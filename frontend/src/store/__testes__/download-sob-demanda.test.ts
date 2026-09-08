/**
 * Download é sob demanda (§11, B8 passo 2; §13.4).
 *
 * O que se afirma: `blob.download` só sai quando alguém pede — receber a mensagem com
 * o anexo não gasta banda de ninguém. O pedido em voo fica em `emCursoById`, que é o
 * que o card lê para escolher entre "Baixar" e a barra de progresso; enquanto está em
 * voo, pedir de novo não duplica o comando, e quando o pedido termina (concluído,
 * corrompido ou recusado pelo núcleo) a marca sai e o card volta a oferecer o download.
 * Verificado por mutação: deixar `iniciar` sem o guarda de `emCursoById` derruba o caso
 * do pedido duplicado; não limpar a marca no `catch` derruba o do erro.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDownloadStore } from "../downloadStore";
import type { Attachment } from "../../domain/types";

const api = vi.hoisted(() => ({
  blobDownload: vi.fn<() => Promise<unknown>>(),
  blobCancel: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("../../ipc/api", () => ({ api }));

function anexo(id: string, progresso = 0): Attachment {
  return {
    id,
    name: "aula.mp4",
    sizeBytes: 1_240_000,
    kind: "video",
    downloadProgress: progresso,
    availablePeers: 0,
    hostAvailable: false,
    origem: {
      communityId: "c1",
      blobsCoreKey: "aa".repeat(32),
      blobId: { byteOffset: 0, blockOffset: 0, blockLength: 20, byteLength: 1_240_000 },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.blobDownload.mockResolvedValue({});
  api.blobCancel.mockResolvedValue({});
  useDownloadStore.getState().reset();
});

describe("downloadStore — nada é baixado sem pedido", () => {
  it("um anexo que chegou pelo fio não está em curso e não pediu nada", () => {
    // O sincronizador hidrata o anexo na mensagem; a store não é acionada.
    expect(api.blobDownload).not.toHaveBeenCalled();
    expect(useDownloadStore.getState().emCursoById[anexo("b1").id]).toBeUndefined();
  });

  it("iniciar marca o pedido em curso e é o único caminho até o núcleo", () => {
    useDownloadStore.getState().iniciar(anexo("b1"));

    expect(api.blobDownload).toHaveBeenCalledTimes(1);
    expect(useDownloadStore.getState().emCursoById["b1"]).toBe(true);
  });

  it("pedir de novo com o download em voo não duplica o comando", () => {
    const a = anexo("b1");
    useDownloadStore.getState().iniciar(a);
    useDownloadStore.getState().iniciar(a);

    expect(api.blobDownload).toHaveBeenCalledTimes(1);
  });

  it("concluir e corromper encerram o pedido — a barra some do card", () => {
    useDownloadStore.getState().iniciar(anexo("b1"));
    useDownloadStore.getState().aplicarConcluido("b1");
    expect(useDownloadStore.getState().emCursoById["b1"]).toBeUndefined();

    useDownloadStore.getState().iniciar(anexo("b2"));
    useDownloadStore.getState().aplicarCorrompido("b2", "hash divergiu");
    expect(useDownloadStore.getState().emCursoById["b2"]).toBeUndefined();
  });

  it("recusa do núcleo (E_NO_PEERS) libera o pedido para o card oferecer de novo", async () => {
    api.blobDownload.mockRejectedValue(new Error("E_NO_PEERS"));

    useDownloadStore.getState().iniciar(anexo("b1"));
    await Promise.resolve();
    await Promise.resolve();

    expect(useDownloadStore.getState().emCursoById["b1"]).toBeUndefined();
  });

  it("anexo já baixado não pede nada, mesmo com clique", () => {
    useDownloadStore.getState().iniciar(anexo("pronto", 100));
    expect(api.blobDownload).not.toHaveBeenCalled();
  });

  it("aplicarIndisponivel encerra o pedido em curso e permite tentar novamente", () => {
    const a = anexo("b3");
    useDownloadStore.getState().iniciar(a);
    expect(useDownloadStore.getState().emCursoById["b3"]).toBe(true);

    useDownloadStore.getState().aplicarIndisponivel("b3");
    expect(useDownloadStore.getState().emCursoById["b3"]).toBeUndefined();
    expect(useDownloadStore.getState().indisponivelById["b3"]).toBe(true);

    api.blobDownload.mockClear();
    useDownloadStore.getState().iniciar(a);
    expect(api.blobDownload).toHaveBeenCalledTimes(1);
    expect(useDownloadStore.getState().indisponivelById["b3"]).toBeUndefined();
  });

  it("tentar novamente após corrupção limpa a marca de corrompido e re-dispara o download", () => {
    const a = anexo("b4");
    useDownloadStore.getState().iniciar(a);
    useDownloadStore.getState().aplicarCorrompido("b4", "hash");
    expect(useDownloadStore.getState().corrompidoById["b4"]).toBe("hash");

    api.blobDownload.mockClear();
    useDownloadStore.getState().iniciar(a);
    expect(api.blobDownload).toHaveBeenCalledTimes(1);
    expect(useDownloadStore.getState().corrompidoById["b4"]).toBeUndefined();
  });
});
