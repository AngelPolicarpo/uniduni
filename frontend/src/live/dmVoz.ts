import { api, cliente } from "../ipc/api";
import { CameraDaChamada, motivoDoErroDeCamera } from "./camera";
import {
  esquecerCameraRecebida,
  esquecerTodasAsCameras,
  guardarCameraLocal,
  guardarCameraRecebida,
} from "./cameraStreams";
import {
  esquecerTelaRecebida,
  esquecerTodasAsTelas,
  guardarTelaDoApresentador,
  guardarTelaRecebida,
} from "./telaStreams";
import { TelaDaDm, motivoDoErroDeTela } from "./dmTela";
import { MalhaDeVoz, motivoDoErroDeMicrofone, type OrigemDaTrilha } from "./voz";
import { useDmCallStore } from "../store/dmCallStore";
import { useIdentityStore } from "../store/identityStore";
import { useSettingsStore } from "../store/settingsStore";
import { useToastStore } from "../store/toastStore";
import { useVoiceStore } from "../store/voiceStore";

/**
 * §31.15 — a chamada de uma conversa direta.
 *
 * **A malha é a mesma de §17.2**, e isso não é reaproveitamento oportunista: §31.15 abre
 * dizendo que §17.2 vale sem alteração — WebRTC no renderer, ponta a ponta, DTLS-SRTP, e o
 * núcleo nunca vê mídia. O que muda é tudo o que estava em volta, e o arquivo se lê pela
 * lista do que **não** está aqui:
 *
 *   - **Nenhum ticket.** `autorizacaoPorTransporte` diz à malha que quem autoriza é o cabo:
 *     o `p2p-dm/1` foi autenticado por Noise contra exatamente a chave do par. Não há
 *     `voice.tickets`, não há renovação e não há passo 3 de §17.4 a repetir.
 *   - **Nenhum roster.** A única pergunta que o roster respondia numa dupla é "o outro está
 *     aqui?", e ela é `dm.callState{on}`.
 *   - **Nenhuma ocupação, fila ou revogação.** §17.6/§16.4/§17.4 não têm análogo aqui.
 *   - **Nenhum relay a oferecer** (**L-29**). Quando a chamada falha, o desfecho é
 *     `conn-failed` com o diagnóstico de §99 e a frase de `TEXTO_CHAMADA_SEM_RELAY` — e o
 *     texto mora em `dmRegras.ts`, onde o teste o alcança.
 *
 * **"Voz é uma só" (§15.4) continua valendo.** A instalação tem no máximo uma chamada, e a
 * store guarda uma conversa, não um mapa. Uma chamada de DM e uma de comunidade ao mesmo
 * tempo seriam dois microfones abertos na mesma máquina.
 *
 * **Por que a malha só sobe quando o outro atende.** §99.13 dá a garantia de §17.2 pela
 * coleta em duas fases: a `RTCPeerConnection` nasce só com o que o *host* serve, e o
 * terceiro entra por escalada. Numa DM quem faz esse papel é o par — e antes de ele atender
 * o serviço dele não existe. Subir a malha ali entregaria o STUN de terceiro ao agente na
 * primeira coleta, que é exatamente o que a fase 1 existe para evitar. Antes do atendimento
 * também não há com quem negociar: o estado é `chamando`, e nada mais.
 *
 * **A câmera entra aqui; a tela não entra em lugar nenhum.** §31.15 abre dizendo que §17.2
 * vale sem alteração, e §17.2 põe voz e câmera na MESMA malha — a câmera de uma DM é
 * `definirVideoLocal` mais um botão, sem fio novo. §17.5 é outra coisa: uma estrela que o
 * host autoriza, com sessão, ticket, roster de espectadores e um laço de saúde cujos cinco
 * passos passam todos pelo host. §31.15 remove o host e **não menciona §17.5**; a decisão e o
 * seu custo estão em `acoesDeVideo` (`features/dm/dmRegras.ts`), e o que falta de texto
 * normativo é **B68**.
 */

/** O `<audio>` do par, fora da árvore do React — mesma razão do mapa da comunidade. */
let audioDoPar: HTMLAudioElement | null = null;

function obterContainerDeAudio(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  let el = document.getElementById("p2p-audio-container");
  if (el === null) {
    el = document.createElement("div");
    el.id = "p2p-audio-container";
    el.style.display = "none";
    document.body.appendChild(el);
  }
  return el;
}

function tocar(stream: MediaStream): void {
  let el = audioDoPar;
  if (el === null) {
    el = new Audio();
    el.autoplay = true;
    obterContainerDeAudio()?.appendChild(el);
    audioDoPar = el;
  }
  el.srcObject = stream;
  aplicarSaida(el);
  void el.play().catch(() => undefined);
}

/**
 * B47 — a saída e o volume geral da tela de ajustes. **Não** há volume por participante nem
 * ensurdecer aqui: os dois são superfície da chamada de comunidade (§9, 2.3), e numa dupla
 * "ensurdecer o único par" é desligar.
 */
function aplicarSaida(el: HTMLAudioElement): void {
  const ajustes = useSettingsStore.getState();
  const saida = ajustes.outputId || "default";
  if ((el.dataset.sinkId ?? "default") !== saida) {
    el.dataset.sinkId = saida;
    void el.setSinkId(saida === "default" ? "" : saida).catch(() => undefined);
  }
  el.volume = Math.max(0, Math.min(100, ajustes.outputVolume)) / 100;
}

function pararAudio(): void {
  if (audioDoPar === null) return;
  audioDoPar.pause();
  audioDoPar.srcObject = null;
  audioDoPar.remove();
  audioDoPar = null;
}

/**
 * §17.2 (emenda de 2026-09-03) — a origem vem da malha, pelo m-line em que a trilha veio.
 *
 * **É esta emenda que torna a tela possível numa DM.** Antes dela nada no fio distinguia
 * tela de câmera (**B41**) e a comunidade contornava cruzando o `msid` com o `share.join`
 * conseguido — que numa dupla não existe. Com o m-line 2 reservado, a distinção é posicional
 * e não depende de host nenhum, que é exatamente o que faltava a §31.15.
 *
 * O par desligando qualquer uma das duas chega como `aoSumirVideo`: `replaceTrack(null)` do
 * outro lado deixa a trilha `muted`, e é essa a única evidência disponível — §31.15 remove o
 * roster, e a tabela fechada de §31.8 não declara câmera nem tela.
 */
function videoDoParChegou(peerHex: string, stream: MediaStream, origem: OrigemDaTrilha): void {
  if (origem === "tela") {
    guardarTelaRecebida(peerHex, stream);
    useDmCallStore.getState().telaDoPar(true);
    return;
  }
  guardarCameraRecebida(peerHex, stream);
  useDmCallStore.getState().cameraDoPar(true);
}

function videoDoParSumiu(peerHex: string, origem: OrigemDaTrilha): void {
  if (origem === "tela") {
    esquecerTelaRecebida(peerHex);
    useDmCallStore.getState().telaDoPar(false);
    return;
  }
  esquecerCameraRecebida(peerHex);
  useDmCallStore.getState().cameraDoPar(false);
}

/** A conversa e o par da chamada corrente, para a porta e para o filtro de eventos. */
let corrente: { conversationId: string; peerKey: string } | null = null;

const malha = new MalhaDeVoz(
  {
    /**
     * `communityId` e `channelId` carregam o **`conversationId`**, pela mesma substituição
     * que §31.14 fez no escopo de blob: o que a malha chama de sessão é o escopo da chamada,
     * e numa DM ele é a conversa (§31.1). `dm.callJoin` é idempotente.
     */
    join: async (a) => {
      const r = await api.dmCallJoin(a.communityId);
      return {
        sessionId: r.sessionId,
        // O roster de uma chamada de dois é a conversa. Uma entrada, sempre.
        roster: [{ keyHex: r.peerKey }],
        iceServers: r.iceServers,
        // §31.15 — o ticket de §17.4 **não existe**; a `remotePublicKey` é a autorização.
        tickets: [],
        autorizacaoPorTransporte: true,
      };
    },
    leave: () => (corrente === null ? Promise.resolve({}) : api.dmCallLeave(corrente.conversationId)),
    // O `ticketId` que a malha passa vem vazio e é descartado aqui: não há ticket a citar, e
    // `dm.signal` não tem campo para ele (§31.16.1).
    signal: (a) =>
      corrente === null
        ? Promise.resolve({})
        : api.dmSignal({
            conversationId: corrente.conversationId,
            ...(a.sdp !== undefined ? { sdp: a.sdp } : {}),
            ...(a.ice !== undefined ? { ice: a.ice } : {}),
          }),
  },
  {
    capturar: async (deviceId) =>
      await navigator.mediaDevices.getUserMedia({
        audio:
          deviceId === "default"
            ? {
                echoCancellation: useSettingsStore.getState().processamentoVoz,
                noiseSuppression: useSettingsStore.getState().processamentoVoz,
                autoGainControl: useSettingsStore.getState().processamentoVoz,
              }
            : {
                deviceId: { exact: deviceId },
                echoCancellation: useSettingsStore.getState().processamentoVoz,
                noiseSuppression: useSettingsStore.getState().processamentoVoz,
                autoGainControl: useSettingsStore.getState().processamentoVoz,
              },
      }),
    conexao: (config) => new RTCPeerConnection(config),
  },
  {
    aoMudarPar: (_peerHex, estado) => {
      const mapa: Record<string, "connecting" | "connected" | "failed"> = {
        connected: "connected",
        completed: "connected",
        connecting: "connecting",
        new: "connecting",
        disconnected: "connecting",
        failed: "failed",
        closed: "failed",
      };
      const traduzido = mapa[estado] ?? "connecting";
      useDmCallStore.getState().parMudou(traduzido);
      if (traduzido === "connected") useDmCallStore.getState().conectou();
    },
    aoChegarAudio: (_peerHex, stream) => tocar(stream),
    aoChegarVideo: (peerHex, stream, _track, origem) => videoDoParChegou(peerHex, stream, origem),
    aoSumirVideo: (peerHex, origem) => videoDoParSumiu(peerHex, origem),
    // §99 — o motivo nomeado. O que a tela faz com ele é `faixaDeChamada`, e é lá que L-29
    // proíbe oferecer o relay que a comunidade oferece.
    aoFalhar: (motivo) => useDmCallStore.getState().falhou(motivo),
    aoSair: () => pararAudio(),
    // O mic morreu e a chamada segue em somente-escuta — a mesma política da
    // comunidade (§17.4), aqui sem roster a contradizer.
    aoMicrofoneAusente: (motivo) => useDmCallStore.getState().microfoneFalhou(motivo),
  },
);

/** A malha sobe agora: o par está do outro lado e o serviço dele já chegou. */
async function subirMalha(conversationId: string): Promise<void> {
  const eu = useIdentityStore.getState().identity?.id ?? "";
  try {
    const r = await malha.entrar({
      communityId: conversationId,
      channelId: conversationId,
      euHex: eu,
      microfoneId: useSettingsStore.getState().microphoneId,
      agora: Date.now(),
      volumeEntrada: useSettingsStore.getState().inputVolume,
    });
    // Somente-escuta: sem mic a chamada está de pé do mesmo jeito — o aviso pede a
    // troca, nunca a saída.
    if (r.microfoneAusente !== null) useDmCallStore.getState().microfoneFalhou(r.microfoneAusente);
    useDmCallStore.getState().conectou();
    void window.electron?.setVoiceActive?.(true);
  } catch {
    // Falha do JOIN (não da captura — essa vira somente-escuta): a malha já desfez
    // o próprio estado; o que falta é não deixar a conversa em "na chamada".
    useToastStore.getState().showToast("Não foi possível abrir o microfone", "error");
    await desligar();
  }
}

/**
 * §17.2 — a câmera desta chamada.
 *
 * `CameraDaChamada` é a **mesma** classe da comunidade, e sem uma linha de condicional: ela
 * já nasceu falando com a malha por uma porta que só conhece "trilha de vídeo local", e o
 * comentário de cabeçalho dela já argumenta por que a câmera é da malha e a tela não é. Uma
 * `CameraDaDm` seria uma segunda implementação da mesma coisa.
 *
 * O que **não** acompanha a câmera aqui é o `voice.setSelf{cameraOn}` da comunidade: ele é
 * aviso ao host, e numa DM não há host nem `voiceState` (§109.6). O outro lado descobre a
 * câmera do único jeito que sobra — a trilha chegando.
 */
const camera = new CameraDaChamada(
  {
    definirVideoLocal: (track, stream) => malha.definirVideoLocal(track, stream),
    removerVideoLocal: () => malha.removerVideoLocal(),
  },
  {
    capturar: async (deviceId) =>
      await navigator.mediaDevices.getUserMedia({
        // `default` é o padrão do sistema: mandar o id literal recusaria a captura.
        video: deviceId === "default" ? true : { deviceId: { exact: deviceId } },
      }),
  },
  {
    // Cabo puxado, dispositivo tomado, permissão revogada no meio da chamada. A trilha morta
    // continua anexada na conexão até alguém a tirar: apagar só o estado deixaria o par com
    // uma imagem congelada no lugar do avatar.
    aoEncerrarNaFonte: () => {
      guardarCameraLocal(null);
      useDmCallStore.getState().cameraFalhou("A câmera foi desconectada.");
      void camera.desligar().catch(() => undefined);
    },
  },
);

/**
 * Liga a câmera. Só faz sentido com a chamada de pé — antes disso não há malha a que anexar
 * a trilha (§31.15, consequência 1), e `acoesDeVideo` é quem impede o botão de existir ali.
 *
 * O erro **nunca sobe**: uma câmera negada pelo sistema é desfecho previsto, e o que fica é
 * o motivo em português (§20.1). Ele vai para `erroDeCamera`, e não para `falha`: a faixa de
 * falha da chamada carrega `TEXTO_CHAMADA_SEM_RELAY`, que não tem nada a ver com um
 * dispositivo que o SO recusou.
 */
export async function ligarCamera(): Promise<void> {
  if (useDmCallStore.getState().estado !== "na-chamada") return;
  try {
    await camera.ligar(useSettingsStore.getState().cameraId);
  } catch (e) {
    useDmCallStore.getState().cameraFalhou(motivoDoErroDeCamera(e));
    return;
  }
  guardarCameraLocal(camera.stream);
  useDmCallStore.getState().cameraMudou(true);
}

export async function desligarCamera(): Promise<void> {
  guardarCameraLocal(null);
  useDmCallStore.getState().cameraMudou(false);
  await camera.desligar();
}

/**
 * §31.15 (emenda de 2026-09-03) — a tela da conversa direta.
 *
 * Ela usa `enviarTrilha`, que é a MESMA porta da estrela de §17.5: com um espectador só, a
 * estrela é a conexão que já existe. O que não acompanha é a sessão do host — o
 * `conversationId` ocupa o slot do `sessionId`, e `capture.authorize` responde a partir de a
 * chamada estar de pé, não de um `captureToken` que aqui ninguém emitiria.
 */
const tela = new TelaDaDm(
  {
    pares: () => malha.pares(),
    enviarTrilha: (par, track, stream) => malha.enviarTrilha(par, track, stream),
  },
  {
    // §17.5/`T-41` — declarar ANTES de capturar. Fora do Electron não há main; o navegador
    // decide sozinho, e a ordem continua sendo a mesma.
    declararSessao: async (a) => {
      await window.electron?.declareCaptureSession?.(a);
    },
    capturar: ({ kind, audio }) =>
      navigator.mediaDevices.getDisplayMedia(opcoesDeCapturaDaDm(kind, audio)),
  },
  {
    aoEncerrarNaFonte: () => {
      guardarTelaDoApresentador(null);
      useDmCallStore.getState().telaMudou(false);
      void tela.parar().catch(() => undefined);
    },
  },
);

/**
 * §17.5 — o "áudio só da janela escolhida", dito pelas opções que o Screen Capture declara
 * para isso. É a mesma decisão da comunidade, e pela mesma razão: sem separar por janela, a
 * captura sobe **muda**, que é o desfecho honesto — nunca "tudo o que toca aqui".
 */
function opcoesDeCapturaDaDm(kind: "screen" | "window", audio: boolean): DisplayMediaStreamOptions {
  if (!audio) return { video: true, audio: false };
  return {
    video: true,
    audio: true,
    ...(kind === "window"
      ? { windowAudio: "window", systemAudio: "exclude" }
      : { windowAudio: "exclude", systemAudio: "include" }),
  } as DisplayMediaStreamOptions;
}

/**
 * Começa a compartilhar. Só com a chamada de pé, pela mesma razão da câmera: o m-line 2 vive
 * numa `RTCPeerConnection` que só nasce quando o par atende (§99.13).
 */
export async function iniciarTela(a: {
  kind: "screen" | "window";
  sourceId?: string | null;
  audio: boolean;
}): Promise<void> {
  const estado = useDmCallStore.getState();
  if (estado.estado !== "na-chamada" || estado.conversationId === null) return;
  try {
    await tela.iniciar({ conversationId: estado.conversationId, ...a });
  } catch (e) {
    // Nunca lança para a UI: uma captura recusada é desfecho previsto (§20.1).
    useDmCallStore.getState().telaFalhou(motivoDoErroDeTela(e));
    return;
  }
  guardarTelaDoApresentador(tela.stream);
  useDmCallStore.getState().telaMudou(true);
}

export async function pararTela(): Promise<void> {
  guardarTelaDoApresentador(null);
  useDmCallStore.getState().telaMudou(false);
  await tela.parar();
}

/**
 * §9 (2.3.1) / **L-12** — o mudo do próprio microfone é **efetivo**, não conselho: quem
 * controla o microfone é quem o possui. E numa DM não há host a quem contá-lo, então ele não
 * sai da máquina: não existe `voiceState` aqui, e inventá-lo seria mecanismo sem destinatário.
 */
export function definirMudo(mudo: boolean): void {
  useDmCallStore.getState().definirMudo(mudo);
  malha.definirMudo(mudo);
}

/** Chamar, ou atender: os dois são `dm.callJoin` — não há convite a aceitar (§31.15). */
export async function chamar(conversationId: string): Promise<void> {
  const store = useDmCallStore.getState();
  if (store.conversationId !== null && store.conversationId !== conversationId) {
    // §15.4 "voz é uma só".
    useToastStore.getState().showToast("Você já está numa chamada", "error");
    return;
  }
  // §15.4 "voz é uma só": iniciar ou atender chamada de DM encerra chamada de comunidade ativa.
  if (useVoiceStore.getState().channelId !== null) {
    useVoiceStore.getState().leave();
  }
  try {
    const r = await api.dmCallJoin(conversationId);
    corrente = { conversationId, peerKey: r.peerKey };
    if (r.peerOnCall) {
      useDmCallStore.getState().chamando({ conversationId, peerKey: r.peerKey });
      await subirMalha(conversationId);
      return;
    }
    useDmCallStore.getState().chamando({ conversationId, peerKey: r.peerKey });
  } catch {
    useToastStore.getState().showToast("Não foi possível iniciar a chamada", "error");
  }
}

export async function desligar(): Promise<void> {
  void window.electron?.setVoiceActive?.(false);
  const id = corrente?.conversationId ?? useDmCallStore.getState().conversationId;
  corrente = null;
  useDmCallStore.getState().encerrou();
  malha.definirMudo(false);
  pararAudio();
  // A câmera é dispositivo desta máquina e ninguém a apaga por ela: sair da chamada sem isto
  // deixaria a luz acesa para ninguém. Vem antes de `malha.sair()` porque `desligar` ainda
  // precisa da malha para tirar a trilha das conexões.
  await camera.desligar().catch(() => undefined);
  await tela.parar().catch(() => undefined);
  esquecerTodasAsCameras();
  esquecerTodasAsTelas();
  await malha.sair().catch(() => undefined);
  if (id !== null) await api.dmCallLeave(id).catch(() => undefined);
}

/**
 * §31.16.2 — os dois eventos de mídia. Ambos são **ordem**, não sinal para reconsultar: não
 * existe query que reconstrua uma negociação WebRTC, e §15.1 regra 5 não se aplica a quadro
 * de sinalização — a mesma exceção que `voice.signal` sempre teve em §15.5.
 */
export function assinarDmVoz(): void {
  cliente.subscribe("dm.signal", (d) => {
    const ev = d as { conversationId: string; peerKey: string; sdp?: string; ice?: string };
    // Sinal de uma conversa que não é a da chamada corrente é descartado. Sem isto, um par
    // que ligou enquanto eu falo com outra pessoa entraria na negociação em curso.
    if (corrente === null || ev.conversationId !== corrente.conversationId) return;
    void malha.aplicarSinal({
      peerKey: ev.peerKey,
      ticketId: "",
      ...(ev.sdp !== undefined ? { sdp: ev.sdp } : {}),
      ...(ev.ice !== undefined ? { ice: ev.ice } : {}),
    });
  });

  cliente.subscribe("dm.callState", (d) => {
    const ev = d as {
      conversationId: string;
      peerKey: string;
      on: boolean;
      iceServers?: RTCIceServer[];
    };
    const store = useDmCallStore.getState();
    if (!ev.on) {
      // Ele saiu, caiu ou bloqueou — e os três são indistinguíveis (§31.9 regra 2, L-28).
      // A tela encerra sem afirmar a causa, exatamente como "não entregue" não a afirma.
      if (store.conversationId === ev.conversationId) void desligar();
      return;
    }
    if (store.conversationId === null) {
      if (useVoiceStore.getState().channelId !== null) {
        // §15.4, §20.3 (emenda de 2026-09-09) — chamada concorrente sob a regra "voz é uma só":
        // se uma chamada de DM for recebida com sessão de voz já em andamento, o sistema recusa
        // a nova chamada e emite notificação informativa em toast avisando sobre a chamada descartada do par.
        void api.dmCallLeave(ev.conversationId).catch(() => undefined);
        useToastStore
          .getState()
          .showToast("Chamada de DM descartada porque você já está em uma chamada de voz", "info");
        return;
      }
      // Ninguém pediu esta chamada deste lado: é o outro ligando.
      corrente = { conversationId: ev.conversationId, peerKey: ev.peerKey };
      useDmCallStore
        .getState()
        .recebendo({ conversationId: ev.conversationId, peerKey: ev.peerKey });
      return;
    }
    if (store.conversationId !== ev.conversationId) {
      // §15.4 "voz é uma só", §20.3 feedback da chamada recebida enquanto ocupado.
      useToastStore
        .getState()
        .showToast("Chamada recebida de outro contato enquanto você está em chamada", "warning");
      return;
    }
    // Eu já estava chamando e ele atendeu: agora existe serviço do outro lado, e é agora que
    // a coleta de §99.13 pode começar na fase 1.
    if (store.estado === "chamando") {
      void subirMalha(ev.conversationId);
      return;
    }
    // Chamada já de pé e a lista mudou (ele reanunciou): renova sem renegociar.
    if (ev.iceServers !== undefined) malha.aplicarIceServers(ev.iceServers);
  });

  // §10, 3.1 — a escolha de microfone, saída e volume valem DURANTE a chamada da conversa, como na
  // comunidade: é também a recuperação do mic ausente, com a chamada de pé.
  useSettingsStore.subscribe((estado, anterior) => {
    if (useDmCallStore.getState().conversationId === null) return;

    if (estado.microphoneId !== anterior.microphoneId) {
      malha.trocarMicrofone(estado.microphoneId).then(
        () => useDmCallStore.getState().microfoneFalhou(null),
        (e) => {
          console.log("[voz-dm] troca de microfone falhou:", (e as Error).message);
          useDmCallStore.getState().microfoneFalhou(motivoDoErroDeMicrofone(e));
        },
      );
    }

    if (
      estado.outputId !== anterior.outputId ||
      estado.outputVolume !== anterior.outputVolume
    ) {
      if (audioDoPar !== null) aplicarSaida(audioDoPar);
    }
  });
}
