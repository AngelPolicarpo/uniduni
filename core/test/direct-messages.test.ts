/**
 * `directMessages` (L2, §31) — o ciclo de vida da conversa direta.
 *
 * O teste que fecha o item é o **da ordem**, não o do caminho feliz: um nó que reabre com
 * `core.length < self_high_water` não appenda, emite `dm.desynced`, devolve `E_DM_FORKED` na
 * escrita, e só volta a appendar depois de recompor. `ACHADO-G14-02` mediu o contrafactual —
 * appendar antes de recompor produz dois blocos diferentes no mesmo índice assinados pela
 * mesma chave —, então o que aqui se verifica é a **precedência**, com um cabo que registra a
 * ordem das operações e uma asserção que quebra se um `append` aparecer antes do `recompor`.
 *
 * O `manifest.db` é real, em arquivo, com `synchronous=FULL`: é ele que a barreira de §31.13
 * usa, e substituí-lo por um mapa transformaria o teste da barreira num teste de mock. Os
 * cores são de mentira, pela mesma razão do cabo do `dmProjector`: a ordem em que os blocos
 * aparecem é o que se quer controlar. Os registros e as derivações são os de produto.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import sodium from 'sodium-native';

import type { CoreHandle, WritableCoreHandle } from '../src/l0/corestore/index.ts';
import { deriveDmCoreKeyPair } from '../src/l0/corestore/index.ts';
import { openManifestDb, type ManifestDb } from '../src/l0/manifest/index.ts';
import {
  DM_KINDS,
  DM_VERSION,
  decodeDmEnvelope,
  decodeDmOp,
  decodeDmPayload,
  dmContentKey,
  dmConversationKey,
  dmCorePossessionHash,
  dmOpSigningHash,
  encodeDmEnvelope,
  encodeDmOp,
  encodeDmPayload,
  openDmPayload,
  sealDmPayload,
  type DmHeader,
} from '../src/l1/dmCodec/index.ts';
import {
  DirectMessages,
  type DmCorePort,
  type DmCriptoPort,
  type DmEvent,
  type DmFalha,
  type DmRecomposicao,
} from '../src/l2/directMessages/index.ts';

import { dmKeypair, type Keypair } from './helpers/dm.ts';

// ─── Cabo ──────────────────────────────────────────────────────────────────────────────

const TEMPS: string[] = [];
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-l2-'));
  TEMPS.push(d);
  return d;
}
after(() => {
  for (const d of TEMPS) fs.rmSync(d, { recursive: true, force: true });
});

/** Um core escrevível em memória que **registra a ordem** das operações. */
class CoreEscrevivel implements WritableCoreHandle {
  readonly key: Buffer;
  readonly blocos: Uint8Array[] = [];
  readonly #ouvintes = new Set<() => void>();
  /** Trava de simulação de crash: o append grava no diário e depois lança. */
  falharNoProximoAppend = false;

  readonly diario: string[];

  constructor(key: Buffer, diario: string[]) {
    this.key = key;
    this.diario = diario;
  }

  get length(): number {
    return this.blocos.length;
  }

  get(seq: number): Promise<Uint8Array | null> {
    return Promise.resolve(this.blocos[seq] ?? null);
  }

  onAppend(l: () => void): () => void {
    this.#ouvintes.add(l);
    return () => this.#ouvintes.delete(l);
  }

  async append(blocks: readonly Uint8Array[]): Promise<void> {
    this.diario.push('append');
    if (this.falharNoProximoAppend) {
      this.falharNoProximoAppend = false;
      throw new Error('crash simulado entre a marca e o append');
    }
    for (const b of blocks) this.blocos.push(b);
    for (const l of [...this.#ouvintes]) l();
    return Promise.resolve();
  }

  /** Encurta o core, como uma queda de energia faria (§31.13). */
  encurtar(para: number): void {
    this.blocos.length = para;
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

type No = {
  readonly identity: Keypair;
  readonly seed: Buffer;
  readonly manifest: ManifestDb;
  readonly dm: DirectMessages;
  readonly eventos: DmEvent[];
  readonly diario: string[];
  readonly cores: Map<string, CoreEscrevivel>;
  readonly paresAbertos: Map<string, CoreHandle>;
  recomposicao: DmRecomposicao;
  projetados: string[];
};

function criarNo(rotulo: string, opcoes: Partial<Parameters<typeof montar>[2]> = {}): No {
  const identity = dmKeypair(rotulo);
  const seed = identity.secretKey.subarray(0, 32);
  const manifest = openManifestDb(path.join(tempDir(), 'manifest.db'));
  return montar(identity, seed, { manifest, ...opcoes });
}

function montar(
  identity: Keypair,
  seed: Buffer,
  o: {
    manifest: ManifestDb;
    compartilhaComunidade?: (k: Buffer) => boolean;
    pendingMax?: number;
    maxConversations?: number;
    cores?: Map<string, CoreEscrevivel>;
    diario?: string[];
  },
): No {
  const eventos: DmEvent[] = [];
  const diario = o.diario ?? [];
  const cores = o.cores ?? new Map<string, CoreEscrevivel>();
  const paresAbertos = new Map<string, CoreHandle>();
  const projetados: string[] = [];

  const no: No = {
    identity,
    seed,
    manifest: o.manifest,
    eventos,
    diario,
    cores,
    paresAbertos,
    recomposicao: { resultado: 'indisponivel' },
    projetados,
    dm: undefined as unknown as DirectMessages,
  } as No;

  // Portas de cripto: o `dmCodec` de produto, com a chave de identidade local dentro (§4).
  const cripto: DmCriptoPort = {
    conversationKey: (peerKey) => dmConversationKey(identity.publicKey, peerKey),
    hello: ({ conversationKey, peerKey, selfCoreKey }) => {
      const contentKey = dmContentKey(identity.secretKey, peerKey, conversationKey);
      assert.notEqual(contentKey, null);
      const proof = Buffer.alloc(sodium.crypto_sign_BYTES);
      sodium.crypto_sign_detached(
        proof,
        dmCorePossessionHash(conversationKey, selfCoreKey),
        identity.secretKey,
      );
      const header: DmHeader = {
        v: DM_VERSION,
        conversationId: conversationKey,
        kind: DM_KINDS['dm.hello'],
        author: identity.publicKey,
        authorSeq: 1,
        ts: 1_755_000_000_000,
        ack: 0,
      };
      const plaintext = encodeDmPayload('dm.hello', {
        peerKey,
        coreProof: proof,
        displayName: `nome-${identity.publicKey.toString('hex').slice(0, 4)}`,
        avatarColor: 1,
      });
      const payload = sealDm(contentKey as Buffer, header, plaintext);
      const opBytes = encodeDmOp({ ...header, payload });
      const sig = Buffer.alloc(sodium.crypto_sign_BYTES);
      sodium.crypto_sign_detached(sig, dmOpSigningHash(opBytes), identity.secretKey);
      return encodeDmEnvelope({ op: opBytes, sig });
    },
  };

  const coresPort: DmCorePort = {
    abrirProprio: ({ conversationId, keyPair }) => {
      const existente = cores.get(conversationId);
      if (existente !== undefined) return Promise.resolve(existente);
      const c = new CoreEscrevivel(keyPair.publicKey, diario);
      cores.set(conversationId, c);
      return Promise.resolve(c);
    },
    abrirDoPar: ({ conversationId, coreKey }) => {
      const c = paresAbertos.get(conversationId) ?? new CoreEscrevivel(coreKey, diario);
      paresAbertos.set(conversationId, c);
      return Promise.resolve(c);
    },
    recompor: ({ conversationId, core, alvo }) => {
      diario.push('recompor');
      if (no.recomposicao.resultado === 'restaurado') {
        const c = cores.get(conversationId) as CoreEscrevivel;
        assert.equal(c, core);
        while (c.blocos.length < alvo) c.blocos.push(Buffer.from([0]));
      }
      return Promise.resolve(no.recomposicao);
    },
    limpar: ({ core }) => {
      diario.push('limpar');
      (core as CoreEscrevivel).blocos.length = 0;
      return Promise.resolve();
    },
  };

  const dm = new DirectMessages({
    manifest: o.manifest,
    identity: { publicKey: identity.publicKey, seed },
    cripto,
    cores: coresPort,
    projetor: {
      montar: (a) => {
        // O conjunto do que está **montado agora**: remontar (vínculo de core, aceite) não
        // duplica a entrada.
        if (!projetados.includes(a.conversationId)) projetados.push(a.conversationId);
        return Promise.resolve({
          boot: () => Promise.resolve(),
          start: () => {},
          stop: () => {},
        });
      },
      limpar: (id) => projetados.splice(projetados.indexOf(id), 1),
    },
    onEvent: (ev) => eventos.push(ev),
    ...(o.compartilhaComunidade !== undefined
      ? { compartilhaComunidade: o.compartilhaComunidade }
      : {}),
    ...(o.pendingMax !== undefined ? { pendingMax: o.pendingMax } : {}),
    ...(o.maxConversations !== undefined ? { maxConversations: o.maxConversations } : {}),
  });
  // O objeto é o **mesmo** que as portas fecharam por cima: `recomposicao` é escrita pelo
  // teste e lida pela porta, e uma cópia por spread quebraria essa ligação em silêncio.
  return Object.assign(no, { dm });
}

function sealDm(key: Buffer, header: DmHeader, plaintext: Buffer): Buffer {
  const out = sealDmPayload(key, header, plaintext);
  assert.notEqual(out, null, 'sealDmPayload falhou');
  return out as Buffer;
}

function codigo(r: { ok: true } | DmFalha): string {
  assert.equal(r.ok, false, 'esperava falha e veio sucesso');
  return (r as DmFalha).code;
}

// ─── §31.2/§31.3 — derivação, com os dois lados reais ──────────────────────────────────

describe('§31.2/§31.3 — derivação simétrica, medida dos dois lados', () => {
  it('os dois nós computam o mesmo `conversationId` e a mesma `dmContentKey`, sem trocar nada', () => {
    const a = dmKeypair('alice');
    const b = dmKeypair('bob');

    // §31.2 regra 2: `id(A,B) = id(B,A)`, por ordenação de byte, sem convenção de "quem começou".
    const ida = dmConversationKey(a.publicKey, b.publicKey);
    const idb = dmConversationKey(b.publicKey, a.publicKey);
    assert.notEqual(ida, null);
    assert.deepEqual(ida, idb);

    // §31.3 regra 3: cada lado a computa do **próprio** segredo e da chave pública do outro.
    const ka = dmContentKey(a.secretKey, b.publicKey, ida as Buffer);
    const kb = dmContentKey(b.secretKey, a.publicKey, idb as Buffer);
    assert.notEqual(ka, null);
    assert.deepEqual(ka, kb);
    assert.equal((ka as Buffer).length, sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
  });

  it('a chave de conteúdo de um par não abre a de outro (§5.2 — prefixo por domínio)', () => {
    const a = dmKeypair('alice');
    const b = dmKeypair('bob');
    const c = dmKeypair('carol');
    const ab = dmConversationKey(a.publicKey, b.publicKey) as Buffer;
    const ac = dmConversationKey(a.publicKey, c.publicKey) as Buffer;
    assert.notDeepEqual(
      dmContentKey(a.secretKey, b.publicKey, ab),
      dmContentKey(a.secretKey, c.publicKey, ac),
    );
    // O mesmo par, `conversationId` trocado, também muda a chave: o id entra na derivação.
    assert.notDeepEqual(
      dmContentKey(a.secretKey, b.publicKey, ab),
      dmContentKey(a.secretKey, b.publicKey, ac),
    );
  });

  it('`dmCoreSeed` é do lado, não do par: cada um deriva só a própria metade (§31.3 regra 2)', () => {
    const a = dmKeypair('alice');
    const b = dmKeypair('bob');
    const cid = dmConversationKey(a.publicKey, b.publicKey) as Buffer;
    const ca = deriveDmCoreKeyPair(a.secretKey.subarray(0, 32), cid);
    const cb = deriveDmCoreKeyPair(b.secretKey.subarray(0, 32), cid);
    assert.notDeepEqual(ca.publicKey, cb.publicKey);
    // Determinístico: restaurar a identidade recupera a própria metade (§31.3 regra 1, §5.5).
    assert.deepEqual(deriveDmCoreKeyPair(a.secretKey.subarray(0, 32), cid).seed, ca.seed);
  });

  it('conversa consigo mesmo é `E_VALIDATION.peerKey`, não um código novo (§31.17)', async () => {
    const a = criarNo('alice');
    const r = await a.dm.abrir(a.identity.publicKey);
    assert.equal(codigo(r), 'E_VALIDATION');
    assert.equal((r as DmFalha).field, 'peerKey');
  });
});

// ─── §31.13 — a ordem, que é o que fecha o item ────────────────────────────────────────

describe('§31.13 — `self_high_water`, `desynced` e a ordem de `ACHADO-G14-02`', () => {
  it('a marca sobe ANTES do append: um crash no meio deixa `core.length = marca − 1`', async () => {
    const a = criarNo('alice');
    const b = dmKeypair('bob');
    const r = await a.dm.abrir(b.publicKey);
    assert.equal(r.ok, true);
    const id = (r as { conversationId: string }).conversationId;

    const core = a.cores.get(id) as CoreEscrevivel;
    assert.equal(core.length, 1, 'o `dm.hello` de gênese está no índice 0 (RD-1)');
    assert.equal(a.manifest.getDmConversation(id)?.self_high_water, 1);

    core.falharNoProximoAppend = true;
    await assert.rejects(a.dm.append(id, [Buffer.from([1, 2, 3])]));

    // A marca já subiu; o bloco não existe. É exatamente a janela de `ACHADO-G14-05`.
    assert.equal(a.manifest.getDmConversation(id)?.self_high_water, 2);
    assert.equal(core.length, 1);
  });

  it('reabrir com `core.length < self_high_water` não appenda, emite `dm.desynced` e recusa a escrita', async () => {
    const a = criarNo('alice');
    const b = dmKeypair('bob');
    const id = ((await a.dm.abrir(b.publicKey)) as { conversationId: string }).conversationId;
    await a.dm.append(id, [Buffer.from('um'), Buffer.from('dois')]);
    const core = a.cores.get(id) as CoreEscrevivel;
    assert.equal(core.length, 3);
    assert.equal(a.manifest.getDmConversation(id)?.self_high_water, 3);

    // Queda de energia: o core reabre mais curto do que já esteve (§10.7.1 não alcança).
    core.encurtar(1);

    const b2 = montar(a.identity, a.seed, { manifest: a.manifest, cores: a.cores });
    a.diario.length = 0;
    await b2.dm.boot();

    assert.equal(b2.dm.sync(id), 'desynced');
    const ev = b2.eventos.find((e) => e.topic === 'dm.desynced');
    assert.notEqual(ev, undefined);
    assert.deepEqual(ev?.data, { conversationId: id, coreLength: 1, highWater: 3 });

    assert.equal(codigo(await b2.dm.append(id, [Buffer.from('três')])), 'E_DM_FORKED');
    assert.equal(core.length, 1, 'nenhum bloco entrou no core encurtado');
    assert.deepEqual(
      a.diario.filter((d) => d === 'append'),
      [],
      'o boot em `desynced` não appendou nada',
    );
  });

  it('só volta a appendar DEPOIS de recompor — e o `recompor` vem antes de todo `append`', async () => {
    const a = criarNo('alice');
    const b = dmKeypair('bob');
    const id = ((await a.dm.abrir(b.publicKey)) as { conversationId: string }).conversationId;
    await a.dm.append(id, [Buffer.from('um'), Buffer.from('dois')]);
    const core = a.cores.get(id) as CoreEscrevivel;
    core.encurtar(1);

    // O diário é o do core, que sobrevive à reabertura: é nele que `append` e `recompor`
    // entram, e é a ordem entre os dois que este teste mede.
    const diario = a.diario;
    diario.length = 0;
    const b2 = montar(a.identity, a.seed, { manifest: a.manifest, cores: a.cores, diario });
    await b2.dm.boot();

    // Enquanto a recomposição não acontece, escrever é `E_DM_FORKED` — e nada vai para o log.
    assert.equal(codigo(await b2.dm.append(id, [Buffer.from('x')])), 'E_DM_FORKED');
    assert.equal(codigo(await b2.dm.append(id, [Buffer.from('y')])), 'E_DM_FORKED');

    // Sem contato com o par não se conclui nada: continua `desynced` (§31.13).
    b2.recomposicao = { resultado: 'indisponivel' };
    assert.deepEqual(await b2.dm.recuperarDesynced(id), { ok: true, resultado: 'indisponivel' });
    assert.equal(b2.dm.sync(id), 'desynced');
    assert.equal(codigo(await b2.dm.append(id, [Buffer.from('z')])), 'E_DM_FORKED');

    // `ACHADO-G14-01` — o par tem os blocos, assinados pela minha própria chave de core.
    b2.recomposicao = { resultado: 'restaurado' };
    assert.deepEqual(await b2.dm.recuperarDesynced(id), { ok: true, resultado: 'restaurado' });
    assert.equal(b2.dm.sync(id), 'peer-offline');

    const ok = await b2.dm.append(id, [Buffer.from('depois')]);
    assert.equal(ok.ok, true);

    // A asserção que mede `ACHADO-G14-02`: o primeiro `append` desta sessão é posterior ao
    // primeiro `recompor`. Ela falha se o caminho de escrita appendar antes de recompor.
    const primeiroAppend = diario.indexOf('append');
    const primeiroRecompor = diario.indexOf('recompor');
    assert.notEqual(primeiroAppend, -1);
    assert.notEqual(primeiroRecompor, -1);
    assert.ok(
      primeiroRecompor < primeiroAppend,
      `appendou antes de recompor: ${JSON.stringify(diario)}`,
    );
  });

  it('`ACHADO-G14-05` — com o par confirmando que o índice nunca existiu, a marca desce', async () => {
    const a = criarNo('alice');
    const b = dmKeypair('bob');
    const id = ((await a.dm.abrir(b.publicKey)) as { conversationId: string }).conversationId;
    const core = a.cores.get(id) as CoreEscrevivel;

    core.falharNoProximoAppend = true;
    await assert.rejects(a.dm.append(id, [Buffer.from('perdido')]));
    assert.equal(a.manifest.getDmConversation(id)?.self_high_water, 2);
    assert.equal(core.length, 1);

    const b2 = montar(a.identity, a.seed, { manifest: a.manifest, cores: a.cores });
    await b2.dm.boot();
    assert.equal(b2.dm.sync(id), 'desynced', 'a regra de §31.13 é conservadora nesta janela');

    b2.recomposicao = { resultado: 'inexistente' };
    assert.deepEqual(await b2.dm.recuperarDesynced(id), { ok: true, resultado: 'inexistente' });

    assert.equal(b2.dm.sync(id), 'peer-offline');
    assert.equal(
      b2.manifest.getDmConversation(id)?.self_high_water,
      1,
      'a marca especulativa voltou para o que o core tem',
    );
    assert.equal((await b2.dm.append(id, [Buffer.from('de novo')])).ok, true);
    assert.equal(core.length, 2);
  });

  it('a marca só desce com confirmação do par: `indisponivel` a deixa onde está', async () => {
    const a = criarNo('alice');
    const b = dmKeypair('bob');
    const id = ((await a.dm.abrir(b.publicKey)) as { conversationId: string }).conversationId;
    const core = a.cores.get(id) as CoreEscrevivel;
    core.falharNoProximoAppend = true;
    await assert.rejects(a.dm.append(id, [Buffer.from('perdido')]));

    const b2 = montar(a.identity, a.seed, { manifest: a.manifest, cores: a.cores });
    await b2.dm.boot();
    b2.recomposicao = { resultado: 'indisponivel' };
    await b2.dm.recuperarDesynced(id);
    assert.equal(b2.manifest.getDmConversation(id)?.self_high_water, 2);
    assert.equal(b2.dm.sync(id), 'desynced');
  });

  it('§18.9 — `forked` é terminal e não tem merge automático', async () => {
    const a = criarNo('alice');
    const id = ((await a.dm.abrir(dmKeypair('bob').publicKey)) as { conversationId: string })
      .conversationId;
    a.dm.marcarForked(id);
    assert.equal(a.dm.sync(id), 'forked');
    assert.equal(codigo(await a.dm.append(id, [Buffer.from('x')])), 'E_DM_FORKED');
    assert.equal(codigo(await a.dm.recuperarDesynced(id)), 'E_DM_FORKED');
    assert.equal(a.eventos.filter((e) => e.topic === 'dm.forked').length, 1);
  });
});

// ─── §31.9 — os cinco estados ──────────────────────────────────────────────────────────

describe('§31.9 — aceite, bloqueio silencioso, teto de pendentes e política de contato', () => {
  it('abrir cria o meu core e escreve o `dm.hello` no índice 0 (RD-1)', async () => {
    const a = criarNo('alice');
    const b = dmKeypair('bob');
    const r = (await a.dm.abrir(b.publicKey)) as { ok: true; conversationId: string; state: string };
    assert.equal(r.state, 'pending-out');

    const core = a.cores.get(r.conversationId) as CoreEscrevivel;
    const env = decodeDmEnvelope(core.blocos[0] as Uint8Array);
    const op = decodeDmOp((env as { op: Buffer }).op);
    assert.equal(op?.kind, DM_KINDS['dm.hello']);
    assert.equal(op?.authorSeq, 1);
    assert.equal(op?.ack, 0);

    // O payload abre com a chave que **o par** deriva sozinho — §31.3 regra 3, dos dois lados.
    const ck = dmContentKey(b.secretKey, a.identity.publicKey, op!.conversationId) as Buffer;
    const { payload, ...cabecalho } = op as NonNullable<typeof op>;
    const claro = openDmPayload(ck, cabecalho, payload);
    assert.notEqual(claro, null);
    const hello = decodeDmPayload('dm.hello', claro as Buffer);
    assert.deepEqual(hello?.peerKey, b.publicKey);
    assert.deepEqual(hello?.coreProof.length, sodium.crypto_sign_BYTES);
  });

  it('`pending-in` NÃO cria o meu core: aceitar é o ato (§31.9 regra 1)', async () => {
    const a = criarNo('alice');
    const b = criarNo('bob');
    const ida = (await a.dm.abrir(b.identity.publicKey)) as { conversationId: string };
    const coreA = a.cores.get(ida.conversationId) as CoreEscrevivel;

    const r = await b.dm.receberHello({
      peerKey: a.identity.publicKey,
      conversationId: ida.conversationId,
      coreKey: coreA.key,
    });
    assert.equal(r.ok, true);
    assert.equal((r as { state: string }).state, 'pending-in');
    assert.equal((r as { selfCoreKey: Buffer | null }).selfCoreKey, null);
    assert.equal(b.cores.size, 0, 'nenhum core meu antes do aceite');
    assert.equal(b.eventos.filter((e) => e.topic === 'dm.requested').length, 1);

    // Escrever antes do aceite não tem onde acontecer.
    assert.equal(
      codigo(await b.dm.append(ida.conversationId, [Buffer.from('x')])),
      'E_DM_NOT_AUTHORIZED',
    );

    assert.deepEqual(await b.dm.aceitar(ida.conversationId), { ok: true, state: 'accepted' });
    const coreB = b.cores.get(ida.conversationId) as CoreEscrevivel;
    assert.equal(coreB.length, 1, 'o aceite escreveu o `dm.hello`');
    assert.equal(b.manifest.getDmConversation(ida.conversationId)?.self_high_water, 1);
  });

  it('bloqueio é silencioso: o par vê `E_DM_NOT_AUTHORIZED`, indistinguível de política (regra 2)', async () => {
    const a = criarNo('alice');
    const b = criarNo('bob');
    const ida = (await a.dm.abrir(b.identity.publicKey)) as { conversationId: string };
    const coreA = a.cores.get(ida.conversationId) as CoreEscrevivel;

    await b.dm.receberHello({
      peerKey: a.identity.publicKey,
      conversationId: ida.conversationId,
      coreKey: coreA.key,
    });
    assert.deepEqual(b.dm.bloquear(ida.conversationId), { ok: true });

    // O bloqueado recebe o mesmo código que a política de contato dá — nunca `E_DM_BLOCKED`,
    // que seria o aviso que a regra 2 recusa dar (**L-28**).
    const r = await b.dm.receberHello({
      peerKey: a.identity.publicKey,
      conversationId: ida.conversationId,
      coreKey: coreA.key,
    });
    assert.equal(codigo(r), 'E_DM_NOT_AUTHORIZED');
    assert.equal(b.dm.autorizaDm(a.identity.publicKey, ida.conversationId), false);

    // Nada foi para log nenhum (regra 3): o core do par não ganhou bloco, e eu não tenho core.
    assert.equal(b.cores.size, 0);

    // Localmente, sim, o bloqueio é um estado nomeado.
    assert.equal(codigo(await b.dm.aceitar(ida.conversationId)), 'E_DM_BLOCKED');
    assert.equal(b.dm.sync(ida.conversationId), 'unauthorized');

    const volta = await b.dm.desbloquear(ida.conversationId);
    assert.deepEqual(volta, { ok: true, state: 'pending-in' });
    assert.equal(b.dm.autorizaDm(a.identity.publicKey, ida.conversationId), true);
  });

  it('teto de pendentes é `E_LIMIT_EXCEEDED` com `limit`, e não descarta o mais antigo (regra 4)', async () => {
    const b = criarNo('bob', { pendingMax: 2 });
    const pedidos = ['p1', 'p2', 'p3'].map((r) => dmKeypair(r));
    const ids: string[] = [];
    for (const p of pedidos.slice(0, 2)) {
      const cid = dmConversationKey(p.publicKey, b.identity.publicKey) as Buffer;
      const r = await b.dm.receberHello({
        peerKey: p.publicKey,
        conversationId: cid.toString('hex'),
        coreKey: dmKeypair(`core-${cid.toString('hex').slice(0, 4)}`).publicKey,
      });
      assert.equal(r.ok, true);
      ids.push(cid.toString('hex'));
    }

    const terceiro = pedidos[2] as Keypair;
    const cid3 = dmConversationKey(terceiro.publicKey, b.identity.publicKey) as Buffer;
    const r3 = await b.dm.receberHello({
      peerKey: terceiro.publicKey,
      conversationId: cid3.toString('hex'),
      coreKey: dmKeypair('core-3').publicKey,
    });
    assert.equal(codigo(r3), 'E_LIMIT_EXCEEDED');
    assert.equal((r3 as DmFalha).limit, 2);

    // Sem descarte silencioso: um pedido que o usuário nunca viu não pode sumir sem ele saber.
    for (const id of ids) assert.notEqual(b.dm.conversa(id), null);
    assert.equal(b.dm.conversa(cid3.toString('hex')), null);
  });

  it('política `shared-community` recusa o primeiro contato sem comunidade em comum (regra 5)', async () => {
    const conhecidos = new Set<string>();
    const b = criarNo('bob', {
      compartilhaComunidade: (k) => conhecidos.has(k.toString('hex')),
    });
    assert.equal(b.dm.contactPolicy(), 'anyone');
    assert.deepEqual(b.dm.setContactPolicy('shared-community'), { ok: true });
    assert.equal(b.dm.contactPolicy(), 'shared-community');
    assert.equal(codigo(b.dm.setContactPolicy('ninguem')), 'E_VALIDATION');

    const estranho = dmKeypair('estranho');
    const cid = dmConversationKey(estranho.publicKey, b.identity.publicKey) as Buffer;
    assert.equal(
      codigo(
        await b.dm.receberHello({
          peerKey: estranho.publicKey,
          conversationId: cid.toString('hex'),
          coreKey: dmKeypair('core-estranho').publicKey,
        }),
      ),
      'E_DM_NOT_AUTHORIZED',
    );

    conhecidos.add(estranho.publicKey.toString('hex'));
    assert.equal(
      (
        await b.dm.receberHello({
          peerKey: estranho.publicKey,
          conversationId: cid.toString('hex'),
          coreKey: dmKeypair('core-estranho').publicKey,
        })
      ).ok,
      true,
    );
  });

  it('RD-6 — chave de core do par é imutável: a segunda é `E_DM_CORE_MISMATCH`', async () => {
    const a = criarNo('alice');
    const b = criarNo('bob');
    const ida = (await a.dm.abrir(b.identity.publicKey)) as { conversationId: string };
    const primeira = (a.cores.get(ida.conversationId) as CoreEscrevivel).key;

    await b.dm.receberHello({
      peerKey: a.identity.publicKey,
      conversationId: ida.conversationId,
      coreKey: primeira,
    });
    const r = await b.dm.receberHello({
      peerKey: a.identity.publicKey,
      conversationId: ida.conversationId,
      coreKey: dmKeypair('core-forjado').publicKey,
    });
    assert.equal(codigo(r), 'E_DM_CORE_MISMATCH');
    assert.deepEqual(
      b.manifest.getDmConversation(ida.conversationId)?.peer_core_key,
      primeira,
      'nunca sobrescrita',
    );
  });

  it('§31.8(2) — `conversationId` que não bate com o par é recusado antes de tudo', async () => {
    const b = criarNo('bob');
    const par = dmKeypair('alice');
    const outro = dmConversationKey(dmKeypair('carol').publicKey, b.identity.publicKey) as Buffer;
    const r = await b.dm.receberHello({
      peerKey: par.publicKey,
      conversationId: outro.toString('hex'),
      coreKey: dmKeypair('core-x').publicKey,
    });
    assert.equal(codigo(r), 'E_DM_NOT_AUTHORIZED');
    assert.equal(b.dm.listar().length, 0);
  });

  it('teto de conversas é `E_LIMIT_EXCEEDED` com `limit` (§31.18)', async () => {
    const a = criarNo('alice', { maxConversations: 1 });
    assert.equal((await a.dm.abrir(dmKeypair('b1').publicKey)).ok, true);
    const r = await a.dm.abrir(dmKeypair('b2').publicKey);
    assert.equal(codigo(r), 'E_LIMIT_EXCEEDED');
    assert.equal((r as DmFalha).limit, 1);
  });

  it('abrir uma conversa que já existe a retoma, nunca a duplica (§31.2 regra 3)', async () => {
    const a = criarNo('alice');
    const b = dmKeypair('bob');
    const r1 = (await a.dm.abrir(b.publicKey)) as { conversationId: string };
    const r2 = (await a.dm.abrir(b.publicKey)) as { conversationId: string; state: string };
    assert.equal(r2.conversationId, r1.conversationId);
    assert.equal(r2.state, 'pending-out');
    assert.equal(a.dm.listar().length, 1);
    assert.equal((a.cores.get(r1.conversationId) as CoreEscrevivel).length, 1, 'uma gênese só');
  });

  it('chamadas concorrentes a abrir criam exatamente uma gênese no core (RD-1)', async () => {
    const a = criarNo('alice');
    const b = dmKeypair('bob');
    const [r1, r2] = await Promise.all([
      a.dm.abrir(b.publicKey),
      a.dm.abrir(b.publicKey),
    ]);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    const id = (r1 as { conversationId: string }).conversationId;
    const core = a.cores.get(id) as CoreEscrevivel;
    assert.equal(core.length, 1, 'exatamente um dm.hello no índice 0');
  });

  it('abrir com um pedido já pendente aceita, em vez de criar uma segunda conversa', async () => {
    const a = criarNo('alice');
    const b = criarNo('bob');
    const ida = (await a.dm.abrir(b.identity.publicKey)) as { conversationId: string };
    await b.dm.receberHello({
      peerKey: a.identity.publicKey,
      conversationId: ida.conversationId,
      coreKey: (a.cores.get(ida.conversationId) as CoreEscrevivel).key,
    });
    const r = (await b.dm.abrir(a.identity.publicKey)) as { conversationId: string; state: string };
    assert.equal(r.conversationId, ida.conversationId);
    assert.equal(r.state, 'accepted');
    assert.equal(b.dm.listar().length, 1);
  });
});

// ─── §31.19 — a linha que sobrevive ────────────────────────────────────────────────────

describe('§31.19 — `dm.forget` e a linha que fica para sempre (L-25)', () => {
  it('limpa blocos e projeção, mas mantém a linha, `self_high_water` e as marcas', async () => {
    const a = criarNo('alice');
    const b = criarNo('bob');
    const id = ((await a.dm.abrir(b.identity.publicKey)) as { conversationId: string })
      .conversationId;
    await a.dm.append(id, [Buffer.from('um'), Buffer.from('dois')]);
    await a.dm.receberHello({
      peerKey: b.identity.publicKey,
      conversationId: id,
      coreKey: dmKeypair('core-bob').publicKey,
    });
    assert.deepEqual(a.projetados, [id]);

    assert.deepEqual(await a.dm.esquecer(id), { ok: true });

    const row = a.manifest.getDmConversation(id);
    assert.notEqual(row, null, 'a linha sobrevive para sempre (§31.19 regra 2)');
    assert.equal(row?.state, 'left');
    assert.equal(row?.self_high_water, 3, '`core.length` precisa sobreviver, senão forka');
    assert.equal(row?.forgotten_self_length, 3);
    assert.notEqual(row?.removed_at, null);
    assert.notEqual(row?.retain_until, null);
    assert.equal((a.cores.get(id) as CoreEscrevivel).length, 0, 'os blocos saíram');
    assert.deepEqual(a.projetados, [], 'a projeção saiu — e quem a apaga é o projetor (§21.1)');

    // §31.8(4): `left` não está entre os estados que autorizam canal.
    assert.equal(a.dm.autorizaDm(b.identity.publicKey, id), false);
    // O boot não remonta core de conversa esquecida.
    const b2 = montar(a.identity, a.seed, { manifest: a.manifest });
    await b2.dm.boot();
    assert.deepEqual(b2.projetados, []);
  });
});
