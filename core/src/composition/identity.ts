// A superfície de identidade de §15.4/§5.5 e o estado `awaiting-identity` de §3.3 — raiz de
// composição: quem junta o `IdentityManager` (L0), o `manifest` (L0), o keystore via IPC-M
// (§3.2/A13) e a ponte de submissão por comunidade.
//
// Nada aqui decide domínio: validação de campo é a mesma do `fold` (`checkDisplayName`,
// `isAvatarColor`), os erros são os da coluna de §15.4, e o material privado nunca sai do
// processo — o blob de export atravessa IPC-M como bytes, e o caminho de arquivo escolhido
// pelo diálogo do main nunca volta para cá nem segue para o renderer (§13.3, T-16).

import {
  IdentityManager,
  type ExportCommunity,
  type IdentityRecord,
} from '../l0/identity/index.ts';
import { FallbackKeystoreOracle, type KeystoreOracle } from '../l0/keystore/index.ts';
import { acceptInsecure, hasAcceptedInsecure } from '../l0/keystore/index.ts';
import type { ManifestDb } from '../l0/manifest/index.ts';
import { isAvatarColor, checkDisplayName } from '../l1/fold/index.ts';
import { aeadOpenSeed } from './ports.ts';

/** Presença local de §6.1 — `offline` nunca é escrito; a tabela é fechada. */
export const PRESENCE_VALUES = ['online', 'idle', 'dnd', 'invisible'] as const;
export type LocalPresence = (typeof PRESENCE_VALUES)[number];

/**
 * O keystore visto pela superfície de identidade. `kind` alimenta `CoreStatus.keystore`
 * (§15.6); `available` é o gate `E_KEYSTORE_UNAVAILABLE` (§3.2 L-2).
 */
export type IdentityKeystorePort = {
  readonly oracle: KeystoreOracle;
  kind(): 'secure' | 'insecure-fallback';
  available(): Promise<boolean>;
};

/** §3.2 L-2 emendado — o modo em que a Data Key está embrulhada, persistido no manifest. */
export const CHAVE_MODO_KEYSTORE = 'keystore_mode';
export type ModoKeystore = 'secure' | 'insecure-fallback';

/**
 * Compõe o cofre a partir do que o main responde ao `keystoreInfo` da IPC-M (A13).
 *
 * A13(5)/L-2 — quem decide é `isEncryptionAvailable()` do main, não o nome do backend. E a
 * plataforma mudou sob a L-2: no Electron 43, sem secret service o `safeStorage` cai em
 * `basic_text` **e se recusa a cifrar** (`isEncryptionAvailable() === false`; `encryptString`
 * lança) — o "fallback inseguro utilizável" que a L-2 descreve deixou de existir. O modo
 * explícito passa então pelo oráculo de obfuscação local (`FallbackKeystoreOracle`): wrap que
 * não protege nada, dito em voz alta — `kind()` `'insecure-fallback'`, criação recusada com
 * `E_KEYSTORE_INSECURE` até o aceite da tela dedicada, indicador permanente em
 * `CoreStatus.keystore`. O mesmo oráculo volta para o chamador compor o `IdentityManager`,
 * porque quem wrapa a identidade é ele, não o serviço.
 *
 *   - cifra disponível → oráculo do main via IPC-M, modo `'secure'`;
 *   - resposta explícita `available:false` (probe de backend esgotado — caso A do G10) →
 *     modo inseguro explícito.
 *
 * **Emenda de 2026-09-05 em §3.2 L-2 — não conseguir perguntar NÃO é "não há cifra".** A
 * versão anterior tratava qualquer exceção da consulta como ausência de cifra, e o modo
 * ficava fixo para a vida do processo: um main preso além do prazo (diálogo modal, disco
 * travado) degradava o cofre desta instalação em silêncio, e numa instalação que já tinha
 * identidade o `unwrapDataKey` seguinte estourava em `E_BOOT` genérico três vezes até o
 * "Erro irrecuperável" do main — sem nunca dizer que o problema foi o keystore. Agora a
 * consulta é **retentada**, e o silêncio persistente é `E_KEYSTORE_UNAVAILABLE`: um erro
 * nomeado, que o shell mostra, em vez de uma degradação permanente.
 */
export async function composeKeystore(
  oracle: KeystoreOracle & { isAvailable?(): boolean; keystoreInfo?(): Promise<{ available: boolean }> },
  opts: { tentativas?: number; esperaMs?: number } = {},
): Promise<{ oracle: KeystoreOracle; keystore: IdentityKeystorePort; modo: ModoKeystore }> {
  const tentativas = Math.max(1, opts.tentativas ?? 3);
  const esperaMs = opts.esperaMs ?? 500;
  let capazDeCifrar: boolean | null = null;
  if (typeof oracle.keystoreInfo === 'function') {
    let ultimoErro: unknown = null;
    for (let i = 0; i < tentativas && capazDeCifrar === null; i++) {
      try {
        capazDeCifrar = (await oracle.keystoreInfo()).available === true;
      } catch (err) {
        ultimoErro = err;
        if (i + 1 < tentativas) await new Promise((r) => setTimeout(r, esperaMs));
      }
    }
    if (capazDeCifrar === null) {
      throw Object.assign(
        new Error(
          `Não foi possível consultar o keystore do sistema em ${tentativas} tentativas: ` +
            `${(ultimoErro as Error | null)?.message ?? 'sem resposta'}`,
        ),
        { code: 'E_KEYSTORE_UNAVAILABLE' },
      );
    }
  } else if (typeof oracle.isAvailable === 'function') {
    capazDeCifrar = oracle.isAvailable() === true;
  } else {
    // Sem como perguntar (rigs sem IPC-M), presume-se capaz — é o oráculo injetado que manda.
    capazDeCifrar = true;
  }
  if (capazDeCifrar) {
    return { oracle, keystore: { oracle, kind: () => 'secure', available: async () => true }, modo: 'secure' };
  }
  const oracleLocal = new FallbackKeystoreOracle();
  return {
    oracle: oracleLocal,
    keystore: insecureFallbackKeystorePort(oracleLocal),
    modo: 'insecure-fallback',
  };
}

/**
 * §3.2 L-2 emendado, regras 2 e 3 — o que fazer quando o modo do cofre mudou entre boots.
 *
 * Devolve o `wrapped` que deve valer daqui em diante (reembrulhado quando houve upgrade), e
 * grava o modo novo. As duas direções não são simétricas, e é essa assimetria que a regra
 * captura: `insecure-fallback → secure` é sempre possível (a Data Key ainda é legível pelo
 * oráculo antigo) e acontece sozinha, porque ninguém precisa aprovar passar a ser protegido;
 * `secure → insecure-fallback` é impossível (não há como abrir o que o `safeStorage` fechou)
 * e falha com `E_KEYSTORE_MODE_CHANGED`, em vez de sortear uma Data Key nova por cima da
 * única cópia da chave.
 */
export async function conciliarModoKeystore(a: {
  manifest: ManifestDb;
  modoAtual: ModoKeystore;
  oracleAtual: KeystoreOracle;
  /** O `secrets.data_key` gravado, ou `null` numa instalação sem identidade ainda. */
  wrapped: string | null;
  log?: (msg: string) => void;
}): Promise<string | null> {
  const gravado = a.manifest.metaGet(CHAVE_MODO_KEYSTORE) as ModoKeystore | null;
  if (a.wrapped === null || a.wrapped.length === 0) {
    // Nada embrulhado ainda: o modo corrente é simplesmente o modo desta instalação.
    a.manifest.metaSet(CHAVE_MODO_KEYSTORE, a.modoAtual);
    return a.wrapped;
  }
  // Instalação anterior à emenda: adota o modo corrente como o registrado. Não há como
  // saber o modo antigo, e inventar um seria pior — o `unwrapDataKey` logo adiante é quem
  // diz se a chave abre.
  if (gravado === null) {
    a.manifest.metaSet(CHAVE_MODO_KEYSTORE, a.modoAtual);
    return a.wrapped;
  }
  if (gravado === a.modoAtual) return a.wrapped;
  if (gravado === 'secure' && a.modoAtual === 'insecure-fallback') {
    throw Object.assign(
      new Error(
        'A Data Key desta instalação está protegida pelo chaveiro do sistema, que não está ' +
          'disponível agora. Reinstale o chaveiro, ou restaure o backup de §5.5 numa instalação nova.',
      ),
      { code: 'E_KEYSTORE_MODE_CHANGED' },
    );
  }
  // `insecure-fallback` → `secure`: desembrulha pelo antigo, reembrulha pelo novo.
  const antigo = new FallbackKeystoreOracle();
  const dataKeyB64 = await antigo.unwrapDataKey(a.wrapped);
  const novoWrapped = await a.oracleAtual.wrapDataKey(dataKeyB64);
  a.manifest.setSecret('data_key', Buffer.from(novoWrapped, 'utf8'), null);
  a.manifest.metaSet(CHAVE_MODO_KEYSTORE, a.modoAtual);
  a.log?.('keystore.upgraded insecure-fallback→secure');
  return novoWrapped;
}

/** Porta do fallback inseguro — exige aceite explícito persistido (L-2, poc-10). */
export function insecureFallbackKeystorePort(oracle: KeystoreOracle): IdentityKeystorePort {
  return { oracle, kind: () => 'insecure-fallback', available: async () => true };
}

export type ExportCommunityWire = {
  readonly communityId: string;
  readonly coreKey: string;
  readonly blobsKey: string;
  readonly communitySeed?: string;
};

export type IdentityServiceDeps = {
  readonly manager: IdentityManager;
  readonly manifest: ManifestDb;
  /** `<dataDir>` — onde o aceite inseguro fica persistido. */
  readonly dataDir: string;
  readonly keystore: IdentityKeystorePort;
  /** §5.4 — a Data Key corrente da instalação (a mesma que protege as sementes). */
  dataKey(): Buffer;
  now(): number;
  /**
   * §15.7 `file.save` — o main mostra o diálogo e GRAVA os bytes; daqui sai `{ok}` e
   * nunca um caminho. Ausente → `E_CANCELLED` (sem shell não há para onde gravar).
   */
  saveFile?(a: { suggestedName: string; data: Buffer }): Promise<{ ok: true } | { ok: false; code: string }>;
  /** §5.5 import — o main lê o arquivo escolhido; ausente → `E_CANCELLED`. */
  readFile?(): Promise<Buffer | null>;
};

export type IdentityCreateResult =
  | { readonly ok: true; readonly publicKey: string; readonly handle: string; readonly createdAt: number }
  | { readonly ok: false; readonly code: string; readonly field?: string };

export type IdentityUpdateQueued = {
  readonly communityId: string;
  readonly opId: string;
};

function recordWire(rec: IdentityRecord): { publicKey: string; handle: string; createdAt: number } {
  return { publicKey: rec.publicKeyHex, handle: rec.handle, createdAt: rec.createdAt };
}

/**
 * O serviço que os comandos `identity.*` consomem. Uma instância por núcleo; o mesmo
 * `manager` que o boot usa para `deps.identity()`.
 */
export class IdentityService {
  readonly #deps: IdentityServiceDeps;

  constructor(deps: IdentityServiceDeps) {
    this.#deps = deps;
  }

  get manager(): IdentityManager {
    return this.#deps.manager;
  }

  /** §15.6 `CoreStatus.keystore`. */
  keystoreKind(): 'secure' | 'insecure-fallback' {
    return this.#deps.keystore.kind();
  }

  /** Aceite explícito do modo inseguro (L-2) — lido do arquivo persistido. */
  hasAcceptedInsecure(): boolean {
    return hasAcceptedInsecure(this.#deps.dataDir);
  }

  acceptInsecure(backend: string): void {
    acceptInsecure(this.#deps.dataDir, backend);
  }

  /**
   * §3.2 L-2 — o aceite da tela dedicada, pela fronteira. Idempotente: aceitar de novo
   * apenas reescreve o registro, e é isso que faz o gatilho poder ser chamado sem a UI
   * precisar saber se já houve aceite.
   *
   * Com o cofre SEGURO não há o que aceitar, e gravar o registro mesmo assim deixaria no
   * disco a afirmação de que se aceitou um modo que nunca esteve em uso — se o ambiente
   * degradar depois, o gate de `create` já estaria vencido sem ninguém ter visto a tela.
   * Recusa com o erro genérico de estado, no precedente de §57.
   *
   * O `backend` gravado é o que o núcleo sabe: o main é quem conhece o nome real do backend
   * do `safeStorage`, e ele não cruza a IPC-M hoje. Registrado como pendência.
   */
  acceptInsecureKeystore(): { ok: true } | { ok: false; code: string } {
    const kind = this.#deps.keystore.kind();
    if (kind !== 'insecure-fallback') return { ok: false, code: 'E_VALIDATION' };
    this.acceptInsecure(kind);
    return { ok: true };
  }

  async create(displayName: unknown, avatarColor: unknown): Promise<IdentityCreateResult> {
    if (this.#deps.manager.isLoaded) return { ok: false, code: 'E_IDENTITY_EXISTS' };
    // Coluna Erros de §15.4: E_VALIDATION antes dos gates de keystore (ordem da tabela).
    if (typeof displayName !== 'string') return { ok: false, code: 'E_VALIDATION', field: 'displayName' };
    const nome = checkDisplayName(displayName);
    if (!nome.ok) return { ok: false, code: 'E_VALIDATION', field: 'displayName' };
    if (typeof avatarColor !== 'number' || !isAvatarColor(avatarColor)) {
      return { ok: false, code: 'E_VALIDATION', field: 'avatarColor' };
    }
    if (!(await this.#deps.keystore.available())) return { ok: false, code: 'E_KEYSTORE_UNAVAILABLE' };
    if (this.#deps.keystore.kind() === 'insecure-fallback' && !this.hasAcceptedInsecure()) {
      return { ok: false, code: 'E_KEYSTORE_INSECURE' };
    }
    try {
      const rec = await this.#deps.manager.create(nome.value, avatarColor, undefined, this.#deps.dataKey());
      return { ok: true, ...recordWire(rec) };
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'E_INTERNAL';
      return { ok: false, code } as IdentityCreateResult;
    }
  }

  /** Lista das comunidades participadas para o backup de §5.5 — semente só de hospedeira. */
  exportCommunities(): ExportCommunity[] {
    const rows = this.#deps.manifest.listCommunities() as Array<{
      community_id: string;
      core_key: Uint8Array;
      blobs_key: Uint8Array;
      community_seed_enc?: Uint8Array | null;
      community_seed_nonce?: Uint8Array | null;
      is_host: number;
      left_at: number | null;
    }>;
    const dk = this.#deps.dataKey();
    const saida: ExportCommunity[] = [];
    for (const r of rows) {
      if (r.left_at !== null) continue;
      let communitySeed: Buffer | undefined;
      if (
        Boolean(r.is_host) &&
        r.community_seed_enc !== undefined &&
        r.community_seed_enc !== null &&
        r.community_seed_nonce !== undefined &&
        r.community_seed_nonce !== null
      ) {
        const seed = aeadOpenSeed(
          Buffer.from(r.community_seed_enc),
          Buffer.from(r.community_seed_nonce),
          dk,
        );
        if (seed !== null && seed.length === 32) {
          communitySeed = seed;
        }
      }
      saida.push({
        communityId: r.community_id,
        coreKey: Buffer.from(r.core_key),
        blobsKey: Buffer.from(r.blobs_key),
        ...(communitySeed !== undefined ? { communitySeed } : {}),
      });
    }
    return saida;
  }

  async export(passphrase: unknown): Promise<{ ok: true } | { ok: false; code: string; field?: string }> {
    if (typeof passphrase !== 'string' || passphrase.length === 0) {
      return { ok: false, code: 'E_VALIDATION', field: 'passphrase' };
    }
    const saveFile = this.#deps.saveFile;
    if (saveFile === undefined) return { ok: false, code: 'E_CANCELLED' };
    let bundle: Buffer;
    const comms = this.exportCommunities();
    try {
      bundle = this.#deps.manager.exportBundle(passphrase, comms);
    } catch (err) {
      return { ok: false, code: (err as { code?: string }).code ?? 'E_NO_IDENTITY' };
    } finally {
      for (const c of comms) {
        if (c.communitySeed !== undefined) {
          c.communitySeed.fill(0);
        }
      }
    }
    const r = await saveFile({ suggestedName: 'identidade-comunidade.bak', data: bundle });
    if (!r.ok) return { ok: false, code: r.code };
    // §15.4 diz `{savedTo}`; §13.3 regra 5 proíbe caminho de usuário no IPC-R. Emenda
    // datada no normativo alinha a resposta em `{}` — o desfecho da chamada É a confirmação.
    return { ok: true };
  }

  /**
   * §5.5 — decifra, recria a identidade e devolve as comunidades do backup para quem
   * reabre os cores. Só em instalação sem identidade.
   */
  async import(passphrase: unknown): Promise<
    | { ok: true; publicKey: string; handle: string; communities: number; rows: ExportCommunityWire[] }
    | { ok: false; code: string; field?: string }
  > {
    if (typeof passphrase !== 'string' || passphrase.length === 0) {
      return { ok: false, code: 'E_VALIDATION', field: 'passphrase' };
    }
    const readFile = this.#deps.readFile;
    if (readFile === undefined) return { ok: false, code: 'E_CANCELLED' };
    let bundle: Buffer | null = null;
    try {
      bundle = await readFile();
    } catch {
      bundle = null;
    }
    if (bundle === null || bundle.length === 0) return { ok: false, code: 'E_CANCELLED' };
    try {
      // As linhas do backup voltam para quem reabre os cores (§5.5 "reabre os cores"), e
      // vêm da MESMA decodificação que recriou a identidade: decodificar de novo pagaria o
      // Argon2id MODERATE duas vezes e dobraria as cópias em claro da semente no heap.
      const { record, communities } = await this.#deps.manager.importBundle(
        bundle,
        passphrase,
        this.#deps.dataKey(),
      );
      const rows = communities.map((c) => ({
        communityId: c.communityId,
        coreKey: c.coreKey.toString('hex'),
        blobsKey: c.blobsKey.toString('hex'),
        ...(c.communitySeed !== undefined ? { communitySeed: c.communitySeed.toString('hex') } : {}),
      }));
      return { ok: true, ...recordWire(record), communities: rows.length, rows };
    } catch (err) {
      return { ok: false, code: (err as { code?: string }).code ?? 'E_MALFORMED' };
    }
  }

  /** §6.1 — presença local; valida contra a tabela fechada. */
  setPresence(presence: unknown): { ok: true; presence: LocalPresence } | { ok: false; code: string } {
    if (typeof presence !== 'string' || !(PRESENCE_VALUES as readonly string[]).includes(presence)) {
      return { ok: false, code: 'E_VALIDATION' };
    }
    try {
      this.#deps.manager.setPresence(presence);
    } catch {
      return { ok: false, code: 'E_NO_IDENTITY' };
    }
    return { ok: true, presence: presence as LocalPresence };
  }
}
