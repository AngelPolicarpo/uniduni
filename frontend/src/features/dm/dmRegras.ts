import { AVATAR_COLORS } from "../../lib/avatar";
import type { AvatarColor } from "../../domain/types";
import type {
  DmConvState,
  DmConversationItem,
  DmMessageDto,
  DmSync,
} from "../../ipc/dto";

/**
 * As decisões de U-33 que **não** são render.
 *
 * Elas moram aqui, e não dentro dos componentes, pela mesma razão de
 * `moderation/historico.ts`: são o que o teste afirma, e a maior parte de U-33 é
 * proibição de texto — coisa que só é verificável se existir uma função a chamar. Um
 * componente que monta a frase inline transforma requisito normativo em detalhe de JSX,
 * e a próxima pessoa a mexer não tem como saber que "não entregue" não pode virar
 * "ele está offline".
 *
 * O nome não colide com componente nenhum: `dmRegras.ts` não tem irmão `DmRegras.tsx`
 * (`TS1261` num filesystem que não distingue caixa — a lição de `historico.ts`).
 */

/* ─── Os dois textos obrigatórios de §31.24 ───────────────────────────────── */

/**
 * **L-25**, superfície obrigatória. `dm.forget` está na classe `main-confirmed` de §15.3,
 * então o modal existe de qualquer forma; o que este texto acrescenta é a consequência
 * exata, que é a regra de §15 (nunca um "Tem certeza?" genérico).
 *
 * A segunda frase é a que não pode sumir numa revisão de copy: a linha de
 * `dm_conversations` sobrevive **para sempre** (§31.19 regra 2), porque sem o
 * `self_high_water` escrever de novo para a mesma pessoa produziria fork contra a cópia
 * que ela tem. Prometer "apaga tudo" seria mentira verificável no disco.
 */
export const TEXTO_ESQUECER_CONVERSA =
  "Isto apaga as mensagens desta conversa desta máquina e não pode ser desfeito. " +
  "Uma marca mínima da conversa permanece no disco — sem ela, escrever de novo para " +
  "esta pessoa corromperia a cópia que ela tem. Apagar tudo só é possível apagando a " +
  "identidade.";

/**
 * **L-28**, superfície obrigatória. O bloqueio é silencioso por decisão de segurança
 * (§31.9 regra 2): avisar transformaria o bloqueio num sinal para escalar. Quem bloqueia
 * precisa saber que o silêncio **é** o mecanismo — senão espera um efeito que não vem.
 */
export const TEXTO_BLOQUEAR_CONVERSA =
  "A outra pessoa não é avisada. Para ela, você fica igual a alguém desligado.";

/**
 * **L-29**, superfície obrigatória. O que este texto não pode conter é a oferta de relay:
 * numa dupla não há terceiro, então §17.7 não se aplica (§31.15). Oferecer o caminho de
 * recuperação que a comunidade tem seria pior do que declarar a falha.
 */
export const TEXTO_CHAMADA_SEM_RELAY =
  "A chamada precisa que pelo menos um dos dois esteja alcançável pela rede. " +
  "Numa conversa direta não há terceiro para encaminhar.";

/* ─── Entrega (§31.11) — o que a tela pode e não pode dizer ───────────────── */

export type RotuloDeEntrega = {
  /** O que aparece ao lado da mensagem. */
  readonly texto: string;
  /** `title`/`aria-label` — mais longo, e igualmente proibido de afirmar a causa. */
  readonly detalhe: string;
};

const MINUTO = 60_000;
const HORA = 60 * MINUTO;
const DIA = 24 * HORA;

/** O tempo desde a escrita, que é a **única** informação que §31.24 manda acrescentar. */
export function tempoDesdeEscrita(ts: number, agora: number): string {
  const ms = Math.max(0, agora - ts);
  if (ms < MINUTO) return "agora mesmo";
  if (ms < HORA) return `há ${Math.floor(ms / MINUTO)} min`;
  if (ms < DIA) return `há ${Math.floor(ms / HORA)} h`;
  const dias = Math.floor(ms / DIA);
  return `há ${dias} ${dias === 1 ? "dia" : "dias"}`;
}

/**
 * O rótulo de uma mensagem **própria**. `undefined` para as do par: §31.11 dá `delivery`
 * só nas minhas, e inventar um estado de entrega para a mensagem do outro seria afirmar
 * o que eu não observo.
 *
 * As duas proibições de **L-26** e **L-28**, que são o motivo desta função existir:
 *
 * 1. `undelivered` não diz **por quê**. Ele é, por construção, indistinguível entre o par
 *    offline e o par que bloqueou (§31.9 regra 2) — as duas situações produzem
 *    exatamente o mesmo `ack` parado. Escrever "ele está offline" inventaria o fato que
 *    o protocolo recusa dar.
 * 2. `delivered` não é **"lido"**. O `ack` só avança quando o par **escreve**, então ele
 *    atesta que os registros chegaram, não que alguém os leu; confirmação de leitura não
 *    existe em §31.5, e o rótulo seria inventá-la na camada errada.
 */
export function rotuloDeEntrega(
  mensagem: Pick<DmMessageDto, "delivery" | "ts">,
  agora: number,
): RotuloDeEntrega | undefined {
  if (mensagem.delivery === undefined) return undefined;
  if (mensagem.delivery === "delivered") {
    return {
      texto: "Entregue",
      // "Entregue" e não "visto": o `ack` é atestado de chegada, assinado pelo par.
      detalhe: "O outro lado recebeu esta mensagem. Não é confirmação de leitura.",
    };
  }
  return {
    texto: "Não entregue",
    detalhe: `Escrita ${tempoDesdeEscrita(mensagem.ts, agora)} e ainda não recebida pelo outro lado.`,
  };
}

/* ─── Sincronização (§31.13) — sete estados, seis frases ──────────────────── */

export type FaixaDeSincronizacao = {
  readonly tone: "offline" | "reconnecting" | "degraded" | "failed";
  readonly texto: string;
  /** Escrever é possível? §31.13: `desynced` e `forked` recusam o append. */
  readonly podeEscrever: boolean;
};

/**
 * A frase de cada estado de §31.13 — e a igualdade que é requisito, não descuido:
 * **`unauthorized` devolve exatamente o mesmo texto que `peer-offline`**.
 *
 * Os dois são distintos no núcleo (um é "o par recusou o canal", o outro é "não há
 * conexão"), e precisam ser **indistinguíveis na tela**. Separá-los diria ao bloqueado
 * que ele foi bloqueado, que é precisamente o que **L-28** recusa — e vazaria por um
 * caminho lateral o sinal que §31.9 regra 2 se dá ao trabalho de não emitir.
 *
 * `synced` não tem faixa: o estado normal não se anuncia.
 */
export function faixaDeSincronizacao(sync: DmSync): FaixaDeSincronizacao | null {
  switch (sync) {
    case "synced":
      return null;
    case "catching-up":
      return { tone: "reconnecting", texto: "Recebendo mensagens…", podeEscrever: true };
    case "stalled":
      return {
        tone: "degraded",
        texto: "A sincronização parou. Falta receber parte da conversa.",
        podeEscrever: true,
      };
    case "peer-offline":
    case "unauthorized":
      // MESMA frase, de propósito. Ver o comentário acima antes de "melhorar" isto.
      return {
        tone: "offline",
        texto: "Sem conexão com esta pessoa agora.",
        podeEscrever: true,
      };
    case "desynced":
      return {
        tone: "failed",
        texto:
          "Parte do seu lado desta conversa se perdeu nesta máquina. Escrever está " +
          "suspenso até o próximo contato com a outra pessoa — escrever agora " +
          "corromperia a cópia que ela tem.",
        podeEscrever: false,
      };
    case "forked":
      return {
        tone: "failed",
        texto:
          "Esta conversa foi escrita de duas máquinas ao mesmo tempo e os dois lados " +
          "divergiram. Escrever está suspenso; é preciso escolher qual ramo manter.",
        podeEscrever: false,
      };
  }
}

/**
 * O composer existe? **Some** em `blocked` e `left` — ali a conversa é histórico, e o
 * campo seria decorativo (§15). **Fica visível e desabilitado** em `desynced` e `forked`,
 * que é a única exceção declarada em U-33 à regra de esconder-nunca-desabilitar: o estado
 * é temporário e espera o par (§31.13), e sumir com o campo faria a conversa parecer
 * somente-leitura por natureza.
 */
export function composerDaConversa(
  state: DmConvState,
  sync: DmSync,
): { readonly visivel: boolean; readonly habilitado: boolean; readonly motivo?: string } {
  if (state === "blocked" || state === "left" || state === "pending-in") {
    return { visivel: false, habilitado: false };
  }
  const faixa = faixaDeSincronizacao(sync);
  if (faixa !== null && !faixa.podeEscrever) {
    return { visivel: true, habilitado: false, motivo: faixa.texto };
  }
  return { visivel: true, habilitado: true };
}

/* ─── Marcas na mensagem (L-27 e o relógio) ───────────────────────────────── */

export type MarcaDeMensagem = {
  readonly id: "ordem-provisoria" | "relogio";
  readonly rotulo: string;
  readonly detalhe: string;
};

/**
 * **L-27** — a ordem de uma conversa direta é acordo entre as duas partes, e uma delas
 * pode declarar um `ack` maior do que o que viu. A outra vê isso **marcado**, nunca
 * corrigido e nunca escondido: não há terceiro a enganar numa dupla, e recusar o registro
 * daria a um contador quebrado o poder de parar a conversa (§31.6).
 */
export function marcasDaMensagem(
  mensagem: Pick<DmMessageDto, "ackAhead" | "clockSkewed">,
): MarcaDeMensagem[] {
  const marcas: MarcaDeMensagem[] = [];
  if (mensagem.ackAhead) {
    marcas.push({
      id: "ordem-provisoria",
      rotulo: "ordem provisória",
      detalhe:
        "A posição desta mensagem foi declarada por quem a escreveu e não é confirmada " +
        "pela ordem da conversa.",
    });
  }
  if (mensagem.clockSkewed) {
    marcas.push({
      id: "relogio",
      rotulo: "relógio fora de hora",
      detalhe: "O horário declarado não é coerente com a ordem em que a conversa aconteceu.",
    });
  }
  return marcas;
}

/* ─── Ações por estado (§15: esconder, nunca desabilitar) ─────────────────── */

export type AcaoDeConversa =
  | "aceitar"
  | "bloquear"
  | "desbloquear"
  | "esquecer";

/**
 * Quais ações **renderizam** para cada estado de §31.9. Aceitar e bloquear existem só
 * em `pending-in`; desbloquear só em `blocked`. Nada de botão visível e morto — a regra
 * de §15, e o precedente é U-32.
 *
 * `esquecer` existe em todos, inclusive em `pending-in`: recusar um pedido sem bloquear
 * quem o mandou é um desfecho legítimo, e o teto de §31.9 regra 4 depende de haver como
 * esvaziar a fila.
 */
export function acoesDaConversa(state: DmConvState): AcaoDeConversa[] {
  switch (state) {
    case "pending-in":
      return ["aceitar", "bloquear", "esquecer"];
    case "blocked":
      return ["desbloquear", "esquecer"];
    case "left":
      return [];
    case "pending-out":
    case "accepted":
      return ["bloquear", "esquecer"];
  }
}

/* ─── Ordem canônica e a recarga de `dm.reordered` ────────────────────────── */

/**
 * A ordem de §31.6, e a mesma do cursor de §31.16.3: `(ordSum, authorKey, id)`. O
 * desempate por chave e depois por id é o que a torna total — dois registros podem
 * empatar em `ordSum`, e sem desempate determinístico as duas réplicas mostrariam ordens
 * diferentes da mesma conversa.
 */
export function compararMensagens(a: DmMessageDto, b: DmMessageDto): number {
  if (a.ordSum !== b.ordSum) return a.ordSum - b.ordSum;
  const chave = a.author.key.localeCompare(b.author.key);
  if (chave !== 0) return chave;
  return a.id.localeCompare(b.id);
}

/**
 * Mescla uma página nova na lista, por `id`, e reordena. Página vem do núcleo já
 * ordenada; o que exige a reordenação aqui é a chegada por evento, que não respeita
 * paginação nenhuma.
 */
export function mesclarMensagens(
  atuais: readonly DmMessageDto[],
  novas: readonly DmMessageDto[],
): DmMessageDto[] {
  const porId = new Map(atuais.map((m) => [m.id, m]));
  for (const m of novas) porId.set(m.id, m);
  return [...porId.values()].sort(compararMensagens);
}

/**
 * `dm.reordered` — o **único** dos doze eventos de §31.16.2 que a UI não pode tratar
 * como "reconsultar se quiser".
 *
 * Chegou um registro cujo `ordKey` é menor que o já interpretado (§31.13, inserção
 * retroativa): o projetor reinterpretou dali até as duas cabeças, e a lista renderizada
 * **deixou de ser a corrente** a partir de `fromOrdSum`. Descartar a faixa é obrigatório
 * — mantê-la mostraria uma história que não existe mais, com as mensagens novas
 * penduradas no fim.
 *
 * O que sobra abaixo do corte é mantido de propósito: é a parte que não mudou, e é a
 * âncora de rolagem que impede o salto na recarga.
 */
export function descartarFaixaReordenada(
  mensagens: readonly DmMessageDto[],
  fromOrdSum: number,
): DmMessageDto[] {
  return mensagens.filter((m) => m.ordSum < fromOrdSum);
}

/* ─── A lista (§31.16.3) ──────────────────────────────────────────────────── */

/**
 * O nome exibido de um par, **sempre com o `handle` junto** (§6.1).
 *
 * §31.16.3 não tem `collision`: numa conversa de dois não há conjunto em que colidir. O
 * `handle` continua ao lado mesmo assim, porque a mitigação (a) de **L-5** vale aqui mais
 * forte — para falar com alguém é preciso já ter a chave dele, e é o `handle` que liga o
 * nome escolhido àquela chave.
 */
export function nomeComHandle(peer: { displayName: string; handle: string }): string {
  return `${peer.displayName} ${peer.handle}`;
}

/**
 * A cor do avatar do par. §31.16.3 dá `avatarColor` como **número** — o par o escolhe e o
 * escreve no `dm.profile` —, e a paleta é a de §5.4, curada para contraste. O módulo é o
 * que impede um número arbitrário de virar cor inexistente.
 *
 * Mora aqui, e não no componente, pela regra que `historico.ts` já pagou: um `.tsx` que
 * exporta função além de componente quebra o Fast Refresh.
 */
export function corDoPar(avatarColor: number): AvatarColor {
  return AVATAR_COLORS[Math.abs(Math.trunc(avatarColor)) % AVATAR_COLORS.length];
}

/* ─── §31.15 / U-33 — a chamada de dois, e o que a tela não pode oferecer ─── */

/**
 * Os estados de uma chamada numa conversa direta. São **quatro**, e a lista curta é o
 * ponto: §31.15 remove roster, ocupação, fila e revogação, então não há "3 na chamada",
 * não há "você é o próximo" e não há "sua permissão foi revogada".
 */
export type DmCallState = "fora" | "chamando" | "recebendo" | "na-chamada";

export type AcaoDeChamada = "chamar" | "atender" | "desligar";

/**
 * O que o cabeçalho da conversa oferece, por estado.
 *
 * A chamada só existe em `accepted`: antes do aceite não há core meu (§31.9 regra 1) e o
 * canal de sinalização de §31.15 não está autorizado (`autorizaDm` exige o estado). Um
 * botão de ligar num pedido pendente prometeria um caminho que o transporte recusa.
 */
export function acoesDeChamada(state: DmConvState, chamada: DmCallState): AcaoDeChamada[] {
  if (state !== "accepted") return [];
  switch (chamada) {
    case "fora":
      return ["chamar"];
    case "recebendo":
      return ["atender", "desligar"];
    case "chamando":
    case "na-chamada":
      return ["desligar"];
  }
}

export type FaixaDeChamada = {
  /** Os tons de `StatusBanner` (§6) — os mesmos que a faixa de sincronização usa. */
  readonly tone: "reconnecting" | "degraded" | "failed";
  readonly texto: string;
  /**
   * §17.7 **não se aplica** (§31.15, **L-29**). O campo existe para o teste poder afirmar a
   * ausência: uma faixa de falha que trouxesse `podeOferecerRelay: true` desfaria L-29 na
   * única superfície em que ela é visível.
   */
  readonly podeOferecerRelay: false;
};

/**
 * A faixa da chamada, incluindo o desfecho `conn-failed` de **L-29**.
 *
 * `motivo` é o diagnóstico de rede de §99, tal como a malha o produziu — o mesmo texto que
 * a comunidade mostra. O que muda numa DM é o que vem **depois** dele: na comunidade §17.7
 * oferece o relay voluntário, e aqui não há terceiro a quem recorrer. A frase de
 * `TEXTO_CHAMADA_SEM_RELAY` é o que ocupa esse lugar, e ela não oferece nada.
 */
export function faixaDeChamada(
  chamada: DmCallState,
  falha: string | null,
): FaixaDeChamada | null {
  if (falha !== null) {
    return {
      tone: "failed",
      texto: `${falha} ${TEXTO_CHAMADA_SEM_RELAY}`,
      podeOferecerRelay: false,
    };
  }
  switch (chamada) {
    case "chamando":
      // "Chamando" é fato local: eu entrei e o outro ainda não. Não afirma nada sobre ele —
      // não diz "está tocando lá", que exigiria um atestado que o protocolo não dá.
      return { tone: "reconnecting", texto: "Chamando…", podeOferecerRelay: false };
    case "recebendo":
      return { tone: "reconnecting", texto: "Chamada recebida", podeOferecerRelay: false };
    case "na-chamada":
      return null;
    case "fora":
      return null;
  }
}

/**
 * O rótulo do painel de chamada que **sobrevive à navegação** (U-33, emenda de 2026-09-05).
 *
 * Ele existe pela mesma razão que o `VoicePanel` da comunidade: "a chamada pode ser de uma
 * comunidade que nem está aberta, e este painel é o que diz isso" (§9, 2.3.1 / §11 C11).
 * Numa DM o buraco era maior — os botões de atender e desligar moravam **só** no cabeçalho
 * da conversa, sob a guarda de ser a conversa aberta. Quem estivesse em outra conversa ou
 * numa comunidade não tinha como atender a chamada que estava chegando, nem como desligar a
 * que estava de pé, e ainda ficava impedido de iniciar outra por §15.4.
 *
 * As frases não afirmam nada sobre o outro lado, pela mesma disciplina de `faixaDeChamada`:
 * "Chamando…" é fato local, não "está tocando lá".
 */
export function rotuloDoPainelDeChamada(chamada: DmCallState): string | null {
  switch (chamada) {
    case "fora":
      return null;
    case "chamando":
      return "Chamando…";
    case "recebendo":
      return "Chamada recebida";
    case "na-chamada":
      return "Em chamada";
  }
}

/* ─── §31.16.1 `dm.open` — a chave de identidade colada ───────────────────── */

/**
 * **L-24** — a chave pública de identidade **é** o endereço: não há diretório, não há
 * busca e não há tópico de descoberta. Para falar com alguém pela primeira vez é preciso
 * já ter a chave dela, obtida por fora do produto.
 *
 * `frontend.md` não descreve uma tela de busca de pessoas porque ela não pode existir —
 * §31.8 recusou o rendezvous por segredo compartilhado e nada substitui o "quem é
 * fulano?". Colar a chave é o caminho, e o link `comunidadep2p://u/<KEY64>` (B64, §3.5)
 * é o atalho clicável para a mesma chave — o campo segue como reserva onde o handler
 * não alcança.
 */
export const TEXTO_NOVA_CONVERSA =
  "A chave pública de identidade é o endereço da pessoa: não há busca nem diretório. " +
  "Peça a ela os 64 caracteres e cole aqui.";

/**
 * **§31.9 regra 5**, e o custo que a UI é obrigada a mostrar. Com a política em
 * `shared-community`, o `dmHello` de quem não tem comunidade em comum é recusado com
 * `E_DM_NOT_AUTHORIZED` **do outro lado** — o pedido sai daqui e morre lá, em silêncio,
 * porque o bloqueio silencioso de L-28 usa o mesmo caminho.
 *
 * Isto é sobre a política **do destinatário**, que este nó não conhece; o aviso fala da
 * própria, que é a única verdade disponível, e não afirma nada sobre a dele.
 */
export const TEXTO_POLITICA_RESTRITA =
  "Sua política de contato está em “só quem compartilha comunidade”. " +
  "Isso não impede você de abrir a conversa, mas impede que pessoas de fora abram uma com você.";

/**
 * O que a conversa direta **é**, dito onde decide alguma coisa: no momento de abrir.
 *
 * A frase morava no vazio do painel, em três lugares ao mesmo tempo (o parágrafo, o
 * rodapé da lista e o ícone), numa tela em que ainda não havia ato nenhum a informar.
 * Aqui ela é a consequência de §31.5: sem host no meio, a entrega depende de as duas
 * pontas se encontrarem online — e é isso que explica a mensagem que fica "não entregue"
 * (§31.11, **L-26**) sem que ninguém tenha bloqueado ninguém.
 */
export const TEXTO_ENTREGA_QUANDO_ONLINE =
  "As mensagens vão da sua máquina para a dela, sem host no meio: elas chegam quando as " +
  "duas estiverem online ao mesmo tempo.";

export type ChaveColada =
  | { readonly ok: true; readonly peerKey: string; readonly jaExiste: string | null }
  | { readonly ok: false; readonly erro: string };

/**
 * Normaliza e valida a chave colada.
 *
 * **A tolerância é deliberada e limitada.** Espaço, quebra de linha e caixa somem — 64
 * caracteres copiados de um chat ou de um e-mail chegam quebrados o tempo todo, e recusar
 * por isso seria transformar formatação em erro do usuário. O que **não** é tolerado é
 * qualquer coisa que mude o valor: nada de prefixo `0x`, nada de Base32. O link
 * `comunidadep2p://u/<KEY64>` (B64, §3.5) é aceito colado aqui e a chave é extraída —
 * é a mesma chave, noutra embalagem.
 */
export function lerChaveDeIdentidade(
  bruto: string,
  contexto: {
    /** A minha chave — §31.2 regra 5: `lo = hi` não é conversa. */
    readonly euHex: string | null;
    /** As conversas que já existem, para não criar pedido onde já há histórico. */
    readonly conversas: readonly {
      readonly conversationId: string;
      readonly state: DmConvState;
      readonly peer: { readonly key: string };
    }[];
  },
): ChaveColada {
  const recortado = bruto.trim();
  // B64 — o link colado no campo: só a forma exata `u/<64 hex>`, sem conteúdo extra.
  // Qualquer coisa fora disso cai na validação de 64 hex abaixo, com o mesmo erro.
  const deLink = /^comunidadep2p:\/\/u\/([0-9a-fA-F]{64})$/.exec(recortado)?.[1];
  const chave = (deLink ?? bruto).replace(/\s+/g, "").toLowerCase();
  if (chave.length === 0) return { ok: false, erro: "Cole a chave de identidade da pessoa." };
  if (!/^[0-9a-f]{64}$/.test(chave)) {
    return {
      ok: false,
      erro: "A chave tem 64 caracteres de 0 a 9 e a a f. Confira o que foi colado.",
    };
  }
  // §31.2 regra 5. O núcleo recusa com `E_VALIDATION.peerKey` (§31.17 não deu código
  // próprio: um existente já descreve a condição), mas dizer isto aqui é mais honesto do
  // que traduzir um erro genérico depois.
  if (euHexIgual(chave, contexto.euHex)) {
    return { ok: false, erro: "Esta é a sua própria chave." };
  }
  // `dm.open` é **derivado, nunca atribuído** (§31.2 regra 1): a mesma chave dá sempre o
  // mesmo `conversationId`. Colar a chave de quem já está na lista tem de abrir a conversa
  // que existe, não parecer que criou um pedido novo.
  //
  // `left` fica **de fora**: ela não está na lista (§31.19 tira a conversa de vista), então
  // "abrir a que existe" não abriria nada. Quem sabe o que fazer com uma conversa esquecida
  // é `dm.open`, que a remonta.
  const existente =
    contexto.conversas.find((c) => c.peer.key.toLowerCase() === chave && c.state !== "left")
      ?.conversationId ?? null;
  return { ok: true, peerKey: chave, jaExiste: existente };
}

function euHexIgual(chave: string, euHex: string | null): boolean {
  return euHex !== null && euHex.toLowerCase() === chave;
}

/* ─── B63(b) — o selo conta só o que pode interromper ─────────────────────── */

/**
 * O número do botão de conversas no rail: pedidos mais não lidas das conversas com
 * som. Conversa muda não soma — como canal mudo não soma no traço do rail (§8, 1.1).
 * Pedido (`pending-in`) soma sempre: é exatamente a coisa que não pode ficar invisível
 * (§31.9 regra 4), e pedido ainda não é conversa para ter mudo. Sem nada mudo, é a
 * conta de antes (pedidos + não lidas de todas).
 */
export function contarPendentesDm(
  conversas: readonly DmConversationItem[],
  mudasPorConversa: Readonly<Record<string, boolean | undefined>>,
): number {
  let total = 0;
  for (const c of conversas) {
    if (c.state === "pending-in") total += 1;
    if (mudasPorConversa[c.conversationId] === true) continue;
    total += c.unread.count;
  }
  return total;
}

/* ─── §17.2 numa DM: câmera sim, tela não (B68) ───────────────────────────── */

/**
 * As ações de **vídeo** que o cabeçalho da conversa oferece.
 *
 * O tipo tem **um** membro, e a ausência do outro é a decisão desta fatia, não um recorte
 * de escopo. As duas metades de "câmera e tela" não têm o mesmo estatuto normativo:
 *
 * - **Câmera é derivação.** §31.15 abre com "Vale §17.2 sem alteração", e a tabela de §17.2
 *   põe voz e câmera na **mesma malha** (`Voz e câmera | WebRTC mesh`), na mesma
 *   `RTCPeerConnection` (§93). Numa DM a malha já existe desde §109 e `definirVideoLocal` já
 *   sabe carregar vídeo. Não há fio novo, não há comando novo e não há linha nova na tabela
 *   fechada de §31.8 — é o teste de §109.2 passando: nada aqui é inexpressível.
 * - **A tela foi B68, e fechou em 2026-09-03.** Ela não era derivável enquanto §17.5
 *   dependesse do host em cada peça (sessão, ticket, roster de espectadores, laço de saúde)
 *   e enquanto **B41** deixasse quem recebe sem como distinguir tela de câmera — numa DM não
 *   existe `share.join` de que a heurística da comunidade partisse. As duas caíram juntas:
 *   §17.2 fixou o m-line de cada origem (o discriminador deixou de ser adivinhação, e não
 *   custou campo nenhum no fio), e §31.15 declarou que numa dupla a estrela **é** a malha de
 *   dois — some a sessão, some o ticket, some o roster e some o laço de saúde inteiro,
 *   porque ele existe para repartir UM upload entre N espectadores e aqui N = 1.
 */
export type AcaoDeVideo = "camera" | "tela";

/**
 * A câmera só existe com a chamada **de pé**, e isso é consequência 1 de §31.15, não
 * preferência de UI: a `RTCPeerConnection` só nasce quando `dm.call{on:true}` chega (§99.13),
 * então em `chamando` e em `recebendo` não há malha a que anexar a trilha. Um botão de câmera
 * ali capturaria o dispositivo para não mandá-lo a lugar nenhum.
 */
export function acoesDeVideo(
  state: DmConvState,
  chamada: DmCallState,
  /**
   * O motivo de §99 quando a chamada **não fechou**. Ele não encerra a chamada de propósito
   * — a faixa precisa continuar visível com o desfecho (`dmCallStore.falhou`) —, mas ele diz
   * que não há par conectado: `#veredito` da malha só o produz quando nenhum par chegou a
   * `connected`. Oferecer câmera e tela ali acende o dispositivo para mandá-lo a lugar
   * nenhum, que é a mesma promessa vazia que `acoesDeVideo` já recusa em `chamando`.
   */
  falha: string | null = null,
): AcaoDeVideo[] {
  if (state !== "accepted") return [];
  if (falha !== null) return [];
  return chamada === "na-chamada" ? ["camera", "tela"] : [];
}

/* ─── U-33 — o divisor de "Novas mensagens" ───────────────────────────────── */

/**
 * O **id** da primeira mensagem depois do corte de leitura, ou `null` quando não há corte.
 *
 * U-33 manda a conversa reusar a anatomia de 2.1, e o divisor está na lista. O que faltava
 * era a fonte: §31.16.3 dava o **quantas** (`unread.count`) e não o **onde** — o watermark
 * de `dm_local_read_state` não saía do núcleo. A emenda de 2026-09-05 o devolve nas duas
 * queries, e esta função é a regra que o transforma em posição.
 *
 * A comparação é o `ordKey` de §31.6 inteiro — `(ordSum, authorKey)` —, a mesma de
 * `naoLidas` no núcleo. Usar só o `ordSum` discordaria do selo exatamente no empate: dois
 * registros com o mesmo `ordSum`, um deles a marca, e o selo diria "1" sem divisor nenhum.
 *
 * A minha própria mensagem nunca abre o divisor, pela mesma razão que ela nunca conta como
 * não lida: eu escrevi, logo eu li.
 */
export function primeiraNaoLida(
  mensagens: readonly DmMessageDto[],
  corte: { readonly ordSum: number; readonly authorKey: string } | undefined,
  euHex: string | null,
): string | null {
  if (corte === undefined) return null;
  const eu = euHex?.toLowerCase() ?? null;
  for (const m of mensagens) {
    const autor = m.author.key.toLowerCase();
    if (autor === eu) continue;
    if (m.ordSum < corte.ordSum) continue;
    if (m.ordSum === corte.ordSum && autor <= corte.authorKey.toLowerCase()) continue;
    return m.id;
  }
  return null;
}

export type FaixaDeCamera = {
  readonly tone: "degraded";
  readonly texto: string;
};

/**
 * A faixa de uma câmera que não ligou ou que caiu.
 *
 * Ela é **separada de `faixaDeChamada`** de propósito. `faixaDeChamada` cola
 * `TEXTO_CHAMADA_SEM_RELAY` em toda falha, porque ali a falha é de conectividade e **L-29** é
 * a consequência exata; uma câmera negada pelo sistema operacional não tem nada com relay
 * nenhum, e emendar a frase a ela mandaria a pessoa procurar defeito na rede. O motivo vem de
 * `motivoDoErroDeCamera` (§20.1), que já distingue autorizar, trocar de dispositivo e fechar
 * o outro aplicativo.
 */
export function faixaDeCamera(erro: string | null): FaixaDeCamera | null {
  return erro === null ? null : { tone: "degraded", texto: erro };
}

/**
 * A faixa de uma captura de tela que não aconteceu. Separada de `faixaDeChamada` pela mesma
 * razão que `faixaDeCamera`: uma captura recusada não tem nada com **L-29**, e emendar a
 * frase do relay a ela mandaria a pessoa procurar defeito na rede.
 */
export function faixaDeTela(erro: string | null): FaixaDeCamera | null {
  return erro === null ? null : { tone: "degraded", texto: erro };
}

/**
 * A faixa do microfone ausente: a chamada segue em somente-escuta, e a faixa é
 * o que pede a troca de dispositivo. `degraded` como as de câmera e tela — um
 * aviso, nunca a frase de conectividade de `faixaDeChamada`.
 */
export function faixaDeMicrofone(erro: string | null): FaixaDeCamera | null {
  return erro === null
    ? null
    : { tone: "degraded", texto: `${erro} Troque de microfone nas configurações para voltar a falar.` };
}

export type PalcoDeVideo = {
  /** De quem é a tela em foco, ou `null` quando não há tela nenhuma. */
  readonly tela: "eu" | "par" | null;
  /**
   * O `<video>` do palco toca o áudio que vier junto.
   *
   * §17.5 — a tela pode levar som, e ele viaja no m-line 3, agrupado com a imagem (§17.2,
   * emenda de 2026-09-03). Duas razões para isto ser uma decisão nomeada e não um atributo
   * no JSX:
   *
   * 1. **A minha própria tela nunca toca.** Tocá-la devolve o som que estou transmitindo —
   *    o mesmo eco que o `<audio>` da voz evita não tocando a própria trilha.
   * 2. **Numa DM não há outro jeito de calar o do par.** Não existe ensurdecer nem volume
   *    por participante — os dois são superfície de uma chamada com mais de duas pessoas
   *    (§31.15) —, então o que resta é o volume geral da máquina. Um `muted` fixo aqui
   *    tornaria o m-line 3 inaudível **sempre**, que é transmitir som para ninguém.
   */
  readonly comSom: boolean;
};

/**
 * Quem ocupa o palco do painel de vídeo de uma conversa direta.
 *
 * A tela do **par** ganha da minha: quem compartilha já vê a própria tela na máquina, e
 * ocupar o palco com ela esconderia a única imagem que a pessoa não tem de outro jeito. Não
 * há seletor de foco — ele é superfície de uma chamada com mais de duas pessoas.
 */
export function palcoDeVideo(a: {
  readonly telaLigada: boolean;
  readonly parComTela: boolean;
}): PalcoDeVideo {
  if (a.parComTela) return { tela: "par", comSom: true };
  if (a.telaLigada) return { tela: "eu", comSom: false };
  return { tela: null, comSom: false };
}
