import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUpdateStore } from "../updateStore";
import type { UpdateStatus } from "../../ipc/bridge";

describe("useUpdateStore — ciclo de atualizações (§25.7, T-42)", () => {
  let listeners: Record<string, (arg: unknown) => void> = {};

  beforeEach(() => {
    listeners = {};
    useUpdateStore.setState({
      status: { status: "idle" },
      appVersion: "",
      verificando: false,
      baixando: false,
      inicializado: false,
    });

    const mockElectron = {
      getEpoch: vi.fn(() => 1),
      confirmExit: vi.fn(async () => {}),
      requestAuthToken: vi.fn(async () => ({ ok: true })),
      getAppVersion: vi.fn(async () => "1.0.0"),
      getUpdateStatus: vi.fn(async () => ({ status: "idle" } as UpdateStatus)),
      checkForUpdates: vi.fn(async () => ({
        status: "available",
        version: "1.1.0",
        releaseDate: "2026-09-07T12:00:00Z",
      } as UpdateStatus)),
      downloadUpdate: vi.fn(async () => {}),
      applyUpdate: vi.fn(async () => {}),
      on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
        listeners[channel] = listener as (arg: unknown) => void;
      }),
      off: vi.fn((channel: string) => {
        delete listeners[channel];
      }),
    };

    (globalThis as unknown as { window: { electron: typeof mockElectron } }).window = {
      electron: mockElectron,
    };
  });

  it("inicializa com versão e status e assina eventos do electron", async () => {
    await useUpdateStore.getState().inicializar();

    expect(window.electron?.getAppVersion).toHaveBeenCalled();
    expect(window.electron?.getUpdateStatus).toHaveBeenCalled();
    expect(window.electron?.on).toHaveBeenCalledWith("update-status", expect.any(Function));
    expect(useUpdateStore.getState().appVersion).toBe("1.0.0");
  });

  it("reage a evento de update-status emitido pelo main", async () => {
    await useUpdateStore.getState().inicializar();

    const listener = listeners["update-status"];
    expect(listener).toBeDefined();

    listener({
      status: "downloading",
      percent: 45,
      transferred: 4500,
      total: 10000,
      bytesPerSecond: 1000,
    });

    const state = useUpdateStore.getState();
    expect(state.status.status).toBe("downloading");
    if (state.status.status === "downloading") {
      expect(state.status.percent).toBe(45);
    }
    expect(state.baixando).toBe(true);
  });

  it("verificarAtualizacao chama checkForUpdates no main e atualiza o estado", async () => {
    await useUpdateStore.getState().verificarAtualizacao();

    expect(window.electron?.checkForUpdates).toHaveBeenCalled();
    const state = useUpdateStore.getState();
    expect(state.status.status).toBe("available");
    if (state.status.status === "available") {
      expect(state.status.version).toBe("1.1.0");
    }
  });

  it("baixarAtualizacao chama downloadUpdate no main", async () => {
    await useUpdateStore.getState().baixarAtualizacao();

    expect(window.electron?.downloadUpdate).toHaveBeenCalled();
    expect(useUpdateStore.getState().baixando).toBe(true);
  });

  it("aplicarAtualizacao chama applyUpdate no main", async () => {
    await useUpdateStore.getState().aplicarAtualizacao();

    expect(window.electron?.applyUpdate).toHaveBeenCalled();
  });
});
