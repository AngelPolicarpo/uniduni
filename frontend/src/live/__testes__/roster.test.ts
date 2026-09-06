/**
 * `sincronizarMembros` — o roster que decide permissão e hierarquia na tela.
 *
 * O que se afirma: cada membro entra no espelho com **todos** os cargos ativos dele, e não
 * só com o cargo do grupo (§15.6, emenda de 2026-09-06); e o roster é lido **até o fim**,
 * seguindo `nextCursor`.
 *
 * Os dois vêm do mesmo defeito, visto de dois ângulos. §9.2 define a permissão efetiva como
 * a UNIÃO dos cargos e R-3 exige o cargo base dentro de `member.setRoles`: com um cargo só,
 * a tela escondia ação que o `fold` autoriza e mandava `setRoles` sem o base
 * (`E_BASE_ROLE_REQUIRED` garantido). Com o roster truncado no primeiro lote, quem ficasse
 * de fora aparecia sem cargo nenhum, que é a mesma cegueira por outro caminho.
 *
 * Verificado por mutação: voltar a `roleIds: [roleId-do-grupo]` derruba o primeiro caso;
 * parar no primeiro lote derruba o segundo.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemberEntry, MembersPage } from "../../ipc/dto";

const api = vi.hoisted(() => ({
  members: vi.fn<(a: { cursor?: string }) => Promise<unknown>>(),
}));

vi.mock("../../ipc/api", () => ({
  api,
  cliente: { subscribe: vi.fn(), onResync: vi.fn(), handleCoreEpoch: vi.fn() },
}));
vi.mock("../sessao", () => ({
  registrarResync: vi.fn(),
  useSessao: { getState: () => ({ estado: "inicial", iniciar: vi.fn() }) },
}));
vi.mock("../../store/downloadStore", () => ({ useDownloadStore: { getState: () => ({}) } }));

import { sincronizarMembros } from "../sincronizacao";
import { useCommunityStore } from "../../store/communityStore";

const COM = "c1";

function entrada(key: string, roleIds: string[]): MemberEntry {
  return {
    key,
    displayName: key,
    handle: key,
    avatarColor: "blue",
    collision: false,
    presence: "online",
    joinedAt: 1_700_000_000_000,
    roleIds,
  };
}

function pagina(
  members: MemberEntry[],
  roleId: string,
  nextCursor?: string,
): MembersPage {
  return {
    groups: [{ roleId, roleName: roleId, roleColor: "1", rank: "a0", members }],
    offlineCount: 0,
    total: members.length,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

function roster() {
  return useCommunityStore.getState().remote.membersByCommunity[COM] ?? [];
}

beforeEach(() => {
  vi.clearAllMocks();
  const store = useCommunityStore.getState();
  store.aplicarRemoto({ membersByCommunity: { [COM]: [] } });
});

describe("sincronizarMembros — roster de §15.6", () => {
  it("o membro carrega todos os cargos ativos, não só o do grupo", async () => {
    // O grupo é "veterano" (maior rank, sem permissão nenhuma); a pessoa também é
    // "moderacao" e tem o cargo base. É a união disso que §9.2 manda a tela ler.
    api.members.mockResolvedValue(
      pagina([entrada("ana", ["veterano", "moderacao", "base"])], "veterano"),
    );

    await sincronizarMembros(COM);

    expect(roster()).toHaveLength(1);
    expect(roster()[0]!.roleIds).toEqual(["veterano", "moderacao", "base"]);
  });

  it("host antigo, sem roleIds na resposta, cai no cargo do grupo em vez de ficar sem cargo", async () => {
    const antiga = entrada("ana", []);
    delete (antiga as { roleIds?: string[] }).roleIds;
    api.members.mockResolvedValue(pagina([antiga], "veterano"));

    await sincronizarMembros(COM);

    expect(roster()[0]!.roleIds).toEqual(["veterano"]);
  });

  it("segue nextCursor até o fim: roster maior que um lote não fica pela metade", async () => {
    api.members
      .mockResolvedValueOnce(pagina([entrada("ana", ["base"])], "base", "cur1"))
      .mockResolvedValueOnce(pagina([entrada("rafa", ["base"])], "base"));

    await sincronizarMembros(COM);

    expect(api.members).toHaveBeenCalledTimes(2);
    expect(api.members.mock.calls[1]![0]).toMatchObject({ cursor: "cur1" });
    expect(roster().map((m) => m.identityId)).toEqual(["ana", "rafa"]);
  });

  it("falha no meio do roster não substitui o espelho por meia lista", async () => {
    api.members
      .mockResolvedValueOnce(pagina([entrada("ana", ["base"])], "base", "cur1"))
      .mockRejectedValueOnce(new Error("E_HOST_UNAVAILABLE"));

    await sincronizarMembros(COM);

    expect(roster()).toEqual([]);
  });
});
