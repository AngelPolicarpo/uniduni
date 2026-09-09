/**
 * A régua do rail: `query.communities` é a lista AUTORITATIVA de participação (§15.6), e a
 * comunidade ativa segue a mesma régua.
 *
 * O caso que motivou o teste é o "Excluir" do modo histórico (U-17/B8): `community.forget`
 * apaga a réplica no núcleo (manifest, bancos, disco), a resposta seguinte já não a traz —
 * e sem rebaixar a ativa que saiu da lista, o shell desenhava uma comunidade fantasma sobre
 * o registro velho do espelho, que a fusão da sincronização nunca remove.
 *
 * Verificado por mutação: voltar à régua antiga (`s.activeCommunityId ?? lista[0]?.id ??
 * null`) derruba os dois primeiros casos, porque a ativa velha sobrevivia à resposta.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  communities: vi.fn<() => Promise<unknown>>(),
  structure: vi.fn<() => Promise<unknown>>(),
  community: vi.fn<() => Promise<unknown>>(),
  roles: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("../../ipc/api", () => ({
  api,
  cliente: { subscribe: vi.fn(), onResync: vi.fn(), handleCoreEpoch: vi.fn() },
}));

import { sincronizarComunidade, sincronizarComunidades } from "../sincronizacao";
import { comunidade } from "../adaptadores";
import { useCommunityStore } from "../../store/communityStore";
import type { Community } from "../../domain/types";
import type { CommunityListItem } from "../../ipc/dto";

function item(id: string, name: string): CommunityListItem {
  return {
    id,
    name,
    iconColor: "azul",
    memberCount: 3,
    isHostedByMe: false,
    hostStatus: "online",
    replication: { state: "synced", lag: 0 },
    unread: { count: 0, mentions: 0 },
    notificationLevel: "all",
    partialInterpretation: false,
  };
}

const A = comunidade(item("a".repeat(32), "Alfa"));
const B = comunidade(item("b".repeat(32), "Beta"));

function semear(comunidades: Community[], ativa: string | null): void {
  useCommunityStore.setState({
    remote: {
      ...useCommunityStore.getState().remote,
      communities: Object.fromEntries(comunidades.map((c) => [c.id, c])),
    },
    joinedCommunityIds: comunidades.map((c) => c.id),
    activeCommunityId: ativa,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sincronizarComunidades — a ativa segue a lista autoritativa", () => {
  it("comunidade excluída sai do rail e deixa de ser a ativa", async () => {
    semear([A, B], A.id);
    api.communities.mockResolvedValue([B]);

    await sincronizarComunidades();

    const s = useCommunityStore.getState();
    expect(s.joinedCommunityIds).toEqual([B.id]);
    expect(s.activeCommunityId).toBe(B.id);
  });

  it("excluir a última: a ativa fica nula e o shell volta ao Hub vazio", async () => {
    semear([A], A.id);
    api.communities.mockResolvedValue([]);

    await sincronizarComunidades();

    const s = useCommunityStore.getState();
    expect(s.joinedCommunityIds).toEqual([]);
    expect(s.activeCommunityId).toBeNull();
  });

  it("ativa que continua na lista não é perturbada pela sincronização", async () => {
    semear([A, B], B.id);
    api.communities.mockResolvedValue([A, B]);

    await sincronizarComunidades();

    expect(useCommunityStore.getState().activeCommunityId).toBe(B.id);
  });
});

describe("sincronizarComunidade — poda de canais excluídos e fallback de ativo", () => {
  it("canal excluído de structure é podado de remote.channels e activeChannel faz fallback", async () => {
    semear([A], A.id);
    useCommunityStore.setState({
      activeChannelByCommunity: { [A.id]: "ch-deletado" },
      remote: {
        ...useCommunityStore.getState().remote,
        channels: {
          "ch-deletado": {
            id: "ch-deletado",
            communityId: A.id,
            categoryId: "cat-1",
            name: "deletado",
            type: "text",
            unreadCount: 0,
            pendingMentions: 0,
            muted: false,
            readOnly: false,
            speechMode: "free",
            queueTurnSeconds: 300,
          },
          "ch-geral": {
            id: "ch-geral",
            communityId: A.id,
            categoryId: "cat-1",
            name: "geral",
            type: "text",
            unreadCount: 0,
            pendingMentions: 0,
            muted: false,
            readOnly: false,
            speechMode: "free",
            queueTurnSeconds: 300,
          },
        },
        categories: {
          "cat-1": {
            id: "cat-1",
            communityId: A.id,
            name: "Geral",
            channelIds: ["ch-deletado", "ch-geral"],
            collapsed: false,
          },
        },
      },
    });

    api.structure.mockResolvedValue({
      categories: [
        {
          id: "cat-1",
          name: "Geral",
          channels: [
            {
              id: "ch-geral",
              name: "geral",
              type: "text",
              position: 0,
              unread: { count: 0, mentions: 0 },
              muted: false,
              readOnly: false,
            },
          ],
        },
      ],
    });
    api.community.mockResolvedValue({
      id: A.id,
      name: A.name,
      hostRef: { key: "host-key" },
      memberCount: 2,
    });
    api.roles.mockResolvedValue({ roles: [] });

    await sincronizarComunidade(A.id);

    const s = useCommunityStore.getState();
    // Canal deletado foi podado do espelho
    expect(s.remote.channels["ch-deletado"]).toBeUndefined();
    expect(s.remote.channels["ch-geral"]).toBeDefined();
    // Canal ativo da comunidade atualizou para ch-geral
    expect(s.activeChannelByCommunity[A.id]).toBe("ch-geral");
  });
});
