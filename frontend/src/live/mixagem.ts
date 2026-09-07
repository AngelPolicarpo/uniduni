// §17.5 (emenda de 2026-08-28) — a mixagem do Modo Música, isolada do resto da mídia.
//
// **Por que misturar AQUI e não enviar duas trilhas.** O `<audio>` por par toca a PRIMEIRA
// trilha de áudio do `MediaStream` que chega; uma segunda trilha num mesmo stream não é
// tocada. Adicionar trilha exigiria renegociação em toda a malha e um receptor novo em cada
// par — e a trilha de música herdaria o tratamento de "uma segunda mídia" em vez do slot de
// voz, que é o único sempre permitido, inclusive em caminho relayado. Misturar no remetente
// e substituir a trilha do microfone por `replaceTrack` resolve os três de uma vez: sem
// renegociação, mesmo slot, mesmos tickets (§17.5 item 4).
//
// **O mudo em dois níveis mora aqui** (§17.5 item 5): o mudo PRÓPRIO continua sendo
// `track.enabled = false` na trilha do MICROFONE — o grafo recebe silêncio do mic, e a
// música segue; o mute IMPOSTO (host/fila) desliga a trilha MISTURADA, que é a que sai.
// Quem coordena os dois é `MalhaDeVoz`; este módulo só montaria o grafo.

/**
 * O que o grafo expõe. `trilha` é a saída única (mic + sistema já somados) que substitui a
 * trilha do microfone em cada `RTCPeerConnection`.
 */
export interface Mixador {
  /** A trilha misturada — `null` enquanto o `AudioContext` não produziu saída. */
  readonly trilha: MediaStreamTrack | null;
  /** Entra com o STREAM de sistema (loopback). Trocar o stream reconstrói só essa perna. */
  definirSistema(stream: MediaStream): void;
  /** Tira a perna de sistema sem desmontar o grafo. */
  removerSistema(): void;
  /** Volume da música (0..1) — o slider da UI. A voz não passa por aqui. */
  definirGanhoSistema(g: number): void;
  /** Nível RMS 0..1 do que está SAINDO — insumo do medidor e do VAD (§, Fatia do VAD). */
  nivel(): number;
  /** Para o grafo e devolve os nós. Depois disto a instância não serve de novo. */
  encerrar(): void;
}

/** Fábrica de `AudioContext` — injetável para teste determinístico. */
export type FabricaDeAudio = () => AudioContext;

/**
 * Monta o grafo `mic → micGain → destino` + `sistema → sistemaGain → destino`. Retorna
 * `null` quando o ambiente não tem `AudioContext` (teste fora de navegador) — quem chama
 * trata como "música indisponível", nunca como falha de chamada.
 */
export function criarMixador(
  micStream: MediaStream,
  fabrica?: FabricaDeAudio,
): Mixador | null {
  const Ctor = globalThis.AudioContext;
  if (typeof Ctor !== "function" && fabrica === undefined) return null;
  const ctx = fabrica !== undefined ? fabrica() : new Ctor!();
  ctx.onstatechange = () => {
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => undefined);
    }
  };
  // Um contexto recém-criado pode nascer suspenso (sem ativação do usuário para
  // herdar) — e um grafo suspenso produz silêncio digital: nem música, nem mic
  // (a perna de voz passa pelo misturador enquanto ele existe). É a mesma ordem
  // que o estágio de ganho de entrada já dava (`voz.ts`), e pelo mesmo motivo.
  void ctx.resume().catch(() => undefined);

  const destino = ctx.createMediaStreamDestination();
  const ganhoMic = ctx.createGain();
  const fonteMic = ctx.createMediaStreamSource(micStream);
  fonteMic.connect(ganhoMic).connect(destino);

  let fonteSistema: MediaStreamAudioSourceNode | null = null;
  const ganhoSistema = ctx.createGain();

  // O analisador lê a SAÍDA, não uma entrada: é o que o ouvinte ouve de fato.
  const analisador = ctx.createAnalyser();
  analisador.fftSize = 512;
  destino.connect(analisador);
  const buffer = new Uint8Array(analisador.fftSize);

  const trilha = destino.stream.getAudioTracks()[0] ?? null;

  return {
    trilha,
    definirSistema(stream: MediaStream) {
      fonteSistema?.disconnect();
      fonteSistema = ctx.createMediaStreamSource(stream);
      fonteSistema.connect(ganhoSistema).connect(destino);
    },
    removerSistema() {
      fonteSistema?.disconnect();
      fonteSistema = null;
    },
    definirGanhoSistema(g: number) {
      ganhoSistema.gain.value = Math.max(0, Math.min(1, g));
    },
    nivel() {
      analisador.getByteTimeDomainData(buffer);
      let soma = 0;
      for (let i = 0; i < buffer.length; i++) {
        const v = (buffer[i]! - 128) / 128;
        soma += v * v;
      }
      return Math.sqrt(soma / buffer.length);
    },
    encerrar() {
      fonteSistema?.disconnect();
      fonteMic.disconnect();
      void ctx.close().catch(() => undefined);
    },
  };
}
