/**
 * O badge de não-lidas da thread (§9, 2.2) — `query.thread.unread` sobre o canal ativo.
 *
 * O que se afirma: só threads com contador acima de zero entram no mapa (ausência é
 * "lida", nunca zero inventado); a reconsulta substitui o mapa INTEIRO — thread que foi
 * lida sai, porque o fio é quem manda no conjunto; falha de consulta preserva o espelho;
 * e abrir o painel marca leitura pela escrita injetada (`thread.markRead`) além de
 * hidratar. Verificado por mutação: remover a chamada de `marcarThreadLida` em
 * `hidratarThread` derruba o caso correspondente.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  thread: vi.fn<() => Promise<unknown>>(),
  threadUnread: vi.fn<() => Promise<unknown>>(),
  threadMarkRead: vi.fn<() => Promise<{ unreadCount: number }>>(),
}));

vi.mock("../../ipc/api", () => ({ api }));
vi.mock("../sessao", () => ({ registrarResync: vi.fn(), useSessao: { getState: () => ({ estado: "inicial", iniciar: vi.fn() }) } }));
vi.mock("../../store/downloadStore", () => ({ useDownloadStore: { getState: () => ({}) } }));
vi.mock("../../store/communityStore", () => ({
  useCommunityStore: { getState: () => ({ remote: { euId: null }, activeChannelByCommunity: { c1: "ch-1" } }) },
}));

import { sincronizarThreadsNaoLidas } from "../sincronizacao";
import { useMessageStore } from "../../store/messageStore";
import type { CanalDeEscrita } from "../../store/messageStore";

beforeEach(() => {
  vi.clearAllMocks();
  useMessageStore.setState({ naoLidasPorThread: {} });
});

describe("sincronizarThreadsNaoLidas — §9, 2.2", () => {
  it("só threads com contador vivo entram; lida é AUSÊNCIA, não zero", async () => {
    api.threadUnread.mockResolvedValue({
      items: [
        { threadId: "t1", rootMessageId: "m1", channelId: "ch-1", unreadCount: 3 },
        { threadId: "t2", rootMessageId: "m2", channelId: "ch-1", unreadCount: 1 },
      ],
      hasMore: false,
    });

    await sincronizarThreadsNaoLidas("c1", "ch-1");

    expect(useMessageStore.getState().naoLidasPorThread["ch-1"]).toEqual({ t1: 3, t2: 1 });
    expect("t0" in useMessageStore.getState().naoLidasPorThread["ch-1"]!).toBe(false);
  });

  it("a reconsulta SUBSTITUI o mapa: a thread que foi lida sai do badge", async () => {
    useMessageStore.getState().aplicarNaoLidasDeThreads("ch-1", { t1: 3 });
    api.threadUnread.mockResolvedValue({ items: [], hasMore: false });

    await sincronizarThreadsNaoLidas("c1", "ch-1");

    expect(useMessageStore.getState().naoLidasPorThread["ch-1"]).toEqual({});
  });

  it("falha de consulta preserva o espelho", async () => {
    useMessageStore.getState().aplicarNaoLidasDeThreads("ch-1", { t1: 3 });
    api.threadUnread.mockRejectedValue(new Error("E_HOST_UNAVAILABLE"));

    await sincronizarThreadsNaoLidas("c1", "ch-1");

    expect(useMessageStore.getState().naoLidasPorThread["ch-1"]).toEqual({ t1: 3 });
  });

  it("a resposta atrasada de OUTRO canal não apaga os badges do canal aberto", async () => {
    useMessageStore.getState().aplicarNaoLidasDeThreads("ch-2", { t9: 4 });
    api.threadUnread.mockResolvedValue({ items: [], hasMore: false });

    // #geral responde depois, e vazio: só o mapa de #geral pode mudar.
    await sincronizarThreadsNaoLidas("c1", "ch-1");

    expect(useMessageStore.getState().naoLidasPorThread["ch-2"]).toEqual({ t9: 4 });
    expect(useMessageStore.getState().naoLidasPorThread["ch-1"]).toEqual({});
  });
});

describe("hidratarThread — abrir o painel É ler", () => {
  it("hidrata E marca leitura pela escrita injetada", () => {
    const escrita = {
      observarThread: vi.fn(),
      marcarThreadLida: vi.fn(),
    } as unknown as CanalDeEscrita;
    useMessageStore.getState().configurarEscrita(escrita);

    useMessageStore.getState().hidratarThread("c1", "t9");

    expect(escrita.observarThread).toHaveBeenCalledWith("c1", "t9");
    expect(escrita.marcarThreadLida).toHaveBeenCalledWith("c1", "t9");
  });
});
