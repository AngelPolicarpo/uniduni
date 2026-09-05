// `shareStar` — sessão de tela em estrela host-side: autorização, teto, qualidade por
// espectador e saúde (§17.5, §6.16, §RPC `share.*`, A19, A22). L2 sobre o
// `voiceCoordinator`, de onde os tickets e a porta de estado vêm (§4).
//
// Fase 8: a camada de decisão nasceu no `voiceCoordinator` durante o G8 (§24) e migrou
// para cá na implementação da fase 8 (§25). O núcleo nunca vê mídia: a estrela é WebRTC
// no renderer; aqui vivem só as decisões — autorização do `share.start`, teto de
// espectadores, captureToken, qualidade corrente por espectador e derivação de encerramento.
//
// Ordem obrigatória da captura (`T-41`, §17.4): `share.start` → host autoriza →
// `captureToken` → `getDisplayMedia`. Nunca o contrário. O token é opaco, aleatório,
// amarrado à sessão e comparado em tempo constante; quem valida é o próprio host que o
// emitiu (`capture.authorize`, IPC-M main→núcleo→main) — não há verificador terceiro,
// então ticket assinado aqui acrescentaria codificação sem propriedade nova.
//
// **Sem teto de espectadores (emenda de 2026-08-26, §90).** `SHARE_MAX_VIEWERS` 8 era
// número de política, não invariante da estrela: o que limita de verdade é o upload da
// máquina de quem apresenta, e disso quem cuida é a degradação medida de §17.5 — que já
// existe, já roda e lê perda real em vez de contar cabeças. Espectador continua sendo
// **participante do canal de voz** (A19/§17.5): não existe audiência fora da chamada
// (`F-18`), e essa é a única condição de entrada que sobrou.
//
// Entidades efêmeras de §6.16: `ShareSession` (topologia `star`) e os eventos
// `share.started`/`share.viewersChanged`/`share.stopped` saem pelo callback
// `onSessionEvent`; o fan-out aos destinatários conectados é da composição.

import crypto from 'node:crypto';

import { issueSessionTicket, ticketIdOf, type MediaTicket } from '../voiceCoordinator/tickets.ts';
import { memberHasPermission, type VoiceStatePort } from '../voiceCoordinator/host.ts';

export const SHARE_SCREEN = 'voice_share_screen' as const;

type Id = string;
type KeyHex = string;

// ─── Perfis de qualidade e saúde (§17.5) ────────────────────────────────────────────────

export type ShareQuality = 'high' | 'balanced' | 'low';

/** Perfis de §17.5 em kbps — valores do contrato `share.start`/`share.setQuality`. */
export const SHARE_QUALITY_PROFILES: Readonly<Record<ShareQuality, number>> = {
  high: 2500,
  balanced: 1200,
  low: 600,
};

/** Critério G8/plano: acima desta perda reportada pela saúde, degrada automaticamente. */
export const SHARE_LOSS_DEGRADE_PCT = 3;

const NEXT_LOWER: Readonly<Record<ShareQuality, ShareQuality | null>> = {
  high: 'balanced',
  balanced: 'low',
  low: null,
};

/** Ordem dos perfis para o caminho de sistema `degradeTo` (só desce). */
const SHARE_QUALITY_RANK: Readonly<Record<ShareQuality, number>> = {
  high: 2,
  balanced: 1,
  low: 0,
};

/**
 * Degradação automática de qualidade a partir da saúde da sessão (§17.5): perda
 * estritamente acima do limiar desce um perfil; na borda e abaixo não faz nada.
 * A subida não é automática — o texto normativo só define degradação.
 */
export function degradeOnLoss(quality: ShareQuality, lossPct: number): ShareQuality | null {
  if (!Number.isFinite(lossPct)) return null;
  if (lossPct <= SHARE_LOSS_DEGRADE_PCT) return null;
  return NEXT_LOWER[quality];
}

export function isShareQuality(value: unknown): value is ShareQuality {
  return value === 'high' || value === 'balanced' || value === 'low';
}

// ─── captureToken (T-41, §17.4) ─────────────────────────────────────────────────────────

export interface CaptureToken {
  /** Segredo opaco de 32 B em hex — vale só dentro da sessão que o gerou. */
  readonly token: string;
  readonly sessionId: string;
  readonly expiresAt: number;
}

export type AuthorizeCaptureResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: 'gone' | 'mismatch' | 'expired' };

function timingSafeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) {
    // comparação de comprimento diferente ainda consome tempo constante aproximado
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

// ─── Sessões de tela host-side (§17.5, §RPC `share.*`) ──────────────────────────────────

export type ShareErrorCode =
  | 'E_COMMUNITY_ENDED'
  | 'E_NOT_FOUND'
  | 'E_CHANNEL_NOT_FOUND'
  | 'E_CHANNEL_NOT_VOICE'
  | 'E_NOT_MEMBER'
  | 'E_BANNED'
  | 'E_TIMED_OUT'
  | 'E_PERMISSION_DENIED'
  | 'E_ALREADY_SHARING'
  | 'E_SESSION_GONE';

export interface ShareRevokedTarget {
  readonly sessionId: string;
  readonly channelId: Id;
  readonly targetKeyHex: KeyHex;
}

/** Entidade efêmera `ShareSession` de §6.16 — topologia fixa do v1 (A19). */
export const SHARE_TOPOLOGY = 'star' as const;

/**
 * Eventos de sessão que a composição mapeia para `share.started`,
 * `share.viewersChanged` e `share.stopped` (§RPC eventos, §6.16). `viewersChanged`
 * cobre entrada e saída de espectador; `stopped` cobre `share.stop`, saída do
 * apresentador e os encerramentos derivados do sweep.
 *
 * **Os três ramos carregam `channelId` e `presenterKeyHex`**, e não só o `started`. São os
 * campos que §16.3 declara no quadro de `share.started`/`share.stopped`, e são o que permite
 * à composição responder "para quem isto vai": os destinatários são os participantes DAQUELA
 * chamada (§17.5). Sem o canal no evento, `viewersChanged` e `stopped` não tinham como ser
 * endereçados e iam para toda a comunidade conectada.
 */
export type ShareSessionEvent =
  | { readonly kind: 'started'; readonly sessionId: string; readonly channelId: Id; readonly presenterKeyHex: KeyHex }
  | { readonly kind: 'viewersChanged'; readonly sessionId: string; readonly channelId: Id; readonly presenterKeyHex: KeyHex; readonly viewerCount: number }
  | { readonly kind: 'stopped'; readonly sessionId: string; readonly channelId: Id; readonly presenterKeyHex: KeyHex };

export interface ShareSessionSnapshot {
  readonly sessionId: string;
  readonly channelId: Id;
  readonly presenterKeyHex: KeyHex;
  readonly topology: typeof SHARE_TOPOLOGY;
  readonly quality: ShareQuality;
  readonly viewerCount: number;
  readonly viewers: readonly { readonly keyHex: KeyHex; readonly quality: ShareQuality }[];
}

interface ViewerEntry {
  quality: ShareQuality;
  joinedAt: number;
}

interface ShareSession {
  readonly sessionId: string;
  readonly channelId: Id;
  readonly presenterKeyHex: KeyHex;
  quality: ShareQuality;
  readonly startedAt: number;
  readonly captureExpiresAt: number;
  readonly captureToken: string;
  readonly viewers: Map<KeyHex, ViewerEntry>;
}

export interface JoinShareOk {
  readonly ok: true;
  readonly sessionId: string;
  readonly channelId: Id;
  readonly presenterKeyHex: KeyHex;
  readonly ticketId: string;
  readonly ticket: MediaTicket;
  readonly expiresAt: number;
}

export type StartShareOk = {
  readonly ok: true;
  readonly sessionId: string;
  readonly channelId: Id;
  readonly captureToken: CaptureToken;
};

export type SetQualityOk = {
  readonly ok: true;
  readonly applied: true;
  readonly quality: ShareQuality;
};

/**
 * Sessões de tela vivas do host. Estado **efêmero** como a voz (nunca persiste): uma
 * sessão por canal (delta U-10), espectadores são participantes da chamada (A19). A
 * autoridade estrutural é o `DecisionState` corrente, passado como argumento no `start`
 * e no `sweepAgainst`.
 */
export class ShareHostSessions {
  readonly #hostSecretKey: Buffer;
  readonly #clock: { now(): number };
  readonly #ttlMs: number;
  readonly #captureTtlMs: number;
  readonly #isVoiceChannelType: (type: number) => boolean;
  readonly #voiceParticipants: (channelId: Id) => ReadonlySet<KeyHex> | null;
  readonly #sessionIdFactory: () => string;
  /** Só a suíte injeta; em produto o id sai da assinatura (`ticketIdOf`), como na voz. */
  readonly #ticketIdFactory: (() => string) | null;
  readonly #onRevoked: (targets: readonly ShareRevokedTarget[]) => void;
  readonly #onSessionEvent: (event: ShareSessionEvent) => void;
  readonly #sessions = new Map<string, ShareSession>(); // sessionId → session

  constructor(opts: {
    hostSecretKey: Buffer;
    clock?: { now(): number };
    /** Composição injeta `MEDIA_TICKET_TTL_MS` (§27.1) — validade do ticket do espectador. */
    ttlMs: number;
    /**
     * Validade do captureToken. O texto normativo não fixa número (lacuna registrada em
     * §24); a composição injeta — default de produto curto, renovável pelo próprio
     * `share.start` idempotente? Não há renovação especificada: expirou, recusa.
     */
    captureTokenTtlMs: number;
    isVoiceChannelType: (type: number) => boolean;
    /** Porta: participantes efêmeros da chamada daquele canal — satisfeita pelo roster da voz. */
    voiceParticipants: (channelId: Id) => ReadonlySet<KeyHex> | null;
    sessionIdFactory?: () => string;
    ticketIdFactory?: () => string;
    onRevoked?: (targets: readonly ShareRevokedTarget[]) => void;
    onSessionEvent?: (event: ShareSessionEvent) => void;
  }) {
    this.#hostSecretKey = opts.hostSecretKey;
    this.#clock = opts.clock ?? { now: () => Date.now() };
    this.#ttlMs = opts.ttlMs;
    this.#captureTtlMs = opts.captureTokenTtlMs;
    this.#isVoiceChannelType = opts.isVoiceChannelType;
    this.#voiceParticipants = opts.voiceParticipants;
    this.#sessionIdFactory = opts.sessionIdFactory ?? (() => crypto.randomBytes(16).toString('hex'));
    this.#ticketIdFactory = opts.ticketIdFactory ?? null;
    this.#onRevoked = opts.onRevoked ?? (() => {});
    this.#onSessionEvent = opts.onSessionEvent ?? (() => {});
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  snapshotOf(sessionId: string): ShareSessionSnapshot | null {
    const s = this.#sessions.get(sessionId);
    if (s === undefined) return null;
    return this.#snapshot(s);
  }

  /**
   * As transmissões vivas de um canal. **Plural desde a emenda de 2026-08-26**: o canal
   * deixou de ter no máximo uma. Devolve na ordem em que começaram, que é a ordem em que a
   * UI as empilha.
   */
  sessionsOf(channelId: Id): readonly ShareSessionSnapshot[] {
    return [...this.#sessions.values()]
      .filter((s) => s.channelId === channelId)
      .sort((a, b) => a.startedAt - b.startedAt || a.sessionId.localeCompare(b.sessionId))
      .map((s) => this.#snapshot(s));
  }

  /**
   * Todas as sessões vivas. É o que permite ao monitor de saúde consolidar a partir da
   * **audiência autorizada** — quem passou pelo `join` e coube no teto — em vez de só a
   * partir de quem já rendeu amostra. Sem isso, `share.health` só falava de quem já estava
   * sendo servido, e o apresentador não tinha como descobrir a quem DEVE servir.
   */
  liveSessions(): readonly ShareSessionSnapshot[] {
    return [...this.#sessions.values()].map((s) => this.#snapshot(s));
  }

  /**
   * `share.start` (§RPC): valida contra o estado estrutural (mesmo recorte de §17.4
   * passo 1, com `voice_share_screen`), exige apresentador dentro da chamada (A19: a
   * sessão vive dentro dela) e devolve `{sessionId, captureToken}`.
   *
   * **Emenda de 2026-08-26 — o canal deixou de ter no máximo uma transmissão.** O teto de
   * "exatamente 1 por canal" vinha de `RT-06`, que era uma contradição entre documentos
   * (a UX pedia várias, o backend fixava `0..1`, o mock não implementava nenhuma) resolvida
   * a favor do que já estava escrito. Não era restrição de arquitetura: em estrela, a
   * trilha de tela **pega carona na conexão de voz que já existe** entre cada par, então um
   * segundo apresentador não abre malha nova — acrescenta uma trilha a conexões abertas. E
   * o upload não compõe: cada apresentador paga a própria estrela, na própria máquina.
   *
   * O que sobrou de `E_ALREADY_SHARING` é o teto que é real: **uma por apresentador por
   * canal**. Não é regra de protocolo, é o renderer — a captura de tela de uma instalação
   * é uma só, e deixar a mesma pessoa abrir duas sessões criaria a segunda sem stream para
   * alimentá-la.
   */
  start(args: {
    state: VoiceStatePort;
    channelId: Id;
    presenterKeyHex: KeyHex;
    quality?: ShareQuality;
  }): StartShareOk | { ok: false; code: ShareErrorCode } {
    const now = this.#clock.now();
    const state = args.state;
    const quality = args.quality ?? 'balanced';

    if (!state.community.exists) return { ok: false, code: 'E_NOT_FOUND' };
    if (state.community.endedAt !== undefined) return { ok: false, code: 'E_COMMUNITY_ENDED' };

    const channel = state.channels.get(args.channelId);
    if (channel === undefined || channel.deletedAt !== undefined) return { ok: false, code: 'E_CHANNEL_NOT_FOUND' };
    if (!this.#isVoiceChannelType(channel.type)) return { ok: false, code: 'E_CHANNEL_NOT_VOICE' };

    const eligibility = this.#memberEligible(state, args.presenterKeyHex, now);
    if (!eligibility.ok) return eligibility;

    if (!memberHasPermission(state, args.presenterKeyHex, SHARE_SCREEN)) {
      return { ok: false, code: 'E_PERMISSION_DENIED' };
    }

    const call = this.#voiceParticipants(args.channelId);
    if (call === null || !call.has(args.presenterKeyHex)) {
      // Sem chamada ativa não há sessão de tela: audiência e apresentador saem da chamada.
      return { ok: false, code: 'E_SESSION_GONE' };
    }

    for (const s of this.#sessions.values()) {
      if (s.channelId === args.channelId && s.presenterKeyHex === args.presenterKeyHex) {
        return { ok: false, code: 'E_ALREADY_SHARING' };
      }
    }

    const session: ShareSession = {
      sessionId: this.#sessionIdFactory(),
      channelId: args.channelId,
      presenterKeyHex: args.presenterKeyHex,
      quality,
      startedAt: now,
      captureExpiresAt: now + this.#captureTtlMs,
      captureToken: crypto.randomBytes(32).toString('hex'),
      viewers: new Map(),
    };
    this.#sessions.set(session.sessionId, session);
    this.#onSessionEvent({ kind: 'started', sessionId: session.sessionId, channelId: session.channelId, presenterKeyHex: session.presenterKeyHex });
    return {
      ok: true,
      sessionId: session.sessionId,
      channelId: session.channelId,
      captureToken: { token: session.captureToken, sessionId: session.sessionId, expiresAt: session.captureExpiresAt },
    };
  }

  /**
   * `share.join` (§RPC): devolve `{ticketId, ticket, presenterKey}`. Sessão inexistente →
   * `E_SESSION_GONE`; quem não está na chamada não tem audiência → `E_PERMISSION_DENIED`
   * (§17.5/A19). Não há recusa por lotação (§90).
   *
   * **O que o ticket de tela é, e o que ele NÃO é (correção de 2026-09-05).** A redação
   * anterior o apresentava como "A22 passos 3–4", isto é, como a autorização criptográfica
   * da audiência. Não é, e não tem por onde ser: a tela reusa a **mesma**
   * `RTCPeerConnection` da voz (§17.2/§17.3), que já está gateada pelo ticket de §17.4, e
   * §16.2 não tem campo em que este ticket viaje. O enforcement real da audiência é a lista
   * do host, reconferida a cada mudança de roster (§17.5, emenda de 2026-08-26).
   *
   * O que ele **é**: a origem do `ticketId`, agora derivado dele por `ticketIdOf` como em
   * §17.4, em vez de `randomBytes`. A assinatura Ed25519 é determinística sobre
   * `(sessionId, channelId, par ordenado, expiresAt)`, então o id é estável entre re-joins
   * e os dois lados chegam nele sozinhos — que era a propriedade que o id aleatório não
   * tinha e que a divergência com a voz escondia.
   */
  join(args: { sessionId: string; memberKeyHex: KeyHex }): JoinShareOk | { ok: false; code: ShareErrorCode } {
    const now = this.#clock.now();
    const session = this.#bySessionId(args.sessionId);
    if (session === undefined) return { ok: false, code: 'E_SESSION_GONE' };

    const call = this.#voiceParticipants(session.channelId);
    if (call === null || !call.has(args.memberKeyHex)) return { ok: false, code: 'E_PERMISSION_DENIED' };

    const isNewViewer = !session.viewers.has(args.memberKeyHex);
    session.viewers.set(args.memberKeyHex, { quality: session.quality, joinedAt: now });
    if (isNewViewer) {
      this.#onSessionEvent({ kind: 'viewersChanged', sessionId: session.sessionId, channelId: session.channelId, presenterKeyHex: session.presenterKeyHex, viewerCount: session.viewers.size });
    }

    const ticket = issueSessionTicket(this.#hostSecretKey, {
      sessionId: session.sessionId,
      channelId: session.channelId,
      selfKey: Buffer.from(args.memberKeyHex, 'hex'),
      otherKey: Buffer.from(session.presenterKeyHex, 'hex'),
      now,
      ttlMs: this.#ttlMs,
    });
    return {
      ok: true,
      sessionId: session.sessionId,
      channelId: session.channelId,
      presenterKeyHex: session.presenterKeyHex,
      ticketId: this.#ticketIdFactory === null ? ticketIdOf(ticket) : this.#ticketIdFactory(),
      ticket,
      expiresAt: now + this.#ttlMs,
    };
  }

  /**
   * `share.setQuality` (§RPC) — **papel apresentador desde a emenda de 2026-08-26**.
   *
   * O perfil de §17.5 é o teto de banda com que a tela SAI, e quem paga por ele é o upload
   * de quem transmite: 8 espectadores em `high` são 20 Mbps de subida na máquina do
   * apresentador. Dar o comando a quem assiste punha a conta no bolso alheio — qualquer
   * espectador podia pedir `high` e o custo caía sobre outra pessoa, que não tinha como
   * recusar. É também quem vê o que está transmitindo e sabe se o texto precisa ficar
   * legível ou se é vídeo em movimento.
   *
   * O que **não** mudou: a degradação automática por perda continua sendo do sistema
   * (`degradeTo`), continua descendo sozinha e continua sendo por espectador — é ela que
   * protege quem assiste numa conexão ruim, e ela não precisa de comando nenhum.
   *
   * Mudar o perfil redefine a base da sessão e realinha todos os espectadores: é um teto
   * novo, não um ajuste. A degradação volta a descer a partir dele no tique seguinte se a
   * perda persistir.
   */
  setQuality(args: { sessionId: string; memberKeyHex: KeyHex; quality: ShareQuality }): SetQualityOk | { ok: false; code: ShareErrorCode } {
    const session = this.#bySessionId(args.sessionId);
    if (session === undefined) return { ok: false, code: 'E_SESSION_GONE' };
    if (session.presenterKeyHex !== args.memberKeyHex) return { ok: false, code: 'E_PERMISSION_DENIED' };
    session.quality = args.quality;
    for (const viewer of session.viewers.values()) viewer.quality = args.quality;
    return { ok: true, applied: true, quality: args.quality };
  }

  /** Qualidade corrente do espectador (o que a saúde usa ao degradar). */
  viewerQuality(sessionId: string, memberKeyHex: KeyHex): ShareQuality | null {
    return this.#bySessionId(sessionId)?.viewers.get(memberKeyHex)?.quality ?? null;
  }

  /**
   * Caminho de **sistema** para a degradação automática de §17.5 (a saúde desce o
   * perfil quando a perda reportada passa do limiar) — distinto do comando
   * `share.setQuality`, cujo papel no §RPC é espectador. Só desce: a subida não é
   * definida pelo normativo. Razões nomeadas internas, como nas recusas TURN.
   */
  degradeTo(args: { sessionId: string; memberKeyHex: KeyHex; quality: ShareQuality }): SetQualityOk | { ok: false; reason: 'gone' | 'not-lower' } {
    const session = this.#bySessionId(args.sessionId);
    const viewer = session?.viewers.get(args.memberKeyHex);
    if (session === undefined || viewer === undefined) return { ok: false, reason: 'gone' };
    if (SHARE_QUALITY_RANK[args.quality] >= SHARE_QUALITY_RANK[viewer.quality]) return { ok: false, reason: 'not-lower' };
    viewer.quality = args.quality;
    return { ok: true, applied: true, quality: args.quality };
  }

  /** `share.stop` (papel apresentador): encerra e revoga todos os espectadores. */
  stop(args: { sessionId: string; memberKeyHex: KeyHex }): { ok: true } | { ok: false; code: ShareErrorCode } {
    const session = this.#bySessionId(args.sessionId);
    if (session === undefined) return { ok: false, code: 'E_SESSION_GONE' };
    if (session.presenterKeyHex !== args.memberKeyHex) return { ok: false, code: 'E_PERMISSION_DENIED' };
    this.#end(session);
    return { ok: true };
  }

  /** `share.leave`: espectador sai (revogação dele); apresentador saindo encerra tudo. */
  leave(args: { sessionId: string; memberKeyHex: KeyHex }): { ok: true } | { ok: false; code: ShareErrorCode } {
    const session = this.#bySessionId(args.sessionId);
    if (session === undefined) return { ok: false, code: 'E_SESSION_GONE' };
    if (session.presenterKeyHex === args.memberKeyHex) return this.stop(args);
    if (!session.viewers.delete(args.memberKeyHex)) return { ok: false, code: 'E_SESSION_GONE' };
    this.#emitRevocation(session, args.memberKeyHex);
    this.#onSessionEvent({ kind: 'viewersChanged', sessionId: session.sessionId, channelId: session.channelId, presenterKeyHex: session.presenterKeyHex, viewerCount: session.viewers.size });
    return { ok: true };
  }

  /**
   * Consulta `capture.authorize` (IPC-M main→núcleo→main): só existe captura com sessão
   * viva e token válido e não expirado. É a porta única do `setDisplayMediaRequestHandler`
   * — sem ela aprovada, a captura nunca inicia (`T-41`).
   */
  authorizeCapture(args: { sessionId: string; token: string }): AuthorizeCaptureResult {
    const session = this.#bySessionId(args.sessionId);
    if (session === undefined) return { allowed: false, reason: 'gone' };
    const now = this.#clock.now();
    if (now >= session.captureExpiresAt) return { allowed: false, reason: 'expired' };
    if (!timingSafeEqualHex(session.captureToken, args.token)) return { allowed: false, reason: 'mismatch' };
    return { allowed: true };
  }

  /**
   * Deriva os encerramentos do momento a partir do estado corrente — o host chama após
   * cada admissão projetada **e a cada mudança do roster da voz**. Ban/kick/timeout/saída
   * do apresentador encerram a sessão inteira (revogando cada espectador); do espectador,
   * revogam só ele (`T-32`).
   *
   * **Emenda de 2026-08-26 — a tela vive DENTRO da chamada, e isso é contínuo.** §17.5/A19
   * dizem que espectador é participante do canal de voz e que não existe audiência fora da
   * chamada, mas a regra só era aplicada no `start` e no `join`: depois disso, ninguém
   * reconferia. Quem apresentava e saía da chamada — por `voiceLeave` ou por queda de
   * conexão — deixava a sessão viva no host para sempre, e com ela o `E_ALREADY_SHARING`
   * que trancava o canal para qualquer outro apresentador. A porta `voiceParticipants` já
   * estava injetada; o que faltava era consultá-la aqui.
   */
  sweepAgainst(state: VoiceStatePort): readonly ShareRevokedTarget[] {
    const now = this.#clock.now();
    const emitted: ShareRevokedTarget[] = [];

    if (!state.community.exists || state.community.endedAt !== undefined) {
      for (const session of [...this.#sessions.values()]) this.#end(session, emitted);
      return emitted;
    }

    for (const session of [...this.#sessions.values()]) {
      const channel = state.channels.get(session.channelId);
      const call = this.#voiceParticipants(session.channelId);
      if (
        channel === undefined ||
        channel.deletedAt !== undefined ||
        call === null ||
        !call.has(session.presenterKeyHex) ||
        !this.#memberEligible(state, session.presenterKeyHex, now).ok
      ) {
        this.#end(session, emitted);
        continue;
      }
      for (const keyHex of [...session.viewers.keys()]) {
        if (!call.has(keyHex) || !this.#memberEligible(state, keyHex, now).ok) {
          session.viewers.delete(keyHex);
          this.#pushRevocation(emitted, session, keyHex);
          this.#emitRevocation(session, keyHex);
          this.#onSessionEvent({ kind: 'viewersChanged', sessionId: session.sessionId, channelId: session.channelId, presenterKeyHex: session.presenterKeyHex, viewerCount: session.viewers.size });
        }
      }
    }
    return emitted;
  }

  #snapshot(s: ShareSession): ShareSessionSnapshot {
    return {
      sessionId: s.sessionId,
      channelId: s.channelId,
      presenterKeyHex: s.presenterKeyHex,
      topology: SHARE_TOPOLOGY,
      quality: s.quality,
      viewerCount: s.viewers.size,
      viewers: [...s.viewers.entries()]
        .map(([keyHex, v]) => ({ keyHex, quality: v.quality }))
        .sort((a, b) => a.keyHex.localeCompare(b.keyHex)),
    };
  }

  #end(session: ShareSession, emitted?: ShareRevokedTarget[]): void {
    this.#sessions.delete(session.sessionId);
    for (const keyHex of session.viewers.keys()) {
      this.#pushRevocation(emitted, session, keyHex);
      this.#emitRevocation(session, keyHex);
    }
    session.viewers.clear();
    this.#onSessionEvent({ kind: 'stopped', sessionId: session.sessionId, channelId: session.channelId, presenterKeyHex: session.presenterKeyHex });
  }

  #pushRevocation(emitted: ShareRevokedTarget[] | undefined, session: ShareSession, keyHex: KeyHex): void {
    if (emitted !== undefined) {
      emitted.push({ sessionId: session.sessionId, channelId: session.channelId, targetKeyHex: keyHex });
    }
  }

  #emitRevocation(session: ShareSession, targetKeyHex: KeyHex): void {
    this.#onRevoked([{ sessionId: session.sessionId, channelId: session.channelId, targetKeyHex }]);
  }

  #bySessionId(sessionId: string): ShareSession | undefined {
    return this.#sessions.get(sessionId);
  }

  #memberEligible(
    state: VoiceStatePort,
    memberKeyHex: KeyHex,
    now: number,
  ): { ok: true } | { ok: false; code: ShareErrorCode } {
    const member = state.members.get(memberKeyHex);
    if (member === undefined) return { ok: false, code: 'E_NOT_MEMBER' };
    if (member.state === 'banned') return { ok: false, code: 'E_BANNED' };
    if (member.state === 'left') return { ok: false, code: 'E_NOT_MEMBER' };
    if (member.timeoutUntil !== undefined && member.timeoutUntil > now) return { ok: false, code: 'E_TIMED_OUT' };
    return { ok: true };
  }
}
