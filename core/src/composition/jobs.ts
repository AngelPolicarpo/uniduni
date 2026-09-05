// O trabalho periódico do núcleo vivo — jobs de §22.2 e loops permanentes de §22.1.
//
// Raiz de composição (§4): cada entrada é uma chamada a um módulo que existe — o que mora
// aqui é a **cadência** e o cancelamento, nunca decisão de domínio.
//
// §22.5 é a regra que dá forma ao arquivo: nenhum job sobrevive ao fechamento do seu escopo.
// Como todos os jobs desta fase são por instalação (não por comunidade), o escopo é o do
// núcleo, e `stop()` é chamado pelo `close` do runtime — nada de job zumbi escrevendo em
// banco fechado.
//
// O relógio é injetado (`schedule`/`cancel` de `BootDeps`): em teste o agendador é no-op e
// quem dispara o job é `runNow`, que é o mesmo caminho, sem esperar 15 minutos. Nada de
// `setInterval` solto: quem torna o trabalho periódico é o REARME depois de cada execução —
// e é ele que também impede sobreposição, porque o próximo relógio só começa quando o
// anterior terminou.

import { DEFAULT_HELLO_MS, DEFAULT_WATCH_MS } from '../l2/communityClient/index.ts';
import { OUTBOX_RECONCILE_MS } from '../l2/outbox/index.ts';
import { PRESENCE_REFRESH_MS, PRESENCE_TICK_MS } from '../l2/presence/index.ts';

/** Cadências de §22.2 — os períodos são normativos, não preferência de implementação. */
export const JOB_INTERVALS = {
  'invite.topicSweep': 15 * 60_000,
  /** §11.6 regra 1 — `dropped/expired` SÓ depois de reconciliar; a cadência é a de olhar. */
  'outbox.expire': 5 * 60_000,
  'host.inactivity': 6 * 60 * 60_000,
  'staging.gc': 24 * 60 * 60_000,
  'removed.purge': 24 * 60 * 60_000,
  'db.maintenance': 24 * 60 * 60_000,
  'log.rotate': 24 * 60 * 60_000,
  'succession.check': 24 * 60 * 60_000,
  'blob.gc': 24 * 60 * 60_000,
} as const;

export type JobName = keyof typeof JOB_INTERVALS;

/**
 * Loops permanentes de §22.1 com corpo em código nesta fase. `media.ticketRenew`,
 * `blob.progress` e o projector reativo já têm dono nos seus subsistemas. Os períodos vêm
 * das constantes dos módulos que executam — nunca de uma segunda tabela solta.
 */
export const LOOP_INTERVALS = {
  /** §22.1 — um giro de flush por segundo em todo nó (o cameBack dispara fora de cadência). */
  'outbox.flush': 1_000,
  /** §22.1/§27.2 — `P2P_OUTBOX_RECONCILE_MS`; boot e `cameBack` também reconciliam. */
  'outbox.reconcile': OUTBOX_RECONCILE_MS,
  /** §22.1/§27.2 — `P2P_REPLICATION_WATCH_MS`; eventos por `CommunityClient.onEvent`. */
  'replication.watchdog': DEFAULT_WATCH_MS,
  /**
   * §22.1 emendada (2026-08-23)/§27.2 — `P2P_HELLO_INTERVAL_MS`, todo nó membro: alimenta
   * `synced` (§14.5) e é o `hello` obrigatório da primeira conexão (§16.3).
   */
  'host.hello': DEFAULT_HELLO_MS,
  /** §17.6 — o host agrega presença em delta consolidado a cada `PRESENCE_TICK_MS`. */
  'presence.tick': PRESENCE_TICK_MS,
  /** §17.6 — TTL 5 s do typing, varrido a cada segundo no host. */
  'typing.expire': 1000,
  /** §17.6/§6.16 — republish antes do TTL de 45 s; todo nó. */
  'presence.refresh': PRESENCE_REFRESH_MS,
  /**
   * §22.1 emendada (2026-08-26)/§17.4 — **queda de conexão é saída da chamada**, e a
   * varredura é a rede de segurança de quando o transporte não percebe a queda (máquina
   * desligada não manda FIN). Roda no host, na cadência do `hello`, e derruba do roster
   * quem não fala há `VOICE_LIVENESS_MS`. O prazo é DERIVADO da evidência que o alimenta —
   * três `hello` (§22.1) —, e não uma segunda constante: um número solto seria mais um
   * valor a envelhecer separado daquilo que o justifica.
   */
  'voice.liveness': DEFAULT_HELLO_MS,
  /**
   * §16.4/§22.2 (emenda de 2026-08-30) — o giro do relógio da fila de karaokê, no host.
   * Rodava acoplado ao `voice.liveness`, na cadência do hello (30 s): o turno vencido
   * durava até 30 s além do prazo — o titular com o microfone aberto numa vez que já era
   * do próximo, e a promoção do próximo atrasada junto. A vez é coisa de SEGUNDOS; o giro
   * que a expira acompanha o `typing.expire`, que já é por segundo.
   */
  'voice.queueTick': 1_000,
  /** §22.1 — o registro central de §24.3 é cometido pelos detentores a cada 10 s, todo nó. */
  'metrics.flush': 10_000,
  /**
   * §17.3/§22.1 (emenda de 2026-09-05) — a varredura de alocações do TURN do host: fecha a
   * socket relayada de quem venceu e a de quem saiu do roster (§17.4). A cadência é a da
   * vida da permissão de RFC 5766 §9 dividida por dez — o vazamento é de socket, não de
   * segurança (a revogação ativa já fecha o caminho no ato), e varrer por segundo custaria
   * um giro de mapa a cada segundo num host que quase nunca tem alocação.
   */
  'media.sweep': 30_000,
} as const;

export type LoopName = keyof typeof LOOP_INTERVALS;

/**
 * §17.4/§22.1 — silêncio acima disto é par morto para efeito de roster de voz. Três voltas
 * do `hello`: tolera uma perdida e a jitter da rede sem derrubar ninguém de uma chamada em
 * que ainda está. O caminho rápido continua sendo o fechamento do canal, que derruba na
 * hora; este prazo é o teto de quanto um fantasma pode durar quando esse aviso não vem.
 */
export const VOICE_LIVENESS_MS = 3 * DEFAULT_HELLO_MS;

/**
 * §17.6 — a janela de coalescência de `voiceOccupancy`, que a tabela declara ("coalescido
 * em 1 s") e o produto não tinha. Não é loop: é janela por canal, aberta pela primeira
 * mudança e fechada com o último estado. Mora aqui porque é cadência, que é o que este
 * arquivo guarda.
 */
export const VOICE_OCCUPANCY_COALESCE_MS = 1_000;

/**
 * §7/§17.6 — quantas chaves acompanham a contagem em `voice.occupancyChanged`
 * (`firstKeys[≤5]`). Era 3 em código e 5 na spec; o recorte existe para a sidebar poder
 * NOMEAR quem está na sala, e cortar dois a menos do que o contrato permite só empobrecia
 * a lista sem economizar quadro nenhum.
 */
export const VOICE_OCCUPANCY_FIRST_KEYS = 5;

type PeriodicDeps<K extends string> = {
  schedule(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
  bodies: { readonly [P in K]?: () => void | Promise<void> };
  onError?(name: K, err: unknown): void;
};

type PeriodicRunner<K extends string> = {
  runNow(name: K): Promise<void>;
  stop(): void;
};

/**
 * Um corredor por nome: rearma após cada execução (§22.2/§22.5) e para junto com o núcleo.
 * Compartilhado pelos jobs de §22.2 e pelos loops de §22.1 — a cadência muda, a disciplina
 * não.
 */
function startPeriodic<K extends string>(intervals: Readonly<Record<K, number>>, deps: PeriodicDeps<K>): PeriodicRunner<K> {
  let parado = false;

  async function runNow(name: K): Promise<void> {
    const body = deps.bodies[name];
    if (body === undefined || parado) return;
    try {
      await body();
    } catch (err) {
      deps.onError?.(name, err);
    }
  }

  const armados = new Map<K, unknown>();
  function armar(nome: K): void {
    if (parado) return;
    armados.set(
      nome,
      deps.schedule(() => {
        void runNow(nome).finally(() => armar(nome));
      }, intervals[nome]),
    );
  }
  for (const nome of Object.keys(intervals) as K[]) {
    if (deps.bodies[nome] === undefined) continue;
    armar(nome);
  }

  return {
    runNow,
    stop() {
      parado = true;
      for (const h of armados.values()) deps.cancel(h);
      armados.clear();
    },
  };
}

export type JobRunnerDeps = {
  /** `setInterval` do produto; em teste, o injetado por `BootDeps` (no-op determinístico). */
  schedule(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
  jobs: { readonly [K in JobName]?: () => void | Promise<void> };
  /** Falha de job não derruba o núcleo (§22.5): o próximo ciclo tenta de novo. */
  onError?(name: JobName, err: unknown): void;
};

export type JobRunner = PeriodicRunner<JobName>;

export function startJobs(deps: JobRunnerDeps): JobRunner {
  return startPeriodic(JOB_INTERVALS, {
    schedule: deps.schedule,
    cancel: deps.cancel,
    bodies: deps.jobs,
    ...(deps.onError !== undefined ? { onError: deps.onError } : {}),
  });
}

export type LoopRunnerDeps = {
  schedule(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
  loops: { readonly [K in LoopName]?: () => void | Promise<void> };
  onError?(name: LoopName, err: unknown): void;
};

export type LoopRunner = PeriodicRunner<LoopName>;

/** Os loops permanentes de §22.1 — mesma disciplina de rearme e cancelamento dos jobs. */
export function startLoops(deps: LoopRunnerDeps): LoopRunner {
  return startPeriodic(LOOP_INTERVALS, {
    schedule: deps.schedule,
    cancel: deps.cancel,
    bodies: deps.loops,
    ...(deps.onError !== undefined ? { onError: deps.onError } : {}),
  });
}
