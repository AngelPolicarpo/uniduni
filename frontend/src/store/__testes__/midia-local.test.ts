/**
 * §17.2/§17.5 (emenda de 2026-09-06) — **o ciclo de vida da captura local**.
 *
 * O que se afirma: nenhuma captura desta máquina sobrevive ao fim da chamada, nem à troca
 * de canal, nem à reentrada. Câmera e tela são dispositivos do SO — a luz acesa e o
 * indicador de gravação são o que o usuário vê quando o produto esquece de fechá-los — e
 * "esquecer a referência" não fecha nada.
 *
 * Verificado por mutação: apagar o `portaDeTela?.parar()` de `leave` derruba o primeiro
 * caso; apagar os dois de `join` derruba o segundo; apagar o bloco de limpeza de
 * `retryJoin` derruba o terceiro e o quarto.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  useVoiceStore,
  type PortaDeCamera,
  type PortaDeMalha,
  type PortaDeTelaStore,
} from "../voiceStore";

const CANAL = {
  id: "ch-voz",
  communityId: "c1",
  name: "sala",
  type: "voice" as const,
  categoryId: "cat-1",
};
const OUTRO_CANAL = { ...CANAL, id: "ch-voz-2" };
const EU = "aa".repeat(32);

function portas() {
  const camera = { ligar: vi.fn(async () => ({ erro: null })), desligar: vi.fn(async () => undefined) };
  const tela = {
    apresentar: vi.fn(async () => ({ sessionId: "s1", sourceLabel: "Tela 1", comAudio: false })),
    parar: vi.fn(async () => undefined),
    assistir: vi.fn(async () => ({ erro: null })),
    definirQualidade: vi.fn(async () => true),
    definirCaptura: vi.fn(async (a: unknown) => a),
    perfilDeCaptura: vi.fn(() => ({ height: null, frameRate: null })),
  };
  const malha = {
    entrar: vi.fn(async () => undefined),
    sair: vi.fn(async () => undefined),
    mudarSelf: vi.fn(),
    definirMudo: vi.fn(),
    definirSurdo: vi.fn(),
    definirVolume: vi.fn(),
    definirMusica: vi.fn(async () => ({ erro: null })),
    definirVolumeMusica: vi.fn(),
    fluxosParaGravacao: vi.fn(() => []),
  };
  useVoiceStore.getState().configurarCamera(camera as unknown as PortaDeCamera);
  useVoiceStore.getState().configurarTela(tela as unknown as PortaDeTelaStore);
  useVoiceStore.getState().configurarVoz(malha as unknown as PortaDeMalha);
  return { camera, tela, malha };
}

/** Uma chamada de pé com câmera ligada, música tocando e a MINHA tela no ar. */
function comMidiaLigada(p: ReturnType<typeof portas>) {
  useVoiceStore.getState().join(CANAL as never, EU);
  useVoiceStore.setState({
    stage: "connected",
    musicaAtiva: true,
    shareSessionId: "s1",
    shares: [
      {
        sessionId: "s1",
        presenterId: EU,
        channelId: CANAL.id,
        viewerCount: 1,
        quality: "balanced",
        phase: "live",
        sourceLabel: "Tela 1",
        comAudio: false,
        motivoDaFalha: null,
        saude: [],
        oculto: false,
      },
    ],
    participants: [
      {
        identityId: EU,
        speaking: false,
        muted: false,
        deafened: false,
        cameraOn: true,
        sharingScreen: true,
        connectionToMe: "ok",
      },
    ],
  });
  // O `join` da montagem também para as capturas (é o que o segundo caso afirma); o que
  // cada `it` mede é a ação dele.
  p.camera.desligar.mockClear();
  p.tela.parar.mockClear();
}

describe("a captura local não sobrevive à chamada (§17.2/§17.5, 2026-09-06)", () => {
  beforeEach(() => {
    useVoiceStore.getState().configurarCamera(null);
    useVoiceStore.getState().configurarTela(null);
    useVoiceStore.getState().configurarVoz(null);
    useVoiceStore.setState({ shares: [], shareSessionId: null, musicaAtiva: false });
  });

  it("sair da chamada para a captura de tela, não só a da câmera", () => {
    const p = portas();
    comMidiaLigada(p);

    useVoiceStore.getState().leave();

    // As duas: a tela leva o áudio do sistema junto, e o indicador de gravação do SO fica
    // aceso sobre uma sessão que acabou.
    expect(p.camera.desligar).toHaveBeenCalled();
    expect(p.tela.parar).toHaveBeenCalled();
    expect(useVoiceStore.getState().channelId).toBeNull();
  });

  it("trocar de canal de voz mata a câmera e a tela do canal anterior", () => {
    const p = portas();
    comMidiaLigada(p);

    useVoiceStore.getState().join(OUTRO_CANAL as never, EU);

    expect(p.camera.desligar).toHaveBeenCalled();
    expect(p.tela.parar).toHaveBeenCalled();
    // E o estado da chamada nova nasce sem nada da anterior.
    expect(useVoiceStore.getState().shares).toEqual([]);
    expect(
      useVoiceStore.getState().participants.find((x) => x.identityId === EU)?.cameraOn,
    ).toBe(false);
  });

  it("a reentrada por epoch para as capturas — o transporte volta limpo, o store também", () => {
    const p = portas();
    comMidiaLigada(p);

    useVoiceStore.getState().retryJoin();

    expect(p.camera.desligar).toHaveBeenCalled();
    expect(p.tela.parar).toHaveBeenCalled();
    expect(p.malha.entrar).toHaveBeenCalled();
  });

  it("a reentrada apaga câmera, música e tela do estado — sem isso a tela mente", () => {
    const p = portas();
    comMidiaLigada(p);

    useVoiceStore.getState().retryJoin();

    const st = useVoiceStore.getState();
    // Nada disto volta sozinho: `malha.entrar` limpa o próprio estado (conexões fechadas,
    // vídeo local zerado, mistura encerrada) e nunca avisa o store.
    expect(st.musicaAtiva).toBe(false);
    expect(st.shares).toEqual([]);
    expect(st.shareSessionId).toBeNull();
    expect(st.participants.find((x) => x.identityId === EU)?.cameraOn).toBe(false);
    expect(st.participants.find((x) => x.identityId === EU)?.sharingScreen).toBe(false);
    // A chamada em si volta a tentar: a limpeza é da mídia, não da voz.
    expect(st.stage).toBe("connecting");
  });
});

describe("silenciar outro participante sai da máquina (§17.4 L-12, 2026-09-06)", () => {
  beforeEach(() => {
    useVoiceStore.getState().configurarVoz(null);
    useVoiceStore.setState({ participants: [] });
  });

  it("o clique chama `voice.muteParticipant` — pintar o ícone local não cala ninguém", () => {
    const mutarParticipante = vi.fn(async () => undefined);
    useVoiceStore.getState().configurarVoz({
      entrar: vi.fn(async () => undefined),
      sair: vi.fn(async () => undefined),
      mudarSelf: vi.fn(),
      definirMudo: vi.fn(),
      definirSurdo: vi.fn(),
      definirVolume: vi.fn(),
      definirMusica: vi.fn(async () => ({ erro: null })),
      definirVolumeMusica: vi.fn(),
      fluxosParaGravacao: vi.fn(() => []),
      mutarParticipante,
    } as unknown as PortaDeMalha);
    useVoiceStore.getState().join(CANAL as never, EU);

    const outro = "bb".repeat(32);
    useVoiceStore.getState().setParticipantMuted(outro, true);

    // O conselho de L-12 viaja pelo host, que marca o roster do alvo; o cliente dele lê
    // isso como imposição e corta a própria trilha.
    expect(mutarParticipante).toHaveBeenCalledWith(outro, true);
  });
});
