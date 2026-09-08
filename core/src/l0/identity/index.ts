// `identity` — L0, par Ed25519, assinatura, verificação, export/import (§4, §5.1, §5.5, §6.1, §3.2, A13).
//
// §4: depende de `keystore` + `manifest` (§10.2: `manifest.secrets` guarda `data_key` e
// `identity_seed`; L0→L0 declarada em `scripts/check-layers.ts`).
// §4: NUNCA expõe material privado por IPC-R, log ou erro.
//
// Cifra simétrica em repouso: XChaCha20-Poly1305 (§5.1), via
// `crypto_aead_xchacha20poly1305_ietf_*` do `sodium-native`.

import fs from 'node:fs';
import path from 'node:path';
import sodium from 'sodium-native';

import type { KeystoreOracle } from '../keystore/index.ts';
import { ManifestDb } from '../manifest/index.ts';

// --- Crockford-Base32 para handle (§6.1) ---

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function crockford32(bytes: Uint8Array): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(acc >>> bits) & 31] as string;
    }
  }
  if (bits > 0) out += CROCKFORD[(acc << (5 - bits)) & 31] as string;
  return out;
}

/** §6.1: '@' + 8 Crockford-Base32 minúsculos da publicKey, em 2 grupos de 4 (@k3f9-2mqa). */
export function computeHandle(publicKey: Uint8Array): string {
  const full = crockford32(publicKey.subarray(0, 5)).toLowerCase();
  const c8 = full.slice(0, 8);
  return `@${c8.slice(0, 4)}-${c8.slice(4, 8)}`;
}

// --- XChaCha20-Poly1305 helpers (§5.1: cifra simétrica em repouso) ---

const KEYBYTES = sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES;
const NPUBBYTES = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
const ABYTES = sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES;

/** Cifra com XChaCha20-Poly1305. Devolve nonce ‖ ciphertext. */
function aeadSeal(plain: Buffer, key: Buffer): Buffer {
  const nonce = Buffer.alloc(NPUBBYTES);
  sodium.randombytes_buf(nonce);
  const cipher = Buffer.alloc(plain.length + ABYTES);
  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    cipher,
    plain,
    null,
    null,
    nonce,
    key,
  );
  return Buffer.concat([nonce, cipher]);
}

/** Decifra. Entrada: nonce ‖ ciphertext. Lança se autenticação falha. */
function aeadOpen(box: Buffer, key: Buffer): Buffer {
  if (box.length < NPUBBYTES + ABYTES) {
    throw new Error('Ciphertext curto demais');
  }
  const nonce = box.subarray(0, NPUBBYTES);
  const cipher = box.subarray(NPUBBYTES);
  const plain = Buffer.alloc(cipher.length - ABYTES);
  try {
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      plain,
      null,
      cipher,
      null,
      nonce,
      key,
    );
  } catch {
    throw new Error(
      'Falha de decifragem: autenticação violada ou chave incorreta',
    );
  }
  return plain;
}

// --- Argon2id (§5.1: derivação de chave por frase secreta — MODERATE) ---

function keyFromPassphrase(passphrase: string, salt: Buffer): Buffer {
  const key = Buffer.alloc(KEYBYTES);
  const passBuf = Buffer.from(passphrase, 'utf8');
  try {
    sodium.crypto_pwhash(
      key,
      passBuf,
      salt,
      sodium.crypto_pwhash_OPSLIMIT_MODERATE,
      sodium.crypto_pwhash_MEMLIMIT_MODERATE,
      sodium.crypto_pwhash_ALG_DEFAULT,
    );
  } finally {
    passBuf.fill(0);
  }
  return key;
}

// --- Tipos ---

export type IdentityRecord = {
  readonly publicKey: Buffer;
  readonly publicKeyHex: string;
  readonly handle: string;
  readonly displayName: string;
  readonly avatarColor: number;
  readonly createdAt: number;
  readonly presence: string;
};

type IdentityMeta = {
  displayName: string;
  avatarColor: number;
  createdAt: number;
  presence: string;
};

export type ExportCommunity = {
  readonly communityId: string;
  readonly coreKey: Buffer;
  readonly blobsKey: Buffer;
  readonly communitySeed?: Buffer;
};

// --- IdentityManager ---

export class IdentityManager {
  readonly #dataDir: string;
  readonly #oracle: KeystoreOracle;
  readonly #manifest: ManifestDb | null;
  #identitySeed: Buffer | null = null;
  #secretKey: Buffer | null = null;
  #publicKey: Buffer | null = null;
  #meta: IdentityMeta | null = null;

  constructor(dataDir: string, oracle: KeystoreOracle, manifestDb?: ManifestDb | null) {
    this.#dataDir = dataDir;
    this.#oracle = oracle;
    // Injeção preferencial; se não vier, tenta abrir o manifest.db existente no mesmo
    // diretório (compatibilidade com testes legados que só passam dataDir).
    if (manifestDb !== undefined) {
      this.#manifest = manifestDb;
    } else {
      const manifestPath = path.join(dataDir, 'manifest.db');
      if (fs.existsSync(manifestPath)) {
        try {
          this.#manifest = new ManifestDb(manifestPath);
        } catch {
          this.#manifest = null;
        }
      } else {
        this.#manifest = null;
      }
    }
  }

  get isLoaded(): boolean {
    return this.#publicKey !== null;
  }

  get publicKey(): Buffer | null {
    return this.#publicKey ? Buffer.from(this.#publicKey) : null;
  }

  get publicKeyHex(): string | null {
    return this.#publicKey ? this.#publicKey.toString('hex') : null;
  }

  get handle(): string | null {
    return this.#publicKey ? computeHandle(this.#publicKey) : null;
  }

  get record(): IdentityRecord | null {
    if (this.#publicKey === null || this.#meta === null) return null;
    return {
      publicKey: Buffer.from(this.#publicKey),
      publicKeyHex: this.#publicKey.toString('hex'),
      handle: computeHandle(this.#publicKey),
      displayName: this.#meta.displayName,
      avatarColor: this.#meta.avatarColor,
      createdAt: this.#meta.createdAt,
      presence: this.#meta.presence,
    };
  }

  setPresence(p: string): void {
    if (this.#meta === null) throw new Error('Identidade não carregada');
    this.#meta = { ...this.#meta, presence: p };
  }

  /**
   * O par Ed25519 local para quem assina DENTRO do núcleo (ponte de submissão §19.3,
   * derivações de §5.2). §3.2: material privado nunca cruza IPC-R, log ou erro — a cópia
   * existe para o mesmo processo que o `IdentityManager` já serve.
   */
  getKeyPair(): { publicKey: Buffer; secretKey: Buffer } | null {
    if (this.#publicKey === null || this.#secretKey === null) return null;
    return { publicKey: Buffer.from(this.#publicKey), secretKey: Buffer.from(this.#secretKey) };
  }

  updateProfile(displayName?: string, avatarColor?: number): void {
    if (this.#meta === null) throw new Error('Identidade não carregada');
    this.#meta = {
      ...this.#meta,
      displayName: displayName ?? this.#meta.displayName,
      avatarColor: avatarColor ?? this.#meta.avatarColor,
    };
    this.#saveMeta();
  }

  sign(hash: Buffer): Buffer {
    if (this.#secretKey === null) throw new Error('Sem chave privada');
    const sig = Buffer.alloc(sodium.crypto_sign_BYTES);
    sodium.crypto_sign_detached(sig, hash, this.#secretKey);
    return sig;
  }

  #hasManifestSecrets(): boolean {
    if (this.#manifest === null) return false;
    try {
      return this.#manifest.hasSecret('data_key') && this.#manifest.hasSecret('identity_seed');
    } catch {
      return false;
    }
  }

  async #loadFromManifest(): Promise<boolean> {
    if (this.#manifest === null) return false;
    if (!this.#hasManifestSecrets()) return false;
    const dataKeyRec = this.#manifest.getSecret('data_key');
    const seedRec = this.#manifest.getSecret('identity_seed');
    if (dataKeyRec === null || seedRec === null) return false;
    // data_key: wrapped base64 utf8 em ciphertext
    const wrappedB64 = dataKeyRec.ciphertext.toString('utf8').trim();
    const dataKeyB64 = await this.#oracle.unwrapDataKey(wrappedB64);
    const dataKey = Buffer.from(dataKeyB64, 'base64');
    let seed: Buffer | null = null;
    try {
      const encryptedSeed = seedRec.ciphertext;
      seed = aeadOpen(encryptedSeed, dataKey);
      this.#initKeys(seed);
    } finally {
      sodium.sodium_memzero(dataKey);
      // §3.2 item 4 — `#initKeys` guarda uma CÓPIA da semente; a original decifrada aqui
      // não tem mais dono e não pode ficar no heap esperando o coletor.
      if (seed !== null) sodium.sodium_memzero(seed);
    }
    // meta: tenta manifest meta primeiro, depois arquivo
    const metaJson = this.#manifest.metaGet('identity_meta');
    if (metaJson !== null) {
      try {
        this.#meta = JSON.parse(metaJson) as IdentityMeta;
      } catch {
        this.#meta = { displayName: 'Membro', avatarColor: 0, createdAt: Date.now(), presence: 'online' };
      }
    } else {
      const metaPath = path.join(this.#dataDir, 'identity.meta.json');
      if (fs.existsSync(metaPath)) {
        try {
          this.#meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as IdentityMeta;
        } catch {
          this.#meta = { displayName: 'Membro', avatarColor: 0, createdAt: Date.now(), presence: 'online' };
        }
      } else {
        this.#meta = { displayName: 'Membro', avatarColor: 0, createdAt: Date.now(), presence: 'online' };
      }
    }
    return true;
  }

  async #loadFromFile(): Promise<boolean> {
    const keyPath = path.join(this.#dataDir, 'identity.enc');
    const dataKeyPath = path.join(this.#dataDir, 'datakey.wrapped');
    const metaPath = path.join(this.#dataDir, 'identity.meta.json');
    if (!fs.existsSync(keyPath) || !fs.existsSync(dataKeyPath)) {
      return false;
    }
    const wrappedB64 = fs.readFileSync(dataKeyPath, 'utf8').trim();
    const dataKeyB64 = await this.#oracle.unwrapDataKey(wrappedB64);
    const dataKey = Buffer.from(dataKeyB64, 'base64');
    let seed: Buffer | null = null;
    try {
      const encryptedSeed = fs.readFileSync(keyPath);
      seed = aeadOpen(encryptedSeed, dataKey);
      this.#initKeys(seed);
      if (fs.existsSync(metaPath)) {
        try {
          this.#meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as IdentityMeta;
        } catch {
          this.#meta = { displayName: 'Membro', avatarColor: 0, createdAt: Date.now(), presence: 'online' };
        }
      } else {
        this.#meta = { displayName: 'Membro', avatarColor: 0, createdAt: Date.now(), presence: 'online' };
      }
      /**
       * Migração para `manifest.secrets` (§10.2), com a **mesma** Data Key que acabou de
       * abrir a semente — e não uma nova sorteada aqui.
       *
       * §5.4 é "UMA Data Key por instalação", e era ela que o formato antigo quebrava: a
       * composição lê `secrets.data_key` para ter a Data Key do processo, não achava linha
       * nenhuma e sorteava uma chave nova, enquanto `communities.community_seed_enc` e
       * `member_blobs_core.secret_seed_enc` seguiam selados pela original. Resultado: o host
       * não derivava a própria chave de escrita. Gravar as duas linhas aqui faz a instalação
       * legada convergir para o caminho canônico no primeiro boot.
       */
      if (this.#manifest !== null && !this.#hasManifestSecrets()) {
        this.#saveToManifest(seed, dataKey, wrappedB64);
      }
    } finally {
      sodium.sodium_memzero(dataKey);
      if (seed !== null) sodium.sodium_memzero(seed);
    }
    return true;
  }

  async load(): Promise<boolean> {
    // §10.2: tenta manifest.secrets primeiro, depois arquivo (compatibilidade).
    if (this.#manifest !== null && this.#hasManifestSecrets()) {
      return this.#loadFromManifest();
    }
    return this.#loadFromFile();
  }

  #saveToManifest(seed: Buffer, dataKey: Buffer, wrappedB64: string): void {
    if (this.#manifest === null) return;
    // §10.2: secrets.data_key é a Data Key embrulhada por safeStorage (via oracle)
    this.#manifest.setSecret('data_key', Buffer.from(wrappedB64, 'utf8'), null);
    // §10.2: secrets.identity_seed é a semente cifrada pela Data Key (XChaCha20-Poly1305)
    this.#manifest.setSecret('identity_seed', aeadSeal(seed, dataKey), null);
    if (this.#publicKey !== null) {
      this.#manifest.metaSet('identity_public_key', this.#publicKey.toString('hex'));
    }
    if (this.#meta !== null) {
      this.#manifest.metaSet('identity_meta', JSON.stringify(this.#meta));
    }
  }

  #saveToFile(seed: Buffer, dataKey: Buffer, wrappedB64: string): void {
    fs.mkdirSync(this.#dataDir, { recursive: true });
    const keyPath = path.join(this.#dataDir, 'identity.enc');
    const dataKeyPath = path.join(this.#dataDir, 'datakey.wrapped');
    fs.writeFileSync(keyPath, aeadSeal(seed, dataKey));
    fs.writeFileSync(dataKeyPath, wrappedB64, 'utf8');
  }

  async create(
    displayName: string,
    avatarColor: number,
    seedOverride?: Buffer,
    dataKeyOverride?: Buffer,
  ): Promise<IdentityRecord> {
    if (this.isLoaded) {
      throw Object.assign(
        new Error('Uma identidade já existe nesta instalação'),
        { code: 'E_IDENTITY_EXISTS' },
      );
    }
    // Verifica existência prévia tanto em manifest quanto em arquivo
    if (this.#manifest !== null && this.#hasManifestSecrets()) {
      throw Object.assign(new Error('Uma identidade já existe nesta instalação'), { code: 'E_IDENTITY_EXISTS' });
    }
    const keyPath = path.join(this.#dataDir, 'identity.enc');
    const dataKeyPath = path.join(this.#dataDir, 'datakey.wrapped');
    if (fs.existsSync(keyPath) || fs.existsSync(dataKeyPath)) {
      throw Object.assign(new Error('Uma identidade já existe nesta instalação'), { code: 'E_IDENTITY_EXISTS' });
    }
    // A semente é SEMPRE uma cópia local: `#initKeys` copia de novo para `#identitySeed`, e
    // esta aqui é zerada no `finally`. Com `seedOverride` (import de §5.5) isso importa
    // duas vezes — quem chamou continua dono do buffer dele, e o nosso sai do heap.
    const seed = Buffer.alloc(sodium.crypto_sign_SEEDBYTES);
    if (seedOverride === undefined) {
      sodium.randombytes_buf(seed);
    } else {
      if (seedOverride.length !== sodium.crypto_sign_SEEDBYTES) {
        throw Object.assign(new Error('Semente de identidade com tamanho inválido'), { code: 'E_MALFORMED' });
      }
      seedOverride.copy(seed);
    }
    // §5.4 — UMA Data Key por instalação: quando a composição já a tem em mãos (gerada no
    // primeiro boot, embrulhada via IPC-M), é ELA que protege `identity_seed`, e não uma
    // segunda chave sorteada aqui. Duas chaves partiriam a promessa de §5.4.
    const dataKey =
      dataKeyOverride !== undefined && dataKeyOverride.length === KEYBYTES
        ? Buffer.from(dataKeyOverride)
        : Buffer.alloc(KEYBYTES);
    if (dataKeyOverride === undefined || dataKeyOverride.length !== KEYBYTES) {
      sodium.randombytes_buf(dataKey);
    }
    /**
     * **Ou a identidade existe no disco, ou não existe em lugar nenhum.**
     *
     * `#initKeys` acontece antes do primeiro `await` que pode falhar (o wrap da Data Key
     * atravessa a IPC-M e tem prazo de 20 s) e antes de qualquer escrita. Sem este
     * `try`/rollback, um wrap que estoura o prazo — main preso num diálogo modal — deixava
     * `#publicKey`/`#secretKey` populados sem nada persistido, e a partir daí: `isLoaded`
     * passava a `true`, o que libera TODA a classe `standard` de §15.3 sobre uma identidade
     * que não existe; o vigia de rede anexava o backend do swarm e anunciava esse par na
     * DHT; e toda retentativa devolvia `E_IDENTITY_EXISTS`, sem saída a não ser matar o
     * processo. Uma comunidade criada nessa janela perderia a chave de escrita no boot
     * seguinte.
     */
    try {
      this.#initKeys(seed);
      this.#meta = { displayName, avatarColor, createdAt: Date.now(), presence: 'online' };
      const wrappedB64 = await this.#oracle.wrapDataKey(dataKey.toString('base64'));
      fs.mkdirSync(this.#dataDir, { recursive: true });
      if (this.#manifest !== null) {
        // §10.2: persiste em manifest.secrets (FULL) — caminho canônico
        this.#saveToManifest(seed, dataKey, wrappedB64);
      } else {
        this.#saveToFile(seed, dataKey, wrappedB64);
      }
      this.#saveMeta();
      const rec = this.record;
      if (rec === null) throw new Error('Falha ao criar identidade');
      return rec;
    } catch (err) {
      this.#descartarMaterial();
      throw err;
    } finally {
      sodium.sodium_memzero(dataKey);
      sodium.sodium_memzero(seed);
    }
  }

  /**
   * Zera e solta o material em memória sem tocar em disco — o rollback de `create` e a
   * primeira metade de `wipe`. Separado porque são a mesma operação com destinos
   * diferentes: aqui nada foi persistido; lá a persistência já foi embora.
   */
  #descartarMaterial(): void {
    if (this.#secretKey !== null) sodium.sodium_memzero(this.#secretKey);
    if (this.#identitySeed !== null) sodium.sodium_memzero(this.#identitySeed);
    this.#secretKey = null;
    this.#identitySeed = null;
    this.#publicKey = null;
    this.#meta = null;
  }

  /** §5.5: exporta identitySeed cifrado com Argon2id(passphrase) em XChaCha20-Poly1305. */
  exportBundle(
    passphrase: string,
    communities: readonly ExportCommunity[] = [],
  ): Buffer {
    if (this.#identitySeed === null || this.#meta === null) {
      throw Object.assign(new Error('Sem identidade para exportar'), {
        code: 'E_NO_IDENTITY',
      });
    }
    const salt = Buffer.alloc(sodium.crypto_pwhash_SALTBYTES);
    sodium.randombytes_buf(salt);
    const kek = keyFromPassphrase(passphrase, salt);
    const exportData = {
      version: 1,
      identitySeed: this.#identitySeed,
      displayName: this.#meta.displayName,
      avatarColor: this.#meta.avatarColor,
      communities: communities.map((c) => ({
        communityId: c.communityId,
        coreKey: c.coreKey.toString('hex'),
        blobsKey: c.blobsKey.toString('hex'),
        ...(c.communitySeed !== undefined
          ? { communitySeed: c.communitySeed.toString('hex') }
          : {}),
      })),
    };
    const jsonPayload = Buffer.from(
      JSON.stringify(exportData, (_key: string, val: unknown) => {
        const v = val as { type?: string; data?: number[] };
        if (
          v !== null &&
          typeof v === 'object' &&
          v.type === 'Buffer' &&
          Array.isArray(v.data)
        ) {
          return Buffer.from(v.data).toString('hex');
        }
        return val;
      }),
      'utf8',
    );
    const sealed = aeadSeal(jsonPayload, kek);
    sodium.sodium_memzero(kek);
    // §3.2 item 4 — o payload em claro carrega a semente em hex; depois de selado ele é
    // lixo com o valor da identidade dentro. Zerar aqui é o que impede que uma exportação
    // deixe a semente legível no heap pelo resto da sessão.
    sodium.sodium_memzero(jsonPayload);
    const domainPrefix = Buffer.from('identity-export/1\0', 'utf8');
    return Buffer.concat([domainPrefix, salt, sealed]);
  }

  /**
   * §5.5 — decifra o backup sem criar nada: é o que o import usa antes de `create` e o que
   * a composição usa para restaurar as linhas de comunidade no manifest.
   */
  #decodeBundle(
    bundle: Buffer,
    passphrase: string,
  ): {
    identitySeed: Buffer;
    displayName?: string;
    avatarColor?: number;
    communities: Array<{ communityId: string; coreKey: Buffer; blobsKey: Buffer; communitySeed?: Buffer }>;
  } {
    const domainPrefix = Buffer.from('identity-export/1\0', 'utf8');
    if (!bundle.subarray(0, domainPrefix.length).equals(domainPrefix)) {
      throw Object.assign(new Error('Formato de backup inválido'), {
        code: 'E_MALFORMED',
      });
    }
    const rest = bundle.subarray(domainPrefix.length);
    const salt = rest.subarray(0, sodium.crypto_pwhash_SALTBYTES);
    const cipher = rest.subarray(sodium.crypto_pwhash_SALTBYTES);
    const kek = keyFromPassphrase(passphrase, salt);
    let plain: Buffer;
    try {
      plain = aeadOpen(cipher as Buffer, kek);
    } catch {
      throw Object.assign(
        new Error('Frase secreta incorreta ou backup corrompido'),
        { code: 'E_BAD_PASSPHRASE' },
      );
    } finally {
      sodium.sodium_memzero(kek);
    }
    // O `finally` cobre TODA saída daqui para baixo, inclusive as de erro: um backup
    // corrompido também tem a semente em claro no `plain`, e sair por exceção sem zerar
    // deixaria justamente o caso mais provável de repetição (a pessoa tenta de novo) com
    // uma cópia por tentativa no heap.
    try {
      let parsed: {
        version?: number;
        identitySeed?: string;
        displayName?: string;
        avatarColor?: number;
        communities?: Array<{ communityId?: string; coreKey?: string; blobsKey?: string; communitySeed?: string }>;
      };
      try {
        parsed = JSON.parse(plain.toString('utf8')) as typeof parsed;
      } catch {
        throw Object.assign(new Error('Conteúdo do backup corrompido'), {
          code: 'E_MALFORMED',
        });
      }
      if (
        parsed === null ||
        parsed.version !== 1 ||
        typeof parsed.identitySeed !== 'string'
      ) {
        throw Object.assign(
          new Error('Backup corrompido ou versão incompatível'),
          { code: 'E_MALFORMED' },
        );
      }
      const communities = (parsed.communities ?? [])
        .filter((c) => typeof c.communityId === 'string' && typeof c.coreKey === 'string' && typeof c.blobsKey === 'string')
        .map((c) => ({
          communityId: c.communityId as string,
          coreKey: Buffer.from(c.coreKey as string, 'hex'),
          blobsKey: Buffer.from(c.blobsKey as string, 'hex'),
          ...(typeof c.communitySeed === 'string' ? { communitySeed: Buffer.from(c.communitySeed, 'hex') } : {}),
        }));
      // A `string` hex de `parsed.identitySeed` é inzerável por construção (§3.2 fala de
      // `Buffer`), e é justamente por isso que ela não sai deste método: quem chama recebe o
      // `Buffer`, que tem dono e é zerável.
      return {
        identitySeed: Buffer.from(parsed.identitySeed, 'hex'),
        ...(parsed.displayName !== undefined ? { displayName: parsed.displayName } : {}),
        ...(parsed.avatarColor !== undefined ? { avatarColor: parsed.avatarColor } : {}),
        communities,
      };
    } finally {
      sodium.sodium_memzero(plain);
    }
  }

  /**
   * §5.5: import em instalação sem identidade. Devolve **junto** as comunidades do backup,
   * para quem reabre os cores.
   *
   * Uma decodificação só: a versão anterior decodificava o mesmo backup duas vezes (aqui e
   * num `parseExportedCommunities` separado), o que pagava o Argon2id MODERATE duas vezes e
   * dobrava as cópias em claro da semente no heap para nada — as duas chamadas eram sempre
   * do mesmo `import`, com o mesmo bundle e a mesma frase.
   */
  async importBundle(
    bundle: Buffer,
    passphrase: string,
    dataKeyOverride?: Buffer,
  ): Promise<{
    record: IdentityRecord;
    communities: ReadonlyArray<{ communityId: string; coreKey: Buffer; blobsKey: Buffer; communitySeed?: Buffer }>;
  }> {
    if (this.isLoaded) {
      throw Object.assign(
        new Error('Uma identidade já existe nesta instalação'),
        { code: 'E_IDENTITY_EXISTS' },
      );
    }
    const decoded = this.#decodeBundle(bundle, passphrase);
    try {
      const record = await this.create(
        decoded.displayName ?? 'Membro',
        decoded.avatarColor ?? 0,
        decoded.identitySeed,
        dataKeyOverride,
      );
      return { record, communities: decoded.communities };
    } finally {
      sodium.sodium_memzero(decoded.identitySeed);
    }
  }

  /** §3.2: zera material em memória. §18.6: parte da máquina de wipe. */
  wipe(): void {
    this.#descartarMaterial();
    // Remove persistência: tanto manifest.secrets quanto arquivos legados
    if (this.#manifest !== null) {
      try {
        this.#manifest.deleteSecret('data_key');
      } catch {}
      try {
        this.#manifest.deleteSecret('identity_seed');
      } catch {}
      try {
        this.#manifest.metaSet('identity_public_key', '');
        // remove chave vazia?
        this.#manifest.raw.prepare('DELETE FROM meta WHERE key = ?').run('identity_public_key');
      } catch {}
      try {
        this.#manifest.raw.prepare('DELETE FROM meta WHERE key = ?').run('identity_meta');
      } catch {}
    }
    for (const nome of ['identity.enc', 'datakey.wrapped', 'identity.meta.json']) {
      const p = path.join(this.#dataDir, nome);
      if (fs.existsSync(p)) {
        try {
          fs.rmSync(p, { force: true });
        } catch {}
        if (fs.existsSync(p)) {
          throw Object.assign(new Error(`não foi possível remover ${p}`), { code: 'E_WIPE_INCOMPLETE' });
        }
      }
    }
  }

  #initKeys(seed: Buffer): void {
    this.#identitySeed = Buffer.from(seed);
    const pk = Buffer.alloc(sodium.crypto_sign_PUBLICKEYBYTES);
    const sk = Buffer.alloc(sodium.crypto_sign_SECRETKEYBYTES);
    sodium.crypto_sign_seed_keypair(pk, sk, seed);
    this.#publicKey = pk;
    this.#secretKey = sk;
  }

  #saveMeta(): void {
    if (this.#meta === null) return;
    const metaPath = path.join(this.#dataDir, 'identity.meta.json');
    fs.writeFileSync(metaPath, JSON.stringify(this.#meta, null, 2), 'utf8');
    if (this.#manifest !== null) {
      try {
        this.#manifest.metaSet('identity_meta', JSON.stringify(this.#meta));
      } catch {}
      if (this.#publicKey !== null) {
        try {
          this.#manifest.metaSet('identity_public_key', this.#publicKey.toString('hex'));
        } catch {}
      }
    }
  }
}
