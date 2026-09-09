import { describe, expect, it, vi, beforeEach } from "vitest";
import { useVoiceStore } from "../../store/voiceStore";

describe("Fase 9 — Correções de Mídia e WebRTC", () => {
  beforeEach(() => {
    useVoiceStore.setState({
      channelId: null,
      communityId: null,
      localId: null,
      participants: [],
      cameraPendente: false,
      erroDeCamera: null,
      musicaAtiva: false,
      musicaErro: null,
      fila: null,
      motivoDaFila: null,
      selfMuted: false,
    });
  });

  describe("voiceStore.join — limpeza de estado entre salas", () => {
    it("trocar de canal via join zera musicaAtiva, musicaErro, fila e motivoDaFila da sala anterior", () => {
      // Simula sala anterior com música ativa e fila de karaokê aberta
      useVoiceStore.setState({
        channelId: "canal-antigo",
        communityId: "com-1",
        localId: "eu-123",
        stage: "connected",
        musicaAtiva: true,
        musicaErro: "erro-antigo",
        fila: {
          channelId: "canal-antigo",
          open: true,
          items: [{ keyHex: "peer-1", queuedAt: 100 }],
          turn: null,
        },
        motivoDaFila: "motivo-antigo",
      });

      // Usuário troca diretamente para o novo canal sem passar por leave()
      useVoiceStore.getState().join(
        { id: "canal-novo", communityId: "com-1", name: "Voz 2", speechMode: "free" } as any,
        "eu-123",
      );

      const estado = useVoiceStore.getState();
      expect(estado.channelId).toBe("canal-novo");
      expect(estado.musicaAtiva).toBe(false);
      expect(estado.musicaErro).toBeNull();
      expect(estado.fila).toBeNull();
      expect(estado.motivoDaFila).toBeNull();
    });
  });

  describe("voiceStore.aplicarRoster — mudo e anel de fala", () => {
    it("força speaking: false para participante mutado no roster", () => {
      useVoiceStore.setState({
        localId: "eu-123",
        participants: [
          {
            identityId: "peer-1",
            speaking: true,
            muted: false,
            deafened: false,
            cameraOn: false,
            sharingScreen: false,
            connectionToMe: "ok",
          },
        ],
      });

      // Host publica roster onde o participante foi mutado mas speaking veio true (in-flight)
      useVoiceStore.getState().aplicarRoster([
        { keyHex: "peer-1", muted: true, speaking: true } as any,
      ]);

      const peer = useVoiceStore.getState().participants.find((p) => p.identityId === "peer-1");
      expect(peer).toBeDefined();
      expect(peer?.muted).toBe(true);
      expect(peer?.speaking).toBe(false);
    });
  });

  describe("toggleCamera — proteção contra corrida com saída de chamada", () => {
    it("não liga a câmera se a chamada foi encerrada enquanto a porta estava ligando", async () => {
      let resolverPorta: ((res: { erro: string | null }) => void) | null = null;
      useVoiceStore.getState().configurarCamera({
        ligar: vi.fn(() => new Promise<{ erro: string | null }>((resolve) => { resolverPorta = resolve; })),
        desligar: vi.fn(async () => undefined),
      });

      useVoiceStore.setState({
        channelId: "canal-1",
        localId: "eu-123",
        participants: [{ identityId: "eu-123", cameraOn: false, connectionToMe: "ok", muted: false, deafened: false, speaking: false, sharingScreen: false }],
      });

      useVoiceStore.getState().toggleCamera();
      expect(useVoiceStore.getState().cameraPendente).toBe(true);

      // Usuário sai da chamada enquanto porta ligava
      useVoiceStore.getState().leave();
      expect(useVoiceStore.getState().channelId).toBeNull();

      // Porta de câmera resolve
      resolverPorta!({ erro: null });

      // Espera resolução
      await vi.waitFor(() => expect(useVoiceStore.getState().cameraPendente).toBe(false));
      expect(useVoiceStore.getState().participants.find((p) => p.identityId === "eu-123")?.cameraOn ?? false).toBe(false);
    });
  });
});
