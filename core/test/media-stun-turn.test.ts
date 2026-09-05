// Testes do módulo de mídia — STUN/TURN comunitários (§17.3, A17) sobre portas injetadas.
// Vetores e decisões reutilizados da evidência G7 (poc/poc-08-g7); o código do poc é
// descartável, as decisões não.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MediaServer,
  TURN_ALLOCATE,
  TURN_CHANNEL_BIND,
  TURN_CREATE_PERMISSION,
  TURN_REFRESH,
  TURN_SEND,
  addMessageIntegrity,
  classifyInbound,
  decode,
  encodeBindingRequest,
  encodeTurnRequest,
  frameChannelData,
  issueTurnCredential,
  longTermKey,
  parseChannelData,
  randomTxId,
  turnCredentialPassword,
  verifyMessageIntegrity,
  type MediaAddr,
  type MediaServerOptions,
  type MediaSocketPort,
  type RelayPort,
} from '../src/l2/communityHost/stunTurn.ts';
import { resolveConfig } from '../src/l0/config/index.ts';
import { keypairFromSeed } from './helpers/world.ts';

const REALM = 'comunidade.test';
const CLIENT: MediaAddr = { host: '10.0.0.1', port: 50_001 };
const PEER_ADDR: MediaAddr = { host: '10.0.0.2', port: 50_002 };
const ATTR_USERNAME = 0x0006;
/** RFC 5766 §14.1 — CHANNEL-NUMBER. Era lido de 0x0006 (USERNAME), e o teste congelava o erro. */
const ATTR_CHANNEL_NUMBER = 0x000c;
const ATTR_REALM = 0x0014;
const ATTR_NONCE = 0x0015;
const ATTR_LIFETIME = 0x000d;
const ATTR_XOR_PEER = 0x0012;
const ATTR_DATA = 0x0013;

function fakeClock(): { now(): number; advance(ms: number): void } {
  let t = 1_000_000;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

type SentDatagram = { data: Buffer; addr: MediaAddr };

function fakeSocket(): { port: MediaSocketPort; sents: SentDatagram[] } {
  const sents: SentDatagram[] = [];
  return {
    sents,
    port: {
      send(datagram, addr) {
        sents.push({ data: Buffer.from(datagram), addr });
      },
    },
  };
}

type SocketHandle = ReturnType<typeof fakeSocket>;

class FakeRelayPort implements RelayPort {
  readonly addr: MediaAddr;
  readonly sents: SentDatagram[] = [];
  closed = false;
  #cb: ((data: Uint8Array, from: MediaAddr) => void) | null = null;

  constructor(addr: MediaAddr) {
    this.addr = addr;
  }

  send(datagram: Uint8Array, addr: MediaAddr): void {
    this.sents.push({ data: Buffer.from(datagram), addr });
  }

  onData(cb: (data: Uint8Array, from: MediaAddr) => void): void {
    this.#cb = cb;
  }

  /** Simula um datagrama chegando ao relay de um par. */
  receive(data: Buffer, from: MediaAddr): void {
    this.#cb?.(data, from);
  }

  close(): void {
    this.closed = true;
  }
}

interface Fixture {
  clock: ReturnType<typeof fakeClock>;
  socket: SocketHandle;
  relays: FakeRelayPort[];
  server: MediaServer;
  secret: Buffer;
  member: ReturnType<typeof keypairFromSeed>;
  sessionId: string;
  username: string;
  password: string;
  roster: Set<string>;
}

function fixture(overrides: Partial<MediaServerOptions> = {}): Fixture {
  const clock = fakeClock();
  const socket = fakeSocket();
  const relays: FakeRelayPort[] = [];
  const secret = Buffer.alloc(32, 9);
  const member = keypairFromSeed('membro-voz');
  const sessionId = 'sess-voz-1';
  const expiresAt = clock.now() + 300_000;
  let nextRelayPort = 40_000;
  // RFC 5766 §9: a permissão é por IP e a porta do `XOR-PEER-ADDRESS` é ignorada. O
  // roster do host é, portanto, um conjunto de IPs — e é o que torna a ponte de B27
  // possível: a porta de origem do `RTCPeerConnection` é de outra socket que não a do UDX.
  const roster = new Set<string>([PEER_ADDR.host]);
  const server = new MediaServer({
    realm: REALM,
    hostTurnSecret: secret,
    socket: socket.port,
    openRelayPort: async () => {
      const relay = new FakeRelayPort({ host: '203.0.113.10', port: nextRelayPort++ });
      relays.push(relay);
      return relay;
    },
    sessionPeerKeys: () => new Set([member.publicKey.toString('hex')]),
    rosterAddresses: () => roster,
    now: clock.now,
    ...overrides,
  });
  const cred = issueTurnCredential(secret, sessionId, member.publicKey, expiresAt);
  return {
    clock,
    socket,
    relays,
    server,
    secret,
    member,
    sessionId,
    username: cred.username,
    password: cred.password,
    roster,
  };
}

function findChallengeNonce(f: Fixture): string | null {
  for (let i = f.socket.sents.length - 1; i >= 0; i--) {
    const dec = decode(f.socket.sents[i]!.data);
    if (dec?.errorCode === 401 && dec.nonce !== undefined) return dec.nonce;
  }
  return null;
}

function currentNonce(f: Fixture): string {
  const found = findChallengeNonce(f);
  if (found !== null) return found;
  f.server.handleDatagram(encodeTurnRequest(TURN_ALLOCATE, randomTxId(), []), CLIENT);
  return findChallengeNonce(f)!;
}

function authedRequest(
  f: Fixture,
  type: number,
  attrs: Parameters<typeof encodeTurnRequest>[2],
  overrides: { client?: MediaAddr; username?: string; password?: string; nonce?: string } = {},
): Buffer {
  const username = overrides.username ?? f.username;
  const nonce = overrides.nonce ?? currentNonce(f);
  const req = encodeTurnRequest(type, randomTxId(), [
    { type: ATTR_USERNAME, value: Buffer.from(username, 'utf8') },
    { type: ATTR_REALM, value: Buffer.from(REALM, 'utf8') },
    { type: ATTR_NONCE, value: Buffer.from(nonce, 'utf8') },
    ...attrs,
  ]);
  return addMessageIntegrity(req, longTermKey(username, REALM, overrides.password ?? f.password));
}

async function drain(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
}

async function allocate(f: Fixture): Promise<void> {
  f.server.handleDatagram(authedRequest(f, TURN_ALLOCATE, []), CLIENT);
  await drain();
}

function grantPermission(f: Fixture): void {
  f.server.handleDatagram(
    authedRequest(f, TURN_CREATE_PERMISSION, [{ type: ATTR_XOR_PEER, value: xorPeerValue(PEER_ADDR) }]),
    CLIENT,
  );
}

function indication(f: Fixture, type: number, peer: MediaAddr, data: Buffer, client: MediaAddr = CLIENT): void {
  // Indicações também carregam MESSAGE-INTEGRITY com a credencial de curta duração
  f.server.handleDatagram(
    authedRequest(f, type, [
      { type: ATTR_XOR_PEER, value: xorPeerValue(peer) },
      { type: ATTR_DATA, value: data },
    ]),
    client,
  );
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n, 0);
  return b;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

function xorPeerValue(addr: MediaAddr): Buffer {
  const value = Buffer.alloc(8);
  value[1] = 0x01;
  value.writeUInt16BE(addr.port ^ 0x2112, 2);
  const ip = addr.host.split('.').map((s) => Number.parseInt(s, 10));
  for (let i = 0; i < 4; i++) value[4 + i] = ip[i]! ^ [0x21, 0x12, 0xa4, 0x42][i]!;
  return value;
}

/** Reenquadra a resposta removendo o MESSAGE-INTEGRITY final para inspecionar atributos. */
function stripMessageIntegrity(buf: Buffer): Buffer {
  const stripped = buf.readUInt16BE(2) - 24;
  const head = Buffer.from(buf.subarray(0, 20));
  head.writeUInt16BE(stripped, 2);
  return Buffer.concat([head, buf.subarray(20, 20 + stripped)]);
}

// ─── Demux §17.3 ────────────────────────────────────────────────────────────────────────

describe('demux §17.3 na socket compartilhada', () => {
  it('regra literal: bits 00 + magic cookie + comprimento coerente é STUN', () => {
    assert.equal(classifyInbound(encodeBindingRequest()), 'stun');
  });

  it('UDX real (primeiro byte 0xff) e lixo vão para a pilha UDX', () => {
    const udx = Buffer.concat([Buffer.from([0xff, 0x51, 0x00]), Buffer.alloc(64, 0xab)]);
    assert.equal(classifyInbound(udx), 'udx');
    assert.equal(classifyInbound(Buffer.alloc(0)), 'udx');
    assert.equal(classifyInbound(Buffer.alloc(19)), 'udx');
  });

  it('adversarial: cookie errado, bits 10/11 e length mentirosa não são STUN', () => {
    const base = encodeBindingRequest();

    const cookieErrado = Buffer.from(base);
    cookieErrado.writeUInt32BE(0xdeadbeef, 4);
    assert.equal(classifyInbound(cookieErrado), 'udx');

    for (const first of [0x80, 0xc0]) {
      const b = Buffer.from(base);
      b[0] = first;
      assert.equal(classifyInbound(b), 'udx');
    }

    const lenErrada = Buffer.from(base);
    lenErrada.writeUInt16BE(4, 2);
    assert.equal(classifyInbound(lenErrada), 'udx');
  });

  it('ChannelData (bits 01) é roteado ao TURN antes do fallback UDX', () => {
    const frame = frameChannelData(0x4001, Buffer.from('srtp'));
    assert.equal(classifyInbound(frame), 'channel-data');
    assert.deepEqual(parseChannelData(frame), { channel: 0x4001, data: Buffer.from('srtp') });
  });

  it('handleDatagram devolve udx intacto para a pilha UDX e consome STUN', async () => {
    const f = fixture();
    const udx = Buffer.concat([Buffer.from([0xff]), Buffer.alloc(31, 1)]);
    assert.equal(f.server.handleDatagram(udx, CLIENT), 'udx');
    assert.equal(f.server.handleDatagram(encodeBindingRequest(), CLIENT), 'stun');
    await drain();
    assert.equal(f.socket.sents.length, 1); // só o Binding gerou resposta
  });
});

// ─── STUN Binding ───────────────────────────────────────────────────────────────────────

describe('STUN Binding (RFC 5389)', () => {
  it('responde XOR-MAPPED-ADDRESS com o endereço de origem observado', async () => {
    const f = fixture();
    const txId = Buffer.from('txid-binding'); // 12 B
    f.server.handleDatagram(encodeBindingRequest(txId), CLIENT);
    await drain();
    assert.equal(f.server.counters.bindingRequests, 1);
    assert.equal(f.socket.sents.length, 1);
    const dec = decode(f.socket.sents[0]!.data);
    assert.ok(dec !== null);
    assert.equal(dec.type, 0x0101);
    assert.deepEqual(dec.txId, txId);
    assert.deepEqual(dec.xorMapped, CLIENT);
  });
});

// ─── Allocate e autenticação ────────────────────────────────────────────────────────────

describe('TURN Allocate com credencial de curta duração (§17.3)', () => {
  it('sem MESSAGE-INTEGRITY responde 401 com realm+nonce', async () => {
    const f = fixture();
    f.server.handleDatagram(encodeTurnRequest(TURN_ALLOCATE, randomTxId(), []), CLIENT);
    await drain();
    const dec = decode(f.socket.sents[0]!.data);
    assert.equal(dec?.errorCode, 401);
    assert.equal(dec?.realm, REALM);
    assert.ok((dec?.nonce ?? '').length > 0);
    assert.equal(f.server.counters.allocates, 0);
  });

  it('credencial válida do roster aloca e devolve XOR-RELAYED/XOR-MAPPED/LIFETIME autenticados', async () => {
    const f = fixture({ allocTtlMs: 600_000 });
    await allocate(f);
    assert.equal(f.server.counters.allocates, 1);
    const raw = f.socket.sents.at(-1)!.data; // a última resposta é o Allocate Success
    const dec = stripMessageIntegrity(raw);
    const parsed = decode(dec);
    assert.equal(parsed?.type, 0x0103);
    assert.deepEqual(parsed?.xorRelayed, f.relays[0]!.addr);
    assert.deepEqual(parsed?.xorMapped, CLIENT);
    assert.equal(parsed?.lifetimeSec, 600);
    // resposta autenticada com a chave long-term derivada da senha emitida
    assert.ok(verifyMessageIntegrity(raw, longTermKey(f.username, REALM, f.password)));
  });

  it('senha errada é recusada sem novo desafio', async () => {
    const f = fixture();
    currentNonce(f); // provoca o 401 inicial
    const antes = f.socket.sents.length;
    f.server.handleDatagram(authedRequest(f, TURN_ALLOCATE, [], { password: 'senha-errada' }), CLIENT);
    await drain();
    assert.equal(decode(f.socket.sents[antes]!.data)?.errorCode, 401);
    assert.equal(f.server.counters.authFailures, 1);
  });

  it('par sem sessão de voz ativa é recusado (§17.3: só membro com sessão ativa)', async () => {
    const f = fixture({ sessionPeerKeys: () => new Set<string>() });
    f.server.handleDatagram(authedRequest(f, TURN_ALLOCATE, []), CLIENT);
    await drain();
    assert.equal(decode(f.socket.sents.at(-1)!.data)?.errorCode, 401);
  });

  it('credencial expirada é recusada', async () => {
    const f = fixture();
    f.clock.advance(301_000);
    f.server.handleDatagram(authedRequest(f, TURN_ALLOCATE, []), CLIENT);
    await drain();
    assert.equal(decode(f.socket.sents.at(-1)!.data)?.errorCode, 401);
  });

  it('REQUESTED-TRANSPORT diferente de UDP é recusado com 442', async () => {
    const f = fixture();
    currentNonce(f);
    const antes = f.socket.sents.length;
    f.server.handleDatagram(
      authedRequest(f, TURN_ALLOCATE, [{ type: 0x0019, value: Buffer.from([6, 0, 0, 0]) }]),
      CLIENT,
    );
    await drain();
    assert.equal(decode(f.socket.sents[antes]!.data)?.errorCode, 442);
  });

  it('terceira alocação do mesmo membro excede TURN_ALLOC_PER_MEMBER → 486', async () => {
    const f = fixture();
    await allocate(f);
    const client2: MediaAddr = { host: CLIENT.host, port: 50_002 };
    const client3: MediaAddr = { host: CLIENT.host, port: 50_003 };
    f.server.handleDatagram(authedRequest(f, TURN_ALLOCATE, []), client2);
    await drain();
    f.server.handleDatagram(authedRequest(f, TURN_ALLOCATE, []), client3);
    await drain();
    assert.equal(decode(f.socket.sents.at(-1)!.data)?.errorCode, 486);
    assert.equal(f.server.allocationCount, 2);
  });

  it('segundo Allocate no mesmo 5-tuple é 437 Allocation Mismatch', async () => {
    const f = fixture();
    await allocate(f);
    const antes = f.socket.sents.length;
    f.server.handleDatagram(authedRequest(f, TURN_ALLOCATE, []), CLIENT);
    await drain();
    assert.equal(decode(f.socket.sents[antes]!.data)?.errorCode, 437);
  });
});

// ─── Refresh / permissão / canal / dados ────────────────────────────────────────────────

describe('TURN Refresh, CreatePermission, ChannelBind e Send/Data', () => {
  it('refresh renova dentro do TTL; lifetime 0 fecha; alloc inexistente é 437', async () => {
    const f = fixture({ allocTtlMs: 60_000 });
    await allocate(f);

    f.clock.advance(59_000);
    f.server.handleDatagram(authedRequest(f, TURN_REFRESH, [{ type: ATTR_LIFETIME, value: u32(120) }]), CLIENT);
    await drain();
    assert.equal(f.server.counters.refreshes, 1);
    // a vida concedida é a política do host, não a pedida
    assert.equal(decode(stripMessageIntegrity(f.socket.sents.at(-1)!.data))?.lifetimeSec, 60);
    assert.equal(f.server.allocationFor(`${CLIENT.host}:${CLIENT.port}`)?.bytesRelayed, 0);

    f.clock.advance(59_000); // renovado até ~118 s; ainda vivo
    assert.equal(f.server.sweep(), 0);
    assert.equal(f.server.allocationCount, 1);

    f.server.handleDatagram(authedRequest(f, TURN_REFRESH, [{ type: ATTR_LIFETIME, value: u32(0) }]), CLIENT);
    await drain();
    assert.equal(f.server.allocationCount, 0);
    assert.ok(f.relays[0]!.closed);

    const apos = f.socket.sents.length;
    f.server.handleDatagram(authedRequest(f, TURN_REFRESH, []), CLIENT);
    await drain();
    assert.equal(decode(f.socket.sents[apos]!.data)?.errorCode, 437);
  });

  it('permissão só para endereços do roster da sessão (§17.3)', async () => {
    const f = fixture();
    await allocate(f);

    grantPermission(f);
    await drain();
    assert.equal(f.server.counters.permissionsGranted, 1);
    assert.equal(decode(stripMessageIntegrity(f.socket.sents.at(-1)!.data))?.type, 0x0108);

    const fora: MediaAddr = { host: '192.0.2.99', port: 9 };
    f.server.handleDatagram(
      authedRequest(f, TURN_CREATE_PERMISSION, [{ type: ATTR_XOR_PEER, value: xorPeerValue(fora) }]),
      CLIENT,
    );
    await drain();
    assert.equal(f.server.counters.permissionsRefused, 1);
    assert.equal(decode(f.socket.sents.at(-1)!.data)?.errorCode, 403);

    // Send indication para endereço sem permissão não repassa
    indication(f, TURN_SEND, fora, Buffer.from('x'));
    await drain();
    assert.equal(f.relays[0]!.sents.length, 0);
    assert.equal(f.server.counters.notPermittedDropped, 1);
  });

  it('Send indication permitido repassa ao par; dado do par volta como Data indication', async () => {
    const f = fixture();
    await allocate(f);
    grantPermission(f);
    await drain();

    const payload = Buffer.alloc(160, 7); // cadência de voz do gate
    indication(f, TURN_SEND, PEER_ADDR, payload);
    await drain();
    assert.equal(f.server.counters.relayedPackets, 1);
    assert.equal(f.server.counters.relayedBytes, payload.length);
    assert.deepEqual(f.relays[0]!.sents[0], { data: payload, addr: PEER_ADDR });

    f.relays[0]!.receive(Buffer.from('eco'), PEER_ADDR);
    await drain();
    const back = decode(f.socket.sents.at(-1)!.data);
    assert.equal(back?.type, 0x0017);
    assert.deepEqual(back?.xorPeer, PEER_ADDR);
    assert.deepEqual(back?.data, Buffer.from('eco'));
    assert.equal(f.server.counters.dataIndications, 1);
  });

  it('Send indication de alocação inexistente ou sem MI não repassa', async () => {
    const f = fixture();
    indication(f, TURN_SEND, PEER_ADDR, Buffer.from('fantasma'));
    await drain();
    assert.equal(f.relays.length, 0);

    await allocate(f);
    grantPermission(f);
    const req = encodeTurnRequest(TURN_SEND, randomTxId(), [
      { type: ATTR_XOR_PEER, value: xorPeerValue(PEER_ADDR) },
      { type: ATTR_DATA, value: Buffer.from('sem-mi') },
    ]);
    const antes = f.relays[0]!.sents.length;
    f.server.handleDatagram(req, CLIENT); // sem MESSAGE-INTEGRITY
    await drain();
    assert.equal(f.relays[0]!.sents.length, antes);
  });

  it('ChannelBind fora do roster é 403; dentro do roster troca ChannelData nos dois sentidos', async () => {
    const f = fixture();
    await allocate(f);
    const bindFrame = (peer: MediaAddr): Buffer =>
      authedRequest(f, TURN_CHANNEL_BIND, [
        // CHANNEL-NUMBER é 0x000C (RFC 5766 §14.1), 2 B de canal + 2 B RFFU — que é o que
        // o Chromium manda. O decodificador o lia de 0x0006 e este teste montava o pedido
        // do mesmo jeito errado, então todo ChannelBind de cliente real voltava 400.
        { type: ATTR_CHANNEL_NUMBER, value: Buffer.concat([u16(0x4000), u16(0)]) },
        { type: ATTR_XOR_PEER, value: xorPeerValue(peer) },
      ]);

    f.server.handleDatagram(bindFrame({ host: '198.51.100.1', port: 1 }), CLIENT);
    await drain();
    assert.equal(decode(f.socket.sents.at(-1)!.data)?.errorCode, 403);

    f.server.handleDatagram(bindFrame(PEER_ADDR), CLIENT);
    await drain();
    assert.equal(f.server.counters.channelBinds, 1);
    assert.ok(verifyMessageIntegrity(f.socket.sents.at(-1)!.data, longTermKey(f.username, REALM, f.password)));
    assert.equal(decode(stripMessageIntegrity(f.socket.sents.at(-1)!.data))?.type, 0x0109);

    // cliente → par via ChannelData na socket compartilhada
    assert.equal(f.server.handleDatagram(frameChannelData(0x4000, Buffer.from('ida')), CLIENT), 'channel-data');
    await drain();
    assert.deepEqual(f.relays[0]!.sents[0]?.data, Buffer.from('ida'));

    // par → cliente volta enquadradо como ChannelData do canal
    f.relays[0]!.receive(Buffer.from('volta'), PEER_ADDR);
    await drain();
    const frame = parseChannelData(f.socket.sents.at(-1)!.data);
    assert.ok(frame !== null);
    assert.equal(frame.channel, 0x4000);
    assert.deepEqual(frame.data, Buffer.from('volta'));

    // canal já ligado a outro par é recusado. O `outroPar` está no MESMO IP e por isso já
    // é permitido (§9): o 400 aqui é do canal, não da permissão — que é a distinção entre
    // as duas chaves, permissão por IP e canal por endereço de transporte (§11).
    const outroPar: MediaAddr = { host: PEER_ADDR.host, port: 60_066 };
    f.server.handleDatagram(bindFrame(outroPar), CLIENT);
    await drain();
    assert.equal(decode(f.socket.sents.at(-1)!.data)?.errorCode, 400);
  });
});

// ─── Controles §17.3: taxa, teto de bytes, TTL ──────────────────────────────────────────

describe('controles §17.3 do TURN do host', () => {
  it('taxa acima de TURN_RATE_KBPS é descartada com balde de tokens', async () => {
    const f = fixture({ rateKbps: 8 }); // 1 KB/s, rajada de 1000 B
    await allocate(f);
    grantPermission(f);
    await drain();

    for (let i = 0; i < 5; i++) {
      indication(f, TURN_SEND, PEER_ADDR, Buffer.alloc(900, 1));
    }
    await drain();
    assert.equal(f.server.counters.rateDropped, 4);
    assert.equal(f.server.counters.relayedBytes, 900);

    f.clock.advance(2000); // dois segundos de tokens novos
    indication(f, TURN_SEND, PEER_ADDR, Buffer.alloc(900, 1));
    await drain();
    assert.equal(f.server.counters.relayedBytes, 1800);
  });

  it('teto TURN_SESSION_MAX_BYTES encerra a alocação', async () => {
    const f = fixture({ rateKbps: 4096, sessionMaxBytes: 1500 });
    await allocate(f);
    grantPermission(f);
    await drain();

    indication(f, TURN_SEND, PEER_ADDR, Buffer.alloc(1000, 2));
    await drain();
    assert.equal(f.server.allocationCount, 1);

    indication(f, TURN_SEND, PEER_ADDR, Buffer.alloc(1000, 2));
    await drain();
    assert.equal(f.server.counters.quotaExceeded, 1);
    assert.equal(f.server.allocationCount, 0);
    assert.ok(f.relays[0]!.closed);
  });

  it('TTL vencido fecha a alocação no sweep', async () => {
    const f = fixture({ allocTtlMs: 60_000 });
    await allocate(f);
    f.clock.advance(61_000);
    assert.equal(f.server.sweep(), 1);
    assert.ok(f.relays[0]!.closed);
    assert.equal(f.server.allocationCount, 0);
  });
});

// ─── Credencial e codec auxiliares ──────────────────────────────────────────────────────

describe('turnCredential de curta duração (§17.3)', () => {
  it('username é <sessionId>:<expiresAt> e a password amarra sessão, par e validade', () => {
    const secret = Buffer.alloc(32, 3);
    const peer = keypairFromSeed('par').publicKey;
    const cred = issueTurnCredential(secret, 'sess-7', peer, 555_000);
    assert.equal(cred.username, 'sess-7:555000');
    assert.equal(cred.password, turnCredentialPassword(secret, 'sess-7', peer, 555_000));
    assert.notEqual(cred.password, turnCredentialPassword(secret, 'sess-7', keypairFromSeed('outro').publicKey, 555_000));
    assert.notEqual(cred.password, turnCredentialPassword(secret, 'sess-7', peer, 556_000));
    assert.notEqual(cred.password, turnCredentialPassword(Buffer.alloc(32, 4), 'sess-7', peer, 555_000));
  });

  it('MESSAGE-INTEGRITY cobre o corpo: byte adulterado é recusado com 401', async () => {
    const f = fixture();
    await allocate(f);
    const tampered = authedRequest(f, TURN_REFRESH, []);
    tampered[20] = (tampered[20] ?? 0) ^ 0xff;
    const antes = f.socket.sents.length;
    f.server.handleDatagram(tampered, CLIENT);
    await drain();
    const resp = decode(f.socket.sents[antes]!.data);
    assert.equal(resp?.errorCode, 401);
    // a alocação original permanece intacta
    assert.equal(f.server.allocationCount, 1);
  });
});

describe('constantes de §27.1/§27.2 aplicáveis à mídia', () => {
  it('config operacional carrega defaults de §27.2', () => {
    const cfg = resolveConfig();
    assert.equal(cfg.turnRateKbps, 512);
    assert.equal(cfg.turnAllocTtlMs, 600_000);
    assert.equal(cfg.turnAllocPerMember, 2);
    assert.equal(cfg.turnSessionMaxBytes, 2 * 1024 * 1024 * 1024);
    assert.equal(cfg.relayMaxBytesPerDay, 5 * 1024 * 1024 * 1024);
    assert.equal(cfg.relayMaxAllocs, 4);
  });
});

// ─── B27: a ponte par→endereço, a permissão por IP e o primer (§17.3) ───────────────────

describe('§17.3 — o caminho relayado: permissão por IP, primer e entrada filtrada (B27)', () => {
  it('permissão casa por IP e ignora a porta — RFC 5766 §9', async () => {
    const f = fixture();
    await allocate(f);

    // Mesmo IP do roster, OUTRA porta. Sob a regra antiga (`host:port`) isto era 403 — e era
    // a razão de o caminho relayado nunca abrir: a porta que o host observa é a da socket do
    // UDX, nunca a do `RTCPeerConnection`, que é de outra socket com outro mapeamento NAT.
    const outraPorta: MediaAddr = { host: PEER_ADDR.host, port: 61_234 };
    f.server.handleDatagram(
      authedRequest(f, TURN_CREATE_PERMISSION, [{ type: ATTR_XOR_PEER, value: xorPeerValue(outraPorta) }]),
      CLIENT,
    );
    await drain();
    assert.equal(f.server.counters.permissionsGranted, 1);
    assert.equal(f.server.counters.permissionsRefused, 0);

    // E o repasse acontece para a porta pedida, que é o que a permissão por IP autoriza.
    indication(f, TURN_SEND, outraPorta, Buffer.from('voz'));
    await drain();
    assert.deepEqual(f.relays[0]!.sents.at(-1), { data: Buffer.from('voz'), addr: outraPorta });
  });

  it('o primer sai pela porta relayada no CreatePermission, com o endereço COMPLETO do par', async () => {
    const primers: Array<{ data: Uint8Array; addr: MediaAddr }> = [];
    const f = fixture({
      primeRelayTo: (relay, peer) => {
        primers.push({ data: new Uint8Array([0]), addr: peer });
        relay.send(new Uint8Array([0]), peer);
      },
    });
    await allocate(f);
    grantPermission(f);
    await drain();

    // A porta não vale para casar a permissão (§9) mas VEM no atributo, e é o único
    // instante em que o host sabe para onde furar o próprio NAT.
    assert.equal(primers.length, 1);
    assert.deepEqual(primers[0]!.addr, PEER_ADDR);
    assert.deepEqual(f.relays[0]!.sents[0], { data: Buffer.from([0]), addr: PEER_ADDR });
  });

  it('dado que chega à porta relayada de IP sem permissão é descartado — RFC 5766 §10', async () => {
    const f = fixture();
    await allocate(f);
    grantPermission(f);
    await drain();

    // O endereço relayado é público: sem esta checagem qualquer máquina que o descubra faz
    // o host entregar bytes ao cliente por ela.
    f.relays[0]!.receive(Buffer.from('injetado'), { host: '198.51.100.7', port: 4 });
    await drain();
    assert.equal(f.server.counters.notPermittedDropped, 1);
    assert.equal(f.server.counters.dataIndications, 0);

    f.relays[0]!.receive(Buffer.from('legítimo'), PEER_ADDR);
    await drain();
    assert.equal(f.server.counters.dataIndications, 1);
  });

  it('retransmissão do MESMO Allocate não vira 437 — RFC 5766 §6.2', async () => {
    // Abrir a porta relayada leva mais que os 500 ms do primeiro retransmit do cliente: o
    // mapeamento externo dela é descoberto por um Binding a um STUN de terceiro. Responder
    // 437 à segunda cópia do mesmo pedido faz o cliente derrubar a porta TURN inteira — e
    // com ela a coleta de candidatos, que então NUNCA termina. Foi metade do que quebrou
    // uma chamada real; a outra metade era anunciar o `turn:` sem nunca fechar o Allocate.
    let abrir: ((relay: RelayPort) => void) | null = null;
    const f = fixture({
      openRelayPort: () =>
        new Promise<RelayPort>((resolve) => {
          abrir = (relay) => resolve(relay);
        }),
    });

    const pedido = authedRequest(f, TURN_ALLOCATE, []);
    f.server.handleDatagram(pedido, CLIENT);
    await drain();
    const apos = f.socket.sents.length;

    // O cliente não viu resposta e retransmite — MESMO `txId`, mesmo 5-tuple.
    f.server.handleDatagram(pedido, CLIENT);
    await drain();
    assert.equal(f.socket.sents.length, apos, 'a retransmissão foi respondida em vez de ignorada');

    // Um Allocate DIFERENTE do mesmo cliente continua sendo 437: aí há conflito de verdade.
    f.server.handleDatagram(authedRequest(f, TURN_ALLOCATE, []), CLIENT);
    await drain();
    assert.equal(decode(f.socket.sents.at(-1)!.data)?.errorCode, 437);

    // E quando a porta abre, o pedido original é respondido normalmente.
    const relay = new FakeRelayPort({ host: '203.0.113.10', port: 40_000 });
    (abrir as unknown as (r: RelayPort) => void)(relay);
    await drain();
    assert.equal(f.server.allocationCount, 1);
  });

  it('o Allocate autenticado é a segunda perna da ponte: prova chave→IP', async () => {
    const observados: Array<{ sessionId: string; peerKeyHex: string; host: string }> = [];
    const f = fixture({
      onPeerObserved: (sessionId, peerKeyHex, addr) => observados.push({ sessionId, peerKeyHex, host: addr.host }),
    });
    await allocate(f);

    assert.ok(observados.length >= 1);
    assert.equal(observados[0]!.sessionId, f.sessionId);
    assert.equal(observados[0]!.peerKeyHex, f.member.publicKey.toString('hex'));
    assert.equal(observados[0]!.host, CLIENT.host);

    // Credencial que não fecha o MAC não observa nada: a ponte é uma PROVA, não um palpite.
    const antes = observados.length;
    f.server.handleDatagram(authedRequest(f, TURN_REFRESH, [], { password: 'errada' }), CLIENT);
    await drain();
    assert.equal(observados.length, antes);
  });
});

// ─── As correções de 2026-09-05 ─────────────────────────────────────────────────────────

describe('§17.3 — o demux não pode comer datagrama UDX (RFC 5766 §11.4)', () => {
  it('primeiro byte na faixa de canal só é ChannelData com Length coerente', () => {
    // O que a regra antiga classificava como ChannelData: qualquer coisa em 0x40–0x7F.
    const udx = Buffer.from([0x51, 0x0a, 0xff, 0xff, 1, 2, 3, 4, 5, 6]);
    assert.equal(classifyInbound(udx), 'udx', 'Length que não casa é UDX, não canal comido');

    const quadro = frameChannelData(0x510a, Buffer.from('carga'));
    assert.equal(classifyInbound(quadro), 'channel-data');

    // Sobre UDP o padding a múltiplo de 4 é opcional (§11.4): até 3 bytes de folga passam.
    assert.equal(classifyInbound(Buffer.concat([quadro, Buffer.alloc(3)])), 'channel-data');
    assert.equal(classifyInbound(Buffer.concat([quadro, Buffer.alloc(4)])), 'udx');
  });

  it('um quarto do corpus adversarial de primeiro byte cai na faixa e nenhum é consumido', () => {
    // Datagramas UDX de comprimento fixo com o campo Length preenchido por acaso: sob a
    // regra antiga ~25 % deles sumiam do transporte. Nenhum pode ser reclassificado aqui.
    let comidos = 0;
    for (let primeiro = 0x40; primeiro <= 0x7f; primeiro++) {
      const d = Buffer.alloc(64, 0xab);
      d[0] = primeiro;
      // Length arbitrário que NÃO é 60 (= 64 − 4): é o caso do datagrama UDX real.
      d.writeUInt16BE(0x1234, 2);
      if (classifyInbound(d) !== 'udx') comidos++;
    }
    assert.equal(comidos, 0);
  });
});

describe('§17.3 — MESSAGE-INTEGRITY cobre a mensagem inteira (RFC 5389 §15.4)', () => {
  it('atributo anexado depois do MESSAGE-INTEGRITY invalida o MAC e não é decodificado', () => {
    const f = fixture();
    const chave = longTermKey(f.username, REALM, f.password);
    const legitimo = authedRequest(f, TURN_CREATE_PERMISSION, [
      { type: ATTR_XOR_PEER, value: xorPeerValue(PEER_ADDR) },
    ]);
    assert.equal(verifyMessageIntegrity(legitimo, chave), true);

    // O MITM anexa um XOR-PEER-ADDRESS forjado e corrige o comprimento do cabeçalho — que
    // não entra no MAC, porque o cálculo o reescreve para terminar no próprio MI.
    const forjado: MediaAddr = { host: '198.51.100.9', port: 4444 };
    const cauda = encodeTurnRequest(TURN_CREATE_PERMISSION, randomTxId(), [
      { type: ATTR_XOR_PEER, value: xorPeerValue(forjado) },
    ]).subarray(20);
    const adulterado = Buffer.concat([legitimo, cauda]);
    adulterado.writeUInt16BE(adulterado.length - 20, 2);

    assert.equal(verifyMessageIntegrity(adulterado, chave), false, 'o MAC não pode fechar sobre o prefixo');
    assert.equal(decode(adulterado)?.xorPeer?.host, PEER_ADDR.host, 'o decode para no MI');
  });
});

describe('§17.3 — CHANNEL-NUMBER é 0x000C (RFC 5766 §14.1)', () => {
  it('ChannelBind sem CHANNEL-NUMBER é 400, e o USERNAME não faz as vezes dele', async () => {
    const f = fixture();
    await allocate(f);
    // O pedido carrega USERNAME (`authedRequest` o põe) e nenhum 0x000C: falta o canal.
    f.server.handleDatagram(
      authedRequest(f, TURN_CHANNEL_BIND, [{ type: ATTR_XOR_PEER, value: xorPeerValue(PEER_ADDR) }]),
      CLIENT,
    );
    await drain();
    assert.equal(decode(stripMessageIntegrity(f.socket.sents.at(-1)!.data))?.errorCode, 400);
    assert.equal(f.server.counters.channelBinds, 0);
  });
});

/**
 * Credencial de vida longa: a do `fixture` vence em 5 min, que é o MESMO prazo da permissão
 * de §9 e menos que o TTL da alocação. Sem isto, todo teste que adianta o relógio para
 * exercitar prazo bate primeiro no 401 da credencial e mede a coisa errada.
 */
function credLonga(f: Fixture): { username: string; password: string } {
  return issueTurnCredential(f.secret, f.sessionId, f.member.publicKey, f.clock.now() + 24 * 3_600_000);
}

describe('§17.3/§17.4 — a alocação não sobrevive à revogação nem ao prazo', () => {
  it('permissão de §9 vence em 5 min e para de entregar nos dois sentidos', async () => {
    const f = fixture();
    const cred = credLonga(f);
    const permitir = (): void => {
      f.server.handleDatagram(
        authedRequest(f, TURN_CREATE_PERMISSION, [{ type: ATTR_XOR_PEER, value: xorPeerValue(PEER_ADDR) }], cred),
        CLIENT,
      );
    };
    f.server.handleDatagram(authedRequest(f, TURN_ALLOCATE, [], cred), CLIENT);
    await drain();
    permitir();
    f.relays[0]!.receive(Buffer.from('antes'), PEER_ADDR);
    await drain();
    assert.equal(f.server.counters.relayedPackets, 1);

    f.clock.advance(300_001);
    f.relays[0]!.receive(Buffer.from('depois'), PEER_ADDR);
    await drain();
    assert.equal(f.server.counters.relayedPackets, 1, 'entrada por permissão vencida é descartada');
    assert.equal(f.server.counters.notPermittedDropped, 1);

    // A renovação é o próprio CreatePermission (§9): concedida de novo, volta a entregar.
    permitir();
    f.relays[0]!.receive(Buffer.from('renovada'), PEER_ADDR);
    await drain();
    assert.equal(f.server.counters.relayedPackets, 2);
  });

  it('`revoke` fecha a alocação do banido — o caminho relayado morre com o roster', async () => {
    const f = fixture();
    await allocate(f);
    grantPermission(f);
    assert.equal(f.server.allocationCount, 1);

    assert.equal(f.server.revoke(f.member.publicKey.toString('hex')), 1);
    assert.equal(f.server.allocationCount, 0);
    assert.equal(f.relays[0]!.closed, true, 'a socket relayada fecha junto');

    // Entrada que chegue depois não tem mais a quem entregar.
    const antes = f.socket.sents.length;
    f.relays[0]!.receive(Buffer.from('tarde'), PEER_ADDR);
    await drain();
    assert.equal(f.socket.sents.length, antes);
  });

  it('o sweep derruba quem saiu do roster mesmo sem evento de revogação', async () => {
    const naSessao = new Set<string>();
    const f = fixture({ sessionPeerKeys: () => naSessao });
    naSessao.add(keypairFromSeed('membro-voz').publicKey.toString('hex'));
    await allocate(f);
    assert.equal(f.server.allocationCount, 1);

    assert.equal(f.server.sweep(), 0, 'quem está na sessão fica');
    naSessao.clear();
    assert.equal(f.server.sweep(), 1);
    assert.equal(f.server.allocationCount, 0);
  });

  it('alocação VENCIDA não tranca o 5-tuple em 437: o Allocate seguinte realoca', async () => {
    const f = fixture();
    const cred = credLonga(f);
    f.server.handleDatagram(authedRequest(f, TURN_ALLOCATE, [], cred), CLIENT);
    await drain();
    assert.equal(f.server.allocationCount, 1);

    // O TTL vence e o sweep ainda não passou — é a janela em que o cliente reAloca.
    f.clock.advance(resolveConfig().turnAllocTtlMs + 1);
    const antes = f.socket.sents.length;
    f.server.handleDatagram(authedRequest(f, TURN_ALLOCATE, [], cred), CLIENT);
    await drain();
    const resposta = decode(stripMessageIntegrity(f.socket.sents.at(-1)!.data));
    assert.notEqual(resposta?.errorCode, 437);
    assert.equal(resposta?.type, 0x0103, 'Allocate Success, não Allocation Mismatch');
    assert.ok(f.socket.sents.length > antes);
    assert.equal(f.server.allocationCount, 1);
  });
});
