// §17.3 — a porta de transporte relayado de uma alocação TURN (RFC 5766 §5).
//
// **A lacuna que este arquivo fecha, e por que ela não era óbvia.** §17.3 manda o host
// servir TURN e diz de onde sai o endereço do *serviço* ("o endereço público do host é
// obtido do próprio `hyperdht`"). Ela não diz nada sobre o endereço **relayado** — o
// `XOR-RELAYED-ADDRESS` que o Allocate devolve e que o par do outro lado vai usar como
// destino. E os dois não são o mesmo endereço: RFC 5766 §5 exige uma porta relayada
// própria por alocação, e uma socket UDP nova, atrás de NAT, tem um mapeamento externo que
// **o host não conhece**. A socket do DHT é a única cujo mapeamento ele conhece, porque o
// próprio `hyperdht` o descobre e o mantém vivo.
//
// O G7 não pegou isto: `poc/poc-08-g7/src/turnServer.ts` liga a socket relayada em
// `127.0.0.1:0` e anuncia loopback, com o NAT emulado em user-space no mesmo processo. Ali
// o endereço anunciado é sempre alcançável por construção. Em rede real não é.
//
// **A decisão (operador, 2026-08-28).** A socket relayada é nova, por alocação — RFC 5766
// como escrito —, e o host descobre o mapeamento externo **dela** mandando um Binding RFC
// 5389 ao STUN de terceiro, que desde a emenda de 2026-08-25 de §17.2 vem ligado por
// default. Três consequências que precisam estar escritas:
//
//   1. O terceiro passa a ver o IP **do host**, não só o de quem entra em chamada. O custo
//      de privacidade é nulo: o host já publica esse mesmo IP na DHT, que é onde a
//      comunidade inteira o encontra.
//   2. `P2P_STUN_SERVERS=""` desliga a descoberta junto com o resto. Sem terceiro e atrás
//      de NAT, `abrirPortaDeRelay` recusa e o Allocate volta a 508 — o mesmo desfecho de
//      antes desta fatia, agora por um motivo medido em vez de `E_NOT_IMPLEMENTED`.
//   3. NAT simétrico **no host** faz o mapeamento observado pelo terceiro valer só para o
//      terceiro. O endereço anunciado não serve para mais ninguém e o caminho relayado não
//      fecha. Isso é a L-11 já declarada em §17.3, e é a razão de §17.7 existir.
//
// **O primer.** Descobrir o mapeamento não basta: sob NAT restrito por porta, o par só
// consegue mandar para ele depois que o host mandou alguma coisa para o par. Quem sabe o
// endereço do par é o `CreatePermission` (RFC 5766 §9 ignora a porta para casar permissão,
// mas ela **vem** no `XOR-PEER-ADDRESS`), então é de lá que o `MediaServer` chama `send`
// com um byte. Um datagrama de 1 byte não é STUN, não é ChannelData e não é DTLS: o agente
// ICE do par o descarta. É o mesmo furo que o ICE faz, feito no momento em que o host
// aprende para quem furar.

import dgram from 'node:dgram';

import {
  BINDING_SUCCESS,
  decode,
  encodeBindingRequest,
  randomTxId,
  type MediaAddr,
  type RelayPort,
} from '../l2/communityHost/stunTurn.ts';

/** Datagrama de 1 byte que abre o mapeamento sem dizer nada a quem o recebe. */
export const RELAY_PRIMER = new Uint8Array([0]);

/** Intervalo do keepalive do mapeamento — abaixo do menor UDP timeout usual de NAT (30 s). */
const KEEPALIVE_MS = 25_000;

/** Prazo de uma tentativa de Binding; três tentativas cabem no orçamento total. */
const TENTATIVA_MS = 500;

export type PortaDeRelayOptions = {
  /** `stun:host:porta` de §27.2 — a lista de §17.2, na ordem em que foi configurada. */
  readonly stunServers: readonly string[];
  /** Teto total da descoberta. Estourado, a porta recusa em vez de anunciar um palpite. */
  readonly budgetMs?: number;
};

/** `stun:host:porta` → endereço; `null` para o que o parser de §17.2 não reconhece. */
export function enderecoDoStun(url: string): MediaAddr | null {
  const m = /^stuns?:(?:\/\/)?\[?([^\]/?#]+?)\]?(?::(\d+))?$/i.exec(url.trim());
  if (m === null) return null;
  const host = m[1];
  if (host === undefined || host.length === 0) return null;
  return { host, port: m[2] === undefined ? 3478 : Number.parseInt(m[2], 10) };
}

/**
 * Pergunta a um STUN de terceiro qual é o mapeamento externo **desta** socket. Resolve
 * `null` quando ninguém responde dentro do prazo — nunca inventa endereço.
 */
function descobrirMapeamento(
  socket: dgram.Socket,
  servidor: MediaAddr,
  prazoMs: number,
): Promise<MediaAddr | null> {
  return new Promise((resolve) => {
    const txId = randomTxId();
    let pronto = false;
    const terminar = (addr: MediaAddr | null): void => {
      if (pronto) return;
      pronto = true;
      clearTimeout(timer);
      socket.removeListener('message', ouvir);
      resolve(addr);
    };
    const ouvir = (data: Buffer): void => {
      const dec = decode(data);
      if (dec === null || dec.type !== BINDING_SUCCESS || !dec.txId.equals(txId)) return;
      terminar(dec.xorMapped ?? null);
    };
    const timer = setTimeout(() => terminar(null), prazoMs);
    timer.unref?.();
    socket.on('message', ouvir);
    socket.send(encodeBindingRequest(txId), servidor.port, servidor.host, (err) => {
      if (err !== null && err !== undefined) terminar(null);
    });
  });
}

/**
 * Abre a socket relayada de uma alocação e devolve a `RelayPort` de §17.3 já com o
 * endereço externo descoberto. Rejeita quando não há como anunciar um endereço honesto —
 * quem chama traduz isso no 508 de RFC 5766.
 */
export async function abrirPortaDeRelay(opts: PortaDeRelayOptions): Promise<RelayPort> {
  const servidores = opts.stunServers.map(enderecoDoStun).filter((a): a is MediaAddr => a !== null);
  if (servidores.length === 0) {
    throw Object.assign(new Error('sem STUN para descobrir o mapeamento da porta de relay (§17.3)'), {
      code: 'E_NO_MAPPING',
    });
  }

  // Referenciada **durante a descoberta** e solta depois: uma socket de relay não pode
  // segurar o processo aberto no fechamento (§18.7), mas soltá-la antes de o Binding
  // voltar deixaria a descoberta correndo num loop que já pode esvaziar.
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      try {
        socket.close();
      } catch {}
      reject(err);
    };
    socket.once('error', onError);
    socket.bind(0, '0.0.0.0', () => {
      socket.removeListener('error', onError);
      resolve();
    });
  });
  // Erro de socket depois do bind é a rede sumindo, não exceção de programa: um `ICMP port
  // unreachable` de um par que fechou não pode derrubar o processo do host.
  socket.on('error', () => {});

  const tentativaMs = TENTATIVA_MS;
  const deadline = Date.now() + (opts.budgetMs ?? Math.max(servidores.length * tentativaMs, 3 * tentativaMs));
  let externo: MediaAddr | null = null;
  let usado: MediaAddr | null = null;
  while (externo === null && Date.now() < deadline) {
    let tentouAlgum = false;
    for (const servidor of servidores) {
      if (Date.now() >= deadline) break;
      tentouAlgum = true;
      const timeout = Math.min(tentativaMs, Math.max(100, deadline - Date.now()));
      externo = await descobrirMapeamento(socket, servidor, timeout);
      if (externo !== null) {
        usado = servidor;
        break;
      }
    }
    if (!tentouAlgum) break;
  }
  if (externo === null || usado === null) {
    socket.close();
    throw Object.assign(new Error('nenhum STUN respondeu o mapeamento da porta de relay (§17.3, L-11)'), {
      code: 'E_NO_MAPPING',
    });
  }

  // O mapeamento morre por inatividade muito antes do `TURN_ALLOC_TTL_MS` de 10 min. O
  // keepalive é o mesmo Binding: mantém a tradução viva e, de quebra, é o único ponto em
  // que uma troca de mapeamento seria visível.
  const servidorVivo = usado;
  const keepalive = setInterval(() => {
    void descobrirMapeamento(socket, servidorVivo, TENTATIVA_MS);
  }, KEEPALIVE_MS);
  keepalive.unref?.();
  socket.unref();

  let entregar: ((data: Uint8Array, from: MediaAddr) => void) | null = null;
  socket.on('message', (data, rinfo) => {
    // Resposta do keepalive não é tráfego de par: ela chega do servidor que descobriu o
    // mapeamento e seria repassada ao cliente como se fosse mídia.
    if (rinfo.address === servidorVivo.host && rinfo.port === servidorVivo.port) return;
    entregar?.(new Uint8Array(data), { host: rinfo.address, port: rinfo.port });
  });

  let fechada = false;
  return {
    addr: externo,
    send(datagram: Uint8Array, addr: MediaAddr): void {
      if (fechada) return;
      try {
        socket.send(Buffer.from(datagram), addr.port, addr.host);
      } catch {
        // Socket fechando: perder um datagrama UDP é o comportamento do meio, não erro.
      }
    },
    onData(cb: (data: Uint8Array, from: MediaAddr) => void): void {
      entregar = cb;
    },
    close(): void {
      if (fechada) return;
      fechada = true;
      clearInterval(keepalive);
      entregar = null;
      try {
        socket.close();
      } catch {
        // já fechada
      }
    },
  };
}

// ─── §15.4 `diag.run` — a sonda STUN sobre a socket real (B11) ──────────────────────────

/**
 * Manda um Binding RFC 5389 pela socket de §17.3 — **a mesma** que o UDX usa e que o par do
 * outro lado alcança — e resolve `true` se a resposta voltar no prazo.
 *
 * A socket importa. "O STUN responde a esta máquina" e "o STUN responde à socket que
 * carrega a minha mídia" são afirmações diferentes, e só a segunda diz algo sobre a chamada
 * que vai acontecer: é o mapeamento DESTA socket que vira candidato `srflx`.
 *
 * Vale para quem hospeda e para quem não hospeda: a sonda instala o próprio classificador
 * por cima do que estiver na socket e o retira ao terminar. Nunca rejeita — §15.4 não
 * cataloga erro para `diag.run`, e o desfecho de falha é o pior caso (`false`).
 */
export async function sondarStun(
  tap: {
    send(datagram: Uint8Array, addr: MediaAddr): void;
    tap(handler: (data: Buffer, addr: { host: string; port: number }) => boolean): () => void;
  },
  stunServers: readonly string[],
  timeoutMs = 2_000,
): Promise<boolean> {
  const servidor = stunServers.map(enderecoDoStun).find((a): a is MediaAddr => a !== null);
  if (servidor === undefined) return false;

  const txId = randomTxId();
  return new Promise<boolean>((resolve) => {
    let pronto = false;
    const terminar = (ok: boolean): void => {
      if (pronto) return;
      pronto = true;
      clearTimeout(timer);
      desinstalar();
      resolve(ok);
    };
    const timer = setTimeout(() => terminar(false), timeoutMs);
    timer.unref?.();
    // `true` consome o datagrama; `false` devolve ao que já estava na socket (o
    // `MediaServer` do host, quando ele existe, e depois dele o próprio DHT).
    const desinstalar = tap.tap((data) => {
      const dec = decode(data);
      if (dec === null || dec.type !== BINDING_SUCCESS || !dec.txId.equals(txId)) return false;
      terminar(dec.xorMapped !== undefined);
      return true;
    });
    try {
      tap.send(encodeBindingRequest(txId), servidor);
    } catch {
      terminar(false);
    }
  });
}
