// Limites de campo e normalização — §8.6, tabela única e autoritativa. Estágio 13.
//
// **Unidade de contagem:** code points (escalares Unicode), nunca grafemas. Este módulo não
// chama `Intl.Segmenter` e não pode passar a chamar: grafema é definido pela tabela de
// segmentação do ICU do runtime, que tem versão, muda com o Node/Electron e pode ser
// tailorizada por locale. Contar grafema aqui faria a interpretação do log ser função do
// ambiente e violaria §1.5 — foi a única brecha estrutural que G1 encontrou contra a tese
// "mesma função em todo nó", e §8.6 a fechou trocando a unidade. Contador grafêmico é
// assunto de UI, e é advisório por §8.7.

import { LIMIT, CHANNEL_TYPE } from './constants.ts';

/** Escalares Unicode de `s`. `for..of` itera code points, não unidades UTF-16. */
export function codePoints(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/**
 * Conta até `limit + 1` e para. Um code point ocupa ≥ 1 unidade UTF-16, então
 * `s.length ≤ limit` já garante `codePoints ≤ limit` sem iterar nada: mesma decisão de
 * aceitação, custo limitado para entrada hostil longa.
 */
export function codePointsAtMost(s: string, limit: number): number {
  if (s.length <= limit) return codePoints(s);
  let n = 0;
  for (const _ of s) {
    if (++n > limit) return n;
  }
  return n;
}

export function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

export function trimNFKC(s: string): string {
  return s.trim().normalize('NFKC');
}

/** §8.6 — `displayName`: `trim`, colapsa espaço interno, NFKC. */
export function trimCollapseNFKC(s: string): string {
  return s.trim().replace(/\s+/gu, ' ').normalize('NFKC');
}

const CASEFOLD_MAP: Record<string, string> = {
  '\u00DF': 'ss', // ß -> ss
  '\u1E9E': 'ss', // ẞ -> ss
  '\u017F': 's',  // ſ -> s
  '\u1E9B': '\u1E61', // ẛ -> ṡ
  '\u03C2': '\u03C3', // ς -> σ
  '\u1FBE': '\u03B9', // ι -> ι
  '\u03D0': '\u03B2', // ϐ -> β
  '\u03D1': '\u03B8', // ϑ -> θ
  '\u03D5': '\u03C6', // ϕ -> φ
  '\u03D6': '\u03C0', // ϖ -> π
  '\u03F0': '\u03BA', // ϰ -> κ
  '\u03F1': '\u03C1', // ϱ -> ρ
  '\u03F5': '\u03B5', // ϵ -> ε
};
const CASEFOLD_RE = /[\u00DF\u1E9E\u017F\u1E9B\u03C2\u1FBE\u03D0\u03D1\u03D5\u03D6\u03F0\u03F1\u03F5]/gu;

/**
 * §6.1 L-5 — Unicode Full Case Folding determinístico.
 *
 * `toLowerCase()` sozinho preserva caracteres como `ß` (U+00DF), `ſ` (U+017F, s longo) e `ς`
 * (sigma final). O casefold normativo mapeia variantes de caixa e ligaturas simples para que
 * nomes como 'STRASSE' e 'Straße' ou 'WASSER' e 'Waſſer' colidam como L-5 exige.
 */
export function casefold(s: string): string {
  return s.toLowerCase().replace(CASEFOLD_RE, (c) => CASEFOLD_MAP[c] ?? c);
}

/** §8.6 — `Message.content`: `trim` no fim, **preservando quebra de linha** interna. */
export function trimEndOnly(s: string): string {
  return s.replace(/\s+$/u, '');
}

export type FieldCheck = { ok: true; value: string } | { ok: false; field: string };

const ok = (value: string): FieldCheck => ({ ok: true, value });
const bad = (field: string): FieldCheck => ({ ok: false, field });

function range(value: string, minCp: number, maxCp: number, field: string): FieldCheck {
  const n = codePointsAtMost(value, maxCp);
  return n < minCp || n > maxCp ? bad(field) : ok(value);
}

/** Campo opcional de texto: ausente passa; presente é normalizado e medido. */
function optional(
  raw: string | undefined,
  normalize: (s: string) => string,
  minCp: number,
  maxCp: number,
  field: string,
): FieldCheck {
  if (raw === undefined) return ok('');
  return range(normalize(raw), minCp, maxCp, field);
}

export function checkDisplayName(raw: string): FieldCheck {
  const { minCp, maxCp } = LIMIT.displayName;
  return range(trimCollapseNFKC(raw), minCp, maxCp, 'displayName');
}

export function checkCommunityName(raw: string): FieldCheck {
  const { minCp, maxCp } = LIMIT.communityName;
  return range(trimNFKC(raw), minCp, maxCp, 'name');
}

export function checkCommunityDescription(raw: string | undefined): FieldCheck {
  const { minCp, maxCp } = LIMIT.communityDescription;
  return optional(raw, (s) => s.trim(), minCp, maxCp, 'description');
}

/** §8.6 — `iconEmoji`: 1–8 code points **e** ≤ 32 bytes. Sem normalização. */
export function checkIconEmoji(raw: string | undefined): FieldCheck {
  if (raw === undefined) return ok('');
  const { minCp, maxCp, maxBytes } = LIMIT.communityIconEmoji;
  if (utf8Bytes(raw) > maxBytes) return bad('iconEmoji');
  return range(raw, minCp, maxCp, 'iconEmoji');
}

export function checkCategoryName(raw: string): FieldCheck {
  const { minCp, maxCp } = LIMIT.categoryName;
  return range(trimNFKC(raw), minCp, maxCp, 'name');
}

export function checkRoleName(raw: string): FieldCheck {
  const { minCp, maxCp } = LIMIT.roleName;
  return range(trimNFKC(raw), minCp, maxCp, 'name');
}

/** §8.6 — `nickname`: vazio depois do `trim` **remove**, não é erro (§6.3). */
export function checkNickname(raw: string | undefined): { ok: true; value: string | null } | { ok: false; field: string } {
  if (raw === undefined) return { ok: true, value: null };
  const v = raw.trim();
  if (v.length === 0) return { ok: true, value: null };
  const { minCp, maxCp } = LIMIT.nickname;
  const r = range(v, minCp, maxCp, 'nickname');
  return r.ok ? { ok: true, value: r.value } : r;
}

export function checkChannelTopic(raw: string | undefined): FieldCheck {
  const { minCp, maxCp } = LIMIT.channelTopic;
  return optional(raw, (s) => s.trim(), minCp, maxCp, 'topic');
}

export function checkModerationReason(raw: string | undefined): FieldCheck {
  const { minCp, maxCp } = LIMIT.moderationReason;
  return optional(raw, (s) => s.trim(), minCp, maxCp, 'reason');
}

export function checkInviteLabel(raw: string | undefined): FieldCheck {
  const { minCp, maxCp } = LIMIT.inviteLabel;
  return optional(raw, (s) => s.trim(), minCp, maxCp, 'label');
}

/** §8.6 — `content`: os **dois** tetos, code points e bytes UTF-8. */
export function checkMessageContent(raw: string): FieldCheck {
  const v = trimEndOnly(raw);
  const { minCp, maxCp, maxBytes } = LIMIT.messageContent;
  if (utf8Bytes(v) > maxBytes) return bad('content');
  return range(v, minCp, maxCp, 'content');
}

/**
 * §8.6 — `Reaction.emoji`: 1–8 code points, ≤ 32 bytes.
 *
 * Era "1 grafema / 24 bytes", e o teto de 24 rejeitava a família com ZWJ (`👨‍👩‍👧‍👦`: 1
 * grafema, 7 code points, 25 bytes). "Uma reação é **um** emoji" passa a ser garantido pelo
 * seletor curado da interface (`deltas-ux-v2.md` U-30); aqui a regra é um teto
 * determinístico, não um julgamento sobre o que é emoji.
 */
export function checkReactionEmoji(raw: string): FieldCheck {
  const { minCp, maxCp, maxBytes } = LIMIT.reactionEmoji;
  if (utf8Bytes(raw) > maxBytes) return bad('emoji');
  return range(raw, minCp, maxCp, 'emoji');
}

// ─── Nome de canal ──────────────────────────────────────────────────────────────────────

/**
 * §8.6 — canal de **texto**: NFD → remove diacrítico → minúsculo → espaço vira `-` →
 * descarta o resto → colapsa `-` repetido → `trim('-')`.
 */
export function slugChannelName(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s/gu, '-')
    .replace(/[^a-z0-9-]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

export const CHANNEL_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * `E_CHANNEL_NAME_EMPTY` é um código próprio no catálogo de §20.2: um nome que a
 * normalização esvazia por inteiro (`'###'`) não é o mesmo erro que um nome longo demais, e
 * a UI de §20.3 precisa da diferença para dizer o que fazer.
 */
export type ChannelNameCheck =
  | { ok: true; value: string }
  | { ok: false; empty: boolean };

export function checkChannelName(raw: string, type: number): ChannelNameCheck {
  const { minCp, maxCp } = LIMIT.channelName;
  if (type === CHANNEL_TYPE.text) {
    const s = slugChannelName(raw);
    if (s.length === 0) return { ok: false, empty: true };
    if (!CHANNEL_SLUG_RE.test(s)) return { ok: false, empty: false };
    return { ok: true, value: s };
  }
  // Voz: `trim`, preserva caixa e espaço, NFKC.
  const v = trimNFKC(raw);
  const n = codePointsAtMost(v, maxCp);
  if (n < minCp || n > maxCp) return { ok: false, empty: false };
  return { ok: true, value: v };
}

// ─── Nome de anexo ──────────────────────────────────────────────────────────────────────

const NOME_RESERVADO = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

/**
 * §8.6 — **rejeitar, não sanitizar**. v1 removia caracteres, o que pode fazer dois nomes
 * distintos colapsarem no mesmo e esconder travessia de caminho (`T-37`). v2 rejeita na
 * origem; no disco o arquivo vira `<blobIdHex>-<nome>`, e o prefixo garante unicidade mesmo
 * com nomes iguais.
 */
export function isValidAttachmentName(name: string): boolean {
  const bytes = utf8Bytes(name);
  const { minBytes, maxBytes } = LIMIT.attachmentName;
  if (bytes < minBytes || bytes > maxBytes) return false;
  if (/[/\\\0]/.test(name)) return false;
  for (const c of name) {
    const cp = c.codePointAt(0) ?? 0;
    if (cp < 0x20 || cp === 0x7f) return false;
  }
  if (NOME_RESERVADO.test(name)) return false;
  return !(name.endsWith('.') || name.endsWith(' '));
}
