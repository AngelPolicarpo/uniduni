/**
 * A tradução da fila de §15.6 para bolhas de UI: mapeamento de estado (§11.3 ×
 * os quatro estados do mock) e o recorte do que vira linha de canal. Verificado
 * por mutação em §60 — trocar um ramo do switch derruba o caso correspondente.
 */

import { describe, expect, it } from "vitest";
import { bolhaDaFila, estadoDeEntrega } from "../adaptadores";
import type { OutboxItem } from "../../ipc/dto";

const item = (sobre?: Partial<OutboxItem>): OutboxItem => ({
  opId: "op-1",
  communityId: "co-1",
  kind: 1,
  kindLabel: "Mensagem",
  state: "queued",
  attempts: 0,
  enqueuedAt: 1_757_030_400_000,
  nextAttemptAt: 0,
  preview: { content: "olá" },
  ...sobre,
});

describe("estadoDeEntrega — os cinco estados da outbox nos quatro da UI", () => {
  it("queued → queued", () =>
    expect(estadoDeEntrega("queued")).toBe("queued"));
  it("sending → sending", () =>
    expect(estadoDeEntrega("sending")).toBe("sending"));
  it("awaiting-confirmation NÃO é entrega: segue sending", () =>
    // ACK sem observação na réplica é o que o normativo chama de ainda-não.
    expect(estadoDeEntrega("awaiting-confirmation")).toBe("sending"));
  it("failed → failed", () =>
    expect(estadoDeEntrega("failed")).toBe("failed"));
  it("dropped não vira bolha", () =>
    expect(estadoDeEntrega("dropped")).toBeNull());
});

describe("bolhaDaFila — o recorte de F-16", () => {
  it("item com clientRef, canal e conteúdo vira bolha casável", () => {
    const b = bolhaDaFila(item({ clientRef: "b-9", channelId: "ch-1" }));
    expect(b).toEqual({
      ref: "b-9",
      opId: "op-1",
      channelId: "ch-1",
      content: "olá",
      // §15.6 `enqueuedAt` — o instante do enfileiramento, não a época zero.
      timestamp: new Date(1_757_030_400_000).toISOString(),
      deliveryState: "queued",
    });
  });

  it("o carimbo da bolha é o do enfileiramento — nunca 1970", () => {
    const b = bolhaDaFila(item({ clientRef: "b-9", channelId: "ch-1", enqueuedAt: 1_700_000_000_000 }));
    expect(b?.timestamp).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it("sem clientRef não há bolha — correlação é a razão dela existir", () =>
    expect(bolhaDaFila(item({ channelId: "ch-1" }))).toBeNull());

  it("reação/edição/thread têm targetMessageId, não conteúdo: nunca viram linha", () =>
    expect(
      bolhaDaFila(item({ clientRef: "b-9", channelId: "ch-1", preview: { emoji: "👍", targetMessageId: "msg-1" } })),
    ).toBeNull());
});
