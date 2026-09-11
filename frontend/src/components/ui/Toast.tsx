import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { cn } from "../../lib/cn";
import {
  TOAST_DURATION_MS,
  useToastStore,
  type Toast as ToastData,
  type ToastVariant,
} from "../../store/toastStore";

const ICON: Record<ToastVariant, typeof Info> = {
  success: CheckCircle2,
  info: Info,
  warning: AlertTriangle,
  error: XCircle,
};

const ICON_CLASS: Record<ToastVariant, string> = {
  success: "text-feedback-success",
  info: "text-feedback-info",
  warning: "text-feedback-warning",
  error: "text-feedback-danger",
};

function ToastItem({ toast }: { toast: ToastData }) {
  const dismissToast = useToastStore((state) => state.dismissToast);
  const [leaving, setLeaving] = useState(false);
  const Icon = ICON[toast.variant];

  useEffect(() => {
    // Erro fica até ser dispensado manualmente (§15).
    if (toast.variant === "error") return;
    const timer = window.setTimeout(() => setLeaving(true), TOAST_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [toast.variant]);

  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => dismissToast(toast.id), 180);
    return () => window.clearTimeout(timer);
  }, [leaving, dismissToast, toast.id]);

  return (
    /*
      Sem `role="status"` aqui: a pilha abaixo já é `aria-live="polite"`, e região
      viva dentro de região viva faz parte dos leitores de tela anunciarem a mesma
      mensagem duas vezes. Quem precisa existir antes da mensagem é o contêiner —
      um live region criado junto com o conteúdo costuma não ser anunciado.
    */
    <div
      className={cn(
        "pointer-events-auto flex w-[320px] max-w-[calc(100vw-32px)] items-start gap-3",
        "rounded-md border border-border-default bg-surface-elevated p-3 shadow-elevated",
        leaving ? "animate-toast-out" : "animate-toast-in",
      )}
    >
      <Icon
        size={20}
        strokeWidth={2}
        className={cn("mt-px shrink-0", ICON_CLASS[toast.variant])}
        aria-hidden="true"
      />
      <p className="min-w-0 flex-1 text-body text-text-primary">
        {toast.message}
      </p>
      <button
        type="button"
        onClick={() => setLeaving(true)}
        aria-label="Dispensar"
        className={cn(
          "-mt-1 -mr-1 grid size-6 shrink-0 place-items-center rounded-sm",
          "text-text-tertiary transition-colors duration-(--duration-fast) ease-out",
          "hover:bg-surface-primary hover:text-text-primary",
        )}
      >
        <X size={16} strokeWidth={2} />
      </button>
    </div>
  );
}

/**
 * Pilha de toasts no canto inferior direito (§6, §15). Fica montada uma vez
 * na raiz do app; qualquer tela publica através de `useToastStore`.
 */
export function ToastViewport() {
  const toasts = useToastStore((state) => state.toasts);

  return (
    <div
      className="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col items-end gap-2"
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
