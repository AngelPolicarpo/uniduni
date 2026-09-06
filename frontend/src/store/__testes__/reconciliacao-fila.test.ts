/**
 * §11.6 (emenda de 2026-09-06) — o desfecho que o evento não entregou, lido de
 * `query.outbox`.
 *
 * O que se afirma: presença na fila é "ainda pendente"; `dropped` é descarte com motivo;
 * **ausência** é aceite, porque §11.6 só tira item da fila por observação na réplica. É o
 * que fecha o buraco de `message.accepted`/`dropped` perdido num `evStale` (§15.1 r. 4) ou
 * num reinício do núcleo — sem isso a bolha otimista ficava viva ao lado da linha real
 * (mensagem duplicada na tela para sempre) ou presa em "enviando".
 *
 * Verificado por mutação: tirar a guarda de `opIdPorRef` faz a bolha recém-criada — cujo
 * `message.send` ainda está em voo — ser lida como aceita e sumir da tela.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { compose, useMessageStore } from "../messageStore";
import type { Message } from "../../domain/types";

const CANAL = "ch-1";
const CANAIS = new Set([CANAL]);

function bolha(ref: string): Message {
  return {
    id: ref,
    channelId: CANAL,
    authorId: "eu",
    content: "olá",
    timestamp: new Date(1_757_030_400_000).toISOString(),
    edited: false,
    pinned: false,
    reactions: [],
    attachments: [],
    mentions: [],
    deliveryState: "sending",
  };
}

function real(id: string): Message {
  return { ...bolha(id), seq: 100, deliveryState: "sent" };
}

beforeEach(() => {
  useMessageStore.getState().reset();
});

describe("reconciliarPelaFila", () => {
  it("op que saiu da fila sem descarte é ACEITE: a bolha some e sobra a linha real", () => {
    useMessageStore.setState({
      sentByChannel: { [CANAL]: [bolha("ref-1")] },
      opIdPorRef: { "ref-1": "op-1" },
      remoteMessages: { [CANAL]: [real("msg-100")] },
    });

    useMessageStore.getState().reconciliarPelaFila({
      vivas: new Set(),
      desfeitas: [],
      canais: CANAIS,
    });

    const linhas = compose(
      [CANAL],
      useMessageStore.getState().sentByChannel,
      useMessageStore.getState().filaPorCanal,
      useMessageStore.getState().overrides,
      useMessageStore.getState().deletedIds,
      useMessageStore.getState().remoteMessages,
      useMessageStore.getState().aceitasRefs,
      useMessageStore.getState().remoteReactions,
    );
    expect(linhas.map((m) => m.id)).toEqual(["msg-100"]);
  });

  it("op AINDA na fila não é tocada — a bolha segue enquanto a entrega não fechou", () => {
    useMessageStore.setState({
      sentByChannel: { [CANAL]: [bolha("ref-1")] },
      opIdPorRef: { "ref-1": "op-1" },
    });

    useMessageStore.getState().reconciliarPelaFila({
      vivas: new Set(["ref-1"]),
      desfeitas: [],
      canais: CANAIS,
    });

    expect(useMessageStore.getState().sentByChannel[CANAL]).toHaveLength(1);
  });

  it("`dropped` vira falha nomeada, e não sumiço silencioso", () => {
    useMessageStore.setState({
      sentByChannel: { [CANAL]: [bolha("ref-1")] },
      opIdPorRef: { "ref-1": "op-1" },
    });

    useMessageStore.getState().reconciliarPelaFila({
      vivas: new Set(),
      desfeitas: [{ ref: "ref-1", motivo: "descartada (channel-deleted)" }],
      canais: CANAIS,
    });

    expect(useMessageStore.getState().errosPorRef["ref-1"]).toBe("descartada (channel-deleted)");
    expect(useMessageStore.getState().sentByChannel[CANAL]).toHaveLength(1);
  });

  it("bolha sem `opId` ainda não chegou ao núcleo: ausência da fila não a julga", () => {
    useMessageStore.setState({
      sentByChannel: { [CANAL]: [bolha("ref-nova")] },
    });

    useMessageStore.getState().reconciliarPelaFila({
      vivas: new Set(),
      desfeitas: [],
      canais: CANAIS,
    });

    expect(useMessageStore.getState().sentByChannel[CANAL]).toHaveLength(1);
  });

  it("escrita sobre mensagem real: o aceite aposenta o override em vez de mascarar a base", () => {
    useMessageStore.setState({
      remoteMessages: { [CANAL]: [{ ...real("msg-9"), content: "texto do log" }] },
      overrides: { "msg-9": { content: "minha edição" } },
      alvoPorRef: { "ref-e": { messageId: "msg-9", channelId: CANAL, campos: ["content"] } },
      opIdPorRef: { "ref-e": "op-e" },
    });

    useMessageStore.getState().reconciliarPelaFila({
      vivas: new Set(),
      desfeitas: [],
      canais: CANAIS,
    });

    expect(useMessageStore.getState().overrides["msg-9"]).toBeUndefined();
    expect(useMessageStore.getState().alvoPorRef["ref-e"]).toBeUndefined();
    expect(useMessageStore.getState().aceitasRefs["ref-e"]).toBe("msg-9");
  });

  it("descarte já tratado não é remarcado a cada resync", () => {
    useMessageStore.setState({
      sentByChannel: { [CANAL]: [bolha("ref-1")] },
      opIdPorRef: { "ref-1": "op-1" },
    });
    const desfeitas = [{ ref: "ref-1", motivo: "descartada (banned)" }];

    // A linha `dropped` fica em `local_outbox` para sempre (§11.2) e volta em toda resposta.
    useMessageStore.getState().reconciliarPelaFila({ vivas: new Set(), desfeitas, canais: CANAIS });
    useMessageStore.setState({ errosPorRef: {} });
    useMessageStore.setState({ sentByChannel: {} });
    useMessageStore.getState().reconciliarPelaFila({ vivas: new Set(), desfeitas, canais: CANAIS });

    // Sem otimismo na tela não há o que marcar: nenhum `ref` órfão em `errosPorRef`.
    expect(useMessageStore.getState().errosPorRef).toEqual({});
  });

  it("canal de outra comunidade não é julgado por esta resposta", () => {
    useMessageStore.setState({
      sentByChannel: { "ch-outra": [{ ...bolha("ref-1"), channelId: "ch-outra" }] },
      opIdPorRef: { "ref-1": "op-1" },
    });

    useMessageStore.getState().reconciliarPelaFila({
      vivas: new Set(),
      desfeitas: [],
      canais: CANAIS,
    });

    expect(useMessageStore.getState().sentByChannel["ch-outra"]).toHaveLength(1);
  });
});
