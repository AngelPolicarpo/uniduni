import { api, cliente } from "../ipc/api";
import { desligar } from "./dmVoz";
import { useDmCallStore } from "../store/dmCallStore";
import { useDmStore } from "../store/dmStore";
import { useSettingsStore } from "../store/settingsStore";
import { useToastStore } from "../store/toastStore";
import type { StagedAttachmentDto } from "../ipc/dto";

/**
 * A ponte entre a superfície IPC-R de §31.16 e a store de DM — U-33 / B60.
 *
 * O contrato desta camada é o de §15.1 regra 5: **evento é sinal para reconsultar**,
 * nenhum deles aplica payload direto na store. Há uma exceção declarada, e ela é o
 * ponto todo de §31.13:
 *
 *   `dm.reordered` **não** é sinal opcional. A história mudou de ordem a partir de
 *   `fromOrdSum`, e a lista já renderizada deixou de ser a corrente. Aqui o payload é
 *   aplicado na hora — a faixa é descartada — e só depois vem a reconsulta. Tratá-lo
 *   como os outros onze deixaria a tela mostrando uma história que não existe mais até a
 *   query voltar.
 */

/** §31.16.1 — quantas mensagens a página traz. O núcleo tem o teto real de §31.18. */
const PAGINA = 50;

/** §31.16.1 `dm.typing` — TTL de 5 s, e é o renderer quem o aplica. */
const TYPING_TTL_MS = 5_000;

const temporizadoresDeDigitacao = new Map<string, number>();

export async function sincronizarConversas(): Promise<void> {
  const r = await api.dmConversations().catch(() => null);
  if (r === null) return;
  useDmStore.getState().setConversas(r.conversations);
}

export async function sincronizarPrefsDm(): Promise<void> {
  const r = await api.dmPrefs().catch(() => null);
  if (r === null) return;
  useDmStore.getState().setContactPolicy(r.contactPolicy);
}

/**
 * Abre uma conversa: detalhe, primeira página e `dm.activate`.
 *
 * `dm.activate` não é cosmético — §31.16.1 o usa para decidir a **residência do
 * projetor**: a conversa em foco consome lote, as demais ficam montadas e paradas. Sem
 * ele, cada conversa aberta uma vez continuaria consumindo para sempre.
 */
export async function abrirConversa(conversationId: string): Promise<void> {
  const store = useDmStore.getState();
  store.setAtiva(conversationId);
  await api.dmActivate(conversationId).catch(() => null);
  const [, pagina] = await Promise.all([
    recarregarDetalhe(conversationId),
    carregarMensagens(conversationId),
  ]);
  // A28 — a marca de leitura é do topo da ordem canônica agora, e a contagem vira 0 por
  // construção. Depois de carregar, senão marcaria como lido o que a tela ainda não tem.
  //
  // **E só se a tela realmente ficou com ela.** As duas guardas abaixo são o mesmo defeito
  // em duas formas: `markRead` zera por watermark (§31.16.1), não por "o que apareceu", e
  // zerar sem ter mostrado nada apaga o selo de mensagens que ninguém viu.
  //
  //   1. A página falhou (rede, IPC, conversa que sumiu). `carregarMensagens` engole a
  //      recusa por desenho — a tela continua legível com o que já tinha —, mas engolir a
  //      falha e marcar como lida é apagar o selo de uma conversa que não abriu.
  //   2. Quem abriu já trocou de conversa. `recarregarDetalhe` sempre teve esta guarda; o
  //      `markRead` não tinha, e clicar em A e logo em B zerava o selo de A.
  if (!pagina) return;
  if (useDmStore.getState().ativa !== conversationId) return;
  await api.dmMarkRead(conversationId).catch(() => null);
}

export async function fecharConversa(): Promise<void> {
  useDmStore.getState().setAtiva(null);
  await api.dmActivate(null).catch(() => null);
}

export async function recarregarDetalhe(conversationId: string): Promise<void> {
  const d = await api.dmConversation(conversationId).catch(() => null);
  if (d === null) return;
  if (useDmStore.getState().ativa !== conversationId) return;
  useDmStore.getState().setDetalhe(d);
}

/** `true` quando a página chegou. A recusa é engolida (a tela segue legível), mas ela é **fato**. */
export async function carregarMensagens(
  conversationId: string,
  cursor?: string,
): Promise<boolean> {
  const pagina = await api
    .dmMessages({
      conversationId,
      limit: PAGINA,
      direction: "before",
      ...(cursor !== undefined ? { cursor } : {}),
    })
    .catch(() => null);
  if (pagina === null) return false;
  useDmStore.getState().aplicarPagina(conversationId, pagina.messages, {
    ...(pagina.nextCursor !== undefined ? { cursorAnterior: pagina.nextCursor } : {}),
    temMais: pagina.hasMore,
    // §31.16.3 (emenda de 2026-09-05) — o corte do divisor de "Novas mensagens" de U-33.
    // Ele é **congelado na abertura** pela store: `dm.markRead` avança o watermark do
    // núcleo logo em seguida, e um corte que seguisse o watermark sumiria no mesmo quadro
    // em que apareceu.
    corte: { ordSum: pagina.lastReadOrdSum, authorKey: pagina.lastReadAuthorKey },
  });
  return true;
}

/* ─── Os doze eventos de §31.16.2 ─────────────────────────────────────────── */

export function assinarDm(): void {
  const ativa = (): string | null => useDmStore.getState().ativa;
  const daAtiva = (d: unknown): boolean =>
    (d as { conversationId?: string })?.conversationId === ativa();

  // Um pedido novo muda a lista e pode ter atingido o teto de §31.9 regra 4 — que **tem**
  // de aparecer: não há descarte silencioso do mais antigo, então um teto invisível seria
  // um pedido perdido sem ninguém saber.
  cliente.subscribe("dm.requested", () => void sincronizarConversas());
  cliente.subscribe("dm.conversationChanged", (d) => {
    void sincronizarConversas();
    if (daAtiva(d)) void recarregarDetalhe((d as { conversationId: string }).conversationId);
  });

  /**
   * A conversa **em foco** não acumula não lidas, e é aqui que isso acontece.
   *
   * O núcleo conta por watermark (§31.12/A28): a mensagem que chega fica acima da marca e
   * entra na contagem, tenha ou não uma tela mostrando-a. Sem remarcar, a conversa aberta
   * ganhava selo de "1 não lida" sobre si mesma, e ele só sumia ao fechar e reabrir.
   *
   * `hasIncoming` é a guarda, e é para isto que §31.16.2 o declara (emenda de 2026-09-05):
   * um lote só meu não tem o que marcar como lido, e remarcar nele seria uma escrita no
   * manifest a cada tecla enviada. A ordem também é a de `abrirConversa` — carregar
   * primeiro, marcar depois —, porque a marca é do topo da ordem canônica.
   */
  cliente.subscribe("dm.appended", (d) => {
    void sincronizarConversas();
    if (!daAtiva(d)) return;
    const ev = d as { conversationId: string; hasIncoming?: boolean };
    void carregarMensagens(ev.conversationId).then((ok) => {
      if (!ok || ev.hasIncoming !== true) return;
      if (useDmStore.getState().ativa !== ev.conversationId) return;
      return api.dmMarkRead(ev.conversationId).catch(() => null);
    });
  });

  cliente.subscribe("dm.messageUpdated", (d) => {
    if (daAtiva(d)) void carregarMensagens((d as { conversationId: string }).conversationId);
  });

  /**
   * A exceção. Descartar a faixa é síncrono e obrigatório (§31.13); a reconsulta vem
   * depois. Ver o cabeçalho deste arquivo.
   */
  cliente.subscribe("dm.reordered", (d) => {
    const ev = d as { conversationId: string; fromOrdSum: number };
    useDmStore.getState().reordenar(ev.conversationId, ev.fromOrdSum);
    if (ev.conversationId === ativa()) void carregarMensagens(ev.conversationId);
  });

  // §31.11 — a entrega é derivada do `ack` do par, e muda o rótulo das MINHAS mensagens.
  cliente.subscribe("dm.delivered", (d) => {
    if (daAtiva(d)) {
      const id = (d as { conversationId: string }).conversationId;
      void recarregarDetalhe(id);
      void carregarMensagens(id);
    }
  });

  cliente.subscribe("dm.sync", (d) => {
    void sincronizarConversas();
    if (daAtiva(d)) void recarregarDetalhe((d as { conversationId: string }).conversationId);
  });
  cliente.subscribe("dm.desynced", (d) => {
    if (daAtiva(d)) void recarregarDetalhe((d as { conversationId: string }).conversationId);
  });
  cliente.subscribe("dm.forked", (d) => {
    if (daAtiva(d)) void recarregarDetalhe((d as { conversationId: string }).conversationId);
  });
  cliente.subscribe("dm.partialInterpretation", (d) => {
    if (daAtiva(d)) void recarregarDetalhe((d as { conversationId: string }).conversationId);
  });

  cliente.subscribe("dm.unreadChanged", () => void sincronizarConversas());

  // TTL de 5 s aplicado aqui: o núcleo emite o pulso, e quem apaga o indicador é a tela.
  cliente.subscribe("dm.typing", (d) => {
    const ev = d as { conversationId: string; on: boolean };
    const store = useDmStore.getState();
    const anterior = temporizadoresDeDigitacao.get(ev.conversationId);
    if (anterior !== undefined) window.clearTimeout(anterior);
    store.setDigitando(ev.conversationId, ev.on);
    if (!ev.on) return;
    temporizadoresDeDigitacao.set(
      ev.conversationId,
      window.setTimeout(() => {
        useDmStore.getState().setDigitando(ev.conversationId, false);
        temporizadoresDeDigitacao.delete(ev.conversationId);
      }, TYPING_TTL_MS),
    );
  });
}

/* ─── Os comandos (§31.16.1) ──────────────────────────────────────────────── */

function avisar(erro: unknown, quando: string): void {
  const code = (erro as { code?: string })?.code;
  // §31.9 regra 4 — o teto de pendentes tem superfície própria; os demais viram toast.
  if (code === "E_LIMIT_EXCEEDED") {
    useDmStore.getState().setPendentesNoTeto(true);
    return;
  }
  useToastStore.getState().showToast(quando, "error");
}

/**
 * §31.16.1 `dm.open` — a única forma de **começar** uma conversa.
 *
 * `dm.open` é **derivado, nunca atribuído** (§31.2 regra 1): a mesma chave devolve sempre o
 * mesmo `conversationId`, e chamá-lo para quem já está na lista é idempotente — devolve a
 * conversa que existe em vez de criar outra.
 *
 * A conversa é aberta em seguida, e não só sincronizada: quem colou uma chave quer falar,
 * e deixá-la escolher de novo na lista o que acabou de pedir seria trabalho a troco de
 * nada. Abrir **não** aceita nada (§31.9 regra 1 vale só do lado de quem recebe): aqui o
 * estado nasce `pending-out`, que é local e reversível por `dm.forget`.
 */
export async function abrirConversaCom(peerKey: string): Promise<string | null> {
  try {
    const r = await api.dmOpen(peerKey);
    await sincronizarConversas();
    await abrirConversa(r.conversationId);
    return r.conversationId;
  } catch (erro) {
    avisar(erro, "Não foi possível abrir a conversa");
    return null;
  }
}

export async function aceitarConversa(conversationId: string): Promise<void> {
  try {
    await api.dmAccept(conversationId);
    // Aceitar é o que cria o meu core (§31.9 regra 1): a lista muda de forma, não só de
    // rótulo, e a entrega só passa a ser observável a partir daqui.
    useDmStore.getState().setPendentesNoTeto(false);
    await sincronizarConversas();
  } catch (erro) {
    avisar(erro, "Não foi possível aceitar");
  }
}

/**
 * §31.15 (emenda de 2026-09-05) — **bloquear e esquecer encerram a chamada desta conversa.**
 *
 * Sem isto, bloquear alguém no meio de uma chamada deixava a `RTCPeerConnection` de pé e o
 * microfone e a câmera capturando: a mídia é ponta a ponta (§17.2) e não passa pelo canal
 * que o bloqueio fecha. Em `esquecer` era pior — a conversa some da lista, a tela volta para
 * "Escolha uma conversa" e com ela some o único botão de desligar que existia (ele mora no
 * cabeçalho da conversa), deixando uma chamada órfã que ainda recusa a próxima com "Você já
 * está numa chamada" (§15.4).
 *
 * `desligar()` **antes** do comando, de propósito: ele manda `dm.callLeave`, e depois de
 * bloquear o canal `p2p-dm/1` não autoriza mais nada (§31.8(4)) — o par ficaria com a
 * chamada de pé contra quem acabou de bloqueá-lo. O núcleo repete a saída do seu lado
 * (`boot.ts`), porque o escopo do TURN é dele; aqui o que se desliga é o dispositivo.
 */
async function encerrarChamadaDe(conversationId: string): Promise<void> {
  if (useDmCallStore.getState().conversationId !== conversationId) return;
  await desligar();
}

export async function bloquearConversa(conversationId: string): Promise<void> {
  try {
    await encerrarChamadaDe(conversationId);
    await api.dmBlock(conversationId);
    await sincronizarConversas();
  } catch (erro) {
    avisar(erro, "Não foi possível bloquear");
  }
}

export async function desbloquearConversa(conversationId: string): Promise<void> {
  try {
    await api.dmUnblock(conversationId);
    await sincronizarConversas();
  } catch (erro) {
    avisar(erro, "Não foi possível desbloquear");
  }
}

export async function esquecerConversa(conversationId: string): Promise<void> {
  try {
    await encerrarChamadaDe(conversationId);
    await api.dmForget(conversationId);
    useDmStore.getState().limpar(conversationId);
    // B63(b) — o mudo morre com a conversa: sem isto o mapa cresceria com histórico.
    useSettingsStore.getState().setDmMuted(conversationId, false);
    useDmStore.getState().setPendentesNoTeto(false);
    await sincronizarConversas();
  } catch (erro) {
    avisar(erro, "Não foi possível esquecer a conversa");
  }
}

/**
 * §31.10 — **síncrono, com o registro já no log**. Não há `opId`, não há desfecho por
 * evento e não há o que retentar: ou a promessa resolve e a mensagem é final, ou ela
 * rejeita e nada foi escrito. Por isso o erro vira toast e não uma linha "falhou" na
 * conversa — uma linha assim seria um estado de outbox, e §31.11 não declara nenhum.
 */
export async function enviarMensagem(
  conversationId: string,
  content: string,
  anexo?: StagedAttachmentDto,
  replyToId?: string,
): Promise<boolean> {
  try {
    await api.dmSend({
      conversationId,
      content,
      ...(anexo !== undefined ? { attachment: anexo } : {}),
      ...(replyToId !== undefined ? { replyToId } : {}),
    });
    await carregarMensagens(conversationId);
    return true;
  } catch (erro) {
    avisar(erro, "A mensagem não foi escrita");
    return false;
  }
}

export async function editarMensagem(
  conversationId: string,
  messageId: string,
  content: string,
): Promise<void> {
  try {
    await api.dmEdit({ conversationId, messageId, content });
    await carregarMensagens(conversationId);
  } catch (erro) {
    avisar(erro, "Não foi possível editar");
  }
}

export async function apagarMensagem(
  conversationId: string,
  messageId: string,
): Promise<void> {
  try {
    await api.dmDelete({ conversationId, messageId });
    await carregarMensagens(conversationId);
  } catch (erro) {
    avisar(erro, "Não foi possível apagar");
  }
}

export async function reagir(
  conversationId: string,
  messageId: string,
  emoji: string,
  present: boolean,
): Promise<void> {
  try {
    await api.dmReact({ conversationId, messageId, emoji, present });
    await carregarMensagens(conversationId);
  } catch (erro) {
    avisar(erro, "Não foi possível reagir");
  }
}

/**
 * §31.16.1 — o perfil é **por conversa**: não há comunidade de onde herdar um. O piso de
 * §31.7.5 (2 a 32 code points) é validação de formulário; um nome vazio faria o `dmFold`
 * recusar o registro e marcar o lado inteiro como `invalid`.
 */
export async function definirPerfil(
  conversationId: string,
  displayName: string,
): Promise<void> {
  try {
    await api.dmSetProfile({ conversationId, displayName });
    await sincronizarConversas();
  } catch (erro) {
    avisar(erro, "Não foi possível salvar o nome");
  }
}

export async function definirPoliticaDeContato(
  policy: "anyone" | "shared-community",
): Promise<void> {
  try {
    await api.dmSetContactPolicy(policy);
    useDmStore.getState().setContactPolicy(policy);
  } catch (erro) {
    avisar(erro, "Não foi possível salvar a preferência");
  }
}

export async function avisarDigitacao(conversationId: string, on: boolean): Promise<void> {
  await api.dmSetTyping({ conversationId, on }).catch(() => undefined);
}

/* ─── §31.14 — anexos, reusando §13 sem alteração ─────────────────────────── */

/**
 * O clipe: o main abre o diálogo, o núcleo recebe o ticket e escreve o blob **antes** de
 * qualquer mensagem existir (§13.7: o blob primeiro, a mensagem depois).
 *
 * O `conversationId` viaja no slot que o `communityId` ocupa, e isso não é gambiarra: é o
 * que §31.14 quer dizer com "ticket de staging e fluxo de upload **reutilizados sem
 * alteração**" — o escopo de um blob é o escopo de replicação dele, e numa DM ele é a
 * conversa (§31.1). O caminho do arquivo nunca cruza o IPC-R (T-16), aqui como lá.
 */
export async function anexarArquivo(conversationId: string): Promise<StagedAttachmentDto | null> {
  try {
    const ticket = await api.filePickForAttachment(conversationId);
    return await api.blobStage(ticket.ticketId);
  } catch (erro) {
    // Cancelar o diálogo é desfecho normal, não falha: nada a dizer.
    if ((erro as { code?: string }).code === "E_CANCELLED") return null;
    avisar(erro, "Não foi possível anexar o arquivo");
    return null;
  }
}

/*
 * **Não há `baixarAnexo` aqui**, e a ausência é a correção de 2026-09-05.
 *
 * Havia, e ele era metade do fluxo de §13.4: mandava `blob.download` e não escutava
 * `blob.progress`, `blob.completed`, `blob.peerLost`, `blob.unavailable` nem
 * `attachment.corrupt` — os cinco eventos que dizem o que aconteceu depois. Quem os escuta
 * é o `downloadStore` (§15.5, chaveado por `blobIdHex`), e §31.14 manda reutilizar o fluxo
 * de download **sem alteração**: o cartão da DM passou a usar o mesmo caminho do cartão da
 * comunidade, com o `conversationId` no slot do `communityId` (§31.1).
 */

/**
 * §31.16.3 — o anexo completo mora em `query.dmMessage`; a lista traz só `hasAttachment`.
 *
 * O desfecho é sempre **gravado**, e é isso que muda em relação a antes: uma query que
 * falhava saía daqui sem escrever nada, e o efeito do cartão — cujas dependências não
 * mudaram — nunca rodava de novo. O cartão ficava no bloco pulsante para sempre, sem erro,
 * sem botão e sem nova tentativa. `hasAttachment` e a linha de `dm_attachments` saem da
 * mesma tabela e do mesmo lote do projetor, então "existe na lista e não existe na query"
 * não é estado de replicação: é falha de consulta, e ela agora se anuncia.
 */
export async function carregarAnexo(
  conversationId: string,
  messageId: string,
): Promise<void> {
  const cheia = await api.dmMessage({ conversationId, messageId }).catch(() => null);
  const anexo = cheia?.attachment ?? null;
  useDmStore.getState().setAnexo(messageId, anexo);
}
