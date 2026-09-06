/**
 * Smoke da gramática **fechada** de deep link (§3.5).
 *
 * Por que um smoke e não um teste do core: a gramática vivia em dois lugares — o produto
 * (`app/src/main`) e uma cópia em `core/src/l3/ipcMain` —, e só a cópia tinha teste. Ela já
 * havia divergido (faltava a rota `u/<KEY64>` da emenda B64), então a suíte validava uma
 * implementação que nenhum processo executava. Ficou uma só, no processo que de fato recebe
 * `argv` e `open-url`, e este smoke é a verificação dela.
 *
 *   npm run smoke:deeplink
 *
 * **E a gramática não era o defeito.** Ela estava certa e o link não fazia nada: o main
 * entregava `{route,…}` ao `webContents`, o preload virava evento de janela e o renderer
 * **nunca registrava a escuta** — `assinarDeepLinks` existia e ninguém a chamava. Um smoke
 * que só valida o parse passa com o produto inteiro surdo, e passou. Por isso a segunda
 * parte: preload real, bundle real do renderer, e a pergunta que importa — o link mudou
 * alguma coisa do outro lado?
 *
 *   xvfb-run -a npm run smoke:deeplink       (a parte de ponta a ponta precisa de display)
 *
 * Requer `npm run build` em app/ (roda contra `dist/main/deeplink.js`) e em frontend/.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const MODULO = path.resolve(AQUI, '../dist/main/deeplink.js');

const { parseDeepLink } = await import(pathToFileURL(MODULO).href);

const CHAVE64 = 'A'.repeat(64);
const casos = [
  // Aceita: as três rotas de §3.5 + B64.
  ['comunidadep2p://join/0123456789ABCDEF', { route: 'join', code: '0123456789ABCDEF' }],
  [`comunidadep2p://m/${'A'.repeat(86)}`, { route: 'message', ref: 'A'.repeat(86) }],
  [`comunidadep2p://u/${CHAVE64}`, { route: 'user', key: CHAVE64.toLowerCase() }],
  // A caixa da URL é tolerada na rota de pessoa, e a chave segue em minúsculas.
  [`  comunidadep2p://u/${CHAVE64.toLowerCase()}  `, { route: 'user', key: CHAVE64.toLowerCase() }],

  // Recusa: gramática fechada quer dizer que tudo o mais é `null`.
  ['comunidadep2p://join/invalid-short', null],
  ['comunidadep2p://join/0123456789ABCDEFG', null], // 17 caracteres
  ['comunidadep2p://join/0123456789abcdef', null], // Crockford é maiúsculo
  ['comunidadep2p://join/0123456789ABCDEI', null], // `I` não existe em Crockford
  [`comunidadep2p://u/${'A'.repeat(63)}`, null],
  [`comunidadep2p://u/${'Z'.repeat(64)}`, null], // fora do alfabeto hexadecimal
  [`comunidadep2p://m/${'A'.repeat(85)}`, null],
  ['https://comunidadep2p.org/join/0123456789ABCDEF', null],
  ['comunidadep2p://outra/coisa', null],
  ['javascript:alert(1)', null],
  ['file:///etc/passwd', null],
  ['', null],
];

let falhas = 0;
for (const [entrada, esperado] of casos) {
  const obtido = parseDeepLink(entrada);
  try {
    assert.deepEqual(obtido, esperado);
  } catch {
    falhas++;
    console.error(`FALHOU ${JSON.stringify(entrada)}\n  esperado ${JSON.stringify(esperado)}\n  obtido   ${JSON.stringify(obtido)}`);
  }
}

if (falhas > 0) {
  console.error(`\nsmoke:deeplink REPROVADO — ${falhas} de ${casos.length} casos`);
  process.exit(1);
}
console.log(`gramática ok — ${casos.length} casos de §3.5`);

// ── Parte 2: o link chega ao renderer, e o renderer faz algo com ele ──────────────────
//
// O observável é o convite pendente de §11 A2, que o store persiste: se ele está no
// `localStorage` depois do evento, a escuta foi registrada, `receber` correu e a rota
// `join` posicionou a prévia. Se `assinarDeepLinks` voltar a não ser chamada, sai `null`.

const RAIZ = path.resolve(AQUI, '..');
const PRELOAD = path.join(RAIZ, 'dist/preload/index.js');
const INDEX = path.resolve(RAIZ, '../frontend/dist/index.html');
const ELECTRON = path.join(RAIZ, 'node_modules/electron/cli.js');
const JANELA = path.join(AQUI, 'smoke-deeplink-renderer.cjs');
const CODIGO = '0123456789ABCDEF';

if (!fs.existsSync(PRELOAD)) {
  console.error(`preload não encontrado em ${PRELOAD} — rode \`npm run build\` em app/.`);
  process.exit(2);
}
if (!fs.existsSync(INDEX)) {
  console.error(`renderer não encontrado em ${INDEX} — rode \`npm run build\` em frontend/.`);
  process.exit(2);
}
if (process.env.DISPLAY === undefined && process.platform === 'linux') {
  console.error('sem DISPLAY: rode por `xvfb-run -a` ou aponte um display.');
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-deeplink-'));
const saida = await new Promise((resolve) => {
  const pedacos = [];
  const filho = spawn(
    process.execPath,
    [
      ELECTRON, JANELA,
      `--preload=${PRELOAD}`,
      `--index=${INDEX}`,
      `--codigo=${CODIGO}`,
      '--no-sandbox',
      '--password-store=basic_text',
      `--user-data-dir=${path.join(tmp, 'ud')}`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const morte = setTimeout(() => filho.kill('SIGKILL'), 30_000);
  filho.stdout.on('data', (d) => pedacos.push(String(d)));
  filho.stderr.on('data', (d) => pedacos.push(String(d)));
  filho.on('exit', () => {
    clearTimeout(morte);
    resolve(pedacos.join(''));
  });
});
fs.rmSync(tmp, { recursive: true, force: true });

const linha = /PENDENTE=(.*)/.exec(saida);
const chegou = linha !== null && linha[1].includes(CODIGO);
if (!chegou) {
  console.error(saida);
  console.error(
    `\nsmoke:deeplink REPROVADO — o link não chegou ao renderer.\n` +
      `O main enviou \`deeplink\` e o convite pendente não apareceu: a escuta ` +
      `(\`assinarDeepLinks\`) não está registrada, ou a rota \`join\` não posiciona nada.`,
  );
  process.exit(1);
}

console.log(`ponta a ponta ok — o link \`join\` virou convite pendente no renderer`);
console.log('smoke:deeplink OK');
