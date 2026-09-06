// O protocolo `p2p-admission/1` de §16.1 sobre o canal pré-membro de §12.3 — as duas
// direções compostas num serviço só, porque **uma** assinatura de `onAdmissionChannel` tem
// de decidir dos dois lados: candidato é quem tem sessão aberta para aquele tópico; host é
// quem tem aquele convite conhecido no DS de uma comunidade hospedada.
//
// Este arquivo é raiz de composição (§4). As decisões de admissão moram onde sempre
// estiveram: os seis desfechos de §12.3 e o consumo atômico de `maxUses` são do
// `InviteManager`/`HostAdmission`/`fold` (G3/A08 — não reabertos aqui); o que este serviço
// compõe é o transporte, os tetos de §12.6 e a persistência pós-resgate.
//
// Tetos aplicados aqui, e por quê:
//   §12.6 orçamento de conexões pré-membro por tópico de convite — recusa o canal na hora.
//   §12.6 rate limit por `remotePublicKey` e por /24 — aplicado **antes** do decode
//        (§14.4, ordem 1→2): quadro limitado não existe para nós. É node-level, uma única
//        vez — o `InviteManager` não recebe o par justamente para não limitar duas vezes.
//   §12.3 passo 4 prova errada → fecha a conexão, sem segunda tentativa.
//   §14.3(5) enquanto houver convite hospedado, o firewall de conexão cede (`setPreMemberSurface`);
//            a autorização por comunidade (§14.3(1)) não muda.

import { KINDS, OP_VERSION, decodeEnvelope, decodeOp } from '../l1/opCodec/index.ts';
import { checkDisplayName, type DecisionState } from '../l1/fold/index.ts';
import type { ManifestDb } from '../l0/manifest/index.ts';
import type { Swarm } from '../l0/swarm/index.ts';
import {
  PreMemberRateLimiter,
  createJoinProof,
  createLiveProof,
  deriveInviteKeypair,
  deriveInviteTopicHex,
  isInviteLive as conviteVivo,
  parseCodeOrLink,
  type InvitePreview,
} from '../l2/invites/index.ts';
import { RPC_TIMEOUT_REDEEM_MS, RpcClient } from '../l3/rpcClient/index.ts';
import { RpcServer } from '../l3/rpcServer/index.ts';
import type { ProtomuxTransport } from '../l3/rpcServer/protomux.ts';
import type { CoreRuntime } from './boot.ts';
import { aeadSealPacked, memberBlobsKeyPairFor, type BootIdentityLike } from './community.ts';
import { opCodecSignPort } from './ports.ts';
import type { AdmissionChannelInfo, CommunityTransport } from './transport.ts';

/** Espera por conexão no tópico, por rodada — acima do timeout de request pré-membro (10 s, §16.1). */
const ESPERA_CANAL_MS = 8_000;
/**
 * Rodadas de descoberta antes de declarar o host inalcançável: a consulta da DHT nem
 * sempre acha o anúncio na primeira passada, e sair/entrar no tópico a reinicia.
 *
 * **Três, não quatro, e o teto é do renderer.** `invite.resolve`/`invite.redeem` correm sob
 * o prazo de 30 s de §16.1; quatro rodadas de 8 s são 32 s, e o prazo estourava ANTES de o
 * núcleo desistir. O resultado é que o desfecho 6 de §12.3 — "host offline / inalcançável"
 * — nunca chegava à tela: quem tentava um convite que não resolve via `E_TIMEOUT`, que não
 * diz nada, no lugar de `E_HOST_UNAVAILABLE`. Nada se perde no corte: o que passasse de
 * 30 s já morria no renderer.
 */
const RODADAS_CANAL = 3;

/**
 * §12.3 desfecho 6 — "host offline / inalcançável (**decidido pelo cliente**)".
 *
 * É desfecho de `inviteResolve`, e não recusa: a coluna de §12.5 lista `unreachable` ao
 * lado de `invalid`, e U-03 exige que a tela diga que o convite pode estar bom e ofereça
 * tentar de novo — o oposto de "este convite não vale". A implementação rejeitava com
 * `E_HOST_UNAVAILABLE`, então o único desfecho que o cliente decide sozinho era o único
 * que nunca chegava à tela: o renderer tinha o ramo escrito e ele era inalcançável, e a
 * pessoa via o banner genérico de erro com um código de §20 dentro.
 *
 * `redeem` continua recusando: lá o desfecho vira código pela coluna de §15.4
 * (`desfechoParaCodigo` devolve `E_HOST_UNAVAILABLE` para `unreachable`), porque resgatar
 * é escrita e escrita que não aconteceu é recusa.
 */
const INALCANCAVEL: InvitePreview = { status: 'unreachable' };

function b64(b: Uint8Array): string {
  return Buffer.from(b).toString('base64');
}

function unb64(v: unknown): Buffer | null {
  if (typeof v !== 'string') return null;
  const b = Buffer.from(v, 'base64');
  return b.length > 0 ? b : null;
}

/** Um canal de §16.1 que só aceita o que o rate limit de §12.6 deixar passar (§14.4 ordem 2→3). */
function gateLimitado(
  inner: ProtomuxTransport,
  peerKeyHex: string,
  address: string | undefined,
  limiter: PreMemberRateLimiter,
): Pick<ProtomuxTransport, 'send' | 'onFrame' | 'onDown'> {
  return {
    send: (frame) => inner.send(frame),
    onFrame: (cb) => {
      inner.onFrame((raw) => {
        if (!limiter.check(peerKeyHex, address).allowed) return;
        cb(raw);
      });
    },
    onDown: (cb) => inner.onDown(cb),
  };
}

/**
 * O canal padrão da comunidade (§15.4 `community.create`/`invite.redeem` respondem o
 * `defaultChannelId`): o **primeiro** canal criado — a ordem de inserção de `ds.channels` é
 * a ordem de aplicação do log, e a gênese cria #geral primeiro. Decisão registrada em §46:
 * "canal padrão" é posição de criação, não campo do DS.
 */
function canalPadraoDe(ds: DecisionState): string | null {
  for (const [id] of ds.channels) return id;
  return null;
}

/** Desfecho de preview → código de erro de `invite.redeem` (coluna de §15.4). */
function desfechoParaCodigo(preview: InvitePreview): string {
  switch (preview.status) {
    case 'banned':
      return 'E_BANNED';
    case 'ended':
      return 'E_COMMUNITY_ENDED';
    case 'unreachable':
      return 'E_HOST_UNAVAILABLE';
    default:
      // `invalid` e `already-member`: o fold recusaria o join com E_INVITE_INVALID nos dois
      // casos (R-9: par `(invitePk, autor)` já usado conta como inválido).
      return 'E_INVITE_INVALID';
  }
}

type ChamadaResultado = { readonly ok: true; readonly body: Record<string, unknown> } | { readonly ok: false; readonly code: string };

async function chamada(
  client: RpcClient,
  method: string,
  payload: Record<string, unknown>,
  timeoutMs?: number,
): Promise<ChamadaResultado> {
  const r = await client.call(
    method,
    new Uint8Array(Buffer.from(JSON.stringify(payload), 'utf8')),
    ...(timeoutMs !== undefined ? [{ timeoutMs }] : []),
  );
  if (!r.ok) return { ok: false, code: r.code };
  try {
    return { ok: true, body: JSON.parse(Buffer.from(r.body).toString('utf8')) as Record<string, unknown> };
  } catch {
    return { ok: false, code: 'E_MALFORMED' };
  }
}

/** Sessão candidata por código normalizado — vive enquanto o convite não foi cumprido. */
type Sessao = {
  readonly invitePk: Buffer;
  readonly inviteSk: Buffer;
  readonly topicHex: string;
  transport: ProtomuxTransport | null;
  client: RpcClient | null;
  hostPk: Buffer | null;
  /** Último preview recebido — resolve repetido não refaz o round-trip. */
  lastPreview: InvitePreview | null;
  /** Último preview `ok`, com o `communityId` que §12.4 passo 1 exige para o resgate. */
  previewOk: { readonly communityId: string } | null;
  readonly waiters: Array<() => void>;
};

export type AdmissionServiceDeps = {
  readonly runtime: CoreRuntime;
  readonly swarm: Swarm;
  readonly manifest: ManifestDb;
  /** §5.4 — protege a semente do core de blobs de quem entra. */
  readonly dataKey: Buffer;
  /** `<dataDir>/cores` (§10.1) — onde nasce o core da comunidade resgatada. */
  readonly coresDir: string;
  selfKey(): BootIdentityLike | null;
  /** Perfil local — fonte de `displayName`/`avatarColor` quando o comando não traz. */
  profile(): { displayName: string; avatarColor: number } | null;
  now(): number;
};

export type ResolveResultado =
  | { readonly ok: true; readonly preview: InvitePreview }
  | { readonly ok: false; readonly code: string };

export type RedeemResultado =
  | { readonly ok: true; readonly communityId: string; readonly defaultChannelId: string; readonly seq: number }
  | { readonly ok: false; readonly code: string };

export class AdmissionService {
  readonly #deps: AdmissionServiceDeps;
  readonly #limiter = new PreMemberRateLimiter();
  readonly #codec = opCodecSignPort();
  readonly #sessoes = new Map<string, Sessao>();
  /** Tópico → pares com canal pré-membro aberto agora (orçamento de §12.6). */
  readonly #ocupacao = new Map<string, Set<string>>();
  #transport: CommunityTransport | null = null;
  #offAdmission: (() => void) | null = null;
  #offProjected: (() => void) | null = null;

  constructor(deps: AdmissionServiceDeps) {
    this.#deps = deps;
    deps.runtime.onTransport((t) => this.#ligar(t));
  }

  // ─── Lado comum ─────────────────────────────────────────────────────────────────────

  #ligar(t: CommunityTransport): void {
    if (this.#transport !== null) return;
    this.#transport = t;
    this.#offAdmission = t.onAdmissionChannel((info) => this.#distribuirCanal(info));
    this.#reconciliar();
    this.#offProjected = this.#deps.runtime.onProjected(() => this.#reconciliar());
  }

  /** Transporte anexado (ou o primeiro que anexar). Sem rede, não há admissão pela rede. */
  async #garantirTransporte(): Promise<CommunityTransport | null> {
    const t = await this.#deps.runtime.whenTransport();
    if (t === null) return null;
    this.#ligar(t);
    return t;
  }

  /**
   * Uma direção só pode existir por tópico: se há sessão candidata esperando, o canal é do
   * candidato; senão, este nó tenta servir como host. Quem não é nem um nem outro recusa.
   */
  #distribuirCanal(info: AdmissionChannelInfo): boolean {
    for (const sessao of this.#sessoes.values()) {
      if (sessao.topicHex === info.topicHex) return this.#canalCandidato(sessao, info);
    }
    return this.#aceitarComoHost(info);
  }

  // ─── Candidato (§12.3 passos 1–3; §12.4 passos 1–2 e 6) ──────────────────────────────

  async resolve(a: { readonly codeOrLink: string }): Promise<ResolveResultado> {
    const parsed = parseCodeOrLink(a.codeOrLink);
    if ('error' in parsed) return { ok: false, code: parsed.error };
    const identity = this.#deps.selfKey();
    if (identity === null) return { ok: false, code: 'E_NO_IDENTITY' };
    const transporte = await this.#garantirTransporte();
    if (transporte === null) return { ok: true, preview: INALCANCAVEL };

    const sessao = this.#sessao(parsed.normalized, parsed.secret);
    transporte.seekInviteTopic(sessao.topicHex);
    if (!(await this.#esperarCanal(sessao, transporte))) return { ok: true, preview: INALCANCAVEL };
    const cliente = sessao.client!;
    if (sessao.lastPreview !== null) return { ok: true, preview: sessao.lastPreview };

    const hello = await chamada(cliente, 'admissionHello', { clientOpVersion: OP_VERSION });
    if (!hello.ok) return { ok: false, code: hello.code };
    const challenge = unb64(hello.body['challenge']);
    const hostPk = unb64(hello.body['hostPk']);
    if (challenge === null || hostPk === null) return { ok: false, code: 'E_MALFORMED' };
    if (hello.body['hostOpVersion'] !== OP_VERSION) return { ok: false, code: 'E_VERSION_UNSUPPORTED' };
    sessao.hostPk = hostPk;

    // §12.3 passo 3 — liveProof amarra hostPk + candidatePk + challenge (T-06).
    const liveProof = createLiveProof(sessao.inviteSk, sessao.invitePk, hostPk, identity.publicKey, challenge);
    const r = await chamada(cliente, 'inviteResolve', {
      invitePk: b64(sessao.invitePk),
      candidatePk: b64(identity.publicKey),
      liveProof: b64(liveProof),
      challenge: b64(challenge),
    });
    if (!r.ok) return { ok: false, code: r.code };
    const preview = r.body as unknown as InvitePreview;
    if (typeof preview !== 'object' || preview === null || typeof preview.status !== 'string') {
      return { ok: false, code: 'E_MALFORMED' };
    }
    sessao.lastPreview = preview;
    if (preview.status === 'ok') sessao.previewOk = { communityId: preview.community.id };
    return { ok: true, preview };
  }

  /**
   * `invite.redeem` (§12.4). Exige o `communityId` que só o preview devolve — se não houve
   * resolve antes, resolve aqui. O desafio do preview já foi consumido (consumo único),
   * então o resgate pede challenge fresco num `admissionHello` novo e usa o timeout de
   * 30 s que §16.1 reserva para `redeem`.
   */
  async redeem(a: { readonly codeOrLink: string; readonly displayName?: string; readonly avatarColor?: number }): Promise<RedeemResultado> {
    const parsed = parseCodeOrLink(a.codeOrLink);
    if ('error' in parsed) return { ok: false, code: parsed.error };
    const identity = this.#deps.selfKey();
    if (identity === null) return { ok: false, code: 'E_NO_IDENTITY' };
    const perfil = this.#deps.profile();
    const displayName = a.displayName ?? perfil?.displayName;
    if (displayName === undefined || !checkDisplayName(displayName).ok) return { ok: false, code: 'E_VALIDATION' };
    const avatarColor = a.avatarColor ?? perfil?.avatarColor ?? 0;
    if (!Number.isInteger(avatarColor) || avatarColor < 0 || avatarColor > 255) return { ok: false, code: 'E_VALIDATION' };

    const transporte = await this.#garantirTransporte();
    const sessao = this.#sessao(parsed.normalized, parsed.secret);
    if (transporte === null) return { ok: false, code: 'E_HOST_UNAVAILABLE' };

    if (sessao.previewOk === null) {
      const pre = await this.resolve(a);
      if (!pre.ok) return { ok: false, code: pre.code };
      if (pre.preview.status !== 'ok') return { ok: false, code: desfechoParaCodigo(pre.preview) };
    }
    const alvoCid = sessao.previewOk!.communityId;
    if (sessao.client === null && !(await this.#esperarCanal(sessao, transporte))) return { ok: false, code: 'E_HOST_UNAVAILABLE' };

    // Core de blobs local de quem entra (§13.1): a semente é DERIVADA da identidade —
    // `BLAKE2b-256('ns/memberblobs/1' ‖ identitySeed ‖ communityId)`, a linha de §5.2 —,
    // não sorteada. Assim a chave publicada no `member.join` volta a existir a partir do
    // backup de §5.5 sozinho; a linha cifrada do manifest é atalho e verificação cruzada.
    const cidBuf = Buffer.from(alvoCid, 'hex');
    const blobs = memberBlobsKeyPairFor(identity, cidBuf);
    const blobsPublicKey = blobs.publicKey;
    this.#deps.manifest.setMemberBlobsCore({
      communityId: alvoCid,
      coreKey: blobsPublicKey,
      secretSeedEnc: aeadSealPacked(blobs.seed, this.#deps.dataKey),
    });

    // §12.4 passo 1 — a Op member.join assinada pelo PRÓPRIO candidato (F-06).
    const joinProof = createJoinProof(sessao.inviteSk, cidBuf, sessao.invitePk, identity.publicKey);
    const encodedPayload = this.#codec.encodePayload('member.join', {
      invitePublicKey: sessao.invitePk,
      joinProof,
      displayName,
      avatarColor,
      blobsCoreKey: blobsPublicKey,
    });
    if (encodedPayload === null) return { ok: false, code: 'E_INTERNAL' };
    const sealed = this.#codec.sealOp({
      opVersion: OP_VERSION,
      communityId: cidBuf,
      kindNumber: KINDS['member.join'],
      author: identity.publicKey,
      secretKey: identity.secretKey,
      sequenceScope: { kind: 'community' },
      authorSeq: 1,
      ts: this.#deps.now(),
      payload: encodedPayload,
    });

    const hello = await chamada(sessao.client!, 'admissionHello', { clientOpVersion: OP_VERSION });
    if (!hello.ok) return { ok: false, code: hello.code };
    const challenge = unb64(hello.body['challenge']);
    const hostPk = unb64(hello.body['hostPk']);
    if (challenge === null || hostPk === null) return { ok: false, code: 'E_MALFORMED' };
    sessao.hostPk = hostPk;
    const liveProof = createLiveProof(sessao.inviteSk, sessao.invitePk, hostPk, identity.publicKey, challenge);
    const r = await chamada(
      sessao.client!,
      'inviteRedeem',
      { envelope: b64(sealed.envelope), liveProof: b64(liveProof), challenge: b64(challenge) },
      RPC_TIMEOUT_REDEEM_MS,
    );
    if (!r.ok) return { ok: false, code: r.code };
    const resp = r.body;
    if (
      typeof resp['seq'] !== 'number' ||
      typeof resp['communityId'] !== 'string' ||
      typeof resp['coreKey'] !== 'string' ||
      typeof resp['blobsKey'] !== 'string' ||
      typeof resp['defaultChannelId'] !== 'string'
    ) {
      return { ok: false, code: 'E_MALFORMED' };
    }

    // §12.4 passo 6 / §5.3 último parágrafo — participação no manifest e a comunidade no
    // runtime, na mesma respiração e SEM reiniciar o processo. O transporte entra no tópico
    // do log pelo gancho `onOpen` e a replicação segue o caminho de §45.
    const coreKey = Buffer.from(resp['coreKey'], 'hex');
    const blobsKey = Buffer.from(resp['blobsKey'], 'hex');
    this.#deps.manifest.upsertCommunity({
      communityId: resp['communityId'],
      coreKey,
      blobsKey,
      isHost: false,
      joinedAt: this.#deps.now(),
    });
    try {
      this.#deps.runtime.register(
        await this.#deps.runtime.openCommunity({
          community_id: resp['communityId'],
          core_key: coreKey,
          blobs_key: blobsKey,
          is_host: 0,
          left_at: null,
        }),
      );
    } catch {
      return { ok: false, code: 'E_INTERNAL' };
    }

    // Convite cumprido: para de procurar o tópico e descarta a sessão. (`leave` encerra
    // a descoberta, não a conexão — os tópicos não são donos de conexão no hyperswarm.)
    transporte.releaseInviteTopic(sessao.topicHex);
    sessao.transport?.close();
    this.#sessoes.delete(parsed.normalized);
    return { ok: true, communityId: resp['communityId'], defaultChannelId: resp['defaultChannelId'], seq: resp['seq'] };
  }

  #sessao(normalizedCode: string, secret: Buffer): Sessao {
    const existente = this.#sessoes.get(normalizedCode);
    if (existente !== undefined) return existente;
    const { publicKey, secretKey } = deriveInviteKeypair(secret);
    const nova: Sessao = {
      invitePk: publicKey,
      inviteSk: secretKey,
      topicHex: deriveInviteTopicHex(publicKey),
      transport: null,
      client: null,
      hostPk: null,
      lastPreview: null,
      previewOk: null,
      waiters: [],
    };
    this.#sessoes.set(normalizedCode, nova);
    return nova;
  }

  async #esperarCanal(sessao: Sessao, transporte: CommunityTransport): Promise<boolean> {
    for (let rodada = 0; rodada < RODADAS_CANAL; rodada++) {
      if (await this.#esperarUmaRodada(sessao)) return true;
      // Reinicia a consulta: sair e entrar de novo no tópico derruba a sessão de busca
      // velha, que pode ter corrido antes de o anúncio do host se propagar pela DHT.
      transporte.releaseInviteTopic(sessao.topicHex);
      transporte.seekInviteTopic(sessao.topicHex);
    }
    return false;
  }

  async #esperarUmaRodada(sessao: Sessao): Promise<boolean> {
    if (sessao.transport !== null) return true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ESPERA_CANAL_MS);
      timer.unref?.();
      sessao.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    return sessao.transport !== null;
  }

  #canalCandidato(sessao: Sessao, info: AdmissionChannelInfo): boolean {
    if (sessao.transport !== null) {
      // Já há canal para este convite; um segundo host não adiciona nada ao fluxo de §12.3.
      return false;
    }
    sessao.transport = info.transport;
    sessao.client = new RpcClient({ protocol: 'admission', transport: info.transport, role: 'pre-member' });
    info.transport.onDown(() => {
      if (sessao.transport === info.transport) {
        sessao.transport = null;
        sessao.client = null;
        sessao.hostPk = null;
      }
    });
    for (const w of sessao.waiters.splice(0)) w();
    return true;
  }

  // ─── Host (§12.3 passos 2–5; §12.4 passos 3–5) ───────────────────────────────────────

  /**
   * Que comunidade hospedada conhece o convite deste tópico? Procura em **qualquer** estado
   * (revogado/expirado/esgotado inclusive): é assim que o preview responde `invalid` em vez
   * de deixar o candidato sem resposta. Tópico desconhecido → recusa.
   */
  #comunidadePorTopico(topicHex: string): { readonly communityId: string; readonly invitePkHex: string } | null {
    for (const c of this.#deps.runtime.communities()) {
      if (!c.isHost || c.host === null) continue;
      for (const [pkHex] of c.projector.ds.invites) {
        if (deriveInviteTopicHex(Buffer.from(pkHex, 'hex')) === topicHex) {
          return { communityId: c.communityId, invitePkHex: pkHex };
        }
      }
    }
    return null;
  }

  #aceitarComoHost(info: AdmissionChannelInfo): boolean {
    const alvo = this.#comunidadePorTopico(info.topicHex);
    if (alvo === null) return false;
    const aberta = this.#deps.runtime.get(alvo.communityId);
    if (aberta === undefined || aberta.host === null) return false;
    const manager = aberta.host.invites;

    // Orçamento de conexões pré-membro (§12.6): por tópico de convite, separado do
    // orçamento de membros. Estourou → recusa o canal na hora, sem trabalho nenhum.
    let ocupados = this.#ocupacao.get(info.topicHex);
    if (ocupados === undefined) {
      ocupados = new Set<string>();
      this.#ocupacao.set(info.topicHex, ocupados);
    }
    const orcamento = this.#deps.swarm.budget.preMemberBudget;
    if (ocupados.has(info.peerKeyHex) === false && ocupados.size >= orcamento) return false;
    ocupados.add(info.peerKeyHex);
    info.transport.onDown(() => {
      const atual = this.#ocupacao.get(info.topicHex);
      if (atual !== undefined) atual.delete(info.peerKeyHex);
    });

    const server = new RpcServer({ protocol: 'admission', transport: gateLimitado(info.transport, info.peerKeyHex, info.address, this.#limiter) });
    const peerKeyBuf = Buffer.from(info.peerKeyHex, 'hex');

    server.register('admissionHello', (body) => {
      let arg: Record<string, unknown>;
      try {
        arg = JSON.parse(Buffer.from(body).toString('utf8')) as Record<string, unknown>;
      } catch {
        return { code: 'E_MALFORMED' };
      }
      if (arg['clientOpVersion'] !== OP_VERSION) return { code: 'E_VERSION_UNSUPPORTED' };
      const ch = manager.createChallenge();
      return Buffer.from(
        JSON.stringify({ challenge: b64(ch.challenge), hostPk: b64(ch.hostPublicKey), hostOpVersion: OP_VERSION }),
        'utf8',
      );
    });

    server.register('inviteResolve', (body) => {
      let arg: Record<string, unknown>;
      try {
        arg = JSON.parse(Buffer.from(body).toString('utf8')) as Record<string, unknown>;
      } catch {
        return { code: 'E_MALFORMED' };
      }
      const invitePk = unb64(arg['invitePk']);
      const candidatePk = unb64(arg['candidatePk']);
      const liveProof = unb64(arg['liveProof']);
      const challenge = unb64(arg['challenge']);
      if (invitePk === null || candidatePk === null || liveProof === null || challenge === null) return { code: 'E_MALFORMED' };
      const r = manager.preview({ invitePublicKey: invitePk, candidatePublicKey: candidatePk, liveProof, challenge });
      if (r.status === 'proof-invalid') {
        // §12.3 passo 4 / §12.6 — fecha a conexão, sem segunda tentativa. A resposta pode
        // não sair a tempo; o fechamento é o contrato.
        queueMicrotask(() => info.transport.close());
        return { code: 'E_INVITE_INVALID' };
      }
      return Buffer.from(JSON.stringify(r), 'utf8');
    });

    server.register('inviteRedeem', async (body) => {
      let arg: Record<string, unknown>;
      try {
        arg = JSON.parse(Buffer.from(body).toString('utf8')) as Record<string, unknown>;
      } catch {
        return { code: 'E_MALFORMED' };
      }
      const envelope = unb64(arg['envelope']);
      const liveProof = unb64(arg['liveProof']);
      const challenge = unb64(arg['challenge']);
      if (envelope === null || liveProof === null || challenge === null) return { code: 'E_MALFORMED' };
      // F-06 — ninguém assina por terceiro: o autor do envelope tem de ser o próprio par
      // da conexão (a `remotePublicKey` do Noise).
      const dec = decodeEnvelope(envelope);
      const op = dec === null ? null : decodeOp(dec.op);
      if (op === null) return { code: 'E_MALFORMED' };
      if (!op.author.equals(peerKeyBuf)) return { code: 'E_AUTHOR_MISMATCH' };
      const r = await manager.redeem({
        envelope,
        liveProof,
        challenge,
        candidatePublicKey: op.author,
        invitePublicKey: Buffer.from(alvo.invitePkHex, 'hex'),
      });
      if (!r.ok) return { code: r.code };
      // §12.4 passo 5 — o que o candidato não tem e só o host pode dar.
      const linha = this.#deps.manifest.getCommunity(alvo.communityId) as { blobs_key?: Buffer } | null;
      const padrao = canalPadraoDe(aberta.projector.ds);
      if (linha === null || linha.blobs_key === undefined || padrao === null) return { code: 'E_INTERNAL' };
      return Buffer.from(
        JSON.stringify({
          seq: r.seq,
          communityId: alvo.communityId,
          coreKey: alvo.communityId,
          blobsKey: Buffer.from(linha.blobs_key).toString('hex'),
          defaultChannelId: padrao,
          hostKey: aberta.projector.ds.community.hostKey.toString('hex'),
        }),
        'utf8',
      );
    });
    return true;
  }

  // ─── Reconciliação da superfície hospedada (§12.2 passo 3 + §14.3(5)) ────────────────

  #reconciliar(): void {
    const t = this.#transport;
    if (t === null) return;
    const topics = new Set<string>();
    for (const c of this.#deps.runtime.communities()) {
      if (!c.isHost || c.host === null) continue;
      for (const [pkHex, invite] of c.projector.ds.invites) {
        if (!conviteVivo(invite, this.#deps.now())) continue;
        topics.add(deriveInviteTopicHex(Buffer.from(pkHex, 'hex')));
      }
    }
    t.serveInviteTopics([...topics]);
    // Enquanto houver convite hospedado, o firewall de conexão cede ao canal pré-membro.
    this.#deps.swarm.backend?.setPreMemberSurface?.(topics.size > 0 ? () => topics.size > 0 || this.#temConviteAtivo() : null);
  }

  /**
   * `invite.topicSweep` de §22.2 — o job de 15 min. A reconciliação por lote projetado já
   * derruba o tópico de convite revogado ou esgotado, porque as duas coisas são registro no
   * log; **expirar não é registro nenhum**: o convite morre pela passagem do tempo, e sem
   * este job uma comunidade parada continuaria anunciando na DHT um convite vencido até o
   * próximo lote qualquer. O relógio é o local do host, que é quem anuncia.
   */
  sweepInviteTopics(): void {
    this.#reconciliar();
  }

  #temConviteAtivo(): boolean {
    const agora = this.#deps.now();
    for (const c of this.#deps.runtime.communities()) {
      if (!c.isHost || c.host === null) continue;
      for (const [, invite] of c.projector.ds.invites) if (conviteVivo(invite, agora)) return true;
    }
    return false;
  }

  stop(): void {
    this.#offAdmission?.();
    this.#offProjected?.();
    this.#offAdmission = null;
    this.#offProjected = null;
    for (const sessao of this.#sessoes.values()) sessao.transport?.close();
    this.#sessoes.clear();
    this.#ocupacao.clear();
  }
}
