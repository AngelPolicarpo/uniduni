import { useEffect, useState } from "react";
import { Copy, Minus, Network, Square, X } from "lucide-react";

/**
 * Titlebar customizada do Uniduni.
 *
 * Substitui os controles nativos do sistema operacional / Electron por uma barra
 * integrada ao design system do projeto (superfície `surface-app`, borda `border-subtle`,
 * ícones do padrão Lucide e estados de hover consistentes).
 *
 * Integração com o Electron:
 * - Área de arrasto via `.app-drag-region` (-webkit-app-region: drag).
 * - Botões e elementos interativos protegidos com `.app-no-drag`.
 * - Duplo clique na barra alterna maximização/restauração da janela.
 * - Sincronização em tempo real do estado maximizado via IPC.
 * - Fechamento aciona o ciclo gracioso existente no Electron (`close` -> `exit-impact`).
 */
export function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (!window.electron?.windowIsMaximized) return;

    void window.electron.windowIsMaximized().then((max) => {
      setIsMaximized(Boolean(max));
    });

    const handleMaximizedChange = (isMax: unknown) => {
      setIsMaximized(Boolean(isMax));
    };

    window.electron.on("window-maximized-change", handleMaximizedChange);

    return () => {
      window.electron?.off("window-maximized-change", handleMaximizedChange);
    };
  }, []);

  const handleDoubleClick = (event: React.MouseEvent) => {
    // Evita ação se o duplo clique foi em um botão interativo
    if ((event.target as HTMLElement).closest(".app-no-drag")) return;
    void window.electron?.windowMaximize?.();
  };

  const handleMinimize = () => {
    void window.electron?.windowMinimize?.();
  };

  const handleMaximize = () => {
    void window.electron?.windowMaximize?.();
  };

  const handleClose = () => {
    void window.electron?.windowClose?.();
  };

  return (
    <header
      role="banner"
      aria-label="Barra de título"
      onDoubleClick={handleDoubleClick}
      className="app-drag-region flex h-8 w-full shrink-0 select-none items-center justify-between border-b border-border-subtle bg-surface-app text-text-secondary"
    >
      <div className="flex items-center gap-2 px-3">
        <Network size={14} strokeWidth={2} className="text-accent-default" aria-hidden="true" />
        <span className="text-caption font-medium tracking-normal text-text-secondary">
          Uniduni
        </span>
      </div>

      <div className="app-no-drag flex h-full items-center">
        <button
          type="button"
          onClick={handleMinimize}
          title="Minimizar"
          aria-label="Minimizar"
          className="app-no-drag grid h-full w-10 place-items-center text-text-secondary transition-colors duration-(--duration-fast) ease-out hover:bg-surface-elevated hover:text-text-primary active:bg-surface-elevated/70"
        >
          <Minus size={14} strokeWidth={2} aria-hidden="true" />
        </button>

        <button
          type="button"
          onClick={handleMaximize}
          title={isMaximized ? "Restaurar" : "Maximizar"}
          aria-label={isMaximized ? "Restaurar" : "Maximizar"}
          className="app-no-drag grid h-full w-10 place-items-center text-text-secondary transition-colors duration-(--duration-fast) ease-out hover:bg-surface-elevated hover:text-text-primary active:bg-surface-elevated/70"
        >
          {isMaximized ? (
            <Copy size={12} strokeWidth={2} aria-hidden="true" />
          ) : (
            <Square size={12} strokeWidth={2} aria-hidden="true" />
          )}
        </button>

        <button
          type="button"
          onClick={handleClose}
          title="Fechar"
          aria-label="Fechar"
          className="app-no-drag grid h-full w-10 place-items-center text-text-secondary transition-colors duration-(--duration-fast) ease-out hover:bg-feedback-danger hover:text-text-on-accent active:bg-feedback-danger/80"
        >
          <X size={14} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
