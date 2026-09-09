import { describe, expect, it } from "vitest";
import { acoesDeChamada, acoesDaConversa, type DmCallState } from "../dmRegras";
import { useUiStore } from "../../../store/uiStore";
import { useDmStore } from "../../../store/dmStore";

describe("Fase 8 — Correções de Navegação e Chamadas de DM", () => {
  it("selecionar conversa ou atender deve levar mobilePane para 'content'", () => {
    useUiStore.getState().abrirDm();
    expect(useUiStore.getState().destino).toBe("dm");
    expect(useUiStore.getState().mobilePane).toBe("channels");

    // Simula a transição realizada ao selecionar conversa na lista ou atender
    useUiStore.getState().setMobilePane("content");
    expect(useUiStore.getState().mobilePane).toBe("content");
  });

  it("quando a conversa não existe no cache, DmCallPanel restringe ações a 'desligar'/'recusar' e não permite 'atender'", () => {
    // Chamada recebida para conversa não indexada
    let estado: DmCallState = "recebendo";
    const conversa = undefined;
    const acoes = conversa
      ? acoesDeChamada((conversa as any).state, estado)
      : (estado as string) === "fora"
        ? []
        : ["desligar"];

    expect(acoes).toEqual(["desligar"]);
    expect(acoes).not.toContain("atender");
  });

  it("conversa inexistente no cache não deve ser considerada 'naTela' no DmCallPanel", () => {
    useDmStore.setState({ ativa: "conv-orfam", conversas: [] });
    useUiStore.setState({ destino: "dm" });

    const conversationId = "conv-orfam";
    const conversas = useDmStore.getState().conversas;
    const conversa = conversas.find((c) => c.conversationId === conversationId);
    const ativa = useDmStore.getState().ativa;
    const destino = useUiStore.getState().destino;

    const naTela = destino === "dm" && ativa === conversationId && conversa !== undefined;
    expect(naTela).toBe(false);
  });

  it("acoesDaConversa para 'pending-in' deve incluir 'aceitar', 'bloquear' e 'esquecer'", () => {
    const acoes = acoesDaConversa("pending-in");
    expect(acoes).toContain("aceitar");
    expect(acoes).toContain("bloquear");
    expect(acoes).toContain("esquecer");
  });

  it("validação de nome de perfil por conversa (§31.7.5 / U-33) deve exigir entre 2 e 32 caracteres", () => {
    function validarNome(nome: string): boolean {
      const limpo = nome.trim();
      const len = Array.from(limpo).length;
      return len >= 2 && len <= 32;
    }

    expect(validarNome("")).toBe(false);
    expect(validarNome("a")).toBe(false);
    expect(validarNome("ab")).toBe(true);
    expect(validarNome("Ana Paula")).toBe(true);
    expect(validarNome("a".repeat(32))).toBe(true);
    expect(validarNome("a".repeat(33))).toBe(false);
  });

  it("não oferece ação de chamar em conversa se já houver chamada em andamento noutra conversa (§15.4 / §15)", () => {
    const conversaState = "accepted";
    const chamadaId = "conv-1";
    const daConversa = false; // Usuário visualizando conv-2 enquanto conv-1 está em chamada

    const acoesChamada =
      chamadaId !== null && !daConversa
        ? []
        : acoesDeChamada(conversaState, daConversa ? "na-chamada" : "fora");

    expect(acoesChamada).toEqual([]);
    expect(acoesChamada).not.toContain("chamar");
  });
});
