import { useEffect, useState } from "react";
import {
  Ban,
  Link2,
  MessagesSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Reply,
  SmilePlus,
  Trash2,
} from "lucide-react";
import { cn } from "../../lib/cn";
import { Button } from "../../components/ui/Button";
import { Menu } from "../../components/ui/Menu";
import type { MenuItem } from "../../components/ui/Menu";
import { Modal } from "../../components/ui/Modal";
import { EmojiPicker } from "./EmojiPicker";
import { ModerationDialog } from "../moderation/ModerationDialog";
import { INVITE_LINK_HOST } from "../../mocks/dataset";
import { selectCanModerate, useCommunityStore, useFindMember, useHasPermission } from "../../store/communityStore";
import { useMessageStore, useThreadForRoot } from "../../store/messageStore";
import { useToastStore } from "../../store/toastStore";
import { useUiStore } from "../../store/uiStore";
import { encodeMessageRef } from "../../lib/messageLink";
import { copiarTexto } from "../../lib/copiar";
import type { Message } from "../../domain/types";

const ICON = 16;

export interface MessageActionsProps {
  message: Message;
  communityId: string;
  /** Id da identidade local dentro desta comunidade. */
  localMemberId: string;
  /** Canal somente-leitura desliga responder e reagir. */
  readOnly: boolean;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  onReply: () => void;
  onStartEdit: () => void;
}

/**
 * Barra de ações da mensagem (§6, §9 2.1) e seu menu "⋯" (§15).
 *
 * Aparece no hover sem deslocar o texto (§17) e continua visível enquanto o
 * menu ou o seletor de emoji estiverem abertos — senão o próprio movimento
 * do mouse até o menu o fecharia. Item que a permissão não autoriza não é
 * passado ao menu: nunca aparece desabilitado (§15).
 *
 * "Responder em thread" entra junto com o painel de thread (2.2) — abrir um
 * destino que não existe seria pior que não oferecer a ação.
 */
export function MessageActions({
  message,
  communityId,
  localMemberId,
  readOnly,
  menuOpen,
  onMenuOpenChange,
  onReply,
  onStartEdit,
}: MessageActionsProps) {
  const findMember = useFindMember();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const toggleReaction = useMessageStore((state) => state.toggleReaction);
  const setPinned = useMessageStore((state) => state.setPinned);
  const deleteMessage = useMessageStore((state) => state.deleteMessage);
  const createThread = useMessageStore((state) => state.createThread);
  // §15.6.1 — reações não viajam na lista; a barra hidrata por demanda.
  const hidratarReacoes = useMessageStore((state) => state.hidratarReacoes);
  const showToast = useToastStore((state) => state.showToast);
  const openThreadPanel = useUiStore((state) => state.openThreadPanel);
  const thread = useThreadForRoot(message.id);

  useEffect(() => {
    hidratarReacoes(message.channelId, message.id);
  }, [hidratarReacoes, message.channelId, message.id]);

  const canReact = useHasPermission(communityId, "add_reactions") && !readOnly;
  const canSend = useHasPermission(communityId, "send_messages") && !readOnly;
  const canPin = useHasPermission(communityId, "pin_messages");
  const canManage = useHasPermission(communityId, "manage_messages");
  // §11, D12: banir do próprio menu da mensagem, com permissão e hierarquia.
  const canBan = useHasPermission(communityId, "ban_members");
  const canModerateAuthor = useCommunityStore((state) =>
    selectCanModerate(state, communityId, message.authorId),
  );
  const [banning, setBanning] = useState(false);

  const isOwn = message.authorId === localMemberId;
  const authorName =
    findMember(communityId, message.authorId)?.displayName ?? "este membro";

  async function handleCopyLink() {
    // §4 — o code empacota comunidade+canal+mensagem, para o link não
    // anunciar a estrutura da comunidade a quem não é membro.
    const link = `${INVITE_LINK_HOST}/m/${encodeMessageRef({
      communityId,
      channelId: message.channelId,
      messageId: message.id,
    })}`;
    if (await copiarTexto(link)) showToast("Link copiado");
    else showToast("Não foi possível copiar o link", "error");
  }

  const items: MenuItem[] = [];
  if (canReact) {
    items.push({
      id: "react",
      label: "Adicionar reação",
      icon: <SmilePlus size={ICON} strokeWidth={2} />,
      onSelect: () => setPickerOpen(true),
    });
  }
  if (canSend) {
    items.push({
      id: "reply",
      label: "Responder",
      icon: <Reply size={ICON} strokeWidth={2} />,
      onSelect: onReply,
    });
    items.push({
      id: "thread",
      label: thread ? "Ver thread" : "Responder em thread",
      icon: <MessagesSquare size={ICON} strokeWidth={2} />,
      onSelect: () => {
        // Mensagem sem thread ganha uma na hora; com thread, só abre.
        if (!thread) createThread(message);
        openThreadPanel(message.id);
      },
    });
  }
  if (canPin) {
    items.push({
      id: "pin",
      label: message.pinned ? "Desafixar mensagem" : "Fixar mensagem",
      icon: message.pinned ? (
        <PinOff size={ICON} strokeWidth={2} />
      ) : (
        <Pin size={ICON} strokeWidth={2} />
      ),
      onSelect: () => setPinned(message, !message.pinned),
    });
  }
  items.push({
    id: "copy",
    label: "Copiar link da mensagem",
    icon: <Link2 size={ICON} strokeWidth={2} />,
    onSelect: () => void handleCopyLink(),
  });
  if (isOwn && canSend) {
    items.push({
      id: "edit",
      label: "Editar mensagem",
      icon: <Pencil size={ICON} strokeWidth={2} />,
      onSelect: onStartEdit,
    });
  }
  if (!isOwn && canBan && canModerateAuthor) {
    items.push({
      id: "ban",
      label: `Banir ${authorName}`,
      icon: <Ban size={ICON} strokeWidth={2} />,
      danger: true,
      onSelect: () => setBanning(true),
    });
  }
  if (isOwn || canManage) {
    items.push({
      id: "delete",
      label: "Deletar mensagem",
      icon: <Trash2 size={ICON} strokeWidth={2} />,
      danger: true,
      // A própria mensagem some sem confirmação (§15: destrutivo reversível
      // dentro da sessão); a de outro autor passa por modal.
      onSelect: () =>
        isOwn ? deleteMessage(message) : setConfirmingDelete(true),
    });
  }

  const forcedOpen = menuOpen || pickerOpen;

  return (
    <>
      <div
        className={cn(
          "absolute -top-3 right-4 z-20 flex items-center gap-0.5",
          "rounded-md border border-border-default bg-surface-elevated p-0.5 shadow-elevated",
          "transition-opacity duration-(--duration-fast) ease-out",
          forcedOpen
            ? "opacity-100"
            : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100",
        )}
      >
        {canReact && (
          <button
            type="button"
            onClick={() => setPickerOpen((open) => !open)}
            className="grid size-7 place-items-center rounded-sm text-text-secondary hover:bg-surface-primary hover:text-text-primary"
          >
            <SmilePlus size={ICON} strokeWidth={2} aria-hidden="true" />
            <span className="sr-only">Reagir</span>
          </button>
        )}

        {canSend && (
          <button
            type="button"
            onClick={onReply}
            className="grid size-7 place-items-center rounded-sm text-text-secondary hover:bg-surface-primary hover:text-text-primary"
          >
            <Reply size={ICON} strokeWidth={2} aria-hidden="true" />
            <span className="sr-only">Responder</span>
          </button>
        )}

        <div className="relative">
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => onMenuOpenChange(!menuOpen)}
            className="grid size-7 place-items-center rounded-sm text-text-secondary hover:bg-surface-primary hover:text-text-primary"
          >
            <MoreHorizontal size={ICON} strokeWidth={2} aria-hidden="true" />
            <span className="sr-only">Mais opções</span>
          </button>

          <Menu
            open={menuOpen}
            onClose={() => onMenuOpenChange(false)}
            items={items}
            side="bottom-end"
          />
        </div>

        {pickerOpen && (
          <EmojiPicker
            onPick={(emoji) => toggleReaction(message, emoji, localMemberId)}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </div>

      {/* Montado só quando pedido: um `<dialog>` oculto por linha de mensagem
          encheria o DOM e a árvore de acessibilidade de confirmações que
          ninguém pediu. */}
      {confirmingDelete && (
      <Modal
        open
        onClose={() => setConfirmingDelete(false)}
        title="Deletar mensagem"
        size="sm"
      >
        <p className="text-body text-text-secondary">
          A mensagem de {authorName} será removida para todo mundo. Não pode
          ser desfeito.
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirmingDelete(false)}>
            Cancelar
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              deleteMessage(message);
              setConfirmingDelete(false);
            }}
          >
            Deletar mensagem
          </Button>
        </div>
      </Modal>
      )}

      {/* §11, D12 passo 3: banir remove as mensagens do canal junto. */}
      {banning && (
        <ModerationDialog
          kind="ban"
          communityId={communityId}
          targetId={message.authorId}
          targetLabel={authorName}
          byId={localMemberId}
          onClose={() => setBanning(false)}
        />
      )}
    </>
  );
}
