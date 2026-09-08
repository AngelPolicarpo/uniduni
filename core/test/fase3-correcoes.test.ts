import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { ManifestDb } from '../src/l0/manifest/index.ts';
import { openViewDb } from '../src/l0/view/index.ts';
import { HostStatusTracker } from '../src/composition/hostStatus.ts';
import { PresenceManager } from '../src/l2/presence/index.ts';
import { encodeCursor, decodeCursor } from '../src/composition/queries.ts';
import { SearchService } from '../src/l2/search/service.ts';

const COMMUNITY = 'comm-correcoes';

function tempDb(): { dir: string; dbPath: string; manifest: ManifestDb } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'correcoes-'));
  const dbPath = path.join(dir, 'manifest.db');
  return { dir, dbPath, manifest: new ManifestDb(dbPath) };
}

describe('Fase 3 — Correções de Auditoria e Estabilização', () => {
  it('cabeça em failed/E_AUTHOR_SEQ_OVERTAKEN não bloqueia itens queued posteriores na lane do canal', () => {
    const { dir, manifest } = tempDb();
    try {
      const row1 = manifest.enqueue({
        opId: 'op-1',
        communityId: COMMUNITY,
        channelId: 'ch-geral',
        sequenceScope: 'channel:ch-geral',
        kind: 1,
        authorSeq: 1,
        envelope: Buffer.from('env-1'),
        clientRef: 'ref-1',
        now: 1000,
      });
      const row2 = manifest.enqueue({
        opId: 'op-2',
        communityId: COMMUNITY,
        channelId: 'ch-geral',
        sequenceScope: 'channel:ch-geral',
        kind: 1,
        authorSeq: 2,
        envelope: Buffer.from('env-2'),
        clientRef: 'ref-2',
        now: 1000,
      });

      assert.ok(row1.localSeq !== null);
      assert.ok(row2.localSeq !== null);

      // Simula que row1 falhou terminalmente por E_AUTHOR_SEQ_OVERTAKEN
      manifest.setState(row1.localSeq, 'failed', { last_error: 'E_AUTHOR_SEQ_OVERTAKEN' });

      // ready() deve retornar row2 mesmo com row1 falhada na cabeça
      const groups = manifest.ready(COMMUNITY, Date.now() + 1000, 10);
      const chRows = groups.get('ch-geral') ?? [];
      assert.equal(chRows.length, 1);
      assert.equal(chRows[0]?.op_id, 'op-2');
    } finally {
      manifest.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('HostStatusTracker: duas falhas de hello em estado online transicionam para reconnecting', () => {
    const vistos = new Map<string, number>();
    const eventos: any[] = [];
    const tracker = new HostStatusTracker({
      manifest: {
        getLastHostSeenAt: (cid: string) => vistos.get(cid) ?? null,
        setLastHostSeenAt: (cid: string, at: number) => void vistos.set(cid, at),
      } as any,
      emit: (ev) => eventos.push(ev.data),
      now: () => 1000,
      schedule: () => 1,
      cancel: () => {},
      outboxOf: () => undefined,
      stateFor: () => null,
      replicationStateOf: () => null,
      selfKeyHex: () => 'aa'.repeat(32),
    });

    tracker.ensure('c1', { isHost: false });
    tracker.channelAttached('c1');
    tracker.markSeen('c1');
    assert.equal(tracker.statusOf('c1'), 'online');

    // Primeira falha em online: attempts vira 1, continua online
    tracker.noteHelloFailure('c1');
    assert.equal(tracker.statusOf('c1'), 'online');
    assert.equal(tracker.attemptOf('c1'), 1);

    // Segunda falha em online: transiciona para reconnecting
    tracker.noteHelloFailure('c1');
    assert.equal(tracker.statusOf('c1'), 'reconnecting');
    assert.equal(tracker.attemptOf('c1'), 2);

    // Contato renovado volta a online e reseta attempts
    tracker.markSeen('c1');
    assert.equal(tracker.statusOf('c1'), 'online');
    assert.equal(tracker.attemptOf('c1'), 0);
  });

  it('PresenceManager: ingestPresence preserva lastPublishAt local e previne envenenamento por clock skew', () => {
    let agora = 100_000;
    const pm = new PresenceManager({ clock: { now: () => agora } });

    // Publica presença local
    const p1 = pm.publishPresence({ communityId: 'c1', identityKey: 'eu', status: 'online' });
    assert.equal(p1.ok, true);

    // Recebe push do host com relógio adiantado em 30 segundos (skew remoto)
    pm.ingestPresence({ communityId: 'c1', identityKey: 'eu', status: 'online', at: agora + 30_000 });

    // Avança 6 segundos no tempo local (passou da janela RATE_LIMIT_PRESENCE_MS de 5s)
    agora += 6_000;

    // Próxima publicação local NÃO deve ser barrada pelo relógio adiantado do host
    const p2 = pm.publishPresence({ communityId: 'c1', identityKey: 'eu', status: 'idle' });
    assert.equal(p2.ok, true);
  });

  it('queries: decodeCursor rejeita cursor com escopo incompatível (E_BAD_CURSOR)', () => {
    const cursor = encodeCursor({ seq: 10, id: 'msg-1', scope: 'ch-geral' });
    assert.deepEqual(decodeCursor(cursor, 'ch-geral'), { seq: 10, id: 'msg-1' });

    assert.throws(
      () => decodeCursor(cursor, 'ch-outro'),
      (e: any) => e.code === 'E_BAD_CURSOR',
    );
  });

  it('SearchService: busca puramente filtrada não gera erro e executa sem MATCH', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-'));
    const viewDb = openViewDb(path.join(dir, 'view.db'));
    try {
      // Cria canal de texto (type 0) e insere mensagem
      viewDb.prepare(
        "INSERT INTO channels (community_id, id, category_id, type, name, rank, read_only_role_ids) VALUES ('c1', 'ch1', 'cat1', 0, 'geral', 'a', '[]')",
      ).run();
      viewDb.prepare(
        "INSERT INTO messages (id, community_id, channel_id, author_key, seq, content, author_ts, host_ts, clock_skewed, orphaned, pinned, hidden_by_ban) " +
          "VALUES ('m1', 'c1', 'ch1', 'author1', 1, 'mensagem teste', 1000, 1000, 0, 0, 1, 0)",
      ).run();

      const search = new SearchService({ view: viewDb, clock: { now: () => 1000 } });
      // Busca puramente filtrada (sem texto, match === null): consulta direto messages sem JOIN com messages_fts
      const res = search.search({
        communityId: 'c1',
        query: '',
        filters: { kind: 'pinned' },
        limitPerGroup: 10,
      });

      assert.equal(res.messages.length, 1);
      assert.equal(res.messages[0]?.id, 'm1');
    } finally {
      viewDb.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
