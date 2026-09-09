import { describe, expect, it } from "vitest";
import { validateChannelForm } from "../channelFormModel";
import { channelName } from "../../../lib/channelName";
import { linkDeMensagem, decodeMessageRef } from "../../../lib/messageLink";

describe("validateChannelForm — regras e limites (§8.6, §8.7, §13)", () => {
  it("rejeita canal com mais de 32 code points", () => {
    const longo = "a".repeat(33);
    const errors = validateChannelForm(
      {
        type: "text",
        name: longo,
        categoryId: "cat-1",
        newCategoryName: "",
        topic: "",
        readOnly: false,
        canPostRoleIds: [],
        speechMode: "free",
        queueTurnSeconds: 300,
      },
      [],
    );
    expect(errors.name).toBe("O nome pode ter no máximo 32 caracteres.");
  });

  it("aceita canal com exatamente 32 code points", () => {
    const exato = "a".repeat(32);
    const errors = validateChannelForm(
      {
        type: "text",
        name: exato,
        categoryId: "cat-1",
        newCategoryName: "",
        topic: "",
        readOnly: false,
        canPostRoleIds: [],
        speechMode: "free",
        queueTurnSeconds: 300,
      },
      [],
    );
    expect(errors.name).toBeUndefined();
  });

  it("rejeita canal somente-leitura sem nenhum cargo autorizado a postar", () => {
    const errors = validateChannelForm(
      {
        type: "text",
        name: "avisos",
        categoryId: "cat-1",
        newCategoryName: "",
        topic: "",
        readOnly: true,
        canPostRoleIds: [],
        speechMode: "free",
        queueTurnSeconds: 300,
      },
      [],
    );
    expect(errors.readOnly).toBe(
      "Selecione ao menos um cargo com permissão para postar.",
    );
  });

  it("aceita canal somente-leitura com ao menos um cargo autorizado", () => {
    const errors = validateChannelForm(
      {
        type: "text",
        name: "avisos",
        categoryId: "cat-1",
        newCategoryName: "",
        topic: "",
        readOnly: true,
        canPostRoleIds: ["role-admin"],
        speechMode: "free",
        queueTurnSeconds: 300,
      },
      [],
    );
    expect(errors.readOnly).toBeUndefined();
  });
});

describe("channelName — normalização NFKC para voz (§8.7)", () => {
  it("aplica NFKC no nome do canal de voz", () => {
    // ﬀ (ligatura Unicode U+FB00) se decompõe em 'ff' sob NFKC
    const canalVoz = channelName("voice", "Sala ﬀ");
    expect(canalVoz).toBe("Sala ff");
  });
});

describe("linkDeMensagem — integridade e esquema https", () => {
  it("gera link com protocolo https:// e decodificável", () => {
    const ref = {
      communityId: "comm-123",
      channelId: "chan-456",
      messageId: "msg-789",
    };
    const url = linkDeMensagem(ref);
    expect(url.startsWith("https://")).toBe(true);

    const match = url.match(/\/m\/([^/]+)$/);
    expect(match).not.toBeNull();
    const code = match![1]!;
    const decoded = decodeMessageRef(code);
    expect(decoded).toEqual(ref);
  });
});
