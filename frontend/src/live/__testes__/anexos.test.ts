/**
 * O adaptador de anexo de §15.6.1: o `id` É o `blobIdHex` de §13.2 (16 primeiros bytes
 * do hash) — a MESMA chave dos eventos `blob.*` —, o número de `kind` vira token do
 * domínio e a origem no fio viaja para o card poder pedir download/reveal. Verificado
 * por mutação: trocar o mapa de kinds ou o corte do id derruba os casos.
 */

import { describe, expect, it } from "vitest";
import { anexo } from "../adaptadores";

const DTO = {
  blobsCoreKey: "cd".repeat(32),
  blobId: { byteOffset: 0, blockOffset: 0, blockLength: 4, byteLength: 100 },
  name: "foto.png",
  sizeBytes: 2048,
  kind: 0,
  hash: "ab".repeat(32),
  progress: 0,
  availablePeers: 0,
  hostAvailable: false,
};

describe("anexo — do DTO de §15.6.1 para o domínio", () => {
  it("o id é o blobIdHex (hash cortado em 16 bytes) e a origem vai inteira", () => {
    const a = anexo(DTO, "com-1");
    expect(a.id).toBe("ab".repeat(16));
    expect(a.id).toHaveLength(32);
    expect(a.origem).toEqual({
      communityId: "com-1",
      blobsCoreKey: "cd".repeat(32),
      blobId: DTO.blobId,
    });
  });

  it("o número de kind do fio vira token do domínio (0=image, 3=document, 4=other)", () => {
    expect(anexo({ ...DTO, kind: 0 }, "c").kind).toBe("image");
    expect(anexo({ ...DTO, kind: 3 }, "c").kind).toBe("document");
    expect(anexo({ ...DTO, kind: 4 }, "c").kind).toBe("other");
    expect(anexo({ ...DTO, kind: 99 }, "c").kind).toBe("other");
  });

  it("progresso e disponibilidade vêm do DTO, sem inventar peers", () => {
    const a = anexo({ ...DTO, progress: 0.42, availablePeers: 2, hostAvailable: true }, "c");
    expect(a.downloadProgress).toBe(42);
    expect(a.availablePeers).toBe(2);
    expect(a.hostAvailable).toBe(true);
  });

  it("revealMode vem do DTO e ausente vira folder", () => {
    expect(anexo({ ...DTO, revealMode: "open" }, "c").revealMode).toBe("open");
    expect(anexo({ ...DTO, revealMode: "folder" }, "c").revealMode).toBe("folder");
    expect(anexo({ ...DTO }, "c").revealMode).toBe("folder");
  });
});
