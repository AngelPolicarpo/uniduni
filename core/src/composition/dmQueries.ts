// As cinco consultas de §31.16.3 sobre a `view.db` da conversa direta.
//
// Raiz de composição (§4): nenhuma regra de domínio nasce aqui. O que estas funções fazem é
// **recortar** o que o `dmProjector` já materializou (§31.7.6) e juntar três fontes:
//
//   - `view.db`   — conteúdo (`dm_messages`, `dm_reactions`, `dm_attachments`,
//                   `dm_participants`);
//   - `manifest`  — o que é local e não replica: os cinco estados, `dm_local_read_state`, as
//                   marcas de esquecimento e `dm_prefs` (§31.12);
//   - `directMessages` (L2) — `sync`, que é estado vivo e não fica em banco nenhum.
//
// **Não há `DS` aqui, e a ausência é o desenho.** Numa conversa de dois não existe roster,
// cargo, permissão nem moderação (§31.1): `DmPeerRef` não tem `collision` porque não há
// conjunto em que colidir, e o `handle` de §6.1 — derivado da chave — é sempre exibido junto
// do nome, que é a mitigação (a) de **L-5**, aqui mais forte, porque para falar com alguém é
// preciso **já ter** a chave dele.
//
// Cursor: `base64url({ordSum, authorKey, id})`, opaco. Forma inválida ou de outra conversa é
// `E_BAD_CURSOR`, nunca resultado errado em silêncio (§15.6.1).

import { computeHandle } from '../l0/identity/index.ts';
import type { ManifestDb } from '../l0/manifest/index.ts';
import type { ViewDb } from '../l0/view/index.ts';
import { modoDeRevelacao } from '../l2/blobs/index.ts';
import type {
  DirectMessages,
  DmContactPolicy,
  DmConversationRow,
  DmSyncState,
} from '../l2/directMessages/index.ts';

/** §23.3 — o mesmo lote de `query.messages`; §31.16.3 declara `limit = 50`. */
const LIMITE_MENSAGENS = 50;
const LIMITE_REATORES = 24;

function recusar(code: string): never {
  throw Object.assign(new Error(code), { code });
}

// ─── Cursor de §31.16.3 ────────────────────────────────────────────────────────────────

export type DmCursor = {
  readonly ordSum: number;
  /** A chave do autor em hex — a segunda metade do `ordKey` de §31.6. */
  readonly authorKey: string;
  readonly id: string;
};

export function encodeDmCursor(c: DmCursor): string {
  return Buffer.from(JSON.stringify({ ordSum: c.ordSum, authorKey: c.authorKey, id: c.id }), 'utf8').toString(
    'base64url',
  );
}

/**
 * O inverso. **Três campos, e os três importam**: `ordSum` sozinho empata — §31.6 desempata
 * pela chave do autor —, e `id` é o que sobrevive a uma reinterpretação (§31.13), em que o
 * `ordSum` de um registro pode mudar de vizinhos sem mudar de identidade.
 */
export function decodeDmCursor(cursor: string): DmCursor {
  try {
    const p = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      ordSum?: unknown;
      authorKey?: unknown;
      id?: unknown;
    };
    if (
      typeof p.ordSum !== 'number' ||
      !Number.isInteger(p.ordSum) ||
      typeof p.authorKey !== 'string' ||
      !/^[0-9a-f]{64}$/.test(p.authorKey) ||
      typeof p.id !== 'string' ||
      p.id.length === 0
    ) {
      recusar('E_BAD_CURSOR');
    }
    return { ordSum: p.ordSum, authorKey: p.authorKey, id: p.id };
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

// ─── DTOs de §31.16.3 ──────────────────────────────────────────────────────────────────

/** **Sem `collision`** — numa conversa de dois não há conjunto em que colidir (§31.16.3). */
export type DmPeerRef = {
  readonly key: string;
  readonly displayName: string;
  readonly handle: string;
  readonly avatarColor: number;
};

export type DmMessageDto = {
  readonly id: string;
  readonly ordSum: number;
  readonly conversationId: string;
  readonly author: DmPeerRef;
  /** `null` quando tombstonada (A26) — a linha fica, o conteúdo não. */
  readonly content: string | null;
  readonly ts: number;
  readonly clockSkewed: boolean;
  readonly ackAhead: boolean;
  readonly editedAt?: number;
  readonly replyTo?: {
    readonly messageId: string;
    readonly author: DmPeerRef;
    readonly excerpt: string | null;
    readonly deleted: boolean;
  };
  readonly hasAttachment: boolean;
  readonly deleted: boolean;
  /** §31.11 — só nas **próprias**; ausente nas do par, que não têm entrega a observar. */
  readonly delivery?: 'written' | 'delivered';
};

type LinhaMensagem = {
  conversation_id: string;
  id: string;
  ord_sum: number;
  author_key: Buffer;
  author_seq: number;
  content: string | null;
  ts: number;
  clock_skewed: number;
  ack_ahead: number;
  edited_at: number | null;
  reply_to_id: string | null;
  deleted_at: number | null;
  has_attachment: number;
};

type LinhaParticipante = {
  identity_key: Buffer;
  display_name: string;
  avatar_color: number;
  core_key: Buffer | null;
  length: number;
  invalid: number;
};

export type DmQueryDeps = {
  readonly view: ViewDb;
  readonly manifest: ManifestDb;
  readonly dm: DirectMessages;
  /** Chave pública hex da identidade local — `null` sem identidade carregada. */
  selfKeyHex(): string | null;
  /**
   * §31.11 — `entregueAté(meuLado) = max(r.ack : r ∈ log do par)`. Vive no `DmState`, que é
   * do projetor; a composição o entrega já calculado. `0` quando não há projetor montado.
   */
  deliveredUpTo(conversationId: string): number;
  /** §31.13 — `lag` do par, em registros por interpretar. */
  lagOf(conversationId: string): number;
  /** §31.4 — a conversa viu `kind` ou `v` que este binário não conhece. */
  partialOf(conversationId: string): {
    readonly partial: boolean;
    readonly unknownKinds: readonly number[];
    readonly unknownVersions: readonly number[];
  };
  /**
   * §31.14 / §31.16.3 — o estado de download deste blob, em `local_blob_cache` (§13.4).
   *
   * Ele existe porque §31.16.3 declara que o `attachment` de `query.dmMessage` é o
   * `AttachmentDto` de §15.6.1 **sem alteração**, e metade daquele DTO é estado de download:
   * `state`, `progress` e `localPath`. Sem esta porta a query devolvia só o que está em
   * `dm_attachments` — nome, tamanho e ponteiro —, e o cartão da conversa nascia congelado em
   * "Baixar" mesmo com o arquivo já no disco desta máquina.
   *
   * Ausente = sem `BlobManager` montado (o rig de teste): o DTO responde `not-downloaded`,
   * que é a verdade quando não há cache a consultar.
   */
  blobCache?(blobsCoreKey: Buffer, blobIdHex: string): {
    readonly state: string;
    readonly bytesDownloaded: number;
    readonly path: string | null;
  } | null;
};

export function dmQueryPorts(deps: DmQueryDeps) {
  const { view, manifest, dm } = deps;

  function linha(conversationId: string): DmConversationRow {
    const row = manifest.getDmConversation(conversationId);
    if (row === null) recusar('E_NOT_FOUND');
    return row;
  }

  /** Os dois participantes materializados pelo projetor, por chave hex. */
  function participantes(conversationId: string): Map<string, LinhaParticipante> {
    const linhas = view
      .prepare('SELECT identity_key, display_name, avatar_color, core_key, length, invalid FROM dm_participants WHERE conversation_id = ?')
      .all(conversationId) as LinhaParticipante[];
    return new Map(linhas.map((l) => [l.identity_key.toString('hex'), l]));
  }

  /**
   * §31.16.3 — o `handle` sai **sempre** da chave (§6.1), nunca do nome: é derivado, não
   * declarado, e é por isso que ele mitiga a impersonação que `displayName` permite (**L-5**).
   * Sem `dm.profile` daquele lado, o nome cai para o prefixo da chave — a mesma degradação
   * de `queryUserRef`.
   */
  function ref(keyHex: string, p?: LinhaParticipante): DmPeerRef {
    return {
      key: keyHex,
      displayName: p?.display_name ?? keyHex.slice(0, 8),
      handle: computeHandle(Buffer.from(keyHex, 'hex')),
      avatarColor: p?.avatar_color ?? 0,
    };
  }

  function dto(
    conversationId: string,
    r: LinhaMensagem,
    porChave: Map<string, LinhaParticipante>,
    eu: string | null,
    entregueAte: number,
    respondida?: { id: string; content: string | null; author_key: Buffer; deleted_at: number | null },
  ): DmMessageDto {
    const autor = r.author_key.toString('hex');
    const propria = eu !== null && autor === eu;
    return {
      id: r.id,
      ordSum: r.ord_sum,
      conversationId,
      author: ref(autor, porChave.get(autor)),
      content: r.content,
      ts: r.ts,
      clockSkewed: r.clock_skewed !== 0,
      ackAhead: r.ack_ahead !== 0,
      ...(r.edited_at !== null ? { editedAt: r.edited_at } : {}),
      ...(respondida !== undefined
        ? {
            replyTo: {
              messageId: respondida.id,
              author: ref(respondida.author_key.toString('hex'), porChave.get(respondida.author_key.toString('hex'))),
              excerpt: respondida.content === null ? null : respondida.content.slice(0, 120),
              deleted: respondida.deleted_at !== null,
            },
          }
        : {}),
      hasAttachment: r.has_attachment !== 0,
      deleted: r.deleted_at !== null,
      // §31.11 — `delivered` quando `entregueAté ≥ índice + 1`. **Ausente** nas do par: a
      // entrega da mensagem do outro é observação dele, não minha, e inventá-la aqui seria
      // afirmar o que nenhum atestado sustenta.
      ...(propria
        ? { delivery: entregueAte >= r.author_seq ? ('delivered' as const) : ('written' as const) }
        : {}),
    };
  }

  /**
   * §31.16.3 — o `AttachmentDto` de §15.6.1, **inteiro**, para a conversa direta.
   *
   * §31.14 manda reutilizar §13 sem alteração, e isso vale para o DTO tanto quanto para o
   * fluxo: o cartão da DM precisa das mesmas quatro coisas que o da comunidade — o estado do
   * cache, o quanto já chegou, o caminho local quando existe e o `revealMode` de §13.6 regra
   * 1. Devolver metade do tipo declarado é o defeito que fazia o cartão da DM nascer parado.
   *
   * `availablePeers`/`hostAvailable` são `0`/`false` pela mesma razão de §15.6.1 (emenda de
   * 2026-08-22): eles são leitura do bitfield **vivo**, e fora de um download em curso não há
   * par conectado àquele core. Numa DM `hostAvailable` é `false` por construção — não há host.
   *
   * A correlação com `blob.progress` é o `blobIdHex` de §13.2 (§15.6.1, emenda de
   * 2026-09-05): os 16 primeiros bytes do `hash`, em hex, que é a chave do fio.
   */
  function anexoDto(anexo: {
    owner_key: Buffer;
    blobs_core_key: Buffer;
    blob_id: string;
    name: string;
    size_bytes: number;
    kind: number;
    hash: Buffer;
  }) {
    const hashHex = anexo.hash.toString('hex');
    const cache = deps.blobCache?.(anexo.blobs_core_key, hashHex.slice(0, 32)) ?? null;
    const baixados = cache?.bytesDownloaded ?? 0;
    return {
      name: anexo.name,
      sizeBytes: anexo.size_bytes,
      kind: anexo.kind,
      // §13.6 regra 1 / B74 — o mesmo campo do `AttachmentDto` de §15.6.1, que
      // §31.16.2 declara reusado sem alteração. Quem classifica é o núcleo.
      revealMode: modoDeRevelacao(anexo.name),
      hash: hashHex,
      ownerKey: anexo.owner_key.toString('hex'),
      blobsCoreKey: anexo.blobs_core_key.toString('hex'),
      blobId: JSON.parse(anexo.blob_id) as unknown,
      state: cache?.state ?? 'not-downloaded',
      progress: anexo.size_bytes > 0 ? Math.min(1, baixados / anexo.size_bytes) : 0,
      availablePeers: 0,
      hostAvailable: false,
      ...(cache?.path != null ? { localPath: cache.path } : {}),
    };
  }

  /**
   * §31.16.3 (emenda de 2026-09-05) — a marca de leitura desta conversa, para o divisor de
   * "Novas mensagens" que **U-33** exige ("a conversa reusa a anatomia de 2.1 — … divisor de
   * Novas mensagens …").
   *
   * Ela é o `ordKey` de §31.6 do watermark de `dm_local_read_state` (A28) — os **dois**
   * eixos —, e não a contagem: o contador diz **quantas**, o divisor precisa saber **onde**.
   * `-1` com a chave zerada é o sentinela de "nada lido"; a ordem canônica começa em 0, e
   * nesse caso tudo é novo.
   */
  function marcaDeLeitura(conversationId: string): {
    readonly lastReadOrdSum: number;
    readonly lastReadAuthorKey: string;
  } {
    const marca = manifest.getDmReadState(conversationId);
    return {
      lastReadOrdSum: marca?.last_read_ord_sum ?? -1,
      // O segundo eixo do `ordKey` de §31.6, e ele não é decoração: o corte do divisor tem
      // de ser **o mesmo** que `naoLidas` usa, senão o selo diz "1" e o divisor não aparece.
      lastReadAuthorKey: marca?.last_read_author.toString('hex') ?? '',
    };
  }

  /** §31.13 — o par `{state, lag}` que a UI desenha. `sync` vem de L2; `lag` da composição. */
  function sincronia(conversationId: string): { state: DmSyncState; lag: number } {
    return { state: dm.sync(conversationId), lag: deps.lagOf(conversationId) };
  }

  /**
   * §31.12 — as não-lidas são uma **query** sobre `ordKey > lastRead`, nunca um acumulador
   * (A28). É por isso que não há contagem dupla e que a reprojeção as recomputa do zero.
   */
  function naoLidas(conversationId: string, eu: string | null): number {
    const marca = manifest.getDmReadState(conversationId);
    const params: unknown[] = [conversationId];
    let cond = '';
    if (marca !== null) {
      cond = 'AND (ord_sum > ? OR (ord_sum = ? AND hex(author_key) > ?)) ';
      params.push(marca.last_read_ord_sum, marca.last_read_ord_sum, marca.last_read_author.toString('hex').toUpperCase());
    }
    // A minha própria mensagem nunca é não-lida.
    if (eu !== null) {
      cond += 'AND hex(author_key) <> ? ';
      params.push(eu.toUpperCase());
    }
    const r = view
      .prepare(`SELECT COUNT(*) AS n FROM dm_messages WHERE conversation_id = ? ${cond}AND deleted_at IS NULL`)
      .get(...params) as { n: number };
    return r.n;
  }

  return {
    naoLidas,

    /** `query.dmConversations` (§31.16.3) — mais recente primeiro. */
    conversations() {
      const eu = deps.selfKeyHex();
      const saida = manifest.listDmConversations().map((row) => {
        const id = row.conversation_id;
        const porChave = participantes(id);
        const par = row.peer_key.toString('hex');
        const ultima = view
          .prepare(
            'SELECT id, ord_sum, ts, content, author_key FROM dm_messages WHERE conversation_id = ? ' +
              'ORDER BY ord_sum DESC, author_key DESC LIMIT 1',
          )
          .get(id) as { id: string; ord_sum: number; ts: number; content: string | null; author_key: Buffer } | undefined;
        const pendentes =
          row.state === 'pending-in'
            ? ((view.prepare('SELECT COUNT(*) AS n FROM dm_messages WHERE conversation_id = ?').get(id) as { n: number }).n)
            : undefined;
        return {
          conversationId: id,
          peer: ref(par, porChave.get(par)),
          state: row.state,
          sync: dm.sync(id),
          unread: { count: naoLidas(id, eu) },
          ...(ultima !== undefined
            ? {
                lastMessage: {
                  ordSum: ultima.ord_sum,
                  ts: ultima.ts,
                  excerpt: ultima.content === null ? null : ultima.content.slice(0, 120),
                  author: ref(ultima.author_key.toString('hex'), porChave.get(ultima.author_key.toString('hex'))),
                },
              }
            : {}),
          // §31.9 — quantos registros do par já chegaram, para a UI do pedido. Só faz sentido
          // em `pending-in`, onde a replicação é limitada.
          ...(pendentes !== undefined ? { pendingRecords: pendentes } : {}),
          _ord: ultima?.ord_sum ?? -1,
          _criada: row.created_at,
        };
      });
      // "Mais recente primeiro": pela última mensagem, e pela criação quando não há nenhuma.
      saida.sort((a, b) => b._ord - a._ord || b._criada - a._criada);
      return saida.map(({ _ord, _criada, ...resto }) => resto);
    },

    /** `query.dmConversation` (§31.16.3). */
    conversation(a: { conversationId: string }) {
      const row = linha(a.conversationId);
      const porChave = participantes(a.conversationId);
      const eu = deps.selfKeyHex();
      const par = row.peer_key.toString('hex');
      const parcial = deps.partialOf(a.conversationId);
      const { state, lag } = sincronia(a.conversationId);
      return {
        conversationId: a.conversationId,
        peer: ref(par, porChave.get(par)),
        state: row.state,
        sync: state,
        lag,
        deliveredUpTo: deps.deliveredUpTo(a.conversationId),
        // §31.7.2 — `invalid` é estado de LADO: aquele lado emitiu registro que o `dmFold`
        // recusou de forma que invalida o resto dele.
        selfInvalid: eu !== null && (porChave.get(eu)?.invalid ?? 0) !== 0,
        peerInvalid: (porChave.get(par)?.invalid ?? 0) !== 0,
        partialInterpretation: parcial.partial,
        // §31.16.3 (emenda de 2026-09-05) — onde fica o corte do divisor de "Novas
        // mensagens" de U-33. Sem ele o renderer sabia **quantas** não lidas havia e não
        // sabia **onde** elas começam.
        ...marcaDeLeitura(a.conversationId),
        ...(row.blocked_at !== null ? { blockedAt: row.blocked_at } : {}),
        ...(row.retain_until !== null ? { retainUntil: row.retain_until } : {}),
      };
    },

    /**
     * `query.dmMessages` (§31.16.3) — página por `(ordSum, authorKey, id)`, lote de 50.
     *
     * A ordem é a canônica de §31.6, e a **saída é sempre crescente**, independente da
     * direção: `before` devolve a página anterior já reordenada para leitura, como
     * `query.messages` faz com `seq` (§23.2). A UI não inverte nada.
     */
    messages(a: { conversationId: string; cursor?: string; limit?: number; direction?: string }) {
      linha(a.conversationId);
      const eu = deps.selfKeyHex();
      const n = limite(a.limit, LIMITE_MENSAGENS);
      const direcao = a.direction ?? 'before';
      if (direcao !== 'before' && direcao !== 'after') recusar('E_VALIDATION');
      const cursor = a.cursor === undefined ? null : decodeDmCursor(a.cursor);

      // O trio inteiro entra na comparação: `ordSum` empata (§31.6 desempata pela chave do
      // autor) e `id` fecha o caso em que os dois primeiros ainda coincidem.
      const cmp = direcao === 'before' ? '<' : '>';
      const cond =
        cursor === null
          ? ''
          : `AND (ord_sum ${cmp} ? OR (ord_sum = ? AND (hex(author_key) ${cmp} ? OR (hex(author_key) = ? AND id ${cmp} ?)))) `;
      const ordem = direcao === 'before' ? 'DESC' : 'ASC';
      const params: unknown[] = [a.conversationId];
      if (cursor !== null) {
        const hex = cursor.authorKey.toUpperCase();
        params.push(cursor.ordSum, cursor.ordSum, hex, hex, cursor.id);
      }
      const linhas = view
        .prepare(
          'SELECT m.*, (SELECT COUNT(*) FROM dm_attachments x WHERE x.conversation_id = m.conversation_id AND x.message_id = m.id) AS has_attachment ' +
            `FROM dm_messages m WHERE m.conversation_id = ? ${cond}` +
            `ORDER BY m.ord_sum ${ordem}, m.author_key ${ordem}, m.id ${ordem} LIMIT ?`,
        )
        .all(...params, n + 1) as LinhaMensagem[];

      const hasMore = linhas.length > n;
      const pagina = hasMore ? linhas.slice(0, n) : linhas;
      const ordenada = direcao === 'before' ? [...pagina].reverse() : pagina;
      const borda = direcao === 'before' ? ordenada[0] : ordenada[ordenada.length - 1];
      const porChave = participantes(a.conversationId);
      const entregueAte = deps.deliveredUpTo(a.conversationId);
      return {
        messages: ordenada.map((r) => dto(a.conversationId, r, porChave, eu, entregueAte)),
        ...(hasMore && borda !== undefined
          ? {
              nextCursor: encodeDmCursor({
                ordSum: borda.ord_sum,
                authorKey: borda.author_key.toString('hex'),
                id: borda.id,
              }),
            }
          : {}),
        hasMore,
        sync: dm.sync(a.conversationId),
        // A página e o corte vêm juntos: buscá-lo numa segunda query deixaria a marca
        // avançar entre as duas, e o divisor apareceria no lugar errado por uma corrida.
        ...marcaDeLeitura(a.conversationId),
      };
    },

    /** `query.dmMessage` (§31.16.3) — com reações e anexo. `null` quando não existe. */
    message(a: { conversationId: string; messageId: string }) {
      linha(a.conversationId);
      const r = view
        .prepare(
          'SELECT m.*, (SELECT COUNT(*) FROM dm_attachments x WHERE x.conversation_id = m.conversation_id AND x.message_id = m.id) AS has_attachment ' +
            'FROM dm_messages m WHERE m.conversation_id = ? AND m.id = ?',
        )
        .get(a.conversationId, a.messageId) as LinhaMensagem | undefined;
      if (r === undefined) return null;

      const porChave = participantes(a.conversationId);
      const eu = deps.selfKeyHex();
      const respondida =
        r.reply_to_id === null
          ? undefined
          : (view
              .prepare('SELECT id, content, author_key, deleted_at FROM dm_messages WHERE conversation_id = ? AND id = ?')
              .get(a.conversationId, r.reply_to_id) as
              | { id: string; content: string | null; author_key: Buffer; deleted_at: number | null }
              | undefined);

      const reacoes = view
        .prepare('SELECT emoji, identity_key FROM dm_reactions WHERE conversation_id = ? AND message_id = ? ORDER BY emoji, identity_key')
        .all(a.conversationId, a.messageId) as Array<{ emoji: string; identity_key: Buffer }>;
      const porEmoji = new Map<string, string[]>();
      for (const re of reacoes) {
        const lista = porEmoji.get(re.emoji) ?? [];
        lista.push(re.identity_key.toString('hex'));
        porEmoji.set(re.emoji, lista);
      }

      const anexo = view
        .prepare('SELECT owner_key, blobs_core_key, blob_id, name, size_bytes, kind, hash FROM dm_attachments WHERE conversation_id = ? AND message_id = ?')
        .get(a.conversationId, a.messageId) as
        | {
            owner_key: Buffer;
            blobs_core_key: Buffer;
            blob_id: string;
            name: string;
            size_bytes: number;
            kind: number;
            hash: Buffer;
          }
        | undefined;

      return {
        ...dto(a.conversationId, r, porChave, eu, deps.deliveredUpTo(a.conversationId), respondida),
        reactions: [...porEmoji.entries()].map(([emoji, chaves]) => ({
          emoji,
          count: chaves.length,
          mine: eu !== null && chaves.includes(eu),
          reactors: chaves.slice(0, LIMITE_REATORES).map((k) => ref(k, porChave.get(k))),
        })),
        ...(anexo !== undefined ? { attachment: anexoDto(anexo) } : {}),
      };
    },

    /** `query.dmPrefs` (§31.16.3) — hoje só a política de contato de §31.9 regra 5. */
    prefs(): { contactPolicy: DmContactPolicy } {
      return { contactPolicy: dm.contactPolicy() };
    },
  };
}

export type DmQueryPorts = ReturnType<typeof dmQueryPorts>;
