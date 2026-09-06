/**
 * Análise do markdown de mensagem (§15.6.1 T-18, §9 2.1).
 *
 * O escopo é fechado e pequeno — negrito, itálico, código inline, bloco de código, link e
 * menção —, então não entra dependência nova.
 *
 * **A allowlist é normativa, não estética.** §15.6.1: "links com esquema fora de
 * `http`/`https`/`mailto` são renderizados como **texto**, não como âncora". É a mesma
 * allowlist que o `fold` aplica ao extrair `message_links`, e por isso ela vive aqui como
 * regra explícita e testada: um `javascript:` que virasse âncora seria execução de código
 * escrito por outra pessoa.
 *
 * A análise devolve **tokens**, não elementos. A separação existe para esta parte poder ser
 * testada sem DOM: é onde estão as decisões (o que é link, o que é texto), enquanto a
 * renderização só escolhe a tag.
 */

/** §15.6.1 e §26 — os três esquemas que podem virar âncora. */
const ESQUEMAS_PERMITIDOS = ["http:", "https:", "mailto:"] as const;

export type No =
  | { readonly t: "texto"; readonly texto: string }
  | { readonly t: "negrito"; readonly filhos: readonly No[] }
  | { readonly t: "italico"; readonly filhos: readonly No[] }
  | { readonly t: "codigo"; readonly texto: string }
  | { readonly t: "bloco"; readonly texto: string }
  | { readonly t: "link"; readonly href: string; readonly rotulo: string }
  | { readonly t: "mencao"; readonly texto: string };

/**
 * Um esquema só passa se o runtime souber analisar a URL **e** o esquema estiver na lista.
 * URL que o `URL` recusa não vira link nenhum — o mesmo critério de §8.5, onde o `fold`
 * normaliza em vez de lançar.
 */
export function esquemaPermitido(href: string): boolean {
  try {
    return (ESQUEMAS_PERMITIDOS as readonly string[]).includes(new URL(href).protocol);
  } catch {
    return false;
  }
}

const BLOCO = /```(?:[a-zA-Z0-9-]*)\n?([\s\S]*?)```/g;

/**
 * O destino de um link, sem a pontuação que fecha a FRASE.
 *
 * "olha https://exemplo.org/a." é uma frase com um link, não um link terminado em
 * ponto; e um `)` só pertence à URL se houver o `(` que ele fecha — é o que faz
 * `.../Rust_(linguagem)` sobreviver inteiro sem engolir o parêntese de quem
 * escreveu "(veja https://exemplo.org)".
 */
export function urlSemPontuacaoFinal(bruta: string): string {
  let fim = bruta.length;
  while (fim > 0) {
    const c = bruta[fim - 1]!;
    if (".,;:!?".includes(c)) {
      fim -= 1;
      continue;
    }
    if (c === ")") {
      const trecho = bruta.slice(0, fim);
      const abre = (trecho.match(/\(/g) ?? []).length;
      const fecha = (trecho.match(/\)/g) ?? []).length;
      if (fecha > abre) {
        fim -= 1;
        continue;
      }
    }
    break;
  }
  return bruta.slice(0, fim);
}

function padraoInline(mencoes: readonly string[]): RegExp {
  const escapadas = mencoes.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const mencao = escapadas.length > 0 ? `|(${escapadas.join("|")})` : "";
  return new RegExp(
    // Código inline vem primeiro: `**x**` dentro de crase é literal, não negrito.
    "(`[^`\\n]+`)" +
      // `***x***` é negrito COM itálico: sem esta alternativa própria, nem a de
      // negrito nem a de itálico casam (as duas param no `*` seguinte) e a tela
      // mostrava os asteriscos crus.
      "|(\\*\\*\\*[^*\\n]+\\*\\*\\*)" +
      // O corpo do negrito admite itálico dentro: `[^*\n]+` sozinho parava no
      // primeiro `*` de `**a *b* c**` e o negrito inteiro não era reconhecido. As
      // duas alternativas são disjuntas na primeira letra, então não há ambiguidade
      // que faça o motor de regex retroceder.
      "|(\\*\\*(?:[^*\\n]+|\\*[^*\\n]+\\*)+\\*\\*)" +
      "|(\\*[^*\\n]+\\*|_[^_\\n]+_)" +
      // O destino do link markdown aceita parênteses BALANCEADOS: sem isso
      // `[Rust](…/Rust_(linguagem))` casava até o primeiro `)` e o link nascia
      // truncado, com o resto sobrando como texto.
      "|(\\[[^\\]\\n]+\\]\\((?:[^()\\s]*(?:\\([^()\\s]*\\)[^()\\s]*)*)\\))" +
      "|([a-zA-Z][a-zA-Z0-9+.-]*:\\/\\/[^\\s]+|mailto:[^\\s]+)" +
      mencao,
    "g",
  );
}

/**
 * Um link cujo esquema não passa vira **texto**, com o rótulo visível — nunca some. Some
 * seria pior: a pessoa que escreveu acharia que mandou algo que ninguém vê.
 */
function link(href: string, rotulo: string): No {
  return esquemaPermitido(href) ? { t: "link", href, rotulo } : { t: "texto", texto: rotulo };
}

function inline(texto: string, mencoes: readonly string[]): No[] {
  const nos: No[] = [];
  const padrao = padraoInline(mencoes);
  let ultimo = 0;
  let m = padrao.exec(texto);

  while (m !== null) {
    if (m.index > ultimo) nos.push({ t: "texto", texto: texto.slice(ultimo, m.index) });
    const [inteiro, codigo, triplo, negrito, italico, mdLink, urlSolta, mencao] = m;

    if (codigo !== undefined) {
      nos.push({ t: "codigo", texto: codigo.slice(1, -1) });
    } else if (triplo !== undefined) {
      nos.push({ t: "negrito", filhos: [{ t: "italico", filhos: inline(triplo.slice(3, -3), mencoes) }] });
    } else if (negrito !== undefined) {
      nos.push({ t: "negrito", filhos: inline(negrito.slice(2, -2), mencoes) });
    } else if (italico !== undefined) {
      nos.push({ t: "italico", filhos: inline(italico.slice(1, -1), mencoes) });
    } else if (mdLink !== undefined) {
      const corte = mdLink.indexOf("](");
      nos.push(link(mdLink.slice(corte + 2, -1), mdLink.slice(1, corte)));
    } else if (urlSolta !== undefined) {
      // O casamento pega a pontuação que fecha a frase; o link fica com o resto.
      const href = urlSemPontuacaoFinal(urlSolta);
      nos.push(link(href, href));
      const sobra = urlSolta.slice(href.length);
      if (sobra !== "") nos.push({ t: "texto", texto: sobra });
    } else if (mencao !== undefined) {
      nos.push({ t: "mencao", texto: mencao });
    } else {
      nos.push({ t: "texto", texto: inteiro });
    }

    ultimo = m.index + inteiro.length;
    m = padrao.exec(texto);
  }

  if (ultimo < texto.length) nos.push({ t: "texto", texto: texto.slice(ultimo) });
  return nos;
}

/** `mencoes` são os textos já resolvidos ("@ana", "@everyone") que viram pill. */
export function analisarMarkdown(conteudo: string, mencoes: readonly string[] = []): No[] {
  const nos: No[] = [];
  let ultimo = 0;
  BLOCO.lastIndex = 0;
  let m = BLOCO.exec(conteudo);

  while (m !== null) {
    if (m.index > ultimo) nos.push(...inline(conteudo.slice(ultimo, m.index), mencoes));
    nos.push({ t: "bloco", texto: m[1] ?? "" });
    ultimo = m.index + m[0].length;
    m = BLOCO.exec(conteudo);
  }

  if (ultimo < conteudo.length) nos.push(...inline(conteudo.slice(ultimo), mencoes));
  return nos;
}
