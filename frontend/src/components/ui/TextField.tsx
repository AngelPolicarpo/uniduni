import type { ComponentPropsWithRef } from "react";
import { useId } from "react";
import { cn } from "../../lib/cn";
import { codePoints, cortarCodePoints } from "../../lib/texto";

export interface TextFieldProps
  extends Omit<ComponentPropsWithRef<"input">, "onChange"> {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Erro de validação é sempre inline, junto ao campo (§12). */
  error?: string;
  /** Texto de apoio; escondido enquanto houver erro. */
  hint?: string;
  /** Ativa o contador "12/32" à direita do rótulo (§7, 0.1). */
  showCounter?: boolean;
  /**
   * A partir de quantos caracteres o contador vira `feedback-warning`
   * (§7, 0.1: acima de 28 num limite de 32).
   */
  counterWarningAt?: number;
  /**
   * Teto em **code points** (§8.6), para campo cujo limite é do log.
   *
   * Substitui o `maxLength` do DOM, que conta unidades UTF-16 e por isso cortava
   * um nome de vinte emojis no meio — e substitui também a base do contador, que
   * mostrava "40/32" para o mesmo nome. Quando presente, o campo clampa a
   * digitação por code point e o `maxLength` do DOM não é aplicado.
   */
  limiteCp?: number;
}

export function TextField({
  label,
  value,
  onChange,
  error,
  hint,
  showCounter = false,
  counterWarningAt,
  maxLength,
  limiteCp,
  className,
  ...rest
}: TextFieldProps) {
  const inputId = useId();
  const errorId = `${inputId}-error`;
  const hintId = `${inputId}-hint`;

  const hasError = Boolean(error);
  // §8.6 — quando o limite é do log, a conta é em code points; senão, o que o
  // `maxLength` do DOM de fato aplica, que é unidade UTF-16.
  const contagem = limiteCp === undefined ? value.length : codePoints(value);
  const teto = limiteCp ?? maxLength;
  const isNearLimit =
    counterWarningAt !== undefined && contagem > counterWarningAt;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <label
          htmlFor={inputId}
          className="text-caption text-text-secondary uppercase"
        >
          {label}
        </label>

        {showCounter && teto !== undefined && (
          <span
            className={cn(
              "text-meta tabular-nums",
              isNearLimit ? "text-feedback-warning" : "text-text-tertiary",
            )}
            aria-hidden="true"
          >
            {contagem}/{teto}
          </span>
        )}
      </div>

      <input
        id={inputId}
        value={value}
        {...(limiteCp === undefined ? { maxLength } : {})}
        onChange={(event) =>
          onChange(
            limiteCp === undefined
              ? event.target.value
              : cortarCodePoints(event.target.value, limiteCp),
          )
        }
        aria-invalid={hasError || undefined}
        aria-describedby={hasError ? errorId : hint ? hintId : undefined}
        className={cn(
          "h-11 w-full rounded-md px-3",
          "bg-surface-app text-body text-text-primary",
          "placeholder:text-text-tertiary",
          "border transition-colors duration-(--duration-fast) ease-out",
          "focus:outline-none focus-visible:outline-none",
          hasError
            ? "border-feedback-danger focus:ring-2 focus:ring-feedback-danger/30"
            : "border-border-default focus:border-accent-default focus:ring-2 focus:ring-accent-muted-bg",
          "disabled:cursor-not-allowed disabled:border-border-subtle disabled:text-text-disabled",
        )}
        {...rest}
      />

      {hasError ? (
        <p id={errorId} className="text-meta text-feedback-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-meta text-text-tertiary">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
