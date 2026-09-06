/**
 * §17.4 no renderer. O que dá para provar sem microfone e sem duas máquinas: a regra de
 * quem pode falar com quem (passo 4), a de quem oferta (anti-glare) e o ciclo de roster.
 *
 * O passo 3 — recusar sinalização sem ticket válido — NÃO é testado aqui porque não é daqui:
 * `signalIsAuthorized` roda no núcleo, antes do evento chegar. O que este arquivo cobre é a
 * outra metade: não iniciar DTLS com par para quem o host não emitiu ticket.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MalhaDeVoz,
  chaveHex,
  contarTerceiros,
  familiaDoCandidato,
  leituraDeSaida,
  motivoDaFalha,
  paresAutorizados,
  separarPorOrigem,
  souOIniciador,
  ticketIdDe,
} from "../voz";
import type { FabricaDeMidia, PortaDeVoz, TicketNoFio } from "../voz";

const EU = "aa".repeat(32);
const PAR = "bb".repeat(32);
/** Chave MENOR que a minha: com ele, quem oferta primeiro é o outro lado (§17.4). */
const PAR_MENOR = "01".repeat(32);
const ESTRANHO = "cc".repeat(32);

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
}

function ticket(a: string, b: string, expiresAt = 9_000): TicketNoFio {
  return { sessionId: "s1", channelId: "ch", peerA: bytes(a), peerB: bytes(b), expiresAt, sig: bytes("00") };
}

/** Evento de mentira para disparar handlers `on*` sem navegador. */
function evFalso(): Event {
  return { type: "connectionstatechange" } as unknown as Event;
}

/** Os m-lines reservados de cada `RTCPeerConnection` de mentira, na ordem de criação. */
const txPorPc = new WeakMap<object, RTCRtpTransceiver[]>();
function transceiversDe(pc: object): RTCRtpTransceiver[] {
  let t = txPorPc.get(pc);
  if (t === undefined) {
    t = [];
    txPorPc.set(pc, t);
  }
  return t;
}

/** Os senders que cada `RTCPeerConnection` de mentira criou — `getSenders` lê daqui. */
const sendersPorPc = new WeakMap<object, Array<Record<string, unknown>>>();
function sendersDe(pc: object): Array<Record<string, unknown>> {
  let s = sendersPorPc.get(pc);
  if (s === undefined) {
    s = [];
    sendersPorPc.set(pc, s);
  }
  return s;
}

/** `RTCPeerConnection` de mentira — o suficiente para a malha acreditar. */
function pcFalso(): RTCPeerConnection {
  const pc = {
    connectionState: "new" as RTCPeerConnectionState,
    signalingState: "stable" as RTCSignalingState,
    // Só existe depois que o outro lado responde — é o que distingue "não me responderam"
    // de "não me chegou nada", e o critério da repetição de oferta de §17.4.
    remoteDescription: null as RTCSessionDescription | null,
    addTrack: vi.fn((track: MediaStreamTrack, _stream?: MediaStream) => {
      const sender = {
        track,
        getParameters: vi.fn(() => ({ encodings: [{}] })),
        setParameters: vi.fn(async () => undefined),
        replaceTrack: vi.fn(async () => undefined),
      };
      sendersDe(pc).push(sender as unknown as Record<string, unknown>);
      return sender;
    }),
    /**
     * §17.2 (emenda de 2026-09-03) — os quatro m-lines reservados. O duplo registra o
     * `sender` de cada um e guarda a trilha que `replaceTrack` escreveu, que é o que os
     * testes leem no lugar do antigo `addTrack`.
     */
    addTransceiver: vi.fn((kind: string, _init?: unknown) => {
      // O `mid` que o ofertante atribui, na ordem das seções da SDP — é por ele que
      // `ontrack` decide (§17.2, emenda de 2026-09-03).
      const mid = String(transceiversDe(pc).length);
      const sender = {
        track: null as MediaStreamTrack | null,
        getParameters: vi.fn(() => ({ encodings: [{}] })),
        setParameters: vi.fn(async () => undefined),
        replaceTrack: vi.fn(async (t: MediaStreamTrack | null) => {
          sender.track = t;
        }),
      };
      sendersDe(pc).push(sender as unknown as Record<string, unknown>);
      const t = { mid, sender, receiver: { track: null }, direction: "sendrecv", kind };
      transceiversDe(pc).push(t as unknown as RTCRtpTransceiver);
      return t;
    }),
    getTransceivers: vi.fn(() => transceiversDe(pc)),
    removeTrack: vi.fn(),
    getSenders: vi.fn(() => sendersDe(pc)),
    getStats: vi.fn(async () => new Map()),
    onsignalingstatechange: null,
    close: vi.fn(),
    createOffer: vi.fn(async () => ({ type: "offer", sdp: "v=0" })),
    createAnswer: vi.fn(async () => ({ type: "answer", sdp: "v=0" })),
    setLocalDescription: vi.fn(async () => undefined),
    setRemoteDescription: vi.fn(async (d: RTCSessionDescriptionInit) => {
      pc.remoteDescription = d as RTCSessionDescription;
      // §17.2 (emenda de 2026-09-03) — quem responde recebe os m-lines da oferta, criados
      // pelo navegador e **`recvonly`**, que é o que o duplo precisa reproduzir.
      if (transceiversDe(pc).length === 0) {
        for (const k of ["audio", "video", "video", "audio"]) {
          const t = pc.addTransceiver(k) as unknown as { direction: string };
          t.direction = "recvonly";
        }
      }
    }),
    addIceCandidate: vi.fn(async () => undefined),
    restartIce: vi.fn(),
    setConfiguration: vi.fn(),
    onicecandidate: null,
    ontrack: null,
    onconnectionstatechange: null,
    oniceconnectionstatechange: null,
    onicegatheringstatechange: null,
  };
  return pc as unknown as RTCPeerConnection;
}

function montar(
  tickets: TicketNoFio[],
  roster: string[],
  iceServers?: RTCIceServer[],
  /** §31.15 — sem ticket, quem autoriza é o cabo. Só a conversa direta liga isto. */
  autorizacaoPorTransporte?: boolean,
) {
  const criadas: RTCPeerConnection[] = [];
  const porta: PortaDeVoz = {
    join: vi.fn(async () => ({
      sessionId: "s1",
      roster: roster.map((k) => ({ keyHex: k })),
      iceServers: iceServers ?? [{ urls: "stun:1.2.3.4:1" }],
      tickets,
      ...(autorizacaoPorTransporte === true ? { autorizacaoPorTransporte: true } : {}),
    })),
    leave: vi.fn(async () => undefined),
    signal: vi.fn(async () => undefined),
  };
  const trilhasDeAudio = [{ kind: "audio", enabled: true, stop: vi.fn() }];
  const midia: FabricaDeMidia = {
    capturar: vi.fn(
      async () =>
        ({
          getTracks: () => trilhasDeAudio,
          getAudioTracks: () => trilhasDeAudio,
        }) as unknown as MediaStream,
    ),
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
    aoSumirVideo: vi.fn(),
    aoFalhar: vi.fn(),
    aoSair: vi.fn(),
    aoMicrofoneAusente: vi.fn(),
  };
  const malha = new MalhaDeVoz(porta, midia, eventos);
  return { malha, porta, midia, criadas, trilhasDeAudio, eventos };
}

/**
 * Os quatro m-lines reservados daquela conexão (§17.2, emenda de 2026-09-03), na ordem
 * normativa: 0 voz, 1 câmera, 2 tela, 3 som da tela.
 */
function reservados(pc: RTCPeerConnection): {
  voz: RTCRtpTransceiver;
  camera: RTCRtpTransceiver;
  tela: RTCRtpTransceiver;
  telaAudio: RTCRtpTransceiver;
} {
  const c = (pc.addTransceiver as ReturnType<typeof vi.fn>).mock.results.map(
    (r) => r.value as RTCRtpTransceiver,
  );
  return { voz: c[0]!, camera: c[1]!, tela: c[2]!, telaAudio: c[3]! };
}

/** Um `MediaStream` de mentira identificado pelo `msid`, que é o que a malha usa. */
function streamFalso(id: string): MediaStream {
  return { id } as unknown as MediaStream;
}

describe("chaveHex — as duas formas do fio", () => {
  it("bytes da IPC-R e hex de §16.2 chegam ao mesmo lugar", () => {
    expect(chaveHex(bytes("aabb"))).toBe("aabb");
    expect(chaveHex("AABB")).toBe("aabb");
  });
});

describe("paresAutorizados", () => {
  it("o outro lado do par é quem fica autorizado", () => {
    expect([...paresAutorizados([ticket(EU, PAR)], EU, 0).keys()]).toEqual([PAR]);
  });

  it("ticket vencido não autoriza ninguém", () => {
    // Vencido além da tolerância de relógio (60 s) — o filtro é consultivo, e quem tem o
    // relógio um pouco adiantado não descarta ticket recém-emitido.
    expect(paresAutorizados([ticket(EU, PAR, 100)], EU, 100 + 60_000).size).toBe(0);
  });

  it("ticket recém-emitido sobrevive a um relógio local adiantado (tolerância de 60 s)", () => {
    expect(paresAutorizados([ticket(EU, PAR, 100)], EU, 200).size).toBe(1);
  });

  it("ticket entre dois terceiros não me autoriza a falar com nenhum deles", () => {
    expect(paresAutorizados([ticket(PAR, ESTRANHO)], EU, 0).size).toBe(0);
  });
});

describe("ticketIdDe — §15.4 exige um id em voice.signal", () => {
  it("deriva da assinatura, os 12 primeiros bytes", () => {
    const t = ticket(EU, PAR);
    expect(ticketIdDe({ ...t, sig: bytes("0011223344556677889900112233") })).toBe("001122334455667788990011");
  });

  it("o par autorizado vem COM o id — quem oferta fala primeiro e precisa dele", () => {
    const t = ticket(EU, PAR);
    const mapa = paresAutorizados([t], EU, 0);
    expect(mapa.get(PAR)).toBe(ticketIdDe(t));
    expect(mapa.get(PAR)).not.toBe("");
  });
});

describe("souOIniciador — sem glare", () => {
  it("exatamente um dos dois lados oferta", () => {
    expect(souOIniciador(EU, PAR)).toBe(true);
    expect(souOIniciador(PAR, EU)).toBe(false);
  });
});

describe("MalhaDeVoz", () => {
  it("o host decide ANTES da captura: sem join aceito, o microfone não acende", async () => {
    const { malha, midia, porta } = montar([ticket(EU, PAR)], [EU, PAR]);
    (porta.join as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("E_PERMISSION_DENIED"));
    await expect(
      malha.entrar({ communityId: "c", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 }),
    ).rejects.toThrow();
    expect(midia.capturar).not.toHaveBeenCalled();
  });

  it("oferta ao par com ticket e NÃO oferta a quem não tem (§17.4 passo 4)", async () => {
    const { malha, porta } = montar([ticket(EU, PAR)], [EU, PAR, ESTRANHO]);
    await malha.entrar({ communityId: "c", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 });
    await new Promise((r) => setTimeout(r, 0));

    const enviados = (porta.signal as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as { peerKey: string; ticketId: string },
    );
    const paraOPar = enviados.find((s) => s.peerKey === PAR);
    expect(paraOPar).toBeDefined();
    // A regressão de §79: `ticketId` vazio era recusado com `E_VALIDATION` no roteador, e
    // quem OFERTA fala primeiro — não tinha como ter recebido um id antes.
    expect(paraOPar!.ticketId).not.toBe("");
    expect(enviados.some((s) => s.peerKey === ESTRANHO)).toBe(false);
  });

  it("sinal de par sem ticket é ignorado, mesmo chegando pelo evento", async () => {
    const { malha, criadas } = montar([ticket(EU, PAR)], [EU, PAR]);
    await malha.entrar({ communityId: "c", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 });
    const antes = criadas.length;
    await malha.aplicarSinal({ peerKey: ESTRANHO, ticketId: "t", sdp: '{"type":"offer"}' });
    expect(criadas.length).toBe(antes);
  });

  /**
   * §17.2/§17.4 (correção de 2026-09-05) — o sinal que chega antes do roster reabre a
   * conexão pelo `aplicarSinal`, e o papel ali era um `false` FIXO. Quem deveria ofertar
   * nascia como respondedor: sem os quatro m-lines de §17.2, a repetição de oferta saía sem
   * m-line nenhum e a chamada conectava MUDA para sempre naquele par.
   */
  it("sinal de par fora de `#pares` reabre com o papel de `souOIniciador`, não como respondedor", async () => {
    const { malha, criadas } = montar([ticket(EU, PAR)], [EU, PAR]);
    await malha.entrar({ communityId: "c", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 });
    await new Promise((r) => setTimeout(r, 0));
    expect(criadas.length).toBe(1);
    const mLinesDoIniciador = transceiversDe(criadas[0] as unknown as object).length;
    expect(mLinesDoIniciador).toBe(4);

    // O roster oscila e fecha o par; `#autorizados` continua com ele, então um candidato
    // trickle atrasado entra por `aplicarSinal` e reabre a conexão.
    malha.aplicarRoster([{ keyHex: EU }]);
    await malha.aplicarSinal({ peerKey: PAR, ticketId: "t", ice: '{"candidate":"a"}' });
    expect(criadas.length).toBe(2);
    // EU > PAR? `souOIniciador(EU, PAR)` é true (aa… < bb…): eu ofertaria, e a conexão
    // reaberta tem de nascer com os m-lines reservados.
    expect(souOIniciador(EU, PAR)).toBe(true);
    expect(transceiversDe(criadas[1] as unknown as object).length).toBe(4);
  });

  it("do lado que RESPONDE, o mesmo caminho continua sem criar m-line (é quem adota)", async () => {
    const { malha, criadas } = montar([ticket(EU, PAR_MENOR)], [EU, PAR_MENOR]);
    await malha.entrar({ communityId: "c", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 });
    await new Promise((r) => setTimeout(r, 0));
    malha.aplicarRoster([{ keyHex: EU }]);
    await malha.aplicarSinal({ peerKey: PAR_MENOR, ticketId: "t", ice: '{"candidate":"a"}' });
    expect(souOIniciador(EU, PAR_MENOR)).toBe(false);
    expect(transceiversDe(criadas[criadas.length - 1] as unknown as object).length).toBe(0);
  });

  it("roster que perde um par fecha a conexão dele", async () => {
    const { malha, criadas } = montar([ticket(EU, PAR)], [EU, PAR]);
    await malha.entrar({ communityId: "c", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 });
    expect(criadas.length).toBe(1);
    malha.aplicarRoster([{ keyHex: EU }]);
    expect(criadas[0]!.close).toHaveBeenCalled();
  });

  it("só candidato host = falha NOMEADA, não 'Conectando…' para sempre (L-11)", async () => {
    vi.useFakeTimers();
    try {
      const aoFalhar = vi.fn();
      const criadas: RTCPeerConnection[] = [];
      const porta: PortaDeVoz = {
        join: vi.fn(async () => ({
          sessionId: "s1",
          roster: [{ keyHex: EU }, { keyHex: PAR }],
          iceServers: [],
          tickets: [ticket(EU, PAR)],
        })),
        leave: vi.fn(async () => undefined),
        signal: vi.fn(async () => undefined),
      };
      const midia: FabricaDeMidia = {
        capturar: vi.fn(
          async () =>
            ({
              getTracks: () => [],
              getAudioTracks: () => [],
            }) as unknown as MediaStream,
        ),
        conexao: vi.fn(() => {
          const pc = pcFalso();
          criadas.push(pc);
          return pc;
        }),
      };
      const malha = new MalhaDeVoz(porta, midia, {
        aoMudarPar: vi.fn(),
        aoChegarAudio: vi.fn(),
        aoFalhar,
        aoSair: vi.fn(),
      });

      await malha.entrar({ communityId: "c", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 });
      // Só endereço de rede local — o STUN do host não respondeu.
      criadas[0]!.onicecandidate?.({
        candidate: { type: "host", protocol: "udp", toJSON: () => ({}) },
      } as unknown as RTCPeerConnectionIceEvent);

      await vi.advanceTimersByTimeAsync(21_000);

      expect(aoFalhar).toHaveBeenCalledTimes(1);
      expect(aoFalhar.mock.calls[0]![0]).toMatch(/alcançável/);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * O defeito do smoke de duas máquinas, na forma exata em que ele aparece no log: o host
   * ofertou no instante em que viu o roster novo, e o outro lado registrou
   * `SEM TICKET — o host não pareou nós dois` no mesmo fôlego. A oferta foi descartada pelo
   * núcleo de lá (§17.4 passo 3) e não voltava nunca — quem oferta é um lado só, e ele já
   * tinha ofertado. Os dois ficavam parados até o prazo de L-11.
   */
  it("oferta sem resposta é REPETIDA — a corrida do ticket não trava a chamada para sempre", async () => {
    vi.useFakeTimers();
    try {
      const { malha, porta, criadas } = montar([ticket(EU, PAR)], [EU, PAR]);
      await malha.entrar({ communityId: "c", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 });
      const ofertas = () =>
        (porta.signal as ReturnType<typeof vi.fn>).mock.calls.filter(
          (c) => (c[0] as { sdp?: string }).sdp !== undefined,
        ).length;
      await vi.advanceTimersByTimeAsync(0);
      expect(ofertas()).toBe(1);

      // Ninguém respondeu: a oferta sai de novo, e os candidatos já coletados vão junto —
      // `onicecandidate` não os repete, e uma oferta sem endereço não fecha ICE nenhum.
      criadas[0]!.onicecandidate?.({
        candidate: { type: "srflx", protocol: "udp", toJSON: () => ({ candidate: "a" }) },
      } as unknown as RTCPeerConnectionIceEvent);
      (porta.signal as ReturnType<typeof vi.fn>).mockClear();
      await vi.advanceTimersByTimeAsync(3_500);
      expect(ofertas()).toBe(1);
      const reenviados = (porta.signal as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => (c[0] as { ice?: string }).ice !== undefined,
      );
      expect(reenviados.length).toBe(1);

      // E a resposta encerra a repetição: `remoteDescription` deixa de ser nula.
      await malha.aplicarSinal({ peerKey: PAR, ticketId: "t", sdp: '{"type":"answer"}' });
      (porta.signal as ReturnType<typeof vi.fn>).mockClear();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(porta.signal).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ticket que chega depois destrava quem já estava esperando (§17.4 passo 4)", async () => {
    vi.useFakeTimers();
    try {
      // Entra sem ticket nenhum — é o que o host devolve a quem entra primeiro na chamada.
      const { malha, porta } = montar([], [EU, PAR]);
      await malha.entrar({ communityId: "c", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 });
      await vi.advanceTimersByTimeAsync(0);
      expect(porta.signal).not.toHaveBeenCalled();

      malha.aplicarTickets([ticket(EU, PAR)], 0);
      await vi.advanceTimersByTimeAsync(0);
      const oferta = (porta.signal as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => (c[0] as { sdp?: string }).sdp !== undefined,
      );
      expect(oferta).toBeDefined();
      expect((oferta![0] as { ticketId: string }).ticketId).not.toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("candidato que chega antes da descrição remota espera por ela, e não se perde", async () => {
    // Quem NÃO oferta é quem vive este caso: a resposta ainda não saiu e o outro lado já
    // está mandando endereço. `addIceCandidate` sem descrição remota é erro de estado, e a
    // promessa recusada não tinha quem a pegasse — o evento entra por `void aplicarSinal`.
    const { malha, criadas } = montar([ticket(PAR, EU)], [PAR, EU]);
    await malha.entrar({ communityId: "c", channelId: "ch", euHex: PAR, microfoneId: "default", agora: 0 });
    await malha.aplicarSinal({ peerKey: EU, ticketId: "t", ice: '{"candidate":"a"}' });
    const pc = criadas[0]! as unknown as { addIceCandidate: ReturnType<typeof vi.fn> };
    expect(pc.addIceCandidate).not.toHaveBeenCalled();

    await malha.aplicarSinal({ peerKey: EU, ticketId: "t", sdp: '{"type":"offer"}' });
    expect(pc.addIceCandidate).toHaveBeenCalledWith({ candidate: "a" });
  });

  it("sair fecha tudo e avisa o núcleo", async () => {
    const { malha, porta, criadas } = montar([ticket(EU, PAR)], [EU, PAR]);
    await malha.entrar({ communityId: "c", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 });
    await malha.sair();
    expect(criadas[0]!.close).toHaveBeenCalled();
    expect(porta.leave).toHaveBeenCalled();
    expect(malha.sessionId).toBeNull();
  });

  /**
   * Trocar de canal de voz é o gesto mais comum da chamada. Entrar de novo sem limpar
   * deixava as RTCPeerConnection(s) do join anterior negociando pelo MESMO `voice.signal` —
   * ofertas cruzadas, a mesma voz tocando duas vezes e o microfone antigo preso. E o
   * `leave` não é do `entrar`: o host já resolveu a sessão anterior no join idempotente,
   * e um leave aqui seria resolvido contra a sessão NOVA.
   */
  it("reentrar nasce LIMPO: a conexão antiga fecha e o leave não sai por conta do entrar", async () => {
    const { malha, porta, criadas, trilhasDeAudio } = montar([ticket(EU, PAR)], [EU, PAR]);
    await malha.entrar({ communityId: "c", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 });
    expect(criadas).toHaveLength(1);

    await malha.entrar({ communityId: "c", channelId: "outro", euHex: EU, microfoneId: "default", agora: 0 });

    expect(criadas[0]!.close).toHaveBeenCalled();
    expect(criadas).toHaveLength(2);
    expect(trilhasDeAudio[0]!.stop).toHaveBeenCalled();
    expect(porta.leave).not.toHaveBeenCalled();
    expect(malha.sessionId).toBe("s1");
  });

  /**
   * §9 (2.3) — a falha é assimétrica. O prazo de L-11 era GLOBAL e rearmado a cada par
   * novo do roster: um terceiro que entrava e não conectava anunciava `conn-failed` para
   * uma chamada que já funcionava com o primeiro par.
   */
  it("um par que não conecta não falha a chamada que já tem outro conectado", async () => {
    vi.useFakeTimers();
    try {
      const { malha, criadas, eventos } = montar([ticket(EU, PAR), ticket(EU, ESTRANHO)], [EU, PAR]);
      await malha.entrar({ communityId: "c", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 });
      // PAR conectou: a chamada existe, e o prazo morreu com a conexão dele.
      (criadas[0] as unknown as { connectionState: RTCPeerConnectionState }).connectionState = "connected";
      criadas[0]!.onconnectionstatechange?.(evFalso());

      // ESTRANHO entra depois — o roster rearmava o prazo global.
      malha.aplicarRoster([{ keyHex: EU }, { keyHex: PAR }, { keyHex: ESTRANHO }]);
      await vi.advanceTimersByTimeAsync(21_000);
      expect(eventos.aoFalhar).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sem par conectado nenhum, o prazo de L-11 continua falhando a chamada", async () => {
    vi.useFakeTimers();
    try {
      const { malha, eventos } = montar([ticket(EU, PAR)], [EU, PAR]);
      await malha.entrar({ communityId: "c", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 });
      await vi.advanceTimersByTimeAsync(21_000);
      expect(eventos.aoFalhar).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Queda de rede não é o fim da chamada: `failed` reconstrói o ICE, pelo lado iniciador
   * (a mesma regra de quem oferta — os dois reofertando é glare), com teto de tentativas.
   */
  it("par que CHEGA A FALHAR reconstrói o ICE e reoferta — com teto de tentativas", async () => {
    vi.useFakeTimers();
    try {
      const { malha, criadas, porta } = montar([ticket(EU, PAR)], [EU, PAR]);
      await malha.entrar({ communityId: "c", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 });
      await vi.advanceTimersByTimeAsync(0);
      (porta.signal as ReturnType<typeof vi.fn>).mockClear();
      const pc = criadas[0] as unknown as {
        connectionState: RTCPeerConnectionState;
        restartIce: ReturnType<typeof vi.fn>;
        onconnectionstatechange: ((ev: Event) => void) | null;
      };

      pc.connectionState = "failed";
      pc.onconnectionstatechange?.(evFalso());
      expect(pc.restartIce).toHaveBeenCalledTimes(1);
      // A reoferta sai pelo caminho assíncrono da negociação.
      await vi.advanceTimersByTimeAsync(0);
      const oferta = (porta.signal as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => (c[0] as { sdp?: string }).sdp !== undefined,
      );
      expect(oferta).toBeDefined();

      // Três reconstruções depois, desiste: retentativa infinita contra par morto é
      // enxurrada, não recuperação.
      pc.onconnectionstatechange?.(evFalso());
      pc.onconnectionstatechange?.(evFalso());
      pc.onconnectionstatechange?.(evFalso());
      expect(pc.restartIce).toHaveBeenCalledTimes(3);

      // E uma recuperação zera o contador: o próximo `failed` reconstrói de novo.
      pc.connectionState = "connected";
      pc.onconnectionstatechange?.(evFalso());
      pc.connectionState = "failed";
      pc.onconnectionstatechange?.(evFalso());
      expect(pc.restartIce).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * §17.4 (correção de 2026-09-05) — **quem detecta a queda renegocia, iniciador ou não.**
   * A queda é assimétrica com frequência: só um lado vê `failed`. Guardado por
   * `souOIniciador`, o lado respondedor chamava `restartIce()` — que só marca credenciais
   * novas para a PRÓXIMA oferta — e ficava calado; três voltas depois o teto de tentativas
   * matava a conexão sem que uma oferta tivesse saído. O glare que a guarda evitava já é
   * resolvido em `aplicarSinal`, que é onde a colisão de renegociação se desempata.
   */
  it("o lado que RESPONDE também reoferta ao reconstruir o ICE", async () => {
    vi.useFakeTimers();
    try {
      const { malha, criadas, porta } = montar([ticket(EU, PAR_MENOR)], [EU, PAR_MENOR]);
      await malha.entrar({ communityId: "c", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 });
      await vi.advanceTimersByTimeAsync(0);
      expect(souOIniciador(EU, PAR_MENOR)).toBe(false);
      (porta.signal as ReturnType<typeof vi.fn>).mockClear();

      const pc = criadas[0] as unknown as {
        connectionState: RTCPeerConnectionState;
        restartIce: ReturnType<typeof vi.fn>;
        onconnectionstatechange: ((ev: Event) => void) | null;
      };
      pc.connectionState = "failed";
      pc.onconnectionstatechange?.(evFalso());
      expect(pc.restartIce).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(0);

      const oferta = (porta.signal as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => (c[0] as { sdp?: string }).sdp !== undefined,
      );
      expect(oferta).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  /** §17.3 — a credencial TURN vence junto do ticket; a renovada chega e é aplicada VIVA. */
  it("iceServers renovados entram por setConfiguration nas conexões vivas", async () => {
    const { malha, criadas } = montar([ticket(EU, PAR)], [EU, PAR]);
    await malha.entrar({ communityId: "c", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 });
    const novas = [{ urls: "stun:1.2.3.4:1" }, { urls: "turn:1.2.3.4:1", username: "s1:x", credential: "hmac" }];
    malha.aplicarIceServers(novas);
    expect((criadas[0] as unknown as { setConfiguration: ReturnType<typeof vi.fn> }).setConfiguration).toHaveBeenCalledWith({
      iceServers: novas,
    });
  });
});

/** `RTCStatsReport` de mentira: um mapa com as entradas que o WebRTC entregaria. */
function relatorio(entradas: Array<Record<string, unknown>>): RTCStatsReport {
  return new Map(entradas.map((e, i) => [String(i), e])) as unknown as RTCStatsReport;
}

describe("enviarTrilha — a estrela de tela pega carona na conexão da voz (§17.5)", () => {
  async function comChamada() {
    const r = montar([ticket(EU, PAR)], [EU, PAR]);
    await r.malha.entrar({
      communityId: "c",
      channelId: "ch",
      euHex: EU,
      microfoneId: "default",
      agora: 0,
    });
    return r;
  }

  it("par sem conexão não recebe trilha nenhuma", async () => {
    const r = await comChamada();
    const envio = await r.malha.enviarTrilha(ESTRANHO, {} as MediaStreamTrack, {} as MediaStream);
    expect(envio).toBeNull();
  });

  /**
   * §17.3 (emenda de 2026-08-28). O host perdeu o controle "tela via TURN é recusada"
   * porque lá ele era inaplicável: tela, câmera e voz compartilham a mesma conexão, logo a
   * mesma alocação TURN, e o host só vê bytes cifrados. Quem distingue é este lado.
   */
  it("tela NÃO sobe por par relayado — o conselho que substituiu o controle do host", async () => {
    const r = await comChamada();
    const pc = r.criadas[0]! as unknown as { getStats: ReturnType<typeof vi.fn>; addTrack: ReturnType<typeof vi.fn> };
    pc.getStats.mockResolvedValueOnce(
      relatorio([
        { type: "candidate-pair", state: "succeeded", nominated: true, localCandidateId: "L", remoteCandidateId: "R" },
        { id: "L", type: "local-candidate", candidateType: "relay" },
        { id: "R", type: "remote-candidate", candidateType: "srflx" },
      ]),
    );
    // (o microfone já entrou por `addTrack` quando o par abriu; o que interessa é o depois)
    pc.addTrack.mockClear();
    const envio = await r.malha.enviarTrilha(PAR, { kind: "video" } as MediaStreamTrack, {} as MediaStream);
    expect(envio).toBeNull();
    // E a recusa é ANTES do `addTrack`: uma trilha adicionada e depois removida já teria
    // renegociado, que é justamente o custo que não se quer pagar.
    expect(pc.addTrack).not.toHaveBeenCalled();
  });

  it("tela SOBE quando o par selecionado é direto — a recusa é do relay, não do NAT", async () => {
    const r = await comChamada();
    const pc = r.criadas[0]! as unknown as { getStats: ReturnType<typeof vi.fn> };
    pc.getStats.mockResolvedValueOnce(
      relatorio([
        { type: "candidate-pair", state: "succeeded", nominated: true, localCandidateId: "L", remoteCandidateId: "R" },
        { id: "L", type: "local-candidate", candidateType: "srflx" },
        { id: "R", type: "remote-candidate", candidateType: "srflx" },
      ]),
    );
    const envio = await r.malha.enviarTrilha(PAR, { kind: "video" } as MediaStreamTrack, {} as MediaStream);
    expect(envio).not.toBeNull();
  });

  it("sem par selecionado ainda, a tela sobe — não saber não é motivo para recusar", async () => {
    const r = await comChamada();
    // `getStats` default é um relatório vazio: a negociação não assentou. Recusar aqui
    // trocaria "a tela sobe por TURN" por "a tela nunca sobe".
    const envio = await r.malha.enviarTrilha(PAR, { kind: "video" } as MediaStreamTrack, {} as MediaStream);
    expect(envio).not.toBeNull();
  });

  /**
   * A regressão do defeito que a §83 introduziu: a trilha era adicionada à conexão, a
   * negociação anterior ainda não tinha assentado, a oferta era adiada — e **nunca saía**.
   * O espectador entrava no mapa como servido e ficava sem vídeo, em silêncio.
   */
  it("a tela NÃO renegocia mais: o m-line 2 já estava negociado (emenda de 2026-09-03)", async () => {
    const r = await comChamada();
    const pc = r.criadas[0]!;
    // A oferta inicial sai depois das trilhas (ver `prontas` em `#abrir`): esperar por ela
    // é o que separa "a tela renegociou" de "a entrada ainda estava terminando".
    await vi.waitFor(() => expect(pc.createOffer).toHaveBeenCalled());
    (r.porta.signal as ReturnType<typeof vi.fn>).mockClear();
    (pc.createOffer as ReturnType<typeof vi.fn>).mockClear();

    const track = { kind: "video" } as MediaStreamTrack;
    await r.malha.enviarTrilha(PAR, track, {} as MediaStream);

    // A trilha entrou no m-line reservado, e nenhuma SDP saiu por causa disso. Antes da
    // emenda, começar a transmitir custava um round-trip com aquele espectador — e represar
    // a oferta fora de `stable` era o que impedia o par de ficar sem vídeo para sempre.
    expect(reservados(pc).tela.sender.track).toBe(track);
    expect(pc.createOffer).not.toHaveBeenCalled();
  });

  it("o som da tela vai no m-line 3, e não no da voz", async () => {
    const r = await comChamada();
    const pc = r.criadas[0]!;
    const som = { kind: "audio" } as MediaStreamTrack;

    await r.malha.enviarTrilha(PAR, som, {} as MediaStream);

    expect(reservados(pc).telaAudio.sender.track).toBe(som);
    // O m-line 0 continua com o microfone: escrever a tela nele calaria a pessoa.
    expect(reservados(pc).voz.sender.track).not.toBe(som);
  });

  it("volta a `stable` sem nada represado não gera oferta à toa", async () => {
    const r = await comChamada();
    const pc = r.criadas[0]! as unknown as { onsignalingstatechange: (() => void) | null };
    (r.porta.signal as ReturnType<typeof vi.fn>).mockClear();
    pc.onsignalingstatechange?.();
    await Promise.resolve();
    expect(r.porta.signal).not.toHaveBeenCalled();
  });

  it("a perda é a do INTERVALO, não a acumulada desde o começo da transmissão", async () => {
    const r = await comChamada();
    const pc = r.criadas[0]! as unknown as { getStats: ReturnType<typeof vi.fn> };
    const envio = (await r.malha.enviarTrilha(PAR, { kind: "video" } as MediaStreamTrack, {} as MediaStream))!;

    // Primeira leitura: rajada de 10 perdidos em 100 enviados.
    pc.getStats.mockResolvedValueOnce(
      relatorio([
        { type: "remote-inbound-rtp", roundTripTime: 0.05, packetsLost: 10 },
        { type: "outbound-rtp", packetsSent: 100 },
      ]),
    );
    expect(await envio.estatisticas()).toEqual({ rttMs: 50, lossPct: 10 });

    // Segunda leitura: mais 100 pacotes e NENHUMA perda nova. O acumulado ainda é 10/200
    // (5%), mas o intervalo é 0/100 — e é o intervalo que a degradação de §17.5 deve ler,
    // senão uma rajada inicial prenderia o espectador no perfil baixo para sempre.
    pc.getStats.mockResolvedValueOnce(
      relatorio([
        { type: "remote-inbound-rtp", roundTripTime: 0.02, packetsLost: 10 },
        { type: "outbound-rtp", packetsSent: 200 },
      ]),
    );
    expect(await envio.estatisticas()).toEqual({ rttMs: 20, lossPct: 0 });
  });
});

describe("leituraDeSaida — os contadores crus do RTCStatsReport", () => {
  it("a perda vem do relatório do RECEPTOR, e os contadores saem acumulados", () => {
    expect(
      leituraDeSaida(
        relatorio([
          { type: "remote-inbound-rtp", roundTripTime: 0.1, packetsLost: 7 },
          { type: "outbound-rtp", packetsSent: 700 },
        ]),
      ),
    ).toEqual({ rttMs: 100, perdidosAcumulados: 7, enviadosAcumulados: 700 });
  });

  it("relatório sem nada medível é `null`, não zero — zero seria uma medida inventada", () => {
    expect(leituraDeSaida(relatorio([{ type: "outbound-rtp", packetsSent: 10 }]))).toBeNull();
  });
});

describe("definirMudo — §17.4 L-12: o mudo do próprio microfone é EFETIVO", () => {
  async function emChamada() {
    const r = montar([ticket(EU, PAR)], [EU, PAR]);
    await r.malha.entrar({
      communityId: "c",
      channelId: "ch",
      euHex: EU,
      microfoneId: "default",
      agora: 0,
    });
    return r;
  }

  /**
   * A regressão do que o smoke em duas máquinas mostrou: `voice.setSelf` contava ao host, o
   * ícone acendia do outro lado — e a trilha continuava transmitindo. O ícone mentia.
   */
  it("mudo desliga a trilha do microfone, não só o ícone", async () => {
    const r = await emChamada();
    expect(r.trilhasDeAudio[0]!.enabled).toBe(true);
    r.malha.definirMudo(true);
    expect(r.trilhasDeAudio[0]!.enabled).toBe(false);
    r.malha.definirMudo(false);
    expect(r.trilhasDeAudio[0]!.enabled).toBe(true);
  });

  it("fora de chamada não quebra — não há trilha para desligar", () => {
    const r = montar([], []);
    expect(() => r.malha.definirMudo(true)).not.toThrow();
  });
});

describe("prazo de conexão — sozinho na chamada não é falha", () => {
  /**
   * O log do smoke mostrava `FALHOU · candidatos vistos: nenhum` logo depois de
   * `join ok · roster 1`: entrar sozinho num canal de voz armava o relógio de 20 s e a tela
   * anunciava `conn-failed` para uma chamada que nunca tentou conectar nada.
   */
  it("entrar sem par nenhum NÃO arma o prazo", async () => {
    vi.useFakeTimers();
    try {
      const r = montar([], [EU]);
      const aoFalhar = vi.fn();
      const solo = new MalhaDeVoz(r.porta, r.midia, {
        aoMudarPar: vi.fn(),
        aoChegarAudio: vi.fn(),
        aoFalhar,
        aoSair: vi.fn(),
      });
      await solo.entrar({ communityId: "c", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(aoFalhar).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("com par, o prazo continua valendo — L-11 segue sendo estado desenhado", async () => {
    vi.useFakeTimers();
    try {
      const r = montar([ticket(EU, PAR)], [EU, PAR]);
      const aoFalhar = vi.fn();
      const comPar = new MalhaDeVoz(r.porta, r.midia, {
        aoMudarPar: vi.fn(),
        aoChegarAudio: vi.fn(),
        aoFalhar,
        aoSair: vi.fn(),
      });
      await comPar.entrar({ communityId: "c", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(aoFalhar).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ficar sozinho de novo desarma o prazo em vez de deixá-lo disparar", async () => {
    vi.useFakeTimers();
    try {
      const r = montar([ticket(EU, PAR)], [EU, PAR]);
      const aoFalhar = vi.fn();
      const malha = new MalhaDeVoz(r.porta, r.midia, {
        aoMudarPar: vi.fn(),
        aoChegarAudio: vi.fn(),
        aoFalhar,
        aoSair: vi.fn(),
      });
      await malha.entrar({ communityId: "c", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 });
      malha.aplicarRoster([{ keyHex: EU }]); // o outro saiu
      await vi.advanceTimersByTimeAsync(30_000);
      expect(aoFalhar).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("§17.2 (emenda de 2026-09-03) — quem é o quê se lê na POSIÇÃO, e B41 fecha", () => {
  /** Uma trilha recebida, com o mute que a emenda torna observável. */
  function recebida(kind: "audio" | "video", muted = false): MediaStreamTrack {
    return { kind, muted, onmute: null, onunmute: null, onended: null } as unknown as MediaStreamTrack;
  }

  async function comPar() {
    const r = montar([ticket(EU, PAR)], [EU, PAR]);
    await r.malha.entrar({ communityId: "c", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 });
    return { ...r, pc: r.criadas[0]!, tx: reservados(r.criadas[0]!) };
  }

  it("o m-line 0 é a voz; o m-line 3 é o som da tela, e ele NÃO toca no `<audio>` da voz", async () => {
    const { pc, tx, eventos } = await comPar();
    const voz = streamFalso("stream-da-voz");

    pc.ontrack?.({ track: recebida("audio"), streams: [voz], transceiver: tx.voz } as unknown as RTCTrackEvent);
    expect(eventos.aoChegarAudio).toHaveBeenCalledTimes(1);
    expect(eventos.aoChegarAudio).toHaveBeenCalledWith(PAR, voz);

    // O som da tela chega pelo m-line 3. Passá-lo ao `<audio>` da voz trocaria o `srcObject`
    // daquele par e a voz dele sumiria — "parou de falar quando começou a compartilhar".
    pc.ontrack?.({
      track: recebida("audio"),
      streams: [streamFalso("stream-da-tela")],
      transceiver: tx.telaAudio,
    } as unknown as RTCTrackEvent);
    expect(eventos.aoChegarAudio).toHaveBeenCalledTimes(1);
  });

  it("câmera e tela chegam NOMEADAS, sem `msid` a cruzar e sem `share.join` a consultar", async () => {
    const { pc, tx, eventos } = await comPar();
    const cam = recebida("video");
    const tela = recebida("video");

    pc.ontrack?.({ track: cam, streams: [streamFalso("a")], transceiver: tx.camera } as unknown as RTCTrackEvent);
    pc.ontrack?.({ track: tela, streams: [streamFalso("b")], transceiver: tx.tela } as unknown as RTCTrackEvent);

    // **B41.** Antes desta emenda, as duas eram indistinguíveis no fio e quem recebia
    // adivinhava; numa conversa direta não havia sequer `share.join` de que partir.
    expect(eventos.aoChegarVideo).toHaveBeenCalledWith(PAR, expect.anything(), cam, "camera");
    expect(eventos.aoChegarVideo).toHaveBeenCalledWith(PAR, expect.anything(), tela, "tela");
  });

  it("trilha MUDA não é imagem: o evento espera o `unmute`", async () => {
    const { pc, tx, eventos } = await comPar();
    const cam = recebida("video", true);

    // Com os m-lines reservados, `ontrack` acontece na primeira negociação para os quatro,
    // com as trilhas mudas. Anunciar aqui faria a UI acender a câmera de quem não a ligou.
    pc.ontrack?.({ track: cam, streams: [streamFalso("a")], transceiver: tx.camera } as unknown as RTCTrackEvent);
    expect(eventos.aoChegarVideo).not.toHaveBeenCalled();

    (cam.onunmute as unknown as () => void)();
    expect(eventos.aoChegarVideo).toHaveBeenCalledWith(PAR, expect.anything(), cam, "camera");

    // E parar é observável — a metade que `removeTrack` não dava, porque ausência não é evento.
    (cam.onmute as unknown as () => void)();
    expect(eventos.aoSumirVideo).toHaveBeenCalledWith(PAR, "camera");
  });

  it("o objeto do transceiver NÃO precisa ser o mesmo: o que decide é o `mid`", async () => {
    const { pc, eventos } = await comPar();
    const cam = recebida("video");

    /*
     * **A regressão que o `smoke:voz` achou e a unidade não achava.** Do lado que
     * RESPONDE, quem associa m-line a transceiver é o `setRemoteDescription`, e o objeto
     * que chega no `ontrack` não é necessariamente o que este lado criou. Comparar por
     * identidade fazia as quatro trilhas caírem em "m-line não reservado": a negociação
     * inteira parecia sã, o ICE conectava, e a chamada ficava sem áudio.
     */
    const outroObjeto = { mid: "1" } as RTCRtpTransceiver;
    pc.ontrack?.({
      track: cam,
      streams: [streamFalso("a")],
      transceiver: outroObjeto,
    } as unknown as RTCTrackEvent);

    expect(eventos.aoChegarVideo).toHaveBeenCalledWith(PAR, expect.anything(), cam, "camera");
  });

  it("m-line fora da tabela normativa é DESCARTADO, não adivinhado", async () => {
    const { pc, eventos } = await comPar();
    pc.ontrack?.({
      track: recebida("video"),
      streams: [streamFalso("x")],
      transceiver: { mid: "9" } as RTCRtpTransceiver,
    } as unknown as RTCTrackEvent);
    expect(eventos.aoChegarVideo).not.toHaveBeenCalled();
    expect(eventos.aoChegarAudio).not.toHaveBeenCalled();
  });
});

describe("§17.2 — o aviso de STUN de terceiro conta ENDEREÇO, não posição", () => {
  it("o host servindo stun: e turn: no mesmo endereço continua sendo UM host", () => {
    // A conta antiga era `length - 1` e pressupunha uma entrada por host. Com o `turn:` de
    // §17.3 na mesma socket, ela acusava um terceiro que não existe.
    expect(
      contarTerceiros([
        { urls: "stun:203.0.113.9:49737" },
        { urls: "turn:203.0.113.9:49737?transport=udp" },
        { urls: "stun:stun.l.google.com:19302" },
      ]),
    ).toBe(1);
  });

  it("só o host, em uma ou duas entradas, não gera aviso nenhum", () => {
    expect(contarTerceiros([{ urls: "stun:203.0.113.9:49737" }])).toBe(0);
    expect(
      contarTerceiros([
        { urls: "stun:203.0.113.9:49737" },
        { urls: "turn:203.0.113.9:49737?transport=udp" },
      ]),
    ).toBe(0);
  });

  it("lista vazia não avisa — é a L-11, e ela já tem o seu próprio texto", () => {
    expect(contarTerceiros([])).toBe(0);
  });

  // ── O defeito que a conta por posição escondia (§99) ────────────────────────────────
  it("host SEM endereço público: o terceiro sozinho é contado, não confundido com o host", () => {
    // `MediaHost.iceServers()` devolve `[...doHost, ...terceiros]`, e `doHost` é VAZIO
    // quando não há endereço público observado — a L-11 exata de §80. A conta antiga tomava
    // `servers[0]` por host, dava 0, e o aviso de §17.2 ficava calado justamente na chamada
    // em que o terceiro é o ÚNICO servidor em uso.
    expect(contarTerceiros([{ urls: "stun:stun.l.google.com:19302" }])).toBe(1);
    expect(
      contarTerceiros([{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }]),
    ).toBe(2);
  });

  it("com a marca do núcleo (§99.13) não há heurística nenhuma — nem no caso da L-11", () => {
    expect(contarTerceiros([{ urls: "stun:stun.l.google.com:19302", terceiro: true }])).toBe(1);
    expect(
      contarTerceiros([{ urls: "stun:203.0.113.9:49737" }, { urls: "stun:198.51.100.7:3478", terceiro: true }]),
    ).toBe(1);
  });

  it("o `turn:` identifica o host mesmo quando o terceiro é IP literal", () => {
    // §17.3 — "não há TURN de terceiro e não haverá"; o parser de `P2P_STUN_SERVERS`
    // descarta `turn:`. Um `turn:` na lista é do host, e é a identificação EXATA.
    expect(
      contarTerceiros([
        { urls: "stun:203.0.113.9:49737" },
        { urls: "turn:203.0.113.9:49737?transport=udp" },
        { urls: "stun:198.51.100.7:3478" },
      ]),
    ).toBe(1);
  });
});

describe("§99 — a família do candidato, que é onde o IPv6 aparece", () => {
  it("lê o campo 4 da linha de SDP, e não `address`, que o navegador ofusca", () => {
    expect(familiaDoCandidato({ candidate: "candidate:1 1 udp 2122260223 192.168.0.10 54321 typ host" })).toBe("ipv4");
    expect(familiaDoCandidato({ candidate: "candidate:2 1 udp 2122194687 2804:14d:1::1 54322 typ host" })).toBe("ipv6");
    expect(familiaDoCandidato({ candidate: "candidate:3 1 udp 1 a0b1c2d3-e4f5.local 54323 typ host" })).toBe("mdns");
  });

  it("sem linha de SDP cai para `address`, e sem nenhum dos dois é `null`", () => {
    expect(familiaDoCandidato({ address: "2001:db8::1" })).toBe("ipv6");
    expect(familiaDoCandidato({})).toBeNull();
  });
});

describe("§99 — `motivoDaFalha` separa as falhas que pedem ações OPOSTAS", () => {
  const obs = (
    tipos: string[],
    familias: Array<"ipv4" | "ipv6" | "mdns"> = ["ipv4"],
    turnAnunciado = false,
  ) => ({ tipos: new Set(tipos), familias: new Set(familias), turnAnunciado });

  it("nenhum candidato é UDP bloqueado, não L-11", () => {
    expect(motivoDaFalha(obs([], [])).codigo).toBe("sem-candidatos");
  });

  it("só `host` sem IPv6 é a L-11 clássica — quem hospeda não tem porta", () => {
    const m = motivoDaFalha(obs(["host"]));
    expect(m.codigo).toBe("sem-endereco-publico");
    expect(m.texto).toContain("quem hospeda");
  });

  it("só `host` COM IPv6 não acusa o host: o endereço existe e é roteável", () => {
    // Um endereço IPv6 não passa por NAT nenhum. Se ele está aqui e a chamada não fecha,
    // quem não o tem é o outro lado — mandar consertar o host seria a máquina errada.
    const m = motivoDaFalha(obs(["host"], ["ipv4", "ipv6"]));
    expect(m.codigo).toBe("so-ipv6-local");
    expect(m.texto).not.toContain("quem hospeda");
  });

  it("com `srflx` e sem relay é NAT simétrico, e o texto NÃO culpa quem hospeda", () => {
    // O erro que a versão anterior cometia: mandava este caso para a frase genérica, e a
    // investigação de §80 não conseguia separá-lo da L-11. São causas diferentes: aqui os
    // dois lados TÊM endereço público, e o que falta é relay.
    const m = motivoDaFalha(obs(["host", "srflx"]));
    expect(m.codigo).toBe("furo-falhou");
    expect(m.texto).toContain("relay");
    expect(m.texto).not.toContain("quem hospeda");
  });

  it("com `srflx`, TURN anunciado e sem `relay`: o relay é o caminho e não abriu", () => {
    expect(motivoDaFalha(obs(["host", "srflx"], ["ipv4"], true)).codigo).toBe("turn-nao-alocou");
  });

  it("com `relay` coletado e ainda assim sem conexão, a culpa não é do endereço", () => {
    expect(motivoDaFalha(obs(["host", "srflx", "relay"], ["ipv4"], true)).codigo).toBe("relay-falhou");
  });
});

// ─── B47 — volume de entrada e troca de microfone DURANTE a chamada ────────────────────

describe("B47 — o que sai por malha passa pelo volume de entrada", () => {
  /** `AudioContext` de mentira: fonte → ganho → destino, com a trilha de saída observável. */
  function ctxFalso() {
    const trilhaSaida = { kind: "audio", enabled: true, stop: vi.fn() };
    const ligavel = () => ({ connect: vi.fn((x: unknown) => x), disconnect: vi.fn() });
    const ganho = { ...ligavel(), gain: { value: 1 } };
    const ctx = {
      createMediaStreamSource: vi.fn(() => ligavel()),
      createGain: vi.fn(() => ganho),
      createMediaStreamDestination: vi.fn(() => ({
        ...ligavel(),
        stream: { getAudioTracks: () => [trilhaSaida] },
      })),
      // O VAD da malha também abre um contexto: o analisador lê a saída dele.
      createAnalyser: vi.fn(() => ({
        ...ligavel(),
        fftSize: 512,
        getFloatTimeDomainData: vi.fn(),
      })),
      resume: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    return { ctx, ganho, trilhaSaida };
  }

  /** Monta com um `AudioContext` falso no global e um par na chamada. */
  async function comGanho() {
    const { ctx, ganho, trilhaSaida } = ctxFalso();
    vi.stubGlobal("AudioContext", function () {
      return ctx;
    });
    try {
      const r = montar([ticket(EU, PAR)], [EU, PAR]);
      await r.malha.entrar({ communityId: "c", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 });
      return { ...r, ganho, trilhaSaida, ctx };
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it("a trilha que ENTRA no m-line 0 é a do destino (pós-ganho), não o mic cru", async () => {
    const r = await comGanho();
    expect(reservados(r.criadas[0]!).voz.sender.track).toBe(r.trilhaSaida);
  });

  it("definirVolumeEntrada aplica o ganho ao vivo (100 → 1.0, 60 → 0.6)", async () => {
    const r = await comGanho();
    expect(r.ganho.gain.value).toBe(1);
    r.malha.definirVolumeEntrada(60);
    expect(r.ganho.gain.value).toBeCloseTo(0.6);
    r.malha.definirVolumeEntrada(150);
    expect(r.ganho.gain.value).toBe(1); // fora da faixa é limitado, não inventado
  });

  it("sem AudioContext sai o mic cru — nada quebra", async () => {
    const r = montar([ticket(EU, PAR)], [EU, PAR]);
    await r.malha.entrar({ communityId: "c", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 });
    expect(reservados(r.criadas[0]!).voz.sender.track).toBe(r.trilhasDeAudio[0]);
  });
});

describe("B47 — trocar de microfone em chamada", () => {
  it("re-captura, substitui a trilha em cada par, re-aplica o mudo e para o mic antigo", async () => {
    const micNovo = { kind: "audio", enabled: true, stop: vi.fn() };
    const { malha, midia, criadas, trilhasDeAudio } = montar([ticket(EU, PAR)], [EU, PAR]);
    await malha.entrar({ communityId: "c", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 });
    (midia.capturar as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      getTracks: () => [micNovo],
      getAudioTracks: () => [micNovo],
    }));

    await malha.trocarMicrofone("dev-novo");

    // A trilha nova substituiu a antiga NO M-LINE 0 daquele par. A conexão tem dois áudios
    // desde a emenda de 2026-09-03, e endereçar por `kind` podia acertar o da tela.
    expect(reservados(criadas[0]!).voz.sender.track).toBe(micNovo as unknown as MediaStreamTrack);
    expect(reservados(criadas[0]!).telaAudio.sender.track).toBeNull();
    // ...o mic antigo foi parado (não fica preso ao dispositivo)...
    expect(trilhasDeAudio[0]!.stop).toHaveBeenCalled();
    expect(micNovo.stop).not.toHaveBeenCalled();
    // ...e o mudo próprio reaparece no trilho novo (a preferência é da pessoa).
    malha.definirMudo(true);
    expect(micNovo.enabled).toBe(false);
  });

  it("fora de chamada é no-op — a próxima captura lê a escolha nova", async () => {
    const { malha, midia } = montar([], []);
    await malha.trocarMicrofone("dev-novo");
    expect(midia.capturar).not.toHaveBeenCalled();
  });
});

// ─── Microfone ausente — somente-escuta, nunca saída ────────────────────────────

describe("Microfone ausente — a chamada segue em somente-escuta", () => {
  function falhaDeCaptura(nome: string): Error {
    return Object.assign(new Error("dispositivo sumiu"), { name: nome });
  }

  /** A trilha de mentira com `stop` que se comporta como a de verdade: parar dispara `ended`. */
  function trilhaViva() {
    const t = { kind: "audio", enabled: true, stop: vi.fn(), onended: null as (() => void) | null };
    (t.stop as ReturnType<typeof vi.fn>).mockImplementation(() => {
      t.onended?.();
    });
    return t;
  }

  it("entrar sem microfone ENTRA: resolve em somente-escuta, sem leave, com o motivo nomeado", async () => {
    const { malha, porta, midia, criadas } = montar([ticket(EU, PAR)], [EU, PAR]);
    (midia.capturar as ReturnType<typeof vi.fn>).mockRejectedValueOnce(falhaDeCaptura("NotFoundError"));
    const r = await malha.entrar({ communityId: "c", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 });
    expect(r.sessionId).toBe("s1");
    expect(r.microfoneAusente).toBe("O microfone escolhido não está mais disponível.");
    // O join foi aceito e fica de pé: sem mic não há expulsão, há escuta.
    expect(malha.sessionId).toBe("s1");
    expect(porta.leave).not.toHaveBeenCalled();
    expect(criadas.length).toBe(1);
    expect(malha.streamLocal).toBeNull();
    expect(malha.nivelDeVoz()).toBeNull();
  });

  it("com microfone, o desfecho diz que está tudo bem", async () => {
    const { malha } = montar([ticket(EU, PAR)], [EU, PAR]);
    const r = await malha.entrar({ communityId: "c", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 });
    expect(r.microfoneAusente).toBeNull();
  });

  it("o mic que morre no meio da chamada avisa — e a chamada continua de pé", async () => {
    const { malha, porta, trilhasDeAudio, eventos } = montar([ticket(EU, PAR)], [EU, PAR]);
    await malha.entrar({ communityId: "c", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 });
    const trilha = trilhasDeAudio[0]! as unknown as { onended: (() => void) | null };
    expect(typeof trilha.onended).toBe("function");
    trilha.onended!();
    expect(eventos.aoMicrofoneAusente).toHaveBeenCalledWith("O microfone foi desconectado.");
    expect(malha.sessionId).toBe("s1");
    expect(porta.leave).not.toHaveBeenCalled();
  });

  it("parar por decisão do produto não vira aviso: nem a troca, nem a saída", async () => {
    const { malha, midia, trilhasDeAudio, eventos } = montar([ticket(EU, PAR)], [EU, PAR]);
    await malha.entrar({ communityId: "c", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 });
    // O duplo reproduz a trilha de verdade, que dispara `ended` no `stop`: sem o
    // desarme antes de parar, a troca anunciaria ausência no instante da cura.
    const antiga = trilhasDeAudio[0]! as unknown as {
      onended: (() => void) | null;
      stop: ReturnType<typeof vi.fn>;
    };
    antiga.stop.mockImplementation(() => {
      antiga.onended?.();
    });
    const micNovo = trilhaViva();
    (midia.capturar as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      getTracks: () => [micNovo],
      getAudioTracks: () => [micNovo],
    }));
    await malha.trocarMicrofone("dev-novo");
    expect(eventos.aoMicrofoneAusente).not.toHaveBeenCalled();
    await malha.sair();
    expect(eventos.aoMicrofoneAusente).not.toHaveBeenCalled();
  });

  it("a troca recupera o somente-escuta: o mic novo transmite, sem aviso pendente", async () => {
    const { malha, midia, criadas, eventos } = montar([ticket(EU, PAR)], [EU, PAR]);
    (midia.capturar as ReturnType<typeof vi.fn>).mockRejectedValueOnce(falhaDeCaptura("NotFoundError"));
    const r = await malha.entrar({ communityId: "c", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 });
    expect(r.microfoneAusente).not.toBeNull();
    const micNovo = { kind: "audio", enabled: true, stop: vi.fn(), onended: null };
    (midia.capturar as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      getTracks: () => [micNovo],
      getAudioTracks: () => [micNovo],
    }));
    await malha.trocarMicrofone("dev-novo");
    expect(malha.streamLocal).not.toBeNull();
    expect(eventos.aoMicrofoneAusente).not.toHaveBeenCalled();
    expect(reservados(criadas[0]!).voz.sender.track).toBe(micNovo as unknown as MediaStreamTrack);
  });

  it("sair() repassa o sessionId para porta.leave({ sessionId }) (§15.4 / Lacuna 2)", async () => {
    const { malha, porta } = montar([ticket(EU, PAR)], [EU, PAR]);
    await malha.entrar({ communityId: "c", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 });
    await malha.sair();
    expect(porta.leave).toHaveBeenCalledWith({ sessionId: "s1" });
  });

  it("concorrência entre entrar e sair cancela continuação de entrar superado", async () => {
    let resolverJoin!: (val: unknown) => void;
    const porta = {
      join: vi.fn(() => new Promise((resolve) => { resolverJoin = resolve; })),
      leave: vi.fn(async () => undefined),
      signal: vi.fn(async () => undefined),
    };
    const midia = {
      capturar: vi.fn(async () => ({ getTracks: () => [], getAudioTracks: () => [] })),
      conexao: vi.fn(),
    };
    const malha = new MalhaDeVoz(porta as unknown as PortaDeVoz, midia as never, { aoFalhar: vi.fn(), aoMudarPar: vi.fn(), aoChegarAudio: vi.fn(), aoSair: vi.fn() });

    const pEntrar = malha.entrar({ communityId: "c", channelId: "ch1", euHex: EU, microfoneId: "default", agora: 0 });
    const pSair = malha.sair();

    await new Promise((r) => setTimeout(r, 10));

    resolverJoin({
      sessionId: "sess-antiga",
      roster: [{ keyHex: EU }, { keyHex: PAR }],
      iceServers: [],
      tickets: [ticket(EU, PAR)],
    });

    await pEntrar;
    await pSair;

    expect(malha.streamLocal).toBeNull();
  });
});


// ─── §99.13 — a coleta em duas fases, que devolve a garantia que §17.2 prometia ────────

describe("§99.13 — `separarPorOrigem` usa a marca do núcleo, não a posição", () => {
  it("com marca, o host é quem NÃO está marcado — mesmo sendo a segunda entrada", () => {
    const r = separarPorOrigem([
      { urls: "stun:stun.l.google.com:19302", terceiro: true },
      { urls: "stun:203.0.113.9:49737" },
    ]);
    expect(r.doHost.map((s) => s.urls)).toEqual(["stun:203.0.113.9:49737"]);
    expect(r.temTerceiro).toBe(true);
  });

  it("host sem endereço público: a marca diz que a lista é SÓ terceiro", () => {
    // O caso da L-11, e o que a conta por posição errava (§99.3).
    const r = separarPorOrigem([{ urls: "stun:stun.l.google.com:19302", terceiro: true }]);
    expect(r.doHost).toEqual([]);
    expect(r.temTerceiro).toBe(true);
  });

  it("lista sem marca nenhuma e sem terceiro é toda do host", () => {
    const r = separarPorOrigem([{ urls: "stun:203.0.113.9:49737" }]);
    expect(r.doHost.length).toBe(1);
    expect(r.temTerceiro).toBe(false);
  });
});

describe("§99.13 — a fase 1 não entrega o terceiro ao agente antes de o host falhar", () => {
  const doHost = { urls: "stun:203.0.113.9:49737" };
  const terceiro = { urls: "stun:stun.l.google.com:19302", terceiro: true };

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function entrar(lista: RTCIceServer[]) {
    const m = montar([ticket(EU, PAR)], [EU, PAR], lista);
    await m.malha.entrar({ communityId: "c", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 });
    await vi.advanceTimersByTimeAsync(0);
    return m;
  }

  it("a primeira conexão nasce SÓ com o servidor do host", async () => {
    const { midia } = await entrar([doHost, terceiro]);
    const cfg = (midia.conexao as unknown as { mock: { calls: RTCConfiguration[][] } }).mock.calls[0]?.[0];
    expect(cfg?.iceServers).toEqual([doHost]);
  });

  it("`srflx` dentro do prazo: o terceiro NUNCA é consultado — a garantia de §17.2", async () => {
    const { midia, criadas } = await entrar([doHost, terceiro]);
    const pc = criadas[0]!;
    // O STUN do host respondeu.
    pc.onicecandidate?.({
      candidate: { type: "srflx", protocol: "udp", candidate: "candidate:1 1 udp 1 203.0.113.9 1 typ srflx", toJSON: () => ({}) },
    } as unknown as RTCPeerConnectionIceEvent);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pc.setConfiguration).not.toHaveBeenCalled();
    expect(pc.restartIce).not.toHaveBeenCalled();
    // E nenhuma conexão nova nasceu com o terceiro.
    for (const call of (midia.conexao as unknown as { mock: { calls: RTCConfiguration[][] } }).mock.calls) {
      expect(call[0]?.iceServers).toEqual([doHost]);
    }
  });

  it("sem `srflx` no prazo: escala para a lista inteira com `setConfiguration` + `restartIce`", async () => {
    const { criadas } = await entrar([doHost, terceiro]);
    const pc = criadas[0]!;
    pc.onicecandidate?.({
      candidate: { type: "host", protocol: "udp", candidate: "candidate:1 1 udp 1 192.168.0.2 1 typ host", toJSON: () => ({}) },
    } as unknown as RTCPeerConnectionIceEvent);
    await vi.advanceTimersByTimeAsync(2_600);
    expect(pc.setConfiguration).toHaveBeenCalledWith({ iceServers: [doHost, terceiro] });
    expect(pc.restartIce).toHaveBeenCalled();
  });

  it("host SEM endereço público não paga espera nenhuma: nasce já na fase 2", async () => {
    // Nada a tentar primeiro — cobrar 2,5 s de quem está na L-11 pura seria taxa sem
    // contrapartida, e é o caso em que o terceiro é o único caminho que existe.
    const { midia, criadas } = await entrar([terceiro]);
    const cfg = (midia.conexao as unknown as { mock: { calls: RTCConfiguration[][] } }).mock.calls[0]?.[0];
    expect(cfg?.iceServers).toEqual([terceiro]);
    await vi.advanceTimersByTimeAsync(2_600);
    expect(criadas[0]!.setConfiguration).not.toHaveBeenCalled();
  });

  it("sem terceiro na lista não há fase nenhuma a cumprir", async () => {
    const { midia } = await entrar([doHost]);
    const cfg = (midia.conexao as unknown as { mock: { calls: RTCConfiguration[][] } }).mock.calls[0]?.[0];
    expect(cfg?.iceServers).toEqual([doHost]);
  });

  it("a renovação de credencial NÃO desfaz a fase 1", async () => {
    // `voice.tickets` traz a lista inteira a cada TTL/3. Aplicá-la crua entregaria o
    // terceiro ao agente antes de o host ter falhado — o que a fase 1 existe para impedir.
    const { malha, criadas } = await entrar([doHost, terceiro]);
    malha.aplicarIceServers([doHost, terceiro]);
    expect(criadas[0]!.setConfiguration).toHaveBeenCalledWith({ iceServers: [doHost] });
  });
});

// ─── §31.15 — a autorização por transporte (B62 / §109) ────────────────────────────────

describe("§31.15 — sem ticket, quem autoriza é o cabo", () => {
  const EU = "aa".repeat(32);
  const PAR = "bb".repeat(32);

  it("um roster com zero tickets NÃO negocia com ninguém: é o passo 4 de §17.4, e ele fica", async () => {
    const r = montar([], [EU, PAR]);
    await r.malha.entrar({ communityId: "c", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 });
    await r.malha.aplicarSinal({ peerKey: PAR, ticketId: "", sdp: JSON.stringify({ type: "offer", sdp: "v=0" }) });
    // Nenhuma resposta saiu: sem ticket o sinal é ignorado. Numa comunidade isso é a
    // propriedade que `T-15` fecha, e ela não pode ser afrouxada por engano.
    expect(r.porta.signal).not.toHaveBeenCalled();
  });

  it("com `autorizacaoPorTransporte` o roster É a autorização, e o `ticketId` sai vazio", async () => {
    const r = montar([], [EU, PAR], undefined, true);
    await r.malha.entrar({ communityId: "c", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 });
    await r.malha.aplicarSinal({ peerKey: PAR, ticketId: "", sdp: JSON.stringify({ type: "offer", sdp: "v=0" }) });
    expect(r.porta.signal).toHaveBeenCalled();
    const enviado = (r.porta.signal as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as {
      peerKey: string;
      ticketId: string;
    };
    expect(enviado.peerKey).toBe(PAR);
    // Não há ticket a citar (§31.15): o campo existe na porta de §15.4 e vai vazio.
    expect(enviado.ticketId).toBe("");
  });

  it("a marca não autoriza a MIM mesmo: `euHex` fora do conjunto, como em `paresAutorizados`", async () => {
    const r = montar([], [EU], undefined, true);
    await r.malha.entrar({ communityId: "c", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 });
    await r.malha.aplicarSinal({ peerKey: EU, ticketId: "", sdp: JSON.stringify({ type: "offer", sdp: "v=0" }) });
    expect(r.porta.signal).not.toHaveBeenCalled();
  });
});


describe("§17.2 (emenda de 2026-09-03) — quem RESPONDE adota os m-lines da oferta", () => {
  /**
   * Os dois defeitos desta metade foram medidos em `smoke:voz`, e nenhum deles aparece de
   * um lado só: a chamada conectava, o ICE fechava, e o áudio ia num sentido só.
   */
  async function comOfertaRecebida() {
    const r = montar([ticket(EU, PAR_MENOR)], [EU, PAR_MENOR]);
    await r.malha.entrar({ communityId: "c", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 });
    // PAR_MENOR oferta primeiro (chave menor), então este lado RESPONDE.
    await r.malha.aplicarSinal({
      peerKey: PAR_MENOR,
      ticketId: "t",
      sdp: JSON.stringify({ type: "offer", sdp: "v=0" }),
    });
    return { ...r, pc: r.criadas[0]! };
  }

  it("a trilha local entra nos m-lines NEGOCIADOS, não em transceivers próprios órfãos", async () => {
    const r = await comOfertaRecebida();
    const tx = r.pc.getTransceivers();

    // Um transceiver criado por `addTransceiver` **não** recebe m-line de oferta remota. Se
    // este lado pré-criasse os quatro, ficaria com oito — quatro órfãos segurando as
    // trilhas, quatro negociados vazios — e não transmitiria nada.
    expect(tx.length).toBe(4);
    expect(tx[0]!.sender.track).toBe(r.trilhasDeAudio[0]);
  });

  it("adotar força `sendrecv`: o transceiver criado pelo navegador nasce `recvonly`", async () => {
    const r = await comOfertaRecebida();
    // `replaceTrack` põe a trilha no sender e NÃO mexe na direção: sem esta correção a
    // resposta saía dizendo "só recebo", e este lado nunca transmitia.
    for (const t of r.pc.getTransceivers()) expect(t.direction).toBe("sendrecv");
  });

  it("uma negociação sem os quatro m-lines não é adotada — a voz não sai pelo m-line da tela", async () => {
    const r = montar([ticket(EU, PAR_MENOR)], [EU, PAR_MENOR]);
    await r.malha.entrar({ communityId: "c", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 });
    const pc = r.criadas[0]!;
    // Só dois m-lines: não é a tabela normativa deste produto.
    pc.addTransceiver("audio");
    pc.addTransceiver("video");

    await r.malha.aplicarSinal({
      peerKey: PAR_MENOR,
      ticketId: "t",
      sdp: JSON.stringify({ type: "offer", sdp: "v=0" }),
    });

    // Forçar uma leitura aqui poria a voz num m-line que não é o dela.
    expect(pc.getTransceivers()[0]!.sender.track).toBeNull();
  });
});

/**
 * §17.2 (correção de 2026-09-06) — **"há imagem" é medido, não deduzido do `unmute`.**
 *
 * O que `smoke:tela` mediu em Chromium real, com os quatro m-lines deste produto: a borda
 * de `unmute` sai UMA vez na vida da conexão, na primeira vez que chega RTP naquele
 * m-line. O `replaceTrack(null)` de quem para de apresentar **não** produz `mute` — nem
 * 12 s depois, com a trilha de origem parada — e o `replaceTrack` da transmissão seguinte,
 * portanto, não produz `unmute`. Os bytes voltam a chegar em silêncio.
 *
 * Era o defeito relatado: apresentar, parar, apresentar de novo, e os espectadores ficam
 * em "Preparando compartilhamento…" até o prazo de §17.5 estourar, com os pixels chegando
 * o tempo todo. Reentrar na chamada resolvia porque a conexão nova traz um `ontrack` novo,
 * e com ele a primeira borda.
 *
 * Verificado por mutação: sem o vigia, a segunda apresentação não anuncia nada.
 */
describe("§17.2 — a imagem que volta é medida (2026-09-06)", () => {
  /** Uma trilha do outro lado, como o receptor a entrega: muda até chegar RTP. */
  function recebida(kind: "audio" | "video", muted = false): MediaStreamTrack {
    return { kind, muted, onmute: null, onunmute: null, onended: null } as unknown as MediaStreamTrack;
  }

  /** Um `RTCStatsReport` com um `inbound-rtp` de vídeo naquele m-line. */
  function comBytes(mid: string, bytesReceived: number): RTCStatsReport {
    return new Map([["i0", { id: "i0", type: "inbound-rtp", kind: "video", mid, bytesReceived }]]) as unknown as RTCStatsReport;
  }

  async function comTelaNegociada() {
    const r = montar([ticket(EU, PAR)], [EU, PAR]);
    await r.malha.entrar({ communityId: "c", channelId: "ch", euHex: EU, microfoneId: "default", agora: 0 });
    const pc = r.criadas[0]!;
    const tx = reservados(pc);
    const tela = recebida("video", true);
    (tx.tela as unknown as { receiver: { track: MediaStreamTrack } }).receiver.track = tela;
    // A primeira negociação entrega os quatro m-lines com as trilhas mudas.
    pc.ontrack?.({ track: tela, streams: [streamFalso("t")], transceiver: tx.tela } as unknown as RTCTrackEvent);
    return { ...r, pc, tx, tela };
  }

  it("parar e voltar a apresentar é anunciado sem `unmute` nenhum", async () => {
    vi.useFakeTimers();
    try {
      const { pc, eventos, tela } = await comTelaNegociada();
      const stats = pc.getStats as ReturnType<typeof vi.fn>;
      const volta = async (bytes: number) => {
        stats.mockResolvedValue(comBytes("2", bytes));
        await vi.advanceTimersByTimeAsync(1_000);
      };

      // A primeira leitura é só referência: não há "cresceu" contra nada.
      await volta(1_000);
      expect(eventos.aoChegarVideo).not.toHaveBeenCalled();

      // 1ª apresentação — os bytes crescem e a tela é anunciada.
      await volta(2_000);
      expect(eventos.aoChegarVideo).toHaveBeenCalledTimes(1);
      expect(eventos.aoChegarVideo).toHaveBeenCalledWith(PAR, expect.anything(), tela, "tela");

      // Enquanto flui, não se anuncia a cada volta: seria um tique por segundo na UI.
      await volta(3_000);
      expect(eventos.aoChegarVideo).toHaveBeenCalledTimes(1);

      // Parar: os bytes param de crescer. **Nenhum `mute` chega** — é o que a medição diz.
      await volta(3_000);
      await volta(3_000);
      expect(eventos.aoChegarVideo).toHaveBeenCalledTimes(1);
      expect(eventos.aoSumirVideo).not.toHaveBeenCalled();

      // 2ª apresentação: `replaceTrack` do outro lado, sem borda nenhuma. É aqui que o
      // produto ficava surdo, e o espectador via "Preparando…" até o prazo estourar.
      await volta(4_000);
      expect(eventos.aoChegarVideo).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("o m-line diz o que é: bytes no 1 são câmera, e um m-line fora da tabela é ignorado", async () => {
    vi.useFakeTimers();
    try {
      const { pc, tx, eventos } = await comTelaNegociada();
      const cam = recebida("video", true);
      (tx.camera as unknown as { receiver: { track: MediaStreamTrack } }).receiver.track = cam;
      pc.ontrack?.({ track: cam, streams: [streamFalso("c")], transceiver: tx.camera } as unknown as RTCTrackEvent);

      const stats = pc.getStats as ReturnType<typeof vi.fn>;
      stats.mockResolvedValue(comBytes("1", 1_000));
      await vi.advanceTimersByTimeAsync(1_000);
      stats.mockResolvedValue(comBytes("1", 2_000));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(eventos.aoChegarVideo).toHaveBeenCalledWith(PAR, expect.anything(), cam, "camera");

      // O m-line 0 é voz e o 3 é som da tela: nenhum dos dois é "imagem chegando".
      eventos.aoChegarVideo.mockClear();
      stats.mockResolvedValue(comBytes("0", 9_000));
      await vi.advanceTimersByTimeAsync(1_000);
      stats.mockResolvedValue(comBytes("0", 99_000));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(eventos.aoChegarVideo).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
