// Gerado a partir de `docs/backend-v2.md` §20.2 — não editar à mão.
// O catálogo é fonte única (§20.2): nenhum código existe fora desta tabela.
//
// §4: este módulo é L1, não depende de ninguém e **não pode conter texto em português**.
// Os comentários explicam; `message` é inglês porque §20.1 manda — o texto para o usuário
// é do renderer.

/** Classe do erro, coluna "Classe" de §20.2. */
export type ErrorClass =
  | 'client'
  | 'security'
  | 'idempotency'
  | 'authorization'
  | 'rule'
  | 'state'
  | 'conflict'
  | 'validation'
  | 'protection'
  | 'network'
  | 'infra'
  | 'batch'
  | 'compat'
  | 'bug';

/**
 * Coluna "R" de §20.2 — se a outbox retenta.
 *
 * - `no`          — terminal para a outbox.
 * - `yes`         — retenta com o backoff de §22.3.
 * - `after-until` — só `E_TIMED_OUT`: retenta depois do `until` do timeout.
 * - `once`        — só `E_INTERNAL`: uma única retentativa.
 * - `n/a`         — só `E_DUPLICATE`, que é sucesso para o cliente e não entra na fila.
 */
export type RetryPolicy = 'no' | 'yes' | 'after-until' | 'once' | 'n/a';

export type ErrorSpec = {
  readonly class: ErrorClass;
  /** Equivalente HTTP de §20.2. Documental: não há HTTP no caminho de dado. */
  readonly http: number;
  readonly retry: RetryPolicy;
  /** §20.1: inglês, para log e depuração. */
  readonly message: string;
};

/** O catálogo fechado de §20.2, na ordem da tabela. 92 códigos. */
export const ERROR_CATALOG = {
  E_MALFORMED:                    { class: 'client', http: 400, retry: 'no', message: "frame or payload does not decode" },
  E_VALIDATION:                   { class: 'client', http: 400, retry: 'no', message: "field outside the limits of §8.6" },
  E_UNKNOWN_COMMAND:              { class: 'client', http: 404, retry: 'no', message: "IPC command does not exist" },
  E_UNKNOWN_KIND:                 { class: 'client', http: 400, retry: 'no', message: "unknown op kind" },
  E_BAD_CURSOR:                   { class: 'client', http: 400, retry: 'no', message: "cursor is invalid or belongs to another scope" },
  E_BAD_SIGNATURE:                { class: 'security', http: 401, retry: 'no', message: "author signature is invalid" },
  E_BAD_HOST_SIGNATURE:           { class: 'security', http: 401, retry: 'no', message: "hostSig is invalid" },
  E_WRONG_COMMUNITY:              { class: 'security', http: 400, retry: 'no', message: "op.communityId does not match the core" },
  E_AUTHOR_MISMATCH:              { class: 'security', http: 401, retry: 'no', message: "op.author does not match the peer key" },
  E_DUPLICATE:                    { class: 'idempotency', http: 200, retry: 'n/a', message: "authorSeq already seen — success for the client" },
  E_AUTHOR_SEQ_OVERTAKEN:         { class: 'bug', http: 409, retry: 'no', message: "sequence scope advanced without the corresponding opId" },
  E_NOT_MEMBER:                   { class: 'authorization', http: 403, retry: 'no', message: "author is not an active member" },
  E_BANNED:                       { class: 'authorization', http: 403, retry: 'no', message: "author is banned" },
  E_TIMED_OUT:                    { class: 'authorization', http: 403, retry: 'after-until', message: "timeout is active" },
  E_PERMISSION_DENIED:            { class: 'authorization', http: 403, retry: 'no', message: "missing permission" },
  E_HIERARCHY:                    { class: 'authorization', http: 403, retry: 'no', message: "target rank is greater than or equal to the author rank" },
  E_FOUNDER_IMMUNE:               { class: 'authorization', http: 403, retry: 'no', message: "target is the Founder" },
  E_HOST_IMMUNE:                  { class: 'authorization', http: 403, retry: 'no', message: "target is the current host" },
  E_SELF_TARGET:                  { class: 'authorization', http: 403, retry: 'no', message: "moderation against self" },
  E_FOUNDER_IMMUTABLE:            { class: 'authorization', http: 403, retry: 'no', message: "the Founder role is not editable" },
  E_FOUNDER_TOP:                  { class: 'authorization', http: 403, retry: 'no', message: "the Founder is always at the top" },
  E_PERMISSION_ESCALATION:        { class: 'authorization', http: 403, retry: 'no', message: "granting a permission the author does not hold (R-5)" },
  E_BASE_ROLE_REQUIRED:           { class: 'rule', http: 409, retry: 'no', message: "base role is mandatory and cannot be deleted or have its rank modified" },
  E_BASE_ROLE_RESTRICTED:         { class: 'security', http: 403, retry: 'no', message: "permission is forbidden on the base role (R-11)" },
  E_NOT_HOST:                     { class: 'authorization', http: 403, retry: 'no', message: "only the host may do this" },
  E_HOST_CANNOT_LEAVE:            { class: 'rule', http: 409, retry: 'no', message: "the host ends or succeeds, it does not leave" },
  E_NICKNAME_SELF_ONLY:           { class: 'rule', http: 403, retry: 'no', message: "a nickname is self-assigned" },
  E_CANNOT_EDIT_OTHERS:           { class: 'rule', http: 403, retry: 'no', message: "moderation deletes, it does not rewrite" },
  E_NOT_FOUND:                    { class: 'state', http: 404, retry: 'no', message: "not found" },
  E_CHANNEL_NOT_FOUND:            { class: 'state', http: 404, retry: 'no', message: "channel is gone" },
  E_CHANNEL_NOT_VOICE:            { class: 'state', http: 409, retry: 'no', message: "wrong channel type for voice" },
  E_CATEGORY_NOT_FOUND:           { class: 'state', http: 404, retry: 'no', message: "category not found" },
  E_MESSAGE_DELETED:              { class: 'state', http: 409, retry: 'no', message: "message was deleted" },
  E_COMMUNITY_ENDED:              { class: 'state', http: 410, retry: 'no', message: "community has ended" },
  E_NOT_BANNED:                   { class: 'state', http: 409, retry: 'no', message: "revoking a ban that does not exist" },
  E_CHANNEL_NAME_TAKEN:           { class: 'conflict', http: 409, retry: 'no', message: "duplicate channel name (R-6)" },
  E_CHANNEL_NAME_EMPTY:           { class: 'validation', http: 400, retry: 'no', message: "slug is empty after normalization" },
  E_LAST_CHANNEL:                 { class: 'rule', http: 409, retry: 'no', message: "last channel (R-7)" },
  E_THREAD_EXISTS:                { class: 'conflict', http: 409, retry: 'no', message: "a thread already exists on this root" },
  E_REACTION_LIMIT:               { class: 'rule', http: 409, retry: 'no', message: "more than 20 distinct emojis" },
  E_CHANNEL_READ_ONLY:            { class: 'authorization', http: 403, retry: 'no', message: "channel is read-only for the author roles" },
  E_LIMIT_EXCEEDED:               { class: 'rule', http: 409, retry: 'no', message: "cardinality limit of §26.2 exceeded" },
  E_QUOTA_EXCEEDED:               { class: 'protection', http: 429, retry: 'yes', message: "deterministic quota exceeded (R-14/R-15)" },
  E_INVITE_INVALID:               { class: 'state', http: 404, retry: 'no', message: "invite is invalid, revoked or expired" },
  E_INVITE_EXHAUSTED:             { class: 'state', http: 409, retry: 'no', message: "invite maxUses reached" },
  E_ATTACHMENT_TOO_LARGE:         { class: 'validation', http: 413, retry: 'no', message: "attachment above ATTACHMENT_MAX_BYTES" },
  E_PAYLOAD_TOO_LARGE:            { class: 'validation', http: 413, retry: 'no', message: "envelope above the ceiling" },
  E_FILE_UNREADABLE:              { class: 'infra', http: 400, retry: 'no', message: "local file is unreadable" },
  E_TICKET_INVALID:               { class: 'security', http: 403, retry: 'no', message: "staging or media ticket is invalid or expired" },
  E_TICKET_DENIED:                { class: 'authorization', http: 403, retry: 'no', message: "host refused to issue a media ticket" },
  E_TYPE_NOT_OPENABLE:            { class: 'security', http: 403, retry: 'no', message: "type is outside the allowlist of §13.6" },
  E_NOT_DOWNLOADED:               { class: 'state', http: 409, retry: 'no', message: "opening before downloading" },
  E_NO_PEERS:                     { class: 'network', http: 503, retry: 'yes', message: "no peers hold the blob" },
  E_RATE_LIMITED:                 { class: 'protection', http: 429, retry: 'yes', message: "rate limited" },
  E_OUTBOX_FULL:                  { class: 'protection', http: 429, retry: 'no', message: "outbox is full" },
  E_ALREADY_SENT:                 { class: 'state', http: 409, retry: 'no', message: "cancelling an item already in flight" },
  E_HOST_UNAVAILABLE:             { class: 'network', http: 503, retry: 'yes', message: "host is offline or unreachable" },
  E_SWARM_DEGRADED:               { class: 'network', http: 503, retry: 'yes', message: "no bootstrap or peers" },
  E_PEER_UNREACHABLE:             { class: 'network', http: 503, retry: 'yes', message: "signalling did not arrive" },
  E_TIMEOUT:                      { class: 'network', http: 504, retry: 'yes', message: "deadline exceeded" },
  E_BUSY:                         { class: 'protection', http: 429, retry: 'yes', message: "host queue full or maximum concurrency reached" },
  E_NOT_ATTEMPTED:                { class: 'batch', http: 202, retry: 'yes', message: "the host did not get to this submitOps item; it stays queued (§11.9)" },
  E_NOT_AUTHORIZED_FOR_COMMUNITY: { class: 'authorization', http: 403, retry: 'no', message: "replication channel refused (§14.3)" },
  E_SESSION_GONE:                 { class: 'state', http: 410, retry: 'no', message: "media session is over" },
  E_ALREADY_SHARING:              { class: 'conflict', http: 409, retry: 'no', message: "you are already sharing on this channel" },
  E_QUEUE_CLOSED:                 { class: 'state', http: 409, retry: 'no', message: "the karaoke queue is closed (§16.4)" },
  E_DEVICE_BLOCKED:               { class: 'infra', http: 403, retry: 'no', message: "the OS denied microphone or camera" },
  E_CONSENT_REQUIRED:             { class: 'rule', http: 403, retry: 'no', message: "relay without consent" },
  E_VERSION_UNSUPPORTED:          { class: 'compat', http: 426, retry: 'no', message: "incompatible opVersion — terminal in the outbox" },
  E_CLOCK_UNREASONABLE:           { class: 'validation', http: 400, retry: 'no', message: "op.ts outside the window (R-2)" },
  E_GENESIS_MISPLACED:            { class: 'rule', http: 409, retry: 'no', message: "community.create outside seq 0" },
  E_ID_COLLISION:                 { class: 'bug', http: 500, retry: 'no', message: "deterministic id collision" },
  E_SUCCESSION_DENIED:            { class: 'authorization', http: 403, retry: 'no', message: "host assumption is not authorized (R-18)" },
  E_IDENTITY_EXISTS:              { class: 'conflict', http: 409, retry: 'no', message: "an identity already exists" },
  E_BAD_PASSPHRASE:               { class: 'client', http: 401, retry: 'no', message: "wrong import passphrase" },
  E_CANCELLED:                    { class: 'client', http: 499, retry: 'no', message: "the user cancelled the OS dialog" },
  E_BLOB_NOT_STAGED:              { class: 'rule', http: 409, retry: 'no', message: "attachment sent before blob.stage finished (§13.7)" },
  E_KEYSTORE_UNAVAILABLE:         { class: 'infra', http: 500, retry: 'no', message: "safeStorage is unavailable" },
  E_KEYSTORE_INSECURE:            { class: 'security', http: 500, retry: 'no', message: "basic_text fallback without explicit acceptance (§3.2 L-2)" },
  E_CORE_ALREADY_RUNNING:         { class: 'infra', http: 409, retry: 'no', message: "lock is held" },
  E_CORE_RESTARTED:               { class: 'infra', http: 503, retry: 'no', message: "request lost to a core crash (§15.2)" },
  E_CORE_CORRUPT:                 { class: 'infra', http: 500, retry: 'no', message: "core is unreadable" },
  E_SCHEMA_AHEAD:                 { class: 'infra', http: 500, retry: 'no', message: "database is from a future version" },
  E_STORAGE_FULL:                 { class: 'infra', http: 507, retry: 'no', message: "disk is full" },
  E_WIPE_INCOMPLETE:              { class: 'infra', http: 500, retry: 'no', message: "identity.wipe is partial (§18.6)" },
  E_INTERNAL:                     { class: 'bug', http: 500, retry: 'once', message: "unclassified" },
  // §31.17 — os quatro da conversa direta (§20.2, emenda de 2026-09-01). Nenhum código
  // existente descrevia a condição; três outras condições de §31 deliberadamente NÃO ganharam
  // código: conversa consigo mesmo é `E_VALIDATION.peerKey`, pendentes demais é
  // `E_LIMIT_EXCEEDED` com `limit`, e registro de outra conversa é `E_WRONG_COMMUNITY`.
  E_DM_BLOCKED:                   { class: 'state', http: 409, retry: 'no', message: "the direct conversation is blocked on this installation" },
  E_DM_FORKED:                    { class: 'state', http: 409, retry: 'no', message: "own DM core is forked or desynced — writing would fork it" },
  E_DM_CORE_MISMATCH:             { class: 'security', http: 403, retry: 'no', message: "peer announced a core key different from the one already bound" },
  E_DM_NOT_AUTHORIZED:            { class: 'authorization', http: 403, retry: 'no', message: "DM channel refused: wrong peer, blocked, or contact policy" },
  // §20.2, emenda de 2026-09-05 — os dois que as regras novas de §3.2 L-2 e §10.8 passaram
  // a poder devolver. Ambos param o boot: são condições em que abrir seria pior que recusar.
  E_KEYSTORE_MODE_CHANGED:        { class: 'infra', http: 500, retry: 'no', message: "the Data Key is wrapped in secure mode and the current vault is the insecure one (§3.2 L-2)" },
  E_CORE_LOCK_UNAVAILABLE:        { class: 'infra', http: 500, retry: 'no', message: "the exclusive lock of §10.8(2) could not be attempted" },
} as const satisfies Record<string, ErrorSpec>;

/** Todo código de erro do contrato. Nada fora daqui atravessa uma fronteira. */
export type ErrorCode = keyof typeof ERROR_CATALOG;

export const ERROR_CODES = Object.keys(ERROR_CATALOG) as readonly ErrorCode[];
