import type { ReactNode } from "react";
import { analisarMarkdown, type No } from "../live/markdown";
import { cn } from "../lib/cn";

/**
 * Markdown básico da mensagem (§0, premissa 8 · §9, 2.1 · §11, C9).
 *
 * Aqui só se escolhe a tag. **Quem decide o que é link, negrito, menção ou texto é
 * `live/markdown.ts`** — e é lá que a allowlist normativa de §15.6.1
 * (`http`/`https`/`mailto`) mora, junto dos testes que a fixam.
 *
 * Havia dois analisadores: este arquivo tinha uma cópia própria da gramática, e era
 * ela que a tela usava enquanto os testes exercitavam a outra. As duas divergiam —
 * `mailto:` não virava âncora na tela, e `[isto](javascript:alert(1))` aparecia como
 * markup cru em vez do rótulo limpo que a allowlist manda mostrar. Um analisador que
 * ninguém vê não protege ninguém; por isso agora existe um só.
 *
 * O resultado é sempre elemento React, nunca HTML injetado: conteúdo de mensagem é
 * texto de terceiro e não deve virar markup por acidente.
 */

const MENTION_CLASS = cn(
  "rounded-sm bg-accent-muted-bg px-1 py-px",
  "text-body-emphasis text-accent-default",
);

const LINK_CLASS = "text-accent-default underline underline-offset-2 hover:text-accent-hover";

function renderNos(nos: readonly No[], keyPrefix: string): ReactNode[] {
  return nos.map((no, indice) => {
    const key = `${keyPrefix}-${indice}`;
    switch (no.t) {
      case "texto":
        return no.texto;
      case "codigo":
        return (
          <code
            key={key}
            className="rounded-sm bg-surface-app px-1 py-px font-mono text-[13px]"
          >
            {no.texto}
          </code>
        );
      case "bloco":
        return (
          <pre
            key={key}
            className="my-1 overflow-x-auto rounded-md border border-border-default bg-surface-app p-3 font-mono text-[13px] text-text-primary"
          >
            <code>{no.texto.replace(/\n$/, "")}</code>
          </pre>
        );
      case "negrito":
        return (
          <strong key={key} className="font-semibold">
            {renderNos(no.filhos, key)}
          </strong>
        );
      case "italico":
        return (
          <em key={key} className="italic">
            {renderNos(no.filhos, key)}
          </em>
        );
      case "link":
        return (
          <a
            key={key}
            href={no.href}
            target="_blank"
            rel="noreferrer noopener"
            className={LINK_CLASS}
          >
            {no.rotulo}
          </a>
        );
      case "mencao":
        return (
          <span key={key} className={MENTION_CLASS}>
            {no.texto}
          </span>
        );
    }
  });
}

/**
 * Converte o conteúdo de uma mensagem em nós React. `mentionTokens` são os
 * textos já resolvidos ("@Ana Torres", "@everyone") que devem virar pill.
 */
export function renderMarkdown(
  content: string,
  mentionTokens: string[],
): ReactNode[] {
  return renderNos(analisarMarkdown(content, mentionTokens), "md");
}
