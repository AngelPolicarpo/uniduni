// `search` — serviço de consulta FTS5 sobre o Estado de Conteúdo (§23).
//
// §4: L2, depende só de `view` — consulta pura sobre `CS`; nada de rede ("Consultar a rede"
// é exatamente o que ele não pode fazer). O índice `messages_fts` não é mantido aqui: o
// `projector` emite `ftsIndex`/`ftsRemove` na transação dos efeitos (§10.3) e a composição
// é quem liga tudo no boot. Este módulo nunca escreve em `view.db` — o `projector` é o
// único escritor (§21.1).
//
// Regras aplicadas, cada uma citada:
//   - pipeline de §23.1 (normalização → tokenização → MATCH DR-39): `./text.ts`;
//   - exclusões de §23.1: deletadas, `hidden_by_ban` e `orphaned` nunca aparecem; canais
//     de voz não são varridos;
//   - canais e membros respondem **só ao texto** — filtro de autor/anexo/data não se aplica;
//   - `scopeChannelId` restringe antes dos filtros;
//   - ordenação de §23.2: resultado de busca por `seq` decrescente (recência);
//   - paginação de §23.3: teto de 20 por grupo, expansão até 100.
//
// `partial`/`partialReason` (fecha RT-11, §14.5): as quatro causas são estado de
// replicação/host conhecido pela composição (`communityClient`, outbox, `partialInterpretation`);
// quem chama decide a causa e passa `partialReason` — o módulo apenas ecoa. Não há causa
// derivável de `view.db` sozinha.

import type { ViewDb } from '../../l0/view/index.ts';

import { buildFtsMatch, normalizeText, tokenize } from './text.ts';

/**
 * Valor de `channels.type` para canal de voz (§6.7 catálogo fechado: text=0, voice=1).
 * Constante repetida localmente porque §4 não declara `fold` como dependência de `search`,
 * e a barreira de camadas bloquearia o import — `channels.type INT` é forma de armazenamento
 * de `view.db`, não interpretação.
 */
const CHANNEL_TYPE_VOICE = 1;

/** Teto de §23.3: 20 por grupo, "ver todos" expande até 100. */
export const SEARCH_DEFAULT_LIMIT_PER_GROUP = 20;
export const SEARCH_MAX_LIMIT_PER_GROUP = 100;

export type SearchDateFilter = 'today' | '7d' | '30d';
export type SearchKindFilter = 'attachment' | 'pinned' | 'link';

export type SearchFilters = {
  readonly authorKey?: Buffer;
  readonly channelId?: string;
  readonly date?: SearchDateFilter;
  readonly kind?: SearchKindFilter;
};

/** As quatro causas de `partial` de §14.5/RT-11 — decididas pela composição. */
export type SearchPartialReason = 'host-offline' | 'catching-up' | 'stalled' | 'partial-interpretation';

export type SearchArgs = {
  readonly communityId: string;
  readonly query: string;
  readonly filters?: SearchFilters;
  /** Escopo "neste canal": restringe **antes** dos filtros (§23.1). */
  readonly scopeChannelId?: string;
  readonly limitPerGroup?: number;
  readonly partialReason?: SearchPartialReason;
};

export type MessageHit = {
  readonly id: string;
  readonly seq: number;
  readonly channelId: string;
  readonly channelName: string;
  readonly authorKeyHex: string;
  readonly content: string;
  /**
   * Trecho com o casamento — derivado de `messages.content` em JS, porque `messages_fts`
   * é contentless por norma (§10.3) e `snippet()` do FTS5 não tem texto de onde ler.
   */
  readonly snippet: string;
  readonly authorTs: number;
  readonly hostTs: number;
  readonly clockSkewed: boolean;
  readonly editedAt: number | null;
  readonly pinned: boolean;
  readonly threadId: string | null;
};

export type ChannelHit = {
  readonly id: string;
  readonly name: string;
  /** `channels.type INT` — text=0, voice=1 (§6.7). */
  readonly type: number;
  readonly categoryId: string;
};

export type MemberHit = {
  readonly identityKeyHex: string;
  readonly displayName: string;
  readonly nickname: string | null;
};

export type SearchResult = {
  readonly messages: readonly MessageHit[];
  readonly channels: readonly ChannelHit[];
  readonly members: readonly MemberHit[];
  readonly partial: boolean;
  readonly partialReason?: SearchPartialReason;
};

type Row = Record<string, unknown>;

function str(row: Row, key: string): string {
  return row[key] as string;
}

function num(row: Row, key: string): number {
  return row[key] as number;
}

function nullableNum(row: Row, key: string): number | null {
  const v = row[key];
  return typeof v === 'number' ? v : null;
}

function nullableStr(row: Row, key: string): string | null {
  const v = row[key];
  return typeof v === 'string' ? v : null;
}

/** Início do dia local do leitor (§23.1, `date: today`) sobre o relógio injetado. */
function startOfLocalDay(nowMs: number): number {
  const d = new Date(nowMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function dateCutoff(date: SearchDateFilter, nowMs: number): number {
  if (date === 'today') return startOfLocalDay(nowMs);
  const days = date === '7d' ? 7 : 30;
  return nowMs - days * 24 * 60 * 60 * 1000;
}

/**
 * Trecho com o casamento, derivado em JavaScript: `messages_fts` é contentless por norma
 * (§10.3, `content=''`), então `snippet()` do FTS5 não tem texto de onde ler. O recorte é
 * sobre o conteúdo original (fidelidade de exibição), localizado pela primeira palavra que
 * casa com algum token (palavra contém o token, ou prefixa o último token digitado).
 * Janela fixa com reticências nas bordas cortadas — apresentação fina fica para a UI.
 */
const SNIPPET_BEFORE = 24;
const SNIPPET_AFTER = 56;

function buildSnippet(content: string | null, tokens: readonly string[]): string {
  if (content === null || tokens.length === 0) return '';
  const word = /[\p{L}\p{N}]+/gu;
  let m: RegExpExecArray | null;
  while ((m = word.exec(content)) !== null) {
    const w = normalizeText(m[0]);
    if (!tokens.some((t) => w.includes(t) || t.startsWith(w))) continue;
    const start = Math.max(0, m.index - SNIPPET_BEFORE);
    const end = Math.min(content.length, m.index + m[0].length + SNIPPET_AFTER);
    return (
      (start > 0 ? '…' : '') +
      content.slice(start, end).trim() +
      (end < content.length ? '…' : '')
    );
  }
  return '';
}

const KIND_PREDICATE: Record<SearchKindFilter, string> = {
  attachment: 'EXISTS (SELECT 1 FROM attachments a WHERE a.community_id = m.community_id AND a.message_id = m.id)',
  pinned: 'm.pinned = 1',
  link: 'EXISTS (SELECT 1 FROM message_links l WHERE l.community_id = m.community_id AND l.message_id = m.id)',
};

export type SearchServiceOptions = {
  readonly view: ViewDb;
  /** Única fonte de "agora" — usada só pelo filtro `date` de §23.1. */
  readonly clock?: { now(): number };
};

export class SearchService {
  readonly #view: ViewDb;
  readonly #clock: { now(): number };
  readonly #stmts = new Map<string, ReturnType<ViewDb['prepare']>>();

  constructor(opts: SearchServiceOptions) {
    this.#view = opts.view;
    this.#clock = opts.clock ?? { now: () => Date.now() };
  }

  #prepare(sql: string): ReturnType<ViewDb['prepare']> {
    let stmt = this.#stmts.get(sql);
    if (stmt === undefined) {
      stmt = this.#view.prepare(sql);
      this.#stmts.set(sql, stmt);
    }
    return stmt;
  }

  /**
   * `query.search` (§15.6/§23.1). Síncrono por contrato de `view.db` (SQLite local,
   * melhor-sqlite3): nenhuma rede, nenhum event loop externo bloqueado além da consulta
   * indexada, sempre LIMITada pelos tetos de §23.3.
   */
  search(args: SearchArgs): SearchResult {
    const partial =
      args.partialReason !== undefined
        ? { partial: true, partialReason: args.partialReason }
        : { partial: false };

    const filters = args.filters ?? {};
    const tokens = tokenize(args.query);
    const hasText = tokens.length > 0;
    const hasFilters =
      filters.authorKey !== undefined ||
      filters.channelId !== undefined ||
      filters.date !== undefined ||
      filters.kind !== undefined;

    // Nada para buscar: sem texto e sem filtro, os três grupos voltam vazios.
    if (!hasText && !hasFilters) {
      return { messages: [], channels: [], members: [], ...partial };
    }

    const limit = clampLimit(args.limitPerGroup);

    return {
      messages: hasText || hasFilters ? this.#searchMessages(args, filters, tokens, limit) : [],
      // Canais e membros respondem só ao texto (§23.1) — mesmo com filtros presentes.
      channels: hasText ? this.#searchChannels(args.communityId, args.query, limit) : [],
      members: hasText ? this.#searchMembers(args.communityId, args.query, limit) : [],
      ...partial,
    };
  }

  #searchMessages(
    args: SearchArgs,
    filters: SearchFilters,
    tokens: readonly string[],
    limit: number,
  ): readonly MessageHit[] {
    // Sem texto, a busca é só por filtros — o MATCH é omitido inteiro.
    const match = buildFtsMatch(tokens);

    const where: string[] = [
      'm.community_id = ?',
      // Exclusões de §23.1 — nunca aparecem, em nenhuma combinação de filtros.
      'm.deleted_at IS NULL',
      'm.hidden_by_ban = 0',
      'm.orphaned = 0',
      // Canais de voz não são varridos (§23.1); canal deletado não empresta nome.
      'c.type <> ?',
      'c.deleted_at IS NULL',
    ];
    const params: unknown[] = [args.communityId, CHANNEL_TYPE_VOICE];

    if (match !== null) {
      where.push('messages_fts MATCH ?');
      params.push(match);
    }
    // `scopeChannelId` restringe antes dos filtros (§23.1) — declarado primeiro no WHERE.
    if (args.scopeChannelId !== undefined) {
      where.push('m.channel_id = ?');
      params.push(args.scopeChannelId);
    }
    if (filters.channelId !== undefined) {
      where.push('m.channel_id = ?');
      params.push(filters.channelId);
    }
    if (filters.authorKey !== undefined) {
      where.push('m.author_key = ?');
      params.push(filters.authorKey);
    }
    if (filters.date !== undefined) {
      where.push('m.host_ts >= ?');
      params.push(dateCutoff(filters.date, this.#clock.now()));
    }
    if (filters.kind !== undefined) {
      where.push(KIND_PREDICATE[filters.kind]);
    }

    const sql =
      'SELECT m.id AS id, m.seq AS seq, m.channel_id AS channel_id,' +
      ' c.name AS channel_name, m.author_key AS author_key, m.content AS content,' +
      ' m.author_ts AS author_ts, m.host_ts AS host_ts, m.clock_skewed AS clock_skewed,' +
      ' m.edited_at AS edited_at, m.pinned AS pinned, m.thread_id AS thread_id' +
      (match !== null
        ? ' FROM messages_fts' +
          ' JOIN messages m ON m.rowid = messages_fts.rowid' +
          ' JOIN channels c ON c.community_id = m.community_id AND c.id = m.channel_id'
        : ' FROM messages m' +
          ' JOIN channels c ON c.community_id = m.community_id AND c.id = m.channel_id') +
      ` WHERE ${where.join(' AND ')}` +
      // Ordenação de §23.2: recência, não relevância.
      ' ORDER BY m.seq DESC LIMIT ?';
    params.push(limit);

    return (this.#prepare(sql).all(...params) as Row[]).map((row) => ({
      id: str(row, 'id'),
      seq: num(row, 'seq'),
      channelId: str(row, 'channel_id'),
      channelName: str(row, 'channel_name'),
      authorKeyHex: (row['author_key'] as Buffer).toString('hex'),
      content: str(row, 'content') ?? '',
      snippet: buildSnippet(nullableStr(row, 'content'), tokens),
      authorTs: num(row, 'author_ts'),
      hostTs: num(row, 'host_ts'),
      clockSkewed: num(row, 'clock_skewed') !== 0,
      editedAt: nullableNum(row, 'edited_at'),
      pinned: num(row, 'pinned') !== 0,
      threadId: nullableStr(row, 'thread_id'),
    }));
  }

  #searchChannels(communityId: string, query: string, limit: number): readonly ChannelHit[] {
    // Canais respondem só ao texto (§23.1): substring sobre a MESMA normalização da etapa 1.
    const needle = normalizeText(query.trim());
    if (needle === '') return [];
    const sql =
      'SELECT id, name, type, category_id FROM channels' +
      ' WHERE community_id = ? AND deleted_at IS NULL ORDER BY rank';
    const rows = this.#prepare(sql).all(communityId) as Row[];
    const hits: ChannelHit[] = [];
    for (const row of rows) {
      if (!normalizeText(str(row, 'name')).includes(needle)) continue;
      hits.push({
        id: str(row, 'id'),
        name: str(row, 'name'),
        type: num(row, 'type'),
        categoryId: str(row, 'category_id'),
      });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  #searchMembers(communityId: string, query: string, limit: number): readonly MemberHit[] {
    const needle = normalizeText(query.trim());
    if (needle === '') return [];
    // Roster ativo — o índice `idx_members_active` existe para esta enumeração (§10.3).
    const sql =
      'SELECT identity_key, display_name, nickname FROM members' +
      ' WHERE community_id = ? AND left_at IS NULL AND banned = 0';
    const rows = this.#prepare(sql).all(communityId) as Row[];
    const hits: Array<MemberHit & { sortKey: string }> = [];
    for (const row of rows) {
      const displayName = str(row, 'display_name');
      const nickname = nullableStr(row, 'nickname');
      const label = nickname ?? displayName;
      if (!normalizeText(label).includes(needle)) continue;
      hits.push({
        identityKeyHex: (row['identity_key'] as Buffer).toString('hex'),
        displayName,
        nickname,
        sortKey: normalizeText(label),
      });
    }
    // Alfabético pelo rótulo exibido, comparação por código de código fixa — determinística
    // entre máquinas (sem locale).
    hits.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
    return hits.slice(0, limit).map(({ sortKey: _sortKey, ...hit }) => hit);
  }
}

function clampLimit(limitPerGroup: number | undefined): number {
  if (limitPerGroup === undefined || !Number.isFinite(limitPerGroup) || limitPerGroup < 1) {
    return SEARCH_DEFAULT_LIMIT_PER_GROUP;
  }
  return Math.min(Math.trunc(limitPerGroup), SEARCH_MAX_LIMIT_PER_GROUP);
}
