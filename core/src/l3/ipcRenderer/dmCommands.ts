// A superfície IPC-R da conversa direta — §31.16.1 (17 comandos) e §31.16.3 (5 queries).
//
// §4: `ipcRenderer` é roteamento e autorização de comando; **nenhuma regra de domínio aqui**.
// Cada handler traduz a forma de §31.16 para uma chamada da raiz de composição e devolve
// `{code}` do catálogo de §20.2 quando o módulo recusa. As classes de §15.3 valem sem
// alteração: tudo é `standard`, menos `dm.forget`, que é **main-confirmed** pela mesma razão
// que `community.forget` — ele apaga dado, e a barreira contra o apagamento acidental é o
// diálogo nativo.
//
// **`dm.send` responde síncrono, com o registro já no log.** É a terceira classe de escrita
// de §31.10, e é a diferença mais visível desta superfície em relação à de §15.4: não há
// `{opId, state:'queued'}`, não há `message.retry`, não há `message.cancelQueued`, e nenhum
// desfecho chega depois por evento. O que chega depois é a **entrega** (`dm.delivered`), que
// é outra coisa.
//
// **Nenhum comando devolve, deriva ou expõe material de chave** (§31.16.1, §3.2 item 5, sem
// exceção nova): `dmContentKey`, `dmShared` e `dmCoreSeed` não aparecem em resposta, em erro
// nem em log.

import type { IpcServer } from './index.ts';

function refuse(code: string, extra: Record<string, unknown> = {}): never {
  throw Object.assign(new Error(code), { code, ...extra });
}

type Arg = Record<string, unknown>;

function texto(arg: Arg, key: string): string {
  const v = arg[key];
  if (typeof v !== 'string' || v.length === 0) refuse('E_VALIDATION', { field: key });
  return v;
}

/** hex64 — `conversationId`, `messageId` de outra forma e chaves atravessam assim (§15.1). */
function chaveHex(arg: Arg, key: string): Buffer {
  const v = arg[key];
  if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) refuse('E_VALIDATION', { field: key });
  return Buffer.from(v, 'hex');
}

function opcionalTexto(arg: Arg, key: string): string | undefined {
  const v = arg[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') refuse('E_VALIDATION', { field: key });
  return v;
}

function opcionalInteiro(arg: Arg, key: string): number | undefined {
  const v = arg[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v)) refuse('E_VALIDATION', { field: key });
  return v;
}

/**
 * O anexo de §31.5 na forma do fio: hex nas chaves, quádruplo de §7.2.1 no `blobId`.
 * Declarado **aqui**, e não importado do `dmCodec`: §4 dá a `ipcRenderer` a dependência `L2`,
 * e nem L1 nem a raiz de composição entram — a barreira de camadas quebra o build se
 * entrarem. A fronteira conhece a **forma** do que atravessa, não o catálogo de `kind`s.
 */
export type DmAttachmentWire = {
  readonly blob: {
    readonly blobsCoreKey: Buffer;
    readonly byteOffset: number;
    readonly blockOffset: number;
    readonly blockLength: number;
    readonly byteLength: number;
  };
  readonly name: string;
  readonly sizeBytes: number;
  readonly kind: number;
  readonly hash: Buffer;
};

/** O registro **já no log** (§31.10) — o que toda escrita de DM devolve. */
export type DmWriteResult = { readonly messageId: string; readonly ordSum: number };

/**
 * §31.15 — o serviço de §17.3 na forma que atravessa a fronteira. Declarado **aqui** pela
 * mesma razão de `DmAttachmentWire`: a fronteira conhece a forma do que passa, não o módulo
 * que a produz. Repare no que não existe — não há `ticket`, não há `sessionId` de host e não
 * há `roster`: as três são as remoções que §31.15 declara, e uma superfície que as carregasse
 * mentiria sobre o modelo do mesmo jeito que um `dm.retry` mentiria sobre a outbox (§105.4).
 */
export type DmIceServer = {
  readonly urls: string;
  readonly username?: string;
  readonly credential?: string;
  readonly terceiro?: boolean;
};

/** §31.16.3 — as cinco consultas, pela forma e não pelo módulo (mesma razão de §4 acima). */
export type DmQuerySurface = {
  conversations(): unknown;
  conversation(a: { conversationId: string }): unknown;
  messages(a: { conversationId: string; cursor?: string; limit?: number; direction?: string }): unknown;
  message(a: { conversationId: string; messageId: string }): unknown;
  prefs(): unknown;
};

/**
 * O que esta superfície precisa da raiz de composição. Repare no que **não** está aqui:
 * nada de `manifest`, `view`, cores, chaves nem catálogo de `kind`. A fronteira roteia; quem
 * decide é L2 e quem monta é a composição.
 */
export type DmSurfaceDeps = {
  /** §31.16.1 `dm.open` — derivado, nunca atribuído (§31.2 regra 1). */
  open(peerKey: Buffer): Promise<{ ok: true; conversationId: string; state: string } | { ok: false; code: string; field?: string; limit?: number }>;
  accept(conversationId: string): Promise<{ ok: true; state: 'accepted' } | { ok: false; code: string; limit?: number }>;
  block(conversationId: string): { ok: true } | { ok: false; code: string };
  unblock(conversationId: string): Promise<{ ok: true; state: string } | { ok: false; code: string }>;
  forget(conversationId: string): Promise<{ ok: true } | { ok: false; code: string }>;
  // §31.10 — as cinco escritas. Cada uma devolve o registro **já no log**, e lança `{code}`
  // quando recusa. Cinco métodos, e não um `write(kind, payload)`: o catálogo de §31.5 é de
  // L1, e a fronteira não o conhece.
  sendMessage(a: {
    conversationId: string;
    content: string;
    attachment?: DmAttachmentWire;
    replyToId?: string;
  }): Promise<DmWriteResult>;
  editMessage(a: { conversationId: string; messageId: string; content: string }): Promise<DmWriteResult>;
  deleteMessage(a: { conversationId: string; messageId: string }): Promise<DmWriteResult>;
  react(a: { conversationId: string; messageId: string; emoji: string; present: boolean }): Promise<DmWriteResult>;
  setProfile(a: { conversationId: string; displayName?: string; avatarColor?: number }): Promise<DmWriteResult>;
  markRead(conversationId: string): { unreadCount: 0 };
  activate(conversationId: string | null): { residency: string };
  /** §31.8 — efêmero; nunca enfileira. */
  setTyping(conversationId: string, on: boolean): { ok: true } | { ok: false; code: string };
  setContactPolicy(policy: string): { ok: true } | { ok: false; code: string; field?: string };
  /**
   * §31.15 — a chamada de dois. `sessionId` é o `conversationId`: o escopo do serviço de
   * §17.3 é a conversa, e não há host que emita um id de sessão.
   */
  callJoin(conversationId: string):
    | { ok: true; sessionId: string; peerKey: string; iceServers: readonly DmIceServer[]; peerOnCall: boolean }
    | { ok: false; code: string };
  callLeave(conversationId: string): { ok: true } | { ok: false; code: string };
  /** SDP/ICE ao par, pelo `p2p-dm/1`. **Sem `ticketId` e sem `toPeerKey`** (§31.15). */
  callSignal(a: { conversationId: string; sdp?: string; ice?: string }): { ok: true } | { ok: false; code: string };
  readonly queries: DmQuerySurface;
};

function lancarSeRecusa<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (r.ok !== true) {
    const e = r as unknown as { code?: string; field?: string; limit?: number };
    refuse(e.code ?? 'E_INTERNAL', {
      ...(e.field !== undefined ? { field: e.field } : {}),
      ...(e.limit !== undefined ? { limit: e.limit } : {}),
    });
  }
  return r as Extract<T, { ok: true }>;
}

export function registerDmCommands(server: IpcServer, deps: DmSurfaceDeps): void {
  // ── §31.16.1 — os 14 comandos ──────────────────────────────────────────────────────

  /**
   * `dm.open{peerKey}` → `{conversationId, state}`.
   *
   * Conversa consigo mesmo é `E_VALIDATION.peerKey` — não ganhou código próprio, e §31.17 diz
   * por quê: um código existente já descreve a condição, e §20.2 é fonte única.
   */
  server.register('dm.open', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const r = lancarSeRecusa(await deps.open(chaveHex(arg, 'peerKey')));
    return { conversationId: r.conversationId, state: r.state };
  });

  /** `dm.accept{conversationId}` → cria o core e escreve o `dm.hello` (§31.9 regra 1). */
  server.register('dm.accept', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    return lancarSeRecusa(await deps.accept(texto(arg, 'conversationId')));
  });

  /**
   * `dm.block{conversationId}` → `{}`. **Silencioso**: nada vai para log nenhum (regra 3).
   *
   * **Bloquear encerra a chamada desta conversa** (§31.16.1, emenda de 2026-09-05), e o
   * `dm.callLeave` vai **antes**: depois de bloquear, `autorizaDm` é falso (§31.8(4)) e o
   * `dm.call{on:false}` não teria por onde sair — o par ficaria com a chamada de pé contra
   * quem acabou de bloqueá-lo.
   *
   * Sem isto, `dm.block` fechava o canal e deixava tudo o mais em pé: a mídia é ponta a
   * ponta (§17.2) e não passa por ele, e o escopo continuava registrado no `MediaServer`
   * com a credencial que este nó emitiu ainda válida — o meu TURN encaminhando a mídia de
   * quem eu acabei de bloquear. §31.15 diz que a revogação de §17.4 acontece "pela única
   * via que sobrou aqui: **sair encerra**", então bloquear tem de sair.
   *
   * A ordem mora **aqui**, e não na raiz de composição, por uma razão medida: há mais de
   * uma montagem da mesma superfície (o `boot.ts` do produto e os rigs de teste), e uma
   * regra que dependesse de cada uma se lembrar dela vale só onde alguém lembrou. Isto não
   * é decisão de política — L2 continua decidindo o que bloquear faz —, é a ordem de dois
   * comandos que esta fronteira já roteia. `callLeave` é idempotente (§31.16.1).
   */
  server.register('dm.block', 'standard', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const conversationId = texto(arg, 'conversationId');
    deps.callLeave(conversationId);
    lancarSeRecusa(deps.block(conversationId));
    return {};
  });

  server.register('dm.unblock', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    return lancarSeRecusa(await deps.unblock(texto(arg, 'conversationId')));
  });

  /**
   * `dm.send` → `{messageId, ordSum, state:'written'}`, **síncrono**, com o registro já no
   * log (§31.10). `state` é literal e não uma promessa: `delivered` só existe quando o `ack`
   * do par avança (§31.11), e quem o anuncia é `dm.delivered`, nunca esta resposta.
   *
   * `clientRef` está na assinatura de §31.16.1 e **não** viaja no registro: aqui não há
   * outbox a reconciliar (§31.10), então ele não tem nada a correlacionar. Ele volta na
   * resposta para o renderer casar o otimismo local, e só.
   */
  server.register('dm.send', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const conversationId = texto(arg, 'conversationId');
    const content = arg['content'];
    if (typeof content !== 'string') refuse('E_VALIDATION', { field: 'content' });
    const replyToId = opcionalTexto(arg, 'replyToId');
    const anexo = arg['attachment'];
    const r = await deps.sendMessage({
      conversationId,
      content,
      ...(anexo !== undefined && anexo !== null ? { attachment: anexoDoFio(anexo) } : {}),
      ...(replyToId !== undefined ? { replyToId } : {}),
    });
    return {
      messageId: r.messageId,
      ordSum: r.ordSum,
      state: 'written',
      ...(typeof arg['clientRef'] === 'string' ? { clientRef: arg['clientRef'] } : {}),
    };
  });

  server.register('dm.edit', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const content = arg['content'];
    if (typeof content !== 'string') refuse('E_VALIDATION', { field: 'content' });
    const r = await deps.editMessage({
      conversationId: texto(arg, 'conversationId'),
      messageId: texto(arg, 'messageId'),
      content,
    });
    return { ordSum: r.ordSum };
  });

  /** Tombstone (A26): "não pode ser desfeito" é verdade para a interface, não para os bytes. */
  server.register('dm.delete', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const r = await deps.deleteMessage({
      conversationId: texto(arg, 'conversationId'),
      messageId: texto(arg, 'messageId'),
    });
    return { ordSum: r.ordSum };
  });

  /** Idempotente e convergente (A11): `set{present}`, não incremento. */
  server.register('dm.react', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const present = arg['present'];
    if (typeof present !== 'boolean') refuse('E_VALIDATION', { field: 'present' });
    const r = await deps.react({
      conversationId: texto(arg, 'conversationId'),
      messageId: texto(arg, 'messageId'),
      emoji: texto(arg, 'emoji'),
      present,
    });
    return { ordSum: r.ordSum };
  });

  /** Perfil **por conversa**, como §6.3 já faz por comunidade. */
  server.register('dm.setProfile', 'standard', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const displayName = opcionalTexto(arg, 'displayName');
    const avatarColor = opcionalInteiro(arg, 'avatarColor');
    if (displayName === undefined && avatarColor === undefined) refuse('E_VALIDATION');
    const r = await deps.setProfile({
      conversationId: texto(arg, 'conversationId'),
      ...(displayName !== undefined ? { displayName } : {}),
      ...(avatarColor !== undefined ? { avatarColor } : {}),
    });
    return { ordSum: r.ordSum };
  });

  server.register('dm.markRead', 'standard', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    return deps.markRead(texto(arg, 'conversationId'));
  });

  /** Efêmero, TTL 5 s (§31.8). **Nunca enfileira** — sem canal, simplesmente não acontece. */
  server.register('dm.setTyping', 'standard', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const on = arg['on'];
    if (typeof on !== 'boolean') refuse('E_VALIDATION', { field: 'on' });
    lancarSeRecusa(deps.setTyping(texto(arg, 'conversationId'), on));
    return {};
  });

  /**
   * §31.9 regra 5 — a única defesa real contra Sybil num sistema em que identidade é gratuita
   * (**L-8**). O custo precisa aparecer na UI: ligada, ninguém de fora fala com você pela
   * primeira vez.
   */
  server.register('dm.setContactPolicy', 'standard', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    lancarSeRecusa(deps.setContactPolicy(texto(arg, 'policy')));
    return {};
  });

  /**
   * **main-confirmed** (§15.3): apaga dado, e a barreira é o diálogo nativo.
   *
   * Encerra a chamada antes, pela mesma razão de `dm.block` — e aqui com uma consequência a
   * mais no renderer: esquecer tira a conversa da lista, e com ela some a tela que carrega o
   * único botão de desligar. A chamada ficava órfã, capturando microfone e câmera, e ainda
   * recusando a próxima com "voz é uma só" (§15.4).
   */
  server.register('dm.forget', 'main-confirmed', async (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const paraEsquecer = texto(arg, 'conversationId');
    deps.callLeave(paraEsquecer);
    lancarSeRecusa(await deps.forget(paraEsquecer));
    return {};
  });

  // ── §31.15 — mídia numa conversa direta ────────────────────────────────────────────
  //
  // Três comandos, e cada campo que eles **não** têm é uma linha da tabela de remoções de
  // §31.15: sem `channelId` (não há canal), sem `ticketId` (a `remotePublicKey` do Noise é a
  // autorização), sem `toPeerKey` (há um par só), sem `roster` e sem `quality`. O que sobra
  // é `voice.join`/`voice.leave`/`voice.signal` com a comunidade tirada de baixo.

  /**
   * `dm.callJoin{conversationId}` → `{sessionId, peerKey, iceServers[], peerOnCall}`.
   *
   * `peerOnCall` é o que substitui o roster de §17.6: numa dupla a única pergunta que o
   * roster respondia é "o outro está aqui?", e ela é um booleano. Ele pode nascer `false` e
   * virar `true` por `dm.callState` — chamar antes de o outro atender é o caso normal.
   */
  server.register('dm.callJoin', 'standard', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const r = lancarSeRecusa(deps.callJoin(texto(arg, 'conversationId')));
    return { sessionId: r.sessionId, peerKey: r.peerKey, iceServers: r.iceServers, peerOnCall: r.peerOnCall };
  });

  /**
   * `dm.callLeave{conversationId}` → `{}`. Idempotente: sair de uma chamada que não existe é
   * no-op nomeado, como `voice.leave` sem sessão. §31.15 — sair é uma das três coisas que
   * encerram (as outras são cair e bloquear); **não há revogação por moderação**.
   */
  server.register('dm.callLeave', 'standard', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    lancarSeRecusa(deps.callLeave(texto(arg, 'conversationId')));
    return {};
  });

  /**
   * `dm.signal{conversationId, sdp?, ice?}` → `{}`.
   *
   * O núcleo **não lê** o SDP: a mídia é DTLS-SRTP ponta a ponta e o núcleo nunca a vê
   * (§17.2, sem alteração). `E_PEER_UNREACHABLE` quando não há canal `p2p-dm/1` de pé — o
   * mesmo código de §16.2 `voiceSignal`, e aqui ele não depende de um host encaminhar.
   */
  server.register('dm.signal', 'standard', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const sdp = opcionalTexto(arg, 'sdp');
    const ice = opcionalTexto(arg, 'ice');
    if (sdp === undefined && ice === undefined) refuse('E_VALIDATION', { field: 'sdp' });
    lancarSeRecusa(
      deps.callSignal({
        conversationId: texto(arg, 'conversationId'),
        ...(sdp !== undefined ? { sdp } : {}),
        ...(ice !== undefined ? { ice } : {}),
      }),
    );
    return {};
  });

  /** `dm.activate{conversationId | null}` → `{residency}`. */
  server.register('dm.activate', 'standard', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    const v = arg['conversationId'];
    if (v !== null && v !== undefined && typeof v !== 'string') refuse('E_VALIDATION', { field: 'conversationId' });
    return deps.activate(typeof v === 'string' && v.length > 0 ? v : null);
  });

  // ── §31.16.3 — as 5 queries ────────────────────────────────────────────────────────
  //
  // §15.3: "todas as queries" são **open**. O recorte de confidencialidade que §15.6.1 aplica
  // a `query.auditLog`/`bans`/`timeouts` não tem análogo aqui: não há permissão numa conversa
  // de dois, e o que a conversa guarda é do dono da máquina.

  server.register('query.dmConversations', 'open', () => ({ conversations: deps.queries.conversations() }));

  server.register('query.dmConversation', 'open', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    return deps.queries.conversation({ conversationId: texto(arg, 'conversationId') });
  });

  server.register('query.dmMessages', 'open', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    return deps.queries.messages({
      conversationId: texto(arg, 'conversationId'),
      ...(typeof arg['cursor'] === 'string' ? { cursor: arg['cursor'] } : {}),
      ...(arg['limit'] !== undefined ? { limit: arg['limit'] as number } : {}),
      ...(typeof arg['direction'] === 'string' ? { direction: arg['direction'] } : {}),
    });
  });

  server.register('query.dmMessage', 'open', (rawArg) => {
    const arg = (rawArg ?? {}) as Arg;
    return deps.queries.message({
      conversationId: texto(arg, 'conversationId'),
      messageId: texto(arg, 'messageId'),
    });
  });

  server.register('query.dmPrefs', 'open', () => deps.queries.prefs());
}

/**
 * O `attachment` de §31.5 vindo do fio. `Buffer` não atravessa JSON (§15.1): chaves e hash
 * viajam em hex, e o `blobId` é o quádruplo de §7.2.1 — a mesma forma de `blob.stage`.
 */
function anexoDoFio(raw: unknown): DmAttachmentWire {
  if (typeof raw !== 'object' || raw === null) refuse('E_VALIDATION', { field: 'attachment' });
  const a = raw as Arg;
  const blobId = a['blobId'];
  if (typeof blobId !== 'object' || blobId === null) refuse('E_VALIDATION', { field: 'attachment' });
  const b = blobId as Arg;
  const inteiro = (o: Arg, k: string): number => {
    const v = o[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) refuse('E_VALIDATION', { field: 'attachment' });
    return v;
  };
  return {
    blob: {
      blobsCoreKey: chaveHex(a, 'blobsCoreKey'),
      byteOffset: inteiro(b, 'byteOffset'),
      blockOffset: inteiro(b, 'blockOffset'),
      blockLength: inteiro(b, 'blockLength'),
      byteLength: inteiro(b, 'byteLength'),
    },
    name: texto(a, 'name'),
    sizeBytes: inteiro(a, 'sizeBytes'),
    kind: inteiro(a, 'kind'),
    hash: chaveHex(a, 'hash'),
  };
}
