import type { ReactNode } from "react";
import { Bell, BellOff, Check, Link2, Pencil, Trash2 } from "lucide-react";
import { Menu } from "../ui/Menu";
import type { MenuItem } from "../ui/Menu";
import { INVITE_LINK_HOST } from "../../mocks/dataset";
import { copiarTexto } from "../../lib/copiar";
import {
  useChannelCount,
  useCommunityStore,
} from "../../store/communityStore";
import { useToastStore } from "../../store/toastStore";
import { useUiStore } from "../../store/uiStore";
import type { Channel } from "../../domain/types";

const ICON = 16;

export interface ChannelContextMenuProps {
  channel: Channel;
  /** §10, 3.4 — os itens de gestão só existem com `gerenciar canais`. */
  canManage: boolean;
  /** Estrutura de canal só muda com o host conectado (§10, 3.4). */
  hostOnline: boolean;
  open: boolean;
  onClose: () => void;
  anchor?: ReactNode;
}

/**
 * §8, 1.1.1 — menu de contexto do canal.
 *
 * Silenciar e marcar como lido são de **todo membro**: são preferências de
 * quem lê, não propriedade da comunidade. Os itens de gestão (§10, 3.4) se
 * somam depois do divisor, e só para quem tem permissão — nunca aparecem
 * desabilitados (§15).
 */
export function ChannelContextMenu({
  channel,
  canManage,
  hostOnline,
  open,
  onClose,
}: ChannelContextMenuProps) {
  const toggleChannelMuted = useCommunityStore(
    (state) => state.toggleChannelMuted,
  );
  const markChannelRead = useCommunityStore((state) => state.markChannelRead);
  const openChannelDialog = useUiStore((state) => state.openChannelDialog);
  const showToast = useToastStore((state) => state.showToast);
  const channelCount = useChannelCount(channel.communityId);

  const isText = channel.type === "text";
  const hasUnread = channel.unreadCount > 0 || channel.pendingMentions > 0;

  const items: MenuItem[] = [];

  // Canal de voz não tem histórico para marcar como lido.
  if (isText && hasUnread)
    items.push({
      id: "read",
      label: "Marcar como lido",
      icon: <Check size={ICON} strokeWidth={2} />,
      onSelect: () => markChannelRead(channel.id),
    });

  items.push({
    id: "mute",
    label: channel.muted ? "Reativar notificações" : "Silenciar canal",
    description: channel.muted
      ? undefined
      : "Menções diretas continuam avisando",
    icon: channel.muted ? (
      <Bell size={ICON} strokeWidth={2} />
    ) : (
      <BellOff size={ICON} strokeWidth={2} />
    ),
    onSelect: () => toggleChannelMuted(channel.id),
  });

  if (isText)
    items.push({
      id: "copy-link",
      label: "Copiar link do canal",
      icon: <Link2 size={ICON} strokeWidth={2} />,
      onSelect: () => {
        void copiarTexto(`${INVITE_LINK_HOST}/m/${channel.id}`).then((ok) =>
          showToast(ok ? "Link copiado" : "Não foi possível copiar o link", ok ? "success" : "error"),
        );
      },
    });

  if (canManage && hostOnline) {
    items.push({
      id: "edit",
      label: "Editar canal",
      icon: <Pencil size={ICON} strokeWidth={2} />,
      onSelect: () =>
        openChannelDialog({ kind: "edit-channel", channelId: channel.id }),
    });

    // Regra do último canal: a comunidade nunca fica sem nenhum (§7, 0.4).
    if (channelCount > 1)
      items.push({
        id: "delete",
        label: "Excluir canal",
        icon: <Trash2 size={ICON} strokeWidth={2} />,
        danger: true,
        onSelect: () =>
          openChannelDialog({ kind: "delete-channel", channelId: channel.id }),
      });
  }

  return <Menu open={open} onClose={onClose} items={items} side="bottom" />;
}
