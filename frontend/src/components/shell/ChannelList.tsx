import { ChevronDown, FolderPlus, Plus, Settings } from "lucide-react";
import { cn } from "../../lib/cn";
import { ChannelListItem } from "./ChannelListItem";
import { useContextMenu } from "./useContextMenu";
import { Menu } from "../ui/Menu";
import { Tooltip } from "../ui/Tooltip";
import {
  useCategories,
  useChannels,
  useCollapsedCategoryIds,
  useCommunityStore,
  useHasPermission,
} from "../../store/communityStore";
import { useHostStatus } from "../../store/connectionStore";
import { useUiStore } from "../../store/uiStore";
import { OFFLINE_HINT } from "../../live/recusas";
import type { Category, Community } from "../../domain/types";



interface CategorySectionProps {
  category: Category;
  collapsed: boolean;
  activeChannelId: string | undefined;
  canManage: boolean;
  hostOnline: boolean;
  communityName: string;
  onToggle: () => void;
  onSelectChannel: (channelId: string) => void;
  onJoinVoice: (channelId: string) => void;
}

function CategorySection({
  category,
  collapsed,
  activeChannelId,
  canManage,
  hostOnline,
  communityName,
  onToggle,
  onSelectChannel,
  onJoinVoice,
}: CategorySectionProps) {
  const channels = useChannels(category.channelIds);
  const openChannelDialog = useUiStore((state) => state.openChannelDialog);
  const menu = useContextMenu();

  return (
    <section
      className="group/category mb-4 last:mb-0"
      onContextMenu={
        canManage && hostOnline
          ? (event) => {
              // Só o header abre o menu da categoria; dentro dos canais o
              // menu do próprio canal já cuidou do evento.
              if ((event.target as HTMLElement).closest("li")) return;
              event.preventDefault();
              menu.show();
            }
          : undefined
      }
    >
      <div className="relative flex items-center gap-1 pr-1">
        <h3 className="min-w-0 flex-1">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          className={cn(
            "flex w-full items-center gap-1 rounded-sm px-1 py-1",
            "text-caption text-text-tertiary uppercase",
            "transition-colors duration-(--duration-fast) ease-out",
            "hover:text-text-secondary",
          )}
        >
          <ChevronDown
            size={16}
            strokeWidth={2}
            aria-hidden="true"
            className={cn(
              "shrink-0 transition-transform duration-(--duration-fast) ease-out",
              collapsed && "-rotate-90",
            )}
          />
          <span className="truncate">{category.name}</span>
        </button>
        </h3>

        {/*
          §10, 3.4 — "+" da categoria: aparece no hover no Desktop/Tablet e
          fica sempre visível no Mobile, onde não existe hover.
        */}
        {canManage && (
          <Tooltip
            label={
              hostOnline
                ? `Criar canal em ${category.name}`
                : `${communityName} está offline — a estrutura de canais ${OFFLINE_HINT}`
            }
            side="top"
          >
            <button
              type="button"
              disabled={!hostOnline}
              onClick={() =>
                openChannelDialog({
                  kind: "create-channel",
                  categoryId: category.id,
                })
              }
              /*
                O rótulo acessível acompanha o do tooltip quando o botão está
                inativo. Com um `aria-label` fixo, quem usa leitor de tela ouvia
                "Criar canal em Geral, indisponível" e o **porquê** ficava só no
                balão de hover — que teclado e leitor de tela não alcançam.
              */
              aria-label={
                hostOnline
                  ? `Criar canal em ${category.name}`
                  : `Criar canal em ${category.name} — ${communityName} está offline, a estrutura de canais ${OFFLINE_HINT}`
              }
              className={cn(
                "grid size-6 shrink-0 place-items-center rounded-sm",
                "text-text-tertiary transition-colors duration-(--duration-fast) ease-out",
                "hover:bg-surface-primary hover:text-text-primary",
                "disabled:cursor-not-allowed disabled:text-text-disabled disabled:hover:bg-transparent",
                "tablet:invisible tablet:group-hover/category:visible tablet:focus-visible:visible",
              )}
            >
              <Plus size={16} strokeWidth={2} aria-hidden="true" />
            </button>
          </Tooltip>
        )}

        {canManage && hostOnline && (
          <Menu
            open={menu.open}
            onClose={menu.close}
            side="bottom"
            items={[
              {
                id: "create",
                label: "Criar canal aqui",
                icon: <Plus size={16} strokeWidth={2} />,
                onSelect: () =>
                  openChannelDialog({
                    kind: "create-channel",
                    categoryId: category.id,
                  }),
              },
              {
                id: "rename",
                label: "Renomear categoria",
                icon: <FolderPlus size={16} strokeWidth={2} />,
                onSelect: () =>
                  openChannelDialog({
                    kind: "rename-category",
                    categoryId: category.id,
                  }),
              },
              {
                id: "delete",
                label: "Excluir categoria",
                danger: true,
                onSelect: () =>
                  openChannelDialog({
                    kind: "delete-category",
                    categoryId: category.id,
                  }),
              },
            ]}
          />
        )}
      </div>

      {!collapsed && (
        <ul className="mt-0.5 flex flex-col gap-0.5">
          {channels.map((channel) => (
            <ChannelListItem
              key={channel.id}
              channel={channel}
              active={channel.id === activeChannelId}
              canManage={canManage}
              hostOnline={hostOnline}
              onSelect={() => onSelectChannel(channel.id)}
              onJoinVoice={() => onJoinVoice(channel.id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export interface ChannelListProps {
  community: Community;
  /**
   * Canal aberto na área de conteúdo. Vem de fora, já resolvido, para o
   * destaque da lista nunca discordar do que está aberto — numa comunidade
   * visitada pela primeira vez o canal ainda não foi gravado na store.
   */
  activeChannelId: string | undefined;
  onSelectChannel: (channelId: string) => void;
  onJoinVoice: (channelId: string) => void;
  className?: string;
}

/**
 * Lista de canais do shell (§8, 1.1) — 240px fixos, `surface-sidebar`.
 * Nome da comunidade no topo, categorias colapsáveis (estado lembrado por
 * comunidade) e os canais na ordem de criação (§14).
 */
export function ChannelList({
  community,
  activeChannelId,
  onSelectChannel,
  onJoinVoice,
  className,
}: ChannelListProps) {
  const categories = useCategories(community.id);
  const collapsedIds = useCollapsedCategoryIds(community.id);
  // Um conjunto: a lista é varrida uma vez, não uma vez por categoria.
  const colapsadas = new Set(collapsedIds);
  const toggleCategoryCollapsed = useCommunityStore(
    (state) => state.toggleCategoryCollapsed,
  );
  const toggleMembersPanel = useUiStore((state) => state.toggleMembersPanel);
  const openCommunitySettings = useUiStore(
    (state) => state.openCommunitySettings,
  );
  const openChannelDialog = useUiStore((state) => state.openChannelDialog);
  const canManage = useHasPermission(community.id, "manage_channels");
  // O afinador de §19.1 derruba o host sem tocar no espelho, então a
  // verdade está no `connectionStore`, não em `community` (§12).
  const hostOnline = useHostStatus(community) === "online";

  return (
    <div
      className={cn(
        "flex min-w-0 flex-col bg-surface-sidebar",
        // §16: 240px fixos no Desktop e no Tablet; no Mobile a lista de
        // canais é a tela inteira ao lado do rail.
        "w-full tablet:w-60 tablet:shrink-0",
        className,
      )}
    >
      {/*
        §8 (1.1) e §4 dizem que o nome da comunidade abre o painel de membros;
        §10 (3.1b) diz que ele abre as configurações. Duas seções contra uma:
        o nome segue indo para os membros e as configurações ganham botão
        próprio — o mesmo destino que o menu de contexto do ícone no rail.
      */}
      <header className="flex h-12 shrink-0 items-center border-b border-border-subtle pr-1">
        <button
          type="button"
          onClick={toggleMembersPanel}
          className={cn(
            "flex h-full min-w-0 flex-1 items-center px-4 text-left",
            "transition-colors duration-(--duration-fast) ease-out",
            "hover:bg-surface-primary",
          )}
        >
          <h2 className="truncate text-heading-3 text-text-primary">
            {community.name}
          </h2>
        </button>

        {canManage && (
          <Tooltip
            label={
              hostOnline
                ? "Criar canal"
                : `${community.name} está offline — a estrutura de canais ${OFFLINE_HINT}`
            }
            side="top"
          >
            <button
              type="button"
              disabled={!hostOnline}
              onClick={() => openChannelDialog({ kind: "create-channel" })}
              aria-label={
                hostOnline
                  ? "Criar canal"
                  : `Criar canal — ${community.name} está offline, a estrutura de canais ${OFFLINE_HINT}`
              }
              className={cn(
                "grid size-8 shrink-0 place-items-center rounded-md",
                "text-text-secondary transition-colors duration-(--duration-fast) ease-out",
                "hover:bg-surface-primary hover:text-text-primary",
                "disabled:cursor-not-allowed disabled:text-text-disabled disabled:hover:bg-transparent",
              )}
            >
              <Plus size={20} strokeWidth={2} aria-hidden="true" />
            </button>
          </Tooltip>
        )}

        <button
          type="button"
          onClick={openCommunitySettings}
          aria-label="Configurações da comunidade"
          className={cn(
            "grid size-8 shrink-0 place-items-center rounded-md",
            "text-text-secondary transition-colors duration-(--duration-fast) ease-out",
            "hover:bg-surface-primary hover:text-text-primary",
          )}
        >
          <Settings size={20} strokeWidth={2} aria-hidden="true" />
        </button>
      </header>

      <nav
        aria-label="Canais"
        className="group/list flex-1 overflow-y-auto px-2 py-3"
      >
        {categories.map((category) => (
          <CategorySection
            key={category.id}
            category={category}
            collapsed={colapsadas.has(category.id)}
            activeChannelId={activeChannelId}
            canManage={canManage}
            hostOnline={hostOnline}
            communityName={community.name}
            onToggle={() =>
              toggleCategoryCollapsed(community.id, category.id)
            }
            onSelectChannel={onSelectChannel}
            onJoinVoice={onJoinVoice}
          />
        ))}

        {canManage && hostOnline && (
          <button
            type="button"
            onClick={() => openChannelDialog({ kind: "create-category" })}
            className={cn(
              "mt-2 flex w-full items-center gap-1.5 rounded-md px-2 py-1.5",
              "text-meta text-text-tertiary",
              "transition-colors duration-(--duration-fast) ease-out",
              "hover:bg-surface-primary hover:text-text-secondary",
              // Discreto: só aparece ao passar pela lista (§10, 3.4).
              "tablet:opacity-0 tablet:group-hover/list:opacity-100 tablet:focus-visible:opacity-100",
            )}
          >
            <FolderPlus size={16} strokeWidth={2} aria-hidden="true" />
            Nova categoria
          </button>
        )}
      </nav>
    </div>
  );
}
