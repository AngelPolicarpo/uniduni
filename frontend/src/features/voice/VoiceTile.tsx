import { useEffect, useRef } from "react";
import { HeadphoneOff, MicOff, MonitorUp, SignalLow, Video, WifiOff } from "lucide-react";
import { cn } from "../../lib/cn";
import { cameraLocal, cameraRecebida } from "../../live/cameraStreams";
import { Avatar } from "../../components/ui/Avatar";
import { Skeleton } from "../../components/ui/Skeleton";
import { Tooltip } from "../../components/ui/Tooltip";
import { ROLE_TEXT_CLASS } from "../../lib/role";
import { selectHighestRole, useCommunityStore, useFindMember } from "../../store/communityStore";
import { useVoiceStore } from "../../store/voiceStore";
import type { VoiceParticipant } from "../../domain/types";

export interface VoiceTileProps {
  communityId: string;
  participant: VoiceParticipant;
  isLocal: boolean;
  /** Mobile e tira de miniaturas: linha compacta em vez de card (§9, 2.3). */
  compact?: boolean;
  /**
   * §9, 2.3.2 — este é o tile fixado como principal: ocupa a área grande em vez de
   * uma célula da grade, e por isso é a altura disponível que o dimensiona, não a
   * proporção do card.
   */
  destaque?: boolean;
  /**
   * §9, 2.3.2 — há câmera ligada nesta chamada, então a grade inteira vai a 16:9.
   * É decisão da grade e não do tile: ver o comentário na classe abaixo.
   */
  widescreen?: boolean;
  onOpenProfile: (identityId: string, anchor: DOMRect) => void;
}

/**
 * Tile de participante de voz/vídeo (§6) — avatar + anel de fala + ícones de
 * estado sobrepostos no canto.
 *
 * O anel de fala vem do próprio `Avatar` (forma + movimento, §5.4), então
 * nunca colide com o dot de presença: são pistas visuais diferentes no mesmo
 * componente, como a spec exige por acessibilidade.
 */
export function VoiceTile({
  communityId,
  participant,
  isLocal,
  compact = false,
  destaque = false,
  widescreen = false,
  onOpenProfile,
}: VoiceTileProps) {
  const findMember = useFindMember();
  const member = findMember(communityId, participant.identityId);
  const role = useCommunityStore((state) =>
    selectHighestRole(state, member?.roleIds ?? []),
  );

  const name = member?.displayName ?? "Participante";
  const failed = participant.connectionToMe === "failed";
  const degraded = participant.connectionToMe === "degraded";
  // Conexão ruim derruba o vídeo antes da voz: o áudio tem prioridade
  // declarada (§9, 2.3.2), e o tile volta a mostrar o avatar.
  const video = participant.cameraOn && !failed && !degraded;
  const videoRef = useRef<HTMLVideoElement>(null);
  // O aviso de que há `MediaStream` novo fora do React — ver `cameraSeq` no store.
  const cameraSeq = useVoiceStore((state) => state.cameraSeq);
  const alternarFixado = useVoiceStore((state) => state.alternarFixado);
  const fixado = useVoiceStore((state) => state.fixadoId === participant.identityId);

  /**
   * §17.2 — a imagem é real: `<video>` ligado ao `MediaStream` que a malha entregou. O
   * gradiente animado que morava aqui era do mock, e sobreviveu à captura de tela de §83
   * porque a câmera ainda não tinha saído dele.
   *
   * O stream mora fora do React (`live/cameraStreams`), como o da tela: ele precisa
   * sobreviver a re-render, e um `srcObject` recriado a cada render pisca a imagem. Quem
   * está com a câmera ligada vê o que captura; os outros veem o que chegou pela malha.
   */
  useEffect(() => {
    const el = videoRef.current;
    if (el === null) return;
    if (!video) {
      // Soltar o `srcObject` é o que de fato para a decodificação; esconder por CSS
      // continuaria pintando quadro a quadro para ninguém.
      el.srcObject = null;
      return;
    }
    const stream = isLocal ? cameraLocal() : cameraRecebida(participant.identityId);
    if (stream === null) return;
    // Reatribuir o MESMO stream reinicia a decodificação e pisca a imagem — e este efeito
    // roda de novo a cada câmera que entra na chamada, não só a deste tile.
    if (el.srcObject !== stream) el.srcObject = stream;
    void el.play().catch(() => undefined);
  }, [video, isLocal, participant.identityId, cameraSeq]);

  /**
   * Desmontar solta o stream. Fica num efeito próprio, sem dependências, porque juntá-lo ao
   * de cima faria a limpeza rodar a cada troca de dependência — e um `srcObject` que vai a
   * `null` e volta no mesmo fôlego pisca a imagem, que é o defeito que o guarda acima evita.
   */
  useEffect(() => {
    const el = videoRef.current;
    return () => {
      if (el !== null) el.srcObject = null;
    };
  }, []);

  const stateIcons = (
    <>
      {participant.muted && (
        <Tooltip label="Microfone desligado" side="top">
          <span className="grid size-6 place-items-center rounded-full bg-surface-app/80 text-text-secondary">
            <MicOff size={16} strokeWidth={2} aria-hidden="true" />
            <span className="sr-only">Microfone desligado</span>
          </span>
        </Tooltip>
      )}
      {participant.deafened && (
        <Tooltip label="Áudio desligado" side="top">
          <span className="grid size-6 place-items-center rounded-full bg-surface-app/80 text-text-secondary">
            <HeadphoneOff size={16} strokeWidth={2} aria-hidden="true" />
            <span className="sr-only">Áudio desligado</span>
          </span>
        </Tooltip>
      )}
      {participant.cameraOn && (
        <Tooltip label="Câmera ligada" side="top">
          <span className="grid size-6 place-items-center rounded-full bg-surface-app/80 text-text-secondary">
            <Video size={16} strokeWidth={2} aria-hidden="true" />
            <span className="sr-only">Câmera ligada</span>
          </span>
        </Tooltip>
      )}
      {participant.sharingScreen && (
        <Tooltip label="Compartilhando a tela" side="top">
          <span className="grid size-6 place-items-center rounded-full bg-surface-app/80 text-accent-default">
            <MonitorUp size={16} strokeWidth={2} aria-hidden="true" />
            <span className="sr-only">Compartilhando a tela</span>
          </span>
        </Tooltip>
      )}
      {/* §11, B7 passo 3 — falha pontual de mesh, só neste tile. */}
      {(failed || degraded) && (
        <Tooltip
          label={failed ? "Sem conexão com você" : "Conexão instável"}
          side="top"
        >
          <span
            className={cn(
              "grid size-6 place-items-center rounded-full bg-surface-app/80",
              failed ? "text-conn-failed" : "text-conn-degraded",
            )}
          >
            {/*
              `SignalZero` desenha só o ponto da base, sem barra nenhuma: no
              tile virava uma poeira vermelha de 16px, indistinguível de
              sujeira na tela e quase idêntica ao `SignalLow` do estado
              vizinho. O traço cruzado do `WifiOff` diz "não conecta" pela
              forma, que é o que §5.4 exige — a cor não pode ser a única
              pista.
            */}
            {failed ? (
              <WifiOff size={16} strokeWidth={2} aria-hidden="true" />
            ) : (
              <SignalLow size={16} strokeWidth={2} aria-hidden="true" />
            )}
            {/*
              Falha já tem a frase escrita no corpo do tile; repetir aqui
              fazia o leitor de tela anunciar "Sem conexão com você" duas
              vezes seguidas. Instável não tem texto visível, então o rótulo
              acessível continua sendo daqui.
            */}
            {!failed && <span className="sr-only">Conexão instável</span>}
          </span>
        </Tooltip>
      )}
    </>
  );

  return (
    <li className={cn(destaque && "flex min-h-0 flex-1")}>
      <button
        type="button"
        onClick={(event) =>
          onOpenProfile(
            participant.identityId,
            event.currentTarget.getBoundingClientRect(),
          )
        }
        /*
          §9, 2.3.2 — "fixar um tile como principal (clique duplo — desfaz com outro
          clique duplo)". É o que dá ao espectador o controle sobre o que ocupa a área
          grande: sem isto, com alguém transmitindo a tela, TODA câmera da chamada virava
          uma miniatura de 40px e não havia como aumentar nenhuma.
        */
        onDoubleClick={() => alternarFixado(participant.identityId)}
        aria-label={`${name}${isLocal ? " (você)" : ""}`}
        aria-pressed={fixado}
        title={
          fixado
            ? "Clique duplo para desafixar"
            : "Clique duplo para fixar como principal"
        }
        className={cn(
          "group relative flex w-full items-center overflow-hidden rounded-md border",
          "transition-colors duration-(--duration-fast) ease-out",
          "bg-surface-sidebar hover:border-border-strong",
          failed ? "border-conn-failed/40" : "border-border-default",
          fixado && !compact && "border-accent-default",
          compact
            ? "h-14 shrink-0 gap-3 px-3"
            : destaque
              // Fixado: quem manda no tamanho é a área, não a proporção do card.
              ? "h-full flex-col justify-center gap-2 p-3"
              // §9, 2.3.2 — "Proporção 16:9" para o tile com câmera. A proporção é da
              // GRADE, não do tile: mistura de 16:9 com 4:3 na mesma fileira deixa as
              // células de alturas diferentes, com buraco embaixo das mais baixas. Basta
              // uma câmera ligada para a grade inteira virar 16:9 — o tile sem câmera só
              // ganha mais respiro em volta do avatar, que é o que ele já é.
              : widescreen
                ? "aspect-video flex-col justify-center gap-2 p-3"
                : "aspect-[4/3] flex-col justify-center gap-2 p-3",
        )}
      >
        {/*
          §9, 2.3.2 — câmera ligada **troca** o avatar pelo vídeo; não o cobre. Desenhar as
          iniciais da pessoa por cima do rosto dela era herança do mock, onde "vídeo" era um
          gradiente e não havia rosto nenhum embaixo.

          A forma muda com o espaço, e as duas são o mesmo elemento — um só `srcObject`, um
          só `ref`. Na grade o vídeo ocupa o tile inteiro; na linha compacta (que é o que a
          tira de miniaturas ao lado de uma transmissão usa) ele ocupa o lugar do avatar, em
          4:3. Full-bleed numa faixa de 56px recortaria um rosto em tarja e ainda poria o
          nome por cima da imagem.

          Sem som: a voz daquele par já toca no `<audio>` que a malha mantém (§17.4 L-12 e o
          volume por participante de §9). Um segundo caminho de áudio aqui seria a mesma
          pessoa duas vezes, e fora do controle de volume dela.
        */}
        <span
          className={cn(
            video ? (compact ? "relative h-10 w-[3.25rem] shrink-0" : "absolute inset-0") : "hidden",
          )}
        >
          {/* eslint-disable-next-line jsx-a11y/media-has-caption -- vídeo ao vivo de câmera não tem faixa de legenda */}
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            aria-label={isLocal ? "Sua câmera, como os outros a veem" : `Câmera de ${name}`}
            className={cn(
              "h-full w-full rounded-md bg-black object-cover",
              // Você se vê espelhada; os outros te veem como você é.
              isLocal && "scale-x-[-1]",
            )}
          />
          {/*
            Fala ativa continua sendo **anel**, mesmo sem avatar: §5.4 pede forma e
            movimento, e some-la junto com as iniciais deixaria a grade sem dizer quem está
            falando exatamente quando há mais o que olhar.
          */}
          {participant.speaking && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 animate-speaking-ring rounded-md border-2 border-presence-online"
            />
          )}
        </span>

        {!video && (
          <Avatar
            name={name}
            color={member?.avatarColor ?? "role-neutral"}
            size={compact ? "md" : "lg"}
            speaking={participant.speaking}
          />
        )}

        {/*
          A coluna encolhe até a largura do filho mais largo. Com um filho só
          — o caso dos tiles sem falha — ela tem a largura do nome e o
          `items-start` não aparece; assim que entra a segunda linha ("Sem
          conexão com você", mais larga), o nome fica preso à esquerda dessa
          caixa e sai 22px do centro do tile, enquanto o avatar acima segue
          centralizado. Na grade o alinhamento é central; na linha compacta,
          onde o texto fica ao lado do avatar, continua à esquerda.

          Sobre vídeo, o nome ganha fundo. Texto claro direto sobre imagem ao vivo é
          ilegível pela metade do tempo e não tem contraste que se possa afirmar: o que
          estava atrás dele antes era uma superfície conhecida, agora é o que a câmera
          estiver mostrando. Na linha compacta não há o que cobrir — a miniatura fica ao
          lado do texto, não atrás dele.
        */}
        <span
          className={cn(
            "flex min-w-0 flex-col gap-0.5",
            compact ? "items-start" : "items-center text-center",
            video &&
              !compact &&
              "absolute right-2 bottom-2 left-2 rounded-md bg-surface-app/80 px-2 py-1 backdrop-blur-sm",
          )}
        >
          <span
            className={cn(
              "max-w-full truncate text-body-emphasis",
              role ? ROLE_TEXT_CLASS[role.color] : "text-text-primary",
            )}
          >
            {name}
            {isLocal && (
              <span className="text-text-tertiary"> (você)</span>
            )}
          </span>
          {failed && (
            <span className="text-meta text-conn-failed">
              Sem conexão com você
            </span>
          )}
        </span>

        <span
          className={cn(
            "flex items-center gap-1",
            compact ? "ml-auto" : "absolute top-2 right-2",
          )}
        >
          {stateIcons}
        </span>
      </button>
    </li>
  );
}

/** §11, B7 passo 2 — tiles com skeleton enquanto o mesh se estabelece. */
export function VoiceTileSkeleton({ compact = false }: { compact?: boolean }) {
  return (
    <li
      className={cn(
        "flex items-center rounded-md border border-border-default bg-surface-sidebar",
        compact
          ? "h-14 shrink-0 gap-3 px-3"
          : "aspect-[4/3] flex-col justify-center gap-2 p-3",
      )}
    >
      <Skeleton className={compact ? "size-8 rounded-full" : "size-20 rounded-full"} />
      <Skeleton className="h-3 w-24" />
    </li>
  );
}
