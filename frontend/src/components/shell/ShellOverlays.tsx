import { ChannelDialogs } from "../../features/channels/ChannelDialogs";
import { CreateCommunityModal } from "../../features/communities/CreateCommunityModal";
import { JoinCommunityOverlay } from "../../features/invites/JoinCommunityOverlay";
import { MessageLinkResolver } from "../../features/channel/MessageLinkResolver";
import { AccountSettings } from "../../features/settings/AccountSettings";
import { CommunitySettings } from "../../features/settings/CommunitySettings";
import { RelayConsentModal } from "../../features/voice/RelayConsentModal";
import { useUiStore } from "../../store/uiStore";
import type { Community } from "../../domain/types";

export interface ShellOverlaysProps {
  community: Community | undefined;
}

/**
 * Camada de sobreposição do shell: modais de comunidade, configurações e
 * diálogos de canal. Todos vivem acima da árvore de conteúdo e são decididos
 * pelo `overlay` do `uiStore`.
 *
 * **O aviso de saída do host saiu daqui (U-06).** Ele não é overlay do shell: chega antes
 * do shell existir, e disputava o slot único de `overlay` com o que já estava aberto —
 * abrir o aviso apagava a criação de comunidade ou o editor de cargos, e cancelar o
 * fechamento não os trazia de volta. Além disso, o shell decidia renderizá-lo a partir da
 * SUA cópia do impacto, que podia estar vazia enquanto a cópia do ouvinte não estava: o
 * main recebia "vou perguntar" e nada aparecia até o prazo de 10 s vencer. Agora quem
 * responde ao main é quem desenha, no `HostExitListener` da raiz.
 */
export function ShellOverlays({ community }: ShellOverlaysProps) {
  const overlay = useUiStore((state) => state.overlay);
  const closeOverlay = useUiStore((state) => state.closeOverlay);

  return (
    <>
      {overlay === "create-community" && <CreateCommunityModal />}
      {overlay === "join-community" && <JoinCommunityOverlay layout="modal" />}
      {overlay === "account-settings" && (
        <AccountSettings onClose={closeOverlay} />
      )}
      {overlay === "community-settings" && community && (
        <CommunitySettings community={community} onClose={closeOverlay} />
      )}

      {/* §10, 3.4 — gestão de canais e categorias, disparada da lista. */}
      {community && <ChannelDialogs community={community} />}

      {/* §4 — resolve um `/m/:code` assim que o shell existe. */}
      <MessageLinkResolver />

      <RelayConsentModal />
    </>
  );
}
