/**
 * Que ids saem no `mentions` da op quando a mensagem é enviada (§9, 2.1.1).
 *
 * O que se afirma: o token vale como menção só onde ele é a palavra inteira. O
 * casamento por `content.includes(token)` mandava o id do Dan em toda mensagem que
 * dissesse "@Danilo" — notificação de uma conversa que não é dele. Verificado por
 * mutação: trocar a borda por `includes` derruba o caso do prefixo.
 */

import { describe, expect, it } from "vitest";
import { ocorrenciasDe } from "../composerMentions";

describe("ocorrenciasDe — a borda da menção", () => {
  it("prefixo de outro nome NÃO conta: `@Dan` dentro de `@Danilo` não é o Dan", () => {
    expect(ocorrenciasDe("fala com @Danilo", "@Dan")).toBe(0);
  });

  it("o nome inteiro conta, no fim do texto ou antes de espaço", () => {
    expect(ocorrenciasDe("fala com @Dan", "@Dan")).toBe(1);
    expect(ocorrenciasDe("@Dan, veja isso", "@Dan")).toBe(1);
    expect(ocorrenciasDe("@Dan e mais gente", "@Dan")).toBe(1);
  });

  it("`@` colado a palavra não abre menção — `ana@exemplo.org` não menciona ninguém", () => {
    expect(ocorrenciasDe("escreva para ana@exemplo.org", "@exemplo")).toBe(0);
  });

  it("conta uma vez por ocorrência — é o que casa homônimo com homônimo", () => {
    expect(ocorrenciasDe("@Ana e @Ana", "@Ana")).toBe(2);
  });

  it("nome com espaço no meio continua sendo um token só", () => {
    expect(ocorrenciasDe("oi @Ana Torres!", "@Ana Torres")).toBe(1);
    expect(ocorrenciasDe("oi @Ana Torreson", "@Ana Torres")).toBe(0);
  });
});
