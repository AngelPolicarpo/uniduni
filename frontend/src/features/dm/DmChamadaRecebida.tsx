import { useEffect, useId, useRef, useState } from "react";
import { Phone, PhoneOff } from "lucide-react";

import { Avatar } from "../../components/ui/Avatar";
import { Button } from "../../components/ui/Button";
import { acoesDeChamada, corDoPar, nomeDoContato } from "./dmRegras";
import { useNomeLocalDoContato } from "./useNomeDoContato";
import { abrirConversa } from "../../live/dm";
import { chamar, desligar } from "../../live/dmVoz";
import { useDmCallStore } from "../../store/dmCallStore";
import { useDmStore } from "../../store/dmStore";
import { useUiStore } from "../../store/uiStore";

/**
 * U-33 (emenda de 2026-09-13) — **alguém está chamando você.**
 *
 * Até aqui a chamada que chega tinha o toque em laço de 3.1a e duas superfícies pequenas:
 * uma linha no painel acima da barra de usuário e um botão no cabeçalho da conversa. Nenhuma
 * das duas dizia *quem* com o peso que o momento tem, e a primeira some no Mobile quando o
 * conteúdo está em foco (§16) — o telefone tocava sem nada na tela para atender.
 *
 * O cartão é **a** superfície do estado `recebendo`, em qualquer destino e em qualquer
 * breakpoint. Por isso o painel da coluna e o cabeçalho se calam nesse estado: três pares
 * de "Atender/Recusar" na mesma tela é o argumento que já tirou mudo e ensurdecer do painel
 * da comunidade (§9, 2.3.1).
 *
 * **Não é modal, a não ser que precise.** Quem está escrevendo continua escrevendo — o
 * cartão não rouba foco nem escurece a tela. A exceção é medida, não gosto: com um `Modal`
 * aberto (§6), o `<dialog>` modal torna inerte tudo o que não é ele, *inclusive* o que
 * estiver acima no top layer (Chrome 151: um popover mostrado depois do modal não recebe
 * clique nem foco). Nesse caso o cartão sobe como modal por cima, com fundo transparente e
 * foco no próprio cartão — nunca num botão, para um Enter ou espaço que já vinha sendo
 * digitado não atender nem recusar por engano.
 *
 * O que ele **não** afirma é o de sempre (§31.15, 3.1a regra 5): nada sobre o aparelho do
 * outro lado. "Chamada recebida" é fato local.
 */
export function DmChamadaRecebida() {
  const conversationId = useDmCallStore((s) => s.conversationId);
  const estado = useDmCallStore((s) => s.estado);
  if (estado !== "recebendo" || conversationId === null) return null;
  // `key`: uma segunda chamada que chegasse sem o cartão desmontar começaria com o
  // "ocupado" da primeira.
  return <Cartao key={conversationId} conversationId={conversationId} />;
}

function Cartao({ conversationId }: { conversationId: string }) {
  const conversa = useDmStore((s) => s.conversas.find((c) => c.conversationId === conversationId));
  const nomeLocal = useNomeLocalDoContato(conversationId);
  const [ocupado, setOcupado] = useState<"atender" | "recusar" | null>(null);
  const ref = useRef<HTMLDialogElement>(null);
  const tituloId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;

    function acomodar(): void {
      if (dialog === null) return;
      const outroModal = Array.from(document.querySelectorAll("dialog")).some(
        (d) => d !== dialog && d.matches(":modal"),
      );
      if (outroModal) {
        if (dialog.matches(":modal")) return;
        if (dialog.open) dialog.close();
        dialog.showModal();
        // O foco inicial de `showModal()` é o primeiro botão (medido: o Recusar, mesmo com
        // `autofocus` no diálogo). Ele vai para o próprio cartão, que tem `tabIndex=-1`: o
        // Enter que vinha do formulário de baixo não pode recusar a chamada.
        dialog.focus({ preventScroll: true });
        return;
      }
      if (dialog.matches(":modal")) {
        // O modal de baixo fechou: o cartão volta a não bloquear nada.
        dialog.close();
      }
      if (!dialog.open) {
        // `show()` também roda os "dialog focusing steps" e leva o foco ao primeiro botão
        // (medido: o Recusar nascia focado). Não modal quer dizer não tirar o foco de quem
        // está escrevendo — ele volta para onde estava, e sem dono não fica num botão.
        const anterior = document.activeElement;
        dialog.show();
        if (anterior instanceof HTMLElement && anterior !== document.body) {
          anterior.focus({ preventScroll: true });
        } else if (document.activeElement instanceof HTMLElement && dialog.contains(document.activeElement)) {
          document.activeElement.blur();
        }
      }
    }

    acomodar();
    // Um modal aberto DEPOIS do cartão o deixaria inerte embaixo dele. Observar só o
    // atributo `open` é barato e cobre todo `<dialog>` do produto, sem cada um avisar.
    const observador = new MutationObserver(acomodar);
    observador.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ["open"],
    });
    return () => {
      observador.disconnect();
      if (dialog.open) dialog.close();
    };
  }, []);

  const nome = conversa ? nomeDoContato(conversa.peer, nomeLocal) : "Conversa direta";
  // A mesma regra do cabeçalho: sem a conversa no espelho, ou fora de `accepted`, não há
  // para onde levar a chamada — e recusar continua existindo nos dois casos.
  const podeAtender =
    conversa !== undefined && acoesDeChamada(conversa.state, "recebendo").includes("atender");

  function atender(): void {
    if (ocupado !== null) return;
    setOcupado("atender");
    // Atender LEVA para a conversa (emenda de 2026-09-05): a imagem, o mudo e o desligar
    // moram lá. E no Mobile o painel precisa avançar junto (emenda de 2026-09-09).
    const ui = useUiStore.getState();
    ui.abrirDm();
    ui.setMobilePane("content");
    void abrirConversa(conversationId);
    void chamar(conversationId);
  }

  function recusar(): void {
    if (ocupado !== null) return;
    setOcupado("recusar");
    void desligar();
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby={tituloId}
      tabIndex={-1}
      // `Esc` não recusa: recusar é um ato, e ele tem botão. Sem isto o navegador fecharia
      // o cartão com a chamada ainda tocando — e o observador o traria de volta.
      onCancel={(e) => e.preventDefault()}
      className={
        "app-no-drag fixed inset-x-4 top-12 bottom-auto z-[70] m-0 mx-auto h-auto w-auto " +
        "max-h-none max-w-[calc(100vw-32px)] tablet:w-[340px] " +
        "rounded-lg border border-border-default bg-surface-elevated p-0 text-text-primary " +
        "shadow-elevated animate-call-in backdrop:bg-transparent focus:outline-none"
      }
    >
      <div className="flex flex-col items-center px-4 pt-6 pb-4 text-center">
        <span className="relative grid place-items-center" aria-hidden="true">
          {/* Halo em expansão (decorativo) e anel estático (a forma que fica). */}
          <span className="absolute -inset-1.5 animate-call-ring rounded-full border-2 border-accent-default" />
          <span className="absolute -inset-1.5 rounded-full border-2 border-accent-default/40" />
          {conversa ? (
            <Avatar name={nome} color={corDoPar(conversa.peer.avatarColor)} size="lg" />
          ) : (
            // Contingência (emenda de 2026-09-09): sem a conversa no espelho não há nome
            // nem cor, e inventar um avatar seria inventar alguém.
            <span className="grid size-20 place-items-center rounded-full bg-surface-primary text-text-secondary">
              <Phone size={32} strokeWidth={1.5} />
            </span>
          )}
          {/* O telefone no canto: "é uma chamada" dito por forma, não só pela cor (§5.4).
              Na contingência o próprio centro já é o telefone. */}
          {conversa && (
            <span className="absolute -right-0.5 -bottom-0.5 grid size-7 place-items-center rounded-full border-2 border-surface-elevated bg-accent-default text-text-on-accent">
              <Phone size={14} strokeWidth={2} />
            </span>
          )}
        </span>

        <p className="mt-5 text-caption text-text-secondary uppercase">Chamada recebida</p>
        <h2 id={tituloId} className="mt-1 w-full truncate text-heading-2 text-text-primary">
          {nome}
        </h2>
        {conversa && (
          // O `handle` junto do nome, sempre (L-5) — e mais ainda aqui, onde o nome é o
          // que decide atender.
          <p className="mt-0.5 text-meta text-text-tertiary">{conversa.peer.handle}</p>
        )}

        {/* O anúncio para quem não está olhando para o topo da janela (§20.3). */}
        <p role="alert" className="sr-only">
          Chamada recebida de {nome}
        </p>

        <div className="mt-5 flex w-full gap-2">
          <Button
            variant="danger"
            size="lg"
            className="min-w-0 flex-1"
            onClick={recusar}
            loading={ocupado === "recusar"}
            disabled={ocupado === "atender"}
          >
            <PhoneOff size={20} strokeWidth={2} aria-hidden="true" />
            Recusar
          </Button>
          {podeAtender && (
            <Button
              size="lg"
              className="min-w-0 flex-1"
              onClick={atender}
              loading={ocupado === "atender"}
              disabled={ocupado === "recusar"}
            >
              <Phone size={20} strokeWidth={2} aria-hidden="true" />
              Atender
            </Button>
          )}
        </div>
      </div>
    </dialog>
  );
}
