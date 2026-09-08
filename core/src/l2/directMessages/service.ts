// `directMessages` — L2. O **ciclo de vida** da conversa direta: derivação, aceite, bloqueio,
// política de contato, `self_high_water` e a saída de `desynced` (§31.8, §31.9, §31.13).
//
// §4 dá a este módulo a coluna "Depende de" `corestore, swarm, manifest, identity`, mais a
// **porta** de RPC implementada por `rpcServer`/`rpcClient`, e duas proibições: **interpretar
// registro** e **importar `rpcServer`/`rpcClient`**.
//
// Note o que a lista NÃO tem: `dmCodec`, `dmFold`, `dmProjector` nem `view`. Construir o
// `dm.hello` de gênese e montar o projetor entram por **porta injetada** — o mesmo padrão que
// `succession` usou para a submissão e o escrow (§27), e pela mesma razão: emendar §4 para
// encurtar uma injeção é trocar a fronteira por conveniência. A consequência prática é a que
// se quer: este módulo **nunca vê um registro decodificado** e nunca escreve em `view.db`,
// que tem um escritor só (§21.1).
//
// O que ele decide, e o que não decide:
//
// | Decide aqui (B57) | Aplica no fio (B58) |
// |---|---|
// | `autorizaDm(par, conversa)` — o predicado de §31.8(4) | recusar o canal `protomux` |
// | aceitar, bloquear, teto de pendentes, política de contato | `dmHello` no fio, prova de posse |
// | `self_high_water` antes de cada append, `desynced` | replicar os dois cores no mesmo mux |
//
// **Não há outbox (§31.10).** Escrever é `core.append` no próprio core, e a resposta é
// síncrona com o registro **já no log**. Sem `local_outbox`, sem group commit, sem
// reconciliação, sem `observed_ops`, sem descarte com motivo, sem `retry`/`cancelQueued`.

import { deriveDmCoreKeyPair, type CoreHandle, type WritableCoreHandle } from '../../l0/corestore/index.ts';
import type {
  DmConversationRow,
  DmConversationState,
  ManifestDb,
} from '../../l0/manifest/index.ts';

import {
  DIA_MS,
  DM_REMOVED_RETENTION_DAYS_DEFAULT,
  P2P_DM_MAX_CONVERSATIONS,
  P2P_DM_PENDING_MAX,
} from './limites.ts';

export type { DmConversationRow, DmConversationState };

/** §31.13 — os estados de sincronização observáveis, análogos a §14.5. */
export type DmSyncState =
  | 'synced'
  | 'catching-up'
  | 'stalled'
  | 'peer-offline'
  | 'unauthorized'
  | 'forked'
  | 'desynced';

/** §31.9 regra 5 — preferência local; default `'anyone'`. */
export type DmContactPolicy = 'anyone' | 'shared-community';

export const DM_CONTACT_POLICY_KEY = 'contactPolicy';

/**
 * Os códigos de §20.2 que este módulo devolve. **Ele não importa `errors`** — nenhum L2
 * importa, e §4 não lista o módulo entre as dependências: quem traduz para a forma de §20.1
 * é a fronteira (o mesmo arranjo de `relay` e `shareStar`).
 *
 * Três condições de §31.17 deliberadamente **não** têm código próprio: conversa consigo mesmo
 * é `E_VALIDATION.peerKey`; pendentes demais é `E_LIMIT_EXCEEDED` com `limit`; registro de
 * outra conversa é `E_WRONG_COMMUNITY`.
 */
export type DmErrorCode =
  | 'E_VALIDATION'
  | 'E_NOT_FOUND'
  | 'E_LIMIT_EXCEEDED'
  | 'E_DM_BLOCKED'
  | 'E_DM_FORKED'
  | 'E_DM_CORE_MISMATCH'
  | 'E_DM_NOT_AUTHORIZED';

export type DmFalha = {
  readonly ok: false;
  readonly code: DmErrorCode;
  /** Só `E_VALIDATION` (§20.1). */
  readonly field?: string;
  /** Só `E_LIMIT_EXCEEDED` (§31.9 regra 4). */
  readonly limit?: number;
};

function falha(code: DmErrorCode, extra: { field?: string; limit?: number } = {}): DmFalha {
  return { ok: false, code, ...extra };
}

export type DmEvent = { readonly topic: string; readonly data: Readonly<Record<string, unknown>> };

// ─── Portas (§4) ───────────────────────────────────────────────────────────────────────

/**
 * As duas derivações de §31.2/§31.5 que moram no `dmCodec`, que §4 **não** dá a este módulo.
 * A composição as liga com a chave de identidade local dentro; nem `identitySk` nem
 * `dmContentKey` atravessam esta porta, e é isso que mantém §3.2 item 5 sem exceção.
 */
export type DmCriptoPort = {
  /**
   * §31.2 — `BLAKE2b-256('dm-conv/1' ‖ lo ‖ hi)`, 32 bytes. `null` quando `peerKey` é a
   * própria chave: `lo = hi` não é conversa (§31.2 regra 5).
   */
  conversationKey(peerKey: Uint8Array): Buffer | null;
  /**
   * §31.5/RD-1 — o `dm.hello` de gênese daquele lado, assinado e cifrado: **índice 0**,
   * `authorSeq = 1`, `ack = 0`, com `coreProof` sobre
   * `BLAKE2b('dm-core-possession/1' ‖ conversationId ‖ selfCoreKey)`.
   */
  hello(a: {
    readonly conversationKey: Buffer;
    readonly peerKey: Buffer;
    readonly selfCoreKey: Buffer;
  }): Uint8Array;
  /**
   * §31.12 — `self_core_seed_enc`: a semente cifrada pela Data Key, `nonce‖ct‖tag`. É
   * **atalho derivável** (§31.19 regra 4), então a porta é opcional: sem ela a coluna fica
   * `NULL` e o boot rederiva do `identitySeed`.
   */
  selarSemente?(seed: Buffer): Buffer;
};

/** §31.13 — o desfecho de uma tentativa de recompor o próprio core com o par. */
export type DmRecomposicao =
  /** `ACHADO-G14-01` — o par tinha os blocos, assinados pela minha chave; o core voltou. */
  | { readonly resultado: 'restaurado' }
  /**
   * `ACHADO-G14-05` — houve contato com o par e ele **não tem** o índice que falta. Ninguém
   * tem: o bloco nunca chegou a existir, e a marca era especulativa.
   */
  | { readonly resultado: 'inexistente' }
  /** Sem contato com o par. Não se conclui nada; a conversa continua `desynced`. */
  | { readonly resultado: 'indisponivel' };

/**
 * Ciclo de vida dos dois cores. `corestore` é dependência declarada, mas o **caminho** de
 * armazenamento (§10.1, §5.3) e a replicação (§14.1, B58) são de quem monta o grafo.
 */
export type DmCorePort = {
  abrirProprio(a: {
    readonly conversationId: string;
    readonly keyPair: { readonly publicKey: Buffer; readonly secretKey: Buffer };
  }): Promise<WritableCoreHandle>;
  abrirDoPar(a: {
    readonly conversationId: string;
    readonly coreKey: Buffer;
  }): Promise<CoreHandle>;
  /**
   * §31.13 — a saída de `desynced`, tentada **antes de qualquer append** (`ACHADO-G14-02`).
   * Sem porta ligada o desfecho é `indisponivel`: não se inventa restauração.
   */
  recompor?(a: {
    readonly conversationId: string;
    readonly core: CoreHandle;
    readonly alvo: number;
  }): Promise<DmRecomposicao>;
  /** §31.19 — `core.clear` dos blocos dos dois cores. A árvore assinada **fica**. */
  limpar?(a: { readonly conversationId: string; readonly core: CoreHandle }): Promise<void>;
};

export type DmProjetorLike = {
  boot(): Promise<void>;
  start(): void;
  stop(): void;
};

/** O `dmProjector` de §21.1 — o **único** escritor de `view.db` para DM. */
export type DmProjetorPort = {
  montar(a: {
    readonly conversationId: string;
    readonly conversationKey: Buffer;
    readonly loKey: Buffer;
    readonly hiKey: Buffer;
    readonly lo: CoreHandle | null;
    readonly hi: CoreHandle | null;
    readonly loCoreKey?: Buffer;
    readonly hiCoreKey?: Buffer;
  }): Promise<DmProjetorLike>;
  /** §31.19 — apaga a projeção daquela conversa. Escrita em `view.db` é sempre do projetor. */
  limpar?(conversationId: string): void;
};

export type DirectMessagesOptions = {
  readonly manifest: ManifestDb;
  /** A identidade local (§5.1). `seed` são os 32 primeiros bytes da chave secreta Ed25519. */
  readonly identity: { readonly publicKey: Buffer; readonly seed: Buffer };
  readonly cripto: DmCriptoPort;
  readonly cores: DmCorePort;
  readonly projetor?: DmProjetorPort;
  readonly onEvent?: (ev: DmEvent) => void;
  readonly now?: () => number;
  /**
   * §31.9 regra 5 — em `'shared-community'`, `dmHello` de um par sem comunidade em comum é
   * recusado. Quem sabe disso é o estado interpretado, que §4 não dá a este módulo; sem a
   * porta, a política `'shared-community'` recusa **todo** primeiro contato, que é o
   * desfecho conservador e não o silencioso.
   */
  readonly compartilhaComunidade?: (peerKey: Buffer) => boolean;
  /** §14.5/§31.13 — a leitura de rede que só B58 tem. Sem ela, `peer-offline`. */
  readonly sincronizacao?: (conversationId: string) => DmSyncState | null;
  /** `P2P_REMOVED_RETENTION_DAYS` de §27.2 (default 7), que mora em `config`. */
  readonly retentionDays?: number;
  readonly maxConversations?: number;
  readonly pendingMax?: number;
};

type Runtime = {
  conversationKey: Buffer;
  peerKey: Buffer;
  /** `'lo'` quando a minha chave de identidade é a menor das duas (§31.2). */
  selfOrigin: 'lo' | 'hi';
  core: WritableCoreHandle | null;
  peerCore: CoreHandle | null;
  projetor: DmProjetorLike | null;
  /** §31.13 — `core.length < self_high_water` na abertura. Enquanto ligado, **não appenda**. */
  desynced: boolean;
  /** §18.9 — bloco conflitante reportado pelo Hypercore. Terminal: não há merge automático. */
  forked: boolean;
};

// ─── O serviço ─────────────────────────────────────────────────────────────────────────

export class DirectMessages {
  readonly #manifest: ManifestDb;
  readonly #identity: { publicKey: Buffer; seed: Buffer };
  readonly #cripto: DmCriptoPort;
  readonly #cores: DmCorePort;
  readonly #projetor: DmProjetorPort | null;
  readonly #onEvent: (ev: DmEvent) => void;
  readonly #now: () => number;
  readonly #compartilhaComunidade: ((peerKey: Buffer) => boolean) | null;
  readonly #sincronizacao: ((conversationId: string) => DmSyncState | null) | null;
  readonly #retencaoMs: number;
  readonly #maxConversations: number;
  readonly #pendingMax: number;
  readonly #rt = new Map<string, Runtime>();
  /** §31.10 — a cadeia de escrita por conversa; ver `#serializado`. */
  readonly #escritas = new Map<string, Promise<void>>();

  constructor(o: DirectMessagesOptions) {
    this.#manifest = o.manifest;
    this.#identity = { publicKey: o.identity.publicKey, seed: o.identity.seed };
    this.#cripto = o.cripto;
    this.#cores = o.cores;
    this.#projetor = o.projetor ?? null;
    this.#onEvent = o.onEvent ?? (() => {});
    this.#now = o.now ?? Date.now;
    this.#compartilhaComunidade = o.compartilhaComunidade ?? null;
    this.#sincronizacao = o.sincronizacao ?? null;
    this.#retencaoMs = (o.retentionDays ?? DM_REMOVED_RETENTION_DAYS_DEFAULT) * DIA_MS;
    this.#maxConversations = o.maxConversations ?? P2P_DM_MAX_CONVERSATIONS;
    this.#pendingMax = o.pendingMax ?? P2P_DM_PENDING_MAX;
  }

  // ── Boot ─────────────────────────────────────────────────────────────────────────────

  /**
   * §19.2 na leitura de §31.13. Para cada conversa que ainda tem core, **a barreira antes de
   * tudo**: abrir, comparar `core.length` com `self_high_water`, e só então montar o projetor.
   *
   * A ordem não é conservadorismo. `ACHADO-G14-02` mediu o contrafactual: appendar num core
   * encurtado, antes de recompor, produz dois blocos diferentes no mesmo índice assinados
   * pela mesma chave, e as duas pontas emitem `conflict`.
   */
  async boot(): Promise<void> {
    for (const row of this.#manifest.listDmConversations()) {
      if (row.state === 'left') continue; // §31.19 — a linha sobrevive; os cores, não
      await this.#montar(row);
    }
  }

  async #montar(row: DmConversationRow): Promise<Runtime> {
    const existente = this.#rt.get(row.conversation_id);
    if (existente !== undefined) return existente;

    const conversationKey = Buffer.from(row.conversation_id, 'hex');
    const selfOrigin = Buffer.compare(this.#identity.publicKey, row.peer_key) < 0 ? 'lo' : 'hi';
    const rt: Runtime = {
      conversationKey,
      peerKey: row.peer_key,
      selfOrigin,
      core: null,
      peerCore: null,
      projetor: null,
      desynced: false,
      forked: false,
    };
    this.#rt.set(row.conversation_id, rt);

    // `pending-in` **não** tem core próprio: aceitar é o que o cria (§31.9 regra 1). O
    // `dm_conversations.self_core_key` está gravado desde a criação da linha porque é
    // derivado, mas o core em si só existe depois do aceite.
    if (row.state !== 'pending-in' && row.state !== 'blocked') {
      rt.core = await this.#cores.abrirProprio({
        conversationId: row.conversation_id,
        keyPair: this.#coreKeyPair(conversationKey),
      });
      this.#verificarBarreira(row, rt);
    }
    if (row.peer_core_key !== null && row.state !== 'blocked') {
      rt.peerCore = await this.#cores.abrirDoPar({
        conversationId: row.conversation_id,
        coreKey: row.peer_core_key,
      });
    }
    await this.#ligarProjetor(row.conversation_id, rt);
    return rt;
  }

  async #ligarProjetor(conversationId: string, rt: Runtime): Promise<void> {
    if (this.#projetor === null) return;
    if (rt.projetor !== null) {
      rt.projetor.stop();
      rt.projetor = null;
    }
    if (rt.core === null && rt.peerCore === null) return;
    const meu = rt.selfOrigin === 'lo';
    const meuCore = rt.core?.key ?? null;
    const dele = rt.peerCore?.key ?? null;
    const proj = await this.#projetor.montar({
      conversationId,
      conversationKey: rt.conversationKey,
      loKey: meu ? this.#identity.publicKey : rt.peerKey,
      hiKey: meu ? rt.peerKey : this.#identity.publicKey,
      lo: meu ? rt.core : rt.peerCore,
      hi: meu ? rt.peerCore : rt.core,
      ...(meuCore === null ? {} : meu ? { loCoreKey: meuCore } : { hiCoreKey: meuCore }),
      ...(dele === null ? {} : meu ? { hiCoreKey: dele } : { loCoreKey: dele }),
    });
    await proj.boot();
    proj.start();
    rt.projetor = proj;
  }

  #coreKeyPair(conversationKey: Buffer): { publicKey: Buffer; secretKey: Buffer } {
    return deriveDmCoreKeyPair(this.#identity.seed, conversationKey);
  }

  // ── §31.13 — a barreira do `self_high_water` ─────────────────────────────────────────

  /**
   * `core.length ≥ self_high_water` → normal. `core.length < self_high_water` → **`desynced`**:
   * o nó não appenda, emite `dm.desynced`, e escrita devolve `E_DM_FORKED`.
   */
  #verificarBarreira(row: DmConversationRow, rt: Runtime): void {
    const core = rt.core;
    if (core === null) return;
    if (core.length >= row.self_high_water) {
      rt.desynced = false;
      return;
    }
    rt.desynced = true;
    this.#emitir('dm.desynced', {
      conversationId: row.conversation_id,
      coreLength: core.length,
      highWater: row.self_high_water,
    });
  }

  /**
   * A saída de `desynced` de §31.13, e a **única** coisa que a desliga.
   *
   * Duas saídas, as duas exigindo o par — e isso é a decisão de `ACHADO-G14-05`, não um
   * acidente:
   *
   * 1. `restaurado` — o par tinha os blocos, assinados pela minha própria chave de core, com
   *    a árvore de Merkle correspondente (`ACHADO-G14-01`, medido em `hypercore@11.35.2`).
   * 2. `inexistente` — houve contato e o par **não tem** o índice que falta. Como o
   *    `self_high_water` é gravado **antes** do append, um crash na janela entre os dois
   *    deixa `core.length = self_high_water − n` sem que nada tenha se perdido: o bloco nunca
   *    existiu. Confirmado isso, a marca era especulativa e volta para `core.length`.
   *
   * **Por que a saída 2 exige o par, em vez de um teste local.** A tentação é decidir por
   * `core.length === self_high_water − 1` e pronto — é local, é instantâneo, e acerta na
   * janela benigna. Ela erra no caso que a barreira existe para pegar: uma queda de energia
   * que encurte o core em um bloco **que o par já tem** produz exatamente a mesma leitura
   * local, e appendar ali é o fork de `ACHADO-G14-02`. Nenhum estado local separa "nunca
   * landou" de "landou e sumiu"; só o par separa. A alternativa que o achado também nomeia —
   * gravar o `self_high_water` de outra forma, por exemplo só depois do append — abriria a
   * janela inversa, em que um bloco durável não está coberto pela marca, e é justamente a
   * propriedade que §31.13 compra. Preferiu-se a espera à janela.
   *
   * Custo declarado: a conversa fica `desynced` até o próximo contato com o par. Um nó que
   * morreu na janela e nunca mais encontra o par não volta a escrever naquela conversa.
   */
  async recuperarDesynced(conversationId: string): Promise<
    { readonly ok: true; readonly resultado: DmRecomposicao['resultado'] | 'nada-a-fazer' } | DmFalha
  > {
    const row = this.#manifest.getDmConversation(conversationId);
    if (row === null) return falha('E_NOT_FOUND');
    const rt = this.#rt.get(conversationId);
    if (rt === undefined || rt.core === null) return falha('E_NOT_FOUND');
    if (rt.forked) return falha('E_DM_FORKED');
    if (!rt.desynced) return { ok: true, resultado: 'nada-a-fazer' };

    const r =
      this.#cores.recompor === undefined
        ? ({ resultado: 'indisponivel' } as const)
        : await this.#cores.recompor({
            conversationId,
            core: rt.core,
            alvo: row.self_high_water,
          });

    if (r.resultado === 'restaurado' && rt.core.length >= row.self_high_water) {
      rt.desynced = false;
    } else if (r.resultado === 'inexistente') {
      // A marca era especulativa: baixa-a para o que o core de fato tem. `raiseDmSelfHighWater`
      // é `MAX`, então quem baixa é o upsert da linha inteira — e ele só chega aqui com a
      // confirmação do par.
      this.#gravar(row, { selfHighWater: rt.core.length });
      rt.desynced = false;
    }
    if (!rt.desynced) {
      this.#emitir('dm.conversationChanged', { conversationId, fields: ['sync'] });
    }
    return { ok: true, resultado: r.resultado };
  }

  /**
   * §18.9 — bloco conflitante reportado pelo Hypercore (identidade restaurada em duas
   * máquinas escrevendo a mesma conversa, **L-4**). Para de appendar e **não há merge
   * automático, e não haverá**. Quem observa o `conflict` é quem monta a replicação (B58).
   */
  marcarForked(conversationId: string): void {
    const rt = this.#rt.get(conversationId);
    if (rt === undefined || rt.forked) return;
    rt.forked = true;
    rt.projetor?.stop();
    this.#emitir('dm.forked', { conversationId });
  }

  // ── §31.10 — o caminho de escrita ────────────────────────────────────────────────────

  /**
   * A **terceira classe de escrita** de §31.10: `core.append` no próprio core, resposta
   * síncrona, registro **já no log**. Não há outbox, não há fila e não há a que submeter.
   *
   * A ordem é normativa e é o item que `ACHADO-G14-02` mediu: **grava `self_high_water`
   * (`manifest.db`, `synchronous=FULL`), depois appenda**. Nunca o contrário, e nunca em
   * `desynced` — daí `E_DM_FORKED`.
   *
   * **Serializado por conversa** (§31.10, emenda de 2026-09-05). `core.length` só avança
   * quando o `await core.append` resolve; sem trava, dois `dm.send` em voo leem o mesmo
   * comprimento, e quem deriva `authorSeq = index + 1` assina o mesmo número duas vezes. Isso
   * quebra RD-3 no estágio 5 de §31.7.3, marca o lado `invalid`, e o estágio 7 torna a marca
   * **absorvente**: a conversa nunca mais aceita escrita própria. A trava é uma cadeia de
   * promessas por conversa — nada de fila durável, que §31.10 recusa: o que se serializa é a
   * janela entre ler o comprimento e appendar, não a entrega.
   *
   * Por isso `blocos` também pode ser uma **função do índice**: quem precisa do `authorSeq`
   * constrói o registro **dentro** da trava, com o comprimento que vai valer. Passar um array
   * pronto continua válido para quem não deriva nada dele.
   *
   * Durabilidade: vale §10.7.1 sem emenda. `await core.append(...)` é a barreira, cobre falha
   * de processo e **não** cobre queda de energia enquanto G4 não medir com `fsync` observado.
   */
  async append(
    conversationId: string,
    blocos: readonly Uint8Array[] | ((from: number) => readonly Uint8Array[]),
  ): Promise<{ readonly ok: true; readonly from: number; readonly to: number } | DmFalha> {
    return await this.#serializado(conversationId, async () => {
      const row = this.#manifest.getDmConversation(conversationId);
      if (row === null) return falha('E_NOT_FOUND');
      if (row.state === 'blocked') return falha('E_DM_BLOCKED');
      const rt = this.#rt.get(conversationId);
      if (rt === undefined || rt.core === null) {
        // §31.9 regra 1 — antes do aceite não existe o meu core, logo não existe onde appendar.
        return falha('E_DM_NOT_AUTHORIZED');
      }
      if (rt.forked || rt.desynced) return falha('E_DM_FORKED');

      const from = rt.core.length;
      const lote = typeof blocos === 'function' ? blocos(from) : blocos;
      if (lote.length === 0) return { ok: true, from, to: from };

      this.#manifest.raiseDmSelfHighWater(conversationId, from + lote.length);
      await rt.core.append(lote);
      return { ok: true, from, to: rt.core.length };
    });
  }

  /**
   * A cadeia de escrita de uma conversa. Cada entrada espera a anterior **terminar** (falha
   * inclusa: um erro não pode adiantar quem vem atrás para dentro da janela do anterior), e a
   * entrada só sai do mapa quando é a última — sem isso o mapa cresceria por conversa viva.
   */
  async #serializado<T>(conversationId: string, corpo: () => Promise<T>): Promise<T> {
    const anterior = this.#escritas.get(conversationId) ?? Promise.resolve();
    const minha = anterior.then(corpo, corpo);
    // A cadeia guarda a versão **neutralizada**: uma rejeição aqui é do chamador, não da
    // próxima escrita, e um `unhandledRejection` derrubaria o processo (§18.7).
    const elo = minha.then(
      () => undefined,
      () => undefined,
    );
    this.#escritas.set(conversationId, elo);
    try {
      return await minha;
    } finally {
      if (this.#escritas.get(conversationId) === elo) this.#escritas.delete(conversationId);
    }
  }

  // ── §31.9 — os cinco estados ─────────────────────────────────────────────────────────

  /**
   * `dm.open` de §31.16.1. Derivado, nunca atribuído: não existe registro de criação e não
   * existe negociação (§31.2 regra 1). Conversa que já existe é **retomada**, nunca duplicada
   * (§31.2 regra 3).
   *
   * Quem abre cria o próprio core na hora e escreve o `dm.hello` — é o lado `pending-out` da
   * tabela de §31.9 ("escrevo no meu core"). Quem **recebe** só cria o dele no aceite.
   */
  async abrir(peerKey: Uint8Array): Promise<
    { readonly ok: true; readonly conversationId: string; readonly state: DmConversationState } | DmFalha
  > {
    const conversationKey = this.#cripto.conversationKey(peerKey);
    if (conversationKey === null) return falha('E_VALIDATION', { field: 'peerKey' });
    const conversationId = conversationKey.toString('hex');
    const par = Buffer.from(peerKey);

    const existente = this.#manifest.getDmConversation(conversationId);
    if (existente !== null) {
      if (existente.state === 'blocked') return falha('E_DM_BLOCKED');
      if (existente.state === 'pending-in') {
        // Os dois abriram ao mesmo tempo: abrir é aceitar o que já chegou.
        const r = await this.aceitar(conversationId);
        return r.ok === true
          ? { ok: true, conversationId, state: 'accepted' }
          : r;
      }
      await this.#montar(existente);
      return { ok: true, conversationId, state: existente.state };
    }

    const teto = this.#contar(['accepted', 'pending-out']);
    if (teto >= this.#maxConversations) {
      return falha('E_LIMIT_EXCEEDED', { limit: this.#maxConversations });
    }

    const keyPair = this.#coreKeyPair(conversationKey);
    const agora = this.#now();
    this.#manifest.upsertDmConversation({
      conversationId,
      peerKey: par,
      selfCoreKey: keyPair.publicKey,
      selfCoreSeedEnc: this.#cripto.selarSemente?.(deriveDmCoreKeyPair(this.#identity.seed, conversationKey).seed) ?? null,
      peerCoreKey: null,
      state: 'pending-out',
      createdAt: agora,
      selfHighWater: 0,
    });
    const row = this.#manifest.getDmConversation(conversationId);
    /* c8 ignore next */
    if (row === null) return falha('E_NOT_FOUND');
    const rt = await this.#montar(row);
    await this.#genese(conversationId, rt);
    this.#emitir('dm.conversationChanged', { conversationId, fields: ['state'] });
    return { ok: true, conversationId, state: 'pending-out' };
  }

  /**
   * `dm.accept` de §31.16.1, e a regra 1 de §31.9: **aceitar é o que cria o meu core**. Antes
   * dele não existe `dm.hello` do meu lado, logo não existe `ack` meu, logo o outro lado não
   * observa entrega. Um pedido não aceito não confirma nada.
   */
  async aceitar(
    conversationId: string,
  ): Promise<{ readonly ok: true; readonly state: 'accepted' } | DmFalha> {
    const row = this.#manifest.getDmConversation(conversationId);
    if (row === null) return falha('E_NOT_FOUND');
    if (row.state === 'blocked') return falha('E_DM_BLOCKED');
    if (row.state === 'accepted') return { ok: true, state: 'accepted' };

    const teto = this.#contar(['accepted']);
    if (row.state !== 'pending-out' && teto >= this.#maxConversations) {
      return falha('E_LIMIT_EXCEEDED', { limit: this.#maxConversations });
    }

    this.#gravar(row, { state: 'accepted', acceptedAt: this.#now() });
    const atual = this.#manifest.getDmConversation(conversationId);
    /* c8 ignore next */
    if (atual === null) return falha('E_NOT_FOUND');
    this.#rt.delete(conversationId);
    const rt = await this.#montar(atual);
    await this.#genese(conversationId, rt);
    this.#emitir('dm.conversationChanged', { conversationId, fields: ['state'] });
    return { ok: true, state: 'accepted' };
  }

  /** RD-1 — `dm.hello` no índice 0 do meu core, e só quando o core ainda está vazio. */
  async #genese(conversationId: string, rt: Runtime): Promise<void> {
    if (rt.core === null) return;
    await this.append(conversationId, (from) => {
      if (from > 0 || rt.core === null) return [];
      return [
        this.#cripto.hello({
          conversationKey: rt.conversationKey,
          peerKey: rt.peerKey,
          selfCoreKey: rt.core.key,
        }),
      ];
    });
  }

  /**
   * `dm.block` — §31.9 regras 2 e 3. **Silencioso**: o bloqueado vê o mesmo que veria se eu
   * estivesse offline, e o `ack` dele simplesmente não avança. Não vai para log nenhum, porque
   * um bloqueio replicado seria o aviso que a regra 2 recusa dar (**L-28**). Não apaga nada.
   */
  bloquear(conversationId: string): { readonly ok: true } | DmFalha {
    const row = this.#manifest.getDmConversation(conversationId);
    if (row === null) return falha('E_NOT_FOUND');
    if (row.state === 'blocked') return { ok: true };
    this.#gravar(row, { state: 'blocked', blockedAt: this.#now() });
    const rt = this.#rt.get(conversationId);
    if (rt !== undefined) rt.projetor?.stop();
    // **Nenhum evento para o par.** `dm.conversationChanged` é IPC-R local (§31.16.2).
    this.#emitir('dm.conversationChanged', { conversationId, fields: ['state'] });
    return { ok: true };
  }

  /**
   * `dm.unblock`. O estado de volta é **derivado**, não lembrado: quem tem `accepted_at` volta
   * para `accepted`; quem nunca criou o próprio core volta para `pending-in`; o resto é
   * `pending-out`. Guardar um "estado anterior" seria uma coluna a mais para reconstruir o que
   * as três que já existem dizem.
   */
  async desbloquear(
    conversationId: string,
  ): Promise<{ readonly ok: true; readonly state: DmConversationState } | DmFalha> {
    const row = this.#manifest.getDmConversation(conversationId);
    if (row === null) return falha('E_NOT_FOUND');
    if (row.state !== 'blocked') return { ok: true, state: row.state };
    const state: DmConversationState =
      row.accepted_at !== null ? 'accepted' : row.self_high_water > 0 ? 'pending-out' : 'pending-in';
    this.#gravar(row, { state, blockedAt: null });
    const atual = this.#manifest.getDmConversation(conversationId);
    /* c8 ignore next */
    if (atual === null) return falha('E_NOT_FOUND');
    this.#rt.delete(conversationId);
    await this.#montar(atual);
    this.#emitir('dm.conversationChanged', { conversationId, fields: ['state'] });
    return { ok: true, state };
  }

  /**
   * `dm.forget` — §31.19, e a regra que parece bug e não é (**L-25**): limpa os blocos dos dois
   * cores e a projeção, mas **a linha de `dm_conversations` sobrevive para sempre**, reduzida a
   * `conversation_id`, `peer_key`, `self_core_key`, `self_high_water`, os dois
   * `forgotten_*_length` e `state = 'left'`.
   *
   * O motivo é o de sempre nesta seção: `core.length` precisa sobreviver. Sem ele, escrever de
   * novo produziria fork contra a cópia que o par tem — e o `conversationId` é derivado, então
   * não há como pedir um core novo para o mesmo par (§31.2 regra 4).
   *
   * `dm.forget` não é `dm.delete` e não é `dm.block`: nenhum byte do par é retirado da rede, e
   * o par não é avisado de nada.
   */
  async esquecer(conversationId: string): Promise<{ readonly ok: true } | DmFalha> {
    const row = this.#manifest.getDmConversation(conversationId);
    if (row === null) return falha('E_NOT_FOUND');
    const rt = this.#rt.get(conversationId);
    rt?.projetor?.stop();

    const selfLength = rt?.core?.length ?? row.forgotten_self_length ?? row.self_high_water;
    const peerLength = rt?.peerCore?.length ?? row.forgotten_peer_length ?? 0;
    if (this.#cores.limpar !== undefined) {
      if (rt?.core != null) await this.#cores.limpar({ conversationId, core: rt.core });
      if (rt?.peerCore != null) await this.#cores.limpar({ conversationId, core: rt.peerCore });
    }
    this.#projetor?.limpar?.(conversationId);

    const agora = this.#now();
    this.#gravar(row, {
      state: 'left',
      // Registros com índice **menor** que estes nunca voltam a ser projetados: é isso que
      // impede a conversa de "voltar" ao primeiro recontato (§31.19 regra 1).
      forgottenSelfLength: selfLength,
      forgottenPeerLength: peerLength,
      // `self_high_water` **não** é zerado: é o que impede o fork (regra 2).
      selfHighWater: Math.max(row.self_high_water, selfLength),
      removedAt: agora,
      retainUntil: agora + this.#retencaoMs,
      peerCoreKey: row.peer_core_key,
      acceptedAt: row.accepted_at,
      blockedAt: row.blocked_at,
    });
    this.#rt.delete(conversationId);
    this.#emitir('dm.conversationChanged', { conversationId, fields: ['state'] });
    return { ok: true };
  }

  // ── §31.8 — a política que B58 aplica no fio ─────────────────────────────────────────

  /**
   * §31.8(4), literal:
   *
   * ```
   * autorizaDm(par, conversa) =
   *     par === conversa.peerKey
   *     && conversa.state ∈ { 'accepted', 'pending-in', 'pending-out' }
   *     && conversa.blockedAt === null
   * ```
   *
   * É isso, e só isso, que impede um terceiro de replicar um core de DM cuja chave tenha
   * vazado. Quem **recusa o canal** é B58; aqui só se decide.
   */
  autorizaDm(peerKey: Uint8Array, conversationId: string): boolean {
    const row = this.#manifest.getDmConversation(conversationId);
    if (row === null) return false;
    if (!row.peer_key.equals(Buffer.from(peerKey))) return false;
    if (row.state !== 'accepted' && row.state !== 'pending-in' && row.state !== 'pending-out') {
      return false;
    }
    return row.blocked_at === null;
  }

  /**
   * A **política** do `dmHello` de §31.8 — o ponto de injeção que B58 chama depois de já ter
   * autenticado o transporte. Aqui não há fio: a `remotePublicKey` chega decidida, e a
   * conferência de `coreProof` contra ela é do canal.
   *
   * O vínculo de §31.8(2) é conferido mesmo assim, porque é barato e fecha transplante de
   * conversa antes de qualquer trabalho criptográfico caro: o `conversationId` anunciado tem
   * de ser exatamente o derivado do par de chaves.
   *
   * Ordem das recusas: **bloqueio primeiro**, e com o mesmo código de "canal recusado" que a
   * política de contato usa. Bloqueado e não-autorizado precisam ser indistinguíveis do outro
   * lado (§31.9 regra 2, §31.13 `unauthorized`), e devolver `E_DM_BLOCKED` aqui seria
   * exatamente o aviso que a regra recusa dar.
   */
  async receberHello(a: {
    readonly peerKey: Uint8Array;
    readonly conversationId: string;
    readonly coreKey: Buffer;
  }): Promise<
    { readonly ok: true; readonly state: DmConversationState; readonly selfCoreKey: Buffer | null } | DmFalha
  > {
    const conversationKey = this.#cripto.conversationKey(a.peerKey);
    if (conversationKey === null) return falha('E_VALIDATION', { field: 'peerKey' });
    if (conversationKey.toString('hex') !== a.conversationId) {
      return falha('E_DM_NOT_AUTHORIZED');
    }
    const par = Buffer.from(a.peerKey);
    const existente = this.#manifest.getDmConversation(a.conversationId);

    if (existente !== null) {
      if (existente.state === 'blocked') return falha('E_DM_NOT_AUTHORIZED');
      // RD-6 — a chave de core de um lado é imutável. Um handshake que anuncie chave diferente
      // da já vinculada é recusado, **nunca aceito e nunca sobrescrito**.
      if (existente.peer_core_key !== null && !existente.peer_core_key.equals(a.coreKey)) {
        return falha('E_DM_CORE_MISMATCH');
      }
      const vinculando = existente.peer_core_key === null;
      // §31.9 (emenda de 2026-09-05) — `pending-out` quer dizer "o outro ainda não aceitou", e
      // o `dm.hello` do par é a prova de que ele aceitou: pela regra 1, o core dele **só
      // existe depois do aceite**. Sem esta transição quem abriu ficava em `pending-out` para
      // sempre, com a conversa viva nos dois sentidos e a UI dizendo o contrário — e como o
      // estado é local e nunca replicado, não havia correção posterior. O estado continua
      // derivado, não lembrado: o que o move é a existência do core do outro lado.
      const aceitando = existente.state === 'pending-out';
      if (vinculando || aceitando) {
        this.#gravar(existente, {
          ...(vinculando ? { peerCoreKey: a.coreKey } : {}),
          ...(aceitando ? { state: 'accepted' as const, acceptedAt: this.#now() } : {}),
        });
        const atual = this.#manifest.getDmConversation(a.conversationId);
        /* c8 ignore next */
        if (atual === null) return falha('E_NOT_FOUND');
        this.#rt.delete(a.conversationId);
        await this.#montar(atual);
        this.#emitir('dm.conversationChanged', {
          conversationId: a.conversationId,
          fields: [...(vinculando ? ['peerCoreKey'] : []), ...(aceitando ? ['state'] : [])],
        });
      }
      const depois = this.#manifest.getDmConversation(a.conversationId) ?? existente;
      return {
        ok: true,
        state: depois.state,
        selfCoreKey: depois.state === 'pending-in' ? null : depois.self_core_key,
      };
    }

    // Primeiro contato. §31.9 regra 5 — filtro local de contato, que é a única defesa real
    // contra Sybil num sistema em que identidade é gratuita (**L-8**). O custo é declarado:
    // ligada, ninguém de fora consegue falar com você pela primeira vez.
    if (this.contactPolicy() === 'shared-community') {
      if (this.#compartilhaComunidade === null || !this.#compartilhaComunidade(par)) {
        return falha('E_DM_NOT_AUTHORIZED');
      }
    }
    // §31.9 regra 4 — teto de pendentes, **sem descarte silencioso do mais antigo**: um pedido
    // que o usuário nunca viu não pode sumir sem ele saber.
    if (this.#contar(['pending-in']) >= this.#pendingMax) {
      return falha('E_LIMIT_EXCEEDED', { limit: this.#pendingMax });
    }

    const keyPair = this.#coreKeyPair(conversationKey);
    this.#manifest.upsertDmConversation({
      conversationId: a.conversationId,
      peerKey: par,
      // Derivada, gravada como atalho e verificação cruzada (§31.12). O core em si **não** é
      // criado: aceitar é o que o cria (§31.9 regra 1).
      selfCoreKey: keyPair.publicKey,
      peerCoreKey: a.coreKey,
      state: 'pending-in',
      createdAt: this.#now(),
      selfHighWater: 0,
    });
    const row = this.#manifest.getDmConversation(a.conversationId);
    /* c8 ignore next */
    if (row === null) return falha('E_NOT_FOUND');
    await this.#montar(row);
    this.#emitir('dm.requested', { conversationId: a.conversationId, peerKey: par });
    return { ok: true, state: 'pending-in', selfCoreKey: null };
  }

  // ── §31.9 regra 5 — a preferência local ──────────────────────────────────────────────

  contactPolicy(): DmContactPolicy {
    return this.#manifest.dmPref(DM_CONTACT_POLICY_KEY) === 'shared-community'
      ? 'shared-community'
      : 'anyone';
  }

  setContactPolicy(policy: string): { readonly ok: true } | DmFalha {
    if (policy !== 'anyone' && policy !== 'shared-community') {
      return falha('E_VALIDATION', { field: 'policy' });
    }
    this.#manifest.setDmPref(DM_CONTACT_POLICY_KEY, policy);
    return { ok: true };
  }

  // ── Leitura ──────────────────────────────────────────────────────────────────────────

  conversa(conversationId: string): DmConversationRow | null {
    return this.#manifest.getDmConversation(conversationId);
  }

  listar(): DmConversationRow[] {
    return this.#manifest.listDmConversations();
  }

  /** §31.13 — o estado observável. `forked` e `desynced` são os dois que este módulo decide. */
  sync(conversationId: string): DmSyncState {
    const rt = this.#rt.get(conversationId);
    if (rt !== undefined && rt.forked) return 'forked';
    if (rt !== undefined && rt.desynced) return 'desynced';
    const row = this.#manifest.getDmConversation(conversationId);
    if (row !== null && row.state === 'blocked') return 'unauthorized';
    return this.#sincronizacao?.(conversationId) ?? 'peer-offline';
  }

  /** O core próprio, para quem monta a replicação (B58). `null` antes do aceite. */
  coreDe(conversationId: string): WritableCoreHandle | null {
    return this.#rt.get(conversationId)?.core ?? null;
  }

  coreDoPar(conversationId: string): CoreHandle | null {
    return this.#rt.get(conversationId)?.peerCore ?? null;
  }

  async close(): Promise<void> {
    for (const rt of this.#rt.values()) rt.projetor?.stop();
    this.#rt.clear();
  }

  // ── Internos ─────────────────────────────────────────────────────────────────────────

  #contar(estados: readonly DmConversationState[]): number {
    return this.#manifest.listDmConversations().filter((r) => estados.includes(r.state)).length;
  }

  /** `upsertDmConversation` com a linha inteira: o método é `INSERT … ON CONFLICT DO UPDATE`. */
  #gravar(
    row: DmConversationRow,
    patch: {
      state?: DmConversationState;
      peerCoreKey?: Buffer | null;
      acceptedAt?: number | null;
      blockedAt?: number | null;
      selfHighWater?: number;
      forgottenSelfLength?: number | null;
      forgottenPeerLength?: number | null;
      removedAt?: number | null;
      retainUntil?: number | null;
    },
  ): void {
    this.#manifest.upsertDmConversation({
      conversationId: row.conversation_id,
      peerKey: row.peer_key,
      selfCoreKey: row.self_core_key,
      selfCoreSeedEnc: row.self_core_seed_enc,
      peerCoreKey: patch.peerCoreKey !== undefined ? patch.peerCoreKey : row.peer_core_key,
      state: patch.state ?? row.state,
      createdAt: row.created_at,
      acceptedAt: patch.acceptedAt !== undefined ? patch.acceptedAt : row.accepted_at,
      blockedAt: patch.blockedAt !== undefined ? patch.blockedAt : row.blocked_at,
      selfHighWater: patch.selfHighWater ?? row.self_high_water,
      forgottenSelfLength:
        patch.forgottenSelfLength !== undefined
          ? patch.forgottenSelfLength
          : row.forgotten_self_length,
      forgottenPeerLength:
        patch.forgottenPeerLength !== undefined
          ? patch.forgottenPeerLength
          : row.forgotten_peer_length,
      removedAt: patch.removedAt !== undefined ? patch.removedAt : row.removed_at,
      retainUntil: patch.retainUntil !== undefined ? patch.retainUntil : row.retain_until,
    });
  }

  #emitir(topic: string, data: Readonly<Record<string, unknown>>): void {
    this.#onEvent({ topic, data });
  }
}
