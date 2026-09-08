// Ciclo de vida local da comunidade: nascer (`community.create`, §5.3/§19.1) e convidar
// (`invite.create`/`invite.revoke`, §12.2) — a metade **local** da admissão.
//
// Este arquivo é raiz de composição (§4): importa qualquer módulo e não é importado por
// nenhum deles. O que ele decide é ordem e orquestração; a regra de domínio continua onde
// sempre esteve — a forma do lote de gênese é verificada pelo `fold` (R-27), a admissão de
// cada op pelo pipeline de §8.2 dentro do `HostAdmission`, e os tetos de campo pelos limites
// de §8.6, que a validação advisória daqui apenas antecipa (§8.7).

import path from 'node:path';

import sodium from 'sodium-native';

import {
  createCore,
  deriveCommunityKeyPairs,
  type WritableCoreHandle,
} from '../l0/corestore/index.ts';
import type { ManifestDb } from '../l0/manifest/index.ts';
import { entityId } from '../l1/idgen/index.ts';
import { OP_VERSION } from '../l1/opCodec/index.ts';
import { ALL_PERMISSIONS, permissionNumber } from '../l1/permissions/index.ts';
import {
  CHANNEL_TYPE,
  INVITE_EXPIRY_MAX_MS,
  INVITE_EXPIRY_MIN_MS,
  INVITE_MAX_USES_MAX,
  INVITE_MAX_USES_MIN,
  checkCommunityDescription,
  checkCommunityName,
  checkIconEmoji,
  checkInviteLabel,
  checkModerationReason,
} from '../l1/fold/index.ts';
import { DEFAULT_CONFIG } from '../l0/config/index.ts';
import { deriveMemberBlobsKeypair } from '../l2/blobs/index.ts';
import { memberHasPermission } from '../l2/voiceCoordinator/host.ts';
import {
  MAX_ACTIVE_INVITES,
  deriveInviteKeypair,
  generateInviteSecret,
  inviteSecretToCode,
} from '../l2/invites/index.ts';
import type { CoreRuntime } from './boot.ts';
import { hostRecordSigner, opCodecSignPort, storeCommunitySeed } from './ports.ts';

/** Par Ed25519 qualquer — material de derivação local (log, blobs). */
export type KeyPair = { readonly publicKey: Buffer; readonly secretKey: Buffer };

/**
 * Identidade local com o perfil que o `member.join` da gênese carrega. É a forma que o boot
 * entrega; os dois campos de perfil são opcionais porque o contrato atual de `BootDeps`
 * só garante o par de chaves.
 */
export type BootIdentityLike = {
  readonly publicKey: Buffer;
  readonly secretKey: Buffer;
  readonly displayName?: string;
  readonly avatarColor?: number;
};

function randomBytes(n: number): Buffer {
  const b = Buffer.alloc(n);
  sodium.randombytes_buf(b);
  return b;
}

/**
 * A semente de identidade de §5.1 a partir do par local: `sodium` guarda a chave secreta
 * Ed25519 como `seed ‖ publicKey`, então os 32 primeiros bytes SÃO o `identitySeed` que o
 * backup de §5.5 exporta. É esta a entrada das derivações por namespace de §5.2 que
 * dependem da identidade (`ns/relay/1`, `ns/memberblobs/1`).
 */
export function identitySeedOf(identity: { readonly secretKey: Buffer }): Buffer {
  if (identity.secretKey.length !== sodium.crypto_sign_SECRETKEYBYTES) {
    throw new Error('Chave secreta de identidade com tamanho inesperado');
  }
  return Buffer.from(identity.secretKey.subarray(0, sodium.crypto_sign_SEEDBYTES));
}

/**
 * O core de blobs local do membro nesta comunidade (§13.1, §19.1 passo 3): **derivado**,
 * nunca sorteado — `memberBlobsSeed = BLAKE2b-256('ns/memberblobs/1' ‖ identitySeed ‖
 * communityId)`. É a derivação que faz valer a promessa de §13.1/§5.5: quem restaura a
 * identidade recupera o core em qualquer instalação, mesmo sem o `manifest.db` — o backup
 * de §5.5 carrega `identitySeed` e a lista de comunidades, e nunca carregou esta semente.
 */
export function memberBlobsKeyPairFor(
  identity: { readonly secretKey: Buffer },
  communityId: string | Buffer,
): { publicKey: Buffer; secretKey: Buffer; seed: Buffer } {
  return deriveMemberBlobsKeypair(identitySeedOf(identity), communityId);
}

// ─── Cifra de repouso de §5.1/§5.4 (XChaCha20-Poly1305), empacotada ──────────────────────
//
// `member_blobs_core.secret_seed_enc` não tem coluna de nonce (§10.2), diferente das linhas
// de `communities`: o nonce viaja **prefixado** ao ciphertext‖tag dentro do mesmo blob.

export function aeadSealPacked(plain: Buffer, dataKey: Buffer): Buffer {
  const nonce = Buffer.alloc(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  sodium.randombytes_buf(nonce);
  const enc = Buffer.alloc(plain.length + sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES);
  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(enc, plain, null, null, nonce, dataKey);
  return Buffer.concat([nonce, enc]);
}

export function aeadOpenPacked(blob: Buffer, dataKey: Buffer): Buffer | null {
  const npub = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  if (blob.length <= npub + sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES) return null;
  const nonce = blob.subarray(0, npub);
  const enc = blob.subarray(npub);
  const plain = Buffer.alloc(enc.length - sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES);
  try {
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(plain, null, enc, null, nonce, dataKey);
  } catch {
    return null;
  }
  return plain;
}

// ─── Lote de gênese (§19.1, forma normativa em R-27) ────────────────────────────────────

export type GenesisBatch = {
  /** Os seis registros, prontos para UM `core.append` (§19.1 passo 5, §10.7.1). */
  readonly blocks: Buffer[];
  readonly communityId: string;
  readonly founderRoleId: string;
  readonly baseRoleId: string;
  readonly categoryId: string;
  readonly defaultChannelId: string;
};

/**
 * Monta os seis registros de `seq` 0..5 na ordem exata de R-27, todos autorados pela
 * identidade do fundador (`authorSeq` 1..6, escopo comunidade) e empacotados como HostRecord
 * assinado pela chave de escrita do log.
 *
 * `blobsKey` entra no payload do `seq` 0 (§5.3 passo 4 — dado do log, recuperável para
 * sempre); o `member.join` do fundador carrega convite e prova **zerados** — a única exceção
 * a R-9, que o próprio R-27(a) declara. Quem confere a forma de cada registro é o `fold`,
 * com o principal de gênese tornando o lote admissível; nada aqui suspende estágio.
 */
export function genesisBatch(a: {
  readonly logKeyPair: KeyPair;
  readonly blobsKeyPair: KeyPair;
  readonly founderBlobsCoreKey: Buffer;
  readonly identity: BootIdentityLike;
  readonly name: string;
  readonly iconEmoji?: string;
  readonly iconColor: number;
  readonly description?: string;
  now(): number;
}): GenesisBatch {
  const codec = opCodecSignPort();
  const record = hostRecordSigner(a.logKeyPair.secretKey);
  const communityKey = a.logKeyPair.publicKey;
  const ts = a.now();

  const sela = (kindName: string, authorSeq: number, payload: Record<string, unknown>): Buffer => {
    const kindNumber = codec.kindNumber(kindName);
    if (kindNumber === null) throw Object.assign(new Error('kind fora do catálogo'), { code: 'E_INTERNAL' });
    const encoded = codec.encodePayload(kindName, payload);
    if (encoded === null) throw Object.assign(new Error('payload fora do layout'), { code: 'E_INTERNAL' });
    const { envelope } = codec.sealOp({
      opVersion: OP_VERSION,
      communityId: communityKey,
      kindNumber,
      author: a.identity.publicKey,
      secretKey: a.identity.secretKey,
      sequenceScope: { kind: 'community' },
      authorSeq,
      ts,
      payload: encoded,
    });
    return Buffer.from(record(envelope, ts));
  };

  const ZERO32 = Buffer.alloc(32);
  const ZERO64 = Buffer.alloc(64);
  const basePermissions = ['send_messages', 'attach_files', 'add_reactions', 'voice_speak'].map((p) =>
    permissionNumber(p as Parameters<typeof permissionNumber>[0]),
  );
  const blocks = [
    // seq 0 — a comunidade passa a existir; o autor deste registro é o `founderKey`.
    sela('community.create', 1, {
      name: a.name,
      ...(a.iconEmoji !== undefined ? { iconEmoji: a.iconEmoji } : {}),
      iconColor: a.iconColor,
      ...(a.description !== undefined ? { description: a.description } : {}),
      blobsKey: a.blobsKeyPair.publicKey,
    }),
    // seq 1 — cargo Fundador: exatamente as 17 permissões, topo da hierarquia (R-27b).
    sela('role.create', 2, {
      name: 'Fundador',
      color: 0,
      permissions: ALL_PERMISSIONS.map(permissionNumber),
      mentionable: true,
    }),
    // seq 2 — cargo base: subconjunto fechado de §19.1/R-11, fundo da hierarquia.
    sela('role.create', 3, {
      name: 'Membro',
      color: 6,
      permissions: basePermissions,
      mentionable: false,
    }),
    // seq 3 — o fundador entra; convite e prova zerados (a gênese não tem convite).
    sela('member.join', 4, {
      invitePublicKey: ZERO32,
      joinProof: ZERO64,
      displayName: a.identity.displayName ?? 'Fundador',
      avatarColor: a.identity.avatarColor ?? 0,
      blobsCoreKey: a.founderBlobsCoreKey,
    }),
    // seq 4 — categoria GERAL.
    sela('category.create', 5, { name: 'GERAL' }),
    // seq 5 — canal #geral, texto.
    sela('channel.create', 6, {
      categoryId: entityId('category', communityKey, a.identity.publicKey, 5),
      type: CHANNEL_TYPE.text,
      name: 'geral',
      readOnlyForRoleIds: [],
    }),
  ];

  return {
    blocks,
    communityId: communityKey.toString('hex'),
    founderRoleId: entityId('role', communityKey, a.identity.publicKey, 2),
    baseRoleId: entityId('role', communityKey, a.identity.publicKey, 3),
    categoryId: entityId('category', communityKey, a.identity.publicKey, 5),
    defaultChannelId: entityId('channel', communityKey, a.identity.publicKey, 6),
  };
}

// ─── community.create (§15.4, §19.1) ─────────────────────────────────────────────────────

export type CreateCommunityDeps = {
  readonly runtime: CoreRuntime;
  readonly manifest: ManifestDb;
  /** §5.4 — protege `communitySeed` e as sementes de blobs no manifest. */
  readonly dataKey: Buffer;
  /** `<dataDir>/cores` (§10.1). */
  readonly coresDir: string;
  /** Identidade local — sem ela não há quem assine a gênese (`E_NO_IDENTITY`). */
  selfKey(): BootIdentityLike | null;
  now(): number;
  /** Criação do core; sobrescrita em teste para não tocar disco. */
  createCoreImpl?(storagePath: string, keyPair: KeyPair): Promise<WritableCoreHandle>;
};

export type CreateCommunityInput = {
  readonly name: string;
  readonly iconEmoji?: string;
  readonly iconColor?: number;
  readonly description?: string;
};

export type CreateCommunityResult =
  | { readonly ok: true; readonly communityId: string; readonly defaultChannelId: string }
  | { readonly ok: false; readonly code: string; readonly field?: string };

/**
 * `community.create` — §5.3 e §19.1 passo a passo:
 *
 *   1. valida campos contra os tetos de §8.6 (advisório, antes de tocar nada);
 *   2. gera `communitySeed` (32 bytes aleatórios);
 *   3. **grava a linha cifrada no manifest ANTES de criar core algum** — se o processo
 *      morrer aqui, nada foi criado e a linha órfã é limpa no boot (§5.3 passo 2);
 *   4. grava o core de blobs local do fundador (§13.1) e deriva os dois pares por namespace
 *      determinístico; cria o core do log por chave explícita;
 *   5. appenda o lote de gênese inteiro numa chamada — ou entram os 6, ou nenhum (§10.7.1);
 *      falha de append descarta linha e core (§19.1 "Falhas");
 *   6. abre a comunidade no runtime **sem reiniciar o processo** (`openCommunity`) — é isto
 *      que faz a recém-nascida anunciar tópico e servir membros no mesmo tick.
 *
 * Criar comunidade nunca depende de rede (§19.1): `swarm.join` falhar não impede nada — a
 * comunidade funciona localmente em `hosting-degraded`, e o anúncio é do transporte.
 */
export async function createCommunity(deps: CreateCommunityDeps, input: CreateCommunityInput): Promise<CreateCommunityResult> {
  const identity = deps.selfKey();
  if (identity === null || identity.secretKey.length !== 64) return { ok: false, code: 'E_NO_IDENTITY' };

  // §8.7 ponto 1 — os erros síncronos da coluna de §15.4, decididos antes de qualquer
  // escrita. Quem revalida tudo é o fold, sobre cada registro da gênese.
  const nome = checkCommunityName(input.name);
  if (!nome.ok) return { ok: false, code: 'E_VALIDATION', field: 'name' };
  if (input.iconEmoji !== undefined && !checkIconEmoji(input.iconEmoji).ok) return { ok: false, code: 'E_VALIDATION', field: 'iconEmoji' };
  if (input.description !== undefined && !checkCommunityDescription(input.description).ok) return { ok: false, code: 'E_VALIDATION', field: 'description' };
  const iconColor = input.iconColor ?? 0;
  if (!Number.isInteger(iconColor) || iconColor < 0 || iconColor > 255) return { ok: false, code: 'E_VALIDATION', field: 'iconColor' };

  const communitySeed = randomBytes(32);
  const pairs = deriveCommunityKeyPairs(communitySeed);

  // Passo 2 de §5.3 — ANTES de criar qualquer core. A cifra é a Data Key (§5.4).
  storeCommunitySeed(
    deps.manifest,
    {
      communityId: pairs.log.publicKey.toString('hex'),
      coreKey: pairs.log.publicKey,
      blobsKey: pairs.blobs.publicKey,
      communitySeed,
      isHost: true,
      joinedAt: deps.now(),
    },
    deps.dataKey,
  );

  // O core de blobs local do fundador (§19.1 passo 3): DERIVADO da identidade e do
  // `communityId` (§13.1). A linha do manifest é atalho e verificação cruzada — o boot
  // confere a chave publicada contra a derivada —, não a única cópia da semente.
  const founderBlobs = memberBlobsKeyPairFor(identity, pairs.log.publicKey);
  deps.manifest.setMemberBlobsCore({
    communityId: pairs.log.publicKey.toString('hex'),
    coreKey: founderBlobs.publicKey,
    secretSeedEnc: aeadSealPacked(founderBlobs.seed, deps.dataKey),
  });

  const lote = genesisBatch({
    logKeyPair: pairs.log,
    blobsKeyPair: pairs.blobs,
    founderBlobsCoreKey: founderBlobs.publicKey,
    identity,
    name: nome.value,
    ...(input.iconEmoji !== undefined ? { iconEmoji: input.iconEmoji } : {}),
    iconColor,
    ...(input.description !== undefined ? { description: input.description } : {}),
    now: deps.now,
  });

  let core: WritableCoreHandle | null = null;
  try {
    core =
      deps.createCoreImpl !== undefined
        ? await deps.createCoreImpl(path.join(deps.coresDir, lote.communityId), pairs.log)
        : await createCore(path.join(deps.coresDir, lote.communityId), pairs.log);
    // §19.1 passo 5 / §10.7.1 — uma chamada, que já commita. Ou os 6 entram, ou nenhum.
    await core.append(lote.blocks);
  } catch {
    if (core !== null) await core.close().catch(() => {});
    deps.manifest.deleteCommunity(lote.communityId);
    return { ok: false, code: 'E_STORAGE_FULL' };
  }
  // O armazenamento é exclusivo: fecha o cabo da criação para que o runtime reabra o core
  // pela chave gravada (§5.3 passo 5), pelo mesmo caminho de todo boot.
  await core.close().catch(() => {});
  // §7.5 — a gênese consumiu os authorSeq 1..6 do fundador fora da ponte; fixa o contador
  // para que a primeira op síncrona use o 7, não o 1 (E_DUPLICATE).
  deps.manifest.advanceAuthorSeq(lote.communityId, 'community', lote.blocks.length + 1);

  try {
    deps.runtime.register(
      await deps.runtime.openCommunity({
        community_id: lote.communityId,
        core_key: pairs.log.publicKey,
        blobs_key: pairs.blobs.publicKey,
        is_host: 1,
        left_at: null,
      }),
    );
  } catch (e) {
    // §58.11 — falha que se apresenta calada transforma sintoma em mistério. O código de
    // erro segue o mesmo (contrato de §15.4), mas a causa sai visível.
    console.error('[createCommunity] open/register falhou:', e);
    return { ok: false, code: 'E_INTERNAL' };
  }

  return { ok: true, communityId: lote.communityId, defaultChannelId: lote.defaultChannelId };
}

// ─── invite.create / invite.revoke (§12.2, §15.4 "Convites") ─────────────────────────────

export type InviteSurfaceDeps = Pick<CreateCommunityDeps, 'runtime' | 'manifest' | 'selfKey' | 'now'>;

export type InviteCreateArgs = {
  readonly communityId: string;
  readonly expiresInDays?: number;
  readonly maxUses?: number;
  readonly label?: string;
};

export type InviteCreateResult =
  | {
      readonly ok: true;
      readonly invitePublicKeyHex: string;
      readonly code: string;
      readonly expiresAt?: number;
      readonly maxUses?: number;
      readonly seq: number;
    }
  | { readonly ok: false; readonly code: string; readonly field?: string };

const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * `invite.create` (⏱, coluna Perm. `create_invite`). Vale para **qualquer** membro
 * autorizado — host ou não (A08: o convite delegado existe porque o host valida pela chave
 * pública do log e nunca precisa conhecer o segredo).
 *
 * §12.2 passo 1: gera segredo+par, grava o segredo em `invite_secrets` (FULL) **antes** do
 * append. Passo 2: appenda a op síncrona pela porta do host — local quando hospedada aqui,
 * §16.2 `submitOp` quando membro. Falha de admissão remove o segredo órfão. O `code` só
 * existe nesta resposta — nunca trafega nem vai para o log (só `invitePublicKey` entra nele).
 *
 * O anúncio na DHT NÃO é desta função: é do lote projetado (gancho de §12.2 passo 3 no
 * boot), que cobre convite criado aqui e convite criado por outro membro que chegue pela
 * replicação.
 */
export async function inviteCreate(deps: InviteSurfaceDeps, args: InviteCreateArgs): Promise<InviteCreateResult> {
  const identity = deps.selfKey();
  if (identity === null) return { ok: false, code: 'E_NO_IDENTITY' };
  const aberta = deps.runtime.get(args.communityId);
  if (aberta === undefined) return { ok: false, code: 'E_NOT_FOUND' };
  const ds = aberta.projector.ds;
  if (!ds.community.exists) return { ok: false, code: 'E_NOT_FOUND' };
  if (ds.community.endedAt !== undefined) return { ok: false, code: 'E_COMMUNITY_ENDED' };
  const selfHex = identity.publicKey.toString('hex');
  if (!memberHasPermission(ds, selfHex, 'create_invite')) return { ok: false, code: 'E_PERMISSION_DENIED' };

  const agora = deps.now();
  // Tetos de §8.6 — advisório; o fold revalida contra o `hostTs` da admissão.
  let expiresAt: number | undefined;
  if (args.expiresInDays !== undefined) {
    if (!Number.isFinite(args.expiresInDays)) return { ok: false, code: 'E_VALIDATION', field: 'expiresInDays' };
    expiresAt = agora + Math.floor(args.expiresInDays * DIA_MS);
    if (expiresAt < agora + INVITE_EXPIRY_MIN_MS || expiresAt > agora + INVITE_EXPIRY_MAX_MS) {
      return { ok: false, code: 'E_VALIDATION', field: 'expiresInDays' };
    }
  }
  if (args.maxUses !== undefined && (!Number.isInteger(args.maxUses) || args.maxUses < INVITE_MAX_USES_MIN || args.maxUses > INVITE_MAX_USES_MAX)) {
    return { ok: false, code: 'E_VALIDATION', field: 'maxUses' };
  }
  if (args.label !== undefined && !checkInviteLabel(args.label).ok) return { ok: false, code: 'E_VALIDATION', field: 'label' };
  // Limite de cardinalidade de §26.2 — convites ativos por comunidade: 50.
  const ativos = [...ds.invites.values()].filter((inv) => {
    if (inv.revokedAt !== undefined) return false;
    if (inv.expiresAt !== undefined && inv.expiresAt <= agora) return false;
    return !(inv.maxUses !== undefined && inv.uses >= inv.maxUses);
  }).length;
  if (ativos >= MAX_ACTIVE_INVITES) return { ok: false, code: 'E_LIMIT_EXCEEDED' };

  // §12.1/§12.2 passo 1 — segredo de 80 bits, par derivado, segredo persistido primeiro.
  const secret = generateInviteSecret();
  const { publicKey } = deriveInviteKeypair(secret);
  deps.manifest.setInviteSecret({
    invitePublicKey: publicKey,
    communityId: args.communityId,
    secret,
    ...(args.label !== undefined ? { label: args.label } : {}),
  });

  const payload: Record<string, unknown> = { invitePublicKey: publicKey };
  if (expiresAt !== undefined) payload['expiresAt'] = expiresAt;
  if (args.maxUses !== undefined) payload['maxUses'] = args.maxUses;
  if (args.label !== undefined) payload['label'] = args.label;

  const r = await deps.runtime.client.submitSync(args.communityId, { kindName: 'invite.create', payload });
  if (!r.ok) {
    // A op não entrou: o segredo gravado acima virou órfão — remove-o.
    deps.manifest.deleteInviteSecret(publicKey.toString('hex'));
    return { ok: false, code: r.code, ...(r.field !== undefined ? { field: r.field } : {}) };
  }
  return {
    ok: true,
    invitePublicKeyHex: publicKey.toString('hex'),
    code: inviteSecretToCode(secret),
    seq: r.seq,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(args.maxUses !== undefined ? { maxUses: args.maxUses } : {}),
  };
}

/**
 * `invite.revoke` (⏱, autor \| `manage_community`). O fold revalida a mesma regra (R-10
 * inclui a revogação automática quando o autor é banido); o lote que projetar a revogação
 * tira o tópico da DHT pelo gancho de §12.2 no boot.
 */
export async function inviteRevoke(
  deps: InviteSurfaceDeps,
  args: { communityId: string; invitePublicKeyHex: string },
): Promise<{ ok: true; seq: number } | { ok: false; code: string }> {
  const identity = deps.selfKey();
  if (identity === null) return { ok: false, code: 'E_NO_IDENTITY' };
  if (!/^[0-9a-f]{64}$/i.test(args.invitePublicKeyHex)) return { ok: false, code: 'E_VALIDATION' };
  const aberta = deps.runtime.get(args.communityId);
  if (aberta === undefined) return { ok: false, code: 'E_NOT_FOUND' };
  const ds = aberta.projector.ds;
  if (!ds.community.exists) return { ok: false, code: 'E_NOT_FOUND' };
  const invite = ds.invites.get(args.invitePublicKeyHex.toLowerCase());
  if (invite === undefined) return { ok: false, code: 'E_NOT_FOUND' };
  const selfHex = identity.publicKey.toString('hex');
  const ehAutor = invite.createdBy.toString('hex') === selfHex;
  if (!ehAutor && !memberHasPermission(ds, selfHex, 'manage_community')) return { ok: false, code: 'E_PERMISSION_DENIED' };
  const r = await deps.runtime.client.submitSync(args.communityId, {
    kindName: 'invite.revoke',
    payload: { invitePublicKey: Buffer.from(args.invitePublicKeyHex, 'hex') },
  });
  if (!r.ok) return { ok: false, code: r.code };
  return { ok: true, seq: r.seq };
}

// ─── community.end / community.forget (§15.4, §18.5, §18.4) ──────────────────────────────

export type EndCommunityResult =
  | { readonly ok: true; readonly seq: number; readonly replicatedTo: number }
  | { readonly ok: false; readonly code: string; readonly field?: string };

/**
 * `community.end ⏱` (§15.4, §18.5) — main-confirmed; só o `hostKey` corrente encerra
 * (R-17, conferido aqui de forma advisória e de novo pelo `fold` no estágio 14). A op é
 * síncrona pela ponte; confirmado o `seq`, corre o MESMO orçamento de draining de §18.7
 * ("o mesmo procedimento vale para community.end") com a MESMA barreira — fila vazia,
 * projeção na cabeça e `min(3, memberCount − 1)` pares confirmando —, ou `DRAIN_BUDGET_MS`
 * (§27.2), o que vier primeiro. A comunidade fica
 * aberta em leitura: zero ops novas é decisão do `fold` (estágio 5), membros veem
 * `community.ended` pelo notify do lote.
 */
export async function endCommunity(
  deps: InviteSurfaceDeps & { now(): number },
  a: { communityId: string; reason?: string },
): Promise<EndCommunityResult> {
  const identity = deps.selfKey();
  if (identity === null) return { ok: false, code: 'E_NO_IDENTITY' };
  const c = deps.runtime.get(a.communityId);
  if (c === undefined || !c.projector.ds.community.exists) return { ok: false, code: 'E_NOT_FOUND' };
  if (!c.isHost || c.projector.ds.community.hostKey.toString('hex') !== identity.publicKey.toString('hex')) {
    return { ok: false, code: 'E_NOT_HOST' };
  }
  if (c.projector.ds.community.endedAt !== undefined) return { ok: false, code: 'E_COMMUNITY_ENDED' };
  if (a.reason !== undefined && !checkModerationReason(a.reason).ok) {
    return { ok: false, code: 'E_VALIDATION', field: 'reason' };
  }

  const r = await deps.runtime.client.submitSync(a.communityId, {
    kindName: 'community.end',
    payload: { ...(a.reason !== undefined ? { reason: a.reason } : {}) },
  });
  if (!r.ok) return { ok: false, code: r.code, ...(r.field !== undefined ? { field: r.field } : {}) };

  // §18.7 passo 2 — a barreira é por confirmação de PARES (B10). Encerrar uma comunidade é
  // o momento em que o log para de crescer para sempre: sair antes de alguém tê-lo é
  // perdê-lo, e o sinal local não distinguia os dois casos.
  const prazo = deps.now() + DEFAULT_CONFIG.drainBudgetMs;
  const alvo = deps.runtime.alvoDeConfirmacoes(c);
  while (deps.now() < prazo) {
    const pendentes = deps.manifest.countActive(a.communityId);
    const atraso = c.projector.interpretedSeq < c.core.length - 1;
    const confirmadas = deps.runtime.confirmacoesDe(c);
    if (pendentes === 0 && !atraso && confirmadas >= alvo) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // `replicatedTo` é quantos PARES levaram o log, não até onde ESTA máquina interpretou.
  return { ok: true, seq: r.seq, replicatedTo: deps.runtime.confirmacoesDe(c) };
}

export type ForgetCommunityResult = { ok: true } | { ok: false; code: string };

/**
 * `community.forget` (§15.4, §18.4) — main-confirmed: apaga ANTES do prazo a réplica local
 * de uma comunidade já `left`/`removed`. Comunidade ainda participada é recusa nomeada
 * (emenda datada na tabela: `E_VALIDATION`) — esquecer exige ter saído ou sido removido.
 */
export async function forgetCommunity(
  args: {
    manifest: ManifestDb;
    forget(communityId: string): void;
    purge(): Promise<void>;
    /** §18.5 — a comunidade é terminal? Opcional: sem a porta, só left/removed é esquecível. */
    isEnded?(communityId: string): boolean;
  },
  communityId: string,
): Promise<ForgetCommunityResult> {
  const row = args.manifest.getCommunity(communityId) as
    | { left_at: number | null; removed_reason: string | null; core_key: Buffer; blobs_key: Buffer }
    | null;
  if (row === null) return { ok: false, code: 'E_NOT_FOUND' };
  // **Comunidade encerrada também é esquecível (B8, emenda de 2026-08-28).** A pré-condição
  // era `left_at` ou `removed_reason`, e o caminho documentado para uma comunidade encerrada
  // em que ainda sou membro era "sair, depois esquecer" — que **não existe**: §18.5 a deixa
  // terminal e o estágio 5 do `fold` recusa toda op nova, `member.leave` inclusive
  // (`E_COMMUNITY_ENDED`). O passo 1 daquela sequência é impossível, então o 2 era
  // inalcançável e a comunidade ficava no rail para sempre.
  //
  // E a distinção não significa nada aqui: num log que nunca mais recebe registro, "ainda
  // sou membro" não descreve relação nenhuma. Continua sendo escolha explícita — é
  // main-confirmed (§15.3), com diálogo nativo.
  const encerrada = args.isEnded?.(communityId) === true;
  if (row.left_at === null && row.removed_reason === null && !encerrada) {
    return { ok: false, code: 'E_VALIDATION' };
  }
  // A orquestração é a mesma do `removed.purge`, disparada fora da cadência: esquecer do
  // runtime/swarm PRIMEIRO, purgar bancos e disco depois (§54.1).
  args.forget(communityId);
  await args.purge();
  return { ok: true };
}
