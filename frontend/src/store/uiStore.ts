import { create } from "zustand";

/**
 * Estado de sessão da interface (§4) — nada disso vive no router, porque
 * nenhuma dessas coisas é um recurso endereçável.
 *
 * Só o que a Camada 0 precisa por enquanto; painéis (membros/busca/thread),
 * modais de configuração e estado de voz entram nas camadas seguintes.
 */
export type OverlayKind =
  | "join-community"
  | "create-community"
  /** §10, 3.1 — configurações de conta, independentes de comunidade. */
  | "account-settings"
  /** §10, 3.1b — configurações da comunidade ativa (Geral/Cargos/Moderação). */
  | "community-settings"
  /*
   * §10, 3.5 — o aviso de saída do host **não** entra aqui.
   *
   * Ele chegou a ser um `overlay`, e o slot é único: abrir o aviso descartava o modal que
   * estivesse aberto (criar comunidade, editar cargo) junto com o que não tinha sido
   * salvo, e cancelar o fechamento devolvia a tela vazia. Um pedido do main não é
   * navegação da pessoa — mora no `HostExitListener`, que é quem responde ao main.
   */
  | null;

/** De onde 0.3 foi aberta — muda se o passo 1 (colar código) aparece. */
export type JoinSource = "manual" | "link";

/**
 * O que a área principal está mostrando: a comunidade ativa ou a conversa direta (U-33).
 *
 * É a proposta declarada de **B63(a)** — a DM como entrada no topo do rail, trocando a
 * sidebar pela lista de conversas e o painel principal pela conversa —, e B63(a) continua
 * aberta: nem §31 nem `frontend.md` decidem onde a DM mora. Ficou aqui, e não em
 * `communityStore`, exatamente porque é escolha de navegação e não estado de comunidade:
 * mudar a decisão de B63 troca quem lê este campo, não o resto.
 */
export type Destino = "comunidade" | "dm";

/**
 * §16, Mobile: uma coluna por vez. Qual das duas está em foco não faz
 * sentido no Tablet/Desktop, onde as duas convivem — por isso é só estado de
 * sessão, sem persistência.
 */
export type MobilePane = "channels" | "content";

/**
 * Slot único de painel à direita (§6, §15): membros e thread dividem o
 * mesmo espaço, então abrir um fecha o outro por construção — é um valor só,
 * não dois booleanos que poderiam ficar ambos verdadeiros.
 *
 * A busca (1.2) *não* entra aqui: §8 a descreve como overlay centralizado no
 * topo (command palette), não como painel lateral.
 */
export type RightPanel =
  | { kind: "members" }
  | { kind: "thread"; rootMessageId: string }
  /** §9, 2.1.2 — fixados/arquivos/links do canal, no mesmo slot. */
  | { kind: "channel-info" }
  | null;

/**
 * Escopo inicial da busca (§8, 1.2): o ícone de lupa do canal abre no canal
 * atual; `Cmd/Ctrl+K` abre na comunidade inteira. Um motor, dois pontos de
 * entrada — e dá para trocar de escopo sem fechar.
 */
export type SearchScope = "channel" | "community";

/**
 * §10, 3.4 — gestão de canais e categorias. Fora do `overlay` porque cada
 * caixa destas carrega o alvo junto (qual canal, qual categoria), e um union
 * de strings não tem onde guardar isso.
 */
export type ChannelDialog =
  | { kind: "create-channel"; categoryId?: string }
  | { kind: "edit-channel"; channelId: string }
  | { kind: "delete-channel"; channelId: string }
  | { kind: "create-category" }
  | { kind: "rename-category"; categoryId: string }
  | { kind: "delete-category"; categoryId: string }
  | null;

/** §9, 2.1 — highlight breve da mensagem alcançada por busca ou link. */
export const HIGHLIGHT_MS = 1500;

interface UiState {
  destino: Destino;
  /**
   * U-33 — o modal de abrir conversa (§31.16.1 `dm.open`). Mora aqui porque **duas
   * colunas** o abrem: a lista, que fica na coluna da esquerda do shell, e o painel
   * vazio, que fica na área de conteúdo. Não há componente que contenha os dois, e o
   * deep link `u/` (B64) o abre de fora dos dois.
   */
  dmNovaConversa: boolean;
  overlay: OverlayKind;
  joinSource: JoinSource;
  mobilePane: MobilePane;
  rightPanel: RightPanel;
  searchScope: SearchScope | null;
  highlightedMessageId: string | null;
  channelDialog: ChannelDialog;
  abrirDm: () => void;
  abrirNovaConversa: () => void;
  fecharNovaConversa: () => void;
  abrirComunidades: () => void;
  openJoinCommunity: (source?: JoinSource) => void;
  openCreateCommunity: () => void;
  openAccountSettings: () => void;
  openCommunitySettings: () => void;
  closeOverlay: () => void;
  setMobilePane: (pane: MobilePane) => void;
  toggleMembersPanel: () => void;
  toggleChannelInfoPanel: () => void;
  openThreadPanel: (rootMessageId: string) => void;
  closeRightPanel: () => void;
  openSearch: (scope: SearchScope) => void;
  setSearchScope: (scope: SearchScope) => void;
  closeSearch: () => void;
  highlightMessage: (messageId: string) => void;
  openChannelDialog: (dialog: NonNullable<ChannelDialog>) => void;
  closeChannelDialog: () => void;
}

export const useUiStore = create<UiState>()((set) => ({
  destino: "comunidade",
  dmNovaConversa: false,
  overlay: null,
  joinSource: "manual",
  mobilePane: "channels",
  rightPanel: null,
  searchScope: null,
  highlightedMessageId: null,
  channelDialog: null,

  // Trocar de destino volta o Mobile para a coluna da lista: a navegação sequencial de
  // §16 começa pela esquerda, e cair direto no conteúdo esconderia a lista recém-aberta.
  abrirDm: () => set({ destino: "dm", mobilePane: "channels", rightPanel: null }),
  abrirComunidades: () => set({ destino: "comunidade" }),

  abrirNovaConversa: () => set({ dmNovaConversa: true }),
  fecharNovaConversa: () => set({ dmNovaConversa: false }),

  openJoinCommunity: (source = "manual") =>
    set({ overlay: "join-community", joinSource: source }),

  openCreateCommunity: () => set({ overlay: "create-community" }),

  openAccountSettings: () => set({ overlay: "account-settings" }),

  openCommunitySettings: () => set({ overlay: "community-settings" }),

  closeOverlay: () => set({ overlay: null }),

  setMobilePane: (pane) => set({ mobilePane: pane }),

  toggleMembersPanel: () =>
    set((state) => ({
      rightPanel: state.rightPanel?.kind === "members" ? null : { kind: "members" },
    })),

  toggleChannelInfoPanel: () =>
    set((state) => ({
      rightPanel:
        state.rightPanel?.kind === "channel-info" ? null : { kind: "channel-info" },
    })),

  openThreadPanel: (rootMessageId) =>
    set({ rightPanel: { kind: "thread", rootMessageId } }),

  closeRightPanel: () => set({ rightPanel: null }),

  openSearch: (scope) => set({ searchScope: scope }),
  setSearchScope: (scope) => set({ searchScope: scope }),
  closeSearch: () => set({ searchScope: null }),

  openChannelDialog: (dialog) => set({ channelDialog: dialog }),
  closeChannelDialog: () => set({ channelDialog: null }),

  highlightMessage: (messageId) => {
    set({ highlightedMessageId: messageId });
    window.setTimeout(() => {
      // Só apaga se ainda for a mesma: outra busca no meio manda nela.
      if (useUiStore.getState().highlightedMessageId === messageId)
        set({ highlightedMessageId: null });
    }, HIGHLIGHT_MS);
  },
}));
