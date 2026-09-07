/**
 * Smoke do gerenciador de atualizações (§25.7, T-42).
 *
 * Exercita o ciclo de IPC entre o preload real e o main process:
 * - Leitura da versão do app
 * - Consulta de status de atualização
 * - Verificação de atualizações
 * - Integração do aplicarAtualizacao com o encerramento gracioso (§3.3)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, '..');
const PRELOAD = path.join(RAIZ, 'dist/preload/index.js');
const ELECTRON = path.join(RAIZ, 'node_modules/electron/cli.js');
const JANELA = path.join(AQUI, 'smoke-atualizacao-janela.cjs');

if (!fs.existsSync(PRELOAD)) {
  console.error(`preload não encontrado em ${PRELOAD} — rode \`npm run build\` em app/ antes.`);
  process.exit(2);
}
if (process.env.DISPLAY === undefined && process.platform === 'linux') {
  console.error('sem DISPLAY: rode por `xvfb-run -a` ou aponte um display.');
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-atualizacao-'));

const filho = spawn(
  process.execPath,
  [
    ELECTRON,
    JANELA,
    `--preload=${PRELOAD}`,
    '--no-sandbox',
    '--password-store=basic_text',
    `--user-data-dir=${tmp}`,
  ],
  { stdio: ['ignore', 'inherit', 'inherit'] },
);

const morte = setTimeout(() => {
  filho.kill('SIGKILL');
  console.error('FAIL: timeout no smoke de atualizacao');
  process.exit(1);
}, 25_000);

filho.on('exit', (code) => {
  clearTimeout(morte);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
  if (code !== 0) {
    console.error(`FAIL: processo encerrou com codigo ${code}`);
    process.exit(code ?? 1);
  }
  process.exit(0);
});
