/**
 * A lista de convites de 3.1b: o que a interface pode mostrar, e o que ela pode copiar.
 *
 * Delta **U-04** — o segredo do convite nunca entra no log (`F-21`, `adr-v2.md` A08), então
 * `query.invites` só entrega o código a quem criou o convite NESTA instalação, e diz isso
 * em `codeAvailable`. O adaptador fazia `code: i.code ?? i.invitePublicKey`: a chave pública
 * de 64 hex ia para o campo do código, a tela a mostrava em fonte monoespaçada como se
 * fosse um, e oferecia "copiar link" de uma coisa que não resgata nada.
 *
 * E o link em si: §3.5 tem rota de protocolo só para `comunidadep2p://join/<CODE16>`. O que
 * era copiado — `p2p.app/invite/<code>` — não tem esquema, não casa nem a segunda gramática
 * de `codeOrLink` (§15.4), e é inerte em qualquer lugar onde seja colado.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  invites: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("../../ipc/api", () => ({
  api,
  cliente: { subscribe: vi.fn(), onResync: vi.fn(), handleCoreEpoch: vi.fn() },
}));

import { sincronizarConvites } from "../sincronizacao";
import { linkDeConvite } from "../../mocks/dataset";
import { useCommunityStore } from "../../store/communityStore";
import type { InviteItem } from "../../ipc/dto";

const CID = "c".repeat(32);
const CHAVE_MINHA = "a".repeat(64);
const CHAVE_ALHEIA = "b".repeat(64);
const CODIGO = "X7K2-QM9F-RT4B-N8ZP";

/** A gramática de `join/` de §3.5, copiada de `app/src/main/deeplink.ts`. */
const RE_JOIN = /^comunidadep2p:\/\/join\/([0-9A-HJKMNP-TV-Z]{16})$/;

function item(over: Partial<InviteItem>): InviteItem {
  return {
    invitePublicKey: CHAVE_MINHA,
    codeAvailable: true,
    code: CODIGO,
    createdBy: {
      key: "d".repeat(64),
      displayName: "Rafael",
      handle: "@rafael",
      avatarColor: "azul",
      collision: false,
    },
    createdAt: 1_700_000_000_000,
    uses: 0,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useCommunityStore.setState({ remote: { ...useCommunityStore.getState().remote, invites: [] } });
});

describe("sincronizarConvites — U-04", () => {
  it("o convite criado aqui carrega o código", async () => {
    api.invites.mockResolvedValue({ items: [item({})] });

    await sincronizarConvites(CID);

    const [convite] = useCommunityStore.getState().remote.invites;
    expect(convite?.code).toBe(CODIGO);
    expect(convite?.invitePublicKey).toBe(CHAVE_MINHA);
  });

  it("o convite de terceiro vem SEM código — e nunca com a chave pública no lugar dele", async () => {
    api.invites.mockResolvedValue({
      items: [item({ invitePublicKey: CHAVE_ALHEIA, codeAvailable: false, code: undefined })],
    });

    await sincronizarConvites(CID);

    const [convite] = useCommunityStore.getState().remote.invites;
    expect(convite?.code).toBeUndefined();
    expect(convite?.invitePublicKey).toBe(CHAVE_ALHEIA);
  });

  it("`codeAvailable: false` vence um `code` que venha junto por engano", async () => {
    api.invites.mockResolvedValue({
      items: [item({ codeAvailable: false, code: CODIGO })],
    });

    await sincronizarConvites(CID);

    expect(useCommunityStore.getState().remote.invites[0]?.code).toBeUndefined();
  });

  it("a chave pública é identificador estável — dois convites do mesmo autor não colidem", async () => {
    api.invites.mockResolvedValue({
      items: [
        item({ invitePublicKey: CHAVE_MINHA }),
        item({ invitePublicKey: CHAVE_ALHEIA, codeAvailable: false, code: undefined }),
      ],
    });

    await sincronizarConvites(CID);

    const chaves = useCommunityStore.getState().remote.invites.map((i) => i.invitePublicKey);
    expect(new Set(chaves).size).toBe(2);
  });
});

describe("linkDeConvite", () => {
  it("produz a forma que o sistema operacional abre (§3.5)", () => {
    expect(linkDeConvite(CODIGO)).toBe("comunidadep2p://join/X7K2QM9FRT4BN8ZP");
  });

  it("o resultado casa a gramática fechada de §3.5 — hífens de exibição não entram", () => {
    expect(RE_JOIN.test(linkDeConvite(CODIGO))).toBe(true);
    // O que se copiava antes não casa nada: sem esquema, não é rota de protocolo nem link.
    expect(RE_JOIN.test(`p2p.app/invite/${CODIGO}`)).toBe(false);
  });

  it("aceita o código já sem hífens e em caixa baixa", () => {
    expect(linkDeConvite("x7k2qm9frt4bn8zp")).toBe("comunidadep2p://join/X7K2QM9FRT4BN8ZP");
  });
});
