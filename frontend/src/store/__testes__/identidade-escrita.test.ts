/**
 * §15.4 "Identidade e app" — editar a identidade É escrever no núcleo.
 *
 * O que se afirma: nome, cor e presença saem pela porta injetada; recusa reverte o
 * otimismo e diz o motivo; sem núcleo a edição não é aceita em silêncio.
 *
 * O defeito que isto fecha: `updateIdentity`/`setPresence` eram escritas puramente locais.
 * `identity.update` e `identity.setPresence` existiam e não tinham chamador nenhum em
 * produto — a mudança vivia só na memória do renderer e o primeiro `sincronizarIdentidade`
 * (resync de epoch, `community.changed`, recarga) a apagava sem avisar. Ninguém do outro
 * lado via nome, cor ou presença mudarem.
 *
 * Verificado por mutação: trocar o `void porta.atualizar(...)` por nada faz o primeiro
 * caso passar a não registrar chamada.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { useIdentityStore } from "../identityStore";
import { useToastStore } from "../toastStore";
import type { Identity } from "../../domain/types";

const EU: Identity = {
  id: "eu",
  displayName: "Ana",
  handle: "ana",
  avatarColor: "role-blue",
  publicKey: "ab".repeat(32),
  presence: "online",
  createdAt: new Date(0).toISOString(),
};

function porta(sobre?: { atualizar?: () => Promise<unknown>; definirPresenca?: () => Promise<unknown> }) {
  const canal = {
    atualizar: vi.fn(sobre?.atualizar ?? (async () => ({}))),
    definirPresenca: vi.fn(sobre?.definirPresenca ?? (async () => ({}))),
  };
  useIdentityStore.getState().configurarEscrita(canal);
  return canal;
}

beforeEach(() => {
  useIdentityStore.setState({ identity: EU });
  useIdentityStore.getState().configurarEscrita(null);
  useToastStore.setState({ toasts: [] });
});

describe("identidade — a edição sai pela IPC-R", () => {
  it("trocar o nome chama `identity.update` e recalcula o handle na tela", () => {
    const canal = porta();
    useIdentityStore.getState().updateIdentity({ displayName: "  Ana Paula  " });
    expect(canal.atualizar).toHaveBeenCalledWith({ displayName: "Ana Paula" });
    expect(useIdentityStore.getState().identity?.displayName).toBe("Ana Paula");
  });

  it("trocar a cor manda o TOKEN — quem traduz para o `u8` de §6.4.2 é o sincronizador", () => {
    const canal = porta();
    useIdentityStore.getState().updateIdentity({ avatarColor: "role-green" });
    expect(canal.atualizar).toHaveBeenCalledWith({ avatarColor: "role-green" });
  });

  it("trocar a presença chama `identity.setPresence`", () => {
    const canal = porta();
    useIdentityStore.getState().setPresence("dnd");
    expect(canal.definirPresenca).toHaveBeenCalledWith("dnd");
    expect(useIdentityStore.getState().identity?.presence).toBe("dnd");
  });

  it("a MESMA presença não vira request — nada mudou para publicar", () => {
    const canal = porta();
    useIdentityStore.getState().setPresence("online");
    expect(canal.definirPresenca).not.toHaveBeenCalled();
  });

  it("recusa do núcleo reverte o otimismo e nomeia o motivo", async () => {
    porta({ atualizar: async () => Promise.reject(new Error("E_RATE_LIMITED")) });
    useIdentityStore.getState().updateIdentity({ displayName: "Beatriz" });
    await new Promise((r) => setTimeout(r, 0));
    expect(useIdentityStore.getState().identity?.displayName).toBe("Ana");
    expect(useToastStore.getState().toasts[0]?.message).toContain("E_RATE_LIMITED");
  });

  it("sem núcleo a edição NÃO é aceita em silêncio", () => {
    useIdentityStore.getState().updateIdentity({ displayName: "Beatriz" });
    expect(useIdentityStore.getState().identity?.displayName).toBe("Ana");
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });
});
