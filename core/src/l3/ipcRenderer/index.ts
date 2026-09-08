// `ipcRenderer` — L3, protocolo e transporte IPC-R para o renderer (§4, §15.1, §15.2, §15.3, §15.4, §15.5, A14).
//
// §4: depende de L2.
// §4: Roteamento, autorização de comando, forma da fronteira; sem regra de negócio.

type IpcFrame =
  | { t: 'hello'; epoch: number; coreVersion: string; opVersion: number; schemaVersion: number }
  | { t: 'req'; epoch: number; id: number; cmd: string; arg: unknown; authToken?: string }
  | { t: 'res'; epoch: number; id: number; ok: boolean; data?: unknown; err?: { code: string; message: string; field?: string; details?: unknown; retryAfterMs?: number } }
  | { t: 'sub'; epoch: number; id: number; topic: string; filter?: unknown }
  | { t: 'subOk'; epoch: number; id: number; subId: number }
  | { t: 'unsub'; epoch: number; subId: number }
  | { t: 'ev'; epoch: number; subId: number; evSeq: number; topic: string; data: unknown }
  | { t: 'evAck'; epoch: number; subId: number; evSeq: number }
  | { t: 'evStale'; epoch: number; subId: number; fromSeq: number; toSeq: number; dropped: number };

type AuthClass = 'open' | 'standard' | 'main-confirmed' | 'dev';

type Handler = (
  arg: unknown,
  ctx: { id: number; epoch: number; authToken?: string },
) => unknown | Promise<unknown>;

type SubEntry = {
  subId: number;
  topic: string;
  filter?: unknown;
  /** Último `evSeq` ATRIBUÍDO — inclusive aos descartados, que é o que torna a perda visível. */
  evSeq: number;
  /** Último `evSeq` confirmado por `evAck`; `evSeq − lastAckedSeq` são os não confirmados. */
  lastAckedSeq: number;
  stale: boolean;
  /** Acumulador da janela corrente de descarte — o `dropped` de §15.1(4) é contagem, não 1. */
  descartados: number;
  primeiroDescartado: number | null;
  ultimoDescartado: number | null;
  prazoStale: ReturnType<typeof setTimeout> | null;
};

type HelloWaiter = {
  resolve: (hello: Extract<IpcFrame, { t: 'hello' }>) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export interface IpcPort {
  postMessage(frame: IpcFrame): void;
  onMessage(listener: (frame: IpcFrame) => void): void;
}

export class IpcServer {
  readonly #epoch: number;
  readonly #port: IpcPort;
  readonly #tokenVerifier: { consume(token: string, cmd: string, escopo: string | null): boolean };
  readonly #identityStatus: { isLoaded: boolean };
  readonly #buildChannel: string;
  readonly #subWindow: number;
  readonly #staleMs: number;
  /**
   * §15.3 emendado — o alvo ao qual o token se liga, derivado do argumento REAL do quadro.
   * Injetado pela raiz de composição (a tabela mora em `l3/ipcMain`, e L3 não importa L3):
   * é a mesma função que o renderer usa para pedir o token, e é essa igualdade que faz um
   * token de `community.end` da comunidade A não encerrar a B.
   */
  readonly #escopoDeConfirmacao: (cmd: string, arg: unknown) => string | null;
  readonly #handlers = new Map<string, { handler: Handler; authClass: AuthClass }>();
  readonly #subs = new Map<number, SubEntry>();
  #nextSubId = 1;

  constructor(opts: {
    epoch: number;
    port: IpcPort;
    tokenVerifier: { consume(token: string, cmd: string, escopo: string | null): boolean };
    identityStatus: { isLoaded: boolean };
    buildChannel?: string;
    subWindow?: number;
    staleMs?: number;
    escopoDeConfirmacao?: (cmd: string, arg: unknown) => string | null;
  }) {
    this.#epoch = opts.epoch;
    this.#port = opts.port;
    this.#tokenVerifier = opts.tokenVerifier;
    this.#identityStatus = opts.identityStatus;
    this.#buildChannel = opts.buildChannel ?? 'prod';
    this.#subWindow = opts.subWindow ?? 256;
    this.#staleMs = opts.staleMs ?? 3000;
    this.#escopoDeConfirmacao = opts.escopoDeConfirmacao ?? (() => null);
    this.#port.onMessage((frame) => {
      void this.#handleFrame(frame);
    });
  }

  get epoch(): number {
    return this.#epoch;
  }

  register(cmd: string, authClass: AuthClass, handler: Handler): void {
    if (this.#buildChannel === 'prod' && authClass === 'dev') {
      // §15.3: em prod comandos dev NÃO são registrados
      return;
    }
    this.#handlers.set(cmd, { handler, authClass });
  }

  /**
   * §15.3 — a classe de `blob.reveal` depende do **dado**, não do comando: a tabela diz
   * "`blob.reveal` de `archive`" na linha `main-confirmed`. O tipo do blob só se conhece
   * depois de olhá-lo, então o handler pede a confirmação nativa aqui, pelo mesmo caminho
   * que o roteador usa na classe estática — o token é de uso único e o renderer não o
   * fabrica.
   */
  requireConfirmation(cmd: string, authToken: string | undefined, arg: unknown): void {
    if (
      authToken === undefined ||
      !this.#tokenVerifier.consume(authToken, cmd, this.#escopoDeConfirmacao(cmd, arg))
    ) {
      throw Object.assign(new Error('Token de confirmação nativa inválido ou ausente'), {
        code: 'E_PERMISSION_DENIED',
      });
    }
  }

  sendHello(
    coreVersion = '1.0.0',
    opVersion = 2,
    schemaVersion = 3,
  ): void {
    this.#port.postMessage({
      t: 'hello',
      epoch: this.#epoch,
      coreVersion,
      opVersion,
      schemaVersion,
    });
  }

  /**
   * §15.1(4) — o núcleo para de emitir para um `subId` com mais de `IPC_SUB_WINDOW` eventos
   * não confirmados, e **passado `IPC_STALE_MS` nesse estado** emite `evStale` com a
   * contagem descartada.
   *
   * Duas coisas que a versão anterior não fazia, e que a spec pede pelo nome: o `evStale`
   * espera o prazo em vez de sair no instante em que a janela enche, e o `dropped` é a
   * contagem real da janela em vez de `1` fixo. O `evSeq` avança **também** no descarte —
   * é o buraco na numeração que dá ao renderer a "detecção de perda" de §15.1(3), e é o que
   * torna `fromSeq`/`toSeq` a faixa que de fato se perdeu.
   */
  emit(
    topic: string,
    data: unknown,
    matches?: (filter: unknown) => boolean,
  ): void {
    for (const sub of this.#subs.values()) {
      if (sub.topic !== topic) continue;
      if (sub.filter !== undefined && matches !== undefined && !matches(sub.filter)) continue;
      sub.evSeq++;
      if (sub.evSeq - sub.lastAckedSeq > this.#subWindow) {
        this.#descartar(sub);
        continue;
      }
      this.#port.postMessage({
        t: 'ev',
        epoch: this.#epoch,
        subId: sub.subId,
        evSeq: sub.evSeq,
        topic,
        data,
      });
    }
  }

  /** Contabiliza o descarte e arma (uma vez por janela) o prazo de `IPC_STALE_MS`. */
  #descartar(sub: SubEntry): void {
    sub.descartados++;
    if (sub.primeiroDescartado === null) sub.primeiroDescartado = sub.evSeq;
    sub.ultimoDescartado = sub.evSeq;
    if (sub.prazoStale !== null) return;
    const prazo = setTimeout(() => {
      sub.prazoStale = null;
      this.#anunciarStale(sub);
    }, this.#staleMs);
    // Um `subId` saturado não pode ser motivo para o processo não encerrar (§3.3 draining).
    prazo.unref?.();
    sub.prazoStale = prazo;
  }

  /**
   * Vencido o prazo com a janela ainda cheia: anuncia a faixa perdida e marca `stale`. O
   * acumulador zera aqui — se o renderer continuar sem confirmar, a janela seguinte produz
   * o próprio `evStale`, cada um com a contagem que lhe pertence.
   */
  #anunciarStale(sub: SubEntry): void {
    if (sub.descartados === 0) return;
    sub.stale = true;
    this.#port.postMessage({
      t: 'evStale',
      epoch: this.#epoch,
      subId: sub.subId,
      fromSeq: sub.primeiroDescartado ?? sub.evSeq,
      toSeq: sub.ultimoDescartado ?? sub.evSeq,
      dropped: sub.descartados,
    });
    sub.descartados = 0;
    sub.primeiroDescartado = null;
    sub.ultimoDescartado = null;
  }

  async #handleFrame(frame: IpcFrame): Promise<void> {
    // §15.1: quadro com epoch diferente do corrente é DESCARTADO sem resposta
    if ((frame as { epoch?: number }).epoch !== this.#epoch) {
      return;
    }
    switch (frame.t) {
      case 'req':
        await this.#handleReq(frame);
        break;
      case 'sub':
        this.#handleSub(frame);
        break;
      case 'unsub': {
        const sub = this.#subs.get(frame.subId);
        if (sub?.prazoStale != null) clearTimeout(sub.prazoStale);
        this.#subs.delete(frame.subId);
        break;
      }
      case 'evAck':
        this.#handleEvAck(frame);
        break;
      default:
        break;
    }
  }

  async #handleReq(frame: Extract<IpcFrame, { t: 'req' }>): Promise<void> {
    const entry = this.#handlers.get(frame.cmd);
    if (entry === undefined) {
      this.#port.postMessage({
        t: 'res',
        epoch: this.#epoch,
        id: frame.id,
        ok: false,
        err: {
          code: 'E_UNKNOWN_COMMAND',
          message: `Comando desconhecido: ${frame.cmd}`,
        },
      });
      return;
    }
    const { handler, authClass } = entry;
    // Checagem de autorização (§15.3)
    if (authClass === 'standard' && !this.#identityStatus.isLoaded) {
      this.#port.postMessage({
        t: 'res',
        epoch: this.#epoch,
        id: frame.id,
        ok: false,
        err: {
          code: 'E_NO_IDENTITY',
          message: 'Identidade necessária para executar esta ação',
        },
      });
      return;
    }
    if (authClass === 'main-confirmed') {
      if (
        frame.authToken === undefined ||
        !this.#tokenVerifier.consume(
          frame.authToken,
          frame.cmd,
          this.#escopoDeConfirmacao(frame.cmd, frame.arg),
        )
      ) {
        this.#port.postMessage({
          t: 'res',
          epoch: this.#epoch,
          id: frame.id,
          ok: false,
          err: {
            code: 'E_PERMISSION_DENIED',
            message: 'Token de confirmação nativa inválido ou ausente',
          },
        });
        return;
      }
    }
    try {
      const data = await handler(frame.arg, {
        id: frame.id,
        epoch: frame.epoch,
        ...(frame.authToken !== undefined ? { authToken: frame.authToken } : {}),
      });
      this.#port.postMessage({
        t: 'res',
        epoch: this.#epoch,
        id: frame.id,
        ok: true,
        data: data === undefined ? {} : (data as unknown),
      });
    } catch (err) {
      const e = err as {
        code?: string;
        message?: string;
        field?: string;
        details?: unknown;
        retryAfterMs?: number;
      };
      const errPayload: {
        code: string;
        message: string;
        field?: string;
        details?: unknown;
        retryAfterMs?: number;
      } = {
        code: e.code ?? 'E_INTERNAL',
        message: e.message ?? 'Erro interno',
      };
      if (e.field !== undefined) errPayload.field = e.field;
      if (e.details !== undefined) errPayload.details = e.details;
      if (e.retryAfterMs !== undefined) errPayload.retryAfterMs = e.retryAfterMs;
      this.#port.postMessage({
        t: 'res',
        epoch: this.#epoch,
        id: frame.id,
        ok: false,
        err: errPayload,
      });
    }
  }

  #handleSub(frame: Extract<IpcFrame, { t: 'sub' }>): void {
    const subId = this.#nextSubId++;
    this.#subs.set(subId, {
      subId,
      topic: frame.topic,
      filter: frame.filter,
      evSeq: 0,
      lastAckedSeq: 0,
      stale: false,
      descartados: 0,
      primeiroDescartado: null,
      ultimoDescartado: null,
      prazoStale: null,
    });
    this.#port.postMessage({
      t: 'subOk',
      epoch: this.#epoch,
      id: frame.id,
      subId,
    });
  }

  /**
   * §15.1(5) — o `evAck` traz o último `evSeq` recebido, e o núcleo retoma a emissão. A
   * marca **avança**, nunca zera um contador cego: zerar fazia um ack atrasado de um evento
   * antigo reabrir a janela inteira como se o renderer tivesse alcançado a cabeça. O
   * `Math.min` com `evSeq` impede que um ack de seq inventado abra janela sem fim.
   */
  #handleEvAck(frame: Extract<IpcFrame, { t: 'evAck' }>): void {
    const sub = this.#subs.get(frame.subId);
    if (sub === undefined) return;
    const ate = Math.min(frame.evSeq, sub.evSeq);
    if (ate > sub.lastAckedSeq) sub.lastAckedSeq = ate;
    if (sub.evSeq - sub.lastAckedSeq > this.#subWindow) return;
    // Fora da saturação: solta o prazo e volta a emitir.
    if (sub.prazoStale !== null) {
      clearTimeout(sub.prazoStale);
      sub.prazoStale = null;
    }
    sub.stale = false;
    sub.descartados = 0;
    sub.primeiroDescartado = null;
    sub.ultimoDescartado = null;
  }

  /** §3.3 `draining` — solta os prazos de `IPC_STALE_MS` ainda armados. */
  close(): void {
    for (const sub of this.#subs.values()) {
      if (sub.prazoStale !== null) clearTimeout(sub.prazoStale);
      sub.prazoStale = null;
    }
    this.#subs.clear();
  }
}

/**
 * `IpcClient` — lado renderer de IPC-R (§15.1, §15.2, A14, G6).
 *
 * - Mantém `epoch` corrente; quadro com epoch diferente é descartado (§15.1) exceto `hello`
 *   que atualiza o epoch e dispara a recuperação G6.
 * - Requests em voo falham com `E_CORE_RESTARTED` no bump de epoch (§15.2 4a) e NUNCA são
 *   reenviados automaticamente — escrita está na outbox (§11.6).
 * - Subs antigos são descartados e refeitos no bump (4b, 4c).
 * - `evStale` exige resync (queries refeitas) (A14, §15.1 janela 256).
 */
export class IpcClient {
  #port: IpcPort | null = null;
  #epoch = 0;
  #nextId = 1;
  readonly #pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; cmd: string; timer: ReturnType<typeof setTimeout> }
  >();
  readonly #subs = new Map<
    number,
    { topic: string; filter?: unknown; handler: (data: unknown) => void; ultimoEvSeq: number }
  >();
  readonly #subIdToLocal = new Map<number, number>();
  /** O caminho de volta: localId → o subId que o SERVIDOR atribuiu (chega no `subOk`). */
  readonly #serverSubIdByLocal = new Map<number, number>();
  /** Unsub pedido antes do `subOk` chegar — o unsub real sai quando o subId existir. */
  readonly #unsubPendente = new Set<number>();
  #nextLocalSubId = 1;
  readonly #helloWaiters: HelloWaiter[] = [];

  get epoch(): number {
    return this.#epoch;
  }

  attach(port: IpcPort): void {
    this.#port = port;
    port.onMessage((frame) => this.#handleFrame(frame));
  }

  /** Chamado pelo preload quando o main notifica novo epoch via `core-epoch` (§15.2). */
  handleCoreEpoch(newEpoch: number): void {
    if (newEpoch <= this.#epoch) return;
    this.#epoch = newEpoch;
    // §15.2 4a: falha TODAS as requests em voo com E_CORE_RESTARTED
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(Object.assign(new Error('Núcleo reiniciado'), { code: 'E_CORE_RESTARTED', epoch: newEpoch }));
    }
    this.#pending.clear();
    // §15.2 4b: descarta todos os subId antigos
    this.#subIdToLocal.clear();
    this.#serverSubIdByLocal.clear();
    this.#unsubPendente.clear();
    // O renderer deve refazer assinaturas e queries (4c, 4d) — expõe evento
    // O consumidor da classe deve ouvir `onCoreRestart` e re-subscrever.
    this.#onCoreRestart?.(newEpoch);
  }

  #onCoreRestart: ((epoch: number) => void) | null = null;
  onCoreRestart(listener: (epoch: number) => void): void {
    this.#onCoreRestart = listener;
  }

  waitForHello(timeoutMs = 30_000): Promise<Extract<IpcFrame, { t: 'hello' }>> {
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (hello: Extract<IpcFrame, { t: 'hello' }>) => {
          clearTimeout(waiter.timer);
          this.#removerWaiter(waiter);
          resolve(hello);
        },
        reject: (e: Error) => {
          this.#removerWaiter(waiter);
          reject(e);
        },
        timer: null as unknown as ReturnType<typeof setTimeout>,
      };
      // Fila, não slot único: um segundo `waitForHello` enquanto o primeiro pendura
      // substituía o resolver e a primeira promessa só saía pelo próprio timer.
      waiter.timer = setTimeout(() => {
        this.#removerWaiter(waiter);
        reject(new Error('timeout esperando hello'));
      }, timeoutMs);
      this.#helloWaiters.push(waiter);
    });
  }

  #removerWaiter(waiter: HelloWaiter): void {
    const i = this.#helloWaiters.indexOf(waiter);
    if (i >= 0) this.#helloWaiters.splice(i, 1);
  }

  request(cmd: string, arg: unknown, authToken?: string): Promise<unknown> {
    if (this.#port === null) return Promise.reject(Object.assign(new Error('IPC-R não conectado'), { code: 'E_NO_PORT' }));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      // §15.4 — ops ⏱ têm 30 s. O timer vive DENTRO do registro pendente e é limpo em
      // TODO caminho de saída (resposta, epoch bump) — deixá-lo vazava handle por request.
      const timer = setTimeout(() => {
        if (this.#pending.delete(id)) {
          reject(Object.assign(new Error(`timeout em ${cmd}`), { code: 'E_TIMEOUT' }));
        }
      }, 30_000);
      this.#pending.set(id, { resolve, reject, cmd, timer });
      this.#port!.postMessage({
        t: 'req',
        epoch: this.#epoch,
        id,
        cmd,
        arg,
        ...(authToken !== undefined ? { authToken } : {}),
      });
    });
  }

  subscribe(topic: string, handler: (data: unknown) => void, filter?: unknown): number {    if (this.#port === null) throw Object.assign(new Error('IPC-R não conectado'), { code: 'E_NO_PORT' });
    const localId = this.#nextLocalSubId++;
    const reqId = this.#nextId++;
    this.#subs.set(localId, { topic, filter, handler, ultimoEvSeq: 0 });
    // Envia sub com epoch corrente; o servidor responderá com subId
    this.#port.postMessage({ t: 'sub', epoch: this.#epoch, id: reqId, topic, filter });
    // Mapeia reqId → localId para quando subOk chegar
    this.#subIdToLocal.set(reqId, localId);
    return localId;
  }

  unsubscribe(localId: number): void {
    const sub = this.#subs.get(localId);
    if (sub === undefined || this.#port === null) return;
    this.#subs.delete(localId);
    // O servidor conhece a assinatura pelo subId DELE (que chega no `subOk`), não pelo
    // localId. Mandar o localId apagava a entrada ERRADA — a assinatura órfã continuava
    // recebendo `ev` sem `evAck` até a janela de §15.1 estourar e o `evStale` matá-la
    // para sempre no servidor.
    const serverSubId = this.#serverSubIdByLocal.get(localId);
    if (serverSubId === undefined) {
      // O `subOk` ainda não voltou: lembrar de desinscrever quando ele chegar.
      this.#unsubPendente.add(localId);
      return;
    }
    this.#serverSubIdByLocal.delete(localId);
    this.#port.postMessage({ t: 'unsub', epoch: this.#epoch, subId: serverSubId });
  }

  #handleFrame(frame: IpcFrame): void {
    if (frame.t === 'hello') {
      // Hello pode vir com epoch maior que o corrente — atualiza e dispara G6 se necessário
      if (frame.epoch > this.#epoch) {
        this.handleCoreEpoch(frame.epoch);
      } else {
        this.#epoch = frame.epoch;
      }
      for (const w of this.#helloWaiters.splice(0)) w.resolve(frame);
      return;
    }
    // §15.1: quadro com epoch diferente é DESCARTADO sem resposta (exceto hello)
    if ((frame as { epoch?: number }).epoch !== this.#epoch) {
      return;
    }
    switch (frame.t) {
      case 'res': {
        const p = this.#pending.get(frame.id);
        if (p === undefined) return;
        this.#pending.delete(frame.id);
        clearTimeout(p.timer);
        if (frame.ok) p.resolve(frame.data);
        else p.reject(Object.assign(new Error(frame.err?.message ?? 'erro'), { code: frame.err?.code ?? 'E_INTERNAL', field: frame.err?.field, details: frame.err?.details, retryAfterMs: frame.err?.retryAfterMs }));
        break;
      }
      case 'subOk': {
        const localId = this.#subIdToLocal.get(frame.id);
        if (localId !== undefined) {
          this.#subIdToLocal.delete(frame.id);
          this.#subIdToLocal.set(frame.subId, localId);
          if (this.#unsubPendente.delete(localId)) {
            // O unsub chegou antes do `subOk`: agora que existe o que desinscrever, sai.
            this.#port?.postMessage({ t: 'unsub', epoch: this.#epoch, subId: frame.subId });
          } else {
            this.#serverSubIdByLocal.set(localId, frame.subId);
          }
        }
        break;
      }
      case 'ev': {
        const localId = this.#subIdToLocal.get(frame.subId);
        const sub = localId !== undefined ? this.#subs.get(localId) : undefined;
        if (sub !== undefined) {
          if (frame.evSeq > sub.ultimoEvSeq) sub.ultimoEvSeq = frame.evSeq;
          sub.handler(frame.data);
          // Controle de fluxo: envia evAck (§15.1 janela 256)
          this.#port?.postMessage({ t: 'evAck', epoch: this.#epoch, subId: frame.subId, evSeq: frame.evSeq });
        }
        break;
      }
      case 'evStale': {
        const localId = this.#subIdToLocal.get(frame.subId);
        const sub = localId !== undefined ? this.#subs.get(localId) : undefined;
        if (sub !== undefined) {
          // §15.1(5) — a assinatura stale obriga a DUAS coisas: (a) refazer a query, que é
          // do consumidor, e (b) mandar `evAck` com o último `evSeq` recebido, que é daqui.
          // Sem (b) o núcleo nunca retoma a emissão e a assinatura fica morta pelo resto do
          // epoch — a UI daquele tópico congela sem erro nenhum. Deixar (b) por conta de
          // quem escuta `onStale` era confiar o controle de fluxo do protocolo a um
          // listener opcional.
          // O ack cobre a faixa ANUNCIADA, não só o que chegou: os descartados consumiram
          // `evSeq` (é o buraco que denuncia a perda), então confirmar apenas o último
          // recebido deixaria a janela cheia para sempre. Cobrir `toSeq` é o que a re-query
          // do consumidor já tornou verdadeiro — evento é sinal para reconsultar, nunca
          // fonte de verdade (§15.1(5), emenda de 2026-09-05).
          sub.ultimoEvSeq = Math.max(sub.ultimoEvSeq, frame.toSeq);
          this.#onStale?.(frame.subId, frame);
          this.#port?.postMessage({
            t: 'evAck',
            epoch: this.#epoch,
            subId: frame.subId,
            evSeq: sub.ultimoEvSeq,
          });
        }
        break;
      }
      default:
        break;
    }
  }

  #onStale: ((subId: number, frame: Extract<IpcFrame, { t: 'evStale' }>) => void) | null = null;
  onStale(listener: (subId: number, frame: Extract<IpcFrame, { t: 'evStale' }>) => void): void {
    this.#onStale = listener;
  }
}

export class MemoryIpcPort implements IpcPort {
  #other: MemoryIpcPort | null = null;
  readonly #listeners: Array<(frame: IpcFrame) => void> = [];

  static createPair(): [MemoryIpcPort, MemoryIpcPort] {
    const a = new MemoryIpcPort();
    const b = new MemoryIpcPort();
    a.#other = b;
    b.#other = a;
    return [a, b];
  }

  postMessage(frame: IpcFrame): void {
    if (this.#other === null) return;
    queueMicrotask(() => {
      for (const listener of this.#other!.#listeners) {
        listener(frame);
      }
    });
  }

  onMessage(listener: (frame: IpcFrame) => void): void {
    this.#listeners.push(listener);
  }
}
