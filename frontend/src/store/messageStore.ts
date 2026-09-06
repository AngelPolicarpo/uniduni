import { useMemo } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { Attachment, AttachmentKind, Message, Reaction, Thread } from "../domain/types";
import { useIdentityStore } from "./identityStore";
import { useToastStore } from "./toastStore";

/** Número do fio (§7.4.1) → token do domínio; a ordem É a de §13.6. */
const KINDS_DE_FIO: Record<number, AttachmentKind> = {
  0: "image",
  1: "video",
  2: "audio",
  3: "document",
  4: "other",
  5: "other",
};

/**
 * O anexo da PRÓPRIA bolha: nasce local (staging deste membro, §13.2) e já
 * disponibilizado como seed — progresso 100 é a verdade, não otimismo.
 */
function anexoDaBolha(attachment: { nome: string; tamanho: number; kind: number; hash: string }): Attachment {
  return {
    id: attachment.hash.slice(0, 32),
    name: attachment.nome,
    sizeBytes: attachment.tamanho,
    kind: KINDS_DE_FIO[attachment.kind] ?? "other",
    downloadProgress: 100,
    availablePeers: 0,
    hostAvailable: false,
  };
}

/**
 * Mensagens da sessão (§9, 2.1 · fluxos C9 e B4) sobre a fonte real.
 *
 * A base (`remoteMessages`/`remoteThreads`) vem do núcleo por `query.messages`/
 * `query.thread`. O que nasce aqui é só a **bolha otimista** do envio: ela existe
 * enquanto a op ainda não foi observada na réplica. O transporte NÃO mora nesta
 * store — quem o injeta é o sincronizador (`configurarEscrita`), porque este
 * módulo não pode conhecer IPC-R; sem canal configurado, enviar falha calado na
 * bolha em vez de fingir confirmação.
 *
 * A durabilidade é da outbox do núcleo (`manifest.db`, §11.2) — não desta store.
 * Por isso nada aqui sobrevive a um reload: ao reabrir, a fila é redesenhada a
 * partir de `query.outbox` (`aplicarFila`), cujo preview existe exatamente para
 * isso (F-16). Persistir bolha no localStorage seria um segundo dono de promessa
 * de entrega, e promessa duplicada é mentira.
 */

/** Id da bolha = `clientRef` que viaja na op e volta em todo desfecho de §15.5. */
function clientRef(): string {
  const buffer = new Uint8Array(8);
  crypto.getRandomValues(buffer);
  return `b-${Array.from(buffer, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * O canal de escrita injetado pelo sincronizador. Cada método devolve o `opId`
 * da op enfileirada (§15.4 responde `{opId, state}`), ou `{ cancelado: true }`
 * quando o gesto do usuário abortou antes do quadro — cancelar não é falha.
 * Quem resolve `communityId` a partir do canal é o sincronizador; a store não
 * conhece o mapeamento nem o transporte.
 */
export interface CanalDeEscrita {
  enviar(entrada: {
    communityId: string;
    channelId: string;
    content: string;
    mentions: string[];
    replyToId?: string;
    threadId?: string;
    /** §13.7 — o fio recebe o ticketId e NADA mais do anexo. */
    attachment?: { ticketId: string };
    /** Id da bolha otimista; é o `clientRef` de §11.2/F-44. */
    clientRef: string;
  }): Promise<{ opId: string; cancelado?: boolean }>;
  /** §15.1 r. 7 / §11.3 — reenvia o MESMO envelope, mesmo `opId`. */
  reenviar(opId: string): Promise<void>;
  editar(entrada: { channelId: string; messageId: string; content: string; clientRef: string }): Promise<{ opId: string }>;
  apagar(entrada: { channelId: string; messageId: string; clientRef: string }): Promise<{ opId: string }>;
  fixar(entrada: { channelId: string; messageId: string; pinned: boolean; clientRef: string }): Promise<{ opId: string }>;
  reagir(entrada: { channelId: string; messageId: string; emoji: string; present: boolean; clientRef: string }): Promise<{ opId: string }>;
  abrirThread(entrada: { channelId: string; rootMessageId: string; clientRef: string }): Promise<{ opId: string }>;
  /** Hidratação de reações (`query.message` → `MessageFull.reactions`, §15.6.1). */
  observarReacoes(channelId: string, messageId: string): void;
  /** §15.6 `query.reactors` (DR-47) — QUEM reagiu; o fio da lista só diz quantos. */
  observarReatores(channelId: string, messageId: string, emoji: string): void;
  /** Hidratação de thread (`query.thread` → respostas além da janela do canal, §15.6). */
  observarThread(communityId: string, threadId: string): void;
  /** §9, 2.2 / §6.15 — abrir o painel É ler: o núcleo zera o contador da thread. */
  marcarThreadLida(communityId: string, threadId: string): void;
}

export interface SendMessageInput {
  communityId: string;
  channelId: string;
  content: string;
  /** Ids de membros/cargos mencionados; `@everyone` usa o id `everyone` — formato do fio. */
  mentions: string[];
  replyToId?: string;
  /** Resposta dentro de uma thread (§9, 2.2). */
  threadId?: string;
  /**
   * Anexo já STAGED (§13.2/§13.7): ao fio vai só o `ticketId`; o resto descreve a
   * bolha otimista — quem descreve o blob para o log é o núcleo, a partir do que
   * ele mesmo escreveu.
   */
  attachment?: { ticketId: string; nome: string; tamanho: number; kind: number; hash: string };
}

const NENHUMA: Message[] = [];

/** Prefixo do id provisório de thread, até a projeção trazer o real (§8.x R-24). */
export const THREAD_TEMPORARIA_PREFIXO = "thr-temp-";

/** Chave de `reatoresPorChip`. O `\u0000` não aparece em id nem em emoji. */
export function chaveDoChip(messageId: string, emoji: string): string {
  return `${messageId}\u0000${emoji}`;
}

interface MessageState {
  /** Base vinda do núcleo, por canal (§15.6 `query.messages`). */
  remoteMessages: Record<string, Message[]>;
  /** Threads vindas de `query.thread`, por id. */
  remoteThreads: Record<string, Thread>;
  /**
   * Leitura de §15.6 `query.thread` por thread aberta no painel: as respostas que a
   * página do canal não carrega (janela de 50) mais o total do fio. `null` total é
   * "consulta não concluída", não zero.
   */
  threadLeituras: Record<string, { respostas: Message[]; total: number | null }>;
  /**
   * Não-lidas por thread (§9, 2.2) — o que `query.thread.unread` responde, **por
   * canal**. Só threads com contador acima de zero entram; ausência é lida.
   *
   * A chave por canal não é organização: o mapa era único e a resposta de CADA
   * canal o substituía inteiro. Trocar de canal depressa deixava a resposta lenta
   * do canal anterior chegar por último e apagar os badges do canal na tela —
   * eles só voltavam com a mensagem seguinte.
   */
  naoLidasPorThread: Record<string, Record<string, number>>;
  aplicarNaoLidasDeThreads: (channelId: string, porThread: Record<string, number>) => void;
  aplicarRemoto: (patch: { remoteMessages?: Record<string, Message[]>; remoteThreads?: Record<string, Thread> }) => void;
  /** Bolhas otimistas desta sessão, por canal. Sai delas só por desfecho. */
  sentByChannel: Record<string, Message[]>;
  /**
   * Bolhas derivadas de `query.outbox` ao reabrir (F-16), por canal. A origem
   * manda: cada sincronização SUBSTITUI o conjunto inteiro — o item que saiu da
   * fila some daqui, porque ou virou mensagem projetada ou saiu com motivo.
   */
  filaPorCanal: Record<string, Message[]>;
  /** Mudanças de sessão sobre qualquer mensagem, por id. */
  overrides: Record<string, Partial<Message>>;
  deletedIds: string[];
  /** Threads abertas nesta sessão; as que vieram do log estão em `remoteThreads`. */
  createdThreads: Record<string, Thread>;
  /** Quem está digitando agora, por canal (§9, 2.1). */
  typingByChannel: Record<string, string[]>;
  /** Correlação da bolha com a op: `clientRef → opId` (§11.2 `client_ref`). */
  opIdPorRef: Record<string, string>;
  /** Desfecho feliz: `clientRef → messageId` observado na réplica (§11.6 passo 8). */
  aceitasRefs: Record<string, string>;
  /** Última recusa/descarte por bolha — o código nomeado de §20, para a linha mostrar. */
  errosPorRef: Record<string, string>;
  /**
   * Reações projetadas que `MessageDto` não carrega — vêm de `query.message`
   * por demanda (§15.6.1) e servem de base ao toggle otimista.
   */
  remoteReactions: Record<string, Reaction[]>;
  /** Anexo de §15.6.1 hidratado por `query.message`, por mensagem — o fio traz no máximo um. */
  anexosRemotos: Record<string, Attachment>;
  /**
   * Quem reagiu, por `messageId\u0000emoji` (§15.6 `query.reactors`).
   *
   * `Reaction.userIds` NÃO responde isso: o fio de §15.6.1 traz só
   * `{emoji, count, mine}`, e o adaptador põe ali no máximo a própria chave. O
   * tooltip que lia essa lista dizia " reagiu com 👍" — nome vazio — para toda
   * reação de outra pessoa.
   */
  reatoresPorChip: Record<string, { total: number; identityIds: string[] }>;
  /**
   * Como desfazer cada escrita de mensagem ainda não aceita, com o rótulo da
   * ação para o aviso. Entra no desfecho de falha e sai no de aceite — uma
   * recusa nunca fica aplicada em silêncio (lição de §58.11/§59).
   */
  undoPorRef: Record<string, { acao: string; desfazer: () => void }>;
  /**
   * Que mensagem — e que campos dela — cada escrita EM VOO sobre registro real
   * está sobrescrevendo otimisticamente. É o que dá fim ao override: aceito na
   * réplica (§11.6 passo 8), o campo volta a ser o da projeção. Sem isto o
   * override era eterno, e uma edição minha mascarava para sempre a edição — ou
   * o tombstone de moderação — que outra pessoa fizesse depois.
   */
  alvoPorRef: Record<string, { messageId: string; channelId: string; campos: ReadonlyArray<keyof Message> }>;
  /**
   * O pedido de envio que originou cada bolha, enquanto ela não tiver `opId`.
   *
   * Sem núcleo — ou com o comando falhando antes da resposta — a op nunca chegou
   * à outbox: não existe envelope para `message.retry` reenviar (§11.3), e o
   * botão "Tentar novamente" da linha ficava clicando no vazio. Guardar o pedido
   * é o que dá a esse botão o único significado possível ali: enviar de novo.
   */
  envioPorRef: Record<string, SendMessageInput>;

  /** O transporte corrente; `null` é "sem núcleo". Injetado pelo sincronizador. */
  escrita: CanalDeEscrita | null;

  /** Injeção do transporte; `null` devolve ao estado sem núcleo. Idempotente. */
  configurarEscrita(canal: CanalDeEscrita | null): void;
  send: (input: SendMessageInput) => Promise<void>;
  /** Abre thread numa mensagem que ainda não tem — devolve o id (temporário até a projeção). */
  createThread: (rootMessage: Message) => string;
  retrySend: (ref: string) => void;
  toggleReaction: (message: Message, emoji: string, userId: string) => void;
  setPinned: (message: Message, pinned: boolean) => void;
  editMessage: (message: Message, content: string) => void;
  deleteMessage: (message: Message) => void;
  setTyping: (channelId: string, identityIds: string[]) => void;

  /* ─── Leitura sob demanda e reconciliação fina — chamadas por telas/sincronizador ─── */

  /** Pede ao sincronizador as reações projetadas de uma mensagem (`query.message`). */
  hidratarReacoes: (channelId: string, messageId: string) => void;
  /** Mescla reações vindas de `query.message` na base sob o override otimista. */
  aplicarReacoesRemotas: (messageId: string, reactions: Reaction[]) => void;
  /** Guarda o anexo que `query.message` trouxe para uma mensagem (§15.6.1). */
  aplicarAnexoRemoto: (messageId: string, anexo: Attachment) => void;
  /** Pede ao sincronizador quem reagiu com um emoji (`query.reactors`). */
  hidratarReatores: (channelId: string, messageId: string, emoji: string) => void;
  /** Guarda o que `query.reactors` respondeu para um chip. */
  aplicarReatores: (messageId: string, emoji: string, reatores: { total: number; identityIds: string[] }) => void;
  /** Pede ao sincronizador a thread projetada (`query.thread`) — painel aberto. */
  hidratarThread: (communityId: string, threadId: string) => void;
  /** Guarda o que `query.thread` respondeu, para a vista mesclar com a página do canal. */
  aplicarThreadRemota: (threadId: string, leitura: { respostas: Message[]; total: number }) => void;
  /** A raiz projetou o `threadId` real: substitui o temporário da criação otimista. */
  assentarThreadReal: (rootMessageId: string, threadIdReal: string) => void;

  /* ─── Desfechos de §15.5 e fila de §15.6 — chamados pelo sincronizador ─── */

  /** `message.accepted` — casa pelo `clientRef` e assenta na posição de `seq`. */
  assentarAceita: (ref: string, messageId: string) => void;
  /** `message.failed`/`message.dropped` — a bolha fica visível COM o motivo. */
  marcarFalha: (ref: string, motivo: string) => void;
  /** Redesenho da fila a partir de `query.outbox`; substitui o conjunto anterior. */
  aplicarFila: (
    bolhas: Array<{ ref: string; opId: string; channelId: string; content: string; timestamp: string; deliveryState: Message["deliveryState"] }>,
  ) => void;
  /**
   * O desfecho que o evento não entregou, lido da fila (§11.6, emenda de 2026-09-06).
   *
   * `message.accepted`/`failed`/`dropped` são a via rápida, e ela tem buraco: um `evStale`
   * (§15.1 r. 4) ou um reinício do núcleo no instante errado descartam o quadro, e nada
   * mais casava a bolha com a linha real — ela ficava viva ao lado da mensagem já
   * projetada, duplicada na tela para sempre, ou presa em "enviando" contra uma op morta.
   *
   * `query.outbox` fecha isso sem heurística: a op **saiu** da fila sem descarte ⇒ foi
   * observada na réplica (é o único caminho de remoção de §11.6) ⇒ aceite. A op está lá
   * como `dropped` ⇒ descarte, com o motivo nomeado de §11.7.
   */
  reconciliarPelaFila: (a: {
    /** Refs presentes na resposta, em qualquer estado que não `dropped`. */
    vivas: ReadonlySet<string>;
    /** `dropped`/`failed` terminal, com o motivo a mostrar. */
    desfeitas: ReadonlyArray<{ ref: string; motivo: string }>;
    /** Canais da comunidade consultada — o recorte do que esta resposta pode julgar. */
    canais: ReadonlySet<string>;
  }) => void;
  /**
   * Bolhas de canais que deixaram de existir na réplica local (§18) — devolve
   * quantas caíram, para quem chamou poder avisar em vez de sumir calado.
   */
  descartarCanal: (channelIds: string[]) => number;
  reset: () => void;
}

/**
 * Registra o alvo de uma escrita otimista sobre mensagem real, para o desfecho
 * saber quais campos aposentar. Anda SEMPRE junto de `withOverride` sobre um
 * `message.id` — override sem alvo é override que ninguém recolhe.
 */
function comAlvo(
  state: MessageState,
  ref: string,
  message: Message,
  campos: ReadonlyArray<keyof Message>,
): Pick<MessageState, "alvoPorRef"> {
  return {
    alvoPorRef: {
      ...state.alvoPorRef,
      [ref]: { messageId: message.id, channelId: message.channelId, campos },
    },
  };
}

/** Tira do mapa de alvos o `ref` cujo desfecho já chegou. */
function semAlvo(alvoPorRef: MessageState["alvoPorRef"], ref: string): MessageState["alvoPorRef"] {
  const resto = { ...alvoPorRef };
  delete resto[ref];
  return resto;
}

/** Remove campos de um override; a chave inteira sai quando não sobra nada. */
function semCampos(
  overrides: Record<string, Partial<Message>>,
  messageId: string,
  campos: ReadonlyArray<keyof Message>,
): Record<string, Partial<Message>> {
  const atual = overrides[messageId];
  if (atual === undefined) return overrides;
  const resto: Partial<Message> = { ...atual };
  for (const campo of campos) delete resto[campo];
  const proximo = { ...overrides };
  if (Object.keys(resto).length === 0) delete proximo[messageId];
  else proximo[messageId] = resto;
  return proximo;
}

/** Estado de entrega efetivo: o override manda sobre o da mensagem. */
function deliveryOf(state: MessageState, message: Message) {
  return state.overrides[message.id]?.deliveryState ?? message.deliveryState;
}

function withOverride(
  state: MessageState,
  id: string,
  patch: Partial<Message>,
): Pick<MessageState, "overrides"> {
  return {
    overrides: {
      ...state.overrides,
      [id]: { ...state.overrides[id], ...patch },
    },
  };
}

/**
 * Reação de um usuário entra ou sai; chip zerado some junto (§18).
 *
 * O contador anda de UM, e não vira `userIds.length`: §15.6.1 manda no fio só
 * `{emoji, count, mine}`, então `userIds` nunca tem quem mais reagiu — derivar o
 * contador dessa lista colapsaria as cinco reações de terceiros para a minha.
 */
function toggled(
  reactions: Reaction[],
  emoji: string,
  userId: string,
): Reaction[] {
  const current = reactions.find((reaction) => reaction.emoji === emoji);
  if (!current) {
    return [...reactions, { emoji, count: 1, userIds: [userId] }];
  }
  const mine = current.userIds.includes(userId);
  const userIds = mine
    ? current.userIds.filter((id) => id !== userId)
    : [...current.userIds, userId];

  return reactions
    .map((reaction) =>
      reaction.emoji === emoji
        ? { ...reaction, userIds, count: reaction.count + (mine ? -1 : 1) }
        : reaction,
    )
    .filter((reaction) => reaction.count > 0);
}

export const useMessageStore = create<MessageState>()((set, get) => {
  /**
   * Despacha uma escrita de mensagem pelo canal injetado. Falha de transporte
   * ou recusa futura do fold caem em `marcarFalha`, que é quem desfaz o
   * otimismo e avisa — o padrão é sempre o mesmo desfecho por evento (§11.1).
   */
  function despachar(ref: string, chamada: (canal: CanalDeEscrita) => Promise<{ opId: string }>): void {
    const canal = get().escrita;
    if (canal === null) {
      get().marcarFalha(ref, "O núcleo não está acessível");
      return;
    }
    chamada(canal)
      .then((r) => set((s) => ({ opIdPorRef: { ...s.opIdPorRef, [ref]: r.opId } })))
      .catch((e: unknown) => get().marcarFalha(ref, e instanceof Error ? e.message : String(e)));
  }

  /**
   * O despacho do envio, separado para o "Tentar novamente" de uma bolha SEM
   * `opId` poder repeti-lo. Cancelamento apaga a bolha; falha a deixa visível
   * com o motivo, que é o desfecho de §11.1.
   */
  async function enviarPeloRef(ref: string, entrada: SendMessageInput): Promise<void> {
    const canal = get().escrita;
    if (canal === null) {
      set((state) => ({
        ...withOverride(state, ref, { deliveryState: "failed" }),
        errosPorRef: { ...state.errosPorRef, [ref]: "O núcleo não está acessível" },
      }));
      return;
    }
    try {
      const r = await canal.enviar({
        communityId: entrada.communityId,
        channelId: entrada.channelId,
        content: entrada.content,
        mentions: entrada.mentions,
        ...(entrada.replyToId !== undefined ? { replyToId: entrada.replyToId } : {}),
        ...(entrada.threadId !== undefined ? { threadId: entrada.threadId } : {}),
        ...(entrada.attachment !== undefined ? { attachment: { ticketId: entrada.attachment.ticketId } } : {}),
        clientRef: ref,
      });
      if (r.cancelado === true) {
        // O gesto abortou antes do quadro: a bolha nunca deveria ter existido.
        set((state) => {
          const envioPorRef = { ...state.envioPorRef };
          delete envioPorRef[ref];
          return {
            sentByChannel: {
              ...state.sentByChannel,
              [entrada.channelId]: (state.sentByChannel[entrada.channelId] ?? []).filter((m) => m.id !== ref),
            },
            envioPorRef,
          };
        });
        return;
      }
      // Com envelope na fila, o retry passa a ser o de §11.3 (o MESMO envelope).
      set((state) => {
        const envioPorRef = { ...state.envioPorRef };
        delete envioPorRef[ref];
        return { opIdPorRef: { ...state.opIdPorRef, [ref]: r.opId }, envioPorRef };
      });
    } catch (e) {
      set((state) => ({
        ...withOverride(state, ref, { deliveryState: "failed" }),
        errosPorRef: { ...state.errosPorRef, [ref]: e instanceof Error ? e.message : String(e) },
      }));
    }
  }

  return {
  remoteMessages: {},
  remoteThreads: {},
  aplicarRemoto: (patch) => set(patch),
  threadLeituras: {},
  naoLidasPorThread: {},
  aplicarNaoLidasDeThreads(channelId, porThread) {
    set((state) => ({ naoLidasPorThread: { ...state.naoLidasPorThread, [channelId]: porThread } }));
  },
  sentByChannel: {},
  filaPorCanal: {},
  overrides: {},
  deletedIds: [],
  createdThreads: {},
  typingByChannel: {},
  opIdPorRef: {},
  aceitasRefs: {},
  errosPorRef: {},
  remoteReactions: {},
  anexosRemotos: {},
  reatoresPorChip: {},
  undoPorRef: {},
  alvoPorRef: {},
  envioPorRef: {},

  escrita: null,
  configurarEscrita(canal) {
    set({ escrita: canal });
  },

  async send({ communityId, channelId, content, mentions, replyToId, threadId, attachment }) {
    const ref = clientRef();
    const eu = useIdentityStore.getState().identity;
    const message: Message = {
      id: ref,
      channelId,
      authorId: eu?.id ?? "",
      content,
      timestamp: new Date().toISOString(),
      edited: false,
      pinned: false,
      ...(replyToId !== undefined ? { replyToId } : {}),
      ...(threadId !== undefined ? { threadId } : {}),
      reactions: [],
      attachments: attachment !== undefined ? [anexoDaBolha(attachment)] : [],
      mentions,
      // Verdade provisória: a op ainda nem foi enfileirada. Os estados seguintes
      // vêm da outbox — nunca de um temporizador desta store.
      deliveryState: "sending",
    };

    set((state) => ({
      sentByChannel: {
        ...state.sentByChannel,
        [channelId]: [...(state.sentByChannel[channelId] ?? []), message],
      },
      // Enquanto não houver `opId`, este pedido é a única forma de tentar de novo.
      envioPorRef: {
        ...state.envioPorRef,
        [ref]: { communityId, channelId, content, mentions, ...(replyToId !== undefined ? { replyToId } : {}), ...(threadId !== undefined ? { threadId } : {}), ...(attachment !== undefined ? { attachment } : {}) },
      },
    }));

    await enviarPeloRef(ref, { communityId, channelId, content, mentions, ...(replyToId !== undefined ? { replyToId } : {}), ...(threadId !== undefined ? { threadId } : {}), ...(attachment !== undefined ? { attachment } : {}) });
  },

  createThread: (rootMessage) => {
    // R-24 — uma thread por raiz; já existindo (real ou em criação), é ela.
    if (rootMessage.threadId !== undefined && !rootMessage.threadId.startsWith(THREAD_TEMPORARIA_PREFIXO)) {
      return rootMessage.threadId;
    }
    const tempId = `${THREAD_TEMPORARIA_PREFIXO}${crypto.randomUUID().slice(0, 8)}`;
    const ref = clientRef();
    set((state) => ({
      createdThreads: {
        ...state.createdThreads,
        [tempId]: {
          id: tempId,
          rootMessageId: rootMessage.id,
          channelId: rootMessage.channelId,
          replyIds: [],
          participantIds: [rootMessage.authorId],
          unreadCount: 0,
        },
      },
      overrides: {
        ...state.overrides,
        [rootMessage.id]: { ...state.overrides[rootMessage.id], threadId: tempId },
      },
      ...comAlvo(state, ref, rootMessage, ["threadId"]),
      undoPorRef: {
        ...state.undoPorRef,
        [ref]: {
          acao: "abrir a thread",
          desfazer: () =>
            useMessageStore.setState((s) => {
              const createdThreads = { ...s.createdThreads };
              delete createdThreads[tempId];
              let overrides = s.overrides;
              if (overrides[rootMessage.id]?.threadId === tempId) {
                const resto = { ...overrides[rootMessage.id] };
                delete resto.threadId;
                overrides = { ...overrides, [rootMessage.id]: resto };
              }
              return { createdThreads, overrides };
            }),
        },
      },
    }));
    despachar(ref, (canal) =>
      canal.abrirThread({ channelId: rootMessage.channelId, rootMessageId: rootMessage.id, clientRef: ref }),
    );
    return tempId;
  },

  retrySend: (ref) => {
    const state = get();
    const opId = state.opIdPorRef[ref];
    if (opId === undefined) {
      // Sem `opId` não há envelope para reenviar (§11.3: retry reenvia o MESMO):
      // a op nunca chegou à outbox — núcleo inacessível, ou o comando falhou antes
      // da resposta. Aqui "tentar de novo" só pode significar ENVIAR de novo, e é
      // isso que o botão faz; devolver em silêncio o deixava morto na tela.
      const entrada = state.envioPorRef[ref];
      if (entrada === undefined) return;
      set((s) => ({
        ...withOverride(s, ref, { deliveryState: "sending" }),
        errosPorRef: Object.fromEntries(Object.entries(s.errosPorRef).filter(([id]) => id !== ref)),
      }));
      void enviarPeloRef(ref, entrada);
      return;
    }
    set((s) => ({
      ...withOverride(s, ref, { deliveryState: "sending" }),
      errosPorRef: Object.fromEntries(Object.entries(s.errosPorRef).filter(([id]) => id !== ref)),
    }));
    void get()
      .escrita?.reenviar(opId)
      .catch((e: unknown) => {
        set((s) => ({
          ...withOverride(s, ref, { deliveryState: "failed" }),
          errosPorRef: { ...s.errosPorRef, [ref]: e instanceof Error ? e.message : String(e) },
        }));
      });
  },

  toggleReaction: (message, emoji, userId) => {
    const state = get();
    // Base mesclada: o que `query.message` trouxe por cima da lista vazia de §15.6.1,
    // e por fim o próprio override — reações em voo mandam até serem observadas.
    const base =
      state.overrides[message.id]?.reactions ??
      (message.reactions.length > 0 ? message.reactions : state.remoteReactions[message.id] ?? []);
    const atual = base.find((reaction) => reaction.emoji === emoji);
    const present = !(atual?.userIds.includes(userId) ?? false);
    const overrideAntes = state.overrides[message.id];
    const ref = clientRef();
    set((s) => ({
      ...withOverride(s, message.id, { reactions: toggled(base, emoji, userId) }),
      ...comAlvo(s, ref, message, ["reactions"]),
      undoPorRef: {
        ...s.undoPorRef,
        [ref]: {
          acao: "reagir à mensagem",
          desfazer: () =>
            useMessageStore.setState((s2) => {
              const overrides = { ...s2.overrides };
              if (overrideAntes === undefined) delete overrides[message.id];
              else overrides[message.id] = overrideAntes;
              return { overrides };
            }),
        },
      },
    }));
    despachar(ref, (canal) =>
      canal.reagir({ channelId: message.channelId, messageId: message.id, emoji, present, clientRef: ref }),
    );
  },

  setPinned: (message, pinned) => {
    const overrideAntes = get().overrides[message.id];
    const ref = clientRef();
    set((s) => ({
      ...withOverride(s, message.id, { pinned }),
      ...comAlvo(s, ref, message, ["pinned"]),
      undoPorRef: {
        ...s.undoPorRef,
        [ref]: {
          acao: pinned ? "fixar a mensagem" : "desafixar a mensagem",
          desfazer: () =>
            useMessageStore.setState((s2) => {
              const overrides = { ...s2.overrides };
              if (overrideAntes === undefined) delete overrides[message.id];
              else overrides[message.id] = overrideAntes;
              return { overrides };
            }),
        },
      },
    }));
    despachar(ref, (canal) =>
      canal.fixar({ channelId: message.channelId, messageId: message.id, pinned, clientRef: ref }),
    );
  },

  editMessage: (message, content) => {
    // Rollback EXATO: restaura o override como estava (ou remove a chave se não havia).
    const overrideAntes = get().overrides[message.id];
    const ref = clientRef();
    set((s) => ({
      ...withOverride(s, message.id, { content, edited: true }),
      ...comAlvo(s, ref, message, ["content", "edited"]),
      undoPorRef: {
        ...s.undoPorRef,
        [ref]: {
          acao: "editar a mensagem",
          desfazer: () =>
            useMessageStore.setState((s2) => {
              const overrides = { ...s2.overrides };
              if (overrideAntes === undefined) delete overrides[message.id];
              else overrides[message.id] = overrideAntes;
              return { overrides };
            }),
        },
      },
    }));
    despachar(ref, (canal) =>
      canal.editar({ channelId: message.channelId, messageId: message.id, content, clientRef: ref }),
    );
  },

  deleteMessage: (message) => {
    const ref = clientRef();
    set((s) => ({
      deletedIds: [...s.deletedIds, message.id],
      undoPorRef: {
        ...s.undoPorRef,
        [ref]: {
          acao: "apagar a mensagem",
          desfazer: () =>
            useMessageStore.setState((s2) => ({
              deletedIds: s2.deletedIds.filter((id) => id !== message.id),
            })),
        },
      },
    }));
    despachar(ref, (canal) =>
      canal.apagar({ channelId: message.channelId, messageId: message.id, clientRef: ref }),
    );
  },

  setTyping: (channelId, identityIds) =>
    set((state) => ({
      typingByChannel: { ...state.typingByChannel, [channelId]: identityIds },
    })),

  assentarAceita(ref, messageId) {
    const alvo = get().alvoPorRef[ref];
    set((state) => {
      // Aceite descarta o rollback: observado na réplica, não há o que desfazer.
      const undoPorRef = { ...state.undoPorRef };
      delete undoPorRef[ref];
      const base = {
        aceitasRefs: { ...state.aceitasRefs, [ref]: messageId },
        errosPorRef: Object.fromEntries(Object.entries(state.errosPorRef).filter(([id]) => id !== ref)),
        undoPorRef,
        alvoPorRef: semAlvo(state.alvoPorRef, ref),
      };
      if (alvo === undefined) {
        // `ref` de bolha própria: ela some quando a linha real entra na base, e até
        // lá o override de entrega é o que a mantém "sent" em vez de piscar.
        return { ...base, ...withOverride(state, ref, { deliveryState: "sent" }) };
      }
      // Escrita sobre mensagem real: o otimismo cumpriu o papel dele. Aposenta os
      // campos que ele segurava — daqui em diante manda a projeção, e é ela que
      // carrega a edição, o tombstone ou a fixação de QUALQUER pessoa (§11.6 passo 8).
      //
      // Reação é o caso em que a projeção não responde sozinha: §15.6.1 não põe
      // reação na lista do canal. Por isso o override dela sai só quando a
      // hidratação relida chegar — quem a pede é a linha abaixo.
      const campos = alvo.campos.filter((c) => c !== "reactions");
      return {
        ...base,
        ...(campos.length > 0 ? { overrides: semCampos(state.overrides, alvo.messageId, campos) } : {}),
      };
    });
    if (alvo !== undefined && alvo.campos.includes("reactions")) {
      get().escrita?.observarReacoes(alvo.channelId, alvo.messageId);
    }
  },

  marcarFalha(ref, motivo) {
    const undo = get().undoPorRef[ref];
    set((state) => ({ alvoPorRef: semAlvo(state.alvoPorRef, ref) }));
    if (undo !== undefined) {
      // Escrita sobre mensagem real (editar/apagar/fixar/reagir/thread): a recusa
      // desfaz o otimismo e avisa nomeado — nunca fica aplicada em silêncio.
      undo.desfazer();
      useToastStore.getState().showToast(`Não foi possível ${undo.acao} (${motivo})`, "error");
      set((state) => {
        const undoPorRef = { ...state.undoPorRef };
        delete undoPorRef[ref];
        return { undoPorRef };
      });
      return;
    }
    set((state) => ({
      ...withOverride(state, ref, { deliveryState: "failed" }),
      errosPorRef: { ...state.errosPorRef, [ref]: motivo },
    }));
  },

  hidratarReacoes(channelId, messageId) {
    get().escrita?.observarReacoes(channelId, messageId);
  },

  aplicarReacoesRemotas(messageId, reactions) {
    set((state) => {
      // A leitura é do estado projetado AGORA. Ela só não vence o override quando
      // ainda há reação minha em voo sobre esta mensagem — aí o otimismo é o mais
      // novo dos dois, e recolhê-lo faria o chip piscar de volta ao valor antigo.
      const emVoo = Object.values(state.alvoPorRef).some(
        (alvo) => alvo.messageId === messageId && alvo.campos.includes("reactions"),
      );
      return {
        remoteReactions: { ...state.remoteReactions, [messageId]: reactions },
        ...(emVoo ? {} : { overrides: semCampos(state.overrides, messageId, ["reactions"]) }),
      };
    });
  },

  aplicarAnexoRemoto(messageId, anexo) {
    set((state) => ({ anexosRemotos: { ...state.anexosRemotos, [messageId]: anexo } }));
  },

  hidratarReatores(channelId, messageId, emoji) {
    get().escrita?.observarReatores(channelId, messageId, emoji);
  },

  aplicarReatores(messageId, emoji, reatores) {
    set((state) => ({ reatoresPorChip: { ...state.reatoresPorChip, [chaveDoChip(messageId, emoji)]: reatores } }));
  },

  hidratarThread(communityId, threadId) {
    get().escrita?.observarThread(communityId, threadId);
    // Abrir o painel É o ato de leitura (§6.15): o contador zera no núcleo e a
    // reconsulta que ele dispara tira o badge do chip.
    get().escrita?.marcarThreadLida(communityId, threadId);
  },

  aplicarThreadRemota(threadId, leitura) {
    set((state) => ({ threadLeituras: { ...state.threadLeituras, [threadId]: leitura } }));
  },

  assentarThreadReal(rootMessageId, threadIdReal) {
    set((state) => {
      const temp = Object.values(state.createdThreads).find(
        (t) => t.rootMessageId === rootMessageId && t.id.startsWith(THREAD_TEMPORARIA_PREFIXO),
      );
      if (temp === undefined || temp.id === threadIdReal) return {};
      const createdThreads = { ...state.createdThreads };
      delete createdThreads[temp.id];
      createdThreads[threadIdReal] = { ...temp, id: threadIdReal };
      let overrides = state.overrides;
      if (overrides[rootMessageId]?.threadId === temp.id) {
        overrides = { ...overrides, [rootMessageId]: { ...overrides[rootMessageId], threadId: threadIdReal } };
      }
      return { createdThreads, overrides };
    });
  },

  aplicarFila(bolhas) {
    set((state) => {
      const filaPorCanal: Record<string, Message[]> = {};
      const opIdPorRef = { ...state.opIdPorRef };
      for (const b of bolhas) {
        // Já observada na réplica: a linha real vem por `query.messages`.
        if (state.aceitasRefs[b.ref] !== undefined) continue;
        opIdPorRef[b.ref] = b.opId;
        const lista = filaPorCanal[b.channelId] ?? [];
        filaPorCanal[b.channelId] = [
          ...lista,
          {
            id: b.ref,
            channelId: b.channelId,
            authorId: useIdentityStore.getState().identity?.id ?? "",
            content: b.content,
            // §15.6 `enqueuedAt` — o instante REAL do enfileiramento. A época zero
            // que ficava aqui punha a conversa reaberta sob um separador de 1970.
            timestamp: b.timestamp,
            edited: false,
            pinned: false,
            reactions: [],
            attachments: [],
            mentions: [],
            deliveryState: b.deliveryState,
          },
        ];
      }
      return { filaPorCanal, opIdPorRef };
    });
  },

  reconciliarPelaFila({ vivas, desfeitas, canais }) {
    /** A bolha ou o override que este `ref` ainda segura na tela. */
    const temOtimismo = (ref: string): boolean => {
      const s = get();
      if (s.alvoPorRef[ref] !== undefined) return true;
      for (const channelId of canais) {
        if ((s.sentByChannel[channelId] ?? []).some((m) => m.id === ref)) return true;
      }
      return false;
    };

    for (const { ref, motivo } of desfeitas) {
      const s = get();
      if (s.aceitasRefs[ref] !== undefined) continue;
      if (s.errosPorRef[ref] !== undefined) continue;
      // Só o que ESTA instalação despachou: sem `opId` a op nunca chegou à fila, e o
      // desfecho é de outra bolha.
      if (s.opIdPorRef[ref] === undefined) continue;
      // A linha `dropped` fica em `local_outbox` para sempre (§11.2), e esta reconciliação
      // roda a cada resync: sem esta guarda, um descarte já tratado voltaria a marcar falha
      // sobre um `ref` que não tem mais nada na tela.
      if (!temOtimismo(ref)) continue;
      get().marcarFalha(ref, motivo);
    }

    const s = get();
    const desfeitasRefs = new Set(desfeitas.map((d) => d.ref));
    /** Saiu da fila sem descarte: §11.6 só remove por observação na réplica. */
    const sumiu = (ref: string): boolean =>
      s.opIdPorRef[ref] !== undefined &&
      s.aceitasRefs[ref] === undefined &&
      !vivas.has(ref) &&
      !desfeitasRefs.has(ref);

    // (a) escritas sobre mensagem real (editar/fixar/reagir/apagar/thread): o aceite
    // aposenta o override e o rollback, exatamente como faria `message.accepted`.
    for (const [ref, alvo] of Object.entries(s.alvoPorRef)) {
      if (!canais.has(alvo.channelId) || !sumiu(ref)) continue;
      get().assentarAceita(ref, alvo.messageId);
    }

    // (b) bolhas próprias: a linha real já está (ou estará, pelo `query.messages` do mesmo
    // resync) na base do canal. A bolha some — mantê-la era a duplicata.
    const orfas = new Set<string>();
    for (const channelId of canais) {
      for (const bolha of get().sentByChannel[channelId] ?? []) {
        if (sumiu(bolha.id)) orfas.add(bolha.id);
      }
    }
    if (orfas.size === 0) return;
    set((state) => {
      const sentByChannel: Record<string, Message[]> = { ...state.sentByChannel };
      for (const channelId of canais) {
        const lista = sentByChannel[channelId];
        if (lista === undefined) continue;
        const restante = lista.filter((m) => !orfas.has(m.id));
        if (restante.length === lista.length) continue;
        sentByChannel[channelId] = restante;
      }
      const overrides = { ...state.overrides };
      const envioPorRef = { ...state.envioPorRef };
      const opIdPorRef = { ...state.opIdPorRef };
      for (const ref of orfas) {
        delete overrides[ref];
        delete envioPorRef[ref];
        delete opIdPorRef[ref];
      }
      return {
        sentByChannel,
        overrides,
        envioPorRef,
        opIdPorRef,
        errosPorRef: Object.fromEntries(
          Object.entries(state.errosPorRef).filter(([id]) => !orfas.has(id)),
        ),
      };
    });
  },

  descartarCanal: (channelIds) => {
    if (channelIds.length === 0) return 0;
    const alvos = new Set(channelIds);
    let dropped = 0;
    set((state) => {
      const sentByChannel: Record<string, Message[]> = {};
      const filaPorCanal: Record<string, Message[]> = {};
      for (const [channelId, messages] of Object.entries(state.sentByChannel)) {
        if (alvos.has(channelId)) {
          dropped += messages.length;
          continue;
        }
        sentByChannel[channelId] = messages;
      }
      for (const [channelId, messages] of Object.entries(state.filaPorCanal)) {
        if (alvos.has(channelId)) {
          dropped += messages.length;
          continue;
        }
        filaPorCanal[channelId] = messages;
      }
      return { sentByChannel, filaPorCanal };
    });
    return dropped;
  },

  reset: () =>
    set({
      sentByChannel: {},
      filaPorCanal: {},
      overrides: {},
      deletedIds: [],
      createdThreads: {},
      threadLeituras: {},
      naoLidasPorThread: {},
      typingByChannel: {},
      opIdPorRef: {},
      aceitasRefs: {},
      errosPorRef: {},
      remoteReactions: {},
      anexosRemotos: {},
      reatoresPorChip: {},
      undoPorRef: {},
      alvoPorRef: {},
      envioPorRef: {},
    }),
  };
});

/* ─── Seletores ──────────────────────────────────────────────────── */

/**
 * Histórico do canal: base do núcleo, depois as bolhas derivadas da outbox e as
 * da sessão, com os overrides aplicados e as mensagens deletadas fora.
 *
 * Uma bolha cujo `clientRef` já tem `messageId` observado SOME quando a linha
 * real chega à base — é o assentamento de §11.6 passo 8 (casa pelo `clientRef`,
 * posiciona pela ordem do log). Antes disso ela continua visível como "sent",
 * para a mensagem não piscar entre o evento e a reconsulta.
 *
 * A composição fica num `useMemo` sobre referências estáveis, não dentro do
 * seletor: aplicar override cria objeto novo a cada chamada, e nem
 * `useShallow` salva disso — ele compara elemento a elemento por referência
 * (a mesma armadilha que derrubou o autocomplete de menção).
 */
/** Exportado para o teste exercitar a mescla sem renderizar (hooks exigem React). */
export function compose(
  channelIds: string[],
  sentByChannel: Record<string, Message[]>,
  filaPorCanal: Record<string, Message[]>,
  overrides: Record<string, Partial<Message>>,
  deletedIds: string[],
  remoteMessages: Record<string, Message[]>,
  aceitasRefs: Record<string, string>,
  remoteReactions: Record<string, Reaction[]>,
): Message[] {
  const deleted = new Set(deletedIds);
  const out: Message[] = [];

  for (const channelId of channelIds) {
    const base = remoteMessages[channelId] ?? NENHUMA;
    const presentes = new Set(base.map((m) => m.id));
    // As duas bolhas do MESMO `clientRef` são uma só linha: a da sessão nasceu no
    // envio (com instante, anexo e menções) e a da fila é o redesenho de
    // `query.outbox` sobre o mesmo item. Concatenar sem mesclar duplicava a
    // mensagem na tela — e com a mesma chave de lista — durante todo o tempo em
    // que o item ficasse enfileirado.
    const daFila = new Map((filaPorCanal[channelId] ?? []).map((m) => [m.id, m]));
    const bolhas: Message[] = [];
    for (const bolha of sentByChannel[channelId] ?? []) {
      const fila = daFila.get(bolha.id);
      daFila.delete(bolha.id);
      // A fila é quem sabe o estado de entrega (§11.3); o resto é da bolha viva.
      bolhas.push(fila === undefined ? bolha : { ...bolha, deliveryState: fila.deliveryState });
    }
    for (const restante of daFila.values()) bolhas.push(restante);

    const vivas = bolhas.filter((bolha) => {
      const aceitada = aceitasRefs[bolha.id];
      return aceitada === undefined || !presentes.has(aceitada);
    });
    for (const message of [...base, ...vivas]) {
      if (deleted.has(message.id)) continue;
      const override = overrides[message.id];
      let efetiva = override ? { ...message, ...override } : message;
      // §15.6.1 — a lista não carrega reações; o que `query.message` hidratou é a
      // base. O override só existe enquanto a reação está em voo (`alvoPorRef`), e
      // é por isso que ele pode mandar aqui sem mascarar o que os outros fizeram.
      if (override?.reactions === undefined && remoteReactions[message.id] !== undefined) {
        efetiva = { ...efetiva, reactions: remoteReactions[message.id] };
      }
      out.push(efetiva);
    }
  }
  return out;
}

export function useChannelMessages(channelId: string): Message[] {
  const sentByChannel = useMessageStore((state) => state.sentByChannel);
  const filaPorCanal = useMessageStore((state) => state.filaPorCanal);
  const overrides = useMessageStore((state) => state.overrides);
  const deletedIds = useMessageStore((state) => state.deletedIds);
  const remotas = useMessageStore((state) => state.remoteMessages);
  const aceitasRefs = useMessageStore((state) => state.aceitasRefs);
  const remoteReactions = useMessageStore((state) => state.remoteReactions);

  return useMemo(
    () =>
      compose([channelId], sentByChannel, filaPorCanal, overrides, deletedIds, remotas, aceitasRefs, remoteReactions),
    [channelId, sentByChannel, filaPorCanal, overrides, deletedIds, remotas, aceitasRefs, remoteReactions],
  );
}

/**
 * Thread ancorada numa mensagem (§9, 2.2). As do log vivem em `remoteThreads`;
 * as abertas nesta sessão, em `createdThreads`. Procura nas duas.
 */
export function useThreadForRoot(
  rootMessageId: string | undefined,
): Thread | undefined {
  const created = useMessageStore((state) => state.createdThreads);
  const remotas = useMessageStore((state) => state.remoteThreads);
  return useMemo(() => {
    if (!rootMessageId) return undefined;
    const match = (thread: Thread): boolean => thread.rootMessageId === rootMessageId;
    return Object.values(created).find(match) ?? Object.values(remotas).find(match);
  }, [created, remotas, rootMessageId]);
}

/**
 * Mapa `threadId → rootMessageId`. O indicador "N respostas" só pode
 * aparecer sob a raiz: a resposta também carrega o `threadId`, e sem esta
 * distinção ela anunciaria uma thread que não ancora.
 */
export function useThreadRoots(): Map<string, string> {
  const created = useMessageStore((state) => state.createdThreads);
  const remotas = useMessageStore((state) => state.remoteThreads);
  return useMemo(
    () =>
      new Map(
        [...Object.values(remotas), ...Object.values(created)].map((thread) => [
          thread.id,
          thread.rootMessageId,
        ]),
      ),
    [created, remotas],
  );
}

const SEM_NAO_LIDAS: Record<string, number> = {};

/** §9, 2.2 — as não-lidas das threads DESTE canal; a referência só muda com o fio. */
export function useNaoLidasPorThread(channelId: string): Record<string, number> {
  return useMessageStore((state) => state.naoLidasPorThread[channelId] ?? SEM_NAO_LIDAS);
}

/** Respostas de uma thread, em ordem cronológica, sem a mensagem raiz. */
export function useThreadReplies(
  channelId: string,
  thread: Thread | undefined,
): Message[] {
  const messages = useChannelMessages(channelId);
  return useMemo(
    () =>
      thread
        ? messages.filter(
            (message) =>
              message.threadId === thread.id &&
              message.id !== thread.rootMessageId,
          )
        : [],
    [messages, thread],
  );
}

/** A leitura de `query.thread` de uma thread, quando já veio. */
export function useThreadLeitura(
  threadId: string | undefined,
): { respostas: Message[]; total: number | null } | undefined {
  return useMessageStore((state) =>
    threadId === undefined ? undefined : state.threadLeituras[threadId],
  );
}

/** O anexo hidratado de `query.message` para uma mensagem (§15.6.1 — no máximo um). */
export function useAnexoRemoto(messageId: string): Attachment | undefined {
  return useMessageStore((state) => state.anexosRemotos[messageId]);
}

/**
 * As duas fontes de anexo de uma mensagem — a bolha própria (staging local, §13.2)
 * e a hidratação de `query.message` (§15.6.1, no máximo um anexo por mensagem) —,
 * sem duplicar por id.
 *
 * Mora aqui, e não na linha, porque a linha não é a única superfície do acervo: a
 * aba Arquivos do canal lia só `message.attachments`, que o adaptador zera para
 * TODA mensagem projetada — a aba ficava vazia mesmo com o card do arquivo
 * desenhado logo ali na conversa.
 */
export function anexosDaMensagem(message: Message, remoto: Attachment | undefined): Attachment[] {
  if (remoto === undefined) return message.attachments;
  if (message.attachments.some((a) => a.id === remoto.id)) return message.attachments;
  return [...message.attachments, remoto];
}

/** Quem reagiu com um emoji, se `query.reactors` já respondeu por este chip. */
export function useReatores(
  messageId: string,
  emoji: string,
): { total: number; identityIds: string[] } | undefined {
  return useMessageStore((state) => state.reatoresPorChip[chaveDoChip(messageId, emoji)]);
}

/** O mapa inteiro de anexos hidratados; a referência só muda quando o fio muda. */
export function useAnexosRemotos(): Record<string, Attachment> {
  return useMessageStore((state) => state.anexosRemotos);
}

export function useTypingIn(channelId: string): string[] {
  return useMessageStore(
    useShallow((state) => state.typingByChannel[channelId] ?? []),
  );
}

/**
 * Quantas mensagens deste canal ainda não foram observadas na réplica — a
 * contagem honesta de fila: bolhas da sessão e da outbox em `queued`/`sending`,
 * exceto as já aceitas (§11.3: aceito é quem saiu da fila por observação).
 */
export function contaPendentes(state: MessageState, channelId: string): number {
  const pendentes = (messages: Message[]): number =>
    messages.filter(
      (message) =>
        state.aceitasRefs[message.id] === undefined &&
        (deliveryOf(state, message) === "queued" ||
          deliveryOf(state, message) === "sending"),
    ).length;
  return (
    pendentes(state.sentByChannel[channelId] ?? []) +
    pendentes(state.filaPorCanal[channelId] ?? [])
  );
}

export function useQueuedCount(channelId: string): number {
  return useMessageStore((state) => contaPendentes(state, channelId));
}
