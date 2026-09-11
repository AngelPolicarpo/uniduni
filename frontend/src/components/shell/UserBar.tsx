import { useState } from "react";
import { HeadphoneOff, Headphones, Mic, MicOff, Settings } from "lucide-react";
import { cn } from "../../lib/cn";
import { Avatar } from "../ui/Avatar";
import { Tooltip } from "../ui/Tooltip";
import { PRESENCE_LABEL } from "../../lib/avatar";
import { ProfilePopover } from "../../features/members/ProfilePopover";
import { useIdentityStore } from "../../store/identityStore";
import { useUiStore } from "../../store/uiStore";
import { selectCanTransmitIn, useCommunityStore } from "../../store/communityStore";
import { useSelfAudio, useVoiceStore } from "../../store/voiceStore";

interface ControlProps {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  pressed: boolean;
  /** Visível e inativo: o modo de fala do canal em chamada não libera o microfone. */
  inert?: boolean;
}

/**
 * Mudo, ensurdecer e configurações. O estado ligado é vermelho **e** troca o
 * ícone para a versão cortada: §5.4 não aceita cor como pista única.
 */
function Control({ label, icon, onClick, pressed, inert = false }: ControlProps) {
  return (
    <Tooltip label={label} side="top">
      <button
        type="button"
        onClick={inert ? undefined : onClick}
        aria-pressed={pressed}
        aria-label={label}
        aria-disabled={inert || undefined}
        className={cn(
          // 44px de alvo de toque no Mobile, 32px onde há ponteiro (§9, 2.3.1).
          "grid size-11 shrink-0 place-items-center rounded-md tablet:size-8",
          "transition-colors duration-(--duration-fast) ease-out",
          pressed
            ? "bg-feedback-danger/15 text-feedback-danger hover:bg-feedback-danger/25"
            : "text-text-secondary hover:bg-surface-primary hover:text-text-primary",
          inert && "cursor-not-allowed text-text-disabled hover:bg-transparent",
        )}
      >
        {icon}
      </button>
    </Tooltip>
  );
}

export interface UserBarProps {
  className?: string;
  /**
   * Hub vazio (0.2): não há lista de canais nem de conversas para a barra
   * atravessar, então ela se recolhe à largura do rail e empilha o que mostrava
   * em fileira.
   *
   * Sem isto a barra era o elemento mais largo da coluna da esquerda e, como a
   * coluna é `w-auto`, era ela quem decidia a largura: o rail de 72px de §5.6
   * aparecia com 250px, com 178px de superfície vazia ao lado dos ícones, até
   * a pessoa entrar na primeira comunidade.
   */
  compacta?: boolean;
}

/**
 * §8, 1.1 — barra de usuário, no rodapé da coluna da esquerda, atravessando
 * o rail e a lista de canais.
 *
 * É a superfície permanente da identidade local: quem eu sou, como estou
 * aparecendo e os dois controles de áudio. Os dois valem **fora** da chamada
 * (preferência persistida no `voiceStore`) — sem isso, "entrar já mudo" não
 * existiria e o único lugar para desligar o microfone seria uma chamada em
 * curso.
 *
 * Substitui o avatar do rodapé do rail como porta de 3.1: o avatar sozinho
 * não dizia nome nem presença, e duas portas para a mesma tela na mesma
 * coluna seriam ruído.
 */
export function UserBar({ className, compacta = false }: UserBarProps) {
  const identity = useIdentityStore((state) => state.identity);
  const openAccountSettings = useUiStore((state) => state.openAccountSettings);
  const activeCommunityId = useCommunityStore(
    (state) => state.activeCommunityId,
  );
  const { muted, deafened } = useSelfAudio();
  const toggleMute = useVoiceStore((state) => state.toggleMute);
  const toggleDeafen = useVoiceStore((state) => state.toggleDeafen);
  const inVoice = useVoiceStore((state) => state.channelId !== null);
  const voiceChannelId = useVoiceStore((state) => state.channelId);

  // §17.4 (emenda de 2026-08-28) — fora de chamada, o mute é preferência local e sempre
  // vale. Em chamada, o modo de fala do canal (§6.6) gateia DESMUTAR: quem não tem
  // direito de transmissão fica com o botão visível e inativo, com o porquê no rótulo.
  const titularDaFila = useVoiceStore((state) =>
    voiceChannelId !== null && state.fila?.channelId === voiceChannelId
      ? state.fila.turn?.keyHex ?? null
      : null,
  );
  const podeTransmitir = useCommunityStore((state) =>
    voiceChannelId ? selectCanTransmitIn(state, voiceChannelId, titularDaFila) : true,
  );
  const desmutarBloqueado = voiceChannelId !== null && !podeTransmitir && muted;

  const [profile, setProfile] = useState<DOMRect | null>(null);

  if (!identity) return null;

  return (
    <div
      className={cn(
        "flex shrink-0 gap-1 border-t border-border-subtle bg-surface-app",
        compacta
          ? "w-18 flex-col items-center px-2 py-2"
          : "h-14 items-center px-2",
        className,
      )}
    >
      {/*
        O bloco todo abre o popover do próprio perfil (§8, 1.4): presença,
        apelido e o caminho para 3.1 já moram lá. A engrenagem continua indo
        direto, para quem quer as configurações e não o perfil.
      */}
      <button
        type="button"
        onClick={(event) =>
          setProfile(event.currentTarget.getBoundingClientRect())
        }
        aria-haspopup="dialog"
        className={cn(
          "flex items-center rounded-md p-1 text-left",
          "transition-colors duration-(--duration-fast) ease-out",
          "hover:bg-surface-primary",
          compacta ? "shrink-0" : "min-w-0 flex-1 gap-2",
        )}
      >
        <Avatar
          name={identity.displayName}
          color={identity.avatarColor}
          size="md"
          presence={identity.presence}
          presenceRingClass="border-surface-app"
        />
        {/* No rail recolhido o nome não cabe em 72px — quem o diz é o tooltip
            do avatar e o popover que este botão abre. */}
        <span className={cn("flex min-w-0 flex-col", compacta && "sr-only")}>
          <span className="truncate text-body-emphasis text-text-primary">
            {identity.displayName}
          </span>
          <span className="truncate text-meta text-text-tertiary">
            {PRESENCE_LABEL[identity.presence]}
          </span>
        </span>
      </button>

      <Control
        label={
          desmutarBloqueado
            ? "Aguardando vez ou sem permissão de fala neste canal"
            : muted
              ? "Ativar microfone"
              : "Silenciar microfone"
        }
        pressed={muted}
        inert={desmutarBloqueado}
        onClick={toggleMute}
        icon={
          muted ? (
            <MicOff size={20} strokeWidth={2} aria-hidden="true" />
          ) : (
            <Mic size={20} strokeWidth={2} aria-hidden="true" />
          )
        }
      />
      <Control
        label={deafened ? "Reativar áudio" : "Ensurdecer"}
        pressed={deafened}
        onClick={toggleDeafen}
        icon={
          deafened ? (
            <HeadphoneOff size={20} strokeWidth={2} aria-hidden="true" />
          ) : (
            <Headphones size={20} strokeWidth={2} aria-hidden="true" />
          )
        }
      />
      <Control
        label="Configurações de conta"
        pressed={false}
        onClick={openAccountSettings}
        icon={<Settings size={20} strokeWidth={2} aria-hidden="true" />}
      />

      {/*
        O popover é do meu perfil NESTA comunidade — apelido é por comunidade
        (§2, Member). Sem comunidade ativa (Hub vazio) não há membro para
        mostrar, e o caminho continua sendo a engrenagem.
      */}
      {profile && activeCommunityId && (
        <ProfilePopover
          communityId={activeCommunityId}
          identityId={identity.id}
          anchor={profile}
          onClose={() => setProfile(null)}
          inCall={inVoice}
        />
      )}
    </div>
  );
}
