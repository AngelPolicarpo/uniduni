const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

const PRELOAD = process.argv.find((a) => a.startsWith('--preload='))?.split('=')[1];

if (!PRELOAD) {
  console.error('smoke-atualizacao: --preload obrigatorio');
  process.exit(2);
}

// Configura handlers de teste para o smoke
const { inicializarAtualizacao, checarAtualizacoes, aplicarAtualizacao } = require('../dist/main/atualizacao.js');

let encerramentoChamado = false;
let aoTerminarCallback = null;

function fakeEncerrar(motivo, aoTerminar) {
  encerramentoChamado = true;
  aoTerminarCallback = aoTerminar;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
    },
  });

  inicializarAtualizacao(win, fakeEncerrar);

  // Carrega página mínima para executar o preload
  await win.loadURL('data:text/html;charset=utf-8,<html><body>smoke atualizacao</body></html>');

  try {
    // 1. Testa getAppVersion via ponte preload
    const versao = await win.webContents.executeJavaScript('window.electron.getAppVersion()');
    if (typeof versao !== 'string') {
      console.error('FAIL: getAppVersion nao devolveu string');
      process.exit(1);
    }
    console.log('ok   getAppVersion devolveu string:', versao);

    // 2. Testa getUpdateStatus via ponte preload
    const status = await win.webContents.executeJavaScript('window.electron.getUpdateStatus()');
    if (!status || typeof status.status !== 'string') {
      console.error('FAIL: getUpdateStatus invalido:', status);
      process.exit(1);
    }
    console.log('ok   getUpdateStatus devolveu status inicial:', status.status);

    // 3. Testa checkForUpdates
    const resCheck = await win.webContents.executeJavaScript('window.electron.checkForUpdates()');
    if (!resCheck || (resCheck.status !== 'not-available' && resCheck.status !== 'idle')) {
      console.error('FAIL: checkForUpdates em dev nao devolveu not-available/idle:', resCheck);
      process.exit(1);
    }
    console.log('ok   checkForUpdates em dev respondeu sem erro:', resCheck.status);

    // 4. Testa draining ao chamar aplicarAtualizacao quando pronto
    // Simula estado ready
    process.env.P2P_MOCK_UPDATE = '1';
    await checarAtualizacoes();
    const { baixarAtualizacao } = require('../dist/main/atualizacao.js');
    await baixarAtualizacao();

    // Espera ficar ready
    await new Promise((r) => setTimeout(r, 2000));
    const statusPronto = await win.webContents.executeJavaScript('window.electron.getUpdateStatus()');
    if (statusPronto.status !== 'ready') {
      console.error('FAIL: simulador de update nao alcancou status ready:', statusPronto);
      process.exit(1);
    }
    console.log('ok   simulacao de atualizacao alcancou estado ready');

    // Executa aplicarAtualizacao
    await win.webContents.executeJavaScript('window.electron.applyUpdate()');
    if (!encerramentoChamado) {
      console.error('FAIL: aplicarAtualizacao nao disparou o encerramento com draining');
      process.exit(1);
    }
    console.log('ok   aplicarAtualizacao solicitou o ciclo de encerramento (§3.3)');

    if (typeof aoTerminarCallback !== 'function') {
      console.error('FAIL: callback aoTerminar nao foi passado para o encerramento');
      process.exit(1);
    }
    console.log('ok   callback aoTerminar foi passado corretamente para quitAndInstall');

    console.log('smoke-atualizacao OK');
    app.quit();
  } catch (err) {
    console.error('FAIL: excecao no teste de atualizacao:', err);
    process.exit(1);
  }
});
