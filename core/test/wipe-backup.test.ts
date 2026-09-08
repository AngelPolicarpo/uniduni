// §56 — backup/restauração de §5.5, a máquina de wipe de §18.6, o draining de §18.7,
// o gatilho de typing de §17.6 e os produtores NDJSON de §24.1/§24.2/§24.3.
//
//   §5.5   — export→import restaura identidade E as linhas de comunidade; o blob nunca
//            passa pelo renderer (o main grava/lê);
//   §18.6  — cada etapa grava o próprio nome ANTES de agir; crash no meio retoma no boot
//            pelo `wipe_state` ou pelo sentinela `WIPE`; LOCK é o último a sair;
//   §18.7  — `core.shutdown` devolve `{drainedMs, pendingOps, replicatedTo}` honestos;
//   §17.6  — typing só para quem assinou o canal; o comando local espelha por §16.2;
//   §24.x  — allowlist estrutural; displayName/conteúdo NUNCA saem na linha.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { ManifestDb } from '../src/l0/manifest/index.ts';
import { openViewDb } from '../src/l0/view/index.ts';
import { Swarm } from '../src/l0/swarm/index.ts';
import { IdentityManager } from '../src/l0/identity/index.ts';
import { FallbackKeystoreOracle, acceptInsecure } from '../src/l0/keystore/index.ts';
import { ProcessLock } from '../src/l3/ipcMain/index.ts';
import { MemoryIpcPort } from '../src/l3/ipcRenderer/index.ts';
import type { CoreRuntime } from '../src/composition/boot.ts';
import { bootCore } from '../src/composition/boot.ts';
import { executeWipe, resumePendingWipe, WIPE_SENTINEL } from '../src/composition/wipe.ts';
import { NdjsonLogger, silentLogger } from '../src/composition/logger.ts';
import { RpcServer } from '../src/l3/rpcServer/index.ts';
import { PresenceManager } from '../src/l2/presence/index.ts';
import { wireHostPresenceRpc, wireHostRpc, tempDir, rpcPair } from './helpers/composition.ts';
import { T0, World, genesis, joinMember, keypairFromSeed } from './helpers/world.ts';

const DATA_KEY = Buffer.alloc(32, 88);

type Frame = Record<string, unknown>;
type Resposta = { ok: boolean; data: unknown; code: string | null };

function cabo(rendererSide: MemoryIpcPort) {
  const pendentes = new Map<number, (r: Resposta) => void>();
  const assinaturas = new Map<number, Frame[]>();
  let proximoId = 7000;
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

/** Rig hospedeiro com manager real; `semIdentidade` nasce awaiting-identity. */
async function rig(rotulo: string, opts: { readonly semIdentidade?: boolean } = {}) {
  const dir = tempDir(rotulo);
  const manifest = new ManifestDb(path.join(dir, 'manifest.db'));
  const view = openViewDb(path.join(dir, 'view.db'));
  const manager = new IdentityManager(dir, new FallbackKeystoreOracle(), manifest);
  if (!opts.semIdentidade) await manager.create('Dona Raiz', 3);
  acceptInsecure(dir, 'rig');
  const [coreSide, rendererSide] = MemoryIpcPort.createPair();
  const estado = { bundles: [] as Buffer[], saiu: false, limpo: false };
  const runtime: CoreRuntime = await bootCore({
    dataDir: dir,
    manifest,
    view,
    swarm: new Swarm(),
    dataKey: DATA_KEY,
    identity: () => manager.getKeyPair(),
    identityManager: manager,
    foldBuildId: `shell-56b-${rotulo}`,
    ipcPort: coreSide,
    epoch: 1,
    tokenVerifier: { consume: () => true },
    hostTurnSecret: () => Buffer.alloc(32, 7),
    now: () => T0 + 1000,
    schedule: () => 0,
    cancel: () => {},
    logger: silentLogger(),
    saveFile: async ({ data }) => {
      estado.bundles.push(data);
      return { ok: true };
    },
    readFile: async () => (estado.bundles.length > 0 ? (estado.bundles[estado.bundles.length - 1] as Buffer) : null),
    exit: () => {
      estado.saiu = true;
    },
  });
  const vivo = setInterval(() => {}, 5);
  return {
    runtime,
    manager,
    manifest,
    view,
    dir,
    io: cabo(rendererSide),
    estado,
    async fechar() {
      clearInterval(vivo);
      if (estado.limpo) return;
      estado.limpo = true;
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

describe('§56.4 backup e restauração — export → import ponta a ponta (§5.5)', () => {
  it('export carrega comunidades hospedadas com semente; import recria manifesto e reabre cores', async () => {
    const a = await rig('backup-a');
    let b: Awaited<ReturnType<typeof rig>> | null = null;
    try {
      const criada = await a.io.request('community.create', { name: 'Raiz Backup', iconColor: 5 });
      assert.ok(criada.ok, JSON.stringify(criada));
      const cid = (criada.data as Record<string, unknown>)['communityId'] as string;

      const semSenha = await a.io.request('identity.export', {});
      assert.equal(semSenha.code, 'E_VALIDATION');
      const exp = await a.io.request('identity.export', { passphrase: 'frase secreta 123' });
      assert.ok(exp.ok, JSON.stringify(exp));
      assert.equal(a.estado.bundles.length, 1);

      // Instalação nova, SEM identidade: o "main" entrega o mesmo blob ao núcleo.
      b = await rig('backup-b', { semIdentidade: true });
      b.estado.bundles.push(a.estado.bundles[0]!);
      const imp = await b.io.request('identity.import', { passphrase: 'frase secreta 123' });
      assert.ok(imp.ok, JSON.stringify(imp));
      const dados = imp.data as { publicKey: string; handle: string; communities: number };
      assert.equal(dados.publicKey, a.manager.publicKeyHex);
      assert.ok(dados.communities >= 1, 'a comunidade hospedada tinha de vir no backup');
      assert.equal(b.runtime.phase, 'ready');

      // A linha voltou ao manifest e a comunidade reabriu pelo caminho do boot.
      const linha = b.manifest.getCommunity(cid) as Record<string, unknown> | null;
      assert.notEqual(linha, null, 'linha da comunidade não restaurada');
      assert.equal(linha!['is_host'], 1, 'comunidade hospedada deve permanecer hospedada');
      assert.ok(linha!['community_seed_enc'] !== null, 'semente da comunidade deve ser restaurada');
    } finally {
      await a.fechar();
      if (b !== null) await b.fechar();
    }
  });
});

describe('§56.5 máquina de wipe — executar, falhar e retomar (§18.6)', () => {
  it('execução inteira apaga bancos, cores, sentinela e libera o LOCK por último', async () => {
    const dir = tempDir('wipe-full');
    const manifest = new ManifestDb(path.join(dir, 'manifest.db'));
    const view = openViewDb(path.join(dir, 'view.db'));
    const manager = new IdentityManager(dir, new FallbackKeystoreOracle(), manifest);
    await manager.create('Vai Sair', 1);
    const lock = new ProcessLock(dir);
    lock.acquire();
    fs.mkdirSync(path.join(dir, 'cores'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'cores', 'marcado'), 'x');
    fs.mkdirSync(path.join(dir, 'a'.repeat(64)), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a'.repeat(64), 'arquivo.png'), 'blob-data');
    fs.writeFileSync(path.join(dir, 'keystore-accepted'), 'accepted');

    let fechado = 0;
    const r = await executeWipe({
      dataDir: dir,
      swarm: new Swarm(),
      closeRuntime: async () => {
        fechado++;
      },
      view,
      manifest,
      wipeIdentity: () => manager.wipe(),
      releaseLock: () => lock.release(),
    });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(fechado, 1);
    assert.equal(manager.isLoaded, false);
    assert.equal(lock.isLocked, false);
    assert.equal(fs.existsSync(path.join(dir, 'view.db')), false);
    assert.equal(fs.existsSync(path.join(dir, 'manifest.db')), false);
    assert.equal(fs.existsSync(path.join(dir, 'cores')), false);
    assert.equal(fs.existsSync(path.join(dir, 'a'.repeat(64))), false, 'blobs devem ser removidos no wipe');
    assert.equal(fs.existsSync(path.join(dir, 'keystore-accepted')), false, 'keystore-accepted deve ser removido no wipe');
    assert.equal(fs.existsSync(path.join(dir, WIPE_SENTINEL)), false);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it('o manifest é FECHADO antes de ser apagado, como a view já era', async () => {
    // O defeito que isto fecha: `manifest-deleted` apagava o banco sem fechá-lo, ao
    // contrário de `view-deleted`. Em Linux o `unlink` de arquivo aberto funciona e nada
    // aparecia; em Windows o SQLite abre sem `FILE_SHARE_DELETE` e a remoção falha. A
    // asserção é sobre o comportamento observável na plataforma que temos — o banco está
    // fechado quando a máquina termina —, que é a condição de que a remoção depende lá.
    const dir = tempDir('wipe-fecha');
    const manifest = new ManifestDb(path.join(dir, 'manifest.db'));
    const view = openViewDb(path.join(dir, 'view.db'));
    const manager = new IdentityManager(dir, new FallbackKeystoreOracle(), manifest);
    await manager.create('Fecha Antes', 5);

    const r = await executeWipe({
      dataDir: dir,
      swarm: new Swarm(),
      closeRuntime: async () => {},
      view,
      manifest,
      wipeIdentity: () => manager.wipe(),
    });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(manifest.raw.open, false, 'o manifest ficou aberto depois do wipe');
    assert.equal(fs.existsSync(path.join(dir, 'manifest.db')), false);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it('remoção que falha vira E_WIPE_INCOMPLETE, e não sucesso silencioso', async () => {
    // §18.6 emendado. Um diretório no lugar do arquivo faz `rmSync` sem `recursive` falhar —
    // é o análogo portátil do `EBUSY` que o Windows devolve sobre um banco aberto. Antes, o
    // `catch {}` de `apagarBanco` engolia isso e a máquina seguia até `done`: a UI recebia
    // "apagado", e `communities.core_key` e `invite_secrets.secret` continuavam no disco.
    const dir = tempDir('wipe-falha');
    const manifest = new ManifestDb(path.join(dir, 'manifest.db'));
    const view = openViewDb(path.join(dir, 'view.db'));
    const manager = new IdentityManager(dir, new FallbackKeystoreOracle(), manifest);
    await manager.create('Nao Sai', 6);

    // A view "fecha" e o caminho dela é um diretório não vazio: apagar tem de falhar.
    view.close();
    fs.rmSync(path.join(dir, 'view.db'), { force: true });
    fs.mkdirSync(path.join(dir, 'view.db'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'view.db', 'ocupado'), 'x');

    const r = await executeWipe({
      dataDir: dir,
      swarm: new Swarm(),
      closeRuntime: async () => {},
      view: { close() {} } as unknown as typeof view,
      manifest,
      wipeIdentity: () => manager.wipe(),
    });
    assert.equal(r.ok, false, 'a remoção falhou e mesmo assim o wipe disse que deu certo');
    if (!r.ok) {
      assert.equal(r.code, 'E_WIPE_INCOMPLETE');
      assert.equal(r.stage, 'view-deleted');
    }
    // E o manifest continua intacto — a máquina parou onde devia, sem passar por cima.
    assert.equal(fs.existsSync(path.join(dir, 'manifest.db')), true);
    manifest.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it('crash na etapa cores-closed: retoma pelo wipe_state no boot seguinte', async () => {
    const dir = tempDir('wipe-crash');
    const manifest = new ManifestDb(path.join(dir, 'manifest.db'));
    const view = openViewDb(path.join(dir, 'view.db'));
    const manager = new IdentityManager(dir, new FallbackKeystoreOracle(), manifest);
    await manager.create('Caiu No Meio', 2);
    const lock = new ProcessLock(dir);
    lock.acquire();

    const r1 = await executeWipe({
      dataDir: dir,
      swarm: new Swarm(),
      closeRuntime: async () => {
        throw new Error('crash simulado');
      },
      view,
      manifest,
      wipeIdentity: () => manager.wipe(),
    });
    assert.equal(r1.ok, false);
    if (!r1.ok) assert.equal(r1.stage, 'cores-closed');

    // Boot seguinte: resumePendingWipe ANTES de abrir qualquer coisa.
    const retomou = await resumePendingWipe({
      dataDir: dir,
      swarm: new Swarm(),
      openManifest: () => {
        try {
          return new ManifestDb(path.join(dir, 'manifest.db'));
        } catch {
          return null;
        }
      },
      openView: () => {
        try {
          return openViewDb(path.join(dir, 'view.db'));
        } catch {
          return null;
        }
      },
      wipeIdentity: () => manager.wipe(),
    });
    assert.equal(retomou, true);
    assert.equal(manager.isLoaded, false);
    // §18.6 emendado — a RETOMADA não solta o LOCK: o boot continua daqui e vai abrir os
    // bancos de uma instalação zerada, o que §10.8 exige com a etapa (2) em mãos.
    assert.equal(lock.isLocked, true);
    assert.equal(fs.existsSync(path.join(dir, WIPE_SENTINEL)), false);
    assert.equal(fs.existsSync(path.join(dir, 'manifest.db')), false);
    lock.release();
    try {
      view.close();
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it('sentinela presente: retoma depois do manifest-deleted sem abrir banco nenhum', async () => {
    const dir = tempDir('wipe-sentinel');
    const manager = new IdentityManager(dir, new FallbackKeystoreOracle());
    await manager.create('Sentinela', 4);
    const lock = new ProcessLock(dir);
    lock.acquire();
    fs.writeFileSync(path.join(dir, WIPE_SENTINEL), 'manifest-deleted', 'utf8');
    fs.writeFileSync(path.join(dir, 'view.db'), 'resto', 'utf8');
    fs.writeFileSync(path.join(dir, 'manifest.db'), 'resto', 'utf8');

    const retomou = await resumePendingWipe({
      dataDir: dir,
      swarm: new Swarm(),
      openManifest: () => {
        throw new Error('não deveria abrir banco com sentinela presente');
      },
      openView: () => null,
      wipeIdentity: () => manager.wipe(),
    });
    assert.equal(retomou, true);
    assert.equal(manager.isLoaded, false);
    assert.equal(fs.existsSync(path.join(dir, WIPE_SENTINEL)), false);
    assert.equal(fs.existsSync(path.join(dir, 'manifest.db')), false);
    assert.equal(fs.existsSync(path.join(dir, 'view.db')), false);
    // §18.6 emendado — o LOCK continua com o processo que retomou.
    assert.equal(lock.isLocked, true);
    lock.release();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it('identity.wipe pela IPC: resposta sai antes da saída do processo e os arquivos acabam', async () => {
    const r = await rig('wipe-cmd');
    try {
      const criada = await r.io.request('community.create', { name: 'Para Apagar', iconColor: 2 });
      assert.ok(criada.ok, JSON.stringify(criada));
      const wipe = await r.io.request('identity.wipe', {});
      assert.ok(wipe.ok, JSON.stringify(wipe));
      await esperar(() => r.estado.saiu, 'o reinício não foi agendado');
      assert.equal(fs.existsSync(path.join(r.dir, 'manifest.db')), false);
      assert.equal(fs.existsSync(path.join(r.dir, 'view.db')), false);
      assert.equal(fs.existsSync(path.join(r.dir, WIPE_SENTINEL)), false);
      assert.equal(r.manager.isLoaded, false);
      assert.equal(r.runtime.phase, 'stopped');
      r.estado.limpo = true; // teardown não fecha de novo o que já foi apagado
    } finally {
      await r.fechar();
    }
  });
});

