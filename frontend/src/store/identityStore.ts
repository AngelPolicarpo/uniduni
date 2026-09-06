import { create } from "zustand";
import type { AvatarColor, Identity, PresenceStatus } from "../domain/types";
import { handleFromDisplayName } from "../lib/avatar";
import { useToastStore } from "./toastStore";

/**
 * Identidade no renderer — espelho de `query.identity` (§15.6).
 *
 * A fonte da verdade é o NÚCLEO: o par de chaves nasce e vive no cofre
 * (`identity.create`, §15.4), e quem enche esta store é o sincronizador.
 * Nada aqui persiste — uma identidade que só existe no localStorage
 * enquanto o núcleo diz `awaiting-identity` é um fantasma que faz a rota
 * `/` abrir um shell sem núcleo (foi exatamente o que o smoke achou).
 *
 * **Editar aqui É escrever no núcleo.** `identity.update` (§15.4) enfileira uma op por
 * comunidade e `identity.setPresence` fixa o status que o refresh de §17.6 publica; sem
 * essa ponte, nome, cor e presença viviam só neste objeto e o primeiro
 * `sincronizarIdentidade` — resync de epoch, `community.changed`, recarga — os apagava sem
 * dizer nada, e ninguém do outro lado via a mudança. Por isso o otimismo aqui é revertido
 * quando o núcleo recusa: a store não pode afirmar o que o log não vai carregar.
 */
export interface CreateIdentityInput {
  displayName: string;
  avatarColor: AvatarColor;
}

/**
 * O canal de escrita de §15.4 injetado pelo sincronizador. `null` é "sem núcleo": a edição
 * continua desenhando na tela, mas quem a pediu é avisado de que ela não saiu daqui.
 */
export interface CanalDeIdentidade {
  /** A cor vai como token do tema; quem a traduz para o `u8` de §6.4.2 é o sincronizador. */
  atualizar(patch: { displayName?: string; avatarColor?: AvatarColor }): Promise<unknown>;
  definirPresenca(presence: PresenceStatus): Promise<unknown>;
}

interface IdentityState {
  identity: Identity | null;
  /** Escrita de presença; otimista na tela, `identity.setPresence` no fio. */
  setPresence: (presence: PresenceStatus) => void;
  updateIdentity: (
    patch: Partial<Pick<Identity, "displayName" | "avatarColor">>,
  ) => void;
  /** "Sair desta identidade" (§10, 3.1) — não há recuperação. */
  clearIdentity: () => void;
  /** Injeção do transporte pelo sincronizador; `null` volta ao estado sem núcleo. */
  configurarEscrita: (canal: CanalDeIdentidade | null) => void;
  /** Espelho de `query.identity` — não é edição, e por isso não escreve no fio. */
  aplicarRemoto: (identity: Identity | null) => void;
}

let portaDeIdentidade: CanalDeIdentidade | null = null;

/** Devolve o valor anterior quando o núcleo recusa, e diz por quê (§20.1). */
function reverter(anterior: Identity, acao: string, e: unknown): void {
  useIdentityStore.setState((state) =>
    state.identity === null || state.identity.id !== anterior.id ? state : { identity: anterior },
  );
  useToastStore
    .getState()
    .showToast(`Não foi possível ${acao} (${e instanceof Error ? e.message : String(e)})`, "error");
}

export const useIdentityStore = create<IdentityState>()((set) => ({
  identity: null,

  configurarEscrita: (canal) => {
    portaDeIdentidade = canal;
  },

  aplicarRemoto: (identity) => set({ identity }),

  setPresence: (presence) =>
    set((state) => {
      if (!state.identity) return state;
      const anterior = state.identity;
      if (anterior.presence === presence) return state;
      const porta = portaDeIdentidade;
      if (porta === null) {
        useToastStore.getState().showToast("Sem núcleo: a presença não foi publicada", "error");
        return state;
      }
      void porta.definirPresenca(presence).catch((e: unknown) => reverter(anterior, "mudar a presença", e));
      return { identity: { ...anterior, presence } };
    }),

  updateIdentity: (patch) =>
    set((state) => {
      if (!state.identity) return state;
      const anterior = state.identity;
      const displayName = patch.displayName?.trim();
      const porta = portaDeIdentidade;
      if (porta === null) {
        useToastStore.getState().showToast("Sem núcleo: a alteração não foi salva", "error");
        return state;
      }
      // §15.4 `identity.update` aceita os dois campos juntos; o `handle` é derivado do nome
      // e não viaja — quem o recalcula do outro lado é o fold (§6.1).
      void porta
        .atualizar({
          ...(displayName !== undefined && displayName !== "" ? { displayName } : {}),
          ...(patch.avatarColor !== undefined ? { avatarColor: patch.avatarColor } : {}),
        })
        .catch((e: unknown) => reverter(anterior, "salvar a identidade", e));
      return {
        identity: {
          ...anterior,
          ...patch,
          ...(displayName
            ? { displayName, handle: handleFromDisplayName(displayName) }
            : {}),
        },
      };
    }),

  clearIdentity: () => set({ identity: null }),
}));
