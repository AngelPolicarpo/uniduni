// Testes do lado host do `voiceCoordinator` — sessões de voz, tickets e revogação
// derivada do log (§17.4, §RPC `voiceJoin`/`voiceLeave`/`voiceState`/`voiceTicket`, A22).
// O `DecisionState` real das fixtures prova que a porta `VoiceStatePort` é satisfeita
// pela estrutura de L1 sem importá-la (§4).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  VoiceHostSessions,
  verifyMediaTicket,
  type RevokedTarget,
  type RosterSnapshot,
} from '../src/l2/voiceCoordinator/index.ts';
import { issueTurnCredential } from '../src/l2/communityHost/stunTurn.ts';
import {
  MEDIA_TICKET_TTL_MS,
} from '../src/l1/fold/constants.ts';
import { genesis, joinMember, keypairFromSeed, makeRecord, T0, type Genesis } from './helpers/world.ts';

const HOST = keypairFromSeed('host-sessoes');

function fakeClock(): { now(): number; advance(ms: number): void } {
  let t = T0 + 500_000;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

interface Rig {
  clock: ReturnType<typeof fakeClock>;
  sessions: VoiceHostSessions;
  revoked: RevokedTarget[];
  rosters: RosterSnapshot[];
}

function rig(overrides: Partial<ConstructorParameters<typeof VoiceHostSessions>[0]> = {}): Rig {
  const clock = fakeClock();
  const revoked: RevokedTarget[] = [];
  const rosters: RosterSnapshot[] = [];
  let n = 0;
  const sessions = new VoiceHostSessions({
    hostSecretKey: HOST.secretKey,
    hostTurnSecret: Buffer.alloc(32, 5),
    clock,
    ttlMs: MEDIA_TICKET_TTL_MS,
    isVoiceChannelType: (type) => type === 1,
    sessionIdFactory: () => `sess-${++n}`,
    iceServers: () => [{ urls: 'stun:203.0.113.1:3478' }],
    onRevoked: (targets) => revoked.push(...targets),
    onRosterChanged: (snapshot) => rosters.push(snapshot),
    ...overrides,
  });
  return { clock, sessions, revoked, rosters };
}

/** Canal de voz com authorSeq explícito — `world.id` exige o mesmo número do submit. */
function addVoiceChannel(g: Genesis, name: string, hostTs: number): string {
  const seq = g.world.next(g.founder);
  g.world.push(
    makeRecord(g.world.core, {
      kind: 'channel.create',
      author: g.founder,
      authorSeq: seq,
      hostTs,
      payload: { categoryId: g.categoryId, type: 1, name, readOnlyForRoleIds: [] },
    }),
  );
  return g.world.id('channel', g.founder, seq);
}

/** Gênese real + canal de voz próprio; membros com o cargo base têm `voice_speak`. */
function voiceWorld(): { g: Genesis; vozId: string; alice: ReturnType<typeof keypairFromSeed>; bob: ReturnType<typeof keypairFromSeed> } {
  const g = genesis();
  const vozId = addVoiceChannel(g, 'voz', T0 + 50);
  const alice = joinMember(g, 'alice');
  const bob = joinMember(g, 'bob');
  return { g, vozId, alice, bob };
}

/** Canal de voz num estado mínimo da porta — para casos que não precisam do log. */
function miniPort(overrides: Partial<Parameters<VoiceHostSessions['join']>[0]['state']> = {}): Parameters<VoiceHostSessions['join']>[0]['state'] {
  const alice = keypairFromSeed('mini-alice').publicKey.toString('hex');
  return {
    community: { exists: true },
    channels: new Map([['ch-voz', { type: 1, speechMode: 0 }]]),
    members: new Map([[alice, { state: 'active', roleIds: ['r-voz'] }]]),
    roles: new Map([['r-voz', { permissions: [9] }]]), // 9 = voice_speak (§9.1)
    ...overrides,
  };
}

/** Estreteita o desfecho para leitura do código em asserções. */
function codeOf(result: { ok: true } | { ok: false; code: string }): 'ok' | string {
  return result.ok ? 'ok' : result.code;
}

// ─── voiceJoin — validação de §17.4 passo 1 ─────────────────────────────────────────────

describe('voiceJoin — validação de §17.4 passo 1', () => {
  it('entra com DecisionState real: sessão, roster, credencial TURN e gelo', () => {
    const { g, vozId, alice } = voiceWorld();
    const r = rig();
    const joined = r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: alice.publicKey.toString('hex') });
    assert.equal(joined.ok, true);
    if (!joined.ok) return;
    assert.equal(joined.sessionId, 'sess-1');
    assert.deepEqual(joined.roster.map((e) => e.keyHex), [alice.publicKey.toString('hex')]);
    assert.deepEqual(joined.tickets, []);
    assert.equal(joined.turnCredential.username, `${joined.sessionId}:${r.clock.now() + MEDIA_TICKET_TTL_MS}`);
    assert.deepEqual(joined.iceServers, [{ urls: 'stun:203.0.113.1:3478' }]);
    assert.deepEqual(
      issueTurnCredential(Buffer.alloc(32, 5), joined.sessionId, alice.publicKey, r.clock.now() + MEDIA_TICKET_TTL_MS),
      joined.turnCredential,
    );
    assert.equal(r.rosters.length, 1);
    assert.equal(r.sessions.participantKeys(joined.sessionId).size, 1);
  });

  it('canal de texto é E_CHANNEL_NOT_VOICE; canal ausente é E_CHANNEL_NOT_FOUND', () => {
    const { g, alice } = voiceWorld();
    const r = rig();
    assert.equal(codeOf(r.sessions.join({ state: g.world.state, channelId: g.channelId, memberKeyHex: alice.publicKey.toString('hex') })), 'E_CHANNEL_NOT_VOICE');
    assert.equal(codeOf(r.sessions.join({ state: g.world.state, channelId: 'canal-fantasma', memberKeyHex: alice.publicKey.toString('hex') })), 'E_CHANNEL_NOT_FOUND');
  });

  it('quem nunca entrou é E_NOT_MEMBER; banido é E_BANNED mesmo com cargo válido', () => {
    const { g, vozId, alice, bob } = voiceWorld();
    const r = rig();
    const fantasma = keypairFromSeed('fantasma');
    assert.equal(codeOf(r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: fantasma.publicKey.toString('hex') })), 'E_NOT_MEMBER');

    g.world.submit({ kind: 'mod.ban', author: g.founder, hostTs: T0 + 400, payload: { targetKey: bob.publicKey } });
    assert.equal(g.world.state.members.get(bob.publicKey.toString('hex'))?.state, 'banned');
    assert.equal(codeOf(r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: bob.publicKey.toString('hex') })), 'E_BANNED');
    void alice;
  });

  it('timeout ativo é E_TIMED_OUT e expira sozinho', () => {
    const { g, vozId, alice } = voiceWorld();
    const r = rig();
    const hostTs = r.clock.now();
    g.world.submit({
      kind: 'mod.timeout',
      author: g.founder,
      hostTs,
      payload: { targetKey: alice.publicKey, until: hostTs + 120_000 },
    });
    assert.equal(codeOf(r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: alice.publicKey.toString('hex') })), 'E_TIMED_OUT');
    r.clock.advance(121_000);
    assert.equal(r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: alice.publicKey.toString('hex') }).ok, true);
  });

  it('comunidade ended e inexistente são recusadas; falta de voice_speak é E_PERMISSION_DENIED', () => {
    const r = rig();
    const hex = keypairFromSeed('mini-alice').publicKey.toString('hex');
    assert.equal(codeOf(r.sessions.join({ state: miniPort({ community: { exists: false } }), channelId: 'ch-voz', memberKeyHex: hex })), 'E_NOT_FOUND');
    assert.equal(codeOf(r.sessions.join({ state: miniPort({ community: { exists: true, endedAt: 1 } }), channelId: 'ch-voz', memberKeyHex: hex })), 'E_COMMUNITY_ENDED');
    assert.equal(
      codeOf(
        r.sessions.join({
          state: miniPort({ roles: new Map([['r-voz', { permissions: [] }]]) }),
          channelId: 'ch-voz',
          memberKeyHex: hex,
        }),
      ),
      'E_PERMISSION_DENIED',
    );
  });
});

// ─── Sessão, roster e renovação ────────────────────────────────────────────────────────

describe('sessão de voz — roster, pares e tetos', () => {
  it('segundo participante recebe ticket par-a-par verificável pelo cliente', () => {
    const { g, vozId, alice, bob } = voiceWorld();
    const r = rig();
    const a = r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: alice.publicKey.toString('hex') });
    const b = r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: bob.publicKey.toString('hex') });
    assert.ok(a.ok && b.ok);
    if (!a.ok || !b.ok) return;
    assert.equal(a.sessionId, b.sessionId);
    // alice recebeu ticket para bob; verifica na orientação dela
    const ticketDeBobParaAlice = b.tickets.find((t) =>
      verifyMediaTicket(HOST.publicKey, t, {
        sessionId: b.sessionId,
        channelId: vozId,
        localPeer: bob.publicKey,
        remotePeer: alice.publicKey,
      }, r.clock.now()).ok,
    );
    assert.ok(ticketDeBobParaAlice !== undefined);
    // o roster vivo tem os dois; o snapshot de cada resposta também
    const vivos = r.sessions.sessionOf(vozId)!.participants.map((e) => e.keyHex).sort();
    assert.deepEqual(vivos, [alice.publicKey.toString('hex'), bob.publicKey.toString('hex')].sort());
    assert.deepEqual(a.roster.map((e) => e.keyHex), [alice.publicKey.toString('hex')]);
    // roster ordena determinístico
    assert.deepEqual(b.roster, [...b.roster].sort((x, y) => x.keyHex.localeCompare(y.keyHex)));
  });

  it('re-entrada no mesmo canal devolve a mesma sessão com material fresco', () => {
    const { g, vozId, alice, bob } = voiceWorld();
    const r = rig();
    const primeira = r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: alice.publicKey.toString('hex') });
    r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: bob.publicKey.toString('hex') });
    r.clock.advance(60_000);
    const segunda = r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: alice.publicKey.toString('hex') });
    assert.ok(primeira.ok && segunda.ok);
    if (!primeira.ok || !segunda.ok) return;
    assert.equal(segunda.sessionId, primeira.sessionId);
    assert.equal(segunda.tickets.length, 1);
    assert.equal(segunda.tickets[0]!.expiresAt, r.clock.now() + MEDIA_TICKET_TTL_MS);
    assert.notEqual(segunda.tickets[0]!.sig.toString('hex'), primeira.tickets[0]?.sig.toString('hex'));
  });

  // §90 — o teto de ocupação saiu. Não é "o número ficou grande": não há contagem, e é
  // isto que este teste fixa, porque a recusa por lotação era um caminho de código com
  // erro nomeado (`E_VOICE_FULL`) e um caminho apagado que volta sozinho é o defeito
  // clássico deste repositório.
  it('não há teto de participantes: quem é elegível entra, e a sessão é uma só', () => {
    const { g, vozId, alice, bob } = voiceWorld();
    const r = rig();
    const primeira = r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: alice.publicKey.toString('hex') });
    assert.equal(primeira.ok, true);
    const segunda = r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: bob.publicKey.toString('hex') });
    assert.equal(codeOf(segunda), 'ok');
    assert.ok(primeira.ok && segunda.ok);
    if (!primeira.ok || !segunda.ok) return;
    assert.equal(segunda.sessionId, primeira.sessionId);
    assert.equal(segunda.roster.length, 2);
  });

  it('entrar noutra chamada sai da anterior e revoga aos que ficaram', () => {
    const { g, vozId, alice, bob } = voiceWorld();
    const voz2 = addVoiceChannel(g, 'voz-2', T0 + 200);
    const r = rig();
    r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: alice.publicKey.toString('hex') });
    r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: bob.publicKey.toString('hex') });
    r.revoked.length = 0;
    const nova = r.sessions.join({ state: g.world.state, channelId: voz2, memberKeyHex: alice.publicKey.toString('hex') });
    assert.ok(nova.ok);
    assert.equal(r.revoked.length, 1);
    assert.equal(r.revoked[0]!.targetKeyHex, alice.publicKey.toString('hex'));
    assert.equal(r.revoked[0]!.channelId, vozId);
    assert.equal(r.sessions.participantKeys(nova.ok ? nova.sessionId : '').has(alice.publicKey.toString('hex')), true);
  });
});

// ─── voiceLeave e derivação de revogação ────────────────────────────────────────────────

describe('voiceLeave e sweepAgainst — revogação de §17.4', () => {
  it('leave emite voice.revoked{targetKey} e encerra sessão vazia', () => {
    const { g, vozId, alice, bob } = voiceWorld();
    const r = rig();
    const a = r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: alice.publicKey.toString('hex') });
    r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: bob.publicKey.toString('hex') });
    assert.ok(a.ok);
    if (!a.ok) return;
    r.revoked.length = 0;
    const left = r.sessions.leave({ sessionId: a.sessionId, memberKeyHex: alice.publicKey.toString('hex') });
    assert.deepEqual(left, { ok: true });
    // §17.4 — a revogação vai a TODOS os participantes do instante, alvo incluído.
    assert.deepEqual(r.revoked, [
      {
        sessionId: a.sessionId,
        channelId: vozId,
        targetKeyHex: alice.publicKey.toString('hex'),
        reason: 'left',
        recipients: [alice.publicKey.toString('hex'), bob.publicKey.toString('hex')].sort(),
      },
    ]);
    assert.equal(r.sessions.sessionOf(vozId)!.participants.length, 1);
    r.sessions.leave({ sessionId: a.sessionId, memberKeyHex: bob.publicKey.toString('hex') });
    assert.equal(r.sessions.sessionCount, 0);
    assert.equal(codeOf(r.sessions.leave({ sessionId: a.sessionId, memberKeyHex: bob.publicKey.toString('hex') })), 'E_SESSION_GONE');
  });

  it('ban no meio da chamada derruba só o alvo no sweep', () => {
    const { g, vozId, alice, bob } = voiceWorld();
    const r = rig();
    const a = r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: alice.publicKey.toString('hex') });
    r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: bob.publicKey.toString('hex') });
    assert.ok(a.ok);
    if (!a.ok) return;
    r.revoked.length = 0;
    g.world.submit({ kind: 'mod.ban', author: g.founder, hostTs: r.clock.now(), payload: { targetKey: alice.publicKey } });
    r.rosters.length = 0;
    const emitted = r.sessions.sweepAgainst(g.world.state);
    assert.deepEqual(emitted, [
      {
        sessionId: a.sessionId,
        channelId: vozId,
        targetKeyHex: alice.publicKey.toString('hex'),
        reason: 'moderation',
        recipients: [alice.publicKey.toString('hex'), bob.publicKey.toString('hex')].sort(),
      },
    ]);
    assert.equal(r.sessions.participantKeys(a.sessionId).has(alice.publicKey.toString('hex')), false);
    // §17.6 — quem FICA recebe o roster novo no mesmo instante. Sem isto o banido só sumia
    // da tela de quem ficou no próximo `voiceJoin`, e a `RTCPeerConnection` seguia aberta.
    assert.equal(r.rosters.length, 1);
    assert.deepEqual(r.rosters[0]!.participants.map((p) => p.keyHex), [bob.publicKey.toString('hex')]);
    assert.equal(codeOf(r.sessions.renewTicket({ state: g.world.state, sessionId: a.sessionId, memberKeyHex: alice.publicKey.toString('hex'), peerKeyHex: bob.publicKey.toString('hex') })), 'E_TICKET_DENIED');
  });

  it('channel.delete encerra a sessão inteira; fim da comunidade também', () => {
    const { g, vozId, alice, bob } = voiceWorld();
    const r = rig();
    const a = r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: alice.publicKey.toString('hex') });
    r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: bob.publicKey.toString('hex') });
    assert.ok(a.ok);
    if (!a.ok) return;
    g.world.submit({ kind: 'channel.delete', author: g.founder, hostTs: r.clock.now(), payload: { channelId: vozId } });
    const emitted = r.sessions.sweepAgainst(g.world.state);
    assert.equal(emitted.length, 2);
    assert.equal(r.sessions.sessionCount, 0);
  });

  it('fim da comunidade derruba qualquer sessão restante', () => {
    const { g, vozId, alice } = voiceWorld();
    const r = rig();
    const a = r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: alice.publicKey.toString('hex') });
    assert.ok(a.ok);
    if (!a.ok) return;
    const emitted = r.sessions.sweepAgainst({
      community: { exists: false },
      channels: new Map(),
      members: new Map(),
      roles: new Map(),
    });
    assert.deepEqual(emitted, [
      {
        sessionId: a.sessionId,
        channelId: vozId,
        targetKeyHex: alice.publicKey.toString('hex'),
        reason: 'community-ended',
        recipients: [alice.publicKey.toString('hex')],
      },
    ]);
    assert.equal(r.sessions.sessionCount, 0);
  });

  it('canal apagado nomeia o motivo — §19.8 exige `voice.failed{reason}`', () => {
    const { g, vozId, alice, bob } = voiceWorld();
    const r = rig();
    const a = r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: alice.publicKey.toString('hex') });
    r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: bob.publicKey.toString('hex') });
    assert.ok(a.ok);
    if (!a.ok) return;
    g.world.submit({ kind: 'channel.delete', author: g.founder, hostTs: r.clock.now(), payload: { channelId: vozId } });
    const emitted = r.sessions.sweepAgainst(g.world.state);
    assert.equal(emitted.length, 2);
    assert.deepEqual(new Set(emitted.map((t) => t.reason)), new Set(['channel-deleted']));
    // Todo mundo que estava na chamada é destinatário de todas as revogações do lote.
    for (const t of emitted) {
      assert.deepEqual([...t.recipients].sort(), [alice.publicKey.toString('hex'), bob.publicKey.toString('hex')].sort());
    }
  });
});

// ─── Vivacidade: queda de conexão é saída (§17.4 emendado, §22.1 voice.liveness) ─────────

describe('dropPeer e sweepLiveness — o participante fantasma de 2026-08-26', () => {
  it('queda de conexão tira do roster, revoga a quem ficou e zera a ocupação', () => {
    const { g, vozId, alice, bob } = voiceWorld();
    const r = rig();
    const a = r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: alice.publicKey.toString('hex') });
    r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: bob.publicKey.toString('hex') });
    assert.ok(a.ok);
    if (!a.ok) return;
    r.revoked.length = 0;
    r.rosters.length = 0;

    const emitted = r.sessions.dropPeer(alice.publicKey.toString('hex'));

    assert.deepEqual(emitted, [
      {
        sessionId: a.sessionId,
        channelId: vozId,
        targetKeyHex: alice.publicKey.toString('hex'),
        reason: 'peer-gone',
        recipients: [alice.publicKey.toString('hex'), bob.publicKey.toString('hex')].sort(),
      },
    ]);
    assert.equal(r.sessions.participantKeys(a.sessionId).has(alice.publicKey.toString('hex')), false);
    assert.deepEqual(r.rosters.at(-1)!.participants.map((p) => p.keyHex), [bob.publicKey.toString('hex')]);
    // Quem cai deixa de renovar ticket: a rede de segurança de §17.4 continua valendo.
    assert.equal(
      codeOf(r.sessions.renewTicket({ state: g.world.state, sessionId: a.sessionId, memberKeyHex: alice.publicKey.toString('hex'), peerKeyHex: bob.publicKey.toString('hex') })),
      'E_TICKET_DENIED',
    );
    // Idempotente: o mesmo par caindo de novo (detach tardio) não emite nada.
    assert.deepEqual(r.sessions.dropPeer(alice.publicKey.toString('hex')), []);
  });

  it('sozinho na chamada, a queda encerra a sessão inteira', () => {
    const { g, vozId, alice } = voiceWorld();
    const r = rig();
    const a = r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: alice.publicKey.toString('hex') });
    assert.ok(a.ok);
    if (!a.ok) return;
    r.rosters.length = 0;
    r.sessions.dropPeer(alice.publicKey.toString('hex'));
    assert.equal(r.sessions.sessionCount, 0);
    // §15.5 `voice.occupancyChanged` — a ocupação do canal precisa voltar a zero.
    assert.deepEqual(r.rosters.at(-1)!.participants, []);
  });

  it('a varredura de vivacidade derruba quem o predicado não vê vivo, e só ele', () => {
    const { g, vozId, alice, bob } = voiceWorld();
    const r = rig();
    const a = r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: alice.publicKey.toString('hex') });
    r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: bob.publicKey.toString('hex') });
    assert.ok(a.ok);
    if (!a.ok) return;
    r.revoked.length = 0;

    const vivos = new Set([bob.publicKey.toString('hex')]);
    const emitted = r.sessions.sweepLiveness((k) => vivos.has(k));

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]!.targetKeyHex, alice.publicKey.toString('hex'));
    assert.equal(emitted[0]!.reason, 'peer-gone');
    assert.deepEqual(r.sessions.sessionOf(vozId)!.participants.map((p) => p.keyHex), [bob.publicKey.toString('hex')]);
    // Segunda volta com todo mundo vivo não emite nada — a varredura não é destrutiva.
    assert.deepEqual(r.sessions.sweepLiveness((k) => vivos.has(k)), []);
  });
});

// ─── voiceState ─────────────────────────────────────────────────────────────────────────

describe('voiceState — estado próprio e teto de câmeras', () => {
  it('aplica o patch e reflete no roster; sessão alheia é E_SESSION_GONE', () => {
    const { g, vozId, alice } = voiceWorld();
    const r = rig();
    const a = r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: alice.publicKey.toString('hex') });
    assert.ok(a.ok);
    if (!a.ok) return;
    r.rosters.length = 0;
    const patched = r.sessions.setSelf({
      state: g.world.state,
      sessionId: a.sessionId,
      memberKeyHex: alice.publicKey.toString('hex'),
      patch: { muted: true, deafened: true, speaking: true },
    });
    assert.deepEqual(patched, { ok: true });
    assert.equal(r.rosters.at(-1)?.participants[0]?.muted, true);
    assert.equal(codeOf(r.sessions.setSelf({ state: g.world.state, sessionId: 'outra', memberKeyHex: alice.publicKey.toString('hex'), patch: { muted: true } })), 'E_SESSION_GONE');
  });

  it('não há teto de câmeras: a segunda a ligar não é recusada (§90)', () => {
    const { g, vozId, alice, bob } = voiceWorld();
    const r = rig();
    const a = r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: alice.publicKey.toString('hex') });
    r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: bob.publicKey.toString('hex') });
    assert.ok(a.ok);
    if (!a.ok) return;
    assert.equal(r.sessions.setSelf({ state: g.world.state, sessionId: a.sessionId, memberKeyHex: alice.publicKey.toString('hex'), patch: { cameraOn: true } }).ok, true);
    assert.equal(codeOf(r.sessions.setSelf({ state: g.world.state, sessionId: a.sessionId, memberKeyHex: bob.publicKey.toString('hex'), patch: { cameraOn: true } })), 'ok');
    assert.equal(r.rosters.at(-1)?.participants.filter((x) => x.cameraOn).length, 2);
  });
});

// ─── voiceTicket ────────────────────────────────────────────────────────────────────────

describe('voiceTicket — renovação par-a-par (§26.2)', () => {
  it('renova para par presente e elegível; recusa fora da sessão e a si mesmo', () => {
    const { g, vozId, alice, bob } = voiceWorld();
    const r = rig();
    const a = r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: alice.publicKey.toString('hex') });
    r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: bob.publicKey.toString('hex') });
    assert.ok(a.ok);
    if (!a.ok) return;
    const renewed = r.sessions.renewTicket({
      state: g.world.state,
      sessionId: a.sessionId,
      memberKeyHex: alice.publicKey.toString('hex'),
      peerKeyHex: bob.publicKey.toString('hex'),
    });
    assert.equal(renewed.ok, true);
    if (!renewed.ok) return;
    assert.equal(renewed.expiresAt, r.clock.now() + MEDIA_TICKET_TTL_MS);
    assert.equal(renewed.ticketId.length > 0, true);
    assert.equal(
      verifyMediaTicket(HOST.publicKey, renewed.ticket, {
        sessionId: a.sessionId,
        channelId: vozId,
        localPeer: alice.publicKey,
        remotePeer: bob.publicKey,
      }, r.clock.now()).ok,
      true,
    );

    const estranho = keypairFromSeed('estranho').publicKey.toString('hex');
    assert.equal(codeOf(r.sessions.renewTicket({ state: g.world.state, sessionId: a.sessionId, memberKeyHex: alice.publicKey.toString('hex'), peerKeyHex: estranho })), 'E_TICKET_DENIED');
    assert.equal(codeOf(r.sessions.renewTicket({ state: g.world.state, sessionId: a.sessionId, memberKeyHex: alice.publicKey.toString('hex'), peerKeyHex: alice.publicKey.toString('hex') })), 'E_TICKET_DENIED');
  });
});

// ─── §17.4 (emenda de 2026-08-28) — o gate de transmissão do modo de fala ───────────────

describe('modo de fala — o gate de transmissão (§17.4, R-29)', () => {
  /** `miniPort` com canais nomeados e permissões por cargo — base dos casos do modo. */
  function portModo(speechMode: number): Parameters<VoiceHostSessions['join']>[0]['state'] & { members: Map<string, { state: 'active'; roleIds: string[] }> } {
    return {
      community: { exists: true },
      channels: new Map([['ch-voz', { type: 1, speechMode }]]),
      members: new Map([
        ['alice', { state: 'active' as const, roleIds: ['r-voz'] }],
        ['bob', { state: 'active' as const, roleIds: ['r-mod'] }],
      ]),
      roles: new Map([
        ['r-voz', { permissions: [9] }], // voice_speak
        ['r-mod', { permissions: [9, 10] }], // voice_speak + voice_mute_others
      ]),
    } as never;
  }

  function permsDe(st: { roles: ReadonlyMap<string, { permissions: Iterable<number> }> }, roleId: string, permissao: number): boolean {
    for (const p of st.roles.get(roleId)?.permissions ?? []) if (p === permissao) return true;
    return false;
  }

  it('modo admins: quem entra SEM voice_mute_others entra BLOQUEADO e não desmuta', () => {
    const state = portModo(2);
    const r = rig({
      canTransmit: ({ state: st, channelId, memberKeyHex }) => {
        const canal = st.channels.get(channelId);
        if (canal?.speechMode === 2) {
          for (const roleId of st.members.get(memberKeyHex)?.roleIds ?? []) {
            if (permsDe(st, roleId, 10)) return true;
          }
          return false;
        }
        return true;
      },
    });
    const joined = r.sessions.join({ state, channelId: 'ch-voz', memberKeyHex: 'alice' });
    assert.ok(joined.ok);
    if (!joined.ok) return;
    // O roster inicial já impõe o mute — o pedido do cliente não manda no modo.
    assert.equal(joined.roster[0]?.muted, true);
    assert.equal(codeOf(r.sessions.setSelf({ state, sessionId: joined.sessionId, memberKeyHex: 'alice', patch: { muted: false } })), 'E_PERMISSION_DENIED');
    assert.equal(r.rosters.at(-1)?.participants[0]?.muted, true);
  });

  it('modo admins: quem TEM voice_mute_others entra livre e desmuta', () => {
    const state = portModo(2);
    const r = rig({
      canTransmit: ({ state: st, channelId, memberKeyHex }) => {
        const canal = st.channels.get(channelId);
        if (canal?.speechMode === 2) {
          for (const roleId of st.members.get(memberKeyHex)?.roleIds ?? []) {
            if (permsDe(st, roleId, 10)) return true;
          }
          return false;
        }
        return true;
      },
    });
    const joined = r.sessions.join({ state, channelId: 'ch-voz', memberKeyHex: 'bob' });
    assert.ok(joined.ok);
    if (!joined.ok) return;
    assert.equal(joined.roster[0]?.muted, false);
    const mudo = r.sessions.setSelf({ state, sessionId: joined.sessionId, memberKeyHex: 'bob', patch: { muted: true } });
    assert.deepEqual(mudo, { ok: true });
    assert.equal(codeOf(r.sessions.setSelf({ state, sessionId: joined.sessionId, memberKeyHex: 'bob', patch: { muted: false } })), 'ok');
  });

  it('modo fila: só o titular do turno desmuta — quem entra, entra bloqueado', () => {
    const state = portModo(1);
    const titulares = new Map([['ch-voz', 'bob']]);
    const r = rig({
      canTransmit: ({ state: st, channelId, memberKeyHex }) => titulares.get(channelId) === memberKeyHex,
    });
    const alice = r.sessions.join({ state, channelId: 'ch-voz', memberKeyHex: 'alice' });
    const bob = r.sessions.join({ state, channelId: 'ch-voz', memberKeyHex: 'bob' });
    assert.ok(alice.ok && bob.ok);
    if (!alice.ok || !bob.ok) return;
    assert.equal(codeOf(r.sessions.setSelf({ state, sessionId: alice.sessionId, memberKeyHex: 'alice', patch: { muted: false } })), 'E_PERMISSION_DENIED');
    assert.equal(codeOf(r.sessions.setSelf({ state, sessionId: bob.sessionId, memberKeyHex: 'bob', patch: { muted: false } })), 'ok');
  });

  it('a troca de modo aplica NA HORA: a varredura silencia quem perdeu o direito', () => {
    const state = portModo(0); // free — alice entra falando
    const titulares = new Map<string, string>();
    const r = rig({
      canTransmit: ({ state: st, channelId, memberKeyHex }) => {
        const canal = st.channels.get(channelId);
        if (canal?.speechMode === 1) return titulares.get(channelId) === memberKeyHex;
        if (canal?.speechMode === 2) {
          for (const roleId of st.members.get(memberKeyHex)?.roleIds ?? []) {
            if (permsDe(st, roleId, 10)) return true;
          }
          return false;
        }
        return true;
      },
    });
    const joined = r.sessions.join({ state, channelId: 'ch-voz', memberKeyHex: 'alice' });
    assert.ok(joined.ok);
    if (!joined.ok) return;
    assert.equal(joined.roster[0]?.muted, false);

    // O log virou o canal para modo fila (sem titular): a próxima varredura — que roda
    // a cada admissão projetada — impõe o mute pelo roster.
    (state.channels as Map<string, { type: number; speechMode: number }>).set('ch-voz', { type: 1, speechMode: 1 });
    const emitted = r.sessions.sweepAgainst(state);
    assert.deepEqual(emitted, []);
    assert.equal(r.rosters.at(-1)?.participants[0]?.muted, true);
  });
});


// ─── §16.4 (emenda de 2026-08-28) — a troca de turno aplicada no roster NO ATO ──────────

describe('imporTurno — quem ganha a vez abre o mic; quem perde é silenciado', () => {
  /** Dois membros num canal em modo fila — o caso do karaokê. */
  function portFila(): Parameters<VoiceHostSessions['join']>[0]['state'] {
    return {
      community: { exists: true },
      channels: new Map([['ch-voz', { type: 1, speechMode: 1 }]]),
      members: new Map([
        ['alice', { state: 'active' as const, roleIds: ['r-voz'] }],
        ['bob', { state: 'active' as const, roleIds: ['r-voz'] }],
      ]),
      roles: new Map([['r-voz', { permissions: [9] }]]),
    };
  }

  it('o titular novo entra no palco com o microfone ABERTO pelo host', () => {
    const r = rig();
    const state = portFila();
    const s = r.sessions.join({ state, channelId: 'ch-voz', memberKeyHex: 'alice' });
    const b = r.sessions.join({ state, channelId: 'ch-voz', memberKeyHex: 'bob' });
    assert.ok(s.ok && b.ok);
    if (!s.ok || !b.ok) return;
    // Quem entra em modo fila entra BLOQUEADO (gate de §17.4 — aqui o rig não injeta
    // canTransmit, então entramos já sabendo que a imposição do turno é quem manda)…
    r.sessions.imporTurno('ch-voz', 'alice');
    assert.equal(r.rosters.at(-1)?.participants.every((p) => p.muted), false);
    // …a promoção levanta a imposição do titular NO ATO, sem esperar op projetada…
    r.rosters.length = 0;
    r.sessions.imporTurno('ch-voz', 'bob');
    const roster = r.rosters.at(-1)?.participants ?? [];
    assert.equal(roster.find((p) => p.keyHex === 'bob')?.muted, false);
    // …e silencia quem perdeu a vez.
    assert.equal(roster.find((p) => p.keyHex === 'alice')?.muted, true);
  });

  it('fim de fila sem sucessor silencia o ex-titular — o mic não fica aberto para sempre', () => {
    const r = rig();
    const state = portFila();
    const s = r.sessions.join({ state, channelId: 'ch-voz', memberKeyHex: 'alice' });
    assert.ok(s.ok);
    if (!s.ok) return;
    r.sessions.imporTurno('ch-voz', 'alice');
    assert.equal(r.rosters.at(-1)?.participants[0]?.muted, false);
    r.sessions.imporTurno('ch-voz', null);
    assert.equal(r.rosters.at(-1)?.participants[0]?.muted, true);
  });

  it('canal sem sessão não faz nada — imporTurno de fila morta é inofensivo', () => {
    const r = rig();
    r.sessions.imporTurno('canal-fantasma', 'alice');
    assert.equal(r.rosters.length, 0);
  });
});

// ─── setSharing — o `sharing` do roster passa a ser escrito (§6.16, 2026-09-06) ──────────

/**
 * O campo `sharing` está no contrato de `VoiceRoster` desde o início e o host publicava
 * `false` constante. O custo não era cosmético: o renderer reconstrói a lista a cada roster,
 * então a marca que `share.started` acendia era apagada pelo roster seguinte — o de qualquer
 * `voiceState` de qualquer participante. Sumiam junto o ícone de quem apresenta e a
 * confirmação de §11 (C11) ao sair da chamada compartilhando.
 *
 * A autoridade é do host porque a SESSÃO é dele: o cliente não declara o que não decide.
 */
describe('setSharing — quem escreve o `sharing` do roster (§6.16, 2026-09-06)', () => {
  it('marca e desmarca o apresentador, e o roster republicado leva a marca', () => {
    const { g, vozId, alice, bob } = voiceWorld();
    const r = rig();
    const aliceHex = alice.publicKey.toString('hex');
    r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: aliceHex });
    r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: bob.publicKey.toString('hex') });

    // Entrar na chamada não é apresentar: ninguém nasce com a marca.
    const aoEntrar = r.rosters.at(-1)!;
    assert.equal(aoEntrar.participants.every((p) => p.sharing === false), true);

    r.sessions.setSharing(vozId, aliceHex, true);

    const comTela = r.rosters.at(-1)!;
    assert.equal(comTela.participants.find((p) => p.keyHex === aliceHex)?.sharing, true);
    // Só quem apresenta: a marca é de um participante, não da sessão.
    assert.equal(comTela.participants.filter((p) => p.sharing).length, 1);

    r.sessions.setSharing(vozId, aliceHex, false);
    assert.equal(r.rosters.at(-1)!.participants.find((p) => p.keyHex === aliceHex)?.sharing, false);
  });

  it('é idempotente: repetir o mesmo valor não republica o roster', () => {
    const { g, vozId, alice } = voiceWorld();
    const r = rig();
    const aliceHex = alice.publicKey.toString('hex');
    r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: aliceHex });

    r.sessions.setSharing(vozId, aliceHex, true);
    const depoisDaPrimeira = r.rosters.length;
    r.sessions.setSharing(vozId, aliceHex, true);

    // Um `share.viewersChanged` não pode custar um roster à chamada inteira.
    assert.equal(r.rosters.length, depoisDaPrimeira);
  });

  it('canal sem sessão ou participante fora dela não republica nada', () => {
    const { g, vozId, alice, bob } = voiceWorld();
    const r = rig();
    r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: alice.publicKey.toString('hex') });
    const antes = r.rosters.length;

    r.sessions.setSharing('ch-que-nao-existe', alice.publicKey.toString('hex'), true);
    r.sessions.setSharing(vozId, bob.publicKey.toString('hex'), true);

    assert.equal(r.rosters.length, antes);
  });

  it('quem entra de novo entra sem a marca — a sessão de tela vive DENTRO da chamada (A19)', () => {
    const { g, vozId, alice } = voiceWorld();
    const r = rig();
    const aliceHex = alice.publicKey.toString('hex');
    const joined = r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: aliceHex });
    assert.equal(joined.ok, true);
    if (!joined.ok) return;
    r.sessions.setSharing(vozId, aliceHex, true);

    r.sessions.leave({ sessionId: joined.sessionId, memberKeyHex: aliceHex });
    r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: aliceHex });

    assert.equal(r.rosters.at(-1)!.participants.find((p) => p.keyHex === aliceHex)?.sharing, false);
  });
});

describe('§18.7 — `inCallCount` conta pessoas, não canais', () => {
  /*
    O DTO de `host.exitImpact` publicava `sessionCount`, que é o tamanho do mapa de
    SESSÕES. Os dois desfechos errados que isso produzia no modal de U-06:

      - oito pessoas no mesmo canal viravam "1 em chamada" (uma sessão), subdimensionando
        exatamente o impacto que o modal existe para mostrar;
      - o host sozinho num canal virava "1 em chamada" (uma sessão, a dele), e fechar o
        app avisava que derrubaria alguém — sendo o alguém quem estava fechando.
  */
  it('duas pessoas no mesmo canal são duas, e a sessão continua sendo uma', () => {
    const { g, vozId, alice, bob } = voiceWorld();
    const r = rig();
    const aliceHex = alice.publicKey.toString('hex');
    const bobHex = bob.publicKey.toString('hex');

    r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: aliceHex });
    r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: bobHex });

    assert.equal(r.sessions.sessionCount, 1);
    assert.equal(r.sessions.participantCount(), 2);
  });

  it('quem pergunta não se conta — host sozinho no canal lê zero', () => {
    const { g, vozId, alice } = voiceWorld();
    const r = rig();
    const aliceHex = alice.publicKey.toString('hex');

    r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: aliceHex });

    assert.equal(r.sessions.sessionCount, 1);
    assert.equal(r.sessions.participantCount(aliceHex), 0);
  });

  it('duas sessões com gente diferente somam; a mesma pessoa nas duas conta uma vez', () => {
    const { g, vozId, alice, bob } = voiceWorld();
    const outraVoz = addVoiceChannel(g, 'voz-2', T0 + 60);
    const r = rig();
    const aliceHex = alice.publicKey.toString('hex');
    const bobHex = bob.publicKey.toString('hex');

    assert.equal(r.sessions.join({ state: g.world.state, channelId: vozId, memberKeyHex: aliceHex }).ok, true);
    assert.equal(r.sessions.join({ state: g.world.state, channelId: outraVoz, memberKeyHex: bobHex }).ok, true);

    assert.equal(r.sessions.sessionCount, 2);
    assert.equal(r.sessions.participantCount(), 2);
    // "Voz é uma só" (§17.4): entrar na segunda tira da primeira, e o total não sobe.
    assert.equal(r.sessions.join({ state: g.world.state, channelId: outraVoz, memberKeyHex: aliceHex }).ok, true);
    assert.equal(r.sessions.participantCount(), 2);
  });
});
