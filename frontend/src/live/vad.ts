// §17.6 (Fatia de ajustes de áudio) — VAD real: o campo `speaking` SEMPRE existiu no
// protocolo (`voiceState {speaking}`, `VoiceRoster`) e nunca era setado — o anel de fala
// dos tiles era decoração. Aqui nasce a medição: RMS da trilha do microfone, threshold
// ajustável ("sensibilidade" nas configurações) e a decisão de falar/calar.
//
// A CADÊNCIA é assunto do chamador (§17.6 limita o fio; o próprio módulo só mede): quem
// consulta `nivel()` num intervalo e compara com o threshold é o loop da sincronização.

export interface DetectorDeVoz {
  /** Nível RMS instantâneo 0..1 da trilha monitorada. */
  nivel(): number;
  /** Para o analisador. A trilha em si não é tocada — quem a possui é quem para. */
  encerrar(): void;
}

/**
 * Analisador de nível sobre `stream`. Sem WebAudio no ambiente (testes), devolve `null` —
 * "sem medição" nunca pode derrubar captura nenhuma.
 */
export function criarDetectorDeVoz(stream: MediaStream): DetectorDeVoz | null {
  const Ctor = globalThis.AudioContext;
  if (typeof Ctor !== "function") return null;
  const ctx = new Ctor();
  ctx.onstatechange = () => {
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => undefined);
    }
  };
  // Sem isto o analisador lê zeros num contexto suspenso e `speaking` nunca
  // acende — o mesmo silêncio que o misturador do Modo Música produzia (§17.5).
  void ctx.resume().catch(() => undefined);
  const fonte = ctx.createMediaStreamSource(stream);
  const analisador = ctx.createAnalyser();
  analisador.fftSize = 512;
  fonte.connect(analisador);
  const buffer = new Uint8Array(analisador.fftSize);

  return {
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
      fonte.disconnect();
      void ctx.close().catch(() => undefined);
    },
  };
}

/**
 * A comparação com histerese: fala começa acima de `threshold` e só termina abaixo de
 * `threshold * 0.6`. Sem isso, um nível perto do limpar pisca o anel e o campo `speaking`
 * vira ruído no fio — e cada virada é um `voiceState`.
 */
export function estaFalando(nivel: number, threshold: number, falandoAntes: boolean): boolean {
  if (falandoAntes) return nivel > threshold * 0.6;
  return nivel > threshold;
}
