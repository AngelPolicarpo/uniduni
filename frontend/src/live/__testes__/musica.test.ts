// §17.5 (emenda de 2026-08-28) — o Modo Música no renderer, sem áudio de verdade:
// a malha recebe uma FÁBRICA de mixador de mentira (4º parâmetro do construtor), e o rig
// conta `replaceTrack`. O que se prova: a trilha que sai é a MISTURADA; o mudo próprio cala
// só a perna do mic; o mudo impositivo corta tudo; e desligar devolve o microfone original.
// O grafo REAL (`criarMixador`) tem teste próprio com `AudioContext` falso.

import { describe, expect, it, vi } from "vitest";

import { criarMixador, type Mixador } from "../mixagem";
import { MalhaDeVoz } from "../voz";
import type { FabricaDeMidia, PortaDeVoz, TicketNoFio } from "../voz";

const EU = "aa".repeat(32);
const PAR = "bb".repeat(32);

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
}

function trilhaFalsa(nome: string, kind = "audio"): MediaStreamTrack {
  return { kind, enabled: true, label: nome, stop: vi.fn() } as unknown as MediaStreamTrack;
}

/** `AudioContext` de mentira: nós com `connect` encadeável e destino com trilha própria. */
function contextoFalso() {
  const node = () => {
    const n = {
      gain: { value: 1 },
      fftSize: 512,
      connect(destino: unknown) {
        return destino;
      },
      disconnect: vi.fn(),
      getByteTimeDomainData: vi.fn(),
      stream: { getAudioTracks: () => [trilhaFalsa("mistura")] },
    };
    return n;
  };
  return {
    createMediaStreamDestination: vi.fn(node),
    createGain: vi.fn(node),
    createMediaStreamSource: vi.fn(node),
    createAnalyser: vi.fn(node),
    // O misturador retoma o contexto ao montar (grafo suspenso é silêncio, §17.5).
    resume: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  } as unknown as AudioContext;
}

function mixadorFalso(trilha: MediaStreamTrack): Mixador {
  return {
    trilha,
    definirSistema: vi.fn(),
    removerSistema: vi.fn(),
    definirGanhoSistema: vi.fn(),
    nivel: () => 0,
    encerrar: vi.fn(),
  };
}

function pcFalsoComSenders() {
  const audioSender = { track: trilhaFalsa("mic-original"), replaceTrack: vi.fn(async (_nova: MediaStreamTrack) => undefined) };
  const videoSender = { track: trilhaFalsa("video", "video"), replaceTrack: vi.fn(async (_nova: MediaStreamTrack) => undefined) };
  /**
   * §17.2 (emenda de 2026-09-03) — o SEGUNDO áudio da conexão: o som da tela, m-line 3.
   *
   * Ele existe neste duplo para que os testes possam afirmar que o Modo Música **não** o
   * toca. Antes da emenda, `#substituirTrilhaDeAudio` procurava "o sender de áudio" por
   * `kind`, e com dois áudios na conexão essa busca podia escrever no m-line errado — trocar
   * o microfone teria chance de substituir o som que está sendo transmitido.
   */
  const audioDaTelaSender = { track: trilhaFalsa("som-da-tela"), replaceTrack: vi.fn(async (_nova: MediaStreamTrack) => undefined) };
  const telaSender = { track: null, replaceTrack: vi.fn(async (_nova: MediaStreamTrack | null) => undefined) };
  const reservados = [audioSender, videoSender, telaSender, audioDaTelaSender];
  let proximo = 0;
  const pc = {
    connectionState: "connected",
    signalingState: "stable",
    remoteDescription: null,
    addTrack: vi.fn(() => audioSender),
    // A ordem normativa: voz, câmera, tela, som da tela.
    addTransceiver: vi.fn((kind: string) => ({
      kind,
      sender: reservados[proximo++]!,
      receiver: { track: null },
      mid: null,
      direction: "sendrecv",
    })),
    removeTrack: vi.fn(),
    /*
     * A ordem é HOSTIL de propósito: o som da tela vem ANTES da voz. `getSenders()` não
     * promete ordem nenhuma, e era exatamente disso que a busca por `kind` dependia sem
     * dizer. Um duplo que devolvesse a voz primeiro deixaria o defeito passar.
     */
    getSenders: vi.fn(() => [videoSender, audioDaTelaSender, audioSender]),
    getStats: vi.fn(async () => new Map()),
    close: vi.fn(),
    createOffer: vi.fn(async () => ({ type: "offer" as const, sdp: "v=0" })),
    createAnswer: vi.fn(async () => ({ type: "answer" as const, sdp: "v=0" })),
    setLocalDescription: vi.fn(async () => undefined),
    setRemoteDescription: vi.fn(async () => undefined),
    addIceCandidate: vi.fn(async () => undefined),
    onicecandidate: null,
    ontrack: null,
    onsignalingstatechange: null,
    onconnectionstatechange: null,
    oniceconnectionstatechange: null,
    onicegatheringstatechange: null,
  } as unknown as RTCPeerConnection;
  return { pc, audioSender, audioDaTelaSender };
}

function montar(trilhaMic: MediaStreamTrack, fabricaDeMixador: (mic: MediaStream) => Mixador | null) {
  const { pc, audioSender, audioDaTelaSender } = pcFalsoComSenders();
  const tickets: TicketNoFio[] = [
    { sessionId: "s1", channelId: "ch", peerA: bytes(EU), peerB: bytes(PAR), expiresAt: 9_000, sig: bytes("00") },
  ];
  const porta: PortaDeVoz = {
    join: vi.fn(async () => ({
      sessionId: "s1",
      roster: [{ keyHex: EU }, { keyHex: PAR }],
      iceServers: [{ urls: "stun:1.2.3.4:1" }],
      tickets,
    })),
    leave: vi.fn(async () => undefined),
    signal: vi.fn(async () => undefined),
  };
  const trilhasDeAudio = [trilhaMic];
  const midia: FabricaDeMidia = {
    capturar: vi.fn(async () => ({ getTracks: () => trilhasDeAudio, getAudioTracks: () => trilhasDeAudio }) as unknown as MediaStream),
    conexao: vi.fn(() => pc),
  };
  const eventos = {
    aoMudarPar: vi.fn(),
    aoChegarAudio: vi.fn(),
    aoChegarVideo: vi.fn(),
    aoFalhar: vi.fn(),
    aoSair: vi.fn(),
  };
  return { malha: new MalhaDeVoz(porta, midia, eventos, fabricaDeMixador), audioSender, audioDaTelaSender };
}

describe("criarMixador — o grafo mic + sistema numa trilha única", () => {
  it("liga as pernas ao destino, expõe a trilha dele e encerra limpo", () => {
    const ctx = contextoFalso();
    const mic = trilhaFalsa("mic");
    const mixador = criarMixador({ getAudioTracks: () => [mic] } as unknown as MediaStream, () => ctx);
    expect(mixador).not.toBeNull();
    expect(mixador!.trilha?.label).toBe("mistura");
    mixador!.definirSistema({ getAudioTracks: () => [trilhaFalsa("loopback")] } as unknown as MediaStream);
    mixador!.definirGanhoSistema(0.5);
    mixador!.encerrar();
    expect(ctx.close).toHaveBeenCalled();
  });

  it("o misturador retoma o contexto ao montar — grafo suspenso é silêncio", () => {
    // Sem o `resume`, um contexto nascido suspenso (sem ativação para herdar)
    // produziria silêncio digital: nem música, nem a perna do mic que passa por
    // ele. O estágio de ganho de entrada já retomava; o misturador, não.
    const ctx = contextoFalso();
    const mixador = criarMixador({ getAudioTracks: () => [trilhaFalsa("mic")] } as unknown as MediaStream, () => ctx);
    expect(mixador).not.toBeNull();
    expect(ctx.resume).toHaveBeenCalled();
  });

  it("sem AudioContext no ambiente devolve null — música indisponível, nunca crash", () => {
    const Ctor = globalThis.AudioContext;
    // @ts-expect-error — simulando ambiente sem WebAudio
    delete globalThis.AudioContext;
    try {
      expect(criarMixador({ getAudioTracks: () => [] } as unknown as MediaStream)).toBeNull();
    } finally {
      globalThis.AudioContext = Ctor;
    }
  });
});

describe("Modo Música na malha — mixagem, replaceTrack e o mudo em dois níveis", () => {
  async function rigComMusica() {
    const trilhaMic = trilhaFalsa("mic-original");
    const trilhaMistura = trilhaFalsa("mistura");
    const mixador = mixadorFalso(trilhaMistura);
    const { malha, audioSender } = montar(trilhaMic, () => mixador);
    await malha.entrar({ communityId: "c1", channelId: "ch", euHex: EU, microfoneId: "default", agora: 1_000 });
    await malha.ativarMusica({ getAudioTracks: () => [trilhaFalsa("loopback")] } as unknown as MediaStream);
    return { malha, audioSender, trilhaMic, trilhaMistura, mixador };
  }

  it("ativar substitui a trilha de áudio dos pares pela misturada; desativar devolve o mic", async () => {
    const trilhaMic = trilhaFalsa("mic-original");
    const trilhaMistura = trilhaFalsa("mistura");
    const { malha, audioSender } = montar(trilhaMic, () => mixadorFalso(trilhaMistura));
    await malha.entrar({ communityId: "c1", channelId: "ch", euHex: EU, microfoneId: "default", agora: 1_000 });
    const misturou = await malha.ativarMusica({ getAudioTracks: () => [trilhaFalsa("loopback")] } as unknown as MediaStream);
    expect(misturou).toBe(true);
    const substituida = audioSender.replaceTrack.mock.calls.at(-1)?.[0] as MediaStreamTrack | undefined;
    expect(substituida).not.toBeUndefined();
    expect(substituida?.label).toBe("mistura");
    await malha.desativarMusica();
    expect(audioSender.replaceTrack.mock.calls.at(-1)?.[0]).toBe(trilhaMic);
  });

  it("ativar diz quando NÃO misturou: sem sistema, sem mic ou sem grafo, nada sai", async () => {
    // O desfecho honesto é o que deixa a UI dizer "indisponível" em vez de acender
    // o ícone sobre uma transmissão que não existe.
    const trilhaMic = trilhaFalsa("mic-original");
    const { malha, audioSender } = montar(trilhaMic, () => mixadorFalso(trilhaFalsa("mistura")));
    await malha.entrar({ communityId: "c1", channelId: "ch", euHex: EU, microfoneId: "default", agora: 1_000 });
    audioSender.replaceTrack.mockClear();
    expect(await malha.ativarMusica({ getAudioTracks: () => [] } as unknown as MediaStream)).toBe(false);
    expect(audioSender.replaceTrack).not.toHaveBeenCalled();
  });

  it("sem chamada (somente-escuta sem captura) ativar não mistura", async () => {
    const { malha } = montar(trilhaFalsa("mic-original"), () => mixadorFalso(trilhaFalsa("mistura")));
    expect(await malha.ativarMusica({ getAudioTracks: () => [trilhaFalsa("loopback")] } as unknown as MediaStream)).toBe(false);
  });

  it("sem sistema na trilha, ativar não troca nada — não há música para tocar", async () => {
    const trilhaMic = trilhaFalsa("mic-original");
    const { malha, audioSender } = montar(trilhaMic, () => mixadorFalso(trilhaFalsa("mistura")));
    await malha.entrar({ communityId: "c1", channelId: "ch", euHex: EU, microfoneId: "default", agora: 1_000 });
    // §17.2 (emenda de 2026-09-03) — o microfone entra no m-line 0 por `replaceTrack`, e não
    // mais por `addTrack`. O que se mede aqui é o DEPOIS da entrada.
    audioSender.replaceTrack.mockClear();
    await malha.ativarMusica({ getAudioTracks: () => [] } as unknown as MediaStream);
    expect(audioSender.replaceTrack).not.toHaveBeenCalled();
  });

  it("trocar de trilha escreve no m-line 0 e NUNCA no som da tela (m-line 3)", async () => {
    /*
     * A conexão tem dois áudios desde a emenda de 2026-09-03. `#substituirTrilhaDeAudio`
     * procurava "o sender de áudio" por `kind`, e `getSenders()` não promete ordem: com o
     * som da tela no ar, ativar o Modo Música podia substituir a transmissão em vez do
     * microfone. Endereçar o m-line pelo nome é o que fecha isso.
     */
    const { malha, audioSender, audioDaTelaSender } = montar(
      trilhaFalsa("mic-original"),
      () => mixadorFalso(trilhaFalsa("mistura")),
    );
    await malha.entrar({ communityId: "c1", channelId: "ch", euHex: EU, microfoneId: "default", agora: 1_000 });
    audioSender.replaceTrack.mockClear();
    audioDaTelaSender.replaceTrack.mockClear();

    await malha.ativarMusica({ getAudioTracks: () => [trilhaFalsa("loopback")] } as unknown as MediaStream);

    expect(audioSender.replaceTrack).toHaveBeenCalled();
    expect(audioDaTelaSender.replaceTrack).not.toHaveBeenCalled();
  });

  it("mudo próprio com música cala só o mic; impositivo corta a saída inteira", async () => {
    const { malha, trilhaMic, trilhaMistura } = await rigComMusica();

    // Mudo PRÓPRIO: a trilha do MIC desliga, a misturada segue no ar.
    malha.definirMudo(true);
    expect(trilhaMic.enabled).toBe(false);
    expect(trilhaMistura.enabled).toBe(true);

    // Mudo IMPOSTO (host/fila): a trilha que SAI desliga — música incluída.
    malha.definirMudoImpositivo(true);
    expect(trilhaMistura.enabled).toBe(false);

    // A imposição caiu (turno chegou): a saída volta — e o mic continua no mudo DELE.
    malha.definirMudoImpositivo(false);
    expect(trilhaMistura.enabled).toBe(true);
    expect(trilhaMic.enabled).toBe(false);

    malha.definirMudo(false);
    expect(trilhaMic.enabled).toBe(true);
  });

  it("sem música, mudo próprio e impositivo convergem na mesma trilha (comportamento de hoje)", async () => {
    const trilhaMic = trilhaFalsa("mic-original");
    const { malha } = montar(trilhaMic, () => mixadorFalso(trilhaFalsa("mistura")));
    await malha.entrar({ communityId: "c1", channelId: "ch", euHex: EU, microfoneId: "default", agora: 1_000 });

    malha.definirMudo(true);
    expect(trilhaMic.enabled).toBe(false);
    malha.definirMudoImpositivo(true);
    expect(trilhaMic.enabled).toBe(false);
    malha.definirMudoImpositivo(false);
    // O mudo próprio ainda vale — a imposição cair não desmuta quem se calou.
    expect(trilhaMic.enabled).toBe(false);
    malha.definirMudo(false);
    expect(trilhaMic.enabled).toBe(true);
  });

  /*
   * §17.5 item 5-bis (emenda de 2026-09-06) — a fonte de sistema é REAPROVEITADA na troca
   * de microfone, e por isso a trilha anterior só pode ser parada quando é OUTRA.
   *
   * Verificado por mutação: voltar o `stop()` a ser incondicional derruba este caso — que é
   * exatamente o defeito relatado, a música emudecendo para todos sem erro nenhum no meio
   * de uma troca de microfone que aparentemente deu certo.
   */
  it("trocar de microfone com música ativa NÃO para a trilha de sistema reaproveitada", async () => {
    const trilhaMic = trilhaFalsa("mic-original");
    const trilhaMistura = trilhaFalsa("mistura");
    const loopback = trilhaFalsa("loopback");
    const streamDeSistema = { getAudioTracks: () => [loopback] } as unknown as MediaStream;
    const { malha } = montar(trilhaMic, () => mixadorFalso(trilhaFalsa("mistura-nova")));
    await malha.entrar({ communityId: "c1", channelId: "ch", euHex: EU, microfoneId: "default", agora: 1_000 });
    await malha.ativarMusica(streamDeSistema);
    expect(trilhaMistura).toBeDefined();

    await malha.trocarMicrofone("outro-mic");

    // A trilha do loopback é a MESMA de antes: `trocarMicrofone` remonta o grafo com ela.
    // Pará-la aqui deixaria a mistura montada sobre uma fonte morta.
    expect(loopback.stop).not.toHaveBeenCalled();
  });

  it("uma fonte de sistema NOVA para a anterior — trocar de fonte não acumula captura", async () => {
    const trilhaMic = trilhaFalsa("mic-original");
    const primeira = trilhaFalsa("loopback-1");
    const segunda = trilhaFalsa("loopback-2");
    const { malha } = montar(trilhaMic, () => mixadorFalso(trilhaFalsa("mistura")));
    await malha.entrar({ communityId: "c1", channelId: "ch", euHex: EU, microfoneId: "default", agora: 1_000 });

    await malha.ativarMusica({ getAudioTracks: () => [primeira] } as unknown as MediaStream);
    await malha.ativarMusica({ getAudioTracks: () => [segunda] } as unknown as MediaStream);

    expect(primeira.stop).toHaveBeenCalled();
    expect(segunda.stop).not.toHaveBeenCalled();
  });

  /*
   * §6.16 (emenda de 2026-09-06) — `speaking` é sobre o que SAI. Com Modo Música ligado, o
   * mudo imposto corta só a trilha misturada e deixa o microfone captando; sem esta
   * propriedade, quem espera a vez na fila acendia o anel de fala do canal inteiro.
   */
  it("a voz deixa de ser audível sob mudo próprio E sob mudo imposto", async () => {
    const { malha } = await rigComMusica();
    expect(malha.vozAudivel).toBe(true);

    malha.definirMudoImpositivo(true);
    expect(malha.vozAudivel).toBe(false);

    malha.definirMudoImpositivo(false);
    expect(malha.vozAudivel).toBe(true);

    malha.definirMudo(true);
    expect(malha.vozAudivel).toBe(false);
  });

  it("o volume da música vai para o nó de ganho do grafo", async () => {
    const { malha, mixador } = await rigComMusica();
    malha.definirVolumeMusica(0.3);
    expect(mixador.definirGanhoSistema).toHaveBeenCalledWith(0.3);
  });
});
