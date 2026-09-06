import { useRef, useState } from "react";
import { ChevronDown, ChevronUp, GripVertical } from "lucide-react";
import { cn } from "../../lib/cn";
import { Tooltip } from "../../components/ui/Tooltip";
import { AVATAR_BG_CLASS } from "../../lib/avatar";
import { ROLE_TEXT_CLASS } from "../../lib/role";
import type { Role } from "../../domain/types";

/** Altura da linha da lista — usada para saber quando o arrasto troca de posição. */
const ROW_HEIGHT = 36;

export interface RoleListProps {
  roles: Role[];
  selectedId: string;
  onSelect: (roleId: string) => void;
  /** Commit da reordenação — UMA op de §15.4, disparada no drop. */
  mover: (roleId: string, paraIndice: number) => void;
  desabilitado: boolean;
  motivoDesabilitado?: string;
  /**
   * `topRank(autor)` na ordinalização de `adaptadores.cargo` (§9.3). Cargo com posição maior
   * ou igual a esta não é movível pelo autor — `E_HIERARCHY` no núcleo (R-4).
   */
  minhaPosicao: number;
}

/**
 * Lista de cargos ordenada por hierarquia, do topo para baixo. Reordenável
 * por arrasto (§10, 3.2) **e** pelos botões de mover: arrastar é preciso,
 * mas não é alcançável por teclado, e §19.4 exige caminho equivalente.
 */
export function RoleList({
  roles,
  selectedId,
  onSelect,
  mover,
  desabilitado,
  motivoDesabilitado,
  minhaPosicao,
}: RoleListProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragState = useRef<{ id: string; lastY: number; indice: number } | null>(null);
  /**
   * Ordem só do gesto. `role.move` é op SÍNCRONA (A25/U-02): commitar a cada linha cruzada
   * mandaria uma op por linha e queimaria o rate limit de §14.4, do mesmo jeito que o
   * auto-save fazia nos formulários. O arrasto mostra o preview; o drop manda uma op.
   */
  const [preview, setPreview] = useState<Role[] | null>(null);
  const exibidos = preview ?? roles;

  /**
   * §20.3 (regra 8): a lista não oferece o movimento que o `fold` já recusa. Fundador é topo
   * fixo (`E_FOUNDER_TOP`), o cargo base é o piso sentinela de §6.4.1 (`RANK_BOTTOM`), e
   * cargo com `rank ≥` o topo do autor é `E_HIERARCHY` por R-4.
   */
  function motivoDeNaoMover(role: Role): string | null {
    if (role.isFounder) return "Fundador é sempre o topo da hierarquia";
    if (role.isDefault) return "O cargo base é sempre o último da hierarquia";
    if (minhaPosicao <= role.position) return "Este cargo está acima do seu na hierarquia";
    if (desabilitado) return motivoDesabilitado ?? null;
    return null;
  }

  function handlePointerDown(
    event: React.PointerEvent<HTMLButtonElement>,
    role: Role,
  ) {
    if (motivoDeNaoMover(role) !== null) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragState.current = {
      id: role.id,
      lastY: event.clientY,
      indice: roles.findIndex((r) => r.id === role.id),
    };
    setDraggingId(role.id);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    const drag = dragState.current;
    if (!drag) return;
    const delta = event.clientY - drag.lastY;
    if (Math.abs(delta) < ROW_HEIGHT) return;
    const base = preview ?? roles;
    const de = base.findIndex((r) => r.id === drag.id);
    // O Fundador ocupa o índice 0 e não sai de lá; o cargo base ocupa o último e também não.
    // E o teto do arrasto é o primeiro índice que o autor alcança: subir acima do próprio
    // topo é `E_HIERARCHY`, e o preview não promete o que a op não entrega.
    const teto = Math.max(base.findIndex((r) => minhaPosicao > r.position), 1);
    const piso = base[base.length - 1]?.isDefault === true ? base.length - 2 : base.length - 1;
    const para = Math.min(Math.max(de + (delta > 0 ? 1 : -1), teto), Math.max(piso, teto));
    if (para !== de) {
      const proxima = [...base];
      const [movido] = proxima.splice(de, 1);
      proxima.splice(para, 0, movido!);
      setPreview(proxima);
    }
    drag.lastY = event.clientY;
  }

  function endDrag() {
    const drag = dragState.current;
    dragState.current = null;
    setDraggingId(null);
    if (drag === null) return;
    const destino = (preview ?? roles).findIndex((r) => r.id === drag.id);
    setPreview(null);
    if (destino >= 0 && destino !== drag.indice) mover(drag.id, destino);
  }

  return (
    <ul className="flex flex-col gap-0.5">
      {exibidos.map((role, index) => {
        const active = role.id === selectedId;
        const bloqueio = motivoDeNaoMover(role);
        const acima = exibidos[index - 1];
        const abaixo = exibidos[index + 1];
        const canMoveUp =
          bloqueio === null &&
          acima !== undefined &&
          !acima.isFounder &&
          minhaPosicao > acima.position;
        const canMoveDown =
          bloqueio === null && abaixo !== undefined && !abaixo.isDefault;

        return (
          <li
            key={role.id}
            className={cn(
              "group flex items-center gap-1 rounded-md pr-1",
              // §17 — o item levanta levemente e os demais deslizam.
              draggingId === role.id &&
                "bg-surface-elevated shadow-elevated ring-1 ring-border-strong",
              active && draggingId !== role.id && "bg-accent-muted-bg",
            )}
          >
            <Tooltip label={bloqueio ?? "Arraste para reordenar"} side="top">
              <button
                type="button"
                aria-label={`Arrastar ${role.name || "cargo sem nome"}`}
                onPointerDown={(event) => handlePointerDown(event, role)}
                onPointerMove={handlePointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                className={cn(
                  "grid size-6 shrink-0 place-items-center rounded-sm text-text-tertiary",
                  bloqueio !== null
                    ? "cursor-not-allowed opacity-40"
                    : "cursor-grab hover:text-text-secondary",
                )}
              >
                <GripVertical size={16} strokeWidth={2} aria-hidden="true" />
              </button>
            </Tooltip>

            <button
              type="button"
              onClick={() => onSelect(role.id)}
              aria-current={active ? "true" : undefined}
              className={cn(
                "flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-1 text-left",
                "transition-colors duration-(--duration-fast) ease-out",
                !active && "hover:bg-surface-primary",
              )}
            >
              <span
                className={cn(
                  "size-2.5 shrink-0 rounded-full",
                  AVATAR_BG_CLASS[role.color],
                )}
                aria-hidden="true"
              />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-body",
                  role.name ? ROLE_TEXT_CLASS[role.color] : "text-text-tertiary",
                )}
              >
                {role.name || "Cargo sem nome"}
              </span>
            </button>

            <span className="flex shrink-0 opacity-0 transition-opacity duration-(--duration-fast) group-hover:opacity-100 focus-within:opacity-100">
              <button
                type="button"
                disabled={!canMoveUp}
                title={bloqueio ?? undefined}
                onClick={() => mover(role.id, index - 1)}
                aria-label={`Mover ${role.name || "cargo"} para cima`}
                className="grid size-6 place-items-center rounded-sm text-text-tertiary hover:text-text-primary disabled:opacity-30"
              >
                <ChevronUp size={16} strokeWidth={2} aria-hidden="true" />
              </button>
              <button
                type="button"
                disabled={!canMoveDown}
                title={bloqueio ?? undefined}
                onClick={() => mover(role.id, index + 1)}
                aria-label={`Mover ${role.name || "cargo"} para baixo`}
                className="grid size-6 place-items-center rounded-sm text-text-tertiary hover:text-text-primary disabled:opacity-30"
              >
                <ChevronDown size={16} strokeWidth={2} aria-hidden="true" />
              </button>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
