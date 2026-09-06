/**
 * §8.6 — a unidade em que a interface conta `displayName`.
 *
 * O núcleo conta **code points** depois de `trim` + colapso de espaço interno + NFKC
 * (`checkDisplayName`). A tela contava `String.length`, que é UTF-16, e as duas leituras
 * discordavam nos dois extremos:
 *
 *   - um emoji sozinho tem `length === 2`: passava no mínimo de 2 da tela e voltava do
 *     núcleo como `E_VALIDATION`;
 *   - vinte emojis têm 40 unidades UTF-16: o `maxLength={32}` do DOM travava a digitação
 *     de um nome que o núcleo aceitaria — e travava no meio de um par substituto.
 */

import { describe, expect, it } from "vitest";
import {
  codePoints,
  codePointsNormalizados,
  cortarCodePoints,
  trimCollapseNFKC,
} from "../../lib/texto";

const NAME_MIN = 2;
const NAME_MAX = 32;

/** A validação da tela de onboarding, na mesma forma. */
function aceito(raw: string): boolean {
  const n = codePointsNormalizados(raw);
  return n >= NAME_MIN && n <= NAME_MAX;
}

describe("codePoints", () => {
  it("conta escalares, não unidades UTF-16", () => {
    expect("🙂".length).toBe(2);
    expect(codePoints("🙂")).toBe(1);
    expect(codePoints("ab🙂")).toBe(3);
  });
});

describe("a validação do nome de exibição", () => {
  it("um emoji sozinho é UM caractere — a tela recusa, como o núcleo recusaria", () => {
    expect(aceito("🙂")).toBe(false);
  });

  it("dois emojis passam nos dois lados", () => {
    expect(aceito("🙂🙃")).toBe(true);
  });

  it("vinte emojis cabem: são 20 code points, não 40", () => {
    const nome = "🙂".repeat(20);
    expect(nome.length).toBe(40);
    expect(aceito(nome)).toBe(true);
  });

  it("trinta e três code points não cabem", () => {
    expect(aceito("a".repeat(33))).toBe(false);
  });

  it("mede o texto NORMALIZADO — espaço interno colapsa antes da conta", () => {
    expect(codePointsNormalizados("  a     b  ")).toBe(3);
    expect(trimCollapseNFKC("  a     b  ")).toBe("a b");
  });

  it("só espaço não é nome", () => {
    expect(aceito("   ")).toBe(false);
  });
});

describe("cortarCodePoints", () => {
  it("não parte par substituto ao aplicar o teto do campo", () => {
    const cortado = cortarCodePoints("🙂".repeat(40), NAME_MAX);
    expect(codePoints(cortado)).toBe(NAME_MAX);
    // Cortar por `slice(0, 32)` deixaria meia surrogate no fim.
    expect(cortado.endsWith("🙂")).toBe(true);
  });

  it("texto curto passa intacto", () => {
    expect(cortarCodePoints("ana", NAME_MAX)).toBe("ana");
  });
});
