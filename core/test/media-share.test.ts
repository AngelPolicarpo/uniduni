// Testes da camada de decisão da sessão de tela — captureToken e teto de espectadores
// (§17.4/T-41, §17.5, A19/A22). Estado estrutural entra por fixtures mínimas da porta
// `VoiceStatePort` e, no caso de gênese real, pelo `DecisionState` do world.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MEDIA_TICKET_TTL_MS } from '../src/l1/fold/constants.ts';
import {
  ShareHostSessions,
  degradeOnLoss,
  isShareQuality,
  SHARE_LOSS_DEGRADE_PCT,
  SHARE_QUALITY_PROFILES,
  type ShareRevokedTarget,
  type ShareSessionEvent,
} from '../src/l2/shareStar/index.ts';
import { verifyMediaTicket } from '../src/l2/voiceCoordinator/index.ts';
import { genesis, keypairFromSeed, makeRecord, T0 } from './helpers/world.ts';

const HOST = keypairFromSeed('host-share');

function fakeClock(): { now(): number; advance(ms: number): void } {
  let t = T0 + 900_000;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

interface Rig {
  clock: ReturnType<typeof fakeClock>;
  shares: ShareHostSessions;
  revoked: ShareRevokedTarget[];
  calls: Map<string, Set<string>>;
}

/** Porta de chamadas de voz efêmeras: `calls.get(channelId)` é o roster da chamada. */
function rig(calls: Map<string, Set<string>>): Rig {
  const clock = fakeClock();
  const revoked: ShareRevokedTarget[] = [];
  let n = 0;
  let t = 0;
  const shares = new ShareHostSessions({
    hostSecretKey: HOST.secretKey,
    clock,
    ttlMs: MEDIA_TICKET_TTL_MS,
    captureTokenTtlMs: 60_000,
    isVoiceChannelType: (type) => type === 1,
    voiceParticipants: (channelId) => calls.get(channelId) ?? null,
    sessionIdFactory: () => `share-${++n}`,
    ticketIdFactory: () => `tick-${++t}`,
    onRevoked: (targets) => revoked.push(...targets),
  });
  return { clock, shares, revoked, calls };
}

function hex(label: string): string {
  return keypairFromSeed(label).publicKey.toString('hex');
}

const PRESENTER = hex('apresentador');
const VIEWER = hex('espectador');

/** Estado mínimo com cargo `voz+share` para quem precisa só da porta. */
function baseState(permissions: number[] = [9, 11]): {
  community: { exists: boolean; endedAt?: number };
  channels: Map<string, { type: number; deletedAt?: number; speechMode: number }>;
  members: Map<string, { state: 'active' | 'left' | 'banned'; timeoutUntil?: number; roleIds: string[] }>;
  roles: Map<string, { permissions: number[] }>;
} {
  const members = new Map<string, { state: 'active' | 'left' | 'banned'; timeoutUntil?: number; roleIds: string[] }>();
  members.set(PRESENTER, { state: 'active', roleIds: ['r-1'] });
  members.set(VIEWER, { state: 'active', roleIds: ['r-1'] });
  members.set(hex('estranho'), { state: 'active', roleIds: [] });
  return {
    community: { exists: true },
    channels: new Map([['ch-voz', { type: 1, speechMode: 0 }], ['ch-texto', { type: 0, speechMode: 0 }]]),
    members,
    roles: new Map([['r-1', { permissions }]]),
  };
}

function callOf(channelId: string, ...labels: string[]): void {
  callsGlobal.set(channelId, new Set(labels.map((l) => hex(l))));
}
let callsGlobal = new Map<string, Set<string>>();

function freshRig(channel = 'ch-voz', ...labels: string[]): Rig {
  callsGlobal = new Map();
  callOf(channel, ...labels);
  return rig(callsGlobal);
}

function codeOf(result: { ok: true } | { ok: false; code: string }): 'ok' | string {
  return result.ok ? 'ok' : result.code;
}

// ─── Perfis e saúde ─────────────────────────────────────────────────────────────────────

describe('perfis e degradação por perda (§17.5)', () => {
  it('perfis do contrato são high/balanced/low em 2500/1200/600 kbps', () => {
    assert.deepEqual(SHARE_QUALITY_PROFILES, { high: 2500, balanced: 1200, low: 600 });
    assert.ok(isShareQuality('balanced'));
    assert.ok(!isShareQuality('ultra'));
  });

  it('degrada um perfil quando a perda excede 3% e nunca sobe sozinha', () => {
    assert.equal(SHARE_LOSS_DEGRADE_PCT, 3);
    assert.equal(degradeOnLoss('high', 3), null); // na borda não faz nada
    assert.equal(degradeOnLoss('high', 3.01), 'balanced');
    assert.equal(degradeOnLoss('balanced', 12), 'low');
    assert.equal(degradeOnLoss('low', 40), null); // já está no piso
    assert.equal(degradeOnLoss('high', Number.NaN), null);
  });
});

// ─── share.start — autorização ──────────────────────────────────────────────────────────

describe('share.start — autorização de §17.4 passo 1 com voice_share_screen', () => {
  it('apresentador elegível com permissão inicia sessão e recebe captureToken verificável', () => {
    const r = freshRig('ch-voz', 'apresentador', 'espectador');
    const started = r.shares.start({
      state: baseState([9, 11]),
      channelId: 'ch-voz',
      presenterKeyHex: PRESENTER,
    });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assert.equal(started.sessionId, 'share-1');
    assert.equal(started.captureToken.expiresAt, r.clock.now() + 60_000);
    assert.match(started.captureToken.token, /^[0-9a-f]{64}$/);

    // capture.authorize aprova o par (sessionId, token) emitido
    assert.deepEqual(r.shares.authorizeCapture({ sessionId: started.sessionId, token: started.captureToken.token }), {
      allowed: true,
    });
  });

  it('matriz de recusa estrutural: comunidade, canal, membro e permissão', () => {
    const r = freshRig('ch-voz', 'apresentador');
    const ok = baseState([9, 11]);
    assert.equal(codeOf(r.shares.start({ state: { ...ok, community: { exists: false } }, channelId: 'ch-voz', presenterKeyHex: PRESENTER })), 'E_NOT_FOUND');
    assert.equal(codeOf(r.shares.start({ state: { ...ok, community: { exists: true, endedAt: T0 } }, channelId: 'ch-voz', presenterKeyHex: PRESENTER })), 'E_COMMUNITY_ENDED');
    assert.equal(codeOf(r.shares.start({ state: ok, channelId: 'ch-fantasma', presenterKeyHex: PRESENTER })), 'E_CHANNEL_NOT_FOUND');
    assert.equal(codeOf(r.shares.start({ state: ok, channelId: 'ch-texto', presenterKeyHex: PRESENTER })), 'E_CHANNEL_NOT_VOICE');
    assert.equal(codeOf(r.shares.start({ state: ok, channelId: 'ch-voz', presenterKeyHex: hex('fantasma') })), 'E_NOT_MEMBER');
    assert.equal(
      codeOf(
        r.shares.start({
          state: (() => {
            const s = baseState([9, 11]);
            s.members.set(PRESENTER, { state: 'banned', roleIds: ['r-1'] });
            return s;
          })(),
          channelId: 'ch-voz',
          presenterKeyHex: PRESENTER,
        }),
      ),
      'E_BANNED',
    );
    assert.equal(
      codeOf(
        r.shares.start({
          state: (() => {
            const s = baseState([9, 11]);
            s.members.set(PRESENTER, { state: 'active', roleIds: ['r-1'], timeoutUntil: r.clock.now() + 1000 });
            return s;
          })(),
          channelId: 'ch-voz',
          presenterKeyHex: PRESENTER,
        }),
      ),
      'E_TIMED_OUT',
    );
    // sem `voice_share_screen` no cargo → recusa mesmo elegível
    assert.equal(codeOf(r.shares.start({ state: baseState([9]), channelId: 'ch-voz', presenterKeyHex: PRESENTER })), 'E_PERMISSION_DENIED');
  });

  it('apresentador fora da chamada de voz não abre sessão (A19: audiência é a chamada)', () => {
    const r = freshRig('ch-voz', 'espectador'); // apresentador não entrou na chamada
    assert.equal(
      codeOf(r.shares.start({ state: baseState([9, 11]), channelId: 'ch-voz', presenterKeyHex: PRESENTER })),
      'E_SESSION_GONE',
    );
  });

  // §17.5, emenda de 2026-08-26 — o teto que sobrou é POR APRESENTADOR, e não por canal.
  // Não é regra de protocolo: a captura de tela de uma instalação é uma só, e a segunda
  // sessão da mesma pessoa nasceria sem stream para alimentá-la.
  it('o mesmo apresentador não abre duas no mesmo canal; depois do stop, abre outra', () => {
    const r = freshRig('ch-voz', 'apresentador');
    const state = baseState([9, 11]);
    assert.equal(codeOf(r.shares.start({ state, channelId: 'ch-voz', presenterKeyHex: PRESENTER })), 'ok');
    assert.equal(codeOf(r.shares.start({ state, channelId: 'ch-voz', presenterKeyHex: PRESENTER })), 'E_ALREADY_SHARING');
    const first = r.shares.sessionsOf('ch-voz')[0]!;
    assert.equal(codeOf(r.shares.stop({ sessionId: first.sessionId, memberKeyHex: PRESENTER })), 'ok');
    assert.equal(codeOf(r.shares.start({ state, channelId: 'ch-voz', presenterKeyHex: PRESENTER })), 'ok');
    assert.notEqual(r.shares.sessionsOf('ch-voz')[0]!.sessionId, first.sessionId);
  });

  // O que a emenda de 2026-08-26 abriu: duas pessoas apresentando no MESMO canal.
  it('duas pessoas apresentam no mesmo canal, cada uma com a própria sessão', () => {
    const r = freshRig('ch-voz', 'apresentador', 'espectador');
    const state = baseState([9, 11]);
    const a = r.shares.start({ state, channelId: 'ch-voz', presenterKeyHex: PRESENTER });
    const b = r.shares.start({ state, channelId: 'ch-voz', presenterKeyHex: VIEWER });
    assert.ok(a.ok && b.ok);
    if (!a.ok || !b.ok) return;
    assert.notEqual(a.sessionId, b.sessionId);
    assert.equal(r.shares.sessionCount, 2);

    // As duas são independentes: audiência, perfil e encerramento não se misturam.
    const vivas = r.shares.sessionsOf('ch-voz');
    assert.deepEqual(vivas.map((s) => s.presenterKeyHex), [PRESENTER, VIEWER], 'ordem = quem começou primeiro');
    assert.equal(codeOf(r.shares.setQuality({ sessionId: a.sessionId, memberKeyHex: PRESENTER, quality: 'low' })), 'ok');
    assert.equal(r.shares.snapshotOf(b.sessionId)!.quality, 'balanced', 'o perfil de uma não alcança a outra');

    // Parar a de um não encerra a do outro, e cada `captureToken` vale só na sua.
    assert.equal(codeOf(r.shares.stop({ sessionId: a.sessionId, memberKeyHex: PRESENTER })), 'ok');
    assert.equal(r.shares.sessionCount, 1);
    assert.equal(r.shares.snapshotOf(b.sessionId)!.sessionId, b.sessionId);
    assert.equal(r.shares.authorizeCapture({ sessionId: b.sessionId, token: a.captureToken.token }).allowed, false);
  });

  it('quem assiste uma pode apresentar a outra ao mesmo tempo', () => {
    const r = freshRig('ch-voz', 'apresentador', 'espectador');
    const state = baseState([9, 11]);
    const a = r.shares.start({ state, channelId: 'ch-voz', presenterKeyHex: PRESENTER });
    assert.ok(a.ok);
    if (!a.ok) return;
    assert.equal(codeOf(r.shares.join({ sessionId: a.sessionId, memberKeyHex: VIEWER })), 'ok');
    // Assistir a de outro não é impedimento para transmitir a sua.
    assert.equal(codeOf(r.shares.start({ state, channelId: 'ch-voz', presenterKeyHex: VIEWER })), 'ok');
    assert.equal(r.shares.sessionCount, 2);
  });

  it('com gênese real (fundador tem todas as permissões) a decisão usa o DecisionState real', () => {
    const g = genesis();
    // canal de voz real no log (mesmo padrão de voice-host.test.ts)
    const seq = g.world.next(g.founder);
    g.world.push(
      makeRecord(g.world.core, {
        kind: 'channel.create',
        author: g.founder,
        authorSeq: seq,
        hostTs: T0 + 50,
        payload: { categoryId: g.categoryId, type: 1, name: 'voz', readOnlyForRoleIds: [] },
      }),
    );
    const vozId = g.world.id('channel', g.founder, seq);
    const calls = new Map([[vozId, new Set([g.founder.publicKey.toString('hex')])]]);
    const clock = fakeClock();
    const shares = new ShareHostSessions({
      hostSecretKey: HOST.secretKey,
      clock,
      ttlMs: MEDIA_TICKET_TTL_MS,
      captureTokenTtlMs: 60_000,
      isVoiceChannelType: (type) => type === 1,
      voiceParticipants: (id) => calls.get(id) ?? null,
    });
    const started = shares.start({
      state: g.world.state,
      channelId: vozId,
      presenterKeyHex: g.founder.publicKey.toString('hex'),
    });
    assert.equal(started.ok, true);
    assert.equal(shares.sessionCount, 1);
  });
});

// ─── captureToken — captura nunca inicia sem autorização (T-41) ────────────────────────

describe('captureToken — ordem obrigatória share.start → token → captura (T-41)', () => {
  function rigComSessao(): { r: Rig; sessionId: string; token: string } {
    const r = freshRig('ch-voz', 'apresentador');
    const started = r.shares.start({ state: baseState([9, 11]), channelId: 'ch-voz', presenterKeyHex: PRESENTER });
    assert.ok(started.ok);
    if (!started.ok) throw new Error('unreachable');
    return { r, sessionId: started.sessionId, token: started.captureToken.token };
  }

  it('antes de qualquer share.start não há captura possível', () => {
    const r = freshRig('ch-voz');
    assert.deepEqual(r.shares.authorizeCapture({ sessionId: 'qualquer', token: 'ab'.repeat(32) }), {
      allowed: false,
      reason: 'gone',
    });
  });

  it('token forjado, de outra sessão ou adulterado é recusado', () => {
    const a = rigComSessao();
    assert.deepEqual(a.r.shares.authorizeCapture({ sessionId: a.sessionId, token: 'cd'.repeat(32) }), {
      allowed: false,
      reason: 'mismatch',
    });
    // token válido de A não vale em outra sessão
    const b = rigComSessao();
    assert.deepEqual(b.r.shares.authorizeCapture({ sessionId: b.sessionId, token: a.token }), {
      allowed: false,
      reason: 'mismatch',
    });
  });

  it('token expirado é recusado mesmo com sessão viva', () => {
    const a = rigComSessao();
    a.r.clock.advance(60_001);
    assert.deepEqual(a.r.shares.authorizeCapture({ sessionId: a.sessionId, token: a.token }), {
      allowed: false,
      reason: 'expired',
    });
  });

  it('sessão encerrada revoga a captura: handler consulta e leva gone', () => {
    const a = rigComSessao();
    assert.equal(a.r.shares.stop({ sessionId: a.sessionId, memberKeyHex: PRESENTER }).ok, true);
    assert.deepEqual(a.r.shares.authorizeCapture({ sessionId: a.sessionId, token: a.token }), {
      allowed: false,
      reason: 'gone',
    });
  });
});

// ─── share.join — espectadores e teto ───────────────────────────────────────────────────

describe('share.join — participante da chamada, teto de 8 e ticket do par', () => {
  function sessao(quantosNaChamada: string[]): { r: Rig; sessionId: string } {
    const labels = ['apresentador', ...quantosNaChamada];
    const r = freshRig('ch-voz', ...labels);
    const started = r.shares.start({ state: baseState([9, 11]), channelId: 'ch-voz', presenterKeyHex: PRESENTER });
    assert.ok(started.ok);
    if (!started.ok) throw new Error('unreachable');
    return { r, sessionId: started.sessionId };
  }

  it('espectador na chamada entra e recebe ticket que verifica nas duas pontas (A22)', () => {
    const { r, sessionId } = sessao(['espectador']);
    const joined = r.shares.join({ sessionId, memberKeyHex: VIEWER });
    assert.equal(joined.ok, true);
    if (!joined.ok) return;
    assert.equal(joined.presenterKeyHex, PRESENTER);
    assert.equal(joined.ticketId, 'tick-1');
    const espectador = keypairFromSeed('espectador').publicKey;
    const apresentador = keypairFromSeed('apresentador').publicKey;
    // lado espectador
    assert.deepEqual(
      verifyMediaTicket(HOST.publicKey, joined.ticket, {
        sessionId,
        channelId: 'ch-voz',
        localPeer: espectador,
        remotePeer: apresentador,
      }, r.clock.now()),
      { ok: true },
    );
    // lado apresentador (ordem canônica do par)
    assert.deepEqual(
      verifyMediaTicket(HOST.publicKey, joined.ticket, {
        sessionId,
        channelId: 'ch-voz',
        localPeer: apresentador,
        remotePeer: espectador,
      }, r.clock.now()),
      { ok: true },
    );
  });

  it('quem não participa da chamada não tem audiência: E_PERMISSION_DENIED', () => {
    const { r, sessionId } = sessao([]);
    assert.equal(codeOf(r.shares.join({ sessionId, memberKeyHex: hex('de-fora') })), 'E_PERMISSION_DENIED');
    assert.equal(codeOf(r.shares.join({ sessionId, memberKeyHex: hex('estranho') })), 'E_PERMISSION_DENIED');
  });

  it('sessão inexistente é E_SESSION_GONE', () => {
    const r = freshRig('ch-voz', 'espectador');
    assert.equal(codeOf(r.shares.join({ sessionId: 'nada', memberKeyHex: VIEWER })), 'E_SESSION_GONE');
  });

  it('apresentador tentando dar join na própria tela é recusado com E_ALREADY_SHARING', () => {
    const { r, sessionId } = sessao(['espectador']);
    assert.equal(codeOf(r.shares.join({ sessionId, memberKeyHex: PRESENTER })), 'E_ALREADY_SHARING');
  });

  // §90 — não há mais vaga a disputar. O que limita a estrela é o upload de quem
  // apresenta, e disso cuida a degradação medida de §17.5; contar cabeças não media nada.
  // Vinte é arbitrário de propósito: prova que não existe número mágico entre 8 e 9.
  it('não há teto de espectadores: o 9º e o 20º entram como o 1º (§90)', () => {
    const labels = Array.from({ length: 20 }, (_, i) => `v${i}`);
    const { r, sessionId } = sessao(labels);
    for (let i = 0; i < 20; i++) {
      assert.equal(codeOf(r.shares.join({ sessionId, memberKeyHex: hex(`v${i}`) })), 'ok', `espectador ${i}`);
    }
    assert.equal(r.shares.snapshotOf(sessionId)!.viewers.length, 20);

    // A única condição de entrada que sobrou continua de pé: audiência é a chamada (F-18).
    assert.equal(codeOf(r.shares.join({ sessionId, memberKeyHex: hex('de-fora') })), 'E_PERMISSION_DENIED');
  });

  it('join idempotente do mesmo espectador devolve material fresco sem consumir vaga extra', () => {
    const { r, sessionId } = sessao(['espectador']);
    assert.equal(codeOf(r.shares.join({ sessionId, memberKeyHex: VIEWER })), 'ok');
    const again = r.shares.join({ sessionId, memberKeyHex: VIEWER });
    assert.equal(again.ok, true);
    if (!again.ok) return;
    assert.match(again.ticketId, /^tick-\d+$/);
    assert.equal(r.shares.snapshotOf(sessionId)!.viewers.length, 1);
  });
});

// ─── setQuality / stop / leave ──────────────────────────────────────────────────────────

describe('share.setQuality e encerramentos (§RPC)', () => {
  function sessao(): { r: Rig; sessionId: string } {
    const r = freshRig('ch-voz', 'apresentador', 'espectador');
    const started = r.shares.start({ state: baseState([9, 11]), channelId: 'ch-voz', presenterKeyHex: PRESENTER, quality: 'high' });
    assert.ok(started.ok);
    if (!started.ok) throw new Error('unreachable');
    assert.equal(codeOf(r.shares.join({ sessionId: started.sessionId, memberKeyHex: VIEWER })), 'ok');
    return { r, sessionId: started.sessionId };
  }

  // §17.5, emenda de 2026-08-26 — o papel do comando é APRESENTADOR. O perfil é o teto de
  // banda com que a tela sai, e quem paga por ele é o upload de quem transmite; dar o
  // comando a quem assiste punha a conta no bolso alheio.
  it('apresentador redefine a base da sessão e realinha todos os espectadores', () => {
    const { r, sessionId } = sessao();
    assert.deepEqual(r.shares.setQuality({ sessionId, memberKeyHex: PRESENTER, quality: 'low' }), {
      ok: true,
      applied: true,
      quality: 'low',
    });
    assert.equal(r.shares.viewerQuality(sessionId, VIEWER), 'low', 'o perfil novo é teto, não ajuste de um');
    assert.equal(r.shares.snapshotOf(sessionId)!.quality, 'low', 'quem entrar depois nasce na base nova');
  });

  it('espectador não manda no upload de quem transmite: E_PERMISSION_DENIED', () => {
    const { r, sessionId } = sessao();
    // A sessão deste rig nasce em `high`; um espectador pedindo `low` é recusado sem efeito.
    assert.equal(codeOf(r.shares.setQuality({ sessionId, memberKeyHex: VIEWER, quality: 'low' })), 'E_PERMISSION_DENIED');
    assert.equal(r.shares.viewerQuality(sessionId, VIEWER), 'high', 'a recusa não pode ter efeito colateral');
  });

  // O que a mudança de papel NÃO tira: a degradação por perda continua do sistema, continua
  // por espectador e continua descendo sozinha — é ela que protege quem assiste.
  it('a degradação automática continua por espectador, a partir da base nova', () => {
    const { r, sessionId } = sessao();
    assert.deepEqual(r.shares.degradeTo({ sessionId, memberKeyHex: VIEWER, quality: 'balanced' }), {
      ok: true,
      applied: true,
      quality: 'balanced',
    });
    assert.equal(r.shares.viewerQuality(sessionId, VIEWER), 'balanced');
    assert.equal(r.shares.snapshotOf(sessionId)!.quality, 'high', 'degradar um espectador não mexe na base');
  });

  it('sessão encerrada → E_SESSION_GONE no setQuality', () => {
    const { r, sessionId } = sessao();
    assert.equal(codeOf(r.shares.stop({ sessionId, memberKeyHex: PRESENTER })), 'ok');
    assert.equal(codeOf(r.shares.setQuality({ sessionId, memberKeyHex: PRESENTER, quality: 'low' })), 'E_SESSION_GONE');
  });

  it('stop é do apresentador: espectador tentando é E_PERMISSION_DENIED', () => {
    const { r, sessionId } = sessao();
    assert.equal(codeOf(r.shares.stop({ sessionId, memberKeyHex: VIEWER })), 'E_PERMISSION_DENIED');
  });

  it('stop encerra e emite uma revogação por espectador; leave do apresentador idem', () => {
    const r2 = freshRig('ch-voz', 'apresentador', 'espectador');
    const s = r2.shares.start({ state: baseState([9, 11]), channelId: 'ch-voz', presenterKeyHex: PRESENTER });
    assert.ok(s.ok);
    if (!s.ok) return;
    assert.equal(codeOf(r2.shares.join({ sessionId: s.sessionId, memberKeyHex: VIEWER })), 'ok');
    r2.revoked.length = 0;
    assert.equal(codeOf(r2.shares.leave({ sessionId: s.sessionId, memberKeyHex: PRESENTER })), 'ok');
    assert.equal(r2.shares.sessionCount, 0);
    assert.deepEqual(r2.revoked, [{ sessionId: s.sessionId, channelId: 'ch-voz', targetKeyHex: VIEWER }]);
  });

  it('leave do espectador revoga só ele e libera vaga', () => {
    const { r, sessionId } = sessao();
    r.revoked.length = 0;
    assert.equal(codeOf(r.shares.leave({ sessionId, memberKeyHex: VIEWER })), 'ok');
    assert.deepEqual(r.revoked, [{ sessionId, channelId: 'ch-voz', targetKeyHex: VIEWER }]);
    assert.equal(r.shares.snapshotOf(sessionId)!.viewers.length, 0);
  });
});

// ─── sweepAgainst — ban alcança a sessão de tela (T-32) ─────────────────────────────────

describe('sweepAgainst — ban/kick/canal deletado encerram a sessão de tela', () => {
  function sessao(): { r: Rig; sessionId: string } {
    const r = freshRig('ch-voz', 'apresentador', 'espectador');
    const started = r.shares.start({ state: baseState([9, 11]), channelId: 'ch-voz', presenterKeyHex: PRESENTER });
    assert.ok(started.ok);
    if (!started.ok) return undefined!;
    assert.equal(codeOf(r.shares.join({ sessionId: started.sessionId, memberKeyHex: VIEWER })), 'ok');
    return { r, sessionId: started.sessionId };
  }

  it('ban do apresentador encerra a sessão e revoga todos os espectadores', () => {
    const { r, sessionId } = sessao();
    const state = (() => {
      const s = baseState([9, 11]);
      s.members.set(PRESENTER, { state: 'banned', roleIds: ['r-1'] });
      return s;
    })();
    r.revoked.length = 0;
    const emitted = r.shares.sweepAgainst(state);
    assert.equal(r.shares.sessionCount, 0);
    assert.deepEqual(emitted, [{ sessionId, channelId: 'ch-voz', targetKeyHex: VIEWER }]);
    assert.deepEqual(r.revoked, [{ sessionId, channelId: 'ch-voz', targetKeyHex: VIEWER }]);
  });

  it('ban de um espectador revoga só ele; sessão continua', () => {
    const { r, sessionId } = sessao();
    const state = (() => {
      const s = baseState([9, 11]);
      s.members.set(VIEWER, { state: 'banned', roleIds: ['r-1'] });
      return s;
    })();
    r.revoked.length = 0;
    const emitted = r.shares.sweepAgainst(state);
    assert.equal(r.shares.sessionCount, 1);
    assert.deepEqual(emitted, [{ sessionId, channelId: 'ch-voz', targetKeyHex: VIEWER }]);
    assert.equal(r.shares.snapshotOf(sessionId)!.viewers.length, 0);
  });

  it('canal deletado encerra a sessão inteira; comunidade ended idem', () => {
    const { r, sessionId } = sessao();
    let state = (() => {
      const s = baseState([9, 11]);
      s.channels.set('ch-voz', { type: 1, speechMode: 0, deletedAt: r.clock.now() });
      return s;
    })();
    r.shares.sweepAgainst(state);
    assert.equal(r.shares.sessionCount, 0);

    const r2 = sessao();
    state = { ...baseState([9, 11]), community: { exists: true, endedAt: r2.r.clock.now() } };
    r2.r.shares.sweepAgainst(state);
    assert.equal(r2.r.shares.sessionCount, 0);
  });

  it('estado limpo não deriva revogação nenhuma', () => {
    const { r } = sessao();
    r.revoked.length = 0;
    assert.deepEqual(r.shares.sweepAgainst(baseState([9, 11])), []);
    assert.equal(r.revoked.length, 0);
  });

  // §17.5/A19, emenda de 2026-08-26 — a audiência é a chamada, e isso vale CONTINUAMENTE,
  // não só no `start`/`join`. Antes desta volta o apresentador podia sair da chamada
  // (`voiceLeave`, ou queda de conexão) e a sessão de tela ficava viva para sempre no host,
  // trancando o canal com `E_ALREADY_SHARING`.
  it('apresentador que sai da chamada encerra a sessão de tela', () => {
    const { r, sessionId } = sessao();
    r.revoked.length = 0;
    // A chamada continua existindo; quem saiu foi o apresentador.
    callOf('ch-voz', 'espectador');
    const emitted = r.shares.sweepAgainst(baseState([9, 11]));
    assert.equal(r.shares.sessionCount, 0);
    assert.deepEqual(emitted, [{ sessionId, channelId: 'ch-voz', targetKeyHex: VIEWER }]);
  });

  it('espectador que sai da chamada deixa de ser audiência; a sessão continua', () => {
    const { r, sessionId } = sessao();
    r.revoked.length = 0;
    callOf('ch-voz', 'apresentador');
    const emitted = r.shares.sweepAgainst(baseState([9, 11]));
    assert.equal(r.shares.sessionCount, 1);
    assert.deepEqual(emitted, [{ sessionId, channelId: 'ch-voz', targetKeyHex: VIEWER }]);
    assert.equal(r.shares.snapshotOf(sessionId)!.viewers.length, 0);
  });

  it('B36 — a revogação do espectador tem alvo nomeado, que é o que `share.failed` carrega', () => {
    const { r, sessionId } = sessao();
    r.revoked.length = 0;
    const state = (() => {
      const st = baseState([9, 11]);
      st.members.set(VIEWER, { state: 'banned', roleIds: ['r-1'] });
      return st;
    })();
    r.shares.sweepAgainst(state);
    // O callback existia desde a fase 8 e a composição nunca o ligava: quem perdia a
    // autorização de assistir não recebia sinal nenhum. `share.stopped` é da sessão inteira
    // e `share.viewersChanged` leva só a contagem — nenhum diz "acabou para VOCÊ".
    assert.deepEqual(r.revoked, [{ sessionId, channelId: 'ch-voz', targetKeyHex: VIEWER }]);
    assert.equal(r.shares.sessionCount, 1, 'revogar UM espectador não encerra a sessão');
  });

  it('chamada inteira desfeita encerra a tela junto', () => {
    const { r } = sessao();
    // Sem sessão de voz no canal a porta devolve `null` — não existe tela fora da chamada.
    callsGlobal.delete('ch-voz');
    r.shares.sweepAgainst(baseState([9, 11]));
    assert.equal(r.shares.sessionCount, 0);
  });

  it('perda de voice_share_screen do apresentador encerra a sessão no sweep', () => {
    const { r, sessionId } = sessao();
    r.revoked.length = 0;
    // Estado onde o apresentador perdeu a permissão 11 (voice_share_screen)
    const state = baseState([9]); // apenas voice_speak, sem voice_share_screen
    const emitted = r.shares.sweepAgainst(state);
    assert.equal(r.shares.sessionCount, 0);
    assert.deepEqual(emitted, [{ sessionId, channelId: 'ch-voz', targetKeyHex: VIEWER }]);
  });
});

// ─── Entidades efêmeras de §6.16 — ShareSession e eventos share.* ──────────────────────

describe('eventos de sessão (share.started / share.viewersChanged / share.stopped)', () => {
  /** Rig mínimo com captura de eventos de sessão. */
  function rigComEventos(): { shares: ShareHostSessions; eventos: ShareSessionEvent[]; presenterKeyHex: string } {
    const calls = new Map([['ch-voz', new Set([PRESENTER, VIEWER, hex('ev2')])]]);
    const clock = fakeClock();
    const eventos: ShareSessionEvent[] = [];
    const shares = new ShareHostSessions({
      hostSecretKey: HOST.secretKey,
      clock,
      ttlMs: MEDIA_TICKET_TTL_MS,
      captureTokenTtlMs: 60_000,
      isVoiceChannelType: (type) => type === 1,
      voiceParticipants: (channelId) => calls.get(channelId) ?? null,
      onSessionEvent: (e) => eventos.push(e),
    });
    return { shares, eventos, presenterKeyHex: PRESENTER };
  }

  it('start emite started; join/leave emitem viewersChanged com contagem corrente', () => {
    const { shares, eventos, presenterKeyHex } = rigComEventos();
    const s = shares.start({ state: baseState([9, 11]), channelId: 'ch-voz', presenterKeyHex });
    assert.ok(s.ok);
    if (!s.ok) return;
    assert.deepEqual(eventos, [{ kind: 'started', sessionId: s.sessionId, channelId: 'ch-voz', presenterKeyHex }]);

    assert.equal(shares.join({ sessionId: s.sessionId, memberKeyHex: VIEWER }).ok, true);
    assert.equal(shares.join({ sessionId: s.sessionId, memberKeyHex: hex('ev2') }).ok, true);
    // join idempotente não emite de novo
    assert.equal(shares.join({ sessionId: s.sessionId, memberKeyHex: VIEWER }).ok, true);
    // §16.3 — canal e apresentador viajam nos TRÊS ramos: é o que permite à composição
    // endereçar o evento aos participantes daquela chamada em vez da comunidade inteira.
    assert.deepEqual(eventos.slice(1), [
      { kind: 'viewersChanged', sessionId: s.sessionId, channelId: 'ch-voz', presenterKeyHex, viewerCount: 1 },
      { kind: 'viewersChanged', sessionId: s.sessionId, channelId: 'ch-voz', presenterKeyHex, viewerCount: 2 },
    ]);

    assert.equal(shares.leave({ sessionId: s.sessionId, memberKeyHex: VIEWER }).ok, true);
    assert.deepEqual(eventos.at(-1), { kind: 'viewersChanged', sessionId: s.sessionId, channelId: 'ch-voz', presenterKeyHex, viewerCount: 1 });
  });

  it('snapshot carrega a entidade ShareSession de §6.16 (topologia star + viewerCount)', () => {
    const { shares, presenterKeyHex } = rigComEventos();
    const s = shares.start({ state: baseState([9, 11]), channelId: 'ch-voz', presenterKeyHex });
    assert.ok(s.ok);
    if (!s.ok) return;
    assert.equal(shares.join({ sessionId: s.sessionId, memberKeyHex: VIEWER }).ok, true);
    const snap = shares.snapshotOf(s.sessionId)!;
    assert.equal(snap.topology, 'star');
    assert.equal(snap.viewerCount, 1);
    assert.equal(snap.presenterKeyHex, presenterKeyHex);
    assert.equal(snap.channelId, 'ch-voz');
  });

  it('stop e encerramento por sweep emitem stopped exatamente uma vez', () => {
    const { shares, eventos, presenterKeyHex } = rigComEventos();
    const s = shares.start({ state: baseState([9, 11]), channelId: 'ch-voz', presenterKeyHex });
    assert.ok(s.ok);
    if (!s.ok) return;
    assert.equal(shares.join({ sessionId: s.sessionId, memberKeyHex: VIEWER }).ok, true);

    assert.equal(shares.stop({ sessionId: s.sessionId, memberKeyHex: presenterKeyHex }).ok, true);
    assert.deepEqual(eventos.filter((e) => e.kind === 'stopped'), [{ kind: 'stopped', sessionId: s.sessionId, channelId: 'ch-voz', presenterKeyHex }]);

    eventos.length = 0;
    const s2 = shares.start({ state: baseState([9, 11]), channelId: 'ch-voz', presenterKeyHex });
    assert.ok(s2.ok);
    if (!s2.ok) return;
    const banido = (() => {
      const st = baseState([9, 11]);
      st.members.set(presenterKeyHex, { state: 'banned', roleIds: ['r-1'] });
      shares.sweepAgainst(st);
      return true;
    })();
    assert.ok(banido);
    assert.deepEqual(eventos.filter((e) => e.kind === 'stopped'), [{ kind: 'stopped', sessionId: s2.sessionId, channelId: 'ch-voz', presenterKeyHex }]);
  });
});
