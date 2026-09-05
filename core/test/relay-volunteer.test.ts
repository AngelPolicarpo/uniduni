// Testes do relay voluntário — consentimento persistido, chave derivada da identidade,
// prova de posse (R-19), TTL renovável e cota do TURN restrito (§17.7, A21).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { relayPossessionSigningHash, verifySignature } from '../src/l1/opCodec/index.ts';
import { RELAY_TTL_MS } from '../src/l1/fold/constants.ts';
import {
  RelayVolunteer,
  deriveRelayKeyPair,
  relayPossessionHash,
  signPossession,
  type RelayConsentPort,
  type RelayOpSubmission,
  type RelayStateChanged,
  type RelaySubmitPort,
} from '../src/l2/relay/index.ts';
import { keypairFromSeed } from './helpers/world.ts';

const IDENTITY = keypairFromSeed('voluntario-relay');

function fakeClock(): { now(): number; advance(ms: number): void } {
  let t = 1_800_000_000_000;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

function memoryConsent(initial?: Record<string, { decision: 'accepted' | 'declined'; at: number }>): RelayConsentPort & {
  store: Map<string, { decision: 'accepted' | 'declined'; at: number }>;
} {
  const store = new Map(Object.entries(initial ?? {}));
  return {
    store,
    get(communityId) {
      return store.get(communityId) ?? null;
    },
    set(communityId, decision) {
      store.set(communityId, { decision, at: 0 });
    },
    forget(communityId) {
      store.delete(communityId);
    },
  };
}

function captureSubmit(): RelaySubmitPort & { submissions: RelayOpSubmission[] } {
  const submissions: RelayOpSubmission[] = [];
  return {
    submissions,
    async submit(submission) {
      submissions.push(submission);
      return submissions.length;
    },
  };
}

interface Rig {
  clock: ReturnType<typeof fakeClock>;
  consent: ReturnType<typeof memoryConsent>;
  submit: ReturnType<typeof captureSubmit>;
  volunteer: RelayVolunteer;
  stateChanges: RelayStateChanged[];
}

function rig(
  overrides: { ttlMs?: number; maxBytesPerDay?: number; maxAllocs?: number } = {},
  consentInitial?: Record<string, { decision: 'accepted' | 'declined'; at: number }>,
): Rig {
  const clock = fakeClock();
  const consent = memoryConsent(consentInitial);
  const submit = captureSubmit();
  const stateChanges: RelayStateChanged[] = [];
  const volunteer = new RelayVolunteer({
    identitySeed: Buffer.from(IDENTITY.secretKey.subarray(0, 32)),
    identitySecretKey: IDENTITY.secretKey,
    consent,
    submit,
    clock,
    ttlMs: overrides.ttlMs ?? RELAY_TTL_MS,
    maxBytesPerDay: overrides.maxBytesPerDay ?? 5 * 1024 * 1024 * 1024,
    maxAllocs: overrides.maxAllocs ?? 4,
    onStateChanged: (e) => stateChanges.push(e),
  });
  return { clock, consent, submit, volunteer, stateChanges };
}

function hexDe(label: string): string {
  return keypairFromSeed(label).publicKey.toString('hex');
}

// ─── Chave derivada e prova de posse (A21, R-19) ────────────────────────────────────────

describe('chave de relay derivada da identidade (§17.7)', () => {
  it('é determinística por (identidade, comunidade) e muda com qualquer um dos dois', async () => {
    const seed = Buffer.alloc(32, 9);
    const a1 = deriveRelayKeyPair(seed, 'comunidade-a');
    const a2 = deriveRelayKeyPair(seed, 'comunidade-a');
    const b = deriveRelayKeyPair(seed, 'comunidade-b');
    const outro = deriveRelayKeyPair(Buffer.alloc(32, 10), 'comunidade-a');
    assert.ok(a1.publicKey.equals(a2.publicKey));
    assert.ok(!a1.publicKey.equals(b.publicKey));
    assert.ok(!a1.publicKey.equals(outro.publicKey));
  });

  it('a prova de posse verifica com a MESMA hash que o fold verifica em R-19', async () => {
    const keys = deriveRelayKeyPair(Buffer.alloc(32, 3), 'com');
    const possession = signPossession(IDENTITY.secretKey, keys.publicKey);

    // hash local ≡ hash do opCodec (é este que o fold verifica)
    assert.deepEqual(relayPossessionHash(keys.publicKey), relayPossessionSigningHash(keys.publicKey));
    // verificação exatamente como em apply.ts R-19
    assert.equal(verifySignature(possession, relayPossessionSigningHash(keys.publicKey), IDENTITY.publicKey), true);
    // adulterada não verifica
    possession[0] = (possession[0] ?? 0) ^ 0xff;
    assert.equal(verifySignature(possession, relayPossessionSigningHash(keys.publicKey), IDENTITY.publicKey), false);
  });

  it('seed com tamanho errado é recusado', async () => {
    assert.throws(() => deriveRelayKeyPair(Buffer.alloc(16), 'com'));
  });
});

// ─── Consentimento persistido antes de ligar ────────────────────────────────────────────

describe('consentimento — sem ele, E_CONSENT_REQUIRED', () => {
  it('enable sem consentimento recusa, pede consentimento (missing) e não submete op', async () => {
    const r = rig();
    const pedidos: string[] = [];
    void pedidos;
    const out = await r.volunteer.enable({ communityId: 'com' });
    assert.deepEqual(out, { ok: false, code: 'E_CONSENT_REQUIRED' });
    assert.equal(r.submit.submissions.length, 0);
  });

  it('consentimento recusado também recusa; aceito e lembrado libera', async () => {
    const r = rig();
    r.consent.set('com', 'declined', { remember: true });
    assert.deepEqual(await r.volunteer.enable({ communityId: 'com' }), { ok: false, code: 'E_CONSENT_REQUIRED' });
    r.clock.advance(1000);
    r.consent.set('com', 'accepted', { remember: true });
    assert.equal((await r.volunteer.enable({ communityId: 'com' })).ok, true);
  });

  it('esquecer o consentimento volta a exigi-lo (`relay.respondConsent{remember:false}`)', async () => {
    const r = rig();
    r.consent.set('com', 'accepted', { remember: true });
    assert.equal((await r.volunteer.enable({ communityId: 'com' })).ok, true);
    r.consent.forget('com');
    assert.deepEqual(await r.volunteer.enable({ communityId: 'com' }), { ok: false, code: 'E_CONSENT_REQUIRED' });
  });

  it('consentimento persistido sobrevive ao reinício do objeto (novo processo)', async () => {
    const r = rig({}, { com: { decision: 'accepted', at: 5 } });
    const ok = await r.volunteer.enable({ communityId: 'com' });
    assert.equal(ok.ok, true);
    assert.equal(r.submit.submissions.length, 1);
  });
});

// ─── Ciclo de vida: enable / renew / disable / sweep ────────────────────────────────────

describe('ciclo de vida do voluntariado', () => {
  it('enable submete relay.volunteer com chave/expiração/posse corretos e devolve seq', async () => {
    const r = rig();
    r.consent.set('com', 'accepted', { remember: true });
    const ok = await r.volunteer.enable({ communityId: 'com' });
    assert.equal(ok.ok, true);
    if (!ok.ok) return;
    assert.equal(ok.seq, 1);
    assert.equal(ok.expiresAt, r.clock.now() + RELAY_TTL_MS);
    const submission = r.submit.submissions[0]!;
    assert.equal(submission.kind, 'relay.volunteer');
    if (submission.kind !== 'relay.volunteer') return;
    assert.ok(submission.relayPublicKey.equals(ok.relayPublicKey));
    assert.equal(submission.expiresAt, ok.expiresAt);
    assert.equal(verifySignature(submission.possession, relayPossessionSigningHash(submission.relayPublicKey), IDENTITY.publicKey), true);
    assert.deepEqual(r.stateChanges.at(-1), { communityId: 'com', enabled: true, expiresAt: ok.expiresAt, bytesRelayed: 0 });
  });

  it('cada comunidade tem chave própria e estado independente', async () => {
    const r = rig();
    r.consent.set('a', 'accepted', { remember: true });
    r.consent.set('b', 'accepted', { remember: true });
    const a = await r.volunteer.enable({ communityId: 'a' });
    const b = await r.volunteer.enable({ communityId: 'b' });
    assert.equal(a.ok && b.ok, true);
    if (!a.ok || !b.ok) return;
    assert.ok(!a.relayPublicKey.equals(b.relayPublicKey));
    await r.volunteer.disable({ communityId: 'b' });
    assert.notEqual(r.volunteer.status('a'), null);
    assert.equal(r.volunteer.status('b'), null);
  });

  it('renew devolve material fresco (nova expiração) sob o mesmo consentimento', async () => {
    const r = rig();
    r.consent.set('com', 'accepted', { remember: true });
    const primeiro = await r.volunteer.enable({ communityId: 'com' });
    assert.equal(primeiro.ok, true);
    r.clock.advance(60_000);
    const renovado = await r.volunteer.renew({ communityId: 'com' });
    assert.equal(renovado.ok, true);
    if (!renovado.ok || !primeiro.ok) return;
    assert.ok(renovado.expiresAt > primeiro.expiresAt);
    assert.equal(r.submit.submissions.length, 2);
    assert.equal(r.submit.submissions[1]!.kind, 'relay.volunteer');
  });

  it('disable submete relay.withdraw; sem voluntariado é no-op nomeado', async () => {
    const r = rig();
    r.consent.set('com', 'accepted', { remember: true });
    assert.deepEqual(await r.volunteer.disable({ communityId: 'com' }), { ok: true, seq: null });
    await r.volunteer.enable({ communityId: 'com' });
    const off = await r.volunteer.disable({ communityId: 'com' });
    if (!off.ok || off.seq === null) throw new Error('deveria ter submetido withdraw');
    assert.equal(r.submit.submissions.at(-1)!.kind, 'relay.withdraw');
    assert.equal(r.volunteer.status('com'), null);
    assert.deepEqual(r.stateChanges.at(-1), { communityId: 'com', enabled: false, expiresAt: null, bytesRelayed: 0 });
  });

  it('expirou → não listado: sweep marca, emite stateChanged e o TURN recusa (not-active)', async () => {
    const r = rig({ ttlMs: 1000 });
    r.consent.set('com', 'accepted', { remember: true });
    await r.volunteer.enable({ communityId: 'com' });
    r.stateChanges.length = 0;
    r.clock.advance(1001);
    assert.deepEqual(r.volunteer.sweep(), ['com']);
    assert.equal(r.volunteer.status('com')?.status, 'expired');
    assert.deepEqual(r.volunteer.tryAllocate('com', hexDe('par')), { ok: false, reason: 'not-active' });
    assert.equal(r.stateChanges.filter((e) => !e.enabled).length, 1);
    // sweep repetido não reemite
    assert.deepEqual(r.volunteer.sweep(), []);
  });
});

// ─── Cota do TURN restrito ──────────────────────────────────────────────────────────────

describe('cota do TURN restrito (RELAY_MAX_ALLOCS / RELAY_MAX_BYTES_PER_DAY)', () => {
  it('alocações além do teto são recusadas; liberar reabre', async () => {
    const r = rig({ maxAllocs: 2 });
    r.consent.set('com', 'accepted', { remember: true });
    await r.volunteer.enable({ communityId: 'com' });
    assert.equal(r.volunteer.tryAllocate('com', hexDe('p1')).ok, true);
    assert.equal(r.volunteer.tryAllocate('com', hexDe('p2')).ok, true);
    assert.deepEqual(r.volunteer.tryAllocate('com', hexDe('p3')), { ok: false, reason: 'alloc-limit' });
    r.volunteer.releaseAllocation('com', hexDe('p1'));
    assert.equal(r.volunteer.tryAllocate('com', hexDe('p3')).ok, true);
  });

  it('bytes na cota suspendem o voluntário e emitem relay.stateChanged uma vez', async () => {
    const r = rig({ maxBytesPerDay: 1000 });
    r.consent.set('com', 'accepted', { remember: true });
    await r.volunteer.enable({ communityId: 'com' });
    r.stateChanges.length = 0;
    r.volunteer.recordRelayBytes('com', 600);
    r.volunteer.recordRelayBytes('com', 400); // atinge a cota → suspende
    assert.equal(r.volunteer.status('com')?.status, 'suspended');
    assert.deepEqual(r.volunteer.tryAllocate('com', hexDe('px')), { ok: false, reason: 'bytes-quota' });
    // a suspensão emite stateChanged com os bytes acumulados; `enabled` segue true
    // porque o voluntariado no log continua — quem para de aceitar é o TURN restrito
    assert.equal(r.stateChanges.length, 1);
    assert.equal((r.stateChanges[0]?.bytesRelayed ?? 0) >= 1000, true);
    assert.equal(r.stateChanges[0]?.enabled, true);
  });

  it('virada da janela de 24 h limpa a suspensão e o voluntário volta a aceitar', async () => {
    const r = rig({ maxBytesPerDay: 500 });
    r.consent.set('com', 'accepted', { remember: true });
    await r.volunteer.enable({ communityId: 'com' });
    r.volunteer.recordRelayBytes('com', 500);
    const recusado = r.volunteer.tryAllocate('com', hexDe('py'));
    assert.equal(recusado.ok, false);
    if (!recusado.ok) assert.equal(recusado.reason, 'bytes-quota');
    r.clock.advance(24 * 60 * 60 * 1000 + 1);
    assert.deepEqual(r.volunteer.tryAllocate('com', hexDe('py')), { ok: true });
    assert.equal(r.volunteer.status('com')?.status, 'active');
    assert.equal(r.volunteer.status('com')?.bytesInWindow, 0);
  });
});

// ─── Precedência de suspensão e status coerente (correções de 2026-09-05) ───────────────

describe('cota: o teto de VOLUME tem precedência sobre a recusa por alocação (§17.7)', () => {
  it('estourar bytes com alloc-limit de pé não é apagado pela liberação de uma alocação', async () => {
    const r = rig({ maxAllocs: 1, maxBytesPerDay: 1000 });
    r.consent.set('com', 'accepted', { remember: true });
    await r.volunteer.enable({ communityId: 'com' });

    assert.equal(r.volunteer.tryAllocate('com', hexDe('p1')).ok, true);
    assert.deepEqual(r.volunteer.tryAllocate('com', hexDe('p2')), { ok: false, reason: 'alloc-limit' });

    // O par admitido segue transferindo e estoura o teto diário ENQUANTO a marca de
    // alloc-limit ocupa o campo. Antes, a violação de volume nem chegava a ser registrada.
    r.volunteer.recordRelayBytes('com', 1200);
    assert.equal(r.volunteer.status('com')?.suspendedReason, 'bytes-quota');

    // Terminada a alocação, o campo era limpo e o nó voltava a admitir acima do teto.
    r.volunteer.releaseAllocation('com', hexDe('p1'));
    assert.deepEqual(r.volunteer.tryAllocate('com', hexDe('p2')), { ok: false, reason: 'bytes-quota' });
    assert.equal(r.volunteer.status('com')?.status, 'suspended');
  });
});

describe('status do voluntário não mente sobre estar suspenso (§17.7)', () => {
  it('liberar a alocação que suspendeu cura o status e emite `relay.stateChanged`', async () => {
    const r = rig({ maxAllocs: 1 });
    r.consent.set('com', 'accepted', { remember: true });
    await r.volunteer.enable({ communityId: 'com' });
    r.volunteer.tryAllocate('com', hexDe('p1'));
    r.volunteer.tryAllocate('com', hexDe('p2')); // recusado: marca alloc-limit
    assert.equal(r.volunteer.status('com')?.status, 'suspended');

    r.stateChanges.length = 0;
    r.volunteer.releaseAllocation('com', hexDe('p1'));
    // A UI mostrava "suspenso" para um voluntário que já servia: `releaseAllocation`
    // limpava a marca na cota e nunca tocava `runtime.status`, nem emitia.
    assert.equal(r.volunteer.status('com')?.status, 'active');
    assert.equal(r.stateChanges.length, 1);
    assert.equal(r.stateChanges[0]?.enabled, true);
  });

  it('a virada da janela deixa o instantâneo coerente consigo mesmo', async () => {
    const r = rig({ maxBytesPerDay: 500 });
    r.consent.set('com', 'accepted', { remember: true });
    await r.volunteer.enable({ communityId: 'com' });
    r.volunteer.recordRelayBytes('com', 500);
    assert.equal(r.volunteer.status('com')?.status, 'suspended');

    r.clock.advance(24 * 60 * 60 * 1000 + 1);
    const s = r.volunteer.status('com')!;
    // `status` e `suspendedReason` saíam do mesmo objeto contando histórias diferentes:
    // ler os bytes rolava a janela e limpava a marca, e `runtime.status` ficava para trás.
    assert.equal(s.status, 'active');
    assert.equal(s.suspendedReason, null);
    assert.equal(s.bytesInWindow, 0);
  });
});
