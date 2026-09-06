/**
 * §18.7/U-06 — o que o modal de saída do host afirma, e o que ele não pode afirmar.
 *
 * `montarImpacto` é a conta que decide se a janela fecha sozinha ou se a pessoa é
 * perguntada. Os dois defeitos que ela carregava:
 *
 *   - `pendingReplication` vinha com `?? 0`: sem resposta do núcleo — reiniciando, sem
 *     identidade, leitura falhando — o modal afirmava que nada estava por replicar,
 *     exatamente no caso em que §18.7 existe. Zero é uma afirmação sobre o disco DOS
 *     OUTROS; sem leitura não há como fazê-la, e `null` é o que se sabe;
 *   - com o mapa do núcleo vazio (o estado do primeiro instante), a lista saía vazia e
 *     quem ouvia o pedido de saída auto-confirmava o fechamento sem perguntar nada.
 */

import { describe, expect, it } from "vitest";
import { montarImpacto } from "../../features/host/hostExit";
import type { Community } from "../../domain/types";

function comunidade(over: Partial<Community> = {}): Community {
  return {
    id: "c1",
    name: "Comunidade",
    iconColor: "accent",
    hostPeerId: "peer-host",
    isHostedByMe: true,
    createdAt: "2026-09-06T00:00:00.000Z",
    memberCount: 3,
    categoryIds: [],
    roleIds: [],
    connectionHealth: { hostStatus: "online" },
    ...over,
  };
}

const SEM_VOZ = { euId: "eu", voiceCommunityId: null, outrosNaChamada: 0 };

describe("montarImpacto", () => {
  it("sem leitura do núcleo, o que falta replicar é `null` — não zero", () => {
    const r = montarImpacto({ communities: [comunidade()], doNucleo: null, ...SEM_VOZ });

    expect(r).toHaveLength(1);
    expect(r[0]?.pendingReplication).toBeNull();
  });

  it("impacto NÃO MEDIDO entra na lista: quem não mediu não pode dizer que não há", () => {
    // É o que impede a auto-confirmação silenciosa no boot, com a comunidade cheia.
    const r = montarImpacto({ communities: [comunidade()], doNucleo: null, ...SEM_VOZ });

    expect(r).not.toHaveLength(0);
  });

  it("com leitura completa e tudo zerado, a lista é vazia — e aí fechar é rotina", () => {
    const doNucleo = new Map([
      ["c1", { onlineCount: 0, inCallCount: 0, pendingReplication: 0 }],
    ]);

    expect(montarImpacto({ communities: [comunidade()], doNucleo, ...SEM_VOZ })).toHaveLength(0);
  });

  it("op pendente sozinha basta para perguntar (§18.7 passo 1)", () => {
    const doNucleo = new Map([
      ["c1", { onlineCount: 0, inCallCount: 0, pendingReplication: 4 }],
    ]);

    const r = montarImpacto({ communities: [comunidade()], doNucleo, ...SEM_VOZ });
    expect(r).toHaveLength(1);
    expect(r[0]?.pendingReplication).toBe(4);
  });

  it("comunidade que não é hospedada aqui nunca entra na conta", () => {
    const doNucleo = new Map([
      ["c1", { onlineCount: 9, inCallCount: 9, pendingReplication: 9 }],
    ]);

    const r = montarImpacto({
      communities: [comunidade({ isHostedByMe: false })],
      doNucleo,
      ...SEM_VOZ,
    });
    expect(r).toHaveLength(0);
  });

  it("o número do núcleo tem precedência sobre a derivação das stores", () => {
    const doNucleo = new Map([
      ["c1", { onlineCount: 2, inCallCount: 5, pendingReplication: 0 }],
    ]);

    const r = montarImpacto({
      communities: [comunidade()],
      doNucleo,
      euId: "eu",
      voiceCommunityId: "c1",
      outrosNaChamada: 1,
    });
    expect(r[0]?.inCall).toBe(5);
    expect(r[0]?.online).toBe(2);
  });
});
