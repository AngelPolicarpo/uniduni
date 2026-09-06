/**
 * A janela do cenário de ponta a ponta de `smoke:deeplink`.
 *
 * Preload REAL do produto + bundle REAL do renderer (`frontend/dist`). Sem núcleo: o
 * `Sincronizador` fica na tela de "Sem núcleo", e é justamente aí que a escuta de deep
 * link precisa existir — um link pode chegar antes de o núcleo responder.
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');

function arg(nome) {
  const p = process.argv.find((a) => a.startsWith(`--${nome}=`));
  return p === undefined ? undefined : p.slice(nome.length + 3);
}

const PRELOAD = arg('preload');
const INDEX = arg('index');
const CODIGO = arg('codigo');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: false },
  });

  await win.loadFile(INDEX);
  // O `App` assina no efeito de montagem; um tick de macrotask basta para o React commitar.
  await new Promise((r) => setTimeout(r, 500));

  // Exatamente o que `handleDeepLinkRaw` do produto envia depois de `parseDeepLink`.
  win.webContents.send('deeplink', { route: 'join', code: CODIGO });
  await new Promise((r) => setTimeout(r, 500));

  const guardado = await win.webContents.executeJavaScript(
    "localStorage.getItem('comunidade-p2p:pending-invite')",
  );
  console.log(`PENDENTE=${guardado}`);

  win.destroy();
  app.quit();
});
