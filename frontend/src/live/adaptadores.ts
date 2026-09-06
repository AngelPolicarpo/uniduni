/**
 * Adaptadores §15.6 → `domain/types.ts`.
 *
 * Telas, ícones e componentes ficam **intactos**; o que muda é de onde o dado vem. Estas
 * funções são a única costura — traduzem os DTOs do fio para as formas que os componentes
 * já consomem, e é aqui que mora toda divergência entre os dois modelos.
 *
 * Por que a tradução vive aqui e não nos componentes: `domain/types.ts` foi escrito para as
 * fixtures e é mais estreito que §15.6 em vários pontos (cor como token × `u8`, `position`
 * × `rank`, `HostStatus` de 3 × 9 valores). Espalhar essas conversões pelas telas colocaria
 * regra de fronteira dentro da UI e faria cada divergência ser resolvida de um jeito
 * diferente em cada arquivo.
 *
 * Regra desta fatia: **onde o mock não tem aparência para um valor do fio, escolhe-se o
 * vizinho mais conservador e a lacuna fica registrada** — nunca se inventa elemento de tela.
 */

import { tokenDaCor } from "../ipc/cores";
import type {
  AttachmentKind,
  Attachment,
  AvatarColor,
  Category,
  Channel,
  Community,
  Identity,
  Member,
  Message,
  ModerationAction,
  PresenceStatus,
  Reaction,
  Role,
  RoleColor,
  HostStatus as HostStatusMock,
} from "../domain/types";
import type {
  AuditItem,
  BanItem,
  ChannelDto,
  CommunityDetail,
  CommunityListItem,
  HostStatus,
  IdentityDto,
  MemberEntry,
  MessageDto,
  OutboxItem,
  Presence,
  RoleDto,
  SearchResult as SearchResultDto,
  StructureDto,
  TimeoutItem,
  UserRef,
} from "../ipc/dto";
import type { BanRecord, TimeoutRecord } from "../store/moderationStore";
import type { BuscaResults } from "../domain/types";

/* ─── Escalares ──────────────────────────────────────────────────────────── */

/** §6.4.2 — o fio manda `u8`; o mock pinta por token. Fora do catálogo cai no neutro. */
export function corDeAvatar(bruto: unknown): AvatarColor {
  return (tokenDaCor(bruto) ?? "role-neutral") as AvatarColor;
}

/** `accent` não é atribuível a cargo (§6.4.2): se vier, vira neutro. */
export function corDeCargo(bruto: unknown): RoleColor {
  const token = tokenDaCor(bruto);
  return token === null || token === "accent" ? "role-neutral" : token;
}

export function iso(ms: number | undefined): string {
  return new Date(ms ?? 0).toISOString();
}

/** §6.1 — `offline` não é publicado: a AUSÊNCIA de presença é que o significa. */
export function presenca(p: Presence | undefined): PresenceStatus {
  return p ?? "offline";
}

/**
 * §15.6 `HostStatus` tem nove valores; o mock tem três. Os quatro terminais
 * (`ended`, `unauthorized`, `incompatible`, `forked`) não têm aparência no mock e caem em
 * `offline` — que é o vizinho honesto: em todos eles não há host de quem esperar resposta.
 * O que se perde é a explicação, e ela está registrada como lacuna de UX.
 */
export function statusDoHost(s: HostStatus | undefined): HostStatusMock {
  switch (s) {
    case "online":
      return "online";
    case "connecting":
    case "reconnecting":
    case "unknown":
      return "reconnecting";
    default:
      return "offline";
  }
}

/** §6 — `type` é numérico no fio; 1 é voz. */
export function tipoDeCanal(t: number): Channel["type"] {
  return t === 1 ? "voice" : "text";
}

/* ─── Entidades ──────────────────────────────────────────────────────────── */

export function identidade(d: IdentityDto): Identity {
  return {
    id: d.key,
    handle: d.handle,
    displayName: d.displayName,
    avatarColor: corDeAvatar(d.avatarColor),
    // O mock mostra a chave truncada em Configurações; é a mesma chave pública.
    publicKey: d.key,
    presence: presenca(d.presence),
    createdAt: iso(d.createdAt),
  };
}

export function membroDeRef(communityId: string, u: UserRef, extra?: Partial<Member>): Member {
  return {
    identityId: u.key,
    communityId,
    displayName: u.displayName,
    handle: u.handle,
    avatarColor: corDeAvatar(u.avatarColor),
    ...(u.nickname !== undefined ? { nickname: u.nickname } : {}),
    roleIds: [],
    joinedAt: iso(0),
    presence: "offline",
    banned: false,
    ...extra,
  };
}

export function membroDeEntrada(communityId: string, m: MemberEntry, roleId: string): Member {
  return membroDeRef(communityId, m, {
    roleIds: [roleId],
    joinedAt: iso(m.joinedAt),
    presence: presenca(m.presence),
  });
}

export function cargo(r: RoleDto, posicao: number): Role {
  return {
    id: r.id,
    name: r.name,
    color: corDeCargo(r.color),
    // `rank` é índice fracionário (§6.4.1) e não é comparável a um inteiro. A posição do
    // mock é ordinal, e `query.roles` já vem em `rank DESC`: a ordem do array É a hierarquia.
    position: posicao,
    permissions: r.permissions as Role["permissions"],
    mentionable: r.mentionable,
    memberCount: r.memberCount,
    ...(r.isDefault ? { isDefault: true } : {}),
    ...(r.isFounder ? { isFounder: true } : {}),
  };
}

export function comunidade(c: CommunityListItem, detalhe?: CommunityDetail, estrutura?: StructureDto): Community {
  return {
    id: c.id,
    name: c.name,
    ...(c.iconEmoji !== undefined ? { iconEmoji: c.iconEmoji } : {}),
    iconColor: corDeAvatar(c.iconColor),
    // §15.6 não declara `description` em `query.community`; o mock a exibe em
    // Configurações. Campo sem fonte fica AUSENTE — lacuna registrada.
    // `hostPeerId` do mock é identificação de quem hospeda; no fio isso é `hostRef.key`, que
    // só `query.community` traz. Sem detalhe carregado, fica a própria comunidade.
    hostPeerId: detalhe?.hostRef.key ?? c.id,
    isHostedByMe: c.isHostedByMe,
    // §15.6 não declara data de criação da comunidade em lugar nenhum. O mock exige o campo;
    // a época zero é visivelmente "sem data" e não finge uma. Lacuna registrada.
    createdAt: iso(0),
    memberCount: c.memberCount,
    categoryIds: (estrutura?.categories ?? []).map((cat) => cat.id),
    roleIds: detalhe?.myRoleIds ?? [],
    connectionHealth: { hostStatus: statusDoHost(c.hostStatus) },
    // §18.4 passo 5 — o que faz a comunidade aparecer no rail em modo histórico.
    ...(c.removedReason !== undefined ? { removedReason: c.removedReason } : {}),
    ...(c.retainUntil !== undefined ? { retainUntil: c.retainUntil } : {}),
    // §18.5 / U-17 — encerrada tem aparência própria, e ela não depende de eu ter saído.
    ...(c.endedAt !== undefined ? { endedAt: c.endedAt } : {}),
  };
}

export function categoria(communityId: string, c: StructureDto["categories"][number]): Category {
  return {
    id: c.id,
    communityId,
    name: c.name,
    channelIds: c.channels.map((ch) => ch.id),
    collapsed: c.collapsed,
  };
}

export function canal(communityId: string, categoryId: string, ch: ChannelDto): Channel {
  return {
    id: ch.id,
    communityId,
    categoryId,
    type: tipoDeCanal(ch.type),
    name: ch.name,
    ...(ch.topic !== undefined ? { topic: ch.topic } : {}),
    unreadCount: ch.unread.count,
    pendingMentions: ch.unread.mentions,
    muted: ch.muted,
    // §15.6 dá `readOnly` JÁ RESOLVIDO para quem pergunta; o mock guardava a lista de cargos
    // e resolvia na tela. Manter a lista exigiria recalcular a permissão fora do núcleo —
    // a lista vazia com o booleano aplicado é o que preserva o comportamento sem duplicar
    // a regra. `selectIsChannelReadOnly` é ajustado para ler o campo resolvido.
    ...(ch.readOnly ? { readOnlyForRoleIds: [] } : {}),
    ...(ch.voice !== undefined ? { voiceParticipantIds: ch.voice.first.map((u) => u.key) } : {}),
    // §6.6 (emenda de 2026-08-28) — o núcleo já devolve com os defaults aplicados; a
    // conversão do número para o rótulo é a única tradução que cabe aqui.
    speechMode: modoDeFala(ch.speechMode),
    queueTurnSeconds: ch.queueTurnSeconds,
  };
}

/** `u8` de §6.6 → rótulo da UI. Valor fora do enum é tratado como `free` (§7.2 regra 4). */
function modoDeFala(n: number): Channel["speechMode"] {
  return n === 1 ? "queue" : n === 2 ? "admins" : "free";
}

export function mensagem(m: MessageDto, euId: string | null): Message {
  return {
    id: m.id,
    channelId: m.channelId,
    authorId: m.author.key,
    // §15.6.1 — `null` é tombstone. O mock não tem estado de mensagem removida; o texto
    // é o de U-20, que já é o que a spec manda dizer.
    content: m.content ?? "_Mensagem removida da interface — os bytes continuam no registro da comunidade._",
    timestamp: iso(m.hostTs),
    edited: m.editedAt !== undefined,
    pinned: m.pinned,
    ...(m.replyTo !== undefined ? { replyToId: m.replyTo.messageId } : {}),
    ...(m.threadId !== undefined ? { threadId: m.threadId } : {}),
    ...(m.threadReplyCount !== undefined ? { threadReplyCount: m.threadReplyCount } : {}),
    // Reações e anexo não estão no `MessageDto` (§15.6.1): vêm de `query.message`, sob
    // demanda. A lista vazia é o estado antes de a linha ser detalhada, não uma afirmação
    // de que não há reação.
    reactions: [],
    attachments: [],
    mentions: [
      ...m.mentions.identityKeys,
      ...m.mentions.roleIds,
      ...(m.mentions.everyone ? ["everyone"] : []),
    ],
    // Mensagem projetada já está no log: entregue. A fila é da outbox, e é ela que produz
    // `queued`/`sending`/`failed` — nunca esta função.
    deliveryState: "sent",
    ...(euId !== null && m.mentionsMe ? {} : {}),
  };
}

/* ─── Fila da outbox (§11.3 × §15.6 `query.outbox`) ──────────────────────── */

/** O que `aplicarFila` consome: a bolha já na forma do mock, ou nada. */
export interface BolhaDaFila {
  /** `clientRef` — o mesmo id da bolha otimista que a originou. */
  ref: string;
  opId: string;
  channelId: string;
  content: string;
  /** ISO do `enqueuedAt` de §15.6 — o instante do enfileiramento, não o do log. */
  timestamp: string;
  deliveryState: Message["deliveryState"];
}

/**
 * Estado de entrega da UI a partir do estado da outbox (§11.3). O mock tem quatro
 * estados; a outbox tem cinco. `awaiting-confirmation` (ACK recebido, ainda não
 * observado na réplica) não é entrega para o normativo — "sending" é o vizinho
 * honesto, e é a opacidade reduzida de §6 que a linha já sabe desenhar.
 */
export function estadoDeEntrega(estado: string): Message["deliveryState"] | null {
  switch (estado) {
    case "queued":
      return "queued";
    case "sending":
    case "awaiting-confirmation":
      return "sending";
    case "failed":
      return "failed";
    default:
      // `dropped` não vira bolha: o item saiu da fila com motivo nomeado e quem
      // o viu como bolha recebe o desfecho por `message.dropped`.
      return null;
  }
}

/**
 * Bolha de fila a partir de um item de `query.outbox`. Só itens COM `clientRef`,
 * canal e preview de conteúdo viram bolha — são os que esta instalação enfileirou
 * pela UI (fecha F-16: "o preview é o que permite a UI redesenhar a fila ao
 * reabrir"). Reação/edição/thread têm `targetMessageId`, não conteúdo, e aplicam
 * sobre mensagens reais quando drenarem — nunca viram linha nova.
 */
export function bolhaDaFila(item: OutboxItem): BolhaDaFila | null {
  if (item.clientRef === undefined || item.channelId === undefined) return null;
  const content = item.preview.content;
  if (content === undefined) return null;
  const deliveryState = estadoDeEntrega(item.state);
  if (deliveryState === null) return null;
  return {
    ref: item.clientRef,
    opId: item.opId,
    channelId: item.channelId,
    content,
    timestamp: iso(item.enqueuedAt),
    deliveryState,
  };
}

export function reacoes(lista: ReadonlyArray<{ emoji: string; count: number; mine: boolean }>, euId: string | null): Reaction[] {
  return lista.map((r) => ({
    emoji: r.emoji,
    count: r.count,
    // O fio diz apenas SE eu reagi (`mine`), não quem mais reagiu — `query.reactors` é uma
    // consulta à parte. O mock usa `userIds` só para destacar o próprio chip, e é isso que
    // a lista de um elemento preserva.
    userIds: r.mine && euId !== null ? [euId] : [],
  }));
}

/**
 * Threads que a página do canal revela e a store ainda não conhece — as criadas em
 * OUTRAS instalações (§61.4). Devolve só os **ids**: a raiz NÃO é dedutível daqui.
 *
 * Deduzi-la como o registro de menor `seq` da página parece seguro por R-24 (o fold
 * só aceita resposta em thread existente), mas a página é a janela de 50 de §23.3 —
 * uma thread aberta há tempo tem a raiz FORA dela, e o palpite elegia uma resposta
 * como âncora. Pior: `conhecidas` então a dava por resolvida, e o indicador "N
 * respostas" ficava para sempre sob a mensagem errada. Quem sabe a raiz é
 * `query.thread` (`threads.root_message_id`); quem a pergunta é o sincronizador.
 *
 * Conhecidas não entram — quem assenta a temporária local é `assentarThreadReal`, e
 * sobrescrevê-la aqui a reverteria.
 */
export function threadsDaPagina(
  dtos: ReadonlyArray<{ id: string; seq: number; threadId?: string; channelId: string }>,
  conhecidas: ReadonlySet<string>,
): string[] {
  const ids: string[] = [];
  const vistas = new Set<string>();
  for (const dto of dtos) {
    if (dto.threadId === undefined || conhecidas.has(dto.threadId) || vistas.has(dto.threadId)) continue;
    vistas.add(dto.threadId);
    ids.push(dto.threadId);
  }
  return ids;
}

/** Número do fio (§7.4.1 `u8 kind`) → token do domínio. A ordem É a de §13.6. */
const KINDS: Record<number, AttachmentKind> = {
  0: "image",
  1: "video",
  2: "audio",
  3: "document",
  4: "other",
  5: "other",
};

/**
 * Anexo de §15.6.1 → domínio. O `id` é o `blobIdHex` de §13.2 — os 16 primeiros bytes do
 * hash —, a MESMA chave que os eventos `blob.*` usam no fio (emenda de 2026-08-22), então
 * progresso/conclusão casam com o card sem tradução extra.
 */
export function anexo(
  dto: {
    blobsCoreKey: string;
    blobId: { byteOffset: number; blockOffset: number; blockLength: number; byteLength: number };
    name: string;
    sizeBytes: number;
    kind: number;
    hash: string;
    progress: number;
    availablePeers: number;
    hostAvailable: boolean;
    revealMode?: "open" | "folder" | "none";
  },
  communityId: string,
): Attachment {
  return {
    id: dto.hash.slice(0, 32),
    name: dto.name,
    sizeBytes: dto.sizeBytes,
    kind: KINDS[dto.kind] ?? "other",
    // §15.6.1/§13.4 — o fio fala 0..1; o card fala 0..100.
    downloadProgress: Math.round(dto.progress * 100),
    availablePeers: dto.availablePeers,
    hostAvailable: dto.hostAvailable,
    // §13.6 — quem decide é o núcleo. Um núcleo mais antigo não manda o campo; ler a
    // ausência como `folder` é a leitura conservadora (mostrar na pasta nunca entrega
    // arquivo a programa nenhum).
    revealMode: dto.revealMode ?? "folder",
    origem: {
      communityId,
      blobsCoreKey: dto.blobsCoreKey,
      blobId: dto.blobId,
    },
  };
}

/* ─── Moderação (§15.6 leituras; §6.13 rótulos congelados) ───────────────── */

/**
 * Entrada do `query.auditLog` → domínio. O `type` é o `AuditType` fechado do fold
 * (§6.13/§7.4 coluna Aud.) e a união do domínio cobre os mesmos 20; um tipo
 * DESCONHEIDO (host mais novo que o renderer) não derruba a tela — descreve-se
 * pelo rótulo genérico, como as notificações de §16.3 já fazem.
 */
export function entradaDeAuditoria(
  item: AuditItem,
  communityId: string,
): ModerationAction {
  return {
    id: item.id,
    communityId,
    type: item.type as ModerationAction["type"],
    targetId: item.targetKey ?? item.targetId ?? "",
    targetLabel: item.targetLabel ?? item.targetKey ?? item.targetId ?? "—",
    authorId: item.by.key,
    authorLabel: item.byLabel,
    ...(item.reason !== undefined ? { reason: item.reason } : {}),
    timestamp: iso(item.at),
  };
}

/** Banido vivo de `query.bans`. O rótulo é o que o roster tem AGORA (§15.6). */
export function banido(item: BanItem, communityId: string): BanRecord {
  return {
    communityId,
    identityId: item.target.key,
    label: item.target.displayName || item.target.key.slice(0, 8),
    byId: item.by.key,
    at: iso(item.at),
    ...(item.reason !== undefined ? { reason: item.reason } : {}),
  };
}

/** Timeout de `query.timeouts`; expirados ficam fora — são história, não estado. */
export function timeout(item: TimeoutItem, communityId: string): TimeoutRecord | null {
  if (item.expired) return null;
  return {
    communityId,
    identityId: item.target.key,
    label: item.target.displayName || item.target.key.slice(0, 8),
    byId: item.by.key,
    at: iso(item.at),
    until: item.until,
    ...(item.reason !== undefined ? { reason: item.reason } : {}),
  };
}

/**
 * `query.search` (§23.1) → o que o painel desenha. A mensagem vem do FTS com o
 * trecho pronto; membro vira o `Member` do roster local (presença por ausência,
 * §6.1) para reusar o Avatar. `partial`/`partialReason` atravessam sem tradução —
 * as quatro causas são do fio, e a tela é quem as nomeia.
 */
export function resultadoDeBusca(
  dto: SearchResultDto,
): BuscaResults {
  return {
    messages: dto.messages.map((m) => ({
      id: m.id,
      channelId: m.channelId,
      channelName: m.channelName,
      authorId: m.authorKeyHex,
      content: m.content,
      snippet: m.snippet,
      timestamp: iso(m.authorTs),
    })),
    channels: dto.channels.map((c) => ({ id: c.id, name: c.name })),
    members: dto.members.map((m) => ({
      identityId: m.identityKeyHex,
      communityId: "",
      displayName: m.displayName,
      handle: m.nickname ?? m.displayName,
      avatarColor: "role-neutral" as const,
      roleIds: [],
      joinedAt: iso(0),
      presence: "offline" as const,
      banned: false,
      ...(m.nickname !== null ? { nickname: m.nickname } : {}),
    })),
    partial: dto.partial,
    ...(dto.partialReason !== undefined ? { partialReason: dto.partialReason } : {}),
  };
}
