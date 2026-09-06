/**
 * A janela do `smoke:clipboard`: os handlers REAIS do produto (`main/permissoes.ts`) e uma
 * página que chama `navigator.clipboard.writeText` com gesto do usuário, como o botão de
 * copiar faz. O veredito é lido do módulo `clipboard` do Electron — a área de transferência
 * de verdade, não a promessa.
 */
const { app, BrowserWindow, clipboard, session } = require('electron');
const path = require('node:path');

function arg(nome) {
  const p = process.argv.find((a) => a.startsWith(`--${nome}=`));
  return p === undefined ? undefined : p.slice(nome.length + 3);
}

const { permissaoConcedida } = require(path.join(__dirname, '../dist/main/permissoes.js'));
const CENARIO = arg('cenario') ?? 'produto';
const SENTINELA = 'SENTINELA-ANTERIOR';
const ALVO = 'comunidadep2p://join/0123456789ABCDEF';

app.whenReady().then(async () => {
  if (CENARIO === 'produto') {
    session.defaultSession.setPermissionRequestHandler((_wc, p, cb) => cb(permissaoConcedida(p)));
    session.defaultSession.setPermissionCheckHandler((_wc, p) => permissaoConcedida(p));
  } else {
    // `so-media` reproduz a lista anterior — o cenário que precisa continuar REPROVANDO.
    session.defaultSession.setPermissionRequestHandler((_wc, p, cb) => cb(p === 'media'));
    session.defaultSession.setPermissionCheckHandler((_wc, p) => p === 'media');
  }

  clipboard.writeText(SENTINELA);
  const win = new BrowserWindow({ show: true, webPreferences: { contextIsolation: true } });
  // `file://`, como o renderer do produto (§3.1). `data:` tem origem opaca e não é
  // contexto seguro: ali `navigator.clipboard` é `undefined` e a medida seria outra.
  await win.loadFile(path.join(__dirname, 'smoke-clipboard-janela.html'));
  win.focus();
  await new Promise((r) => setTimeout(r, 300));

  // `executeJavaScript(..., true)` é o gesto do usuário — o clique no botão de copiar.
  const promessa = await win.webContents.executeJavaScript(
    `(async () => {
       if (!window.isSecureContext) return 'INSEGURO';
       if (navigator.clipboard === undefined) return 'SEM_API';
       try { await navigator.clipboard.writeText(${JSON.stringify(ALVO)}); return 'RESOLVEU'; }
       catch (e) { return 'REJEITOU:' + e.name; }
     })()`,
    true,
  );

  console.log(`PROMESSA=${promessa}`);
  console.log(`AREA=${clipboard.readText()}`);
  console.log(`LEITURA_CONCEDIDA=${permissaoConcedida('clipboard-read')}`);
  console.log(`GEO_CONCEDIDA=${permissaoConcedida('geolocation')}`);

  win.destroy();
  app.quit();
});
