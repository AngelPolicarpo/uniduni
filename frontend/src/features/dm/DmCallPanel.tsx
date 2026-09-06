import { Phone, PhoneOff } from "lucide-react";

import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/cn";
import { DmPeerLabel } from "./DmPeerLabel";
import { acoesDeChamada, rotuloDoPainelDeChamada } from "./dmRegras";
import { abrirConversa } from "../../live/dm";
import { chamar, desligar } from "../../live/dmVoz";
import { useDmCallStore } from "../../store/dmCallStore";
import { useDmStore } from "../../store/dmStore";
import { useUiStore } from "../../store/uiStore";

/**
 * §31.15 / U-33 (emenda de 2026-09-05) — **a chamada de DM que sobrevive à navegação.**
 *
 * É o análogo do `VoicePanel` de §9 2.3.1, no mesmo slot acima da barra de usuário, e ele
 * fecha o buraco que a conversa direta tinha: atender e desligar só existiam no cabeçalho da
 * conversa, sob a guarda `chamadaId === conversa.conversationId`. Consequência, medida no
 * código: uma chamada que chegasse com o app noutra conversa — ou numa comunidade — não
 * tinha superfície nenhuma. Ela nem podia ser recusada, e ainda impedia iniciar outra, com
 * "Você já está numa chamada" (§15.4) para uma chamada que ninguém via.
 *
 * **O que ele não traz**, e cada ausência é uma linha da tabela de remoções de §31.15: não
 * há roster (numa dupla ele é a conversa), não há ocupação, não há fila e não há revogação.
 * Câmera e tela também não estão aqui — elas produzem imagem, e a imagem mora no
 * `DmVideoPanel`, dentro da conversa. É por isso que atender **leva** para a conversa: uma
 * chamada atendida sem as suas imagens e sem o seu mudo seria a metade que a pessoa não
 * pediu.
 *
 * Não coexiste com o `VoicePanel`: §15.4 diz "voz é uma só", e a store guarda uma conversa.
 */
export function DmCallPanel({ className }: { className?: string }) {
  const conversationId = useDmCallStore((s) => s.conversationId);
  const estado = useDmCallStore((s) => s.estado);
  const conversas = useDmStore((s) => s.conversas);
  const ativa = useDmStore((s) => s.ativa);
  const destino = useUiStore((s) => s.destino);
  const abrirDm = useUiStore((s) => s.abrirDm);

  if (conversationId === null) return null;

  const rotulo = rotuloDoPainelDeChamada(estado);
  if (rotulo === null) return null;

  // A conversa aberta já tem tudo isto no cabeçalho, e mais: mudo, câmera, tela e o palco.
  // Repetir o par de botões 8px acima seria o mesmo interruptor duas vezes na mesma coluna
  // — o argumento que tirou mudo e ensurdecer do `VoicePanel`.
  const naTela = destino === "dm" && ativa === conversationId;
  if (naTela) return null;

  const conversa = conversas.find((c) => c.conversationId === conversationId);
  const acoes = acoesDeChamada("accepted", estado);

  function irParaAConversa(): void {
    if (conversationId === null) return;
    abrirDm();
    void abrirConversa(conversationId);
  }

  return (
    <div
      className={cn(
        "flex shrink-0 flex-col gap-1.5 border-t border-border-subtle bg-surface-sidebar px-2 py-2",
        className,
      )}
      // §20.3 — a chamada que chega é notícia, e ela precisa ser anunciada a quem não
      // está olhando para esta coluna.
      role={estado === "recebendo" ? "alert" : "status"}
    >
      <p className="px-1 text-caption text-text-tertiary">{rotulo}</p>

      {conversa ? (
        <button
          type="button"
          onClick={irParaAConversa}
          className="flex min-w-0 rounded-md px-1 py-0.5 text-left hover:bg-surface-hover"
        >
          <DmPeerLabel peer={conversa.peer} size="sm" />
        </button>
      ) : (
        // A conversa saiu da lista (esquecida noutro caminho) e a chamada ficou: o painel
        // continua sendo a única saída dela, e some com um nome a menos, nunca com o botão.
        <p className="px-1 text-meta text-text-secondary">Conversa direta</p>
      )}

      <div className="flex gap-1.5">
        {acoes.includes("atender") && (
          <Button
            size="sm"
            className="min-w-0 flex-1"
            onClick={() => {
              irParaAConversa();
              void chamar(conversationId);
            }}
          >
            <Phone size={16} strokeWidth={2} aria-hidden="true" />
            Atender
          </Button>
        )}
        {acoes.includes("desligar") && (
          <Button
            variant="danger"
            size="sm"
            className="min-w-0 flex-1"
            onClick={() => void desligar()}
          >
            <PhoneOff size={16} strokeWidth={2} aria-hidden="true" />
            {estado === "recebendo" ? "Recusar" : "Desligar"}
          </Button>
        )}
      </div>
    </div>
  );
}
