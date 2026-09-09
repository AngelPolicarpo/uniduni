import type { ComponentPropsWithRef } from "react";
import { useId } from "react";
import { cn } from "../../lib/cn";
import { codePoints, cortarCodePoints } from "../../lib/texto";

export interface TextAreaProps
  extends Omit<ComponentPropsWithRef<"textarea">, "onChange"> {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: string;
  showCounter?: boolean;
  counterWarningAt?: number;
  /**
   * Teto em **code points** (§8.6), para campo cujo limite é do log.
   * Substitui o `maxLength` do DOM e a base do contador.
   */
  limiteCp?: number;
}

/** Textarea de formulário (§6) — mesmas regras de estado do `TextField`. */
export function TextArea({
  label,
  value,
  onChange,
  error,
  hint,
  showCounter = false,
  counterWarningAt,
  maxLength,
  limiteCp,
  rows = 3,
  className,
  ...rest
}: TextAreaProps) {
  const fieldId = useId();
  const errorId = `${fieldId}-error`;
  const hintId = `${fieldId}-hint`;

  const hasError = Boolean(error);
  const contagem = limiteCp === undefined ? value.length : codePoints(value);
  const teto = limiteCp ?? maxLength;
  const isNearLimit =
    counterWarningAt !== undefined && contagem > counterWarningAt;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <label
          htmlFor={fieldId}
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

      <textarea
        id={fieldId}
        value={value}
        rows={rows}
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
          "w-full resize-none rounded-md px-3 py-2",
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
