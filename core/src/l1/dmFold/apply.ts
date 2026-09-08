// Estágios 10, 11 e 12 de §31.7.3, delegados por `kind`: limites de campo (§31.7.5), regras
// estruturais (`RD-*`, §31.7.4) e emissão de efeitos (§31.7.6).
//
// A tabela de §31.7.4 é **determinística e completa**: nenhum handler consulta relógio,
// configuração ou banco, e nenhum lança. Referência quebrada tem resolução declarada — a
// tabela "Resolução determinística de referência quebrada" de §31.7.4 —, não uma exceção.

import {
  DM_KINDS,
  dmCorePossessionHash,
  verifyDmSignature,
  type DmOp,
  type DmPayloadOf,
} from '../dmCodec/index.ts';
import type { ErrorCode } from '../errors/index.ts';
import { dmEntityId } from '../idgen/index.ts';

import { DM_ATTACHMENT_MAX_BYTES, DM_MAX_REACTION_EMOJIS, isDmAvatarColor } from './constants.ts';
import type { DmEffect } from './effects.ts';
import {
  checkDmDisplayName,
  checkDmMessageContent,
  checkDmReactionEmoji,
  isValidDmAttachmentName,
} from './limits.ts';
import { DmDraft, otherSide, type DmOrigin } from './state.ts';

export type DmRejection = { readonly code: ErrorCode; readonly field?: string };

/**
 * §31.7.1 — o contexto entra como **argumento**, nunca como leitura de ambiente, pelo mesmo
 * arranjo que §8.1 usa para o `MessageLookup`.
 */
export type DmContext = {
  readonly conversationId: string;
  /** Os 32 bytes de §31.2. Material do estágio 2 e de `dmEntityId`. */
  readonly conversationKey: Buffer;
  /** §31.2 — as duas chaves de identidade, já ordenadas por byte. */
  readonly loKey: Buffer;
  readonly hiKey: Buffer;
  /** §31.3 — a chave AEAD de conteúdo, suprida pela raiz de composição (§4). */
  readonly contentKey: Uint8Array;
  /**
   * As chaves públicas dos dois cores de DM.
   *
   * **Acréscimo ao `DmContext` de §31.7.1, sem segunda leitura possível.** RD-1 manda
   * verificar `coreProof` "sobre `BLAKE2b('dm-core-possession/1' ‖ conversationId ‖
   * chaveDoCore)`", e a chave do core não está em lugar nenhum do registro: §31.5 dá ao
   * `dm.hello` `peerKey · coreProof · displayName · avatarColor`, e `peerKey` é a **outra
   * chave de identidade** do par, não um core. A chave do core é a do core que se está lendo
   * — o nó a conhece por construção (abriu o core) e a aprendeu do handshake `dmHello` de
   * §31.8, que a carrega. Sem ela RD-1 não é implementável, e o `dm.hello` deixaria de ser a
   * "prova durável" que §31.8(3) diz que ele é.
   *
   * Ausente ⇒ a prova daquele lado não é conferível e a gênese daquele lado é recusada: o
   * `dmFold` não presume o que não pode verificar.
   */
  readonly loCoreKey?: Buffer;
  readonly hiCoreKey?: Buffer;
};

export type DmKindCtx = {
  readonly origin: DmOrigin;
  readonly index: number;
  readonly ordSum: number;
  readonly op: DmOp;
  /** `ts` já clampado por RD-5. */
  readonly ts: number;
  /** `ack` já clampado por RD-4. */
  readonly ack: number;
  readonly ackAhead: boolean;
  readonly clockSkewed: boolean;
  readonly draft: DmDraft;
  readonly effects: DmEffect[];
  readonly dm: DmContext;
};

const rj = (code: ErrorCode): DmRejection => ({ code });
const VAL = (field: string): DmRejection => ({ code: 'E_VALIDATION', field });

/** RD-1 marca **aquele lado** `invalid`; o outro segue. É a diferença deliberada com R-27. */
const GENESIS = (ctx: DmKindCtx): DmRejection => {
  ctx.draft.side(ctx.origin).invalid = true;
  return rj('E_GENESIS_MISPLACED');
};

type Handler<K extends keyof typeof DM_KINDS> = (
  ctx: DmKindCtx,
  p: DmPayloadOf<K>,
) => DmRejection | null;

/** A linha de `dm_participants` que o `dmFold` decide (§31.12). */
function participantRow(ctx: DmKindCtx): void {
  const side = ctx.draft.state.sides[ctx.origin];
  ctx.effects.push({
    t: 'upsert',
    table: 'dm_participants',
    key: [side.identityKey],
    row: {
      identity_key: side.identityKey,
      display_name: side.displayName,
      avatar_color: side.avatarColor,
      core_key: side.coreKey ?? null,
    },
  });
}

// ─── §31.5 — os seis handlers ──────────────────────────────────────────────────────────

/**
 * RD-1 (parte de payload) e RD-2.
 *
 * A parte de cabeçalho de RD-1 — `kind`, `authorSeq = 1`, `ack = 0` — é o estágio 6, que roda
 * antes de a AEAD abrir. O que sobra é o que só existe depois do estágio 9: `peerKey` igual à
 * outra chave do par e `coreProof` válido. Um desvio aqui é o mesmo desvio de RD-1 e marca o
 * lado `invalid` pela mesma razão.
 */
const dmHello: Handler<'dm.hello'> = (ctx, p) => {
  // RD-2 — `dm.hello` só no índice 0. Fora dele é `REJECTED` **sem** marcar `invalid`: um
  // registro fora de lugar não diz que o core foi reescrito, e RD-1 diz.
  if (ctx.index !== 0) return rj('E_GENESIS_MISPLACED');

  const nome = checkDmDisplayName(p.displayName);
  if (!nome.ok) {
    ctx.draft.side(ctx.origin).invalid = true;
    return VAL(nome.field);
  }
  if (!isDmAvatarColor(p.avatarColor)) {
    ctx.draft.side(ctx.origin).invalid = true;
    return VAL('avatarColor');
  }

  // RD-1 — `peerKey` é a **outra** chave do par.
  const par = ctx.draft.state.sides[otherSide(ctx.origin)].identityKey;
  if (!par.equals(p.peerKey)) return GENESIS(ctx);

  // RD-1 — posse do core, sobre a chave do core de origem.
  const coreKey = ctx.origin === 'lo' ? ctx.dm.loCoreKey : ctx.dm.hiCoreKey;
  if (coreKey === undefined) return GENESIS(ctx);
  const digest = dmCorePossessionHash(ctx.dm.conversationKey, coreKey);
  if (!verifyDmSignature(p.coreProof, digest, ctx.op.author)) return GENESIS(ctx);

  const side = ctx.draft.side(ctx.origin);
  // RD-6 — a chave é fixada aqui e nada depois a troca.
  side.coreKey = coreKey;
  side.displayName = nome.value;
  side.avatarColor = p.avatarColor;
  participantRow(ctx);
  ctx.effects.push({
    t: 'notify',
    topic: 'dm.conversationChanged',
    data: { conversationId: ctx.dm.conversationId, fields: ['peer', 'coreKey'] },
  });
  return null;
};

/**
 * `dm.profile` — perfil **por conversa**, como §6.3 já faz por comunidade. RD-10: o último a
 * escrever vence **por `ordKey`**, o que aqui é automático — os registros chegam ao `dmFold`
 * na ordem canônica de §31.6, então "o último aplicado" **é** o maior `ordKey`.
 */
const dmProfile: Handler<'dm.profile'> = (ctx, p) => {
  if (p.displayName === undefined && p.avatarColor === undefined) {
    // Registro sem campo nenhum: nada a convergir. `APPLIED` sem efeito seria estado morto
    // na projeção; `E_VALIDATION` diz o que aconteceu e não muda nada.
    return VAL('displayName');
  }
  let nome: string | undefined;
  if (p.displayName !== undefined) {
    const c = checkDmDisplayName(p.displayName);
    if (!c.ok) return VAL(c.field);
    nome = c.value;
  }
  if (p.avatarColor !== undefined && !isDmAvatarColor(p.avatarColor)) return VAL('avatarColor');

  const side = ctx.draft.side(ctx.origin);
  if (nome !== undefined) side.displayName = nome;
  if (p.avatarColor !== undefined) side.avatarColor = p.avatarColor;
  participantRow(ctx);
  ctx.effects.push({
    t: 'notify',
    topic: 'dm.conversationChanged',
    data: { conversationId: ctx.dm.conversationId, fields: ['peer'] },
  });
  return null;
};

const dmMessage: Handler<'dm.message'> = (ctx, p) => {
  // Estágio 10 — limites de campo (§31.7.5).
  const content = checkDmMessageContent(p.content);
  if (!content.ok) return VAL(content.field);
  if (p.attachment !== undefined) {
    const a = p.attachment;
    if (a.sizeBytes < 1 || a.sizeBytes > DM_ATTACHMENT_MAX_BYTES) return rj('E_ATTACHMENT_TOO_LARGE');
    if (!isValidDmAttachmentName(a.name)) return VAL('name');
  }

  // Estágio 11 — RD-8 sobre `replyToId`: existente e **não deletada na ordem corrente**.
  // §31.7.4 (emenda de 2026-09-05) — alvo que a ordem ainda não contém é `E_NOT_FOUND`; tombstonado é `E_MESSAGE_DELETED`.
  if (p.replyToId !== undefined) {
    const alvo = ctx.draft.state.messages.get(p.replyToId);
    if (alvo === undefined) return rj('E_NOT_FOUND');
    if (alvo.deletedAt !== undefined) return rj('E_MESSAGE_DELETED');
  }

  // Estágio 11 — RD-11. Ver `DmSideState.blobsCoreKey`: o que é verificável sem mudar o fio
  // é a **consistência** do core de blobs de um lado, vinculado no primeiro anexo.
  const side = ctx.draft.state.sides[ctx.origin];
  if (p.attachment !== undefined && side.blobsCoreKey !== undefined) {
    if (!side.blobsCoreKey.equals(p.attachment.blob.blobsCoreKey)) return VAL('attachment');
  }

  const id = dmEntityId('message', ctx.dm.conversationKey, ctx.op.author, ctx.op.authorSeq);
  // Impossível por construção (§31.4). Se ocorrer, é bug, e o segundo é recusado.
  if (ctx.draft.state.messages.has(id)) return rj('E_ID_COLLISION');

  ctx.draft.messages().set(id, {
    author: ctx.op.author,
    ordSum: ctx.ordSum,
    authorSeq: ctx.op.authorSeq,
    hasAttachment: p.attachment !== undefined,
    reactionEmojis: new Set<string>(),
    ...(p.replyToId !== undefined ? { replyToId: p.replyToId } : {}),
  });
  if (p.attachment !== undefined && side.blobsCoreKey === undefined) {
    ctx.draft.side(ctx.origin).blobsCoreKey = p.attachment.blob.blobsCoreKey;
  }

  ctx.effects.push({
    t: 'upsert',
    table: 'dm_messages',
    key: [id],
    row: {
      id,
      ord_sum: ctx.ordSum,
      author_key: ctx.op.author,
      author_seq: ctx.op.authorSeq,
      content: content.value,
      ts: ctx.ts,
      clock_skewed: ctx.clockSkewed ? 1 : 0,
      ack_ahead: ctx.ackAhead ? 1 : 0,
      edited_at: null,
      reply_to_id: p.replyToId ?? null,
      deleted_at: null,
    },
  });
  if (p.attachment !== undefined) {
    const a = p.attachment;
    ctx.effects.push({
      t: 'upsert',
      table: 'dm_attachments',
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
  }
  // §31.16.2 — `dm.appended` é por **lote**; o projetor coalesce a faixa e é ele quem
  // acrescenta `hasIncoming`, que depende de saber qual lado é o próprio — coisa que o
  // `dmFold` deliberadamente não sabe (os dois lados são simétricos, §31.1). Mandar `author`
  // daqui era a tentativa de contornar isso, e ela não sobrevivia à agregação: o merge de um
  // lote de N mensagens ficava com o autor da última em vez do OU booleano da faixa.
  ctx.effects.push({
    t: 'notify',
    topic: 'dm.appended',
    data: {
      conversationId: ctx.dm.conversationId,
      fromOrdSum: ctx.ordSum,
      toOrdSum: ctx.ordSum,
    },
  });
  return null;
};

const dmEdit: Handler<'dm.edit'> = (ctx, p) => {
  const content = checkDmMessageContent(p.content);
  if (!content.ok) return VAL(content.field);

  const msg = ctx.draft.state.messages.get(p.messageId);
  // §31.7.4 — alvo que a ordem corrente ainda não contém é `REJECTED`. Se ele chegar depois e
  // se inserir antes, a reinterpretação de §31.13 refaz o desfecho: muda a **entrada**, não a
  // função. §31.7.4 não nomeia o código para "não existe" (só para "deletada"); `E_NOT_FOUND`
  // é o que §20.2 tem, e é o mesmo que R-8 usa no `fold`.
  if (msg === undefined) return rj('E_NOT_FOUND');
  if (msg.deletedAt !== undefined) return rj('E_MESSAGE_DELETED');
  // RD-7 — editar só a própria. Não existe moderação numa conversa direta.
  if (!msg.author.equals(ctx.op.author)) return rj('E_CANNOT_EDIT_OTHERS');

  const m = ctx.draft.mutMessage(p.messageId);
  if (m === undefined) return rj('E_NOT_FOUND');
  m.editedAt = ctx.ts;
  ctx.effects.push({
    t: 'patch',
    table: 'dm_messages',
    key: [p.messageId],
    fields: { content: content.value, edited_at: ctx.ts },
  });
  ctx.effects.push({
    t: 'notify',
    topic: 'dm.messageUpdated',
    data: { conversationId: ctx.dm.conversationId, messageId: p.messageId, fields: ['content'] },
  });
  return null;
};

const dmDelete: Handler<'dm.delete'> = (ctx, p) => {
  const msg = ctx.draft.state.messages.get(p.messageId);
  if (msg === undefined) return rj('E_NOT_FOUND');
  if (!msg.author.equals(ctx.op.author)) return rj('E_CANNOT_EDIT_OTHERS'); // RD-7
  // §31.7.4 — deletar já deletada é `APPLIED` idempotente, sem efeito.
  if (msg.deletedAt !== undefined) {
    ctx.draft.touch();
    return null;
  }

  const m = ctx.draft.mutMessage(p.messageId);
  if (m === undefined) return rj('E_NOT_FOUND');
  m.deletedAt = ctx.ts;
  m.reactionEmojis = new Set();
  m.hasAttachment = false;
  ctx.effects.push({
    t: 'patch',
    table: 'dm_messages',
    key: [p.messageId],
    // §31.12: `content` é `NULL` quando tombstonada (A26).
    fields: { content: null, deleted_at: ctx.ts },
  });
  // A mensagem morreu: as reações somem na mesma transação, sem estado zumbi (§6.9).
  ctx.effects.push({ t: 'delete', table: 'dm_reactions', key: [p.messageId] });
  // E o anexo vai junto, pela mesma razão que os links vão no `fold` da comunidade: o
  // `content` vira `NULL`, mas nome, tamanho, tipo e `hash` do arquivo são conteúdo também —
  // e `query.dmMessage` os devolvia inteiros depois da deleção, com `hasAttachment: true`.
  // A26 vale para os **bytes** no core, que continuam onde estavam; não para a projeção.
  ctx.effects.push({ t: 'delete', table: 'dm_attachments', key: [p.messageId] });
  ctx.effects.push({
    t: 'notify',
    topic: 'dm.messageUpdated',
    data: { conversationId: ctx.dm.conversationId, messageId: p.messageId, fields: ['deletedAt'] },
  });
  return null;
};

const dmReact: Handler<'dm.react'> = (ctx, p) => {
  const emoji = checkDmReactionEmoji(p.emoji);
  if (!emoji.ok) return VAL(emoji.field);

  const msg = ctx.draft.state.messages.get(p.messageId);
  // RD-8 — "`dm.react{present:false}` **nunca** é recusada", e a tabela de resolução de
  // §31.7.4 diz o desfecho: `APPLIED` idempotente, sem efeito de estado. Vale para os dois
  // alvos que não recebem reação — a mensagem deletada (que já perdeu as reações no mesmo
  // efeito do tombstone) e a que a ordem corrente ainda não contém. Testar `present` **antes**
  // do alvo é o que a regra manda: recusar aqui produziria linha em `dm_rejected_records` por
  // uma remoção que só pode convergir para "não está lá".
  if (!p.present && (msg === undefined || msg.deletedAt !== undefined)) {
    ctx.draft.touch();
    return null;
  }
  if (msg === undefined) return rj('E_NOT_FOUND');
  if (msg.deletedAt !== undefined) return rj('E_MESSAGE_DELETED'); // RD-8

  if (p.present) {
    // RD-9 — máx. 20 emojis distintos por mensagem. `present:false` **nunca** é recusada.
    if (!msg.reactionEmojis.has(emoji.value) && msg.reactionEmojis.size >= DM_MAX_REACTION_EMOJIS) {
      return rj('E_REACTION_LIMIT');
    }
    const m = ctx.draft.mutMessage(p.messageId);
    if (m === undefined) return rj('E_NOT_FOUND');
    m.reactionEmojis.add(emoji.value);
    ctx.effects.push({
      t: 'upsert',
      table: 'dm_reactions',
      key: [p.messageId, emoji.value, ctx.op.author],
      row: {
        message_id: p.messageId,
        emoji: emoji.value,
        identity_key: ctx.op.author,
        ord_sum: ctx.ordSum,
      },
    });
  } else {
    // §31.7.4 — `present:false` sem reação é `APPLIED` idempotente, sem efeito de estado.
    ctx.draft.touch();
    ctx.effects.push({
      t: 'delete',
      table: 'dm_reactions',
      key: [p.messageId, emoji.value, ctx.op.author],
    });
  }
  ctx.effects.push({
    t: 'notify',
    topic: 'dm.messageUpdated',
    data: { conversationId: ctx.dm.conversationId, messageId: p.messageId, fields: ['reactions'] },
  });
  return null;
};

// ─── Despacho ──────────────────────────────────────────────────────────────────────────

const HANDLERS = {
  [DM_KINDS['dm.hello']]: dmHello as Handler<never>,
  [DM_KINDS['dm.profile']]: dmProfile as Handler<never>,
  [DM_KINDS['dm.message']]: dmMessage as Handler<never>,
  [DM_KINDS['dm.edit']]: dmEdit as Handler<never>,
  [DM_KINDS['dm.delete']]: dmDelete as Handler<never>,
  [DM_KINDS['dm.react']]: dmReact as Handler<never>,
} as unknown as Record<number, (ctx: DmKindCtx, p: unknown) => DmRejection | null>;

/**
 * Estágios 10–12 para o `kind` do registro. `undefined` é impossível — o estágio 1 já recusou
 * `kind` fora do catálogo —, e mesmo assim falha fechado, como §9.4 faz no `fold`.
 */
export function applyDmKind(ctx: DmKindCtx, payload: unknown): DmRejection | null {
  const h = HANDLERS[ctx.op.kind];
  if (h === undefined) return rj('E_UNKNOWN_KIND');
  return h(ctx, payload);
}
