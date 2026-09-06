import { useEffect, useLayoutEffect } from "react";
import {
  selectFirstTextChannelId,
  useCommunityStore,
} from "../../store/communityStore";
import { usePendingInviteStore } from "../../store/inviteStore";
import { useSettingsStore } from "../../store/settingsStore";
import { useUiStore } from "../../store/uiStore";
import { useVoiceStore } from "../../store/voiceStore";

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
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);
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
