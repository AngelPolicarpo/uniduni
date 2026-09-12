import { useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2, VideoOff } from "lucide-react";

import { Avatar } from "../../components/ui/Avatar";
import { cn } from "../../lib/cn";
import { cameraLocal, cameraRecebida } from "../../live/cameraStreams";
import { telaDoApresentador, telaRecebida } from "../../live/telaStreams";
import { corDoPar, nomeComHandle, palcoDeVideo } from "./dmRegras";
import { useEscapeExitsFullscreen } from "../voice/screenShareHooks";
import { useDmCallStore } from "../../store/dmCallStore";
import { useIdentityStore } from "../../store/identityStore";
import type { DmPeerRef } from "../../ipc/dto";
import type { AvatarColor } from "../../domain/types";

/**
 * §17.2 — as duas imagens de uma chamada de dois.
 *
 * **Dois tiles, e nunca mais que dois.** Numa comunidade a grade de §9 (2.3) cresce com o
 * roster; aqui não há roster (§31.15) e não há terceiro possível, então a grade é fixa. Ela
 * também não tem tira de miniaturas nem seletor de quem está em foco: os dois são superfície
 * de uma chamada com mais de duas pessoas.
 *
 * **A tela, quando existe, ocupa o palco e as câmeras viram miniaturas.** §31.15 (emenda de
 * 2026-09-03) traz a tela para a DM sem sessão, sem espectadores e sem perfil de qualidade —
 * então não há aqui contador de audiência, seletor de perfil nem barra de saúde. O que a UI
 * mostra é o que existe: uma imagem grande e duas pequenas.
 *
 * O `MediaStream` mora fora do React (`live/cameraStreams`), como na comunidade: reatribuir
 * `srcObject` a cada render pisca a imagem, e um `useState` o perderia na remontagem. O que
 * atravessa o store é `videoSeq`, a ordem de ir buscá-lo de novo.
 */
export interface DmVideoPanelProps {
  peer: DmPeerRef;
  className?: string;
}

export function DmVideoPanel({ peer, className }: DmVideoPanelProps) {
  const cameraLigada = useDmCallStore((s) => s.cameraLigada);
  const parComCamera = useDmCallStore((s) => s.parComCamera);
  const telaLigada = useDmCallStore((s) => s.telaLigada);
  const parComTela = useDmCallStore((s) => s.parComTela);
  const videoSeq = useDmCallStore((s) => s.videoSeq);
  const meuPerfil = useIdentityStore((s) => s.identity);
  const minhaCor = meuPerfil?.avatarColor;
  const [cheia, setCheia] = useState(false);
  // A mesma saída do palco da comunidade: sem ela, sair da tela cheia dependia de achar
  // o botão, e `Esc` é o que o resto do sistema usa.
  useEscapeExitsFullscreen(cheia, () => setCheia(false));

  // A transmissão acabou com a tela cheia aberta: sem isto o `cheia` ficava ligado e a
  // PRÓXIMA tela compartilhada abriria em tela cheia sozinha, sem ninguém ter pedido.
  const temTela = telaLigada || parComTela;
  useEffect(() => {
    if (!temTela) setCheia(false);
  }, [temTela]);

  // Sem imagem de lado nenhum o painel não existe: uma chamada só de voz não precisa de
  // caixas pretas ocupando a conversa que a pessoa abriu para ler.
  if (!cameraLigada && !parComCamera && !telaLigada && !parComTela) return null;

  // Quem ocupa o palco e se o som toca: decidido em `dmRegras`, onde o teste alcança
  // (§107.1). Um `muted` fixo no JSX já tornou o m-line 3 inaudível uma vez.
  const palco = palcoDeVideo({ telaLigada, parComTela });

  const rotuloDaTela =
    palco.tela === "par" ? `Tela de ${peer.displayName}` : "Sua tela";

  return (
    <div
      className={cn(
        "flex shrink-0 flex-col gap-2 border-b border-border-subtle p-2",
        /*
          Altura fixa **só com a tela no palco**, que é o caso quebrado. Sem ela, a caixa
          da tela era dimensionada pela proporção 16:9 sobre a largura do conteúdo: numa
          janela de 1128px ela sozinha pedia ~630px de altura e, com as miniaturas, o
          painel passava de 800px. Como ele é `shrink-0` e a lista de mensagens é
          `flex-1 min-h-0`, quem cedia era a lista — a conversa que a pessoa abriu para
          ler encolhia a zero atrás do vídeo. Para ver grande existe a tela cheia abaixo.

          `h-` e não `max-h-`: o palco é `flex-1` e a caixa dele não tem altura intrínseca
          (a imagem é `object-contain` dentro dela), então sem altura declarada no
          contêiner o `flex-1` não teria o que preencher.

          Só com câmeras o painel continua como era — duas caixas 16:9 lado a lado, ~330px
          numa janela de 1128px de conteúdo. Aquilo não estava quebrado.
        */
        palco.tela !== null && "h-[45vh]",
        className,
      )}
    >
      {palco.tela !== null && (
        <div className="relative flex min-h-0 flex-1">
          <DmVideoTile
            rotulo={rotuloDaTela}
            tipo="tela"
            ativo
            avatarColor={peer.avatarColor}
            nome={peer.displayName}
            obterStream={palco.tela === "par" ? () => telaRecebida(peer.key) : telaDoApresentador}
            seq={videoSeq}
            comSom={palco.comSom}
            // A tela vai INTEIRA: `object-contain`. Recortar para preencher esconderia
            // justamente as bordas, que é onde moram menus e barras de ferramentas.
            inteira
            tamanho="preencher"
            /*
              §2.4 lista "expandir pra tela cheia" entre as ações do compartilhamento, e a
              DM não estava na tabela de remoções de §31.15 — o que ela remove é audiência,
              perfil de qualidade e saúde. Sem isto, uma tela compartilhada numa conversa só
              podia ser vista na faixa acima das mensagens, e não havia como aumentá-la.
            */
            aoExpandir={() => setCheia(true)}
          />
        </div>
      )}

      {/*
        Com a tela no palco as câmeras são miniatura — tira à esquerda, altura fixa e
        largura derivada da proporção. Sem ela, são o conteúdo e dividem o painel.

        Eram `grid-cols-4` com dois filhos: as duas caixas ficavam no quarto esquerdo e
        metade da fileira sobrava vazia à direita.
      */}
      <div
        className={cn(
          "shrink-0 gap-2",
          palco.tela !== null ? "flex h-20" : "grid grid-cols-2",
        )}
      >
        <DmVideoTile
          rotulo="Você"
          ativo={cameraLigada}
          avatarColor={minhaCor ?? peer.avatarColor}
          nome="Você"
          // A própria imagem vai espelhada e MUDA: espelhar é o que faz o gesto bater com o que
          // a pessoa vê, e o áudio do próprio microfone voltando seria eco.
          espelhada
          obterStream={cameraLocal}
          seq={videoSeq}
          tamanho={palco.tela !== null ? "miniatura" : "proporcao"}
        />
        <DmVideoTile
          rotulo={nomeComHandle(peer)}
          ativo={parComCamera}
          avatarColor={peer.avatarColor}
          nome={peer.displayName}
          obterStream={() => cameraRecebida(peer.key)}
          seq={videoSeq}
          tamanho={palco.tela !== null ? "miniatura" : "proporcao"}
        />
      </div>

      {cheia && palco.tela !== null && (
        <div className="fixed inset-0 z-50 flex flex-col gap-2 bg-surface-app p-4">
          <DmVideoTile
            rotulo={rotuloDaTela}
            tipo="tela"
            ativo
            avatarColor={peer.avatarColor}
            nome={peer.displayName}
            obterStream={palco.tela === "par" ? () => telaRecebida(peer.key) : telaDoApresentador}
            seq={videoSeq}
            comSom={palco.comSom}
            inteira
            tamanho="preencher"
            cheia
            aoExpandir={() => setCheia(false)}
          />
        </div>
      )}
    </div>
  );
}

interface DmVideoTileProps {
  rotulo: string;
  nome: string;
  ativo: boolean;
  /**
   * O que a caixa mostra. Só existe para o rótulo acessível: com `"camera"` fixo, a
   * caixa da tela se anunciava como "Câmera de Tela de Bruno".
   */
  tipo?: "camera" | "tela";
  /**
   * Como a caixa é dimensionada: pela proporção 16:9 sobre a largura (`proporcao`), pelo
   * espaço que recebe (`preencher`) ou pela altura da tira, com a largura saindo da
   * proporção (`miniatura`).
   */
  tamanho?: "proporcao" | "preencher" | "miniatura";
  /** Está em tela cheia — o botão passa a reduzir. */
  cheia?: boolean;
  /** Quando presente, a caixa oferece expandir/reduzir (duplo clique e botão). */
  aoExpandir?: () => void;
  avatarColor: number | AvatarColor;
  espelhada?: boolean;
  /** Tela vai inteira (`contain`); câmera preenche (`cover`). */
  inteira?: boolean;
  /**
   * O `<video>` toca o áudio que vier junto. Só a tela do PAR: a câmera não leva som (a voz
   * é o m-line 0, e quem a toca é o `<audio>` de `dmVoz`), e a minha própria tela tocaria
   * de volta o que estou transmitindo.
   *
   * Numa DM não há ensurdecer nem volume por participante — os dois são superfície de uma
   * chamada com mais de duas pessoas (§31.15) —, então o que resta é o volume geral desta
   * máquina, que o elemento já respeita.
   */
  comSom?: boolean;
  obterStream: () => MediaStream | null;
  seq: number;
}

function DmVideoTile({
  rotulo,
  nome,
  ativo,
  tipo = "camera",
  tamanho = "proporcao",
  cheia = false,
  aoExpandir,
  avatarColor,
  espelhada = false,
  inteira = false,
  comSom = false,
  obterStream,
  seq,
}: DmVideoTileProps) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    if (!ativo) {
      // Soltar o `srcObject` é o que de fato para a decodificação; esconder por CSS
      // continuaria pintando quadro a quadro para ninguém.
      el.srcObject = null;
      return;
    }
    const stream = obterStream();
    if (stream === null) return;
    // Reatribuir o MESMO stream reinicia a decodificação e pisca a imagem.
    if (el.srcObject !== stream) el.srcObject = stream;
    void el.play().catch(() => undefined);
    // `obterStream` é recriada a cada render e não entra nas dependências de propósito: o
    // que diz "há stream novo" é `seq`, e incluí-la faria o efeito rodar a cada render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ativo, seq]);

  // Desmontar solta o stream, em efeito próprio: juntá-lo ao de cima faria a limpeza rodar a
  // cada troca de dependência, e um `srcObject` que vai a `null` e volta pisca a imagem.
  useEffect(() => {
    const el = ref.current;
    return () => {
      if (el !== null) el.srcObject = null;
    };
  }, []);

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md bg-surface-app",
        tamanho === "preencher"
          ? "size-full min-h-0"
          : tamanho === "miniatura"
            ? "aspect-video h-full shrink-0"
            : "aspect-video",
      )}
      onDoubleClick={aoExpandir}
    >
      {ativo ? (
        <video
          ref={ref}
          autoPlay
          playsInline
          muted={!comSom}
          className={cn(
            "size-full",
            inteira ? "object-contain" : "object-cover",
            espelhada && "-scale-x-100",
          )}
          // `rotulo` já diz de quem e do quê ("Tela de Bruno", "Você"): prefixar "Câmera
          // de" fazia a caixa da tela se anunciar como "Câmera de Tela de Bruno".
          aria-label={tipo === "tela" ? rotulo : `Câmera de ${rotulo}`}
        />
      ) : (
        <div className="grid size-full place-items-center gap-1">
          <Avatar
            name={nome}
            color={typeof avatarColor === "number" ? corDoPar(avatarColor) : avatarColor}
            size="md"
          />
          <span className="flex items-center gap-1 text-meta text-text-tertiary">
            <VideoOff size={12} strokeWidth={2} aria-hidden="true" />
            Câmera desligada
          </span>
        </div>
      )}
      <span className="absolute bottom-1 left-1 max-w-[90%] truncate rounded-sm bg-surface-app/80 px-1 text-meta text-text-secondary">
        {rotulo}
      </span>

      {/* O duplo clique acima é de ponteiro; §19.4 exige o caminho equivalente. */}
      {aoExpandir && (
        <button
          type="button"
          onClick={aoExpandir}
          aria-label={cheia ? "Reduzir" : "Ver em tela cheia"}
          className={cn(
            "absolute top-1 right-1 grid size-8 place-items-center rounded-md",
            "bg-surface-app/80 text-text-secondary",
            "transition-colors duration-(--duration-fast) ease-out",
            "hover:bg-surface-elevated hover:text-text-primary",
          )}
        >
          {cheia ? (
            <Minimize2 size={16} strokeWidth={2} aria-hidden="true" />
          ) : (
            <Maximize2 size={16} strokeWidth={2} aria-hidden="true" />
          )}
        </button>
      )}
    </div>
  );
}
