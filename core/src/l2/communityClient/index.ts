// `communityClient` — L2. Replicação, autorização de canal e estados visíveis de §14.
//
// §4: depende de `swarm` (L0), `corestore` (L0), `projector` (L1→L0) e `outbox` (L2 porta rpcClient).
// Não appenda no core (só `communityHost` faz), não decide domínio — apenas replica,
// interpreta e publica o estado de rede que a UI consome — e envia ops: a ponte de
// submissão assinada de §19.3 mora em `./submit.ts`, sobre as portas injetadas de lá.
// §14.2: usa o escalonador do `swarm` para multicomunidade.
// §14.3: autorização de canal de replicação por comunidade.
// §14.5: `synced`/`catching-up`/`stalled`/`blocked`/`unauthorized`/`forked` + watchdog.
// §6.15: não-lidas são LS em `manifest.db`; o cálculo é puro e o `projector` é o escritor
// de `view.db` — a atualização incremental vive no `CommunityClient` após cada lote (§10.5).

import type { Swarm } from '../../l0/swarm/index.ts';
import type { CoreHandle } from '../../l0/corestore/index.ts';
import type { Projector } from '../../l1/projector/index.ts';
import type { Outbox } from '../outbox/index.ts';
import {
  IDENTITY_UPDATE_KIND,
  MEMBER_LEAVE_KIND,
  MESSAGE_QUEUEABLE_KINDS,
  prepareSubmission,
  type HostSubmitPort,
  type SignedOpCodecPort,
  type SigningKeyPair,
  type SubmissionBinding,
  type SubmissionInput,
  type SubmissionLimits,
  type QueuedSubmissionResult,
  type SyncSubmissionResult,
  type WriteStatePort,
} from './submit.ts';

export {
  CHANNEL_SCOPED,
  IDENTITY_UPDATE_KIND,
  MEMBER_LEAVE_KIND,
  MESSAGE_QUEUEABLE_KINDS,
  advisoryCheck,
  opScopeKey,
  prepareSubmission,
  resolveScope,
  type AdvisoryViolation,
  type HostSubmitPort,
  type OpScope,
  type QueuedSubmissionResult,
  type SignedOpCodecPort,
  type SigningKeyPair,
  type SubmissionBinding,
  type SubmissionInput,
  type SubmissionLimits,
  type SyncSubmissionResult,
  type WriteStatePort,
} from './submit.ts';

/** Caminho A de §11.1: os seis kinds de mensagem mais as exceções declaradas. */
const QUEUEABLE_NO_CAMINHO_A: ReadonlySet<string> = new Set([...MESSAGE_QUEUEABLE_KINDS, MEMBER_LEAVE_KIND, IDENTITY_UPDATE_KIND]);

export type ReplicationState = 'synced' | 'catching-up' | 'stalled' | 'blocked' | 'unauthorized' | 'forked';

/**
 * §14.5 (emenda de 2026-09-05) — os motivos que acompanham `stalled` e `blocked`:
 * - `no-provider`: sem avanço e sem contato com o host na janela de `hello`;
 * - `no-progress`: o host responde e os blocos não chegam mesmo assim;
 * - `host-offline`: réplica em dia (`lag == 0`) cujo host parou de responder;
 * - `gap`: `blocked`.
 */
export type ReplicationReason = 'no-provider' | 'no-progress' | 'host-offline' | 'gap';

export type ReplicationInfo = {
  readonly state: ReplicationState;
  readonly lag: number;
  readonly etaMs?: number;
  readonly reason?: ReplicationReason;
};

export type WatchdogEvent =
  | { readonly topic: 'community.replication'; readonly data: { readonly communityId: string; readonly state: ReplicationState; readonly lag: number; readonly reason?: ReplicationReason; readonly etaMs?: number } }
  | { readonly topic: 'community.accessRevoked'; readonly data: { readonly communityId: string; readonly cause: 'banned' | 'kicked' | 'unauthorized' } }
  | { readonly topic: 'community.forked'; readonly data: { readonly communityId: string } };

export type CommunityClientOptions = {
  readonly swarm: Swarm;
  readonly clock?: { now(): number };
  readonly helloIntervalMs?: number;
  readonly replicationStallMs?: number;
  readonly replicationWatchMs?: number;
  readonly onEvent?: (ev: WatchdogEvent) => void;
  /** Assinatura/código da ponte de submissão — ausente ⇒ comunidade somente leitura. */
  readonly signing?: SubmissionSigning;
};

export type CommunityHandle = {
  readonly communityId: string;
  readonly core: CoreHandle;
  readonly projector: Projector;
  isHosted?: boolean;
  /** Fila durável desta comunidade (§11.2) — presente quando a instalação escreve nela. */
  outbox?: Outbox;
  /** Porta `submitOp` do host (§16.2) — presente quando há conexão de escrita ao host. */
  hostSubmit?: HostSubmitPort;
};

/**
 * Material de assinatura e codec da ponte de submissão (§19.3). Chega injetado: §4 não
 * declara `opCodec`, `idgen` nem `identity` nas dependências deste módulo, e os tetos de
 * §8.6/R-14 são constantes de protocolo — nada aqui importa fora da tabela nem inventa valor.
 */
export type SubmissionSigning = {
  readonly authorKey: SigningKeyPair;
  readonly codec: SignedOpCodecPort;
  /** Versão do protocolo que este binário escreve por inteiro (§7.2 regra 3). */
  readonly opVersion: number;
  readonly limits: SubmissionLimits;
};

/** §27.2 — `P2P_HELLO_INTERVAL_MS`: cadência do `hello` que alimenta `synced` (§14.5, §22.1). */
export const DEFAULT_HELLO_MS = 30_000;
/** §27.2 — `P2P_REPLICATION_WATCH_MS`: cadência do watchdog de §14.5 (§22.1). */
export const DEFAULT_WATCH_MS = 5_000;
const DEFAULT_STALL_MS = 20_000;

/**
 * §14.5: determina o estado de replicação a partir de métricas observáveis.
 *
 * - `synced`: interpretedSeq === core.length-1 && host respondeu no último HELLO_INTERVAL
 *   — em comunidade HOSPEDADA não há `hello` a esperar: o par host é este nó, e o loop de
 *   §22.1 nem envia o frame para si mesmo. A tabela de §14.5 é escrita do lado do membro e
 *   não tem linha para o host; sem esta distinção, `lag <= 0` caía no `catching-up` de
 *   fallback e a comunidade que a pessoa hospeda ficava eternamente "sincronizando"
 * - `catching-up`: lag>0 e avançando
 * - `stalled`: lag>0 e sem avanço por REPLICATION_STALL_MS
 * - `blocked`: core anuncia comprimento maior que o disponível em qualquer par (gap)
 * - `unauthorized`: todos os pares recusaram o canal (§14.3)
 * - `forked`: bloco conflitante detectado (§5.5 L-4)
 */
export function computeReplicationState(args: {
  readonly coreLength: number;
  readonly interpretedSeq: number;
  /** Este nó hospeda a comunidade? Então `hello` não se aplica (§14.5, §22.1). */
  readonly isHosted?: boolean;
  readonly now: number;
  readonly lastProgressAt: number | null;
  readonly lastHelloAt: number | null;
  readonly helloIntervalMs: number;
  readonly stallMs: number;
  readonly unauthorized: boolean;
  readonly forked: boolean;
  readonly blocked: boolean;
}): ReplicationState {
  if (args.forked) return 'forked';
  if (args.unauthorized) return 'unauthorized';
  if (args.blocked) return 'blocked';
  const lag = args.coreLength - (args.interpretedSeq + 1);
  if (lag <= 0) {
    if (args.isHosted === true) return 'synced';
    if (args.lastHelloAt === null) return 'catching-up'; // contato ainda não aconteceu
    // §14.5 (emenda de 2026-09-05): réplica em dia cujo host calou não está "baixando
    // dados" — `catching-up` de fallback era o estado errado e sem lag para exibir.
    return args.now - args.lastHelloAt <= args.helloIntervalMs ? 'synced' : 'stalled';
  }
  // lag > 0
  const stalled = args.lastProgressAt !== null && args.now - args.lastProgressAt >= args.stallMs;
  if (stalled) return 'stalled';
  return 'catching-up';
}

/**
 * §14.5 (emenda de 2026-09-05) — o motivo que acompanha `stalled`, sobre as MESMAS
 * entradas de `computeReplicationState`. Existe porque `no-provider` era o único motivo
 * possível e mentia nos dois casos em que há provedor: o host respondendo `hello` com os
 * blocos parados, e a réplica em dia cujo host calou.
 */
export function stalledReasonOf(args: {
  readonly coreLength: number;
  readonly interpretedSeq: number;
  readonly now: number;
  readonly lastHelloAt: number | null;
  readonly helloIntervalMs: number;
}): Extract<ReplicationReason, 'no-provider' | 'no-progress' | 'host-offline'> {
  const lag = args.coreLength - (args.interpretedSeq + 1);
  const helloOk = args.lastHelloAt !== null && args.now - args.lastHelloAt <= args.helloIntervalMs;
  if (lag <= 0) return 'host-offline';
  return helloOk ? 'no-progress' : 'no-provider';
}

export function lagOf(coreLength: number, interpretedSeq: number): number {
  return Math.max(0, coreLength - (interpretedSeq + 1));
}

type PerCommunity = {
  handle: CommunityHandle;
  lastProgressAt: number | null;
  lastInterpretedSeq: number;
  lastHelloAt: number | null;
  unauthorized: boolean;
  forked: boolean;
  blocked: boolean;
  state: ReplicationState;
};

export class CommunityClient {
  readonly #swarm: Swarm;
  readonly #clock: { now(): number };
  readonly #helloIntervalMs: number;
  readonly #stallMs: number;
  readonly #watchMs: number;
  readonly #onEvent: (ev: WatchdogEvent) => void;
  #signing: SubmissionSigning | undefined;
  readonly #communities = new Map<string, PerCommunity>();
  #watchTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: CommunityClientOptions) {
    this.#swarm = opts.swarm;
    this.#clock = opts.clock ?? { now: () => Date.now() };
    this.#helloIntervalMs = opts.helloIntervalMs ?? DEFAULT_HELLO_MS;
    this.#stallMs = opts.replicationStallMs ?? DEFAULT_STALL_MS;
    this.#watchMs = opts.replicationWatchMs ?? DEFAULT_WATCH_MS;
    this.#onEvent = opts.onEvent ?? (() => {});
    this.#signing = opts.signing;
  }

  /**
   * A identidade chegou DEPOIS do boot (`identity.import`, §5.5): a ponte de escrita liga
   * agora, com o par carregado. Nada mais muda — comunidades já abertas passam a poder
   * enfileirar; sem identidade continuam somente leitura.
   */
  setSigning(signing: SubmissionSigning): void {
    this.#signing = signing;
  }

  addCommunity(handle: CommunityHandle): void {
    const now = this.#clock.now();
    const lagState: ReplicationState = computeReplicationState({
      coreLength: handle.core.length,
      interpretedSeq: handle.projector.interpretedSeq,
      isHosted: handle.isHosted === true,
      now,
      lastProgressAt: now,
      lastHelloAt: null,
      helloIntervalMs: this.#helloIntervalMs,
      stallMs: this.#stallMs,
      unauthorized: false,
      forked: false,
      blocked: false,
    });
    this.#communities.set(handle.communityId, {
      handle,
      lastProgressAt: now,
      lastInterpretedSeq: handle.projector.interpretedSeq,
      lastHelloAt: null,
      unauthorized: false,
      forked: false,
      blocked: false,
      state: lagState,
    });
    // §14.1 — O transporte é o único dono do anúncio/descoberta no swarm via discoveryKey.
    // O cliente gerencia o estado de replicação e lag, sem duplicar joins no swarm com a chave crua.
  }

  removeCommunity(communityId: string): void {
    this.#communities.delete(communityId);
  }

  /** Chamado quando o host responde `hello` naquela comunidade (§14.5 synced). */
  markHello(communityId: string, at = this.#clock.now()): void {
    const entry = this.#communities.get(communityId);
    if (entry === undefined) return;
    entry.lastHelloAt = at;
    this.#recompute(communityId);
  }

  markUnauthorized(communityId: string, revoked: boolean): void {
    const entry = this.#communities.get(communityId);
    if (entry === undefined) return;
    entry.unauthorized = revoked;
    this.#recompute(communityId, revoked ? 'unauthorized' : undefined);
  }

  markForked(communityId: string): void {
    const entry = this.#communities.get(communityId);
    if (entry === undefined) return;
    entry.forked = true;
    this.#recompute(communityId, 'forked');
  }

  markBlocked(communityId: string, blocked: boolean): void {
    const entry = this.#communities.get(communityId);
    if (entry === undefined) return;
    entry.blocked = blocked;
    this.#recompute(communityId);
  }

  /** Deve ser chamado após cada lote do projector (avanço de interpretedSeq). */
  notifyProgress(communityId: string): void {
    const entry = this.#communities.get(communityId);
    if (entry === undefined) return;
    entry.lastProgressAt = this.#clock.now();
    entry.lastInterpretedSeq = entry.handle.projector.interpretedSeq;
    this.#recompute(communityId);
  }

  /** Motivo de `stalled` para esta comunidade, agora (§14.5). */
  #motivoDeStall(e: PerCommunity, now: number, interpretedSeq: number): ReplicationReason {
    return stalledReasonOf({
      coreLength: e.handle.core.length,
      interpretedSeq,
      now,
      lastHelloAt: e.lastHelloAt,
      helloIntervalMs: this.#helloIntervalMs,
    });
  }

  getState(communityId: string): ReplicationInfo | null {
    const e = this.#communities.get(communityId);
    if (e === undefined) return null;
    const interpretedSeq = e.handle.projector.interpretedSeq;
    const lag = lagOf(e.handle.core.length, interpretedSeq);
    const st: ReplicationInfo = { state: e.state, lag };
    if (e.state === 'stalled') return { ...st, reason: this.#motivoDeStall(e, this.#clock.now(), interpretedSeq) };
    if (e.state === 'blocked') return { ...st, reason: 'gap' as const };
    return st;
  }

  listStates(): Map<string, ReplicationInfo> {
    const out = new Map<string, ReplicationInfo>();
    for (const [cid] of this.#communities) {
      const s = this.getState(cid);
      if (s !== null) out.set(cid, s);
    }
    return out;
  }

  /** §14.5 watchdog: compara core.length vs interpretedSeq e publica transição. */
  watchdogTick(now = this.#clock.now()): WatchdogEvent[] {
    const events: WatchdogEvent[] = [];
    for (const [cid, entry] of this.#communities) {
      // detecta progresso silencioso
      const curSeq = entry.handle.projector.interpretedSeq;
      if (curSeq !== entry.lastInterpretedSeq) {
        entry.lastInterpretedSeq = curSeq;
        entry.lastProgressAt = now;
      }
      const prev = entry.state;
      const next = computeReplicationState({
        coreLength: entry.handle.core.length,
        interpretedSeq: curSeq,
        isHosted: entry.handle.isHosted === true,
        now,
        lastProgressAt: entry.lastProgressAt,
        lastHelloAt: entry.lastHelloAt,
        helloIntervalMs: this.#helloIntervalMs,
        stallMs: this.#stallMs,
        unauthorized: entry.unauthorized,
        forked: entry.forked,
        blocked: entry.blocked,
      });
      if (next !== prev) {
        entry.state = next;
        if (next === 'unauthorized') {
          const ev: WatchdogEvent = { topic: 'community.accessRevoked', data: { communityId: cid, cause: 'unauthorized' } };
          events.push(ev);
          this.#onEvent(ev);
        } else if (next === 'forked') {
          const ev: WatchdogEvent = { topic: 'community.forked', data: { communityId: cid } };
          events.push(ev);
          this.#onEvent(ev);
        } else {
          const lag = lagOf(entry.handle.core.length, curSeq);
          const reason: ReplicationReason | undefined =
            next === 'stalled' ? this.#motivoDeStall(entry, now, curSeq) : next === 'blocked' ? 'gap' : undefined;
          const data = reason === undefined ? { communityId: cid, state: next, lag } : { communityId: cid, state: next, lag, reason };
          const ev: WatchdogEvent = { topic: 'community.replication', data };
          events.push(ev);
          this.#onEvent(ev);
        }
      }
    }
    return events;
  }

  startWatchdog(): void {
    if (this.#watchTimer !== null) return;
    this.#watchTimer = setInterval(() => this.watchdogTick(), this.#watchMs);
    if ((this.#watchTimer as unknown as { unref?: () => void }).unref !== undefined) {
      (this.#watchTimer as unknown as { unref(): void }).unref();
    }
  }

  stopWatchdog(): void {
    if (this.#watchTimer !== null) {
      clearInterval(this.#watchTimer);
      this.#watchTimer = null;
    }
  }

  /** §14.2: delega ao swarm o cálculo de orçamento para as comunidades conhecidas. */
  allocationFor(swarmActiveId: string | null, hostedIds: ReadonlySet<string>): ReadonlyMap<string, number> {
    return this.#swarm.allocateForCommunities([...this.#communities.keys()], swarmActiveId, hostedIds);
  }

  // ── Ponte de submissão assinada de ops (§19.3, item 1 de §29.2) ─────────────────────

  /** Recorte estrutural do DS corrente — autorização de comando e leitura de estado. */
  writeStateFor(communityId: string): WriteStatePort | null {
    const entry = this.#communities.get(communityId);
    if (entry === undefined) return null;
    return entry.handle.projector.ds;
  }

  /**
   * Caminho A (§11.1) — op do domínio de mensagem: valida advisório, reserva `authorSeq`,
   * sela o envelope e enfileira na outbox durável. Resposta imediata `{opId, state:'queued'}`
   * ou erro síncrono da coluna de §15.4; o desfecho real chega por evento.
   */
  submitQueued(communityId: string, input: SubmissionInput): QueuedSubmissionResult {
    const entry = this.#communities.get(communityId);
    const outbox = entry?.handle.outbox;
    const signing = this.#signing;
    if (entry === undefined) return { ok: false, code: 'E_NOT_FOUND' };
    if (outbox === undefined || signing === undefined) {
      return { ok: false, code: 'E_INTERNAL' }; // composição: comunidade de escrita sem fila é bug
    }
    const prepared = prepareSubmission({
      binding: { outbox },
      signing,
      communityKey: entry.handle.core.key,
      state: entry.handle.projector.ds,
      now: () => this.#clock.now(),
      queueableKinds: QUEUEABLE_NO_CAMINHO_A,
      input,
      sync: false,
    });
    if (!prepared.ok) return prepared;
    const result = outbox.enqueue(
      prepared.envelope,
      {
        opId: prepared.opId,
        channelId: prepared.channelId,
        sequenceScope: prepared.scopeKey,
        kind: prepared.kindNumber,
        authorSeq: prepared.authorSeq,
        ...(input.clientRef !== undefined ? { clientRef: input.clientRef } : {}),
      },
    );
    if (!result.enqueued) return { ok: false, code: 'E_OUTBOX_FULL' };
    return { ok: true, opId: prepared.opId, state: 'queued' };
  }

  /**
   * Caminho ⏱ (§11.1) — op síncrona com o host: sela e submete por `submitOp` (§16.2)
   * direto pela porta existente, devolvendo `{seq}` ou `{code}`. Recusa antes do append
   * queima o `authorSeq` consumido (§7.5).
   */
  async submitSync(communityId: string, input: SubmissionInput): Promise<SyncSubmissionResult> {
    const entry = this.#communities.get(communityId);
    const outbox = entry?.handle.outbox;
    const hostSubmit = entry?.handle.hostSubmit;
    const signing = this.#signing;
    if (entry === undefined) return { ok: false, code: 'E_NOT_FOUND' };
    if (outbox === undefined || signing === undefined) return { ok: false, code: 'E_INTERNAL' };
    if (hostSubmit === undefined) return { ok: false, code: 'E_HOST_UNAVAILABLE' };
    const prepared = prepareSubmission({
      binding: { outbox },
      signing,
      communityKey: entry.handle.core.key,
      state: entry.handle.projector.ds,
      now: () => this.#clock.now(),
      queueableKinds: MESSAGE_QUEUEABLE_KINDS,
      input,
      sync: true,
    });
    if (!prepared.ok) return prepared;
    const submitted = await hostSubmit(prepared.envelope);
    if (submitted === null) return { ok: false, code: 'E_HOST_UNAVAILABLE' };
    if (!submitted.ok) return { ok: false, code: submitted.code };
    return { ok: true, seq: submitted.seq, authorSeq: prepared.authorSeq, opId: prepared.opId };
  }

  #recompute(communityId: string, forced?: ReplicationState): void {
    const e = this.#communities.get(communityId)!;
    const now = this.#clock.now();
    const computed = forced ?? computeReplicationState({
      coreLength: e.handle.core.length,
      interpretedSeq: e.handle.projector.interpretedSeq,
      isHosted: e.handle.isHosted === true,
      now,
      lastProgressAt: e.lastProgressAt,
      lastHelloAt: e.lastHelloAt,
      helloIntervalMs: this.#helloIntervalMs,
      stallMs: this.#stallMs,
      unauthorized: e.unauthorized,
      forked: e.forked,
      blocked: e.blocked,
    });
    if (computed === e.state) return;
    e.state = computed;
    const lag = lagOf(e.handle.core.length, e.handle.projector.interpretedSeq);
    if (computed === 'unauthorized') {
      this.#onEvent({ topic: 'community.accessRevoked', data: { communityId, cause: 'unauthorized' } });
    } else if (computed === 'forked') {
      this.#onEvent({ topic: 'community.forked', data: { communityId } });
    } else {
      const reason: ReplicationReason | undefined =
        computed === 'stalled'
          ? this.#motivoDeStall(e, now, e.handle.projector.interpretedSeq)
          : computed === 'blocked'
            ? 'gap'
            : undefined;
      const data = reason === undefined ? { communityId, state: computed, lag } : { communityId, state: computed, lag, reason };
      this.#onEvent({ topic: 'community.replication', data });
    }
  }

  close(): void {
    this.stopWatchdog();
    for (const cid of [...this.#communities.keys()]) this.removeCommunity(cid);
  }
}

// ── Não-lidas §6.15 ──────────────────────────────────────────────────────────────

/**
 * §6.15: `unreadCount` por canal = mensagens com `seq > lastReadSeq` cujo autor não é a
 * identidade local, não deletadas e não `hiddenByBan`; `pendingMentions` = subconjunto que
 * menciona a identidade, um cargo dela ou `everyone` efetivo — menção conta mesmo em canal
 * silenciado. `firstUnreadSeq` é o menor `seq` do conjunto.
 *
 * Função pura para o cálculo — o armazenamento em `manifest.local_read_state` e a
 * atualização incremental por lote (§10.5) são feitos pelo CommunityClient/projector;
 * o boot recomputa quando `last_read_seq > interpretedSeq` (§10.5 barreira).
 */
export function computeUnreadForChannel(args: {
  readonly lastReadSeq: number;
  readonly localKeyHex: string;
  readonly localRoleIds: ReadonlySet<string>;
  readonly messages: ReadonlyArray<{
    readonly seq: number;
    readonly authorKeyHex: string;
    readonly deleted: boolean;
    readonly hiddenByBan: boolean;
    readonly mentionEveryoneEffective: boolean;
    readonly mentions: readonly string[];
  }>;
}): { readonly unreadCount: number; readonly pendingMentions: number; readonly firstUnreadSeq: number | null } {
  let unreadCount = 0;
  let pendingMentions = 0;
  let firstUnreadSeq: number | null = null;
  for (const m of args.messages) {
    if (m.seq <= args.lastReadSeq) continue;
    if (m.deleted || m.hiddenByBan) continue;
    if (m.authorKeyHex === args.localKeyHex) continue;
    unreadCount++;
    if (firstUnreadSeq === null || m.seq < firstUnreadSeq) firstUnreadSeq = m.seq;
    const mentionsMe =
      m.mentions.includes(args.localKeyHex) ||
      m.mentionEveryoneEffective ||
      m.mentions.some((id) => args.localRoleIds.has(id));
    if (mentionsMe) pendingMentions++;
  }
  return { unreadCount, pendingMentions, firstUnreadSeq };
}
