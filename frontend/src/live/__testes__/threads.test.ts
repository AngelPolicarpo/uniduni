/**
 * As threads de OUTRAS instalações (§61.4) que a página do canal revela.
 *
 * O que se afirma: a função devolve os **ids** ainda desconhecidos, sem palpitar a
 * raiz. Palpitá-la como o menor `seq` da página era errado — a janela de 50 de §23.3
 * pode não conter a raiz, e o palpite ancorava o chip "N respostas" numa resposta,
 * de onde `conhecidas` nunca mais o tirava. Quem responde a raiz é `query.thread`.
 * Threads já conhecidas não são reemitidas (sobrescrever reverteria o assentamento da
 * temporária local) e mensagem sem `threadId` não revela thread nenhuma.
 */

import { describe, expect, it } from "vitest";
import { threadsDaPagina } from "../adaptadores";

const CANAL = "ch-1";

function dto(id: string, seq: number, threadId?: string) {
  return { id, seq, ...(threadId !== undefined ? { threadId } : {}), channelId: CANAL };
}

describe("threadsDaPagina — a thread que o canal revela e a store não conhece", () => {
  it("devolve o id, e NÃO elege raiz a partir da página", () => {
    // A página desce de `before` e chega invertida; a raiz real pode nem estar aqui.
    const ids = threadsDaPagina([dto("r3", 3, "t1"), dto("r7", 7, "t1"), dto("r5", 5, "t1")], new Set());
    expect(ids).toEqual(["t1"]);
  });

  it("thread já conhecida não é reemitida — assentarThreadReal é quem manda na local", () => {
    expect(threadsDaPagina([dto("r1", 1, "t-conhecida")], new Set(["t-conhecida"]))).toEqual([]);
  });

  it("mensagem sem threadId não revela thread nenhuma", () => {
    expect(threadsDaPagina([dto("r1", 1), dto("r2", 2)], new Set())).toEqual([]);
  });

  it("grupos distintos viram ids distintos, cada um uma vez só", () => {
    const ids = threadsDaPagina(
      [dto("a2", 2, "tA"), dto("a9", 9, "tA"), dto("b4", 4, "tB"), dto("b1", 1, "tB")],
      new Set(),
    );
    expect(ids).toEqual(["tA", "tB"]);
  });
});
