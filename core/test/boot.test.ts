// §44 — o boot do `utilityProcess`: a raiz de composição de §4 montando o grafo.
//
// O que se testa aqui não é nenhuma das peças (todas já têm suíte própria), e sim as
// **ligações** que só existem quando alguém monta o grafo: o fan-out de §38.2 recebendo os
// dois produtores, a escolha do modo de mídia por comunidade (§42.3/§43.3), a cadência de
// §17.4 com relógio injetado, o mapa conexão↔membro que `peerSignalRelay` consulta (§43.3) e
// as portas de §35.2/§37.2 na frente do roteador de §15.4.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { MEDIA_TICKET_TTL_MS } from '../src/l1/fold/index.ts';
import { permissionNumber } from '../src/l1/permissions/index.ts';
import { OP_VERSION } from '../src/l1/opCodec/index.ts';
import { deriveCommunityKeyPairs, type CoreHandle } from '../src/l0/corestore/index.ts';
import { ManifestDb } from '../src/l0/manifest/index.ts';
import { openViewDb } from '../src/l0/view/index.ts';
import { Swarm } from '../src/l0/swarm/index.ts';
import { HostAdmission } from '../src/l2/communityHost/index.ts';
import { MemoryIpcPort } from '../src/l3/ipcRenderer/index.ts';
import { RpcClient } from '../src/l3/rpcClient/index.ts';
import { RpcServer } from '../src/l3/rpcServer/index.ts';
import { bootCore, type CoreRuntime } from '../src/composition/boot.ts';
import { hostRecordSigner, storeCommunitySeed, wireHostRpc } from '../src/composition/ports.ts';
import { MemoryRpcChannel, rpcPair, tempDir } from './helpers/composition.ts';
import { T0, World, genesis, joinMember, makeRecord } from './helpers/world.ts';

const SEED = Buffer.alloc(32, 9);
const DATA_KEY = Buffer.alloc(32, 3);

/** Um `CoreHandle` gravável sobre memória — o boot recebe o core pronto pela porta. */
function memoryCore(blocks: Uint8Array[], key: Buffer): CoreHandle & { append(b: readonly Uint8Array[]): Promise<void> } {
  const listeners = new Set<() => void>();
  return {
    key,
    get length() {
      return blocks.length;
    },
    get: async (seq: number) => blocks[seq] ?? null,
    onAppend: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    append: async (novos: readonly Uint8Array[]) => {
      blocks.push(...novos.map((b) => Buffer.from(b)));
      for (const l of listeners) l();
    },
    close: async () => {},
  };
}

type Rig = Awaited<ReturnType<typeof bootRig>>;

/**
 * O boot completo sobre módulos reais, com três injeções e só três: o core em memória
 * (para não pagar hypercore em disco), o relógio da cadência e o transporte de §16.1 —
 * exatamente as costuras que a fase do transporte real preenche.
 */
async function bootRig(opts: { readonly hosted: boolean }) {
  const dir = tempDir('boot');
  const pares = deriveCommunityKeyPairs(SEED);
  const world = new World(pares.log);
  const g = genesis(world);
  const ana = joinMember(g, 'ana-boot');
  const bea = joinMember(g, 'bea-boot');
  world.submit({
    kind: 'channel.create',
    author: g.founder,
    hostTs: T0 + 120,
    payload: { categoryId: g.categoryId, type: 1, name: 'voz', readOnlyForRoleIds: [] },
  });
  const voiceChannelId = world.id('channel', g.founder, world.authorSeq.get(g.founder.publicKey.toString('hex'))!);
  // O cargo base de §19.1 nasce com quatro permissões e `voice_share_screen` não é uma
  // delas — sem esta linha nenhum membro do rig consegue abrir uma sessão de tela.
  world.submit({
    kind: 'role.update',
    author: g.founder,
    hostTs: T0 + 130,
    payload: {
      roleId: g.baseRoleId,
      permissions: ['send_messages', 'attach_files', 'add_reactions', 'voice_speak', 'voice_share_screen'].map(
        (nome) => permissionNumber(nome as Parameters<typeof permissionNumber>[0]),
      ),
    },
  });

  const communityId = pares.log.publicKey.toString('hex');
  const blocks = [...world.log].map((b) => Buffer.from(b));
  const core = memoryCore(blocks, pares.log.publicKey);

  const manifest = new ManifestDb(path.join(dir, 'manifest.db'));
  if (opts.hosted) {
    storeCommunitySeed(
      manifest,
      { communityId, coreKey: pares.log.publicKey, blobsKey: pares.blobs.publicKey, communitySeed: SEED, isHost: true, joinedAt: T0 },
      DATA_KEY,
    );
  } else {
    manifest.upsertCommunity({
      communityId,
      coreKey: pares.log.publicKey,
      blobsKey: pares.blobs.publicKey,
      isHost: false,
      joinedAt: T0,
    });
  }
  const view = openViewDb(path.join(dir, 'view.db'));

  const agendados: Array<{ ms: number; fn: () => void }> = [];
  const [coreSide, rendererSide] = MemoryIpcPort.createPair();
  const eventos: Array<{ topic: string; data: Record<string, unknown> }> = [];
  const subs = new Map<number, string>();
  rendererSide.onMessage((frame) => {
    if (frame.t === 'subOk') subs.set(frame.subId, 'ok');
    if (frame.t === 'ev') eventos.push({ topic: frame.topic, data: frame.data as Record<string, unknown> });
  });

  const identidade = opts.hosted ? g.founder : ana;
  const runtime: CoreRuntime = await bootCore({
    dataDir: dir,
    manifest,
    view,
    swarm: new Swarm(),
    dataKey: DATA_KEY,
    identity: () => identidade,
    foldBuildId: 'boot-test',
    ipcPort: coreSide,
    epoch: 1,
    tokenVerifier: { consume: () => true },
    hostTurnSecret: () => Buffer.alloc(32, 7),
    now: () => T0 + 1_000,
    schedule: (fn, ms) => {
      agendados.push({ ms, fn });
      return agendados.length;
    },
    cancel: () => {},
    openCore: async () => core,
  });

  // Lado host do canal de §16.1 quando o rig roda em modo membro: os mesmos módulos de
  // produto do outro lado do fio, para que a outbox tenha a quem submeter.
  let hostRemoto: { channel: MemoryRpcChannel; admission: HostAdmission } | null = null;
  if (!opts.hosted) {
    const [hostSide, memberSide] = rpcPair();
    const admission = new HostAdmission({
      core,
      state: runtime.get(communityId)!.projector.ds,
      makeHostRecord: hostRecordSigner(pares.log.secretKey),
      now: () => T0 + 1_000,
      groupWindowMs: 1,
      groupMax: 8,
    });
    const server = new RpcServer({ protocol: 'community', transport: hostSide });
    wireHostRpc(server, {
      admission,
      hello: { hostVersion: 'x', opVersion: OP_VERSION, coreLength: core.length, memberCount: 2, capabilities: [] },
    });
    runtime.attachHostChannel({ communityId, transport: memberSide });
    hostRemoto = { channel: memberSide, admission };
  }

  /** Assina um tópico pelo IPC-R e devolve quando o `subOk` chegou. */
  async function subscribe(topic: string): Promise<void> {
    rendererSide.postMessage({ t: 'sub', epoch: 1, id: eventos.length + 1000, topic });
    await tick();
  }

  async function request(cmd: string, arg: unknown): Promise<{ ok: boolean; data: unknown; code: string | null }> {
    const id = 9000 + Math.floor(Math.random() * 1000);
    const resposta = new Promise<{ ok: boolean; data: unknown; code: string | null }>((resolve) => {
      rendererSide.onMessage((frame) => {
        if (frame.t === 'res' && frame.id === id) resolve({ ok: frame.ok, data: frame.data, code: frame.err?.code ?? null });
      });
    });
    rendererSide.postMessage({ t: 'req', epoch: 1, id, cmd, arg, authToken: 'ok' });
    return await resposta;
  }

  return {
    dir,
    g,
    ana,
    bea,
    world,
    core,
    blocks,
    communityId,
    voiceChannelId,
    runtime,
    manifest,
    agendados,
    eventos,
    subscribe,
    request,
    hostRemoto,
    async cleanup() {
      await runtime.close();
      view.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    },
  };
}

/** Deixa microtasks (MemoryIpcPort/MemoryRpcChannel entregam por `queueMicrotask`) correrem. */
async function tick(vezes = 12): Promise<void> {
  for (let i = 0; i < vezes; i++) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
}

describe('§44 boot — fan-out dos dois produtores (§38.2)', () => {
  it('o lote do projector chega ao renderer sem intermediário', async () => {
    const rig = await bootRig({ hosted: false });
    try {
      await rig.subscribe('messages.appended');
      const antes = rig.core.length;
      await rig.core.append([
        makeRecord(deriveCommunityKeyPairs(SEED).log, {
          kind: 'message.send',
          author: rig.ana,
          authorSeq: 1,
          sequenceScope: { kind: 'channel', channelId: rig.g.channelId },
          hostTs: T0 + 900,
          payload: { channelId: rig.g.channelId, content: 'oi', mentions: [] },
        }),
      ]);
      await tick(40);
      const ev = rig.eventos.find((e) => e.topic === 'messages.appended');
      assert.ok(ev, 'nenhum messages.appended chegou ao renderer');
      assert.equal(ev.data['channelId'], rig.g.channelId);
      // §38: o lote é agregado por canal — `fromSeq`/`toSeq`, não um evento por registro.
      assert.equal(ev.data['fromSeq'], antes);
      assert.equal(ev.data['toSeq'], antes);
    } finally {
      await rig.cleanup();
    }
  });

  it('o desfecho da outbox chega pelo mesmo fan-out, depois do lote', async () => {
    const rig = await bootRig({ hosted: false });
    try {
      await rig.subscribe('messages.appended');
      await rig.subscribe('message.accepted');
      const enfileirada = rig.runtime.client.submitQueued(rig.communityId, {
        kindName: 'message.send',
        payload: { channelId: rig.g.channelId, content: 'pela fila', mentions: [] },
      });
      assert.ok(enfileirada.ok, `submitQueued recusou: ${JSON.stringify(enfileirada)}`);
      const outbox = rig.runtime.get(rig.communityId)!.outbox!;
      await outbox.flush();
      await tick(40);
      outbox.reconcile();
      await tick(40);

      const topicos = rig.eventos.map((e) => e.topic);
      const iLote = topicos.indexOf('messages.appended');
      const iAceite = topicos.indexOf('message.accepted');
      assert.ok(iLote >= 0, 'o lote não foi projetado');
      assert.ok(iAceite >= 0, 'o desfecho da outbox não chegou');
      // DS-31 ponta a ponta: o lote precede o aceite, e a entrega do fan-out é em ordem.
      assert.ok(iLote < iAceite, 'message.accepted chegou antes de messages.appended');
      assert.equal(rig.eventos[iAceite]!.data['opId'], enfileirada.opId);
    } finally {
      await rig.cleanup();
    }
  });
});

describe('§44 boot — modo de mídia por comunidade (§42.3, §43.3)', () => {
  it('quem hospeda recebe o dispatcher local; quem não hospeda, o remoto', async () => {
    const hospeda = await bootRig({ hosted: true });
    const membro = await bootRig({ hosted: false });
    try {
      assert.equal(hospeda.runtime.get(hospeda.communityId)!.dispatcher.mode, 'host');
      assert.notEqual(hospeda.runtime.get(hospeda.communityId)!.host, null);
      assert.equal(membro.runtime.get(membro.communityId)!.dispatcher.mode, 'member');
      assert.equal(membro.runtime.get(membro.communityId)!.host, null);
      // O canal de §16.1 só existe de quem não hospeda para o host: o host não fala consigo.
      assert.equal(hospeda.runtime.get(hospeda.communityId)!.rpc, null);
      assert.notEqual(membro.runtime.get(membro.communityId)!.rpc, null);
    } finally {
      await hospeda.cleanup();
      await membro.cleanup();
    }
  });

  it('a cadência de renovação de ticket é MEDIA_TICKET_TTL_MS/3 (§17.4 emendado)', async () => {
    const rig = await bootRig({ hosted: false });
    try {
      const periodo = Math.floor(MEDIA_TICKET_TTL_MS / 3);
      assert.ok(
        rig.agendados.some((a) => a.ms === periodo),
        `nenhum temporizador em ${periodo} ms: ${JSON.stringify(rig.agendados.map((a) => a.ms))}`,
      );
    } finally {
      await rig.cleanup();
    }
  });
});

describe('§44 boot — mapa conexão↔membro (§43.3, §16.3 regra 4)', () => {
  it('o relay acha a conexão do destinatário e usa a chave da conexão como origem', async () => {
    const rig = await bootRig({ hosted: true });
    try {
      const bea = rig.bea;
      const anaHex = rig.ana.publicKey.toString('hex');
      const beaHex = bea.publicKey.toString('hex');

      const [ladoAnaHost, ladoAna] = rpcPair();
      const [ladoBeaHost, ladoBea] = rpcPair();
      const conexaoAna = rig.runtime.attachMemberConnection({ communityId: rig.communityId, peerKeyHex: anaHex, transport: ladoAnaHost });
      rig.runtime.attachMemberConnection({ communityId: rig.communityId, peerKeyHex: beaHex, transport: ladoBeaHost });

      const clienteAna = new RpcClient({ protocol: 'community', transport: ladoAna, role: 'member' });
      const clienteBea = new RpcClient({ protocol: 'community', transport: ladoBea, role: 'member' });
      const recebidos: Array<{ topic: string; data: Record<string, unknown> }> = [];
      clienteBea.onNotify((topic, body) => {
        recebidos.push({ topic, data: JSON.parse(Buffer.from(body).toString('utf8')) as Record<string, unknown> });
      });

      // As duas entram na chamada pelo host — é ele que emite os tickets de §17.4.
      const entrada = async (c: RpcClient): Promise<Record<string, unknown>> => {
        const r = await c.call('voiceJoin', new Uint8Array(Buffer.from(JSON.stringify({ channelId: rig.voiceChannelId }), 'utf8')));
        assert.ok(r.ok, `voiceJoin recusado: ${JSON.stringify(r)}`);
        return JSON.parse(Buffer.from(r.body).toString('utf8')) as Record<string, unknown>;
      };
      await entrada(clienteAna);
      await entrada(clienteBea);

      const sinal = await clienteAna.call(
        'voiceSignal',
        new Uint8Array(Buffer.from(JSON.stringify({ toPeerKey: beaHex, ticketId: 't-1', sdp: 'v=0' }), 'utf8')),
      );
      assert.ok(sinal.ok, `voiceSignal recusado: ${JSON.stringify(sinal)}`);
      await tick(20);

      const chegou = recebidos.find((r) => r.topic === 'voice.signal');
      assert.ok(chegou, `bea não recebeu voice.signal: ${JSON.stringify(recebidos.map((r) => r.topic))}`);
      // §16.3 regra 4: a origem é a da conexão, nunca um campo do pedido.
      assert.equal(chegou.data['peerKey'], anaHex);
      assert.equal(chegou.data['sdp'], 'v=0');

      // Conexão que sai deixa o mapa: o relay passa a não achar o destino (§20.2).
      conexaoAna.detach();
      const orfao = await clienteBea.call(
        'voiceSignal',
        new Uint8Array(Buffer.from(JSON.stringify({ toPeerKey: anaHex, ticketId: 't-2', sdp: 'v=0' }), 'utf8')),
      );
      assert.equal(orfao.ok, false);
      assert.equal((orfao as { code: string }).code, 'E_PEER_UNREACHABLE');
    } finally {
      await rig.cleanup();
    }
  });

  it('o roster do host é empurrado só a quem está na chamada (§15.5)', async () => {
    const rig = await bootRig({ hosted: true });
    try {
      const bea = rig.bea;
      const [ladoAnaHost, ladoAna] = rpcPair();
      const [ladoBeaHost, ladoBea] = rpcPair();
      rig.runtime.attachMemberConnection({ communityId: rig.communityId, peerKeyHex: rig.ana.publicKey.toString('hex'), transport: ladoAnaHost });
      rig.runtime.attachMemberConnection({ communityId: rig.communityId, peerKeyHex: bea.publicKey.toString('hex'), transport: ladoBeaHost });
      const clienteAna = new RpcClient({ protocol: 'community', transport: ladoAna, role: 'member' });
      const clienteBea = new RpcClient({ protocol: 'community', transport: ladoBea, role: 'member' });
      const paraBea: string[] = [];
      clienteBea.onNotify((topic) => paraBea.push(topic));

      const r = await clienteAna.call('voiceJoin', new Uint8Array(Buffer.from(JSON.stringify({ channelId: rig.voiceChannelId }), 'utf8')));
      assert.ok(r.ok);
      await tick(20);
      assert.ok(!paraBea.includes('voice.roster'), 'bea não está na chamada e recebeu o roster mesmo assim');
      // §17.6 — a OCUPAÇÃO é o oposto: vai a todos os membros conectados, e é justamente
      // quem está de fora da chamada que precisa dela (`RT-05`). O tópico faltava na tabela
      // fechada de §16.3, então nunca saía da máquina de quem hospeda: para todo mundo que
      // não hospedava, a sala de voz aparecia vazia mesmo com gente dentro.
      assert.ok(
        paraBea.includes('voice.occupancyChanged'),
        `bea está de fora da chamada e precisa da ocupação: ${JSON.stringify(paraBea)}`,
      );
    } finally {
      await rig.cleanup();
    }
  });

  /**
   * §17.5 — **quem entra na chamada com a tela já no ar precisa saber dela.**
   *
   * `share.started` era emitido só no instante do `share.start`, e nada o repunha: quem
   * chegava depois não criava a sessão do lado de quem assiste e nunca mandava o
   * `share.join`, então o apresentador nunca era mandado servi-lo. A câmera não sofria
   * porque é malha (§17.2) — chega a quem entra na primeira negociação, sem autorização
   * nenhuma. Era por isso que o defeito parecia ser só da tela: com dois espectadores,
   * um via e o outro não, para sempre.
   *
   * O evento vai **só a quem entrou**. O roster sai também em `voiceState`, e o `speaking`
   * do VAD é publicado a cada virada num relógio de 250 ms; reemitir a toda a chamada em
   * toda mudança de roster faria de cada virada de fala um `share.started` para todos — e
   * cada espectador responde a ele com um `share.join`, que cunha um ticket Ed25519.
   *
   * Verificado por mutação: sem a reemissão, bea entra e nunca sabe da tela; reemitindo a
   * `alvos` inteiro em vez de aos entrantes, ana recebe o evento de novo e o VAD o repete.
   */
  it('quem entra na chamada com a tela no ar recebe `share.started`, e só ele (§17.5)', async () => {
    const rig = await bootRig({ hosted: true });
    try {
      const anaHex = rig.ana.publicKey.toString('hex');
      const beaHex = rig.bea.publicKey.toString('hex');
      const [ladoAnaHost, ladoAna] = rpcPair();
      const [ladoBeaHost, ladoBea] = rpcPair();
      rig.runtime.attachMemberConnection({ communityId: rig.communityId, peerKeyHex: anaHex, transport: ladoAnaHost });
      rig.runtime.attachMemberConnection({ communityId: rig.communityId, peerKeyHex: beaHex, transport: ladoBeaHost });
      const clienteAna = new RpcClient({ protocol: 'community', transport: ladoAna, role: 'member' });
      const clienteBea = new RpcClient({ protocol: 'community', transport: ladoBea, role: 'member' });
      const paraAna: string[] = [];
      const paraBea: string[] = [];
      clienteAna.onNotify((topic) => paraAna.push(topic));
      clienteBea.onNotify((topic) => paraBea.push(topic));

      const chamar = async (c: RpcClient, cmd: string, arg: unknown): Promise<Record<string, unknown>> => {
        const r = await c.call(cmd, new Uint8Array(Buffer.from(JSON.stringify(arg), 'utf8')));
        assert.ok(r.ok, `${cmd} recusado: ${JSON.stringify(r)}`);
        return JSON.parse(Buffer.from(r.body).toString('utf8')) as Record<string, unknown>;
      };

      await chamar(clienteAna, 'voiceJoin', { channelId: rig.voiceChannelId });
      await chamar(clienteAna, 'shareStart', { channelId: rig.voiceChannelId, quality: 'balanced' });
      await tick(20);
      assert.ok(
        !paraBea.includes('share.started'),
        'bea está fora da chamada e a audiência de tela é a chamada (A19)',
      );

      paraAna.length = 0;
      await chamar(clienteBea, 'voiceJoin', { channelId: rig.voiceChannelId });
      await tick(20);
      assert.ok(
        paraBea.includes('share.started'),
        `bea entrou com a tela no ar e não soube dela: ${JSON.stringify(paraBea)}`,
      );
      assert.ok(
        !paraAna.includes('share.started'),
        'ana já estava na chamada — o evento é de quem entrou, não de todo mundo',
      );

      // O roster sai a cada `voiceState`, e nenhuma virada de fala é uma tela nova.
      paraAna.length = 0;
      paraBea.length = 0;
      await chamar(clienteBea, 'voiceState', { speaking: true });
      await chamar(clienteBea, 'voiceState', { speaking: false });
      await tick(20);
      assert.ok(
        !paraAna.includes('share.started') && !paraBea.includes('share.started'),
        `o VAD republicou a sessão de tela: ana=${JSON.stringify(paraAna)} bea=${JSON.stringify(paraBea)}`,
      );
    } finally {
      await rig.cleanup();
    }
  });

  it('quem conecta com a chamada já em curso recebe a ocupação de boas-vindas (§17.6)', async () => {
    // Ocupação é NÍVEL, não sequência: só emiti-la por mudança de roster deixava quem abre
    // o aplicativo no meio de uma chamada vendo a sala vazia até alguém entrar ou sair — e
    // §15.6 não dá produtor de ocupação a quem não hospeda (`RT-05`).
    const rig = await bootRig({ hosted: true });
    try {
      const [ladoAnaHost, ladoAna] = rpcPair();
      rig.runtime.attachMemberConnection({ communityId: rig.communityId, peerKeyHex: rig.ana.publicKey.toString('hex'), transport: ladoAnaHost });
      const clienteAna = new RpcClient({ protocol: 'community', transport: ladoAna, role: 'member' });
      const r = await clienteAna.call('voiceJoin', new Uint8Array(Buffer.from(JSON.stringify({ channelId: rig.voiceChannelId }), 'utf8')));
      assert.ok(r.ok);
      await tick(20);

      // Bea chega DEPOIS, e a única mudança de roster já passou.
      const [ladoBeaHost, ladoBea] = rpcPair();
      const clienteBea = new RpcClient({ protocol: 'community', transport: ladoBea, role: 'member' });
      const paraBea: Array<{ topic: string; data: Record<string, unknown> }> = [];
      clienteBea.onNotify((topic, body) => {
        paraBea.push({ topic, data: JSON.parse(Buffer.from(body).toString('utf8')) as Record<string, unknown> });
      });
      rig.runtime.attachMemberConnection({ communityId: rig.communityId, peerKeyHex: rig.bea.publicKey.toString('hex'), transport: ladoBeaHost });
      await tick(20);

      const ocupacao = paraBea.find((n) => n.topic === 'voice.occupancyChanged');
      assert.ok(ocupacao, `bea entrou no meio da chamada e não soube dela: ${JSON.stringify(paraBea.map((n) => n.topic))}`);
      assert.equal(ocupacao.data['channelId'], rig.voiceChannelId);
      assert.equal(ocupacao.data['count'], 1);
      assert.deepEqual(ocupacao.data['firstKeys'], [rig.ana.publicKey.toString('hex')]);
    } finally {
      await rig.cleanup();
    }
  });
});

describe('§44 boot — as portas de §35.2/§37.2 no roteador de §15.4', () => {
  it('query.community responde sobre o DS real da comunidade aberta', async () => {
    const rig = await bootRig({ hosted: false });
    try {
      const res = await rig.request('query.community', { communityId: rig.communityId });
      assert.ok(res.ok, JSON.stringify(res));
      const view = res.data as Record<string, unknown>;
      assert.equal(view['id'], rig.communityId);
      assert.equal(view['isHost'], false);
      assert.equal(view['name'], 'Comunidade');
    } finally {
      await rig.cleanup();
    }
  });

  it('community.leave sai localmente e a comunidade deixa de estar aberta (§11.1 exceção)', async () => {
    const rig = await bootRig({ hosted: false });
    try {
      const res = await rig.request('community.leave', { communityId: rig.communityId });
      assert.ok(res.ok, JSON.stringify(res));
      assert.equal(rig.runtime.get(rig.communityId), undefined);
      const row = rig.manifest.getCommunity(rig.communityId) as { left_at: number | null };
      assert.notEqual(row.left_at, null);
    } finally {
      await rig.cleanup();
    }
  });

  it('o host não sai da própria comunidade', async () => {
    const rig = await bootRig({ hosted: true });
    try {
      const res = await rig.request('community.leave', { communityId: rig.communityId });
      assert.equal(res.ok, false);
      assert.equal(res.code, 'E_HOST_CANNOT_LEAVE');
      assert.notEqual(rig.runtime.get(rig.communityId), undefined);
    } finally {
      await rig.cleanup();
    }
  });

  it('a sucessão está composta sobre os módulos reais (§35.2)', async () => {
    const rig = await bootRig({ hosted: true });
    try {
      // Não-sucessor pedindo o rail: a recusa vem do serviço, não de porta faltando.
      const r = await rig.runtime.succession.assumeHost({ communityId: rig.communityId });
      assert.equal(r.ok, false);
      assert.equal((r as { code: string }).code, 'E_SUCCESSION_DENIED');
    } finally {
      await rig.cleanup();
    }
  });
});
