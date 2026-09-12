import { describe, expect, it } from "vitest";
import { comporPalco } from "../palcoDaChamada";

const pessoas = (...ids: string[]) => ids.map((identityId) => ({ identityId }));

describe("composição do palco da chamada (§9, 2.3.2 · §9, 2.4)", () => {
  it("sem transmissão e sem fixado, não há palco — é a grade normal", () => {
    const r = comporPalco({
      participantes: pessoas("eu", "bruno", "clara"),
      transmissoes: 0,
      fixadoId: null,
    });
    expect(r.temPalco).toBe(false);
    expect(r.itensNoPalco).toBe(0);
    expect(r.naGrade).toEqual(["eu", "bruno", "clara"]);
  });

  it("uma transmissão ocupa o palco sozinha e todo mundo vai para a tira", () => {
    const r = comporPalco({
      participantes: pessoas("eu", "bruno"),
      transmissoes: 1,
      fixadoId: null,
    });
    expect(r.temPalco).toBe(true);
    expect(r.itensNoPalco).toBe(1);
    expect(r.naGrade).toEqual(["eu", "bruno"]);
  });

  it("fixar sem transmissão nenhuma também abre o palco", () => {
    const r = comporPalco({
      participantes: pessoas("eu", "bruno", "clara"),
      transmissoes: 0,
      fixadoId: "bruno",
    });
    expect(r.temPalco).toBe(true);
    expect(r.itensNoPalco).toBe(1);
    expect(r.fixadoId).toBe("bruno");
  });

  it("o fixado sai da grade — senão a mesma câmera decodificaria duas vezes", () => {
    const r = comporPalco({
      participantes: pessoas("eu", "bruno", "clara"),
      transmissoes: 0,
      fixadoId: "bruno",
    });
    expect(r.naGrade).toEqual(["eu", "clara"]);
  });

  it("transmissão e fixado dividem o palco: dois itens viram grade de duas colunas", () => {
    const r = comporPalco({
      participantes: pessoas("eu", "bruno", "clara"),
      transmissoes: 1,
      fixadoId: "clara",
    });
    expect(r.itensNoPalco).toBe(2);
    expect(r.naGrade).toEqual(["eu", "bruno"]);
  });

  it("fixado que saiu da chamada não reserva a área grande", () => {
    const r = comporPalco({
      participantes: pessoas("eu", "bruno"),
      transmissoes: 0,
      fixadoId: "clara",
    });
    expect(r.temPalco).toBe(false);
    expect(r.fixadoId).toBeNull();
    expect(r.naGrade).toEqual(["eu", "bruno"]);
  });

  it("fixado que saiu não cancela o palco de uma transmissão viva", () => {
    const r = comporPalco({
      participantes: pessoas("eu", "bruno"),
      transmissoes: 1,
      fixadoId: "clara",
    });
    expect(r.temPalco).toBe(true);
    expect(r.itensNoPalco).toBe(1);
    expect(r.fixadoId).toBeNull();
  });

  it("duas transmissões mais um fixado são três itens no palco", () => {
    const r = comporPalco({
      participantes: pessoas("eu", "bruno", "clara"),
      transmissoes: 2,
      fixadoId: "eu",
    });
    expect(r.itensNoPalco).toBe(3);
    expect(r.naGrade).toEqual(["bruno", "clara"]);
  });
});
