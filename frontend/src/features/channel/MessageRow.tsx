import { useRef, useState } from "react";
import {
  AlertTriangle,
  Clock,
  CornerUpLeft,
  MessagesSquare,
  Pin,
} from "lucide-react";
import { cn } from "../../lib/cn";
import { Avatar } from "../../components/ui/Avatar";
import { AttachmentCard } from "./AttachmentCard";
import { MessageActions } from "./MessageActions";
import { MessageContent } from "./MessageContent";
import { MessageEditor } from "./MessageEditor";
import { ReactionBar } from "./ReactionBar";
import {
  formatClock,
  formatFullTimestamp,
  formatMessageTimestamp,
} from "../../lib/format";
import { ROLE_TEXT_CLASS } from "../../lib/role";
import { selectCommunity, selectHighestRole, useCommunityStore, useFindMember, useHasPermission, useLocalMemberId } from "../../store/communityStore";
import { useIdentityStore } from "../../store/identityStore";
import { anexosDaMensagem, useMessageStore, useAnexoRemoto } from "../../store/messageStore";
import { useUiStore } from "../../store/uiStore";
import { ProfilePopover } from "../members/ProfilePopover";
import type { Message } from "../../domain/types";

/** §9, 2.1 responsividade — no toque a barra de ações vem por long-press. */
const LONG_PRESS_MS = 500;

/** Nome de autor colorido pelo cargo mais alto do membro (§5.4, §9 2.1.1). */
function useAuthorLabel(communityId: string, identityId: string) {
  const findMember = useFindMember();
  const identity = useIdentityStore((state) => state.identity);
  const member = findMember(communityId, identityId);
  const highestRole = useCommunityStore((state) =>
    member ? selectHighestRole(state, member.roleIds) : undefined,
  );

  const isLocal = !member && identity?.id === identityId;

  return {
    name:
      member?.nickname ??
      member?.displayName ??
      (isLocal ? identity.displayName : "Membro desconhecido"),
    avatarColor:
      member?.avatarColor ?? (isLocal ? identity.avatarColor : "role-neutral"),
    nameClass: highestRole
      ? ROLE_TEXT_CLASS[highestRole.color]
      : "text-text-primary",
  };
}

/**
 * §6 — estados de entrega da linha de mensagem. "Enviando" é só opacidade
 * reduzida; fila offline e falha ganham uma linha explicando o que houve,
 * porque nenhum ícone sozinho diz "sua mensagem ainda não saiu daqui".
 */
function DeliveryStatus({
  message,
  communityId,
}: {
  message: Message;
  communityId: string;
}) {
  const retrySend = useMessageStore((state) => state.retrySend);
  // O motivo nomeado de §11.3/§20 — recusa do fold ou descarte, não "erro".
  const erro = useMessageStore((state) => state.errosPorRef[message.id]);
  const communityName = useCommunityStore(
    (state) => selectCommunity(state, communityId)?.name ?? "o host",
  );

  if (message.deliveryState === "queued") {
    return (
      <p className="mt-0.5 flex items-center gap-1 text-meta text-text-tertiary">
        <Clock size={12} strokeWidth={2} aria-hidden="true" />
        Pendente — será enviada quando {communityName} voltar
      </p>
    );
  }

  if (message.deliveryState === "failed") {
    return (
      <p className="mt-0.5 flex items-center gap-1 text-meta text-feedback-danger">
        <AlertTriangle size={12} strokeWidth={2} aria-hidden="true" />
        Não foi possível enviar
        {erro !== undefined && (
          <span className="text-text-tertiary">({erro})</span>
        )}
        <button
          type="button"
          onClick={() => retrySend(message.id)}
          className="ml-1 underline underline-offset-2 hover:text-text-primary"
        >
          Tentar novamente
        </button>
      </p>
    );
  }

  return null;
}

function ReplyPreview({
  communityId,
  repliedTo,
}: {
  communityId: string;
  repliedTo: Message;
}) {
  const author = useAuthorLabel(communityId, repliedTo.authorId);

  return (
    <p className="mb-0.5 flex min-w-0 items-center gap-1 text-meta text-text-secondary">
      <CornerUpLeft
        size={12}
        strokeWidth={2}
        aria-hidden="true"
        className="shrink-0 text-text-tertiary"
      />
      <span className="shrink-0">respondendo a</span>
      <span className={cn("shrink-0 font-semibold", author.nameClass)}>
        {author.name}
      </span>
      <span className="truncate text-text-tertiary">{repliedTo.content}</span>
    </p>
  );
}

export interface MessageRowProps {
  message: Message;
  communityId: string;
  /** Primeira mensagem do bloco — só ela repete avatar, nome e carimbo (§9, 2.1). */
  groupStart: boolean;
  /** Mensagem respondida, quando esta é uma resposta inline. */
  repliedTo?: Message;
  /** Canal somente-leitura desliga responder, reagir e editar. */
  readOnly: boolean;
  onReply: (message: Message) => void;
  /** Respostas da thread ancorada nesta mensagem, se houver (§9, 2.2). */
  threadReplies?: number;
  /**
   * Não-lidas da thread (§9, 2.2, emenda de §15.6) — o que `query.thread.unread`
   * responde para a raiz. Presente só quando acima de zero; abre o painel limpa.
   */
  threadUnread?: number;
  /**
   * Dentro do painel de thread (§9, 2.2) a linha é só leitura da
   * sub-conversa: sem toolbar e sem indicador de thread, que abririam uma
   * thread de dentro da própria thread.
   */
  hideActions?: boolean;
}

/**
 * Linha de mensagem (§6).
 *
 * Mensagens consecutivas do mesmo autor dentro de 5 min não repetem avatar
 * nem nome; a hora aparece na medianiz no hover. Fixada ganha o rótulo
 * "Fixado" e uma superfície um degrau acima (§5.1 — hierarquia por
 * luminância). A barra de ações aparece no hover (Desktop), no botão direito
 * ou por long-press (toque, §9 2.1).
 */
export function MessageRow({
  message,
  communityId,
  groupStart,
  repliedTo,
  readOnly,
  onReply,
  threadReplies = 0,
  threadUnread,
  hideActions = false,
}: MessageRowProps) {
  const author = useAuthorLabel(communityId, message.authorId);
  const localMemberId = useLocalMemberId(communityId);
  const anexoRemoto = useAnexoRemoto(message.id);
  const timestamp = new Date(message.timestamp);
  const openThreadPanel = useUiStore((state) => state.openThreadPanel);
  // §9, 2.1 — destaque breve ao chegar por busca ou link.
  const highlighted = useUiStore(
    (state) => state.highlightedMessageId === message.id,
  );

  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [profileAnchor, setProfileAnchor] = useState<DOMRect | null>(null);
  const longPress = useRef<number | undefined>(undefined);

  const toggleReaction = useMessageStore((state) => state.toggleReaction);
  const editMessage = useMessageStore((state) => state.editMessage);
  const canReact = useHasPermission(communityId, "add_reactions") && !readOnly;

  function cancelLongPress() {
    window.clearTimeout(longPress.current);
  }

  return (
    <article
      id={`msg-${message.id}`}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenuOpen(true);
      }}
      onPointerDown={(event) => {
        if (event.pointerType !== "touch") return;
        longPress.current = window.setTimeout(
          () => setMenuOpen(true),
          LONG_PRESS_MS,
        );
      }}
      onPointerUp={cancelLongPress}
      onPointerCancel={cancelLongPress}
      onPointerLeave={cancelLongPress}
      className={cn(
        "group relative flex gap-3 px-4 py-0.5",
        "transition-colors duration-(--duration-fast) ease-out",
        groupStart && "mt-4 first:mt-0",
        highlighted
          ? "bg-accent-muted-bg"
          : message.pinned
            ? "bg-surface-elevated/40"
            : "hover:bg-surface-elevated/30",
        // Enviando: opacidade reduzida até a confirmação (§6, §11 C9).
        message.deliveryState === "sending" && "opacity-60",
      )}
    >
      {!editing && !hideActions && (
        <MessageActions
          message={message}
          communityId={communityId}
          localMemberId={localMemberId}
          readOnly={readOnly}
          menuOpen={menuOpen}
          onMenuOpenChange={setMenuOpen}
          onReply={() => onReply(message)}
          onStartEdit={() => setEditing(true)}
        />
      )}

      <div className="w-8 shrink-0">
        {groupStart ? (
          <button
            type="button"
            onClick={(event) =>
              setProfileAnchor(event.currentTarget.getBoundingClientRect())
            }
            className="mt-0.5 rounded-full"
          >
            <Avatar name={author.name} color={author.avatarColor} size="md" />
            <span className="sr-only">Ver perfil de {author.name}</span>
          </button>
        ) : (
          <span
            className="hidden text-caption tabular-nums text-text-tertiary group-hover:block"
            title={formatFullTimestamp(timestamp)}
          >
            {formatClock(timestamp)}
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        {message.pinned && (
          <p className="flex items-center gap-1 text-caption text-text-tertiary">
            <Pin size={12} strokeWidth={2} aria-hidden="true" />
            Fixado
          </p>
        )}

        {repliedTo && (
          <ReplyPreview communityId={communityId} repliedTo={repliedTo} />
        )}

        {groupStart && (
          <p className="flex items-baseline gap-2">
            <button
              type="button"
              onClick={(event) =>
                setProfileAnchor(event.currentTarget.getBoundingClientRect())
              }
              className={cn(
                "text-body-emphasis hover:underline",
                author.nameClass,
              )}
            >
              {author.name}
            </button>
            <span
              className="text-meta text-text-tertiary"
              title={formatFullTimestamp(timestamp)}
            >
              {formatMessageTimestamp(timestamp)}
            </span>
          </p>
        )}

        {editing ? (
          <MessageEditor
            message={message}
            onCancel={() => setEditing(false)}
            onSave={(content) => {
              editMessage(message, content);
              setEditing(false);
            }}
          />
        ) : (
          <MessageContent message={message} communityId={communityId} />
        )}

        {anexosDaMensagem(message, anexoRemoto).map((attachment) => (
          <AttachmentCard
            key={attachment.id}
            attachment={attachment}
            uploading={message.deliveryState === "sending"}
          />
        ))}

        <ReactionBar
          message={message}
          communityId={communityId}
          localMemberId={localMemberId}
          canReact={canReact}
          onToggle={(emoji) => toggleReaction(message, emoji, localMemberId)}
        />

        {/* Indicador de thread sob a raiz, no canal principal (§9, 2.2). */}
        {!hideActions && threadReplies > 0 && (
          <button
            type="button"
            onClick={() => openThreadPanel(message.id)}
            className={cn(
              "mt-1 flex items-center gap-1.5 rounded-md px-1.5 py-0.5",
              "text-meta text-accent-default",
              "transition-colors duration-(--duration-fast) ease-out",
              "hover:bg-accent-muted-bg",
            )}
          >
            <MessagesSquare size={14} strokeWidth={2} aria-hidden="true" />
            {threadReplies} {threadReplies === 1 ? "resposta" : "respostas"}
            {threadUnread !== undefined && (
              <span
                className={cn(
                  "ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1",
                  "bg-feedback-danger text-[10px] font-medium text-text-on-accent",
                )}
              >
                {threadUnread}
                <span className="sr-only">não lidas nesta thread</span>
              </span>
            )}
          </button>
        )}

        <DeliveryStatus message={message} communityId={communityId} />
      </div>

      {profileAnchor && (
        <ProfilePopover
          communityId={communityId}
          identityId={message.authorId}
          anchor={profileAnchor}
          onClose={() => setProfileAnchor(null)}
        />
      )}
    </article>
  );
}
