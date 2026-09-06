/**
 * Preferências locais de §15.4 — "escrita direta no LS, sem host e sem fila".
 *
 * O que se afirma: a ação da store aplica o estado LOCAL na hora e replica a
 * MESMA decisão pela porta injetada (quem injeta é o sincronizador); falha da
 * porta não desfaz o estado local (o LS é a primeira fonte); sem porta
 * configurada nada quebra; e `query.preferences` hidrata dispositivos/volumes/
 * notificações no boot. Verificado por mutação: remover o `.catch(() => {})`
 * não muda estes casos — o que os segura é a chamada em si, e a rejeição
 * solta é o que o teste de falha prova que não vira unhandled rejection.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { reenviarPreferencias, useSettingsStore } from "../settingsStore";
import { selectChannel, useCommunityStore } from "../communityStore";

function useCommunityNotificationDe(s: ReturnType<typeof useSettingsStore.getState>, communityId: string): string {
  return s.notificationByCommunity[communityId] ?? "all";
}

function portaDePreferencias() {
  return {
    setDevice: vi.fn().mockResolvedValue({}),
    setVolume: vi.fn().mockResolvedValue({}),
    setNotifications: vi.fn().mockResolvedValue({}),
  };
}

function portaDeComunidade() {
  return {
    setMuted: vi.fn().mockResolvedValue({}),
    setCollapsed: vi.fn().mockResolvedValue({}),
  };
}

beforeEach(() => {
  useSettingsStore.getState().configurarEscrita(null);
  useCommunityStore.getState().configurarPreferencias(null);
  useSettingsStore.setState({
    microphoneId: "default",
    cameraId: "default",
    outputId: "default",
    inputVolume: 80,
    outputVolume: 100,
    notificationsEnabled: true,
    notificationByCommunity: {},
    dmMutedByConversation: {},
  });
});

describe("settingsStore — escrita local + réplica pelo núcleo", () => {
  it("setDevice aplica na hora e chama a porta com o dispositivo", () => {
    const porta = portaDePreferencias();
    useSettingsStore.getState().configurarEscrita(porta);

    useSettingsStore.getState().setDevice("camera", "integrated");

    expect(useSettingsStore.getState().cameraId).toBe("integrated");
    expect(porta.setDevice).toHaveBeenCalledWith("camera", "integrated");
  });

  it("setVolume e notificações replicam a mesma decisão", () => {
    const porta = portaDePreferencias();
    useSettingsStore.getState().configurarEscrita(porta);

    useSettingsStore.getState().setVolume("output", 40);
    useSettingsStore.getState().setNotificationsEnabled(false);

    expect(useSettingsStore.getState().outputVolume).toBe(40);
    expect(useSettingsStore.getState().notificationsEnabled).toBe(false);
    expect(porta.setVolume).toHaveBeenCalledWith("output", 40);
    expect(porta.setNotifications).toHaveBeenCalledWith({ enabled: false });
  });

  it("sem porta configurada, a ação local funciona do mesmo jeito", () => {
    useSettingsStore.getState().setDevice("microphone", "usb");
    expect(useSettingsStore.getState().microphoneId).toBe("usb");
  });
});

describe("B63(b) — o mudo por conversa é só local, sem porta e sem fio", () => {
  it("silenciar marca e reativar apaga a entrada em vez de marcá-la", () => {
    const porta = portaDePreferencias();
    useSettingsStore.getState().configurarEscrita(porta);

    useSettingsStore.getState().setDmMuted("conv-1", true);
    expect(useSettingsStore.getState().dmMutedByConversation).toEqual({ "conv-1": true });
    // Como o mudo de canal, é preferência de quem lê: nada atravessa a porta.
    expect(porta.setNotifications).not.toHaveBeenCalled();

    useSettingsStore.getState().setDmMuted("conv-1", false);
    expect(useSettingsStore.getState().dmMutedByConversation).toEqual({});
  });

  it("reativar o que nunca foi mudo não cria entrada", () => {
    useSettingsStore.getState().setDmMuted("conv-9", false);
    expect(useSettingsStore.getState().dmMutedByConversation).toEqual({});
  });
});

describe("aplicarRemoto — query.preferences hidrata o boot", () => {
  it("dispositivos, volumes e notificações por comunidade", () => {
    useSettingsStore.getState().aplicarRemoto({
      device: { microphoneId: "usb", outputId: "headset", inputVolume: 55, outputVolume: 66 },
      notifications: {
        enabled: false,
        byCommunity: [{ communityId: "c1", level: "mentions" }],
      },
    });

    const s = useSettingsStore.getState();
    expect(s.microphoneId).toBe("usb");
    expect(s.outputId).toBe("headset");
    expect(s.inputVolume).toBe(55);
    expect(s.outputVolume).toBe(66);
    expect(s.notificationsEnabled).toBe(false);
    expect(useCommunityNotificationDe(s, "c1")).toBe("mentions");
  });

  it("hidratação parcial NÃO apaga o que o fio não trouxe", () => {
    useSettingsStore.getState().aplicarRemoto({ device: { inputVolume: 10 } });
    const s = useSettingsStore.getState();
    expect(s.inputVolume).toBe(10);
    expect(s.microphoneId).toBe("default");
    expect(s.notificationsEnabled).toBe(true);
  });
});

describe("communityStore — mute e recolher replicam §15.4", () => {
  it("toggleChannelMuted inverte e manda muted NOVO pela porta", async () => {
    const canal = { id: "ch-x", communityId: "c1", muted: false } as never;
    // O canal vem do LOG (§72, B5): o espelho remoto é a única fonte de estrutura.
    // `channelPatch` escreve só a preferência de quem lê, por cima dele.
    useCommunityStore.getState().aplicarRemoto({
      channels: { ...useCommunityStore.getState().remote.channels, "ch-x": canal },
    });
    const porta = portaDeComunidade();
    useCommunityStore.getState().configurarPreferencias(porta);

    useCommunityStore.getState().toggleChannelMuted("ch-x");

    const depois = selectChannel(useCommunityStore.getState(), "ch-x");
    expect(depois?.muted).toBe(true);
    expect(porta.setMuted).toHaveBeenCalledWith("ch-x", true);
  });

  it("toggleCategoryCollapsed recolhe e manda collapsed NOVO pela porta", () => {
    const porta = portaDeComunidade();
    useCommunityStore.getState().configurarPreferencias(porta);

    useCommunityStore.getState().toggleCategoryCollapsed("c2", "cat-9");

    expect(
      useCommunityStore.getState().collapsedCategoryIds["c2"],
    ).toContain("cat-9");
    expect(porta.setCollapsed).toHaveBeenCalledWith("c2", "cat-9", true);
  });
});

/**
 * §15.4 (emenda de 2026-09-06) — sem fila, mas com reposição.
 *
 * O que se afirma: a escrita que o núcleo não confirmou fica pendente e é reenviada no
 * resync, ANTES da leitura. O defeito que isto fecha: o `.catch(() => {})` engolia a falha
 * com o LS já gravado, e no boot seguinte `aplicarRemoto` devolvia o valor antigo — a
 * escolha da pessoa evaporava sem aviso nenhum.
 */
describe("reenviarPreferencias — o espelho que não confirmou volta a ser tentado", () => {
  it("a escrita recusada é reposta no resync", async () => {
    const porta = portaDePreferencias();
    porta.setDevice.mockRejectedValueOnce(new Error("E_CORE_RESTARTED"));
    useSettingsStore.getState().configurarEscrita(porta);

    useSettingsStore.getState().setDevice("microphone", "mic-b");
    await new Promise((r) => setTimeout(r, 0));
    expect(useSettingsStore.getState().microphoneId).toBe("mic-b");

    await reenviarPreferencias();

    expect(porta.setDevice).toHaveBeenCalledTimes(2);
    expect(porta.setDevice).toHaveBeenLastCalledWith("microphone", "mic-b");
  });

  it("a escrita confirmada não é repetida", async () => {
    const porta = portaDePreferencias();
    useSettingsStore.getState().configurarEscrita(porta);

    useSettingsStore.getState().setVolume("input", 40);
    await new Promise((r) => setTimeout(r, 0));
    await reenviarPreferencias();

    expect(porta.setVolume).toHaveBeenCalledTimes(1);
  });

  it("a chave é o que a escrita SIGNIFICA: três trocas com o núcleo fora repõem só a última", async () => {
    const porta = portaDePreferencias();
    porta.setDevice.mockRejectedValue(new Error("E_NO_PORT"));
    useSettingsStore.getState().configurarEscrita(porta);

    useSettingsStore.getState().setDevice("microphone", "mic-a");
    useSettingsStore.getState().setDevice("microphone", "mic-b");
    useSettingsStore.getState().setDevice("microphone", "mic-c");
    await new Promise((r) => setTimeout(r, 0));

    porta.setDevice.mockResolvedValue({});
    porta.setDevice.mockClear();
    await reenviarPreferencias();

    expect(porta.setDevice).toHaveBeenCalledTimes(1);
    expect(porta.setDevice).toHaveBeenCalledWith("microphone", "mic-c");
  });
});
