import { useSettingsStore } from "../../store/settingsStore";

/**
 * O nome local de um contato (U-33, emenda de 2026-09-13), ou `undefined` se eu não dei
 * nenhum. O seletor devolve a string crua — nunca objeto montado — pela regra que a
 * armadilha do Zustand v5 já cobrou quatro vezes (`frontend.md`, Parte 11).
 *
 * Mora fora dos componentes pela regra de `dmRegras.ts`: um `.tsx` que exporta hook além
 * de componente quebra o Fast Refresh.
 */
export function useNomeLocalDoContato(conversationId: string | null | undefined): string | undefined {
  return useSettingsStore((s) =>
    conversationId === null || conversationId === undefined
      ? undefined
      : s.dmNomeDoContato[conversationId],
  );
}
