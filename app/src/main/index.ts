/**
 * `app` — Electron main (§3.1, §3.2, §3.3, §10.8, A13, §15.2)
 *
 * Topologia normativa (§3.1):
 *   main cria DOIS MessageChannelMain e cruza as portas:
 *     IPC-M  main ↔︎ núcleo (utilityProcess) — privado, nunca ao renderer (§3.2)
 *     IPC-R  núcleo ↔︎ renderer — o main NÃO fica no meio do tráfego de dado
 *
 * Ciclo §3.3: boot → wipe-resume → identity → view → open → swarm → ready → draining
 * Lock §10.8: 1) requestSingleInstanceLock 2) flock em p2p/LOCK 3) RocksDB 4) SQLite
 * SafeStorage A13(5)(6): probe --password-store antes do lock, com relaunch e argv preservado
 * G6 §15.2: crash do utilityProcess → epoch+1, E_CORE_RESTARTED, resync
 */

import { app, BrowserWindow, MessageChannelMain, desktopCapturer, dialog, session, shell, safeStorage, utilityProcess, ipcMain, type UtilityProcess } from 'electron';
import { atenderPedidoDeCaptura, seletorDoSistema, suporteDeCaptura } from './captura';
import type { DeclaracaoDeCaptura } from './captura';
import path from 'node:path';
import fs from 'node:fs';

// Deep link: gramática fechada de §3.5 (emenda B64), em `main/deeplink.ts` — uma
// implementação só, e é esta que o `smoke:deeplink` exercita.
import { parseDeepLink, type DeepLink } from './deeplink';

// §10.8 etapa 1 — instância única; deep link com app aberto via second-instance
/**
 * Links parseados que ainda não chegaram a documento nenhum. **É fila, não histórico:** o
 * que é entregue sai dela. A versão anterior só empilhava, e o `did-finish-load` a relia
 * inteira a cada carga — então uma recarga da janela ressuscitava o convite de duas horas
 * atrás, com a prévia abrindo sozinha em cima do que a pessoa estava fazendo.
 */
let deepLinkQueue: DeepLink[] = [];

/** Entrega o que estiver na fila ao documento vivo, e **esvazia**. */
function drenarDeepLinks(): void {
  if (mainWindow === null || mainWindow.isDestroyed() || deepLinkQueue.length === 0) return;
  const pendentes = deepLinkQueue;
  deepLinkQueue = [];
  for (const dl of pendentes) mainWindow.webContents.send('deeplink', dl);
}

function handleDeepLinkRaw(raw: string): void {
  const parsed = parseDeepLink(raw);
  if (parsed === null) {
    console.log(`deeplink.rejected ${raw}`);
    return;
  }
  /*
   * §3.5(2) emendado (2026-09-05) — o dado estruturado vai ao **renderer**, e só a ele.
   *
   * A regra 3 manda o link apenas posicionar a UI numa confirmação, e a prévia que essa
   * tela mostra é `invite.resolve` / `query.resolveMessageLink` pela IPC-R: o núcleo já
   * atende os dois. O `postMessage({kind:'deeplink'})` que existia aqui não tinha
   * consumidor do outro lado — o `utilityProcess` logava e voltava —, então o "encaminha
   * ao núcleo" era escrita sem efeito nas duas pontas. Ver a emenda em `docs/backend-v2.md`.
   */
  deepLinkQueue.push(parsed);
  // Com janela viva e carregada, entrega agora; senão espera o `did-finish-load`.
  if (mainWindow !== null && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
    drenarDeepLinks();
  }
}

/*
 * §10.8 etapa 1 no topo, e o probe de A13(6) **depois** — a ordem é essa de propósito.
 *
 * A13(6) exige que o probe de `--password-store` rode antes do lock composto, e a razão que
 * a própria ADR dá é a etapa (2): "o processo relançado encontra o próprio lock e morre com
 * `E_CORE_ALREADY_RUNNING`". Esse código é do `flock` de `p2p/LOCK`, que quem toma é o
 * `utilityProcess` — e o probe roda no topo do `whenReady`, antes de `spawnUtility()`.
 *
 * Com a etapa (1) a ordem não pode ser essa, e não precisa ser: `safeStorage
 * .isEncryptionAvailable()` **só responde depois do `ready`** no Linux (é o que a API
 * documenta), então o probe não tem como preceder um `requestSingleInstanceLock` de topo de
 * módulo; e `app.relaunch()` só sobe a instância nova **quando a atual sai** ("Relaunches
 * the app when the current instance exits"), então ela nunca disputa o singleton com o
 * processo que a pediu. A emenda de 2026-09-05 em A13(6) fixa isso por escrito.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const link = argv.find((a) => a.startsWith('comunidadep2p://'));
    if (link) handleDeepLinkRaw(link);
    // `mainWindow` pode estar destruída e ainda não ter sido zerada por um `closed` que não
    // rodou: durante o draining a referência sobrevive à janela, e tocá-la lança
    // "Object has been destroyed" no processo main inteiro.
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// --- SafeStorage probe A13(5)(6) — antes do lock composto de §10.8 -------------------
//
// **O switch viaja no `argv` do relaunch, e não no `appendSwitch` do processo corrente.**
// A13(6) mede que `--password-store` só tem efeito antes de `app.whenReady()`; a versão
// anterior chamava `appendSwitch` DEPOIS do ready (de dentro de `spawnUtility`) e relançava
// com `process.argv.slice(1)`, que é o argv **original** — o switch anexado não ia junto e
// nenhum boot jamais rodou com backend forçado. Passando-o no argv, ele está presente desde
// o `main()` do processo novo, que é antes do ready por construção; `appendSwitch` fica
// junto porque a ADR o nomeia e ele é inofensivo.
//
// A ordem exigida por A13(6) continua valendo, e é por isso que a decisão roda no topo do
// `whenReady`, **antes** de `spawnUtility()`: o `utilityProcess` é quem toma o lock de
// §10.8, e um relaunch depois disso encontraria o próprio lock.
const CANDIDATES = ['gnome-libsecret', 'kwallet6', 'kwallet5'] as const;

function arquivoProbe(): string {
  return path.join(app.getPath('userData'), 'keystore-backend-probe');
}

/** O backend APROVADO, persistido para ser reusado sem repetir o probe (A13 6). */
function arquivoBackendAprovado(): string {
  return path.join(app.getPath('userData'), 'keystore-backend');
}

/** Estado do probe entre relaunches: quem já foi tentado e quando a lista se esgotou. */
type EstadoProbe = { tentados: string[]; esgotadoEm?: number };

function lerEstadoProbe(): EstadoProbe {
  try {
    const raw = fs.readFileSync(arquivoProbe(), 'utf8').trim();
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    // Formato antigo: só o array de tentados.
    if (Array.isArray(v)) return { tentados: v.filter((x): x is string => typeof x === 'string') };
    const o = v as EstadoProbe | null;
    if (o !== null && Array.isArray(o.tentados)) return o;
  } catch {}
  return { tentados: [] };
}

function gravar(caminho: string, conteudo: string): void {
  fs.mkdirSync(path.dirname(caminho), { recursive: true });
  fs.writeFileSync(caminho, conteudo, 'utf8');
}

function lerTexto(caminho: string): string | null {
  try {
    const t = fs.readFileSync(caminho, 'utf8').trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

/**
 * De quanto em quanto tempo vale repetir o probe depois de ele se esgotar.
 *
 * Nem "nunca mais" nem "a cada boot": esgotar e desligar para sempre é o defeito da versão
 * anterior (instalar o chaveiro depois não mudava nada); repetir sempre custaria três
 * relaunches em toda abertura numa máquina headless. Um dia é o meio-termo — e o caso comum
 * de "instalei o chaveiro" nem chega aqui, porque `isEncryptionAvailable()` responde `true`
 * e a função retorna antes.
 */
const REPETIR_PROBE_APOS_MS = 24 * 60 * 60 * 1000;

/** Relança preservando o argv (§3.5(4): o deep link não se perde) com o switch pedido. */
function relancarCom(backend: string): void {
  const argv = process.argv.slice(1).filter((a) => !a.startsWith('--password-store'));
  app.commandLine.appendSwitch('password-store', backend);
  app.relaunch({ args: [...argv, `--password-store=${backend}`] });
  app.exit(0);
}

/**
 * A13(5)(6) — decide o backend de secret store desta máquina. Devolve `true` quando
 * relançou (o processo corrente deve encerrar sem subir mais nada).
 */
function resolverBackendDeSenha(): boolean {
  if (process.platform !== 'linux') return false;

  const forcado = app.commandLine.hasSwitch('password-store');
  let disponivel = false;
  try {
    disponivel = safeStorage.isEncryptionAvailable();
  } catch {}

  if (disponivel) {
    // Deu certo. Se foi um candidato forçado, **persiste o aprovado** e limpa a lista de
    // tentados: é isso que A13(6) chama de "reusado no boot seguinte, sem repetir o probe".
    if (forcado) {
      const backend = app.commandLine.getSwitchValue('password-store');
      if (backend) {
        gravar(arquivoBackendAprovado(), backend);
        try { fs.rmSync(arquivoProbe(), { force: true }); } catch {}
        console.log(`[main] keystore: backend ${backend} aprovado e persistido`);
      }
    }
    return false;
  }

  // Sem cifra disponível. Se já há um backend aprovado de outro boot, aplica-o (uma vez).
  if (!forcado) {
    const aprovado = lerTexto(arquivoBackendAprovado());
    if (aprovado !== null && (CANDIDATES as readonly string[]).includes(aprovado)) {
      console.log(`[main] keystore: reaplicando backend aprovado ${aprovado}`);
      relancarCom(aprovado);
      return true;
    }
  }

  const estado = lerEstadoProbe();
  if (estado.esgotadoEm !== undefined && Date.now() - estado.esgotadoEm < REPETIR_PROBE_APOS_MS) {
    return false;
  }

  // Autodetecção caiu em `basic_text` (G10 §3.1.1 caso A: WSL2, headless, SSH, contêiner):
  // é a hipótese do probe. Com um candidato já forçado, seguimos para o próximo.
  if (!forcado) {
    let backend = 'basic_text';
    try { backend = safeStorage.getSelectedStorageBackend(); } catch {}
    if (backend !== 'basic_text') return false;
  }

  const tentados = [...estado.tentados];
  const atual = forcado ? app.commandLine.getSwitchValue('password-store') : '';
  if (atual && !tentados.includes(atual)) tentados.push(atual);
  const proximo = CANDIDATES.find((c) => !tentados.includes(c));
  if (proximo !== undefined) {
    tentados.push(proximo);
    gravar(arquivoProbe(), JSON.stringify({ tentados } satisfies EstadoProbe));
    console.log(`[main] keystore: tentando backend ${proximo}`);
    relancarCom(proximo);
    return true;
  }

  // Esgotou candidatos — degradado de verdade (A13 5). O núcleo recusará criar identidade
  // sem o aceite de L-2. A marca de esgotamento é datada: o probe volta a valer amanhã, em
  // vez de ficar desligado para sempre depois de três relaunches.
  //
  // O backend aprovado sai junto: se ele ainda funcionasse, não teríamos chegado aqui. Uma
  // aprovação obsoleta (o chaveiro foi desinstalado) custaria um relaunch inútil em TODA
  // abertura, porque é ela que o boot normal aplica antes de olhar o esgotamento.
  try { fs.rmSync(arquivoBackendAprovado(), { force: true }); } catch {}
  gravar(arquivoProbe(), JSON.stringify({ tentados: [], esgotadoEm: Date.now() } satisfies EstadoProbe));
  console.warn('[main] keystore: candidatos esgotados — modo degradado (L-2)');
  return false;
}

// --- Estado -------------------------------------------------------------------------
let mainWindow: BrowserWindow | null = null;
let utility: UtilityProcess | null = null;

/**
 * §17.5/`T-41` — a ordem é `share.start` → o host autoriza → `captureToken` → captura.
 * Nunca o contrário. O renderer DECLARA para qual sessão vai pedir tela antes de chamar
 * `getDisplayMedia`; quem decide se aquela sessão existe e está autorizada é o núcleo, por
 * `capture.authorize` (§15.7). A declaração é só o endereço da pergunta: um renderer que
 * inventasse um `sessionId` receberia `gone` do núcleo, porque o `captureToken` é local e
 * nasceu lá dentro (§17.4 emendado).
 */
let sessaoDeCapturaDeclarada: string | null = null;

let capturaDeclarada: DeclaracaoDeCaptura = { kind: 'screen', sourceId: null, audio: false, mode: 'share' };
const decisoesDeCaptura = new Map<string, Array<(d: { allowed: boolean; sourceTypes: readonly string[]; audio: boolean }) => void>>();

/**
 * Pergunta ao núcleo (§15.7 `capture.authorize` → `capture.decision`). Falha fechada.
 *
 * `audio` é a emenda de 2026-09-03 (**B39**): o pedido de som **vai junto**, e a resposta diz
 * se ele é concedido. Antes disto o flag ia do renderer direto para cá e o main o obedecia —
 * o núcleo não sabia que uma captura de som de máquina inteira estava acontecendo, e o
 * renderer era a única autoridade sobre isso.
 */
function perguntarCapturaAoNucleo(
  sessionId: string,
  kind: 'screen' | 'music' = 'screen',
  audio = false,
): Promise<{ allowed: boolean; sourceTypes: readonly string[]; audio: boolean }> {
  const nucleo = utility;
  if (nucleo === null) return Promise.resolve({ allowed: false, sourceTypes: [], audio: false });
  return new Promise((resolve) => {
    const fila = decisoesDeCaptura.get(sessionId) ?? [];
    fila.push(resolve);
    decisoesDeCaptura.set(sessionId, fila);
    nucleo.postMessage({ kind: 'capture.authorize', sessionId, captureKind: kind, captureAudio: audio });
    // Sem resposta, não concede. Uma captura que trava é pior que uma que recusa: a pessoa
    // vê o erro e tenta de novo, em vez de olhar para um diálogo que nunca abre.
    setTimeout(() => {
      const pendentes = decisoesDeCaptura.get(sessionId);
      if (pendentes?.includes(resolve) === true) {
        decisoesDeCaptura.set(sessionId, pendentes.filter((r) => r !== resolve));
        resolve({ allowed: false, sourceTypes: [], audio: false });
      }
    }, 5_000);
  });
}
let epoch = 1;
let utilityRestarts = 0;
const MAX_RESTARTS = 3;
let restartWindowStart = Date.now();
let ipcM: MessageChannelMain | null = null;
let ipcRForUtility: MessageChannelMain | null = null;
/** Quit em andamento — a saída do utilityProcess é esperada, não crash (§3.3 draining). */
let encerrando = false;
/** §3.3 — o núcleo recusou abrir por condição definitiva; não há respawn que a resolva. */
let nucleoBloqueado = false;
/** O respawn de §15.2 em voo. Guardado para não nascer núcleo no meio de um quit. */
let reinicioAgendado: ReturnType<typeof setTimeout> | null = null;

// Prompt de confirmação nativa para comandos main-confirmed (§15.3)
/**
 * §15.3 — o token nasce NO núcleo (`AuthTokenStore`, consumo síncrono no roteador); este
 * mapa guarda só os pedidos de emissão em voo entre o diálogo nativo e a resposta da IPC-M.
 */
const pedidosDeToken = new Map<number, (r: { ok: boolean; token?: string; code?: string }) => void>();
let proximoPedidoToken = 1;

function pedirTokenAoNucleo(cmd: string, escopoBruto: unknown): Promise<{ ok: boolean; token?: string; code?: string }> {
  return new Promise((resolve) => {
    if (ipcM === null || utility === null) {
      resolve({ ok: false, code: 'E_NO_PORT' });
      return;
    }
    const id = proximoPedidoToken++;
    pedidosDeToken.set(id, resolve);
    ipcM.port1.postMessage({ kind: 'issueToken', cmd, escopoBruto, id });
    setTimeout(() => {
      if (pedidosDeToken.delete(id)) resolve({ ok: false, code: 'E_TIMEOUT' });
    }, 5_000);
  });
}

/**
 * §15.3 emendado — a tabela fechada do que a caixa nativa diz, por comando.
 *
 * Vive aqui, e não no renderer, pela razão que a emenda dá: se o texto viesse de quem pede,
 * um renderer comprometido escolheria a frase que o usuário aceitaria. A cópia é declarada
 * no processo main porque `l3/ipcMain` do núcleo é ESM carregado só dentro do
 * `utilityProcess`; a fonte normativa das duas é a mesma tabela de §15.3, e o núcleo é quem
 * de fato recusa (`comandoConfirmado`) o nome que não estiver nela.
 */
const CAIXA_POR_COMANDO: Readonly<Record<string, { titulo: string; detalhe: string; botao: string; escopo: string | null }>> = {
  'identity.wipe': {
    titulo: 'Apagar esta instalação?',
    detalhe: 'Identidade, comunidades e mensagens locais são removidas desta máquina. Não há desfazer.',
    botao: 'Apagar tudo',
    escopo: null,
  },
  'identity.export': {
    titulo: 'Exportar a identidade?',
    detalhe: 'Grava um backup cifrado pela frase secreta que você digitou. Quem tiver o arquivo e a frase tem a sua identidade.',
    botao: 'Exportar',
    escopo: null,
  },
  'identity.import': {
    titulo: 'Restaurar identidade de um backup?',
    detalhe: 'Substitui o estado local desta instalação pelo backup escolhido.',
    botao: 'Restaurar',
    escopo: null,
  },
  'community.end': {
    titulo: 'Encerrar a comunidade?',
    detalhe: 'Quem está conectado cai, e a comunidade deixa de existir para todos os membros.',
    botao: 'Encerrar',
    escopo: 'communityId',
  },
  'community.forget': {
    titulo: 'Esquecer esta comunidade?',
    detalhe: 'A réplica local é apagada desta máquina. A comunidade continua existindo para os outros.',
    botao: 'Esquecer',
    escopo: 'communityId',
  },
  'community.assumeHost': {
    titulo: 'Assumir a hospedagem?',
    detalhe: 'Cria a continuação da comunidade sob esta máquina; os membros precisam reentrar.',
    botao: 'Assumir',
    escopo: 'communityId',
  },
  'core.reproject': {
    titulo: 'Reprojetar o estado?',
    detalhe: 'O núcleo congela enquanto reabre o estado a partir do log. Nada é perdido.',
    botao: 'Reprojetar',
    escopo: 'communityId',
  },
  'blob.reveal': {
    titulo: 'Abrir este arquivo compactado?',
    detalhe: 'O arquivo será aberto pelo aplicativo que o sistema associar a ele.',
    botao: 'Abrir',
    escopo: 'blobId',
  },
  'dm.forget': {
    titulo: 'Esquecer esta conversa?',
    detalhe: 'As mensagens locais desta conversa são apagadas desta máquina.',
    botao: 'Esquecer',
    escopo: 'conversationId',
  },
};

/**
 * §13.6 — as extensões que `shell.openPath` pode entregar ao handler do SO.
 *
 * É a tabela de §13.6 **sem** `other`: `image`, `audio`, `video`, `document` e — desde a
 * emenda de 2026-09-05 (`B73`) — `archive`, cuja abertura §15.3 gateia pela caixa nativa
 * ("Abrir este arquivo compactado?"). Executáveis não precisam de lista própria aqui:
 * nenhum deles está nesta, e o que não está é recusado.
 *
 * Isto **duplica** a decisão que o núcleo já toma em `canReveal` (§13.6, `l2/blobs`), e a
 * duplicação é o ponto: §3.1 declara a allowlist dentro da caixa do main, e o main é a
 * fronteira que fala com o SO. A do núcleo continua sendo a normativa — esta é a que
 * garante que nada chegue ao `openPath` sem passar por uma.
 */
const EXTENSOES_ABRIVEIS: ReadonlySet<string> = new Set([
  // image
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'tiff', 'heic',
  // video
  'mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v',
  // audio
  'mp3', 'wav', 'flac', 'ogg', 'opus', 'm4a', 'aac',
  // document
  'pdf', 'txt', 'md', 'csv', 'json', 'xml', 'odt', 'ods', 'odp', 'docx', 'xlsx', 'pptx', 'rtf',
  // archive — §15.3 exige confirmação nativa antes de o comando chegar até aqui
  'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar',
]);

function extensaoAbrivel(caminho: string): boolean {
  const ext = path.extname(caminho).replace(/^\./, '').toLowerCase();
  return ext !== '' && EXTENSOES_ABRIVEIS.has(ext);
}

/**
 * Os esquemas que o main entrega ao navegador do sistema.
 *
 * `shell.openExternal` obedece o que o SO registrar: `file:`, `smb:`, um handler de app
 * qualquer. O comentário aqui prometia allowlist e não havia nenhuma — qualquer `window.open`
 * do renderer virava "o SO que decide".
 *
 * A lista não é escolha deste arquivo: §25.4 já fixa `http`/`https`/`mailto` para URL em
 * mensagem, "o resto vira texto". Um link que o renderer não teria como pintar também não
 * deve ter como abrir.
 */
const ESQUEMAS_EXTERNOS: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:']);

function podeAbrirExternamente(url: string): boolean {
  try {
    return ESQUEMAS_EXTERNOS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

// --- Criação do utilityProcess com dois canais (§3.1) -----------------------------
function spawnUtility(): void {
  const utilityPath = path.join(__dirname, '../utility/index.js');
  const child = utilityProcess.fork(utilityPath, [], {
    serviceName: 'comunidade-nucleo',
    env: { ...process.env, P2P_DATA_DIR: app.getPath('userData') },
  });
  utility = child;

  // Sinais de ciclo do núcleo (§3.3): ready/blocked/drained/crashed.
  child.on('message', (msg: unknown) => {
    const m = msg as { e?: string; phase?: string; code?: string; message?: string };
    if (m.e === 'ready') {
      console.log(`núcleo pronto na fase ${m.phase}, epoch ${epoch}`);
      mainWindow?.webContents.send('core-ready', { phase: m.phase, epoch });
    } else if (m.e === 'blocked') {
      /*
       * §3.3 — `blocked` é **terminal**, não crash. "Lock ocupado → `E_CORE_ALREADY_RUNNING`,
       * encerra" e "`manifest.db` à frente do binário → `E_SCHEMA_AHEAD`, encerra" são
       * desfechos definitivos: reiniciar não muda nenhuma das duas condições.
       *
       * A saída que vem logo depois é `exit(3)`/`exit(1)`, e sem esta marca ela caía na
       * lógica de respawn de §15.2 — o núcleo subia de novo, batia no mesmo lock, e a caixa
       * "Núcleo bloqueado" aparecia mais três vezes antes de a cota de 60 s se esgotar.
       * Quatro caixas para um problema que a primeira já descreveu inteiro.
       */
      nucleoBloqueado = true;
      dialog.showErrorBox('Núcleo bloqueado', `O núcleo não pôde iniciar (${m.code}). ${m.message ?? ''}`);
    } else if (m.e === 'crashed') {
      console.error('núcleo crashou:', m.message);
    } else if (m.e === 'drained') {
      aoDrained?.();
      aoDrained = null;
    }
  });

  // --- IPC-M: canal privado main ↔︎ núcleo, nunca ao renderer ------------------------
  ipcM = new MessageChannelMain();
  // Porta 1 fica no main, porta 2 vai ao utility
  child.postMessage({ kind: 'ipc-m-port' }, [ipcM.port2 as unknown as Electron.MessagePortMain]);

  ipcM.port1.on('message', async (e: Electron.MessageEvent) => {
    const msg = e.data as {
      q?: string; id?: number; dataKeyB64?: string; wrappedB64?: string;
      suggestedName?: string; dataB64?: string;
      communityId?: string; path?: string; mode?: string;
    };
    // Protocolo do IpcKeystoreOracle (§3.2/A13): respostas {a, id}
    if (msg.q === 'wrapDataKey' && msg.dataKeyB64 !== undefined && msg.id !== undefined) {
      try {
        const wrapped = safeStorage.encryptString(msg.dataKeyB64);
        ipcM!.port1.postMessage({ a: 'wrapDataKey', id: msg.id, wrappedB64: wrapped.toString('base64') });
      } catch (err) {
        ipcM!.port1.postMessage({ a: 'error', id: msg.id, code: 'E_KEYSTORE', message: (err as Error).message });
      }
    } else if (msg.q === 'unwrapDataKey' && msg.wrappedB64 !== undefined && msg.id !== undefined) {
      try {
        const plain = safeStorage.decryptString(Buffer.from(msg.wrappedB64, 'base64'));
        ipcM!.port1.postMessage({ a: 'unwrapDataKey', id: msg.id, dataKeyB64: plain });
      } catch (err) {
        ipcM!.port1.postMessage({ a: 'error', id: msg.id, code: 'E_KEYSTORE', message: (err as Error).message });
      }
    } else if (msg.q === 'keystoreInfo' && msg.id !== undefined) {
      let backend = 'unknown';
      try { backend = safeStorage.getSelectedStorageBackend(); } catch {}
      ipcM!.port1.postMessage({ a: 'keystoreInfo', id: msg.id, available: safeStorage.isEncryptionAvailable(), backend });
    } else if (msg.q === 'file.save' && msg.id !== undefined && typeof msg.dataB64 === 'string') {
      // §5.5/§13.3 — o main grava o arquivo do backup; caminho nenhum volta ao núcleo.
      const win = mainWindow ?? BrowserWindow.getFocusedWindow();
      const result = win !== null
        ? await dialog.showSaveDialog(win, { title: 'Salvar backup de identidade', defaultPath: msg.suggestedName })
        : { canceled: true, filePath: '' } as const;
      if (result.canceled || !result.filePath) {
        ipcM!.port1.postMessage({ id: msg.id, ok: false, code: 'E_CANCELLED' });
      } else {
        try {
          fs.writeFileSync(result.filePath, Buffer.from(msg.dataB64, 'base64'));
          ipcM!.port1.postMessage({ id: msg.id, ok: true, data: null });
        } catch {
          ipcM!.port1.postMessage({ id: msg.id, ok: false, code: 'E_INTERNAL' });
        }
      }
    } else if (msg.q === 'file.read' && msg.id !== undefined) {
      // §5.5 import — o main lê o arquivo escolhido e manda os BYTES pela IPC-M.
      const win = mainWindow ?? BrowserWindow.getFocusedWindow();
      const result = win !== null
        ? await dialog.showOpenDialog(win, { title: 'Restaurar identidade', properties: ['openFile'] })
        : { canceled: true, filePaths: [] as string[] };
      if (result.canceled || result.filePaths.length === 0) {
        ipcM!.port1.postMessage({ id: msg.id, ok: false, code: 'E_CANCELLED' });
      } else {
        try {
          const bytes = fs.readFileSync(result.filePaths[0]!);
          ipcM!.port1.postMessage({ id: msg.id, ok: true, data: bytes.toString('base64') });
        } catch {
          ipcM!.port1.postMessage({ id: msg.id, ok: false, code: 'E_INTERNAL' });
        }
      }
    } else if (msg.q === 'dialogOpenAttachment' && msg.id !== undefined && typeof msg.communityId === 'string') {
      // §13.3 — ticket de anexo: diálogo aqui, caminho nunca cruza o IPC-R.
      // P2P_PICK_FILE (smoke/CI): o main substitui o diálogo por um caminho fixo —
      // decisão DELE, nunca do renderer; o ticket nasce do mesmo jeito.
      const fixo = process.env.P2P_PICK_FILE;
      if (fixo !== undefined && fixo !== '') {
        try {
          const sizeBytes = fs.statSync(fixo).size;
          ipcM!.port1.postMessage({ id: msg.id, ok: true, data: { path: fixo, sizeBytes } });
        } catch {
          ipcM!.port1.postMessage({ id: msg.id, ok: true, data: null });
        }
      } else {
        const win = mainWindow ?? BrowserWindow.getFocusedWindow();
        const result = win !== null
          ? await dialog.showOpenDialog(win, { properties: ['openFile'] })
          : { canceled: true, filePaths: [] as string[] };
        if (result.canceled || result.filePaths.length === 0) {
          ipcM!.port1.postMessage({ id: msg.id, ok: true, data: null });
        } else {
          const p = result.filePaths[0]!;
          try {
            const sizeBytes = fs.statSync(p).size;
            ipcM!.port1.postMessage({ id: msg.id, ok: true, data: { path: p, sizeBytes } });
            void msg.communityId;
          } catch {
            ipcM!.port1.postMessage({ id: msg.id, ok: false, code: 'E_INTERNAL' });
          }
        }
      }
    } else if (msg.q === 'shell.reveal' && msg.id !== undefined && typeof msg.path === 'string') {
      /*
       * §15.7 `shell.open{path, mode}` — **o `mode` é parte do pedido, e era ignorado.**
       * "Mostrar na pasta" abria o arquivo: `openPath` para os dois modos fazia a ação
       * menos invasiva das duas virar a mais invasiva, justamente na que a pessoa escolhe
       * quando não quer abrir. `folder` é `showItemInFolder`.
       *
       * A allowlist de §13.6 é do núcleo (`canReveal`, que recusa executável e tudo fora de
       * image/audio/video/document com `E_TYPE_NOT_OPENABLE`) e continua sendo — mas §3.1
       * põe "shell.openPath (só com allowlist de tipo, §13.6)" dentro da caixa do main, e
       * era a única linha daquela caixa sem verificação nenhuma aqui. Um `openPath` que
       * obedece qualquer caminho que chegue pela IPC-M é uma etapa a menos entre um núcleo
       * com defeito e o handler do SO; conferir a extensão custa nada e fecha a etapa.
       */
      const modo = msg.mode === 'folder' ? 'folder' : 'open';
      if (modo === 'folder') {
        shell.showItemInFolder(msg.path);
        ipcM!.port1.postMessage({ id: msg.id, ok: true, data: null });
      } else if (extensaoAbrivel(msg.path)) {
        void shell.openPath(msg.path);
        ipcM!.port1.postMessage({ id: msg.id, ok: true, data: null });
      } else {
        console.warn(`[main] shell.open recusado — tipo fora da allowlist de §13.6: ${path.extname(msg.path)}`);
        ipcM!.port1.postMessage({ id: msg.id, ok: false, code: 'E_TYPE_NOT_OPENABLE' });
      }
    }
    // §15.7 `capture.decision` — a resposta do núcleo sobre uma sessão de tela.
    const decisao = e.data as { a?: string; sessionId?: string; allowed?: boolean; sourceTypes?: string[]; audio?: boolean };
    if (decisao.a === 'capture.decision' && typeof decisao.sessionId === 'string') {
      const pendentes = decisoesDeCaptura.get(decisao.sessionId) ?? [];
      decisoesDeCaptura.delete(decisao.sessionId);
      for (const resolver of pendentes) {
        resolver({
          allowed: decisao.allowed === true,
          sourceTypes: decisao.sourceTypes ?? [],
          audio: decisao.audio === true,
        });
      }
    }
    // Resposta da emissão de token pedida ao núcleo ({a:'issueToken', id, ok, token?})
    const resposta = e.data as { a?: string; id?: number; ok?: boolean; token?: string; code?: string };
    if (resposta.a === 'issueToken' && resposta.id !== undefined) {
      const resolver = pedidosDeToken.get(resposta.id);
      if (resolver !== undefined) {
        pedidosDeToken.delete(resposta.id);
        resolver(resposta.ok === true ? { ok: true, token: resposta.token } : { ok: false, code: resposta.code ?? 'E_BUSY' });
      }
    }
  });
  ipcM.port1.start();

  // --- IPC-R: canal núcleo ↔︎ renderer, atravessa o main sem ser lido ----------------
  ipcRForUtility = new MessageChannelMain();
  portaREntregue = false;
  renovacaoEmCurso = false;
  // Porta 1 ao utility, porta 2 ao renderer (quando houver janela)
  child.postMessage({ kind: 'ipc-r-port', epoch }, [ipcRForUtility.port1 as unknown as Electron.MessagePortMain]);
  // Na PRIMEIRA subida a janela ainda não existe e quem transfere é o `did-finish-load`.
  // Num respawn (§15.2) a janela já está lá com a porta do núcleo morto na mão: sem esta
  // linha o renderer nunca receberia a porta nova, e o passo 4 da recuperação pararia no
  // `hello` que não chega.
  entregarPortaAoRenderer();

  child.on('exit', (code) => {
    console.log(`utilityProcess saiu com código ${code}, epoch ${epoch}`);
    utility = null;
    try { ipcM?.port1.close(); } catch {}
    ipcM = null;
    try { ipcRForUtility?.port1.close(); } catch {}
    ipcRForUtility = null;

    // Saída esperada: quit em curso (draining) — não é crash.
    if (encerrando) {
      app.quit();
      return;
    }
    // §3.3 — o núcleo recusou abrir por condição definitiva (lock ocupado, schema à frente).
    // Reiniciar só repetiria a recusa e a caixa de erro; o app não tem o que fazer sem núcleo.
    if (nucleoBloqueado) {
      encerrando = true;
      app.quit();
      return;
    }
    const limpo = code === 0;
    if (!limpo) {
      // G6 §15.2 + §3.3: reinicia até 3 vezes em 60s com backoff 1s/4s/10s
      const now = Date.now();
      if (now - restartWindowStart > 60_000) {
        utilityRestarts = 0;
        restartWindowStart = now;
      }
      utilityRestarts++;
      if (utilityRestarts > MAX_RESTARTS) {
        console.error('utilityProcess falhou 3 vezes em 60s — não reinicia mais');
        dialog.showErrorBox('Erro irrecuperável', 'O núcleo falhou repetidamente. O aplicativo será encerrado.');
        app.quit();
        return;
      }
    }
    // Notifica renderer que epoch mudou (§15.2) — o IpcClient falha pendentes e refaz subs.
    epoch++;
    const backoff = limpo ? 50 : ([1000, 4000, 10_000][utilityRestarts - 1] ?? 10_000);
    /*
     * **O reinício agendado tem de saber que o app está saindo.** O backoff chega a 10 s, e
     * fechar a janela dentro dessa janela punha um núcleo NOVO no mundo depois de
     * `encerrando = true`: ele abria os bancos, tomava o lock de §10.8 — e ninguém mais lhe
     * mandaria `shutdown`, porque o `window-all-closed` já tinha mandado (para o `utility`
     * que era `null`). O `app.quit()` do prazo de 8 s o matava por cima, sem snapshot e sem
     * soltar o lock pelo caminho limpo. Guardar o handle e conferir `encerrando` na hora de
     * disparar fecha os dois lados da corrida.
     */
    if (reinicioAgendado !== null) clearTimeout(reinicioAgendado);
    reinicioAgendado = setTimeout(() => {
      reinicioAgendado = null;
      if (encerrando || nucleoBloqueado) return;
      spawnUtility();
    }, backoff);
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('core-epoch', { epoch });
    }
  });

  child.stdout?.on('data', (d: Buffer) => process.stdout.write(`[utility:out] ${d}`));
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[utility:err] ${d}`));
}

/**
 * Transfere a porta 2 do canal IPC-R ao renderer. O main não lê o tráfego (§3.1): ele só
 * cruza as portas. Chamada nos dois momentos em que a porta e a janela coexistem —
 * `did-finish-load` e respawn do núcleo.
 *
 * Marca por canal: porta transferida é neuterada e repostá-la lança; canal novo (respawn)
 * zera a marca ao nascer. Com carga em curso, a entrega é adiada para o fim de carga real
 * (`did-stop-loading`) exatamente uma vez.
 */
let portaREntregue = false;
let entregaAdiada = false;
/** Renovação de canal já pedida — o `shutdown` está em voo; não peça duas vezes. */
let renovacaoEmCurso = false;

/**
 * Pede ao núcleo um encerramento limpo para que o canal IPC-R nasça de novo, com `epoch+1`,
 * e a porta chegue ao documento que acabou de carregar. Ver o comentário em
 * `did-finish-load`: é o caminho de §15.2 já existente, e não um mecanismo novo.
 */
function renovarCanalParaRendererNovo(): void {
  if (renovacaoEmCurso || utility === null || encerrando) return;
  renovacaoEmCurso = true;
  utility.postMessage({ kind: 'shutdown' });
}

function entregarPortaAoRenderer(): void {
  if (ipcRForUtility === null || mainWindow === null || mainWindow.isDestroyed()) {
    console.log(
      `[main] porta IPC-R sem destino ainda (canal=${ipcRForUtility !== null}, janela=${mainWindow !== null && !mainWindow.isDestroyed()})`,
    );
    return;
  }
  // Porta transferida é neuterada: um segundo postMessage com ela lança. Cada canal é
  // entregue uma única vez; canal novo (respawn) zera a marca ao nascer.
  if (portaREntregue) return;
  const wc = mainWindow.webContents;  if (wc.isLoading()) {
    // O Electron emite `did-finish-load` ANTES de encerrar o estado interno de carga —
    // neste ponto isLoading() ainda é true (verificado no smoke de §59), e devolver cedo
    // aqui deixava a partida fria sem porta nenhuma: nem o spawnUtility (janela ausente)
    // nem este evento tentariam de novo. O fim de carga real é `did-stop-loading`, que vem
    // depois; é ele quem retoma a entrega exatamente uma vez.
    if (!entregaAdiada) {
      entregaAdiada = true;
      console.log('[main] porta IPC-R adiada: carga em curso — retoma em did-stop-loading');
      wc.once('did-stop-loading', () => {
        entregaAdiada = false;
        console.log('[main] did-stop-loading — retomando entrega da porta IPC-R');
        entregarPortaAoRenderer();
      });
    }
    return;
  }
  portaREntregue = true;
  console.log('[main] transferindo porta IPC-R ao renderer');
  wc.postMessage('ipc-r-port', null, [
    ipcRForUtility.port2 as unknown as Electron.MessagePortMain,
  ]);
}

/**
 * U-06/§18.7 — fechar como host derruba quem está conectado e pode perder o que ainda não
 * replicou. O renderer mostra o impacto (`host.exitImpact`) e só então confirma; o main
 * segura o primeiro `close` para isso. Uma vez confirmado, a janela fecha de verdade e o
 * draining de §3.3 segue seu curso.
 */
let saidaConfirmada = false;
/** Já pedimos o impacto uma vez: a segunda tentativa de fechar não é mais segurada. */
let pedidoDeSaidaEnviado = false;
/**
 * O prazo que solta a janela quando o renderer não responde. Guardado porque uma resposta
 * — confirmar OU **cancelar** — o torna obsoleto: sem cancelá-lo, quem clicava "Cancelar"
 * via o app fechar sozinho dez segundos depois, que é o contrário do que pediu.
 */
let prazoDeSaida: ReturnType<typeof setTimeout> | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });

  // Carrega o renderer (build do Vite em `frontend/dist`).
  //
  // O caminho é relativo a `app/dist/main`, e um `..` a menos parava DENTRO de `app/` —
  // `fs.existsSync` dava falso, o código caía no `loadURL` do dev server e, sem Vite no ar,
  // a janela ficava branca sem uma linha de log. O fallback silencioso é que transformava
  // um caminho errado em sintoma mudo: agora os candidatos são explícitos, a escolha é
  // registrada, e não achar nenhum é uma tela que DIZ o que faltou.
  const candidatos = [
    path.join(__dirname, '../../../frontend/dist/index.html'), // árvore de desenvolvimento
    path.join(__dirname, '../renderer/index.html'), // empacotado (electron-builder)
  ];
  const rendererPath = candidatos.find((c) => fs.existsSync(c));
  if (rendererPath !== undefined) {
    console.log(`[main] renderer: ${rendererPath}`);
    void mainWindow.loadFile(rendererPath);
  } else if (process.env.P2P_RENDERER_URL !== undefined) {
    console.log(`[main] renderer: ${process.env.P2P_RENDERER_URL} (P2P_RENDERER_URL)`);
    void mainWindow.loadURL(process.env.P2P_RENDERER_URL);
  } else {
    console.error(`[main] renderer não encontrado. Procurei em:\n  ${candidatos.join('\n  ')}`);
    void mainWindow.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          '<body style="font:14px system-ui;padding:2rem;background:#1a1c24;color:#e6e6e6">' +
            '<h1>Renderer nao encontrado</h1>' +
            '<p>Rode <code>npm run build</code> em <code>frontend/</code> antes de <code>npm run dev</code>.</p>' +
            '<p>Para apontar para o dev server do Vite, use <code>P2P_RENDERER_URL=http://localhost:5173</code>.</p>' +
            '</body>',
        ),
    );
  }

  // Quando o renderer estiver pronto, transfere a porta IPC-R
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[main] did-finish-load');
    if (portaREntregue) {
      // **O documento é novo e a porta antiga morreu com o anterior.** Uma `MessagePort`
      // transferida pertence ao documento que a recebeu; quando ele é substituído (recarga
      // após crash do renderer, navegação), ela vai junto e não há como transferi-la de
      // novo — o canal inteiro precisa nascer outra vez. Sem isto o renderer recarregado
      // ficava sem IPC-R até o núcleo morrer por outro motivo: `waitForHello` estourava em
      // 30 s e a tela não tinha caminho de volta.
      //
      // Quem renasce o canal é o ciclo de §15.2 que já existe: pedimos ao núcleo um
      // encerramento LIMPO (`shutdown`), e a saída com código 0 não consome a cota de 3
      // reinícios em 60 s — ela dá `epoch+1`, um `MessageChannelMain` novo e a entrega da
      // porta a esta janela.
      console.log('[main] renderer recarregou — renovando o canal IPC-R');
      renovarCanalParaRendererNovo();
    } else {
      entregarPortaAoRenderer();
    }
    // Entrega os deep links pendentes — e a fila esvazia, senão toda recarga reabriria a
    // prévia de um convite que já foi tratado (ver `drenarDeepLinks`).
    drenarDeepLinks();
  });

  mainWindow.on('close', (e) => {
    console.log(`[main] evento close (saidaConfirmada=${saidaConfirmada}, utility=${utility !== null}, pedido=${pedidoDeSaidaEnviado})`);
    if (saidaConfirmada || mainWindow === null) return;
    // Sem núcleo vivo não há impacto a consultar: segurar a janela seria só travá-la.
    if (utility === null) return;
    // **O guarda nunca pode prender a janela.** Se o renderer não está de pé — tela branca,
    // crash, build ausente —, ninguém vai chamar `confirmExit` e a pessoa fica sem saída.
    // Três escapes, nesta ordem: renderer morto não segura; a segunda tentativa de fechar
    // fecha; e o prazo fecha sozinho. U-06 pede mostrar o impacto, não impedir a saída.
    const wc = mainWindow.webContents;
    if (wc.isDestroyed() || wc.isCrashed() || wc.isLoading() || pedidoDeSaidaEnviado) {
      return;
    }
    e.preventDefault();
    pedidoDeSaidaEnviado = true;
    wc.send('exit-impact');
    // §18.7 dá 5 s de barreira ao fechar; o dobro disso já é tempo de sobra para uma tela
    // aparecer. Passado o prazo SEM RESPOSTA, a janela fecha. Com resposta — confirmar ou
    // cancelar — o prazo é desarmado: ele existe para o silêncio, não para vencer a pessoa.
    prazoDeSaida = setTimeout(() => {
      prazoDeSaida = null;
      if (!saidaConfirmada && mainWindow !== null && !mainWindow.isDestroyed()) {
        console.warn('[main] impacto de saída sem resposta do renderer — fechando mesmo assim');
        saidaConfirmada = true;
        mainWindow.close();
      }
    }, 10_000);
  });

  /**
   * §17.5/`T-41` — **a porta única da captura de tela**. Era comentário; agora é código.
   *
   * O `setDisplayMediaRequestHandler` só concede depois que o núcleo confirmar, por
   * `capture.authorize` (§15.7), que existe sessão viva com `captureToken` válido para o
   * `sessionId` que o renderer declarou. Sem handler explícito a decisão fica com o default
   * do Electron, que varia por versão — e a ordem de §17.5 (`share.start` → host autoriza →
   * `captureToken` → `getDisplayMedia`) deixaria de ser verificável em qualquer lugar.
   *
   * Falha fechada em todos os ramos: sem sessão declarada, sem núcleo, sem decisão dentro do
   * prazo ou sem fonte disponível, `callback({})` nega a captura.
   */
  mainWindow.webContents.session.setDisplayMediaRequestHandler(
    /*
     * O corpo mora em `main/captura.ts` desde 2026-09-03 (§114.5): `main/index.ts` abre
     * janela ao ser importado, então nada aqui dentro é exercitável fora de um app inteiro —
     * e a regra que mais importa (**quem concede o som é o núcleo**, §15.7) vivia justamente
     * aqui, sem teste que a alcançasse. O `smoke:captura` agora chama a MESMA função, com um
     * núcleo real do outro lado.
     */
    (_request, callback) => {
      atenderPedidoDeCaptura(
        {
          sessaoDeclarada: () => sessaoDeCapturaDeclarada,
          declaracao: () => capturaDeclarada,
          perguntarAoNucleo: (sessionId, kind, audio) => perguntarCapturaAoNucleo(sessionId, kind, audio),
          getSources: (opts) => desktopCapturer.getSources(opts as Parameters<typeof desktopCapturer.getSources>[0]),
          seletorDoSistema: () => seletorDoSistema(),
        },
        (concessao) => {
          /*
           * §17.5/`T-41` — **a declaração vale por UMA captura.** Ela é o endereço da
           * pergunta que este handler acabou de fazer ao núcleo; guardá-la depois de
           * respondida deixaria um segundo `getDisplayMedia` sem `declareCaptureSession`
           * herdar a autorização do primeiro, e a ordem que §17.5 exige (`share.start` → o
           * host autoriza → declarar → capturar) passaria a ter um degrau opcional. O
           * núcleo ainda recusaria a sessão morta com `gone`, mas a ordem é a barreira, e
           * ela é daqui. Quem transmite de novo declara de novo — é o que `tela.ts` faz.
           */
          sessaoDeCapturaDeclarada = null;
          callback(concessao);
        },
      );
    },
    /**
     * **Sem `useSystemPicker`.** Ele não é o seletor do sistema que o comentário antigo
     * prometia "no Windows/macOS": o Electron só o usa quando
     * `isDisplayMediaSystemPickerAvailable()` responde `true` e, quando usa, responde
     * `callback({video: <placeholder>})` **sem chamar este handler** — ou seja, sem
     * perguntar ao núcleo. A ordem de `T-41` (§17.5) deixaria de ser verificável
     * justamente onde o seletor existe, e no Linux, que é metade do v1, ele nunca existiu:
     * a pessoa caía no `fontes[0]` de qualquer jeito. O seletor do produto (§17.5, a lista
     * com miniatura por fonte) é quem dá a escolha real, nas duas plataformas.
     */
  );

  // §3.1 — janela nova nenhuma; o que sai vai ao navegador do sistema, e só nos esquemas
  // da allowlist. Ver `podeAbrirExternamente`: o "com allowlist" que este comentário
  // prometia não existia em lugar nenhum.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (podeAbrirExternamente(url)) void shell.openExternal(url);
    else console.warn(`[main] navegação externa recusada — esquema fora da allowlist: ${url.slice(0, 64)}`);
    return { action: 'deny' };
  });

  // A janela morre antes do processo (draining de §3.3 dura até 8 s). Sem zerar a
  // referência, todo `mainWindow !== null` adiante virava acesso a objeto destruído.
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // A13(6) — o probe roda ANTES do lock composto de §10.8, e quem toma o lock é o
  // `utilityProcess`: por isso a decisão vem aqui, antes de `spawnUtility()`. Quando
  // relança, nada mais deste boot acontece.
  if (resolverBackendDeSenha()) return;

  const link = process.argv.find((a) => a.startsWith('comunidadep2p://'));
  if (link) handleDeepLinkRaw(link);

  // §17.2 — a mídia é toda do renderer, então microfone e câmera passam por aqui. Sem um
  // handler explícito a decisão fica com o default do Electron, que varia por versão: uma
  // porta de captura não deve depender disso. `media` é a única concedida; o resto —
  // geolocalização, notificações do SO, MIDI, USB, HID, serial — é recusado, porque §25.4
  // diz que este produto não fala com nada além dos pares.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media');
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');

  spawnUtility();
  createWindow();

  // Linux deep link via xdg-open entrega argv no second-instance; já tratado.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLinkRaw(url);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/**
 * §3.3 draining — o único caminho de encerramento, venha de onde vier.
 *
 * O núcleo fecha cores com snapshot e responde `{e:'drained'}`; sem resposta em 8 s, sai do
 * mesmo jeito (segurar o fechamento é pior, §18.7).
 *
 * **Emenda de 2026-09-05 em §3.3 — o sinal externo entra por aqui.** Antes só
 * `window-all-closed` drenava, e o encerramento vindo de fora da janela (`SIGTERM` de um
 * `systemctl`/gerenciador de sessão, `SIGINT` de um terminal, logoff) matava o processo sem
 * passar por nada: sem snapshot de §10.6, sem a barreira de §18.7 e sem `stopped`. O
 * caminho de U-06 **não** vale nesses casos — a decisão de sair foi tomada fora do app, e
 * perguntar "tem certeza?" a um `SIGTERM` só gasta o prazo que o SO deu antes do `SIGKILL`.
 */
let encerramentoIniciado = false;
function iniciarEncerramento(motivo: string): void {
  if (encerramentoIniciado) return;
  encerramentoIniciado = true;
  encerrando = true;
  console.log(`[main] encerrando (${motivo}) — draining de §3.3`);
  if (reinicioAgendado !== null) {
    clearTimeout(reinicioAgendado);
    reinicioAgendado = null;
  }
  let saiu = false;
  const sairUmaVez = (): void => {
    if (!saiu) {
      saiu = true;
      app.quit();
    }
  };
  aoDrained = sairUmaVez;
  if (utility === null) {
    // Sem núcleo não há o que drenar, e esperar 8 s por um `drained` que não vem é só
    // atraso — no `SIGTERM` é atraso dentro do prazo que o SO concedeu.
    sairUmaVez();
    return;
  }
  utility.postMessage({ kind: 'shutdown' });
  setTimeout(sairUmaVez, 8_000);
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') iniciarEncerramento('window-all-closed');
});

// §3.3 emendado — encerramento externo. O sinal é o caminho do `systemctl`/logoff; o
// `before-quit` cobre o resto (menu Sair, `app.quit()` de outro ponto) sem segurar a saída:
// `iniciarEncerramento` é idempotente e não faz `preventDefault`.
for (const sinal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(sinal, () => iniciarEncerramento(sinal));
}
app.on('before-quit', () => iniciarEncerramento('before-quit'));

/** Chamado quando o núcleo confirma que drenou (mensagem `{e:'drained'}` do utility). */
let aoDrained: (() => void) | null = null;

/**
 * §17.5 — o renderer diz para qual sessão de tela ele vai pedir captura, logo depois de
 * `share.start` responder. Não é autorização: é o endereço da pergunta que o main fará ao
 * núcleo. Quem autoriza é `capture.authorize`, contra o `captureToken` que nasceu lá dentro.
 */
ipcMain.handle('declareCaptureSession', (_e, arg: unknown) => {
  const a = (arg ?? {}) as { sessionId?: unknown; kind?: unknown; sourceId?: unknown; audio?: unknown; mode?: unknown };
  sessaoDeCapturaDeclarada = typeof a.sessionId === 'string' && a.sessionId.length > 0 ? a.sessionId : null;
  capturaDeclarada = {
    ...(a.mode === 'music' ? { mode: 'music' as const } : { mode: 'share' as const }),
    kind: a.kind === 'window' ? 'window' : 'screen',
    sourceId: typeof a.sourceId === 'string' && a.sourceId.length > 0 ? a.sourceId : null,
    audio: a.audio === true,
  };
  console.log(
    `[main] sessão de captura declarada: ${sessaoDeCapturaDeclarada?.slice(0, 8) ?? 'nenhuma'}` +
      ` (${capturaDeclarada.mode ?? 'share'} · ${capturaDeclarada.kind}${capturaDeclarada.sourceId === null ? '' : ' escolhida'}` +
      `${capturaDeclarada.audio ? ' + áudio' : ''})`,
  );
});

/**
 * §17.5 — as fontes que a pessoa pode escolher, para o seletor do produto.
 *
 * **Listar não é capturar.** Nada aqui abre trilha, acende luz de captura ou sai da
 * máquina: são miniaturas locais, pintadas no nosso renderer, do mesmo jeito que o seletor
 * do Chrome as pinta antes de qualquer permissão. A ordem de `T-41` continua intacta —
 * `share.start` → o host autoriza → `captureToken` → `getDisplayMedia` —, e é o handler de
 * `setDisplayMediaRequestHandler` que a faz valer. O que esta lista muda é só isto: quando
 * a captura for concedida, ela é da fonte que a pessoa apontou, e não de `fontes[0]`.
 *
 * A própria janela do app sai da lista: transmiti-la é a sala de espelhos, e nunca é o que
 * se quis escolher.
 */
ipcMain.handle('listCaptureSources', async (_e, arg: unknown) => {
  // Onde o portal manda, LISTAR É PERGUNTAR: `getSources` abriria a caixa do sistema aqui,
  // antes de `share.start` e antes de o host autorizar nada — a ordem de `T-41` de cabeça
  // para baixo, e a primeira das duas caixas que a pessoa via. O renderer já não chama
  // neste caminho; recusar aqui é a segunda tranca, e não uma lista vazia por acaso.
  if (seletorDoSistema()) return [];
  const kind = (arg as { kind?: unknown } | undefined)?.kind === 'window' ? 'window' : 'screen';
  const minhaJanela = mainWindow?.isDestroyed() === false ? mainWindow.getMediaSourceId() : null;
  try {
    const fontes = await desktopCapturer.getSources({
      types: [kind],
      // Grande o bastante para reconhecer a janela, pequeno o bastante para caber num IPC
      // que roda a cada abertura do seletor.
      thumbnailSize: { width: 320, height: 200 },
      fetchWindowIcons: kind === 'window',
    });
    return fontes
      .filter((f) => f.id !== minhaJanela)
      .map((f) => ({
        id: f.id,
        name: f.name,
        kind,
        // JPEG e não PNG: a miniatura é foto de tela, e o PNG dela chega a ser dez vezes
        // maior para o mesmo pixel visível.
        thumbnail: f.thumbnail.isEmpty() ? null : `data:image/jpeg;base64,${f.thumbnail.toJPEG(70).toString('base64')}`,
        // O ícone precisa do canal alfa, então continua PNG.
        appIcon:
          f.appIcon === null || f.appIcon === undefined || f.appIcon.isEmpty()
            ? null
            : f.appIcon.toDataURL(),
        displayId: f.display_id === '' ? null : f.display_id,
      }));
  } catch (e) {
    console.warn('[main] não foi possível listar fontes de captura', e);
    return [];
  }
});

/**
 * O que ESTA plataforma faz com captura — a UI pergunta antes de desenhar o seletor.
 *
 * Duas coisas, e as duas mudam a tela: se há áudio para oferecer (o loopback do Electron é
 * do Windows; no Linux a captura sobe muda, e prometer som ali seria mentira), e de quem é
 * a escolha da fonte — nossa, ou do `xdg-desktop-portal` (ver `seletorDoSistema`).
 */
ipcMain.handle('captureSupport', () => suporteDeCaptura());

/** O renderer terminou de mostrar o impacto de U-06: agora a janela fecha de verdade. */
ipcMain.handle('confirmExit', () => {
  console.log('[main] confirmExit — fechando a janela');
  if (prazoDeSaida !== null) clearTimeout(prazoDeSaida);
  prazoDeSaida = null;
  saidaConfirmada = true;
  mainWindow?.close();
  return { ok: true };
});

/**
 * U-06 — a pessoa viu o impacto e **desistiu**. Duas coisas voltam ao lugar: o prazo de
 * 10 s, que fecharia a janela sozinho e transformaria "Cancelar" em "fechar daqui a pouco";
 * e o próprio guarda, porque `pedidoDeSaidaEnviado` fixo em `true` fazia o fechamento
 * SEGUINTE passar direto, sem mostrar impacto nenhum. Cancelar tem de deixar o app no
 * estado em que estava antes de a pergunta ser feita.
 */
ipcMain.handle('cancelExit', () => {
  console.log('[main] cancelExit — a janela fica, e o guarda volta a valer');
  if (prazoDeSaida !== null) clearTimeout(prazoDeSaida);
  prazoDeSaida = null;
  pedidoDeSaidaEnviado = false;
  return { ok: true };
});

// Confirmação nativa para comandos destrutivos §15.3 — o diálogo é aqui, o token nasce no
// núcleo (AuthTokenStore, consumo síncrono no roteador).
ipcMain.handle('requestAuthToken', async (_e, cmd: unknown, arg: unknown) => {
  // §15.3 emendado, regra 2 — só comando da tabela vira diálogo. Um nome fora dela nem
  // chega a incomodar a pessoa com uma caixa.
  const caixa = typeof cmd === 'string' ? CAIXA_POR_COMANDO[cmd] : undefined;
  if (caixa === undefined) {
    console.warn(`[main] requestAuthToken recusado: ${String(cmd)} não é comando main-confirmed`);
    return { ok: false, code: 'E_UNKNOWN_COMMAND' };
  }
  const win = BrowserWindow.getFocusedWindow();
  if (win === null) return { ok: false, code: 'E_NO_WINDOW' };

  // §15.3 emendado, regra 3 — o alvo sai do argumento. O main extrai só o CAMPO declarado e
  // manda o valor bruto; quem o põe na forma canônica é o núcleo, com a mesma função que o
  // roteador usa para consumir. Assim existe uma implementação só da canonicalização, e o
  // main nunca vê o resto do argumento — `identity.export` não tem escopo justamente para
  // que a `passphrase` não atravesse por aqui.
  const escopoBruto =
    caixa.escopo === null ? undefined : (arg as Record<string, unknown> | null | undefined)?.[caixa.escopo];

  // §15.3 emendado, regra 1 — a caixa NOMEIA a ação. "Confirmar ação destrutiva?" servia
  // igualmente bem para apagar a instalação e para reprojetar uma comunidade: quem lia não
  // tinha como recusar uma e aceitar a outra, e a confirmação nativa virava um clique.
  // O main não vê tráfego do IPC-R (§3.1), então não conhece o NOME da comunidade; mostra o
  // identificador, que é o que ele legitimamente tem.
  // Só um alvo que seja texto vai para a caixa: o `blobId` de `blob.reveal` é um registro de
  // deslocamentos (§13.2) e não diz nada a quem lê. Ele continua ligando o token.
  const alvoLegivel = typeof escopoBruto === 'string' && escopoBruto.length > 0 ? escopoBruto : null;
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Cancelar', caixa.botao],
    defaultId: 0,
    cancelId: 0,
    message: caixa.titulo,
    detail: alvoLegivel === null ? caixa.detalhe : `${caixa.detalhe}\n\nAlvo: ${alvoLegivel}`,
  });
  if (response !== 1) return { ok: false, code: 'E_CANCELLED' };
  // O token nasce NO núcleo e é consumido lá uma única vez (§15.3).
  if (utility === null || ipcM === null) return { ok: false, code: 'E_NO_PORT' };
  return await pedirTokenAoNucleo(cmd as string, escopoBruto);
});
