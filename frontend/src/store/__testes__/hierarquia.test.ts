/**
 * A hierarquia de §9.3 no espelho do renderer — o que a tela pode oferecer.
 *
 * O que se afirma: o host CORRENTE é imune mesmo sem o cargo Fundador (R-16,
 * `E_HOST_IMMUNE`), que é o caso que aparece depois de uma sucessão (R-18), quando quem
 * assumiu não carrega o cargo original; a permissão efetiva é a UNIÃO dos cargos (§9.2), e
 * não a do cargo de maior rank; e nenhum cargo com `rank ≥` o topo do autor é editável,
 * movível ou atribuível por ele (R-4), com o cargo Fundador fora antes disso
 * (`E_FOUNDER_IMMUTABLE`).
 *
 * Isto é affordance, não autorização: quem decide é o `fold` (§20.3, regras 8 e 9). O que
 * estes casos protegem é o produto não prometer uma ação que já sabe que será recusada.
 *
 * Verificado por mutação: tirar a conferência de `hostPeerId` derruba o caso da sucessão;
 * trocar a união por "cargo de maior rank" derruba o caso do Veterano sem permissão; trocar
 * `>` por `>=` em `selectCanActOnRole` derruba o caso do cargo de nível igual.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  selectCanActOnRole,
  selectCanModerate,
  selectHasPermission,
  selectLocalTopPosition,
  useCommunityStore,
} from "../communityStore";
import type { Community, Member, Role } from "../../domain/types";

const COM = "c1";

function cargo(id: string, position: number, extra: Partial<Role> = {}): Role {
  return {
    id,
    name: id,
    color: "role-neutral",
    position,
    permissions: [],
    mentionable: false,
    memberCount: 1,
    ...extra,
  };
}

function membro(identityId: string, roleIds: string[]): Member {
  return {
    identityId,
    communityId: COM,
    displayName: identityId,
    handle: identityId,
    avatarColor: "role-blue",
    roleIds,
    joinedAt: "",
    presence: "online",
    banned: false,
  };
}

/** Cargos: Fundador(4) · Admin(3) · Moderação(2, com `ban_members`) · Veterano(2, vazio) · base(1). */
const CARGOS: Record<string, Role> = {
  fundador: cargo("fundador", 4, { isFounder: true }),
  admin: cargo("admin", 3),
  moderacao: cargo("moderacao", 2, { permissions: ["ban_members", "kick_members"] }),
  veterano: cargo("veterano", 2),
  base: cargo("base", 1, { isDefault: true, permissions: ["send_messages"] }),
};

function montar(euRoles: string[], hostPeerId: string, membros: Member[]) {
  const community = {
    id: COM,
    name: "Raiz",
    iconColor: "blue",
    hostPeerId,
    isHostedByMe: false,
    createdAt: "",
    categoryIds: [],
    roleIds: Object.keys(CARGOS),
    memberCount: membros.length,
  } as unknown as Community;
  useCommunityStore.getState().aplicarRemoto({
    communities: { [COM]: community },
    roles: CARGOS,
    membersByCommunity: { [COM]: [membro("eu", euRoles), ...membros] },
    euId: "eu",
  });
  return useCommunityStore.getState();
}

beforeEach(() => {
  useCommunityStore.getState().aplicarRemoto({
    communities: {},
    roles: {},
    membersByCommunity: {},
    euId: null,
  });
});

describe("§9.3 no espelho do renderer", () => {
  it("o host corrente é imune mesmo sem o cargo Fundador (sucessão, R-18)", () => {
    // Quem assumiu o host mantém os cargos originais, abaixo do Admin que está moderando.
    const s = montar(["admin", "base"], "novoHost", [membro("novoHost", ["veterano", "base"])]);
    expect(selectCanModerate(s, COM, "novoHost")).toBe(false);
  });

  it("quem não é host nem Fundador, e está abaixo, continua sendo alvo", () => {
    const s = montar(["admin", "base"], "outroQualquer", [membro("alvo", ["veterano", "base"])]);
    expect(selectCanModerate(s, COM, "alvo")).toBe(true);
  });

  it("a permissão efetiva é a união dos cargos, não a do cargo de maior rank", () => {
    // Veterano é o cargo do GRUPO no roster (empatado no topo, sem permissão nenhuma).
    // `ban_members` vem de Moderação, e some se a leitura for só do cargo do grupo.
    const s = montar(["veterano", "moderacao", "base"], "host", []);
    expect(selectHasPermission(s, COM, "ban_members")).toBe(true);
    expect(selectHasPermission(s, COM, "manage_roles")).toBe(false);
  });

  it("cargo de nível igual ou superior não é editável, movível nem atribuível (R-4)", () => {
    const s = montar(["moderacao", "base"], "host", []);
    expect(selectLocalTopPosition(s, COM)).toBe(2);
    expect(selectCanActOnRole(s, COM, CARGOS["admin"]!)).toBe(false);
    // Mesmo nível também não: §9.3 é "estritamente menor", nunca igual.
    expect(selectCanActOnRole(s, COM, CARGOS["veterano"]!)).toBe(false);
    expect(selectCanActOnRole(s, COM, CARGOS["base"]!)).toBe(true);
  });

  it("o cargo Fundador não é alvo nem para o próprio Fundador (E_FOUNDER_IMMUTABLE)", () => {
    const s = montar(["fundador", "base"], "eu", []);
    expect(selectCanActOnRole(s, COM, CARGOS["fundador"]!)).toBe(false);
    expect(selectCanActOnRole(s, COM, CARGOS["admin"]!)).toBe(true);
  });
});
