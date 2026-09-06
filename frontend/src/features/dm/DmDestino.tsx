import { useEffect } from "react";
import { MessagesSquare, UserPlus } from "lucide-react";

import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/cn";
import { DmConversationView } from "./DmConversationView";
import { DmNovaConversaModal } from "./DmDialogs";
import {
  abrirConversa,
  abrirConversaCom,
  fecharConversa,
  sincronizarConversas,
  sincronizarPrefsDm,
} from "../../live/dm";
import { useDeeplinks } from "../../live/deeplink";
import { selecionarConversas, selecionarPedidos, useDmStore } from "../../store/dmStore";
import { useUiStore } from "../../store/uiStore";

/**
 * O destino da conversa direta — a proposta declarada de **B63(a)**, e nada além dela.
 *
 * B63(a) é decisão do operador e continua aberta: nem §31 nem `frontend.md` dizem se a
 * DM é entrada no rail, visão de topo separada ou parte do hub. A proposta escrita lá é
 * "entrada no topo do rail, que troca a sidebar pela lista de conversas e o painel
 * principal pela conversa — reusa o `AppShell` sem layout novo", e é o que está aqui.
 * Trocar de forma depois é trocar de lugar de montagem, não de componente: a lista e a
 * conversa não sabem onde estão.
 *
 * **A lista não é montada aqui.** Ela ocupa o slot de 240px da coluna da esquerda do
 * shell, junto do rail, porque a barra de usuário atravessa os dois (§8, 1.1) — montada
 * neste componente, ela ficava ao lado da coluna, que então assumia a largura intrínseca
 * da barra de usuário e esticava o rail. Quem oferece o ato de abrir conversa são as
 * duas colunas, e por isso o modal é estado de sessão (`uiStore`) e não deste componente;
 * o deep link `u/` (B64) o abre pelo mesmo caminho.
 */
export function DmDestino({ className }: { className?: string }) {
  const conversas = useDmStore((s) => s.conversas);
  const ativaId = useDmStore((s) => s.ativa);
  const mobilePane = useUiStore((s) => s.mobilePane);
  const setMobilePane = useUiStore((s) => s.setMobilePane);
  const nova = useUiStore((s) => s.dmNovaConversa);
  const abrirNova = useUiStore((s) => s.abrirNovaConversa);
  const fecharNovaModal = useUiStore((s) => s.fecharNovaConversa);

  // B64 — o link `u/` posiciona nesta tela com a chave preenchida (§3.5 regra 3: sem ação).
  const contato = useDeeplinks((s) => s.contato);
  const fecharContato = useDeeplinks((s) => s.fecharContato);
  useEffect(() => {
    if (contato !== null) abrirNova();
  }, [contato, abrirNova]);
  const fecharNova = () => {
    fecharNovaModal();
    fecharContato();
  };

  useEffect(() => {
    void sincronizarConversas();
    void sincronizarPrefsDm();
  }, []);

  // Sair do destino solta a residência do projetor (§31.16.1 `dm.activate`): sem isto, a
  // conversa que ficou aberta continuaria consumindo lote com ninguém olhando.
  useEffect(() => () => void fecharConversa(), []);

  const ativa = conversas.find((c) => c.conversationId === ativaId);
  const conteudoEmFoco = mobilePane === "content";
  // "Não há o que escolher" e "há, e nenhuma está aberta" são estados diferentes, e o
  // painel dizia a frase do segundo nos dois. Pedir para escolher numa tela sem nenhuma
  // conversa é apontar para uma lista vazia; o que falta ali é o primeiro passo.
  const semNenhuma =
    selecionarConversas(conversas).length === 0 && selecionarPedidos(conversas).length === 0;

  return (
    <div className={cn("flex min-h-0 flex-1", className)}>
      <DmNovaConversaModal
        key={contato?.peerKey ?? "manual"}
        open={nova}
        onClose={fecharNova}
        chaveInicial={contato?.peerKey ?? null}
        // Já na lista? Abre a que existe. `dm.open` é derivado (§31.2 regra 1) e seria
        // idempotente em `accepted`/`pending-out`, mas em `blocked` recusa e em
        // `pending-in` **aceita** — ver `DmNovaConversaModal`.
        onAbrir={(peerKey, jaExiste) =>
          void (jaExiste !== null ? abrirConversa(jaExiste) : abrirConversaCom(peerKey))
        }
      />

      {ativa ? (
        <DmConversationView
          // Trocar de conversa remonta a área: o rascunho do composer é daquela conversa
          // e não pode vazar para a próxima — o mesmo argumento do `key` do `ChannelView`.
          key={ativa.conversationId}
          conversa={ativa}
          onBack={() => setMobilePane("channels")}
          className={cn(!conteudoEmFoco && "hidden tablet:flex")}
        />
      ) : (
        <div
          className={cn(
            "flex min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-surface-primary p-8 text-center",
            !conteudoEmFoco && "hidden tablet:flex",
          )}
        >
          <MessagesSquare
            size={40}
            strokeWidth={1.5}
            className="text-text-tertiary"
            aria-hidden="true"
          />
          {semNenhuma ? (
            <>
              <p className="text-body text-text-secondary">Comece uma conversa direta.</p>
              {/*
                A ação primária fica no painel, e não na lista: com **L-24** não há busca,
                então abrir a primeira conversa é a única coisa que a tela pode fazer, e
                ela ocupava o canto menos visível enquanto o espaço maior não oferecia
                nada. O que a conversa direta é — sem host, e dependente de as duas pontas
                se encontrarem online — está no modal, no momento em que decide alguma
                coisa; repetido aqui, competia com o próprio botão.
              */}
              <Button onClick={abrirNova}>
                <UserPlus size={16} strokeWidth={2} aria-hidden="true" />
                Nova conversa
              </Button>
            </>
          ) : (
            <p className="text-body text-text-secondary">Escolha uma conversa.</p>
          )}
        </div>
      )}
    </div>
  );
}
