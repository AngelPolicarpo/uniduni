/**
 * Smoke da tela — **o ciclo parar → recomeçar** (§17.2, §17.5).
 *
 *   xvfb-run -a npm run smoke:tela     (ou com DISPLAY já apontado)
 *
 * O que ele mede, e por que não dá para medir em outro lugar: `live/voz.ts` decide "há
 * imagem deste par" a partir do que o Chromium conta sobre uma trilha de receptor, e essa
 * premissa não é verificável em teste de unidade — o duplo faz o que o autor do duplo
 * acredita. Foi por acreditar errado que o produto quebrou: `aoChegarVideo` disparava só
 * no `unmute`, e a suposição de que desligar produz `mute` e religar produz `unmute` é
 * falsa.
 *
 * O que este smoke fixa, em Chromium de verdade, com os quatro m-lines de §17.2 montados
 * como `voz.ts` os monta:
 *
 *   - `inbound-rtp` traz `mid`, que é como o vigia de §17.2 sabe se os bytes são câmera
 *     (1) ou tela (2). Sem isso o vigia não tem por onde ler a origem.
 *   - a primeira apresentação flui e a borda de `unmute` sai.
 *   - **parar não produz `mute`** — nem 12 s depois, com a trilha de origem parada.
 *   - a segunda apresentação **volta a fluir e não produz borda nenhuma**. É aqui que o
 *     produto ficava surdo: os pixels chegavam e o espectador via "Preparando
 *     compartilhamento…" até o prazo de §17.5 estourar. Só reentrar na chamada resolvia,
 *     porque a conexão nova traz um `ontrack` novo e a primeira borda volta a existir.
 *
 * O que ele **não** prova: nada sobre `MalhaDeVoz`, `EstrelaDeTela` ou o store — não há uma
 * linha de produto nesta página. Quem cobre o produto sobre esta medida são
 * `frontend/src/live/__testes__/voz.test.ts` (o vigia) e `tela.test.ts` (a audiência).
 *
 * As duas primeiras medidas são pré-condição: se falharem, a página está errada e o
 * veredito não vale. As duas últimas são a premissa que o produto passou a codificar — se
 * um Electron futuro passar a emitir as bordas, elas mudam, e o vigia vira redundante em
 * vez de errado. Nesse dia o smoke avisa, que é o ponto.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, '..');
const ELECTRON = path.join(RAIZ, 'node_modules/electron/cli.js');
const JANELA = path.join(AQUI, 'smoke-tela-janela.cjs');

if (!fs.existsSync(ELECTRON)) {
  console.error(`electron não encontrado em ${ELECTRON} — rode \`npm install\` em app/.`);
  process.exit(2);
}
if (process.env.DISPLAY === undefined && process.platform === 'linux') {
  console.error('sem DISPLAY: rode por `xvfb-run -a` ou aponte um display.');
  process.exit(2);
}

const linhas = [];
const filho = spawn(process.execPath, [ELECTRON, JANELA], { stdio: ['ignore', 'pipe', 'inherit'] });
filho.stdout.on('data', (b) => {
  for (const l of String(b).split('\n')) {
    if (!l.startsWith('TELA:')) continue;
    linhas.push(l.slice(5));
    console.log(`  · ${l.slice(5)}`);
  }
});

const codigo = await new Promise((r) => filho.on('exit', r));

const medida = (nome) => linhas.find((l) => l.startsWith(`RESULTADO:${nome}=`))?.split('=')[1] ?? null;

const casos = [
  ['`inbound-rtp` nomeia o m-line — é por ele que o vigia lê a origem', medida('MID') === '2'],
  ['a 1ª apresentação flui', medida('PRIMEIRA_FLUIU') === 'SIM'],
  ['a 1ª apresentação produz a borda de `unmute`', medida('UNMUTE_NA_PRIMEIRA') === 'SIM'],
  ['parar NÃO produz `mute` — a premissa antiga do produto era falsa', medida('MUTE_AO_PARAR') === 'NAO'],
  ['a 2ª apresentação volta a fluir', medida('SEGUNDA_FLUIU') === 'SIM'],
  ['a 2ª apresentação NÃO produz borda — só a medida a enxerga', medida('BORDA_NA_SEGUNDA') === 'NAO'],
];

console.log('\nsmoke da tela — o ciclo parar/recomeçar (§17.2)');
let falhou = codigo !== 0;
for (const [nome, ok] of casos) {
  console.log(`  ${ok ? 'ok  ' : 'FALHA'} ${nome}`);
  if (!ok) falhou = true;
}
console.log(falhou ? '\nreprovado' : '\ntudo verde');
process.exit(falhou ? 1 : 0);
