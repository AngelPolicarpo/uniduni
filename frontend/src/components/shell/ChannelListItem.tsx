import { useState } from "react";
import { BellOff, Hash, MoreHorizontal, Volume2 } from "lucide-react";
import { cn } from "../../lib/cn";
import { Avatar } from "../ui/Avatar";
import { Badge } from "../ui/Badge";
import { ChannelContextMenu } from "./ChannelContextMenu";
import { MemberContextMenu } from "../../features/members/MemberContextMenu";
import { ProfilePopover } from "../../features/members/ProfilePopover";
import { useContextMenu } from "./useContextMenu";
import {
  useIsInVoiceChannel,
  useVoiceChannelParticipantIds,
} from "../../store/voiceStore";
import type { Channel } from "../../domain/types";
import { useCommunityStore, useFindMember } from "../../store/communityStore";

export interface ChannelListItemProps {
  channel: Channel;
  active: boolean;
  /** Só canal de texto troca a área de conteúdo (§4). */
  onSelect?: () => void;
  /** Canal de voz: entra na chamada sem trocar o conteúdo (§4, 2.3). */
  onJoinVoice?: () => void;
  /** §10, 3.4 — habilita os itens de gestão no menu de contexto. */
  canManage?: boolean;
  hostOnline?: boolean;
}

/**
 * Item de lista de canal (§6) — todos os estados obrigatórios:
 * default, hover, ativo (`accent-muted-bg`), não-lido (texto mais claro +
 * dot), menção pendente (badge numérico `feedback-danger`), silenciado
 * (ícone mudo, sem destaque de não-lido) e canal de voz com gente dentro
 * (uma linha por participante abaixo do nome: avatar + nome de exibição).
 *
 * A linha por participante substituiu a fileira de avatares nus (2026-08-27):
 * uma tira de iniciais coloridas só diz *quantos* estão na sala; quem está
 * lá ficava escondido no `sr-only`, legível para o leitor de tela e para
 * ninguém mais. O nome é a informação que faz entrar ou não na chamada.
 *
 * A linha é o quarto gatilho do popover de perfil (§8, 1.4), ao lado da lista
 * de membros, do autor de mensagem e do tile de voz. Botão direito nela abre
 * o menu de contexto **da pessoa** (§6): o do canal é do resto do item, e
 * empilhar os dois no mesmo gesto deixava o gesto sem alvo definido.
 *
 * Canal de voz é o ponto de entrada de 2.3: clicar entra na chamada e abre a
 * grade **por cima** do conteúdo — o canal de texto aberto continua onde
 * estava (§4). Por isso o item nunca fica "ativo": ele não é o que a área de
 * conteúdo está mostrando.
 */
export function ChannelListItem({
  channel,
  active,
  onSelect,
  onJoinVoice,
  canManage = false,
  hostOnline = true,
}: ChannelListItemProps) {
  const findMember = useFindMember();
  const menu = useContextMenu();
  // Participante da lista cujo perfil está aberto (§8, 1.4) — o mesmo popover
  // dos outros três gatilhos, com o retângulo da linha como âncora.
  const [profile, setProfile] = useState<{
    identityId: string;
    anchor: DOMRect;
  } | null>(null);
  // Botão direito na pessoa é do menu DELA; o do canal fica com o resto do
  // item. Guarda o retângulo da linha porque "Ver perfil" precisa ancorar o
  // popover no mesmo lugar de onde o menu saiu.
  const [participantMenu, setParticipantMenu] = useState<{
    identityId: string;
    anchor: DOMRect;
  } | null>(null);
  const toggleChannelMuted = useCommunityStore(
    (state) => state.toggleChannelMuted,
  );
  const isVoice = channel.type === "voice";
  // A ocupação vem do núcleo; a chamada em curso sobrepõe, senão a lista não
  // mostraria a identidade local depois que ela entra.
  const participantIds = useVoiceChannelParticipantIds(channel);
  const inThisCall = useIsInVoiceChannel(channel.id);
  // Silenciado perde o destaque de não-lido, nunca a menção (§6).
  const unread = channel.unreadCount > 0 && !channel.muted;

  const ChannelIcon = isVoice ? Volume2 : Hash;

  const content = (
    <>
      <ChannelIcon
        size={20}
        strokeWidth={2}
        className="shrink-0 text-text-tertiary"
        aria-hidden="true"
      />

      <span className="min-w-0 flex-1 truncate text-left">{channel.name}</span>

      {unread && <span className="sr-only">Mensagens não lidas</span>}

      {/*
        Indicadores da direita cedem o canto ao "⋯" no hover: o botão ocupa
        exatamente este espaço, e deixá-los por baixo dele empilhava duas
        informações no mesmo lugar — o "AO VIVO" de uma sala com gente dentro
        ficava metade escondido atrás do gatilho. Some por opacidade, não por
        `hidden`: o leitor de tela continua anunciando o estado do canal, e a
        largura não muda, então nada pula de lugar quando o ponteiro entra.
      */}
      <span
        className={cn(
          "flex shrink-0 items-center gap-1.5",
          "transition-opacity duration-(--duration-fast) ease-out",
          "group-hover:opacity-0",
          menu.open && "opacity-0",
        )}
      >
        {channel.muted && (
          <BellOff
            size={16}
            strokeWidth={2}
            role="img"
            aria-label="Silenciado"
            className="shrink-0 text-text-tertiary"
          />
        )}

        {isVoice && participantIds.length > 0 && (
          <Badge tone="live">AO VIVO</Badge>
        )}

        {channel.pendingMentions > 0 && (
          <Badge
            count={channel.pendingMentions}
            srLabel={`${channel.pendingMentions} menção pendente`}
          />
        )}
      </span>
    </>
  );

  const rowClass = cn(
    "flex h-8 w-full items-center gap-1.5 rounded-md px-2",
    "transition-colors duration-(--duration-fast) ease-out",
    active
      ? "bg-accent-muted-bg text-text-primary"
      : unread || inThisCall
        ? "text-text-primary"
        : channel.muted
          ? "text-text-tertiary"
          : "text-text-secondary",
    unread && !active && "text-body-emphasis",
    !active && "hover:bg-surface-primary hover:text-text-primary",
  );

  return (
    <li
      onContextMenu={(event) => {
        event.preventDefault();
        menu.show();
      }}
    >
      {/*
        A linha do canal é o seu próprio bloco, separada da lista de gente
        embaixo: o "⋯", o dot e o menu de contexto se ancoram nela, e não no
        `li` inteiro. Enquanto o `li` era a âncora, três participantes
        empurravam o menu do canal 80px para baixo do canal que ele governa.
      */}
      <div className="group relative">
        {/* Dot de não-lido na borda da lista, fora do retângulo do item ativo
            para os dois estados nunca se sobreporem (§6). */}
        {unread && (
          <span
            className="pointer-events-none absolute top-1/2 -left-2 h-2 w-1 -translate-y-1/2 rounded-r-full bg-text-primary"
            aria-hidden="true"
          />
        )}

        <button
          type="button"
          onClick={(event) => {
            // docs/frontend.md:536 — Atalho: Shift + clique no canal na lista.
            if (event.shiftKey) {
              event.preventDefault();
              toggleChannelMuted(channel.id);
              return;
            }
            if (isVoice) {
              onJoinVoice?.();
            } else {
              onSelect?.();
            }
          }}
          aria-current={active ? "true" : undefined}
          className={rowClass}
        >
          {content}
        </button>

        {/*
          Caminho equivalente ao botão direito (§19.4): teclado e toque chegam
          ao mesmo menu pelo "⋯", que aparece no hover e no foco. Fica sobre a
          borda direita, cobrindo os badges — como no gênero.
        */}
        <button
          type="button"
          onClick={menu.toggle}
          aria-label={`Opções de ${channel.name}`}
          aria-haspopup="menu"
          aria-expanded={menu.open}
          className={cn(
            "absolute top-0 right-1 hidden size-8 place-items-center rounded-md",
            "text-text-secondary hover:bg-surface-elevated hover:text-text-primary",
            "group-hover:grid focus-visible:grid",
            menu.open && "grid",
          )}
        >
          <MoreHorizontal size={16} strokeWidth={2} aria-hidden="true" />
        </button>

        <ChannelContextMenu
          channel={channel}
          canManage={canManage}
          hostOnline={hostOnline}
          open={menu.open}
          onClose={menu.close}
        />
      </div>

      {isVoice && participantIds.length > 0 && (
        <ul className="mt-0.5 mb-1 flex flex-col gap-0.5">
          {participantIds.map((identityId) => {
            const member = findMember(channel.communityId, identityId);
            if (!member) return null;
            return (
              <li key={identityId} className="relative">
                <button
                  type="button"
                  onClick={(event) =>
                    setProfile({
                      identityId,
                      anchor: event.currentTarget.getBoundingClientRect(),
                    })
                  }
                  onContextMenu={(event) => {
                    event.preventDefault();
                    // Sem isto o menu do canal abriria por cima: o `li` do
                    // canal escuta o mesmo evento, mais acima na árvore.
                    event.stopPropagation();
                    setParticipantMenu({
                      identityId,
                      anchor: event.currentTarget.getBoundingClientRect(),
                    });
                  }}
                  className={cn(
                    "flex h-7 w-full items-center gap-2 rounded-md pr-2 pl-8 text-left",
                    "text-text-secondary",
                    "transition-colors duration-(--duration-fast) ease-out",
                    "hover:bg-surface-primary hover:text-text-primary",
                  )}
                >
                  <Avatar
                    name={member.displayName}
                    color={member.avatarColor}
                    size="sm"
                  />
                  <span className="min-w-0 flex-1 truncate text-meta">
                    {member.displayName}
                  </span>
                </button>

                <MemberContextMenu
                  communityId={channel.communityId}
                  identityId={identityId}
                  open={participantMenu?.identityId === identityId}
                  onClose={() => setParticipantMenu(null)}
                  inCall={inThisCall}
                  onOpenProfile={() => {
                    if (participantMenu) setProfile(participantMenu);
                  }}
                />
              </li>
            );
          })}
        </ul>
      )}

      {profile && (
        <ProfilePopover
          communityId={channel.communityId}
          identityId={profile.identityId}
          anchor={profile.anchor}
          onClose={() => setProfile(null)}
          /* Volume individual e silenciar-nesta-chamada (§8, 1.4) só valem
             quando os dois estão na MESMA chamada — daqui isso é verdade
             exatamente quando a chamada local é a deste canal. */
          inCall={inThisCall}
        />
      )}
    </li>
  );
}
