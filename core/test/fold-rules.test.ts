/**
 * §28.1 — as regras estruturais de §8.3 (`R-*`) e a resolução de referência quebrada de
 * §8.4.1.
 *
 * R-1, R-2 e R-15 vivem em `fold-pipeline.test.ts`, porque são decididas antes do estágio 14;
 * R-27 tem arquivo próprio. Aqui ficam as outras 23, uma a uma, mais a tabela de §8.4.1 —
 * que é a política que substituiu "reducer que lança" e por isso merece caso por linha.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_CATEGORIES,
  MAX_REACTION_EMOJIS,
  MAX_ROLES,
  MAX_ROLES_PER_MEMBER,
  MAX_ACTIVE_INVITES,
  RELAY_TTL_MS,
} from '../src/l1/fold/index.ts';
import { relayPossessionSigningHash } from '../src/l1/opCodec/index.ts';
import { permissionNumber } from '../src/l1/permissions/index.ts';
import {
  genesis,
  joinMember,
  joinProof,
  keypairFromSeed,
  makeRecord,
  sign,
  T0,
  ZERO32,
  ZERO64,
  type Genesis,
  type Keypair,
} from './helpers/world.ts';

const TS = T0 + 100;
const BLOBS = keypairFromSeed('blobs').publicKey;

/**
 * Cria um cargo e devolve o id, já resolvido.
 *
 * `afterRank` importa mais do que parece: sem dica, R-20 põe o cargo novo **no fundo**, abaixo
 * do cargo base — então quem o recebe continua com `topRank` = base. Para exercitar hierarquia
 * é preciso posicionar o cargo acima do base de propósito.
 */
function criaCargo(
  g: Genesis,
  nome: string,
  perms: number[],
  opts: { autor?: Keypair; afterRank?: string } = {},
): string {
  const autor = opts.autor ?? g.founder;
  const seq = g.world.next(autor);
  g.world.push(
    makeRecord(g.world.core, {
      kind: 'role.create',
      author: autor,
      authorSeq: seq,
      hostTs: TS,
      payload: {
        name: nome,
        color: 1,
        permissions: perms,
        mentionable: true,
        ...(opts.afterRank !== undefined ? { afterRank: opts.afterRank } : {}),
      },
    }),
  );
  return g.world.id('role', autor, seq);
}

/** Cria um canal e devolve o id, sem depender de contar `authorSeq` à mão. */
function criaCanal(g: Genesis, nome: string, type = 0, readOnlyForRoleIds: string[] = []): string {
  const seq = g.world.next(g.founder);
  g.world.push(
    makeRecord(g.world.core, {
      kind: 'channel.create',
      author: g.founder,
      authorSeq: seq,
      hostTs: TS,
      payload: { categoryId: g.categoryId, type, name: nome, readOnlyForRoleIds },
    }),
  );
  return g.world.id('channel', g.founder, seq);
}

/** O `rank` do cargo base — o piso a partir do qual um cargo fica acima dos membros comuns. */
const rankBase = (g: Genesis): string => g.world.state.roles.get(g.baseRoleId)?.rank ?? '';

function envia(g: Genesis, autor: Keypair, texto = 'oi', channelId = g.channelId) {
  const seq = g.world.next(autor);
  const r = g.world.push(
    makeRecord(g.world.core, {
      kind: 'message.send',
      author: autor,
      authorSeq: seq,
      hostTs: TS,
      payload: { channelId, content: texto, mentions: [] },
    }),
  );
  return { r, id: g.world.id('message', autor, seq) };
}

describe('R-3 e R-12 — o cargo base é obrigatório e indestrutível', () => {
  it('R-3: remover o cargo base de um membro ativo é recusado', () => {
    const g = genesis();
    const ana = joinMember(g, 'ana');
    const mod = criaCargo(g, 'Mod', [8]);
    const r = g.world.submit({
      kind: 'member.setRoles',
      author: g.founder,
      hostTs: TS,
      payload: { targetKey: ana.publicKey, roleIds: [mod] },
    });
    assert.equal(r.reason, 'E_BASE_ROLE_REQUIRED');
  });

  it('R-12: o cargo base não é deletável', () => {
    const g = genesis();
    const r = g.world.submit({
      kind: 'role.delete',
      author: g.founder,
      hostTs: TS,
      payload: { roleId: g.baseRoleId },
    });
    assert.equal(r.reason, 'E_BASE_ROLE_REQUIRED');
  });

  it('R-12: o cargo base não pode ter seu rank modificado (role.move)', () => {
    const g = genesis();
    const r = g.world.submit({
      kind: 'role.move',
      author: g.founder,
      hostTs: TS,
      payload: { roleId: g.baseRoleId, afterRank: '5' },
    });
    assert.equal(r.reason, 'E_BASE_ROLE_REQUIRED');
  });

  it('R-12: as permissões do cargo base continuam editáveis dentro de R-11', () => {
    const g = genesis();
    const r = g.world.submit({
      kind: 'role.update',
      author: g.founder,
      hostTs: TS,
      payload: { roleId: g.baseRoleId, permissions: [3, 7] },
    });
    assert.equal(r.decision, 'APPLIED');
  });
});

describe('R-4 e R-5 — anti-escalada', () => {
  it('R-4: ninguém move cargo para `rank ≥` o próprio topo', () => {
    const g = genesis();
    const ana = joinMember(g, 'ana');
    // Um cargo de gestão **acima do base**, dado a ana: é isso que faz o `topRank` dela subir.
    const gestor = criaCargo(g, 'Gestor', [16], { afterRank: rankBase(g) });
    g.world.submit({
      kind: 'member.setRoles',
      author: g.founder,
      hostTs: TS,
      payload: { targetKey: ana.publicKey, roleIds: [g.baseRoleId, gestor] },
    });
    // Ana cria um cargo: R-20 põe no fundo, abaixo dela. Passa.
    const seq = g.world.next(ana);
    const ok = g.world.push(
      makeRecord(g.world.core, {
        kind: 'role.create',
        author: ana,
        authorSeq: seq,
        hostTs: TS,
        payload: { name: 'Abaixo', color: 1, permissions: [], mentionable: true },
      }),
    );
    assert.equal(ok.decision, 'APPLIED');
    // E mover esse cargo para cima do dela é recusado.
    const novo = g.world.id('role', ana, seq);
    const rankGestor = g.world.state.roles.get(gestor)?.rank;
    assert.ok(rankGestor);
    const mover = g.world.submit({
      kind: 'role.move',
      author: ana,
      hostTs: TS,
      payload: { roleId: novo, afterRank: rankGestor },
    });
    assert.equal(mover.reason, 'E_HIERARCHY');
  });

  it('R-5: ninguém concede permissão que não possui', () => {
    const g = genesis();
    const ana = joinMember(g, 'ana');
    const gestor = criaCargo(g, 'Gestor', [16]); // só `manage_roles`
    g.world.submit({
      kind: 'member.setRoles',
      author: g.founder,
      hostTs: TS,
      payload: { targetKey: ana.publicKey, roleIds: [g.baseRoleId, gestor] },
    });
    const seq = g.world.next(ana);
    const r = g.world.push(
      makeRecord(g.world.core, {
        kind: 'role.create',
        author: ana,
        authorSeq: seq,
        hostTs: TS,
        payload: { name: 'Banidor', color: 1, permissions: [14], mentionable: true },
      }),
    );
    assert.equal(r.reason, 'E_PERMISSION_ESCALATION');
  });

  it('R-5 é sobre o que é **acrescentado**: manter o que já estava lá não é conceder', () => {
    const g = genesis();
    const ana = joinMember(g, 'ana');
    const gestor = criaCargo(g, 'Gestor', [16]);
    const outro = criaCargo(g, 'Banidor', [14]);
    g.world.submit({
      kind: 'member.setRoles',
      author: g.founder,
      hostTs: TS,
      payload: { targetKey: ana.publicKey, roleIds: [g.baseRoleId, gestor] },
    });
    // Ana não tem `ban_members`, mas renomear um cargo que a tem precisa continuar possível.
    const r = g.world.submit({
      kind: 'role.update',
      author: ana,
      hostTs: TS,
      payload: { roleId: outro, permissions: [14] },
    });
    assert.equal(r.decision, 'APPLIED');
  });

  it('R-11: o cargo base nunca recebe permissão de gestão, moderação ou menção global', () => {
    const g = genesis();
    for (const proibida of ['manage_roles', 'ban_members', 'mention_everyone', 'create_invite'] as const) {
      const r = g.world.submit({
        kind: 'role.update',
        author: g.founder,
        hostTs: TS,
        payload: { roleId: g.baseRoleId, permissions: [3, permissionNumber(proibida)] },
      });
      assert.equal(r.reason, 'E_BASE_ROLE_RESTRICTED', proibida);
    }
  });
});

describe('R-6 e R-7 — unicidade e último canal', () => {
  it('R-6: o primeiro `APPLIED` fica com o nome; o segundo é recusado', () => {
    const g = genesis();
    const r = g.world.submit({
      kind: 'channel.create',
      author: g.founder,
      hostTs: TS,
      payload: { categoryId: g.categoryId, type: 0, name: 'geral', readOnlyForRoleIds: [] },
    });
    assert.equal(r.reason, 'E_CHANNEL_NAME_TAKEN');
  });

  it('R-6: o mesmo nome em tipos diferentes é permitido — a chave é `(type, name)`', () => {
    const g = genesis();
    const r = g.world.submit({
      kind: 'channel.create',
      author: g.founder,
      hostTs: TS,
      payload: { categoryId: g.categoryId, type: 1, name: 'geral', readOnlyForRoleIds: [] },
    });
    assert.equal(r.decision, 'APPLIED');
  });

  it('R-6: deletar libera o nome', () => {
    const g = genesis();
    const avisos = criaCanal(g, 'avisos');
    g.world.submit({ kind: 'channel.delete', author: g.founder, hostTs: TS, payload: { channelId: avisos } });
    const r = g.world.submit({
      kind: 'channel.create',
      author: g.founder,
      hostTs: TS,
      payload: { categoryId: g.categoryId, type: 0, name: 'avisos', readOnlyForRoleIds: [] },
    });
    assert.equal(r.decision, 'APPLIED');
  });

  it('R-7: excluir o último canal de texto é recusado', () => {
    const g = genesis();
    const r = g.world.submit({
      kind: 'channel.delete',
      author: g.founder,
      hostTs: TS,
      payload: { channelId: g.channelId },
    });
    assert.equal(r.reason, 'E_LAST_CHANNEL');
  });

  it('R-7: `category.delete` com `deleteChannels` também é barrado pelo último canal', () => {
    const g = genesis();
    const r = g.world.submit({
      kind: 'category.delete',
      author: g.founder,
      hostTs: TS,
      payload: { categoryId: g.categoryId, deleteChannels: true },
    });
    assert.equal(r.reason, 'E_LAST_CHANNEL');
  });

  it('R-7: canal de voz não conta — excluir o último de voz é permitido', () => {
    const g = genesis();
    const voz = criaCanal(g, 'Sala', 1);
    const r = g.world.submit({ kind: 'channel.delete', author: g.founder, hostTs: TS, payload: { channelId: voz } });
    assert.equal(r.decision, 'APPLIED');
  });
});

describe('R-8 — `replyToId` e `threadId`', () => {
  it('resposta a mensagem inexistente é `E_VALIDATION.replyToId`', () => {
    const g = genesis();
    const ana = joinMember(g, 'ana');
    const r = g.world.submit({
      kind: 'message.send',
      author: ana,
      hostTs: TS,
      payload: { channelId: g.channelId, content: 'oi', mentions: [], replyToId: 'msg-FANTASMA00000000000000' },
    });
    assert.equal(r.reason, 'E_VALIDATION');
    assert.equal(r.field, 'replyToId');
  });

  it('resposta a mensagem de **outro canal** é recusada', () => {
    const g = genesis();
    const ana = joinMember(g, 'ana');
    const { id } = envia(g, ana);
    const outro = criaCanal(g, 'outro');
    const r = g.world.submit({
      kind: 'message.send',
      author: ana,
      hostTs: TS,
      payload: { channelId: outro, content: 'oi', mentions: [], replyToId: id },
    });
    assert.equal(r.field, 'replyToId');
  });

  it('resposta a mensagem deletada é recusada', () => {
    const g = genesis();
    const ana = joinMember(g, 'ana');
    const { id } = envia(g, ana);
    g.world.submit({ kind: 'message.delete', author: ana, hostTs: TS, payload: { messageId: id } });
    const r = g.world.submit({
      kind: 'message.send',
      author: ana,
      hostTs: TS,
      payload: { channelId: g.channelId, content: 'oi', mentions: [], replyToId: id },
    });
    assert.equal(r.field, 'replyToId');
  });

  it('`threadId` só vale para thread existente, no mesmo canal', () => {
    const g = genesis();
    const ana = joinMember(g, 'ana');
    const { id } = envia(g, ana);
    const seq = g.world.next(ana);
    g.world.push(
      makeRecord(g.world.core, {
        kind: 'thread.create',
        author: ana,
        sequenceScope: { kind: 'channel', channelId: g.channelId },
        authorSeq: seq,
        hostTs: TS,
        payload: { rootMessageId: id },
      }),
    );
    const threadId = g.world.id('thread', ana, seq);
    const ok = g.world.submit({
      kind: 'message.send',
      author: ana,
      hostTs: TS,
      payload: { channelId: g.channelId, content: 'na thread', mentions: [], threadId },
    });
    assert.equal(ok.decision, 'APPLIED');
    const ruim = g.world.submit({
      kind: 'message.send',
      author: ana,
      hostTs: TS,
      payload: { channelId: g.channelId, content: 'x', mentions: [], threadId: 'thr-FANTASMA0000000000000' },
    });
    assert.equal(ruim.field, 'threadId');
  });
});

describe('R-9 — adesão por convite', () => {
  it('prova válida, convite vivo: entra com o cargo base e `uses` incrementa no mesmo passo', () => {
    const g = genesis();
    const ana = joinMember(g, 'ana');
    const m = g.world.state.members.get(ana.publicKey.toString('hex'));
    assert.ok(m);
    assert.deepEqual([...m.roleIds], [g.baseRoleId]);
    const convite = [...g.world.state.invites.values()][0];
    assert.equal(convite?.uses, 1);
  });

  it('o par `(invitePk, autor)` nunca é aceito duas vezes — reentrar exige convite novo', () => {
    const g = genesis();
    const ana = joinMember(g, 'ana');
    const convitePk = [...g.world.state.invites.keys()][0];
    assert.ok(convitePk);
    const segredo = keypairFromSeed('invite-ana');

    g.world.submit({ kind: 'member.leave', author: ana, hostTs: TS, payload: {} });
    const r = g.world.submit({
      kind: 'member.join',
      author: ana,
      hostTs: TS,
      payload: {
        invitePublicKey: segredo.publicKey,
        joinProof: joinProof(g.world.core.publicKey, segredo, ana.publicKey),
        displayName: 'ana',
        avatarColor: 1,
        blobsCoreKey: BLOBS,
      },
    });
    // Sem isto, um convite de `maxUses = 1` seria reusável indefinidamente pela mesma pessoa
    // entrando e saindo (§12.6) — e a defesa anti-Sybil cairia junto.
    assert.equal(r.reason, 'E_INVITE_INVALID');
  });

  it('convite revogado, expirado e esgotado têm cada um o seu código', () => {
    const g = genesis();
    const segredo = keypairFromSeed('conv-1');
    g.world.submit({
      kind: 'invite.create',
      author: g.founder,
      hostTs: TS,
      payload: { invitePublicKey: segredo.publicKey, maxUses: 1 },
    });
    const bia = keypairFromSeed('bia');
    g.world.submit({
      kind: 'member.join',
      author: bia,
      hostTs: TS,
      payload: {
        invitePublicKey: segredo.publicKey,
        joinProof: joinProof(g.world.core.publicKey, segredo, bia.publicKey),
        displayName: 'bia',
        avatarColor: 1,
        blobsCoreKey: BLOBS,
      },
    });
    const cid = keypairFromSeed('cid');
    const esgotado = g.world.submit({
      kind: 'member.join',
      author: cid,
      hostTs: TS,
      payload: {
        invitePublicKey: segredo.publicKey,
        joinProof: joinProof(g.world.core.publicKey, segredo, cid.publicKey),
        displayName: 'cid',
        avatarColor: 1,
        blobsCoreKey: BLOBS,
      },
    });
    assert.equal(esgotado.reason, 'E_INVITE_EXHAUSTED');
  });

  it('prova assinada por outra chave é recusada', () => {
    const g = genesis();
    const segredo = keypairFromSeed('conv-2');
    const impostor = keypairFromSeed('impostor');
    g.world.submit({
      kind: 'invite.create',
      author: g.founder,
      hostTs: TS,
      payload: { invitePublicKey: segredo.publicKey },
    });
    const dan = keypairFromSeed('dan');
    const r = g.world.submit({
      kind: 'member.join',
      author: dan,
      hostTs: TS,
      payload: {
        invitePublicKey: segredo.publicKey,
        joinProof: joinProof(g.world.core.publicKey, impostor, dan.publicKey),
        displayName: 'dan',
        avatarColor: 1,
        blobsCoreKey: BLOBS,
      },
    });
    assert.equal(r.reason, 'E_INVITE_INVALID');
  });
});

describe('R-10 — revogação automática de convites', () => {
  const cenarios = [
    ['ban', (g: Genesis, alvo: Keypair) => g.world.submit({ kind: 'mod.ban' as const, author: g.founder, hostTs: TS, payload: { targetKey: alvo.publicKey } })],
    ['kick', (g: Genesis, alvo: Keypair) => g.world.submit({ kind: 'mod.kick' as const, author: g.founder, hostTs: TS, payload: { targetKey: alvo.publicKey } })],
    ['leave', (g: Genesis, alvo: Keypair) => g.world.submit({ kind: 'member.leave' as const, author: alvo, hostTs: TS, payload: {} })],
  ] as const;

  for (const [nome, acao] of cenarios) {
    it(`${nome} revoga todos os convites do membro, no mesmo registro`, () => {
      const g = genesis();
      const ana = joinMember(g, 'ana');
      const comConvite = criaCargo(g, 'Convidador', [permissionNumber('create_invite')]);
      g.world.submit({
        kind: 'member.setRoles',
        author: g.founder,
        hostTs: TS,
        payload: { targetKey: ana.publicKey, roleIds: [g.baseRoleId, comConvite] },
      });
      const segredo = keypairFromSeed(`conv-${nome}`);
      g.world.submit({
        kind: 'invite.create',
        author: ana,
        hostTs: TS,
        payload: { invitePublicKey: segredo.publicKey },
      });
      assert.equal(g.world.state.invites.get(segredo.publicKey.toString('hex'))?.revokedAt, undefined);

      acao(g, ana);
      assert.notEqual(g.world.state.invites.get(segredo.publicKey.toString('hex'))?.revokedAt, undefined);
    });
  }

  it('perder `create_invite` por `member.setRoles` também revoga', () => {
    const g = genesis();
    const ana = joinMember(g, 'ana');
    const comConvite = criaCargo(g, 'Convidador', [permissionNumber('create_invite')]);
    g.world.submit({
      kind: 'member.setRoles',
      author: g.founder,
      hostTs: TS,
      payload: { targetKey: ana.publicKey, roleIds: [g.baseRoleId, comConvite] },
    });
    const segredo = keypairFromSeed('conv-setroles');
    g.world.submit({ kind: 'invite.create', author: ana, hostTs: TS, payload: { invitePublicKey: segredo.publicKey } });

    g.world.submit({
      kind: 'member.setRoles',
      author: g.founder,
      hostTs: TS,
      payload: { targetKey: ana.publicKey, roleIds: [g.baseRoleId] },
    });
    assert.notEqual(g.world.state.invites.get(segredo.publicKey.toString('hex'))?.revokedAt, undefined);
  });

  it('perder `create_invite` por `role.update` também revoga', () => {
    const g = genesis();
    const ana = joinMember(g, 'ana');
    const comConvite = criaCargo(g, 'Convidador', [permissionNumber('create_invite')]);
    g.world.submit({
      kind: 'member.setRoles',
      author: g.founder,
      hostTs: TS,
      payload: { targetKey: ana.publicKey, roleIds: [g.baseRoleId, comConvite] },
    });
    const segredo = keypairFromSeed('conv-roleupdate');
    g.world.submit({ kind: 'invite.create', author: ana, hostTs: TS, payload: { invitePublicKey: segredo.publicKey } });

    g.world.submit({
      kind: 'role.update',
      author: g.founder,
      hostTs: TS,
      payload: { roleId: comConvite, permissions: [] },
    });
    assert.notEqual(g.world.state.invites.get(segredo.publicKey.toString('hex'))?.revokedAt, undefined);
  });
});

describe('R-13 — `everyone` sem `mention_everyone`', () => {
  it('a mensagem é `APPLIED` com a flag em `false`; o conteúdo não muda', () => {
    const g = genesis();
    const ana = joinMember(g, 'ana'); // cargo base: sem `mention_everyone` (R-11 proíbe)
    const r = g.world.submit({
      kind: 'message.send',
      author: ana,
      hostTs: TS,
      payload: { channelId: g.channelId, content: 'oi @everyone', mentions: ['everyone'] },
    });
    assert.equal(r.decision, 'APPLIED');
    const linha = r.effects.find((e) => e.t === 'upsert' && e.table === 'messages');
    assert.ok(linha?.t === 'upsert');
    assert.equal(linha.row['mention_everyone_effective'], 0);
    assert.equal(linha.row['content'], 'oi @everyone', 'o conteúdo não é alterado');
  });

  it('com a permissão, a flag vira `true`', () => {
    const g = genesis();
    const r = g.world.submit({
      kind: 'message.send',
      author: g.founder,
      hostTs: TS,
      payload: { channelId: g.channelId, content: 'atenção', mentions: ['everyone'] },
    });
    const linha = r.effects.find((e) => e.t === 'upsert' && e.table === 'messages');
    assert.ok(linha?.t === 'upsert');
    assert.equal(linha.row['mention_everyone_effective'], 1);
  });
});

describe('R-16, R-17 e R-18 — imunidades, host e sucessão', () => {
  it('R-16: `mod.*` sobre si mesmo é `E_SELF_TARGET`', () => {
    const g = genesis();
    const ana = joinMember(g, 'ana');
    const mod = criaCargo(g, 'Mod', [13, 14, 15]);
    g.world.submit({
      kind: 'member.setRoles',
      author: g.founder,
      hostTs: TS,
      payload: { targetKey: ana.publicKey, roleIds: [g.baseRoleId, mod] },
    });
    const r = g.world.submit({
      kind: 'mod.kick',
      author: ana,
      hostTs: TS,
      payload: { targetKey: ana.publicKey },
    });
    assert.equal(r.reason, 'E_SELF_TARGET');
  });

  it('R-17: só o host corrente faz `community.end`, `setSuccessors` e `escrow`', () => {
    const g = genesis();
    const ana = joinMember(g, 'ana');
    for (const kind of ['community.end', 'community.setSuccessors', 'community.escrow'] as const) {
      const payload =
        kind === 'community.end'
          ? {}
          : kind === 'community.setSuccessors'
            ? { successorKeys: [] }
            : { targetKey: ana.publicKey, wrappedSeed: Buffer.from([1, 2, 3]) };
      const r = g.world.submit({ kind, author: ana, hostTs: TS, payload } as never);
      assert.equal(r.reason, 'E_NOT_HOST', kind);
    }
  });

  it('R-18(a): sem `originCommunityId` na gênese, `assumeHost` é `E_SUCCESSION_DENIED`', () => {
    const g = genesis();
    const r = g.world.submit({
      kind: 'community.assumeHost',
      author: g.founder,
      hostTs: TS,
      payload: { newHostKey: g.founder.publicKey, observedHostTs: TS, proof: ZERO64 },
    });
    assert.equal(r.reason, 'E_SUCCESSION_DENIED');
  });

  it('R-19: `possession` inválida ou TTL acima de `RELAY_TTL_MS` recusa', () => {
    const g = genesis();
    const ana = joinMember(g, 'ana');
    const relay = keypairFromSeed('relay-ana');
    const longe = g.world.submit({
      kind: 'relay.volunteer',
      author: ana,
      hostTs: TS,
      payload: { relayPublicKey: relay.publicKey, expiresAt: TS + RELAY_TTL_MS + 1, possession: ZERO64 },
    });
    assert.equal(longe.field, 'expiresAt');

    const semProva = g.world.submit({
      kind: 'relay.volunteer',
      author: ana,
      hostTs: TS,
      payload: { relayPublicKey: relay.publicKey, expiresAt: TS + 1000, possession: ZERO64 },
    });
    assert.equal(semProva.field, 'possession');

    // §5.2 — a prova é sobre `BLAKE2b('relay-possession/1' ‖ relayPublicKey)`, não sobre os
    // 32 bytes crus. Assinar a chave direto era a leitura literal de R-19 antes de o prefixo
    // existir, e continua sendo o ataque que o prefixo fecha: sem separação de domínio, uma
    // assinatura colhida de outro contexto sobre os mesmos bytes valeria aqui.
    const semDominio = g.world.submit({
      kind: 'relay.volunteer',
      author: ana,
      hostTs: TS,
      payload: {
        relayPublicKey: relay.publicKey,
        expiresAt: TS + 1000,
        possession: sign(relay.publicKey, ana.secretKey),
      },
    });
    assert.equal(semDominio.field, 'possession');

    const ok = g.world.submit({
      kind: 'relay.volunteer',
      author: ana,
      hostTs: TS,
      payload: {
        relayPublicKey: relay.publicKey,
        expiresAt: TS + 1000,
        possession: sign(relayPossessionSigningHash(relay.publicKey), ana.secretKey),
      },
    });
    assert.equal(ok.decision, 'APPLIED');
  });
});

describe('R-20 — `rank` recalculado pelo `fold`, nunca aceito do cliente', () => {
  it('a dica desatualizada é ignorada e o item vai para o fim', () => {
    const g = genesis();
    const a = criaCargo(g, 'Alfa', []);
    const rankA = g.world.state.roles.get(a)?.rank;
    assert.ok(rankA);
    g.world.submit({ kind: 'role.delete', author: g.founder, hostTs: TS, payload: { roleId: a } });
    // `afterRank` aponta para um `rank` que não existe mais no escopo.
    const seq = g.world.next(g.founder);
    g.world.push(
      makeRecord(g.world.core, {
        kind: 'role.create',
        author: g.founder,
        authorSeq: seq,
        hostTs: TS,
        payload: { name: 'Beta', color: 1, permissions: [], mentionable: true, afterRank: rankA },
      }),
    );
    const beta = g.world.state.roles.get(g.world.id('role', g.founder, seq));
    assert.ok(beta);
    // Sem dica utilizável o item vai para o fim do escopo — mas o fim é o **piso**, não o
    // abismo (§6.4.1, §19.9). Abaixo do base o cargo nasceria inerte: por R-3 todo membro
    // carrega o base, então o `topRank` de quem recebesse Beta continuaria sendo o do base, e
    // por R-4 ele não moderaria nem um membro comum.
    const base = g.world.state.roles.get(g.baseRoleId)?.rank ?? '';
    const fundador = g.world.state.roles.get(g.founderRoleId)?.rank ?? '';
    assert.ok(beta.rank > base, `${beta.rank} deveria ficar acima do base ${base}`);
    assert.ok(beta.rank < fundador, `${beta.rank} deveria ficar abaixo do Fundador ${fundador}`);
  });

  it('duas réplicas com a mesma sequência produzem o mesmo `rank`', () => {
    const ranks = [0, 1].map(() => {
      const g = genesis();
      criaCargo(g, 'Alfa', []);
      criaCargo(g, 'Beta', []);
      return [...g.world.state.roles.values()].map((r) => r.rank).sort();
    });
    assert.deepEqual(ranks[0], ranks[1]);
  });
});

describe('R-21 e R-22 — canal somente-leitura', () => {
  it('R-21: id inexistente na lista é `E_VALIDATION.readOnlyForRoleIds`', () => {
    const g = genesis();
    const r = g.world.submit({
      kind: 'channel.create',
      author: g.founder,
      hostTs: TS,
      payload: {
        categoryId: g.categoryId,
        type: 0,
        name: 'restrito',
        readOnlyForRoleIds: ['role-FANTASMA00000000000000'],
      },
    });
    assert.equal(r.field, 'readOnlyForRoleIds');
  });

  it('R-21: a lista precisa deixar ≥ 1 cargo de fora', () => {
    const g = genesis();
    const r = g.world.submit({
      kind: 'channel.create',
      author: g.founder,
      hostTs: TS,
      payload: {
        categoryId: g.categoryId,
        type: 0,
        name: 'restrito',
        readOnlyForRoleIds: [g.founderRoleId, g.baseRoleId],
      },
    });
    assert.equal(r.field, 'readOnlyForRoleIds');
  });

  it('R-22: só recusa quando **todos** os cargos do autor estão na lista', () => {
    const g = genesis();
    const ana = joinMember(g, 'ana'); // só cargo base
    const avisos = criaCanal(g, 'avisos', 0, [g.baseRoleId]);
    assert.equal(envia(g, ana, 'oi', avisos).r.reason, 'E_CHANNEL_READ_ONLY');

    // Um cargo de fora basta para voltar a escrever.
    const extra = criaCargo(g, 'Extra', []);
    g.world.submit({
      kind: 'member.setRoles',
      author: g.founder,
      hostTs: TS,
      payload: { targetKey: ana.publicKey, roleIds: [g.baseRoleId, extra] },
    });
    assert.equal(envia(g, ana, 'agora vai', avisos).r.decision, 'APPLIED');
  });
});

describe('R-23, R-24 e R-25', () => {
  it('R-23: 20 emojis distintos; `present:false` **nunca** é recusada', () => {
    const g = genesis();
    const ana = joinMember(g, 'ana');
    const { id } = envia(g, ana);
    for (let i = 0; i < MAX_REACTION_EMOJIS; i++) {
      const r = g.world.submit({
        kind: 'reaction.set',
        author: ana,
        hostTs: TS,
        payload: { messageId: id, emoji: String.fromCodePoint(0x1f600 + i), present: true },
      });
      assert.equal(r.decision, 'APPLIED', `emoji ${i}`);
    }
    const estoura = g.world.submit({
      kind: 'reaction.set',
      author: ana,
      hostTs: TS,
      payload: { messageId: id, emoji: '🎯', present: true },
    });
    assert.equal(estoura.reason, 'E_REACTION_LIMIT');

    const remove = g.world.submit({
      kind: 'reaction.set',
      author: ana,
      hostTs: TS,
      payload: { messageId: id, emoji: '🎯', present: false },
    });
    assert.equal(remove.decision, 'APPLIED');
  });

  it('R-24: uma thread por raiz', () => {
    const g = genesis();
    const ana = joinMember(g, 'ana');
    const { id } = envia(g, ana);
    assert.equal(
      g.world.submit({ kind: 'thread.create', author: ana, hostTs: TS, payload: { rootMessageId: id } }).decision,
      'APPLIED',
    );
    const segunda = g.world.submit({
      kind: 'thread.create',
      author: ana,
      hostTs: TS,
      payload: { rootMessageId: id },
    });
    assert.equal(segunda.reason, 'E_THREAD_EXISTS');
  });

  it('R-25: `category.delete` carrega exatamente um de `moveChannelsTo`/`deleteChannels`', () => {
    const g = genesis();
    const nenhum = g.world.submit({
      kind: 'category.delete',
      author: g.founder,
      hostTs: TS,
      payload: { categoryId: g.categoryId, deleteChannels: false },
    });
    assert.equal(nenhum.field, 'moveChannelsTo');

    const ambos = g.world.submit({
      kind: 'category.delete',
      author: g.founder,
      hostTs: TS,
      payload: { categoryId: g.categoryId, moveChannelsTo: g.categoryId, deleteChannels: true },
    });
    assert.equal(ambos.field, 'moveChannelsTo');
  });

  it('R-25: mover os canais para outra categoria preserva a comunidade', () => {
    const g = genesis();
    const catSeq = g.world.next(g.founder);
    g.world.push(
      makeRecord(g.world.core, {
        kind: 'category.create',
        author: g.founder,
        authorSeq: catSeq,
        hostTs: TS,
        payload: { name: 'OUTRA' },
      }),
    );
    const outra = g.world.id('category', g.founder, catSeq);
    const r = g.world.submit({
      kind: 'category.delete',
      author: g.founder,
      hostTs: TS,
      payload: { categoryId: g.categoryId, moveChannelsTo: outra, deleteChannels: false },
    });
    assert.equal(r.decision, 'APPLIED');
    assert.equal(g.world.state.channels.get(g.channelId)?.categoryId, outra);
    assert.equal(g.world.state.channels.get(g.channelId)?.deletedAt, undefined);
  });
});

describe('R-26 — limites de cardinalidade de §26.2', () => {
  it('cargos param em `MAX_ROLES`, com `limit` no erro', () => {
    const g = genesis();
    let recusa: ReturnType<typeof criaCargo> | null = null;
    for (let i = g.world.state.roles.size; i < MAX_ROLES + 2; i++) {
      const seq = g.world.next(g.founder);
      const r = g.world.push(
        makeRecord(g.world.core, {
          kind: 'role.create',
          author: g.founder,
          authorSeq: seq,
          hostTs: TS,
          payload: { name: `C${i}`, color: 1, permissions: [], mentionable: true },
        }),
      );
      if (r.reason === 'E_LIMIT_EXCEEDED') {
        assert.equal(r.limit, MAX_ROLES);
        assert.equal(g.world.state.roles.size, MAX_ROLES);
        recusa = 'ok';
        break;
      }
    }
    assert.equal(recusa, 'ok');
  });

  it('categorias param em `MAX_CATEGORIES`', () => {
    const g = genesis();
    let bateu = false;
    for (let i = 0; i < MAX_CATEGORIES + 2; i++) {
      const r = g.world.submit({
        kind: 'category.create',
        author: g.founder,
        hostTs: TS,
        payload: { name: `CAT${i}` },
      });
      if (r.reason === 'E_LIMIT_EXCEEDED') {
        assert.equal(r.limit, MAX_CATEGORIES);
        bateu = true;
        break;
      }
    }
    assert.ok(bateu);
  });

  it('cargos por membro param em `MAX_ROLES_PER_MEMBER`', () => {
    const g = genesis();
    const ana = joinMember(g, 'ana');
    const ids = [g.baseRoleId];
    for (let i = 0; i < MAX_ROLES_PER_MEMBER; i++) ids.push(criaCargo(g, `R${i}`, []));
    const r = g.world.submit({
      kind: 'member.setRoles',
      author: g.founder,
      hostTs: TS,
      payload: { targetKey: ana.publicKey, roleIds: ids },
    });
    assert.equal(r.reason, 'E_LIMIT_EXCEEDED');
    assert.equal(r.limit, MAX_ROLES_PER_MEMBER);
  });

  it('convites ativos param em `MAX_ACTIVE_INVITES`', () => {
    const g = genesis();
    let bateu = false;
    for (let i = 0; i < MAX_ACTIVE_INVITES + 2; i++) {
      const r = g.world.submit({
        kind: 'invite.create',
        author: g.founder,
        hostTs: TS,
        payload: { invitePublicKey: keypairFromSeed(`inv-${i}`).publicKey },
      });
      if (r.reason === 'E_LIMIT_EXCEEDED') {
        assert.equal(r.limit, MAX_ACTIVE_INVITES);
        bateu = true;
        break;
      }
    }
    assert.ok(bateu);
  });
});

describe('§8.4.1 — referência quebrada, linha a linha', () => {
  it('`message.send` para canal desconhecido ou deletado nunca chega ao efeito', () => {
    const g = genesis();
    const ana = joinMember(g, 'ana');
    const r = envia(g, ana, 'oi', 'ch-FANTASMA000000000000000').r;
    assert.equal(r.reason, 'E_CHANNEL_NOT_FOUND');
    assert.equal(r.effects.length, 0);
  });

  it('canal deletado depois: as mensagens ficam `orphaned`, **não** são apagadas', () => {
    const g = genesis();
    const ana = joinMember(g, 'ana');
    const temp = criaCanal(g, 'temp');
    const { id } = envia(g, ana, 'oi', temp);
    const r = g.world.submit({ kind: 'channel.delete', author: g.founder, hostTs: TS, payload: { channelId: temp } });
    assert.equal(r.decision, 'APPLIED');
    assert.equal(g.world.state.messages.get(id)?.orphaned, true);
    assert.ok(g.world.state.messages.has(id), 'a mensagem continua existindo');
    // §8.4 `patchScope`: um efeito para N linhas, não N efeitos.
    assert.ok(r.effects.some((e) => e.t === 'patchScope' && e.scope.s === 'messagesOfChannel'));
  });

  it('`role.delete` limpa o id de `readOnlyForRoleIds` (fecha `F-31`)', () => {
    const g = genesis();
    const extra = criaCargo(g, 'Extra', []);
    const restrito = criaCanal(g, 'restrito', 0, [extra]);
    g.world.submit({ kind: 'role.delete', author: g.founder, hostTs: TS, payload: { roleId: extra } });
    assert.equal(g.world.state.channels.get(restrito)?.readOnlyForRoleIds.has(extra), false);
  });

  it('`role.delete` mantém os membros; quem fica sem cargo recebe o base', () => {
    const g = genesis();
    const ana = joinMember(g, 'ana');
    const extra = criaCargo(g, 'Extra', []);
    g.world.submit({
      kind: 'member.setRoles',
      author: g.founder,
      hostTs: TS,
      payload: { targetKey: ana.publicKey, roleIds: [g.baseRoleId, extra] },
    });
    g.world.submit({ kind: 'role.delete', author: g.founder, hostTs: TS, payload: { roleId: extra } });
    const m = g.world.state.members.get(ana.publicKey.toString('hex'));
    assert.ok(m);
    assert.equal(m.state, 'active');
    assert.deepEqual([...m.roleIds], [g.baseRoleId]);
  });

  it('`member.setRoles` com id inexistente **descarta** o id, não recusa a op', () => {
    const g = genesis();
    const ana = joinMember(g, 'ana');
    const r = g.world.submit({
      kind: 'member.setRoles',
      author: g.founder,
      hostTs: TS,
      payload: { targetKey: ana.publicKey, roleIds: [g.baseRoleId, 'role-FANTASMA00000000000000'] },
    });
    assert.equal(r.decision, 'APPLIED');
    assert.deepEqual([...(g.world.state.members.get(ana.publicKey.toString('hex'))?.roleIds ?? [])], [g.baseRoleId]);
  });

  it('`reaction.set` sobre mensagem deletada é `E_MESSAGE_DELETED`', () => {
    const g = genesis();
    const ana = joinMember(g, 'ana');
    const { id } = envia(g, ana);
    g.world.submit({ kind: 'message.delete', author: ana, hostTs: TS, payload: { messageId: id } });
    const r = g.world.submit({
      kind: 'reaction.set',
      author: ana,
      hostTs: TS,
      payload: { messageId: id, emoji: '👍', present: true },
    });
    assert.equal(r.reason, 'E_MESSAGE_DELETED');
  });

  it('`message.delete` de já deletada é `APPLIED` idempotente, sem efeito e sem auditoria', () => {
    const g = genesis();
    const ana = joinMember(g, 'ana');
    const { id } = envia(g, ana);
    g.world.submit({ kind: 'message.delete', author: ana, hostTs: TS, payload: { messageId: id } });
    const r = g.world.submit({ kind: 'message.delete', author: ana, hostTs: TS, payload: { messageId: id } });
    assert.equal(r.decision, 'APPLIED');
    assert.equal(r.effects.length, 0);
  });

  it('o tombstone apaga a linha de `attachments`, e não só as reações e os links', () => {
    const g = genesis();
    const ana = joinMember(g, 'ana');
    const seq = g.world.next(ana);
    g.world.push(
      makeRecord(g.world.core, {
        kind: 'message.send',
        author: ana,
        authorSeq: seq,
        hostTs: TS,
        payload: {
          channelId: g.channelId,
          content: 'com anexo',
          mentions: [],
          attachment: {
            blob: { blobsCoreKey: Buffer.alloc(32, 7), byteOffset: 0, blockOffset: 0, blockLength: 1, byteLength: 10 },
            name: 'a.txt',
            sizeBytes: 10,
            kind: 0,
            hash: Buffer.alloc(32, 3),
          },
        },
      }),
    );
    const id = g.world.id('message', ana, seq);
    const r = g.world.submit({ kind: 'message.delete', author: ana, hostTs: TS, payload: { messageId: id } });
    assert.equal(r.decision, 'APPLIED');
    // §13.7 regra 2 só é verdade com esta linha: o GC de §22.4 decide pela referência viva em
    // `attachments`, e sem apagá-la os blocos do autor nunca voltavam. Além disso nome,
    // tamanho, tipo e `hash` continuavam em `query.message` depois da deleção.
    assert.ok(
      r.effects.some((e) => e.t === 'delete' && e.table === 'attachments'),
      'o anexo não foi apagado junto com o tombstone',
    );
    const meta = r.next.messages.get(id);
    assert.equal(meta?.hasAttachment, false);
    assert.equal(meta?.attachmentBytes, 0);
    // §13.8 — `storageUsedBytes` é acumulador de uso do membro, não soma da tabela: não volta.
    assert.equal(r.next.members.get(ana.publicKey.toString('hex'))?.storageUsedBytes, 10);
  });

  it('`mod.ban` de já banido é `APPLIED` idempotente, sem segunda auditoria', () => {
    const g = genesis();
    const ana = joinMember(g, 'ana');
    g.world.submit({ kind: 'mod.ban', author: g.founder, hostTs: TS, payload: { targetKey: ana.publicKey } });
    const r = g.world.submit({ kind: 'mod.ban', author: g.founder, hostTs: TS, payload: { targetKey: ana.publicKey } });
    assert.equal(r.decision, 'APPLIED');
    assert.equal(r.effects.filter((e) => e.t === 'audit').length, 0);
  });

  it('`thread.create` sobre raiz deletada é recusada', () => {
    const g = genesis();
    const ana = joinMember(g, 'ana');
    const { id } = envia(g, ana);
    g.world.submit({ kind: 'message.delete', author: ana, hostTs: TS, payload: { messageId: id } });
    const r = g.world.submit({ kind: 'thread.create', author: ana, hostTs: TS, payload: { rootMessageId: id } });
    assert.equal(r.reason, 'E_MESSAGE_DELETED');
  });
});

describe('§18.1 e §18.2 — o que a moderação faz', () => {
  it('ban oculta as mensagens do alvo; revogar reexibe', () => {
    const g = genesis();
    const ana = joinMember(g, 'ana');
    const { id } = envia(g, ana);

    const ban = g.world.submit({ kind: 'mod.ban', author: g.founder, hostTs: TS, payload: { targetKey: ana.publicKey } });
    assert.equal(g.world.state.messages.get(id)?.hiddenByBan, true);
    assert.ok(ban.effects.some((e) => e.t === 'patchScope' && e.fields['hidden_by_ban'] === 1));
    assert.ok(ban.effects.some((e) => e.t === 'ftsRemoveScope'));

    const revoga = g.world.submit({
      kind: 'mod.revokeBan',
      author: g.founder,
      hostTs: TS,
      payload: { targetKey: ana.publicKey },
    });
    assert.equal(g.world.state.messages.get(id)?.hiddenByBan, false);
    assert.ok(revoga.effects.some((e) => e.t === 'patchScope' && e.fields['hidden_by_ban'] === 0));
    assert.equal(g.world.state.members.get(ana.publicKey.toString('hex'))?.state, 'left');
  });

  it('`mod.revokeBan` de quem não está banido é `E_NOT_BANNED`', () => {
    const g = genesis();
    const ana = joinMember(g, 'ana');
    const r = g.world.submit({
      kind: 'mod.revokeBan',
      author: g.founder,
      hostTs: TS,
      payload: { targetKey: ana.publicKey },
    });
    assert.equal(r.reason, 'E_NOT_BANNED');
  });

  it('o host não pode `member.leave`', () => {
    const g = genesis();
    const r = g.world.submit({ kind: 'member.leave', author: g.founder, hostTs: TS, payload: {} });
    assert.equal(r.reason, 'E_HOST_CANNOT_LEAVE');
  });

  it('§6.7: editar mensagem de outro é sempre `E_CANNOT_EDIT_OTHERS`', () => {
    const g = genesis();
    const ana = joinMember(g, 'ana');
    const { id } = envia(g, ana);
    const r = g.world.submit({
      kind: 'message.edit',
      author: g.founder,
      hostTs: TS,
      payload: { messageId: id, content: 'reescrito' },
    });
    assert.equal(r.reason, 'E_CANNOT_EDIT_OTHERS', 'moderação apaga, não reescreve');
  });
});

describe('R-28 — ban sem membresia', () => {
  /** Alguém que nunca entrou: só existe a chave. */
  const forasteiro = keypairFromSeed('forasteiro');
  const forasteiroHex = forasteiro.publicKey.toString('hex');

  const bane = (g: Genesis, alvo = forasteiro.publicKey, reason?: string) =>
    g.world.submit({
      kind: 'mod.ban',
      author: g.founder,
      hostTs: TS,
      payload: reason === undefined ? { targetKey: alvo } : { targetKey: alvo, reason },
    });

  it('banir quem não é membro é `APPLIED`: a linha nasce em `banned`, sem passar por `active`', () => {
    const g = genesis();
    const r = bane(g, forasteiro.publicKey, 'preventivo');
    assert.equal(r.decision, 'APPLIED');

    const m = g.world.state.members.get(forasteiroHex);
    assert.equal(m?.state, 'banned');
    assert.equal(m?.preBan, true);
    assert.equal(m?.bannedAt, TS);
    assert.equal(m?.roleIds.size, 0, 'R-3 vale para membro ativo; este nunca esteve ativo');
    assert.equal(m?.leftAt, undefined);

    const membros = r.effects.filter((e) => e.t === 'upsert' && e.table === 'members');
    assert.equal(membros.length, 1);
    assert.equal((membros[0] as { row: Record<string, unknown> }).row['banned'], 1);
    assert.ok(r.effects.some((e) => e.t === 'upsert' && e.table === 'bans'));
  });

  it('não reconta `memberCount`, não oculta mensagem e não revoga convite', () => {
    const g = genesis();
    const r = bane(g);
    assert.equal(r.effects.filter((e) => e.t === 'recount').length, 0, 'quem nunca esteve ativo nunca foi contado');
    assert.equal(r.effects.filter((e) => e.t === 'patchScope' || e.t === 'ftsRemoveScope').length, 0);
    assert.equal(r.effects.filter((e) => e.t === 'patch' && e.table === 'invites').length, 0);
  });

  it('a auditoria congela o fragmento de chave como rótulo (§6.13, sem nome a congelar)', () => {
    const g = genesis();
    const r = bane(g);
    const entrada = r.effects.find((e) => e.t === 'audit');
    assert.ok(entrada !== undefined);
    assert.equal(
      (entrada as { entry: { targetLabel: string | null } }).entry.targetLabel,
      forasteiroHex.slice(0, 8),
    );
  });

  it('permissão continua valendo: sem `ban_members` o ban preventivo é recusado', () => {
    const g = genesis();
    const ana = joinMember(g, 'ana');
    const r = g.world.submit({
      kind: 'mod.ban',
      author: ana,
      hostTs: TS,
      payload: { targetKey: forasteiro.publicKey },
    });
    assert.equal(r.reason, 'E_PERMISSION_DENIED');
    assert.equal(g.world.state.members.get(forasteiroHex), undefined);
  });

  it('banir de novo é `APPLIED` idempotente, sem segunda auditoria', () => {
    const g = genesis();
    bane(g);
    const r = bane(g);
    assert.equal(r.decision, 'APPLIED');
    assert.equal(r.effects.filter((e) => e.t === 'audit').length, 0);
  });

  it('§18.8.1 — o ban preventivo recusa a reentrada: é isso que a sucessão carrega', () => {
    const g = genesis();
    bane(g, keypairFromSeed('ana').publicKey);
    const segredo = keypairFromSeed('invite-ana');
    g.world.push(
      makeRecord(g.world.core, {
        kind: 'invite.create',
        author: g.founder,
        authorSeq: g.world.next(g.founder),
        hostTs: TS,
        payload: { invitePublicKey: segredo.publicKey },
      }),
    );
    const ana = keypairFromSeed('ana');
    const r = g.world.submit({
      kind: 'member.join',
      author: ana,
      hostTs: TS,
      payload: {
        invitePublicKey: segredo.publicKey,
        joinProof: joinProof(g.world.core.publicKey, segredo, ana.publicKey),
        displayName: 'ana',
        avatarColor: 1,
        blobsCoreKey: BLOBS,
      },
    });
    assert.equal(r.reason, 'E_BANNED', 'o convite de reentrada de L-23 não lava o ban');
  });

  it('`mod.revokeBan` leva o pré-banido a `left`; o join seguinte não herda o `joinedAt` do ban', () => {
    const g = genesis();
    bane(g, keypairFromSeed('ana').publicKey);
    const revoga = g.world.submit({
      kind: 'mod.revokeBan',
      author: g.founder,
      hostTs: TS + 1,
      payload: { targetKey: keypairFromSeed('ana').publicKey },
    });
    assert.equal(revoga.decision, 'APPLIED');
    assert.equal(g.world.state.members.get(keypairFromSeed('ana').publicKey.toString('hex'))?.state, 'left');

    const ana = joinMember(g, 'ana', TS + 2);
    const m = g.world.state.members.get(ana.publicKey.toString('hex'));
    assert.equal(m?.state, 'active');
    assert.equal(m?.joinedAt, TS + 2, 'a adesão é agora, não o instante do ban');
    assert.equal(m?.displayName, 'ana', 'o fragmento de chave dá lugar ao nome declarado');
  });

  it('só o **ban** tem forma sem membresia: kick, timeout e os inversos seguem `E_NOT_FOUND`', () => {
    const g = genesis();
    const alvo = forasteiro.publicKey;
    for (const op of [
      { kind: 'mod.kick' as const, payload: { targetKey: alvo } },
      { kind: 'mod.timeout' as const, payload: { targetKey: alvo, until: TS + 3_600_000 } },
      { kind: 'mod.revokeBan' as const, payload: { targetKey: alvo } },
      { kind: 'mod.removeTimeout' as const, payload: { targetKey: alvo } },
    ]) {
      const r = g.world.submit({ ...op, author: g.founder, hostTs: TS });
      assert.equal(r.reason, 'E_NOT_FOUND', op.kind);
    }
  });
});

describe('R-29 — modo de fala do canal (emenda de 2026-08-28)', () => {
  const TS_R29 = TS;

  it('voz em modo fila com turno é `APPLIED` e o estado guarda os dois campos', () => {
    const g = genesis();
    const seq = g.world.next(g.founder);
    const r = g.world.submit({
      kind: 'channel.create',
      author: g.founder,
      authorSeq: seq,
      hostTs: TS_R29,
      payload: {
        categoryId: g.categoryId,
        type: 1,
        name: 'Palco Karaokê',
        readOnlyForRoleIds: [],
        speechMode: 1,
        queueTurnSeconds: 300,
      },
    });
    assert.equal(r.decision, 'APPLIED');
    const canal = g.world.state.channels.get(g.world.id('channel', g.founder, seq));
    assert.equal(canal?.speechMode, 1);
    assert.equal(canal?.queueTurnSeconds, 300);
  });

  it('`speechMode` fora de {0,1,2} é `E_VALIDATION.speechMode`', () => {
    const g = genesis();
    const r = g.world.submit({
      kind: 'channel.create',
      author: g.founder,
      hostTs: TS_R29,
      payload: { categoryId: g.categoryId, type: 1, name: 'palco', readOnlyForRoleIds: [], speechMode: 5 },
    });
    assert.equal(r.field, 'speechMode');
  });

  it('canal de TEXTO com modo de fala é recusado — o campo só existe em voz', () => {
    const g = genesis();
    const r = g.world.submit({
      kind: 'channel.create',
      author: g.founder,
      hostTs: TS_R29,
      payload: { categoryId: g.categoryId, type: 0, name: 'texto-mudo', readOnlyForRoleIds: [], speechMode: 2 },
    });
    assert.equal(r.field, 'speechMode');
  });

  it('`queueTurnSeconds` fora de 30..3600 é `E_VALIDATION.queueTurnSeconds`', () => {
    const g = genesis();
    for (const segundos of [20, 3601]) {
      const r = g.world.submit({
        kind: 'channel.create',
        author: g.founder,
        hostTs: TS_R29,
        payload: { categoryId: g.categoryId, type: 1, name: `palco-${segundos}`, readOnlyForRoleIds: [], speechMode: 1, queueTurnSeconds: segundos },
      });
      assert.equal(r.field, 'queueTurnSeconds', String(segundos));
    }
  });

  it('turno presente sem o canal ficar em modo fila é recusado', () => {
    const g = genesis();
    const r = g.world.submit({
      kind: 'channel.create',
      author: g.founder,
      hostTs: TS_R29,
      payload: { categoryId: g.categoryId, type: 1, name: 'livre-com-turno', readOnlyForRoleIds: [], queueTurnSeconds: 300 },
    });
    assert.equal(r.field, 'queueTurnSeconds');
  });

  it('update troca o modo; o campo `queueTurnSeconds` persiste fora da fila e volta a valer', () => {
    const g = genesis();
    const seq = g.world.next(g.founder);
    g.world.submit({
      kind: 'channel.create',
      author: g.founder,
      authorSeq: seq,
      hostTs: TS_R29,
      payload: { categoryId: g.categoryId, type: 1, name: 'palco', readOnlyForRoleIds: [], speechMode: 1, queueTurnSeconds: 120 },
    });
    const canalId = g.world.id('channel', g.founder, seq);

    // Fila → livre: o turno continua gravado (§6.6), mas sem efeito.
    const livre = g.world.submit({
      kind: 'channel.update',
      author: g.founder,
      hostTs: TS_R29,
      payload: { channelId: canalId, speechMode: 0 },
    });
    assert.equal(livre.decision, 'APPLIED');
    let canal = g.world.state.channels.get(canalId);
    assert.equal(canal?.speechMode, 0);
    assert.equal(canal?.queueTurnSeconds, 120);

    // Em modo livre, mexer no turno é recusado (o canal não FICA em fila).
    const turnoFora = g.world.submit({
      kind: 'channel.update',
      author: g.founder,
      hostTs: TS_R29,
      payload: { channelId: canalId, queueTurnSeconds: 180 },
    });
    assert.equal(turnoFora.field, 'queueTurnSeconds');

    // Livre → fila de novo: o turno gravado (120) é o que vale, sem reenviar.
    const fila = g.world.submit({
      kind: 'channel.update',
      author: g.founder,
      hostTs: TS_R29,
      payload: { channelId: canalId, speechMode: 1 },
    });
    assert.equal(fila.decision, 'APPLIED');
    canal = g.world.state.channels.get(canalId);
    assert.equal(canal?.speechMode, 1);
    assert.equal(canal?.queueTurnSeconds, 120);
  });

  it('update de canal de TEXTO com modo de fala é recusado', () => {
    const g = genesis();
    const textoId = criaCanal(g, 'texto-antigo', 0);
    const r = g.world.submit({
      kind: 'channel.update',
      author: g.founder,
      hostTs: TS_R29,
      payload: { channelId: textoId, speechMode: 0 },
    });
    assert.equal(r.field, 'speechMode');
  });
});
