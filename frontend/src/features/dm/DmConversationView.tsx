import { Fragment, useLayoutEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  Mic,
  MicOff,
  MoreVertical,
  Phone,
  PhoneOff,
  MonitorUp,
  MonitorX,
  Video,
  VideoOff,
} from "lucide-react";

import { Button } from "../../components/ui/Button";
import { Menu } from "../../components/ui/Menu";
import { Spinner } from "../../components/ui/Spinner";
import { StatusBanner } from "../../components/ui/StatusBanner";
import { cn } from "../../lib/cn";
import { MESSAGE_GROUP_WINDOW_MS } from "../../lib/format";
import { DmBloquearModal, DmEsquecerModal } from "./DmDialogs";
import { DmComposer } from "./DmComposer";
import { DmMessageRow } from "./DmMessageRow";
import { DmPeerLabel } from "./DmPeerLabel";
import { DmVideoPanel } from "./DmVideoPanel";
import {
  acoesDaConversa,
  acoesDeChamada,
  acoesDeVideo,
  composerDaConversa,
  faixaDeCamera,
  faixaDeChamada,
  faixaDeMicrofone,
  faixaDeTela,
  faixaDeSincronizacao,
  primeiraNaoLida,
} from "./dmRegras";
import {
  bloquearConversa,
  carregarMensagens,
  desbloquearConversa,
  esquecerConversa,
} from "../../live/dm";
import {
  chamar,
  definirMudo,
  desligar,
  desligarCamera,
  iniciarTela,
  ligarCamera,
  pararTela,
} from "../../live/dmVoz";
import { useDmCallStore } from "../../store/dmCallStore";
import { useDmStore } from "../../store/dmStore";
import { useIdentityStore } from "../../store/identityStore";
import { useSettingsStore } from "../../store/settingsStore";
import type { DmConversationItem } from "../../ipc/dto";

/**
 * A conversa aberta — cabeçalho, faixa de estado, mensagens e composer.
 *
 * A faixa de sincronização é **faixa, não modal**: a conversa continua legível nos sete
 * estados de §31.13, e um modal esconderia justamente o histórico que a pessoa abriu para
 * ler. O texto de cada estado está em `dmRegras.ts` — inclusive a igualdade entre
 * `unauthorized` e `peer-offline`, que é requisito de **L-28** e não descuido.
 */
/**
 * O divisor de "Novas mensagens" — o MESMO de §9 2.1, na mesma gramática do canal: régua
 * `feedback-danger` com o rótulo colado à esquerda. U-33 manda a conversa reusar a anatomia
 * de 2.1, e a lista dela nomeia este divisor.
 */
function DivisorDeNaoLidas() {
  return (
    <div className="mt-4 flex items-center px-4" role="separator">
      <span className="h-px flex-1 bg-feedback-danger" aria-hidden="true" />
      <span className="ml-2 rounded-sm bg-feedback-danger px-1.5 py-px text-caption text-text-on-accent">
        Novas mensagens
      </span>
    </div>
  );
}

export interface DmConversationViewProps {
  conversa: DmConversationItem;
  onBack: () => void;
  className?: string;
}

export function DmConversationView({ conversa, onBack, className }: DmConversationViewProps) {
  const detalhe = useDmStore((s) => s.detalhe);
  const carregada = useDmStore((s) => s.porConversa[conversa.conversationId]);
  const digitando = useDmStore((s) => s.digitando[conversa.conversationId] ?? false);

  // §31.15 — a chamada de dois. Uma conversa por vez ("voz é uma só", §15.4), então o
  // estado só vale para ESTA conversa quando é ela que está na chamada.
  const chamadaId = useDmCallStore((s) => s.conversationId);
  const chamadaEstado = useDmCallStore((s) => s.estado);
  const chamadaFalha = useDmCallStore((s) => s.falha);
  const chamadaMuda = useDmCallStore((s) => s.mudo);
  const cameraLigada = useDmCallStore((s) => s.cameraLigada);
  const erroDeCamera = useDmCallStore((s) => s.erroDeCamera);
  const erroDeMicrofone = useDmCallStore((s) => s.erroDeMicrofone);
  const telaLigada = useDmCallStore((s) => s.telaLigada);
  const erroDeTela = useDmCallStore((s) => s.erroDeTela);
  const daConversa = chamadaId === conversa.conversationId;

  const [menuAberto, setMenuAberto] = useState(false);
  const [menuTela, setMenuTela] = useState(false);
  const [bloquear, setBloquear] = useState(false);
  const [esquecer, setEsquecer] = useState(false);
  // B63(b) — o mudo desta conversa, preferência local deste aparelho.
  const conversaMuda = useSettingsStore((s) => s.dmMutedByConversation[conversa.conversationId] === true);
  const alternarMudoConversa = useSettingsStore((s) => s.setDmMuted);

  const rolagem = useRef<HTMLDivElement>(null);
  const mensagens = carregada?.mensagens ?? [];

  /**
   * A conversa nasce no fim, como qualquer canal de texto (§9, 2.1) — **e só volta para lá
   * quem já estava lá.**
   *
   * O efeito antigo rolava para o rodapé a qualquer variação de `mensagens.length`, e
   * "carregar mensagens anteriores" é exatamente isso: a página anterior entra no TOPO, o
   * comprimento cresce, e quem tinha subido para ler o histórico era arremessado de volta
   * ao fim — a única coisa que ele acabara de pedir para não fazer. U-33 nomeia o requisito
   * ao falar da recarga de `dm.reordered` ("o desenho precisa aguentá-la sem salto de
   * rolagem"), e ele vale igual aqui.
   *
   * A medida é a mesma do `MessageList` do canal, e ela é feita no **gesto de rolar**, não
   * depois do render: um efeito de layout já roda com a lista nova no DOM e mediria a
   * posição de depois — sempre "não está no fim" — em vez da intenção de quem rolou.
   */
  const PERTO_DO_FIM = 80;
  const noFim = useRef(true);
  function aoRolar(event: React.UIEvent<HTMLDivElement>) {
    const node = event.currentTarget;
    noFim.current = node.scrollHeight - node.scrollTop - node.clientHeight <= PERTO_DO_FIM;
  }
  useLayoutEffect(() => {
    const node = rolagem.current;
    if (node === null) return;
    if (noFim.current) node.scrollTop = node.scrollHeight;
  }, [mensagens.length]);

  /*
    U-33 — o divisor de "Novas mensagens", que a conversa herda da anatomia de 2.1.
    O corte vem do watermark de §31.12 (`query.dmMessages`, emenda de 2026-09-05) e está
    congelado na abertura pela store: abrir marca como lida logo em seguida, e um divisor
    que seguisse o watermark sumiria no mesmo quadro em que apareceu.
  */
  const corte = useDmStore((s) => s.cortes[conversa.conversationId]);
  const euHex = useIdentityStore((s) => s.identity?.publicKey ?? null);
  const idDaPrimeiraNova = primeiraNaoLida(mensagens, corte, euHex);

  const sync = detalhe?.sync ?? conversa.sync;
  const faixa = faixaDeSincronizacao(sync);
  const composer = composerDaConversa(conversa.state, sync);
  const acoes = acoesDaConversa(conversa.state);
  const acoesChamada = acoesDeChamada(conversa.state, daConversa ? chamadaEstado : "fora");
  const bannerChamada = faixaDeChamada(
    daConversa ? chamadaEstado : "fora",
    daConversa ? chamadaFalha : null,
  );
  const acoesVideo = acoesDeVideo(
    conversa.state,
    daConversa ? chamadaEstado : "fora",
    daConversa ? chamadaFalha : null,
  );
  const bannerCamera = faixaDeCamera(daConversa ? erroDeCamera : null);
  const bannerMicrofone = faixaDeMicrofone(daConversa ? erroDeMicrofone : null);
  const bannerTela = faixaDeTela(daConversa ? erroDeTela : null);
  const agora = Date.now();

  return (
    <div className={cn("flex min-w-0 flex-1 flex-col bg-surface-primary", className)}>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border-subtle px-3">
        {/* §16, Mobile: a conversa é a tela em foco, e voltar é a saída. */}
        <Button
          variant="icon"
          size="sm"
          onClick={onBack}
          aria-label="Voltar para a lista de conversas"
          className="tablet:hidden"
        >
          <ChevronLeft size={16} strokeWidth={2} aria-hidden="true" />
        </Button>

        <DmPeerLabel peer={conversa.peer} className="min-w-0 flex-1" />

        {/*
          §31.15 — chamar, atender, desligar e a câmera de §17.2. §15: item aparece só quando
          a ação existe naquele estado, e não há **nada** que ofereça relay: §17.7 pressupõe
          um terceiro, e numa dupla não existe (**L-29**).

          A tela entrou em §31.15 (emenda de 2026-09-03): numa dupla a estrela de §17.5 É a
          malha de dois. O que ela NÃO traz é o resto de §17.5 — não há contador de
          espectadores, não há perfil de qualidade e não há barra de saúde, porque nenhum
          deles existe com um espectador só.
        */}
        {acoesChamada.includes("chamar") && (
          <Button
            variant="icon"
            size="sm"
            onClick={() => void chamar(conversa.conversationId)}
            aria-label="Chamar"
            className="shrink-0"
          >
            <Phone size={16} strokeWidth={2} aria-hidden="true" />
          </Button>
        )}
        {acoesChamada.includes("atender") && (
          <Button
            variant="primary"
            size="sm"
            onClick={() => void chamar(conversa.conversationId)}
            className="shrink-0"
          >
            Atender
          </Button>
        )}
        {/*
          §9 (2.3.1) / **L-12** — o mudo do próprio microfone, e só ele. Não há ensurdecer
          (numa dupla é desligar), não há silenciar o outro (isso é moderação, e §31.15
          remove a moderação inteira) e não há volume por participante.
        */}
        {daConversa && chamadaEstado === "na-chamada" && (
          <Button
            variant="icon"
            size="sm"
            onClick={() => definirMudo(!chamadaMuda)}
            aria-label={chamadaMuda ? "Ligar o microfone" : "Desligar o microfone"}
            aria-pressed={chamadaMuda}
            className="shrink-0"
          >
            {chamadaMuda ? (
              <MicOff size={16} strokeWidth={2} aria-hidden="true" />
            ) : (
              <Mic size={16} strokeWidth={2} aria-hidden="true" />
            )}
          </Button>
        )}
        {/*
          §17.2 — a câmera na MESMA malha da voz. Ela aparece só com a chamada de pé porque a
          `RTCPeerConnection` só nasce quando o par atende (§31.15, consequência 1 / §99.13):
          antes disso não há a que anexar a trilha. Quem decide é `acoesDeVideo`.
        */}
        {acoesVideo.includes("camera") && (
          <Button
            variant="icon"
            size="sm"
            onClick={() => void (cameraLigada ? desligarCamera() : ligarCamera())}
            aria-label={cameraLigada ? "Desligar a câmera" : "Ligar a câmera"}
            aria-pressed={cameraLigada}
            className="shrink-0"
          >
            {cameraLigada ? (
              <VideoOff size={16} strokeWidth={2} aria-hidden="true" />
            ) : (
              <Video size={16} strokeWidth={2} aria-hidden="true" />
            )}
          </Button>
        )}
        {/*
          §31.15 — compartilhar a tela. Um botão, sem seletor de perfil: a adaptação de banda
          é do `transport-cc` da própria conexão, e oferecer `high`/`balanced`/`low` aqui
          prometeria um controle que não existe numa malha de dois.
        */}
        {acoesVideo.includes("tela") && (
          <div className="relative shrink-0">
            <Button
              variant="icon"
              size="sm"
              onClick={() => (telaLigada ? void pararTela() : setMenuTela((a) => !a))}
              aria-label={telaLigada ? "Parar de compartilhar a tela" : "Compartilhar a tela"}
              aria-pressed={telaLigada}
              {...(telaLigada ? {} : { "aria-haspopup": "menu" as const, "aria-expanded": menuTela })}
            >
              {telaLigada ? (
                <MonitorX size={16} strokeWidth={2} aria-hidden="true" />
              ) : (
                <MonitorUp size={16} strokeWidth={2} aria-hidden="true" />
              )}
            </Button>
            {/*
              §17.5 (emenda de 2026-09-03) — **o som é opt-in e nasce `false`**. Não há
              seletor de fonte aqui (o do sistema resolve isso), mas escolher levar o som da
              máquina não pode ser efeito colateral de clicar em "compartilhar": capturar o
              som de uma máquina é o tipo de coisa que ninguém deve descobrir depois. São dois
              itens em vez de um botão, e nenhum perfil de qualidade — §31.15 os remove.
            */}
            <Menu
              open={menuTela}
              onClose={() => setMenuTela(false)}
              items={[
                {
                  id: "tela",
                  label: "Compartilhar a tela",
                  onSelect: () => void iniciarTela({ kind: "screen", audio: false }),
                },
                {
                  id: "tela-som",
                  label: "Compartilhar a tela com o som",
                  onSelect: () => void iniciarTela({ kind: "screen", audio: true }),
                },
              ]}
            />
          </div>
        )}
        {acoesChamada.includes("desligar") && (
          <Button
            variant="icon"
            size="sm"
            onClick={() => void desligar()}
            aria-label="Desligar"
            className="shrink-0"
          >
            <PhoneOff size={16} strokeWidth={2} aria-hidden="true" />
          </Button>
        )}

        <div className="relative shrink-0">
          <Button
            variant="icon"
            size="sm"
            onClick={() => setMenuAberto((a) => !a)}
            aria-haspopup="menu"
            aria-expanded={menuAberto}
            aria-label="Ações da conversa"
          >
            <MoreVertical size={16} strokeWidth={2} aria-hidden="true" />
          </Button>
          {/*
            §15 — item aparece só quando a ação existe naquele estado; nada de
            desabilitado-mas-visível. `acoesDaConversa` é quem decide, e é o que o teste
            afirma.
          */}
          <Menu
            open={menuAberto}
            onClose={() => setMenuAberto(false)}
            items={[
              // B63(b) — como o mudo de canal: tira a conversa da conta do selo sem
              // avisar ninguém. Vale em qualquer estado visível (inclusive bloqueada).
              conversaMuda
                ? {
                    id: "reativar-notificacoes",
                    label: "Reativar notificações",
                    onSelect: () => alternarMudoConversa(conversa.conversationId, false),
                  }
                : {
                    id: "silenciar-conversa",
                    label: "Silenciar conversa",
                    onSelect: () => alternarMudoConversa(conversa.conversationId, true),
                  },
              ...(acoes.includes("desbloquear")
                ? [
                    {
                      id: "desbloquear",
                      label: "Desbloquear",
                      onSelect: () => void desbloquearConversa(conversa.conversationId),
                    },
                  ]
                : []),
              ...(acoes.includes("bloquear")
                ? [{ id: "bloquear", label: "Bloquear", onSelect: () => setBloquear(true) }]
                : []),
              ...(acoes.includes("esquecer")
                ? [
                    {
                      id: "esquecer",
                      label: "Esquecer conversa",
                      danger: true,
                      onSelect: () => setEsquecer(true),
                    },
                  ]
                : []),
            ]}
          />
        </div>
      </header>

      {faixa && <StatusBanner tone={faixa.tone}>{faixa.texto}</StatusBanner>}

      {/*
        §31.15 / **L-29** — o desfecho da chamada. O texto vem de `faixaDeChamada`, e o que
        ele **não** traz é a oferta de relay: o teste afirma a ausência, porque oferecer o
        caminho que §17.7 dá na comunidade seria prometer um terceiro que não existe.
      */}
      {bannerChamada && (
        <StatusBanner tone={bannerChamada.tone}>{bannerChamada.texto}</StatusBanner>
      )}

      {/*
        §20.1 — a câmera que o sistema recusou, em faixa PRÓPRIA. Emendá-la a
        `faixaDeChamada` colaria `TEXTO_CHAMADA_SEM_RELAY` num defeito de dispositivo e
        mandaria a pessoa procurar problema na rede.
      */}
      {bannerCamera && <StatusBanner tone={bannerCamera.tone}>{bannerCamera.texto}</StatusBanner>}
      {bannerMicrofone && <StatusBanner tone={bannerMicrofone.tone}>{bannerMicrofone.texto}</StatusBanner>}
      {bannerTela && <StatusBanner tone={bannerTela.tone}>{bannerTela.texto}</StatusBanner>}

      {/* §17.2/§31.15 — as imagens da chamada. Nunca mais que duas câmeras e uma tela. */}
      {daConversa && <DmVideoPanel peer={conversa.peer} />}

      {/*
        §31.4 — `kind` ou versão desconhecidos nesta conversa. As listas de §31.16.2 saem
        vazias enquanto a fonte não existir (§105.7), então a faixa diz o FATO e não
        enumera: um "kind desconhecido: —" seria pior do que a frase honesta.
      */}
      {detalhe?.partialInterpretation && (
        <StatusBanner tone="degraded">
          Parte desta conversa foi escrita por uma versão mais nova do aplicativo e não pode
          ser interpretada aqui. Escrever nela está suspenso.
        </StatusBanner>
      )}

      <div ref={rolagem} onScroll={aoRolar} className="min-h-0 flex-1 overflow-y-auto py-2">
        {carregada?.temMais && (
          <div className="flex justify-center py-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                void carregarMensagens(conversa.conversationId, carregada.cursorAnterior)
              }
            >
              Carregar mensagens anteriores
            </Button>
          </div>
        )}

        {/*
          §31.13 — a faixa foi descartada por `dm.reordered` e a reconsulta está em voo.
          Mostrar o carregando é o que impede a tela de exibir a história antiga com as
          mensagens novas penduradas no fim.
        */}
        {carregada?.recarregando && (
          <div className="flex items-center justify-center gap-2 py-3 text-meta text-text-tertiary">
            <Spinner />
            A ordem da conversa mudou. Recarregando…
          </div>
        )}

        {mensagens.map((m, i) => {
          const anterior = mensagens[i - 1];
          const nova = m.id === idDaPrimeiraNova;
          const agrupada =
            !nova &&
            anterior !== undefined &&
            anterior.author.key === m.author.key &&
            m.ts - anterior.ts < MESSAGE_GROUP_WINDOW_MS;
          return (
            <Fragment key={m.id}>
              {nova && <DivisorDeNaoLidas />}
              <DmMessageRow mensagem={m} agrupada={agrupada} agora={agora} />
            </Fragment>
          );
        })}
      </div>

      {digitando && (
        <p className="px-4 pb-1 text-caption text-text-tertiary" role="status">
          {conversa.peer.displayName} está digitando…
        </p>
      )}

      {/*
        §31.9 regra 1 — em `pending-out` o outro lado ainda não aceitou, logo não existe
        core dele, logo não existe `ack`: nada aqui aparece como entregue, e a faixa diz
        isso em vez de deixar todas as mensagens com "não entregue" sem explicação.
      */}
      {conversa.state === "pending-out" && (
        <p className="px-4 pb-2 text-caption text-text-tertiary">
          {conversa.peer.displayName} ainda não aceitou esta conversa. Até lá, nada aparece
          como entregue.
        </p>
      )}

      {composer.visivel ? (
        <DmComposer
          conversationId={conversa.conversationId}
          nomeDoPar={conversa.peer.displayName}
          desabilitado={!composer.habilitado}
          {...(composer.motivo !== undefined ? { motivo: composer.motivo } : {})}
        />
      ) : (
        <p className="px-4 pb-4 text-meta text-text-tertiary">
          {conversa.state === "blocked"
            ? "Você bloqueou esta conversa. Ela continua legível."
            : "Esta conversa é somente leitura."}
        </p>
      )}

      <DmBloquearModal
        open={bloquear}
        nomeDoPar={conversa.peer.displayName}
        onClose={() => setBloquear(false)}
        onConfirm={() => void bloquearConversa(conversa.conversationId)}
      />
      <DmEsquecerModal
        open={esquecer}
        nomeDoPar={conversa.peer.displayName}
        onClose={() => setEsquecer(false)}
        onConfirm={() => void esquecerConversa(conversa.conversationId)}
      />
    </div>
  );
}
