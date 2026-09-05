// Portas da raiz de composição (§4, "quem monta o grafo injeta a implementação no boot").
//
// Cada função aqui é uma **junta**: liga dois módulos que §4 proíbe de se importarem, sem
// tomar decisão de domínio nenhuma. `communityClient` não pode importar `opCodec`; `outbox`
// não pode importar `rpcClient`; `blobs` não pode receber caminho de arquivo do renderer.
// Quem sabe das duas pontas é quem monta o grafo — e é este arquivo.
//
// A regra que separa o que entra aqui do que fica no cabo de teste: entra o que o produto
// executa; fica de fora o que só simula transporte (`MemoryRpcChannel`), sonda fixa
// (`swarmNatProbe`) ou disco descartável (`tempDir`).

import path from 'node:path';

import sodium from 'sodium-native';

import {
  KINDS,
  PAYLOAD_LAYOUT,
  decodeEnvelope,
  decodeHostRecord,
  decodeOp,
  decodePayload,
  encodeEnvelope,
  encodeHostRecord,
  encodeOp,
  encodePayload,
  hostRecordSigningHash,
  opSigningHash,
  type KindName,
  type PayloadOf,
} from '../l1/opCodec/index.ts';
import {
  MAX_REACTION_EMOJIS,
  QUOTA_BYTES_PER_WINDOW,
  QUOTA_OPS_PER_WINDOW,
  QUOTA_WINDOW_SEQS,
} from '../l1/fold/constants.ts';
import { entityId, opId } from '../l1/idgen/index.ts';
import type { DecisionState } from '../l1/fold/index.ts';
import { PERMISSION_BY_NUMBER } from '../l1/permissions/index.ts';
import {
  createCore,
  openCore,
  type CoreHandle,
  type WritableCoreHandle,
} from '../l0/corestore/index.ts';
import type { ManifestDb } from '../l0/manifest/index.ts';
import type { ViewDb } from '../l0/view/index.ts';
import { computeHandle } from '../l0/identity/index.ts';
import type { Swarm } from '../l0/swarm/index.ts';
import type { HostAdmission } from '../l2/communityHost/index.ts';
import { inviteSecretToCode } from '../l2/invites/index.ts';
import {
  MEMBER_LEAVE_KIND,
  type CommunityClient,
  type HostSubmitPort,
  type ReplicationInfo,
  type SignedOpCodecPort,
  type SubmissionLimits,
} from '../l2/communityClient/index.ts';
import type { Outbox, SubmitPort, SubmitResult } from '../l2/outbox/index.ts';
import type { Projector } from '../l1/projector/index.ts';
import {
  dispositionFor,
  type CreateContinuationCorePort,
  type LayerBRefusal,
  type OriginFacts,
  type SubmitSyncPort,
} from '../l2/succession/index.ts';
import type { DiagnosticsMetricsPort, MetricsSnapshot, NatType } from '../l2/diagnostics/index.ts';
import type { RelayConsentPort } from '../l2/relay/index.ts';
import type { PresenceManager, PresenceStatus } from '../l2/presence/index.ts';
import type { VoiceHostSessions, VoiceStatePort } from '../l2/voiceCoordinator/index.ts';
import type { ShareHostSessions } from '../l2/shareStar/index.ts';
import {
  kindFromFilename,
  type BlobManager,
  type BlobsReaderPort,
  type BlobsWriterPort,
  type StageResult,
} from '../l2/blobs/index.ts';
import type { AttachmentSurfaceDeps, StagedAttachment } from '../l3/ipcRenderer/commands.ts';
import type { RpcClient } from '../l3/rpcClient/index.ts';
import { RPC_METHODS, type RpcServer } from '../l3/rpcServer/index.ts';
import { registerHostMediaMethods, type SignalDeliveryPort } from '../l3/rpcServer/media.ts';

/** Ed25519 detached de §5.1 — a mesma primitiva que o `opCodec` verifica do outro lado. */
function signDetached(message: Uint8Array, secretKey: Buffer): Buffer {
  const sig = Buffer.alloc(sodium.crypto_sign_BYTES);
  sodium.crypto_sign_detached(sig, message, secretKey);
  return sig;
}

// ─── Host sobre RPC (§16.2: hello, submitOp, submitOps) ─────────────────────────────────

export type HelloInfo = {
  readonly hostVersion: string;
  readonly opVersion: number;
  readonly coreLength: number;
  readonly memberCount: number;
  readonly capabilities: readonly string[];
};

/**
 * Registra os métodos de §16.2 suportados pelo `communityHost` atual sobre um `RpcServer`.
 * `submitOps` segue §11.9: um resultado por envelope, na ordem, sem parar no primeiro erro.
 */
export function wireHostRpc(
  server: RpcServer,
  opts: { admission: Pick<HostAdmission, 'submit'>; hello: HelloInfo },
): void {
  server.register('hello', () =>
    Buffer.from(
      JSON.stringify({
        hostVersion: opts.hello.hostVersion,
        opVersion: opts.hello.opVersion,
        coreLength: opts.hello.coreLength,
        memberCount: opts.hello.memberCount,
        capabilities: opts.hello.capabilities,
      }),
      'utf8',
    ),
  );

  server.register('submitOp', async (body) => {
    const arg = JSON.parse(Buffer.from(body).toString('utf8')) as { envelope: string };
    const result = await opts.admission.submit(new Uint8Array(Buffer.from(arg.envelope, 'base64')));
    if (!result.ok) return { code: result.code };
    return Buffer.from(JSON.stringify({ seq: result.seq, hostTs: result.hostTs }), 'utf8');
  });

  server.register('submitOps', async (body) => {
    const arg = JSON.parse(Buffer.from(body).toString('utf8')) as { envelopes: string[] };
    const out: Array<Record<string, unknown>> = [];
    let infraFailure = false;
    for (const [index, envB64] of arg.envelopes.entries()) {
      if (infraFailure) {
        out.push({ index, ok: false, code: 'E_NOT_ATTEMPTED' });
        continue;
      }
      const result = await opts.admission.submit(new Uint8Array(Buffer.from(envB64, 'base64')));
      if (result.ok) {
        out.push({ index, ok: true, seq: result.seq, hostTs: result.hostTs });
      } else {
        out.push({ index, ok: false, code: result.code });
        // §11.9: só infraestrutura interrompe o lote
        if (result.code === 'E_STORAGE_FULL' || result.code === 'E_BUSY') infraFailure = true;
      }
    }
    return Buffer.from(JSON.stringify(out), 'utf8');
  });
}

/**
 * §14.3(1) — o canal RECUSADO. "senão → recusa o canal com `E_NOT_AUTHORIZED_FOR_COMMUNITY`
 * e não replica nada": o segundo pedaço a composição sempre fez (o par não entra na
 * replicação); o primeiro não existia — o transporte apenas ignorava o par, em silêncio.
 *
 * O silêncio custava caro: §14.5 define `unauthorized` por "todos os pares recusaram o
 * canal" e §18.4 tem um SEGUNDO gatilho ("ao receber `E_NOT_AUTHORIZED_FOR_COMMUNITY` de
 * todos os pares") — os dois eram inalcançáveis, e quem foi removido enquanto estava
 * offline ficava em `reconnecting` para sempre, sem tela de histórico e sem poder esquecer
 * a comunidade. Nenhum quadro novo: o código já está no catálogo de §20.2 e a recusa viaja
 * como qualquer outra recusa nomeada de §16.1.
 */
export function wireRefusedCommunityRpc(server: RpcServer): void {
  for (const metodo of RPC_METHODS.community) {
    server.register(metodo, () => ({ code: 'E_NOT_AUTHORIZED_FOR_COMMUNITY' }));
  }
}

/**
 * Lado host dos métodos de presença de §16.2 (`presencePublish`, `subscribeChannel`) sobre o
 * `PresenceManager` da comunidade hospedada (§17.6). A origem da publicação é a CHAVE DA
 * CONEXÃO — §16.3 regra 4 vale aqui por analogia: o host não fabrica origem, e um payload
 * que afirmasse outra identidade seria spoofing de roster. Rate limit de §17.6 (1 presença/
 * 5 s por autor; 1 typing/2 s por autor e canal) é do manager; recusa vira `{code}` puro.
 */
export function wireHostPresenceRpc(
  server: RpcServer,
  opts: {
    readonly communityId: string;
    readonly peerKeyHex: string;
    readonly presence: PresenceManager;
  },
): void {
  const STATUS_VALIDOS: ReadonlySet<string> = new Set(['online', 'idle', 'dnd', 'invisible']);

  server.register('presencePublish', (body) => {
    let arg: { status?: unknown; typingChannelId?: unknown };
    try {
      arg = JSON.parse(Buffer.from(body).toString('utf8')) as typeof arg;
    } catch {
      return { code: 'E_MALFORMED' };
    }
    if (typeof arg.status !== 'string' || !STATUS_VALIDOS.has(arg.status)) return { code: 'E_VALIDATION' };
    const publicada = opts.presence.publishPresence({
      communityId: opts.communityId,
      identityKey: opts.peerKeyHex,
      status: arg.status as PresenceStatus,
    });
    // §17.6 limita a PRESENÇA a 1/5 s por autor, e o mesmo método carrega o typing
    // (§16.2 `presencePublish{status, typingChannelId?}` — é o fluxo do "digitando…" da
    // UI, que dispara muito mais often que 5 s). Publicar o MESMO status dentro da janela
    // não carrega informação nenhuma: trata como no-op e segue para o typing. Status
    // DIFERENTE dentro da janela continua sendo `E_RATE_LIMITED` — é ele que o teto protege.
    if (
      !publicada.ok &&
      !(publicada.code === 'E_RATE_LIMITED' && opts.presence.visibleStatusOf(opts.communityId, opts.peerKeyHex) === arg.status)
    ) {
      return { code: publicada.code };
    }
    // §17.6 (emenda de 2026-09-05) — `invisible` não publica presença NEM typing. O
    // "digitando…" carrega a mesma informação que a presença esconde: identidade, canal e
    // o fato de a pessoa estar conectada agora. Publicar um enquanto se recusa o outro
    // deixava o modo invisível meia-porta.
    if (arg.status === 'invisible') return new Uint8Array(0);
    if (typeof arg.typingChannelId === 'string' && arg.typingChannelId.length > 0) {
      const digitando = opts.presence.publishTyping({
        communityId: opts.communityId,
        identityKey: opts.peerKeyHex,
        channelId: arg.typingChannelId,
      });
      if (!digitando.ok) return { code: digitando.code };
    }
    return new Uint8Array(0);
  });

  server.register('subscribeChannel', (body) => {
    let arg: { channelId?: unknown; on?: unknown };
    try {
      arg = JSON.parse(Buffer.from(body).toString('utf8')) as typeof arg;
    } catch {
      return { code: 'E_MALFORMED' };
    }
    if (typeof arg.channelId !== 'string' || arg.channelId.length === 0 || typeof arg.on !== 'boolean') {
      return { code: 'E_VALIDATION' };
    }
    opts.presence.subscribeChannel({
      communityId: opts.communityId,
      subscriberKey: opts.peerKeyHex,
      channelId: arg.channelId,
      on: arg.on,
    });
    return new Uint8Array(0);
  });
}

/**
 * Lado host dos métodos de mídia de §16.2 — agora **produto**, em `rpcServer/media.ts`.
 * Este atalho mantém a forma que os rigs já usavam.
 */
export function wireHostMediaRpc(
  server: RpcServer,
  opts: {
    readonly peerKeyHex: string;
    readonly stateFor: () => VoiceStatePort | null;
    readonly voice: VoiceHostSessions;
    readonly share: ShareHostSessions;
    /** §16.4 (emenda de 2026-08-28) — a fila de karaokê da comunidade hospedada. */
    readonly fila: {
      entrar(channelId: string, keyHex: string): { ok: true } | { ok: false; code: 'E_QUEUE_CLOSED' | 'E_SESSION_GONE' | 'E_VALIDATION' };
      sair(channelId: string, keyHex: string): void;
      moderar(channelId: string, acao: 'promote' | 'skip' | 'remove' | 'addTime' | 'open' | 'close', alvo?: string, segundos?: number): { ok: true } | { ok: false; code: 'E_QUEUE_CLOSED' | 'E_SESSION_GONE' | 'E_VALIDATION' };
    };
    /** §16.2 `shareReport` (emenda de 2026-08-25) — o monitor de saúde de §17.5. */
    readonly shareHealth?: { ingest(sample: { sessionId: string; viewerKeyHex: string; rttMs: number; lossPct: number }): void };
    readonly signal?: SignalDeliveryPort;
  },
): void {
  registerHostMediaMethods(server, {
    peerKeyHex: opts.peerKeyHex,
    stateFor: opts.stateFor,
    voice: opts.voice,
    share: opts.share,
    fila: opts.fila,
    ...(opts.shareHealth !== undefined ? { shareHealth: opts.shareHealth } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });
}

/**
 * Porta de submissão da outbox de quem hospeda: a fila de admissão de §11.4 está neste
 * processo, então não há round-trip — cada envelope vai direto ao group commit, na ordem.
 * É a mesma forma que `rpcSubmitPort`, sem a rede: quem escreve na própria comunidade
 * também tem fila durável (`CommunityHandle.outbox` — "presente quando a instalação
 * escreve nela") e consome `authorSeq` da mesma fonte persistida (§11.2).
 */
export function admissionSubmitPort(admission: Pick<HostAdmission, 'submit'>): SubmitPort {
  return async (envelopes) => {
    const out: SubmitResult[] = [];
    for (const envelope of envelopes) {
      const r = await admission.submit(envelope);
      out.push(r.ok ? { ok: true, seq: r.seq, hostTs: r.hostTs } : { ok: false, code: r.code });
    }
    return out;
  };
}

/** Adaptador da porta de submissão da outbox sobre o `rpcClient` (§4, §11.6). */
export function rpcSubmitPort(client: RpcClient): SubmitPort {
  return async (envelopes) => {
    const body = Buffer.from(
      JSON.stringify({ envelopes: envelopes.map((e) => Buffer.from(e).toString('base64')) }),
      'utf8',
    );
    const result = await client.call('submitOps', new Uint8Array(body));
    if (!result.ok) return null; // indisponível → backoff/circuit breaker da outbox (§11.8)
    const parsed = JSON.parse(Buffer.from(result.body).toString('utf8')) as Array<
      | { index: number; ok: true; seq: number; hostTs: number }
      | { index: number; ok: false; code: string }
      | { index: number; ok: false; code: 'E_NOT_ATTEMPTED' }
    >;
    return parsed.map((item) =>
      item.ok
        ? ({ ok: true, seq: item.seq, hostTs: item.hostTs } satisfies SubmitResult)
        : ({ ok: false, code: item.code } satisfies SubmitResult),
    );
  };
}

// ─── Ponte de submissão assinada (§19.3, §29.2 item 1): portas reais da composição ──────

/**
 * Tetos de §8.6/R-14 usados pela validação advisória da ponte — constantes de protocolo
 * injetadas, a mesma fonte do `fold` (§27.1). A ponte não importa L1; quem compõe sim.
 */
export const SUBMISSION_LIMITS: SubmissionLimits = {
  contentMaxCodePoints: 4000,
  contentMaxBytes: 16_384,
  mentionsMaxItems: 64,
  quotaWindowSeqs: QUOTA_WINDOW_SEQS,
  quotaOpsPerWindow: QUOTA_OPS_PER_WINDOW,
  quotaBytesPerWindow: QUOTA_BYTES_PER_WINDOW,
  reactionMaxEmojis: MAX_REACTION_EMOJIS,
};

/**
 * Porta do codec assinado sobre os módulos reais de L1 (`opCodec` + `idgen`): é o
 * construtor compartilhado de §7.1/§7.3 que §4 não deixa `communityClient` importar.
 * Em produto, o boot do utilityProcess injeta esta mesma forma.
 */
export function opCodecSignPort(): SignedOpCodecPort {
  return {
    kindNumber(kindName: string): number | null {
      return kindName in KINDS ? KINDS[kindName as KindName] : null;
    },
    encodePayload(kindName: string, payload: Readonly<Record<string, unknown>>): Buffer | null {
      if (!(kindName in PAYLOAD_LAYOUT)) return null;
      try {
        return encodePayload(kindName as KindName, payload as PayloadOf<KindName>);
      } catch {
        return null;
      }
    },
    sealOp(input): { envelope: Buffer; opId: string } {
      const op = encodeOp({
        v: input.opVersion,
        communityId: input.communityId,
        kind: input.kindNumber,
        author: input.author,
        sequenceScope: input.sequenceScope,
        authorSeq: input.authorSeq,
        ts: input.ts,
        payload: input.payload,
      });
      // Ed25519 detached sobre BLAKE2b('op/1' ‖ op) — §7.1; o material é construído pelo codec.
      const sig = signDetached(opSigningHash(op), input.secretKey);
      const envelope = encodeEnvelope({ op, sig });
      return { envelope, opId: opId(envelope) };
    },
  };
}

/**
 * Porta do caminho ⏱ (§11.1) sobre o método `submitOp` de §16.2 no `rpcClient` existente.
 * Erro de transporte já chega como `{code}` do catálogo; resposta sem `{seq}` é anomalia
 * e vira indisponibilidade.
 */
export function rpcHostSubmitPort(client: RpcClient): HostSubmitPort {
  return async (envelope) => {
    const body = Buffer.from(
      JSON.stringify({ envelope: Buffer.from(envelope).toString('base64') }),
      'utf8',
    );
    const result = await client.call('submitOp', new Uint8Array(body));
    if (!result.ok) return { ok: false, code: result.code };
    const parsed = JSON.parse(Buffer.from(result.body).toString('utf8')) as { seq?: unknown };
    if (typeof parsed.seq !== 'number') return null;
    return { ok: true, seq: parsed.seq };
  };
}

/**
 * Resolve o alvo do envelope para o payload de `message.accepted` de §15.5: decodifica
 * `Envelope → Op` e dá o id da mensagem afetada — criada (`entityId` de §7.3 no send) ou
 * alvo do payload nos demais kinds do domínio. É a implementação da porta `resolveTarget`
 * da outbox — o boot injeta esta mesma forma. Kinds sem mensagem afetada devolvem `null`.
 */
export function envelopeTargetResolver(): (row: { readonly envelope: Buffer }) => {
  readonly messageId: string;
  readonly channelId: string | null;
} | null {
  const nomePorNumero = new Map<number, string>(
    Object.entries(KINDS).map(([nome, numero]) => [numero as number, nome] as const),
  );
  return (row) => {
    const envelope = decodeEnvelope(row.envelope);
    const op = envelope === null ? null : decodeOp(envelope.op);
    if (op === null) return null;
    const channelId = op.sequenceScope.kind === 'channel' ? op.sequenceScope.channelId : null;
    const nome = nomePorNumero.get(op.kind);
    if (nome === 'message.send') {
      const scopeKey = channelId === null ? 'community' : `channel:${channelId}`;
      return { messageId: entityId('message', op.communityId, op.author, op.authorSeq, scopeKey), channelId };
    }
    if (
      nome === 'message.edit' ||
      nome === 'message.delete' ||
      nome === 'message.pin' ||
      nome === 'reaction.set' ||
      nome === 'thread.create'
    ) {
      const p = decodePayload(nome, op.payload);
      if (p === null) return null;
      const messageId =
        nome === 'thread.create' ? (p as { rootMessageId: string }).rootMessageId : (p as { messageId: string }).messageId;
      return typeof messageId === 'string' ? { messageId, channelId } : null;
    }
    return null;
  };
}

// ─── Anexos e download (§13, §15.4 "Arquivos e diagnóstico") ────────────────────────────

/**
 * Porta de anexos sobre o `BlobManager` real. Três injeções, e todas são fronteiras que
 * §4 não deixa `blobs` cruzar sozinho:
 *
 *   - `blobsCoreKeyOf` é o core de blobs **local** da comunidade (§13.1), nascido do
 *     `member_blobs_core.secret_seed_enc` que só o boot decifra com a Data Key.
 *   - `pickFile` é o diálogo do main (`file.pick`/`staging.ticket`, §15.7). O caminho nasce
 *     e morre entre main e núcleo: nunca aparece na superfície IPC-R (`T-16`, `DR-37`).
 *   - `resolveAttachment` é a leitura de `attachments` na `view.db`. `blob.download`
 *     recebe de §15.4 só `{blobsCoreKey, blobId}`, e `name`/`sizeBytes`/`hash` — que o
 *     download precisa para abortar por tamanho e verificar o conteúdo (§13.4 passos 5–6)
 *     — são fato da mensagem projetada, não coisa que o renderer possa afirmar. A faixa
 *     do `blobId` também: o renderer que a mentir recebe o hash divergente, não o arquivo.
 */
export function blobAttachmentPort(opts: {
  readonly blobs: BlobManager;
  blobsCoreKeyOf(communityId: string): Buffer | null;
  pickFile(communityId: string): { readonly path: string; readonly sizeBytes: number } | Promise<{ readonly path: string; readonly sizeBytes: number } | null> | null;
  resolveAttachment(a: {
    readonly communityId?: string;
    readonly blobsCoreKeyHex: string;
    readonly blobId: { readonly byteOffset: number; readonly blockOffset: number; readonly blockLength: number; readonly byteLength: number };
  }): { readonly name: string; readonly sizeBytes: number; readonly hashHex: string; readonly blobId: { readonly byteOffset: number; readonly blockOffset: number; readonly blockLength: number; readonly byteLength: number } } | null;
  /** Onde o main abriria o arquivo/pasta (`shell.open`, §15.7) — registrado para o teste. */
  onReveal?(a: { readonly path: string; readonly mode: 'open' | 'folder' }): void;
}): AttachmentSurfaceDeps {
  const wire = (r: StageResult): StagedAttachment => ({
    blobsCoreKey: r.blobsCoreKey.toString('hex'),
    blobId: r.blobId,
    name: r.name,
    sizeBytes: r.sizeBytes,
    kind: r.kind,
    hash: r.hash.toString('hex'),
  });

  type Quad = { readonly byteOffset: number; readonly blockOffset: number; readonly blockLength: number; readonly byteLength: number };

  /** A chave do cache local é derivada do hash — resolver o anexo é o único caminho. */
  function resolvido(ref: { communityId?: string; blobsCoreKey: string; blobId: Quad }) {
    const row = opts.resolveAttachment({
      ...(ref.communityId !== undefined ? { communityId: ref.communityId } : {}),
      blobsCoreKeyHex: ref.blobsCoreKey,
      blobId: ref.blobId,
    });
    if (row === null) return null;
    return { ...row, blobIdHex: row.hashHex.slice(0, 32) };
  }

  return {
    async pick(communityId) {
      // O diálogo do main é async por natureza (§15.7); a porta aceita as duas formas.
      const escolhido = await opts.pickFile(communityId);
      if (escolhido === null || escolhido === undefined) throw Object.assign(new Error('cancelado'), { code: 'E_CANCELLED' });
      const ticket = opts.blobs.createTicketForMain(communityId, escolhido.path, escolhido.sizeBytes);
      return { ticketId: ticket.ticketId, name: ticket.name, sizeBytes: ticket.sizeBytes, kind: ticket.kind };
    },

    async stage(ticketId) {
      // O core de blobs do autor é o LOCAL da comunidade do ticket (§13.1) — quem resolve
      // é o manager, a partir do escopo que o próprio ticket carrega.
      return wire(await opts.blobs.stage(ticketId));
    },

    staged(ticketId) {
      const r = opts.blobs.stagedResult(ticketId);
      return r === null ? null : wire(r);
    },

    download(a) {
      const alvo = resolvido({ communityId: a.communityId, blobsCoreKey: a.blobsCoreKey, blobId: a.blobId });
      if (alvo === null) throw Object.assign(new Error('anexo desconhecido'), { code: 'E_NOT_FOUND' });
      // §13.4 devolve `{state}` na hora: o download corre e o progresso vai por evento.
      void opts.blobs
        .download({
          blobsCoreKey: Buffer.from(a.blobsCoreKey, 'hex'),
          blobIdHex: alvo.blobIdHex,
          declaredSize: alvo.sizeBytes,
          hash: Buffer.from(alvo.hashHex, 'hex'),
          name: alvo.name,
          blobId: alvo.blobId,
          communityId: a.communityId,
        })
        .catch(() => {
          /* o desfecho vai por `blob.completed`/`attachment.corrupt` (§15.5), não por aqui */
        });
      return { state: opts.blobs.getDownloadState(a.blobsCoreKey, alvo.blobIdHex) ?? 'queued' };
    },

    cancel(a) {
      const alvo = resolvido({ blobsCoreKey: a.blobsCoreKey, blobId: a.blobId });
      if (alvo !== null) opts.blobs.cancelDownload(a.blobsCoreKey, alvo.blobIdHex);
    },

    kindOf(a) {
      const alvo = resolvido({ blobsCoreKey: a.blobsCoreKey, blobId: a.blobId });
      if (alvo === null) return null;
      const row = opts.blobs.cache.get(a.blobsCoreKey, alvo.blobIdHex);
      return row?.path == null ? kindFromFilename(alvo.name) : kindFromFilename(row.path);
    },

    reveal(a) {
      const alvo = resolvido({ blobsCoreKey: a.blobsCoreKey, blobId: a.blobId });
      if (alvo === null) return { ok: false, code: 'E_NOT_DOWNLOADED' };
      const permitido = opts.blobs.canReveal(a.blobsCoreKey, alvo.blobIdHex, a.mode);
      if (!permitido.allowed) return { ok: false, code: permitido.reason ?? 'E_NOT_DOWNLOADED' };
      const row = opts.blobs.cache.get(a.blobsCoreKey, alvo.blobIdHex);
      if (row?.path == null) return { ok: false, code: 'E_NOT_DOWNLOADED' };
      opts.onReveal?.({ path: row.path, mode: a.mode });
      return { ok: true };
    },
  };
}

/**
 * Os dois adaptadores de Hypercore para o `BlobManager` (§13.1, §13.4). O armazenamento é
 * o de §10.1: os cores de blobs vivem em `<coresDir>/blobs/<blobsCoreKeyHex>` — a chave é
 * única do par `(autor, comunidade)`, então local e remoto compartilham a mesma árvore.
 * O writer nasce da semente decifrada do `member_blobs_core`; o reader abre por chave
 * pública e é esparso por natureza.
 */
export function blobCorePorts(coresDir: string): {
  openWriter(seed: Buffer): Promise<BlobsWriterPort>;
  openReader(blobsCoreKey: Buffer): Promise<BlobsReaderPort | null>;
} {
  const dirDe = (key: Buffer): string => path.join(coresDir, 'blobs', key.toString('hex'));
  return {
    async openWriter(seed) {
      if (seed.length !== 32) throw Object.assign(new Error('semente de blobs inválida'), { code: 'E_INTERNAL' });
      const publicKey = Buffer.alloc(sodium.crypto_sign_PUBLICKEYBYTES);
      const secretKey = Buffer.alloc(sodium.crypto_sign_SECRETKEYBYTES);
      sodium.crypto_sign_seed_keypair(publicKey, secretKey, seed);
      const core = await createCore(dirDe(publicKey), { publicKey, secretKey });
      const handle: BlobsWriterPort = {
        get key() {
          return core.key;
        },
        replicate(mux) {
          core.replicate?.(mux);
        },
        async appendBlocks(chunks) {
          const blockOffset = core.length;
          if (chunks.length > 0) await core.append(chunks);
          return blockOffset;
        },
        // §13.5/§22.4 — o GC de staging poda blocos locais; cabo real tem o hypercore por
        // baixo, rig de memória não e fica sem a porta.
        ...(core.clear !== undefined ? { clearRange: (startBlock: number, endBlock: number) => core.clear!(startBlock, endBlock) } : {}),
        close: () => core.close(),
      };
      return handle;
    },
    async openReader(blobsCoreKey) {
      let core: CoreHandle;
      try {
        core = await openCore(dirDe(blobsCoreKey), blobsCoreKey);
      } catch {
        return null;
      }
      if (core.downloadRange === undefined || core.replicate === undefined) {
        await core.close().catch(() => {});
        return null;
      }
      const handle: BlobsReaderPort = {
        get key() {
          return core.key;
        },
        replicate(mux) {
          core.replicate!(mux);
        },
        downloadRange: (startBlock, endBlock) => core.downloadRange!(startBlock, endBlock),
        // O `get` do cabo já é `wait: false`: a espera pela rede tem dono — o prazo que o
        // manager aplica sobre `downloadRange`. Aqui só se lê o que chegou.
        getBlock: async (seq) => {
          const bloco = await core.get(seq);
          return bloco ?? null;
        },
        // §13.4 passo 4 — só existe quando o cabo real está por baixo; rig sem replicação
        // fica sem a porta, e o manager então não publica progresso nenhum.
        ...(core.rangeStatus !== undefined ? { rangeStatus: (s2: number, e2: number) => core.rangeStatus!(s2, e2) } : {}),
        close: () => core.close(),
      };
      return handle;
    },
  };
}

/** Forma canônica do `blob_id` em `attachments` (JSON com ordem fixa de campos). */
export function attachmentBlobIdJson(blobId: {
  readonly byteOffset: number;
  readonly blockOffset: number;
  readonly blockLength: number;
  readonly byteLength: number;
}): string {
  return JSON.stringify({
    byteOffset: blobId.byteOffset,
    blockOffset: blobId.blockOffset,
    blockLength: blobId.blockLength,
    byteLength: blobId.byteLength,
  });
}

/**
 * Junta `resolveAttachment` sobre a `view.db` (§10.3 tabela `attachments`). O recorte é o
 * que o `blob.download` precisa e nada mais: nome, tamanho, hash e a faixa projetada —
 * nunca o caminho de disco, que não existe aqui. Sem linha projetada (mensagem que este
 * nó ainda não viu), devolve `null` e o comando responde `E_NOT_FOUND`.
 */
export function viewAttachmentResolver(view: ViewDb): Parameters<typeof blobAttachmentPort>[0]['resolveAttachment'] {
  return ({ communityId, blobsCoreKeyHex, blobId }) => {
    if (!/^[0-9a-f]{64}$/i.test(blobsCoreKeyHex)) return null;
    const blobIdJson = attachmentBlobIdJson(blobId);
    const sql =
      communityId !== undefined
        ? 'SELECT name, size_bytes AS sizeBytes, hash, blob_id AS blobIdJson FROM attachments WHERE community_id = ? AND blobs_core_key = ? AND blob_id = ?'
        : 'SELECT name, size_bytes AS sizeBytes, hash, blob_id AS blobIdJson FROM attachments WHERE blobs_core_key = ? AND blob_id = ?';
    const params = communityId !== undefined ? [communityId, Buffer.from(blobsCoreKeyHex, 'hex'), blobIdJson] : [Buffer.from(blobsCoreKeyHex, 'hex'), blobIdJson];
    let row = view.prepare(sql).get(...params) as
      | { name: string; sizeBytes: number; hash: Uint8Array; blobIdJson: string }
      | undefined;
    // §31.14 — anexo de conversa direta. `blob.download` é "reutilizado sem alteração", e
    // é isto que faz valer: o comando de §15.4 continua recebendo só `{blobsCoreKey,
    // blobId}`, e quem descobre `name`/`sizeBytes`/`hash` é este resolver. A tabela é
    // outra (`dm_attachments`, §10.3) porque a projeção é outra; a consulta é a mesma
    // pergunta. Sem este ramo, baixar um anexo de DM devolveria "anexo desconhecido" — o
    // renderer não pode declarar o tamanho nem o hash (§13.4 passos 5–6).
    if (row === undefined) {
      row = view
        .prepare(
          'SELECT name, size_bytes AS sizeBytes, hash, blob_id AS blobIdJson FROM dm_attachments WHERE blobs_core_key = ? AND blob_id = ?',
        )
        .get(Buffer.from(blobsCoreKeyHex, 'hex'), blobIdJson) as
        | { name: string; sizeBytes: number; hash: Uint8Array; blobIdJson: string }
        | undefined;
    }
    if (row === undefined) return null;
    return {
      name: row.name,
      sizeBytes: row.sizeBytes,
      hashHex: Buffer.from(row.hash).toString('hex'),
      blobId: JSON.parse(row.blobIdJson) as {
        byteOffset: number;
        blockOffset: number;
        blockLength: number;
        byteLength: number;
      },
    };
  };
}

/**
 * `host.exitImpact` (§15.4, §18.7). O núcleo junta o que já sabe por comunidade: quem está
 * hospedado aqui, quantos online, quantos em chamada e o que ainda não replicou. Nenhuma fonte
 * nova — cada número vem de um subsistema que já existe.
 */
export function hostExitImpactPort(opts: {
  readonly communities: readonly { readonly communityId: string; readonly name: string }[];
  onlineCount(communityId: string): number;
  inCallCount(communityId: string): number;
  pendingReplication(communityId: string): number;
}): () => readonly Record<string, unknown>[] {
  return () =>
    opts.communities.map((c) => ({
      communityId: c.communityId,
      name: c.name,
      onlineCount: opts.onlineCount(c.communityId),
      inCallCount: opts.inCallCount(c.communityId),
      pendingReplication: opts.pendingReplication(c.communityId),
    }));
}

/** Snapshot agregado das métricas de §24.3 espalhadas pelos detentores de estado. */
export function aggregateMetricsPort(opts: {
  swarm: Swarm;
  natType: NatType;
  counters?: () => Record<string, number>;
}): DiagnosticsMetricsPort & { setNat(n: NatType): void } {
  let nat = opts.natType;
  return {
    setNat(n: NatType) {
      nat = n;
    },
    snapshot(): MetricsSnapshot {
      const stats = opts.swarm.getStats();
      return {
        gauges: {
          'swarm.peers': stats.peerCount,
          'swarm.natType': nat === 'open' ? 0 : nat === 'moderate' ? 1 : 2,
        },
        counters: opts.counters?.() ?? {},
        histograms: {},
      };
    },
  };
}

// ─── Porta de consentimento do relay sobre manifest.db (§6.15) ─────────────────────────

export function manifestRelayConsentPort(manifest: import('../l0/manifest/index.ts').ManifestDb): RelayConsentPort {
  return {
    get(communityId) {
      return manifest.getRelayConsent(communityId);
    },
    set(communityId, decision, opts) {
      manifest.setRelayConsent(communityId, decision, Date.now());
      if (!opts.remember) manifest.forgetRelayConsent(communityId);
    },
    forget(communityId) {
      manifest.forgetRelayConsent(communityId);
    },
  };
}

// ─── Recorte do DecisionState para voz/tela (porta de §17.4) ────────────────────────────

/**
 * Adaptador estrutural `DecisionState → VoiceStatePort`. O DS de §8.1 satisfaz a porta por
 * forma — `permissions` já é `Set<number>` de §9.1 e os campos de membro/canal batem; este
 * adaptador só recorta o que a mídia lê.
 */
export function voiceStateOf(state: DecisionState): VoiceStatePort {
  return {
    community: state.community,
    channels: state.channels,
    members: new Map(
      [...state.members.entries()].map(([keyHex, member]) => [
        keyHex,
        {
          state: member.state,
          ...(member.timeoutUntil !== undefined ? { timeoutUntil: member.timeoutUntil } : {}),
          roleIds: member.roleIds,
        },
      ]),
    ),
    roles: new Map(
      [...state.roles.entries()].map(([id, role]) => [
        id,
        {
          permissions: role.permissions,
          ...(role.deletedAt !== undefined ? { deletedAt: role.deletedAt } : {}),
        },
      ]),
    ),
  };
}

// ─── Composição das portas de sucessão sobre módulos reais (§34.2 item 1, §18.8) ────────
//
// As quatro portas de `SuccessionDeps` compostas dos módulos de produto — a ponte de §30,
// o `corestore`, o log da origem e o `manifest` — no mesmo padrão das juntas da ponte de
// submissão acima (`opCodecSignPort`, `rpcHostSubmitPort`): nenhuma decisão de domínio
// aqui dentro; quem decide continua sendo o serviço (L2) e o `fold`. Quando o boot do
// utilityProcess existir, são estas formas que ele injeta.

// Cifra de repouso de §5.1/§5.4 (XChaCha20-Poly1305) com o particionamento do schema de
// §10.2: `community_seed_nonce` é a coluna separada do nonce e `_enc` é ciphertext‖tag.
// Os helpers de `identity` não são exportados; a forma é a mesma.

function aeadSealSeed(plain: Buffer, dataKey: Buffer): { enc: Buffer; nonce: Buffer } {
  const nonce = Buffer.alloc(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  sodium.randombytes_buf(nonce);
  const enc = Buffer.alloc(plain.length + sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES);
  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(enc, plain, null, null, nonce, dataKey);
  return { enc, nonce };
}

function aeadOpenSeed(enc: Buffer, nonce: Buffer, dataKey: Buffer): Buffer | null {
  if (enc.length < sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES) return null;
  const plain = Buffer.alloc(enc.length - sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES);
  try {
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(plain, null, enc, null, nonce, dataKey);
  } catch {
    return null;
  }
  return plain;
}

/** Grava a linha de comunidade hospedada de §5.3 com a semente cifrada pela Data Key. */
export function storeCommunitySeed(manifest: ManifestDb, row: {
  communityId: string;
  coreKey: Buffer;
  blobsKey: Buffer;
  communitySeed: Buffer;
  isHost: boolean;
  joinedAt: number;
  originCommunityId?: string | null;
}, dataKey: Buffer): void {
  const { enc, nonce } = aeadSealSeed(row.communitySeed, dataKey);
  manifest.upsertCommunity({
    communityId: row.communityId,
    coreKey: row.coreKey,
    blobsKey: row.blobsKey,
    communitySeedEnc: enc,
    communitySeedNonce: nonce,
    isHost: row.isHost,
    joinedAt: row.joinedAt,
    ...(row.originCommunityId !== undefined ? { originCommunityId: row.originCommunityId } : {}),
  });
}

/** Porta `communitySeed` de §5.3: lê o `manifest` e decifra com a Data Key; sem linha hospedada ou cifra inválida → `null`. */
export function manifestCommunitySeedPort(manifest: ManifestDb, dataKey: Buffer): (communityId: string) => Buffer | null {
  return (communityId) => {
    const row = manifest.getCommunity(communityId) as
      | { community_seed_enc?: Buffer | null; community_seed_nonce?: Buffer | null; is_host?: number }
      | null;
    if (
      row === null ||
      !row.is_host ||
      row.community_seed_enc === undefined ||
      row.community_seed_enc === null ||
      row.community_seed_nonce === undefined ||
      row.community_seed_nonce === null
    ) {
      return null;
    }
    const seed = aeadOpenSeed(Buffer.from(row.community_seed_enc), Buffer.from(row.community_seed_nonce), dataKey);
    return seed !== null && seed.length === 32 ? seed : null;
  };
}

/**
 * Porta `sealedSeedFor`: relê o log da origem pelo `CoreHandle` — o `DS` não guarda escrow
 * (§8.1) — decodificando HostRecord → Envelope → Op até achar o `community.escrow`
 * endereçado à identidade local; mais recente primeiro. Comunidade que não é este core,
 * bloco ilegível ou escrow ausente → `null`.
 */
export function logEscrowPort(core: CoreHandle, selfPublicKey: Buffer): (communityId: string) => Promise<Buffer | null> {
  return async (communityId) => {
    if (communityId !== core.key.toString('hex')) return null;
    for (let seq = core.length - 1; seq >= 0; seq--) {
      const block = await core.get(seq);
      if (block === null) continue;
      const hostRecord = decodeHostRecord(Buffer.from(block));
      const envelope = hostRecord === null ? null : decodeEnvelope(hostRecord.envelope);
      const op = envelope === null ? null : decodeOp(envelope.op);
      if (op === null || op.kind !== KINDS['community.escrow']) continue;
      const p = decodePayload('community.escrow', op.payload);
      if (p !== null && p.targetKey.equals(selfPublicKey)) return Buffer.from(p.wrappedSeed);
    }
    return null;
  };
}

/** O que a composição precisa saber para registrar a continuação (§18.8, §5.3, §19.1). */
export type ContinuationInfo = {
  readonly communityId: string;
  readonly coreKey: Buffer;
  readonly blobsKey: Buffer;
  readonly communitySeed: Buffer;
  readonly originCommunityId: string;
  /** Tamanho do lote appendado — a gênese estendida, para fixar o `authorSeq` de §7.5. */
  readonly recordCount: number;
};

/**
 * Porta `createContinuationCore` sobre o `corestore` real: cria o core com o par do plano
 * em `<rootDir>/<keyHex>` (§5.3 — aberto por chave explícita, nunca namespace aleatório),
 * appenda o lote inteiro numa chamada (§10.7.1) e chama os ganchos da ativação.
 *
 * A ordem é a de §19.1/§5.3 e não é decorativa: `antesDeCriar` grava a linha do manifest
 * com a semente cifrada **antes** de existir core algum, `aoCriar` recebe o cabo já com o
 * lote dentro, e `aoFalhar` desfaz a linha quando o append não passa. Criar o core sem
 * nenhum deles — como a raiz fazia — deixava a continuação no disco e fora do processo:
 * não entrava no manifest, não abria no runtime, não anunciava tópico, e sumia no
 * reinício seguinte.
 */
export function corestoreContinuationCorePort(
  rootDir: string,
  hooks?: {
    readonly antesDeCriar?: (info: ContinuationInfo) => void | Promise<void>;
    readonly aoCriar?: (core: WritableCoreHandle, info: ContinuationInfo) => void | Promise<void>;
    readonly aoFalhar?: (info: ContinuationInfo) => void;
  },
): CreateContinuationCorePort & { readonly created: WritableCoreHandle[]; close(): Promise<void> } {
  const created: WritableCoreHandle[] = [];
  const port = async ({ keyPair, records, communitySeed, blobsKey, originCommunityId }: {
    readonly keyPair: { readonly publicKey: Buffer; readonly secretKey: Buffer };
    readonly records: readonly Buffer[];
    readonly communitySeed: Buffer;
    readonly blobsKey: Buffer;
    readonly originCommunityId: string;
  }): Promise<void> => {
    const info: ContinuationInfo = {
      communityId: keyPair.publicKey.toString('hex'),
      coreKey: keyPair.publicKey,
      blobsKey,
      communitySeed,
      originCommunityId,
      recordCount: records.length,
    };
    await hooks?.antesDeCriar?.(info);
    let core: WritableCoreHandle | null = null;
    try {
      core = await createCore(path.join(rootDir, info.communityId), keyPair);
      await core.append(records.map((r) => Buffer.from(r)));
    } catch (e) {
      if (core !== null) await core.close().catch(() => {});
      hooks?.aoFalhar?.(info);
      throw e;
    }
    created.push(core);
    await hooks?.aoCriar?.(core, info);
  };
  return Object.assign(port, {
    created,
    // `aoCriar` pode ter fechado o cabo para o runtime reabrir o core em exclusividade
    // (§5.3 passo 5); fechar duas vezes não é erro que valha derrubar o desligamento.
    close: async () => {
      for (const core of created) await core.close().catch(() => {});
    },
  });
}

/** Porta `submitSync` ligada à ponte de §30 — delegação direta ao `CommunityClient`. */
export function bridgeSubmitSyncPort(client: CommunityClient): SubmitSyncPort {
  return (communityId, input) => client.submitSync(communityId, input);
}

// ─── Ciclo de vida da comunidade e consulta; rail de sucessão (§11.1, §15.6, L-16/L-22) ─

/**
 * Orquestração de `community.leave` (§15.4, exceção única de §11.1). Efeito local
 * imediato — descarte da fila com motivo nomeado, `left_at`, saída do swarm — com o
 * kind `member.leave` enfileirado ANTES do descarte para os demais verem a saída (L-22).
 * O host não sai (`E_HOST_CANNOT_LEAVE`); o fold continua vinculante na admissão.
 */
export function communityLeavePort(opts: {
  client: CommunityClient;
  manifest: ManifestDb;
  outboxOf(communityId: string): Outbox | undefined;
  selfKeyHex(): string | null;
}): (communityId: string) =>
  | { readonly ok: true; readonly opId: string; readonly droppedQueued: number }
  | { readonly ok: false; readonly code: string } {
  return (communityId) => {
    const state = opts.client.writeStateFor(communityId);
    if (state === null) return { ok: false, code: 'E_NOT_FOUND' };
    const selfKeyHex = opts.selfKeyHex();
    if (selfKeyHex === null) return { ok: false, code: 'E_NO_IDENTITY' };
    if (state.community.hostKey.toString('hex') === selfKeyHex) {
      return { ok: false, code: 'E_HOST_CANNOT_LEAVE' };
    }
    const outbox = opts.outboxOf(communityId);
    if (outbox === undefined) return { ok: false, code: 'E_INTERNAL' };
    const enfileirada = opts.client.submitQueued(communityId, {
      kindName: MEMBER_LEAVE_KIND,
      payload: {},
    });
    if (!enfileirada.ok) return { ok: false, code: enfileirada.code };
    const droppedQueued = outbox.discardForLeave(enfileirada.opId);
    opts.manifest.markCommunityLeft(communityId, Date.now());
    opts.client.removeCommunity(communityId);
    return { ok: true, opId: enfileirada.opId, droppedQueued };
  };
}

/** `UserRef` de §15.6 com os campos que já têm fonte em código. */
export interface QueryUserRef {
  readonly key: string;
  readonly displayName: string;
  readonly handle: string;
  readonly avatarColor: string;
  /** §15.6 — apelido por comunidade (`member.setNickname`), ausente quando não há. */
  readonly nickname?: string;
  /**
   * L-5 — colisão de `displayName` normalizado entre membros ativos. O valor é LIDO da
   * marca que o `fold` mantém no DS (`displayNameCollision`, §6.1, fechada em §57);
   * calculá-lo aqui seria escrever a regra de domínio uma segunda vez, fora do `fold`.
   * Membro ausente do roster não colide com ninguém: sem marca, `false`.
   */
  readonly collision: boolean;
}

/** `UserRef` a partir do roster do DS — a mesma forma para toda query de §15.6. */
export function queryUserRef(
  keyHex: string,
  membro?: { displayName: string; avatarColor: number; displayNameCollision?: true },
): QueryUserRef {
  return {
    key: keyHex,
    displayName: membro?.displayName ?? keyHex.slice(0, 8),
    handle: computeHandle(Buffer.from(keyHex, 'hex')),
    avatarColor: String(membro?.avatarColor ?? 0),
    collision: membro?.displayNameCollision === true,
  };
}

/**
 * Recorte entregue de `query.community` (§15.6): só os campos com fonte real hoje.
 * `memberCount`, `unread`, `notificationLevel`, `hostStatus`, `inactiveDays`,
 * `iconEmoji?` e `partialInterpretation` aguardam seus subsistemas e ficam AUSENTES —
 * registrados em `docs/sequenciamento-pos-fase-0.md`.
 */
export interface QueryCommunityView {
  readonly id: string;
  readonly name: string;
  readonly iconColor: number;
  readonly endedAt?: number;
  readonly originCommunityId?: string;
  readonly isHost: boolean;
  readonly hostRef: QueryUserRef;
  readonly successorKeys: readonly string[];
  readonly myRoleIds: readonly string[];
  readonly myPermissions: readonly string[];
  readonly myTopRank: string;
  readonly replication: { readonly state: string; readonly lag: number };
  readonly pendingReentry?: readonly QueryUserRef[];
}

/**
 * Monta `query.community` sobre o DS REAL (nomes, cargos, ranks — o recorte da ponte não
 * basta), a replicação e a sucessão. `pendingReentry` só existe quando a comunidade é
 * continuação E a origem está replicada aqui — exatamente a condição de §15.6/L-23.
 */
export function queryCommunityPort(opts: {
  stateFor(communityId: string): DecisionState | null;
  selfKeyHex(): string | null;
  replicationOf(communityId: string): ReplicationInfo;
  pendingReentryOf?(communityId: string): readonly Buffer[];
}): (communityId: string) => QueryCommunityView | null {
  const refDe = queryUserRef;
  return (communityId) => {
    const ds = opts.stateFor(communityId);
    if (ds === null || !ds.community.exists) return null;
    const selfKeyHex = opts.selfKeyHex();
    if (selfKeyHex === null) return null;
    const eu = ds.members.get(selfKeyHex);
    if (eu === undefined || eu.state !== 'active') return null;

    const myRoleIds = [...eu.roleIds];
    const permissoes = new Set<number>();
    // §9.3 — o teto do membro é o maior rank entre os cargos ativos dele (mesma regra
    // de `topRank`; aqui é inline porque o recorte do DS não satisfaz `RoleLookup`).
    let teto: string | null = null;
    for (const roleId of myRoleIds) {
      const role = ds.roles.get(roleId);
      if (role === undefined || role.deletedAt !== undefined) continue;
      for (const p of role.permissions) permissoes.add(p);
      if (teto === null || role.rank > teto) teto = role.rank;
    }
    const hostHex = ds.community.hostKey.toString('hex');
    // pendingReentry só existe quando a comunidade é continuação E a origem está
    // replicada aqui — a condição literal de §15.6; os nomes vêm do roster da ORIGEM.
    const originId = ds.community.originCommunityId;
    let pendentes: QueryUserRef[] | undefined;
    if (originId !== undefined && opts.pendingReentryOf !== undefined) {
      const origem = opts.stateFor(originId);
      if (origem !== null && origem.community.exists) {
        pendentes = opts.pendingReentryOf(communityId).map((k) => {
          const hex = k.toString('hex');
          return refDe(hex, origem.members.get(hex));
        });
      }
    }

    const view: QueryCommunityView = {
      id: ds.communityId,
      name: ds.community.name,
      iconColor: ds.community.iconColor,
      ...(ds.community.endedAt !== undefined ? { endedAt: ds.community.endedAt } : {}),
      ...(originId !== undefined ? { originCommunityId: originId } : {}),
      isHost: hostHex === selfKeyHex,
      hostRef: refDe(hostHex, ds.members.get(hostHex)),
      successorKeys: ds.community.successorKeys.map((k) => k.toString('hex')),
      myRoleIds,
      myPermissions: [...permissoes].map((n) => PERMISSION_BY_NUMBER[n] ?? String(n)),
      myTopRank: teto ?? '',
      replication: opts.replicationOf(communityId),
      ...(pendentes !== undefined ? { pendingReentry: pendentes } : {}),
    };
    return view;
  };
}

/** Item de `query.invites` (§15.6) — os campos da tabela, sem nenhum a mais. */
export interface QueryInviteItem {
  readonly invitePublicKey: string;
  readonly code?: string;
  readonly codeAvailable: boolean;
  readonly label?: string;
  readonly createdBy: QueryUserRef;
  readonly createdAt: number;
  readonly expiresAt?: number;
  readonly maxUses?: number;
  readonly uses: number;
  readonly revokedAt?: number;
}

/**
 * `query.invites` (§15.6) sobre o DS real e o `manifest.invite_secrets` (§10.2). O que é
 * **fato do log** — quem criou, quando, validade, tetos, usos, revogação — vem do DS, e é
 * igual em toda réplica; o `code` só existe onde o segredo foi guardado, isto é, na
 * instalação que criou o convite (§12.2, delta U-04). É por isso que `codeAvailable` é um
 * campo próprio: "não tenho o código" é resposta legítima, não erro.
 *
 * A ordem é a de aplicação do log (a ordem de inserção do DS), a mesma régua de
 * `defaultChannelId` em §46. `label` é local: mora com o segredo, nunca no log.
 */
export function queryInvitesPort(opts: {
  stateFor(communityId: string): DecisionState | null;
  readonly manifest: ManifestDb;
}): (communityId: string) => { readonly items: readonly QueryInviteItem[] } | null {
  return (communityId) => {
    const ds = opts.stateFor(communityId);
    if (ds === null || !ds.community.exists) return null;
    const locais = new Map<string, { secret: Buffer; label: string | null }>();
    for (const row of opts.manifest.listInviteSecrets(communityId)) {
      locais.set(Buffer.from(row.invitePublicKey).toString('hex'), { secret: Buffer.from(row.secret), label: row.label });
    }
    const items: QueryInviteItem[] = [];
    for (const [pkHex, invite] of ds.invites) {
      const local = locais.get(pkHex);
      // Segredo com tamanho inesperado não vira código inventado: `codeAvailable` cai.
      let code: string | null = null;
      if (local !== undefined) {
        try {
          code = inviteSecretToCode(local.secret);
        } catch {
          code = null;
        }
      }
      const criadorHex = invite.createdBy.toString('hex');
      items.push({
        invitePublicKey: pkHex,
        ...(code !== null ? { code } : {}),
        codeAvailable: code !== null,
        ...(local?.label != null ? { label: local.label } : {}),
        createdBy: queryUserRef(criadorHex, ds.members.get(criadorHex)),
        createdAt: invite.createdAt,
        ...(invite.expiresAt !== undefined ? { expiresAt: invite.expiresAt } : {}),
        ...(invite.maxUses !== undefined ? { maxUses: invite.maxUses } : {}),
        uses: invite.uses,
        ...(invite.revokedAt !== undefined ? { revokedAt: invite.revokedAt } : {}),
      });
    }
    return { items };
  };
}

/**
 * Migração de rail de §18.8 passo 5 com arbitragem de L-16: `dispositionFor` decide por
 * réplica — camada b quando a origem está aqui, camada a quando não está. Migrar é
 * acrescentar a continuação ao cliente como comunidade ativa; a origem permanece aberta
 * e legível em modo histórico (S6: se o host voltar, ela ainda interpreta cauda).
 * Recusado → `disputed` para quem detém estado de UI; nada é adicionado ao cliente.
 * A DESCOBERTA da continuação (quem dá o core novo à réplica) é do transporte — G12
 * empacotado; esta porta decide o que fazer com ele depois de descoberto.
 */
export function migrateRail(args: {
  client: CommunityClient;
  originProjector: Projector;
  continuation: { core: CoreHandle; projector: Projector };
  ttlMs: number;
  now(): number;
}): { migrated: true } | { migrated: false; disputed: true; reason: LayerBRefusal } {
  const contDs = args.continuation.projector.ds;
  const originId = contDs.community.originCommunityId;
  if (!contDs.community.exists || originId === undefined) {
    throw new Error('migração de rail exige uma continuação interpretada aqui');
  }
  const origemDs = args.originProjector.ds;
  const claim = {
    communityIdHex: args.continuation.core.key.toString('hex'),
    originCommunityIdHex: originId,
    originFinalSeq: contDs.community.originFinalSeq ?? 0,
    assumedByHex: contDs.community.hostKey.toString('hex'),
  };
  // Só quem TEM a origem replicada confere a camada b; origem de outro id aqui não conta.
  const facts: OriginFacts | null =
    origemDs.communityId === originId
      ? {
          communityIdHex: origemDs.communityId,
          successorKeysHex: origemDs.community.successorKeys.map((k) => k.toString('hex')),
          lastHostTs: origemDs.lastHostTs,
          ...(origemDs.community.endedAt !== undefined ? { endedAt: origemDs.community.endedAt } : {}),
        }
      : null;
  const d = dispositionFor({ claim, origin: facts, ttlMs: args.ttlMs, now: args.now() });
  if (!d.migrate) return { migrated: false, disputed: true, reason: d.reason };
  args.client.addCommunity({
    communityId: claim.communityIdHex,
    core: args.continuation.core,
    projector: args.continuation.projector,
  });
  return { migrated: true };
}

// ─── Assinatura do HostRecord (§7.1, §11.4) ─────────────────────────────────────────────

/**
 * O `makeHostRecord` que `communityHost` recebe injetado. §4 não dá `opCodec` a
 * `communityHost`: quem constrói o material assinável e quem tem a chave de escrita do core
 * é quem monta o grafo. `flags` é 0 — o v1 não define nenhum (§7.1).
 */
export function hostRecordSigner(coreSecretKey: Buffer): (envelope: Uint8Array, hostTs: number) => Uint8Array {
  return (envelope, hostTs) => {
    const hostSig = signDetached(hostRecordSigningHash(envelope, hostTs, 0), coreSecretKey);
    return encodeHostRecord({ envelope: Buffer.from(envelope), hostTs, flags: 0, hostSig });
  };
}
