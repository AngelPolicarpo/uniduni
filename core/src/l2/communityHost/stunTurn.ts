// STUN e TURN comunitários do host — §17.3, A17 (fase 7).
//
// §4: o `communityHost` é quem serve STUN/TURN ("fila de admissão, append, DS de host,
// roster, STUN/TURN"). A socket UDP compartilhada com o UDX é uma **porta** injetada por
// L3 (`MediaSocketPort`/`RelayPort`): este módulo nunca importa transporte.
//
// Decisões já validadas pelo G7 (poc/poc-08-g7/out/gate-G7/gate-G7.json), reutilizadas
// aqui como decisões, não como código:
//   - demux na ordem ChannelData (0x40–0x7F **com Length coerente**, RFC 5766 §11.4) →
//     regra estrutural de §17.3 → resto é UDX;
//   - Binding RFC 5389 com XOR-MAPPED-ADDRESS;
//   - subconjunto TURN RFC 5766 (Allocate/Refresh/CreatePermission/Send/Data/ChannelBind)
//     com credencial long-term (MESSAGE-INTEGRITY HMAC-SHA1 sobre chave
//     MD5(username:realm:password), RFC 5389 §10.2 — interoperável com clientes WebRTC);
//   - controles: tela via TURN recusada no v1, limite por membro, permissão só roster,
//     TTL renovável enquanto a sessão viver, taxa por alocação e teto de bytes por sessão.
//
// Erros de fronteira continuam no catálogo fechado de §20.2; recusas internas do TURN são
// razões nomeadas que viram códigos RFC na resposta (401/403/437/442/486).

import crypto from 'node:crypto';

import sodium from 'sodium-native';

// ─── Constantes de codec ────────────────────────────────────────────────────────────────

export const STUN_MAGIC = 0x2112a442;
export const BINDING_REQUEST = 0x0001;
export const BINDING_SUCCESS = 0x0101;
export const TURN_ALLOCATE = 0x0003;
export const TURN_REFRESH = 0x0004;
export const TURN_CREATE_PERMISSION = 0x0008;
export const TURN_CHANNEL_BIND = 0x0009;
export const TURN_SEND = 0x0016;
export const TURN_DATA = 0x0017;

const ATTR_USERNAME = 0x0006;
const ATTR_MESSAGE_INTEGRITY = 0x0008;
const ATTR_ERROR_CODE = 0x0009;
const ATTR_XOR_PEER = 0x0012;
const ATTR_REALM = 0x0014;
const ATTR_NONCE = 0x0015;
const ATTR_XOR_MAPPED = 0x0020;
const ATTR_LIFETIME = 0x000d;
const ATTR_DATA = 0x0013;
const ATTR_XOR_RELAYED = 0x0016;
const ATTR_REQUESTED_TRANSPORT = 0x0019;
/** RFC 5766 §14.1 — CHANNEL-NUMBER. **NÃO** é 0x0006: esse é USERNAME (RFC 5389 §15.3). */
const ATTR_CHANNEL_NUMBER = 0x000c;
/** RFC 5389 §15.5 — o único atributo que pode SUCEDER o MESSAGE-INTEGRITY. */
const ATTR_FINGERPRINT = 0x8028;

const NONCE_VALID_MS = 60 * 60 * 1000;

/**
 * RFC 5766 §9 — a permissão de um par vive 5 minutos e é renovada por cada
 * `CreatePermission`/`ChannelBind` que a reafirme. O `Set` sem prazo que existia aqui
 * concedia acesso PERMANENTE ao endereço relayado até a alocação inteira vencer.
 */
const PERMISSION_LIFETIME_MS = 300_000;

/** Defaults de §27.2; a config L0 resolve os valores desta instalação. */
const DEFAULTS = {
  allocTtlMs: 600_000,
  maxAllocsPerMember: 2,
  rateKbps: 512,
  sessionMaxBytes: 2 * 1024 * 1024 * 1024,
};

export type MediaAddr = { readonly host: string; readonly port: number };

function view(buf: Uint8Array): Buffer {
  return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
}

function keyOf(addr: MediaAddr): string {
  return `${addr.host}:${addr.port}`;
}

export function randomTxId(): Buffer {
  return crypto.randomBytes(12);
}

// ─── Demux da socket compartilhada (§17.3) ──────────────────────────────────────────────

/** Regra §17.3 literal: bits `00` + magic cookie + coerência de comprimento. */
export function isStructurallyStun(buf: Uint8Array): boolean {
  if (buf.length < 20) return false;
  const b = view(buf);
  if ((b[0]! & 0xc0) !== 0) return false;
  if (b.readUInt32BE(4) !== STUN_MAGIC) return false;
  return 20 + b.readUInt16BE(2) === buf.length;
}

/**
 * ChannelData ocupa o primeiro byte 0x40–0x7F (bits `01`) — sob a regra bruta de §17.3
 * cairia no UDX; na socket compartilhada ele é roteado ao TURN antes do fallback UDX.
 * Ordem validada em G7 (C2/C3, zero desvios em corpus UDX real + adversarial).
 *
 * **O primeiro byte sozinho não classifica (emenda de 2026-09-05).** Um quarto dos
 * datagramas UDX cai nessa faixa por acaso, e o demux os dava por consumidos pelo TURN:
 * ~25 % de perda artificial em toda replicação da comunidade, indistinguível de rede ruim.
 * O que separa os dois é o campo Length do cabeçalho, que RFC 5766 §11.4 obriga a casar com
 * o datagrama ("The Length field ... MUST match the length of the UDP message minus 4"). O
 * padding a múltiplo de quatro não é exigido sobre UDP, mas **pode** vir: até 3 bytes de
 * folga são aceitos, mais que isso é UDX.
 */
export function isChannelData(buf: Uint8Array): boolean {
  if (buf.length < 4) return false;
  const b = view(buf);
  if (b[0]! < 0x40 || b[0]! > 0x7f) return false;
  const folga = buf.length - 4 - b.readUInt16BE(2);
  return folga >= 0 && folga < 4;
}

export type InboundClass = 'stun' | 'channel-data' | 'udx';

/** Classificação completa da socket compartilhada; `udx` segue para a pilha UDX. */
export function classifyInbound(buf: Uint8Array): InboundClass {
  if (isChannelData(buf)) return 'channel-data';
  return isStructurallyStun(buf) ? 'stun' : 'udx';
}

// ─── Codec STUN/TURN ────────────────────────────────────────────────────────────────────

function attr(type: number, value: Buffer): Buffer {
  const pad = (4 - (value.length % 4)) % 4;
  const head = Buffer.alloc(4);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(value.length, 2);
  return Buffer.concat([head, value, Buffer.alloc(pad)]);
}

function message(type: number, txId: Buffer, body: Buffer): Buffer {
  const head = Buffer.alloc(20);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(body.length, 2);
  head.writeUInt32BE(STUN_MAGIC, 4);
  txId.copy(head, 8);
  return Buffer.concat([head, body]);
}

function ipv4ToBuffer(host: string): Buffer | null {
  const parts = host.split('.').map((s) => Number.parseInt(s, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return Buffer.from(parts as number[]);
}

function encodeXorAddress(addr: MediaAddr): Buffer | null {
  const ip = ipv4ToBuffer(addr.host);
  if (ip === null) return null;
  const value = Buffer.alloc(8);
  value[1] = 0x01;
  value.writeUInt16BE(addr.port ^ (STUN_MAGIC >>> 16), 2);
  for (let i = 0; i < 4; i++) value[4 + i] = ip[i]! ^ ((STUN_MAGIC >>> (24 - 8 * i)) & 0xff);
  return value;
}

function decodeXorAddress(value: Buffer): MediaAddr {
  const port = value.readUInt16BE(2) ^ (STUN_MAGIC >>> 16);
  const ip: string[] = [];
  for (let i = 0; i < 4; i++) ip.push((value[4 + i]! ^ ((STUN_MAGIC >>> (24 - 8 * i)) & 0xff)).toString(10));
  return { host: ip.join('.'), port };
}

export function encodeBindingRequest(txId: Buffer = randomTxId()): Buffer {
  return message(BINDING_REQUEST, txId, Buffer.alloc(0));
}

/** Binding Success com XOR-MAPPED-ADDRESS = endereço de origem observado (RFC 5389). */
export function encodeBindingSuccess(txId: Buffer, addr: MediaAddr): Buffer | null {
  const xaddr = encodeXorAddress(addr);
  if (xaddr === null) return null;
  return message(BINDING_SUCCESS, txId, attr(ATTR_XOR_MAPPED, xaddr));
}

export interface DecodedStun {
  type: number;
  txId: Buffer;
  xorMapped?: MediaAddr;
  errorCode?: number;
  username?: string;
  realm?: string;
  nonce?: string;
  lifetimeSec?: number;
  requestedTransport?: number;
  xorPeer?: MediaAddr;
  xorRelayed?: MediaAddr;
  data?: Buffer;
  channelNumber?: number;
  hasMessageIntegrity?: boolean;
}

/** Decodifica um pacote STUN estruturalmente válido; null se malformado. */
export function decode(buf: Uint8Array): DecodedStun | null {
  if (!isStructurallyStun(buf)) return null;
  const b = view(buf);
  const type = b.readUInt16BE(0);
  const len = b.readUInt16BE(2);
  const out: DecodedStun = { type, txId: Buffer.from(b.subarray(8, 20)) };
  let off = 20;
  const end = 20 + len;
  while (off + 4 <= end) {
    const at = b.readUInt16BE(off);
    const alen = b.readUInt16BE(off + 2);
    if (off + 4 + alen > end) return null;
    const value = b.subarray(off + 4, off + 4 + alen);
    if (at === ATTR_CHANNEL_NUMBER && alen === 4) {
      // RFC 5766 §14.1 — CHANNEL-NUMBER é 0x000C, 2 B de canal + 2 B RFFU. A redação
      // anterior o lia de 0x0006 "porque compartilha o tipo com USERNAME": não compartilha,
      // 0x0006 É o USERNAME. Todo ChannelBind de cliente WebRTC real voltava 400.
      out.channelNumber = value.readUInt16BE(0);
    } else if (at === ATTR_USERNAME) {
      out.username = value.toString('utf8');
    } else if (at === ATTR_MESSAGE_INTEGRITY && alen === 20) {
      out.hasMessageIntegrity = true;
      // RFC 5389 §15.4 — nada depois do MESSAGE-INTEGRITY conta, exceto FINGERPRINT. Ler
      // adiante é aceitar atributo que o HMAC não cobre: era por onde um MITM anexava um
      // `XOR-PEER-ADDRESS` forjado na cauda de um pedido TURN legitimamente assinado.
      break;
    } else if (at === ATTR_ERROR_CODE && alen >= 4) {
      out.errorCode = value[2]! * 100 + value[3]!;
    } else if (at === ATTR_REALM) {
      out.realm = value.toString('utf8');
    } else if (at === ATTR_NONCE) {
      out.nonce = value.toString('utf8');
    } else if (at === ATTR_LIFETIME && alen === 4) {
      out.lifetimeSec = value.readUInt32BE(0);
    } else if (at === ATTR_REQUESTED_TRANSPORT && alen === 4) {
      out.requestedTransport = value[0]!;
    } else if (at === ATTR_XOR_PEER && alen >= 8 && value[1] === 0x01) {
      out.xorPeer = decodeXorAddress(value);
    } else if (at === ATTR_XOR_RELAYED && alen >= 8 && value[1] === 0x01) {
      out.xorRelayed = decodeXorAddress(value);
    } else if (at === ATTR_XOR_MAPPED && alen >= 8 && value[1] === 0x01) {
      out.xorMapped = decodeXorAddress(value);
    } else if (at === ATTR_DATA) {
      out.data = Buffer.from(value);
    }
    off += 4 + alen + ((4 - (alen % 4)) % 4);
  }
  return out;
}

// Encoders TURN (subconjunto §17.3)

export interface TurnAttr {
  type: number;
  value: Buffer;
}

export function encodeTurnRequest(type: number, txId: Buffer, attrs: TurnAttr[]): Buffer {
  return message(type, txId, Buffer.concat(attrs.map((a) => attr(a.type, a.value))));
}

export function encodeTurnError(
  reqType: number,
  txId: Buffer,
  code: number,
  reason: string,
  extra: { realm?: string; nonce?: string } = {},
): Buffer {
  const errValue = Buffer.concat([
    Buffer.from([0x00, 0x00, Math.floor(code / 100), code % 100]),
    Buffer.from(reason, 'utf8'),
  ]);
  const parts: TurnAttr[] = [{ type: ATTR_ERROR_CODE, value: errValue }];
  if (extra.realm !== undefined) parts.push({ type: ATTR_REALM, value: Buffer.from(extra.realm, 'utf8') });
  if (extra.nonce !== undefined) parts.push({ type: ATTR_NONCE, value: Buffer.from(extra.nonce, 'utf8') });
  return message(reqType | 0x0110, txId, Buffer.concat(parts.map((p) => attr(p.type, p.value))));
}

export function encodeAllocateSuccess(txId: Buffer, relayed: MediaAddr, mapped: MediaAddr, lifetimeSec: number): Buffer | null {
  const xrelayed = encodeXorAddress(relayed);
  const xmapped = encodeXorAddress(mapped);
  if (xrelayed === null || xmapped === null) return null;
  const life = Buffer.alloc(4);
  life.writeUInt32BE(lifetimeSec, 0);
  return message(0x0103, txId, Buffer.concat([attr(ATTR_XOR_RELAYED, xrelayed), attr(ATTR_XOR_MAPPED, xmapped), attr(ATTR_LIFETIME, life)]));
}

export function encodeRefreshSuccess(txId: Buffer, lifetimeSec: number): Buffer {
  const life = Buffer.alloc(4);
  life.writeUInt32BE(lifetimeSec, 0);
  return message(0x0104, txId, attr(ATTR_LIFETIME, life));
}

export function encodePermissionSuccess(txId: Buffer): Buffer {
  return message(0x0108, txId, Buffer.alloc(0));
}

export function encodeChannelBindSuccess(txId: Buffer): Buffer {
  return message(0x0109, txId, Buffer.alloc(0));
}

export function encodeSendIndication(txId: Buffer, peer: MediaAddr, data: Buffer): Buffer | null {
  const xpeer = encodeXorAddress(peer);
  if (xpeer === null) return null;
  return message(TURN_SEND, txId, Buffer.concat([attr(ATTR_XOR_PEER, xpeer), attr(ATTR_DATA, data)]));
}

export function encodeDataIndication(txId: Buffer, peer: MediaAddr, data: Buffer): Buffer | null {
  const xpeer = encodeXorAddress(peer);
  if (xpeer === null) return null;
  return message(TURN_DATA, txId, Buffer.concat([attr(ATTR_XOR_PEER, xpeer), attr(ATTR_DATA, data)]));
}

/** Frame ChannelData (RFC 5766 §11): número de canal 0x4000–0x7FFF escolhido pelo cliente. */
export function frameChannelData(channel: number, data: Buffer): Buffer {
  const frame = Buffer.alloc(4 + data.length);
  frame.writeUInt16BE(channel, 0);
  frame.writeUInt16BE(data.length, 2);
  data.copy(frame, 4);
  return frame;
}

export function parseChannelData(buf: Uint8Array): { channel: number; data: Buffer } | null {
  if (!isChannelData(buf)) return null;
  const b = view(buf);
  const len = b.readUInt16BE(2);
  if (4 + len > buf.length) return null;
  return { channel: b.readUInt16BE(0), data: Buffer.from(b.subarray(4, 4 + len)) };
}

// ─── MESSAGE-INTEGRITY (RFC 5389 §15.4, credencial long-term §10.2) ─────────────────────

/** Chave long-term: MD5(username:realm:password) — derivação dos clientes WebRTC. */
export function longTermKey(username: string, realm: string, password: string): Buffer {
  return crypto.createHash('md5').update(`${username}:${realm}:${password}`, 'utf8').digest();
}

/** Anexa MESSAGE-INTEGRITY como último atributo (HMAC-SHA1 com length ajustado). */
export function addMessageIntegrity(buf: Buffer, key: Buffer): Buffer {
  const bodyLen = buf.readUInt16BE(2);
  const head = Buffer.from(buf.subarray(0, 20));
  head.writeUInt16BE(bodyLen + 24, 2);
  const mac = crypto.createHmac('sha1', key).update(Buffer.concat([head, buf.subarray(20)])).digest();
  return Buffer.concat([head, buf.subarray(20), attr(ATTR_MESSAGE_INTEGRITY, mac)]);
}

/**
 * Verifica MESSAGE-INTEGRITY onde quer que o atributo esteja (hash termina antes dele).
 *
 * **E exige que ele seja o ÚLTIMO** (emenda de 2026-09-05), como RFC 5389 §15.4 manda: só
 * FINGERPRINT (§15.5) pode sucedê-lo. Sem essa conferência, o HMAC provava o prefixo e não a
 * mensagem: qualquer intermediário anexava atributos na cauda, corrigia o comprimento do
 * cabeçalho externo — que não entra no MAC, porque o cálculo o reescreve — e o pedido passava
 * adulterado. O `decode` para no MI pelo mesmo motivo; as duas guardas são a mesma regra
 * aplicada nos dois lados (quem lê e quem autentica).
 */
export function verifyMessageIntegrity(buf: Uint8Array, key: Buffer): boolean {
  const b = view(buf);
  let off = 20;
  let miOff = -1;
  while (off + 4 <= b.length) {
    const at = b.readUInt16BE(off);
    const alen = b.readUInt16BE(off + 2);
    if (at === ATTR_MESSAGE_INTEGRITY && alen === 20) {
      miOff = off;
      break;
    }
    off += 4 + alen + ((4 - (alen % 4)) % 4);
  }
  if (miOff < 0) return false;
  const depois = miOff + 24;
  if (depois !== b.length) {
    // O único sucessor legítimo: FINGERPRINT (0x8028), 4 B de valor, e nada além dele.
    if (depois + 8 !== b.length) return false;
    if (b.readUInt16BE(depois) !== ATTR_FINGERPRINT || b.readUInt16BE(depois + 2) !== 4) return false;
  }
  const head = Buffer.from(b.subarray(0, 20));
  head.writeUInt16BE(miOff - 20 + 24, 2);
  const expected = crypto.createHmac('sha1', key).update(Buffer.concat([head, b.subarray(20, miOff)])).digest();
  try {
    return crypto.timingSafeEqual(expected, b.subarray(miOff + 4, miOff + 24));
  } catch {
    return false;
  }
}

// ─── Credencial TURN de curta duração (§17.3) ───────────────────────────────────────────
//
// Emitida em `voiceJoin`: username = `<sessionId>:<expiresAt>`; password =
// hex(HMAC-SHA-256(chaveNormalizada, BLAKE2b('turn-cred/1' ‖ sessionId ‖ peerKey ‖ expiresAt))).
// O HMAC usa libsodium `crypto_auth` (= HMAC-SHA-256); segredo de tamanho diferente de
// 32 B é normalizado por BLAKE2b-256 com domínio próprio.

function blake256(domain: string, ...parts: Buffer[]): Buffer {
  const out = Buffer.allocUnsafe(32);
  sodium.crypto_generichash_batch(out, [Buffer.from(domain, 'utf8'), ...parts]);
  return out;
}

function be64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(Math.trunc(n)));
  return b;
}

function turnAuthKey(secret: Buffer): Buffer {
  if (secret.length === sodium.crypto_auth_KEYBYTES) return secret;
  return blake256('turn-cred-key/1', secret);
}

export interface TurnCredential {
  readonly username: string;
  /** hex(HMAC-SHA-256) — entra como password na credencial long-term do cliente WebRTC. */
  readonly password: string;
}

export function turnCredentialPassword(hostTurnSecret: Buffer, sessionId: string, peerKey: Buffer, expiresAt: number): string {
  const digest = blake256('turn-cred/1', Buffer.from(sessionId, 'utf8'), peerKey, be64(expiresAt));
  const mac = Buffer.alloc(sodium.crypto_auth_BYTES);
  sodium.crypto_auth(mac, digest, turnAuthKey(hostTurnSecret));
  return mac.toString('hex');
}

export function issueTurnCredential(hostTurnSecret: Buffer, sessionId: string, peerKey: Buffer, expiresAt: number): TurnCredential {
  return {
    username: `${sessionId}:${expiresAt}`,
    password: turnCredentialPassword(hostTurnSecret, sessionId, peerKey, expiresAt),
  };
}

export function parseTurnUsername(username: string): { sessionId: string; expiresAt: number } | null {
  const sep = username.lastIndexOf(':');
  if (sep < 0) return null;
  const sessionId = username.slice(0, sep);
  const expiresAt = Number.parseInt(username.slice(sep + 1), 10);
  if (sessionId.length === 0 || !Number.isFinite(expiresAt)) return null;
  return { sessionId, expiresAt };
}

// ─── Controles do TURN do host (§17.3) — camada de decisão pura ─────────────────────────

/**
 * **A recusa de tela saiu (emenda de 2026-08-28).** §17.3 dizia "tela via TURN é recusada
 * no v1" e este módulo tinha o ramo para aplicá-la — mas nenhum chamador podia acioná-lo,
 * e não por descuido: a tela reusa a MESMA `RTCPeerConnection` da voz (§17.5, e
 * `frontend/src/live/voz.ts` diz por quê), então voz, câmera e tela viajam num componente
 * ICE só e numa alocação TURN só. O host recebe bytes cifrados e não tem como saber qual
 * trilha é qual; recusar "a tela" significaria recusar a chamada inteira.
 *
 * O que sobra do controle é o que sempre foi aplicável: `TURN_RATE_KBPS` e
 * `TURN_SESSION_MAX_BYTES`, agora declaradamente sobre o **bundle**. Quem evita empurrar
 * tela por um caminho relayado é o renderer, que enxerga o par selecionado — conselho
 * declarado, na distinção que §17.4 já faz (`T-40`), não enforcement fingido.
 */
export type AllocDecision =
  | { ok: true; allocId: string; expiresAt: number }
  | { ok: false; reason: 'member-limit' | 'gone' };

interface AllocRecord {
  allocId: string;
  memberKeyHex: string;
  expiresAt: number;
}

/**
 * Limites de §17.3 sobre estado próprio: tela recusada no v1, `TURN_ALLOC_PER_MEMBER`
 * simultâneas por membro, TTL renovável enquanto a sessão viver. Os valores vêm da config
 * operacional de §27.2 (`config`, L0), injetados no boot.
 */
export class TurnControls {
  readonly #allocs = new Map<string, Map<string, AllocRecord>>(); // memberKeyHex → allocId → record
  readonly #ttlMs: number;
  readonly #maxPerMember: number;
  readonly #allocIdFactory: () => string;

  constructor(opts: { ttlMs: number; maxPerMember: number; allocIdFactory?: () => string }) {
    this.#ttlMs = opts.ttlMs;
    this.#maxPerMember = opts.maxPerMember;
    this.#allocIdFactory = opts.allocIdFactory ?? (() => crypto.randomBytes(16).toString('hex'));
  }

  get ttlMs(): number {
    return this.#ttlMs;
  }

  allocate(memberKeyHex: string, now: number): AllocDecision {
    let set = this.#allocs.get(memberKeyHex);
    if (set === undefined) {
      set = new Map();
      this.#allocs.set(memberKeyHex, set);
    }
    for (const [id, a] of set) if (a.expiresAt <= now) set.delete(id);
    if (set.size >= this.#maxPerMember) return { ok: false, reason: 'member-limit' };
    const allocId = this.#allocIdFactory();
    const expiresAt = now + this.#ttlMs;
    set.set(allocId, { allocId, memberKeyHex, expiresAt });
    return { ok: true, allocId, expiresAt };
  }

  refresh(memberKeyHex: string, allocId: string, now: number): AllocDecision {
    const a = this.#allocs.get(memberKeyHex)?.get(allocId);
    if (a === undefined || a.expiresAt <= now) return { ok: false, reason: 'gone' };
    a.expiresAt = now + this.#ttlMs; // renovável enquanto a sessão viver
    return { ok: true, allocId, expiresAt: a.expiresAt };
  }

  drop(memberKeyHex: string, allocId: string): void {
    const set = this.#allocs.get(memberKeyHex);
    if (set === undefined) return;
    set.delete(allocId);
    if (set.size === 0) this.#allocs.delete(memberKeyHex);
  }

  sweep(now: number): number {
    let n = 0;
    for (const [member, set] of this.#allocs) {
      for (const [id, a] of set) {
        if (a.expiresAt <= now) {
          set.delete(id);
          n++;
        }
      }
      if (set.size === 0) this.#allocs.delete(member);
    }
    return n;
  }

  activeCount(memberKeyHex: string): number {
    return this.#allocs.get(memberKeyHex)?.size ?? 0;
  }
}

// ─── Servidor de mídia sobre portas injetadas ───────────────────────────────────────────

/** Porta da socket UDP compartilhada UDX/STUN — implementada por L3 e injetada no boot. */
export interface MediaSocketPort {
  send(datagram: Uint8Array, addr: MediaAddr): void;
}

/** Porta de transporte relayado de uma alocação TURN (RFC 5766 §5) — implementada por L3. */
export interface RelayPort {
  /** Endereço relayado anunciado em XOR-RELAYED-ADDRESS. */
  readonly addr: MediaAddr;
  send(datagram: Uint8Array, addr: MediaAddr): void;
  onData(cb: (data: Uint8Array, from: MediaAddr) => void): void;
  close(): void;
}

export interface MediaServerOptions {
  realm: string;
  /**
   * Segredo das credenciais TURN de curta duração emitidas em `voiceJoin` (§17.3).
   *
   * §5.2 o deriva **por comunidade** (`ns/hostturn/1 ‖ dataKey ‖ communityId`), e a socket de
   * §17.3 é uma só para o processo — então uma instalação que hospeda duas comunidades tem
   * dois segredos numa socket. Por isso a forma de função: o `sessionId` vem no username da
   * credencial (RFC 5389 §10.2) e diz de qual comunidade é a sessão. `null` = sessão que não
   * é minha, e a autenticação recusa. O `Buffer` cru continua aceito para quem hospeda uma só.
   */
  hostTurnSecret: Buffer | ((sessionId: string) => Buffer | null);
  socket: MediaSocketPort;
  openRelayPort: (allocId: string) => Promise<RelayPort>;
  /** Chaves (hex) dos pares com sessão de voz ativa naquele `sessionId`. */
  sessionPeerKeys: (sessionId: string) => ReadonlySet<string>;
  /**
   * **IPs** dos pares do roster daquela sessão — único destino permitido (§17.3).
   *
   * IP, e não `host:port`, porque RFC 5766 §9 é explícita: a permissão é por endereço IP e
   * "the port portion of each attribute will be ignored and may be any arbitrary value".
   * A redação anterior comparava `host:port` e era, ao mesmo tempo, mais estrita que a RFC
   * e **impossível de satisfazer**: a porta de origem do `RTCPeerConnection` do renderer
   * é de outra socket que não a do UDX, com outro mapeamento NAT, e o host não tem de onde
   * saber qual é. Por IP a ponte fecha — o IP público de um par é o mesmo para as duas
   * sockets em todo NAT que não distribua saída por um pool de endereços.
   */
  rosterAddresses: (sessionId: string) => ReadonlySet<string>;
  /**
   * §17.3 — abre o mapeamento de volta para o par recém-permitido. Sob NAT restrito por
   * porta, a permissão sozinha não basta: o par só alcança o endereço relayado depois que
   * ele mandou alguma coisa primeiro. Opcional porque um host em endereço público não
   * precisa (e a suíte unitária não tem NAT).
   */
  primeRelayTo?: (relay: RelayPort, peer: MediaAddr) => void;
  /**
   * Ponte par→endereço observado, na direção que só o TURN conhece: um Allocate/Refresh
   * autenticado prova que **aquela chave** está **naquele IP** agora. É a segunda fonte de
   * `rosterAddresses` (a primeira é o endereço que o transporte observou na conexão), e é a
   * que cobre o par cujo tráfego de mídia sai por um IP diferente do da conexão do DHT.
   */
  onPeerObserved?: (sessionId: string, peerKeyHex: string, addr: MediaAddr) => void;
  now?: () => number;
  /** Defaults de §27.2, resolvidos pela config L0 e congelados no boot. */
  allocTtlMs?: number;
  maxAllocsPerMember?: number;
  rateKbps?: number;
  sessionMaxBytes?: number;
}

export interface TurnCounters {
  bindingRequests: number;
  allocates: number;
  refreshes: number;
  permissionsGranted: number;
  permissionsRefused: number;
  channelBinds: number;
  relayedPackets: number;
  dataIndications: number;
  relayedBytes: number;
  notPermittedDropped: number;
  rateDropped: number;
  authFailures: number;
  quotaExceeded: number;
}

interface Allocation {
  readonly clientAddr: string;
  readonly allocId: string;
  readonly sessionId: string;
  readonly memberKeyHex: string;
  readonly username: string;
  readonly key: Buffer; // chave long-term para MI das respostas deste membro
  readonly relayPort: RelayPort;
  expiresAt: number;
  /** IP do par (RFC 5766 §9 ignora a porta) → instante em que a permissão vence. */
  readonly permissions: Map<string, number>;
  readonly channels: Map<number, string>;
  readonly peersByChannel: Map<string, number>;
  bytesRelayed: number;
  tokens: number;
  lastRefill: number;
}

export class MediaServer {
  readonly #socket: MediaSocketPort;
  readonly #openRelayPort: (allocId: string) => Promise<RelayPort>;
  readonly #sessionPeerKeys: (sessionId: string) => ReadonlySet<string>;
  readonly #rosterAddresses: (sessionId: string) => ReadonlySet<string>;
  readonly #primeRelayTo: (relay: RelayPort, peer: MediaAddr) => void;
  readonly #onPeerObserved: (sessionId: string, peerKeyHex: string, addr: MediaAddr) => void;
  readonly #now: () => number;
  readonly #controls: TurnControls;
  readonly #rateBytesPerMs: number;
  readonly #sessionMaxBytes: number;
  readonly #hostTurnSecret: (sessionId: string) => Buffer | null;
  readonly #realm: string;
  readonly #allocations = new Map<string, Allocation>(); // clientAddr → allocation
  /** Allocate em voo (porta de relay abrindo) → `txId`, para reconhecer retransmissão. */
  readonly #pending = new Map<string, Buffer>();
  #nonce = crypto.randomBytes(16).toString('hex');
  #nonceIssuedAt = 0;
  readonly counters: TurnCounters = {
    bindingRequests: 0,
    allocates: 0,
    refreshes: 0,
    permissionsGranted: 0,
    permissionsRefused: 0,
    channelBinds: 0,
    relayedPackets: 0,
    dataIndications: 0,
    relayedBytes: 0,
    notPermittedDropped: 0,
    rateDropped: 0,
    authFailures: 0,
    quotaExceeded: 0,
  };

  constructor(options: MediaServerOptions) {
    this.#socket = options.socket;
    this.#openRelayPort = options.openRelayPort;
    this.#sessionPeerKeys = options.sessionPeerKeys;
    this.#rosterAddresses = options.rosterAddresses;
    this.#primeRelayTo = options.primeRelayTo ?? (() => {});
    this.#onPeerObserved = options.onPeerObserved ?? (() => {});
    this.#now = options.now ?? Date.now;
    const segredo = options.hostTurnSecret;
    this.#hostTurnSecret = typeof segredo === 'function' ? segredo : () => segredo;
    this.#realm = options.realm;
    this.#controls = new TurnControls({
      ttlMs: options.allocTtlMs ?? DEFAULTS.allocTtlMs,
      maxPerMember: options.maxAllocsPerMember ?? DEFAULTS.maxAllocsPerMember,
    });
    this.#rateBytesPerMs = ((options.rateKbps ?? DEFAULTS.rateKbps) * 1000) / 8 / 1000;
    this.#sessionMaxBytes = options.sessionMaxBytes ?? DEFAULTS.sessionMaxBytes;
  }

  /**
   * Entrada única da socket compartilhada. Retorna a classificação: `udx` precisa ser
   * repassado à pilha UDX pelo dono da socket; os outros dois foram consumidos aqui.
   */
  handleDatagram(datagram: Uint8Array, addr: MediaAddr): InboundClass {
    const cls = classifyInbound(datagram);
    if (cls === 'udx') return 'udx';
    const msg = Buffer.from(datagram);
    if (cls === 'channel-data') {
      this.#handleChannelData(msg, addr);
      return 'channel-data';
    }
    const dec = decode(msg);
    if (dec === null) return 'udx'; // defensivo: classificação e decode não divergem
    switch (dec.type) {
      case BINDING_REQUEST:
        this.counters.bindingRequests++;
        this.#reply(encodeBindingSuccess(dec.txId, addr), addr);
        break;
      case TURN_ALLOCATE:
        this.#handleAllocate(msg, dec, addr);
        break;
      case TURN_REFRESH:
        this.#handleRefresh(msg, dec, addr);
        break;
      case TURN_CREATE_PERMISSION:
        this.#handlePermission(msg, dec, addr);
        break;
      case TURN_CHANNEL_BIND:
        this.#handleChannelBind(msg, dec, addr);
        break;
      case TURN_SEND:
        this.#handleSendIndication(msg, dec, addr);
        break;
      default:
        break;
    }
    return 'stun';
  }

  /**
   * Expira alocações vencidas — e as de quem já não está na sessão — e devolve quantas
   * fechou. Sem cadência que a chame, cada alocação vencida vazava um socket UDP até o fim
   * do processo, e o cliente cuja alocação venceu levava **437 para sempre** do mesmo
   * 5-tuple (o `#handleAllocate` via o registro morto e o tratava como conflito).
   *
   * A perna do roster é a rede de segurança de §17.4: quem foi banido perde a alocação no
   * ato pelo `revoke`, e esta varredura cobre o caso em que o evento não veio.
   */
  sweep(now = this.#now()): number {
    let n = 0;
    for (const alloc of [...this.#allocations.values()]) {
      const naSessao = this.#sessionPeerKeys(alloc.sessionId).has(alloc.memberKeyHex);
      if (alloc.expiresAt <= now || !naSessao) {
        this.#terminate(alloc);
        n++;
      }
    }
    return n;
  }

  /**
   * §17.4 — a revogação fecha o caminho de mídia do alvo, e não só o de sinalização.
   *
   * Ban, kick, timeout, saída e queda tiram o par do roster; sem isto a alocação TURN dele
   * sobrevivia até `TURN_ALLOC_TTL_MS` (10 min), e os dois caminhos que não autenticam
   * (ChannelData de saída e entrada pela porta relayada) continuavam entregando mídia
   * relayada a quem acabou de ser removido, à custa da máquina de quem hospeda.
   */
  revoke(memberKeyHex: string): number {
    let n = 0;
    for (const alloc of [...this.#allocations.values()]) {
      if (alloc.memberKeyHex !== memberKeyHex) continue;
      this.#terminate(alloc);
      n++;
    }
    return n;
  }

  /** Fecha todas as alocações (encerramento do serviço de mídia do host). */
  close(): void {
    for (const alloc of [...this.#allocations.values()]) this.#terminate(alloc);
  }

  get allocationCount(): number {
    return this.#allocations.size;
  }

  allocationFor(clientAddr: string): {
    readonly allocId: string;
    readonly sessionId: string;
    readonly memberKeyHex: string;
    readonly bytesRelayed: number;
  } | null {
    const a = this.#allocations.get(clientAddr);
    if (a === undefined) return null;
    return {
      allocId: a.allocId,
      sessionId: a.sessionId,
      memberKeyHex: a.memberKeyHex,
      bytesRelayed: a.bytesRelayed,
    };
  }

  #currentNonce(now: number): string {
    if (this.#nonceIssuedAt === 0 || now - this.#nonceIssuedAt > NONCE_VALID_MS) {
      this.#nonce = crypto.randomBytes(16).toString('hex');
      this.#nonceIssuedAt = now;
    }
    return this.#nonce;
  }

  /**
   * Verifica MESSAGE-INTEGRITY contra a credencial de curta duração: decodifica o
   * username, confere expiração e procura um par com sessão ativa cuja senha derivada
   * valide o MAC. Devolve a chave long-term para assinar a resposta.
   */
  #authenticate(
    msg: Buffer,
    dec: DecodedStun,
    now: number,
    addr: MediaAddr,
  ): { ok: true; sessionId: string; peerKeyHex: string; username: string; key: Buffer } | { ok: false; challenge: boolean } {
    if (!dec.hasMessageIntegrity || dec.username === undefined || dec.realm !== this.#realm || dec.nonce === undefined) {
      return { ok: false, challenge: true };
    }
    if (dec.nonce !== this.#nonce || now - this.#nonceIssuedAt > NONCE_VALID_MS) {
      return { ok: false, challenge: true };
    }
    const parsed = parseTurnUsername(dec.username);
    if (parsed === null || now >= parsed.expiresAt) {
      this.counters.authFailures++;
      return { ok: false, challenge: true };
    }
    // Sessão de outra instalação (ou de comunidade que este nó não hospeda) não tem segredo
    // aqui: recusa como qualquer credencial inválida, sem dizer que a sessão existe.
    const segredo = this.#hostTurnSecret(parsed.sessionId);
    if (segredo === null) {
      this.counters.authFailures++;
      return { ok: false, challenge: true };
    }
    for (const peerKeyHex of this.#sessionPeerKeys(parsed.sessionId)) {
      const peerKey = Buffer.from(peerKeyHex, 'hex');
      if (peerKey.length !== 32) continue;
      const password = turnCredentialPassword(segredo, parsed.sessionId, peerKey, parsed.expiresAt);
      const key = longTermKey(dec.username, this.#realm, password);
      if (verifyMessageIntegrity(msg, key)) {
        // O MAC fecha: esta chave está NESTE endereço agora. É a única prova de
        // par→endereço que o host obtém sem perguntar a ninguém.
        this.#onPeerObserved(parsed.sessionId, peerKeyHex, addr);
        return { ok: true, sessionId: parsed.sessionId, peerKeyHex, username: dec.username, key };
      }
    }
    this.counters.authFailures++;
    return { ok: false, challenge: false };
  }

  #challenge(dec: DecodedStun, challenge: boolean, addr: MediaAddr): void {
    if (!challenge) {
      // autenticou mal (senha/expiração/sessão): 401 sem nonce novo evita ciclo de retry
      this.#sendRaw(encodeTurnError(dec.type, dec.txId, 401, 'Unauthorized'), addr);
      return;
    }
    const extra = { realm: this.#realm, nonce: this.#currentNonce(this.#now()) };
    this.#sendRaw(encodeTurnError(dec.type, dec.txId, 401, 'Unauthorized', extra), addr);
  }

  #handleAllocate(msg: Buffer, dec: DecodedStun, addr: MediaAddr): void {
    const now = this.#now();
    if (dec.requestedTransport !== undefined && dec.requestedTransport !== 17) {
      this.#sendRaw(encodeTurnError(dec.type, dec.txId, 442, 'Unsupported Transport'), addr);
      return;
    }
    const auth = this.#authenticate(msg, dec, now, addr);
    if (!auth.ok) {
      this.#challenge(dec, auth.challenge, addr);
      return;
    }
    const clientAddr = keyOf(addr);
    // **Retransmissão não é conflito (RFC 5766 §6.2).** O cliente retransmite o Allocate a
    // cada 500 ms enquanto não vê resposta, e abrir a porta relayada leva mais que isso — o
    // mapeamento externo dela é descoberto por um Binding a um STUN de terceiro. Responder
    // 437 à segunda cópia do MESMO pedido faz o cliente derrubar a porta TURN inteira, e foi
    // metade do que travou a coleta de candidatos numa chamada real: a outra metade era
    // anunciar o `turn:` sem nunca fechar o Allocate.
    //
    // A transação identifica a retransmissão: mesmo `txId`, mesmo cliente. A resposta certa
    // é silêncio — o pedido original ainda está em voo e vai responder por ele.
    const emVoo = this.#pending.get(clientAddr);
    if (emVoo !== undefined) {
      if (emVoo.equals(dec.txId)) return;
      this.#sendAuthed(encodeTurnError(dec.type, dec.txId, 437, 'Allocation Mismatch'), auth.key, addr);
      return;
    }
    const anterior = this.#allocations.get(clientAddr);
    if (anterior !== undefined) {
      if (anterior.expiresAt > now) {
        this.#sendAuthed(encodeTurnError(dec.type, dec.txId, 437, 'Allocation Mismatch'), auth.key, addr);
        return;
      }
      // Alocação VENCIDA não é conflito: é lixo que a varredura ainda não recolheu. Tratá-la
      // como conflito trancava o 5-tuple do cliente em 437 até o host reiniciar — o Refresh
      // que se perde depois do vencimento não tinha volta nenhuma.
      this.#terminate(anterior);
    }
    const decision = this.#controls.allocate(auth.peerKeyHex, now);
    if (!decision.ok) {
      // membro no teto de §17.3 → cota de alocação atingida
      this.#sendAuthed(encodeTurnError(dec.type, dec.txId, 486, 'Allocation Quota Reached'), auth.key, addr);
      return;
    }
    this.#pending.set(clientAddr, dec.txId);
    void this.#openRelayPort(decision.allocId).then(
      (relayPort) => {
        this.#pending.delete(clientAddr);
        // entre o Allocate e a porta abrir, outro pode ter tomado o mesmo 5-tuple
        if (this.#allocations.has(clientAddr)) {
          relayPort.close();
          this.#controls.drop(auth.peerKeyHex, decision.allocId);
          return;
        }
        const alloc: Allocation = {
          clientAddr,
          allocId: decision.allocId,
          sessionId: auth.sessionId,
          memberKeyHex: auth.peerKeyHex,
          username: auth.username,
          key: auth.key,
          relayPort,
          expiresAt: decision.expiresAt,
          permissions: new Map(),
          channels: new Map(),
          peersByChannel: new Map(),
          bytesRelayed: 0,
          tokens: this.#rateBytesPerMs * 1000, // burst de 1 s
          lastRefill: now,
        };
        this.#wireRelay(alloc);
        this.#allocations.set(clientAddr, alloc);
        this.counters.allocates++;
        const success = encodeAllocateSuccess(dec.txId, relayPort.addr, addr, Math.floor(this.#controls.ttlMs / 1000));
        if (success !== null) this.#sendAuthed(success, auth.key, addr);
      },
      () => {
        this.#pending.delete(clientAddr);
        this.#controls.drop(auth.peerKeyHex, decision.allocId);
        this.#sendRaw(encodeTurnError(dec.type, dec.txId, 508, 'Insufficient Capacity'), addr);
      },
    );
  }

  #handleRefresh(msg: Buffer, dec: DecodedStun, addr: MediaAddr): void {
    const now = this.#now();
    const auth = this.#authenticate(msg, dec, now, addr);
    if (!auth.ok) {
      this.#challenge(dec, auth.challenge, addr);
      return;
    }
    const alloc = this.#allocations.get(keyOf(addr));
    if (alloc === undefined || alloc.expiresAt <= now) {
      this.#sendAuthed(encodeTurnError(dec.type, dec.txId, 437, 'Allocation Mismatch'), auth.key, addr);
      return;
    }
    const lifetimeSec = dec.lifetimeSec ?? Math.floor(this.#controls.ttlMs / 1000);
    if (lifetimeSec === 0) {
      this.#terminate(alloc);
      this.#sendAuthed(encodeRefreshSuccess(dec.txId, 0), auth.key, addr);
      return;
    }
    // A vida concedida é sempre a política do host: TTL renovável enquanto a sessão
    // viver (§17.3). A sessão morreu → a credencial expirou no #authenticate acima.
    const decision = this.#controls.refresh(alloc.memberKeyHex, alloc.allocId, now);
    if (!decision.ok) {
      this.#sendAuthed(encodeTurnError(dec.type, dec.txId, 437, 'Allocation Mismatch'), auth.key, addr);
      return;
    }
    alloc.expiresAt = decision.expiresAt;
    this.counters.refreshes++;
    this.#sendAuthed(encodeRefreshSuccess(dec.txId, Math.floor(this.#controls.ttlMs / 1000)), auth.key, addr);
  }

  #handlePermission(msg: Buffer, dec: DecodedStun, addr: MediaAddr): void {
    const now = this.#now();
    const auth = this.#authenticate(msg, dec, now, addr);
    if (!auth.ok) {
      this.#challenge(dec, auth.challenge, addr);
      return;
    }
    const alloc = this.#allocations.get(keyOf(addr));
    const peer = dec.xorPeer;
    if (alloc === undefined || peer === undefined || alloc.expiresAt <= now) {
      this.#sendAuthed(encodeTurnError(dec.type, dec.txId, 437, 'Allocation Mismatch'), auth.key, addr);
      return;
    }
    // §17.3: permissão só para pares do roster daquela sessão. Por IP — RFC 5766 §9 manda
    // ignorar a porta do `XOR-PEER-ADDRESS` para casar a permissão.
    if (!this.#rosterAddresses(alloc.sessionId).has(peer.host)) {
      this.counters.permissionsRefused++;
      this.#sendAuthed(encodeTurnError(dec.type, dec.txId, 403, 'Forbidden'), auth.key, addr);
      return;
    }
    alloc.permissions.set(peer.host, now + PERMISSION_LIFETIME_MS);
    this.counters.permissionsGranted++;
    // A porta vem no atributo mesmo sem valer para a permissão, e é ela que o primer usa:
    // é o único instante em que o host sabe para onde furar o próprio NAT.
    this.#primeRelayTo(alloc.relayPort, peer);
    this.#sendAuthed(encodePermissionSuccess(dec.txId), auth.key, addr);
  }

  #handleChannelBind(msg: Buffer, dec: DecodedStun, addr: MediaAddr): void {
    const now = this.#now();
    const auth = this.#authenticate(msg, dec, now, addr);
    if (!auth.ok) {
      this.#challenge(dec, auth.challenge, addr);
      return;
    }
    const alloc = this.#allocations.get(keyOf(addr));
    const peer = dec.xorPeer;
    if (alloc === undefined || peer === undefined || alloc.expiresAt <= now) {
      this.#sendAuthed(encodeTurnError(dec.type, dec.txId, 437, 'Allocation Mismatch'), auth.key, addr);
      return;
    }
    const channel = dec.channelNumber;
    if (channel === undefined || channel < 0x4000 || channel > 0x7fff) {
      this.#sendAuthed(encodeTurnError(dec.type, dec.txId, 400, 'Bad Request'), auth.key, addr);
      return;
    }
    // O canal é por endereço de transporte (RFC 5766 §11), mas a permissão que ele implica
    // continua por IP — as duas chaves convivem de propósito.
    const peerKey = keyOf(peer);
    if (!this.#rosterAddresses(alloc.sessionId).has(peer.host)) {
      this.counters.permissionsRefused++;
      this.#sendAuthed(encodeTurnError(dec.type, dec.txId, 403, 'Forbidden'), auth.key, addr);
      return;
    }
    const existing = alloc.channels.get(channel);
    if (existing !== undefined && existing !== peerKey) {
      this.#sendAuthed(encodeTurnError(dec.type, dec.txId, 400, 'Bad Request'), auth.key, addr);
      return;
    }
    if (existing === undefined) {
      alloc.channels.set(channel, peerKey);
      alloc.peersByChannel.set(peerKey, channel);
    }
    alloc.permissions.set(peer.host, now + PERMISSION_LIFETIME_MS);
    this.#primeRelayTo(alloc.relayPort, peer);
    this.counters.channelBinds++;
    this.#sendAuthed(encodeChannelBindSuccess(dec.txId), auth.key, addr);
  }

  #handleSendIndication(msg: Buffer, dec: DecodedStun, addr: MediaAddr): void {
    const now = this.#now();
    const auth = this.#authenticate(msg, dec, now, addr);
    if (!auth.ok) {
      this.counters.authFailures++; // indicação não tem resposta; só contabiliza
      return;
    }
    const alloc = this.#allocations.get(keyOf(addr));
    if (alloc === undefined || alloc.expiresAt <= now || dec.xorPeer === undefined || dec.data === undefined) return;
    this.#relayOut(alloc, dec.data, dec.xorPeer, now);
  }

  /** Datagrama ChannelData do cliente (mesma socket compartilhada) para o par. */
  #handleChannelData(msg: Buffer, addr: MediaAddr): void {
    const now = this.#now();
    const parsedFrame = parseChannelData(msg);
    const alloc = this.#allocations.get(keyOf(addr));
    if (parsedFrame === null || alloc === undefined || alloc.expiresAt <= now) return;
    const peerKey = alloc.channels.get(parsedFrame.channel);
    if (peerKey === undefined) return;
    const [host, portStr] = peerKey.split(':');
    if (host === undefined || portStr === undefined) return;
    this.#relayOut(alloc, parsedFrame.data, { host, port: Number.parseInt(portStr, 10) }, now);
  }

  /** Dado que chegou na porta de relay → Data indication ou ChannelData ao cliente. */
  #wireRelay(alloc: Allocation): void {
    alloc.relayPort.onData((data, from) => {
      const now = this.#now();
      if (alloc.expiresAt <= now) return;
      // RFC 5766 §10: o endereço relayado é público, e sem esta checagem qualquer máquina
      // da internet que o descubra faz o host entregar bytes ao cliente por ela. A
      // permissão é a mesma do caminho de saída, e por IP pelo mesmo §9.
      if (!this.#permitido(alloc, from.host, now)) {
        this.counters.notPermittedDropped++;
        return;
      }
      const payload = Buffer.from(data);
      if (!this.#admitRate(alloc, payload.length, now)) {
        this.counters.rateDropped++;
        return;
      }
      alloc.bytesRelayed += payload.length;
      this.counters.relayedPackets++;
      this.counters.relayedBytes += payload.length;
      if (alloc.bytesRelayed > this.#sessionMaxBytes) {
        this.counters.quotaExceeded++;
        this.#terminate(alloc);
        return;
      }
      const channel = alloc.peersByChannel.get(keyOf(from));
      if (channel !== undefined) {
        this.#socket.send(new Uint8Array(frameChannelData(channel, payload)), this.#clientAddrOf(alloc));
      } else {
        const indication = encodeDataIndication(randomTxId(), from, payload);
        if (indication !== null) {
          this.#socket.send(new Uint8Array(indication), this.#clientAddrOf(alloc));
          this.counters.dataIndications++;
        }
      }
    });
  }

  /** Saída relayada para um par: permissão, taxa e teto de sessão (§17.3). */
  #relayOut(alloc: Allocation, payload: Buffer, peer: MediaAddr, now: number): void {
    if (!this.#permitido(alloc, peer.host, now)) {
      this.counters.notPermittedDropped++;
      return;
    }
    if (!this.#admitRate(alloc, payload.length, now)) {
      this.counters.rateDropped++;
      return;
    }
    alloc.bytesRelayed += payload.length;
    this.counters.relayedPackets++;
    this.counters.relayedBytes += payload.length;
    if (alloc.bytesRelayed > this.#sessionMaxBytes) {
      this.counters.quotaExceeded++;
      this.#terminate(alloc);
      return;
    }
    alloc.relayPort.send(new Uint8Array(payload), peer);
  }

  /**
   * A permissão de §9 vale para ESTE IP e ainda não venceu. Vencida sai do mapa no ato: o
   * caminho quente é também o que poda, e não há segunda cadência para isto.
   */
  #permitido(alloc: Allocation, host: string, now: number): boolean {
    const ate = alloc.permissions.get(host);
    if (ate === undefined) return false;
    if (ate > now) return true;
    alloc.permissions.delete(host);
    // O canal é por `host:port` (§11) e a permissão por IP (§9) — duas chaves, de propósito.
    // Sem a permissão o canal não tem para onde entregar: os que apontam para este IP saem
    // junto, senão ficaria um destino que §9 acabou de negar.
    for (const [peerKey, canal] of [...alloc.peersByChannel]) {
      if (peerKey.slice(0, peerKey.lastIndexOf(':')) !== host) continue;
      alloc.peersByChannel.delete(peerKey);
      alloc.channels.delete(canal);
    }
    return false;
  }

  /** Balde de tokens por alocação: rajada de 1 s da taxa contratada (§27.2). */
  #admitRate(alloc: Allocation, len: number, now: number): boolean {
    const capacity = this.#rateBytesPerMs * 1000;
    alloc.tokens = Math.min(capacity, alloc.tokens + Math.max(0, now - alloc.lastRefill) * this.#rateBytesPerMs);
    alloc.lastRefill = now;
    if (alloc.tokens < len) return false;
    alloc.tokens -= len;
    return true;
  }

  #terminate(alloc: Allocation): void {
    // A porta de relay é fechada abaixo, mas o `onData` que `#wireRelay` instalou é uma
    // closure sobre ESTA alocação e nada garante que a porta pare de entregar no mesmo
    // instante. Zerar o prazo é o que faz a closure recusar: o guarda já existe nos dois
    // caminhos relayados, e assim a revogação vale mesmo para o datagrama em trânsito.
    alloc.expiresAt = 0;
    this.#allocations.delete(alloc.clientAddr);
    this.#pending.delete(alloc.clientAddr);
    this.#controls.drop(alloc.memberKeyHex, alloc.allocId);
    alloc.relayPort.close();
  }

  #clientAddrOf(alloc: Allocation): MediaAddr {
    const sep = alloc.clientAddr.lastIndexOf(':');
    return { host: alloc.clientAddr.slice(0, sep), port: Number.parseInt(alloc.clientAddr.slice(sep + 1), 10) };
  }

  #reply(buf: Buffer | null, addr: MediaAddr): void {
    if (buf !== null) this.#sendRaw(buf, addr);
  }

  #sendRaw(buf: Buffer, addr: MediaAddr): void {
    this.#socket.send(new Uint8Array(buf), addr);
  }

  /** Resposta a pedido autenticado: RFC 5766 exige MESSAGE-INTEGRITY na resposta. */
  #sendAuthed(buf: Buffer | null, key: Buffer, addr: MediaAddr): void {
    if (buf === null) return;
    this.#sendRaw(addMessageIntegrity(buf, key), addr);
  }
}
