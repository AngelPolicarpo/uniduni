import { useEffect, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import {
  selectChannel,
  useCommunityStore,
} from "../../store/communityStore";
import { usePendingMessageStore } from "../../store/inviteStore";
import { useMessageStore } from "../../store/messageStore";
import { useToastStore } from "../../store/toastStore";
import { useUiStore } from "../../store/uiStore";
import { useSessao } from "../../live/sessao";

/**
 * Resolve um link `/m/:code` depois que o shell está de pé (§4).
 *
 * Os desfechos de falha nunca revelam conteúdo: quem não é membro não fica
 * sabendo o nome do canal nem se a mensagem existe, e quem já saiu da
 * comunidade recebe exatamente a mesma resposta de quem nunca entrou (§18).
 */
export function MessageLinkResolver() {
  const pending = usePendingMessageStore((state) => state.pendingMessage);
  const invalid = usePendingMessageStore(
    (state) => state.pendingMessageInvalid,
  );
  const clearPending = usePendingMessageStore(
    (state) => state.clearPendingMessage,
  );

  const estadoSessao = useSessao((state) => state.estado);
  const joinedCommunityIds = useCommunityStore((state) => state.joinedCommunityIds);
  const setActiveCommunity = useCommunityStore(
    (state) => state.setActiveCommunity,
  );
  const setActiveChannel = useCommunityStore((state) => state.setActiveChannel);
  const highlightMessage = useUiStore((state) => state.highlightMessage);
  const openJoinCommunity = useUiStore((state) => state.openJoinCommunity);
  const showToast = useToastStore((state) => state.showToast);

  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    if (!pending && !invalid) return;

    if (invalid || !pending) {
      setBlocked(true);
      clearPending();
      return;
    }

    // Se o app ainda está na inicialização da sessão, espera a sincronização inicial
    // para não rejeitar prematuramente um link de comunidade válida (§3.5, §15.6).
    const emConexao = estadoSessao === "inicial" || estadoSessao === "conectando";
    const state = useCommunityStore.getState();
    if (!state.joinedCommunityIds.includes(pending.communityId)) {
      if (emConexao) return;
      setBlocked(true);
      clearPending();
      return;
    }

    const channel = selectChannel(state, pending.channelId);
    if (!channel) {
      if (emConexao) return;
      // Canal existe do outro lado, mas não neste dispositivo (premissa 6).
      showToast("Esta mensagem ainda não chegou neste dispositivo");
      setActiveCommunity(pending.communityId);
      clearPending();
      return;
    }

    setActiveCommunity(pending.communityId);
    setActiveChannel(pending.communityId, pending.channelId);

    const messages = useMessageStore.getState();
    const deleted = messages.deletedIds.includes(pending.messageId);
    if (deleted) showToast("Esta mensagem não existe mais");
    else highlightMessage(pending.messageId);

    clearPending();
  }, [
    pending,
    invalid,
    estadoSessao,
    joinedCommunityIds,
    clearPending,
    setActiveCommunity,
    setActiveChannel,
    highlightMessage,
    showToast,
  ]);

  if (!blocked) return null;

  return (
    <Modal
      open
      onClose={() => setBlocked(false)}
      title="Este link não abre aqui"
      size="sm"
    >
      <div className="flex flex-col gap-6">
        <p className="text-body text-text-secondary">
          Este link é de uma comunidade da qual você não faz parte. Sem um
          convite não há como entrar — não existe diretório público de
          comunidades.
        </p>
        <div className="flex flex-col gap-3 tablet:flex-row tablet:justify-end">
          <Button variant="secondary" onClick={() => setBlocked(false)}>
            Fechar
          </Button>
          <Button
            onClick={() => {
              setBlocked(false);
              openJoinCommunity("manual");
            }}
          >
            Colar um convite
          </Button>
        </div>
      </div>
    </Modal>
  );
}
