/**
 * Os efeitos sonoros — `frontend.md` §10 3.1a (§136).
 *
 * O que se afirma aqui são as **regras**, não o áudio: a evidência de que um `<audio>`
 * ancorado toca no dispositivo escolhido já é a da voz (B47, §98). O que este arquivo
 * fixa é quando o produto avisa e, principalmente, **quando ele se cala** — que é a
 * metade que dá defeito: um app que toca a caixa de entrada inteira no boot, ou que
 * avisa a mensagem do canal que está aberto na tela, é pior do que um app mudo.
 *
 * Verificado por mutação: tirar a linha de base do roster (`rosterConhecido === null`)
 * derruba "entrar num canal cheio não anuncia ninguém"; trocar o `>` por `!==` no delta
 * de não-lidas derruba "marcar como lido não avisa"; tirar o teto de
 * `INTERVALO_MINIMO_MS` derruba "um lote de canais toca uma vez".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** O `<audio>` do Chromium reduzido ao que este módulo usa. */
class AudioFalso {
  static tocados: string[] = [];
  static pausados: string[] = [];
  readonly src: string;
  readonly dataset: Record<string, string> = {};
  preload = "";
  loop = false;
  volume = 1;
  currentTime = 0;
  constructor(src: string) {
    this.src = src;
  }
  setSinkId(): Promise<void> {
    return Promise.resolve();
  }
  play(): Promise<void> {
    AudioFalso.tocados.push(nomeDe(this.src));
    return Promise.resolve();
  }
  pause(): void {
    AudioFalso.pausados.push(nomeDe(this.src));
  }
  remove(): void {}
}

/** O bundler devolve uma URL com o nome do arquivo dentro; é por ele que o teste olha. */
function nomeDe(src: string): string {
  return /([^/]+?)(-[A-Za-z0-9_]+)?\.mp3/.exec(src)?.[1] ?? src;
}

vi.stubGlobal("Audio", AudioFalso);

import {
  assinarSons,
  decidirNotificacaoDeCanal,
  decidirNotificacaoDeConversa,
  esquecerSons,
  notificarConversa,
  notificarNaoLidasDeCanal,
} from "../sons";
import { useCommunityStore } from "../../store/communityStore";
import { useDmCallStore } from "../../store/dmCallStore";
import { useSettingsStore } from "../../store/settingsStore";
import { useVoiceStore } from "../../store/voiceStore";
import { SPEECH_MODE_DEFAULT_SECONDS, type Channel } from "../../domain/types";

const EU = "aa".repeat(32);
const OUTRA = "bb".repeat(32);
const TERCEIRA = "cc".repeat(32);

const CANAL: Channel = {
  id: "voz1",
  communityId: "com1",
  categoryId: "cat1",
  type: "voice",
  name: "Geral",
  unreadCount: 0,
  pendingMentions: 0,
  muted: false,
  speechMode: "free",
  queueTurnSeconds: SPEECH_MODE_DEFAULT_SECONDS,
};

function roster(...chaves: string[]): Array<{ keyHex: string }> {
  return chaves.map((keyHex) => ({ keyHex }));
}

beforeEach(() => {
  AudioFalso.tocados = [];
  AudioFalso.pausados = [];
  useVoiceStore.getState().leave();
  useDmCallStore.getState().encerrou();
  useSettingsStore.setState({
    notificationsEnabled: true,
    notificationByCommunity: {},
    dmMutedByConversation: {},
    outputId: "default",
    outputVolume: 100,
  });
  useCommunityStore.setState({ activeCommunityId: null, activeChannelByCommunity: {} });
  assinarSons();
  AudioFalso.tocados = [];
});

afterEach(() => {
  esquecerSons();
});

describe("entrar e sair de um canal de voz", () => {
  it("entrar toca uma vez; sair toca uma vez", () => {
    useVoiceStore.getState().join(CANAL, EU);
    expect(AudioFalso.tocados).toEqual(["entrarNoCanal"]);
    useVoiceStore.getState().leave();
    expect(AudioFalso.tocados).toEqual(["entrarNoCanal", "sairDoCanal"]);
  });

  it("trocar de canal é sair de um e entrar no outro — e o produto só anuncia a entrada", () => {
    useVoiceStore.getState().join(CANAL, EU);
    AudioFalso.tocados = [];
    useVoiceStore.getState().join({ ...CANAL, id: "voz2" }, EU);
    expect(AudioFalso.tocados).toEqual(["entrarNoCanal"]);
  });

  it("a reentrada de B43 não é entrada: o `retryJoin` mantém o canal e não toca nada", () => {
    useVoiceStore.getState().join(CANAL, EU);
    AudioFalso.tocados = [];
    useVoiceStore.getState().retryJoin();
    expect(AudioFalso.tocados).toEqual([]);
  });

  it("e a sala que volta com a reentrada não é gente chegando", () => {
    useVoiceStore.getState().join(CANAL, EU);
    useVoiceStore.getState().aplicarRoster(roster(EU, OUTRA, TERCEIRA));
    // B43: o núcleo reiniciou, o `retryJoin` esvazia o roster local e o host o republica.
    useVoiceStore.getState().retryJoin();
    AudioFalso.tocados = [];
    useVoiceStore.getState().aplicarRoster(roster(EU, OUTRA, TERCEIRA));
    expect(AudioFalso.tocados).toEqual([]);
  });

  it("ensurdecido não ouve a chamada, e os avisos dela são a chamada", () => {
    useVoiceStore.setState({ selfDeafened: true });
    useVoiceStore.getState().join(CANAL, EU);
    expect(AudioFalso.tocados).toEqual([]);
    useVoiceStore.setState({ selfDeafened: false });
  });
});

describe("quem entra e quem sai da chamada", () => {
  it("o primeiro roster é linha de base: entrar num canal cheio não anuncia ninguém", () => {
    useVoiceStore.getState().join({ ...CANAL, voiceParticipantIds: [] }, EU);
    AudioFalso.tocados = [];
    // O host publica quem já estava lá — três pessoas que NÃO acabaram de entrar.
    useVoiceStore.getState().aplicarRoster(roster(EU, OUTRA, TERCEIRA));
    expect(AudioFalso.tocados).toEqual([]);
  });

  it("o roster seguinte é evento: chegou uma pessoa, saiu outra", () => {
    useVoiceStore.getState().join(CANAL, EU);
    useVoiceStore.getState().aplicarRoster(roster(EU, OUTRA));
    AudioFalso.tocados = [];
    useVoiceStore.getState().aplicarRoster(roster(EU, OUTRA, TERCEIRA));
    expect(AudioFalso.tocados).toEqual(["alguemEntrou"]);
    AudioFalso.tocados = [];
    useVoiceStore.getState().aplicarRoster(roster(EU, TERCEIRA));
    expect(AudioFalso.tocados).toEqual(["alguemSaiu"]);
  });

  it("duas pessoas entrando no mesmo roster tocam UMA vez, não duas", () => {
    useVoiceStore.getState().join(CANAL, EU);
    useVoiceStore.getState().aplicarRoster(roster(EU));
    AudioFalso.tocados = [];
    useVoiceStore.getState().aplicarRoster(roster(EU, OUTRA, TERCEIRA));
    expect(AudioFalso.tocados).toEqual(["alguemEntrou"]);
  });

  it("mas ficar sozinho porque o outro SAIU continua sendo uma saída", () => {
    // A outra metade do discriminante da reentrada: aqui também sobra só eu, e aqui o
    // aviso tem de sair. Trocar o `stage` do guarda por "roster vazio" derruba este caso.
    useVoiceStore.getState().join(CANAL, EU);
    useVoiceStore.getState().aplicarRoster(roster(EU, OUTRA));
    AudioFalso.tocados = [];
    useVoiceStore.getState().aplicarRoster(roster(EU));
    expect(AudioFalso.tocados).toEqual(["alguemSaiu"]);
  });

  it("republicar o mesmo roster não anuncia nada", () => {
    useVoiceStore.getState().join(CANAL, EU);
    useVoiceStore.getState().aplicarRoster(roster(EU, OUTRA));
    AudioFalso.tocados = [];
    useVoiceStore.getState().aplicarRoster(roster(EU, OUTRA));
    expect(AudioFalso.tocados).toEqual([]);
  });

  it("sair da chamada com gente dentro não vira uma saída por pessoa", () => {
    useVoiceStore.getState().join(CANAL, EU);
    useVoiceStore.getState().aplicarRoster(roster(EU, OUTRA, TERCEIRA));
    AudioFalso.tocados = [];
    useVoiceStore.getState().leave();
    expect(AudioFalso.tocados).toEqual(["sairDoCanal"]);
  });
});

describe("a chamada de uma conversa direta (§31.15)", () => {
  it("receber toca a chamada em laço; atender a interrompe e anuncia o par", () => {
    useDmCallStore.getState().recebendo({ conversationId: "c1", peerKey: OUTRA });
    expect(AudioFalso.tocados).toEqual(["chamadaRecebida"]);
    AudioFalso.tocados = [];
    useDmCallStore.getState().conectou();
    expect(AudioFalso.pausados).toContain("chamadaRecebida");
    expect(AudioFalso.tocados).toEqual(["alguemEntrou"]);
  });

  it("`chamando` NÃO toca: deste lado não há atestado de que o outro esteja tocando", () => {
    useDmCallStore.getState().chamando({ conversationId: "c1", peerKey: OUTRA });
    expect(AudioFalso.tocados).toEqual([]);
  });

  it("a chamada que acabou depois de conectar anuncia a saída", () => {
    useDmCallStore.getState().chamando({ conversationId: "c1", peerKey: OUTRA });
    useDmCallStore.getState().conectou();
    AudioFalso.tocados = [];
    useDmCallStore.getState().encerrou();
    expect(AudioFalso.tocados).toEqual(["alguemSaiu"]);
  });

  it("a chamada que nunca conectou não perdeu ninguém: ela falhou, e quem diz é a faixa", () => {
    useDmCallStore.getState().chamando({ conversationId: "c1", peerKey: OUTRA });
    useDmCallStore.getState().falhou("Nenhum dos dois lados tem endereço público.");
    AudioFalso.tocados = [];
    useDmCallStore.getState().encerrou();
    expect(AudioFalso.tocados).toEqual([]);
  });

  it("desistir de atender interrompe o laço", () => {
    useDmCallStore.getState().recebendo({ conversationId: "c1", peerKey: OUTRA });
    useDmCallStore.getState().encerrou();
    expect(AudioFalso.pausados).toContain("chamadaRecebida");
  });
});

describe("a notificação de mensagem — o delta de `unread.changed`", () => {
  const ev = (unreadCount: number, pendingMentions = 0) => ({
    communityId: "com1",
    channelId: "ch1",
    unreadCount,
    pendingMentions,
  });

  it("a contagem que sobe avisa; a que desce (marcar como lido) não", () => {
    notificarNaoLidasDeCanal(ev(1));
    expect(AudioFalso.tocados).toEqual(["notificacao"]);
    AudioFalso.tocados = [];
    notificarNaoLidasDeCanal(ev(0));
    expect(AudioFalso.tocados).toEqual([]);
  });

  it("um lote de canais chegando junto toca UMA vez", () => {
    notificarNaoLidasDeCanal({ ...ev(1), channelId: "ch1" });
    notificarNaoLidasDeCanal({ ...ev(1), channelId: "ch2" });
    notificarNaoLidasDeCanal({ ...ev(1), channelId: "ch3" });
    expect(AudioFalso.tocados).toEqual(["notificacao"]);
  });

  it("antes de `assinarSons` nada toca — o que o boot descobre é histórico", () => {
    esquecerSons();
    notificarNaoLidasDeCanal(ev(7));
    expect(AudioFalso.tocados).toEqual([]);
  });

  it("o interruptor global de §15.4 cala tudo", () => {
    useSettingsStore.setState({ notificationsEnabled: false });
    notificarNaoLidasDeCanal(ev(1));
    expect(AudioFalso.tocados).toEqual([]);
  });

  it("nível `mentions` avisa só a menção; nível `none` não avisa nada", () => {
    useSettingsStore.setState({ notificationByCommunity: { com1: "mentions" } });
    notificarNaoLidasDeCanal(ev(1));
    expect(AudioFalso.tocados).toEqual([]);
    notificarNaoLidasDeCanal(ev(2, 1));
    expect(AudioFalso.tocados).toEqual(["notificacao"]);
  });
});

describe("as regras, sem áudio no meio", () => {
  const base = {
    unreadCount: 1,
    pendingMentions: 0,
    anterior: null,
    nivel: "all" as const,
    ligado: true,
    silenciado: false,
    emFoco: false,
  };

  it("o canal aberto com a janela em foco não avisa: quem está lendo já viu chegar", () => {
    expect(decidirNotificacaoDeCanal({ ...base, emFoco: true })).toBe(false);
    expect(decidirNotificacaoDeCanal(base)).toBe(true);
  });

  it("canal silenciado continua avisando MENÇÃO DIRETA — a regra escrita do badge", () => {
    expect(decidirNotificacaoDeCanal({ ...base, silenciado: true })).toBe(false);
    expect(
      decidirNotificacaoDeCanal({ ...base, silenciado: true, unreadCount: 1, pendingMentions: 1 }),
    ).toBe(true);
  });

  it("nível `none` cala inclusive a menção", () => {
    expect(
      decidirNotificacaoDeCanal({ ...base, nivel: "none", pendingMentions: 1 }),
    ).toBe(false);
  });

  it("a conversa direta decide com os DOIS levers que existem — B63 segue aberto", () => {
    expect(decidirNotificacaoDeConversa({ ligado: true, silenciada: false, emFoco: false })).toBe(true);
    expect(decidirNotificacaoDeConversa({ ligado: false, silenciada: false, emFoco: false })).toBe(false);
    expect(decidirNotificacaoDeConversa({ ligado: true, silenciada: true, emFoco: false })).toBe(false);
    expect(decidirNotificacaoDeConversa({ ligado: true, silenciada: false, emFoco: true })).toBe(false);
  });

  it("o mudo de B63(b) cala a conversa silenciada e só ela", () => {
    useSettingsStore.setState({ dmMutedByConversation: { c1: true } });
    notificarConversa("c1");
    expect(AudioFalso.tocados).toEqual([]);
    notificarConversa("c2");
    expect(AudioFalso.tocados).toEqual(["notificacao"]);
  });
});
