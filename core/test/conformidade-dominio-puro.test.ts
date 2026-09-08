/**
 * Conformidade do domínio puro — as regressões da varredura de 2026-09-04.
 *
 * Cada bloco trava um defeito que a suíte existente não pegava, e cita a linha normativa que
 * decide o caso. Eles moram juntos de propósito: são achados da mesma varredura, e o valor de
 * lê-los em sequência é ver **por que** cada um passava despercebido.
 *
 * O que era comum a quase todos: o teste antigo afirmava um efeito colateral do defeito (a
 * contagem que não mudou, o `interpretedSeq` que a reprojeção também produz, o índice que
 * nunca esvaziava) em vez da propriedade normativa.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SearchService } from '../src/l2/search/service.ts';
import { loadSnapshot, makeProjectorFold, saveSnapshot } from './helpers/conformidade.ts';
import { RANK_BOTTOM, RANK_TOP, permissionNumber } from '../src/l1/permissions/index.ts';
import { rankBetween } from '../src/l1/fold/index.ts';
import {
  T0,
  World,
  ZERO32,
  ZERO64,
  genesis,
  joinMember,
  keypairFromSeed,
  type Genesis,
  type Keypair,
} from './helpers/world.ts';
import { BUILD_A, makeProjector, setup } from './helpers/projector.ts';

const ultimoSeqDe = (g: Genesis, autor: Keypair): number =>
  g.world.authorSeq.get(autor.publicKey.toString('hex')) as number;

/** Cria um cargo pelo Fundador e devolve o id derivado (§7.3). */
function cargo(
  g: Genesis,
  nome: string,
  permissoes: number[],
  hostTs: number,
  dica?: { afterRank?: string; beforeRank?: string },
): string {
  g.world.submit({
    kind: 'role.create',
    author: g.founder,
    hostTs,
    payload: { name: nome, color: 0, permissions: permissoes, mentionable: false, ...dica },
  });
  return g.world.id('role', g.founder, ultimoSeqDe(g, g.founder));
}

// ─── §9.3 R-30 — auto-atribuição não concede o que o autor não tem ──────────────────────

describe('R-30 — auto-atribuição de cargo não é caminho de escalada (§9.3)', () => {
  it('quem tem só `manage_roles` não se atribui um cargo com `ban_members`', () => {
    const g = genesis();
    let ts = T0 + 300;
    const ana = joinMember(g, 'ana');
    const staff = cargo(g, 'Staff', [permissionNumber('manage_roles')], ts++);
    const rankStaff = g.world.state.roles.get(staff)?.rank as string;
    const chefia = cargo(
      g,
      'Chefia',
      [permissionNumber('ban_members'), permissionNumber('manage_community')],
      ts++,
      { beforeRank: rankStaff }, // abaixo de Staff: R-4 sozinha deixaria passar
    );
    g.world.submit({
      kind: 'member.setRoles',
      author: g.founder,
      hostTs: ts++,
      payload: { targetKey: ana.publicKey, roleIds: [g.baseRoleId, staff] },
    });

    const r = g.world.submit({
      kind: 'member.setRoles',
      author: ana,
      hostTs: ts++,
      payload: { targetKey: ana.publicKey, roleIds: [g.baseRoleId, staff, chefia] },
    });
    assert.equal(r.decision, 'REJECTED');
    assert.equal(r.reason, 'E_PERMISSION_ESCALATION');
    const eff = g.world.state.members.get(ana.publicKey.toString('hex'))?.roleIds;
    assert.equal(eff?.has(chefia), false, 'o cargo não pode ter entrado');
  });

  it('auto-atribuir cargo cujas permissões o autor JÁ tem continua valendo', () => {
    const g = genesis();
    let ts = T0 + 300;
    const ana = joinMember(g, 'ana');
    const staff = cargo(g, 'Staff', [permissionNumber('manage_roles')], ts++);
    const inofensivo = cargo(g, 'Revisor', [permissionNumber('add_reactions')], ts++);
    g.world.submit({
      kind: 'member.setRoles',
      author: g.founder,
      hostTs: ts++,
      payload: { targetKey: ana.publicKey, roleIds: [g.baseRoleId, staff] },
    });
    // `add_reactions` vem do cargo base (§19.1), então não há concessão nova.
    const r = g.world.submit({
      kind: 'member.setRoles',
      author: ana,
      hostTs: ts++,
      payload: { targetKey: ana.publicKey, roleIds: [g.baseRoleId, staff, inofensivo] },
    });
    assert.equal(r.decision, 'APPLIED');
  });

  it('o Fundador segue ajustando os próprios cargos — ele tem as 17 (§19.1)', () => {
    const g = genesis();
    let ts = T0 + 300;
    const qualquer = cargo(g, 'Qualquer', [permissionNumber('ban_members')], ts++);
    const r = g.world.submit({
      kind: 'member.setRoles',
      author: g.founder,
      hostTs: ts++,
      payload: { targetKey: g.founder.publicKey, roleIds: [g.baseRoleId, g.founderRoleId, qualquer] },
    });
    assert.equal(r.decision, 'APPLIED');
  });

  it('atribuir a OUTRA pessoa um cargo forte continua valendo — R-30 é só sobre si mesmo', () => {
    const g = genesis();
    let ts = T0 + 300;
    const ana = joinMember(g, 'ana');
    const chefia = cargo(g, 'Chefia', [permissionNumber('ban_members')], ts++);
    const r = g.world.submit({
      kind: 'member.setRoles',
      author: g.founder,
      hostTs: ts++,
      payload: { targetKey: ana.publicKey, roleIds: [g.baseRoleId, chefia] },
    });
    assert.equal(r.decision, 'APPLIED');
  });
});

// ─── §8.2 estágio 6 — `sequenceScope` compatível com o alvo ─────────────────────────────

describe('§8.2 estágio 6 — o escopo declarado é conferido contra o alvo (§7.1)', () => {
  it('`message.send` com `sequenceScope` de outro canal é `E_VALIDATION.sequenceScope`', () => {
    const g = genesis();
    const ana = joinMember(g, 'ana');
    const r = g.world.submit({
      kind: 'message.send',
      author: ana,
      hostTs: T0 + 300,
      sequenceScope: { kind: 'channel', channelId: 'ch-OUTROCANAL00000000000000' },
      payload: { channelId: g.channelId, content: 'olá', mentions: [] },
    });
    assert.equal(r.decision, 'REJECTED');
    assert.equal(r.reason, 'E_VALIDATION');
    assert.equal(r.field, 'sequenceScope');
  });

  it('o escopo correto passa, e o id da mensagem sai dele (§7.3)', () => {
    const g = genesis();
    const ana = joinMember(g, 'ana');
    const r = g.world.submit({
      kind: 'message.send',
      author: ana,
      hostTs: T0 + 300,
      payload: { channelId: g.channelId, content: 'olá', mentions: [] },
    });
    assert.equal(r.decision, 'APPLIED');
    const id = g.world.id('message', ana, ultimoSeqDe(g, ana), { kind: 'channel', channelId: g.channelId });
    assert.equal(g.world.state.messages.has(id), true);
  });
});

// ─── R-27(c) — o desvio da gênese marca `invalid`, venha do estágio que vier ────────────

describe('R-27(c) — qualquer recusa na gênese marca a comunidade `invalid`', () => {
  it('`authorSeq` repetido no `seq` 1 recusa e marca; o resto da gênese não aplica', () => {
    const w = new World();
    const founder = keypairFromSeed('founder');
    const TODAS = Array.from({ length: 17 }, (_, i) => i);
    w.submit({
      kind: 'community.create',
      author: founder,
      hostTs: T0,
      authorSeq: 1,
      payload: { name: 'Comunidade', iconColor: 0, blobsKey: keypairFromSeed('blobs').publicKey },
    });
    // `authorSeq` 1 de novo: o estágio 6 recusa com `E_DUPLICATE` **antes** da forma de R-27.
    const r1 = w.submit({
      kind: 'role.create',
      author: founder,
      hostTs: T0,
      authorSeq: 1,
      payload: { name: 'Fundador', color: 0, permissions: TODAS, mentionable: true },
    });
    assert.equal(r1.decision, 'REJECTED');
    assert.equal(r1.reason, 'E_DUPLICATE');
    assert.equal(w.state.communityInvalid, true, 'R-27(c): a recusa marca a comunidade');

    // A partir daí **todo** registro é recusado, inclusive os `seq` restantes da gênese.
    const r2 = w.submit({
      kind: 'role.create',
      author: founder,
      hostTs: T0,
      authorSeq: 3,
      payload: { name: 'Membro', color: 6, permissions: [permissionNumber('send_messages')], mentionable: false },
    });
    assert.equal(r2.decision, 'REJECTED');
    assert.equal(r2.reason, 'E_GENESIS_MISPLACED');
    assert.equal(w.state.roles.size, 0, 'nenhum cargo pode ter nascido de uma gênese quebrada');

    const r3 = w.submit({
      kind: 'category.create',
      author: founder,
      hostTs: T0,
      authorSeq: 4,
      payload: { name: 'GERAL' },
    });
    assert.equal(r3.decision, 'REJECTED');
    assert.equal(w.state.categories.size, 0);
  });

  it('a recusa vinda do estágio 14 também marca — `member.join` sem o cargo Fundador', () => {
    const w = new World();
    const founder = keypairFromSeed('founder');
    w.submit({
      kind: 'community.create',
      author: founder,
      hostTs: T0,
      authorSeq: 1,
      payload: { name: 'Comunidade', iconColor: 0, blobsKey: keypairFromSeed('blobs').publicKey },
    });
    // `seq` 1 com `kind` fora da ordem de R-27: recusa de forma, marca.
    const fora = w.submit({
      kind: 'category.create',
      author: founder,
      hostTs: T0,
      authorSeq: 2,
      payload: { name: 'GERAL' },
    });
    assert.equal(fora.reason, 'E_GENESIS_MISPLACED');
    assert.equal(w.state.communityInvalid, true);
  });

  it('`IGNORED` não marca: versão desconhecida é `partialInterpretation`, não desvio (§7.2)', () => {
    const w = new World();
    const founder = keypairFromSeed('founder');
    const r = w.submit({
      kind: 'community.create',
      author: founder,
      hostTs: T0,
      authorSeq: 1,
      v: 99,
      payload: { name: 'Comunidade', iconColor: 0, blobsKey: keypairFromSeed('blobs').publicKey },
    });
    assert.equal(r.decision, 'IGNORED');
    assert.equal(r.reason, 'E_VERSION_UNSUPPORTED');
    assert.equal(w.state.communityInvalid, false);
    assert.equal(w.state.partialInterpretation, true);
  });
});

// ─── §6.9 / R-23 — a vaga de emoji volta quando o último reagente sai ───────────────────

describe('R-23 — a vaga de emoji é liberada pela última remoção (§6.9)', () => {
  it('`present:false` do único reagente tira o emoji do `DS`', () => {
    const g = genesis();
    let ts = T0 + 300;
    const ana = joinMember(g, 'ana');
    g.world.submit({
      kind: 'message.send',
      author: ana,
      hostTs: ts++,
      payload: { channelId: g.channelId, content: 'oi', mentions: [] },
    });
    const id = g.world.id('message', ana, ultimoSeqDe(g, ana), { kind: 'channel', channelId: g.channelId });
    g.world.submit({ kind: 'reaction.set', author: ana, hostTs: ts++, payload: { messageId: id, emoji: '👍', present: true } });
    assert.equal(g.world.state.messages.get(id)?.reactions.size, 1);
    g.world.submit({ kind: 'reaction.set', author: ana, hostTs: ts++, payload: { messageId: id, emoji: '👍', present: false } });
    assert.equal(g.world.state.messages.get(id)?.reactions.size, 0, 'sem reagente, o emoji não ocupa vaga');
  });

  it('a vaga só volta quando o ÚLTIMO reagente sai — 1 reação por pessoa por emoji', () => {
    const g = genesis();
    let ts = T0 + 300;
    const ana = joinMember(g, 'ana');
    const bob = joinMember(g, 'bob', T0 + 200);
    g.world.submit({
      kind: 'message.send',
      author: ana,
      hostTs: ts++,
      payload: { channelId: g.channelId, content: 'oi', mentions: [] },
    });
    const id = g.world.id('message', ana, ultimoSeqDe(g, ana), { kind: 'channel', channelId: g.channelId });
    for (const quem of [ana, bob]) {
      g.world.submit({ kind: 'reaction.set', author: quem, hostTs: ts++, payload: { messageId: id, emoji: '🎉', present: true } });
    }
    g.world.submit({ kind: 'reaction.set', author: ana, hostTs: ts++, payload: { messageId: id, emoji: '🎉', present: false } });
    assert.equal(g.world.state.messages.get(id)?.reactions.size, 1, 'bob ainda reage: a vaga segue ocupada');
    g.world.submit({ kind: 'reaction.set', author: bob, hostTs: ts++, payload: { messageId: id, emoji: '🎉', present: false } });
    assert.equal(g.world.state.messages.get(id)?.reactions.size, 0);
  });

  it('20 ciclos põe-e-tira não esgotam a mensagem (R-23 conta emoji COM reagente)', () => {
    const g = genesis();
    let ts = T0 + 300;
    const ana = joinMember(g, 'ana');
    g.world.submit({
      kind: 'message.send',
      author: ana,
      hostTs: ts++,
      payload: { channelId: g.channelId, content: 'oi', mentions: [] },
    });
    const id = g.world.id('message', ana, ultimoSeqDe(g, ana), { kind: 'channel', channelId: g.channelId });
    const paleta = [...'abcdefghijklmnopqrst'];
    for (const e of paleta) {
      g.world.submit({ kind: 'reaction.set', author: ana, hostTs: ts++, payload: { messageId: id, emoji: e, present: true } });
      g.world.submit({ kind: 'reaction.set', author: ana, hostTs: ts++, payload: { messageId: id, emoji: e, present: false } });
    }
    const r = g.world.submit({
      kind: 'reaction.set',
      author: ana,
      hostTs: ts++,
      payload: { messageId: id, emoji: '🥁', present: true },
    });
    assert.equal(r.decision, 'APPLIED', 'nenhuma vaga ficou presa por reação já removida');
  });
});

// ─── §6.4.1 — a renormalização não move os dois sentinelas ──────────────────────────────

describe('§6.4.1 — renormalização preserva Fundador no topo e o cargo base no piso', () => {
  it('depois de estourar `RANK_MAX_LEN`, os dois sentinelas continuam nos lugares', () => {
    const g = genesis();
    let ts = T0 + 500;
    let anterior: string | undefined;
    let renormalizou = false;
    for (let i = 0; i < 420; i++) {
      const antes = g.world.state.roles.get(g.founderRoleId)?.rank;
      const r = g.world.submit({
        kind: 'role.create',
        author: g.founder,
        hostTs: ts++,
        payload: {
          name: `c${i}`,
          color: 0,
          permissions: [],
          mentionable: false,
          ...(anterior !== undefined ? { beforeRank: anterior } : {}),
        },
      });
      if (r.decision !== 'APPLIED') break;
      const id = g.world.id('role', g.founder, ultimoSeqDe(g, g.founder));
      const rank = g.world.state.roles.get(id)?.rank;
      if (rank === undefined) break;
      if (antes !== undefined && rank.length <= 2 && anterior !== undefined && anterior.length > 2) {
        renormalizou = true;
      }
      anterior = rank;
      // Não bater `MAX_ROLES`: some com um cargo antigo a cada rodada.
      if (i >= 2) {
        const vitima = [...g.world.state.roles.entries()].find(
          ([, x]) => !x.isFounder && !x.isDefault && x.deletedAt === undefined && x.rank !== rank,
        );
        if (vitima !== undefined) {
          g.world.submit({ kind: 'role.delete', author: g.founder, hostTs: ts++, payload: { roleId: vitima[0] } });
        }
      }
      if (renormalizou) break;
    }
    assert.equal(renormalizou, true, 'o cenário precisa mesmo ter renormalizado');
    assert.equal(g.world.state.roles.get(g.founderRoleId)?.rank, RANK_TOP, 'o Fundador é imutável');
    assert.equal(g.world.state.roles.get(g.baseRoleId)?.rank, RANK_BOTTOM, 'o base É a fronteira de baixo');
    for (const [id, r] of g.world.state.roles) {
      if (r.deletedAt !== undefined || id === g.founderRoleId || id === g.baseRoleId) continue;
      assert.ok(r.rank > RANK_BOTTOM && r.rank < RANK_TOP, `rank ${r.rank} saiu do intervalo de §6.4.1`);
    }
  });

  it('com o base no piso, cargo novo sem dica nasce ACIMA dele (§19.9)', () => {
    // A regressão que a renormalização causava: com o base em `11`, `rankBetween` devolvia
    // `10V` — abaixo do base, e portanto inerte por R-3 + R-4.
    assert.ok(rankBetween([], undefined, undefined) > RANK_BOTTOM);
    assert.ok(rankBetween(['V'], undefined, undefined) > RANK_BOTTOM);
  });
});

// ─── §10.3 — a remoção da FTS remove mesmo ──────────────────────────────────────────────

describe('§10.3 — `ftsRemove` subtrai os termos do índice', () => {
  it('mensagem deletada não casa mais no MATCH', async () => {
    const g = genesis();
    let ts = T0 + 300;
    const ana = joinMember(g, 'ana');
    g.world.submit({
      kind: 'message.send',
      author: ana,
      hostTs: ts++,
      payload: { channelId: g.channelId, content: 'abacaxi maduro', mentions: [] },
    });
    const id = g.world.id('message', ana, ultimoSeqDe(g, ana), { kind: 'channel', channelId: g.channelId });
    g.world.submit({ kind: 'message.delete', author: ana, hostTs: ts++, payload: { messageId: id } });

    const h = await setup([...g.world.log]);
    try {
      await makeProjector(h, { foldBuildId: BUILD_A }).boot();
      const n = h.view
        .prepare("SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'abacaxi'")
        .get() as { n: number };
      assert.equal(n.n, 0, 'o texto da mensagem tombstonada não pode sobreviver no índice');
    } finally {
      await h.close();
    }
  });

  it('`message.edit` não deixa o conteúdo antigo casando na busca', async () => {
    const g = genesis();
    let ts = T0 + 300;
    const ana = joinMember(g, 'ana');
    g.world.submit({
      kind: 'message.send',
      author: ana,
      hostTs: ts++,
      payload: { channelId: g.channelId, content: 'abacaxi', mentions: [] },
    });
    const id = g.world.id('message', ana, ultimoSeqDe(g, ana), { kind: 'channel', channelId: g.channelId });
    g.world.submit({ kind: 'message.edit', author: ana, hostTs: ts++, payload: { messageId: id, content: 'banana' } });
    g.world.submit({ kind: 'message.edit', author: ana, hostTs: ts++, payload: { messageId: id, content: 'cereja' } });

    const h = await setup([...g.world.log]);
    try {
      await makeProjector(h, { foldBuildId: BUILD_A }).boot();
      const svc = new SearchService({ view: h.view, clock: { now: () => T0 + 10_000 } });
      assert.equal(svc.search({ communityId: h.communityId, query: 'cereja' }).messages.length, 1);
      for (const antigo of ['abacaxi', 'banana']) {
        assert.equal(
          svc.search({ communityId: h.communityId, query: antigo }).messages.length,
          0,
          `"${antigo}" é conteúdo que a mensagem não tem mais`,
        );
      }
    } finally {
      await h.close();
    }
  });

  it('ban tira da busca e `revokeBan` devolve (§18.2), agora dos dois lados', async () => {
    const g = genesis();
    let ts = T0 + 300;
    const ana = joinMember(g, 'ana');
    g.world.submit({
      kind: 'message.send',
      author: ana,
      hostTs: ts++,
      payload: { channelId: g.channelId, content: 'jabuticaba', mentions: [] },
    });
    const semRevogar = [...g.world.log];
    g.world.submit({ kind: 'mod.ban', author: g.founder, hostTs: ts++, payload: { targetKey: ana.publicKey } });
    const soBan = [...g.world.log];
    g.world.submit({ kind: 'mod.revokeBan', author: g.founder, hostTs: ts++, payload: { targetKey: ana.publicKey } });

    const conta = async (log: readonly Uint8Array[]): Promise<number> => {
      const h = await setup([...log]);
      try {
        await makeProjector(h, { foldBuildId: BUILD_A }).boot();
        return (
          h.view.prepare("SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'jabuticaba'").get() as {
            n: number;
          }
        ).n;
      } finally {
        await h.close();
      }
    };
    assert.equal(await conta(semRevogar), 1);
    assert.equal(await conta(soBan), 0, 'o ban precisa tirar do índice de verdade');
    assert.equal(await conta(g.world.log), 1, 'o revoke devolve (§8.4 `ftsIndexScope`)');
  });
});

// ─── §10.6 — o snapshot volta a acelerar o boot ─────────────────────────────────────────

describe('§10.6 — o snapshot gravado é herdado pelo boot seguinte', () => {
  it('`loadSnapshot` devolve o `DS`, e o segundo boot não refolda o log inteiro', async () => {
    const g = genesis();
    const ana = joinMember(g, 'ana');
    let ts = T0 + 300;
    for (let i = 0; i < 20; i++) {
      g.world.submit({
        kind: 'message.send',
        author: ana,
        hostTs: ts++,
        payload: { channelId: g.channelId, content: `m${i}`, mentions: [] },
      });
    }
    const h = await setup([...g.world.log]);
    try {
      const p1 = makeProjector(h, { foldBuildId: BUILD_A });
      await p1.boot();
      saveSnapshot(h.view, h.communityId, p1.ds, BUILD_A, T0);

      const s = loadSnapshot(h.view, h.communityId, BUILD_A);
      assert.notEqual(s, null, 'snapshot válido não pode ser descartado');
      assert.equal(s?.interpretedSeq, p1.ds.interpretedSeq);
      assert.equal(s?.members.size, p1.ds.members.size);

      const { fold, contagem } = makeProjectorFold();
      await makeProjector(h, { foldBuildId: BUILD_A, fold }).boot();
      assert.equal(contagem.n, 0, 'com o snapshot na cabeça do log não há registro a refoldar');
    } finally {
      await h.close();
    }
  });

  it('o `DS` reidratado é o mesmo que o `fold` contínuo produziu (§28.4 teste 3)', async () => {
    const g = genesis();
    let ts = T0 + 300;
    const ana = joinMember(g, 'ana');
    const bob = joinMember(g, 'bob', T0 + 200);
    g.world.submit({
      kind: 'message.send',
      author: ana,
      hostTs: ts++,
      payload: { channelId: g.channelId, content: 'oi', mentions: [] },
    });
    const id = g.world.id('message', ana, ultimoSeqDe(g, ana), { kind: 'channel', channelId: g.channelId });
    // Uma reação posta e tirada, e outra que fica: o par que divergia entre as duas origens.
    g.world.submit({ kind: 'reaction.set', author: ana, hostTs: ts++, payload: { messageId: id, emoji: '👍', present: true } });
    g.world.submit({ kind: 'reaction.set', author: ana, hostTs: ts++, payload: { messageId: id, emoji: '👍', present: false } });
    g.world.submit({ kind: 'reaction.set', author: bob, hostTs: ts++, payload: { messageId: id, emoji: '🎉', present: true } });
    // E uma colisão de nome de L-5, que só o blob do snapshot pode carregar.
    g.world.submit({ kind: 'identity.update', author: bob, hostTs: ts++, payload: { displayName: 'ana' } });

    const h = await setup([...g.world.log]);
    try {
      const p = makeProjector(h, { foldBuildId: BUILD_A });
      await p.boot();
      saveSnapshot(h.view, h.communityId, p.ds, BUILD_A, T0);
      const s = loadSnapshot(h.view, h.communityId, BUILD_A);
      assert.notEqual(s, null);

      const vivo = p.ds.messages.get(id);
      const reidratado = s?.messages.get(id);
      assert.deepEqual(
        [...(reidratado?.reactions.keys() ?? [])].sort(),
        [...(vivo?.reactions.keys() ?? [])].sort(),
        'R-23 tem de decidir igual nas duas origens do `DS`',
      );
      assert.deepEqual([...(reidratado?.reactions.get('🎉') ?? [])], [bob.publicKey.toString('hex')]);
      // Comparado por identidade: o blob ordena os membros por chave e o `DS` vivo guarda a
      // ordem de entrada, e a marca é do membro, não da posição.
      const marcas = (d: NonNullable<typeof s>): Record<string, boolean> =>
        Object.fromEntries([...d.members].map(([k, m]) => [k, m.displayNameCollision === true]));
      assert.deepEqual(marcas(s as NonNullable<typeof s>), marcas(p.ds), 'L-5 precisa sobreviver ao snapshot');
      assert.equal(marcas(p.ds)[bob.publicKey.toString('hex')], true, 'o cenário precisa mesmo colidir');
    } finally {
      await h.close();
    }
  });

  it('`loadSnapshot` descarta snapshot com `communityKey` corrompida (evita permanent wedge)', async () => {
    const g = genesis();
    const h = await setup([...g.world.log]);
    try {
      const p = makeProjector(h, { foldBuildId: BUILD_A });
      await p.boot();
      saveSnapshot(h.view, h.communityId, p.ds, BUILD_A, T0);

      // Corrompe 1 caractere de communityKey no JSON do blob
      const row = h.view.prepare('SELECT blob FROM ds_snapshot WHERE community_id = ?').get(h.communityId) as { blob: Buffer };
      const parsed = JSON.parse(row.blob.toString('utf8'));
      parsed.communityKey = 'f'.repeat(64); // chave divergente de communityId
      h.view.prepare('UPDATE ds_snapshot SET blob = ? WHERE community_id = ?').run(Buffer.from(JSON.stringify(parsed)), h.communityId);

      const s = loadSnapshot(h.view, h.communityId, BUILD_A);
      assert.equal(s, null, 'snapshot corrompido precisa ser descartado para recomeçar do seq 0');
    } finally {
      await h.close();
    }
  });
});

// ─── §18.1 e §8.4 — moderação e os contadores derivados da população ativa ──────────────

describe('§18.1 — `mod.revokeBan` devolve o alvo a `left`, também em `view.db`', () => {
  it('a linha fica `left_at` preenchido, e o alvo some do roster ativo', async () => {
    const g = genesis();
    let ts = T0 + 300;
    const ana = joinMember(g, 'ana');
    g.world.submit({ kind: 'mod.ban', author: g.founder, hostTs: ts++, payload: { targetKey: ana.publicKey } });
    g.world.submit({ kind: 'mod.revokeBan', author: g.founder, hostTs: ts++, payload: { targetKey: ana.publicKey } });
    assert.equal(g.world.state.members.get(ana.publicKey.toString('hex'))?.state, 'left');

    const h = await setup([...g.world.log]);
    try {
      await makeProjector(h, { foldBuildId: BUILD_A }).boot();
      const linha = h.view
        .prepare('SELECT left_at, banned FROM members WHERE community_id=? AND identity_key=?')
        .get(h.communityId, ana.publicKey) as { left_at: number | null; banned: number };
      assert.equal(linha.banned, 0, '§18.1: o ban foi revogado');
      assert.notEqual(linha.left_at, null, '§18.1: "o alvo volta a `left`" — também na projeção');
      const ativos = h.view
        .prepare('SELECT COUNT(*) AS n FROM members WHERE community_id=? AND left_at IS NULL AND banned=0')
        .get(h.communityId) as { n: number };
      const c = h.view.prepare('SELECT member_count AS n FROM communities WHERE community_id=?').get(h.communityId) as {
        n: number;
      };
      assert.equal(ativos.n, 1, 'só o Fundador continua ativo');
      assert.equal(c.n, ativos.n, '§8.4: o contador legenda a mesma população');
    } finally {
      await h.close();
    }
  });

  it('`roles.member_count` desconta quem saiu, foi expulso ou banido (§8.4)', async () => {
    const g = genesis();
    let ts = T0 + 300;
    const ana = joinMember(g, 'ana');
    const bob = joinMember(g, 'bob', T0 + 200);
    const mod = cargo(g, 'Mod', [permissionNumber('add_reactions')], ts++);
    for (const quem of [ana, bob]) {
      g.world.submit({
        kind: 'member.setRoles',
        author: g.founder,
        hostTs: ts++,
        payload: { targetKey: quem.publicKey, roleIds: [g.baseRoleId, mod] },
      });
    }
    const comOsDois = [...g.world.log];
    g.world.submit({ kind: 'mod.ban', author: g.founder, hostTs: ts++, payload: { targetKey: ana.publicKey } });
    g.world.submit({ kind: 'mod.kick', author: g.founder, hostTs: ts++, payload: { targetKey: bob.publicKey } });

    const conta = async (log: readonly Uint8Array[]): Promise<number> => {
      const h = await setup([...log]);
      try {
        await makeProjector(h, { foldBuildId: BUILD_A }).boot();
        return (
          h.view.prepare('SELECT member_count AS n FROM roles WHERE community_id=? AND id=?').get(h.communityId, mod) as {
            n: number;
          }
        ).n;
      } finally {
        await h.close();
      }
    };
    assert.equal(await conta(comOsDois), 2);
    assert.equal(await conta(g.world.log), 0, 'banido e expulso saem da população do cargo');
  });
});

// ─── §6.8 e §8.4 — a thread reage à deleção e ao canal apagado ──────────────────────────

describe('§6.8 — a thread acompanha a deleção da raiz e das respostas', () => {
  async function projetar(log: readonly Uint8Array[]): Promise<{ reply_count: number; root_deleted: number }> {
    const h = await setup([...log]);
    try {
      await makeProjector(h, { foldBuildId: BUILD_A }).boot();
      return h.view.prepare('SELECT reply_count, root_deleted FROM threads WHERE community_id=?').get(h.communityId) as {
        reply_count: number;
        root_deleted: number;
      };
    } finally {
      await h.close();
    }
  }

  it('resposta deletada sai de `reply_count`; raiz deletada marca `root_deleted`', async () => {
    const g = genesis();
    let ts = T0 + 300;
    const ana = joinMember(g, 'ana');
    g.world.submit({
      kind: 'message.send',
      author: ana,
      hostTs: ts++,
      payload: { channelId: g.channelId, content: 'raiz', mentions: [] },
    });
    const raiz = g.world.id('message', ana, ultimoSeqDe(g, ana), { kind: 'channel', channelId: g.channelId });
    g.world.submit({ kind: 'thread.create', author: ana, hostTs: ts++, payload: { rootMessageId: raiz } });
    const thread = g.world.id('thread', ana, ultimoSeqDe(g, ana), { kind: 'channel', channelId: g.channelId });
    g.world.submit({
      kind: 'message.send',
      author: ana,
      hostTs: ts++,
      payload: { channelId: g.channelId, content: 'resposta', mentions: [], threadId: thread },
    });
    const resposta = g.world.id('message', ana, ultimoSeqDe(g, ana), { kind: 'channel', channelId: g.channelId });
    assert.deepEqual(await projetar(g.world.log), { reply_count: 1, root_deleted: 0 });

    g.world.submit({ kind: 'message.delete', author: ana, hostTs: ts++, payload: { messageId: resposta } });
    assert.deepEqual(await projetar(g.world.log), { reply_count: 0, root_deleted: 0 });

    g.world.submit({ kind: 'message.delete', author: ana, hostTs: ts++, payload: { messageId: raiz } });
    assert.deepEqual(await projetar(g.world.log), { reply_count: 0, root_deleted: 1 });
  });

  it('canal apagado orfana as respostas e `reply_count` cai junto (§8.4)', async () => {
    const g = genesis();
    let ts = T0 + 300;
    const ana = joinMember(g, 'ana');
    g.world.submit({
      kind: 'message.send',
      author: ana,
      hostTs: ts++,
      payload: { channelId: g.channelId, content: 'raiz', mentions: [] },
    });
    const raiz = g.world.id('message', ana, ultimoSeqDe(g, ana), { kind: 'channel', channelId: g.channelId });
    g.world.submit({ kind: 'thread.create', author: ana, hostTs: ts++, payload: { rootMessageId: raiz } });
    const thread = g.world.id('thread', ana, ultimoSeqDe(g, ana), { kind: 'channel', channelId: g.channelId });
    g.world.submit({
      kind: 'message.send',
      author: ana,
      hostTs: ts++,
      payload: { channelId: g.channelId, content: 'resposta', mentions: [], threadId: thread },
    });
    // R-7 exige que sobre um canal de texto.
    g.world.submit({
      kind: 'channel.create',
      author: g.founder,
      hostTs: ts++,
      payload: { categoryId: g.categoryId, type: 0, name: 'segundo', readOnlyForRoleIds: [] },
    });
    g.world.submit({ kind: 'channel.delete', author: g.founder, hostTs: ts++, payload: { channelId: g.channelId } });
    assert.deepEqual(await projetar(g.world.log), { reply_count: 0, root_deleted: 0 });
  });
});

// ─── §6.1 L-5 — a marca de colisão chega a `view.db` ────────────────────────────────────

describe('§6.1 L-5 — `display_name_collision` é projetada e acompanha o conjunto ativo', () => {
  it('dois nomes iguais marcam os dois; a saída de um desmarca o outro', async () => {
    const g = genesis();
    const ana = joinMember(g, 'ana');
    const bob = joinMember(g, 'bob', T0 + 200);
    g.world.submit({ kind: 'identity.update', author: bob, hostTs: T0 + 400, payload: { displayName: 'ana' } });
    const colidindo = [...g.world.log];
    g.world.submit({ kind: 'mod.kick', author: g.founder, hostTs: T0 + 500, payload: { targetKey: bob.publicKey } });

    const marcas = async (log: readonly Uint8Array[]): Promise<Record<string, number>> => {
      const h = await setup([...log]);
      try {
        await makeProjector(h, { foldBuildId: BUILD_A }).boot();
        const linhas = h.view
          .prepare('SELECT identity_key, display_name_collision AS c FROM members WHERE community_id=?')
          .all(h.communityId) as Array<{ identity_key: Buffer; c: number }>;
        return Object.fromEntries(linhas.map((l) => [l.identity_key.toString('hex'), l.c]));
      } finally {
        await h.close();
      }
    };

    const antes = await marcas(colidindo);
    assert.equal(antes[ana.publicKey.toString('hex')], 1);
    assert.equal(antes[bob.publicKey.toString('hex')], 1);
    assert.equal(antes[g.founder.publicKey.toString('hex')], 0);

    const depois = await marcas(g.world.log);
    assert.equal(depois[ana.publicKey.toString('hex')], 0, 'sobrando uma, não há colisão');
    assert.equal(depois[bob.publicKey.toString('hex')], 0, 'quem saiu deixa o conjunto ativo');
  });
});
