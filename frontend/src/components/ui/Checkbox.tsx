import { Check } from "lucide-react";
import { cn } from "../../lib/cn";

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  className?: string;
  /**
   * Caixa visível e inerte. É o que §20.3 (regra 8) pede no checklist de permissões: a
   * permissão que o autor não pode conceder continua no catálogo — se sumisse, o catálogo
   * pareceria menor do que é —, mas não é marcável.
   */
  disabled?: boolean;
  /** Motivo do desabilitado, dito e não escondido. */
  title?: string;
}

/**
 * Checkbox (§6) — em cima do input nativo, que continua sendo o alvo real de
 * clique e teclado; o quadrado desenhado é só a camada visual.
 */
export function Checkbox({
  checked,
  onChange,
  label,
  className,
  disabled = false,
  title,
}: CheckboxProps) {
  return (
    <label
      title={title}
      className={cn(
        "flex items-center gap-2 text-body",
        disabled
          ? "cursor-not-allowed text-text-disabled"
          : "cursor-pointer text-text-secondary",
        className,
      )}
    >
      <span className="relative inline-flex size-4 shrink-0">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          className={cn(
            "peer size-4 appearance-none rounded-sm border border-border-strong bg-surface-primary",
            "checked:border-accent-default checked:bg-accent-default",
            disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
          )}
        />
        <Check
          size={12}
          strokeWidth={3}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 m-auto text-text-on-accent opacity-0 peer-checked:opacity-100"
        />
      </span>
      {label}
    </label>
  );
}
