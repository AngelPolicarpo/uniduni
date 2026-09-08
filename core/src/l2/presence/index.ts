// `presence` — L2. Presença, digitando e roster efêmeros de §6.16 e §17.6.
//
// §4: depende de `swarm` (L0) e `clock` (L0). Nunca persiste (L-13).
// §17.6: fan-out redesenhado com agregação e assinatura por interesse.
// A presença é efêmera, at-most-once (L-13), corrigida por TTL.

export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'invisible' | 'offline';

export const PRESENCE_TTL_MS = 45_000;
export const PRESENCE_REFRESH_MS = 15_000;
export const TYPING_TTL_MS = 5_000;
export const TYPING_REFRESH_MS = 3_000;
export const PRESENCE_TICK_MS = 2_000;

const RATE_LIMIT_PRESENCE_MS = 5_000;
const RATE_LIMIT_TYPING_MS = 2_000;

export type PresenceEntry = {
  readonly identityKey: string;
  readonly status: PresenceStatus;
  readonly lastSeenAt: number;
};

export type TypingEntry = {
  readonly identityKey: string;
  readonly channelId: string;
  readonly until: number;
};

type StoredPresence = {
  status: PresenceStatus;
  lastSeenAt: number;
  lastPublishAt: number;
};

type StoredTyping = {
  channelId: string;
  until: number;
  lastPublishAt: number;
};

export type PresenceDelta = {
  readonly communityId: string;
  readonly entries: ReadonlyArray<PresenceEntry>;
  readonly removed: ReadonlyArray<string>;
};

export type TypingDelta = {
  readonly communityId: string;
  readonly channelId: string;
  readonly identityKeys: ReadonlyArray<string>;
};

export type PresenceOptions = {
  readonly clock?: { now(): number };
  readonly onPresenceChanged?: (delta: PresenceDelta) => void;
  readonly onTypingChanged?: (delta: TypingDelta) => void;
  /** `true` quando esta instalação é host da comunidade — só host agrega e emite. */
  readonly isHost?: (communityId: string) => boolean;
};

/**
 * `PresenceManager` — mantém o estado efêmero local de presença/digitando.
 *
 * Cada nó rastreia presença e digitando recebidos via RPC (`presencePublish`/
 * `subscribeChannel`). O host agrega `presence` em delta consolidado a cada
 * `PRESENCE_TICK_MS` (2 s) para membros com conexão ativa — aqui modelado como
 * todo membro com `status !== invisible`.
 * `invisible` nunca publica, mas continua recebendo (§6.16).
 * Taxa: 1 publicação de presença /5 s por autor; 1 de typing /2 s por autor/canal (§17.6).
 */
export class PresenceManager {
  readonly #clock: { now(): number };
  readonly #onPresenceChanged: (d: PresenceDelta) => void;
  readonly #onTypingChanged: (d: TypingDelta) => void;
  readonly #isHost: (cid: string) => boolean;

  // communityId → identityKey → StoredPresence
  #presence = new Map<string, Map<string, StoredPresence>>();
  // communityId → `${identityKey}:${channelId}` → StoredTyping
  // Permite que a mesma identidade digite em canais distintos simultaneamente — a chave
  // é por canal, como o fan-out por interesse de §17.6 exige. Map por identityKey só
  // apagaria ch1 ao publicar em ch2, que é o bug do teste de fase 4.
  #typing = new Map<string, Map<string, StoredTyping>>();
  // communityId → channelId → Set<subscriberKey>  (interesse em typing)
  #typingSubs = new Map<string, Map<string, Set<string>>>();
  // Para delta aggregation: snapshot do último tick
  #lastPresenceSnapshot = new Map<string, Map<string, PresenceStatus>>();

  constructor(opts: PresenceOptions = {}) {
    this.#clock = opts.clock ?? { now: () => Date.now() };
    this.#onPresenceChanged = opts.onPresenceChanged ?? (() => {});
    this.#onTypingChanged = opts.onTypingChanged ?? (() => {});
    this.#isHost = opts.isHost ?? (() => false);
  }

  /**
   * Publica presença local. `invisible` não publica (§6.16), mas ainda recebe.
   * Rate limit: 1 / 5 s por autor (§17.6).
   */
  publishPresence(args: {
    readonly communityId: string;
    readonly identityKey: string;
    readonly status: PresenceStatus;
  }): { readonly ok: true } | { readonly ok: false; readonly code: 'E_RATE_LIMITED'; readonly retryAfterMs: number } {
    if (args.status === 'invisible') {
      // Não publica; remove entrada local se existir (não é exibir, mas é não anunciar)
      this.#presence.get(args.communityId)?.delete(args.identityKey);
      return { ok: true };
    }
    const now = this.#clock.now();
    const community = this.#ensurePresenceMap(args.communityId);
    const existing = community.get(args.identityKey);
    if (existing !== undefined) {
      const elapsed = Math.max(0, now - existing.lastPublishAt);
      if (elapsed < RATE_LIMIT_PRESENCE_MS) {
        return { ok: false, code: 'E_RATE_LIMITED', retryAfterMs: RATE_LIMIT_PRESENCE_MS - elapsed };
      }
    }
    community.set(args.identityKey, { status: args.status, lastSeenAt: now, lastPublishAt: now });
    return { ok: true };
  }

  /**
   * Publica `typing` para `channelId`. Precisa ter assinado interesse? Não — o host
   * filtra fan-out por assinatura; a publicação é sempre aceita com rate limit.
   * Rate limit: 1 / 2 s por autor/canal (§17.6).
   */
  publishTyping(args: {
    readonly communityId: string;
    readonly identityKey: string;
    readonly channelId: string;
  }): { readonly ok: true } | { readonly ok: false; readonly code: 'E_RATE_LIMITED'; readonly retryAfterMs: number } {
    const now = this.#clock.now();
    const map = this.#ensureTypingMap(args.communityId);
    const key = `${args.identityKey}:${args.channelId}`;
    const existing = map.get(key);
    if (existing !== undefined) {
      const elapsed = now - existing.lastPublishAt;
      if (elapsed < RATE_LIMIT_TYPING_MS) {
        return { ok: false, code: 'E_RATE_LIMITED', retryAfterMs: RATE_LIMIT_TYPING_MS - elapsed };
      }
    }
    map.set(key, { channelId: args.channelId, until: now + TYPING_TTL_MS, lastPublishAt: now });
    // host deve agregar e emitir a quem tem o canal aberto — tick fará, mas emitimos
    // typingChanged imediato para teste determinístico (fan-out real é no tick).
    this.#emitTypingForChannel(args.communityId, args.channelId);
    return { ok: true };
  }

  subscribeChannel(args: { readonly communityId: string; readonly subscriberKey: string; readonly channelId: string; readonly on: boolean }): void {
    const byCommunity = this.#typingSubs.get(args.communityId) ?? new Map<string, Set<string>>();
    if (!this.#typingSubs.has(args.communityId)) this.#typingSubs.set(args.communityId, byCommunity);
    const set = byCommunity.get(args.channelId) ?? new Set<string>();
    if (!byCommunity.has(args.channelId)) byCommunity.set(args.channelId, set);
    if (args.on) set.add(args.subscriberKey);
    else {
      set.delete(args.subscriberKey);
      if (set.size === 0) byCommunity.delete(args.channelId);
    }
  }

  /**
   * Os assinantes de interesse de um canal (§17.6) — o alvo do push de `typing.changed`
   * do host. Ordenado para fan-out determinístico.
   */
  getTypingSubscribers(communityId: string, channelId: string): string[] {
    return [...(this.#typingSubs.get(communityId)?.get(channelId) ?? [])].sort();
  }

  /**
   * O status VISÍVEL do autor agora — o que um `presencePublish` repetido com o MESMO
   * status encontra. Diferente de `getPresenceEntries`, não filtra por TTL: é a leitura
   * que o rate limit de §17.6 usa para decidir se há informação nova no fio.
   */
  visibleStatusOf(communityId: string, identityKey: string): PresenceStatus | null {
    return this.#presence.get(communityId)?.get(identityKey)?.status ?? null;
  }

  getPresenceEntries(communityId: string, now = this.#clock.now()): PresenceEntry[] {
    const map = this.#presence.get(communityId);
    if (map === undefined) return [];
    const out: PresenceEntry[] = [];
    for (const [key, v] of map) {
      if (now - v.lastSeenAt > PRESENCE_TTL_MS) continue;
      out.push({ identityKey: key, status: v.status, lastSeenAt: v.lastSeenAt });
    }
    // ordena determinístico para dump idêntico
    out.sort((a, b) => a.identityKey.localeCompare(b.identityKey));
    return out;
  }

  getTypingForChannel(communityId: string, channelId: string, now = this.#clock.now()): string[] {
    const map = this.#typing.get(communityId);
    if (map === undefined) return [];
    const out: string[] = [];
    for (const [k, v] of map) {
      if (v.channelId !== channelId) continue;
      if (v.until <= now) continue;
      const sep = k.indexOf(':');
      const identityKey = sep === -1 ? k : k.slice(0, sep);
      out.push(identityKey);
    }
    out.sort();
    return out;
  }

  /**
   * Só o TTL do typing (§22.1 `typing.expire`, 1 s no host) — sem o passe de agregação de
   * presença, que tem cadência própria (`presence.tick`, 2 s). Idempotente: typing vivo
   * dentro do TTL não emite nada.
   */
  expireTyping(now = this.#clock.now()): TypingDelta[] {
    const deltas: TypingDelta[] = [];
    for (const [cid, map] of this.#typing) {
      for (const [key, v] of [...map]) {
        if (v.until > now) continue;
        map.delete(key);
        const d = this.#typingDeltaFor(cid, v.channelId, now);
        deltas.push(d ?? { communityId: cid, channelId: v.channelId, identityKeys: [] });
        this.#onTypingChanged(d ?? { communityId: cid, channelId: v.channelId, identityKeys: [] });
      }
    }
    return deltas;
  }

  /**
   * Avança relógio lógico: expira TTL e, se for host, emite delta agregado de presença
   * a cada PRESENCE_TICK_MS (§17.6). Retorna os deltas emitidos para teste.
   */
  tick(now = this.#clock.now()): { presence: PresenceDelta[]; typing: TypingDelta[] } {
    const presenceDeltas: PresenceDelta[] = [];
    const typingDeltas: TypingDelta[] = [];

    // Expira TTL
    for (const [cid, map] of this.#typing) {
      for (const [key, v] of [...map]) {
        if (v.until <= now) {
          map.delete(key);
          // emite delta de remoção para quem tinha interesse
          const d = this.#typingDeltaFor(cid, v.channelId, now);
          // só emite se alguém assina; ainda registra para teste
          if (d !== null) typingDeltas.push(d);
          this.#onTypingChanged(d ?? { communityId: cid, channelId: v.channelId, identityKeys: [] });
        }
      }
    }

    const expiredPresence: Array<{ cid: string; removed: string[] }> = [];
    for (const [cid, map] of this.#presence) {
      const removed: string[] = [];
      for (const [key, v] of [...map]) {
        if (now - v.lastSeenAt > PRESENCE_TTL_MS) {
          map.delete(key);
          removed.push(key);
        }
      }
      if (removed.length > 0) expiredPresence.push({ cid, removed });
    }

    // Host aggregation: delta consolidado a cada 2s (§17.6) — aqui a cada tick, o
    // chamador decide frequência; já filtrado para só host.
    for (const [cid] of this.#presence) {
      if (!this.#isHost(cid)) continue;
      const current = this.getPresenceEntries(cid, now);
      const last = this.#lastPresenceSnapshot.get(cid) ?? new Map();
      const entriesMap = new Map(current.map((e) => [e.identityKey, e.status] as const));
      // detecta mudança ou expiração
      const changed: PresenceEntry[] = [];
      const removed: string[] = [];
      for (const e of current) {
        if (last.get(e.identityKey) !== e.status) changed.push(e);
      }
      for (const [key] of last) {
        if (!entriesMap.has(key)) removed.push(key);
      }
      // também os expirados que já sumiram
      const exp = expiredPresence.find((x) => x.cid === cid)?.removed ?? [];
      for (const k of exp) if (!removed.includes(k)) removed.push(k);

      if (changed.length > 0 || removed.length > 0) {
        const delta: PresenceDelta = { communityId: cid, entries: changed, removed };
        presenceDeltas.push(delta);
        this.#onPresenceChanged(delta);
      }
      // atualiza snapshot
      const snap = new Map<string, PresenceStatus>();
      for (const e of current) snap.set(e.identityKey, e.status);
      this.#lastPresenceSnapshot.set(cid, snap);
    }

    // Para não-host, expiração já limpa mas não agrega; ainda emite typing que expirou
    // (já feito acima). Presença de não-host não emite `presence.changed` — só o host o faz.

    return { presence: presenceDeltas, typing: typingDeltas };
  }

  /** Usado por teste para receber ingestão de evento remoto (já validado). */
  /**
   * §17.6 — as chaves que o host declarou fora no MESMO delta (`removed`). Sem elas o
   * membro só esquecia quem saiu pelo TTL passivo de 45 s, e a lista mostrava como online
   * quem já tinha fechado o programa.
   */
  removePresence(communityId: string, identityKeys: readonly string[]): void {
    const map = this.#presence.get(communityId);
    if (map === undefined) return;
    for (const k of identityKeys) map.delete(k);
  }

  ingestPresence(args: { readonly communityId: string; readonly identityKey: string; readonly status: PresenceStatus; readonly at: number }): void {
    if (args.status === 'invisible') return;
    const map = this.#ensurePresenceMap(args.communityId);
    const existing = map.get(args.identityKey);
    map.set(args.identityKey, {
      status: args.status,
      lastSeenAt: args.at,
      lastPublishAt: existing !== undefined ? existing.lastPublishAt : args.at,
    });
  }

  ingestTyping(args: { readonly communityId: string; readonly identityKey: string; readonly channelId: string; readonly until: number }): void {
    const map = this.#ensureTypingMap(args.communityId);
    const key = `${args.identityKey}:${args.channelId}`;
    map.set(key, { channelId: args.channelId, until: args.until, lastPublishAt: args.until - TYPING_TTL_MS });
  }

  #ensurePresenceMap(cid: string): Map<string, StoredPresence> {
    let m = this.#presence.get(cid);
    if (m === undefined) {
      m = new Map();
      this.#presence.set(cid, m);
    }
    return m;
  }

  #ensureTypingMap(cid: string): Map<string, StoredTyping> {
    let m = this.#typing.get(cid);
    if (m === undefined) {
      m = new Map();
      this.#typing.set(cid, m);
    }
    return m;
  }

  #emitTypingForChannel(communityId: string, channelId: string): void {
    const delta = this.#typingDeltaFor(communityId, channelId);
    if (delta === null) return;
    // O host filtra fan-out para quem assinou; o cliente ainda pode ignorar se não tem o canal aberto.
    // Para teste determinístico, emitimos sempre; quem consome filtra por assinatura.
    this.#onTypingChanged(delta);
  }

  #typingDeltaFor(communityId: string, channelId: string, now = this.#clock.now()): TypingDelta | null {
    const keys = this.getTypingForChannel(communityId, channelId, now);
    // Se ninguém assina, não há fan-out (§17.6) — não emite.
    const subs = this.#typingSubs.get(communityId)?.get(channelId);
    if (subs === undefined || subs.size === 0) return null;
    return { communityId, channelId, identityKeys: keys };
  }
}
