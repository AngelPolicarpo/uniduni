/**
 * `IpcClient` — lado renderer de IPC-R (§15.1, §15.2).
 *
 * **Por que este cliente vive aqui e não vem de `core/`.** O núcleo já tem um `IpcClient`
 * em `core/src/l3/ipcRenderer/index.ts`, mas ele existe para os rigs do próprio núcleo:
 * fala com um `MemoryIpcPort` (`onMessage(listener)`), mora num pacote ESM sem `exports`
 * cujo build atravessa a barreira de camadas de §4, e traz junto o `IpcServer`. Uma
 * dependência `file:../core` faria o build do Vite depender do artefato de `core/dist` e
 * arrastaria L0..L2 para o grafo do renderer — acoplamento que a fronteira de §4 existe
 * justamente para não ter. O contrato compartilhado é o **quadro** de §15.1, não a classe;
 * este arquivo implementa o mesmo quadro sobre o `MessagePort` real que o preload
 * transfere. (Decisão de 2026-08-23, §58.)
 *
 * O que o cliente garante, e a store não precisa refazer:
 *
 * - `epoch` corrente; quadro com epoch diferente é descartado, exceto `hello` (§15.1 r. 1).
 * - No bump de epoch (§15.2 passo 4): (a) toda request em voo falha com `E_CORE_RESTARTED`
 *   e **nenhuma** é reenviada — escrita está na outbox (§11.6); (b) os `subId` antigos são
 *   descartados; (c) as assinaturas são refeitas a partir da lista declarativa que o
 *   cliente mantém, **na porta do núcleo novo**. Refazer as **queries** (4d) é do
 *   consumidor: só ele sabe quais estão ativas — é o que `onResync` entrega.
 * - `evAck` a cada evento e `evStale` → `onResync`, porque evento é sinal para reconsultar
 *   e nunca fonte de verdade (§15.1 r. 5). O `evSeq` é conferido por `subId`: quadro
 *   repetido ou atrasado não é despachado, e buraco na numeração é perda (§15.1 r. 3/5).
 *
 * **O aviso do main chega ANTES da porta nova, e é assim por construção** (§15.2, emenda de
 * 2026-09-06). O main sabe do epoch novo no `exit` do `utilityProcess`; a porta só existe
 * depois do backoff de 1 s/4 s/10 s e do `hello` do processo novo. Por isso o bump tem duas
 * metades aqui: `handleCoreEpoch` **desliga** (falha pendentes, larga a porta morta, avisa
 * `onDesconectado`) e o `hello` do núcleo novo **religa** (reassina e pede o resync). Fazer
 * as duas na primeira metade era mandar `sub` por uma porta neuterada e nunca mais reassinar
 * — o `hello` seguinte vinha com o epoch que o cliente já tinha e não disparava nada.
 */

import {
  IpcCommandError,
  type FrameFromCore,
  type FrameToCore,
  type RendererPort,
} from "./frames";

/** §15.1 r. 6 — default 10 s; as ⏱ de §15.4 pedem 30 s explicitamente. */
export const TIMEOUT_PADRAO_MS = 10_000;
export const TIMEOUT_HOST_MS = 30_000;

/** Por que o cliente pediu resync: o consumidor decide o quanto refazer. */
export type MotivoDeResync =
  | { readonly tipo: "epoch"; readonly epoch: number }
  | { readonly tipo: "stale"; readonly topic: string; readonly dropped: number };

interface Pendente {
  readonly cmd: string;
  readonly resolve: (v: unknown) => void;
  readonly reject: (e: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface Assinatura {
  readonly topic: string;
  readonly filter: unknown;
  readonly handler: (data: unknown) => void;
  /** `subId` do núcleo; ausente entre o `sub` e o `subOk` — e depois de um bump. */
  subId: number | undefined;
  /** `id` do `sub` em voo, para casar o `subOk`. */
  reqId: number | undefined;
  /**
   * Último `evSeq` DESPACHADO desta assinatura (§15.1 r. 3). Zera junto com o `subId`: o
   * `subId` do núcleo novo recomeça a numeração.
   */
  ultimoSeq: number;
}

export class IpcClient {
  #port: RendererPort | null = null;
  #epoch = 0;
  #proximoId = 1;
  #proximoLocal = 1;
  readonly #pendentes = new Map<number, Pendente>();
  readonly #assinaturas = new Map<number, Assinatura>();
  #resolverHello: ((h: Extract<FrameFromCore, { t: "hello" }>) => void) | null = null;
  #timerHello: ReturnType<typeof setTimeout> | null = null;
  #onResync: ((motivo: MotivoDeResync) => void) | null = null;
  #onDesconectado: ((epoch: number) => void) | null = null;
  /**
   * O epoch já subiu, mas a porta do núcleo novo ainda não chegou: as assinaturas estão
   * pendentes e o `hello` que vier com ESTE epoch é quem as dispara. Sem esta marca, o
   * `hello` de epoch igual ao corrente não fazia nada e as assinaturas ficavam perdidas.
   */
  #reassinaturaPendente = false;

  get epoch(): number {
    return this.#epoch;
  }

  get conectado(): boolean {
    return this.#port !== null;
  }

  /**
   * Liga o cliente à porta transferida. Uma porta NOVA chega a cada núcleo novo: os
   * `subId` do núcleo anterior não valem mais, e as assinaturas declaradas são reenviadas
   * assim que o `hello` fixar o epoch.
   */
  attach(port: RendererPort): void {
    // Idempotente: a mesma porta chega duas vezes na partida fria (a guardada no módulo e
    // a que `esperarPorta` resolve), e anexá-la de novo duplicaria TODO quadro recebido.
    if (this.#port === port) return;
    this.#port = port;
    port.addEventListener("message", (ev) => {
      this.#receber(ev.data as FrameFromCore);
    });
    port.start?.();
  }

  onResync(listener: (motivo: MotivoDeResync) => void): void {
    this.#onResync = listener;
  }

  /**
   * §15.2 4e — o núcleo caiu e o canal ficou sem porta. Serve para a UI entrar em
   * `conn-reconnecting` NA HORA, sem esperar o núcleo novo: entre o `exit` e o `hello` do
   * respawn passam até 10 s de backoff, e consultar nesse intervalo é falar com uma porta
   * morta. O resync de epoch (4d) sai só depois, pelo `onResync`.
   */
  onDesconectado(listener: (epoch: number) => void): void {
    this.#onDesconectado = listener;
  }

  waitForHello(timeoutMs = TIMEOUT_HOST_MS): Promise<Extract<FrameFromCore, { t: "hello" }>> {
    return new Promise((resolve, reject) => {
      this.#timerHello = setTimeout(() => {
        this.#resolverHello = null;
        this.#timerHello = null;
        reject(new Error("tempo esgotado esperando o hello do núcleo"));
      }, timeoutMs);
      this.#resolverHello = (h) => {
        if (this.#timerHello !== null) clearTimeout(this.#timerHello);
        this.#timerHello = null;
        this.#resolverHello = null;
        resolve(h);
      };
    });
  }

  /**
   * §15.2 4a/4b — o main anunciou epoch novo (`core-epoch`) ou o `core.restarted` chegou.
   * Idempotente: o segundo aviso do mesmo epoch é ignorado, senão o resync aconteceria
   * duas vezes por reinício.
   *
   * NÃO reassina aqui: neste instante a única porta que o cliente tem é a do núcleo morto
   * (o respawn ainda está no backoff de §3.3). Reassinar nela mandava `sub` para o vazio e
   * gastava o bump, deixando o `hello` do núcleo novo — que vem com o MESMO epoch — sem
   * nada a disparar. Quem reassina é o `hello`; ver `#religar`.
   */
  handleCoreEpoch(novoEpoch: number): void {
    if (novoEpoch <= this.#epoch) return;
    this.#epoch = novoEpoch;
    this.#falharPendentes();
    this.#soltarAssinaturas();
    // A porta transferida morreu com o processo: largá-la é o que faz uma request na janela
    // de reconexão falhar NA HORA com `E_NO_PORT`, em vez de esperar 10 s por um `res` que
    // não vem e virar `E_TIMEOUT` — foi esse timeout que travava a sessão em "falhou".
    this.#port = null;
    this.#reassinaturaPendente = true;
    this.#onDesconectado?.(novoEpoch);
  }

  #falharPendentes(): void {
    for (const p of this.#pendentes.values()) {
      clearTimeout(p.timer);
      p.reject(
        new IpcCommandError({
          code: "E_CORE_RESTARTED",
          message: "O núcleo reiniciou; a ação em voo não foi reenviada",
        }),
      );
    }
    this.#pendentes.clear();
  }

  #soltarAssinaturas(): void {
    for (const a of this.#assinaturas.values()) {
      a.subId = undefined;
      a.reqId = undefined;
      a.ultimoSeq = 0;
    }
  }

  /**
   * §15.2 4c/4d — há porta viva e o `hello` fixou o epoch: as assinaturas saem de novo e o
   * consumidor refaz as queries ativas.
   */
  #religar(epoch: number): void {
    this.#reassinaturaPendente = false;
    this.#reassinar();
    this.#onResync?.({ tipo: "epoch", epoch });
  }

  request(cmd: string, arg: unknown = {}, authToken?: string, timeoutMs = TIMEOUT_PADRAO_MS): Promise<unknown> {
    const port = this.#port;
    if (port === null) {
      return Promise.reject(new IpcCommandError({ code: "E_NO_PORT", message: "IPC-R não conectado" }));
    }
    const id = this.#proximoId++;
    return new Promise((resolve, reject) => {
      // O handle vive DENTRO do registro pendente e some em todo desfecho — resposta,
      // bump de epoch ou o próprio estouro (lição de §57).
      const timer = setTimeout(() => {
        if (this.#pendentes.delete(id)) {
          reject(new IpcCommandError({ code: "E_TIMEOUT", message: `Tempo esgotado em ${cmd}` }));
        }
      }, timeoutMs);
      this.#pendentes.set(id, { cmd, resolve, reject, timer });
      port.postMessage({
        t: "req",
        epoch: this.#epoch,
        id,
        cmd,
        arg,
        ...(authToken !== undefined ? { authToken } : {}),
      });
    });
  }

  /**
   * Assinatura declarativa: o retorno é um id LOCAL, estável através de reinícios do
   * núcleo. É o que permite ao cliente refazer a assinatura sozinho no bump sem que a
   * store guarde `subId` de servidor (§15.2 4c).
   */
  subscribe(topic: string, handler: (data: unknown) => void, filter?: unknown): number {
    const local = this.#proximoLocal++;
    this.#assinaturas.set(local, { topic, filter, handler, subId: undefined, reqId: undefined, ultimoSeq: 0 });
    this.#enviarSub(local);
    return local;
  }

  unsubscribe(local: number): void {
    const a = this.#assinaturas.get(local);
    if (a === undefined) return;
    this.#assinaturas.delete(local);
    // Sem `subId` do núcleo não há o que cancelar no outro lado: ou o `subOk` ainda não
    // chegou, ou o núcleo que o emitiu já morreu. Inventar um número aqui cancelaria a
    // assinatura de outra tela.
    if (a.subId !== undefined) {
      this.#port?.postMessage({ t: "unsub", epoch: this.#epoch, subId: a.subId });
    }
  }

  #enviarSub(local: number): void {
    const a = this.#assinaturas.get(local);
    if (a === undefined || this.#port === null) return;
    const reqId = this.#proximoId++;
    a.reqId = reqId;
    const frame: FrameToCore = { t: "sub", epoch: this.#epoch, id: reqId, topic: a.topic };
    this.#port.postMessage(a.filter === undefined ? frame : { ...frame, filter: a.filter });
  }

  #reassinar(): void {
    for (const local of this.#assinaturas.keys()) this.#enviarSub(local);
  }

  #assinaturaDe(subId: number): Assinatura | undefined {
    for (const a of this.#assinaturas.values()) if (a.subId === subId) return a;
    return undefined;
  }

  #receber(frame: FrameFromCore): void {
    if (frame === null || typeof frame !== "object") return;
    if (frame.t === "hello") {
      if (this.#epoch === 0) {
        // Primeiro `hello` do canal: não houve reinício, não há pendente a falhar — só as
        // assinaturas declaradas antes da porta existir precisam sair agora. O resync de
        // §15.2 4d não sai daqui: quem carrega o primeiro lote é o boot da sessão.
        this.#epoch = frame.epoch;
        this.#reassinaturaPendente = false;
        this.#reassinar();
      } else if (frame.epoch > this.#epoch) {
        // Núcleo novo cujo `hello` chegou ANTES do aviso do main. A porta por onde ele
        // chegou está viva: desligar e religar na mesma volta.
        this.#epoch = frame.epoch;
        this.#falharPendentes();
        this.#soltarAssinaturas();
        this.#onDesconectado?.(frame.epoch);
        this.#religar(frame.epoch);
      } else if (frame.epoch === this.#epoch && this.#reassinaturaPendente) {
        // O caminho normal do respawn: o main avisou o epoch primeiro, e é este `hello` —
        // na porta nova — que prova que existe núcleo para reassinar.
        this.#religar(frame.epoch);
      }
      this.#resolverHello?.(frame);
      return;
    }
    // §15.1 r. 1 — quadro de outro epoch é descartado sem resposta.
    if (frame.epoch !== this.#epoch) return;
    switch (frame.t) {
      case "res": {
        const p = this.#pendentes.get(frame.id);
        if (p === undefined) return;
        this.#pendentes.delete(frame.id);
        clearTimeout(p.timer);
        if (frame.ok) p.resolve(frame.data ?? {});
        else p.reject(new IpcCommandError(frame.err));
        return;
      }
      case "subOk": {
        for (const a of this.#assinaturas.values()) {
          if (a.reqId === frame.id) {
            a.reqId = undefined;
            a.subId = frame.subId;
            // `subId` novo recomeça a numeração de `evSeq` (§15.1 r. 3).
            a.ultimoSeq = 0;
            return;
          }
        }
        // `subOk` de assinatura já cancelada: cancela do outro lado, senão o núcleo
        // continuaria emitindo para um `subId` que ninguém escuta.
        this.#port?.postMessage({ t: "unsub", epoch: this.#epoch, subId: frame.subId });
        return;
      }
      case "ev": {
        const a = this.#assinaturaDe(frame.subId);
        // §15.1 r. 3 — `evSeq` é monotônico por `subId`, e é o cliente quem confere.
        // Quadro repetido ou atrasado NÃO é despachado: aplicar 70 % depois de 100 % era
        // regredir a barra de download por reordenação do despacho. Continua sendo
        // confirmado, senão a janela de §15.1 r. 4 nunca fecharia.
        if (a !== undefined && frame.evSeq > a.ultimoSeq) {
          // Buraco na numeração é perda (§15.1 r. 5, emenda de 2026-09-05: o descarte
          // consome `evSeq`). Reconsultar aqui é o que fecha a metade da detecção que o
          // renderer devia — o `evStale` do núcleo só chega 3 s depois, e há perda que
          // nunca vira `stale`.
          const perdidos = a.ultimoSeq > 0 ? frame.evSeq - a.ultimoSeq - 1 : 0;
          a.ultimoSeq = frame.evSeq;
          a.handler(frame.data);
          if (perdidos > 0) this.#onResync?.({ tipo: "stale", topic: a.topic, dropped: perdidos });
        }
        this.#port?.postMessage({ t: "evAck", epoch: this.#epoch, subId: frame.subId, evSeq: frame.evSeq });
        return;
      }
      case "evStale": {
        // §15.1 r. 5 — as duas obrigações: confirmar a FAIXA anunciada (`toSeq`) para o
        // núcleo voltar a emitir, e refazer a query correspondente.
        this.#port?.postMessage({ t: "evAck", epoch: this.#epoch, subId: frame.subId, evSeq: frame.toSeq });
        const a = this.#assinaturaDe(frame.subId);
        // A faixa perdida foi reconhecida: o próximo `ev` continua de `toSeq + 1` e não
        // deve ser lido como buraco novo — a re-query abaixo já cobre o que caiu.
        if (a !== undefined && frame.toSeq > a.ultimoSeq) a.ultimoSeq = frame.toSeq;
        this.#onResync?.({ tipo: "stale", topic: a?.topic ?? "", dropped: frame.dropped });
        return;
      }
      default:
        return;
    }
  }
}
