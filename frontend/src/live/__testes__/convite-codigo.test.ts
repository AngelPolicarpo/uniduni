/**
 * §12.1/§15.4 — a leitura do código de convite no lado da interface.
 *
 * O que se afirma: a normalização da tela é a MESMA de `core/src/l2/invites`, e o que não
 * é código volta como `null` em vez de virar uma string qualquer.
 *
 * O defeito: um `comunidadep2p://join/…` não casava no regex de `invite/…` e caía num
 * fallback que só removia pontuação — `comunidadep2pjoinX7K2…`, 33 caracteres que o núcleo
 * recusa com `E_MALFORMED`, guardados como se fossem convite pendente. E, sem os aliases
 * Crockford nem a caixa, o mesmo convite colado de duas formas virava duas pendências.
 */

import { describe, expect, it } from "vitest";
import { normalizeInviteCode } from "../../mocks/dataset";

/** 16 chars Crockford, como o host emite (4 grupos de 4). */
const CANONICO = "X7K2QM9FRT4BN8ZP";

describe("normalizeInviteCode", () => {
  it("aceita o código nu, com e sem os grupos", () => {
    expect(normalizeInviteCode(CANONICO)).toBe(CANONICO);
    expect(normalizeInviteCode("X7K2-QM9F-RT4B-N8ZP")).toBe(CANONICO);
  });

  it("aceita o deep link nativo — era o caso que virava lixo de 33 caracteres", () => {
    expect(normalizeInviteCode(`comunidadep2p://join/${CANONICO}`)).toBe(CANONICO);
  });

  it("aceita o link de compartilhamento, com e sem esquema", () => {
    expect(normalizeInviteCode(`p2p.app/invite/${CANONICO}`)).toBe(CANONICO);
    expect(normalizeInviteCode(`https://p2p.app/invite/X7K2-QM9F-RT4B-N8ZP`)).toBe(CANONICO);
  });

  it("caixa e aliases Crockford: I e L valem 1, O vale 0", () => {
    expect(normalizeInviteCode("x7k2qm9frt4bn8zp")).toBe(CANONICO);
    expect(normalizeInviteCode("iiiillllooootttt")).toBe("111111110000TTTT");
  });

  it("espaço acidental é ignorado, não trunca o código", () => {
    // A versão anterior fazia `split(/\s+/)[0]` em algum ponto da história e o resto do
    // código sumia em silêncio. Espaço aqui é separador visual, como o `-`.
    expect(normalizeInviteCode(" X7K2 QM9F RT4B N8ZP ")).toBe(CANONICO);
  });

  it("o que não é código volta `null` — e `null` não é o mesmo que string vazia", () => {
    expect(normalizeInviteCode("")).toBeNull();
    expect(normalizeInviteCode("comunidadep2p://join/X7K2")).toBeNull();
    expect(normalizeInviteCode("X7K2QM9FRT4BN8ZPX")).toBeNull();
    // `U` está fora do alfabeto Crockford, de propósito.
    expect(normalizeInviteCode("X7K2QM9FRT4BN8ZU")).toBeNull();
  });
});
