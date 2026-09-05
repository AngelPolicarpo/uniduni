// `blobs` — L2. Ownership, ticket, staging, download, GC e barreira (§13, §22.4, A09, A15).
//
// §4: depende de `corestore` (L0), `swarm` (L0), `manifest` (L0).
// Não importa de L3. A porta de transporte é injetada por L3; aqui só a decisão e o estado local.
// Não anuncia números não medidos — BENCHMARK REQUIRED (§26.1) permanece provisório.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import sodium from 'sodium-native';

import type { ManifestDb } from '../../l0/manifest/index.ts';
import type { Swarm } from '../../l0/swarm/index.ts';

// L1 — constantes de protocolo (§27.1) duplicadas localmente para não criar aresta L2→L1
// que exigiria emenda em §4. Valores idênticos a `fold/constants.ts`.
const ATTACHMENT_MAX_BYTES = Number.MAX_SAFE_INTEGER;

function blake2b256(domain: string, ...parts: Buffer[]): Buffer {
  const out = Buffer.allocUnsafe(32);
  sodium.crypto_generichash_batch(out, [Buffer.from(domain, 'utf8'), ...parts]);
  return out;
}

// ─── Constantes operacionais (§27.2) ─────────────────────────────────────────

export const STAGING_TICKET_TTL_MS_DEFAULT = 15 * 60 * 1000;
export const STAGING_ORPHAN_MS_DEFAULT = 24 * 60 * 60 * 1000;
export const BLOB_CACHE_MAX_BYTES_DEFAULT = 20 * 1024 * 1024 * 1024;

// ─── Kind por extensão (§13.6, fecha DR-41) ───────────────────────────────────

export const BLOB_KIND = {
  image: 0,
  video: 1,
  audio: 2,
  document: 3,
  archive: 4,
  other: 5,
} as const;

export type BlobKindNumber = (typeof BLOB_KIND)[keyof typeof BLOB_KIND];

const EXT_TO_KIND: ReadonlyMap<string, BlobKindNumber> = new Map<string, BlobKindNumber>([
  // image
  ...['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'tiff', 'heic'].map((e) => [e, BLOB_KIND.image] as const),
  // video
  ...['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v'].map((e) => [e, BLOB_KIND.video] as const),
  // audio
  ...['mp3', 'wav', 'flac', 'ogg', 'opus', 'm4a', 'aac'].map((e) => [e, BLOB_KIND.audio] as const),
  // document
  ...['pdf', 'txt', 'md', 'csv', 'json', 'xml', 'odt', 'ods', 'odp', 'docx', 'xlsx', 'pptx', 'rtf'].map((e) => [e, BLOB_KIND.document] as const),
  // archive
  ...['zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar'].map((e) => [e, BLOB_KIND.archive] as const),
]);

const EXECUTABLE_BLOCKLIST = new Set<string>([
  'exe', 'bat', 'cmd', 'com', 'scr', 'ps1', 'sh', 'msi', 'dll', 'app', 'pkg', 'dmg', 'deb', 'rpm', 'jar', 'vbs', 'js', 'wsf', 'lnk',
]);

const INLINE_IMAGE_ALLOWLIST = new Set<string>(['png', 'jpg', 'jpeg', 'gif', 'webp']);

function extOf(nameOrPath: string): string {
  const base = path.basename(nameOrPath);
  const dot = base.lastIndexOf('.');
  if (dot < 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

export function kindFromExtension(ext: string): BlobKindNumber {
  const lower = ext.toLowerCase().replace(/^\./, '');
  return EXT_TO_KIND.get(lower) ?? BLOB_KIND.other;
}

export function kindFromFilename(nameOrPath: string): BlobKindNumber {
  return kindFromExtension(extOf(nameOrPath));
}

export function isExecutableExtension(extOrName: string): boolean {
  const e = extOf(extOrName) || extOrName.toLowerCase().replace(/^\./, '');
  return EXECUTABLE_BLOCKLIST.has(e);
}

export function isInlineImageAllowed(extOrName: string): boolean {
  const e = extOf(extOrName) || extOrName.toLowerCase().replace(/^\./, '');
  return INLINE_IMAGE_ALLOWLIST.has(e);
}

export function isRevealAllowed(kind: BlobKindNumber, extOrName: string): boolean {
  const ext = extOf(extOrName) || extOrName.replace(/^\./, '');
  if (isExecutableExtension(ext)) return false; // §13.6 regra 2 — bloqueada até para revelar
  if (kind === BLOB_KIND.other || kind === BLOB_KIND.archive) return false; // §13.6 regra 1 — só image/audio/video/document
  // §13.6 regra 1 — apenas extensões da tabela: o kind declarado pelo remetente é consultável,
  // a extensão real do arquivo é que delimita a allowlist (troca de extensão é o ataque T-48)
  const tabKind = EXT_TO_KIND.get(ext);
  return tabKind !== undefined && tabKind !== BLOB_KIND.archive;
}

// ─── Nome de anexo — rejeitar, não sanitizar (§8.6) ─────────────────────────

const NOME_RESERVADO = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

export function isValidAttachmentName(name: string): boolean {
  const bytes = Buffer.byteLength(name, 'utf8');
  if (bytes < 1 || bytes > 255) return false;
  if (/[/\\\0]/.test(name)) return false;
  for (const c of name) {
    const cp = c.codePointAt(0) ?? 0;
    if (cp < 0x20 || cp === 0x7f) return false;
  }
  if (NOME_RESERVADO.test(name)) return false;
  if (name.endsWith('.') || name.endsWith(' ')) return false;
  return true;
}

// ─── Ownership por autor (§13.1, A09) ────────────────────────────────────────

/**
 * `memberBlobsSeed = BLAKE2b-256('ns/memberblobs/1' ‖ identitySeed ‖ communityId)`
 * Derivável só pelo dono, recuperável por backup de identidade (§5.5).
 * `communityId` é hex de 32 bytes (coreKey) ou Buffer.
 */
export function deriveMemberBlobsSeed(identitySeed: Buffer, communityId: string | Buffer): Buffer {
  const cid = typeof communityId === 'string' ? Buffer.from(communityId, 'hex') : communityId;
  // Domínio fixo, 18 bytes — prefixo de separação de domínio de §5.2
  return blake2b256('ns/memberblobs/1', identitySeed, cid);
}

export function deriveMemberBlobsKeypair(
  identitySeed: Buffer,
  communityId: string | Buffer,
): { publicKey: Buffer; secretKey: Buffer; seed: Buffer } {
  const seed = deriveMemberBlobsSeed(identitySeed, communityId);
  const publicKey = Buffer.alloc(sodium.crypto_sign_PUBLICKEYBYTES);
  const secretKey = Buffer.alloc(sodium.crypto_sign_SECRETKEYBYTES);
  sodium.crypto_sign_seed_keypair(publicKey, secretKey, seed);
  return { publicKey, secretKey, seed };
}

export function deriveMemberBlobsPublicKey(identitySeed: Buffer, communityId: string | Buffer): Buffer {
  return deriveMemberBlobsKeypair(identitySeed, communityId).publicKey;
}

/** `discoveryKey(blobsCoreKey)` — tópico DHT do core de blobs do membro (§14.1). */
export function discoveryKeyForBlobsCoreKey(blobsCoreKey: Buffer): Buffer {
  return blake2b256('blob-discovery/1', blobsCoreKey);
}

export function discoveryKeyHexForBlobsCoreKey(blobsCoreKey: Buffer): string {
  return discoveryKeyForBlobsCoreKey(blobsCoreKey).toString('hex');
}

// ─── Hash de blob (§13.2 passo 5) ───────────────────────────────────────────

export function hashForBlobContent(content: Buffer): Buffer {
  return blake2b256('blob-hash/1', content);
}

// ─── Ticket (§13.3, A15) — 16 bytes, TTL 15 min, uso único, escopo comunidade+caminho ─

export type StagingTicket = {
  readonly ticketId: string; // 32 hex (16 bytes)
  readonly path: string;
  readonly sizeBytes: number;
  readonly communityId: string;
  readonly createdAt: number;
  readonly name: string;
  readonly kind: BlobKindNumber;
};

export type TicketIssue = {
  readonly ticketId: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly kind: BlobKindNumber;
};

function isValidTicketId(id: string): boolean {
  return /^[0-9a-f]{32}$/i.test(id);
}

export class TicketStore {
  readonly #tickets = new Map<string, StagingTicket & { used: boolean }>();
  readonly #ttlMs: number;
  readonly #clock: () => number;

  constructor(opts: { ttlMs?: number; clock?: () => number } = {}) {
    this.#ttlMs = opts.ttlMs ?? STAGING_TICKET_TTL_MS_DEFAULT;
    this.#clock = opts.clock ?? Date.now;
  }

  get ttlMs(): number {
    return this.#ttlMs;
  }

  /** Emite ticket de 16 bytes aleatórios — chamado pelo **main** após dialog.showOpenDialog (§13.2). */
  issue(communityId: string, filePath: string, sizeBytes: number): TicketIssue {
    if (!isValidAttachmentName(path.basename(filePath))) {
      throw Object.assign(new Error('Nome de anexo inválido'), { code: 'E_VALIDATION', field: 'name' });
    }
    if (sizeBytes < 1 || sizeBytes > ATTACHMENT_MAX_BYTES) {
      throw Object.assign(new Error('Anexo acima de ATTACHMENT_MAX_BYTES'), { code: 'E_ATTACHMENT_TOO_LARGE' });
    }
    const ticketId = crypto.randomBytes(16).toString('hex');
    const name = path.basename(filePath);
    const kind = kindFromFilename(name);
    const ticket: StagingTicket & { used: boolean } = {
      ticketId,
      path: filePath,
      sizeBytes,
      communityId,
      createdAt: this.#clock(),
      name,
      kind,
      used: false,
    };
    this.#tickets.set(ticketId, ticket);
    return { ticketId, name, sizeBytes, kind };
  }

  /** Ingesta ticket emitido pelo main via IPC-M (§15.7 staging.ticket) — núcleo recebe e persiste. */
  ingest(ticket: StagingTicket): void {
    if (!isValidTicketId(ticket.ticketId)) throw Object.assign(new Error('Ticket inválido'), { code: 'E_TICKET_INVALID' });
    if (this.#tickets.has(ticket.ticketId)) throw Object.assign(new Error('Ticket já existe'), { code: 'E_TICKET_INVALID' });
    if (ticket.sizeBytes < 1 || ticket.sizeBytes > ATTACHMENT_MAX_BYTES) {
      throw Object.assign(new Error('Tamanho inválido'), { code: 'E_TICKET_INVALID' });
    }
    this.#tickets.set(ticket.ticketId, { ...ticket, used: false });
  }

  get(ticketId: string): (StagingTicket & { used: boolean }) | undefined {
    return this.#tickets.get(ticketId);
  }

  /** Consome ticket — uso único, valida TTL e escopo. Retorna ticket se válido, lança E_TICKET_INVALID senão. */
  consume(ticketId: string, expectedCommunityId?: string): StagingTicket {
    const t = this.#tickets.get(ticketId);
    if (t === undefined || t.used) throw Object.assign(new Error('Ticket inválido ou já usado'), { code: 'E_TICKET_INVALID' });
    if (this.#clock() - t.createdAt > this.#ttlMs) {
      // **O vencido fica no mapa** (emenda de 2026-09-05). Apagá-lo aqui tornava a segunda
      // tentativa indistinguível de "ticket de outro processo", e é exatamente essa
      // distinção que o `stage` usa para decidir se pode reconstruir o ticket da linha de
      // staging: uma retentativa do renderer passava pelo caminho de retomada e furava a
      // TTL. O custo de manter é um objeto por anexo escolhido na vida do processo.
      throw Object.assign(new Error('Ticket expirado'), { code: 'E_TICKET_INVALID' });
    }
    if (expectedCommunityId !== undefined && t.communityId !== expectedCommunityId) {
      throw Object.assign(new Error('Ticket fora do escopo da comunidade'), { code: 'E_TICKET_INVALID' });
    }
    t.used = true;
    return { ticketId: t.ticketId, path: t.path, sizeBytes: t.sizeBytes, communityId: t.communityId, createdAt: t.createdAt, name: t.name, kind: t.kind };
  }

  /** Verifica se ticket existe e é válido sem consumir (para validação preemptiva). */
  peek(ticketId: string): StagingTicket | null {
    const t = this.#tickets.get(ticketId);
    if (t === undefined || t.used) return null;
    if (this.#clock() - t.createdAt > this.#ttlMs) return null;
    return t;
  }

  pruneExpired(now = this.#clock()): number {
    let n = 0;
    for (const [id, t] of this.#tickets) {
      if (now - t.createdAt > this.#ttlMs || t.used) {
        // mantém usados até GC? Por ora remove expirados e usados após consumo bem-sucedido externo
        if (now - t.createdAt > this.#ttlMs) {
          this.#tickets.delete(id);
          n++;
        }
      }
    }
    return n;
  }

  size(): number {
    return this.#tickets.size;
  }
}

// ─── Estados de cache (§13.4, fecha DR-40) ───────────────────────────────────

export const BLOB_CACHE_STATES = [
  'not-downloaded',
  'queued',
  'downloading',
  'verifying',
  'downloaded',
  'corrupt',
  'unavailable',
  'cancelled',
] as const;

export type BlobCacheState = (typeof BLOB_CACHE_STATES)[number];

export function isValidBlobCacheState(s: string): s is BlobCacheState {
  return (BLOB_CACHE_STATES as readonly string[]).includes(s);
}

export const STAGING_STATES = ['pending', 'writing', 'done', 'failed', 'cancelled'] as const;
export type StagingState = (typeof STAGING_STATES)[number];

// ─── Staging — manifest.local_blob_staging (§13.5, fecha DS-22) ──────────────

export type StagingRow = {
  ticketId: string;
  path: string;
  bytesWritten: number;
  rollingHashState: Buffer | null;
  state: StagingState;
  communityId: string | null;
  sizeBytes: number | null;
  name: string | null;
  kind: number | null;
  hash: Buffer | null;
  createdAt: number | null;
  /** Faixa de blocos que o stage escreveu no core do autor — o que o `core.clear` de §13.5 poda. */
  blobRanges: { readonly blockOffset: number; readonly blockLength: number } | null;
};

function rowToStaging(r: Record<string, unknown>): StagingRow {
  return {
    ticketId: r['ticket_id'] as string,
    path: r['path'] as string,
    bytesWritten: r['bytes_written'] as number,
    rollingHashState: (r['rolling_hash_state'] as Buffer | null) ?? null,
    state: r['state'] as StagingState,
    communityId: (r['community_id'] as string | null) ?? null,
    sizeBytes: (r['size_bytes'] as number | null) ?? null,
    name: (r['name'] as string | null) ?? null,
    kind: (r['kind'] as number | null) ?? null,
    hash: (r['hash'] as Buffer | null) ?? null,
    createdAt: (r['created_at'] as number | null) ?? null,
    blobRanges: StagingManager.parseRanges(r['blob_ranges']),
  };
}

export class StagingManager {
  readonly #manifest: ManifestDb;
  readonly #clock: () => number;
  readonly #orphanMs: number;

  /** Faixa de blocos registrada no stage; JSON malformado é ausência (§8.5: normaliza). */
  static parseRanges(raw: unknown): { readonly blockOffset: number; readonly blockLength: number } | null {
    if (typeof raw !== 'string' || raw.length === 0) return null;
    try {
      const parsed = JSON.parse(raw) as { blockOffset?: unknown; blockLength?: unknown };
      if (
        typeof parsed.blockOffset === 'number' &&
        Number.isInteger(parsed.blockOffset) &&
        parsed.blockOffset >= 0 &&
        typeof parsed.blockLength === 'number' &&
        Number.isInteger(parsed.blockLength) &&
        parsed.blockLength > 0
      ) {
        return { blockOffset: parsed.blockOffset, blockLength: parsed.blockLength };
      }
    } catch {}
    return null;
  }

  constructor(manifest: ManifestDb, opts: { clock?: () => number; orphanMs?: number } = {}) {
    this.#manifest = manifest;
    this.#clock = opts.clock ?? Date.now;
    this.#orphanMs = opts.orphanMs ?? STAGING_ORPHAN_MS_DEFAULT;
  }

  /** Persiste ticket após ingest via IPC-M. Estado inicial `pending`. */
  createFromTicket(ticket: StagingTicket): void {
    const now = this.#clock();
    this.#manifest.raw
      .prepare(
        'INSERT OR REPLACE INTO local_blob_staging(ticket_id, path, bytes_written, rolling_hash_state, state, community_id, size_bytes, name, kind, hash, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        ticket.ticketId,
        ticket.path,
        0,
        null,
        'pending',
        ticket.communityId,
        ticket.sizeBytes,
        ticket.name,
        ticket.kind,
        null,
        now,
      );
  }

  get(ticketId: string): StagingRow | null {
    const r = this.#manifest.raw.prepare('SELECT * FROM local_blob_staging WHERE ticket_id = ?').get(ticketId) as Record<string, unknown> | undefined;
    return r === undefined ? null : rowToStaging(r);
  }

  list(): StagingRow[] {
    const rows = this.#manifest.raw.prepare('SELECT * FROM local_blob_staging').all() as Record<string, unknown>[];
    return rows.map(rowToStaging);
  }

  listByState(state: StagingState): StagingRow[] {
    const rows = this.#manifest.raw.prepare('SELECT * FROM local_blob_staging WHERE state = ?').all(state) as Record<string, unknown>[];
    return rows.map(rowToStaging);
  }

  setState(ticketId: string, state: StagingState, extra: Partial<Pick<StagingRow, 'bytesWritten' | 'hash'>> = {}): void {
    const fields: string[] = ['state = ?'];
    const values: unknown[] = [state];
    if (extra.bytesWritten !== undefined) {
      fields.push('bytes_written = ?');
      values.push(extra.bytesWritten);
    }
    if (extra.hash !== undefined) {
      fields.push('hash = ?');
      values.push(extra.hash);
    }
    values.push(ticketId);
    this.#manifest.raw.prepare(`UPDATE local_blob_staging SET ${fields.join(', ')} WHERE ticket_id = ?`).run(...values);
  }

  updateProgress(ticketId: string, bytesWritten: number, rollingHashState: Buffer | null = null): void {
    this.#manifest.raw
      .prepare('UPDATE local_blob_staging SET bytes_written = ?, rolling_hash_state = ?, state = ? WHERE ticket_id = ?')
      .run(bytesWritten, rollingHashState, 'writing', ticketId);
  }

  markDone(ticketId: string, hash: Buffer, bytesWritten: number, ranges?: { readonly blockOffset: number; readonly blockLength: number }): void {
    this.#manifest.raw
      .prepare('UPDATE local_blob_staging SET state = ?, hash = ?, bytes_written = ?, blob_ranges = ? WHERE ticket_id = ?')
      .run('done', hash, bytesWritten, ranges === undefined ? null : JSON.stringify(ranges), ticketId);
  }

  markFailed(ticketId: string): void {
    this.#manifest.raw.prepare("UPDATE local_blob_staging SET state = 'failed' WHERE ticket_id = ?").run(ticketId);
  }

  remove(ticketId: string): void {
    this.#manifest.raw.prepare('DELETE FROM local_blob_staging WHERE ticket_id = ?').run(ticketId);
  }

  /**
   * Retomada após crash no boot (§13.5):
   * - `writing` → retoma do bytesWritten (verifica se arquivo ainda existe, senão E_FILE_UNREADABLE)
   * - `done` antigo sem referência → será coletado por `gcOrphan`
   */
  resumeOnBoot(): { resumed: StagingRow[]; discarded: StagingRow[] } {
    const resumed: StagingRow[] = [];
    const discarded: StagingRow[] = [];
    for (const row of this.list()) {
      if (row.state === 'writing' || row.state === 'pending') {
        if (!fs.existsSync(row.path)) {
          this.markFailed(row.ticketId);
          discarded.push({ ...row, state: 'failed' });
        } else {
          resumed.push(row);
        }
      }
    }
    return { resumed, discarded };
  }

  /**
   * GC de staging órfão (§13.5, §22.4): `done` sem mensagem referenciando em STAGING_ORPHAN_MS → core.clear + remove.
   * `hasReference` é injetado para consultar `view.attachments` sem acoplar `view` diretamente (§4).
   */
  gcOrphan(opts: { now?: number; hasReference: (row: StagingRow) => boolean; clearBlobs: (row: StagingRow) => void }): { removed: number; cleared: number } {
    const now = opts.now ?? this.#clock();
    let removed = 0;
    let cleared = 0;
    for (const row of this.listByState('done')) {
      const createdAt = row.createdAt ?? now;
      if (now - createdAt < this.#orphanMs) continue;
      if (opts.hasReference(row)) continue;
      try {
        opts.clearBlobs(row);
        cleared++;
      } catch {}
      this.remove(row.ticketId);
      removed++;
    }
    return { removed, cleared };
  }
}

// ─── Download cache — manifest.local_blob_cache (§13.4) ─────────────────────

export type CacheRow = {
  blobsCoreKeyHex: string;
  blobIdHex: string;
  bytesDownloaded: number;
  state: BlobCacheState;
  path: string | null;
  verifiedAt: number | null;
  declaredSize: number | null;
};

function rowToCache(r: Record<string, unknown>): CacheRow {
  const keyBuf = r['blobs_core_key'] as Buffer;
  return {
    blobsCoreKeyHex: keyBuf.toString('hex'),
    blobIdHex: r['blob_id_hex'] as string,
    bytesDownloaded: r['bytes_downloaded'] as number,
    state: r['state'] as BlobCacheState,
    path: (r['path'] as string | null) ?? null,
    verifiedAt: (r['verified_at'] as number | null) ?? null,
    declaredSize: (r['declared_size'] as number | null) ?? null,
  };
}

export class DownloadCache {
  readonly #manifest: ManifestDb;
  readonly #clock: () => number;

  constructor(manifest: ManifestDb, opts: { clock?: () => number } = {}) {
    this.#manifest = manifest;
    this.#clock = opts.clock ?? Date.now;
  }

  get(blobsCoreKey: Buffer | string, blobIdHex: string): CacheRow | null {
    const key = typeof blobsCoreKey === 'string' ? Buffer.from(blobsCoreKey, 'hex') : blobsCoreKey;
    const r = this.#manifest.raw
      .prepare('SELECT * FROM local_blob_cache WHERE blobs_core_key = ? AND blob_id_hex = ?')
      .get(key, blobIdHex) as Record<string, unknown> | undefined;
    return r === undefined ? null : rowToCache(r);
  }

  list(): CacheRow[] {
    const rows = this.#manifest.raw.prepare('SELECT * FROM local_blob_cache').all() as Record<string, unknown>[];
    return rows.map(rowToCache);
  }

  listByState(state: BlobCacheState): CacheRow[] {
    const rows = this.#manifest.raw.prepare('SELECT * FROM local_blob_cache WHERE state = ?').all(state) as Record<string, unknown>[];
    return rows.map(rowToCache);
  }

  upsert(row: { blobsCoreKey: Buffer; blobIdHex: string; state: BlobCacheState; bytesDownloaded?: number; declaredSize?: number | null; path?: string | null }): void {
    const existing = this.get(row.blobsCoreKey, row.blobIdHex);
    const bytes = row.bytesDownloaded ?? existing?.bytesDownloaded ?? 0;
    const declared = row.declaredSize ?? existing?.declaredSize ?? null;
    const p = row.path ?? existing?.path ?? null;
    const verifiedAt = row.state === 'downloaded' ? this.#clock() : existing?.verifiedAt ?? null;
    this.#manifest.raw
      .prepare(
        'INSERT INTO local_blob_cache(blobs_core_key, blob_id_hex, bytes_downloaded, state, path, verified_at, declared_size) VALUES (?,?,?,?,?,?,?) ' +
          'ON CONFLICT(blobs_core_key, blob_id_hex) DO UPDATE SET bytes_downloaded = excluded.bytes_downloaded, state = excluded.state, path = excluded.path, verified_at = excluded.verified_at, declared_size = excluded.declared_size',
      )
      .run(row.blobsCoreKey, row.blobIdHex, bytes, row.state, p, verifiedAt, declared);
  }

  setState(blobsCoreKey: Buffer | string, blobIdHex: string, state: BlobCacheState, extra: Partial<Pick<CacheRow, 'bytesDownloaded' | 'path' | 'declaredSize'>> = {}): void {
    const key = typeof blobsCoreKey === 'string' ? Buffer.from(blobsCoreKey, 'hex') : blobsCoreKey;
    const existing = this.get(key, blobIdHex);
    if (existing === null) return;
    const bytes = extra.bytesDownloaded ?? existing.bytesDownloaded;
    const p = extra.path ?? existing.path;
    const declared = extra.declaredSize ?? existing.declaredSize;
    const verifiedAt = state === 'downloaded' ? this.#clock() : existing.verifiedAt;
    this.#manifest.raw
      .prepare('UPDATE local_blob_cache SET state = ?, bytes_downloaded = ?, path = ?, verified_at = ?, declared_size = ? WHERE blobs_core_key = ? AND blob_id_hex = ?')
      .run(state, bytes, p, verifiedAt, declared, key, blobIdHex);
  }

  remove(blobsCoreKey: Buffer | string, blobIdHex: string): void {
    const key = typeof blobsCoreKey === 'string' ? Buffer.from(blobsCoreKey, 'hex') : blobsCoreKey;
    this.#manifest.raw.prepare('DELETE FROM local_blob_cache WHERE blobs_core_key = ? AND blob_id_hex = ?').run(key, blobIdHex);
  }

  /**
   * Retomada após crash (§13.4): todo `downloading`/`verifying` volta para `queued` com bytesDownloaded preservado.
   * Hypercore retoma pelo bitfield sem reiniciar (§13.4).
   */
  resumeOnBoot(): number {
    const rows = this.#manifest.raw.prepare("SELECT blobs_core_key, blob_id_hex FROM local_blob_cache WHERE state IN ('downloading','verifying')").all() as Array<Record<string, unknown>>;
    let n = 0;
    for (const r of rows) {
      const key = r['blobs_core_key'] as Buffer;
      const id = r['blob_id_hex'] as string;
      this.#manifest.raw.prepare("UPDATE local_blob_cache SET state = 'queued' WHERE blobs_core_key = ? AND blob_id_hex = ?").run(key, id);
      n++;
    }
    return n;
  }

  /**
   * GC de blobs (§22.4): LRU por verified_at, exceto protegidos (§13.7 regra 2).
   * `isProtected` diz se o blob é do autor local com mensagem viva — nunca coletado.
   * `deleteFile` remove do disco; aqui só remove linha do cache (core.clear libera blocos locais).
   */
  gc(opts: {
    maxBytes: number;
    isProtected: (row: CacheRow) => boolean;
    deleteFile?: (row: CacheRow) => void;
    now?: number;
  }): { removed: number; freedBytes: number } {
    const max = opts.maxBytes;
    let total = 0;
    const candidates: Array<CacheRow & { size: number }> = [];
    for (const row of this.list()) {
      if (row.state !== 'downloaded' || row.path === null) continue;
      if (opts.isProtected(row)) continue;
      const sz = row.declaredSize ?? row.bytesDownloaded;
      total += sz;
      candidates.push({ ...row, size: sz });
    }
    if (total <= max) return { removed: 0, freedBytes: 0 };
    candidates.sort((a, b) => (a.verifiedAt ?? 0) - (b.verifiedAt ?? 0)); // LRU
    let removed = 0;
    let freed = 0;
    for (const c of candidates) {
      if (total <= max) break;
      try {
        opts.deleteFile?.(c);
      } catch {}
      // core.clear: libera blocos locais (mock: remove linha)
      this.remove(Buffer.from(c.blobsCoreKeyHex, 'hex'), c.blobIdHex);
      total -= c.size;
      freed += c.size;
      removed++;
    }
    return { removed, freedBytes: freed };
  }
}

// ─── Core de blobs do membro (§13.1) — portas injetadas pela composição ─────
//
// O conteúdo do anexo vive em blocos do **core de blobs do próprio autor**: cada `stage`
// appenda o arquivo em fatias de `BLOB_CHUNK_BYTES` e o `blobId` da mensagem é o recorte
// (`blockOffset`, `blockLength`, `byteOffset`, `byteLength`) dentro desse core — o mesmo
// quádruplo de §7.2.1 que o leitor usa para pedir a faixa esparsa (§13.4). Quem abre
// Hypercore é L0/L3; aqui só a forma da porta.

/** Fatia de escrita do `stage` (§13.2 passo 5) — e a unidade de `blockLength` do `blobId`. */
export const BLOB_CHUNK_BYTES = 64 * 1024;

/**
 * Fatias por chamada de `appendBlocks` no `blob.stage` (§13.2 passo 5). Emenda de
 * 2026-09-04: sem cota por membro, o arquivo pode ser maior que a RAM, então o staging não
 * pode mais juntar todas as fatias antes de escrever. 64 × 64 KiB = 4 MiB de pico.
 */
const STAGE_BATCH_BLOCKS = 64;

/** §22.1 — cadência do loop `blob.progress` de quem baixa. */
export const BLOB_PROGRESS_MS = 500;

export type BlobsWriterPort = {
  readonly key: Buffer;
  /** §14.1/§16.1 — entra na replicação sobre um mux já montado (é ele quem serve os blocos). */
  replicate(mux: unknown): void;
  /** Appenda as fatias e devolve o `blockOffset` (o comprimento do core antes do append). */
  appendBlocks(chunks: readonly Uint8Array[]): Promise<number>;
  /**
   * §13.5/§22.4 — `core.clear` da faixa **inclusiva** de blocos locais. Opcional: cabo sem
   * o hypercore real (rig) não tem bitfield para podar.
   */
  clearRange?(startBlock: number, endBlock: number): Promise<void>;
  close(): Promise<void>;
};

export type BlobsReaderPort = {
  readonly key: Buffer;
  /** §14.1/§16.1 — entra na replicação sobre um mux já montado. Uma vez por (mux, core). */
  replicate(mux: unknown): void;
  /** Pede a faixa esparsa; resolve quando os blocos chegaram (ou rejeita por rede). */
  downloadRange(startBlock: number, endBlock: number): Promise<void>;
  /** Bloco já baixado; `null` quando ausente. */
  getBlock(seq: number): Promise<Uint8Array | null>;
  /**
   * §13.4 passo 4 — leitura **real** do bitfield, nunca estimativa: quantos blocos da faixa
   * já estão locais e quais pares **anunciam ter** a faixa inteira (chave pública remota em
   * hex). Opcional porque um rig sem replicação não tem o que ler.
   */
  rangeStatus?(startBlock: number, endBlock: number): Promise<{ readonly blocksHave: number; readonly peers: readonly string[] }>;
  close(): Promise<void>;
};

export type BlobEvent = {
  readonly topic: 'blob.completed' | 'blob.unavailable' | 'attachment.corrupt' | 'blob.progress' | 'blob.peerLost';
  /** Exatamente os campos da tabela de §15.5 — nada além deles sai no fio. */
  readonly data: {
    readonly blobsCoreKey: string;
    readonly blobIdHex: string;
    readonly path?: string;
    readonly cause?: 'hash' | 'size';
    /** `blob.progress` (§13.4 passo 4): fração 0..1, bytes já locais, pares com a faixa. */
    readonly progress?: number;
    readonly bytesDownloaded?: number;
    readonly peers?: number;
    readonly hostAvailable?: boolean;
    /** `blob.peerLost`: quantos pares com a faixa restaram depois da perda. */
    readonly remaining?: number;
  };
  /** Rota do fan-out (§15.1 regra 2) — viaja ao lado do evento, nunca dentro do payload. */
  readonly communityId?: string;
};

export type BlobStoreEntry = {
  blobsCoreKeyHex: string;
  blobIdHex: string;
  path: string;
  hashHex: string;
  sizeBytes: number;
  kind: BlobKindNumber;
  name: string;
};

export type BlobManagerOptions = {
  readonly manifest: ManifestDb;
  readonly swarm: Swarm;
  readonly dataDir?: string;
  readonly clock?: () => number;
  readonly ttlMs?: number;
  readonly orphanMs?: number;
  readonly cacheMaxBytes?: number;
  /** Abre o leitor esparsso de um core de blobs alheio (§13.4). Ausente = caminho local só. */
  openReader?(blobsCoreKey: Buffer): Promise<BlobsReaderPort | null> | BlobsReaderPort | null;
  /** Prazo de §14.5 (`REPLICATION_STALL_MS`) aplicado à espera da faixa; teste injeta menor. */
  readonly downloadTimeoutMs?: number;
  /** Chave do host da comunidade (§13.4 passo 4) — `hostAvailable` é fato, não palpite. */
  hostKeyOf?(communityId: string): Buffer | null;
  /** Cadência de `blob.progress` (§22.1: 500 ms). */
  readonly progressIntervalMs?: number;
  /** Relógio de intervalo injetável — o teste dirige o loop sem esperar meio segundo. */
  startInterval?(fn: () => void, ms: number): () => void;
  /** Eventos de §15.5 produzidos aqui saem por esta porta — quem monta o grafo liga o fan-out. */
  onEvent?(ev: BlobEvent): void;
};

export type StageResult = {
  readonly blobsCoreKey: Buffer;
  readonly blobId: { byteOffset: number; blockOffset: number; blockLength: number; byteLength: number };
  readonly blobIdHex: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly kind: BlobKindNumber;
  readonly hash: Buffer;
};

export type DownloadOpts = {
  readonly blobsCoreKey: Buffer;
  readonly blobIdHex: string;
  readonly declaredSize: number;
  readonly hash: Buffer;
  readonly name: string;
  /** Recorte no core de blobs do autor (§7.2.1) — a faixa que §13.4 passo 3 pede. */
  readonly blobId?: { readonly byteOffset: number; readonly blockOffset: number; readonly blockLength: number; readonly byteLength: number };
  /** Rota do evento de §15.5 — o dado da tabela não a nomeia. */
  readonly communityId?: string;
};

export class BlobManager {
  readonly manifest: ManifestDb;
  readonly swarm: Swarm;
  readonly tickets: TicketStore;
  readonly staging: StagingManager;
  readonly cache: DownloadCache;
  readonly #dataDir: string;
  readonly #clock: () => number;
  readonly #cacheMaxBytes: number;
  readonly #openReader: ((blobsCoreKey: Buffer) => Promise<BlobsReaderPort | null> | BlobsReaderPort | null) | null;
  readonly #timeoutMs: number;
  readonly #onEvent: ((ev: BlobEvent) => void) | null;
  readonly #hostKeyOf: ((communityId: string) => Buffer | null) | null;
  readonly #progressMs: number;
  readonly #startInterval: (fn: () => void, ms: number) => () => void;
  /** Leitores remotos em uso agora (download em voo) — o GC de §22.4 não fecha estes. */
  readonly #emUso = new Map<string, number>();
  /**
   * §13.4 — downloads cancelados em voo (`<coreHex>/<blobIdHex>`). Em memória de propósito:
   * o cancelamento é do download DESTA execução; o estado durável já é `cancelled` no cache,
   * e a retomada de boot é decisão do `resumeOnBoot`, não desta marca.
   */
  readonly #cancelados = new Set<string>();
  /** §13.2 — `ticketId` com um `stage` em voo. Uso único vale contra a concorrência também. */
  readonly #stagingEmVoo = new Set<string>();
  /** Core de blobs local por comunidade (§13.1) — quem anuncia o tópico e escreve. */
  readonly #locais = new Map<string, BlobsWriterPort>();
  /**
   * §31.14 — quais escopos são de **conversa direta**, e não de comunidade.
   *
   * O `BlobManager` sempre chaveou por uma string opaca, e §31.14 manda reusar §13 inteiro:
   * o `conversationId` entra no mesmo slot que o `communityId`, e o fluxo de upload, o de
   * download, a barreira blob↔mensagem e os oito estados de cache seguem sem alteração.
   * O que **precisa** de distinção é uma coisa só — a cota R-14, que §31.14 declara não
   * aplicável —, e o tópico DHT, que não deve mentir sobre o que anuncia.
   */
  readonly #escoposDm = new Set<string>();
  /**
   * Fechamentos de core em voo disparados por `detachLocalCore`. A parada da comunidade
   * (`OpenCommunity.stop()`) é **síncrona** por contrato e chama o detach sem poder esperá-lo:
   * sem este registro, `close()` devolveria com um RocksDB ainda fechando por baixo, e quem
   * confia no fim do `close()` para apagar arquivos (§18.6 wipe, §18.7 draining) acharia o
   * diretório ocupado.
   */
  readonly #fechamentos = new Set<Promise<void>>();
  /** Todos os cores de blobs conhecidos, por chave hex — os que replicam nos muxes vivos. */
  readonly #cores = new Map<string, { port: BlobsWriterPort | BlobsReaderPort; announce: boolean; topicHex: string; communityId: string | null }>();
  /** Estado de replicação por mux — `replicate` é UMA vez por (mux, core). */
  readonly #muxes = new Map<object, { done: Set<string> }>();
  /**
   * Resultado do último `stage` por ticket (§13.7 regra 1). Em memória de propósito: é o
   * material que liga o ticket ao blob local — `blobsCoreKey` e `blobId` — e que
   * `local_blob_staging` (§13.5) não guarda. Perder no crash é o comportamento certo: sem
   * ele, `message.send` com anexo recusa e a UI reencena o `blob.stage`, que é idempotente
   * do ponto de vista do autor. O que **não** pode acontecer é a mensagem sair apontando
   * para um blob que este núcleo não escreveu.
   */
  readonly #staged = new Map<string, StageResult>();

  constructor(opts: BlobManagerOptions) {
    this.manifest = opts.manifest;
    this.swarm = opts.swarm;
    const clock = opts.clock ?? Date.now;
    this.#clock = clock;
    this.#dataDir = opts.dataDir ?? path.join(process.cwd(), 'blobs');
    this.tickets = new TicketStore({ ttlMs: opts.ttlMs ?? STAGING_TICKET_TTL_MS_DEFAULT, clock });
    this.staging = new StagingManager(opts.manifest, { clock, orphanMs: opts.orphanMs ?? STAGING_ORPHAN_MS_DEFAULT });
    this.cache = new DownloadCache(opts.manifest, { clock });
    this.#cacheMaxBytes = opts.cacheMaxBytes ?? BLOB_CACHE_MAX_BYTES_DEFAULT;
    this.#openReader = opts.openReader ?? null;
    this.#timeoutMs = opts.downloadTimeoutMs ?? 20_000;
    this.#onEvent = opts.onEvent ?? null;
    this.#hostKeyOf = opts.hostKeyOf ?? null;
    this.#progressMs = opts.progressIntervalMs ?? BLOB_PROGRESS_MS;
    this.#startInterval =
      opts.startInterval ??
      ((fn, ms) => {
        const t = setInterval(fn, ms);
        t.unref?.();
        return () => clearInterval(t);
      });
  }

  // ── Cores de blobs (§13.1, §14.1, §16.1) ─────────────────────────────────

  /**
   * Registra o core de blobs local de uma comunidade. Quem **tem** o core anuncia o tópico
   * de §14.1 (`server`) e passa a replicá-lo em todo mux vivo — inclusive nos que já
   * existiam, porque uma conexão do hyperdht é única por par e o core pode nascer depois
   * dela. A semente veio cifrada do `member_blobs_core` (§10.2); quem abriu o writer foi a
   * composição, que é quem lê o manifest com a Data Key.
   */
  attachLocalCore(
    communityId: string,
    writer: BlobsWriterPort,
    opts: { readonly escopo?: 'community' | 'dm' } = {},
  ): void {
    const keyHex = writer.key.toString('hex');
    if (this.#cores.has(keyHex)) return;
    const dm = opts.escopo === 'dm';
    this.#locais.set(communityId, writer);
    if (dm) this.#escoposDm.add(communityId);
    const topicHex = discoveryKeyHexForBlobsCoreKey(writer.key);
    this.#cores.set(keyHex, { port: writer, announce: true, topicHex, communityId });
    // §14.1 — quem tem o core anuncia. Client aqui seria pedir o que já se tem.
    //
    // §31.14 — o tópico é o MESMO `BLAKE2b('blob-discovery/1' ‖ blobsCoreKey)` de §13.4, e
    // continua não revelando a conversa nem o par: a chave é derivada do `identitySeed` de
    // quem escreve (§31.3). O `kind` também é o mesmo, e isso não é preguiça — §31.14
    // classifica o core de blobs de DM como "core de blobs por autor, **reutilizado**",
    // que é exatamente o que `member-blobs` nomeia. O que muda é o `communityId`, que sai
    // `null`: o campo já é anulável e é o lugar certo para dizer "este não pertence a
    // comunidade nenhuma". Inventar um `kind` novo em L0 mexeria no vocabulário declarado
    // de §14.1 para não dizer nada que este `null` não diga.
    if (!this.swarm.isJoined(topicHex)) {
      this.swarm.join(
        topicHex,
        { topicHex, kind: 'member-blobs', communityId: dm ? null : communityId },
        { server: true, client: false },
      );
    }
    this.#replicarEmTodos(keyHex);
  }

  async detachLocalCore(communityId: string): Promise<void> {
    const writer = this.#locais.get(communityId);
    if (writer === undefined) return;
    this.#locais.delete(communityId);
    this.#escoposDm.delete(communityId);
    const keyHex = writer.key.toString('hex');
    const registro = this.#cores.get(keyHex);
    this.#cores.delete(keyHex);
    if (registro !== undefined) this.swarm.leave(registro.topicHex);
    // A desinscrição acima é síncrona de propósito: quem chamar de novo não reabre nada. O
    // fechamento é o que demora, e fica visível para `close()` até terminar.
    const fechando = writer.close().catch(() => {});
    this.#fechamentos.add(fechando);
    try {
      await fechando;
    } finally {
      this.#fechamentos.delete(fechando);
    }
  }

  /** Chave pública do core de blobs local da comunidade — o que o ticket/stage precisam. */
  localCoreKey(communityId: string): Buffer | null {
    return this.#locais.get(communityId)?.key ?? null;
  }

  /**
   * §13.5/§22.4 — libera a faixa de blocos que um staging órfão escreveu no core LOCAL da
   * comunidade. Sem core local anexado (ou sem cabo com `clearRange`), não há o que podar —
   * e a linha do staging é removida do mesmo jeito, porque o registro em si já não serve.
   */
  async clearLocalRange(communityId: string, startBlock: number, endBlock: number): Promise<void> {
    const writer = this.#locais.get(communityId);
    if (writer?.clearRange === undefined) return;
    await writer.clearRange(startBlock, endBlock);
  }

  /**
   * Liga todos os cores conhecidos a este mux, uma vez cada. Chamado pelo transporte a cada
   * conexão avaliada e reavaliada; o custo de repetição é um `Set.has`. O `attachTo` do
   * hypercore **não** é idempotente: rechamar cria peers duplicados que se matam.
   */
  serveMux(mux: object): void {
    let entrada = this.#muxes.get(mux);
    if (entrada === undefined) {
      entrada = { done: new Set<string>() };
      this.#muxes.set(mux, entrada);
    }
    for (const [keyHex, registro] of this.#cores) {
      if (entrada.done.has(keyHex)) continue;
      entrada.done.add(keyHex);
      registro.port.replicate(mux);
    }
  }

  /** Mux morto: esquece a marcação — se o stream voltar, será outro objeto. */
  forgetMux(mux: object): void {
    this.#muxes.delete(mux);
  }

  #replicarEmTodos(keyHex: string): void {
    const registro = this.#cores.get(keyHex);
    if (registro === undefined) return;
    for (const [mux, entrada] of this.#muxes) {
      if (entrada.done.has(keyHex)) continue;
      entrada.done.add(keyHex);
      registro.port.replicate(mux);
    }
  }

  async #readerFor(blobsCoreKey: Buffer): Promise<BlobsReaderPort | null> {
    const keyHex = blobsCoreKey.toString('hex');
    const existente = this.#cores.get(keyHex);
    if (existente !== undefined && !existente.announce) return existente.port as BlobsReaderPort;
    if (existente !== undefined) return null; // é o core local; dono não baixa de si mesmo
    if (this.#openReader === undefined || this.#openReader === null) return null;
    const reader = await this.#openReader(blobsCoreKey);
    if (reader === null) return null;
    this.#cores.set(reader.key.toString('hex'), {
      port: reader,
      announce: false,
      topicHex: discoveryKeyHexForBlobsCoreKey(reader.key),
      communityId: null,
    });
    // O leitor pode nascer depois das conexões: entra nos muxes vivos na hora.
    this.#replicarEmTodos(reader.key.toString('hex'));
    return reader;
  }

  #emitir(ev: BlobEvent): void {
    this.#onEvent?.(ev);
  }

  // ── Ticket ingest via IPC-M (§15.7 staging.ticket) ────────────────────────

  /** Recebe ticket do main (IPC-M) — path nunca cruza IPC-R. */
  ingestTicket(ticket: StagingTicket): TicketIssue {
    // Valida e persiste ticket como staging pendente
    this.tickets.ingest(ticket);
    this.staging.createFromTicket(ticket);
    return { ticketId: ticket.ticketId, name: ticket.name, sizeBytes: ticket.sizeBytes, kind: ticket.kind };
  }

  /** Helper para main criar ticket: main abre dialog, deriva name/kind, emite ticket. */
  createTicketForMain(communityId: string, filePath: string, sizeBytes: number): StagingTicket {
    const name = path.basename(filePath);
    const kind = kindFromFilename(name);
    if (!isValidAttachmentName(name)) throw Object.assign(new Error('Nome inválido'), { code: 'E_VALIDATION', field: 'name' });
    const issued = this.tickets.issue(communityId, filePath, sizeBytes);
    const ticket: StagingTicket = {
      ticketId: issued.ticketId,
      path: filePath,
      sizeBytes,
      communityId,
      createdAt: this.#clock(),
      name: issued.name,
      kind: issued.kind,
    };
    // Persiste imediatamente para retomada
    this.staging.createFromTicket(ticket);
    return ticket;
  }

  // ── Stage (§13.2) — só via ticketId, nunca via path direto (fecha T-16/DR-37) ─

  /**
   * `blob.stage{ticketId}` — lê arquivo em stream, calcula BLAKE2b('blob-hash/1'‖conteúdo),
   * faz hyperblobs.put em chunks journalando bytesWritten, e devolve BlobStageResult.
   * Recusa qualquer path vindo do renderer, sempre.
   */
  async stage(ticketId: string, opts: { blobsCoreKey?: Buffer; identitySeed?: Buffer; communityId?: string } = {}): Promise<StageResult> {
    if (!isValidTicketId(ticketId)) throw Object.assign(new Error('Ticket inválido'), { code: 'E_TICKET_INVALID' });
    const stagingRow = this.staging.get(ticketId);
    if (stagingRow === null) throw Object.assign(new Error('Ticket não encontrado'), { code: 'E_TICKET_INVALID' });
    if (stagingRow.state === 'done') throw Object.assign(new Error('Ticket já usado'), { code: 'E_TICKET_INVALID' });
    /**
     * **Uso único também vale para o stage CONCORRENTE** (emenda de 2026-09-05).
     *
     * A guarda de cima lê `state === 'done'`, e `markDone` só roda no fim: dois `stage` do
     * mesmo ticket disparados juntos (duplo clique em "anexar") passavam os dois. Um vencia
     * o `consume`, o outro caía na retomada abaixo, e os DOIS appendavam o arquivo inteiro
     * no core — o segundo `markDone` sobrescrevia `blobRanges` e os blocos do primeiro
     * viravam lixo que nenhum `core.clear` de §22.4 sabe podar. Uma linha de staging tem um
     * stage por vez, e o segundo é recusado como o ticket já usado que ele é.
     */
    if (this.#stagingEmVoo.has(ticketId)) throw Object.assign(new Error('Ticket já usado'), { code: 'E_TICKET_INVALID' });
    this.#stagingEmVoo.add(ticketId);
    try {
      return await this.#stage(ticketId, stagingRow, opts);
    } finally {
      this.#stagingEmVoo.delete(ticketId);
    }
  }

  async #stage(
    ticketId: string,
    stagingRow: StagingRow,
    opts: { blobsCoreKey?: Buffer; identitySeed?: Buffer; communityId?: string },
  ): Promise<StageResult> {
    // Valida ticket store (TTL, uso único, escopo)
    let ticket: StagingTicket;
    try {
      ticket = this.tickets.consume(ticketId, stagingRow.communityId ?? undefined);
    } catch (e) {
      /**
       * **A retomada é só para o ticket que este processo não conhece** (emenda de
       * 2026-09-05). `TicketStore` é memória e a linha de staging é disco: depois de um
       * restart, retomar um `pending`/`writing` é §13.5 funcionando, e a janela que o
       * governa é a órfã de 24 h da linha, não a TTL do ticket.
       *
       * Antes, QUALQUER falha do `consume` caía aqui — inclusive vencido e já usado. A TTL
       * de 15 min era inócua sempre que a linha sobrevivesse: bastava o renderer guardar um
       * `ticketId` velho e encenar o `stage` horas depois. Ticket que este processo conhece
       * e recusou é recusa, e o motivo dela é o que sobe.
       */
      if (this.tickets.get(ticketId) !== undefined) throw e;
      if (stagingRow.state !== 'pending' && stagingRow.state !== 'writing') throw e;
      ticket = {
        ticketId: stagingRow.ticketId,
        path: stagingRow.path,
        sizeBytes: stagingRow.sizeBytes ?? 0,
        communityId: stagingRow.communityId ?? '',
        createdAt: stagingRow.createdAt ?? this.#clock(),
        name: stagingRow.name ?? path.basename(stagingRow.path),
        kind: (stagingRow.kind as BlobKindNumber) ?? BLOB_KIND.other,
      };
    }

    const filePath = ticket.path;
    const communityId = ticket.communityId;
    // Verifica arquivo existe e tamanho
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      this.staging.markFailed(ticketId);
      throw Object.assign(new Error('Arquivo não legível'), { code: 'E_FILE_UNREADABLE' });
    }
    if (!stat.isFile() || stat.size < 1) {
      // Arquivo vazio não tem blocos que valham: sem faixa no core, o leitor esperaria
      // para sempre um bloco que nunca existiu.
      this.staging.markFailed(ticketId);
      throw Object.assign(new Error('Arquivo não legível'), { code: 'E_FILE_UNREADABLE' });
    }
    if (stat.size !== ticket.sizeBytes) {
      // Tamanho declarado diverge — pode ser race, mas trata como erro de validação
      // Permite continuar com tamanho real, pois o hash final valida
    }
    if (stat.size > ATTACHMENT_MAX_BYTES) {
      this.staging.markFailed(ticketId);
      throw Object.assign(new Error('Anexo muito grande'), { code: 'E_ATTACHMENT_TOO_LARGE' });
    }
    if (!isValidAttachmentName(ticket.name)) {
      this.staging.markFailed(ticketId);
      throw Object.assign(new Error('Nome inválido'), { code: 'E_VALIDATION', field: 'name' });
    }
    // A antecipação de R-14 que existia aqui **saiu** com a cota, na emenda de 2026-09-04
    // (§13.8, `opVersion = 3`): não há mais nada a estimar antes de gravar, porque não há
    // mais fronteira de bytes por membro. O que continua barrando o stage é o teto de
    // representação (`ATTACHMENT_MAX_BYTES`, conferido no ticket) e o disco de verdade —
    // `E_STORAGE_FULL` no `put`, que com a cota fora deixou de ser caso patológico e é
    // desfecho nomeado do fluxo.

    // Determina o core de blobs do autor: o LOCAL da comunidade (§13.1) quando registrado,
    // ou a chave explícita de quem chamou. Sem nenhum dos dois, recusa — nenhum membro
    // escreve sem o core dele (A09, F-03).
    let blobsCoreKey: Buffer;
    const escritor = this.#locais.get(communityId) ?? null;
    if (escritor !== null) {
      blobsCoreKey = escritor.key;
    } else if (opts.blobsCoreKey !== undefined) {
      blobsCoreKey = Buffer.from(opts.blobsCoreKey);
    } else if (opts.identitySeed !== undefined && communityId) {
      blobsCoreKey = deriveMemberBlobsPublicKey(opts.identitySeed, communityId);
    } else {
      throw Object.assign(new Error('Sem chave de blobs do autor'), { code: 'E_NO_BLOBS_KEY' });
    }

    // Stream + hash + journaling (§13.2 passo 5).
    //
    // Emenda de 2026-09-04: nada de `Buffer.concat` sobre o arquivo inteiro. Enquanto havia
    // cota de 5 GiB o acumulador já era grande demais; sem cota (§13.8) ele é uma parada por
    // falta de memória em qualquer arquivo que caiba no disco e não na RAM. O hash passa a ser
    // incremental (`crypto_generichash_init/update/final`, mesmo domínio `blob-hash/1`) e as
    // fatias vão para o core em lotes, de modo que o pico de memória é o lote, não o arquivo.
    this.staging.updateProgress(ticketId, 0, null);
    let bytesWritten = 0;
    const chunkSize = BLOB_CHUNK_BYTES;
    const fd = await fs.promises.open(filePath, 'r');
    const fileSize = stat.size;
    const hashState = Buffer.allocUnsafe(sodium.crypto_generichash_STATEBYTES);
    sodium.crypto_generichash_init(hashState, null, 32);
    sodium.crypto_generichash_update(hashState, Buffer.from('blob-hash/1', 'utf8'));
    const escreveNoCore = escritor !== null && escritor.key.equals(blobsCoreKey);
    let blockOffsetInicial: number | null = null;
    let blocos = 0;
    let lote: Buffer[] = [];
    const descarregaLote = async (): Promise<void> => {
      if (lote.length === 0 || !escreveNoCore || escritor === null) return;
      const off = await escritor.appendBlocks(lote);
      if (blockOffsetInicial === null) blockOffsetInicial = off;
      lote = [];
    };
    try {
      const buf = Buffer.alloc(chunkSize);
      while (bytesWritten < fileSize) {
        const toRead = Math.min(chunkSize, fileSize - bytesWritten);
        const { bytesRead } = await fd.read(buf, 0, toRead, bytesWritten);
        if (bytesRead === 0) break;
        // Cópia obrigatória: `buf` é reutilizado a cada leitura; um subarray aqui seria
        // uma view que o próximo read sobrescreve, corrompendo o hash de anexos > 1 chunk.
        const fatia = Buffer.from(buf.subarray(0, bytesRead));
        sodium.crypto_generichash_update(hashState, fatia);
        blocos += 1;
        if (escreveNoCore) {
          lote.push(fatia);
          if (lote.length >= STAGE_BATCH_BLOCKS) await descarregaLote();
        }
        bytesWritten += bytesRead;
        // Journal a cada chunk — manifest com FULL garante durabilidade
        this.staging.updateProgress(ticketId, bytesWritten, null);
      }
      await descarregaLote();
    } finally {
      await fd.close();
    }

    const hash = Buffer.allocUnsafe(32);
    sodium.crypto_generichash_final(hashState, hash);
    const blobIdHex = hash.toString('hex').slice(0, 32); // 16 bytes hex como id mock
    // O recorte no core de blobs do autor (§7.2.1): com core local, o conteúdo entra em
    // blocos appendaris e o `blobId` é a faixa que o leitor pedirá (§13.4 passo 3). Sem
    // core (rigs de teste), o quadruplo fica no formato antigo.
    const blobId = {
      byteOffset: 0,
      blockOffset: blockOffsetInicial ?? 0,
      blockLength: Math.max(1, escreveNoCore ? blocos : Math.ceil(fileSize / chunkSize)),
      byteLength: fileSize,
    };

    // Persiste blob no store local (simula hyperblobs core do autor)
    const storeDir = path.join(this.#dataDir, blobsCoreKey.toString('hex'));
    await fs.promises.mkdir(storeDir, { recursive: true });
    const storedPath = path.join(storeDir, `${blobIdHex}-${ticket.name}`);
    try {
      await fs.promises.copyFile(filePath, storedPath);
    } catch (e) {
      // Se falhar cópia, mantém staging como failed. Emenda de 2026-09-04: com a cota fora
      // (§13.8), disco cheio deixou de ser caso patológico e virou o desfecho esperado de
      // quem anexa arquivo grande — então ele é nomeado, e não confundido com um erro de
      // leitura ou de permissão, que têm outra resposta na UI.
      this.staging.markFailed(ticketId);
      const errno = (e as { code?: string }).code;
      const semEspaco = errno === 'ENOSPC' || errno === 'EDQUOT' || errno === 'EFBIG';
      throw Object.assign(new Error(semEspaco ? 'Disco cheio ao gravar o anexo' : 'Falha ao armazenar blob'), {
        code: semEspaco ? 'E_STORAGE_FULL' : 'E_FILE_UNREADABLE',
      });
    }

    // Marca staging como done e journal hash, com a faixa de blocos que o `core.clear`
    // de §13.5/§22.4 precisa para podar SEM tocar os anexos vivos do mesmo core.
    this.staging.markDone(ticketId, hash, bytesWritten, {
      blockOffset: blobId.blockOffset,
      blockLength: blobId.blockLength,
    });

    // Registra também no cache como verificado (o autor já tem o blob)
    this.cache.upsert({
      blobsCoreKey,
      blobIdHex,
      state: 'downloaded',
      bytesDownloaded: fileSize,
      declaredSize: fileSize,
      path: storedPath,
    });

    const result: StageResult = {
      blobsCoreKey,
      blobId,
      blobIdHex,
      name: ticket.name,
      sizeBytes: fileSize,
      kind: ticket.kind,
      hash,
    };
    this.#staged.set(ticketId, result);
    return result;
  }

  /**
   * §13.7 regra 1 — o que o `blob.stage` deste ticket produziu, ou `null`. É a **única**
   * fonte do `attachment` de `message.send`: nada que descreva o blob vem do renderer.
   */
  stagedResult(ticketId: string): StageResult | null {
    const result = this.#staged.get(ticketId);
    if (result === undefined) return null;
    return this.isStagedDone(ticketId) ? result : null;
  }

  // ── Barreira blob ↔ mensagem (§13.7) ─────────────────────────────────────

  /**
   * Verifica se `message.send` com anexo pode ser enfileirada.
   * Só depois que `blob.stage` completou e `hyperblobs.put` foi flushado.
   */
  assertReadyForMessage(ticketId: string): void {
    const row = this.staging.get(ticketId);
    if (row === null || row.state !== 'done' || row.hash === null) {
      throw Object.assign(new Error('Blob ainda não staged'), { code: 'E_BLOB_NOT_STAGED' });
    }
  }

  /**
   * §13.7 regra 1 pelo outro lado do balcão: **este núcleo escreveu este blob?**
   *
   * `message.send` (§15.4) manda só o `ticketId`, então a barreira é `stagedResult`. Já
   * `dm.send` (§31.16.1) recebe o `attachment` completo no argumento, e a mesma regra
   * precisa valer ali: nada que descreva o blob pode vir do renderer sem confronto. Sem
   * esta busca, o renderer poderia mandar uma referência que ninguém staged e a mensagem
   * apontaria para bytes que este nó não tem — que é exatamente o `E_BLOB_NOT_STAGED` que
   * a tabela de §31.16.1 já declara.
   *
   * O confronto é pelo **hash**, e não pelo nome ou pelo tamanho: o hash é o que identifica
   * o conteúdo (§13.2 passo 5), e a faixa e a chave são conferidas junto para que um blob
   * staged noutra conversa não sirva de passe para esta.
   */
  stagedMatching(a: {
    readonly blobsCoreKey: Buffer;
    readonly blobIdHex: string;
    readonly hash: Buffer;
  }): StageResult | null {
    for (const [ticketId, r] of this.#staged) {
      if (!r.hash.equals(a.hash)) continue;
      if (!r.blobsCoreKey.equals(a.blobsCoreKey)) continue;
      if (r.blobIdHex.toLowerCase() !== a.blobIdHex.toLowerCase()) continue;
      if (!this.isStagedDone(ticketId)) continue;
      return r;
    }
    return null;
  }

  isStagedDone(ticketId: string): boolean {
    const row = this.staging.get(ticketId);
    return row !== null && row.state === 'done';
  }

  // ── Download (§13.4) ─────────────────────────────────────────────────────

  /**
   * `blob.download{blobsCoreKey, blobId}` — swarm.join, hyperblobs.get por range, progresso 500ms,
   * abort se > declaredSize, verifica hash, grava em blobs/<coreHex>/<blobIdHex>-<name>.
   */
  async download(opts: DownloadOpts): Promise<{ path: string }> {
    const { blobsCoreKey, blobIdHex, declaredSize, hash, name } = opts;
    if (declaredSize < 1 || declaredSize > ATTACHMENT_MAX_BYTES) {
      throw Object.assign(new Error('Tamanho declarado inválido'), { code: 'E_VALIDATION', field: 'sizeBytes' });
    }
    if (!isValidAttachmentName(name)) throw Object.assign(new Error('Nome inválido'), { code: 'E_VALIDATION', field: 'name' });

    // Estado inicial — não retorna early se hash for diferente do já verificado;
    // o cache não armazena hash, então precisa re-verificar sempre que hash for fornecido e diferir do arquivo existente
    const existing = this.cache.get(blobsCoreKey, blobIdHex);
    if (existing !== null && existing.state === 'downloaded' && existing.path !== null && fs.existsSync(existing.path)) {
      // Verifica se o arquivo existente bate com o hash pedido; se não, força re-verificação
      try {
        const existingData = await fs.promises.readFile(existing.path);
        const existingHash = hashForBlobContent(existingData);
        if (existingHash.equals(hash) && existingData.length <= declaredSize) {
          return { path: existing.path };
        }
        // hash diverge ou tamanho diverge — cai no fluxo de verificação que marcará corrupt
      } catch {}
    }
    // Um `cancel` de um download ANTERIOR não cancela este: a marca é por tentativa, e é
    // esta linha que a zera — antes dos dois caminhos (rede e busca local).
    this.#cancelados.delete(`${blobsCoreKey.toString('hex')}/${blobIdHex}`);
    this.cache.upsert({ blobsCoreKey, blobIdHex, state: 'queued', declaredSize, bytesDownloaded: 0 });

    // swarm.join(discoveryKey) se ainda não estiver — §14.1
    const topicHex = discoveryKeyHexForBlobsCoreKey(blobsCoreKey);
    if (!this.swarm.isJoined(topicHex)) {
      this.swarm.join(topicHex, { topicHex, kind: 'member-blobs', communityId: null });
    }
    this.cache.setState(blobsCoreKey, blobIdHex, 'downloading', { bytesDownloaded: 0 });

    // Caminho de rede (§13.4 passos 3–6): com leitor do core alheio e a faixa do `blobId`,
    // os blocos chegam pela replicação — o mesmo mux das comunidades, canal próprio do
    // hypercore. Sem leitor injetado (rigs), vale a busca local de baixo.
    if (opts.blobId !== undefined) {
      const reader = await this.#readerFor(blobsCoreKey);
      if (reader !== null) {
        return await this.#baixarPelaRede(reader, opts as DownloadOpts & { blobId: NonNullable<DownloadOpts['blobId']> });
      }
    }

    // Simula busca: procura em dataDir do dono (mock P2P)
    // Em produção, seria `hyperblobs.get` por range com bitfield.
    // Aqui tenta copiar de qualquer store local que tenha o blob
    let sourcePath: string | null = null;
    // Varre dataDir por blobsCoreKey
    const ownerDir = path.join(this.#dataDir, blobsCoreKey.toString('hex'));
    try {
      const files = await fs.promises.readdir(ownerDir);
      const match = files.find((f) => f.startsWith(blobIdHex));
      if (match !== undefined) sourcePath = path.join(ownerDir, match);
    } catch {}

    if (sourcePath === null) {
      // Nenhum peer tem — marca unavailable se host também não tem
      this.cache.setState(blobsCoreKey, blobIdHex, 'unavailable');
      throw Object.assign(new Error('Nenhum par tem o blob'), { code: 'E_NO_PEERS' });
    }

    // Lê e verifica tamanho
    const data = await fs.promises.readFile(sourcePath);
    if (data.length > declaredSize) {
      this.cache.setState(blobsCoreKey, blobIdHex, 'corrupt');
      throw Object.assign(new Error('Tamanho excede declarado'), { code: 'E_BLOB_CORRUPT', cause: 'size' });
    }

    this.cache.setState(blobsCoreKey, blobIdHex, 'verifying', { bytesDownloaded: data.length });

    // Verifica hash §13.4 passo 6
    const computed = hashForBlobContent(data);
    if (!computed.equals(hash)) {
      this.cache.setState(blobsCoreKey, blobIdHex, 'corrupt');
      throw Object.assign(new Error('Hash diverge'), { code: 'E_BLOB_CORRUPT', cause: 'hash' });
    }

    // Grava em blobs/<blobsCoreKeyHex>/<blobIdHex>-<name> → blob.completed{path}
    const destDir = path.join(this.#dataDir, blobsCoreKey.toString('hex'));
    await fs.promises.mkdir(destDir, { recursive: true });
    const destPath = path.join(destDir, `${blobIdHex}-${name}`);
    // Se sourcePath já é o destino (dono baixando próprio), não copia
    if (sourcePath !== destPath) {
      await fs.promises.copyFile(sourcePath, destPath);
    }
    // Marca de origem no Windows (§13.6 regra 3) — só onde SO suportar; no Linux não aplica
    // Mock: não tenta Zone.Identifier, apenas registra que não aplicou em Linux

    if (this.#cancelado(blobsCoreKey.toString('hex'), blobIdHex)) {
      throw Object.assign(new Error('Download cancelado'), { code: 'E_CANCELLED' });
    }
    this.cache.setState(blobsCoreKey, blobIdHex, 'downloaded', { bytesDownloaded: data.length, path: destPath, declaredSize });
    return { path: destPath };
  }

  /**
   * §13.4 passos 3–7 sobre a replicação real. A faixa é a do `blobId` projetado; o teto de
   * bytes vale sobre o que **chegou** (passo 5), e o hash sobre o recorte montado (passo 6).
   * Cada desfecho nomeado sai por evento — `blob.completed`, `attachment.corrupt`,
   * `blob.unavailable` — nunca por silêncio.
   */
  async #baixarPelaRede(
    reader: BlobsReaderPort,
    opts: DownloadOpts & { blobId: NonNullable<DownloadOpts['blobId']> },
  ): Promise<{ path: string }> {
    const chaveHex = opts.blobsCoreKey.toString('hex');
    const start = opts.blobId.blockOffset;
    const end = start + Math.max(1, opts.blobId.blockLength) - 1;
    // §22.1 — enquanto a faixa não chega, o loop de 500 ms publica progresso e perda de
    // par. O leitor fica marcado em uso: o GC de §22.4 não fecha core sob download.
    this.#emUso.set(chaveHex, (this.#emUso.get(chaveHex) ?? 0) + 1);
    const pararProgresso = this.#loopDeProgresso(reader, opts, start, end);
    try {
      return await this.#baixarFaixa(reader, opts);
    } finally {
      pararProgresso();
      this.#cancelados.delete(`${chaveHex}/${opts.blobIdHex}`);
      const n = (this.#emUso.get(chaveHex) ?? 1) - 1;
      if (n <= 0) this.#emUso.delete(chaveHex);
      else this.#emUso.set(chaveHex, n);
    }
  }

  /**
   * §13.4 passo 4 — o loop de progresso sobre a leitura REAL do bitfield: quantos blocos da
   * faixa já são locais e quais pares anunciam tê-la. `hostAvailable` é o `hostKey` da
   * comunidade entre esses pares. Um par que sai da lista vira `blob.peerLost{remaining}` —
   * o número que sobrou, não uma estimativa. Leitor sem `rangeStatus` (rig sem replicação)
   * não produz evento nenhum: silêncio é melhor que número inventado.
   */
  #loopDeProgresso(
    reader: BlobsReaderPort,
    opts: DownloadOpts & { blobId: NonNullable<DownloadOpts['blobId']> },
    start: number,
    end: number,
  ): () => void {
    if (reader.rangeStatus === undefined || this.#onEvent === null) return () => {};
    const chaveHex = opts.blobsCoreKey.toString('hex');
    const rota = opts.communityId === undefined ? {} : { communityId: opts.communityId };
    const totalBlocos = end - start + 1;
    const hostHex = opts.communityId === undefined ? null : this.#hostKeyOf?.(opts.communityId)?.toString('hex') ?? null;
    let anteriores: ReadonlySet<string> = new Set<string>();
    let rodando = false;
    const tick = (): void => {
      if (rodando) return;
      rodando = true;
      void reader
        .rangeStatus!(start, end)
        .then((status) => {
          const pares = new Set(status.peers);
          // §13.4 passo 4 — bytes locais pela fatia fixa de §13.2, com teto no declarado:
          // o último bloco é parcial, e prometer mais do que o anexo tem seria mentira.
          const bytes = Math.min(status.blocksHave * BLOB_CHUNK_BYTES, opts.blobId.byteLength);
          this.#emitir({
            topic: 'blob.progress',
            data: {
              blobsCoreKey: chaveHex,
              blobIdHex: opts.blobIdHex,
              progress: totalBlocos === 0 ? 1 : Math.min(1, status.blocksHave / totalBlocos),
              bytesDownloaded: bytes,
              peers: pares.size,
              hostAvailable: hostHex !== null && pares.has(hostHex),
            },
            ...rota,
          });
          for (const p of anteriores) {
            if (!pares.has(p)) {
              this.#emitir({
                topic: 'blob.peerLost',
                data: { blobsCoreKey: chaveHex, blobIdHex: opts.blobIdHex, remaining: pares.size },
                ...rota,
              });
              break;
            }
          }
          anteriores = pares;
        })
        .catch(() => {
          /* bitfield indisponível não interrompe download nenhum */
        })
        .finally(() => {
          rodando = false;
        });
    };
    return this.#startInterval(tick, this.#progressMs);
  }

  async #baixarFaixa(
    reader: BlobsReaderPort,
    opts: DownloadOpts & { blobId: NonNullable<DownloadOpts['blobId']> },
  ): Promise<{ path: string }> {
    const { blobsCoreKey, blobIdHex, declaredSize, hash, name, blobId } = opts;
    const rota = opts.communityId === undefined ? {} : { communityId: opts.communityId };
    const chaveHex = blobsCoreKey.toString('hex');
    const start = blobId.blockOffset;
    const end = blobId.blockOffset + Math.max(1, blobId.blockLength) - 1;

    /**
     * §13.4 — a desistência de quem cancelou, conferida em cada ponto de retomada. Só aqui
     * o motor volta a ter o controle: entre um `await` e o seguinte, `cancelDownload` pode
     * ter chegado pela IPC. Cancelado não sobrescreve estado nem emite desfecho — quem
     * cancelou já viu "cancelado", e `blob.completed` por cima disso era a mentira do achado.
     */
    const desistiu = (): boolean => this.#cancelado(chaveHex, blobIdHex);
    const cancelado = (): Error => Object.assign(new Error('Download cancelado'), { code: 'E_CANCELLED' });
    if (desistiu()) throw cancelado();

    try {
      await this.#comPrazo(reader.downloadRange(start, end));
    } catch (e) {
      if (desistiu()) throw cancelado();
      // §14.5 — sem avanço dentro do prazo é `unavailable`, estado nomeado e desenhado.
      this.cache.setState(blobsCoreKey, blobIdHex, 'unavailable');
      this.#emitir({ topic: 'blob.unavailable', data: { blobsCoreKey: chaveHex, blobIdHex }, ...rota });
      throw Object.assign(new Error('Nenhum par entregou a faixa'), { code: 'E_NO_PEERS', cause: e });
    }
    if (desistiu()) throw cancelado();

    const partes: Buffer[] = [];
    let recebidos = 0;
    for (let seq = start; seq <= end; seq++) {
      const bloco = await reader.getBlock(seq);
      if (desistiu()) throw cancelado();
      if (bloco === null) {
        this.cache.setState(blobsCoreKey, blobIdHex, 'unavailable');
        this.#emitir({ topic: 'blob.unavailable', data: { blobsCoreKey: chaveHex, blobIdHex }, ...rota });
        throw Object.assign(new Error('Bloco ausente na faixa'), { code: 'E_NO_PEERS' });
      }
      recebidos += bloco.byteLength;
      if (recebidos > declaredSize) {
        // §13.4 passo 5 — aborta no instante em que o teto é estourado.
        this.cache.setState(blobsCoreKey, blobIdHex, 'corrupt', { bytesDownloaded: recebidos });
        this.#emitir({ topic: 'attachment.corrupt', data: { blobsCoreKey: chaveHex, blobIdHex, cause: 'size' }, ...rota });
        throw Object.assign(new Error('Tamanho excede declarado'), { code: 'E_BLOB_CORRUPT', cause: 'size' });
      }
      partes.push(Buffer.from(bloco));
    }

    const bruto = Buffer.concat(partes);
    const bytes =
      blobId.byteOffset > 0 || bruto.byteLength !== blobId.byteLength
        ? bruto.subarray(blobId.byteOffset, blobId.byteOffset + blobId.byteLength)
        : bruto;

    this.cache.setState(blobsCoreKey, blobIdHex, 'verifying', { bytesDownloaded: bytes.byteLength });
    if (!hashForBlobContent(bytes).equals(hash)) {
      // §13.4 passo 6 — hash divergente é descartado, não servido.
      this.cache.setState(blobsCoreKey, blobIdHex, 'corrupt', { bytesDownloaded: bytes.byteLength });
      this.#emitir({ topic: 'attachment.corrupt', data: { blobsCoreKey: chaveHex, blobIdHex, cause: 'hash' }, ...rota });
      throw Object.assign(new Error('Hash diverge'), { code: 'E_BLOB_CORRUPT', cause: 'hash' });
    }

    if (desistiu()) throw cancelado();
    const destDir = path.join(this.#dataDir, blobsCoreKey.toString('hex'));
    await fs.promises.mkdir(destDir, { recursive: true });
    const destPath = path.join(destDir, `${blobIdHex}-${name}`);
    await fs.promises.writeFile(destPath, bytes);
    if (desistiu()) {
      await fs.promises.rm(destPath, { force: true }).catch(() => {});
      throw cancelado();
    }

    this.cache.setState(blobsCoreKey, blobIdHex, 'downloaded', { bytesDownloaded: bytes.byteLength, path: destPath, declaredSize });
    this.#emitir({ topic: 'blob.completed', data: { blobsCoreKey: chaveHex, blobIdHex, path: destPath }, ...rota });
    return { path: destPath };
  }

  /** Prazo de §14.5 aplicado à espera da faixa — sem ele, par ausente é espera eterna. */
  #comPrazo<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('E_REPLICATION_STALL')), this.#timeoutMs);
      timer.unref?.();
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e: unknown) => {
          clearTimeout(timer);
          reject(e instanceof Error ? e : new Error(String(e)));
        },
      );
    });
  }

  /** Fecha os cores de blobs que este manager abreu/registrou e sai dos tópicos dele. */
  async close(): Promise<void> {
    for (const [keyHex, registro] of [...this.#cores]) {
      this.#cores.delete(keyHex);
      if (registro.announce) this.swarm.leave(registro.topicHex);
      await registro.port.close().catch(() => {});
    }
    this.#locais.clear();
    this.#escoposDm.clear();
    this.#muxes.clear();
    // Espera o que já saiu do registro mas ainda não fechou. O laço repete porque um detach
    // pode entrar enquanto se espera o anterior; `close()` só devolve com o disco liberado.
    while (this.#fechamentos.size > 0) {
      await Promise.all([...this.#fechamentos]);
    }
  }

  /**
   * `blob.cancel` — e ele **cancela** desde 2026-09-05.
   *
   * Antes gravava `state = 'cancelled'` no manifest e mais nada: nenhum ponto do motor lia
   * esse estado, o download seguia consumindo banda até o fim, gravava o arquivo e emitia
   * `blob.completed` por cima do "cancelado" que a tela já mostrava. O cancelamento agora é
   * uma marca em memória que os pontos de retomada do `#baixarFaixa` consultam, e é ela que
   * impede os desfechos posteriores de sobrescrever o estado.
   */
  cancelDownload(blobsCoreKey: Buffer | string, blobIdHex: string): void {
    const key = typeof blobsCoreKey === 'string' ? Buffer.from(blobsCoreKey, 'hex') : blobsCoreKey;
    this.#cancelados.add(`${key.toString('hex')}/${blobIdHex}`);
    this.cache.setState(key, blobIdHex, 'cancelled');
  }

  /** O download deste blob foi cancelado enquanto estava em voo? */
  #cancelado(chaveHex: string, blobIdHex: string): boolean {
    return this.#cancelados.has(`${chaveHex}/${blobIdHex}`);
  }

  getDownloadState(blobsCoreKey: Buffer | string, blobIdHex: string): BlobCacheState | null {
    const key = typeof blobsCoreKey === 'string' ? Buffer.from(blobsCoreKey, 'hex') : blobsCoreKey;
    const row = this.cache.get(key, blobIdHex);
    return row?.state ?? null;
  }

  // ── Retomada no boot (§13.5, §13.4) ───────────────────────────────────────

  resumeOnBoot(): { stagingResumed: number; stagingDiscarded: number; downloadsResumed: number } {
    const { resumed, discarded } = this.staging.resumeOnBoot();
    const downloadsResumed = this.cache.resumeOnBoot();
    return { stagingResumed: resumed.length, stagingDiscarded: discarded.length, downloadsResumed };
  }

  // ── GC (§22.4, §13.8) ─────────────────────────────────────────────────────

  gcStaging(opts: { hasReference: (row: StagingRow) => boolean; clearBlobs: (row: StagingRow) => void; now?: number }): { removed: number; cleared: number } {
    return this.staging.gcOrphan({ hasReference: opts.hasReference, clearBlobs: opts.clearBlobs, now: opts.now ?? this.#clock() });
  }

  gcCache(opts: { isProtected: (row: CacheRow) => boolean; now?: number }): { removed: number; freedBytes: number } {
    return this.cache.gc({ maxBytes: this.#cacheMaxBytes, isProtected: opts.isProtected, now: opts.now ?? this.#clock() });
  }

  /**
   * §22.4 — fecha os **leitores esparsos de cores alheios** que perderam referência. Um
   * `blob.download` abre o core do autor e o registra para replicar em todo mux vivo; sem
   * coleta, uma sessão longa acumula um core aberto por autor de quem já se baixou algo,
   * cada um com canal em cada conexão. Nunca fecha: o core LOCAL (é dele que se serve a
   * comunidade, §13.7 regra 2) nem leitor com download em voo.
   *
   * Fechar o core exige **esquecer a marcação de replicação** por mux: se o mesmo core for
   * reaberto depois, ele precisa entrar de novo em cada mux — `attachTo` não é idempotente,
   * mas também não sobrevive ao `close` (lição de §45, o outro lado dela).
   */
  async gcReaders(): Promise<{ closed: number }> {
    let closed = 0;
    for (const [keyHex, registro] of [...this.#cores]) {
      if (registro.announce) continue; // core local: quem serve não coleta
      if (this.#emUso.has(keyHex)) continue; // download em voo
      this.#cores.delete(keyHex);
      for (const entrada of this.#muxes.values()) entrada.done.delete(keyHex);
      // O tópico foi entrado como cliente no `download`; sem leitor, não há o que procurar.
      if (this.swarm.isJoined(registro.topicHex)) this.swarm.leave(registro.topicHex);
      await registro.port.close().catch(() => {});
      closed += 1;
    }
    return { closed };
  }

  /** Quantos cores de blobs alheios estão abertos agora — o que o GC de §22.4 observa. */
  openReaderCount(): number {
    let n = 0;
    for (const registro of this.#cores.values()) if (!registro.announce) n += 1;
    return n;
  }

  // ── Reveal / abertura (§13.6) ─────────────────────────────────────────────

  canReveal(blobsCoreKey: Buffer | string, blobIdHex: string): { allowed: boolean; reason?: string } {
    const key = typeof blobsCoreKey === 'string' ? Buffer.from(blobsCoreKey, 'hex') : blobsCoreKey;
    const row = this.cache.get(key, blobIdHex);
    if (row === null || row.state !== 'downloaded' || row.path === null) return { allowed: false, reason: 'E_NOT_DOWNLOADED' };
    const ext = extOf(row.path);
    const kind = kindFromExtension(ext);
    if (isExecutableExtension(ext)) return { allowed: false, reason: 'E_TYPE_NOT_OPENABLE' };
    if (!isRevealAllowed(kind, ext)) return { allowed: false, reason: 'E_TYPE_NOT_OPENABLE' };
    return { allowed: true };
  }

  // ── Helper de cache local (§13.8, `BLOB_CACHE_MAX_BYTES`) ─────────────────

  static exceedsCache(maxBytes: number, currentBytes: number, newBytes: number): boolean {
    return currentBytes + newBytes > maxBytes;
  }
}


