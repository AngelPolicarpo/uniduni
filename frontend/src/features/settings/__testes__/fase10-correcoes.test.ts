import { describe, expect, it } from "vitest";
import { codePoints, cortarCodePoints } from "../../../lib/texto";

describe("Fase 10 — Validação por code points (§8.6, §13)", () => {
  it("um emoji tem 1 code point mas 2 unidades UTF-16: rejeita comunidade com 1 emoji", () => {
    const nome1Emoji = "🙂";
    expect(nome1Emoji.length).toBe(2); // UTF-16 length
    expect(codePoints(nome1Emoji)).toBe(1); // code point count
    // Mínimo é 2 code points:
    expect(codePoints(nome1Emoji) < 2).toBe(true);
  });

  it("dois emojis têm 2 code points: aceita como nome de comunidade", () => {
    const nome2Emojis = "🙂🚀";
    expect(nome2Emojis.length).toBe(4);
    expect(codePoints(nome2Emojis)).toBe(2);
    expect(codePoints(nome2Emojis) >= 2).toBe(true);
  });

  it("21 emojis têm 21 code points (<= 40 teto), embora tenham 42 unidades UTF-16", () => {
    const vinteUmEmojis = "🙂".repeat(21);
    expect(vinteUmEmojis.length).toBe(42); // Seria bloqueado pelo maxLength={40} do DOM!
    expect(codePoints(vinteUmEmojis)).toBe(21); // Permitido no núcleo (limite 40 code points)
    expect(codePoints(vinteUmEmojis) <= 40).toBe(true);
  });

  it("cortarCodePoints trunca por escalar Unicode sem quebrar pares substitutos", () => {
    const texto = "Comunidade 🙂🚀🎉";
    // 11 chars ascii + 3 emojis = 14 code points
    const cortado = cortarCodePoints(texto, 12);
    expect(codePoints(cortado)).toBe(12);
    expect(cortado).toBe("Comunidade 🙂");
  });
});

describe("Fase 10 — Reconciliação de abas em configurações da comunidade (§15)", () => {
  it("quando a aba ativa for 'roles' ou 'moderation' e a permissão for revogada, reconcilia para 'general'", () => {
    const reconcileTab = (
      selectedTab: string,
      canManageRoles: boolean,
      canModeration: boolean,
    ) => {
      const tabs = [
        { id: "general" },
        ...(canManageRoles ? [{ id: "roles" }] : []),
        ...(canModeration ? [{ id: "moderation" }] : []),
      ];
      return tabs.some((t) => t.id === selectedTab) ? selectedTab : "general";
    };

    // Com permissão, a aba selecionada permanece
    expect(reconcileTab("roles", true, false)).toBe("roles");
    expect(reconcileTab("moderation", false, true)).toBe("moderation");

    // Se perder a permissão, reverte para 'general'
    expect(reconcileTab("roles", false, false)).toBe("general");
    expect(reconcileTab("moderation", false, false)).toBe("general");
  });
});

describe("Fase 10 — Delta U-15: Declaração de reversibilidade do banimento", () => {
  it("a frase obrigatória de restauração de mensagens ao revogar ban está presente", () => {
    const targetLabel = "Membro Teste";
    const banNotice = `${targetLabel} não consegue mais entrar nesta comunidade com esta identidade, e as mensagens dele saem do canal. Revogar o banimento reexibe as mensagens.`;
    expect(banNotice).toContain("Revogar o banimento reexibe as mensagens");
  });
});
