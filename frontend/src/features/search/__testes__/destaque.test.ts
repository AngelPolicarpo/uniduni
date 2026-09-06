/**
 * O destaque do trecho no resultado da busca (§23.1, §14).
 *
 * O que se afirma: cada TERMO é destacado por si — o FTS casa os termos em conjunção,
 * não a frase literal, e procurar a frase inteira deixava toda busca de duas palavras
 * sem realce nenhum. E o corte é feito no texto ORIGINAL: o índice sai do texto
 * normalizado (sem acento), e usá-lo direto no original deslocava o `<mark>` sempre que
 * os dois tivessem comprimentos diferentes. Verificado por mutação: voltar a procurar a
 * query inteira derruba o caso de duas palavras; usar o índice normalizado direto no
 * `slice` derruba o de NFD.
 */

import { describe, expect, it } from "vitest";
import { destacarCasamentos } from "../searchIndex";

const marcado = (text: string, query: string) =>
  destacarCasamentos(text, query)
    .filter((t) => t.match)
    .map((t) => t.text);

describe("destacarCasamentos", () => {
  it("destaca cada termo de uma busca de várias palavras", () => {
    expect(marcado("A reunião de equipe mudou para quinta-feira", "reunião quinta")).toEqual([
      "reunião",
      "quinta",
    ]);
  });

  it("ignora acento nos dois lados", () => {
    expect(marcado("A reunião foi ótima", "reuniao")).toEqual(["reunião"]);
  });

  it("texto em NFD é fatiado no lugar certo — o realce cobre a palavra inteira", () => {
    // "école" com `e` + acento combinante: 6 unidades no original, 5 normalizadas.
    expect(marcado("école", "ecole")).toEqual(["école"]);
  });

  it("sem casamento, o texto sai inteiro e sem marca", () => {
    const trechos = destacarCasamentos("nada aqui", "outra coisa");
    expect(trechos).toEqual([{ text: "nada aqui", match: false }]);
  });

  it("busca vazia não destaca nada", () => {
    expect(destacarCasamentos("qualquer texto", "   ")).toEqual([
      { text: "qualquer texto", match: false },
    ]);
  });

  it("todas as ocorrências do termo entram, não só a primeira", () => {
    expect(marcado("plano e mais plano", "plano")).toEqual(["plano", "plano"]);
  });

  it("o texto sem marca é preservado na ordem", () => {
    expect(destacarCasamentos("ver o plano hoje", "plano")).toEqual([
      { text: "ver o ", match: false },
      { text: "plano", match: true },
      { text: " hoje", match: false },
    ]);
  });
});
