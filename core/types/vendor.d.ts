// Tipagem estreita das dependências nativas que o núcleo usa. Declara só o que é chamado —
// um `any` global esconderia exatamente os erros de tamanho de buffer que a criptografia de
// §5.1 não perdoa.

declare module 'sodium-native' {
  /**
   * BLAKE2b sobre a concatenação de `parts`. O comprimento da saída é o de `out`:
   * 32 bytes para BLAKE2b-256, 16 para BLAKE2b-128 (§5.1). O parâmetro de comprimento faz
   * parte do bloco de parâmetros do BLAKE2b — truncar um digest de 64 bytes **não** produz
   * o mesmo valor.
   */
  export function crypto_generichash_batch(out: Buffer, parts: Uint8Array[]): void;
  export function crypto_generichash(out: Buffer, input: Uint8Array, key?: Uint8Array): void;

  /**
   * BLAKE2b incremental — usado pelo `blob.stage` (§13.2 passo 5) desde que a cota por
   * membro saiu (§13.8, 2026-09-04) e o arquivo deixou de caber na RAM por definição.
   * `outlen` entra no bloco de parâmetros: `init` com 32 é o mesmo digest que
   * `crypto_generichash_batch` sobre as mesmas partes.
   */
  export const crypto_generichash_STATEBYTES: number;
  export function crypto_generichash_init(state: Buffer, key: Uint8Array | null, outlen: number): void;
  export function crypto_generichash_update(state: Buffer, input: Uint8Array): void;
  export function crypto_generichash_final(state: Buffer, out: Buffer): void;

  export function randombytes_buf(out: Buffer): void;
  export function sodium_memzero(buf: Buffer): void;

  export const crypto_sign_PUBLICKEYBYTES: number;
  export const crypto_sign_SECRETKEYBYTES: number;
  export const crypto_sign_BYTES: number;
  export const crypto_sign_SEEDBYTES: number;
  export function crypto_sign_seed_keypair(pk: Buffer, sk: Buffer, seed: Uint8Array): void;
  export function crypto_sign_detached(sig: Buffer, message: Uint8Array, sk: Uint8Array): void;
  export function crypto_sign_verify_detached(
    sig: Uint8Array,
    message: Uint8Array,
    pk: Uint8Array,
  ): boolean;

  // ── Sealed box (§18.8 escrow de sucessão) — Ed25519 → X25519 + crypto_box_seal ──────
  export const crypto_box_PUBLICKEYBYTES: number;
  export const crypto_box_SECRETKEYBYTES: number;
  export const crypto_box_SEALBYTES: number;
  /** Converte a chave pública Ed25519 para X25519 — `crypto_box_seal(communitySeed, x25519(targetKey))`. */
  export function crypto_sign_ed25519_pk_to_curve25519(curvePk: Buffer, edPk: Uint8Array): number;
  /** Converte a chave secreta Ed25519 para X25519 — abre o próprio escrow. */
  export function crypto_sign_ed25519_sk_to_curve25519(curveSk: Buffer, edSk: Uint8Array): number;
  export function crypto_box_seal(out: Buffer, message: Uint8Array, curvePk: Uint8Array): number;
  /** Devolve `true` em sucesso; `false` com selo adulterado ou chave errada. */
  export function crypto_box_seal_open(out: Buffer, sealed: Uint8Array, curvePk: Uint8Array, curveSk: Uint8Array): boolean;

  // ── X25519 cru (§31.3 `dmShared`) — o segredo compartilhado dos dois lados da conversa ──
  export const crypto_scalarmult_BYTES: number;
  export const crypto_scalarmult_SCALARBYTES: number;
  /** `q = n · p`. Simétrico: `scalarmult(sk_A, pk_B) === scalarmult(sk_B, pk_A)`. */
  export function crypto_scalarmult(q: Buffer, n: Uint8Array, p: Uint8Array): void;


  export const crypto_aead_xchacha20poly1305_ietf_KEYBYTES: number;
  export const crypto_aead_xchacha20poly1305_ietf_NPUBBYTES: number;
  export const crypto_aead_xchacha20poly1305_ietf_ABYTES: number;
  export function crypto_aead_xchacha20poly1305_ietf_encrypt(
    cipher: Buffer,
    message: Uint8Array,
    additionalData: Uint8Array | null,
    nsec: Uint8Array | null,
    nonce: Uint8Array,
    key: Uint8Array,
  ): void;
  export function crypto_aead_xchacha20poly1305_ietf_decrypt(
    message: Buffer,
    nsec: Uint8Array | null,
    cipher: Uint8Array,
    additionalData: Uint8Array | null,
    nonce: Uint8Array,
    key: Uint8Array,
  ): boolean;

  export const crypto_pwhash_SALTBYTES: number;
  export const crypto_pwhash_OPSLIMIT_MODERATE: number;
  export const crypto_pwhash_MEMLIMIT_MODERATE: number;
  export const crypto_pwhash_ALG_DEFAULT: number;
  export function crypto_pwhash(
    out: Buffer,
    passwd: Uint8Array,
    salt: Uint8Array,
    opsLimit: number,
    memLimit: number,
    alg: number,
  ): void;

  /** `crypto_auth` é HMAC-SHA-256 — usado na credencial TURN de curta duração (§17.3). */
  export const crypto_auth_BYTES: number;
  export const crypto_auth_KEYBYTES: number;
  export function crypto_auth(out: Buffer, message: Uint8Array, key: Uint8Array): void;
  export function crypto_auth_verify(tag: Uint8Array, message: Uint8Array, key: Uint8Array): boolean;
}

declare module 'hypercore' {
  import { EventEmitter } from 'node:events';

  export type HypercoreKeyPair = { publicKey: Buffer; secretKey: Buffer };

  export type HypercoreOptions = {
    /** Chave pública do core. Sem ela, um novo core é criado. */
    key?: Buffer;
    /** Par de chaves do core. Em modo `compat`, `key` precisa casar com `publicKey`. */
    keyPair?: HypercoreKeyPair;
    /** Modo de assinatura clássico: `key` é a própria chave pública (não o hash do manifest). */
    compat?: boolean;
    createIfMissing?: boolean;
  };

  export default class Hypercore extends EventEmitter {
    constructor(storage: string, opts?: HypercoreOptions);
    constructor(storage: string, key?: Buffer | null, opts?: HypercoreOptions);

    /** Chave pública do core (hash do manifest, ou a própria chave em modo `compat`). */
    readonly key: Buffer | null;
    /** §14.1 — o tópico DHT do log é `discoveryKey(coreKey)`. Pronto depois de `ready()`. */
    readonly discoveryKey: Buffer | null;
    readonly length: number;
    readonly remoteContiguousLength: number;
    readonly writable: boolean;
    readonly closed: boolean;

    ready(): Promise<void>;
    append(value: Uint8Array): Promise<number>;
    /**
     * Bloco `seq`. Com `{ wait: false }`, devolve `null` quando o bloco ainda não está
     * disponível (replicação em curso) — é o contrato de leitura do projector (§10.5).
     */
    get(seq: number, opts?: { wait?: boolean }): Promise<Buffer | null>;
    on(
      event: 'append' | 'download' | 'upload' | 'remote-contiguous-length',
      listener: (...args: any[]) => void,
    ): this;
    off(
      event: 'append' | 'download' | 'upload' | 'remote-contiguous-length',
      listener: (...args: any[]) => void,
    ): this;
    /**
     * §14.1 — replica sobre um `Protomux` já montado no stream do Hyperswarm. O hypercore
     * abre o próprio canal no mux; ele não sabe (nem precisa saber) dos canais de §16.
     */
    replicate(muxOrStream: unknown): unknown;
    /**
     * §14.2 — o hypercore é esparso por padrão: sem pedir, nada é baixado. Uma faixa aberta
     * (`end: -1`) é o "replica em background" que ADR-16 exige de toda comunidade
     * participada.
     */
    download(range?: { start?: number; end?: number; linear?: boolean }): { done(): Promise<void>; destroy(): void };
    /**
     * §13.4 passo 4 — o bitfield local: `true` quando **todos** os blocos de `[start, end)`
     * estão aqui (a faixa do vendor é meio-aberta, como em `download`).
     */
    has(start: number, end?: number): Promise<boolean>;
    /**
     * §13.5/§22.4 — libera os blocos LOCAIS de `[start, end)` (faixa do vendor
     * meio-aberta). O dado continua na rede para quem o tiver; aqui só o disco sai.
     */
    clear(start: number, end?: number): Promise<void>;
    /**
     * Pares replicando este core agora. `_remoteHasBlock` é a leitura que o próprio
     * replicator usa para decidir de quem pedir (fonte: `hypercore@11.35.1
     * lib/replicator.js`) — é o "anuncia ter" de §13.4, não uma estimativa nossa.
     */
    readonly peers: ReadonlyArray<{
      readonly remotePublicKey: Buffer | null;
      _remoteHasBlock(index: number): boolean;
      /**
       * §18.7 — até onde este par tem o log de forma CONTÍGUA. É o que o `replicator` do
       * hypercore mantém a partir do bitfield remoto: não é declaração do par, é o que ele
       * anunciou ter. Contígua, e não `remoteLength`, porque a barreira de §18.7 quer quem
       * consegue INTERPRETAR até a cabeça — um par com buraco no meio tem `remoteLength`
       * alto e não interpreta nada depois do buraco (§10.5 passo 6).
       */
      readonly remoteContiguousLength: number;
    }>;
    close(): Promise<void>;
  }
}

// ── Transporte de §14/§16.1 ───────────────────────────────────────────────────────────

declare module 'hyperswarm' {
  import { EventEmitter } from 'node:events';

  /** Stream criptografado do Hyperswarm (`NoiseSecretStream`), visto pelo que se usa dele. */
  export type SwarmStream = {
    readonly remotePublicKey: Buffer;
    readonly publicKey: Buffer;
    on(event: 'close' | 'error', listener: (err?: Error) => void): SwarmStream;
    once(event: 'close' | 'error', listener: (err?: Error) => void): SwarmStream;
    destroy(err?: Error): void;
  };

  /**
   * O cadastro que o hyperswarm mantém do par. É um `EventEmitter` e **vive mais que a
   * conexão**: `topics` cresce a cada redescoberta do par num tópico novo (`_handlePeer` →
   * `peerInfo._topic`), inclusive quando não há `connection` nova porque já existe conexão
   * com aquela chave. `topic` é o aviso dessa mudança.
   */
  export type PeerInfo = {
    readonly publicKey: Buffer;
    readonly topics: Buffer[];
    on(event: 'topic', listener: (topic: Buffer) => void): PeerInfo;
    off(event: 'topic', listener: (topic: Buffer) => void): PeerInfo;
  };

  export type DiscoverySession = { flushed(): Promise<void>; destroy(): Promise<void> };

  export type HyperswarmOptions = {
    bootstrap?: Array<{ host: string; port: number }>;
    keyPair?: { publicKey: Buffer; secretKey: Buffer };
    maxPeers?: number;
    /** §14.3(4) — devolve `true` para **recusar** a conexão antes de qualquer trabalho. */
    firewall?: (remotePublicKey: Buffer) => boolean;
  };

  export default class Hyperswarm extends EventEmitter {
    constructor(opts?: HyperswarmOptions);
    readonly keyPair: { publicKey: Buffer; secretKey: Buffer };
    readonly connections: Set<SwarmStream>;
    join(topic: Buffer, opts?: { server?: boolean; client?: boolean }): DiscoverySession;
    leave(topic: Buffer): Promise<void>;
    /** §31.8 — anuncia este nó na DHT sob o próprio par de identidade, sem tópico. */
    listen(): Promise<void>;
    /** §31.8 — conexão direta a uma chave pública, sem tópico (`L-24`). */
    joinPeer(publicKey: Buffer): void;
    leavePeer(publicKey: Buffer): void;
    flush(): Promise<void>;
    destroy(): Promise<void>;
    on(event: 'connection', listener: (stream: SwarmStream, info: PeerInfo) => void): this;
  }
}

declare module 'protomux' {
  export type ProtomuxMessage = {
    send(data: Uint8Array): boolean;
  };

  export type ProtomuxChannel = {
    open(handshake?: unknown): void;
    close(): void;
    addMessage(opts: {
      encoding: unknown;
      onmessage?: (data: Uint8Array) => void;
    }): ProtomuxMessage;
  };

  export default class Protomux {
    static from(stream: unknown): Protomux;
    /** Registra o lado **respondedor**: o canal só nasce quando o par o pede (§16.1). */
    pair(opts: { protocol: string; id?: Buffer }, onpair: () => void): void;
    unpair(opts: { protocol: string; id?: Buffer }): void;
    createChannel(opts: {
      protocol: string;
      id?: Buffer;
      unique?: boolean;
      handshake?: unknown;
      onopen?: () => void;
      onclose?: () => void;
      ondestroy?: () => void;
    }): ProtomuxChannel | null;
    destroy(err?: Error): void;
  }
}

declare module 'compact-encoding' {
  /** Bytes crus com prefixo de comprimento — a codificação dos quadros de §16.1. */
  export const raw: unknown;
}

declare module 'hyperdht/testnet.js' {
  /** Rede DHT local para teste (§28.5) — bootstrap isolado, sem tocar a rede pública. */
  export default function createTestnet(
    size?: number,
    opts?: { teardown?: (fn: () => void) => void },
  ): Promise<{
    readonly bootstrap: Array<{ host: string; port: number }>;
    destroy(): Promise<void>;
  }>;
}

/**
 * `@hyperswarm/secret-stream` — o Noise que o `hyperswarm` põe em cada conexão (§5.1). Só o
 * recorte que o cabo de teste de §31 usa: montar o par autenticado sem DHT.
 */
declare module '@hyperswarm/secret-stream' {
  import type { SwarmStream } from 'hyperswarm';

  export default class SecretStream {
    constructor(
      isInitiator: boolean,
      rawStream?: unknown,
      opts?: { keyPair?: { publicKey: Buffer; secretKey: Buffer } },
    );
    readonly publicKey: Buffer;
    readonly remotePublicKey: Buffer;
    /** Resolve quando o handshake fecha. É o que o `hypercore` espera em `attachTo`. */
    readonly opened: Promise<boolean>;
    destroy(err?: Error): void;
    on(event: string, listener: (...args: unknown[]) => void): SecretStream;
    once(event: string, listener: (...args: unknown[]) => void): SecretStream;
  }

  export type { SwarmStream };
}
