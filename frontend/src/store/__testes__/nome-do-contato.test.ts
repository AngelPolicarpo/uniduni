/**
 * U-33 (emenda de 2026-09-13) — o nome do contato **sobrevive a fechar e abrir o app**.
 *
 * O nome mora no `persist` do `settingsStore`, ao lado do mudo por conversa, e a promessa
 * de tela é que ele esteja lá na próxima abertura. O que se afirma aqui é o ciclo inteiro
 * sobre um `localStorage` de mentira que sobrevive ao descarte dos módulos: gravar, "fechar"
 * (`vi.resetModules`), "abrir" (importar a store de novo, que se hidrata do armazenamento) e
 * encontrar o nome — e o mesmo para a remoção, que não pode ressuscitar na abertura seguinte.
 *
 * Verificado por mutação: tirar `dmNomeDoContato` do estado persistido (um `partialize` que o
 * descarte) faz os três primeiros casos falharem; o quarto não depende de gravar nada.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const disco = new Map<string, string>();

// O `persist` do zustand lê `window.localStorage`, e no Node não há `window`.
const armazenamento = {
  getItem: (k: string) => disco.get(k) ?? null,
  setItem: (k: string, v: string) => void disco.set(k, v),
  removeItem: (k: string) => void disco.delete(k),
  clear: () => disco.clear(),
  key: (i: number) => [...disco.keys()][i] ?? null,
  get length() {
    return disco.size;
  },
};
vi.stubGlobal("localStorage", armazenamento);
vi.stubGlobal("window", { localStorage: armazenamento });

afterAll(() => {
  vi.unstubAllGlobals();
});

/** Uma "abertura do app": módulos novos, o mesmo disco. */
async function abrirApp() {
  vi.resetModules();
  const { useSettingsStore } = await import("../settingsStore");
  return useSettingsStore;
}

beforeEach(() => {
  disco.clear();
});

describe("U-33 — o nome do contato persiste entre aberturas", () => {
  it("renomear, fechar e abrir de novo: o nome está lá", async () => {
    const primeira = await abrirApp();
    primeira.getState().setDmNomeDoContato("conv-1", "Mãe");
    expect(primeira.getState().dmNomeDoContato).toEqual({ "conv-1": "Mãe" });

    const segunda = await abrirApp();
    expect(segunda.getState().dmNomeDoContato).toEqual({ "conv-1": "Mãe" });
  });

  it("trocar o nome grava o novo, não o antigo", async () => {
    const primeira = await abrirApp();
    primeira.getState().setDmNomeDoContato("conv-1", "Mãe");
    primeira.getState().setDmNomeDoContato("conv-1", "Dona Maria");

    const segunda = await abrirApp();
    expect(segunda.getState().dmNomeDoContato["conv-1"]).toBe("Dona Maria");
  });

  it("'Usar o nome da pessoa' (e esquecer a conversa) não ressuscita na abertura seguinte", async () => {
    const primeira = await abrirApp();
    primeira.getState().setDmNomeDoContato("conv-1", "Mãe");
    primeira.getState().setDmNomeDoContato("conv-2", "Rafa");
    primeira.getState().setDmNomeDoContato("conv-1", null);

    const segunda = await abrirApp();
    expect(segunda.getState().dmNomeDoContato).toEqual({ "conv-2": "Rafa" });
  });

  it("um armazenamento de antes desta emenda abre sem nome nenhum, e sem quebrar", async () => {
    // O que uma instalação existente tem gravado: a store de ajustes sem o campo novo.
    disco.set(
      "comunidade-p2p:settings",
      JSON.stringify({ state: { microphoneId: "mic-x", dmMutedByConversation: {} }, version: 1 }),
    );
    const store = await abrirApp();
    expect(store.getState().dmNomeDoContato).toEqual({});
    expect(store.getState().microphoneId).toBe("mic-x");
  });
});
