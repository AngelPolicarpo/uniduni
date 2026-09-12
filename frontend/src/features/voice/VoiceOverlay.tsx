import { useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, Volume2 } from "lucide-react";
import { cn } from "../../lib/cn";
import { ProfilePopover } from "../members/ProfilePopover";
import { FilaKaraokê } from "./FilaKaraoke";
import { MusicaQuickControls } from "./MusicaQuickControls";
import { ScreenShareStage } from "./ScreenShareStage";
import { ShareSourceModal } from "./ShareSourceModal";
import { LeaveVoiceConfirm } from "./LeaveVoiceConfirm";
import { useLeaveVoiceGuard } from "./leaveGuard";
import { VoiceCallBanners } from "./VoiceCallBanners";
import { VoiceControlBar } from "./VoiceControlBar";
import { VoiceTile, VoiceTileSkeleton } from "./VoiceTile";
import { comporPalco } from "./palcoDaChamada";
import { useIsMobile } from "../../lib/useMediaQuery";
import {
  selectCanTransmitIn,
  selectChannel,
  selectCommunity,
  useCommunityStore,
  useFindMember,
  useHasPermission,
} from "../../store/communityStore";
import { useVoiceStore } from "../../store/voiceStore";

/**
 * 2.3 Canal de voz — grade de participantes, fala ativa, mute/deafen e
 * entrar/sair, com o compartilhamento de tela (2.4) como sub-modo.
 *
 * Abre **por cima** da área de conteúdo, sem trocá-la: entrar em voz não
 * muda o canal de texto que estava aberto (§4, C11). Recolher devolve a
 * barra persistente (2.3.1) sem encerrar a chamada.
 *
 * Esta tela monta a grade e o palco; os estados da chamada estão em
 * `VoiceCallBanners`, os botões em `VoiceControlBar`, a fila em `FilaKaraokê`
 * e os controles rápidos de música em `MusicaQuickControls`.
 */
export function VoiceOverlay() {
  const findMember = useFindMember();
  const channelId = useVoiceStore((state) => state.channelId);
  const communityId = useVoiceStore((state) => state.communityId);
  const localId = useVoiceStore((state) => state.localId);
  const stage = useVoiceStore((state) => state.stage);
  const participants = useVoiceStore((state) => state.participants);
  const shares = useVoiceStore((state) => state.shares);
  const fixadoId = useVoiceStore((state) => state.fixadoId);
  const setExpanded = useVoiceStore((state) => state.setExpanded);
  const startShare = useVoiceStore((state) => state.startShare);
  // §16.4 (emenda de 2026-08-28) — a fila de karaokê e suas ações.
  const fila = useVoiceStore((state) => state.fila);
  const motivoDaFila = useVoiceStore((state) => state.motivoDaFila);
  const entrarNaFila = useVoiceStore((state) => state.entrarNaFila);
  const sairDaFila = useVoiceStore((state) => state.sairDaFila);
  const moderarFila = useVoiceStore((state) => state.moderarFila);

  const channel = useCommunityStore((state) =>
    channelId ? selectChannel(state, channelId) : undefined,
  );
  const community = useCommunityStore((state) =>
    selectCommunity(state, communityId),
  );
  const activeCommunityId = useCommunityStore(
    (state) => state.activeCommunityId,
  );
  const canShareScreen = useHasPermission(
    communityId ?? "",
    "voice_share_screen",
  );
  // §16.4 — quem comanda a fila é quem modera a voz (decisão da Fatia do modo de fala).
  const podeModerarFila = useHasPermission(
    communityId ?? "",
    "voice_mute_others",
  );
  // §17.4 (emenda de 2026-08-28) — espelho local do gate do modo de fala. É conselho de
  // UI; quem decide é o host, e o roster traz o estado final de volta. No modo fila o
  // titular da fila (§16.4) é quem desmuta — o mesmo estado que a UI exibe.
  const podeTransmitir = useCommunityStore((state) =>
    channelId ? selectCanTransmitIn(state, channelId, fila?.turn?.keyHex ?? null) : true,
  );

  const [profile, setProfile] = useState<{
    identityId: string;
    anchor: DOMRect;
  } | null>(null);
  const [choosingSource, setChoosingSource] = useState(false);
  const guard = useLeaveVoiceGuard();
  const isMobile = useIsMobile();

  // Foco entra na grade ao abrir e volta ao gatilho ao recolher. Sem dependências:
  // vale uma vez por abertura, que é a vida deste componente.
  const raiz = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const gatilho = document.activeElement;
    raiz.current?.focus();
    return () => {
      if (gatilho instanceof HTMLElement && gatilho.isConnected) gatilho.focus();
    };
  }, []);

  if (!channel || !community || !communityId || !localId) return null;

  const local = participants.find((p) => p.identityId === localId);
  const sharing = Boolean(local?.sharingScreen);
  const connecting = stage === "connecting";

  // §9, 2.3 — um peer que não conecta comigo mas conecta com os outros: a
  // chamada segue, e a interface diz de quem se trata em vez de deixar a
  // pessoa parecer calada (§11, B7).
  const unstable = participants.find(
    (p) => p.identityId !== localId && p.connectionToMe !== "ok",
  );
  const unstableName = unstable
    ? (findMember(communityId, unstable.identityId)?.displayName ?? "um peer")
    : null;

  /** Mobile: lista vertical compacta; acima de 4, carrossel horizontal. */
  const carousel = isMobile && participants.length > 4;

  // §9, 2.3.2 — uma câmera ligada já põe a grade inteira em 16:9.
  const algumaCamera = participants.some((p) => p.cameraOn);

  const palco = comporPalco({
    participantes: participants,
    transmissoes: shares.length,
    fixadoId,
  });
  const fixado = participants.find((p) => p.identityId === palco.fixadoId);
  const naGrade = participants.filter((p) => p.identityId !== palco.fixadoId);

  const tiles = connecting
    ? naGrade.map((participant) => (
        <VoiceTileSkeleton key={participant.identityId} compact={isMobile} />
      ))
    : naGrade.map((participant) => (
        <VoiceTile
          key={participant.identityId}
          communityId={communityId}
          participant={participant}
          isLocal={participant.identityId === localId}
          compact={isMobile || palco.temPalco}
          widescreen={algumaCamera}
          onOpenProfile={(identityId, anchor) =>
            setProfile({ identityId, anchor })
          }
        />
      ));

  return (
    /*
      Região nomeada e focável.

      A grade tapa a área de conteúdo e o canal de baixo fica `inert` enquanto ela
      existe (ver `ChannelView`). Duas consequências que só o foco resolve: quem
      abriu a grade a partir de um controle do canal perderia o foco para o
      `<body>` no instante em que o `inert` valesse, e quem usa leitor de tela não
      teria como saber que a área de conteúdo trocou de dono. O `ref` abaixo põe o
      foco aqui ao abrir e o devolve ao gatilho ao recolher — o mesmo caminho que
      o `Popover` de §6 já usa.
    */
    <div
      ref={raiz}
      tabIndex={-1}
      role="region"
      aria-label={`Chamada em ${channel.name}`}
      className="absolute inset-0 z-30 flex flex-col bg-surface-primary outline-none"
    >
      {/* `px-4`: a grade abre POR CIMA da área de conteúdo, e o cabeçalho dela
          substitui visualmente o do canal. Com `px-3` o conteúdo do cabeçalho
          escorregava 4px ao expandir e voltava ao recolher. */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border-subtle px-4">
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className={cn(
            "-ml-2 grid size-8 shrink-0 place-items-center rounded-md",
            "text-text-secondary transition-colors duration-(--duration-fast) ease-out",
            "hover:bg-surface-sidebar hover:text-text-primary",
          )}
        >
          {isMobile ? (
            <ChevronLeft size={20} strokeWidth={2} aria-hidden="true" />
          ) : (
            <ChevronDown size={20} strokeWidth={2} aria-hidden="true" />
          )}
          <span className="sr-only">Recolher chamada</span>
        </button>

        <Volume2
          size={20}
          strokeWidth={2}
          aria-hidden="true"
          className="shrink-0 text-text-tertiary"
        />
        <h2 className="min-w-0 truncate text-heading-3 text-text-primary">
          {channel.name}
        </h2>
        {/* Só quando a chamada é de outra comunidade — na própria seria
            informação redundante (mesma regra de 2.3.1). */}
        {communityId !== activeCommunityId && (
          <span className="min-w-0 truncate text-meta text-text-tertiary">
            · {community.name}
          </span>
        )}
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        <VoiceCallBanners unstableName={unstableName} />

        {/*
          §17.5 (2026-08-26) — o canal aceita **várias** transmissões ao mesmo tempo. Uma
          ocupa o palco inteiro; a partir de duas viram grade, que é o que a UX original
          pedia em §18 e que o teto de "exatamente 1 por canal" tinha cortado.

          O teto de duas colunas é deliberado: cada palco tem controles próprios e uma
          terceira coluna os espremeria abaixo do alvo de toque. Com 3+ a grade rola.
        */}
        {palco.temPalco && (
          <div
            className={cn(
              "flex min-h-0 flex-1 gap-2",
              palco.itensNoPalco === 1
                ? "flex-col"
                : "flex-col overflow-y-auto tablet:grid tablet:auto-rows-fr tablet:grid-cols-2 tablet:overflow-y-auto",
            )}
          >
            {shares.map((s) => (
              <ScreenShareStage
                key={s.sessionId === "" ? `propria:${s.presenterId}` : s.sessionId}
                communityId={communityId}
                share={s}
                isPresenter={s.presenterId === localId}
              />
            ))}

            {/*
              §9, 2.3.2 — o tile fixado divide a área grande com as transmissões, em vez
              de disputar um lugar nela: o contêiner acima já sabe fazer "um ocupa tudo,
              dois ou mais viram grade", e fixar é só mais um item.
            */}
            {fixado && (
              <ul className="flex min-h-0 flex-1 flex-col">
                <VoiceTile
                  key={fixado.identityId}
                  communityId={communityId}
                  participant={fixado}
                  isLocal={fixado.identityId === localId}
                  destaque
                  onOpenProfile={(identityId, anchor) =>
                    setProfile({ identityId, anchor })
                  }
                />
              </ul>
            )}
          </div>
        )}

        <ul
          className={cn(
            palco.temPalco
              ? // Tira de miniaturas ao lado do compartilhamento (§9, 2.4).
                "flex shrink-0 gap-2 overflow-x-auto"
              : carousel
                ? "flex gap-2 overflow-x-auto"
                : "flex flex-col gap-2 tablet:grid tablet:grid-cols-2 desktop:grid-cols-3",
          )}
        >
          {tiles}
        </ul>
      </div>

      <VoiceControlBar
        channel={channel}
        local={local}
        podeTransmitir={podeTransmitir}
        canShareScreen={canShareScreen}
        sharing={sharing}
        onChooseSource={() => setChoosingSource(true)}
        onLeave={guard.requestLeave}
      />

      {/* §16.4 (emenda de 2026-08-28) — a fila de karaokê, só em canal do modo fila. */}
      {channel.speechMode === "queue" && (
        <FilaKaraokê
          fila={fila}
          motivo={motivoDaFila}
          communityId={communityId}
          localId={localId}
          podeModerar={podeModerarFila}
          entrarNaFila={() => void entrarNaFila()}
          sairDaFila={() => void sairDaFila()}
          moderar={moderarFila}
          findMember={findMember}
        />
      )}

      <MusicaQuickControls />

      {profile && (
        <ProfilePopover
          communityId={communityId}
          identityId={profile.identityId}
          anchor={profile.anchor}
          onClose={() => setProfile(null)}
          inCall
        />
      )}

      {choosingSource && (
        <ShareSourceModal
          onClose={() => setChoosingSource(false)}
          onSelect={({ kind, quality, sourceId, audio }) => {
            setChoosingSource(false);
            startShare({ kind, quality, sourceId, audio });
          }}
        />
      )}

      <LeaveVoiceConfirm guard={guard} />
    </div>
  );
}
