import React, { useEffect, useState, useRef, useCallback } from "react";

type Direction = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const MIN_WIDTH = 800;
const MIN_HEIGHT = 600;

interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const WindowResizeHandles: React.FC = () => {
  const [isMaximized, setIsMaximized] = useState(false);
  const isDraggingRef = useRef(false);

  useEffect(() => {
    if (!window.electron?.windowIsMaximized) return;

    window.electron.windowIsMaximized().then(setIsMaximized).catch(() => {});

    const handleMaximizedChange = (maximized: unknown) => {
      setIsMaximized(Boolean(maximized));
    };

    window.electron.on("window-maximized-change", handleMaximizedChange);
    return () => {
      window.electron?.off("window-maximized-change", handleMaximizedChange);
    };
  }, []);

  const handlePointerDown = useCallback((direction: Direction) => (e: React.PointerEvent) => {
    if (!window.electron?.windowGetBounds || !window.electron?.windowSetBounds) return;
    if (isMaximized) return;

    e.preventDefault();
    e.stopPropagation();

    const startX = e.screenX;
    const startY = e.screenY;

    void window.electron.windowGetBounds().then((initialBounds) => {
      if (!initialBounds) return;

      isDraggingRef.current = true;
      const originalUserSelect = document.body.style.userSelect;
      document.body.style.userSelect = "none";

      let rafId: number | null = null;
      let pendingBounds: WindowBounds | null = null;

      const onPointerMove = (ev: PointerEvent) => {
        if (!isDraggingRef.current) return;

        const dx = ev.screenX - startX;
        const dy = ev.screenY - startY;

        let { x, y, width, height } = initialBounds;

        if (direction.includes("e")) {
          width = Math.max(MIN_WIDTH, initialBounds.width + dx);
        }
        if (direction.includes("s")) {
          height = Math.max(MIN_HEIGHT, initialBounds.height + dy);
        }
        if (direction.includes("w")) {
          const potentialWidth = initialBounds.width - dx;
          if (potentialWidth >= MIN_WIDTH) {
            width = potentialWidth;
            x = initialBounds.x + dx;
          } else {
            width = MIN_WIDTH;
            x = initialBounds.x + (initialBounds.width - MIN_WIDTH);
          }
        }
        if (direction.includes("n")) {
          const potentialHeight = initialBounds.height - dy;
          if (potentialHeight >= MIN_HEIGHT) {
            height = potentialHeight;
            y = initialBounds.y + dy;
          } else {
            height = MIN_HEIGHT;
            y = initialBounds.y + (initialBounds.height - MIN_HEIGHT);
          }
        }

        pendingBounds = { x, y, width, height };

        if (rafId === null) {
          rafId = requestAnimationFrame(() => {
            rafId = null;
            if (pendingBounds && window.electron?.windowSetBounds) {
              void window.electron.windowSetBounds(pendingBounds);
            }
          });
        }
      };

      const onPointerUp = () => {
        isDraggingRef.current = false;
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        if (pendingBounds && window.electron?.windowSetBounds) {
          void window.electron.windowSetBounds(pendingBounds);
        }
        document.body.style.userSelect = originalUserSelect;
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
      };

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
    });
  }, [isMaximized]);

  // Se não estiver no Electron ou a janela estiver maximizada, não renderiza handles
  if (!window.electron?.windowSetBounds || isMaximized) {
    return null;
  }

  return (
    <div className="pointer-events-none fixed inset-0 z-50 overflow-hidden app-no-drag">
      {/* Bordas lineares (espessura de 5px) */}
      <div
        className="pointer-events-auto absolute top-0 left-0 right-0 h-[5px] cursor-ns-resize app-no-drag"
        onPointerDown={handlePointerDown("n")}
        aria-hidden="true"
      />
      <div
        className="pointer-events-auto absolute bottom-0 left-0 right-0 h-[5px] cursor-ns-resize app-no-drag"
        onPointerDown={handlePointerDown("s")}
        aria-hidden="true"
      />
      <div
        className="pointer-events-auto absolute top-0 bottom-0 left-0 w-[5px] cursor-ew-resize app-no-drag"
        onPointerDown={handlePointerDown("w")}
        aria-hidden="true"
      />
      <div
        className="pointer-events-auto absolute top-0 bottom-0 right-0 w-[5px] cursor-ew-resize app-no-drag"
        onPointerDown={handlePointerDown("e")}
        aria-hidden="true"
      />

      {/* Cantos para redimensionamento diagonal (área de 10x10px) */}
      <div
        className="pointer-events-auto absolute top-0 left-0 h-[10px] w-[10px] cursor-nwse-resize app-no-drag z-10"
        onPointerDown={handlePointerDown("nw")}
        aria-hidden="true"
      />
      <div
        className="pointer-events-auto absolute top-0 right-0 h-[10px] w-[10px] cursor-nesw-resize app-no-drag z-10"
        onPointerDown={handlePointerDown("ne")}
        aria-hidden="true"
      />
      <div
        className="pointer-events-auto absolute bottom-0 left-0 h-[10px] w-[10px] cursor-nesw-resize app-no-drag z-10"
        onPointerDown={handlePointerDown("sw")}
        aria-hidden="true"
      />
      <div
        className="pointer-events-auto absolute bottom-0 right-0 h-[10px] w-[10px] cursor-nwse-resize app-no-drag z-10"
        onPointerDown={handlePointerDown("se")}
        aria-hidden="true"
      />
    </div>
  );
};
