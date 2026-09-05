/**
 * Anexos, download e impacto de saída pela fronteira IPC-R (§15.4 "Arquivos e diagnóstico",
 * §13, §18.7).
 *
 * O que é REAL: `IpcServer`/`IpcClient`, o roteador de §15.4, o `BlobManager` com
 * `manifest.db` em arquivo, o arquivo de origem em disco e o hash BLAKE2b do conteúdo.
 * SIMULADO: o diálogo nativo do main (a função que devolveria o caminho escolhido).
 *
 * A propriedade central é a de §13.7: **o blob primeiro, a mensagem depois** — e o que
 * descreve o blob é o núcleo, nunca o renderer.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { ManifestDb } from '../src/l0/manifest/index.ts';
import { Swarm } from '../src/l0/swarm/index.ts';
import { BlobManager, hashForBlobContent, modoDeRevelacao } from '../src/l2/blobs/index.ts';
import type { Diagnostics } from '../src/l2/diagnostics/index.ts';
import type { SearchService } from '../src/l2/search/index.ts';
import type { QueuedSubmissionResult, SubmissionInput, WriteStatePort } from '../src/l2/communityClient/index.ts';
import { IpcClient, IpcServer, MemoryIpcPort } from '../src/l3/ipcRenderer/index.ts';
import { registerCoreCommands, type MessageSurfaceDeps } from '../src/l3/ipcRenderer/commands.ts';
import { blobAttachmentPort, hostExitImpactPort, tempDir } from './helpers/composition.ts';

const COMUNIDADE = 'ab'.repeat(32);
const EU = 'aa'.repeat(32);
const CANAL = 'ch-geral';

/** Recorte do DS que o roteador consulta para a coluna Perm. de §15.4. */
function writeState(perms: readonly number[]): WriteStatePort {
  return {
    community: { exists: true, hostKey: 'cc'.repeat(32) },
    // 3 = send_messages, 4 = attach_files (§9.1)
    members: new Map([[EU, { state: 'active', roleIds: ['r'] }]]),
    roles: new Map([['r', { permissions: perms }]]),
    channels: new Map([[CANAL, { type: 0, readOnlyForRoleIds: [] }]]),
    messages: new Map(),
  } as unknown as WriteStatePort;
}

type Rig = {
  ipc: IpcClient;
  blobs: BlobManager;
  /** Payloads que a ponte de submissão recebeu — é onde o `attachment` real aparece. */
  enviados: SubmissionInput[];
  arquivo: { path: string; sizeBytes: number; conteudo: Buffer };
  revelados: Array<{ path: string; mode: string }>;
  tokens: { conceder: boolean };
  anexoConhecido: {
    valor: {
      name: string;
      sizeBytes: number;
      hashHex: string;
      blobId: { byteOffset: number; blockOffset: number; blockLength: number; byteLength: number };
    } | null;
  };
  /** As fatias que o `stage` appendou no core local — a forma de bloco de §13.2. */
  blocosDoCore: Buffer[];
  chaveBlobs: Buffer;
  cleanup(): void;
};

async function rig(opts: { perms?: readonly number[] } = {}): Promise<Rig> {
  const dir = tempDir('anexos');
  const manifest = new ManifestDb(path.join(dir, 'manifest.db'));
  const blobs = new BlobManager({
    manifest,
    swarm: new Swarm(),
    dataDir: path.join(dir, 'blobs'),
  });

  // Core de blobs local da comunidade, em memória — é o que o `blob.stage` procura pelo
  // escopo do ticket (§13.1). As fatias ficam registradas para as asserções de baixo.
  const CHAVE_BLOBS = Buffer.alloc(32, 9);
  const blocosDoCore: Buffer[] = [];
  blobs.attachLocalCore(COMUNIDADE, {
    key: CHAVE_BLOBS,
    replicate: () => {},
    async appendBlocks(chunks) {
      const blockOffset = blocosDoCore.length;
      for (const c of chunks) blocosDoCore.push(Buffer.from(c));
      return blockOffset;
    },
    close: async () => {},
  });

  const conteudo = Buffer.from('conteúdo do relatório\n'.repeat(64), 'utf8');
  const arquivoPath = path.join(dir, 'relatorio.pdf');
  fs.writeFileSync(arquivoPath, conteudo);
  const arquivo = { path: arquivoPath, sizeBytes: conteudo.byteLength, conteudo };

  const revelados: Array<{ path: string; mode: string }> = [];
  const anexoConhecido: Rig['anexoConhecido'] = { valor: null };
  const attachments = blobAttachmentPort({
    blobs,
    blobsCoreKeyOf: (cid) => (cid === COMUNIDADE ? CHAVE_BLOBS : null),
    pickFile: () => ({ path: arquivo.path, sizeBytes: arquivo.sizeBytes }),
    resolveAttachment: ({ blobId }) => {
      const v = anexoConhecido.valor;
      if (v === null || JSON.stringify(v.blobId) !== JSON.stringify(blobId)) return null;
      return v;
    },
    onReveal: (a) => revelados.push(a),
  });

  const enviados: SubmissionInput[] = [];
  const messages: MessageSurfaceDeps = {
    writeStateFor: (id) => (id === COMUNIDADE ? writeState(opts.perms ?? [3, 4]) : null),
    selfKeyHex: () => EU,
    submitQueued: (_id, input): QueuedSubmissionResult => {
      enviados.push(input);
      return { ok: true, opId: `op-${enviados.length}`, state: 'queued' };
    },
    retryQueued: () => ({ ok: false, code: 'E_NOT_FOUND' }),
    cancelQueued: () => ({ ok: false, code: 'E_NOT_FOUND' }),
  };

  const tokens = { conceder: false };
  const [coreSide, rendererSide] = MemoryIpcPort.createPair();
  const server = new IpcServer({
    epoch: 1,
    port: coreSide,
    tokenVerifier: { consume: () => tokens.conceder },
    identityStatus: { isLoaded: true },
  });
  registerCoreCommands(server, {
    diagnostics: undefined as unknown as Diagnostics,
    search: undefined as unknown as SearchService,
    messages,
    attachments,
    exitImpact: hostExitImpactPort({
      communities: [{ communityId: COMUNIDADE, name: 'Comunidade' }],
      onlineCount: () => 12,
      inCallCount: () => 3,
      pendingReplication: () => 7,
    }),
  });
  const ipc = new IpcClient();
  ipc.attach(rendererSide);
  const hello = ipc.waitForHello(1_000);
  server.sendHello('anexos', 2);
  await hello;

  return {
    ipc,
    blobs,
    enviados,
    arquivo,
    revelados,
    tokens,
    anexoConhecido,
    blocosDoCore,
    chaveBlobs: CHAVE_BLOBS,
    cleanup() {
      manifest.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    },
  };
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'sem-erro';
  } catch (err) {
    return (err as NodeJS.ErrnoException).code ?? 'sem-codigo';
  }
}

type Staged = {
  blobsCoreKey: string;
  blobId: { byteOffset: number; blockOffset: number; blockLength: number; byteLength: number };
  name: string;
  sizeBytes: number;
  kind: number;
  hash: string;
};

describe('anexos — ticket, staging e a barreira de §13.7', () => {
  it('o caminho nunca cruza o IPC-R: sai ticket, entra ticket', async () => {
    const r = await rig();
    try {
      const ticket = (await r.ipc.request('file.pickForAttachment', { communityId: COMUNIDADE })) as {
        ticketId: string;
        name: string;
        sizeBytes: number;
        kind: number;
      };
      assert.match(ticket.ticketId, /^[0-9a-f]{32}$/);
      assert.equal(ticket.name, 'relatorio.pdf');
      assert.equal(ticket.sizeBytes, r.arquivo.sizeBytes);
      assert.equal(ticket.kind, 3); // document (§13.6)
      // Nada no que voltou parece um caminho de arquivo (T-16, DR-37).
      assert.equal(JSON.stringify(ticket).includes(path.sep + 'relatorio'), false);

      const staged = (await r.ipc.request('blob.stage', { ticketId: ticket.ticketId })) as Staged;
      assert.equal(staged.name, 'relatorio.pdf');
      assert.equal(staged.sizeBytes, r.arquivo.sizeBytes);
      // O hash é o do conteúdo real, calculado pelo núcleo — não algo que o renderer disse.
      assert.equal(staged.hash, hashForBlobContent(r.arquivo.conteudo).toString('hex'));
      assert.equal(staged.blobsCoreKey, Buffer.alloc(32, 9).toString('hex'));
      // §13.2 passo 5 — o conteúdo entrou em fatias no core local, e o `blobId` é a faixa.
      const esperadas = Math.ceil(r.arquivo.sizeBytes / 65536);
      assert.equal(staged.blobId.blockOffset, 0);
      assert.equal(staged.blobId.blockLength, esperadas);
      assert.equal(staged.blobId.byteLength, r.arquivo.sizeBytes);
      assert.equal(r.blocosDoCore.length, esperadas);
      assert.deepEqual(Buffer.concat(r.blocosDoCore), r.arquivo.conteudo);
    } finally {
      r.cleanup();
    }
  });

  it('`message.send` com anexo é montado pelo núcleo a partir do que ele mesmo escreveu', async () => {
    const r = await rig();
    try {
      const ticket = (await r.ipc.request('file.pickForAttachment', { communityId: COMUNIDADE })) as { ticketId: string };
      const staged = (await r.ipc.request('blob.stage', { ticketId: ticket.ticketId })) as Staged;

      await r.ipc.request('message.send', {
        communityId: COMUNIDADE,
        channelId: CANAL,
        content: 'segue o relatório',
        mentions: [],
        attachment: { ticketId: ticket.ticketId },
      });

      const payload = r.enviados[0]?.payload as {
        attachment: { blob: { blobsCoreKey: Buffer; byteOffset: number; blockOffset: number; blockLength: number; byteLength: number }; name: string; sizeBytes: number; kind: number; hash: Buffer };
      };
      assert.equal(payload.attachment.blob.blobsCoreKey.toString('hex'), staged.blobsCoreKey);
      assert.deepEqual(
        {
          byteOffset: payload.attachment.blob.byteOffset,
          blockOffset: payload.attachment.blob.blockOffset,
          blockLength: payload.attachment.blob.blockLength,
          byteLength: payload.attachment.blob.byteLength,
        },
        staged.blobId,
      );
      assert.equal(payload.attachment.name, 'relatorio.pdf');
      assert.equal(payload.attachment.sizeBytes, r.arquivo.sizeBytes);
      assert.deepEqual(payload.attachment.hash, Buffer.from(staged.hash, 'hex'));
    } finally {
      r.cleanup();
    }
  });

  it('a barreira: sem `blob.stage` completo, a mensagem não é enfileirada (§13.7 regra 1)', async () => {
    const r = await rig();
    try {
      const ticket = (await r.ipc.request('file.pickForAttachment', { communityId: COMUNIDADE })) as { ticketId: string };
      // Ticket emitido, staging ainda não rodou: a ordem normativa é blob primeiro.
      assert.equal(
        await code(
          r.ipc.request('message.send', {
            communityId: COMUNIDADE,
            channelId: CANAL,
            content: 'cedo demais',
            mentions: [],
            attachment: { ticketId: ticket.ticketId },
          }),
        ),
        'E_BLOB_NOT_STAGED',
      );
      assert.equal(r.enviados.length, 0);

      // Ticket inventado pelo renderer também não passa.
      assert.equal(
        await code(
          r.ipc.request('message.send', {
            communityId: COMUNIDADE,
            channelId: CANAL,
            content: 'inventado',
            mentions: [],
            attachment: { ticketId: 'f'.repeat(32) },
          }),
        ),
        'E_BLOB_NOT_STAGED',
      );
    } finally {
      r.cleanup();
    }
  });

  it('o renderer não descreve o blob: campos extras no argumento são ignorados', async () => {
    const r = await rig();
    try {
      const ticket = (await r.ipc.request('file.pickForAttachment', { communityId: COMUNIDADE })) as { ticketId: string };
      await r.ipc.request('blob.stage', { ticketId: ticket.ticketId });

      await r.ipc.request('message.send', {
        communityId: COMUNIDADE,
        channelId: CANAL,
        content: 'com metadado mentiroso',
        mentions: [],
        attachment: {
          ticketId: ticket.ticketId,
          name: 'outro-nome.exe',
          sizeBytes: 1,
          kind: 5,
          hash: '00'.repeat(32),
          blobsCoreKey: 'ff'.repeat(32),
        },
      });

      const payload = r.enviados[0]?.payload as { attachment: { name: string; sizeBytes: number; hash: Buffer } };
      assert.equal(payload.attachment.name, 'relatorio.pdf');
      assert.equal(payload.attachment.sizeBytes, r.arquivo.sizeBytes);
      assert.deepEqual(payload.attachment.hash, hashForBlobContent(r.arquivo.conteudo));
    } finally {
      r.cleanup();
    }
  });

  it('anexar exige `attach_files` além de `send_messages` (§7.4)', async () => {
    const r = await rig({ perms: [3] }); // só send_messages
    try {
      const ticket = (await r.ipc.request('file.pickForAttachment', { communityId: COMUNIDADE })) as { ticketId: string };
      await r.ipc.request('blob.stage', { ticketId: ticket.ticketId });
      assert.equal(
        await code(
          r.ipc.request('message.send', {
            communityId: COMUNIDADE,
            channelId: CANAL,
            content: 'sem permissão',
            mentions: [],
            attachment: { ticketId: ticket.ticketId },
          }),
        ),
        'E_PERMISSION_DENIED',
      );
      // Sem anexo, a mesma identidade envia normalmente.
      await r.ipc.request('message.send', { communityId: COMUNIDADE, channelId: CANAL, content: 'texto', mentions: [] });
      assert.equal(r.enviados.length, 1);
    } finally {
      r.cleanup();
    }
  });

  it('o diálogo cancelado é `E_CANCELLED`, não um ticket vazio', async () => {
    const r = await rig();
    try {
      const dir = tempDir('anexos-cancel');
      const manifest = new ManifestDb(path.join(dir, 'manifest.db'));
      const blobs = new BlobManager({ manifest, swarm: new Swarm(), dataDir: path.join(dir, 'blobs') });
      const porta = blobAttachmentPort({
        blobs,
        blobsCoreKeyOf: () => Buffer.alloc(32, 9),
        pickFile: () => null,
        resolveAttachment: () => null,
      });
      await assert.rejects(porta.pick(COMUNIDADE), (e: NodeJS.ErrnoException) => e.code === 'E_CANCELLED');
      manifest.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    } finally {
      r.cleanup();
    }
  });
});

describe('download e revelação (§13.4, §13.6, §15.3)', () => {
  /** Um anexo alheio já projetado: é o que `blob.download` recebe de §15.4. */
  function anexoAlheio(r: Rig, name: string, conteudo: Buffer) {
    const blobId = { byteOffset: 0, blockOffset: 0, blockLength: 1, byteLength: conteudo.byteLength };
    r.anexoConhecido.valor = {
      name,
      sizeBytes: conteudo.byteLength,
      hashHex: hashForBlobContent(conteudo).toString('hex'),
      blobId,
    };
    return {
      blobsCoreKey: 'bb'.repeat(32),
      blobId,
    };
  }

  it('`blob.download` devolve o estado na hora e `blob.cancel` o encerra', async () => {
    const r = await rig();
    try {
      const ref = anexoAlheio(r, 'foto.png', Buffer.from('imagem-falsa'));
      const started = (await r.ipc.request('blob.download', { communityId: COMUNIDADE, ...ref })) as { state: string };
      // §13.4: o comando não espera o download; o progresso vai por `blob.progress`.
      assert.ok(['queued', 'downloading', 'verifying', 'downloaded', 'unavailable'].includes(started.state), started.state);

      await r.ipc.request('blob.cancel', ref);
      assert.equal(r.blobs.getDownloadState(ref.blobsCoreKey, r.anexoConhecido.valor!.hashHex.slice(0, 32)), 'cancelled');
    } finally {
      r.cleanup();
    }
  });

  it('argumento malformado é `E_VALIDATION` antes de qualquer decisão (§15.1 regra 8)', async () => {
    const r = await rig();
    try {
      assert.equal(
        await code(r.ipc.request('blob.download', { communityId: COMUNIDADE, blobsCoreKey: 'não-hex', blobId: {} })),
        'E_VALIDATION',
      );
      assert.equal(
        await code(
          r.ipc.request('blob.cancel', {
            blobsCoreKey: 'bb'.repeat(32),
            blobId: { byteOffset: -1, blockOffset: 0, blockLength: 1, byteLength: 1 },
          }),
        ),
        'E_VALIDATION',
      );
      assert.equal(
        await code(r.ipc.request('blob.reveal', { blobsCoreKey: 'bb'.repeat(32), blobId: {}, mode: 'ambos' })),
        'E_VALIDATION',
      );
    } finally {
      r.cleanup();
    }
  });

  it('revelar o que não baixou é `E_NOT_DOWNLOADED`; `archive` exige confirmação nativa (§15.3)', async () => {
    const r = await rig();
    try {
      const conteudo = Buffer.from('pacote');
      const ref = anexoAlheio(r, 'pacote.zip', conteudo);
      assert.equal(await code(r.ipc.request('blob.reveal', { ...ref, mode: 'folder' })), 'E_PERMISSION_DENIED');

      // §15.3 põe `blob.reveal` de `archive` na classe main-confirmed: sem token não passa,
      // e com token a decisão volta a ser a de §13.6 — que ainda não baixou.
      r.tokens.conceder = true;
      assert.equal(
        await code(r.ipc.request('blob.reveal', { ...ref, mode: 'folder' }, 'token-do-main')),
        'E_NOT_DOWNLOADED',
      );

      // Um `document` é standard: nenhuma confirmação, e a recusa é a de §13.6.
      r.tokens.conceder = false;
      const doc = anexoAlheio(r, 'texto.pdf', conteudo);
      assert.equal(await code(r.ipc.request('blob.reveal', { ...doc, mode: 'open' })), 'E_NOT_DOWNLOADED');
      assert.deepEqual(r.revelados, []);
    } finally {
      r.cleanup();
    }
  });

  it('o que foi staged localmente é revelável, e quem age é o main', async () => {
    const r = await rig();
    try {
      const ticket = (await r.ipc.request('file.pickForAttachment', { communityId: COMUNIDADE })) as { ticketId: string };
      const staged = (await r.ipc.request('blob.stage', { ticketId: ticket.ticketId })) as Staged;
      r.anexoConhecido.valor = {
        name: staged.name,
        sizeBytes: staged.sizeBytes,
        hashHex: staged.hash,
        blobId: {
          byteOffset: staged.blobId.byteOffset,
          blockOffset: staged.blobId.blockOffset,
          blockLength: staged.blobId.blockLength,
          byteLength: staged.blobId.byteLength,
        },
      };

      assert.deepEqual(
        await r.ipc.request('blob.reveal', { blobsCoreKey: staged.blobsCoreKey, blobId: staged.blobId, mode: 'folder' }),
        {},
      );
      assert.equal(r.revelados.length, 1);
      assert.equal(r.revelados[0]?.mode, 'folder');
      // O caminho existe, mas é do main — nunca voltou pelo IPC-R.
      assert.ok(fs.existsSync(r.revelados[0]!.path));
    } finally {
      r.cleanup();
    }
  });

  it('§13.6 regra 1 — `folder` vale para o que `open` recusa, e executável não tem nem isso', async () => {
    const dir = tempDir('anexos-modo');
    const manifest = new ManifestDb(path.join(dir, 'manifest.db'));
    const blobs = new BlobManager({ manifest, swarm: new Swarm(), dataDir: path.join(dir, 'blobs') });
    const chave = Buffer.alloc(32, 7);

    // "Todo o resto oferece somente 'Mostrar na pasta'" — a metade da regra 1 que a
    // verificação única recusava junto com o abrir, deixando um `.bin` sem ação nenhuma.
    const casos = [
      { nome: 'relatorio.pdf', open: true, folder: true },
      { nome: 'pacote.zip', open: true, folder: true }, // B73 — §15.3 gateia com caixa nativa
      { nome: 'dados.bin', open: false, folder: true }, // `other`
      { nome: 'instalador.exe', open: false, folder: false }, // regra 2 — nem revelar
    ];
    for (const [i, caso] of casos.entries()) {
      const conteudo = crypto.randomBytes(16 + i);
      const hashHex = hashForBlobContent(conteudo).toString('hex');
      const alvo = path.join(dir, caso.nome);
      fs.writeFileSync(alvo, conteudo);
      blobs.cache.upsert({ blobsCoreKey: chave, blobIdHex: hashHex.slice(0, 32), state: 'downloaded', path: alvo, bytesDownloaded: conteudo.length });
      assert.equal(blobs.canReveal(chave, hashHex.slice(0, 32), 'open').allowed, caso.open, `${caso.nome} · open`);
      assert.equal(blobs.canReveal(chave, hashHex.slice(0, 32), 'folder').allowed, caso.folder, `${caso.nome} · folder`);
      // B74 — a mesma decisão, dita à UI pelo nome do log e SEM depender do download.
      assert.equal(modoDeRevelacao(caso.nome), caso.open ? 'open' : caso.folder ? 'folder' : 'none', `${caso.nome} · modo`);
    }

    // §13.6 regra 1: quem delimita é a extensão REAL, não o `kind` de quem enviou (T-48).
    assert.equal(modoDeRevelacao('foto.png.exe'), 'none');
    assert.equal(modoDeRevelacao('sem-extensao'), 'folder');

    manifest.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it('executável não é revelável nem depois de baixado (§13.6 regra 2)', async () => {
    const r = await rig();
    try {
      const dir = tempDir('anexos-exe');
      const manifest = new ManifestDb(path.join(dir, 'manifest.db'));
      const blobs = new BlobManager({ manifest, swarm: new Swarm(), dataDir: path.join(dir, 'blobs') });
      const conteudo = crypto.randomBytes(32);
      const hashHex = hashForBlobContent(conteudo).toString('hex');
      const blobIdHex = hashHex.slice(0, 32);
      const chave = Buffer.alloc(32, 3);
      const alvo = path.join(dir, 'instalador.exe');
      fs.writeFileSync(alvo, conteudo);
      blobs.cache.upsert({ blobsCoreKey: chave, blobIdHex, state: 'downloaded', path: alvo, bytesDownloaded: conteudo.length });

      const porta = blobAttachmentPort({
        blobs,
        blobsCoreKeyOf: () => chave,
        pickFile: () => null,
        resolveAttachment: () => ({ name: 'instalador.exe', sizeBytes: conteudo.length, hashHex, blobId: { byteOffset: 0, blockOffset: 0, blockLength: 1, byteLength: conteudo.length } }),
      });
      const ref = { blobsCoreKey: chave.toString('hex'), blobId: { byteOffset: 0, blockOffset: 0, blockLength: 1, byteLength: conteudo.length } };
      assert.deepEqual(porta.reveal({ ...ref, mode: 'open' }), { ok: false, code: 'E_TYPE_NOT_OPENABLE' });

      manifest.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    } finally {
      r.cleanup();
    }
  });
});

describe('host.exitImpact (§15.4, §18.7)', () => {
  it('informa o impacto por comunidade e não avisa ninguém (U-06)', async () => {
    const r = await rig();
    try {
      const impacto = (await r.ipc.request('host.exitImpact', {})) as Array<Record<string, unknown>>;
      assert.deepEqual(impacto, [
        { communityId: COMUNIDADE, name: 'Comunidade', onlineCount: 12, inCallCount: 3, pendingReplication: 7 },
      ]);
    } finally {
      r.cleanup();
    }
  });
});

/**
 * §18.6/§18.7 — o `close()` do `BlobManager` só pode devolver com o disco liberado.
 *
 * A parada da comunidade (`OpenCommunity.stop()`) é síncrona por contrato e chama
 * `detachLocalCore` sem poder esperá-lo. Enquanto o fechamento em voo não era registrado,
 * `close()` devolvia com o RocksDB do core de blobs ainda fechando — e quem confia no fim do
 * `close()` para apagar arquivos (a máquina de wipe, o draining, e todo rig que remove o
 * diretório temporário) encontrava `ENOTEMPTY`. Era o flake que mudava de arquivo a cada
 * execução da suíte, e a causa não estava no teardown do rig: estava aqui.
 */
describe('§58.4 fechamento do BlobManager — `close()` não devolve com core em voo', () => {
  it('espera o `detachLocalCore` disparado de contexto síncrono', async () => {
    const dir = tempDir('blobs-fechamento');
    try {
      const manifest = new ManifestDb(path.join(dir, 'manifest.db'));
      const blobs = new BlobManager({ manifest, swarm: new Swarm(), dataDir: path.join(dir, 'blobs') });

      let fechado = false;
      blobs.attachLocalCore(COMUNIDADE, {
        key: Buffer.alloc(32, 7),
        replicate: () => {},
        appendBlocks: async () => 0,
        // Fechar leva tempo: é o que o RocksDB faz de verdade por baixo do writer.
        close: async () => {
          await new Promise((r) => setTimeout(r, 30));
          fechado = true;
        },
      });

      // Exatamente o que o `stop()` da comunidade faz: dispara e não espera.
      void blobs.detachLocalCore(COMUNIDADE);
      assert.equal(fechado, false, 'o fechamento ainda não terminou — é essa a janela do defeito');

      await blobs.close();
      assert.equal(fechado, true, '`close()` devolveu antes de o core fechar');
      manifest.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});
