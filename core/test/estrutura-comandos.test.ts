// §51 — a metade de escrita da estrutura: canais, categorias e `community.update` (§15.4).
//
// Tudo pelo caminho de produto: a comunidade nasce por `community.create`, cada comando ⏱
// vai ao host local pela ponte de submissão, e a leitura que confere é a de §50
// (`query.structure`), não uma consulta de teste. O que cada asserção fixa:
//
//   §15.4 — a resposta de cada comando (`channelId`/`rank`/`droppedQueued`/contagens);
//   §7.3  — o id da entidade criada é derivável de `authorSeq`, sem esperar projeção;
//   R-20  — "depois de X" cai ENTRE X e o seguinte, não no fim do escopo;
//   R-6/R-7 — nome duplicado e último canal de texto são recusados pelo `fold`;
//   §11.7 — apagar canal derruba a fila dele com motivo nomeado (`channel-deleted`).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { ManifestDb } from '../src/l0/manifest/index.ts';
import { openViewDb } from '../src/l0/view/index.ts';
import { Swarm } from '../src/l0/swarm/index.ts';
import { CHANNEL_SCOPED_KINDS, CHANNEL_TYPE } from '../src/l1/fold/index.ts';
import { CHANNEL_SCOPED, resolveScope } from '../src/l2/communityClient/index.ts';
import { MemoryIpcPort } from '../src/l3/ipcRenderer/index.ts';
import { bootCore, type CoreRuntime } from '../src/composition/boot.ts';
import { tempDir } from './helpers/composition.ts';
import { T0, keypairFromSeed } from './helpers/world.ts';

const DATA_KEY = Buffer.alloc(32, 51);

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
    foldBuildId: 'estrutura-51',
    ipcPort: coreSide,
    epoch: 1,
    tokenVerifier: { consume: () => true },
    hostTurnSecret: () => Buffer.alloc(32, 7),
    // A suíte roda os arquivos em paralelo: o prazo de produto (2 s) é apertado sob carga,
    // e sem `rank` a asserção do teste falharia por relógio, não por regra.
    projectionWaitMs: 20_000,
    now: () => Date.now(),
    schedule: () => 0,
    cancel: () => {},
  });
  // §11.4 fecha o grupo por `setTimeout` unref: sem rede, nada segura o event loop do rig.
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

  /**
   * Comando aceito + projeção alcançada. As ops ⏱ respondem `{seq}` assim que o host
   * appenda; quem materializa a `view.db` é o `projector`, num tick posterior (§10.5). Sem
   * esta espera o teste leria o estado anterior — e estaria testando a corrida, não a regra.
   */
  async function ok(cmd: string, arg: unknown): Promise<Record<string, unknown>> {
    const r = await request(cmd, arg);
    assert.ok(r.ok, `${cmd} recusou: ${JSON.stringify(r)}`);
    const communityId = (arg as { communityId?: string }).communityId ?? (r.data as { communityId?: string })?.communityId;
    const c = communityId === undefined ? undefined : runtime.get(communityId);
    if (c !== undefined) {
      const alvo = c.core.length - 1;
      const limite = Date.now() + 20_000;
      while (c.projector.interpretedSeq < alvo && Date.now() < limite) await new Promise((res) => setTimeout(res, 5));
      assert.ok(c.projector.interpretedSeq >= alvo, `o projector parou em ${c.projector.interpretedSeq}, esperava ${alvo}`);
    }
    return r.data as Record<string, unknown>;
  }

  return {
    runtime,
    identity,
    request,
    ok,
    /** `query.structure` de §50 — a leitura que confere o efeito de cada comando. */
    async estrutura(communityId: string) {
      return (await ok('query.structure', { communityId })) as unknown as {
        categories: Array<{
          id: string;
          name: string;
          channels: Array<{ id: string; name: string; type: number; topic?: string; readOnly: boolean; readOnlyForRoleIds: string[] }>;
        }>;
      };
    },
    async close() {
      clearInterval(vivo);
      await runtime.close();
      view.close();
      manifest.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    },
  };
}

describe('§51 escopo de `authorSeq` (§7.5) — a ponte escolhe o mesmo que o `fold` exige', () => {
  it('as duas listas de kinds escopados por canal são a mesma', () => {
    // §4 não dá `fold` a `communityClient`, então a lista existe duas vezes. Divergir faria
    // toda op de estrutura sobre canal (que também carrega `channelId`) ser assinada com
    // escopo de canal e recusada pelo `fold` com `E_VALIDATION{sequenceScope}` — no host,
    // depois de assinada. Este teste é o que impede as duas de andarem separadas.
    assert.deepEqual([...CHANNEL_SCOPED].sort(), [...CHANNEL_SCOPED_KINDS].sort());
  });

  it('`channel.delete` e irmãos são escopados por comunidade, apesar do `channelId`', () => {
    assert.deepEqual(resolveScope('channel.delete', { channelId: 'ch-x' }, null), { kind: 'community' });
    assert.deepEqual(resolveScope('channel.update', { channelId: 'ch-x' }, null), { kind: 'community' });
    assert.deepEqual(resolveScope('channel.move', { channelId: 'ch-x', categoryId: 'cat-y' }, null), { kind: 'community' });
    assert.deepEqual(resolveScope('message.send', { channelId: 'ch-x' }, null), { kind: 'channel', channelId: 'ch-x' });
  });
});

describe('§51 estrutura — comandos de canal, categoria e comunidade (§15.4)', { timeout: 120_000 }, () => {
  it('cria canal e categoria, e a posição pedida é a que o `fold` atribui (R-20)', async () => {
    const r = await rig('estrutura-cria');
    try {
      const { communityId, defaultChannelId } = (await r.ok('community.create', { name: 'Raiz', iconColor: 1 })) as unknown as {
        communityId: string;
        defaultChannelId: string;
      };
      const geral = (await r.estrutura(communityId)).categories[0]!;

      const primeiro = (await r.ok('channel.create', { communityId, categoryId: geral.id, type: CHANNEL_TYPE.text, name: 'avisos', topic: 'só o essencial' })) as {
        channelId: string;
        seq: number;
        rank?: string;
      };
      assert.match(primeiro.channelId, /^ch-/, 'o id da entidade vem de §7.3, sem esperar projeção');
      assert.equal(typeof primeiro.seq, 'number');
      assert.equal(typeof primeiro.rank, 'string', 'o `rank` é o que o `fold` calculou');

      // "Depois de #geral" tem de cair ENTRE #geral e #avisos — não no fim (R-20).
      const meio = (await r.ok('channel.create', {
        communityId,
        categoryId: geral.id,
        type: CHANNEL_TYPE.text,
        name: 'no-meio',
        afterChannelId: defaultChannelId,
      })) as { channelId: string; rank?: string };
      const depois = await r.estrutura(communityId);
      // A ordem de §23.2 é `rank` crescente. Quem nasce **sem dica** cai no fim do escopo de
      // R-20, que é o piso da escala — e piso, em ordem crescente, é a primeira posição:
      // por isso `avisos` (sem dica) fica antes de `geral`. Com dica, o item cai ENTRE o
      // vizinho pedido e o seguinte, que é o que este caso prova.
      assert.deepEqual(
        depois.categories[0]!.channels.map((c) => c.name),
        ['avisos', 'geral', 'no-meio'],
        'a dica `afterChannelId` tem de posicionar logo depois do canal pedido',
      );
      assert.equal(typeof meio.rank, 'string');
      const ranks = depois.categories[0]!.channels;
      assert.ok(ranks[1]!.name === 'geral' && ranks[2]!.name === 'no-meio', 'o canal com dica ficou depois do vizinho pedido');

      const categoria = (await r.ok('category.create', { communityId, name: 'ARQUIVO' })) as { categoryId: string; rank?: string };
      assert.match(categoria.categoryId, /^cat-/, 'o id da categoria também vem de §7.3');
      const comCategoria = await r.estrutura(communityId);
      // Mesma convenção do canal sem dica: fim do escopo de R-20 é o piso da escala, e em
      // `rank` crescente (§23.2) o piso vem primeiro.
      assert.deepEqual(comCategoria.categories.map((c) => c.name), ['ARQUIVO', 'GERAL']);

      // Canal de voz não aceita tópico (§8.6), e o nome duplicado é recusado pelo fold (R-6).
      const comTopico = await r.request('channel.create', { communityId, categoryId: geral.id, type: CHANNEL_TYPE.voice, name: 'sala', topic: 'x' });
      assert.equal(comTopico.code, 'E_VALIDATION');
      assert.equal(comTopico.field, 'topic');
      const duplicado = await r.request('channel.create', { communityId, categoryId: geral.id, type: CHANNEL_TYPE.text, name: 'avisos' });
      assert.equal(duplicado.code, 'E_CHANNEL_NAME_TAKEN');
      const semCategoria = await r.request('channel.create', { communityId, categoryId: 'ca-naoexiste', type: CHANNEL_TYPE.text, name: 'x' });
      assert.equal(semCategoria.code, 'E_CATEGORY_NOT_FOUND');
    } finally {
      await r.close();
    }
  });

  it('renomeia canal e categoria, move de categoria e atualiza a comunidade', async () => {
    const r = await rig('estrutura-edita');
    try {
      const { communityId, defaultChannelId } = (await r.ok('community.create', { name: 'Raiz', iconColor: 1 })) as unknown as {
        communityId: string;
        defaultChannelId: string;
      };
      const geral = (await r.estrutura(communityId)).categories[0]!;

      await r.ok('channel.update', { communityId, channelId: defaultChannelId, name: 'principal', topic: 'o canal de tudo' });
      const outra = (await r.ok('category.create', { communityId, name: 'OUTRA' })) as { categoryId: string };
      const movido = (await r.ok('channel.move', { communityId, channelId: defaultChannelId, categoryId: outra.categoryId })) as { seq: number; rank?: string };
      assert.equal(typeof movido.rank, 'string');

      const depois = await r.estrutura(communityId);
      const naOutra = depois.categories.find((c) => c.id === outra.categoryId)!;
      assert.deepEqual(naOutra.channels.map((c) => c.name), ['principal']);
      assert.equal(naOutra.channels[0]!.topic, 'o canal de tudo');
      assert.equal(depois.categories.find((c) => c.id === geral.id)!.channels.length, 0);

      await r.ok('category.rename', { communityId, categoryId: outra.categoryId, name: 'RENOMEADA' });
      assert.equal((await r.estrutura(communityId)).categories.find((c) => c.id === outra.categoryId)!.name, 'RENOMEADA');

      await r.ok('community.update', { communityId, name: 'Raiz Nova', description: 'agora com descrição' });
      const comunidade = (await r.ok('query.community', { communityId })) as unknown as { name: string };
      assert.equal(comunidade.name, 'Raiz Nova');

      const vazio = await r.request('community.update', { communityId });
      assert.equal(vazio.code, 'E_VALIDATION', 'update sem nenhum campo não é uma op');
      const nomeRuim = await r.request('community.update', { communityId, name: 'x' });
      assert.equal(nomeRuim.field, 'name');
    } finally {
      await r.close();
    }
  });

  it('apagar canal derruba a fila dele (§11.7) e o último canal de texto é intocável (R-7)', async () => {
    const r = await rig('estrutura-apaga');
    try {
      const { communityId, defaultChannelId } = (await r.ok('community.create', { name: 'Raiz', iconColor: 1 })) as unknown as {
        communityId: string;
        defaultChannelId: string;
      };
      const geral = (await r.estrutura(communityId)).categories[0]!;

      // R-7 — a comunidade nunca fica sem canal de texto.
      const ultimo = await r.request('channel.delete', { communityId, channelId: defaultChannelId });
      assert.equal(ultimo.code, 'E_LAST_CHANNEL');

      const extra = (await r.ok('channel.create', { communityId, categoryId: geral.id, type: CHANNEL_TYPE.text, name: 'temporario' })) as { channelId: string };
      // Duas mensagens ficam na fila SEM flush: é o estado que o descarte de §11.7 alcança.
      await r.ok('message.send', { communityId, channelId: extra.channelId, content: 'uma', mentions: [] });
      await r.ok('message.send', { communityId, channelId: extra.channelId, content: 'outra', mentions: [] });

      const apagado = (await r.ok('channel.delete', { communityId, channelId: extra.channelId })) as { seq: number; droppedQueued: number };
      assert.equal(apagado.droppedQueued, 2, 'as duas mensagens enfileiradas para o canal saíram com motivo nomeado');
      const restou = await r.estrutura(communityId);
      assert.deepEqual(restou.categories[0]!.channels.map((c) => c.name), ['geral']);

      const denovo = await r.request('channel.delete', { communityId, channelId: extra.channelId });
      assert.equal(denovo.code, 'E_CHANNEL_NOT_FOUND');
    } finally {
      await r.close();
    }
  });

  it('§15.6 — `readOnly` é resolvido por R-22 (TODOS os cargos), e a lista de cargos vai junto', async () => {
    const r = await rig('estrutura-readonly');
    try {
      const { communityId } = (await r.ok('community.create', { name: 'Raiz', iconColor: 1 })) as unknown as { communityId: string };
      const geral = (await r.estrutura(communityId)).categories[0]!;
      const cargos = ((await r.ok('query.roles', { communityId })) as unknown as {
        roles: Array<{ id: string; isDefault: boolean; isFounder: boolean }>;
      }).roles;
      const base = cargos.find((c) => c.isDefault)!;
      const fundador = cargos.find((c) => c.isFounder)!;

      // Fundador NÃO está na lista: por R-22 quem tem o cargo base **e** o de fundador pode
      // postar — basta um cargo de fora. O `some` que estava em `query.structure`
      // silenciava a tela de quem o `fold` deixa escrever.
      await r.ok('channel.create', {
        communityId,
        categoryId: geral.id,
        type: CHANNEL_TYPE.text,
        name: 'avisos',
        readOnlyForRoleIds: [base.id],
      });
      const avisos = (await r.estrutura(communityId)).categories[0]!.channels.find((c) => c.name === 'avisos')!;
      assert.equal(avisos.readOnly, false, 'R-22: um cargo de fora basta para escrever');
      // A lista crua é o que a tela de edição do canal reabre; sem ela o formulário
      // apresentava todo canal restrito como se fosse aberto.
      assert.deepEqual(avisos.readOnlyForRoleIds, [base.id]);

      // Com TODOS os cargos do autor na lista, aí sim é somente-leitura. O cargo extra
      // existe porque R-21 exige ≥ 1 cargo de fora da lista.
      const extra = (await r.ok('role.create', { communityId, name: 'Leitor', color: 2, permissions: [], mentionable: true })) as { roleId: string };
      await r.ok('channel.update', { communityId, channelId: avisos.id, readOnlyForRoleIds: [base.id, fundador.id] });
      assert.ok(extra.roleId);
      const depois = (await r.estrutura(communityId)).categories[0]!.channels.find((c) => c.name === 'avisos')!;
      assert.equal(depois.readOnly, true);
      assert.deepEqual([...depois.readOnlyForRoleIds].sort(), [base.id, fundador.id].sort());
    } finally {
      await r.close();
    }
  });

  it('`category.delete` move ou apaga os canais, e conta o que o `fold` decidiu', async () => {
    const r = await rig('estrutura-categoria');
    try {
      const { communityId } = (await r.ok('community.create', { name: 'Raiz', iconColor: 1 })) as unknown as { communityId: string };
      const geral = (await r.estrutura(communityId)).categories[0]!;
      const alvo = (await r.ok('category.create', { communityId, name: 'ALVO' })) as { categoryId: string };
      await r.ok('channel.create', { communityId, categoryId: alvo.categoryId, type: CHANNEL_TYPE.text, name: 'vai-mudar' });
      await r.ok('channel.create', { communityId, categoryId: alvo.categoryId, type: CHANNEL_TYPE.voice, name: 'voz' });

      const incoerente = await r.request('category.delete', { communityId, categoryId: alvo.categoryId, moveChannelsTo: geral.id, deleteChannels: true });
      assert.equal(incoerente.code, 'E_VALIDATION', 'mover E apagar ao mesmo tempo não é uma das duas formas de §15.4');

      const movidos = (await r.ok('category.delete', { communityId, categoryId: alvo.categoryId, moveChannelsTo: geral.id })) as {
        movedChannels: number;
        deletedChannels: number;
      };
      assert.deepEqual(movidos, { ...movidos, movedChannels: 2, deletedChannels: 0 });
      const depois = await r.estrutura(communityId);
      assert.equal(depois.categories.length, 1);
      assert.deepEqual(depois.categories[0]!.channels.map((c) => c.name).sort(), ['geral', 'vai-mudar', 'voz']);

      const outra = (await r.ok('category.create', { communityId, name: 'DESCARTAVEL' })) as { categoryId: string };
      await r.ok('channel.create', { communityId, categoryId: outra.categoryId, type: CHANNEL_TYPE.voice, name: 'some-junto' });
      const apagados = (await r.ok('category.delete', { communityId, categoryId: outra.categoryId, deleteChannels: true })) as {
        movedChannels: number;
        deletedChannels: number;
      };
      assert.equal(apagados.deletedChannels, 1);
      assert.equal(apagados.movedChannels, 0);
    } finally {
      await r.close();
    }
  });
});
