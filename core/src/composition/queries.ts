// As consultas de leitura de §15.6 sobre a `view.db` — estrutura, mensagens e derivados,
// membros, cargos e moderação.
//
// Raiz de composição (§4): nenhuma regra de domínio nasce aqui. O que estas funções fazem é
// **recortar** o que o `projector` já materializou (§8.4) e juntar três fontes que moram em
// lugares diferentes por desenho:
//
//   - `view.db`   — conteúdo (mensagens, canais, anexos, reações, links, threads) e o estado
//                   de decisão materializado (membros, cargos, bans, timeouts, auditoria);
//   - `DS`        — identidade e cargos de quem aparece (`UserRef`, `readOnly` por cargo) e
//                   os fatos de hierarquia que `query.member` precisa para os campos `can*`;
//   - `manifest`  — o que é **local e não replica**: leitura, mudo, categoria recolhida,
//                   e o estado do cache de blobs (§10.1/§10.2).
//
// Ordenação e paginação seguem §23.2/§23.3 — as duas tabelas são fechadas, e o cursor é
// `base64url({seq,id})`, opaco: forma inválida ou de outro escopo é `E_BAD_CURSOR`, nunca
// resultado errado em silêncio (§15.6.1).
//
// Enforcement de leitura (§15.6.1, DR-25/T-44): `query.auditLog`, `query.bans` e
// `query.timeouts` exigem permissão sobre o DS local e devolvem `E_PERMISSION_DENIED` sem
// ela. É confidencialidade **local** (L-10) — a réplica integral está no disco de quem
// pergunta; o que a fronteira protege é a superfície, não o arquivo.

import type { ManifestDb, OutboxRow } from '../l0/manifest/index.ts';
import type { ViewDb } from '../l0/view/index.ts';
import type { DecisionState } from '../l1/fold/index.ts';
import { hierarchyTargetOf } from '../l1/fold/targets.ts';
import { KINDS, decodeEnvelope, decodeOp, decodePayload, kindName } from '../l1/opCodec/index.ts';
import { PERMISSION_BY_NUMBER, authorizeOverTarget, permissionFromNumber, topRank, type Permission } from '../l1/permissions/index.ts';
import { modoDeRevelacao, type BlobManager, type ModoDeRevelacao } from '../l2/blobs/index.ts';
import type { SearchPartialReason } from '../l2/search/service.ts';
import { memberHasPermission } from '../l2/voiceCoordinator/host.ts';
import { inactiveDaysFrom } from './hostStatus.ts';
import { queryUserRef, type QueryUserRef } from './ports.ts';

// ─── Tetos e recortes de §23.3 (paginação) ──────────────────────────────────────────────

const LIMITE_MENSAGENS = 50;
const LIMITE_LISTAS = 25;
const LIMITE_REATORES = 24;
/** §23.3 — a lista de membros pagina em lotes de 100, offline como contagem agregada. */
const LIMITE_MEMBROS = 100;

/** Rótulo de UI para o kind na fila (§15.6 `kindLabel`) — apresentação, não protocolo. */
const ROTULO_KIND: Record<string, string> = {
  'message.send': 'Mensagem',
  'message.edit': 'Edição',
  'message.delete': 'Remoção',
  'message.pin': 'Fixação',
  'reaction.set': 'Reação',
  'thread.create': 'Thread',
};
/** Trecho da citação de `replyTo` — o suficiente para reconhecer, nunca a mensagem inteira. */
const EXCERPT_MAX = 140;

/** §15.6.1 — `MessageDto`, com os campos que têm fonte na `view.db`. */
export interface QueryMessageDto {
  readonly id: string;
  readonly seq: number;
  readonly channelId: string;
  readonly author: QueryUserRef;
  readonly content: string | null;
  readonly authorTs: number;
  readonly hostTs: number;
  readonly clockSkewed: boolean;
  readonly editedAt?: number;
  readonly pinned: boolean;
  /**
   * §15.6.1 — a citação sobrevive à remoção do alvo (`excerpt: null`, `deleted: true`).
   * `author` fica **ausente** no único caso em que não há autor a nomear: a mensagem citada
   * não está projetada aqui (réplica que ainda não a viu, ou `view.db` reprojetando).
   */
  readonly replyTo?: { readonly messageId: string; readonly author?: QueryUserRef; readonly excerpt: string | null; readonly deleted: boolean };
  readonly threadId?: string;
  readonly threadReplyCount?: number;
  readonly mentions: { readonly identityKeys: readonly string[]; readonly roleIds: readonly string[]; readonly everyone: boolean };
  readonly mentionsMe: boolean;
  readonly hasAttachment: boolean;
  readonly deleted: boolean;
  readonly hiddenByBan: boolean;
}

export interface QueryReactionDto {
  readonly emoji: string;
  readonly count: number;
  readonly mine: boolean;
}

export interface QueryAttachmentDto {
  readonly blobsCoreKey: string;
  readonly blobId: { readonly byteOffset: number; readonly blockOffset: number; readonly blockLength: number; readonly byteLength: number };
  readonly name: string;
  readonly sizeBytes: number;
  readonly kind: number;
  readonly hash: string;
  readonly state: string;
  readonly progress: number;
  readonly availablePeers: number;
  readonly hostAvailable: boolean;
  readonly localPath?: string;
  /**
   * §13.6 regra 1 (emenda de 2026-09-05, `B74`) — **o que a UI pode oferecer para este
   * arquivo**: `open` = "Abrir" e "Mostrar na pasta"; `folder` = só "Mostrar na pasta";
   * `none` = nenhuma das duas (executável, regra 2).
   *
   * A regra manda esconder a ação que o núcleo recusaria, e a UI não tem como derivá-la
   * sozinha sem confiar no `kind` declarado pelo remetente (o ataque `T-48`) ou sem a
   * terceira cópia da tabela de extensões. Quem decide é quem já decidia; o que mudou é
   * que ele passou a dizer.
   */
  readonly revealMode: ModoDeRevelacao;
}

export type QueryReadDeps = {
  readonly view: ViewDb;
  readonly manifest: ManifestDb;
  stateFor(communityId: string): DecisionState | null;
  selfKeyHex(): string | null;
  /** Relógio da instalação — a derivação de `inactiveDays` precisa do AGORA. */
  now?: () => number;
  replicationOf(communityId: string): { readonly state: string; readonly lag: number };
  /**
   * DR-29/DR-33 — o estado de conexão observado com o host (máquina de §15.6) e o contador
   * de ciclos falhos desde o último contato. Ausente = acompanhamento não anexado (§46).
   */
  hostConnection?(communityId: string): { readonly status: string; readonly attempt: number };
  /**
   * §17.6 — presença efêmera VIVA por chave hex (`offline` nunca aparece: é ausência).
   * Ausente ou sem entrada para alguém = sem fonte, e campo fica ausente (precedente).
   */
  presenceStatuses?(communityId: string): ReadonlyMap<string, string>;
  /**
   * §16.4/§15.6 `query.voiceQueue` (emenda de 2026-08-28) — o instantâneo efêmero da fila
   * de karaokê do canal: no host é o estado vivo, no membro o último `voice.queueChanged`.
   * Ausente = instalação sem mídia anexada, e a resposta é `null` (precedente de
   * `presenceStatuses`).
   */
  voiceQueue?(communityId: string, channelId: string): {
    aberta: boolean;
    itens: ReadonlyArray<{ keyHex: string; queuedAt: number }>;
    turno: { keyHex: string; endsAt: number } | null;
  } | null;
  /** Estado do cache local de cada anexo (§10.1). Ausente = `AttachmentDto` sem estado vivo. */
  readonly blobs?: BlobManager;
  /**
   * Linhas da fila local (§11.2, `local_outbox`) — de UMA comunidade quando recortado, de
   * todas quando sem recorte. É o que `query.outbox` lê; o preview sai do envelope.
   */
  outboxRows?(communityId?: string): OutboxRow[];
  /** Enumeração autoritativa de participação (§10.2 `communities`), na ordem bruta. */
  comunidadesRows?(): Array<Record<string, unknown>>;
};

type Linha = Record<string, unknown>;

function recusar(code: string): never {
  throw Object.assign(new Error(code), { code });
}

// ─── Cursor de §15.6.1 — `base64url({seq,id})`, opaco ───────────────────────────────────

export function encodeCursor(c: { readonly seq: number; readonly id: string }): string {
  return Buffer.from(JSON.stringify({ seq: c.seq, id: c.id }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { readonly seq: number; readonly id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { seq?: unknown; id?: unknown };
    if (typeof parsed.seq !== 'number' || !Number.isInteger(parsed.seq) || typeof parsed.id !== 'string' || parsed.id.length === 0) {
      recusar('E_BAD_CURSOR');
    }
    return { seq: parsed.seq, id: parsed.id };
  } catch (e) {
    if ((e as { code?: string }).code === 'E_BAD_CURSOR') throw e;
    return recusar('E_BAD_CURSOR');
  }
}

function limite(pedido: unknown, padrao: number): number {
  if (pedido === undefined) return padrao;
  if (typeof pedido !== 'number' || !Number.isInteger(pedido) || pedido < 1) recusar('E_VALIDATION');
  return Math.min(pedido, padrao);
}

// ─── Fábrica ────────────────────────────────────────────────────────────────────────────

export function queryReadPorts(deps: QueryReadDeps) {
  const { view, manifest } = deps;

  function ds(communityId: string): DecisionState {
    const estado = deps.stateFor(communityId);
    if (estado === null || !estado.community.exists) recusar('E_NOT_FOUND');
    return estado;
  }

  function ref(estado: DecisionState, keyHex: string): QueryUserRef {
    const m = estado.members.get(keyHex);
    const base = queryUserRef(keyHex, m);
    return m?.nickname === undefined ? base : { ...base, nickname: m.nickname };
  }

  /** Cargos ativos de quem pergunta — decide `readOnly` do canal e `mentionsMe` por cargo. */
  function meusCargos(estado: DecisionState): ReadonlySet<string> {
    const eu = deps.selfKeyHex();
    const m = eu === null ? undefined : estado.members.get(eu);
    return m === undefined ? new Set<string>() : new Set(m.roleIds);
  }

  function parseMentions(raw: unknown): { identityKeys: string[]; roleIds: string[]; everyone: boolean } {
    const out = { identityKeys: [] as string[], roleIds: [] as string[], everyone: false };
    if (typeof raw !== 'string') return out;
    let lista: unknown;
    try {
      lista = JSON.parse(raw);
    } catch {
      return out;
    }
    if (!Array.isArray(lista)) return out;
    for (const item of lista) {
      if (typeof item !== 'string') continue;
      // A forma decide o destino: `everyone` é o sentinela de R-13; chave é hex de 32 B; o
      // resto é id de cargo (§7.3). Quem valida o alvo é o `fold`, não a leitura.
      if (item === 'everyone') out.everyone = true;
      else if (/^[0-9a-f]{64}$/i.test(item)) out.identityKeys.push(item.toLowerCase());
      else out.roleIds.push(item);
    }
    return out;
  }

  function excerto(content: string | null): string | null {
    if (content === null) return null;
    return content.length <= EXCERPT_MAX ? content : `${content.slice(0, EXCERPT_MAX)}…`;
  }

  function threadReplyCount(communityId: string, threadId: string): number | undefined {
    const row = view.prepare('SELECT reply_count AS replyCount FROM threads WHERE community_id = ? AND id = ?').get(communityId, threadId) as
      | { replyCount: number }
      | undefined;
    return row?.replyCount;
  }

  function temAnexo(communityId: string, messageId: string): boolean {
    return view.prepare('SELECT 1 FROM attachments WHERE community_id = ? AND message_id = ?').get(communityId, messageId) !== undefined;
  }

  function dto(communityId: string, estado: DecisionState, row: Linha, cargos: ReadonlySet<string>): QueryMessageDto {
    const eu = deps.selfKeyHex();
    const mentions = parseMentions(row['mentions']);
    const everyoneEfetivo = Number(row['mentionEveryoneEffective'] ?? 0) === 1;
    const id = String(row['id']);
    const threadId = row['threadId'] === null || row['threadId'] === undefined ? undefined : String(row['threadId']);
    const replyToId = row['replyToId'] === null || row['replyToId'] === undefined ? undefined : String(row['replyToId']);

    let replyTo: QueryMessageDto['replyTo'];
    if (replyToId !== undefined) {
      const alvo = view
        .prepare('SELECT id, author_key AS authorKey, content, deleted_at AS deletedAt FROM messages WHERE community_id = ? AND id = ?')
        .get(communityId, replyToId) as { id: string; authorKey: Uint8Array; content: string | null; deletedAt: number | null } | undefined;
      // F-47/M-7 — a citação de mensagem removida continua existindo, com `excerpt: null`.
      replyTo =
        alvo === undefined
          ? { messageId: replyToId, excerpt: null, deleted: false }
          : {
              messageId: alvo.id,
              author: ref(estado, Buffer.from(alvo.authorKey).toString('hex')),
              excerpt: alvo.deletedAt === null ? excerto(alvo.content) : null,
              deleted: alvo.deletedAt !== null,
            };
    }

    const contagem = threadId === undefined ? undefined : threadReplyCount(communityId, threadId);
    return {
      id,
      seq: Number(row['seq']),
      channelId: String(row['channelId']),
      author: ref(estado, Buffer.from(row['authorKey'] as Uint8Array).toString('hex')),
      content: (row['content'] as string | null) ?? null,
      authorTs: Number(row['authorTs']),
      hostTs: Number(row['hostTs']),
      clockSkewed: Number(row['clockSkewed'] ?? 0) === 1,
      ...(row['editedAt'] === null || row['editedAt'] === undefined ? {} : { editedAt: Number(row['editedAt']) }),
      pinned: Number(row['pinned'] ?? 0) === 1,
      ...(replyTo !== undefined ? { replyTo } : {}),
      ...(threadId !== undefined ? { threadId } : {}),
      ...(contagem !== undefined ? { threadReplyCount: contagem } : {}),
      mentions: { identityKeys: mentions.identityKeys, roleIds: mentions.roleIds, everyone: mentions.everyone },
      // R-13: `everyone` só me menciona quando foi **efetivo** no registro. Cargo mencionado
      // conta pelos cargos que tenho AGORA — o DS é a fonte, como em toda permissão.
      mentionsMe:
        (eu !== null && mentions.identityKeys.includes(eu)) ||
        (mentions.everyone && everyoneEfetivo) ||
        mentions.roleIds.some((r) => cargos.has(r)),
      hasAttachment: temAnexo(communityId, id),
      deleted: row['deletedAt'] !== null && row['deletedAt'] !== undefined,
      hiddenByBan: Number(row['hiddenByBan'] ?? 0) === 1,
    };
  }

  const COLUNAS =
    'id, seq, channel_id AS channelId, author_key AS authorKey, content, author_ts AS authorTs, host_ts AS hostTs, ' +
    'clock_skewed AS clockSkewed, edited_at AS editedAt, pinned, reply_to_id AS replyToId, thread_id AS threadId, ' +
    'mentions, mention_everyone_effective AS mentionEveryoneEffective, deleted_at AS deletedAt, hidden_by_ban AS hiddenByBan';

  function anexoDe(communityId: string, messageId: string): QueryAttachmentDto | null {
    const row = view
      .prepare(
        'SELECT blobs_core_key AS blobsCoreKey, blob_id AS blobIdJson, name, size_bytes AS sizeBytes, kind, hash ' +
          'FROM attachments WHERE community_id = ? AND message_id = ?',
      )
      .get(communityId, messageId) as
      | { blobsCoreKey: Uint8Array; blobIdJson: string; name: string; sizeBytes: number; kind: number; hash: Uint8Array }
      | undefined;
    if (row === undefined) return null;
    const chaveHex = Buffer.from(row.blobsCoreKey).toString('hex');
    const hashHex = Buffer.from(row.hash).toString('hex');
    const cache = deps.blobs?.cache.get(Buffer.from(row.blobsCoreKey), hashHex.slice(0, 32)) ?? null;
    const baixados = cache?.bytesDownloaded ?? 0;
    return {
      blobsCoreKey: chaveHex,
      blobId: JSON.parse(row.blobIdJson) as QueryAttachmentDto['blobId'],
      name: row.name,
      sizeBytes: row.sizeBytes,
      kind: row.kind,
      hash: hashHex,
      state: cache?.state ?? 'not-downloaded',
      progress: row.sizeBytes > 0 ? Math.min(1, baixados / row.sizeBytes) : 0,
      // §13.4 passo 4 — pares e `hostAvailable` são leitura do bitfield **vivo**: fora de um
      // download em curso não há par conectado a este core, e é isso que 0/false dizem.
      availablePeers: 0,
      hostAvailable: false,
      // §13.6 — pela extensão REAL, e pelo nome do log: o arquivo local é gravado com a
      // extensão preservada (regra 2), então a resposta é a mesma antes e depois do
      // download — e a UI acerta os botões desde o primeiro render.
      revealMode: modoDeRevelacao(row.name),
      ...(cache?.path != null ? { localPath: cache.path } : {}),
    };
  }

  return {
    /**
     * `query.structure` (§15.6): categorias e canais na ordem de §23.2 (`rank` crescente nos
     * dois níveis), com o que é local por cima — mudo, recolhida e não lidas.
     *
     * `readOnly` é **para quem pergunta**: o canal é somente-leitura quando algum cargo meu
     * está em `read_only_role_ids` (§6.7). `voice` fica ausente enquanto a ocupação não tiver
     * produtor nesta instalação (§15.6 `RT-05`).
     */
    structure(communityId: string) {
      const estado = ds(communityId);
      const cargos = meusCargos(estado);
      const recolhidas = manifest.collapsedCategories(communityId);
      const categorias = view
        .prepare('SELECT id, name, rank FROM categories WHERE community_id = ? AND deleted_at IS NULL ORDER BY rank ASC')
        .all(communityId) as Array<{ id: string; name: string; rank: string }>;
      const canais = view
        .prepare(
          'SELECT id, category_id AS categoryId, type, name, topic, rank, read_only_role_ids AS readOnlyRoleIds, speech_mode AS speechMode, queue_turn_seconds AS queueTurnSeconds ' +
            'FROM channels WHERE community_id = ? AND deleted_at IS NULL ORDER BY rank ASC',
        )
        .all(communityId) as Array<{ id: string; categoryId: string; type: number; name: string; topic: string | null; rank: string; readOnlyRoleIds: string; speechMode: number | null; queueTurnSeconds: number | null }>;

      const porCategoria = new Map<string, Array<Record<string, unknown>>>();
      for (const c of canais) {
        let somenteLeitura = false;
        try {
          const ids: unknown = JSON.parse(c.readOnlyRoleIds);
          if (Array.isArray(ids)) somenteLeitura = ids.some((r) => typeof r === 'string' && cargos.has(r));
        } catch {
          somenteLeitura = false;
        }
        const leitura = manifest.getReadState(communityId, c.id);
        const lista = porCategoria.get(c.categoryId) ?? [];
        lista.push({
          id: c.id,
          name: c.name,
          type: c.type,
          ...(c.topic !== null ? { topic: c.topic } : {}),
          rank: c.rank,
          readOnly: somenteLeitura,
          // §6.6 (R-29): os defaults de §6.6 valem quando o log não carrega o campo.
          speechMode: c.speechMode ?? 0,
          queueTurnSeconds: c.queueTurnSeconds ?? 300,
          muted: manifest.isChannelMuted(c.id),
          unread: { count: leitura.unreadCount, mentions: leitura.pendingMentions },
          ...(leitura.firstUnreadSeq !== null ? { firstUnreadSeq: leitura.firstUnreadSeq } : {}),
        });
        porCategoria.set(c.categoryId, lista);
      }

      return {
        categories: categorias.map((cat) => ({
          id: cat.id,
          name: cat.name,
          rank: cat.rank,
          collapsed: recolhidas.has(cat.id),
          channels: porCategoria.get(cat.id) ?? [],
        })),
      };
    },

    /**
     * `query.messages` (§15.6): página de um canal, `seq` crescente (§23.2), cursor
     * bidirecional por `(seq, id)` e lote de 50 (§23.3). `before` devolve a página **anterior**
     * já reordenada para leitura — a UI não inverte nada.
     */
    messages(a: { communityId: string; channelId: string; cursor?: string; limit?: number; direction?: string }) {
      const estado = ds(a.communityId);
      const cargos = meusCargos(estado);
      const n = limite(a.limit, LIMITE_MENSAGENS);
      const direcao = a.direction ?? 'before';
      if (direcao !== 'before' && direcao !== 'after') recusar('E_VALIDATION');
      const cursor = a.cursor === undefined ? null : decodeCursor(a.cursor);

      // A comparação é sobre o par `(seq, id)` — dois registros nunca compartilham `seq`, mas
      // o par é o que o cursor promete, e é ele que sobrevive a uma reprojeção.
      const condicao =
        cursor === null ? '' : direcao === 'before' ? 'AND (seq < ? OR (seq = ? AND id < ?)) ' : 'AND (seq > ? OR (seq = ? AND id > ?)) ';
      const ordem = direcao === 'before' ? 'DESC' : 'ASC';
      const params: unknown[] = [a.communityId, a.channelId];
      if (cursor !== null) params.push(cursor.seq, cursor.seq, cursor.id);
      const linhas = view
        .prepare(`SELECT ${COLUNAS} FROM messages WHERE community_id = ? AND channel_id = ? ${condicao}ORDER BY seq ${ordem}, id ${ordem} LIMIT ?`)
        .all(...params, n + 1) as Linha[];

      const hasMore = linhas.length > n;
      const pagina = hasMore ? linhas.slice(0, n) : linhas;
      // §23.2 — mensagens de canal sempre saem em `seq` crescente, independente da direção.
      const ordenada = direcao === 'before' ? [...pagina].reverse() : pagina;
      const borda = direcao === 'before' ? ordenada[0] : ordenada[ordenada.length - 1];
      return {
        messages: ordenada.map((r) => dto(a.communityId, estado, r, cargos)),
        ...(hasMore && borda !== undefined ? { nextCursor: encodeCursor({ seq: Number(borda['seq']), id: String(borda['id']) }) } : {}),
        hasMore,
        // §15.6 — aqui é o ENUM (`ReplicationState`), não o par `{state, lag}` de
        // `query.community`/`query.hostStatus`. O objeto atravessou em 2026-08-23 e a UI
        // indexava uma tabela com ele: tela toda abaixo (achado do smoke de §59).
        replication: deps.replicationOf(a.communityId).state,
      };
    },

    /** `query.message` (§15.6): a mensagem com reações, anexo e a thread que ela enraíza. */
    message(a: { communityId: string; messageId: string }) {
      const estado = ds(a.communityId);
      const cargos = meusCargos(estado);
      const row = view.prepare(`SELECT ${COLUNAS} FROM messages WHERE community_id = ? AND id = ?`).get(a.communityId, a.messageId) as Linha | undefined;
      if (row === undefined) return null;
      const eu = deps.selfKeyHex();
      const reacoes = view
        .prepare(
          'SELECT emoji, COUNT(*) AS total, SUM(CASE WHEN lower(hex(identity_key)) = ? THEN 1 ELSE 0 END) AS minhas ' +
            'FROM reactions WHERE community_id = ? AND message_id = ? GROUP BY emoji ORDER BY total DESC, emoji ASC',
        )
        .all(eu ?? '', a.communityId, a.messageId) as Array<{ emoji: string; total: number; minhas: number }>;
      const anexo = anexoDe(a.communityId, a.messageId);
      const thread = view
        .prepare('SELECT id, root_message_id AS rootMessageId, channel_id AS channelId, reply_count AS replyCount FROM threads WHERE community_id = ? AND root_message_id = ?')
        .get(a.communityId, a.messageId) as { id: string; rootMessageId: string; channelId: string; replyCount: number } | undefined;
      return {
        ...dto(a.communityId, estado, row, cargos),
        reactions: reacoes.map((r): QueryReactionDto => ({ emoji: r.emoji, count: r.total, mine: r.minhas > 0 })),
        ...(anexo !== null ? { attachment: anexo } : {}),
        ...(thread !== undefined ? { thread: { threadId: thread.id, channelId: thread.channelId, replyCount: thread.replyCount } } : {}),
      };
    },

    /** `query.pinned` (§15.6): fixadas do canal, `seq` decrescente (§23.2), lote de 25. */
    pinned(a: { communityId: string; channelId: string; cursor?: string; limit?: number }) {
      const estado = ds(a.communityId);
      const cargos = meusCargos(estado);
      const n = limite(a.limit, LIMITE_LISTAS);
      const cursor = a.cursor === undefined ? null : decodeCursor(a.cursor);
      const params: unknown[] = [a.communityId, a.channelId];
      if (cursor !== null) params.push(cursor.seq, cursor.seq, cursor.id);
      const linhas = view
        .prepare(
          `SELECT ${COLUNAS} FROM messages WHERE community_id = ? AND channel_id = ? AND pinned = 1 ` +
            `${cursor === null ? '' : 'AND (seq < ? OR (seq = ? AND id < ?)) '}ORDER BY seq DESC, id DESC LIMIT ?`,
        )
        .all(...params, n + 1) as Linha[];
      const hasMore = linhas.length > n;
      const pagina = hasMore ? linhas.slice(0, n) : linhas;
      const ultima = pagina[pagina.length - 1];
      return {
        items: pagina.map((r) => dto(a.communityId, estado, r, cargos)),
        ...(hasMore && ultima !== undefined ? { nextCursor: encodeCursor({ seq: Number(ultima['seq']), id: String(ultima['id']) }) } : {}),
        hasMore,
      };
    },

    /** `query.files` (§15.6): anexos do canal, do mais recente para trás (§23.2). */
    files(a: { communityId: string; channelId: string; cursor?: string; limit?: number }) {
      const estado = ds(a.communityId);
      const n = limite(a.limit, LIMITE_LISTAS);
      const cursor = a.cursor === undefined ? null : decodeCursor(a.cursor);
      const params: unknown[] = [a.communityId, a.channelId];
      if (cursor !== null) params.push(cursor.seq, cursor.seq, cursor.id);
      const linhas = view
        .prepare(
          'SELECT m.id, m.seq, m.host_ts AS hostTs, m.author_key AS authorKey FROM messages m ' +
            'JOIN attachments a ON a.community_id = m.community_id AND a.message_id = m.id ' +
            `WHERE m.community_id = ? AND m.channel_id = ? AND m.deleted_at IS NULL ` +
            `${cursor === null ? '' : 'AND (m.seq < ? OR (m.seq = ? AND m.id < ?)) '}ORDER BY m.seq DESC, m.id DESC LIMIT ?`,
        )
        .all(...params, n + 1) as Array<{ id: string; seq: number; hostTs: number; authorKey: Uint8Array }>;
      const hasMore = linhas.length > n;
      const pagina = hasMore ? linhas.slice(0, n) : linhas;
      const ultima = pagina[pagina.length - 1];
      return {
        items: pagina.map((r) => ({
          messageId: r.id,
          at: r.hostTs,
          author: ref(estado, Buffer.from(r.authorKey).toString('hex')),
          attachment: anexoDe(a.communityId, r.id)!,
        })),
        ...(hasMore && ultima !== undefined ? { nextCursor: encodeCursor({ seq: ultima.seq, id: ultima.id }) } : {}),
        hasMore,
      };
    },

    /** `query.links` (§15.6.1): fonte é `message_links`, escrita pelo `fold` (DR-38). */
    links(a: { communityId: string; channelId: string; cursor?: string; limit?: number }) {
      const estado = ds(a.communityId);
      const n = limite(a.limit, LIMITE_LISTAS);
      const cursor = a.cursor === undefined ? null : decodeCursor(a.cursor);
      const params: unknown[] = [a.communityId, a.channelId];
      if (cursor !== null) params.push(cursor.seq, cursor.seq, cursor.id);
      const linhas = view
        .prepare(
          'SELECT l.message_id AS messageId, l.idx, l.url, l.host, l.seq, m.host_ts AS hostTs, m.author_key AS authorKey ' +
            'FROM message_links l JOIN messages m ON m.community_id = l.community_id AND m.id = l.message_id ' +
            `WHERE l.community_id = ? AND m.channel_id = ? AND m.deleted_at IS NULL ` +
            `${cursor === null ? '' : 'AND (l.seq < ? OR (l.seq = ? AND l.message_id < ?)) '}ORDER BY l.seq DESC, l.message_id DESC, l.idx ASC LIMIT ?`,
        )
        .all(...params, n + 1) as Array<{ messageId: string; idx: number; url: string; host: string; seq: number; hostTs: number; authorKey: Uint8Array }>;
      const hasMore = linhas.length > n;
      const pagina = hasMore ? linhas.slice(0, n) : linhas;
      const ultima = pagina[pagina.length - 1];
      return {
        items: pagina.map((r) => ({
          messageId: r.messageId,
          at: r.hostTs,
          author: ref(estado, Buffer.from(r.authorKey).toString('hex')),
          url: r.url,
          host: r.host,
        })),
        ...(hasMore && ultima !== undefined ? { nextCursor: encodeCursor({ seq: ultima.seq, id: ultima.messageId }) } : {}),
        hasMore,
      };
    },

    /** `query.thread` (§15.6, DR-48): raiz + respostas em `seq` crescente, com participantes. */
    thread(a: { communityId: string; threadId: string; cursor?: string; limit?: number }) {
      const estado = ds(a.communityId);
      const cargos = meusCargos(estado);
      const n = limite(a.limit, LIMITE_MENSAGENS);
      const cabeca = view
        .prepare('SELECT root_message_id AS rootMessageId, reply_count AS replyCount FROM threads WHERE community_id = ? AND id = ?')
        .get(a.communityId, a.threadId) as { rootMessageId: string; replyCount: number } | undefined;
      if (cabeca === undefined) return null;
      const raiz = view.prepare(`SELECT ${COLUNAS} FROM messages WHERE community_id = ? AND id = ?`).get(a.communityId, cabeca.rootMessageId) as
        | Linha
        | undefined;
      if (raiz === undefined) return null;
      const cursor = a.cursor === undefined ? null : decodeCursor(a.cursor);      const params: unknown[] = [a.communityId, a.threadId];
      if (cursor !== null) params.push(cursor.seq, cursor.seq, cursor.id);
      // A RAIZ também carrega `thread_id` (R-24, âncora da própria thread) —
      // respostas são todos os OUTROS registros do recorte.
      const respostas = view
        .prepare(
          `SELECT ${COLUNAS} FROM messages WHERE community_id = ? AND thread_id = ? AND id != ? ` +
            `${cursor === null ? '' : 'AND (seq > ? OR (seq = ? AND id > ?)) '}ORDER BY seq ASC, id ASC LIMIT ?`,
        )
        .all(a.communityId, a.threadId, cabeca.rootMessageId, ...(cursor === null ? [] : [cursor.seq, cursor.seq, cursor.id]), n + 1) as Linha[];
      const hasMore = respostas.length > n;
      const pagina = hasMore ? respostas.slice(0, n) : respostas;
      const ultima = pagina[pagina.length - 1];
      const participantes = new Set<string>([Buffer.from(raiz['authorKey'] as Uint8Array).toString('hex')]);
      for (const r of pagina) participantes.add(Buffer.from(r['authorKey'] as Uint8Array).toString('hex'));
      const leitura = manifest.getThreadReadState(a.communityId, a.threadId);
      return {
        root: dto(a.communityId, estado, raiz, cargos),
        replies: pagina.map((r) => dto(a.communityId, estado, r, cargos)),
        ...(hasMore && ultima !== undefined ? { nextCursor: encodeCursor({ seq: Number(ultima['seq']), id: String(ultima['id']) }) } : {}),
        replyCount: cabeca.replyCount,
        participants: [...participantes].map((k) => ref(estado, k)),
        unread: { count: leitura.unreadCount },
      };
    },

    /**
     * `query.thread.unread` (§15.6, emenda de 2026-08-25 — fecha o §2.2(7) da delta-UX):
     * as threads do canal — ou de toda a comunidade, sem `channelId` — com contador vivo
     * acima de zero. É o que o chip da raiz consome sem consultar thread a thread; a
     * contagem é a MESMA linha que `query.thread.unread` lê (`local_thread_read_state`,
     * mantida pelo recálculo de §6.15) e quem zera é o `thread.markRead`. A junção entre
     * `threads` (view.db) e os contadores (manifest.db) é EM MEMÓRIA de propósito:
     * bancos distintos, e o conjunto por canal é pequeno.
     */
    threadUnread(a: { communityId: string; channelId?: string; cursor?: string; limit?: number }) {
      ds(a.communityId);
      const n = limite(a.limit, LIMITE_LISTAS);
      const cursor = a.cursor === undefined ? null : decodeCursor(a.cursor);
      const contadores = new Map(
        deps.manifest.listThreadReadStates(a.communityId).map((r) => [r.threadId, r.unreadCount]),
      );
      const params: unknown[] = [a.communityId];
      let filtroCanal = '';
      if (a.channelId !== undefined) {
        filtroCanal = ' AND t.channel_id = ?';
        params.push(a.channelId);
      }
      if (cursor !== null) {
        filtroCanal += ' AND (m.seq < ? OR (m.seq = ? AND t.id < ?))';
        params.push(cursor.seq, cursor.seq, cursor.id);
      }
      const linhas = view
        .prepare(
          'SELECT t.id AS threadId, t.root_message_id AS rootMessageId, t.channel_id AS channelId, m.seq AS raizSeq ' +
            'FROM threads t JOIN messages m ON m.community_id = t.community_id AND m.id = t.root_message_id ' +
            `WHERE t.community_id = ? AND t.root_deleted = 0${filtroCanal} ORDER BY m.seq DESC, t.id ASC`,
        )
        .all(...params) as Array<{ threadId: string; rootMessageId: string; channelId: string; raizSeq: number }>;
      const pagina: Array<{
        threadId: string;
        rootMessageId: string;
        channelId: string;
        unreadCount: number;
        raizSeq: number;
      }> = [];
      for (const l of linhas) {
        const unreadCount = contadores.get(l.threadId) ?? 0;
        if (unreadCount <= 0) continue;
        pagina.push({ ...l, unreadCount });
        if (pagina.length > n) break;
      }
      const hasMore = pagina.length > n;
      const saida = hasMore ? pagina.slice(0, n) : pagina;
      const ultima = saida[saida.length - 1];
      return {
        items: saida.map(({ threadId, rootMessageId, channelId, unreadCount }) => ({
          threadId,
          rootMessageId,
          channelId,
          unreadCount,
        })),
        ...(hasMore && ultima !== undefined ? { nextCursor: encodeCursor({ seq: ultima.raizSeq, id: ultima.threadId }) } : {}),
        hasMore,
      };
    },

    /** `query.reactors` (§15.6, DR-47): quem reagiu com um emoji, teto de 24. */
    reactors(a: { communityId: string; messageId: string; emoji: string; limit?: number }) {
      const estado = ds(a.communityId);
      const n = limite(a.limit, LIMITE_REATORES);
      const total = (
        view.prepare('SELECT COUNT(*) AS total FROM reactions WHERE community_id = ? AND message_id = ? AND emoji = ?').get(a.communityId, a.messageId, a.emoji) as {
          total: number;
        }
      ).total;
      const linhas = view
        .prepare('SELECT identity_key AS identityKey FROM reactions WHERE community_id = ? AND message_id = ? AND emoji = ? ORDER BY at ASC LIMIT ?')
        .all(a.communityId, a.messageId, a.emoji, n) as Array<{ identityKey: Uint8Array }>;
      return { total, users: linhas.map((r) => ref(estado, Buffer.from(r.identityKey).toString('hex'))) };
    },

    // ── Membros, cargos e moderação (§15.6) ───────────────────────────────────────────

    /**
     * Enforcement de leitura de §15.6.1 (DR-25/T-44): a permissão é conferida sobre o DS
     * local, que é tudo o que a fronteira tem. Quem não tem responde `E_PERMISSION_DENIED`
     * sem ler uma linha — confidencialidade local (L-10), não segredo criptográfico.
     */
    exigir(estado: DecisionState, permissoes: readonly Permission[]): void {
      const eu = deps.selfKeyHex();
      const autorizado = eu !== null && permissoes.some((p) => memberHasPermission(estado, eu, p));
      if (!autorizado) recusar('E_PERMISSION_DENIED');
    },

    /**
     * `query.members` (§15.6): roster ativo agrupado pelo cargo de maior `rank`, alfabético
     * dentro do grupo por `nickname ?? displayName` com desempate por `handle`, grupos em
     * `rank` decrescente — a linha "Membros" de §23.2. Offline é **contagem agregada**
     * (§23.3); `presence` vem da presença efêmera viva (§17.6) e fica AUSENTE para quem
     * está offline por ausência — `offline` nunca é um valor publicado (§6.1).
     *
     * O cursor percorre a ordem plana dos membros: `{seq: 0, id: última chave emitida}`.
     * `total`/`offlineCount` são do roster inteiro, independente do filtro.
     *
     * Cada membro carrega `roleIds` com TODOS os cargos ativos dele (`rank` DESC), e não só o
     * do grupo: §9.2 é união e R-3 exige o cargo base em `member.setRoles`.
     */
    members(a: { communityId: string; filter?: { query?: unknown; roleId?: unknown; onlyOnline?: unknown }; cursor?: string; limit?: number }) {
      const estado = ds(a.communityId);
      const filtro = a.filter ?? {};
      if (typeof filtro !== 'object' || filtro === null) recusar('E_VALIDATION');
      if (filtro.query !== undefined && typeof filtro.query !== 'string') recusar('E_VALIDATION');
      if (filtro.roleId !== undefined && typeof filtro.roleId !== 'string') recusar('E_VALIDATION');
      if (filtro.onlyOnline !== undefined && typeof filtro.onlyOnline !== 'boolean') recusar('E_VALIDATION');
      const n = limite(a.limit, LIMITE_MEMBROS);
      const cursor = a.cursor === undefined ? null : decodeCursor(a.cursor);

      // Cargos ativos e vínculos saem da `view.db` — quem materializou foi o `projector`.
      type Cargo = { id: string; name: string; color: string; rank: string };
      const cargos = new Map<string, Cargo>();
      for (const r of view.prepare('SELECT id, name, color, rank FROM roles WHERE community_id = ? AND deleted_at IS NULL').all(a.communityId) as Array<{
        id: string;
        name: string;
        color: number;
        rank: string;
      }>) {
        cargos.set(r.id, { id: r.id, name: r.name, color: String(r.color), rank: r.rank });
      }
      const vinculos = new Map<string, Set<string>>();
      for (const v of view.prepare('SELECT identity_key AS k, role_id AS roleId FROM member_roles WHERE community_id = ?').all(a.communityId) as Array<{
        k: Uint8Array;
        roleId: string;
      }>) {
        const hex = Buffer.from(v.k).toString('hex');
        const lista = vinculos.get(hex) ?? new Set<string>();
        lista.add(v.roleId);
        vinculos.set(hex, lista);
      }

      /** Grupo do membro = cargo ativo de maior `rank`. */
      function cargoDeMaiorRank(hex: string): Cargo | null {
        let topo: Cargo | null = null;
        for (const roleId of vinculos.get(hex) ?? []) {
          const role = cargos.get(roleId);
          if (role === undefined) continue;
          if (topo === null || role.rank > topo.rank) topo = role;
        }
        return topo;
      }

      /**
       * TODOS os cargos ativos do membro, `rank` DESC (emenda de 2026-09-06).
       * O grupo é UM cargo — o de maior rank —, mas §9.2 define a permissão efetiva como a
       * UNIÃO dos cargos, e R-3 exige o cargo base dentro de `member.setRoles`. Um roster que
       * só entregasse o cargo do grupo obrigava o renderer a esconder ação que o `fold`
       * autoriza e a mandar `setRoles` sem o base — recusado com `E_BASE_ROLE_REQUIRED`.
       */
      function cargosDoMembro(hex: string): string[] {
        return [...(vinculos.get(hex) ?? [])]
          .filter((roleId) => cargos.has(roleId))
          .sort((x, y) => {
            const rx = cargos.get(x)!.rank;
            const ry = cargos.get(y)!.rank;
            return ry < rx ? -1 : ry > rx ? 1 : 0;
          });
      }

      type Entrada = { key: string; joinedAt: number; ref: QueryUserRef; group: Cargo; roleIds: string[] };
      const entradas: Entrada[] = [];
      const ativos = view
        .prepare('SELECT identity_key AS k, joined_at AS joinedAt FROM members WHERE community_id = ? AND left_at IS NULL AND banned = 0')
        .all(a.communityId) as Array<{ k: Uint8Array; joinedAt: number }>;
      const total = ativos.length;

      // §17.6 — presença VIVA por chave: quem tem entrada está sabidamente online; os
      // demais estão offline POR AUSÊNCIA (§6.1 — `offline` nunca é um valor escrito).
      const presencas = deps.presenceStatuses?.(a.communityId);
      let onlineCount = 0;
      for (const linha of ativos) {
        if (presencas?.has(Buffer.from(linha.k).toString('hex')) === true) onlineCount++;
      }

      // `onlyOnline` com produtor de presença filtra DE VERDADE; sem presença ninguém está
      // sabidamente online e o filtro honesto continua respondendo vazio.
      const buscaTexto = filtro.query === undefined ? null : (filtro.query as string).toLowerCase();
      for (const linha of ativos) {
        const hex = Buffer.from(linha.k).toString('hex');
        if (filtro.onlyOnline === true && presencas?.has(hex) !== true) continue;
        const r = ref(estado, hex);
        const rotulo = (r.nickname ?? r.displayName).toLowerCase();
        if (buscaTexto !== null && !rotulo.includes(buscaTexto) && !r.handle.toLowerCase().includes(buscaTexto)) continue;
        const grupo = cargoDeMaiorRank(hex);
        if (grupo === null) continue;
        entradas.push({ key: hex, joinedAt: linha.joinedAt, ref: r, group: grupo, roleIds: cargosDoMembro(hex) });
      }

      // Filtro por cargo: UM grupo só, com os portadores dele — mesmo que o cargo de maior
      // rank de alguém seja outro (a pergunta é "quem tem X", não "quem é encabeçado por X").
      const grupos = new Map<string, Entrada[]>();
      if (typeof filtro.roleId === 'string') {
        const pedida = cargos.get(filtro.roleId);
        if (pedida === undefined) return { groups: [], offlineCount: total, total };
        for (const [hex, ids] of vinculos) {
          if (!ids.has(pedida.id)) continue;
          const achou = entradas.find((e) => e.key === hex);
          if (achou === undefined) continue;
          const lista = grupos.get(pedida.id) ?? [];
          lista.push({ ...achou, group: pedida });
          grupos.set(pedida.id, lista);
        }
      } else {
        for (const e of entradas) {
          const lista = grupos.get(e.group.id) ?? [];
          lista.push(e);
          grupos.set(e.group.id, lista);
        }
      }

      const ordenados = [...grupos.values()]
        .sort((ga, gb) => (gb[0]!.group.rank < ga[0]!.group.rank ? -1 : gb[0]!.group.rank > ga[0]!.group.rank ? 1 : 0))
        .flatMap((lista) =>
          lista.sort((x, y) => {
            const rx = x.ref.nickname ?? x.ref.displayName;
            const ry = y.ref.nickname ?? y.ref.displayName;
            if (rx !== ry) return rx < ry ? -1 : 1;
            return x.ref.handle < y.ref.handle ? -1 : x.ref.handle > y.ref.handle ? 1 : 0;
          }),
        );

      let pagina = ordenados;
      if (cursor !== null) {
        const corte = ordenados.findIndex((x) => x.key === cursor.id);
        pagina = corte < 0 ? [] : ordenados.slice(corte + 1);
      }
      const hasMore = pagina.length > n;
      const lote = hasMore ? pagina.slice(0, n) : pagina;
      const ultima = lote[lote.length - 1];
      const groups = new Map<string, { cargo: Cargo; members: Array<QueryUserRef & { presence?: unknown; joinedAt: number; roleIds: string[] }> }>();
      for (const e of lote) {
        const saco = groups.get(e.group.id) ?? { cargo: e.group, members: [] };
        const presence = presencas?.get(e.key);
        saco.members.push({ ...e.ref, ...(presence !== undefined ? { presence } : {}), joinedAt: e.joinedAt, roleIds: e.roleIds });
        groups.set(e.group.id, saco);
      }
      return {
        groups: [...groups.values()].map(({ cargo, members }) => ({
          roleId: cargo.id,
          roleName: cargo.name,
          roleColor: cargo.color,
          rank: cargo.rank,
          members,
        })),
        // §23.3 — offline é contagem agregada sobre o roster inteiro, agora com fonte.
        offlineCount: total - onlineCount,
        total,
        ...(hasMore && ultima !== undefined ? { nextCursor: encodeCursor({ seq: 0, id: ultima.key }) } : {}),
      };
    },

    /**
     * `query.member` (§15.6): o perfil completo de um membro. Os campos `can*` dizem o que
     * **quem pergunta** pode fazer sobre o alvo — permissão nomeada sobre o DS mais a MESMA
     * resolução de hierarquia do `fold` (`hierarchyTargetOf` + `authorizeOverTarget`),
     * nunca uma segunda implementação de R-4/R-16. Quem decide num comando real continua
     * sendo o `fold`; aqui é só a affordance que a UI mostra antes de tentar.
     */
    member(a: { communityId: string; identityKey: string }) {
      const estado = ds(a.communityId);
      if (!/^[0-9a-f]{64}$/i.test(a.identityKey)) recusar('E_VALIDATION');
      const alvoHex = a.identityKey.toLowerCase();
      const alvo = estado.members.get(alvoHex);
      if (alvo === undefined) recusar('E_NOT_FOUND');

      const lookupAtivo = (id: string) => {
        const r = estado.roles.get(id);
        if (r === undefined || r.deletedAt !== undefined) return undefined;
        return {
          id,
          name: r.name,
          color: String(r.color),
          rank: r.rank,
          permissions: [...r.permissions].map(permissionFromNumber).filter((p): p is Permission => p !== null),
          isFounder: r.isFounder,
          isDefault: r.isDefault,
        };
      };
      const cargosDoAlvo = [...alvo.roleIds].map(lookupAtivo).filter((r): r is NonNullable<typeof r> => r !== undefined);
      cargosDoAlvo.sort((x, y) => (y.rank < x.rank ? -1 : y.rank > x.rank ? 1 : 0));

      const eu = deps.selfKeyHex();
      function podeSobre(kind: number, perm: Permission): boolean {
        if (eu === null || !memberHasPermission(estado, eu, perm)) return false;
        const meus = estado.members.get(eu);
        const meuTop = meus === undefined ? null : topRank([...meus.roleIds], lookupAtivo);
        const alvoCtx = hierarchyTargetOf(kind, { targetKey: Buffer.from(alvoHex, 'hex') }, estado, eu, meuTop);
        // Sem alvo de hierarquia (ex.: atribuir cargo a si mesmo), quem decide é a regra
        // estrutural do `fold` — na affordance isso significa "pode tentar".
        if (!alvoCtx.applies) return true;
        return authorizeOverTarget(alvoCtx.ctx) === null;
      }
      const canKick = podeSobre(KINDS['mod.kick'], 'kick_members');
      const canBan = podeSobre(KINDS['mod.ban'], 'ban_members');
      const canTimeout = podeSobre(KINDS['mod.timeout'], 'timeout_members');
      const canSetRoles = podeSobre(KINDS['member.setRoles'], 'manage_roles');

      const base = ref(estado, alvoHex);
      // §17.6 — presença viva do alvo; ausente = offline por ausência (§6.1).
      const presence = deps.presenceStatuses?.(a.communityId)?.get(alvoHex);
      return {
        key: base.key,
        displayName: base.displayName,
        handle: base.handle,
        avatarColor: base.avatarColor,
        ...(base.nickname !== undefined ? { nickname: base.nickname } : {}),
        collision: base.collision,
        ...(presence !== undefined ? { presence } : {}),
        roleIds: cargosDoAlvo.map((r) => r.id),
        roles: cargosDoAlvo.map((r) => ({ id: r.id, name: r.name, color: r.color, rank: r.rank })),
        joinedAt: alvo.joinedAt,
        banned: alvo.state === 'banned',
        ...(alvo.timeoutUntil !== undefined ? { timeoutUntil: alvo.timeoutUntil } : {}),
        canModerate: canKick || canBan || canTimeout || canSetRoles,
        canKick,
        canBan,
        canTimeout,
        canSetRoles,
        storageUsedBytes: alvo.storageUsedBytes,
      };
    },

    /** `query.roles` (§15.6): cargos ativos em `rank` **decrescente** (§23.2 — topo primeiro). */
    roles(a: { communityId: string }) {
      ds(a.communityId);
      const linhas = view
        .prepare(
          'SELECT id, name, color, rank, permissions, mentionable, is_founder AS isFounder, is_default AS isDefault, member_count AS memberCount ' +
            'FROM roles WHERE community_id = ? AND deleted_at IS NULL ORDER BY rank DESC',
        )
        .all(a.communityId) as Array<{ id: string; name: string; color: number; rank: string; permissions: string; mentionable: number; isFounder: number; isDefault: number; memberCount: number }>;
      return {
        roles: linhas.map((r) => {
          let nomes: string[] = [];
          try {
            const bruto: unknown = JSON.parse(r.permissions);
            if (Array.isArray(bruto)) {
              for (const item of bruto) {
                const p = permissionFromNumber(Number(item));
                if (p !== null) nomes.push(p);
              }
            }
          } catch {
            nomes = [];
          }
          return {
            id: r.id,
            name: r.name,
            color: String(r.color),
            rank: r.rank,
            permissions: nomes,
            mentionable: r.mentionable === 1,
            isFounder: r.isFounder === 1,
            isDefault: r.isDefault === 1,
            memberCount: r.memberCount,
          };
        }),
      };
    },

    /** `query.bans` (§15.6): bans vivos, mais recentes primeiro, lote 25; exige ver auditoria ou banir. */
    bans(a: { communityId: string; cursor?: string; limit?: number }) {
      const estado = ds(a.communityId);
      this.exigir(estado, ['view_audit_log', 'ban_members']);
      const n = limite(a.limit, LIMITE_LISTAS);
      const cursor = a.cursor === undefined ? null : decodeCursor(a.cursor);
      const params: unknown[] = [a.communityId];
      if (cursor !== null) params.push(cursor.seq, cursor.seq, cursor.id);
      const linhas = view
        .prepare(
          'SELECT target_key AS targetKey, by_key AS byKey, at, reason FROM bans WHERE community_id = ? AND revoked_at IS NULL ' +
            `${cursor === null ? '' : 'AND (at < ? OR (at = ? AND lower(hex(target_key)) < ?)) '}ORDER BY at DESC, lower(hex(target_key)) ASC LIMIT ?`,
        )
        .all(...params, n + 1) as Array<{ targetKey: Uint8Array; byKey: Uint8Array; at: number; reason: string | null }>;
      const hasMore = linhas.length > n;
      const pagina = hasMore ? linhas.slice(0, n) : linhas;
      const ultima = pagina[pagina.length - 1];
      return {
        items: pagina.map((r) => ({
          target: ref(estado, Buffer.from(r.targetKey).toString('hex')),
          by: ref(estado, Buffer.from(r.byKey).toString('hex')),
          at: r.at,
          ...(r.reason !== null ? { reason: r.reason } : {}),
        })),
        ...(hasMore && ultima !== undefined ? { nextCursor: encodeCursor({ seq: ultima.at, id: Buffer.from(ultima.targetKey).toString('hex') }) } : {}),
        hasMore,
      };
    },

    /**
     * `query.timeouts` (§15.6): vigentes, mais recentes primeiro; exige `view_audit_log` ou
     * `timeout_members` (emenda de 2026-09-06 — simétrica ao carve-out de `ban_members` em
     * `query.bans`: §9.1 dá `mod.removeTimeout` a `timeout_members`, e sem ler a lista de
     * vigentes não havia como exercer a permissão).
     * `expired` é calculado contra o `hostTs` do último registro interpretado.
     */
    timeouts(a: { communityId: string; cursor?: string; limit?: number }) {
      const estado = ds(a.communityId);
      this.exigir(estado, ['view_audit_log', 'timeout_members']);
      const n = limite(a.limit, LIMITE_LISTAS);
      const cursor = a.cursor === undefined ? null : decodeCursor(a.cursor);
      const params: unknown[] = [a.communityId];
      if (cursor !== null) params.push(cursor.seq, cursor.seq, cursor.id);
      const linhas = view
        .prepare(
          'SELECT target_key AS targetKey, by_key AS byKey, at, until, reason FROM timeouts WHERE community_id = ? ' +
            `${cursor === null ? '' : 'AND (at < ? OR (at = ? AND lower(hex(target_key)) < ?)) '}ORDER BY at DESC, lower(hex(target_key)) ASC LIMIT ?`,
        )
        .all(...params, n + 1) as Array<{ targetKey: Uint8Array; byKey: Uint8Array; at: number; until: number; reason: string | null }>;
      const hasMore = linhas.length > n;
      const pagina = hasMore ? linhas.slice(0, n) : linhas;
      const ultima = pagina[pagina.length - 1];
      return {
        items: pagina.map((r) => ({
          target: ref(estado, Buffer.from(r.targetKey).toString('hex')),
          by: ref(estado, Buffer.from(r.byKey).toString('hex')),
          at: r.at,
          until: r.until,
          expired: r.until <= estado.lastHostTs,
          ...(r.reason !== null ? { reason: r.reason } : {}),
        })),
        ...(hasMore && ultima !== undefined ? { nextCursor: encodeCursor({ seq: ultima.at, id: Buffer.from(ultima.targetKey).toString('hex') }) } : {}),
        hasMore,
      };
    },

    /**
     * `query.auditLog` (§15.6): o `ModerationEntry` de §6.13 já projetado, `seq` decrescente,
     * lote 25, filtros `type`/`byKey`/`from`/`to`. Exige `view_audit_log`. Quando o alvo é
     * pessoa, o hex64 sai como `targetKey`; nos demais casos sai como `targetId` — o log
     * guarda os dois no mesmo `target_id`. `targetLabel` é o rótulo congelado no momento da
     * aplicação (§6.13).
     */
    auditLog(a: { communityId: string; type?: string; byKey?: string; from?: number; to?: number; cursor?: string; limit?: number }) {
      const estado = ds(a.communityId);
      this.exigir(estado, ['view_audit_log']);
      const n = limite(a.limit, LIMITE_LISTAS);
      if (a.byKey !== undefined && !/^[0-9a-f]{64}$/i.test(a.byKey)) recusar('E_VALIDATION');
      const cursor = a.cursor === undefined ? null : decodeCursor(a.cursor);
      const condicoes = ['community_id = ?'];
      const params: unknown[] = [a.communityId];
      if (a.type !== undefined) {
        condicoes.push('type = ?');
        params.push(a.type);
      }
      if (a.byKey !== undefined) {
        condicoes.push('lower(hex(by_key)) = ?');
        params.push(a.byKey.toLowerCase());
      }
      if (a.from !== undefined) {
        condicoes.push('at >= ?');
        params.push(a.from);
      }
      if (a.to !== undefined) {
        condicoes.push('at <= ?');
        params.push(a.to);
      }
      if (cursor !== null) {
        condicoes.push('(seq < ? OR (seq = ? AND id < ?))');
        params.push(cursor.seq, cursor.seq, cursor.id);
      }
      const linhas = view
        .prepare(
          `SELECT id, seq, type, target_id AS targetId, target_label AS targetLabel, by_key AS byKey, by_label AS byLabel, reason, at ` +
            `FROM moderation_log WHERE ${condicoes.join(' AND ')} ORDER BY seq DESC, id DESC LIMIT ?`,
        )
        .all(...params, n + 1) as Array<{ id: string; seq: number; type: string; targetId: string | null; targetLabel: string | null; byKey: Uint8Array; byLabel: string; reason: string | null; at: number }>;
      const hasMore = linhas.length > n;
      const pagina = hasMore ? linhas.slice(0, n) : linhas;
      const ultima = pagina[pagina.length - 1];
      return {
        items: pagina.map((r) => {
          const alvoPessoa = r.targetId !== null && /^[0-9a-f]{64}$/.test(r.targetId);
          return {
            id: r.id,
            seq: r.seq,
            type: r.type,
            ...(r.targetId !== null ? (alvoPessoa ? { targetKey: r.targetId } : { targetId: r.targetId }) : {}),
            targetLabel: r.targetLabel,
            by: ref(estado, Buffer.from(r.byKey).toString('hex')),
            byLabel: r.byLabel,
            ...(r.reason !== null ? { reason: r.reason } : {}),
            at: r.at,
          };
        }),
        ...(hasMore && ultima !== undefined ? { nextCursor: encodeCursor({ seq: ultima.seq, id: ultima.id }) } : {}),
        hasMore,
      };
    },

    // ── Estado local do leitor (§15.6 — fila, rail, preferências e deep link) ────────

    /**
     * `query.outbox` (§15.6, fecha F-16): o que a fila local tem AGORA, na ordem de
     * enfileiramento. O preview sai do PRÓPRIO envelope enfileirado decodificado pelo
     * `opCodec` — nunca de um campo novo no schema; envelope ilegível é preview vazio
     * (§8.5: normaliza, não lança). `kindLabel` é rótulo de UI, não dado de protocolo.
     */
    outbox(a: { communityId?: string }) {
      if (deps.outboxRows === undefined) recusar('E_UNKNOWN_COMMAND');
      const rows = deps.outboxRows(a.communityId);
      const items = rows.map((r) => {
        const nome = kindName(r.kind);
        let channelId: string | null = null;
        let content: unknown;
        try {
          const envelope = decodeEnvelope(Buffer.from(r.envelope));
          const op = envelope === null ? null : decodeOp(envelope.op);
          if (op !== null && nome !== null) {
            const p: unknown = decodePayload(nome, op.payload);
            if (p !== null && typeof p === 'object') {
              const campos = p as Record<string, unknown>;
              if (nome === 'message.send') content = { content: campos['content'] };
              else if (nome === 'reaction.set') content = { emoji: campos['emoji'], targetMessageId: campos['messageId'] };
              else if (nome === 'thread.create') content = { targetMessageId: campos['rootMessageId'] };
              else if (nome === 'message.edit' || nome === 'message.delete' || nome === 'message.pin') content = { targetMessageId: campos['messageId'] };
            }
          }
        } catch {
          content = undefined;
        }
        const noCanal =
          r.channel_id === null
            ? {}
            : (view.prepare('SELECT name FROM channels WHERE community_id = ? AND id = ?').get(r.community_id, r.channel_id) as { name: string } | undefined);
        return {
          opId: r.op_id,
          ...(r.client_ref !== null ? { clientRef: r.client_ref } : {}),
          communityId: r.community_id,
          ...(r.channel_id !== null ? { channelId: r.channel_id } : {}),
          ...(noCanal !== undefined && typeof (noCanal as { name?: string }).name === 'string' ? { channelName: (noCanal as { name: string }).name } : {}),
          kind: r.kind,
          ...(nome !== null ? { kindLabel: ROTULO_KIND[nome] ?? nome } : {}),
          state: r.state,
          attempts: r.attempts,
          // §15.6 (emenda de 2026-09-05) — o instante do ENFILEIRAMENTO local. É o
          // único carimbo que existe antes de a op ser observada na réplica, e sem
          // ele a bolha redesenhada de F-16 nascia sem data.
          enqueuedAt: r.created_at,
          nextAttemptAt: r.next_attempt_at,
          ...(r.last_error !== null ? { lastError: r.last_error } : {}),
          ...(r.dropped_reason !== null ? { droppedReason: r.dropped_reason } : {}),
          ...(content !== undefined ? { preview: content } : {}),
        };
      });
      const counts = { queued: 0, sending: 0, failed: 0 };
      for (const r of rows) {
        if (r.state === 'queued') counts.queued += 1;
        else if (r.state === 'sending' || r.state === 'awaiting-confirmation') counts.sending += 1;
        else if (r.state === 'failed') counts.failed += 1;
      }
      return { items, counts };
    },

    /**
     * `query.communities` (§15.6): o rail, na ordem de entrada (`joined_at`, §23.2 — nunca
     * alfabética). O agregado de não-lidas vem do LS de §6.15; `hostStatus` vem do
     * acompanhamento de conexão (DR-29/DR-33) e `inactiveDays` é derivado de
     * `last_host_seen_at` — ambos ausentes quando não há fonte (precedente §46/§50/§53).
     */
    communities() {
      if (deps.comunidadesRows === undefined) recusar('E_UNKNOWN_COMMAND');
      // §18.4 passo 5 — "a comunidade continua no rail, em MODO HISTÓRICO SOMENTE LEITURA".
      // O filtro por `left_at` sozinho fazia o oposto: no instante em que a remoção marcava
      // a linha, a comunidade sumia do rail, e a tela de U-16 — que diz o que aconteceu, e
      // por quanto tempo a cópia fica — não tinha onde aparecer. Réplica com
      // `removed_reason` continua listada; sem ele, `left_at` segue tirando do rail.
      const linhas = [...deps.comunidadesRows()]
        .filter((r) => r['left_at'] == null || r['removed_reason'] != null)
        .sort((x, y) => Number(x['joined_at']) - Number(y['joined_at']));
      const itens: Array<Record<string, unknown>> = [];
      for (const row of linhas) {
        const communityId = String(row['community_id']);
        const estado = deps.stateFor(communityId);
        if (estado === null || !estado.community.exists) continue;
        const contagem = view.prepare('SELECT member_count AS m FROM communities WHERE community_id = ?').get(communityId) as { m: number } | undefined;
        let unreadCount = 0;
        let mentions = 0;
        for (const r of deps.manifest.listReadStates(communityId)) {
          unreadCount += r.unreadCount;
          mentions += r.pendingMentions;
        }
        const conn = deps.hostConnection?.(communityId);
        const ultimo = manifest.getLastHostSeenAt(communityId);
        itens.push({
          id: communityId,
          name: estado.community.name,
          ...(estado.community.iconEmoji !== undefined ? { iconEmoji: estado.community.iconEmoji } : {}),
          iconColor: estado.community.iconColor,
          memberCount: contagem?.m ?? 0,
          isHostedByMe: row['is_host'] === 1,
          replication: deps.replicationOf(communityId),
          ...(conn !== undefined ? { hostStatus: conn.status } : {}),
          ...(ultimo !== null ? { inactiveDays: inactiveDaysFrom(ultimo, deps.now?.() ?? Date.now()) } : {}),
          unread: { count: unreadCount, mentions },
          notificationLevel: deps.manifest.getNotificationLevel(communityId) ?? 'all',
          ...(estado.community.endedAt !== undefined ? { endedAt: estado.community.endedAt } : {}),
          // §18.4 passo 5 — o que a tela de U-16 precisa saber sem uma query só para ela:
          // POR QUE esta réplica é histórica e ATÉ QUANDO ela fica. O "por quem e com que
          // motivo" continua em `query.selfModeration`, que é onde a auditoria mora.
          ...(row['removed_reason'] != null ? { removedReason: String(row['removed_reason']) } : {}),
          ...(row['retain_until'] != null ? { retainUntil: Number(row['retain_until']) } : {}),
          partialInterpretation: estado.partialInterpretation,
        });
      }
      return itens;
    },

    /**
     * `query.preferences` (§15.6): o LS inteiro que a UI precisa para redesenhar as telas de
     * configuração. Volume sem valor gravado é 100 — "sem atenuação" é o neutro honesto;
     * id de dispositivo sem escolha fica ausente.
     */
    preferences() {
      const device: Record<string, unknown> = {};
      for (const chave of ['microphoneId', 'cameraId', 'outputId']) {
        const v = deps.manifest.devicePref(chave);
        if (v !== null && v.length > 0) device[chave] = v;
      }
      device['inputVolume'] = Number(deps.manifest.devicePref('inputVolume') ?? 100);
      device['outputVolume'] = Number(deps.manifest.devicePref('outputVolume') ?? 100);
      return {
        device,
        notifications: {
          enabled: deps.manifest.devicePref('notificationsEnabled') !== '0',
          byCommunity: deps.manifest.listNotificationLevels().map((r) => ({ communityId: r.communityId, level: r.level })),
        },
        channels: deps.manifest.listMutedChannels(),
        relayConsent: deps.manifest.listRelayConsents().map((r) => ({ communityId: r.communityId, decision: r.decision, at: r.at })),
        participantVolumes: deps.manifest.listParticipantVolumes(),
      };
    },

    /**
     * `query.hostStatus` (§15.6): a replicação, o estado de conexão observado (máquina de
     * §15.6, DR-29/DR-33), o último contato do LS e os dias desde ele. `lastSeenAt`/
     * `inactiveDays` ficam AUSENTES enquanto não houver contato observado nenhum — nunca
     * um zero inventado (precedente de §46/§50); `attempt` só existe acima de zero.
     */
    hostStatus(a: { communityId: string }) {
      ds(a.communityId);
      const conn = deps.hostConnection?.(a.communityId);
      const ultimo = manifest.getLastHostSeenAt(a.communityId);
      return {
        ...(conn !== undefined ? { status: conn.status } : {}),
        ...(ultimo !== null
          ? { lastSeenAt: ultimo, inactiveDays: inactiveDaysFrom(ultimo, deps.now?.() ?? Date.now()) }
          : {}),
        replication: deps.replicationOf(a.communityId),
        ...(conn !== undefined && conn.attempt > 0 ? { attempt: conn.attempt } : {}),
      };
    },

    /**
     * `query.voiceQueue` (§15.6, emenda de 2026-08-28): a fila de karaokê do canal — é a
     * consulta que reconstrói `voice.queueChanged` (§16.3 regra 1). Os nomes vêm do DS
     * (a fila só guarda chave, §16.4); quem não está no DS aparece como o fragmento de
     * chave, que é a verdade disponível. `null` quando o canal não tem fila conhecida.
     */
    voiceQueue(a: { communityId: string; channelId: string }) {
      const estado = ds(a.communityId);
      const bruto = deps.voiceQueue?.(a.communityId, a.channelId) ?? null;
      if (bruto === null) return null;
      // `queryUserRef` já resolve o membro ausente como fragmento de chave — a verdade
      // disponível para quem não está mais no DS (saiu da comunidade com a fila viva).
      const rotuloDe = (keyHex: string): string => queryUserRef(keyHex, estado.members.get(keyHex)).displayName;
      return {
        open: bruto.aberta,
        items: bruto.itens.map((i) => ({ keyHex: i.keyHex, displayName: rotuloDe(i.keyHex), queuedAt: i.queuedAt })),
        turn:
          bruto.turno === null
            ? null
            : { keyHex: bruto.turno.keyHex, displayName: rotuloDe(bruto.turno.keyHex), endsAt: bruto.turno.endsAt },
      };
    },

    /**
     * `query.selfModeration` (§15.6, alimenta a tela de §18.4): o que ESTA instalação sofreu.
     * Os flags primários saem do roster do DS; `kicked` é derivável da auditoria — um kick
     * sobre mim dentro da membresia CORRENTE (`at >= joinedAt`) e eu fora por isso.
     */
    selfModeration(a: { communityId: string }) {
      const estado = ds(a.communityId);
      const eu = deps.selfKeyHex();
      if (eu === null) recusar('E_NO_IDENTITY');
      const membro = estado.members.get(eu);
      if (membro === undefined) return { banned: false, kicked: false };
      const entradas = view
        .prepare(
          "SELECT seq, type, by_label AS byLabel, reason, at FROM moderation_log " +
            "WHERE community_id = ? AND type IN ('ban','kick','timeout') AND target_id = ? ORDER BY seq DESC",
        )
        .all(a.communityId, eu) as Array<{ seq: number; type: string; byLabel: string; reason: string | null; at: number }>;
      const banidoAtivo = entradas.find((e) => e.type === 'ban');
      const kickDaVidaAtual = entradas.find((e) => e.type === 'kick' && e.at >= membro.joinedAt);
      const timeoutAtivo = entradas.find((e) => e.type === 'timeout');
      const kicked = membro.state === 'left' && kickDaVidaAtual !== undefined;
      let rotulo: { byLabel: string; reason?: string } | null = null;
      if (membro.state === 'banned' && banidoAtivo !== undefined) {
        rotulo = { byLabel: banidoAtivo.byLabel, ...(banidoAtivo.reason !== null ? { reason: banidoAtivo.reason } : {}) };
      } else if (kicked && kickDaVidaAtual !== undefined) {
        rotulo = { byLabel: kickDaVidaAtual.byLabel, ...(kickDaVidaAtual.reason !== null ? { reason: kickDaVidaAtual.reason } : {}) };
      } else if (membro.timeoutUntil !== undefined && timeoutAtivo !== undefined) {
        rotulo = { byLabel: timeoutAtivo.byLabel, ...(timeoutAtivo.reason !== null ? { reason: timeoutAtivo.reason } : {}) };
      }
      return {
        banned: membro.state === 'banned',
        ...(membro.state === 'banned' && membro.bannedAt !== undefined ? { bannedAt: membro.bannedAt } : {}),
        kicked,
        ...(membro.timeoutUntil !== undefined ? { timeoutUntil: membro.timeoutUntil } : {}),
        ...(rotulo !== null ? rotulo : {}),
      };
    },

    /**
     * `query.resolveMessageLink` (§15.6, fecha RT-04). O MSGREF de §3.5 é base64url de 64
     * bytes: `communityId ‖ opId` (emenda datada em §3.5) — o par que toda réplica conhece
     * pelo mesmo valor, e para o qual já existe índice (`observed_ops`, §11.6).
     * No `not-synced` o `channelId` fica AUSENTE: ninguém o conhece antes da projeção da op
     * (emenda datada em §15.6), e inventar seria violar o precedente de §46/§50.
     */
    resolveMessageLink(a: { ref: string }) {
      if (!/^[A-Za-z0-9_-]{86}$/.test(a.ref)) return { status: 'malformed' as const };
      let bytes: Buffer;
      try {
        bytes = Buffer.from(a.ref, 'base64url');
      } catch {
        return { status: 'malformed' as const };
      }
      if (bytes.length !== 64) return { status: 'malformed' as const };
      const communityId = bytes.subarray(0, 32).toString('hex');
      const opIdHex = bytes.subarray(32).toString('hex');
      const estado = deps.stateFor(communityId);
      if (estado === null || !estado.community.exists) return { status: 'not-member' as const, communityId };
      const observada = view.prepare('SELECT seq FROM observed_ops WHERE community_id = ? AND op_id = ?').get(communityId, opIdHex) as
        | { seq: number }
        | undefined;
      if (observada === undefined) return { status: 'not-synced' as const, communityId };
      const msg = view.prepare('SELECT id, channel_id AS channelId, deleted_at AS deletedAt FROM messages WHERE community_id = ? AND seq = ?').get(communityId, observada.seq) as
        | { id: string; channelId: string; deletedAt: number | null }
        | undefined;
      if (msg === undefined) return { status: 'not-synced' as const, communityId };
      if (msg.deletedAt !== null) return { status: 'deleted' as const };
      return { status: 'ok' as const, communityId, channelId: msg.channelId, messageId: msg.id, seq: observada.seq };
    },
  };
}


// ─── §14.5/RT-11 — a causa de `partial` em `query.search` ────────────────────────────────

/**
 * §14.5: "`query.search` devolve `partial: true` quando o estado de replicação **não** é
 * `synced`, **ou** o host está offline, **ou** a comunidade está em `partialInterpretation`."
 * O módulo de busca só ECOA a causa (§23) — decidi-la é da composição, que é quem tem os
 * três sinais. Pura de propósito: era uma decisão sem produtor nenhum no produto, e sem
 * forma testável a segunda tentativa de escrevê-la erraria igual.
 *
 * A ordem é precedência, não gosto: o que a réplica não conseguiu INTERPRETAR fala sobre o
 * resultado devolvido; o que ela não conseguiu BAIXAR fala sobre o que falta; o contato com
 * o host é o mais genérico dos três. `undefined` ⇒ resultado completo.
 */
export function searchPartialReason(args: {
  readonly partialInterpretation: boolean;
  readonly replication: string | undefined;
  readonly isHost: boolean;
  readonly hostStatus: string;
}): SearchPartialReason | undefined {
  if (args.partialInterpretation) return 'partial-interpretation';
  if (args.replication !== undefined && args.replication !== 'synced') {
    return args.replication === 'catching-up' ? 'catching-up' : 'stalled';
  }
  // O host não espera contato de si mesmo: §14.5 fala do "par host", e aqui ele é este nó.
  if (args.isHost) return undefined;
  return args.hostStatus === 'online' ? undefined : 'host-offline';
}
