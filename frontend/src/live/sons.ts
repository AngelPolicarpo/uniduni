import { useCommunityStore } from "../store/communityStore";
import { useDmCallStore } from "../store/dmCallStore";
import { useDmStore } from "../store/dmStore";
import { useSettingsStore, type NotificationLevel } from "../store/settingsStore";
import { useVoiceStore } from "../store/voiceStore";

import alguemEntrouMp3 from "../assets/sons/alguemEntrou.mp3";
import alguemSaiuMp3 from "../assets/sons/alguemSaiu.mp3";
import chamadaRecebidaMp3 from "../assets/sons/chamadaRecebida.mp3";
import entrarNoCanalMp3 from "../assets/sons/entrarNoCanal.mp3";
import notificacaoMp3 from "../assets/sons/notificacao.mp3";
import sairDoCanalMp3 from "../assets/sons/sairDoCanal.mp3";

/**
 * Os efeitos sonoros do produto.
 *
 * **A norma é `frontend.md` §10 3.1a** (emenda de 2026-09-09, §136): catálogo fechado de
 * seis sons e oito regras, cinco delas de silêncio. Este arquivo é a implementação dela
 * e nada além — onde os dois discordarem, manda a spec. O interruptor e o nível são os
 * de `settings.setNotifications`, que a emenda de 2026-09-09 em `backend-v2.md` §15.4
 * declarou governarem **badge e som**: não existe interruptor de som, não existe volume
 * de aviso, e nada disto é preferência nova.
 *
 * **Por que os gatilhos não moram nas stores.** Som é efeito de dispositivo, como o
 * `<audio>` de par em `sincronizacao.ts` e a câmera em `cameraStreams.ts`: o padrão da
 * casa é a store guardar o estado e a camada `live/` observar a transição. Assinar as
 * stores daqui também é o que mantém `voiceStore`/`dmCallStore` testáveis sem áudio.
 *
 * **A saída é a mesma da voz (B47).** `outputId` e `outputVolume` de §10 3.1 valem para
 * estes sons como valem para o áudio dos pares — um aviso que sai pelo alto-falante
 * errado, com a chamada no fone, é o mesmo defeito que B47 corrigiu na voz.
 */

/* ─── Catálogo ───────────────────────────────────────────────────────────── */

export type NomeDeSom =
  | "entrar-no-canal"
  | "sair-do-canal"
  | "alguem-entrou"
  | "alguem-saiu"
  | "notificacao"
  | "chamada-recebida";

const ARQUIVO: Record<NomeDeSom, string> = {
  "entrar-no-canal": entrarNoCanalMp3,
  "sair-do-canal": sairDoCanalMp3,
  "alguem-entrou": alguemEntrouMp3,
  "alguem-saiu": alguemSaiuMp3,
  notificacao: notificacaoMp3,
  "chamada-recebida": chamadaRecebidaMp3,
};

/**
 * O único som que **repete**: uma chamada que toca uma vez só é uma chamada perdida.
 * Os outros cinco são pontuais, e repetir qualquer um deles seria ruído.
 */
const EM_LACO: ReadonlySet<NomeDeSom> = new Set<NomeDeSom>(["chamada-recebida"]);

/**
 * Duas notificações separadas por menos que isto tocam **uma vez**.
 *
 * Não é polimento: `unread.changed` é por canal (§15.5, `unread.ts`), e uma réplica que
 * termina de sincronizar emite um lote deles de uma vez. Sem o teto, uma comunidade que
 * acabou de chegar entraria tocando uma vez por canal.
 */
const INTERVALO_MINIMO_MS = 1_500;

/* ─── Reprodução ─────────────────────────────────────────────────────────── */

/**
 * O container escondido onde ficam os `<audio>` fora da árvore do React.
 *
 * Ancorar no DOM não é decoração: o Chromium suspende a reprodução de elemento solto
 * quando a janela está ocluída — é a mesma razão pela qual o áudio dos pares vive aqui.
 * O id é compartilhado com `sincronizacao.ts` de propósito: um container só.
 */
export function obterContainerDeAudio(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  let el = document.getElementById("p2p-audio-container");
  if (el === null) {
    el = document.createElement("div");
    el.id = "p2p-audio-container";
    el.style.display = "none";
    document.body.appendChild(el);
  }
  return el;
}

const elementos = new Map<NomeDeSom, HTMLAudioElement>();

function elementoDe(nome: NomeDeSom): HTMLAudioElement | null {
  const existente = elementos.get(nome);
  if (existente !== undefined) return existente;
  if (typeof Audio === "undefined") return null;
  const el = new Audio(ARQUIVO[nome]);
  el.preload = "auto";
  el.loop = EM_LACO.has(nome);
  obterContainerDeAudio()?.appendChild(el);
  elementos.set(nome, el);
  return el;
}

/**
 * §10 3.1 / B47 — a saída escolhida e o volume geral, aplicados na hora de tocar.
 *
 * Não há volume por participante aqui, e não deve haver: o slider de §9 2.3 é do áudio
 * *daquele par*, e um aviso do produto não é a voz de ninguém.
 */
function aplicarSaida(el: HTMLAudioElement): void {
  const ajustes = useSettingsStore.getState();
  const saida = ajustes.outputId || "default";
  // Mesmo cuidado de `aplicarSaidaDeAudio`: `setSinkId` com o id já aplicado é recusado
  // por alguns Chromiums, então só troca quando muda.
  if ((el.dataset.sinkId ?? "default") !== saida) {
    el.dataset.sinkId = saida;
    void el
      .setSinkId(saida === "default" ? "" : saida)
      .catch((e) => console.log("[sons] saída de áudio não aplicada:", (e as Error).message));
  }
  el.volume = Math.max(0, Math.min(100, ajustes.outputVolume)) / 100;
}

export function tocarSom(nome: NomeDeSom): void {
  const el = elementoDe(nome);
  if (el === null) return;
  aplicarSaida(el);
  // Retocar o mesmo aviso reinicia: dois avisos em sequência precisam soar como dois.
  el.currentTime = 0;
  void el.play().catch(() => undefined);
}

export function pararSom(nome: NomeDeSom): void {
  const el = elementos.get(nome);
  if (el === undefined) return;
  el.pause();
  el.currentTime = 0;
}

let ultimaNotificacao = 0;

/** A notificação, com o teto de `INTERVALO_MINIMO_MS`. */
function tocarNotificacao(): void {
  const agora = Date.now();
  if (agora - ultimaNotificacao < INTERVALO_MINIMO_MS) return;
  ultimaNotificacao = agora;
  tocarSom("notificacao");
}

/* ─── As regras, separadas de quem toca ──────────────────────────────────── */

/**
 * As regras 1 a 3 de `frontend.md` §10 3.1a, na ordem em que a spec as escreve:
 *
 * - o interruptor global e o nível por comunidade são `settings.setNotifications`, que
 *   §15.4 (emenda de 2026-09-09) declara governarem badge **e** som;
 * - canal silenciado **continua avisando menção direta** — é a regra do badge de §8 1.1.1,
 *   e o som segue o badge sem exceção;
 * - o canal aberto com a janela em foco não avisa: quem está lendo já viu chegar.
 *
 * O delta vem de `unread.changed`, que já exclui as **minhas** mensagens, as apagadas e
 * as ocultadas por ban (`unread.ts`, `#recontarCanal`) — nada disso precisa ser refeito
 * aqui, e refazer seria uma segunda cópia da regra a envelhecer.
 */
export function decidirNotificacaoDeCanal(entrada: {
  readonly unreadCount: number;
  readonly pendingMentions: number;
  /** O que este módulo viu por último neste canal; `null` é "primeira vez nesta sessão". */
  readonly anterior: { readonly unreadCount: number; readonly pendingMentions: number } | null;
  readonly nivel: NotificationLevel;
  readonly ligado: boolean;
  readonly silenciado: boolean;
  readonly emFoco: boolean;
}): boolean {
  if (!entrada.ligado) return false;
  if (entrada.nivel === "none") return false;
  if (entrada.emFoco) return false;
  const antes = entrada.anterior ?? { unreadCount: 0, pendingMentions: 0 };
  const novaMencao = entrada.pendingMentions > antes.pendingMentions;
  if (entrada.nivel === "mentions") return novaMencao;
  if (entrada.silenciado) return novaMencao;
  return entrada.unreadCount > antes.unreadCount;
}

/**
 * A regra 8 de `frontend.md` §10 3.1a — a conversa direta.
 *
 * Não há **nível** por conversa, e a ausência é decidida, não esquecida: `§31.16` (emenda
 * de 2026-09-04, B63(b)) resolveu que uma conversa tem o interruptor global mais o **mudo
 * por conversa** (`dmMutedByConversation`), porque uma conversa não é uma comunidade.
 * Inventar um nível aqui seria reabrir uma decisão fechada.
 */
export function decidirNotificacaoDeConversa(entrada: {
  readonly ligado: boolean;
  readonly silenciada: boolean;
  readonly emFoco: boolean;
}): boolean {
  return entrada.ligado && !entrada.silenciada && !entrada.emFoco;
}

/* ─── Entradas chamadas pelas assinaturas de §15.5 / §31.16.2 ────────────── */

/** Último `{unreadCount, pendingMentions}` visto por canal — a linha de base do delta. */
const naoLidasConhecidas = new Map<string, { unreadCount: number; pendingMentions: number }>();

let armado = false;

/**
 * `unread.changed` de um **canal** (§15.5). O evento de thread não passa por aqui: ele
 * não traz `channelId`, e uma resposta em fio já contou como não-lida do canal.
 */
export function notificarNaoLidasDeCanal(ev: {
  readonly communityId: string;
  readonly channelId: string;
  readonly unreadCount: number;
  readonly pendingMentions: number;
}): void {
  const anterior = naoLidasConhecidas.get(ev.channelId) ?? null;
  naoLidasConhecidas.set(ev.channelId, {
    unreadCount: ev.unreadCount,
    pendingMentions: ev.pendingMentions,
  });
  // Antes de `assinarSons` o produto ainda está montando a tela: o primeiro `fold` de uma
  // réplica recém-chegada produz não-lidas que são histórico, não notícia.
  if (!armado) return;
  const ajustes = useSettingsStore.getState();
  const comunidade = useCommunityStore.getState();
  const canal = comunidade.remote.channels[ev.channelId];
  const emFoco =
    comunidade.activeCommunityId === ev.communityId &&
    comunidade.activeChannelByCommunity[ev.communityId] === ev.channelId &&
    janelaEmFoco();
  const deve = decidirNotificacaoDeCanal({
    unreadCount: ev.unreadCount,
    pendingMentions: ev.pendingMentions,
    anterior,
    nivel: ajustes.notificationByCommunity[ev.communityId] ?? "all",
    ligado: ajustes.notificationsEnabled,
    // Canal de comunidade não ativa não está no espelho (`sincronizarComunidades` só
    // preserva o que a estrutura carregou): sem linha, o mudo por canal não vale — quem
    // decide é o nível da comunidade, que existe para todas.
    silenciado: canal?.muted ?? false,
    emFoco,
  });
  if (deve) tocarNotificacao();
}

/** `dm.appended` com `hasIncoming` (§31.16.2) e `dm.requested` (§31.9). */
export function notificarConversa(conversationId: string | null): void {
  if (!armado) return;
  const ajustes = useSettingsStore.getState();
  const dm = useDmStore.getState();
  const deve = decidirNotificacaoDeConversa({
    ligado: ajustes.notificationsEnabled,
    silenciada:
      conversationId !== null && ajustes.dmMutedByConversation[conversationId] === true,
    emFoco: conversationId !== null && dm.ativa === conversationId && janelaEmFoco(),
  });
  if (deve) tocarNotificacao();
}

function janelaEmFoco(): boolean {
  return typeof document !== "undefined" && document.hasFocus();
}

/* ─── As transições que este módulo observa sozinho ──────────────────────── */

/**
 * `null` enquanto a sessão de voz ainda não recebeu roster. A **primeira** lista que o
 * host publica é linha de base, nunca evento: quem já estava no canal quando eu entrei
 * não "entrou" — entrei eu, e disso já cuida `entrar-no-canal`.
 */
let rosterConhecido: ReadonlySet<string> | null = null;

/** Ensurdecido não ouve a chamada, e os avisos dela são a chamada (§9 2.3, L-12). */
function ensurdecido(estado: ReturnType<typeof useVoiceStore.getState>): boolean {
  const eu = estado.participants.find((p) => p.identityId === estado.localId);
  return eu?.deafened ?? estado.selfDeafened;
}

function observarVoz(): () => void {
  return useVoiceStore.subscribe((estado, anterior) => {
    if (estado.channelId !== anterior.channelId) {
      // Sessão nova (ou nenhuma): o roster desta não é o da anterior.
      rosterConhecido = null;
      if (!ensurdecido(estado)) {
        if (estado.channelId !== null) tocarSom("entrar-no-canal");
        else tocarSom("sair-do-canal");
      }
      // A lista SEMEADA por `join` (que é `voiceParticipantIds` de `query.structure`,
      // possivelmente velha) não vira linha de base: quem a define é o primeiro roster
      // publicado pelo host, no `set` seguinte.
      return;
    }
    if (estado.participants === anterior.participants) return;
    if (estado.channelId === null) return;
    const eu = estado.localId?.toLowerCase() ?? null;
    const agora = new Set(
      estado.participants
        .map((p) => p.identityId.toLowerCase())
        .filter((id) => id !== eu),
    );
    const antes = rosterConhecido;
    rosterConhecido = agora;
    // **A reentrada de B43 não é gente saindo e voltando.** `retryJoin` derruba o roster
    // local para só a identidade que está refazendo a chamada, e o host o republica
    // inteiro logo depois — sob o diff cru, a sala inteira saía e entrava de novo, com
    // dois avisos, por causa de um reinício do núcleo que ninguém viu.
    //
    // O discriminante é o `stage`: sobrar só eu com `connecting` é o `set` do `retryJoin`
    // e nada mais. Quando as pessoas saem DE VERDADE e sobro sozinho, `aplicarRoster`
    // resolve a chamada para `connected` (é a regra de "ficar sozinho não é falhar"), e
    // o caso cai no diff normal, que é onde ele deve cair.
    if (agora.size === 0 && estado.stage === "connecting") {
      rosterConhecido = null;
      return;
    }
    if (antes === null) return;
    if (ensurdecido(estado)) return;
    let entrou = false;
    let saiu = false;
    for (const id of agora) if (!antes.has(id)) entrou = true;
    for (const id of antes) if (!agora.has(id)) saiu = true;
    // Um roster que troca duas pessoas de uma vez toca os dois avisos, e é o certo: são
    // dois fatos. O que não pode é tocar um por pessoa — daí os booleanos.
    if (entrou) tocarSom("alguem-entrou");
    if (saiu) tocarSom("alguem-saiu");
  });
}

/**
 * A chamada de conversa direta (§31.15).
 *
 * **`chamando` não toca**, e a razão é a mesma pela qual `faixaDeChamada` diz "Chamando…"
 * e não "tocando no aparelho dele": deste lado não há atestado nenhum de que o outro
 * lado esteja tocando. O que toca é o que é fato local — **eu** estou recebendo.
 */
function observarChamadaDeConversa(): () => void {
  return useDmCallStore.subscribe((estado, anterior) => {
    if (estado.estado === anterior.estado) return;
    if (estado.estado === "recebendo") tocarSom("chamada-recebida");
    else pararSom("chamada-recebida");
    // Numa dupla, "o par entrou" é a chamada fechar, e "o par saiu" é ela acabar depois
    // de ter fechado. Uma chamada que nunca conectou não perdeu ninguém: ela falhou, e
    // quem diz isso é a faixa de §99.
    if (estado.estado === "na-chamada") tocarSom("alguem-entrou");
    else if (anterior.estado === "na-chamada") tocarSom("alguem-saiu");
  });
}

let desassinar: Array<() => void> = [];

/**
 * Liga as observações. Chamada por `ligarProduto` **depois** da primeira sincronização,
 * que é o que separa "chegou agora" de "já estava aqui quando o app subiu".
 */
export function assinarSons(): void {
  if (armado) return;
  armado = true;
  desassinar = [observarVoz(), observarChamadaDeConversa()];
}

/** Só para teste: desfaz `assinarSons` e esquece o que foi observado. */
export function esquecerSons(): void {
  for (const f of desassinar) f();
  desassinar = [];
  armado = false;
  rosterConhecido = null;
  naoLidasConhecidas.clear();
  ultimaNotificacao = 0;
  for (const el of elementos.values()) el.remove();
  elementos.clear();
}
