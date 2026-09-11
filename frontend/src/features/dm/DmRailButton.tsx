import { MessagesSquare } from "lucide-react";

import { Badge } from "../../components/ui/Badge";
import { Tooltip } from "../../components/ui/Tooltip";
import { cn } from "../../lib/cn";
import { useDmStore } from "../../store/dmStore";
import { useSettingsStore } from "../../store/settingsStore";
import { useUiStore } from "../../store/uiStore";
import { contarPendentesDm } from "./dmRegras";

/**
 * A entrada da conversa direta no topo do rail (B63(a), decidido: é aqui que ela mora).
 *
 * A gramática do rail é a de §8 1.1 e não muda: barra vertical de 4px quando ativo, ícone
 * que "quadra" no ativo/hover, badge numérico `feedback-danger` no canto. O que ele conta
 * é pedidos mais não lidas das conversas com som (B63(b)) — um pedido é exatamente a
 * coisa que não pode ficar invisível (§31.9 regra 4).
 */
export function DmRailButton() {
  const conversas = useDmStore((s) => s.conversas);
  const mudas = useSettingsStore((s) => s.dmMutedByConversation);
  const destino = useUiStore((s) => s.destino);
  const abrirDm = useUiStore((s) => s.abrirDm);

  const ativo = destino === "dm";
  const total = contarPendentesDm(conversas, mudas);

  return (
    <div className="relative flex w-full justify-center">
      <Tooltip label="Conversas diretas">
        <button
          type="button"
          onClick={abrirDm}
          aria-current={ativo ? "true" : undefined}
          className={cn(
            "relative grid size-12 place-items-center",
            "transition-all duration-(--duration-base) ease-out",
            ativo
              ? "rounded-lg bg-accent-default text-text-on-accent"
              : "rounded-full bg-surface-sidebar text-text-secondary hover:rounded-lg hover:bg-accent-default hover:text-text-on-accent",
          )}
        >
          <MessagesSquare size={24} strokeWidth={2} aria-hidden="true" />
          <span className="sr-only">Conversas diretas</span>
          {total > 0 && (
            <Badge
              tone="danger"
              count={total}
              srLabel={`${total} pendentes`}
              className="absolute -right-1 -bottom-1"
            />
          )}
        </button>
      </Tooltip>

      {/*
        A MESMA barra do `CommunityIcon`, e não uma parecida. Esta estava em
        `-left-2`: o wrapper ocupa a largura do rail, então −8px caía FORA dele e
        a barra de ativo da conversa direta nunca aparecia. E, quando aparecesse,
        estaria errada duas vezes — `h-6` onde a gramática de §8 1.1 dá `h-8` ao
        ativo, e `bg-text-primary`, que naquela gramática é a cor do NÃO-LIDO.
      */}
      <span
        className={cn(
          "absolute top-1/2 left-0 w-1 -translate-y-1/2 rounded-r-full",
          "transition-all duration-(--duration-base) ease-out",
          ativo
            ? "h-8 bg-accent-default opacity-100"
            : total > 0
              ? "h-2 bg-text-primary opacity-100"
              : "h-0 opacity-0",
        )}
        aria-hidden="true"
      />
    </div>
  );
}
