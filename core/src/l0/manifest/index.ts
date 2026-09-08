// `manifest` — L0. Estado local durável de §10.2 e §11.2.
//
// Este módulo conhece apenas armazenamento local. A regra de domínio da outbox vive em L2;
// aqui ficam o schema, as transações e a ordem local persistida.

import Database from 'better-sqlite3';
import crypto from 'node:crypto';

export type OutboxState = 'queued' | 'sending' | 'awaiting-confirmation' | 'failed' | 'dropped';

export type DropReason =
  | 'channel-deleted'
  | 'community-ended'
  | 'left-community'
  | 'banned'
  | 'kicked'
  | 'permission-lost'
  | 'expired'
  | 'client-outdated'
  | 'cancelled';

export type OutboxRow = {
  readonly local_seq: number;
  readonly op_id: string;
  readonly community_id: string;
  readonly channel_id: string | null;
  readonly sequence_scope: string;
  readonly kind: number;
  readonly author_seq: number;
  readonly envelope: Buffer;
  readonly client_ref: string | null;
  readonly created_at: number;
  readonly attempts: number;
  readonly next_attempt_at: number;
  readonly state: OutboxState;
  readonly acked_seq: number | null;
  readonly last_error: string | null;
  readonly dropped_reason: DropReason | null;
};

export type EnqueueInput = {
  readonly opId: string;
  readonly communityId: string;
  readonly channelId: string | null;
  readonly sequenceScope: string;
  readonly kind: number;
  readonly authorSeq: number;
  readonly envelope: Buffer;
  readonly clientRef: string | null;
  readonly now: number;
};

export type EnqueueResult = { readonly enqueued: boolean; readonly localSeq: number | null };

/** §31.12 — os cinco estados de `dm_conversations.state`. A transição é de L2 (§31.9). */
export type DmConversationState = 'pending-out' | 'pending-in' | 'accepted' | 'blocked' | 'left';

export type DmConversationInput = {
  readonly conversationId: string;
  readonly peerKey: Buffer;
  readonly selfCoreKey: Buffer;
  readonly selfCoreSeedEnc?: Buffer | null;
  readonly peerCoreKey?: Buffer | null;
  readonly state: DmConversationState;
  readonly createdAt: number;
  readonly acceptedAt?: number | null;
  readonly blockedAt?: number | null;
  readonly selfHighWater: number;
  readonly forgottenSelfLength?: number | null;
  readonly forgottenPeerLength?: number | null;
  readonly removedAt?: number | null;
  readonly retainUntil?: number | null;
};

export type DmConversationRow = {
  readonly conversation_id: string;
  readonly peer_key: Buffer;
  readonly self_core_key: Buffer;
  readonly self_core_seed_enc: Buffer | null;
  readonly peer_core_key: Buffer | null;
  readonly state: DmConversationState;
  readonly created_at: number;
  readonly accepted_at: number | null;
  readonly blocked_at: number | null;
  readonly self_high_water: number;
  readonly forgotten_self_length: number | null;
  readonly forgotten_peer_length: number | null;
  readonly removed_at: number | null;
  readonly retain_until: number | null;
};

export type DmReadStateRow = {
  readonly conversation_id: string;
  readonly last_read_ord_sum: number;
  readonly last_read_author: Buffer;
  readonly unread_count: number;
};

const PRAGMAS: readonly (readonly [string, string | number])[] = [
  ['journal_mode', 'WAL'],
  ['synchronous', 'FULL'],
  ['foreign_keys', 'OFF'],
  ['busy_timeout', 5000],
  ['temp_store', 'MEMORY'],
  ['cache_size', -8000],
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS local_outbox (
  local_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id TEXT UNIQUE NOT NULL,
  community_id TEXT NOT NULL,
  channel_id TEXT,
  sequence_scope TEXT NOT NULL,
  kind INT NOT NULL,
  author_seq INT NOT NULL,
  envelope BLOB NOT NULL,
  client_ref TEXT,
  created_at INT NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  next_attempt_at INT NOT NULL,
  state TEXT NOT NULL,
  acked_seq INT,
  last_error TEXT,
  dropped_reason TEXT);
CREATE INDEX IF NOT EXISTS idx_outbox_ready
  ON local_outbox(community_id, state, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_outbox_channel
  ON local_outbox(community_id, channel_id, local_seq);

CREATE TABLE IF NOT EXISTS local_author_seq (
  community_id TEXT NOT NULL,
  sequence_scope TEXT NOT NULL,
  next_author_seq INT NOT NULL,
  PRIMARY KEY (community_id, sequence_scope));

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS secrets (
  name TEXT PRIMARY KEY,
  ciphertext BLOB NOT NULL,
  nonce BLOB
);

CREATE TABLE IF NOT EXISTS communities (
  community_id TEXT PRIMARY KEY,
  core_key BLOB NOT NULL,
  blobs_key BLOB NOT NULL,
  community_seed_enc BLOB,
  community_seed_nonce BLOB,
  is_host INTEGER NOT NULL,
  joined_at INTEGER NOT NULL,
  left_at INTEGER,
  removed_reason TEXT,
  retain_until INTEGER,
  origin_community_id TEXT
);

CREATE TABLE IF NOT EXISTS member_blobs_core (
  community_id TEXT PRIMARY KEY,
  core_key BLOB,
  secret_seed_enc BLOB
);

CREATE TABLE IF NOT EXISTS invite_secrets (
  invite_public_key BLOB PRIMARY KEY,
  community_id TEXT,
  secret BLOB,
  label TEXT
);

CREATE TABLE IF NOT EXISTS local_read_state (
  community_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  last_read_seq INTEGER NOT NULL,
  first_unread_seq INTEGER,
  unread_count INTEGER NOT NULL,
  pending_mentions INTEGER NOT NULL,
  PRIMARY KEY (community_id, channel_id)
);

CREATE TABLE IF NOT EXISTS local_thread_read_state (
  community_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  last_read_seq INTEGER NOT NULL,
  unread_count INTEGER NOT NULL,
  PRIMARY KEY (community_id, thread_id)
);

CREATE TABLE IF NOT EXISTS local_channel_pref (
  channel_id TEXT PRIMARY KEY,
  muted INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS local_community_pref (
  community_id TEXT PRIMARY KEY,
  notification_level TEXT,
  collapsed_categories TEXT,
  recent_channels TEXT,
  last_host_seen_at INTEGER
);

CREATE TABLE IF NOT EXISTS local_navigation (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS local_relay_consent (
  community_id TEXT PRIMARY KEY,
  decision TEXT NOT NULL,
  at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS local_device_pref (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS local_participant_volume (
  community_id TEXT NOT NULL,
  identity_key BLOB NOT NULL,
  volume INTEGER NOT NULL,
  PRIMARY KEY (community_id, identity_key)
);

CREATE TABLE IF NOT EXISTS local_blob_cache (
  blobs_core_key BLOB NOT NULL,
  blob_id_hex TEXT NOT NULL,
  bytes_downloaded INTEGER NOT NULL,
  state TEXT NOT NULL,
  path TEXT,
  verified_at INTEGER,
  declared_size INTEGER,
  PRIMARY KEY (blobs_core_key, blob_id_hex)
);

CREATE TABLE IF NOT EXISTS local_blob_staging (
  ticket_id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  bytes_written INTEGER NOT NULL,
  rolling_hash_state BLOB,
  state TEXT NOT NULL,
  community_id TEXT,
  size_bytes INTEGER,
  name TEXT,
  kind INTEGER,
  hash BLOB,
  created_at INTEGER
);

-- ─── §31.12 — conversa direta (LS, nunca apagado por reprojeção) ───────────────────────
--
-- As três tabelas de manifest.db. Elas NÃO seguem a regra de view.db: aqui o banco é
-- Estado Local, synchronous=FULL, e nada disto é recomputável do log. dm_conversations é
-- **a enumeração autoritativa de conversas** (§31.12), e self_high_water é a detecção de
-- perda local de §31.13 — B56 cria a coluna; quem a escreve antes de cada append é B57.
--
-- Não existe dm_author_seq (§31.12): o contador é core.length + 1, recuperado do próprio
-- core no boot (RD-3). Uma tabela a menos do que a comunidade precisa.

CREATE TABLE IF NOT EXISTS dm_conversations (
  conversation_id TEXT PRIMARY KEY,
  peer_key BLOB NOT NULL,
  self_core_key BLOB NOT NULL,
  self_core_seed_enc BLOB,
  peer_core_key BLOB,
  state TEXT NOT NULL,
  created_at INT NOT NULL,
  accepted_at INT,
  blocked_at INT,
  self_high_water INT NOT NULL,
  forgotten_self_length INT,
  forgotten_peer_length INT,
  removed_at INT,
  retain_until INT
);
CREATE INDEX IF NOT EXISTS idx_dm_conv_peer ON dm_conversations(peer_key);
CREATE INDEX IF NOT EXISTS idx_dm_conv_state ON dm_conversations(state);

CREATE TABLE IF NOT EXISTS dm_local_read_state (
  conversation_id TEXT PRIMARY KEY,
  last_read_ord_sum INT NOT NULL,
  last_read_author BLOB NOT NULL,
  unread_count INT NOT NULL
);

CREATE TABLE IF NOT EXISTS dm_prefs (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * `3` — as três tabelas de conversa direta de §31.12 (B56). O bump é declaratório: o
 * `CREATE TABLE IF NOT EXISTS` acrescenta as tabelas num `manifest.db` existente sem tocar
 * em nada, porque `manifest.db` é Estado Local e **nunca** é apagado por reprojeção. O
 * número existe para que um binário mais velho recuse abrir um banco mais novo, que é a
 * única coisa que a comparação de versão faz aqui.
 */
export const MANIFEST_SCHEMA_VERSION = '3';

function channelKey(channelId: string | null): string {
  return channelId ?? '';
}

export class ManifestDb {
  readonly #db: Database.Database;
  /** Caminho do arquivo — o que `db.maintenance` precisa para medir o WAL (§22.2). */
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    this.#db = new Database(path);
    for (const [key, value] of PRAGMAS) this.#db.pragma(`${key} = ${value}`);
    this.#db.exec(SCHEMA);
    const outboxColumns = this.#db.pragma('table_info(local_outbox)') as Array<{ name: string }>;
    const authorSeqColumns = this.#db.pragma('table_info(local_author_seq)') as Array<{ name: string }>;
    if (!outboxColumns.some((column) => column.name === 'sequence_scope') || !authorSeqColumns.some((column) => column.name === 'sequence_scope')) {
      throw new Error('manifest schema requires the scoped authorSeq migration');
    }
    // Migração incremental de fase 5 — staging por ticket (A15) + ownership por autor (A09)
    // DBs criados antes de 4709493 têm local_blob_staging com 5 colunas; novos têm 11.
    // ALTER é idempotente e preserva dados existentes.
    const stagingCols = this.#db.pragma('table_info(local_blob_staging)') as Array<{ name: string }>;
    const stagingNames = new Set(stagingCols.map((c) => c.name));
    const addStagingCol = (col: string, def: string): void => {
      if (!stagingNames.has(col)) this.#db.exec(`ALTER TABLE local_blob_staging ADD COLUMN ${col} ${def}`);
    };
    addStagingCol('community_id', 'TEXT');
    addStagingCol('size_bytes', 'INTEGER');
    addStagingCol('name', 'TEXT');
    addStagingCol('kind', 'INTEGER');
    addStagingCol('hash', 'BLOB');
    addStagingCol('created_at', 'INTEGER');
    // §13.5/§22.4 — a faixa de blocos que o stage escreveu no core do autor; é o que deixa
    // o `core.clear` do GC preciso (anexos vivos no mesmo core não são tocados).
    addStagingCol('blob_ranges', 'TEXT');
    const version = this.metaGet('manifest_schema_version');
    if (version !== null && Number(version) > Number(MANIFEST_SCHEMA_VERSION)) {
      throw Object.assign(new Error('manifest schema is ahead of this binary'), { code: 'E_SCHEMA_AHEAD' });
    }
    if (version === null) this.metaSet('manifest_schema_version', MANIFEST_SCHEMA_VERSION);
  }

  get raw(): Database.Database {
    return this.#db;
  }

  pragma(name: string): unknown {
    return this.#db.pragma(name);
  }

  /** Consome um número somente no escopo persistido; números queimados são permitidos. */
  /**
   * §7.5 — fixa o contador em `next` sem entregar número nenhum. É o caso da gênese
   * (§19.1): os `authorSeq` 1..6 do fundador foram consumidos direto no core, fora da
   * ponte de submissão; sem isto, o primeiro op síncrono reusaria o 1 e viraria E_DUPLICATE.
   */
  advanceAuthorSeq(communityId: string, sequenceScope: string, next: number): void {
    this.#db
      .prepare(
        'INSERT INTO local_author_seq(community_id, sequence_scope, next_author_seq) VALUES (?, ?, ?) ' +
          'ON CONFLICT(community_id, sequence_scope) DO UPDATE SET next_author_seq = MAX(next_author_seq, excluded.next_author_seq)',
      )
      .run(communityId, sequenceScope, next);
  }

  nextAuthorSeq(communityId: string, sequenceScope: string): number {
    const tx = this.#db.transaction((cid: string, scope: string): number => {
      const row = this.#db
        .prepare('SELECT next_author_seq AS n FROM local_author_seq WHERE community_id = ? AND sequence_scope = ?')
        .get(cid, scope) as { n: number } | undefined;
      const n = row?.n ?? 1;
      this.#db
        .prepare(
          'INSERT INTO local_author_seq(community_id, sequence_scope, next_author_seq) VALUES (?, ?, ?) ' +
            'ON CONFLICT(community_id, sequence_scope) DO UPDATE SET next_author_seq = excluded.next_author_seq',
        )
        .run(cid, scope, n + 1);
      return n;
    });
    return tx(communityId, sequenceScope);
  }

  /** Grava o envelope completo de forma durável e idempotente por `op_id`. */
  enqueue(item: EnqueueInput): EnqueueResult {
    const tx = this.#db.transaction(() => {
      const result = this.#db
        .prepare(
          'INSERT OR IGNORE INTO local_outbox(op_id, community_id, channel_id, sequence_scope, kind, author_seq, ' +
            'envelope, client_ref, created_at, attempts, next_attempt_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, \'queued\')',
        )
        .run(
          item.opId,
          item.communityId,
          item.channelId,
          item.sequenceScope,
          item.kind,
          item.authorSeq,
          item.envelope,
          item.clientRef,
          item.now,
          item.now,
        );
      return result.changes > 0 ? Number(result.lastInsertRowid) : null;
    });
    const localSeq = tx();
    return { enqueued: localSeq !== null, localSeq };
  }

  /**
   * Retorna a cabeça pronta de cada canal, agrupada por canal. Um estado não pronto bloqueia
   * somente o próprio canal; `sending` já ocupado também não é duplicado.
   */
  ready(communityId: string, now: number, maxPerChannel: number): Map<string, OutboxRow[]> {
    const readyRows = this.#db
      .prepare(
        "SELECT * FROM local_outbox WHERE community_id = ? AND state = 'queued' AND next_attempt_at <= ? ORDER BY local_seq",
      )
      .all(communityId, now) as OutboxRow[];
    const readyIds = new Set(readyRows.map((row) => row.local_seq));
    const occupied = new Set(
      (
        this.#db
          .prepare("SELECT DISTINCT channel_id FROM local_outbox WHERE community_id = ? AND state = 'sending'")
          .all(communityId) as Array<{ channel_id: string | null }>
      ).map((row) => channelKey(row.channel_id)),
    );
    const rows = this.#db
      .prepare("SELECT * FROM local_outbox WHERE community_id = ? AND state != 'dropped' ORDER BY local_seq")
      .all(communityId) as OutboxRow[];
    const blocked = new Set<string>();
    const groups = new Map<string, OutboxRow[]>();
    for (const row of rows) {
      const key = channelKey(row.channel_id);
      if (occupied.has(key) || blocked.has(key)) continue;
      if (row.state !== 'queued' || !readyIds.has(row.local_seq)) {
        blocked.add(key);
        continue;
      }
      const group = groups.get(key) ?? [];
      if (group.length >= maxPerChannel) {
        blocked.add(key);
        continue;
      }
      group.push(row);
      groups.set(key, group);
    }
    return groups;
  }

  all(communityId: string): OutboxRow[] {
    return this.#db.prepare('SELECT * FROM local_outbox WHERE community_id = ? ORDER BY local_seq').all(communityId) as OutboxRow[];
  }

  byOpId(opId: string): OutboxRow | undefined {
    return this.#db.prepare('SELECT * FROM local_outbox WHERE op_id = ?').get(opId) as OutboxRow | undefined;
  }

  countActive(communityId: string): number {
    return (
      this.#db
        .prepare("SELECT COUNT(*) AS n FROM local_outbox WHERE community_id = ? AND state != 'dropped'")
        .get(communityId) as { n: number }
    ).n;
  }

  setState(localSeq: number, state: OutboxState, extra: Partial<Pick<OutboxRow, 'acked_seq' | 'last_error' | 'dropped_reason' | 'attempts' | 'next_attempt_at'>> = {}): void {
    const fields: string[] = ['state = ?'];
    const values: unknown[] = [state];
    for (const field of ['acked_seq', 'last_error', 'dropped_reason', 'attempts', 'next_attempt_at'] as const) {
      if (Object.hasOwn(extra, field)) {
        fields.push(`${field} = ?`);
        values.push(extra[field]);
      }
    }
    values.push(localSeq);
    this.#db.prepare(`UPDATE local_outbox SET ${fields.join(', ')} WHERE local_seq = ?`).run(...values);
  }

  /** Recupera somente estados que pertenciam ao processo encerrado. */
  recoverSending(now: number): number {
    return this.#db
      .prepare("UPDATE local_outbox SET state = 'queued', next_attempt_at = ? WHERE state = 'sending'")
      .run(now).changes;
  }

  remove(localSeq: number): void {
    this.#db.prepare('DELETE FROM local_outbox WHERE local_seq = ?').run(localSeq);
  }

  metaGet(key: string): string | null {
    const row = this.#db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  metaSet(key: string, value: string): void {
    this.#db
      .prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  // --- secrets (§10.2) -----------------------------------------------------------

  setSecret(name: string, ciphertext: Buffer, nonce: Buffer | null = null): void {
    this.#db
      .prepare('INSERT INTO secrets(name, ciphertext, nonce) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext, nonce = excluded.nonce')
      .run(name, ciphertext, nonce);
  }

  getSecret(name: string): { ciphertext: Buffer; nonce: Buffer | null } | null {
    const row = this.#db.prepare('SELECT ciphertext, nonce FROM secrets WHERE name = ?').get(name) as
      | { ciphertext: Buffer; nonce: Buffer | null }
      | undefined;
    return row ?? null;
  }

  deleteSecret(name: string): void {
    this.#db.prepare('DELETE FROM secrets WHERE name = ?').run(name);
  }

  hasSecret(name: string): boolean {
    const row = this.#db.prepare('SELECT 1 FROM secrets WHERE name = ?').get(name) as unknown | undefined;
    return row !== undefined;
  }

  // --- local_relay_consent (§6.15 — estado local, nunca replica) ------------------

  /** Decisão persistida do consentimento de relay; `null` quando nunca perguntado. */
  getRelayConsent(communityId: string): { decision: 'accepted' | 'declined'; at: number } | null {
    const row = this.#db
      .prepare('SELECT decision, at FROM local_relay_consent WHERE community_id = ?')
      .get(communityId) as { decision: string; at: number } | undefined;
    if (row === undefined) return null;
    if (row.decision !== 'accepted' && row.decision !== 'declined') return null;
    return { decision: row.decision, at: row.at };
  }

  setRelayConsent(communityId: string, decision: 'accepted' | 'declined', at: number): void {
    this.#db
      .prepare(
        'INSERT INTO local_relay_consent(community_id, decision, at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(community_id) DO UPDATE SET decision = excluded.decision, at = excluded.at',
      )
      .run(communityId, decision, at);
  }

  forgetRelayConsent(communityId: string): void {
    this.#db.prepare('DELETE FROM local_relay_consent WHERE community_id = ?').run(communityId);
  }

  listRelayConsents(): Array<{ communityId: string; decision: 'accepted' | 'declined'; at: number }> {
    const rows = this.#db.prepare('SELECT community_id AS communityId, decision, at FROM local_relay_consent').all() as Array<{
      communityId: string;
      decision: string;
      at: number;
    }>;
    return rows.filter((r): r is { communityId: string; decision: 'accepted' | 'declined'; at: number } => r.decision === 'accepted' || r.decision === 'declined');
  }

  // --- wipe_state (§18.6, §10.8) ------------------------------------------------

  getWipeState(): string {
    return this.metaGet('wipe_state') ?? 'none';
  }  setWipeState(state: string): void {
    this.metaSet('wipe_state', state);
  }

  // --- install_id (§10.8) ------------------------------------------------------

  getInstallId(): string | null {
    return this.metaGet('install_id');
  }

  setInstallId(id: string): void {
    this.metaSet('install_id', id);
  }

  ensureInstallId(): string {
    let id = this.getInstallId();
    if (id === null || id.length === 0) {
      id = crypto.randomBytes(16).toString('hex');
      this.setInstallId(id);
    }
    return id;
  }

  // --- communities (§10.2) -----------------------------------------------------

  upsertCommunity(row: {
    communityId: string;
    coreKey: Buffer;
    blobsKey: Buffer;
    communitySeedEnc?: Buffer | null;
    communitySeedNonce?: Buffer | null;
    isHost: boolean;
    joinedAt: number;
    leftAt?: number | null;
    removedReason?: string | null;
    retainUntil?: number | null;
    originCommunityId?: string | null;
  }): void {
    this.#db
      .prepare(
        'INSERT INTO communities(community_id, core_key, blobs_key, community_seed_enc, community_seed_nonce, is_host, joined_at, left_at, removed_reason, retain_until, origin_community_id) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(community_id) DO UPDATE SET core_key = excluded.core_key, blobs_key = excluded.blobs_key, community_seed_enc = excluded.community_seed_enc, community_seed_nonce = excluded.community_seed_nonce, is_host = excluded.is_host, joined_at = excluded.joined_at, left_at = excluded.left_at, removed_reason = excluded.removed_reason, retain_until = excluded.retain_until, origin_community_id = excluded.origin_community_id',
      )
      .run(
        row.communityId,
        row.coreKey,
        row.blobsKey,
        row.communitySeedEnc ?? null,
        row.communitySeedNonce ?? null,
        row.isHost ? 1 : 0,
        row.joinedAt,
        row.leftAt ?? null,
        row.removedReason ?? null,
        row.retainUntil ?? null,
        row.originCommunityId ?? null,
      );
  }

  getCommunity(communityId: string): unknown | null {
    const row = this.#db.prepare('SELECT * FROM communities WHERE community_id = ?').get(communityId) as unknown | undefined;
    return row ?? null;
  }

  /** §11.1 exceção — saída local imediata: marca `left_at` na linha da comunidade. */
  markCommunityLeft(communityId: string, leftAt: number): void {
    this.#db.prepare('UPDATE communities SET left_at = ? WHERE community_id = ?').run(leftAt, communityId);
  }

  /**
   * §18.4 passo 2 — a réplica entra em modo histórico: motivo nomeado e prazo de guarda.
   * As três colunas são gravadas juntas porque as três são a mesma decisão; deixar
   * `retain_until` para depois criaria a janela em que `removed.purge` não sabe o prazo e a
   * réplica ficaria para sempre.
   */
  marcarRemovida(communityId: string, a: { reason: string; leftAt: number; retainUntil: number }): void {
    this.#db
      .prepare('UPDATE communities SET left_at = ?, removed_reason = ?, retain_until = ? WHERE community_id = ?')
      .run(a.leftAt, a.reason, a.retainUntil, communityId);
  }

  /**
   * §5.3 passo 2 — a linha órfã de uma criação que morreu entre gravar a semente e criar o
   * core é **descartada**, não marcada: nunca houve comunidade ali. Também usada pelo
   * rollback de `community.create` quando o append da gênese falha (§19.1 "Falhas").
   */
  deleteCommunity(communityId: string): void {
    this.#db.prepare('DELETE FROM communities WHERE community_id = ?').run(communityId);
  }

  /**
   * Core de blobs local do membro (§13.1, §10.2): a semente cifrada pela Data Key é o que
   * torna o core recuperável sem depender de estado em memória. `community.create` grava a
   * linha do fundador; `invite.redeem`, a de quem entra.
   */
  setMemberBlobsCore(row: { communityId: string; coreKey: Buffer; secretSeedEnc: Buffer }): void {
    this.#db
      .prepare(
        'INSERT INTO member_blobs_core(community_id, core_key, secret_seed_enc) VALUES (?, ?, ?) ' +
          'ON CONFLICT(community_id) DO UPDATE SET core_key = excluded.core_key, secret_seed_enc = excluded.secret_seed_enc',
      )
      .run(row.communityId, row.coreKey, row.secretSeedEnc);
  }

  getMemberBlobsCore(communityId: string): { communityId: string; coreKey: Buffer; secretSeedEnc: Buffer } | null {
    const row = this.#db
      .prepare('SELECT community_id AS communityId, core_key AS coreKey, secret_seed_enc AS secretSeedEnc FROM member_blobs_core WHERE community_id = ?')
      .get(communityId) as { communityId: string; coreKey: Buffer; secretSeedEnc: Buffer } | undefined;
    return row ?? null;
  }

  listCommunities(): unknown[] {
    return this.#db.prepare('SELECT * FROM communities').all() as unknown[];
  }

  /**
   * §18.4 passo 6 (`removed.purge`) — apaga TODO o estado local da comunidade: a fila, os
   * marcadores de `authorSeq`, o LS do leitor e a própria linha de `communities`. As linhas
   * de preferência por canal não têm comunidade na chave (o id de canal é único, §7.3), então
   * a lista delas chega pronta de quem também enxerga a `view.db`. Nunca roda para comunidade
   * aberta — quem chama esqueceu-a do runtime antes.
   */
  purgeCommunityData(communityId: string, channelIds: readonly string[]): void {
    const tx = this.#db.transaction(() => {
      for (const sql of [
        'DELETE FROM local_outbox WHERE community_id = ?',
        'DELETE FROM local_author_seq WHERE community_id = ?',
        'DELETE FROM local_read_state WHERE community_id = ?',
        'DELETE FROM local_thread_read_state WHERE community_id = ?',
        'DELETE FROM local_community_pref WHERE community_id = ?',
        'DELETE FROM local_relay_consent WHERE community_id = ?',
        'DELETE FROM local_participant_volume WHERE community_id = ?',
        'DELETE FROM member_blobs_core WHERE community_id = ?',
        'DELETE FROM invite_secrets WHERE community_id = ?',
        'DELETE FROM local_blob_staging WHERE community_id = ?',
      ]) {
        this.#db.prepare(sql).run(communityId);
      }
      if (channelIds.length > 0) {
        const placeholders = channelIds.map(() => '?').join(', ');
        this.#db.prepare(`DELETE FROM local_channel_pref WHERE channel_id IN (${placeholders})`).run(...channelIds);
      }
      const ativa = this.getNavigation();
      if (ativa.activeCommunityId === communityId) this.setNavigationField('activeCommunityId', null);
      if (ativa.activeChannelId !== undefined && channelIds.includes(ativa.activeChannelId)) {
        this.setNavigationField('activeChannelId', null);
      }
      this.deleteCommunity(communityId);
    });
    tx();
  }

  // --- invite_secrets (§12.2, §10.2) ------------------------------------------

  setInviteSecret(row: { invitePublicKey: Buffer; communityId: string; secret: Buffer; label?: string | null }): void {
    this.#db
      .prepare(
        'INSERT INTO invite_secrets(invite_public_key, community_id, secret, label) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT(invite_public_key) DO UPDATE SET community_id = excluded.community_id, secret = excluded.secret, label = excluded.label',
      )
      .run(row.invitePublicKey, row.communityId, row.secret, row.label ?? null);
  }

  getInviteSecret(invitePublicKeyHex: string): { invitePublicKey: Buffer; communityId: string; secret: Buffer; label: string | null } | null {
    const row = this.#db
      .prepare('SELECT invite_public_key AS invitePublicKey, community_id AS communityId, secret, label FROM invite_secrets WHERE invite_public_key = ?')
      .get(Buffer.from(invitePublicKeyHex, 'hex')) as
      | { invitePublicKey: Buffer; communityId: string; secret: Buffer; label: string | null }
      | undefined;
    return row ?? null;
  }

  getInviteSecretBySecret(secret: Buffer): { invitePublicKey: Buffer; communityId: string; secret: Buffer; label: string | null } | null {
    const row = this.#db
      .prepare('SELECT invite_public_key AS invitePublicKey, community_id AS communityId, secret, label FROM invite_secrets WHERE secret = ?')
      .get(secret) as
      | { invitePublicKey: Buffer; communityId: string; secret: Buffer; label: string | null }
      | undefined;
    return row ?? null;
  }

  listInviteSecrets(communityId?: string): Array<{ invitePublicKey: Buffer; communityId: string; secret: Buffer; label: string | null }> {
    if (communityId === undefined) {
      return this.#db.prepare('SELECT invite_public_key AS invitePublicKey, community_id AS communityId, secret, label FROM invite_secrets').all() as Array<{
        invitePublicKey: Buffer;
        communityId: string;
        secret: Buffer;
        label: string | null;
      }>;
    }
    return this.#db
      .prepare('SELECT invite_public_key AS invitePublicKey, community_id AS communityId, secret, label FROM invite_secrets WHERE community_id = ?')
      .all(communityId) as Array<{ invitePublicKey: Buffer; communityId: string; secret: Buffer; label: string | null }>;
  }

  deleteInviteSecret(invitePublicKeyHex: string): void {
    this.#db.prepare('DELETE FROM invite_secrets WHERE invite_public_key = ?').run(Buffer.from(invitePublicKeyHex, 'hex'));
  }

  checkpoint(): void {
    this.#db.pragma('wal_checkpoint(TRUNCATE)');
  }

  // --- estado local de leitura e preferência de exibição (§10.2) ------------------
  //
  // Estas quatro tabelas são **locais e não replicam**: quem as escreve são as preferências
  // de §15.4 (`channel.markRead`, `channel.setMuted`, `category.setCollapsed`) e nada mais.
  // Aqui há só leitura por chave — a derivação de "não lidas" pertence a quem escreve.

  /** `local_read_state` — linha ausente é o estado inicial: nada lido, nada por ler. */
  getReadState(communityId: string, channelId: string): { lastReadSeq: number; firstUnreadSeq: number | null; unreadCount: number; pendingMentions: number } {
    const row = this.#db
      .prepare(
        'SELECT last_read_seq AS lastReadSeq, first_unread_seq AS firstUnreadSeq, unread_count AS unreadCount, ' +
          'pending_mentions AS pendingMentions FROM local_read_state WHERE community_id = ? AND channel_id = ?',
      )
      .get(communityId, channelId) as
      | { lastReadSeq: number; firstUnreadSeq: number | null; unreadCount: number; pendingMentions: number }
      | undefined;
    return row ?? { lastReadSeq: -1, firstUnreadSeq: null, unreadCount: 0, pendingMentions: 0 };
  }

  /** `local_thread_read_state` — mesma regra da linha ausente. */
  getThreadReadState(communityId: string, threadId: string): { lastReadSeq: number; unreadCount: number } {
    const row = this.#db
      .prepare('SELECT last_read_seq AS lastReadSeq, unread_count AS unreadCount FROM local_thread_read_state WHERE community_id = ? AND thread_id = ?')
      .get(communityId, threadId) as { lastReadSeq: number; unreadCount: number } | undefined;
    return row ?? { lastReadSeq: -1, unreadCount: 0 };
  }

  /** `local_channel_pref.muted` — a chave é o canal, que já é único por comunidade (§7.3). */
  isChannelMuted(channelId: string): boolean {
    const row = this.#db.prepare('SELECT muted FROM local_channel_pref WHERE channel_id = ?').get(channelId) as { muted: number } | undefined;
    return row !== undefined && row.muted !== 0;
  }

  /** `local_community_pref.collapsed_categories` — JSON de ids; forma inválida é lista vazia. */
  collapsedCategories(communityId: string): ReadonlySet<string> {
    const row = this.#db.prepare('SELECT collapsed_categories AS collapsed FROM local_community_pref WHERE community_id = ?').get(communityId) as
      | { collapsed: string | null }
      | undefined;
    if (row?.collapsed == null) return new Set();
    try {
      const parsed: unknown = JSON.parse(row.collapsed);
      return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []);
    } catch {
      return new Set();
    }
  }

  // --- escrita do estado local de §6.15 ------------------------------------------
  //
  // As tabelas existem desde o schema de §10.2; quem as escreve são as preferências de
  // §15.4 e o recalculo de não-lidas disparado no lote projetado (§6.15 emendado). Aqui só
  // forma de armazenamento: upsert por chave e leitura em lista — nenhuma regra de domínio.

  /** Upsert da linha de não-lidas de um canal. Quem calcula é o recalcador, não este método. */
  setReadState(communityId: string, channelId: string, row: { lastReadSeq: number; firstUnreadSeq: number | null; unreadCount: number; pendingMentions: number }): void {
    this.#db
      .prepare(
        'INSERT INTO local_read_state(community_id, channel_id, last_read_seq, first_unread_seq, unread_count, pending_mentions) VALUES (?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(community_id, channel_id) DO UPDATE SET last_read_seq = excluded.last_read_seq, first_unread_seq = excluded.first_unread_seq, unread_count = excluded.unread_count, pending_mentions = excluded.pending_mentions',
      )
      .run(communityId, channelId, row.lastReadSeq, row.firstUnreadSeq, row.unreadCount, row.pendingMentions);
  }

  listReadStates(communityId?: string): Array<{ communityId: string; channelId: string; lastReadSeq: number; firstUnreadSeq: number | null; unreadCount: number; pendingMentions: number }> {
    const rows = (
      communityId === undefined
        ? this.#db.prepare('SELECT community_id AS communityId, channel_id AS channelId, last_read_seq AS lastReadSeq, first_unread_seq AS firstUnreadSeq, unread_count AS unreadCount, pending_mentions AS pendingMentions FROM local_read_state').all()
        : this.#db.prepare('SELECT community_id AS communityId, channel_id AS channelId, last_read_seq AS lastReadSeq, first_unread_seq AS firstUnreadSeq, unread_count AS unreadCount, pending_mentions AS pendingMentions FROM local_read_state WHERE community_id = ?').all(communityId)
    ) as Array<{ communityId: string; channelId: string; lastReadSeq: number; firstUnreadSeq: number | null; unreadCount: number; pendingMentions: number }>;
    return rows;
  }

  setThreadReadState(communityId: string, threadId: string, row: { lastReadSeq: number; unreadCount: number }): void {
    this.#db
      .prepare(
        'INSERT INTO local_thread_read_state(community_id, thread_id, last_read_seq, unread_count) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT(community_id, thread_id) DO UPDATE SET last_read_seq = excluded.last_read_seq, unread_count = excluded.unread_count',
      )
      .run(communityId, threadId, row.lastReadSeq, row.unreadCount);
  }

  listThreadReadStates(communityId?: string): Array<{ communityId: string; threadId: string; lastReadSeq: number; unreadCount: number }> {
    return (
      communityId === undefined
        ? this.#db.prepare('SELECT community_id AS communityId, thread_id AS threadId, last_read_seq AS lastReadSeq, unread_count AS unreadCount FROM local_thread_read_state').all()
        : this.#db.prepare('SELECT community_id AS communityId, thread_id AS threadId, last_read_seq AS lastReadSeq, unread_count AS unreadCount FROM local_thread_read_state WHERE community_id = ?').all(communityId)
    ) as Array<{ communityId: string; threadId: string; lastReadSeq: number; unreadCount: number }>;
  }

  setChannelMuted(channelId: string, muted: boolean): void {
    this.#db
      .prepare('INSERT INTO local_channel_pref(channel_id, muted) VALUES (?, ?) ON CONFLICT(channel_id) DO UPDATE SET muted = excluded.muted')
      .run(channelId, muted ? 1 : 0);
  }

  listMutedChannels(): Array<{ channelId: string }> {
    return this.#db.prepare('SELECT channel_id AS channelId FROM local_channel_pref WHERE muted <> 0').all() as Array<{ channelId: string }>;
  }

  /** Grava o conjunto de categorias recolhidas — a ordem é a da lista dada, estável. */
  setCollapsedCategories(communityId: string, ids: readonly string[]): void {
    this.#db
      .prepare('INSERT INTO local_community_pref(community_id, notification_level, collapsed_categories, recent_channels, last_host_seen_at) VALUES (?, NULL, ?, NULL, NULL) ' +
        'ON CONFLICT(community_id) DO UPDATE SET collapsed_categories = excluded.collapsed_categories')
      .run(communityId, JSON.stringify([...ids]));
  }

  getNotificationLevel(communityId: string): string | null {
    const row = this.#db.prepare('SELECT notification_level AS level FROM local_community_pref WHERE community_id = ?').get(communityId) as { level: string | null } | undefined;
    return row?.level ?? null;
  }

  setNotificationLevel(communityId: string, level: string): void {
    this.#db
      .prepare('INSERT INTO local_community_pref(community_id, notification_level, collapsed_categories, recent_channels, last_host_seen_at) VALUES (?, ?, NULL, NULL, NULL) ' +
        'ON CONFLICT(community_id) DO UPDATE SET notification_level = excluded.notification_level')
      .run(communityId, level);
  }

  listNotificationLevels(): Array<{ communityId: string; level: string }> {
    return this.#db
      .prepare('SELECT community_id AS communityId, notification_level AS level FROM local_community_pref WHERE notification_level IS NOT NULL')
      .all() as Array<{ communityId: string; level: string }>;
  }

  /**
   * `local_community_pref.last_host_seen_at` (§6.15) — o último contato OBSERVADO com o host
   * da comunidade. Quem escreve é o acompanhamento de conexão da raiz de composição; aqui só
   * a forma de armazenamento, como nas demais colunas desta tabela.
   */
  getLastHostSeenAt(communityId: string): number | null {
    const row = this.#db.prepare('SELECT last_host_seen_at AS at FROM local_community_pref WHERE community_id = ?').get(communityId) as { at: number | null } | undefined;
    return row?.at ?? null;
  }

  setLastHostSeenAt(communityId: string, at: number): void {
    this.#db
      .prepare('INSERT INTO local_community_pref(community_id, notification_level, collapsed_categories, recent_channels, last_host_seen_at) VALUES (?, NULL, NULL, NULL, ?) ' +
        'ON CONFLICT(community_id) DO UPDATE SET last_host_seen_at = excluded.last_host_seen_at')
      .run(communityId, at);
  }

  /** `local_navigation` — singleton chave/valor; DR-32 dono único da navegação. */
  getNavigation(): { activeCommunityId?: string; activeChannelId?: string } {
    const rows = this.#db.prepare("SELECT key, value FROM local_navigation WHERE key IN ('activeCommunityId', 'activeChannelId')").all() as Array<{ key: string; value: string }>;
    const out: { activeCommunityId?: string; activeChannelId?: string } = {};
    for (const r of rows) {
      if (r.key === 'activeCommunityId') out.activeCommunityId = r.value;
      if (r.key === 'activeChannelId') out.activeChannelId = r.value;
    }
    return out;
  }

  setNavigationField(key: 'activeCommunityId' | 'activeChannelId', value: string | null): void {
    if (value === null) {
      this.#db.prepare('DELETE FROM local_navigation WHERE key = ?').run(key);
      return;
    }
    this.#db.prepare('INSERT INTO local_navigation(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /**
   * §8.1/§15.4 — a comunidade ATIVA para fins de residência do DS (`community.activate`).
   * É escolha LOCAL (nunca trafega): `full` para a ativa e para toda hospedada, `light`
   * para as demais. Ausente = nenhuma ativação explícita.
   */
  getResidencyActive(): string | null {
    const row = this.#db.prepare("SELECT value FROM local_navigation WHERE key = 'residencyActive'").get() as { value: string } | undefined;
    return row?.value ?? null;
  }

  setResidencyActive(communityId: string | null): void {
    if (communityId === null) {
      this.#db.prepare("DELETE FROM local_navigation WHERE key = 'residencyActive'").run();
      return;
    }
    this.#db.prepare("INSERT INTO local_navigation(key, value) VALUES ('residencyActive', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(communityId);
  }

  /** §8.1 — residência EFETIVA da comunidade: a regra deriva; a ativação explícita fixa. */
  residencyOf(communityId: string): 'full' | 'light' {
    if (this.getResidencyActive() === communityId) return 'full';
    const row = this.getCommunity(communityId) as { is_host?: number } | null;
    if (row !== null && row.is_host === 1) return 'full';
    return 'light';
  }

  /** `local_device_pref` — singleton chave/valor (§6.15); valor `null` apaga a chave. */
  devicePref(key: string): string | null {
    const row = this.#db.prepare('SELECT value FROM local_device_pref WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  devicePrefKeys(): string[] {
    return (this.#db.prepare('SELECT key FROM local_device_pref').all() as Array<{ key: string }>).map((r) => r.key);
  }

  setDevicePref(key: string, value: string | null): void {
    if (value === null) {
      this.#db.prepare('DELETE FROM local_device_pref WHERE key = ?').run(key);
      return;
    }
    this.#db.prepare('INSERT INTO local_device_pref(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  setParticipantVolume(communityId: string, identityKey: Buffer, volume: number): void {
    this.#db
      .prepare('INSERT INTO local_participant_volume(community_id, identity_key, volume) VALUES (?, ?, ?) ON CONFLICT(community_id, identity_key) DO UPDATE SET volume = excluded.volume')
      .run(communityId, identityKey, volume);
  }

  listParticipantVolumes(): Array<{ communityId: string; identityKey: string; volume: number }> {
    return (this.#db.prepare('SELECT community_id AS communityId, hex(identity_key) AS identityKey, volume FROM local_participant_volume').all() as Array<{
      communityId: string;
      identityKey: string;
      volume: number;
    }>).map((r) => ({ ...r, identityKey: r.identityKey.toLowerCase() }));
  }

  // ─── §31.12 — conversa direta ────────────────────────────────────────────────────────
  //
  // Armazenamento, e só. A regra de domínio — os cinco estados, o aceite, o bloqueio, a
  // gravação de `self_high_water` **antes** de cada append e a detecção de `desynced` — é de
  // `directMessages` (L2, B57). Aqui não há política nenhuma: `manifest` é L0 (§4).

  /** §31.12 — a enumeração autoritativa de conversas; `state` é validado em L2, não aqui. */
  upsertDmConversation(row: DmConversationInput): void {
    this.#db
      .prepare(
        'INSERT INTO dm_conversations(conversation_id, peer_key, self_core_key, self_core_seed_enc, ' +
          'peer_core_key, state, created_at, accepted_at, blocked_at, self_high_water, ' +
          'forgotten_self_length, forgotten_peer_length, removed_at, retain_until) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(conversation_id) DO UPDATE SET peer_key = excluded.peer_key, ' +
          'self_core_key = excluded.self_core_key, self_core_seed_enc = excluded.self_core_seed_enc, ' +
          'peer_core_key = excluded.peer_core_key, state = excluded.state, ' +
          'accepted_at = excluded.accepted_at, blocked_at = excluded.blocked_at, ' +
          'self_high_water = excluded.self_high_water, ' +
          'forgotten_self_length = excluded.forgotten_self_length, ' +
          'forgotten_peer_length = excluded.forgotten_peer_length, ' +
          'removed_at = excluded.removed_at, retain_until = excluded.retain_until',
      )
      .run(
        row.conversationId,
        row.peerKey,
        row.selfCoreKey,
        row.selfCoreSeedEnc ?? null,
        row.peerCoreKey ?? null,
        row.state,
        row.createdAt,
        row.acceptedAt ?? null,
        row.blockedAt ?? null,
        row.selfHighWater,
        row.forgottenSelfLength ?? null,
        row.forgottenPeerLength ?? null,
        row.removedAt ?? null,
        row.retainUntil ?? null,
      );
  }

  getDmConversation(conversationId: string): DmConversationRow | null {
    const row = this.#db
      .prepare('SELECT * FROM dm_conversations WHERE conversation_id = ?')
      .get(conversationId) as DmConversationRow | undefined;
    return row ?? null;
  }

  listDmConversations(): DmConversationRow[] {
    return this.#db
      .prepare('SELECT * FROM dm_conversations ORDER BY conversation_id')
      .all() as DmConversationRow[];
  }

  /**
   * §31.13 — `self_high_water` é gravado **antes** de cada append, e só cresce. O `MAX` é o
   * que impede que uma escrita fora de ordem devolva a marca para trás; a comparação com
   * `core.length` que decide `desynced` é de B57.
   */
  raiseDmSelfHighWater(conversationId: string, length: number): void {
    this.#db
      .prepare('UPDATE dm_conversations SET self_high_water = MAX(self_high_water, ?) WHERE conversation_id = ?')
      .run(length, conversationId);
  }

  /** §31.12 — watermark de leitura. `unread_count` é **recomputado**, nunca acumulado (A28). */
  getDmReadState(conversationId: string): DmReadStateRow | null {
    const row = this.#db
      .prepare('SELECT * FROM dm_local_read_state WHERE conversation_id = ?')
      .get(conversationId) as DmReadStateRow | undefined;
    return row ?? null;
  }

  setDmReadState(conversationId: string, lastReadOrdSum: number, lastReadAuthor: Buffer, unreadCount: number): void {
    this.#db
      .prepare(
        'INSERT INTO dm_local_read_state(conversation_id, last_read_ord_sum, last_read_author, unread_count) ' +
          'VALUES (?, ?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET ' +
          'last_read_ord_sum = excluded.last_read_ord_sum, last_read_author = excluded.last_read_author, ' +
          'unread_count = excluded.unread_count',
      )
      .run(conversationId, lastReadOrdSum, lastReadAuthor, unreadCount);
  }

  /** §31.12 — `dm_prefs`. Hoje só `contactPolicy` (§31.9 regra 5); a política mora em L2. */
  dmPref(key: string): string | null {
    const row = this.#db.prepare('SELECT value FROM dm_prefs WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setDmPref(key: string, value: string): void {
    this.#db
      .prepare('INSERT INTO dm_prefs(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  close(): void {
    this.#db.close();
  }
}

export function openManifestDb(path: string): ManifestDb {
  return new ManifestDb(path);
}
