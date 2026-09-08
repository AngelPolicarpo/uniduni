// §56 — a superfície de identidade e o ciclo do núcleo que faltavam no roteador. O que
// cada asserção fixa:
//
//   §3.3   — boot sem identidade para em `awaiting-identity`; standard recusa; o
//            `identity.create` vira evento `core.ready` (§15.5) e libera as escritas;
//   §15.4  — coluna Erros da tabela (`E_IDENTITY_EXISTS`, `E_VALIDATION`,
//            `E_KEYSTORE_UNAVAILABLE`, `E_KEYSTORE_INSECURE`); `identity.update` é **A**,
//            UMA op por comunidade, resposta `{queued:[...]}`;
//   §6.1   — presença local é a tabela fechada; `invisible` não publica;
//   §15.6  — `CoreStatus` completo; `query.identity`.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { ManifestDb } from '../src/l0/manifest/index.ts';
import { openViewDb } from '../src/l0/view/index.ts';
import { Swarm } from '../src/l0/swarm/index.ts';
import { IdentityManager } from '../src/l0/identity/index.ts';
import { FallbackKeystoreOracle, acceptInsecure } from '../src/l0/keystore/index.ts';
import { MemoryIpcPort } from '../src/l3/ipcRenderer/index.ts';
import type { CoreRuntime } from '../src/composition/boot.ts';
import { bootCore } from '../src/composition/boot.ts';
import { CHAVE_MODO_KEYSTORE, composeKeystore, conciliarModoKeystore } from '../src/composition/identity.ts';
import { tempDir } from './helpers/composition.ts';
import { OP_VERSION } from '../src/l1/opCodec/index.ts';
import { silentLogger } from '../src/composition/logger.ts';
import { T0 } from './helpers/world.ts';

const DATA_KEY = Buffer.alloc(32, 77);

type Frame = Record<string, unknown>;
type Resposta = { ok: boolean; data: unknown; code: string | null };

/** Mesmo cabo dos rigs anteriores: UM listener distribuindo respostas e eventos. */
function cabo(rendererSide: MemoryIpcPort) {
  const pendentes = new Map<number, (r: Resposta) => void>();
  const assinaturas = new Map<number, Frame[]>();
  let proximoId = 9000;
  rendererSide.onMessage((raw) => {
    const frame = raw as Frame;
    if (frame['t'] === 'res') {
      const resolver = pendentes.get(frame['id'] as number);
      if (resolver !== undefined) {
        pendentes.delete(frame['id'] as number);
        const erro = frame['err'] as { code?: string } | undefined;
        resolver({ ok: frame['ok'] as boolean, data: frame['data'], code: erro?.code ?? null });
      }
      return;
    }
    if (frame['t'] === 'ev') assinaturas.get(frame['subId'] as number)?.push(frame['data'] as Frame);
  });
  return {
    async request(cmd: string, arg: unknown): Promise<Resposta> {
      const id = ++proximoId;
      return await new Promise<Resposta>((resolve) => {
        pendentes.set(id, resolve);
        rendererSide.postMessage({ t: 'req', epoch: 1, id, cmd, arg, authToken: 'ok' });
      });
    },
    assinar(topic: string): Frame[] {
      const id = ++proximoId;
      const lista: Frame[] = [];
      rendererSide.postMessage({ t: 'sub', epoch: 1, id, topic });
      rendererSide.onMessage((raw) => {
        const f = raw as Frame;
        if (f['t'] === 'subOk' && f['id'] === id) assinaturas.set(f['subId'] as number, lista);
      });
      // O `MemoryIpcPort` entrega por microtask: drenar antes do caminho síncrono.
      return lista;
    },
  };
}

async function esperar(cond: () => boolean, msg: string, timeoutMs = 10_000): Promise<void> {
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`${msg} (esperou ${timeoutMs} ms)`);
}

/**
 * Rig de modo HOSPEDEIRO com identidade REAL (`IdentityManager` sobre o manifest do rig).
 * Com `semIdentidade`, o boot nasce `awaiting-identity` — é o caso do primeiro uso.
 */
async function rigHost(
  rotulo: string,
  opts: { readonly semIdentidade?: boolean } = {},
): Promise<{
  runtime: CoreRuntime;
  manager: IdentityManager;
  manifest: ManifestDb;
  io: ReturnType<typeof cabo>;
  dir: string;
  bundles: Buffer[];
  saiu: { valor: boolean };
  limpo: { valor: boolean };
  fechar(): Promise<void>;
}> {
  const dir = tempDir(rotulo);
  const manifest = new ManifestDb(path.join(dir, 'manifest.db'));
  const view = openViewDb(path.join(dir, 'view.db'));
  const manager = new IdentityManager(dir, new FallbackKeystoreOracle(), manifest);
  if (!opts.semIdentidade) await manager.create('Dona Raiz', 3);
  acceptInsecure(dir, 'rig');
  const [coreSide, rendererSide] = MemoryIpcPort.createPair();
  const bundles: Buffer[] = [];
  const saiu = { valor: false };
  const runtime: CoreRuntime = await bootCore({
    dataDir: dir,
    manifest,
    view,
    swarm: new Swarm(),
    dataKey: DATA_KEY,
    identity: () => manager.getKeyPair(),
    identityManager: manager,
    foldBuildId: `shell-56-${rotulo}`,
    ipcPort: coreSide,
    epoch: 1,
    tokenVerifier: { consume: () => true },
    hostTurnSecret: () => Buffer.alloc(32, 7),
    now: () => T0 + 1000,
    schedule: () => 0,
    cancel: () => {},
    logger: silentLogger(),
    saveFile: async ({ data }) => {
      bundles.push(data);
      return { ok: true };
    },
    readFile: async () => (bundles.length > 0 ? (bundles[bundles.length - 1] as Buffer) : null),
    exit: () => {
      saiu.valor = true;
    },
  });
  const vivo = setInterval(() => {}, 5);
  const io = cabo(rendererSide);
  const limpo = { valor: false };
  return {
    runtime,
    manager,
    manifest,
    io,
    dir,
    bundles,
    saiu,
    limpo,
    async fechar() {
      if (limpo.valor) {
        clearInterval(vivo);
        return;
      }
      limpo.valor = true;
      clearInterval(vivo);
      if (runtime.phase !== 'stopped') await runtime.close().catch(() => {});
      try {
        view.close();
      } catch {}
      try {
        manifest.close();
      } catch {}
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    },
  };
}

describe('§56.1 ciclo de §3.3 — awaiting-identity → ready com evento', () => {
  it('boot sem identidade: phase awaiting-identity, standard recusa, create vira core.ready e abre a fila', async () => {
    const r = await rigHost('awaiting', { semIdentidade: true });
    try {
      assert.equal(r.runtime.phase, 'awaiting-identity');
      const prontos = r.io.assinar('core.ready');
      await new Promise((res) => setImmediate(res));

      const status = await r.io.request('core.status', {});
      assert.ok(status.ok, JSON.stringify(status));
      const s = status.data as Record<string, unknown>;
      assert.equal(s['phase'], 'awaiting-identity');
      assert.equal(s['epoch'], 1);
      assert.equal(s['opVersion'], OP_VERSION);
      assert.equal(s['buildChannel'], 'prod');
      assert.equal(typeof s['manifestSchemaVersion'], 'number');
      assert.equal(typeof s['viewSchemaVersion'], 'number');
      assert.equal(s['keystore'], 'insecure-fallback');

      // §15.3 — standard exige identidade; queries/open passam.
      const recusa = await r.io.request('message.send', { communityId: 'x', channelId: 'y', content: 'oi', mentions: [] });
      assert.equal(recusa.code, 'E_NO_IDENTITY');
      // §15.3/§15.6 — query é open: sem identidade criada, responde null ("nada local"), não erro.
      const semIdentidade = await r.io.request('query.identity', {});
      assert.ok(semIdentidade.ok, JSON.stringify(semIdentidade));
      assert.equal(semIdentidade.data, null);

      // Erros da coluna de §15.4, na ordem.
      const ruim = await r.io.request('identity.create', { displayName: 'a', avatarColor: 99 });
      assert.equal(ruim.code, 'E_VALIDATION');
      const criada = await r.io.request('identity.create', { displayName: '  Ana Clarice  ', avatarColor: 2 });
      assert.ok(criada.ok, JSON.stringify(criada));
      const dados = criada.data as { publicKey: string; handle: string; createdAt: number };
      assert.match(dados.publicKey, /^[0-9a-f]{64}$/);
      assert.match(dados.handle, /^@[0-9a-z]{4}-[0-9a-z]{4}$/);

      await esperar(() => r.runtime.phase === 'ready', 'create não virou ready');
      const pronto = prontos.find((e) => e['phase'] === 'ready');
      assert.ok(pronto !== undefined, 'core.ready não saiu pelo fan-out');

      const eu = (await r.io.request('query.identity', {})).data as Record<string, unknown>;
      assert.equal(eu['displayName'], 'Ana Clarice'); // trim/NFKC da mesma régua do fold
      assert.equal(eu['presence'], 'online');
      assert.notEqual((await r.io.request('message.send', { communityId: 'x', channelId: 'y', content: 'oi', mentions: [] })).code, 'E_NO_IDENTITY');

      const duplicada = await r.io.request('identity.create', { displayName: 'Outra', avatarColor: 1 });
      assert.equal(duplicada.code, 'E_IDENTITY_EXISTS');
    } finally {
      await r.fechar();
    }
  });

  it('gates de keystore: sem aceite → E_KEYSTORE_INSECURE; oráculo indisponível → E_KEYSTORE_UNAVAILABLE', async () => {
    // O rig já chama acceptInsecure; aqui um manager num diretório SEM aceite.
    const dir = tempDir('keystore-gate');
    const manifest = new ManifestDb(path.join(dir, 'manifest.db'));
    const view = openViewDb(path.join(dir, 'view.db'));
    const manager = new IdentityManager(dir, new FallbackKeystoreOracle(), manifest);
    const [coreSide, rendererSide] = MemoryIpcPort.createPair();
    const runtime: CoreRuntime = await bootCore({
      dataDir: dir,
      manifest,
      view,
      swarm: new Swarm(),
      dataKey: DATA_KEY,
      identity: () => manager.getKeyPair(),
      identityManager: manager,
      foldBuildId: 'shell-56-gate',
      ipcPort: coreSide,
      epoch: 1,
      tokenVerifier: { consume: () => true },
      hostTurnSecret: () => Buffer.alloc(32, 7),
      schedule: () => 0,
      cancel: () => {},
      logger: silentLogger(),
    });
    const io = cabo(rendererSide);
    try {
      const recusa = await io.request('identity.create', { displayName: 'Sem Aceite', avatarColor: 1 });
      assert.equal(recusa.code, 'E_KEYSTORE_INSECURE');

      // §58.10 — o aceite pela FRONTEIRA, que é o que a tela dedicada de L-2 chama. Antes
      // disto só existia a função da composição, sem gatilho IPC-R: a tela que a limitação
      // declarada exige era inalcançável, e o produto parava aqui em toda máquina sem
      // secret store.
      const aceite = await io.request('identity.acceptInsecureKeystore', {});
      assert.ok(aceite.ok, JSON.stringify(aceite));
      assert.ok(fs.existsSync(path.join(dir, 'keystore-accepted')), 'o aceite tem de ficar no disco');

      const aceita = await io.request('identity.create', { displayName: 'Com Aceite', avatarColor: 1 });
      assert.ok(aceita.ok, JSON.stringify(aceita));

      // Idempotente: a tela pode chamar sem saber se já houve aceite.
      assert.ok((await io.request('identity.acceptInsecureKeystore', {})).ok);
    } finally {
      await runtime.close().catch(() => {});
      try {
        view.close();
        manifest.close();
      } catch {}
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});

describe('§120 a conversa direta nasce com a identidade (§31, §3.3)', () => {
  it('identity.create monta o subsistema de §31 no mesmo processo, sem reiniciar o núcleo', async () => {
    const r = await rigHost('dm-em-sessao', { semIdentidade: true });
    try {
      // Numa instalação nova o boot não tem identidade, e §31 não tem o que montar: o
      // `conversationId` sai de duas chaves de identidade (§31.2).
      assert.equal(r.runtime.dm, null);
      assert.equal((await r.io.request('query.dmConversations', {})).code, 'E_UNKNOWN_COMMAND');

      const criada = await r.io.request('identity.create', { displayName: 'Ana Clarice', avatarColor: 2 });
      assert.ok(criada.ok, JSON.stringify(criada));

      // E agora existe — sem reabrir o app. Era isto que faltava: a montagem acontecia uma
      // vez só, no boot, e quem criou a identidade em sessão ficava sem conversa direta até
      // o próximo reinício.
      assert.notEqual(r.runtime.dm, null, 'o subsistema de §31 não foi montado com a identidade');
      const lista = await r.io.request('query.dmConversations', {});
      assert.ok(lista.ok, JSON.stringify(lista));
      assert.deepEqual((lista.data as { conversations: unknown[] }).conversations, []);
      // A superfície de escrita também: `dm.open` recusa pelo argumento, não por não existir.
      assert.equal((await r.io.request('dm.open', { peerKey: 'nao-e-hex' })).code, 'E_VALIDATION');
    } finally {
      await r.fechar();
    }
  });
});

describe('§56.2 identity.update — **A**, uma op por comunidade (§15.4, §11.1 emendada)', () => {
  it('duas comunidades → duas ops na resposta; o fold aplica nas duas depois do flush', async () => {
    const r = await rigHost('update');
    try {
      const a = await r.io.request('community.create', { name: 'Primeira', iconColor: 1 });
      assert.ok(a.ok, JSON.stringify(a));
      const b = await r.io.request('community.create', { name: 'Segunda', iconColor: 2 });
      assert.ok(b.ok, JSON.stringify(b));
      const cidA = (a.data as Record<string, unknown>)['communityId'] as string;
      const cidB = (b.data as Record<string, unknown>)['communityId'] as string;

      const vazia = await r.io.request('identity.update', {});
      assert.equal(vazia.code, 'E_VALIDATION');

      const upd = await r.io.request('identity.update', { displayName: 'Nome Novo', avatarColor: 4 });
      assert.ok(upd.ok, JSON.stringify(upd));
      const queued = (upd.data as { queued: Array<{ communityId: string; opId: string }> }).queued;
      assert.equal(queued.length, 2);
      assert.deepEqual(queued.map((q) => q.communityId).sort(), [cidA, cidB].sort());

      // O perfil local muda na hora; o LOG acompanha pela fila.
      assert.equal(r.manager.record?.displayName, 'Nome Novo');

      await r.runtime.loops!.runNow('outbox.flush');
      for (const c of [cidA, cidB]) {
        const com = r.runtime.get(c)!;
        await esperar(() => com.projector.interpretedSeq >= com.core.length - 1, `${c}: projeção não alcançou a cabeça`);
        const membro = com.projector.ds.members.get(dadosPublicKey(r.manager));
        assert.equal(membro?.displayName, 'Nome Novo', `fold não aplicou em ${c}`);
        assert.equal(membro?.avatarColor, 4);
      }

      await r.runtime.loops!.runNow('outbox.reconcile');
      for (const c of [cidA, cidB]) {
        const fila = (await r.io.request('query.outbox', { communityId: c })).data as { items: unknown[] };
        assert.deepEqual(fila.items, []);
      }
    } finally {
      await r.fechar();
    }
  });
});

describe('§56.3 identity.setPresence — tabela fechada de §6.1 e invisible sem publicação', () => {
  it('status inválido recusa; dnd publica no refresh; invisible para de publicar', async () => {
    const r = await rigHost('presenca');
    try {
      const criada = await r.io.request('community.create', { name: 'Presença', iconColor: 0 });
      assert.ok(criada.ok, JSON.stringify(criada));
      const cid = (criada.data as Record<string, unknown>)['communityId'] as string;
      const euHex = r.manager.publicKeyHex!;

      assert.equal((await r.io.request('identity.setPresence', { presence: 'offline' })).code, 'E_VALIDATION');
      assert.equal((await r.io.request('identity.setPresence', { presence: 'ocupado' })).code, 'E_VALIDATION');

      assert.ok((await r.io.request('identity.setPresence', { presence: 'dnd' })).ok);
      await r.runtime.loops!.runNow('presence.refresh');
      const vivos = r.runtime.get(cid)!.presence.getPresenceEntries(cid, T0 + 1000);
      assert.equal(vivos.find((e) => e.identityKey === euHex)?.status, 'dnd');

      // §6.1/§6.16 — invisible NÃO publica: nenhuma entrada nova e a anterior expira pelo TTL.
      assert.ok((await r.io.request('identity.setPresence', { presence: 'invisible' })).ok);
      await r.runtime.loops!.runNow('presence.refresh');
      await r.runtime.loops!.runNow('presence.refresh');
      const depois = r.runtime.get(cid)!.presence.getPresenceEntries(cid, T0 + 1000 + 46_000);
      assert.equal(depois.find((e) => e.identityKey === euHex), undefined, 'invisible não pode aparecer na tabela');

      // A escolha persiste no perfil local.
      assert.equal(r.manager.record?.presence, 'invisible');
    } finally {
      await r.fechar();
    }
  });
});

describe('§59 composeKeystore — a tabela A13/L-2 que liga o shell ao modo do cofre', () => {
  // O smoke manual pegou o que nenhum rig via: a fiação do produto chamava sempre o oráculo
  // da IPC-M com `kind` fixo em 'secure', e o Electron 43 sem secret service responde
  // `available === false` — `E_KEYSTORE_UNAVAILABLE` antes de qualquer gate, e a tela de
  // aceite da L-2 inalcançável. A composição decide agora pelo que o main diz.

  function oraculoDeMentira(info?: { available: boolean }): Parameters<typeof composeKeystore>[0] {
    return {
      wrapDataKey: async (b64: string) => b64,
      unwrapDataKey: async (w: string) => w,
      ...(info !== undefined ? { keystoreInfo: async () => info } : {}),
    };
  }

  it('com cifra no main: oráculo do main, modo secure, sem gate', async () => {
    const c = await composeKeystore(oraculoDeMentira({ available: true }));
    assert.equal(c.keystore.kind(), 'secure');
    assert.ok(await c.keystore.available());
    assert.ok(c.keystore.oracle === (c as { oracle: unknown }).oracle);
  });

  it('sem cifra (basic_text do Electron 43): obfuscação local e modo insecure-fallback', async () => {
    const c = await composeKeystore(oraculoDeMentira({ available: false }));
    assert.equal(c.keystore.kind(), 'insecure-fallback');
    // O wrap tem de funcionar SEM o main — é o que dá para onde ir ao aceite da L-2.
    const wrapped = await c.oracle.wrapDataKey('chave-de-teste');
    assert.equal(await c.oracle.unwrapDataKey(wrapped), 'chave-de-teste');
    assert.notEqual(wrapped, 'chave-de-teste', 'obfuscação não é identidade');
  });

  it('consulta que falha e depois responde: retenta, e o modo é o que o main disse', async () => {
    // §3.2 L-2 emendado, regra 1 — um soluço do main não é resposta. A versão anterior
    // tratava a primeira exceção como "não há cifra" e fixava o modo inseguro para a vida
    // do processo.
    const instavel = oraculoDeMentira();
    let chamadas = 0;
    (instavel as { keystoreInfo(): Promise<{ available: boolean }> }).keystoreInfo = async () => {
      chamadas++;
      if (chamadas === 1) throw new Error('IPC-M ocupado');
      return { available: true };
    };
    const c = await composeKeystore(instavel, { tentativas: 3, esperaMs: 1 });
    assert.equal(chamadas, 2);
    assert.equal(c.keystore.kind(), 'secure');
    assert.equal(c.modo, 'secure');
  });

  it('silêncio persistente do main é E_KEYSTORE_UNAVAILABLE, não modo inseguro', async () => {
    const quebrado = oraculoDeMentira();
    (quebrado as { keystoreInfo(): Promise<{ available: boolean }> }).keystoreInfo = async () => {
      throw new Error('IPC-M fechado');
    };
    await assert.rejects(
      () => composeKeystore(quebrado, { tentativas: 2, esperaMs: 1 }),
      (err: { code?: string }) => err.code === 'E_KEYSTORE_UNAVAILABLE',
    );
  });

  it('resposta explícita available:false continua sendo o modo inseguro de L-2', async () => {
    const c = await composeKeystore(oraculoDeMentira({ available: false }), { tentativas: 2, esperaMs: 1 });
    assert.equal(c.modo, 'insecure-fallback');
  });
});

describe('§3.2 L-2 emendado — conciliação de modo do cofre entre boots', () => {
  function manifestoTemporario(nome: string): ManifestDb {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `p2p-modo-${nome}-`));
    return new ManifestDb(path.join(dir, 'manifest.db'));
  }

  it('instalação nova: grava o modo corrente e não mexe em nada', async () => {
    const manifest = manifestoTemporario('novo');
    const r = await conciliarModoKeystore({
      manifest,
      modoAtual: 'secure',
      oracleAtual: new FallbackKeystoreOracle(),
      wrapped: null,
    });
    assert.equal(r, null);
    assert.equal(manifest.metaGet(CHAVE_MODO_KEYSTORE), 'secure');
    manifest.close();
  });

  it('insecure-fallback → secure: reembrulha sozinho e reescreve secrets.data_key', async () => {
    const manifest = manifestoTemporario('upgrade');
    const antigo = new FallbackKeystoreOracle();
    const wrappedAntigo = await antigo.wrapDataKey('ZGF0YS1rZXk=');
    manifest.setSecret('data_key', Buffer.from(wrappedAntigo, 'utf8'), null);
    manifest.metaSet(CHAVE_MODO_KEYSTORE, 'insecure-fallback');

    // Um "safeStorage" de mentira: prefixa, e só ele sabe desfazer.
    const seguro = {
      wrapDataKey: async (b64: string) => `cofre:${b64}`,
      unwrapDataKey: async (w: string) => w.replace(/^cofre:/, ''),
    };
    const novo = await conciliarModoKeystore({
      manifest,
      modoAtual: 'secure',
      oracleAtual: seguro,
      wrapped: wrappedAntigo,
    });
    assert.equal(novo, 'cofre:ZGF0YS1rZXk=');
    assert.equal(manifest.metaGet(CHAVE_MODO_KEYSTORE), 'secure');
    // A linha persistida acompanha — senão o próximo boot voltaria a ver o formato antigo.
    assert.equal(manifest.getSecret('data_key')?.ciphertext.toString('utf8'), novo);
    // E a Data Key continua a MESMA (§5.4: uma por instalação).
    assert.equal(await seguro.unwrapDataKey(novo as string), 'ZGF0YS1rZXk=');
    manifest.close();
  });

  it('secure → insecure-fallback: recusa com E_KEYSTORE_MODE_CHANGED, sem apagar nada', async () => {
    const manifest = manifestoTemporario('downgrade');
    manifest.setSecret('data_key', Buffer.from('cofre:ZGF0YS1rZXk=', 'utf8'), null);
    manifest.metaSet(CHAVE_MODO_KEYSTORE, 'secure');
    await assert.rejects(
      () =>
        conciliarModoKeystore({
          manifest,
          modoAtual: 'insecure-fallback',
          oracleAtual: new FallbackKeystoreOracle(),
          wrapped: 'cofre:ZGF0YS1rZXk=',
        }),
      (err: { code?: string }) => err.code === 'E_KEYSTORE_MODE_CHANGED',
    );
    // O segredo continua onde estava: a recusa não pode ser destrutiva.
    assert.equal(manifest.getSecret('data_key')?.ciphertext.toString('utf8'), 'cofre:ZGF0YS1rZXk=');
    assert.equal(manifest.metaGet(CHAVE_MODO_KEYSTORE), 'secure');
    manifest.close();
  });
});

function dadosPublicKey(manager: IdentityManager): string {
  return manager.publicKeyHex as string;
}
