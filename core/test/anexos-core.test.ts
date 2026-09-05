// §47 — o download de verdade sobre a porta de leitura esparsa (§13.4).
//
// O que é REAL: o `BlobManager`, o `manifest.db` em arquivo, o hash BLAKE2b e a máquina de
// estados de `local_blob_cache`. SIMULADO: o core remoto (um mapa seq→bloco) e a rede que
// o alimenta — a rede de verdade é o teste de fechamento em `anexos-rede.test.ts`.
//
// Propriedades provadas aqui, cada uma nomeada na spec:
//   §13.4 passo 5 — abortar quando os bytes recebidos estouram `declaredSize`;
//   §13.4 passo 6 — hash divergente descarta o arquivo (`attachment.corrupt`);
//   §14.5        — faixa que não chega dentro do prazo é `blob.unavailable`, não espera eterna.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';

import { ManifestDb } from '../src/l0/manifest/index.ts';
import { Swarm } from '../src/l0/swarm/index.ts';
import {
  BLOB_CHUNK_BYTES,
  BlobManager,
  hashForBlobContent,
  type BlobEvent,
  type BlobsReaderPort,
} from '../src/l2/blobs/index.ts';
import { tempDir } from './helpers/composition.ts';

const CHAVE_REMOTA = Buffer.alloc(32, 4);

/** Core remoto simulado: os blocos que "o autor" tem, servidos por faixa. */
function leitorFake(conteudo: Buffer | null): BlobsReaderPort & { pedidos: Array<{ start: number; end: number }> } {
  const blocos = new Map<number, Buffer>();
  if (conteudo !== null) {
    for (let off = 0; off < conteudo.byteLength; off += BLOB_CHUNK_BYTES) {
      blocos.set(blocos.size, conteudo.subarray(off, Math.min(off + BLOB_CHUNK_BYTES, conteudo.byteLength)));
    }
  }
  const pedidos: Array<{ start: number; end: number }> = [];
  return {
    key: CHAVE_REMOTA,
    pedidos,
    replicate() {},
    async downloadRange(start, end) {
      pedidos.push({ start, end });
    },
    async getBlock(seq) {
      return blocos.get(seq) ?? null;
    },
    close: async () => {},
  };
}

type Rig = {
  blobs: BlobManager;
  eventos: BlobEvent[];
  cleanup(): void;
};

function rig(reader: BlobsReaderPort | null, timeoutMs = 1_000): Rig {
  const dir = tempDir('anexos-core');
  const manifest = new ManifestDb(path.join(dir, 'manifest.db'));
  const eventos: BlobEvent[] = [];
  const blobs = new BlobManager({
    manifest,
    swarm: new Swarm(),
    dataDir: path.join(dir, 'cache'),
    openReader: () => reader,
    downloadTimeoutMs: timeoutMs,
    onEvent: (ev) => eventos.push(ev),
  });
  return {
    blobs,
    eventos,
    cleanup() {
      manifest.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    },
  };
}

function optsDe(
  conteudo: Buffer,
  extra: Partial<Parameters<BlobManager['download']>[0]> = {},
): Parameters<BlobManager['download']>[0] {
  const hash = hashForBlobContent(conteudo);
  return {
    blobsCoreKey: CHAVE_REMOTA,
    blobIdHex: hash.toString('hex').slice(0, 32),
    declaredSize: conteudo.byteLength,
    hash,
    name: 'relatorio.pdf',
    blobId: {
      byteOffset: 0,
      blockOffset: 0,
      blockLength: Math.ceil(conteudo.byteLength / BLOB_CHUNK_BYTES),
      byteLength: conteudo.byteLength,
    },
    communityId: 'ab'.repeat(32),
    ...extra,
  };
}

describe('§13.4 — o download monta o arquivo a partir dos blocos que chegaram', () => {
  it('faixa íntegra: blocos → hash verificado → arquivo em disco e `blob.completed`', async () => {
    // Três blocos: duas fatias cheias e uma resto.
    const conteudo = crypto.randomBytes(BLOB_CHUNK_BYTES * 2 + 700);
    const r = rig(leitorFake(conteudo));
    try {
      const opts = optsDe(conteudo);
      const { path: arquivo } = await r.blobs.download(opts);
      assert.ok(fs.readFileSync(arquivo).equals(conteudo));
      assert.equal(r.blobs.getDownloadState(CHAVE_REMOTA, opts.blobIdHex), 'downloaded');
      const completed = r.eventos.find((e) => e.topic === 'blob.completed');
      assert.equal(completed?.data.path, arquivo);
      assert.equal(completed?.data.blobIdHex, opts.blobIdHex);
      // A rota (§15.1 regra 2) não entra no payload da tabela de §15.5.
      assert.equal('communityId' in (completed?.data ?? {}), false);
    } finally {
      r.cleanup();
    }
  });

  it('o que já está em cache e bate o hash nem abre a rede', async () => {
    const conteudo = crypto.randomBytes(5_000);
    const leitor = leitorFake(conteudo);
    const r = rig(leitor);
    try {
      await r.blobs.download(optsDe(conteudo));
      const antes = leitor.pedidos.length;
      await r.blobs.download(optsDe(conteudo));
      assert.equal(leitor.pedidos.length, antes);
    } finally {
      r.cleanup();
    }
  });

  it('§13.4 passo 5 — bytes recebidos acima de `declaredSize` abortam com `corrupt` (cause size)', async () => {
    const conteudo = crypto.randomBytes(10_000);
    const r = rig(leitorFake(conteudo));
    try {
      await assert.rejects(
        r.blobs.download(optsDe(conteudo, { declaredSize: 1_000 })),
        (e: NodeJS.ErrnoException) => e.code === 'E_BLOB_CORRUPT',
      );
      assert.equal(r.blobs.getDownloadState(CHAVE_REMOTA, optsDe(conteudo).blobIdHex), 'corrupt');
      const corrupt = r.eventos.find((e) => e.topic === 'attachment.corrupt');
      assert.equal(corrupt?.data.cause, 'size');
      assert.equal(corrupt?.communityId, 'ab'.repeat(32), 'a rota acompanha o evento');
    } finally {
      r.cleanup();
    }
  });

  it('§13.4 passo 6 — hash divergente descarta o que veio (`corrupt`, cause hash)', async () => {
    const conteudo = crypto.randomBytes(10_000);
    const r = rig(leitorFake(conteudo));
    try {
      // O tamanho confere; o hash declarado na mensagem projetada é de OUTRO conteúdo.
      const opts = { ...optsDe(conteudo), hash: hashForBlobContent(Buffer.from('outro-conteudo')) };
      await assert.rejects(r.blobs.download(opts), (e: NodeJS.ErrnoException) => e.code === 'E_BLOB_CORRUPT');
      assert.equal(r.blobs.getDownloadState(CHAVE_REMOTA, opts.blobIdHex), 'corrupt');
      const corrupt = r.eventos.find((e) => e.topic === 'attachment.corrupt');
      assert.equal(corrupt?.data.cause, 'hash');
    } finally {
      r.cleanup();
    }
  });

  it('§14.5 — faixa sem par dentro do prazo é `unavailable` e `E_NO_PEERS`, não espera eterna', async () => {
    // Core existe, mas está vazio para este nó: nenhum par tem os blocos.
    const r = rig(leitorFake(null), 300);
    try {
      const alvo = Buffer.from('nunca-baixado');
      await assert.rejects(r.blobs.download(optsDe(alvo)), (e: NodeJS.ErrnoException) => e.code === 'E_NO_PEERS');
      assert.equal(r.blobs.getDownloadState(CHAVE_REMOTA, optsDe(alvo).blobIdHex), 'unavailable');
      assert.ok(r.eventos.some((e) => e.topic === 'blob.unavailable'));
    } finally {
      r.cleanup();
    }
  });

  it('sem `openReader` injetado, o caminho local de rig continua valendo (compatibilidade)', async () => {
    const dir = tempDir('anexos-core-local');
    const manifest = new ManifestDb(path.join(dir, 'manifest.db'));
    try {
      const blobs = new BlobManager({ manifest, swarm: new Swarm(), dataDir: dir });
      const conteudo = Buffer.from('só-disco-mesmo');
      const chave = Buffer.alloc(32, 6);
      fs.mkdirSync(path.join(dir, chave.toString('hex')), { recursive: true });
      fs.writeFileSync(path.join(dir, chave.toString('hex'), `${hashForBlobContent(conteudo).toString('hex').slice(0, 32)}-x.pdf`), conteudo);
      const { path: arquivo } = await blobs.download({
        blobsCoreKey: chave,
        blobIdHex: hashForBlobContent(conteudo).toString('hex').slice(0, 32),
        declaredSize: conteudo.byteLength,
        hash: hashForBlobContent(conteudo),
        name: 'x.pdf',
        blobId: { byteOffset: 0, blockOffset: 0, blockLength: 1, byteLength: conteudo.byteLength },
      });
      assert.ok(fs.readFileSync(arquivo).equals(conteudo));
    } finally {
      manifest.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});

// ─── §13.4 — o cancelamento CANCELA (correção de 2026-09-05) ───────────────────────────

describe('`blob.cancel` interrompe o download em voo', () => {
  it('cancelar durante a faixa não grava arquivo, não emite `blob.completed` e o estado fica `cancelled`', async () => {
    const conteudo = crypto.randomBytes(BLOB_CHUNK_BYTES * 3);
    const base = leitorFake(conteudo);
    const opts = optsDe(conteudo);
    let r: Rig | null = null;
    // O cancelamento chega pela IPC no meio da faixa: entre um `getBlock` e o próximo.
    const leitor: BlobsReaderPort = {
      ...base,
      async getBlock(seq) {
        if (seq === 1) r!.blobs.cancelDownload(CHAVE_REMOTA, opts.blobIdHex);
        return base.getBlock(seq);
      },
    };
    r = rig(leitor);
    try {
      await assert.rejects(r.blobs.download(opts), (e: { code?: string }) => e.code === 'E_CANCELLED');
      // Antes, o motor terminava, gravava o arquivo e emitia `blob.completed` POR CIMA do
      // "cancelado" que a tela já mostrava — e a banda já tinha sido gasta.
      assert.equal(r.blobs.getDownloadState(CHAVE_REMOTA, opts.blobIdHex), 'cancelled');
      assert.equal(r.eventos.some((e) => e.topic === 'blob.completed'), false);
    } finally {
      r.cleanup();
    }
  });

  it('um cancelamento antigo não derruba o download seguinte do mesmo blob', async () => {
    const conteudo = crypto.randomBytes(2_000);
    const r = rig(leitorFake(conteudo));
    try {
      const opts = optsDe(conteudo);
      r.blobs.cancelDownload(CHAVE_REMOTA, opts.blobIdHex);
      // A marca é por tentativa: o `download` seguinte a zera e roda até o fim.
      const { path: arquivo } = await r.blobs.download(opts);
      assert.ok(fs.readFileSync(arquivo).equals(conteudo));
      assert.equal(r.blobs.getDownloadState(CHAVE_REMOTA, opts.blobIdHex), 'downloaded');
    } finally {
      r.cleanup();
    }
  });
});
