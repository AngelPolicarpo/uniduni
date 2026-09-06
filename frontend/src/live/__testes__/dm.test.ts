/**
 * A ponte de §31.16 entre o núcleo e a store da conversa direta — U-33 / B60.
 *
 * O que se afirma aqui é o comportamento que os testes de regra não alcançam, porque
 * depende de ordem e de chamada ao fio:
 *
 * - `dm.reordered` descarta a faixa **antes** da reconsulta (é o único dos doze eventos
 *   que aplica payload — ver o cabeçalho de `live/dm.ts`);
 * - abrir uma conversa chama `dm.activate` (residência do projetor, §31.16.1) e só marca
 *   como lida **depois** de carregar;
 * - `E_LIMIT_EXCEEDED` num pedido vira a superfície do teto de §31.9 regra 4, e não um
 *   toast que some;
 * - o envio que falha **não** deixa estado pendente na store: não há outbox (§31.10).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  dmConversations: vi.fn<() => Promise<unknown>>(),
  dmConversation: vi.fn<() => Promise<unknown>>(),
  dmMessages: vi.fn<() => Promise<unknown>>(),
  dmPrefs: vi.fn<() => Promise<unknown>>(),
  dmActivate: vi.fn<() => Promise<unknown>>(),
  dmMarkRead: vi.fn<() => Promise<unknown>>(),
  dmAccept: vi.fn<() => Promise<unknown>>(),
  dmOpen: vi.fn<() => Promise<unknown>>(),
  dmSend: vi.fn<() => Promise<unknown>>(),
  dmForget: vi.fn<() => Promise<unknown>>(),
  dmBlock: vi.fn<() => Promise<unknown>>(),
  dmMessage: vi.fn<() => Promise<unknown>>(),
  filePickForAttachment: vi.fn<() => Promise<unknown>>(),
  blobStage: vi.fn<() => Promise<unknown>>(),
  blobDownload: vi.fn<() => Promise<unknown>>(),
}));
const cliente = vi.hoisted(() => ({ subscribe: vi.fn() }));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
// §31.15 — a mídia mora no renderer, e `live/dm.ts` a desliga ao bloquear ou esquecer.
// O que se afirma aqui é a ORDEM (desligar antes do comando), não o WebRTC.
const voz = vi.hoisted(() => ({ desligar: vi.fn<() => Promise<void>>() }));

vi.mock("../../ipc/api", () => ({ api, cliente }));
vi.mock("../dmVoz", () => voz);
vi.mock("../../store/toastStore", () => ({
  useToastStore: { getState: () => toast },
}));

import {
  abrirConversa,
  abrirConversaCom,
  aceitarConversa,
  anexarArquivo,
  assinarDm,
  bloquearConversa,
  carregarAnexo,
  enviarMensagem,
  esquecerConversa,
  sincronizarConversas,
} from "../dm";
import { anexo as paraDominio } from "../adaptadores";
import { useDmStore } from "../../store/dmStore";
import { useDmCallStore } from "../../store/dmCallStore";
import { useDownloadStore } from "../../store/downloadStore";
import type { DmMessageDto } from "../../ipc/dto";

const par = { key: "aa", displayName: "Ana", handle: "@ana", avatarColor: 0 };

function msg(id: string, ordSum: number): DmMessageDto {
  return {
    id,
    ordSum,
    conversationId: "c1",
    author: par,
    content: id,
    ts: 1,
    clockSkewed: false,
    ackAhead: false,
    hasAttachment: false,
    deleted: false,
  };
}

function ouvinte(topic: string): (d: unknown) => void {
  const chamada = cliente.subscribe.mock.calls.find((c) => c[0] === topic);
  if (chamada === undefined) throw new Error(`sem assinatura de ${topic}`);
  return chamada[1] as (d: unknown) => void;
}

beforeEach(() => {
  vi.clearAllMocks();
  useDmStore.setState({
    conversas: [],
    detalhe: null,
    ativa: null,
    porConversa: {},
    contactPolicy: "anyone",
    pendentesNoTeto: false,
    digitando: {},
  });
  api.dmConversations.mockResolvedValue({ conversations: [] });
  api.dmMessages.mockResolvedValue({
    messages: [],
    hasMore: false,
    sync: "synced",
    lastReadOrdSum: -1,
    lastReadAuthorKey: "",
  });
  api.dmConversation.mockResolvedValue(null);
  api.dmActivate.mockResolvedValue({ residency: "active" });
  api.dmMarkRead.mockResolvedValue({ unreadCount: 0 });
});

describe("§31.16.1 — abrir uma conversa", () => {
  it("chama `dm.activate` e só marca como lida DEPOIS de carregar", async () => {
    const ordem: string[] = [];
    api.dmActivate.mockImplementation(async () => {
      ordem.push("activate");
      return { residency: "active" };
    });
    api.dmMessages.mockImplementation(async () => {
      ordem.push("messages");
      return { messages: [msg("m1", 1)], hasMore: false, sync: "synced" };
    });
    api.dmMarkRead.mockImplementation(async () => {
      ordem.push("markRead");
      return { unreadCount: 0 };
    });

    await abrirConversa("c1");

    // Marcar antes de carregar daria por lido o que a tela ainda não tem (A28).
    expect(ordem).toEqual(["activate", "messages", "markRead"]);
    expect(useDmStore.getState().ativa).toBe("c1");
    expect(useDmStore.getState().porConversa["c1"]?.mensagens.map((m) => m.id)).toEqual(["m1"]);
  });
});

describe("§31.16.1 `dm.open` — a porta de entrada, que faltava", () => {
  it("colar uma chave abre a conversa: sincronizar e parar seria pedir para escolher de novo o que se acabou de pedir", async () => {
    api.dmOpen.mockResolvedValue({ conversationId: "c9", state: "pending-out" });
    const id = await abrirConversaCom("bb".repeat(32));
    expect(id).toBe("c9");
    expect(api.dmOpen).toHaveBeenCalledWith("bb".repeat(32));
    // O que confirma que ela abriu: `dm.activate` é o que decide a residência do projetor.
    expect(api.dmActivate).toHaveBeenCalledWith("c9");
    expect(useDmStore.getState().ativa).toBe("c9");
  });

  it("`E_LIMIT_EXCEEDED` continua indo para a superfície do teto, não para um toast que some", async () => {
    api.dmOpen.mockRejectedValue(Object.assign(new Error("x"), { code: "E_LIMIT_EXCEEDED" }));
    expect(await abrirConversaCom("bb".repeat(32))).toBeNull();
    expect(useDmStore.getState().pendentesNoTeto).toBe(true);
    expect(useDmStore.getState().ativa).toBeNull();
  });

  it("uma recusa não deixa conversa aberta pela metade", async () => {
    api.dmOpen.mockRejectedValue(Object.assign(new Error("x"), { code: "E_DM_BLOCKED" }));
    expect(await abrirConversaCom("bb".repeat(32))).toBeNull();
    expect(api.dmActivate).not.toHaveBeenCalled();
    expect(useDmStore.getState().ativa).toBeNull();
  });
});

describe("§31.13 — `dm.reordered` é o evento que a UI não pode ignorar", () => {
  it("descarta a faixa na hora, antes de a reconsulta voltar", async () => {
    assinarDm();
    useDmStore.setState({
      ativa: "c1",
      porConversa: {
        c1: {
          mensagens: [msg("m1", 1), msg("m2", 2), msg("m3", 3)],
          temMais: false,
          recarregando: false,
        },
      },
    });
    // A reconsulta fica pendurada: o que se mede é o estado ANTES de ela responder.
    api.dmMessages.mockReturnValue(new Promise(() => {}));

    ouvinte("dm.reordered")({ conversationId: "c1", fromOrdSum: 2 });

    const carregada = useDmStore.getState().porConversa["c1"];
    expect(carregada?.mensagens.map((m) => m.ordSum)).toEqual([1]);
    // Sem esta marca a conversa apareceria simplesmente encolhida.
    expect(carregada?.recarregando).toBe(true);
    expect(api.dmMessages).toHaveBeenCalled();
  });

  it("os outros eventos NÃO mexem na lista: são sinal para reconsultar (§15.1 r. 5)", async () => {
    assinarDm();
    useDmStore.setState({
      ativa: "c1",
      porConversa: { c1: { mensagens: [msg("m1", 1)], temMais: false, recarregando: false } },
    });
    api.dmMessages.mockReturnValue(new Promise(() => {}));

    ouvinte("dm.appended")({ conversationId: "c1", fromOrdSum: 1, toOrdSum: 2, hasIncoming: true });

    expect(useDmStore.getState().porConversa["c1"]?.mensagens).toHaveLength(1);
    expect(useDmStore.getState().porConversa["c1"]?.recarregando).toBe(false);
  });
});

describe("§31.9 regra 4 — o teto de pendentes precisa aparecer", () => {
  it("`E_LIMIT_EXCEEDED` liga a superfície do teto, e não vira toast que some", async () => {
    // Não há descarte silencioso do mais antigo: um pedido recusado que ninguém vê é o
    // mesmo que o descarte que a regra recusa.
    api.dmAccept.mockRejectedValue(Object.assign(new Error("cheio"), { code: "E_LIMIT_EXCEEDED" }));

    await aceitarConversa("c1");

    expect(useDmStore.getState().pendentesNoTeto).toBe(true);
    expect(toast.showToast).not.toHaveBeenCalled();
  });

  it("aceitar com sucesso desliga o teto — a fila abriu uma vaga", async () => {
    useDmStore.setState({ pendentesNoTeto: true });
    api.dmAccept.mockResolvedValue({ state: "accepted" });

    await aceitarConversa("c1");

    expect(useDmStore.getState().pendentesNoTeto).toBe(false);
  });
});

describe("§31.10 — não há outbox, e a store não pode inventar uma", () => {
  it("envio que falha não deixa mensagem nenhuma na conversa", async () => {
    api.dmSend.mockRejectedValue(Object.assign(new Error("x"), { code: "E_INTERNAL" }));
    useDmStore.setState({
      ativa: "c1",
      porConversa: { c1: { mensagens: [], temMais: false, recarregando: false } },
    });

    const ok = await enviarMensagem("c1", "oi");

    expect(ok).toBe(false);
    // Nada de `pending`/`failed`: os cinco estados de outbox não são declarados em §31.11
    // porque não podem ocorrer, e uma linha "falhou" seria um deles.
    expect(useDmStore.getState().porConversa["c1"]?.mensagens).toEqual([]);
    expect(toast.showToast).toHaveBeenCalledWith("A mensagem não foi escrita", "error");
  });

  it("envio que resolve recarrega a conversa — a mensagem já está no log", async () => {
    api.dmSend.mockResolvedValue({ messageId: "m9", ordSum: 9 });
    api.dmMessages.mockResolvedValue({ messages: [msg("m9", 9)], hasMore: false, sync: "synced" });

    expect(await enviarMensagem("c1", "oi")).toBe(true);
    expect(useDmStore.getState().porConversa["c1"]?.mensagens.map((m) => m.id)).toEqual(["m9"]);
  });
});

describe("A lista", () => {
  it("falha de consulta preserva o espelho em vez de esvaziar a tela", async () => {
    useDmStore.setState({
      conversas: [
        {
          conversationId: "c1",
          peer: par,
          state: "accepted",
          sync: "synced",
          unread: { count: 0 },
        },
      ],
    });
    api.dmConversations.mockRejectedValue(new Error("sem porta"));

    await sincronizarConversas();

    expect(useDmStore.getState().conversas).toHaveLength(1);
  });
});

describe("§31.14 — anexos, reusando §13 sem alteração", () => {
  const anexo = {
    blobsCoreKey: "ab".repeat(32),
    blobId: { byteOffset: 0, blockOffset: 0, blockLength: 1, byteLength: 9 },
    name: "nota.txt",
    sizeBytes: 9,
    kind: 0,
    hash: "cd".repeat(32),
    state: "local",
    progress: 1,
    availablePeers: 0,
    hostAvailable: false,
  };

  it("o clipe faz `blob.stage` NA HORA: o blob existe antes de a mensagem existir", async () => {
    // §13.7 — o blob primeiro, a mensagem depois. Se o stage acontecesse no envio, a
    // mensagem poderia entrar no log apontando para bytes que ainda não foram escritos.
    api.filePickForAttachment.mockResolvedValue({ ticketId: "t1", name: "nota.txt", sizeBytes: 9, kind: 0 });
    api.blobStage.mockResolvedValue(anexo);

    const r = await anexarArquivo("c1");

    expect(api.filePickForAttachment).toHaveBeenCalledWith("c1");
    expect(api.blobStage).toHaveBeenCalledWith("t1");
    expect(r).toEqual(anexo);
  });

  it("cancelar o diálogo é desfecho normal — não vira erro na tela", async () => {
    api.filePickForAttachment.mockRejectedValue(Object.assign(new Error("x"), { code: "E_CANCELLED" }));

    expect(await anexarArquivo("c1")).toBeNull();
    expect(toast.showToast).not.toHaveBeenCalled();
  });

  it("o que vai no `dm.send` é o resultado do stage, nunca algo montado pela tela", async () => {
    api.dmSend.mockResolvedValue({ messageId: "m1", ordSum: 1 });
    api.dmMessages.mockResolvedValue({
    messages: [],
    hasMore: false,
    sync: "synced",
    lastReadOrdSum: -1,
    lastReadAuthorKey: "",
  });

    await enviarMensagem("c1", "olha", anexo);

    expect(api.dmSend).toHaveBeenCalledWith({
      conversationId: "c1",
      content: "olha",
      attachment: anexo,
    });
  });

  it("baixar usa o `conversationId` no slot do escopo — §13.4 reutilizado sem alteração", () => {
    // §31.14: o escopo de um blob é o escopo de replicação dele, e numa DM ele é a
    // conversa (§31.1). O comando de §15.4 não ganha campo novo.
    //
    // Quem baixa é o MESMO `downloadStore` do cartão da comunidade (correção de
    // 2026-09-05): o `baixarAnexo` que existia aqui mandava `blob.download` e não escutava
    // nenhum dos cinco eventos de desfecho, então o cartão da DM nunca saía do botão.
    api.blobDownload.mockResolvedValue({ state: "downloading" });
    useDownloadStore.getState().reset();

    useDownloadStore.getState().iniciar(paraDominio({ ...anexo, progress: 0 }, "c1"));

    expect(api.blobDownload).toHaveBeenCalledWith({
      communityId: "c1",
      blobsCoreKey: anexo.blobsCoreKey,
      blobId: anexo.blobId,
    });
  });

  it("a correlação com `blob.progress` é o `blobIdHex` — os 16 primeiros bytes do hash", () => {
    // §15.6.1 (emenda de 2026-09-05, fecha B14). Sem esta igualdade o progresso do fio
    // chega chaveado por uma coisa e o cartão procura por outra: era exatamente o que
    // deixava o cartão da DM parado enquanto os bytes desciam.
    expect(paraDominio({ ...anexo, progress: 0 }, "c1").id).toBe(anexo.hash.slice(0, 32));
  });
});

describe("§31.16.1 — a marca de leitura só cai quando a tela ficou com a conversa", () => {
  it("a página que falhou NÃO marca como lida: o selo é de mensagem que ninguém viu", () => {
    // `carregarMensagens` engole a recusa por desenho (a tela segue legível com o que já
    // tinha); engoli-la E marcar como lida apagava o selo de uma conversa que não abriu.
    api.dmMessages.mockRejectedValue(new Error("rede"));

    return abrirConversa("c1").then(() => {
      expect(api.dmMarkRead).not.toHaveBeenCalled();
    });
  });

  it("trocar de conversa no meio da abertura não marca a que ficou para trás", async () => {
    // Abrir A e clicar em B: as promessas de A resolvem depois, e o `markRead` de A zerava
    // o selo de uma conversa que a tela nunca chegou a mostrar. `recarregarDetalhe` sempre
    // teve esta guarda; o `markRead` não tinha.
    api.dmMessages.mockImplementation(async () => {
      useDmStore.getState().setAtiva("c2");
      return { messages: [], hasMore: false, sync: "synced", lastReadOrdSum: -1, lastReadAuthorKey: "" };
    });

    await abrirConversa("c1");

    expect(api.dmMarkRead).not.toHaveBeenCalled();
  });
});

describe("§31.16.2 `dm.appended` — a conversa em foco não acumula não lidas", () => {
  it("lote COM `hasIncoming` na conversa aberta recarrega e remarca como lida", async () => {
    assinarDm();
    await abrirConversa("c1");
    api.dmMarkRead.mockClear();

    ouvinte("dm.appended")({ conversationId: "c1", fromOrdSum: 1, toOrdSum: 2, hasIncoming: true });
    await vi.waitFor(() => expect(api.dmMarkRead).toHaveBeenCalledWith("c1"));
  });

  it("lote SÓ MEU não remarca: não há o que dar por lido, e cada tecla viraria escrita", async () => {
    assinarDm();
    await abrirConversa("c1");
    api.dmMarkRead.mockClear();

    ouvinte("dm.appended")({ conversationId: "c1", fromOrdSum: 1, toOrdSum: 2, hasIncoming: false });
    await vi.waitFor(() => expect(api.dmMessages).toHaveBeenCalled());
    expect(api.dmMarkRead).not.toHaveBeenCalled();
  });

  it("lote de conversa que NÃO está em foco não recarrega nem marca", async () => {
    assinarDm();
    await abrirConversa("c1");
    api.dmMarkRead.mockClear();

    ouvinte("dm.appended")({ conversationId: "outra", fromOrdSum: 1, toOrdSum: 2, hasIncoming: true });
    expect(api.dmMarkRead).not.toHaveBeenCalled();
  });
});

describe("§31.15 — bloquear e esquecer encerram a chamada desta conversa", () => {
  beforeEach(() => {
    voz.desligar.mockResolvedValue(undefined);
    useDmCallStore.getState().encerrou();
  });

  it("bloquear com a chamada de pé desliga ANTES do comando", async () => {
    // A ordem é o ponto: depois de `dm.block` o canal `p2p-dm/1` não autoriza mais nada
    // (§31.8(4)), e o `dm.callLeave` não teria por onde sair — o par ficaria com a chamada
    // de pé contra quem acabou de bloqueá-lo.
    const ordem: string[] = [];
    voz.desligar.mockImplementation(async () => {
      ordem.push("desligar");
    });
    api.dmBlock.mockImplementation(async () => {
      ordem.push("block");
      return {};
    });
    useDmCallStore.getState().chamando({ conversationId: "c1", peerKey: "aa" });

    await bloquearConversa("c1");

    expect(ordem).toEqual(["desligar", "block"]);
  });

  it("esquecer com a chamada de pé desliga: a tela some, e com ela o único botão de sair", async () => {
    // Sem isto sobrava uma chamada órfã — microfone e câmera abertos, sem superfície para
    // encerrá-los, e ainda recusando a próxima com "Você já está numa chamada" (§15.4).
    api.dmForget.mockResolvedValue({});
    useDmCallStore.getState().chamando({ conversationId: "c1", peerKey: "aa" });

    await esquecerConversa("c1");

    expect(voz.desligar).toHaveBeenCalledTimes(1);
  });

  it("bloquear uma conversa que NÃO é a da chamada não mexe na chamada", async () => {
    api.dmBlock.mockResolvedValue({});
    useDmCallStore.getState().chamando({ conversationId: "outra", peerKey: "aa" });

    await bloquearConversa("c1");

    expect(voz.desligar).not.toHaveBeenCalled();
  });
});

describe("§31.16.3 — o anexo que a consulta não devolveu", () => {
  it("grava `null` em vez de nada: sem isto o cartão pulsava para sempre", async () => {
    // As dependências do efeito do cartão não mudavam, então ele não rodava de novo — e
    // não havia erro nem botão. `hasAttachment` e `dm_attachments` saem da mesma tabela e
    // do mesmo lote, então isto é falha de consulta, não anexo a caminho.
    api.dmMessage.mockRejectedValue(new Error("rede"));

    await carregarAnexo("c1", "m1");

    expect(useDmStore.getState().anexos["m1"]).toBeNull();
  });
});
