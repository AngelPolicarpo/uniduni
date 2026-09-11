import { cn } from "../../lib/cn";

export interface SliderProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Texto à direita do label — "80%", por exemplo. */
  valueLabel?: string;
  className?: string;
}

/**
 * Slider (§6) — usado para volume individual de um participante de voz no
 * popover de perfil durante a chamada (§9, 2.3) e, quando a Camada 3
 * existir, para volume de entrada/saída em Configurações (§10, 3.1).
 *
 * Em cima do `input[type=range]` nativo: teclado, foco e semântica de
 * `slider` vêm do navegador em vez de reimplementados.
 */
export function Slider({
  label,
  value,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  valueLabel,
  className,
}: SliderProps) {
  const percent = ((value - min) / (max - min)) * 100;

  return (
    <label className={cn("flex flex-col gap-2", className)}>
      {/* Mesma linha de rótulo + valor do `TextField` com contador: `secondary`
          no rótulo, `tertiary` fica para o texto de apoio. */}
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-caption text-text-secondary uppercase">
          {label}
        </span>
        {valueLabel && (
          <span className="text-meta tabular-nums text-text-secondary">
            {valueLabel}
          </span>
        )}
      </span>

      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        style={{ "--slider-fill": `${percent}%` } as React.CSSProperties}
        className={cn(
          "h-1.5 w-full cursor-pointer appearance-none rounded-full",
          // Trilha preenchida até o valor, o resto em `border-default`.
          "bg-[linear-gradient(to_right,var(--color-accent-default)_var(--slider-fill),var(--color-border-default)_var(--slider-fill))]",
          "[&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none",
          "[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-text-primary",
          "[&::-moz-range-thumb]:size-3.5 [&::-moz-range-thumb]:rounded-full",
          "[&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-text-primary",
        )}
      />
    </label>
  );
}
