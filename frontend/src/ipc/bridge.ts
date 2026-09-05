/**
 * Ponte com o shell Electron (§3.1, §3.4, §3.5).
 *
 * O preload (`app/src/preload/index.ts`) entrega quatro coisas ao renderer, todas por
 * `window.electron` ou por `CustomEvent` no `window`:
 *
 *   - a porta IPC-R transferida por `webContents.postMessage('ipc-r-port')` e repassada pelo
 *     preload ao mundo principal com `window.postMessage(..., [port])` — a única forma de a
 *     porta chegar VIVA aqui, já que o `contextBridge` serializa o que atravessa. Uma porta
 *     NOVA chega a cada núcleo novo (§15.2);
 *   - o epoch corrente e seus bumps (`core-epoch`), o sinal de §15.2;
 *   - os deep links já **parseados** pelo main (`deeplink`) — §3.5(2): o main encaminha
 *     dado estruturado, nunca a string original;
 *   - `requestAuthToken(cmd)`, o único caminho para o token de §15.3. O renderer não o
 *     fabrica: ele nasce no núcleo depois do diálogo nativo.
 *
 * Fora do Electron (`npm run dev` no navegador) nada disso existe. Aqui isso não é um erro
 * a esconder: `conectar()` devolve o motivo e a UI diz que está sem núcleo, em vez de
 * fingir dado.
 */

import { IpcClient } from "./client";
import { IpcCommandError, type RendererPort } from "./frames";

export interface DeepLink {
  route: "join" | "message" | "user";
  code?: string;
  ref?: string;
  /** B64 — a chave de identidade já validada e em minúsculas, só na rota `user`. */
  key?: string;
}

/**
 * Uma fonte capturável, como o sistema a nomeia. O nome e a miniatura vêm do
 * `desktopCapturer`; a UI nunca inventa nem um nem outra (§17.5).
 */
export interface CaptureSource {
  id: string;
  name: string;
  kind: "screen" | "window";
  /** `data:` JPEG da miniatura; `null` quando o sistema não entregou imagem. */
  thumbnail: string | null;
  /** `data:` PNG do ícone do aplicativo — só janelas o têm. */
  appIcon: string | null;
  displayId: string | null;
}

export interface PonteElectron {
  getEpoch(): number;
  /** U-06 — o impacto de sair já foi mostrado e a pessoa confirmou; a janela pode fechar. */
  confirmExit(): Promise<void>;
  /**
   * U-06 — a pessoa desistiu. Opcional porque a ponte pode ser de um shell anterior; sem
   * ela o pior caso é o comportamento antigo (o prazo fecha a janela), nunca um erro.
   */
  cancelExit?(): Promise<void>;
  requestAuthToken(cmd: string, arg?: unknown): Promise<{ ok: boolean; token?: string; code?: string }>;
  /**
   * §17.5/`T-41` — declara ao main a qual sessão de tela a próxima captura se refere, para
   * ele perguntar ao núcleo (`capture.authorize`, §15.7) antes de conceder. Opcional porque
   * a ponte pode ser de uma versão anterior do shell; sem ela o main nega a captura, que é a
   * falha fechada correta.
   */
  declareCaptureSession?(a: {
    sessionId: string | null;
    kind: "screen" | "window";
    /** §17.5 (emenda de 2026-08-28) — `music` é o Modo Música: um clique, sem seletor. */
    mode?: "share" | "music";
    /** A fonte escolhida no seletor de §17.5; `null` é "a primeira do tipo". */
    sourceId?: string | null;
    /** Pedir o som da fonte junto com a imagem. */
    audio?: boolean;
  }): Promise<void>;
  /**
   * §17.5 — as fontes capturáveis, para o seletor do produto. Opcional porque a ponte pode
   * ser de um shell anterior; sem ela o seletor cai no caminho do navegador, que pergunta
   * sozinho — nunca numa lista inventada.
   */
  listCaptureSources?(a: { kind: "screen" | "window" }): Promise<CaptureSource[]>;
  /**
   * O que esta plataforma faz com captura (§17.5): onde há áudio para pedir, e de quem é a
   * escolha da fonte. `systemPicker` é o Wayland, onde listar É pedir permissão e a caixa do
   * `xdg-desktop-portal` já é a escolha — o seletor do produto não aparece ali.
   */
  captureSupport?(): Promise<{
    screen: boolean;
    window: boolean;
    platform: string;
    systemPicker: boolean;
  }>;
  on(channel: string, listener: (...args: unknown[]) => void): void;
  off(channel: string, listener: (...args: unknown[]) => void): void;
}

declare global {
  interface Window {
    electron?: PonteElectron;
  }
}

export function pontePresente(): boolean {
  return typeof window !== "undefined" && window.electron !== undefined;
}

/**
 * **A escuta da porta é de módulo, e a porta é guardada.**
 *
 * O preload repassa a porta com `window.postMessage(..., [port])`, e o evento `message` do
 * DOM é transitório: não há fila, e quem não tem ouvinte no instante em que ele é
 * despachado perde a porta para sempre — o `MessagePort` transferido não volta, e a tela
 * ficava presa até o prazo de 30 s de `esperarPorta` com "o shell não transferiu a porta
 * IPC-R". Registrar dentro de `conectar()` fazia a entrega depender de a árvore React ter
 * chegado ao efeito antes de o main entregar; a ordem hoje é favorável (a entrega é adiada
 * até `did-stop-loading`, que vem depois da execução do bundle), mas é ordem por sorte, não
 * por construção.
 *
 * Registrando no topo do módulo — antes de qualquer `await`, no mesmo turno em que o bundle
 * é avaliado — a porta que chegar cedo demais fica **guardada** aqui e é entregue a quem a
 * pedir depois. A mais recente vence: cada núcleo novo traz uma porta nova (§15.2).
 */
let portaGuardada: RendererPort | null = null;
const esperandoPorta = new Set<(p: RendererPort) => void>();

if (typeof window !== "undefined") {
  window.addEventListener("message", (ev: MessageEvent) => {
    if ((ev.data as { tipo?: string } | null)?.tipo !== "ipc-r-port") return;
    const porta = ev.ports[0];
    if (porta === undefined) return;
    console.log(`[ponte] porta IPC-R recebida do shell (t=${Math.round(performance.now())}ms)`);
    portaGuardada = porta as unknown as RendererPort;
    for (const aviso of [...esperandoPorta]) aviso(portaGuardada);
  });
}

function esperarPorta(timeoutMs: number): Promise<RendererPort> {
  if (portaGuardada !== null) {
    console.log("[ponte] porta IPC-R já estava guardada — sem espera");
    return Promise.resolve(portaGuardada);
  }
  return new Promise((resolve, reject) => {
    console.log(`[ponte] esperando a porta IPC-R (t=${Math.round(performance.now())}ms desde o início da página)`);
    const timer = setTimeout(() => {
      esperandoPorta.delete(aoChegar);
      console.log("[ponte] TEMPO ESGOTADO sem receber a porta IPC-R do shell");
      reject(new Error("o shell não transferiu a porta IPC-R"));
    }, timeoutMs);
    function aoChegar(porta: RendererPort): void {
      clearTimeout(timer);
      esperandoPorta.delete(aoChegar);
      resolve(porta);
    }
    esperandoPorta.add(aoChegar);
  });
}

export interface Conexao {
  readonly cliente: IpcClient;
  readonly coreVersion: string;
  readonly epoch: number;
}

/**
 * Liga o cliente à porta e completa o aperto de mão. O `core-epoch` do main é ouvido para
 * sempre — inclusive depois desta promessa resolver, que é justamente quando o núcleo pode
 * cair (§15.2).
 */
export async function conectar(cliente: IpcClient, timeoutMs = 30_000): Promise<Conexao> {
  if (!pontePresente()) {
    throw new IpcCommandError({
      code: "E_NO_SHELL",
      message: "Esta janela não está rodando dentro do shell Electron do produto",
    });
  }
  window.addEventListener("core-epoch", (ev) => {
    const detalhe = (ev as CustomEvent<{ epoch: number }>).detail;
    if (typeof detalhe?.epoch === "number") cliente.handleCoreEpoch(detalhe.epoch);
  });
  // Cada núcleo novo traz uma porta nova (§15.2 passo 2): o cliente troca de porta e o
  // `hello` que vier por ela fixa o epoch. Ficar preso à primeira porta faria o produto
  // sobreviver ao crash mudo. A escuta é a do módulo, que guarda a porta e avisa daqui.
  esperandoPorta.add((porta) => {
    if (cliente.conectado) cliente.attach(porta);
  });
  const porta = await esperarPorta(timeoutMs);
  cliente.attach(porta);
  console.log("[ponte] attach feito — esperando o hello do núcleo");
  try {
    const hello = await cliente.waitForHello(timeoutMs);
    console.log(`[ponte] hello recebido (epoch ${hello.epoch}, core ${hello.coreVersion})`);
    return { cliente, coreVersion: hello.coreVersion, epoch: hello.epoch };
  } catch (e) {
    console.log(`[ponte] falha no hello: ${(e as Error).message}`);
    throw e;
  }
}

/**
 * U-06/§18.7 — o main segura o primeiro fechamento da janela e avisa aqui, para que a tela
 * diga quantas pessoas caem e quantas operações ainda não replicaram. Devolve o cancelador.
 */
export function ouvirPedidoDeSaida(handler: () => void): () => void {
  const ponte = window.electron;
  if (ponte === undefined) return () => undefined;
  ponte.on("exit-impact", handler);
  return () => ponte.off("exit-impact", handler);
}

export async function confirmarSaida(): Promise<void> {
  await window.electron?.confirmExit();
}

/**
 * U-06 — a pessoa viu o impacto e desistiu. Sem isto, o main mantinha o prazo de 10 s e a
 * janela fechava sozinha depois de "Cancelar"; e o guarda ficava gasto, deixando o
 * fechamento seguinte passar sem mostrar impacto nenhum.
 */
export async function cancelarSaida(): Promise<void> {
  await window.electron?.cancelExit?.();
}

/** Deep links já parseados pelo main. Devolve o cancelador. */
export function ouvirDeepLinks(handler: (link: DeepLink) => void): () => void {
  function aoLink(ev: Event): void {
    const detalhe = (ev as CustomEvent<DeepLink>).detail;
    if (detalhe !== undefined && detalhe !== null) handler(detalhe);
  }
  window.addEventListener("deeplink", aoLink);
  return () => window.removeEventListener("deeplink", aoLink);
}

/**
 * §15.3 — pede ao main o token de uso único para um comando `main-confirmed`. O cancelamento
 * do diálogo nativo é `E_CANCELLED`, um desfecho normal: a UI o trata como "o usuário
 * desistiu", não como falha.
 */
export async function pedirToken(cmd: string, arg?: unknown): Promise<string> {
  const ponte = window.electron;
  if (ponte === undefined) {
    throw new IpcCommandError({ code: "E_NO_SHELL", message: "Sem shell para confirmar a ação" });
  }
  // O argumento vai junto porque o token de §15.3 se liga a `(cmd, alvo)` desde a emenda de
  // 2026-09-05: é dele que o main tira o alvo para NOMEAR na caixa nativa, e é contra o
  // argumento do quadro que o núcleo confere. Mandar o mesmo objeto nos dois lugares é o
  // que faz os dois lados derivarem o mesmo escopo.
  const r = await ponte.requestAuthToken(cmd, arg);
  if (!r.ok || r.token === undefined) {
    throw new IpcCommandError({
      code: r.code ?? "E_PERMISSION_DENIED",
      message: r.code === "E_CANCELLED" ? "Ação cancelada" : "Confirmação nativa indisponível",
    });
  }
  return r.token;
}
