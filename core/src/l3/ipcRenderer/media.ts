// Superfície de voz e tela de §15.4, nos dois modos — L3, forma da fronteira (§4).
//
// As decisões de voz e tela são **do host** (§17.4/§17.5). Quando esta instalação hospeda a
// comunidade, elas são tomadas aqui, sobre `VoiceHostSessions`/`ShareHostSessions` e o
// `DecisionState` local. Quando não hospeda, a mesma pergunta viaja por RPC (§16.2) e quem
// decide é o host — a forma dos comandos de §15.4 não muda, e o roteador não sabe em qual
// modo está: é o `MediaDispatcher` que troca.
//
// O que **muda** entre os dois modos, e por isso mora aqui:
//
//   - **Quem sabe a sessão corrente.** Em modo host, o roster vivo é local e a sessão sai de
//     `currentSessionOf`. Em modo membro não há roster local: a sessão é o que o host
//     devolveu no `voiceJoin`, guardada client-side (o "estado de sessão de mídia (LS)" de
//     §29.2) e derrubada no `voiceLeave`, na queda do host e no `E_SESSION_GONE`.
//   - **A codificação de fio.** O corpo de §16.2 é JSON; os tickets de §17.4 carregam
//     `Buffer` (`peerA`, `peerB`, `sig`). O codec abaixo é a forma canônica dessa travessia —
//     o handler do host usa o mesmo, e nenhum dos dois lados inventa campo.
//
// **`captureToken` é capacidade local** (emenda de §17.4, 2026-08-22): quem o cunha é o
// núcleo do apresentador, no instante em que o host autoriza a sessão, e quem o verifica é
// esse mesmo núcleo — `capture.authorize` (§15.7) leva só `{sessionId}`. Por isso ele não
// trafega: a resposta de `shareStart` em §16.2 é `{sessionId}`, e o token nasce deste lado
// nos dois modos. Sem autorização do host não há sessão; sem sessão não há token.

import crypto from 'node:crypto';

import type {
  AuthorizeCaptureResult,
  CaptureToken,
  ShareHostSessions,
  ShareQuality,
} from '../../l2/shareStar/index.ts';
import type { TurnCredential } from '../../l2/communityHost/stunTurn.ts';
import { memberHasPermission, orderedPair, verifyMediaTicket } from '../../l2/voiceCoordinator/index.ts';
import type { AcaoFila, EstadoFila } from '../../l2/voiceCoordinator/index.ts';
import type {
  IceServer,
  MediaTicket,
  RosterEntry,
  SetSelfPatch,
  VoiceHostSessions,
  VoiceStatePort,
} from '../../l2/voiceCoordinator/index.ts';

export type MediaFail = { readonly ok: false; readonly code: string };
export type MediaAck = { readonly ok: true } | MediaFail;

export type VoiceJoinOk = {
  readonly ok: true;
  readonly sessionId: string;
  readonly channelId: string;
  readonly roster: readonly RosterEntry[];
  readonly iceServers: readonly IceServer[];
  readonly tickets: readonly MediaTicket[];
  readonly turnCredential: TurnCredential;
};

export type ShareStartOk = {
  readonly ok: true;
  readonly sessionId: string;
  /** §15.4 — capacidade local de captura (§17.4 emendado); nunca vem do host pela rede. */
  readonly captureToken: CaptureToken;
};

export type ShareJoinOk = { readonly ok: true; readonly ticketId: string; readonly presenterKey: string };

/**
 * §17.5 (emenda de 2026-08-28) — Modo Música: captura do áudio do SISTEMA, sem tela.
 * O `sessionId` é o da SESSÃO DE VOZ — é contra ele que `capture.authorize{kind:'music'}`
 * resolve; não há sessão de tela nem envolvimento do host.
 */
export type QueueAck = { readonly ok: true } | MediaFail;
export type QueueModerateArgs = { channelId: string; action: AcaoFila; targetKey?: string; seconds?: number };

export type MusicStartOk = {
  readonly ok: true;
  readonly sessionId: string;
  readonly captureToken: CaptureToken;
  readonly expiresAt: number;
};

/**
 * Uma medida de saúde por espectador, tirada do `RTCStatsReport` do apresentador
 * (§17.5). O núcleo não mede nada: ele recebe números já medidos, como a socket UDP
 * entra no `MediaServer` por porta injetada.
 */
export type ShareSample = { readonly viewerKey: string; readonly rttMs: number; readonly lossPct: number };
export type VoiceTicketsOk = { readonly ok: true; readonly sessionId: string; readonly tickets: readonly MediaTicket[] };

export type SessionSecurity = {
  readonly sessionId: string;
  readonly channelId: string;
  readonly tickets: readonly MediaTicket[];
};
export type SetQualityOkResult = { readonly ok: true; readonly applied: boolean };

/**
 * A superfície que o roteador de §15.4 consome. Assíncrona nos dois modos: em modo membro
 * cada chamada é um round-trip de §16.2, e a forma da fronteira não pode depender disso.
 */
export interface MediaDispatcher {
  readonly mode: 'host' | 'member';
  /** Sessão de voz corrente desta instalação — `null` fora de chamada. */
  currentSessionId(): string | null;
  voiceJoin(a: { communityId: string; channelId: string }): Promise<VoiceJoinOk | MediaFail>;
  voiceLeave(arg?: { sessionId?: string }): Promise<MediaAck>;
  voiceSetSelf(patch: SetSelfPatch): Promise<MediaAck>;
  voiceMuteParticipant(a: { communityId: string; identityKey: string; muted: boolean }): Promise<MediaAck>;
  /**
   * §15.4 `voice.signal` — o host encaminha (§16.2 `voiceSignal`, emenda de 2026-08-22). O
   * núcleo não lê SDP: a mídia é DTLS-SRTP ponta a ponta (§17.2).
   */
  voiceSignal(a: { peerKey: string; ticketId: string; sdp?: string; ice?: string }): Promise<MediaAck>;
  /**
   * §17.4 emendado — renovação dos tickets da sessão corrente, na cadência
   * `MEDIA_TICKET_TTL_MS/3`. **Não** é comando de §15.4: quem tem prazo é a sessão, e quem
   * cuida dele é o núcleo. Quem dispara a cadência é o `VoiceTicketRenewer`.
   */
  renewTickets(): Promise<VoiceTicketsOk | MediaFail>;
  /**
   * §17.3/§17.4 (emenda de 2026-08-30) — o material fresco da sessão SEM recriá-la. É o
   * `voiceJoin` idempotente de §21.2, que devolve a sessão existente com tickets novos e a
   * lista `iceServers` com a credencial TURN recém-costurada. O `VoiceTicketRenewer` o
   * chama na mesma cadência da renovação — a credencial TURN vence junto do ticket, e sem
   * isto uma chamada que dependa de relay morria quando ela vencia: o Allocate novo voltava
   * 401 e não havia caminho de renovação nenhum até o re-join manual.
   */
  refreshSession(): Promise<{ ok: true; sessionId: string; iceServers: readonly IceServer[] } | MediaFail>;
  /**
   * §17.4 passo 3 — o material que autoriza sinalização de um par nesta sessão: o ticket que
   * o host emitiu para o par (eu, ele). `null` fora de chamada. É o que o gate de entrada de
   * sinalização consulta antes de deixar qualquer SDP chegar ao renderer.
   */
  sessionSecurity(): SessionSecurity | null;
  /**
   * §16.3 `voice.roster` — o roster mudou no host. Em modo membro é a **única** forma de
   * saber que um par novo entrou: sem isso, a renovação de §17.4 nunca emitiria ticket para
   * ele e a sinalização entre os dois ficaria eternamente sem autorização. Em modo host o
   * roster vivo é local e isto é no-op.
   */
  observeRoster(participants: readonly string[]): void;
  shareStart(a: { communityId: string; channelId: string; quality?: ShareQuality }): Promise<ShareStartOk | MediaFail>;
  /**
   * §17.5 (emenda de 2026-08-28) — Modo Música: cunha o `captureToken` LOCAL de captura de
   * áudio do sistema. O gate é local (§15.4 `music.start`): sessão de voz ativa +
   * `voice_share_screen`. Sem host, sem RPC, sem sessão de tela. "Voz é uma só": não leva
   * `communityId` — a sessão corrente é a única que pode ter música.
   */
  musicStart(): Promise<MusicStartOk | MediaFail>;
  /**
   * §16.4 — a fila de karaokê. Em modo host, mutação direta do estado efêmero; em modo
   * membro, um round-trip de §16.2. A VALIDAÇÃO de participação (estar na sessão do
   * canal) é do dispatcher em ambos os casos, porque é quem sabe a sessão corrente.
   */
  queueJoin(a: { channelId: string }): Promise<QueueAck>;
  queueLeave(a: { channelId: string }): Promise<QueueAck>;
  queueModerate(a: QueueModerateArgs): Promise<QueueAck>;
  /**
   * §16.3 `voice.queueChanged` — ingere o instantâneo da fila para `query.voiceQueue`
   * (§15.6) reconstruir. Em modo host é no-op: o estado vivo é local.
   */
  observarFila(data: { channelId: string; open: boolean; items: EstadoFila['itens']; turn: EstadoFila['turno'] }): void;
  /** A leitura que reconstrói o evento — `null` quando o canal não tem fila conhecida. */
  snapshotFila(channelId: string): EstadoFila | null;
  shareStop(a: { sessionId: string }): Promise<MediaAck>;
  shareSetQuality(a: { sessionId: string; quality: ShareQuality }): Promise<SetQualityOkResult | MediaFail>;
  shareJoin(a: { sessionId: string }): Promise<ShareJoinOk | MediaFail>;
  /**
   * §15.4 `share.report` / §16.2 `shareReport` — **emenda de 2026-08-25**. A perna que
   * faltava do laço de saúde: §16.3 declarava `share.health` descendo do host ao
   * apresentador, mas nada declarava como as amostras SOBEM. Sem elas o host não tem
   * `rttMs`/`lossPct` para consolidar, `share.health` nunca sai, e o `share.setQuality`
   * de um espectador não alcança o apresentador — a qualidade por espectador de §17.5
   * fica inerte, que é exatamente o `F-08`/`V-13` que a spec dá por fechado.
   *
   * Quem mede é o renderer do apresentador; quem consolida e decide degradar é o host.
   */
  shareReport(a: { sessionId: string; samples: readonly ShareSample[] }): Promise<MediaAck>;
  /**
   * §15.7 `capture.authorize` — o main pergunta pelo `sessionId` e a resposta sai do estado
   * **local**, nunca de uma ida ao host (§17.4 emendado, `T-41`). `kind: 'music'` resolve
   * contra o token do Modo Música, cujo `sessionId` é o da sessão de voz (§17.5 emenda).
   *
   * **`audio` é a emenda de 2026-09-03 (B39).** Antes dela o núcleo não sabia se a captura
   * levava som: o flag ia do renderer direto ao main, que o obedecia, e a única coisa que
   * decidia se o som de uma máquina inteira ia para a rede era o renderer. Isso era
   * incoerente com o Modo Música, que é a MESMA captura de áudio e tem `kind` próprio,
   * token próprio e gate de permissão declarado desde §17.5 (emenda de 2026-08-28).
   */
  authorizeCapture(a: { sessionId: string; kind?: 'screen' | 'music'; audio?: boolean }): CaptureDecision;
}

/**
 * A resposta de `capture.authorize` (§15.7), com a metade de som da emenda de 2026-09-03.
 *
 * `audio` **não é** "o renderer pediu som": é "o núcleo concede som". Ele nunca é `true` com
 * `allowed: false`, e nunca é `true` sem o pedido — negar o som não derruba a captura, que
 * sobe **muda**. Subir muda é o desfecho honesto de §17.5, o mesmo que a plataforma sem
 * áudio separável por janela já produzia.
 */
export type CaptureDecision =
  | { readonly allowed: true; readonly audio: boolean }
  | { readonly allowed: false; readonly reason: 'gone' | 'mismatch' | 'expired'; readonly audio: false };

// ─── Modo host (§17.4/§17.5 decididos aqui) ───────────────────────────────────────────

export type LocalMediaDeps = {
  /** Recorte estrutural do DS corrente — `null` quando a comunidade não está aberta aqui. */
  voiceStateFor(communityId: string): VoiceStatePort | null;
  /**
   * §16.4 — a fila de karaokê deste host (mesma instância que o `canTransmit` consulta).
   * Injetada pela composição, que a cria junto com as sessões de voz.
   */
  fila: {
    entrar(channelId: string, keyHex: string): { ok: true } | { ok: false; code: 'E_QUEUE_CLOSED' | 'E_SESSION_GONE' | 'E_VALIDATION' };
    sair(channelId: string, keyHex: string): void;
    moderar(channelId: string, acao: AcaoFila, alvo?: string, segundos?: number): { ok: true } | { ok: false; code: 'E_QUEUE_CLOSED' | 'E_SESSION_GONE' | 'E_VALIDATION' };
    estadoDe(channelId: string): EstadoFila;
  };
  /** Chave pública hex da identidade local — `null` sem identidade carregada. */
  selfKeyHex(): string | null;
  /** Sessão corrente do membro no roster vivo ("voz é uma só", §15.4 `voice.leave`). */
  currentSessionId(): string | null;
  host: VoiceHostSessions;
  share: ShareHostSessions;
  /**
   * §17.5/§17.6 — destino das amostras de `share.report`. Ausente (suíte que não liga a
   * saúde), o relato é aceito e descartado: perder amostra não é erro de sessão, e a
   * cadência seguinte traz outra.
   */
  shareHealth?: { ingest(sample: { sessionId: string; viewerKeyHex: string; rttMs: number; lossPct: number }): void };
  /**
   * Entrega da sinalização ao par de destino. Em modo host quem encaminha é esta instalação
   * — ela é o host —, e a saída para a conexão do destinatário é do transporte (§4).
   */
  deliverSignal?(a: {
    sessionId: string;
    fromPeerKey: string;
    toPeerKey: string;
    ticketId: string;
    sdp?: string;
    ice?: string;
  }): { ok: true } | { ok: false; code: string };
};

/** Dispatcher de quem hospeda: as decisões de §17.4/§17.5 são tomadas nesta máquina. */
export function localMediaDispatcher(
  deps: LocalMediaDeps & {
    /** Vida do token de captura (mesmo parâmetro do `ShareHostSessions`); default 60 s. */
    captureTokenTtlMs?: number;
    /**
     * A comunidade da sessão corrente, para o gate LOCAL do Modo Música. Default: o
     * `voiceJoin`/`voiceLeave` deste dispatcher (§15.4 "voz é uma só"); injetável porque
     * o teste não passa pelo join.
     */
    communityInCall?: () => string | null;
  },
): MediaDispatcher {
  // §15.7 leva só `{sessionId}`: o token que o núcleo cunhou fica aqui, e é contra ele que
  // `authorizeCapture` resolve. Quem decide de fato é `ShareHostSessions` (validade e vida
  // da sessão); este campo é só a metade que a mensagem de §15.7 não carrega.
  let capture: CaptureToken | null = null;
  // §17.5 (emenda de 2026-08-28) — o token do Modo Música, amarrado à SESSÃO DE VOZ. Não
  // precisa de limpeza: `authorizeCapture` o recusa no instante em que a sessão deixa de
  // ser a corrente, que é o mesmo momento em que a música não tem mais por onde ir.
  let musica: CaptureToken | null = null;
  const ttlCaptura = deps.captureTokenTtlMs ?? 60_000;
  // "Voz é uma só" (§15.4 `voice.leave`): há no máximo uma comunidade em chamada, e é dela
  // que sai o recorte do DS para a renovação — `voice.leave`/`setSelf` não levam communityId.
  let comunidadeEmChamada: string | null = null;
  let seguranca: SessionSecurity | null = null;
  const self = (): string | MediaFail => deps.selfKeyHex() ?? { ok: false, code: 'E_NO_IDENTITY' };
  const state = (communityId: string): VoiceStatePort | MediaFail =>
    deps.voiceStateFor(communityId) ?? { ok: false, code: 'E_HOST_UNAVAILABLE' };
  const failed = (v: unknown): v is MediaFail => typeof v === 'object' && v !== null && 'ok' in v;

  /**
   * §17.5 (emenda de 2026-09-03) — o som da tela é a MESMA permissão da tela.
   *
   * Nenhum cargo novo: quem pode compartilhar pode compartilhar com som. O que muda é
   * **quem responde** — antes ninguém respondia, e o renderer decidia sozinho. A leitura
   * é feita agora, contra o DS corrente, e não no `share.start`: é a mesma disciplina do
   * gate do Modo Música, que lê a permissão no instante do pedido.
   */
  function somPermitido(): boolean {
    const key = deps.selfKeyHex();
    if (key === null) return false;
    const cid = deps.communityInCall?.() ?? comunidadeEmChamada;
    const st = cid === null ? null : deps.voiceStateFor(cid);
    return st !== null && memberHasPermission(st, key, 'voice_share_screen');
  }

  return {
    mode: 'host',
    currentSessionId: () => deps.currentSessionId(),

    async voiceJoin({ communityId, channelId }) {
      const key = self();
      if (failed(key)) return key;
      const st = state(communityId);
      if (failed(st)) return st;
      const r = deps.host.join({ state: st, channelId, memberKeyHex: key });
      if (r.ok) {
        comunidadeEmChamada = communityId;
        seguranca = { sessionId: r.sessionId, channelId: r.channelId, tickets: r.tickets };
      }
      return r;
    },

    async voiceLeave(arg?: { sessionId?: string }) {
      const key = deps.selfKeyHex();
      const current = deps.currentSessionId();
      // §15.4 / Lacuna 2 — se um sessionId específico foi passado e a sessão corrente já mudou
      // (ex.: troca rápida de canal), a saída da chamada anterior não pode derrubar a nova.
      if (arg?.sessionId !== undefined && current !== null && arg.sessionId !== current) {
        return { ok: true };
      }
      const sessionId = arg?.sessionId ?? current;
      if (key === null || sessionId === null) return { ok: true };
      comunidadeEmChamada = null;
      seguranca = null;
      // Os dois tokens de captura são da sessão (§17.4: "sem sessão não existe token"). O
      // `authorizeCapture` daqui já os reconferia contra a sessão corrente, então isto não
      // fecha buraco — tira estado morto de pé, que é o que deixou o modo membro escapar.
      capture = null;
      musica = null;
      return deps.host.leave({ sessionId, memberKeyHex: key });
    },

    async voiceSetSelf(patch) {
      const key = deps.selfKeyHex();
      const sessionId = deps.currentSessionId();
      if (key === null || sessionId === null) return { ok: false, code: 'E_SESSION_GONE' };
      // §17.4 (emenda de 2026-08-28) — o gate do modo de fala lê o DS da comunidade em
      // chamada; sem estado não há como conferir o pedido de desmutar.
      const st = comunidadeEmChamada === null ? null : deps.voiceStateFor(comunidadeEmChamada);
      if (st === null) return { ok: false, code: 'E_HOST_UNAVAILABLE' };
      return deps.host.setSelf({ state: st, sessionId, memberKeyHex: key, patch });
    },

    async voiceMuteParticipant({ communityId, identityKey, muted }) {
      const key = deps.selfKeyHex();
      const sessionId = deps.currentSessionId();
      const st = state(communityId);
      if (failed(st)) return st;
      if (key === null || sessionId === null) return { ok: false, code: 'E_SESSION_GONE' };
      return deps.host.muteParticipant({
        state: st,
        sessionId,
        actorKeyHex: key,
        targetKeyHex: identityKey,
        muted,
      });
    },

    async shareStart({ communityId, channelId, quality }) {
      const key = self();
      if (failed(key)) return key;
      const st = state(communityId);
      if (failed(st)) return st;
      const r = deps.share.start({
        state: st,
        channelId,
        presenterKeyHex: key,
        ...(quality !== undefined ? { quality } : {}),
      });
      if (!r.ok) return r;
      capture = r.captureToken;
      return { ok: true, sessionId: r.sessionId, captureToken: r.captureToken };
    },

    async shareStop({ sessionId }) {
      const key = self();
      if (failed(key)) return key;
      if (capture?.sessionId === sessionId) capture = null;
      return deps.share.stop({ sessionId, memberKeyHex: key });
    },

    async shareSetQuality({ sessionId, quality }) {
      const key = self();
      if (failed(key)) return key;
      const r = deps.share.setQuality({ sessionId, memberKeyHex: key, quality });
      return r.ok ? { ok: true, applied: r.applied } : r;
    },

    async shareJoin({ sessionId }) {
      const key = self();
      if (failed(key)) return key;
      const r = deps.share.join({ sessionId, memberKeyHex: key });
      return r.ok ? { ok: true, ticketId: r.ticketId, presenterKey: r.presenterKeyHex } : r;
    },

    async shareReport({ sessionId, samples }) {
      const key = self();
      if (failed(key)) return key;
      const sessao = deps.share.snapshotOf(sessionId);
      if (sessao === null) return { ok: false, code: 'E_SESSION_GONE' };
      // **Só o apresentador relata.** As amostras são do `RTCStatsReport` de quem envia a
      // tela; aceitar de um espectador deixaria qualquer participante mexer no perfil dos
      // outros pelo caminho de sistema (`degradeTo`), que não tem papel no §RPC.
      if (sessao.presenterKeyHex !== key) return { ok: false, code: 'E_PERMISSION_DENIED' };
      for (const s of samples) {
        deps.shareHealth?.ingest({ sessionId, viewerKeyHex: s.viewerKey, rttMs: s.rttMs, lossPct: s.lossPct });
      }
      return { ok: true };
    },

    async voiceSignal(a) {
      const key = deps.selfKeyHex();
      const sessionId = deps.currentSessionId();
      if (key === null || sessionId === null) return { ok: false, code: 'E_SESSION_GONE' };
      // Sem porta de entrega composta, a sinalização não chegou — é o que §15.4 nomeia.
      if (deps.deliverSignal === undefined) return { ok: false, code: 'E_PEER_UNREACHABLE' };
      const r = deps.deliverSignal({
        sessionId,
        fromPeerKey: key,
        toPeerKey: a.peerKey,
        ticketId: a.ticketId,
        ...(a.sdp !== undefined ? { sdp: a.sdp } : {}),
        ...(a.ice !== undefined ? { ice: a.ice } : {}),
      });
      return r.ok ? { ok: true } : r;
    },

    async renewTickets() {
      const key = deps.selfKeyHex();
      const sessionId = deps.currentSessionId();
      if (key === null || sessionId === null) return { ok: false, code: 'E_SESSION_GONE' };
      const st = comunidadeEmChamada === null ? null : deps.voiceStateFor(comunidadeEmChamada);
      const session = deps.host.currentSessionOf(key);
      if (session === null) return { ok: false, code: 'E_SESSION_GONE' };
      const roster = deps.host.sessionOf(session.channelId);
      if (st === null || roster === null) return { ok: false, code: 'E_TICKET_DENIED' };
      const tickets: MediaTicket[] = [];
      for (const p of roster.participants) {
        if (p.keyHex === key) continue;
        const r = deps.host.renewTicket({ state: st, sessionId, memberKeyHex: key, peerKeyHex: p.keyHex });
        // Um par que deixou de ser elegível some da renovação; o ticket dele expira sozinho
        // em `MEDIA_TICKET_TTL_MS` (§17.4), que é a rede de segurança da revogação.
        if (r.ok) tickets.push(r.ticket);
      }
      if (seguranca !== null) seguranca = { ...seguranca, tickets };
      return { ok: true, sessionId, tickets };
    },

    async refreshSession() {
      const key = deps.selfKeyHex();
      const sessionId = deps.currentSessionId();
      const sess = key === null ? null : deps.host.currentSessionOf(key);
      if (key === null || sessionId === null || sess === null || comunidadeEmChamada === null) {
        return { ok: false as const, code: 'E_SESSION_GONE' };
      }
      const st = state(comunidadeEmChamada);
      if (failed(st)) return st;
      // O re-join idempotente curto-circuita no roster (`participants.has`) e devolve a
      // MESMA sessão com material fresco — sem roster reemitido, sem round-trip.
      const r = deps.host.join({ state: st, channelId: sess.channelId, memberKeyHex: key });
      if (r.ok) {
        seguranca = { sessionId: r.sessionId, channelId: r.channelId, tickets: r.tickets };
        return { ok: true as const, sessionId: r.sessionId, iceServers: r.iceServers };
      }
      return r;
    },

    sessionSecurity: () => (deps.currentSessionId() === null ? null : seguranca),

    observeRoster: () => {
      // Modo host: o roster vivo é este. Não há o que observar de fora.
    },

    async musicStart() {
      const key = self();
      if (failed(key)) return key;
      const sessionId = deps.currentSessionId();
      if (sessionId === null) return { ok: false, code: 'E_SESSION_GONE' };
      // §17.5 emenda — o gate é LOCAL: permissão de §9.1 sobre o DS desta instalação.
      const cid = deps.communityInCall?.() ?? comunidadeEmChamada;
      const st = cid === null ? null : deps.voiceStateFor(cid);
      if (st === null || !memberHasPermission(st, key, 'voice_share_screen')) {
        return { ok: false, code: 'E_PERMISSION_DENIED' };
      }
      const expiresAt = Date.now() + ttlCaptura;
      musica = { sessionId, token: crypto.randomBytes(32).toString('hex'), expiresAt };
      return { ok: true, sessionId, captureToken: musica, expiresAt };
    },

    async queueJoin({ channelId }) {
      const sessionId = deps.currentSessionId();
      // §16.4 — a entrada exige sessão de voz ATIVA no canal; sem ela não há onde esperar
      // a vez, e a resposta é a mesma de "a sessão acabou".
      const emChamada = deps.host.currentSessionOf(deps.selfKeyHex() ?? '');
      if (sessionId === null || emChamada === null || emChamada.channelId !== channelId) {
        return { ok: false, code: 'E_SESSION_GONE' };
      }
      return deps.fila.entrar(channelId, deps.selfKeyHex() ?? '');
    },

    async queueLeave({ channelId }) {
      const emChamada = deps.host.currentSessionOf(deps.selfKeyHex() ?? '');
      if (emChamada === null || emChamada.channelId !== channelId) return { ok: false, code: 'E_SESSION_GONE' };
      deps.fila.sair(channelId, deps.selfKeyHex() ?? '');
      return { ok: true };
    },

    async queueModerate({ channelId, action, targetKey, seconds }) {
      const key = self();
      if (failed(key)) return key;
      // §16.4 — moderação de fila é `voice_mute_others`, decidida contra o DS local.
      const st = comunidadeEmChamada === null ? null : deps.voiceStateFor(comunidadeEmChamada);
      const emChamada = deps.host.currentSessionOf(deps.selfKeyHex() ?? '');
      if (st === null || emChamada === null || emChamada.channelId !== channelId) {
        return { ok: false, code: 'E_SESSION_GONE' };
      }
      if (!memberHasPermission(st, key, 'voice_mute_others')) return { ok: false, code: 'E_PERMISSION_DENIED' };
      return deps.fila.moderar(channelId, action, targetKey, seconds);
    },

    observarFila() {
      // Modo host: o estado vivo é este — nada a ingerir.
    },

    snapshotFila(channelId: string): EstadoFila | null {
      if (deps.host.currentSessionOf(deps.selfKeyHex() ?? '') === null) return null;
      return deps.fila.estadoDe(channelId);
    },

    authorizeCapture({ sessionId, kind, audio }) {
      if (kind === 'music') {
        // O token de música vale enquanto a sessão de voz que o gerou for a corrente — e
        // até o prazo dele. A perna remota de §16.2 já recusava vencido ('expired'); a
        // local aceitava, e o host era mais frouxo consigo mesmo do que com o membro.
        if (musica === null || musica.sessionId !== sessionId) return { allowed: false, reason: 'mismatch', audio: false };
        if (Date.now() >= musica.expiresAt) return { allowed: false, reason: 'expired', audio: false };
        if (deps.currentSessionId() !== sessionId) return { allowed: false, reason: 'mismatch', audio: false };
        // O Modo Música **é** som: uma captura dele sem áudio não tem o que transmitir.
        return { allowed: true, audio: true };
      }
      if (capture === null || capture.sessionId !== sessionId) return { allowed: false, reason: 'mismatch', audio: false };
      const base = deps.share.authorizeCapture({ sessionId, token: capture.token });
      if (!base.allowed) return { allowed: false, reason: base.reason, audio: false };
      return { allowed: true, audio: audio === true && somPermitido() };
    },
  };
}

// ─── Codec de fio de §16.2 (JSON; os tickets de §17.4 carregam Buffer) ────────────────

type WireTicket = {
  sessionId: string;
  channelId: string;
  peerA: string;
  peerB: string;
  expiresAt: number;
  sig: string;
};

/** Forma canônica do `voiceJoin` no fio. O host e o cliente usam esta, e só esta. */
export const mediaWire = {
  encodeTicket(t: MediaTicket): WireTicket {
    return {
      sessionId: t.sessionId,
      channelId: t.channelId,
      peerA: t.peerA.toString('hex'),
      peerB: t.peerB.toString('hex'),
      expiresAt: t.expiresAt,
      sig: t.sig.toString('hex'),
    };
  },
  decodeTicket(t: WireTicket): MediaTicket {
    return {
      sessionId: t.sessionId,
      channelId: t.channelId,
      peerA: Buffer.from(t.peerA, 'hex'),
      peerB: Buffer.from(t.peerB, 'hex'),
      expiresAt: t.expiresAt,
      sig: Buffer.from(t.sig, 'hex'),
    };
  },
  encodeVoiceJoin(r: Omit<VoiceJoinOk, 'ok'>): Record<string, unknown> {
    return {
      sessionId: r.sessionId,
      channelId: r.channelId,
      roster: r.roster,
      iceServers: r.iceServers,
      tickets: r.tickets.map((t) => mediaWire.encodeTicket(t)),
      turnCredential: r.turnCredential,
    };
  },
  decodeVoiceJoin(raw: Record<string, unknown>): VoiceJoinOk {
    return {
      ok: true,
      sessionId: String(raw['sessionId'] ?? ''),
      channelId: String(raw['channelId'] ?? ''),
      roster: (raw['roster'] as readonly RosterEntry[] | undefined) ?? [],
      iceServers: (raw['iceServers'] as readonly IceServer[] | undefined) ?? [],
      tickets: ((raw['tickets'] as readonly WireTicket[] | undefined) ?? []).map((t) =>
        mediaWire.decodeTicket(t),
      ),
      turnCredential: (raw['turnCredential'] as TurnCredential | undefined) ?? { username: '', password: '' },
    };
  },
};

// ─── Modo membro (§16.2 sobre `rpcClient`) ────────────────────────────────────────────

/**
 * Porta de chamada RPC. Declarada estruturalmente: §4 não autoriza importação lateral entre
 * módulos de L3, e o `RpcClient` satisfaz esta forma sem que `ipcRenderer` o importe — quem
 * monta o grafo injeta a implementação (§4).
 */
export interface RpcCallPort {
  call(
    method: string,
    body: Uint8Array,
  ): Promise<{ readonly ok: true; readonly body: Uint8Array } | { readonly ok: false; readonly code: string }>;
}

function encodeBody(arg: Record<string, unknown>): Uint8Array {
  return new Uint8Array(Buffer.from(JSON.stringify(arg), 'utf8'));
}

function decodeBody(body: Uint8Array): Record<string, unknown> {
  const text = Buffer.from(body).toString('utf8');
  if (text.length === 0) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Dispatcher de quem **não** hospeda: cada superfície de §15.4 vira o método de §16.2 que a
 * tabela nomeia, e a decisão continua sendo do host. A sessão de voz corrente é o estado
 * client-side que §29.2 pedia: nasce no `voiceJoin`, morre no `voiceLeave` e em qualquer
 * `E_SESSION_GONE` — inclusive o que chega de um `voice.revoked` do host (§17.4).
 */
export function remoteMediaDispatcher(
  port: RpcCallPort,
  opts: {
    /** Vida do `captureToken` local — mesmo parâmetro que o host usa em `ShareHostSessions`. */
    readonly captureTokenTtlMs: number;
    readonly now?: () => number;
    /** Injetável só para teste determinístico; em produto é `randomBytes(32)`. */
    readonly mintToken?: () => string;
    readonly onSessionLost?: (reason: 'host-unavailable') => void;
    /**
     * §17.5 (emenda de 2026-08-28) — o gate LOCAL do Modo Música em modo membro: a
     * permissão é lida no DS da réplica, sem round-trip ao host. Injetado pela composição,
     * que tem as duas pontas.
     */
    readonly musicAllowed?: () => boolean;
    /**
     * A própria chave, para não pedir ao host um ticket de si para si.
     *
     * O roster inclui quem pergunta, e `voiceTicket{peerKey: eu}` é recusado com
     * `E_TICKET_DENIED` — inofensivo no resultado e caro no relógio: é uma ida e volta ao
     * host à frente do ticket que importa, dentro da janela em que a oferta do outro lado
     * está sendo descartada por falta dele (§17.4).
     */
    readonly selfKeyHex?: () => string | null;
  },
): MediaDispatcher & {
  /** §17.4 — revogação recebida do host derruba a sessão local sem round-trip. */
  forgetSession(): void;
} {
  let sessionId: string | null = null;
  let capture: CaptureToken | null = null;
  /** §17.5 (emenda de 2026-08-28) — token do Modo Música, amarrado à sessão de voz. */
  let musica: CaptureToken | null = null;
  /** §16.4 — instantâneos de fila por canal, vindos de `voice.queueChanged`. */
  const filasConhecidas = new Map<string, EstadoFila>();
  /** Roster da última entrada — é dele que sai a lista de pares para renovar (§17.4). */
  let pares: readonly string[] = [];
  let seguranca: SessionSecurity | null = null;
  const now = opts.now ?? Date.now;
  const mint = opts.mintToken ?? (() => crypto.randomBytes(32).toString('hex'));
  const onSessionLost = opts.onSessionLost ?? (() => {});

  async function call(method: string, arg: Record<string, unknown>): Promise<Record<string, unknown> | MediaFail> {
    const r = await port.call(method, encodeBody(arg));
    if (!r.ok) {
      // O host disse que a sessão acabou (ou sumiu): o estado local não pode sobreviver a isso.
      if (r.code === 'E_SESSION_GONE' || r.code === 'E_HOST_UNAVAILABLE') {
        const tinhaSessao = sessionId !== null;
        sessionId = null;
        capture = null;
        // §17.5 — o token do Modo Música é da SESSÃO de voz, como o de tela. Ele ficava de
        // fora de toda limpeza (aqui, no `forgetSession` e no `voiceLeave`), e sobrevivia à
        // revogação e à queda do host: dentro da TTL, `capture.authorize{music}` seguia
        // concedendo a captura de áudio do sistema sem chamada nenhuma para transmiti-la.
        musica = null;
        seguranca = null;
        pares = [];
        filasConhecidas.clear();
        // Só o silêncio do host precisa ser anunciado, e só se havia chamada para perder.
        if (tinhaSessao && r.code === 'E_HOST_UNAVAILABLE') onSessionLost('host-unavailable');
      }
      return { ok: false, code: r.code };
    }
    return decodeBody(r.body);
  }

  const failed = (v: Record<string, unknown> | MediaFail): v is MediaFail => v['ok'] === false;

  return {
    mode: 'member',
    currentSessionId: () => sessionId,
    forgetSession() {
      sessionId = null;
      capture = null;
      musica = null;
      pares = [];
      seguranca = null;
      filasConhecidas.clear();
    },

    async voiceJoin({ channelId }) {
      const r = await call('voiceJoin', { channelId });
      if (failed(r)) return r;
      const joined = mediaWire.decodeVoiceJoin(r);
      sessionId = joined.sessionId;
      pares = joined.roster.map((p) => p.keyHex);
      seguranca = { sessionId: joined.sessionId, channelId: joined.channelId, tickets: joined.tickets };
      return joined;
    },

    async voiceLeave(arg?: { sessionId?: string }) {
      if (sessionId === null) return { ok: true }; // mesmo no-op nomeado do modo host
      if (arg?.sessionId !== undefined && arg.sessionId !== sessionId) return { ok: true };
      const r = await call('voiceLeave', { sessionId });
      sessionId = null;
      seguranca = null;
      // Sair da chamada leva os dois tokens de captura junto: sem sessão não há audiência,
      // e §17.4 é explícita — "sem sessão não existe token".
      capture = null;
      musica = null;
      return failed(r) ? r : { ok: true };
    },

    async voiceSetSelf(patch) {
      if (sessionId === null) return { ok: false, code: 'E_SESSION_GONE' };
      const r = await call('voiceState', { ...patch });
      return failed(r) ? r : { ok: true };
    },

    async voiceMuteParticipant({ identityKey, muted }) {
      // §16.2 `voiceMute` (emenda de 2026-08-22). O alvo é escopado à sessão corrente: sem
      // sessão não há roster onde silenciar, e o host recusaria pelo mesmo motivo.
      if (sessionId === null) return { ok: false, code: 'E_SESSION_GONE' };
      const r = await call('voiceMute', { sessionId, targetKey: identityKey, muted });
      return failed(r) ? r : { ok: true };
    },

    async voiceSignal(a) {
      if (sessionId === null) return { ok: false, code: 'E_SESSION_GONE' };
      const r = await call('voiceSignal', {
        sessionId,
        toPeerKey: a.peerKey,
        ticketId: a.ticketId,
        ...(a.sdp !== undefined ? { sdp: a.sdp } : {}),
        ...(a.ice !== undefined ? { ice: a.ice } : {}),
      });
      return failed(r) ? r : { ok: true };
    },

    async renewTickets() {
      if (sessionId === null) return { ok: false, code: 'E_SESSION_GONE' };
      const tickets: MediaTicket[] = [];
      const eu = opts.selfKeyHex?.() ?? null;
      for (const par of pares) {
        if (eu !== null && par === eu) continue; // ninguém pareia consigo mesmo (§17.4)
        const r = await call('voiceTicket', { sessionId, peerKey: par });
        // `E_TICKET_DENIED` por par é normal e esperado: a própria entrada do roster, quem
        // saiu e quem perdeu elegibilidade não renovam, e esses tickets expiram sozinhos
        // em `MEDIA_TICKET_TTL_MS` — a rede de segurança da revogação de §17.4.
        if (!failed(r) && r['ticket'] !== undefined) {
          tickets.push(mediaWire.decodeTicket(r['ticket'] as Parameters<typeof mediaWire.decodeTicket>[0]));
        }
      }
      if (seguranca !== null) seguranca = { ...seguranca, tickets };
      return { ok: true, sessionId, tickets };
    },

    async refreshSession() {
      if (sessionId === null || seguranca === null) return { ok: false as const, code: 'E_SESSION_GONE' };
      // O mesmo `voiceJoin` idempotente de §21.2: devolve a sessão existente com tickets e
      // credencial TURN frescos. O `call` já derruba o estado local em `E_SESSION_GONE`/
      // `E_HOST_UNAVAILABLE`, que é o desfecho certo para sessão que acabou de morrer.
      const r = await call('voiceJoin', { channelId: seguranca.channelId });
      if (failed(r)) return r;
      const joined = mediaWire.decodeVoiceJoin(r);
      sessionId = joined.sessionId;
      pares = joined.roster.map((p) => p.keyHex);
      seguranca = { sessionId: joined.sessionId, channelId: joined.channelId, tickets: joined.tickets };
      return { ok: true as const, sessionId: joined.sessionId, iceServers: joined.iceServers };
    },

    sessionSecurity: () => (sessionId === null ? null : seguranca),

    observeRoster(participants) {
      pares = [...participants];
    },

    async shareStart({ channelId, quality }) {
      const r = await call('shareStart', { channelId, ...(quality !== undefined ? { quality } : {}) });
      if (failed(r)) return r;
      const started = String(r['sessionId'] ?? '');
      // §17.4 emendado: o host autorizou a sessão; o token de captura nasce AQUI, porque é
      // aqui que `capture.authorize` (§15.7) será resolvido. Ele não trafega.
      capture = { token: mint(), sessionId: started, expiresAt: now() + opts.captureTokenTtlMs };
      return { ok: true, sessionId: started, captureToken: capture };
    },

    async shareStop(a) {
      // §16.2 não tem `shareStop`: quem encerra é o `shareLeave` do apresentador, que o
      // módulo host já roteia para `stop` ("apresentador saindo encerra tudo", §17.5).
      const r = await call('shareLeave', { sessionId: a.sessionId });
      if (capture?.sessionId === a.sessionId) capture = null;
      return failed(r) ? r : { ok: true };
    },

    async shareSetQuality(a) {
      // §16.2 `shareQuality` (emenda de 2026-08-22). O efeito mensurável é do apresentador,
      // que aprende o perfil pelo `quality` de `share.health` (§15.5, §17.5).
      const r = await call('shareQuality', { sessionId: a.sessionId, quality: a.quality });
      if (failed(r)) return r;
      return { ok: true, applied: r['applied'] === true };
    },

    async shareJoin(a) {
      const r = await call('shareJoin', { sessionId: a.sessionId });
      if (failed(r)) return r;
      return {
        ok: true,
        ticketId: String(r['ticketId'] ?? ''),
        presenterKey: String(r['presenterKey'] ?? ''),
      };
    },

    async shareReport(a) {
      // §16.2 `shareReport` (emenda de 2026-08-25). Quem consolida é o host, porque é ele
      // que guarda o perfil pedido por cada espectador — o apresentador membro mede e
      // manda, e recebe de volta o veredito por `share.health` (§16.3).
      const r = await call('shareReport', { sessionId: a.sessionId, samples: a.samples });
      return failed(r) ? r : { ok: true };
    },

    async queueJoin({ channelId }) {
      if (sessionId === null) return { ok: false, code: 'E_SESSION_GONE' };
      const r = await call('voiceQueueJoin', { channelId });
      return failed(r) ? r : { ok: true };
    },

    async queueLeave({ channelId }) {
      if (sessionId === null) return { ok: false, code: 'E_SESSION_GONE' };
      const r = await call('voiceQueueLeave', { channelId });
      return failed(r) ? r : { ok: true };
    },

    async queueModerate(a) {
      if (sessionId === null) return { ok: false, code: 'E_SESSION_GONE' };
      const r = await call('voiceQueueModerate', { channelId: a.channelId, action: a.action, ...(a.targetKey !== undefined ? { targetKey: a.targetKey } : {}), ...(a.seconds !== undefined ? { seconds: a.seconds } : {}) });
      return failed(r) ? r : { ok: true };
    },

    observarFila(data) {
      // §16.3 — o instantâneo CHEGA completo (fila é NÍVEL): guardar é o que dá à
      // `query.voiceQueue` uma fonte local, sem round-trip ao host.
      if (typeof data['channelId'] !== 'string') return;
      filasConhecidas.set(data['channelId'], {
        aberta: data['open'] === true,
        itens: Array.isArray(data['items']) ? (data['items'] as EstadoFila['itens']) : [],
        turno: (data['turn'] ?? null) as EstadoFila['turno'],
      });
    },

    snapshotFila(channelId: string): EstadoFila | null {
      if (sessionId === null) return null;
      return filasConhecidas.get(channelId) ?? null;
    },

    async musicStart() {
      if (sessionId === null) return { ok: false, code: 'E_SESSION_GONE' };
      if (opts.musicAllowed?.() === false) return { ok: false, code: 'E_PERMISSION_DENIED' };
      const expiresAt = now() + opts.captureTokenTtlMs;
      musica = { sessionId, token: mint(), expiresAt };
      return { ok: true, sessionId, captureToken: musica, expiresAt };
    },

    authorizeCapture(a) {
      // Resolvido só contra o estado local (§15.7, §17.4 emendado): nenhuma ida ao host —
      // a autorização dele já aconteceu, e é o que fez esta sessão existir.
      // **Sem sessão de voz não há token** (§17.4: "sem sessão não existe token"). O ramo
      // host tinha a reconferência e o membro não — ele conferia só token e prazo, então
      // sair da chamada, perder o host ou ser revogado deixava `capture.authorize` dizendo
      // `allowed: true` pela TTL inteira. A comparação NÃO é com `a.sessionId`: o da tela é
      // o id da `ShareSession`, não o da sessão de voz; o que se exige aqui é que a chamada
      // que criou a capacidade ainda exista.
      if (sessionId === null) return { allowed: false, reason: 'mismatch', audio: false };
      if (a.kind === 'music') {
        if (musica === null || musica.sessionId !== a.sessionId) return { allowed: false, reason: 'mismatch', audio: false };
        if (now() >= musica.expiresAt) return { allowed: false, reason: 'expired', audio: false };
        return { allowed: true, audio: true };
      }
      if (capture === null || capture.sessionId !== a.sessionId) return { allowed: false, reason: 'mismatch', audio: false };
      if (now() >= capture.expiresAt) return { allowed: false, reason: 'expired', audio: false };
      // §17.5 (emenda de 2026-09-03) — o som da tela é a mesma permissão da tela, lida
      // AGORA. Quem perdeu `voice_share_screen` entre o `share.start` e o `getDisplayMedia`
      // transmite imagem e não transmite o som da máquina.
      return { allowed: true, audio: a.audio === true && (opts.musicAllowed?.() ?? true) };
    },
  };
}

// ─── Renovação de ticket (§17.4 emendado, cadência de §26.2) ──────────────────────────

/**
 * Quem cuida do prazo dos tickets é o núcleo, não o renderer: §15.4 não tem — e não deve
 * ter — comando de renovação, porque um renderer que esquecesse o temporizador perderia a
 * sessão em silêncio. Este é o dono da cadência.
 *
 * O relógio é injetado (`schedule`/`cancel`) porque temporizador dentro do roteador é
 * intestável; em produto o boot passa `setInterval`/`clearInterval`.
 *
 * Se o `voice.tickets` se perder, §15.1 regra 5 continua valendo: o caminho de reconsulta é
 * `voice.join` no mesmo canal, que devolve a sessão existente com material fresco.
 */
/**
 * Piso entre duas renovações puxadas por sinalização recusada (§17.4 passo 3). O gatilho
 * vem da rede; sem o piso, um par insistente viraria uma enxurrada de `voiceTicket`.
 */
const PUXAR_TICKET_MIN_MS = 1_000;

export class VoiceTicketRenewer {
  readonly #dispatcher: MediaDispatcher;
  readonly #communityId: () => string | null;
  readonly #emit: (ev: { readonly topic: 'voice.tickets'; readonly data: Record<string, unknown> }) => void;
  readonly #periodMs: number;
  readonly #schedule: (fn: () => void, ms: number) => unknown;
  readonly #cancel: (handle: unknown) => void;
  #handle: unknown = null;

  constructor(opts: {
    readonly dispatcher: MediaDispatcher;
    /** §15.5 exige `communityId` no evento; em modo membro há um dispatcher por comunidade. */
    readonly communityId: () => string | null;
    readonly emit: (ev: { readonly topic: 'voice.tickets'; readonly data: Record<string, unknown> }) => void;
    /** §26.2 — `MEDIA_TICKET_TTL_MS / 3`. */
    readonly periodMs: number;
    readonly schedule?: (fn: () => void, ms: number) => unknown;
    readonly cancel?: (handle: unknown) => void;
  }) {
    this.#dispatcher = opts.dispatcher;
    this.#communityId = opts.communityId;
    this.#emit = opts.emit;
    this.#periodMs = opts.periodMs;
    this.#schedule = opts.schedule ?? ((fn, ms) => setInterval(fn, ms));
    this.#cancel = opts.cancel ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  }

  start(): void {
    if (this.#handle === null) this.#handle = this.#schedule(() => void this.tick(), this.#periodMs);
  }

  stop(): void {
    if (this.#handle !== null) this.#cancel(this.#handle);
    this.#handle = null;
  }

  /** Um ciclo. Fora de chamada é no-op: não há sessão cujo prazo cuidar. */
  async tick(): Promise<void> {
    if (this.#dispatcher.currentSessionId() === null) return;
    const communityId = this.#communityId();
    if (communityId === null) return;
    const r = await this.#dispatcher.renewTickets();
    // Falha de renovação não é evento: o ticket velho continua valendo até expirar, e a
    // próxima volta tenta de novo. Anunciar "renovou" sem ticket seria mentir à UI.
    if (!r.ok || r.tickets.length === 0) return;
    // A credencial TURN vence junto do ticket (§17.3) e não tem evento próprio: o
    // `refreshSession` — o `voiceJoin` idempotente — devolve a lista `iceServers` com a
    // credencial recém-costurada, e o renderer a aplica por `setConfiguration` nas
    // conexões vivas. Era o caminho que faltava: sem ele, chamada que dependia de relay
    // morria no vencimento da credencial, com o Allocate novo a responder 401.
    const fresco = await this.#dispatcher.refreshSession();
    const iceServers = fresco.ok ? fresco.iceServers : undefined;
    this.#emit({
      topic: 'voice.tickets',
      data: {
        communityId,
        sessionId: r.sessionId,
        tickets: r.tickets.map((t) => mediaWire.encodeTicket(t)),
        ...(iceServers !== undefined ? { iceServers } : {}),
      },
    });
  }
}

// ─── Entrada de notificações do host (§16.3) e o runtime de mídia ─────────────────────

/**
 * Porta de recepção das notificações de §16.3. Estrutural pela mesma razão de `RpcCallPort`:
 * §4 não autoriza `ipcRenderer` a importar `rpcClient`.
 */
export interface RpcNotifyPort {
  onNotify(cb: (topic: string, body: Uint8Array) => void): () => void;
}

/**
 * §17.4 passo 3 — "o cliente SÓ aceita sinalização de um par que apresente ticket válido
 * para (sessionId, esteParDeChaves)". A verificação é **do núcleo**, não do renderer: o
 * núcleo já tem o ticket do par e a chave do host, e sinalização não autorizada não deve
 * chegar à camada que fala WebRTC. Falha fechada — sem material, nada passa.
 */
export function signalIsAuthorized(a: {
  readonly security: SessionSecurity | null;
  readonly hostPublicKey: Buffer;
  readonly selfPublicKey: Buffer;
  readonly peerKeyHex: string;
  readonly now: number;
}): boolean {
  if (a.security === null) return false;
  if (!/^[0-9a-f]{64}$/i.test(a.peerKeyHex)) return false;
  const remoto = Buffer.from(a.peerKeyHex, 'hex');
  if (remoto.equals(a.selfPublicKey)) return false; // ninguém sinaliza consigo mesmo
  const par = orderedPair(a.selfPublicKey, remoto);
  return a.security.tickets.some(
    (ticket) =>
      verifyMediaTicket(
        a.hostPublicKey,
        ticket,
        {
          sessionId: a.security!.sessionId,
          channelId: a.security!.channelId,
          localPeer: par.peerA,
          remotePeer: par.peerB,
        },
        a.now,
      ).ok,
  );
}

/**
 * O que o boot liga: a cadência de renovação de ticket (§17.4 emendado) e a entrada das
 * notificações do host (§16.3), ambas desaguando no fan-out de eventos de §15.5.
 *
 * Existe para que o boot do utilityProcess não precise reconstruir esta ordem em cada
 * comunidade — e para que ela seja testável sem processo, sem socket e sem relógio de
 * parede.
 */
export function startMediaRuntime(opts: {
  readonly dispatcher: MediaDispatcher;
  /** §15.5 exige `communityId` no evento; há um runtime por comunidade. */
  readonly communityId: string;
  /** Saída para o renderer — a mesma forma que o `EventFanout` de §38 consome. */
  readonly emit: (events: readonly { readonly topic: string; readonly data: Record<string, unknown> }[]) => void;
  /** Ausente em modo host: quem hospeda não recebe notificação de §16.3, ele as produz. */
  readonly notifications?: RpcNotifyPort;
  /**
   * A chave do host, **lida a cada quadro**. Não é um valor de boot: a comunidade abre
   * antes de o log replicar, e até `community.create` ser interpretado `hostKey` é
   * `ZERO32` (§6). Capturá-la na abertura congelava o zero para sempre no lado de quem
   * NÃO hospeda — e como só o membro verifica ticket (§17.4 passo 3; quem hospeda entrega
   * a si mesmo pelo fan-out, sem passar por aqui), toda sinalização vinda do host morria
   * neste gate. Achado pelo smoke de duas pontas (B45): a chamada nunca fechava.
   */
  readonly hostPublicKey?: () => Buffer;
  readonly selfPublicKey?: Buffer;
  /** §26.2 — `MEDIA_TICKET_TTL_MS / 3`. */
  readonly ticketPeriodMs: number;
  readonly now?: () => number;
  readonly schedule?: (fn: () => void, ms: number) => unknown;
  readonly cancel?: (handle: unknown) => void;
}): { stop(): void; renovarAgora(): void } {
  const now = opts.now ?? Date.now;
  const renewer = new VoiceTicketRenewer({
    dispatcher: opts.dispatcher,
    communityId: () => opts.communityId,
    emit: (ev) => opts.emit([ev]),
    periodMs: opts.ticketPeriodMs,
    ...(opts.schedule !== undefined ? { schedule: opts.schedule } : {}),
    ...(opts.cancel !== undefined ? { cancel: opts.cancel } : {}),
  });
  renewer.start();

  let ultimaPuxadaDeTicket = 0;
  const off =
    opts.notifications?.onNotify((topic, body) => {
      let data: Record<string, unknown>;
      try {
        const parsed = JSON.parse(Buffer.from(body).toString('utf8')) as unknown;
        data = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
      } catch {
        return; // quadro estranho na condução nunca vira evento
      }

      if (topic === 'voice.signal') {
        // §16.3 regra 5 / §17.4 passo 3 — o gate fica aqui, antes do renderer.
        if (opts.hostPublicKey === undefined || opts.selfPublicKey === undefined) return;
        const autorizado = signalIsAuthorized({
          security: opts.dispatcher.sessionSecurity(),
          hostPublicKey: opts.hostPublicKey(),
          selfPublicKey: opts.selfPublicKey,
          peerKeyHex: typeof data['peerKey'] === 'string' ? data['peerKey'] : '',
          now: now(),
        });
        if (!autorizado) {
          // A recusa continua fechada — o quadro morre aqui —, mas ela é também um SINTOMA
          // conhecido: o par já está ofertando e o material deste lado ainda não chegou. Os
          // tickets de um par só existem depois que os dois estão no roster, e cada lado os
          // busca por conta própria (§17.4). Puxar a renovação agora é o que faz a próxima
          // tentativa do outro lado encontrar autorização, em vez de bater no mesmo silêncio.
          //
          // Com trava de tempo porque o gatilho vem da rede: um par que insista não compra
          // mais do que uma renovação por `PUXAR_TICKET_MIN_MS`.
          const agora = now();
          if (agora - ultimaPuxadaDeTicket >= PUXAR_TICKET_MIN_MS) {
            ultimaPuxadaDeTicket = agora;
            void renewer.tick();
          }
          return;
        }
      }

      if (topic === 'voice.roster') {
        // Par novo na chamada: a renovação de §17.4 precisa saber para emitir ticket a ele.
        const participants = data['participants'];
        if (Array.isArray(participants)) {
          const chaves = participants
            .map((p) => (typeof p === 'object' && p !== null ? (p as { keyHex?: unknown }).keyHex : undefined))
            .filter((k): k is string => typeof k === 'string');
          opts.dispatcher.observeRoster(chaves);
          // **Renovar AGORA, não na próxima volta da cadência.** Quem entra primeiro na
          // chamada recebe zero tickets — não havia com quem parear. Sem ticket o cliente
          // não oferta (§17.4 passo 4), e quem entra depois espera a oferta pela regra de
          // iniciativa: os dois ficam parados até o ciclo de `MEDIA_TICKET_TTL_MS / 3`,
          // que é da ordem de minutos. Foi assim que a chamada ficou em "Conectando…"
          // para sempre no smoke de duas máquinas (§78).
          void renewer.tick();
        }
      }

      if (topic === 'voice.queueChanged') {
        // §16.4 — o instantâneo completo da fila para `query.voiceQueue` (§15.6) ler daqui,
        // sem round-trip ao host. O evento segue ao renderer de qualquer forma (abaixo).
        opts.dispatcher.observarFila({
          channelId: typeof data['channelId'] === 'string' ? data['channelId'] : '',
          open: data['open'] === true,
          items: (Array.isArray(data['items']) ? data['items'] : []) as never,
          turn: (data['turn'] ?? null) as never,
        });
      }

      if (topic === 'voice.revoked') {
        // §17.4 — revogação da própria sessão derruba o estado local sem round-trip.
        const alvo = data['targetKey'];
        const eu = opts.selfPublicKey?.toString('hex');
        if (typeof alvo === 'string' && eu !== undefined && alvo === eu) {
          (opts.dispatcher as { forgetSession?: () => void }).forgetSession?.();
        }
      }

      opts.emit([{ topic, data: { communityId: opts.communityId, ...data } }]);
    }) ?? (() => {});

  return {
    /**
     * §17.4 — emitir ticket AGORA, fora da cadência. Quem entra primeiro numa chamada não
     * tem par com quem se parear, então recebe zero tickets; quando alguém chega, esperar o
     * ciclo de `MEDIA_TICKET_TTL_MS / 3` deixaria os dois lados parados por minutos.
     */
    renovarAgora: () => void renewer.tick(),
    stop() {
      renewer.stop();
      off();
    },
  };
}
