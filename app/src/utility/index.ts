/**
 * `utilityProcess` — o núcleo P2P vivo (§3.1, §3.3, §10.8, §18.6, §15.2)
 *
 * Topologia de §3.1: este processo carrega DUAS fronteiras, cruzadas pelo main:
 *   IPC-M  (MessageChannelMain, porta privada main↔núcleo) — Data Key, tickets, tokens;
 *   IPC-R  (MessageChannelMain, porta núcleo↔renderer)     — o `IpcServer` com epoch.
 *
 * Ciclo de §3.3 executado aqui, na ordem:
 *   lock composto (§10.8, etapa flock) → wipe-resume (§18.6) → identity (load) →
 *   view/open/swarm dentro do `bootCore` → ready | awaiting-identity.
 *
 * O código de domínio é todo do `@comunidade/core` (build ESM em `core/dist`). O import é
 * dinâmico porque o build da app é CJS e não pode ter `rootDir` cruzado; a tipagem local é
 * estrutural e mínima — o contrato continua sendo o dos módulos de L3 do core.
 *
 * Atenção ao que o `tsc` faz com esse `import()`: em `module: commonjs` ele NÃO sobrevive
 * como import dinâmico — o emit é `Promise.resolve(p).then(s => __importStar(require(s)))`.
 * Quem carrega o núcleo, portanto, é `require(esm)` (Node >= 22.12, presente no Electron 43).
 * Duas consequências: o diretório do núcleo precisa declarar `type: module` no lugar onde
 * for carregado — em dev vem de `core/package.json`, empacotado vem do marcador que o
 * `montar` escreve —, e nenhum módulo do grafo do core pode usar `await` de topo, porque
 * `require(esm)` é síncrono e recusa módulo assíncrono (`ERR_REQUIRE_ASYNC_MODULE`). Como
 * dev e pacote passam pelo mesmo caminho, uma regressão dessas quebra os dois.
 */

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

// ─── Formas locais (espelhos estruturais das portas do core) ─────────────────────────

interface PortaMensagem {
  postMessage(msg: unknown): void;
  onMessage(listener: (msg: unknown) => void): void;
  start(): void;
}

interface MensagemPai {
  kind?: string;
  epoch?: number;
  code?: string;
  message?: string;
  /** §15.7 `capture.authorize` — a sessão de tela que o main quer autorizar a capturar. */
  sessionId?: string;
  /** §17.5 (emenda de 2026-08-28) — `music` resolve contra o token do Modo Música. */
  captureKind?: 'screen' | 'music';
  /**
   * §17.5 (emenda de 2026-09-03, B39) — a captura leva som?
   *
   * Antes desta emenda o flag ia do renderer direto ao main, que o obedecia: o núcleo não
   * sabia que uma captura de **som de máquina inteira** estava acontecendo, e não tinha como
   * recusá-la nem registrá-la. Quem decidia era o renderer, sozinho.
   */
  captureAudio?: boolean;
}

let epoch = 1;
let portaM: PortaMensagem | null = null;
let portaR: PortaMensagem | null = null;
let booted = false;
let iniciando = false;
let drenando = false;
let runtime: {
  shutdown(a?: { budgetMs?: number }): Promise<{ drainedMs: number; pendingOps: number; replicatedTo: number }>;
  close(): Promise<void>;
  phase: string;
  /** §15.7/§17.4 emendado — resolvido só contra o estado local; nunca vai ao host. */
  authorizeCapture(a: { sessionId: string; kind?: 'screen' | 'music'; audio?: boolean }): { allowed: boolean; reason?: string; sourceTypes: readonly string[]; audio: boolean };
} | null = null;
let liberarLock: (() => void) | null = null;
let authTokenStore: { issue(cmd: string, escopo: string | null): string } | null = null;
/** §15.3 — a tabela fechada da classe `main-confirmed`, resolvida no `loadCore`. */
let comandoConfirmado: ((cmd: string) => unknown | null) | null = null;
/** §15.3 — a forma canônica do alvo do token; a MESMA que o roteador usa ao consumir. */
let canonicalizarEscopo: ((v: unknown) => string | null) | null = null;
/** Para a rede de §14.1 no draining — o transporte é do processo, não do runtime. */
let pararRede: (() => Promise<void>) | null = null;
// Os ids deste lado começam alto para não colidir com os do `IpcKeystoreOracle`, que
// compartilha a mesma porta IPC-M com protocolo próprio (`{a, id}`).
let proximoIdM = 10_000_000;
const pendentesIpcM = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>();

/** Raiz do build ESM do core — relativa ao __dirname deste arquivo em dev e empacotado. */
function caminhoCoreDist(): string {
  const temBoot = (raiz: string): boolean =>
    fs.existsSync(path.join(raiz, 'composition/boot.js')) || fs.existsSync(path.join(raiz, 'src/composition/boot.js'));
  const override = process.env.P2P_CORE_DIST;
  if (override !== undefined && temBoot(override)) return override;
  const candidatos = [
    path.resolve(__dirname, '../../../core/dist/src'), // tsc com rootDir src
    path.resolve(__dirname, '../../../core/dist'),
    path.resolve(__dirname, '../core'), // empacotado (electron-builder): montado em dist/core
  ];
  for (const c of candidatos) {
    if (temBoot(c)) return c;
  }
  throw Object.assign(new Error(`build do core não encontrado (${candidatos.join(', ')})`), { code: 'E_BOOT' });
}

async function loadCore(): Promise<Record<string, unknown>> {
  const raiz = caminhoCoreDist();
  const sub = fs.existsSync(path.join(raiz, 'composition/boot.js')) ? '' : 'src/';
  const [boot, ipcMain, keystoreMod, identidadeMod, manifestMod, viewMod, swarmMod, hyperswarmMod, transporteMod, wipeMod, identityL0Mod, corestoreMod] = await Promise.all([
    import(path.join(raiz, `${sub}composition/boot.js`)),
    import(path.join(raiz, `${sub}l3/ipcMain/index.js`)),
    import(path.join(raiz, `${sub}l0/keystore/index.js`)),
    import(path.join(raiz, `${sub}composition/identity.js`)),
    import(path.join(raiz, `${sub}l0/manifest/index.js`)),
    import(path.join(raiz, `${sub}l0/view/index.js`)),
    import(path.join(raiz, `${sub}l0/swarm/index.js`)),
    import(path.join(raiz, `${sub}l0/swarm/hyperswarm.js`)),
    import(path.join(raiz, `${sub}composition/transport.js`)),
    import(path.join(raiz, `${sub}composition/wipe.js`)),
    import(path.join(raiz, `${sub}l0/identity/index.js`)),
    // §5.2/§17.3 — a derivação de 'ns/hostturn/1' é do núcleo (o node:crypto do Electron
    // não tem blake2b512; achado do smoke de §59).
    import(path.join(raiz, `${sub}l0/corestore/index.js`)),
  ]);
  return {
    ...(boot as object),
    ...(ipcMain as object),
    ...(keystoreMod as object),
    ...(identidadeMod as object),
    ...(manifestMod as object),
    ...(viewMod as object),
    ...(swarmMod as object),
    ...(hyperswarmMod as object),
    ...(transporteMod as object),
    ...(wipeMod as object),
    ...(identityL0Mod as object),
    ...(corestoreMod as object),
  };
}

/** Adapta a `MessagePortMain` recebida do main à forma que o core espera. */
function adaptar(porta: Electron.MessagePortMain): PortaMensagem {
  return {
    postMessage: (msg) => porta.postMessage(msg),
    onMessage: (listener) => {
      porta.on('message', (e: Electron.MessageEvent) => listener(e.data));
    },
    start: () => porta.start(),
  };
}

/** Pedido ao main pela fronteira IPC-M — caminhos, diálogos e tokens nunca vêm do renderer. */
function perguntarAoMain<I>(q: string, dados: Record<string, unknown> = {}): Promise<I> {
  if (portaM === null) return Promise.reject(Object.assign(new Error('IPC-M fechado'), { code: 'E_NO_PORT' }));
  const id = proximoIdM++;
  return new Promise<I>((resolve, reject) => {
    const t = setTimeout(() => {
      if (pendentesIpcM.delete(id)) reject(Object.assign(new Error('timeout no IPC-M'), { code: 'E_TIMEOUT' }));
    }, 60_000);
    pendentesIpcM.set(id, {
      resolve: ((v: unknown) => {
        clearTimeout(t);
        (resolve as (v: unknown) => void)(v);
      }) as (v: never) => void,
      reject: (e: Error) => {
        clearTimeout(t);
        reject(e);
      },
    });
    portaM!.postMessage({ q, id, ...dados });
  });
}

function log(msg: string): void {
  process.stdout.write(`[nucleo] ${msg}\n`);
}

/**
 * `P2P_DHT_BOOTSTRAP="host:port[,host:port]"` — bootstrap DHT explícito (rede local de
 * teste). Ausente, o Hyperswarm usa os servidores públicos de §14.1.
 */
function bootstrapDoAmbiente(): Array<{ host: string; port: number }> | undefined {
  const bruto = process.env.P2P_DHT_BOOTSTRAP;
  if (bruto === undefined || bruto.trim() === '') return undefined;
  const lista = bruto
    .split(',')
    .map((parte) => parte.trim())
    .filter(Boolean)
    .map((parte) => {
      const i = parte.lastIndexOf(':');
      return { host: parte.slice(0, i), port: Number(parte.slice(i + 1)) };
    })
    .filter((b) => b.host !== '' && Number.isInteger(b.port) && b.port > 0 && b.port < 65536);
  return lista.length > 0 ? lista : undefined;
}

// ─── O boot de verdade (§3.3) ─────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  const core = await loadCore();
  const userData = process.env.P2P_DATA_DIR ?? path.join(process.cwd(), '.p2p-data');
  const dataDir = path.join(userData, 'p2p');
  fs.mkdirSync(dataDir, { recursive: true });

  // §10.8 etapa 2 — flock real em `<dataDir>/LOCK`; segunda instância recusa aqui.
  const ProcessLockCtor = core.ProcessLock as new (dir: string) => { acquire(): void; release(): void };
  const lock = new ProcessLockCtor(dataDir);
  try {
    lock.acquire();
  } catch (err) {
    const e = err as { code?: string; pid?: number; message?: string };
    process.parentPort?.postMessage({ e: 'blocked', code: e.code ?? 'E_CORE_ALREADY_RUNNING', message: e.message });
    process.exit(3);
  }
  liberarLock = () => lock.release();

  // Bancos abertos DEPOIS do wipe-resume (§18.6: retoma antes de qualquer outra coisa).
  const ManifestDbCtor = core.ManifestDb as new (p: string) => object;
  const manifestPath = path.join(dataDir, 'manifest.db');
  const manifestoAberto = (): object | null => {
    try {
      return new ManifestDbCtor(manifestPath);
    } catch {
      return null;
    }
  };
  const ViewFactory = core.openViewDb as (p: string) => object;
  const viewAberta = (): object | null => {
    try {
      return ViewFactory(path.join(dataDir, 'view.db'));
    } catch {
      return null;
    }
  };

  const resumePendingWipe = core.resumePendingWipe as (deps: Record<string, unknown>) => Promise<boolean>;
  const swarm = new (core.Swarm as new () => unknown)();

  // §18.6 emendado — **sem `releaseLock` aqui.** A retomada acontece no meio do boot e o
  // processo CONTINUA: logo abaixo ele abre `manifest.db`, `view.db` e os cores de uma
  // instalação zerada, e §10.8 exige a etapa (2) em mãos antes da etapa (4). Passar a porta
  // de liberação fazia o núcleo rodar a sessão inteira sem exclusão nenhuma, porque nada
  // readquiria o lock depois. Quem libera é o `drenarESair`, no fim.
  const houveLimpeza = await resumePendingWipe({
    dataDir,
    swarm,
    openManifest: manifestoAberto,
    openView: viewAberta,
    wipeIdentity: () => {
      // Material legado fora do manifest (fase 1 gravava arquivos soltos).
      for (const nome of ['identity.enc', 'datakey.wrapped', 'identity.meta.json']) {
        try {
          fs.rmSync(path.join(dataDir, nome), { force: true });
        } catch {}
      }
    },
  });
  if (houveLimpeza) log('wipe-resume concluído — instalação zerada');

  const manifest = manifestoAberto() as {
    getSecret(name: string): { ciphertext: Buffer } | null;
  } & Record<string, unknown>;
  const view = viewAberta() as object;

  // §5.4 — a Data Key: unwrap da cópia embrulhada pelo main; primeira instalação gera
  // (e o `identity.create` persiste a cópia embrulhada em manifest.secrets).
  // A13(5)/L-2 — o cofre é composto ANTES de tudo que wrapa/unwrapa: se o main não consegue
  // cifrar (basic_text no Electron 43), o modo explícito da L-2 assume e o oráculo de
  // obfuscação local passa a responder por identidade e data key.
  const IpcKeystoreOracleCtor = core.IpcKeystoreOracle as new (porta: PortaMensagem) => unknown;
  const oracle = new IpcKeystoreOracleCtor(portaM as PortaMensagem);
  type Cofre = {
    oracle: { wrapDataKey(b64: string): Promise<string>; unwrapDataKey(w: string): Promise<string> };
    keystore: unknown;
    modo: 'secure' | 'insecure-fallback';
  };
  const ComporCofre = core.composeKeystore as (o: unknown) => Promise<Cofre>;
  // Silêncio persistente do main é `E_KEYSTORE_UNAVAILABLE` e derruba o boot com nome
  // próprio (§3.2 L-2 emendado, regra 1) — não vira modo inseguro permanente por acidente.
  const cofre = await ComporCofre(oracle);
  log(`cofre composto em modo ${cofre.modo}`);

  const Conciliar = core.conciliarModoKeystore as (a: {
    manifest: unknown;
    modoAtual: 'secure' | 'insecure-fallback';
    oracleAtual: unknown;
    wrapped: string | null;
    log?: (m: string) => void;
  }) => Promise<string | null>;

  // §3.2 L-2 emendado — a conciliação de modo vem ANTES do `load()`: é ela que reembrulha a
  // Data Key quando o chaveiro apareceu (regra 2) e que recusa o caminho contrário (regra
  // 3). Sem isso, o `load()` tentaria abrir com o oráculo novo um `data_key` selado pelo
  // antigo, falharia em silêncio e a instalação apareceria como "sem identidade".
  const wrappedGravado = manifest.getSecret('data_key')?.ciphertext.toString('utf8').trim() ?? null;
  await Conciliar({
    manifest,
    modoAtual: cofre.modo,
    oracleAtual: cofre.oracle,
    wrapped: wrappedGravado,
    log,
  });

  const IdentityManagerCtor = core.IdentityManager as new (dir: string, oracle: unknown, m: object) => {
    load(): Promise<boolean>;
    getKeyPair(): { publicKey: Buffer; secretKey: Buffer } | null;
    record: { presence?: string } | null;
  };
  const manager = new IdentityManagerCtor(dataDir, cofre.oracle, manifest);
  const carregada = await manager.load();
  log(carregada ? 'identidade carregada' : 'sem identidade — awaiting-identity');

  // §5.4 — UMA Data Key por instalação, e a leitura vem **depois** do `load()`: uma
  // instalação no formato antigo (`identity.enc`/`datakey.wrapped` soltos) grava
  // `secrets.data_key` durante o carregamento, com a mesma chave que abriu a semente. Ler
  // antes disso não achava linha nenhuma e sorteava uma Data Key nova, enquanto
  // `communities.community_seed_enc` seguia selado pela original — o host não derivava a
  // própria chave de escrita.
  const wrapped = manifest.getSecret('data_key')?.ciphertext.toString('utf8').trim() ?? null;
  const dataKeyB64 =
    wrapped !== null && wrapped.length > 0
      ? await cofre.oracle.unwrapDataKey(wrapped)
      : crypto.randomBytes(32).toString('base64');
  const dataKey = Buffer.from(dataKeyB64, 'base64');

  /**
   * §14.1/§14.3 — a rede de verdade. O backend nasce sobre o PAR DA IDENTIDADE (é por
   * `remotePublicKey` que o outro lado autoriza o canal), então não há rede antes dela:
   * sem identidade o swarm fica em modo memória e `ligarRede()` anexa o backend quando o
   * par aparece. O transporte de §16.1 (`startCommunityTransport`) se registra sozinho no
   * runtime — é dele que saem os canais de replicação e de admissão (`p2p-admission/1`).
   */
  const bootstrapDaRede = bootstrapDoAmbiente();
  let backendSwarm: { destroy(): Promise<void> } | null = null;
  const ligarBackendAoSwarm = (par: { publicKey: Buffer; secretKey: Buffer }): void => {
    if (backendSwarm !== null) return;
    const BackendCtor = core.HyperswarmBackend as new (o?: unknown) => { destroy(): Promise<void> };
    // §14.3(4) — o firewall de conexão sobre as DUAS metades, ambas lidas do runtime
    // na hora da conexão (o boot ainda não terminou quando o backend nasce): "em
    // comum" são as comunidades abertas aqui cujo DS conhece o par como membro, e
    // `bannedIn` é o estado do próprio fold. A regra que combina as duas é a pura
    // `firewallShouldRejectConnection`, dentro do backend; §14.3(5) — convite ativo
    // hospedado — faz o firewall ceder, e quem assina isso é o serviço de admissão.
    const runtimeRede = (): {
      communities(): ReadonlyArray<{ communityId: string; projector: { ds: { community: { exists: boolean }; members: Map<string, { state: string }> } } }>;
      get(communityId: string): unknown;
    } | null => runtime as never;
    backendSwarm = new BackendCtor({
      ...(bootstrapDaRede !== undefined ? { bootstrap: bootstrapDaRede } : {}),
      keyPair: par,
      firewall: {
        commonCommunityIds: (peerKeyHex: string): readonly string[] => {
          const rt = runtimeRede();
          if (rt === null) return [];
          return rt
            .communities()
            .filter((c) => c.projector.ds.community.exists && c.projector.ds.members.get(peerKeyHex) !== undefined)
            .map((c) => c.communityId);
        },
        bannedIn: (peerKeyHex: string, communityId: string): boolean => {
          const rt = runtimeRede();
          if (rt === null) return false;
          const c = rt.get(communityId) as { projector: { ds: { members: Map<string, { state: string }> } } } | undefined;
          return c !== undefined && c.projector.ds.members.get(peerKeyHex)?.state === 'banned';
        },
      },
    });
    (swarm as { attachBackend(b: unknown): void }).attachBackend(backendSwarm);
  };
  if (manager.getKeyPair() !== null) ligarBackendAoSwarm(manager.getKeyPair()!);

  // §15.3 — o token de confirmação nativa nasce AQUI (consumo síncrono no roteador);
  // o main pede a emissão depois do diálogo nativo e devolve ao renderer.
  authTokenStore = new (core.AuthTokenStore as new () => { issue(cmd: string, escopo: string | null): string })();
  comandoConfirmado = core.comandoConfirmado as (cmd: string) => unknown | null;
  canonicalizarEscopo = core.canonicalizarEscopo as (v: unknown) => string | null;

  const bootCoreFn = core.bootCore as (deps: Record<string, unknown>) => Promise<object>;
  runtime = (await bootCoreFn({
    dataDir,
    manifest,
    view,
    swarm,
    dataKey,
    identity: () => manager.getKeyPair(),
    identityManager: manager,
    // §12.4 — perfil local que alimenta displayName/avatarColor do resgate quando o
    // comando não os traz (a coluna opcional de §15.4 existe por causa disso).
    identityProfile: () => {
      const rec = (manager as { record: { displayName: string; avatarColor: number } | null }).record;
      return rec === null ? null : { displayName: rec.displayName, avatarColor: rec.avatarColor };
    },
    foldBuildId: process.env.P2P_BUILD_ID ?? 'comunidade-app',
    ipcPort: portaR as PortaMensagem,
    epoch,
    tokenVerifier: {
      consume(token: string, cmd: string, escopo: string | null): boolean {
        // Mesmo critério do AuthTokenStore, sobre a instância única deste processo. O
        // `escopo` chega derivado do argumento real do quadro (§15.3 emendado).
        return (
          authTokenStore !== null &&
          (authTokenStore as unknown as { consume(t: string, c: string, e: string | null): boolean }).consume(
            token,
            cmd,
            escopo,
          ) === true
        );
      },
    },
    // §17.3 — segredo do serviço TURN desta instalação, derivado por namespace de §5.2
    // (emenda de 2026-08-23: 'ns/hostturn/1' ‖ dataKey ‖ communityId). A derivação é do
    // núcleo (BLAKE2b via sodium): o `node:crypto` do Electron não tem blake2b512 e a
    // criação de comunidade morria em E_INTERNAL (achado do smoke de §59). Nunca sai do
    // processo.
    hostTurnSecret: (communityId: string) =>
      (core.hostTurnSecretFrom as (d: Buffer, c: string) => Buffer)(dataKey, communityId),
    keystore: cofre.keystore,
    pickFile: async (communityId: string) => {
      try {
        return await perguntarAoMain<{ path: string; sizeBytes: number } | null>('dialogOpenAttachment', { communityId });
      } catch {
        return null;
      }
    },
    onReveal: (a: { path: string; mode: 'open' | 'folder' }) => {
      void perguntarAoMain<unknown>('shell.reveal', { ...a });
    },
    saveFile: async (a: { suggestedName: string; data: Buffer }) =>
      await perguntarAoMain<null>('file.save', { suggestedName: a.suggestedName, dataB64: a.data.toString('base64') }).then(
        () => ({ ok: true as const }),
        (err: { code?: string }) => ({ ok: false as const, code: err.code ?? 'E_CANCELLED' }),
      ),
    readFile: async () => {
      try {
        const b64 = await perguntarAoMain<string>('file.read', {});
        return Buffer.from(b64, 'base64');
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'E_CANCELLED') return null;
        return null;
      }
    },
    lock: { release: () => lock.release() },
    exit: () => process.exit(0),
    buildChannel: process.env.P2P_BUILD_CHANNEL === 'dev' ? 'dev' : 'prod',
  })) as typeof runtime;

  // Rede: anexa agora se já há identidade; senão, observa a chegada dela (identity.create
  // acontece dentro do núcleo, sem retorno para este processo) e anexa na hora.
  let transporteRede: { stop(): Promise<void> } | null = null;
  let vigiaIdentidade: ReturnType<typeof setInterval> | null = null;
  const ligarRede = (): boolean => {
    if (transporteRede !== null) return true;
    const par = manager.getKeyPair();
    if (par === null) return false;
    ligarBackendAoSwarm(par);
    const StartTransporte = core.startCommunityTransport as (d: Record<string, unknown>) => { stop(): Promise<void> };
    transporteRede = StartTransporte({ runtime, swarm });
    log('rede P2P anexada ao runtime');
    return true;
  };
  if (!ligarRede()) {
    vigiaIdentidade = setInterval(() => {
      if (ligarRede() && vigiaIdentidade !== null) {
        clearInterval(vigiaIdentidade);
        vigiaIdentidade = null;
      }
    }, 1_000);
  }
  pararRede = async () => {
    if (vigiaIdentidade !== null) {
      clearInterval(vigiaIdentidade);
      vigiaIdentidade = null;
    }
    await transporteRede?.stop().catch(() => {});
  };

  process.parentPort?.postMessage({ e: 'ready', phase: (runtime as { phase: string }).phase, epoch });
}

function bootQuandoPronto(): void {
  if (booted || iniciando || portaM === null || portaR === null) return;
  iniciando = true;
  boot()
    .then(() => {
      booted = true;
    })
    .catch((err: { code?: string; message?: string }) => {
      log(`boot falhou: ${err.code ?? ''} ${err.message ?? ''}`);
      process.parentPort?.postMessage({ e: 'blocked', code: err.code ?? 'E_BOOT', message: err.message ?? '' });
      process.exit(1);
    });
}

// ── Mensagens do pai: as duas portas, deep link e o draining do quit (§3.3) ────────────

process.parentPort?.on('message', (e) => {
  const data = (e as unknown as { data: MensagemPai }).data;
  const ports = (e as unknown as { ports?: Electron.MessagePortMain[] }).ports ?? [];

  if (data.kind === 'ipc-m-port' && ports[0] !== undefined) {
    portaM = adaptar(ports[0]);
    portaM.onMessage((raw) => {
      // §15.3 — a emissão do token é pedida NESTA porta ("emitido pelo main via IPC-M") e
      // respondida nela; o token nasce no AuthTokenStore e o roteador o consome uma única
      // vez. O parentPort não vê tráfego de MessagePort — este ramo não pode viver lá.
      const pedido = raw as { kind?: string; cmd?: unknown; escopoBruto?: unknown; id?: number };
      if (pedido.kind === 'issueToken') {
        const store = authTokenStore;
        if (store === null || pedido.id === undefined || typeof pedido.cmd !== 'string') {
          portaM!.postMessage({ a: 'issueToken', id: pedido.id, ok: false, code: 'E_BUSY' });
        } else if (comandoConfirmado === null || comandoConfirmado(pedido.cmd) === null) {
          // §15.3 emendado, regra 2 — o token só nasce para comando da tabela. Emitir para
          // nome arbitrário faria do `AuthTokenStore` um oráculo de assinatura para
          // qualquer comando que um dia entre na classe.
          log(`issueToken RECUSADO: ${pedido.cmd} não é comando main-confirmed`);
          portaM!.postMessage({ a: 'issueToken', id: pedido.id, ok: false, code: 'E_UNKNOWN_COMMAND' });
        } else {
          // §15.3 emendado, regra 3 — o token liga-se a `(cmd, escopo)`. O main manda o
          // valor BRUTO do campo declarado; a forma canônica sai da mesma função que o
          // roteador usa ao consumir, para não haver duas implementações que possam
          // divergir. O que o renderer declarou é só uma declaração: quem confere é o
          // roteador, contra o argumento REAL do quadro.
          const escopo = canonicalizarEscopo === null ? null : canonicalizarEscopo(pedido.escopoBruto);
          portaM!.postMessage({
            a: 'issueToken',
            id: pedido.id,
            ok: true,
            token: store.issue(pedido.cmd, escopo),
          });
        }
        return;
      }
      const m = raw as { id?: number; ok?: boolean; data?: unknown; code?: string };
      if (typeof m.id !== 'number') return;
      const p = pendentesIpcM.get(m.id);
      if (p === undefined) return;
      pendentesIpcM.delete(m.id);
      if (m.ok === false) p.reject(Object.assign(new Error(m.code ?? 'E_MAIN'), { code: m.code }));
      else p.resolve(m.data as never);
    });
    portaM.start();
    bootQuandoPronto();
    return;
  }
  if (data.kind === 'ipc-r-port' && ports[0] !== undefined) {
    if (typeof data.epoch === 'number') epoch = data.epoch;
    portaR = adaptar(ports[0]);
    portaR.start();
    log(`porta IPC-R anexada (epoch ${epoch}) — iniciando o boot`);
    bootQuandoPronto();
    return;
  }
  // **Não há ramo de `deeplink` aqui, e a emenda de 2026-09-05 em §3.5(2) diz por quê.**
  // O destino do dado estruturado é o RENDERER: a regra 3 manda o link só posicionar a UI
  // numa confirmação, e a prévia que ela mostra é `invite.resolve` /
  // `query.resolveMessageLink` pela IPC-R — comandos que o núcleo já atende. Um segundo
  // caminho pela IPC-M não tinha consumidor: o ramo que existia aqui só logava e voltava,
  // e o `postMessage` do main o alimentava, então §3.5(2) era escrita sem efeito nas duas
  // pontas. Quem precisa saber do link é quem o transforma em tela.
  if (data.kind === 'capture.authorize' && portaM !== null) {
    // §15.7 `capture.authorize` → `capture.decision`, e §17.4 emendado: quem cunhou o
    // `captureToken` é o núcleo do apresentador e quem o verifica é ele mesmo. Falha
    // fechada — núcleo ainda subindo, ou sessão que não existe aqui, não concede captura.
    const sessionId = String((data as { sessionId?: unknown }).sessionId ?? '');
    const kindBruto = (data as { captureKind?: unknown }).captureKind;
    const kind = kindBruto === 'music' ? 'music' as const : 'screen' as const;
    const audio = (data as { captureAudio?: unknown }).captureAudio === true;
    const decisao = runtime?.authorizeCapture({ sessionId, kind, audio }) ?? { allowed: false, reason: 'gone', sourceTypes: [], audio: false };
    // O som aparece no log porque capturar o áudio de uma máquina é o tipo de coisa que
    // precisa deixar rastro do lado que autoriza, e não só do lado que pede.
    log(
      `capture.authorize sessão ${sessionId.slice(0, 8)} · som ${audio ? 'pedido' : 'não'} → ` +
        `${decisao.allowed ? `concedida (som ${decisao.audio ? 'sim' : 'não'})` : `RECUSADA (${decisao.reason ?? '?'})`}`,
    );
    portaM.postMessage({ a: 'capture.decision', sessionId, allowed: decisao.allowed, sourceTypes: decisao.sourceTypes, audio: decisao.audio });
    return;
  }
  if (data.kind === 'shutdown') {
    void drenarESair();
  }
});

/**
 * O dreno inteiro tem orçamento, e o orçamento é menor que a rede de segurança do main
 * (8 s). Sem ele, um `stop()` de transporte que não resolve — host com conexões abertas é
 * justamente o caso — deixava `finally` inalcançável: o lock não era liberado e o
 * `process.exit(0)` não acontecia. O main matava o processo de qualquer forma, mas por
 * cima, sem snapshot e sem soltar o lock pelo caminho limpo. Perder o dreno é aceitável;
 * perder o desligamento não é.
 */
const ORCAMENTO_DE_DRENO_MS = 5_000;

function comPrazo<T>(promessa: Promise<T> | undefined, ms: number, oQue: string): Promise<T | null> {
  if (promessa === undefined) return Promise.resolve(null);
  return Promise.race([
    promessa,
    new Promise<null>((resolve) =>
      setTimeout(() => {
        log(`${oQue} não respondeu em ${ms} ms — seguindo para o encerramento`);
        resolve(null);
      }, ms).unref(),
    ),
  ]);
}

/**
 * **A rede sai por último, e isso é §18.7 passo 2, não estilo.**
 *
 * A ordem anterior era `pararRede()` → `runtime.shutdown()`, e ela tornava o dreno
 * impossível de cumprir: `stop()` do transporte fecha os canais, esquece os muxes e chama
 * `backend.destroy()`, então quando o `shutdown` chegava não havia par nenhum. A barreira
 * de §18.7 conta **pares que confirmaram a cabeça** (`replicationConfirmations`, que lê o
 * bitfield por par do replicador) e o `outbox.flush()` do primeiro giro precisa de canal
 * vivo: sem rede, a contagem é fixa em zero, o alvo `min(3, memberCount − 1)` nunca é
 * alcançado, e a espera consumia o orçamento inteiro para devolver `replicatedTo = 0`
 * — o host saía do swarm ANTES de replicar, que é exatamente o que o passo 2 proíbe
 * ("o host permanece no swarm até que … pares confirmem").
 *
 * Invertido, cada etapa fica com o que precisa: o `shutdown` corre com a rede de pé e
 * devolve um `replicatedTo` que quer dizer alguma coisa; a parada do transporte vem depois,
 * com o resto do orçamento, e o `finally` continua garantindo lock solto e saída.
 */
async function drenarESair(): Promise<void> {
  if (drenando) return;
  drenando = true;
  const t0 = Date.now();
  const sobra = (): number => Math.max(500, ORCAMENTO_DE_DRENO_MS - (Date.now() - t0));
  try {
    if (runtime !== null) {
      const orcamento = sobra();
      const resumo = await comPrazo(runtime.shutdown({ budgetMs: orcamento }), orcamento, 'dreno do núcleo');
      if (resumo !== null) {
        log(
          `draining: ${resumo.pendingOps} op(s) pendente(s), ${resumo.replicatedTo} par(es) com a cabeça,` +
            ` ${resumo.drainedMs} ms`,
        );
      }
      await comPrazo(pararRede?.(), sobra(), 'parada da rede');
      process.parentPort?.postMessage({ e: 'drained', summary: resumo });
    } else {
      await comPrazo(pararRede?.(), sobra(), 'parada da rede');
      process.parentPort?.postMessage({ e: 'drained', summary: null });
    }
  } catch (err) {
    log(`draining falhou: ${(err as Error).message}`);
    process.parentPort?.postMessage({ e: 'drained', summary: null });
  } finally {
    liberarLock?.();
    process.exit(0);
  }
}

process.on('uncaughtException', (err) => {
  log(`uncaughtException: ${err.message}`);
  process.parentPort?.postMessage({ e: 'crashed', message: err.message });
  process.exit(1);
});
