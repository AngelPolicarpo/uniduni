/**
 * Esquemas de resposta de `backend-v2.md` §15.6, transcritos.
 *
 * Regra deste arquivo: **nenhum campo que a tabela não declare**. Onde a tela precisaria de
 * algo que a tabela fechada não tem, o campo fica ausente e a falta vira pendência
 * registrada — precedente de §46–§57. Estes tipos NÃO são os de `src/domain/types.ts`: lá
 * está o modelo das fixtures do mock, com nomes e enums próprios (`HostStatus` de três
 * valores, `position` em vez de `rank`). Mapear um no outro seria inventar correspondência;
 * o produto usa o que o fio entrega.
 */

export type Key = string;
export type Ms = number;
export type Cursor = string;
export type Rank = string;

export interface UserRef {
  key: Key;
  displayName: string;
  handle: string;
  avatarColor: string;
  nickname?: string;
  /** §6.1 L-5 — marcada pelo `fold` desde §57. */
  collision: boolean;
}

export type HostStatus =
  | "unknown"
  | "connecting"
  | "online"
  | "reconnecting"
  | "offline"
  | "ended"
  | "unauthorized"
  | "incompatible"
  | "forked";

export type ReplicationState =
  | "synced"
  | "catching-up"
  | "stalled"
  | "blocked"
  | "unauthorized"
  | "forked";

export type CorePhase =
  | "boot"
  | "awaiting-identity"
  | "opening"
  | "ready"
  | "draining"
  | "stopped";

export interface CoreStatus {
  phase: CorePhase;
  epoch: number;
  coreVersion: string;
  opVersion: number;
  manifestSchemaVersion: number;
  viewSchemaVersion: number;
  keystore: "secure" | "insecure-fallback";
  buildChannel: "prod" | "dev";
}

/** §6.1 — `offline` NUNCA é publicado; ausência é que significa offline. */
export type Presence = "online" | "idle" | "dnd" | "invisible";

export interface IdentityDto {
  key: Key;
  displayName: string;
  handle: string;
  avatarColor: string;
  presence: Presence;
  createdAt: Ms;
}

export interface UnreadDto {
  count: number;
  mentions: number;
}

export interface CommunityListItem {
  id: string;
  name: string;
  iconEmoji?: string;
  iconColor: string;
  memberCount: number;
  isHostedByMe: boolean;
  hostStatus: HostStatus;
  replication: { state: ReplicationState; lag: number };
  unread: UnreadDto;
  notificationLevel: string;
  endedAt?: Ms;
  /**
   * §18.4 passo 5 — por que esta réplica é histórica. Presente = modo somente leitura, e a
   * comunidade continua no rail justamente para poder dizê-lo. `by`/`reason` ficam em
   * `query.selfModeration`, que é onde a auditoria mora.
   */
  removedReason?: "banned" | "kicked" | "unauthorized" | "left";
  /** §18.4 passo 6 — quando a cópia local sai sozinha (`REMOVED_RETENTION_DAYS`). */
  retainUntil?: Ms;
  /** Ausente enquanto não houver contato observado com o host (§22.2 emendado). */
  inactiveDays?: number;
  partialInterpretation: boolean;
}

export interface CommunityDetail extends CommunityListItem {
  myPermissions: string[];
  myRoleIds: string[];
  myTopRank: Rank;
  isHost: boolean;
  hostRef: UserRef;
  successorKeys: Key[];
  /** U-18c — só existe em continuação com a origem replicada aqui (L-23, §18.8.1). */
  pendingReentry?: UserRef[];
}

export interface ChannelDto {
  id: string;
  name: string;
  type: number;
  topic?: string;
  rank: Rank;
  /** §6.7 — JÁ RESOLVIDO para quem perguntou: é a regra do núcleo, não um palpite da tela. */
  readOnly: boolean;
  /**
   * §15.6 (emenda de 2026-09-06) — os cargos silenciados, crus. Existe para a tela de
   * edição do canal reabrir a escolha de quem pode postar; NÃO é a fonte do gate de UI,
   * que é `readOnly`.
   */
  readOnlyForRoleIds: string[];
  muted: boolean;
  unread: UnreadDto;
  firstUnreadSeq?: number;
  voice?: { count: number; first: UserRef[] };
  /** §6.6 (emenda de 2026-08-28) — o core já aplica os defaults de §6.6. */
  speechMode: number;
  queueTurnSeconds: number;
}

export interface CategoryDto {
  id: string;
  name: string;
  rank: Rank;
  collapsed: boolean;
  channels: ChannelDto[];
}

export interface StructureDto {
  categories: CategoryDto[];
}

/** §13.2 — `kind` do anexo é numérico no fio; o rótulo é da UI. */
export type BlobState = string;

/**
 * O que `blob.stage` devolve (§15.4) — que **não** é o `AttachmentDto` das queries.
 *
 * O stage descreve bytes que acabaram de ser escritos no core de blobs local: não há estado
 * de download, nem pares, nem `revealMode` (nada foi revelado). Tipá-lo como `AttachmentDto`
 * era uma mentira antiga que só apareceu quando o DTO ganhou campo obrigatório novo.
 */
export interface StagedAttachmentDto {
  blobsCoreKey: Key;
  blobId: { byteOffset: number; blockOffset: number; blockLength: number; byteLength: number };
  name: string;
  sizeBytes: number;
  kind: number;
  hash: string;
}

export interface AttachmentDto {
  blobsCoreKey: Key;
  blobId: { byteOffset: number; blockOffset: number; blockLength: number; byteLength: number };
  name: string;
  sizeBytes: number;
  kind: number;
  hash: string;
  state: BlobState;
  progress: number;
  /**
   * §15.6.1 emenda de 2026-08-22 — leitura do bitfield VIVO. Fora de um download em curso
   * não há par conectado, e `0`/`false` dizem isso; não há registro persistente de pares.
   */
  availablePeers: number;
  hostAvailable: boolean;
  /**
   * §13.6 regra 1 (emenda de 2026-09-05) — `open` = pode abrir pelo handler do SO e mostrar
   * na pasta; `folder` = só mostrar na pasta; `none` = nem uma coisa nem outra (executável,
   * regra 2). Decidido pelo núcleo, pela extensão REAL — nunca pelo `kind` acima, que é
   * declarado por quem enviou.
   */
  revealMode: "open" | "folder" | "none";
  localPath?: string;
}

export interface MessageDto {
  id: string;
  seq: number;
  channelId: string;
  author: UserRef;
  /** `null` quando tombstonada (§15.6.1). */
  content: string | null;
  authorTs: Ms;
  hostTs: Ms;
  clockSkewed: boolean;
  editedAt?: Ms;
  pinned: boolean;
  /**
   * §15.6.1 — a citação sobrevive à remoção do alvo (`excerpt: null`, `deleted: true`), e
   * `author` fica ausente quando a citada não está projetada aqui.
   */
  replyTo?: { messageId: string; author?: UserRef; excerpt: string | null; deleted: boolean };
  threadId?: string;
  threadReplyCount?: number;
  mentions: { identityKeys: Key[]; roleIds: string[]; everyone: boolean };
  mentionsMe: boolean;
  hasAttachment: boolean;
  deleted: boolean;
  hiddenByBan: boolean;
}

export interface ReactionDto {
  emoji: string;
  count: number;
  mine: boolean;
}

/** `query.message` — o DTO com o que só a consulta de uma mensagem carrega. */
export type MessageFull = MessageDto & {
  reactions: ReactionDto[];
  attachment?: AttachmentDto;
  thread?: { threadId: string; replyCount: number };
};

export interface MessagesPage {
  messages: MessageDto[];
  nextCursor?: Cursor;
  hasMore: boolean;
  replication: ReplicationState;
}

export interface MemberEntry extends UserRef {
  presence: Presence;
  joinedAt: Ms;
  /**
   * TODOS os cargos ativos do membro, `rank` DESC — não só o do grupo (§15.6, emenda de
   * 2026-09-06). §9.2 define permissão efetiva como UNIÃO dos cargos e R-3 exige o cargo
   * base dentro de `member.setRoles`: com um cargo só, a tela escondia ação autorizada e
   * mandava `setRoles` sem o base.
   */
  roleIds: string[];
}

export interface MembersPage {
  groups: Array<{
    roleId: string;
    roleName: string;
    roleColor: string;
    rank: Rank;
    members: MemberEntry[];
  }>;
  offlineCount: number;
  total: number;
  nextCursor?: Cursor;
}

export interface HostStatusDto {
  status: HostStatus;
  lastSeenAt?: Ms;
  inactiveDays?: number;
  replication: { state: ReplicationState; lag: number };
  attempt?: number;
}

export type OutboxItemState = string;

export interface OutboxItem {
  opId: string;
  clientRef?: string;
  communityId: string;
  channelId?: string;
  channelName?: string;
  /** §11.2 — `kind` é o inteiro do protocolo no fio; `kindLabel` é o rótulo de UI. */
  kind: number;
  kindLabel: string;
  state: OutboxItemState;
  attempts: number;
  /**
   * §15.6 (emenda de 2026-09-05) — quando a op entrou na fila local (§11.2
   * `created_at`). É o carimbo da bolha redesenhada por F-16: antes da observação
   * na réplica não existe `hostTs`, e sem este campo a linha nascia em 1970.
   */
  enqueuedAt: Ms;
  nextAttemptAt: Ms;
  lastError?: string;
  droppedReason?: string;
  preview: { content?: string; emoji?: string; targetMessageId?: string };
}

export interface OutboxDto {
  items: OutboxItem[];
  counts: { queued: number; sending: number; failed: number };
}

/**
 * Os seis desfechos de §12.3 (`inviteResolve`), transcritos da união normativa — §12.5 fixa
 * o que cada um vaza: `banned`/`ended` levam só o nome; `invalid`/`unreachable` nada; só
 * `ok` carrega contagem e quem convidou.
 */
export type InvitePreview =
  | {
      status: "ok";
      community: {
        id: string;
        name: string;
        iconEmoji?: string;
        iconColor: number;
        memberCount: number;
      };
      invitedBy: { key: string; displayName: string; handle: string };
    }
  | { status: "banned"; communityName: string }
  | {
      status: "already-member";
      community: { id: string; name: string; iconEmoji?: string; iconColor: number };
    }
  | { status: "invalid" }
  | { status: "ended"; communityName: string }
  | { status: "unreachable"; hint?: string };

export type ResolvedMessageLink =
  | { status: "ok"; communityId: string; channelId: string; messageId: string; seq: number }
  | { status: "not-member"; communityId: string }
  // §15.6 (emenda de 2026-08-22): sem projeção da op ninguém sabe o canal, e o campo fica
  // AUSENTE. Declará-lo obrigatório fazia a tela indexar mapas com `undefined`.
  | { status: "not-synced"; communityId: string }
  | { status: "deleted" }
  | { status: "malformed" };

/* ─── Eventos de §15.5 que esta fatia escuta ─────────────────────────────────── */

export interface EvPresenceChanged {
  communityId: string;
  /** Delta: só quem MUDOU no tick. Quem some expira pelo TTL — `offline` não vem no fio. */
  entries: Array<{ identityKey: Key; status: Presence; lastSeenAt: Ms }>;
}

export interface EvTypingChanged {
  communityId: string;
  channelId: string;
  identityKeys: Key[];
}

export interface EvMessagesAppended {
  communityId: string;
  channelId: string;
  fromSeq: number;
  toSeq: number;
  hasMention: boolean;
}

export interface EvMessageAccepted {
  opId: string;
  clientRef?: string;
  messageId: string;
  seq: number;
  channelId: string;
}

export interface EvMessageFailed {
  opId: string;
  clientRef?: string;
  code: string;
  retryInMs?: number;
  terminal: boolean;
}

export interface EvMessageDropped {
  opId: string;
  clientRef?: string;
  reason: string;
  channelId: string;
}

export interface EvHostStatusChanged {
  communityId: string;
  status: HostStatus;
  lastSeenAt?: Ms;
  attempt?: number;
}

export interface EvUnreadChanged {
  communityId: string;
  channelId?: string;
  threadId?: string;
  unreadCount: number;
  pendingMentions: number;
}

/* ─── Cargos, membros e moderação (§15.6) ────────────────────────────────────── */

export interface RoleDto {
  id: string;
  name: string;
  color: string;
  rank: Rank;
  permissions: string[];
  mentionable: boolean;
  isFounder: boolean;
  isDefault: boolean;
  memberCount: number;
}

export interface MemberDetail extends UserRef {
  /** §6.1 — ausente significa offline; `offline` nunca é publicado. */
  presence?: Presence;
  roleIds: string[];
  roles: Array<{ id: string; name: string; color: string; rank: Rank }>;
  joinedAt: Ms;
  banned: boolean;
  timeoutUntil?: Ms;
  /** Affordances já decididas pelo núcleo sobre a hierarquia (§8.4.1) — a UI não recalcula. */
  canModerate: boolean;
  canKick: boolean;
  canBan: boolean;
  canTimeout: boolean;
  canSetRoles: boolean;
  storageUsedBytes: number;
}

export interface Pagina<T> {
  items: T[];
  nextCursor?: Cursor;
  hasMore: boolean;
}

export interface BanItem {
  target: UserRef;
  by: UserRef;
  at: Ms;
  reason?: string;
}

export interface TimeoutItem {
  target: UserRef;
  by: UserRef;
  at: Ms;
  until: Ms;
  reason?: string;
  expired: boolean;
}

export interface AuditItem {
  id: string;
  seq: number;
  type: string;
  targetId?: string;
  targetKey?: Key;
  targetLabel: string | null;
  by: UserRef;
  byLabel: string;
  reason?: string;
  at: Ms;
}

export interface InviteItem {
  invitePublicKey: Key;
  /** Delta U-04 — só nos criados nesta instalação. */
  code?: string;
  codeAvailable: boolean;
  label?: string;
  createdBy: UserRef;
  createdAt: Ms;
  expiresAt?: Ms;
  maxUses?: number;
  uses: number;
  revokedAt?: Ms;
}

export interface SelfModeration {
  banned: boolean;
  bannedAt?: Ms;
  kicked: boolean;
  timeoutUntil?: Ms;
  byLabel?: string;
  reason?: string;
}

/* ─── Threads, fixados, arquivos e links (§15.6) ─────────────────────────────── */

export interface ThreadDto {
  root: MessageDto;
  replies: MessageDto[];
  nextCursor?: Cursor;
  replyCount: number;
  participants: UserRef[];
  unread: { count: number };
}

export interface FileItem {
  messageId: string;
  at: Ms;
  author: UserRef;
  attachment: AttachmentDto;
}

export interface LinkItem {
  messageId: string;
  at: Ms;
  author: UserRef;
  url: string;
  /** §15.6.1 emenda — hostname, não registrable domain: PSL muda e §8.0 proíbe. */
  host: string;
}

export interface ReactorsDto {
  total: number;
  users: UserRef[];
}

/* ─── Busca (§23.1) ──────────────────────────────────────────────────────────── */

export interface SearchArgs {
  communityId: string;
  query: string;
  filters?: { authorKey?: Key; channelId?: string; date?: string; kind?: string };
  scopeChannelId?: string;
  limitPerGroup?: number;
}

/**
 * Transcrição do fio real de `query.search` (`core/src/l2/search/service.ts`).
 * A mensagem NÃO é o `MessageDto` completo: o FTS devolve o hit com o snippet
 * pronto e os campos que a ordenação/destaque precisam.
 */
export interface SearchMessageHitDto {
  id: string;
  seq: number;
  channelId: string;
  channelName: string;
  authorKeyHex: Key;
  content: string;
  /** Trecho com o casamento — derivado no núcleo, porque o FTS é contentless. */
  snippet: string;
  authorTs: Ms;
  hostTs: Ms;
  clockSkewed: boolean;
  editedAt: Ms | null;
  pinned: boolean;
  threadId: Key | null;
}

export interface SearchChannelHitDto {
  id: string;
  name: string;
  type: number;
  categoryId: string;
}

export interface SearchMemberHitDto {
  identityKeyHex: Key;
  displayName: string;
  nickname: string | null;
}

export interface SearchResult {
  messages: SearchMessageHitDto[];
  channels: SearchChannelHitDto[];
  members: SearchMemberHitDto[];
  partial: boolean;
  partialReason?: "host-offline" | "catching-up" | "stalled" | "partial-interpretation";
}

/* ─── Threads (§15.6 emenda de 2026-08-25, fecha o §9 2.2) ───────────────────── */

export interface ThreadUnreadItem {
  threadId: Key;
  rootMessageId: string;
  channelId: string;
  unreadCount: number;
}

/* ─── Preferências locais (§15.6, fecha RT-02) ───────────────────────────────── */

export interface PreferencesDto {
  device: {
    microphoneId?: string;
    cameraId?: string;
    outputId?: string;
    inputVolume: number;
    outputVolume: number;
  };
  notifications: { enabled: boolean; byCommunity: Array<{ communityId: string; level: string }> };
  channels: Array<{ channelId: string; muted: boolean }>;
  relayConsent: Array<{ communityId: string; decision: string; at: Ms }>;
  participantVolumes: Array<{ communityId: string; identityKey: Key; volume: number }>;
}

/* ─── Eventos adicionais de §15.5 que estas telas escutam ────────────────────── */

export interface EvBlobProgress {
  blobsCoreKey: Key;
  /** §15.5 emenda de 2026-08-22 — nas cinco linhas de blob o id viaja como hex. */
  blobIdHex: string;
  progress: number;
  bytesDownloaded: number;
  peers: number;
  hostAvailable: boolean;
}

export interface EvMessageUpdated {
  communityId: string;
  messageId: string;
  channelId: string;
  fields: string[];
}

export interface EvAccessRevoked {
  communityId: string;
  cause: "banned" | "kicked" | "unauthorized";
}

/* ─── Conversa direta (§31.16.3) ─────────────────────────────────────────────── */

export type DmConvState = "pending-out" | "pending-in" | "accepted" | "blocked" | "left";

export type DmSync =
  | "synced"
  | "catching-up"
  | "stalled"
  | "peer-offline"
  | "unauthorized"
  | "forked"
  | "desynced";

/**
 * §31.16.3 — **sem `collision`**: numa conversa de dois não há conjunto em que colidir. O
 * `handle` (§6.1) é derivado da chave e sempre exibido junto do nome — é a mitigação (a) de
 * L-5, e aqui ela é mais forte, porque para falar com alguém é preciso JÁ ter a chave dele.
 */
export interface DmPeerRef {
  key: Key;
  displayName: string;
  handle: string;
  avatarColor: number;
}

export interface DmMessageDto {
  id: string;
  ordSum: number;
  conversationId: string;
  author: DmPeerRef;
  /** `null` quando tombstonada (A26). */
  content: string | null;
  ts: Ms;
  clockSkewed: boolean;
  ackAhead: boolean;
  editedAt?: Ms;
  replyTo?: { messageId: string; author: DmPeerRef; excerpt: string | null; deleted: boolean };
  hasAttachment: boolean;
  deleted: boolean;
  /**
   * §31.11 — só nas **próprias**; ausente nas do par. `undelivered` (a ausência de
   * `delivered`) **não distingue offline de bloqueado** (§31.9 r. 2), e a UI é proibida de
   * afirmar a causa (L-26, L-28) e de rotular `delivered` como "lido".
   */
  delivery?: "written" | "delivered";
}

export interface DmConversationItem {
  conversationId: string;
  peer: DmPeerRef;
  state: DmConvState;
  sync: DmSync;
  unread: { count: number };
  lastMessage?: { ordSum: number; ts: Ms; excerpt: string | null; author: DmPeerRef };
  /** Só em `pending-in`: quantos registros do par já chegaram (teto de §31.9). */
  pendingRecords?: number;
}

export interface DmConversationDetail {
  conversationId: string;
  peer: DmPeerRef;
  state: DmConvState;
  sync: DmSync;
  lag: number;
  deliveredUpTo: number;
  selfInvalid: boolean;
  peerInvalid: boolean;
  partialInterpretation: boolean;
  /** §31.16.3 (emenda de 2026-09-05) — o `ordKey` do watermark de leitura (§31.6/A28). */
  lastReadOrdSum: number;
  lastReadAuthorKey: string;
  blockedAt?: Ms;
  retainUntil?: Ms;
}

export interface DmMessagesPage {
  messages: DmMessageDto[];
  /** `base64url({ordSum, authorKey, id})`, opaco (§31.16.3). */
  nextCursor?: string;
  hasMore: boolean;
  sync: DmSync;
  /**
   * §31.16.3 (emenda de 2026-09-05) — o corte do divisor de "Novas mensagens" de **U-33**,
   * na MESMA resposta da página. Numa segunda consulta a marca poderia avançar entre as
   * duas, e o divisor apareceria no lugar errado por uma corrida.
   */
  lastReadOrdSum: number;
  lastReadAuthorKey: string;
}

export interface DmMessageFull extends DmMessageDto {
  reactions: ReactorsDto[];
  attachment?: AttachmentDto & { ownerKey: Key; blobsCoreKey: Key; blobId: unknown };
}

/* ─── Eventos de §31.16.2 que a UI de DM escuta ─────────────────────────────── */

export interface EvDmAppended {
  conversationId: string;
  fromOrdSum: number;
  toOrdSum: number;
  hasIncoming: boolean;
}

export interface EvDmMessageUpdated {
  conversationId: string;
  messageId: string;
  fields: string[];
}

/** §31.13 — a UI é **obrigada** a recarregar a partir daqui: a história mudou de ordem. */
export interface EvDmReordered {
  conversationId: string;
  fromOrdSum: number;
}

export interface EvDmSync {
  conversationId: string;
  state: DmSync;
  lag: number;
  reason?: string;
}
