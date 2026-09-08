/**
 * Testes de regressão cobrindo os achados de auditoria e lacunas de especificação:
 * 1. member.join após member.leave limpa member_roles antigos na view.db e desconta contadores
 * 2. category.delete com moveChannelsTo inexistente devolve E_VALIDATION.moveChannelsTo
 * 3. member.setRoles sobre Fundador por terceiros devolve E_FOUNDER_IMMUNE (e E_HOST_IMMUNE para host)
 * 4. message.edit em mensagem órfã não reinsere termos na messages_fts
 * 5. Colisão L-5 com Unicode Full Case Folding (ex: 'straße' vs 'STRASSE', 'waſſer' vs 'WASSER')
 * 6. mod.removeTimeout sem timeout ativo é APPLIED silencioso sem efeitos nem auditoria (§21.2, §8.4.1)
 * 7. relay.withdraw sem voluntariado por membro ativo é APPLIED silencioso (§21.2); não-membro segue E_NOT_MEMBER
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { permissionNumber } from '../src/l1/permissions/index.ts';
import {
  genesis,
  joinMember,
  joinProof,
  keypairFromSeed,
  makeRecord,
  type Genesis,
  type Keypair,
} from './helpers/world.ts';
import { BUILD_A, makeProjector, setup } from './helpers/projector.ts';

const TS = 1_755_000_000_000;

function criaCargo(
  g: Genesis,
  nome: string,
  perms: number[],
  opts: { autor?: Keypair; afterRank?: string } = {},
): string {
  const autor = opts.autor ?? g.founder;
  const seq = g.world.next(autor);
  const rec = makeRecord(g.world.core, {
    kind: 'role.create',
    author: autor,
    authorSeq: seq,
    hostTs: TS,
    payload: {
      name: nome,
      color: 0xff0000,
      permissions: perms,
      mentionable: false,
      afterRank: opts.afterRank ?? g.founderRoleId,
    },
  });
  const res = g.world.push(rec);
  assert.equal(res.decision, 'APPLIED');
  return g.world.id('role', autor, seq);
}

describe('Correções de Auditoria e Especificação (Regressão)', () => {
  it('1. member.join após member.leave limpa cargos antigos na view.db e desconta contadores', async () => {
    const g = genesis();
    const modRoleId = criaCargo(g, 'Moderador', [permissionNumber('kick_members')]);

    const ana = joinMember(g, 'ana');
    const anaHex = ana.publicKey.toString('hex');

    // Fundador atribui Moderador + Base para Ana
    const rSet = g.world.submit({
      kind: 'member.setRoles',
      author: g.founder,
      hostTs: TS + 10,
      payload: {
        targetKey: ana.publicKey,
        roleIds: [modRoleId, g.baseRoleId],
      },
    });
    assert.equal(rSet.decision, 'APPLIED');

    // Ana sai da comunidade (member.leave)
    const rLeave = g.world.submit({
      kind: 'member.leave',
      author: ana,
      hostTs: TS + 20,
      payload: {},
    });
    assert.equal(rLeave.decision, 'APPLIED');

    // Ana reingressa com novo convite (member.join com mesma chave da Ana, mas convite inédito)
    const segredoRejoin = keypairFromSeed('convite-novo-ana');
    const conviteSeq = g.world.next(g.founder);
    g.world.push(
      makeRecord(g.world.core, {
        kind: 'invite.create',
        author: g.founder,
        authorSeq: conviteSeq,
        hostTs: TS + 25,
        payload: { invitePublicKey: segredoRejoin.publicKey },
      }),
    );
    const rRejoin = g.world.submit({
      kind: 'member.join',
      author: ana,
      hostTs: TS + 30,
      payload: {
        invitePublicKey: segredoRejoin.publicKey,
        joinProof: joinProof(g.world.core.publicKey, segredoRejoin, ana.publicKey),
        displayName: 'Ana',
        avatarColor: 1,
        blobsCoreKey: keypairFromSeed('mb-ana').publicKey,
      },
    });
    assert.equal(rRejoin.decision, 'APPLIED');

    // Projeta o log na view.db
    const h = await setup(g.world.log);
    try {
      const p = makeProjector(h, { foldBuildId: BUILD_A });
      await p.boot();

      // Ana na view.db só deve ter o cargo base em member_roles (1 linha)
      const rows = h.view
        .prepare('SELECT role_id FROM member_roles WHERE community_id=? AND identity_key=?')
        .all(h.communityId, ana.publicKey) as Array<{ role_id: string }>;
      assert.equal(rows.length, 1, 'Ana deve ter apenas 1 cargo (o cargo base)');
      assert.equal(rows[0]!.role_id, g.baseRoleId, 'O cargo deve ser exatamente o cargo base');

      // O cargo Moderador deve ter member_count = 0
      const modRow = h.view
        .prepare('SELECT member_count FROM roles WHERE community_id=? AND id=?')
        .get(h.communityId, modRoleId) as { member_count: number };
      assert.equal(modRow.member_count, 0, 'Contagem de membros do cargo Moderador deve ser 0');

      // Contagem de membros do cargo base deve ser 2 (fundador + ana)
      const baseRow = h.view
        .prepare('SELECT member_count FROM roles WHERE community_id=? AND id=?')
        .get(h.communityId, g.baseRoleId) as { member_count: number };
      assert.equal(baseRow.member_count, 2, 'Contagem de membros do cargo base deve ser 2');

      // member_count na community deve ser 2
      const commRow = h.view
        .prepare('SELECT member_count FROM communities WHERE id=?')
        .get(h.communityId) as { member_count: number };
      assert.equal(commRow.member_count, 2, 'Comunidade deve ter 2 membros ativos');
    } finally {
      await h.close();
    }
  });

  it('2. category.delete com moveChannelsTo inexistente devolve E_VALIDATION com field moveChannelsTo', () => {
    const g = genesis();

    const catSeq = g.world.next(g.founder);
    const rCat = g.world.submit({
      kind: 'category.create',
      author: g.founder,
      authorSeq: catSeq,
      hostTs: TS,
      payload: { name: 'Categoria 1' },
    });
    assert.equal(rCat.decision, 'APPLIED');
    const catId = g.world.id('category', g.founder, catSeq);

    const chanSeq = g.world.next(g.founder);
    const rChan = g.world.submit({
      kind: 'channel.create',
      author: g.founder,
      authorSeq: chanSeq,
      hostTs: TS + 1,
      payload: {
        name: 'canal-1',
        type: 0,
        categoryId: catId,
        readOnlyForRoleIds: [],
      },
    });
    assert.equal(rChan.decision, 'APPLIED');

    // Tenta apagar a categoria movendo para categoria que não existe
    const rDel = g.world.submit({
      kind: 'category.delete',
      author: g.founder,
      hostTs: TS + 2,
      payload: {
        categoryId: catId,
        deleteChannels: false,
        moveChannelsTo: 'categoria-fantasma-inexistente',
      },
    });
    assert.equal(rDel.decision, 'REJECTED');
    assert.equal(rDel.reason, 'E_VALIDATION');
    assert.equal(rDel.field, 'moveChannelsTo');
  });

  it('3. member.setRoles sobre Fundador e Host por terceiros devolve E_FOUNDER_IMMUNE e E_HOST_IMMUNE', () => {
    const g = genesis();
    const modRoleId = criaCargo(g, 'Admin', [
      permissionNumber('manage_roles'),
      permissionNumber('kick_members'),
    ]);

    const ana = joinMember(g, 'ana');
    // Fundador dá cargo com manage_roles para Ana
    g.world.submit({
      kind: 'member.setRoles',
      author: g.founder,
      hostTs: TS,
      payload: { targetKey: ana.publicKey, roleIds: [modRoleId, g.baseRoleId] },
    });

    // 3a. Ana tenta alterar os cargos do Fundador -> E_FOUNDER_IMMUNE
    const rAnaOnFounder = g.world.submit({
      kind: 'member.setRoles',
      author: ana,
      hostTs: TS + 1,
      payload: { targetKey: g.founder.publicKey, roleIds: [g.founderRoleId, g.baseRoleId] },
    });
    assert.equal(rAnaOnFounder.decision, 'REJECTED');
    assert.equal(rAnaOnFounder.reason, 'E_FOUNDER_IMMUNE');

    // 3b. Fundador altera os próprios cargos -> permitido (não devolve E_FOUNDER_IMMUNE)
    const rFounderSelf = g.world.submit({
      kind: 'member.setRoles',
      author: g.founder,
      hostTs: TS + 2,
      payload: { targetKey: g.founder.publicKey, roleIds: [g.founderRoleId, g.baseRoleId] },
    });
    assert.equal(rFounderSelf.decision, 'APPLIED');
  });

  it('4. message.edit em mensagem órfã não reinsere termos na messages_fts', async () => {
    const g = genesis();
    const ana = joinMember(g, 'ana');

    const chanSeq = g.world.next(g.founder);
    const rChan = g.world.submit({
      kind: 'channel.create',
      author: g.founder,
      authorSeq: chanSeq,
      hostTs: TS,
      payload: { name: 'canal-temporario', type: 0, categoryId: g.categoryId, readOnlyForRoleIds: [] },
    });
    assert.equal(rChan.decision, 'APPLIED');
    const canalId = g.world.id('channel', g.founder, chanSeq);

    // Ana envia mensagem contendo "abacaxi orfao teste"
    const msgSeq = g.world.next(ana);
    const rMsg = g.world.submit({
      kind: 'message.send',
      author: ana,
      authorSeq: msgSeq,
      hostTs: TS + 1,
      payload: { channelId: canalId, content: 'abacaxi orfao teste', mentions: [] },
    });
    assert.equal(rMsg.decision, 'APPLIED');
    const msgId = g.world.id('message', ana, msgSeq);

    // Fundador deleta o canal -> mensagem vira órfã e termos são removidos da FTS
    const rDel = g.world.submit({
      kind: 'channel.delete',
      author: g.founder,
      hostTs: TS + 2,
      payload: { channelId: canalId },
    });
    assert.equal(rDel.decision, 'APPLIED');

    // Ana edita a mensagem órfã para "abacaxi editado orfao"
    const rEdit = g.world.submit({
      kind: 'message.edit',
      author: ana,
      hostTs: TS + 3,
      payload: {
        messageId: msgId,
        content: 'abacaxi editado orfao',
      },
    });
    assert.equal(rEdit.decision, 'APPLIED');

    // Projeta e verifica se a FTS na view.db continua SEM a mensagem órfã
    const h = await setup(g.world.log);
    try {
      const p = makeProjector(h, { foldBuildId: BUILD_A });
      await p.boot();

      const ftsCount = (
        h.view.prepare("SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'abacaxi'").get() as {
          n: number;
        }
      ).n;
      assert.equal(ftsCount, 0, 'Mensagem órfã editada NÃO deve ser reindexada na FTS');
    } finally {
      await h.close();
    }
  });

  it('5. Colisão L-5 com Unicode Full Case Folding (casefold) marca displayNameCollision', () => {
    const g = genesis();

    // Membro 1 com displayName 'straße'
    const ana = joinMember(g, 'm1');
    const rAna = g.world.submit({
      kind: 'identity.update',
      author: ana,
      hostTs: TS + 1,
      payload: { displayName: 'straße' },
    });
    assert.equal(rAna.decision, 'APPLIED');

    // Membro 2 com displayName 'STRASSE'
    const bia = joinMember(g, 'm2');
    const rBia = g.world.submit({
      kind: 'identity.update',
      author: bia,
      hostTs: TS + 2,
      payload: { displayName: 'STRASSE' },
    });
    assert.equal(rBia.decision, 'APPLIED');

    // Sob casefold, 'straße' e 'STRASSE' colidem!
    const mAna = g.world.state.members.get(ana.publicKey.toString('hex'));
    const mBia = g.world.state.members.get(bia.publicKey.toString('hex'));
    assert.equal(mAna?.displayNameCollision, true, 'Ana deve ter colisão L-5 com STRASSE');
    assert.equal(mBia?.displayNameCollision, true, 'Bia deve ter colisão L-5 com straße');

    // Outro teste de casefold: long s 'waſſer' vs 'WASSER'
    const carlos = joinMember(g, 'm3');
    g.world.submit({
      kind: 'identity.update',
      author: carlos,
      hostTs: TS + 3,
      payload: { displayName: 'waſſer' },
    });
    const dani = joinMember(g, 'm4');
    g.world.submit({
      kind: 'identity.update',
      author: dani,
      hostTs: TS + 4,
      payload: { displayName: 'WASSER' },
    });
    const mCarlos = g.world.state.members.get(carlos.publicKey.toString('hex'));
    const mDani = g.world.state.members.get(dani.publicKey.toString('hex'));
    assert.equal(mCarlos?.displayNameCollision, true, 'Carlos deve ter colisão L-5 com WASSER');
    assert.equal(mDani?.displayNameCollision, true, 'Dani deve ter colisão L-5 com waſſer');
  });

  it('6. mod.removeTimeout sem timeout ativo é APPLIED silencioso, sem efeitos e sem auditoria (§21.2, §8.4.1)', () => {
    const g = genesis();
    const ana = joinMember(g, 'ana');

    // 1. Ana é membro ativo e não está em timeout
    const mAna = g.world.state.members.get(ana.publicKey.toString('hex'));
    assert.equal(mAna?.timeoutUntil, undefined);

    // 2. Fundador tenta remover timeout que não existe
    const rSemTimeout = g.world.submit({
      kind: 'mod.removeTimeout',
      author: g.founder,
      hostTs: TS + 1,
      payload: { targetKey: ana.publicKey },
    });
    // Deve ser APPLIED silencioso sem emitir patch, delete, notify ou audit
    assert.equal(rSemTimeout.decision, 'APPLIED');
    assert.equal(rSemTimeout.effects.length, 0, 'não deve emitir efeitos nem gravar auditoria');

    // 3. Aplica timeout real
    const rTimeout = g.world.submit({
      kind: 'mod.timeout',
      author: g.founder,
      hostTs: TS + 2,
      payload: { targetKey: ana.publicKey, until: TS + 3600_000 },
    });
    assert.equal(rTimeout.decision, 'APPLIED');
    assert.ok(rTimeout.effects.length > 0);
    assert.equal(g.world.state.members.get(ana.publicKey.toString('hex'))?.timeoutUntil, TS + 3600_000);

    // 4. Remove timeout existente
    const rRemove = g.world.submit({
      kind: 'mod.removeTimeout',
      author: g.founder,
      hostTs: TS + 3,
      payload: { targetKey: ana.publicKey },
    });
    assert.equal(rRemove.decision, 'APPLIED');
    assert.ok(rRemove.effects.length > 0, 'remoção com timeout ativo emite efeitos');
    assert.equal(g.world.state.members.get(ana.publicKey.toString('hex'))?.timeoutUntil, undefined);

    // 5. Segundo removeTimeout sobre o mesmo membro (agora sem timeout) deve ser novamente APPLIED sem efeitos
    const rRemoveRepetido = g.world.submit({
      kind: 'mod.removeTimeout',
      author: g.founder,
      hostTs: TS + 4,
      payload: { targetKey: ana.publicKey },
    });
    assert.equal(rRemoveRepetido.decision, 'APPLIED');
    assert.equal(rRemoveRepetido.effects.length, 0, 'reenvio sem timeout é silencioso');
  });

  it('7. relay.withdraw sem voluntariado por membro ativo é APPLIED silencioso (§21.2); não-membro segue E_NOT_MEMBER', () => {
    const g = genesis();
    const ana = joinMember(g, 'ana');
    const forasteiro = keypairFromSeed('forasteiro');

    // 1. Ana é membro ativo sem nenhum voluntariado registrado
    assert.equal(g.world.state.relays.get(ana.publicKey.toString('hex')), undefined);

    // 2. Ana submete relay.withdraw sem ter voluntariado
    const rWithdrawSemVoluntariado = g.world.submit({
      kind: 'relay.withdraw',
      author: ana,
      hostTs: TS + 1,
      payload: {},
    });
    assert.equal(rWithdrawSemVoluntariado.decision, 'APPLIED');
    assert.equal(rWithdrawSemVoluntariado.effects.length, 0, 'sem voluntariado é sucesso silencioso sem efeitos');

    // 3. Forasteiro (não-membro) submete relay.withdraw -> recusa no estágio 8
    const rForasteiro = g.world.submit({
      kind: 'relay.withdraw',
      author: forasteiro,
      hostTs: TS + 2,
      payload: {},
    });
    assert.equal(rForasteiro.decision, 'REJECTED');
    assert.equal(rForasteiro.reason, 'E_NOT_MEMBER', 'não-membro é barrado no estágio 8');
  });
});
