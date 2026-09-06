import { useState } from "react";
import { Check, Shield, UserPlus } from "lucide-react";

import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { StatusBanner } from "../../components/ui/StatusBanner";
import { cn } from "../../lib/cn";
import { formatClock } from "../../lib/format";
import { DmPeerLabel } from "./DmPeerLabel";
import { DmBloquearModal, DmEsquecerModal } from "./DmDialogs";
import {
  aceitarConversa,
  abrirConversa,
  bloquearConversa,
  esquecerConversa,
} from "../../live/dm";
import {
  selecionarConversas,
  selecionarPedidos,
  useDmStore,
} from "../../store/dmStore";
import { useUiStore } from "../../store/uiStore";
import type { DmConversationItem } from "../../ipc/dto";

/**
 * A lista de conversas e a seção de pedidos — U-33, no slot de 240px da lista de canais.
 *
 * O pedido (`pending-in`) fica numa seção **própria** no topo, e não como uma conversa
 * comum. A razão é §31.9 regra 1: **aceitar é o que cria o meu core**, e portanto é um
 * ato. Uma linha que abrisse a conversa e aceitasse de passagem faria o ato acontecer por
 * engano, e ele não é desfazível — o `dm.hello` já estaria no log.
 */

function ItemDeConversa({
  item,
  ativa,
  onSelect,
}: {
  item: DmConversationItem;
  ativa: boolean;
  onSelect: () => void;
}) {
  const bloqueada = item.state === "blocked";
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={ativa ? "true" : undefined}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left",
        "hover:bg-surface-hover",
        ativa && "bg-surface-active",
        // `blocked` é histórico legível, como a comunidade encerrada de U-17.
        bloqueada && "opacity-60",
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <DmPeerLabel peer={item.peer} />
        {/*
          U-33 — "a linha de conversa mostra avatar, nome de exibição e o `handle` …, **o
          trecho da última mensagem**, a hora e o contador de não-lidas". O trecho é o que
          faltava, e ele não é enfeite: sem ele a lista de conversas de dois nomes conhecidos
          não diz qual das duas tem algo novo para ler.

          Tombstone (`excerpt: null`) tem frase própria, a mesma de `DmMessageRow`: mostrar a
          linha vazia devolveria o silêncio no lugar do fato (A26).
        */}
        {item.lastMessage && (
          // `pl-10` = a largura do avatar `md` (32px) mais o gap de 8px do `DmPeerLabel`:
          // o trecho alinha com o nome, não com a foto.
          <span className="truncate pl-10 text-caption text-text-tertiary">
            {item.lastMessage.excerpt ?? "Mensagem apagada"}
          </span>
        )}
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5">
        {item.lastMessage && (
          <span className="text-caption text-text-tertiary tabular-nums">
            {formatClock(new Date(item.lastMessage.ts))}
          </span>
        )}
        {item.unread.count > 0 && (
          <Badge
            tone="danger"
            count={item.unread.count}
            srLabel={`${item.unread.count} não lidas`}
          />
        )}
      </span>
    </button>
  );
}

function Pedido({ item }: { item: DmConversationItem }) {
  const [bloquear, setBloquear] = useState(false);
  const [esquecer, setEsquecer] = useState(false);

  return (
    <li className="rounded-md bg-surface-elevated p-2">
      <DmPeerLabel peer={item.peer} layout="stacked" />
      {item.pendingRecords !== undefined && (
        <p className="mt-1 text-caption text-text-tertiary tabular-nums">
          {item.pendingRecords} {item.pendingRecords === 1 ? "registro" : "registros"} recebidos
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {/* §31.9 regra 1 — o ato. Só aqui, e nunca por abrir a conversa. */}
        <Button size="sm" onClick={() => void aceitarConversa(item.conversationId)}>
          <Check size={16} strokeWidth={2} aria-hidden="true" />
          Aceitar
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setBloquear(true)}>
          Bloquear
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEsquecer(true)}>
          Recusar
        </Button>
      </div>

      <DmBloquearModal
        open={bloquear}
        nomeDoPar={item.peer.displayName}
        onClose={() => setBloquear(false)}
        onConfirm={() => void bloquearConversa(item.conversationId)}
      />
      <DmEsquecerModal
        open={esquecer}
        nomeDoPar={item.peer.displayName}
        onClose={() => setEsquecer(false)}
        onConfirm={() => void esquecerConversa(item.conversationId)}
      />
    </li>
  );
}

export function DmList({ className }: { className?: string }) {
  // O painel vazio da área de conteúdo oferece o mesmo ato, e as duas colunas não têm
  // componente em comum: quem guarda o modal é o `uiStore`.
  const onNovaConversa = useUiStore((s) => s.abrirNovaConversa);
  const conversas = useDmStore((s) => s.conversas);
  const ativa = useDmStore((s) => s.ativa);
  const noTeto = useDmStore((s) => s.pendentesNoTeto);

  const pedidos = selecionarPedidos(conversas);
  const abertas = selecionarConversas(conversas);

  return (
    <div
      className={cn(
        // §16 — no Mobile a lista É a tela (o rail de 72px fica ao lado); do Tablet para
        // cima ela volta aos 240px do slot da lista de canais.
        "flex min-w-0 flex-1 flex-col bg-surface-sidebar tablet:w-60 tablet:flex-none",
        className,
      )}
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border-subtle px-3">
        <h2 className="min-w-0 flex-1 text-body-emphasis text-text-primary">Conversas</h2>
        {/*
          §31.16.1 `dm.open` — a porta de entrada. Sem ela a DM só sabia RECEBER pedido, e
          o comando ficava sem chamador na tela: a mesma família do tópico declarado sem
          produtor que §82.3 nomeia. **L-24** é o que a torna um campo de chave e não uma
          busca — a chave de identidade É o endereço, e não há diretório a consultar.
        */}
        <Button
          variant="icon"
          size="sm"
          onClick={onNovaConversa}
          aria-label="Nova conversa"
          className="shrink-0"
        >
          <UserPlus size={16} strokeWidth={2} aria-hidden="true" />
        </Button>
      </header>

      {/*
        §31.9 regra 4 — o teto de pendentes **não** descarta o mais antigo em silêncio, e
        por isso ele precisa aparecer: um pedido recusado por teto que ninguém vê é o
        mesmo que o descarte silencioso que a regra recusa.
      */}
      {noTeto && (
        <StatusBanner tone="degraded">
          A fila de pedidos está cheia. Novos pedidos são recusados até você aceitar,
          recusar ou bloquear algum.
        </StatusBanner>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {pedidos.length > 0 && (
          <section aria-labelledby="dm-pedidos" className="mb-3">
            <h3
              id="dm-pedidos"
              className="mb-1 flex items-center gap-1.5 px-2 text-caption text-text-tertiary uppercase"
            >
              <Shield size={12} strokeWidth={2} aria-hidden="true" />
              Pedidos ({pedidos.length})
            </h3>
            <ul className="flex flex-col gap-1.5">
              {pedidos.map((p) => (
                <Pedido key={p.conversationId} item={p} />
              ))}
            </ul>
          </section>
        )}

        {abertas.length === 0 && pedidos.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-2 py-8 text-center">
            <p className="text-meta text-text-tertiary">Nenhuma conversa ainda.</p>
            {/*
              O vazio aponta a saída: com **L-24** não há busca, e sem esta indicação a
              tela deixava a pessoa sem próximo passo nenhum. Do Tablet para cima quem a
              aponta é o painel, que está vazio ao lado — dois convites para o mesmo ato
              deixavam o mais visível dos dois sem ação nenhuma.
            */}
            <Button size="sm" variant="ghost" onClick={onNovaConversa} className="tablet:hidden">
              <UserPlus size={16} strokeWidth={2} aria-hidden="true" />
              Nova conversa
            </Button>
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {abertas.map((c) => (
              <li key={c.conversationId}>
                <ItemDeConversa
                  item={c}
                  ativa={c.conversationId === ativa}
                  onSelect={() => void abrirConversa(c.conversationId)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
