/**
 * A unidade de contagem de §8.6 — **code points**, nunca unidades UTF-16.
 *
 * O núcleo conta escalares Unicode (`core/src/l1/fold/limits.ts`) e normaliza
 * `trim` + colapso de espaço interno + NFKC antes de medir. A interface contava
 * `String.length`, que é UTF-16, e as duas leituras discordam exatamente onde
 * mais dói:
 *
 * - um emoji sozinho tem `length === 2` e **um** code point: passava no mínimo
 *   de 2 da tela e voltava do núcleo como `E_VALIDATION`;
 * - vinte emojis têm 40 unidades UTF-16 e **vinte** code points: o `maxLength`
 *   de 32 no DOM travava um nome que o núcleo aceitaria, e travava no meio de
 *   um par substituto.
 *
 * Grafema continua fora: §8.6 é explícito em que contar grafema faria a
 * interpretação depender da tabela do ICU do runtime. Aqui a UI só espelha a
 * unidade do log.
 */

/** Escalares Unicode de `s`. `for..of` itera code points, não unidades UTF-16. */
export function codePoints(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** Primeiros `limite` code points de `s`, sem partir par substituto no meio. */
export function cortarCodePoints(s: string, limite: number): string {
  if (s.length <= limite) return s;
  let out = "";
  let n = 0;
  for (const ch of s) {
    if (++n > limite) break;
    out += ch;
  }
  return out;
}

/** §8.6 — a normalização que o núcleo aplica a `displayName` antes de medir. */
export function trimCollapseNFKC(s: string): string {
  return s.trim().replace(/\s+/gu, " ").normalize("NFKC");
}

/** §8.6 — o que o núcleo vai contar, dado o que está no campo. */
export function codePointsNormalizados(s: string): number {
  return codePoints(trimCollapseNFKC(s));
}
