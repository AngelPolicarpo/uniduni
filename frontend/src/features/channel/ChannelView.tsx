import { useState } from "react";
import { Lock } from "lucide-react";
import { cn } from "../../lib/cn";
import { StatusBanner } from "../../components/ui/StatusBanner";
import { useQueuedCount } from "../../store/messageStore";
import { ChannelHeader } from "./ChannelHeader";
import { Composer } from "./Composer";
import { ModoHistorico } from "../moderation/ModoHistorico";
import { MessageList } from "./MessageList";
import {
  selectIsChannelReadOnly,
  useCommunityStore,
} from "../../store/communityStore";
import { useHostStatus } from "../../store/connectionStore";
import type { Channel, Community, Message } from "../../domain/types";

/**
 * §9, 2.1 — canal somente-leitura para o cargo atual (`#avisos` para quem
 * não é Moderador+): o composer é substituído por este aviso, não fica
 * desabilitado nem some sem explicação.
 */
function ReadOnlyNotice() {
  return (
    // `surface-elevated`, não `sidebar`: este aviso ocupa exatamente o lugar
    // do composer, que é elevado. Mais escuro que o conteúdo, o canal parecia
    // ter perdido o composer num buraco em vez de ganhado uma explicação.
    <div className="mx-4 mb-4 flex items-center gap-2 rounded-md border border-border-default bg-surface-elevated px-4 py-3">
      <Lock
        size={16}
        strokeWidth={2}
        aria-hidden="true"
        className="shrink-0 text-text-tertiary"
      />
      <p className="text-body text-text-tertiary">
        Só moderadores podem postar aqui
      </p>
    </div>
  );
}

export interface ChannelViewProps {
  community: Community;
  channel: Channel;
  onBack: () => void;
  className?: string;
  /**
   * A grade de voz (§9, 2.3) está aberta por cima deste canal.
   *
   * A grade é `absolute inset-0` sobre a área de conteúdo: ela esconde o canal
   * de quem enxerga, e **só** de quem enxerga. Sem `inert`, o composer, os
   * botões de cada mensagem e o cabeçalho continuavam no tab order e na árvore
   * de acessibilidade — quem navega por teclado saía da grade direto para
   * controles invisíveis, e o leitor de tela lia um canal que não está na tela.
   */
  inerte?: boolean;
}

/**
 * Área de conteúdo do shell com um canal de texto aberto (§8 1.1, §9 2.1).
 *
 * O banner de host offline (§11, B4) fica acima da lista e não bloqueia a
 * leitura: o histórico da réplica local é dado válido, não erro.
 */
export function ChannelView({
  community,
  channel,
  onBack,
  className,
  inerte = false,
}: ChannelViewProps) {
  // §18.4 passo 5 e U-17 — comunidade em modo histórico é somente leitura INTEIRA, e não
  // por cargo: não há para quem mandar. Sem isto o composer continuava de pé numa
  // comunidade cujo host acabou de recusar esta identidade — ou numa encerrada, cujo log o
  // `fold` fechou —, enfileirando o que nunca sairia.
  const removida = community.removedReason !== undefined || community.endedAt !== undefined;
  const readOnly = useCommunityStore(
    (state) => removida || selectIsChannelReadOnly(state, channel),
  );
  const hostStatus = useHostStatus(community);
  const queuedCount = useQueuedCount(channel.id);

  // Resposta em preparo (§9, 2.1) — some ao trocar de canal, junto com o
  // rascunho do composer. Quem apaga é o `key={channel.id}` do `AppShell`, que
  // remonta esta seção inteira: limpar no efeito deixava a resposta do canal
  // anterior aparecer por um render no canal novo.
  const [replyTo, setReplyTo] = useState<Message | null>(null);

  return (
    <section
      inert={inerte}
      aria-label={`Canal ${channel.name}`}
      className={cn(
        "flex min-w-0 flex-1 flex-col bg-surface-primary",
        className,
      )}
    >
      <ChannelHeader channel={channel} onBack={onBack} />

      {/* U-16 — o cabeçalho nomeado vem ANTES dos banners de conexão: "você foi banido"
          explica o `offline` logo abaixo, e a ordem inversa faria o app parecer quebrado
          antes de dizer por quê. */}
      <ModoHistorico community={community} />

      {!removida && hostStatus === "offline" && (
        <StatusBanner tone="offline">
          {community.name} está offline — mostrando histórico salvo neste
          dispositivo
          {/* A fila é durável (premissa 5): ao reabrir o app com pendências,
              a contagem é o que confirma que elas não se perderam. */}
          {queuedCount > 0 &&
            ` · ${queuedCount} ${
              queuedCount === 1
                ? "mensagem sua aguardando envio"
                : "mensagens suas aguardando envio"
            }`}
        </StatusBanner>
      )}
      {/* E o `reconnecting` some junto: quem foi removido não está reconectando com
          ninguém — o núcleo saiu do swarm daquela comunidade no passo 1 de §18.4. */}
      {!removida && hostStatus === "reconnecting" && (
        <StatusBanner tone="reconnecting">Reconectando…</StatusBanner>
      )}

      <MessageList channel={channel} readOnly={readOnly} onReply={setReplyTo} />

      {readOnly ? (
        <ReadOnlyNotice />
      ) : (
        <Composer
          // Sem `key` próprio: trocar de canal já remonta este `ChannelView`
          // inteiro (`key` no `AppShell`), e com ele o rascunho e o autocomplete.
          channel={channel}
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(null)}
        />
      )}
    </section>
  );
}
