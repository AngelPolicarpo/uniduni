// `corestore` — L0. Ciclo de vida dos cores (§4).
//
// O contrato completo deste módulo — *"namespaces determinísticos"* (§5.3), integração com
// `manifest`, blobs — depende de `manifest` (L0) e de seções que a fase 2 ainda não abre
// (G2 fecha reprojeção+participação+chaves). A fase 2 entregou a **leitura**; a fase 3
// acrescenta a porta de append usada pelo `communityHost`, sem mover a decisão para L0.
//
// Nenhuma decisão sobre **o que** appendar mora aqui (§4, "Não pode: decidir o que
// appendar"). A escrita é exposta apenas como uma porta para `communityHost`; a decisão
// continua em L2.

import Hypercore from 'hypercore';
import sodium from 'sodium-native';

export type CoreHandle = {
  /** Chave pública do core — o `communityId` em hex (§6.2). */
  readonly key: Buffer;
  /**
   * §14.1 — o tópico DHT do log é `discoveryKey(coreKey)`. Opcional porque um `CoreHandle`
   * pode vir de memória (teste, réplica sintética): sem ele não há o que anunciar na DHT, e
   * quem transporta recusa por falta de tópico em vez de inventar um.
   */
  readonly discoveryKey?: Buffer;
  readonly length: number;
  /** Bloco `seq`; `null` quando ainda não disponível (replicação em curso, §10.5). */
  get(seq: number): Promise<Uint8Array | null>;
  /** §10.5 passo 6 — reage a `append`. Devolve o desregistro. */
  onAppend(listener: () => void): () => void;
  /**
   * §14.1 — entra na replicação sobre um `Protomux` já montado no stream do Hyperswarm.
   * Opcional pela mesma razão que `discoveryKey`. O argumento é opaco de propósito: L0 não
   * declara o transporte, e quem monta o grafo passa o mux (§4).
   */
  replicate?(mux: unknown): void;
  /**
   * §14.2 — pede a faixa inteira do log em background. O hypercore é esparso: replicar o
   * canal não baixa bloco nenhum, e o projector pararia no primeiro buraco (§10.5 passo 6)
   * esperando um `append` que nunca viria. Opcional pelo mesmo motivo que `replicate`.
   */
  download?(): void;
  /**
   * §13.4 — pede uma faixa de blocos e resolve quando ela chega (replicação real). É a
   * forma que o download de anexos usa sobre o core de blobs do autor. Opcional como as
   * demais: cabo de memória (teste) não tem o que pedir.
   */
  downloadRange?(startBlock: number, endBlock: number): Promise<void>;
  /**
   * §13.4 passo 4 — bitfield local e bitfield remoto por par, na faixa **inclusiva**. É o
   * que separa `blob.progress`/`blob.peerLost` de estimativa: "quantos blocos tenho" e
   * "quem anuncia ter a faixa". Opcional pelo mesmo motivo que `replicate`.
   */
  rangeStatus?(startBlock: number, endBlock: number): Promise<{ blocksHave: number; peers: string[] }>;
  /**
   * §18.7 passo 2 — quantos pares replicando este core têm o log **contíguo** até `head`.
   * Opcional pelo mesmo motivo das demais: cabo de memória (teste) não tem par nenhum, e a
   * barreira degrada para o orçamento, que é o desfecho que a spec já prevê.
   */
  replicationConfirmations?(head: number): number;
  /**
   * O maior comprimento contíguo replicado por pares (ou guardado no cabeçalho do core).
   * Em DM (§31.11), atesta até onde o par já replicou o meu log de forma contígua.
   */
  remoteContiguousLength?(): number;
  /**
   * Notifica quando o progresso de replicação avançar (ex: novo bloco contíguo anunciado pelo par ou upload).
   * Devolve o desregistro.
   */
  onReplicationProgress?(listener: () => void): () => void;
  /**
   * §13.5/§22.4 — libera os blocos LOCAIS da faixa **inclusiva** (`core.clear`). O dado
   * continua na rede para quem o tiver; aqui só o disco deste nó sai. Opcional como as
   * demais: cabo de memória (teste) não tem bitfield para podar.
   */
  clear?(startBlock: number, endBlock: number): Promise<void>;
  close(): Promise<void>;
};

export type WritableCoreHandle = CoreHandle & {
  /** §11.5 — um append recebe o grupo inteiro; a resolução é a barreira (§10.7.1). */
  append(blocks: readonly Uint8Array[]): Promise<void>;
};

class CoreHandleImpl implements WritableCoreHandle {
  readonly #core: Hypercore;

  constructor(core: Hypercore) {
    this.#core = core;
  }

  get key(): Buffer {
    const k = this.#core.key;
    if (k === null) throw new Error('core sem chave — não deveria estar pronto');
    return Buffer.from(k);
  }

  get discoveryKey(): Buffer {
    const d = this.#core.discoveryKey;
    if (d === null) throw new Error('core sem discoveryKey — não deveria estar pronto');
    return Buffer.from(d);
  }

  replicate(mux: unknown): void {
    this.#core.replicate(mux);
  }

  download(): void {
    this.#core.download({ start: 0, end: -1, linear: true });
  }

  async downloadRange(startBlock: number, endBlock: number): Promise<void> {
    // Contrato da porta é INCLUSIVO nos dois extremos (§13.4); a faixa do hypercore é
    // meio-aberta (`toLength = end − start`): pedir `end` tal qual deixaria o último bloco
    // de fora — e `done()` resolveria sem ele.
    const req = this.#core.download({ start: startBlock, end: endBlock + 1 });
    await req.done();
  }

  get length(): number {
    return this.#core.length;
  }

  async get(seq: number): Promise<Uint8Array | null> {
    return this.#core.get(seq, { wait: false });
  }

  /**
   * §18.7 passo 2 — quantos PARES têm o log contíguo até a cabeça. A barreira de saída do
   * host espera por isto, e não por sinal local nenhum: "a op está no meu disco" e "a op
   * sobreviveu a esta máquina desligar" são afirmações diferentes.
   *
   * Não é sinal novo no fio. O `replicator` do hypercore já mantém, por par, o bitfield do
   * que ele anunciou ter; `remoteContiguousLength` é a leitura desse bitfield. Perguntar de
   * novo por RPC seria duplicar o que o protocolo de replicação já diz.
   */
  replicationConfirmations(head: number): number {
    let n = 0;
    for (const peer of this.#core.peers) {
      if (peer.remotePublicKey === null) continue;
      if (peer.remoteContiguousLength >= head) n++;
    }
    return n;
  }

  remoteContiguousLength(): number {
    let max = this.#core.remoteContiguousLength;
    for (const peer of this.#core.peers) {
      if (peer.remotePublicKey === null) continue;
      if (peer.remoteContiguousLength > max) max = peer.remoteContiguousLength;
    }
    return max;
  }

  onReplicationProgress(listener: () => void): () => void {
    const onRcl = () => listener();
    const onUpload = () => listener();
    this.#core.on('remote-contiguous-length', onRcl);
    this.#core.on('upload', onUpload);
    return () => {
      this.#core.off('remote-contiguous-length', onRcl);
      this.#core.off('upload', onUpload);
    };
  }

  /**
   * §13.4 passo 4 — quantos blocos da faixa **inclusiva** já estão locais e quais pares
   * anunciam ter a faixa inteira. Dado real: o bitfield local do core e o bitfield remoto
   * que o replicator mantém por par. A tradução da convenção (inclusiva aqui, meio-aberta
   * no vendor) é desta fronteira, como em `downloadRange`.
   */
  async rangeStatus(startBlock: number, endBlock: number): Promise<{ blocksHave: number; peers: string[] }> {
    let blocksHave = 0;
    for (let i = startBlock; i <= endBlock; i++) {
      if (await this.#core.has(i, i + 1)) blocksHave += 1;
    }
    const peers: string[] = [];
    for (const peer of this.#core.peers) {
      const chave = peer.remotePublicKey;
      if (chave === null) continue;
      let temTudo = true;
      for (let i = startBlock; i <= endBlock && temTudo; i++) temTudo = peer._remoteHasBlock(i);
      if (temTudo) peers.push(Buffer.from(chave).toString('hex'));
    }
    return { blocksHave, peers };
  }

  /** §13.5/§22.4 — `core.clear` do hypercore; a convenção inclusiva vira meio-aberta aqui. */
  async clear(startBlock: number, endBlock: number): Promise<void> {
    await this.#core.clear(startBlock, endBlock + 1);
  }

  /**
   * §10.5 passo 6. Para o **escritor**, `append` é o evento: o bloco existe e é legível no
   * mesmo instante. Para uma **réplica** as duas coisas se separam — `append` é o anúncio do
   * comprimento novo, e `download` é quando o bloco fica legível. O projector para no
   * primeiro buraco e espera um sinal (§10.5); se o sinal fosse só `append`, um log que
   * chega inteiro de uma vez ficaria projetado até o primeiro bloco ausente e nunca mais
   * seria retomado. Os dois eventos entram aqui, coalescidos numa microtask porque um lote
   * de replicação dispara `download` por bloco.
   */
  onAppend(listener: () => void): () => void {
    let agendado = false;
    const notificar = (): void => {
      if (agendado) return;
      agendado = true;
      queueMicrotask(() => {
        agendado = false;
        listener();
      });
    };
    this.#core.on('append', notificar);
    this.#core.on('download', notificar);
    return () => {
      this.#core.off('append', notificar);
      this.#core.off('download', notificar);
    };
  }

  async close(): Promise<void> {
    await this.#core.close();
  }

  async append(blocks: readonly Uint8Array[]): Promise<void> {
    // Hypercore aceita o lote em runtime; o vendor.d.ts mantém a assinatura escalar da API.
    await this.#core.append(blocks as unknown as Uint8Array);
  }
}

/**
 * Abre (ou cria) o core da comunidade em `storagePath` e devolve o cabo de leitura.
 *
 * `storagePath` é o diretório do core, não o diretório de dados: a derivação de caminho a
 * partir de `<userData>/p2p/cores/` (§10.1) e dos namespaces de §5.3 é parte do ciclo de
 * vida completo, que entra com `manifest` na fase 3.
 */
export async function openCore(storagePath: string, key?: Buffer): Promise<CoreHandle> {
  const core = new Hypercore(storagePath, key !== undefined ? { key } : undefined);
  await core.ready();
  return new CoreHandleImpl(core);
}

/** Cria um core novo com par de chaves determinado — o caso de teste e do host de gênese. */
export async function createCore(
  storagePath: string,
  keyPair: { publicKey: Buffer; secretKey: Buffer },
): Promise<WritableCoreHandle> {
  const core = new Hypercore(storagePath, { key: keyPair.publicKey, keyPair, compat: true });
  await core.ready();
  return new CoreHandleImpl(core);
}

/** Abre um core existente com a chave de escrita do host. */
export async function openWritableCore(
  storagePath: string,
  keyPair: { publicKey: Buffer; secretKey: Buffer },
): Promise<WritableCoreHandle> {
  const core = new Hypercore(storagePath, { key: keyPair.publicKey, keyPair, compat: true });
  await core.ready();
  return new CoreHandleImpl(core);
}

/**
 * §5.3 — namespaces determinísticos. As duas chaves de uma comunidade saem do
 * `communitySeed` por domínio separado, e é isso que torna a comunidade **recuperável**:
 * quem tem a semente (o host no `manifest`, o sucessor pelo escrow de §18.8) reconstrói o
 * par de escrita do log sem depender de estado local nenhum.
 *
 *   logKeyPair   = keyPairFromSeed(BLAKE2b('ns/log/1'   ‖ communitySeed))
 *   blobsKeyPair = keyPairFromSeed(BLAKE2b('ns/blobs/1' ‖ communitySeed))
 *
 * Derivar chave é ciclo de vida de core, não decisão de conteúdo: nada aqui decide o que
 * appendar (§4).
 */
export function deriveCommunityKeyPairs(communitySeed: Buffer): {
  readonly log: { readonly publicKey: Buffer; readonly secretKey: Buffer };
  readonly blobs: { readonly publicKey: Buffer; readonly secretKey: Buffer };
} {
  if (communitySeed.length !== 32) throw new Error('communitySeed deve ter 32 bytes');
  const derive = (domain: string) => {
    const seed = Buffer.allocUnsafe(sodium.crypto_sign_SEEDBYTES);
    sodium.crypto_generichash_batch(seed, [Buffer.from(domain, 'utf8'), communitySeed]);
    const publicKey = Buffer.alloc(sodium.crypto_sign_PUBLICKEYBYTES);
    const secretKey = Buffer.alloc(sodium.crypto_sign_SECRETKEYBYTES);
    sodium.crypto_sign_seed_keypair(publicKey, secretKey, seed);
    seed.fill(0);
    return { publicKey, secretKey };
  };
  return { log: derive('ns/log/1'), blobs: derive('ns/blobs/1') };
}

/**
 * §31.3 — o core de DM de **um** lado da conversa:
 *
 *   dmCoreSeed   = BLAKE2b-256('ns/dm/1' ‖ identitySeed ‖ conversationId)
 *   (dmPk, dmSk) = ed25519_keypair_from_seed(dmCoreSeed)
 *
 * Mora aqui pelo mesmo argumento de `deriveCommunityKeyPairs`: derivar chave é **ciclo de
 * vida de core**, não decisão de conteúdo (§4). E é o que faz valer a regra 1 de §31.3 —
 * quem restaura a identidade pelo backup de §5.5 recupera a própria metade de toda conversa,
 * sem que o backup carregue um campo novo.
 *
 * O par **não** deriva este core (§31.3 regra 2): ele aprende só a `publicKey`, pelo
 * handshake de §31.8, e a confere contra `dmCorePossessionHash`. Dois escritores no mesmo
 * core seriam fork (§18.9).
 *
 * `conversationId` entra como os **32 bytes** de §31.2, não como o hex64 do IPC — a mesma
 * convenção de `dmNonce` e `dmContentKey`.
 */
export function deriveDmCoreKeyPair(
  identitySeed: Buffer,
  conversationId: Buffer,
): { readonly publicKey: Buffer; readonly secretKey: Buffer; readonly seed: Buffer } {
  if (identitySeed.length !== sodium.crypto_sign_SEEDBYTES) {
    throw new Error('identitySeed deve ter 32 bytes');
  }
  if (conversationId.length !== 32) throw new Error('conversationId deve ter 32 bytes');
  const seed = Buffer.allocUnsafe(sodium.crypto_sign_SEEDBYTES);
  sodium.crypto_generichash_batch(seed, [
    Buffer.from('ns/dm/1', 'utf8'),
    identitySeed,
    conversationId,
  ]);
  const publicKey = Buffer.alloc(sodium.crypto_sign_PUBLICKEYBYTES);
  const secretKey = Buffer.alloc(sodium.crypto_sign_SECRETKEYBYTES);
  sodium.crypto_sign_seed_keypair(publicKey, secretKey, seed);
  return { publicKey, secretKey, seed };
}

/**
 * §31.3 / §31.14 — o core de **blobs** de DM de um lado da conversa:
 *
 *   dmBlobsSeed  = BLAKE2b-256('ns/dmblobs/1' ‖ identitySeed ‖ conversationId)
 *   (pk, sk)     = ed25519_keypair_from_seed(dmBlobsSeed)
 *
 * Um core de blobs **por conversa**, e não por identidade, pela razão de §31.1: escopo de
 * replicação = escopo de confidencialidade. Um core só para todas as conversas faria o
 * tópico de descoberta de §13.4 ligar entre si pessoas que não têm relação nenhuma — quem
 * baixa um anexo meu numa conversa passaria a anunciar interesse no mesmo core que serve
 * outra.
 *
 * Mora ao lado de `deriveDmCoreKeyPair` pelo mesmo argumento que aquele já faz: derivar
 * chave é **ciclo de vida de core**, não decisão de conteúdo (§4). E é o irmão de
 * `deriveMemberBlobsSeed` de §13.1 — mesma forma, domínio trocado, `conversationId` no
 * lugar do `communityId`.
 *
 * `conversationId` entra como os **32 bytes** de §31.2, a mesma convenção de `dmNonce`,
 * `dmContentKey` e `deriveDmCoreKeyPair`.
 */
export function deriveDmBlobsKeyPair(
  identitySeed: Buffer,
  conversationId: Buffer,
): { readonly publicKey: Buffer; readonly secretKey: Buffer; readonly seed: Buffer } {
  if (identitySeed.length !== sodium.crypto_sign_SEEDBYTES) {
    throw new Error('identitySeed deve ter 32 bytes');
  }
  if (conversationId.length !== 32) throw new Error('conversationId deve ter 32 bytes');
  const seed = Buffer.allocUnsafe(sodium.crypto_sign_SEEDBYTES);
  sodium.crypto_generichash_batch(seed, [
    Buffer.from('ns/dmblobs/1', 'utf8'),
    identitySeed,
    conversationId,
  ]);
  const publicKey = Buffer.alloc(sodium.crypto_sign_PUBLICKEYBYTES);
  const secretKey = Buffer.alloc(sodium.crypto_sign_SECRETKEYBYTES);
  sodium.crypto_sign_seed_keypair(publicKey, secretKey, seed);
  return { publicKey, secretKey, seed };
}

/**
 * §5.2 `'ns/hostturn/1'` (emenda de 2026-08-23) — segredo do serviço TURN desta instalação,
 * por comunidade hospedeira (§17.3). Mesma disciplina das derivações de cima: BLAKE2b via
 * sodium, e não `node:crypto` — o build do Electron não tem `blake2b512` no seu OpenSSL
 * ("Digest method not supported", achado do smoke de §59), e a canônica da tabela de §5.2 é
 * a de 32 bytes que todo o resto do código usa. A entrada (`dataKey`) é da composição; o
 * segredo nunca sai do processo núcleo.
 */
export function hostTurnSecretFrom(dataKey: Buffer, communityId: string): Buffer {
  const out = Buffer.allocUnsafe(32);
  sodium.crypto_generichash_batch(out, [Buffer.from('ns/hostturn/1', 'utf8'), dataKey, Buffer.from(communityId, 'utf8')]);
  return out;
}

/**
 * §5.2 `'ns/dmturn/1'` — segredo do serviço TURN desta instalação **por conversa direta**
 * (§31.15):
 *
 *   dmTurnSecret = BLAKE2b-256('ns/dmturn/1' ‖ dataKey ‖ conversationId)
 *
 * É o irmão exato de `hostTurnSecretFrom`, com o `conversationId` no lugar do `communityId` —
 * a mesma substituição que §31.14 fez no escopo de blob. E é a única peça de §17.3 que a
 * conversa direta **troca** em vez de reutilizar: o `'turn-cred/1'` e o TTL continuam os
 * mesmos, porque o que muda é de quem é o segredo, não como a credencial é feita.
 *
 * Por conversa, e não por instalação: um segredo único faria a credencial que eu emito para
 * um par valer contra o serviço que eu presto a outro. O escopo do segredo é o escopo do
 * serviço, e numa DM ele é a conversa (§31.1).
 *
 * O serviço é **simétrico** (§31.15): cada lado deriva o próprio segredo com a própria
 * `dataKey`, e é por isso que a credencial que eu uso contra o TURN do par **não** é
 * derivável aqui — ela chega dele, pelo `p2p-dm/1`.
 */
export function dmTurnSecretFrom(dataKey: Buffer, conversationId: string): Buffer {
  const out = Buffer.allocUnsafe(32);
  sodium.crypto_generichash_batch(out, [
    Buffer.from('ns/dmturn/1', 'utf8'),
    dataKey,
    Buffer.from(conversationId, 'utf8'),
  ]);
  return out;
}
