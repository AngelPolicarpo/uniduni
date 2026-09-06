/**
 * Reconhecimento do `@` no composer (§9, 2.1.1).
 *
 * São as bordas que decidem se o painel de menção ajuda ou atrapalha: um endereço de e-mail
 * digitado no meio da frase não pode abrir a lista de pessoas, e uma menção não sobrevive ao
 * espaço — nem à pontuação — que a encerra.
 *
 * O alvo é `findMentionQuery`, que é a regra que o composer REALMENTE usa. Havia uma segunda
 * cópia (`live/mencoes.ts`) que só os testes chamavam, e ela divergia da de produção: fechava
 * o filtro no espaço mas não na pontuação, contra o que §2.1.1 manda. Regra que ninguém
 * executa não é regra; a cópia saiu, e estes casos passaram a mirar a viva.
 */

import { describe, expect, it } from "vitest";
import { findMentionQuery } from "../../features/channel/composerMentions";

describe("findMentionQuery", () => {
  it("abre no `@` do início da linha", () => {
    expect(findMentionQuery("@an", 3)).toEqual({ start: 0, text: "an" });
  });

  it("abre no `@` precedido de espaço", () => {
    expect(findMentionQuery("olá @an", 7)).toEqual({ start: 4, text: "an" });
  });

  it("abre vazio logo depois do `@` — a lista completa é o começo da escolha", () => {
    expect(findMentionQuery("olá @", 5)).toEqual({ start: 4, text: "" });
  });

  it("NÃO abre em `email@host`: `@` colado a caractere não é menção", () => {
    expect(findMentionQuery("mande para ana@exemplo.org", 26)).toBeNull();
  });

  it("fecha ao passar o espaço", () => {
    expect(findMentionQuery("@ana escreveu", 13)).toBeNull();
  });

  it("fecha na pontuação, como manda §2.1.1", () => {
    expect(findMentionQuery("@ana,", 5)).toBeNull();
    expect(findMentionQuery("@ana.", 5)).toBeNull();
    expect(findMentionQuery("@ana?", 5)).toBeNull();
  });

  it("não atravessa quebra de linha", () => {
    expect(findMentionQuery("@ana\nsegunda", 12)).toBeNull();
  });

  it("sem `@` não há menção", () => {
    expect(findMentionQuery("texto comum", 11)).toBeNull();
  });

  it("usa o `@` mais recente antes do cursor, não o primeiro", () => {
    expect(findMentionQuery("@ana e @bru", 11)).toEqual({ start: 7, text: "bru" });
  });

  it("ignora o que está DEPOIS do cursor", () => {
    // O cursor no meio da palavra deve filtrar pelo que já foi digitado, não pelo resto.
    expect(findMentionQuery("@ana", 2)).toEqual({ start: 0, text: "a" });
  });
});
