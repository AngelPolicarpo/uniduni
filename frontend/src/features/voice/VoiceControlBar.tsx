import { useEffect, useState } from "react";
import {
  AudioLines,
  Circle,
  Headphones,
  HeadphoneOff,
  Mic,
  MicOff,
  Monitor,
  MonitorUp,
  Music,
  PhoneOff,
  Settings,
  Square,
  Video,
  VideoOff,
} from "lucide-react";
import { cn } from "../../lib/cn";
import { Tooltip } from "../../components/ui/Tooltip";
import {
  gravacaoEmCurso,
  gravacaoSuportada,
  iniciarGravacao,
  pararGravacao,
} from "../../live/gravacao";
import { useVoiceStore } from "../../store/voiceStore";
import type { Channel, VoiceParticipant } from "../../domain/types";

interface ControlProps {
  label: string;
  icon: React.ReactNode;
  onClick?: () => void;
  pressed?: boolean;
  tone?: "default" | "warning" | "danger";
  /** Destino que só existe na Camada 3 — visível e inativo (precedente §6). */
  inert?: boolean;
}

/**
 * Botão da barra de controles (§5.7: ícones de 24px nas ações primárias da
 * chamada). Sempre com nome acessível — o ícone sozinho não nomeia nada.
 */
function Control({
  label,
  icon,
  onClick,
  pressed,
  tone = "default",
  inert = false,
}: ControlProps) {
  return (
    <Tooltip label={label} side="top">
      <button
        type="button"
        onClick={inert ? undefined : onClick}
        aria-pressed={pressed}
        aria-disabled={inert || undefined}
        className={cn(
          "grid size-11 place-items-center rounded-full",
          "transition-colors duration-(--duration-fast) ease-out",
          tone === "danger"
            ? "bg-feedback-danger text-text-on-accent hover:brightness-110"
            : tone === "warning"
              ? "bg-surface-elevated text-feedback-danger hover:bg-surface-primary"
              : "bg-surface-elevated text-text-secondary hover:bg-surface-primary hover:text-text-primary",
          inert && "cursor-not-allowed text-text-disabled",
        )}
      >
        {icon}
        <span className="sr-only">{label}</span>
      </button>
    </Tooltip>
  );
}

export interface VoiceControlBarProps {
  channel: Channel;
  local: VoiceParticipant | undefined;
  /** §17.4 — espelho local do gate do modo de fala; quem decide é o host. */
  podeTransmitir: boolean;
  canShareScreen: boolean;
  sharing: boolean;
  onChooseSource: () => void;
  onLeave: () => void;
}

/**
 * A barra de controles da chamada (§9, 2.3 · §5.7): microfone, áudio, câmera,
 * Modo Música, tela, gravação local e sair.
 */
export function VoiceControlBar({
  channel,
  local,
  podeTransmitir,
  canShareScreen,
  sharing,
  onChooseSource,
  onLeave,
}: VoiceControlBarProps) {
  const toggleMute = useVoiceStore((state) => state.toggleMute);
  const toggleDeafen = useVoiceStore((state) => state.toggleDeafen);
  const toggleCamera = useVoiceStore((state) => state.toggleCamera);
  const cameraPendente = useVoiceStore((state) => state.cameraPendente);
  const stopShare = useVoiceStore((state) => state.stopShare);
  const musicaAtiva = useVoiceStore((state) => state.musicaAtiva);
  const toggleMusica = useVoiceStore((state) => state.toggleMusica);

  /*
   * Épico 4 — gravação local do canal (o que ESTA máquina ouve), sem protocolo nenhum.
   *
   * O gravador mora em `live/gravacao.ts`, fora do React: esta barra desmonta quando a
   * grade se recolhe para a barra persistente (§9, 2.3.1), e um gravador em `useRef` ia
   * embora junto — `AudioContext` aberto para sempre e o arquivo perdido sem aviso. Aqui
   * fica só o que a UI precisa: se está gravando ou não, ressincronizado na montagem.
   */
  const [gravando, setGravando] = useState(gravacaoEmCurso);
  useEffect(() => {
    setGravando(gravacaoEmCurso());
  }, []);

  return (
    <div className="flex shrink-0 flex-wrap items-center justify-center gap-2 border-t border-border-subtle p-3">
  <Control
    label={
      !podeTransmitir
        ? channel.speechMode === "queue"
          ? "Aguardando sua vez na fila (karaokê)"
          : "O modo de fala deste canal não libera seu microfone"
        : local?.muted
          ? "Ativar microfone"
          : "Silenciar microfone"
    }
    pressed={local?.muted}
    tone={local?.muted ? "warning" : "default"}
    inert={!podeTransmitir}
    onClick={toggleMute}
    icon={
      local?.muted ? (
        <MicOff size={24} strokeWidth={2} aria-hidden="true" />
      ) : (
        <Mic size={24} strokeWidth={2} aria-hidden="true" />
      )
    }
  />
  <Control
    label={local?.deafened ? "Reativar áudio" : "Ensurdecer"}
    pressed={local?.deafened}
    tone={local?.deafened ? "warning" : "default"}
    onClick={toggleDeafen}
    icon={
      local?.deafened ? (
        <HeadphoneOff size={24} strokeWidth={2} aria-hidden="true" />
      ) : (
        <Headphones size={24} strokeWidth={2} aria-hidden="true" />
      )
    }
  />
  {/*
    §90 — não há mais teto de câmeras. O botão deixou de ter estado inativo
    "muitas câmeras nesta chamada": não existe número a partir do qual o host
    recuse, e desenhar um portão que o núcleo não aplica seria a interface
    inventando regra.
  */}
  <Control
    label={
      cameraPendente
        ? "Ligando câmera…"
        : local?.cameraOn
          ? "Desligar câmera"
          : "Ligar câmera"
    }
    pressed={local?.cameraOn}
    // Entre o gesto e a imagem está o diálogo de permissão do sistema, que demora o
    // que a pessoa levar para responder. Um segundo clique aí abriria uma segunda
    // captura; e anunciar a câmera antes de haver imagem é a decoração de §85.2.
    inert={cameraPendente}
    onClick={toggleCamera}
    icon={
      local?.cameraOn ? (
        <Video size={24} strokeWidth={2} aria-hidden="true" />
      ) : (
        <VideoOff size={24} strokeWidth={2} aria-hidden="true" />
      )
    }
  />
  {/*
    §17.5 (emenda de 2026-08-28) — Modo Música: um clique, captura do áudio do
    sistema. Disponível em qualquer modo de fala — quem transmite é sempre o gate
    de §17.4, e cortar a música junto com a voz é exatamente o que a imposição deve
    fazer.
  */}
  <Control
    label={musicaAtiva ? "Desligar Modo Música" : "Modo Música (áudio do computador)"}
    pressed={musicaAtiva}
    onClick={() => void toggleMusica()}
    icon={
      musicaAtiva ? (
        <AudioLines size={24} strokeWidth={2} aria-hidden="true" />
      ) : (
        <Music size={24} strokeWidth={2} aria-hidden="true" />
      )
    }
  />
  {canShareScreen && (
    <Control
      label={sharing ? "Parar compartilhamento" : "Compartilhar tela"}
      pressed={sharing}
      onClick={() => (sharing ? stopShare() : onChooseSource())}
      icon={
        sharing ? (
          <Monitor size={24} strokeWidth={2} aria-hidden="true" />
        ) : (
          <MonitorUp size={24} strokeWidth={2} aria-hidden="true" />
        )
      }
    />
  )}
  <Control
    label="Configurações de dispositivo"
    inert
    icon={<Settings size={24} strokeWidth={2} aria-hidden="true" />}
  />
  {gravacaoSuportada() && (
    <Control
      label={gravando ? "Parar gravação (baixa o arquivo)" : "Gravar o áudio do canal (local)"}
      pressed={gravando}
      tone={gravando ? "warning" : "default"}
      onClick={() => {
        const store = useVoiceStore.getState();
        if (gravando) {
          void pararGravacao().then((blob) => {
            setGravando(false);
            if (blob === null) return;
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `comunidade-${channel.name}-${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}.webm`;
            a.click();
            // A revogação SÍNCRONA corria contra o download: o Chromium resolve o `blob:`
            // fora desta pilha, e revogá-lo no mesmo tique deixava o arquivo vazio ou com
            // erro de rede. Um tique de folga é o bastante — e não revogar seria o
            // vazamento equivalente do lado do blob.
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
          });
          return;
        }
        const fluxos = store.consultarFluxos();
        if (fluxos === null) return;
        setGravando(iniciarGravacao(fluxos));
      }}
      icon={
        gravando ? (
          <Square size={22} strokeWidth={2} aria-hidden="true" />
        ) : (
          <Circle size={22} strokeWidth={2} aria-hidden="true" />
        )
      }
    />
  )}
  <Control
    label="Sair da chamada"
    tone="danger"
    onClick={onLeave}
    icon={<PhoneOff size={24} strokeWidth={2} aria-hidden="true" />}
  />
    </div>
  );
}
