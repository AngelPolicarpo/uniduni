import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { telaDoApresentador, telaRecebida } from "../../live/telaStreams";
import { useVoiceStore } from "../../store/voiceStore";

/**
 * Quanto tempo os controles ficam sobre a imagem depois do último movimento.
 *
 * Assistir é o modo normal desta tela, e o que se assiste está **debaixo** dos botões: o
 * chip de espectadores cobre o canto de cima, a fileira de ações cobre o de baixo, e nada
 * disso some. Numa apresentação de slides ou num editor, é justamente onde o conteúdo mora.
 *
 * Três segundos é o intervalo em que a mão parada já significa "estou vendo, não mexendo".
 */
const CONTROLES_SOMEM_EM_MS = 3_000;

export interface ShareVideoParams {
  videoRef: RefObject<HTMLVideoElement | null>;
  isPresenter: boolean;
  oculto: boolean;
  presenterId: string;
  phase: string;
  /** Volume que esta máquina deu a quem apresenta (§9, 2.3). */
  volume: number;
  /** §10, 3.1 (B47) — saída e volume GERAIS desta máquina. */
  outputId: string;
  outputVolume: number;
  /** §9 (2.3) — ensurdecimento local cala todo áudio entrante, incluindo tela alheia. */
  surdo?: boolean;
}

/**
 * Liga o `<video>` da transmissão ao que o sistema decidiu: a stream, o
 * volume e a saída de áudio (§17.5 · §10, 3.1 B47).
 */
export function useShareVideoElement({
  videoRef,
  isPresenter,
  oculto,
  presenterId,
  phase,
  volume,
  outputId,
  outputVolume,
  surdo,
}: ShareVideoParams) {
  // O aviso de que há `MediaStream` de tela novo ou atualizado fora do React.
  const telaSeq = useVoiceStore((state) => state.telaSeq);

  /**
   * O `MediaStream` mora fora do React (`live/telaStreams`): ele precisa sobreviver a
   * re-render, e um `srcObject` recriado a cada render pisca a imagem. O apresentador vê o
   * que captura; quem assiste vê o que chegou pela malha.
   */
  useEffect(() => {
    const el = videoRef.current;
    if (el === null) return;
    // §17.5 — quem assiste pode ocultar. Soltar o `srcObject` é o que de fato para a
    // decodificação e a pintura desta máquina; deixar o elemento escondido por CSS
    // continuaria decodificando quadro a quadro para ninguém.
    if (!isPresenter && oculto) {
      el.srcObject = null;
      return;
    }
    const stream = isPresenter ? telaDoApresentador() : telaRecebida(presenterId);
    if (stream === null) return;
    // Reatribuir o MESMO stream reinicia a decodificação e pisca a imagem — e este efeito
    // roda de novo a cada tela que entra na chamada ou a cada tick de telaSeq.
    if (el.srcObject !== stream) {
      el.srcObject = stream;
    }
    void el.play().catch(() => undefined);
  }, [videoRef, isPresenter, oculto, presenterId, phase, telaSeq]);

  /**
   * Desmontar solta o stream. Fica num efeito próprio, sem dependências dinâmicas,
   * porque juntá-lo ao de cima faria a limpeza rodar a cada troca de dependência — e
   * um `srcObject` que vai a `null` e volta no mesmo fôlego pisca a imagem ou
   * deixa a tela preta caso o stream esteja em transição.
   */
  useEffect(() => {
    const el = videoRef.current;
    return () => {
      if (el !== null) {
        el.srcObject = null;
      }
    };
  }, [videoRef]);

  // Propriedade do elemento, não atributo: `volume` não existe como prop do `<video>` e
  // um `srcObject` novo não a reaplica. O volume GERAL de saída (§10, 3.1, B47) multiplica
  // o volume por participante — é o que faz o slider de ajustes valer também para o som da
  // tela, que toca no `<video>` e não nos `<audio>` da voz.
  // Ensurdecer (§9, 2.3) ou ser o próprio apresentador zera o volume e ativa o muted imperativamente.
  useEffect(() => {
    const el = videoRef.current;
    if (el === null) return;
    const mutado = isPresenter || Boolean(surdo);
    el.muted = mutado;
    el.volume = mutado ? 0 : Math.max(0, Math.min(100, volume * (outputVolume / 100))) / 100;
  }, [videoRef, isPresenter, surdo, volume, outputVolume, phase]);

  // §10, 3.1 (B47) — a SAÍDA de áudio escolhida em ajustes vale para o som da tela também:
  // sem o `setSinkId`, o `<video>` tocava sempre no dispositivo padrão do sistema.
  useEffect(() => {
    const el = videoRef.current;
    if (el === null || typeof el.setSinkId !== "function") return;
    if ((el.dataset.sinkId ?? "default") === outputId) return;
    el.dataset.sinkId = outputId;
    void el.setSinkId(outputId === "default" ? "" : outputId).catch(() => undefined);
  }, [videoRef, outputId, phase]);
}

/**
 * Os controles somem sozinhos sobre a imagem e voltam ao primeiro gesto.
 *
 * `podeSumir` é a condição inteira: só há o que cobrir quando existe imagem, e
 * nunca enquanto um popover está aberto. `sobreControles` é `ref` e não estado
 * porque nada renderiza a partir dele — mirar um botão e hesitar não pode
 * fazê-lo sumir debaixo do cursor.
 */
export function useAutoHideControls(podeSumir: boolean) {
  const [controles, setControles] = useState(true);
  const relogio = useRef<number | undefined>(undefined);
  const sobreControles = useRef(false);

  const acordar = useCallback(() => {
    setControles(true);
    window.clearTimeout(relogio.current);
    if (!podeSumir || sobreControles.current) return;
    relogio.current = window.setTimeout(() => setControles(false), CONTROLES_SOMEM_EM_MS);
  }, [podeSumir]);

  // O relógio recomeça a cada mudança do que o torna possível: sair do popover ou a imagem
  // chegar precisa armá-lo, e o contrário precisa desarmá-lo na hora.
  useEffect(() => {
    acordar();
    return () => window.clearTimeout(relogio.current);
  }, [acordar]);

  return {
    controles,
    acordar,
    esconder: () => podeSumir && setControles(false),
    sobreControles,
  };
}

/**
 * §17.5 — sair da tela cheia pelo Esc. Sem isto o único jeito de voltar era achar o botão
 * "Reduzir", que é exatamente o que acabou de sumir com o resto dos controles: a pessoa
 * ficava presa numa tela sem saída visível, apertando a tecla que o resto do sistema
 * inteiro usa para isto.
 */
export function useEscapeExitsFullscreen(fullscreen: boolean, sair: () => void) {
  useEffect(() => {
    if (!fullscreen) return;
    const aoTeclar = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      sair();
    };
    window.addEventListener("keydown", aoTeclar, true);
    return () => window.removeEventListener("keydown", aoTeclar, true);
    // `sair` é estável na prática (setState); a dependência é o modo.
  }, [fullscreen, sair]);
}
