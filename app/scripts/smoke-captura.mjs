/**
 * Smoke da escolha de fonte de captura (§17.5, "Uma janela").
 *
 * O defeito que este smoke existe para não deixar voltar: a opção "Uma janela" abria uma
 * captura, mostrava imagem e transmitia **a primeira janela que o sistema listasse** — o
 * main resolvia `desktopCapturer.getSources(...)[0]` porque a escolha da pessoa nunca
 * chegava até ele. De fora nada parece quebrado: aparece uma tela e ela até se move. Só
 * quem esperava ver a própria janela sabe que é a errada.
 *
 *   xvfb-run -a npm run smoke:captura     (ou com DISPLAY já apontado)
 *
 * Três cenários, todos contra a `resolverFonte` do produto (`dist/main/captura.js`) dentro
 * de um `setDisplayMediaRequestHandler` real:
 *
 *   tela        — declara o id de uma fonte de tela: a captura tem de ser DELA.
 *   inexistente — declara um id que não está na lista viva (a janela fechou entre escolher
 *                 e capturar): a captura tem de ser NEGADA, nunca trocada por outra fonte.
 *                 É o cenário que reprova `fontes[0]` mesmo numa máquina com uma fonte só.
 *   janela      — o cenário completo: várias janelas abertas e a escolhida FORA da primeira
 *                 posição. Onde o X não lista janelas — display virtual sem gerenciador de
 *                 janelas, que é o caso do CI —, ele é declarado **não medido**, e não
 *                 aprovado: um verde que não olhou para nada é pior que um buraco conhecido.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, '..');
const ELECTRON = path.join(RAIZ, 'node_modules/electron/cli.js');
const JANELA = path.join(AQUI, 'smoke-captura-janela.cjs');
const PAGINA = path.join(AQUI, 'smoke-captura-pagina.html');
const CAPTURA = path.join(RAIZ, 'dist/main/captura.js');

if (!fs.existsSync(CAPTURA)) {
  console.error(`${CAPTURA} não encontrado — rode \`npm run build\` em app/ antes.`);
  process.exit(2);
}
if (process.env.DISPLAY === undefined && process.platform === 'linux') {
  console.error('sem DISPLAY: rode por `xvfb-run -a` ou aponte um display.');
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-captura-'));

function cenario(nome) {
  return new Promise((resolve) => {
    const saida = [];
    const filho = spawn(
      process.execPath,
      [
        ELECTRON, JANELA,
        `--cenario=${nome}`,
        `--pagina=${PAGINA}`,
        '--no-sandbox',
        '--password-store=basic_text',
        `--user-data-dir=${path.join(tmp, nome)}`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const morte = setTimeout(() => filho.kill('SIGKILL'), 60_000);
    filho.stdout.on('data', (d) => saida.push(String(d)));
    filho.stderr.on('data', (d) => saida.push(String(d)));
    filho.on('exit', () => {
      clearTimeout(morte);
      resolve(saida.join(''));
    });
  });
}

const problemas = [];
const naoMedidos = [];
function conferir(ok, msg) {
  console.log(`${ok ? '  ok  ' : ' FALHA'} ${msg}`);
  if (!ok) problemas.push(msg);
}
function naoMedido(msg) {
  console.log(`  --   ${msg}`);
  naoMedidos.push(msg);
}

/** `CHAVE=valor` numa linha da saída do cenário. */
function campo(saida, chave) {
  const m = saida.match(new RegExp(`^${chave}=(.*)$`, 'm'));
  return m === null ? null : m[1];
}

console.log('smoke da escolha de fonte de captura (§17.5)\n');

const tela = await cenario('tela');
console.log('tela — o id declarado é o concedido:');
if (campo(tela, 'SEM_FONTE') !== null || campo(tela, 'QUANTAS') === '0') {
  conferir(false, 'o ambiente não listou nenhuma tela — sem isso não há captura a exercitar');
  console.error(tela);
} else {
  conferir(
    campo(tela, 'CONCEDIDA') === campo(tela, 'ESCOLHIDA'),
    `a fonte concedida é a escolhida (${campo(tela, 'CONCEDIDA')})`,
  );
  conferir((campo(tela, 'CAPTURA') ?? '').startsWith('OK:'), 'a captura sobe com trilha de vídeo');
  conferir(
    (campo(tela, 'CAPTURA') ?? '').includes(campo(tela, 'ESCOLHIDA') ?? ' '),
    `a trilha capturada é a da fonte escolhida (${campo(tela, 'CAPTURA')})`,
  );
  conferir(
    Number(campo(tela, 'COM_MINIATURA')) === Number(campo(tela, 'QUANTAS')),
    `toda fonte listada tem miniatura (${campo(tela, 'COM_MINIATURA')}/${campo(tela, 'QUANTAS')})`,
  );
  conferir(campo(tela, 'PROPRIA_FILTRADA') === 'true', 'a própria janela do app fica fora da lista');
}

const inexistente = await cenario('inexistente');
console.log('\ninexistente — a fonte sumiu entre escolher e capturar:');
conferir(
  campo(inexistente, 'CONCEDIDA') === 'nenhuma',
  'fonte que não está na lista viva é NEGADA, não trocada pela primeira',
);
conferir(
  (campo(inexistente, 'CAPTURA') ?? '').startsWith('ERRO:'),
  `e o renderer recebe a recusa (${campo(inexistente, 'CAPTURA')})`,
);

const janela = await cenario('janela');
console.log('\njanela — a escolhida não é a primeira da lista:');
const quantas = Number(campo(janela, 'QUANTAS') ?? '0');
if (quantas < 2) {
  naoMedido(
    `o X listou ${quantas} janela(s): sem gerenciador de janelas o Chromium não enumera janela nenhuma. ` +
      'Rode este smoke numa sessão gráfica de verdade para exercitar o cenário completo.',
  );
} else {
  conferir(
    campo(janela, 'INDICE_DA_ESCOLHIDA') !== '0',
    `a janela escolhida está fora da primeira posição (índice ${campo(janela, 'INDICE_DA_ESCOLHIDA')})`,
  );
  conferir(
    campo(janela, 'CONCEDIDA') === campo(janela, 'ESCOLHIDA'),
    `o main concede a janela ESCOLHIDA (${campo(janela, 'CONCEDIDA')}) e não a primeira (${campo(janela, 'PRIMEIRA')})`,
  );
  conferir(
    (campo(janela, 'CAPTURA') ?? '').includes(campo(janela, 'ESCOLHIDA') ?? ' '),
    `a trilha capturada é a da janela escolhida (${campo(janela, 'CAPTURA')})`,
  );
  conferir(
    Number(campo(janela, 'COM_MINIATURA')) === quantas,
    `toda janela listada tem miniatura (${campo(janela, 'COM_MINIATURA')}/${quantas})`,
  );
}

// ── De quem é a escolha da fonte, por plataforma (§17.5) ────────────────────────────────
//
// Não precisa de Electron: é decisão pura, e é a que resolve o loop do Wayland — onde
// `getSources` é o próprio pedido de permissão, listar aqui mostrava a caixa do sistema,
// depois a nossa, e depois a do sistema de novo. A tabela fica presa aqui porque o erro
// natural é afrouxá-la ("é Linux, então é portal") e perder o seletor do produto no X11,
// onde ele é a única escolha real que existe.
console.log('\nde quem é a escolha da fonte:');
const { seletorDoSistema } = await import(`file://${CAPTURA}`);
for (const [plataforma, env, esperado, porque] of [
  ['win32', { WAYLAND_DISPLAY: 'wayland-0' }, false, 'Windows nunca usa portal'],
  ['darwin', { XDG_SESSION_TYPE: 'wayland' }, false, 'macOS nunca usa portal'],
  ['linux', { XDG_SESSION_TYPE: 'wayland' }, true, 'sessão Wayland declarada'],
  ['linux', { WAYLAND_DISPLAY: 'wayland-0' }, true, 'socket do compositor sem declaração (WSLg)'],
  [
    'linux',
    { XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: 'wayland-0' },
    false,
    'X11 declarado vence WAYLAND_DISPLAY herdado do ambiente',
  ],
  ['linux', {}, false, 'X11 puro — o seletor do produto é a única escolha'],
]) {
  conferir(
    seletorDoSistema(plataforma, env) === esperado,
    `${plataforma} ${JSON.stringify(env)} → ${esperado ? 'sistema' : 'produto'} · ${porque}`,
  );
}

// §114.5 — a lacuna de cobertura de B39, fechada.
//
// Duas metades, e a mutação que fazia o main obedecer o renderer em vez do núcleo passava em
// TODAS as outras verificações — typecheck, unidade e este smoke — porque o corpo do handler
// morava dentro de `main/index.ts`, onde nada o alcançava.
console.log('\no fio de `capture.authorize{audio}` e quem honra a decisão:');
const nucleo = await cenario('nucleo');
const respondeu = campo(nucleo, 'NUCLEO_RESPONDEU');
if (respondeu === null) {
  conferir(false, 'o núcleo real não respondeu ao `capture.authorize` — sem isso não há fio a exercitar');
  console.error(nucleo);
} else {
  const r = JSON.parse(respondeu);
  // O núcleo não conhece esta sessão e recusa. O que se prova é a TRAVESSIA: a pergunta foi
  // com o som e a resposta voltou com o campo — §15.7, emenda de 2026-09-03.
  conferir(r.temCampo === true, `a resposta do núcleo real carrega o campo \`audio\` (${respondeu})`);
  conferir(r.allowed === false, 'sessão que o núcleo não conhece é recusada — falha fechada (§17.5)');
  const concedeu = JSON.parse(campo(nucleo, 'NUCLEO_CONCEDEU') ?? '{}');
  conferir(
    concedeu.video === false && concedeu.audio === null,
    'recusa do núcleo não concede vídeo nem som',
  );

  // A regra que a extração tornou alcançável: **pedido E concedido**.
  const caso = (n) => JSON.parse(campo(nucleo, `CASO_${n}`) ?? '{}');
  conferir(
    caso('pediu-negou').video === true && caso('pediu-negou').audio === null,
    'pediu som e o núcleo negou → a captura sobe MUDA, com a imagem intacta',
  );
  conferir(
    caso('pediu-concedeu').audio === 'loopback',
    'pediu som e o núcleo concedeu → o som sobe',
  );
  conferir(
    caso('nao-pediu-concedeu').audio === null,
    'não pediu som → não recebe, mesmo se o núcleo o conceder por engano',
  );

  // O Modo Música É som (§17.5): a concessão exige loopback (a plataforma) E o
  // áudio concedido (o núcleo). Sem um dos dois, a recusa é nomeada — subir mudo
  // seria transmitir a promessa de música sem música.
  const musica = (n) => JSON.parse(campo(nucleo, `CASO_${n}`) ?? '{}');
  conferir(
    musica('musica-win32-concedida').video === true && musica('musica-win32-concedida').audio === 'loopback',
    'Modo Música no Windows: tela primária + loopback, sem seletor',
  );
  conferir(
    musica('musica-linux-concedida').video === true && musica('musica-linux-concedida').audio === 'loopback',
    'Modo Música no Linux: tela primária + loopback, como no Windows (emenda de 2026-09-03)',
  );
  conferir(
    musica('musica-darwin-sem-loopback').video === false && musica('musica-darwin-sem-loopback').audio === null,
    'Modo Música sem loopback na plataforma é NEGADO — nunca captura muda fingindo música',
  );
  conferir(
    musica('musica-win32-som-negado').video === false && musica('musica-win32-som-negado').audio === null,
    'Modo Música com som negado pelo núcleo é NEGADO — música muda não é música',
  );
}

// §17.5 (emenda de 2026-09-03, B39) — o som da captura, e quem o decide.
//
// O main não passa mais a **declaração do renderer** para cá: passa a **resposta do núcleo**
// (`capture.decision{audio}`, §15.7). Esta tabela prende a metade que mora neste módulo —
// que "não concedido" produz captura MUDA e não captura recusada, que é o desfecho declarado
// em §17.5. A outra metade (o núcleo decidir) é unidade, em `musica-captura.test.ts`.
console.log('\no som da captura, e quem o decide:');
const { audioDaCaptura } = await import(`file://${CAPTURA}`);
for (const [plataforma, tipo, concedido, esperado, porque] of [
  ['win32', 'screen', true, 'loopback', 'som concedido numa tela inteira é o som do sistema'],
  ['win32', 'window', true, 'loopback', 'som concedido numa janela — o isolamento é do pedido, §17.5'],
  ['win32', 'screen', false, undefined, 'som NEGADO pelo núcleo sobe a captura muda, não a derruba'],
  // Emenda de 2026-09-03: o loopback do Electron não é só do Windows — o Linux o concede
  // pelo monitor do sink padrão, por dentro do Chromium. Mas é o som da MÁQUINA: numa
  // captura de `window` ele entregaria o sistema inteiro a quem pediu uma janela.
  ['linux', 'screen', true, 'loopback', 'o loopback existe no Linux — o Modo Música vive aqui'],
  ['linux', 'window', true, undefined, 'janela no Linux sobe MUDA: loopback ali seria capturar demais'],
  ['linux', 'screen', false, undefined, 'som NEGADO pelo núcleo sobe muda também no Linux'],
  ['darwin', 'screen', true, undefined, 'sem loopback na plataforma, sobe muda — nunca outra fonte'],
]) {
  conferir(
    audioDaCaptura(tipo, concedido, plataforma) === esperado,
    `${plataforma}/${tipo} · núcleo ${concedido ? 'concedeu' : 'negou'} → ${esperado ?? 'sem som'} · ${porque}`,
  );
}

// §17.5 (emenda de 2026-09-05) — o tipo que vale é o CONCEDIDO, não o declarado.
//
// Onde o portal manda, a lista que volta É a escolha da pessoa, e ela pode ter apontado uma
// janela depois de o renderer declarar `screen`. O defeito que isto prende: o som era
// calculado pelo tipo DECLARADO, então uma janela escolhida no portal subia com `loopback` —
// o som da máquina inteira entregue a quem escolheu compartilhar uma janela. É a captura a
// mais que §17.5 chama pelo nome ("nunca de janela"), e nenhuma verificação a alcançava,
// porque `audioDaCaptura` sozinha responde certo: quem errava era o argumento.
console.log('\nseletor do sistema: o tipo concedido não é o declarado:');
const { atenderPedidoDeCaptura } = await import(`file://${CAPTURA}`);

/** Um pedido inteiro contra a função de produto, com o núcleo e o sistema injetados. */
function pedir({ declarada, fontes, doSistema, decisao, plataforma = 'linux' }) {
  return new Promise((resolve) => {
    atenderPedidoDeCaptura(
      {
        sessaoDeclarada: () => 'sessao-de-teste-0000',
        declaracao: () => declarada,
        perguntarAoNucleo: async () => decisao,
        getSources: async () => fontes,
        seletorDoSistema: () => doSistema,
        plataforma: () => plataforma,
      },
      (c) => resolve({ video: c.video?.id ?? null, audio: c.audio ?? null }),
    );
  });
}

const TELA = { id: 'screen:0:0', name: 'Tela inteira' };
const JAN = { id: 'window:4242:0', name: 'Um navegador qualquer' };
const CONCEDE_TUDO = { allowed: true, sourceTypes: ['screen', 'window'], audio: true };

const portalDeuJanela = await pedir({
  declarada: { kind: 'screen', sourceId: null, audio: true, mode: 'share' },
  fontes: [JAN],
  doSistema: true,
  decisao: CONCEDE_TUDO,
});
conferir(
  portalDeuJanela.video === JAN.id && portalDeuJanela.audio === null,
  `declarou tela + som, o portal deu JANELA → sobe muda (${JSON.stringify(portalDeuJanela)})`,
);

const portalDeuTela = await pedir({
  declarada: { kind: 'screen', sourceId: null, audio: true, mode: 'share' },
  fontes: [TELA],
  doSistema: true,
  decisao: CONCEDE_TUDO,
});
conferir(
  portalDeuTela.video === TELA.id && portalDeuTela.audio === 'loopback',
  `declarou tela + som e o portal deu TELA → o loopback sobe (${JSON.stringify(portalDeuTela)})`,
);

const tipoNaoAutorizado = await pedir({
  declarada: { kind: 'window', sourceId: null, audio: false, mode: 'share' },
  fontes: [TELA],
  doSistema: true,
  decisao: { allowed: true, sourceTypes: ['window'], audio: false },
});
conferir(
  tipoNaoAutorizado.video === null,
  'o portal devolveu um tipo que o núcleo não autorizou → NEGADA, não concedida assim mesmo',
);

// E, sem portal, a outra metade: `window` sem `sourceId` não é "a primeira janela da lista"
// — a primeira costuma ser a janela DESTE app, e ninguém a escolheu.
const janelaSemEscolha = await pedir({
  declarada: { kind: 'window', sourceId: null, audio: false, mode: 'share' },
  fontes: [JAN, { id: 'window:9:0', name: 'Outra' }],
  doSistema: false,
  decisao: CONCEDE_TUDO,
});
conferir(
  janelaSemEscolha.video === null,
  'seletor do produto: `window` sem fonte escolhida é NEGADA, não `fontes[0]`',
);

fs.rmSync(tmp, { recursive: true, force: true });
if (naoMedidos.length > 0) console.log(`\n${naoMedidos.length} cenário(s) NÃO MEDIDO(S) neste ambiente`);
console.log(problemas.length === 0 ? 'tudo verde' : `\n${problemas.length} problema(s)`);
process.exit(problemas.length === 0 ? 0 : 1);
