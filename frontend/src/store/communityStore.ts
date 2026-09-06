import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";
import { useIdentityStore } from "./identityStore";
import type {
  AvatarColor,
  Category,
  Channel,
  ChannelType,
  Community,
  Invite,
  Member,
  Permission,
  PresenceStatus,
  Role,
} from "../domain/types";

/** Os quatro estados que §15.4/§17.6 publicam; `offline` é ausência, não publicação. */
const PRESENCAS_DO_FIO = new Set(["online", "idle", "dnd", "invisible"]);
// As tabelas de permissão são constantes de produto (§10), não fixture de dado: seguem
// vindo daqui. Tudo que era DADO — comunidades, categorias, canais, cargos, convites,
// membros — passou para o espelho de `remote`, preenchido pela IPC-R.

/**
 * Comunidades das quais a identidade local participa (§7 0.3/0.4 · §8 1.1).
 *
 * Fonte única: as comunidades vivem no espelho `remote`, preenchido por
 * `query.communities` (§15.6), e `selectCommunity` lê só de lá. Criar uma
 * comunidade é `community.create` (§15.4) — quem a materializa é o núcleo, e
 * ela aparece aqui pelo resync seguinte, como qualquer outra.
 *
 * Persistido (§4): comunidade e canal ativos sobrevivem entre sessões.
 */
export interface CreateCommunityInput {
  name: string;
  description?: string;
  iconColor: AvatarColor;
}

/** §10, 3.4 — canal nasce numa categoria, sempre (§7, 0.4). */
export interface CreateChannelInput {
  communityId: string;
  categoryId: string;
  type: ChannelType;
  name: string;
  topic?: string;
  /** Cargos que **não** postam aqui — é assim que `#avisos` existe (§2). */
  readOnlyForRoleIds?: string[];
}

/** §13 — expiração e limite de usos são opcionais (premissa 4). */
export interface CreateInviteInput {
  communityId: string;
  createdById: string;
  expiresInDays?: number;
  maxUses?: number;
}

/**
 * Espelho do que o núcleo respondeu — o lugar das fixtures.
 *
 * Os seletores desta store sempre resolveram `criado[id] ?? fixture[id] + override`. A
 * fatia de ligação com a IPC-R troca **só a fonte**: as fixtures de `mocks/dataset` saem e
 * este espelho entra, preenchido pelos adaptadores de §15.6. Nenhum seletor muda de forma e
 * nenhum componente sabe que a origem mudou — que é o ponto.
 *
 * Vive DENTRO do estado do Zustand (e não num módulo à parte) porque é isso que faz os
 * componentes re-renderizarem quando o núcleo responde.
 */
export interface EspelhoRemoto {
  communities: Record<string, Community>;
  /** Ordem de `query.communities` — que é a ordem de entrada (§15.6). */
  order: string[];
  categories: Record<string, Category>;
  channels: Record<string, Channel>;
  roles: Record<string, Role>;
  invites: Invite[];
  membersByCommunity: Record<string, Member[]>;
  /** Chave da identidade local: quem o mock chamava de `IDS.ana`. */
  euId: string | null;
}

export const ESPELHO_VAZIO: EspelhoRemoto = {
  communities: {},
  order: [],
  categories: {},
  channels: {},
  roles: {},
  invites: [],
  membersByCommunity: {},
  euId: null,
};

interface CommunityState {
  /** O que o núcleo respondeu (§15.6), no lugar das fixtures. */
  remote: EspelhoRemoto;
  /** Aplica um lote vindo do núcleo. Substitui, nunca mescla por baixo. */
  aplicarRemoto: (patch: Partial<EspelhoRemoto>) => void;
  /**
   * §17.6 `presence.changed` — o delta de presença aplicado sobre o roster.
   *
   * É a exceção declarada à regra "evento é sinal para reconsultar" (§15.1 r. 5), junto de
   * `voice.signal` e `dm.typing`: presença é efêmera, não tem log por trás, e o tick que a
   * produz é de 2 s — reconsultar `query.members` inteiro a cada tick custaria o roster
   * completo por dois segundos de vida útil. `removed` é quem saiu (TTL de 45 s), e volta
   * a `offline`, que é o que a ausência significa.
   */
  aplicarPresenca: (
    communityId: string,
    entries: ReadonlyArray<{ identityKey: string; status: string }>,
    removed: readonly string[],
  ) => void;
  /** Ordem do rail = ordem de entrada/criação, nunca alfabética (§14). */
  joinedCommunityIds: string[];
  /** Comunidades das quais esta identidade foi banida (preview de 0.3). */
  bannedCommunityIds: string[];
  activeCommunityId: string | null;
  /** Último canal aberto por comunidade — restaurado ao trocar (§4). */
  activeChannelByCommunity: Record<string, string>;
  /**
   * Categorias colapsadas, lembradas por comunidade (§8, 1.1). O estado de
   * colapso é de quem lê, não da comunidade — mas §15.4 tem escrita para ele
   * (`configurarPreferencias`), então este mapa é a leitura otimista sobre o
   * `collapsed` que veio do núcleo, não uma segunda fonte de verdade.
   */
  collapsedCategoryIds: Record<string, string[]>;
  /**
   * Canais abertos recentemente, por comunidade, do mais recente para o mais
   * antigo — é o que a busca mostra antes de o usuário digitar (§8, 1.2).
   */
  recentChannelIds: Record<string, string[]>;
  /**
   * Cargos que a identidade local assume numa comunidade, sobrepondo os que o
   * núcleo respondeu. Existe para §19.1: com uma identidade só, sem isto não há
   * como alcançar a UI que depende de permissão (deletar mensagem de outro
   * autor, por exemplo). Não é persistido, e não altera nada no log — é
   * afordância de conferência de tela, não escrita.
   */
  localRoleOverrides: Record<string, string[]>;


  /**
   * Preferência de leitura sobre o canal que veio do log (§8, 1.1.1). Estrutura NÃO passa
   * mais por aqui: `channel.*`/`category.*` são ops de §15.4 e o espelho é `remote`.
   */
  channelOverrides: Record<string, Partial<Channel>>;

  joinCommunity: (communityId: string) => void;
  setActiveCommunity: (communityId: string) => void;
  setActiveChannel: (communityId: string, channelId: string) => void;
  toggleCategoryCollapsed: (communityId: string, categoryId: string) => void;
  /** Injeta a escrita de preferências de §15.4 — quem faz é o sincronizador. */
  configurarPreferencias: (
    porta:
      | {
          setMuted(channelId: string, muted: boolean): Promise<unknown>;
          setCollapsed(communityId: string, categoryId: string, collapsed: boolean): Promise<unknown>;
        }
      | null,
  ) => void;
  /** Só §19.1 — `null` devolve os cargos que o núcleo respondeu. */
  setLocalRoleOverride: (communityId: string, roleIds: string[] | null) => void;

  /* §10, 3.1b — metadados, convites e zona de perigo. */
  /** Sair da comunidade; o host precisa encerrar, não sair (§18). */

  /* §10, 3.2 — cargos. */
  /** Reordena a hierarquia; Fundador nunca sai do topo (§10, D13). */
  /** `null` remove o apelido e volta a exibir o nome de identidade. */

  /* §10, 3.4 — canais e categorias. */
  /**
   * §15.5 `voice.occupancyChanged` — quem está no canal de voz, para quem NÃO está na
   * chamada. Vem do host por evento, não de `query.structure`: a lista da leitura é do
   * instante da consulta, e a sidebar precisa acompanhar quem entra e sai.
   */
  aplicarOcupacaoDeVoz: (channelId: string, keys: readonly string[]) => void;

  /* §8, 1.1.1 — preferências de leitura, locais de quem lê. */
  toggleChannelMuted: (channelId: string) => void;
  markChannelRead: (channelId: string) => void;

  /** Só para desenvolvimento (§19.1) — carrega o rail de §2 de uma vez. */
  seedReferenceDataset: () => void;
  /** Só para desenvolvimento — volta ao estado de 0 comunidades. */
  resetCommunities: () => void;
}

/**
 * Preferência de leitura (silenciado, lido) sobre o canal que veio do log — §8, 1.1.1. Não é
 * estrutura: estrutura é op de §15.4 e mora no núcleo. Este overlay existe porque a
 * preferência é de quem lê, e o espelho remoto é de todo mundo.
 */
function channelPatch(
  state: CommunityState,
  channelId: string,
  patch: Partial<Channel>,
): Partial<CommunityState> {
  return {
    channelOverrides: {
      ...state.channelOverrides,
      [channelId]: { ...(state.channelOverrides[channelId] ?? {}), ...patch },
    },
  };
}

const EMPTY_STATE = {
  joinedCommunityIds: [] as string[],
  bannedCommunityIds: [] as string[],
  activeCommunityId: null,
  activeChannelByCommunity: {} as Record<string, string>,
  collapsedCategoryIds: {} as Record<string, string[]>,
  recentChannelIds: {} as Record<string, string[]>,
  localRoleOverrides: {} as Record<string, string[]>,
  channelOverrides: {} as Record<string, Partial<Channel>>,
};

/**
 * Porta de escrita das preferências locais de §15.4 (`channel.setMuted`,
 * `category.setCollapsed`) — injetada pelo sincronizador; a store não conhece
 * IPC-R. Falha da escrita não desfaz o estado local: o LS é a primeira fonte,
 * e `query.preferences`/`query.structure` reconciliam no próximo boot.
 */
let portaPreferencias: {
  setMuted(channelId: string, muted: boolean): Promise<unknown>;
  setCollapsed(communityId: string, categoryId: string, collapsed: boolean): Promise<unknown>;
} | null = null;

export const useCommunityStore = create<CommunityState>()(
  persist(
    (set, get) => ({
      ...EMPTY_STATE,
      remote: ESPELHO_VAZIO,

      aplicarRemoto: (patch) => {
        set((state) => ({ remote: { ...state.remote, ...patch } }));
      },

      aplicarPresenca: (communityId, entries, removed) =>
        set((state) => {
          const membros = state.remote.membersByCommunity[communityId];
          if (membros === undefined || (entries.length === 0 && removed.length === 0)) return {};
          const novo = new Map<string, PresenceStatus>();
          for (const e of entries) {
            const status = PRESENCAS_DO_FIO.has(e.status) ? (e.status as PresenceStatus) : null;
            if (status !== null) novo.set(e.identityKey.toLowerCase(), status);
          }
          for (const k of removed) novo.set(k.toLowerCase(), "offline");
          let mudou = false;
          const atualizados = membros.map((m) => {
            const presence = novo.get(m.identityId.toLowerCase());
            if (presence === undefined || presence === m.presence) return m;
            mudou = true;
            return { ...m, presence };
          });
          if (!mudou) return {};
          return {
            remote: {
              ...state.remote,
              membersByCommunity: { ...state.remote.membersByCommunity, [communityId]: atualizados },
            },
          };
        }),

      joinCommunity: (communityId) => {
        const state = get();
        if (state.joinedCommunityIds.includes(communityId)) {
          set({ activeCommunityId: communityId });
          return;
        }
        set({
          joinedCommunityIds: [...state.joinedCommunityIds, communityId],
          activeCommunityId: communityId,
        });
      },

      /*
       * `createCommunity` saiu daqui (§72, B5). Era código morto desde que a criação passou
       * a ir por `live/sessao.ts` → `community.create`: semeava uma comunidade inteira —
       * gênese de §19.1 incluída — só no LS desta máquina, e ninguém a chamava.
       */
      setActiveCommunity: (communityId) =>
        set({ activeCommunityId: communityId }),

      setActiveChannel: (communityId, channelId) =>
        set((state) => {
          const recent = state.recentChannelIds[communityId] ?? [];
          return {
            activeChannelByCommunity: {
              ...state.activeChannelByCommunity,
              [communityId]: channelId,
            },
            recentChannelIds: {
              ...state.recentChannelIds,
              [communityId]: [
                channelId,
                ...recent.filter((id) => id !== channelId),
              ].slice(0, 5),
            },
          };
        }),

      toggleCategoryCollapsed: (communityId, categoryId) =>
        set((state) => {
          const current = state.collapsedCategoryIds[communityId] ?? [];
          const recolher = !current.includes(categoryId);
          const next = recolher
            ? [...current, categoryId]
            : current.filter((id) => id !== categoryId);
          void portaPreferencias?.setCollapsed(communityId, categoryId, recolher).catch(() => {});
          return {
            collapsedCategoryIds: {
              ...state.collapsedCategoryIds,
              [communityId]: next,
            },
          };
        }),

      configurarPreferencias: (porta) => {
        portaPreferencias = porta;
      },

      setLocalRoleOverride: (communityId, roleIds) =>
        set((state) => {
          const next = { ...state.localRoleOverrides };
          if (roleIds === null) delete next[communityId];
          else next[communityId] = roleIds;
          return { localRoleOverrides: next };
        }),

      /* ─── §10, 3.1b — comunidade e convites ────────────────────── */

      /*
       * As escritas de comunidade e convite saíram daqui (§72, B5): `community.update/end/
       * leave` e `invite.create/revoke` são de §15.4 e quem as dispara é
       * `features/settings/CommunitySettings.tsx`. `community.leave` merece nota: ela tem
       * efeito local imediato e enfileira o `member.leave` (L-22, exceção de §11.1) — é o
       * que faz U-29 possível, sair com o host offline.
       */


      /* ─── §10, 3.4 — canais e categorias ───────────────────────── */

      /*
       * As sete escritas de estrutura saíram daqui (§72, B5). `channel.*` e `category.*` são
       * ops SÍNCRONAS de §15.4 (A25/U-02: confirma-depois-desenha, host online, sem fila) e
       * quem as dispara agora é `features/channels/ChannelDialogs.tsx`, direto na IPC-R —
       * mesmo padrão da moderação. O que a tela mostra vem do log pela reconsulta, e não
       * deste store: um canal que só existisse aqui era um canal que o outro lado nunca via.
       */
      aplicarOcupacaoDeVoz: (channelId, keys) =>
        set((state) => {
          const canal = state.remote.channels[channelId];
          if (canal === undefined) return {};
          return {
            remote: {
              ...state.remote,
              channels: { ...state.remote.channels, [channelId]: { ...canal, voiceParticipantIds: [...keys] } },
            },
          };
        }),

      toggleChannelMuted: (channelId) =>
        set((state) => {
          const channel = selectChannel(state, channelId);
          if (!channel) return {};
          void portaPreferencias?.setMuted(channelId, !channel.muted).catch(() => {});
          return channelPatch(state, channelId, { muted: !channel.muted });
        }),

      markChannelRead: (channelId) =>
        set((state) =>
          channelPatch(state, channelId, {
            unreadCount: 0,
            pendingMentions: 0,
            firstUnreadSeq: undefined,
          }),
        ),

      seedReferenceDataset: () =>
        set((state) => ({
          joinedCommunityIds: [...get().remote.order],
          activeCommunityId: state.activeCommunityId ?? get().remote.order[0],
        })),

      resetCommunities: () => set({ ...EMPTY_STATE }),
    }),
    {
      name: "comunidade-p2p:communities",
      version: 1,
      // Cargo assumido é afinador de sessão (§19.1): não sobrevive ao reload.
      partialize: ({ localRoleOverrides: _, ...rest }) => rest,
    },
  ),
);

/* ─── Seletores ──────────────────────────────────────────────────── */

type State = CommunityState;

/**
 * Cache de mesclagem espelho+override, chaveado pelo próprio objeto de
 * override.
 *
 * Sem isto, `selectCommunity` devolveria um objeto novo a cada chamada assim
 * que a comunidade fosse editada — e `useShallow`, que compara elemento a
 * elemento por referência, não salva disso (a armadilha da Parte 4). O
 * override é substituído de forma imutável a cada edição, então a entrada
 * velha do cache morre junto com ele.
 */
const mergedChannels = new WeakMap<object, Channel>();

function merged<T extends object>(
  cache: WeakMap<object, T>,
  base: T,
  override: Partial<T>,
): T {
  const cached = cache.get(override);
  if (cached) return cached;
  const value = { ...base, ...override };
  cache.set(override, value);
  return value;
}

export function selectCommunity(
  state: State,
  communityId: string | null,
): Community | undefined {
  if (!communityId) return undefined;
  return state.remote.communities[communityId];
}

export function selectJoinedCommunities(state: State): Community[] {
  return state.joinedCommunityIds
    .map((id) => selectCommunity(state, id))
    .filter((community): community is Community => community !== undefined);
}

/**
 * Hook para os seletores que montam um array novo a cada chamada.
 * Sem comparação rasa, a store devolveria uma referência diferente em todo
 * render e o `useSyncExternalStore` do Zustand entraria em loop — use este
 * hook em componentes, nunca `useCommunityStore(selectJoinedCommunities)`.
 */
export function useJoinedCommunities(): Community[] {
  return useCommunityStore(useShallow(selectJoinedCommunities));
}

export function useCategories(communityId: string | null): Category[] {
  return useCommunityStore(
    useShallow((state: State) =>
      communityId ? selectCategories(state, communityId) : [],
    ),
  );
}

export function selectCategory(
  state: State,
  categoryId: string,
): Category | undefined {
  return state.remote.categories[categoryId];
}

export function selectCategories(
  state: State,
  communityId: string,
): Category[] {
  const community = selectCommunity(state, communityId);
  if (!community) return [];
  return community.categoryIds
    .map((id) => selectCategory(state, id))
    .filter((category): category is Category => category !== undefined);
}

export function selectChannel(
  state: State,
  channelId: string,
): Channel | undefined {
  const doLog = state.remote.channels[channelId];
  if (doLog === undefined) return undefined;
  // §8, 1.1.1 — silenciado/lido são de quem lê, não do log.
  const pref = state.channelOverrides[channelId];
  return pref ? merged(mergedChannels, doLog, pref) : doLog;
}

/**
 * Quantos canais a comunidade ainda tem. Sustenta a regra do último canal
 * (§10, 3.4): a comunidade nunca fica sem nenhum (§7, 0.4).
 */
export function selectChannelCount(state: State, communityId: string): number {
  return selectCategories(state, communityId).reduce(
    (total, category) =>
      total +
      category.channelIds.filter((id) => selectChannel(state, id)).length,
    0,
  );
}

/**
 * Não-lidas da comunidade inteira, para o rail (§8, 1.1).
 *
 * Canal silenciado (§8, 1.1.1) não conta pro traço de não-lida, mas menção
 * direta continua contando: silenciar reduz ruído, não esconde alguém te
 * chamando pelo nome.
 */
export function selectCommunityUnread(
  state: State,
  communityId: string,
): { unread: boolean; mentions: number } {
  let unread = false;
  let mentions = 0;
  for (const category of selectCategories(state, communityId)) {
    for (const channelId of category.channelIds) {
      const channel = selectChannel(state, channelId);
      if (!channel) continue;
      if (!channel.muted && channel.unreadCount > 0) unread = true;
      mentions += channel.pendingMentions;
    }
  }
  return { unread: unread || mentions > 0, mentions };
}

export function useCommunityUnread(communityId: string): {
  unread: boolean;
  mentions: number;
} {
  return useCommunityStore(
    useShallow((state: State) => selectCommunityUnread(state, communityId)),
  );
}

export function useChannelCount(communityId: string | null): number {
  return useCommunityStore((state) =>
    communityId ? selectChannelCount(state, communityId) : 0,
  );
}

export function useCategory(categoryId: string | null): Category | undefined {
  return useCommunityStore((state) =>
    categoryId ? selectCategory(state, categoryId) : undefined,
  );
}

export function useChannel(channelId: string | null): Channel | undefined {
  return useCommunityStore((state) =>
    channelId ? selectChannel(state, channelId) : undefined,
  );
}

export function selectRole(state: State, roleId: string): Role | undefined {
  return state.remote.roles[roleId];
}

/** Cargos da comunidade, do topo da hierarquia para baixo (§10, 3.2). */
export function selectRoles(state: State, communityId: string): Role[] {
  const community = selectCommunity(state, communityId);
  if (!community) return [];
  return community.roleIds
    .map((roleId) => selectRole(state, roleId))
    .filter((role): role is Role => role !== undefined)
    .sort((a, b) => b.position - a.position);
}

export function useRoles(communityId: string | null): Role[] {
  return useCommunityStore(
    useShallow((state: State) =>
      communityId ? selectRoles(state, communityId) : [],
    ),
  );
}

/**
 * Busca de membro com a MESMA assinatura de `findMember` das fixtures, para as telas não
 * precisarem mudar de forma. O hook assina o roster do espelho: quando `query.members`
 * responde, quem chama re-renderiza sozinho.
 */
export function useFindMember(): (communityId: string, identityId: string) => Member | undefined {
  const roster = useCommunityStore((state) => state.remote.membersByCommunity);
  return (communityId, identityId) =>
    roster[communityId]?.find((m) => m.identityId === identityId);
}

/** Idem para `findMembers(communityId)`. */
export function useFindMembers(): (communityId: string) => Member[] {
  const roster = useCommunityStore((state) => state.remote.membersByCommunity);
  return (communityId) => roster[communityId] ?? NENHUM_MEMBRO;
}

/**
 * Versão sem hook, para módulos puros (autocomplete de menção, impacto de saída) que são
 * chamados sob demanda e não precisam re-renderizar por conta própria.
 */
export function membrosDaComunidade(communityId: string): Member[] {
  return useCommunityStore.getState().remote.membersByCommunity[communityId] ?? NENHUM_MEMBRO;
}

const NENHUM_MEMBRO: Member[] = [];

/** Membro no roster que o núcleo respondeu — o lugar de `findMember` das fixtures. */
function membroDo(state: State, communityId: string, identityId: string): Member | undefined {
  return state.remote.membersByCommunity[communityId]?.find((m) => m.identityId === identityId);
}

/**
 * Apelido de um membro nesta comunidade (§8, 1.4) — vem do roster de
 * `query.members`, como todo o resto do membro. Auto-atribuído (premissa 11),
 * então na prática só a própria pessoa o escreve, por `member.setNickname`
 * (§15.4). `undefined` é "nunca definiu".
 */
export function selectMemberNickname(
  state: State,
  communityId: string,
  identityId: string,
): string | undefined {
  return membroDo(state, communityId, identityId)?.nickname;
}

/**
 * Como um membro é chamado nesta comunidade: apelido, senão nome de
 * identidade. Toda tela que escreve o nome de alguém passa por aqui, senão
 * mudar o apelido só teria efeito em metade da interface.
 */
export function selectMemberLabel(
  state: State,
  communityId: string,
  identityId: string,
): string {
  return (
    selectMemberNickname(state, communityId, identityId) ??
    membroDo(state, communityId, identityId)?.displayName ??
    "Membro"
  );
}

export function useMemberLabel(
  communityId: string,
  identityId: string,
): string {
  return useCommunityStore((state) =>
    selectMemberLabel(state, communityId, identityId),
  );
}

/** Cargos de um membro, como o roster de `query.members` os responde (§15.6). */
export function selectMemberRoleIds(
  state: State,
  communityId: string,
  identityId: string,
): string[] {
  return membroDo(state, communityId, identityId)?.roleIds ?? [];
}

/** Convites ativos da comunidade — `query.invites` é a fonte (§15.6). */
export function selectInvites(state: State, communityId: string): Invite[] {
  return state.remote.invites.filter(
    (invite) => invite.communityId === communityId && !invite.revoked,
  );
}

export function useInvites(communityId: string | null): Invite[] {
  return useCommunityStore(
    useShallow((state: State) =>
      communityId ? selectInvites(state, communityId) : [],
    ),
  );
}

/**
 * Primeiro canal de texto da primeira categoria — destino padrão ao entrar
 * numa comunidade (§7, 0.3/0.4) ou ao visitá-la pela primeira vez (§4).
 */
export function selectFirstTextChannelId(
  state: State,
  communityId: string,
): string | undefined {
  for (const category of selectCategories(state, communityId)) {
    for (const channelId of category.channelIds) {
      const channel = selectChannel(state, channelId);
      if (channel?.type === "text") return channel.id;
    }
  }
  return undefined;
}

/**
 * Canal aberto na comunidade ativa. Se o canal lembrado não resolve mais
 * (ou a comunidade nunca foi visitada), cai no primeiro canal de texto —
 * assim a área de conteúdo nunca renderiza vazia esperando um efeito.
 */
export function useActiveChannel(): Channel | undefined {
  return useCommunityStore((state) => {
    const communityId = state.activeCommunityId;
    if (!communityId) return undefined;

    const channelId = state.activeChannelByCommunity[communityId];
    const channel = channelId ? selectChannel(state, channelId) : undefined;
    if (channel) return channel;

    const firstId = selectFirstTextChannelId(state, communityId);
    return firstId ? selectChannel(state, firstId) : undefined;
  });
}

export function useChannels(channelIds: string[]): Channel[] {
  return useCommunityStore(
    useShallow((state: State) =>
      channelIds
        .map((id) => selectChannel(state, id))
        .filter((channel): channel is Channel => channel !== undefined),
    ),
  );
}

/** Todos os canais de texto da comunidade, na ordem das categorias (§14). */
export function useTextChannels(communityId: string | null): Channel[] {
  return useCommunityStore(
    useShallow((state: State) => {
      if (!communityId) return [];
      const channels: Channel[] = [];
      for (const category of selectCategories(state, communityId)) {
        for (const channelId of category.channelIds) {
          const channel = selectChannel(state, channelId);
          if (channel?.type === "text") channels.push(channel);
        }
      }
      return channels;
    }),
  );
}

/** Canais visitados recentemente, já resolvidos e ainda existentes. */
export function useRecentChannels(communityId: string | null): Channel[] {
  return useCommunityStore(
    useShallow((state: State) =>
      communityId
        ? (state.recentChannelIds[communityId] ?? [])
            .map((id) => selectChannel(state, id))
            .filter((channel): channel is Channel => channel !== undefined)
        : [],
    ),
  );
}

export function useCollapsedCategoryIds(communityId: string | null): string[] {
  return useCommunityStore(
    useShallow((state: State) =>
      communityId ? (state.collapsedCategoryIds[communityId] ?? []) : [],
    ),
  );
}

/**
 * Cargos da identidade local *dentro* desta comunidade.
 *
 * Sai de `remote.euId` + o roster de `query.members` (§15.6) — quem a
 * comunidade diz que a identidade local é. `localRoleOverrides` só entra na
 * frente para a conferência de tela de §19.1. Em comunidade criada aqui, quem
 * cria é a fundadora (§11, A3).
 */
export function selectLocalMemberRoleIds(
  state: State,
  communityId: string,
): string[] {
  const override = state.localRoleOverrides[communityId];
  if (override) return override;
  const eu = state.remote.euId;
  return eu === null ? [] : selectMemberRoleIds(state, communityId, eu);
}

/**
 * Regra de hierarquia de §10, aplicada em toda a spec: só dá para moderar
 * alguém cujo cargo mais alto esteja **abaixo** do seu. Nunca igual, nunca
 * superior, e o Fundador/host nunca é alvo de ação nenhuma.
 */
export function selectCanModerate(
  state: State,
  communityId: string,
  targetId: string,
): boolean {
  // Ninguém modera a si mesmo (§10) — `E_SELF_TARGET` no núcleo.
  if (targetId === state.remote.euId) return false;
  const targetRoles = selectMemberRoleIds(state, communityId, targetId);
  const target = selectHighestRole(state, targetRoles);
  if (target?.isFounder) return false;
  // O host CORRENTE também é imune (§9.3, R-16 — `E_HOST_IMMUNE`). Depois de uma
  // sucessão (R-18) quem assume não carrega o cargo Fundador, então conferir só
  // `isFounder` deixava o novo host aparecer como alvo de quem está acima dele.
  if (selectCommunity(state, communityId)?.hostPeerId === targetId) return false;

  const mine = selectHighestRole(
    state,
    selectLocalMemberRoleIds(state, communityId),
  );
  if (!mine) return false;
  return mine.position > (target?.position ?? 0);
}

/**
 * Posição do cargo mais alto da identidade local — o `topRank(autor)` de §9.3, na
 * ordinalização de `adaptadores.cargo`. `0` é "nenhum cargo conhecido", que já não
 * autoriza nada porque a comparação é estrita.
 */
export function selectLocalTopPosition(state: State, communityId: string): number {
  return (
    selectHighestRole(state, selectLocalMemberRoleIds(state, communityId))?.position ?? 0
  );
}

/**
 * `efetiva(autor)` de §9.2 — a união das permissões de todos os cargos ativos da
 * identidade local. É o que R-5 usa para decidir o que ela pode conceder.
 */
export function selectLocalPermissions(
  state: State,
  communityId: string,
): Set<Permission> {
  const efetiva = new Set<Permission>();
  for (const roleId of selectLocalMemberRoleIds(state, communityId)) {
    for (const p of selectRole(state, roleId)?.permissions ?? []) efetiva.add(p);
  }
  return efetiva;
}

/**
 * R-4 de §8.3: o autor não cria, edita, move nem atribui cargo cujo `rank` seja maior ou
 * igual ao próprio topo. O cargo Fundador é imutável antes disso (`E_FOUNDER_IMMUTABLE`,
 * passo 1 de §9.3), então nem para o próprio Fundador ele é alvo.
 */
export function selectCanActOnRole(
  state: State,
  communityId: string,
  role: Role,
): boolean {
  if (role.isFounder) return false;
  return selectLocalTopPosition(state, communityId) > role.position;
}

/**
 * Quem a identidade local *é* dentro desta comunidade, como id de autor.
 * Nas comunidades de §2 ela ocupa o lugar de Ana Torres (§19.2 pede que Ana
 * seja a mesma entidade em toda tela); nas criadas no app, é ela mesma.
 */
export function useLocalMemberId(_communityId: string): string {
  // Com dado real não há mais "o lugar de Ana": a identidade local é a chave desta
  // instalação, e ela é a mesma em toda comunidade (§6.1).
  const identityId = useIdentityStore((state) => state.identity?.id);
  const euId = useCommunityStore((state) => state.remote.euId);
  return identityId ?? euId ?? "";
}

/**
 * Permissão da identidade local nesta comunidade (§10, 3.2) — união das
 * permissões de todos os cargos dela. Decide, por exemplo, se `@everyone`
 * aparece no autocomplete de menção (§9, 2.1.1).
 */
export function selectHasPermission(
  state: State,
  communityId: string,
  permission: Permission,
): boolean {
  return selectLocalMemberRoleIds(state, communityId).some((roleId) =>
    selectRole(state, roleId)?.permissions.includes(permission),
  );
}

export function useHasPermission(
  communityId: string,
  permission: Permission,
): boolean {
  return useCommunityStore((state) =>
    selectHasPermission(state, communityId, permission),
  );
}

/**
 * §17.4 (emenda de 2026-08-28) — o espelho local do gate de transmissão do modo de fala
 * (§6.6): decide se o botão de mute habilita e com que rótulo. É CONSELHO de UI — quem
 * decide de verdade é o host no `voiceState`, e o roster manda o estado final de volta.
 * No modo fila a resposta completa depende da fila de §16.4 (`turnHolderId`); sem fila,
 * ninguém é titular e ninguém transmite.
 */
export function selectCanTransmitIn(
  state: State,
  channelId: string,
  turnHolderId?: string | null,
): boolean {
  const channel = state.remote.channels[channelId];
  if (channel === undefined || channel.type !== "voice") return true;
  if (channel.speechMode === "queue") {
    return turnHolderId !== undefined && turnHolderId !== null &&
      turnHolderId === state.remote.euId;
  }
  if (channel.speechMode === "admins") {
    const communityId = channel.communityId;
    return selectHasPermission(state, communityId, "voice_mute_others");
  }
  return true;
}

/** Cargo mais alto da hierarquia entre os informados (§10, regra de cargo). */
export function selectHighestRole(
  state: State,
  roleIds: string[],
): Role | undefined {
  let highest: Role | undefined;
  for (const roleId of roleIds) {
    const role = selectRole(state, roleId);
    if (!role) continue;
    if (!highest || role.position > highest.position) highest = role;
  }
  return highest;
}

/**
 * Canal somente-leitura para a identidade local (§9, 2.1 — `#avisos`).
 * Vale quando *todos* os cargos dela estão na lista de somente-leitura:
 * basta um cargo de fora (Moderador+) para liberar o composer.
 *
 * **Quem resolve é o núcleo.** `ChannelDto.readOnly` (§15.6) já vem decidido para quem
 * perguntou, pela MESMA função que o `fold` usa em R-22; recalcular aqui seria uma segunda
 * cópia da regra, e foi assim que a divergência anterior nasceu. A resolução local abaixo
 * sobrevive só para o canal montado nesta sessão, que ainda não passou por `query.structure`.
 */
export function selectIsChannelReadOnly(
  state: State,
  channel: Channel,
): boolean {
  if (channel.readOnly !== undefined) return channel.readOnly;
  const readOnlyFor = channel.readOnlyForRoleIds;
  if (!readOnlyFor || readOnlyFor.length === 0) return false;
  const roleIds = selectLocalMemberRoleIds(state, channel.communityId);
  if (roleIds.length === 0) return false;
  // Conjunto: a lista do canal é a mesma para todos os cargos consultados.
  const somenteLeitura = new Set(readOnlyFor);
  return roleIds.every((roleId) => somenteLeitura.has(roleId));
}
