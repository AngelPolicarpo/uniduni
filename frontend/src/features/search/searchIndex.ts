/**
 * Tipos da busca real de §23.1 (`query.search` sobre o FTS do núcleo).
 *
 * O motor client-side foi embora: a fonte é o índice do `view.db`, que enxerga
 * TODO o log interpretado — não só a janela de 50 mensagens carregada na tela.
 * Aqui ficam os filtros do painel e o destaque do casamento; os tipos de
 * resultado moram em `domain/types.ts`.
 */

/** §14 — top ~20 por grupo, com "ver todos" expandindo in-line. */
export const RESULTS_PER_GROUP = 20;

/**
 * O teto de `limitPerGroup` em §23.1 (`SEARCH_MAX_LIMIT_PER_GROUP` no núcleo). É até onde
 * "Ver todos" expande — pedir mais é recusado lá e devolveria o mesmo 100.
 */
export const RESULTS_MAX_PER_GROUP = 100;

export type DateFilter = "today" | "7d" | "30d";
export type KindFilter = "attachment" | "link" | "pinned";

export interface SearchFilters {
  authorId?: string;
  channelId?: string;
  date?: DateFilter;
  kind?: KindFilter;
}

export type {
  BuscaResults,
  SearchMessageHit,
  SearchChannelHit,
  SearchPartialReason,
} from "../../domain/types";

export function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

export function hasFilters(filters: SearchFilters): boolean {
  return Object.values(filters).some((value) => value !== undefined);
}

/** Um pedaço do trecho do resultado: casou com a busca, ou não. */
export interface TrechoDestacado {
  text: string;
  match: boolean;
}

/**
 * Normaliza mantendo o mapa de volta ao texto ORIGINAL.
 *
 * `normalize` pode encurtar o texto — "e" seguido de acento combinante (NFD) vira
 * uma unidade só —, e fatiar o original com um índice calculado sobre o
 * normalizado deslocava o `<mark>` para o lado. O mapa diz, para cada posição
 * normalizada, onde ela começa no original.
 */
function normalizadoComMapa(text: string): { plano: string; posicoes: number[] } {
  let plano = "";
  const posicoes: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const pedaco = normalize(text[i]!);
    for (let k = 0; k < pedaco.length; k += 1) posicoes.push(i);
    plano += pedaco;
  }
  posicoes.push(text.length);
  return { plano, posicoes };
}

/**
 * Divide o texto nos trechos que casaram, para destacá-los no resultado.
 *
 * Cada TERMO da busca é procurado por si: o FTS de §23.1 casa os termos em
 * conjunção, não a frase literal, então procurar "reuniao quinta" inteiro não
 * achava nada e o resultado vinha sem destaque nenhum.
 */
export function destacarCasamentos(text: string, query: string): TrechoDestacado[] {
  const termos = [...new Set(query.trim().split(/\s+/).map(normalize).filter((t) => t !== ""))];
  if (termos.length === 0) return [{ text, match: false }];

  const { plano, posicoes } = normalizadoComMapa(text);
  // Intervalos no espaço NORMALIZADO, depois unidos: dois termos podem se tocar.
  const marcas: Array<[number, number]> = [];
  for (const termo of termos) {
    let i = plano.indexOf(termo);
    while (i !== -1) {
      marcas.push([i, i + termo.length]);
      i = plano.indexOf(termo, i + termo.length);
    }
  }
  if (marcas.length === 0) return [{ text, match: false }];
  marcas.sort((a, b) => a[0] - b[0]);

  const trechos: TrechoDestacado[] = [];
  let cursor = 0;
  let [inicio, fim] = marcas[0]!;
  for (const [i, f] of marcas.slice(1)) {
    if (i <= fim) {
      fim = Math.max(fim, f);
      continue;
    }
    empurrar(inicio, fim);
    [inicio, fim] = [i, f];
  }
  empurrar(inicio, fim);
  if (cursor < text.length) trechos.push({ text: text.slice(cursor), match: false });
  return trechos;

  function empurrar(de: number, ate: number) {
    const a = posicoes[de] ?? text.length;
    const b = posicoes[ate] ?? text.length;
    if (a > cursor) trechos.push({ text: text.slice(cursor, a), match: false });
    trechos.push({ text: text.slice(a, b), match: true });
    cursor = b;
  }
}

/**
 * Uma lista por grupo, e não uma só envolvendo os três: o botão "Ver todos" mora dentro da
 * seção de mensagens, e uma `listbox` só admite `option`/`group` como filhos. Três listas
 * rotuladas deixam o botão fora de todas elas sem mover nada na tela — e o campo aponta as
 * três de uma vez, porque `aria-controls` aceita lista de ids.
 */
export const LISTAS_IDS = ["busca-mensagens", "busca-canais", "busca-membros"] as const;

/** O que o `aria-controls` do campo de busca aponta. */
export const LISTA_ID = LISTAS_IDS.join(" ");

/** Um id por posição achatada — é o que o `aria-activedescendant` do campo aponta. */
export function opcaoId(indice: number): string {
  return `resultado-da-busca-${indice}`;
}
