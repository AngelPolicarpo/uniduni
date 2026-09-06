/**
 * O compartilhamento de tela do renderer — §17.5 (estrela WebRTC, sem teto de audiência).
 *
 * **A divisão é a mesma da voz (§76).** `live/voz.ts` fala WebRTC e não sabe o que é uma
 * tela; este módulo sabe o que é uma tela e **não toca em `RTCPeerConnection`** — ele fala
 * com a malha por uma porta (`PortaDaMalha`) que só conhece "trilha", "par" e "bitrate". O
 * `voiceStore` guarda o estado que a tela lê; `live/sincronizacao.ts` é o único lugar onde
 * os três se encontram.
 *
 * **Por que não há conexão nova aqui.** §17.5 pede uma `RTCPeerConnection` por espectador, e
 * ela já existe: é a que a voz mantém com aquele par. §15.4 tem um único canal de
 * sinalização (`voice.signal`) e nenhum campo que diga a qual negociação um SDP pertence —
 * uma segunda conexão pelo mesmo canal faria a oferta de uma cair na outra. A estrela de
 * §17.5 é, portanto, o conjunto dos envios de trilha sobre a malha que já está de pé.
 *
 * **A ordem de `T-41` é lei aqui.** `share.start` → o host autoriza → `captureToken` →
 * `getDisplayMedia`. Nunca o contrário: capturar antes de saber se a permissão
 * `voice_share_screen` deixa passar acende a luz da captura à toa, que é o mesmo erro que
 * §76.4 nomeou para o microfone.
 *
 * **TURN não entra.** §17.3: "tela via TURN é **recusada** no v1". Não há fallback relayado
 * a desenhar nem a anunciar — se a conexão da voz com aquele par não fechou, não há tela
 * para ele.
 *
 * A captura e a malha entram **injetadas**: sem isso nada aqui seria testável fora de um
 * navegador com tela real.
 */
import {
  SHARE_QUALITY_KBPS,
  type ShareQualityDto,
  type ShareViewerHealthDto,
} from "../ipc/api";
import type { EnvioDeTrilha } from "./voz";

/**
 * Diagnóstico do caminho de tela, no console do renderer — irmão do `[voz]`.
 *
 * §82.1: cinco dos oito defeitos da voz só ficaram visíveis depois que §77 instrumentou o
 * caminho. Uma negociação que falha em silêncio é indistinguível de uma que nunca começou, e
 * o stdout do processo Electron não tem para onde ir numa instalação aberta pelo Explorer.
 */
function log(msg: string, extra?: unknown): void {
  if (extra === undefined) console.log(`[tela] ${msg}`);
  else console.log(`[tela] ${msg}`, extra);
}

/** §17.6 — a cadência de `shareHealth`. É nela que medimos e relatamos. */
const CADENCIA_DE_SAUDE_MS = 2_000;

/** O que este módulo precisa da malha de voz. Nada de `RTCPeerConnection` atravessa. */
export interface PortaDaMalha {
  pares(): string[];
  enviarTrilha(
    parHex: string,
    track: MediaStreamTrack,
    stream: MediaStream,
  ): Promise<EnvioDeTrilha | null>;
}

/** A superfície de §15.4 que a tela usa. */
export interface PortaDeTela {
  start(a: {
    communityId: string;
    channelId: string;
    quality: ShareQualityDto;
  }): Promise<{ sessionId: string }>;
  stop(a: { sessionId: string }): Promise<unknown>;
  join(a: { sessionId: string }): Promise<{ ticketId: string; presenterKey: string }>;
  setQuality(a: { sessionId: string; quality: ShareQualityDto }): Promise<{ applied: boolean }>;
  report(a: {
    sessionId: string;
    samples: Array<{ viewerKey: string; rttMs: number; lossPct: number }>;
  }): Promise<unknown>;
}

/**
 * A captura de tela, injetada. Em produto é `getDisplayMedia`; no teste é uma trilha falsa.
 *
 * `declararSessao` é a metade de §17.5 que vive no main: ele precisa saber a qual sessão a
 * próxima captura se refere para perguntar ao núcleo (`capture.authorize`, §15.7) antes de
 * conceder. Sem essa declaração o main nega — falha fechada.
 */
export interface FabricaDeCaptura {
  declararSessao(a: DeclaracaoDeCaptura): Promise<void>;
  capturar(a: { kind: "screen" | "window"; audio: boolean }): Promise<MediaStream>;
}

/**
 * O que o main precisa saber antes de conceder a captura.
 *
 * `sourceId` é a fonte que a pessoa apontou no seletor — a metade que faltava para "Uma
 * janela" significar alguma coisa. Sem ele o main resolvia o tipo pela primeira fonte que o
 * sistema listasse, e escolher janela era um botão que não escolhia nada. `null` continua
 * sendo "a primeira do tipo", que é o caminho de quem chama sem passar pelo seletor.
 */
export interface DeclaracaoDeCaptura {
  sessionId: string | null;
  kind: "screen" | "window";
  sourceId?: string | null;
  audio?: boolean;
}

export interface EventosDaTela {
  /** A transmissão não subiu, e o motivo é nomeado — `share.failed` de §15.5. */
  aoFalhar: (motivo: string) => void;
  /** A pessoa parou pela UI do sistema ("Parar de compartilhar" do SO). */
  aoEncerrarNaFonte: () => void;
  /** Saúde por espectador, medida aqui e consolidada pelo núcleo (§17.5). */
  aoMedir?: (amostras: readonly ShareViewerHealthDto[]) => void;
}

/**
 * Resolução e taxa de quadros REAIS da captura. Vem de `getSettings()`, nunca do que foi
 * pedido: entre pedir e conseguir há a fonte, que aproxima ou ignora.
 */
export interface PerfilDeCaptura {
  height: number | null;
  frameRate: number | null;
}

function perfilDaTrilha(track: MediaStreamTrack): PerfilDeCaptura {
  const s = track.getSettings();
  return {
    height: typeof s.height === 'number' ? s.height : null,
    // Fontes de tela costumam entregar fracionário; a UI mostra inteiro.
    frameRate: typeof s.frameRate === 'number' ? Math.round(s.frameRate) : null,
  };
}

interface Espectador {
  envio: EnvioDeTrilha;
  /**
   * O som que vai junto com a tela, quando há. Fica separado do vídeo porque o teto de
   * banda de §17.5 é do vídeo: aplicar `maxBitrate` de 600 kbps a uma trilha de voz de
   * aplicativo não a melhora, e aplicar 2500 não a piora — o que ela precisa é existir ou
   * não. Só o encerramento é comum aos dois.
   */
  envioDeAudio: EnvioDeTrilha | null;
  /** Perfil corrente aplicado a ESTE espectador (§17.5: por espectador, não por sessão). */
  quality: ShareQualityDto;
}

/**
 * A sessão de tela que ESTA instalação apresenta, e as que ela assiste.
 *
 * O canal aceita várias transmissões ao mesmo tempo (§17.5, 2026-08-26); o que é único é a
 * minha, porque a captura de tela de uma instalação é uma só — é por isso que esta classe é
 * instanciada uma vez e reusada, e é o que o host recusa com `E_ALREADY_SHARING`. Assistir
 * é sem estado por aqui: `assistir` só faz o `share.join`, e a trilha que chega é indexada
 * por apresentador no `telaStreams`.
 */
export class EstrelaDeTela {
  readonly #porta: PortaDeTela;
  readonly #malha: PortaDaMalha;
  readonly #captura: FabricaDeCaptura;
  readonly #eventos: EventosDaTela;
  readonly #espectadores = new Map<string, Espectador>();
  #stream: MediaStream | null = null;
  #track: MediaStreamTrack | null = null;
  /** A trilha de áudio da captura, quando a plataforma a entregou (§17.5, áudio da fonte). */
  #trackDeAudio: MediaStreamTrack | null = null;
  #sessionId: string | null = null;
  #euHex = "";
  /** Perfil pedido no `share.start`; base de quem entra depois (§17.5). */
  #qualityBase: ShareQualityDto = "balanced";
  #relogio: ReturnType<typeof setInterval> | null = null;
  /**
   * A última audiência anunciada e ainda não aplicada, e o laço que a aplica. Ver
   * `atualizarEspectadores`: audiência é nível, e o laço é o que a serializa **fora** da
   * fila de captura.
   */
  #audienciaPendente: readonly string[] | null = null;
  #aplicandoAudiencia: Promise<void> | null = null;
  /**
   * **A fila de captura** — `apresentar` e `parar` nunca correm juntas.
   *
   * As duas são longas (o host decide, o main declara, o seletor do sistema espera a
   * pessoa) e as duas escrevem `#stream`/`#track`/`#sessionId`. "Tentar novamente" chama
   * as duas em sequência SÍNCRONA (`stopShare()` e depois `startShare()` no store, cada
   * uma disparando uma promessa que ninguém aguarda), e aí a corrida é a regra e não a
   * exceção: `parar()` lê `#stream` DEPOIS dos seus `await` e encontrava a captura NOVA —
   * parava as trilhas dela, zerava a sessão nova e desfazia a declaração que o main acabara
   * de receber. A retentativa nascia morta.
   *
   * Não é lock de exclusão mútua: é ordem. Quem chega segundo espera o primeiro terminar,
   * que é exatamente a semântica que "parar e começar de novo" pede.
   */
  #fila: Promise<unknown> = Promise.resolve();

  constructor(
    porta: PortaDeTela,
    malha: PortaDaMalha,
    captura: FabricaDeCaptura,
    eventos: EventosDaTela,
  ) {
    this.#porta = porta;
    this.#malha = malha;
    this.#captura = captura;
    this.#eventos = eventos;
  }

  get sessionId(): string | null {
    return this.#sessionId;
  }

  /** Espectadores servidos agora — o que a faixa do tile mostra (§17.5). */
  get espectadores(): string[] {
    return [...this.#espectadores.keys()];
  }

  /** A tela capturada, para o `<video>` de quem apresenta. `null` fora de apresentação. */
  get stream(): MediaStream | null {
    return this.#stream;
  }

  /** Como a fonte escolhida se chama, dita pelo sistema — nunca inventado pela UI. */
  get rotuloDaFonte(): string {
    return this.#track?.label ?? "";
  }

  /**
   * A captura veio com som — **medido na trilha**, não no que foi pedido.
   *
   * Pedir áudio e recebê-lo são coisas diferentes: a plataforma pode não separar o som
   * daquela janela, e aí `getDisplayMedia` devolve vídeo e mais nada. Quem responde por
   * "está indo com áudio" é a trilha que existe, e é isto que o tile mostra.
   */
  get comAudio(): boolean {
    return this.#trackDeAudio !== null;
  }

  /**
   * §17.5 — começar a apresentar. A ordem de `T-41` está escrita nas linhas abaixo e não
   * pode ser reordenada: o host decide, o núcleo cunha o token, o main o verifica, e só
   * então a tela é capturada.
   */
  async apresentar(a: {
    communityId: string;
    channelId: string;
    euHex: string;
    quality?: ShareQualityDto;
    kind?: "screen" | "window";
    /** A fonte que a pessoa escolheu no seletor; `null` é "a primeira do tipo". */
    sourceId?: string | null;
    /** Pedir o som da fonte junto. Opt-in: som de máquina não se transmite por descuido. */
    audio?: boolean;
  }): Promise<{ sessionId: string }> {
    return this.#enfileirar(() => this.#apresentar(a));
  }

  /**
   * Serializa uma operação de captura contra as outras. A fila não propaga falha: um
   * `apresentar` que lançou não pode impedir o `parar` seguinte de rodar.
   */
  #enfileirar<T>(op: () => Promise<T>): Promise<T> {
    const proxima = this.#fila.then(op, op);
    this.#fila = proxima.catch(() => undefined);
    return proxima;
  }

  async #apresentar(a: {
    communityId: string;
    channelId: string;
    euHex: string;
    quality?: ShareQualityDto;
    kind?: "screen" | "window";
    sourceId?: string | null;
    audio?: boolean;
  }): Promise<{ sessionId: string }> {
    const quality = a.quality ?? "balanced";
    log(`share.start em ${a.channelId} · perfil ${quality}`);

    // 1. O host decide. Sem `voice_share_screen`, canal de voz e chamada ativa, não há
    //    sessão — e capturar antes disto acenderia a luz da captura à toa (§76.4).
    const r = await this.#porta.start({
      communityId: a.communityId,
      channelId: a.channelId,
      quality,
    });
    log(`share.start ok · sessão ${r.sessionId}`);
    this.#sessionId = r.sessionId;
    this.#euHex = a.euHex.toLowerCase();
    this.#qualityBase = quality;

    // 2. O main precisa saber a qual sessão a próxima captura se refere, para perguntar ao
    //    núcleo (§15.7). O `captureToken` não viaja: ele já está no núcleo desta máquina.
    //    Junto vai a FONTE escolhida — é ela que o main casa contra a lista viva antes de
    //    conceder, e é o que faz "Uma janela" transmitir a janela apontada.
    const kind = a.kind ?? "screen";
    const audio = a.audio === true;
    await this.#captura.declararSessao({
      sessionId: r.sessionId,
      kind,
      sourceId: a.sourceId ?? null,
      audio,
    });

    // 3. Agora, e só agora, a tela.
    try {
      this.#stream = await this.#captura.capturar({ kind, audio });
    } catch (e) {
      log("getDisplayMedia FALHOU", e);
      await this.#porta.stop({ sessionId: r.sessionId }).catch(() => undefined);
      this.#sessionId = null;
      await this.#captura.declararSessao({ sessionId: null, kind: "screen", sourceId: null, audio: false });
      throw e;
    }
    const track = this.#stream.getVideoTracks()[0] ?? null;
    if (track === null) {
      log("captura sem trilha de vídeo — encerrando a sessão");
      // O corpo, não a porta: já estamos DENTRO da fila, e reentrar nela esperaria a si
      // mesmo para sempre.
      await this.#parar();
      throw new Error("captura sem trilha de vídeo");
    }
    this.#track = track;
    // A trilha de áudio pode simplesmente não vir: §17.5 pede o som DA FONTE, e nem toda
    // plataforma sabe separá-lo. Ausência não é erro — é uma transmissão muda, e a UI diz
    // isso em vez de anunciar um som que ninguém vai ouvir.
    this.#trackDeAudio = this.#stream.getAudioTracks()[0] ?? null;
    log(
      `captura ok · '${track.label}'` +
        (audio ? (this.#trackDeAudio === null ? " · SEM áudio (a fonte não o entregou)" : " · com áudio") : ""),
    );

    // A pessoa pode parar pelo botão do SISTEMA, que não passa por lugar nenhum do produto.
    // Sem isto a sessão ficaria viva no host com uma trilha morta.
    track.onended = () => {
      log("captura encerrada na fonte (botão do sistema)");
      this.#eventos.aoEncerrarNaFonte();
    };

    this.#iniciarMedicao();
    return { sessionId: r.sessionId };
  }

  /**
   * `share.viewersChanged`/`share.started` disseram quem assiste. Abre o envio para quem
   * entrou e encerra o de quem saiu.
   *
   * Quem entra nesta lista é decisão do HOST (§17.5): ela já vem pronta. Filtrar de novo
   * aqui criaria uma segunda fonte de verdade para a mesma regra.
   *
   * **Uma de cada vez, e a audiência é NÍVEL, não sequência** (correção de 2026-09-06).
   *
   * Duas metades, e as duas foram medidas. A primeira: o host dispara um tique de saúde a
   * cada `viewersChanged` (`composition/boot.ts`), então dois espectadores entrando com
   * milissegundos de diferença produzem dois `share.health` sobrepostos — o primeiro com a
   * lista velha. Correndo juntas, o laço de `saindo` da chamada velha derruba o espectador
   * que a nova acabou de servir: a tela do segundo pisca ou fica preta, que é o defeito
   * relatado. Serializar resolve.
   *
   * A segunda: a fila **não pode ser a da captura**. `#enfileirar` é de `apresentar` e
   * `parar`, e servir um espectador espera a negociação dos m-lines daquele par (até 5 s em
   * `live/voz.ts`). Compartilhando a fila, um par travado prendia o "Parar de
   * compartilhar" atrás de si — medido em >4 s — e o tique de 2 s reenfileirava outro antes
   * do anterior terminar, sem teto.
   *
   * Por isso **coalescer** em vez de empilhar: a lista de espectadores é um estado, não uma
   * ordem. Quem chega enquanto uma aplicação corre não vira mais uma volta — substitui a
   * pendente, e o laço aplica a última quando puder. É a mesma disciplina do coalescimento
   * de ocupação de §17.6, pela mesma razão: quem chega no meio só precisa do valor final.
   */
  async atualizarEspectadores(chaves: readonly string[]): Promise<void> {
    this.#audienciaPendente = chaves;
    if (this.#aplicandoAudiencia !== null) return this.#aplicandoAudiencia;
    const laco = (async () => {
      try {
        while (this.#audienciaPendente !== null) {
          const alvo = this.#audienciaPendente;
          this.#audienciaPendente = null;
          await this.#atualizarEspectadores(alvo);
        }
      } finally {
        this.#aplicandoAudiencia = null;
      }
    })();
    this.#aplicandoAudiencia = laco;
    return laco;
  }

  async #atualizarEspectadores(chaves: readonly string[]): Promise<void> {
    if (this.#track === null || this.#stream === null) return;
    const vivos = new Set(
      chaves.map((k) => k.toLowerCase()).filter((k) => k !== this.#euHex),
    );

    // Uma tarefa por espectador, em paralelo: DENTRO de um espectador a ordem importa
    // (vídeo, depois áudio no mesmo `msid`, depois o bitrate no sender que acabou de
    // nascer), mas ENTRE espectadores não há nada em comum — cada um é uma conexão. Em
    // fila, servir a plateia custava uma negociação inteira por pessoa que entrou.
    const track = this.#track;
    const stream = this.#stream;
    const entrando: Promise<void>[] = [];
    for (const par of vivos) {
      if (this.#espectadores.has(par)) continue;
      entrando.push(this.#servir(par, track, stream));
    }
    await Promise.all(entrando);

    const saindo: Promise<void>[] = [];
    for (const [par, e] of [...this.#espectadores]) {
      if (vivos.has(par)) continue;
      this.#espectadores.delete(par);
      saindo.push(
        (async () => {
          await e.envio.encerrar().catch(() => undefined);
          await e.envioDeAudio?.encerrar().catch(() => undefined);
          log(`espectador ${par.slice(0, 8)} saiu`);
        })(),
      );
    }
    await Promise.all(saindo);
  }

  /** Um espectador novo: vídeo, áudio no mesmo `msid` e o bitrate do perfil base. */
  async #servir(
    par: string,
    track: MediaStreamTrack,
    stream: MediaStream,
  ): Promise<void> {
    const envio = await this.#malha.enviarTrilha(par, track, stream);
    if (envio === null) return;
    // O som vai no MESMO `MediaStream` do vídeo, e isso não é detalhe: do outro lado, é o
    // `msid` comum que faz as duas trilhas chegarem no mesmo objeto — o que o `<video>` do
    // tile já toca sem ninguém ligar nada, e o que impede a voz daquele par de ser
    // trocada pelo som da tela.
    const envioDeAudio =
      this.#trackDeAudio === null
        ? null
        : await this.#malha.enviarTrilha(par, this.#trackDeAudio, stream);
    // A captura pode ter parado enquanto este envio abria — `parar()` deixou de esperar na
    // mesma fila que a audiência. Registrar aqui um espectador de uma apresentação morta
    // deixaria um envio pendurado que o `#parar` já passou e ninguém mais encerra.
    if (this.#track !== track) {
      await envio.encerrar().catch(() => undefined);
      await envioDeAudio?.encerrar().catch(() => undefined);
      log(`espectador ${par.slice(0, 8)} descartado — a captura mudou no meio`);
      return;
    }
    this.#espectadores.set(par, { envio, envioDeAudio, quality: this.#qualityBase });
    await envio.definirBitrateKbps(SHARE_QUALITY_KBPS[this.#qualityBase]);
    log(
      `espectador ${par.slice(0, 8)} servido · ${this.#qualityBase}` +
        (envioDeAudio === null ? "" : " + áudio"),
    );
  }

  /**
   * `share.health` chegou do núcleo (§15.5, só ao apresentador). O `quality` de cada
   * espectador é o veredito do host: o perfil que ELE pediu por `share.setQuality`, já
   * passado pela degradação automática de §17.5. Aplicá-lo no `RTCRtpSender` daquele
   * espectador é o que torna a qualidade por espectador real — e o que fecha `F-08`/`V-13`.
   */
  async aplicarSaude(viewers: readonly ShareViewerHealthDto[]): Promise<void> {
    // O `quality` é escrito de forma síncrona na varredura; só o `definirBitrateKbps`,
    // que é por sender, vai em paralelo.
    const aplicando: Promise<void>[] = [];
    for (const v of viewers) {
      const e = this.#espectadores.get(v.key.toLowerCase());
      if (e === undefined || e.quality === v.quality) continue;
      e.quality = v.quality;
      aplicando.push(
        e.envio.definirBitrateKbps(SHARE_QUALITY_KBPS[v.quality]).catch(() => undefined),
      );
      const perda = v.lossPct === undefined ? "sem medida" : `${v.lossPct.toFixed(1)}% de perda`;
      log(`espectador ${v.key.slice(0, 8)} · perfil agora ${v.quality} (${perda})`);
    }
    await Promise.all(aplicando);
  }

  /**
   * §15.4 papel **apresentador** (emenda de 2026-08-26) — o teto de banda com que a tela
   * sai. São duas metades, e as duas precisam acontecer: o host registra a base nova (para
   * que `share.health` não venha logo em seguida desfazê-la) e os `RTCRtpSender` vivos
   * passam a valer o perfil novo **agora**, sem esperar o tique de saúde.
   *
   * Sem a segunda metade este comando seria mais um "estado que muda e efeito que não
   * acontece" da família de §85.2: o rótulo mudaria na tela e a transmissão continuaria
   * igual até alguém medir perda.
   */
  async definirQualidade(sessionId: string, quality: ShareQualityDto): Promise<boolean> {
    const r = await this.#porta.setQuality({ sessionId, quality });
    log(`share.setQuality ${quality} → applied=${r.applied}`);
    if (!r.applied) return false;
    this.#qualityBase = quality;
    // Como em `aplicarSaude`: o `quality` é escrito na varredura, e só o bitrate — que é
    // por sender, um por espectador — vai em paralelo.
    const aplicando: Promise<void>[] = [];
    for (const [par, e] of this.#espectadores) {
      e.quality = quality;
      aplicando.push(
        e.envio.definirBitrateKbps(SHARE_QUALITY_KBPS[quality]).catch(() => undefined),
      );
      log(`espectador ${par.slice(0, 8)} · perfil agora ${quality} (apresentador)`);
    }
    await Promise.all(aplicando);
    return true;
  }

  /**
   * §17.5 emendado — resolução e taxa de quadros da CAPTURA, do apresentador e só dele.
   *
   * Não passa pelo host e não tem RPC: é `applyConstraints` sobre a trilha que esta máquina
   * captura, do mesmo jeito que `track.enabled` é o mudo efetivo de §17.4 L-12. Quem possui
   * o dispositivo decide o que sai dele; o host decide quem pode receber.
   *
   * `null` em qualquer campo é "como a fonte entregar" — não é um valor, é a ausência de
   * restrição, e é o padrão. Uma fonte pode recusar a restrição (o navegador aproxima, ou
   * ignora): a promessa aqui é ter PEDIDO, nunca ter conseguido, e é por isso que o valor
   * que a UI mostra vem de volta da trilha, não do que foi pedido.
   */
  async definirCaptura(a: { height: number | null; frameRate: number | null }): Promise<PerfilDeCaptura> {
    const track = this.#track;
    if (track === null) return { height: null, frameRate: null };
    const constraints: MediaTrackConstraints = {};
    if (a.height !== null) constraints.height = { max: a.height };
    if (a.frameRate !== null) constraints.frameRate = { max: a.frameRate };
    try {
      // Sem restrição nenhuma, `applyConstraints({})` é o que LIMPA as anteriores.
      await track.applyConstraints(constraints);
    } catch {
      log('a fonte recusou a restrição de captura; segue como estava');
    }
    const efetivo = perfilDaTrilha(track);
    log(`captura · ${efetivo.height ?? '?'}p @ ${efetivo.frameRate ?? '?'} fps`);
    return efetivo;
  }

  /** O que a trilha está de fato entregando agora — a fonte da verdade da UI. */
  perfilDeCaptura(): PerfilDeCaptura {
    return this.#track === null ? { height: null, frameRate: null } : perfilDaTrilha(this.#track);
  }

  /** §15.4 — entrar como espectador de uma sessão que outra pessoa abriu. */
  async assistir(sessionId: string): Promise<{ presenterKey: string }> {
    log(`share.join na sessão ${sessionId}`);
    const r = await this.#porta.join({ sessionId });
    log(`share.join ok · apresentador ${r.presenterKey.slice(0, 8)}`);
    return { presenterKey: r.presenterKey };
  }

  /** Encerra a apresentação: para a captura, os envios e a sessão no host. */
  async parar(): Promise<void> {
    return this.#enfileirar(() => this.#parar());
  }

  async #parar(): Promise<void> {
    const sessionId = this.#sessionId;
    this.#pararMedicao();
    // A audiência que ainda não foi aplicada é desta sessão e morre com ela: aplicá-la
    // depois seria servir a plateia velha da apresentação seguinte.
    this.#audienciaPendente = null;
    // Em paralelo: encerrar é uma operação por conexão, e em fila o fechamento da
    // apresentação demorava o tamanho da plateia.
    await Promise.all(
      [...this.#espectadores.values()].map(async (e) => {
        await e.envio.encerrar().catch(() => undefined);
        await e.envioDeAudio?.encerrar().catch(() => undefined);
      }),
    );
    this.#espectadores.clear();
    if (this.#track !== null) this.#track.onended = null;
    for (const t of this.#stream?.getTracks() ?? []) t.stop();
    this.#stream = null;
    this.#track = null;
    this.#trackDeAudio = null;
    this.#sessionId = null;
    await this.#captura
      .declararSessao({ sessionId: null, kind: "screen", sourceId: null, audio: false })
      .catch(() => undefined);
    if (sessionId !== null) {
      await this.#porta.stop({ sessionId }).catch(() => undefined);
      log(`sessão ${sessionId} encerrada`);
    }
  }

  /**
   * A cadência de §17.6: a cada 2 s, mede cada envio e **relata ao núcleo**
   * (`share.report`). Quem consolida e decide degradar é o host, que é quem sabe o perfil
   * que cada espectador pediu; o veredito volta por `share.health`.
   */
  #iniciarMedicao(): void {
    this.#pararMedicao();
    this.#relogio = setInterval(() => void this.medirERelatar(), CADENCIA_DE_SAUDE_MS);
  }

  #pararMedicao(): void {
    if (this.#relogio !== null) clearInterval(this.#relogio);
    this.#relogio = null;
  }

  /** Um ciclo de medição. Exposto para o teste não depender de temporizador de parede. */
  async medirERelatar(): Promise<void> {
    const sessionId = this.#sessionId;
    if (sessionId === null || this.#espectadores.size === 0) return;
    const samples: Array<{ viewerKey: string; rttMs: number; lossPct: number }> = [];
    const locais: ShareViewerHealthDto[] = [];
    // `getStats` de todos os espectadores de uma vez: em fila, um ciclo de medição
    // crescia com a plateia e podia passar do próprio intervalo. O `map` preserva a
    // ordem dos espectadores no resultado.
    const medidas = await Promise.all(
      [...this.#espectadores].map(async ([par, e]) => ({
        par,
        e,
        s: await e.envio.estatisticas().catch(() => null),
      })),
    );
    for (const { par, e, s } of medidas) {
      if (s === null) continue;
      samples.push({ viewerKey: par, rttMs: s.rttMs, lossPct: s.lossPct });
      locais.push({ key: par, rttMs: s.rttMs, lossPct: s.lossPct, quality: e.quality });
    }
    if (samples.length === 0) return;
    // A UI do apresentador não espera o round-trip para mostrar número: o que ela mostra é
    // o que ESTA máquina mediu. O que volta do host é o veredito de PERFIL, não a medida.
    this.#eventos.aoMedir?.(locais);
    await this.#porta.report({ sessionId, samples }).catch((e: unknown) => {
      log("share.report falhou — a amostra desta volta se perde (§16.3 regra 1)", e);
    });
  }
}
