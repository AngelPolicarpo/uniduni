// A montagem do subsistema de conversa direta (§31) — raiz de composição (§4).
//
// Quatro peças existem e nenhuma se conhece, por desenho: `dmCodec`/`dmFold` (L1) não fazem
// I/O; `dmProjector` (L1→L0) é o **único** escritor de `view.db` e não decide nada;
// `directMessages` (L2) é a política e não importa transporte nem codec; `composition/dm.ts`
// é o fio. Este arquivo é o que as liga, e é o único lugar onde a chave secreta de identidade
// e a `dmContentKey` coexistem com o resto.
//
// O que ele decide, e por quê:
//
//   §31.3   a `dmContentKey` é derivada **aqui** e não sai daqui. Ela entra no `DmContext` do
//           projetor e no escritor; nenhuma porta de `directMessages` a carrega, e ela nunca
//           cruza o IPC-R (§3.2 item 5, sem exceção).
//   §31.10  escrever é `core.append` no próprio core, com a barreira do `self_high_water`
//           **antes** — que é de `directMessages` (§103). Aqui só se constrói o registro.
//   §10.5   a segunda metade da barreira: `dm_local_read_state` recomputado no boot e
//           `dm.unreadChanged` depois do commit. §4 não dá `manifest` ao `dmProjector` nem
//           `view` a `directMessages`, então o cruzamento das duas é de quem compõe o boot —
//           exatamente como já acontece com o `local_read_state` da comunidade.
//   §31.16.2 os doze eventos saem por um `onEvent` só, e é o `EventFanout` que os roteia.

import sodium from 'sodium-native';

import { computeHandle } from '../l0/identity/index.ts';

import {
  deriveDmBlobsKeyPair,
  openCore,
  openWritableCore,
  type CoreHandle,
  type WritableCoreHandle,
} from '../l0/corestore/index.ts';
import type { ManifestDb } from '../l0/manifest/index.ts';
import type { Swarm } from '../l0/swarm/index.ts';
import type { ViewDb } from '../l0/view/index.ts';
import {
  DM_KINDS,
  DM_VERSION,
  dmContentKey,
  dmConversationKey,
  dmCorePossessionHash,
  dmOpSigningHash,
  encodeDmEnvelope,
  encodeDmOp,
  encodeDmPayload,
  sealDmPayload,
  type DmHeader,
  type DmKindName,
  type DmPayloadOf,
} from '../l1/dmCodec/index.ts';
import { ordSumOf, type DmOrigin, type DmState } from '../l1/dmFold/index.ts';
import { DmProjector, type DmProjectedEvent } from '../l1/dmProjector/index.ts';
import { dmEntityId } from '../l1/idgen/index.ts';
import { DirectMessages, type DmEvent, type DmSyncState } from '../l2/directMessages/index.ts';
import { startDmTransport, type DmTransport } from './dm.ts';
import { dmQueryPorts, type DmQueryPorts } from './dmQueries.ts';
import { aeadSealPacked } from './community.ts';

/** O recorte do `attachment` de §31.5 que a guarda de RD-11 e a de §13.7 precisam ver. */
type DmAnexoDoPayload = {
  readonly blob?: { readonly blobsCoreKey?: Buffer };
  readonly hash: Buffer;
};

function recusar(code: string, extra: Record<string, unknown> = {}): never {
  throw Object.assign(new Error(code), { code, ...extra });
}

export type DmRuntimeDeps = {
  readonly manifest: ManifestDb;
  readonly view: ViewDb;
  readonly swarm: Swarm;
  /** §5.1 — a identidade local. `null` enquanto o núcleo está em `awaiting-identity`. */
  identity(): { readonly publicKey: Buffer; readonly secretKey: Buffer } | null;
  /** §5.4 — a Data Key, para cifrar o atalho `self_core_seed_enc` de §31.12. */
  readonly dataKey: Buffer;
  /** Diretório dos cores desta instalação (§10.1). */
  readonly coresDir: string;
  /** §10.6 — hash do binário do `dmFold`, o mesmo `foldBuildId` do resto do boot. */
  readonly foldBuildId: string;
  /** §31.16.2 — a saída única dos doze eventos. */
  onEvent(topic: string, data: Readonly<Record<string, unknown>>): void;
  /**
   * §31.5 — o perfil que vai no `dm.hello` de gênese. §31.7.5 exige `displayName` de **2 a
   * 32 code points**: um nome vazio faz o `dmFold` recusar a gênese com `E_VALIDATION`, e RD-1
   * marca aquele lado **inteiro** como `invalid` — a conversa nasce morta. O default é o
   * `handle` de §6.1, que é derivado da chave e nunca é vazio.
   */
  perfil?(): { readonly displayName: string; readonly avatarColor: number };
  /** §31.9 regra 5 — tem comunidade em comum com este par? */
  compartilhaComunidade?(peerKey: Buffer): boolean;
  now?(): number;
  /** §27.2 `P2P_REMOVED_RETENTION_DAYS`. */
  retentionDays?: number;
  /**
   * §31.14 — o core de **blobs** desta conversa, anexado ao `BlobManager` de §13.
   *
   * A porta existe porque §4 não deixa `dmRuntime` conhecer `blobs` (L2) nem o
   * `corestore` de blobs: quem liga os dois é quem compõe o boot. A `seed` que atravessa é
   * a de §31.3 derivada aqui — ela é material de identidade, e derivá-la fora seria dar o
   * `identitySeed` a mais um módulo.
   *
   * Ausente = conversa sem anexos (o rig de teste dos cabos, e o caminho de `pending-in`,
   * que não tem core nenhum). Nesse caso `dm.send` com anexo recusa em vez de escrever um
   * `blobsCoreKey` que ninguém serve.
   */
  blobs?: {
    /** Abre/anexa o core de blobs local desta conversa e devolve a chave pública dele. */
    anexar(conversationId: string, seed: Buffer): Promise<Buffer>;
    /** §31.19 — `dm.forget` e `close()`: solta o core e sai do tópico de §13.4. */
    soltar(conversationId: string): Promise<void>;
    /**
     * §13.7 regra 1 — este núcleo escreveu mesmo este blob? `dm.send` recebe o `attachment`
     * completo no argumento (§31.16.1), diferente de `message.send`, que manda só o
     * `ticketId`; a regra é a mesma nos dois, e sem este confronto o renderer poderia
     * apontar a mensagem para bytes que ninguém staged.
     */
    foiStaged(a: {
      readonly blobsCoreKey: Buffer;
      readonly blobIdHex: string;
      readonly hash: Buffer;
    }): boolean;
    /**
     * §31.16.3 — o estado de download deste blob (`local_blob_cache`, §13.4), para o
     * `AttachmentDto` que a query devolve. §31.14 reutiliza os oito estados de cache sem
     * alteração; a query da DM precisava lê-los, e não lia.
     */
    cache?(blobsCoreKey: Buffer, blobIdHex: string): {
      readonly state: string;
      readonly bytesDownloaded: number;
      readonly path: string | null;
    } | null;
  };
  /** Injetável para teste: sem isto, cores de verdade em disco. */
  abrirCore?(a: {
    readonly conversationId: string;
    readonly own: boolean;
    readonly keyPair?: { readonly publicKey: Buffer; readonly secretKey: Buffer };
    readonly coreKey?: Buffer;
  }): Promise<CoreHandle>;
};

/** Estado vivo por conversa que não mora em banco nenhum. */
type Vivo = {
  projetor: DmProjector;
  /** `'lo'` quando a minha chave de identidade é a menor das duas (§31.2). */
  readonly meuLado: DmOrigin;
  readonly contentKey: Buffer;
};

export type DmRuntime = {
  readonly dm: DirectMessages;
  readonly transport: DmTransport;
  readonly queries: DmQueryPorts;
  /** §31.10 — a terceira classe de escrita: síncrona, com o registro **já no log**. */
  escrever<K extends DmKindName>(
    conversationId: string,
    kind: K,
    payload: DmPayloadOf<K>,
  ): Promise<{ readonly messageId: string; readonly ordSum: number }>;
  /** `dm.markRead` (§31.16.1) — zera a contagem por watermark (A28). */
  markRead(conversationId: string): { readonly unreadCount: 0 };
  /** `dm.activate` (§31.16.1) — a conversa em foco; governa a residência do projetor. */
  activate(conversationId: string | null): { readonly residency: 'active' | 'background' };
  /**
   * §31.14 / RD-11 — o core de blobs **local** desta conversa. É o que `blob.stage` grava e
   * o que a guarda de RD-11 confere antes de deixar um anexo entrar no log.
   */
  blobsCoreKeyOf(conversationId: string): Buffer | null;
  boot(): Promise<void>;
  close(): Promise<void>;
};

export async function criarDmRuntime(deps: DmRuntimeDeps): Promise<DmRuntime> {
  const now = deps.now ?? Date.now;
  const vivos = new Map<string, Vivo>();
  /** §31.16.1 `dm.activate` — a conversa em foco. `null` = nenhuma, tudo em background. */
  let ativa: string | null = null;

  const eu = (): { publicKey: Buffer; secretKey: Buffer } => {
    const i = deps.identity();
    if (i === null) recusar('E_UNKNOWN_COMMAND');
    return i;
  };

  // ── §31.3 — a derivação que não sai daqui ──────────────────────────────────────────

  const chaveDeConteudo = (conversationKey: Buffer, peerKey: Buffer): Buffer => {
    const k = dmContentKey(eu().secretKey, peerKey, conversationKey);
    if (k === null) recusar('E_INTERNAL');
    return k;
  };

  /** O perfil local, com o piso de §31.7.5 garantido. */
  const perfil = (): { displayName: string; avatarColor: number } => {
    const p = deps.perfil?.();
    const nome = p?.displayName ?? '';
    return {
      displayName: nome.trim().length >= 2 ? nome : computeHandle(eu().publicKey),
      avatarColor: p?.avatarColor ?? 0,
    };
  };

  const assinar = (digest: Buffer): Buffer => {
    const sig = Buffer.alloc(sodium.crypto_sign_BYTES);
    sodium.crypto_sign_detached(sig, digest, eu().secretKey);
    return sig;
  };

  // ── Cores ──────────────────────────────────────────────────────────────────────────
  //
  // §5.3 — `corestore` com chave explícita, nunca namespace aleatório. O caminho é derivado
  // do `conversationId` e do lado, e não do que o par disser.

  const caminho = (conversationId: string, lado: 'self' | 'peer'): string =>
    `${deps.coresDir}/dm/${conversationId}/${lado}`;

  /**
   * Cabos abertos, por `(conversa, lado)`. **Um core por caminho de armazenamento, sempre.**
   *
   * `directMessages` remonta a conversa a cada transição de estado (aceite, desbloqueio,
   * vínculo de core), e cada remontagem repede os dois cabos. Sem esta memória, o segundo
   * pedido abriria o **mesmo diretório** com o primeiro ainda aberto — que o hypercore recusa,
   * e que apareceria como `E_INTERNAL` no aceite. Quem tem o ciclo de vida do core é a
   * composição (§4); é aqui que ele mora.
   *
   * O que o mapa guarda é a **promessa**, não o cabo pronto, e isso é a parte que importa.
   * As remontagens não são sequenciais: o aceite vem do IPC-R e o vínculo de `peerCoreKey`
   * vem do handshake do fio, e as duas chegam por caminhos assíncronos independentes. Com o
   * cabo gravado só **depois** do `await`, as duas atravessam a janela entre o pedido e a
   * resposta vendo o mapa vazio, e o hypercore recebe dois `open` do mesmo diretório — o
   * `File descriptor could not be locked` que aparecia como `E_INTERNAL` intermitente no
   * `dm.accept`. A promessa entra no mapa **antes** do `await`, e a segunda chamada espera a
   * primeira em vez de competir com ela. Uma abertura que falha sai do mapa: cachear a
   * rejeição faria um erro transitório condenar a conversa até o próximo boot.
   */
  const cabos = new Map<string, Promise<CoreHandle>>();

  const cabo = <T extends CoreHandle>(chave: string, abrir: () => Promise<T>): Promise<T> => {
    const existente = cabos.get(chave);
    if (existente !== undefined) return existente as Promise<T>;
    const novo = abrir().catch((erro: unknown) => {
      cabos.delete(chave);
      throw erro;
    }) as Promise<T>;
    cabos.set(chave, novo);
    return novo;
  };

  const abrirProprio = async (a: {
    conversationId: string;
    keyPair: { publicKey: Buffer; secretKey: Buffer };
  }): Promise<WritableCoreHandle> =>
    await cabo(`${a.conversationId}:self`, async () =>
      deps.abrirCore !== undefined
        ? ((await deps.abrirCore({ conversationId: a.conversationId, own: true, keyPair: a.keyPair })) as WritableCoreHandle)
        : await openWritableCore(caminho(a.conversationId, 'self'), a.keyPair),
    );

  const abrirDoPar = async (a: { conversationId: string; coreKey: Buffer }): Promise<CoreHandle> =>
    await cabo(`${a.conversationId}:peer`, async () =>
      deps.abrirCore !== undefined
        ? await deps.abrirCore({ conversationId: a.conversationId, own: false, coreKey: a.coreKey })
        : await openCore(caminho(a.conversationId, 'peer'), a.coreKey),
    );

  // ── §10.5 — a segunda metade da barreira ───────────────────────────────────────────

  /**
   * `dm_local_read_state` recomputado, e `dm.unreadChanged` **depois** do commit.
   *
   * §31.12: "no boot, `dm_local_read_state` é recomputado para toda conversa cujo watermark
   * não bata com a query". A contagem é uma query sobre `ordKey > lastRead` (A28), nunca um
   * acumulador — é isso que a torna idempotente e faz a reprojeção recomeçar do zero sem
   * contar duas vezes.
   */
  const recomputarNaoLidas = (conversationId: string): void => {
    const marca = deps.manifest.getDmReadState(conversationId);
    const n = queries.naoLidas(conversationId, deps.identity()?.publicKey.toString('hex') ?? null);
    if (marca !== null && marca.unread_count === n) return;
    deps.manifest.setDmReadState(
      conversationId,
      marca?.last_read_ord_sum ?? -1,
      marca?.last_read_author ?? Buffer.alloc(32),
      n,
    );
    deps.onEvent('dm.unreadChanged', { conversationId, unreadCount: n });
  };

  // ── §31.16.2 — a saída única dos eventos ───────────────────────────────────────────

  const eventosDoProjetor = (conversationId: string) => (events: readonly DmProjectedEvent[]): void => {
    for (const ev of events) deps.onEvent(ev.topic, { conversationId, ...ev.data });
    // Depois do commit, e só quando algo chegou: a contagem é derivada do que foi projetado.
    recomputarNaoLidas(conversationId);
    // §31.11 — a entrega é derivada do `ack` do par, que só muda quando ele escreve.
    const vivo = vivos.get(conversationId);
    if (vivo !== undefined) {
      deps.onEvent('dm.delivered', {
        conversationId,
        deliveredUpTo: entregueAte(vivo),
      });
    }
  };

  /**
   * O transporte nasce depois da política (ele depende de `dm`), e a política precisa
   * acordá-lo: por isso a referência é tardia em vez de um parâmetro.
   */
  let transporte: DmTransport | null = null;

  const eventosDaPolitica = (ev: DmEvent): void => {
    deps.onEvent(ev.topic, ev.data);
    // §31.8 — a descoberta segue o **estado** da conversa, e quem o muda é L2: `abrir`,
    // `aceitar`, `bloquear`, `desbloquear` e `esquecer` são comandos de §31.16.1 que o
    // transporte não vê passar. Sem esta releitura, um `pending-out` recém-aberto só
    // procuraria o par no boot seguinte — a primeira mensagem ficava no log de quem
    // escreveu até alguém reiniciar o núcleo (defeito de 2026-09-03). `refresh` é
    // idempotente, e é o próprio `DmTransport` que declara isso.
    if (ev.topic === 'dm.conversationChanged' || ev.topic === 'dm.requested') {
      transporte?.refresh();
    }
  };

  // ── §31.11 — entrega e lag, derivados do `DmState` ─────────────────────────────────

  const outroLado = (o: DmOrigin): DmOrigin => (o === 'lo' ? 'hi' : 'lo');

  /** `entregueAté(meuLado) = max(r.ack : r ∈ log do par)`. `lastAck` é esse máximo (RD-4). */
  const entregueAte = (vivo: Vivo): number => vivo.projetor.state.sides[outroLado(vivo.meuLado)].lastAck;

  const estado = (conversationId: string): DmState | null => vivos.get(conversationId)?.projetor.state ?? null;

  // ── O projetor, montado por `directMessages` (§103) ────────────────────────────────

  /**
   * §31.14 — o core de blobs local por conversa, uma promessa por conversa, pela mesma
   * razão que `cabos`: duas montagens concorrentes abririam o mesmo diretório duas vezes
   * (§105.5 defeito 4). O `hyperblobs` sofre do mesmo lock que o `hypercore`.
   */
  const blobsLocais = new Map<string, Promise<Buffer>>();

  const anexarBlobs = (conversationId: string): Promise<Buffer> | null => {
    const porta = deps.blobs;
    if (porta === undefined) return null;
    const existente = blobsLocais.get(conversationId);
    if (existente !== undefined) return existente;
    const identidade = eu();
    // §31.3 — a semente é derivada AQUI, junto das outras, e sai daqui direto para quem
    // abre o core. Ela não cruza porta de `directMessages` e não cruza o IPC-R.
    const { seed } = deriveDmBlobsKeyPair(
      identidade.secretKey.subarray(0, sodium.crypto_sign_SEEDBYTES),
      Buffer.from(conversationId, 'hex'),
    );
    const p = porta.anexar(conversationId, seed).catch((erro: unknown) => {
      blobsLocais.delete(conversationId);
      throw erro;
    });
    blobsLocais.set(conversationId, p);
    return p;
  };

  /** A chave já resolvida, para quem precisa dela sem esperar (`blobsCoreKeyOf`). */
  const blobsPorConversa = new Map<string, Buffer>();

  /**
   * A chave do core de blobs desta conversa, **esperando o anexo em voo**. `montarProjetor`
   * dispara `anexarBlobs` sem aguardar — de propósito, porque uma conversa sem anexos não
   * pode depender disso para nascer —, e a guarda de RD-11 cai exatamente na janela entre a
   * montagem e a resolução. Esperar aqui troca um `E_VALIDATION` enganoso por alguns
   * milissegundos; uma falha real continua devolvendo `null`, que a guarda recusa.
   */
  const chaveDeBlobs = async (conversationId: string): Promise<Buffer | null> => {
    const pronta = blobsPorConversa.get(conversationId);
    if (pronta !== undefined) return pronta;
    const emVoo = blobsLocais.get(conversationId);
    if (emVoo === undefined) return null;
    return await emVoo.catch(() => null);
  };

  const montarProjetor = async (a: {
    conversationId: string;
    conversationKey: Buffer;
    loKey: Buffer;
    hiKey: Buffer;
    lo: CoreHandle | null;
    hi: CoreHandle | null;
    loCoreKey?: Buffer;
    hiCoreKey?: Buffer;
  }) => {
    // `directMessages` remonta a conversa a cada transição (aceite, desbloqueio, vínculo de
    // core) e descarta o `Runtime` anterior — a referência dele ao projetor velho vai junto.
    // Quem ainda a tem é este mapa, e parar o projetor velho é obrigação daqui: dois
    // projetores da MESMA conversa rodando `#run()` sobre a mesma `view.db` disputam a
    // transação, e o segundo morre em `SQLITE_BUSY` — que chega à fronteira como
    // `E_INTERNAL`, intermitente e dependente de carga.
    vivos.get(a.conversationId)?.projetor.stop();

    const identidade = eu();
    const meuLado: DmOrigin = a.loKey.equals(identidade.publicKey) ? 'lo' : 'hi';
    const peerKey = meuLado === 'lo' ? a.hiKey : a.loKey;
    const contentKey = chaveDeConteudo(a.conversationKey, peerKey);
    const projetor = new DmProjector(
      deps.view,
      { lo: a.lo, hi: a.hi },
      {
        conversationId: a.conversationId,
        conversationKey: a.conversationKey,
        loKey: a.loKey,
        hiKey: a.hiKey,
        contentKey,
        ...(a.loCoreKey !== undefined ? { loCoreKey: a.loCoreKey } : {}),
        ...(a.hiCoreKey !== undefined ? { hiCoreKey: a.hiCoreKey } : {}),
      },
      {
        foldBuildId: deps.foldBuildId,
        meuLado,
        now,
        onEvent: eventosDoProjetor(a.conversationId),
        onPanic: (ordSum, kind) => deps.onEvent('dmFold.panic', { conversationId: a.conversationId, ordSum, kind }),
      },
    );
    vivos.set(a.conversationId, { projetor, meuLado, contentKey });
    // §31.14 — o core de blobs nasce com a conversa, e não com o primeiro anexo: quem
    // baixa um anexo meu precisa me achar no tópico de §13.4, e o anúncio é do dono do
    // core. Esperar o primeiro `blob.stage` deixaria a janela em que o par pede e ninguém
    // responde. A falha não derruba a montagem — uma conversa sem anexos continua inteira.
    const blobs = anexarBlobs(a.conversationId);
    if (blobs !== null) {
      void blobs.then(
        (chave) => blobsPorConversa.set(a.conversationId, chave),
        () => deps.onEvent('dm.sync', { conversationId: a.conversationId, state: 'stalled', lag: 0, reason: 'no-provider' }),
      );
    }
    // Uma conversa que nasce enquanto outra está em foco **não** começa a consumir lote:
    // `dm.activate` é quem decide residência, e ignorá-lo aqui faria cada `dmHello` novo
    // ligar um projetor que ninguém está olhando.
    if (ativa !== null && ativa !== a.conversationId) projetor.stop();
    return projetor;
  };

  // ── `directMessages` (L2) ──────────────────────────────────────────────────────────

  const dm = new DirectMessages({
    manifest: deps.manifest,
    // A `seed` são os 32 primeiros bytes da chave secreta Ed25519 (§5.1, `identitySeedOf`).
    get identity() {
      const i = eu();
      return { publicKey: i.publicKey, seed: i.secretKey.subarray(0, sodium.crypto_sign_SEEDBYTES) };
    },
    cripto: {
      conversationKey: (peerKey) => dmConversationKey(eu().publicKey, peerKey),
      // RD-1 — a gênese daquele lado: `dm.hello` no índice 0, `authorSeq = 1`, `ack = 0`.
      hello: ({ conversationKey, peerKey, selfCoreKey }) =>
        registro({
          conversationKey,
          peerKey,
          kind: 'dm.hello',
          authorSeq: 1,
          ack: 0,
          payload: { peerKey, coreProof: assinar(dmCorePossessionHash(conversationKey, selfCoreKey)), ...perfil() },
        }),
      // §31.12 — atalho **derivável**: o boot o reescreve quando falta ou não decifra.
      selarSemente: (seed) => aeadSealPacked(deps.dataKey, seed),
    },
    cores: {
      abrirProprio,
      abrirDoPar,
      // §31.13 — a saída de `desynced` exige o par (§103.1). Enquanto B58 não expõe a
      // recomposição no fio, o desfecho honesto é `indisponivel`: não se inventa restauração.
      limpar: async ({ core }) => {
        await (core as { clear?: (a: number, b: number) => Promise<void> }).clear?.(0, Math.max(0, core.length - 1));
      },
    },
    projetor: {
      montar: montarProjetor,
      limpar: (conversationId) => {
        vivos.get(conversationId)?.projetor.stop();
        vivos.delete(conversationId);
        // §31.19 — o core de blobs sai junto: os blocos dele são o anexo, e mantê-lo
        // anunciado no tópico de §13.4 depois de esquecer serviria bytes de uma conversa
        // que a pessoa mandou apagar.
        blobsLocais.delete(conversationId);
        blobsPorConversa.delete(conversationId);
        void deps.blobs?.soltar(conversationId);
        // §31.19 — as quatro tabelas `dm_*`, o log de recusas, o snapshot e os marcadores.
        // Nada em `manifest.db` é tocado: a linha de `dm_conversations` sobrevive (**L-25**).
        deps.view.purgeConversationData(conversationId);
      },
    },
    onEvent: eventosDaPolitica,
    now,
    ...(deps.compartilhaComunidade !== undefined ? { compartilhaComunidade: deps.compartilhaComunidade } : {}),
    ...(deps.retentionDays !== undefined ? { retentionDays: deps.retentionDays } : {}),
    sincronizacao: (conversationId): DmSyncState | null => {
      const s = estado(conversationId);
      if (s === null) return null;
      const vivo = vivos.get(conversationId);
      /* c8 ignore next */
      if (vivo === undefined) return null;
      const par = s.sides[outroLado(vivo.meuLado)];
      // §31.13 — `synced` é "os dois lados interpretados até a cabeça". O `lag` real depende
      // de conhecer a cabeça do par, que é do transporte; sem ele, `peer-offline`.
      return par.length > 0 ? 'synced' : null;
    },
  });

  // ── §31.10 — a construção do registro ──────────────────────────────────────────────

  /**
   * Um registro de §31.4, assinado e cifrado. **Aqui não há barreira nenhuma**: quem grava o
   * `self_high_water` antes do append é `directMessages.append` (§103), e quem chama esta
   * função já decidiu que vai appendar.
   */
  function registro<K extends DmKindName>(a: {
    conversationKey: Buffer;
    peerKey: Buffer;
    kind: K;
    authorSeq: number;
    ack: number;
    payload: DmPayloadOf<K>;
  }): Uint8Array {
    const identidade = eu();
    const header: DmHeader = {
      v: DM_VERSION,
      conversationId: a.conversationKey,
      kind: DM_KINDS[a.kind],
      author: identidade.publicKey,
      authorSeq: a.authorSeq,
      ts: now(),
      ack: a.ack,
    };
    const contentKey = chaveDeConteudo(a.conversationKey, a.peerKey);
    const plaintext = encodeDmPayload(a.kind, a.payload);
    const payload = sealDmPayload(contentKey, header, plaintext);
    // §31.3 regra 5 — zerada após o uso.
    sodium.sodium_memzero(contentKey);
    if (payload === null) recusar('E_INTERNAL');
    const opBytes = encodeDmOp({ ...header, payload });
    return encodeDmEnvelope({ op: opBytes, sig: assinar(dmOpSigningHash(opBytes)) });
  }

  const escrever = async <K extends DmKindName>(
    conversationId: string,
    kind: K,
    payload: DmPayloadOf<K>,
  ): Promise<{ messageId: string; ordSum: number }> => {
    const row = deps.manifest.getDmConversation(conversationId);
    if (row === null) recusar('E_NOT_FOUND');
    const vivo = vivos.get(conversationId);
    const s = vivo?.projetor.state;
    // §31.4 — `v` ou `kind` desconhecido nesta conversa bloqueia a escrita local nela.
    if (s?.partialInterpretation === true) recusar('E_VERSION_UNSUPPORTED');

    // §31.9 regra 1 — antes do aceite não existe o meu core. `append` reconfere dentro da
    // trava; aqui a recusa é só a que não vale a pena enfileirar.
    if (dm.coreDe(conversationId) === null) recusar('E_DM_NOT_AUTHORIZED');
    const conversationKey = Buffer.from(conversationId, 'hex');

    // RD-11, a metade que **este** nó controla: o `blobsCoreKey` de um anexo tem de ser o
    // core de blobs de DM do autor daquela mensagem — e o autor, aqui, sou eu.
    //
    // O que a guarda fecha e o que ela não fecha (B66). Do lado da ESCRITA, ela é total:
    // um anexo com chave que não é a minha não entra no meu log, ponto. Do lado da
    // LEITURA, o `dmFold` só consegue exigir que todo anexo de um lado repita a chave do
    // primeiro daquele lado (§31.7.2, `blobsCoreKey`), porque `dmBlobsSeed` é derivável só
    // por quem tem o `identitySeed` e a chave resultante não é declarada em lugar nenhum
    // do fio. Fechar o primeiro anexo exige texto normativo — é B66, e não se inventa aqui.
    const anexo = (payload as { attachment?: DmAnexoDoPayload }).attachment;
    if (anexo?.blob?.blobsCoreKey !== undefined) {
      // O core de blobs nasce com a conversa, mas nasce numa promessa (`anexarBlobs`): entre
      // montar e anexar há uma janela em que a chave certa ainda não está no mapa. Recusar ali
      // seria dizer `E_VALIDATION` a um anexo correto — o mesmo código de uma violação real de
      // RD-11 —, então a janela se **espera**, não se responde.
      const minha = await chaveDeBlobs(conversationId);
      if (minha === null || !minha.equals(anexo.blob.blobsCoreKey)) {
        recusar('E_VALIDATION', { field: 'attachment' });
      }
      // §13.7 regra 1 — e o blob tem de existir aqui. A ordem é blob primeiro, mensagem
      // depois; uma mensagem que aponte para bytes não escritos é a promessa que o autor
      // não pode cumprir.
      if (
        deps.blobs !== undefined &&
        !deps.blobs.foiStaged({
          blobsCoreKey: anexo.blob.blobsCoreKey,
          blobIdHex: anexo.hash.subarray(0, 16).toString('hex'),
          hash: anexo.hash,
        })
      ) {
        recusar('E_BLOB_NOT_STAGED');
      }
    }

    // RD-3 — o contador é `core.length + 1`, recuperado do próprio core. **Não existe
    // `dm_author_seq`** (§31.12): uma tabela a menos do que a comunidade precisa. Derivar aqui
    // fora seria derivá-lo de um comprimento que outra escrita em voo já vai mudar: quem passa
    // pela trava por conversa de §31.10 é `directMessages.append`, e por isso o registro é
    // construído **dentro** dela, com o índice que vai valer.
    let ack = 0;
    const r = await dm.append(conversationId, (index) => {
      // §31.6 — `ack` é quantos registros do log do par eu já interpretei. Lido aqui dentro
      // pelo mesmo motivo do `authorSeq`: é o valor do momento do append.
      const atual = vivos.get(conversationId);
      const st = atual?.projetor.state;
      ack = atual === undefined || st === undefined ? 0 : st.sides[outroLado(atual.meuLado)].length;
      return [
        registro({ conversationKey, peerKey: row.peer_key, kind, authorSeq: index + 1, ack, payload }),
      ];
    });
    if (r.ok !== true) recusar(r.code, r.limit !== undefined ? { limit: r.limit } : {});

    return {
      // §31.4 — a **única** entidade com id próprio é a mensagem; reação, edição e deleção
      // referenciam a mensagem e não têm identidade (§31.5).
      messageId: dmEntityId('message', conversationKey, eu().publicKey, r.from + 1),
      ordSum: ordSumOf(r.from, ack),
    };
  };

  // ── Consultas e fio ────────────────────────────────────────────────────────────────

  const queries = dmQueryPorts({
    view: deps.view,
    manifest: deps.manifest,
    dm,
    selfKeyHex: () => deps.identity()?.publicKey.toString('hex') ?? null,
    deliveredUpTo: (id) => {
      const vivo = vivos.get(id);
      return vivo === undefined ? 0 : entregueAte(vivo);
    },
    // §31.13 — `lag` é "registros por interpretar". Sem a cabeça do par (que é do fio), o
    // honesto é 0: um número inventado seria pior do que nenhum.
    lagOf: () => 0,
    partialOf: (id) => {
      const s = estado(id);
      return {
        partial: s?.partialInterpretation === true,
        // §31.16.2 — as listas são as do `DmState` (§31.7.2, emenda de 2026-09-05). Antes elas
        // eram vazias por construção, e a query dizia "parcial" sem dizer de quê.
        unknownKinds: [...(s?.unknownKinds ?? [])],
        unknownVersions: [...(s?.unknownVersions ?? [])],
      };
    },
    ...(deps.blobs?.cache !== undefined ? { blobCache: deps.blobs.cache.bind(deps.blobs) } : {}),
  });

  const transport = startDmTransport({
    swarm: deps.swarm,
    dm,
    get identity() {
      return eu();
    },
    onEvent: (topic, data) => deps.onEvent(topic, data),
    clock: { now },
  });
  transporte = transport;

  return {
    dm,
    transport,
    queries,
    escrever,

    markRead(conversationId: string) {
      const row = deps.manifest.getDmConversation(conversationId);
      if (row === null) recusar('E_NOT_FOUND');
      // A28 — a marca é o topo da ordem canônica agora; a contagem vira 0 por construção.
      const topo = deps.view
        .prepare(
          'SELECT ord_sum, author_key FROM dm_messages WHERE conversation_id = ? ORDER BY ord_sum DESC, author_key DESC LIMIT 1',
        )
        .get(conversationId) as { ord_sum: number; author_key: Buffer } | undefined;
      deps.manifest.setDmReadState(
        conversationId,
        topo?.ord_sum ?? -1,
        topo?.author_key ?? Buffer.alloc(32),
        0,
      );
      deps.onEvent('dm.unreadChanged', { conversationId, unreadCount: 0 });
      return { unreadCount: 0 as const };
    },

    /**
     * `dm.activate` (§31.16.1). A conversa em foco fica com o projetor **rodando**; as demais
     * continuam montadas e param de consumir lote — a mesma economia de §21.3, e a razão de
     * `residency` existir na resposta em vez de ser silenciosa.
     */
    blobsCoreKeyOf(conversationId: string) {
      return blobsPorConversa.get(conversationId) ?? null;
    },

    activate(conversationId: string | null) {
      if (conversationId !== null && deps.manifest.getDmConversation(conversationId) === null) {
        recusar('E_NOT_FOUND');
      }
      ativa = conversationId;
      for (const [id, vivo] of vivos) {
        if (id === conversationId) vivo.projetor.start();
        else vivo.projetor.stop();
      }
      return { residency: conversationId === null ? ('background' as const) : ('active' as const) };
    },

    async boot() {
      await dm.boot();
      // §31.12 — no boot, o watermark de cada conversa é reconferido contra a query.
      for (const row of deps.manifest.listDmConversations()) {
        if (row.state === 'left') continue;
        recomputarNaoLidas(row.conversation_id);
      }
      transport.refresh();
    },

    async close() {
      await transport.stop();
      for (const vivo of vivos.values()) vivo.projetor.stop();
      vivos.clear();
      // `cabos` guarda promessas: uma abertura ainda em voo tem de ser esperada antes de
      // fechar, ou o core sobrevive ao `close` sem dono. Uma que falhou já se removeu do
      // mapa, mas pode chegar aqui na janela da microtask — e um fechamento não é o lugar
      // de propagar aquele erro.
      for (const c of cabos.values()) {
        await c.then((h) => h.close()).catch(() => {});
      }
      cabos.clear();
      for (const id of blobsLocais.keys()) await deps.blobs?.soltar(id).catch(() => {});
      blobsLocais.clear();
      blobsPorConversa.clear();
      await dm.close();
      ativa = null;
    },
  };
}
