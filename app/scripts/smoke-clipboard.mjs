/**
 * Smoke da área de transferência (§17.2/§25.4).
 *
 * **Todo botão de copiar do produto estava quebrado, e três deles diziam que não.**
 * `navigator.clipboard.writeText` pede a permissão `clipboard-sanitized-write` ao Chromium;
 * o `setPermissionCheckHandler` do main concedia só `media`, então a promessa rejeitava com
 * `NotAllowedError` — link de convite, link do canal, link da mensagem e chave pública.
 * `void promessa` + toast incondicional fazia a interface afirmar o sucesso.
 *
 *   xvfb-run -a npm run smoke:clipboard     (ou com DISPLAY já apontado)
 *
 * Por que smoke e não teste: a decisão mora num handler de `session` do processo main, e
 * nenhuma suíte de renderer alcança isso. É a mesma razão de `smoke:captura` — a regra que
 * mais importa vivia onde nada a exercitava.
 *
 * Dois cenários:
 *   produto  — os handlers reais (`main/permissoes.ts`): a promessa resolve e a área de
 *              transferência recebe o texto.
 *   so-media — a lista anterior, com `media` sozinha. **Tem de reprovar**: é a prova de que
 *              o cenário verde acima é a linha nova, e não o default do Electron.
 *
 * Requer `npm run build` em app/.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, '..');
const MODULO = path.join(RAIZ, 'dist/main/permissoes.js');
const ELECTRON = path.join(RAIZ, 'node_modules/electron/cli.js');
const JANELA = path.join(AQUI, 'smoke-clipboard-janela.cjs');
const ALVO = 'comunidadep2p://join/0123456789ABCDEF';

if (!fs.existsSync(MODULO)) {
  console.error(`${MODULO} não encontrado — rode \`npm run build\` em app/ antes.`);
  process.exit(2);
}
if (process.env.DISPLAY === undefined && process.platform === 'linux') {
  console.error('sem DISPLAY: rode por `xvfb-run -a` ou aponte um display.');
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-clipboard-'));

function cenario(nome) {
  return new Promise((resolve) => {
    const pedacos = [];
    const filho = spawn(
      process.execPath,
      [
        ELECTRON, JANELA,
        `--cenario=${nome}`,
        '--no-sandbox',
        '--password-store=basic_text',
        `--user-data-dir=${path.join(tmp, nome)}`,
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
}

const problemas = [];
function conferir(ok, msg) {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${msg}`);
  if (!ok) problemas.push(msg);
}

console.log('smoke da área de transferência (§17.2/§25.4)\n');

const produto = await cenario('produto');
console.log('produto — os handlers reais de `main/permissoes.ts`:');
conferir(produto.includes('PROMESSA=RESOLVEU'), '`clipboard.writeText` resolve');
conferir(produto.includes(`AREA=${ALVO}`), 'e o texto chega à área de transferência de verdade');
conferir(produto.includes('LEITURA_CONCEDIDA=false'), 'ler a área de transferência continua recusado');
conferir(produto.includes('GEO_CONCEDIDA=false'), 'a lista continua fechada (geolocalização recusada)');

const soMedia = await cenario('so-media');
console.log('\nso-media — a lista anterior, que precisa continuar reprovando:');
conferir(soMedia.includes('PROMESSA=REJEITOU:NotAllowedError'), 'com só `media`, `writeText` rejeita');
conferir(soMedia.includes('AREA=SENTINELA-ANTERIOR'), 'e a área de transferência fica com o conteúdo anterior');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(problemas.length === 0 ? '\ntudo verde' : `\n${problemas.length} problema(s)`);
process.exit(problemas.length === 0 ? 0 : 1);
