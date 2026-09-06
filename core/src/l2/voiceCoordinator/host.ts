// `voiceCoordinator` host-side — sessões de voz, tickets e revogação (§17.4, §RPC, A22).
//
// Contratos atendidos aqui:
//   `voiceJoin`   → `{sessionId, roster[], iceServers[], tickets[], turnCredential}`
//                   com validação de §17.4 passo 1 (`voice_speak`, canal de voz,
//                   comunidade não ended, membro ativo não banido nem em timeout);
//   `voiceLeave`  → `{}` com `voice.revoked{targetKey, sessionId}` aos participantes;
//   `voiceState`  → `{muted?, deafened?, cameraOn?, speaking?}`;
//   `voiceTicket` → `{ticketId, ticket, expiresAt}`, cadência `MEDIA_TICKET_TTL_MS/3`
//                   (§26.2), `E_TICKET_DENIED` quando o par não está na sessão;
//   `VoiceRoster` → fan-out a participantes a cada mudança (§17.6).
//
// §4: este módulo não declara `fold` — o estado estrutural entra pela porta estreita
// `VoiceStatePort`, que o `DecisionState` real satisfaz por estrutura, e os valores de
// contrato que moram no `fold` (`CHANNEL_TYPE` via predicado, `MEDIA_TICKET_TTL_MS`) e os
// segredos de assinatura chegam injetados pela composição.
//
// **Sem teto de ocupação (emenda de 2026-08-26, §90).** A sessão não recusa por lotação:
// nem de participante, nem de câmera. Ver `l1/fold/constants.ts` para o porquê. A derivação de revogação é função pura sobre essa porta
// (`sweepAgainst`): ban/kick/saída derrubam pelo estado do membro; `mod.timeout` pelo
// `timeoutUntil`; `channel.delete` e o fim da comunidade encerram a sessão inteira.

import crypto from 'node:crypto';

import { issueSessionTicket, ticketIdOf, type MediaTicket } from './tickets.ts';
import { issueTurnCredential, type TurnCredential } from '../communityHost/stunTurn.ts';
import { permissionFromNumber, type Permission } from '../../l1/permissions/index.ts';

export const VOICE_SPEAK: Permission = 'voice_speak';

/**
 * Varredura de permissão efetiva de um membro sobre o recorte da porta (§9.1). Exportada
 * para o `shareStar` e para a fronteira de mensagens, que reutilizam a mesma decisão sem
 * importar `permissions` — §4 não o declara nas dependências daqueles módulos. Lê só
 * `members` e `roles`: qualquer recorte com essa forma satisfaz (`WriteStatePort` incluída).
 */
export function memberHasPermission(
  state: Pick<VoiceStatePort, 'members' | 'roles'>,
  memberKeyHex: KeyHex,
  permission: Permission,
): boolean {
  const member = state.members.get(memberKeyHex);
  if (member === undefined) return false;
  for (const roleId of member.roleIds) {
    const role = state.roles.get(roleId);
    if (role === undefined || role.deletedAt !== undefined) continue;
    for (const n of role.permissions) {
      if (permissionFromNumber(n) === permission) return true;
    }
  }
  return false;
}

type Id = string;
type KeyHex = string;

/**
 * Recorte do `DecisionState` que a voz lê — porta declarada por este módulo (§4). O
 * `DecisionState` de L1 satisfaz-na por estrutura; nada além disto é lido.
 */
export interface VoiceStatePort {
  readonly community: { readonly exists: boolean; readonly endedAt?: number };
  readonly channels: ReadonlyMap<
    Id,
    { readonly type: number; readonly deletedAt?: number; readonly speechMode: number }
  >;
  readonly members: ReadonlyMap<
    KeyHex,
    {
      readonly state: 'active' | 'left' | 'banned';
      readonly timeoutUntil?: number;
      readonly roleIds: Iterable<string>;
    }
  >;
  /** Permissões como números de §9.1 — a conversão para `Permission` é feita aqui. */
  readonly roles: ReadonlyMap<Id, { readonly permissions: Iterable<number>; readonly deletedAt?: number }>;
}

/** Forma de `iceServers` entregue em `voiceJoin` — endereços vêm da porta injetada. */
export interface IceServer {
  readonly urls: string;
  readonly username?: string;
  readonly credential?: string;
  /**
   * §17.2 — esta entrada é de **terceiro** (não é servida por quem hospeda)?
   *
   * Quem produz a lista é o `MediaHost`, e só ele sabe a resposta: a lista é
   * `[...doHost, ...terceiros]` e `doHost` é vazio quando não há endereço público
   * observado, então **posição não identifica nada**. O renderer adivinhava por
   * `servers[0]` e errava justamente sob L-11, onde o único servidor é o terceiro (§99.3).
   *
   * Dois consumidores dependem desta resposta e nenhum dos dois pode inferi-la:
   * o aviso de §17.2, e a coleta em duas fases que devolve a garantia que a guarda 1
   * prometia (§99.13). Marcar aqui é mais barato que os dois adivinharem.
   *
   * Campo **aditivo e opcional**: §15.4 e §16.3 declaram `iceServers[]` sem enumerar os
   * campos de uma entrada, e uma propriedade a mais num `RTCIceServer` é ignorada pelo
   * WebIDL — o renderer repassa a lista ao `RTCPeerConnection` sem filtrar.
   */
  readonly terceiro?: boolean;
}

export type VoiceParticipantState = {
  readonly muted: boolean;
  readonly deafened: boolean;
  /**
   * Campo do contrato `VoiceRoster` (§6.16). Quem o muda é o `shareStar` via
   * `setSharing`, chamado pela composição no `started`/`stopped` da sessão de tela — não
   * `voiceState`, que só carrega o que o próprio cliente declara.
   */
  readonly sharing: boolean;
  readonly cameraOn: boolean;
  readonly speaking: boolean;
};

export type RosterEntry = VoiceParticipantState & { readonly keyHex: KeyHex };

export type RosterSnapshot = {
  readonly sessionId: string;
  readonly channelId: Id;
  readonly participants: readonly RosterEntry[];
};

/**
 * Por que a revogação aconteceu. §17.4 lista os gatilhos; §19.8 exige que o encerramento
 * de sessão inteira chegue **nomeado** ao renderer (`voice.failed{reason}`), e sem isto a
 * composição não tinha como distinguir "fulano saiu" de "o canal foi apagado".
 *
 * `peer-gone` é a emenda de 2026-08-26: queda de conexão é saída (§17.4). Antes dela nada
 * ligava o cabo caído ao roster, e quem desligou o computador ficava no roster para sempre.
 */
export type RevocationReason =
  | 'left'
  | 'peer-gone'
  | 'moderation'
  | 'channel-deleted'
  | 'community-ended';

export type RevokedTarget = {
  readonly sessionId: string;
  readonly channelId: Id;
  readonly targetKeyHex: KeyHex;
  readonly reason: RevocationReason;
  /**
   * §17.4: "o host emite `voice.revoked{targetKey, sessionId}` **a todos os participantes**".
   * Quem FICA é quem precisa fechar a `RTCPeerConnection` com o alvo — mandar só ao alvo
   * deixava a malha dos outros aberta com quem acabou de ser banido, que é justamente o
   * `T-32` que a seção diz fechar. Só L2 sabe quem estava na sessão no instante da remoção,
   * então a lista sai daqui; o fan-out continua sendo da composição.
   */
  readonly recipients: readonly KeyHex[];
};

interface Participant {
  muted: boolean;
  deafened: boolean;
  cameraOn: boolean;
  speaking: boolean;
  /**
   * §17.5 — este participante tem sessão de tela viva neste canal. Diferente dos vizinhos,
   * **não vem de `voiceState`**: a sessão de tela é do host (`share.start`/`share.stop`), e
   * o cliente não a declara. Quem o escreve é a composição, ao ver o evento de `shareStar`.
   */
  sharing: boolean;
}

interface Session {
  readonly sessionId: string;
  readonly channelId: Id;
  readonly createdAt: number;
  readonly participants: Map<KeyHex, Participant>;
}

export type JoinOk = {
  readonly ok: true;
  readonly sessionId: string;
  readonly channelId: Id;
  readonly roster: readonly RosterEntry[];
  readonly iceServers: readonly IceServer[];
  readonly tickets: readonly MediaTicket[];
  readonly turnCredential: TurnCredential;
};

export type VoiceErrorCode =
  | 'E_COMMUNITY_ENDED'
  | 'E_NOT_FOUND'
  | 'E_CHANNEL_NOT_FOUND'
  | 'E_CHANNEL_NOT_VOICE'
  | 'E_NOT_MEMBER'
  | 'E_BANNED'
  | 'E_TIMED_OUT'
  | 'E_PERMISSION_DENIED'
  | 'E_SESSION_GONE'
  | 'E_TICKET_DENIED';

export type JoinErr = { readonly ok: false; readonly code: VoiceErrorCode };

export type SetSelfPatch = {
  readonly muted?: boolean;
  readonly deafened?: boolean;
  readonly cameraOn?: boolean;
  readonly speaking?: boolean;
};

export interface VoiceHostOptions {
  /** Chave privada do host para emitir tickets (L0 `identity`, injetada no boot). */
  hostSecretKey: Buffer;
  /** Segredo das credenciais TURN de curta duração (§17.3). */
  hostTurnSecret: Buffer;
  clock?: { now(): number };
  /** Composição injeta `MEDIA_TICKET_TTL_MS` (§27.1) — vale para ticket e credencial. */
  ttlMs: number;
  /**
   * Prediço sobre o tipo numérico de canal de §6.6: a constante `CHANNEL_TYPE.voice`
   * mora no `fold` (§27.1), que este módulo não importa — a composição injeta o teste.
   */
  isVoiceChannelType: (type: number) => boolean;
  /**
   * **Emenda de 2026-08-28 (§17.4, R-29) — o gate de transmissão do modo de fala.** O modo
   * é constante do `fold` (`SPEECH_MODE`), e a fila de §16.4 é estado deste host — por isso
   * quem responde "este membro pode deixar o microfone aberto neste canal?" é a composição,
   * que tem as duas pontas. Default: sempre sim (modo `free`, o comportamento histórico).
   * É o predicado que gateia `voiceState {muted: false}`, o mute inicial de quem entra e a
   * imposição de mute da varredura — o host não sabe o que significa o modo, só que o
   * predicado é dono da resposta.
   */
  canTransmit?: (args: { state: VoiceStatePort; channelId: Id; memberKeyHex: KeyHex }) => boolean;
  /** Porta: endereço público do host via `hyperdht` (§17.3); default vazio. */
  iceServers?: () => readonly IceServer[];
  sessionIdFactory?: () => string;
  onRevoked?: (targets: readonly RevokedTarget[]) => void;
  onRosterChanged?: (snapshot: RosterSnapshot) => void;
}

/**
 * §17.3 — a credencial TURN é de curta duração e amarrada ao par, então quem a costura na
 * lista é o `voiceJoin`, não quem serve a socket. O `MediaHost` entrega os `urls`; a
 * credencial só existe aqui, onde a sessão existe.
 *
 * Sem esta costura o `turn:` chegava ao renderer sem `username`/`credential`, o Allocate
 * levava 401 e a lista anunciava um caminho que não abria — pior do que não anunciar.
 */
function comCredencialTurn(servers: readonly IceServer[], cred: TurnCredential): readonly IceServer[] {
  return servers.map((s) =>
    s.urls.startsWith('turn:') || s.urls.startsWith('turns:')
      ? { urls: s.urls, username: cred.username, credential: cred.password }
      : s,
  );
}

function participantEntry(keyHex: string, p: Participant): RosterEntry {
  return {
    keyHex,
    muted: p.muted,
    deafened: p.deafened,
    sharing: p.sharing,
    cameraOn: p.cameraOn,
    speaking: p.speaking,
  };
}

/**
 * Sessões de voz vivas do host. Estado **efêmero** (nunca persiste): morre com o
 * processo do host, que é exatamente quando toda voz morre (`VOZ-09`). A autoridade
 * estrutural é sempre o `DecisionState` corrente, passado como argumento.
 */
export class VoiceHostSessions {
  readonly #hostSecretKey: Buffer;
  readonly #turnSecret: Buffer;
  readonly #clock: { now(): number };
  readonly #ttlMs: number;
  readonly #isVoiceChannelType: (type: number) => boolean;
  readonly #canTransmit: (args: { state: VoiceStatePort; channelId: Id; memberKeyHex: KeyHex }) => boolean;
  readonly #iceServers: () => readonly IceServer[];
  readonly #sessionIdFactory: () => string;
  readonly #onRevoked: (targets: readonly RevokedTarget[]) => void;
  readonly #onRosterChanged: (snapshot: RosterSnapshot) => void;
  readonly #sessions = new Map<Id, Session>(); // channelId → session

  constructor(opts: VoiceHostOptions) {
    this.#hostSecretKey = opts.hostSecretKey;
    this.#turnSecret = opts.hostTurnSecret;
    this.#clock = opts.clock ?? { now: () => Date.now() };
    this.#ttlMs = opts.ttlMs;
    this.#isVoiceChannelType = opts.isVoiceChannelType;
    this.#canTransmit = opts.canTransmit ?? (() => true);
    this.#iceServers = opts.iceServers ?? (() => []);
    this.#sessionIdFactory = opts.sessionIdFactory ?? (() => crypto.randomBytes(16).toString('hex'));
    this.#onRevoked = opts.onRevoked ?? (() => {});
    this.#onRosterChanged = opts.onRosterChanged ?? (() => {});
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  sessionOf(channelId: Id): { sessionId: string; participants: readonly RosterEntry[] } | null {
    const s = this.#sessions.get(channelId);
    if (s === undefined) return null;
    return { sessionId: s.sessionId, participants: this.#rosterOf(s) };
  }

  /**
   * Todas as sessões vivas. §17.6 manda a ocupação a **todos os membros conectados**, e
   * ocupação é NÍVEL, não sequência: quem abre o aplicativo com uma chamada já em curso
   * não viu nenhuma das mudanças anteriores e, como `query.structure` não tem produtor de
   * ocupação fora do host (§15.6 `RT-05`), ficaria vendo a sala vazia até alguém entrar ou
   * sair. O instantâneo de boas-vindas é da composição; a lista é daqui.
   */
  activeSessions(): readonly { readonly sessionId: string; readonly channelId: Id; readonly participants: readonly RosterEntry[] }[] {
    return [...this.#sessions.values()].map((s) => ({
      sessionId: s.sessionId,
      channelId: s.channelId,
      participants: this.#rosterOf(s),
    }));
  }

  /** Chaves dos participantes — porta para o `MediaServer` (`sessionPeerKeys`, §17.3). */
  participantKeys(sessionId: string): ReadonlySet<KeyHex> {
    for (const s of this.#sessions.values()) {
      if (s.sessionId !== sessionId) continue;
      return new Set(s.participants.keys());
    }
    return new Set();
  }

  /**
   * Sessão corrente do membro ("voz é uma só") — a composição lê para o estado LS do
   * renderer e para `voice.leave`/`voice.setSelf`, que chegam sem `sessionId` (§15.4).
   */
  currentSessionOf(memberKeyHex: KeyHex): { readonly sessionId: string; readonly channelId: Id } | null {
    const s = this.#sessionOfMember(memberKeyHex);
    return s === undefined ? null : { sessionId: s.sessionId, channelId: s.channelId };
  }

  /**
   * `voiceJoin`. Idempotente para quem já está na sessão: devolve a mesma sessão com
   * material fresco — é também o caminho de renovação da `turnCredential`, cujo
   * `expiresAt` viaja dentro do `username` (§17.3).
   */
  join(args: { state: VoiceStatePort; channelId: Id; memberKeyHex: KeyHex }): JoinOk | JoinErr {
    const now = this.#clock.now();
    const state = args.state;

    // §17.4 passo 1 — comunidade não ended
    if (!state.community.exists) return { ok: false, code: 'E_NOT_FOUND' };
    if (state.community.endedAt !== undefined) return { ok: false, code: 'E_COMMUNITY_ENDED' };

    // canal de voz existente
    const channel = state.channels.get(args.channelId);
    if (channel === undefined || channel.deletedAt !== undefined) return { ok: false, code: 'E_CHANNEL_NOT_FOUND' };
    if (!this.#isVoiceChannelType(channel.type)) return { ok: false, code: 'E_CHANNEL_NOT_VOICE' };

    // membro ativo, não banido nem em timeout
    const eligibility = this.#memberEligible(state, args.memberKeyHex, now);
    if (!eligibility.ok) return eligibility;

    // permissão `voice_speak` (§9.1)
    if (!this.#hasVoiceSpeak(state, args.memberKeyHex)) return { ok: false, code: 'E_PERMISSION_DENIED' };

    // sessão do canal — a primeira entrada a cria. Não há teto de ocupação (§90): quem
    // passou pela elegibilidade e pela permissão entra, e o custo de uma chamada grande é
    // de máquina, não de protocolo.
    let session = this.#sessions.get(args.channelId);
    if (session !== undefined && session.participants.has(args.memberKeyHex)) {
      return this.#joinResult(session, args.memberKeyHex);
    }
    if (session === undefined) {
      session = {
        sessionId: this.#sessionIdFactory(),
        channelId: args.channelId,
        createdAt: now,
        participants: new Map(),
      };
    }

    // entrar numa chamada enquanto está noutra é sair da anterior (voz é uma só)
    const previous = this.#sessionOfMember(args.memberKeyHex);
    if (previous !== undefined && previous.sessionId !== session.sessionId) {
      this.leave({ sessionId: previous.sessionId, memberKeyHex: args.memberKeyHex });
    }

    const isNew = !this.#sessions.has(args.channelId);
    // §17.4 (emenda de 2026-08-28): quem entra num canal que gateia a transmissão entra
    // BLOQUEADO, mesmo pedindo o contrário — o estado inicial é do modo, não do cliente.
    session.participants.set(args.memberKeyHex, {
      muted: !this.#canTransmit({ state, channelId: args.channelId, memberKeyHex: args.memberKeyHex }),
      deafened: false,
      cameraOn: false,
      speaking: false,
      // Quem entra na chamada não está transmitindo tela: se estivesse, a sessão de tela
      // teria sido criada dentro de uma chamada que ele acabou de deixar (§17.5, A19).
      sharing: false,
    });
    if (isNew) this.#sessions.set(args.channelId, session);

    this.#emitRoster(session);
    return this.#joinResult(session, args.memberKeyHex);
  }

  /** `voiceLeave`: remove e emite `voice.revoked{targetKey}` (§17.4). */
  leave(args: { sessionId: string; memberKeyHex: KeyHex }): { ok: true } | { ok: false; code: 'E_SESSION_GONE' } {
    const session = this.#bySessionId(args.sessionId);
    if (session === undefined || !session.participants.has(args.memberKeyHex)) {
      return { ok: false, code: 'E_SESSION_GONE' };
    }
    this.#remove(session, args.memberKeyHex, 'left');
    return { ok: true };
  }

  /**
   * **Emenda de 2026-08-26 (§17.4) — queda de conexão é saída.** O par não fala mais: ou o
   * transporte avisou que o cabo caiu, ou a varredura de vivacidade não o vê há tempo
   * demais. Nos dois casos ele sai da chamada exatamente como sairia por `voiceLeave` —
   * mesma revogação, mesmo roster novo, mesma ocupação —, com o motivo trocado para que a
   * UI possa dizer "caiu" em vez de "saiu".
   *
   * Idempotente: quem não está em sessão nenhuma devolve lista vazia.
   */
  dropPeer(memberKeyHex: KeyHex): readonly RevokedTarget[] {
    const session = this.#sessionOfMember(memberKeyHex);
    if (session === undefined) return [];
    return [this.#remove(session, memberKeyHex, 'peer-gone')];
  }

  /**
   * §22.1 `voice.liveness` — a rede de segurança do `dropPeer`. Um computador desligado no
   * meio da chamada pode não produzir fechamento de stream nenhum (a outra ponta nunca
   * manda FIN); sem esta varredura o roster só se corrigiria no próximo `voiceJoin`, que
   * pode não vir nunca. `isAlive` é predicado puro — quem sabe o que é "vivo" é a
   * composição, que tem as conexões; este módulo continua sem ver transporte (§4).
   */
  sweepLiveness(isAlive: (memberKeyHex: KeyHex) => boolean): readonly RevokedTarget[] {
    const emitted: RevokedTarget[] = [];
    for (const session of [...this.#sessions.values()]) {
      for (const keyHex of [...session.participants.keys()]) {
        if (isAlive(keyHex)) continue;
        emitted.push(this.#remove(session, keyHex, 'peer-gone'));
      }
    }
    return emitted;
  }

  /**
   * `voiceState{muted?, deafened?, cameraOn?, speaking?}` — só o próprio estado.
   *
   * **Emenda de 2026-08-28 (§17.4):** a transição para `muted: false` passa pelo gate do
   * modo de fala. Recusado, o estado do roster permanece (o host NÃO aplica o pedido) e o
   * código é `E_PERMISSION_DENIED` — a UI distingue "silenciado" (cooperativo, sempre
   * aceito) de "aguardando vez / sem permissão de fala" (imposição do modo).
   */
  setSelf(args: { state: VoiceStatePort; sessionId: string; memberKeyHex: KeyHex; patch: SetSelfPatch }): { ok: true } | { ok: false; code: VoiceErrorCode } {
    const session = this.#bySessionId(args.sessionId);
    const p = session?.participants.get(args.memberKeyHex);
    if (session === undefined || p === undefined) return { ok: false, code: 'E_SESSION_GONE' };
    if (args.patch.muted === false && p.muted === true) {
      const pode = this.#canTransmit({ state: args.state, channelId: session.channelId, memberKeyHex: args.memberKeyHex });
      if (!pode) return { ok: false, code: 'E_PERMISSION_DENIED' };
    }
    if (args.patch.muted !== undefined) p.muted = args.patch.muted;
    if (args.patch.deafened !== undefined) p.deafened = args.patch.deafened;
    if (args.patch.cameraOn !== undefined) p.cameraOn = args.patch.cameraOn;
    if (args.patch.speaking !== undefined) p.speaking = args.patch.speaking;
    this.#emitRoster(session);
    return { ok: true };
  }

  /**
   * `voiceMuteParticipant` (§15.4): mutar **outro** participante é decisão do host com
   * `voice_mute_others` (§9.1) — o alvo não autoriza o próprio silenciamento. Estado
   * efêmero do roster; vai embora com a sessão (§6.16).
   */
  muteParticipant(args: {
    state: VoiceStatePort;
    sessionId: string;
    actorKeyHex: KeyHex;
    targetKeyHex: KeyHex;
    muted: boolean;
  }): { ok: true } | { ok: false; code: 'E_SESSION_GONE' | 'E_PERMISSION_DENIED' } {
    if (!memberHasPermission(args.state, args.actorKeyHex, 'voice_mute_others')) {
      return { ok: false, code: 'E_PERMISSION_DENIED' };
    }
    const session = this.#bySessionId(args.sessionId);
    const target = session?.participants.get(args.targetKeyHex);
    if (session === undefined || target === undefined) return { ok: false, code: 'E_SESSION_GONE' };
    target.muted = args.muted;
    this.#emitRoster(session);
    return { ok: true };
  }

  /**
   * §17.5 / §6.16 — **o `sharing` do roster passa a ser escrito.**
   *
   * O campo está no contrato de `VoiceRoster` desde sempre e o host publicava `false`
   * constante, com o comentário dizendo que "quem muda é o `shareStar`" — e nada mudava. O
   * custo não era cosmético: o renderer reconstrói a lista inteira a cada roster, então a
   * marca de "está compartilhando tela" que `share.started` acendia era apagada pelo roster
   * seguinte — o de qualquer `voiceState` de qualquer participante. Sumiam junto o ícone do
   * tile de quem apresenta e a confirmação de §11 (C11) ao sair da chamada compartilhando,
   * que lê exatamente este campo.
   *
   * A autoridade é do host porque a **sessão** é dele: `share.start` e `share.stop` passam
   * por aqui, e o cliente não tem como declarar o que ele não decide. Quem chama é a
   * composição, no mesmo ponto em que emite `share.started`/`share.stopped`.
   *
   * Idempotente e silencioso quando nada muda: um `viewersChanged` não republica roster.
   */
  setSharing(channelId: Id, memberKeyHex: KeyHex, sharing: boolean): void {
    const session = this.#sessions.get(channelId);
    const p = session?.participants.get(memberKeyHex);
    if (session === undefined || p === undefined) return;
    if (p.sharing === sharing) return;
    p.sharing = sharing;
    this.#emitRoster(session);
  }

  /**
   * §16.4 (emenda de 2026-08-28) — a troca de turno aplicada no roster NO ATO. O sweep de
   * §17.4 reimpõe o gate só quando um op é projetada — entre "a vez acabou" e o próximo
   * registro do log pode haver minutos, e quem perdeu a vez ficaria com o microfone aberto
   * o tempo todo. Quem ENTRA em canal de fila já entra mudo (join); quem GANHA a vez tem o
   * microfone aberto pelo host — a imposição de entrada vale até chegar a vez; quem perde,
   * é silenciado aqui, inclusive quando a fila encerra sem sucessor.
   */
  imporTurno(channelId: Id, holder: KeyHex | null): void {
    const session = this.#sessions.get(channelId);
    if (session === undefined) return;
    let mudou = false;
    for (const [keyHex, p] of session.participants) {
      if (keyHex === holder) {
        if (p.muted) {
          p.muted = false;
          mudou = true;
        }
      } else if (!p.muted) {
        p.muted = true;
        mudou = true;
      }
    }
    if (mudou) this.#emitRoster(session);
  }

  /**
   * `voiceTicket{sessionId, peerKey}` — renovação par-a-par na cadência
   * `MEDIA_TICKET_TTL_MS/3` (§26.2). Recusa com `E_TICKET_DENIED` se a sessão acabou,
   * se algum dos dois não participa ou se alguém deixou de ser elegível no log.
   */
  renewTicket(args: {
    state: VoiceStatePort;
    sessionId: string;
    memberKeyHex: KeyHex;
    peerKeyHex: KeyHex;
  }): { ok: true; ticketId: string; ticket: MediaTicket; expiresAt: number } | { ok: false; code: 'E_TICKET_DENIED' } {
    const now = this.#clock.now();
    const session = this.#bySessionId(args.sessionId);
    if (
      session === undefined ||
      !session.participants.has(args.memberKeyHex) ||
      !session.participants.has(args.peerKeyHex) ||
      args.memberKeyHex === args.peerKeyHex ||
      !this.#memberEligible(args.state, args.memberKeyHex, now).ok ||
      !this.#memberEligible(args.state, args.peerKeyHex, now).ok
    ) {
      return { ok: false, code: 'E_TICKET_DENIED' };
    }
    const selfKey = Buffer.from(args.memberKeyHex, 'hex');
    const otherKey = Buffer.from(args.peerKeyHex, 'hex');
    if (selfKey.length !== 32 || otherKey.length !== 32) return { ok: false, code: 'E_TICKET_DENIED' };
    const expiresAt = now + this.#ttlMs;
    const ticket = issueSessionTicket(this.#hostSecretKey, {
      sessionId: args.sessionId,
      channelId: session.channelId,
      selfKey,
      otherKey,
      now,
      ttlMs: this.#ttlMs,
    });
    // O id é do TICKET, derivado da assinatura: quem recebe o mesmo ticket chega ao mesmo
    // id sem que ele precise viajar (§17.4, emenda de 2026-08-25).
    return { ok: true, ticketId: ticketIdOf(ticket), ticket, expiresAt };
  }

  /**
   * Deriva as revogações do momento a partir do estado corrente — o host chama após
   * cada admissão projetada. Devolve os alvos emitidos (teste e métrica); o fan-out a
   * destinatários concretos é da composição.
   *
   * Permissão removida no meio da sessão **não** derruba: §17.4 define enforcement por
   * remoção de roster + revogação de ticket, e quem revalida `voice_speak` é a entrada.
   */
  sweepAgainst(state: VoiceStatePort): readonly RevokedTarget[] {
    const now = this.#clock.now();
    const emitted: RevokedTarget[] = [];

    if (!state.community.exists || state.community.endedAt !== undefined) {
      for (const session of [...this.#sessions.values()]) this.#endSession(session, emitted, 'community-ended');
      return emitted;
    }

    for (const session of [...this.#sessions.values()]) {
      const channel = state.channels.get(session.channelId);
      if (channel === undefined || channel.deletedAt !== undefined) {
        this.#endSession(session, emitted, 'channel-deleted');
        continue;
      }
      for (const keyHex of [...session.participants.keys()]) {
        if (!this.#memberEligible(state, keyHex, now).ok) {
          // §17.6 — o roster novo sai AQUI, como sai no `leave`. Sem ele quem ficava na
          // chamada continuava vendo o banido na lista e com a `RTCPeerConnection` aberta:
          // a remoção acontecia só na memória do host.
          emitted.push(this.#remove(session, keyHex, 'moderation'));
        }
      }
      // §17.4 (emenda de 2026-08-28) — a troca de modo aplica NA HORA: quem estava
      // desmutado e perdeu o direito de transmitir com o `channel.update` é silenciado
      // pelo roster, sem comando novo. A varredura já roda a cada admissão projetada,
      // que é exatamente quando o modo pode ter mudado.
      let silenciou = false;
      for (const [keyHex, p] of session.participants) {
        if (!p.muted && !this.#canTransmit({ state, channelId: session.channelId, memberKeyHex: keyHex })) {
          p.muted = true;
          silenciou = true;
        }
      }
      if (silenciou) this.#emitRoster(session);
    }
    return emitted;
  }

  #endSession(session: Session, emitted: RevokedTarget[], reason: RevocationReason): void {
    // A lista de destinatários é a de ANTES do esvaziamento: todos os que estavam na
    // chamada precisam da revogação de todos os outros (§17.4), inclusive de si mesmos.
    const recipients = [...session.participants.keys()];
    if (recipients.length > 0) {
      const targets = recipients.map((keyHex) => ({
        sessionId: session.sessionId,
        channelId: session.channelId,
        targetKeyHex: keyHex,
        reason,
        recipients,
      }));
      session.participants.clear();
      this.#onRevoked(targets);
      emitted.push(...targets);
    }
    // Sessão encerrada é ocupação zero, e isso é observável de fora da chamada.
    this.#emitRoster(session);
    this.#dropIfEmpty(session);
  }

  /**
   * A saída de UM participante, com o motivo que a causou: revogação a quem estava na
   * chamada, roster novo a quem ficou, e a sessão vazia desaparece. É o corpo único de
   * `voiceLeave`, de `dropPeer` e da revogação derivada do log — os três removiam do mesmo
   * jeito e só dois emitiam roster.
   */
  #remove(session: Session, targetKeyHex: KeyHex, reason: RevocationReason): RevokedTarget {
    const recipients = [...session.participants.keys()];
    session.participants.delete(targetKeyHex);
    const target: RevokedTarget = {
      sessionId: session.sessionId,
      channelId: session.channelId,
      targetKeyHex,
      reason,
      recipients,
    };
    this.#onRevoked([target]);
    // §17.6 — quem FICOU precisa da lista nova. Sem isto o roster só se corrigia no próximo
    // join, e a ocupação do canal (§15.5 `voice.occupancyChanged`) nunca voltava a zero.
    this.#emitRoster(session);
    this.#dropIfEmpty(session);
    return target;
  }

  /** Material de `voiceJoin` para um participante já presente (renovação idempotente). */
  #joinResult(session: Session, memberKeyHex: KeyHex): JoinOk {
    const now = this.#clock.now();
    const roster = this.#rosterOf(session);
    const selfKey = Buffer.from(memberKeyHex, 'hex');
    const tickets = roster
      .filter((e) => e.keyHex !== memberKeyHex)
      .map((e) =>
        issueSessionTicket(this.#hostSecretKey, {
          sessionId: session.sessionId,
          channelId: session.channelId,
          selfKey,
          otherKey: Buffer.from(e.keyHex, 'hex'),
          now,
          ttlMs: this.#ttlMs,
        }),
      );
    const turnCredential = issueTurnCredential(this.#turnSecret, session.sessionId, selfKey, now + this.#ttlMs);
    return {
      ok: true,
      sessionId: session.sessionId,
      channelId: session.channelId,
      roster,
      iceServers: comCredencialTurn(this.#iceServers(), turnCredential),
      tickets,
      turnCredential,
    };
  }

  #rosterOf(session: Session): RosterEntry[] {
    return [...session.participants.entries()]
      .map(([keyHex, p]) => participantEntry(keyHex, p))
      .sort((a, b) => a.keyHex.localeCompare(b.keyHex));
  }

  #bySessionId(sessionId: string): Session | undefined {
    for (const s of this.#sessions.values()) if (s.sessionId === sessionId) return s;
    return undefined;
  }

  #sessionOfMember(memberKeyHex: KeyHex): Session | undefined {
    for (const s of this.#sessions.values()) if (s.participants.has(memberKeyHex)) return s;
    return undefined;
  }

  #memberEligible(
    state: VoiceStatePort,
    memberKeyHex: KeyHex,
    now: number,
  ): { ok: true } | { ok: false; code: VoiceErrorCode } {
    const member = state.members.get(memberKeyHex);
    if (member === undefined) return { ok: false, code: 'E_NOT_MEMBER' };
    if (member.state === 'banned') return { ok: false, code: 'E_BANNED' };
    if (member.state === 'left') return { ok: false, code: 'E_NOT_MEMBER' };
    if (member.timeoutUntil !== undefined && member.timeoutUntil > now) return { ok: false, code: 'E_TIMED_OUT' };
    return { ok: true };
  }

  #hasVoiceSpeak(state: VoiceStatePort, memberKeyHex: KeyHex): boolean {
    return memberHasPermission(state, memberKeyHex, VOICE_SPEAK);
  }

  #emitRoster(session: Session): void {
    this.#onRosterChanged({
      sessionId: session.sessionId,
      channelId: session.channelId,
      participants: this.#rosterOf(session),
    });
  }

  #dropIfEmpty(session: Session): void {
    if (session.participants.size === 0 && this.#sessions.get(session.channelId) === session) {
      this.#sessions.delete(session.channelId);
    }
  }
}
