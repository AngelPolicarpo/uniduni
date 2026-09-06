/**
 * §17.2 no renderer — a câmera. O que dá para provar sem câmera e sem duas máquinas: que a
 * imagem vai para **todos** os pares da malha (e não para uma audiência autorizada, como a
 * tela de §17.5), que desligar tira a trilha *e* para o dispositivo, e que o ícone que o
 * outro lado vê só acende depois de haver imagem.
 *
 * O que NÃO é testado aqui porque não é daqui: se a imagem chega — isso é DTLS entre duas
 * máquinas, medido em uso real como a voz de §82 e a tela de §88.
 *
 * A captura, a malha e a porta entram injetadas; nada aqui toca em WebRTC de verdade.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CameraDaChamada, motivoDoErroDeCamera } from "../camera";
import type { FabricaDeCameraLocal, PortaDaMalhaDeCamera } from "../camera";
import { MalhaDeVoz } from "../voz";
import type { FabricaDeMidia, PortaDeVoz, TicketNoFio } from "../voz";
import { useVoiceStore, type PortaDeCamera, type PortaDeMalha } from "../../store/voiceStore";

const EU = "aa".repeat(32);
const PAR = "bb".repeat(32);
/** Chave MENOR que a minha: com ele, quem oferta primeiro é o outro lado. */
const PAR_MENOR = "01".repeat(32);

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
}

function ticket(a: string, b: string): TicketNoFio {
  return { sessionId: "s1", channelId: "ch", peerA: bytes(a), peerB: bytes(b), expiresAt: 9_000, sig: bytes("00") };
}

function trilha(kind: "video" | "audio" = "video", label = "Integrated Webcam"): MediaStreamTrack {
  return { kind, label, enabled: true, stop: vi.fn(), onended: null } as unknown as MediaStreamTrack;
}

function stream(tracks: MediaStreamTrack[], id = "cam-1"): MediaStream {
  return {
    id,
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
  } as unknown as MediaStream;
}

/* ─── A câmera, sozinha ──────────────────────────────────────────── */

function montarCamera(opts: { falha?: unknown; semVideo?: boolean } = {}) {
  const track = trilha();
  const midia = stream(opts.semVideo === true ? [trilha("audio")] : [track]);
  const malha: PortaDaMalhaDeCamera = {
    definirVideoLocal: vi.fn(async () => undefined),
    removerVideoLocal: vi.fn(async () => undefined),
  };
  const captura: FabricaDeCameraLocal = {
    capturar: vi.fn(async () => {
      if (opts.falha !== undefined) throw opts.falha;
      return midia;
    }),
  };
  const eventos = { aoEncerrarNaFonte: vi.fn() };
  return { camera: new CameraDaChamada(malha, captura, eventos), malha, captura, eventos, track, midia };
}

describe("§17.2 — a câmera é da malha", () => {
  it("ligar captura o dispositivo escolhido e entrega a trilha à malha", async () => {
    const { camera, malha, captura, track, midia } = montarCamera();

    const r = await camera.ligar("cam-usb");

    expect(captura.capturar).toHaveBeenCalledWith("cam-usb");
    expect(malha.definirVideoLocal).toHaveBeenCalledWith(track, midia);
    expect(camera.ligada).toBe(true);
    // O rótulo é o que o sistema diz, nunca inventado pela UI.
    expect(r.rotulo).toBe("Integrated Webcam");
  });

  it("desligar tira a trilha da malha E para o dispositivo", async () => {
    const { camera, malha, track } = montarCamera();
    await camera.ligar("default");

    await camera.desligar();

    // As duas metades: só a primeira deixaria a luz da câmera acesa; só a segunda deixaria
    // um m-line morto em cada conexão.
    expect(malha.removerVideoLocal).toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
    expect(camera.ligada).toBe(false);
    expect(camera.stream).toBeNull();
  });

  it("ligar com a câmera já ligada troca o dispositivo em vez de empilhar duas", async () => {
    const { camera, malha, track } = montarCamera();
    await camera.ligar("cam-1");

    await camera.ligar("cam-2");

    expect(track.stop).toHaveBeenCalled();
    expect(malha.removerVideoLocal).toHaveBeenCalledTimes(1);
    expect(malha.definirVideoLocal).toHaveBeenCalledTimes(2);
  });

  it("captura sem trilha de vídeo não vira câmera ligada", async () => {
    const { camera, malha } = montarCamera({ semVideo: true });
    await expect(camera.ligar("default")).rejects.toThrow();
    expect(malha.definirVideoLocal).not.toHaveBeenCalled();
    expect(camera.ligada).toBe(false);
  });

  /*
   * §17.2 (emenda de 2026-09-06, item 4) — uma captura que não vira transmissão é desfeita.
   *
   * A negociação pode falhar depois de `getUserMedia` ter aberto o dispositivo (par que
   * caiu, `replaceTrack` recusado). Quem chamou vê a exceção e desenha o erro — mas a luz da
   * câmera fica acesa e ninguém mais tem a referência para fechá-la.
   *
   * Verificado por mutação: tirar o `try/catch` de `ligar` derruba este caso.
   */
  it("a negociação que falha não deixa a câmera aberta atrás dela", async () => {
    const r = montarCamera();
    (r.malha.definirVideoLocal as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("replaceTrack recusado"),
    );

    await expect(r.camera.ligar("default")).rejects.toThrow();

    // O motivo sobe (o botão mostra o erro) E o dispositivo fecha.
    expect(r.track.stop).toHaveBeenCalled();
    expect(r.camera.ligada).toBe(false);
    expect(r.camera.stream).toBeNull();
  });

  it("a câmera que morre na fonte avisa — cabo puxado não é estado que a UI adivinhe", async () => {
    const { camera, eventos, track } = montarCamera();
    await camera.ligar("default");

    track.onended?.(new Event("ended"));

    expect(eventos.aoEncerrarNaFonte).toHaveBeenCalled();
  });
});

describe("motivoDoErroDeCamera — cada recusa pede uma ação diferente", () => {
  it("distingue permissão, dispositivo sumido e dispositivo ocupado", () => {
    expect(motivoDoErroDeCamera({ name: "NotAllowedError" })).toMatch(/não autorizou/i);
    expect(motivoDoErroDeCamera({ name: "NotFoundError" })).toMatch(/não está mais disponível/i);
    expect(motivoDoErroDeCamera({ name: "NotReadableError" })).toMatch(/em uso por outro/i);
  });

  it("erro que não é nenhum dos nomeados não vira frase inventada", () => {
    expect(motivoDoErroDeCamera(new Error("qualquer"))).toBe("Não foi possível ligar a câmera.");
  });
});

/* ─── A câmera dentro da malha ───────────────────────────────────── */

function pcFalso(): RTCPeerConnection {
  const senders: RTCRtpSender[] = [];
  /** §17.2 (emenda de 2026-09-03) — os m-lines reservados, na ordem normativa. */
  const tx: Array<{ kind: string; mid: string; sender: { track: MediaStreamTrack | null } }> = [];
  function criarTransceiver(kind: string) {
    const sender = {
      track: null as MediaStreamTrack | null,
      replaceTrack: vi.fn(async (t: MediaStreamTrack | null) => {
        sender.track = t;
      }),
      getParameters: vi.fn(() => ({ encodings: [{}] })),
      setParameters: vi.fn(async () => undefined),
    };
    const t = { kind, sender, receiver: { track: null }, mid: String(tx.length), direction: "sendrecv" };
    tx.push(t);
    senders.push(sender as unknown as RTCRtpSender);
    return t;
  }
  const pc = {
    connectionState: "new" as RTCPeerConnectionState,
    signalingState: "stable" as RTCSignalingState,
    remoteDescription: null as RTCSessionDescription | null,
    senders,
    tx,
    addTrack: vi.fn((track: MediaStreamTrack) => {
      const s = { track } as unknown as RTCRtpSender;
      senders.push(s);
      return s;
    }),
    addTransceiver: vi.fn((kind: string) => criarTransceiver(kind)),
    /**
     * §17.2 (emenda de 2026-09-03) — quem RESPONDE não cria transceiver: ele adota os que a
     * oferta trouxe. O duplo os materializa aqui, com os `mid` que o ofertante atribuiria.
     */
    getTransceivers: vi.fn(() => tx),
    /** O duplo do `setRemoteDescription` materializa os m-lines que a oferta trouxe. */
    materializarMLines: () => {
      if (tx.length === 0) for (const k of ["audio", "video", "video", "audio"]) criarTransceiver(k);
    },
    removeTrack: vi.fn(),
    getStats: vi.fn(async () => new Map()),
    close: vi.fn(),
    createOffer: vi.fn(async () => ({ type: "offer", sdp: "v=0" })),
    createAnswer: vi.fn(async () => ({ type: "answer", sdp: "v=0" })),
    setLocalDescription: vi.fn(async () => undefined),
    setRemoteDescription: vi.fn(async (d: RTCSessionDescriptionInit) => {
      pc.remoteDescription = d as RTCSessionDescription;
      pc.materializarMLines();
    }),
    addIceCandidate: vi.fn(async () => undefined),
    onicecandidate: null,
    ontrack: null,
    onconnectionstatechange: null,
    onsignalingstatechange: null,
    oniceconnectionstatechange: null,
    onicegatheringstatechange: null,
  };
  return pc as unknown as RTCPeerConnection;
}

/** A trilha que está no m-line 1 (câmera) daquela conexão — `null` quando vazio. */
function noMLineDaCamera(pc: RTCPeerConnection): MediaStreamTrack | null {
  return pc.getTransceivers()[1]?.sender.track ?? null;
}

function montarMalha(roster: string[]) {
  const criadas: RTCPeerConnection[] = [];
  const porta: PortaDeVoz = {
    join: vi.fn(async () => ({
      sessionId: "s1",
      roster: roster.map((k) => ({ keyHex: k })),
      iceServers: [],
      tickets: roster.map((k) => ticket(EU, k)),
    })),
    leave: vi.fn(async () => undefined),
    signal: vi.fn(async () => undefined),
  };
  const audio = [trilha("audio")];
  const midia: FabricaDeMidia = {
    capturar: vi.fn(async () => stream(audio, "voz")),
    conexao: vi.fn(() => {
      const pc = pcFalso();
      criadas.push(pc);
      return pc;
    }),
  };
  const eventos = {
    aoMudarPar: vi.fn(),
    aoChegarAudio: vi.fn(),
    aoChegarVideo: vi.fn(),
    aoFalhar: vi.fn(),
    aoSair: vi.fn(),
  };
  const malha = new MalhaDeVoz(porta, midia, eventos);
  return { malha, porta, criadas };
}

describe("§17.2 — a trilha de câmera na malha", () => {
  it("ligar a câmera põe a trilha no m-line 1 de TODOS os pares, SEM renegociar", async () => {
    const { malha, criadas, porta } = montarMalha([EU, PAR, PAR_MENOR]);
    await malha.entrar({ communityId: "c1", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 });
    // As ofertas iniciais saem por `void #ofertar`: esperar por elas antes de medir é o que
    // separa "a câmera renegociou" de "a entrada ainda estava terminando".
    await vi.waitFor(() => expect(porta.signal).toHaveBeenCalled());
    const ofertasAntes = criadas.map((pc) => (pc.createOffer as ReturnType<typeof vi.fn>).mock.calls.length);

    const cam = trilha();
    await malha.definirVideoLocal(cam, stream([cam]));

    /*
     * A câmera é malha, não estrela: não há audiência a filtrar, e quem está na chamada vê.
     *
     * Mas só **onde já há m-line**. Quem OFERTA cria os quatro no `#abrir`; quem responde
     * ainda não tem transceiver nenhum (§17.2, emenda de 2026-09-03: um `addTransceiver`
     * local não recebe m-line de oferta remota), e a trilha entra quando a oferta chega,
     * por `#adotarMLines`. Pôr a câmera num transceiver órfão é exatamente o defeito que
     * deixava aquele lado mudo.
     */
    const comMLine = criadas.filter((pc) => pc.getTransceivers().some((t) => t.mid !== null));
    expect(comMLine.length).toBeGreaterThan(0);
    for (const pc of comMLine) expect(noMLineDaCamera(pc)).toBe(cam);
    /*
     * §17.2 (emenda de 2026-09-03) — e **nenhuma oferta nova**. O m-line 1 já foi negociado
     * quando a conexão nasceu; antes disto, ligar a câmera custava um round-trip de SDP por
     * par da malha, e a guarda contra o segundo m-line dependia de nenhuma renegociação
     * correr no meio da varredura.
     */
    const ofertasDepois = criadas.map((pc) => (pc.createOffer as ReturnType<typeof vi.fn>).mock.calls.length);
    expect(ofertasDepois).toEqual(ofertasAntes);
  });

  it("quem ENTRA com a câmera já ligada recebe o vídeo na primeira oferta, sem renegociar", async () => {
    const { malha, criadas } = montarMalha([EU]);
    await malha.entrar({ communityId: "c1", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 });
    const cam = trilha();
    await malha.definirVideoLocal(cam, stream([cam]));

    // O host pareia os dois (§17.4) e publica o roster novo: é assim que alguém entra numa
    // chamada que já está em curso.
    malha.aplicarTickets([ticket(EU, PAR)], 0);
    malha.aplicarRoster([{ keyHex: EU }, { keyHex: PAR }]);

    const nova = criadas[criadas.length - 1]!;
    expect(noMLineDaCamera(nova)).toBe(cam);
    // A oferta sai DEPOIS das trilhas entrarem nos m-lines (`replaceTrack` é assíncrono, e
    // `addTrack` era síncrono) — daí a espera. E sai **uma vez**: a câmera já ligada viaja
    // na oferta inicial, sem renegociação.
    await vi.waitFor(() =>
      expect((nova.createOffer as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1),
    );
  });

  it("desligar ESVAZIA o m-line em vez de removê-lo — é o que torna o desligamento visível", async () => {
    const { malha, criadas } = montarMalha([EU, PAR]);
    await malha.entrar({ communityId: "c1", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 });
    const cam = trilha();
    await malha.definirVideoLocal(cam, stream([cam]));

    await malha.removerVideoLocal();

    for (const pc of criadas) {
      expect(noMLineDaCamera(pc)).toBeNull();
      // `removeTrack` derrubaria o m-line, e o outro lado veria a trilha **sumir** — que não
      // é observável. Vazio deixa a trilha dele em `muted`, que é.
      expect(pc.removeTrack).not.toHaveBeenCalled();
    }
  });

  it("a câmera não sobrevive à chamada: sair esquece a trilha", async () => {
    const { malha, criadas } = montarMalha([EU, PAR]);
    await malha.entrar({ communityId: "c1", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 });
    const cam = trilha();
    await malha.definirVideoLocal(cam, stream([cam]));
    await malha.sair();

    // Entrar de novo não pode ressuscitar a câmera da chamada anterior.
    await malha.entrar({ communityId: "c1", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 });
    const nova = criadas[criadas.length - 1]!;
    expect(noMLineDaCamera(nova)).toBeNull();
  });
});

describe("§17.2 — ofertas cruzadas, que só existem desde que há renegociação dos dois lados", () => {
  it("quem iniciaria ignora a oferta cruzada: a dele é que vale", async () => {
    const { malha, criadas } = montarMalha([EU, PAR]);
    await malha.entrar({ communityId: "c1", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 });
    const pc = criadas[0]!;
    // Eu sou o iniciador com PAR (aa… < bb…), e minha oferta está no ar.
    (pc as unknown as { signalingState: string }).signalingState = "have-local-offer";

    await malha.aplicarSinal({
      peerKey: PAR,
      ticketId: "t",
      sdp: JSON.stringify({ type: "offer", sdp: "v=0" }),
    });

    expect(pc.setRemoteDescription).not.toHaveBeenCalled();
    expect(pc.createAnswer).not.toHaveBeenCalled();
  });

  it("o outro lado desfaz a própria oferta, responde, e a reoferta sai quando assenta", async () => {
    const { malha, criadas, porta } = montarMalha([EU, PAR_MENOR]);
    await malha.entrar({ communityId: "c1", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 });
    const pc = criadas[0]!;
    (pc as unknown as { signalingState: string }).signalingState = "have-local-offer";

    await malha.aplicarSinal({
      peerKey: PAR_MENOR,
      ticketId: "t",
      sdp: JSON.stringify({ type: "offer", sdp: "v=0" }),
    });

    // Rollback, e só então a oferta que chegou.
    const locais = (pc.setLocalDescription as ReturnType<typeof vi.fn>).mock.calls;
    expect(locais.some((c) => (c[0] as RTCSessionDescriptionInit)?.type === "rollback")).toBe(true);
    expect(pc.setRemoteDescription).toHaveBeenCalled();
    expect(pc.createAnswer).toHaveBeenCalled();

    // O que a minha oferta levava não se perde: ela volta quando a negociação assenta.
    (porta.signal as ReturnType<typeof vi.fn>).mockClear();
    (pc as unknown as { signalingState: string }).signalingState = "stable";
    pc.onsignalingstatechange?.(new Event("signalingstatechange"));
    await vi.waitFor(() => expect(porta.signal).toHaveBeenCalled());
  });
});

/* ─── O botão, no store ──────────────────────────────────────────── */

const CANAL = {
  id: "ch-voz",
  communityId: "c1",
  name: "sala",
  type: "voice" as const,
  categoryId: "cat-1",
};

function entrarNaChamada(camera: PortaDeCamera, malha?: Partial<PortaDeMalha>) {
  useVoiceStore.getState().configurarVoz({
    entrar: async () => undefined,
    sair: async () => undefined,
    mudarSelf: vi.fn(),
    definirMudo: vi.fn(),
    definirSurdo: vi.fn(),
    definirVolume: vi.fn(),
    ...malha,
  } as PortaDeMalha);
  useVoiceStore.getState().configurarCamera(camera);
  useVoiceStore.getState().join(CANAL as never, EU);
}

function cameraLocalLigada(): boolean {
  const s = useVoiceStore.getState();
  return s.participants.find((p) => p.identityId === s.localId)?.cameraOn === true;
}

describe("§17.2/A25 — o ícone da câmera só acende depois de haver imagem", () => {
  beforeEach(() => {
    useVoiceStore.getState().configurarCamera(null);
    useVoiceStore.getState().configurarVoz(null);
  });

  it("ligar conta ao host DEPOIS da captura, nunca antes", async () => {
    const ordem: string[] = [];
    const mudarSelf = vi.fn((patch: { cameraOn?: boolean }) => {
      if (patch.cameraOn !== undefined) ordem.push(`setSelf:${String(patch.cameraOn)}`);
    });
    entrarNaChamada(
      {
        ligar: vi.fn(async () => {
          ordem.push("captura");
          return { erro: null };
        }),
        desligar: vi.fn(async () => undefined),
      },
      { mudarSelf },
    );

    useVoiceStore.getState().toggleCamera();
    await vi.waitFor(() => expect(cameraLocalLigada()).toBe(true));

    // A ordem é a própria regra: acender o ícone do outro lado antes de haver imagem é a
    // decoração que §85.2 tirou do mudo.
    expect(ordem).toEqual(["captura", "setSelf:true"]);
  });

  it("câmera negada pelo sistema não acende o botão, e diz por quê", async () => {
    const mudarSelf = vi.fn();
    entrarNaChamada(
      {
        ligar: vi.fn(async () => ({ erro: "O sistema não autorizou o acesso à câmera." })),
        desligar: vi.fn(async () => undefined),
      },
      { mudarSelf },
    );

    useVoiceStore.getState().toggleCamera();
    await vi.waitFor(() => expect(useVoiceStore.getState().cameraPendente).toBe(false));

    expect(cameraLocalLigada()).toBe(false);
    expect(useVoiceStore.getState().erroDeCamera).toMatch(/não autorizou/i);
    // Nada foi anunciado ao host: não houve câmera nenhuma.
    expect(mudarSelf).not.toHaveBeenCalledWith(expect.objectContaining({ cameraOn: true }));
  });

  it("um segundo clique enquanto a permissão está aberta não abre uma segunda captura", async () => {
    let liberar: (() => void) | null = null;
    const ligar = vi.fn(
      async () =>
        await new Promise<{ erro: string | null }>((resolve) => {
          liberar = () => resolve({ erro: null });
        }),
    );
    entrarNaChamada({ ligar, desligar: vi.fn(async () => undefined) });

    useVoiceStore.getState().toggleCamera();
    useVoiceStore.getState().toggleCamera();
    expect(ligar).toHaveBeenCalledTimes(1);

    liberar!();
    await vi.waitFor(() => expect(cameraLocalLigada()).toBe(true));
  });

  it("desligar é imediato e não espera ninguém — a trilha é desta máquina", async () => {
    const desligar = vi.fn(async () => undefined);
    entrarNaChamada({ ligar: vi.fn(async () => ({ erro: null })), desligar });
    useVoiceStore.getState().toggleCamera();
    await vi.waitFor(() => expect(cameraLocalLigada()).toBe(true));

    useVoiceStore.getState().toggleCamera();

    expect(cameraLocalLigada()).toBe(false);
    expect(desligar).toHaveBeenCalled();
  });

  it("sair da chamada apaga a câmera: a luz não sobrevive a ela", async () => {
    const desligar = vi.fn(async () => undefined);
    entrarNaChamada({ ligar: vi.fn(async () => ({ erro: null })), desligar });
    useVoiceStore.getState().toggleCamera();
    await vi.waitFor(() => expect(cameraLocalLigada()).toBe(true));

    useVoiceStore.getState().leave();

    expect(desligar).toHaveBeenCalled();
  });

  it("o roster do host não apaga a câmera de quem a possui", async () => {
    entrarNaChamada({ ligar: vi.fn(async () => ({ erro: null })), desligar: vi.fn(async () => undefined) });
    useVoiceStore.getState().toggleCamera();
    await vi.waitFor(() => expect(cameraLocalLigada()).toBe(true));

    // Roster publicado por outro motivo (alguém entrou), ainda sem o eco do `setSelf`.
    useVoiceStore.getState().aplicarRoster([{ keyHex: EU }, { keyHex: PAR, cameraOn: false }]);

    expect(cameraLocalLigada()).toBe(true);
  });

  it("a câmera de um par chega pela trilha, sem esperar o eco do roster", () => {
    entrarNaChamada({ ligar: vi.fn(async () => ({ erro: null })), desligar: vi.fn(async () => undefined) });
    useVoiceStore.getState().aplicarRoster([{ keyHex: EU }, { keyHex: PAR }]);

    useVoiceStore.getState().cameraDoParChegou(PAR);

    const dele = useVoiceStore.getState().participants.find((p) => p.identityId === PAR);
    expect(dele?.cameraOn).toBe(true);
  });
});
