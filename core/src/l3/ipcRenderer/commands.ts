// Registro dos comandos IPC-R das superfícies de diagnóstico, busca, relay e mídia
// (§15.3 classes, §15.4 tabela de comandos, §15.6 `query.search`).
//
// §4: `ipcRenderer` é o roteamento e a autorização de comando — nenhuma regra de domínio
// aqui: cada handler traduz a forma de §15.4 para uma chamada de L2 e devolve `{code}` do
// catálogo §20.2 quando o módulo recusa. O que este roteador NÃO faz é decidir nada.
//
// Modo host vs modo membro: as superfícies de voz/tela são decisões do host (§17.4/§17.5).
// Quando esta instalação hospeda, a composição injeta o dispatcher local (sobre
// `VoiceHostSessions`/`ShareHostSessions`); quando não hospeda, o dispatcher remoto (via
// `rpcClient`) entra pela mesma interface — a forma da fronteira não muda.

import type { Diagnostics } from '../../l2/diagnostics/index.ts';
import type { RelayConsentPort, RelayVolunteer } from '../../l2/relay/index.ts';
import type { InvitePreview } from '../../l2/invites/index.ts';
import { memberHasPermission } from '../../l2/voiceCoordinator/host.ts';
import type {
  SubmissionInput,
  QueuedSubmissionResult,
  WriteStatePort,
} from '../../l2/communityClient/index.ts';
import type { SearchPartialReason, SearchService } from '../../l2/search/index.ts';
import type { SuccessionService } from '../../l2/succession/index.ts';
import { isShareQuality } from '../../l2/shareStar/index.ts';
import type { MediaDispatcher } from './media.ts';
import type { IpcServer } from './index.ts';

/** Recusa nomeada → erro com `.code` que o IpcServer traduz na resposta (§20.1). */
function refuse(code: string): never {
  throw Object.assign(new Error(code), { code });
}

function okOrThrow<T extends { readonly ok: boolean }>(result: T): Extract<T, { readonly ok: true }> {
  if (result.ok !== true) refuse((result as { code?: string }).code ?? 'E_INTERNAL');
  return result as Extract<T, { readonly ok: true }>;
}

/**
 * Superfície de voz/tela desta instalação. A forma da fronteira é uma só; quem troca é o
 * dispatcher: `localMediaDispatcher` quando esta instalação hospeda (§17.4/§17.5 decididos
 * aqui) e `remoteMediaDispatcher` quando não hospeda (os mesmos comandos, por §16.2).
 */
export interface MediaSurfaceDeps {
  dispatcher: MediaDispatcher;
}

/**
 * Superfície de mensagens (§15.4 "Mensagens" — todas **A**, §11.1). A decisão de domínio é
 * da ponte de submissão em `communityClient`; aqui só a forma da fronteira, a coluna Perm.
 * lida sobre o recorte do DS (permissões nomeadas; "própria \| manage_messages" no delete)
 * e o mapeamento do resultado. O desfecho real chega pelos eventos de §15.5, emitidos pela
 * outbox e ligados ao fan-out pelo boot.
 */
export interface MessageSurfaceDeps {
  /** Recorte estrutural do DS corrente — null quando a comunidade não está aberta aqui. */
  writeStateFor(communityId: string): WriteStatePort | null;
  /** Chave pública hex da identidade local — null sem identidade carregada. */
  selfKeyHex(): string | null;
  /** Caminho A da ponte: sela, enfileira na outbox e responde `{opId, state}` na hora. */
  submitQueued(communityId: string, input: SubmissionInput): QueuedSubmissionResult;
  /** `message.retry{opId}` — reenfileira o MESMO envelope (§11.3, fecha DS-16). */
  retryQueued(opId: string):
    | { readonly ok: true; readonly state: 'queued' }
    | { readonly ok: false; readonly code: string };
  /** `message.cancelQueued{opId}` — descarte com motivo nomeado (§11.7). */
  cancelQueued(opId: string): { readonly ok: true } | { readonly ok: false; readonly code: string };
}

/**
 * Referência a um blob no fio do IPC-R. `Buffer` não atravessa JSON (§15.1): as chaves e o
 * hash viajam em hex, e o `blobId` é o quádruplo de §7.2.1.
 */
export type BlobRefWire = {
  readonly blobsCoreKey: string;
  readonly blobId: { readonly byteOffset: number; readonly blockOffset: number; readonly blockLength: number; readonly byteLength: number };
};

/** O que `blob.stage` devolve (§15.4) e o que vira `attachment` na op (§7.4.1). */
export type StagedAttachment = BlobRefWire & {
  readonly name: string;
  readonly sizeBytes: number;
  readonly kind: number;
  readonly hash: string;
};

/**
 * Anexos e download (§15.4 "Arquivos e diagnóstico", §13).
 *
 * O caminho de arquivo **nunca** cruza o IPC-R (T-16/DR-37): o renderer pede um ticket, o
 * main abre o diálogo e o núcleo recebe o `staging.ticket` (§15.7). Da mesma forma, nada que
 * descreva o blob volta do renderer: `message.send` manda só o `ticketId`, e quem monta o
 * `attachment` é o núcleo, a partir do que ele mesmo escreveu (§13.7 regra 1).
 */
export interface AttachmentSurfaceDeps {
  /** `file.pickForAttachment` — o main abre o diálogo e devolve o ticket (§15.7). */
  pick(communityId: string): Promise<{ readonly ticketId: string; readonly name: string; readonly sizeBytes: number; readonly kind: number }>;
  /** `blob.stage{ticketId}` — lê, faz hash e escreve no core de blobs do próprio membro. */
  stage(ticketId: string): Promise<StagedAttachment>;
  /** §13.7 regra 1 — o que este núcleo staged para o ticket, ou `null`. */
  staged(ticketId: string): StagedAttachment | null;
  /** `blob.download` — dispara e devolve o estado corrente; o progresso vai por evento. */
  download(a: BlobRefWire & { readonly communityId: string }): { readonly state: string };
  cancel(a: BlobRefWire): void;
  /** Tipo do blob baixado — decide a classe de §15.3 (`archive` é main-confirmed). */
  kindOf(a: BlobRefWire): number | null;
  /** `blob.reveal` — só depois da allowlist de §13.6; quem age é o main (`shell.open`). */
  reveal(a: BlobRefWire & { readonly mode: 'open' | 'folder' }): { readonly ok: true } | { readonly ok: false; readonly code: string };
}

export type CoreCommandDeps = {
  diagnostics: Diagnostics;
  search: SearchService;
  /** Causa `partial` de RT-11 (§14.5) decidida fora — undefined = réplica íntegra. */
  /** §14.5/RT-11 — causa de `partial` naquela comunidade; `undefined` ⇒ resultado completo. */
  partialReason?: (communityId: string) => SearchPartialReason | undefined;
  relay?: RelayVolunteer;
  relayConsent?: RelayConsentPort;
  media?: MediaSurfaceDeps;
  messages?: MessageSurfaceDeps;
  /**
   * Ciclo de vida da comunidade local (§15.4 "Comunidade"). A saída é a exceção de §11.1:
   * efeito local imediato — `left_at`, saída do swarm, descarte da fila com motivo
   * nomeado — enquanto o kind `member.leave` enfileira para os demais (L-22). A criação
   * (§19.1) é a orquestração de §5.3: semente → manifest FULL → gênese em um append.
   * A orquestração é da composição/boot; aqui só a fronteira.
   */
  community?: {
    leave(communityId: string):
      | { readonly ok: true; readonly opId: string; readonly droppedQueued: number }
      | { readonly ok: false; readonly code: string };
    create?(input: {
      readonly name: string;
      readonly iconEmoji?: string;
      readonly iconColor?: number;
      readonly description?: string;
    }): Promise<{ ok: true; communityId: string; defaultChannelId: string } | { ok: false; code: string; field?: string }>;
    /** `community.activate` (§8.1) — residência do DS, escolha local. */
    activate?(communityId: string | null): { ok: true; residency: 'full' | 'light' } | { ok: false; code: string };
    /** `community.end ⏱` (§18.5/§18.7) — main-confirmed; draining com orçamento na resposta. */
    end?(a: { readonly communityId: string; readonly reason?: string }): Promise<
      | { ok: true; seq: number; replicatedTo: number }
      | { ok: false; code: string; field?: string }
    >;
    /** `community.forget` (§18.4) — main-confirmed; réplica left/removed antes do prazo. */
    forget?(communityId: string): Promise<{ ok: true } | { ok: false; code: string }>;
  };
  /**
   * Convites (§15.4 "Convites", §12). Emissão/revogação são ops ⏱ pela porta do host;
   * resolve/redeem falam o protocolo pré-membro `p2p-admission/1` (§16.1) com o host da
   * comunidade. O `code` só existe na resposta de quem cria — nunca no log nem em evento.
   */
  invites?: {
    create(args: {
      readonly communityId: string;
      readonly expiresInDays?: number;
      readonly maxUses?: number;
      readonly label?: string;
    }): Promise<
      | { ok: true; invitePublicKey: string; code: string; expiresAt?: number; maxUses?: number; seq: number }
      | { ok: false; code: string; field?: string }
    >;
    revoke(args: { readonly communityId: string; readonly invitePublicKey: string }): Promise<{ ok: true; seq: number } | { ok: false; code: string }>;
    resolve(args: { readonly codeOrLink: string }): Promise<{ ok: true; preview: InvitePreview } | { ok: false; code: string }>;
    redeem(args: {
      readonly codeOrLink: string;
      readonly displayName?: string;
      readonly avatarColor?: number;
    }): Promise<{ ok: true; communityId: string; defaultChannelId: string; seq: number } | { ok: false; code: string }>;
  };
  /**
   * Estrutura da comunidade (§15.4 "Canais e categorias" + `community.update`). Todas ⏱: a
   * composição submete ao host e responde com o `seq` observado. `manage_channels` e
   * `manage_community` são verificadas lá, sobre o DS — aqui só a forma do argumento.
   */
  structure?: {
    channelCreate(a: {
      communityId: string;
      categoryId: string;
      type: number;
      name: string;
      topic?: string;
      readOnlyForRoleIds?: readonly string[];
      afterChannelId?: string;
    }): Promise<{ ok: true; channelId: string; seq: number; rank?: string } | { ok: false; code: string; field?: string }>;
    channelUpdate(a: {
      communityId: string;
      channelId: string;
      name?: string;
      topic?: string;
      readOnlyForRoleIds?: readonly string[];
    }): Promise<{ ok: true; seq: number } | { ok: false; code: string; field?: string }>;
    channelMove(a: {
      communityId: string;
      channelId: string;
      categoryId: string;
      afterChannelId?: string;
    }): Promise<{ ok: true; seq: number; rank?: string } | { ok: false; code: string; field?: string }>;
    channelDelete(a: { communityId: string; channelId: string }): Promise<{ ok: true; seq: number; droppedQueued: number } | { ok: false; code: string; field?: string }>;
    categoryCreate(a: {
      communityId: string;
      name: string;
      afterCategoryId?: string;
    }): Promise<{ ok: true; categoryId: string; seq: number; rank?: string } | { ok: false; code: string; field?: string }>;
    categoryRename(a: { communityId: string; categoryId: string; name: string }): Promise<{ ok: true; seq: number } | { ok: false; code: string; field?: string }>;
    categoryDelete(a: {
      communityId: string;
      categoryId: string;
      moveChannelsTo?: string;
      deleteChannels?: boolean;
    }): Promise<{ ok: true; seq: number; movedChannels: number; deletedChannels: number } | { ok: false; code: string; field?: string }>;
    communityUpdate(a: {
      communityId: string;
      name?: string;
      iconEmoji?: string;
      iconColor?: number;
      description?: string;
    }): Promise<{ ok: true; seq: number } | { ok: false; code: string; field?: string }>;
  };
  /**
   * Membros, cargos e moderação (§15.4 "Cargos e membros" e "Moderação"). Todas ⏱ e na
   * mesma régua da estrutura: a regra é do `fold` (R-3..R-5, R-10..R-12, R-16, R-26, R-28),
   * a permissão da coluna é conferida aqui de forma advisória sobre o DS (§8.7), e a
   * hierarquia NÃO é duplicada — `E_HIERARCHY`/`E_FOUNDER_IMMUNE`/`E_HOST_IMMUNE`/
   * `E_SELF_TARGET` vêm do `fold`.
   */
  moderation?: {
    roleCreate(a: {
      communityId: string;
      name: string;
      color: number;
      permissions: readonly string[];
      mentionable: boolean;
      afterRoleId?: string;
    }): Promise<{ ok: true; roleId: string; seq: number; rank?: string } | { ok: false; code: string; field?: string }>;
    roleUpdate(a: {
      communityId: string;
      roleId: string;
      name?: string;
      color?: number;
      permissions?: readonly string[];
      mentionable?: boolean;
    }): Promise<{ ok: true; seq: number } | { ok: false; code: string; field?: string }>;
    roleMove(a: {
      communityId: string;
      roleId: string;
      afterRoleId?: string;
      beforeRoleId?: string;
    }): Promise<{ ok: true; seq: number; rank?: string } | { ok: false; code: string; field?: string }>;
    roleDelete(a: { communityId: string; roleId: string }): Promise<
      { ok: true; seq: number; affectedMembers: number; clearedChannelRefs: number } | { ok: false; code: string; field?: string }
    >;
    memberSetRoles(a: {
      communityId: string;
      targetKey: string;
      roleIds: readonly string[];
    }): Promise<{ ok: true; seq: number; appliedRoleIds: string[] } | { ok: false; code: string; field?: string }>;
    memberSetNickname(a: {
      communityId: string;
      nickname: string | null;
    }): Promise<{ ok: true; seq: number } | { ok: false; code: string; field?: string }>;
    modKick(a: { communityId: string; targetKey: string; reason?: string }): Promise<{ ok: true; seq: number } | { ok: false; code: string; field?: string }>;
    modBan(a: {
      communityId: string;
      targetKey: string;
      reason?: string;
    }): Promise<{ ok: true; seq: number; hiddenMessages: number; revokedInvites: number } | { ok: false; code: string; field?: string }>;
    modRevokeBan(a: { communityId: string; targetKey: string }): Promise<{ ok: true; seq: number; restoredMessages: number } | { ok: false; code: string; field?: string }>;
    modTimeout(a: { communityId: string; targetKey: string; until: number; reason?: string }): Promise<{ ok: true; seq: number } | { ok: false; code: string; field?: string }>;
    modRemoveTimeout(a: { communityId: string; targetKey: string }): Promise<{ ok: true; seq: number } | { ok: false; code: string; field?: string }>;
  };
  /**
   * `query.community` de §15.6, montada pela composição sobre o DS real, a replicação e a
   * sucessão (`pendingReentry`, U-18c). Campos sem fonte em código ainda ficam ausentes.
   * `null` é "nada local para esta comunidade" (§20.2).
   */
  communityQuery?: (communityId: string) => unknown;
  /**
   * `query.invites` (§15.6): o que o log diz sobre cada convite, mais o `code` de quem o
   * criou aqui (delta U-04). A composição é quem junta DS e `invite_secrets` — a fronteira
   * só nomeia a comunidade e devolve o recorte.
   */
  invitesQuery?: (communityId: string) => unknown;
  /**
   * As consultas de leitura de §15.6 sobre a `view.db` (estrutura, mensagens e derivados).
   * A fronteira valida a **forma** do argumento (§15.2) e nada mais: recorte, ordenação e
   * paginação são de §23, e moram na composição, junto do banco que responde.
   */
  reads?: {
    structure(communityId: string): unknown;
    /** §15.6 (emenda de 2026-08-28) — `null` quando o canal não tem fila conhecida. */
    voiceQueue?(a: { communityId: string; channelId: string }): unknown;
    messages(a: { communityId: string; channelId: string; cursor?: string; limit?: number; direction?: string }): unknown;
    message(a: { communityId: string; messageId: string }): unknown;
    pinned(a: { communityId: string; channelId: string; cursor?: string; limit?: number }): unknown;
    files(a: { communityId: string; channelId: string; cursor?: string; limit?: number }): unknown;
    links(a: { communityId: string; channelId: string; cursor?: string; limit?: number }): unknown;
    thread(a: { communityId: string; threadId: string; cursor?: string; limit?: number }): unknown;
    threadUnread(a: { communityId: string; channelId?: string; cursor?: string; limit?: number }): unknown;
    reactors(a: { communityId: string; messageId: string; emoji: string; limit?: number }): unknown;
    members(a: {
      communityId: string;
      filter?: { query?: string; roleId?: string; onlyOnline?: boolean };
      cursor?: string;
      limit?: number;
    }): unknown;
    member(a: { communityId: string; identityKey: string }): unknown;
    roles(a: { communityId: string }): unknown;
    bans(a: { communityId: string; cursor?: string; limit?: number }): unknown;
    timeouts(a: { communityId: string; cursor?: string; limit?: number }): unknown;
    auditLog(a: { communityId: string; type?: string; byKey?: string; from?: number; to?: number; cursor?: string; limit?: number }): unknown;
    outbox(a: { communityId?: string }): unknown;
    communities(): unknown;
    preferences(): unknown;
    hostStatus(a: { communityId: string }): unknown;
    selfModeration(a: { communityId: string }): unknown;
    resolveMessageLink(a: { ref: string }): unknown;
  };
  /**
   * Preferências locais de §15.4 ("sem host, sem fila") — escrita direta no LS (§6.15).
   * Nenhuma toca o log; `nav.setActive` é dono único da navegação (DR-32). A fronteira
   * valida a forma do argumento; os enums e as faixas numéricas são do módulo.
   */
  preferences?: {
    channelSetMuted(a: { channelId: string; muted: boolean }): Record<string, never>;
    channelMarkRead(a: { communityId: string; channelId: string }): { unreadCount: number; pendingMentions: number };
    threadMarkRead(a: { communityId: string; threadId: string }): { unreadCount: number };
    categorySetCollapsed(a: { communityId: string; categoryId: string; collapsed: boolean }): Record<string, never>;
    navSetActive(a: { communityId?: string | null; channelId?: string | null }): Record<string, never>;
    settingsSetDevice(a: { kind: string; deviceId: string }): Record<string, never>;
    settingsSetVolume(a: { kind: string; value: number }): Record<string, never>;
    settingsSetParticipantVolume(a: { communityId: string; identityKey: string; volume: number }): Record<string, never>;
    settingsSetNotifications(a: { enabled?: boolean; communityId?: string; level?: string }): Record<string, never>;
  };
  /**
   * Ciclo do núcleo de §15.4 "Identidade e app" (§3.3, §15.6 `CoreStatus`, §18.6). A raiz
   * de composição é quem conduz as fases e a máquina de wipe; aqui só a forma.
   */
  core?: {
    status(): Record<string, unknown>;
    reproject(communityId?: string): Promise<{ ok: true } | { ok: false; code: string }>;
    shutdown(budgetMs?: number): Promise<{ drainedMs: number; pendingOps: number; replicatedTo: number }>;
    wipe(): Promise<{ ok: true } | { ok: false; code: string; stage?: string }>;
  };
  /**
   * Identidade de §15.4/§5.5/§6.1. Os argumentos chegam como estão no fio (`unknown`) —
   * a validação de campo é da mesma régua do `fold`, na composição; a fronteira só roteia.
   */
  identity?: {
    self(): { key: string; displayName: string; handle: string; avatarColor: number; presence: string; createdAt: number } | null;
    create(a: { readonly displayName: unknown; readonly avatarColor: unknown }): Promise<
      | { ok: true; publicKey: string; handle: string; createdAt: number }
      | { ok: false; code: string; field?: string }
    >;
    update(a: { readonly displayName?: unknown; readonly avatarColor?: unknown }): Promise<
      | { ok: true; queued: ReadonlyArray<{ communityId: string; opId: string }> }
      | { ok: false; code: string; field?: string }
    >;
    setPresence(presence: unknown): { ok: true; presence: string } | { ok: false; code: string };
    export(passphrase: unknown): Promise<{ ok: true } | { ok: false; code: string; field?: string }>;
    import(passphrase: unknown): Promise<
      | { ok: true; publicKey: string; handle: string; communities: number }
      | { ok: false; code: string; field?: string }
    >;
    wipe(): Promise<{ ok: true } | { ok: false; code: string; stage?: string }>;
    /**
     * §3.2 L-2 — o aceite explícito do modo inseguro. A limitação declarada já exigia "uma
     * tela dedicada" e um indicador permanente; o que faltava era o gatilho IPC-R para
     * chegar nela, do mesmo modo que faltava para `channel.subscribeTyping` (§56).
     */
    acceptInsecureKeystore(): { ok: true } | { ok: false; code: string };
  };
  /**
   * Gatilho local da assinatura de typing de §17.6 (emenda de 2026-08-23 em §15.4): a UI
   * chama ao abrir canal; no host assina no agregador local, no membro espelha por §16.2.
   */
  typing?: {
    subscribe(a: { readonly communityId: string; readonly channelId: string; readonly on: boolean }): { ok: true } | { ok: false; code: string };
    /**
     * §15.4 (emenda de 2026-09-06) — o outro lado do "digitando…". `subscribeTyping` só
     * declarava interesse em RECEBER; nada nesta fronteira publicava, e o
     * `typingChannelId` de §16.2 não tinha chamador em lugar nenhum do produto: o
     * indicador estava morto nas duas pontas. O teto de 1 / 2 s por autor e canal é do
     * `PresenceManager`; passar dele é `E_RATE_LIMITED`, que a UI ignora em silêncio.
     */
    publish(a: { readonly communityId: string; readonly channelId: string }): { ok: true } | { ok: false; code: string };
  };
  /**
   * Superfície de sucessão (§15.4 "Comunidade", §18.8). As decisões — R-17, camada b de
   * R-18, escrow, plano da continuação — são todas do serviço em L2; aqui só a forma da
   * fronteira e a classe de cada comando: `setSuccessors` é standard, `assumeHost` é
   * **main-confirmed** (§15.3), porque migra a comunidade inteira para um core novo.
   */
  succession?: SuccessionService;
  /** §15.4 "Arquivos e diagnóstico" — anexos e download (§13). */
  attachments?: AttachmentSurfaceDeps;
  /**
   * `host.exitImpact` (§15.4, §18.7). O núcleo é quem sabe: comunidades hospedadas aqui,
   * quantos estão online, quantos em chamada e o que ainda não replicou. A composição junta
   * as fontes; `host.notifyBeforeExit` foi removido (U-06) e nada aqui avisa ninguém.
   */
  exitImpact?: () => Promise<readonly Record<string, unknown>[]> | readonly Record<string, unknown>[];
};

type Arg = Record<string, unknown>;

/** §13.6 — número do `kind` `archive`; a classe de §15.3 depende dele em `blob.reveal`. */
const BLOB_KIND_ARCHIVE = 4;

function str(arg: Arg, key: string): string {
  const v = arg[key];
  if (typeof v !== 'string' || v.length === 0) refuse('E_VALIDATION');
  return v;
}

/**
 * Registra no `IpcServer` os comandos das superfícies integradas nesta fase:
 * diag.*, query.search, relay.* e voz/tela. As classes seguem §15.3 (`query.search` é
 * open; todo o resto aqui é standard).
 */
export function registerCoreCommands(server: IpcServer, deps: CoreCommandDeps): void {
  // ── Ciclo do núcleo e identidade (§15.4 "Identidade e app", §15.3, §3.3, §18.6) ─────

  // §15.3 — `core.status` é open por tabela ("Todas as queries, core.status").
  server.register('core.status', 'open', () => {
    const core = deps.core;
    if (core === undefined) refuse('E_UNKNOWN_COMMAND');
    return core.status();
  });

  // §18.7 — reabrir o estado a partir do log; main-confirmed porque congela o núcleo
  // enquanto dura (a mesma classe de `community.end`).
  server.register('core.reproject', 'main-confirmed', async (rawArg) => {
    const core = deps.core;
    if (core === undefined) refuse('E_UNKNOWN_COMMAND');
    const arg = (rawArg ?? {}) as Arg;
    const communityId = arg['communityId'];
    if (communityId !== undefined && (typeof communityId !== 'string' || communityId.length === 0)) {
      refuse('E_VALIDATION');
    }
    const r = await core.reproject(typeof communityId === 'string' ? communityId : undefined);
    if (!r.ok) refuse(r.code);
    return {};
  });

  // §18.7 — draining com orçamento; a resposta é honesta sobre o que ficou pendente.
  server.register('core.shutdown', 'standard', async (rawArg) => {
    const core = deps.core;
    if (core === undefined) refuse('E_UNKNOWN_COMMAND');
    const arg = (rawArg ?? {}) as Arg;
    const budgetMs = arg['budgetMs'];
    if (budgetMs !== undefined && (typeof budgetMs !== 'number' || !Number.isInteger(budgetMs))) refuse('E_VALIDATION');
    return await core.shutdown(typeof budgetMs === 'number' ? budgetMs : undefined);
  });

  // §5.5/§6.1 — criar identidade é open: é exatamente o que tira o núcleo de
  // `awaiting-identity`, onde não há identidade para exigir.
  server.register('identity.create', 'open', async (rawArg) => {
    const identity = deps.identity;
    if (identity === undefined) refuse('E_UNKNOWN_COMMAND');
    const arg = (rawArg ?? {}) as Arg;
    const r = await identity.create({ displayName: arg['displayName'], avatarColor: arg['avatarColor'] });
    if (!r.ok) throw Object.assign(new Error(r.code), { code: r.code, ...(r.field !== undefined ? { field: r.field } : {}) });
    return { publicKey: r.publicKey, handle: r.handle, createdAt: r.createdAt };
  });

  // §15.4 — **A**, uma op por comunidade: resposta imediata com a fila; o desfecho real
  // chega pelos eventos da outbox.
  server.register('identity.update', 'standard', async (rawArg) => {
    const identity = deps.identity;
    if (identity === undefined) refuse('E_UNKNOWN_COMMAND');
    const arg = (rawArg ?? {}) as Arg;
    const r = await identity.update({ displayName: arg['displayName'], avatarColor: arg['avatarColor'] });
    if (!r.ok) throw Object.assign(new Error(r.code), { code: r.code, ...(r.field !== undefined ? { field: r.field } : {}) });
    return { queued: r.queued };
  });

  // §6.1 — presença local, efêmera; `invisible` não publica (o loop sabe).
  server.register('identity.setPresence', 'standard', (rawArg) => {
    const identity = deps.identity;
    if (identity === undefined) refuse('E_UNKNOWN_COMMAND');
    const r = identity.setPresence(((rawArg ?? {}) as Arg)['presence']);
    if (!r.ok) refuse(r.code);
    return {};
  });

  // §5.5 — export/import/wipe são main-confirmed: o token vem do diálogo nativo (§15.3).
  // O blob do backup NUNCA passa pelo renderer — o main grava/lê o arquivo direto.
  server.register('identity.export', 'main-confirmed', async (rawArg) => {
    const identity = deps.identity;
    if (identity === undefined) refuse('E_UNKNOWN_COMMAND');
    const r = await identity.export(((rawArg ?? {}) as Arg)['passphrase']);
    if (!r.ok) throw Object.assign(new Error(r.code), { code: r.code, ...(r.field !== undefined ? { field: r.field } : {}) });
    return {};
  });

  server.register('identity.import', 'main-confirmed', async (rawArg) => {
    const identity = deps.identity;
    if (identity === undefined) refuse('E_UNKNOWN_COMMAND');
    const r = await identity.import(((rawArg ?? {}) as Arg)['passphrase']);
    if (!r.ok) throw Object.assign(new Error(r.code), { code: r.code, ...(r.field !== undefined ? { field: r.field } : {}) });
    return { publicKey: r.publicKey, handle: r.handle, communities: r.communities };
  });

  // §18.6 — máquina retomável; falha nomeada carrega a etapa (`details.stage`).
  server.register('identity.wipe', 'main-confirmed', async () => {
    const core = deps.core;
    if (core === undefined) refuse('E_UNKNOWN_COMMAND');
    const r = await core.wipe();
    if (!r.ok) {
      throw Object.assign(new Error(r.code), { code: r.code, ...(r.stage !== undefined ? { details: { stage: r.stage } } : {}) });
    }
    return {};
  });

  /**
   * §3.2 L-2 (emenda de 2026-08-23 em §15.4) — `open` pela mesma razão de `identity.create`:
   * é a PRÉ-CONDIÇÃO dela, e em `awaiting-identity` não há identidade contra a qual
   * autorizar. Não entra em `main-confirmed`: aquela classe existe para impedir que um
   * renderer comprometido destrua dado sem confirmação nativa, e aceitar o modo inseguro
   * não destrói nada — muda como a chave passará a ser guardada, e só tem efeito quando
   * uma identidade for criada em seguida.
   */
  server.register('identity.acceptInsecureKeystore', 'open', () => {
    const identity = deps.identity;
    if (identity === undefined) refuse('E_UNKNOWN_COMMAND');
    const r = identity.acceptInsecureKeystore();
    if (!r.ok) refuse(r.code);
    return {};
  });

  // §15.6 — `{...} | null`: sem identidade criada, null é "nada local", não erro.
  server.register('query.identity', 'standard', () => {
    const identity = deps.identity;
    if (identity === undefined) refuse('E_UNKNOWN_COMMAND');
    return identity.self();
  });

  // §17.6/§16.2 (emenda de 2026-08-23 em §15.4) — quem abre canal assina o typing dele.
  server.register('channel.subscribeTyping', 'standard', (rawArg) => {
    const typing = deps.typing;
    if (typing === undefined) refuse('E_UNKNOWN_COMMAND');
    const arg = (rawArg ?? {}) as Arg;
    if (typeof arg['on'] !== 'boolean') refuse('E_VALIDATION');
    const r = typing.subscribe({ communityId: str(arg, 'communityId'), channelId: str(arg, 'channelId'), on: arg['on'] as boolean });
    if (!r.ok) refuse(r.code);
    return {};
  });

  // §17.6/§16.2 (emenda de 2026-09-06 em §15.4) — quem digita publica. Efêmero: sem log,
  // sem fila, sem retentativa. `E_RATE_LIMITED` é desfecho normal (o teto é 1 / 2 s).
  server.register('channel.typing', 'standard', (rawArg) => {
    const typing = deps.typing;
    if (typing === undefined) refuse('E_UNKNOWN_COMMAND');
    const arg = (rawArg ?? {}) as Arg;
    const r = typing.publish({ communityId: str(arg, 'communityId'), channelId: str(arg, 'channelId') });
    if (!r.ok) refuse(r.code);
    return {};
  });

  // ── Diagnóstico (§15.4 "Arquivos e diagnóstico") ─────────────────────────────────

  server.register('diag.run', 'standard', async () => await deps.diagnostics.run());

  server.register('diag.snapshot', 'standard', () => deps.diagnostics.snapshot());

  // ── Busca (§23, §15.6 query.search) ──────────────────────────────────────────────

  server.register('query.search', 'open', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const communityId = str(arg, 'communityId');
    const query = typeof arg['query'] === 'string' ? arg['query'] : '';
    const filtersRaw = (arg['filters'] ?? {}) as Arg;
    const authorKeyHex =
      typeof filtersRaw['authorKey'] === 'string'
        ? Buffer.from(filtersRaw['authorKey'] as string, 'hex')
        : undefined;
    const rawDate = filtersRaw['date'];
    const date =
      rawDate === 'today' || rawDate === '7d' || rawDate === '30d' ? (rawDate as 'today' | '7d' | '30d') : undefined;
    const kind =
      filtersRaw['kind'] === 'attachment' || filtersRaw['kind'] === 'pinned' || filtersRaw['kind'] === 'link'
        ? (filtersRaw['kind'] as 'attachment' | 'pinned' | 'link')
        : undefined;
    const filters = {
      ...(authorKeyHex !== undefined && authorKeyHex.length === 32 ? { authorKey: authorKeyHex } : {}),
      ...(typeof filtersRaw['channelId'] === 'string' ? { channelId: filtersRaw['channelId'] as string } : {}),
      ...(date !== undefined ? { date } : {}),
      ...(kind !== undefined ? { kind } : {}),
    };
    const partial = deps.partialReason?.(communityId);
    return deps.search.search({
      communityId,
      query,
      filters,
      ...(typeof arg['scopeChannelId'] === 'string' ? { scopeChannelId: arg['scopeChannelId'] as string } : {}),
      ...(typeof arg['limitPerGroup'] === 'number' ? { limitPerGroup: arg['limitPerGroup'] as number } : {}),
      ...(partial !== undefined ? { partialReason: partial } : {}),
    });
  });

  // ── Relay voluntário (§15.4 "Voz, tela e relay", §17.7) ──────────────────────────

  server.register('relay.enable', 'standard', async (rawArg) => {
    if (deps.relay === undefined) refuse('E_UNKNOWN_COMMAND');
    const communityId = str((rawArg ?? {}) as Arg, 'communityId');
    const result = await deps.relay.enable({ communityId });
    if (!result.ok) refuse(result.code);
    // Chave em hex, como toda chave que atravessa a IPC-R (`Key` de §15.6). Um `Buffer`
    // cru sobreviveria ao structured clone e chegaria ao renderer como `Uint8Array` — o
    // único campo de chave do produto inteiro com forma diferente dos outros.
    return { relayPublicKey: result.relayPublicKey.toString('hex'), seq: result.seq, expiresAt: result.expiresAt };
  });

  server.register('relay.disable', 'standard', async (rawArg) => {
    if (deps.relay === undefined) refuse('E_UNKNOWN_COMMAND');
    const communityId = str((rawArg ?? {}) as Arg, 'communityId');
    return await deps.relay.disable({ communityId });
  });

  server.register('relay.respondConsent', 'standard', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    if (deps.relayConsent === undefined) refuse('E_UNKNOWN_COMMAND');
    if (typeof arg['accept'] !== 'boolean') refuse('E_VALIDATION');
    const communityId = str(arg, 'communityId');
    const remember = arg['remember'] !== false;
    deps.relayConsent.set(communityId, arg['accept'] ? 'accepted' : 'declined', { remember });
    if (!remember) deps.relayConsent.forget(communityId);
    return {};
  });

  // ── Mensagens (§15.4 "Mensagens" — todas A por contrato, §11.1) ─────────────────────

  /**
   * Forma comum das seis superfícies enfileiráveis: recorte + identidade, a coluna Perm.
   * da tabela (permissão nomeada quando há), payload direto para a ponte e o resultado
   * `{opId, state}`. Erros síncronos restantes são da validação advisória da ponte (§8.7).
   */
  function enfileira(
    arg: Arg,
    kindName: SubmissionInput['kindName'],
    payload: Record<string, unknown>,
    perm?: Parameters<typeof memberHasPermission>[2],
  ): { opId: string; state: string } {
    const messages = deps.messages;
    if (messages === undefined) refuse('E_UNKNOWN_COMMAND');
    const communityId = str(arg, 'communityId');
    const state = messages.writeStateFor(communityId);
    if (state === null) refuse('E_NOT_FOUND');
    const selfKeyHex = messages.selfKeyHex();
    if (selfKeyHex === null) refuse('E_NO_IDENTITY');
    if (perm !== undefined && !memberHasPermission(state, selfKeyHex, perm)) refuse('E_PERMISSION_DENIED');
    const result = messages.submitQueued(communityId, {
      kindName,
      payload,
      ...(typeof arg['clientRef'] === 'string' ? { clientRef: arg['clientRef'] } : {}),
    });
    if (!result.ok) {
      throw Object.assign(new Error(result.code), {
        code: result.code,
        ...(result.field !== undefined ? { field: result.field } : {}),
      });
    }
    return { opId: result.opId, state: result.state };
  }

  server.register('message.send', 'standard', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    // Coluna Perm. de §15.4 — `send_messages` sobre o recorte do DS. O readOnly do canal
    // (R-22) é E_CHANNEL_READ_ONLY e é da ponte, não daqui.
    const payload: Record<string, unknown> = {
      channelId: str(arg, 'channelId'),
      content: str(arg, 'content'),
      mentions: Array.isArray(arg['mentions']) ? arg['mentions'].filter((m) => typeof m === 'string') : [],
    };
    const anexo = arg['attachment'];
    if (anexo !== undefined) {
      // §13.7 regra 1 — a barreira. O renderer manda o `ticketId` e **nada mais**: quem
      // descreve o blob é o núcleo, a partir do que ele mesmo escreveu. Um `attachment`
      // montado pelo renderer poderia apontar a mensagem para qualquer blob do mundo.
      const attachments = deps.attachments;
      if (attachments === undefined) refuse('E_UNKNOWN_COMMAND');
      const ticketId = str((anexo ?? {}) as Arg, 'ticketId');
      const staged = attachments.staged(ticketId);
      // "só é enfileirada depois que o `blob.stage` completou": sem o staging, recusa.
      if (staged === null) refuse('E_BLOB_NOT_STAGED');
      // Coluna Perm. de §7.4: `send_messages` **+ `attach_files`** quando há anexo.
      const state = deps.messages?.writeStateFor(str(arg, 'communityId'));
      const selfKeyHex = deps.messages?.selfKeyHex();
      if (state != null && selfKeyHex != null && !memberHasPermission(state, selfKeyHex, 'attach_files')) {
        refuse('E_PERMISSION_DENIED');
      }
      // O `blob` do fio é o BlobRef COMPLETO de §7.2.1 — chave e quádruplo. Sem a chave,
      // o encode da ponte nem aconteceria: quem sabe de que core o blob é é este núcleo.
      payload['attachment'] = {
        blob: {
          blobsCoreKey: Buffer.from(staged.blobsCoreKey, 'hex'),
          byteOffset: staged.blobId.byteOffset,
          blockOffset: staged.blobId.blockOffset,
          blockLength: staged.blobId.blockLength,
          byteLength: staged.blobId.byteLength,
        },
        name: staged.name,
        sizeBytes: staged.sizeBytes,
        kind: staged.kind,
        hash: Buffer.from(staged.hash, 'hex'),
      };
    }
    if (typeof arg['replyToId'] === 'string') payload['replyToId'] = arg['replyToId'];
    if (typeof arg['threadId'] === 'string') payload['threadId'] = arg['threadId'];
    return enfileira(arg, 'message.send', payload, 'send_messages');
  });

  server.register('message.edit', 'standard', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    return enfileira(arg, 'message.edit', { messageId: str(arg, 'messageId'), content: str(arg, 'content') });
  });

  server.register('message.delete', 'standard', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const communityId = str(arg, 'communityId');
    const messageId = str(arg, 'messageId');
    // Coluna Perm. "própria \| manage_messages": apagar o próprio registro é de todo
    // membro; o alheio exige a permissão nomeada. A hierarquia (E_HIERARCHY) é do fold.
    const state = deps.messages?.writeStateFor(communityId);
    const selfKeyHex = deps.messages?.selfKeyHex();
    if (state !== null && state !== undefined && selfKeyHex !== null && selfKeyHex !== undefined) {
      const msg = state.messages.get(messageId);
      if (msg === undefined || msg.authorKey !== selfKeyHex) {
        if (!memberHasPermission(state, selfKeyHex, 'manage_messages')) refuse('E_PERMISSION_DENIED');
      }
    }
    return enfileira(arg, 'message.delete', {
      messageId,
      ...(typeof arg['reason'] === 'string' ? { reason: arg['reason'] } : {}),
    });
  });

  server.register('message.pin', 'standard', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    if (typeof arg['pinned'] !== 'boolean') refuse('E_VALIDATION');
    return enfileira(
      arg,
      'message.pin',
      { messageId: str(arg, 'messageId'), pinned: arg['pinned'] as boolean },
      'pin_messages',
    );
  });

  server.register('message.react', 'standard', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    if (typeof arg['present'] !== 'boolean') refuse('E_VALIDATION');
    return enfileira(
      arg,
      'reaction.set',
      { messageId: str(arg, 'messageId'), emoji: str(arg, 'emoji'), present: arg['present'] as boolean },
      'add_reactions',
    );
  });

  server.register('thread.create', 'standard', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    return enfileira(arg, 'thread.create', { rootMessageId: str(arg, 'rootMessageId') }, 'send_messages');
  });

  server.register('message.retry', 'standard', (rawArg) => {
    const messages = deps.messages;
    if (messages === undefined) refuse('E_UNKNOWN_COMMAND');
    const opId = str((rawArg ?? {}) as Arg, 'opId');
    const r = messages.retryQueued(opId);
    if (!r.ok) refuse(r.code);
    return { state: r.state };
  });

  server.register('message.cancelQueued', 'standard', (rawArg) => {
    const messages = deps.messages;
    if (messages === undefined) refuse('E_UNKNOWN_COMMAND');
    const opId = str((rawArg ?? {}) as Arg, 'opId');
    const r = messages.cancelQueued(opId);
    if (!r.ok) refuse(r.code);
    return {};
  });

  // ── Ciclo de vida e consulta da comunidade (§15.4, §15.6) ───────────────────────────

  server.register('community.leave', 'standard', (rawArg) => {
    const community = deps.community;
    if (community === undefined) refuse('E_UNKNOWN_COMMAND');
    const r = community.leave(str((rawArg ?? {}) as Arg, 'communityId'));
    if (!r.ok) refuse(r.code);
    return { leftLocally: true, opId: r.opId, droppedQueued: r.droppedQueued };
  });

  // §8.1/§15.4 — `{communityId | null}`: presente fixa a ativa (residência `full`),
  // `null` desativa (todas as não hospedadas caem para `light`).
  server.register('community.activate', 'standard', (rawArg) => {
    const activate = deps.community?.activate;
    if (activate === undefined) refuse('E_UNKNOWN_COMMAND');
    const arg = (rawArg ?? {}) as Arg;
    const communityId = arg['communityId'];
    if (communityId !== null && (typeof communityId !== 'string' || communityId.length === 0)) {
      refuse('E_VALIDATION');
    }
    const r = activate(communityId === null ? null : (communityId as string));
    if (!r.ok) refuse(r.code);
    return { residency: r.residency };
  });

  // §18.5/§18.7 — main-confirmed; a resposta carrega o que ainda não replicou.
  server.register('community.end', 'main-confirmed', async (rawArg) => {
    const end = deps.community?.end;
    if (end === undefined) refuse('E_UNKNOWN_COMMAND');
    const arg = (rawArg ?? {}) as Arg;
    const reason = opcional(arg, 'reason');
    const r = await end({ communityId: str(arg, 'communityId'), ...(reason !== undefined ? { reason } : {}) });
    if (!r.ok) throw Object.assign(new Error(r.code), { code: r.code, ...(r.field !== undefined ? { field: r.field } : {}) });
    return { seq: r.seq, replicatedTo: r.replicatedTo };
  });

  // §18.4 — main-confirmed; apaga ANTES do prazo a réplica de quem já saiu ou foi removido.
  server.register('community.forget', 'main-confirmed', async (rawArg) => {
    const forget = deps.community?.forget;
    if (forget === undefined) refuse('E_UNKNOWN_COMMAND');
    const r = await forget(str((rawArg ?? {}) as Arg, 'communityId'));
    if (!r.ok) refuse(r.code);
    return {};
  });

  server.register('community.create', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const create = deps.community?.create;
    if (create === undefined) refuse('E_UNKNOWN_COMMAND');
    // Forma de §15.4: `{name, iconEmoji?, iconColor, description?}`. A validação dos tetos
    // de §8.6 é da orquestração (composição); aqui só a forma do argumento.
    if (typeof arg['name'] !== 'string') refuse('E_VALIDATION');
    const iconEmoji = arg['iconEmoji'];
    if (iconEmoji !== undefined && typeof iconEmoji !== 'string') refuse('E_VALIDATION');
    const iconColor = arg['iconColor'];
    if (iconColor !== undefined && typeof iconColor !== 'number') refuse('E_VALIDATION');
    const description = arg['description'];
    if (description !== undefined && typeof description !== 'string') refuse('E_VALIDATION');
    const r = await create({
      name: arg['name'] as string,
      ...(typeof iconEmoji === 'string' ? { iconEmoji } : {}),
      ...(typeof iconColor === 'number' ? { iconColor } : {}),
      ...(typeof description === 'string' ? { description } : {}),
    });
    if (!r.ok) throw Object.assign(new Error(r.code), { code: r.code, ...(r.field !== undefined ? { field: r.field } : {}) });
    return { communityId: r.communityId, defaultChannelId: r.defaultChannelId };
  });

  // ── Convites (§15.4 "Convites", §12) ────────────────────────────────────────────────

  function convites(): NonNullable<CoreCommandDeps['invites']> {
    if (deps.invites === undefined) refuse('E_UNKNOWN_COMMAND');
    return deps.invites;
  }

  server.register('invite.create', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const expiresInDays = arg['expiresInDays'];
    const maxUses = arg['maxUses'];
    const label = arg['label'];
    const r = await convites().create({
      communityId: str(arg, 'communityId'),
      ...(typeof expiresInDays === 'number' ? { expiresInDays } : {}),
      ...(typeof maxUses === 'number' ? { maxUses } : {}),
      ...(typeof label === 'string' ? { label } : {}),
    });
    if (!r.ok) throw Object.assign(new Error(r.code), { code: r.code, ...(r.field !== undefined ? { field: r.field } : {}) });
    return {
      invitePublicKey: r.invitePublicKey,
      code: r.code,
      seq: r.seq,
      ...(r.expiresAt !== undefined ? { expiresAt: r.expiresAt } : {}),
      ...(r.maxUses !== undefined ? { maxUses: r.maxUses } : {}),
    };
  });

  server.register('invite.revoke', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const r = await convites().revoke({ communityId: str(arg, 'communityId'), invitePublicKey: str(arg, 'invitePublicKey') });
    if (!r.ok) refuse(r.code);
    return { seq: r.seq };
  });

  server.register('invite.resolve', 'open', async (rawArg) => {
    // Classe open (§15.3): a consulta não muda estado e o código é a própria capacidade.
    const arg = (rawArg ?? {}) as Arg;
    const r = await convites().resolve({ codeOrLink: str(arg, 'codeOrLink') });
    if (!r.ok) refuse(r.code);
    return r.preview;
  });

  server.register('invite.redeem', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const displayName = arg['displayName'];
    const avatarColor = arg['avatarColor'];
    const r = await convites().redeem({
      codeOrLink: str(arg, 'codeOrLink'),
      ...(typeof displayName === 'string' ? { displayName } : {}),
      ...(typeof avatarColor === 'number' ? { avatarColor } : {}),
    });
    if (!r.ok) refuse(r.code);
    return { communityId: r.communityId, defaultChannelId: r.defaultChannelId, seq: r.seq };
  });

  // ── Estrutura (§15.4 "Canais e categorias" e `community.update`) ─────────────────
  //
  // Todas standard (§15.3) e todas ⏱ (§11.1): estrutura não passa pela fila, porque a
  // resposta que a UI precisa — id, `rank`, contagens — só existe depois do host aceitar.

  function estrutura(): NonNullable<CoreCommandDeps['structure']> {
    const e = deps.structure;
    if (e === undefined) refuse('E_UNKNOWN_COMMAND');
    return e;
  }

  /** `string` opcional na forma que §15.2 promete: presente e não vazia, ou ausente. */
  function opcional(arg: Arg, key: string): string | undefined {
    const v = arg[key];
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || v.length === 0) refuse('E_VALIDATION');
    return v;
  }

  function idsDeCargo(arg: Arg, key: string): readonly string[] | undefined {
    const v = arg[key];
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x.length === 0)) refuse('E_VALIDATION');
    return v as string[];
  }

  /** `number` inteiro opcional (§15.4: `speechMode`, `queueTurnSeconds`). */
  function inteiroOpcional(arg: Arg, key: string): number | undefined {
    const v = arg[key];
    if (v === undefined) return undefined;
    if (typeof v !== 'number' || !Number.isInteger(v)) refuse('E_VALIDATION');
    return v;
  }

  /** Desfecho → resposta: `ok` sai do corpo, e o erro leva `field` quando existe (§15.2). */
  async function entregar<T extends { ok: boolean }>(p: Promise<T | { ok: false; code: string; field?: string }>): Promise<Record<string, unknown>> {
    const r = await p;
    if (!r.ok) {
      const erro = r as { code: string; field?: string };
      throw Object.assign(new Error(erro.code), { code: erro.code, ...(erro.field !== undefined ? { field: erro.field } : {}) });
    }
    const { ok: _ok, ...resto } = r as unknown as Record<string, unknown>;
    return resto;
  }

  server.register('channel.create', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const type = arg['type'];
    if (typeof type !== 'number' || !Number.isInteger(type)) refuse('E_VALIDATION');
    const readOnlyForRoleIds = idsDeCargo(arg, 'readOnlyForRoleIds');
    const topic = opcional(arg, 'topic');
    const afterChannelId = opcional(arg, 'afterChannelId');
    const speechMode = inteiroOpcional(arg, 'speechMode');
    const queueTurnSeconds = inteiroOpcional(arg, 'queueTurnSeconds');
    return await entregar(
      estrutura().channelCreate({
        communityId: str(arg, 'communityId'),
        categoryId: str(arg, 'categoryId'),
        type,
        name: str(arg, 'name'),
        ...(topic !== undefined ? { topic } : {}),
        ...(readOnlyForRoleIds !== undefined ? { readOnlyForRoleIds } : {}),
        ...(speechMode !== undefined ? { speechMode } : {}),
        ...(queueTurnSeconds !== undefined ? { queueTurnSeconds } : {}),
        ...(afterChannelId !== undefined ? { afterChannelId } : {}),
      }),
    );
  });

  server.register('channel.update', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const name = opcional(arg, 'name');
    const readOnlyForRoleIds = idsDeCargo(arg, 'readOnlyForRoleIds');
    // `topic` é o único campo que aceita string vazia: limpar o tópico é uma edição válida.
    const topic = arg['topic'];
    if (topic !== undefined && typeof topic !== 'string') refuse('E_VALIDATION');
    const speechMode = inteiroOpcional(arg, 'speechMode');
    const queueTurnSeconds = inteiroOpcional(arg, 'queueTurnSeconds');
    return await entregar(
      estrutura().channelUpdate({
        communityId: str(arg, 'communityId'),
        channelId: str(arg, 'channelId'),
        ...(name !== undefined ? { name } : {}),
        ...(typeof topic === 'string' ? { topic } : {}),
        ...(readOnlyForRoleIds !== undefined ? { readOnlyForRoleIds } : {}),
        ...(speechMode !== undefined ? { speechMode } : {}),
        ...(queueTurnSeconds !== undefined ? { queueTurnSeconds } : {}),
      }),
    );
  });

  server.register('channel.move', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const afterChannelId = opcional(arg, 'afterChannelId');
    return await entregar(
      estrutura().channelMove({
        communityId: str(arg, 'communityId'),
        channelId: str(arg, 'channelId'),
        categoryId: str(arg, 'categoryId'),
        ...(afterChannelId !== undefined ? { afterChannelId } : {}),
      }),
    );
  });

  server.register('channel.delete', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    return await entregar(estrutura().channelDelete({ communityId: str(arg, 'communityId'), channelId: str(arg, 'channelId') }));
  });

  server.register('category.create', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const afterCategoryId = opcional(arg, 'afterCategoryId');
    return await entregar(
      estrutura().categoryCreate({
        communityId: str(arg, 'communityId'),
        name: str(arg, 'name'),
        ...(afterCategoryId !== undefined ? { afterCategoryId } : {}),
      }),
    );
  });

  server.register('category.rename', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    return await entregar(
      estrutura().categoryRename({ communityId: str(arg, 'communityId'), categoryId: str(arg, 'categoryId'), name: str(arg, 'name') }),
    );
  });

  server.register('category.delete', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const moveChannelsTo = opcional(arg, 'moveChannelsTo');
    const deleteChannels = arg['deleteChannels'];
    if (deleteChannels !== undefined && typeof deleteChannels !== 'boolean') refuse('E_VALIDATION');
    return await entregar(
      estrutura().categoryDelete({
        communityId: str(arg, 'communityId'),
        categoryId: str(arg, 'categoryId'),
        ...(moveChannelsTo !== undefined ? { moveChannelsTo } : {}),
        ...(typeof deleteChannels === 'boolean' ? { deleteChannels } : {}),
      }),
    );
  });

  server.register('community.update', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const name = opcional(arg, 'name');
    const iconEmoji = opcional(arg, 'iconEmoji');
    const iconColor = arg['iconColor'];
    if (iconColor !== undefined && (typeof iconColor !== 'number' || !Number.isInteger(iconColor))) refuse('E_VALIDATION');
    // `description` aceita string vazia: apagar a descrição é uma edição válida.
    const description = arg['description'];
    if (description !== undefined && typeof description !== 'string') refuse('E_VALIDATION');
    return await entregar(
      estrutura().communityUpdate({
        communityId: str(arg, 'communityId'),
        ...(name !== undefined ? { name } : {}),
        ...(iconEmoji !== undefined ? { iconEmoji } : {}),
        ...(typeof iconColor === 'number' ? { iconColor } : {}),
        ...(typeof description === 'string' ? { description } : {}),
      }),
    );
  });

  // ── Cargos, membros e moderação (§15.4) ─────────────────────────────────────────
  //
  // Todas standard e todas ⏱. A coluna Perm. de §15.4 é conferida DENTRO de cada função da
  // composição sobre o DS; aqui só a forma do argumento. `permissions[]` viaja como NOMES —
  // quem traduz para os números de protocolo de §9.1 é a composição.

  function moderacao(): NonNullable<CoreCommandDeps['moderation']> {
    const m = deps.moderation;
    if (m === undefined) refuse('E_UNKNOWN_COMMAND');
    return m;
  }

  /** `key` do fio de §15.2 — hex64 do renderer; forma errada nunca vira op assinada. */
  function chave(arg: Arg, keyName: string): string {
    const v = str(arg, keyName);
    if (!/^[0-9a-f]{64}$/i.test(v)) refuse('E_VALIDATION');
    return v.toLowerCase();
  }

  function nomesDePermissao(arg: Arg, keyName: string): readonly string[] {
    const v = arg[keyName];
    if (!Array.isArray(v)) refuse('E_VALIDATION');
    for (const item of v) {
      if (typeof item !== 'string') refuse('E_VALIDATION');
    }
    return v as string[];
  }

  server.register('role.create', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const color = arg['color'];
    if (typeof color !== 'number' || !Number.isInteger(color)) refuse('E_VALIDATION');
    if (typeof arg['mentionable'] !== 'boolean') refuse('E_VALIDATION');
    const afterRoleId = opcional(arg, 'afterRoleId');
    return await entregar(
      moderacao().roleCreate({
        communityId: str(arg, 'communityId'),
        name: str(arg, 'name'),
        color,
        permissions: nomesDePermissao(arg, 'permissions'),
        mentionable: arg['mentionable'] as boolean,
        ...(afterRoleId !== undefined ? { afterRoleId } : {}),
      }),
    );
  });

  server.register('role.update', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const name = opcional(arg, 'name');
    const color = arg['color'];
    if (color !== undefined && (typeof color !== 'number' || !Number.isInteger(color))) refuse('E_VALIDATION');
    const permissions = arg['permissions'] === undefined ? undefined : nomesDePermissao(arg, 'permissions');
    const mentionable = arg['mentionable'];
    if (mentionable !== undefined && typeof mentionable !== 'boolean') refuse('E_VALIDATION');
    return await entregar(
      moderacao().roleUpdate({
        communityId: str(arg, 'communityId'),
        roleId: str(arg, 'roleId'),
        ...(name !== undefined ? { name } : {}),
        ...(typeof color === 'number' ? { color } : {}),
        ...(permissions !== undefined ? { permissions } : {}),
        ...(typeof mentionable === 'boolean' ? { mentionable } : {}),
      }),
    );
  });

  server.register('role.move', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const afterRoleId = opcional(arg, 'afterRoleId');
    const beforeRoleId = opcional(arg, 'beforeRoleId');
    return await entregar(
      moderacao().roleMove({
        communityId: str(arg, 'communityId'),
        roleId: str(arg, 'roleId'),
        ...(afterRoleId !== undefined ? { afterRoleId } : {}),
        ...(beforeRoleId !== undefined ? { beforeRoleId } : {}),
      }),
    );
  });

  server.register('role.delete', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    return await entregar(moderacao().roleDelete({ communityId: str(arg, 'communityId'), roleId: str(arg, 'roleId') }));
  });

  server.register('member.setRoles', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const roleIds = arg['roleIds'];
    if (!Array.isArray(roleIds)) refuse('E_VALIDATION');
    for (const id of roleIds) {
      if (typeof id !== 'string' || id.length === 0) refuse('E_VALIDATION');
    }
    return await entregar(
      moderacao().memberSetRoles({ communityId: str(arg, 'communityId'), targetKey: chave(arg, 'targetKey'), roleIds: roleIds as string[] }),
    );
  });

  server.register('member.setNickname', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const nickname = arg['nickname'];
    // `null` limpa o apelido (§15.4): é uma forma declarada, não ausência de argumento.
    if (nickname !== null && typeof nickname !== 'string') refuse('E_VALIDATION');
    return await entregar(
      moderacao().memberSetNickname({ communityId: str(arg, 'communityId'), nickname: nickname === null ? null : (nickname as string) }),
    );
  });

  server.register('mod.kick', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const reason = opcional(arg, 'reason');
    return await entregar(
      moderacao().modKick({ communityId: str(arg, 'communityId'), targetKey: chave(arg, 'targetKey'), ...(reason !== undefined ? { reason } : {}) }),
    );
  });

  server.register('mod.ban', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const reason = opcional(arg, 'reason');
    return await entregar(
      moderacao().modBan({ communityId: str(arg, 'communityId'), targetKey: chave(arg, 'targetKey'), ...(reason !== undefined ? { reason } : {}) }),
    );
  });

  server.register('mod.revokeBan', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    return await entregar(moderacao().modRevokeBan({ communityId: str(arg, 'communityId'), targetKey: chave(arg, 'targetKey') }));
  });

  server.register('mod.timeout', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const until = arg['until'];
    if (typeof until !== 'number' || !Number.isSafeInteger(until) || until <= 0) refuse('E_VALIDATION');
    const reason = opcional(arg, 'reason');
    return await entregar(
      moderacao().modTimeout({
        communityId: str(arg, 'communityId'),
        targetKey: chave(arg, 'targetKey'),
        until,
        ...(reason !== undefined ? { reason } : {}),
      }),
    );
  });

  server.register('mod.removeTimeout', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    return await entregar(moderacao().modRemoveTimeout({ communityId: str(arg, 'communityId'), targetKey: chave(arg, 'targetKey') }));
  });

  // ── Leitura de §15.6 (estrutura e mensagens) ─────────────────────────────────────
  //
  // Todas standard (§15.3): não mudam estado e não exigem confirmação nativa. `cursor` e
  // `limit` são opcionais e opacos para a fronteira — quem os interpreta é §23.3.

  function reads(): NonNullable<CoreCommandDeps['reads']> {
    const r = deps.reads;
    if (r === undefined) refuse('E_UNKNOWN_COMMAND');
    return r;
  }

  /** `cursor?` e `limit?` na forma que §23.3 promete — o resto é do chamador. */
  function pagina(arg: Arg): { cursor?: string; limit?: number } {
    const cursor = arg['cursor'];
    const limit = arg['limit'];
    if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length === 0)) refuse('E_VALIDATION');
    if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1)) refuse('E_VALIDATION');
    return {
      ...(typeof cursor === 'string' ? { cursor } : {}),
      ...(typeof limit === 'number' ? { limit } : {}),
    };
  }

  function achado<T>(v: T): NonNullable<T> {
    if (v === null || v === undefined) refuse('E_NOT_FOUND');
    return v as NonNullable<T>;
  }

  server.register('query.structure', 'standard', (rawArg) => achado(reads().structure(str((rawArg ?? {}) as Arg, 'communityId'))));
    // §15.6 `query.voiceQueue` (emenda de 2026-08-28) — a leitura que reconstrói
    // `voice.queueChanged`; `null` quando o canal não tem fila conhecida.
    server.register('query.voiceQueue', 'standard', (rawArg) => {
      const arg = (rawArg ?? {}) as Arg;
      // `null` é resposta válida da spec ("o canal não tem fila") — não é E_NOT_FOUND.
      const leitura = reads().voiceQueue?.({ communityId: str(arg, 'communityId'), channelId: str(arg, 'channelId') });
      return leitura ?? {};
    });

  server.register('query.messages', 'standard', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const direction = arg['direction'];
    if (direction !== undefined && direction !== 'before' && direction !== 'after') refuse('E_VALIDATION');
    return reads().messages({
      communityId: str(arg, 'communityId'),
      channelId: str(arg, 'channelId'),
      ...pagina(arg),
      ...(typeof direction === 'string' ? { direction } : {}),
    });
  });

  server.register('query.message', 'standard', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    return achado(reads().message({ communityId: str(arg, 'communityId'), messageId: str(arg, 'messageId') }));
  });

  server.register('query.pinned', 'standard', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    return reads().pinned({ communityId: str(arg, 'communityId'), channelId: str(arg, 'channelId'), ...pagina(arg) });
  });

  server.register('query.files', 'standard', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    return reads().files({ communityId: str(arg, 'communityId'), channelId: str(arg, 'channelId'), ...pagina(arg) });
  });

  server.register('query.links', 'standard', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    return reads().links({ communityId: str(arg, 'communityId'), channelId: str(arg, 'channelId'), ...pagina(arg) });
  });

  server.register('query.thread', 'standard', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    return achado(reads().thread({ communityId: str(arg, 'communityId'), threadId: str(arg, 'threadId'), ...pagina(arg) }));
  });

  // §15.6 emenda de 2026-08-25 — o badge do chip de §9 2.2 (delta §2.2 item 7).
  server.register('query.thread.unread', 'standard', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const channelId = arg['channelId'];
    if (channelId !== undefined && (typeof channelId !== 'string' || channelId.length === 0)) refuse('E_VALIDATION');
    return reads().threadUnread({
      communityId: str(arg, 'communityId'),
      ...(typeof channelId === 'string' ? { channelId } : {}),
      ...pagina(arg),
    });
  });

  server.register('query.reactors', 'standard', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const limit = arg['limit'];
    if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1)) refuse('E_VALIDATION');
    return reads().reactors({
      communityId: str(arg, 'communityId'),
      messageId: str(arg, 'messageId'),
      emoji: str(arg, 'emoji'),
      ...(typeof limit === 'number' ? { limit } : {}),
    });
  });

  // ── Leitura de §15.6 (membros, cargos e moderação) ───────────────────────────────
  //
  // Mesma régua das demais consultas: a fronteira valida forma e recorta; o enforcement
  // de leitura de §15.6.1 (`view_audit_log`, DR-25/T-44) mora na consulta, sobre o DS.

  server.register('query.members', 'standard', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const bruto = arg['filter'];
    let filtro: { query?: string; roleId?: string; onlyOnline?: boolean } | undefined;
    if (bruto !== undefined && bruto !== null) {
      if (typeof bruto !== 'object') refuse('E_VALIDATION');
      const f = bruto as Arg;
      filtro = {
        ...(f['query'] === undefined ? {} : typeof f['query'] === 'string' ? { query: f['query'] as string } : refuse('E_VALIDATION')),
        ...(f['roleId'] === undefined ? {} : typeof f['roleId'] === 'string' ? { roleId: f['roleId'] as string } : refuse('E_VALIDATION')),
        ...(f['onlyOnline'] === undefined ? {} : typeof f['onlyOnline'] === 'boolean' ? { onlyOnline: f['onlyOnline'] as boolean } : refuse('E_VALIDATION')),
      };
    }
    return reads().members({ communityId: str(arg, 'communityId'), ...(filtro !== undefined ? { filter: filtro } : {}), ...pagina(arg) });
  });

  server.register('query.member', 'standard', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const identityKey = str(arg, 'identityKey');
    if (!/^[0-9a-f]{64}$/i.test(identityKey)) refuse('E_VALIDATION');
    return achado(reads().member({ communityId: str(arg, 'communityId'), identityKey }));
  });

  server.register('query.roles', 'standard', (rawArg) => reads().roles({ communityId: str((rawArg ?? {}) as Arg, 'communityId') }));

  server.register('query.bans', 'standard', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    return reads().bans({ communityId: str(arg, 'communityId'), ...pagina(arg) });
  });

  server.register('query.timeouts', 'standard', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    return reads().timeouts({ communityId: str(arg, 'communityId'), ...pagina(arg) });
  });

  server.register('query.auditLog', 'standard', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const type = opcional(arg, 'type');
    const byKey = opcional(arg, 'byKey');
    if (byKey !== undefined && !/^[0-9a-f]{64}$/i.test(byKey)) refuse('E_VALIDATION');
    const from = arg['from'];
    const to = arg['to'];
    for (const v of [from, to]) {
      if (v !== undefined && (typeof v !== 'number' || !Number.isSafeInteger(v))) refuse('E_VALIDATION');
    }
    return reads().auditLog({
      communityId: str(arg, 'communityId'),
      ...(type !== undefined ? { type } : {}),
      ...(byKey !== undefined ? { byKey } : {}),
      ...(typeof from === 'number' ? { from } : {}),
      ...(typeof to === 'number' ? { to } : {}),
      ...pagina(arg),
    });
  });

  // ── Leitura de §15.6 (estado local do leitor) ────────────────────────────────────

  server.register('query.outbox', 'standard', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const communityId = opcional(arg, 'communityId');
    return reads().outbox({ ...(communityId !== undefined ? { communityId } : {}) });
  });

  server.register('query.communities', 'standard', () => reads().communities());

  server.register('query.preferences', 'standard', () => reads().preferences());

  server.register('query.hostStatus', 'standard', (rawArg) => reads().hostStatus({ communityId: str((rawArg ?? {}) as Arg, 'communityId') }));

  server.register('query.selfModeration', 'standard', (rawArg) => reads().selfModeration({ communityId: str((rawArg ?? {}) as Arg, 'communityId') }));

  server.register('query.resolveMessageLink', 'standard', (rawArg) => {
    // O main já validou a gramática de §3.5; o núcleo revalida a forma do ref — recusa
    // aqui é `{status:'malformed'}`, não erro de comando (§15.6).
    return reads().resolveMessageLink({ ref: str((rawArg ?? {}) as Arg, 'ref') });
  });

  // ── Preferências locais (§15.4 "sem host, sem fila") ─────────────────────────────

  function preferencias(): NonNullable<CoreCommandDeps['preferences']> {
    const p = deps.preferences;
    if (p === undefined) refuse('E_UNKNOWN_COMMAND');
    return p;
  }

  server.register('channel.setMuted', 'standard', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    if (typeof arg['muted'] !== 'boolean') refuse('E_VALIDATION');
    return preferencias().channelSetMuted({ channelId: str(arg, 'channelId'), muted: arg['muted'] as boolean });
  });

  server.register('channel.markRead', 'standard', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    return preferencias().channelMarkRead({ communityId: str(arg, 'communityId'), channelId: str(arg, 'channelId') });
  });

  server.register('thread.markRead', 'standard', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    return preferencias().threadMarkRead({ communityId: str(arg, 'communityId'), threadId: str(arg, 'threadId') });
  });

  server.register('category.setCollapsed', 'standard', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    if (typeof arg['collapsed'] !== 'boolean') refuse('E_VALIDATION');
    return preferencias().categorySetCollapsed({
      communityId: str(arg, 'communityId'),
      categoryId: str(arg, 'categoryId'),
      collapsed: arg['collapsed'] as boolean,
    });
  });

  server.register('nav.setActive', 'standard', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    // DR-32 dono único — o argumento declara o estado: presente define, ausente limpa.
    const communityId = arg['communityId'];
    const channelId = arg['channelId'];
    for (const v of [communityId, channelId]) {
      if (v !== undefined && v !== null && (typeof v !== 'string' || v.length === 0)) refuse('E_VALIDATION');
    }
    return preferencias().navSetActive({
      ...(communityId !== undefined && communityId !== null && typeof communityId === 'string' ? { communityId } : { communityId: null }),
      ...(channelId !== undefined && channelId !== null && typeof channelId === 'string' ? { channelId } : { channelId: null }),
    });
  });

  server.register('settings.setDevice', 'standard', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    if (typeof arg['kind'] !== 'string') refuse('E_VALIDATION');
    return preferencias().settingsSetDevice({ kind: arg['kind'] as string, deviceId: str(arg, 'deviceId') });
  });

  server.register('settings.setVolume', 'standard', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    if (typeof arg['kind'] !== 'string') refuse('E_VALIDATION');
    return preferencias().settingsSetVolume({ kind: arg['kind'] as string, value: arg['value'] as number });
  });

  server.register('settings.setParticipantVolume', 'standard', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const identityKey = str(arg, 'identityKey');
    if (!/^[0-9a-f]{64}$/i.test(identityKey)) refuse('E_VALIDATION');
    return preferencias().settingsSetParticipantVolume({ communityId: str(arg, 'communityId'), identityKey, volume: arg['volume'] as number });
  });

  server.register('settings.setNotifications', 'standard', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const enabled = arg['enabled'];
    if (enabled !== undefined && typeof enabled !== 'boolean') refuse('E_VALIDATION');
    const level = opcional(arg, 'level');
    const communityId = opcional(arg, 'communityId');
    return preferencias().settingsSetNotifications({
      ...(typeof enabled === 'boolean' ? { enabled } : {}),
      ...(communityId !== undefined ? { communityId } : {}),
      ...(level !== undefined ? { level } : {}),
    });
  });

  server.register('query.invites', 'standard', (rawArg) => {
    const invitesQuery = deps.invitesQuery;
    if (invitesQuery === undefined) refuse('E_UNKNOWN_COMMAND');
    const view = invitesQuery(str((rawArg ?? {}) as Arg, 'communityId'));
    if (view === null || view === undefined) refuse('E_NOT_FOUND');
    return view;
  });

  server.register('query.community', 'standard', (rawArg) => {
    const communityQuery = deps.communityQuery;
    if (communityQuery === undefined) refuse('E_UNKNOWN_COMMAND');
    const view = communityQuery(str((rawArg ?? {}) as Arg, 'communityId'));
    if (view === null || view === undefined) refuse('E_NOT_FOUND');
    return view;
  });

  // ── Sucessão (§15.4 "Comunidade", §18.8) ─────────────────────────────────────────

  server.register('community.setSuccessors', 'standard', async (rawArg) => {
    const succession = deps.succession;
    if (succession === undefined) refuse('E_UNKNOWN_COMMAND');
    const arg = (rawArg ?? {}) as Arg;
    const communityId = str(arg, 'communityId');
    const raw = arg['successorKeys'];
    if (!Array.isArray(raw)) refuse('E_VALIDATION');
    const successorKeys: Buffer[] = [];
    for (const k of raw) {
      // A fronteira aceita hex do renderer (§15.2: JSON) e converte; forma errada é
      // `E_VALIDATION` aqui, antes de qualquer op.
      if (typeof k !== 'string' || !/^[0-9a-f]{64}$/i.test(k)) refuse('E_VALIDATION');
      successorKeys.push(Buffer.from(k, 'hex'));
    }
    const r = await succession.setSuccessors({ communityId, successorKeys });
    if (!r.ok) refuse(r.code);
    return { seq: r.seq };
  });

  server.register('community.assumeHost', 'main-confirmed', async (rawArg) => {
    const succession = deps.succession;
    if (succession === undefined) refuse('E_UNKNOWN_COMMAND');
    const communityId = str((rawArg ?? {}) as Arg, 'communityId');
    const r = await succession.assumeHost({ communityId });
    if (!r.ok) refuse(r.code);
    return { newCommunityId: r.newCommunityId, seq: r.seq };
  });

  // ── Arquivos (§15.4 "Arquivos e diagnóstico", §13) ───────────────────────────────

  function anexos(): AttachmentSurfaceDeps {
    if (deps.attachments === undefined) refuse('E_UNKNOWN_COMMAND');
    return deps.attachments;
  }

  /** `{blobsCoreKey, blobId}` do fio — hex e o quádruplo de §7.2.1, validados aqui. */
  function blobRef(arg: Arg): BlobRefWire {
    const blobsCoreKey = str(arg, 'blobsCoreKey');
    if (!/^[0-9a-f]{64}$/i.test(blobsCoreKey)) refuse('E_VALIDATION');
    const raw = (arg['blobId'] ?? {}) as Record<string, unknown>;
    const campos = ['byteOffset', 'blockOffset', 'blockLength', 'byteLength'] as const;
    const blobId = {} as Record<(typeof campos)[number], number>;
    for (const campo of campos) {
      const v = raw[campo];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) refuse('E_VALIDATION');
      blobId[campo] = v;
    }
    return { blobsCoreKey, blobId };
  }

  server.register('file.pickForAttachment', 'standard', async (rawArg) => {
    // O diálogo é do main e o caminho nunca volta pelo IPC-R (§15.7, T-16): daqui sai só o
    // ticket, que é o que `blob.stage` consome.
    return await anexos().pick(str((rawArg ?? {}) as Arg, 'communityId'));
  });

  server.register('blob.stage', 'standard', async (rawArg) => {
    return await anexos().stage(str((rawArg ?? {}) as Arg, 'ticketId'));
  });

  server.register('blob.download', 'standard', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    // §13.4 devolve `{state}` na hora; o progresso vai por `blob.progress` a cada 500 ms.
    return anexos().download({ ...blobRef(arg), communityId: str(arg, 'communityId') });
  });

  server.register('blob.cancel', 'standard', (rawArg) => {
    anexos().cancel(blobRef((rawArg ?? {}) as Arg));
    return {};
  });

  server.register('blob.reveal', 'standard', (rawArg, ctx) => {
    const arg = (rawArg ?? {}) as Arg;
    const mode = arg['mode'];
    if (mode !== 'open' && mode !== 'folder') refuse('E_VALIDATION');
    const ref = blobRef(arg);
    // §15.3 — a classe deste comando depende do dado: revelar um `archive` é
    // main-confirmed, o resto é standard. O tipo só se conhece olhando o blob.
    if (anexos().kindOf(ref) === BLOB_KIND_ARCHIVE) server.requireConfirmation('blob.reveal', ctx.authToken, arg);
    const r = anexos().reveal({ ...ref, mode });
    if (!r.ok) refuse(r.code);
    return {};
  });

  server.register('host.exitImpact', 'standard', async () => {
    if (deps.exitImpact === undefined) refuse('E_UNKNOWN_COMMAND');
    // §18.7 / U-06: isto **informa**, não avisa ninguém e não bloqueia a saída.
    return await deps.exitImpact();
  });

  // ── Voz (§15.4, §17.4) ───────────────────────────────────────────────────────────
  //
  // Nenhum destes handlers decide: a decisão é do host (§17.4/§17.5), tomada aqui quando
  // esta instalação hospeda e do outro lado de §16.2 quando não hospeda. O roteador só
  // valida a forma do argumento e traduz o `{code}` da recusa.

  function midia(): MediaDispatcher {
    if (deps.media === undefined) refuse('E_UNKNOWN_COMMAND');
    return deps.media.dispatcher;
  }

  server.register('voice.join', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    return okOrThrow(
      await midia().voiceJoin({ communityId: str(arg, 'communityId'), channelId: str(arg, 'channelId') }),
    );
  });

  server.register('voice.leave', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const sessionId = typeof arg['sessionId'] === 'string' ? arg['sessionId'] : undefined;
    okOrThrow(await midia().voiceLeave(sessionId !== undefined ? { sessionId } : undefined));
    return {};
  });

  server.register('voice.setSelf', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const patch: { muted?: boolean; deafened?: boolean; cameraOn?: boolean; speaking?: boolean } = {};
    for (const key of ['muted', 'deafened', 'cameraOn', 'speaking'] as const) {
      if (typeof arg[key] === 'boolean') patch[key] = arg[key] as boolean;
    }
    okOrThrow(await midia().voiceSetSelf(patch));
    return {};
  });

  server.register('voice.muteParticipant', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    if (typeof arg['muted'] !== 'boolean') refuse('E_VALIDATION');
    okOrThrow(
      await midia().voiceMuteParticipant({
        communityId: str(arg, 'communityId'),
        identityKey: str(arg, 'identityKey'),
        muted: arg['muted'] as boolean,
      }),
    );
    return {};
  });

  server.register('voice.signal', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const sdp = arg['sdp'];
    const ice = arg['ice'];
    // O núcleo não lê SDP: encaminha (§16.2 `voiceSignal`) e a mídia segue DTLS-SRTP ponta
    // a ponta (§17.2). O ticket é o que autoriza o par do outro lado (§17.4 passo 3).
    okOrThrow(
      await midia().voiceSignal({
        peerKey: str(arg, 'peerKey'),
        ticketId: str(arg, 'ticketId'),
        ...(typeof sdp === 'string' ? { sdp } : {}),
        ...(typeof ice === 'string' ? { ice } : {}),
      }),
    );
    return {};
  });

  // ── §17.5 (emenda de 2026-08-28) — Modo Música ──────────────────────────────────
  // A decisão é LOCAL ("voz é uma só"): sessão de voz ativa + `voice_share_screen` lido
  // na réplica, sem ida ao host. O token que volta é a capacidade local que o
  // `capture.authorize{kind:'music'}` do main resolve.
  server.register('music.start', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    if (str(arg, 'communityId').length === 0) refuse('E_VALIDATION');
    const result = okOrThrow(await midia().musicStart());
    return { sessionId: result.sessionId, captureToken: result.captureToken, expiresAt: result.expiresAt };
  });

  // ── §16.4 (emenda de 2026-08-28) — a fila de karaokê ─────────────────────────────
  // Estes três registros FALTARAM no primeiro pouso da fatia e o produto respondia
  // `E_UNKNOWN_COMMAND` a "Entrar na fila" — o teste de contrato que os cobre existe
  // para exatamente esta classe de defeito.
  server.register('voice.queueJoin', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    if (str(arg, 'communityId').length === 0 || str(arg, 'channelId').length === 0) refuse('E_VALIDATION');
    okOrThrow(await midia().queueJoin({ channelId: str(arg, 'channelId') }));
    return {};
  });

  server.register('voice.queueLeave', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    if (str(arg, 'communityId').length === 0 || str(arg, 'channelId').length === 0) refuse('E_VALIDATION');
    okOrThrow(await midia().queueLeave({ channelId: str(arg, 'channelId') }));
    return {};
  });

  server.register('voice.queueModerate', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    if (str(arg, 'communityId').length === 0) refuse('E_VALIDATION');
    const acaoBruta = arg['action'];
    const acoes = ['promote', 'skip', 'remove', 'addTime', 'open', 'close'] as const;
    if (typeof acaoBruta !== 'string' || !(acoes as readonly string[]).includes(acaoBruta)) refuse('E_VALIDATION');
    const seconds = arg['seconds'];
    okOrThrow(
      await midia().queueModerate({
        channelId: str(arg, 'channelId'),
        action: acaoBruta as (typeof acoes)[number],
        ...(typeof arg['targetKey'] === 'string' ? { targetKey: arg['targetKey'] as string } : {}),
        ...(typeof seconds === 'number' ? { seconds } : {}),
      }),
    );
    return {};
  });

  server.register('share.start', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const quality = arg['quality'];
    const result = okOrThrow(
      await midia().shareStart({
        communityId: str(arg, 'communityId'),
        channelId: str(arg, 'channelId'),
        ...(isShareQuality(quality) ? { quality } : {}),
      }),
    );
    // §15.4 — `{sessionId, captureToken}`; o token é a capacidade local de §17.4 emendado.
    return { sessionId: result.sessionId, captureToken: result.captureToken };
  });

  server.register('share.stop', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    okOrThrow(await midia().shareStop({ sessionId: str(arg, 'sessionId') }));
    return {};
  });

  server.register('share.setQuality', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const quality = arg['quality'];
    if (!isShareQuality(quality)) refuse('E_VALIDATION');
    const result = okOrThrow(await midia().shareSetQuality({ sessionId: str(arg, 'sessionId'), quality }));
    return { applied: result.applied };
  });

  server.register('share.join', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const result = okOrThrow(await midia().shareJoin({ sessionId: str(arg, 'sessionId') }));
    return { ticketId: result.ticketId, presenterKey: result.presenterKey };
  });

  /**
   * §15.4 `share.report` — **emenda de 2026-08-25**. O apresentador relata o que o
   * `RTCStatsReport` dele mediu por espectador; o núcleo consolida e devolve `share.health`
   * (§15.5/§16.3). Sem esta metade o evento existia nas duas tabelas e nunca tinha número
   * para carregar, e a qualidade por espectador de §17.5 não saía do papel.
   *
   * Amostra malformada é **descartada**, não recusada: relatar saúde não pode derrubar a
   * transmissão de ninguém, e a cadência seguinte traz outra medida.
   */
  server.register('share.report', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const brutas = Array.isArray(arg['samples']) ? arg['samples'] : [];
    const samples: Array<{ viewerKey: string; rttMs: number; lossPct: number }> = [];
    for (const bruta of brutas) {
      if (typeof bruta !== 'object' || bruta === null) continue;
      const { viewerKey, rttMs, lossPct } = bruta as Arg;
      if (typeof viewerKey !== 'string' || typeof rttMs !== 'number' || typeof lossPct !== 'number') continue;
      if (!Number.isFinite(rttMs) || !Number.isFinite(lossPct)) continue;
      samples.push({ viewerKey, rttMs, lossPct });
    }
    okOrThrow(await midia().shareReport({ sessionId: str(arg, 'sessionId'), samples }));
    return {};
  });
}
