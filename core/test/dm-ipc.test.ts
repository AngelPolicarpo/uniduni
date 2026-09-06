/**
 * A superfície IPC-R da conversa direta — §31.16 (14 comandos, 12 eventos, 5 queries).
 *
 * O teste que fecha o item é o **contrato de §31.10**: `dm.send` responde **síncrono**, com o
 * registro **já no log**. Não há `{opId, state:'queued'}`, não há desfecho por evento, e o
 * `ordSum` que volta é o da ordem canônica de §31.6 — o que se afirma aqui é que o número
 * respondido é o mesmo que a projeção materializa depois, dos **dois** lados.
 *
 * A pilha é inteira de produto: `manifest.db` e `view.db` reais em arquivo, `dmFold` e
 * `dmProjector` de produto, `directMessages` de produto, o `p2p-dm/1` sobre `Protomux` de
 * verdade e o `IpcServer` real com os frames de §15.1. O que é de mentira são os **cores** —
 * pela mesma razão dos cabos anteriores: a ordem em que os blocos chegam é o que se quer
 * controlar, e um hypercore em disco não dá controle nenhum sobre isso.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { openManifestDb, type ManifestDb } from '../src/l0/manifest/index.ts';
import { openViewDb, type ViewDb } from '../src/l0/view/index.ts';
import { Swarm } from '../src/l0/swarm/index.ts';
import type { SwarmConnection } from '../src/l0/swarm/ports.ts';
import { dmConversationKey } from '../src/l1/dmCodec/index.ts';
import { IpcServer, MemoryIpcPort } from '../src/l3/ipcRenderer/index.ts';
import { EventFanout } from '../src/l3/ipcRenderer/fanout.ts';
import { registerDmCommands } from '../src/l3/ipcRenderer/dmCommands.ts';
import { criarDmRuntime, type DmRuntime } from '../src/composition/dmRuntime.ts';
import { criarDmCall } from '../src/composition/dmCall.ts';
import { decodeDmCursor, encodeDmCursor } from '../src/composition/dmQueries.ts';

import { dmKeypair, type Keypair } from './helpers/dm.ts';
import { BackendDeMentira, parDeStreamsNoise } from './helpers/dmRede.ts';

const TEMPS: string[] = [];
after(() => {
  for (const d of TEMPS) fs.rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-ipc-'));
  TEMPS.push(d);
  return d;
}

type Resposta = { ok: boolean; data?: unknown; code: string | null; message?: string };

type No = {
  readonly rotulo: string;
  readonly identity: Keypair;
  readonly manifest: ManifestDb;
  readonly view: ViewDb;
  readonly backend: BackendDeMentira;
  readonly dm: DmRuntime;
  readonly eventos: Array<{ topic: string; data: Record<string, unknown> }>;
  request(cmd: string, arg?: unknown): Promise<Resposta>;
  close(): Promise<void>;
};

async function no(rotulo: string): Promise<No> {
  const dir = tempDir();
  const identity = dmKeypair(rotulo);
  const manifest = openManifestDb(path.join(dir, 'manifest.db'));
  const view = openViewDb(path.join(dir, 'view.db'));
  const backend = new BackendDeMentira();
  const swarm = new Swarm({ backend });
  const eventos: Array<{ topic: string; data: Record<string, unknown> }> = [];

  const [coreSide, rendererSide] = MemoryIpcPort.createPair();
  const ipc = new IpcServer({
    epoch: 1,
    port: coreSide,
    tokenVerifier: { consume: () => true },
    identityStatus: { isLoaded: true },
  });
  const fanout = new EventFanout(ipc);

  const dm = await criarDmRuntime({
    manifest,
    view,
    swarm,
    identity: () => identity,
    dataKey: Buffer.alloc(32, 9),
    coresDir: path.join(dir, 'cores'),
    foldBuildId: 'dm-ipc',
    onEvent: (topic, data) => {
      eventos.push({ topic, data: { ...data } });
      fanout.emit(
        { topic, data },
        typeof data['conversationId'] === 'string' ? { conversationId: data['conversationId'] } : {},
      );
    },
    // **Cores de verdade, em disco.** Diferente dos cabos de §103 e §104, aqui a replicação
    // precisa acontecer: o que este arquivo mede é a superfície ponta a ponta, e "a mensagem
    // que `alice` enviou aparece na projeção de `bob`" não é afirmável com core de mentira.
  });
  await dm.boot();

  // §31.15 — a chamada de dois. `midia: () => null` é o caso "esta instalação não tem socket
  // de mídia": o `BackendDeMentira` não a tem, e o que sobra é exatamente o que §31.15 exige
  // que exista sem serviço nenhum — sinalização pelo próprio cabo. A lista de ICE nasce vazia,
  // e vazia é honesto (§17.3: sem STUN a chamada fecha só em rede local).
  const dmCall = criarDmCall({
    transport: dm.transport,
    identity: () => identity,
    dataKey: Buffer.alloc(32, 9),
    peerKeyOf: (id) => dm.dm.conversa(id)?.peer_key ?? null,
    midia: () => null,
    onEvent: (topic, data) => {
      eventos.push({ topic, data: { ...data } });
      fanout.emit(
        { topic, data },
        typeof data['conversationId'] === 'string' ? { conversationId: data['conversationId'] } : {},
      );
    },
  });
  dm.transport.definirOuvinteDeChamada((a) => dmCall.aoMudarChamadaDoPar(a));

  registerDmCommands(ipc, {
    open: (peerKey) => dm.dm.abrir(peerKey),
    accept: (id) => dm.dm.aceitar(id),
    block: (id) => dm.dm.bloquear(id),
    unblock: (id) => dm.dm.desbloquear(id),
    forget: (id) => dm.dm.esquecer(id),
    sendMessage: (a) =>
      dm.escrever(a.conversationId, 'dm.message', {
        content: a.content,
        ...(a.attachment !== undefined ? { attachment: a.attachment } : {}),
        ...(a.replyToId !== undefined ? { replyToId: a.replyToId } : {}),
      }),
    editMessage: (a) => dm.escrever(a.conversationId, 'dm.edit', { messageId: a.messageId, content: a.content }),
    deleteMessage: (a) => dm.escrever(a.conversationId, 'dm.delete', { messageId: a.messageId }),
    react: (a) =>
      dm.escrever(a.conversationId, 'dm.react', { messageId: a.messageId, emoji: a.emoji, present: a.present }),
    setProfile: (a) =>
      dm.escrever(a.conversationId, 'dm.profile', {
        ...(a.displayName !== undefined ? { displayName: a.displayName } : {}),
        ...(a.avatarColor !== undefined ? { avatarColor: a.avatarColor } : {}),
      }),
    markRead: (id) => dm.markRead(id),
    activate: (id) => dm.activate(id),
    setTyping: (id, on) => dm.transport.setTyping(id, on),
    setContactPolicy: (p) => dm.dm.setContactPolicy(p),
    callJoin: (id) => dmCall.join(id),
    callLeave: (id) => dmCall.leave(id),
    callSignal: (a) => dmCall.signal(a.conversationId, a),
    queries: dm.queries,
  });

  const pendentes = new Map<number, (r: Resposta) => void>();
  let proximoId = 0;
  rendererSide.onMessage((raw) => {
    const frame = raw as Record<string, unknown>;
    if (frame['t'] !== 'res') return;
    const resolver = pendentes.get(frame['id'] as number);
    if (resolver === undefined) return;
    pendentes.delete(frame['id'] as number);
    const erro = frame['err'] as { code?: string; message?: string } | undefined;
    resolver({
      ok: frame['ok'] as boolean,
      data: frame['data'],
      code: erro?.code ?? null,
      ...(erro?.message !== undefined ? { message: erro.message } : {}),
    });
  });

  return {
    rotulo,
    identity,
    manifest,
    view,
    backend,
    dm,
    eventos,
    request(cmd, arg) {
      const id = ++proximoId;
      return new Promise<Resposta>((resolve) => {
        pendentes.set(id, resolve);
        rendererSide.postMessage({ t: 'req', epoch: 1, id, cmd, arg: arg ?? {}, authToken: 'ok' });
      });
    },
    async close() {
      dmCall.close();
      await dm.close();
      view.close();
    },
  };
}

function idEntre(a: No, b: No): string {
  const k = dmConversationKey(a.identity.publicKey, b.identity.publicKey);
  assert.notEqual(k, null);
  return (k as Buffer).toString('hex');
}

/**
 * Uma conexão entre os dois nós, com **Noise de verdade**: a `remotePublicKey` é a que o
 * handshake autenticou (§31.8 camada 1), não uma declarada pelo cabo. É também o que o
 * `hypercore` exige para replicar de fato — ele espera `stream.opened` ao anexar-se ao mux.
 */
async function conectar(a: No, b: No): Promise<void> {
  const [sa, sb] = parDeStreamsNoise(a.identity, b.identity);
  // A `remotePublicKey` só existe depois do handshake: é ele que a autentica.
  await Promise.all([sa.opened, sb.opened]);
  const conn = (stream: { remotePublicKey: Buffer }): SwarmConnection =>
    ({
      remotePublicKeyHex: stream.remotePublicKey.toString('hex'),
      stream: stream as unknown as SwarmConnection['stream'],
      topicsHex: [],
      close: () => {},
    }) as SwarmConnection;
  a.backend.entregar(conn(sa));
  b.backend.entregar(conn(sb));
}

async function ate(cond: () => boolean, msg: string, limiteMs = 5_000): Promise<void> {
  const fim = Date.now() + limiteMs;
  while (Date.now() < fim) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`${msg} (esperou ${limiteMs} ms)`);
}

function ok(r: Resposta): Record<string, unknown> {
  assert.equal(r.ok, true, `esperava sucesso, veio ${r.code}: ${r.message ?? ''}`);
  return r.data as Record<string, unknown>;
}

// ─── §31.10 — a terceira classe de escrita ─────────────────────────────────────────────

describe('§31.16.1/§31.10 — `dm.send` responde síncrono, com o registro já no log', () => {
  it('a conversa nasce, é aceita, e o `ordSum` respondido é o que os dois lados projetam', async () => {
    const a = await no('alice');
    const b = await no('bob');
    const id = idEntre(a, b);

    // `dm.open` — derivado, nunca atribuído (§31.2 regra 1).
    const aberta = ok(await a.request('dm.open', { peerKey: b.identity.publicKey.toString('hex') }));
    assert.equal(aberta['conversationId'], id);
    assert.equal(aberta['state'], 'pending-out');

    a.dm.transport.refresh();
    b.dm.transport.refresh();
    await conectar(a, b);
    await ate(() => b.manifest.getDmConversation(id) !== null, 'o pedido não chegou');

    ok(await b.request('dm.accept', { conversationId: id }));
    b.dm.transport.refresh();
    await conectar(a, b);
    await ate(() => a.manifest.getDmConversation(id)?.peer_core_key !== null, '`alice` não vinculou o core');

    // §31.10 — resposta **síncrona**, com o registro já no log. `state` é literal.
    const enviada = ok(
      await a.request('dm.send', { conversationId: id, content: 'oi', clientRef: 'ref-1' }),
    );
    assert.equal(enviada['state'], 'written');
    assert.equal(enviada['clientRef'], 'ref-1');
    assert.equal(typeof enviada['messageId'], 'string');
    assert.ok(String(enviada['messageId']).startsWith('dmsg-'), '§31.4 — o prefixo é do domínio de DM');
    assert.equal(typeof enviada['ordSum'], 'number');

    // Nada de outbox: a resposta **não** carrega `opId` nem `state:'queued'` (§31.10).
    assert.equal(enviada['opId'], undefined);

    // A projeção do PRÓPRIO lado materializa o mesmo `ordSum` que a resposta prometeu.
    await ate(
      () => (a.view.prepare('SELECT COUNT(*) AS n FROM dm_messages WHERE conversation_id = ?').get(id) as { n: number }).n > 0,
      'a projeção local não chegou',
    );
    const minha = ok(await a.request('query.dmMessages', { conversationId: id }));
    const lista = minha['messages'] as Array<Record<string, unknown>>;
    const msg = lista.find((m) => m['id'] === enviada['messageId']);
    assert.notEqual(msg, undefined, 'a mensagem respondida não apareceu na projeção');
    assert.equal(msg?.['ordSum'], enviada['ordSum'], '§31.6 — o `ordSum` respondido é o projetado');
    assert.equal(msg?.['content'], 'oi');
    // §31.11 — `delivery` só existe nas **próprias**; `written` até o `ack` do par avançar.
    assert.equal(msg?.['delivery'], 'written');

    await a.close();
    await b.close();
  });

  it('escrever numa conversa que não existe é `E_NOT_FOUND`; antes do aceite, `E_DM_NOT_AUTHORIZED`', async () => {
    const a = await no('alice');
    const b = await no('bob');
    const id = idEntre(a, b);

    assert.equal((await a.request('dm.send', { conversationId: id, content: 'x' })).code, 'E_NOT_FOUND');

    ok(await a.request('dm.open', { peerKey: b.identity.publicKey.toString('hex') }));
    a.dm.transport.refresh();
    await conectar(a, b);
    await ate(() => b.manifest.getDmConversation(id) !== null, 'o pedido não chegou');

    // §31.9 regra 1 — antes do aceite não existe o meu core, logo não existe onde appendar.
    assert.equal(
      (await b.request('dm.send', { conversationId: id, content: 'x' })).code,
      'E_DM_NOT_AUTHORIZED',
    );
    await a.close();
    await b.close();
  });

  /**
   * RD-3 é uma invariante de **corrida**, não de caminho feliz: o `authorSeq` sai de
   * `core.length`, e sem serialização por conversa dois `dm.send` em voo leem o mesmo
   * comprimento, assinam o mesmo número e produzem o mesmo `dmsg-`. O segundo registro
   * quebra o estágio 5 de §31.7.3, marca o lado `invalid` — e o estágio 7 torna a marca
   * absorvente: a conversa nunca mais aceita escrita própria. O teste é o de N em voo.
   */
  it('N escritas em voo na mesma conversa saem com `authorSeq` distintos e o lado não fica `invalid`', async () => {
    const a = await no('alice');
    const b = await no('bob');
    const id = idEntre(a, b);

    ok(await a.request('dm.open', { peerKey: b.identity.publicKey.toString('hex') }));
    a.dm.transport.refresh();
    b.dm.transport.refresh();
    await conectar(a, b);
    await ate(() => b.manifest.getDmConversation(id) !== null, 'o pedido não chegou');
    ok(await b.request('dm.accept', { conversationId: id }));
    b.dm.transport.refresh();
    await conectar(a, b);
    await ate(() => a.manifest.getDmConversation(id)?.peer_core_key !== null, '`alice` não vinculou o core');

    const N = 8;
    const respostas = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        a.request('dm.send', { conversationId: id, content: `m${i}` }),
      ),
    );
    for (const r of respostas) ok(r);
    const ids = new Set(respostas.map((r) => String((r.data as Record<string, unknown>)['messageId'])));
    assert.equal(ids.size, N, '§31.4 — cada mensagem tem id próprio; id repetido é `authorSeq` repetido');

    // E a projeção materializa as N: um `authorSeq` repetido teria virado `REJECTED` no
    // estágio 5, e o lado `invalid` engoliria todas as seguintes.
    await ate(
      () =>
        (a.view.prepare('SELECT COUNT(*) AS n FROM dm_messages WHERE conversation_id = ?').get(id) as { n: number })
          .n === N,
      'a projeção não materializou as N escritas',
    );
    const rejeitadas = a.view
      .prepare('SELECT COUNT(*) AS n FROM dm_rejected_records WHERE conversation_id = ?')
      .get(id) as { n: number };
    assert.equal(rejeitadas.n, 0, '§31.7.3 estágio 5 — nenhuma escrita própria pode ser recusada');

    await a.close();
    await b.close();
  });

  /**
   * §31.9 — `pending-out` quer dizer "o outro ainda não aceitou". Quando o par aceita, o core
   * dele passa a existir (regra 1) e o `dm.hello` dele chega: o estado local de quem abriu
   * **tem** de sair de `pending-out`. Ele nunca é replicado, então não havia correção
   * posterior — a UI ficava com o aviso de pedido pendente para sempre, numa conversa viva.
   */
  it('quem abriu sai de `pending-out` quando o par aceita e o hello dele chega', async () => {
    const a = await no('alice');
    const b = await no('bob');
    const id = idEntre(a, b);

    ok(await a.request('dm.open', { peerKey: b.identity.publicKey.toString('hex') }));
    a.dm.transport.refresh();
    b.dm.transport.refresh();
    await conectar(a, b);
    await ate(() => b.manifest.getDmConversation(id) !== null, 'o pedido não chegou');
    assert.equal(a.manifest.getDmConversation(id)?.state, 'pending-out');

    ok(await b.request('dm.accept', { conversationId: id }));
    b.dm.transport.refresh();
    await conectar(a, b);
    await ate(() => a.manifest.getDmConversation(id)?.state === 'accepted', '`alice` ficou em `pending-out`');
    assert.notEqual(a.manifest.getDmConversation(id)?.accepted_at, null);
    // E a query diz o mesmo — é ela que a UI lê para decidir se mostra "aguardando aceite".
    assert.equal(ok(await a.request('query.dmConversation', { conversationId: id }))['state'], 'accepted');

    await a.close();
    await b.close();
  });

  it('conversa consigo mesmo é `E_VALIDATION`, não um código novo (§31.17)', async () => {
    const a = await no('alice');
    const r = await a.request('dm.open', { peerKey: a.identity.publicKey.toString('hex') });
    assert.equal(r.code, 'E_VALIDATION');
    await a.close();
  });
});

// ─── §31.16.3 — as queries e o cursor ──────────────────────────────────────────────────

describe('§31.16.3 — as cinco queries e o cursor por `(ordSum, authorKey, id)`', () => {
  it('o cursor leva os três campos, e um de outra forma é `E_BAD_CURSOR`', () => {
    const c = { ordSum: 7, authorKey: 'ab'.repeat(32), id: 'dmsg-XYZ' };
    assert.deepEqual(decodeDmCursor(encodeDmCursor(c)), c);

    // `ordSum` sozinho empata (§31.6 desempata pela chave do autor): os três são exigidos.
    for (const ruim of [
      { ordSum: 1, authorKey: 'ab'.repeat(32) },
      { ordSum: 1, id: 'x' },
      { authorKey: 'ab'.repeat(32), id: 'x' },
      { ordSum: 1.5, authorKey: 'ab'.repeat(32), id: 'x' },
      { ordSum: 1, authorKey: 'NAO-HEX', id: 'x' },
    ]) {
      assert.throws(
        () => decodeDmCursor(Buffer.from(JSON.stringify(ruim), 'utf8').toString('base64url')),
        (e: { code?: string }) => e.code === 'E_BAD_CURSOR',
        JSON.stringify(ruim),
      );
    }
    // Bytes que não são cursor nenhum: `E_BAD_CURSOR`, nunca resultado errado em silêncio.
    assert.throws(() => decodeDmCursor('nao-e-cursor'), (e: { code?: string }) => e.code === 'E_BAD_CURSOR');
  });

  it('pagina em ordem canônica crescente nas duas direções, e `hasMore` é honesto', async () => {
    const a = await no('alice');
    const b = await no('bob');
    const id = idEntre(a, b);
    ok(await a.request('dm.open', { peerKey: b.identity.publicKey.toString('hex') }));
    a.dm.transport.refresh();

    for (let i = 0; i < 5; i++) ok(await a.request('dm.send', { conversationId: id, content: `m${i}` }));
    await ate(
      () => (a.view.prepare('SELECT COUNT(*) AS n FROM dm_messages WHERE conversation_id = ?').get(id) as { n: number }).n === 5,
      'as cinco não projetaram',
    );

    const p1 = ok(await a.request('query.dmMessages', { conversationId: id, limit: 2 }));
    const l1 = p1['messages'] as Array<Record<string, unknown>>;
    assert.equal(l1.length, 2);
    assert.equal(p1['hasMore'], true);
    // §23.2 — a saída é **sempre** crescente, independente da direção. A UI não inverte nada.
    assert.ok((l1[0]?.['ordSum'] as number) < (l1[1]?.['ordSum'] as number));
    assert.equal(l1[1]?.['content'], 'm4', '`before` sem cursor é a página mais recente');

    const p2 = ok(await a.request('query.dmMessages', { conversationId: id, limit: 2, cursor: p1['nextCursor'] }));
    const l2 = p2['messages'] as Array<Record<string, unknown>>;
    assert.deepEqual(l2.map((m) => m['content']), ['m1', 'm2']);

    // `after` a partir do começo caminha para a frente.
    const doInicio = ok(await a.request('query.dmMessages', { conversationId: id, limit: 2, direction: 'after' }));
    assert.deepEqual((doInicio['messages'] as Array<Record<string, unknown>>).map((m) => m['content']), ['m0', 'm1']);

    // Cursor de outra forma → `E_BAD_CURSOR` na fronteira, não resultado vazio.
    assert.equal((await a.request('query.dmMessages', { conversationId: id, cursor: 'lixo' })).code, 'E_BAD_CURSOR');
    // `direction` fora das duas é `E_VALIDATION`.
    assert.equal(
      (await a.request('query.dmMessages', { conversationId: id, direction: 'lateral' })).code,
      'E_VALIDATION',
    );

    await a.close();
    await b.close();
  });

  it('`query.dmConversation` e `query.dmConversations` trazem o estado, o par e o não-lido', async () => {
    const a = await no('alice');
    const b = await no('bob');
    const id = idEntre(a, b);
    ok(await a.request('dm.open', { peerKey: b.identity.publicKey.toString('hex') }));

    const uma = ok(await a.request('query.dmConversation', { conversationId: id }));
    assert.equal(uma['state'], 'pending-out');
    const par = uma['peer'] as Record<string, unknown>;
    assert.equal(par['key'], b.identity.publicKey.toString('hex'));
    // §31.16.3 — **sem `collision`**: numa conversa de dois não há conjunto em que colidir.
    assert.equal(par['collision'], undefined);
    // O `handle` é derivado da chave (§6.1) e é sempre exibido junto do nome (**L-5**).
    assert.equal(typeof par['handle'], 'string');
    assert.ok(String(par['handle']).length > 0);

    const lista = ok(await a.request('query.dmConversations'));
    assert.equal((lista['conversations'] as unknown[]).length, 1);

    assert.equal((await a.request('query.dmConversation', { conversationId: '0'.repeat(64) })).code, 'E_NOT_FOUND');
    await a.close();
    await b.close();
  });

  it('`query.dmPrefs` e `dm.setContactPolicy` são a política local de §31.9 regra 5', async () => {
    const a = await no('alice');
    assert.deepEqual(ok(await a.request('query.dmPrefs')), { contactPolicy: 'anyone' });
    ok(await a.request('dm.setContactPolicy', { policy: 'shared-community' }));
    assert.deepEqual(ok(await a.request('query.dmPrefs')), { contactPolicy: 'shared-community' });
    assert.equal((await a.request('dm.setContactPolicy', { policy: 'ninguem' })).code, 'E_VALIDATION');
    await a.close();
  });
});

// ─── §31.16.2 — os eventos ─────────────────────────────────────────────────────────────

describe('§31.16.2 — os eventos, e o não-lido que é query e não acumulador', () => {
  it('`dm.appended` e `dm.unreadChanged` saem depois do commit, e `dm.markRead` zera', async () => {
    const a = await no('alice');
    const b = await no('bob');
    const id = idEntre(a, b);
    ok(await a.request('dm.open', { peerKey: b.identity.publicKey.toString('hex') }));
    a.dm.transport.refresh();
    await conectar(a, b);
    await ate(() => b.manifest.getDmConversation(id) !== null, 'sem pedido');
    ok(await b.request('dm.accept', { conversationId: id }));
    b.dm.transport.refresh();
    await conectar(a, b);
    await ate(() => a.manifest.getDmConversation(id)?.peer_core_key !== null, 'sem vínculo');

    ok(await a.request('dm.send', { conversationId: id, content: 'oi' }));
    await ate(() => b.eventos.some((e) => e.topic === 'dm.appended'), '`bob` não recebeu `dm.appended`');

    // A28 — a contagem é uma **query** sobre `ordKey > lastRead`, nunca um acumulador. Por
    // isso ela não conta duas vezes e a reprojeção a recomputa do zero.
    await ate(() => {
      const c = ok2(b, id);
      return (c['unread'] as { count: number }).count === 1;
    }, '`bob` não contou a não-lida');

    assert.deepEqual(ok(await b.request('dm.markRead', { conversationId: id })), { unreadCount: 0 });
    assert.equal((ok2(b, id)['unread'] as { count: number }).count, 0);
    assert.ok(b.eventos.some((e) => e.topic === 'dm.unreadChanged' && e.data['unreadCount'] === 0));

    // A minha própria mensagem nunca é não-lida para mim.
    assert.equal((ok2(a, id)['unread'] as { count: number }).count, 0);

    await a.close();
    await b.close();
  });

  it('§31.16.3 — a marca de leitura sai nas queries, e é ela que dá o ONDE do divisor', async () => {
    // O selo dizia **quantas** e nada dizia **onde**: o watermark de `dm_local_read_state`
    // não saía do núcleo, e U-33 pede o divisor de "Novas mensagens" na conversa. Emenda de
    // 2026-09-05 em §31.16.3 — os dois eixos do `ordKey` de §31.6, porque `naoLidas`
    // desempata pela chave do autor e um corte só por `ordSum` discordaria do selo.
    const a = await no('alice');
    const b = await no('bob');
    const id = idEntre(a, b);
    try {
      ok(await a.request('dm.open', { peerKey: b.identity.publicKey.toString('hex') }));
      ok(await a.request('dm.send', { conversationId: id, content: 'oi' }));
      await ate(
        () => (a.view.prepare('SELECT COUNT(*) AS n FROM dm_messages WHERE conversation_id = ?').get(id) as { n: number }).n > 0,
        'não projetou',
      );

      // Nunca marcada: `-1` é "tudo é novo" na ordem canônica, que começa em 0.
      // `recomputarNaoLidas` já gravou a linha com o sentinela de §31.12 (`-1` e a chave
      // zerada): nada foi lido, e é isso que o corte diz.
      const antes = a.dm.queries.messages({ conversationId: id }) as unknown as Record<string, unknown>;
      assert.equal(antes['lastReadOrdSum'], -1);

      ok(await a.request('dm.markRead', { conversationId: id }));

      const depois = a.dm.queries.messages({ conversationId: id }) as unknown as Record<string, unknown>;
      const topo = a.view
        .prepare('SELECT ord_sum, author_key FROM dm_messages WHERE conversation_id = ? ORDER BY ord_sum DESC, author_key DESC LIMIT 1')
        .get(id) as { ord_sum: number; author_key: Buffer };
      assert.equal(depois['lastReadOrdSum'], topo.ord_sum);
      assert.equal(depois['lastReadAuthorKey'], topo.author_key.toString('hex'));

      // A mesma marca no detalhe: a página e o detalhe não podem discordar do corte.
      const detalhe = a.dm.queries.conversation({ conversationId: id }) as unknown as Record<string, unknown>;
      assert.equal(detalhe['lastReadOrdSum'], topo.ord_sum);
      assert.equal(detalhe['lastReadAuthorKey'], topo.author_key.toString('hex'));
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('`dm.activate` decide residência e é `E_NOT_FOUND` para conversa que não existe', async () => {
    const a = await no('alice');
    const b = await no('bob');
    const id = idEntre(a, b);
    ok(await a.request('dm.open', { peerKey: b.identity.publicKey.toString('hex') }));
    assert.deepEqual(ok(await a.request('dm.activate', { conversationId: id })), { residency: 'active' });
    assert.deepEqual(ok(await a.request('dm.activate', { conversationId: null })), { residency: 'background' });
    assert.equal((await a.request('dm.activate', { conversationId: '0'.repeat(64) })).code, 'E_NOT_FOUND');
    await a.close();
    await b.close();
  });
});

/** Atalho: a conversa de um nó, já desembrulhada. */
function ok2(n: No, id: string): Record<string, unknown> {
  return n.dm.queries.conversations().find((c) => c.conversationId === id) as unknown as Record<string, unknown>;
}

// ─── §31.19 — `dm.forget` pela fronteira ───────────────────────────────────────────────

describe('§31.16.1/§31.19 — `dm.forget` é main-confirmed e a linha sobrevive', () => {
  it('apaga a projeção e mantém `dm_conversations` reduzida a `left` (L-25)', async () => {
    const a = await no('alice');
    const b = await no('bob');
    const id = idEntre(a, b);
    ok(await a.request('dm.open', { peerKey: b.identity.publicKey.toString('hex') }));
    ok(await a.request('dm.send', { conversationId: id, content: 'oi' }));
    await ate(
      () => (a.view.prepare('SELECT COUNT(*) AS n FROM dm_messages WHERE conversation_id = ?').get(id) as { n: number }).n > 0,
      'não projetou',
    );

    ok(await a.request('dm.forget', { conversationId: id }));

    assert.equal(
      (a.view.prepare('SELECT COUNT(*) AS n FROM dm_messages WHERE conversation_id = ?').get(id) as { n: number }).n,
      0,
      'a projeção saiu',
    );
    const row = a.manifest.getDmConversation(id);
    assert.notEqual(row, null, 'a linha sobrevive para sempre (§31.19 regra 2)');
    assert.equal(row?.state, 'left');
    assert.ok((row?.self_high_water ?? 0) > 0, '`core.length` precisa sobreviver, senão forka');

    await a.close();
    await b.close();
  });
});

// ─── §31.15 — mídia numa conversa direta, sobre o cabo de verdade (B62 / §109) ─────────

describe('§31.15 — SDP e ICE viajam pelo próprio `p2p-dm/1`, sem host e sem ticket', () => {
  it('a sinalização atravessa, e o núcleo do outro lado a entrega sem interpretar', async () => {
    const a = await no('alice');
    const b = await no('bob');
    const id = idEntre(a, b);
    try {
      ok(await a.request('dm.open', { peerKey: b.identity.publicKey.toString('hex') }));
      a.dm.transport.refresh();
      b.dm.transport.refresh();
      await conectar(a, b);
      await ate(() => b.manifest.getDmConversation(id) !== null, 'o pedido não chegou');
      ok(await b.request('dm.accept', { conversationId: id }));
      b.dm.transport.refresh();
      await conectar(a, b);
      await ate(() => a.manifest.getDmConversation(id)?.peer_core_key !== null, '`alice` não vinculou o core');

      // §31.15 — não há `voice.join` no host a pedir: o escopo é a conversa, e a resposta
      // não tem roster nem ticket. `peerOnCall` nasce falso: `bob` ainda não atendeu.
      const entrou = ok(await a.request('dm.callJoin', { conversationId: id }));
      assert.equal(entrou['sessionId'], id);
      assert.equal(entrou['peerKey'], b.identity.publicKey.toString('hex'));
      assert.equal(entrou['peerOnCall'], false);

      // `bob` soube que `alice` está na chamada — sem roster, e sem host que o difundisse.
      await ate(
        () => b.eventos.some((e) => e.topic === 'dm.callState' && e.data['on'] === true),
        '`bob` não soube da chamada de `alice`',
      );
      const estado = b.eventos.find((e) => e.topic === 'dm.callState');
      assert.equal(estado?.data['conversationId'], id);
      assert.equal(estado?.data['peerKey'], a.identity.publicKey.toString('hex'));

      ok(await b.request('dm.callJoin', { conversationId: id }));
      // O reanúncio de quem já estava dentro: `alice` descobre que `bob` entrou.
      await ate(
        () => a.eventos.some((e) => e.topic === 'dm.callState' && e.data['on'] === true),
        '`alice` não soube que `bob` entrou',
      );

      // A sinalização. O SDP atravessa **opaco**: o núcleo não o lê, e o que chega do outro
      // lado é byte a byte o que saiu daqui (§17.2 — a mídia é DTLS-SRTP ponta a ponta).
      const sdp = 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n';
      ok(await a.request('dm.signal', { conversationId: id, sdp }));
      await ate(() => b.eventos.some((e) => e.topic === 'dm.signal'), 'o SDP não chegou a `bob`');
      const recebido = b.eventos.find((e) => e.topic === 'dm.signal');
      assert.equal(recebido?.data['sdp'], sdp);
      // §16.3 regra 4, na forma que sobra sem host: a origem é a chave da CONEXÃO. Aqui ela
      // nem sequer é fabricável — não há campo de origem no quadro, e o Noise já a fixou.
      assert.equal(recebido?.data['peerKey'], a.identity.publicKey.toString('hex'));
      assert.equal('ticketId' in (recebido?.data ?? {}), false, 'Ticket de mídia: NÃO REUTILIZADO (§31.15)');

      // Sair: o outro lado sabe, e sabe por notificação efêmera, não por roster.
      ok(await b.request('dm.callLeave', { conversationId: id }));
      await ate(
        () => a.eventos.some((e) => e.topic === 'dm.callState' && e.data['on'] === false),
        '`alice` não soube que `bob` saiu',
      );
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('sem canal `p2p-dm/1` de pé, `dm.signal` é `E_PEER_UNREACHABLE` — não há fila e não há host a culpar', async () => {
    const a = await no('alice');
    const b = await no('bob');
    const id = idEntre(a, b);
    try {
      ok(await a.request('dm.open', { peerKey: b.identity.publicKey.toString('hex') }));
      ok(await a.request('dm.callJoin', { conversationId: id }));
      const r = await a.request('dm.signal', { conversationId: id, ice: '{}' });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'E_PEER_UNREACHABLE');
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('§31.15 — bloquear encerra a chamada: o escopo do TURN não sobrevive ao bloqueio', async () => {
    // Sem isto, `dm.block` fechava o canal `p2p-dm/1` e deixava tudo o mais de pé: o escopo
    // registrado no `MediaServer` e a credencial que EU emiti ainda válidos, ou seja, o meu
    // TURN continuaria encaminhando a mídia de quem eu acabei de bloquear. §31.15 diz que a
    // revogação de §17.4 acontece "pela única via que sobrou aqui: sair encerra" — então
    // bloquear tem de sair. `E_SESSION_GONE` é a prova de que saiu.
    const a = await no('alice');
    const b = await no('bob');
    const id = idEntre(a, b);
    try {
      ok(await a.request('dm.open', { peerKey: b.identity.publicKey.toString('hex') }));
      ok(await a.request('dm.callJoin', { conversationId: id }));
      ok(await a.request('dm.block', { conversationId: id }));

      const r = await a.request('dm.signal', { conversationId: id, ice: '{}' });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'E_SESSION_GONE', `veio ${r.code}`);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('§31.15 — esquecer encerra a chamada pela mesma razão, e antes de a conversa sumir', async () => {
    const a = await no('alice');
    const b = await no('bob');
    const id = idEntre(a, b);
    try {
      ok(await a.request('dm.open', { peerKey: b.identity.publicKey.toString('hex') }));
      ok(await a.request('dm.callJoin', { conversationId: id }));
      ok(await a.request('dm.forget', { conversationId: id }));

      const r = await a.request('dm.signal', { conversationId: id, ice: '{}' });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'E_SESSION_GONE', `veio ${r.code}`);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('`dm.signal` sem `sdp` nem `ice` é `E_VALIDATION`: um quadro vazio não é sinalização', async () => {
    const a = await no('alice');
    const b = await no('bob');
    const id = idEntre(a, b);
    try {
      ok(await a.request('dm.open', { peerKey: b.identity.publicKey.toString('hex') }));
      ok(await a.request('dm.callJoin', { conversationId: id }));
      const r = await a.request('dm.signal', { conversationId: id });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'E_VALIDATION');
    } finally {
      await a.close();
      await b.close();
    }
  });
});
