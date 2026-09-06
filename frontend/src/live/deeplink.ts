/**
 * Deep links (§3.5) — `join/<CODE16>`, `m/<MSGREF>` e `u/<KEY64>`.
 *
 * O main já validou a gramática fechada e encaminha dado estruturado; o renderer nunca vê a
 * string original. Aqui o link vira uma intenção pendente e **a UI vai para onde a
 * confirmação aparece**: `join` posiciona a prévia de 0.3 (a mesma tela, os mesmos seis
 * desfechos de §12.3), `m/` resolve por `query.resolveMessageLink`, cujos cinco desfechos de
 * §15.6 são estados de tela e não erros, e `u/` posiciona a "Nova conversa" com a chave
 * preenchida.
 *
 * §3.5 regra 3 vale para as três rotas: nenhuma dispara ação — `u/` nunca chama `dm.open`
 * sozinho, `join` nunca chama `invite.redeem` sozinho, só abrem a confirmação.
 *
 * **`assinarDeepLinks` precisa ser chamada, e é `App` quem chama.** Enquanto ninguém a
 * chamava, o `ouvirDeepLinks` abaixo nunca era registrado e todo link que o main entregava
 * caía no vazio: o teste passava porque chamava `receber()` direto, que é o degrau depois do
 * que faltava. A assinatura mora na raiz, acima do `Sincronizador`, porque um link pode
 * chegar enquanto o núcleo ainda está conectando (§92, mesma razão do `HostExitListener`).
 */

import { create } from "zustand";
import { ouvirDeepLinks, type DeepLink } from "../ipc/bridge";
import { usePendingInviteStore } from "../store/inviteStore";
import { useUiStore } from "../store/uiStore";
import type { ResolvedMessageLink } from "../ipc/dto";

interface Deeplinks {
  /** §15.6 — o MSGREF em voo e os cinco desfechos, para `DeepLinkMensagem` desenhar. */
  mensagem: { ref: string; resultado: ResolvedMessageLink | null } | null;
  /** B64 — a chave vinda do link `u/`, à espera da confirmação em "Nova conversa". */
  contato: { peerKey: string } | null;

  receber(link: DeepLink): Promise<void>;
  /**
   * O desfecho de §15.6 para o MSGREF em voo. Escrito por `DeepLinkMensagem`, que é quem
   * chama `query.resolveMessageLink` — e chama **quando há núcleo**. Resolver aqui, no
   * instante em que o link chega, transformava todo link recebido antes de o núcleo
   * responder num `malformed`, que é a tela de "link alterado": a resposta certa para um
   * link truncado, e a errada para um link bom que chegou dez segundos cedo demais.
   */
  definirResultado(ref: string, resultado: ResolvedMessageLink): void;
  fecharMensagem(): void;
  fecharContato(): void;
}

export const useDeeplinks = create<Deeplinks>((set) => ({
  mensagem: null,
  contato: null,

  async receber(link) {
    if (link.route === "user" && typeof link.key === "string") {
      // §3.5 regra 3: posiciona na confirmação, nunca dispara `dm.open`.
      set({ contato: { peerKey: link.key.toLowerCase() } });
      // **Posicionar inclui chegar lá.** Quem reage a `contato` e abre o modal é
      // `DmDestino`, e ele só está montado com o destino em `dm` (B63(a)): clicar num
      // `comunidadep2p://u/…` de dentro de uma comunidade guardava a chave num store que
      // ninguém estava olhando, e o app não fazia nada visível. "Sem ação" em §3.5 é sobre
      // **`dm.open`**, não sobre navegar — a navegação é o que torna a confirmação possível.
      useUiStore.getState().abrirDm();
      return;
    }
    if (link.route === "join" && link.code !== undefined) {
      /*
       * A prévia do convite é a de 0.3, e não uma segunda tela só para deep link.
       * Havia uma: este store guardava `convite.previa` resolvida por `invite.resolve`,
       * e nenhum componente a lia — dois caminhos para o mesmo desfecho, um deles sem
       * superfície. O que sobra é o de sempre: o código vira convite pendente e o
       * overlay de §11 A2 abre com ele, incluindo o passo por onboarding quando ainda
       * não há identidade.
       */
      usePendingInviteStore.getState().setPendingInvite(link.code);
      // Mesma regra do `u/`: posicionar inclui chegar lá. Com o destino em `dm`, o
      // overlay do shell continua montado, mas a pessoa cairia numa confirmação
      // flutuando sobre a lista de conversas.
      useUiStore.getState().abrirComunidades();
      useUiStore.getState().openJoinCommunity("link");
      return;
    }
    if (link.route === "message" && link.ref !== undefined) {
      set({ mensagem: { ref: link.ref, resultado: null } });
    }
  },

  definirResultado(ref, resultado) {
    set((s) => (s.mensagem?.ref === ref ? { mensagem: { ref, resultado } } : s));
  },

  fecharMensagem() {
    set({ mensagem: null });
  },

  fecharContato() {
    set({ contato: null });
  },
}));

export function assinarDeepLinks(): () => void {
  return ouvirDeepLinks((link) => {
    void useDeeplinks.getState().receber(link);
  });
}
