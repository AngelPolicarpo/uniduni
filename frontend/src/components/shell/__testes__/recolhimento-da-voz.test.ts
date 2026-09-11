import { describe, expect, it } from "vitest";
import {
  chaveDoAlvo,
  deveRecolherAGrade,
} from "../recolhimentoDaVoz";

const canal = (channelId: string) =>
  chaveDoAlvo({ destino: "comunidade", communityId: "c1", channelId });

describe("recolhimento da grade de voz ao navegar (§9, 2.3.1)", () => {
  it("não recolhe na primeira passagem — é a grade abrindo, não navegação", () => {
    expect(
      deveRecolherAGrade({
        expandida: true,
        anterior: null,
        atual: canal("ch-geral"),
      }),
    ).toBe(false);
  });

  it("recolhe quando o canal de texto muda com a grade aberta", () => {
    expect(
      deveRecolherAGrade({
        expandida: true,
        anterior: canal("ch-geral"),
        atual: canal("ch-projetos"),
      }),
    ).toBe(true);
  });

  it("recolhe ao trocar de comunidade — C11 diz que voltar é 'clicar nela reexpande'", () => {
    expect(
      deveRecolherAGrade({
        expandida: true,
        anterior: chaveDoAlvo({
          destino: "comunidade",
          communityId: "c1",
          channelId: "ch-geral",
        }),
        atual: chaveDoAlvo({
          destino: "comunidade",
          communityId: "c2",
          channelId: "ch-outro",
        }),
      }),
    ).toBe(true);
  });

  it("recolhe ao ir para as conversas diretas", () => {
    expect(
      deveRecolherAGrade({
        expandida: true,
        anterior: canal("ch-geral"),
        atual: chaveDoAlvo({
          destino: "dm",
          communityId: "c1",
          channelId: "ch-geral",
        }),
      }),
    ).toBe(true);
  });

  it("não recolhe quando nada mudou — a chamada sobrevive ao render", () => {
    expect(
      deveRecolherAGrade({
        expandida: true,
        anterior: canal("ch-geral"),
        atual: canal("ch-geral"),
      }),
    ).toBe(false);
  });

  it("com a grade recolhida não há o que recolher", () => {
    expect(
      deveRecolherAGrade({
        expandida: false,
        anterior: canal("ch-geral"),
        atual: canal("ch-projetos"),
      }),
    ).toBe(false);
  });

  it("canal ausente não colide com canal presente", () => {
    const semCanal = chaveDoAlvo({
      destino: "comunidade",
      communityId: "c1",
      channelId: null,
    });
    expect(semCanal).not.toBe(canal("ch-geral"));
  });
});
