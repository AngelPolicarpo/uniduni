// `relay` — voluntariado TURN (§17.7, A21, L-11/L-14).
//
// O voluntário serve **um TURN restrito**: encaminha DTLS-SRTP que não decifra; vê volume
// e temporização, nunca conteúdo (L-14 — texto de consentimento). Este módulo decide:
// consentimento persistido antes de ligar (`E_CONSENT_REQUIRED`), chave derivada da
// identidade, prova de posse verificada pelo fold (R-19), TTL renovável e cota. O socket
// TURN em si é o `MediaServer` da fase 7 sob estes controles, com a socket real entrando
// pela composição na integração.
//
// §4: dependências `swarm`/`config` — os valores de config (§27.2) e a semente de
// identidade (L0) chegam injetados; a submissão dos ops `relay.volunteer`/
// `relay.withdraw` (kinds 60/61, R-19) sai pela porta `RelaySubmitPort`, que a
// composição liga ao outbox/communityHost. O consentimento persistido
// (`local_relay_consent`, §6.15) entra pela porta `RelayConsentPort`.

import { deriveRelayKeyPair, signPossession } from './keys.ts';
import { RelayQuota, type QuotaRefusal } from './quota.ts';

type KeyHex = string;

// ─── Portas declaradas por este módulo ──────────────────────────────────────────────────

export type RelayConsentDecision = 'accepted' | 'declined';

export interface RelayConsentRecord {
  readonly decision: RelayConsentDecision;
  readonly at: number;
}

/** Persistência do consentimento (`local_relay_consent`, §6.15) — implementada por L0/view. */
export interface RelayConsentPort {
  get(communityId: string): RelayConsentRecord | null;
  set(communityId: string, decision: RelayConsentDecision, opts: { remember: boolean }): void;
  forget(communityId: string): void;
}

export type RelayOpSubmission =
  | {
      readonly kind: 'relay.volunteer';
      readonly communityId: string;
      /** Chave pública derivada (32 B) — a que o fold guarda em R-19. */
      readonly relayPublicKey: Buffer;
      /** `expiresAt ≤ hostTs + RELAY_TTL_MS` (R-19); aqui sempre `now + ttlMs`. */
      readonly expiresAt: number;
      /** Ed25519(identitySk, BLAKE2b('relay-possession/1' ‖ relayPublicKey)). */
      readonly possession: Buffer;
    }
  | { readonly kind: 'relay.withdraw'; readonly communityId: string };

/**
 * Submissão do op ao log da comunidade — ligada ao caminho de escrita pela composição.
 *
 * **Assíncrona (emenda de 2026-08-28).** `relay.volunteer` e `relay.withdraw` têm
 * `fila: false` em §7.4 e §15.4 declara `relay.enable ⏱`/`relay.disable ⏱`: são ops
 * SÍNCRONAS com o host, e o `seq` que a resposta promete é o que o host atribuiu. Uma porta
 * síncrona só podia devolver um número antes de o host existir na conversa — ou seja, um
 * palpite.
 */
export interface RelaySubmitPort {
  /** O seq atribuído pelo host (§16.2 `submitOp`); `-1` quando a submissão falhou. */
  submit(submission: RelayOpSubmission): Promise<number>;
}

// ─── Eventos (§RPC eventos, §17.7) ──────────────────────────────────────────────────────

export interface RelayConsentRequested {
  readonly communityId: string;
  /** `missing`: nunca perguntado · `declined`: recusado antes — a UI pergunta de novo. */
  readonly reason: 'missing' | 'declined';
}

export interface RelayStateChanged {
  readonly communityId: string;
  readonly enabled: boolean;
  readonly expiresAt: number | null;
  readonly bytesRelayed: number;
}

// ─── Estado e classe ────────────────────────────────────────────────────────────────────

type VolunteerStatus = 'active' | 'expired' | 'suspended';

interface Runtime {
  readonly publicKey: Buffer;
  readonly secretKey: Buffer;
  expiresAt: number;
  status: VolunteerStatus;
  quota: RelayQuota;
  lastSeq: number;
}

export type EnableOk = {
  readonly ok: true;
  readonly relayPublicKey: Buffer;
  readonly seq: number;
  readonly expiresAt: number;
};

/**
 * Voluntariado de relay por comunidade. Uma instância serve todas as comunidades
 * participadas: cada uma tem chave derivada própria, cota própria e ciclo próprio.
 * Estado efêmero; a autoridade do log é o `DecisionState` (relays, R-19).
 */
export class RelayVolunteer {
  readonly #identitySeed: Buffer;
  readonly #identitySecretKey: Buffer;
  readonly #consent: RelayConsentPort;
  readonly #submit: RelaySubmitPort;
  readonly #clock: { now(): number };
  readonly #ttlMs: number;
  readonly #maxBytesPerDay: number;
  readonly #maxAllocs: number;
  readonly #onConsentRequested: (event: RelayConsentRequested) => void;
  readonly #onStateChanged: (event: RelayStateChanged) => void;
  readonly #runtimes = new Map<string, Runtime>(); // communityId → runtime

  constructor(opts: {
    identitySeed: Buffer;
    identitySecretKey: Buffer;
    consent: RelayConsentPort;
    submit: RelaySubmitPort;
    clock?: { now(): number };
    /** Composição injeta `RELAY_TTL_MS` (§27.1). */
    ttlMs: number;
    /** Composição injeta os defaults de §27.2 resolvidos na config L0. */
    maxBytesPerDay: number;
    maxAllocs: number;
    onConsentRequested?: (event: RelayConsentRequested) => void;
    onStateChanged?: (event: RelayStateChanged) => void;
  }) {
    this.#identitySeed = opts.identitySeed;
    this.#identitySecretKey = opts.identitySecretKey;
    this.#consent = opts.consent;
    this.#submit = opts.submit;
    this.#clock = opts.clock ?? { now: () => Date.now() };
    this.#ttlMs = opts.ttlMs;
    this.#maxBytesPerDay = opts.maxBytesPerDay;
    this.#maxAllocs = opts.maxAllocs;
    this.#onConsentRequested =
      opts.onConsentRequested ??
      (() => {});
    this.#onStateChanged = opts.onStateChanged ?? (() => {});
  }

  /** Consentimento aceito e persistido é pré-condição de ligar (§17.7). */
  async enable(args: { communityId: string }): Promise<EnableOk | { ok: false; code: 'E_CONSENT_REQUIRED' }> {
    const now = this.#clock.now();
    const record = this.#consent.get(args.communityId);
    if (record === undefined || record === null || record.decision !== 'accepted') {
      this.#onConsentRequested({ communityId: args.communityId, reason: record === null || record === undefined ? 'missing' : 'declined' });
      return { ok: false, code: 'E_CONSENT_REQUIRED' };
    }

    const keys = deriveRelayKeyPair(this.#identitySeed, args.communityId);
    const expiresAt = now + this.#ttlMs;
    const possession = signPossession(this.#identitySecretKey, keys.publicKey);
    const seq = await this.#submit.submit({
      kind: 'relay.volunteer',
      communityId: args.communityId,
      relayPublicKey: keys.publicKey,
      expiresAt,
      possession,
    });

    const previous = this.#runtimes.get(args.communityId);
    const quota = previous?.quota ?? new RelayQuota({ maxBytesPerDay: this.#maxBytesPerDay, maxAllocs: this.#maxAllocs });
    // renovar limpa suspensão por bytes? Não: a cota é do recurso local, independe do TTL.
    this.#runtimes.set(args.communityId, {
      publicKey: keys.publicKey,
      secretKey: keys.secretKey,
      expiresAt,
      status: quota.suspended === null ? 'active' : 'suspended',
      quota,
      lastSeq: seq,
    });
    this.#emitState(args.communityId);
    return { ok: true, relayPublicKey: keys.publicKey, seq, expiresAt };
  }

  /**
   * `relay.disable`: submete `relay.withdraw` (kind 61) e para de servir. Sem
   * voluntariado ativo é no-op nomeado — o RPC não cataloga erro para disable.
   */
  async disable(args: { communityId: string }): Promise<{ ok: true; seq: number | null }> {
    const runtime = this.#runtimes.get(args.communityId);
    if (runtime === undefined) return { ok: true, seq: null };
    const seq = await this.#submit.submit({ kind: 'relay.withdraw', communityId: args.communityId });
    this.#runtimes.delete(args.communityId);
    this.#emitState(args.communityId);
    return { ok: true, seq };
  }

  /**
   * Renovação: mesmo caminho do `enable` (consentimento persistido continua válido),
   * com material fresco — novo `expiresAt` e nova posse. O fold sobrescreve a entrada.
   */
  renew(args: { communityId: string }): Promise<EnableOk | { ok: false; code: 'E_CONSENT_REQUIRED' }> {
    return this.enable(args);
  }

  /** Expirou → não listado (§17.7). Chamado pela composição em cadência. */
  sweep(now: number = this.#clock.now()): readonly string[] {
    const expired: string[] = [];
    for (const [communityId, runtime] of [...this.#runtimes]) {
      if (runtime.status !== 'expired' && now >= runtime.expiresAt) {
        runtime.status = 'expired';
        expired.push(communityId);
        this.#emitState(communityId);
      }
    }
    return expired;
  }

  // ─── Decisões do TURN restrito (a composição consulta ao servir) ────────────────────

  /** Admissão de um par no TURN do voluntário. */
  tryAllocate(communityId: string, peerKeyHex: KeyHex, now: number = this.#clock.now()): { ok: true } | { ok: false; reason: QuotaRefusal | 'not-active' } {
    const runtime = this.#runtimes.get(communityId);
    if (runtime === undefined || runtime.status === 'expired') return { ok: false, reason: 'not-active' };
    const decision = runtime.quota.tryAllocate(peerKeyHex, now);
    this.#reconciliar(communityId, runtime);
    return decision;
  }

  releaseAllocation(communityId: string, peerKeyHex: KeyHex): void {
    const runtime = this.#runtimes.get(communityId);
    if (runtime === undefined) return;
    runtime.quota.release(peerKeyHex);
    this.#reconciliar(communityId, runtime);
  }

  /** Bytes retransmitidos no turno do voluntário; pode suspender (emite stateChanged). */
  recordRelayBytes(communityId: string, bytes: number, now: number = this.#clock.now()): void {
    const runtime = this.#runtimes.get(communityId);
    if (runtime === undefined || runtime.status === 'expired') return;
    runtime.quota.recordBytes(bytes, now);
    this.#reconciliar(communityId, runtime);
  }

  /**
   * `runtime.status` derivado de `quota.suspended`, emitindo só na transição (emenda de
   * 2026-09-05).
   *
   * Três pontos mudavam a suspensão e só um emitia. A cura silenciosa no `tryAllocate` não
   * avisava ninguém; `releaseAllocation` limpava a marca da cota e nem tocava
   * `runtime.status`; a rolagem da janela de 24 h limpava a marca de dentro do `status()`,
   * que continuava devolvendo `'suspended'`. A UI mostrava "suspenso" para um voluntário
   * que já servia — e o contrário também: `suspendedReason` vinha `null` no mesmo objeto em
   * que `status` dizia `suspended`. Agora a derivação é uma só e mora aqui.
   */
  #reconciliar(communityId: string, runtime: Runtime): void {
    if (runtime.status === 'expired') return;
    const alvo: VolunteerStatus = runtime.quota.suspended === null ? 'active' : 'suspended';
    if (runtime.status === alvo) return;
    runtime.status = alvo;
    this.#emitState(communityId);
  }

  /** Snapshot para query/UI — `null` quando a comunidade não voluntaria. */
  status(communityId: string, now: number = this.#clock.now()):
    | {
        readonly status: VolunteerStatus;
        readonly relayPublicKeyHex: string;
        readonly expiresAt: number;
        readonly bytesInWindow: number;
        readonly activeAllocs: number;
        readonly suspendedReason: QuotaRefusal | null;
      }
    | null {
    const runtime = this.#runtimes.get(communityId);
    if (runtime === undefined) return null;
    // A janela pode ter rolado desde a última chamada: ler os bytes é o que a faz rolar, e
    // o status tem de sair já reconciliado — senão o instantâneo contradiz a si mesmo.
    const bytesInWindow = runtime.quota.bytesInWindow(now);
    this.#reconciliar(communityId, runtime);
    return {
      status: runtime.status,
      relayPublicKeyHex: runtime.publicKey.toString('hex'),
      expiresAt: runtime.expiresAt,
      bytesInWindow,
      activeAllocs: runtime.quota.activeAllocs,
      suspendedReason: runtime.quota.suspended,
    };
  }

  #emitState(communityId: string): void {
    const runtime = this.#runtimes.get(communityId);
    this.#onStateChanged({
      communityId,
      enabled: runtime !== undefined && runtime.status !== 'expired',
      expiresAt: runtime?.expiresAt ?? null,
      bytesRelayed: runtime?.quota.bytesInWindow(this.#clock.now()) ?? 0,
    });
  }
}
