import { useRef, useState } from "react";
import { EyeOff, Monitor, TriangleAlert } from "lucide-react";
import { cn } from "../../lib/cn";
import { Button } from "../../components/ui/Button";
import { StatusBanner } from "../../components/ui/StatusBanner";
import { useFindMember } from "../../store/communityStore";
import {
  useLocalParticipant,
  useVoiceStore,
  type ActiveShare,
} from "../../store/voiceStore";
import { useSettingsStore } from "../../store/settingsStore";
import { ShareControls } from "./ShareControls";
import { ShareStatusChips } from "./ShareStatusChips";
import {
  useAutoHideControls,
  useEscapeExitsFullscreen,
  useShareVideoElement,
} from "./screenShareHooks";

export interface ScreenShareStageProps {
  communityId: string;
  share: ActiveShare;
  isPresenter: boolean;
}

/**
 * Compartilhamento de tela (§17.5) — sub-modo do canal de voz, nunca tela irmã.
 *
 * **A topologia é estrela e só estrela** (A19/A20). Saíram desta tela, com B26: o seletor
 * de topologia (`Transmissão direta` vs `Retransmissão em árvore`), o `TreeHealthPopover`,
 * o banner "Otimizando distribuição…", o banner de reparo e o badge "Você está
 * retransmitindo para N pessoas". Todos descreviam a árvore de §17.8, que está **fora do
 * v1** — anunciá-los seria prometer um caminho que o produto não tem.
 *
 * Saiu também o selo **"Via TURN"**: §17.3 diz que tela via TURN é *recusada* no v1. Não é
 * um fallback que a UI possa mostrar, porque não é um fallback que exista.
 *
 * O vídeo é real: `<video>` ligado ao `MediaStream` que a estrela entregou. Esta tela é o
 * palco — os selos estão em `ShareStatusChips`, os botões em `ShareControls`, e a fiação do
 * elemento em `screenShareHooks`.
 */
export function ScreenShareStage({
  communityId,
  share,
  isPresenter,
}: ScreenShareStageProps) {
  const findMember = useFindMember();
  const retryShare = useVoiceStore((state) => state.retryShare);
  // §17.5 — ocultar é por sessão: com duas telas no canal, esconder uma não diz nada
  // sobre a outra.
  const oculto = share.oculto;
  /**
   * §9 (2.3) — ensurdecer é enforcement local e vale para **tudo** o que entra, não só para
   * a voz. Quando uma tela passou a poder trazer som (§17.5), este elemento virou uma
   * segunda saída de áudio: sem esta linha, quem ensurdeceu continuava ouvindo o som da
   * transmissão alheia, que é exatamente o que o botão promete calar.
   */
  const surdo = useLocalParticipant()?.deafened ?? false;
  /**
   * O volume que esta máquina deu a quem apresenta (§9, 2.3). Vale para o som da tela pelo
   * mesmo motivo do surdo: baixar alguém para 0% e continuar ouvindo a transmissão dele
   * seria o controle acender e não fazer nada.
   */
  const volume = useVoiceStore((state) => state.volumeById[share.presenterId] ?? 100);
  // §10, 3.1 (B47) — a saída e o volume GERAIS desta máquina (o que ela ouve).
  const outputId = useSettingsStore((state) => state.outputId);
  const outputVolume = useSettingsStore((state) => state.outputVolume);

  const [fullscreen, setFullscreen] = useState(false);
  const [ajustesAbertos, setAjustesAbertos] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const presenter = findMember(communityId, share.presenterId);
  const presenterName = presenter?.displayName ?? "Participante";

  useShareVideoElement({
    videoRef,
    isPresenter,
    oculto,
    presenterId: share.presenterId,
    phase: share.phase,
    volume,
    outputId,
    outputVolume,
    surdo,
  });

  const aoVivo = share.phase === "live";
  // Ocultar é do espectador: o apresentador nunca esconde a própria conferência.
  const exibindo = aoVivo && (isPresenter || !oculto);

  /**
   * Os controles só somem quando há **imagem** para eles cobrirem, e nunca enquanto o
   * popover de ajustes está aberto — some-lo debaixo do próprio menu seria puxar o tapete
   * de quem está usando.
   *
   * "Preparando…", a falha com "Tentar novamente" e o vídeo ocultado são o oposto: ali os
   * botões são o conteúdo, e escondê-los deixaria a pessoa sem saída.
   */
  const podeSumir = exibindo && !ajustesAbertos;
  const { controles, acordar, esconder, sobreControles } =
    useAutoHideControls(podeSumir);

  useEscapeExitsFullscreen(fullscreen, () => setFullscreen(false));

  /**
   * Sumir é por opacidade, não por desmontagem: o `<video>` não pode remontar (perderia o
   * `srcObject`) e os botões precisam continuar existindo para o foco de teclado poder
   * trazê-los de volta. `pointer-events-none` enquanto invisíveis evita o clique cego —
   * quem toca na tela para reaparecer não pode apertar um botão que não estava vendo.
   */
  const camada = cn(
    "transition-opacity duration-(--duration-base) ease-out",
    controles ? "opacity-100" : "pointer-events-none opacity-0",
  );

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col gap-2",
        fullscreen ? "fixed inset-0 z-50 bg-surface-app p-4" : "min-h-0 flex-1",
      )}
    >
      {isPresenter && share.viewerCount === 0 && aoVivo && (
        <StatusBanner tone="offline" inset>
          Ninguém está assistindo agora
        </StatusBanner>
      )}

      <div
        // Mexer o ponteiro é o gesto que traz os controles de volta; sair da área os
        // dispensa na hora, sem esperar o relógio. `onFocusCapture` é a metade de teclado:
        // um botão invisível que recebe foco precisa aparecer, senão o Tab passa por
        // controles que ninguém vê.
        onPointerMove={acordar}
        onPointerDown={acordar}
        onPointerLeave={esconder}
        onFocusCapture={acordar}
        className={cn(
          "relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-md border border-border-default bg-surface-app",
          // Em tela cheia o ponteiro parado também vira sujeira sobre a imagem.
          fullscreen && !controles && "cursor-none",
        )}
      >
        {share.phase === "starting" && (
          <p className="text-body text-text-secondary">
            Preparando compartilhamento…
          </p>
        )}

        {share.phase === "failed" && (
          <div className="flex flex-col items-center gap-3 p-6 text-center">
            <TriangleAlert
              size={24}
              strokeWidth={2}
              aria-hidden="true"
              className="text-conn-failed"
            />
            <p className="text-body text-text-primary">
              {share.motivoDaFalha ?? "Falha ao conectar à transmissão"}
            </p>
            {/*
              Apresentador repete a captura; espectador repete o `share.join`. Quem decide é
              o store, e o que este botão precisa dizer é **qual** transmissão — sem o id,
              com duas telas no canal, ele agia sempre sobre a minha.
            */}
            <Button variant="secondary" size="sm" onClick={() => retryShare(share.sessionId)}>
              Tentar novamente
            </Button>
          </div>
        )}

        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- transmissão ao vivo de tela não tem faixa de legenda */}
        <video
          ref={videoRef}
          autoPlay
          playsInline
          // O gesto que todo reprodutor de vídeo tem, e que aqui passou a fazer falta: com
          // os controles sumindo sozinhos, o duplo clique é o caminho para tela cheia que
          // não depende de achar um botão. Fica no `<video>`, não no contêiner, para não
          // disparar quando alguém clica duas vezes num botão da barra.
          onDoubleClick={() => setFullscreen((v) => !v)}
          // O apresentador não ouve a própria tela (seria eco da própria máquina); quem
          // assiste ouve o que vier junto, a menos que tenha ensurdecido.
          muted={isPresenter || surdo}
          aria-label={
            isPresenter
              ? "Sua tela, como os outros a veem"
              : `Tela de ${presenterName}`
          }
          className={cn("h-full w-full bg-black object-contain", !exibindo && "hidden")}
        />

        {/* Ocultado por quem assiste: o lugar do vídeo diz por que está vazio. */}
        {aoVivo && !exibindo && (
          <div className="flex flex-col items-center gap-2 p-6 text-center">
            <EyeOff size={24} strokeWidth={2} aria-hidden="true" className="text-text-tertiary" />
            <p className="text-body text-text-secondary">Vídeo oculto</p>
            <p className="text-meta text-text-tertiary">
              {presenterName} continua transmitindo — só você deixou de ver
              {share.comAudio ? " e de ouvir" : ""}.
            </p>
          </div>
        )}

        <ShareStatusChips
          communityId={communityId}
          share={share}
          isPresenter={isPresenter}
          aoVivo={aoVivo}
          camada={camada}
        />

        <ShareControls
          share={share}
          isPresenter={isPresenter}
          aoVivo={aoVivo}
          oculto={oculto}
          fullscreen={fullscreen}
          onToggleFullscreen={() => setFullscreen((value) => !value)}
          onAjustesChange={setAjustesAbertos}
          camada={camada}
          onPointerEnter={() => {
            sobreControles.current = true;
            acordar();
          }}
          onPointerLeave={() => {
            sobreControles.current = false;
            acordar();
          }}
        />

        {!aoVivo && share.phase !== "starting" && share.phase !== "failed" && (
          <Monitor
            size={24}
            strokeWidth={2}
            aria-hidden="true"
            className="text-text-tertiary"
          />
        )}
      </div>
    </div>
  );
}
