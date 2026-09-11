import { useEffect, useLayoutEffect, useRef } from "react";
import {
  selectFirstTextChannelId,
  useCommunityStore,
} from "../../store/communityStore";
import { usePendingInviteStore } from "../../store/inviteStore";
import { useSettingsStore } from "../../store/settingsStore";
import { useUiStore } from "../../store/uiStore";
import { useVoiceStore } from "../../store/voiceStore";
import { chaveDoAlvo, deveRecolherAGrade } from "./recolhimentoDaVoz";

/**
 * Efeitos globais do shell (§8/§11/Épico 4). Ficam fora do componente porque
 * são ouvintes de janela e correções de estado, não desenho: separá-los deixa
 * o `AppShell` com a árvore que ele monta, e cada regra com um nome.
 */

/**
 * Convite guardado por `/invite/:code` ou por um deep link `join/` retoma o preview
 * automaticamente, sem exigir colar o código de novo (§11, A2 passo 3; §3.5 regra 3).
 *
 * **`useLayoutEffect`, e não `useEffect`.** Com o efeito comum, o shell pintava um quadro
 * inteiro antes de o modal existir: quem chega por convite sem nenhuma comunidade via o
 * Hub vazio piscar antes da prévia. O layout effect roda antes do paint, então a decisão
 * "há convite pendente" já vale no primeiro quadro.
 *
 * O código **inválido** também abre a tela: mapeá-lo para "não havia convite" mandava a
 * pessoa para o app comum sem nada dizer que o link que a trouxe não servia.
 */
export function usePendingInviteOverlay() {
  const pendingInviteCode = usePendingInviteStore(
    (state) => state.pendingInviteCode,
  );
  const pendingInviteInvalid = usePendingInviteStore(
    (state) => state.pendingInviteInvalid,
  );
  const overlay = useUiStore((state) => state.overlay);
  const openJoinCommunity = useUiStore((state) => state.openJoinCommunity);

  useLayoutEffect(() => {
    if ((pendingInviteCode || pendingInviteInvalid) && overlay === null)
      openJoinCommunity("link");
  }, [pendingInviteCode, pendingInviteInvalid, overlay, openJoinCommunity]);
}

/** Comunidade ativa some do rail (ou nunca existiu) → cai na primeira. */
export function useActiveCommunityFallback() {
  const joinedCommunityIds = useCommunityStore(
    (state) => state.joinedCommunityIds,
  );
  const activeCommunityId = useCommunityStore(
    (state) => state.activeCommunityId,
  );
  const setActiveCommunity = useCommunityStore(
    (state) => state.setActiveCommunity,
  );
  const setActiveChannel = useCommunityStore((state) => state.setActiveChannel);

  useEffect(() => {
    if (joinedCommunityIds.length === 0) return;
    if (activeCommunityId && joinedCommunityIds.includes(activeCommunityId))
      return;

    const fallbackId = joinedCommunityIds[0];
    setActiveCommunity(fallbackId);
    const state = useCommunityStore.getState();
    if (!state.activeChannelByCommunity[fallbackId]) {
      const channelId = selectFirstTextChannelId(state, fallbackId);
      if (channelId) setActiveChannel(fallbackId, channelId);
    }
  }, [
    joinedCommunityIds,
    activeCommunityId,
    setActiveCommunity,
    setActiveChannel,
  ]);
}

/**
 * Épico 4 — push-to-talk: com a preferência ligada e estando em chamada, segurar a
 * tecla abre o microfone e soltar fecha. A tecla é relida a cada evento (mudou nas
 * configurações, vale na hora) e campos de texto são ignorados — digitar "F2" num
 * input não abre o microfone de ninguém.
 */
export function usePushToTalk() {
  useEffect(() => {
    const alvoDeTexto = (t: EventTarget | null): boolean =>
      t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
    const down = (event: KeyboardEvent) => {
      const settings = useSettingsStore.getState();
      if (!settings.pttAtivo || event.repeat || alvoDeTexto(event.target)) return;
      if (event.key !== settings.pttTecla) return;
      event.preventDefault();
      useVoiceStore.getState().aplicarPTT(true);
    };
    const up = (event: KeyboardEvent) => {
      const settings = useSettingsStore.getState();
      if (!settings.pttAtivo || event.key !== settings.pttTecla) return;
      useVoiceStore.getState().aplicarPTT(false);
    };
    const blur = () => {
      const settings = useSettingsStore.getState();
      if (!settings.pttAtivo) return;
      useVoiceStore.getState().aplicarPTT(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);
}

/**
 * §9, 2.3.1 — a grade expandida recolhe quando a área de conteúdo passa a mostrar
 * outra coisa.
 *
 * A grade é um overlay **sobre a área de conteúdo** (§4, C11): a lista de canais, o
 * rail e a busca ficam de fora e continuam clicáveis enquanto ela está aberta. Sem
 * este recolhimento, todos eles trocavam o que está por baixo e o resultado ficava
 * escondido — o clique acontecia e a tela não mudava. Vale para o rail (C11 diz que
 * ao voltar é "clicar nela reexpande a grade", isto é, trocar de comunidade deixa a
 * grade recolhida), para o resultado de busca, para o link de mensagem de §4, para
 * a mensagem fixada e para o canal recém-criado.
 *
 * A primeira execução não recolhe: ela acontece no instante em que a grade abre, e
 * aí o alvo não mudou — foi só o efeito montando.
 */
export function useRecolherVozAoNavegar() {
  const expanded = useVoiceStore((state) => state.expanded);
  const destino = useUiStore((state) => state.destino);
  const activeCommunityId = useCommunityStore((state) => state.activeCommunityId);
  const activeChannelId = useCommunityStore((state) =>
    state.activeCommunityId
      ? (state.activeChannelByCommunity[state.activeCommunityId] ?? null)
      : null,
  );

  const alvo = chaveDoAlvo({
    destino,
    communityId: activeCommunityId,
    channelId: activeChannelId,
  });
  const alvoAnterior = useRef<string | null>(null);

  useEffect(() => {
    // A regra mora em `recolhimentoDaVoz.ts`, onde o teste a alcança.
    const recolher = deveRecolherAGrade({
      expandida: expanded,
      anterior: alvoAnterior.current,
      atual: alvo,
    });
    alvoAnterior.current = expanded ? alvo : null;
    if (recolher) useVoiceStore.getState().setExpanded(false);
  }, [expanded, alvo]);
}

/** `Cmd/Ctrl+K` de qualquer lugar dentro de uma comunidade ativa (§8, 1.2). */
export function useSearchShortcut() {
  const activeCommunityId = useCommunityStore(
    (state) => state.activeCommunityId,
  );
  const openSearch = useUiStore((state) => state.openSearch);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey))
        return;
      if (!activeCommunityId) return;
      event.preventDefault();
      openSearch("community");
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [activeCommunityId, openSearch]);
}
