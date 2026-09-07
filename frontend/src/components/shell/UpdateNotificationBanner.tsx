import { useState, useEffect } from "react";
import { ArrowUpCircle, Download, RefreshCw, Sparkles, X } from "lucide-react";
import { useUpdateStore } from "../../store/updateStore";
import { useUiStore } from "../../store/uiStore";
import { cn } from "../../lib/cn";

export function UpdateNotificationBanner() {
  const { status, baixarAtualizacao, aplicarAtualizacao, baixando, inicializar } = useUpdateStore();
  const openAccountSettings = useUiStore((state) => state.openAccountSettings);
  const [dispensadoParaVersao, setDispensadoParaVersao] = useState<string | null>(null);

  useEffect(() => {
    void inicializar();
  }, [inicializar]);

  if (status.status !== "available" && status.status !== "ready") {
    return null;
  }

  if (dispensadoParaVersao === status.version) {
    return null;
  }

  const isReady = status.status === "ready";

  return (
    <aside
      aria-label="Aviso de atualização"
      className={cn(
        "flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2 text-meta transition-colors",
        isReady
          ? "border-conn-ok/40 bg-conn-ok/15 text-text-primary"
          : "border-conn-reconnecting/40 bg-conn-reconnecting/15 text-text-primary",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {isReady ? (
          <ArrowUpCircle size={16} className="shrink-0 text-conn-ok" />
        ) : (
          <Sparkles size={16} className="shrink-0 text-conn-reconnecting" />
        )}
        <span className="truncate">
          {isReady
            ? `Versão ${status.version} pronta para instalação.`
            : `Nova versão ${status.version} disponível.`}
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {isReady ? (
          <button
            type="button"
            onClick={() => void aplicarAtualizacao()}
            className="flex items-center gap-1.5 rounded bg-conn-ok/20 px-2.5 py-1 font-medium text-text-primary hover:bg-conn-ok/30 focus:outline-none"
          >
            <RefreshCw size={12} />
            Reiniciar agora
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void baixarAtualizacao()}
              disabled={baixando}
              className="flex items-center gap-1.5 rounded bg-conn-reconnecting/20 px-2.5 py-1 font-medium text-text-primary hover:bg-conn-reconnecting/30 focus:outline-none disabled:opacity-50"
            >
              <Download size={12} />
              {baixando ? "Baixando..." : "Baixar"}
            </button>
            <button
              type="button"
              onClick={() => openAccountSettings()}
              className="rounded px-2 py-1 text-text-secondary hover:bg-surface-elevated hover:text-text-primary focus:outline-none"
            >
              Detalhes
            </button>
          </>
        )}

        <button
          type="button"
          onClick={() => setDispensadoParaVersao(status.version)}
          aria-label="Dispensar aviso de atualização"
          className="rounded p-1 text-text-tertiary hover:bg-surface-elevated hover:text-text-primary focus:outline-none"
        >
          <X size={14} />
        </button>
      </div>
    </aside>
  );
}
