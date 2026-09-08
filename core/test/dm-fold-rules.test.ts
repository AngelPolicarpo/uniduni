/**
 * §31.7.4 — RD-1..RD-11, uma a uma, e as resoluções determinísticas de referência quebrada.
 *
 * Duas delas — RD-4 e RD-5 — **não recusam**: são clamps. Testá-las é testar que o registro é
 * `APPLIED` e que o estado saiu monotônico do outro lado; se um clamp virar recusa, `ordSum`
 * deixa de ser estritamente crescente e o merge de dois ponteiros de §31.6 para de valer.
 *
 * A paridade de limites com §8.6 também mora aqui: §31.7.5 é **reuso literal**, e a segunda
 * cópia das constantes (que §4 obriga) só é defensável se um teste a comparar com a primeira.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import sodium from 'sodium-native';

import { dmCorePossessionHash } from '../src/l1/dmCodec/index.ts';
import {
  DM_ATTACHMENT_MAX_BYTES,
  DM_LIMIT,
  DM_MAX_ENVELOPE_BYTES,
  DM_MAX_ENVELOPE_BYTES_ATTACHMENT,
  DM_MAX_REACTION_EMOJIS,
  DM_CLOCK_SKEW_MS,
  dmFoldRecord,
  type DmState,
} from '../src/l1/dmFold/index.ts';
import {
  ATTACHMENT_MAX_BYTES,
  CLOCK_SKEW_MS,
  LIMIT,
  MAX_ENVELOPE_BYTES,
  MAX_ENVELOPE_BYTES_ATTACHMENT,
  MAX_REACTION_EMOJIS,
} from '../src/l1/fold/index.ts';

import { DM_T0, dmHello, dmKeypair, dmRecord, dmWorld, type DmSide, type DmWorld } from './helpers/dm.ts';

function aberta(w: DmWorld): DmState {
  let s = w.state();
  s = dmFoldRecord(s, dmHello(w, w.lo), 'lo', 0, w.ctx).next;
  s = dmFoldRecord(s, dmHello(w, w.hi), 'hi', 0, w.ctx).next;
  return s;
}

/** Escreve uma mensagem e devolve `{state, id}`. */
function mensagem(
  w: DmWorld,
  s: DmState,
  side: DmSide,
  index: number,
  content: string,
  ack = 1,
): { state: DmState; id: string } {
  const r = dmFoldRecord(
    s,
    dmRecord(w, side, { kind: 'dm.message', authorSeq: index + 1, ack, payload: { content } }),
    side.origin,
    index,
    w.ctx,
  );
  assert.equal(r.decision, 'APPLIED', `mensagem ${content}: ${r.reason ?? ''}`);
  assert.ok(typeof r.messageId === 'string');
  return { state: r.next, id: r.messageId };
}

function blobref(coreKey: Buffer) {
  return { blobsCoreKey: coreKey, byteOffset: 0, blockOffset: 0, blockLength: 1, byteLength: 10 };
}

function anexo(coreKey: Buffer, sizeBytes = 10, name = 'a.png') {
  return { blob: blobref(coreKey), name, sizeBytes, kind: 0, hash: Buffer.alloc(32, 3) };
}

describe('RD-1 — gênese do lado', () => {
  it('a gênese em forma é APPLIED e vincula o coreKey do lado', () => {
    const w = dmWorld();
    const r = dmFoldRecord(w.state(), dmHello(w, w.lo), 'lo', 0, w.ctx);
    assert.equal(r.decision, 'APPLIED');
    assert.ok(r.next.sides.lo.coreKey?.equals(w.lo.core.publicKey));
    assert.equal(r.next.sides.lo.displayName, 'nome-lo');
  });

  it('peerKey que não é a outra chave do par marca o lado invalid', () => {
    const w = dmWorld();
    const estranho = dmKeypair('mallory').publicKey;
    const rec = dmRecord(w, w.lo, {
      kind: 'dm.hello',
      authorSeq: 1,
      ack: 0,
      payload: {
        peerKey: estranho,
        coreProof: Buffer.alloc(64),
        displayName: 'xx',
        avatarColor: 0,
      },
    });
    const r = dmFoldRecord(w.state(), rec, 'lo', 0, w.ctx);
    assert.equal(r.reason, 'E_GENESIS_MISPLACED');
    assert.equal(r.next.sides.lo.invalid, true);
  });

  it('coreProof inválido marca o lado invalid — o dm.hello é a prova DURÁVEL de §31.8(3)', () => {
    const w = dmWorld();
    // Prova sobre o core do OUTRO lado: assinada pela identidade certa, sobre a chave errada.
    const mentira = dmCorePossessionHash(w.conversationKey, w.hi.core.publicKey);
    const rec = dmRecord(w, w.lo, {
      kind: 'dm.hello',
      authorSeq: 1,
      ack: 0,
      payload: {
        peerKey: w.hi.identity.publicKey,
        coreProof: (() => {
          const sig = Buffer.alloc(sodium.crypto_sign_BYTES);
          sodium.crypto_sign_detached(sig, mentira, w.lo.identity.secretKey);
          return sig;
        })(),
        displayName: 'xx',
        avatarColor: 0,
      },
    });
    const r = dmFoldRecord(w.state(), rec, 'lo', 0, w.ctx);
    assert.equal(r.reason, 'E_GENESIS_MISPLACED');
    assert.equal(r.next.sides.lo.invalid, true);
  });

  it('sem a chave do core no DmContext a gênese daquele lado é recusada — não presumida', () => {
    const w = dmWorld();
    const { loCoreKey: _omitido, ...semCore } = w.ctx;
    const r = dmFoldRecord(w.state(), dmHello(w, w.lo), 'lo', 0, semCore);
    assert.equal(r.reason, 'E_GENESIS_MISPLACED');
  });

  it('invalid é absorvente POR LADO — a conversa fica legível pela metade', () => {
    const w = dmWorld();
    let s = dmFoldRecord(w.state(), dmHello(w, w.lo, { ack: 9 }), 'lo', 0, w.ctx).next;
    assert.equal(s.sides.lo.invalid, true);
    const r = dmFoldRecord(s, dmHello(w, w.hi), 'hi', 0, w.ctx);
    assert.equal(r.decision, 'APPLIED');
    assert.equal(r.next.sides.hi.invalid, false);
  });
});

describe('RD-2 — dm.hello só no índice 0', () => {
  it('fora do índice 0 é REJECTED sem marcar invalid', () => {
    const w = dmWorld();
    const s = aberta(w);
    const r = dmFoldRecord(s, dmHello(w, w.lo, { authorSeq: 2, ack: 1 }), 'lo', 1, w.ctx);
    assert.equal(r.reason, 'E_GENESIS_MISPLACED');
    assert.equal(r.next.sides.lo.invalid, false);
    // E o lado continua escrevendo depois disso.
    const depois = dmFoldRecord(
      r.next,
      dmRecord(w, w.lo, { kind: 'dm.message', authorSeq: 3, ack: 1, payload: { content: 'ok' } }),
      'lo',
      2,
      w.ctx,
    );
    assert.equal(depois.decision, 'APPLIED');
  });
});

describe('RD-3 — authorSeq = index + 1, sem exceção', () => {
  it('para cima e para baixo, os dois marcam o lado invalid', () => {
    for (const seq of [1, 3]) {
      const w = dmWorld();
      const s = aberta(w);
      const r = dmFoldRecord(
        s,
        dmRecord(w, w.lo, { kind: 'dm.message', authorSeq: seq, ack: 1, payload: { content: 'x' } }),
        'lo',
        1,
        w.ctx,
      );
      assert.equal(r.field, 'authorSeq');
      assert.equal(r.next.sides.lo.invalid, true);
    }
  });
});

describe('RD-4 — ack é não decrescente, e o clamp NÃO recusa', () => {
  it('um ack que decresceria é clampado, o registro é APPLIED, e ordSum não retrocede', () => {
    const w = dmWorld();
    let s = aberta(w);
    s = mensagem(w, s, w.lo, 1, 'a', 1).state;
    const antes = s.interpretedOrdSum;
    assert.equal(s.sides.lo.lastAck, 1);

    const r = dmFoldRecord(
      s,
      dmRecord(w, w.lo, { kind: 'dm.message', authorSeq: 3, ack: 0, payload: { content: 'b' } }),
      'lo',
      2,
      w.ctx,
    );
    assert.equal(r.decision, 'APPLIED', 'RD-4 é clamp, não recusa');
    assert.equal(r.next.sides.lo.lastAck, 1, 'clampado para o anterior');
    assert.equal(r.ordSum, 2 + 1 + 1);
    assert.ok(r.ordSum > antes, 'ordSum é estritamente crescente dentro do log');
  });

  it('o ack mentiroso NÃO é recusado — é marcado ackAhead (L-27)', () => {
    const w = dmWorld();
    const s = aberta(w);
    const r = dmFoldRecord(
      s,
      dmRecord(w, w.lo, { kind: 'dm.message', authorSeq: 2, ack: 9999, payload: { content: 'x' } }),
      'lo',
      1,
      w.ctx,
    );
    assert.equal(r.decision, 'APPLIED', 'o dano é cosmético: não há terceiro a enganar');
    assert.equal(r.ackAhead, true);
    const upsert = r.effects.find((e) => e.t === 'upsert' && e.table === 'dm_messages');
    assert.ok(upsert !== undefined && upsert.t === 'upsert');
    assert.equal(upsert.row['ack_ahead'], 1);
  });
});

describe('RD-5 — ts é não decrescente, e o clamp NÃO recusa', () => {
  it('ts retroativo é clampado e reportado em tsClamped', () => {
    const w = dmWorld();
    let s = aberta(w);
    s = dmFoldRecord(
      s,
      dmRecord(w, w.lo, { kind: 'dm.message', authorSeq: 2, ack: 1, ts: DM_T0 + 10_000, payload: { content: 'a' } }),
      'lo',
      1,
      w.ctx,
    ).next;

    const r = dmFoldRecord(
      s,
      dmRecord(w, w.lo, { kind: 'dm.message', authorSeq: 3, ack: 1, ts: DM_T0, payload: { content: 'b' } }),
      'lo',
      2,
      w.ctx,
    );
    assert.equal(r.decision, 'APPLIED', 'RD-5 é clamp, não recusa');
    assert.equal(r.tsClamped, true);
    assert.equal(r.next.sides.lo.lastTs, DM_T0 + 10_000);
    const upsert = r.effects.find((e) => e.t === 'upsert' && e.table === 'dm_messages');
    assert.ok(upsert !== undefined && upsert.t === 'upsert');
    assert.equal(upsert.row['ts'], DM_T0 + 10_000, 'o ts gravado é o clampado');
  });

  it('§31.6 — nenhum registro é recusado por causa de ts, por mais absurdo que ele seja', () => {
    const w = dmWorld();
    const s = aberta(w);
    for (const ts of [0, 1, DM_T0 - 10 * 365 * 24 * 3600_000, DM_T0 + 10 * 365 * 24 * 3600_000]) {
      const r = dmFoldRecord(
        s,
        dmRecord(w, w.lo, { kind: 'dm.message', authorSeq: 2, ack: 1, ts, payload: { content: 'x' } }),
        'lo',
        1,
        w.ctx,
      );
      assert.equal(r.decision, 'APPLIED', `ts=${ts} não pode destruir a conversa`);
    }
  });

  it('clockSkewed marca a impossibilidade CAUSAL, não uma janela de relógio', () => {
    const w = dmWorld();
    let s = w.state();
    // `lo` abre com ts alto; `hi` abre depois e escreve reconhecendo lo, com ts MENOR.
    s = dmFoldRecord(s, dmHello(w, w.lo, { ts: DM_T0 + 100_000 }), 'lo', 0, w.ctx).next;
    s = dmFoldRecord(s, dmHello(w, w.hi, { ts: DM_T0 + 100_000 }), 'hi', 0, w.ctx).next;
    // hi no índice 1 reconhece o índice 0 de lo (ack = 1) com um ts anterior ao dele.
    const r = dmFoldRecord(
      s,
      dmRecord(w, w.hi, { kind: 'dm.message', authorSeq: 2, ack: 1, ts: DM_T0, payload: { content: 'x' } }),
      'hi',
      1,
      w.ctx,
    );
    assert.equal(r.decision, 'APPLIED');
    assert.equal(
      r.clockSkewed,
      undefined,
      'o clamp de RD-5 já subiu o ts para o do próprio lado: não sobra impossibilidade a marcar',
    );

    // Agora o caso real: o lado que reconhece tem o próprio ts baixo.
    const w2 = dmWorld();
    let s2 = w2.state();
    s2 = dmFoldRecord(s2, dmHello(w2, w2.lo, { ts: DM_T0 + 100_000 }), 'lo', 0, w2.ctx).next;
    s2 = dmFoldRecord(s2, dmHello(w2, w2.hi, { ts: DM_T0 }), 'hi', 0, w2.ctx).next;
    const r2 = dmFoldRecord(
      s2,
      dmRecord(w2, w2.hi, { kind: 'dm.message', authorSeq: 2, ack: 1, ts: DM_T0 + 1, payload: { content: 'x' } }),
      'hi',
      1,
      w2.ctx,
    );
    assert.equal(r2.decision, 'APPLIED');
    assert.equal(r2.clockSkewed, true, 'reconhece um registro cujo ts é MAIOR que o próprio');
  });
});

describe('RD-6 — chave de core imutável por lado', () => {
  it('o coreKey vem de RD-1 e nada depois o troca', () => {
    const w = dmWorld();
    let s = aberta(w);
    const fixado = s.sides.lo.coreKey;
    assert.ok(fixado !== undefined && fixado.equals(w.lo.core.publicKey));
    // Um segundo `dm.hello` anunciando outra coisa é RD-2 antes de ser qualquer outra coisa.
    s = dmFoldRecord(s, dmHello(w, w.lo, { authorSeq: 2, ack: 1 }), 'lo', 1, w.ctx).next;
    assert.ok(s.sides.lo.coreKey?.equals(fixado));
  });
});

describe('RD-7 — edição e deleção são só do próprio', () => {
  it('editar mensagem do outro é E_CANNOT_EDIT_OTHERS', () => {
    const w = dmWorld();
    let s = aberta(w);
    const m = mensagem(w, s, w.lo, 1, 'minha');
    s = m.state;
    const r = dmFoldRecord(
      s,
      dmRecord(w, w.hi, { kind: 'dm.edit', authorSeq: 2, ack: 2, payload: { messageId: m.id, content: 'roubada' } }),
      'hi',
      1,
      w.ctx,
    );
    assert.equal(r.reason, 'E_CANNOT_EDIT_OTHERS');
  });

  it('deletar mensagem do outro é E_CANNOT_EDIT_OTHERS — não existe moderação', () => {
    const w = dmWorld();
    let s = aberta(w);
    const m = mensagem(w, s, w.lo, 1, 'minha');
    s = m.state;
    const r = dmFoldRecord(
      s,
      dmRecord(w, w.hi, { kind: 'dm.delete', authorSeq: 2, ack: 2, payload: { messageId: m.id } }),
      'hi',
      1,
      w.ctx,
    );
    assert.equal(r.reason, 'E_CANNOT_EDIT_OTHERS');
  });

  it('a própria é editável e deletável, e a deleção é tombstone (content NULL)', () => {
    const w = dmWorld();
    let s = aberta(w);
    const m = mensagem(w, s, w.lo, 1, 'minha');
    s = m.state;
    const ed = dmFoldRecord(
      s,
      dmRecord(w, w.lo, { kind: 'dm.edit', authorSeq: 3, ack: 1, payload: { messageId: m.id, content: 'nova' } }),
      'lo',
      2,
      w.ctx,
    );
    assert.equal(ed.decision, 'APPLIED');
    s = ed.next;
    const del = dmFoldRecord(
      s,
      dmRecord(w, w.lo, { kind: 'dm.delete', authorSeq: 4, ack: 1, payload: { messageId: m.id } }),
      'lo',
      3,
      w.ctx,
    );
    assert.equal(del.decision, 'APPLIED');
    const patch = del.effects.find((e) => e.t === 'patch' && e.table === 'dm_messages');
    assert.ok(patch !== undefined && patch.t === 'patch');
    assert.equal(patch.fields['content'], null);
    assert.ok(del.effects.some((e) => e.t === 'delete' && e.table === 'dm_reactions'));
  });
});

describe('RD-8 — alvo existente e vivo', () => {
  it('replyToId inexistente é E_NOT_FOUND (§31.7.4 emenda 2026-09-05)', () => {
    const w = dmWorld();
    const s = aberta(w);
    const r = dmFoldRecord(
      s,
      dmRecord(w, w.lo, {
        kind: 'dm.message',
        authorSeq: 2,
        ack: 1,
        payload: { content: 'oi', replyToId: 'dmsg-NAOEXISTE0000000000000' },
      }),
      'lo',
      1,
      w.ctx,
    );
    assert.equal(r.reason, 'E_NOT_FOUND');
  });

  it('replyToId sobre mensagem deletada é E_MESSAGE_DELETED', () => {
    const w = dmWorld();
    let s = aberta(w);
    const m = mensagem(w, s, w.lo, 1, 'x');
    s = dmFoldRecord(
      m.state,
      dmRecord(w, w.lo, { kind: 'dm.delete', authorSeq: 3, ack: 1, payload: { messageId: m.id } }),
      'lo',
      2,
      w.ctx,
    ).next;

    const r = dmFoldRecord(
      s,
      dmRecord(w, w.hi, {
        kind: 'dm.message',
        authorSeq: 2,
        ack: 3,
        payload: { content: 'resposta', replyToId: m.id },
      }),
      'hi',
      1,
      w.ctx,
    );
    assert.equal(r.reason, 'E_MESSAGE_DELETED');
  });

  it('edit e react sobre mensagem deletada são E_MESSAGE_DELETED', () => {
    const w = dmWorld();
    let s = aberta(w);
    const m = mensagem(w, s, w.lo, 1, 'x');
    s = dmFoldRecord(
      m.state,
      dmRecord(w, w.lo, { kind: 'dm.delete', authorSeq: 3, ack: 1, payload: { messageId: m.id } }),
      'lo',
      2,
      w.ctx,
    ).next;

    const ed = dmFoldRecord(
      s,
      dmRecord(w, w.lo, { kind: 'dm.edit', authorSeq: 4, ack: 1, payload: { messageId: m.id, content: 'z' } }),
      'lo',
      3,
      w.ctx,
    );
    assert.equal(ed.reason, 'E_MESSAGE_DELETED');
    const re = dmFoldRecord(
      s,
      dmRecord(w, w.hi, { kind: 'dm.react', authorSeq: 2, ack: 3, payload: { messageId: m.id, emoji: '👍', present: true } }),
      'hi',
      1,
      w.ctx,
    );
    assert.equal(re.reason, 'E_MESSAGE_DELETED');
  });

  it('deletar já deletada é APPLIED idempotente, sem efeito', () => {
    const w = dmWorld();
    const m = mensagem(w, aberta(w), w.lo, 1, 'x');
    const s = dmFoldRecord(
      m.state,
      dmRecord(w, w.lo, { kind: 'dm.delete', authorSeq: 3, ack: 1, payload: { messageId: m.id } }),
      'lo',
      2,
      w.ctx,
    ).next;
    const r = dmFoldRecord(
      s,
      dmRecord(w, w.lo, { kind: 'dm.delete', authorSeq: 4, ack: 1, payload: { messageId: m.id } }),
      'lo',
      3,
      w.ctx,
    );
    assert.equal(r.decision, 'APPLIED');
    assert.equal(r.effects.length, 0, 'idempotente: sem efeito nenhum');
  });

  it('react present:false sobre mensagem DELETADA é APPLIED, nunca E_MESSAGE_DELETED', () => {
    const w = dmWorld();
    const m = mensagem(w, aberta(w), w.lo, 1, 'x');
    const s = dmFoldRecord(
      m.state,
      dmRecord(w, w.lo, { kind: 'dm.delete', authorSeq: 3, ack: 1, payload: { messageId: m.id } }),
      'lo',
      2,
      w.ctx,
    ).next;
    // RD-8 diz "`dm.react{present:false}` **nunca** é recusada", sem exceção para o alvo
    // tombstonado — e a tabela de §31.7.4 dá o desfecho: `APPLIED` idempotente, sem efeito.
    const r = dmFoldRecord(
      s,
      dmRecord(w, w.hi, { kind: 'dm.react', authorSeq: 2, ack: 3, payload: { messageId: m.id, emoji: '👍', present: false } }),
      'hi',
      1,
      w.ctx,
    );
    assert.equal(r.decision, 'APPLIED');
    assert.equal(r.reason, undefined);
    assert.equal(r.effects.length, 0, 'a mensagem já perdeu as reações no tombstone');
  });

  it('react present:false sobre alvo que a ordem corrente não contém é APPLIED', () => {
    const w = dmWorld();
    const r = dmFoldRecord(
      aberta(w),
      dmRecord(w, w.hi, {
        kind: 'dm.react',
        authorSeq: 2,
        ack: 1,
        payload: { messageId: 'dmsg-NAOEXISTE0000000000000', emoji: '👍', present: false },
      }),
      'hi',
      1,
      w.ctx,
    );
    assert.equal(r.decision, 'APPLIED');
    assert.equal(r.effects.length, 0);
  });

  it('react present:false sem reação é APPLIED idempotente', () => {
    const w = dmWorld();
    let s = aberta(w);
    const m = mensagem(w, s, w.lo, 1, 'x');
    const r = dmFoldRecord(
      m.state,
      dmRecord(w, w.hi, { kind: 'dm.react', authorSeq: 2, ack: 2, payload: { messageId: m.id, emoji: '👍', present: false } }),
      'hi',
      1,
      w.ctx,
    );
    assert.equal(r.decision, 'APPLIED');
    assert.equal(r.reason, undefined);
  });
});

describe('RD-9 — máximo de emojis distintos por mensagem', () => {
  it('o 21º emoji distinto com present:true é E_REACTION_LIMIT; present:false nunca recusa', () => {
    const w = dmWorld();
    let s = aberta(w);
    const m = mensagem(w, s, w.lo, 1, 'x');
    s = m.state;
    const emojis = Array.from({ length: DM_MAX_REACTION_EMOJIS + 1 }, (_, i) =>
      String.fromCodePoint(0x1f600 + i),
    );
    let idx = 1;
    for (const [i, e] of emojis.entries()) {
      const r = dmFoldRecord(
        s,
        dmRecord(w, w.hi, {
          kind: 'dm.react',
          authorSeq: idx + 1,
          ack: 2,
          payload: { messageId: m.id, emoji: e, present: true },
        }),
        'hi',
        idx,
        w.ctx,
      );
      if (i < DM_MAX_REACTION_EMOJIS) assert.equal(r.decision, 'APPLIED');
      else assert.equal(r.reason, 'E_REACTION_LIMIT');
      s = r.next;
      idx++;
    }
    const remocao = dmFoldRecord(
      s,
      dmRecord(w, w.hi, {
        kind: 'dm.react',
        authorSeq: idx + 1,
        ack: 2,
        payload: { messageId: m.id, emoji: emojis[emojis.length - 1] ?? '', present: false },
      }),
      'hi',
      idx,
      w.ctx,
    );
    assert.equal(remocao.decision, 'APPLIED', 'present:false nunca é recusada');
  });
});

describe('RD-10 — último a escrever vence, por ordKey, nunca por ts', () => {
  it('duas edições concorrentes convergem para a de maior ordKey, com o ts invertido', () => {
    const w = dmWorld();
    let s = aberta(w);
    const m = mensagem(w, s, w.lo, 1, 'original');
    s = m.state;
    // Duas edições do MESMO autor (RD-7), a segunda com ts MENOR que a primeira.
    s = dmFoldRecord(
      s,
      dmRecord(w, w.lo, { kind: 'dm.edit', authorSeq: 3, ack: 1, ts: DM_T0 + 5000, payload: { messageId: m.id, content: 'A' } }),
      'lo',
      2,
      w.ctx,
    ).next;
    const r = dmFoldRecord(
      s,
      dmRecord(w, w.lo, { kind: 'dm.edit', authorSeq: 4, ack: 1, ts: DM_T0, payload: { messageId: m.id, content: 'B' } }),
      'lo',
      3,
      w.ctx,
    );
    assert.equal(r.decision, 'APPLIED');
    const patch = r.effects.find((e) => e.t === 'patch' && e.table === 'dm_messages');
    assert.ok(patch !== undefined && patch.t === 'patch');
    assert.equal(patch.fields['content'], 'B', 'ganha o maior ordKey, não o maior ts');
  });

  it('dm.profile converge pelo último aplicado na ordem canônica', () => {
    const w = dmWorld();
    let s = aberta(w);
    s = dmFoldRecord(
      s,
      dmRecord(w, w.lo, { kind: 'dm.profile', authorSeq: 2, ack: 1, payload: { displayName: 'primeiro' } }),
      'lo',
      1,
      w.ctx,
    ).next;
    s = dmFoldRecord(
      s,
      dmRecord(w, w.lo, { kind: 'dm.profile', authorSeq: 3, ack: 1, payload: { displayName: 'segundo' } }),
      'lo',
      2,
      w.ctx,
    ).next;
    assert.equal(s.sides.lo.displayName, 'segundo');
  });
});

describe('RD-11 — anexo é do autor', () => {
  it('o primeiro anexo vincula o core de blobs do lado', () => {
    const w = dmWorld();
    const s = aberta(w);
    const r = dmFoldRecord(
      s,
      dmRecord(w, w.lo, {
        kind: 'dm.message',
        authorSeq: 2,
        ack: 1,
        payload: { content: 'com anexo', attachment: anexo(w.lo.blobs.publicKey) },
      }),
      'lo',
      1,
      w.ctx,
    );
    assert.equal(r.decision, 'APPLIED');
    assert.ok(r.next.sides.lo.blobsCoreKey?.equals(w.lo.blobs.publicKey));
    assert.ok(r.effects.some((e) => e.t === 'upsert' && e.table === 'dm_attachments'));
  });

  it('o tombstone apaga a linha de `dm_attachments`, e não só as reações', () => {
    const w = dmWorld();
    const comAnexo = dmFoldRecord(
      aberta(w),
      dmRecord(w, w.lo, {
        kind: 'dm.message',
        authorSeq: 2,
        ack: 1,
        payload: { content: 'a', attachment: anexo(w.lo.blobs.publicKey) },
      }),
      'lo',
      1,
      w.ctx,
    );
    const id = comAnexo.messageId as string;
    const r = dmFoldRecord(
      comAnexo.next,
      dmRecord(w, w.lo, { kind: 'dm.delete', authorSeq: 3, ack: 1, payload: { messageId: id } }),
      'lo',
      2,
      w.ctx,
    );
    assert.equal(r.decision, 'APPLIED');
    // Nome, tamanho, tipo e `hash` são conteúdo tanto quanto o texto: `content` vira `NULL` e
    // eles ficavam inteiros na projeção, com `query.dmMessage` devolvendo `hasAttachment`.
    assert.ok(
      r.effects.some((e) => e.t === 'delete' && e.table === 'dm_attachments'),
      'o anexo não foi apagado junto com o tombstone',
    );
    assert.equal(r.next.messages.get(id)?.hasAttachment, false);
  });

  it('um anexo posterior apontando para outro core é E_VALIDATION.attachment', () => {
    const w = dmWorld();
    let s = aberta(w);
    s = dmFoldRecord(
      s,
      dmRecord(w, w.lo, {
        kind: 'dm.message',
        authorSeq: 2,
        ack: 1,
        payload: { content: 'a', attachment: anexo(w.lo.blobs.publicKey) },
      }),
      'lo',
      1,
      w.ctx,
    ).next;
    const r = dmFoldRecord(
      s,
      dmRecord(w, w.lo, {
        kind: 'dm.message',
        authorSeq: 3,
        ack: 1,
        payload: { content: 'b', attachment: anexo(w.hi.blobs.publicKey) },
      }),
      'lo',
      2,
      w.ctx,
    );
    assert.equal(r.reason, 'E_VALIDATION');
    assert.equal(r.field, 'attachment');
  });

  it('sizeBytes acima do teto de representação nem chega ao estágio: `E_MALFORMED` no decode', () => {
    const w = dmWorld();
    const s = aberta(w);
    const grande = dmFoldRecord(
      s,
      dmRecord(w, w.lo, {
        kind: 'dm.message',
        authorSeq: 2,
        ack: 1,
        payload: { content: 'a', attachment: anexo(w.lo.blobs.publicKey, DM_ATTACHMENT_MAX_BYTES + 1) },
      }),
      'lo',
      1,
      w.ctx,
    );
    // Emenda de 2026-09-04: com `DM_ATTACHMENT_MAX_BYTES = 2^53−1`, o teto do `dmFold` passou
    // a coincidir com o do leitor de `u64` (`Reader.u64` liga `failed` acima de
    // `MAX_SAFE_INTEGER`). `E_ATTACHMENT_TOO_LARGE` deixou de ser alcançável pelo fio: quem
    // recusa primeiro é o decode. A checagem do estágio permanece porque o `dmFold` é total e
    // não pode depender de quem o chamou ter decodificado.
    assert.equal(grande.reason, 'E_MALFORMED');

    const nome = dmFoldRecord(
      s,
      dmRecord(w, w.lo, {
        kind: 'dm.message',
        authorSeq: 2,
        ack: 1,
        payload: { content: 'a', attachment: anexo(w.lo.blobs.publicKey, 10, '../etc/passwd') },
      }),
      'lo',
      1,
      w.ctx,
    );
    assert.equal(nome.reason, 'E_VALIDATION');
    assert.equal(nome.field, 'name', '§31.7.5: rejeita, não sanitiza');
  });
});

describe('§31.7.5 — reuso literal de §8.6, conferido contra a fonte', () => {
  it('todo limite de campo tem o mesmo valor do `fold`', () => {
    assert.deepEqual(DM_LIMIT.displayName, LIMIT.displayName);
    assert.deepEqual(DM_LIMIT.messageContent, LIMIT.messageContent);
    assert.deepEqual(DM_LIMIT.reactionEmoji, LIMIT.reactionEmoji);
    assert.deepEqual(DM_LIMIT.attachmentName, LIMIT.attachmentName);
  });

  it('todo teto de protocolo tem o mesmo valor do `fold`', () => {
    assert.equal(DM_MAX_ENVELOPE_BYTES, MAX_ENVELOPE_BYTES);
    assert.equal(DM_MAX_ENVELOPE_BYTES_ATTACHMENT, MAX_ENVELOPE_BYTES_ATTACHMENT);
    assert.equal(DM_ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_BYTES);
    assert.equal(DM_MAX_REACTION_EMOJIS, MAX_REACTION_EMOJIS);
    assert.equal(DM_CLOCK_SKEW_MS, CLOCK_SKEW_MS);
  });
});
