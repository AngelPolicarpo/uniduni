import { Bell, BellOff, ChevronLeft, Hash, MessagesSquare, Pin, Search, Users, Volume2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "../../lib/cn";
import { Tooltip } from "../../components/ui/Tooltip";
import { useUiStore } from "../../store/uiStore";
import { useCommunityStore } from "../../store/communityStore";
import type { Channel } from "../../domain/types";

/**
 * Ícone de ação do cabeçalho (§9, 2.1). Os quatro destinos — thread (2.2),
 * fixados, busca (1.2) e membros (1.3) — são painéis que ainda não existem,
 * então o controle fica visível e inativo (`aria-disabled`), nunca some: a
 * regra de esconder-em-vez-de-desabilitar de §15 vale para permissão de
 * moderação, não para navegação.
 */
function HeaderAction({
  label,
  icon: Icon,
  onSelect,
  active = false,
}: {
  label: string;
  icon: LucideIcon;
  onSelect?: () => void;
  active?: boolean;
}) {
  return (
    <Tooltip label={label} side="top">
      <button
        type="button"
        onClick={onSelect}
        aria-disabled={onSelect ? undefined : "true"}
        aria-pressed={onSelect ? active : undefined}
        className={cn(
          "grid size-9 place-items-center rounded-md",
          "transition-colors duration-(--duration-fast) ease-out",
          onSelect
            ? active
              ? "bg-accent-muted-bg text-accent-default"
              : "text-text-secondary hover:bg-surface-elevated hover:text-text-primary"
            : "cursor-default text-text-disabled",
        )}
      >
        <Icon size={20} strokeWidth={2} aria-hidden="true" />
        <span className="sr-only">{label}</span>
      </button>
    </Tooltip>
  );
}

export interface ChannelHeaderProps {
  channel: Channel;
  /** §16, Mobile: volta para a lista de canais. */
  onBack: () => void;
}

/** Cabeçalho do canal (§9, 2.1) — nome, tópico e ícones de ação. */
export function ChannelHeader({ channel, onBack }: ChannelHeaderProps) {
  const ChannelIcon = channel.type === "voice" ? Volume2 : Hash;
  const rightPanel = useUiStore((state) => state.rightPanel);
  const toggleMembersPanel = useUiStore((state) => state.toggleMembersPanel);
  const toggleChannelInfoPanel = useUiStore(
    (state) => state.toggleChannelInfoPanel,
  );
  const toggleChannelMuted = useCommunityStore(
    (state) => state.toggleChannelMuted,
  );
  const openSearch = useUiStore((state) => state.openSearch);

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border-subtle px-4">
      <button
        type="button"
        onClick={onBack}
        className={cn(
          "-ml-2 grid size-9 shrink-0 place-items-center rounded-md",
          "text-text-secondary hover:bg-surface-elevated hover:text-text-primary",
          "transition-colors duration-(--duration-fast) ease-out",
          "tablet:hidden",
        )}
      >
        <ChevronLeft size={20} strokeWidth={2} aria-hidden="true" />
        <span className="sr-only">Voltar para a lista de canais</span>
      </button>

      <ChannelIcon
        size={20}
        strokeWidth={2}
        aria-hidden="true"
        className="shrink-0 text-text-tertiary"
      />
      <h1 className="shrink-0 truncate text-heading-3 text-text-primary">
        {channel.name}
      </h1>

      {channel.topic && (
        <>
          <span
            className="hidden h-4 w-px shrink-0 bg-border-default tablet:block"
            aria-hidden="true"
          />
          <p className="hidden min-w-0 truncate text-meta text-text-secondary tablet:block">
            {channel.topic}
          </p>
        </>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <HeaderAction
          label={channel.muted ? "Reativar notificações" : "Silenciar canal"}
          icon={channel.muted ? BellOff : Bell}
          onSelect={() => toggleChannelMuted(channel.id)}
          active={channel.muted}
        />
        <HeaderAction label="Threads" icon={MessagesSquare} />
        {/* §9, 2.1.2 — o alfinete abre o acervo do canal, no slot direito. */}
        <HeaderAction
          label="Fixados, arquivos e links"
          icon={Pin}
          onSelect={toggleChannelInfoPanel}
          active={rightPanel?.kind === "channel-info"}
        />
        {/* Lupa do canal abre a busca já escopada nele (§8, 1.2). */}
        <HeaderAction
          label="Buscar"
          icon={Search}
          onSelect={() => openSearch("channel")}
        />
        <HeaderAction
          label="Membros"
          icon={Users}
          onSelect={toggleMembersPanel}
          active={rightPanel?.kind === "members"}
        />
      </div>
    </header>
  );
}
