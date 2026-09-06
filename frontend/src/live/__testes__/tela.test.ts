/**
 * §17.5 no renderer. O que dá para provar sem tela real e sem duas máquinas: a **ordem** de
 * `T-41`, o perfil por espectador, a reconciliação da audiência e o ciclo de saúde.
 *
 * O que NÃO é testado aqui porque não é daqui: o teto de 8 (`E_SESSION_FULL`) e a
 * autorização da sessão são decisões do **host** (`ShareHostSessions`), verificadas na suíte
 * do núcleo. Repeti-las aqui criaria uma segunda fonte de verdade para a mesma regra — o
 * mesmo motivo pelo qual `voz.test.ts` não testa o passo 3 de §17.4.
 *
 * A captura, a malha e a porta de §15.4 entram injetadas; nada aqui toca em WebRTC de
 * verdade.
 */
import { describe, expect, it, vi } from "vitest";

import { EstrelaDeTela } from "../tela";
import type { FabricaDeCaptura, PortaDaMalha, PortaDeTela } from "../tela";
import type { EnvioDeTrilha } from "../voz";

const EU = "aa".repeat(32);
const ESPECTADOR = "bb".repeat(32);
const OUTRO = "cc".repeat(32);

/** Uma trilha de mentira, com o rótulo que o sistema daria. */
function trilha(label = "Tela inteira", kind: "video" | "audio" = "video"): MediaStreamTrack {
  return { kind, label, stop: vi.fn(), onended: null } as unknown as MediaStreamTrack;
}

function stream(track: MediaStreamTrack, audio: MediaStreamTrack | null = null): MediaStream {
  return {
    getVideoTracks: () => [track],
    getAudioTracks: () => (audio === null ? [] : [audio]),
    getTracks: () => (audio === null ? [track] : [track, audio]),
  } as unknown as MediaStream;
}

function envioFalso(stats: { rttMs: number; lossPct: number } | null = { rttMs: 20, lossPct: 0 }) {
  return {
    definirBitrateKbps: vi.fn(async () => undefined),
    estatisticas: vi.fn(async () => stats),
    encerrar: vi.fn(async () => undefined),
  } satisfies EnvioDeTrilha & Record<string, unknown>;
}

function montar(
  opts: {
    pares?: string[];
    stats?: { rttMs: number; lossPct: number } | null;
    /** A captura entregou som junto — o caso de "áudio só da fonte escolhida" (§17.5). */
    comAudio?: boolean;
  } = {},
) {
  const ordem: string[] = [];
  const envios = new Map<string, ReturnType<typeof envioFalso>>();
  const track = trilha();
  const trackDeAudio = opts.comAudio === true ? trilha("Áudio da janela", "audio") : null;
  const midia = stream(track, trackDeAudio);

  const porta: PortaDeTela = {
    start: vi.fn(async () => {
      ordem.push("share.start");
      return { sessionId: "sess-1" };
    }),
    stop: vi.fn(async () => ({})),
    join: vi.fn(async () => ({ ticketId: "t1", presenterKey: OUTRO })),
    setQuality: vi.fn(async () => ({ applied: true })),
    report: vi.fn(async () => ({})),
  };

  const malha: PortaDaMalha = {
    pares: () => opts.pares ?? [ESPECTADOR],
    enviarTrilha: vi.fn(async (par: string, t: MediaStreamTrack) => {
      const e = envioFalso(opts.stats === undefined ? { rttMs: 20, lossPct: 0 } : opts.stats);
      // O mapa de envios é o do VÍDEO — é dele que fala o teto de banda de §17.5. O envio
      // de áudio é observado pelas chamadas de `enviarTrilha`, não por este mapa.
      if (t.kind === "video") envios.set(par, e);
      return e as unknown as EnvioDeTrilha;
    }),
  };

  const captura: FabricaDeCaptura = {
    declararSessao: vi.fn(async () => {
      ordem.push("declararSessao");
    }),
    capturar: vi.fn(async () => {
      ordem.push("getDisplayMedia");
      return midia;
    }),
  };

  const eventos = {
    aoFalhar: vi.fn(),
    aoEncerrarNaFonte: vi.fn(),
    aoMedir: vi.fn(),
  };

  const estrela = new EstrelaDeTela(porta, malha, captura, eventos);
  return { estrela, porta, malha, captura, eventos, ordem, envios, track, trackDeAudio, midia };
}

/** A declaração de "não estou capturando nada", que `parar` e a falha de captura repõem. */
const SEM_CAPTURA = { sessionId: null, kind: "screen", sourceId: null, audio: false };

describe("§17.5 — a ordem de T-41", () => {
  it("o host decide ANTES da captura: share.start, declaração, e só então getDisplayMedia", async () => {
    const { estrela, ordem } = montar();
    await estrela.apresentar({ communityId: "c1", channelId: "ch-voz", euHex: EU });
    // A ordem é a própria regra: capturar antes de saber se a permissão deixa passar
    // acenderia a luz da captura à toa (§76.4), e `T-41` a fixa explicitamente.
    expect(ordem).toEqual(["share.start", "declararSessao", "getDisplayMedia"]);
  });

  it("host recusando NUNCA chega a capturar", async () => {
    const { estrela, porta, captura } = montar();
    (porta.start as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error("negado"), { code: "E_PERMISSION_DENIED" }),
    );
    await expect(
      estrela.apresentar({ communityId: "c1", channelId: "ch-voz", euHex: EU }),
    ).rejects.toThrow();
    expect(captura.capturar).not.toHaveBeenCalled();
  });

  it("captura que falha desfaz a sessão no host e retira a declaração", async () => {
    const { estrela, porta, captura } = montar();
    (captura.capturar as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error("cancelado"), { name: "NotAllowedError" }),
    );
    await expect(
      estrela.apresentar({ communityId: "c1", channelId: "ch-voz", euHex: EU }),
    ).rejects.toThrow();
    // Sessão órfã no host seria `E_ALREADY_SHARING` na próxima tentativa.
    expect(porta.stop).toHaveBeenCalledWith({ sessionId: "sess-1" });
    expect(captura.declararSessao).toHaveBeenLastCalledWith(SEM_CAPTURA);
  });
});

describe("§17.5 — a fonte escolhida, e não a primeira que o sistema listar", () => {
  it("o id da janela escolhida viaja na declaração de captura", async () => {
    const { estrela, captura } = montar();
    await estrela.apresentar({
      communityId: "c1",
      channelId: "ch",
      euHex: EU,
      kind: "window",
      sourceId: "window:42:0",
    });
    // É esta linha que faz "Uma janela" significar alguma coisa: sem `sourceId`, o main
    // resolvia o tipo pela primeira fonte da lista e a escolha da pessoa não chegava a
    // lugar nenhum.
    expect(captura.declararSessao).toHaveBeenCalledWith({
      sessionId: "sess-1",
      kind: "window",
      sourceId: "window:42:0",
      audio: false,
    });
  });

  it("sem escolha, a declaração diz `null` — que o main lê como 'a primeira do tipo'", async () => {
    const { estrela, captura } = montar();
    await estrela.apresentar({ communityId: "c1", channelId: "ch", euHex: EU });
    expect(captura.declararSessao).toHaveBeenCalledWith({
      sessionId: "sess-1",
      kind: "screen",
      sourceId: null,
      audio: false,
    });
  });

  it("o pedido de áudio chega à captura junto com o tipo da fonte", async () => {
    const { estrela, captura } = montar({ comAudio: true });
    await estrela.apresentar({
      communityId: "c1",
      channelId: "ch",
      euHex: EU,
      kind: "window",
      sourceId: "window:7:0",
      audio: true,
    });
    expect(captura.capturar).toHaveBeenCalledWith({ kind: "window", audio: true });
  });
});

describe("§17.5 — o som da fonte escolhida", () => {
  it("a trilha de áudio vai a cada espectador NO MESMO stream do vídeo", async () => {
    const { estrela, malha, track, trackDeAudio, midia } = montar({ comAudio: true });
    await estrela.apresentar({
      communityId: "c1",
      channelId: "ch",
      euHex: EU,
      kind: "window",
      sourceId: "window:7:0",
      audio: true,
    });
    await estrela.atualizarEspectadores([ESPECTADOR]);

    // O `msid` comum é o que faz as duas trilhas chegarem no mesmo `MediaStream` do outro
    // lado — sem ele, o som da tela trocaria o `<audio>` da voz daquele par.
    expect(malha.enviarTrilha).toHaveBeenCalledWith(ESPECTADOR, track, midia);
    expect(malha.enviarTrilha).toHaveBeenCalledWith(ESPECTADOR, trackDeAudio, midia);
    expect(estrela.comAudio).toBe(true);
  });

  it("captura muda não envia trilha de áudio nenhuma nem anuncia som", async () => {
    const { estrela, malha } = montar();
    // Pedir áudio e recebê-lo são coisas diferentes: a plataforma pode não separar o som
    // da fonte, e aí a transmissão sobe muda.
    await estrela.apresentar({ communityId: "c1", channelId: "ch", euHex: EU, audio: true });
    await estrela.atualizarEspectadores([ESPECTADOR]);

    expect(malha.enviarTrilha).toHaveBeenCalledTimes(1);
    expect(estrela.comAudio).toBe(false);
  });

  it("parar encerra também o envio de áudio", async () => {
    const encerramentos: number[] = [];
    const { estrela, malha } = montar({ comAudio: true });
    (malha.enviarTrilha as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      definirBitrateKbps: vi.fn(async () => undefined),
      estatisticas: vi.fn(async () => ({ rttMs: 20, lossPct: 0 })),
      encerrar: vi.fn(async () => {
        encerramentos.push(1);
      }),
    }));
    await estrela.apresentar({ communityId: "c1", channelId: "ch", euHex: EU, audio: true });
    await estrela.atualizarEspectadores([ESPECTADOR]);
    await estrela.parar();
    // Vídeo e áudio: um sender vivo depois de parar continuaria consumindo upload.
    expect(encerramentos.length).toBe(2);
  });
});

describe("§17.5 — a estrela e o perfil por espectador", () => {
  it("cada espectador ganha o próprio envio, com o bitrate do perfil pedido", async () => {
    const { estrela, malha, envios } = montar({ pares: [ESPECTADOR, OUTRO] });
    await estrela.apresentar({ communityId: "c1", channelId: "ch", euHex: EU, quality: "low" });
    await estrela.atualizarEspectadores([ESPECTADOR, OUTRO]);

    expect(malha.enviarTrilha).toHaveBeenCalledTimes(2);
    // `low` = 600 kbps (§17.5). Cada `RTCRtpSender` tem os próprios encodings, e é isso
    // que faz a qualidade por espectador funcionar em estrela.
    expect(envios.get(ESPECTADOR)!.definirBitrateKbps).toHaveBeenCalledWith(600);
    expect(envios.get(OUTRO)!.definirBitrateKbps).toHaveBeenCalledWith(600);
  });

  it("a identidade local nunca é espectadora de si mesma", async () => {
    const { estrela, malha } = montar();
    await estrela.apresentar({ communityId: "c1", channelId: "ch", euHex: EU });
    await estrela.atualizarEspectadores([EU, ESPECTADOR]);
    expect(malha.enviarTrilha).toHaveBeenCalledTimes(1);
    expect(estrela.espectadores).toEqual([ESPECTADOR]);
  });

  it("quem sai tem o envio encerrado; quem fica não é reaberto", async () => {
    const { estrela, malha, envios } = montar();
    await estrela.apresentar({ communityId: "c1", channelId: "ch", euHex: EU });
    await estrela.atualizarEspectadores([ESPECTADOR, OUTRO]);
    (malha.enviarTrilha as ReturnType<typeof vi.fn>).mockClear();

    await estrela.atualizarEspectadores([ESPECTADOR]);
    expect(envios.get(OUTRO)!.encerrar).toHaveBeenCalled();
    expect(malha.enviarTrilha).not.toHaveBeenCalled(); // ESPECTADOR já estava servido
    expect(estrela.espectadores).toEqual([ESPECTADOR]);
  });

  it("share.health do host vira maxBitrate no sender daquele espectador", async () => {
    const { estrela, envios } = montar();
    await estrela.apresentar({ communityId: "c1", channelId: "ch", euHex: EU, quality: "high" });
    await estrela.atualizarEspectadores([ESPECTADOR]);
    (envios.get(ESPECTADOR)!.definirBitrateKbps as ReturnType<typeof vi.fn>).mockClear();

    // O veredito é do host: foi ELE que registrou o `share.setQuality` do espectador.
    await estrela.aplicarSaude([
      { key: ESPECTADOR, rttMs: 30, lossPct: 0.2, quality: "low" },
    ]);
    expect(envios.get(ESPECTADOR)!.definirBitrateKbps).toHaveBeenCalledWith(600);
  });

  it("saúde que não muda o perfil não mexe no sender", async () => {
    const { estrela, envios } = montar();
    await estrela.apresentar({ communityId: "c1", channelId: "ch", euHex: EU, quality: "balanced" });
    await estrela.atualizarEspectadores([ESPECTADOR]);
    (envios.get(ESPECTADOR)!.definirBitrateKbps as ReturnType<typeof vi.fn>).mockClear();

    await estrela.aplicarSaude([
      { key: ESPECTADOR, rttMs: 30, lossPct: 0.2, quality: "balanced" },
    ]);
    expect(envios.get(ESPECTADOR)!.definirBitrateKbps).not.toHaveBeenCalled();
  });
});

describe("§17.5/§17.6 — o laço de saúde", () => {
  it("mede cada envio e relata ao núcleo por share.report", async () => {
    const { estrela, porta, eventos } = montar({ stats: { rttMs: 42, lossPct: 5 } });
    await estrela.apresentar({ communityId: "c1", channelId: "ch", euHex: EU });
    await estrela.atualizarEspectadores([ESPECTADOR]);

    await estrela.medirERelatar();
    expect(porta.report).toHaveBeenCalledWith({
      sessionId: "sess-1",
      samples: [{ viewerKey: ESPECTADOR, rttMs: 42, lossPct: 5 }],
    });
    // A UI do apresentador mostra o que ESTA máquina mediu, sem esperar o round-trip.
    expect(eventos.aoMedir).toHaveBeenCalledWith([
      { key: ESPECTADOR, rttMs: 42, lossPct: 5, quality: "balanced" },
    ]);
  });

  it("sem espectador não há o que relatar", async () => {
    const { estrela, porta } = montar();
    await estrela.apresentar({ communityId: "c1", channelId: "ch", euHex: EU });
    await estrela.medirERelatar();
    expect(porta.report).not.toHaveBeenCalled();
  });

  it("estatística indisponível não vira amostra inventada", async () => {
    const { estrela, porta } = montar({ stats: null });
    await estrela.apresentar({ communityId: "c1", channelId: "ch", euHex: EU });
    await estrela.atualizarEspectadores([ESPECTADOR]);
    await estrela.medirERelatar();
    expect(porta.report).not.toHaveBeenCalled();
  });

  it("share.report que falha não derruba a transmissão (§16.3 regra 1)", async () => {
    const { estrela, porta } = montar();
    await estrela.apresentar({ communityId: "c1", channelId: "ch", euHex: EU });
    await estrela.atualizarEspectadores([ESPECTADOR]);
    (porta.report as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("caiu"));
    await expect(estrela.medirERelatar()).resolves.toBeUndefined();
    expect(estrela.espectadores).toEqual([ESPECTADOR]);
  });
});

describe("§17.5 — encerramento", () => {
  it("parar encerra envios, para a captura e fecha a sessão no host", async () => {
    const { estrela, porta, captura, envios, track } = montar();
    await estrela.apresentar({ communityId: "c1", channelId: "ch", euHex: EU });
    await estrela.atualizarEspectadores([ESPECTADOR]);

    await estrela.parar();
    expect(envios.get(ESPECTADOR)!.encerrar).toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
    expect(porta.stop).toHaveBeenCalledWith({ sessionId: "sess-1" });
    expect(captura.declararSessao).toHaveBeenLastCalledWith(SEM_CAPTURA);
    expect(estrela.sessionId).toBeNull();
  });

  it("parar a captura na UI do sistema avisa quem escuta", async () => {
    const { estrela, eventos, track } = montar();
    await estrela.apresentar({ communityId: "c1", channelId: "ch", euHex: EU });
    // O botão "Parar de compartilhar" do SO não passa por lugar nenhum do produto: sem
    // isto a sessão ficaria viva no host com uma trilha morta.
    track.onended?.(new Event("ended"));
    expect(eventos.aoEncerrarNaFonte).toHaveBeenCalled();
  });
});

/**
 * §17.5 (emenda de 2026-09-06) — **apresentar e parar formam uma fila**.
 *
 * "Tentar novamente" é parar e começar, e a interface as dispara em sequência sem esperar
 * a primeira: as duas são longas (o host decide, o main declara, o seletor espera a pessoa
 * responder) e as duas escrevem o mesmo `#stream`/`#track`/`#sessionId`. Entrelaçadas, o
 * `parar` que começou primeiro volta de seus `await` já com a captura NOVA à vista — para
 * as trilhas dela, zera a sessão nova e desfaz a declaração que o main acabou de receber.
 * A retentativa nasce morta, e de forma dependente de tempo.
 *
 * O encerramento por espectador é o `await` lento de `parar` — é ele que dá a janela — e
 * por isso os casos abaixo o tornam explicitamente lento: com fakes instantâneos a corrida
 * não acontece, e um teste que não a produz não prova nada sobre ela.
 *
 * Verificado por mutação: trocar `parar()` por uma chamada direta a `#parar()` (sem a fila)
 * derruba os dois primeiros casos.
 */
describe("§17.5 — parar e apresentar não se atropelam (2026-09-06)", () => {
  /** Uma apresentação viva, com um espectador cujo encerramento demora alguns ticks. */
  async function comEncerramentoLento() {
    const r = montar();
    await r.estrela.apresentar({ communityId: "c1", channelId: "ch", euHex: EU });
    await r.estrela.atualizarEspectadores([ESPECTADOR]);
    r.envios.get(ESPECTADOR)!.encerrar.mockImplementation(
      () => new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5)),
    );
    return r;
  }

  it("o retry não mata a captura nova: a captura viva no fim é a da segunda apresentação", async () => {
    const r = await comEncerramentoLento();
    const primeira = r.track;

    // O gesto exato de "Tentar novamente": as duas promessas soltas, na mesma pilha.
    const parando = r.estrela.parar();
    const apresentando = r.estrela.apresentar({ communityId: "c1", channelId: "ch", euHex: EU });
    await Promise.all([parando, apresentando]);

    // A primeira foi parada, como se pediu…
    expect(primeira.stop).toHaveBeenCalled();
    // …e a segunda ficou de pé: sessão viva e captura viva. Sem a fila, `parar` voltava do
    // encerramento dos espectadores e derrubava justamente esta.
    expect(r.estrela.sessionId).toBe("sess-1");
    expect(r.estrela.stream).not.toBeNull();
  });

  it("a declaração de captura que sobra é a da sessão NOVA, não o `null` do parar", async () => {
    const r = await comEncerramentoLento();

    const parando = r.estrela.parar();
    const apresentando = r.estrela.apresentar({ communityId: "c1", channelId: "ch", euHex: EU });
    await Promise.all([parando, apresentando]);

    // Sem a fila, o `declararSessao(null)` do `parar` chegava DEPOIS da declaração da nova,
    // e o main negaria a captura que já estava no ar.
    const ultima = (r.captura.declararSessao as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(ultima).toMatchObject({ sessionId: "sess-1" });
  });

  it("uma apresentação que falha não trava a fila — é depois dela que se tenta de novo", async () => {
    const r = montar();
    (r.porta.start as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("host recusou"));

    await expect(
      r.estrela.apresentar({ communityId: "c1", channelId: "ch", euHex: EU }),
    ).rejects.toThrow();

    // A seguinte roda normalmente: a fila é ordem, não propagação de falha.
    await r.estrela.apresentar({ communityId: "c1", channelId: "ch", euHex: EU });
    expect(r.estrela.sessionId).toBe("sess-1");
  });
});
