/**
 * §86.9 B33/B34 — o encerramento da chamada com motivo (`voice.failed`, §15.5/§19.8).
 *
 * O que se afirma: `encerradaPeloHost` sem motivo é o encerramento limpo de sempre (a
 * chamada some da tela); com motivo, a chamada acaba **e o overlay fica**, porque o banner
 * de `stage:"failed"` é a única superfície que carrega o porquê; e um motivo já entregue
 * sobrevive ao `voice.revoked` do mesmo encerramento, que chega separado (§16.3 regra 1).
 *
 * Verificado por mutação: trocar o `motivo ?? state.motivoDaFalha` por `motivo` derruba o
 * último caso — que é exatamente o defeito de a chamada evaporar sem explicação.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { useVoiceStore } from "../../store/voiceStore";

const CANAL = {
  id: "ch-voz",
  communityId: "c1",
  name: "sala",
  type: "voice" as const,
  categoryId: "cat-1",
};

function entrar(): void {
  useVoiceStore.getState().configurarVoz(null);
  useVoiceStore.getState().join(CANAL as never, "eu");
  useVoiceStore.setState({ expanded: true });
}

describe("encerradaPeloHost — o motivo é o que não pode se perder", () => {
  beforeEach(() => {
    useVoiceStore.setState({ motivoDaFalha: null, expanded: false, channelId: null, stage: "connecting" });
  });

  it("sem motivo, a chamada some da tela — o encerramento limpo de sempre", () => {
    entrar();
    expect(useVoiceStore.getState().channelId).toBe(CANAL.id);

    useVoiceStore.getState().encerradaPeloHost();

    expect(useVoiceStore.getState().channelId).toBeNull();
    expect(useVoiceStore.getState().participants).toEqual([]);
    expect(useVoiceStore.getState().motivoDaFalha).toBeNull();
  });

  it("com motivo, a chamada acaba mas o overlay fica para mostrar o porquê", () => {
    entrar();

    useVoiceStore.getState().encerradaPeloHost("O canal desta chamada foi excluído.");

    const s = useVoiceStore.getState();
    expect(s.stage).toBe("failed");
    expect(s.motivoDaFalha).toBe("O canal desta chamada foi excluído.");
    // O banner vive dentro do overlay: zerar o canal o desmontaria e o motivo iria junto.
    expect(s.channelId).toBe(CANAL.id);
    expect(s.expanded).toBe(true);
    // A chamada em si acabou: ninguém mais na grade, nenhuma tela.
    expect(s.participants).toEqual([]);
    expect(s.shares).toEqual([]);
  });

  it("o `voice.revoked` do mesmo encerramento não apaga o motivo já entregue", () => {
    entrar();
    useVoiceStore.getState().encerradaPeloHost("Esta comunidade foi encerrada.");

    // Chega depois, sem motivo próprio — é a segunda metade do MESMO encerramento (§19.8).
    useVoiceStore.getState().encerradaPeloHost();

    expect(useVoiceStore.getState().stage).toBe("failed");
    expect(useVoiceStore.getState().motivoDaFalha).toBe("Esta comunidade foi encerrada.");
  });

  it("desliga câmera e tela ao ser encerrada pelo host (§VOZ-12)", () => {
    const desligarCam = vi.fn().mockResolvedValue(undefined);
    const pararTela = vi.fn().mockResolvedValue(undefined);
    useVoiceStore.getState().configurarCamera({ ligar: vi.fn(), desligar: desligarCam });
    useVoiceStore.getState().configurarTela({
      apresentar: vi.fn(),
      parar: pararTela,
      assistir: vi.fn(),
      definirQualidade: vi.fn(),
      definirCaptura: vi.fn(),
      perfilDeCaptura: vi.fn(),
    } as never);

    entrar();
    useVoiceStore.getState().encerradaPeloHost("Canal apagado");

    expect(desligarCam).toHaveBeenCalled();
    expect(pararTela).toHaveBeenCalled();
  });
});
