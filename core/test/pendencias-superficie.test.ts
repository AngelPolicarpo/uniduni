// §49 — as pendências pequenas de §46.3/§47.3, cada uma com a propriedade que a fecha:
//
//   `query.invites` (§15.6)          — fato do log + `code` só de quem criou aqui (U-04);
//   `invite.topicSweep` (§22.2)      — convite EXPIRA sem registro no log: sem job, o host
//                                      continua anunciando na DHT um convite vencido;
//   `E_QUOTA_EXCEEDED` no stage      — R-14 antecipada antes de gravar o arquivo (§15.4);
//   `blob.progress`/`blob.peerLost`  — bitfield real, nunca estimativa (§13.4 passo 4);
//   GC de leitores esparsos (§22.4)  — core alheio aberto por download não vive para sempre;
//   índice do resolver de anexos     — `{blobsCoreKey, blobId}` sem `communityId` (§15.4).

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { ManifestDb } from '../src/l0/manifest/index.ts';
import { openViewDb } from '../src/l0/view/index.ts';
import { Swarm } from '../src/l0/swarm/index.ts';
import { isInviteLive } from '../src/l2/invites/index.ts';
import { deriveRelayKeyPair } from '../src/l2/relay/index.ts';
import { RELAY_TTL_MS } from '../src/l1/fold/constants.ts';
import { BLOB_CHUNK_BYTES, BlobManager, discoveryKeyHexForBlobsCoreKey, hashForBlobContent, type BlobEvent, type BlobsReaderPort } from '../src/l2/blobs/index.ts';
import { MemoryIpcPort } from '../src/l3/ipcRenderer/index.ts';
import { bootCore, type CoreRuntime } from '../src/composition/boot.ts';
import { JOB_INTERVALS, startJobs } from '../src/composition/jobs.ts';
import { attachmentBlobIdJson } from '../src/composition/ports.ts';
import type { CommunityTransport } from '../src/composition/transport.ts';
import { tempDir } from './helpers/composition.ts';
import { T0, keypairFromSeed } from './helpers/world.ts';

const DATA_KEY = Buffer.alloc(32, 49);
const CHAVE_REMOTA = Buffer.alloc(32, 4);

// ─── Rig local: um núcleo sem rede, o mesmo caminho de produto de §48 ────────────────────

async function rigLocal(rotulo: string, identity: { publicKey: Buffer; secretKey: Buffer }, relogio: { now: number }) {
  const dir = tempDir(rotulo);
  const manifest = new ManifestDb(path.join(dir, 'manifest.db'));
  const view = openViewDb(path.join(dir, 'view.db'));
  const [coreSide, rendererSide] = MemoryIpcPort.createPair();
  const runtime: CoreRuntime = await bootCore({
    dataDir: dir,
    manifest,
    view,
    swarm: new Swarm(),
    dataKey: DATA_KEY,
    identity: () => identity,
    identityProfile: () => ({ displayName: 'Dona', avatarColor: 2 }),
    foldBuildId: 'pendencias-49',
    ipcPort: coreSide,
    epoch: 1,
    tokenVerifier: { consume: () => true },
    hostTurnSecret: () => Buffer.alloc(32, 7),
    now: () => relogio.now,
    schedule: () => 0,
    cancel: () => {},
  });
  // §11.4 fecha o grupo de submissão por `setTimeout` **unref** (4 ms). Num rig sem rede
  // não há nada segurando o event loop: o processo sairia antes de o grupo fechar, e toda
  // op síncrona (`invite.create`, `invite.revoke`) ficaria pendente para sempre. Este
  // intervalo é o único papel deste objeto — manter o loop vivo enquanto o teste espera.
  const vivo = setInterval(() => {}, 5);

  async function request(cmd: string, arg: unknown): Promise<{ ok: boolean; data: unknown; code: string | null }> {
    const id = 9000 + Math.floor(Math.random() * 1000);
    const resposta = new Promise<{ ok: boolean; data: unknown; code: string | null }>((resolve) => {
      rendererSide.onMessage((frame) => {
        if (frame.t === 'res' && frame.id === id) resolve({ ok: frame.ok, data: frame.data, code: frame.err?.code ?? null });
      });
    });
    rendererSide.postMessage({ t: 'req', epoch: 1, id, cmd, arg, authToken: 'ok' });
    return await resposta;
  }
  return {
    runtime,
    manifest,
    view,
    request,
    async close() {
      clearInterval(vivo);
      await runtime.close();
      view.close();
      manifest.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    },
  };
}

/** O log é appendado antes de ser projetado: o DS só vê o convite depois do lote (§10.5). */
async function ate(cond: () => boolean, msg: string, timeoutMs = 15_000): Promise<void> {
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`${msg} (esperou ${timeoutMs} ms)`);
}

/** Transporte de mentira: só registra o que o host declarou servir (§12.2 passo 3). */
function transporteStub(): CommunityTransport & { servidos: string[][] } {
  const servidos: string[][] = [];
  return {
    servidos,
    flush: async () => {},
    refresh: () => {},
    ipDoPar: () => null,
    leaveCommunity: () => {},
    channelCount: () => 0,
    seekInviteTopic: () => {},
    releaseInviteTopic: () => {},
    serveInviteTopics: (topicsHex) => {
      servidos.push([...topicsHex]);
    },
    onAdmissionChannel: () => () => {},
    stop: async () => {},
  };
}

describe('§49.1 query.invites — o log e o código de quem criou aqui', () => {
  it('devolve o convite com `code`, e a revogação aparece na mesma listagem', async () => {
    const relogio = { now: T0 + 1_000 };
    const r = await rigLocal('q-invites', keypairFromSeed('fundador-49'), relogio);
    try {
      const criada = await r.request('community.create', { name: 'Raiz', iconColor: 1 });
      const { communityId } = criada.data as { communityId: string };
      const convite = await r.request('invite.create', { communityId, maxUses: 3, expiresInDays: 7, label: 'turma da tarde' });
      assert.ok(convite.ok, `invite.create recusou: ${JSON.stringify(convite)}`);
      const criado = convite.data as { invitePublicKey: string; code: string; expiresAt: number; maxUses: number };
      const c = r.runtime.get(communityId)!;
      await ate(() => c.projector.ds.invites.size === 1, 'o `invite.create` não foi projetado');

      const listagem = await r.request('query.invites', { communityId });
      assert.ok(listagem.ok, `query.invites recusou: ${JSON.stringify(listagem)}`);
      const { items } = listagem.data as { items: Array<Record<string, unknown>> };
      assert.equal(items.length, 1);
      const item = items[0]!;
      assert.equal(item['invitePublicKey'], criado.invitePublicKey);
      // U-04: o código só existe onde o segredo foi guardado — aqui ele foi.
      assert.equal(item['code'], criado.code);
      assert.equal(item['codeAvailable'], true);
      assert.equal(item['label'], 'turma da tarde');
      assert.equal(item['uses'], 0);
      assert.equal(item['maxUses'], 3);
      assert.equal(item['expiresAt'], criado.expiresAt);
      assert.equal((item['createdBy'] as { key: string }).key, keypairFromSeed('fundador-49').publicKey.toString('hex'));
      assert.equal(item['revokedAt'], undefined);

      const revogado = await r.request('invite.revoke', { communityId, invitePublicKey: criado.invitePublicKey });
      assert.ok(revogado.ok, `invite.revoke recusou: ${JSON.stringify(revogado)}`);
      await ate(() => c.projector.ds.invites.get(criado.invitePublicKey)?.revokedAt !== undefined, 'a revogação não foi projetada');
      const depois = (await r.request('query.invites', { communityId })).data as { items: Array<Record<string, unknown>> };
      assert.equal(depois.items.length, 1, 'o convite revogado sumiu da listagem — ele tem de aparecer marcado');
      assert.equal(typeof depois.items[0]!['revokedAt'], 'number');
    } finally {
      await r.close();
    }
  });

  it('comunidade desconhecida é `E_NOT_FOUND`, não lista vazia', async () => {
    const r = await rigLocal('q-invites-404', keypairFromSeed('fundador-49b'), { now: T0 });
    try {
      const resp = await r.request('query.invites', { communityId: 'f'.repeat(64) });
      assert.equal(resp.ok, false);
      assert.equal(resp.code, 'E_NOT_FOUND');
    } finally {
      await r.close();
    }
  });
});

describe('§49.2 invite.topicSweep — o convite que expira sem registro no log', () => {
  it('a regra de vida do convite', () => {
    assert.equal(isInviteLive({ uses: 0 }, T0), true);
    assert.equal(isInviteLive({ uses: 0, revokedAt: T0 - 1 }, T0), false);
    assert.equal(isInviteLive({ uses: 0, expiresAt: T0 }, T0), false, 'expiração é `<=`, como o preview de §12.3');
    assert.equal(isInviteLive({ uses: 0, expiresAt: T0 + 1 }, T0), true);
    assert.equal(isInviteLive({ uses: 3, maxUses: 3 }, T0), false);
    assert.equal(isInviteLive({ uses: 2, maxUses: 3 }, T0), true);
  });

  it('o job deixa de anunciar o tópico depois que o prazo passa, sem lote novo', async () => {
    const relogio = { now: T0 + 1_000 };
    const r = await rigLocal('sweep', keypairFromSeed('fundador-49c'), relogio);
    const t = transporteStub();
    try {
      const criada = await r.request('community.create', { name: 'Raiz', iconColor: 1 });
      const { communityId } = criada.data as { communityId: string };
      const convite = await r.request('invite.create', { communityId, expiresInDays: 1 });
      assert.ok(convite.ok, `invite.create recusou: ${JSON.stringify(convite)}`);
      const { expiresAt } = convite.data as { expiresAt: number };
      await ate(() => r.runtime.get(communityId)!.projector.ds.invites.size === 1, 'o `invite.create` não foi projetado');

      // O transporte anexa depois do boot, como em produção; a admissão reconcilia na hora.
      r.runtime.attachTransport(t);
      assert.equal(t.servidos.at(-1)?.length, 1, 'o convite vivo não foi anunciado');

      // Nenhum registro novo entra no log: só o relógio anda.
      relogio.now = expiresAt + 1;
      await r.runtime.jobs!.runNow('invite.topicSweep');
      assert.deepEqual(t.servidos.at(-1), [], 'o tópico do convite vencido continuou anunciado');
    } finally {
      await r.close();
    }
  });

  it('o runner rearma o job com a cadência de §22.2 e para no `stop`', async () => {
    const agendados: Array<{ ms: number; fn: () => void }> = [];
    let corridas = 0;
    const runner = startJobs({
      schedule: (fn, ms) => {
        agendados.push({ ms, fn });
        return agendados.length;
      },
      cancel: () => {},
      jobs: { 'invite.topicSweep': () => void (corridas += 1) },
    });
    assert.equal(agendados.length, 1);
    assert.equal(agendados[0]!.ms, JOB_INTERVALS['invite.topicSweep']);
    assert.equal(agendados[0]!.ms, 15 * 60_000);
    agendados[0]!.fn();
    await new Promise((r) => setImmediate(r));
    assert.equal(corridas, 1);
    assert.equal(agendados.length, 2, 'o job não rearmou — rodaria uma vez só');
    runner.stop();
    await runner.runNow('invite.topicSweep');
    assert.equal(corridas, 1, 'job disparado depois do `stop` (§22.5)');
  });
});

describe('§49.3 blob.stage — sem cota (emenda de 2026-09-04, §13.8)', () => {
  it('grava um anexo maior que a antiga cota de 5 GiB sem recusar', async () => {
    const dir = tempDir('quota-49');
    const manifest = new ManifestDb(path.join(dir, 'manifest.db'));
    const arquivo = path.join(dir, 'relatorio.pdf');
    fs.writeFileSync(arquivo, Buffer.alloc(2048, 3));
    const blobs = new BlobManager({
      manifest,
      swarm: new Swarm(),
      dataDir: path.join(dir, 'cache'),
    });
    try {
      // O ticket declara 6 GiB — acima de `ATTACHMENT_QUOTA_PER_MEMBER`, que não existe mais.
      // Antes de `opVersion = 3` isto era `E_QUOTA_EXCEEDED` antes de qualquer escrita.
      const grande = blobs.createTicketForMain('a'.repeat(64), arquivo, 6 * 1024 ** 3);
      assert.equal(grande.sizeBytes, 6 * 1024 ** 3);
      const staged = await blobs.stage(grande.ticketId, { blobsCoreKey: Buffer.alloc(32, 9) });
      assert.equal(staged.sizeBytes, 2048, 'o tamanho gravado é o do arquivo real');
    } finally {
      manifest.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('arquivo de muitos lotes: hash incremental == hash em lote, e as fatias saem em ordem', async () => {
    // §13.2 passo 5 depois da emenda de 2026-09-04: o staging não junta mais o arquivo
    // inteiro na memória. Este arquivo cruza `STAGE_BATCH_BLOCKS` (64 fatias) três vezes, que
    // é onde um `appendBlocks` em lote erraria o `blockOffset` ou a ordem.
    const dir = tempDir('lotes-49');
    const manifest = new ManifestDb(path.join(dir, 'manifest.db'));
    const conteudo = crypto.randomBytes(200 * BLOB_CHUNK_BYTES + 7);
    const arquivo = path.join(dir, 'grande.bin');
    fs.writeFileSync(arquivo, conteudo);
    const blobs = new BlobManager({ manifest, swarm: new Swarm(), dataDir: path.join(dir, 'cache') });
    const chave = Buffer.alloc(32, 9);
    const blocos: Buffer[] = [];
    blobs.attachLocalCore('c'.repeat(64), {
      key: chave,
      replicate: () => {},
      async appendBlocks(chunks) {
        const off = blocos.length;
        for (const c of chunks) blocos.push(Buffer.from(c));
        return off;
      },
      close: async () => {},
    });
    try {
      const t = blobs.createTicketForMain('c'.repeat(64), arquivo, conteudo.byteLength);
      const staged = await blobs.stage(t.ticketId);
      assert.deepEqual(staged.hash, hashForBlobContent(conteudo), 'o hash incremental divergiu do em lote');
      assert.equal(staged.blobId.blockOffset, 0);
      assert.equal(staged.blobId.blockLength, 201);
      assert.equal(staged.blobId.byteLength, conteudo.byteLength);
      assert.equal(blocos.length, 201);
      assert.deepEqual(Buffer.concat(blocos), conteudo, 'as fatias chegaram fora de ordem');
    } finally {
      manifest.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it('o teto que sobra é o de representação, não o de produto', () => {
    const dir = tempDir('teto-49');
    const manifest = new ManifestDb(path.join(dir, 'manifest.db'));
    const arquivo = path.join(dir, 'grande.bin');
    fs.writeFileSync(arquivo, Buffer.alloc(16, 1));
    const blobs = new BlobManager({ manifest, swarm: new Swarm(), dataDir: path.join(dir, 'cache') });
    try {
      // 2^53−1 passa; acima disso `sizeBytes` deixa de fazer round-trip como `u64`/`number`.
      assert.ok(blobs.createTicketForMain('a'.repeat(64), arquivo, Number.MAX_SAFE_INTEGER));
      assert.throws(
        () => blobs.createTicketForMain('a'.repeat(64), arquivo, Number.MAX_SAFE_INTEGER + 2),
        (e: { code?: string }) => e.code === 'E_ATTACHMENT_TOO_LARGE',
      );
    } finally {
      manifest.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});

describe('§49.4 blob.progress / blob.peerLost — bitfield real (§13.4 passo 4)', () => {
  it('publica progresso com pares e `hostAvailable`, e nomeia o par perdido', async () => {
    const dir = tempDir('progresso-49');
    const manifest = new ManifestDb(path.join(dir, 'manifest.db'));
    const conteudo = Buffer.alloc(BLOB_CHUNK_BYTES + 10, 5);
    const blocos = [conteudo.subarray(0, BLOB_CHUNK_BYTES), conteudo.subarray(BLOB_CHUNK_BYTES)];
    const hostHex = 'ab'.repeat(32);
    let status = { blocksHave: 1, peers: [hostHex, 'cd'.repeat(32)] as string[] };
    let liberar = (): void => {};
    const espera = new Promise<void>((resolve) => {
      liberar = resolve;
    });
    const reader: BlobsReaderPort = {
      key: CHAVE_REMOTA,
      replicate() {},
      downloadRange: async () => await espera,
      getBlock: async (seq) => blocos[seq] ?? null,
      rangeStatus: async () => status,
      close: async () => {},
    };
    const eventos: BlobEvent[] = [];
    let tick: (() => void) | null = null;
    const blobs = new BlobManager({
      manifest,
      swarm: new Swarm(),
      dataDir: path.join(dir, 'cache'),
      openReader: () => reader,
      hostKeyOf: () => Buffer.from(hostHex, 'hex'),
      onEvent: (ev) => eventos.push(ev),
      startInterval: (fn) => {
        tick = fn;
        return () => {
          tick = null;
        };
      },
    });
    try {
      const hash = hashForBlobContent(conteudo);
      const emCurso = blobs.download({
        blobsCoreKey: CHAVE_REMOTA,
        blobIdHex: hash.toString('hex').slice(0, 32),
        declaredSize: conteudo.byteLength,
        hash,
        name: 'grande.pdf',
        blobId: { byteOffset: 0, blockOffset: 0, blockLength: 2, byteLength: conteudo.byteLength },
        communityId: 'c'.repeat(64),
      });
      await new Promise((r) => setImmediate(r));
      assert.notEqual(tick, null, 'o loop de progresso não subiu');

      tick!();
      await new Promise((r) => setImmediate(r));
      const progresso = eventos.filter((e) => e.topic === 'blob.progress');
      assert.equal(progresso.length, 1);
      assert.equal(progresso[0]!.data.progress, 0.5, 'metade dos blocos da faixa estão locais');
      assert.equal(progresso[0]!.data.bytesDownloaded, BLOB_CHUNK_BYTES);
      assert.equal(progresso[0]!.data.peers, 2);
      assert.equal(progresso[0]!.data.hostAvailable, true, 'o host está entre os pares com a faixa');
      assert.equal(progresso[0]!.communityId, 'c'.repeat(64), 'a rota tem de viajar FORA do payload (§15.1 regra 2)');

      // Um par some: `remaining` é o que sobrou, contado do bitfield.
      status = { blocksHave: 2, peers: [hostHex] };
      tick!();
      await new Promise((r) => setImmediate(r));
      const perdido = eventos.filter((e) => e.topic === 'blob.peerLost');
      assert.equal(perdido.length, 1);
      assert.equal(perdido[0]!.data.remaining, 1);

      liberar();
      await emCurso;
      assert.equal(tick, null, 'o loop continuou depois do download terminar');
      assert.equal(eventos.at(-1)?.topic, 'blob.completed');
    } finally {
      manifest.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});

describe('§49.5 GC dos leitores esparsos (§22.4)', () => {
  it('fecha o core alheio sem download em voo, e o download seguinte reabre', async () => {
    const dir = tempDir('gc-readers-49');
    const manifest = new ManifestDb(path.join(dir, 'manifest.db'));
    const conteudo = Buffer.from('anexo pequeno');
    let aberturas = 0;
    let fechados = 0;
    const swarm = new Swarm();
    const blobs = new BlobManager({
      manifest,
      swarm,
      dataDir: path.join(dir, 'cache'),
      openReader: () => {
        aberturas += 1;
        return {
          key: CHAVE_REMOTA,
          replicate() {},
          downloadRange: async () => {},
          getBlock: async (seq) => (seq === 0 ? conteudo : null),
          close: async () => {
            fechados += 1;
          },
        };
      },
    });
    const hash = hashForBlobContent(conteudo);
    const pedido = {
      blobsCoreKey: CHAVE_REMOTA,
      blobIdHex: hash.toString('hex').slice(0, 32),
      declaredSize: conteudo.byteLength,
      hash,
      name: 'p.txt',
      blobId: { byteOffset: 0, blockOffset: 0, blockLength: 1, byteLength: conteudo.byteLength },
    };
    try {
      await blobs.download(pedido);
      assert.equal(aberturas, 1);
      assert.equal(blobs.openReaderCount(), 1, 'o leitor do core alheio ficou aberto — é o que o GC coleta');

      const topico = discoveryKeyHexForBlobsCoreKey(CHAVE_REMOTA);
      assert.equal(swarm.isJoined(topico), true, 'o download não entrou no tópico de §14.1');

      assert.deepEqual(await blobs.gcReaders(), { closed: 1 });
      assert.equal(fechados, 1);
      assert.equal(blobs.openReaderCount(), 0);
      // Sem leitor, não há o que procurar na DHT: o tópico sai junto.
      assert.equal(swarm.isJoined(topico), false, 'o tópico do core coletado continuou anunciado');

      // O arquivo já está no cache: força o caminho de rede de novo com outro destino.
      fs.rmSync(path.join(dir, 'cache', CHAVE_REMOTA.toString('hex')), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      await blobs.download(pedido);
      assert.equal(aberturas, 2, 'o core alheio não foi reaberto depois do GC');
    } finally {
      await blobs.close();
      manifest.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});

describe('§49.6 resolver de anexos sem `communityId` (§15.4)', () => {
  it('a consulta por `(blobs_core_key, blob_id)` usa índice, não varredura', () => {
    const dir = tempDir('idx-49');
    const view = openViewDb(path.join(dir, 'view.db'));
    try {
      const plano = view
        .prepare(
          'EXPLAIN QUERY PLAN SELECT name, size_bytes, hash, blob_id FROM attachments WHERE blobs_core_key = ? AND blob_id = ?',
        )
        .all(Buffer.alloc(32, 1), attachmentBlobIdJson({ byteOffset: 0, blockOffset: 0, blockLength: 1, byteLength: 10 })) as Array<{ detail: string }>;
      const detalhe = plano.map((p) => p.detail).join(' | ');
      assert.match(detalhe, /idx_attachments_ref/, `o plano não usou o índice: ${detalhe}`);
      assert.doesNotMatch(detalhe, /SCAN attachments/, `varredura completa da tabela: ${detalhe}`);
    } finally {
      view.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});

// ─── B30 (parcial): o voluntariado de relay existe no produto (§17.7, §15.4) ─────────────

describe('§17.7 relay.* — as três superfícies deixam de ser E_UNKNOWN_COMMAND (B30)', () => {
  it('sem consentimento é E_CONSENT_REQUIRED, e o consentimento persiste no LS', async () => {
    const relogio = { now: T0 };
    const r = await rigLocal('relay-superficie', keypairFromSeed('relay-eu'), relogio);
    try {
      const criada = await r.request('community.create', { name: 'Rede', iconColor: 3 });
      assert.ok(criada.ok, JSON.stringify(criada));
      const cid = (criada.data as Record<string, unknown>)['communityId'] as string;

      // `l2/relay` estava pronto e testado desde a fase 9, e a composição nunca o injetava:
      // as três superfícies respondiam `E_UNKNOWN_COMMAND` no produto inteiro. O primeiro
      // desfecho de §15.4 é o consentimento, não "comando não existe".
      const semConsentimento = await r.request('relay.enable', { communityId: cid });
      assert.equal(semConsentimento.code, 'E_CONSENT_REQUIRED');

      // §17.7 — consentimento explícito e PERSISTIDO; é o que a superfície de U-13 grava.
      const aceite = await r.request('relay.respondConsent', { communityId: cid, accept: true, remember: true });
      assert.ok(aceite.ok, JSON.stringify(aceite));
      assert.equal(r.manifest.getRelayConsent(cid)?.decision, 'accepted');

      const ligado = await r.request('relay.enable', { communityId: cid });
      assert.ok(ligado.ok, JSON.stringify(ligado));
      const dados = ligado.data as { relayPublicKey: string; expiresAt: number; seq: number };
      // A chave é DERIVADA da identidade (`ns/relay/1`): é o que torna impossível apontar o
      // voluntariado para um terceiro (§17.7, T-14).
      assert.equal(
        dados.relayPublicKey,
        deriveRelayKeyPair(keypairFromSeed('relay-eu').secretKey.subarray(0, 32), cid).publicKey.toString('hex'),
      );
      // TTL obrigatório de §6.14 — expirado deixa de ser listado.
      assert.equal(dados.expiresAt, T0 + RELAY_TTL_MS);

      // E o op 60 chega ao log: `relays` do DS é o produtor da lista de §17.7. O append
      // resolve antes do lote projetado (§10.5), então a espera é a mesma dos convites.
      await ate(() => r.runtime.get(cid)!.projector.ds.relays.size === 1, 'R-19 recusou o `relay.volunteer`');

      const desligado = await r.request('relay.disable', { communityId: cid });
      assert.ok(desligado.ok, JSON.stringify(desligado));

      // `remember: false` é decisão explícita de não persistir.
      await r.request('relay.respondConsent', { communityId: cid, accept: true, remember: false });
      assert.equal(r.manifest.getRelayConsent(cid), null);
      assert.equal((await r.request('relay.enable', { communityId: cid })).code, 'E_CONSENT_REQUIRED');
    } finally {
      await r.close();
    }
  });
});

describe('§13.2 blob.stage — a retomada não pode furar a TTL nem o uso único (2026-09-05)', () => {
  function rigStage(clock: () => number) {
    const dir = tempDir('stage-ttl');
    const manifest = new ManifestDb(path.join(dir, 'manifest.db'));
    const arquivo = path.join(dir, 'relatorio.pdf');
    fs.writeFileSync(arquivo, Buffer.alloc(4096, 7));
    const blobs = new BlobManager({
      manifest,
      swarm: new Swarm(),
      dataDir: path.join(dir, 'cache'),
      clock,
      ttlMs: 15 * 60_000,
    });
    return {
      blobs,
      arquivo,
      cleanup() {
        manifest.close();
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      },
    };
  }

  it('ticket vencido é recusado mesmo com a linha de staging viva', async () => {
    let t = 1_000_000;
    const r = rigStage(() => t);
    try {
      const ticket = r.blobs.createTicketForMain('a'.repeat(64), r.arquivo, 4096);
      t += 15 * 60_000 + 1;
      // A linha de staging tem janela órfã de 24 h e sobrevive; a TTL do ticket é de 15 min.
      // O `catch` blanket que existia aqui reconstruía o ticket da linha e seguia em frente,
      // tornando a TTL inócua sempre que a linha estivesse viva.
      await assert.rejects(
        r.blobs.stage(ticket.ticketId, { blobsCoreKey: Buffer.alloc(32, 9) }),
        (e: { code?: string }) => e.code === 'E_TICKET_INVALID',
      );
      // E a segunda tentativa também: apagar o vencido do mapa fazia a próxima parecer
      // "ticket de outro processo" e cair no caminho de retomada.
      await assert.rejects(
        r.blobs.stage(ticket.ticketId, { blobsCoreKey: Buffer.alloc(32, 9) }),
        (e: { code?: string }) => e.code === 'E_TICKET_INVALID',
      );
    } finally {
      r.cleanup();
    }
  });

  it('dois `stage` concorrentes do mesmo ticket: um grava, o outro é recusado', async () => {
    const r = rigStage(() => 1_000_000);
    try {
      const ticket = r.blobs.createTicketForMain('b'.repeat(64), r.arquivo, 4096);
      const [a, b] = await Promise.allSettled([
        r.blobs.stage(ticket.ticketId, { blobsCoreKey: Buffer.alloc(32, 9) }),
        r.blobs.stage(ticket.ticketId, { blobsCoreKey: Buffer.alloc(32, 9) }),
      ]);
      const ok = [a, b].filter((x) => x.status === 'fulfilled');
      const nao = [a, b].filter((x) => x.status === 'rejected');
      // Antes, os dois passavam a guarda `state === 'done'` (que só é gravada no fim) e
      // appendavam o arquivo inteiro no core; o segundo `markDone` sobrescrevia
      // `blobRanges` e os blocos do primeiro viravam lixo que nenhum GC sabe podar.
      assert.equal(ok.length, 1);
      assert.equal(nao.length, 1);
    } finally {
      r.cleanup();
    }
  });
});
