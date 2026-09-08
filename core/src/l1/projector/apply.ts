// Tradução de `Effect` → SQL — §8.4.
//
// O `fold` emite `Effect[]`; o `projector` aplica a lista **na ordem**, dentro de **uma
// transação por lote**, e emite os `notify` **depois do commit** (§10.5, §10.7). O projector
// **não decide nada** — este arquivo é a tradução mecânica de cada forma fechada do tipo,
// e mais nada.
//
// §8.4: cada forma em lote vira **um** `UPDATE ... WHERE` sobre índice existente; o `fold`
// não enumera as linhas. A FTS5 não usa triggers (§10.3): `ftsIndex`/`ftsRemove` são
// aplicados na **mesma transação** do `upsert`/`patch` da mensagem, sempre depois dele —
// exatamente a ordem em que o `fold` os emite.

import type { ViewStatement, ViewDb } from '../../l0/view/index.ts';
import { KEY_COLS } from '../../l0/view/index.ts';
import type {
  CsTable,
  Effect,
  EffectScope,
  EntityKey,
  Primitive,
} from '../../l1/fold/index.ts';

export type StmtCache = Map<string, ViewStatement>;

function prep(view: ViewDb, cache: StmtCache, sql: string): ViewStatement {
  let s = cache.get(sql);
  if (s === undefined) {
    s = view.prepare(sql);
    cache.set(sql, s);
  }
  return s;
}

/** `INSERT ... ON CONFLICT` com os campos da linha — preserva `rowid`, que a FTS5 usa. */
function applyUpsert(view: ViewDb, cache: StmtCache, communityId: string, eff: Effect & { t: 'upsert' }): void {
  const cols = Object.keys(eff.row);
  if (cols.length === 0) return;
  const pk = KEY_COLS[eff.table].filter((c) => eff.row[c] !== undefined);
  const updatables = cols.filter((c) => !pk.includes(c));
  const sql =
    `INSERT INTO ${eff.table} (community_id, ${cols.join(', ')}) VALUES (${new Array<string>(cols.length + 1).fill('?').join(', ')}) ` +
    `ON CONFLICT(community_id, ${pk.join(', ')}) DO ` +
    (updatables.length > 0
      ? `UPDATE SET ${updatables.map((c) => `${c} = excluded.${c}`).join(', ')}`
      : 'NOTHING');
  prep(view, cache, sql).run(communityId, ...cols.map((c) => eff.row[c]));
}

function whereClause(table: CsTable, key: EntityKey): { cols: string[]; vals: Primitive[] } {
  const cols = KEY_COLS[table].slice(0, key.length);
  return { cols, vals: [...key] };
}

function applyPatch(view: ViewDb, cache: StmtCache, communityId: string, eff: Effect & { t: 'patch' }): void {
  const set = Object.keys(eff.fields);
  if (set.length === 0) return;
  const { cols, vals } = whereClause(eff.table, eff.key);
  const sql =
    `UPDATE ${eff.table} SET ${set.map((c) => `${c}=?`).join(',')} ` +
    `WHERE community_id=?${cols.map((c) => ` AND ${c}=?`).join('')}`;
  prep(view, cache, sql).run(...set.map((c) => eff.fields[c]), communityId, ...vals);
}

/** §8.4 — um `UPDATE ... WHERE` por forma em lote, sobre índice existente. */
function applyPatchScope(view: ViewDb, cache: StmtCache, communityId: string, eff: Effect & { t: 'patchScope' }): void {
  const set = Object.keys(eff.fields);
  if (set.length === 0) return;
  const assign = set.map((c) => `${c}=?`).join(',');
  const vals = set.map((c) => eff.fields[c]);
  if (eff.scope.s === 'messagesOfAuthor') {
    prep(view, cache, `UPDATE messages SET ${assign} WHERE community_id=? AND author_key=?`).run(
      ...vals,
      communityId,
      eff.scope.authorKey,
    );
  } else {
    prep(view, cache, `UPDATE messages SET ${assign} WHERE community_id=? AND channel_id=?`).run(
      ...vals,
      communityId,
      eff.scope.channelId,
    );
  }
}

function applyDelete(view: ViewDb, cache: StmtCache, communityId: string, eff: Effect & { t: 'delete' }): void {
  const { cols, vals } = whereClause(eff.table, eff.key);
  const sql = `DELETE FROM ${eff.table} WHERE community_id=?${cols.map((c) => ` AND ${c}=?`).join('')}`;
  prep(view, cache, sql).run(communityId, ...vals);
}

/** §10.3 — `rowid = messages.rowid`; o `upsert` da mensagem já rodou (ordem do `fold`). */
function applyFtsIndex(view: ViewDb, cache: StmtCache, communityId: string, eff: Effect & { t: 'ftsIndex' }): void {
  prep(
    view,
    cache,
    'INSERT INTO messages_fts(rowid, content) SELECT rowid, ? FROM messages WHERE community_id=? AND id=? AND orphaned=0 AND hidden_by_ban=0 AND deleted_at IS NULL',
  ).run(eff.content, communityId, eff.messageId);
}

/**
 * §10.3 — a tabela é FTS5 **contentless-delete** (`content=''` **com `contentless_delete=1`**),
 * e nessa forma `DELETE FROM` é a remoção suportada: ela subtrai os termos do índice e é
 * idempotente — apagar um `rowid` que já saiu é no-op, não `SQLITE_CORRUPT_VTAB`.
 *
 * A forma anterior era `INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete',
 * rowid, NULL)`. Num contentless **simples** (`content=''` sozinho) esse comando exige os
 * **valores originais da coluna** para subtrair os termos: com `NULL` ele tirava o `rowid` da
 * lista de documentos e **deixava todos os termos no índice**. Medido: depois de
 * `message.delete`, `messages_fts MATCH 'abacaxi'` continuava casando, com `messages.content`
 * já em `NULL` — o texto da mensagem tombstonada seguia materializado em `view.db`, e a
 * remoção que §18.2 promete reversível nunca acontecia em nenhum dos dois sentidos.
 */
function applyFtsRemove(view: ViewDb, cache: StmtCache, communityId: string, eff: Effect & { t: 'ftsRemove' }): void {
  prep(
    view,
    cache,
    'DELETE FROM messages_fts WHERE rowid IN (SELECT rowid FROM messages WHERE community_id=? AND id=?)',
  ).run(communityId, eff.messageId);
}

/**
 * §8.4 — a forma inversa. Reindexa o escopo a partir de `messages.content`, que o projector
 * materializou: o `fold` não carrega o texto, e é essa assimetria que fazia um ban revogado
 * devolver as mensagens às listagens e nunca à busca (§18.2).
 *
 * O predicado é o complemento exato das três remoções — tombstone (`content IS NULL`,
 * `deleted_at`), canal apagado (`orphaned`) e ban (`hidden_by_ban`) —, então reindexar não
 * pode ressuscitar o que outra regra tirou. A guarda de pertença invertida
 * (`NOT IN messages_fts`) é o espelho da guarda da remoção: sem ela, um escopo reindexado
 * duas vezes duplicaria linhas no índice.
 */
function applyFtsIndexScope(view: ViewDb, cache: StmtCache, communityId: string, eff: Effect & { t: 'ftsIndexScope' }): void {
  const coluna = eff.scope.s === 'messagesOfAuthor' ? 'author_key' : 'channel_id';
  const v = eff.scope.s === 'messagesOfAuthor' ? eff.scope.authorKey : eff.scope.channelId;
  prep(
    view,
    cache,
    `INSERT INTO messages_fts(rowid, content) SELECT rowid, content FROM messages ` +
      `WHERE community_id=? AND ${coluna}=? AND content IS NOT NULL AND deleted_at IS NULL ` +
      `AND orphaned=0 AND hidden_by_ban=0 AND rowid NOT IN (SELECT rowid FROM messages_fts)`,
  ).run(communityId, v);
}

/** A forma em lote da remoção acima — mesmo `DELETE`, um comando por escopo (§8.4). */
function applyFtsRemoveScope(view: ViewDb, cache: StmtCache, communityId: string, eff: Effect & { t: 'ftsRemoveScope' }): void {
  const scopeSql: Record<EffectScope['s'], string> = {
    messagesOfAuthor: 'SELECT rowid FROM messages WHERE community_id=? AND author_key=?',
    messagesOfChannel: 'SELECT rowid FROM messages WHERE community_id=? AND channel_id=?',
  };
  const v = eff.scope.s === 'messagesOfAuthor' ? eff.scope.authorKey : eff.scope.channelId;
  prep(view, cache, `DELETE FROM messages_fts WHERE rowid IN (${scopeSql[eff.scope.s]})`).run(
    communityId,
    v,
  );
}

/** §10.3, `moderation_log` — o `ModerationEntry` de §6.13 chega pronto do `fold`. */
function applyAudit(view: ViewDb, cache: StmtCache, communityId: string, eff: Effect & { t: 'audit' }): void {
  const e = eff.entry;
  prep(
    view,
    cache,
    'INSERT INTO moderation_log(community_id, id, seq, type, target_id, target_label, by_key, by_label, reason, at) VALUES (?,?,?,?,?,?,?,?,?,?)',
  ).run(communityId, e.id, e.seq, e.type, e.targetId, e.targetLabel, e.byKey, e.byLabel, e.reason, e.at);
}

/**
 * §10.5 passo 4 — "recalcula os `recount`", com a população de cada um definida em §8.4:
 *
 * - `memberCount` — membros com `left_at IS NULL` **e** `banned = 0`;
 * - `roleMemberCount` — os mesmos, restritos aos que têm o cargo em `member_roles`;
 * - `threadReplyCount` — respostas com `deleted_at IS NULL` **e** `orphaned = 0`.
 *
 * `hidden_by_ban` **não** subtrai: a ocultação por ban é reversível (§18.2) e um contador que
 * oscilasse com ela mostraria a thread perdendo respostas que voltam. As três são derivadas
 * das tabelas de `CS` **dentro da mesma transação do lote**.
 */
function applyRecount(view: ViewDb, cache: StmtCache, communityId: string, eff: Effect & { t: 'recount' }): void {
  const id = String(eff.key[0]);
  if (eff.what === 'memberCount') {
    prep(
      view,
      cache,
      'UPDATE communities SET member_count = (SELECT COUNT(*) FROM members WHERE community_id=? AND left_at IS NULL AND banned=0) WHERE community_id=? AND id=?',
    ).run(communityId, communityId, id);
  } else if (eff.what === 'roleMemberCount') {
    prep(
      view,
      cache,
      'UPDATE roles SET member_count = (SELECT COUNT(*) FROM member_roles mr JOIN members m ON m.community_id=mr.community_id AND m.identity_key=mr.identity_key WHERE mr.community_id=? AND mr.role_id=? AND m.left_at IS NULL AND m.banned=0) WHERE community_id=? AND id=?',
    ).run(communityId, id, communityId, id);
  } else {
    prep(
      view,
      cache,
      // A raiz também carrega `thread_id` (R-24): a contagem de respostas a EXCLUI.
      'UPDATE threads SET reply_count = (SELECT COUNT(*) FROM messages WHERE community_id=? AND thread_id=? AND id != (SELECT root_message_id FROM threads WHERE community_id=? AND id=?) AND deleted_at IS NULL AND orphaned=0) WHERE community_id=? AND id=?',
    ).run(communityId, id, communityId, id, communityId, id);
  }
}

/**
 * As formas de §8.4 que viram SQL — a lista é o que o teste de paridade compara com a union
 * do normativo em tempo de execução. `notify` não vira SQL e é tratado pelo projector antes
 * de chegar aqui.
 */
export const SQL_EFFECT_FORMS = [
  'upsert',
  'patch',
  'delete',
  'patchScope',
  'ftsIndex',
  'ftsRemove',
  'ftsRemoveScope',
  'ftsIndexScope',
  'audit',
  'recount',
] as const;

/**
 * Aplica um `Effect` que vira SQL. `notify` **não** passa por aqui: é coletado pelo
 * projector e emitido como evento IPC **depois** do commit (§10.5, §10.7). O caso existe
 * só para o tipo fechado continuar exaustivo.
 */
export function applyEffect(view: ViewDb, cache: StmtCache, communityId: string, eff: Effect): void {
  switch (eff.t) {
    case 'upsert':
      applyUpsert(view, cache, communityId, eff);
      return;
    case 'patch':
      applyPatch(view, cache, communityId, eff);
      return;
    case 'delete':
      applyDelete(view, cache, communityId, eff);
      return;
    case 'patchScope':
      applyPatchScope(view, cache, communityId, eff);
      return;
    case 'ftsIndex':
      applyFtsIndex(view, cache, communityId, eff);
      return;
    case 'ftsRemove':
      applyFtsRemove(view, cache, communityId, eff);
      return;
    case 'ftsRemoveScope':
      applyFtsRemoveScope(view, cache, communityId, eff);
      return;
    case 'ftsIndexScope':
      applyFtsIndexScope(view, cache, communityId, eff);
      return;
    case 'audit':
      applyAudit(view, cache, communityId, eff);
      return;
    case 'recount':
      applyRecount(view, cache, communityId, eff);
      return;
    case 'notify':
      return;
  }
}

export function newStmtCache(): StmtCache {
  return new Map();
}
