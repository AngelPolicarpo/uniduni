import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  Dispatch,
  KeyboardEvent as ReactKeyboardEvent,
  SetStateAction,
} from "react";
import { Search, X } from "lucide-react";
import { cn } from "../../lib/cn";
import { StatusBanner } from "../../components/ui/StatusBanner";
import { useCommunityStore } from "../../store/communityStore";
import { useUiStore } from "../../store/uiStore";
import { LISTA_ID, hasFilters, opcaoId } from "./searchIndex";
import type { SearchFilters } from "./searchIndex";
import { SearchFilterBar } from "./SearchFilterBar";
import { SearchResults } from "./SearchResults";
import type { Selectable } from "./SearchResults";
import { useSearchQuery } from "./useSearchQuery";
import type { Channel, Community } from "../../domain/types";

/** Uma frase por causa de `partial` (§23.1/RT-11) — o fio nomeia, a tela explica. */
const MOTIVO_PARCIAL: Record<string, string> = {
  "host-offline": "Buscando só no histórico salvo neste dispositivo — o host está offline",
  "catching-up": "Resultado parcial — ainda sincronizando o histórico desta comunidade",
  "stalled": "Resultado parcial — esta réplica está sem avançar há um tempo",
  "partial-interpretation": "Resultado parcial — parte do log ainda não foi interpretada",
};

export interface SearchPanelProps {
  community: Community;
  activeChannel: Channel | undefined;
}

/**
 * Painel de busca (§8, 1.2) — overlay centralizado no topo, não painel
 * lateral: §15 lista a busca junto dos painéis do slot direito, mas §8 e §6
 * a descrevem como command palette, e é a descrição da tela que vale.
 *
 * Um motor, dois pontos de entrada: a lupa do cabeçalho abre no canal atual,
 * `Cmd/Ctrl+K` abre na comunidade inteira, e o escopo troca sem fechar.
 *
 * Aqui ficam o campo, a navegação por teclado e o que cada resultado faz ao
 * ser ativado; a consulta é de `useSearchQuery`, os filtros de
 * `SearchFilterBar` e a lista de `SearchResults`.
 */
export function SearchPanel({ community, activeChannel }: SearchPanelProps) {
  const scope = useUiStore((state) => state.searchScope);
  const closeSearch = useUiStore((state) => state.closeSearch);
  const highlightMessage = useUiStore((state) => state.highlightMessage);
  const toggleMembersPanel = useUiStore((state) => state.toggleMembersPanel);
  const setMobilePane = useUiStore((state) => state.setMobilePane);
  const setActiveChannel = useCommunityStore((state) => state.setActiveChannel);

  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<SearchFilters>({});
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDialogElement>(null);

  const {
    debounced,
    results,
    carregando,
    erro,
    expandMessages,
    setExpandMessages,
    visibleMessages,
  } = useSearchQuery({
    communityId: community.id,
    query,
    filters,
    scope,
    activeChannel,
  });

  // `show()` e não `showModal()`: o fechamento por clique fora mora no scrim
  // que envolve este `<dialog>`, e o top layer do modal deixaria esse scrim
  // inert — o clique fora pararia de fechar a busca. O `<dialog>` dá a
  // semântica ao leitor de tela; `Esc` e o clique fora continuam nossos.
  useLayoutEffect(() => {
    const gatilho = document.activeElement;
    containerRef.current?.show();
    return () => {
      if (gatilho instanceof HTMLElement && gatilho.isConnected) gatilho.focus();
    };
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // A seleção volta ao topo em quem a invalida — digitar e mexer em filtro —, e não num
  // efeito depois da pintura: ali o Enter apertado no mesmo quadro ainda abria o resultado
  // apontado pela lista anterior.
  function digitar(texto: string) {
    setQuery(texto);
    setSelected(0);
  }

  const aplicarFiltros: Dispatch<SetStateAction<SearchFilters>> = (acao) => {
    setFilters(acao);
    setSelected(0);
  };

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closeSearch();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closeSearch]);

  // Trocar o escopo é trocar a consulta: manter o índice apontaria para um
  // resultado da lista anterior.
  const escopoAnterior = useRef(scope);
  if (escopoAnterior.current !== scope) {
    escopoAnterior.current = scope;
    if (selected !== 0) setSelected(0);
  }

  const searching = carregando || query !== debounced;
  // Olha a digitação viva, não a debounced: senão o estado vazio ("canais
  // recentes") pisca por 250ms no lugar do skeleton a cada primeira busca.
  const asked = query.trim() !== "" || hasFilters(filters);

  const flat: Selectable[] = useMemo(
    () => [
      ...visibleMessages.map((message) => ({ type: "message" as const, message })),
      ...results.channels.map((channel) => ({ type: "channel" as const, channel })),
      ...results.members.map((member) => ({ type: "member" as const, member })),
    ],
    [visibleMessages, results.channels, results.members],
  );

  function openChannel(channelId: string) {
    setActiveChannel(community.id, channelId);
    setMobilePane("content");
  }

  function activate(item: Selectable) {
    if (item.type === "message") {
      openChannel(item.message.channelId);
      highlightMessage(item.message.id);
    } else if (item.type === "channel") {
      openChannel(item.channel.id);
    } else {
      // Sem gatilho ancorado aqui, o destino do membro é a lista (1.3).
      toggleMembersPanel();
    }
    closeSearch();
  }

  function handleKeyDown(event: ReactKeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      // Lista vazia não tem "próximo": sem a guarda, o clamp devolvia -1.
      if (flat.length > 0) setSelected((index) => Math.min(index + 1, flat.length - 1));
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((index) => Math.max(index - 1, 0));
    }
    if (event.key === "Enter" && flat[selected]) {
      event.preventDefault();
      activate(flat[selected]);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-surface-overlay-scrim tablet:items-center tablet:pt-[10vh]"
      onPointerDown={(event) => {
        if (!containerRef.current?.contains(event.target as Node)) closeSearch();
      }}
    >
      <dialog
        ref={containerRef}
        aria-label="Buscar"
        onKeyDown={handleKeyDown}
        className={cn(
          // `hidden open:flex` e não `flex`: um utilitário de `display` vence a
          // regra `dialog:not([open])` do agente de usuário, e o painel
          // apareceria antes do `show()`.
          "hidden h-full w-full min-h-0 flex-col overflow-hidden open:flex",
          "bg-surface-elevated text-text-primary",
          // Zera o estilo de agente de usuário do `<dialog>` (posição
          // absoluta, margem automática, padding e limites de tamanho), como
          // em `Modal`: aqui quem posiciona é o flex do scrim.
          "static m-0 max-h-none max-w-none p-0",
          "tablet:h-auto tablet:max-h-[70vh] tablet:w-[600px]",
          "tablet:rounded-lg tablet:border tablet:border-border-default tablet:shadow-elevated",
          "animate-modal-in",
        )}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-4 py-3">
          <Search
            size={20}
            strokeWidth={2}
            aria-hidden="true"
            className="shrink-0 text-text-tertiary"
          />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => digitar(event.target.value)}
            // O foco fica no campo e as setas movem a seleção na lista: quem diz ao leitor
            // de tela QUAL resultado está apontado é o `aria-activedescendant`.
            role="combobox"
            aria-expanded={asked}
            aria-controls={LISTA_ID}
            aria-autocomplete="list"
            aria-activedescendant={
              flat[selected] === undefined ? undefined : opcaoId(selected)
            }
            placeholder={
              scope === "channel" && activeChannel
                ? `Buscar em #${activeChannel.name}`
                : `Buscar em ${community.name}`
            }
            aria-label="Buscar"
            className="min-w-0 flex-1 bg-transparent text-body text-text-primary outline-none placeholder:text-text-tertiary"
          />
          {query !== "" && (
            <button
              type="button"
              onClick={() => digitar("")}
              className="shrink-0 rounded-sm text-text-tertiary hover:text-text-primary"
            >
              <X size={16} strokeWidth={2} aria-hidden="true" />
              <span className="sr-only">Limpar busca</span>
            </button>
          )}
        </div>

        <SearchFilterBar
          community={community}
          activeChannel={activeChannel}
          scope={scope}
          filters={filters}
          setFilters={aplicarFiltros}
        />

        {erro !== null && (
          <StatusBanner tone="offline">
            Não foi possível buscar agora ({erro})
          </StatusBanner>
        )}

        {erro === null && results.partial && results.partialReason !== undefined && (
          <StatusBanner tone={results.partialReason === "host-offline" ? "offline" : "reconnecting"}>
            {MOTIVO_PARCIAL[results.partialReason] ??
              "Resultado parcial desta réplica"}
          </StatusBanner>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          <SearchResults
            community={community}
            debounced={debounced}
            filters={filters}
            results={results}
            visibleMessages={visibleMessages}
            asked={asked}
            searching={searching}
            selected={selected}
            onHover={setSelected}
            onActivate={activate}
            expandMessages={expandMessages}
            onExpandMessages={() => setExpandMessages(true)}
            onOpenChannel={(channelId) => {
              openChannel(channelId);
              closeSearch();
            }}
          />
        </div>
      </dialog>
    </div>
  );
}
