import { create } from "zustand";

import {
  descartarFaixaReordenada,
  mesclarMensagens,
} from "../features/dm/dmRegras";
import type {
  DmConversationDetail,
  DmConversationItem,
  DmMessageDto,
  DmMessageFull,
} from "../ipc/dto";

/** §31.16.3 — o anexo completo, que só `query.dmMessage` devolve. */
export type DmAnexo = NonNullable<DmMessageFull["attachment"]>;

/**
 * §31.16.3 — o corte do divisor de "Novas mensagens" (**U-33**), **congelado na abertura**.
 *
 * Ele é o `ordKey` de §31.6 do watermark de `dm_local_read_state`, e os dois eixos importam:
 * `ordSum` empata, e `naoLidas` desempata pela chave do autor. Um corte que usasse só o
 * primeiro discordaria do selo em exatamente o caso do empate — "1 não lida" com divisor
 * nenhum na tela.
 *
 * **Congelado** porque abrir a conversa marca como lida logo em seguida (§31.16.1): um corte
 * que acompanhasse o watermark sumiria no mesmo quadro em que apareceu.
 */
export interface CorteDeNaoLidas {
  readonly ordSum: number;
  /** Hex; `''` quando a conversa nunca foi marcada — aí tudo acima de `ordSum` é novo. */
  readonly authorKey: string;
}

/**
 * O espelho local da conversa direta (§31.16) — U-33.
 *
 * Ele guarda o que as 5 queries devolvem e **nada derivado**: contagem de não lidas,
 * entrega e `sync` vêm do núcleo, que é quem tem a projeção. Recalcular qualquer um deles
 * aqui produziria um segundo número, e o de §31.11 é o único com fonte.
 *
 * Não há fila de envio. `dm.send` é síncrono com o registro já no log (§31.10), então não
 * existe `pending`/`sending`/`failed` neste store — os cinco estados de outbox não são
 * declarados em §31.11 porque não podem ocorrer, e uma store que os tivesse convidaria a
 * tela a inventá-los.
 */

/** §31.16.3 — a página de mensagens de uma conversa, com o cursor opaco. */
export interface ConversaCarregada {
  readonly mensagens: DmMessageDto[];
  /** `base64url({ordSum, authorKey, id})` — para trás, rumo ao começo da conversa. */
  readonly cursorAnterior?: string;
  readonly temMais: boolean;
  /**
   * §31.13 — a faixa foi descartada por `dm.reordered` e ainda não voltou. A tela mostra
   * o carregando naquela faixa em vez de uma história que não é mais a corrente.
   */
  readonly recarregando: boolean;
}

interface DmState {
  /** `query.dmConversations`, na ordem que o núcleo devolveu. */
  conversas: DmConversationItem[];
  /** `query.dmConversation` da conversa aberta — `lag`, `deliveredUpTo`, invalidez. */
  detalhe: DmConversationDetail | null;
  /** A conversa aberta. `null` = a lista, sem conversa nenhuma. */
  ativa: string | null;
  porConversa: Record<string, ConversaCarregada>;
  /** §31.9 regra 5 — preferência local, com o custo declarado na tela. */
  contactPolicy: "anyone" | "shared-community";
  /** §31.9 regra 4 — o teto foi atingido e um pedido novo foi recusado. */
  pendentesNoTeto: boolean;
  /** §31.16.1 `dm.typing`, TTL de 5 s — por conversa. */
  digitando: Record<string, boolean>;
  /**
   * §31.14 — o anexo de cada mensagem que tem um, por `messageId`.
   *
   * Separado das mensagens de propósito: a lista de §31.16.3 traz só `hasAttachment`, e o
   * anexo inteiro vem de `query.dmMessage`, uma mensagem por vez. Guardá-lo dentro da
   * mensagem faria cada recarga da página apagar o que já se sabia.
   */
  anexos: Record<string, DmAnexo | null>;
  /** §31.16.3 — o corte do divisor, por conversa. Ausente = conversa nunca aberta aqui. */
  cortes: Record<string, CorteDeNaoLidas>;

  setConversas: (conversas: DmConversationItem[]) => void;
  setDetalhe: (detalhe: DmConversationDetail | null) => void;
  setAtiva: (conversationId: string | null) => void;
  setContactPolicy: (policy: "anyone" | "shared-community") => void;
  setPendentesNoTeto: (noTeto: boolean) => void;
  setDigitando: (conversationId: string, on: boolean) => void;
  /** `null` = a consulta não devolveu anexo; o cartão para de pulsar e oferece tentar de novo. */
  setAnexo: (messageId: string, anexo: DmAnexo | null) => void;
  aplicarPagina: (
    conversationId: string,
    mensagens: DmMessageDto[],
    pagina: { cursorAnterior?: string; temMais: boolean; corte?: CorteDeNaoLidas },
  ) => void;
  aplicarMensagens: (conversationId: string, mensagens: DmMessageDto[]) => void;
  reordenar: (conversationId: string, fromOrdSum: number) => void;
  limpar: (conversationId: string) => void;
}

const VAZIA: ConversaCarregada = { mensagens: [], temMais: false, recarregando: false };

export const useDmStore = create<DmState>()((set) => ({
  conversas: [],
  detalhe: null,
  ativa: null,
  porConversa: {},
  contactPolicy: "anyone",
  pendentesNoTeto: false,
  digitando: {},
  anexos: {},
  cortes: {},

  setConversas: (conversas) => set({ conversas }),
  setDetalhe: (detalhe) => set({ detalhe }),

  setAtiva: (conversationId) =>
    set((s) => {
      // Trocar de conversa larga o detalhe da anterior: ele é de UMA conversa, e mantê-lo
      // faria a faixa de sincronização da antiga aparecer sobre a nova por um quadro.
      if (s.ativa === conversationId) return s;
      // O corte da que se fecha vai junto. Ele é congelado enquanto a conversa está aberta
      // (senão sumiria ao marcar como lida) e precisa ser recalculado na próxima abertura,
      // do watermark de então — senão o divisor voltaria no lugar da visita anterior.
      const cortes = { ...s.cortes };
      if (s.ativa !== null) delete cortes[s.ativa];
      return { ativa: conversationId, detalhe: null, cortes };
    }),

  setContactPolicy: (contactPolicy) => set({ contactPolicy }),
  setPendentesNoTeto: (pendentesNoTeto) => set({ pendentesNoTeto }),

  setDigitando: (conversationId, on) =>
    set((s) => ({ digitando: { ...s.digitando, [conversationId]: on } })),

  setAnexo: (messageId, anexo) =>
    set((s) => ({ anexos: { ...s.anexos, [messageId]: anexo } })),

  aplicarPagina: (conversationId, mensagens, pagina) =>
    set((s) => {
      const atual = s.porConversa[conversationId] ?? VAZIA;
      // Primeira página desta abertura fixa o corte; as seguintes (`dm.appended`, "carregar
      // anteriores") não o movem.
      const cortes =
        pagina.corte === undefined || s.cortes[conversationId] !== undefined
          ? s.cortes
          : { ...s.cortes, [conversationId]: pagina.corte };
      return {
        cortes,
        porConversa: {
          ...s.porConversa,
          [conversationId]: {
            mensagens: mesclarMensagens(atual.mensagens, mensagens),
            ...(pagina.cursorAnterior !== undefined
              ? { cursorAnterior: pagina.cursorAnterior }
              : {}),
            temMais: pagina.temMais,
            recarregando: false,
          },
        },
      };
    }),

  aplicarMensagens: (conversationId, mensagens) =>
    set((s) => {
      const atual = s.porConversa[conversationId] ?? VAZIA;
      return {
        porConversa: {
          ...s.porConversa,
          [conversationId]: {
            ...atual,
            mensagens: mesclarMensagens(atual.mensagens, mensagens),
          },
        },
      };
    }),

  /**
   * §31.13 — a faixa a partir de `fromOrdSum` deixou de ser a corrente. Descartar é
   * obrigatório, e `recarregando` é o que impede a tela de mostrar o buraco como se a
   * conversa tivesse encolhido.
   */
  reordenar: (conversationId, fromOrdSum) =>
    set((s) => {
      const atual = s.porConversa[conversationId];
      if (atual === undefined) return s;
      return {
        porConversa: {
          ...s.porConversa,
          [conversationId]: {
            ...atual,
            mensagens: descartarFaixaReordenada(atual.mensagens, fromOrdSum),
            recarregando: true,
          },
        },
      };
    }),

  limpar: (conversationId) =>
    set((s) => {
      const { [conversationId]: _removida, ...resto } = s.porConversa;
      const { [conversationId]: _corte, ...cortes } = s.cortes;
      return {
        porConversa: resto,
        cortes,
        ativa: s.ativa === conversationId ? null : s.ativa,
        detalhe: s.ativa === conversationId ? null : s.detalhe,
      };
    }),
}));

/** A seção de pedidos do topo da lista (§31.9): `pending-in` **não** é conversa ainda. */
export function selecionarPedidos(conversas: readonly DmConversationItem[]): DmConversationItem[] {
  return conversas.filter((c) => c.state === "pending-in");
}

/** O resto da lista. `left` não aparece: esquecer tira a conversa de vista (§31.19). */
export function selecionarConversas(
  conversas: readonly DmConversationItem[],
): DmConversationItem[] {
  return conversas.filter((c) => c.state !== "pending-in" && c.state !== "left");
}
