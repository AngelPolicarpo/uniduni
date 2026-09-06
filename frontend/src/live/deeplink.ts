/**
 * Deep links (§3.5) — `join/<código>`, `m/<MSGREF>` e `u/<KEY64>` (B64).
 *
 * O main já validou a gramática fechada e encaminha dado estruturado; o renderer nunca vê a
 * string original. Aqui o link vira uma intenção pendente: `join` abre a prévia do convite
 * (`invite.resolve`, classe `open` — funciona antes de qualquer identidade), `m/` resolve
 * por `query.resolveMessageLink`, cujos cinco desfechos de §15.6 são estados de tela, não
 * erros, e `u/` posiciona a "Nova conversa" com a chave preenchida.
 *
 * §3.5 regra 3 vale para as três rotas: nenhuma dispara ação — `u/` nunca chama `dm.open`
 * sozinho, só abre a confirmação.
 */

import { create } from "zustand";
import { api } from "../ipc/api";
import { ouvirDeepLinks, type DeepLink } from "../ipc/bridge";
import { useUiStore } from "../store/uiStore";
import type { InvitePreview, ResolvedMessageLink } from "../ipc/dto";

interface Deeplinks {
  convite: { code: string; previa: InvitePreview | null; erro: string | null; resolvendo: boolean } | null;
  mensagem: { ref: string; resultado: ResolvedMessageLink | null } | null;
  /** B64 — a chave vinda do link `u/`, à espera da confirmação em "Nova conversa". */
  contato: { peerKey: string } | null;

  receber(link: DeepLink): Promise<void>;
  abrirConvite(codeOrLink: string): Promise<void>;
  fecharConvite(): void;
  fecharMensagem(): void;
  fecharContato(): void;
}

export const useDeeplinks = create<Deeplinks>((set, get) => ({
  convite: null,
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
      await get().abrirConvite(link.code);
      return;
    }
    if (link.route === "message" && link.ref !== undefined) {
      const ref = link.ref;
      set({ mensagem: { ref, resultado: null } });
      const resultado = await api
        .resolveMessageLink(ref)
        .catch<ResolvedMessageLink>(() => ({ status: "malformed" }));
      set((s) => (s.mensagem?.ref === ref ? { mensagem: { ref, resultado } } : s));
    }
  },

  async abrirConvite(codeOrLink) {
    set({ convite: { code: codeOrLink, previa: null, erro: null, resolvendo: true } });
    try {
      const previa = await api.inviteResolve(codeOrLink);
      set((s) => (s.convite?.code === codeOrLink ? { convite: { code: codeOrLink, previa, erro: null, resolvendo: false } } : s));
    } catch (e) {
      const erro = e instanceof Error ? e.message : "convite inválido";
      set((s) => (s.convite?.code === codeOrLink ? { convite: { code: codeOrLink, previa: null, erro, resolvendo: false } } : s));
    }
  },

  fecharConvite() {
    set({ convite: null });
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
