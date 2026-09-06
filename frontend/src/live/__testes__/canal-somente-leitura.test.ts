/**
 * §6.7/R-22 e §15.6 — o canal somente-leitura, do DTO até o gate da tela.
 *
 * O que se afirma: quem resolve é o núcleo (`ChannelDto.readOnly`), a lista de cargos vem
 * junto **para a tela de edição**, e o seletor lê o booleano. O defeito que isto fecha era
 * de tradução: `readOnly: true` virava `readOnlyForRoleIds: []`, e lista vazia significa
 * "ninguém silenciado" — `#avisos` abria com o compositor liberado para qualquer pessoa, e
 * a recusa só aparecia depois de a mensagem ser escrita.
 *
 * Verificado por mutação: apagar o `if (channel.readOnly !== undefined)` do seletor
 * devolve o defeito (o canal do núcleo volta a ser gravável).
 */

import { describe, expect, it } from "vitest";
import { canal } from "../adaptadores";
import { selectIsChannelReadOnly, useCommunityStore } from "../../store/communityStore";
import type { ChannelDto } from "../../ipc/dto";

const dto = (sobre?: Partial<ChannelDto>): ChannelDto => ({
  id: "ch-avisos",
  name: "avisos",
  type: 0,
  rank: "a0",
  readOnly: false,
  readOnlyForRoleIds: [],
  muted: false,
  unread: { count: 0, mentions: 0 },
  speechMode: 0,
  queueTurnSeconds: 300,
  ...sobre,
});

function estado() {
  return useCommunityStore.getState();
}

describe("canal() — o que o adaptador preserva de §15.6", () => {
  it("o booleano resolvido chega ao domínio", () => {
    expect(canal("c1", "cat", dto({ readOnly: true, readOnlyForRoleIds: ["r-membro"] })).readOnly).toBe(true);
    expect(canal("c1", "cat", dto()).readOnly).toBe(false);
  });

  it("a lista de cargos silenciados chega junto — é o que a tela de edição reabre", () => {
    const c = canal("c1", "cat", dto({ readOnly: true, readOnlyForRoleIds: ["r-membro", "r-contrib"] }));
    expect(c.readOnlyForRoleIds).toEqual(["r-membro", "r-contrib"]);
  });

  it("`firstUnreadSeq` deixa de ser descartado: é a âncora do divisor", () => {
    expect(canal("c1", "cat", dto({ firstUnreadSeq: 42 })).firstUnreadSeq).toBe(42);
    expect(canal("c1", "cat", dto()).firstUnreadSeq).toBeUndefined();
  });
});

describe("selectIsChannelReadOnly — o gate lê o núcleo", () => {
  it("canal resolvido como somente-leitura bloqueia, mesmo com a lista carregada", () => {
    const c = canal("c1", "cat", dto({ readOnly: true, readOnlyForRoleIds: ["r-membro"] }));
    expect(selectIsChannelReadOnly(estado(), c)).toBe(true);
  });

  it("canal resolvido como gravável libera, mesmo com cargos silenciados na lista", () => {
    // R-22: basta um cargo de fora para escrever, e quem sabe disso é o núcleo.
    const c = canal("c1", "cat", dto({ readOnly: false, readOnlyForRoleIds: ["r-membro"] }));
    expect(selectIsChannelReadOnly(estado(), c)).toBe(false);
  });

  it("canal sem o campo resolvido (montado localmente) ainda cai na regra por cargo", () => {
    const c = { ...canal("c1", "cat", dto()), readOnly: undefined, readOnlyForRoleIds: ["r-x"] };
    expect(selectIsChannelReadOnly(estado(), c)).toBe(false);
  });
});
