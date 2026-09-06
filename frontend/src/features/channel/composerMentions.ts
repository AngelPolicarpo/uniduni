import { useEffect, useMemo, useState } from "react";
import type { RefObject } from "react";
import { escapeRegExp } from "../../lib/text";
import {
  filterMentionCandidates,
  mentionToken,
  useMentionCandidates,
} from "./mentions";
import type { MentionCandidate } from "./mentions";

interface ActiveMention {
  token: string;
  id: string;
}

/**
 * Um token só é menção onde ele é a PALAVRA inteira: `@Dan` dentro de `@Danilo`
 * não é o Dan. Sem esta borda, escolher `@Dan` e continuar digitando `ilo`
 * mandava o id do Dan no `mentions` da op — e o Dan recebia uma notificação de
 * uma mensagem que não fala dele (§9, 2.1.1: quem é mencionado é dado, não
 * adivinhação).
 */
const DEPOIS_DA_MENCAO = /[\p{L}\p{N}_]/u;

function ehMencaoEm(content: string, inicio: number, token: string): boolean {
  const antes = inicio === 0 ? "" : content[inicio - 1]!;
  if (antes !== "" && !/\s/.test(antes)) return false;
  const depois = content[inicio + token.length];
  return depois === undefined || !DEPOIS_DA_MENCAO.test(depois);
}

/** Quantas vezes o token aparece como menção inteira — não como pedaço de palavra. */
export function ocorrenciasDe(content: string, token: string): number {
  let n = 0;
  let i = content.indexOf(token);
  while (i !== -1) {
    if (ehMencaoEm(content, i, token)) n += 1;
    i = content.indexOf(token, i + token.length);
  }
  return n;
}

/** Um pedaço do texto no espelho do composer: menção confirmada ou não. */
export interface MentionSegment {
  text: string;
  isMention: boolean;
}

/**
 * Menção sendo digitada: o `@` precisa começar palavra, e espaço ou
 * pontuação encerram o filtro e fecham o dropdown (§9, 2.1.1).
 */
export function findMentionQuery(
  value: string,
  caret: number,
): { start: number; text: string } | null {
  const before = value.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(before[at - 1])) return null;

  const text = before.slice(at + 1);
  if (/[\s,.;:!?]/.test(text)) return null;
  return { start: at, text };
}

export interface ComposerMentionsParams {
  communityId: string;
  value: string;
  setValue: (next: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** Cursor a reposicionar depois que o React aplicar o novo valor. */
  pendingCaret: RefObject<number | null>;
}

/**
 * Toda a máquina de menção do composer (§9, 2.1.1): o que está sendo digitado
 * depois do `@`, quem já foi confirmado, o realce no espelho e as teclas que
 * pertencem ao dropdown.
 *
 * Vive fora do `Composer` porque é uma responsabilidade inteira e fechada: o
 * composer só precisa saber o que desenhar e se a tecla já foi consumida.
 */
export function useComposerMentions({
  communityId,
  value,
  setValue,
  textareaRef,
  pendingCaret,
}: ComposerMentionsParams) {
  const candidates = useMentionCandidates(communityId);

  const [mentions, setMentions] = useState<ActiveMention[]>([]);
  const [query, setQuery] = useState<{ start: number; text: string } | null>(
    null,
  );
  /**
   * Posição do `@` que o usuário fechou com `Esc`. Sem isso o dropdown
   * reabriria no `keyup` seguinte — e o próximo `Enter` confirmaria uma
   * menção em vez de enviar a mensagem.
   */
  const [dismissedStart, setDismissedStart] = useState<number | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Filtro novo recomeça a seleção no topo, senão a seta continua de onde
  // parou numa lista que já é outra.
  useEffect(() => setSelectedIndex(0), [query?.text]);

  const visible = useMemo(
    () => (query ? filterMentionCandidates(candidates, query.text) : []),
    [candidates, query],
  );

  /** Trechos do texto que já são menção confirmada — pintados no espelho. */
  const segments = useMemo<MentionSegment[]>(() => {
    const tokens = [...new Set(mentions.map((mention) => mention.token))].filter(
      (token) => ocorrenciasDe(value, token) > 0,
    );
    if (tokens.length === 0) return [{ text: value, isMention: false }];

    // As MESMAS bordas de `ocorrenciasDe`: o espelho não pode pintar `@Dan`
    // dentro de `@Danilo`, senão ele promete uma menção que não será enviada.
    const pattern = new RegExp(
      `(?<![^\\s])(${tokens.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}_])`,
      "gu",
    );
    // Conjunto: o texto quebrado pode ter muitos pedaços, e cada um pergunta
    // pela mesma lista de tokens.
    const confirmados = new Set(tokens);
    return value
      .split(pattern)
      .map((part) => ({ text: part, isMention: confirmados.has(part) }));
  }, [value, mentions]);

  function syncQuery(next: string, caret: number) {
    const found = findMentionQuery(next, caret);
    if (found && found.start === dismissedStart) {
      // Mesma menção que o usuário já dispensou: segue como texto comum.
      setQuery(null);
      return;
    }
    if (dismissedStart !== null) setDismissedStart(null);
    setQuery(found);
  }

  function applyMention(candidate: MentionCandidate) {
    const el = textareaRef.current;
    if (!el || !query) return;

    const token = mentionToken(candidate);
    const caret = el.selectionStart;
    const next = `${value.slice(0, query.start)}${token} ${value.slice(caret)}`;
    const nextCaret = query.start + token.length + 1;

    pendingCaret.current = nextCaret;
    setValue(next);
    // Não se descarta a confirmação anterior do MESMO token: dois membros
    // homônimos produzem o mesmo `@Fulano`, e filtrar por token fazia a segunda
    // escolha apagar a primeira — só uma das duas pessoas era notificada. Cada
    // confirmação vira uma entrada, e o envio casa por ocorrência.
    setMentions((prev) => [...prev, { token, id: candidate.id }]);
    setQuery(null);
  }

  /**
   * Ids das menções que sobreviveram até o texto enviado (§9, 2.1.1).
   *
   * Casa por OCORRÊNCIA, não por "o texto contém": o token precisa aparecer como
   * palavra inteira, e um token confirmado duas vezes (dois homônimos) leva os
   * dois ids só se aparecer duas vezes no texto.
   */
  function mentionIdsIn(content: string): string[] {
    const restantes = new Map<string, number>();
    for (const mention of mentions) {
      if (restantes.has(mention.token)) continue;
      restantes.set(mention.token, ocorrenciasDe(content, mention.token));
    }
    const ids: string[] = [];
    for (const mention of mentions) {
      const sobrando = restantes.get(mention.token) ?? 0;
      if (sobrando <= 0) continue;
      restantes.set(mention.token, sobrando - 1);
      if (!ids.includes(mention.id)) ids.push(mention.id);
    }
    return ids;
  }

  function reset() {
    setMentions([]);
    setQuery(null);
    // O Esc de uma mensagem não pode calar o autocomplete da SEGUINTE: o índice
    // memorizado é do texto que acabou de ir embora, e um `@` na mesma posição
    // do composer vazio nascia bloqueado.
    setDismissedStart(null);
  }

  /**
   * As teclas que pertencem à menção. Devolve `true` quando a tecla já foi
   * consumida — o composer só trata o que sobra (Enter para enviar).
   */
  function handleKeyDown(
    event: React.KeyboardEvent<HTMLTextAreaElement>,
  ): boolean {
    if (query && visible.length > 0) {
      // ↑/↓ dão a volta; Tab equivale a Enter (§9, 2.1.1).
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((index) => (index + 1) % visible.length);
        return true;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex(
          (index) => (index - 1 + visible.length) % visible.length,
        );
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        applyMention(visible[selectedIndex]);
        return true;
      }
    }

    if (query && event.key === "Escape") {
      // Fecha mantendo o "@" e o texto já digitado como texto comum.
      event.preventDefault();
      setDismissedStart(query.start);
      setQuery(null);
      return true;
    }

    // Um único Backspace apaga a menção inteira, não caractere a caractere.
    if (event.key === "Backspace" && !event.shiftKey) {
      const el = event.currentTarget;
      if (el.selectionStart === el.selectionEnd) {
        const before = value.slice(0, el.selectionStart);
        // `applyMention` deixa o cursor DEPOIS do espaço que segue o token; sem
        // contar esse espaço, o primeiro Backspace só apagava o espaço e a
        // menção só sumia no segundo toque.
        const comEspaco = before.endsWith(" ") ? 1 : 0;
        const semEspaco = comEspaco === 1 ? before.slice(0, -1) : before;
        const hit = mentions.find((mention) => semEspaco.endsWith(mention.token));
        if (hit) {
          event.preventDefault();
          const start = el.selectionStart - hit.token.length - comEspaco;
          pendingCaret.current = start;
          setValue(value.slice(0, start) + value.slice(el.selectionStart));
          setMentions((prev) => {
            // Só UMA confirmação daquele token sai — homônimos são entradas
            // distintas, e apagar todas notificaria de menos.
            const indice = prev.findLastIndex((mention) => mention.token === hit.token);
            return indice === -1 ? prev : [...prev.slice(0, indice), ...prev.slice(indice + 1)];
          });
          return true;
        }
      }
    }

    return false;
  }

  return {
    query,
    visible,
    selectedIndex,
    setSelectedIndex,
    segments,
    syncQuery,
    applyMention,
    mentionIdsIn,
    reset,
    handleKeyDown,
  };
}
