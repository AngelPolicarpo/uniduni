/**
 * `app/src/main/atualizacao.ts` — Gerenciador de atualizações do shell Electron (§25.7, T-42)
 *
 * Integração com `electron-updater` (Alternativa 1):
 * - Consulta de metadados de release no GitHub Releases público (sem telemetria, sem servidor proprietário).
 * - Suporte a downloads diferenciais (delta updates com .blockmap) para Windows (NSIS) e Linux (AppImage).
 * - `autoInstallOnAppQuit = false`: o updater NUNCA mata o processo diretamente; ele respeita
 *   obrigatoriamente o encerramento gracioso (§3.3 draining) com fechamento de cores e bancos.
 * - Disparo de eventos via canal `update-status` para o renderer refletir na interface.
 */

import { app, BrowserWindow, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { UpdateInfo, ProgressInfo } from 'electron-updater';

export type UpdateStatus =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; version: string; releaseDate?: string; releaseNotes?: string }
  | { status: 'not-available'; version: string }
  | { status: 'downloading'; percent: number; transferred: number; total: number; bytesPerSecond: number }
  | { status: 'ready'; version: string }
  | { status: 'error'; message: string };

let estadoAtual: UpdateStatus = { status: 'idle' };
let janelaAtiva: BrowserWindow | null = null;
let callbackEncerramento: ((motivo: string, aoTerminar?: () => void) => void) | null = null;
let configurado = false;

function notificar(novoEstado: UpdateStatus): void {
  estadoAtual = novoEstado;
  if (janelaAtiva !== null && !janelaAtiva.isDestroyed()) {
    janelaAtiva.webContents.send('update-status', estadoAtual);
  }
}

/**
 * Configura os listeners e opções do `autoUpdater`.
 */
function configurarAutoUpdater(): void {
  if (configurado) return;
  configurado = true;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.logger = {
    info(message?: unknown) {
      console.log(`[atualizacao] ${String(message)}`);
    },
    warn(message?: unknown) {
      console.warn(`[atualizacao] ${String(message)}`);
    },
    error(message?: unknown) {
      console.error(`[atualizacao] ${String(message)}`);
    },
    debug() {},
  };

  autoUpdater.on('checking-for-update', () => {
    console.log('[atualizacao] verificando se há atualizações...');
    notificar({ status: 'checking' });
  });

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    console.log(`[atualizacao] versão ${info.version} disponível`);
    const releaseNotes = typeof info.releaseNotes === 'string'
      ? info.releaseNotes
      : Array.isArray(info.releaseNotes)
        ? info.releaseNotes.map((n) => (typeof n === 'string' ? n : n.note ?? '')).join('\n')
        : undefined;

    notificar({
      status: 'available',
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes,
    });
  });

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    console.log(`[atualizacao] nenhuma atualização disponível (versão atual: ${info.version ?? app.getVersion()})`);
    notificar({
      status: 'not-available',
      version: info.version ?? app.getVersion(),
    });
  });

  autoUpdater.on('download-progress', (p: ProgressInfo) => {
    notificar({
      status: 'downloading',
      percent: Math.round(p.percent),
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond,
    });
  });

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    console.log(`[atualizacao] download concluído para a versão ${info.version}`);
    notificar({
      status: 'ready',
      version: info.version,
    });
  });

  autoUpdater.on('error', (err: Error) => {
    const msg = err?.message ?? String(err);
    console.error('[atualizacao] erro durante verificação/download:', msg);
    notificar({
      status: 'error',
      message: msg,
    });
  });

  // Registra IPC handlers
  ipcMain.handle('getUpdateStatus', () => estadoAtual);
  ipcMain.handle('getAppVersion', () => app.getVersion());

  ipcMain.handle('checkForUpdates', async () => {
    return checarAtualizacoes();
  });

  ipcMain.handle('downloadUpdate', async () => {
    return baixarAtualizacao();
  });

  ipcMain.handle('applyUpdate', () => {
    return aplicarAtualizacao();
  });
}

/**
 * Dispara a verificação de atualizações.
 */
export async function checarAtualizacoes(): Promise<UpdateStatus> {
  configurarAutoUpdater();

  // Em modo de desenvolvimento sem P2P_FORCE_UPDATE_CHECK, tratamos de forma graciosa
  if (!app.isPackaged && process.env.P2P_FORCE_UPDATE_CHECK !== '1') {
    if (process.env.P2P_MOCK_UPDATE === '1') {
      console.log('[atualizacao] simulando atualização em desenvolvimento (P2P_MOCK_UPDATE=1)');
      notificar({
        status: 'available',
        version: '99.9.9-dev',
        releaseDate: new Date().toISOString(),
        releaseNotes: 'Notas simuladas da versão de teste.',
      });
      return estadoAtual;
    }
    console.log('[atualizacao] modo desenvolvimento — ignorando checagem real');
    notificar({ status: 'not-available', version: app.getVersion() });
    return estadoAtual;
  }

  try {
    notificar({ status: 'checking' });
    await autoUpdater.checkForUpdates();
    return estadoAtual;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[atualizacao] falha ao checar atualizações:', msg);
    notificar({ status: 'error', message: msg });
    return estadoAtual;
  }
}

/**
 * Inicia o download da atualização disponível.
 */
export async function baixarAtualizacao(): Promise<void> {
  configurarAutoUpdater();

  if (!app.isPackaged && process.env.P2P_FORCE_UPDATE_CHECK !== '1') {
    if (process.env.P2P_MOCK_UPDATE === '1') {
      console.log('[atualizacao] simulando progresso de download...');
      notificar({
        status: 'downloading',
        percent: 50,
        transferred: 50_000_000,
        total: 100_000_000,
        bytesPerSecond: 2_500_000,
      });
      setTimeout(() => {
        notificar({ status: 'ready', version: '99.9.9-dev' });
      }, 1500);
      return;
    }
    throw new Error('Download de atualização só está ativo no executável empacotado');
  }

  await autoUpdater.downloadUpdate();
}

/**
 * Aplica a atualização baixada realizando o draining gracioso de §3.3 antes do reinício.
 */
export function aplicarAtualizacao(): void {
  if (estadoAtual.status !== 'ready') {
    throw new Error('Nenhuma atualização pronta para ser instalada');
  }

  console.log('[atualizacao] aplicando atualização — solicitando encerramento gracioso (§3.3)');

  if (callbackEncerramento !== null) {
    callbackEncerramento('auto-update', () => {
      console.log('[atualizacao] draining concluído — executando quitAndInstall');
      if (app.isPackaged || process.env.P2P_FORCE_UPDATE_CHECK === '1') {
        autoUpdater.quitAndInstall(false, true);
      } else {
        app.quit();
      }
    });
  } else {
    if (app.isPackaged || process.env.P2P_FORCE_UPDATE_CHECK === '1') {
      autoUpdater.quitAndInstall(false, true);
    } else {
      app.quit();
    }
  }
}

/**
 * Atualiza a referência da janela para envio de eventos IPC.
 */
export function definirJanelaAtualizacao(win: BrowserWindow | null): void {
  janelaAtiva = win;
}

/**
 * Inicializa o módulo de atualização e agenda checagem automática.
 */
export function inicializarAtualizacao(
  win: BrowserWindow,
  iniciarEncerramentoFn: (motivo: string, aoTerminar?: () => void) => void,
): void {
  janelaAtiva = win;
  callbackEncerramento = iniciarEncerramentoFn;
  configurarAutoUpdater();

  // Checagem automática 15 s após o boot em ambiente de produção
  if (app.isPackaged || process.env.P2P_FORCE_UPDATE_CHECK === '1') {
    setTimeout(() => {
      void checarAtualizacoes().catch((e) => {
        console.warn('[atualizacao] falha na checagem de fundo:', (e as Error)?.message ?? e);
      });
    }, 15_000);
  }
}
