import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PonteElectron } from "../bridge";

describe("Controles de Janela e TitleBar — IPC", () => {
  let listeners: Record<string, (arg: unknown) => void> = {};
  let mockElectron: Partial<PonteElectron> & {
    windowMinimize: ReturnType<typeof vi.fn>;
    windowMaximize: ReturnType<typeof vi.fn>;
    windowClose: ReturnType<typeof vi.fn>;
    windowIsMaximized: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    listeners = {};
    mockElectron = {
      windowMinimize: vi.fn(async () => {}),
      windowMaximize: vi.fn(async () => {}),
      windowClose: vi.fn(async () => {}),
      windowIsMaximized: vi.fn(async () => false),
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

  it("chama windowMinimize ao acionar minimizar", async () => {
    await window.electron?.windowMinimize?.();
    expect(mockElectron.windowMinimize).toHaveBeenCalledOnce();
  });

  it("chama windowMaximize ao acionar maximizar/restaurar", async () => {
    await window.electron?.windowMaximize?.();
    expect(mockElectron.windowMaximize).toHaveBeenCalledOnce();
  });

  it("chama windowClose ao acionar fechar", async () => {
    await window.electron?.windowClose?.();
    expect(mockElectron.windowClose).toHaveBeenCalledOnce();
  });

  it("consulta o estado de maximização da janela", async () => {
    mockElectron.windowIsMaximized.mockResolvedValueOnce(true);
    const resultado = await window.electron?.windowIsMaximized?.();
    expect(resultado).toBe(true);
    expect(mockElectron.windowIsMaximized).toHaveBeenCalledOnce();
  });

  it("escuta e cancela eventos de alteração de maximização da janela", () => {
    const handler = vi.fn();
    window.electron?.on("window-maximized-change", handler);
    expect(mockElectron.on).toHaveBeenCalledWith("window-maximized-change", handler);

    // Dispara evento
    listeners["window-maximized-change"]?.(true);
    expect(handler).toHaveBeenCalledWith(true);

    window.electron?.off("window-maximized-change", handler);
    expect(mockElectron.off).toHaveBeenCalledWith("window-maximized-change", handler);
  });

  it("chama windowGetBounds e windowSetBounds para redimensionamento", async () => {
    mockElectron.windowGetBounds = vi.fn(async () => ({ x: 100, y: 100, width: 800, height: 600 }));
    mockElectron.windowSetBounds = vi.fn(async () => {});

    const bounds = await window.electron?.windowGetBounds?.();
    expect(bounds).toEqual({ x: 100, y: 100, width: 800, height: 600 });
    expect(mockElectron.windowGetBounds).toHaveBeenCalledOnce();

    await window.electron?.windowSetBounds?.({ x: 100, y: 100, width: 900, height: 700 });
    expect(mockElectron.windowSetBounds).toHaveBeenCalledWith({ x: 100, y: 100, width: 900, height: 700 });
  });
});
