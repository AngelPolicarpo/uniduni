/**
 * Modelo de domínio — §2 da spec de UX/UI.
 *
 * A forma que as telas consomem. Nasceu para as fixtures de `src/mocks/` e
 * sobreviveu a elas: hoje o dado vem do núcleo pela IPC-R e é `live/adaptadores.ts`
 * que traduz os DTOs de §15.6 para cá — por isso este modelo é mais estreito que o
 * fio em vários pontos, e cada divergência está anotada lá. Os nomes de campo estão
 * em inglês (convenção de código); o mapeamento pros nomes da spec está anotado onde
 * não é óbvio. Todo texto de interface continua em português.
 */

/* ─── Identidade e presença ──────────────────────────────────────── */

/** §2 Identity.statusPresence — `offline` só existe para os outros. */
export type PresenceStatus = "online" | "idle" | "dnd" | "invisible" | "offline";

/** §5.4 — conjunto curado fechado; nunca color-picker livre. */
export type RoleColor =
  | "role-gold"
  | "role-blue"
  | "role-green"
  | "role-red"
  | "role-purple"
  | "role-pink"
  | "role-neutral";

/**
 * §5.4 — paleta de avatar/ícone de comunidade. Reaproveita as 7 cores de
 * cargo + o accent do produto, em vez de inventar uma paleta paralela.
 */
export type AvatarColor = RoleColor | "accent";

/** §2 Identity — o par de chaves não é exibido, só sua existência. */
export interface Identity {
  id: string;
  /** Identificador local curto, ex.: `@ana` (§10, 3.1). */
  handle: string;
  displayName: string;
  avatarColor: AvatarColor;
  /** Chave pública de identidade (§15.6 `key`); só aparece truncada em Configurações (3.1). */
  publicKey: string;
  presence: PresenceStatus;
  createdAt: string;
}

/* ─── Saúde de conexão P2P (§5.4, §12) ───────────────────────────── */

export type HostStatus = "online" | "offline" | "reconnecting";
export type MeshStatus = "ok" | "degraded" | "failed";

export interface ConnectionHealth {
  hostStatus: HostStatus;
  meshStatus?: MeshStatus;
}

/* ─── Cargos e permissões (§10, 3.2) ─────────────────────────────── */

export type PermissionGroup = "general" | "text" | "voice" | "moderation";

export type Permission =
  // Geral
  | "manage_community"
  | "manage_channels"
  | "view_audit_log"
  // Texto
  | "send_messages"
  | "attach_files"
  | "add_reactions"
  | "mention_everyone"
  | "pin_messages"
  | "manage_messages"
  // Voz
  | "voice_speak"
  | "voice_mute_others"
  | "voice_share_screen"
  // Moderação
  | "create_invite"
  | "kick_members"
  | "ban_members"
  | "timeout_members"
  | "manage_roles";

export interface Role {
  id: string;
  name: string;
  color: RoleColor;
  /** Hierarquia: maior = mais alto. Fundador é sempre o topo (§10). */
  position: number;
  permissions: Permission[];
  mentionable: boolean;
  memberCount: number;
  /** Cargo base de todo membro; não pode ser deletado (§10, D13). */
  isDefault?: boolean;
  /** Fundador: não editável, não deletável, sempre no topo (§10). */
  isFounder?: boolean;
}

/* ─── Estrutura da comunidade ────────────────────────────────────── */

export interface Community {
  id: string;
  name: string;
  /** Emoji do ícone; quando ausente, usa iniciais + `iconColor`. */
  iconEmoji?: string;
  iconColor: AvatarColor;
  description?: string;
  hostPeerId: string;
  /** §2 `souEuOHost` — a comunidade roda na máquina da identidade local. */
  isHostedByMe: boolean;
  createdAt: string;
  memberCount: number;
  categoryIds: string[];
  roleIds: string[];
  connectionHealth: ConnectionHealth;
  /**
   * §18.4 passo 5 / U-16 — modo histórico somente leitura. Presente = esta instalação
   * perdeu acesso (ou saiu) e o que resta é a cópia local, até `retainUntil`.
   */
  removedReason?: "banned" | "kicked" | "unauthorized" | "left";
  retainUntil?: number;
  /**
   * §18.5 / U-17 — a comunidade é terminal. Como `removedReason`, é o que põe a tela em
   * modo histórico; ao contrário dele, **todo mundo** a vê assim, não só quem saiu.
   */
  endedAt?: number;
}

export interface Category {
  id: string;
  communityId: string;
  name: string;
  channelIds: string[];
  collapsed: boolean;
}

export type ChannelType = "text" | "voice";

/**
 * §6.6 (emenda de 2026-08-28, R-29) — modo de fala do canal de voz. Os números são
 * constantes de protocolo (viajam como `u8` no log); aqui entram já traduzidos.
 */
export type SpeechMode = "free" | "queue" | "admins";

export const SPEECH_MODE_DEFAULT_SECONDS = 300;

export interface Channel {
  id: string;
  communityId: string;
  categoryId: string;
  type: ChannelType;
  name: string;
  topic?: string;
  unreadCount: number;
  pendingMentions: number;
  muted: boolean;
  /**
   * Onde entra o divisor "Novas mensagens" ao reabrir o canal (§6). Fica no
   * canal, não na mensagem, porque "lido até aqui" é estado de quem lê.
   */
  firstUnreadMessageId?: string;
  /** `#avisos`: só quem tem `send_messages` aqui posta (§9, 2.1). */
  readOnlyForRoleIds?: string[];
  /** Só quando `type === "voice"`: ids de quem está conectado agora. */
  voiceParticipantIds?: string[];
  /** §6.6 — quem transmite áudio; default `free` quando o log não carrega. */
  speechMode: SpeechMode;
  /** §6.6 — duração do turno no modo fila (30–3600 s); default 300. */
  queueTurnSeconds: number;
}

export interface Member {
  identityId: string;
  communityId: string;
  displayName: string;
  handle: string;
  avatarColor: AvatarColor;
  /** Apelido dentro desta comunidade (§2). */
  nickname?: string;
  roleIds: string[];
  joinedAt: string;
  presence: PresenceStatus;
  banned: boolean;
}

/* ─── Mensagens (§9, 2.1) ────────────────────────────────────────── */

export interface Reaction {
  emoji: string;
  count: number;
  /** Ids de quem reagiu — destaca o chip quando inclui a identidade local. */
  userIds: string[];
}

export type AttachmentKind = "video" | "image" | "audio" | "document" | "other";

/** §13.6 regra 1 — as três respostas possíveis para "o que dá para fazer com este arquivo". */
export type RevealMode = "open" | "folder" | "none";

export interface Attachment {
  id: string;
  name: string;
  sizeBytes: number;
  kind: AttachmentKind;
  /** 0-100; distribuição estilo torrent (§11, B8). */
  downloadProgress: number;
  availablePeers: number;
  hostAvailable: boolean;
  /**
   * §13.6 regra 1 — o que o cartão pode oferecer para este arquivo. Vem do núcleo, que é
   * quem tem a tabela de extensões e quem recusaria a ação: `open` = "Abrir" e "Mostrar na
   * pasta"; `folder` = só mostrar na pasta; `none` = nenhuma das duas (executável, regra 2).
   *
   * Opcional porque anexo em composição (ainda sem `origem`) não tem ação nenhuma a
   * oferecer; ausente é lido como `folder`, que é o desfecho conservador.
   */
  revealMode?: RevealMode;
  /**
   * Origem no fio (§13.4) — presente só em anexo vindo do núcleo; as fixtures do mock
   * não a têm. É o que o card precisa para pedir o download e o reveal.
   */
  origem?: {
    communityId: string;
    blobsCoreKey: string;
    blobId: { byteOffset: number; blockOffset: number; blockLength: number; byteLength: number };
  };
}

export type MessageDeliveryState =
  | "sent"
  | "sending"
  | "failed"
  /** Fila local enquanto o host está offline (premissa 5, §11 B4). */
  | "queued";

export interface Message {
  id: string;
  channelId: string;
  authorId: string;
  /** Markdown básico, renderizado só depois de enviado (§11, C9). */
  content: string;
  timestamp: string;
  edited: boolean;
  pinned: boolean;
  replyToId?: string;
  threadId?: string;
  /** §15.6.1 — `reply_count` da tabela `threads`; existe só em mensagens ancoradas. */
  threadReplyCount?: number;
  reactions: Reaction[];
  attachments: Attachment[];
  /** Ids de membros/cargos mencionados; `@everyone` usa o id `everyone`. */
  mentions: string[];
  deliveryState: MessageDeliveryState;
}

export interface Thread {
  id: string;
  rootMessageId: string;
  channelId: string;
  replyIds: string[];
  participantIds: string[];
  unreadCount: number;
}

/* ─── Convites (§7, 0.3) ─────────────────────────────────────────── */

export interface Invite {
  code: string;
  communityId: string;
  createdById: string;
  createdAt: string;
  /** Sem expiração por padrão (premissa 4). */
  expiresAt?: string;
  maxUses?: number;
  uses: number;
  revoked: boolean;
}

/**
 * Resultado da resolução de um convite (§7, 0.3). O mock devolve um destes
 * estados; `banned` não vaza dado nenhum da comunidade.
 */
export type InvitePreview =
  | { status: "ok"; community: Community; invitedBy: Member }
  | { status: "already-member"; community: Community }
  | { status: "banned"; communityName: string }
  | { status: "invalid" };

/* ─── Busca (§23.1) — resultados de `query.search`, já adaptados ──────────── */

/** Uma mensagem achada pelo FTS do núcleo — o trecho já vem recortado. */
export interface SearchMessageHit {
  id: string;
  channelId: string;
  channelName: string;
  authorId: string;
  content: string;
  snippet: string;
  timestamp: string;
}

export interface SearchChannelHit {
  id: string;
  name: string;
}

/** As quatro causas de `partial` de §23.1/RT-11 — nomeadas pelo fio. */
export type SearchPartialReason =
  | "host-offline"
  | "catching-up"
  | "stalled"
  | "partial-interpretation";

export interface BuscaResults {
  messages: SearchMessageHit[];
  channels: SearchChannelHit[];
  members: Member[];
  partial: boolean;
  partialReason?: SearchPartialReason;
}

/* ─── Moderação (§10, 3.3) ───────────────────────────────────────── */

export type ModerationActionType =
  | "kick"
  | "ban"
  | "timeout"
  | "removeTimeout"
  | "deleteMessage"
  /** §2 registra "criou o cargo Contribuidor" no log — o par dele também. */
  | "createRole"
  | "updateRole"
  | "deleteRole"
  | "revokeBan"
  /** §10, 3.4 — o log é da comunidade, não só de punições. */
  | "createChannel"
  | "updateChannel"
  | "deleteChannel"
  | "createCategory"
  | "renameCategory"
  | "deleteCategory"
  | "updateCommunity"
  | "endCommunity"
  | "assumeHost"
  | "setSuccessors"
  | "revokeInvite";

export interface ModerationAction {
  id: string;
  communityId: string;
  type: ModerationActionType;
  targetId: string;
  targetLabel: string;
  authorId: string;
  /**
   * Rótulo congelado no momento da ação (§6.13) — é a verdade sobre quem agiu
   * mesmo depois de o autor sair e o roster o esquecer.
   */
  authorLabel?: string;
  reason?: string;
  timestamp: string;
}

/* ─── Voz e compartilhamento de tela (§9, 2.3 / 2.4) ─────────────── */

export interface VoiceParticipant {
  identityId: string;
  speaking: boolean;
  muted: boolean;
  deafened: boolean;
  cameraOn: boolean;
  sharingScreen: boolean;
  /** Falha pontual de mesh com a identidade local (§11, B7). */
  connectionToMe: MeshStatus;
}

export interface VoiceSession {
  channelId: string;
  communityId: string;
  participants: VoiceParticipant[];
}

/**
 * §17.5/A19 — **estrela, e só estrela**. A árvore de multicast está especificada em §17.8 e
 * **adiada para fora do v1** (A20): não há `topology`, `treeHealth` nem `firstLevelRelays`
 * aqui porque não há árvore a descrever. O que existia eram superfícies do mock desenhadas
 * sobre uma arquitetura revogada (B26).
 *
 * `usingTurnFallback` saiu pelo mesmo motivo, e por um mais forte: §17.3 diz que **tela via
 * TURN é recusada no v1**. Um selo "Via TURN" no tile prometia um caminho que a spec nega.
 */
export interface ScreenShareSession {
  presenterId: string;
  channelId: string;
  /**
   * Quantos assistem. §15.5 manda a **contagem** em `share.viewersChanged`, não a lista:
   * quem assiste não precisa saber quem mais está lá, e quem apresenta descobre pelos pares
   * que serve. Não há teto de espectadores (§90): o que limita é o upload de quem
   * apresenta, e disso cuida a degradação medida de §17.5.
   */
  viewerCount: number;
  /** §17.5 — `high` 2500 kbps · `balanced` 1200 · `low` 600. Não existe "auto". */
  quality: "high" | "balanced" | "low";
}
