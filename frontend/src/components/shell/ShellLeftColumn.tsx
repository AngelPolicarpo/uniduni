import type { ReactNode } from "react";

import { cn } from "../../lib/cn";
import { ChannelList } from "./ChannelList";
import { CommunityRail } from "./CommunityRail";
import { UserBar } from "./UserBar";
import { VoicePanel } from "../../features/voice/VoicePanel";
import { DmCallPanel } from "../../features/dm/DmCallPanel";
import type { Channel, Community } from "../../domain/types";

export interface ShellLeftColumnProps {
  community: Community | undefined;
  activeChannel: Channel | undefined;
  /** §16: o conteúdo (ou a grade de voz) é a tela em foco no Mobile. */
  contentPaneVisible: boolean;
  /**
   * A lista de 240px quando ela **não** é a de canais — hoje, a de conversas de U-33.
   *
   * Ela entra por aqui, e não ao lado da coluna, porque a barra de usuário atravessa o
   * rail **e** a lista (§8, 1.1): montada fora, a coluna ficava com a largura intrínseca
   * da própria barra (~215px em vez dos 72px do rail), o rail aparecia esticado ao trocar
   * para as conversas e a barra parava antes da lista em vez de correr sob ela.
   */
  lista?: ReactNode;
  inVoice: boolean;
  onSelectChannel: (channelId: string) => void;
  onJoinVoice: (channelId: string) => void;
}

/**
 * Coluna da esquerda: rail e lista de canais em cima, barra de usuário
 * (§8, 1.1) atravessando os dois no rodapé. A barra é do shell, não da
 * lista: ela existe mesmo no Hub vazio, onde não há lista nenhuma.
 */
export function ShellLeftColumn({
  community,
  activeChannel,
  contentPaneVisible,
  lista,
  inVoice,
  onSelectChannel,
  onJoinVoice,
}: ShellLeftColumnProps) {
  // §16: com o conteúdo em foco a coluna vira só o rail de 72px, e tudo o que
  // depende de largura sai da tela junto.
  const temLista = Boolean(community) || lista !== undefined;
  const recolhida = temLista && contentPaneVisible;

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col tablet:w-auto",
        // §16: no Mobile a coluna da esquerda **é** a tela enquanto a lista
        // de canais está em foco. Sem isto ela encolhia para os 312px de
        // rail + lista e o resto da janela ficava preto — a lista já pedia
        // `w-full`, mas quem precisa da largura agora é a coluna que a
        // embrulha, junto do painel de chamada e da barra de usuário.
        temLista && !contentPaneVisible ? "w-full" : "w-auto",
      )}
    >
      <div className="flex min-h-0 flex-1">
        <CommunityRail />

        {lista}

        {community && (
          <ChannelList
            community={community}
            activeChannelId={activeChannel?.id}
            onSelectChannel={onSelectChannel}
            onJoinVoice={onJoinVoice}
            className={cn(contentPaneVisible && "hidden tablet:flex")}
          />
        )}
      </div>

      {/* A chamada em curso fica logo acima da barra de usuário e com a
          largura dela (§9, 2.3.1): o que só existe enquanto há chamada.
          Some junto com ela no Mobile, pelo mesmo motivo. */}
      {inVoice && (
        <VoicePanel className={cn(recolhida && "hidden tablet:flex")} />
      )}

      {/*
        §31.15 / U-33 — o mesmo slot, para a chamada de conversa direta. Não coexiste com o
        `VoicePanel`: §15.4 diz "voz é uma só". Ele decide sozinho quando aparecer, porque
        quem sabe se há chamada é a store dela — e porque ele **some** quando a conversa da
        chamada é a que está na tela, onde o cabeçalho já oferece tudo isto e mais.
      */}
      <DmCallPanel className={cn(recolhida && "hidden tablet:flex")} />

      {/* §16: no Mobile a barra acompanha a lista de canais — com o
          conteúdo em foco, a coluna da esquerda é só o rail de 72px, que
          não comporta nome nem controles. */}
      <UserBar className={cn(recolhida && "hidden tablet:flex")} />
    </div>
  );
}
