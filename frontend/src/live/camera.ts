/**
 * A câmera da chamada — §17.2 ("Voz e câmera: WebRTC mesh") e §9 (2.3.2).
 *
 * **A divisão é a mesma da tela (§76/§83).** `live/voz.ts` fala WebRTC e não sabe o que é
 * uma câmera; este módulo sabe o que é uma câmera — dispositivo escolhido, permissão do
 * sistema, rótulo, motivo da recusa — e **não toca em `RTCPeerConnection`**: fala com a
 * malha por uma porta que só conhece "trilha de vídeo local".
 *
 * **Por que a câmera é da MALHA e a tela não é.** §17.2 põe voz e câmera na mesma malha
 * ponta a ponta: quem está na chamada vê, pela mesma regra que faz todos ouvirem o
 * microfone. A tela é outra coisa — §17.5 é uma **estrela** cuja audiência o host autoriza
 * nome a nome (`share.join`, `share.health`), com perfil de banda por espectador. Tratar as
 * duas do mesmo jeito faria a câmera precisar de uma sessão que a spec não declara, ou a
 * tela ir para quem nunca pediu para assistir.
 *
 * **A ordem é o inverso da tela, e de propósito.** Em §17.5 o host decide ANTES da captura
 * (`T-41`), porque compartilhar tela exige a permissão `voice_share_screen` e existe uma
 * sessão a criar. A câmera não tem sessão nem permissão de comunidade — §15.4 só tem
 * `voice.setSelf{cameraOn}`, que é **aviso**, não pedido. Então captura-se primeiro e
 * avisa-se depois: anunciar `cameraOn: true` para depois descobrir que o SO negou o
 * dispositivo acenderia o ícone do outro lado sobre uma imagem que não existe — a mesma
 * decoração que §85.2 tirou do mudo.
 *
 * A captura e a malha entram **injetadas**: sem isso nada aqui seria testável fora de um
 * navegador com câmera.
 */

function log(msg: string, extra?: unknown): void {
  if (extra === undefined) console.log(`[camera] ${msg}`);
  else console.log(`[camera] ${msg}`, extra);
}

/** O que este módulo precisa da malha. Nada de `RTCPeerConnection` atravessa. */
export interface PortaDaMalhaDeCamera {
  definirVideoLocal(track: MediaStreamTrack, stream: MediaStream): Promise<void>;
  removerVideoLocal(): Promise<void>;
}

/** A captura, injetada. Em produto é `getUserMedia({video})`; no teste é uma trilha falsa. */
export interface FabricaDeCameraLocal {
  capturar(deviceId: string): Promise<MediaStream>;
}

export interface EventosDaCamera {
  /**
   * A câmera parou por fora do produto: cabo puxado, dispositivo tomado por outro
   * aplicativo, ou a permissão revogada no sistema com a chamada em curso. Sem isto o
   * botão continuaria dizendo "Desligar câmera" sobre uma trilha morta.
   */
  aoEncerrarNaFonte: () => void;
}

/**
 * O motivo, em português, de uma câmera que não ligou — §20.1 ("o texto em português é do
 * renderer") com o vocabulário de `RT-10`/`E_DEVICE_BLOCKED` (§15.5 `voice.deviceError`).
 *
 * Os nomes vêm do `DOMException` do padrão de mídia, e cada um pede uma ação diferente de
 * quem está do lado de cá: autorizar, escolher outra câmera, ou fechar o outro aplicativo.
 * Uma frase genérica para os três mandaria a pessoa procurar defeito no lugar errado.
 */
export function motivoDoErroDeCamera(e: unknown): string {
  const nome = (e as { name?: string } | null)?.name ?? "";
  if (nome === "NotAllowedError" || nome === "SecurityError") {
    return "O sistema não autorizou o acesso à câmera.";
  }
  if (nome === "NotFoundError" || nome === "OverconstrainedError") {
    return "A câmera escolhida não está mais disponível.";
  }
  if (nome === "NotReadableError" || nome === "AbortError") {
    return "A câmera está em uso por outro aplicativo.";
  }
  return "Não foi possível ligar a câmera.";
}

/**
 * A câmera que ESTA instalação transmite. Instanciada uma vez e reusada, como a malha e a
 * estrela: §15.4 tem um `cameraOn` por instalação, não um por canal.
 */
export class CameraDaChamada {
  readonly #malha: PortaDaMalhaDeCamera;
  readonly #captura: FabricaDeCameraLocal;
  readonly #eventos: EventosDaCamera;
  #stream: MediaStream | null = null;
  #track: MediaStreamTrack | null = null;

  constructor(
    malha: PortaDaMalhaDeCamera,
    captura: FabricaDeCameraLocal,
    eventos: EventosDaCamera,
  ) {
    this.#malha = malha;
    this.#captura = captura;
    this.#eventos = eventos;
  }

  get ligada(): boolean {
    return this.#track !== null;
  }

  /** A imagem que esta máquina captura, para o próprio tile. `null` com a câmera desligada. */
  get stream(): MediaStream | null {
    return this.#stream;
  }

  /** Como o dispositivo se chama, dito pelo sistema — nunca inventado pela UI. */
  get rotuloDaFonte(): string {
    return this.#track?.label ?? "";
  }

  /**
   * Liga a câmera e a põe na malha. `deviceId` é a preferência de §10 (3.1); `default` é o
   * padrão do sistema, e mandá-lo como id literal recusaria a captura.
   *
   * Ligar com a câmera já ligada é troca de dispositivo: a anterior é desligada primeiro,
   * senão duas trilhas ficariam vivas e a luz da câmera antiga continuaria acesa.
   */
  async ligar(deviceId: string): Promise<{ rotulo: string }> {
    if (this.#track !== null) await this.desligar();
    log(`ligando · dispositivo ${deviceId}`);
    const stream = await this.#captura.capturar(deviceId);
    const track = stream.getVideoTracks()[0] ?? null;
    if (track === null) {
      for (const t of stream.getTracks()) t.stop();
      throw Object.assign(new Error("captura sem trilha de vídeo"), { name: "NotFoundError" });
    }
    this.#stream = stream;
    this.#track = track;
    // Cabo puxado, dispositivo tomado, permissão revogada: a trilha morre sem passar por
    // lugar nenhum do produto, e o botão precisa saber.
    track.onended = () => {
      log("câmera encerrada na fonte");
      this.#eventos.aoEncerrarNaFonte();
    };
    /*
     * A negociação pode falhar (par que caiu, `replaceTrack` recusado): quem chamou vê
     * a exceção e desenha o erro, mas o DISPOSITIVO já está aberto — e ninguém mais tem
     * a referência para fechá-lo. Sem isto, a câmera ficava capturando com a luz acesa
     * sobre um botão que diz "Ligar câmera", que é a mesma decoração invertida que §85.2
     * tirou do mudo.
     */
    try {
      await this.#malha.definirVideoLocal(track, stream);
    } catch (e) {
      await this.desligar();
      throw e;
    }
    log(`ligada · '${track.label}'`);
    return { rotulo: track.label };
  }

  /**
   * Desliga: tira a trilha de todos os pares e **para o dispositivo**. As duas metades
   * importam — parar só a captura deixaria um m-line morto em cada conexão, e só tirar da
   * malha deixaria a luz da câmera acesa para ninguém.
   */
  async desligar(): Promise<void> {
    if (this.#track === null && this.#stream === null) return;
    if (this.#track !== null) this.#track.onended = null;
    await this.#malha.removerVideoLocal().catch(() => undefined);
    for (const t of this.#stream?.getTracks() ?? []) t.stop();
    this.#stream = null;
    this.#track = null;
    log("desligada");
  }
}
