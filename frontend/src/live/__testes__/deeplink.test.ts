/**
 * §3.5 — o que cada rota de deep link faz com a UI, e o que ela nunca faz.
 *
 * O que se afirma: as três rotas **posicionam** e nenhuma dispara ação (regra 3) — `u/`
 * não chama `dm.open`, `join/` não chama `invite.redeem`. E as três posicionam de verdade
 * (emenda de 2026-09-05): `u/` leva ao destino de conversas, `join/` abre a prévia de 0.3
 * com o convite pendente, `m/` fica com o MSGREF esperando quem o desenhe.
 *
 * `assinarDeepLinks` é coberta à parte porque o defeito não estava em `receber`: era a
 * ausência da chamada que registra a escuta.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  dmOpen: vi.fn(),
  inviteResolve: vi.fn(),
  resolveMessageLink: vi.fn(),
}));

vi.mock("../../ipc/api", () => ({
  api,
  cliente: { subscribe: vi.fn(), onResync: vi.fn(), handleCoreEpoch: vi.fn() },
}));

import { useDeeplinks, assinarDeepLinks } from "../deeplink";
import { usePendingInviteStore } from "../../store/inviteStore";
import { useUiStore } from "../../store/uiStore";

const OUTRA = "bb".repeat(32);
/** 16 chars Crockford — a gramática de §12.1 que o main já validou. */
const CODIGO = "X7K2QM9FRT4BN8ZP";

beforeEach(() => {
  vi.clearAllMocks();
  useDeeplinks.setState({ mensagem: null, contato: null });
  usePendingInviteStore.getState().clearPendingInvite();
  useUiStore.getState().closeOverlay();
  useUiStore.getState().abrirComunidades();
});

describe("deep link de pessoa — confirmação, nunca ação", () => {
  it("preenche o contato e não chama `dm.open`", async () => {
    await useDeeplinks.getState().receber({ route: "user", key: OUTRA });

    expect(useDeeplinks.getState().contato).toEqual({ peerKey: OUTRA });
    expect(api.dmOpen).not.toHaveBeenCalled();
  });

  it("normaliza a caixa da chave para minúsculas", async () => {
    await useDeeplinks.getState().receber({ route: "user", key: OUTRA.toUpperCase() });

    expect(useDeeplinks.getState().contato).toEqual({ peerKey: OUTRA });
  });

  it("fechar o contato limpa a intenção pendente", async () => {
    await useDeeplinks.getState().receber({ route: "user", key: OUTRA });
    useDeeplinks.getState().fecharContato();

    expect(useDeeplinks.getState().contato).toBeNull();
  });

  it("um segundo link substitui o anterior, sem acumular", async () => {
    const SEGUNDA = "cc".repeat(32);
    await useDeeplinks.getState().receber({ route: "user", key: OUTRA });
    await useDeeplinks.getState().receber({ route: "user", key: SEGUNDA });

    expect(useDeeplinks.getState().contato).toEqual({ peerKey: SEGUNDA });
    expect(api.dmOpen).not.toHaveBeenCalled();
  });
});

describe("deep link de convite — prévia, nunca resgate", () => {
  it("guarda o convite pendente e abre a prévia de 0.3", async () => {
    await useDeeplinks.getState().receber({ route: "join", code: CODIGO });

    expect(usePendingInviteStore.getState().pendingInviteCode).toBe(CODIGO);
    expect(useUiStore.getState().overlay).toBe("join-community");
    expect(useUiStore.getState().joinSource).toBe("link");
  });

  it("volta ao destino de comunidades — a confirmação não flutua sobre a lista de DMs", async () => {
    useUiStore.getState().abrirDm();

    await useDeeplinks.getState().receber({ route: "join", code: CODIGO });

    expect(useUiStore.getState().destino).toBe("comunidade");
  });

  it("não resolve nem resgata sozinho (§3.5 regra 3)", async () => {
    await useDeeplinks.getState().receber({ route: "join", code: CODIGO });

    expect(api.inviteResolve).not.toHaveBeenCalled();
  });
});

describe("deep link de mensagem", () => {
  it("guarda o MSGREF sem resolver — quem chama o núcleo é a tela, com núcleo de pé", async () => {
    await useDeeplinks.getState().receber({ route: "message", ref: "a".repeat(86) });

    expect(useDeeplinks.getState().mensagem).toEqual({
      ref: "a".repeat(86),
      resultado: null,
    });
    expect(api.resolveMessageLink).not.toHaveBeenCalled();
  });

  it("o resultado só é aceito para o MSGREF que ainda está em voo", async () => {
    await useDeeplinks.getState().receber({ route: "message", ref: "a".repeat(86) });
    useDeeplinks.getState().definirResultado("b".repeat(86), { status: "deleted" });

    expect(useDeeplinks.getState().mensagem?.resultado).toBeNull();
  });
});

describe("a escuta do main", () => {
  /*
    O defeito não estava em `receber` — estava em ninguém chamar `assinarDeepLinks`. Um
    teste que exercita `receber()` direto passa com a escuta jamais registrada, que foi
    exatamente o que aconteceu. Aqui o degrau testado é o de baixo: o evento que o preload
    dispara na janela precisa chegar ao store, e parar de chegar quando a assinatura é
    desfeita.

    A suíte roda em Node, sem DOM: a janela é o mínimo que `ouvirDeepLinks` usa.
  */
  const ouvintes = new Map<string, Set<(ev: unknown) => void>>();

  beforeEach(() => {
    ouvintes.clear();
    (globalThis as { window?: unknown }).window = {
      addEventListener(tipo: string, cb: (ev: unknown) => void) {
        const set = ouvintes.get(tipo) ?? new Set();
        set.add(cb);
        ouvintes.set(tipo, set);
      },
      removeEventListener(tipo: string, cb: (ev: unknown) => void) {
        ouvintes.get(tipo)?.delete(cb);
      },
    };
  });

  function emitir(detail: unknown): void {
    for (const cb of ouvintes.get("deeplink") ?? []) cb({ detail });
  }

  it("assinar registra a escuta, e o evento do preload chega ao store", async () => {
    const parar = assinarDeepLinks();

    emitir({ route: "user", key: OUTRA });
    await Promise.resolve();

    expect(useDeeplinks.getState().contato).toEqual({ peerKey: OUTRA });

    parar();
    useDeeplinks.setState({ contato: null });
    emitir({ route: "user", key: OUTRA });
    await Promise.resolve();

    expect(useDeeplinks.getState().contato).toBeNull();
  });
});
