/**
 * `preload` — ponte segura entre renderer e main/utilityProcess (§3.1, §3.4)
 *
 * - Expõe `window.electron` com contextIsolation + sandbox
 * - **Transfere** a porta IPC-R ao mundo principal do renderer
 * - Encapsula `requestAuthToken` para comandos main-confirmed (§15.3)
 *
 * A transferência é por `window.postMessage(..., [port])`, e não por um getter no
 * `contextBridge`: o bridge serializa o que atravessa, e um `MessagePort` não sobrevive a
 * isso — o renderer receberia um objeto morto. `postMessage` com lista de transferência é o
 * único caminho que entrega a porta VIVA ao mundo principal.
 *
 * O preload também NÃO chama `port.start()`. Quem inicia é quem escuta: o `hello` do núcleo
 * (§15.1, primeiro quadro do canal) já pode estar na fila da porta quando ela chega aqui, e
 * iniciá-la sem listener descartaria justamente o quadro que fixa o `epoch`.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { UpdateStatus } from '../main/atualizacao';

type DeepLink = { route: string; code?: string; ref?: string; key?: string };

/** Uma fonte capturável, como o sistema a nomeia — nunca como a UI a imaginaria. */
export interface CaptureSource {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  /** `data:` JPEG da miniatura; `null` quando o sistema não entregou imagem. */
  thumbnail: string | null;
  /** `data:` PNG do ícone do aplicativo, só para janelas. */
  appIcon: string | null;
  displayId: string | null;
}

/**
 * O que esta plataforma faz com captura: onde há áudio para pedir, por tipo de fonte, e de
 * quem é a escolha da fonte — nossa ou do seletor do sistema (`xdg-desktop-portal`).
 */
export interface CaptureSupport {
  screen: boolean;
  window: boolean;
  platform: string;
  /**
   * `true` = **o sistema escolhe a fonte**, e listar aqui abriria a caixa dele. O seletor
   * do produto não aparece nesse caminho: a caixa do sistema já É a escolha, e insistir na
   * nossa mostrava a mesma caixa duas vezes (ver `main/captura.ts`).
   */
  systemPicker: boolean;
}

let epoch = 1;

/**
 * Canal → (listener do renderer → embrulho realmente inscrito no `ipcRenderer`).
 * É o que torna `off` capaz de remover o que `on` inscreveu; ver o comentário em `on`.
 */
const embrulhos = new Map<string, Map<(...args: unknown[]) => void, (...args: unknown[]) => void>>();

ipcRenderer.on('ipc-r-port', (event) => {
  const port = event.ports[0];
  if (port === undefined) return;
  // A porta viaja na lista de transferência; o dado é só o rótulo que o renderer procura.
  window.postMessage({ tipo: 'ipc-r-port', epoch }, '*', [port]);
  // Mantido por compatibilidade com quem escuta o anúncio em vez da mensagem.
  window.dispatchEvent(new CustomEvent('ipc-r-ready', { detail: { epoch } }));
});

ipcRenderer.on('core-epoch', (_e, data: { epoch: number }) => {
  epoch = data.epoch;
  window.dispatchEvent(new CustomEvent('core-epoch', { detail: data }));
});

/** Buffer de retenção para abertura a frio: guarda links recebidos antes do renderer assinar. */
const deepLinksPendentes: DeepLink[] = [];

ipcRenderer.on('deeplink', (_e, data: DeepLink) => {
  deepLinksPendentes.push(data);
  window.dispatchEvent(new CustomEvent('deeplink', { detail: data }));
});

contextBridge.exposeInMainWorld('electron', {
  getEpoch: () => epoch,
  /** Drena e limpa a fila de deep links recebidos na abertura a frio. */
  consumirDeepLinksPendentes: (): DeepLink[] => {
    const pendentes = [...deepLinksPendentes];
    deepLinksPendentes.length = 0;
    return pendentes;
  },
  // U-06 — o renderer mostrou o impacto de sair e a pessoa confirmou.
  confirmExit: async (): Promise<void> => {
    await ipcRenderer.invoke('confirmExit');
  },
  /**
   * §15.3 — o token de uso único para um comando `main-confirmed`.
   *
   * `arg` é o MESMO argumento que seguirá no quadro IPC-R: o main tira dele o alvo da ação
   * (a emenda de 2026-09-05 liga o token a `(cmd, escopo)`) e o mostra na caixa nativa. Não
   * é autorização — quem confere é o núcleo, derivando o escopo do argumento que de fato
   * chegou. Declarar um alvo aqui e mandar outro no quadro não consome token nenhum.
   */
  requestAuthToken: async (cmd: string, arg?: unknown): Promise<{ ok: boolean; token?: string; code?: string }> => {
    return ipcRenderer.invoke('requestAuthToken', cmd, arg ?? {}) as Promise<{ ok: boolean; token?: string; code?: string }>;
  },
  /**
   * §17.5/`T-41` — declara para qual sessão de tela a próxima captura será pedida. O main
   * usa isto só como endereço da pergunta que fará ao núcleo (`capture.authorize`, §15.7);
   * quem autoriza é o núcleo, contra o `captureToken` local. Chamado depois de
   * `share.start` responder e ANTES de `getDisplayMedia`, que é a ordem que §17.5 exige.
   */
  declareCaptureSession: async (arg: {
    sessionId: string | null;
    kind: 'screen' | 'window';
    sourceId?: string | null;
    audio?: boolean;
  }): Promise<void> => {
    await ipcRenderer.invoke('declareCaptureSession', arg);
  },
  /**
   * §17.5 — as fontes que o seletor do produto mostra. Listar não é capturar: a miniatura
   * é pintada nesta máquina e a ordem de `T-41` continua valendo no `getDisplayMedia`.
   */
  listCaptureSources: async (arg: { kind: 'screen' | 'window' }): Promise<CaptureSource[]> => {
    return (await ipcRenderer.invoke('listCaptureSources', arg)) as CaptureSource[];
  },
  /** O que a plataforma faz com captura — a UI não promete o que não há, nem duplica seletor. */
  captureSupport: async (): Promise<CaptureSupport> => {
    return (await ipcRenderer.invoke('captureSupport')) as CaptureSupport;
  },
  /** §17.2 — Previne a suspensão de energia pelo SO durante chamada de voz ativa. */
  setVoiceActive: async (active: boolean): Promise<void> => {
    await ipcRenderer.invoke('setVoiceActive', active);
  },
  /** U-06 — a pessoa desistiu de fechar. O main solta o prazo e volta a segurar o próximo. */
  cancelExit: async (): Promise<void> => {
    await ipcRenderer.invoke('cancelExit');
  },
  /** Atualizações automáticas (§25.7, T-42) */
  getUpdateStatus: async (): Promise<UpdateStatus> => {
    return ipcRenderer.invoke('getUpdateStatus') as Promise<UpdateStatus>;
  },
  checkForUpdates: async (): Promise<UpdateStatus> => {
    return ipcRenderer.invoke('checkForUpdates') as Promise<UpdateStatus>;
  },
  downloadUpdate: async (): Promise<void> => {
    await ipcRenderer.invoke('downloadUpdate');
  },
  applyUpdate: async (): Promise<void> => {
    await ipcRenderer.invoke('applyUpdate');
  },
  getAppVersion: async (): Promise<string> => {
    return ipcRenderer.invoke('getAppVersion') as Promise<string>;
  },
  windowMinimize: async (): Promise<void> => {
    await ipcRenderer.invoke('windowMinimize');
  },
  windowMaximize: async (): Promise<void> => {
    await ipcRenderer.invoke('windowMaximize');
  },
  windowClose: async (): Promise<void> => {
    await ipcRenderer.invoke('windowClose');
  },
  windowIsMaximized: async (): Promise<boolean> => {
    return (await ipcRenderer.invoke('windowIsMaximized')) as boolean;
  },
  windowGetBounds: async (): Promise<{ x: number; y: number; width: number; height: number } | null> => {
    return (await ipcRenderer.invoke('windowGetBounds')) as { x: number; y: number; width: number; height: number } | null;
  },
  windowSetBounds: async (bounds: { x: number; y: number; width: number; height: number }): Promise<void> => {
    await ipcRenderer.invoke('windowSetBounds', bounds);
  },
  on: (channel: string, listener: (...args: unknown[]) => void): void => {
    // O `ipcRenderer` entrega `(event, ...args)` e o renderer não pode receber o `event`
    // (ele carrega `sender`, que atravessaria o contextIsolation). Daí o embrulho — e daí
    // o REGISTRO dele: `off` recebe o listener original, que nunca foi o que se inscreveu.
    // Sem este mapa, `off` removia um listener que não existia e devolvia sem erro: cada
    // reexecução do efeito de `AppShell` empilhava mais um `exit-impact` vivo, todos com
    // um `hostedImpact` congelado no instante em que foram criados.
    let porCanal = embrulhos.get(channel);
    if (porCanal === undefined) {
      porCanal = new Map();
      embrulhos.set(channel, porCanal);
    }
    if (porCanal.has(listener)) return; // inscrever duas vezes o mesmo é uma vez só
    const embrulho = (_e: unknown, ...args: unknown[]): void => listener(...args);
    porCanal.set(listener, embrulho);
    ipcRenderer.on(channel, embrulho as never);
  },
  off: (channel: string, listener: (...args: unknown[]) => void): void => {
    const porCanal = embrulhos.get(channel);
    const embrulho = porCanal?.get(listener);
    if (porCanal === undefined || embrulho === undefined) return;
    porCanal.delete(listener);
    ipcRenderer.off(channel, embrulho as never);
  },
});

declare global {
  interface Window {
    electron: {
      getEpoch(): number;
      confirmExit(): Promise<void>;
      cancelExit(): Promise<void>;
      setVoiceActive(active: boolean): Promise<void>;
      requestAuthToken(cmd: string, arg?: unknown): Promise<{ ok: boolean; token?: string; code?: string }>;
      declareCaptureSession(arg: {
        sessionId: string | null;
        kind: 'screen' | 'window';
        mode?: 'share' | 'music';
        sourceId?: string | null;
        audio?: boolean;
      }): Promise<void>;
      listCaptureSources(arg: { kind: 'screen' | 'window' }): Promise<CaptureSource[]>;
      captureSupport(): Promise<CaptureSupport>;
      getUpdateStatus(): Promise<UpdateStatus>;
      checkForUpdates(): Promise<UpdateStatus>;
      downloadUpdate(): Promise<void>;
      applyUpdate(): Promise<void>;
      getAppVersion(): Promise<string>;
      windowMinimize(): Promise<void>;
      windowMaximize(): Promise<void>;
      windowClose(): Promise<void>;
      windowIsMaximized(): Promise<boolean>;
      windowGetBounds(): Promise<{ x: number; y: number; width: number; height: number } | null>;
      windowSetBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<void>;
      consumirDeepLinksPendentes?(): DeepLink[];
      on(channel: string, listener: (...args: unknown[]) => void): void;
      off(channel: string, listener: (...args: unknown[]) => void): void;
    };
  }
}
