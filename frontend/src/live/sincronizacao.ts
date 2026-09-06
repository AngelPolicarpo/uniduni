/**
 * O sincronizador: enche o espelho das stores com o que o núcleo responde (§15.6), reage
 * aos eventos de §15.5 e injeta nas stores o canal de **escrita** (§15.4).
 *
 * Este é o único módulo que sabe que existe IPC-R **e** que existem stores. Os componentes
 * continuam lendo as stores como sempre leram; as stores continuam resolvendo
 * `criado[id] ?? espelho[id] + override`. A diferença é que o espelho agora vem do núcleo.
 *
 * Evento é **sinal para reconsultar**, nunca fonte de verdade (§15.1 regra 5). A exceção
 * declarada é o par de desfechos da outbox (`message.accepted`/`message.failed`, §11.6):
 * eles EXISTEM para casar a bolha otimista pelo `clientRef`, e é isso que os handlers
 * fazem — o conteúdo da linha aceita continua vindo de `query.messages`, disparada pelo
 * `messages.appended` que sempre chega antes (DS-31).
 */

import { api, cliente } from "../ipc/api";
import { registrarResync, useSessao, type MotivoResync } from "./sessao";
import { canal as adaptarCanal, categoria, comunidade, identidade, cargo, membroDeEntrada, bolhaDaFila, reacoes, anexo, entradaDeAuditoria, banido, timeout as adaptarTimeout } from "./adaptadores";
import { codigoDoErro } from "../ipc/frames";
import { estaFalando } from "./vad";
import type { EvMessageAccepted, AuditItem, BanItem, Pagina, TimeoutItem } from "../ipc/dto";
import { useCommunityStore } from "../store/communityStore";
import { useIdentityStore } from "../store/identityStore";
import { useVoiceStore } from "../store/voiceStore";
import { MalhaDeVoz, motivoDoErroDeMicrofone } from "./voz";
import { acharMonitorDeSistema } from "./dispositivos";
import { EstrelaDeTela } from "./tela";
import { CameraDaChamada, motivoDoErroDeCamera } from "./camera";
import {
  esquecerTelaRecebida,
  esquecerTodasAsTelas,
  guardarTelaDoApresentador,
  guardarTelaRecebida,
} from "./telaStreams";
import {
  esquecerCameraRecebida,
  esquecerTodasAsCameras,
  guardarCameraLocal,
  guardarCameraRecebida,
} from "./cameraStreams";
import { useMessageStore } from "../store/messageStore";
import { useDownloadStore } from "../store/downloadStore";
import { useModerationStore } from "../store/moderationStore";
import { useSettingsStore } from "../store/settingsStore";
import { assinarDm, sincronizarConversas, sincronizarPrefsDm } from "./dm";
import { assinarDmVoz } from "./dmVoz";
import { mensagem as adaptarMensagem, threadsDaPagina } from "./adaptadores";
import type { Category, Channel, Community, Member, Message, Role, Thread } from "../domain/types";

/** Evita consultas concorrentes para a mesma comunidade quando vários eventos chegam juntos. */
const emVoo = new Set<string>();

async function comExclusao<T>(chave: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (emVoo.has(chave)) return undefined;
  emVoo.add(chave);
  try {
    return await fn();
  } finally {
    emVoo.delete(chave);
  }
}

/** `query.identity` → o `Identity` que o mock consome. */
export async function sincronizarIdentidade(): Promise<void> {
  const d = await api.identity().catch(() => null);
  if (d === null) return;
  const eu = identidade(d);
  useIdentityStore.setState({ identity: eu });
  useCommunityStore.getState().aplicarRemoto({ euId: eu.id });
}

/**
 * `query.communities` → rail. A lista chega na ordem de entrada, que é exatamente a ordem
 * que o rail do mock espera — nada é reordenado aqui.
 */
export async function sincronizarComunidades(): Promise<void> {
  const lista = await api.communities().catch(() => null);
  if (lista === null) return;
  const store = useCommunityStore.getState();
  const communities: Record<string, Community> = { ...store.remote.communities };
  for (const c of lista) {
    // Preserva o que a estrutura já preencheu (`categoryIds`), senão trocar de tela
    // esvaziaria a lista de canais até a próxima consulta.
    const anterior = communities[c.id];
    communities[c.id] = {
      ...comunidade(c),
      ...(anterior !== undefined
        ? { categoryIds: anterior.categoryIds, roleIds: anterior.roleIds, hostPeerId: anterior.hostPeerId }
        : {}),
    };
  }
  store.aplicarRemoto({ communities, order: lista.map((c) => c.id) });
  // O rail mostra as comunidades das quais se participa; com dado real, participar É estar
  // na resposta de `query.communities`. A ativa segue a mesma régua: excluída do rail
  // (`community.forget`, U-17/B8), ela não pode continuar ativa — o registro velho no
  // espelho ainda existiria e o shell desenharia uma comunidade que o manifest já apagou.
  useCommunityStore.setState((s) => ({
    joinedCommunityIds: lista.map((c) => c.id),
    activeCommunityId: lista.some((c) => c.id === s.activeCommunityId)
      ? s.activeCommunityId
      : lista[0]?.id ?? null,
  }));
}

/** `query.structure` + `query.community` + `query.roles` → categorias, canais e cargos. */
export async function sincronizarComunidade(communityId: string): Promise<void> {
  await comExclusao(`com:${communityId}`, async () => {
    const [estrutura, detalhe, cargos] = await Promise.all([
      api.structure(communityId).catch(() => null),
      api.community(communityId).catch(() => null),
      api.roles(communityId).catch(() => null),
    ]);
    if (estrutura === null) return;
    const store = useCommunityStore.getState();

    const categories: Record<string, Category> = { ...store.remote.categories };
    const channels: Record<string, Channel> = { ...store.remote.channels };
    for (const cat of estrutura.categories) {
      categories[cat.id] = categoria(communityId, cat);
      for (const ch of cat.channels) channels[ch.id] = adaptarCanal(communityId, cat.id, ch);
    }

    const roles: Record<string, Role> = { ...store.remote.roles };
    // `rank` é índice fracionário e não vira inteiro; a ordem do array (rank DESC) É a
    // hierarquia, então a posição do mock é o ordinal invertido.
    const lista = cargos?.roles ?? [];
    lista.forEach((r, i) => {
      roles[r.id] = cargo(r, lista.length - i);
    });

    const anterior = store.remote.communities[communityId];
    const communities = { ...store.remote.communities };
    if (anterior !== undefined) {
      communities[communityId] = {
        ...anterior,
        categoryIds: estrutura.categories.map((c) => c.id),
        roleIds: lista.map((r) => r.id),
        ...(detalhe !== null ? { hostPeerId: detalhe.hostRef.key, memberCount: detalhe.memberCount } : {}),
      };
    }
    store.aplicarRemoto({ categories, channels, roles, communities });
  });
}

/** `query.members` → roster. Os grupos vêm por cargo; o membro carrega o cargo do grupo. */
export async function sincronizarMembros(communityId: string): Promise<void> {
  const pagina = await api.members({ communityId, limit: 100 }).catch(() => null);
  if (pagina === null) return;
  const membros: Member[] = [];
  for (const g of pagina.groups) {
    for (const m of g.members) membros.push(membroDeEntrada(communityId, m, g.roleId));
  }
  const store = useCommunityStore.getState();
  store.aplicarRemoto({
    membersByCommunity: { ...store.remote.membersByCommunity, [communityId]: membros },
  });
}

/** `query.invites` → convites da comunidade. */
export async function sincronizarConvites(communityId: string): Promise<void> {
  const r = await api.invites(communityId).catch(() => null);
  if (r === null) return;
  const store = useCommunityStore.getState();
  const outras = store.remote.invites.filter((i) => i.communityId !== communityId);
  store.aplicarRemoto({
    invites: [
      ...outras,
      ...r.items.map((i) => ({
        // O mock chaveia convite por `code`; §15.6 só entrega o código a quem o criou NESTA
        // instalação (delta U-04). Sem código, a chave pública é o identificador estável.
        code: i.code ?? i.invitePublicKey,
        communityId,
        createdById: i.createdBy.key,
        createdAt: new Date(i.createdAt).toISOString(),
        ...(i.expiresAt !== undefined ? { expiresAt: new Date(i.expiresAt).toISOString() } : {}),
        ...(i.maxUses !== undefined ? { maxUses: i.maxUses } : {}),
        uses: i.uses,
        revoked: i.revokedAt !== undefined,
      })),
    ],
  });
}

/**
 * Leituras de moderação de §15.6 — `query.auditLog`/`query.bans`/`query.timeouts`.
 * As três exigem `view_audit_log`: a recusa `E_PERMISSION_DENIED` é ESTADO aqui
 * (a tela diz "sem permissão"), não silêncio que fingiria que nada aconteceu.
 */
export async function sincronizarModeracao(communityId: string): Promise<void> {
  await comExclusao(`mod:${communityId}`, async () => {
    const [log, bans, timeouts] = await Promise.all([
      api.auditLog({ communityId, limit: 50 }).catch((e) => e as Pagina<AuditItem> | Error),
      api.bans({ communityId }).catch((e) => e as Pagina<BanItem> | Error),
      api.timeouts({ communityId }).catch((e) => e as Pagina<TimeoutItem> | Error),
    ]);
    // A permissão é UMA para as três: só vale o flag quando TODAS negarem —
    // falha parcial preserva o espelho e não mente sobre permissão.
    const negadas = [log, bans, timeouts].filter((r) => r instanceof Error);
    if (negadas.length > 0 && negadas.every((r) => codigoDoErro(r) === "E_PERMISSION_DENIED")) {
      useModerationStore.getState().aplicarRemoto({
        auditLog: [], bans: [], timeouts: [], semPermissao: true,
      });
      return;
    }
    const store = useModerationStore.getState();
    store.aplicarRemoto({
      semPermissao: false,
      auditLog:
        log instanceof Error
          ? store.auditLog
          : log.items.map((item) => entradaDeAuditoria(item, communityId)),
      bans:
        bans instanceof Error
          ? store.bans
          : bans.items.map((item) => banido(item, communityId)),
      timeouts:
        timeouts instanceof Error
          ? store.timeouts
          : timeouts.items
              .map((item) => adaptarTimeout(item, communityId))
              .filter((t) => t !== null),
    });
  });
}

/**
 * Não-lidas por thread de um canal (§9, 2.2) — `query.thread.unread` responde só as
 * com contador acima de zero; ausência no mapa É "lida". Roda nos MESMOS gatilhos da
 * página de mensagens: carregar o canal, resposta que chega, resync e leitura.
 *
 * O resultado é guardado SOB O CANAL consultado. Sem isso, duas sincronizações
 * concorrentes (troca de canal com a resposta da anterior chegando por último)
 * deixavam o mapa do canal errado na tela e os badges do canal aberto sumiam.
 */
export async function sincronizarThreadsNaoLidas(communityId: string, channelId: string): Promise<void> {
  const pagina = await api.threadUnread({ communityId, channelId }).catch(() => null);
  if (pagina === null) return;
  const porThread: Record<string, number> = {};
  for (const item of pagina.items) porThread[item.threadId] = item.unreadCount;
  useMessageStore.getState().aplicarNaoLidasDeThreads(channelId, porThread);
}

/**
 * Resolve a raiz de cada thread nova pela fonte autoritativa (`threads.root_message_id`,
 * via `query.thread`) e a registra em `remoteThreads`. Só as ainda desconhecidas chegam
 * aqui — é uma consulta por thread, uma vez na vida dela nesta sessão.
 */
async function resolverRaizesDeThreads(communityId: string, threadIds: readonly string[]): Promise<void> {
  const lidas = await Promise.all(
    threadIds.map((threadId) =>
      api
        .thread({ communityId, threadId })
        .then((dto) => (dto === null ? null : { threadId, dto }))
        .catch(() => null),
    ),
  );
  const store = useMessageStore.getState();
  const novas: Record<string, Thread> = {};
  for (const lida of lidas) {
    if (lida === null) continue;
    // Uma thread pode ter sido assentada enquanto a consulta ia e voltava.
    if (store.remoteThreads[lida.threadId] !== undefined || store.createdThreads[lida.threadId] !== undefined) continue;
    novas[lida.threadId] = {
      id: lida.threadId,
      rootMessageId: lida.dto.root.id,
      channelId: lida.dto.root.channelId,
      replyIds: [],
      participantIds: [],
      unreadCount: lida.dto.unread.count,
    };
  }
  if (Object.keys(novas).length === 0) return;
  const atual = useMessageStore.getState();
  atual.aplicarRemoto({ remoteThreads: { ...atual.remoteThreads, ...novas } });
}

/** `query.messages` → histórico do canal. */
export async function sincronizarMensagens(communityId: string, channelId: string): Promise<void> {
  await comExclusao(`msg:${channelId}`, async () => {
    const pagina = await api
      .messages({ communityId, channelId, limit: 50, direction: "before" })
      .catch(() => null);
    if (pagina === null) return;
    const eu = useCommunityStore.getState().remote.euId;
    const store = useMessageStore.getState();
    const mensagens: Message[] = pagina.messages.map((m) => adaptarMensagem(m, eu));
    // Threads de OUTRAS instalações que a página revelou (§61.4): sem isto o chip
    // "N respostas" não renderiza e o painel não abre para quem não criou a thread.
    const conhecidas = new Set([...Object.keys(store.remoteThreads), ...Object.keys(store.createdThreads)]);
    const novas = threadsDaPagina(pagina.messages, conhecidas);
    store.aplicarRemoto({ remoteMessages: { ...store.remoteMessages, [channelId]: mensagens } });
    // A raiz vem de `query.thread`, não de palpite sobre a página: a janela de 50
    // de §23.3 pode não conter a raiz, e ancorar o chip numa resposta o deixaria no
    // lugar errado para sempre (`conhecidas` não reabre o caso).
    if (novas.length > 0) void resolverRaizesDeThreads(communityId, novas);
    // A raiz projetou o `threadId` real? Assenta a criação otimista (§8.x R-24).
    for (const m of mensagens) {
      if (m.threadId !== undefined) store.assentarThreadReal(m.id, m.threadId);
    }
    // §9 2.2 — os badges de thread vivem nos MESMOS gatilhos da página: carregar o
    // canal, resposta que chega (`messages.appended`) e resync passam por aqui.
    await sincronizarThreadsNaoLidas(communityId, channelId);
  });
}

/**
 * `query.outbox` → a fila redesenhada (F-16). Só viram bolhas os itens desta
 * instalação com `clientRef` e preview de conteúdo; o resto da fila (ops de
 * estrutura, reações, de outras janelas) não é linha de canal.
 */
export async function sincronizarFila(communityId: string): Promise<void> {
  await comExclusao(`fila:${communityId}`, async () => {
    const dto = await api.outbox(communityId).catch(() => null);
    if (dto === null) return;
    useMessageStore.getState().aplicarFila(
      dto.items
        .map(bolhaDaFila)
        .filter((b) => b !== null),
    );
  });
}

/** O que a comunidade ativa precisa ter carregado. */
export async function abrirComunidade(communityId: string): Promise<void> {
  await Promise.all([
    sincronizarComunidade(communityId),
    sincronizarMembros(communityId),
    sincronizarConvites(communityId),
    sincronizarFila(communityId),
    sincronizarModeracao(communityId),
  ]);
}

/**
 * O canal de comunidade de um canal de texto, resolvido na hora do despacho.
 * A store não conhece o mapeamento — este módulo sim (é o que ele existe para).
 */
function comunidadeDoCanal(channelId: string): string {
  const canal = useCommunityStore.getState().remote.channels[channelId];
  if (canal === undefined) throw new Error("O canal não pertence a uma comunidade conhecida");
  return canal.communityId;
}

/** Erro de consulta vira falha nomeada; cancelamento nativo não é falha. */
function erroDeEscrita(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * O canal de escrita real (§15.4): cada comando responde `{opId, state}` e o
 * desfecho vem por evento — nada aqui espera entrega. Cancelamento do diálogo
 * nativo (`E_CANCELLED`) não é falha: volta como gesto abortado, sem bolha.
 * Os demais códigos sobem como a mensagem do erro, que é o código de §20.
 */
function configurarEscritaDeMensagem(): void {
  useMessageStore.getState().configurarEscrita({
    async enviar(entrada) {
      try {
        const r = await api.messageSend({
          communityId: entrada.communityId,
          channelId: entrada.channelId,
          content: entrada.content,
          mentions: entrada.mentions,
          clientRef: entrada.clientRef,
          ...(entrada.replyToId !== undefined ? { replyToId: entrada.replyToId } : {}),
          ...(entrada.threadId !== undefined ? { threadId: entrada.threadId } : {}),
          ...(entrada.attachment !== undefined ? { attachment: entrada.attachment } : {}),
        });
        return { opId: r.opId };
      } catch (e) {
        if (codigoDoErro(e) === "E_CANCELLED") return { opId: "", cancelado: true };
        throw erroDeEscrita(e);
      }
    },
    reenviar: (opId) => api.messageRetry(opId).then(() => undefined),
    async editar(entrada) {
      const r = await api.messageEdit({
        communityId: comunidadeDoCanal(entrada.channelId),
        messageId: entrada.messageId,
        content: entrada.content,
        clientRef: entrada.clientRef,
      });
      return { opId: r.opId };
    },
    async apagar(entrada) {
      const r = await api.messageDelete({
        communityId: comunidadeDoCanal(entrada.channelId),
        messageId: entrada.messageId,
        clientRef: entrada.clientRef,
      });
      return { opId: r.opId };
    },
    async fixar(entrada) {
      const r = await api.messagePin({
        communityId: comunidadeDoCanal(entrada.channelId),
        messageId: entrada.messageId,
        pinned: entrada.pinned,
        clientRef: entrada.clientRef,
      });
      return { opId: r.opId };
    },
    async reagir(entrada) {
      const r = await api.messageReact({
        communityId: comunidadeDoCanal(entrada.channelId),
        messageId: entrada.messageId,
        emoji: entrada.emoji,
        present: entrada.present,
        clientRef: entrada.clientRef,
      });
      return { opId: r.opId };
    },
    async abrirThread(entrada) {
      const r = await api.threadCreate({
        communityId: comunidadeDoCanal(entrada.channelId),
        rootMessageId: entrada.rootMessageId,
        clientRef: entrada.clientRef,
      });
      return { opId: r.opId };
    },
    /** §15.6.1 — reações e anexo não viajam na lista; hidratam por demanda. */
    observarReacoes(channelId, messageId) {
      const communityId = comunidadeDoCanal(channelId);
      void api
        .message({ communityId, messageId })
        .then((cheia) => {
          if (cheia === null) return;
          const eu = useCommunityStore.getState().remote.euId;
          const store = useMessageStore.getState();
          store.aplicarReacoesRemotas(messageId, reacoes(cheia.reactions, eu));
          // §13 — o anexo vem na MESMA leitura; o card de download/reveal é dele.
          if (cheia.attachment !== undefined) {
            store.aplicarAnexoRemoto(messageId, anexo(cheia.attachment, communityId));
          }
        })
        .catch(() => {});
    },
    /** §15.6 `query.reactors` (DR-47) — quem reagiu; o chip só conhece o total. */
    observarReatores(channelId, messageId, emoji) {
      const communityId = comunidadeDoCanal(channelId);
      void api
        .reactors({ communityId, messageId, emoji })
        .then((dto) => {
          useMessageStore.getState().aplicarReatores(messageId, emoji, {
            total: dto.total,
            identityIds: dto.users.map((u) => u.key),
          });
        })
        .catch(() => {});
    },
    /** §15.6 — respostas além da janela de 50 do canal e o total do fio. */
    observarThread(communityId, threadId) {
      void api
        .thread({ communityId, threadId })
        .then((dto) => {
          if (dto === null) return;
          const eu = useCommunityStore.getState().remote.euId;
          useMessageStore.getState().aplicarThreadRemota(threadId, {
            respostas: dto.replies.map((m) => adaptarMensagem(m, eu)),
            total: dto.replyCount,
          });
        })
        .catch(() => {});
    },
    /** §9 2.2 — a abertura do painel marca leitura; a reconsulta tira o badge. */
    marcarThreadLida(communityId, threadId) {
      void api
        .threadMarkRead({ communityId, threadId })
        .then(() => {
          const cid = useCommunityStore.getState().activeChannelByCommunity[communityId];
          if (cid !== undefined) void sincronizarThreadsNaoLidas(communityId, cid);
        })
        .catch(() => {});
    },
  });
}

/**
 * B43 — reentrada automática de voz pós-respawn do núcleo.
 *
 * O núcleo reinicia no meio da chamada (epoch novo): a sessão de voz dele morre sem
 * evento nenhum — ela é efêmera (§6.16) — e o renderer continuava mostrando a chamada
 * de pé, surdo e mudo. No resync de §15.2(4d) com chamada ativa, reexecuta o
 * `voice.join` idempotente (nova sessão), que é o mesmo caminho do "Tentar novamente".
 *
 * Só no `epoch`: `stale` é uma janela de eventos estourada (§15.1 r.5) e `recarregar` é
 * boot ou comunidade nova — refazer a chamada ali derrubaria quem está nela sem motivo.
 * A falha do re-join não é silenciada: `retryJoin` põe `failed` com o motivo, e o botão
 * de sempre continua valendo. Câmera, tela e música seguem o mesmo destino do retry
 * manual (nascem limpos) — a voz é o que volta sozinha.
 */
export function reentrarVozSePreciso(motivo: MotivoResync): void {
  if (motivo.tipo !== "epoch") return;
  const voz = useVoiceStore.getState();
  if (voz.channelId === null || voz.communityId === null || voz.localId === null) return;
  voz.retryJoin();
}

/**
 * Assinaturas de §15.5. Cada uma dispara a consulta correspondente — nenhuma aplica payload.
 * Sem filtro de comunidade de propósito: o rail reage a todas, e recortar faria as demais
 * pararem de atualizar.
 */
export function assinarSincronizacao(): void {
  const ativa = (): string | null => useCommunityStore.getState().activeCommunityId;
  const daAtiva = (d: unknown): boolean => (d as { communityId?: string })?.communityId === ativa();

  const recarregarAtiva = (): void => {
    const cid = ativa();
    if (cid !== null) void abrirComunidade(cid);
  };

  cliente.subscribe("community.joined", () => void sincronizarComunidades());
  cliente.subscribe("community.left", () => void sincronizarComunidades());
  cliente.subscribe("community.ended", () => void sincronizarComunidades());
  // §18.4 passo 4 — o núcleo acabou de marcar a réplica como histórica. Recarregar a lista
  // é o que traz `removedReason`/`retainUntil` e faz a tela de U-16 aparecer; sem isto o
  // renderer só descobriria a remoção no próximo boot.
  cliente.subscribe("community.accessRevoked", () => void sincronizarComunidades());
  cliente.subscribe("community.changed", () => {
    void sincronizarComunidades();
    recarregarAtiva();
  });
  cliente.subscribe("community.replication", (d) => {
    const ev = d as { communityId?: string; state?: string };
    void sincronizarComunidades();
    // A PRIMEIRA sincronização da comunidade ativa é o momento em que o log
    // recém-chegado vira estrutura, roster e fila consultáveis — quem entrou
    // por convite abriu a tela contra uma réplica ainda vazia.
    if (ev.state === "synced" && ev.communityId !== undefined && ev.communityId === ativa()) {
      void abrirComunidade(ev.communityId);
    }
  });
  cliente.subscribe("community.replication", () => void sincronizarComunidades());
  cliente.subscribe("host.statusChanged", () => void sincronizarComunidades());
  cliente.subscribe("unread.changed", () => {
    void sincronizarComunidades();
    recarregarAtiva();
  });
  cliente.subscribe("structure.changed", (d) => {
    if (daAtiva(d)) void sincronizarComunidade(ativa()!);
  });
  cliente.subscribe("roles.changed", (d) => {
    if (daAtiva(d)) void sincronizarComunidade(ativa()!);
  });
  cliente.subscribe("members.changed", (d) => {
    if (daAtiva(d)) void sincronizarMembros(ativa()!);
  });
  cliente.subscribe("invites.changed", (d) => {
    if (daAtiva(d)) void sincronizarConvites(ativa()!);
  });
  // §15.5 — o fold notifica TODA auditoria nova (punição, cargo, canal, convite
  // revogado): reconsulta as três leituras de moderação da comunidade ativa.
  cliente.subscribe("auditLog.changed", (d) => {
    if (daAtiva(d)) void sincronizarModeracao(ativa()!);
  });
  cliente.subscribe("messages.appended", (d) => {
    const ev = d as { communityId?: string; channelId?: string };
    if (ev.communityId !== undefined && ev.channelId !== undefined) {
      void sincronizarMensagens(ev.communityId, ev.channelId);
    }
  });
  cliente.subscribe("message.updated", (d) => {
    const ev = d as { communityId?: string; channelId?: string };
    if (ev.communityId !== undefined && ev.channelId !== undefined) {
      void sincronizarMensagens(ev.communityId, ev.channelId);
    }
  });

  // ── Desfechos da outbox (§11.6/§11.7) — casam a bolha pelo clientRef ───────
  const refDo = (ev: { clientRef?: string; opId: string }): string => ev.clientRef ?? ev.opId;
  cliente.subscribe("message.accepted", (d) => {
    const ev = d as EvMessageAccepted;
    useMessageStore.getState().assentarAceita(refDo(ev), ev.messageId);
  });
  cliente.subscribe("message.failed", (d) => {
    const ev = d as { opId: string; clientRef?: string; code: string };
    // `retryInMs` com erro transitório NÃO é falha para a UI: a outbox volta a
    // retentar sozinha (§11.3), e a bolha segue no estado que `query.outbox` disser.
    useMessageStore.getState().marcarFalha(refDo(ev), ev.code);
  });
  cliente.subscribe("message.dropped", (d) => {
    const ev = d as { opId: string; clientRef?: string; reason: string };
    useMessageStore.getState().marcarFalha(refDo(ev), `descartada (${ev.reason})`);
  });
  cliente.subscribe("outbox.changed", (d) => {
    const communityId = (d as { communityId?: string }).communityId;
    if (typeof communityId === "string") void sincronizarFila(communityId);
  });

  // ── Downloads (§13.4) — a chave do fio é o blobIdHex (emenda de 2026-08-22) ──
  const downloads = useDownloadStore.getState();
  cliente.subscribe("blob.progress", (d) => {
    const ev = d as { blobIdHex?: string; progress?: number; peers?: number; hostAvailable?: boolean };
    if (typeof ev.blobIdHex === "string" && typeof ev.progress === "number") {
      downloads.aplicarProgresso(ev.blobIdHex, Math.round(ev.progress * 100), ev.peers ?? 0, ev.hostAvailable === true);
    }
  });
  cliente.subscribe("blob.completed", (d) => {
    const blobIdHex = (d as { blobIdHex?: string }).blobIdHex;
    if (typeof blobIdHex === "string") downloads.aplicarConcluido(blobIdHex);
  });
  cliente.subscribe("blob.peerLost", (d) => {
    const ev = d as { blobIdHex?: string; remaining?: number };
    if (typeof ev.blobIdHex === "string" && typeof ev.remaining === "number") {
      downloads.aplicarPeerLost(ev.blobIdHex, ev.remaining);
    }
  });
  cliente.subscribe("blob.unavailable", (d) => {
    const blobIdHex = (d as { blobIdHex?: string }).blobIdHex;
    if (typeof blobIdHex === "string") downloads.aplicarIndisponivel(blobIdHex);
  });
  cliente.subscribe("attachment.corrupt", (d) => {
    const ev = d as { blobIdHex?: string; cause?: string };
    if (typeof ev.blobIdHex === "string") downloads.aplicarCorrompido(ev.blobIdHex, ev.cause ?? "hash");
  });

  cliente.subscribe("core.ready", () => {
    void sincronizarIdentidade().then(() => sincronizarComunidades());
  });

  // §15.2 4d — depois de um reinício do núcleo, tudo que está na tela é reconsultado.
  registrarResync((motivo) => {
    void sincronizarIdentidade();
    void sincronizarComunidades();
    recarregarAtiva();
    const cid = ativa();
    const chid = cid !== null ? useCommunityStore.getState().activeChannelByCommunity[cid] : undefined;
    if (cid !== null && chid !== undefined) void sincronizarMensagens(cid, chid);
    if (cid !== null) void sincronizarFila(cid);
    if (cid !== null) void sincronizarModeracao(cid);
    reentrarVozSePreciso(motivo);
  });
}

/** Sobe a sessão, injeta a escrita e carrega o primeiro lote. Chamada uma vez, na raiz. */
/**
 * Preferências locais de §15.4 — "escrita direta no LS, sem host e sem fila".
 * As ações das stores continuam síncronas (o LS é delas); a porta injetada
 * replica a MESMA decisão para o núcleo persistir, sem fila nem retentativa.
 */
function configurarEscritaDePreferencias(): void {
  useSettingsStore.getState().configurarEscrita({
    setDevice: (kind, deviceId) => api.settingsSetDevice({ kind, deviceId }),
    setVolume: (kind, value) => api.settingsSetVolume({ kind, value }),
    setNotifications: (arg) => api.settingsSetNotifications(arg),
  });
  useCommunityStore.getState().configurarPreferencias({
    setMuted: async (channelId, muted) => {
      // O canal sabe a comunidade dele; o fio de §15.4 exige as duas chaves.
      const cid = useCommunityStore.getState().remote.channels[channelId]?.communityId;
      if (cid === undefined) return;
      await api.channelSetMuted({ communityId: cid, channelId, muted });
    },
    setCollapsed: async (communityId, categoryId, collapsed) =>
      api.categorySetCollapsed({ communityId, categoryId, collapsed }),
  });
}

/** `query.preferences` → dispositivos/volumes/notificações. Uma leitura no boot; mute/recolher já vêm na `query.structure`. */
export async function sincronizarPreferencias(): Promise<void> {
  const p = await api.preferences().catch(() => null);
  if (p === null) return;
  useSettingsStore.getState().aplicarRemoto(p);
}


/**
 * §17.2/§17.4 — a malha de voz ligada ao store. A separação: `MalhaDeVoz` fala WebRTC e não
 * sabe o que é uma tela; o `voiceStore` guarda o estado que a tela lê e não sabe o que é um
 * `RTCPeerConnection`. Este é o único lugar onde os dois se encontram.
 *
 * Os quatro eventos de §15.5 entram aqui. `voice.signal` **já veio autorizado** pelo núcleo
 * (§17.4 passo 3, `signalIsAuthorized`), então o que a malha faz com ele é só negociar.
 */
function configurarVoz(): void {
  const malha = new MalhaDeVoz(
    {
      join: (a) =>
        api.voiceJoin(a).then((r) => ({
          sessionId: r.sessionId,
          roster: r.roster,
          iceServers: r.iceServers,
          tickets: r.tickets,
        })),
      leave: () => api.voiceLeave(),
      signal: (a) => api.voiceSignal(a),
    },
    {
      capturar: async (deviceId) =>
        await navigator.mediaDevices.getUserMedia({
          // `default` é o padrão do sistema: mandar o id literal recusaria a captura.
          // EC/NS/AGC são as "configurações de voz" do Épico 4: ligadas por default,
          // desligáveis por quem canta com música (o AGC abaixa a voz no meio do playback).
          audio:
            deviceId === "default"
              ? {
                  echoCancellation: useSettingsStore.getState().processamentoVoz,
                  noiseSuppression: useSettingsStore.getState().processamentoVoz,
                  autoGainControl: useSettingsStore.getState().processamentoVoz,
                }
              : {
                  deviceId: { exact: deviceId },
                  echoCancellation: useSettingsStore.getState().processamentoVoz,
                  noiseSuppression: useSettingsStore.getState().processamentoVoz,
                  autoGainControl: useSettingsStore.getState().processamentoVoz,
                },
        }),
      conexao: (config) => new RTCPeerConnection(config),
    },
    {
      aoMudarPar: (peerHex, estado) => {
        const mapa: Record<string, "ok" | "degraded" | "failed"> = {
          connected: "ok",
          completed: "ok",
          connecting: "degraded",
          new: "degraded",
          disconnected: "degraded",
          failed: "failed",
          closed: "failed",
        };
        useVoiceStore.getState().aplicarEstadoDoPar(peerHex, mapa[estado] ?? "degraded");
      },
      aoChegarAudio: (peerHex, stream) => tocar(peerHex, stream),
      /**
       * §17.2 (emenda de 2026-09-03) — a malha **diz** o que a trilha é, pelo m-line em que
       * ela veio. `classificarVideo` e a lacuna **B41** que ele contornava saíram daqui: não
       * há mais `msid` a cruzar com o `share.join` conseguido, nem a janela em que a câmera
       * chegando primeiro era lida como tela.
       *
       * Guardar o stream fora do React é o que deixa o `<video>` sobreviver a re-render
       * (mesma razão do mapa de `<audio>`).
       */
      aoChegarVideo: (peerHex, stream, _track, origem) => {
        const de = peerHex.toLowerCase();
        if (origem === "tela") {
          // §17.5 (2026-08-26) — o canal pode ter várias transmissões vivas. A trilha é da
          // sessão de QUEM a mandou; sem esta busca por apresentador, a segunda tela do
          // canal seria descartada como "não é de quem apresenta".
          const daquele = useVoiceStore
            .getState()
            .shares.find((s) => s.presenterId.toLowerCase() === de);
          if (daquele === undefined) {
            // Chegou tela de quem não tem sessão anunciada. O m-line não mente sobre o que a
            // trilha é, mas a sessão é do host: sem ela não há a que ligar a imagem.
            console.log("[tela] trilha sem sessão anunciada de", peerHex.slice(0, 8));
            return;
          }
          console.log("[tela] vídeo recebido de", peerHex.slice(0, 8));
          guardarTelaRecebida(peerHex, stream);
          // A tela chegou: quem assiste sai de "Preparando compartilhamento…".
          useVoiceStore.setState((st) => ({
            shares: st.shares.map((s) =>
              s.sessionId === daquele.sessionId ? { ...s, phase: "live" as const } : s,
            ),
          }));
          return;
        }
        console.log("[camera] vídeo recebido de", peerHex.slice(0, 8));
        guardarCameraRecebida(peerHex, stream);
        // A trilha é a prova de que a câmera está ligada, e ela pode chegar antes do roster
        // que a anuncia. O host continua mandando; até o eco voltar, o tile mostra o que
        // está de fato entrando.
        useVoiceStore.getState().cameraDoParChegou(peerHex);
      },
      /**
       * §17.2 (emenda de 2026-09-03) — a trilha parou, e agora isso é observável: com o
       * m-line reservado, desligar vira `muted` em vez de sumiço.
       *
       * O roster do host continua sendo quem manda no `cameraOn` de §17.6 — este evento não
       * o contradiz, ele solta o pixel. Manter o `MediaStream` de uma trilha morta deixaria
       * o tile com o último quadro congelado no lugar do avatar.
       */
      aoSumirVideo: (peerHex, origem) => {
        if (origem === "tela") {
          esquecerTelaRecebida(peerHex);
          return;
        }
        // O `cameraOn` de §17.6 continua sendo do roster do host: este evento solta o
        // pixel, não contradiz o estado. Inventar aqui um "ele desligou" seria decidir por
        // observação local o que a comunidade já decide por roster.
        esquecerCameraRecebida(peerHex);
      },
      aoFalhar: (motivo) => useVoiceStore.getState().falhouAoConectar(motivo),
      aoSair: () => pararTudo(),
      // O mic morreu e a chamada segue em somente-escuta: avisa sem encerrar, e a
      // recuperação é a troca de dispositivo com a chamada de pé (assinatura abaixo).
      aoMicrofoneAusente: (motivo) => useVoiceStore.getState().microfoneCaiu(motivo),
    },
  );

  /**
   * §17.5 item 7 — o Modo Música onde a plataforma **não** tem loopback: o monitor de
   * reprodução, aberto por `getUserMedia` e misturado pelo mesmo grafo — a integração
   * WebRTC não muda, só a fonte do sistema muda.
   *
   * **Emenda de 2026-09-03 — isto é último recurso, não o caminho do Linux.** O texto
   * anterior dizia que o Chromium lista o monitor do PulseAudio/PipeWire como
   * `audioinput` comum. Ele não lista: `AudioManagerPulse::InputDevicesInfoCallback`
   * descarta toda fonte com `monitor_of_sink != PA_INVALID_INDEX` ("Exclude output
   * monitor (i.e. loopback) devices"), justamente para que ninguém capture o som da
   * máquina por trás de uma permissão de microfone. O que sobra para o `/monitor/i`
   * casar é uma fonte que a PESSOA criou (um `module-remap-source`, por exemplo), que
   * não é monitor aos olhos do Pulse e por isso aparece. O caminho do Linux passou a
   * ser o loopback de verdade (ver `audioDaCaptura` no main).
   *
   * Rótulos vazios não casam com nada: a permissão é pedida pelo caminho normal
   * (abre e fecha o mic, como a tela de ajustes faz) e a lista é relida com nomes.
   * O processamento de voz fica DESLIGADO nesta captura — ele é do mic (§17.5
   * item 6); aqui "limparia" a música.
   */
  async function ligarMusicaDoMonitor(): Promise<{ erro: "indisponivel" | "negado" | null }> {
    const md = navigator.mediaDevices;
    if (md === undefined) return { erro: "indisponivel" };
    let lista: MediaDeviceInfo[];
    try {
      lista = await md.enumerateDevices();
    } catch {
      return { erro: "indisponivel" };
    }
    if (lista.some((d) => d.deviceId !== "" && d.label === "")) {
      try {
        const perm = await md.getUserMedia({ audio: true });
        for (const t of perm.getTracks()) t.stop();
        lista = await md.enumerateDevices();
      } catch {
        return { erro: "indisponivel" };
      }
    }
    const monitorId = acharMonitorDeSistema(lista);
    if (monitorId === null) return { erro: "indisponivel" };
    let monitor: MediaStream;
    try {
      monitor = await md.getUserMedia({
        audio: {
          deviceId: { exact: monitorId },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    } catch {
      return { erro: "indisponivel" };
    }
    const misturou = await malha.ativarMusica(monitor).catch(() => false);
    if (!misturou) {
      for (const t of monitor.getTracks()) t.stop();
      return { erro: "indisponivel" };
    }
    return { erro: null };
  }

  // ─── Épico 4 — VAD real (o `speaking` de §17.6 que nunca era setado) ────────────────
  // Mede o RMS do microfone 4×/s; a virada É o envio (histerese de vad.ts), então o fio
  // só vê `voiceState` quando o estado muda — e §17.6 limita o resto.
  let vad: ReturnType<typeof setInterval> | null = null;
  let falando = false;
  const desligarVad = () => {
    if (vad !== null) clearInterval(vad);
    vad = null;
    falando = false;
  };
  const ligarVad = () => {
    desligarVad();
    vad = setInterval(() => {
      const nivel = malha.nivelDeVoz();
      if (nivel === null) return; // sem medição: VAD honestamente desligado
      const sens = useSettingsStore.getState().sensibilidadeVoz;
      // sens 0 → threshold 0.31 (só voz alta); sens 100 → 0.01 (qualquer sussurro).
      const threshold = 0.31 - sens * 0.003;
      const agora = estaFalando(nivel, threshold, falando);
      if (agora !== falando) {
        falando = agora;
        void api.voiceSetSelf({ speaking: agora }).catch(() => undefined);
      }
    }, 250);
  };

  useVoiceStore.getState().configurarVoz({
    entrar: async (a) => {
      const eu = useIdentityStore.getState().identity?.id ?? a.localId;
      const microfoneId = useSettingsStore.getState().microphoneId;
      const r = await malha.entrar({
        ...a,
        euHex: eu,
        microfoneId,
        agora: Date.now(),
        // §10, 3.1 (B47) — o volume de entrada nasce aplicado, e reage ao slider ao vivo.
        volumeEntrada: useSettingsStore.getState().inputVolume,
      });
      // Somente-escuta: sem mic a chamada está de pé do mesmo jeito — o aviso é o
      // que pede a troca de dispositivo, nunca a expulsão.
      if (r.microfoneAusente !== null) useVoiceStore.getState().microfoneCaiu(r.microfoneAusente);
      // §15.1 regra 5 — evento é sinal para reconsultar: ao entrar, puxo o instantâneo da
      // fila (§16.4) de uma vez, porque um `voice.queueChanged` perdido não volta. Foi a
      // reconsulta que revelou o primeiro clique do usuário funcionando NO HOST com a
      // tela muda — o evento morria por forma e só ela contava a verdade.
      await reconsultarFila(a);
      ligarVad();
    },
    sair: () => {
      desligarVad();
      return malha.sair();
    },
    mudarSelf: (patch) => void api.voiceSetSelf(patch).catch(() => undefined),
    // §17.4 L-12 — o mudo do PRÓPRIO microfone é efetivo, não conselho: quem controla o
    // microfone é quem o possui. Contar ao host acende o ícone do outro lado; o que
    // interrompe o áudio é a trilha.
    definirMudo: (mudo) => malha.definirMudo(mudo),
    definirSurdo: () => aplicarSaidaDeAudioATodos(),
    definirVolume: (peerHex) => {
      const el = audios.get(peerHex);
      if (el !== undefined) aplicarSaidaDeAudio(peerHex, el);
    },
    // §17.4 (emenda de 2026-08-28) — a imposição do modo de fala chega pelo roster e vira
    // efeito aqui: a trilha que SAI (mic + música) é cortada; quem a reabre é o roster.
    definirMudoImpositivo: (imposto) => malha.definirMudoImpositivo(imposto),
    // §10, 3.1 (B47) — trocar de microfone e o volume de entrada valem DURANTE a chamada.
    trocarMicrofone: (deviceId) => malha.trocarMicrofone(deviceId),
    definirVolumeEntrada: (p) => malha.definirVolumeEntrada(p),
    // §17.5 (emenda de 2026-08-28) — Modo Música, um clique: `music.start` (autorização
    // LOCAL do núcleo) → declaração da sessão ao main → `getDisplayMedia` com o loopback
    // concedido sem seletor (Windows). Recusas viram desfecho NOMEADO, nunca exceção —
    // o store decide o que a tela diz. O stream inteiro fica nesta camada; o store só
    // recebe o desfecho.
    definirMusica: async (ligada) => {
      if (!ligada) {
        await malha.desativarMusica();
        return { erro: null };
      }
      let autorizado: { sessionId: string } | null = null;
      try {
        autorizado = await api.musicStart({ communityId: useVoiceStore.getState().communityId ?? "" });
      } catch (e) {
        const codigo = codigoDoErro(e);
        return { erro: codigo === "E_PERMISSION_DENIED" || codigo === "E_SESSION_GONE" ? "negado" : "negado" };
      }
      console.log("[musica] núcleo autorizou · sessão", autorizado.sessionId.slice(0, 8));
      await window.electron?.declareCaptureSession?.({
        sessionId: autorizado.sessionId,
        kind: "screen",
        mode: "music",
      });
      // Sem loopback não há `getDisplayMedia` a tentar: o handler negaria de todo jeito
      // e o monitor é o que sobra. Desde a emenda de 2026-09-03 o Linux **tem** loopback
      // (`captureSupport().screen` é verdadeiro lá), então este desvio deixou de ser o
      // caminho da plataforma. No navegador (sem shell) a escolha cancelada é resposta, e
      // o monitor não entra para não emendar um prompt de microfone no cancelamento da
      // tela.
      const ponte = window.electron;
      let semLoopback = false;
      try {
        const suporte = (await ponte?.captureSupport?.()) ?? null;
        semLoopback = ponte !== undefined && suporte !== null && suporte.screen === false;
        console.log("[musica] plataforma", suporte?.platform ?? "?", "· loopback", semLoopback ? "NÃO" : "sim");
      } catch {
        semLoopback = false;
      }
      if (semLoopback) return ligarMusicaDoMonitor();
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia(opcoesDeCaptura("screen", true));
      } catch (e) {
        // **Emenda de 2026-09-03.** Este ramo devolvia `indisponivel`, e a tela dizia
        // "indisponível nesta plataforma" — num Windows, onde a plataforma é justamente a
        // que suporta. A recusa vem do main (sessão não declarada, núcleo negou, núcleo
        // negou o som, sem tela) e a razão está no log dele; o que se pode dizer aqui é
        // que foi recusada, e dizer QUAL erro veio.
        console.log("[musica] getDisplayMedia recusou ·", e instanceof Error ? `${e.name}: ${e.message}` : String(e));
        return { erro: "recusada" };
      }
      // O vídeo é o veículo do loopback, não o produto: parado no ato, como a emenda manda.
      for (const t of stream.getVideoTracks()) t.stop();
      if (stream.getAudioTracks().length === 0) {
        console.log("[musica] a captura subiu SEM trilha de áudio — o loopback não entregou som");
        for (const t of stream.getTracks()) t.stop();
        return { erro: "sem-som" };
      }
      // `ativarMusica` diz se misturou de verdade: sucesso falso acenderia o ícone
      // sobre uma transmissão que não existe.
      const misturou = await malha.ativarMusica(stream).catch(() => false);
      if (!misturou) {
        console.log("[musica] o som chegou e a mixagem NÃO montou (sem microfone na chamada, ou sem AudioContext)");
        for (const t of stream.getTracks()) t.stop();
        return { erro: "sem-mistura" };
      }
      console.log("[musica] ligada · trilha", stream.getAudioTracks()[0]?.label ?? "?");
      return { erro: null };
    },
    definirVolumeMusica: (volume) => malha.definirVolumeMusica(volume / 100),
    // Épico 4 — o que ESTA máquina ouve: o áudio de cada par (os `<audio>` fora do React)
    // + o próprio mic. É sobre estes streams que a gravação local monta o mix.
    fluxosParaGravacao: () => {
      const remotos = [...audios.values()]
        .map((el) => el.srcObject)
        .filter((st): st is MediaStream => st instanceof MediaStream);
      const local = malha.streamLocal;
      return local !== null ? [...remotos, local] : remotos;
    },
  });

  // §16.4 (emenda de 2026-08-28) — a porta da fila de karaokê: comandos de §15.4 que
  // viram os métodos de §16.2 no membro e mutação direta no host. Recusas sobem nomeadas
  // e o store as traduz (§20.1).
  //
  // **Todo desfecho é seguido de reconsulta** (§15.1 regra 5): o evento
  // `voice.queueChanged` é at-most-once e — provado em teste — pode não chegar; quem
  // clica "Entrar na fila" precisa ver o resultado do PRÓPRIO clique, não orar por um
  // push. A consulta é a verdade; o evento só adianta o desenho dos OUTROS.
  async function reconsultarFila(a: { communityId: string; channelId: string }): Promise<void> {
    try {
      const fila = await api.voiceQueue(a);
      useVoiceStore.getState().aplicarFila({
        channelId: a.channelId,
        open: fila?.open ?? true,
        items: (fila?.items ?? []).map((i) => ({ keyHex: i.keyHex, queuedAt: i.queuedAt })),
        turn: fila?.turn ? { keyHex: fila.turn.keyHex, endsAt: fila.turn.endsAt } : null,
      });
    } catch {
      // Sem resposta, o próximo `voice.queueChanged` (ou a reentrada na chamada) corrige.
    }
  }

  useVoiceStore.getState().configurarFila({
    entrar: async (a) => {
      await api.voiceQueueJoin(a);
      await reconsultarFila(a);
    },
    sair: async (a) => {
      await api.voiceQueueLeave(a);
      await reconsultarFila(a);
    },
    moderar: async (a) => {
      await api.voiceQueueModerate(a);
      await reconsultarFila(a);
    },
  });

  configurarTela(malha);
  configurarCamera(malha);

  /**
   * §15.5 `voice.failed{reason}` → a frase que o banner de §9 (2.3) mostra. O enum é o de
   * §17.4 (motivo da revogação que encerrou a sessão inteira) mais o silêncio do host; um
   * motivo que este cliente não conhece **não** vira texto inventado — a chamada acaba com a
   * frase genérica, que é o que §16.3 regra 2 pede para tópico/campo desconhecido.
   */
  const motivoDaChamada = (reason: string | undefined): string => {
    if (reason === "channel-deleted") return "O canal desta chamada foi excluído.";
    if (reason === "community-ended") return "Esta comunidade foi encerrada.";
    if (reason === "host-unavailable") {
      return "Sem conexão com quem hospeda: a chamada não pôde continuar.";
    }
    return "A chamada de voz foi encerrada.";
  };

  cliente.subscribe("voice.roster", (d) => {
    const dado = d as { participants?: Array<{ keyHex: string }> };
    console.log("[voz] roster do host", dado.participants?.map((p) => p.keyHex.slice(0, 8)));
    if (!Array.isArray(dado.participants)) return;
    // Quem saiu da chamada leva a câmera junto. **Só quem saiu**: câmera desligada não entra
    // aqui, porque o roster que a anuncia pode chegar antes da trilha e apagar a imagem que
    // acabou de entrar — o que a esconde é `cameraOn`, que o tile já lê.
    const naChamada = new Set(dado.participants.map((p) => p.keyHex.toLowerCase()));
    for (const p of useVoiceStore.getState().participants) {
      if (!naChamada.has(p.identityId.toLowerCase())) esquecerCameraRecebida(p.identityId);
    }
    useVoiceStore.getState().aplicarRoster(dado.participants);
    malha.aplicarRoster(dado.participants);
  });

  cliente.subscribe("voice.signal", (d) => {
    malha
      .aplicarSinal(d as { peerKey: string; ticketId: string; sdp?: string; ice?: string })
      .catch((e) => {
        // Uma negociação que falha em silêncio é indistinguível de uma que nunca começou —
        // a lição de §82.3, no canal de ENTRADA de sinalização, onde ela era literal.
        console.log("[voz] sinal não aplicado —", (e as { code?: string })?.code ?? e);
      });
  });

  cliente.subscribe("voice.tickets", (d) => {
    const dado = d as {
      tickets?: Parameters<typeof malha.aplicarTickets>[0];
      iceServers?: RTCIceServer[];
    };
    if (Array.isArray(dado.tickets)) malha.aplicarTickets(dado.tickets, Date.now());
    // §17.3 — a credencial TURN é de curta duração, e a renovada viaja costurada na lista
    // (emenda de 2026-08-30). Sem isto, chamada que depende de relay morre no vencimento.
    if (Array.isArray(dado.iceServers)) malha.aplicarIceServers(dado.iceServers);
  });

  cliente.subscribe("voice.revoked", (d) => {
    // §15.5 — a revogação nomeia a SESSÃO em que aconteceu, e é por ela que se decide.
    // Trocar de canal de voz é sair da anterior (§17.4): o host emite a revogação da sessão
    // ANTIGA para quem acabou de entrar na NOVA, e tratá-la como encerramento derrubava a
    // malha que o usuário acabou de pedir — o `voice.leave` de baixo, resolvido pelo núcleo
    // contra a sessão CORRENTE, expulsava da chamada nova. O eco da sessão antiga não é
    // ordem; a limpeza dela é do `entrar`, que nasce limpo.
    const dado = d as { targetKey?: string; sessionId?: string };
    if (dado.sessionId !== undefined && malha.sessionId !== dado.sessionId) return;
    // Idem enquanto o join novo está a caminho: `entrando` cobre o intervalo em que a
    // sessão corrente ainda é a antiga, mas a nova já foi pedida.
    if (malha.entrando) return;
    if (malha.sessionId === null) return; // sem chamada não há o que encerrar
    // §17.4 — a revogação nomeia UM alvo. Se for outra pessoa, quem sai é ela: derrubar a
    // própria chamada porque alguém saiu era o efeito de ignorar `targetKey`.
    const alvo = dado.targetKey?.toLowerCase();
    const eu = useIdentityStore.getState().identity?.id?.toLowerCase();
    if (alvo !== undefined && eu !== undefined && alvo !== eu) {
      const restantes = useVoiceStore
        .getState()
        .participants.filter((p) => p.identityId.toLowerCase() !== alvo)
        .map((p) => ({ keyHex: p.identityId }));
      useVoiceStore.getState().aplicarRoster(restantes);
      malha.aplicarRoster(restantes);
      return;
    }
    void malha.sair();
    useVoiceStore.getState().encerradaPeloHost();
  });

  /**
   * §15.5/§19.8 — o encerramento NOMEADO. O host passou a emiti-lo quando a sessão inteira
   * cai por estrutura (`channel-deleted`, `community-ended`) e quando o próprio host some
   * (`host-unavailable`); sem assinante, a chamada simplesmente evaporava da tela e o
   * usuário ficava sem saber por quê.
   *
   * Chega junto com o `voice.revoked` do mesmo encerramento, e sem ordem garantida (§16.3
   * regra 1): os dois chamam a MESMA ação, e quem tem o motivo o entrega — por isso não há
   * corrida a resolver aqui. O mesmo recorte de sessão do `voice.revoked` vale aqui: o
   * `channel-deleted` do canal de onde acabei de SAIR para entrar em outro não encerra a
   * chamada nova. `host-unavailable` chega SEM `sessionId` — é local, e vale sempre.
   */
  cliente.subscribe("voice.failed", (d) => {
    const dado = d as { reason?: string; sessionId?: string };
    if (dado.sessionId !== undefined && malha.sessionId !== dado.sessionId) return;
    if (dado.sessionId !== undefined && malha.entrando) return;
    const razao = dado.reason;
    console.log("[voz] chamada encerrada pelo host:", razao ?? "sem motivo");
    void malha.sair();
    useVoiceStore.getState().encerradaPeloHost(motivoDaChamada(razao));
  });

  // §15.5 `voice.deviceError`/`RT-10` — o núcleo nomeou um problema de dispositivo que este
  // renderer não viu pela própria captura. Hoje não há produtor no núcleo (a captura é do
  // renderer, B49), mas o assinante é o que torna o tópico vivo quando existir.
  cliente.subscribe("voice.deviceError", (d) => {
    const dado = d as { kind?: string; code?: string };
    console.log("[voz] erro de dispositivo do núcleo:", dado.kind, dado.code);
    useVoiceStore.getState().registrarErroDeDispositivo(
      dado.kind === "camera" ? "A câmera foi bloqueada pelo sistema." : "O microfone foi bloqueado pelo sistema.",
    );
  });

  // §15.5 — a ocupação do CANAL, para quem está de fora da chamada. É o que faz a sidebar
  // mostrar quem já está na sala antes de entrar (RT-05).
  cliente.subscribe("voice.occupancyChanged", (d) => {
    const dado = d as { communityId?: string; channelId?: string; firstKeys?: string[] };
    console.log("[voz] ocupação do canal", dado.channelId, dado.firstKeys?.length ?? 0);
    if (typeof dado.channelId !== "string" || !Array.isArray(dado.firstKeys)) return;
    useCommunityStore.getState().aplicarOcupacaoDeVoz(dado.channelId, dado.firstKeys);
  });

  // §16.4 (emenda de 2026-08-28) — a fila de karaokê mudou. O payload é NÍVEL: é o estado
  // completo do canal, não um delta — a store substitui e o gate de transmissão lê daqui.
  cliente.subscribe("voice.queueChanged", (d) => {
    const dado = d as {
      communityId?: string;
      channelId?: string;
      open?: boolean;
      items?: Array<{ keyHex: string; queuedAt: number }>;
      turn?: { keyHex: string; endsAt: number } | null;
    };
    if (typeof dado.channelId !== "string" || !Array.isArray(dado.items)) return;
    useVoiceStore.getState().aplicarFila({
      channelId: dado.channelId,
      open: dado.open === true,
      items: dado.items,
      turn: dado.turn ?? null,
    });
  });

  // §10, 3.1 (B47) — as escolhas de DISPOSITIVO e volume passam a ter efeito em chamada.
  // Antes: persistiam e esperavam a próxima chamada (mic) ou nunca saíam da store
  // (saída, volumes). A assinatura é plana (sem `subscribeWithSelector`): compara o antes
  // e o depois e reage só ao que mudou.
  useSettingsStore.subscribe((estado, anterior) => {
    const chamada = useVoiceStore.getState();
    if (estado.microphoneId !== anterior.microphoneId && chamada.channelId !== null) {
      // A troca com a chamada de pé é também a RECUPERAÇÃO do mic ausente: sucesso
      // limpa o aviso, falha o nomeia — nos dois casos sem encerrar nada.
      malha.trocarMicrofone(estado.microphoneId).then(
        () => useVoiceStore.getState().microfoneCaiu(null),
        (e) => {
          console.log("[voz] troca de microfone falhou:", (e as Error).message);
          useVoiceStore.getState().microfoneCaiu(motivoDoErroDeMicrofone(e));
        },
      );
    }
    if (estado.inputVolume !== anterior.inputVolume && chamada.channelId !== null) {
      malha.definirVolumeEntrada(estado.inputVolume);
    }
    // Saída trocada ou volume geral movido: reaplica a todos os `<audio>` vivos (o
    // `aplicarSaidaDeAudio` leva o `setSinkId` junto quando o dispositivo mudou).
    if (
      estado.outputId !== anterior.outputId ||
      estado.outputVolume !== anterior.outputVolume
    ) {
      aplicarSaidaDeAudioATodos();
    }
  });
}

/** §20.1 — a recusa do `share.join`, em português. Vale para a primeira tentativa e para o retry. */
function motivoDaEntradaNaTela(e: unknown): string {
  return (e as { code?: string })?.code === "E_PERMISSION_DENIED"
    ? "Só quem está na chamada pode assistir a esta transmissão."
    : "Não foi possível entrar na transmissão.";
}

/**
 * §17.2 — a câmera ligada ao store, no mesmo padrão da voz (§76.1) e da tela (§83).
 *
 * `CameraDaChamada` fala captura e dispositivo e **não conhece o store**; o `voiceStore`
 * guarda o estado que o tile lê e **não conhece `MediaStream`**; a malha empresta as
 * conexões que já existem com cada par. Este é o único lugar onde os três se encontram.
 *
 * O dispositivo sai daqui, não do store: a preferência é de §10 (3.1) e mora no
 * `settingsStore`, exatamente como o microfone em `entrar`.
 */
function configurarCamera(malha: MalhaDeVoz): void {
  const camera = new CameraDaChamada(
    {
      definirVideoLocal: (track, stream) => malha.definirVideoLocal(track, stream),
      removerVideoLocal: () => malha.removerVideoLocal(),
    },
    {
      capturar: async (deviceId) =>
        await navigator.mediaDevices.getUserMedia({
          // `default` é o padrão do sistema: mandar o id literal recusaria a captura.
          video: deviceId === "default" ? true : { deviceId: { exact: deviceId } },
        }),
    },
    {
      // Cabo puxado, dispositivo tomado por outro aplicativo, permissão revogada com a
      // chamada em curso: o botão precisa apagar, e o outro lado precisa saber.
      aoEncerrarNaFonte: () => {
        guardarCameraLocal(null);
        useVoiceStore.getState().cameraCaiu("A câmera foi desconectada.");
        // A trilha morta continua anexada em cada conexão até alguém a tirar: apagar só o
        // estado deixaria os outros com um vídeo congelado no lugar do avatar.
        void camera.desligar().catch(() => undefined);
        void api.voiceSetSelf({ cameraOn: false }).catch(() => undefined);
      },
    },
  );

  useVoiceStore.getState().configurarCamera({
    ligar: async () => {
      const cameraId = useSettingsStore.getState().cameraId;
      try {
        await camera.ligar(cameraId);
      } catch (e) {
        // Nunca lança para o store: uma câmera negada é desfecho previsto, e o que sobe é
        // o motivo em português (§20.1).
        console.log("[camera] não ligou:", e);
        return { erro: motivoDoErroDeCamera(e) };
      }
      guardarCameraLocal(camera.stream);
      return { erro: null };
    },
    desligar: async () => {
      guardarCameraLocal(null);
      await camera.desligar();
    },
  });

  // O fim da chamada, por qualquer caminho: `aoSair` da malha passa por `pararTudo`, e a
  // câmera é dispositivo desta máquina — ninguém a apaga por ela.
  aoPararTudo.push(() => void camera.desligar().catch(() => undefined));
}

/**
 * §17.5 — o pedido de `getDisplayMedia`, e onde o "áudio só da janela escolhida" é dito.
 *
 * O main concede a captura de áudio; **de onde ela pode vir é dito aqui**, pelas opções que
 * o Screen Capture declara para isso:
 *
 * - `windowAudio: "window"` — o som do aplicativo capturado, e não o da máquina;
 * - `systemAudio: "exclude"` — e, explicitamente, **não** o da máquina. É esta a linha que
 *   impede a transmissão de virar "tudo o que toca aqui" quando a plataforma não sabe
 *   separar por janela: sem som a separar, a captura sobe muda, que é o desfecho honesto.
 *
 * Compartilhando a tela inteira não há janela a isolar, e a única leitura coerente de
 * "áudio" é o som do sistema — é o que se pede ali.
 *
 * As duas opções são do padrão e ainda não estão no `lib.dom` do TypeScript desta versão;
 * daí o `as`. Uma plataforma que não as conheça as ignora, e o `systemAudio` continua
 * valendo como o pedido mais forte que se pode fazer.
 */
function opcoesDeCaptura(kind: "screen" | "window", audio: boolean): DisplayMediaStreamOptions {
  if (!audio) return { video: true, audio: false };
  return {
    video: true,
    audio: true,
    ...(kind === "window"
      ? { windowAudio: "window", systemAudio: "exclude" }
      : { windowAudio: "exclude", systemAudio: "include" }),
  } as DisplayMediaStreamOptions;
}

/**
 * §17.5 — a estrela de tela ligada ao store, no mesmo padrão da voz (§76.1).
 *
 * `EstrelaDeTela` fala captura e trilhas e **não conhece o store**; o `voiceStore` guarda o
 * estado que o tile lê e **não conhece `RTCPeerConnection`**; a malha de voz empresta as
 * conexões que já existem com cada par. Este é o único lugar onde os três se encontram.
 */
function configurarTela(malha: MalhaDeVoz): void {
  const estrela = new EstrelaDeTela(
    {
      start: (a) => api.shareStart(a).then((r) => ({ sessionId: r.sessionId })),
      stop: (a) => api.shareStop(a),
      join: (a) => api.shareJoin(a),
      setQuality: (a) => api.shareSetQuality(a),
      report: (a) => api.shareReport(a),
    },
    {
      pares: () => malha.pares(),
      enviarTrilha: (par, track, stream) => malha.enviarTrilha(par, track, stream),
    },
    {
      declararSessao: async (a) => {
        // §17.5/`T-41` — o main precisa saber a qual sessão a próxima captura se refere,
        // para perguntar ao núcleo antes de conceder. Fora do Electron não há main: o
        // navegador decide sozinho, e a ordem continua sendo garantida pelo `share.start`.
        await window.electron?.declareCaptureSession?.(a);
      },
      capturar: ({ kind, audio }) =>
        navigator.mediaDevices.getDisplayMedia(opcoesDeCaptura(kind, audio)),
    },
    {
      aoFalhar: (motivo) => useVoiceStore.getState().telaFalhou(motivo),
      aoEncerrarNaFonte: () => useVoiceStore.getState().stopShare(),
      aoMedir: (amostras) => useVoiceStore.getState().telaMediuSaude(amostras),
    },
  );

  useVoiceStore.getState().configurarTela({
    apresentar: async (a) => {
      const r = await estrela.apresentar({
        communityId: a.communityId,
        channelId: a.channelId,
        euHex: useIdentityStore.getState().identity?.id ?? a.localId,
        quality: a.quality,
        kind: a.kind,
        sourceId: a.sourceId,
        audio: a.audio,
      });
      guardarTelaDoApresentador(estrela.stream);
      // **Não** se serve a chamada inteira aqui. Espectador é quem passou pelo `share.join`,
      // e quem diz isso é o host, por `share.health`, que é o único evento com as CHAVES da
      // audiência (§15.5, RT-08). Servir `malha.pares()` mandava a tela a quem está na
      // chamada e nunca pediu para assistir — audiência é quem pediu, não quem está lá.
      return {
        sessionId: r.sessionId,
        sourceLabel: estrela.rotuloDaFonte === "" ? "Tela" : estrela.rotuloDaFonte,
        // O que a captura ENTREGOU, não o que foi pedido: sem esta distinção o tile
        // anunciaria som numa transmissão muda.
        comAudio: estrela.comAudio,
      };
    },
    parar: async () => {
      guardarTelaDoApresentador(null);
      await estrela.parar();
    },
    /** "Tentar novamente" de quem assiste: repete o `share.join` e nada mais. */
    assistir: async (sessionId) => {
      try {
        await estrela.assistir(sessionId);
        return { erro: null };
      } catch (e) {
        console.log("[tela] share.join recusado no retry:", e);
        return { erro: motivoDaEntradaNaTela(e) };
      }
    },
    definirQualidade: (sessionId, quality) => estrela.definirQualidade(sessionId, quality),
    definirCaptura: (a) => estrela.definirCaptura(a),
    perfilDeCaptura: () => estrela.perfilDeCaptura(),
  });

  /**
   * §15.5 — os quatro eventos de tela. `share.started` e `share.stopped` chegam a todos os
   * da chamada; `share.health` **só ao apresentador** (RT-08).
   */
  cliente.subscribe("share.started", (d) => {
    const dado = d as { sessionId?: string; presenterKey?: string; channelId?: string };
    console.log("[tela] share.started", dado.sessionId, "por", dado.presenterKey?.slice(0, 8));
    if (typeof dado.sessionId !== "string" || typeof dado.presenterKey !== "string") return;
    if (typeof dado.channelId !== "string") return;
    useVoiceStore.getState().telaComecou({
      sessionId: dado.sessionId,
      presenterKey: dado.presenterKey,
      channelId: dado.channelId,
    });
    // Espectador: pedir entrada ao host. É ele que emite o ticket da sessão de tela e que
    // confere que quem pede está na chamada (§17.5, F-18).
    const eu = useIdentityStore.getState().identity?.id?.toLowerCase();
    if (eu !== undefined && eu === dado.presenterKey.toLowerCase()) return;
    const sessionId = dado.sessionId;
    void estrela
      .assistir(sessionId)
      .catch((e: unknown) => {
        console.log("[tela] share.join recusado:", (e as { code?: string })?.code ?? e);
        // A falha é da transmissão DAQUELE par, não da minha: sem o id, o motivo era
        // procurado na minha transmissão — que não existe — e sumia (§94.3).
        useVoiceStore.getState().telaFalhou(motivoDaEntradaNaTela(e), sessionId);
      });
  });

  /**
   * §15.5/§17.5 — a revogação de UM espectador, que `share.stopped` (sessão inteira) e
   * `share.viewersChanged` (só a contagem) não conseguiam dizer.
   */
  cliente.subscribe("share.failed", (d) => {
    const dado = d as { sessionId?: string; reason?: string };
    console.log("[tela] share.failed", dado.sessionId, dado.reason);
    useVoiceStore
      .getState()
      .telaFalhou(
        dado.reason === "revoked"
          ? "Você não pode mais assistir a esta transmissão."
          : "A transmissão de tela foi encerrada.",
        dado.sessionId,
      );
  });

  cliente.subscribe("share.stopped", (d) => {
    const dado = d as { sessionId?: string; presenterKey?: string };
    console.log("[tela] share.stopped", dado.sessionId);
    if (typeof dado.sessionId !== "string") return;
    if (typeof dado.presenterKey === "string") esquecerTelaRecebida(dado.presenterKey);
    useVoiceStore.getState().telaParou(dado.sessionId);
  });

  cliente.subscribe("share.viewersChanged", (d) => {
    const dado = d as { sessionId?: string; viewerCount?: number };
    console.log("[tela] espectadores agora:", dado.viewerCount);
    if (typeof dado.sessionId !== "string") return;
    // §15.5 manda a CONTAGEM, não a lista: quem assiste só precisa do número, e quem
    // apresenta descobre QUEM são pelos pares que a malha serve — nunca por id inventado.

    useVoiceStore.getState().telaMudouEspectadores({
      sessionId: dado.sessionId,
      viewerCount: typeof dado.viewerCount === "number" ? dado.viewerCount : 0,
    });
    // Quem abre e fecha envio é o `share.health`, que carrega as chaves; o host dispara um
    // tick junto deste evento, então a audiência nova chega no mesmo fôlego.
  });

  /**
   * `share.health` é o **único** evento que nomeia a audiência (§15.5: `viewers[{key, …}]`,
   * só ao apresentador). Por isso ele faz duas coisas: diz A QUEM servir e com QUE perfil.
   */
  cliente.subscribe("share.health", (d) => {
    const dado = d as {
      sessionId?: string;
      viewers?: Array<{ key: string; rttMs?: number; lossPct?: number; quality: "high" | "balanced" | "low" }>;
    };
    if (!Array.isArray(dado.viewers)) return;
    const viewers = dado.viewers;
    console.log("[tela] share.health", viewers.map((v) => `${v.key.slice(0, 8)}:${v.quality}`));
    useVoiceStore.getState().telaMediuSaude(viewers);
    // A audiência autorizada pelo host, e só ela: abre o envio de quem entrou, encerra o de
    // quem saiu.
    void estrela
      .atualizarEspectadores(viewers.map((v) => v.key))
      .then(() => estrela.aplicarSaude(viewers));
  });
}

/**
 * O áudio dos outros. Um `<audio>` por par, fora da árvore do React: o elemento precisa
 * sobreviver a re-render, e um par que troca de tile não pode perder o som por causa disso.
 */
const audios = new Map<string, HTMLAudioElement>();

function tocar(peerHex: string, stream: MediaStream): void {
  let el = audios.get(peerHex);
  if (el === undefined) {
    el = new Audio();
    el.autoplay = true;
    audios.set(peerHex, el);
  }
  el.srcObject = stream;
  // Um par que chega DEPOIS de eu ter ensurdecido ou baixado o volume dele precisa nascer
  // já no estado corrente; sem isto, o áudio novo entrava sempre alto.
  aplicarSaidaDeAudio(peerHex, el);
  void el.play().catch(() => undefined);
}

/**
 * §9 (2.3) — ensurdecer, o volume por participante e a SAÍDA de áudio (B47), aplicados ao
 * `<audio>` daquele par.
 *
 * O ensurdecer e o volume por participante já eram enforcement local (o áudio é meu, quem
 * decide se toco sou eu), diferente de silenciar outro participante, que §17.4 L-12 declara
 * como conselho.
 *
 * O `setSinkId` e o `outputVolume` são o B47: a escolha de SAÍDA e o volume geral da tela de
 * ajustes eram persistidos e ignorados — os `<audio>` da voz nasciam sempre no dispositivo
 * padrão, no volume do sistema.
 */
function aplicarSaidaDeAudio(peerHex: string, el: HTMLAudioElement): void {
  const ajustes = useSettingsStore.getState();
  const saida = ajustes.outputId || "default";
  // `setSinkId` com o id já aplicado é recusado por alguns Chromiums; só troca quando muda
  // — o rótulo do que já está aplicado fica no próprio elemento.
  if ((el.dataset.sinkId ?? "default") !== saida) {
    el.dataset.sinkId = saida;
    void el
      .setSinkId(saida === "default" ? "" : saida)
      .catch((e) => console.log("[voz] saída de áudio não aplicada:", (e as Error).message));
  }
  const chamada = useVoiceStore.getState();
  const eu = chamada.participants.find((p) => p.identityId === chamada.localId);
  const surdo = eu?.deafened ?? false;
  // Volume do par × volume GERAL de saída: o slider de §9 (2.3) continua mandando por par.
  const volume = (chamada.volumeById[peerHex] ?? 100) * (ajustes.outputVolume / 100);
  el.muted = surdo;
  el.volume = Math.max(0, Math.min(100, volume)) / 100;
}

/** Reaplica a saída a todos os pares — usado quando a decisão é da chamada inteira. */
function aplicarSaidaDeAudioATodos(): void {
  for (const [peerHex, el] of audios) aplicarSaidaDeAudio(peerHex, el);
}

/**
 * O que precisa acontecer quando a chamada acaba, registrado por quem tem o objeto vivo.
 *
 * Existe porque `pararTudo` é chamado pela malha (`aoSair`) e não conhece nem a estrela nem
 * a câmera — e a câmera, sendo dispositivo desta máquina, não se apaga sozinha quando a
 * malha cai.
 */
const aoPararTudo: Array<() => void> = [];

function pararTudo(): void {
  for (const el of audios.values()) {
    el.pause();
    el.srcObject = null;
  }
  audios.clear();
  // Nenhuma tela sobrevive à chamada: §17.5 põe a sessão de tela DENTRO dela (A19).
  esquecerTodasAsTelas();
  // Nem câmera: §17.2 põe a malha dentro da chamada pela mesma razão.
  esquecerTodasAsCameras();
  for (const f of aoPararTudo) f();
}

export async function iniciarSincronizacao(): Promise<void> {
  // React 18 em desenvolvimento monta cada componente DUAS VEZES (StrictMode), e o efeito
  // de `Sincronizador` roda duas vezes. Sem esta guarda, toda assinatura de §15.5 existia
  // em dois exemplares: `voice.signal` processado duas vezes (a segunda batendo em estado
  // errado), dois relógios de VAD, o primeiro nunca desligado. O flag é síncrono de
  // propósito — a segunda chamada chega enquanto a primeira ainda está no meio dos `await`.
  if (sincronizacaoLigada) return;
  sincronizacaoLigada = true;
  await useSessao.getState().iniciar();
  const estado = useSessao.getState().estado;
  if (estado === "sem-shell" || estado === "falhou") return;
  configurarEscritaDeMensagem();
  configurarEscritaDePreferencias();
  configurarVoz();
  assinarSincronizacao();
  // §31.16.2 — os doze eventos da conversa direta entram na mesma sessão IPC-R, e as
  // assinaturas precisam existir antes da primeira consulta: um `dm.requested` que chegue
  // na janela entre a query e a assinatura ficaria invisível até o próximo evento.
  assinarDm();
  // §31.15 — os dois eventos de mídia da conversa direta. Eles são **ordem**, não sinal para
  // reconsultar: não existe query que reconstrua uma negociação WebRTC, e um `dm.callState`
  // perdido entre a query e a assinatura seria uma chamada que nunca tocou.
  assinarDmVoz();
  await sincronizarIdentidade();
  await sincronizarComunidades();
  void sincronizarPreferencias();
  void sincronizarConversas();
  void sincronizarPrefsDm();
  const cid = useCommunityStore.getState().activeCommunityId;
  if (cid !== null) await abrirComunidade(cid);
}

let sincronizacaoLigada = false;
