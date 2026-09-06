// O boot do `utilityProcess` — a raiz de composição de §4 e as fases `open` … `host-mode`
// de §3.3.
//
// Todas as peças que ele liga já existem e são testadas em separado. O que não existia era
// o **lugar** onde elas se conhecem: `Projector.onEvent` e `Outbox.onOutcome` desaguando no
// mesmo `EventFanout` (§38.2); a escolha entre `localMediaDispatcher` e
// `remoteMediaDispatcher` por comunidade (§42.3, §43.3); o `startMediaRuntime` com relógio
// de verdade (§17.4 emendado); o mapa conexão↔membro que `peerSignalRelay` consulta
// (§43.3); e as portas de sucessão, saída e consulta (§35.2, §37.2).
//
// Nada aqui decide domínio. Toda decisão continua no `fold` (L1) ou no serviço de L2 que a
// tabela de §4 nomeia; este arquivo escolhe implementações e as injeta.
//
// **O transporte chega injetado.** O boot nunca abre socket: ele recebe `RpcTransportPort`
// por conexão e devolve o cabo. É essa costura que a fase seguinte (protomux-rpc sobre
// Hyperswarm) preenche sem tocar em nada abaixo.

import fs from 'node:fs';
import path from 'node:path';

import {
  CHANNEL_TYPE,
  HOST_INACTIVITY_MS,
  MEDIA_TICKET_TTL_MS,
  SPEECH_MODE,
  type DecisionState,
} from '../l1/fold/index.ts';
import { OP_VERSION } from '../l1/opCodec/index.ts';
import { MANIFEST_SCHEMA_VERSION } from '../l0/manifest/index.ts';
import { VIEW_SCHEMA_VERSION } from '../l0/view/index.ts';
import { IDENTITY_UPDATE_KIND } from '../l2/communityClient/index.ts';
import { Projector } from '../l1/projector/index.ts';
import type { ViewDb } from '../l0/view/index.ts';
import type { ManifestDb } from '../l0/manifest/index.ts';
import {
  deriveCommunityKeyPairs,
  openCore,
  openWritableCore,
  type CoreHandle,
  type WritableCoreHandle,
} from '../l0/corestore/index.ts';
import type { Swarm } from '../l0/swarm/index.ts';
import { HostAdmission } from '../l2/communityHost/index.ts';
import { CommunityClient, type HostSubmitPort } from '../l2/communityClient/index.ts';
import { Outbox } from '../l2/outbox/index.ts';
import { InviteManager } from '../l2/invites/index.ts';
import { PRESENCE_TTL_MS, PRESENCE_TICK_MS, TYPING_TTL_MS, PresenceManager, type PresenceDelta, type PresenceStatus, type TypingDelta } from '../l2/presence/index.ts';
import { SearchService } from '../l2/search/index.ts';
import { SuccessionService } from '../l2/succession/index.ts';
import {
  FilaKaraoké,
  filaParaOFio,
  VoiceHostSessions,
  memberHasPermission,
  type IceServer,
  type RevokedTarget,
  type RosterSnapshot,
} from '../l2/voiceCoordinator/index.ts';
import { ShareHealthMonitor, ShareHostSessions, type ShareRevokedTarget, type ShareSessionEvent } from '../l2/shareStar/index.ts';
import { MediaHost } from './media.ts';
import { RelayVolunteer, type RelayConsentPort } from '../l2/relay/index.ts';
import { identitySeedOf } from './community.ts';
import { RELAY_TTL_MS } from '../l1/fold/constants.ts';
import {
  aplicarRemocaoPropria,
  causaDaPropriaSaida,
  kicksSobreMimEm,
  type CausaDeRemocao,
  type RemocaoDeps,
} from './removido.ts';
import { sondarStun } from './relayPort.ts';
import { resolveConfig } from '../l0/config/index.ts';
import { classificarNat, Diagnostics } from '../l2/diagnostics/index.ts';
import { BlobManager } from '../l2/blobs/index.ts';
import { EventFanout } from '../l3/ipcRenderer/fanout.ts';
import { IpcServer, type IpcPort } from '../l3/ipcRenderer/index.ts';
import { registerCoreCommands, type CoreCommandDeps } from '../l3/ipcRenderer/commands.ts';
import { registerDmCommands, type DmSurfaceDeps } from '../l3/ipcRenderer/dmCommands.ts';
import {
  localMediaDispatcher,
  remoteMediaDispatcher,
  startMediaRuntime,
  type MediaAck,
  type MediaDispatcher,
  type SessionSecurity,
  type ShareStartOk,
  type VoiceJoinOk,
  type VoiceTicketsOk,
  type MediaFail,
  type ShareJoinOk,
  type SetQualityOkResult,
} from '../l3/ipcRenderer/media.ts';
import type { CommunityTransport } from './transport.ts';
import { criarDmRuntime, type DmRuntime } from './dmRuntime.ts';
import { criarDmCall } from './dmCall.ts';
import { RpcClient } from '../l3/rpcClient/index.ts';
import { RpcServer, type RpcTransportPort } from '../l3/rpcServer/index.ts';
import { peerSignalRelay } from '../l3/rpcServer/media.ts';
import { AdmissionService, type AdmissionServiceDeps } from './admission.ts';
import { HostStatusTracker, type HostStatusDeps } from './hostStatus.ts';
import { startJobs, startLoops, VOICE_LIVENESS_MS, VOICE_OCCUPANCY_COALESCE_MS, VOICE_OCCUPANCY_FIRST_KEYS, type JobRunner, type LoopRunner } from './jobs.ts';
import {
  aeadOpenPacked,
  aeadSealPacked,
  createCommunity,
  endCommunity,
  forgetCommunity,
  inviteCreate,
  inviteRevoke,
  memberBlobsKeyPairFor,
  type BootIdentityLike,
  type CreateCommunityInput,
  type InviteCreateArgs,
} from './community.ts';
import {
  memberSetNickname,
  memberSetRoles,
  modBan,
  modKick,
  modRemoveTimeout,
  modRevokeBan,
  modTimeout,
  roleCreate,
  roleDelete,
  roleMove,
  roleUpdate,
} from './moderation.ts';
import {
  categorySetCollapsed,
  channelMarkRead,
  channelSetMuted,
  navSetActive,
  settingsSetDevice,
  settingsSetNotifications,
  settingsSetParticipantVolume,
  settingsSetVolume,
  threadMarkRead,
  type PreferencesDeps,
} from './preferences.ts';
import { queryReadPorts, searchPartialReason } from './queries.ts';
import { UnreadTracker } from './unread.ts';
import type { IdentityManager } from '../l0/identity/index.ts';
import { FallbackKeystoreOracle } from '../l0/keystore/index.ts';
import {
  IdentityService,
  insecureFallbackKeystorePort,
  type IdentityKeystorePort,
  type LocalPresence,
  PRESENCE_VALUES,
} from './identity.ts';
import sodium from 'sodium-native';

import { executeWipe } from './wipe.ts';
import { escopoDeConfirmacao } from '../l3/ipcMain/index.ts';
import { NdjsonLogger, MetricsRegistry, serieId, type LoggerPort } from './logger.ts';
import { isAvatarColor, checkDisplayName } from '../l1/fold/index.ts';
import type { DiagnosticsMetricsPort, MetricsSnapshot } from '../l2/diagnostics/index.ts';
import {
  categoryCreate,
  categoryDelete,
  categoryRename,
  channelCreate,
  channelDelete,
  channelMove,
  channelUpdate,
  communityActivate,
  communityUpdate,
} from './structure.ts';
import {
  SUBMISSION_LIMITS,
  admissionSubmitPort,
  blobAttachmentPort,
  blobCorePorts,
  bridgeSubmitSyncPort,
  communityLeavePort,
  corestoreContinuationCorePort,
  envelopeTargetResolver,
  hostExitImpactPort,
  hostRecordSigner,
  logEscrowPort,
  manifestCommunitySeedPort,
  storeCommunitySeed,
  migrateRail,
  opCodecSignPort,
  queryCommunityPort,
  queryInvitesPort,
  rpcHostSubmitPort,
  rpcSubmitPort,
  viewAttachmentResolver,
  voiceStateOf,
  wireHostMediaRpc,
  wireHostPresenceRpc,
  wireHostRpc,
  wireRefusedCommunityRpc,
  type HelloInfo,
} from './ports.ts';

/** Identidade local de §5.5 — `null` no estado `awaiting-identity` de §3.3. */
export type BootIdentity = { readonly publicKey: Buffer; readonly secretKey: Buffer };

/** Linha de `manifest.communities` (§10.2) recortada no que o boot lê. */
export type CommunityRow = {
  readonly community_id: string;
  readonly core_key: Buffer;
  readonly blobs_key: Buffer;
  readonly is_host: number;
  readonly left_at: number | null;
};

export type BootDeps = {
  /** `<userData>/p2p` de §10.1 — os cores ficam em `<dataDir>/cores/<keyHex>`. */
  readonly dataDir: string;
  readonly manifest: ManifestDb;
  readonly view: ViewDb;
  readonly swarm: Swarm;
  /** §5.4 — protege as sementes de comunidade no `manifest` (§5.3). */
  readonly dataKey: Buffer;
  identity(): BootIdentity | null;
  /** §10.6 — hash do binário do `fold`, calculado por quem compõe o boot. */
  readonly foldBuildId: string;
  /** Porta do IPC-R (§3.1): o `MessagePort` que o main cruzou até o renderer. */
  readonly ipcPort: IpcPort;
  /** §15.1 — incrementado a cada reinício do núcleo pelo main (§3.3, crash do núcleo). */
  readonly epoch: number;
  /** §15.3 — tokens de confirmação nativa; chegam pelo IPC-M. */
  /**
   * §15.3 emendado — o `escopo` faz parte do contrato: um verificador que o ignore aceita
   * um token de `community.end` da comunidade A para encerrar a B. Declarado aqui porque um
   * tipo de dois argumentos é estruturalmente compatível com a chamada de três, e o
   * parâmetro a mais sumiria em silêncio.
   */
  readonly tokenVerifier: { consume(token: string, cmd: string, escopo: string | null): boolean };
  /** §17.3 — segredo do serviço TURN desta instalação, por comunidade hospedada. */
  hostTurnSecret(communityId: string): Buffer;
  /** Perfil local (`displayName`/`avatarColor`) para o `member.join` da gênese e do resgate. */
  identityProfile?(): { readonly displayName: string; readonly avatarColor: number } | null;
  /** §24.3 — depende de sonda de NAT/STUN, que é transporte; chega pronto. */
  readonly diagnostics?: Diagnostics;
  /**
   * §15.4 "Identidade e app" — o `IdentityManager` desta instalação. Presente, os comandos
   * `identity.*` e a transição `awaiting-identity → ready` (§3.3) existem; ausente, o
   * núcleo continua servindo o resto com `identityStatus` passivo.
   */
  readonly identityManager?: IdentityManager;
  /** §3.2/A13 — o keystore via IPC-M; default é o fallback inseguro com aceite explícito. */
  readonly keystore?: IdentityKeystorePort;
  /** §5.5 export — o main grava o arquivo do backup; caminho nenhum volta daqui. */
  saveFile?(a: { readonly suggestedName: string; readonly data: Buffer }): Promise<{ ok: true } | { ok: false; code: string }>;
  /** §5.5 import — o main lê o arquivo escolhido pelo diálogo nativo. */
  readFile?(): Promise<Buffer | null>;
  /** §18.6 — depois do wipe o núcleo reinicia: quem sai é o processo (injetável em teste). */
  exit?(): void;
  /** §10.8 — o flock composto é do shell; o wipe é quem o libera por último. */
  readonly lock?: { release(): void };
  /**
   * §24.1 — o produtor NDJSON. Default: `<dataDir>/logs/core-YYYY-MM-DD.ndjson` com a
   * allowlist de §24.2. `null` desliga (rigs que não querem disco).
   */
  readonly logger?: LoggerPort | undefined;
  /** §15.3/§15.6 — canal de build; dev registra comandos `dev` e liga `debug` no log. */
  readonly buildChannel?: 'prod' | 'dev';
  /**
   * O diálogo do main que origina todo caminho de anexo (§13.3, §15.7). Sem ele,
   * `file.pickForAttachment` responde `E_CANCELLED` — o produto liga quando o shell
   * Electron existir; o núcleo nunca aceita caminho de renderer.
   */
  pickFile?(communityId: string): { readonly path: string; readonly sizeBytes: number } | Promise<{ readonly path: string; readonly sizeBytes: number } | null> | null;
  /** `shell.open` do main (§15.7) — destino dos `blob.reveal` aprovados pela allowlist. */
  onReveal?(a: { readonly path: string; readonly mode: 'open' | 'folder' }): void;
  /** Demais superfícies de §15.4 que o boot não constrói (relay). */
  readonly extraCommands?: Pick<CoreCommandDeps, 'relay' | 'relayConsent' | 'partialReason'>;
  readonly now?: () => number;
  /** Injetáveis só para teste determinístico; em produto são os do `globalThis`. */
  readonly schedule?: (fn: () => void, ms: number) => unknown;
  readonly cancel?: (handle: unknown) => void;
  /** §17.5 — validade do `captureToken` local (§17.4 emendado). */
  readonly captureTokenTtlMs?: number;
  /**
   * Quanto uma op ⏱ de estrutura espera a projeção local antes de responder sem os campos
   * derivados (`rank`, contagens de `category.delete`). O padrão de produto é curto — a
   * resposta não pode ficar presa à replicação de quem não hospeda; o teste alonga para
   * não depender da carga da máquina.
   */
  readonly projectionWaitMs?: number;
  /** Abertura do core; sobrescrita em teste para não tocar disco. */
  openCore?(a: {
    readonly communityId: string;
    readonly coreKey: Buffer;
    readonly keyPair: { readonly publicKey: Buffer; readonly secretKey: Buffer } | null;
  }): Promise<CoreHandle>;
};

/** Uma comunidade aberta: as peças de §3.3 fase `open` mais o modo de mídia escolhido. */
export type OpenCommunity = {
  readonly communityId: string;
  readonly isHost: boolean;
  readonly core: CoreHandle;
  readonly projector: Projector;
  readonly outbox: Outbox | null;
  /** Canal de §16.1 com o host — ausente em modo host (esta instalação **é** o host). */
  readonly rpc: RpcClient | null;
  readonly dispatcher: MediaDispatcher;
  readonly host: HostSide | null;
  /**
   * Presença e digitando (§6.16, §17.6) desta comunidade. No host é também a fonte da
   * agregação que ele empurra; no membro, o destino das notificações de §16.3.
   */
  readonly presence: PresenceManager;
  stop(): void;
};

/** O que só existe quando esta instalação hospeda a comunidade (§3.3 `host-mode`). */
export type HostSide = {
  readonly admission: HostAdmission;
  readonly voice: VoiceHostSessions;
  readonly share: ShareHostSessions;
  /**
   * §17.5/§17.6 — o monitor de `share.health` desta comunidade. Vive no host porque é ele
   * que guarda o perfil pedido por cada espectador; as amostras chegam por `shareReport`
   * (§16.2, emenda de 2026-08-25) e saem consolidadas ao apresentador.
   */
  readonly shareHealth: ShareHealthMonitor;
  /** O mapa conexão↔membro que `peerSignalRelay` consulta (§43.3, §16.3 regra 4). */
  readonly connections: Map<string, RpcServer>;
  /**
   * §22.1 `voice.liveness` (emenda de 2026-08-26) — instante do último pedido recebido de
   * cada par. É a evidência de vivacidade que §17.4 passou a exigir para o roster: o
   * `hello` de §22.1 chega a cada `P2P_HELLO_INTERVAL_MS` em toda conexão viva, então
   * silêncio longo demais é par morto, tenha o transporte percebido ou não.
   */
  readonly vistoEm: Map<string, number>;
  /**
   * A superfície de convites desta comunidade hospedada (§12): emite challenge, valida
   * preview/resgate e concilia os anúncios na DHT a cada lote projetado.
   */
  readonly invites: InviteManager;
  /** §16.4 — a fila de karaokê, efêmera; o loop de vivacidade é quem a faz ticar. */
  readonly fila: FilaKaraoké;
};

/**
 * Roteador de mídia por comunidade (§42.3, §43.3). §15.4 dá ao roteador **um** dispatcher, e
 * §15.4 `voice.leave` declara que "voz é uma só": a instalação tem no máximo uma sessão de
 * voz. As duas coisas juntas dizem exatamente o que este objeto faz — `voiceJoin` fixa a
 * comunidade corrente, e todo comando sem `communityId` vai para o dispatcher fixado.
 *
 * `share.*` endereça por `sessionId`, que não nomeia comunidade: o mapa
 * `sessionId → comunidade` é alimentado pelo `shareStart` local e por todo evento de §16.3
 * que carrega `sessionId` — é assim que um espectador sabe para onde mandar `shareJoin` de
 * uma sessão que ele não abriu. Sem registro, cai na comunidade da chamada corrente, que é
 * a única em que §17.5 permite que exista tela.
 */
class MediaRouter implements MediaDispatcher {
  readonly mode = 'host' as const;
  readonly #byCommunity: Map<string, MediaDispatcher>;
  readonly #sessionCommunity = new Map<string, string>();
  #currentVoice: string | null = null;

  constructor(byCommunity: Map<string, MediaDispatcher>) {
    this.#byCommunity = byCommunity;
  }

  /** Registra o vínculo `sessionId → comunidade` visto num evento de §16.3/§15.5. */
  observeSession(communityId: string, sessionId: unknown): void {
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      this.#sessionCommunity.set(sessionId, communityId);
    }
  }

  forget(communityId: string): void {
    if (this.#currentVoice === communityId) this.#currentVoice = null;
    for (const [sid, cid] of [...this.#sessionCommunity]) {
      if (cid === communityId) this.#sessionCommunity.delete(sid);
    }
  }

  #of(communityId: string): MediaDispatcher | null {
    return this.#byCommunity.get(communityId) ?? null;
  }

  #current(): MediaDispatcher | null {
    return this.#currentVoice === null ? null : this.#of(this.#currentVoice);
  }

  #bySession(sessionId: string): MediaDispatcher | null {
    const cid = this.#sessionCommunity.get(sessionId);
    return cid === undefined ? this.#current() : this.#of(cid);
  }

  currentSessionId(): string | null {
    return this.#current()?.currentSessionId() ?? null;
  }

  async voiceJoin(a: { communityId: string; channelId: string }): Promise<VoiceJoinOk | MediaFail> {
    const d = this.#of(a.communityId);
    if (d === null) return { ok: false, code: 'E_NOT_FOUND' };
    const r = await d.voiceJoin(a);
    if (r.ok) {
      this.#currentVoice = a.communityId;
      this.observeSession(a.communityId, r.sessionId);
    }
    return r;
  }

  async voiceLeave(): Promise<MediaAck> {
    const d = this.#current();
    if (d === null) return { ok: false, code: 'E_NOT_IN_CALL' };
    const r = await d.voiceLeave();
    this.#currentVoice = null;
    return r;
  }

  async voiceSetSelf(patch: Parameters<MediaDispatcher['voiceSetSelf']>[0]): Promise<MediaAck> {
    return (await this.#current()?.voiceSetSelf(patch)) ?? { ok: false, code: 'E_NOT_IN_CALL' };
  }

  async voiceMuteParticipant(a: { communityId: string; identityKey: string; muted: boolean }): Promise<MediaAck> {
    return (await this.#of(a.communityId)?.voiceMuteParticipant(a)) ?? { ok: false, code: 'E_NOT_FOUND' };
  }

  async voiceSignal(a: { peerKey: string; ticketId: string; sdp?: string; ice?: string }): Promise<MediaAck> {
    return (await this.#current()?.voiceSignal(a)) ?? { ok: false, code: 'E_NOT_IN_CALL' };
  }

  async renewTickets(): Promise<VoiceTicketsOk | MediaFail> {
    return (await this.#current()?.renewTickets()) ?? { ok: false, code: 'E_NOT_IN_CALL' };
  }

  async refreshSession(): Promise<
    { ok: true; sessionId: string; iceServers: readonly IceServer[] } | MediaFail
  > {
    return (await this.#current()?.refreshSession()) ?? { ok: false, code: 'E_NOT_IN_CALL' };
  }

  sessionSecurity(): SessionSecurity | null {
    return this.#current()?.sessionSecurity() ?? null;
  }

  observeRoster(participants: readonly string[]): void {
    this.#current()?.observeRoster(participants);
  }

  async shareStart(a: Parameters<MediaDispatcher['shareStart']>[0]): Promise<ShareStartOk | MediaFail> {
    const d = this.#of(a.communityId);
    if (d === null) return { ok: false, code: 'E_NOT_FOUND' };
    const r = await d.shareStart(a);
    if (r.ok) this.observeSession(a.communityId, r.sessionId);
    return r;
  }

  async shareStop(a: { sessionId: string }): Promise<MediaAck> {
    return (await this.#bySession(a.sessionId)?.shareStop(a)) ?? { ok: false, code: 'E_NOT_FOUND' };
  }

  async shareSetQuality(a: Parameters<MediaDispatcher['shareSetQuality']>[0]): Promise<SetQualityOkResult | MediaFail> {
    return (await this.#bySession(a.sessionId)?.shareSetQuality(a)) ?? { ok: false, code: 'E_NOT_FOUND' };
  }

  async shareJoin(a: { sessionId: string }): Promise<ShareJoinOk | MediaFail> {
    return (await this.#bySession(a.sessionId)?.shareJoin(a)) ?? { ok: false, code: 'E_NOT_FOUND' };
  }

  async shareReport(a: Parameters<MediaDispatcher['shareReport']>[0]): Promise<MediaAck> {
    return (await this.#bySession(a.sessionId)?.shareReport(a)) ?? { ok: false, code: 'E_NOT_FOUND' };
  }

  /**
   * §17.5 (emenda de 2026-08-28) — o `captureToken` do Modo Música é amarrado à sessão de
   * VOZ, não a uma sessão de tela: a rota certa é a comunidade em chamada (`#current`),
   * não o mapa de sessões de tela.
   */
  async musicStart(): Promise<Awaited<ReturnType<MediaDispatcher['musicStart']>>> {
    return (await this.#current()?.musicStart()) ?? { ok: false, code: 'E_NOT_IN_CALL' };
  }

  // ── §16.4 (emenda de 2026-08-28) — a fila de karaokê, da comunidade em chamada ─────

  async queueJoin(a: { channelId: string }): Promise<Awaited<ReturnType<MediaDispatcher["queueJoin"]>>> {
    return (await this.#current()?.queueJoin(a)) ?? { ok: false, code: 'E_NOT_IN_CALL' };
  }

  async queueLeave(a: { channelId: string }): Promise<Awaited<ReturnType<MediaDispatcher["queueLeave"]>>> {
    return (await this.#current()?.queueLeave(a)) ?? { ok: false, code: 'E_NOT_IN_CALL' };
  }

  async queueModerate(a: Parameters<MediaDispatcher['queueModerate']>[0]): Promise<Awaited<ReturnType<MediaDispatcher["queueModerate"]>>> {
    return (await this.#current()?.queueModerate(a)) ?? { ok: false, code: 'E_NOT_IN_CALL' };
  }

  observarFila(data: Parameters<MediaDispatcher['observarFila']>[0]): void {
    this.#current()?.observarFila(data);
  }

  /** A leitura de §15.6 `query.voiceQueue` — `null` sem fila conhecida. */
  snapshotFila(channelId: string): ReturnType<MediaDispatcher['snapshotFila']> {
    return this.#current()?.snapshotFila(channelId) ?? null;
  }

  authorizeCapture(a: { sessionId: string; kind?: 'screen' | 'music'; audio?: boolean }): ReturnType<MediaDispatcher['authorizeCapture']> {
    // Sem dispatcher para a sessão não há token local, e §17.4 emendado é falha fechada.
    if (a.kind === 'music') {
      return this.#current()?.authorizeCapture(a) ?? { allowed: false, reason: 'gone', audio: false };
    }
    return this.#bySession(a.sessionId)?.authorizeCapture(a) ?? { allowed: false, reason: 'gone', audio: false };
  }
}

/**
 * Porta `submitOp` de quem hospeda: não há round-trip nenhum: a fila de admissão de §11.4
 * está neste processo. Existe pela mesma razão que `rpcHostSubmitPort` — `communityClient`
 * não pode importar `communityHost` (§4), e quem conhece os dois é o boot.
 */
export function localHostSubmitPort(admission: Pick<HostAdmission, 'submit'>): HostSubmitPort {
  return async (envelope) => {
    const r = await admission.submit(envelope);
    return r.ok ? { ok: true, seq: r.seq } : { ok: false, code: r.code };
  };
}

/** §18.7 passo 2 — membros ativos; quem saiu ou foi banido não replica e não conta. */
function membrosAtivos(c: OpenCommunity): number {
  let n = 0;
  for (const m of c.projector.ds.members.values()) if (m.state === 'active') n++;
  return n;
}

/**
 * §18.7 passo 2 — o alvo da barreira: `min(3, memberCount − 1)`. Três pares bastam, e uma
 * comunidade com dois membros não pode esperar por três. Alvo zero (host sozinho) não
 * segura ninguém: não há para quem replicar, e esperar seria só atrasar o fechamento.
 */
export function alvoDeReplicacao(membrosAtivos: number): number {
  return Math.min(3, Math.max(0, membrosAtivos - 1));
}

/**
 * §18.7 passo 1 — quantos registros da cabeça ainda não alcançaram o alvo de pares.
 *
 * A conta anterior era `core.length − 1 − interpretedSeq`, o **atraso da projeção local**:
 * ela lia zero num host perfeitamente em dia consigo mesmo e sozinho no swarm, que é
 * exatamente o caso em que fechar perde tudo. O modal de U-06 mostrava esse zero.
 *
 * `confirmam(n)` responde "quantos pares têm o log contíguo até `n`" e é **monótona
 * decrescente** em `n` — mais log, menos pares que o têm. A maior cabeça que `alvo` pares
 * alcançam é, portanto, o maior `n` cuja resposta ainda é ≥ alvo, e a busca binária o acha
 * exatamente. Com menos pares que o alvo, esse `n` é 0 e a resposta é o log inteiro.
 */
export function opsForaDaBarreira(a: {
  readonly length: number;
  readonly alvo: number;
  readonly confirmam: (ate: number) => number;
}): number {
  if (a.alvo === 0) return 0;
  let baixo = 0;
  let alto = a.length;
  while (baixo < alto) {
    const meio = Math.ceil((baixo + alto) / 2);
    if (a.confirmam(meio) >= a.alvo) baixo = meio;
    else alto = meio - 1;
  }
  return Math.max(0, a.length - baixo);
}

/** O núcleo montado. É o que o `utilityProcess` guarda e o que o `draining` de §3.3 fecha. */
export class CoreRuntime {
  readonly ipc: IpcServer;
  readonly fanout: EventFanout;
  readonly client: CommunityClient;
  readonly succession: SuccessionService;
  readonly search: SearchService;
  /** Anexos de §13 — um manager por instalação, com os cores de blobs locais por comunidade. */
  readonly blobs: BlobManager;
  /**
   * Os jobs periódicos de §22.2 com dono em código (`invite.topicSweep`, `blob.gc`).
   * Anexado depois da construção porque dois deles dependem de serviços que nascem sobre o
   * runtime — `stop()` entra no `close`, que é o escopo de §22.5.
   */
  jobs: JobRunner | null = null;
  /**
   * §31 — o subsistema de conversa direta, anexado depois da construção pela mesma razão dos
   * demais: ele fecha sobre o runtime (o `onEvent` vai ao `fanout` daqui). `null` sem
   * identidade — não há `conversationId` a derivar sem uma chave própria (§31.2).
   */
  dm: DmRuntime | null = null;
  /** Os loops permanentes de §22.1 com corpo em código (presença/digitando). Mesmo escopo. */
  loops: LoopRunner | null = null;
  /**
   * O acompanhamento da conexão com o host (DR-29/DR-33, §15.6 `HostStatus`). Anexado depois
   * da construção porque as portas dele fecham o runtime; o `openCommunity` registra cada
   * comunidade nele.
   */
  hostStatus: HostStatusTracker | null = null;
  /**
   * A fase de §3.3/§15.6 `CoreStatus.phase`. `opening` é o próprio boot; quem muda para
   * `ready` é o fim do boot (ou a identidade chegando), para `draining` é o
   * `core.shutdown`/`close`, e `stopped` fecha.
   */
  #phase: 'boot' | 'awaiting-identity' | 'opening' | 'ready' | 'draining' | 'stopped' = 'boot';
  /** §6.1 — a escolha de presença local por comunidade; default derivado da identidade. */
  readonly localPresence = new Map<string, LocalPresence>();
  /** §24.1 — anexado pelo `bootCore` depois da construção (`null` = desligado). */
  logger: LoggerPort | null = null;
  /** §24.3 — o registro central que os desfechos da fila também alimentam. */
  metricsSink: { inc(name: string, by?: number): void } | null = null;
  /**
   * §17.3 — o STUN/TURN desta instalação, um por processo porque a socket é uma só. Nasce
   * na primeira comunidade hospedada que encontrar socket; `null` sem rede (suíte unitária)
   * ou com o DHT ainda desligado.
   */
  #mediaHost: MediaHost | null = null;
  /** §15.4 `diag.run` — `relayAvailable` é fato desta instalação, e o fato mora aqui. */
  get mediaHost(): MediaHost | null {
    return this.#mediaHost;
  }

  /**
   * O serviço de mídia do PROCESSO, criado sob demanda. Criar aqui, e não no boot, é o que
   * garante que ele exista quando há algo para servir: uma instalação que não hospeda nada e
   * não está em chamada nenhuma não abre porta nenhuma.
   *
   * **Dois chamadores desde §109**, e o segundo é o ponto de §31.15: uma comunidade
   * hospedada (§17.3) e uma conversa direta em chamada. O serviço é por **nó**, não por
   * comunidade — a socket é uma só, o `MediaServer` é um só, e o que distingue um escopo do
   * outro é o `turnSecret` registrado por id. Uma instalação que só tem DM passa a servir
   * STUN/TURN, que é exatamente o que "simétrico" quer dizer.
   */
  garantirMediaHost(): MediaHost | null {
    if (this.#mediaHost !== null) return this.#mediaHost;
    const tap = this.#deps.swarm.backend?.mediaSocket?.() ?? null;
    if (tap === null) return null;
    const media = new MediaHost(tap, 'comunidade');
    this.#mediaHost = media;
    // §17.3 (B27) — a perna do transporte da ponte par→endereço. O transporte pode já ter
    // anexado (comunidade que nasce depois do boot) ou ainda não; `onTransport` resolve os
    // dois casos e não deixa a ponte depender da ordem de subida.
    const jaTem = this.#transport;
    if (jaTem !== null) media.ligarEnderecos(jaTem);
    else this.onTransport((tr) => media.ligarEnderecos(tr));
    return media;
  }
  readonly #deps: BootDeps;
  readonly #open: Map<string, OpenCommunity>;
  readonly #dispatchers: Map<string, MediaDispatcher>;
  readonly #router: MediaRouter;
  readonly #now: () => number;
  readonly #onProjected = new Set<(communityId: string) => void>();
  readonly #onOpen = new Set<(communityId: string) => void>();
  #transport: CommunityTransport | null = null;
  readonly #onTransport = new Set<(transport: CommunityTransport) => void>();

  constructor(a: {
    deps: BootDeps;
    ipc: IpcServer;
    fanout: EventFanout;
    client: CommunityClient;
    succession: SuccessionService;
    search: SearchService;
    blobs: BlobManager;
    router: MediaRouter;
    dispatchers: Map<string, MediaDispatcher>;
    open: Map<string, OpenCommunity>;
  }) {
    this.#deps = a.deps;
    this.ipc = a.ipc;
    this.fanout = a.fanout;
    this.client = a.client;
    this.succession = a.succession;
    this.search = a.search;
    this.blobs = a.blobs;
    this.#router = a.router;
    this.#dispatchers = a.dispatchers;
    this.#open = a.open;
    this.#now = a.deps.now ?? Date.now;
  }

  /**
   * Um lote foi projetado nesta comunidade. Existe por causa de §14.3(3): o nó fecha os
   * canais já abertos para um par que acabou de ser banido, **no mesmo lote de projeção que
   * aplicou o ban**. Quem detém os canais é o transporte, e é ele que assina isto.
   */
  onProjected(cb: (communityId: string) => void): () => void {
    this.#onProjected.add(cb);
    return () => this.#onProjected.delete(cb);
  }

  /** @internal — chamado pelo `bootCore` no mesmo passo síncrono do fan-out do lote. */
  notifyProjected(communityId: string): void {
    for (const cb of this.#onProjected) cb(communityId);
  }

  /**
   * §24.1 — a porta `onOutcome` das outbox com o produtor de log na frente: cada desfecho
   * vira linha (`scope:'outbox'`, msg é o desfecho) e o counter de §24.3 acompanha; o
   * fan-out segue intacto, na mesma ordem (DS-31).
   */
  outboxOutcomePort(communityId: string): ReturnType<EventFanout['fromOutbox']> {
    const base = this.fanout.fromOutbox(communityId);
    return (ev) => {
      const d = ev.data as Record<string, unknown>;
      this.logger?.info('outbox', ev.topic.replace('message.', ''), {
        communityId,
        ...(typeof d.opId === 'string' ? { opId: d.opId } : {}),
        ...(typeof d.code === 'string' ? { code: d.code } : {}),
        ...(typeof d.seq === 'number' ? { seq: d.seq } : {}),
      });
      if (ev.topic === 'message.dropped') this.metricsSink?.inc('outbox.dropped');
      base(ev);
    };
  }

  /**
   * Uma comunidade nova entrou no runtime (`register`). O transporte assina para entrar no
   * tópico dela na hora — sem isso, uma comunidade que nasce depois do boot nunca seria
   * anunciada nem procurada.
   */
  onOpen(cb: (communityId: string) => void): () => void {
    this.#onOpen.add(cb);
    return () => this.#onOpen.delete(cb);
  }

  /**
   * O transporte real chega **depois** do boot (`startCommunityTransport` é de quem sobe o
   * processo). As superfícies que precisam dele — hoje, `invite.resolve`/`invite.redeem` —
   * esperam por este anexo; sem transporte, a admissão pela rede é impossível e responde
   * `E_HOST_UNAVAILABLE`.
   */
  /** O transporte já anexado, sem esperar. `null` sem rede (suíte unitária). */
  get transportOrNull(): CommunityTransport | null {
    return this.#transport;
  }

  attachTransport(transport: CommunityTransport): void {
    this.#transport = transport;
    this.#mediaHost?.ligarEnderecos(transport);
    for (const cb of this.#onTransport) cb(transport);
  }

  /** Transporte já anexado, ou o primeiro que anexar. Resolve `null` se fechar sem rede. */
  whenTransport(): Promise<CommunityTransport | null> {
    const atual = this.#transport;
    if (atual !== null) return Promise.resolve(atual);
    return new Promise((resolve) => {
      const desregistro = this.onTransport((t) => {
        desregistro();
        resolve(t);
      });
    });
  }

  onTransport(cb: (transport: CommunityTransport) => void): () => void {
    this.#onTransport.add(cb);
    return () => this.#onTransport.delete(cb);
  }

  communities(): readonly OpenCommunity[] {
    return [...this.#open.values()];
  }

  get(communityId: string): OpenCommunity | undefined {
    return this.#open.get(communityId);
  }

  /** §15.6 `query.voiceQueue` (§16.4) — o instantâneo efêmero da fila da comunidade. */
  snapshotFilaDe(communityId: string, channelId: string): ReturnType<MediaDispatcher['snapshotFila']> {
    return this.#dispatchers.get(communityId)?.snapshotFila(channelId) ?? null;
  }

  /**
   * Modo membro: (re)liga o canal de §16.1 com o host. O `RpcClient` nasce sem transporte —
   * fila e circuit breaker de §11.8 já cobrem a janela sem conexão —, e é isto que a fase do
   * transporte real chama quando o Hyperswarm entrega a conexão.
   */
  attachHostChannel(a: { communityId: string; transport: RpcTransportPort }): void {
    const c = this.#open.get(a.communityId);
    if (c?.rpc == null) throw new Error(`sem canal de membro para ${a.communityId}`);
    c.rpc.reattach(a.transport);
    // DR-29/DR-33 — o canal de §16.1 é a fonte do estado de conexão: anexo é `connecting`,
    // queda (avisada pelo MESMO transporte, que aceita vários ouvintes) vira
    // `reconnecting`/`offline` na máquina de §15.6.
    this.hostStatus?.channelAttached(a.communityId);
    a.transport.onDown(() => this.hostStatus?.channelDown(a.communityId));
    // §16.3 fluxo obrigatório — hello ANTES de qualquer outro método na conexão nova. A
    // queda anterior falhou os pendentes e esvaziou a fila, então este frame sai primeiro;
    // o loop de HELLO_INTERVAL_MS renova daí em diante.
    void this.#enviarHello(a.communityId).catch(() => {});
  }

  /**
   * §14.5/§16.3 — um `hello` para cada comunidade de MEMBRO com canal vivo: a resposta
   * alimenta `synced` (`markHello`), marca contato com o host (DR-29) e, com `opVersion`
   * incompatível, fecha o relacionamento como `incompatible` e derruba a fila
   * (`dropped/client-outdated`). É o corpo do loop `host.hello` de §22.1 (emendada).
   */
  renovarHelos(): void {
    for (const c of this.communities()) {
      if (!c.isHost) void this.#enviarHello(c.communityId).catch(() => {});
    }
  }

  async #enviarHello(communityId: string): Promise<void> {
    const c = this.#open.get(communityId);
    if (c === undefined || c.isHost || c.rpc === null) return;
    // Sem canal vivo não há tentativa real (§11.8): efêmero não enfileira no RpcClient.
    const estado = this.hostStatus?.statusOf(communityId) ?? 'unknown';
    if (estado !== 'online' && estado !== 'connecting') return;
    const corpo = new Uint8Array(
      Buffer.from(JSON.stringify({ clientVersion: this.#deps.foldBuildId, opVersion: OP_VERSION }), 'utf8'),
    );
    const r = await c.rpc.call('hello', corpo);
    if (!r.ok) {
      // §14.3(1)/§14.5 — o host RECUSOU o canal. É o único par a quem um membro abre canal
      // de §16.1, então "todos os pares recusaram" se resolve nele: o watchdog transiciona
      // para `unauthorized` e o evento `community.accessRevoked` dispara o passo de §18.4.
      // Sem isto, quem foi removido enquanto estava offline nunca saía de `reconnecting`.
      if (r.code === 'E_NOT_AUTHORIZED_FOR_COMMUNITY') {
        this.client.markUnauthorized(communityId, true);
        return;
      }
      // Falha de hello é falha de contato (§19.4): é o que tira a instalação do
      // `connecting` eterno quando a conexão morre sem o transporte perceber.
      this.hostStatus?.noteHelloFailure(communityId);
      return;
    }
    let parsed: { opVersion?: unknown };
    try {
      parsed = JSON.parse(Buffer.from(r.body).toString('utf8')) as typeof parsed;
    } catch {
      return;
    }
    if (parsed.opVersion !== OP_VERSION) {
      // §16.3 — somente-leitura naquela comunidade: status `incompatible` e fila inteira
      // `dropped/client-outdated`. Itens em voo recebem o mesmo motivo pelo desfecho do host.
      this.hostStatus?.noteSubmit(communityId, [{ ok: false, code: 'E_VERSION_UNSUPPORTED' }]);
      c.outbox?.discardForVersion();
      return;
    }
    this.client.markHello(communityId, this.#now());
    // O host RESPONDEU: é contato observado, com todas as consequências de §11.8.
    this.hostStatus?.markSeen(communityId);
  }

  /**
   * Modo host: uma conexão de membro autorizada (§14.3) vira um `RpcServer` com os métodos
   * de §16.2 e uma entrada no mapa conexão↔membro. É esse mapa que `peerSignalRelay`
   * consulta para achar a conexão do destinatário de `voice.signal` (§43.3).
   */
  /**
   * §14.3(1) — o canal do par NÃO autorizado. Ele existe só para dizer o código: nenhum
   * método é servido, nada replica, e é isso que dá desfecho a quem foi removido enquanto
   * estava offline (§18.4 segundo gatilho, §14.5 `unauthorized`).
   */
  attachRefusedConnection(a: { communityId: string; transport: RpcTransportPort }): void {
    const c = this.#open.get(a.communityId);
    if (c?.host == null) throw new Error(`${a.communityId} não é hospedada aqui`);
    wireRefusedCommunityRpc(new RpcServer({ protocol: 'community', transport: a.transport }));
  }

  attachMemberConnection(a: {
    communityId: string;
    peerKeyHex: string;
    transport: RpcTransportPort;
  }): { detach(): void } {
    const c = this.#open.get(a.communityId);
    if (c?.host == null) throw new Error(`${a.communityId} não é hospedada aqui`);
    const host = c.host;
    const server = new RpcServer({
      protocol: 'community',
      transport: a.transport,
      // §22.1 `voice.liveness` — pedido recebido é prova de vida do par.
      onRequest: () => host.vistoEm.set(a.peerKeyHex, this.#now()),
    });
    const hello: HelloInfo = {
      hostVersion: this.#deps.foldBuildId,
      opVersion: OP_VERSION,
      coreLength: c.core.length,
      memberCount: c.projector.ds.members.size,
      capabilities: [],
    };
    wireHostRpc(server, { admission: host.admission, hello });
    wireHostPresenceRpc(server, { communityId: a.communityId, peerKeyHex: a.peerKeyHex, presence: c.presence });
    wireHostMediaRpc(server, {
      peerKeyHex: a.peerKeyHex,
      stateFor: () => voiceStateOf(c.projector.ds),
      voice: host.voice,
      share: host.share,
      fila: host.fila,
      shareHealth: host.shareHealth,
      signal: peerSignalRelay((toPeerKeyHex) => this.#destinoDeSinal(a.communityId, toPeerKeyHex)),
    });
    host.connections.set(a.peerKeyHex, server);
    host.vistoEm.set(a.peerKeyHex, this.#now());
    // §17.6 — ocupação é NÍVEL, e este par não viu nenhuma das mudanças anteriores. Sem o
    // instantâneo de boas-vindas, quem abre o aplicativo com uma chamada já em curso vê a
    // sala vazia até alguém entrar ou sair: `voice.occupancyChanged` só é emitido por
    // mudança de roster, e §15.6 não dá produtor de ocupação a quem não hospeda (`RT-05`).
    for (const sessao of host.voice.activeSessions()) {
      const chaves = sessao.participants.map((p) => p.keyHex);
      // §16.4 — a fila também é NÍVEL: quem conecta no meio de um turno vê a fila como
      // ela está, não como estava quando a última mudança aconteceu.
      const estadoFila = host.fila.estadoDe(sessao.channelId);
      if (estadoFila.itens.length > 0 || estadoFila.turno !== null) {
        server.notify(
          'voice.queueChanged',
          new Uint8Array(
            Buffer.from(
              JSON.stringify({ channelId: sessao.channelId, ...filaParaOFio(estadoFila) }),
              'utf8',
            ),
          ),
        );
      }
      server.notify(
        'voice.occupancyChanged',
        new Uint8Array(
          Buffer.from(
            JSON.stringify({
              channelId: sessao.channelId,
              count: chaves.length,
              firstKeys: chaves.slice(0, VOICE_OCCUPANCY_FIRST_KEYS),
            }),
            'utf8',
          ),
        ),
      );
    }
    return {
      detach: () => {
        // Reconexão pode anexar o canal novo ANTES de o velho avisar que caiu: só o detach
        // da conexão corrente é queda de verdade. Sem esta guarda, um blip derrubaria da
        // chamada quem já tinha voltado.
        if (host.connections.get(a.peerKeyHex) !== server) return;
        host.connections.delete(a.peerKeyHex);
        host.vistoEm.delete(a.peerKeyHex);
        // §17.4 emendado (2026-08-26) — **queda de conexão é saída da chamada.** Este era o
        // caminho inteiro que faltava: o detach só esquecia o RPC, e o participante ficava
        // no roster do host para sempre. Quem desligou o computador continuava aparecendo
        // na chamada de quem ficou, sem nunca sair. O cliente já tratava a queda como fim
        // de sessão (`E_HOST_UNAVAILABLE` zera o estado local em `remoteMediaDispatcher`);
        // era o host que mantinha o fantasma.
        //
        // A ordem importa. §14.3(3) manda o lote que aplicou o ban FECHAR o canal do banido,
        // então a queda também é o desfecho de uma moderação — e nesse caso o motivo certo é
        // `moderation`, não `peer-gone`. Derivar do log primeiro é o que decide isso sem
        // depender da ordem em que os assinantes de `onProjected` correm.
        const estrutural = voiceStateOf(c.projector.ds);
        host.voice.sweepAgainst(estrutural);
        host.voice.dropPeer(a.peerKeyHex);
        // A saída do roster já reconcilia a tela pelo `onRosterChanged`; quem não estava em
        // chamada nenhuma mas apresentava (impossível hoje, mas barato de garantir) sai aqui.
        host.share.sweepAgainst(estrutural);
      },
    };
  }

  /**
   * §18.8 passo 5 — migração de rail com a arbitragem de L-16. A DESCOBERTA da continuação
   * é do transporte; aqui decide-se o que fazer com o core depois de descoberto.
   */
  migrateRail(a: { originCommunityId: string; continuation: { core: CoreHandle; projector: Projector }; ttlMs?: number }): ReturnType<typeof migrateRail> {
    const origem = this.#open.get(a.originCommunityId);
    if (origem === undefined) throw new Error(`origem ${a.originCommunityId} não está aberta aqui`);
    return migrateRail({
      client: this.client,
      originProjector: origem.projector,
      continuation: a.continuation,
      ttlMs: a.ttlMs ?? HOST_INACTIVITY_MS,
      now: this.#now,
    });
  }

  get phase(): 'boot' | 'awaiting-identity' | 'opening' | 'ready' | 'draining' | 'stopped' {
    return this.#phase;
  }

  /** @internal — a raiz de composição é quem conduz as fases de §3.3. */
  /**
   * §15.7 `capture.authorize` → `capture.decision` — a porta única do
   * `setDisplayMediaRequestHandler` do main (`T-41`). O main pergunta pelo `sessionId` e
   * **este** processo responde a partir do estado local: quem cunhou o `captureToken` é o
   * núcleo do apresentador e quem o verifica é ele mesmo (§17.4 emendado). Nenhuma ida ao
   * host acontece aqui — a autorização dele já aconteceu, e é o que fez a sessão existir.
   *
   * `sourceTypes` é a metade que §15.7 declara na resposta: sem decisão aprovada o main não
   * concede fonte nenhuma, e a captura nunca inicia.
   */
  authorizeCapture(a: { sessionId: string; kind?: 'screen' | 'music'; audio?: boolean }): { allowed: boolean; reason?: string; sourceTypes: readonly ('screen' | 'window')[]; audio: boolean } {
    const r = this.#router.authorizeCapture(a);
    if (r.allowed) return { allowed: true, sourceTypes: ['screen', 'window'], audio: r.audio };
    /*
     * §31.15 (emenda de 2026-09-03) — a tela de uma CONVERSA DIRETA.
     *
     * Aqui não há sessão de tela, não há `captureToken` e não há host que os emita: o
     * `sessionId` que o main declarou é o `conversationId`, pela mesma substituição que
     * §31.15 já faz em `dm.callJoin`. O que autoriza é o único fato local que existe — **eu
     * estou nesta chamada agora** —, e ele é exatamente tão forte quanto o token de §17.4
     * era: os dois são estado deste processo, e nenhum dos dois vai ao host.
     *
     * A ordem importa e é falha fechada: só se chega aqui depois de o roteador de
     * comunidade ter recusado, e uma conversa que não está em chamada cai no `reason` dele.
     */
    if (a.kind !== 'music' && this.dmCallAtivas?.().has(a.sessionId) === true) {
      // §17.5 (emenda de 2026-09-03) — o som segue a mesma regra da imagem, e numa conversa
      // direta não há cargo a consultar: o que autoriza as duas é a chamada estar de pé.
      return { allowed: true, sourceTypes: ['screen', 'window'], audio: a.audio === true };
    }
    return { allowed: false, reason: r.reason, sourceTypes: [], audio: false };
  }

  /**
   * As conversas diretas em que este nó está em chamada agora (§31.15). Ligada pela raiz de
   * composição quando o runtime de DM existe; ausente, a tela de DM simplesmente não
   * autoriza — que é o desfecho correto para uma instalação sem conversa nenhuma.
   */
  dmCallAtivas: (() => ReadonlySet<string>) | null = null;

  setPhase(p: 'boot' | 'awaiting-identity' | 'opening' | 'ready' | 'draining' | 'stopped'): void {
    this.#phase = p;
  }

  /** §6.1/§15.4 — `identity.setPresence` fixa o status que o refresh publica. */
  setLocalPresence(status: LocalPresence): void {
    for (const c of this.#open.keys()) this.localPresence.set(c, status);
  }

  /**
   * §15.4 `core.shutdown` / §18.7 — o draining com orçamento.
   *
   * **A barreira é por confirmação de PARES (B10, fechado em 2026-08-28).** A redação
   * anterior esperava sinais locais — fila vazia e projeção na cabeça — e devolvia
   * `replicatedTo = interpretedSeq`. Os dois são verdadeiros e nenhum dos dois é o que
   * §18.7 passo 2 pede: "o host permanece no swarm até que `min(3, memberCount − 1)` pares
   * confirmem `core.length` igual à cabeça". "A op está no meu disco" e "a op sobreviveu a
   * esta máquina desligar" são afirmações diferentes, e o modal de U-06 mostrava a primeira
   * chamando-a de segunda.
   *
   * A evidência não é sinal novo no fio: o `replicator` do hypercore já mantém, por par, o
   * bitfield do que ele anunciou ter (`replicationConfirmations`). Contígua e não
   * `remoteLength`, porque quem interessa é quem consegue INTERPRETAR até a cabeça — um par
   * com buraco no meio não interpreta nada depois dele (§10.5 passo 6).
   *
   * O que NÃO muda: o orçamento continua vencendo a barreira (`DRAIN_BUDGET_MS`, default
   * 5 000). Segurar o fechamento indefinidamente é pior — o usuário mata o processo e nada
   * é gravado. Uma comunidade sem par a quem replicar (`memberCount ≤ 1`) tem alvo zero e
   * não segura ninguém.
   */
  async shutdown(a: { readonly budgetMs?: number }): Promise<{ drainedMs: number; pendingOps: number; replicatedTo: number }> {
    const now = this.#now;
    const inicio = now();
    this.setPhase('draining');
    const prazo = inicio + (a.budgetMs ?? 5_000);
    // Um giro de flush antes da espera: sem canal vivo o membro não tenta (§11.8) e a fila
    // permanece — o desfecho honesto é o contador de pendentes.
    for (const c of this.communities()) await c.outbox?.flush().catch(() => {});
    while (this.#now() < prazo) {
      let pendentes = 0;
      let atraso = false;
      let faltaConfirmacao = false;
      for (const c of this.#open.values()) {
        pendentes += this.#deps.manifest.countActive(c.communityId);
        if (c.projector.interpretedSeq < c.core.length - 1) atraso = true;
        if (this.confirmacoesDe(c) < this.alvoDeConfirmacoes(c)) faltaConfirmacao = true;
      }
      if (pendentes === 0 && !atraso && !faltaConfirmacao) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    let pendingOps = 0;
    // `replicatedTo` é a PIOR confirmação entre as comunidades abertas: com duas
    // hospedadas, dizer o melhor número esconderia a que não replicou.
    let replicatedTo = Number.MAX_SAFE_INTEGER;
    for (const c of this.#open.values()) {
      pendingOps += this.#deps.manifest.countActive(c.communityId);
      replicatedTo = Math.min(replicatedTo, this.confirmacoesDe(c));
    }
    if (replicatedTo === Number.MAX_SAFE_INTEGER) replicatedTo = 0;
    const drainedMs = Math.max(0, now() - inicio);
    await this.close();
    this.setPhase('stopped');
    return { drainedMs, pendingOps, replicatedTo };
  }

  /** §18.7 passo 2 — quantos pares já têm o log contíguo até a cabeça desta comunidade. */
  confirmacoesDe(c: OpenCommunity): number {
    return c.core.replicationConfirmations?.(c.core.length) ?? 0;
  }

  /** §18.7 passo 2 — o alvo de confirmações desta comunidade, `min(3, memberCount − 1)`. */
  alvoDeConfirmacoes(c: OpenCommunity): number {
    return alvoDeReplicacao(membrosAtivos(c));
  }

  /** §18.7 passo 1 — "quantas operações ainda não replicaram", o número do modal de U-06. */
  opsNaoReplicadas(c: OpenCommunity): number {
    return opsForaDaBarreira({
      length: c.core.length,
      alvo: this.alvoDeConfirmacoes(c),
      confirmam: (n) => c.core.replicationConfirmations?.(n) ?? 0,
    });
  }

  /** §3.3 `draining`/`stopped` — para os temporizadores e fecha os cores abertos aqui. */
  /**
   * §17.4 — o destino de uma sinalização pode ser **o próprio host**.
   *
   * `connections` é o mapa dos RPC servers REMOTOS: quem está nele é par que abriu conexão
   * com esta instalação. O host não abre conexão consigo mesmo, então procurá-lo ali devolve
   * `null` e a sinalização morre com `E_PEER_UNREACHABLE` — o que na prática deixava a
   * negociação WebRTC só de ida (host→membro entregava, membro→host não), e nenhuma chamada
   * fechava. Achado no teste de duas máquinas de §77.
   *
   * Quando o destino é esta identidade, o "notify" é a emissão local: o mesmo evento de
   * §15.5 que o renderer já escuta, pelo fan-out em vez do fio.
   */
  #destinoDeSinal(communityId: string, toPeerKeyHex: string): { notify(topic: string, body: Uint8Array): boolean } | null {
    const eu = this.#deps.identity()?.publicKey.toString('hex') ?? null;
    if (eu !== null && toPeerKeyHex === eu) {
      return {
        notify: (topic, body) => {
          try {
            const data = JSON.parse(Buffer.from(body).toString('utf8')) as Record<string, unknown>;
            this.fanout.emit({ topic, data: { communityId, ...data } }, { communityId });
            return true;
          } catch {
            return false;
          }
        },
      };
    }
    const c = this.#open.get(communityId);
    return c?.host?.connections.get(toPeerKeyHex) ?? null;
  }

  async close(): Promise<void> {
    if (this.#phase !== 'stopped' && this.#phase !== 'draining') this.setPhase('draining');
    // §17.3 — devolve a socket ao DHT antes de qualquer outra coisa: o classificador está no
    // caminho de TODO datagrama, e um núcleo em `draining` não deve continuar nele.
    this.#mediaHost?.close();
    this.#mediaHost = null;
    // §10.6 — snapshot no `draining`, antes de qualquer fechamento: é cache (perder custa
    // tempo de boot, nunca dado), mas custar tempo sem necessidade também é bug.
    for (const c of this.#open.values()) {
      try {
        c.projector.snapshot(this.#now());
      } catch {
        // Sem snapshot o boot reinterpreta do zero — comportamento correto, não falha.
      }
    }
    for (const c of this.#open.values()) {
      c.stop();
      await c.core.close();
    }
    this.#open.clear();
    // §22.5 — nenhum job sobrevive ao fechamento do escopo dele.
    this.jobs?.stop();
    this.jobs = null;
    this.loops?.stop();
    this.loops = null;
    this.hostStatus?.stop();
    // §31 — o fio, os projetores das conversas e os cores de DM saem antes dos blobs, pela
    // mesma ordem do resto: rede primeiro, disco depois.
    await this.dm?.close();
    this.dm = null;
    await this.blobs.close();
    this.client.close();
    // §15.1 — solta os prazos de `IPC_STALE_MS` ainda armados nas assinaturas vivas.
    this.ipc.close();
    this.setPhase('stopped');
  }

  /** @internal — usado pelo `bootCore` e por quem abre comunidade depois do boot. */
  register(c: OpenCommunity): void {
    this.#open.set(c.communityId, c);
    this.#dispatchers.set(c.communityId, c.dispatcher);
    for (const cb of this.#onOpen) cb(c.communityId);
  }

  /** Saída local de §11.1 (exceção) — a comunidade deixa de estar aberta aqui. */
  forget(communityId: string): void {
    const c = this.#open.get(communityId);
    if (c === undefined) return;
    // Desligar da rede ANTES de soltar a comunidade. Sem isto, os aceitadores `p2p-community/1`
    // dela continuavam registrados nos muxes vivos: um par ainda conectado abria o canal, o
    // `attachMemberConnection` recusava com "não é hospedada aqui" DENTRO do `mux.pair` — e
    // o throw nasce no processamento do stream, com o processo inteiro no caminho. É o mesmo
    // recorte de `desligarDaRede` (§18.4 passo 1), que fecha canais e purga os aceitadores.
    this.transportOrNull?.leaveCommunity(communityId);
    c.stop();
    this.#open.delete(communityId);
    this.#dispatchers.delete(communityId);
    this.hostStatus?.forget(communityId);
    this.#router.forget(communityId);
  }

  /**
   * Abre uma comunidade pela linha de `manifest.communities` (§3.3 fases `open` +
   * `host-mode`) e devolve-a **sem registrá-la** — o chamador decide (`register`).
   *
   * Era um closure dentro do `bootCore`; virou método porque uma comunidade que nasce
   * depois do boot — por `community.create`, por `invite.redeem`, e também a continuação
   * de §18.8 quando descoberta — precisa deste mesmo caminho sem reiniciar o processo.
   */
  async openCommunity(row: CommunityRow): Promise<OpenCommunity> {
    const deps = this.#deps;
    const now = this.#now;
    const communityId = row.community_id;
    const isHost = row.is_host === 1;
    const coresDir = path.join(deps.dataDir, 'cores');
    const captureTokenTtlMs = deps.captureTokenTtlMs ?? MEDIA_TICKET_TTL_MS;
    const identidade = deps.identity();
    const selfKeyHex = (): string | null => identidade?.publicKey.toString('hex') ?? null;
    const seedPort = manifestCommunitySeedPort(deps.manifest, deps.dataKey);
    const seed = isHost ? seedPort(communityId) : null;
    const keyPair = seed === null ? null : deriveCommunityKeyPairs(seed).log;

    const core =
      deps.openCore !== undefined
        ? await deps.openCore({ communityId, coreKey: row.core_key, keyPair })
        : keyPair !== null
          ? await openWritableCore(path.join(coresDir, communityId), keyPair)
          : await openCore(path.join(coresDir, communityId), row.core_key);

    // §38.2 — o `notify` do lote, depois do commit, entra no fan-out sem intermediário.
    const projector = new Projector(deps.view, core, {
      foldBuildId: deps.foldBuildId,
      now,
      onEvent: (events) => {
        this.fanout.fromProjector(events);
        // §14.3(3) — no MESMO passo do lote: quem projetou o ban fecha o canal do banido.
        this.notifyProjected(communityId);
      },
    });
    await projector.boot();
    // §10.5 passo 6 — só a partir daqui o projector reage a `append`. Sem esta linha o
    // núcleo interpreta o log do boot e depois fica surdo: é a ligação, não o módulo.
    projector.start();

    let outbox: Outbox | null = null;
    let rpc: RpcClient | null = null;
    let host: HostSide | null = null;
    let dispatcher: MediaDispatcher;
    // §17.4 — o roster muda no branch de host (acima do runtime de mídia, que depende do
    // `dispatcher`); o holder é o que permite renovar ticket no instante em que um par
    // entra, em vez de esperar a cadência de `MEDIA_TICKET_TTL_MS / 3`.
    const renovarTickets = { agora: (): void => {} };
    // §17.5/A19 — a tela vive dentro da chamada. Quando o roster da voz muda (entrada,
    // saída, queda de conexão, revogação), a sessão de tela precisa ser reconferida contra
    // ele: apresentador que saiu da chamada não continua apresentando. Mesmo motivo do
    // holder acima — `share` nasce depois do `voice`.
    const conciliarTela = { agora: (): void => {} };
    const paradas: Array<() => void> = [];

    // §13.1/§19.1 passo 3 — o core de blobs LOCAL desta comunidade é **derivado** da
    // identidade (`ns/memberblobs/1' ‖ identitySeed ‖ communityId`); a linha
    // `member_blobs_core` (§10.2) guarda a mesma semente cifrada pela Data Key como atalho
    // e verificação cruzada. Derivar é o que torna o core recuperável só com o backup de
    // §5.5, que nunca carregou esta semente. Quem tem o core anuncia o tópico de §14.1 e o
    // replica nos muxes vivos; falha aqui não derruba a comunidade — anexo é subsistema
    // dela, não o log.
    const linhaBlobs = deps.manifest.getMemberBlobsCore(communityId);
    const sementeGravada =
      linhaBlobs === null ? null : aeadOpenPacked(Buffer.from(linhaBlobs.secretSeedEnc), deps.dataKey);
    const sementeBlobs =
      identidade !== null
        ? memberBlobsKeyPairFor(identidade, communityId).seed
        : sementeGravada !== null && sementeGravada.length === 32
          ? sementeGravada
          : null;
    // A chave a bater é a que o log publicou em `member.join`/`member.setBlobsCore` — dado
    // de réplica, não local. A linha do manifest é a cópia usada enquanto o log desta
    // instalação ainda não tem a entrada do próprio (comunidade recém-criada no mesmo tick).
    const chaveDeBlobsPublicada = ((): Buffer | null => {
      const eu = selfKeyHex();
      const doLog = eu === null ? undefined : projector.ds.members.get(eu)?.blobsCoreKey;
      if (doLog !== undefined) return Buffer.from(doLog);
      return linhaBlobs === null || linhaBlobs.coreKey.length !== 32 ? null : Buffer.from(linhaBlobs.coreKey);
    })();
    if (sementeBlobs !== null) {
      try {
        const writer = await blobCorePorts(coresDir).openWriter(sementeBlobs);
        // A chave derivada TEM que ser a que o log publicou; divergência é corrupção local
        // (ou dado de instalação anterior à derivação) — não escrever em core algum com ela.
        if (chaveDeBlobsPublicada !== null && writer.key.equals(chaveDeBlobsPublicada)) {
          this.blobs.attachLocalCore(communityId, writer);
          // Reescreve o atalho quando ele faltava ou estava ilegível: a linha é derivada da
          // identidade, então recriá-la é reparo local — é este caminho que devolve os
          // anexos a quem restaurou a identidade sem o `manifest.db` (§5.5).
          if (linhaBlobs === null || sementeGravada === null) {
            deps.manifest.setMemberBlobsCore({
              communityId,
              coreKey: writer.key,
              secretSeedEnc: aeadSealPacked(sementeBlobs, deps.dataKey),
            });
          }
          paradas.push(() => {
            void this.blobs.detachLocalCore(communityId);
          });
        } else {
          await writer.close().catch(() => {});
        }
      } catch {
        // Sem core de blobs local, `blob.stage` recusa (`E_NO_BLOBS_KEY`) e o resto segue.
      }
    }

    const observacao = {
      observedOp: (id: string) => projector.observedOp(id),
      watermark: (item: { readonly sequence_scope: string }) => {
        const eu = identidade;
        return eu === null ? -1 : projector.authorWatermark(eu.publicKey, item.sequence_scope);
      },
      interpretedSeq: () => projector.interpretedSeq,
      resolveTarget: envelopeTargetResolver(),
    };

    // §6.16/§17.6 — presença e digitando desta comunidade. O push do host é injetado por
    // indireção porque `empurra` nasce só no ramo hospedeiro; no membro os deltas chegam
    // prontos por §16.3 e são INGERIDOS abaixo, não reemitidos (o runtime de mídia já
    // encaminha esses tópicos ao fan-out — duplicar seria evento repetido).
    let empurraPresenca: ((topic: string, data: Record<string, unknown>, alvos: readonly string[] | null) => void) | null = null;
    const presence = new PresenceManager({
      clock: { now },
      isHost: () => isHost,
      onPresenceChanged: (delta: PresenceDelta) => {
        // §17.6 — o delta tem duas metades: quem mudou e quem SAIU. Mandar só `entries`
        // fazia o membro esquecer quem saiu apenas pelo TTL de 45 s.
        empurraPresenca?.('presence.changed', { entries: delta.entries, removed: delta.removed }, null);
      },
      onTypingChanged: (delta: TypingDelta) => {
        // §17.6 — typing NÃO é broadcast de comunidade: vai só a quem chamou
        // `subscribeChannel` naquele canal.
        const assinantes = presence.getTypingSubscribers(communityId, delta.channelId);
        empurraPresenca?.('typing.changed', { channelId: delta.channelId, identityKeys: delta.identityKeys }, assinantes);
      },
    });

    if (isHost && keyPair !== null && 'append' in core) {
      // ── Modo host: as decisões de §17.4/§17.5 são tomadas aqui ──────────────────────
      const admission = new HostAdmission({
        core: core as WritableCoreHandle,
        state: projector.ds,
        makeHostRecord: hostRecordSigner(keyPair.secretKey),
        now,
      });
      const connections = new Map<string, RpcServer>();
      /**
       * §22.1 `voice.liveness` — quando cada par falou pela última vez. Todo pedido do
       * membro renova a marca (o `hello` de 30 s garante o piso); o loop derruba da chamada
       * quem passou do prazo. É o que cobre o caso em que o transporte NÃO percebe a queda:
       * computador desligado no meio da chamada não manda FIN nenhum.
       */
      const vistoEm = new Map<string, number>();
      /**
       * §17.6 — `voiceOccupancy` é declarado "emitido a cada mudança, **coalescido em 1 s**",
       * e a janela nunca existiu: o host emitia por mudança de roster, para TODA a comunidade
       * conectada. Uma saída em massa (host que volta, ou a varredura de vivacidade de §17.4
       * pegando vários de uma vez) vira um evento por participante.
       *
       * A janela é de borda de ATAQUE: a primeira mudança sai na hora — atrasar por um
       * segundo o avatar de quem acabou de entrar seria trocar um defeito por outro — e as
       * seguintes esperam o fim da janela, quando sai só o ÚLTIMO estado. Ocupação é nível,
       * não sequência: quem chega no meio da janela só precisa do valor final.
       */
      const ocupacaoPendente = new Map<string, { count: number; firstKeys: readonly string[] }>();
      const ocupacaoAgendada = new Map<string, unknown>();
      const agendarOcupacao = deps.schedule ?? ((f: () => void, ms: number) => setTimeout(f, ms));
      const cancelarOcupacao = deps.cancel ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
      const empurra = (topic: string, data: Record<string, unknown>, paraKeys: readonly string[] | null): void => {
        const body = new Uint8Array(Buffer.from(JSON.stringify(data), 'utf8'));
        for (const [keyHex, server] of connections) {
          if (paraKeys !== null && !paraKeys.includes(keyHex)) continue;
          // §16.3 regra 1: at-most-once. `notify` devolvendo `false` (teto de frame, regra
          // 3, ou conexão caída) não vira fila nem retentativa.
          server.notify(topic, body);
        }
        // O host também é destinatário: ele participa da chamada como qualquer membro.
        this.fanout.emit({ topic, data: { communityId, ...data } }, { communityId });
      };
      /**
       * A metade de §17.6 que faltava: emite na borda de ataque e, dentro da janela de
       * `VOICE_OCCUPANCY_COALESCE_MS`, guarda só o último estado daquele canal.
       */
      const empurraOcupacao = (channelId: string, count: number, firstKeys: readonly string[]): void => {
        if (ocupacaoAgendada.has(channelId)) {
          ocupacaoPendente.set(channelId, { count, firstKeys });
          return;
        }
        empurra('voice.occupancyChanged', { channelId, count, firstKeys }, null);
        const handle = agendarOcupacao(() => {
          ocupacaoAgendada.delete(channelId);
          const ultimo = ocupacaoPendente.get(channelId);
          if (ultimo === undefined) return;
          ocupacaoPendente.delete(channelId);
          // O fim da janela reabre a próxima: emitir por aqui é de novo borda de ataque.
          empurraOcupacao(channelId, ultimo.count, ultimo.firstKeys);
        }, VOICE_OCCUPANCY_COALESCE_MS);
        ocupacaoAgendada.set(channelId, handle);
      };
      paradas.push(() => {
        for (const h of ocupacaoAgendada.values()) cancelarOcupacao(h);
        ocupacaoAgendada.clear();
        ocupacaoPendente.clear();
      });
      // §16.3/§17.6 — o push de presença/digitando usa a mesma disciplina do resto da mídia.
      empurraPresenca = empurra;
      const turnSecret = deps.hostTurnSecret(communityId);
      // §16.4 (emenda de 2026-08-28) — a fila de karaokê: efêmera como o roster, mesma
      // vida da sessão. Toda mudança sai por `voice.queueChanged` a TODOS os conectados
      // (a fila é visível a quem assiste de fora) e ao renderer daqui, que é NÍVEL — o
      // instantâneo de boas-vindas acontece em `attachMemberConnection`.
      const fila = new FilaKaraoké({
        clock: { now },
        duracaoTurnoDe: (channelId) => {
          const canal = projector.ds.channels.get(channelId);
          return canal?.queueTurnSeconds ?? 300;
        },
        aoMudar: (channelId, estado) => {
          // O fio fala os nomes de §15.5 ({open, items, turn}); o estado interno é o do
          // módulo. Espalhar os nomes internos fez o renderer descartar o evento por
          // forma — "Entrar na fila" funcionava no host e a tela nunca ficava sabendo.
          empurra('voice.queueChanged', { channelId, ...filaParaOFio(estado) }, null);
          // §16.4 — a troca de turno aplica no roster NO ATO: abre o mic do titular novo
          // e silencia quem perdeu a vez. Guardado pelo modo: a fila sobrevive a uma
          // troca de modo para livre, e impor turno num canal livre mutaria todo mundo.
          const canal = projector.ds.channels.get(channelId);
          if (canal?.speechMode !== SPEECH_MODE.queue) return;
          voice.imporTurno(channelId, estado.turno?.keyHex ?? null);
        },
      });
      const voice = new VoiceHostSessions({
        hostSecretKey: identidade?.secretKey ?? Buffer.alloc(64),
        hostTurnSecret: turnSecret,
        // §17.3 — o STUN do host, na socket que o UDX já mantém aberta. Sem serviço de
        // mídia (suíte unitária, ou DHT ainda não ligado) a lista vai vazia, que é a
        // situação de L-11: só conexão direta.
        iceServers: () => this.#mediaHost?.iceServers() ?? [],
        clock: { now },
        ttlMs: MEDIA_TICKET_TTL_MS,
        isVoiceChannelType: (type) => type === CHANNEL_TYPE.voice,
        // §17.4 (emenda de 2026-08-28, R-29) — o gate do modo de fala. As constantes do
        // modo são do fold e a fila de §16.4 é efêmera deste host; quem tem as duas pontas
        // é esta raiz, e é aqui que a resposta é montada. No modo fila, só o titular
        // transmite — a mesma máquina de estados que a UI vê é a que gateia o voiceState.
        canTransmit: ({ state, channelId, memberKeyHex }) => {
          const canal = state.channels.get(channelId);
          if (canal === undefined) return true; // o join já recusou canal inexistente
          if (canal.speechMode === SPEECH_MODE.admins) {
            return memberHasPermission(state, memberKeyHex, 'voice_mute_others');
          }
          if (canal.speechMode === SPEECH_MODE.queue) {
            return fila.titularDe(channelId) === memberKeyHex;
          }
          return true;
        },
        onRosterChanged: (snapshot: RosterSnapshot) => {
          const alvos = snapshot.participants.map((p) => p.keyHex);
          // §16.4 — a fila é da SESSÃO: quem saiu do roster sai dela junto. O único
          // chamador de `fila.sair` era o comando explícito do próprio usuário, então
          // banido, expulso, quem saiu por `voiceLeave` e quem simplesmente desligou o
          // computador continuavam na fila — e, como titulares, silenciavam o canal inteiro
          // por imposição de turno até o prazo vencer, promovendo o fantasma seguinte.
          fila.reconciliar(snapshot.channelId, new Set(alvos));
          empurra('voice.roster', { sessionId: snapshot.sessionId, channelId: snapshot.channelId, participants: snapshot.participants }, alvos);
          // §15.5 `voice.occupancyChanged` — declarado para "alimentar a sidebar" (RT-05) e
          // nunca implementado: quem NÃO está na chamada não via ninguém no canal de voz
          // até entrar. Vai para TODA a comunidade (`null`), porque a ocupação é do canal,
          // não da sessão — e é justamente quem está de fora que precisa dela.
          empurraOcupacao(snapshot.channelId, snapshot.participants.length, alvos.slice(0, VOICE_OCCUPANCY_FIRST_KEYS));
          // Par novo no roster precisa de ticket AGORA: sem ele o cliente não oferta
          // (§17.4 passo 4) e a chamada não fecha. Achado no smoke de §78.
          renovarTickets.agora();
          // E quem saiu da chamada deixa de ser apresentador ou audiência (§17.5, A19).
          conciliarTela.agora();
        },
        onRevoked: (targets: readonly RevokedTarget[]) => {
          // §19.8 — "o host encerra a sessão de voz imediatamente, emitindo
          // `voice.failed{reason:'channel-deleted'}` **e** `voice.revoked` a cada
          // participante". A segunda metade existia; a primeira, não.
          //
          // O motivo sai ANTES das revogações, e a ordem é a coisa toda: os dois eventos são
          // o mesmo encerramento, o `voice.revoked` do próprio alvo derruba a chamada na
          // tela, e uma chamada já derrubada não tem mais onde mostrar o porquê. Invertido,
          // o motivo chegaria a uma superfície que acabou de fechar.
          const fim = targets.find((t) => t.reason === 'channel-deleted' || t.reason === 'community-ended');
          if (fim !== undefined) empurra('voice.failed', { reason: fim.reason, sessionId: fim.sessionId }, fim.recipients);
          for (const t of targets) {
            // §17.3/§17.4 — a revogação fecha o **transporte**, não só a sinalização. Os
            // dois caminhos relayados que não autenticam (ChannelData de saída, entrada
            // pela porta relayada) só conferiam `alloc.permissions`, que nunca era podada:
            // o banido seguia recebendo e mandando mídia pelo relay do host, na cota dele,
            // até a alocação vencer sozinha em `TURN_ALLOC_TTL_MS`.
            this.#mediaHost?.revogar(t.targetKeyHex);
            // §17.4 — **a todos os participantes**, não só ao alvo. Quem fica é quem tem de
            // fechar a `RTCPeerConnection` com a chave revogada; mandando só ao alvo, o
            // banido saía da lista do host e continuava recebendo mídia de todo mundo, que
            // é exatamente o `T-32` que a seção diz fechar. `recipients` é a sessão no
            // instante da remoção, calculada em L2.
            empurra('voice.revoked', { targetKey: t.targetKeyHex, sessionId: t.sessionId }, t.recipients);
          }
        },
      });
      // O serviço de mídia é do PROCESSO; a comunidade só se registra nele. Criar aqui, e
      // não no boot, é o que garante que ele exista quando há algo para servir: uma
      // instalação que não hospeda nada não abre porta nenhuma.
      this.garantirMediaHost()?.registrar({ communityId, voice, turnSecret });

      const share = new ShareHostSessions({
        hostSecretKey: identidade?.secretKey ?? Buffer.alloc(64),
        clock: { now },
        ttlMs: MEDIA_TICKET_TTL_MS,
        captureTokenTtlMs,
        isVoiceChannelType: (type) => type === CHANNEL_TYPE.voice,
        voiceParticipants: (channelId) => {
          const session = voice.sessionOf(channelId);
          return session === null ? null : new Set(session.participants.map((p) => p.keyHex));
        },
        /**
         * §17.5 — a revogação de UM espectador. O módulo a emite desde a fase 8 e a
         * composição nunca ligou o callback: quem perdia a autorização de assistir não
         * recebia sinal nenhum. `share.stopped` é da sessão inteira e `share.viewersChanged`
         * leva só a contagem — nenhum dos dois diz "acabou para VOCÊ". `share.failed` é o
         * tópico que §15.5 declara para isso, e agora está na tabela fechada de §16.3.
         */
        onRevoked: (targets: readonly ShareRevokedTarget[]) => {
          for (const t of targets) {
            empurra('share.failed', { sessionId: t.sessionId, reason: 'revoked' }, [t.targetKeyHex]);
          }
        },
        onSessionEvent: (ev: ShareSessionEvent) => {
          const alvos = destinatariosDaTela(voice, ev);
          if (ev.kind === 'started') {
            // §6.16 — o `sharing` do roster. O campo estava no contrato e ninguém o
            // escrevia: quem apresentava perdia o ícone no primeiro roster que passasse, e
            // com ele a confirmação de saída de §11 (C11). A sessão de tela é do host, e é
            // aqui que ela nasce.
            voice.setSharing(ev.channelId, ev.presenterKeyHex, true);
            empurra('share.started', { sessionId: ev.sessionId, presenterKey: ev.presenterKeyHex, channelId: ev.channelId }, alvos);
          } else if (ev.kind === 'viewersChanged') {
            empurra('share.viewersChanged', { sessionId: ev.sessionId, viewerCount: ev.viewerCount }, alvos);
            // §15.5 manda só a CONTAGEM, e quem apresenta precisa das CHAVES para abrir o
            // envio de cada um. `share.health` é o único evento que as carrega, e é só ao
            // apresentador (RT-08) — disparar o tick aqui entrega a audiência nova de
            // imediato, em vez de deixar quem entrou esperando até 2 s pela cadência.
            saude.tick(now());
          } else {
            // A marca do roster cai junto com a sessão — inclusive quando quem a derrubou
            // foi o host (moderação, canal apagado, varredura de §17.5).
            voice.setSharing(ev.channelId, ev.presenterKeyHex, false);
            // §16.3 declara `{sessionId, presenterKey, channelId}` no MESMO quadro de
            // `share.started`. Mandar só o id obrigava o renderer a adivinhar de qual
            // sessão se tratava quando há tela em mais de um canal.
            empurra('share.stopped', { sessionId: ev.sessionId, presenterKey: ev.presenterKeyHex, channelId: ev.channelId }, alvos);
          }
          this.#router.observeSession(communityId, ev.sessionId);
        },
      });
      // §12 — a superfície de convites é do hospedeiro: challenge, preview, resgate e a
      // conciliação dos anúncios na DHT (§12.2 passo 3), reavaliada a cada lote projetado.
      const invites = new InviteManager({
        communityId,
        swarm: deps.swarm,
        manifest: deps.manifest,
        hostAdmission: admission,
        getDecisionState: () => projector.ds,
        hostPublicKey: identidade?.publicKey ?? Buffer.alloc(32),
        clock: { now },
        preMemberBudget: deps.swarm.budget.preMemberBudget,
      });
      // §17.5/§17.6 — a saúde da tela. O monitor já existia e era testado, mas ninguém o
      // instanciava: `share.health` estava na tabela de §15.5 e na de §16.3 e **nenhuma
      // linha do produto o emitia**. Sem ele, o `share.setQuality` de um espectador não
      // alcança o apresentador e a qualidade por espectador de §17.5 é inerte — o F-08/V-13
      // que a spec dá por fechado. É o mesmo defeito de §82.3: superfície declarada, ponta
      // solta.
      //
      // "**Só ao apresentador**" (RT-08) é levado a sério aqui: `empurra` emite ao fan-out
      // local incondicionalmente, então usá-lo mandaria os números de saúde da sessão de
      // outra pessoa ao renderer de quem hospeda. Esta porta escolhe UMA perna — a conexão
      // do apresentador, ou o fan-out local quando o apresentador é quem hospeda.
      const saude = new ShareHealthMonitor({
        sessions: share,
        onHealth: (snapshots) => {
          for (const snap of snapshots) {
            const sessao = share.snapshotOf(snap.sessionId);
            if (sessao === null) continue;
            const data = {
              sessionId: snap.sessionId,
              viewers: snap.viewers.map((v) => ({
                key: v.keyHex,
                // Omitidos enquanto o apresentador não mediu este espectador (§17.5): a UI
                // mostra "—" em vez de fingir 0 ms.
                ...(v.rttMs !== undefined ? { rttMs: v.rttMs } : {}),
                ...(v.lossPct !== undefined ? { lossPct: v.lossPct } : {}),
                quality: v.quality,
              })),
            };
            if (sessao.presenterKeyHex === selfKeyHex()) {
              this.fanout.emit({ topic: 'share.health', data: { communityId, ...data } }, { communityId });
              continue;
            }
            connections
              .get(sessao.presenterKeyHex)
              ?.notify('share.health', new Uint8Array(Buffer.from(JSON.stringify(data), 'utf8')));
          }
        },
      });
      // A cadência é da composição (§17.6: 2 s); o monitor só consolida. Tick sem amostra
      // nenhuma é no-op barato — ele poda sessão morta e não emite.
      const relogioDaSaude = agendarIntervalo(() => saude.tick(now()), saude.tickMs, deps);
      paradas.push(relogioDaSaude);

      host = { admission, voice, share, shareHealth: saude, connections, invites, vistoEm, fila };
      // Fecha o laço da tela: `share` só existe agora, e o roster (lá em cima) precisa
      // reconferi-lo a cada mudança.
      conciliarTela.agora = () => {
        share.sweepAgainst(voiceStateOf(projector.ds));
      };
      // §17.4/§19.8 — a revogação derivada do log. `sweepAgainst` existia nos dois módulos,
      // com teste, e **nunca era chamado em produção**: nenhum ponto da composição o ligava
      // ao lote projetado. Ban, kick, timeout, `channel.delete` e o fim da comunidade não
      // alcançavam mídia nenhuma — a sessão sobrevivia ao ban indefinidamente, que é o
      // defeito de v1 que §17.4 diz ter fechado.
      paradas.push(
        this.onProjected((cid) => {
          if (cid !== communityId) return;
          const estrutural = voiceStateOf(projector.ds);
          voice.sweepAgainst(estrutural);
          share.sweepAgainst(estrutural);
        }),
      );
      dispatcher = localMediaDispatcher({
        voiceStateFor: (cid) => (cid === communityId ? voiceStateOf(projector.ds) : null),
        selfKeyHex,
        currentSessionId: () => voice.currentSessionOf(selfKeyHex() ?? '')?.sessionId ?? null,
        host: voice,
        share,
        fila,
        shareHealth: saude,
        captureTokenTtlMs,
        deliverSignal: peerSignalRelay((toPeerKeyHex) => this.#destinoDeSinal(communityId, toPeerKeyHex)).deliver,
      });
      // §11.2 — fila durável também em modo host: quem escreve na própria comunidade
      // consome `authorSeq` da mesma fonte durável (`local_author_seq`) e tem a mesma
      // reconciliação de boot. A submissão é local — a fila de admissão de §11.4 está
      // neste processo, então não há round-trip nenhum.
      outbox = new Outbox({
        manifest: deps.manifest,
        communityId,
        submit: admissionSubmitPort(admission),
        observation: observacao,
        onOutcome: this.outboxOutcomePort(communityId),
        now,
      });
      outbox.recoverOnBoot();
      this.client.addCommunity({ communityId, core, projector, outbox, isHosted: true, hostSubmit: localHostSubmitPort(admission) });
      // §12.2 passo 3 — entra/sai dos tópicos de convite conforme o DS projetado: convite
      // criado por qualquer membro chega pelo log e é anunciado daqui; revogado/expirado/
      // esgotado deixa de ser anunciado no lote que o registrou.
      paradas.push(
        this.onProjected((cid) => {
          if (cid === communityId) invites.syncAnnouncements(now());
        }),
      );
      // §11.6/DS-31 — a observação da própria réplica não espera o job de 30 s: cada lote
      // projetado é um passo posterior ao seu evento (`messages.appended` já saiu no
      // `onEvent`), então reconciliar aqui emite `message.accepted` na ordem determinada
      // e a bolha otimista assenta no mesmo fôlego do append — inclusive no host local,
      // cujo append é instantâneo. Sem reenvio nenhum: reconcile só observa e remove.
      paradas.push(
        this.onProjected((cid) => {
          if (cid === communityId) outbox?.reconcile(now());
        }),
      );
    } else {
      // ── Modo membro: a decisão continua no host, e o canal de §16.1 a carrega ────────
      const canal = new RpcClient({ protocol: 'community', transport: null, role: 'member' });
      rpc = canal;
      // DR-29 — o resultado de cada passe de submissão é a fonte viva do contato com o
      // host: resposta marca `online`/`last_host_seen_at`, indisponibilidade cai para
      // `reconnecting` e `E_VERSION_UNSUPPORTED` fixa `incompatible` (§16.3).
      const submitObservado = async (envelopes: readonly Buffer[]) => {
        const r = await rpcSubmitPort(canal)(envelopes);
        this.hostStatus?.noteSubmit(communityId, r);
        return r;
      };
      outbox = new Outbox({
        manifest: deps.manifest,
        communityId,
        submit: submitObservado,
        observation: observacao,
        // §38.2 — o desfecho de cada item entra no mesmo fan-out, com a comunidade por rota.
        onOutcome: this.outboxOutcomePort(communityId),
        now,
      });
      // §3.3 `reconcile` / §11.6: `sending` sem desfecho volta a `queued` no boot, sem
      // consumir tentativa. É o primeiro dos três gatilhos da reconciliação.
      outbox.recoverOnBoot();
      // §11.6/DS-31 — membro: mesmo gatilho pós-lote do braço do host. A réplica local
      // projetou o próprio append de outro nó; se um item MEU estava no lote, o desfecho
      // sai aqui, sem esperar o job.
      paradas.push(
        this.onProjected((cid) => {
          if (cid === communityId) outbox?.reconcile(now());
        }),
      );
      dispatcher = remoteMediaDispatcher(canal, {
        captureTokenTtlMs,
        now,
        selfKeyHex,
        // §17.5 (emenda de 2026-08-28) — o gate do Modo Música é LOCAL nos dois modos: a
        // permissão `voice_share_screen` é lida na réplica, sem round-trip ao host.
        musicAllowed: () => {
          const eu = selfKeyHex();
          return eu !== null && memberHasPermission(voiceStateOf(projector.ds), eu, 'voice_share_screen');
        },
        // §17.4 emendado — o host sumiu e a sessão local morreu com ele. Sem este aviso o
        // renderer seguia com a chamada na tela e a malha de pé, enquanto o núcleo já se
        // considerava fora. `voice.failed{reason}` é o evento que §15.5 declara para isso.
        onSessionLost: (reason) => {
          this.fanout.emit({ topic: 'voice.failed', data: { communityId, reason } }, { communityId });
        },
      });
      // §16.3 — presença/digitando empurrados pelo host são INGERIDOS no estado local que
      // as consultas leem. O encaminhamento ao renderer já acontece no runtime de mídia,
      // que recebe os mesmos quadros; aqui só o estado, sem evento duplicado.
      paradas.push(
        canal.onNotify((topic, body) => {
          if (topic !== 'presence.changed' && topic !== 'typing.changed') return;
          let data: Record<string, unknown>;
          try {
            const parsed = JSON.parse(Buffer.from(body).toString('utf8')) as unknown;
            data = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
          } catch {
            return; // §16.3 regra 2: quadro estranho nunca derruba a conexão
          }
          if (topic === 'presence.changed') {
            const removidos = Array.isArray(data['removed'])
              ? (data['removed'] as unknown[]).filter((k): k is string => typeof k === 'string')
              : [];
            if (removidos.length > 0) presence.removePresence(communityId, removidos);
            const entries = Array.isArray(data['entries']) ? data['entries'] : [];
            for (const e of entries) {
              if (typeof e !== 'object' || e === null) continue;
              const { identityKey, status } = e as Record<string, unknown>;
              if (typeof identityKey !== 'string' || typeof status !== 'string') continue;
              const lastSeenAt = typeof (e as Record<string, unknown>)['lastSeenAt'] === 'number' ? ((e as Record<string, unknown>)['lastSeenAt'] as number) : now();
              presence.ingestPresence({ communityId, identityKey, status: status as PresenceStatus, at: lastSeenAt });
            }
            return;
          }
          const channelId = data['channelId'];
          const keys = Array.isArray(data['identityKeys']) ? data['identityKeys'] : [];
          if (typeof channelId !== 'string') return;
          for (const k of keys) {
            if (typeof k !== 'string') continue;
            presence.ingestTyping({ communityId, identityKey: k, channelId, until: now() + TYPING_TTL_MS });
          }
        }),
      );
      this.client.addCommunity({ communityId, core, projector, outbox, hostSubmit: rpcHostSubmitPort(canal) });
    }

    this.#dispatchers.set(communityId, dispatcher);
    // DR-29/DR-33 — a comunidade entra no acompanhamento de conexão; modo hospedeiro nasce
    // `online` (o host sou eu), membro nasce `unknown` até o canal dizer algo.
    this.hostStatus?.ensure(communityId, { isHost });

    // §17.4 emendado + §16.3: a cadência de renovação e a entrada das notificações. Em modo
    // host não há `notifications` — quem hospeda produz os eventos, não os recebe.
    const runtimeMidia: { stop(): void; renovarAgora(): void } = startMediaRuntime({
      dispatcher,
      communityId,
      emit: (events) => {
        for (const ev of events) {
          this.#router.observeSession(communityId, ev.data['sessionId']);
          this.fanout.emit(ev, { communityId });
        }
      },
      ...(rpc !== null ? { notifications: rpc } : {}),
      ...(identidade !== null ? { selfPublicKey: identidade.publicKey } : {}),
      hostPublicKey: () => projector.ds.community.hostKey,
      ticketPeriodMs: Math.floor(MEDIA_TICKET_TTL_MS / 3),
      now,
      ...(deps.schedule !== undefined ? { schedule: deps.schedule } : {}),
      ...(deps.cancel !== undefined ? { cancel: deps.cancel } : {}),
    });
    // Fecha o laço: o roster do host (lá em cima) precisa disparar renovação, e o runtime
    // que sabe renovar só existe agora.
    renovarTickets.agora = () => runtimeMidia.renovarAgora();
    paradas.push(() => runtimeMidia.stop());

    return {
      communityId,
      isHost,
      core,
      projector,
      outbox,
      rpc,
      dispatcher,
      host,
      presence,
      stop() {
        for (const p of paradas) p();
        projector.stop();
      },
    };
  }
}

/**
 * Monta o grafo de §4 e devolve o núcleo pronto: as fases `open`, `swarm`, `reconcile` e
 * `host-mode` de §3.3 sobre as comunidades de `manifest.communities` (§10.2), com o IPC-R
 * de §15 na frente.
 */
export async function bootCore(deps: BootDeps): Promise<CoreRuntime> {
  const now = deps.now ?? Date.now;
  const identityOf = (): BootIdentity | null => deps.identity();
  const selfKeyHex = (): string | null => identityOf()?.publicKey.toString('hex') ?? null;
  const coresDir = path.join(deps.dataDir, 'cores');
  const captureTokenTtlMs = deps.captureTokenTtlMs ?? MEDIA_TICKET_TTL_MS;

  // §24.1 — o produtor NDJSON nasce com o núcleo; `undefined` desliga (rigs). A rotação
  // diária é implícita no nome do arquivo; retenção/teto continuam no job `log.rotate`.
  const logger: LoggerPort =
    deps.logger !== undefined
      ? deps.logger
      : new NdjsonLogger({ dir: path.join(deps.dataDir, 'logs'), now, ...(deps.buildChannel !== undefined ? { buildChannel: deps.buildChannel } : {}) });
  // §24.3 — o registro central que o `metrics.flush` comete e o `diag.*` serve.
  const metricas = new MetricsRegistry();

  // §27.2 — `IPC_SUB_WINDOW`/`IPC_STALE_MS` são configuração operacional, e estavam mortas:
  // o `IpcServer` nascia sem elas e usava os próprios defaults, então mexer no `config` não
  // mexia em nada. §15.3 emendado — `escopoDeConfirmacao` é injetado porque a tabela mora em
  // `l3/ipcMain` e L3 não importa L3; a raiz de composição é quem pode ver os dois.
  const cfgIpc = resolveConfig();
  const ipc = new IpcServer({
    epoch: deps.epoch,
    port: deps.ipcPort,
    tokenVerifier: deps.tokenVerifier,
    subWindow: cfgIpc.ipcSubWindow,
    staleMs: cfgIpc.ipcStaleMs,
    escopoDeConfirmacao,
    ...(deps.buildChannel !== undefined ? { buildChannel: deps.buildChannel } : {}),
    identityStatus: {
      get isLoaded(): boolean {
        return identityOf() !== null;
      },
    },
  });
  const fanout = new EventFanout(ipc);
  const search = new SearchService({ view: deps.view, clock: { now } });

  const dispatchers = new Map<string, MediaDispatcher>();
  const router = new MediaRouter(dispatchers);

  const identidade = identityOf();
  const client = new CommunityClient({
    swarm: deps.swarm,
    clock: { now },
    // §14.5/§22.1 — as transições do watchdog (`community.replication`, `accessRevoked`,
    // `forked`) entram no mesmo fan-out, com a comunidade por rota. O log de §24.1 acompanha:
    // a transição é um dos produtores declarados desta fatia.
    onEvent: (ev) => {
      if (ev.topic === 'community.replication') {
        const { state, lag } = ev.data as { state: string; lag?: number };
        logger.info('replication', state, { communityId: String(ev.data.communityId), ...(typeof lag === 'number' ? { seq: lag } : {}) });
      }
      // §18.4 SEGUNDO gatilho: "ou ao receber `E_NOT_AUTHORIZED_FOR_COMMUNITY` de todos os
      // pares". O watchdog já emitia o evento; o que faltava era o resto dos passos — sem
      // eles a réplica ficava para sempre, `community.forget` recusava e a tela de U-16 não
      // tinha de onde saber que a comunidade está em modo histórico.
      if (ev.topic === 'community.accessRevoked') {
        const cid = String(ev.data.communityId);
        // O evento sai daqui pela chamada de `aplicarRemocaoPropria`, não pelo fan-out
        // abaixo: emitir os dois duplicaria `accessRevoked` no renderer.
        if (aplicarRemocaoPropria(removidoDeps(), { communityId: cid, causa: 'unauthorized' }) !== null) return;
      }
      fanout.emit({ topic: ev.topic, data: ev.data }, { communityId: ev.data.communityId });
    },
    ...(identidade !== null
      ? {
          signing: {
            authorKey: identidade,
            codec: opCodecSignPort(),
            opVersion: OP_VERSION,
            limits: SUBMISSION_LIMITS,
          },
        }
      : {}),
  });

  // ── Anexos (§13): o manager sobre o layout de §10.1, com os eventos de §15.5 no fan-out ──
  // Um manager por instalação; os cores de blobs locais entram por comunidade no
  // `openCommunity`, nascidos do `member_blobs_core.secret_seed_enc`.
  const blobs = new BlobManager({
    manifest: deps.manifest,
    swarm: deps.swarm,
    dataDir: deps.dataDir,
    clock: now,
    openReader: blobCorePorts(coresDir).openReader,
    // §13.4 passo 4 — `hostAvailable` é o `hostKey` corrente do log entre os pares que
    // anunciam ter a faixa; muda por `community.assumeHost` (§18.8), então lê-se do DS.
    hostKeyOf: (cid) => abertas.get(cid)?.projector.ds.community.hostKey ?? null,
    onEvent: (ev) => {
      // A rota viaja ao lado do evento (§15.1 regra 2); o payload é o da tabela de §15.5.
      fanout.emit({ topic: ev.topic, data: ev.data }, ev.communityId !== undefined ? { communityId: ev.communityId } : undefined);
    },
  });

  // O mapa das comunidades abertas nasce antes do runtime porque a sucessão o consulta e o
  // runtime a expõe: um dos dois tem de existir primeiro, e é o dado, não o objeto.
  const abertas = new Map<string, OpenCommunity>();
  const stateFor = (cid: string): DecisionState | null => abertas.get(cid)?.projector.ds ?? null;
  const succession = new SuccessionService({
    stateFor,
    identity: identityOf,
    communitySeed: manifestCommunitySeedPort(deps.manifest, deps.dataKey),
    sealedSeedFor: async (cid) => {
      const eu = identityOf();
      const c = abertas.get(cid);
      if (eu === null || c === undefined) return null;
      return await logEscrowPort(c.core, eu.publicKey)(cid);
    },
    submitSync: bridgeSubmitSyncPort(client),
    // §18.8 passos 2 e 6 — criar o core não é assumir. A continuação só existe para este
    // processo depois da linha no manifest (§5.3 item 2), do contador de `authorSeq`
    // fixado depois da gênese (§7.5) e da abertura no runtime (§19.1 passo 6), que é o
    // que a faz anunciar o tópico e servir membro no mesmo tick.
    createContinuationCore: corestoreContinuationCorePort(coresDir, {
      antesDeCriar: (info) => {
        storeCommunitySeed(
          deps.manifest,
          {
            communityId: info.communityId,
            coreKey: info.coreKey,
            blobsKey: info.blobsKey,
            communitySeed: info.communitySeed,
            isHost: true,
            joinedAt: now(),
            originCommunityId: info.originCommunityId,
          },
          deps.dataKey,
        );
        // §13.1 — o atalho do core de blobs local do sucessor. A chave é a mesma que a
        // gênese da continuação publicou em `member.join`, senão o boot recusa anexar.
        const eu = identityOf();
        if (eu !== null) {
          const blobs = memberBlobsKeyPairFor(eu, info.communityId);
          deps.manifest.setMemberBlobsCore({
            communityId: info.communityId,
            coreKey: blobs.publicKey,
            secretSeedEnc: aeadSealPacked(blobs.seed, deps.dataKey),
          });
        }
      },
      aoFalhar: (info) => deps.manifest.deleteCommunity(info.communityId),
      aoCriar: async (core, info) => {
        // O armazenamento é exclusivo: fecha o cabo da criação para o runtime reabrir o
        // core pela chave gravada (§5.3 passo 5), pelo mesmo caminho de todo boot.
        await core.close().catch(() => {});
        // §7.5 — a gênese estendida consumiu os `authorSeq` do sucessor fora da ponte.
        deps.manifest.advanceAuthorSeq(info.communityId, 'community', info.recordCount + 1);
        runtime.register(
          await runtime.openCommunity({
            community_id: info.communityId,
            core_key: info.coreKey,
            blobs_key: info.blobsKey,
            is_host: 1,
            left_at: null,
          }),
        );
      },
    }),
    memberBlobsCoreKeyFor: (communityIdHex) => {
      const eu = identityOf();
      if (eu === null) throw new Error('sem identidade para derivar o core de blobs');
      return memberBlobsKeyPairFor(eu, communityIdHex).publicKey;
    },
    now,
  });
  const runtime = new CoreRuntime({ deps, ipc, fanout, client, search, succession, blobs, router, dispatchers, open: abertas });
  runtime.logger = logger;
  runtime.metricsSink = metricas;

  // ── §17.7 — voluntariado de relay: consentimento persistido e ops 60/61 (B30) ─────────
  //
  // O consentimento é `local_relay_consent` (§6.15) — nunca replica, e é pré-condição de
  // ligar. `remember: false` é decisão explícita de não persistir: a resposta vale para
  // ESTA vez, e o `forget` logo depois é o que a torna de uma vez só.
  const consentimentoDeRelay: RelayConsentPort = {
    get: (communityId) => deps.manifest.getRelayConsent(communityId),
    set: (communityId, decision) => deps.manifest.setRelayConsent(communityId, decision, now()),
    forget: (communityId) => deps.manifest.forgetRelayConsent(communityId),
  };
  const identidadeParaRelay = identityOf();
  const voluntario =
    identidadeParaRelay === null
      ? null
      : new RelayVolunteer({
          // §17.7: a chave de relay é DERIVADA da identidade (`ns/relay/1`), e é isso que
          // torna impossível apontar o voluntariado para um terceiro.
          identitySeed: identitySeedOf(identidadeParaRelay),
          identitySecretKey: identidadeParaRelay.secretKey,
          consent: consentimentoDeRelay,
          // Kinds 60/61 pela mesma fila durável de todo mundo (§11.2): voluntariar-se é
          // escrita de log como outra qualquer, e o desfecho é o da outbox.
          submit: {
            submit: async (submission) => {
              const r = await (submission.kind === 'relay.volunteer'
                ? client.submitSync(submission.communityId, {
                    kindName: 'relay.volunteer',
                    payload: {
                      relayPublicKey: submission.relayPublicKey,
                      expiresAt: submission.expiresAt,
                      possession: submission.possession,
                    },
                  })
                : client.submitSync(submission.communityId, { kindName: 'relay.withdraw', payload: {} }));
              return r.ok ? r.seq : -1;
            },
          },
          clock: { now },
          ttlMs: RELAY_TTL_MS,
          maxBytesPerDay: resolveConfig().relayMaxBytesPerDay,
          maxAllocs: resolveConfig().relayMaxAllocs,
          onConsentRequested: (ev) => fanout.emit({ topic: 'relay.consentRequested', data: { ...ev } }, { communityId: ev.communityId }),
          onStateChanged: (ev) => fanout.emit({ topic: 'relay.stateChanged', data: { ...ev } }, { communityId: ev.communityId }),
        });

  // ── §18.4 — o lado do ALVO: observar o próprio ban/kick e entrar em modo removido (B7) ──
  //
  // O gatilho é o `fold` LOCAL, como a seção manda ("ao observar no próprio `fold` um
  // `mod.ban`/`mod.kick` cujo alvo é a identidade local"), e ele é alcançável porque em v2 o
  // alvo continua replicando até aplicar o ban (§14.3): ele VÊ o próprio ban antes de perder
  // acesso. Roda a cada lote projetado, junto com a revogação de mídia de §17.4 — que é o
  // mesmo gatilho, pelo mesmo motivo.
  // Declaração de função, e não `const`: o `onEvent` do `CommunityClient` acima já a
  // referencia, e um `const` aqui ficaria na zona morta temporal para qualquer evento que
  // chegasse antes desta linha.
  function removidoDeps(): RemocaoDeps {
    return {
      manifest: deps.manifest,
      view: deps.view,
      now,
      retentionDays: resolveConfig().removedRetentionDays,
      // §18.4 passo 1 — o rpcClient para junto: `leaveCommunity` fecha os canais de §16.1
      // daquela comunidade, e é a queda deles que devolve `E_HOST_UNAVAILABLE` ao que estava
      // em voo (§16.1 reconexão).
      desligarDaRede: (cid) => runtime.transportOrNull?.leaveCommunity(cid),
      descartarFila: (cid, motivo) => runtime.get(cid)?.outbox?.discardForRemoval(motivo) ?? 0,
      emitir: (cid, cause) => fanout.emit({ topic: 'community.accessRevoked', data: { communityId: cid, cause } }, { communityId: cid }),
    };
  }
  runtime.onProjected((communityId) => {
    const eu = selfKeyHex();
    const c = abertas.get(communityId);
    if (eu === null || c === undefined) return;
    // Quem hospeda não se remove: `mod.ban` sobre o próprio host não existe (R-11), e
    // aplicar isto ali desligaria a comunidade da rede por causa da própria auditoria.
    if (c.isHost) return;
    const causa = causaDaPropriaSaida(c.projector.ds, eu, kicksSobreMimEm(deps.view, communityId, eu));
    if (causa === null) return;
    const aplicada = aplicarRemocaoPropria(removidoDeps(), { communityId, causa });
    if (aplicada !== null) {
      // §24.2 é allowlist: `code` é o campo que carrega motivo nomeado.
      logger.info('community', 'removed', { communityId, code: aplicada });
    }
  });

  // ── §15.4 "Identidade e app" — o serviço existe quando o shell injeta o manager ──────
  const servicoIdentidade =
    deps.identityManager !== undefined
      ? new IdentityService({
          manager: deps.identityManager,
          manifest: deps.manifest,
          dataDir: deps.dataDir,
          keystore: deps.keystore ?? insecureFallbackKeystorePort(new FallbackKeystoreOracle()),
          dataKey: () => deps.dataKey,
          now,
          ...(deps.saveFile !== undefined ? { saveFile: deps.saveFile } : {}),
          ...(deps.readFile !== undefined ? { readFile: deps.readFile } : {}),
        })
      : null;

  /**
   * §3.3 — a identidade chegou num núcleo que esperava por ela: awaiting-identity → ready,
   * a ponte de escrita liga (§19.3) e o evento de §15.5 avisa. Mesmo passo para `create`
   * e para `import`.
   */
  let assinaturaLigada = identidade !== null;
  async function identidadePronta(): Promise<void> {
    if (!assinaturaLigada && identityOf() !== null) {
      client.setSigning({
        authorKey: identityOf()!,
        codec: opCodecSignPort(),
        opVersion: OP_VERSION,
        limits: SUBMISSION_LIMITS,
      });
      assinaturaLigada = true;
    }
    if (runtime.phase === 'awaiting-identity') {
      runtime.setPhase('ready');
      fanout.emit({ topic: 'core.ready', data: { phase: 'ready', epoch: deps.epoch } }, {});
    }
    // §31 — a conversa direta é montada nesta mesma transição. `montarDm` é idempotente e
    // não faz nada sem identidade, então chamá-lo dos três caminhos custa uma comparação.
    //
    // A falha degrada só §31, como a reabertura de comunidade degrada só aquela comunidade
    // (§3.3): a identidade já existe e a fase já é `ready`, e devolver erro em
    // `identity.create` por causa da conversa direta mentiria sobre o que aconteceu.
    try {
      await montarDm();
    } catch (err) {
      dmMontado = false;
      logger.error('dm', 'mount-failed', { code: (err as { code?: string }).code ?? 'E_INTERNAL' });
    }
  }

  // ── DR-29/DR-33 — o acompanhamento da conexão com o host, sobre as portas do runtime ──
  // Cada transição publicada também é linha de log (§24.1): scope `host`, msg é o status.
  const hostStatusDeps: HostStatusDeps = {
    manifest: deps.manifest,
    emit: (ev, rota) => {
      logger.info('host', String((ev.data as Record<string, unknown>).status), { communityId: rota.communityId });
      fanout.emit(ev, rota);
    },
    now,
    schedule: deps.schedule ?? ((fn, ms) => setTimeout(fn, ms)),
    cancel: deps.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)),
    outboxOf: (cid) => runtime.get(cid)?.outbox ?? undefined,
    stateFor,
    replicationStateOf: (cid) => client.getState(cid)?.state ?? null,
    selfKeyHex,
  };
  runtime.hostStatus = new HostStatusTracker(hostStatusDeps);

  // ── §3.3 `open`: `manifest.communities` é a enumeração autoritativa de participação ──
  const todasAsLinhas = deps.manifest.listCommunities() as CommunityRow[];
  // §5.3 passo 2 — a linha órfã: semente gravada, core nunca criado (o processo morreu no
  // meio de `community.create`). "A linha órfã é limpa no boot". O critério é o armazenamento
  // do core não existir — e só há caminho de produto quando o boot abre cores de disco;
  // com `openCore` injetado (teste) o diretório não é o que prova existência.
  if (deps.openCore === undefined) {
    for (const row of todasAsLinhas) {
      if (row.is_host !== 1) continue;
      if (!fs.existsSync(path.join(deps.dataDir, 'cores', row.community_id))) {
        deps.manifest.deleteCommunity(row.community_id);
      }
    }
  }
  // §10.5 passo 2 — o `DROP`/recria de `view.db` no bump de `view_schema_version` é
  // **global** (§10.1: um banco serve todas as comunidades) e por isso mora aqui, uma vez,
  // antes de abrir a primeira. O projetor é por comunidade: ele limpa só o escopo dele
  // (§10.5 passo 3). Enquanto o `wipe` estava lá dentro, cada comunidade aberta apagava a
  // projeção das anteriores — e o laço abaixo transformava isso em regra, não em acidente.
  if (deps.view.schemaVersionMismatch()) deps.view.wipe();
  const rows = todasAsLinhas.filter((r) => r.left_at === null);
  for (const row of rows) {
    // "Core ilegível → `degraded` só naquela comunidade; as outras seguem" (§3.3).
    try {
      runtime.register(await runtime.openCommunity(row));
    } catch (err) {
      fanout.emit({
        topic: 'host.statusChanged',
        data: { communityId: row.community_id, status: 'degraded', reason: (err as { code?: string }).code ?? 'E_INTERNAL' },
      });
    }
  }

  // ── Portas de §35.2/§37.2 sobre o que ficou aberto ──────────────────────────────────
  const leave = communityLeavePort({
    client,
    manifest: deps.manifest,
    outboxOf: (cid) => runtime.get(cid)?.outbox ?? undefined,
    selfKeyHex,
  });

  // ── Não-lidas de §6.15 — o recálculo no lote projetado (emenda de 2026-08-22) ───────
  // O projector não escreve LS (o `Effect` de §8.4 é fechado sobre CS) e a contagem é por
  // instalação, então quem calcula é a raiz, disparada pelo MESMO passo do fan-out.
  const naoLidas = new UnreadTracker({
    manifest: deps.manifest,
    view: deps.view,
    comunidade: (cid) => runtime.get(cid)?.projector ?? null,
    selfKeyHex,
    emit: (ev, rota) => fanout.emit(ev, rota),
  });
  naoLidas.attach(runtime);
  const depsPreferencias: PreferencesDeps = { manifest: deps.manifest, naoLidas };

  // ── Admissão: nascer, convidar, resolver e resgatar (§12, §15.4, §19.1) ─────────────
  // O serviço sobe junto com o boot; o transporte real anexa-se depois (`attachTransport`)
  // e é o gancho `onTransport` que liga as duas metades do `p2p-admission/1`.
  const selfKeyComposto = (): BootIdentityLike | null => {
    const id = identityOf();
    if (id === null) return null;
    const perfil = deps.identityProfile?.() ?? null;
    return {
      publicKey: id.publicKey,
      secretKey: id.secretKey,
      ...(perfil !== null ? { displayName: perfil.displayName, avatarColor: perfil.avatarColor } : {}),
    };
  };
  const depsAdmissao = {
    runtime,
    swarm: deps.swarm,
    manifest: deps.manifest,
    dataKey: deps.dataKey,
    coresDir,
    selfKey: selfKeyComposto,
    profile: () => deps.identityProfile?.() ?? null,
    now,
  } satisfies AdmissionServiceDeps;
  // As ops de estrutura usam a mesma raiz de dependências da admissão, mais o prazo de
  // espera da projeção (§15.4 responde `rank`, e quem calcula `rank` é o `fold`).
  const depsEstrutura = {
    ...depsAdmissao,
    ...(deps.projectionWaitMs !== undefined ? { projectionWaitMs: deps.projectionWaitMs } : {}),
  };
  const admissao = new AdmissionService(depsAdmissao);

  // ── Jobs de §22.2 com dono em código ───────────────────────────────────────────────
  //
  // `invite.topicSweep`: convite **expira** sem registro no log, então a reconciliação por
  // lote projetado não basta — sem este job, uma comunidade parada anuncia convite vencido.
  // `blob.gc`: LRU do cache de §13.8 (blobs enviados por mim com mensagem viva são
  // protegidos, §13.7 regra 2) e fechamento dos leitores esparsos que perderam referência.
  // Os demais corpos têm a seção que os define: `outbox.expire` reconcilia antes de
  // descartar por idade (§11.6); `staging.gc` confere referência na `view.db` (§13.5);
  // `removed.purge` apaga a réplica vencida (§18.4); `db.maintenance` cuida dos PRAGMAs e
  // do WAL; `log.rotate` aplica retenção/teto de §24.1; `succession.check` avalia o grace
  // period de §18.8.
  const agendar = deps.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancelar = deps.cancel ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  runtime.jobs = startJobs({
    schedule: agendar,
    cancel: cancelar,
    jobs: {
      'invite.topicSweep': () => admissao.sweepInviteTopics(),
      'blob.gc': async () => {
        // Protegido = anexo meu com mensagem viva. A `view.db` é a fonte: a linha existe
        // enquanto a mensagem existir e não estiver tombstonada (§13.7 regra 2).
        blobs.gcCache({ isProtected: (row) => anexoProprioVivo(deps.view, identityOf(), row) });
        await blobs.gcReaders();
      },
      'outbox.expire': () => {
        for (const c of runtime.communities()) c.outbox?.reconcile(now());
      },
      'host.inactivity': () => {
        runtime.hostStatus?.runInactivity();
      },
      'staging.gc': () => {
        blobs.staging.gcOrphan({
          now: now(),
          hasReference: (row) => stagingReferenciado(deps.view, deps.manifest, blobs, row),
          clearBlobs: (row) => {
            if (row.communityId === null || row.blobRanges === null) return;
            void blobs
              .clearLocalRange(row.communityId, row.blobRanges.blockOffset, row.blobRanges.blockOffset + row.blobRanges.blockLength - 1)
              .catch(() => {});
          },
        });
      },
      'removed.purge': async () => {
        await purgeRemovidas({
          runtime,
          client,
          manifest: deps.manifest,
          view: deps.view,
          dataDir: deps.dataDir,
          now,
        });
      },
      'db.maintenance': () => {
        manutencaoDeBancos([deps.manifest, deps.view]);
      },
      'log.rotate': () => {
        rotacionarLogs(path.join(deps.dataDir, 'logs'), now());
      },
      'succession.check': () => {
        for (const c of runtime.communities()) succession.checkEligibility(c.communityId);
      },
    },
  });

  // ── Loops permanentes de §22.1 com corpo em código (presença/digitando) ────────────
  // A escolha de presença é da identidade (`identity.setPresence`, §15.4): o comando fixa
  // `runtime.localPresence` e o refresh publica. O default é o persistido no perfil — e,
  // sem escolha gravada, `online`, que o refresh mantém vivo contra o TTL de 45 s.
  const escolhida = deps.identityManager?.record?.presence;
  const defaultPresenca: LocalPresence =
    escolhida !== undefined && (PRESENCE_VALUES as readonly string[]).includes(escolhida)
      ? (escolhida as LocalPresence)
      : 'online';
  for (const c of abertas.keys()) runtime.localPresence.set(c, defaultPresenca);
  runtime.loops = startLoops({
    schedule: agendar,
    cancel: cancelar,
    loops: {
      // §22.1 outbox.flush — um giro por segundo em todo nó. Em modo membro só com canal
      // vivo: submeter sem conexão não é tentativa real de entrega (§11.8), queimaria
      // tentativa/backoff e inflaria a fila do RpcClient sem destino.
      'outbox.flush': async () => {
        for (const c of runtime.communities()) {
          if (c.outbox === null) continue;
          if (!c.isHost) {
            const estado = runtime.hostStatus?.statusOf(c.communityId) ?? 'unknown';
            if (estado !== 'online' && estado !== 'connecting') continue;
          }
          await c.outbox.flush().catch(() => {});
        }
      },
      // §22.1 outbox.reconcile — OUTBOX_RECONCILE_MS; o boot e o cameBack disparam fora da
      // cadência (§11.6).
      'outbox.reconcile': () => {
        const agora = now();
        for (const c of runtime.communities()) c.outbox?.reconcile(agora);
      },
      // §22.1 replication.watchdog — REPLICATION_WATCH_MS; as transições saem pelo
      // `CommunityClient.onEvent`, ligado ao fan-out acima.
      'replication.watchdog': () => {
        client.watchdogTick(now());
      },
      // §22.1 host.hello (emenda de 2026-08-23) — HELLO_INTERVAL_MS em todo nó membro;
      // a primeira conexão já recebe hello direto do `attachHostChannel` (§16.3).
      'host.hello': () => {
        runtime.renovarHelos();
      },
      // §17.6 — o host agrega presença em delta consolidado a cada PRESENCE_TICK_MS.
      'presence.tick': () => {
        for (const c of runtime.communities()) {
          if (!c.isHost) continue;
          c.presence.tick();
        }
      },
      // §17.6 — TTL 5 s do typing, varrido por segundo no host.
      'typing.expire': () => {
        for (const c of runtime.communities()) {
          if (!c.isHost) continue;
          c.presence.expireTyping();
        }
      },
      // §22.1 voice.liveness (emenda de 2026-08-26) — §17.4: queda de conexão é saída da
      // chamada. O detach do canal derruba na hora; este loop é o teto para o caso em que
      // o transporte nunca percebe a queda, que é exatamente o do computador desligado.
      'voice.liveness': () => {
        const agora = now();
        const eu = selfKeyHex();
        for (const c of runtime.communities()) {
          const h = c.host;
          if (h === undefined || h === null) continue;
          h.voice.sweepLiveness((keyHex) => {
            // O host participa da chamada como qualquer membro e **não** tem conexão de si
            // para si: sem esta linha o primeiro giro do loop expulsaria o próprio host.
            if (keyHex === eu) return true;
            const visto = h.vistoEm.get(keyHex);
            return visto !== undefined && agora - visto <= VOICE_LIVENESS_MS;
          });
        }
      },
      // §16.4 (emenda de 2026-08-30, §22.2) — o giro da fila de karaokê por segundo: expira
      // o turno vencido (muta o titular e promove o próximo) e descarta a fila do canal
      // cuja sessão acabou. Rodava no `voice.liveness`, a 30 s — e a vez é coisa de
      // segundos: o titular ficava com o microfone aberto até 30 s além do prazo.
      'voice.queueTick': () => {
        for (const c of runtime.communities()) {
          const h = c.host;
          if (h === undefined || h === null) continue;
          h.fila.ticar((channelId) => h.voice.sessionOf(channelId) !== null);
        }
      },
      // §17.6/§22.1 — todo nó renova a própria presença antes do TTL.
      'presence.refresh': () => {
        const eu = selfKeyHex();
        if (eu === null) return;
        for (const c of runtime.communities()) {
          const status = runtime.localPresence.get(c.communityId) ?? defaultPresenca;
          if (status === 'invisible') continue;
          if (c.isHost) {
            c.presence.publishPresence({ communityId: c.communityId, identityKey: eu, status });
            continue;
          }
          // Membro: publica pelo canal de §16.2 só com canal vivo — efêmero não enfileira
          // no RpcClient sem conexão, senão a fila cresceria sem fim.
          const estado = runtime.hostStatus?.statusOf(c.communityId) ?? 'unknown';
          if (estado !== 'online' && estado !== 'connecting') continue;
          void c.rpc?.call('presencePublish', new Uint8Array(Buffer.from(JSON.stringify({ status }), 'utf8'))).catch(() => {});
        }
      },
      // §22.1/§24.3 — o flush comete no registro central o que os detentores de estado têm
      // AGORA: profundidade da fila por comunidade, estado de replicação e pares do swarm.
      // O destino é o registro consultável (`diag.snapshot`), não o NDJSON — o formato de
      // §24.1 é fechado e não tem campo para valor.
      'metrics.flush': () => {
        metricas.setGauge('swarm.peers', deps.swarm.getStats().peerCount);
        const estados: Record<string, number> = { synced: 0, 'catching-up': 1, stalled: 2, blocked: 3, unauthorized: 4, forked: 5 };
        for (const c of runtime.communities()) {
          const serie = serieId(c.communityId);
          metricas.setGauge(`outbox.depth.${serie}`, deps.manifest.countActive(c.communityId));
          const st = client.getState(c.communityId)?.state;
          if (st !== undefined) metricas.setGauge(`replication.state.${serie}`, estados[st] ?? -1);
        }
        logger.info('metrics', 'flush');
      },
      // §17.3/§22.1 (emenda de 2026-09-05) — a varredura de alocações do TURN. O
      // `MediaServer.sweep` existia desde a fase 7 **sem nenhum chamador**: só o teste o
      // acionava, e em produto cada alocação vencida deixava a socket relayada aberta até o
      // processo morrer, com o 5-tuple do cliente trancado em 437.
      'media.sweep': () => {
        runtime.mediaHost?.sweep();
      },
    },
  });

  // ── §15.4 `diag.*` — as três sondas de B11, fechadas em 2026-08-28 ────────────────────
  //
  // Elas eram stubs: `nat` rejeitava, `stun` resolvia `false` e `relay` devolvia `false`, e
  // `diag.run` respondia SEMPRE `cgnat/false/false`. Pior caso assumido é a política certa
  // para uma sonda que falha — mas como resposta permanente não é diagnóstico, é ruído:
  // quem acabou de ver a chamada cair em `conn-failed` (§80) abria o painel e lia a mesma
  // coisa que leria com a rede perfeita.
  //
  // Nenhuma das três é medição nova. As duas primeiras leem o que o transporte já mede; a
  // terceira é fato desta instalação.
  const diagnosticoEfetivo =
    deps.diagnostics ??
    new Diagnostics({
      swarm: deps.swarm,
      nat: {
        // O `dht-rpc` amostra o endereço externo a cada resposta que recebe e consolida no
        // `nat-sampler`; `classificarNat` só traduz nos três nomes de §24.3. Mandar tráfego
        // para medir de novo o que já está medido seria pior e mais lento.
        probe: () => {
          const obs = deps.swarm.backend?.natObservation?.() ?? null;
          return obs === null
            ? Promise.reject(new Error('sem observação de NAT nesta instalação'))
            : Promise.resolve(classificarNat(obs));
        },
      },
      stun: {
        // Pela socket de §17.3 — a mesma do UDX. É o mapeamento DELA que vira candidato
        // `srflx`, então é ela que precisa ser sondada.
        probe: async () => {
          const tap = deps.swarm.backend?.mediaSocket?.() ?? null;
          if (tap === null) return false;
          return sondarStun(tap, resolveConfig().stunServers);
        },
      },
      // Fato da instalação (§17.3/§17.7): há caminho relayado servível daqui? Hoje é o TURN
      // do host — endereço público observado e STUN para descobrir o mapeamento da porta
      // relayada. O voluntário de §17.7 entra nesta mesma resposta quando existir.
      relay: { available: () => runtime.mediaHost?.servindoRelay ?? false },
      metrics: {
        snapshot(): MetricsSnapshot {
          return metricas.snapshot();
        },
      } satisfies DiagnosticsMetricsPort,
      clock: { now },
    });

  /**
   * §18.6 — `identity.wipe` sobre recursos vivos. A resposta sai ANTES da saída do
   * processo; quem reinicia é o main (epoch+1, §15.2).
   */
  const wipeAgora = async (): Promise<{ ok: true } | { ok: false; code: string; stage?: string }> => {
    if (servicoIdentidade === null) return { ok: false, code: 'E_INTERNAL' };
    const r = await executeWipe({
      dataDir: deps.dataDir,
      swarm: deps.swarm,
      closeRuntime: async () => {
        await runtime.close();
      },
      view: deps.view,
      manifest: deps.manifest,
      wipeIdentity: () => servicoIdentidade.manager.wipe(),
      // §18.6 emendado — a Data Key do processo sai junto: é ela que protege as sementes de
      // comunidade (§5.3), e no ramo de falha o processo NÃO sai (o `exit` abaixo só roda
      // no caminho `ok`), então deixá-la no heap seria deixá-la lá para valer.
      wipeDataKey: () => sodium.sodium_memzero(deps.dataKey),
      // Aqui a liberação do LOCK é correta: esta é a limpeza sobre recursos vivos, e o
      // processo encerra 25 ms adiante. A retomada do boot é o outro caso, e lá o LOCK fica.
      ...(deps.lock !== undefined ? { releaseLock: deps.lock.release } : {}),
    });
    if (!r.ok) return r;
    setTimeout(() => (deps.exit ?? (() => process.exit(0)))(), 25);
    return { ok: true };
  };

  // ── §31 — a conversa direta, montada e ligada à fronteira (B59) ────────────────────
  //
  // Sem identidade não há o que montar: o `conversationId` é `BLAKE2b('dm-conv/1' ‖ lo ‖ hi)`
  // e as duas metades saem de chaves de identidade (§31.2). O núcleo em `awaiting-identity`
  // simplesmente não tem a superfície, e os comandos de DM respondem `E_UNKNOWN_COMMAND` —
  // que é o mesmo que já acontece com `identity.update` e com toda superfície sem serviço.
  //
  // Mas "não tem agora" não pode virar "não tem até reiniciar" (emenda de 2026-09-03): numa
  // instalação nova a identidade nasce **em sessão**, e §3.3 já trata isso como transição —
  // `identidadePronta` liga a assinatura e passa a fase para `ready`. A montagem entra na
  // mesma transição, em vez de acontecer uma vez só no boot; sem isso, a conversa direta
  // respondia `E_UNKNOWN_COMMAND` até o app ser reaberto.
  let dmMontado = false;
  const montarDm = async (): Promise<void> => {
    if (dmMontado || identityOf() === null) return;
    dmMontado = true;
    const dmRuntime = await criarDmRuntime({
      manifest: deps.manifest,
      view: deps.view,
      swarm: deps.swarm,
      identity: identityOf,
      dataKey: deps.dataKey,
      coresDir,
      foldBuildId: deps.foldBuildId,
      // §31.16.2 — os doze eventos entram pelo MESMO fan-out do resto, com a conversa
      // como rota. `unread.changed` de §15.5 **não** é reutilizado: o payload dele declara
      // `communityId`, e uma conversa direta não tem um (§31.16.2).
      onEvent: (topic, data) =>
        fanout.emit({ topic, data }, { ...(typeof data['conversationId'] === 'string' ? { conversationId: data['conversationId'] } : {}) }),
      // §31.9 regra 5 — "comunidade em comum" é fato do estado interpretado, e é aqui que
      // ele existe. Um par é conhecido quando é membro ativo de alguma comunidade aberta.
      compartilhaComunidade: (peerKey) => {
        const hex = peerKey.toString('hex');
        for (const c of abertas.values()) {
          if (c.projector.ds.members.get(hex)?.state === 'active') return true;
        }
        return false;
      },
      now,
      retentionDays: resolveConfig().removedRetentionDays,
      // §31.14 — o core de blobs por conversa, no MESMO `BlobManager` de §13. O
      // `conversationId` entra no slot que o `communityId` ocupa: o manager sempre
      // chaveou por string opaca, e §31.14 manda reutilizar §13 inteiro — staging,
      // upload, download, barreira blob↔mensagem e os oito estados de cache seguem sem
      // alteração. A marca de escopo existe para uma coisa só: R-14 não se aplica
      // aqui, e a exceção é declarada em vez de acidental.
      blobs: {
        anexar: async (conversationId, seed) => {
          const writer = await blobCorePorts(coresDir).openWriter(seed);
          blobs.attachLocalCore(conversationId, writer, { escopo: 'dm' });
          return writer.key;
        },
        soltar: async (conversationId) => {
          await blobs.detachLocalCore(conversationId);
        },
        foiStaged: (a) => blobs.stagedMatching(a) !== null,
        // §31.16.3 — o mesmo `local_blob_cache` de §13.4 que `query.message` já lê. Sem
        // esta ponta, `query.dmMessage` devolvia meio `AttachmentDto` e o cartão da
        // conversa não sabia que o arquivo já estava no disco.
        cache: (blobsCoreKey, blobIdHex) => blobs.cache.get(blobsCoreKey, blobIdHex),
      },
    });
    runtime.dm = dmRuntime;
    await dmRuntime.boot();
    // §31.15 — a chamada de dois. O serviço de §17.3 é por NÓ: a conversa se registra no
    // mesmo `MediaHost` do processo, com o `conversationId` no slot do `communityId` — a
    // mesma substituição que §31.14 fez no escopo de blob — e com o `dmTurnSecret` de §31.3
    // no lugar do `hostTurnSecret`. Não há `voiceCoordinator` aqui, e não deveria haver: o
    // que ele decide (quem pode falar com quem dentro de um conjunto) não existe num
    // conjunto de dois que o Noise já autenticou.
    const dmCall = criarDmCall({
      transport: dmRuntime.transport,
      identity: identityOf,
      dataKey: deps.dataKey,
      peerKeyOf: (conversationId) => dmRuntime.dm.conversa(conversationId)?.peer_key ?? null,
      // A porta abre sob demanda, e só quando alguém entra em chamada: uma instalação que
      // nunca ligou para ninguém não passa a escutar STUN por causa desta fatia.
      midia: () => runtime.garantirMediaHost(),
      onEvent: (topic, data) =>
        fanout.emit(
          { topic, data },
          { ...(typeof data['conversationId'] === 'string' ? { conversationId: data['conversationId'] } : {}) },
        ),
      now,
    });
    dmRuntime.transport.definirOuvinteDeChamada((a) => dmCall.aoMudarChamadaDoPar(a));
    // §31.15 — a tela de uma DM não tem sessão a autorizar; o que a autoriza é a chamada
    // estar de pé. `capture.authorize` (§15.7) passa a poder perguntar isso.
    runtime.dmCallAtivas = () => dmCall.ativas();
    // Não há `close` a registrar aqui: `CoreRuntime.close()` fecha o `MediaHost` do processo
    // antes de qualquer outra coisa (§17.3), e ele já solta todos os escopos registrados —
    // inclusive os das conversas. `dmCall.close()` existe para quem monta o objeto sozinho.
    const superficieDm: DmSurfaceDeps = {
      open: (peerKey) => dmRuntime.dm.abrir(peerKey),
      accept: (id) => dmRuntime.dm.aceitar(id),
      // §31.15 — bloquear e esquecer **encerram a chamada**. Quem garante a ordem é
      // `registerDmCommands`, e não esta montagem: a regra não pode depender de cada raiz de
      // composição se lembrar dela (ver o comentário de `dm.block` em `dmCommands.ts`).
      block: (id) => dmRuntime.dm.bloquear(id),
      unblock: (id) => dmRuntime.dm.desbloquear(id),
      forget: (id) => dmRuntime.dm.esquecer(id),
      sendMessage: async (a) =>
        await dmRuntime.escrever(a.conversationId, 'dm.message', {
          content: a.content,
          ...(a.attachment !== undefined ? { attachment: a.attachment } : {}),
          ...(a.replyToId !== undefined ? { replyToId: a.replyToId } : {}),
        }),
      editMessage: async (a) =>
        await dmRuntime.escrever(a.conversationId, 'dm.edit', { messageId: a.messageId, content: a.content }),
      deleteMessage: async (a) => await dmRuntime.escrever(a.conversationId, 'dm.delete', { messageId: a.messageId }),
      react: async (a) =>
        await dmRuntime.escrever(a.conversationId, 'dm.react', {
          messageId: a.messageId,
          emoji: a.emoji,
          present: a.present,
        }),
      setProfile: async (a) =>
        await dmRuntime.escrever(a.conversationId, 'dm.profile', {
          ...(a.displayName !== undefined ? { displayName: a.displayName } : {}),
          ...(a.avatarColor !== undefined ? { avatarColor: a.avatarColor } : {}),
        }),
      markRead: (id) => dmRuntime.markRead(id),
      activate: (id) => dmRuntime.activate(id),
      setTyping: (id, on) => dmRuntime.transport.setTyping(id, on),
      setContactPolicy: (policy) => dmRuntime.dm.setContactPolicy(policy),
      callJoin: (id) => dmCall.join(id),
      callLeave: (id) => dmCall.leave(id),
      callSignal: (a) => dmCall.signal(a.conversationId, a),
      queries: dmRuntime.queries,
    };
    registerDmCommands(ipc, superficieDm);
  };

  // Identidade já no disco: monta agora. Se ela ainda vai nascer nesta sessão, quem monta é
  // `identidadePronta` — o mesmo funil de `identity.create` e dos dois caminhos de `import`.
  await montarDm();

  registerCoreCommands(ipc, {
    diagnostics: diagnosticoEfetivo,
    // §15.4/§15.6 "Identidade e app" — o ciclo do núcleo: status, reprojeto, shutdown e a
    // máquina de wipe de §18.6 sobre os recursos que só esta raiz tem nas mãos.
    core: {
      status: () => ({
        phase: runtime.phase,
        epoch: deps.epoch,
        coreVersion: deps.foldBuildId,
        opVersion: OP_VERSION,
        manifestSchemaVersion: Number(MANIFEST_SCHEMA_VERSION),
        viewSchemaVersion: Number(VIEW_SCHEMA_VERSION),
        keystore: servicoIdentidade?.keystoreKind() ?? 'insecure-fallback',
        buildChannel: deps.buildChannel ?? 'prod',
      }),
      reproject: async (communityId?: string) => {
        if (runtime.phase !== 'ready') return { ok: false as const, code: 'E_BUSY' };
        const alvos =
          communityId === undefined ? runtime.communities() : [runtime.get(communityId)].filter((c) => c !== undefined);
        if (alvos.length === 0) return { ok: false as const, code: 'E_NOT_FOUND' };
        for (const c of alvos) await c.projector.reproject();
        return { ok: true as const };
      },
      shutdown: async (budgetMs?: number) => await runtime.shutdown({ ...(budgetMs !== undefined ? { budgetMs } : {}) }),
      wipe: wipeAgora,
    },
    identity:
      servicoIdentidade === null
        ? undefined
        : {
            self: () => {
              const rec = servicoIdentidade.manager.record;
              if (rec === null) return null;
              return {
                key: rec.publicKeyHex,
                displayName: rec.displayName,
                handle: rec.handle,
                avatarColor: rec.avatarColor,
                presence: rec.presence,
                createdAt: rec.createdAt,
              };
            },
            create: async (a) => {
              const r = await servicoIdentidade.create(a.displayName, a.avatarColor);
              if (r.ok) await identidadePronta();
              return r;
            },
            update: async (a) => {
              if (a.displayName === undefined && a.avatarColor === undefined) {
                return { ok: false as const, code: 'E_VALIDATION', field: 'displayName' };
              }
              if (a.displayName !== undefined) {
                if (typeof a.displayName !== 'string') return { ok: false as const, code: 'E_VALIDATION', field: 'displayName' };
                const nome = checkDisplayName(a.displayName);
                if (!nome.ok) return { ok: false as const, code: 'E_VALIDATION', field: 'displayName' };
              }
              if (a.avatarColor !== undefined && (typeof a.avatarColor !== 'number' || !isAvatarColor(a.avatarColor))) {
                return { ok: false as const, code: 'E_VALIDATION', field: 'avatarColor' };
              }
              servicoIdentidade.manager.updateProfile(
                typeof a.displayName === 'string' ? a.displayName : undefined,
                typeof a.avatarColor === 'number' ? a.avatarColor : undefined,
              );
              // §15.4 — **A**, uma op POR comunidade participada. Falha síncrona em qualquer
              // delas recusa a chamada inteira; o que entrou antes continua na fila (a op é
              // idempotente no fold — reenviar não duplica efeito).
              const queued: Array<{ communityId: string; opId: string }> = [];
              const payload: Record<string, unknown> = {
                ...(typeof a.displayName === 'string' ? { displayName: a.displayName } : {}),
                ...(typeof a.avatarColor === 'number' ? { avatarColor: a.avatarColor } : {}),
              };
              for (const cid of abertas.keys()) {
                const r = client.submitQueued(cid, { kindName: IDENTITY_UPDATE_KIND, payload });
                if (!r.ok) return { ok: false as const, code: r.code, ...(r.field !== undefined ? { field: r.field } : {}) };
                queued.push({ communityId: cid, opId: r.opId });
              }
              return { ok: true as const, queued };
            },
            setPresence: (presence: unknown) => {
              const r = servicoIdentidade.setPresence(presence);
              if (r.ok) runtime.setLocalPresence(r.presence);
              return r;
            },
            export: (passphrase: unknown) => servicoIdentidade.export(passphrase),
            import: async (passphrase: unknown) => {
              const r = await servicoIdentidade.import(passphrase);
              if (!r.ok) return r;
              // §5.5 "recria o manifesto e reabre os cores": as linhas do backup voltam ao
              // manifest — hospedadas com a semente cifrada pela Data Key corrente — e cada
              // uma reabre pelo MESMO caminho do boot. Falha de reabertura degrada só aquela
              // comunidade (§3.3), não a restauração.
              await identidadePronta();
              for (const row of r.rows) {
                const isHost = row.communitySeed !== undefined;
                if (isHost) {
                  storeCommunitySeed(
                    deps.manifest,
                    {
                      communityId: row.communityId,
                      coreKey: Buffer.from(row.coreKey, 'hex'),
                      blobsKey: Buffer.from(row.blobsKey, 'hex'),
                      communitySeed: Buffer.from(row.communitySeed as string, 'hex'),
                      isHost: true,
                      joinedAt: now(),
                    },
                    deps.dataKey,
                  );
                } else {
                  deps.manifest.upsertCommunity({
                    communityId: row.communityId,
                    coreKey: Buffer.from(row.coreKey, 'hex'),
                    blobsKey: Buffer.from(row.blobsKey, 'hex'),
                    isHost: false,
                    joinedAt: now(),
                  });
                }
                try {
                  runtime.register(
                    await runtime.openCommunity({
                      community_id: row.communityId,
                      core_key: Buffer.from(row.coreKey, 'hex'),
                      blobs_key: Buffer.from(row.blobsKey, 'hex'),
                      is_host: isHost ? 1 : 0,
                      left_at: null,
                    }),
                  );
                } catch {
                  fanout.emit({
                    topic: 'host.statusChanged',
                    data: { communityId: row.communityId, status: 'degraded', reason: 'E_INTERNAL' },
                  });
                }
              }
              await identidadePronta();
              return { ok: true as const, publicKey: r.publicKey, handle: r.handle, communities: r.communities };
            },
            wipe: wipeAgora,
            // §3.2 L-2 — a tela dedicada que a limitação declarada exige (§15.4, emenda).
            acceptInsecureKeystore: () => servicoIdentidade.acceptInsecureKeystore(),
          },
    search,
    succession,
    media: { dispatcher: router },
    // §13 — anexos compostos aqui: o core local de cada comunidade, o resolver da
    // `view.db` e o diálogo do main injetado. O caminho de arquivo nunca cruza o IPC-R.
    attachments: blobAttachmentPort({
      blobs,
      blobsCoreKeyOf: (cid) => blobs.localCoreKey(cid),
      pickFile: deps.pickFile ?? (() => null),
      resolveAttachment: viewAttachmentResolver(deps.view),
      ...(deps.onReveal !== undefined ? { onReveal: deps.onReveal } : {}),
    }),
    messages: {
      writeStateFor: (cid) => client.writeStateFor(cid),
      selfKeyHex,
      submitQueued: (cid, input) => client.submitQueued(cid, input),
      retryQueued: (opId) => outboxDe(deps.manifest, runtime, opId).retry(opId),
      cancelQueued: (opId) => outboxDe(deps.manifest, runtime, opId).cancelQueued(opId),
    },
    community: {
      leave: (cid) => {
        const r = leave(cid);
        if (r.ok) runtime.forget(cid);
        return r;
      },
      create: async (input: CreateCommunityInput) => await createCommunity({ ...depsAdmissao, coresDir }, input),
      // §15.4 "Comunidade" — as três superfícies que faltavam: ativação (residência de
      // §8.1, escolha local), encerramento (⏱ main-confirmed, draining de §18.7) e
      // esquecimento (main-confirmed, réplica left/removed antes do retain_until).
      activate: (communityId: string | null) =>
        communityActivate({ ...depsEstrutura, manifest: deps.manifest }, communityId),
      end: async (a: { communityId: string; reason?: string }) => await endCommunity(depsAdmissao, a),
      forget: async (cid: string) =>
        await forgetCommunity(
          {
            manifest: deps.manifest,
            forget: (id) => {
              runtime.forget(id);
              client.removeCommunity(id);
            },
            purge: async () => {
              await purgeUmaComunidade({ manifest: deps.manifest, view: deps.view, dataDir: deps.dataDir }, cid);
            },
            // §18.5/B8 — comunidade terminal também é esquecível: "sair primeiro" não é um
            // caminho, é um `E_COMMUNITY_ENDED` (estágio 5 do `fold`).
            isEnded: (id) => runtime.get(id)?.projector.ds.community.endedAt !== undefined,
          },
          cid,
        ),
    },
    invites: {
      create: async (args: InviteCreateArgs) => {
        const r = await inviteCreate(depsAdmissao, args);
        if (!r.ok) return r;
        // O fio do IPC-R leva hex; o `code` só existe NESTA resposta (§15.4).
        return {
          ok: true,
          invitePublicKey: r.invitePublicKeyHex,
          code: r.code,
          seq: r.seq,
          ...(r.expiresAt !== undefined ? { expiresAt: r.expiresAt } : {}),
          ...(r.maxUses !== undefined ? { maxUses: r.maxUses } : {}),
        };
      },
      revoke: async (args) => await inviteRevoke(depsAdmissao, { communityId: args.communityId, invitePublicKeyHex: args.invitePublicKey }),
      resolve: async ({ codeOrLink }) => await admissao.resolve({ codeOrLink }),
      redeem: async ({ codeOrLink, displayName, avatarColor }) =>
        await admissao.redeem({
          codeOrLink,
          ...(displayName !== undefined ? { displayName } : {}),
          ...(avatarColor !== undefined ? { avatarColor } : {}),
        }),
    },
    // §15.4 estrutura — as sete ops ⏱ de canal/categoria/comunidade sobre a mesma ponte de
    // submissão dos convites; a permissão é conferida no DS e revalidada pelo `fold`.
    structure: {
      channelCreate: async (a) => await channelCreate(depsEstrutura, a),
      channelUpdate: async (a) => await channelUpdate(depsEstrutura, a),
      channelMove: async (a) => await channelMove(depsEstrutura, a),
      channelDelete: async (a) => await channelDelete(depsEstrutura, a),
      categoryCreate: async (a) => await categoryCreate(depsEstrutura, a),
      categoryRename: async (a) => await categoryRename(depsEstrutura, a),
      categoryDelete: async (a) => await categoryDelete(depsEstrutura, a),
      communityUpdate: async (a) => await communityUpdate(depsEstrutura, a),
    },
    // §15.4 cargos/membros/moderação — as onze ops ⏱ sobre a mesma ponte de submissão;
    // permissão conferida no DS e revalidada pelo `fold`, hierarquia nunca duplicada aqui.
    moderation: {
      roleCreate: async (a) => await roleCreate(depsEstrutura, a),
      roleUpdate: async (a) => await roleUpdate(depsEstrutura, a),
      roleMove: async (a) => await roleMove(depsEstrutura, a),
      roleDelete: async (a) => await roleDelete(depsEstrutura, a),
      memberSetRoles: async (a) => await memberSetRoles(depsEstrutura, a),
      memberSetNickname: async (a) => await memberSetNickname(depsEstrutura, a),
      modKick: async (a) => await modKick(depsEstrutura, a),
      modBan: async (a) => await modBan(depsEstrutura, a),
      modRevokeBan: async (a) => await modRevokeBan(depsEstrutura, a),
      modTimeout: async (a) => await modTimeout(depsEstrutura, a),
      modRemoveTimeout: async (a) => await modRemoveTimeout(depsEstrutura, a),
    },
    invitesQuery: queryInvitesPort({ stateFor, manifest: deps.manifest }),
    // §15.6 leitura — a `view.db` responde; o DS nomeia quem aparece; o manifest põe por
    // cima o que é local (lido, mudo, recolhido) e o estado do cache de anexos.
    reads: queryReadPorts({
      view: deps.view,
      manifest: deps.manifest,
      stateFor,
      selfKeyHex,
      now,
      replicationOf: (cid) => client.getState(cid) ?? { state: 'catching-up', lag: 0 },
      blobs,
      // DR-29/DR-33 — o estado de conexão observado e a presença efêmera (§17.6), ambos
      // produzidos nesta raiz; as consultas só recortam.
      hostConnection: (cid) => ({
        status: runtime.hostStatus?.statusOf(cid) ?? 'unknown',
        attempt: runtime.hostStatus?.attemptOf(cid) ?? 0,
      }),
      // §15.6 `query.voiceQueue` (§16.4) — o instantâneo efêmero vem do dispatcher da
      // comunidade: no host é o estado vivo; no membro, o último `voice.queueChanged`.
      voiceQueue: (cid, channelId) => runtime.snapshotFilaDe(cid, channelId),
      presenceStatuses: (cid) => {
        const c = runtime.get(cid);
        const mapa = new Map<string, string>();
        for (const e of c?.presence.getPresenceEntries(cid, now()) ?? []) mapa.set(e.identityKey, e.status);
        return mapa;
      },
      // §11.2/§15.6 — a fila é do manifest; sem recorte, todas as comunidades na ordem de
      // enfileiramento global (local_seq).
      outboxRows: (cid) =>
        cid === undefined
          ? (deps.manifest.listCommunities() as Array<{ community_id: string }>).flatMap((r) => deps.manifest.all(r.community_id))
          : deps.manifest.all(cid),
      comunidadesRows: () => deps.manifest.listCommunities() as Array<Record<string, unknown>>,
    }),
    // §15.4 preferências locais — escrita direta no LS (§6.15), sem host e sem fila;
    // markRead passa pelo recalcador para responder zero literal (RT-03).
    // §15.4 (emenda de 2026-08-23) — o gatilho local da assinatura de typing de §17.6: a UI
    // chama ao abrir canal; no host a assinatura é local, no membro espelha por §16.2.
    typing: {
      subscribe: ({ communityId, channelId, on }) => {
        const eu = selfKeyHex();
        if (eu === null) return { ok: false as const, code: 'E_NO_IDENTITY' };
        const c = runtime.get(communityId);
        if (c === undefined) return { ok: false as const, code: 'E_NOT_FOUND' };
        if (c.isHost) {
          c.presence.subscribeChannel({ communityId, subscriberKey: eu, channelId, on });
          return { ok: true as const };
        }
        // Membro: a assinatura mora no host e é efêmera — sem canal vivo não há frame
        // (§11.8), e quem reabre o canal re-assina quando a conexão voltar.
        void c.rpc
          ?.call('subscribeChannel', new Uint8Array(Buffer.from(JSON.stringify({ channelId, on }), 'utf8')))
          .catch(() => {});
        return { ok: true as const };
      },
      /**
       * §17.6 (emenda de 2026-09-06) — publicar o próprio "digitando…". O caminho é o mesmo
       * da presença: no host o agregador local; no membro, `presencePublish` de §16.2 com
       * `typingChannelId`, que é o campo que a spec sempre teve e que ninguém preenchia.
       *
       * `invisible` não publica typing — §17.6 (emenda de 2026-09-05): o "digitando…"
       * carrega identidade, canal e o fato de estar conectado agora, exatamente o que o modo
       * invisível esconde. A recusa é silenciosa: quem escolheu ficar invisível não precisa
       * de aviso a cada tecla.
       */
      publish: ({ communityId, channelId }) => {
        const eu = selfKeyHex();
        if (eu === null) return { ok: false as const, code: 'E_NO_IDENTITY' };
        const c = runtime.get(communityId);
        if (c === undefined) return { ok: false as const, code: 'E_NOT_FOUND' };
        const status = runtime.localPresence.get(communityId) ?? 'online';
        if (status === 'invisible') return { ok: true as const };
        if (c.isHost) {
          const r = c.presence.publishTyping({ communityId, identityKey: eu, channelId });
          return r.ok ? { ok: true as const } : { ok: false as const, code: r.code };
        }
        const estado = runtime.hostStatus?.statusOf(communityId) ?? 'unknown';
        // Sem canal vivo não há para quem publicar, e efêmero não enfileira (§11.8).
        if (estado !== 'online' && estado !== 'connecting') return { ok: true as const };
        void c.rpc
          ?.call(
            'presencePublish',
            new Uint8Array(Buffer.from(JSON.stringify({ status, typingChannelId: channelId }), 'utf8')),
          )
          .catch(() => {});
        return { ok: true as const };
      },
    },
    preferences: {
      channelSetMuted: (a) => channelSetMuted(depsPreferencias, a),
      channelMarkRead: (a) => channelMarkRead(depsPreferencias, a),
      threadMarkRead: (a) => threadMarkRead(depsPreferencias, a),
      categorySetCollapsed: (a) => categorySetCollapsed(depsPreferencias, a),
      navSetActive: (a) => navSetActive(depsPreferencias, a),
      settingsSetDevice: (a) => settingsSetDevice(depsPreferencias, a),
      settingsSetVolume: (a) => settingsSetVolume(depsPreferencias, a),
      settingsSetParticipantVolume: (a) => settingsSetParticipantVolume(depsPreferencias, a),
      settingsSetNotifications: (a) => settingsSetNotifications(depsPreferencias, a),
    },
    communityQuery: queryCommunityPort({
      stateFor,
      selfKeyHex,
      replicationOf: (cid) => client.getState(cid) ?? { state: 'catching-up', lag: 0 },
      pendingReentryOf: (cid) => succession.pendingReentry(cid),
    }),
    // §14.5/RT-11 — `query.search` devolve `partial: true` quando o estado de replicação
    // NÃO é `synced`, ou o host está offline, ou a comunidade está em
    // `partialInterpretation`. O módulo de busca só ecoa a causa; decidi-la é da raiz, que
    // é quem tem os três sinais. Sem este produtor a busca respondia `partial: false`
    // sempre — inclusive numa réplica que ainda não leu metade do log.
    partialReason: (communityId) => {
      const c = runtime.get(communityId);
      if (c === undefined) return undefined;
      return searchPartialReason({
        partialInterpretation: c.projector.ds.partialInterpretation,
        replication: client.getState(communityId)?.state,
        isHost: c.isHost,
        hostStatus: runtime.hostStatus?.statusOf(communityId) ?? 'unknown',
      });
    },
    exitImpact: hostExitImpactPort({
      get communities() {
        return runtime
          .communities()
          .filter((c) => c.isHost)
          .map((c) => ({ communityId: c.communityId, name: c.projector.ds.community.name }));
      },
      onlineCount: (cid) => runtime.get(cid)?.host?.connections.size ?? 0,
      // **Pessoas, não canais** (emenda de 2026-09-06 em §18.7). `sessionCount` conta
      // sessões abertas: o modal de U-06 dizia "1 em chamada" para oito pessoas no mesmo
      // canal, e dizia o mesmo para o host sozinho num canal — oferecendo a própria
      // presença como motivo para não fechar o app. Quem fecha não se conta.
      inCallCount: (cid) => runtime.get(cid)?.host?.voice.participantCount(selfKeyHex() ?? undefined) ?? 0,
      // §18.7 passo 1 — "quantas ops ainda não replicaram" é contra a barreira de PARES,
      // não contra a projeção local: um host em dia consigo mesmo e sozinho no swarm lia
      // zero, que é justamente o caso em que fechar perde tudo (B10).
      pendingReplication: (cid) => {
        const c = runtime.get(cid);
        return c === undefined ? 0 : runtime.opsNaoReplicadas(c);
      },
    } as Parameters<typeof hostExitImpactPort>[0]),
    // §17.7 — o voluntariado de relay, ligado ao produto (B30, parcial).
    //
    // `l2/relay` estava pronto e testado desde a fase 9, e a composição nunca o injetava:
    // `relay.enable`/`relay.disable`/`relay.respondConsent` respondiam `E_UNKNOWN_COMMAND`
    // no produto inteiro, e a superfície de U-13 não tinha o que chamar. Quem substitui
    // continua sendo `extraCommands`, para o teste poder injetar o seu.
    ...(voluntario !== null ? { relay: voluntario, relayConsent: consentimentoDeRelay } : {}),
    ...(deps.extraCommands ?? {}),
  } as CoreCommandDeps);

  // §15.1 — `hello` é o PRIMEIRO quadro de todo canal, e é ele que fixa o `epoch` do lado
  // do renderer. Sai aqui, depois da última linha do roteador estar registrada e antes de
  // qualquer `ev`: um `req` que chegue logo em seguida já encontra o comando de pé.
  // `schemaVersion` é o da `view`, que é o esquema que as queries de §15.6 leem; o do
  // `manifest` é interno ao núcleo e continua visível em `core.status`.
  ipc.sendHello(deps.foldBuildId, OP_VERSION, Number(VIEW_SCHEMA_VERSION));

  // ── §3.3 — o boot termina em `ready` (com identidade) ou `awaiting-identity` (sem) ────
  runtime.setPhase(identidade !== null ? 'ready' : 'awaiting-identity');
  // §15.5 — reinício após crash é fato do epoch; pronto é fato da fase. O renderer que
  // assinar depois lê `core.status` — eventos não são replay.
  if (deps.epoch > 1) {
    fanout.emit({ topic: 'core.restarted', data: { epoch: deps.epoch, attempt: deps.epoch - 1 } }, {});
  }
  if (identidade !== null) {
    fanout.emit({ topic: 'core.ready', data: { phase: 'ready', epoch: deps.epoch } }, {});
  }
  logger.info('core', 'booted', { epoch: deps.epoch, code: runtime.phase });

  return runtime;
}

/**
 * §13.7 regra 2 / §22.4 — o blob está **protegido** do LRU quando é anexo enviado por esta
 * identidade e a mensagem que o carrega continua viva (existe e não foi tombstonada). A
 * fonte é a `view.db`: a linha de `attachments` some com a reprojeção do log, e o
 * `deleted_at` da mensagem é o tombstone de §8.
 *
 * A chave do cache é o `blobIdHex` — os 16 primeiros bytes do hash (§13.2) —, então o
 * casamento é por prefixo de `hash`, na mesma linha em que o `blobs_core_key` bate. Sem
 * identidade local, nada é protegido: não há "meu" anexo sem "mim".
 */
function anexoProprioVivo(view: ViewDb, identity: BootIdentity | null, row: { blobsCoreKeyHex: string; blobIdHex: string }): boolean {
  if (identity === null) return false;
  if (!/^[0-9a-f]{64}$/i.test(row.blobsCoreKeyHex) || !/^[0-9a-f]{32}$/i.test(row.blobIdHex)) return false;
  const encontrado = view
    .prepare(
      'SELECT 1 FROM attachments a JOIN messages m ON m.community_id = a.community_id AND m.id = a.message_id ' +
        'WHERE a.blobs_core_key = ? AND a.owner_key = ? AND m.deleted_at IS NULL AND lower(hex(a.hash)) LIKE ? LIMIT 1',
    )
    .get(Buffer.from(row.blobsCoreKeyHex, 'hex'), identity.publicKey, `${row.blobIdHex.toLowerCase()}%`);
  return encontrado !== undefined;
}

/**
 * Fila em que um `opId` vive. §11.2 dá **uma outbox por comunidade** e §15.4 (`message.retry`,
 * `message.cancelQueued`) manda só o id: quem sabe a que comunidade ele pertence é a linha em
 * `local_outbox`, e é ela que decide o destino — nunca uma varredura que tocaria as demais.
 */
function outboxDe(manifest: ManifestDb, runtime: CoreRuntime, opId: string): Pick<Outbox, 'retry' | 'cancelQueued'> {
  const row = manifest.byOpId(opId);
  const outbox = row === undefined ? null : (runtime.get(row.community_id)?.outbox ?? null);
  if (outbox !== null) return outbox;
  return {
    retry: () => ({ ok: false, code: 'E_NOT_FOUND' }),
    cancelQueued: () => ({ ok: false, code: 'E_NOT_FOUND' }),
  };
}

/**
 * Um intervalo com relógio injetável, na mesma disciplina do `VoiceTicketRenewer`: em
 * produto é o `setInterval` do processo; na suíte, o `schedule` de teste (que costuma ser
 * no-op) mantém a composição determinística e sem temporizador de parede pendurado.
 */
function agendarIntervalo(fn: () => void, ms: number, deps: { readonly schedule?: (f: () => void, ms: number) => unknown; readonly cancel?: (h: unknown) => void }): () => void {
  const agendar = deps.schedule ?? ((f: () => void, periodo: number) => setInterval(f, periodo));
  const cancelar = deps.cancel ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
  const handle = agendar(fn, ms);
  return () => cancelar(handle);
}

/**
 * §17.5 — `share.health` é só ao apresentador; os demais eventos vão **aos da chamada**.
 *
 * Todo evento carrega o canal (§6.16), então os três ramos são endereçados do mesmo jeito.
 * Antes só o `started` era: `viewersChanged` e `stopped` devolviam `null`, que em `empurra`
 * significa "todos os conectados" — a comunidade inteira recebia o movimento de espectador
 * de uma chamada da qual não participa. §15.5 diz "só a participantes da sessão", e a
 * audiência de tela é a chamada (A19).
 */
function destinatariosDaTela(voice: VoiceHostSessions, ev: ShareSessionEvent): readonly string[] {
  const session = voice.sessionOf(ev.channelId);
  return session === null ? [] : session.participants.map((p) => p.keyHex);
}

/**
 * §13.5/§22.2 (`staging.gc`) — o staging `done` tem referência viva quando uma mensagem
 * projetada o carrega (linha em `attachments`) OU uma op ainda na fila pode vir a
 * carregá-lo: o envelope de um `message.send` pendente contém os bytes do core e do hash,
 * e procurá-los no blob bruto é conservador na direção certa (mantém em vez de apagar).
 * Staging sem comunidade/core conhecidos é mantido — sem fonte, nenhuma poda.
 */
function stagingReferenciado(view: ViewDb, manifest: ManifestDb, blobs: BlobManager, row: { readonly communityId: string | null; readonly hash: Buffer | null }): boolean {
  if (row.communityId === null || row.hash === null) return true;
  const coreKey = blobs.localCoreKey(row.communityId);
  if (coreKey === null) return true;
  const prefixo = `${row.hash.subarray(0, 16).toString('hex')}%`;
  const projetada = view
    .prepare('SELECT 1 FROM attachments WHERE community_id = ? AND blobs_core_key = ? AND lower(hex(hash)) LIKE ? LIMIT 1')
    .get(row.communityId, coreKey, prefixo);
  if (projetada !== undefined) return true;
  const naFila = manifest.raw
    .prepare('SELECT 1 FROM local_outbox WHERE community_id = ? AND state != \'dropped\' AND (instr(envelope, ?) > 0 OR instr(envelope, ?) > 0) LIMIT 1')
    .get(row.communityId, coreKey, row.hash);
  return naFila !== undefined;
}

/** §27.2 — `wal_checkpoint(TRUNCATE)` só acima de 64 MiB de WAL. */
const DB_WAL_TRUNCATE_BYTES = 64 * 1024 * 1024;

/**
 * §22.2 `db.maintenance` — `PRAGMA optimize` nos dois bancos e checkpoint do WAL acima do
 * teto. Falha de manutenção nunca derruba o núcleo (§22.5): o próximo ciclo tenta de novo.
 */
function manutencaoDeBancos(bancos: readonly (ManifestDb | ViewDb)[]): void {
  for (const banco of bancos) {
    try {
      banco.pragma('optimize');
      const wal = fs.statSync(`${banco.path}-wal`);
      if (wal.size > DB_WAL_TRUNCATE_BYTES) banco.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // Sem WAL ainda (ou arquivo já fechado): nada a podar neste ciclo.
    }
  }
}

/** §24.1/§27.2 — retenção e teto totais do log estruturado. */
export const LOG_RETENTION_DAYS = 7;
export const LOG_MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const LOG_FILE_RE = /^core-\d{4}-\d{2}-\d{2}\.ndjson$/;

/**
 * §22.2 `log.rotate` / §24.1 — aplica retenção (`LOG_RETENTION_DAYS`) e teto total
 * (`LOG_MAX_TOTAL_BYTES`) sobre `logs/core-YYYY-MM-DD.ndjson`, sempre do mais velho para o
 * mais novo. Os PRODUTORES de log chegam com o shell; a rotação não espera por eles.
 */
function rotacionarLogs(dir: string, agora: number): void {
  let arquivos: string[];
  try {
    arquivos = fs.readdirSync(dir).filter((f) => LOG_FILE_RE.test(f)).sort();
  } catch {
    return; // diretório ainda não existe — nenhum log escrito até aqui
  }
  const limite = agora - LOG_RETENTION_DAYS * 24 * 60 * 60_000;
  let total = 0;
  const tamanhos = new Map<string, number>();
  for (const f of arquivos) {
    try {
      const tamanho = fs.statSync(path.join(dir, f)).size;
      tamanhos.set(f, tamanho);
      total += tamanho;
    } catch {}
  }
  for (const f of arquivos) {
    const tamanho = tamanhos.get(f) ?? 0;
    // `core-YYYY-MM-DD.ndjson` → meia-noite UTC daquele dia; nome fora da forma não expira.
    const y = Number(f.slice(5, 9));
    const m = Number(f.slice(10, 12));
    const d = Number(f.slice(13, 15));
    const expirado =
      Number.isInteger(y) && Number.isInteger(m) && Number.isInteger(d) && Date.UTC(y, m - 1, d) < limite;
    if (!expirado && total <= LOG_MAX_TOTAL_BYTES) continue;
    try {
      fs.rmSync(path.join(dir, f));
      total -= tamanho;
    } catch {}
  }
}

/**
 * §18.4 passo 6 / §22.2 `removed.purge` — réplica com `retain_until` vencido sai inteira:
 * esquecida do runtime e do swarm, apagada do `manifest.db` (fila, LS, segredos) e da
 * `view.db` (CS + snapshot), e removida do disco (core do log e core de blobs local).
 * Comunidade aberta aqui é esquecida PRIMEIRO — job zumbi em banco purgado não existe.
 */
/**
 * A desmontagem de UMA réplica local (§18.4 passo 6): esquecida do runtime e do swarm,
 * apagada do `manifest.db` (fila, LS, segredos) e da `view.db` (CS + snapshot), e removida
 * do disco (core do log e core de blobs local). Compartilhada pelo job `removed.purge`
 * (cadência de §22.2) e por `community.forget` (§15.4, fora da cadência).
 */
async function purgeUmaComunidade(
  args: { manifest: ManifestDb; view: ViewDb; dataDir: string },
  communityId: string,
): Promise<void> {
  const canais = (args.view.prepare('SELECT id FROM channels WHERE community_id = ?').all(communityId) as Array<{ id: string }>).map((r) => r.id);
  const blobsDir = path.join(args.dataDir, 'cores', 'blobs', (args.manifest.getMemberBlobsCore(communityId)?.coreKey ?? Buffer.alloc(0)).toString('hex'));
  args.manifest.purgeCommunityData(communityId, canais);
  args.view.purgeCommunityData(communityId);
  await fs.promises.rm(path.join(args.dataDir, 'cores', communityId), { recursive: true, force: true }).catch(() => {});
  await fs.promises.rm(blobsDir, { recursive: true, force: true }).catch(() => {});
}

async function purgeRemovidas(args: {
  runtime: CoreRuntime;
  client: CommunityClient;
  manifest: ManifestDb;
  view: ViewDb;
  dataDir: string;
  now(): number;
}): Promise<number> {
  const agoraMs = args.now();
  let purgadas = 0;
  for (const row of args.manifest.listCommunities() as Array<{
    community_id: string;
    left_at: number | null;
    removed_reason: string | null;
    retain_until: number | null;
  }>) {
    // Só saída registrada (ban/kick/unauthorized/left) tem política de retenção; linha sem
    // `retain_until` não venceu — apagar seria inventar prazo.
    if (row.removed_reason === null || row.left_at === null || row.retain_until === null) continue;
    if (row.retain_until > agoraMs) continue;
    // Esquecida do runtime ANTES de purgar (§54.1) — job zumbi em banco purgado não existe.
    args.runtime.forget(row.community_id);
    args.client.removeCommunity(row.community_id);
    await purgeUmaComunidade({ manifest: args.manifest, view: args.view, dataDir: args.dataDir }, row.community_id);
    purgadas++;
  }
  return purgadas;
}
