// Acompanhamento da conexão com o host — DR-29/DR-33, §15.6 `HostStatus`, §11.8, §22.1/§22.3.
//
// Raiz de composição (§4), pelo mesmo motivo do recálculo de não-lidas (§53): o enum é
// **por instalação** ("o host VIsto por MIM"), não dado replicado — o mesmo log não pode
// produzir status diferente por réplica, e o `Effect` de §8.4 é tipo fechado sobre CS.
//
// As fontes são todas reais, nunca inventadas:
//
//   - `connecting`  — o canal de §16.1 foi anexado (`attachHostChannel`, chamado pelo
//                     transporte quando o Hyperswarm entrega a conexão);
//   - `online`      — uma resposta do host foi observada (resultado de submissão da outbox;
//                     em modo hospedeiro, a submissão é local e nasce online);
//   - `reconnecting`/`offline` — o transporte avisou queda (`onDown`): com contato anterior
//                     é `reconnecting`; sem nenhum, `offline`;
//   - `ended`       — `community.end` projetado (`DS.community.endedAt`);
//   - `unauthorized`/`forked` — o watchdog de replicação de §14.5 (`CommunityClient`);
//   - `incompatible`— `E_VERSION_UNSUPPORTED` observado na fila (§11.6 regra 3 fecha
//                     `client-outdated`; §16.3 manda emitir o status).
//
// O que mais mora aqui, porque as fontes estão na mão desta raiz:
//
//   - `last_host_seen_at` (LS, §6.15) — escrito NA HORA do primeiro contato e de cada volta;
//   - `host.cameBack` — a transição de volta a `online` dispara reconciliação imediata
//     (§22.1) e flush **com jitter** (§11.8): `RECONNECT_FLUSH_DELAY_MS` +
//     `hash(identityKey) mod 2000 ms`, e taxado a `FLUSH_RATE_PER_S` itens/s — o jitter não
//     é enfeite, §22.3 explica a avalanche que ele evita;
//   - `host.inactivity` (§22.2) — reavalia os dias desde o último contato; a travessia do
//     limiar `INACTIVE_COMMUNITY_DAYS` sai por `host.statusChanged`, o único sinal da tabela
//     fechada de §15.5 que nomeia o relacionamento com o host.

import type { ManifestDb } from '../l0/manifest/index.ts';
import type { DecisionState } from '../l1/fold/index.ts';
import type { Outbox, SubmitResult } from '../l2/outbox/index.ts';

/** Enum FECHADO de §15.6. */
export type HostConnectionState =
  | 'unknown'
  | 'connecting'
  | 'online'
  | 'reconnecting'
  | 'offline'
  | 'ended'
  | 'unauthorized'
  | 'incompatible'
  | 'forked';

/** §27.2 `P2P_INACTIVE_COMMUNITY_DAYS` (default 30) — rótulo "Inativa há muito tempo". */
export const INACTIVE_COMMUNITY_DAYS = 30;
/** §27.2 — base do flush pós-reconexão (§11.8). */
export const RECONNECT_FLUSH_DELAY_MS = 1000;
/** §27.2 — taxa máxima do flush pós-reconexão, itens/s por comunidade (§11.8). */
export const FLUSH_RATE_PER_S = 20;

const DIA_MS = 24 * 60 * 60_000;
const JITTER_MOD_MS = 2000;

export function inactiveDaysFrom(lastHostSeenAt: number, now: number): number {
  return Math.floor((now - lastHostSeenAt) / DIA_MS);
}

/**
 * §11.8 — jitter proporcional a `hash(identityKey) mod 2000 ms`. Determinístico pela chave:
 * dois membros diferentes desconectam em fases diferentes, que é o ponto.
 */
export function reconnectJitterMs(identityKeyHex: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < identityKeyHex.length; i++) {
    hash ^= identityKeyHex.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % JITTER_MOD_MS;
}

export type HostStatusEvent = {
  readonly topic: 'host.statusChanged';
  readonly data: {
    readonly communityId: string;
    readonly status: HostConnectionState;
    readonly lastSeenAt?: number;
    readonly attempt?: number;
  };
};

export type HostStatusDeps = {
  readonly manifest: ManifestDb;
  /** Porta do fan-out de §15.5 — mesma forma de `EventFanout.emit`. */
  emit(ev: HostStatusEvent, route: { communityId: string }): void;
  /** Relógio injetável — testes fixam, produto usa o de parede. */
  now(): number;
  /** Os mesmos cabos injetados de `BootDeps`; em teste, no-op determinístico. */
  schedule(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
  /** A fila durável da comunidade — quem executa o flush/reconciliação de `cameBack`. */
  outboxOf(communityId: string): Outbox | undefined;
  /** DS projetado — fonte dos estados terminais `ended`. */
  stateFor(communityId: string): DecisionState | null;
  /** Estado de replicação de §14.5 — fonte de `unauthorized`/`forked`. */
  replicationStateOf(communityId: string): string | null;
  /** Chave pública hex da identidade local — semeia o jitter de §11.8. */
  selfKeyHex(): string | null;
};

type Dinamico = {
  estado: Exclude<HostConnectionState, 'ended' | 'unauthorized' | 'incompatible' | 'forked'>;
  attempts: number;
};

export class HostStatusTracker {
  readonly #deps: HostStatusDeps;
  readonly #dinamico = new Map<string, Dinamico>();
  /** `incompatible` é pegajoso: nada nesta fase des-marca (novo binário = novo processo). */
  readonly #incompativel = new Set<string>();
  /** Comunidades cujo limiar de inatividade já foi sinalizado nesta sessão. */
  readonly #inatividadeSinalizada = new Set<string>();
  /** Rodadas de flush taxado pendentes, por comunidade — canceladas no `stop`. */
  readonly #flushRodada = new Map<string, unknown[]>();
  #parado = false;

  constructor(deps: HostStatusDeps) {
    this.#deps = deps;
  }

  /**
   * Registra a comunidade no acompanhamento. Modo hospedeiro nasce `online` — o host da
   * comunidade É esta instalação, e o contato é local: `last_host_seen_at` é escrito com
   * verdade, e o rail não mostra fantasma para quem hospeda.
   */
  ensure(communityId: string, opts: { readonly isHost: boolean }): void {
    if (this.#dinamico.has(communityId)) return;
    this.#dinamico.set(communityId, { estado: opts.isHost ? 'online' : 'unknown', attempts: 0 });
    if (opts.isHost) {
      this.#deps.manifest.setLastHostSeenAt(communityId, this.#deps.now());
      this.#emitir(communityId, 'online');
    }
  }

  forget(communityId: string): void {
    this.#dinamico.delete(communityId);
    this.#incompativel.delete(communityId);
    this.#inatividadeSinalizada.delete(communityId);
    for (const h of this.#flushRodada.get(communityId) ?? []) this.#deps.cancel(h);
    this.#flushRodada.delete(communityId);
  }

  /**
   * §16.1 — o transporte anexou o canal com o host (`attachHostChannel`). De
   * `reconnecting` também volta a `connecting`: o cabo existe de novo, e é disto que o
   * hello (§16.3) e o flush da outbox (§11.8) precisam para observar contato — sem esta
   * transição, um anexo pós-queda não desbloqueia nada e a instalação morre em
   * `reconnecting` para sempre (defeto do smoke de §63.4).
   */
  channelAttached(communityId: string): void {
    const d = this.#dinamico.get(communityId);
    if (d === undefined) return;
    const atual = this.#atual(communityId);
    if (atual !== null && atual !== 'unauthorized') return;
    if (d.estado === 'unknown' || d.estado === 'offline' || d.estado === 'reconnecting' || atual === 'unauthorized') {
      this.#mudar(communityId, 'connecting');
    }
  }

  /** §16.1 — o canal caiu. Com contato anterior é `reconnecting`; sem nenhum, `offline`. */
  channelDown(communityId: string): void {
    const d = this.#dinamico.get(communityId);
    if (d === undefined) return;
    if (d.estado === 'online') {
      d.attempts += 1;
      this.#mudar(communityId, 'reconnecting');
      return;
    }
    if (d.estado === 'connecting') {
      d.attempts += 1;
      const teveContato = this.#deps.manifest.getLastHostSeenAt(communityId) !== null;
      this.#mudar(communityId, teveContato ? 'reconnecting' : 'offline');
    }
  }

  /**
   * Falha observada no ping `hello` de §16.3/§22.1.
   *
   * Duas falhas consecutivas são o critério que vale para conectar ou reconectar:
   * sem contato anterior é `offline`, com contato é `reconnecting`. Em `online`,
   * uma conexão meio-aberta (half-open) sem FIN/RST é detectada por este canal
   * e transiciona para `reconnecting`.
   */
  noteHelloFailure(communityId: string): void {
    const d = this.#dinamico.get(communityId);
    if (d === undefined || (d.estado !== 'connecting' && d.estado !== 'online')) return;
    d.attempts += 1;
    if (d.attempts < 2) return;
    const teveContato = this.#deps.manifest.getLastHostSeenAt(communityId) !== null;
    this.#mudar(communityId, teveContato ? 'reconnecting' : 'offline');
  }

  /**
   * Resultado de um passe de submissão da outbox. `null` é indisponibilidade (§11.8):
   * de `online` cai para `reconnecting` sem esperar o `onDown`. Resposta com item aceito
   * marca contato; `E_VERSION_UNSUPPORTED` fixa `incompatible` (§16.3).
   */
  noteSubmit(communityId: string, result: readonly SubmitResult[] | null): void {
    if (result === null) {
      const d = this.#dinamico.get(communityId);
      if (d === undefined) return;
      if (d.estado === 'online') {
        d.attempts += 1;
        this.#mudar(communityId, 'reconnecting');
      }
      return;
    }
    for (const item of result) {
      if (!item.ok && item.code === 'E_VERSION_UNSUPPORTED') {
        this.#incompativel.add(communityId);
        this.#emitir(communityId, 'incompatible');
        return;
      }
    }
    this.markSeen(communityId);
  }

  /**
   * Contato observado com o host. De volta de um estado pós-perda é `host.cameBack` —
   * mesmo que a recuperação tenha passado por `connecting` (anexo novo pós-queda):
   * reconciliação imediata e flush taxado são de §11.8/§22.1, e sem elas uma op
   * `awaiting-confirmation` esperaria a cadência de 30 s para desbloquear a fila.
   */
  markSeen(communityId: string): void {
    const d = this.#dinamico.get(communityId);
    if (d === undefined || this.#parado) return;
    // Contato renovado mantém a marca do LS fresca mesmo sem mudança de estado.
    this.#deps.manifest.setLastHostSeenAt(communityId, this.#deps.now());
    if (d.estado === 'online') {
      d.attempts = 0;
      return;
    }
    const perdas = d.attempts;
    d.attempts = 0;
    this.#mudar(communityId, 'online');
    if (perdas > 0) this.#cameBack(communityId);
  }

  /** §11.8 — reconciliação imediata + flush taxado depois de `RECONNECT_FLUSH_DELAY_MS` ± jitter. */
  #cameBack(communityId: string): void {
    if (this.#parado) return;
    const outbox = this.#deps.outboxOf(communityId);
    if (outbox === undefined) return;
    // §22.1 — `outbox.reconcile` em `host.cameBack`: sem isso, op com ACK não interpretado
    // fica `awaiting-confirmation` e bloqueia o canal na fila (lição de §45–§53).
    outbox.reconcile(this.#deps.now());
    const jitter = RECONNECT_FLUSH_DELAY_MS + reconnectJitterMs(this.#deps.selfKeyHex() ?? '');
    const rodadas = this.#flushRodada.get(communityId) ?? [];
    this.#flushRodada.set(communityId, rodadas);
    rodadas.push(
      this.#deps.schedule(() => {
        void this.#rodadaDeFlush(communityId);
      }, jitter),
    );
  }

  async #rodadaDeFlush(communityId: string): Promise<void> {
    const outbox = this.#deps.outboxOf(communityId);
    if (outbox === undefined || this.#parado) return;
    const enviados = await outbox.flush({ maxItems: FLUSH_RATE_PER_S });
    // A rodada seguinte só existe com o contato ainda de pé (§11.8).
    if (enviados === 0 || this.#dinamico.get(communityId)?.estado !== 'online') return;
    // Taxa de §11.8: uma rodada por segundo enquanto houver o que enviar.
    const rodadas = this.#flushRodada.get(communityId) ?? [];
    this.#flushRodada.set(communityId, rodadas);
    rodadas.push(
      this.#deps.schedule(() => {
        void this.#rodadaDeFlush(communityId);
      }, 1000),
    );
  }

  /** §22.2 `host.inactivity` — devolve as comunidades que ATRAVESSARAM o limiar agora. */
  runInactivity(): readonly string[] {
    const now = this.#deps.now();
    const atravessaram: string[] = [];
    for (const communityId of this.#dinamico.keys()) {
      if (this.#inatividadeSinalizada.has(communityId)) continue;
      const ultimo = this.#deps.manifest.getLastHostSeenAt(communityId);
      // Sem último contato não há dias para contar — e inventar seria violar o precedente
      // de §46/§50. O rail já mostra o estado de conexão, que é o que existe.
      if (ultimo === null) continue;
      if (inactiveDaysFrom(ultimo, now) >= INACTIVE_COMMUNITY_DAYS) {
        this.#inatividadeSinalizada.add(communityId);
        atravessaram.push(communityId);
        // §15.5 tabela fechada — o sinal é o próprio `host.statusChanged`; a UI reconsulta
        // e deriva o rótulo do `inactiveDays` da consulta.
        this.#emitir(communityId, this.statusOf(communityId));
      }
    }
    return atravessaram;
  }

  /**
   * O estado OBSERVÁVEL. Os terminais têm precedência sobre o dinâmico — um fork diz mais
   * sobre o relacionamento do que qualquer conexão — e são avaliados nas fontes vivas, sem
   * transição perdida.
   */
  statusOf(communityId: string): HostConnectionState {
    const terminal = this.#atual(communityId);
    return terminal ?? this.#dinamico.get(communityId)?.estado ?? 'unknown';
  }

  attemptOf(communityId: string): number {
    return this.#dinamico.get(communityId)?.attempts ?? 0;
  }

  stop(): void {
    this.#parado = true;
    for (const rodadas of this.#flushRodada.values()) {
      for (const h of rodadas) this.#deps.cancel(h);
    }
    this.#flushRodada.clear();
  }

  /** Terminal corrente, ou `null` quando o que vale é o dinâmico. */
  #atual(communityId: string): Extract<HostConnectionState, 'unauthorized' | 'incompatible' | 'forked' | 'ended'> | null {
    if (this.#incompativel.has(communityId)) return 'incompatible';
    const replicacao = this.#deps.replicationStateOf(communityId);
    if (replicacao === 'forked') return 'forked';
    if (replicacao === 'unauthorized') return 'unauthorized';
    const ds = this.#deps.stateFor(communityId);
    if (ds !== null && ds.community.exists && ds.community.endedAt !== undefined) return 'ended';
    return null;
  }

  #mudar(communityId: string, proximo: Dinamico['estado']): void {
    const d = this.#dinamico.get(communityId);
    if (d === undefined || d.estado === proximo) return;
    d.estado = proximo;
    this.#emitir(communityId, proximo);
  }

  #emitir(communityId: string, status: HostConnectionState): void {
    if (this.#parado) return;
    const ultimo = this.#deps.manifest.getLastHostSeenAt(communityId);
    const attempts = this.attemptOf(communityId);
    this.#deps.emit(
      {
        topic: 'host.statusChanged',
        data: {
          communityId,
          status,
          ...(ultimo !== null ? { lastSeenAt: ultimo } : {}),
          ...(attempts > 0 ? { attempt: attempts } : {}),
        },
      },
      { communityId },
    );
  }
}
