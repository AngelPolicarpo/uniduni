// Épico 4 — gravação LOCAL do canal (§17.2: mídia nunca toca o núcleo, então gravação é
// assunto do renderer). O que se grava é o que ESTA máquina ouve: os streams de áudio de
// cada par + o próprio microfone, somados num destino único do Web Audio e codificados
// pelo MediaRecorder em Opus/WebM.
//
// **Local é a palavra.** A gravação não sobe, não sinaliza, não consulta o host — e é por
// isso que a UI a trata como escolha pessoal visível só a quem grava (o ícone na barra de
// controles), não como estado de chamada.

export interface GravadorDeCanal {
  /** Liga a captura sobre os streams dados. Chamar de novo reinicia limpo. */
  iniciar(streams: readonly MediaStream[]): void;
  /** Para e devolve o arquivo; `null` se nada foi gravado (sem trilhas, sem dados). */
  parar(): Promise<Blob | null>;
  /**
   * Descarta o gravador e **fecha o `AudioContext`**. Depois disto a instância não serve
   * de novo — é o fim de vida, não uma pausa.
   *
   * `parar()` sozinho não bastava: ele encerra o `MediaRecorder` e deixa de pé o contexto,
   * o destino e uma `MediaStreamSource` por par. Um contexto de áudio é recurso do
   * processo (thread de renderização, buffers), e o navegador limita quantos existem por
   * documento — acumulá-los é o vazamento que só aparece depois de algumas horas de uso.
   */
  encerrar(): Promise<void>;
  readonly gravando: boolean;
}

/** MediaRecorder precisa existir; fora do Electron (teste) ele pode não existir. */
export function gravacaoSuportada(): boolean {
  return typeof MediaRecorder !== "undefined" && typeof globalThis.AudioContext === "function";
}

export function criarGravadorDeCanal(): GravadorDeCanal | null {
  if (!gravacaoSuportada()) return null;
  const ctx = new AudioContext();
  // Gravar de um contexto suspenso é gravar silêncio — o mesmo defeito de
  // ativação que o misturador do Modo Música tinha (§17.5).
  void ctx.resume().catch(() => undefined);
  const destino = ctx.createMediaStreamDestination();
  const fontes: MediaStreamAudioSourceNode[] = [];
  let recorder: MediaRecorder | null = null;
  const partes: Blob[] = [];

  return {
    get gravando() {
      return recorder?.state === "recording";
    },

    iniciar(streams) {
      recorder?.stop();
      for (const f of fontes) f.disconnect();
      fontes.length = 0;
      partes.length = 0;
      let comAudio = false;
      for (const stream of streams) {
        if (stream.getAudioTracks().length === 0) continue;
        const fonte = ctx.createMediaStreamSource(stream);
        fonte.connect(destino);
        fontes.push(fonte);
        comAudio = true;
      }
      if (!comAudio) return;
      recorder = new MediaRecorder(destino.stream);
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) partes.push(ev.data);
      };
      recorder.start(1_000); // fatia de 1 s: parar devolve rápido e nada se perde
    },

    parar() {
      return new Promise((resolve) => {
        const r = recorder;
        if (r === null || r.state !== "recording") {
          resolve(null);
          return;
        }
        r.onstop = () => resolve(new Blob(partes, { type: r.mimeType || "audio/webm" }));
        r.stop();
      });
    },

    async encerrar() {
      if (recorder?.state === "recording") {
        // `stop()` sem esperar o `onstop` perderia a última fatia; quem chama isto costuma
        // querer o arquivo (fim de chamada com gravação em curso).
        await this.parar().catch(() => null);
      }
      recorder = null;
      for (const f of fontes) f.disconnect();
      fontes.length = 0;
      partes.length = 0;
      await ctx.close().catch(() => undefined);
    },
  };
}

/* ─── O gravador do processo ─────────────────────────────────────── */

/**
 * O gravador **não mora no React**, pela mesma razão que os `<audio>` da voz e os
 * `MediaStream` de tela não moram: ele possui recursos do processo (um `AudioContext`, um
 * `MediaRecorder`, uma fonte por par) que não sobrevivem a uma remontagem e não se
 * reconstroem sozinhos.
 *
 * O botão vivia em `VoiceControlBar`, que está dentro da grade expandida — e a grade
 * desmonta quando se recolhe a chamada para a barra persistente (§9, 2.3.1). Cada
 * recolhimento durante uma gravação abandonava o `AudioContext` aberto **e** perdia o
 * arquivo em silêncio: o botão voltava apagado, sem download nenhum.
 */
let gravador: GravadorDeCanal | null = null;

export function gravacaoEmCurso(): boolean {
  return gravador?.gravando === true;
}

/** Liga a gravação sobre os streams dados. `false` quando não há o que gravar. */
export function iniciarGravacao(streams: readonly MediaStream[]): boolean {
  if (streams.length === 0) return false;
  gravador ??= criarGravadorDeCanal();
  gravador?.iniciar(streams);
  return gravacaoEmCurso();
}

/** Para e devolve o arquivo, fechando o contexto: a próxima gravação nasce limpa. */
export async function pararGravacao(): Promise<Blob | null> {
  const g = gravador;
  if (g === null) return null;
  const blob = await g.parar().catch(() => null);
  gravador = null;
  await g.encerrar().catch(() => undefined);
  return blob;
}

/**
 * Fim de chamada: não há canal a gravar. O arquivo do que já foi capturado é perdido de
 * propósito — salvar sozinho um download que ninguém pediu seria surpresa, e a gravação é
 * do CANAL: sem chamada ela não continua.
 */
export function descartarGravacao(): void {
  const g = gravador;
  gravador = null;
  void g?.encerrar().catch(() => undefined);
}
