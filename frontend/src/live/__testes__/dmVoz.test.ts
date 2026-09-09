/**
 * §31.15 — a chamada de uma conversa direta. B62 / §109.
 *
 * O que se afirma aqui é a **tabela de remoções** do lado do renderer, e cada caso nomeia a
 * peça de §17 que some. O WebRTC em si não entra: a `MalhaDeVoz` é a de §17.2 sem alteração,
 * e a evidência de duas pontas com mídia real é o smoke de §98.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  dmCallJoin: vi.fn<(id: string) => Promise<unknown>>(),
  dmCallLeave: vi.fn<(id: string) => Promise<unknown>>(),
  dmSignal: vi.fn<(a: unknown) => Promise<unknown>>(),
}));
const cliente = vi.hoisted(() => ({ subscribe: vi.fn() }));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
const malha = vi.hoisted(() => ({
  entrar: vi.fn<(a: unknown) => Promise<unknown>>(),
  sair: vi.fn<() => Promise<unknown>>(),
  aplicarSinal: vi.fn<(a: unknown) => Promise<unknown>>(),
  aplicarIceServers: vi.fn<(a: unknown) => void>(),
  definirMudo: vi.fn<(m: boolean) => void>(),
  definirVideoLocal: vi.fn<(t: unknown, s: unknown) => Promise<void>>(),
  removerVideoLocal: vi.fn<() => Promise<void>>(),
  pares: vi.fn<() => string[]>(),
  enviarTrilha: vi.fn<(p: string, t: unknown, s: unknown) => Promise<unknown>>(),
}));
/** §17.5/`T-41` — a declaração ao main. A ordem contra a captura é o que o teste afirma. */
const declarar = vi.hoisted(() => vi.fn<(a: unknown) => Promise<void>>());
/** A captura de vídeo, injetada: `CameraDaChamada` é a de produto, o dispositivo não é. */
const captura = vi.hoisted(() => ({
  getUserMedia: vi.fn<(c: unknown) => Promise<unknown>>(),
  getDisplayMedia: vi.fn<(c: unknown) => Promise<unknown>>(),
}));
/** O que o construtor da malha recebeu — é por onde a porta de §31.15 é inspecionada. */
const construida = vi.hoisted(() => ({ porta: null as unknown, eventos: null as unknown }));

vi.mock("../../ipc/api", () => ({ api, cliente }));
vi.mock("../../store/toastStore", () => ({ useToastStore: { getState: () => toast } }));
vi.mock("../voz", () => ({
  MalhaDeVoz: class {
    constructor(porta: unknown, _midia: unknown, eventos: unknown) {
      construida.porta = porta;
      construida.eventos = eventos;
    }
    entrar = malha.entrar;
    sair = malha.sair;
    aplicarSinal = malha.aplicarSinal;
    aplicarIceServers = malha.aplicarIceServers;
    definirMudo = malha.definirMudo;
    definirVideoLocal = malha.definirVideoLocal;
    removerVideoLocal = malha.removerVideoLocal;
    pares = malha.pares;
    enviarTrilha = malha.enviarTrilha;
  },
}));

import {
  assinarDmVoz,
  chamar,
  definirMudo,
  desligar,
  desligarCamera,
  iniciarTela,
  ligarCamera,
} from "../dmVoz";
import { cameraLocal, cameraRecebida } from "../cameraStreams";
import { telaDoApresentador, telaRecebida } from "../telaStreams";
import { useDmCallStore } from "../../store/dmCallStore";
import { useVoiceStore } from "../../store/voiceStore";

type Porta = {
  join(a: { communityId: string; channelId: string }): Promise<{
    sessionId: string;
    roster: Array<{ keyHex: string }>;
    tickets: unknown[];
    autorizacaoPorTransporte?: boolean;
  }>;
  signal(a: { peerKey: string; ticketId: string; sdp?: string; ice?: string }): Promise<unknown>;
};

const CONVERSA = "c".repeat(64);
const PAR = "b".repeat(64);

/** Uma trilha de vídeo falsa, com os três manipuladores que a DM usa como evidência. */
function trilhaFalsa(): MediaStreamTrack {
  return {
    kind: "video",
    label: "Câmera de teste",
    stop: vi.fn(),
    onended: null,
    onmute: null,
    onunmute: null,
  } as unknown as MediaStreamTrack;
}

function streamFalso(id: string, track: MediaStreamTrack): MediaStream {
  return {
    id,
    getVideoTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
}

/** Os eventos que `dmVoz` deu à malha — é por onde a trilha recebida é injetada. */
type Eventos = {
  aoChegarVideo: (
    peerHex: string,
    stream: MediaStream,
    track: MediaStreamTrack,
    origem: "camera" | "tela",
  ) => void;
  aoSumirVideo: (peerHex: string, origem: "camera" | "tela") => void;
};

/** Os assinantes registrados por `assinarDmVoz`, por tópico. */
function ouvinte(topic: string): (d: unknown) => void {
  const chamada = cliente.subscribe.mock.calls.find((c) => c[0] === topic);
  expect(chamada, `nenhum assinante de ${topic}`).toBeDefined();
  return (chamada as [string, (d: unknown) => void])[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  useDmCallStore.getState().encerrou();
  api.dmCallJoin.mockResolvedValue({
    sessionId: CONVERSA,
    peerKey: PAR,
    iceServers: [],
    peerOnCall: false,
  });
  api.dmCallLeave.mockResolvedValue({});
  api.dmSignal.mockResolvedValue({});
  malha.entrar.mockResolvedValue({ sessionId: CONVERSA, microfoneAusente: null });
  malha.sair.mockResolvedValue(undefined);
  malha.aplicarSinal.mockResolvedValue(undefined);
  malha.definirVideoLocal.mockResolvedValue(undefined);
  malha.removerVideoLocal.mockResolvedValue(undefined);
  captura.getUserMedia.mockImplementation(async () => streamFalso("local", trilhaFalsa()));
  captura.getDisplayMedia.mockImplementation(async () => {
    const v = trilhaFalsa();
    const a = { ...trilhaFalsa(), kind: "audio" } as unknown as MediaStreamTrack;
    return {
      id: "captura",
      getVideoTracks: () => [v],
      getAudioTracks: () => [a],
      getTracks: () => [v, a],
    } as unknown as MediaStream;
  });
  declarar.mockResolvedValue(undefined);
  malha.pares.mockReturnValue([PAR]);
  malha.enviarTrilha.mockResolvedValue({ encerrar: async () => undefined });
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: captura.getUserMedia,
      getDisplayMedia: captura.getDisplayMedia,
    },
  });
  vi.stubGlobal("window", { electron: { declareCaptureSession: declarar } });
});

describe("§31.15 — o que a porta de voz da DM NÃO leva", () => {
  it("a porta entrega roster de um e ticket nenhum, com a autorização vindo do transporte", async () => {
    const porta = construida.porta as Porta;
    const r = await porta.join({ communityId: CONVERSA, channelId: CONVERSA });
    // Ticket de mídia (§17.4): **NÃO REUTILIZADO**. A `remotePublicKey` do Noise é a
    // autorização, e sem a marca a malha recusaria todo sinal (passo 4 de §17.4).
    expect(r.tickets).toEqual([]);
    expect(r.autorizacaoPorTransporte).toBe(true);
    // Roster: **não existe**. Numa dupla ele é a própria conversa — uma entrada, sempre.
    expect(r.roster).toEqual([{ keyHex: PAR }]);
  });

  it("`dm.signal` sai sem `ticketId`: o campo não existe em §31.16.1", async () => {
    await chamar(CONVERSA);
    const porta = construida.porta as Porta;
    await porta.signal({ peerKey: PAR, ticketId: "irrelevante", sdp: "v=0" });
    expect(api.dmSignal).toHaveBeenCalledWith({ conversationId: CONVERSA, sdp: "v=0" });
    expect(api.dmSignal.mock.calls[0]?.[0]).not.toHaveProperty("ticketId");
    expect(api.dmSignal.mock.calls[0]?.[0]).not.toHaveProperty("peerKey");
  });
});

describe("§31.15 — a malha só sobe quando o outro atende (§99.13)", () => {
  it("chamar com o par fora deixa a conversa em `chamando`, sem microfone aberto", async () => {
    await chamar(CONVERSA);
    expect(useDmCallStore.getState().estado).toBe("chamando");
    // Subir aqui entregaria o STUN de terceiro ao agente na primeira coleta: numa DM quem
    // faz o papel do host é o par, e antes de ele atender o serviço dele não existe.
    expect(malha.entrar).not.toHaveBeenCalled();
  });

  it("o par atendendo sobe a malha", async () => {
    assinarDmVoz();
    await chamar(CONVERSA);
    ouvinte("dm.callState")({ conversationId: CONVERSA, peerKey: PAR, on: true, iceServers: [] });
    await vi.waitFor(() => expect(malha.entrar).toHaveBeenCalledTimes(1));
  });

  it("chamar quando o par JÁ está na chamada sobe a malha na hora", async () => {
    api.dmCallJoin.mockResolvedValue({ sessionId: CONVERSA, peerKey: PAR, iceServers: [], peerOnCall: true });
    await chamar(CONVERSA);
    expect(malha.entrar).toHaveBeenCalledTimes(1);
  });

  it("sem microfone na entrada, a chamada CONECTA em somente-escuta — com aviso, sem saída", async () => {
    // O defeito era `desligar()` no `catch`: sem mic não havia chamada. Agora o `entrar`
    // resolve com o motivo, e o motivo vira faixa — nunca `dmCallLeave`.
    api.dmCallJoin.mockResolvedValue({ sessionId: CONVERSA, peerKey: PAR, iceServers: [], peerOnCall: true });
    malha.entrar.mockResolvedValue({
      sessionId: CONVERSA,
      microfoneAusente: "O microfone escolhido não está mais disponível.",
    });
    await chamar(CONVERSA);
    const s = useDmCallStore.getState();
    expect(s.estado).toBe("na-chamada");
    expect(s.erroDeMicrofone).toBe("O microfone escolhido não está mais disponível.");
    expect(toast.showToast).not.toHaveBeenCalled();
    expect(api.dmCallLeave).not.toHaveBeenCalled();
  });

  it("o mic que morre no meio da chamada vira aviso local — a chamada não cai", async () => {
    api.dmCallJoin.mockResolvedValue({ sessionId: CONVERSA, peerKey: PAR, iceServers: [], peerOnCall: true });
    await chamar(CONVERSA);
    expect(useDmCallStore.getState().estado).toBe("na-chamada");
    (construida.eventos as { aoMicrofoneAusente: (m: string) => void }).aoMicrofoneAusente(
      "O microfone foi desconectado.",
    );
    const s = useDmCallStore.getState();
    expect(s.erroDeMicrofone).toBe("O microfone foi desconectado.");
    expect(s.estado).toBe("na-chamada");
    expect(api.dmCallLeave).not.toHaveBeenCalled();
  });
});

describe("§31.15 — `dm.callState` é a notificação que substitui o roster", () => {
  beforeEach(() => assinarDmVoz());

  it("o par ligando sem que eu tenha pedido nada põe a conversa em `recebendo`", () => {
    ouvinte("dm.callState")({ conversationId: CONVERSA, peerKey: PAR, on: true, iceServers: [] });
    const s = useDmCallStore.getState();
    expect(s.estado).toBe("recebendo");
    expect(s.conversationId).toBe(CONVERSA);
    expect(s.peerKey).toBe(PAR);
  });

  it("o par saindo encerra sem afirmar a causa — sair, cair e bloquear são indistinguíveis (L-28)", async () => {
    await chamar(CONVERSA);
    ouvinte("dm.callState")({ conversationId: CONVERSA, peerKey: PAR, on: false });
    await vi.waitFor(() => expect(useDmCallStore.getState().estado).toBe("fora"));
    expect(toast.showToast).not.toHaveBeenCalled();
  });

  it("a lista de ICE renovada numa chamada de pé não renegocia: `setConfiguration`, como §17.3", async () => {
    api.dmCallJoin.mockResolvedValue({ sessionId: CONVERSA, peerKey: PAR, iceServers: [], peerOnCall: true });
    await chamar(CONVERSA);
    useDmCallStore.getState().conectou();
    const servers = [{ urls: "stun:9.9.9.9:1" }];
    ouvinte("dm.callState")({ conversationId: CONVERSA, peerKey: PAR, on: true, iceServers: servers });
    expect(malha.aplicarIceServers).toHaveBeenCalledWith(servers);
  });
});

describe("§31.15 — sinal de outra conversa não entra na negociação corrente", () => {
  it("um `dm.signal` de conversa diferente é descartado", async () => {
    assinarDmVoz();
    await chamar(CONVERSA);
    ouvinte("dm.signal")({ conversationId: "a".repeat(64), peerKey: PAR, sdp: "v=0" });
    expect(malha.aplicarSinal).not.toHaveBeenCalled();
    ouvinte("dm.signal")({ conversationId: CONVERSA, peerKey: PAR, sdp: "v=0" });
    expect(malha.aplicarSinal).toHaveBeenCalledWith({ peerKey: PAR, ticketId: "", sdp: "v=0" });
  });
});

describe('§15.4 — "voz é uma só" vale numa DM', () => {
  it("chamar uma segunda conversa com uma chamada de pé é recusado, e nada é aberto", async () => {
    await chamar(CONVERSA);
    api.dmCallJoin.mockClear();
    await chamar("d".repeat(64));
    expect(api.dmCallJoin).not.toHaveBeenCalled();
    expect(toast.showToast).toHaveBeenCalledWith("Você já está numa chamada", "error");
    expect(useDmCallStore.getState().conversationId).toBe(CONVERSA);
  });

  it("chamar numa DM com chamada de comunidade ativa encerra a chamada de comunidade automaticamente", async () => {
    useVoiceStore.setState({ channelId: "ch-comunidade" });
    const leaveSpy = vi.spyOn(useVoiceStore.getState(), "leave");
    await chamar(CONVERSA);
    expect(leaveSpy).toHaveBeenCalled();
    leaveSpy.mockRestore();
    useVoiceStore.setState({ channelId: null });
  });

  it("chamada de DM recebida com chamada de comunidade ativa é recusada no fio com toast (§15.4 / emenda 2026-09-09)", async () => {
    assinarDmVoz();
    useVoiceStore.setState({ channelId: "ch-comunidade" });
    ouvinte("dm.callState")({ conversationId: CONVERSA, peerKey: PAR, on: true });

    expect(api.dmCallLeave).toHaveBeenCalledWith(CONVERSA);
    expect(toast.showToast).toHaveBeenCalledWith(
      expect.stringContaining("já está em uma chamada de voz"),
      "info",
    );
    expect(useDmCallStore.getState().estado).toBe("fora");
    useVoiceStore.setState({ channelId: null });
  });
});

describe("§9 (2.3.1) / L-12 — o mudo é efetivo e não sai da máquina", () => {
  it("mudar o mudo corta a trilha e NÃO manda nada ao par: não há host a quem contar", async () => {
    await chamar(CONVERSA);
    definirMudo(true);
    expect(malha.definirMudo).toHaveBeenCalledWith(true);
    expect(useDmCallStore.getState().mudo).toBe(true);
    // §31.15 remove o roster; não existe `voiceState` numa DM, e um `dm.signal` com estado
    // de microfone seria mecanismo sem destinatário.
    expect(api.dmSignal).not.toHaveBeenCalled();
  });

  it("desligar devolve o microfone ao estado ligado: a próxima chamada não nasce muda por herança", async () => {
    await chamar(CONVERSA);
    definirMudo(true);
    await desligar();
    expect(useDmCallStore.getState().mudo).toBe(false);
    expect(malha.definirMudo).toHaveBeenLastCalledWith(false);
  });
});

describe("§31.15 — desligar", () => {
  it("sai da malha e avisa o núcleo; o estado volta a `fora`", async () => {
    await chamar(CONVERSA);
    await desligar();
    expect(malha.sair).toHaveBeenCalledTimes(1);
    expect(api.dmCallLeave).toHaveBeenCalledWith(CONVERSA);
    expect(useDmCallStore.getState().estado).toBe("fora");
  });
});


/* ─── §17.2 — a câmera na mesma malha, e a tela que não existe (B68) ───────── */

describe("§17.2 numa DM — a câmera é a MESMA malha da voz", () => {
  async function chamadaDePe(): Promise<void> {
    api.dmCallJoin.mockResolvedValue({
      sessionId: CONVERSA,
      peerKey: PAR,
      iceServers: [],
      peerOnCall: true,
    });
    await chamar(CONVERSA);
    useDmCallStore.getState().conectou();
  }

  it("ligar a câmera anexa a trilha à malha que já existe — nenhuma conexão nova", async () => {
    await chamadaDePe();
    await ligarCamera();
    // §17.2: voz e câmera na mesma `RTCPeerConnection`. Uma sessão nova seria a estrela de
    // §17.5, que numa DM não tem host que a autorize.
    expect(malha.definirVideoLocal).toHaveBeenCalledTimes(1);
    expect(useDmCallStore.getState().cameraLigada).toBe(true);
    expect(cameraLocal()).not.toBeNull();
  });

  it("ligar a câmera NÃO manda nada pelo fio: não há `voice.setSelf` numa DM", async () => {
    await chamadaDePe();
    api.dmSignal.mockClear();
    await ligarCamera();
    // §15.4 `voice.setSelf{cameraOn}` é aviso ao HOST, e §31.15 remove o host. A tabela
    // fechada de §31.8 não tem linha de câmera; inventá-la seria mecanismo sem destinatário.
    expect(api.dmSignal).not.toHaveBeenCalled();
  });

  it("a câmera não liga fora da chamada: antes do atendimento não há malha (§99.13)", async () => {
    await chamar(CONVERSA);
    expect(useDmCallStore.getState().estado).toBe("chamando");
    await ligarCamera();
    expect(malha.definirVideoLocal).not.toHaveBeenCalled();
    expect(useDmCallStore.getState().cameraLigada).toBe(false);
  });

  it("a câmera recusada pelo sistema vira motivo em português, e NÃO vira falha de chamada", async () => {
    await chamadaDePe();
    captura.getUserMedia.mockRejectedValue(
      Object.assign(new Error("negado"), { name: "NotAllowedError" }),
    );
    await ligarCamera();
    const s = useDmCallStore.getState();
    expect(s.erroDeCamera).toBe("O sistema não autorizou o acesso à câmera.");
    expect(s.cameraLigada).toBe(false);
    // O slot de `falha` é o de §99, e `faixaDeChamada` cola L-29 nele. Uma câmera negada
    // pelo SO ali mandaria a pessoa procurar defeito na rede.
    expect(s.falha).toBeNull();
  });

  it("desligar a chamada apaga a câmera: o dispositivo é desta máquina e ninguém o apaga por ela", async () => {
    await chamadaDePe();
    await ligarCamera();
    await desligar();
    expect(malha.removerVideoLocal).toHaveBeenCalled();
    expect(cameraLocal()).toBeNull();
    expect(useDmCallStore.getState().cameraLigada).toBe(false);
  });

  it("desligar só a câmera mantém a chamada de pé", async () => {
    await chamadaDePe();
    await ligarCamera();
    await desligarCamera();
    expect(useDmCallStore.getState().cameraLigada).toBe(false);
    expect(useDmCallStore.getState().estado).toBe("na-chamada");
    expect(api.dmCallLeave).not.toHaveBeenCalled();
  });
});

describe("§17.2 (emenda de 2026-09-03) — a origem vem do m-line, e é isso que dá tela à DM", () => {
  it("câmera e tela do par entram em lugares diferentes, sem `share.join` a consultar", () => {
    const eventos = construida.eventos as Eventos;
    const cam = trilhaFalsa();
    const tela = trilhaFalsa();
    eventos.aoChegarVideo(PAR, streamFalso("cam", cam), cam, "camera");
    eventos.aoChegarVideo(PAR, streamFalso("tela", tela), tela, "tela");

    // **É esta emenda que torna a tela possível aqui.** Sem ela, nada distinguiria as duas
    // numa dupla: a heurística da comunidade parte do `share.join`, que numa DM não existe.
    const s = useDmCallStore.getState();
    expect(s.parComCamera).toBe(true);
    expect(s.parComTela).toBe(true);
    expect(cameraRecebida(PAR)?.id).toBe("cam");
    expect(telaRecebida(PAR)?.id).toBe("tela");
  });

  it("a trilha parando é o ÚNICO sinal de que o par desligou — não há roster que o diga", () => {
    const eventos = construida.eventos as Eventos;
    const cam = trilhaFalsa();
    eventos.aoChegarVideo(PAR, streamFalso("cam", cam), cam, "camera");
    // §31.15 remove o roster, e nenhuma notificação de §31.8 declara câmera ou tela: não há
    // `voice.setSelf{cameraOn:false}` ecoado por host nenhum.
    eventos.aoSumirVideo(PAR, "camera");
    expect(useDmCallStore.getState().parComCamera).toBe(false);
    expect(cameraRecebida(PAR)).toBeNull();
  });

  it("a tela do par sumindo não apaga a câmera dele", () => {
    const eventos = construida.eventos as Eventos;
    const cam = trilhaFalsa();
    const tela = trilhaFalsa();
    eventos.aoChegarVideo(PAR, streamFalso("cam", cam), cam, "camera");
    eventos.aoChegarVideo(PAR, streamFalso("tela", tela), tela, "tela");
    eventos.aoSumirVideo(PAR, "tela");
    const s = useDmCallStore.getState();
    expect(s.parComTela).toBe(false);
    expect(s.parComCamera).toBe(true);
  });
});

describe("§31.15 (emenda de 2026-09-03) — a tela da DM é a malha de dois", () => {
  async function chamadaDePe(): Promise<void> {
    api.dmCallJoin.mockResolvedValue({
      sessionId: CONVERSA,
      peerKey: PAR,
      iceServers: [],
      peerOnCall: true,
    });
    await chamar(CONVERSA);
    useDmCallStore.getState().conectou();
  }

  it("o som é opt-in: o pedido leva `audio: false` a menos que a pessoa escolha", async () => {
    await chamadaDePe();
    await iniciarTela({ kind: "screen", audio: false });
    // §17.5 (emenda de 2026-09-03) — capturar o som de uma máquina não pode ser efeito
    // colateral de compartilhar a tela. O flag viaja na declaração, e o núcleo é quem
    // concede (§15.7); passá-lo sempre `true` tornaria o opt-in decorativo.
    expect(declarar).toHaveBeenCalledWith(expect.objectContaining({ audio: false }));
  });

  it("pedir com som declara `audio: true` — quem concede é o núcleo, não este lado", async () => {
    await chamadaDePe();
    await iniciarTela({ kind: "screen", audio: true });
    expect(declarar).toHaveBeenCalledWith(expect.objectContaining({ audio: true }));
  });

  it("o `conversationId` é o que se declara ao main: não há sessão de tela a citar", async () => {
    await chamadaDePe();
    await iniciarTela({ kind: "screen", audio: true });

    // §17.5/`T-41` — declarar ANTES de capturar continua obrigatório; o que muda é O QUE se
    // declara. Não há `share.start`, então não há `sessionId` de host: o escopo é a conversa,
    // a mesma substituição que `dm.callJoin` já faz.
    expect(declarar).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: CONVERSA, kind: "screen" }),
    );
    const ordem = declarar.mock.invocationCallOrder[0]!;
    expect(ordem).toBeLessThan(captura.getDisplayMedia.mock.invocationCallOrder[0]!);
  });

  it("a tela sobe pela conexão que a chamada já mantém, e o som dela junto", async () => {
    await chamadaDePe();
    await iniciarTela({ kind: "screen", audio: true });

    // Duas trilhas para o MESMO par: imagem e som. Não há segunda conexão, não há
    // `share.join` e não há ticket — a estrela de §17.5 com um espectador é esta malha.
    expect(malha.enviarTrilha).toHaveBeenCalledTimes(2);
    expect(malha.enviarTrilha.mock.calls.every((c) => c[0] === PAR)).toBe(true);
    expect(useDmCallStore.getState().telaLigada).toBe(true);
  });

  it("NENHUM comando de tela atravessa o núcleo — §31.8 não ganhou linha", async () => {
    await chamadaDePe();
    api.dmSignal.mockClear();
    await iniciarTela({ kind: "screen", audio: true });
    // A tela de uma DM não passa pelo núcleo em ponto nenhum: sem `share.start`, sem
    // `share.join`, sem `share.report`. O que existe é `replaceTrack` no m-line reservado.
    expect(api.dmSignal).not.toHaveBeenCalled();
  });

  it("não sobe fora da chamada: o m-line 2 vive numa conexão que ainda não existe", async () => {
    await chamar(CONVERSA);
    await iniciarTela({ kind: "screen", audio: true });
    expect(declarar).not.toHaveBeenCalled();
    expect(useDmCallStore.getState().telaLigada).toBe(false);
  });

  it("captura recusada vira motivo em português, e NÃO vira falha de chamada", async () => {
    await chamadaDePe();
    captura.getDisplayMedia.mockRejectedValue(
      Object.assign(new Error("negado"), { name: "NotAllowedError" }),
    );
    await iniciarTela({ kind: "screen", audio: true });
    const s = useDmCallStore.getState();
    expect(s.erroDeTela).toBe("A captura de tela não foi autorizada.");
    expect(s.telaLigada).toBe(false);
    // O slot de `falha` é o de §99, e `faixaDeChamada` cola L-29 nele.
    expect(s.falha).toBeNull();
  });

  it("desligar a chamada para a captura: o indicador do sistema não fica aceso para ninguém", async () => {
    await chamadaDePe();
    await iniciarTela({ kind: "screen", audio: true });
    await desligar();
    expect(useDmCallStore.getState().telaLigada).toBe(false);
    expect(telaDoApresentador()).toBeNull();
  });
});
