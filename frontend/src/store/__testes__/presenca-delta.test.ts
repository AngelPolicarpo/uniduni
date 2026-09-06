/**
 * §17.6 `presence.changed` — o delta aplicado no roster.
 *
 * O que se afirma: o evento é aplicado, não reconsultado (exceção declarada à regra 5 de
 * §15.1 na emenda de 2026-09-06), `removed` volta a `offline`, e status fora da tabela
 * fechada é ignorado em vez de virar palpite.
 *
 * O defeito que isto fecha: `presence.changed` não tinha assinante nenhum em produto. O
 * roster ficava com a presença do último `query.members` — todo mundo marcado como estava
 * no instante da consulta — até um `members.changed` qualquer.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { useCommunityStore } from "../communityStore";
import type { Member } from "../../domain/types";

const CID = "c1";

function membro(id: string, presence: Member["presence"]): Member {
  return {
    identityId: id,
    communityId: CID,
    displayName: id,
    handle: id,
    avatarColor: "role-blue",
    roleIds: ["r-base"],
    joinedAt: new Date(0).toISOString(),
    presence,
    banned: false,
  };
}

beforeEach(() => {
  useCommunityStore.getState().aplicarRemoto({
    membersByCommunity: { [CID]: [membro("ana", "online"), membro("bia", "online")] },
  });
});

function presencaDe(id: string): string | undefined {
  return useCommunityStore
    .getState()
    .remote.membersByCommunity[CID]?.find((m) => m.identityId === id)?.presence;
}

describe("aplicarPresenca", () => {
  it("o delta muda só quem mudou", () => {
    useCommunityStore.getState().aplicarPresenca(CID, [{ identityKey: "ana", status: "dnd" }], []);
    expect(presencaDe("ana")).toBe("dnd");
    expect(presencaDe("bia")).toBe("online");
  });

  it("`removed` volta a offline — é o que a ausência de publicação significa (§6.1)", () => {
    useCommunityStore.getState().aplicarPresenca(CID, [], ["bia"]);
    expect(presencaDe("bia")).toBe("offline");
  });

  it("status fora da tabela fechada é ignorado, não vira palpite", () => {
    useCommunityStore.getState().aplicarPresenca(CID, [{ identityKey: "ana", status: "ausente" }], []);
    expect(presencaDe("ana")).toBe("online");
  });

  it("comunidade sem roster carregado não é inventada", () => {
    useCommunityStore.getState().aplicarPresenca("outra", [{ identityKey: "ana", status: "idle" }], []);
    expect(useCommunityStore.getState().remote.membersByCommunity["outra"]).toBeUndefined();
  });
});
