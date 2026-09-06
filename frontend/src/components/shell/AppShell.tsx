import { cn } from "../../lib/cn";
import { ShellLeftColumn } from "./ShellLeftColumn";
import { ShellOverlays } from "./ShellOverlays";
import { ShellRightPanel } from "./ShellRightPanel";
import {
  useActiveCommunityFallback,
  usePendingInviteOverlay,
  usePushToTalk,
  useSearchShortcut,
} from "./shellHooks";
import { ChannelView } from "../../features/channel/ChannelView";
import { DmDestino } from "../../features/dm/DmDestino";
import { DmList } from "../../features/dm/DmList";
import {
  useBeforeUnloadWarning,
  useHostedImpact,
} from "../../features/host/hostExit";
import { SearchPanel } from "../../features/search/SearchPanel";
import { EmptyHub } from "../../features/hub/EmptyHub";
import { JoinCommunityOverlay } from "../../features/invites/JoinCommunityOverlay";
import { VoiceCallBar } from "../../features/voice/VoiceCallBar";
import { VoiceOverlay } from "../../features/voice/VoiceOverlay";
import {
  selectChannel,
  selectCommunity,
  selectIsChannelReadOnly,
  useActiveChannel,
  useCommunityStore,
  useLocalMemberId,
} from "../../store/communityStore";
import { useHostStatus } from "../../store/connectionStore";
import { useToastStore } from "../../store/toastStore";
import { useUiStore } from "../../store/uiStore";
import { useVoiceStore } from "../../store/voiceStore";

/**
 * 1.1 Shell principal — chrome persistente que hospeda toda a navegação
 * pós-identidade.
 *
 * Rail (72px) · lista de canais (240px) · área de conteúdo. O painel direito
 * de 280px (membros/thread/busca) entra com 1.2/1.3/2.2. Com 0 comunidades,
 * o conteúdo central é o Hub vazio (0.2), que não é uma tela separada.
 *
 * O que o shell decide aqui é o esqueleto: a coluna da esquerda, a área de
 * conteúdo e a camada de sobreposições são componentes próprios, e os
 * ouvintes globais (atalho de busca, push-to-talk, convite pendente) vivem em
 * `shellHooks`.
 */
export function AppShell() {
  const joinedCommunityIds = useCommunityStore(
    (state) => state.joinedCommunityIds,
  );
  const activeCommunityId = useCommunityStore(
    (state) => state.activeCommunityId,
  );
  const activeCommunity = useCommunityStore((state) =>
    selectCommunity(state, state.activeCommunityId),
  );
  const setActiveChannel = useCommunityStore((state) => state.setActiveChannel);
  const activeChannel = useActiveChannel();

  const destino = useUiStore((state) => state.destino);
  const overlay = useUiStore((state) => state.overlay);
  const joinSource = useUiStore((state) => state.joinSource);
  const mobilePane = useUiStore((state) => state.mobilePane);
  const setMobilePane = useUiStore((state) => state.setMobilePane);
  const searchScope = useUiStore((state) => state.searchScope);

  const activeChannelReadOnly = useCommunityStore((state) =>
    activeChannel ? selectIsChannelReadOnly(state, activeChannel) : false,
  );

  const hostStatus = useHostStatus(activeCommunity);
  const localMemberId = useLocalMemberId(activeCommunityId ?? "");
  const joinVoice = useVoiceStore((state) => state.join);
  const voiceExpanded = useVoiceStore((state) => state.expanded);
  const inVoice = useVoiceStore((state) => state.channelId !== null);
  const voiceChannelId = useVoiceStore((state) => state.channelId);
  const setVoiceExpanded = useVoiceStore((state) => state.setExpanded);
  const showToast = useToastStore((state) => state.showToast);

  // §10, 3.5 — o navegador só permite a confirmação genérica dele; o modal
  // é a decisão de produto, alcançável pelo afinador de §19.1.
  const hostedImpact = useHostedImpact();
  useBeforeUnloadWarning(hostedImpact.length > 0);

  // U-06 — quem ATENDE o pedido de saída do main é o `HostExitListener`, montado na raiz
  // (§92): fechar a janela numa tela anterior a este shell não pode custar os 10 s de
  // prazo do main por falta de quem responda. Aqui fica só a superfície, abaixo.

  usePendingInviteOverlay();
  useActiveCommunityFallback();
  usePushToTalk();
  useSearchShortcut();

  const joiningFromLinkWithoutShell =
    overlay === "join-community" &&
    joinSource === "link" &&
    joinedCommunityIds.length === 0;

  if (joiningFromLinkWithoutShell) {
    return <JoinCommunityOverlay layout="fullscreen" />;
  }

  function handleSelectChannel(channelId: string) {
    if (!activeCommunityId) return;
    setActiveChannel(activeCommunityId, channelId);
    // §16, Mobile: escolher um canal avança para a tela de conteúdo.
    setMobilePane("content");
  }

  /**
   * Entrar em voz **não** troca a área de conteúdo (§4): abre a grade por
   * cima dela e a barra persistente. Clicar no canal em que já se está só
   * traz a grade de volta.
   */
  function handleJoinVoice(channelId: string) {
    if (!activeCommunityId) return;
    if (voiceChannelId === channelId) {
      setVoiceExpanded(true);
      return;
    }
    // §11, B4 (exceções): voz precisa do host de pé — bloqueia com mensagem
    // clara em vez de tentar e falhar em silêncio.
    if (hostStatus !== "online") {
      showToast(
        `Voz precisa que ${activeCommunity?.name ?? "o host"} esteja online`,
        "error",
      );
      return;
    }
    const channel = selectChannel(useCommunityStore.getState(), channelId);
    if (channel) joinVoice(channel, localMemberId);
  }

  // §16, Mobile: a grade expandida é a tela em foco, como o conteúdo.
  const contentPaneVisible = mobilePane === "content" || voiceExpanded;

  return (
    // `relative` ancora o painel direito, que no Tablet flutua sobre o
    // conteúdo em vez de ocupar coluna (§16).
    <div
      className={cn(
        "relative flex h-full",
        // A barra de chamada do Mobile é fixa no rodapé: o shell cede a
        // altura dela para não esconder o composer atrás — só quando ela
        // existe, que é com o conteúdo em foco.
        inVoice && contentPaneVisible && !voiceExpanded && "pb-16 tablet:pb-0",
      )}
    >
      <ShellLeftColumn
        community={destino === "dm" ? undefined : activeCommunity}
        activeChannel={activeChannel}
        contentPaneVisible={contentPaneVisible}
        // U-33 — a lista de conversas ocupa o slot da lista de canais, **dentro** da
        // coluna: é o que faz a barra de usuário atravessá-la (§8, 1.1) e o que impede o
        // rail de herdar a largura da barra quando não há lista nenhuma ao lado.
        lista={
          destino === "dm" ? (
            <DmList className={cn(contentPaneVisible && "hidden tablet:flex")} />
          ) : undefined
        }
        inVoice={inVoice}
        onSelectChannel={handleSelectChannel}
        onJoinVoice={handleJoinVoice}
      />

      {destino === "dm" ? (
        /*
          U-33 — a DM ocupa os dois slots que a comunidade ocuparia: a lista de conversas
          no lugar da lista de canais e a conversa no lugar do conteúdo. O rail continua,
          e a barra de usuário também (ela é do shell, não da comunidade). Nenhum layout
          novo — é a proposta de B63(a), montada com o que o shell já tem.
        */
        <DmDestino />
      ) : activeCommunity ? (
        <>
          {/* A grade de voz (2.3) abre sobre a área de conteúdo, não no lugar
              dela: o canal de texto continua atrás (§4, C11). */}
          <div
            className={cn(
              "relative flex min-w-0 flex-1",
              !contentPaneVisible && "hidden tablet:flex",
            )}
          >
            {activeChannel && (
              <ChannelView
                // Trocar de canal remonta a área de conteúdo: a resposta em
                // preparo (§9, 2.1) é do canal onde foi aberta, e some com ele.
                key={activeChannel.id}
                community={activeCommunity}
                channel={activeChannel}
                onBack={() => setMobilePane("channels")}
                className={cn(
                  mobilePane === "channels" && "hidden tablet:flex",
                )}
              />
            )}

            {voiceExpanded && <VoiceOverlay />}
          </div>

          <ShellRightPanel
            community={activeCommunity}
            activeChannel={activeChannel}
            activeChannelReadOnly={activeChannelReadOnly}
          />
        </>
      ) : (
        <EmptyHub />
      )}

      {searchScope !== null && activeCommunity && destino === "comunidade" && (
        <SearchPanel community={activeCommunity} activeChannel={activeChannel} />
      )}

      <ShellOverlays community={activeCommunity} />

      {/*
        §16: no Mobile a barra de chamada é a única coisa que sobrevive à
        navegação sequencial — fica no rodapé da viewport, acima das três
        telas empilhadas. Com o conteúdo em foco, a coluna da esquerda não
        está na tela e a chamada precisa continuar alcançável. Só aí a barra
        fixa existe: com a lista de canais em foco, quem faz o papel é o
        `VoicePanel` acima da barra de usuário, e as duas juntas empilhavam
        dois microfones a 60px de distância.
      */}
      {inVoice && contentPaneVisible && <VoiceCallBar />}
    </div>
  );
}
