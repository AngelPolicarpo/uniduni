// Snapshot do `DecisionState` — §10.6, e a regra de residência de §8.1.
//
// - Serializa o `DS` **exceto** `messages`/`rootOfThread` (§10.6).
// - Carrega o `foldBuildId`; se não bater, é **descartado** e o `fold` recomeça do 0.
//   Snapshot é cache, nunca verdade: a perda custa tempo de boot, nunca dado (§10.6).
// - `messages`/`rootOfThread` são rematerializados a partir de `view.db` (§8.1,
//   `residency = 'full'`) — leitura de chave primária sobre o **mesmo prefixo** que o
//   `fold` já interpretou, determinística e local.
//
// A serialização é JSON **canônico**: chaves ordenadas, mapas ordenados por chave. Sem
// isso, a ordem de inserção entraria no blob — um `DS` construído com snapshots serializaria
// numa ordem e o mesmo `DS` construído do zero noutra, e o teste de equivalência de §28.4
// (teste 3) acusaria falso positivo de divergência. É o mesmo cuidado do OBS-03 do POC-01.

import type { ViewDb } from '../../l0/view/index.ts';
import type {
  Category,
  Channel,
  DecisionState,
  Invite,
  Member,
  MessageMeta,
  Relay,
  Role,
} from '../../l1/fold/index.ts';
import { emptyRing, emptyState } from '../../l1/fold/index.ts';

const hex = (b: Buffer): string => b.toString('hex');
const buf = (s: string): Buffer => Buffer.from(s, 'hex');

/** JSON canônico — chaves ordenadas recursivamente, `undefined` não entra. */
function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

const sortedEntries = <V>(m: ReadonlyMap<string, V>): [string, V][] =>
  [...m].sort(([a], [b]) => (a < b ? -1 : 1));

/** §10.6 — o blob de `ds_snapshot`. Sem `messages`/`rootOfThread`. */
export function serializeDs(s: DecisionState): Buffer {
  const o = {
    communityId: s.communityId,
    communityKey: hex(s.communityKey),
    interpretedSeq: s.interpretedSeq,
    opVersionSeen: s.opVersionSeen,
    partialInterpretation: s.partialInterpretation,
    communityInvalid: s.communityInvalid,
    lastHostTs: s.lastHostTs,
    community: {
      exists: s.community.exists,
      hostKey: hex(s.community.hostKey),
      founderKey: hex(s.community.founderKey),
      blobsKey: hex(s.community.blobsKey),
      name: s.community.name,
      iconEmoji: s.community.iconEmoji,
      iconColor: s.community.iconColor,
      description: s.community.description,
      createdAt: s.community.createdAt,
      endedAt: s.community.endedAt,
      successorKeys: s.community.successorKeys.map(hex),
      originCommunityId: s.community.originCommunityId,
      originFinalSeq: s.community.originFinalSeq,
    },
    members: sortedEntries(s.members).map(([k, m]) => [
      k,
      {
        state: m.state,
        roleIds: [...m.roleIds].sort(),
        displayName: m.displayName,
        avatarColor: m.avatarColor,
        nickname: m.nickname,
        // L-5 (§6.1) — a marca é derivada do CONJUNTO ATIVO inteiro, não do registro corrente:
        // um `DS` reidratado sem ela não a recupera sozinho, porque nenhum registro futuro
        // recalcula os membros que já estavam lá. Fora do blob, toda leitura de §15.6 passava a
        // dizer `collision: false` depois do primeiro boot que herdasse snapshot.
        displayNameCollision: m.displayNameCollision,
        blobsCoreKey: m.blobsCoreKey !== undefined ? hex(m.blobsCoreKey) : undefined,
        joinedAt: m.joinedAt,
        leftAt: m.leftAt,
        timeoutUntil: m.timeoutUntil,
        bannedAt: m.bannedAt,
        bannedBy: m.bannedBy !== undefined ? hex(m.bannedBy) : undefined,
        preBan: m.preBan,
        storageUsedBytes: m.storageUsedBytes,
        opBudget: m.opBudget,
      },
    ]),
    roles: sortedEntries(s.roles).map(([k, r]) => [
      k,
      {
        name: r.name,
        color: r.color,
        rank: r.rank,
        permissions: [...r.permissions].sort((a, b) => a - b),
        mentionable: r.mentionable,
        isFounder: r.isFounder,
        isDefault: r.isDefault,
        deletedAt: r.deletedAt,
      },
    ]),
    categories: sortedEntries(s.categories).map(([k, c]) => [k, { ...c }]),
    channels: sortedEntries(s.channels).map(([k, c]) => [
      k,
      { ...c, readOnlyForRoleIds: [...c.readOnlyForRoleIds].sort() },
    ]),
    channelNameIndex: sortedEntries(s.channelNameIndex),
    invites: sortedEntries(s.invites).map(([k, i]) => [
      k,
      { ...i, createdBy: hex(i.createdBy) },
    ]),
    joinedByInvite: [...s.joinedByInvite].sort(),
    lastAuthorSeq: sortedEntries(s.lastAuthorSeq),
    relays: sortedEntries(s.relays).map(([k, r]) => [
      k,
      { ...r, relayPublicKey: hex(r.relayPublicKey) },
    ]),
  };
  return Buffer.from(canonicalJson(o), 'utf8');
}

type SerMember = {
  state: Member['state'];
  roleIds: string[];
  displayName: string;
  avatarColor: number;
  nickname?: string;
  /** §6.1 L-5 — ver `serializeDs`. */
  displayNameCollision?: true;
  blobsCoreKey?: string;
  joinedAt: number;
  leftAt?: number;
  timeoutUntil?: number;
  bannedAt?: number;
  bannedBy?: string;
  /** R-28 — linha criada por ban preventivo; quem a carrega nunca esteve `active`. */
  preBan?: true;
  storageUsedBytes: number;
  opBudget: Member['opBudget'];
};

export function deserializeDs(blob: Buffer): DecisionState {
  const o = JSON.parse(blob.toString('utf8')) as Record<string, unknown>;
  const s = emptyState(buf(o['communityKey'] as string), o['communityId'] as string);
  s.interpretedSeq = o['interpretedSeq'] as number;
  s.opVersionSeen = o['opVersionSeen'] as number;
  s.partialInterpretation = o['partialInterpretation'] as boolean;
  s.communityInvalid = o['communityInvalid'] as boolean;
  s.lastHostTs = o['lastHostTs'] as number;
  const c = o['community'] as Record<string, unknown>;
  s.community = {
    exists: c['exists'] as boolean,
    hostKey: buf(c['hostKey'] as string),
    founderKey: buf(c['founderKey'] as string),
    blobsKey: buf(c['blobsKey'] as string),
    name: c['name'] as string,
    ...(c['iconEmoji'] !== undefined ? { iconEmoji: c['iconEmoji'] as string } : {}),
    iconColor: c['iconColor'] as number,
    ...(c['description'] !== undefined ? { description: c['description'] as string } : {}),
    createdAt: c['createdAt'] as number,
    ...(c['endedAt'] !== undefined ? { endedAt: c['endedAt'] as number } : {}),
    successorKeys: (c['successorKeys'] as string[]).map(buf),
    ...(c['originCommunityId'] !== undefined ? { originCommunityId: c['originCommunityId'] as string } : {}),
    ...(c['originFinalSeq'] !== undefined ? { originFinalSeq: c['originFinalSeq'] as number } : {}),
  };
  for (const [k, m] of o['members'] as unknown as [string, SerMember][]) {
    const ring = m.opBudget ?? emptyRing();
    s.members.set(k, {
      state: m.state,
      roleIds: new Set(m.roleIds),
      displayName: m.displayName,
      avatarColor: m.avatarColor,
      ...(m.nickname !== undefined ? { nickname: m.nickname } : {}),
      ...(m.displayNameCollision === true ? { displayNameCollision: true as const } : {}),
      ...(m.blobsCoreKey !== undefined ? { blobsCoreKey: buf(m.blobsCoreKey) } : {}),
      joinedAt: m.joinedAt,
      ...(m.leftAt !== undefined ? { leftAt: m.leftAt } : {}),
      ...(m.timeoutUntil !== undefined ? { timeoutUntil: m.timeoutUntil } : {}),
      ...(m.bannedAt !== undefined ? { bannedAt: m.bannedAt } : {}),
      ...(m.bannedBy !== undefined ? { bannedBy: buf(m.bannedBy) } : {}),
      ...(m.preBan === true ? { preBan: true as const } : {}),
      storageUsedBytes: m.storageUsedBytes,
      opBudget: ring,
      byteBudget: ring,
    });
  }
  for (const [k, r] of o['roles'] as unknown as [string, Record<string, unknown>][]) {
    s.roles.set(k, {
      ...(r as unknown as Role),
      permissions: new Set(r['permissions'] as number[]),
    });
  }
  for (const [k, c] of o['categories'] as unknown as [string, Record<string, unknown>][]) {
    s.categories.set(k, { ...(c as unknown as Category) });
  }
  for (const [k, c] of o['channels'] as unknown as [string, Record<string, unknown>][]) {
    s.channels.set(k, { ...(c as unknown as Channel), readOnlyForRoleIds: new Set(c['readOnlyForRoleIds'] as string[]) });
  }
  for (const [k, v] of o['channelNameIndex'] as unknown as [string, string][]) s.channelNameIndex.set(k, v);
  for (const [k, i] of o['invites'] as unknown as [string, Record<string, unknown>][]) {
    s.invites.set(k, { ...(i as unknown as Invite), createdBy: buf(i['createdBy'] as string) });
  }
  for (const p of o['joinedByInvite'] as unknown as string[]) s.joinedByInvite.add(p);
  for (const [k, v] of o['lastAuthorSeq'] as unknown as [string, number][]) s.lastAuthorSeq.set(k, v);
  for (const [k, r] of o['relays'] as unknown as [string, Record<string, unknown>][]) {
    s.relays.set(k, { ...(r as unknown as Relay), relayPublicKey: buf(r['relayPublicKey'] as string) });
  }
  return s;
}

/**
 * §8.1, regra de residência — rematerializa `messages` e `rootOfThread` a partir de
 * `view.db`, que os materializa. Leitura de chave primária sobre o **mesmo prefixo** que o
 * `fold` já interpretou; o oráculo de §28.4 teste 3 depende disto ser fiel.
 */
export function loadMessagesFromView(view: ViewDb, communityId: string, s: DecisionState): void {
  const rows = view.prepare(
    'SELECT id, channel_id, author_key, deleted_at, pinned, thread_id, hidden_by_ban, orphaned FROM messages WHERE community_id = ? ORDER BY id',
  ).all(communityId) as Array<{
    id: string;
    channel_id: string;
    author_key: Buffer;
    deleted_at: number | null;
    pinned: number;
    thread_id: string | null;
    hidden_by_ban: number;
    orphaned: number;
  }>;
  const attachments = new Map<string, number>();
  for (const r of view
    .prepare('SELECT message_id, size_bytes FROM attachments WHERE community_id = ?')
    .all(communityId) as Array<{ message_id: string; size_bytes: number }>) {
    attachments.set(r.message_id, r.size_bytes);
  }
  // §6.9 / §8.1 — `reactions` do `DS` é `emoji → identidades`, e a PK da tabela de §10.3 é
  // exatamente `(message_id, emoji, identity_key)`. Reconstruir com o reagente (e não só com
  // `DISTINCT emoji`) é o que faz o `DS` reidratado ser **a mesma função** do `DS` foldado do
  // `seq` 0: com o conjunto de emojis sem dono, a última remoção de uma reação sumia aqui e
  // não sumia lá, e R-23 decidia diferente conforme a origem do estado.
  const reacoes = new Map<string, Map<string, Set<string>>>();
  for (const r of view
    .prepare('SELECT message_id, emoji, identity_key FROM reactions WHERE community_id = ?')
    .all(communityId) as Array<{ message_id: string; emoji: string; identity_key: Buffer }>) {
    let porEmoji = reacoes.get(r.message_id);
    if (porEmoji === undefined) {
      porEmoji = new Map();
      reacoes.set(r.message_id, porEmoji);
    }
    let reagentes = porEmoji.get(r.emoji);
    if (reagentes === undefined) {
      reagentes = new Set();
      porEmoji.set(r.emoji, reagentes);
    }
    reagentes.add(r.identity_key.toString('hex'));
  }
  s.messages.clear();
  for (const r of rows) {
    const bytes = attachments.get(r.id);
    const meta: MessageMeta = {
      channelId: r.channel_id,
      authorKey: r.author_key.toString('hex'),
      ...(r.deleted_at !== null ? { deletedAt: r.deleted_at } : {}),
      pinned: r.pinned === 1,
      ...(r.thread_id !== null ? { threadId: r.thread_id } : {}),
      hasAttachment: bytes !== undefined,
      attachmentBytes: bytes ?? 0,
      reactions: reacoes.get(r.id) ?? new Map(),
      hiddenByBan: r.hidden_by_ban === 1,
      orphaned: r.orphaned === 1,
    };
    s.messages.set(r.id, meta);
  }
  s.rootOfThread.clear();
  for (const r of view
    .prepare('SELECT id, root_message_id FROM threads WHERE community_id = ?')
    .all(communityId) as Array<{ id: string; root_message_id: string }>) {
    s.rootOfThread.set(r.id, r.root_message_id);
  }
}

export type SnapshotRow = {
  interpretedSeq: number;
  blob: Buffer;
  foldBuildId: string;
  takenAt: number;
};

export function saveSnapshot(view: ViewDb, communityId: string, s: DecisionState, foldBuildId: string, at: number): void {
  view
    .prepare(
      'INSERT OR REPLACE INTO ds_snapshot(community_id, interpreted_seq, blob, fold_build_id, taken_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(communityId, s.interpretedSeq, serializeDs(s), foldBuildId, at);
}

/**
 * Devolve `null` quando não há snapshot, quando o `foldBuildId` não bate (§10.6) ou quando
 * o blob não decodifica — em todos os casos o `fold` recomeça do `seq` 0 (§10.3).
 */
export function loadSnapshot(view: ViewDb, communityId: string, foldBuildId: string): DecisionState | null {
  // Os `AS` não são cosméticos: `ViewDb.prepare` devolve o statement cru do driver, que nomeia
  // as colunas como o SQL as nomeia. Sem eles, `row.foldBuildId` e `row.interpretedSeq` eram
  // sempre `undefined`, a comparação de procedência falhava para **todo** snapshot válido e o
  // boot caía sempre na reprojeção total — §10.6 existia sem nunca acelerar boot nenhum.
  const row = view
    .prepare(
      'SELECT interpreted_seq AS interpretedSeq, blob, fold_build_id AS foldBuildId, taken_at AS takenAt FROM ds_snapshot WHERE community_id = ?',
    )
    .get(communityId) as SnapshotRow | undefined;
  if (row === undefined) return null;
  if (row.foldBuildId !== foldBuildId) return null;
  try {
    const s = deserializeDs(row.blob);
    if (
      s.interpretedSeq !== row.interpretedSeq ||
      s.communityId !== communityId ||
      s.communityKey.toString('hex') !== communityId
    ) {
      return null;
    }
    loadMessagesFromView(view, communityId, s);
    return s;
  } catch {
    return null; // snapshot inconsistente ⇒ recomeça do seq 0 (§10.3)
  }
}
