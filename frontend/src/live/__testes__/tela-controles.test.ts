/**
 * §17.5 / §87 — de quem é cada controle da tela.
 *
 * O que se afirma: o perfil de qualidade e a captura (resolução e taxa de quadros) são
 * comandos de **quem apresenta** e não saem da máquina de quem assiste; e o único controle
 * do espectador — ocultar o vídeo recebido — é **exibição local**: não fala com o host, não
 * toca a estrela e não pode alcançar a transmissão de ninguém.
 *
 * Verificado por mutação: remover o `if (share.presenterId !== localId) return;` de
 * `setQuality` derruba o caso do espectador, que é exatamente o defeito relatado — o
 * controle da transmissão alheia aparecendo para quem só assiste.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { useVoiceStore, type PortaDeTelaStore } from "../../store/voiceStore";

const CANAL = {
  id: "ch-voz",
  communityId: "c1",
  name: "sala",
  type: "voice" as const,
  categoryId: "cat-1",
};

const EU = "aa".repeat(32);
const OUTRO = "bb".repeat(32);

function portaFalsa() {
  const porta = {
    apresentar: vi.fn(async () => ({ sessionId: "s1", sourceLabel: "Tela 1", comAudio: false })),
    parar: vi.fn(async () => undefined),
    definirQualidade: vi.fn(async () => true),
    definirCaptura: vi.fn(async (a: { height: number | null; frameRate: number | null }) => a),
    perfilDeCaptura: vi.fn(() => ({ height: 1080, frameRate: 60 })),
  };
  useVoiceStore.getState().configurarTela(porta as unknown as PortaDeTelaStore);
  return porta;
}

/** Uma sessão de tela viva com o papel pedido, sem passar pela estrela real. */
function comTela(papel: "apresentador" | "espectador") {
  const porta = portaFalsa();
  useVoiceStore.getState().configurarVoz(null);
  useVoiceStore.getState().join(CANAL as never, EU);
  useVoiceStore.setState({
    shareSessionId: papel === "apresentador" ? "s1" : null,
    capturaDaTela: { height: 1080, frameRate: 60 },
    shares: [
      {
        sessionId: "s1",
        presenterId: papel === "apresentador" ? EU : OUTRO,
        channelId: CANAL.id,
        viewerCount: 1,
        quality: "balanced",
        phase: "live",
        sourceLabel: "",
        comAudio: false,
        motivoDaFalha: null,
        saude: [],
        oculto: false,
      },
    ],
  });
  /*
   * O `join` acima é MONTAGEM, não o que cada caso exercita — e ele legitimamente para a
   * captura da chamada anterior (a câmera e a tela não sobrevivem à troca de canal, §17.2 /
   * §17.5 A19). Sem limpar aqui, a chamada de `parar` da montagem seria contada como se
   * tivesse saído da ação sob teste. O que cada `it` afirma continua sendo sobre a ação.
   */
  for (const espiao of Object.values(porta)) espiao.mockClear();
  return porta;
}

describe("controles da tela — o que sai da máquina de quem transmite é de quem transmite", () => {
  beforeEach(() => {
    useVoiceStore.getState().configurarTela(null);
    useVoiceStore.setState({ shares: [], shareSessionId: null });
  });

  it("o apresentador define o perfil, e o estado só muda quando o host aceita", async () => {
    const porta = comTela("apresentador");

    useVoiceStore.getState().setQuality("high");
    await vi.waitFor(() => expect(porta.definirQualidade).toHaveBeenCalledWith("s1", "high"));

    expect(useVoiceStore.getState().shares[0]?.quality).toBe("high");
  });

  it("o host recusando deixa o rótulo como estava — nada de anunciar o que não vale", async () => {
    const porta = comTela("apresentador");
    porta.definirQualidade.mockResolvedValueOnce(false);

    useVoiceStore.getState().setQuality("low");
    await vi.waitFor(() => expect(porta.definirQualidade).toHaveBeenCalled());

    expect(useVoiceStore.getState().shares[0]?.quality).toBe("balanced");
  });

  it("o espectador não manda no envio alheio: qualidade e captura não saem da máquina dele", () => {
    const porta = comTela("espectador");

    useVoiceStore.getState().setQuality("high");
    useVoiceStore.getState().definirCaptura({ height: 480 });

    expect(porta.definirQualidade).not.toHaveBeenCalled();
    expect(porta.definirCaptura).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().shares[0]?.quality).toBe("balanced");
    expect(useVoiceStore.getState().capturaDaTela).toEqual({ height: 1080, frameRate: 60 });
  });

  // O menu de §87.9 aplica os três valores de uma vez; o teste fixa que **os três** saem,
  // porque um modo que só mudasse a captura mentiria o nome ("Leitura" sem a banda alta).
  it("um modo de transmissão resolve resolução, quadros e banda numa tacada", async () => {
    const porta = comTela("apresentador");

    // "Leitura" = 1080p · 15 fps · alta.
    useVoiceStore.getState().definirCaptura({ height: 1080, frameRate: 15 });
    useVoiceStore.getState().setQuality("high");

    await vi.waitFor(() => {
      expect(porta.definirCaptura).toHaveBeenCalledWith({ height: 1080, frameRate: 15 });
      expect(porta.definirQualidade).toHaveBeenCalledWith("s1", "high");
    });
  });

  it("a captura do apresentador guarda o que a FONTE entregou, não o que foi pedido", async () => {
    const porta = comTela("apresentador");
    // A fonte aproxima: pediram 480, ela entrega 486.
    porta.definirCaptura.mockResolvedValueOnce({ height: 486, frameRate: 60 });

    useVoiceStore.getState().definirCaptura({ height: 480 });
    await vi.waitFor(() =>
      expect(porta.definirCaptura).toHaveBeenCalledWith({ height: 480, frameRate: 60 }),
    );

    expect(useVoiceStore.getState().capturaDaTela).toEqual({ height: 486, frameRate: 60 });
  });

  it("ocultar o vídeo é local: alterna o estado e NÃO toca em nada da sessão", () => {
    const porta = comTela("espectador");

    useVoiceStore.getState().alternarVideoRecebido("s1");
    expect(useVoiceStore.getState().shares[0]?.oculto).toBe(true);

    useVoiceStore.getState().alternarVideoRecebido("s1");
    expect(useVoiceStore.getState().shares[0]?.oculto).toBe(false);

    // A afirmação inteira: nenhum comando saiu daqui. A `RTCPeerConnection` continua de pé,
    // o apresentador continua transmitindo e ninguém mais na sessão foi afetado.
    expect(porta.definirQualidade).not.toHaveBeenCalled();
    expect(porta.definirCaptura).not.toHaveBeenCalled();
    expect(porta.parar).not.toHaveBeenCalled();
    // E a sessão continua viva do lado de cá — ocultar não a encerra.
    expect(useVoiceStore.getState().shares[0]?.sessionId).toBe("s1");
    expect(useVoiceStore.getState().shares[0]?.phase).toBe("live");
  });

  it("ocultar morre com a transmissão — a próxima nasce visível", () => {
    comTela("espectador");
    useVoiceStore.getState().alternarVideoRecebido("s1");
    expect(useVoiceStore.getState().shares[0]?.oculto).toBe(true);

    useVoiceStore.getState().telaParou("s1");
    expect(useVoiceStore.getState().shares).toEqual([]);

    useVoiceStore
      .getState()
      .telaComecou({ sessionId: "s2", presenterKey: OUTRO, channelId: CANAL.id });
    expect(useVoiceStore.getState().shares[0]?.oculto).toBe(false);
  });

  // §17.5 (2026-08-26) — o canal aceita várias, e ocultar é **por sessão**.
  it("ocultar uma tela não diz nada sobre a outra", () => {
    comTela("espectador");
    const TERCEIRO = "cc".repeat(32);
    useVoiceStore
      .getState()
      .telaComecou({ sessionId: "s2", presenterKey: TERCEIRO, channelId: CANAL.id });
    expect(useVoiceStore.getState().shares).toHaveLength(2);

    useVoiceStore.getState().alternarVideoRecebido("s1");

    const [a, b] = useVoiceStore.getState().shares;
    expect(a?.oculto).toBe(true);
    expect(b?.oculto).toBe(false);
  });

  it("parar uma transmissão não encerra a outra do mesmo canal", () => {
    comTela("espectador");
    const TERCEIRO = "cc".repeat(32);
    useVoiceStore
      .getState()
      .telaComecou({ sessionId: "s2", presenterKey: TERCEIRO, channelId: CANAL.id });

    useVoiceStore.getState().telaParou("s1");

    const restantes = useVoiceStore.getState().shares;
    expect(restantes).toHaveLength(1);
    expect(restantes[0]?.sessionId).toBe("s2");
  });
});
