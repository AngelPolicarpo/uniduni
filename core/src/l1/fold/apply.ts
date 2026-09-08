// Estágios 13, 14 e 15 de §8.2, por `kind`:
//
//   13 — limites de campo (§8.6)
//   14 — regras estruturais `R-*` (§8.3)
//   15 — emissão de efeitos (§8.4) e avanço do `DS`
//
// Devolve `null` quando o registro é `APPLIED`, ou uma `Rejection` com o código específico da
// regra. **Nunca lança** (§8.5): toda entrada possível mapeia para um dos três desfechos.

import { entityId, type EntityType } from '../idgen/index.ts';
import {
  KINDS,
  blake2b256,
  relayPossessionSigningHash,
  sequenceScopeKey,
  verifySignature,
  type PayloadOf,
} from '../opCodec/index.ts';
import type { Op } from '../opCodec/index.ts';
import type { ErrorCode } from '../errors/index.ts';
import {
  RANK_BOTTOM,
  RANK_TOP,
  baseRoleViolation,
  effectivePermissions,
  escalation,
  permissionFromNumber,
  permissionNumber,
  type Permission,
  type RoleLookup,
} from '../permissions/index.ts';
import {
  ATTACHMENT_MAX_BYTES,
  CHANNEL_TYPE,
  CLOCK_SKEW_MS,
  INVITE_EXPIRY_MAX_MS,
  INVITE_EXPIRY_MIN_MS,
  INVITE_MAX_USES_MAX,
  INVITE_MAX_USES_MIN,
  MAX_ACTIVE_INVITES,
  MAX_CATEGORIES,
  MAX_CHANNELS,
  MAX_MENTIONS,
  MAX_REACTION_EMOJIS,
  MAX_ROLES,
  MAX_ROLES_PER_MEMBER,
  MAX_SUCCESSORS,
  QUEUE_TURN_MAX_SECONDS,
  QUEUE_TURN_MIN_SECONDS,
  RELAY_TTL_MS,
  SPEECH_MODE,
  TIMEOUT_MAX_MS,
  TIMEOUT_MIN_MS,
  isAvatarColor,
  isRoleColor,
  isSpeechMode,
  isValidChannelType,
} from './constants.ts';
import { AUDIT, type AuditType, type Effect, type ModerationEntry, type Primitive } from './effects.ts';
import {
  casefold,
  checkCategoryName,
  checkChannelName,
  checkChannelTopic,
  checkCommunityDescription,
  checkCommunityName,
  checkDisplayName,
  checkIconEmoji,
  checkInviteLabel,
  checkMessageContent,
  checkModerationReason,
  checkNickname,
  checkReactionEmoji,
  checkRoleName,
  isValidAttachmentName,
  trimCollapseNFKC,
} from './limits.ts';
import { needsRenormalization, rankBetween, renormalize } from './rank.ts';
import { emptyRing, type Channel, type Draft, type Member, type Role } from './state.ts';
import { KIND_POLICY, type KindPolicy } from './policy.ts';
import type { KindName } from '../opCodec/index.ts';
import { extractLinks } from './links.ts';

export type Rejection = { readonly code: ErrorCode; readonly field?: string; readonly limit?: number };

export type KindCtx = {
  readonly seq: number;
  /** `hostTs` **efetivo** — já clampado por R-1. */
  readonly hostTs: number;
  readonly op: Op;
  readonly authorHex: string;
  readonly draft: Draft;
  /** R-27(a) — o principal de gênese está em vigor (`seq` 0..5, comunidade não `invalid`). */
  readonly inGenesis: boolean;
  readonly effects: Effect[];
  /** Permissão efetiva do autor; na gênese, as 17 de §9.1 (R-27a). */
  readonly eff: ReadonlySet<Permission>;
  /** `topRank` do autor; na gênese, `RANK_GENESIS` (R-27a). */
  readonly authorTop: string | null;
  readonly member: Member | undefined;
  readonly policy: KindPolicy;
};

const rj = (code: ErrorCode, field?: string, limit?: number): Rejection => {
  const r: { code: ErrorCode; field?: string; limit?: number } = { code };
  if (field !== undefined) r.field = field;
  if (limit !== undefined) r.limit = limit;
  return r;
};

const VAL = (field: string): Rejection => rj('E_VALIDATION', field);

// ─── Utilitários sobre o `DS` ───────────────────────────────────────────────────────────

function newId(ctx: KindCtx, t: EntityType): string {
  return entityId(t, ctx.op.communityId, ctx.op.author, ctx.op.authorSeq, sequenceScopeKey(ctx.op.sequenceScope));
}

/** §6.13 — rótulo congelado no momento da aplicação. */
function labelOf(ctx: KindCtx, keyHex: string): string {
  const m = ctx.draft.state.members.get(keyHex);
  return m === undefined ? keyHex.slice(0, 8) : (m.nickname ?? m.displayName);
}

function roleLookup(ctx: KindCtx): RoleLookup {
  return (id) => {
    const r = ctx.draft.state.roles.get(id);
    if (r === undefined || r.deletedAt !== undefined) return undefined;
    const perms: Permission[] = [];
    for (const n of r.permissions) {
      const p = permissionFromNumber(n);
      if (p !== null) perms.push(p);
    }
    return { id, rank: r.rank, permissions: perms, isFounder: r.isFounder, isDefault: r.isDefault };
  };
}

function effOf(ctx: KindCtx, roleIds: Iterable<string>): ReadonlySet<Permission> {
  return effectivePermissions([...roleIds], roleLookup(ctx));
}

/**
 * §6.13 + §7.4 coluna `Aud.`, com R-27(d): **a gênese não emite auditoria**. §6.13 exige
 * `byLabel` congelado, e nos `seq` 1, 2, 4 e 5 o autor ainda não é membro — o `member.join`
 * dele é o `seq` 3 —, então o log de auditoria de toda comunidade nasceria com quatro
 * entradas cujo `byLabel` é um fragmento de chave em hexadecimal.
 */
function audit(
  ctx: KindCtx,
  type: AuditType,
  targetId: string | null,
  targetLabel: string | null,
  reason: string | null,
): void {
  if (ctx.inGenesis) return;
  const entry: ModerationEntry = {
    id: newId(ctx, 'modentry'),
    seq: ctx.seq,
    type,
    targetId,
    targetLabel,
    byKey: ctx.op.author,
    byLabel: labelOf(ctx, ctx.authorHex),
    reason,
    at: ctx.hostTs,
  };
  ctx.effects.push({ t: 'audit', entry });
  ctx.effects.push({
    t: 'upsert',
    table: 'moderation_log',
    key: [entry.id],
    row: {
      id: entry.id,
      seq: entry.seq,
      type: entry.type,
      target_id: entry.targetId,
      target_label: entry.targetLabel,
      by_key: entry.byKey,
      by_label: entry.byLabel,
      reason: entry.reason,
      at: entry.at,
    },
  });
  ctx.effects.push({
    t: 'notify',
    topic: 'auditLog.changed',
    data: { fromSeq: ctx.seq, toSeq: ctx.seq },
  });
}

const nameKey = (type: number, name: string): string => `${type}:${name}`;

function countActive<T extends { deletedAt?: number }>(m: ReadonlyMap<string, T>): number {
  let n = 0;
  for (const v of m.values()) if (v.deletedAt === undefined) n++;
  return n;
}

function baseRoleId(ctx: KindCtx): string | null {
  for (const [id, r] of ctx.draft.state.roles) {
    if (r.isDefault && r.deletedAt === undefined) return id;
  }
  return null;
}

function founderRoleId(ctx: KindCtx): string | null {
  for (const [id, r] of ctx.draft.state.roles) {
    if (r.isFounder && r.deletedAt === undefined) return id;
  }
  return null;
}

function activeRoleRanks(ctx: KindCtx): string[] {
  const out: string[] = [];
  for (const r of ctx.draft.state.roles.values()) if (r.deletedAt === undefined) out.push(r.rank);
  return out;
}

function permsFrom(nums: readonly number[]): Permission[] | null {
  const out: Permission[] = [];
  for (const n of nums) {
    const p = permissionFromNumber(n);
    // §9.1: `u8` fora de `0..16` é `E_VALIDATION.permissions`, nunca ignorado em silêncio.
    if (p === null) return null;
    out.push(p);
  }
  return out;
}

const jsonPerms = (perms: ReadonlySet<number>): string =>
  JSON.stringify([...perms].sort((a, b) => a - b));

const jsonIds = (ids: ReadonlySet<string>): string => JSON.stringify([...ids].sort());

// ─── Renormalização de escopo (§6.4.1, fecha `HOLE-15`) ─────────────────────────────────

type Escopo = 'roles' | 'categories' | 'channels';

/**
 * O `midpoint` estourou `RANK_MAX_LEN`. §6.4.1 manda **não recusar a op**: o escopo inteiro
 * é reespaçado preservando a ordem corrente, e o item novo entra na posição pedida.
 *
 * Função pura da lista ordenada, então toda réplica produz exatamente os mesmos `rank`.
 * §8.4 é explícito em que isto emite **um `patch` por item** e não usa `patchScope`: cada
 * item recebe um valor *diferente*, e uma forma em lote só transporta o mesmo valor para
 * todas as linhas. É aceitável porque o escopo é limitado por §27.1 (≤ 500).
 *
 * Devolve o `rank` do item novo, ou `null` quando o escopo excede o alcance da função.
 */
function renormalizeScope(
  ctx: KindCtx,
  table: Escopo,
  entries: readonly { id: string; rank: string }[],
  overflowRank: string,
): string | null {
  const ordenado = [...entries].sort((a, b) =>
    a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : 1,
  );
  let insertAt = ordenado.findIndex((e) => e.rank > overflowRank);
  if (insertAt < 0) insertAt = ordenado.length;

  const novos = renormalize(ordenado.length + 1);
  if (novos.length === 0) return null;

  let cursor = 0;
  for (let i = 0; i < novos.length; i++) {
    if (i === insertAt) continue; // reservado para o item novo
    const e = ordenado[cursor++];
    const rank = novos[i];
    if (e === undefined || rank === undefined || e.rank === rank) continue;
    if (table === 'roles') {
      const r = ctx.draft.mutRole(e.id);
      if (r !== undefined) r.rank = rank;
    } else if (table === 'categories') {
      const c = ctx.draft.mutCategory(e.id);
      if (c !== undefined) c.rank = rank;
    } else {
      const c = ctx.draft.mutChannel(e.id);
      if (c !== undefined) c.rank = rank;
    }
    ctx.effects.push({ t: 'patch', table, key: [e.id], fields: { rank } });
  }
  return novos[insertAt] ?? null;
}

/**
 * R-20 com renormalização: o `rank` final de um item novo ou movido.
 *
 * `escopo` é a vizinhança que alimenta o `midpoint`; `renormalizavel` é o que a renormalização
 * pode **reescrever**. Nos cargos os dois diferem, e é isso que mantém a invariante de §6.4.1
 * — ver `roleScopeRenormalizavel`.
 */
function rankFor(
  ctx: KindCtx,
  table: Escopo,
  escopo: readonly { id: string; rank: string }[],
  after: string | undefined,
  before: string | undefined,
  renormalizavel: readonly { id: string; rank: string }[] = escopo,
): string | null {
  const rank = rankBetween(
    escopo.map((e) => e.rank),
    after,
    before,
  );
  if (!needsRenormalization(rank)) return rank;
  return renormalizeScope(ctx, table, renormalizavel, rank);
}

// ─── R-10, R-7 e outros efeitos compartilhados ──────────────────────────────────────────

/**
 * R-10 — ban, kick, saída ou perda de `create_invite` revogam **todos** os convites que o
 * membro criou, **no mesmo registro**. Fecha `T-23`.
 */
function revokeInvitesOf(ctx: KindCtx, ownerHex: string): void {
  let algum = false;
  for (const [pk, i] of [...ctx.draft.state.invites]) {
    if (i.revokedAt !== undefined) continue;
    if (i.createdBy.toString('hex') !== ownerHex) continue;
    ctx.draft.invites().set(pk, { ...i, revokedAt: ctx.hostTs });
    ctx.effects.push({
      t: 'patch',
      table: 'invites',
      key: [Buffer.from(pk, 'hex')],
      fields: { revoked_at: ctx.hostTs },
    });
    algum = true;
  }
  if (algum) ctx.effects.push({ t: 'notify', topic: 'invites.changed', data: {} });
}

/** Reavalia R-10 depois de o conjunto de cargos de alguém mudar. */
function r10OnRoleChange(ctx: KindCtx, memberHex: string, antes: ReadonlySet<Permission>): void {
  const m = ctx.draft.state.members.get(memberHex);
  if (m === undefined) return;
  const depois = effOf(ctx, m.roleIds);
  if (antes.has('create_invite') && !depois.has('create_invite')) revokeInvitesOf(ctx, memberHex);
}

function setMemberRoles(ctx: KindCtx, memberHex: string, roleIds: Set<string>): void {
  const m = ctx.draft.mutMember(memberHex);
  if (m === undefined) return;
  const antes = effOf(ctx, m.roleIds);
  const anteriores = new Set(m.roleIds);
  m.roleIds = roleIds;
  const chave = Buffer.from(memberHex, 'hex');
  for (const rid of anteriores) {
    if (roleIds.has(rid)) continue;
    ctx.effects.push({ t: 'delete', table: 'member_roles', key: [chave, rid] });
    ctx.effects.push({ t: 'recount', what: 'roleMemberCount', key: [rid] });
  }
  for (const rid of roleIds) {
    if (anteriores.has(rid)) continue;
    ctx.effects.push({
      t: 'upsert',
      table: 'member_roles',
      key: [chave, rid],
      row: { identity_key: chave, role_id: rid },
    });
    ctx.effects.push({ t: 'recount', what: 'roleMemberCount', key: [rid] });
  }
  r10OnRoleChange(ctx, memberHex, antes);
  ctx.effects.push({ t: 'notify', topic: 'members.changed', data: { identityKeys: [memberHex] } });
}

/** R-7 — a comunidade nunca fica sem canal de texto não deletado. */
function textChannelsLeftAfter(ctx: KindCtx, removendo: ReadonlySet<string>): number {
  let n = 0;
  for (const [id, c] of ctx.draft.state.channels) {
    if (c.deletedAt !== undefined || c.type !== CHANNEL_TYPE.text || removendo.has(id)) continue;
    n++;
  }
  return n;
}

/** §8.4.1 — canal tombstonado depois das mensagens: elas ficam `orphaned`, não são apagadas. */
function orphanChannelMessages(ctx: KindCtx, channelId: string): void {
  let algum = false;
  const threads = new Set<string>();
  for (const [id, msg] of ctx.draft.state.messages) {
    if (msg.channelId !== channelId || msg.orphaned) continue;
    const m = ctx.draft.mutMessage(id);
    if (m === undefined) continue;
    m.orphaned = true;
    if (m.threadId !== undefined) threads.add(m.threadId);
    algum = true;
  }
  if (!algum) return;
  // §8.4 `patchScope` (fecha `HOLE-12`): dois efeitos no lugar de 2N. O `DS` continua sendo
  // atualizado mensagem a mensagem — ele é a fonte da decisão —, mas o delta que viaja até
  // `view.db` deixa de ser uma lista de N linhas.
  const scope = { s: 'messagesOfChannel', channelId } as const;
  ctx.effects.push({ t: 'patchScope', scope, fields: { orphaned: 1 } });
  ctx.effects.push({ t: 'ftsRemoveScope', scope });
  // §8.4 — a população de `threadReplyCount` exclui `orphaned = 1`, e o `patchScope` não
  // enumera linhas: o recount de cada thread alcançada sai aqui, **depois** do `patchScope`,
  // porque o projector o calcula lendo `messages.orphaned` já corrigido. Ordem estável.
  for (const t of [...threads].sort()) {
    ctx.effects.push({ t: 'recount', what: 'threadReplyCount', key: [t] });
  }
}

function tombstoneChannel(ctx: KindCtx, channelId: string): void {
  const ch = ctx.draft.mutChannel(channelId);
  if (ch === undefined || ch.deletedAt !== undefined) return;
  ch.deletedAt = ctx.hostTs;
  ctx.draft.channelNameIndex().delete(nameKey(ch.type, ch.name));
  ctx.effects.push({
    t: 'patch',
    table: 'channels',
    key: [channelId],
    fields: { deleted_at: ctx.hostTs },
  });
  orphanChannelMessages(ctx, channelId);
}

/**
 * §8.4 — quando um membro entra ou sai da população ativa (`left_at IS NULL AND banned = 0`),
 * **os dois** contadores derivados dela mudam: `memberCount` da comunidade e `roleMemberCount`
 * de cada cargo que ele carrega. A tabela de §8.4 diz que `roleMemberCount` conta "os **mesmos**
 * membros, restritos aos que têm o cargo em `member_roles`" — emitir só o primeiro deixava
 * `roles.member_count` contando quem saiu, foi expulso ou foi banido.
 *
 * Emitir **depois** do `patch` que mexe em `left_at`/`banned`: o projector calcula os dois
 * lendo as tabelas de `CS` já atualizadas, na mesma transação do lote (§10.5 passo 4).
 */
function recontarPopulacaoAtiva(ctx: KindCtx, memberHex: string): void {
  ctx.effects.push({ t: 'recount', what: 'memberCount', key: [ctx.draft.state.communityId] });
  const m = ctx.draft.state.members.get(memberHex);
  if (m === undefined) return;
  for (const rid of [...m.roleIds].sort()) {
    ctx.effects.push({ t: 'recount', what: 'roleMemberCount', key: [rid] });
  }
}

/** Comum a `mod.kick` e `member.leave`: o membro vai para `left` (§6.3). */
function leaveCommunity(ctx: KindCtx, targetHex: string): void {
  const m = ctx.draft.mutMember(targetHex);
  if (m === undefined) return;
  m.state = 'left';
  m.leftAt = ctx.hostTs;
  ctx.effects.push({
    t: 'patch',
    table: 'members',
    key: [Buffer.from(targetHex, 'hex')],
    fields: { left_at: ctx.hostTs },
  });
  revokeInvitesOf(ctx, targetHex); // R-10
  recontarPopulacaoAtiva(ctx, targetHex);
  ctx.effects.push({ t: 'notify', topic: 'members.changed', data: { identityKeys: [targetHex] } });
  recalcularColisoesDeNome(ctx); // L-5 — a saída pode descolar nomes idênticos
}

const structureChanged = (ctx: KindCtx): void => {
  ctx.effects.push({ t: 'notify', topic: 'structure.changed', data: {} });
};

/**
 * §6.1 L-5 — a marca `displayNameCollision` é derivada do CONJUNTO ATIVO: todo membro ativo
 * cujo nome normalizado (NFKC + casefold + colapso de espaço) coincida com o de outro
 * membro ativo leva a marca, e quem sai/banido/volta perde ou ganha conforme o conjunto.
 * O recálculo é inteiro e determinístico — O(membros) por op afetada, barato no teto do v1 —
 * e escreve só via `draft.mutMember`, para não furar o compartilhamento estrutural do DS.
 */
function normalizarParaColisao(nome: string): string {
  return casefold(trimCollapseNFKC(nome));
}

function recalcularColisoesDeNome(ctx: KindCtx): void {
  const draft = ctx.draft;
  const contagem = new Map<string, number>();
  for (const m of draft.state.members.values()) {
    if (m.state !== 'active') continue;
    const n = normalizarParaColisao(m.displayName);
    contagem.set(n, (contagem.get(n) ?? 0) + 1);
  }
  // A varredura cobre **todos** os membros, não só os ativos: quem sai ou é banido deixa o
  // conjunto ativo e precisa **perder** a marca. Antes o `continue` no não-ativo congelava a
  // marca de quem saiu, e ela reaparecia na leitura como se ele ainda colidisse com alguém.
  for (const [hex, m] of [...draft.state.members]) {
    const colide =
      m.state === 'active' && (contagem.get(normalizarParaColisao(m.displayName)) ?? 0) > 1;
    if ((m.displayNameCollision === true) === colide) continue;
    const alvo = draft.mutMember(hex);
    if (alvo === undefined) continue;
    if (colide) alvo.displayNameCollision = true;
    else delete alvo.displayNameCollision;
    // §10.3 declara `members.display_name_collision`, e §8.4 não tinha efeito que a escrevesse:
    // a coluna nascia 0 e ficava 0 para sempre, com a marca de L-5 existindo só em memória.
    ctx.effects.push({
      t: 'patch',
      table: 'members',
      key: [Buffer.from(hex, 'hex')],
      fields: { display_name_collision: colide ? 1 : 0 },
    });
  }
}

const rolesChanged = (ctx: KindCtx, roleIds: string[]): void => {
  ctx.effects.push({ t: 'notify', topic: 'roles.changed', data: { roleIds } });
};

// ─── Dispatch ───────────────────────────────────────────────────────────────────────────

type Handler<K extends KindName> = (ctx: KindCtx, p: PayloadOf<K>) => Rejection | null;
type Handlers = { readonly [K in KindName]: Handler<K> };

export function applyKind(ctx: KindCtx, payload: unknown): Rejection | null {
  const nome = NOME_POR_NUMERO.get(ctx.op.kind);
  // §9.4 — falha fechado. O estágio 2 já teria recusado, então isto é defesa em profundidade.
  if (nome === undefined) return rj('E_UNKNOWN_KIND');
  const h = HANDLERS[nome] as (c: KindCtx, p: unknown) => Rejection | null;
  return h(ctx, payload);
}

// ─── §7.4.1 Mensagem ────────────────────────────────────────────────────────────────────

const messageSend: Handler<'message.send'> = (ctx, p) => {
  // 13 — limites de campo
  const content = checkMessageContent(p.content);
  if (!content.ok) return VAL(content.field);
  const mentions = [...new Set(p.mentions)]; // §8.6: ids duplicados colapsam
  if (mentions.length > MAX_MENTIONS) return VAL('mentions');
  if (p.attachment !== undefined) {
    const a = p.attachment;
    if (a.sizeBytes < 1 || a.sizeBytes > ATTACHMENT_MAX_BYTES) return rj('E_ATTACHMENT_TOO_LARGE');
    if (!isValidAttachmentName(a.name)) return VAL('name');
  }

  // 14 — regras estruturais
  const ch = ctx.draft.state.channels.get(p.channelId);
  // §8.4.1: canal desconhecido ou deletado é `REJECTED` aqui — nunca chega ao efeito.
  if (ch === undefined || ch.deletedAt !== undefined) return rj('E_CHANNEL_NOT_FOUND');
  if (ch.type !== CHANNEL_TYPE.text) return rj('E_CHANNEL_NOT_FOUND'); // §6.7: canal de texto

  // R-22 — recusa quando **todos** os cargos do autor estão em `readOnlyForRoleIds`.
  if (ch.readOnlyForRoleIds.size > 0 && ctx.member !== undefined) {
    let algumDeFora = false;
    for (const rid of ctx.member.roleIds) {
      const r = ctx.draft.state.roles.get(rid);
      if (r === undefined || r.deletedAt !== undefined) continue;
      if (!ch.readOnlyForRoleIds.has(rid)) {
        algumDeFora = true;
        break;
      }
    }
    if (!algumDeFora) return rj('E_CHANNEL_READ_ONLY');
  }

  // R-8 — `replyToId`/`threadId` existem, não deletados, do **mesmo canal**.
  if (p.replyToId !== undefined) {
    const m = ctx.draft.state.messages.get(p.replyToId);
    if (m === undefined || m.deletedAt !== undefined || m.channelId !== p.channelId) {
      return VAL('replyToId');
    }
  }
  if (p.threadId !== undefined) {
    const raiz = ctx.draft.state.rootOfThread.get(p.threadId);
    const m = raiz === undefined ? undefined : ctx.draft.state.messages.get(raiz);
    if (m === undefined || m.deletedAt !== undefined || m.channelId !== p.channelId) {
      return VAL('threadId');
    }
  }

  // 15 — não há cota de anexo a decidir (R-14 saiu em `opVersion = 3`, §13.8); o acumulado
  // de `storageUsedBytes` continua, agora como medidor de uso do membro.
  const id = newId(ctx, 'message');
  if (ctx.draft.state.messages.has(id)) return rj('E_ID_COLLISION');
  const anexoBytes = p.attachment !== undefined ? p.attachment.sizeBytes : 0;
  // R-13 — `everyone` só vira efetivo com `mention_everyone` **no momento do registro**.
  // Sem a permissão a mensagem é `APPLIED` com a flag em `false`; o conteúdo não muda.
  const mentionEveryone = mentions.includes('everyone') && ctx.eff.has('mention_everyone');
  const clockSkewed = Math.abs(ctx.op.ts - ctx.hostTs) > CLOCK_SKEW_MS; // §6.7

  const meta = {
    channelId: p.channelId,
    authorKey: ctx.authorHex,
    pinned: false,
    hasAttachment: p.attachment !== undefined,
    attachmentBytes: anexoBytes,
    reactions: new Map<string, Set<string>>(),
    hiddenByBan: false,
    orphaned: false,
    ...(p.threadId !== undefined ? { threadId: p.threadId } : {}),
  };
  ctx.draft.messages().set(id, meta);

  if (anexoBytes > 0) {
    const m = ctx.draft.mutMember(ctx.authorHex);
    if (m !== undefined) m.storageUsedBytes += anexoBytes;
  }

  ctx.effects.push({
    t: 'upsert',
    table: 'messages',
    key: [id],
    row: {
      id,
      seq: ctx.seq,
      channel_id: p.channelId,
      author_key: ctx.op.author,
      content: content.value,
      author_ts: ctx.op.ts,
      host_ts: ctx.hostTs,
      clock_skewed: clockSkewed ? 1 : 0,
      edited_at: null,
      pinned: 0,
      reply_to_id: p.replyToId ?? null,
      thread_id: p.threadId ?? null,
      mentions: JSON.stringify(mentions),
      mention_everyone_effective: mentionEveryone ? 1 : 0,
      deleted_at: null,
      hidden_by_ban: 0,
      orphaned: 0,
    },
  });
  ctx.effects.push({ t: 'ftsIndex', messageId: id, content: content.value });
  // §15.6.1 (DR-38) — os links são derivados do conteúdo pelo `fold`, na mesma transação.
  for (const [idx, link] of extractLinks(content.value).entries()) {
    ctx.effects.push({
      t: 'upsert',
      table: 'message_links',
      key: [id, idx],
      row: { message_id: id, idx, url: link.url, host: link.host, seq: ctx.seq },
    });
  }
  if (p.attachment !== undefined) {
    const a = p.attachment;
    ctx.effects.push({
      t: 'upsert',
      table: 'attachments',
      key: [id],
      row: {
        message_id: id,
        owner_key: ctx.op.author,
        blobs_core_key: a.blob.blobsCoreKey,
        blob_id: JSON.stringify({
          byteOffset: a.blob.byteOffset,
          blockOffset: a.blob.blockOffset,
          blockLength: a.blob.blockLength,
          byteLength: a.blob.byteLength,
        }),
        name: a.name,
        size_bytes: a.sizeBytes,
        kind: a.kind,
        hash: a.hash,
      },
    });
    ctx.effects.push({
      t: 'patch',
      table: 'members',
      key: [ctx.op.author],
      fields: { storage_used_bytes: ctx.draft.state.members.get(ctx.authorHex)?.storageUsedBytes ?? 0 },
    });
  }
  if (p.threadId !== undefined) {
    ctx.effects.push({ t: 'recount', what: 'threadReplyCount', key: [p.threadId] });
  }
  ctx.effects.push({
    t: 'notify',
    topic: 'messages.appended',
    data: {
      channelId: p.channelId,
      fromSeq: ctx.seq,
      toSeq: ctx.seq,
      hasMention: mentions.length > 0,
    },
  });
  return null;
};

const messageEdit: Handler<'message.edit'> = (ctx, p) => {
  const content = checkMessageContent(p.content);
  if (!content.ok) return VAL(content.field);

  const msg = ctx.draft.state.messages.get(p.messageId);
  if (msg === undefined) return rj('E_NOT_FOUND');
  if (msg.deletedAt !== undefined) return rj('E_MESSAGE_DELETED');
  // §6.7 e §19.10: editar só a própria — moderação apaga, não reescreve.
  if (msg.authorKey !== ctx.authorHex) return rj('E_CANNOT_EDIT_OTHERS');

  ctx.draft.touch();
  ctx.effects.push({
    t: 'patch',
    table: 'messages',
    key: [p.messageId],
    fields: { content: content.value, edited_at: ctx.hostTs },
  });
  // §10.3: a FTS não usa trigger; o `fold` reindexa explicitamente, na mesma transação — e
  // **remove antes**. Inserir o mesmo `rowid` de novo numa FTS5 contentless SOMA termos em vez
  // de substituir: sem o `ftsRemove`, o conteúdo antigo continuava casando na busca e a
  // mensagem aparecia por texto que ela não contém mais. A remoção é idempotente (§10.3).
  ctx.effects.push({ t: 'ftsRemove', messageId: p.messageId });
  if (!msg.orphaned) {
    ctx.effects.push({ t: 'ftsIndex', messageId: p.messageId, content: content.value });
  }
  // O conteúdo mudou: os links do conteúdo ANTIGO deixam de existir (§15.6.1).
  ctx.effects.push({ t: 'delete', table: 'message_links', key: [p.messageId] });
  for (const [idx, link] of extractLinks(content.value).entries()) {
    ctx.effects.push({
      t: 'upsert',
      table: 'message_links',
      key: [p.messageId, idx],
      row: { message_id: p.messageId, idx, url: link.url, host: link.host, seq: ctx.seq },
    });
  }
  ctx.effects.push({
    t: 'notify',
    topic: 'message.updated',
    data: { messageId: p.messageId, channelId: msg.channelId, fields: ['content'] },
  });
  return null;
};

const messageDelete: Handler<'message.delete'> = (ctx, p) => {
  const reason = checkModerationReason(p.reason);
  if (!reason.ok) return VAL(reason.field);

  const msg = ctx.draft.state.messages.get(p.messageId);
  if (msg === undefined) return rj('E_NOT_FOUND');
  // §8.4.1: já deletada ⇒ `APPLIED` idempotente, sem efeito e **sem auditoria**.
  if (msg.deletedAt !== undefined) {
    ctx.draft.touch();
    return null;
  }

  const deOutro = msg.authorKey !== ctx.authorHex;
  const m = ctx.draft.mutMessage(p.messageId);
  if (m === undefined) return rj('E_NOT_FOUND');
  m.deletedAt = ctx.hostTs;
  m.reactions = new Map();
  // Pela mesma razão que `reactions`: o `projector` rematerializa estes dois das linhas
  // **vivas** de `attachments` ao hidratar snapshot (§8.1), e o efeito abaixo apaga a linha.
  // Deixá-los de pé aqui faria o estado depender de ter havido snapshot.
  m.hasAttachment = false;
  m.attachmentBytes = 0;
  ctx.effects.push({
    t: 'patch',
    table: 'messages',
    key: [p.messageId],
    // §10.3: `content` é `NULL` quando tombstonada (fecha `DR-17`).
    fields: { content: null, deleted_at: ctx.hostTs, pinned: 0 },
  });
  ctx.effects.push({ t: 'ftsRemove', messageId: p.messageId });
  // §6.9: mensagem deletada ⇒ reações somem na mesma transação, sem estado zumbi.
  ctx.effects.push({ t: 'delete', table: 'reactions', key: [p.messageId] });
  // O conteúdo virou `NULL`: os links dele não sobrevivem ao tombstone (§15.6.1).
  ctx.effects.push({ t: 'delete', table: 'message_links', key: [p.messageId] });
  // Nem o anexo. Nome, tamanho, tipo e `hash` são conteúdo tanto quanto o texto, e
  // `query.message` os devolvia inteiros depois da deleção. É também o que faz a regra 2 de
  // §13.7 ser verdade: o GC de §22.4 só solta os blocos do autor quando a mensagem deixa de
  // referenciá-los, e a referência que ele consulta é esta linha. `member.storageUsedBytes`
  // não muda — ele é acumulador do `fold` (§13.8), não soma desta tabela.
  ctx.effects.push({ t: 'delete', table: 'attachments', key: [p.messageId] });
  // §6.8 e §8.4 — a thread reage à deleção. A raiz não some (as respostas continuam), mas a
  // thread deixa de ser alcançável: "o `fold` marca `rootDeleted = true`". Uma **resposta**
  // deletada sai da população de `threadReplyCount`, que exclui `deleted_at IS NOT NULL`.
  const threadId = msg.threadId;
  if (threadId !== undefined) {
    if (ctx.draft.state.rootOfThread.get(threadId) === p.messageId) {
      ctx.effects.push({
        t: 'patch',
        table: 'threads',
        key: [threadId],
        fields: { root_deleted: 1 },
      });
    } else {
      ctx.effects.push({ t: 'recount', what: 'threadReplyCount', key: [threadId] });
    }
  }
  ctx.effects.push({
    t: 'notify',
    topic: 'message.updated',
    data: { messageId: p.messageId, channelId: msg.channelId, fields: ['deletedAt'] },
  });
  if (deOutro) {
    audit(ctx, AUDIT.deleteMessage, p.messageId, labelOf(ctx, msg.authorKey), reason.value || null);
  }
  return null;
};

const messagePin: Handler<'message.pin'> = (ctx, p) => {
  const msg = ctx.draft.state.messages.get(p.messageId);
  if (msg === undefined) return rj('E_NOT_FOUND');
  if (msg.deletedAt !== undefined) return rj('E_MESSAGE_DELETED');
  if (msg.pinned === p.pinned) {
    ctx.draft.touch(); // idempotente
    return null;
  }
  const m = ctx.draft.mutMessage(p.messageId);
  if (m === undefined) return rj('E_NOT_FOUND');
  m.pinned = p.pinned;
  ctx.effects.push({
    t: 'patch',
    table: 'messages',
    key: [p.messageId],
    fields: { pinned: p.pinned ? 1 : 0 },
  });
  ctx.effects.push({
    t: 'notify',
    topic: 'message.updated',
    data: { messageId: p.messageId, channelId: msg.channelId, fields: ['pinned'] },
  });
  return null;
};

const reactionSet: Handler<'reaction.set'> = (ctx, p) => {
  const emoji = checkReactionEmoji(p.emoji);
  if (!emoji.ok) return VAL(emoji.field);

  const msg = ctx.draft.state.messages.get(p.messageId);
  if (msg === undefined) return rj('E_NOT_FOUND');
  if (msg.deletedAt !== undefined) return rj('E_MESSAGE_DELETED'); // §8.4.1

  if (p.present) {
    // R-23 — máx. 20 emojis **com reagente** por mensagem. `present:false` nunca é recusada.
    if (!msg.reactions.has(emoji.value) && msg.reactions.size >= MAX_REACTION_EMOJIS) {
      return rj('E_REACTION_LIMIT');
    }
    const m = ctx.draft.mutMessage(p.messageId);
    if (m === undefined) return rj('E_NOT_FOUND');
    let reagentes = m.reactions.get(emoji.value);
    if (reagentes === undefined) {
      reagentes = new Set<string>();
      m.reactions.set(emoji.value, reagentes);
    }
    reagentes.add(ctx.authorHex); // §6.9 — 1 reação por pessoa por emoji
    ctx.effects.push({
      t: 'upsert',
      table: 'reactions',
      key: [p.messageId, emoji.value, ctx.op.author],
      row: {
        message_id: p.messageId,
        emoji: emoji.value,
        identity_key: ctx.op.author,
        at: ctx.hostTs,
      },
    });
  } else {
    const m = ctx.draft.mutMessage(p.messageId);
    if (m === undefined) return rj('E_NOT_FOUND');
    const reagentes = m.reactions.get(emoji.value);
    if (reagentes !== undefined) {
      reagentes.delete(ctx.authorHex);
      // §6.9 — o emoji existe enquanto tiver reagente; a última remoção libera a vaga de R-23.
      // É esta linha que faz o `DS` do `fold` casar com o que o `projector` rematerializa das
      // linhas vivas de `reactions` (§8.1, regra de residência).
      if (reagentes.size === 0) m.reactions.delete(emoji.value);
    }
    ctx.draft.touch();
    ctx.effects.push({
      t: 'delete',
      table: 'reactions',
      key: [p.messageId, emoji.value, ctx.op.author],
    });
  }
  ctx.effects.push({
    t: 'notify',
    topic: 'message.updated',
    data: { messageId: p.messageId, channelId: msg.channelId, fields: ['reactions'] },
  });
  return null;
};

const threadCreate: Handler<'thread.create'> = (ctx, p) => {
  const raiz = ctx.draft.state.messages.get(p.rootMessageId);
  if (raiz === undefined) return rj('E_NOT_FOUND');
  if (raiz.deletedAt !== undefined) return rj('E_MESSAGE_DELETED'); // §8.4.1
  // R-24 — uma thread por mensagem raiz. A raiz carrega o `threadId` da sua própria thread,
  // que é o que torna a regra O(1) sem um segundo índice.
  if (raiz.threadId !== undefined) return rj('E_THREAD_EXISTS');

  const id = newId(ctx, 'thread');
  if (ctx.draft.state.rootOfThread.has(id)) return rj('E_ID_COLLISION');

  const m = ctx.draft.mutMessage(p.rootMessageId);
  if (m === undefined) return rj('E_NOT_FOUND');
  m.threadId = id;
  ctx.draft.rootOfThread().set(id, p.rootMessageId);

  // A raiz carrega o `threadId` (R-24) — e isso precisa chegar à VIEW: sem este
  // patch, `query.messages` devolve `threadId` ausente para sempre e nenhuma
  // réplica consegue ancorar a thread pela própria mensagem raiz.
  ctx.effects.push({
    t: 'patch',
    table: 'messages',
    key: [p.rootMessageId],
    fields: { thread_id: id },
  });
  ctx.effects.push({
    t: 'upsert',
    table: 'threads',
    key: [id],
    row: {
      id,
      root_message_id: p.rootMessageId,
      channel_id: raiz.channelId,
      reply_count: 0,
      root_deleted: 0,
    },
  });
  ctx.effects.push({
    t: 'notify',
    topic: 'message.updated',
    data: { messageId: p.rootMessageId, channelId: raiz.channelId, fields: ['threadId'] },
  });
  return null;
};

// ─── §7.4.2 Estrutura ───────────────────────────────────────────────────────────────────

/** R-21 — todos os ids existem **e** ≥ 1 cargo não deletado fica de fora. */
function checkReadOnly(ctx: KindCtx, ids: readonly string[]): Set<string> | null {
  const set = new Set<string>();
  for (const rid of ids) {
    const r = ctx.draft.state.roles.get(rid);
    if (r === undefined || r.deletedAt !== undefined) return null;
    set.add(rid);
  }
  let deFora = 0;
  for (const [rid, r] of ctx.draft.state.roles) {
    if (r.deletedAt === undefined && !set.has(rid)) deFora++;
  }
  return deFora < 1 ? null : set;
}

/**
 * R-29 — modo de fala (§6.6). `tipo` é o do payload na criação e o do canal no update;
 * `modoCorrente` é o modo que o canal tem antes do registro (na criação, `free`). Devolve
 * o `field` de `E_VALIDATION`, ou `null` quando o registro é aceito.
 */
function checkSpeechMode(
  tipo: number,
  speechMode: number | undefined,
  queueTurnSeconds: number | undefined,
  modoCorrente: number,
): 'speechMode' | 'queueTurnSeconds' | null {
  if (speechMode !== undefined) {
    if (!isSpeechMode(speechMode)) return 'speechMode';
    if (tipo !== CHANNEL_TYPE.voice) return 'speechMode'; // §6.6: só existe em canal de voz
  }
  if (queueTurnSeconds !== undefined) {
    const inteiro =
      Number.isInteger(queueTurnSeconds) &&
      queueTurnSeconds >= QUEUE_TURN_MIN_SECONDS &&
      queueTurnSeconds <= QUEUE_TURN_MAX_SECONDS;
    if (!inteiro) return 'queueTurnSeconds';
    // Só pode estar presente num registro que DEIXA o canal em modo fila (§6.6, R-29).
    if ((speechMode ?? modoCorrente) !== SPEECH_MODE.queue) return 'queueTurnSeconds';
  }
  return null;
}

function channelScope(ctx: KindCtx, categoryId: string): { id: string; rank: string }[] {
  const out: { id: string; rank: string }[] = [];
  for (const [id, ch] of ctx.draft.state.channels) {
    if (ch.deletedAt === undefined && ch.categoryId === categoryId) out.push({ id, rank: ch.rank });
  }
  return out;
}

const channelCreate: Handler<'channel.create'> = (ctx, p) => {
  // 13
  if (!isValidChannelType(p.type)) return VAL('type');
  const nm = checkChannelName(p.name, p.type);
  if (!nm.ok) return nm.empty ? rj('E_CHANNEL_NAME_EMPTY') : VAL('name');
  if (p.topic !== undefined && p.type !== CHANNEL_TYPE.text) return VAL('topic'); // §8.6: só texto
  const tp = checkChannelTopic(p.topic);
  if (!tp.ok) return VAL(tp.field);
  // R-29 — o modo que o canal FICA é o do payload, ou `free` (§6.6)
  const sm = checkSpeechMode(p.type, p.speechMode, p.queueTurnSeconds, SPEECH_MODE.free);
  if (sm !== null) return VAL(sm);

  // 14
  const cat = ctx.draft.state.categories.get(p.categoryId);
  if (cat === undefined || cat.deletedAt !== undefined) return rj('E_CATEGORY_NOT_FOUND');
  // R-26
  if (countActive(ctx.draft.state.channels) >= MAX_CHANNELS) {
    return rj('E_LIMIT_EXCEEDED', undefined, MAX_CHANNELS);
  }
  // R-6 — o primeiro `APPLIED` fica com o nome; o segundo é `REJECTED`.
  if (ctx.draft.state.channelNameIndex.has(nameKey(p.type, nm.value))) {
    return rj('E_CHANNEL_NAME_TAKEN');
  }
  const ro = checkReadOnly(ctx, p.readOnlyForRoleIds);
  if (ro === null) return VAL('readOnlyForRoleIds');

  // 15 — R-20
  const rank = rankFor(ctx, 'channels', channelScope(ctx, p.categoryId), p.afterRank, p.beforeRank);
  if (rank === null) return rj('E_LIMIT_EXCEEDED', undefined, MAX_CHANNELS);

  const id = newId(ctx, 'channel');
  if (ctx.draft.state.channels.has(id)) return rj('E_ID_COLLISION');
  const canal: Channel = {
    categoryId: p.categoryId,
    type: p.type,
    name: nm.value,
    rank,
    readOnlyForRoleIds: ro,
    speechMode: p.speechMode ?? SPEECH_MODE.free,
    ...(p.queueTurnSeconds !== undefined ? { queueTurnSeconds: p.queueTurnSeconds } : {}),
    ...(p.topic !== undefined ? { topic: tp.value } : {}),
  };
  ctx.draft.channels().set(id, canal);
  ctx.draft.channelNameIndex().set(nameKey(p.type, nm.value), id);
  ctx.effects.push({
    t: 'upsert',
    table: 'channels',
    key: [id],
    row: {
      id,
      category_id: p.categoryId,
      type: p.type,
      name: nm.value,
      topic: p.topic === undefined ? null : tp.value,
      rank,
      read_only_role_ids: jsonIds(ro),
      speech_mode: p.speechMode ?? SPEECH_MODE.free,
      queue_turn_seconds: p.queueTurnSeconds === undefined ? null : p.queueTurnSeconds,
      deleted_at: null,
    },
  });
  structureChanged(ctx);
  audit(ctx, AUDIT.createChannel, id, nm.value, null);
  return null;
};

const channelUpdate: Handler<'channel.update'> = (ctx, p) => {
  const ch = ctx.draft.state.channels.get(p.channelId);
  if (ch === undefined || ch.deletedAt !== undefined) return rj('E_CHANNEL_NOT_FOUND');

  let nomeNovo: string | undefined;
  if (p.name !== undefined) {
    const nm = checkChannelName(p.name, ch.type);
    if (!nm.ok) return nm.empty ? rj('E_CHANNEL_NAME_EMPTY') : VAL('name');
    nomeNovo = nm.value;
  }
  if (p.topic !== undefined && ch.type !== CHANNEL_TYPE.text) return VAL('topic');
  const tp = checkChannelTopic(p.topic);
  if (!tp.ok) return VAL(tp.field);
  // R-29 — o modo que o canal FICA é o do payload, ou o que ele já tem
  const sm = checkSpeechMode(ch.type, p.speechMode, p.queueTurnSeconds, ch.speechMode);
  if (sm !== null) return VAL(sm);

  // R-6
  if (nomeNovo !== undefined && nomeNovo !== ch.name) {
    if (ctx.draft.state.channelNameIndex.has(nameKey(ch.type, nomeNovo))) {
      return rj('E_CHANNEL_NAME_TAKEN');
    }
  }
  let ro: Set<string> | undefined;
  if (p.readOnlyForRoleIds !== undefined) {
    const r = checkReadOnly(ctx, p.readOnlyForRoleIds);
    if (r === null) return VAL('readOnlyForRoleIds');
    ro = r;
  }

  const c = ctx.draft.mutChannel(p.channelId);
  if (c === undefined) return rj('E_CHANNEL_NOT_FOUND');
  const fields: Record<string, Primitive> = {};
  if (nomeNovo !== undefined && nomeNovo !== c.name) {
    ctx.draft.channelNameIndex().delete(nameKey(c.type, c.name));
    c.name = nomeNovo;
    ctx.draft.channelNameIndex().set(nameKey(c.type, nomeNovo), p.channelId);
    fields['name'] = nomeNovo;
  }
  if (p.topic !== undefined) {
    c.topic = tp.value;
    fields['topic'] = tp.value;
  }
  if (ro !== undefined) {
    c.readOnlyForRoleIds = ro;
    fields['read_only_role_ids'] = jsonIds(ro);
  }
  if (p.speechMode !== undefined) {
    c.speechMode = p.speechMode;
    fields['speech_mode'] = p.speechMode;
  }
  if (p.queueTurnSeconds !== undefined) {
    c.queueTurnSeconds = p.queueTurnSeconds;
    fields['queue_turn_seconds'] = p.queueTurnSeconds;
  }
  ctx.effects.push({ t: 'patch', table: 'channels', key: [p.channelId], fields });
  structureChanged(ctx);
  audit(ctx, AUDIT.updateChannel, p.channelId, c.name, null);
  return null;
};

const channelMove: Handler<'channel.move'> = (ctx, p) => {
  const ch = ctx.draft.state.channels.get(p.channelId);
  if (ch === undefined || ch.deletedAt !== undefined) return rj('E_CHANNEL_NOT_FOUND');
  const cat = ctx.draft.state.categories.get(p.categoryId);
  if (cat === undefined || cat.deletedAt !== undefined) return rj('E_CATEGORY_NOT_FOUND');

  // R-20 — o escopo é a categoria de **destino**, sem o próprio canal.
  const escopo = channelScope(ctx, p.categoryId).filter((e) => e.id !== p.channelId);
  const rank = rankFor(ctx, 'channels', escopo, p.afterRank, p.beforeRank);
  if (rank === null) return rj('E_LIMIT_EXCEEDED', undefined, MAX_CHANNELS);

  const c = ctx.draft.mutChannel(p.channelId);
  if (c === undefined) return rj('E_CHANNEL_NOT_FOUND');
  c.categoryId = p.categoryId;
  c.rank = rank;
  ctx.effects.push({
    t: 'patch',
    table: 'channels',
    key: [p.channelId],
    fields: { category_id: p.categoryId, rank },
  });
  structureChanged(ctx);
  return null;
};

const channelDelete: Handler<'channel.delete'> = (ctx, p) => {
  const ch = ctx.draft.state.channels.get(p.channelId);
  if (ch === undefined || ch.deletedAt !== undefined) return rj('E_CHANNEL_NOT_FOUND');
  // R-7
  if (ch.type === CHANNEL_TYPE.text && textChannelsLeftAfter(ctx, new Set([p.channelId])) === 0) {
    return rj('E_LAST_CHANNEL');
  }
  const nome = ch.name;
  tombstoneChannel(ctx, p.channelId);
  structureChanged(ctx);
  audit(ctx, AUDIT.deleteChannel, p.channelId, nome, null);
  return null;
};

function categoryScope(ctx: KindCtx): { id: string; rank: string }[] {
  const out: { id: string; rank: string }[] = [];
  for (const [id, c] of ctx.draft.state.categories) {
    if (c.deletedAt === undefined) out.push({ id, rank: c.rank });
  }
  return out;
}

const categoryCreate: Handler<'category.create'> = (ctx, p) => {
  const name = checkCategoryName(p.name);
  if (!name.ok) return VAL(name.field);
  // R-26
  if (countActive(ctx.draft.state.categories) >= MAX_CATEGORIES) {
    return rj('E_LIMIT_EXCEEDED', undefined, MAX_CATEGORIES);
  }
  const rank = rankFor(ctx, 'categories', categoryScope(ctx), p.afterRank, p.beforeRank);
  if (rank === null) return rj('E_LIMIT_EXCEEDED', undefined, MAX_CATEGORIES);

  const id = newId(ctx, 'category');
  if (ctx.draft.state.categories.has(id)) return rj('E_ID_COLLISION');
  ctx.draft.categories().set(id, { name: name.value, rank });
  ctx.effects.push({
    t: 'upsert',
    table: 'categories',
    key: [id],
    row: { id, name: name.value, rank, deleted_at: null },
  });
  structureChanged(ctx);
  audit(ctx, AUDIT.createCategory, id, name.value, null);
  return null;
};

const categoryRename: Handler<'category.rename'> = (ctx, p) => {
  const name = checkCategoryName(p.name);
  if (!name.ok) return VAL(name.field);
  const cat = ctx.draft.state.categories.get(p.categoryId);
  if (cat === undefined || cat.deletedAt !== undefined) return rj('E_CATEGORY_NOT_FOUND');

  const c = ctx.draft.mutCategory(p.categoryId);
  if (c === undefined) return rj('E_CATEGORY_NOT_FOUND');
  c.name = name.value;
  ctx.effects.push({
    t: 'patch',
    table: 'categories',
    key: [p.categoryId],
    fields: { name: name.value },
  });
  structureChanged(ctx);
  audit(ctx, AUDIT.renameCategory, p.categoryId, name.value, null);
  return null;
};

const categoryDelete: Handler<'category.delete'> = (ctx, p) => {
  // R-25 — carrega **exatamente um** de `moveChannelsTo` / `deleteChannels`.
  const temMove = p.moveChannelsTo !== undefined;
  if (temMove === p.deleteChannels) return VAL('moveChannelsTo');

  const cat = ctx.draft.state.categories.get(p.categoryId);
  if (cat === undefined || cat.deletedAt !== undefined) return rj('E_CATEGORY_NOT_FOUND');

  let destino: string | null = null;
  if (temMove) {
    destino = p.moveChannelsTo as string;
    if (destino === p.categoryId) return VAL('moveChannelsTo');
    const d = ctx.draft.state.categories.get(destino);
    if (d === undefined || d.deletedAt !== undefined) return VAL('moveChannelsTo');
  }

  const naCategoria: string[] = [];
  for (const [id, ch] of ctx.draft.state.channels) {
    if (ch.deletedAt === undefined && ch.categoryId === p.categoryId) naCategoria.push(id);
  }
  // R-7
  if (p.deleteChannels && textChannelsLeftAfter(ctx, new Set(naCategoria)) === 0) {
    return rj('E_LAST_CHANNEL');
  }

  const c = ctx.draft.mutCategory(p.categoryId);
  if (c === undefined) return rj('E_CATEGORY_NOT_FOUND');
  c.deletedAt = ctx.hostTs;
  ctx.effects.push({
    t: 'patch',
    table: 'categories',
    key: [p.categoryId],
    fields: { deleted_at: ctx.hostTs },
  });

  if (p.deleteChannels) {
    for (const id of naCategoria) tombstoneChannel(ctx, id);
  } else if (destino !== null) {
    const escopo = channelScope(ctx, destino);
    for (const id of naCategoria) {
      const ch = ctx.draft.mutChannel(id);
      if (ch === undefined) continue;
      const rank = rankFor(ctx, 'channels', escopo, undefined, undefined);
      if (rank === null) return rj('E_LIMIT_EXCEEDED', undefined, MAX_CHANNELS);
      ch.categoryId = destino;
      ch.rank = rank;
      escopo.push({ id, rank });
      ctx.effects.push({
        t: 'patch',
        table: 'channels',
        key: [id],
        fields: { category_id: destino, rank },
      });
    }
  }
  structureChanged(ctx);
  audit(ctx, AUDIT.deleteCategory, p.categoryId, cat.name, null);
  return null;
};

// ─── §7.4.3 Cargos e membros ────────────────────────────────────────────────────────────

function roleScope(ctx: KindCtx): { id: string; rank: string }[] {
  const out: { id: string; rank: string }[] = [];
  for (const [id, r] of ctx.draft.state.roles) {
    if (r.deletedAt === undefined) out.push({ id, rank: r.rank });
  }
  return out;
}

/**
 * §6.4.1 — o que a renormalização de cargos pode reescrever: **tudo menos os dois sentinelas**.
 *
 * `RANK_TOP` é do cargo Fundador, que a mesma seção declara imutável ("Fundador tem sempre o
 * `rank` máximo e é imutável"), e `RANK_BOTTOM` é do cargo base, que "não entra no cálculo como
 * item do escopo, ele *é* a fronteira de baixo". Reespaçar os dois tirava o Fundador do topo e
 * o base do piso — e, com o piso vago, `rankBetween` passava a devolver uma chave **abaixo** do
 * cargo base para todo cargo criado sem dica, que por R-3 + R-4 nasce incapaz de moderar
 * qualquer pessoa. Os valores que `renormalize` gera ficam estritamente entre `RANK_BOTTOM` e
 * `RANK_TOP` (§6.4.1), então a ordem relativa se preserva sem tocar em nenhum dos dois.
 *
 * Eles continuam na vizinhança de `roleScope`: é lá que uma dica `beforeRank = RANK_TOP` de um
 * cliente que quer o cargo logo abaixo do Fundador ainda é reconhecida como viva.
 */
function roleScopeRenormalizavel(ctx: KindCtx): { id: string; rank: string }[] {
  const out: { id: string; rank: string }[] = [];
  for (const [id, r] of ctx.draft.state.roles) {
    if (r.deletedAt === undefined && !r.isFounder && !r.isDefault) out.push({ id, rank: r.rank });
  }
  return out;
}

const roleCreate: Handler<'role.create'> = (ctx, p) => {
  // 13
  const name = checkRoleName(p.name);
  if (!name.ok) return VAL(name.field);
  if (!isRoleColor(p.color)) return VAL('color'); // §6.4.2
  const perms = permsFrom(p.permissions);
  if (perms === null) return VAL('permissions');

  // 14 — R-26
  if (countActive(ctx.draft.state.roles) >= MAX_ROLES) {
    return rj('E_LIMIT_EXCEEDED', undefined, MAX_ROLES);
  }

  // R-27(b): `seq` 1 é o Fundador (as 17, `RANK_TOP`); `seq` 2 é o cargo base (`RANK_BOTTOM`).
  const isFounder = ctx.inGenesis && ctx.seq === 1;
  const isDefault = ctx.inGenesis && ctx.seq === 2;

  // R-11 — o cargo base nunca pode ter permissão de gestão, moderação ou menção global.
  // Vale **desde a criação**, não só no `role.update`.
  if (isDefault && baseRoleViolation(perms) !== null) return rj('E_BASE_ROLE_RESTRICTED');
  // R-5 — **sem suspensão** (R-27a): na gênese `ctx.eff` é o conjunto do principal.
  if (escalation(perms, ctx.eff) !== null) return rj('E_PERMISSION_ESCALATION');

  // 15 — R-20
  const rank = isFounder
    ? RANK_TOP
    : isDefault
      ? RANK_BOTTOM
      : rankFor(ctx, 'roles', roleScope(ctx), p.afterRank, p.beforeRank, roleScopeRenormalizavel(ctx));
  if (rank === null) return rj('E_LIMIT_EXCEEDED', undefined, MAX_ROLES);

  // R-4 — **sem suspensão**: na gênese `authorTop` é `RANK_GENESIS`, e `RANK_TOP <
  // RANK_GENESIS`, então o cargo Fundador do `seq` 1 passa e nenhum cargo posterior alcança.
  if (ctx.authorTop === null || rank >= ctx.authorTop) return rj('E_HIERARCHY');

  const id = newId(ctx, 'role');
  if (ctx.draft.state.roles.has(id)) return rj('E_ID_COLLISION');
  const numeros = new Set(p.permissions);
  const role: Role = {
    name: name.value,
    color: p.color,
    rank,
    permissions: numeros,
    mentionable: p.mentionable,
    isFounder,
    isDefault,
  };
  ctx.draft.roles().set(id, role);
  ctx.effects.push({
    t: 'upsert',
    table: 'roles',
    key: [id],
    row: {
      id,
      name: role.name,
      color: role.color,
      rank,
      permissions: jsonPerms(numeros),
      mentionable: role.mentionable ? 1 : 0,
      is_founder: isFounder ? 1 : 0,
      is_default: isDefault ? 1 : 0,
      member_count: 0,
      deleted_at: null,
    },
  });
  rolesChanged(ctx, [id]);
  audit(ctx, AUDIT.createRole, id, role.name, null);
  return null;
};

const roleUpdate: Handler<'role.update'> = (ctx, p) => {
  // 13
  let nomeNovo: string | undefined;
  if (p.name !== undefined) {
    const n = checkRoleName(p.name);
    if (!n.ok) return VAL(n.field);
    nomeNovo = n.value;
  }
  if (p.color !== undefined && !isRoleColor(p.color)) return VAL('color');
  let permsNovas: Permission[] | undefined;
  if (p.permissions !== undefined) {
    const parsed = permsFrom(p.permissions);
    if (parsed === null) return VAL('permissions');
    permsNovas = parsed;
  }

  // 14
  const role = ctx.draft.state.roles.get(p.roleId);
  if (role === undefined || role.deletedAt !== undefined) return rj('E_NOT_FOUND');
  // §6.4.1: o Fundador é imutável. O estágio 12 já teria recusado; isto cobre o caso em que
  // `Hier.` não se aplicou por o alvo ter sumido entre os estágios.
  if (role.isFounder) return rj('E_FOUNDER_IMMUTABLE');
  // R-12 — o cargo base nunca perde `isDefault`. `isDefault` não está no payload de §7.4.3,
  // então a única forma de perdê-lo seria por efeito, e não há nenhum: a regra é estrutural.

  if (permsNovas !== undefined) {
    // R-11
    if (role.isDefault && baseRoleViolation(permsNovas) !== null) {
      return rj('E_BASE_ROLE_RESTRICTED');
    }
    // R-5 — avaliado sobre o que é **acrescentado**: manter uma permissão que já estava lá
    // não é conceder. Sem isso, quem não tem `ban_members` não conseguiria renomear um cargo
    // que a tem.
    const acrescentadas = permsNovas.filter((p2) => !role.permissions.has(permissionNumber(p2)));
    if (escalation(acrescentadas, ctx.eff) !== null) return rj('E_PERMISSION_ESCALATION');
  }

  // 15
  const r = ctx.draft.mutRole(p.roleId);
  if (r === undefined) return rj('E_NOT_FOUND');
  const fields: Record<string, Primitive> = {};
  if (nomeNovo !== undefined) {
    r.name = nomeNovo;
    fields['name'] = nomeNovo;
  }
  if (p.color !== undefined) {
    r.color = p.color;
    fields['color'] = p.color;
  }
  if (p.mentionable !== undefined) {
    r.mentionable = p.mentionable;
    fields['mentionable'] = p.mentionable ? 1 : 0;
  }
  if (p.permissions !== undefined) {
    // R-10 — quem perder `create_invite` por esta mudança tem os convites revogados.
    const portadores: [string, ReadonlySet<Permission>][] = [];
    for (const [hex, m] of ctx.draft.state.members) {
      if (m.roleIds.has(p.roleId)) portadores.push([hex, effOf(ctx, m.roleIds)]);
    }
    r.permissions = new Set(p.permissions);
    fields['permissions'] = jsonPerms(r.permissions);
    for (const [hex, antes] of portadores) r10OnRoleChange(ctx, hex, antes);
  }
  ctx.effects.push({ t: 'patch', table: 'roles', key: [p.roleId], fields });
  rolesChanged(ctx, [p.roleId]);
  audit(ctx, AUDIT.updateRole, p.roleId, r.name, null);
  return null;
};

const roleMove: Handler<'role.move'> = (ctx, p) => {
  const role = ctx.draft.state.roles.get(p.roleId);
  if (role === undefined || role.deletedAt !== undefined) return rj('E_NOT_FOUND');
  if (role.isFounder) return rj('E_FOUNDER_IMMUTABLE');
  if (role.isDefault) return rj('E_BASE_ROLE_REQUIRED'); // R-12

  const escopo = roleScope(ctx).filter((e) => e.id !== p.roleId);
  const renormalizavel = roleScopeRenormalizavel(ctx).filter((e) => e.id !== p.roleId);
  const rank = rankFor(ctx, 'roles', escopo, p.afterRank, p.beforeRank, renormalizavel);
  if (rank === null) return rj('E_LIMIT_EXCEEDED', undefined, MAX_ROLES);

  // §9.3, passo 1: mover um cargo até `rank ≥` o do Fundador é `E_FOUNDER_TOP` — código
  // próprio, e não `E_HIERARCHY`, para que a UI possa dizer "o Fundador é sempre o topo".
  const fundador = founderRoleId(ctx);
  const rankFundador = fundador === null ? null : (ctx.draft.state.roles.get(fundador)?.rank ?? null);
  if (rankFundador !== null && rank >= rankFundador) return rj('E_FOUNDER_TOP');
  // R-4 — ninguém move cargo para `rank ≥` o próprio topo.
  if (ctx.authorTop === null || rank >= ctx.authorTop) return rj('E_HIERARCHY');

  const r = ctx.draft.mutRole(p.roleId);
  if (r === undefined) return rj('E_NOT_FOUND');
  r.rank = rank;
  ctx.effects.push({ t: 'patch', table: 'roles', key: [p.roleId], fields: { rank } });
  rolesChanged(ctx, [p.roleId]);
  return null;
};

const roleDelete: Handler<'role.delete'> = (ctx, p) => {
  const role = ctx.draft.state.roles.get(p.roleId);
  if (role === undefined || role.deletedAt !== undefined) return rj('E_NOT_FOUND');
  if (role.isFounder) return rj('E_FOUNDER_IMMUTABLE');
  if (role.isDefault) return rj('E_BASE_ROLE_REQUIRED'); // R-12

  const base = baseRoleId(ctx);
  const r = ctx.draft.mutRole(p.roleId);
  if (r === undefined) return rj('E_NOT_FOUND');
  r.deletedAt = ctx.hostTs;
  ctx.effects.push({
    t: 'patch',
    table: 'roles',
    key: [p.roleId],
    fields: { deleted_at: ctx.hostTs },
  });

  // §8.4.1: membros mantidos; o id sai de `roleIds`; sem cargo, recebe o base.
  for (const [hex, m] of [...ctx.draft.state.members]) {
    if (!m.roleIds.has(p.roleId)) continue;
    const proximo = new Set(m.roleIds);
    proximo.delete(p.roleId);
    if (proximo.size === 0 && base !== null) proximo.add(base);
    setMemberRoles(ctx, hex, proximo);
  }
  // §8.4.1 e §6.4.1 (fecha `F-31`): limpa **toda** referência pendurada, inclusive
  // `channel.readOnlyForRoleIds` — uma lista que aponta para cargo morto silencia por engano.
  for (const [id, ch] of [...ctx.draft.state.channels]) {
    if (!ch.readOnlyForRoleIds.has(p.roleId)) continue;
    const c = ctx.draft.mutChannel(id);
    if (c === undefined) continue;
    c.readOnlyForRoleIds.delete(p.roleId);
    ctx.effects.push({
      t: 'patch',
      table: 'channels',
      key: [id],
      fields: { read_only_role_ids: jsonIds(c.readOnlyForRoleIds) },
    });
  }
  rolesChanged(ctx, [p.roleId]);
  audit(ctx, AUDIT.deleteRole, p.roleId, role.name, null);
  return null;
};

const memberSetRoles: Handler<'member.setRoles'> = (ctx, p) => {
  const targetHex = p.targetKey.toString('hex');
  const alvo = ctx.draft.state.members.get(targetHex);
  if (alvo === undefined) return rj('E_NOT_FOUND');

  // §8.4.1: ids desconhecidos ou deletados são **descartados**, não recusam a op inteira.
  const mantidos = new Set<string>();
  for (const rid of p.roleIds) {
    const r = ctx.draft.state.roles.get(rid);
    if (r === undefined || r.deletedAt !== undefined) continue;
    mantidos.add(rid);
  }

  const base = baseRoleId(ctx);
  // R-3 — todo membro ativo contém o cargo base; **remover** o base é recusado.
  if (base !== null && alvo.state === 'active' && alvo.roleIds.has(base) && !mantidos.has(base)) {
    return rj('E_BASE_ROLE_REQUIRED');
  }
  if (mantidos.size === 0 && base !== null) mantidos.add(base);
  // R-26
  if (mantidos.size > MAX_ROLES_PER_MEMBER) {
    return rj('E_LIMIT_EXCEEDED', undefined, MAX_ROLES_PER_MEMBER);
  }
  // R-4 — nenhum cargo **atribuído** pode ter `rank ≥ topRank(autor)`.
  for (const rid of mantidos) {
    if (alvo.roleIds.has(rid)) continue; // já possuía: não é atribuição
    const r = ctx.draft.state.roles.get(rid);
    if (r === undefined) continue;
    if (ctx.authorTop === null || r.rank >= ctx.authorTop) return rj('E_HIERARCHY');
  }

  // R-30 (§9.3, emenda de 2026-09-04) — **auto-atribuição não concede o que o autor não tem.**
  //
  // O estágio 12 não roda quando o alvo é o próprio autor (§9.3 passo 2 é de `mod.*`, e o passo
  // 3 aplicado a si mesmo recusaria sempre, congelando até os cargos do Fundador). O que sobrava
  // era R-4, que só compara `rank`: quem tinha `manage_roles` se atribuía qualquer cargo abaixo
  // do próprio topo e herdava as permissões dele — `ban_members`, `manage_community` — sem
  // jamais tê-las tido. É a mesma escalada que R-5 fecha na criação do cargo, entrando pela
  // porta da atribuição. A quarta regra de anti-escalada de §9.3 fecha essa porta, e só ela:
  // atribuir a **outra pessoa** um cargo mais forte que o seu continua valendo, porque ali a
  // hierarquia do estágio 12 é quem responde e o autor não ganha nada.
  if (targetHex === ctx.authorHex) {
    for (const rid of [...mantidos].sort()) {
      if (alvo.roleIds.has(rid)) continue; // já possuía: não é concessão
      const r = ctx.draft.state.roles.get(rid);
      if (r === undefined) continue;
      const concedidas = permsFrom([...r.permissions]);
      if (concedidas !== null && escalation(concedidas, ctx.eff) !== null) {
        return rj('E_PERMISSION_ESCALATION');
      }
    }
  }

  setMemberRoles(ctx, targetHex, mantidos);
  return null;
};

const ZERO32 = Buffer.alloc(32);
const ZERO64 = Buffer.alloc(64);

const memberJoin: Handler<'member.join'> = (ctx, p) => {
  // 13
  const dn = checkDisplayName(p.displayName);
  if (!dn.ok) return VAL(dn.field);
  if (!isAvatarColor(p.avatarColor)) return VAL('avatarColor'); // §6.4.2

  const existente = ctx.draft.state.members.get(ctx.authorHex);
  // §6.3 e §12.5: banido não entra. `mod.revokeBan` é o único caminho de volta.
  if (existente !== undefined && existente.state === 'banned') return rj('E_BANNED');

  const formaDoFundador = p.invitePublicKey.equals(ZERO32) && p.joinProof.equals(ZERO64);
  let roleIds: Set<string>;

  if (ctx.inGenesis && formaDoFundador) {
    // R-27: **R-9 não se aplica** ao `member.join` do fundador, que carrega
    // `invitePublicKey` e `joinProof` zerados. É a única regra suspensa na gênese.
    const f = founderRoleId(ctx);
    const b = baseRoleId(ctx);
    if (f === null || b === null) return rj('E_GENESIS_MISPLACED');
    // §19.1: um membro (o host, com Fundador). R-3: todo membro ativo tem o cargo base.
    roleIds = new Set([f, b]);
  } else {
    // R-9 — prova de adesão, convite vivo, não esgotado, par `(invitePk, autor)` inédito.
    const digest = blake2b256(
      'invite-join/1',
      ctx.op.communityId,
      p.invitePublicKey,
      ctx.op.author,
    );
    if (!verifySignature(p.joinProof, digest, p.invitePublicKey)) return rj('E_INVITE_INVALID');
    const pkHex = p.invitePublicKey.toString('hex');
    const inv = ctx.draft.state.invites.get(pkHex);
    if (inv === undefined || inv.revokedAt !== undefined) return rj('E_INVITE_INVALID');
    if (inv.expiresAt !== undefined && inv.expiresAt <= ctx.hostTs) return rj('E_INVITE_INVALID');
    // Reentrar exige convite **novo**: sem isso um convite de `maxUses = 1` seria reusável
    // indefinidamente pela mesma pessoa entrando e saindo (§12.6).
    const par = `${pkHex}:${ctx.authorHex}`;
    if (ctx.draft.state.joinedByInvite.has(par)) return rj('E_INVITE_INVALID');
    if (inv.maxUses !== undefined && inv.uses >= inv.maxUses) return rj('E_INVITE_EXHAUSTED');

    const b = baseRoleId(ctx);
    if (b === null) return rj('E_NOT_FOUND');
    // §6.3: quem sai e volta recupera o `Member` com `roleIds` **resetado** ao cargo base.
    roleIds = new Set([b]);

    // R-9 — incrementa `uses` **no mesmo passo**.
    ctx.draft.invites().set(pkHex, { ...inv, uses: inv.uses + 1 });
    ctx.draft.joinedByInvite().add(par);
    ctx.effects.push({
      t: 'patch',
      table: 'invites',
      key: [p.invitePublicKey],
      fields: { uses: inv.uses + 1 },
    });
    ctx.effects.push({ t: 'notify', topic: 'invites.changed', data: {} });
  }

  // 15
  const membro: Member = {
    state: 'active',
    roleIds: existente !== undefined ? new Set(existente.roleIds) : new Set(),
    displayName: dn.value,
    avatarColor: p.avatarColor,
    blobsCoreKey: p.blobsCoreKey,
    // §6.3: quem já esteve dentro mantém a data de adesão. R-28: quem só existia como ban
    // preventivo nunca entrou, então o `joinedAt` da linha é o instante do ban e não pode ser
    // herdado — a adesão é agora.
    joinedAt: existente !== undefined && existente.preBan !== true ? existente.joinedAt : ctx.hostTs,
    storageUsedBytes: existente?.storageUsedBytes ?? 0,
    opBudget: existente?.opBudget ?? emptyRing(),
    byteBudget: existente?.byteBudget ?? emptyRing(),
  };
  ctx.draft.members().set(ctx.authorHex, membro);
  ctx.effects.push({
    t: 'upsert',
    table: 'members',
    key: [ctx.op.author],
    row: {
      identity_key: ctx.op.author,
      display_name: membro.displayName,
      avatar_color: membro.avatarColor,
      nickname: null,
      blobs_core_key: p.blobsCoreKey,
      joined_at: membro.joinedAt,
      left_at: null,
      banned: 0,
      timeout_until: null,
      storage_used_bytes: membro.storageUsedBytes,
      // §10.3 — a coluna de L-5 nasce explícita; `recalcularColisoesDeNome` a corrige logo
      // abaixo, no mesmo registro, se a entrada criar ou desfizer uma colisão.
      display_name_collision: 0,
    },
  });
  setMemberRoles(ctx, ctx.authorHex, roleIds);
  recontarPopulacaoAtiva(ctx, ctx.authorHex);
  recalcularColisoesDeNome(ctx); // L-5 — a entrada pode colidir com nome existente
  return null;
};

const memberLeave: Handler<'member.leave'> = (ctx) => {
  // §6.2: o host não pode `member.leave` — sair é §18.7, não uma op.
  if (ctx.authorHex === ctx.draft.state.community.hostKey.toString('hex')) {
    return rj('E_HOST_CANNOT_LEAVE');
  }
  const m = ctx.draft.state.members.get(ctx.authorHex);
  if (m === undefined) return rj('E_NOT_MEMBER');
  if (m.state === 'left') {
    ctx.draft.touch(); // idempotente
    return null;
  }
  leaveCommunity(ctx, ctx.authorHex);
  return null;
};

const memberSetNickname: Handler<'member.setNickname'> = (ctx, p) => {
  const nk = checkNickname(p.nickname);
  if (!nk.ok) return VAL(nk.field);
  const m = ctx.draft.mutMember(ctx.authorHex);
  if (m === undefined) return rj('E_NOT_MEMBER');
  if (nk.value === null) delete m.nickname;
  else m.nickname = nk.value;
  ctx.effects.push({
    t: 'patch',
    table: 'members',
    key: [ctx.op.author],
    fields: { nickname: nk.value },
  });
  ctx.effects.push({
    t: 'notify',
    topic: 'members.changed',
    data: { identityKeys: [ctx.authorHex] },
  });
  return null;
};

const memberSetBlobsCore: Handler<'member.setBlobsCore'> = (ctx, p) => {
  const m = ctx.draft.mutMember(ctx.authorHex);
  if (m === undefined) return rj('E_NOT_MEMBER');
  m.blobsCoreKey = p.blobsCoreKey;
  ctx.effects.push({
    t: 'patch',
    table: 'members',
    key: [ctx.op.author],
    fields: { blobs_core_key: p.blobsCoreKey },
  });
  ctx.effects.push({
    t: 'notify',
    topic: 'members.changed',
    data: { identityKeys: [ctx.authorHex] },
  });
  return null;
};

const identityUpdate: Handler<'identity.update'> = (ctx, p) => {
  let nome: string | undefined;
  if (p.displayName !== undefined) {
    const dn = checkDisplayName(p.displayName);
    if (!dn.ok) return VAL(dn.field);
    nome = dn.value;
  }
  if (p.avatarColor !== undefined && !isAvatarColor(p.avatarColor)) return VAL('avatarColor');

  const m = ctx.draft.mutMember(ctx.authorHex);
  if (m === undefined) return rj('E_NOT_MEMBER');
  const fields: Record<string, Primitive> = {};
  if (nome !== undefined) {
    m.displayName = nome;
    fields['display_name'] = nome;
  }
  if (p.avatarColor !== undefined) {
    m.avatarColor = p.avatarColor;
    fields['avatar_color'] = p.avatarColor;
  }
  ctx.effects.push({ t: 'patch', table: 'members', key: [ctx.op.author], fields });
  ctx.effects.push({
    t: 'notify',
    topic: 'members.changed',
    data: { identityKeys: [ctx.authorHex] },
  });
  if (nome !== undefined) recalcularColisoesDeNome(ctx); // L-5
  return null;
};

// ─── §7.4.4 Moderação ───────────────────────────────────────────────────────────────────

const modKick: Handler<'mod.kick'> = (ctx, p) => {
  const reason = checkModerationReason(p.reason);
  if (!reason.ok) return VAL(reason.field);
  const targetHex = p.targetKey.toString('hex');
  const alvo = ctx.draft.state.members.get(targetHex);
  if (alvo === undefined) return rj('E_NOT_FOUND');
  if (alvo.state !== 'active') {
    ctx.draft.touch(); // idempotente: já não está dentro
    return null;
  }
  const label = labelOf(ctx, targetHex);
  leaveCommunity(ctx, targetHex);
  audit(ctx, AUDIT.kick, targetHex, label, reason.value || null);
  return null;
};

/**
 * R-28 — **ban sem membresia**. `mod.ban` sobre quem não é membro não é referência quebrada:
 * a linha nasce direto em `banned`, sem passar por `active`. É ban preventivo, e é o
 * mecanismo pelo qual a continuação de uma sucessão carrega os bans da origem (§18.8.1) —
 * sem ele, o convite de reentrada de L-23 lavaria o ban.
 *
 * O que **não** entra aqui, e por quê: `memberCount` não é recontado porque quem nunca esteve
 * `active` nunca foi contado (§8.4, população `left_at IS NULL AND banned = 0`); não há
 * mensagens a ocultar nem convites a revogar por R-10, porque as duas coisas exigem membresia
 * para existir. O rótulo da auditoria é o fragmento de chave: §6.13 pede o rótulo congelado no
 * momento da aplicação, e aqui não há nome a congelar.
 */
function banSemMembresia(
  ctx: KindCtx,
  targetKey: Buffer,
  targetHex: string,
  reason: string | null,
): Rejection | null {
  const ring = emptyRing();
  const membro: Member = {
    state: 'banned',
    roleIds: new Set(),
    displayName: targetHex.slice(0, 8),
    avatarColor: 0,
    // Instante do ban, não data de adesão: `preBan` marca a diferença para que um
    // `member.join` posterior (depois de `mod.revokeBan`) não herde este `joinedAt`.
    joinedAt: ctx.hostTs,
    bannedAt: ctx.hostTs,
    bannedBy: ctx.op.author,
    preBan: true,
    storageUsedBytes: 0,
    opBudget: ring,
    byteBudget: ring,
  };
  ctx.draft.members().set(targetHex, membro);
  ctx.effects.push({
    t: 'upsert',
    table: 'members',
    key: [targetKey],
    row: {
      identity_key: targetKey,
      display_name: membro.displayName,
      avatar_color: membro.avatarColor,
      nickname: null,
      blobs_core_key: null,
      joined_at: membro.joinedAt,
      left_at: null,
      banned: 1,
      timeout_until: null,
      storage_used_bytes: 0,
      display_name_collision: 0, // §10.3 — quem nunca esteve `active` não colide com ninguém
    },
  });
  ctx.effects.push({
    t: 'upsert',
    table: 'bans',
    key: [targetKey],
    row: {
      target_key: targetKey,
      by_key: ctx.op.author,
      at: ctx.hostTs,
      reason,
      revoked_at: null,
    },
  });
  ctx.effects.push({ t: 'notify', topic: 'members.changed', data: { identityKeys: [targetHex] } });
  audit(ctx, AUDIT.ban, targetHex, membro.displayName, reason);
  return null;
}

const modBan: Handler<'mod.ban'> = (ctx, p) => {
  const reason = checkModerationReason(p.reason);
  if (!reason.ok) return VAL(reason.field);

  const targetHex = p.targetKey.toString('hex');
  const alvo = ctx.draft.state.members.get(targetHex);
  // R-28 — só o **ban** tem forma sem membresia; `kick`, `timeout` e os dois inversos
  // continuam recusando com `E_NOT_FOUND` (§8.4.1).
  if (alvo === undefined) return banSemMembresia(ctx, p.targetKey, targetHex, reason.value || null);
  // §8.4.1: já banido ⇒ `APPLIED` idempotente, **sem segunda entrada de auditoria**.
  if (alvo.state === 'banned') {
    ctx.draft.touch();
    return null;
  }

  const label = labelOf(ctx, targetHex);
  const t = ctx.draft.mutMember(targetHex);
  if (t === undefined) return rj('E_NOT_FOUND');
  t.state = 'banned';
  t.bannedAt = ctx.hostTs;
  t.bannedBy = ctx.op.author;
  ctx.effects.push({ t: 'patch', table: 'members', key: [p.targetKey], fields: { banned: 1 } });
  ctx.effects.push({
    t: 'upsert',
    table: 'bans',
    key: [p.targetKey],
    row: {
      target_key: p.targetKey,
      by_key: ctx.op.author,
      at: ctx.hostTs,
      reason: reason.value || null,
      revoked_at: null,
    },
  });
  hideMessagesOf(ctx, p.targetKey, targetHex, true);
  revokeInvitesOf(ctx, targetHex); // R-10
  recontarPopulacaoAtiva(ctx, targetHex);
  ctx.effects.push({ t: 'notify', topic: 'members.changed', data: { identityKeys: [targetHex] } });
  recalcularColisoesDeNome(ctx); // L-5 — banido sai do conjunto ativo
  audit(ctx, AUDIT.ban, targetHex, label, reason.value || null);
  return null;
};

/**
 * §6.12, §18.1 e §18.2 — ocultação **reversível** das mensagens do alvo, na mesma transação.
 *
 * §8.4 `patchScope` (fecha `HOLE-12`): dois efeitos no lugar de 2N. O `DS` continua sendo
 * atualizado mensagem a mensagem — ele é a fonte da decisão —, mas o delta que viaja até
 * `view.db` deixa de ser uma lista de N linhas.
 *
 * **A FTS é simétrica (§8.4).** O ban tira as mensagens do índice com `ftsRemoveScope`; o ban
 * revogado as devolve com `ftsIndexScope`. O `fold` não carrega o `content` — §8.1 só guarda
 * metadado de decisão —, e é por isso que a forma inversa **não** transporta texto: quem
 * reindexa é o projector, a partir do `messages.content` que ele mesmo materializou. Sem ela,
 * §18.2 prometia reversibilidade e entregava metade: as mensagens voltavam às listagens e
 * ficavam fora da busca para sempre.
 *
 * A ordem importa e é a de emissão: o `patchScope` zera `hidden_by_ban` **antes** de o
 * `ftsIndexScope` selecionar o que reindexar, então o filtro do projector vê o estado já
 * corrigido.
 */
function hideMessagesOf(ctx: KindCtx, targetKey: Buffer, targetHex: string, hidden: boolean): void {
  let algum = false;
  for (const [id, msg] of ctx.draft.state.messages) {
    if (msg.authorKey !== targetHex || msg.hiddenByBan === hidden) continue;
    const m = ctx.draft.mutMessage(id);
    if (m === undefined) continue;
    m.hiddenByBan = hidden;
    algum = true;
  }
  if (!algum) return;
  const scope = { s: 'messagesOfAuthor', authorKey: targetKey } as const;
  ctx.effects.push({ t: 'patchScope', scope, fields: { hidden_by_ban: hidden ? 1 : 0 } });
  ctx.effects.push(hidden ? { t: 'ftsRemoveScope', scope } : { t: 'ftsIndexScope', scope });
}

const modRevokeBan: Handler<'mod.revokeBan'> = (ctx, p) => {
  const targetHex = p.targetKey.toString('hex');
  const alvo = ctx.draft.state.members.get(targetHex);
  if (alvo === undefined) return rj('E_NOT_FOUND');
  if (alvo.state !== 'banned') return rj('E_NOT_BANNED');

  const label = labelOf(ctx, targetHex);
  const t = ctx.draft.mutMember(targetHex);
  if (t === undefined) return rj('E_NOT_FOUND');
  // §18.1: o alvo volta a `left`; precisa de convite válido para reentrar.
  t.state = 'left';
  t.leftAt = ctx.hostTs;
  delete t.bannedAt;
  delete t.bannedBy;
  // `left_at` vai junto com `banned = 0`. Sem ele a linha ficava `left_at IS NULL AND
  // banned = 0` — isto é, **membro ativo** para toda query de §15.6 e para os dois contadores
  // de §8.4 —, enquanto o `DS` dizia `left` e o estágio 8 recusava tudo com `E_NOT_MEMBER`.
  ctx.effects.push({
    t: 'patch',
    table: 'members',
    key: [p.targetKey],
    fields: { banned: 0, left_at: ctx.hostTs },
  });
  ctx.effects.push({
    t: 'patch',
    table: 'bans',
    key: [p.targetKey],
    fields: { revoked_at: ctx.hostTs },
  });
  hideMessagesOf(ctx, p.targetKey, targetHex, false);
  recontarPopulacaoAtiva(ctx, targetHex);
  ctx.effects.push({ t: 'notify', topic: 'members.changed', data: { identityKeys: [targetHex] } });
  audit(ctx, AUDIT.revokeBan, targetHex, label, null);
  return null;
};

const modTimeout: Handler<'mod.timeout'> = (ctx, p) => {
  const reason = checkModerationReason(p.reason);
  if (!reason.ok) return VAL(reason.field);
  // §8.6 — `Timeout.until` ∈ `[hostTs+60s, hostTs+30d]`.
  if (p.until < ctx.hostTs + TIMEOUT_MIN_MS || p.until > ctx.hostTs + TIMEOUT_MAX_MS) {
    return VAL('until');
  }
  const targetHex = p.targetKey.toString('hex');
  const alvo = ctx.draft.state.members.get(targetHex);
  if (alvo === undefined) return rj('E_NOT_FOUND');

  const label = labelOf(ctx, targetHex);
  const t = ctx.draft.mutMember(targetHex);
  if (t === undefined) return rj('E_NOT_FOUND');
  t.timeoutUntil = p.until;
  ctx.effects.push({
    t: 'patch',
    table: 'members',
    key: [p.targetKey],
    fields: { timeout_until: p.until },
  });
  ctx.effects.push({
    t: 'upsert',
    table: 'timeouts',
    key: [p.targetKey],
    row: {
      target_key: p.targetKey,
      by_key: ctx.op.author,
      at: ctx.hostTs,
      until: p.until,
      reason: reason.value || null,
    },
  });
  ctx.effects.push({ t: 'notify', topic: 'members.changed', data: { identityKeys: [targetHex] } });
  audit(ctx, AUDIT.timeout, targetHex, label, reason.value || null);
  return null;
};

const modRemoveTimeout: Handler<'mod.removeTimeout'> = (ctx, p) => {
  const targetHex = p.targetKey.toString('hex');
  const alvo = ctx.draft.state.members.get(targetHex);
  if (alvo === undefined) return rj('E_NOT_FOUND');
  // §8.4.1 e §21.2: sem timeout ativo ⇒ `APPLIED` idempotente silencioso, sem efeitos e sem auditoria.
  if (alvo.timeoutUntil === undefined) {
    ctx.draft.touch();
    return null;
  }

  const label = labelOf(ctx, targetHex);
  const t = ctx.draft.mutMember(targetHex);
  if (t === undefined) return rj('E_NOT_FOUND');
  delete t.timeoutUntil;
  ctx.effects.push({
    t: 'patch',
    table: 'members',
    key: [p.targetKey],
    fields: { timeout_until: null },
  });
  ctx.effects.push({ t: 'delete', table: 'timeouts', key: [p.targetKey] });
  ctx.effects.push({ t: 'notify', topic: 'members.changed', data: { identityKeys: [targetHex] } });
  audit(ctx, AUDIT.removeTimeout, targetHex, label, null);
  return null;
};

// ─── §7.4.5 Comunidade, convite, rede ───────────────────────────────────────────────────

const communityCreate: Handler<'community.create'> = (ctx, p) => {
  // 13
  const name = checkCommunityName(p.name);
  if (!name.ok) return VAL(name.field);
  const desc = checkCommunityDescription(p.description);
  if (!desc.ok) return VAL(desc.field);
  if (!isAvatarColor(p.iconColor)) return VAL('iconColor'); // §6.4.2
  const emoji = checkIconEmoji(p.iconEmoji);
  if (!emoji.ok) return VAL(emoji.field);

  // 14 — a posição (`seq` 0) já foi imposta por R-27, antes deste estágio.
  // 15
  const c = ctx.draft.community();
  c.exists = true;
  c.hostKey = ctx.op.author;
  c.founderKey = ctx.op.author; // imutável para sempre (§19.1)
  c.blobsKey = p.blobsKey;
  c.name = name.value;
  c.iconColor = p.iconColor;
  c.createdAt = ctx.hostTs;
  if (p.iconEmoji !== undefined) c.iconEmoji = p.iconEmoji;
  if (p.description !== undefined) c.description = desc.value;
  if (p.originCommunityId !== undefined) c.originCommunityId = p.originCommunityId;
  if (p.originFinalSeq !== undefined) c.originFinalSeq = p.originFinalSeq;

  ctx.effects.push({
    t: 'upsert',
    table: 'communities',
    key: [ctx.draft.state.communityId],
    row: {
      id: ctx.draft.state.communityId,
      core_key: ctx.draft.state.communityKey,
      blobs_key: p.blobsKey,
      host_key: ctx.op.author,
      founder_key: ctx.op.author,
      name: name.value,
      icon_emoji: p.iconEmoji ?? null,
      icon_color: p.iconColor,
      description: p.description === undefined ? null : desc.value,
      created_at: ctx.hostTs,
      member_count: 0,
      ended_at: null,
      origin_community_id: p.originCommunityId ?? null,
      successor_keys: JSON.stringify([]),
    },
  });
  return null;
};

const communityUpdate: Handler<'community.update'> = (ctx, p) => {
  let nome: string | undefined;
  if (p.name !== undefined) {
    const n = checkCommunityName(p.name);
    if (!n.ok) return VAL(n.field);
    nome = n.value;
  }
  let desc: string | undefined;
  if (p.description !== undefined) {
    const d = checkCommunityDescription(p.description);
    if (!d.ok) return VAL(d.field);
    desc = d.value;
  }
  if (p.iconEmoji !== undefined) {
    const e = checkIconEmoji(p.iconEmoji);
    if (!e.ok) return VAL(e.field);
  }
  if (p.iconColor !== undefined && !isAvatarColor(p.iconColor)) return VAL('iconColor');

  const c = ctx.draft.community();
  const fields: Record<string, Primitive> = {};
  const mudados: string[] = [];
  if (nome !== undefined) {
    c.name = nome;
    fields['name'] = nome;
    mudados.push('name');
  }
  if (p.iconEmoji !== undefined) {
    c.iconEmoji = p.iconEmoji;
    fields['icon_emoji'] = p.iconEmoji;
    mudados.push('iconEmoji');
  }
  if (p.iconColor !== undefined) {
    c.iconColor = p.iconColor;
    fields['icon_color'] = p.iconColor;
    mudados.push('iconColor');
  }
  if (desc !== undefined) {
    c.description = desc;
    fields['description'] = desc;
    mudados.push('description');
  }
  ctx.effects.push({
    t: 'patch',
    table: 'communities',
    key: [ctx.draft.state.communityId],
    fields,
  });
  ctx.effects.push({ t: 'notify', topic: 'community.changed', data: { fields: mudados } });
  audit(ctx, AUDIT.updateCommunity, ctx.draft.state.communityId, c.name, null);
  return null;
};

const communityEnd: Handler<'community.end'> = (ctx, p) => {
  const reason = checkModerationReason(p.reason);
  if (!reason.ok) return VAL(reason.field);
  const c = ctx.draft.community();
  if (c.endedAt !== undefined) {
    ctx.draft.touch(); // idempotente
    return null;
  }
  c.endedAt = ctx.hostTs;
  ctx.effects.push({
    t: 'patch',
    table: 'communities',
    key: [ctx.draft.state.communityId],
    fields: { ended_at: ctx.hostTs },
  });
  ctx.effects.push({ t: 'notify', topic: 'community.ended', data: {} });
  audit(ctx, AUDIT.endCommunity, ctx.draft.state.communityId, c.name, reason.value || null);
  return null;
};

const communitySetSuccessors: Handler<'community.setSuccessors'> = (ctx, p) => {
  // §8.6 — máx. 5, sem duplicata, sem o próprio host.
  if (p.successorKeys.length > MAX_SUCCESSORS) return VAL('successorKeys');
  const vistos = new Set<string>();
  const hostHex = ctx.draft.state.community.hostKey.toString('hex');
  for (const k of p.successorKeys) {
    if (k.length !== 32) return VAL('successorKeys');
    const hex = k.toString('hex');
    if (hex === hostHex || vistos.has(hex)) return VAL('successorKeys');
    vistos.add(hex);
  }

  const c = ctx.draft.community();
  c.successorKeys = p.successorKeys.map((k) => Buffer.from(k));
  ctx.effects.push({
    t: 'patch',
    table: 'communities',
    key: [ctx.draft.state.communityId],
    // Ordem = prioridade (§18.8): a lista **não** é ordenada por valor.
    fields: { successor_keys: JSON.stringify(c.successorKeys.map((k) => k.toString('hex'))) },
  });
  audit(ctx, AUDIT.setSuccessors, ctx.draft.state.communityId, c.name, null);
  return null;
};

const communityEscrow: Handler<'community.escrow'> = (ctx, p) => {
  if (p.targetKey.length !== 32) return VAL('targetKey');
  if (p.wrappedSeed.length === 0) return VAL('wrappedSeed');
  // §18.8: `crypto_box_seal(communitySeed, x25519(targetKey))` — só o sucessor abre. O
  // `fold` não pode conferir o conteúdo (é opaco por construção) e não há tabela de `CS`
  // para ele: quem precisa do escrow lê o próprio log (`succession`, L2). Sem efeito.
  ctx.draft.touch();
  return null;
};

const communityAssumeHost: Handler<'community.assumeHost'> = (ctx, p) => {
  if (p.newHostKey.length !== 32) return VAL('newHostKey');
  const origem = ctx.draft.state.community.originCommunityId;
  const finalSeq = ctx.draft.state.community.originFinalSeq;
  if (origem === undefined || finalSeq === undefined) return rj('E_SUCCESSION_DENIED');
  let chaveOrigem: Buffer;
  try {
    chaveOrigem = Buffer.from(origem, 'hex');
  } catch {
    return rj('E_SUCCESSION_DENIED');
  }
  if (chaveOrigem.length !== 32) return rj('E_SUCCESSION_DENIED');

  // R-18(a), **universal** — verificável por toda réplica sem ter a comunidade de origem:
  // `originCommunityId` *é* a chave pública do core antigo e está na gênese desta. A prova
  // demonstra posse da chave de escrita antiga sem exigir escrita no core antigo, que é o
  // que evita o fork (§18.8).
  //
  // R-18(b) — sucessor autorizado, grace period e prioridade — é **condicional** e não é do
  // `fold`: exige o `DS` de *outra* comunidade. Quem tem a origem replicada avalia em
  // `succession` (L2) e, se falhar, marca a continuação como `disputed` **sem** rejeitar o
  // registro — não há base para isso na comunidade nova.
  const digest = blake2b256(
    'assume/1',
    ctx.draft.state.communityKey,
    u64le(finalSeq),
  );
  if (!verifySignature(p.proof, digest, chaveOrigem)) return rj('E_SUCCESSION_DENIED');

  const c = ctx.draft.community();
  c.hostKey = Buffer.from(p.newHostKey);
  ctx.effects.push({
    t: 'patch',
    table: 'communities',
    key: [ctx.draft.state.communityId],
    fields: { host_key: c.hostKey },
  });
  ctx.effects.push({ t: 'notify', topic: 'community.changed', data: { fields: ['hostKey'] } });
  audit(ctx, AUDIT.assumeHost, ctx.draft.state.communityId, c.name, null);
  return null;
};

/** `u64` little-endian — o mesmo layout de §7.2.1, para o material de `'assume/1'`. */
function u64le(n: number): Buffer {
  const b = Buffer.allocUnsafe(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

const inviteCreate: Handler<'invite.create'> = (ctx, p) => {
  // 13 — §8.6
  if (p.invitePublicKey.length !== 32) return VAL('invitePublicKey');
  if (p.maxUses !== undefined) {
    if (p.maxUses < INVITE_MAX_USES_MIN || p.maxUses > INVITE_MAX_USES_MAX) return VAL('maxUses');
  }
  if (p.expiresAt !== undefined) {
    if (p.expiresAt < ctx.hostTs + INVITE_EXPIRY_MIN_MS) return VAL('expiresAt');
    if (p.expiresAt > ctx.hostTs + INVITE_EXPIRY_MAX_MS) return VAL('expiresAt');
  }
  const label = checkInviteLabel(p.label);
  if (!label.ok) return VAL(label.field);

  // 14 — R-26: convites **ativos** por comunidade.
  let ativos = 0;
  for (const i of ctx.draft.state.invites.values()) {
    if (i.revokedAt === undefined && (i.expiresAt === undefined || i.expiresAt > ctx.hostTs)) {
      ativos++;
    }
  }
  if (ativos >= MAX_ACTIVE_INVITES) return rj('E_LIMIT_EXCEEDED', undefined, MAX_ACTIVE_INVITES);
  const pkHex = p.invitePublicKey.toString('hex');
  if (ctx.draft.state.invites.has(pkHex)) return VAL('invitePublicKey');

  // 15
  ctx.draft.invites().set(pkHex, {
    createdBy: ctx.op.author,
    createdAt: ctx.hostTs,
    uses: 0,
    ...(p.expiresAt !== undefined ? { expiresAt: p.expiresAt } : {}),
    ...(p.maxUses !== undefined ? { maxUses: p.maxUses } : {}),
  });
  ctx.effects.push({
    t: 'upsert',
    table: 'invites',
    key: [p.invitePublicKey],
    row: {
      invite_public_key: p.invitePublicKey,
      created_by: ctx.op.author,
      created_at: ctx.hostTs,
      expires_at: p.expiresAt ?? null,
      max_uses: p.maxUses ?? null,
      uses: 0,
      revoked_at: null,
      // §8.6: o rótulo vai normalizado; o **segredo** nunca entra no log (§6.11).
      label: p.label === undefined ? null : label.value,
    },
  });
  ctx.effects.push({ t: 'notify', topic: 'invites.changed', data: {} });
  return null;
};

const inviteRevoke: Handler<'invite.revoke'> = (ctx, p) => {
  const pkHex = p.invitePublicKey.toString('hex');
  const inv = ctx.draft.state.invites.get(pkHex);
  if (inv === undefined) return rj('E_NOT_FOUND');
  if (inv.revokedAt !== undefined) {
    ctx.draft.touch(); // idempotente
    return null;
  }
  ctx.draft.invites().set(pkHex, { ...inv, revokedAt: ctx.hostTs });
  ctx.effects.push({
    t: 'patch',
    table: 'invites',
    key: [p.invitePublicKey],
    fields: { revoked_at: ctx.hostTs },
  });
  ctx.effects.push({ t: 'notify', topic: 'invites.changed', data: {} });
  audit(ctx, AUDIT.revokeInvite, pkHex, null, null);
  return null;
};

const relayVolunteer: Handler<'relay.volunteer'> = (ctx, p) => {
  if (p.relayPublicKey.length !== 32) return VAL('relayPublicKey');
  // R-19 — `expiresAt ≤ hostTs + RELAY_TTL_MS`, e TTL obrigatório (§6.14).
  if (p.expiresAt <= ctx.hostTs || p.expiresAt > ctx.hostTs + RELAY_TTL_MS) return VAL('expiresAt');
  // R-19 — `possession` verifica sobre `BLAKE2b('relay-possession/1' ‖ relayPublicKey)` com a
  // chave de identidade do autor. O prefixo entrou em §5.2 junto com esta linha: era a única
  // assinatura do sistema sobre bytes crus, e sem separação de domínio uma assinatura colhida
  // de outro contexto sobre os mesmos 32 bytes valeria aqui.
  if (
    !verifySignature(p.possession, relayPossessionSigningHash(p.relayPublicKey), ctx.op.author)
  ) {
    return VAL('possession');
  }

  ctx.draft.relays().set(ctx.authorHex, {
    relayPublicKey: p.relayPublicKey,
    expiresAt: p.expiresAt,
  });
  ctx.effects.push({
    t: 'upsert',
    table: 'relay_volunteers',
    key: [ctx.op.author],
    row: {
      identity_key: ctx.op.author,
      relay_public_key: p.relayPublicKey,
      since: ctx.hostTs,
      expires_at: p.expiresAt,
      withdrawn_at: null,
    },
  });
  return null;
};

const relayWithdraw: Handler<'relay.withdraw'> = (ctx) => {
  const r = ctx.draft.state.relays.get(ctx.authorHex);
  // §21.2: sem voluntariado (nunca voluntariou ou já retirado) ⇒ `APPLIED` idempotente silencioso.
  if (r === undefined || r.withdrawnAt !== undefined) {
    ctx.draft.touch();
    return null;
  }
  ctx.draft.relays().set(ctx.authorHex, { ...r, withdrawnAt: ctx.hostTs });
  ctx.effects.push({
    t: 'patch',
    table: 'relay_volunteers',
    key: [ctx.op.author],
    fields: { withdrawn_at: ctx.hostTs },
  });
  return null;
};

// ─── Tabela de handlers ─────────────────────────────────────────────────────────────────

const HANDLERS: Handlers = {
  'message.send': messageSend,
  'message.edit': messageEdit,
  'message.delete': messageDelete,
  'message.pin': messagePin,
  'reaction.set': reactionSet,
  'thread.create': threadCreate,

  'channel.create': channelCreate,
  'channel.update': channelUpdate,
  'channel.move': channelMove,
  'channel.delete': channelDelete,
  'category.create': categoryCreate,
  'category.rename': categoryRename,
  'category.delete': categoryDelete,

  'role.create': roleCreate,
  'role.update': roleUpdate,
  'role.move': roleMove,
  'role.delete': roleDelete,
  'member.setRoles': memberSetRoles,
  'member.join': memberJoin,
  'member.leave': memberLeave,
  'member.setNickname': memberSetNickname,
  'member.setBlobsCore': memberSetBlobsCore,
  'identity.update': identityUpdate,

  'mod.kick': modKick,
  'mod.ban': modBan,
  'mod.revokeBan': modRevokeBan,
  'mod.timeout': modTimeout,
  'mod.removeTimeout': modRemoveTimeout,

  'community.create': communityCreate,
  'community.update': communityUpdate,
  'community.end': communityEnd,
  'community.setSuccessors': communitySetSuccessors,
  'community.escrow': communityEscrow,
  'community.assumeHost': communityAssumeHost,
  'invite.create': inviteCreate,
  'invite.revoke': inviteRevoke,
  'relay.volunteer': relayVolunteer,
  'relay.withdraw': relayWithdraw,
};

const NOME_POR_NUMERO = new Map<number, KindName>(
  (Object.keys(KIND_POLICY) as KindName[]).map((n) => [KINDS[n], n]),
);
