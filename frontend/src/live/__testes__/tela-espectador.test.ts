/**
 * §17.5 do lado de QUEM ASSISTE — §94.
 *
 * Duas famílias de defeito, as duas do mesmo tipo: o produto sabia a coisa certa e a
 * aplicava no lugar errado.
 *
 * 1. **Classificar a trilha que chega.** Tela e câmera chegam iguais pela mesma conexão, e
 *    decidir por "existe transmissão viva deste par" classificava como tela a câmera de
 *    alguém cujo `share.join` tinha sido recusado — erro certo e permanente, não janela
 *    estreita.
 * 2. **Falar com a sessão certa.** `telaFalhou` e `retryShare` procuravam sempre a MINHA
 *    transmissão. Para quem assiste ela não existe: o motivo da recusa sumia e o botão
 *    "Tentar novamente" não fazia nada.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useVoiceStore, type PortaDeTelaStore } from "../../store/voiceStore";

const EU = "aa".repeat(32);
const OUTRO = "bb".repeat(32);

/*
 * §94.1 saiu daqui. A classificação de "tela ou câmera" deixou de ser heurística de quem
 * recebe: com o m-line 2 reservado (§17.2, emenda de 2026-09-03), a malha diz a origem, e
 * quem afirma isso é `voz.test.ts` — no ponto onde o `ontrack` decide. **B41 fechou.**
 */

/* ─── A sessão certa ─────────────────────────────────────────────── */

const CANAL = {
  id: "ch-voz",
  communityId: "c1",
  name: "sala",
  type: "voice" as const,
  categoryId: "cat-1",
};

function portaFalsa() {
  const porta = {
    apresentar: vi.fn(async () => ({ sessionId: "minha", sourceLabel: "Tela 1", comAudio: false })),
    parar: vi.fn(async () => undefined),
    assistir: vi.fn(async (_sessionId: string): Promise<{ erro: string | null }> => ({ erro: null })),
    definirQualidade: vi.fn(async () => true),
    definirCaptura: vi.fn(async (a: { height: number | null; frameRate: number | null }) => a),
    perfilDeCaptura: vi.fn(() => ({ height: 1080, frameRate: 60 })),
  };
  useVoiceStore.getState().configurarTela(porta as unknown as PortaDeTelaStore);
  return porta;
}

/** A transmissão de OUTRA pessoa, que eu estou tentando assistir. */
function telaDeOutro() {
  const porta = portaFalsa();
  useVoiceStore.getState().configurarVoz(null);
  useVoiceStore.getState().join(CANAL as never, EU);
  useVoiceStore.getState().telaComecou({
    sessionId: "dele",
    presenterKey: OUTRO,
    channelId: CANAL.id,
  });
  return porta;
}

function tela(sessionId: string) {
  return useVoiceStore.getState().shares.find((s) => s.sessionId === sessionId);
}

describe("§94.3 — a falha de quem assiste é da transmissão que ele assiste", () => {
  beforeEach(() => {
    useVoiceStore.getState().configurarTela(null);
    useVoiceStore.setState({ shares: [], shareSessionId: null });
  });

  it("entrada recusada marca a transmissão DAQUELE par, e o motivo aparece", () => {
    telaDeOutro();

    useVoiceStore.getState().telaFalhou("Só quem está na chamada pode assistir.", "dele");

    expect(tela("dele")?.phase).toBe("failed");
    expect(tela("dele")?.motivoDaFalha).toMatch(/só quem está na chamada/i);
  });

  it("sem id, a falha continua sendo a minha — o caminho de quem tentou apresentar", () => {
    const porta = portaFalsa();
    useVoiceStore.getState().configurarVoz(null);
    useVoiceStore.getState().join(CANAL as never, EU);
    useVoiceStore.getState().startShare({ quality: "balanced" });

    useVoiceStore.getState().telaFalhou("Não foi possível iniciar a transmissão.");

    const minha = useVoiceStore.getState().shares.find((s) => s.presenterId === EU);
    expect(minha?.phase).toBe("failed");
    expect(porta.apresentar).toHaveBeenCalled();
  });

  it("'Tentar novamente' de quem assiste repete o share.join, não a captura alheia", async () => {
    const porta = telaDeOutro();
    useVoiceStore.getState().telaFalhou("Não foi possível entrar na transmissão.", "dele");

    useVoiceStore.getState().retryShare("dele");

    await vi.waitFor(() => expect(porta.assistir).toHaveBeenCalledWith("dele"));
    // Capturar a tela de outra pessoa não é algo que este botão possa fazer.
    expect(porta.apresentar).not.toHaveBeenCalled();
    expect(tela("dele")?.phase).toBe("starting");
  });

  it("a recusa que volta no retry reaparece na tela, em vez de deixar 'Preparando…' para sempre", async () => {
    const porta = telaDeOutro();
    porta.assistir.mockResolvedValueOnce({ erro: "Você não pode mais assistir a esta transmissão." });

    useVoiceStore.getState().retryShare("dele");

    await vi.waitFor(() => expect(tela("dele")?.phase).toBe("failed"));
    expect(tela("dele")?.motivoDaFalha).toMatch(/não pode mais assistir/i);
  });

  it("'Tentar novamente' de quem apresenta continua repetindo a captura", async () => {
    const porta = portaFalsa();
    useVoiceStore.getState().configurarVoz(null);
    useVoiceStore.getState().join(CANAL as never, EU);
    useVoiceStore.getState().startShare({ quality: "high", kind: "window", sourceId: "janela-7" });
    await vi.waitFor(() => expect(porta.apresentar).toHaveBeenCalled());
    porta.apresentar.mockClear();

    useVoiceStore.getState().retryShare("minha");

    await vi.waitFor(() => expect(porta.apresentar).toHaveBeenCalled());
    // A MESMA fonte: tentar de novo repete o pedido inteiro, não "uma janela qualquer".
    expect(porta.apresentar).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "window", sourceId: "janela-7", quality: "high" }),
    );
    expect(porta.assistir).not.toHaveBeenCalled();
  });

  it("timeout de 10s transiciona transmissão em 'starting' para 'failed' (§17.5 / Lacuna 1)", async () => {
    vi.useFakeTimers();
    try {
      telaDeOutro();
      expect(tela("dele")?.phase).toBe("starting");

      vi.advanceTimersByTime(10_000);

      expect(tela("dele")?.phase).toBe("failed");
      expect(tela("dele")?.motivoDaFalha).toBe("A transmissão demorou muito para responder.");
    } finally {
      vi.useRealTimers();
    }
  });
});
