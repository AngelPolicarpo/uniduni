/**
 * Voz e tela em **modo membro** (§15.4, §16.2, §17.4/§17.5): a mesma superfície IPC-R, com
 * a decisão do outro lado do RPC.
 *
 * O que é REAL aqui: `IpcServer`/`IpcClient`, o roteador de §15.4, `RpcClient`/`RpcServer`
 * com a tabela fechada de §16.2, `VoiceHostSessions`/`ShareHostSessions` do lado host e os
 * tickets Ed25519 de §17.4 — verificados depois da travessia do fio, que é onde um codec
 * errado apareceria. SIMULADO: só a socket (par de canais em memória).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DecisionState } from '../src/l1/fold/index.ts';
import { MEDIA_TICKET_TTL_MS } from '../src/l1/fold/constants.ts';
import { ShareHealthMonitor, ShareHostSessions, type ShareHealthSnapshot } from '../src/l2/shareStar/index.ts';
import { VoiceHostSessions, orderedPair, verifyMediaTicket } from '../src/l2/voiceCoordinator/index.ts';
import { IpcClient, IpcServer, MemoryIpcPort } from '../src/l3/ipcRenderer/index.ts';
import { registerCoreCommands } from '../src/l3/ipcRenderer/commands.ts';
import {
  VoiceTicketRenewer,
  mediaWire,
  remoteMediaDispatcher,
  signalIsAuthorized,
  startMediaRuntime,
} from '../src/l3/ipcRenderer/media.ts';
import {
  mediaWireServer,
  peerSignalRelay,
  registerHostMediaMethods,
  type SignalDeliveryPort,
} from '../src/l3/rpcServer/media.ts';
import { RpcClient } from '../src/l3/rpcClient/index.ts';
import { RpcServer } from '../src/l3/rpcServer/index.ts';
import type { Diagnostics } from '../src/l2/diagnostics/index.ts';
import type { SearchService } from '../src/l2/search/index.ts';
import { keypairFromSeed } from './helpers/world.ts';
import { rpcPair, voiceStateOf, wireHostMediaRpc } from './helpers/composition.ts';

const HOSTKEY = keypairFromSeed('host-membro');
const APRESENTADOR = keypairFromSeed('apresentador');
const MEMBRO = keypairFromSeed('membro-remoto');
const APRESENTADOR_HEX = APRESENTADOR.publicKey.toString('hex');
const MEMBRO_HEX = MEMBRO.publicKey.toString('hex');
const CANAL = 'ch-voz';

/** Recorte estrutural do host: um canal de voz e dois membros com `voice_speak`. */
function fixture() {
  return {
    community: { exists: true },
    channels: new Map([
      [CANAL, { type: 1 }],
      ['ch-texto', { type: 0 }],
    ]),
    members: new Map([
      [APRESENTADOR_HEX, { state: 'active' as const, roleIds: ['r'] }],
      [MEMBRO_HEX, { state: 'active' as const, roleIds: ['r'] }],
    ]),
    // 9 = voice_speak, 10 = voice_mute_others, 11 = voice_share_screen (§9.1)
    roles: new Map([['r', { permissions: [9, 10, 11] }]]),
  };
}

type Rig = {
  ipc: IpcClient;
  voice: VoiceHostSessions;
  share: ShareHostSessions;
  hostSide: { drop(): void };
  memberSide: { drop(): void };
  /** §15.7 `capture.authorize` — o main pergunta ao núcleo local, não ao host. */
  captura(a: { sessionId: string; audio?: boolean; kind?: 'screen' | 'music' }): { allowed: boolean; reason?: string; audio: boolean };
  dispatcher: ReturnType<typeof remoteMediaDispatcher>;
  /** O que o host encaminhou (§16.2 `voiceSignal`). */
  sinais: Array<Record<string, unknown>>;
  /** §17.5/§17.6 — o monitor do host e o que ele consolidou. */
  saude: ShareHealthMonitor;
  saudes: ShareHealthSnapshot[];
};

async function rig(opts: { readonly comRelay?: boolean } = {}): Promise<Rig> {
  let now = 1_700_000_000_000;
  const clock = { now: () => now };
  const state = fixture();

  const voice = new VoiceHostSessions({
    hostSecretKey: HOSTKEY.secretKey,
    hostTurnSecret: Buffer.alloc(32, 7),
    clock,
    ttlMs: MEDIA_TICKET_TTL_MS,
    isVoiceChannelType: (type) => type === 1,
  });
  const share = new ShareHostSessions({
    hostSecretKey: HOSTKEY.secretKey,
    clock,
    ttlMs: MEDIA_TICKET_TTL_MS,
    captureTokenTtlMs: 60_000,
    isVoiceChannelType: (type) => type === 1,
    voiceParticipants: (channelId) => {
      const session = voice.sessionOf(channelId);
      return session === null ? null : new Set(session.participants.map((p) => p.keyHex));
    },
  });

  // Transporte de §16: o host de um lado, o membro do outro.
  const [hostSide, memberSide] = rpcPair();
  const rpcServer = new RpcServer({ protocol: 'community', transport: hostSide });
  const sinais: Array<Record<string, unknown>> = [];
  const signal: SignalDeliveryPort = {
    deliver: (a) => {
      sinais.push({ ...a });
      // Par fora do roster desta sessão é `E_PEER_UNREACHABLE` (§15.4).
      return voice.sessionOf(CANAL)?.participants.some((p) => p.keyHex === a.toPeerKey) === true
        ? { ok: true }
        : { ok: false, code: 'E_PEER_UNREACHABLE' };
    },
  };
  const saudes: ShareHealthSnapshot[] = [];
  const saude = new ShareHealthMonitor({
    sessions: share,
    onHealth: (snapshots) => saudes.push(...snapshots),
  });
  wireHostMediaRpc(rpcServer, {
    peerKeyHex: MEMBRO_HEX,
    stateFor: () => voiceStateOf(state as unknown as DecisionState),
    voice,
    share,
    fila: {
      entrar: () => ({ ok: true as const }),
      sair: () => undefined,
      moderar: () => ({ ok: true as const }),
    },
    shareHealth: saude,
    ...(opts.comRelay === false ? {} : { signal }),
  });
  const rpcClient = new RpcClient({ protocol: 'community', transport: memberSide });

  // Fronteira IPC-R do membro, com o dispatcher REMOTO na mesma interface do modo host.
  const [coreSide, rendererSide] = MemoryIpcPort.createPair();
  const server = new IpcServer({
    epoch: 1,
    port: coreSide,
    tokenVerifier: { consume: () => false },
    identityStatus: { isLoaded: true },
  });
  const dispatcher = remoteMediaDispatcher(rpcClient, {
    captureTokenTtlMs: 60_000,
    now: clock.now,
    mintToken: () => 'token-local-de-teste',
  });
  registerCoreCommands(server, {
    // Só a superfície de mídia importa aqui; diagnóstico e busca não são exercitados.
    diagnostics: undefined as unknown as Diagnostics,
    search: undefined as unknown as SearchService,
    media: { dispatcher },
  });
  const ipc = new IpcClient();
  ipc.attach(rendererSide);
  const hello = ipc.waitForHello(1_000);
  server.sendHello('membro', 2);
  await hello;

  return {
    ipc,
    voice,
    share,
    hostSide,
    memberSide,
    captura: (a) => dispatcher.authorizeCapture(a),
    dispatcher,
    sinais,
    saude,
    saudes,
  };
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'sem-erro';
  } catch (err) {
    return (err as NodeJS.ErrnoException).code ?? 'sem-codigo';
  }
}

describe('modo membro — voz por §16.2 (§15.4, §17.4)', () => {
  it('`voice.join` atravessa o RPC e o ticket sobrevive ao fio, verificável', async () => {
    const r = await rig();
    try {
      // O apresentador já está na chamada, direto no host: é dele o par do ticket.
      assert.equal(
        r.voice.join({
          state: voiceStateOf(fixture() as unknown as DecisionState),
          channelId: CANAL,
          memberKeyHex: APRESENTADOR_HEX,
        }).ok,
        true,
      );

      const joined = (await r.ipc.request('voice.join', { communityId: 'c', channelId: CANAL })) as {
        sessionId: string;
        channelId: string;
        roster: Array<{ keyHex: string }>;
        tickets: Array<{ peerA: Buffer; peerB: Buffer; sig: Buffer; sessionId: string; channelId: string; expiresAt: number }>;
        turnCredential: { username: string; password: string };
      };

      assert.equal(joined.channelId, CANAL);
      assert.deepEqual(joined.roster.map((p) => p.keyHex).sort(), [APRESENTADOR_HEX, MEMBRO_HEX].sort());
      assert.equal(joined.tickets.length, 1);
      assert.match(joined.turnCredential.password, /^[0-9a-f]+$/);

      // O ticket é Ed25519 sobre BLAKE2b (§17.4). Se o codec de fio perdesse um byte de
      // `peerA`/`peerB`/`sig`, esta verificação falharia — é o teste do codec.
      const ticket = joined.tickets[0]!;
      const par = orderedPair(MEMBRO.publicKey, APRESENTADOR.publicKey);
      assert.deepEqual(
        verifyMediaTicket(
          HOSTKEY.publicKey,
          {
            ...ticket,
            peerA: Buffer.from(ticket.peerA),
            peerB: Buffer.from(ticket.peerB),
            sig: Buffer.from(ticket.sig),
          },
          {
            sessionId: joined.sessionId,
            channelId: CANAL,
            localPeer: par.peerA,
            remotePeer: par.peerB,
          },
          1_700_000_000_000,
        ),
        { ok: true },
      );
    } finally {
      r.hostSide.drop();
    }
  });

  it('a sessão corrente é estado client-side: nasce no join, morre no leave', async () => {
    const r = await rig();
    try {
      // §15.4: `voice.setSelf` não tem sessionId — sem sessão local não há o que ajustar.
      assert.equal(await code(r.ipc.request('voice.setSelf', { muted: true })), 'E_SESSION_GONE');

      await r.ipc.request('voice.join', { communityId: 'c', channelId: CANAL });
      assert.deepEqual(await r.ipc.request('voice.setSelf', { muted: true }), {});
      assert.equal(
        r.voice.sessionOf(CANAL)?.participants.find((p: { keyHex: string }) => p.keyHex === MEMBRO_HEX)?.muted,
        true,
      );

      // `voice.leave` sem argumento (§15.4) usa a sessão que o cliente guardou.
      assert.deepEqual(await r.ipc.request('voice.leave', {}), {});
      assert.equal(r.voice.currentSessionOf(MEMBRO_HEX), null);
      assert.equal(await code(r.ipc.request('voice.setSelf', { muted: false })), 'E_SESSION_GONE');

      // Sem sessão, sair de novo é o mesmo no-op nomeado do modo host.
      assert.deepEqual(await r.ipc.request('voice.leave', {}), {});
    } finally {
      r.hostSide.drop();
    }
  });

  it('`voice.muteParticipant` atravessa por `voiceMute` e é decidido pelo host', async () => {
    const r = await rig();
    try {
      assert.equal(
        r.voice.join({
          state: voiceStateOf(fixture() as unknown as DecisionState),
          channelId: CANAL,
          memberKeyHex: APRESENTADOR_HEX,
        }).ok,
        true,
      );
      // Sem sessão local não há roster onde silenciar — nem sai da máquina.
      assert.equal(
        await code(r.ipc.request('voice.muteParticipant', { communityId: 'c', identityKey: APRESENTADOR_HEX, muted: true })),
        'E_SESSION_GONE',
      );

      await r.ipc.request('voice.join', { communityId: 'c', channelId: CANAL });
      assert.deepEqual(
        await r.ipc.request('voice.muteParticipant', { communityId: 'c', identityKey: APRESENTADOR_HEX, muted: true }),
        {},
      );
      // L-12: o efeito é a marca no roster do host, que chega ao alvo por `voice.roster`.
      assert.equal(
        r.voice.sessionOf(CANAL)?.participants.find((p: { keyHex: string }) => p.keyHex === APRESENTADOR_HEX)?.muted,
        true,
      );

      // O alvo continua sendo resolvido pelo host, contra o roster dele.
      assert.equal(
        await code(r.ipc.request('voice.muteParticipant', { communityId: 'c', identityKey: 'ff'.repeat(32), muted: true })),
        'E_SESSION_GONE',
      );
    } finally {
      r.hostSide.drop();
    }
  });

  it('a recusa do host chega com o código do catálogo, sem tradução', async () => {
    const r = await rig();
    try {
      assert.equal(
        await code(r.ipc.request('voice.join', { communityId: 'c', channelId: 'ch-texto' })),
        'E_CHANNEL_NOT_VOICE',
      );
      assert.equal(await code(r.ipc.request('share.join', { sessionId: 'sess-inexistente' })), 'E_SESSION_GONE');
    } finally {
      r.hostSide.drop();
    }
  });

  it('recusa do host que mata a sessão apaga o estado client-side', async () => {
    // Porta de RPC controlada: aqui interessa a regra do dispatcher, não o transporte.
    const chamadas: string[] = [];
    let proxima: { ok: true; body: Uint8Array } | { ok: false; code: string } = {
      ok: true,
      body: new Uint8Array(Buffer.from(JSON.stringify({ sessionId: 'sess-1', channelId: CANAL }), 'utf8')),
    };
    const dispatcher = remoteMediaDispatcher(
      {
        call: async (method) => {
          chamadas.push(method);
          return proxima;
        },
      },
      { captureTokenTtlMs: 60_000 },
    );

    assert.equal((await dispatcher.voiceJoin({ communityId: 'c', channelId: CANAL })).ok, true);
    assert.equal(dispatcher.currentSessionId(), 'sess-1');

    // §16.1: a conexão caiu ou o prazo estourou — os dois viram `E_HOST_UNAVAILABLE`.
    proxima = { ok: false, code: 'E_HOST_UNAVAILABLE' };
    assert.deepEqual(await dispatcher.voiceSetSelf({ muted: true }), { ok: false, code: 'E_HOST_UNAVAILABLE' });
    assert.equal(dispatcher.currentSessionId(), null);

    // Sem sessão, a próxima chamada nem chega à rede.
    assert.deepEqual(await dispatcher.voiceSetSelf({ muted: true }), { ok: false, code: 'E_SESSION_GONE' });
    assert.deepEqual(chamadas, ['voiceJoin', 'voiceState']);

    // §17.4 — a revogação chega por evento, e derruba a sessão sem round-trip.
    proxima = { ok: true, body: new Uint8Array(Buffer.from(JSON.stringify({ sessionId: 'sess-2' }), 'utf8')) };
    await dispatcher.voiceJoin({ communityId: 'c', channelId: CANAL });
    assert.equal(dispatcher.currentSessionId(), 'sess-2');
    dispatcher.forgetSession();
    assert.equal(dispatcher.currentSessionId(), null);
  });
});

describe('modo membro — tela por §16.2 (§15.4, §17.5)', () => {
  it('start, join e stop atravessam; o teto de espectadores continua sendo do host', async () => {
    const r = await rig();
    try {
      // O membro remoto entra na chamada e compartilha; o apresentador local assiste.
      await r.ipc.request('voice.join', { communityId: 'c', channelId: CANAL });
      assert.equal(
        r.voice.join({
          state: voiceStateOf(fixture() as unknown as DecisionState),
          channelId: CANAL,
          memberKeyHex: APRESENTADOR_HEX,
        }).ok,
        true,
      );

      const started = (await r.ipc.request('share.start', {
        communityId: 'c',
        channelId: CANAL,
        quality: 'high',
      })) as { sessionId: string; captureToken: { sessionId: string } };
      assert.match(started.sessionId, /.+/);
      // §15.4 devolve o token; §16.2 não o transportou (§17.4 emendado).
      assert.equal(started.captureToken.sessionId, started.sessionId);

      // §17.5, emenda de 2026-08-26 — o canal aceita várias transmissões; o que o host
      // recusa é a SEGUNDA DO MESMO APRESENTADOR, porque a captura desta instalação é uma só.
      assert.equal(
        await code(r.ipc.request('share.start', { communityId: 'c', channelId: CANAL, quality: 'low' })),
        'E_ALREADY_SHARING',
      );

      const espectador = r.share.join({ sessionId: started.sessionId, memberKeyHex: APRESENTADOR_HEX });
      assert.equal(espectador.ok, true);

      // `share.stop` do apresentador vai por `shareLeave` (§17.5: sair encerra tudo).
      assert.deepEqual(await r.ipc.request('share.stop', { sessionId: started.sessionId }), {});
      assert.equal(
        await code(r.ipc.request('share.stop', { sessionId: started.sessionId })),
        'E_SESSION_GONE',
      );
    } finally {
      r.hostSide.drop();
    }
  });

  // §17.5, emenda de 2026-08-26 — o papel de `share.setQuality` é do APRESENTADOR: o perfil
  // vira `maxBitrate` no sender dele, então quem pedia não era quem pagava.
  it('`share.setQuality` do apresentador atravessa por `shareQuality` (§16.2 emendado)', async () => {
    const r = await rig();
    try {
      // O membro desta IPC entra na chamada e apresenta; o outro par entra e assiste.
      const estado = voiceStateOf(fixture() as unknown as DecisionState);
      assert.equal(r.voice.join({ state: estado, channelId: CANAL, memberKeyHex: APRESENTADOR_HEX }).ok, true);
      await r.ipc.request('voice.join', { communityId: 'c', channelId: CANAL });
      const started = (await r.ipc.request('share.start', {
        communityId: 'c',
        channelId: CANAL,
        quality: 'high',
      })) as { sessionId: string };
      const sessionId = started.sessionId;
      assert.equal(r.share.join({ sessionId, memberKeyHex: APRESENTADOR_HEX }).ok, true);

      assert.deepEqual(await r.ipc.request('share.setQuality', { sessionId, quality: 'low' }), { applied: true });
      // O perfil é a base da sessão e realinha quem assiste — é dele que `share.health` tira
      // o `quality` que volta ao apresentador (§15.5, §17.5).
      assert.equal(r.share.viewerQuality(sessionId, APRESENTADOR_HEX), 'low');

      // Sessão que não existe recusa antes de qualquer papel.
      assert.equal(
        await code(r.ipc.request('share.setQuality', { sessionId: 'sess-inexistente', quality: 'low' })),
        'E_SESSION_GONE',
      );
      // A forma do argumento é validada antes de qualquer viagem.
      assert.equal(
        await code(r.ipc.request('share.setQuality', { sessionId, quality: 'ultra' })),
        'E_VALIDATION',
      );
    } finally {
      r.hostSide.drop();
    }
  });

  /**
   * §15.4 `share.report` / §16.2 `shareReport` — a emenda de 2026-08-25.
   *
   * O laço fechado: o apresentador mede, relata pelo RPC, o host consolida e a degradação
   * automática de §17.5 acontece na decisão dele. Sem esta perna, `share.health` estava
   * declarado em §15.5 E em §16.3 e não tinha número nenhum para carregar — o mesmo tipo de
   * ponta solta que §82.3 nomeou.
   */
  it('`share.report` sobe a amostra do apresentador e alimenta a saúde do host', async () => {
    const r = await rig();
    try {
      // O membro remoto apresenta; o apresentador local assiste.
      await r.ipc.request('voice.join', { communityId: 'c', channelId: CANAL });
      assert.equal(
        r.voice.join({
          state: voiceStateOf(fixture() as unknown as DecisionState),
          channelId: CANAL,
          memberKeyHex: APRESENTADOR_HEX,
        }).ok,
        true,
      );
      const started = (await r.ipc.request('share.start', {
        communityId: 'c',
        channelId: CANAL,
        quality: 'high',
      })) as { sessionId: string };
      assert.equal(r.share.join({ sessionId: started.sessionId, memberKeyHex: APRESENTADOR_HEX }).ok, true);

      // Perda acima do limiar de §17.5 (3%): o host desce UM perfil, pelo caminho de
      // sistema — `high` → `balanced`. Quem decide é ele, não quem mediu.
      await r.ipc.request('share.report', {
        sessionId: started.sessionId,
        samples: [{ viewerKey: APRESENTADOR_HEX, rttMs: 42, lossPct: 7 }],
      });
      r.saude.tick();

      assert.equal(r.saudes.length, 1);
      assert.deepEqual(r.saudes[0]!.viewers, [
        { keyHex: APRESENTADOR_HEX, rttMs: 42, lossPct: 7, quality: 'balanced' },
      ]);
      assert.equal(r.share.viewerQuality(started.sessionId, APRESENTADOR_HEX), 'balanced');
    } finally {
      r.hostSide.drop();
    }
  });

  it('só o apresentador relata: espectador tentando é `E_PERMISSION_DENIED`', async () => {
    const r = await rig();
    try {
      // Agora o APRESENTADOR local abre a sessão e o membro remoto é só espectador.
      const estado = voiceStateOf(fixture() as unknown as DecisionState);
      assert.equal(r.voice.join({ state: estado, channelId: CANAL, memberKeyHex: APRESENTADOR_HEX }).ok, true);
      await r.ipc.request('voice.join', { communityId: 'c', channelId: CANAL });
      const sessao = r.share.start({ state: estado, channelId: CANAL, presenterKeyHex: APRESENTADOR_HEX });
      assert.equal(sessao.ok, true);
      const sessionId = (sessao as { sessionId: string }).sessionId;
      assert.equal(r.share.join({ sessionId, memberKeyHex: MEMBRO_HEX }).ok, true);

      // Aceitar de um espectador deixaria qualquer participante mexer no perfil dos outros
      // pelo caminho de sistema, que não tem papel no §RPC.
      assert.equal(
        await code(
          r.ipc.request('share.report', {
            sessionId,
            samples: [{ viewerKey: APRESENTADOR_HEX, rttMs: 10, lossPct: 90 }],
          }),
        ),
        'E_PERMISSION_DENIED',
      );
      // O snapshot sai — a sessão está viva e a audiência precisa chegar ao apresentador —
      // mas a amostra recusada não deixou número nenhum nele, e o perfil não se mexeu.
      r.saude.tick();
      assert.deepEqual(r.saudes.at(-1)!.viewers, [{ keyHex: MEMBRO_HEX, quality: 'balanced' }]);
      assert.equal(r.share.viewerQuality(sessionId, MEMBRO_HEX), 'balanced');

      assert.equal(
        await code(r.ipc.request('share.report', { sessionId: 'sess-inexistente', samples: [] })),
        'E_SESSION_GONE',
      );
    } finally {
      r.hostSide.drop();
    }
  });

  it('amostra malformada é descartada, não recusada: relatar não derruba a transmissão', async () => {
    const r = await rig();
    try {
      await r.ipc.request('voice.join', { communityId: 'c', channelId: CANAL });
      assert.equal(
        r.voice.join({
          state: voiceStateOf(fixture() as unknown as DecisionState),
          channelId: CANAL,
          memberKeyHex: APRESENTADOR_HEX,
        }).ok,
        true,
      );
      const started = (await r.ipc.request('share.start', { communityId: 'c', channelId: CANAL })) as {
        sessionId: string;
      };
      assert.equal(r.share.join({ sessionId: started.sessionId, memberKeyHex: APRESENTADOR_HEX }).ok, true);

      await r.ipc.request('share.report', {
        sessionId: started.sessionId,
        samples: [
          { viewerKey: APRESENTADOR_HEX, rttMs: 'muito', lossPct: 1 },
          { rttMs: 10, lossPct: 1 },
          null,
          { viewerKey: APRESENTADOR_HEX, rttMs: 15, lossPct: 1 },
        ],
      });
      r.saude.tick();
      // A boa passou; as três quebradas sumiram sem erro.
      assert.deepEqual(r.saudes[0]!.viewers, [
        { keyHex: APRESENTADOR_HEX, rttMs: 15, lossPct: 1, quality: 'balanced' },
      ]);
    } finally {
      r.hostSide.drop();
    }
  });

  it('o `captureToken` é cunhado localmente e `capture.authorize` não vai ao host', async () => {
    const r = await rig();
    try {
      await r.ipc.request('voice.join', { communityId: 'c', channelId: CANAL });
      const started = (await r.ipc.request('share.start', { communityId: 'c', channelId: CANAL })) as {
        sessionId: string;
        captureToken: { token: string; sessionId: string; expiresAt: number };
      };
      // §15.4 devolve o token; §16.2 não o transportou — ele nasceu deste lado (§17.4).
      assert.equal(started.captureToken.token, 'token-local-de-teste');
      assert.equal(started.captureToken.sessionId, started.sessionId);
      assert.equal(r.captura({ sessionId: started.sessionId }).allowed, true);

      /*
       * §17.5 (emenda de 2026-09-03, B39) — o som é decisão do NÚCLEO, e é separada de
       * `allowed`. Antes desta emenda o flag ia do renderer direto ao main: o núcleo
       * autorizava a captura sem saber se ela levava o som da máquina inteira.
       */
      assert.deepEqual(r.captura({ sessionId: started.sessionId }), { allowed: true, audio: false },
        'sem pedir som, não se concede som');
      assert.deepEqual(r.captura({ sessionId: started.sessionId, audio: true }), { allowed: true, audio: true },
        'quem pode compartilhar pode compartilhar com som — a permissão é a mesma');
      assert.deepEqual(r.captura({ sessionId: 'outra-sessao' }), { allowed: false, reason: 'mismatch', audio: false });

      // Sessão encerrada, capacidade encerrada: não há captura órfã.
      await r.ipc.request('share.stop', { sessionId: started.sessionId });
      assert.deepEqual(r.captura({ sessionId: started.sessionId }), { allowed: false, reason: 'mismatch', audio: false });
    } finally {
      r.hostSide.drop();
    }
  });

  /**
   * §17.4 (correção de 2026-09-05) — **sem sessão de voz não existe token**, e o modo
   * membro não aplicava a regra. O ramo host reconferia a sessão corrente; o membro
   * conferia só token e prazo, então sair da chamada, ser revogado ou perder o host deixava
   * `capture.authorize` concedendo tela e Modo Música pela TTL inteira (5 min por default).
   */
  it('sair da chamada derruba os dois tokens de captura — tela e música', async () => {
    const r = await rig();
    try {
      await r.ipc.request('voice.join', { communityId: 'c', channelId: CANAL });
      const started = (await r.ipc.request('share.start', { communityId: 'c', channelId: CANAL })) as {
        sessionId: string;
      };
      const musica = (await r.ipc.request('music.start', { communityId: 'c' })) as { sessionId: string };
      assert.equal(r.captura({ sessionId: started.sessionId }).allowed, true);
      assert.equal(r.captura({ sessionId: musica.sessionId, kind: 'music' }).allowed, true);

      await r.ipc.request('voice.leave', {});
      assert.deepEqual(r.captura({ sessionId: started.sessionId }), { allowed: false, reason: 'mismatch', audio: false });
      assert.deepEqual(r.captura({ sessionId: musica.sessionId, kind: 'music' }), {
        allowed: false,
        reason: 'mismatch',
        audio: false,
      });
    } finally {
      r.hostSide.drop();
    }
  });
});

// ─── Sinalização, renovação e paridade do codec ───────────────────────────────────────

describe('sinalização encaminhada pelo host (§16.2 `voiceSignal`, §17.4)', () => {
  it('o núcleo encaminha sem ler e o host resolve o destino', async () => {
    const r = await rig();
    try {
      assert.equal(
        r.voice.join({
          state: voiceStateOf(fixture() as unknown as DecisionState),
          channelId: CANAL,
          memberKeyHex: APRESENTADOR_HEX,
        }).ok,
        true,
      );
      // Fora de chamada não há sessão para sinalizar — nem sai da máquina.
      assert.equal(
        await code(r.ipc.request('voice.signal', { peerKey: APRESENTADOR_HEX, ticketId: 't1', sdp: 'v=0' })),
        'E_SESSION_GONE',
      );

      await r.ipc.request('voice.join', { communityId: 'c', channelId: CANAL });
      assert.deepEqual(
        await r.ipc.request('voice.signal', { peerKey: APRESENTADOR_HEX, ticketId: 't1', sdp: 'v=0\r\n' }),
        {},
      );
      assert.equal(r.sinais.length, 1);
      assert.equal(r.sinais[0]?.['toPeerKey'], APRESENTADOR_HEX);
      // A origem é a da conexão, não algo que o remetente possa declarar.
      assert.equal(r.sinais[0]?.['fromPeerKey'], MEMBRO_HEX);
      assert.equal(r.sinais[0]?.['sdp'], 'v=0\r\n');

      // Par que não está na chamada: §15.4 nomeia `E_PEER_UNREACHABLE`.
      assert.equal(
        await code(r.ipc.request('voice.signal', { peerKey: 'ff'.repeat(32), ticketId: 't1', ice: 'candidate:1' })),
        'E_PEER_UNREACHABLE',
      );
    } finally {
      r.hostSide.drop();
    }
  });

  it('host sem relay composto recusa em vez de fingir que entregou', async () => {
    const r = await rig({ comRelay: false });
    try {
      await r.ipc.request('voice.join', { communityId: 'c', channelId: CANAL });
      assert.equal(
        await code(r.ipc.request('voice.signal', { peerKey: APRESENTADOR_HEX, ticketId: 't1', sdp: 'v=0' })),
        'E_PEER_UNREACHABLE',
      );
    } finally {
      r.hostSide.drop();
    }
  });
});

describe('renovação de ticket é do núcleo (§17.4 emendado, §26.2)', () => {
  it('o ciclo renova por par e empurra `voice.tickets` verificável', async () => {
    const r = await rig();
    try {
      assert.equal(
        r.voice.join({
          state: voiceStateOf(fixture() as unknown as DecisionState),
          channelId: CANAL,
          memberKeyHex: APRESENTADOR_HEX,
        }).ok,
        true,
      );

      const emitidos: Array<{ topic: string; data: Record<string, unknown> }> = [];
      const renewer = new VoiceTicketRenewer({
        dispatcher: r.dispatcher,
        communityId: () => 'com-a',
        emit: (ev) => emitidos.push(ev),
        periodMs: 60_000,
        schedule: () => null,
        cancel: () => {},
      });

      // Fora de chamada é no-op: não há prazo de que cuidar.
      await renewer.tick();
      assert.equal(emitidos.length, 0);

      const joined = (await r.ipc.request('voice.join', { communityId: 'c', channelId: CANAL })) as {
        sessionId: string;
      };
      await renewer.tick();
      assert.equal(emitidos.length, 1);
      assert.equal(emitidos[0]?.topic, 'voice.tickets');
      assert.equal(emitidos[0]?.data['communityId'], 'com-a');
      assert.equal(emitidos[0]?.data['sessionId'], joined.sessionId);

      // O próprio membro não renova consigo mesmo: sobra o par do apresentador.
      const tickets = emitidos[0]?.data['tickets'] as Array<Parameters<typeof mediaWire.decodeTicket>[0]>;
      assert.equal(tickets.length, 1);
      const par = orderedPair(MEMBRO.publicKey, APRESENTADOR.publicKey);
      assert.deepEqual(
        verifyMediaTicket(
          HOSTKEY.publicKey,
          mediaWire.decodeTicket(tickets[0]!),
          { sessionId: joined.sessionId, channelId: CANAL, localPeer: par.peerA, remotePeer: par.peerB },
          1_700_000_000_000,
        ),
        { ok: true },
      );

      // Depois de sair, o ciclo volta a ser no-op — nada de renovar sessão morta.
      await r.ipc.request('voice.leave', {});
      await renewer.tick();
      assert.equal(emitidos.length, 1);
    } finally {
      r.hostSide.drop();
    }
  });
});

describe('codec de fio — paridade entre as duas cópias de L3', () => {
  const ticket = {
    sessionId: 'sess-1',
    channelId: CANAL,
    peerA: Buffer.alloc(32, 1),
    peerB: Buffer.alloc(32, 2),
    expiresAt: 1_700_000_300_000,
    sig: Buffer.alloc(64, 3),
  };

  it('cliente e servidor codificam o ticket igual, byte a byte', () => {
    assert.deepEqual(mediaWire.encodeTicket(ticket), mediaWireServer.encodeTicket(ticket));
  });

  it('o que o servidor codifica, o cliente decodifica de volta ao original', () => {
    assert.deepEqual(mediaWire.decodeTicket(mediaWireServer.encodeTicket(ticket)), ticket);
    assert.deepEqual(mediaWireServer.decodeTicket(mediaWire.encodeTicket(ticket)), ticket);
  });

  it('`voiceJoin` sai igual dos dois lados', () => {
    const join = {
      sessionId: 'sess-1',
      channelId: CANAL,
      roster: [{ keyHex: MEMBRO_HEX, muted: false, deafened: false, sharing: false, cameraOn: false, speaking: false }],
      iceServers: [{ urls: 'stun:host:3478' }],
      tickets: [ticket],
      turnCredential: { username: 'sess-1:1700000300000', password: 'ab'.repeat(32) },
    };
    assert.deepEqual(mediaWire.encodeVoiceJoin(join), mediaWireServer.encodeVoiceJoin(join));
    assert.deepEqual(mediaWire.decodeVoiceJoin(mediaWireServer.encodeVoiceJoin(join)), { ok: true, ...join });
  });
});

// ─── §16.3: a direção host → membro, ponta a ponta ────────────────────────────────────

describe('notificações do host (§16.3) e o runtime de mídia', () => {
  /**
   * Dois membros remotos contra o mesmo host, cada um com sua conexão. O relay real de
   * `voiceSignal` empurra por §16.3 na conexão do destinatário.
   */
  async function dupla() {
    const clock = { now: () => 1_700_000_000_000 };
    const state = fixture();
    const rosterSink: Array<(s: { sessionId: string; channelId: string; participants: readonly { keyHex: string }[] }) => void> = [];
    const revokedSink: Array<(t: { sessionId: string; targetKeyHex: string }) => void> = [];
    const voice = new VoiceHostSessions({
      onRosterChanged: (snapshot) => {
        for (const cb of rosterSink) cb(snapshot);
      },
      onRevoked: (targets) => {
        for (const t of targets) for (const cb of revokedSink) cb(t);
      },
      hostSecretKey: HOSTKEY.secretKey,
      hostTurnSecret: Buffer.alloc(32, 7),
      clock,
      ttlMs: MEDIA_TICKET_TTL_MS,
      isVoiceChannelType: (type) => type === 1,
    });
    const share = new ShareHostSessions({
      hostSecretKey: HOSTKEY.secretKey,
      clock,
      ttlMs: MEDIA_TICKET_TTL_MS,
      captureTokenTtlMs: 60_000,
      isVoiceChannelType: (type) => type === 1,
      voiceParticipants: (channelId) => {
        const s = voice.sessionOf(channelId);
        return s === null ? null : new Set(s.participants.map((p) => p.keyHex));
      },
    });

    const servers = new Map<string, RpcServer>();
    const relay = peerSignalRelay((peerKeyHex) => servers.get(peerKeyHex) ?? null);
    // O host empurra o roster por §16.3 a cada mudança — é assim que um membro descobre
    // que outro entrou, e é o que faz a renovação de §17.4 emitir ticket para o par novo.
    revokedSink.push((t) => {
      servers.get(t.targetKeyHex)?.notify(
        'voice.revoked',
        new Uint8Array(Buffer.from(JSON.stringify({ sessionId: t.sessionId, targetKey: t.targetKeyHex }), 'utf8')),
      );
    });
    rosterSink.push((snapshot) => {
      for (const p of snapshot.participants) {
        servers.get(p.keyHex)?.notify(
          'voice.roster',
          new Uint8Array(
            Buffer.from(
              JSON.stringify({
                sessionId: snapshot.sessionId,
                channelId: snapshot.channelId,
                participants: snapshot.participants,
              }),
              'utf8',
            ),
          ),
        );
      }
    });

    // A chave do host **como a réplica a enxerga**. Ela nasce `ZERO32` e só vira a chave de
    // verdade quando `community.create` é interpretado (§6) — depois de a comunidade abrir.
    // O runtime tem de lê-la a cada quadro; um valor de boot congela o zero.
    let chaveDoHostNaReplica = HOSTKEY.publicKey;
    const chaveDoHostVista = (): Buffer => chaveDoHostNaReplica;
    const verChaveDoHostComo = (b: Buffer): void => {
      chaveDoHostNaReplica = b;
    };

    function membro(keyHex: string) {
      const [hostSide, memberSide] = rpcPair();
      const server = new RpcServer({ protocol: 'community', transport: hostSide });
      servers.set(keyHex, server);
      registerHostMediaMethods(server, {
        peerKeyHex: keyHex,
        stateFor: () => voiceStateOf(state as unknown as DecisionState),
        voice,
        share,
        fila: {
          entrar: () => ({ ok: true as const }),
          sair: () => undefined,
          moderar: () => ({ ok: true as const }),
        },
        signal: relay,
      });
      const client = new RpcClient({ protocol: 'community', transport: memberSide });
      const dispatcher = remoteMediaDispatcher(client, { captureTokenTtlMs: 60_000, now: clock.now });
      const eventos: Array<{ topic: string; data: Record<string, unknown> }> = [];
      const runtime = startMediaRuntime({
        dispatcher,
        communityId: 'com-a',
        emit: (evs) => eventos.push(...evs),
        notifications: client,
        hostPublicKey: () => chaveDoHostVista(),
        selfPublicKey: Buffer.from(keyHex, 'hex'),
        ticketPeriodMs: 60_000,
        now: clock.now,
        schedule: () => null,
        cancel: () => {},
      });
      return { dispatcher, eventos, runtime, hostSide };
    }

    const a = membro(MEMBRO_HEX);
    const b = membro(APRESENTADOR_HEX);
    await a.dispatcher.voiceJoin({ communityId: 'com-a', channelId: CANAL });
    await b.dispatcher.voiceJoin({ communityId: 'com-a', channelId: CANAL });
    // `a` entrou sozinho: o ticket para `b` só existe depois que o roster novo chegou (§16.3)
    // e a renovação de §17.4 rodou. É a cadência que o `VoiceTicketRenewer` opera em produto.
    await a.dispatcher.renewTickets();
    return { a, b, voice, clock, verChaveDoHostComo };
  }

  it('a sinalização chega ao outro membro pela conexão dele, com a origem da conexão', async () => {
    const d = await dupla();
    try {
      assert.deepEqual(
        await d.a.dispatcher.voiceSignal({ peerKey: APRESENTADOR_HEX, ticketId: 't1', sdp: 'v=0\r\n' }),
        { ok: true },
      );

      const recebidos = d.b.eventos.filter((e) => e.topic === 'voice.signal');
      assert.equal(recebidos.length, 1);
      assert.equal(recebidos[0]?.data['peerKey'], MEMBRO_HEX);
      assert.equal(recebidos[0]?.data['sdp'], 'v=0\r\n');
      assert.equal(recebidos[0]?.data['communityId'], 'com-a');
      // Quem enviou não recebe de volta.
      assert.equal(d.a.eventos.filter((e) => e.topic === 'voice.signal').length, 0);
    } finally {
      d.a.runtime.stop();
      d.b.runtime.stop();
    }
  });

  /**
   * Regressão do achado do smoke de duas pontas (B45): a comunidade abre ANTES de o log
   * replicar, e nesse instante `ds.community.hostKey` ainda é `ZERO32`. Quando o runtime
   * capturava essa chave na abertura, o gate de §17.4 passo 3 passava a recusar TODA
   * sinalização vinda do host — para sempre, porque o valor congelado nunca mais era
   * relido. Só o membro verifica ticket (quem hospeda entrega a si mesmo pelo fan-out),
   * então nenhum teste de um lado só via o defeito: a chamada simplesmente não fechava.
   */
  it('a chave do host é lida a cada quadro — a réplica que chega depois destrava o gate', async () => {
    const d = await dupla();
    try {
      // A comunidade abriu antes da réplica: `hostKey` ainda é `ZERO32`.
      d.verChaveDoHostComo(Buffer.alloc(32));
      assert.deepEqual(
        await d.a.dispatcher.voiceSignal({ peerKey: APRESENTADOR_HEX, ticketId: 't1', sdp: 'v=0\r\n' }),
        { ok: true },
      );
      assert.equal(d.b.eventos.filter((e) => e.topic === 'voice.signal').length, 0);

      // O log replicou e `community.create` foi interpretado: o MESMO runtime passa a ver
      // a chave de verdade, sem reabrir comunidade nem reiniciar nada.
      d.verChaveDoHostComo(HOSTKEY.publicKey);
      assert.deepEqual(
        await d.a.dispatcher.voiceSignal({ peerKey: APRESENTADOR_HEX, ticketId: 't1', sdp: 'v=0\r\n' }),
        { ok: true },
      );
      const recebidos = d.b.eventos.filter((e) => e.topic === 'voice.signal');
      assert.equal(recebidos.length, 1);
      assert.equal(recebidos[0]?.data['peerKey'], MEMBRO_HEX);
    } finally {
      d.a.runtime.stop();
      d.b.runtime.stop();
    }
  });

  it('sem conexão para o destino, `E_PEER_UNREACHABLE` — sem promessa de entrega diferida', async () => {
    const d = await dupla();
    try {
      assert.deepEqual(
        await d.a.dispatcher.voiceSignal({ peerKey: 'ff'.repeat(32), ticketId: 't1', ice: 'candidate:1' }),
        { ok: false, code: 'E_PEER_UNREACHABLE' },
      );
    } finally {
      d.a.runtime.stop();
      d.b.runtime.stop();
    }
  });

  it('sinalização sem ticket válido para o par não chega ao renderer (§17.4 passo 3)', async () => {
    const d = await dupla();
    try {
      // Sai da chamada: o material da sessão morre, e o gate fecha.
      await d.b.dispatcher.voiceLeave();
      assert.equal(d.b.dispatcher.sessionSecurity(), null);
      assert.equal(
        signalIsAuthorized({
          security: d.b.dispatcher.sessionSecurity(),
          hostPublicKey: HOSTKEY.publicKey,
          selfPublicKey: APRESENTADOR.publicKey,
          peerKeyHex: MEMBRO_HEX,
          now: d.clock.now(),
        }),
        false,
      );

      // Um par que nunca esteve na sessão também não passa, mesmo com sessão viva.
      assert.equal(
        signalIsAuthorized({
          security: d.a.dispatcher.sessionSecurity(),
          hostPublicKey: HOSTKEY.publicKey,
          selfPublicKey: MEMBRO.publicKey,
          peerKeyHex: 'ff'.repeat(32),
          now: d.clock.now(),
        }),
        false,
      );
      // Nem o próprio: ninguém sinaliza consigo mesmo.
      assert.equal(
        signalIsAuthorized({
          security: d.a.dispatcher.sessionSecurity(),
          hostPublicKey: HOSTKEY.publicKey,
          selfPublicKey: MEMBRO.publicKey,
          peerKeyHex: MEMBRO_HEX,
          now: d.clock.now(),
        }),
        false,
      );
      // O par legítimo, com a sessão viva, passa.
      assert.equal(
        signalIsAuthorized({
          security: d.a.dispatcher.sessionSecurity(),
          hostPublicKey: HOSTKEY.publicKey,
          selfPublicKey: MEMBRO.publicKey,
          peerKeyHex: APRESENTADOR_HEX,
          now: d.clock.now(),
        }),
        true,
      );
      // E deixa de passar depois de o ticket expirar (§17.4).
      assert.equal(
        signalIsAuthorized({
          security: d.a.dispatcher.sessionSecurity(),
          hostPublicKey: HOSTKEY.publicKey,
          selfPublicKey: MEMBRO.publicKey,
          peerKeyHex: APRESENTADOR_HEX,
          now: d.clock.now() + MEDIA_TICKET_TTL_MS + 1,
        }),
        false,
      );
    } finally {
      d.a.runtime.stop();
      d.b.runtime.stop();
    }
  });

  it('o roster do host chega como evento de §15.5, com a comunidade na rota', async () => {
    const d = await dupla();
    try {
      // A entrada de `b` mudou o roster e o host empurrou por §16.3 — foi assim que `a`
      // passou a ter ticket para `b`, que é o que o teste anterior verifica.
      const rosters = d.a.eventos.filter((e) => e.topic === 'voice.roster');
      assert.ok(rosters.length >= 1, 'o roster do host virou evento no membro');
      const ultimo = rosters.at(-1)!;
      assert.equal(ultimo.data['communityId'], 'com-a');
      assert.deepEqual(
        (ultimo.data['participants'] as Array<{ keyHex: string }>).map((p) => p.keyHex).sort(),
        [APRESENTADOR_HEX, MEMBRO_HEX].sort(),
      );
      // Todo evento que sai do runtime carrega a rota da comunidade (§15.5).
      assert.equal(
        d.a.eventos.every((e) => e.data['communityId'] === 'com-a'),
        true,
      );
    } finally {
      d.a.runtime.stop();
      d.b.runtime.stop();
    }
  });

  it('a revogação do próprio membro derruba a sessão local sem round-trip (§17.4)', async () => {
    const d = await dupla();
    try {
      assert.notEqual(d.b.dispatcher.currentSessionId(), null);
      // O host revoga `b`: ban, kick, timeout ou canal apagado (§17.4).
      d.voice.leave({ sessionId: d.b.dispatcher.currentSessionId()!, memberKeyHex: APRESENTADOR_HEX });
      await new Promise((resolve) => setImmediate(resolve)); // o quadro atravessa a condução
      // A revogação chega por §16.3 e o cliente é obrigado a fechar imediatamente.
      assert.equal(d.b.eventos.some((e) => e.topic === 'voice.revoked'), true);
      assert.equal(d.b.dispatcher.currentSessionId(), null);
      assert.equal(d.b.dispatcher.sessionSecurity(), null);
    } finally {
      d.a.runtime.stop();
      d.b.runtime.stop();
    }
  });

  it('tópico fora da tabela de §16.3 é descartado sem derrubar a conexão', async () => {
    const d = await dupla();
    try {
      const antes = d.a.eventos.length;
      // Um host mais novo empurrando algo que este cliente não conhece.
      const server = new RpcServer({ protocol: 'community', transport: rpcPair()[0] });
      assert.equal(server.notify('coisa.futura', new Uint8Array()), false);
      assert.equal(d.a.eventos.length, antes);
      // E a conexão continua servindo pedidos normalmente.
      assert.deepEqual(await d.a.dispatcher.voiceSetSelf({ muted: true }), { ok: true });
    } finally {
      d.a.runtime.stop();
      d.b.runtime.stop();
    }
  });
});
