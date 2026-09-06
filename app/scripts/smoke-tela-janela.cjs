/**
 * Main do `smoke:tela` — uma janela escondida com a página de medição, e nada mais.
 * O veredito é do runner; aqui só se repassa o que a página imprimiu.
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, width: 400, height: 300 });
  w.webContents.on('console-message', (_e, _nivel, mensagem) => {
    if (!mensagem.startsWith('TELA:')) return;
    console.log(mensagem);
    if (mensagem === 'TELA:FIM') app.exit(0);
  });
  await w.loadFile(path.join(__dirname, 'smoke-tela-pagina.html'));
  setTimeout(() => {
    console.log('TELA:ERRO tempo esgotado');
    app.exit(1);
  }, 90_000);
});
