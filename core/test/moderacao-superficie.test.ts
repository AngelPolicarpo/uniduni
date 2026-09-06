// §52 — a fatia 2 das superfícies de §15.4/§15.6: membros, cargos e moderação.
//
// Mesmo caminho de produto das fatias anteriores: a comunidade nasce por `community.create`,
// cada comando ⏱ vai ao host local pela ponte de submissão, e quem confere o efeito é a
// leitura de §15.6 (`query.roles`, `query.members`, `query.member`, `query.bans`), não
// consulta de teste. O que cada asserção fixa:
//
//   §15.4  — as respostas com campos derivados (`rank`, `affectedMembers`,
//            `clearedChannelRefs`, `appliedRoleIds`, `hiddenMessages`) LIDOS do estado
//            projetado, nunca recalculados;
//   §8.4.1 — id desconhecido em `member.setRoles` é DESCARTADO, não recusado; re-ban
//            idempotente decide nada e não escreve auditoria de novo;
//   R-28   — ban de quem não é membro é APPLIED; os demais recusam não-membro;
//   R-16   — mod.* sobre si mesmo é `E_SELF_TARGET` (decisão do `fold`);
//   §23.2  — cargos em `rank` decrescente; auditoria/bans/timeouts no mais recente primeiro;
//   §15.6.1/DR-25/T-44 — auditoria, bans e timeouts sem permissão são `E_PERMISSION_DENIED`.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { ManifestDb } from '../src/l0/manifest/index.ts';
import { openViewDb } from '../src/l0/view/index.ts';
import { Swarm } from '../src/l0/swarm/index.ts';
import { CHANNEL_TYPE } from '../src/l1/fold/index.ts';
import { MemoryIpcPort } from '../src/l3/ipcRenderer/index.ts';
import { bootCore, type CoreRuntime } from '../src/composition/boot.ts';
import { queryReadPorts } from '../src/composition/queries.ts';
import { tempDir } from './helpers/composition.ts';
import { keypairFromSeed } from './helpers/world.ts';

const DATA_KEY = Buffer.alloc(32, 52);

type Resposta = { ok: boolean; data: unknown; code: string | null; field: string | null };

async function rig(rotulo: string) {
  const dir = tempDir(rotulo);
  const manifest = new ManifestDb(path.join(dir, 'manifest.db'));
  const view = openViewDb(path.join(dir, 'view.db'));
  const [coreSide, rendererSide] = MemoryIpcPort.createPair();
  const identity = keypairFromSeed(`${rotulo}-eu`);
  const runtime: CoreRuntime = await bootCore({
    dataDir: dir,
    manifest,
    view,
    swarm: new Swarm(),
    dataKey: DATA_KEY,
    identity: () => identity,
    identityProfile: () => ({ displayName: 'Dona Raiz', avatarColor: 3 }),
    foldBuildId: 'moderacao-52',
    ipcPort: coreSide,
    epoch: 1,
    tokenVerifier: { consume: () => true },
    hostTurnSecret: () => Buffer.alloc(32, 7),
    // A suíte roda os arquivos em paralelo: prazo apertado vira flake por relógio, não regra.
    projectionWaitMs: 20_000,
    now: () => Date.now(),
    schedule: () => 0,
    cancel: () => {},
  });
  // §11.4 fecha o grupo por `setTimeout` unref: sem isto o processo sai antes da hora.
  const vivo = setInterval(() => {}, 5);

  async function request(cmd: string, arg: unknown): Promise<Resposta> {
    const id = 9000 + Math.floor(Math.random() * 1000);
    const resposta = new Promise<Resposta>((resolve) => {
      rendererSide.onMessage((frame) => {
        if (frame.t === 'res' && frame.id === id) {
          resolve({ ok: frame.ok, data: frame.data, code: frame.err?.code ?? null, field: frame.err?.field ?? null });
        }
      });
    });
    rendererSide.postMessage({ t: 'req', epoch: 1, id, cmd, arg, authToken: 'ok' });
    return await resposta;
  }

  /** Comando aceito + projeção alcançada antes de qualquer conferência (§10.5). */
  async function ok(cmd: string, arg: unknown): Promise<Record<string, unknown>> {
    const r = await request(cmd, arg);
    assert.ok(r.ok, `${cmd} recusou: ${JSON.stringify(r)}`);
    const communityId = (arg as { communityId?: string }).communityId;
    if (communityId !== undefined) {
      const c = runtime.get(communityId);
      if (c !== undefined) {
        const alvo = c.core.length - 1;
        const limite = Date.now() + 20_000;
        while (c.projector.interpretedSeq < alvo && Date.now() < limite) await new Promise((res) => setTimeout(res, 5));
        assert.ok(c.projector.interpretedSeq >= alvo, `o projector parou em ${c.projector.interpretedSeq}, esperava ${alvo}`);
      }
    }
    return r.data as Record<string, unknown>;
  }

  return {
    runtime,
    identity,
    view,
    manifest,
    request,
    ok,
    async comunidadeNova() {
      return (await ok('community.create', { name: 'Raiz', iconColor: 1 })) as unknown as { communityId: string };
    },
    async roles(communityId: string) {
      return (await ok('query.roles', { communityId })) as unknown as {
        roles: Array<{ id: string; name: string; color: string; rank: string; permissions: string[]; mentionable: boolean; isFounder: boolean; isDefault: boolean; memberCount: number }>;
      };
    },
    async members(communityId: string, filtro?: Record<string, unknown>) {
      return (await ok('query.members', { communityId, ...(filtro !== undefined ? { filter: filtro } : {}) })) as unknown as {
        groups: Array<{ roleId: string; roleName: string; roleColor: string; rank: string; members: Array<Record<string, unknown>> }>;
        offlineCount: number;
        total: number;
        nextCursor?: string;
      };
    },
    async member(communityId: string, identityKey: string) {
      return (await ok('query.member', { communityId, identityKey })) as unknown as {
        key: string;
        nickname?: string;
        roleIds: string[];
        roles: Array<{ id: string; name: string; color: string; rank: string }>;
        joinedAt: number;
        banned: boolean;
        timeoutUntil?: number;
        canModerate: boolean;
        canKick: boolean;
        canBan: boolean;
        canTimeout: boolean;
        canSetRoles: boolean;
        storageUsedBytes: number;
      };
    },
    async close() {
      clearInterval(vivo);
      await runtime.close();
      view.close();
      manifest.close();
      // Cores de hypercore podem ainda estar sendo escritas quando o rmSync começa;
      // três tentativas com folga cobrem a corrida sem esconder erro real.
      for (let tentativa = 0; ; tentativa++) {
        try {
          fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
          break;
        } catch (e) {
          if (tentativa >= 2 || (e as { code?: string }).code !== 'ENOTEMPTY') throw e;
          await new Promise((res) => setTimeout(res, 50));
        }
      }
    },
  };
}

function chaveEstranha(seed: number): string {
  return Buffer.from(Array.from({ length: 32 }, (_, i) => (seed * 31 + i * 7) % 256)).toString('hex');
}

describe('§52 cargos — gênese, criação em posição, rank DESC, edição e exclusão', { timeout: 120_000 }, () => {
  it('a gênese tem dois cargos e `query.roles` traz Fundador primeiro, base último (§23.2)', async () => {
    const r = await rig('cargos-genese');
    try {
      const { communityId } = await r.comunidadeNova();
      const lista = await r.roles(communityId);
      assert.equal(lista.roles.length, 2);
      assert.equal(lista.roles[0]!.isFounder, true, 'o topo da lista é o cargo Fundador');
      assert.equal(lista.roles[0]!.permissions.length, 17, 'o Fundador carrega as 17');
      assert.equal(lista.roles[1]!.isDefault, true);
      assert.ok(lista.roles[0]!.rank > lista.roles[1]!.rank, 'rank decrescente');
      assert.equal(lista.roles[1]!.memberCount, 1, 'o contador do cargo base vem do projector');
    } finally {
      await r.close();
    }
  });

  it('role.create deriva o id na hora, o `rank` espera a projeção e "depois de X" posiciona (R-20)', async () => {
    const r = await rig('cargos-cria');
    try {
      const { communityId } = await r.comunidadeNova();
      const base = (await r.roles(communityId)).roles.find((x) => x.isDefault)!;

      const alfa = (await r.ok('role.create', {
        communityId,
        name: 'Alfa',
        color: 5,
        permissions: ['pin_messages'],
        mentionable: false,
      })) as { roleId: string; seq: number; rank?: string };
      assert.match(alfa.roleId, /^role-/, 'o id vem de §7.3, derivado do authorSeq consumido pela submissão');
      assert.equal(typeof alfa.rank, 'string');

      await r.ok('role.create', {
        communityId,
        name: 'Beta',
        color: 6,
        permissions: ['kick_members'],
        mentionable: true,
        afterRoleId: alfa.roleId,
      });

      const nomes = (await r.roles(communityId)).roles.map((x) => x.name);
      assert.deepEqual(nomes, ['Fundador', 'Beta', 'Alfa', base.name], '§23.2: rank DESC — Beta caiu ENTRE Alfa e o Fundador');

      const semPermissao = await r.request('role.create', { communityId, name: 'X', color: 1, permissions: ['não-existe'], mentionable: false });
      assert.equal(semPermissao.code, 'E_VALIDATION');
      assert.equal(semPermissao.field, 'permissions', 'permissão desconhecida não vira número silenciosamente');
    } finally {
      await r.close();
    }
  });

  it('role.update renomeia, role.move reposiciona e role.delete responde o que o fold limpou', async () => {
    const r = await rig('cargos-edita');
    try {
      const { communityId } = await r.comunidadeNova();
      const geral = ((await r.ok('query.structure', { communityId })) as unknown as { categories: Array<{ id: string }> }).categories[0]!.id;
      // §6.4.2 — a paleta de cargo vai de 0 a 6.
      const mod = (await r.ok('role.create', { communityId, name: 'Moderação', color: 5, permissions: ['kick_members', 'manage_messages'], mentionable: true })) as { roleId: string };
      await r.ok('channel.create', { communityId, categoryId: geral, type: CHANNEL_TYPE.text, name: 'restrito', readOnlyForRoleIds: [mod.roleId] });

      // O cargo vai para a própria fundadora — mantendo Fundador e base —, que é o único
      // membro disponível num rig sem segundo participante.
      const gênese = (await r.roles(communityId)).roles;
      const fundadorId = gênese.find((x) => x.isFounder)!.id;
      const baseId = gênese.find((x) => x.isDefault)!.id;
      const atribuído = (await r.ok('member.setRoles', {
        communityId,
        targetKey: r.identity.publicKey.toString('hex'),
        roleIds: [fundadorId, baseId, mod.roleId],
      })) as { appliedRoleIds: string[] };
      assert.deepEqual(atribuído.appliedRoleIds, [fundadorId, baseId, mod.roleId].sort());

      await r.ok('role.update', { communityId, roleId: mod.roleId, name: 'Moderação Renomeada', color: 3 });
      const renomeado = (await r.roles(communityId)).roles.find((x) => x.id === mod.roleId)!;
      assert.equal(renomeado.name, 'Moderação Renomeada');
      assert.equal(renomeado.color, '3');
      assert.equal(renomeado.memberCount, 1);

      // Dois cargos novos dão material para mover sem esbarrar no topo da escala. O
      // no-hint vai ao piso corrente do escopo (R-20): X fica entre a base e a Moderação,
      // e Y, pedida "depois de X", fica ENTRE X e quem vem logo acima dela.
      const x = (await r.ok('role.create', { communityId, name: 'Xis', color: 1, permissions: [], mentionable: false })) as { roleId: string };
      const y = (await r.ok('role.create', { communityId, name: 'Ypsilone', color: 2, permissions: [], mentionable: false, afterRoleId: x.roleId })) as { roleId: string };
      let ordem = (await r.roles(communityId)).roles.map((z) => z.id);
      const pos = (id: string) => ordem.indexOf(id);
      assert.ok(pos(fundadorId) < pos(y.roleId) && pos(y.roleId) < pos(x.roleId), 'Y caiu ENTRE X e quem está acima dele');
      assert.ok(pos(x.roleId) < pos(baseId), 'o cargo base segue no piso da lista');

      const movido = (await r.ok('role.move', { communityId, roleId: x.roleId, afterRoleId: y.roleId })) as { seq: number; rank?: string };
      assert.equal(typeof movido.rank, 'string');
      ordem = (await r.roles(communityId)).roles.map((z) => z.id);
      assert.equal(pos(x.roleId), pos(y.roleId) - 1, 'X subiu para imediatamente acima de Y');

      // Cargo imutável e cargo-base intocável são recusas do fold, não da fronteira.
      assert.equal((await r.request('role.delete', { communityId, roleId: fundadorId })).code, 'E_FOUNDER_IMMUTABLE');
      assert.equal((await r.request('role.delete', { communityId, roleId: baseId })).code, 'E_BASE_ROLE_REQUIRED');

      const apagado = (await r.ok('role.delete', { communityId, roleId: mod.roleId })) as {
        seq: number;
        affectedMembers: number;
        clearedChannelRefs: number;
      };
      assert.equal(apagado.affectedMembers, 1, 'uma portadora tinha o cargo');
      assert.equal(apagado.clearedChannelRefs, 1, 'um canal referenciava o cargo (F-31)');
      const depois = (await r.roles(communityId)).roles;
      assert.ok(depois.every((z) => z.id !== mod.roleId));
      const estrutura = ((await r.ok('query.structure', { communityId })) as unknown as {
        categories: Array<{ channels: Array<{ name: string; readOnly: boolean }> }>;
      }).categories[0]!.channels;
      assert.equal(estrutura.find((c) => c.name === 'restrito')!.readOnly, false, 'a referência morta saiu do canal');
    } finally {
      await r.close();
    }
  });
});

describe('§52 membros — setRoles descarta o inexistente, apelido próprio, leitura completa', { timeout: 120_000 }, () => {
  it('member.setRoles devolve o conjunto EFETIVAMENTE aplicado (§8.4.1) e protege o cargo base (R-3)', async () => {
    const r = await rig('membros-roles');
    try {
      const { communityId } = await r.comunidadeNova();
      const mod = (await r.ok('role.create', { communityId, name: 'Mod', color: 3, permissions: [], mentionable: false })) as { roleId: string };
      const gênese = (await r.roles(communityId)).roles;
      const fundadorId = gênese.find((x) => x.isFounder)!.id;
      const baseId = gênese.find((x) => x.isDefault)!.id;

      // Id inventado é descartado; o resto é aplicado. A resposta é a verdade projetada.
      const r1 = (await r.ok('member.setRoles', {
        communityId,
        targetKey: r.identity.publicKey.toString('hex'),
        roleIds: [fundadorId, baseId, 'role-naoexiste', mod.roleId],
      })) as { appliedRoleIds: string[] };
      assert.deepEqual(r1.appliedRoleIds, [baseId, fundadorId, mod.roleId].sort());

      // Tirar o cargo base de um membro ativo é recusa do fold (R-3).
      assert.equal(
        (await r.request('member.setRoles', { communityId, targetKey: r.identity.publicKey.toString('hex'), roleIds: [fundadorId] })).code,
        'E_BASE_ROLE_REQUIRED',
      );

      const perfil = await r.member(communityId, r.identity.publicKey.toString('hex'));
      assert.deepEqual([...perfil.roleIds].sort(), [baseId, fundadorId, mod.roleId].sort());
      assert.equal(perfil.banned, false);
      assert.ok(perfil.joinedAt > 0);
      assert.equal(perfil.roles.some((x) => x.name === 'Fundador'), true);
      assert.equal(typeof perfil.storageUsedBytes, 'number');
    } finally {
      await r.close();
    }
  });

  it('member.setNickname põe e tira; a leitura reflete e o UserRef leva o apelido', async () => {
    const r = await rig('membros-apelido');
    try {
      const { communityId } = await r.comunidadeNova();
      const eu = r.identity.publicKey.toString('hex');
      await r.ok('member.setNickname', { communityId, nickname: 'Dona A' });
      let perfil = await r.member(communityId, eu);
      assert.equal(perfil.nickname, 'Dona A');
      const roster = await r.members(communityId);
      assert.equal(roster.groups[0]!.members[0]!['nickname'], 'Dona A');

      await r.ok('member.setNickname', { communityId, nickname: null });
      perfil = await r.member(communityId, eu);
      assert.equal(perfil.nickname, undefined, 'limpar é a forma com null, não um apelido vazio');

      const invalido = await r.request('member.setNickname', { communityId, nickname: 42 });
      assert.equal(invalido.code, 'E_VALIDATION');
    } finally {
      await r.close();
    }
  });

  it('query.members agrupa pelo cargo de maior rank, filtra e encerra o cursor no fim da ordem', async () => {
    const r = await rig('membros-lista');
    try {
      const { communityId } = await r.comunidadeNova();
      const eu = r.identity.publicKey.toString('hex');
      const fundador = (await r.roles(communityId)).roles.find((x) => x.isFounder)!;

      const base = (await r.roles(communityId)).roles.find((x) => x.isDefault)!;

      const cheio = await r.members(communityId);
      assert.equal(cheio.total, 1);
      assert.equal(cheio.offlineCount, 1, 'sem produtor de presença, todos estão offline — contagem agregada');
      assert.equal(cheio.groups.length, 1);
      assert.equal(cheio.groups[0]!.roleId, fundador.id, 'o grupo é o cargo de maior rank');
      assert.equal(cheio.groups[0]!.members[0]!['key'], eu);
      // O GRUPO é um cargo só; o membro carrega TODOS os cargos ativos dele (emenda de
      // 2026-09-06). §9.2 é união e R-3 exige o base em `member.setRoles`: entregar só o
      // cargo do grupo fazia o renderer esconder ação autorizada e mandar `setRoles` sem o
      // base — `E_BASE_ROLE_REQUIRED` garantido.
      assert.deepEqual(
        cheio.groups[0]!.members[0]!['roleIds'],
        [fundador.id, base.id],
        'roleIds vem em rank DESC e traz o cargo base junto com o do grupo',
      );
      assert.equal('presence' in cheio.groups[0]!.members[0]!, false, 'campo sem fonte fica ausente (precedente §46/§50)');
      assert.equal(typeof cheio.groups[0]!.members[0]!['joinedAt'], 'number');
      assert.equal(cheio.nextCursor, undefined);

      const semAchado = await r.members(communityId, { query: 'ninguem-assim' });
      assert.deepEqual(semAchado.groups, []);
      assert.equal(semAchado.total, 1, 'total é do roster inteiro, não do filtro');

      const soOnline = await r.members(communityId, { onlyOnline: true });
      assert.deepEqual(soOnline.groups, [], 'presença sem produtor: ninguém está sabidamente online');
      assert.equal(soOnline.offlineCount, 1);

      const porCargo = await r.members(communityId, { roleId: fundador.id });
      assert.equal(porCargo.groups.length, 1);
      assert.equal(porCargo.groups[0]!.members.length, 1);

      // Cursor passado do último item encerra a lista — nunca repete nem inventa página.
      const cursorDoFim = Buffer.from(JSON.stringify({ seq: 0, id: eu }), 'utf8').toString('base64url');
      const pagina2 = (await r.ok('query.members', { communityId, cursor: cursorDoFim })) as unknown as { groups: unknown[] };
      assert.deepEqual(pagina2.groups, []);

      const ruim = await r.request('query.members', { communityId, cursor: 'nao-e-cursor!!' });
      assert.equal(ruim.code, 'E_BAD_CURSOR');
    } finally {
      await r.close();
    }
  });
});

describe('§52 moderação — ban preventivo (R-28), inversos de não-membro, auto-alvo e listagens', { timeout: 120_000 }, () => {
  it('ban de não-membro é APPLIED e alimenta bans/member/members; kick e timeout de não-membro recusam', async () => {
    const r = await rig('mod-ban');
    try {
      const { communityId } = await r.comunidadeNova();
      const estranho = chaveEstranha(11);

      assert.equal((await r.request('mod.kick', { communityId, targetKey: estranho })).code, 'E_NOT_FOUND');
      assert.equal((await r.request('mod.timeout', { communityId, targetKey: estranho, until: Date.now() + 120_000 })).code, 'E_NOT_FOUND');
      assert.equal((await r.request('mod.revokeBan', { communityId, targetKey: estranho })).code, 'E_NOT_FOUND');

      const banido = (await r.ok('mod.ban', { communityId, targetKey: estranho, reason: 'spam' })) as {
        seq: number;
        hiddenMessages: number;
        revokedInvites: number;
      };
      assert.deepEqual(banido, { ...banido, hiddenMessages: 0, revokedInvites: 0 }, 'R-28: sem membresia não há o que ocultar ou revogar');

      const bans = (await r.ok('query.bans', { communityId })) as unknown as {
        items: Array<{ target: { key: string }; by: { key: string }; at: number; reason?: string }>;
      };
      assert.equal(bans.items.length, 1);
      assert.equal(bans.items[0]!.target.key, estranho);
      assert.equal(bans.items[0]!.by.key, r.identity.publicKey.toString('hex'));
      assert.equal(bans.items[0]!.reason, 'spam');

      const perfil = await r.member(communityId, estranho);
      assert.equal(perfil.banned, true);
      assert.deepEqual(perfil.roleIds, []);

      const roster = await r.members(communityId);
      assert.equal(roster.total, 1, 'ban preventivo não entra no roster ativo');

      const revogado = (await r.ok('mod.revokeBan', { communityId, targetKey: estranho })) as { restoredMessages: number };
      assert.equal(revogado.restoredMessages, 0);
      assert.equal(((await r.ok('query.bans', { communityId })) as unknown as { items: unknown[] }).items.length, 0, 'revoked_at tira da listagem');
    } finally {
      await r.close();
    }
  });

  it('a imunidade do Fundador vence (R-16) e o re-ban idempotente decide nada (§8.4.1)', async () => {
    const r = await rig('mod-auto');
    try {
      const { communityId } = await r.comunidadeNova();
      const eu = r.identity.publicKey.toString('hex');
      // R-16 passo 2, na ordem de §9.3: a imunidade do Fundador é conferida ANTES da
      // auto-referência — e o rig só tem a fundadora como membro.
      assert.equal((await r.request('mod.kick', { communityId, targetKey: eu })).code, 'E_FOUNDER_IMMUNE');
      assert.equal((await r.request('mod.ban', { communityId, targetKey: eu })).code, 'E_FOUNDER_IMMUNE');
      assert.equal((await r.request('mod.timeout', { communityId, targetKey: eu, until: Date.now() + 120_000 })).code, 'E_FOUNDER_IMMUNE');

      const estranho = chaveEstranha(23);
      await r.ok('mod.ban', { communityId, targetKey: estranho });
      const deNovo = (await r.ok('mod.ban', { communityId, targetKey: estranho })) as { seq: number; hiddenMessages: number; revokedInvites: number };
      assert.equal(deNovo.hiddenMessages, 0, 'o delta lido é zero, não o total acumulado');
      assert.equal(deNovo.revokedInvites, 0);
      const log = (await r.ok('query.auditLog', { communityId, type: 'ban' })) as unknown as { items: Array<{ type: string; targetKey?: string }> };
      assert.equal(log.items.length, 1, 'idempotente não escreve auditoria de novo');
      assert.equal(log.items[0]!.targetKey, estranho, 'alvo pessoa sai como targetKey');
    } finally {
      await r.close();
    }
  });

  it('timeout põe e tira, valida a janela contra o hostTs do fold, e query.timeouts calcula expired', async () => {
    const r = await rig('mod-timeout');
    try {
      const { communityId } = await r.comunidadeNova();
      // Um banido preventivo EXISTE como membro (R-28) e por isso aceita timeout — é o
      // alvo disponível num rig de uma pessoa só; quem decide é sempre o fold.
      const estranho = chaveEstranha(37);
      await r.ok('mod.ban', { communityId, targetKey: estranho });

      const curto = await r.request('mod.timeout', { communityId, targetKey: estranho, until: Date.now() + 1_000 });
      assert.equal(curto.code, 'E_VALIDATION', 'a janela de §8.6 é conferida pelo fold contra o hostTs da admissão');

      const ate = Date.now() + 10 * 60_000;
      await r.ok('mod.timeout', { communityId, targetKey: estranho, until: ate, reason: 'acalmar' });
      const lista = (await r.ok('query.timeouts', { communityId })) as unknown as {
        items: Array<{ target: { key: string }; until: number; expired: boolean; reason?: string }>;
      };
      assert.equal(lista.items.length, 1);
      assert.equal(lista.items[0]!.target.key, estranho);
      assert.equal(lista.items[0]!.until, ate);
      assert.equal(lista.items[0]!.expired, false, 'até o último hostTs registrado ainda vigora');
      const perfil = await r.member(communityId, estranho);
      assert.equal(perfil.timeoutUntil, ate);

      await r.ok('mod.removeTimeout', { communityId, targetKey: estranho });
      assert.equal(((await r.ok('query.timeouts', { communityId })) as unknown as { items: unknown[] }).items.length, 0);
      const limpo = await r.member(communityId, estranho);
      assert.equal(limpo.timeoutUntil, undefined);
    } finally {
      await r.close();
    }
  });

  it('auditLog ordena por seq DESC, filtra por autor/período, e bans paginam em lotes de 25', async () => {
    const r = await rig('mod-audit');
    try {
      const { communityId } = await r.comunidadeNova();
      for (let i = 0; i < 30; i++) {
        await r.ok('mod.ban', { communityId, targetKey: chaveEstranha(100 + i) });
      }
      const page1 = (await r.ok('query.bans', { communityId })) as unknown as { items: Array<{ target: { key: string } }>; nextCursor?: string; hasMore: boolean };
      assert.equal(page1.items.length, 25);
      assert.equal(page1.hasMore, true);
      const page2 = (await r.ok('query.bans', { communityId, cursor: page1.nextCursor })) as unknown as { items: Array<{ target: { key: string } }>; hasMore: boolean };
      assert.equal(page2.items.length, 5);
      assert.equal(page2.hasMore, false);
      const vistas = new Set([...page1.items, ...page2.items].map((i) => i.target.key));
      assert.equal(vistas.size, 30, 'cursor não repete nem perde item');

      // O lote de auditoria é teto 25 (§23.3) — pedir mais não passa do lote.
      const audit1 = (await r.ok('query.auditLog', { communityId, limit: 40 })) as unknown as { items: Array<{ seq: number; id: string }>; nextCursor?: string; hasMore: boolean };
      assert.equal(audit1.items.length, 25);
      assert.equal(audit1.hasMore, true);
      const audit2 = (await r.ok('query.auditLog', { communityId, cursor: audit1.nextCursor })) as unknown as { items: Array<{ seq: number; id: string }>; hasMore: boolean };
      assert.equal(audit2.items.length, 5);
      const seqs = [...audit1.items, ...audit2.items].map((i) => i.seq);
      assert.equal(new Set(seqs).size, 30);
      assert.deepEqual([...seqs].sort((a, b) => b - a), seqs, 'seq decrescente (§23.2)');

      const porAutor = (await r.ok('query.auditLog', { communityId, byKey: r.identity.publicKey.toString('hex'), limit: 5 })) as unknown as { items: unknown[] };
      assert.equal(porAutor.items.length, 5);

      const janela = (await r.ok('query.auditLog', { communityId, to: 0 })) as unknown as { items: unknown[] };
      assert.deepEqual(janela.items, [], 'período antes de tudo não traz nada');
    } finally {
      await r.close();
    }
  });

  it('enforcement de leitura (DR-25/T-44): sem view_audit_log, auditoria/bans/timeouts são E_PERMISSION_DENIED', async () => {
    const r = await rig('mod-enforcement');
    try {
      const { communityId } = await r.comunidadeNova();
      await r.ok('mod.ban', { communityId, targetKey: chaveEstranha(55) });
      const c = r.runtime.get(communityId)!;
      // Uma segunda porta de leitura, com uma identidade que NÃO é membro: é a conferência
      // local de §15.6.1 — confidencialidade da superfície (L-10), não do disco.
      const intrusa = queryReadPorts({
        view: r.view,
        manifest: r.manifest,
        stateFor: (cid) => c.projector.ds,
        selfKeyHex: () => chaveEstranha(999),
        replicationOf: () => ({ state: 'synced', lag: 0 }),
      });
      for (const consulta of ['auditLog', 'bans', 'timeouts'] as const) {
        assert.throws(
          () => intrusa[consulta]({ communityId }),
          (e: { code?: string }) => e.code === 'E_PERMISSION_DENIED',
          `${consulta} sem permissão deveria recusar`,
        );
      }
      // Consultas sem escopo de permissão seguem abertas para qualquer membro.
      assert.equal((intrusa.roles({ communityId }) as { roles: unknown[] }).roles.length, 2);
      assert.equal((intrusa.members({ communityId }) as { total: number }).total, 1);
    } finally {
      await r.close();
    }
  });

  it('bans e timeouts têm carve-out próprio: ban_members lê bans, timeout_members lê timeouts', async () => {
    const r = await rig('mod-carveout');
    try {
      const { communityId } = await r.comunidadeNova();
      await r.ok('mod.ban', { communityId, targetKey: chaveEstranha(56) });
      const c = r.runtime.get(communityId)!;

      // Dois cargos com UMA permissão de moderação cada — nenhum tem `view_audit_log`.
      const soBanir = (await r.ok('role.create', { communityId, name: 'Só banir', color: 1, permissions: ['ban_members'], mentionable: false })) as { roleId: string };
      const soTimeout = (await r.ok('role.create', { communityId, name: 'Só timeout', color: 1, permissions: ['timeout_members'], mentionable: false })) as { roleId: string };

      /**
       * A porta de leitura com uma chave que o `DecisionState` diz ser membro do cargo dado.
       * Os cargos são REAIS (vieram do `fold`); só a membresia é encenada, que é o mesmo
       * recorte que a `intrusa` do teste anterior usa — a decisão exercitada continua sendo
       * a de §15.6, não uma segunda implementação dela.
       */
      function porta(roleId: string, keyHex: string) {
        const ds = c.projector.ds;
        const members = new Map(ds.members);
        members.set(keyHex, { ...members.values().next().value!, roleIds: new Set([roleId]) });
        return queryReadPorts({
          view: r.view,
          manifest: r.manifest,
          stateFor: () => ({ ...ds, members }) as typeof ds,
          selfKeyHex: () => keyHex,
          replicationOf: () => ({ state: 'synced', lag: 0 }),
        });
      }

      const queBane = porta(soBanir.roleId, chaveEstranha(901));
      assert.equal((queBane.bans({ communityId }) as { items: unknown[] }).items.length, 1, 'ban_members lê a lista que ele pode revogar (§9.1)');
      assert.throws(() => queBane.auditLog({ communityId }), (e: { code?: string }) => e.code === 'E_PERMISSION_DENIED');
      assert.throws(() => queBane.timeouts({ communityId }), (e: { code?: string }) => e.code === 'E_PERMISSION_DENIED');

      const queSilencia = porta(soTimeout.roleId, chaveEstranha(902));
      // Emenda de 2026-09-06: sem este carve-out, quem tem `timeout_members` não conseguia
      // LER os timeouts vigentes e não tinha por onde exercer `mod.removeTimeout`.
      assert.equal((queSilencia.timeouts({ communityId }) as { items: unknown[] }).items.length, 0);
      assert.throws(() => queSilencia.auditLog({ communityId }), (e: { code?: string }) => e.code === 'E_PERMISSION_DENIED');
      assert.throws(() => queSilencia.bans({ communityId }), (e: { code?: string }) => e.code === 'E_PERMISSION_DENIED');
    } finally {
      await r.close();
    }
  });
});
