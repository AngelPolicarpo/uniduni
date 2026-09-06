import { useState } from "react";
import { SmilePlus } from "lucide-react";
import { cn } from "../../lib/cn";
import { Tooltip } from "../../components/ui/Tooltip";
import { EmojiPicker } from "./EmojiPicker";
import { useCommunityStore, selectMemberLabel } from "../../store/communityStore";
import { useMessageStore, useReatores } from "../../store/messageStore";
import { useShallow } from "zustand/react/shallow";
import type { Message, Reaction } from "../../domain/types";

/** Quantos nomes o tooltip lista antes de agregar o resto (§9, 2.1). */
const NAMES_SHOWN = 6;

interface ReactionChipProps {
  reaction: Reaction;
  messageId: string;
  channelId: string;
  communityId: string;
  mine: boolean;
  canReact: boolean;
  onToggle: () => void;
}

/**
 * Chip de uma reação. O tooltip diz QUEM reagiu — e quem reagiu é resposta de
 * `query.reactors` (§15.6, DR-47), pedida quando o ponteiro chega ao chip.
 *
 * `Reaction.userIds` não serve: §15.6.1 põe no fio só `{emoji, count, mine}`, e o
 * adaptador preenche a lista no máximo com a própria chave. O tooltip que lia
 * essa lista anunciava " reagiu com 👍" — sem nome nenhum — sempre que a reação
 * era de outra pessoa.
 */
function ReactionChip({
  reaction,
  messageId,
  channelId,
  communityId,
  mine,
  canReact,
  onToggle,
}: ReactionChipProps) {
  const hidratarReatores = useMessageStore((state) => state.hidratarReatores);
  const reatores = useReatores(messageId, reaction.emoji);
  const names = useCommunityStore(
    useShallow((state) =>
      (reatores?.identityIds ?? []).map((id) => selectMemberLabel(state, communityId, id)),
    ),
  );

  const shown = names.slice(0, NAMES_SHOWN).join(", ");
  const restantes = (reatores?.total ?? 0) - Math.min(names.length, NAMES_SHOWN);
  const who = restantes > 0 ? `${shown} e mais ${restantes}` : shown;
  // Enquanto a consulta não voltou, o tooltip diz o que se sabe: a contagem.
  const rotulo =
    reatores === undefined || names.length === 0
      ? `${reaction.count} ${reaction.count === 1 ? "pessoa reagiu" : "pessoas reagiram"} com ${reaction.emoji}`
      : `${who} reagiu com ${reaction.emoji}`;

  return (
    <Tooltip label={rotulo} side="top">
      <button
        type="button"
        disabled={!canReact}
        onPointerEnter={() => hidratarReatores(channelId, messageId, reaction.emoji)}
        onFocus={() => hidratarReatores(channelId, messageId, reaction.emoji)}
        onClick={onToggle}
        aria-pressed={mine}
        className={cn(
          "flex h-6 items-center gap-1 rounded-full border px-2",
          "text-meta tabular-nums",
          "transition-colors duration-(--duration-fast) ease-out",
          mine
            ? "border-accent-default bg-accent-muted-bg text-accent-default"
            : "border-border-default bg-surface-elevated text-text-secondary",
          canReact && !mine && "hover:border-border-strong",
        )}
      >
        <span key={reaction.count} className="animate-reaction-pop">
          {reaction.emoji}
        </span>
        {reaction.count}
        <span className="sr-only">{`— ${rotulo}`}</span>
      </button>
    </Tooltip>
  );
}

export interface ReactionBarProps {
  message: Message;
  /** Resolve o apelido de quem reagiu, que é por comunidade (§8, 1.4). */
  communityId: string;
  /** Id da identidade local dentro desta comunidade. */
  localMemberId: string;
  canReact: boolean;
  onToggle: (emoji: string) => void;
}

/**
 * Reações da mensagem (§6, §9 2.1) — chip com emoji e contagem, destacado
 * quando a identidade local reagiu. Clicar alterna. O emoji "salta" ao ser
 * adicionado (§17); chip que zera some junto com a última reação (§18).
 */
export function ReactionBar({
  message,
  communityId,
  localMemberId,
  canReact,
  onToggle,
}: ReactionBarProps) {
  const [pickerOpen, setPickerOpen] = useState(false);

  if (message.reactions.length === 0 && !pickerOpen) return null;

  return (
    <div className="relative mt-1 flex flex-wrap items-center gap-1">
      {message.reactions.map((reaction) => (
        <ReactionChip
          key={reaction.emoji}
          reaction={reaction}
          messageId={message.id}
          channelId={message.channelId}
          communityId={communityId}
          mine={reaction.userIds.includes(localMemberId)}
          canReact={canReact}
          onToggle={() => onToggle(reaction.emoji)}
        />
      ))}

      {canReact && (
        <>
          <button
            type="button"
            onClick={() => setPickerOpen((open) => !open)}
            className={cn(
              "grid size-6 place-items-center rounded-full border border-border-default",
              "bg-surface-elevated text-text-secondary",
              "transition-colors duration-(--duration-fast) ease-out",
              "hover:border-border-strong hover:text-text-primary",
            )}
          >
            <SmilePlus size={14} strokeWidth={2} aria-hidden="true" />
            <span className="sr-only">Adicionar reação</span>
          </button>

          {pickerOpen && (
            <EmojiPicker
              align="start"
              onPick={onToggle}
              onClose={() => setPickerOpen(false)}
            />
          )}
        </>
      )}
    </div>
  );
}
