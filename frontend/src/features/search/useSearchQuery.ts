import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../ipc/api";
import { useMessageStore } from "../../store/messageStore";
import { resultadoDeBusca } from "../../live/adaptadores";
import {
  RESULTS_MAX_PER_GROUP,
  RESULTS_PER_GROUP,
  hasFilters,
} from "./searchIndex";
import type { BuscaResults, SearchFilters } from "./searchIndex";
import type { Channel } from "../../domain/types";

/** §8, 1.2 — debounce da digitação. */
const DEBOUNCE_MS = 250;

const VAZIO: BuscaResults = {
  messages: [],
  channels: [],
  members: [],
  partial: false,
};

export interface SearchQueryParams {
  communityId: string;
  query: string;
  filters: SearchFilters;
  scope: "channel" | "community" | null;
  activeChannel: Channel | undefined;
}

/**
 * A consulta em si (§23.1): debounce, ida ao núcleo e o corte da lista de
 * mensagens. Quem busca é o núcleo (FTS sobre view.db) — a tela só pergunta.
 */
export function useSearchQuery({
  communityId,
  query,
  filters,
  scope,
  activeChannel,
}: SearchQueryParams) {
  const [debounced, setDebounced] = useState("");
  const [results, setResults] = useState<BuscaResults>(VAZIO);
  const [carregando, setCarregando] = useState(false);
  /** Motivo nomeado da última falha, ou `null`. Nunca "resultado vazio". */
  const [erro, setErro] = useState<string | null>(null);
  // O que esta sessão apagou/editou e o índice do núcleo ainda não sabe: a op pode
  // estar na fila (§11.3) e o FTS só deixa de responder a mensagem quando o
  // tombstone é projetado. Até lá o resultado mostraria o texto antigo — e uma
  // mensagem que a pessoa acabou de mandar apagar.
  const deletedIds = useMessageStore((state) => state.deletedIds);
  const overrides = useMessageStore((state) => state.overrides);
  // Termo novo recolhe a expansão: "Ver todos" é sobre ESTA busca, e mantê-la ligada faria
  // a consulta seguinte já nascer pedindo 100 sem ninguém ter pedido.
  //
  // Guardamos PARA QUAL consulta a expansão foi pedida, em vez de desligá-la num efeito.
  // O efeito custava uma consulta a mais em toda troca de termo: ele só rodava depois da
  // pintura, então a busca nova saía uma vez expandida (pedindo o teto de §23.1) e outra
  // recolhida, porque `expandMessages` está nas dependências da consulta.
  const [expandidoPara, setExpandidoPara] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  const assinatura = useMemo(
    () => JSON.stringify([debounced, filters, scope]),
    [debounced, filters, scope],
  );
  const expandMessages = expandidoPara === assinatura;
  const setExpandMessages = useCallback(
    (v: boolean) => setExpandidoPara(v ? assinatura : null),
    [assinatura],
  );

  // O token `vivo` descarta a resposta de uma consulta velha que voltou
  // depois da nova.
  useEffect(() => {
    const termo = debounced.trim();
    if (termo === "" && !hasFilters(filters)) {
      setResults(VAZIO);
      setCarregando(false);
      return;
    }
    let vivo = true;
    setCarregando(true);
    setErro(null);
    api
      .search({
        communityId,
        query: termo,
        filters: {
          ...(filters.authorId ? { authorKey: filters.authorId } : {}),
          ...(filters.channelId ? { channelId: filters.channelId } : {}),
          ...(filters.date ? { date: filters.date } : {}),
          ...(filters.kind ? { kind: filters.kind } : {}),
        },
        ...(scope === "channel" && activeChannel
          ? { scopeChannelId: activeChannel.id }
          : {}),
        // **B12 — `limitPerGroup` nunca era enviado.** Sem ele o núcleo aplicava o default
        // de 20 (§23.1), e daí saíam DOIS defeitos que se escondiam um no outro: "Ver
        // todos" nunca aparecia, porque a condição é `length > 20` e o núcleo nunca
        // devolvia 21; e se aparecesse, expandiria para a mesma lista de 20 que já estava
        // na tela. Pede-se 21 fechado, para saber que há mais, e o teto de §23.1 expandido.
        limitPerGroup: expandMessages ? RESULTS_MAX_PER_GROUP : RESULTS_PER_GROUP + 1,
      })
      .then((r) => {
        if (!vivo) return;
        setResults(resultadoDeBusca(r));
        setCarregando(false);
      })
      .catch((e: unknown) => {
        if (!vivo) return;
        // Sem isto, `results` guardava a resposta da busca ANTERIOR e o painel a
        // desenhava sob o termo novo, sem dizer que a consulta falhou.
        setResults(VAZIO);
        setErro(e instanceof Error ? e.message : String(e));
        setCarregando(false);
      });
    return () => {
      vivo = false;
    };
    // `expandMessages` entra nas dependências porque ele MUDA a consulta, não só o corte
    // da lista: expandir é ir buscar o resto, não revelar o que já estava aqui.
  }, [communityId, debounced, filters, scope, activeChannel, expandMessages]);

  // A janela local por cima do índice: o que foi apagado sai, o que foi editado
  // aparece com o texto novo. Sem isso a busca contradizia a conversa.
  const reconciliados = useMemo(() => {
    const apagadas = new Set(deletedIds);
    const messages = results.messages
      .filter((m) => !apagadas.has(m.id))
      .map((m) => {
        const conteudo = overrides[m.id]?.content;
        if (conteudo === undefined) return m;
        // O `snippet` do núcleo é derivado do conteúdo indexado; com o conteúdo
        // novo em mãos, ele é o trecho honesto.
        return { ...m, content: conteudo, snippet: conteudo };
      });
    return messages.length === results.messages.length && messages.every((m, i) => m === results.messages[i])
      ? results
      : { ...results, messages };
  }, [results, deletedIds, overrides]);

  const visibleMessages = expandMessages
    ? reconciliados.messages
    : reconciliados.messages.slice(0, RESULTS_PER_GROUP);

  return {
    debounced,
    results: reconciliados,
    carregando,
    erro,
    expandMessages,
    setExpandMessages,
    visibleMessages,
  };
}
