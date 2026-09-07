import { create } from "zustand";
import type { UpdateStatus } from "../ipc/bridge";

interface UpdateState {
  status: UpdateStatus;
  appVersion: string;
  verificando: boolean;
  baixando: boolean;
  inicializado: boolean;
  inicializar: () => Promise<void>;
  verificarAtualizacao: () => Promise<void>;
  baixarAtualizacao: () => Promise<void>;
  aplicarAtualizacao: () => Promise<void>;
}

export const useUpdateStore = create<UpdateState>()((set, get) => ({
  status: { status: "idle" },
  appVersion: "",
  verificando: false,
  baixando: false,
  inicializado: false,

  inicializar: async () => {
    if (get().inicializado) return;
    set({ inicializado: true });

    if (typeof window === "undefined" || !window.electron) return;

    try {
      if (typeof window.electron.getAppVersion === "function") {
        const versao = await window.electron.getAppVersion();
        set({ appVersion: versao });
      }

      if (typeof window.electron.getUpdateStatus === "function") {
        const estado = await window.electron.getUpdateStatus();
        set({
          status: estado,
          verificando: estado.status === "checking",
          baixando: estado.status === "downloading",
        });
      }

      if (typeof window.electron.on === "function") {
        window.electron.on("update-status", (novoEstado: unknown) => {
          const estado = novoEstado as UpdateStatus;
          set({
            status: estado,
            verificando: estado.status === "checking",
            baixando: estado.status === "downloading",
          });
        });
      }
    } catch (e) {
      console.warn("[updateStore] falha ao inicializar estado de atualização:", e);
    }
  },

  verificarAtualizacao: async () => {
    if (typeof window === "undefined" || !window.electron?.checkForUpdates) return;
    set({ verificando: true });
    try {
      const estado = await window.electron.checkForUpdates();
      set({
        status: estado,
        verificando: estado.status === "checking",
        baixando: estado.status === "downloading",
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      set({
        status: { status: "error", message },
        verificando: false,
      });
    }
  },

  baixarAtualizacao: async () => {
    if (typeof window === "undefined" || !window.electron?.downloadUpdate) return;
    set({ baixando: true });
    try {
      await window.electron.downloadUpdate();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      set({
        status: { status: "error", message },
        baixando: false,
      });
    }
  },

  aplicarAtualizacao: async () => {
    if (typeof window === "undefined" || !window.electron?.applyUpdate) return;
    try {
      await window.electron.applyUpdate();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      set({
        status: { status: "error", message },
      });
    }
  },
}));
