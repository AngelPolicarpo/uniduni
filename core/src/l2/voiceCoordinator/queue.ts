// `voiceCoordinator` host-side — a fila de karaokê do modo fila (§16.4, emenda de 2026-08-28).
//
// Estado **efêmero** de §6.16, como o roster: morre com o processo do host, morre com a
// sessão de voz e não é reconstruído pela sucessão. A máquina é uma só por canal:
//
//   { aberta: bool, itens: [{keyHex, queuedAt}] ordenados, turno: {keyHex, endsAt} | null }
//
// **O gate de transmissão (§17.4 emenda) lê daqui** — `titularDe` é o que o `canTransmit`
// da composição consulta, e quem pode desmutar é exatamente o titular. Fila e gate
// compartilham o mesmo estado: não existe "titular que o host mantém mudo" nem "desmutado
// que não é titular".
//
// Primeiro turno é automático (§16.4): entrada nova numa fila sem turno corrente vira
// titular no ato — a fila existe para dar vez, não para esperar um moderador abrir a
// primeira. A partir daí a promoção é sequencial: expiração, `skip`, saída ou remoção do
// titular promovem o próximo; fila vazia encerra o turno sem sucessor.
//
// O relógio de verdade é o do HOST (injetado aqui); `endsAt` viaja no evento para a UI
// desenhar a contagem, e a UI nunca desmuta por conta própria quando o prazo dela vence.

export type ItemFila = { readonly keyHex: string; readonly queuedAt: number };
export type Turno = { readonly keyHex: string; readonly endsAt: number };
export type EstadoFila = {
  readonly aberta: boolean;
  readonly itens: readonly ItemFila[];
  readonly turno: Turno | null;
};

export type AcaoFila = 'promote' | 'skip' | 'remove' | 'addTime' | 'open' | 'close';

export type FilaErr = { readonly ok: false; readonly code: 'E_QUEUE_CLOSED' | 'E_SESSION_GONE' | 'E_VALIDATION' };

export interface FilaOpts {
  readonly clock?: { now(): number };
  /**
   * Duração do turno do canal, em segundos (§6.6 `queueTurnSeconds`, default 300). O fold
   * é quem guarda o valor; a composição injeta a leitura.
   */
  readonly duracaoTurnoDe: (channelId: string) => number;
  /** Toda mudança de estado sai por aqui — a composição faz o fan-out de §16.3. */
  readonly aoMudar?: (channelId: string, estado: EstadoFila) => void;
  /** Teto absoluto de um turno, em ms (§16.4: "o total do turno não passa de 3600"). */
  readonly turnoMaxMs?: number;
}

const TURN_MAX_MS = 3_600_000;
const ADD_TIME_MIN_MS = 30_000;
const ADD_TIME_MAX_MS = 600_000;

interface Fila {
  aberta: boolean;
  itens: ItemFila[];
  turno: { keyHex: string; endsAt: number; inicio: number } | null;
}

/** O estado no FIO, nos nomes de §15.5/§16.3: `{open, items, turn}`. */
export type EstadoFilaNoFio = {
  readonly open: boolean;
  readonly items: ReadonlyArray<{ keyHex: string; queuedAt: number }>;
  readonly turn: { keyHex: string; endsAt: number } | null;
};

/**
 * A tradução estado interno → fio. Existia uma só razão para existir, e ela é a lição do
 * primeiro pouso: o `empurra` espalhava `{aberta, itens, turno}` — os nomes daqui —, o
 * renderer esperava `{open, items, turn}` e descartava o evento inteiro por forma
 * (§15.2/§16.3 regra 2). "Entrar na fila" funcionava NO HOST e a tela nunca ficava
 * sabendo. Os nomes da spec são inglês; os daqui, português; a tradução mora em UMA
 * função, usada pelos DOIS pontos que emitem (o push e o instantâneo de conexão).
 */
export function filaParaOFio(estado: EstadoFila): EstadoFilaNoFio {
  return {
    open: estado.aberta,
    items: estado.itens.map((i) => ({ keyHex: i.keyHex, queuedAt: i.queuedAt })),
    turn: estado.turno === null ? null : { keyHex: estado.turno.keyHex, endsAt: estado.turno.endsAt },
  };
}

export class FilaKaraoké {
  readonly #clock: { now(): number };
  readonly #duracaoTurnoDe: (channelId: string) => number;
  readonly #aoMudar: (channelId: string, estado: EstadoFila) => void;
  readonly #turnoMaxMs: number;
  readonly #filas = new Map<string, Fila>();

  constructor(opts: FilaOpts) {
    this.#clock = opts.clock ?? { now: () => Date.now() };
    this.#duracaoTurnoDe = opts.duracaoTurnoDe;
    this.#aoMudar = opts.aoMudar ?? (() => {});
    this.#turnoMaxMs = opts.turnoMaxMs ?? TURN_MAX_MS;
  }

  /** O titular do turno do canal — o que o gate de §17.4 consulta. `null` sem turno. */
  titularDe(channelId: string): string | null {
    return this.#filas.get(channelId)?.turno?.keyHex ?? null;
  }

  /** O estado completo — é o payload de `voice.queueChanged` e de `query.voiceQueue`. */
  estadoDe(channelId: string): EstadoFila {
    const f = this.#filas.get(channelId);
    if (f === undefined) return { aberta: true, itens: [], turno: null };
    return {
      aberta: f.aberta,
      itens: f.itens.map((i) => ({ ...i })),
      turno: f.turno === null ? null : { keyHex: f.turno.keyHex, endsAt: f.turno.endsAt },
    };
  }

  /**
   * Entrada (§16.4): exige fila aberta, sem duplicata e sem ser o titular. Idempotente.
   * Entrada nova numa fila SEM turno vira titular no ato — o primeiro turno é automático.
   */
  entrar(channelId: string, keyHex: string): { ok: true } | FilaErr {
    const f = this.#garantir(channelId);
    if (!f.aberta) return { ok: false, code: 'E_QUEUE_CLOSED' };
    if (f.turno?.keyHex === keyHex) return { ok: true };
    if (f.itens.some((i) => i.keyHex === keyHex)) return { ok: true };
    f.itens.push({ keyHex, queuedAt: this.#clock.now() });
    if (f.turno === null) this.#promover(channelId, f);
    this.#emitir(channelId);
    return { ok: true };
  }

  /** Saída, idempotente. Sair como titular encerra o turno e promove o próximo. */
  sair(channelId: string, keyHex: string): void {
    const f = this.#filas.get(channelId);
    if (f === undefined) return;
    const antes = this.#resumo(f);
    f.itens = f.itens.filter((i) => i.keyHex !== keyHex);
    if (f.turno?.keyHex === keyHex) {
      this.#promover(channelId, f);
    }
    if (this.#resumo(f) !== antes) this.#emitir(channelId);
  }

  /**
   * §16.4 (emenda de 2026-09-05) — a fila contra o roster VIVO do canal.
   *
   * A saída explícita (`voiceQueueLeave`) era o **único** caminho que chamava `sair`. Ban,
   * kick, `voiceLeave` e queda de conexão tiram do roster e não tocavam a fila: o ausente
   * seguia como titular, e como o gate de transmissão de §17.4 é "só o titular fala", o
   * canal inteiro ficava mudo por imposição até `endsAt` vencer — e o `ticar` promovia o
   * próximo fantasma, encadeando turnos vazios. `ticar` não podia resolver: ele só sabe se
   * a SESSÃO vive, não quem está nela.
   *
   * Idempotente e silenciosa quando nada muda — ela é chamada a cada `voice.roster`, e a
   * própria imposição de turno emite um roster novo.
   */
  reconciliar(channelId: string, presentes: ReadonlySet<string>): void {
    const f = this.#filas.get(channelId);
    if (f === undefined) return;
    const antes = this.#resumo(f);
    f.itens = f.itens.filter((i) => presentes.has(i.keyHex));
    if (f.turno !== null && !presentes.has(f.turno.keyHex)) this.#promover(channelId, f);
    if (this.#resumo(f) !== antes) this.#emitir(channelId);
  }

  /**
   * Moderação (§16.4) — exige `voice_mute_others`, conferido pelo CHAMADOR (o dispatcher,
   * que tem o DS); aqui só a forma e o efeito.
   */
  moderar(channelId: string, acao: AcaoFila, alvo?: string, segundos?: number): { ok: true } | FilaErr {
    const f = this.#garantir(channelId);
    switch (acao) {
      case 'skip': {
        if (f.turno !== null) this.#promover(channelId, f);
        break;
      }
      case 'promote': {
        if (alvo === undefined) return { ok: false, code: 'E_VALIDATION' };
        if (f.turno?.keyHex === alvo) break; // dar a vez a quem já tem é no-op
        const i = f.itens.findIndex((item) => item.keyHex === alvo);
        if (i < 0) return { ok: false, code: 'E_VALIDATION' }; // alvo fora da fila
        const [item] = f.itens.splice(i, 1);
        f.itens.unshift(item!);
        this.#promover(channelId, f);
        break;
      }
      case 'remove': {
        if (alvo === undefined) return { ok: false, code: 'E_VALIDATION' };
        f.itens = f.itens.filter((i) => i.keyHex !== alvo);
        if (f.turno?.keyHex === alvo) this.#promover(channelId, f);
        break;
      }
      case 'addTime': {
        // A forma vem antes do efeito: `seconds` inválido é recusa mesmo sem turno.
        if (segundos === undefined || !Number.isInteger(segundos) || segundos * 1000 < ADD_TIME_MIN_MS || segundos * 1000 > ADD_TIME_MAX_MS) {
          return { ok: false, code: 'E_VALIDATION' };
        }
        if (f.turno === null) break; // sem turno não há o que estender (no-op nomeado)
        const teto = f.turno.inicio + this.#turnoMaxMs;
        f.turno.endsAt = Math.min(f.turno.endsAt + segundos * 1000, teto);
        break;
      }
      case 'open': {
        f.aberta = true;
        break;
      }
      case 'close': {
        f.aberta = false;
        break;
      }
      default:
        return { ok: false, code: 'E_VALIDATION' };
    }
    this.#emitir(channelId);
    return { ok: true };
  }

  /**
   * O giro do relógio — a composição chama no loop `voice.queueTick` (§22.2, emenda de
   * 2026-08-30), que roda por segundo para os hosts. Faz as duas coisas da vida curta da
   * fila: expira o turno vencido (muta o titular e promove o próximo) e descarta a fila do
   * canal cuja sessão de voz acabou (§6.16 — a fila é efêmera como o roster).
   */
  ticar(sessaoViva: (channelId: string) => boolean): void {
    const agora = this.#clock.now();
    for (const [channelId, f] of [...this.#filas]) {
      if (!sessaoViva(channelId)) {
        if (f.turno !== null || f.itens.length > 0) this.#emitir(channelId);
        this.#filas.delete(channelId);
        continue;
      }
      if (f.turno !== null && agora >= f.turno.endsAt) {
        this.#promover(channelId, f);
        this.#emitir(channelId);
      }
    }
  }

  #garantir(channelId: string): Fila {
    let f = this.#filas.get(channelId);
    if (f === undefined) {
      f = { aberta: true, itens: [], turno: null };
      this.#filas.set(channelId, f);
    }
    return f;
  }

  /** Encerra o turno corrente e promove o próximo da fila — ou encerra sem sucessor. */
  #promover(channelId: string, f: Fila): void {
    const proximo = f.itens.shift();
    const duracao = this.#duracaoTurnoDe(channelId) * 1000;
    f.turno =
      proximo === undefined
        ? null
        : { keyHex: proximo.keyHex, endsAt: this.#clock.now() + duracao, inicio: this.#clock.now() };
  }

  #resumo(f: Fila): string {
    return JSON.stringify([f.aberta, f.itens.map((i) => i.keyHex), f.turno?.keyHex ?? null, f.turno?.endsAt ?? null]);
  }

  #emitir(channelId: string): void {
    this.#aoMudar(channelId, this.estadoDe(channelId));
  }
}
