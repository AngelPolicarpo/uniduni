// §56 — draining de §18.7 via `core.shutdown`, `core.reproject`, o gatilho local da
// assinatura de typing de §17.6 (emenda de 2026-08-23 em §15.4) e os produtores NDJSON de
// §24 com o `metrics.flush` de §22.1.
//
//   §18.7  — a resposta é honesta: `{drainedMs, pendingOps, replicatedTo}`;
//   §15.4  — `core.reproject` é main-confirmed; o estado volta idêntico do log;
//   §17.6  — typing só para quem chamou subscribeChannel no canal; no membro o comando
//            espelha por §16.2; sem canal vivo não há frame (§11.8);
//   §24.1/2 — linha NDJSON com campos da allowlist; displayName/conteúdo NUNCA saem;
//   §24.3  — `metrics.flush` comete gauges que `diag.snapshot` serve.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { alvoDeReplicacao, opsForaDaBarreira } from '../src/composition/boot.ts';
import { ManifestDb } from '../src/l0/manifest/index.ts';
import { openViewDb } from '../src/l0/view/index.ts';
import { Swarm } from '../src/l0/swarm/index.ts';
import { IdentityManager } from '../src/l0/identity/index.ts';
import { FallbackKeystoreOracle, acceptInsecure } from '../src/l0/keystore/index.ts';
import { MemoryIpcPort } from '../src/l3/ipcRenderer/index.ts';
import { RpcServer, type RpcTransportPort } from '../src/l3/rpcServer/index.ts';
import { PresenceManager } from '../src/l2/presence/index.ts';
import { OP_VERSION } from '../src/l1/opCodec/index.ts';
import type { CoreRuntime } from '../src/composition/boot.ts';
import { bootCore } from '../src/composition/boot.ts';
import { wireHostPresenceRpc, wireHostRpc, tempDir, rpcPair } from './helpers/composition.ts';
import { NdjsonLogger, silentLogger } from '../src/composition/logger.ts';
import { T0, World, genesis, joinMember, keypairFromSeed } from './helpers/world.ts';

const DATA_KEY = Buffer.alloc(32, 99);

type Frame = Record<string, unknown>;
type Resposta = { ok: boolean; data: unknown; code: string | null };

function cabo(rendererSide: MemoryIpcPort) {
  const pendentes = new Map<number, (r: Resposta) => void>();
  const assinaturas = new Map<number, Frame[]>();
  let proximoId = 5000;
  rendererSide.onMessage((raw) => {
    const frame = raw as Frame;
    if (frame['t'] === 'res') {
      const resolver = pendentes.get(frame['id'] as number);
      if (resolver !== undefined) {
        pendentes.delete(frame['id'] as number);
        const erro = frame['err'] as { code?: string } | undefined;
        resolver({ ok: frame['ok'] as boolean, data: frame['data'], code: erro?.code ?? null });
      }
      return;
    }
    if (frame['t'] === 'ev') assinaturas.get(frame['subId'] as number)?.push(frame['data'] as Frame);
  });
  return {
    async request(cmd: string, arg: unknown): Promise<Resposta> {
      const id = ++proximoId;
      return await new Promise<Resposta>((resolve) => {
        pendentes.set(id, resolve);
        rendererSide.postMessage({ t: 'req', epoch: 1, id, cmd, arg, authToken: 'ok' });
      });
    },
    assinar(topic: string): Frame[] {
      const id = ++proximoId;
      const lista: Frame[] = [];
      rendererSide.postMessage({ t: 'sub', epoch: 1, id, topic });
      rendererSide.onMessage((raw) => {
        const f = raw as Frame;
        if (f['t'] === 'subOk' && f['id'] === id) assinaturas.set(f['subId'] as number, lista);
      });
      return lista;
    },
  };
}

async function esperar(cond: () => boolean, msg: string, timeoutMs = 10_000): Promise<void> {
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`${msg} (esperou ${timeoutMs} ms)`);
}

/** Rig hospedeiro completo (identidade real, disco real). */
async function rigHost(rotulo: string) {
  const dir = tempDir(rotulo);
  const manifest = new ManifestDb(path.join(dir, 'manifest.db'));
  const view = openViewDb(path.join(dir, 'view.db'));
  const manager = new IdentityManager(dir, new FallbackKeystoreOracle(), manifest);
  await manager.create('Dona Raiz', 3);
  acceptInsecure(dir, 'rig');
  const [coreSide, rendererSide] = MemoryIpcPort.createPair();
  const runtime: CoreRuntime = await bootCore({
    dataDir: dir,
    manifest,
    view,
    swarm: new Swarm(),
    dataKey: DATA_KEY,
    identity: () => manager.getKeyPair(),
    identityManager: manager,
    foldBuildId: `shell-56c-${rotulo}`,
    ipcPort: coreSide,
    epoch: 1,
    tokenVerifier: { consume: () => true },
    hostTurnSecret: () => Buffer.alloc(32, 7),
    now: () => T0 + 1000,
    schedule: () => 0,
    cancel: () => {},
    // logger ausente → o default de produto grava `<dataDir>/logs` — é o que este rig testa.
  });
  const vivo = setInterval(() => {}, 5);
  const limpo = { valor: false };
  return {
    runtime,
    manager,
    manifest,
    view,
    dir,
    io: cabo(rendererSide),
    async fechar() {
      clearInterval(vivo);
      if (limpo.valor) return;
      limpo.valor = true;
      if (runtime.phase !== 'stopped') await runtime.close().catch(() => {});
      try {
        view.close();
      } catch {}
      try {
        manifest.close();
      } catch {}
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    },
  };
}

describe('§56.6 core.shutdown e core.reproject (§18.7, §15.4)', () => {
  it('shutdown drena, devolve contadores honestos e para o núcleo; reproject reconstrói do log', async () => {
    const r = await rigHost('shutdown');
    try {
      const criada = await r.io.request('community.create', { name: 'Dreno', iconColor: 1 });
      assert.ok(criada.ok, JSON.stringify(criada));
      const cid = (criada.data as Record<string, unknown>)['communityId'] as string;
      const canal = (criada.data as Record<string, unknown>)['defaultChannelId'] as string;

      const enviada = await r.io.request('message.send', { communityId: cid, channelId: canal, content: 'antes do dreno', mentions: [] });
      assert.ok(enviada.ok, JSON.stringify(enviada));
      await r.runtime.loops!.runNow('outbox.flush');
      const c = r.runtime.get(cid)!;
      await esperar(() => c.projector.interpretedSeq >= c.core.length - 1, 'projeção não alcançou a cabeça');
      await r.runtime.loops!.runNow('outbox.reconcile');

      // Reproject é main-confirmed por tabela; aqui o token sempre vale.
      const rp = await r.io.request('core.reproject', { communityId: cid });
      assert.ok(rp.ok, JSON.stringify(rp));
      const depois = (await r.io.request('query.messages', { communityId: cid, channelId: canal })).data as { messages: Array<{ content: string }> };
      assert.ok(depois.messages.some((m) => m.content === 'antes do dreno'), 'reproject perdeu mensagem');

      const desligar = (await r.io.request('core.shutdown', {})) as { ok: boolean; data: unknown };
      assert.ok(desligar.ok, JSON.stringify(desligar));
      const resumo = desligar.data as { drainedMs: number; pendingOps: number; replicatedTo: number };
      assert.equal(resumo.pendingOps, 0);
      // §18.7 passo 2 (B10) — `replicatedTo` conta PARES que confirmaram a cabeça, não até
      // onde esta máquina interpretou. Aqui não há par nenhum, e a resposta honesta é 0:
      // um host sozinho no swarm não replicou para ninguém, por mais em dia que esteja
      // consigo mesmo. A redação anterior devolvia a própria cabeça e chamava isso de
      // replicação.
      assert.equal(resumo.replicatedTo, 0);
      // E o dreno não fica preso: sem outro membro ativo o alvo de §18.7 é
      // `min(3, memberCount − 1) = 0`, então não há por quem esperar.
      assert.ok(resumo.drainedMs < 4_000, `dreno não deveria esperar por par nenhum (${resumo.drainedMs} ms)`);
      await esperar(() => r.runtime.phase === 'stopped', 'núcleo não parou');
    } finally {
      await r.fechar();
    }
  });
});

describe('§56.7 channel.subscribeTyping — o gatilho local da assinatura de §17.6', () => {
  it('no host assina no agregador; no membro espelha por §16.2; sem canal não há frame (§11.8)', async () => {
    // ── Host: assinatura local no PresenceManager da comunidade ──
    const h = await rigHost('typing-host');
    try {
      const criada = await h.io.request('community.create', { name: 'Typing', iconColor: 3 });
      assert.ok(criada.ok, JSON.stringify(criada));
      const cid = (criada.data as Record<string, unknown>)['communityId'] as string;
      const canal = (criada.data as Record<string, unknown>)['defaultChannelId'] as string;
      const euHex = h.manager.publicKeyHex!;
      assert.equal(h.runtime.get(cid)!.presence.getTypingSubscribers(cid, canal).length, 0);
      const on = await h.io.request('channel.subscribeTyping', { communityId: cid, channelId: canal, on: true });
      assert.ok(on.ok, JSON.stringify(on));
      assert.deepEqual(h.runtime.get(cid)!.presence.getTypingSubscribers(cid, canal), [euHex]);
      const off = await h.io.request('channel.subscribeTyping', { communityId: cid, channelId: canal, on: false });
      assert.ok(off.ok);
      assert.equal(h.runtime.get(cid)!.presence.getTypingSubscribers(cid, canal).length, 0);
    } finally {
      await h.fechar();
    }

    // ── Membro real sobre world.log: espelha para o servidor RPC do host ──
    const dir = tempDir('typing-membro');
    const manifest = new ManifestDb(path.join(dir, 'manifest.db'));
    const view = openViewDb(path.join(dir, 'view.db'));
    const g = genesis(new World(keypairFromSeed('typing-core')), keypairFromSeed('typing-fundador'));
    const membro = joinMember(g, 'typing-membro-eu');
    const cid = g.world.core.publicKey.toString('hex');
    manifest.upsertCommunity({
      communityId: cid,
      coreKey: g.world.core.publicKey,
      blobsKey: keypairFromSeed('typing-blobs').publicKey,
      isHost: false,
      joinedAt: T0,
    });
    const nucleo = {
      key: g.world.core.publicKey,
      get length() {
        return g.world.log.length;
      },
      get: async (seq: number) => (g.world.log as Array<Uint8Array | undefined>)[seq] ?? null,
      onAppend: () => () => {},
      close: async () => {},
    };
    const presenceDoHost = new PresenceManager({ clock: { now: () => T0 }, isHost: () => true });
    const [serverSide, clientSide] = rpcPair();
    const server = new RpcServer({ protocol: 'community', transport: serverSide });
    wireHostRpc(server, {
      admission: { submit: async () => ({ ok: false as const, code: 'E_INTERNAL' }) },
      hello: { hostVersion: 'rig', opVersion: OP_VERSION, coreLength: 8, memberCount: 2, capabilities: [] },
    });
    wireHostPresenceRpc(server, { communityId: cid, peerKeyHex: membro.publicKey.toString('hex'), presence: presenceDoHost });

    const [coreSide, rendererSide] = MemoryIpcPort.createPair();
    const runtimeMembro: CoreRuntime = await bootCore({
      dataDir: dir,
      manifest,
      view,
      swarm: new Swarm(),
      dataKey: DATA_KEY,
      identity: () => membro,
      foldBuildId: 'shell-56c-membro',
      ipcPort: coreSide,
      epoch: 1,
      tokenVerifier: { consume: () => true },
      hostTurnSecret: () => Buffer.alloc(32, 7),
      now: () => T0,
      schedule: () => 0,
      cancel: () => {},
      logger: silentLogger(),
      openCore: async () => nucleo,
    });
    const vivo = setInterval(() => {}, 5);
    const io = cabo(rendererSide);
    try {
      runtimeMembro.attachHostChannel({ communityId: cid, transport: clientSide });
      await esperar(() => runtimeMembro.hostStatus?.statusOf(cid) === 'online', 'canal não ficou online');

      const r = await io.request('channel.subscribeTyping', { communityId: cid, channelId: g.channelId, on: true });
      assert.ok(r.ok, JSON.stringify(r));
      await esperar(
        () => presenceDoHost.getTypingSubscribers(cid, g.channelId).includes(membro.publicKey.toString('hex')),
        'a assinatura não chegou ao host por §16.2',
      );
    } finally {
      clearInterval(vivo);
      await runtimeMembro.close();
      view.close();
      manifest.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});

describe('§15.4 (2026-09-06) channel.typing — a outra metade do "digitando…"', () => {
  it('no host publica no agregador local e emite typing.changed a quem assinou', async () => {
    const h = await rigHost('typing-publica');
    try {
      const criada = await h.io.request('community.create', { name: 'Typing', iconColor: 3 });
      assert.ok(criada.ok, JSON.stringify(criada));
      const cid = (criada.data as Record<string, unknown>)['communityId'] as string;
      const canal = (criada.data as Record<string, unknown>)['defaultChannelId'] as string;
      const euHex = h.manager.publicKeyHex!;

      // Sem este comando, `typingChannelId` de §16.2 não tinha produtor em lugar nenhum do
      // produto: `publishTyping` era código sem chamador e o indicador estava morto.
      const assinou = await h.io.request('channel.subscribeTyping', { communityId: cid, channelId: canal, on: true });
      assert.ok(assinou.ok, JSON.stringify(assinou));
      const r = await h.io.request('channel.typing', { communityId: cid, channelId: canal });
      assert.ok(r.ok, JSON.stringify(r));
      assert.deepEqual(h.runtime.get(cid)!.presence.getTypingForChannel(cid, canal), [euHex]);

      // §17.6 — teto de 1 / 2 s por autor e canal; a segunda dentro da janela é recusada.
      const repetida = await h.io.request('channel.typing', { communityId: cid, channelId: canal });
      assert.equal(repetida.ok, false);
      assert.equal(repetida.code, 'E_RATE_LIMITED');
    } finally {
      await h.fechar();
    }
  });

  it('`invisible` não publica typing — §6.16 vale para o comando novo também', async () => {
    const h = await rigHost('typing-invisivel');
    try {
      const criada = await h.io.request('community.create', { name: 'Typing', iconColor: 3 });
      assert.ok(criada.ok, JSON.stringify(criada));
      const cid = (criada.data as Record<string, unknown>)['communityId'] as string;
      const canal = (criada.data as Record<string, unknown>)['defaultChannelId'] as string;

      const p = await h.io.request('identity.setPresence', { presence: 'invisible' });
      assert.ok(p.ok, JSON.stringify(p));
      const r = await h.io.request('channel.typing', { communityId: cid, channelId: canal });
      // Aceito e sem efeito: quem escolheu ficar invisível não precisa de aviso a cada tecla.
      assert.ok(r.ok, JSON.stringify(r));
      assert.deepEqual(h.runtime.get(cid)!.presence.getTypingForChannel(cid, canal), []);
    } finally {
      await h.fechar();
    }
  });
});

describe('§56.8 produtores NDJSON e metrics.flush (§24.1, §24.2, §22.1)', () => {
  it('o log diário nasce com allowlist estrutural e sem conteúdo de usuário; diag serve os gauges', async () => {
    const r = await rigHost('ndjson');
    try {
      const criada = await r.io.request('community.create', { name: 'Logzinho', iconColor: 1 });
      assert.ok(criada.ok, JSON.stringify(criada));
      const cid = (criada.data as Record<string, unknown>)['communityId'] as string;
      const canal = (criada.data as Record<string, unknown>)['defaultChannelId'] as string;

      const enviada = await r.io.request('message.send', { communityId: cid, channelId: canal, content: 'SEGREDO-DO-CORPO', mentions: [] });
      assert.ok(enviada.ok, JSON.stringify(enviada));
      const opId = (enviada.data as Record<string, unknown>)['opId'] as string;
      await r.runtime.loops!.runNow('outbox.flush');
      // §11.6 — a remoção acontece pela OBSERVAÇÃO da op na réplica; é ela que espero.
      await esperar(() => r.runtime.get(cid)!.projector.observedOp(opId) !== null, 'op nunca foi observada');
      await r.runtime.loops!.runNow('outbox.reconcile');
      await r.runtime.loops!.runNow('metrics.flush');

      const arquivos = fs.readdirSync(path.join(r.dir, 'logs')).filter((f) => f.endsWith('.ndjson'));
      assert.equal(arquivos.length, 1);
      assert.match(arquivos[0]!, /^core-\d{4}-\d{2}-\d{2}\.ndjson$/);
      const linhas = fs
        .readFileSync(path.join(r.dir, 'logs', arquivos[0]!), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      assert.ok(linhas.length >= 2);

      // Allowlist ESTRUTURAL: nenhum campo fora da lista de §24.1 em linha nenhuma.
      const permitidos = new Set(['ts', 'level', 'scope', 'msg', 'communityId', 'channelId', 'opId', 'kind', 'seq', 'durMs', 'code', 'epoch']);
      for (const l of linhas) {
        for (const k of Object.keys(l)) {
          assert.ok(permitidos.has(k), `campo ${k} fora da allowlist`);
        }
        assert.equal(typeof l['ts'], 'number');
        assert.equal(typeof l['level'], 'string');
        assert.equal(typeof l['scope'], 'string');
        assert.equal(typeof l['msg'], 'string');
      }

      // Redação de §24.2: nome de comunidade e conteúdo de mensagem nunca aparecem.
      const bruto = linhas.map((l) => JSON.stringify(l)).join('\n');
      assert.ok(!bruto.includes('Logzinho'), 'displayName/nome vazou no log');
      assert.ok(!bruto.includes('SEGREDO-DO-CORPO'), 'conteúdo vazou no log');
      const outbox = linhas.find((l) => l['scope'] === 'outbox' && l['msg'] === 'accepted');
      assert.notEqual(outbox, undefined, 'desfecho accepted não virou linha');
      assert.equal(outbox!['opId'], opId);
      assert.ok(linhas.some((l) => l['scope'] === 'host'), 'transições do host não viraram linha');
      assert.ok(linhas.some((l) => l['scope'] === 'metrics' && l['msg'] === 'flush'), 'metrics.flush não registrou');

      // §24.3 — o registro central é o que diag.snapshot serve.
      const snap = (await r.io.request('diag.snapshot', {})).data as { gauges: Record<string, number> };
      assert.equal(typeof snap.gauges['swarm.peers'], 'number');
      const serie = `outbox.depth.${cid.slice(0, 8)}`;
      assert.equal(typeof snap.gauges[serie], 'number');
      assert.equal(snap.gauges[serie], 0); // fila reconciliada antes do flush
    } finally {
      await r.fechar();
    }
  });

  it('debug fica desligado no canal prod e liga no dev (§24.1)', () => {
    const dir = tempDir('logger-niveis');
    try {
      const agora = Date.UTC(2026, 7, 23, 12);
      const prod = new NdjsonLogger({ dir, now: () => agora });
      prod.debug('x', 'some');
      prod.info('x', 'fica');
      const dev = new NdjsonLogger({ dir, now: () => agora, buildChannel: 'dev' });
      dev.debug('x', 'liga');
      const linhas = fs.readFileSync(path.join(dir, 'core-2026-08-23.ndjson'), 'utf8').trim().split('\n');
      const msgs = linhas.map((l) => (JSON.parse(l) as Record<string, unknown>)['msg']);
      assert.deepEqual(msgs, ['fica', 'liga']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});

// ─── B10: a barreira de §18.7 é por confirmação de PARES ────────────────────────────────

describe('§18.7 passo 2 — a barreira conta pares, não sinal local (B10)', () => {
  it('o alvo é `min(3, memberCount − 1)` — e um host sozinho não espera por ninguém', () => {
    assert.equal(alvoDeReplicacao(1), 0, 'host sozinho: não há para quem replicar');
    assert.equal(alvoDeReplicacao(2), 1, 'dois membros não podem esperar por três pares');
    assert.equal(alvoDeReplicacao(3), 2);
    assert.equal(alvoDeReplicacao(4), 3);
    assert.equal(alvoDeReplicacao(340), 3, 'três bastam: o alvo satura, não cresce com a comunidade');
    assert.equal(alvoDeReplicacao(0), 0);
  });

  /** `confirmam(n)` = quantos pares têm o log contíguo até `n`. Monótona decrescente. */
  function comPares(comprimentos: readonly number[]): (ate: number) => number {
    return (ate) => comprimentos.filter((c) => c >= ate).length;
  }

  it('nada fora da barreira quando o alvo já foi alcançado na cabeça', () => {
    assert.equal(opsForaDaBarreira({ length: 10, alvo: 2, confirmam: comPares([10, 10, 4]) }), 0);
  });

  it('conta o que falta contra o k-ésimo melhor par, não contra o melhor', () => {
    // Um par com tudo e outro com metade: com alvo 2, a barreira está em 5, não em 10.
    // Ler o melhor par diria "replicado" sobre ops que existem num disco só.
    assert.equal(opsForaDaBarreira({ length: 10, alvo: 2, confirmam: comPares([10, 5]) }), 5);
    // Com alvo 1, o melhor par basta e nada falta.
    assert.equal(opsForaDaBarreira({ length: 10, alvo: 1, confirmam: comPares([10, 5]) }), 0);
  });

  it('com menos pares que o alvo, o log INTEIRO está fora da barreira', () => {
    assert.equal(opsForaDaBarreira({ length: 10, alvo: 3, confirmam: comPares([10, 10]) }), 10);
    assert.equal(opsForaDaBarreira({ length: 10, alvo: 1, confirmam: comPares([]) }), 10);
  });

  it('alvo zero nunca segura nada — é o host sozinho, e esperar só atrasaria o fechamento', () => {
    assert.equal(opsForaDaBarreira({ length: 999, alvo: 0, confirmam: comPares([]) }), 0);
  });

  it('a busca binária acha a barreira exata em qualquer posição', () => {
    for (let barreira = 0; barreira <= 16; barreira++) {
      assert.equal(
        opsForaDaBarreira({ length: 16, alvo: 2, confirmam: comPares([16, barreira, 0]) }),
        16 - barreira,
        `barreira em ${barreira}`,
      );
    }
  });
});
