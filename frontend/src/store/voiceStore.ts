import { create } from "zustand";
import { persist } from "zustand/middleware";
import { codigoDoErro } from "../ipc/frames";
import { useShallow } from "zustand/react/shallow";
import type {
  Channel,
  MeshStatus,
  ScreenShareSession,
  VoiceParticipant,
} from "../domain/types";
import { type ShareViewerHealthDto } from "../ipc/api";
import { motivoDoErroDeMicrofone } from "../live/voz";

/**
 * Sessão de voz e compartilhamento de tela (§9, 2.3 / 2.3.1 / 2.4 · fluxos
 * B5, B6, B7 e C11).
 *
 * A chamada é **independente da navegação** (§4, C11): mora aqui e não na
 * comunidade/canal ativos, por isso sobrevive à troca de canal e até de
 * comunidade. Só existe uma sessão por vez — entrar em outro canal de voz
 * substitui a anterior, como no gênero.
 *
 * Nada disto é persistido, exceto a resposta ao consentimento de repasse
 * (§9, 2.4.1: "Lembrar minha escolha para esta comunidade"): estado de
 * conexão é sempre do agora.
 */


/* ─── Tipos ──────────────────────────────────────────────────────── */

export type VoiceStage = "connecting" | "connected" | "failed";

/** O que o store precisa da malha — nada de WebRTC atravessa esta fronteira. */
export interface PortaDeMalha {
  entrar: (a: { communityId: string; channelId: string; localId: string }) => Promise<void>;
  sair: () => Promise<void>;
  /** §15.4 `voice.setSelf` — mudo/ensurdecido/câmera vão ao host, que publica no roster. */
  mudarSelf: (patch: { muted?: boolean; deafened?: boolean; cameraOn?: boolean }) => void;
  /**
   * §17.4 L-12 — o efeito REAL das três decisões locais de áudio. `mudarSelf` conta ao host
   * e acende o ícone dos outros; nada disso interrompe som. Quem interrompe é isto:
   * `definirMudo` desliga a trilha do microfone, `definirSurdo` e `definirVolume` mexem na
   * saída de cada par. Sem essa metade, mudo e ensurdecer eram decoração.
   */
  definirMudo: (mudo: boolean) => void;
  definirSurdo: (surdo: boolean) => void;
  definirVolume: (peerHex: string, volume: number) => void;
  /**
   * §17.4 (emenda de 2026-08-28) — o mute IMPOSTO pelo modo de fala/fila: corta a trilha
   * que sai (mic + música), e quem o desfaz é o roster. Opcional: ponte anterior não o
   * conhece, e aí o roster continua sendo a única fonte (comportamento de antes).
   */
  definirMudoImpositivo?: (imposto: boolean) => void;
  /**
   * §10, 3.1 (B47) — trocar de microfone DURANTE a chamada: re-captura e `replaceTrack` em
   * todos os pares, sem renegociação. Opcional pelas mesmas razões do imposto: ponte
   * anterior não o conhece, e aí a escolha nova vale na próxima chamada (comportamento antigo).
   */
  trocarMicrofone?: (deviceId: string) => Promise<void>;
  /** §10, 3.1 (B47) — o `inputVolume` ao vivo: o ganho do que ESTA máquina transmite. */
  definirVolumeEntrada?: (p: number) => void;
  /**
   * §17.5 (emenda de 2026-08-28) — o Modo Música inteiro: autorização local, captura de
   * sistema e mixagem na trilha de saída. O `MediaStream` NUNCA atravessa para o store —
   * o que volta é o desfecho nomeado.
   *
   * **Emenda de 2026-09-03 — um desfecho por causa.** Havia um `indisponivel` só, e ele
   * cobria quatro falhas diferentes numa frase que acusava a PLATAFORMA. Num Windows, que
   * é onde o Modo Música sempre funcionou, essa frase mandou a investigação para o lado
   * errado. Agora cada ramo tem nome:
   *
   * - `null` — ligou.
   * - `"negado"` — o núcleo recusou: sem permissão ou sem chamada (§15.4 `music.start`).
   * - `"indisponivel"` — a plataforma não tem captura de áudio de sistema. Só isto pode
   *   dizer "nesta plataforma".
   * - `"recusada"` — a captura foi recusada no caminho (o main negou, o núcleo não
   *   respondeu, ou o Chromium falhou). É o desfecho cuja razão mora no log do main.
   * - `"sem-som"` — a captura subiu, mas sem trilha de áudio: há imagem e não há som.
   * - `"sem-mistura"` — o som chegou e o grafo de mixagem não montou (sem microfone na
   *   chamada, ou sem `AudioContext`).
   */
  definirMusica: (
    ligada: boolean,
  ) => Promise<{ erro: "indisponivel" | "negado" | "recusada" | "sem-som" | "sem-mistura" | null }>;
  /** Volume da música 0..100 (§17.5 — só a perna de sistema do grafo). */
  definirVolumeMusica: (volume: number) => void;
  /**
   * §15.4 `voice.muteParticipant` / §17.4 L-12 — silenciar OUTRO participante. É **conselho
   * ao cliente do alvo**, e o caminho do conselho é o host: ele marca `muted` no roster e
   * republica, e o cliente do alvo lê isso como imposição (`definirMudoImpositivo`) e corta
   * a trilha que sai. Sem esta linha o botão só pintava o ícone desta máquina, e o próximo
   * roster o desfazia — silenciar era decoração, exatamente o que L-12 manda a UI distinguir
   * de "removido da chamada".
   *
   * Opcional pelas mesmas razões das vizinhas: uma ponte anterior não a conhece.
   */
  mutarParticipante?: (identityKey: string, muted: boolean) => Promise<void>;
  /** Épico 4 — os streams que a gravação local mistura (pares + mic). */
  fluxosParaGravacao: () => MediaStream[];
}

let portaDeMalha: PortaDeMalha | null = null;

/**
 * O que o store precisa da câmera — §17.2. Nada de `MediaStream` atravessa esta fronteira:
 * o pixel mora em `live/cameraStreams.ts`, como o da tela.
 *
 * `ligar` **não lança**: devolve o motivo já em português (§20.1). Uma câmera que não liga
 * é um desfecho previsto — o SO nega, o dispositivo sumiu, outro aplicativo o tomou —, e
 * cada um desses pede uma ação diferente de quem está do lado de cá.
 */
export interface PortaDeCamera {
  ligar: () => Promise<{ erro: string | null }>;
  desligar: () => Promise<void>;
}

let portaDeCamera: PortaDeCamera | null = null;

/**
 * O que o store precisa da fila de karaokê (§16.4) — a fronteira espelha a de voz: nada
 * de transporte atravessa, e as recusas chegam nomeadas (§20.1).
 */
export interface PortaDeFila {
  entrar: (a: { communityId: string; channelId: string }) => Promise<void>;
  sair: (a: { communityId: string; channelId: string }) => Promise<void>;
  moderar: (a: { communityId: string; channelId: string; action: "promote" | "skip" | "remove" | "addTime" | "open" | "close"; targetKey?: string; seconds?: number }) => Promise<void>;
}

let portaDeFila: PortaDeFila | null = null;

/**
 * A preferência de §8, 1.1 precisa virar efeito ao entrar, não só ícone: sem isto,
 * entrar com o microfone "desligado" na barra de usuário transmitiria som mesmo assim —
 * a mesma mentira que L-12 tirou do mudo de dentro da chamada.
 */
function aplicarPreferenciaDeAudio({
  selfMuted,
  selfDeafened,
}: {
  selfMuted: boolean;
  selfDeafened: boolean;
}) {
  if (!selfMuted && !selfDeafened) return;
  portaDeMalha?.mudarSelf({ muted: selfMuted, deafened: selfDeafened });
  portaDeMalha?.definirMudo(selfMuted);
  portaDeMalha?.definirSurdo(selfDeafened);
}

/**
 * §17.5 — iniciando · ativo · falha. `optimizing` era a transição estrela→árvore que A20
 * revogou (B26): sem árvore, não há distribuição a otimizar e o banner mentiria.
 */
export type SharePhase = "starting" | "live" | "failed";

export type ShareQuality = ScreenShareSession["quality"];

export interface ActiveShare extends ScreenShareSession {
  /**
   * §17.5 — a chave da sessão. Passou a ser obrigatória quando o canal deixou de ter no
   * máximo uma transmissão (2026-08-26): com várias vivas ao mesmo tempo, "a sessão" não
   * identifica mais nada. Vazio enquanto a MINHA está em `starting` — o host ainda não
   * respondeu com o id, e quem a identifica nesse intervalo é `presenterId`.
   */
  sessionId: string;
  phase: SharePhase;
  /**
   * §17.5 — quem assiste ocultou o vídeo **desta** transmissão. É por sessão porque a
   * decisão é por sessão: com duas telas no canal, esconder uma não diz nada sobre a outra.
   * Exibição local; a `RTCPeerConnection` continua de pé e o apresentador não é afetado.
   */
  oculto: boolean;
  /** O que está sendo transmitido, como a fonte real se chama (`track.label`). */
  sourceLabel: string;
  /**
   * §17.5 — a transmissão leva som. **Medido na trilha capturada**, não pedido: a fonte
   * pode não separar o áudio dela, e um selo "com áudio" sobre uma transmissão muda é a
   * mesma categoria de mentira que §90 tirou do contador de espectadores.
   *
   * Só o apresentador o conhece — quem assiste ouve (ou não) e não precisa de selo.
   */
  comAudio: boolean;
  /** `share.failed` (§15.5) — por que a transmissão não subiu. */
  motivoDaFalha: string | null;
  /**
   * §17.5 — saúde por espectador, **só no apresentador**. Vem de `share.health`, que o
   * núcleo consolida a partir do que este renderer mediu (`share.report`).
   */
  saude: ShareViewerHealthDto[];
}

/**
 * §17.7 — o pedido de consentimento de **relay voluntário**. Diferente da árvore, isto NÃO
 * foi revogado: é v2, e §15.5 declara `relay.consentRequested{communityId, reason}`. Fica
 * dormente até o relay existir (B27/B30) — o que mudou nesta fatia é o gatilho, que era a
 * transição estrela→árvore e não existe mais.
 */
export interface ConsentRequest {
  communityId: string;
  reason: string;
}

/** O que o store precisa da estrela de tela — nada de WebRTC atravessa esta fronteira. */
export interface PortaDeTelaStore {
  apresentar: (a: {
    communityId: string;
    channelId: string;
    localId: string;
    quality: ShareQuality;
    kind: "screen" | "window";
    /** A fonte escolhida no seletor; `null` é "a primeira do tipo". */
    sourceId: string | null;
    /** Pedir o som da fonte junto — opt-in. */
    audio: boolean;
  }) => Promise<{ sessionId: string; sourceLabel: string; comAudio: boolean }>;
  parar: () => Promise<void>;
  /**
   * §15.4 `share.join` — entrar como espectador. Existe aqui, e não só em
   * `live/sincronizacao.ts`, porque **falhar ao entrar é reversível**: "Tentar novamente"
   * na tela de quem assiste tem de repetir o `share.join`, não a captura de quem apresenta.
   *
   * Devolve o motivo em português em vez de lançar, como a porta da câmera: uma recusa do
   * host é desfecho previsto, não exceção.
   */
  assistir: (sessionId: string) => Promise<{ erro: string | null }>;
  /** Papel **apresentador** (§15.4, emenda de 2026-08-26): o teto de banda da transmissão. */
  definirQualidade: (sessionId: string, quality: ShareQuality) => Promise<boolean>;
  /** §17.5 emendado — resolução e taxa de quadros da captura; local, sem host. */
  definirCaptura: (a: PerfilDeCaptura) => Promise<PerfilDeCaptura>;
  perfilDeCaptura: () => PerfilDeCaptura;
}

/**
 * §17.5 — o que a captura do apresentador está entregando. `null` é "como a fonte
 * entregar": ausência de restrição, que é o padrão e não um valor.
 */
export interface PerfilDeCaptura {
  height: number | null;
  frameRate: number | null;
}

interface VoiceState {
  channelId: string | null;
  communityId: string | null;
  /** Quem a identidade local é dentro desta comunidade (§8, 1.3). */
  localId: string | null;
  stage: VoiceStage;
  /** §17.3/§9 (2.3) — por que a chamada não fechou. `conn-failed` é estado desenhado. */
  motivoDaFalha: string | null;
  /** Inclui a identidade local — §18: sozinha, a grade mostra o tile dela. */
  participants: VoiceParticipant[];
  /** Grade expandida (2.3) vs. só a barra persistente (2.3.1). */
  expanded: boolean;
  /**
   * §17.5 — as transmissões vivas do canal, na ordem em que começaram. **Lista desde
   * 2026-08-26**: `E_ALREADY_SHARING` por canal era `RT-06`, uma contradição entre
   * documentos resolvida a favor do que já estava escrito, e não uma restrição de
   * arquitetura — a trilha de tela pega carona na conexão de voz que já existe entre cada
   * par, então um segundo apresentador não abre malha nova.
   */
  shares: ActiveShare[];
  /** `sessionId` da sessão de tela viva — a chave de todo comando de §15.4. */
  shareSessionId: string | null;
  /**
   * §17.5 — o perfil de captura do APRESENTADOR, como a fonte o está entregando. Espelho de
   * `getSettings()` da trilha, nunca do que foi pedido: entre pedir e conseguir há a fonte.
   * Um por instalação, porque a captura de tela de uma instalação é uma só.
   */
  capturaDaTela: PerfilDeCaptura;
  /** §17.7 — dormente até o relay voluntário existir; a decisão persistida já vale. */
  consentRequest: ConsentRequest | null;
  relayDecisionByCommunity: Record<string, boolean>;
  /** Volume individual por participante, 0-100 (§9, 2.3 · §8, 1.4). */
  volumeById: Record<string, number>;
  /**
   * §8, 1.1 — mudo e ensurdecer da barra de usuário: **preferência da instalação**, não
   * estado da chamada. Persistidos e válidos fora dela, para que entrar num canal já
   * mudo seja possível — que é a razão de o controle existir no rodapé e não só dentro
   * da sessão. Dentro da chamada quem manda continua sendo o roster: estes dois são o
   * que a máquina pede, o participante local é o que o host publicou.
   */
  selfMuted: boolean;
  selfDeafened: boolean;
  /**
   * §17.5 (emenda de 2026-08-28) — Modo Música. `ativa` é estado da CHAMADA (morre com
   * ela — a captura é da sessão); `volume` e `mutarMicJunto` são preferência da
   * instalação, persistidos como os vizinhos. `mutarMicJunto` é o US-02: quem toca música
   * não quer o microfone do ambiente junto — ligá-la muta o microfone de uma vez.
   */
  musicaAtiva: boolean;
  musicaErro: string | null;
  musicaVolume: number;
  musicaMutarMic: boolean;
  /**
   * §16.4 (emenda de 2026-08-28) — a fila de karaokê do canal em chamada, como o último
   * `voice.queueChanged` a entregou. Estado efêmero: morre com a chamada e é reconstruído
   * por `query.voiceQueue` quando o evento se perde (§15.1 regra 5). `null` = sem fila
   * conhecida (canal fora do modo fila, ou nada chegou ainda).
   */
  fila: {
    channelId: string;
    open: boolean;
    items: Array<{ keyHex: string; queuedAt: number }>;
    turn: { keyHex: string; endsAt: number } | null;
  } | null;
  /** §16.4 — por que a entrada na fila foi recusada, em português (§20.1). */
  motivoDaFila: string | null;
  /**
   * §17.2 — a captura da câmera está em curso. Entre o gesto e a imagem há o diálogo de
   * permissão do sistema, que pode demorar o tempo que a pessoa levar para responder.
   *
   * É estado próprio, e não um `cameraOn` otimista, pela razão de A25: ligar pode ser
   * NEGADO, e o botão que já se acendeu teria de apagar sozinho. O ícone da câmera é o que
   * o outro lado vê no roster — acendê-lo antes de haver imagem é a decoração que §85.2
   * tirou do mudo.
   */
  cameraPendente: boolean;
  /** §15.5 `voice.deviceError`/`RT-10` — por que a câmera não ligou, em português. */
  erroDeCamera: string | null;
  /**
   * §15.5 `voice.deviceError`/`RT-10` — o problema de dispositivo que o NÚCLEO nomeou
   * (e que esta captura local não viu). Separado de `erroDeCamera` porque aquele é o
   * desfecho da ação de ligar a câmera; este chega de surpresa, a qualquer momento.
   */
  erroDeDispositivo: string | null;
  /**
   * Quantas vezes o conjunto de câmeras vivas mudou. Não é contador de nada que a UI mostre:
   * é o que diz ao tile "há um `MediaStream` novo em `live/cameraStreams`, vá buscar".
   *
   * Existe porque o pixel mora fora do React de propósito (ele não serializa e não sobrevive
   * a ser recriado), e um par cuja câmera o roster já anunciou **antes** da trilha chegar não
   * teria nada mudando na própria linha para reexecutar o efeito. Sem isto, quem visse
   * `cameraOn: true` primeiro e a imagem depois ficaria com o tile preto até um render por
   * outro motivo.
   */
  cameraSeq: number;

  /**
   * §17.2 — a malha real, injetada por `live/sincronizacao.ts`. O store continua dono do
   * ESTADO que a tela lê; quem fala WebRTC é `live/voz.ts`. Sem porta (teste de componente,
   * Storybook), `join` só desenha o estado — não é simulação, é ausência declarada.
   */
  configurarVoz: (porta: PortaDeMalha | null) => void;
  /** `voice.roster` — o host publicou a lista. É ela que manda, não o palpite local. */
  aplicarRoster: (participantes: ReadonlyArray<{ keyHex: string; muted?: boolean; deafened?: boolean; speaking?: boolean; cameraOn?: boolean; sharing?: boolean }>) => void;
  /** Estado da conexão com UM par (§9, 2.3 — a falha é assimétrica e nomeada). */
  aplicarEstadoDoPar: (peerHex: string, estado: "ok" | "degraded" | "failed") => void;
  /**
   * `voice.revoked` para mim ou `voice.failed`: a chamada acabou por decisão do host
   * (§17.4). O motivo é **opcional** porque os dois eventos do MESMO encerramento chegam
   * separados e sem ordem garantida (§16.3 regra 1) — quem tem o motivo o entrega, quem
   * não tem preserva o que já foi entregue.
   */
  encerradaPeloHost: (motivo?: string) => void;
  /** A malha desistiu: prazo vencido sem par conectado, com o motivo já traduzido. */
  falhouAoConectar: (motivo: string) => void;
  /** §15.5 `voice.deviceError` — o problema de dispositivo que o núcleo anunciou. */
  registrarErroDeDispositivo: (motivo: string) => void;
  join: (channel: Channel, localId: string) => void;
  retryJoin: () => void;
  leave: () => void;
  toggleMute: () => void;
  toggleDeafen: () => void;
  /** §17.5 (emenda de 2026-08-28) — ligar/desligar o Modo Música. */
  toggleMusica: () => Promise<void>;
  /** Volume da música 0–100 (§17.5). */
  definirMusicaVolume: (volume: number) => void;
  /** Preferência US-02: mutar o mic enquanto a música toca. */
  definirMusicaMutarMic: (quer: boolean) => void;
  /** §16.4 — aplica o instantâneo da fila vindo do evento (ou da consulta). */
  aplicarFila: (fila: { channelId: string; open: boolean; items: Array<{ keyHex: string; queuedAt: number }>; turn: { keyHex: string; endsAt: number } | null }) => void;
  /** §16.4 — entrar/sair da fila; recusas viram motivo nomeado. */
  entrarNaFila: () => Promise<void>;
  sairDaFila: () => Promise<void>;
  /** Ação de moderação da fila (§16.4), gated na UI por voice_mute_others. */
  moderarFila: (a: { action: "promote" | "skip" | "remove" | "addTime" | "open" | "close"; targetKey?: string; seconds?: number }) => Promise<void>;
  /**
   * Épico 4 — push-to-talk: pressionado abre o microfone, solto fecha. Reusa o caminho
   * completo do mute (estado + host + trilha); quem decide SE vale é o ouvinte de tecla,
   * que checa a preferência e o alvo do evento.
   */
  aplicarPTT: (pressionado: boolean) => void;
  /** Épico 4 — insumo da gravação local, via porta (nada de MediaStream no estado). */
  consultarFluxos: () => MediaStream[] | null;
  /** Injeção da porta (mesmo padrão de configurarVoz). */
  configurarFila: (porta: PortaDeFila) => void;
  /**
   * §17.2 — a câmera real: captura o dispositivo, põe a trilha na malha e conta ao host.
   * Devolve na hora; o que acontece depois é a captura, que pode ser negada (§93.3).
   */
  toggleCamera: () => void;
  /** §17.2 — a câmera real, injetada por `live/sincronizacao.ts`. */
  configurarCamera: (porta: PortaDeCamera | null) => void;
  /**
   * A câmera parou **fora do produto**: cabo puxado, dispositivo tomado por outro
   * aplicativo, permissão revogada com a chamada em curso. Quem avisa o host nesse caminho é
   * `live/sincronizacao.ts`, que é quem tem o evento — aqui só desce o estado.
   */
  cameraCaiu: (motivo: string | null) => void;
  /**
   * O microfone LOCAL sumiu com a chamada em curso (ou já entrou ausente): cabo
   * puxado, dispositivo tomado, permissão revogada. A chamada SEGUE em
   * somente-escuta — este campo é só o aviso não intrusivo que pede a troca de
   * dispositivo. `null` limpa (troca bem-sucedida, chamada nova). Espelho de
   * `cameraCaiu`, sem tocar no roster: o `muted` de §17.4 é do host, e marcá-lo
   * aqui imporia mudo (que corta a música junto) por um motivo local.
   */
  erroDeMicrofone: string | null;
  microfoneCaiu: (motivo: string | null) => void;
  /**
   * A câmera de um par **chegou**: a trilha é a prova, e ela pode chegar antes do roster
   * que a anuncia. O host continua mandando — o próximo `voice.roster` sobrepõe —, mas até
   * lá o tile mostra o que está de fato entrando em vez de esperar o eco.
   */
  cameraDoParChegou: (peerHex: string) => void;
  setExpanded: (expanded: boolean) => void;
  setVolume: (identityId: string, volume: number) => void;
  /** Silenciar outro participante — exige `voice_mute_others` (§10, 3.2). */
  setParticipantMuted: (identityId: string, muted: boolean) => void;

  /** §17.2/§17.5 — a estrela real, injetada por `live/sincronizacao.ts`. */
  configurarTela: (porta: PortaDeTelaStore | null) => void;
  startShare: (a?: {
    quality?: ShareQuality;
    kind?: "screen" | "window";
    sourceId?: string | null;
    audio?: boolean;
  }) => void;
  stopShare: () => void;
  /** §15.4 papel apresentador — o teto de banda com que a MINHA tela sai (§17.5). */
  setQuality: (quality: ShareQuality) => void;
  /** §17.5 — resolução e taxa de quadros da captura. Só quem apresenta, e sem host. */
  definirCaptura: (a: Partial<PerfilDeCaptura>) => void;
  /** §17.5 — quem assiste liga e desliga a EXIBIÇÃO local de UMA tela, nunca a transmissão. */
  alternarVideoRecebido: (sessionId: string) => void;
  /**
   * "Tentar novamente" — e o que se tenta depende de **quem eu sou nesta transmissão**.
   * Apresentador repete a captura inteira, com a mesma fonte; espectador repete o
   * `share.join`, que é a única coisa que falhou do lado dele. Sem essa distinção, o botão
   * que aparecia para quem assiste procurava a transmissão *dele* e não fazia nada.
   */
  retryShare: (sessionId?: string) => void;

  /** `share.started` (§15.5) — alguém começou a apresentar neste canal. */
  telaComecou: (a: { sessionId: string; presenterKey: string; channelId: string }) => void;
  /** `share.stopped` (§15.5) — a sessão acabou, por quem apresenta ou por moderação. */
  telaParou: (sessionId: string) => void;
  /** `share.viewersChanged` (§15.5) — a audiência mudou de tamanho. */
  telaMudouEspectadores: (a: { sessionId: string; viewerCount: number }) => void;
  /** `share.health` (§15.5) — só ao apresentador. */
  telaMediuSaude: (viewers: readonly ShareViewerHealthDto[]) => void;
  /**
   * `share.failed` (§15.5) — uma transmissão não subiu, ou parou de valer para mim.
   *
   * `sessionId` não é opcional por preguiça: quem falha pode ser **a minha** transmissão
   * (que ainda não tem id, porque o host não respondeu) ou **a de outra pessoa que eu
   * estava assistindo** — o caso do espectador revogado de §17.5, que é justamente o que a
   * emenda de 2026-08-26 criou o evento para dizer. Sem o id, este caminho procurava sempre
   * a minha e o espectador ficava em "Preparando compartilhamento…" para sempre, com o
   * motivo descartado em silêncio (§94.3).
   */
  telaFalhou: (motivo: string, sessionId?: string) => void;

  /** §15.4 `relay.respondConsent` — a decisão de §17.7, com "lembrar nesta comunidade". */
  respondConsent: (accept: boolean, remember: boolean) => void;

  /* Afinadores de §19.1 — sem rede real, nada disto acontece sozinho. */
  devSetPeerMesh: (identityId: string, status: MeshStatus) => void;
  devFailJoin: () => void;
}

/* ─── Porta da tela ──────────────────────────────────────────────── */

/**
 * A árvore de distribuição que morava aqui (`buildRelays`, `relayCandidates`,
 * `retopologize`, `EXTRA_VIEWER_IDS`) saiu inteira: A20 adiou o multicast em árvore para
 * fora do v1 e §17.5 fixou a estrela. Junto saíram os temporizadores que simulavam preparo,
 * otimização e reparo — não há o que simular quando existe rede de verdade (B26).
 */
let portaDeTela: PortaDeTelaStore | null = null;

/**
 * O último pedido de transmissão desta máquina — o que "Tentar novamente" repete.
 *
 * Sem isto, `retryShare` reenviava só o perfil de qualidade: a fonte escolhida sumia e a
 * retentativa caía na primeira fonte do tipo, que é exatamente o defeito que o seletor de
 * §17.5 existe para corrigir. Quem tentou de novo transmitir a janela do editor recebia
 * outra janela qualquer, sem ter mudado nada.
 *
 * Não é estado de UI: nada renderiza a partir daqui, e o `ActiveShare` fala do que ESTÁ
 * acontecendo, não do que foi pedido.
 */
let ultimoPedidoDeTela: {
  kind: "screen" | "window";
  sourceId: string | null;
  audio: boolean;
} = { kind: "screen", sourceId: null, audio: false };

/* ─── Store ──────────────────────────────────────────────────────── */

const CAPTURA_LIVRE: PerfilDeCaptura = { height: null, frameRate: null };

/**
 * A transmissão que ESTA instalação apresenta, se houver. Com várias vivas no canal
 * (§17.5, 2026-08-26), "a minha" é a que tem a minha chave — não a única que existe.
 */
function minhaTela(shares: readonly ActiveShare[], localId: string | null): ActiveShare | undefined {
  if (localId === null) return undefined;
  const eu = localId.toLowerCase();
  return shares.find((s) => s.presenterId.toLowerCase() === eu);
}

/** Substitui UMA transmissão da lista, deixando as outras intactas. */
function comTela(
  shares: readonly ActiveShare[],
  sessionId: string,
  patch: (s: ActiveShare) => ActiveShare,
): ActiveShare[] {
  return shares.map((s) => (s.sessionId === sessionId ? patch(s) : s));
}

const IDLE = {
  channelId: null,
  communityId: null,
  localId: null,
  stage: "connecting" as VoiceStage,
  motivoDaFalha: null as string | null,
  participants: [] as VoiceParticipant[],
  expanded: false,
  shares: [] as ActiveShare[],
  shareSessionId: null,
  capturaDaTela: CAPTURA_LIVRE,
  cameraPendente: false,
  erroDeCamera: null,
  erroDeMicrofone: null as string | null,
  erroDeDispositivo: null as string | null,
  cameraSeq: 0,
  consentRequest: null,
  // §17.5 (emenda de 2026-08-28) — Modo Música. Estado da chamada: morre com ela.
  musicaAtiva: false,
  musicaErro: null as string | null,
  // §16.4 — a fila é da chamada: morre com ela, como a música.
  fila: null as {
    channelId: string;
    open: boolean;
    items: Array<{ keyHex: string; queuedAt: number }>;
    turn: { keyHex: string; endsAt: number } | null;
  } | null,
  motivoDaFila: null as string | null,
};

/**
 * §20.1 — o desfecho NOMEADO de um `voice.join` que não saiu. O `.catch(() => failed)` que
 * existia descartava o código da recusa: `E_PERMISSION_DENIED` do host e o
 * `NotAllowedError` do sistema apareciam na tela como a mesma frase genérica de conexão —
 * e mandavam a pessoa clicar "Tentar novamente" contra uma recusa que não ia mudar.
 */
function motivoDaEntrada(e: unknown): string {
  // A captura do microfone falha com `DOMException` (`name`), não com código de §20.2.
  const nome = (e as { name?: string } | null)?.name;
  if (typeof nome === "string" && nome !== "") return motivoDoErroDeMicrofone(e);
  switch (codigoDoErro(e)) {
    case "E_HOST_UNAVAILABLE":
      return "Sem conexão com quem hospeda a comunidade.";
    case "E_PERMISSION_DENIED":
      return "Você não tem permissão para falar neste canal.";
    case "E_CHANNEL_NOT_VOICE":
      return "Este canal não é de voz.";
    case "E_CHANNEL_NOT_FOUND":
      return "Este canal não existe mais.";
    case "E_COMMUNITY_ENDED":
      return "Esta comunidade foi encerrada.";
    default:
      return "Não foi possível conectar à chamada de voz.";
  }
}

/**
 * §20.1 — o desfecho nomeado do Modo Música vira frase. Cada ramo diz o que aconteceu e
 * o que a pessoa pode fazer; nenhum deles acusa a plataforma sem que a plataforma seja a
 * causa (emenda de 2026-09-03 — era uma frase só para quatro falhas, e ela mentia).
 */
function motivoDaMusica(erro: string | null | undefined): string {
  switch (erro) {
    case undefined:
      return "A ponte de captura não está disponível.";
    case "indisponivel":
      return "Modo Música indisponível nesta plataforma — use Compartilhar tela (com áudio).";
    case "negado":
      return "Sem permissão ou sem chamada para transmitir música.";
    case "recusada":
      return "A captura do áudio do sistema foi recusada — veja o log do aplicativo para o motivo.";
    case "sem-som":
      return "A captura subiu sem som — o sistema não entregou o áudio da máquina.";
    case "sem-mistura":
      return "Não foi possível misturar a música com a sua voz nesta chamada.";
    default:
      return "Não foi possível ligar o Modo Música.";
  }
}

export const useVoiceStore = create<VoiceState>()(
  persist(
    (set, get) => ({
      ...IDLE,
      relayDecisionByCommunity: {},
      volumeById: {},
      // Fora do `IDLE` de propósito: `leave` restaura o IDLE, e a preferência de áudio
      // não é estado da chamada que acabou.
      selfMuted: false,
      musicaVolume: 100,
      musicaMutarMic: true,
      selfDeafened: false,

      join: (channel, localId) => {

        // Hex é hex em qualquer caixa: o resto do arquivo compara identidade por
        // `toLowerCase()` (`minhaTela`, `telaComecou`, `cameraDoParChegou`) e esta linha
        // era a exceção. Um `localId` que chegasse com caixa diferente da do roster punha
        // a identidade local DUAS vezes na grade — o próprio tile e o "outro" que é ele.
        const eu = localId.toLowerCase();
        const others = (channel.voiceParticipantIds ?? []).filter(
          (id) => id.toLowerCase() !== eu,
        );
        const participants: VoiceParticipant[] = [
          ...others.map((identityId) => ({
            identityId,
            speaking: false,
            muted: false,
            deafened: false,
            cameraOn: false,
            sharingScreen: false,
            connectionToMe: "ok" as MeshStatus,
          })),
          {
            identityId: localId,
            speaking: false,
            // Entrar mudo é o ponto da preferência de §8, 1.1: quem desligou o
            // microfone na barra não o liga de volta ao trocar de canal.
            muted: get().selfMuted,
            deafened: get().selfDeafened,
            cameraOn: false,
            sharingScreen: false,
            connectionToMe: "ok",
          },
        ];

        set({
          channelId: channel.id,
          communityId: channel.communityId,
          localId,
          stage: "connecting",
          motivoDaFalha: null,
          participants,
          // Entrar mostra a grade (§9, 2.3) — por cima do conteúdo, que
          // continua o canal de texto que estava aberto (§4).
          expanded: true,
          shares: [],
          shareSessionId: null,
          capturaDaTela: CAPTURA_LIVRE,
          cameraPendente: false,
          erroDeCamera: null,
          erroDeMicrofone: null,
          erroDeDispositivo: null,
          cameraSeq: 0,
          consentRequest: null,
        });

        // A câmera e a tela da chamada ANTERIOR não sobrevivem a esta. `malha.entrar()`
        // limpa o próprio estado (fecha as conexões, zera o vídeo local), mas quem possui
        // os DISPOSITIVOS é a captura, e ela não fica sabendo pelo store trocar de canal —
        // o mesmo motivo pelo qual `leave` desliga as duas explicitamente. Sem isto,
        // trocar de canal com a câmera ligada deixava a luz acesa transmitindo para
        // ninguém, e a tela continuava sendo capturada pelo SO.
        void portaDeCamera?.desligar().catch(() => undefined);
        void portaDeTela?.parar().catch(() => undefined);

        // Sem porta não há chamada: o estado fica em `connecting` e é honesto sobre isso.
        // Com porta, quem tira de `connecting` é o par conectando de verdade.
        void portaDeMalha
          ?.entrar({ communityId: channel.communityId, channelId: channel.id, localId })
          .then(() => aplicarPreferenciaDeAudio(get()))
          .catch((e) => set({ stage: "failed", motivoDaFalha: motivoDaEntrada(e) }));
      },

      retryJoin: () => {
        const { channelId, communityId, localId } = get();
        if (channelId === null || communityId === null || localId === null) return;
        /*
         * §17.2/§17.5 — **a reentrada nasce sem mídia, e a tela precisa dizer isso.**
         *
         * `malha.entrar()` começa por `#limparEstado()`: as conexões são fechadas, o vídeo
         * local é zerado, a mistura é encerrada. O transporte volta limpo — e o store não
         * voltava. Ficava `cameraOn: true` sobre uma câmera que não chega a par nenhum,
         * `musicaAtiva: true` sobre uma mistura que não existe mais, e a transmissão de
         * tela congelada numa sessão que o host já esqueceu.
         *
         * Restaurar é gesto de quem está na chamada, não adivinhação daqui: ligar a câmera
         * de volta pediria a permissão do sistema outra vez, e ressuscitar a música pediria
         * outra captura de áudio. O que se deve é apagar honestamente.
         */
        void portaDeCamera?.desligar().catch(() => undefined);
        void portaDeTela?.parar().catch(() => undefined);
        set((state) => ({
          stage: "connecting" as VoiceStage,
          motivoDaFalha: null,
          erroDeMicrofone: null,
          erroDeCamera: null,
          cameraPendente: false,
          musicaAtiva: false,
          musicaErro: null,
          shares: [],
          shareSessionId: null,
          capturaDaTela: CAPTURA_LIVRE,
          cameraSeq: state.cameraSeq + 1,
          participants: state.participants.map((p) =>
            p.identityId === state.localId
              ? { ...p, cameraOn: false, sharingScreen: false }
              : p,
          ),
        }));
        void portaDeMalha
          ?.entrar({ communityId, channelId, localId })
          // A malha é nova: as trilhas voltam abertas, e a preferência precisa ser
          // aplicada de novo — senão a retentativa devolve o microfone ligado.
          .then(() => aplicarPreferenciaDeAudio(get()))
          .catch((e) => set({ stage: "failed", motivoDaFalha: motivoDaEntrada(e) }));
      },

      leave: () => {
        // A luz da câmera não sobrevive à chamada. `sair()` derruba a malha, mas quem possui
        // o dispositivo é a captura — e ela não fica sabendo pelo estado ir para IDLE.
        void portaDeCamera?.desligar().catch(() => undefined);
        // Nem a da tela, pela mesma razão e com um agravante: a captura de tela leva o
        // áudio do sistema junto, e o indicador de gravação do SO fica aceso sobre uma
        // sessão que acabou. Sem porta de malha (teste, Storybook) nada mais pararia.
        void portaDeTela?.parar().catch(() => undefined);
        void portaDeMalha?.sair().catch(() => undefined);
        set({ ...IDLE });
      },

      configurarVoz: (porta) => {
        portaDeMalha = porta;
      },

      aplicarRoster: (participantes) => {
        set((state) => {
          const local = state.localId;
          // Sozinho na chamada é um estado NORMAL e **terminal**, não uma etapa a caminho
          // de outro: não há par com quem conectar, e é por isso que a malha nem arma o
          // prazo de L-11 nesse caso ("entrar sozinho num canal de voz é normal —
          // espera-se alguém", `live/voz.ts`). A tela discordava do núcleo e ficava em
          // "Conectando…" para sempre, porque quem tirava de `connecting` era o par
          // conectando de verdade e não havia par nenhum. É a mentira que §80 tirou da
          // conexão, reaparecida por outra causa.
          //
          // O custo não era só a frase errada: `connecting` também mantinha o PRÓPRIO tile
          // como esqueleto. Quem entrava primeiro — o caso mais comum de todos — nunca se
          // via na grade da chamada em que já estava.
          //
          // Roster VAZIO não entra aqui: isso não é "sozinho", é "sem chamada" — é o que
          // sobra depois de `encerradaPeloHost`, e ressuscitá-lo apagaria o motivo que
          // aquele caminho existe para preservar.
          const euHex = local?.toLowerCase() ?? null;
          const sozinho =
            participantes.length === 1 && participantes[0]?.keyHex.toLowerCase() === euHex;
          return {
            stage:
              sozinho && (state.stage === "connecting" || state.stage === "failed")
                ? ("connected" as VoiceStage)
                : state.stage,
            // Ficar sozinho porque o outro saiu apaga o "não foi possível conectar": não
            // há mais com quem falhar, e o banner com "Tentar novamente" ofereceria uma
            // retentativa contra ninguém.
            motivoDaFalha: sozinho && state.stage === "failed" ? null : state.motivoDaFalha,
            participants: participantes.map((p) => {
              const anterior = state.participants.find(
                (x) => x.identityId.toLowerCase() === p.keyHex.toLowerCase(),
              );
              return {
                identityId: p.keyHex,
                speaking: p.speaking ?? false,
                muted: p.muted ?? false,
                deafened: p.deafened ?? false,
                // A câmera do PRÓPRIO nó não vem do host: `cameraOn` no roster é o eco do
                // que esta máquina contou por `voice.setSelf`, e entre contar e o eco voltar
                // existe um roster publicado por outro motivo — quem entrou, quem saiu. Ler
                // esse eco como verdade apagaria a própria imagem no meio da chamada, com a
                // câmera acesa e transmitindo. Quem possui o dispositivo responde por ele,
                // pela mesma razão que `connectionToMe` é local logo abaixo.
                cameraOn:
                  p.keyHex.toLowerCase() === euHex
                    ? (anterior?.cameraOn ?? false)
                    : (p.cameraOn ?? false),
                sharingScreen: p.sharing ?? false,
                // O roster é do host e não sabe como ESTA máquina enxerga cada par: o
                // estado da conexão é local e sobrevive à republicação da lista.
                connectionToMe:
                  p.keyHex.toLowerCase() === euHex
                    ? ("ok" as MeshStatus)
                    : (anterior?.connectionToMe ?? ("ok" as MeshStatus)),
              };
            }),
          };
        });
        // §17.4 (emenda de 2026-08-28) — o mute IMPOSTO pelo modo de fala/fila chega pelo
        // mesmo roster. Host dizendo "muted" sem pedido meu é imposição: corta a trilha que
        // sai (mic + música). O próprio muto continua sendo L-12 — quem aqui desmuta é o
        // roster mudando de ideia (turno acabou de chegar), nunca um timer local.
        const st = get();
        const eu = st.participants.find(
          (p) => p.identityId.toLowerCase() === st.localId?.toLowerCase(),
        );
        const imposto = (eu?.muted ?? false) && !st.selfMuted;
        portaDeMalha?.definirMudoImpositivo?.(imposto);
      },

      aplicarEstadoDoPar: (peerHex, estado) =>
        set((state) => ({
          // Um par conectado já basta para a chamada estar de pé; a falha de outro é
          // assimétrica e aparece no tile dele, não na chamada inteira (§9, 2.3).
          //
          // `failed` também volta: o prazo de L-11 é um veredito sobre o que se sabia aos
          // 20 s, não uma sentença. Quando a negociação repetida de §17.4 fecha depois
          // disso, a chamada está de pé — e deixar a tela dizendo que falhou enquanto o
          // áudio já toca é a mesma mentira de "Conectando…" para sempre, ao contrário.
          stage:
            estado === "ok" && (state.stage === "connecting" || state.stage === "failed")
              ? "connected"
              : state.stage,
          // O motivo da falha não sobrevive à recuperação: o banner sairia com a chamada viva.
          motivoDaFalha:
            estado === "ok" && state.stage === "failed" ? null : state.motivoDaFalha,
          participants: state.participants.map((p) =>
            p.identityId === peerHex ? { ...p, connectionToMe: estado } : p,
          ),
        })),

      falhouAoConectar: (motivo) => set({ stage: "failed", motivoDaFalha: motivo }),

      /** §15.5 `voice.deviceError` — nomeia e mostra; quem limpa é a chamada nova. */
      registrarErroDeDispositivo: (motivo) => set({ erroDeDispositivo: motivo }),

      encerradaPeloHost: (motivo) =>
        set((state) => {
          const razao = motivo ?? state.motivoDaFalha;
          // Sem motivo é o encerramento limpo de sempre: a chamada some da tela.
          if (razao === null || razao === undefined) return { ...IDLE };
          // Com motivo, a chamada acaba mas o overlay **fica**: o banner de `stage:"failed"`
          // é a única superfície que carrega o "por quê" (§9, 2.3), e ela vive dentro dele.
          // Zerar tudo faria o usuário ver a chamada evaporar sem explicação — que é o
          // defeito que este caminho existe para corrigir.
          return {
            ...IDLE,
            channelId: state.channelId,
            communityId: state.communityId,
            localId: state.localId,
            expanded: state.expanded,
            stage: "failed" as VoiceStage,
            motivoDaFalha: razao,
          };
        }),

      /**
       * §17.4 L-12 — silenciar a si mesmo é **efetivo**, não conselho. São três coisas, e
       * antes só a primeira acontecia: contar ao host (que acende o ícone dos outros),
       * desligar a trilha do microfone, e refletir no estado local.
       *
       * O estado muda ANTES dos efeitos: quem aplica a saída de áudio lê o store, e lê-lo
       * antes do `set` devolveria o valor velho.
       */
      toggleMute: () => {
        const eu = get().participants.find((p) => p.identityId === get().localId);
        // Fora da chamada não há participante local: quem responde é a preferência.
        const mudo = !(eu?.muted ?? get().selfMuted);
        const saiDoSurdo = !mudo && (eu?.deafened ?? get().selfDeafened);

        set((state) => ({
          selfMuted: mudo,
          selfDeafened: mudo ? state.selfDeafened : false,
          participants: state.participants.map((p) =>
            p.identityId === state.localId
              ? // Desmutar com o áudio ensurdecido não faz sentido: sair do
                // mudo também tira do ensurdecido (convenção do gênero).
                {
                  ...p,
                  muted: mudo,
                  deafened: mudo ? p.deafened : false,
                  speaking: false,
                }
              : p,
          ),
        }));

        portaDeMalha?.mudarSelf({ muted: mudo, ...(saiDoSurdo ? { deafened: false } : {}) });
        // O mudo de verdade: sem esta linha a trilha continuava transmitindo e o ícone do
        // outro lado mentia.
        portaDeMalha?.definirMudo(mudo);
        if (saiDoSurdo) portaDeMalha?.definirSurdo(false);
      },

      /**
       * Ensurdecer é enforcement **local** nas duas direções: cala a saída de cada par e,
       * por convenção do gênero, também o próprio microfone. Antes nenhuma das duas
       * acontecia — só o ícone e o roster mudavam.
       */
      toggleDeafen: () => {
        const eu = get().participants.find((p) => p.identityId === get().localId);
        const surdo = !(eu?.deafened ?? get().selfDeafened);

        set((state) => ({
          selfDeafened: surdo,
          // Ensurdecer implica mudo também na preferência; desensurdecer devolve a voz.
          selfMuted: surdo,
          participants: state.participants.map((p) =>
            p.identityId === state.localId
              ? {
                  ...p,
                  deafened: surdo,
                  // Ensurdecer implica mudo; desensurdecer devolve a voz.
                  muted: surdo,
                  speaking: false,
                }
              : p,
          ),
        }));

        portaDeMalha?.mudarSelf({ deafened: surdo, muted: surdo });
        portaDeMalha?.definirMudo(surdo);
        portaDeMalha?.definirSurdo(surdo);
      },

      /**
       * §17.5 (emenda de 2026-08-28) — ligar/desligar o Modo Música. O estado muda DEPOIS
       * do desfecho (a captura pode recusar — sem loopback, sem permissão, sem sessão),
       * invertendo o otimismo do mute: aqui o desfecho nomeado é o que decide a tela.
       * Com `musicaMutarMic`, ligar a música muta o microfone de uma vez (US-02) — o mudo
       * próprio com mistura cala só a voz, e a música segue.
       */
      toggleMusica: async () => {
        const ligar = !get().musicaAtiva;
        if (ligar) {
          const r = await portaDeMalha?.definirMusica(true);
          if (r === undefined || r.erro !== null) {
            set({ musicaAtiva: false, musicaErro: motivoDaMusica(r?.erro) });
            return;
          }
          const mutarMic = get().musicaMutarMic;
          set({ musicaAtiva: true, musicaErro: null });
          if (mutarMic && !get().selfMuted) get().toggleMute();
          return;
        }
        await portaDeMalha?.definirMusica(false);
        set({ musicaAtiva: false, musicaErro: null });
      },

      /** Volume da música, 0–100 como os outros sliders; efeito imediato no grafo. */
      definirMusicaVolume: (volume: number) => {
        set({ musicaVolume: Math.max(0, Math.min(100, volume)) });
        portaDeMalha?.definirVolumeMusica(get().musicaVolume / 100);
      },

      /** Preferência US-02: ligada, muta o microfone na hora (a música não precisa de mic). */
      definirMusicaMutarMic: (quer: boolean) => {
        set({ musicaMutarMic: quer });
        if (quer && get().musicaAtiva && !get().selfMuted) get().toggleMute();
      },

      aplicarFila: (fila) => {
        // Fila de OUTRO canal não entra aqui: "voz é uma só", e a fila exibida é a do
        // canal em chamada.
        if (fila.channelId !== get().channelId) return;
        set({ fila, motivoDaFila: null });
      },

      entrarNaFila: async () => {
        const { communityId, channelId } = get();
        if (communityId === null || channelId === null) return;
        try {
          await portaDeFila?.entrar({ communityId, channelId });
        } catch (e) {
          // §20.1 — o código vem da fronteira (IpcCommandError); `codigoDoErro` é o
          // extrator canônico — um `(e as {code}).code` solto devolvia undefined para
          // E_UNKNOWN_COMMAND e a mensagem genérica engolia o diagnóstico real.
          const code = codigoDoErro(e);
          set({
            motivoDaFila:
              code === "E_QUEUE_CLOSED"
                ? "A fila está fechada pelo administrador."
                : code === "E_SESSION_GONE"
                  ? "Entre na chamada para entrar na fila."
                  : code === "E_UNKNOWN_COMMAND"
                    ? "O núcleo desta instalação é mais antigo que a interface — reinicie o aplicativo."
                    : "Não foi possível entrar na fila agora.",
          });
        }
      },

      sairDaFila: async () => {
        const { communityId, channelId } = get();
        if (communityId === null || channelId === null) return;
        try {
          await portaDeFila?.sair({ communityId, channelId });
          // A reconsulta da porta (§15.1 r.5) traz o estado verdadeiro — apagar às cegas
          // aqui escondia a fila real se um `voice.queueChanged` estivesse a caminho.
        } catch {
          // sair é idempotente no host; falha de rede se corrige sozinha no próximo evento
        }
      },

      moderarFila: async ({ action, targetKey, seconds }) => {
        const { communityId, channelId } = get();
        if (communityId === null || channelId === null) return;
        try {
          await portaDeFila?.moderar({ communityId, channelId, action, ...(targetKey !== undefined ? { targetKey } : {}), ...(seconds !== undefined ? { seconds } : {}) });
          set({ motivoDaFila: null });
        } catch (e) {
          const code = codigoDoErro(e);
          set({ motivoDaFila: code === "E_PERMISSION_DENIED" ? "Só quem pode moderar a voz comanda a fila." : "Não foi possível comandar a fila agora." });
        }
      },

      configurarFila: (porta) => {
        portaDeFila = porta;
      },

      aplicarPTT: (pressionado) => {
        const mudoDesejado = !pressionado;
        const atual = get().participants.find((p) => p.identityId === get().localId)?.muted ?? get().selfMuted;
        if (atual === mudoDesejado) return; // já está como o PTT quer: nada a fazer
        get().toggleMute();
      },

      consultarFluxos: () => portaDeMalha?.fluxosParaGravacao() ?? null,

      /**
       * §17.2/§9 (2.3.2) — a câmera é **efetiva**, não ícone. Eram três coisas e nenhuma
       * acontecia: capturar o dispositivo, pôr a trilha na malha e contar ao host.
       *
       * Ligar e desligar não são simétricos, e não é descuido:
       *
       * - **Desligar** é meu e não falha — a trilha é desta máquina. O estado desce na hora.
       * - **Ligar** pode ser negado pelo sistema, e por isso o `cameraOn` só sobe depois de
       *   haver imagem (A25, confirma-depois-desenha). O contrário acenderia o ícone do
       *   outro lado sobre uma câmera que nunca abriu.
       */
      toggleCamera: () => {
        const state = get();
        // Dois cliques enquanto o diálogo de permissão está aberto abririam duas capturas.
        if (state.cameraPendente) return;
        const eu = state.participants.find((p) => p.identityId === state.localId);
        const ligando = !(eu?.cameraOn ?? false);

        if (!ligando) {
          set((s) => ({
            erroDeCamera: null,
            cameraSeq: s.cameraSeq + 1,
            participants: s.participants.map((p) =>
              p.identityId === s.localId ? { ...p, cameraOn: false } : p,
            ),
          }));
          portaDeMalha?.mudarSelf({ cameraOn: false });
          void portaDeCamera?.desligar().catch(() => undefined);
          return;
        }

        set({ cameraPendente: true, erroDeCamera: null });
        // Sem porta a câmera fica **pendente**, e é honesto: não há captura para acontecer,
        // e desenhar a imagem seria simular o que §83 tirou da tela. Mesma postura de
        // `join`, que sem malha fica em `connecting`.
        void portaDeCamera
          ?.ligar()
          .then(({ erro }) => {
            if (erro !== null) {
              set({ cameraPendente: false, erroDeCamera: erro });
              return;
            }
            set((s) => ({
              cameraPendente: false,
              erroDeCamera: null,
              cameraSeq: s.cameraSeq + 1,
              participants: s.participants.map((p) =>
                p.identityId === s.localId ? { ...p, cameraOn: true } : p,
              ),
            }));
            // O host publica no roster, e é isso que acende o ícone do outro lado. Depois
            // da imagem, nunca antes.
            portaDeMalha?.mudarSelf({ cameraOn: true });
          })
          .catch(() => set({ cameraPendente: false, erroDeCamera: "Não foi possível ligar a câmera." }));
      },

      configurarCamera: (porta) => {
        portaDeCamera = porta;
      },

      cameraCaiu: (motivo) =>
        set((state) => ({
          cameraPendente: false,
          erroDeCamera: motivo,
          cameraSeq: state.cameraSeq + 1,
          participants: state.participants.map((p) =>
            p.identityId === state.localId ? { ...p, cameraOn: false } : p,
          ),
        })),

      microfoneCaiu: (motivo) => set({ erroDeMicrofone: motivo }),

      cameraDoParChegou: (peerHex) =>
        set((state) => ({
          cameraSeq: state.cameraSeq + 1,
          participants: state.participants.map((p) =>
            p.identityId.toLowerCase() === peerHex.toLowerCase() ? { ...p, cameraOn: true } : p,
          ),
        })),

      setExpanded: (expanded) => set({ expanded }),

      setVolume: (identityId, volume) => {
        set((state) => ({
          volumeById: { ...state.volumeById, [identityId]: volume },
        }));
        // O estado primeiro, o efeito depois: quem aplica lê o volume corrente do store.
        portaDeMalha?.definirVolume(identityId, volume);
      },

      setParticipantMuted: (identityId, muted) => {
        // Otimista, como o volume: o ícone responde ao clique e o roster do host é quem
        // confirma (ou desfaz, se a permissão não estiver lá).
        set((state) => ({
          participants: state.participants.map((p) =>
            p.identityId.toLowerCase() === identityId.toLowerCase()
              ? { ...p, muted, speaking: muted ? false : p.speaking }
              : p,
          ),
        }));
        // O efeito de verdade (§17.4 L-12): o host marca o roster, e o cliente do alvo
        // corta a própria trilha ao lê-lo. Recusa (`E_PERMISSION_DENIED`) não precisa de
        // tratamento aqui — o roster seguinte devolve o estado que vale.
        void portaDeMalha?.mutarParticipante?.(identityId, muted).catch(() => undefined);
      },

      configurarTela: (porta) => {
        portaDeTela = porta;
      },

      /**
       * §17.5 — começar a apresentar. A ordem de `T-41` mora na estrela (`live/tela.ts`):
       * o host decide, o núcleo cunha o `captureToken`, o main o verifica, e só então a
       * tela é capturada. Aqui só o estado que a UI lê.
       *
       * `starting` é honesto: a sessão existe no host e a captura ainda não voltou. Quem a
       * tira de `starting` é a captura de verdade, não um temporizador.
       */
      startShare: (a) => {
        const state = get();
        if (!state.channelId || !state.communityId || !state.localId) return;
        // §17.5, 2026-08-26 — o canal aceita várias transmissões; o que não se repete é a
        // MINHA, porque a captura de tela desta instalação é uma só (`E_ALREADY_SHARING`).
        if (minhaTela(state.shares, state.localId) !== undefined) return;
        const quality = a?.quality ?? "balanced";
        ultimoPedidoDeTela = {
          kind: a?.kind ?? "screen",
          sourceId: a?.sourceId ?? null,
          audio: a?.audio === true,
        };

        set({
          shares: [
            ...state.shares,
            {
              // O id só existe depois que o host responde; até lá quem identifica a minha
              // é a minha chave (`minhaTela`).
              sessionId: "",
              presenterId: state.localId,
              channelId: state.channelId,
              viewerCount: 0,
              quality,
              phase: "starting",
              sourceLabel: "",
              comAudio: false,
              motivoDaFalha: null,
              saude: [],
              oculto: false,
            },
          ],
          expanded: true,
        });

        void portaDeTela
          ?.apresentar({
            communityId: state.communityId,
            channelId: state.channelId,
            localId: state.localId,
            quality,
            ...ultimoPedidoDeTela,
          })
          .then(({ sessionId, sourceLabel, comAudio }) => {
            set((s) => {
              const minha = minhaTela(s.shares, s.localId);
              if (minha === undefined) return {};
              return {
                shareSessionId: sessionId,
                shares: comTela(s.shares, minha.sessionId, (t) => ({
                  ...t,
                  sessionId,
                  phase: "live" as SharePhase,
                  sourceLabel,
                  comAudio,
                })),
                // §17.5 — o que a fonte escolheu entregar, antes de qualquer restrição
                // nossa. É o ponto de partida que os controles de captura mostram.
                capturaDaTela: portaDeTela?.perfilDeCaptura() ?? CAPTURA_LIVRE,
                participants: s.participants.map((p) =>
                  p.identityId === s.localId ? { ...p, sharingScreen: true } : p,
                ),
              };
            });
          })
          .catch((e: unknown) => {
            // Cancelar o seletor do sistema é `NotAllowedError` e NÃO é falha: a pessoa
            // desistiu. Mostrar "falha ao transmitir" para uma desistência seria mentira.
            const nome = (e as { name?: string })?.name;
            if (nome === "NotAllowedError" || nome === "AbortError") {
              set((s) => ({
                shares: s.shares.filter((t) => minhaTela([t], s.localId) === undefined),
                shareSessionId: null,
              }));
              return;
            }
            get().telaFalhou("Não foi possível iniciar a transmissão de tela.");
          });
      },

      stopShare: () => {
        void portaDeTela?.parar().catch(() => undefined);
        set((state) => ({
          // Só a minha sai; a tela de quem mais estiver apresentando continua.
          shares: state.shares.filter((s) => minhaTela([s], state.localId) === undefined),
          shareSessionId: null,
          capturaDaTela: CAPTURA_LIVRE,
          participants: state.participants.map((p) =>
            p.identityId === state.localId ? { ...p, sharingScreen: false } : p,
          ),
        }));
      },

      /**
       * §15.4 papel **apresentador** (emenda de 2026-08-26): o teto de banda com que a
       * MINHA tela sai. Antes o comando era do espectador, e isso punha a conta no bolso
       * alheio — 8 espectadores pedindo `high` são 20 Mbps de subida na máquina de quem
       * transmite, que não tinha como recusar.
       *
       * O estado local só muda quando o host aceita: anunciar "Baixa" e continuar
       * transmitindo em alta seria o `F-08` de volta, agora do outro lado. Espectador que
       * chame isto é recusado no host com `E_PERMISSION_DENIED` e não vê nada mudar.
       */
      setQuality: (quality) => {
        const { shareSessionId, shares, localId } = get();
        // Só existe perfil a definir na transmissão que EU apresento (§17.5).
        if (shareSessionId === null || minhaTela(shares, localId) === undefined) return;
        void portaDeTela
          ?.definirQualidade(shareSessionId, quality)
          .then((applied) => {
            if (applied) set((s) => ({ shares: comTela(s.shares, shareSessionId, (t) => ({ ...t, quality })) }));
          })
          .catch(() => undefined);
      },

      /**
       * §17.5 — resolução e taxa de quadros da CAPTURA. Não passa pelo host e não tem RPC:
       * é `applyConstraints` sobre a trilha desta máquina, do mesmo jeito que `track.enabled`
       * é o mudo efetivo de §17.4 L-12. Quem possui o dispositivo decide o que sai dele.
       *
       * O que volta para o estado é o que a trilha ficou entregando (`getSettings`), não o
       * que foi pedido — uma fonte pode aproximar ou ignorar a restrição, e mostrar "720p"
       * porque foi o que pedimos seria inventar medida.
       */
      definirCaptura: (patch) => {
        const { shares, localId, capturaDaTela } = get();
        if (minhaTela(shares, localId) === undefined) return;
        const pedido: PerfilDeCaptura = {
          height: patch.height === undefined ? capturaDaTela.height : patch.height,
          frameRate: patch.frameRate === undefined ? capturaDaTela.frameRate : patch.frameRate,
        };
        void portaDeTela
          ?.definirCaptura(pedido)
          .then((efetivo) => set({ capturaDaTela: efetivo }))
          .catch(() => undefined);
      },

      /**
       * §17.5 — o único controle de quem ASSISTE. Ocultar é exibição local: não fala com o
       * host, não mexe na `RTCPeerConnection` e não chega ao apresentador. A trilha continua
       * chegando; o que para é o `<video>` desta máquina.
       *
       * Deliberadamente **não** é `share.setQuality` para `low` nem `share.leave`: os dois
       * teriam efeito sobre a transmissão de outra pessoa, e este botão é sobre a tela de
       * quem o aperta.
       */
      alternarVideoRecebido: (sessionId) =>
        set((state) => ({
          shares: comTela(state.shares, sessionId, (s) => ({ ...s, oculto: !s.oculto })),
        })),

      retryShare: (sessionId) => {
        const { shares, localId } = get();
        const alvo =
          sessionId === undefined
            ? minhaTela(shares, localId)
            : shares.find((s) => s.sessionId === sessionId);
        if (alvo === undefined) return;

        if (localId !== null && alvo.presenterId.toLowerCase() === localId.toLowerCase()) {
          get().stopShare();
          // A MESMA fonte, não "uma do mesmo tipo": tentar de novo repete o pedido inteiro.
          get().startShare({ quality: alvo.quality, ...ultimoPedidoDeTela });
          return;
        }

        // Espectador: o que falhou foi o meu `share.join`. Repetir a captura de outra
        // pessoa não é algo que este botão possa — nem deva — fazer.
        const id = alvo.sessionId;
        set((s) => ({
          shares: comTela(s.shares, id, (t) => ({
            ...t,
            phase: "starting" as SharePhase,
            motivoDaFalha: null,
          })),
        }));
        void portaDeTela
          ?.assistir(id)
          .then(({ erro }) => {
            if (erro !== null) get().telaFalhou(erro, id);
          })
          .catch(() => get().telaFalhou("Não foi possível entrar na transmissão.", id));
      },

      telaComecou: ({ sessionId, presenterKey, channelId }) =>
        set((state) => {
          if (state.channelId !== channelId) return {};
          const eu = state.localId?.toLowerCase();
          const apresentador = presenterKey.toLowerCase();
          // O próprio `share.started` volta para quem começou: o estado dele já está de pé
          // e sobrescrevê-lo apagaria o `sourceLabel` que só esta máquina conhece. O que
          // falta é o id, que só o host sabe.
          if (eu !== undefined && apresentador === eu) {
            return {
              shareSessionId: sessionId,
              shares: state.shares.map((s) =>
                s.presenterId.toLowerCase() === eu ? { ...s, sessionId } : s,
              ),
            };
          }
          // Reentrega do mesmo `share.started` (§16.3 é at-most-once, mas nada proíbe
          // repetir) não pode duplicar a transmissão na lista.
          if (state.shares.some((s) => s.sessionId === sessionId)) return {};
          return {
            shares: [
              ...state.shares,
              {
                sessionId,
                presenterId: presenterKey,
                channelId,
                viewerCount: 0,
                quality: "balanced" as ShareQuality,
                phase: "starting" as SharePhase,
                sourceLabel: "",
                // Selo de quem apresenta; para a transmissão de outro é sempre `false`.
                comAudio: false,
                motivoDaFalha: null,
                saude: [],
                oculto: false,
              },
            ],
            participants: state.participants.map((p) =>
              p.identityId.toLowerCase() === apresentador ? { ...p, sharingScreen: true } : p,
            ),
            expanded: true,
          };
        }),

      telaParou: (sessionId) => {
        const state = get();
        const encerrada = state.shares.find((s) => s.sessionId === sessionId);
        if (encerrada === undefined) return;
        const eraMinha = state.shareSessionId === sessionId;
        // **A sessão pode ter sido encerrada pelo HOST** — ban, kick, canal apagado, sweep
        // (§17.5/§18.1). Se eu era quem apresentava, limpar só o estado deixaria a captura
        // viva: a luz de "compartilhando tela" do sistema continuaria acesa, transmitindo
        // para uma sessão que não existe mais. Quem para a captura é a estrela.
        if (eraMinha) void portaDeTela?.parar().catch(() => undefined);
        const restantes = state.shares.filter((s) => s.sessionId !== sessionId);
        const apresentador = encerrada.presenterId.toLowerCase();
        set({
          shares: restantes,
          // Só o que era meu é limpo; a tela de outra pessoa segue viva com o estado dela.
          ...(eraMinha ? { shareSessionId: null, capturaDaTela: CAPTURA_LIVRE } : {}),
          // O ícone do tile é de quem apresenta: só apaga se ELE não estiver mais em
          // nenhuma das transmissões restantes.
          participants: state.participants.map((p) =>
            p.identityId.toLowerCase() === apresentador &&
            !restantes.some((s) => s.presenterId.toLowerCase() === apresentador)
              ? { ...p, sharingScreen: false }
              : p,
          ),
        });
      },

      telaMudouEspectadores: ({ sessionId, viewerCount }) =>
        set((state) => ({ shares: comTela(state.shares, sessionId, (s) => ({ ...s, viewerCount })) })),

      // `share.health` é só ao apresentador (RT-08): a saúde é sempre da MINHA transmissão.
      telaMediuSaude: (viewers) =>
        set((state) => {
          const minha = minhaTela(state.shares, state.localId);
          if (minha === undefined) return {};
          return { shares: comTela(state.shares, minha.sessionId, (s) => ({ ...s, saude: [...viewers] })) };
        }),

      telaFalhou: (motivo, sessionId) =>
        set((state) => {
          // Sem id, a falha é da MINHA — é o caminho de quem tentou apresentar e não
          // conseguiu, que acontece antes de o host devolver um id.
          const alvo = sessionId ?? minhaTela(state.shares, state.localId)?.sessionId;
          if (alvo === undefined) return {};
          if (!state.shares.some((s) => s.sessionId === alvo)) return {};
          return {
            shares: comTela(state.shares, alvo, (s) => ({
              ...s,
              phase: "failed" as SharePhase,
              motivoDaFalha: motivo,
            })),
          };
        }),

      respondConsent: (accept, remember) =>
        set((state) => {
          const communityId = state.consentRequest?.communityId ?? state.communityId;
          if (communityId === null) return { consentRequest: null };
          return {
            consentRequest: null,
            relayDecisionByCommunity: remember
              ? { ...state.relayDecisionByCommunity, [communityId]: accept }
              : state.relayDecisionByCommunity,
          };
        }),

      /* ─── Afinadores de desenvolvimento (§19.1) ─────────────────── */

      devSetPeerMesh: (identityId, status) =>
        set((state) => ({
          participants: state.participants.map((p) =>
            p.identityId === identityId
              ? { ...p, connectionToMe: status, speaking: false }
              : p,
          ),
        })),

      devFailJoin: () => set({ stage: "failed" }),
    }),
    {
      name: "comunidade-p2p:voice",
      version: 1,
      // Sobrevivem ao reload a escolha de repasse (§9, 2.4.1) e a preferência de
      // áudio da barra de usuário (§8, 1.1); a chamada em si é estado do agora.
      partialize: ({ relayDecisionByCommunity, selfMuted, selfDeafened, musicaVolume, musicaMutarMic }) => ({
        relayDecisionByCommunity,
        // §8, 1.1 — o estado dos dois botões da barra de usuário sobrevive ao reload:
        // é preferência da instalação, não estado de chamada.
        selfMuted,
        selfDeafened,
        // §17.5 (emenda de 2026-08-28) — preferências do Modo Música; `musicaAtiva` é da
        // chamada e morre com ela.
        musicaVolume,
        musicaMutarMic,
      }),
    },
  ),
);

/* ─── Seletores ──────────────────────────────────────────────────── */

/** Estado da identidade local dentro da chamada (mudo, câmera, …). */
export function useLocalParticipant(): VoiceParticipant | undefined {
  return useVoiceStore((state) =>
    state.participants.find((p) => p.identityId === state.localId),
  );
}

/**
 * §8, 1.1 — o que os dois botões da barra de usuário mostram. Dentro da chamada é o
 * participante local (o host pode ter publicado outra coisa); fora dela, a preferência
 * persistida, que é tudo que existe.
 */
export function useSelfAudio(): { muted: boolean; deafened: boolean } {
  return useVoiceStore(
    useShallow((state) => {
      const eu = state.participants.find((p) => p.identityId === state.localId);
      return {
        muted: eu?.muted ?? state.selfMuted,
        deafened: eu?.deafened ?? state.selfDeafened,
      };
    }),
  );
}

/** `true` quando a chamada ativa é justamente a deste canal. */
export function useIsInVoiceChannel(channelId: string): boolean {
  return useVoiceStore((state) => state.channelId === channelId);
}

/**
 * Ids de quem está no canal de voz *agora*: o núcleo responde a ocupação
 * (§15.5 `voice.occupancyChanged`), e a chamada em curso sobrepõe — sem isto a
 * lista de canais e a grade discordariam depois que a identidade local entra.
 */
export function useVoiceChannelParticipantIds(channel: Channel): string[] {
  return useVoiceStore(
    useShallow((state) =>
      state.channelId === channel.id
        ? state.participants.map((p) => p.identityId)
        : (channel.voiceParticipantIds ?? []),
    ),
  );
}

/**
 * §17.5 — a saúde por espectador, **só para quem apresenta**. É o que `share.health`
 * entrega, e a única leitura de rede que o tile mostra.
 *
 * Substitui `useMyRelayCount`, que contava quantas pessoas esta máquina retransmitia numa
 * árvore que A20 tirou do v1: em estrela ninguém retransmite para ninguém (B26).
 */
export function useShareHealth(): ShareViewerHealthDto[] {
  return useVoiceStore(
    useShallow((state) => minhaTela(state.shares, state.localId)?.saude ?? NO_HEALTH),
  );
}

/** Referência estável para quem não apresenta nada. */
const NO_HEALTH: ShareViewerHealthDto[] = [];
