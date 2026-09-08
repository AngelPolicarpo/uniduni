// `fold` — a interpretação normativa. §8.
//
//   L1, puro. Sem I/O, sem relógio, sem configuração, **sem exceção** (§4, §8.5).
//   foldRecord(prev: DecisionState, rec: RawRecord, seq: number): FoldResult
//
// Três desfechos, e só três: `APPLIED`, `REJECTED`, `IGNORED`. Não existe "abortar", "parar",
// "degradar a comunidade" nem "lançar" (§8.5). Em **todos** os desfechos o estágio final
// atualiza `interpretedSeq = seq` e, quando o registro chegou ao estágio 6, também
// `lastAuthorSeq[author, sequenceScope]` — inclusive em `REJECTED`, que é o que impede um autor de reciclar
// o número depois de uma recusa (§8.2).
//
// O pipeline de §8.2 está na ordem fixa, com o número do estágio no comentário de cada bloco.
// Os estágios 13, 14 e 15 são delegados por `kind` para `applyKind` (§8.3, §8.4), e a matriz
// de §9.4 é lida declarativamente de `policy.ts`.

import type { ErrorCode } from '../errors/index.ts';
import {
  KINDS,
  decodeEnvelope,
  decodeHostRecord,
  decodeOp,
  decodePayload,
  hostRecordSigningHash,
  isKnownKind,
  isSupportedVersion,
  kindName,
  opSigningHash,
  sequenceScopeKey,
  verifySignature,
  type KindName,
  type Op,
  type SequenceScope,
} from '../opCodec/index.ts';
import { opId } from '../idgen/index.ts';
import {
  ALL_PERMISSIONS,
  RANK_GENESIS,
  authorizeOverTarget,
  effectivePermissions,
  permissionFromNumber,
  topRank,
  type Permission,
  type RoleLookup,
} from '../permissions/index.ts';
import { applyKind, type KindCtx, type Rejection } from './apply.ts';
import {
  CLOCK_ACCEPT_MS,
  GENESIS_LAST_SEQ,
  MAX_ENVELOPE_BYTES,
  MAX_ENVELOPE_BYTES_ATTACHMENT,
} from './constants.ts';
import type { Effect } from './effects.ts';
import { policyOf, type KindPolicy, type PermRule } from './policy.ts';
import { Draft, ringAdd, ringWouldExceed, type DecisionState } from './state.ts';
import { hierarchyTargetOf } from './targets.ts';

export * from './constants.ts';
export * from './effects.ts';
export * from './limits.ts';
export * from './links.ts';
export * from './policy.ts';
export * from './rank.ts';
export * from './state.ts';
export { applyKind, type KindCtx, type Rejection } from './apply.ts';
export { hierarchyTargetOf, type HierarchyTarget } from './targets.ts';

export type Decision = 'APPLIED' | 'REJECTED' | 'IGNORED';

export type FoldResult = {
  readonly decision: Decision;
  /** Presente quando `REJECTED` ou `IGNORED`. */
  readonly reason?: ErrorCode;
  /** §20.1 — presente em `E_VALIDATION`. */
  readonly field?: string;
  /** §20.2 — presente em `E_LIMIT_EXCEEDED`. */
  readonly limit?: number;
  /** Vazio quando não `APPLIED`. */
  readonly effects: readonly Effect[];
  readonly next: DecisionState;
  /** R-1 — o registro trouxe `hostTs` retroativo e foi clampado (`fold.hostTsClamped`). */
  readonly hostTsClamped?: boolean;
  /**
   * §8.0 — o `kind` de §7.4 **como veio no registro**, inclusive quando é desconhecido deste
   * binário. Presente a partir do decode do `Op` (estágio 2) e ausente antes dele. Metadado
   * de desfecho: não entra no `DecisionState` e não influencia decisão nenhuma.
   */
  readonly kind?: number;
  /** §8.0 — `op.author`, presente a partir do decode do `Op` (estágio 2). */
  readonly author?: Buffer;
  /** Metadados da operação aceita, para índices derivados como `observed_ops` (§11.6). */
  readonly opId?: string;
  readonly authorSeq?: number;
  readonly sequenceScope?: SequenceScope;
};

/**
 * §8.0 — a fronteira de diagnóstico do estágio 2. O pipeline preenche isto assim que o `Op`
 * decodifica; `foldRecord` copia para o `FoldResult`, **inclusive no caminho de pânico**
 * (§8.5), que é a única forma de `fold.panic{seq, kind}` ter o `kind`: quem lança pode ter
 * lançado depois do decode, e o `projector` não decodifica registro (§4).
 */
type OpProbe = { kind?: number; author?: Buffer };

function withProbe(r: FoldResult, probe: OpProbe): FoldResult {
  if (probe.kind === undefined || probe.author === undefined) return r;
  return { ...r, kind: probe.kind, author: probe.author };
}

/** Os bytes de um registro do core, como o Hypercore os devolve. */
export type RawRecord = Uint8Array;

/** Contadores de §8.5 e §24.3. Métrica de bug, **nunca** fluxo de controle. */
export type FoldMetrics = {
  panic: number;
  hostTsClamped: number;
  propertyViolation: number;
  idCollision: number;
  applied: number;
  rejected: number;
  ignored: number;
  rejectedBy: Map<string, number>;
  ignoredBy: Map<string, number>;
};

export function newMetrics(): FoldMetrics {
  return {
    panic: 0,
    hostTsClamped: 0,
    propertyViolation: 0,
    idCollision: 0,
    applied: 0,
    rejected: 0,
    ignored: 0,
    rejectedBy: new Map(),
    ignoredBy: new Map(),
  };
}

export function countResult(m: FoldMetrics, r: FoldResult): void {
  if (r.hostTsClamped === true) m.hostTsClamped++;
  if (r.reason === 'E_ID_COLLISION') m.idCollision++;
  if (r.decision === 'APPLIED') {
    m.applied++;
    return;
  }
  const alvo = r.decision === 'REJECTED' ? m.rejectedBy : m.ignoredBy;
  if (r.decision === 'REJECTED') m.rejected++;
  else m.ignored++;
  const k = r.reason ?? 'unknown';
  alvo.set(k, (alvo.get(k) ?? 0) + 1);
}

const SEM_EFEITOS: readonly Effect[] = Object.freeze([]);

// ─── Bookkeeping de §8.2 ────────────────────────────────────────────────────────────────

type Bookkeeping = {
  readonly seq: number;
  /** `null` quando o registro não chegou ao estágio 6. */
  readonly stage6: { readonly authorHex: string; readonly scopeKey: string; readonly authorSeq: number } | null;
  /** `hostTs` já clampado, ou `null` quando o registro nem decodificou. */
  readonly hostTs: number | null;
  readonly partial: boolean;
  readonly opVersion: number | null;
  /**
   * R-15 — `null` quando o registro não chegou ao estágio 10. Quando chegou, a janela do
   * autor é consumida **mesmo que a recusa venha depois**.
   */
  readonly quota: { readonly authorHex: string; readonly bytes: number } | null;
  /**
   * R-27(c) — o registro é da gênese (`seq ≤ 5`) e foi `REJECTED`, por **qualquer** motivo.
   * A garantia que R-27 dá é "toda réplica marca `invalid` no mesmo `seq` e a comunidade fica
   * inútil"; um `seq ≤ 5` recusado deixa a gênese incompleta seja qual for o estágio que o
   * recusou, e sem a marca o cliente abre e entra no swarm de uma comunidade quebrada.
   * `IGNORED` fica de fora de propósito: versão ou `kind` desconhecido é `partialInterpretation`
   * (§7.2 regra 5), não desvio de forma — marcar `invalid` ali tornaria toda gênese futura
   * inválida para um binário antigo.
   */
  readonly genesisInvalid: boolean;
};

/**
 * O que §8.2 manda fazer em **todo** desfecho, inclusive `REJECTED` e `IGNORED`.
 *
 * `lastAuthorSeq[author, sequenceScope] = authorSeq` é aplicado como **`max`**: a leitura literal aplicada a
 * uma duplicata (que por definição tem `authorSeq ≤ lastAuthorSeq`) faria o contador
 * *retroceder*, e o replay que §7.5 fecha reabriria no registro seguinte. `max` é a única
 * leitura compatível com §7.5 ("ignora todo registro com `authorSeq ≤ lastAuthorSeq` no escopo"), e é a
 * que G1 exercitou em ~1,25 M entradas de replay sem uma regressão de contador.
 */
function bookkeep(prev: DecisionState, b: Bookkeeping): DecisionState {
  const d = new Draft(prev);
  d.setScalar('interpretedSeq', b.seq);
  if (b.genesisInvalid) d.setScalar('communityInvalid', true); // R-27(c), absorvente
  if (b.hostTs !== null && b.hostTs > prev.lastHostTs) d.setScalar('lastHostTs', b.hostTs);
  if (b.partial) d.setScalar('partialInterpretation', true);
  if (b.opVersion !== null && b.opVersion > prev.opVersionSeen) {
    d.setScalar('opVersionSeen', b.opVersion);
  }
  if (b.stage6 !== null) {
    const chave = authorSequenceKey(b.stage6.authorHex, b.stage6.scopeKey);
    const atual = prev.lastAuthorSeq.get(chave) ?? 0;
    if (b.stage6.authorSeq > atual) {
      d.lastAuthorSeq().set(chave, b.stage6.authorSeq);
    }
  }
  if (b.quota !== null) {
    const m = d.mutMember(b.quota.authorHex);
    if (m !== undefined) {
      // §8.1 declara dois `RingCounter` e R-15 descreve **uma** janela com dois tetos: um
      // contador só já carrega ops e bytes, então os dois campos apontam para a mesma janela.
      m.opBudget = ringAdd(m.opBudget, b.seq, b.quota.bytes);
      m.byteBudget = m.opBudget;
    }
  }
  d.touch();
  return d.finish();
}

/** Chave do watermark derivado do log, sem colisão entre escopos. */
export function authorSequenceKey(authorHex: string, scope: SequenceScope | string): string {
  const scopeKey = typeof scope === 'string' ? scope : sequenceScopeKey(scope);
  return `${authorHex}\u0000${scopeKey}`;
}

/**
 * §7.5 — os únicos `kind`s cujo `sequenceScope` é o **canal**; todo o resto é `community`.
 * Exportada porque a ponte de submissão precisa escolher o mesmo escopo que o `fold` exige:
 * duas listas seriam duas verdades, e a divergência só apareceria como `E_VALIDATION` no
 * host, depois de assinar.
 */
export const CHANNEL_SCOPED_KINDS: ReadonlySet<KindName> = new Set([
  'message.send',
  'message.edit',
  'message.delete',
  'message.pin',
  'reaction.set',
  'thread.create',
]);

/** Confere o namespace assinado antes de consultar o watermark do autor. */
function invalidSequenceScope(
  op: Op,
  kind: KindName,
  payload: Readonly<Record<string, unknown>>,
  state: DecisionState,
): boolean {
  if (!CHANNEL_SCOPED_KINDS.has(kind)) return op.sequenceScope.kind !== 'community';
  if (op.sequenceScope.kind !== 'channel') return true;

  // `message.send` carrega o canal **no próprio payload** (§7.1: "As seis operações de domínio
  // de mensagem enfileiráveis usam `channel(channelId)`"), então o alvo é comparado direto.
  // Passar por `state.messages` aqui — como este ramo já fez — nunca casa: um `channelId` não é
  // id de mensagem, o lookup dava `undefined` e o escopo declarado jamais era conferido.
  if (kind === 'message.send') {
    const channelId = payload['channelId'];
    return typeof channelId !== 'string' || channelId !== op.sequenceScope.channelId;
  }

  // Os outros cinco carregam o escopo "que o `fold` confere contra o alvo" (§7.1). Alvo que o
  // `DS` não conhece não tem canal a comparar: o estágio 14 devolve `E_NOT_FOUND`, e recusar
  // aqui esconderia o erro que a UI sabe explicar.
  const targetId = kind === 'thread.create' ? payload['rootMessageId'] : payload['messageId'];
  if (typeof targetId !== 'string') return false;
  const target = state.messages.get(targetId);
  return target !== undefined && target.channelId !== op.sequenceScope.channelId;
}

// ─── R-27 — forma do lote de gênese ─────────────────────────────────────────────────────

/** R-27: `community.create · role.create · role.create · member.join · category.create · channel.create`. */
const GENESIS_SHAPE: readonly KindName[] = [
  'community.create',
  'role.create',
  'role.create',
  'member.join',
  'category.create',
  'channel.create',
];

/**
 * R-27(b) — o cargo base do `seq` 2 carrega um subconjunto desta lista. R-11 vale desde a
 * criação, e §19.1 nomeia os quatro que o cargo base recebe de fábrica; `pin_messages` é o
 * único a mais que ele *pode* receber.
 */
const GENESIS_BASE_ROLE_ALLOWED: ReadonlySet<Permission> = new Set<Permission>([
  'send_messages',
  'attach_files',
  'add_reactions',
  'voice_speak',
  'pin_messages',
]);

/**
 * R-27(c) — **verificação por registro, sem retroação**. A assinatura de §8.0 é por registro,
 * sem lookahead: no `seq` k o `fold` ainda não viu k+1..5. Cada registro é conferido contra a
 * posição que R-27 exige **dele**; o desvio marca a comunidade `invalid` e, a partir daí, todo
 * registro — inclusive os restantes da gênese e todo `seq ≥ 6` — é `REJECTED`. Registros de
 * `seq` menor já `APPLIED` **não** são revogados: toda réplica marca `invalid` no **mesmo**
 * `seq`, então a comunidade fica inútil de forma idêntica em todo lugar, sem divergência.
 */
function genesisViolation(
  state: DecisionState,
  op: Op,
  seq: number,
  authorHex: string,
  payload: Readonly<Record<string, unknown>>,
): boolean {
  const esperado = GENESIS_SHAPE[seq];
  if (esperado === undefined) return false;
  if (op.kind !== KINDS[esperado]) return true;
  if (op.authorSeq !== seq + 1) return true;
  // O `seq` 0 **define** `founderKey`; de 1 a 5 o autor precisa ser o mesmo.
  if (seq !== 0 && authorHex !== state.community.founderKey.toString('hex')) return true;

  // R-27(b) — forma dos payloads.
  if (seq === 1 || seq === 2) {
    const brutas = payload['permissions'];
    if (!Array.isArray(brutas)) return true;
    const perms = new Set<Permission>();
    for (const n of brutas as number[]) {
      const p = permissionFromNumber(n);
      if (p === null) return true;
      perms.add(p);
    }
    if (seq === 1) {
      // O cargo Fundador carrega **exatamente as 17**.
      if (perms.size !== ALL_PERMISSIONS.length) return true;
      for (const p of ALL_PERMISSIONS) if (!perms.has(p)) return true;
    } else {
      for (const p of perms) if (!GENESIS_BASE_ROLE_ALLOWED.has(p)) return true;
    }
  }
  return false;
}

// ─── O pipeline ─────────────────────────────────────────────────────────────────────────

function roleLookupOf(state: DecisionState): RoleLookup {
  return (id) => {
    const r = state.roles.get(id);
    if (r === undefined || r.deletedAt !== undefined) return undefined;
    const perms: Permission[] = [];
    for (const n of r.permissions) {
      const p = permissionFromNumber(n);
      if (p !== null) perms.push(p);
    }
    return { id, rank: r.rank, permissions: perms, isFounder: r.isFounder, isDefault: r.isDefault };
  };
}

/** Estágio 11 — a permissão exigida pelo `kind`, com os casos condicionais de §7.4. */
function permissionDenial(
  regra: PermRule,
  ctx: { eff: ReadonlySet<Permission>; op: Op; authorHex: string; state: DecisionState; payload: Readonly<Record<string, unknown>> },
): ErrorCode | null {
  switch (regra.r) {
    case 'none':
      return null;
    case 'perm':
      return ctx.eff.has(regra.perm) ? null : 'E_PERMISSION_DENIED';
    case 'permPlusAttachment': {
      if (!ctx.eff.has(regra.perm)) return 'E_PERMISSION_DENIED';
      const temAnexo = ctx.payload['attachment'] !== undefined;
      if (temAnexo && !ctx.eff.has(regra.comAnexo)) return 'E_PERMISSION_DENIED';
      return null;
    }
    case 'ownOrPerm': {
      // "própria | manage_messages": a permissão só é exigida quando a mensagem é de outro.
      const id = ctx.payload['messageId'];
      const msg = typeof id === 'string' ? ctx.state.messages.get(id) : undefined;
      if (msg !== undefined && msg.authorKey === ctx.authorHex) return null;
      return ctx.eff.has(regra.perm) ? null : 'E_PERMISSION_DENIED';
    }
    case 'inviteOwnerOrPerm': {
      const pk = ctx.payload['invitePublicKey'];
      const inv = Buffer.isBuffer(pk) ? ctx.state.invites.get(pk.toString('hex')) : undefined;
      if (inv !== undefined && inv.createdBy.toString('hex') === ctx.authorHex) return null;
      return ctx.eff.has(regra.perm) ? null : 'E_PERMISSION_DENIED';
    }
    case 'host':
      // R-17 — só o `hostKey` corrente. O código é `E_NOT_HOST`, não `E_PERMISSION_DENIED`.
      return ctx.authorHex === ctx.state.community.hostKey.toString('hex') ? null : 'E_NOT_HOST';
    case 'successor':
      // R-18 é regra estrutural (estágio 14): a prova é criptográfica, não uma permissão.
      return null;
  }
}

function foldRecordInner(prev: DecisionState, rec: RawRecord, seq: number, probe: OpProbe): FoldResult {
  // ── Estágio 0 — teto de bytes, ANTES de qualquer decode ou Ed25519 (fecha `HOLE-04`) ──
  // §14.4 impõe teto no **transporte**, e o host adversário de §1.4 não passa pelo
  // transporte: ele appenda direto. Custo O(1), e impede que um prefixo de tamanho hostil
  // faça o decodificador alocar antes de concluir que a entrada é malformada.
  if (rec.length > MAX_ENVELOPE_BYTES_ATTACHMENT) {
    return {
      decision: 'REJECTED',
      reason: 'E_PAYLOAD_TOO_LARGE',
      effects: SEM_EFEITOS,
      next: bookkeep(prev, {
        seq,
        stage6: null,
        hostTs: null,
        partial: false,
        opVersion: null,
        quota: null,
        genesisInvalid: seq <= GENESIS_LAST_SEQ,
      }),
    };
  }

  const ignorado = (reason: ErrorCode, partial: boolean, hostTs: number | null): FoldResult => ({
    decision: 'IGNORED',
    reason,
    effects: SEM_EFEITOS,
    next: bookkeep(prev, {
      seq,
      stage6: null,
      hostTs: hostTs === null ? null : Math.max(hostTs, prev.lastHostTs),
      partial,
      opVersion: null,
      quota: null,
      genesisInvalid: false, // `IGNORED` não é desvio de forma — ver `Bookkeeping.genesisInvalid`
    }),
  });

  // ── Estágio 1 — `HostRecord` decodifica; `hostSig` válida sobre a chave do core ───────
  const hr = decodeHostRecord(rec);
  if (hr === null) return ignorado('E_BAD_HOST_SIGNATURE', false, null);
  const digestHost = hostRecordSigningHash(hr.envelope, hr.hostTs, hr.flags);
  if (!verifySignature(hr.hostSig, digestHost, prev.communityKey)) {
    return ignorado('E_BAD_HOST_SIGNATURE', false, null);
  }

  // ── Estágio 2 — `Envelope`/`Op` decodificam; `v` e `kind` conhecidos; payload casa §7.4 ─
  const env = decodeEnvelope(hr.envelope);
  if (env === null) return ignorado('E_MALFORMED', false, hr.hostTs);
  const op = decodeOp(env.op);
  if (op === null) return ignorado('E_MALFORMED', false, hr.hostTs);
  // §8.0/§8.2 — a fronteira de diagnóstico. Daqui em diante **todo** desfecho carrega `kind` e
  // `author`; antes daqui ninguém tem como saber quais são, e é por isso que
  // `rejected_records.kind`/`.author_key` são anuláveis (§10.3). O `kind` é gravado mesmo
  // quando desconhecido deste binário: é o que permite diagnosticar de qual versão ele veio.
  probe.kind = op.kind;
  probe.author = op.author;
  // §7.2 regra 5: versão desconhecida liga `partialInterpretation`, que bloqueia escrita
  // local com `E_VERSION_UNSUPPORTED` — mas **não** para a projeção.
  if (!isSupportedVersion(op.v)) return ignorado('E_VERSION_UNSUPPORTED', true, hr.hostTs);
  if (!isKnownKind(op.kind)) return ignorado('E_UNKNOWN_KIND', true, hr.hostTs);
  const nome = kindName(op.kind);
  if (nome === null) return ignorado('E_UNKNOWN_KIND', true, hr.hostTs);
  const payload = decodePayload(nome, op.payload) as Readonly<Record<string, unknown>> | null;
  if (payload === null) return ignorado('E_MALFORMED', false, hr.hostTs);

  // A partir daqui o registro é interpretável, e o clamp de R-1 vale para o resto.
  const hostTs = Math.max(hr.hostTs, prev.lastHostTs);
  const clamped = hr.hostTs < prev.lastHostTs;
  const authorHex = op.author.toString('hex');

  /**
   * R-15 — passa a `true` quando o registro **atravessa** o estágio 10. A partir daí a
   * janela do autor é consumida em qualquer desfecho: recusar num estágio posterior não
   * devolve a cota, pela mesma razão de §7.5 ("uma op recusada antes do append queima o
   * número"). Sem isso, um autor inunda o log com ops que falham tarde e não paga nada.
   */
  let consumiuCota = false;

  const recusa = (code: ErrorCode, extra?: { field?: string; limit?: number }, stage6 = false): FoldResult => {
    const r: {
      decision: 'REJECTED';
      reason: ErrorCode;
      field?: string;
      limit?: number;
      hostTsClamped: boolean;
      effects: readonly Effect[];
      next: DecisionState;
    } = {
      decision: 'REJECTED',
      reason: code,
      hostTsClamped: clamped,
      effects: SEM_EFEITOS,
      next: bookkeep(prev, {
        seq,
        stage6: stage6
          ? { authorHex, scopeKey: sequenceScopeKey(op.sequenceScope), authorSeq: op.authorSeq }
          : null,
        hostTs,
        partial: false,
        opVersion: op.v,
        quota: consumiuCota ? { authorHex, bytes: op.payload.length } : null,
        // R-27(c) — recusa em `seq ≤ 5` é gênese fora da forma, venha do estágio que vier.
        genesisInvalid: seq <= GENESIS_LAST_SEQ,
      }),
    };
    if (extra?.field !== undefined) r.field = extra.field;
    if (extra?.limit !== undefined) r.limit = extra.limit;
    return r;
  };

  // ── Estágio 3 — `op.communityId === state.communityId` ────────────────────────────────
  if (!op.communityId.equals(prev.communityKey)) return recusa('E_WRONG_COMMUNITY');

  // ── Estágio 4 — `sig` válida sobre `BLAKE2b('op/1' ‖ op)` com `op.author` ─────────────
  if (!verifySignature(env.sig, opSigningHash(env.op), op.author)) return recusa('E_BAD_SIGNATURE');

  // ── Estágio 5 — clamp de `hostTs` (acima) e comunidade não `ended` ────────────────────
  if (prev.community.endedAt !== undefined && op.kind !== KINDS['community.end']) {
    return recusa('E_COMMUNITY_ENDED');
  }

  // ── Estágio 6 — `authorSeq > lastAuthorSeq[author, sequenceScope]` ─────────────────────
  // `E_DUPLICATE` é **sucesso** do ponto de vista do cliente (§11.6, §20.3.7).
  if (invalidSequenceScope(op, nome, payload, prev)) {
    return recusa('E_VALIDATION', { field: 'sequenceScope' });
  }
  const scopeKey = sequenceScopeKey(op.sequenceScope);
  const authorScopeKey = authorSequenceKey(authorHex, scopeKey);
  if (op.authorSeq <= (prev.lastAuthorSeq.get(authorScopeKey) ?? 0)) return recusa('E_DUPLICATE');

  // ── Estágio 7 — `|op.ts − hostTs| ≤ CLOCK_ACCEPT_MS` (R-2, sobre o `hostTs` efetivo) ──
  if (Math.abs(op.ts - hostTs) > CLOCK_ACCEPT_MS) return recusa('E_CLOCK_UNREASONABLE', undefined, true);

  // ── R-27 — forma do lote de gênese ────────────────────────────────────────────────────
  // Avaliada aqui porque é o que decide se o **principal de gênese** de R-27(a) está em vigor,
  // e os estágios 8 a 12 dependem disso.
  const inGenesis = seq <= GENESIS_LAST_SEQ && !prev.communityInvalid;
  if (seq <= GENESIS_LAST_SEQ) {
    if (prev.communityInvalid || genesisViolation(prev, op, seq, authorHex, payload)) {
      const d = new Draft(prev);
      d.setScalar('communityInvalid', true); // absorvente
      d.setScalar('interpretedSeq', seq);
      if (hostTs > prev.lastHostTs) d.setScalar('lastHostTs', hostTs);
      if (op.v > prev.opVersionSeen) d.setScalar('opVersionSeen', op.v);
      const atual = prev.lastAuthorSeq.get(authorScopeKey) ?? 0;
      if (op.authorSeq > atual) d.lastAuthorSeq().set(authorScopeKey, op.authorSeq);
      d.touch();
      return {
        decision: 'REJECTED',
        reason: 'E_GENESIS_MISPLACED',
        hostTsClamped: clamped,
        effects: SEM_EFEITOS,
        next: d.finish(),
      };
    }
  } else if (prev.communityInvalid) {
    // R-27(c): a partir do desvio, **todo** registro é recusado. §8.4.1 nomeia o código de um
    // `seq ≥ 6` numa comunidade cuja gênese caiu: `E_NOT_MEMBER` — não há membro nenhum.
    return recusa('E_NOT_MEMBER', undefined, true);
  } else if (op.kind === KINDS['community.create']) {
    // §8.4.1: `community.create` em `seq ≠ 0` é gênese fora de lugar.
    return recusa('E_GENESIS_MISPLACED', undefined, true);
  }

  const member = prev.members.get(authorHex);

  // ── Estágio 8 — autor é membro ativo não banido ───────────────────────────────────────
  // Exceção: `member.join` (o autor é o candidato). Durante a gênese o principal de R-27(a)
  // satisfaz este estágio **por construção**; não há suspensão.
  if (op.kind !== KINDS['member.join']) {
    if (!inGenesis && member?.state === 'banned') return recusa('E_BANNED', undefined, true);
    if (!inGenesis && member?.state !== 'active') return recusa('E_NOT_MEMBER', undefined, true);
  }

  // ── Estágio 9 — sem timeout ativo, exceto `member.leave` ──────────────────────────────
  // §6.12: o timeout expira **sozinho**, por `until > hostTs do registro corrente` — nunca
  // pelo relógio de quem lê. É o que fecha `T-45`: réplicas não divergem.
  if (member !== undefined && op.kind !== KINDS['member.leave']) {
    if (member.timeoutUntil !== undefined && member.timeoutUntil > hostTs) {
      return recusa('E_TIMED_OUT', undefined, true);
    }
  }

  // ── Estágio 10 — cotas determinísticas do autor (R-14, R-15) ──────────────────────────
  if (member !== undefined && op.kind !== KINDS['member.join']) {
    // R-15 vale para todos exceto `member.join`.
    if (ringWouldExceed(member.opBudget, seq, op.payload.length) !== null) {
      return recusa('E_QUOTA_EXCEEDED', undefined, true);
    }
    // R-14 (cota de anexo por membro) **não existe mais** desde `opVersion = 3` — §13.8,
    // emenda de 2026-09-04. Este estágio ficou só com R-15, que é a defesa por volume de
    // registro; o tamanho do anexo segue sendo conferido no estágio 13, contra o teto de
    // representação de `ATTACHMENT_MAX_BYTES`. `member.storageUsedBytes` continua acumulando
    // em `apply` porque virou medidor de uso exibido em `query.member`, não fronteira.
    // O registro atravessou o estágio 10: daqui em diante a cota é dele, com ou sem recusa.
    consumiuCota = true;
  }

  const roles = roleLookupOf(prev);
  // R-27(a): na gênese o principal carrega as 17 permissões e o topo sentinela. `RANK_GENESIS`
  // vale **só** nos `seq` 0..5, não é gravado no `DS` nem em `view.db`, e nunca é `rank` de cargo.
  const eff: ReadonlySet<Permission> = inGenesis
    ? new Set(ALL_PERMISSIONS)
    : member !== undefined
      ? effectivePermissions([...member.roleIds], roles)
      : new Set<Permission>();
  const authorTop = inGenesis
    ? RANK_GENESIS
    : member !== undefined
      ? topRank([...member.roleIds], roles)
      : null;

  const policy: KindPolicy | undefined = policyOf(op.kind);
  if (policy === undefined) return recusa('E_UNKNOWN_KIND', undefined, true); // §9.4, falha fechado

  // ── Estágio 11 — permissão do `kind` (§9.4) ───────────────────────────────────────────
  // Sem suspensão: na gênese `eff` é o conjunto do principal de R-27(a).
  const negada = permissionDenial(policy.perm, { eff, op, authorHex, state: prev, payload });
  if (negada !== null) return recusa(negada, undefined, true);

  // ── Estágio 12 — hierarquia sobre o alvo, quando aplicável (§9.3) ─────────────────────
  // Sem suspensão: na gênese `authorTop` é `RANK_GENESIS`, acima de qualquer `rank`.
  const alvo = hierarchyTargetOf(op.kind, payload, prev, authorHex, authorTop);
  if (alvo.applies) {
    const ctxAutoridade = policy.hier
      ? alvo.ctx
      : // Coluna `Hier.` = `—`: as **imunidades** de §9.3 (passos 1 e 2) continuam valendo —
        // R-16 fala de `mod.*` inteiro —, mas a comparação de `rank` do passo 3 não roda.
        { ...alvo.ctx, authorTopRank: RANK_GENESIS, targetTopRank: null };
    const recusaAutoridade = authorizeOverTarget(ctxAutoridade);
    if (recusaAutoridade !== null) return recusa(recusaAutoridade, undefined, true);
  }

  // ── Estágio 13 (parte de registro) — o teto condicional de §8.6 ───────────────────────
  // O estágio 0 aplicou o teto **absoluto** (64 KiB). Só aqui se sabe se há anexo, e um
  // registro sem anexo tem teto de 32 KiB.
  const temAnexo = op.kind === KINDS['message.send'] && payload['attachment'] !== undefined;
  if (!temAnexo && rec.length > MAX_ENVELOPE_BYTES) {
    return recusa('E_PAYLOAD_TOO_LARGE', undefined, true);
  }

  // ── Estágios 13, 14 e 15 — limites de campo, regras estruturais, efeitos ──────────────
  const draft = new Draft(prev);
  const effects: Effect[] = [];
  const ctx: KindCtx = {
    seq,
    hostTs,
    op,
    authorHex,
    draft,
    inGenesis,
    effects,
    eff,
    authorTop,
    member,
    policy,
  };
  const rejeicao: Rejection | null = applyKind(ctx, payload);
  if (rejeicao !== null) {
    const extra: { field?: string; limit?: number } = {};
    if (rejeicao.field !== undefined) extra.field = rejeicao.field;
    if (rejeicao.limit !== undefined) extra.limit = rejeicao.limit;
    return recusa(rejeicao.code, extra, true);
  }

  // Bookkeeping do estágio final, agora sobre o rascunho já avançado.
  draft.setScalar('interpretedSeq', seq);
  if (hostTs > prev.lastHostTs) draft.setScalar('lastHostTs', hostTs);
  if (op.v > prev.opVersionSeen) draft.setScalar('opVersionSeen', op.v);
  const atual = draft.state.lastAuthorSeq.get(authorScopeKey) ?? 0;
  if (op.authorSeq > atual) draft.lastAuthorSeq().set(authorScopeKey, op.authorSeq);

  // R-15 — o registro admitido consome a janela do autor. `member.join` fica de fora, e é o
  // caminho pelo qual `consumiuCota` chega aqui em `false`.
  if (consumiuCota) {
    const m = draft.mutMember(authorHex);
    if (m !== undefined) {
      m.opBudget = ringAdd(m.opBudget, seq, op.payload.length);
      m.byteBudget = m.opBudget;
    }
  }
  draft.touch();

  return {
    decision: 'APPLIED',
    hostTsClamped: clamped,
    effects,
    next: draft.finish(),
    opId: opId(hr.envelope),
    authorSeq: op.authorSeq,
    sequenceScope: op.sequenceScope,
  };
}

/**
 * §8.5 item 3 — a rede de segurança.
 *
 * Uma exceção lançada de dentro do `fold` é **bug de implementação de severidade máxima**.
 * Ela não é o comportamento pretendido: existe para que um bug nunca vire perda de
 * comunidade. O registro é tratado como `IGNORED`, `fold.panic{seq}` é contado, e a
 * interpretação **continua**. §28.1 exige um fuzzer dedicado a provar que este `catch` nunca
 * é acionado — `fold.panic` precisa ser 0 em 10⁷ entradas hostis.
 */
export function foldRecord(
  prev: DecisionState,
  rec: RawRecord,
  seq: number,
  metrics?: FoldMetrics,
): FoldResult {
  const probe: OpProbe = {};
  try {
    const r = withProbe(foldRecordInner(prev, rec, seq, probe), probe);
    if (metrics !== undefined) countResult(metrics, r);
    return r;
  } catch (err) {
    lastPanic = { seq, err: err instanceof Error ? (err.stack ?? err.message) : String(err) };
    if (metrics !== undefined) {
      metrics.panic++;
      metrics.ignored++;
    }
    // §8.5 — o `kind` da métrica sai daqui: presente quando a exceção veio **depois** do
    // decode do `Op`, ausente quando veio antes dele.
    return withProbe(
      {
        decision: 'IGNORED',
        reason: 'E_MALFORMED',
        effects: SEM_EFEITOS,
        next: bookkeep(prev, {
          seq,
          stage6: null,
          hostTs: null,
          partial: false,
          opVersion: null,
          quota: null,
          genesisInvalid: false, // pânico é `IGNORED`, não desvio de forma
        }),
      },
      probe,
    );
  }
}

export let lastPanic: { seq: number; err: string } | null = null;

export function clearPanic(): void {
  lastPanic = null;
}
