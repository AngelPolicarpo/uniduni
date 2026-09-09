import { create } from "zustand";
import type { Community, HostStatus } from "../domain/types";

/**
 * Saúde de conexão P2P por comunidade (§5.4, §12).
 *
 * O `hostStatus` do espelho (`connectionHealth`, de §15.6) é o que o núcleo
 * respondeu na última consulta. O que muda entre consultas — host caindo,
 * reconectando, voltando — chega por evento e vive aqui, sobrepondo-o.
 *
 * Não é persistido: estado de conexão é sempre do agora. Ao reabrir o app,
 * quem manda de novo é o núcleo.
 */
interface ConnectionState {
  hostStatusOverrides: Record<string, HostStatus>;
  setHostStatus: (communityId: string, status: HostStatus) => void;
  clearHostStatus: (communityId: string) => void;
}

export const useConnectionStore = create<ConnectionState>()((set) => ({
  hostStatusOverrides: {},

  setHostStatus: (communityId, status) =>
    set((state) => ({
      hostStatusOverrides: {
        ...state.hostStatusOverrides,
        [communityId]: status,
      },
    })),

  clearHostStatus: (communityId) =>
    set((state) => {
      const next = { ...state.hostStatusOverrides };
      delete next[communityId];
      return { hostStatusOverrides: next };
    }),
}));

/**
 * Estado atual do host de uma comunidade: o que a sessão mudou, ou o que o
 * núcleo respondeu. Toda tela que mostra saúde de host passa por aqui — rail,
 * banner e composer não podem discordar entre si.
 */
export function useHostStatus(community: Community | undefined): HostStatus {
  const override = useConnectionStore((state) =>
    community ? state.hostStatusOverrides[community.id] : undefined,
  );
  return override ?? community?.connectionHealth.hostStatus ?? "offline";
}
