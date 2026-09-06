/**
 * A malha de voz do renderer — §17.2 (WebRTC ponta a ponta) e §17.4 (tickets).
 *
 * **O que este módulo NÃO faz: criptografia.** §17.4 passo 3 diz que o cliente só aceita
 * sinalização de par com ticket válido, e quem verifica isso é o NÚCLEO: `signalIsAuthorized`
 * roda antes do evento chegar aqui, com a chave do host e os tickets da sessão, e falha
 * fechada. Duplicar a verificação no renderer exigiria Ed25519 sobre BLAKE2b no navegador —
 * que a WebCrypto não tem — e criaria uma segunda fonte de verdade para a mesma regra.
 *
 * O que sobra para cá é o passo 4: **não iniciar DTLS com par para quem não temos ticket**.
 * Isso não precisa de assinatura, só de saber para quem o host emitiu — e é o que
 * `paresAutorizados` responde.
 *
 * **Duas formas de ticket no fio, e não é descuido de quem lê.** `voice.join` responde pela
 * IPC-R, que é `postMessage`/structured clone: as chaves vêm como `Uint8Array`. Já
 * `voice.tickets` é montado com o codec de §16.2, que é JSON e leva hex. `chaveHex` absorve
 * as duas, porque quem consome não deve saber por qual porta o ticket entrou.
 *
 * O `RTCPeerConnection` e a captura entram injetados: sem isso nada aqui seria testável fora
 * de um navegador com microfone.
 */
import type { MediaTicketDto } from "../ipc/api";

/**
 * Diagnóstico do caminho de mídia, no console do renderer.
 *
 * Existe porque o log de fronteira do produto (`[main]`, `[nucleo]`) vai para o stdout do
 * processo Electron — que numa instalação de Windows aberta pelo Explorer não tem para onde
 * ir. Uma negociação WebRTC que falha em silêncio é indistinguível de uma que nunca começou,
 * e no smoke de duas máquinas foi exatamente essa a dúvida que custou caro.
 */
function log(msg: string, extra?: unknown): void {
  if (extra === undefined) console.log(`[voz] ${msg}`);
  else console.log(`[voz] ${msg}`, extra);
}

/** Ticket como chega da IPC-R (bytes) ou do fio de §16.2 (hex). */
export type TicketNoFio = MediaTicketDto | { peerA: string; peerB: string; expiresAt: number };

export function chaveHex(v: Uint8Array | string): string {
  if (typeof v === "string") return v.toLowerCase();
  return Array.from(v, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Para quem o host autorizou esta instalação a falar, dado o conjunto de tickets vivos.
 * Cada ticket nomeia um PAR ordenado `(peerA, peerB)`; o outro lado é o autorizado.
 */
/**
 * O relógio deste filtro é o LOCAL, e o `expiresAt` foi carimbado pelo RELÓGIO DO HOST.
 * Duas máquinas raramente concordam ao segundo; quem tem o relógio adiantado descartava
 * ticket recém-emitido e o passo 4 bloqueava DTLS para um par que o host tinha acabado de
 * autorizar — o sintoma intermitente "por máquina" da corrida de §17.4. A tolerância é
 * segura aqui: este filtro é consultivo (evitar negociar com quem não há ticket), a
 * verificação que vale é a do núcleo (§17.4 passo 3), que compara com o relógio dele.
 */
const TOLERANCIA_DE_RELOGIO_MS = 60_000;

export function paresAutorizados(
  tickets: readonly TicketNoFio[],
  euHex: string,
  agora: number,
): Map<string, string> {
  const eu = euHex.toLowerCase();
  const out = new Map<string, string>();
  for (const t of tickets) {
    if (t.expiresAt + TOLERANCIA_DE_RELOGIO_MS <= agora) continue;
    const a = chaveHex(t.peerA);
    const b = chaveHex(t.peerB);
    const id = ticketIdDe(t);
    if (a === eu) out.set(b, id);
    else if (b === eu) out.set(a, id);
  }
  return out;
}

/**
 * O `ticketId` que §15.4 exige em `voice.signal`, derivado da assinatura — os 12 primeiros
 * bytes, o mesmo que o núcleo faz em `ticketIdOf`.
 *
 * Antes eu mandava string vazia até receber um sinal, e o roteador recusava com
 * `E_VALIDATION`: quem OFERTA fala primeiro e não tinha nada para apresentar. O id nunca
 * viajou pelo `voice.join`; derivá-lo é o que fecha a lacuna sem campo novo no fio (§79).
 */
export function ticketIdDe(t: TicketNoFio): string {
  const sig = (t as { sig?: Uint8Array | string }).sig;
  if (sig === undefined) return "";
  return chaveHex(sig).slice(0, 24);
}

/**
 * Quem manda a oferta. Sem uma regra combinada, os dois lados ofertam ao mesmo tempo e a
 * negociação entra em *glare*. A comparação das chaves é determinística e os dois lados
 * chegam à mesma conclusão sem trocar mensagem para isso.
 */
export function souOIniciador(euHex: string, parHex: string): boolean {
  return euHex.toLowerCase() < parHex.toLowerCase();
}

import { criarMixador, type Mixador } from "./mixagem";
import { criarDetectorDeVoz, type DetectorDeVoz } from "./vad";

export interface PortaDeVoz {
  join(a: { communityId: string; channelId: string }): Promise<{
    sessionId: string;
    roster: Array<{ keyHex: string }>;
    iceServers: RTCIceServer[];
    tickets: TicketNoFio[];
    /**
     * §31.15 — **numa conversa direta o ticket de §17.4 não existe**, e a ausência é o
     * contrato: o ticket prova a um terceiro que ele está autorizado a sinalizar comigo, e
     * numa dupla a sinalização só chega pelo canal `p2p-dm/1`, autenticado por Noise contra
     * exatamente a chave do par. A propriedade de `T-15` fica fechada **por transporte**.
     *
     * Sem esta marca, o passo 4 abaixo (`#autorizados`) recusaria todo sinal de uma DM: um
     * conjunto de tickets vazio autoriza ninguém, e a chamada nunca negociaria. Com ela, o
     * roster — que numa DM é a própria conversa — é a autorização, e o `ticketId` que sai
     * na sinalização é vazio porque não há ticket a nomear.
     */
    autorizacaoPorTransporte?: boolean;
  }>;
  leave(a?: { sessionId?: string }): Promise<unknown>;
  signal(a: { peerKey: string; ticketId: string; sdp?: string; ice?: string }): Promise<unknown>;
}

export interface FabricaDeMidia {
  /** `getUserMedia({audio})` com o microfone escolhido, ou o padrão do sistema. */
  capturar(deviceId: string): Promise<MediaStream>;
  conexao(config: RTCConfiguration): RTCPeerConnection;
}

/**
 * L-11 é um estado DESENHADO, não um travamento. §17.3: sem porta alcançável o STUN/TURN do
 * host não serve e "a conexão falha com `conn-failed`". Sem este prazo o ICE fica em
 * `checking` indefinidamente e a tela mente "Conectando…" para sempre — foi o que o smoke de
 * §80 mostrou entre operadoras diferentes.
 */
const PRAZO_DE_CONEXAO_MS = 20_000;

/**
 * Quantas vezes um par cuja conexão CHEGOU A FALHAR tem direito a reconstrução do ICE
 * (`restartIce`) antes de a falha dele ser definitiva no tile. É o remédio padrão para
 * queda de rede (Wi-Fi que muda, NAT cujo mapeamento venceu): sem ele, `failed` era um
 * estado terminal — o áudio não voltava até o usuário sair e reentrar na chamada à mão.
 * O teto existe para não virar retentativa infinita contra um par que realmente morreu.
 */
const RESTARTS_POR_PAR = 3;

/**
 * Quanto tempo um par pode ficar `disconnected` antes de reconstruir o ICE. O estado é
 * normal num blip curto — o ICE se cura sozinho — e reconstruir nele seria derrubar uma
 * conexão que voltaria sozinha. Passado o prazo sem recuperação, aí sim.
 */
const GRACA_DE_DESCONECTADO_MS = 5_000;

/**
 * De quanto em quanto tempo a oferta é REFEITA enquanto o outro lado não responde.
 *
 * §17.4 tem uma corrida embutida que nenhuma das duas pontas consegue evitar sozinha: os
 * tickets de um par só existem depois que os DOIS estão no roster, e cada lado os busca por
 * conta própria. Quem já tinha ticket (quem estava na chamada primeiro, ou quem hospeda)
 * oferta no instante em que vê o roster novo; quem acabou de entrar ainda está buscando os
 * seus, e o núcleo dele — que falha fechada por passo 3 — **descarta a oferta em silêncio**.
 *
 * A oferta descartada não voltava nunca: quem oferta é um lado só (`souOIniciador`), e ele
 * já tinha ofertado. Os dois ficavam parados até o prazo de L-11 anunciar `conn-failed` com
 * "candidatos vistos: nenhum" — o defeito exato do smoke de duas máquinas, em que o host
 * mandava a oferta e o outro lado registrava `SEM TICKET` no mesmo fôlego.
 *
 * Repetir é o que fecha a corrida sem inventar campo no fio: a próxima volta encontra o
 * ticket já entregue e a negociação anda. Custa uma oferta a cada três segundos, e só
 * enquanto houver par sem resposta.
 */
const REPETIR_OFERTA_MS = 3_000;

/**
 * Quanto tempo a coleta fica **só com os servidores do host** antes de admitir o terceiro.
 *
 * §17.2 prometeu, na guarda 1 da emenda de 2026-08-25, que "quando o do host resolve, o de
 * terceiro não é consultado". Isso é falso do jeito que estava escrito — o ICE consulta
 * todos em paralelo, a partir de um `std::set` que nem preserva ordem (§99.2). A garantia
 * não se obtém ordenando a lista; obtém-se **não entregando** o terceiro ao agente até
 * saber que o host não resolve.
 *
 * O orçamento é curto de propósito. Um STUN alcançável responde na primeira ou segunda
 * retransmissão (250 ms, 500 ms) — 2,5 s cobre isso com folga inclusive para um host do
 * outro lado do país. E o custo só existe no caso (a) de §17.3: host COM endereço público
 * cujo STUN não responde. Quando o host não tem endereço público nenhum, `#faseUm` nasce
 * vazia e a escalada é imediata, sem esperar nada — é o caso puro da L-11, e fazer quem
 * está nele pagar 2,5 s por uma fase que não tem servidor seria taxa sem contrapartida.
 */
const PRAZO_DA_FASE_UM_MS = 2_500;

/**
 * Quanto o prazo de L-11 estica, UMA vez, quando há `turn:` anunciado e o candidato `relay`
 * ainda não chegou. Ver `#armarPrazo`: contra um TURN que não responde o Chromium leva
 * perto de um minuto e meio para desistir do `TurnPort`, e vencer em 20 s seria declarar
 * a falha antes de o relay ter tido chance.
 */
const PRAZO_EXTRA_COM_TURN_MS = 45_000;

/**
 * §17.2 — quantos servidores da lista NÃO são o host. O host serve `stun:` e `turn:` no
 * mesmo endereço (§17.3), então o critério é o endereço, e não a posição.
 *
 * **Por que não é mais `servers[0]`.** A lista é `[...doHost, ...terceiros]`, e `doHost` é
 * VAZIO quando o host não tem endereço público observado — que é exatamente a L-11 (§80).
 * Nesse caso `servers[0]` é o primeiro TERCEIRO, ele era tomado por host, e a conta dava
 * zero: o aviso de privacidade ficava calado justamente na chamada em que o terceiro é o
 * único servidor em uso. Um aviso que falta no pior caso não é um aviso.
 *
 * O host é reconhecido pelo que só ele pode ser, em ordem:
 *
 * 1. **O endereço que carrega um `turn:`.** §17.3 é categórica — "não há TURN de terceiro e
 *    não haverá" — e o parser de `P2P_STUN_SERVERS` descarta `turn:`. Um `turn:` na lista é
 *    do host, e o `stun:` no mesmo endereço também.
 * 2. **A forma do endereço.** O do host sai do `dht.host`/`dht.port` e é sempre literal
 *    (`203.0.113.9:49737`); um STUN de terceiro é configurado por URL e o default é um nome
 *    (`stun.l.google.com:19302`). É heurística, e é por isso que (1) vem antes.
 *
 * O resíduo — terceiro configurado por IP literal, sem `turn:` na lista — deixou de existir
 * em §99.13: o núcleo carimba `terceiro` na entrada que é dele, e quando a marca está
 * presente ela decide. A heurística fica para lista montada à mão (testes) e para qualquer
 * lista que chegue sem marca.
 */
export function contarTerceiros(servers: readonly { urls: string | string[]; terceiro?: boolean }[]): number {
  if (servers.length === 0) return 0;
  // §99.13 — quando o núcleo carimba, não há o que adivinhar. A heurística abaixo é o
  // fallback para lista sem marca; ela erra só na borda estreita descrita acima.
  if (servers.some((s) => s.terceiro !== undefined)) {
    return servers.filter((s) => s.terceiro === true).length;
  }
  const comTurn = servers.find((s) => /^turns?:/i.test(urlDe(s) ?? ""));
  const doHost = comTurn !== undefined ? enderecoDe(comTurn) : enderecoLiteral(servers);
  if (doHost === null) return servers.length;
  return servers.filter((s) => enderecoDe(s) !== doHost).length;
}

/** O primeiro endereço da lista cujo host é um literal IPv4/IPv6 — a forma do que o host serve. */
function enderecoLiteral(servers: readonly { urls: string | string[] }[]): string | null {
  for (const s of servers) {
    const addr = enderecoDe(s);
    if (addr === null) continue;
    const semPorta = addr.replace(/:\d+$/, "");
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(semPorta) || semPorta.includes(":")) return addr;
  }
  return null;
}

function urlDe(server: { urls: string | string[] } | undefined): string | null {
  const url = typeof server?.urls === "string" ? server.urls : server?.urls?.[0];
  return url ?? null;
}

/** `stun:host:porta?x` → `host:porta`; o que não casar vira a própria string. */
function enderecoDe(server: { urls: string | string[] } | undefined): string | null {
  const url = typeof server?.urls === "string" ? server.urls : server?.urls?.[0];
  if (url === undefined) return null;
  return url.replace(/^stuns?:|^turns?:/i, "").split("?")[0] ?? null;
}

/**
 * A família de endereço de um candidato ICE — `ipv4`, `ipv6` ou `mdns`.
 *
 * Existe porque IPv6 é a única saída de CGNAT que não depende de servidor nenhum: um
 * endereço IPv6 é roteável fim a fim, não há tradução, e o par de candidatos `host`↔`host`
 * fecha direto. O Brasil passou de 50% de adoção de IPv6 em 2024 (NIC.br), então saber se
 * ESTA chamada teve IPv6 disponível é a primeira pergunta de qualquer investigação de
 * conectividade — e hoje o log não a respondia.
 *
 * `mdns` é o candidato `host` que o Chromium ofusca como `<uuid>.local` (draft-ietf-mmusic-
 * mdns-ice-candidates). Ele só resolve na mesma rede local, então para uma chamada entre
 * operadoras ele é ruído: contá-lo como endereço seria contar um endereço que não existe
 * do outro lado.
 *
 * A leitura é do campo 4 da linha `candidate:` de SDP, e não de `candidate.address`, porque
 * `address` é `null` em navegador que ofusca e a linha crua nunca é.
 */
export function familiaDoCandidato(c: { candidate?: string; address?: string | null }): "ipv4" | "ipv6" | "mdns" | null {
  const campos = (c.candidate ?? "").split(/\s+/);
  const bruto = campos[4] ?? c.address ?? "";
  if (bruto === "") return null;
  if (/\.local$/i.test(bruto)) return "mdns";
  if (bruto.includes(":")) return "ipv6";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bruto)) return "ipv4";
  return null;
}

/** O que o ICE viu nesta chamada — a entrada do diagnóstico de L-11. */
export interface ObservacaoDoIce {
  /** `host`, `srflx`, `prflx`, `relay` — os tipos de candidato LOCAL coletados. */
  readonly tipos: ReadonlySet<string>;
  /** As famílias de endereço vistas. */
  readonly familias: ReadonlySet<"ipv4" | "ipv6" | "mdns">;
  /** A lista `iceServers` desta sessão anunciava um `turn:`? (§17.3, `P2P_TURN_ANNOUNCE`) */
  readonly turnAnunciado: boolean;
}

/** O veredito nomeado — `codigo` para o log e o teste, `texto` para a tela de §9 (2.3). */
export interface MotivoDaFalha {
  readonly codigo:
    | "sem-candidatos"
    | "sem-endereco-publico"
    | "so-ipv6-local"
    | "turn-nao-alocou"
    | "furo-falhou"
    | "relay-falhou"
    | "indeterminado";
  readonly texto: string;
}

/**
 * POR QUE a chamada não fechou, derivado do que o ICE efetivamente coletou.
 *
 * A versão anterior tinha um teste só — "todos os candidatos são `host`" — e mandava todo o
 * resto para uma frase genérica. Isso confundia duas falhas que pedem AÇÕES OPOSTAS de quem
 * usa, e é a razão de a investigação de §80 não ter conseguido separar os casos:
 *
 * - **sem `srflx`**: nenhum endereço público foi descoberto. O STUN não respondeu, e o
 *   caminho é o do host (L-11) ou o de terceiro (§17.2) — quem hospeda precisa de porta.
 * - **com `srflx` e sem conexão**: os DOIS lados descobriram endereço público e o furo
 *   falhou assim mesmo. Isso não é L-11: é mapeamento **dependente do destino** (NAT
 *   simétrico ou CGNAT) em pelo menos um dos lados — o endereço que o STUN devolveu vale
 *   para o STUN e não vale para o par. É o caso que EXIGE relay, e é o único em que o TURN
 *   resolve. Dizer "quem hospeda não está alcançável" aqui é mandar a pessoa consertar a
 *   máquina errada.
 *
 * A distinção tem consequência direta em §17.3/§17.7: o primeiro caso é o TURN do host não
 * servir; o segundo é o TURN do host servir e não estar anunciado (`P2P_TURN_ANNOUNCE=0`).
 */
export function motivoDaFalha(o: ObservacaoDoIce): MotivoDaFalha {
  const tem = (t: string): boolean => o.tipos.has(t);

  if (o.tipos.size === 0) {
    return {
      codigo: "sem-candidatos",
      texto:
        "A rede não produziu nenhum endereço para a chamada. UDP pode estar bloqueado nesta rede " +
        "(comum em rede corporativa ou de escola).",
    };
  }

  if (tem("relay")) {
    return {
      codigo: "relay-falhou",
      texto:
        "Havia um caminho por relay e ainda assim a conexão não fechou. O relay respondeu, " +
        "mas os dados não atravessaram.",
    };
  }

  if (tem("srflx") || tem("prflx")) {
    // Endereço público dos dois lados e mesmo assim sem par: mapeamento por destino.
    if (o.turnAnunciado) {
      return {
        codigo: "turn-nao-alocou",
        texto:
          "Os dois lados descobriram o endereço público, a conexão direta não fechou e o relay " +
          "de quem hospeda não chegou a abrir. É NAT simétrico (CGNAT) de um dos lados, e o " +
          "relay é o caminho — ele não respondeu.",
      };
    }
    return {
      codigo: "furo-falhou",
      texto:
        "Os dois lados têm endereço público e ainda assim a conexão direta não fechou — é o " +
        "NAT de uma das operadoras trocando a porta por destino (CGNAT). Esta chamada precisa " +
        "de um relay, e não há nenhum ligado.",
    };
  }

  // Só `host`. IPv6 presente muda o conselho: o endereço existe e é roteável; quem não o tem
  // é o outro lado (ou o firewall IPv6 do roteador dele).
  if (o.familias.has("ipv6")) {
    return {
      codigo: "so-ipv6-local",
      texto:
        "Esta máquina só ofereceu endereços da própria rede (incluindo IPv6) e nenhum endereço " +
        "público IPv4. Se o outro lado não tem IPv6, não há caminho comum.",
    };
  }

  return {
    codigo: "sem-endereco-publico",
    texto: "Sem endereço público: quem hospeda a comunidade não está alcançável de fora da rede dela.",
  };
}

/**
 * §17.2 — a lista partida em (o que o host serve) e (a lista inteira).
 *
 * O critério é a marca `terceiro` que o núcleo carimba (§99.13): quem produz a lista é o
 * `MediaHost`, e só ele sabe, porque `[...doHost, ...terceiros]` tem `doHost` vazio sob
 * L-11 e aí `servers[0]` É o terceiro. A heurística de endereço fica como fallback para
 * lista sem marca (as dos testes antigos, e qualquer lista montada à mão).
 */
export function separarPorOrigem<T extends { urls: string | string[]; terceiro?: boolean }>(
  servers: readonly T[],
): { readonly doHost: readonly T[]; readonly temTerceiro: boolean } {
  const marcados = servers.some((s) => s.terceiro !== undefined);
  if (marcados) {
    const doHost = servers.filter((s) => s.terceiro !== true);
    return { doHost, temTerceiro: doHost.length !== servers.length };
  }
  const terceiros = contarTerceiros(servers);
  if (terceiros === 0) return { doHost: servers, temTerceiro: false };
  // Sem marca e com terceiro na lista, não dá para dizer QUAL é qual sem adivinhar — e
  // adivinhar aqui é o defeito de §99.3. A fase 1 fica vazia e a escalada é imediata: o
  // comportamento de antes desta mudança, que é o pior caso aceitável.
  return { doHost: [], temTerceiro: true };
}

/**
 * A posição do m-line de um transceiver — a chave de leitura de §17.2 (emenda de
 * 2026-09-03).
 *
 * O `mid` é atribuído por quem oferta e viaja na SDP, então os dois lados leem o mesmo
 * número para o mesmo m-line. `getTransceivers()` é a reserva: ele devolve os transceivers
 * na ordem das seções da SDP, que é a mesma coisa dita de outro jeito.
 */
export function posicaoDoMLine(
  pc: Pick<RTCPeerConnection, "getTransceivers">,
  transceiver: RTCRtpTransceiver | undefined,
): number {
  if (transceiver === undefined) return -1;
  const mid = transceiver.mid;
  if (typeof mid === "string" && /^\d+$/.test(mid)) return Number(mid);
  return pc.getTransceivers().indexOf(transceiver);
}

export interface EventosDaMalha {
  /** A chamada não fechou, e o motivo é nomeado — `conn-failed` de §17.3/§9 (2.3). */
  aoFalhar: (motivo: string) => void;
  /** Estado por par, para a UI de §9 (2.3) — `connecting | connected | failed`. */
  aoMudarPar: (peerHex: string, estado: RTCPeerConnectionState) => void;
  /**
   * A VOZ do outro lado, pronta para tocar. Só a voz — e agora **por posição**, não por
   * heurística: ela é o m-line 0 (§17.2, emenda de 2026-09-03). O som que acompanha uma tela
   * é o m-line 3 e chega agrupado com a imagem dela, que é quem o toca.
   */
  aoChegarAudio: (peerHex: string, stream: MediaStream) => void;
  /**
   * Uma trilha de vídeo **do par ficou viva**, e este módulo **sabe o que ela é**: `camera`
   * é o m-line 1 e `tela` é o m-line 2, fixados em §17.2 (emenda de 2026-09-03). É o que
   * fecha **B41** — antes quem escutava tinha de adivinhar cruzando `msid` com o `share.join`
   * que conseguira, e numa conversa direta não havia `share.join` de que partir.
   *
   * Dispara no `unmute`, não no `ontrack`. Com os m-lines reservados, `ontrack` acontece na
   * primeira negociação para os quatro, com trilhas **mudas**: "chegou" deixaria de
   * significar "há imagem". Quem tem imagem é quem está `unmuted`.
   */
  aoChegarVideo?: (
    peerHex: string,
    stream: MediaStream,
    track: MediaStreamTrack,
    origem: OrigemDaTrilha,
  ) => void;
  /**
   * A trilha parou: `replaceTrack(null)` do outro lado, conexão caída ou dispositivo morto.
   *
   * Este evento não existia porque não podia existir: sem m-line reservado, desligar a câmera
   * **removia** a trilha, e o que sobrava era ausência — que não é observável. Agora ela vira
   * `muted`, e a ausência passa a ser um fato medido localmente, sem roster e sem notificação.
   */
  aoSumirVideo?: (peerHex: string, origem: OrigemDaTrilha) => void;
  aoSair: () => void;
  /**
   * O microfone LOCAL morreu com a chamada em curso (cabo puxado, dispositivo
   * tomado, permissão revogada): a trilha disparou `ended` sem passar por nada
   * do produto. É o espelho do `aoEncerrarNaFonte` da câmera (`live/camera.ts`)
   * — com uma diferença que importa: a chamada SEGUE, em somente-escuta. Quem
   * recebe não sai, não é saído e não renegocia nada; o aviso é local e a
   * recuperação é `trocarMicrofone`, com a chamada de pé.
   */
  aoMicrofoneAusente?: (motivo: string) => void;
}

/**
 * O que ocupa cada m-line reservado de §17.2 (emenda de 2026-09-03). A ordem é normativa e
 * está na tabela daquela seção: 0 voz, 1 câmera, 2 tela (imagem), 3 tela (som).
 */
export type OrigemDaTrilha = "camera" | "tela";

/**
 * O que se pode fazer com uma trilha que ESTA máquina envia a UM par. Devolvido por
 * `enviarTrilha`, é a única forma de mexer no `RTCRtpSender` sem conhecer a conexão.
 *
 * `maxBitrate` por espectador é o que torna a qualidade de §17.5 real em estrela: cada
 * `RTCRtpSender` tem os próprios `encodings`, então o perfil de um espectador não afeta os
 * outros. É o que fecha `F-08`/`V-13`.
 */
export interface EnvioDeTrilha {
  definirBitrateKbps(kbps: number): Promise<void>;
  /** Números medidos deste envio — a fonte de `share.report` (§17.5). */
  estatisticas(): Promise<{ rttMs: number; lossPct: number } | null>;
  encerrar(): Promise<void>;
}

/**
 * Os quatro m-lines de §17.2 (emenda de 2026-09-03), resolvidos para UMA conexão.
 *
 * **Só quem OFERTA os cria.** Isto não é preferência: pela regra de associação do WebRTC,
 * um transceiver criado por `addTransceiver` **não** é candidato a receber um m-line de uma
 * oferta remota — só os criados implicitamente por `addTrack` são. Quando os dois lados
 * pré-criavam os quatro, o lado que respondia ficava com OITO: quatro órfãos, sem `mid`, e
 * quatro novos que o Chromium anexou para a oferta que chegou. As trilhas locais estavam
 * nos órfãos, então aquele lado **não transmitia nada** — e o outro sim. Medido em duas
 * pontas (`smoke:voz`), com a chamada conectando normalmente e ficando muda num sentido só.
 *
 * Quem responde **adota** os m-lines negociados (`#adotarMLines`) e põe as trilhas neles.
 */
interface MLines {
  voz: RTCRtpTransceiver;
  camera: RTCRtpTransceiver;
  tela: RTCRtpTransceiver;
  telaAudio: RTCRtpTransceiver;
}

interface Par {
  pc: RTCPeerConnection;
  /** Repassado opaco na sinalização: o host não o interpreta, o núcleo do destino também não. */
  ticketId: string;
  /**
   * Renegociação que não coube porque a negociação anterior ainda não tinha assentado.
   * Sem isto a trilha era adicionada à conexão e a oferta **nunca saía**: o par entrava no
   * mapa de espectadores como servido e ficava sem vídeo para sempre, em silêncio — a
   * forma exata de defeito que §82.3 nomeou.
   */
  renegociacaoPendente: boolean;
  /**
   * Os candidatos que ESTA máquina já coletou para este par.
   *
   * Trickle ICE manda cada candidato uma vez, no instante em que ele aparece, e
   * `onicecandidate` não repete. Quando a oferta é refeita porque a primeira foi descartada
   * (ver `REPETIR_OFERTA_MS`), os candidatos que saíram junto com ela foram descartados
   * pelo mesmo motivo — e a coleta já terminou. Sem esta cópia, o outro lado responderia a
   * uma oferta para a qual nunca receberia endereço nenhum: DTLS não começaria e a chamada
   * falharia do mesmo jeito, só que mais tarde.
   */
  candidatosLocais: RTCIceCandidateInit[];
  /**
   * Candidatos do outro lado que chegaram ANTES da descrição remota. `addIceCandidate` sem
   * descrição remota é erro de estado, e a promessa recusada não tinha quem a pegasse — o
   * evento entra por `void malha.aplicarSinal(...)`. Guardar e aplicar depois é a disciplina
   * normal do trickle; descartar seria perder o endereço que talvez fosse o único que fura.
   */
  candidatosRemotos: RTCIceCandidateInit[];
  /**
   * Os **quatro m-lines reservados** de §17.2 (emenda de 2026-09-03), na ordem normativa.
   *
   * Eles nascem com a conexão, em `sendrecv`, antes da primeira oferta e independentemente
   * de haver o que enviar. É o que torna cada trilha identificável **por posição** em vez de
   * por heurística (**B41**), e o que faz ligar/desligar câmera ou tela custar
   * `replaceTrack` em vez de um round-trip de SDP por par.
   *
   * Nunca use `addTrack`/`removeTrack` numa destas conexões: um m-line criado fora desta
   * tabela desalinha as posições e o outro lado passa a ler tela como câmera.
   */
  tx: MLines | null;
  /**
   * O `MediaStream` que este lado montou para cada origem recebida deste par.
   *
   * A imagem da tela (m-line 2) e o som dela (m-line 3) entram no **mesmo** stream, que é o
   * que faz um `<video>` só tocar os dois — o comportamento que o `msid` compartilhado dava
   * antes, agora garantido pela posição em vez de pelo agrupamento do remetente.
   */
  recebidos: Map<OrigemDaTrilha | "voz", MediaStream>;
  /**
   * As trilhas locais entrando nos m-lines reservados.
   *
   * `replaceTrack` é assíncrono e `addTrack` era síncrono: **nem a oferta nem a resposta
   * podem sair antes disto resolver**, ou a SDP descreve um m-line vazio e aquele lado não
   * transmite. O defeito é silencioso e assimétrico — os dois lados conectam e a chamada
   * fica muda num sentido só —, e foi medido duas vezes em `smoke:voz`: primeiro no lado que
   * oferta, depois no que responde.
   */
  prontas: Promise<unknown>;
  /**
   * Resolução de `prontas` para quem responde. Notificado quando `#adotarMLines`
   * conclui a configuração dos 4 m-lines reservados.
   */
  resolverProntas?: () => void;
  /**
   * Quantas reconstruções de ICE este par já usou. A queda de rede tem remédio
   * (`restartIce`), mas remédio sem teto é retentativa infinita contra par morto.
   */
  tentativasDeRestart: number;
  /** O relógio da graça de `disconnected`; quem o limpa é `#fechar` e o `connected`. */
  reinicioAgendado: ReturnType<typeof setTimeout> | null;
}

/**
 * Uma chamada viva. §15.4 diz "voz é uma só": a instalação tem no máximo uma, e é por isso
 * que esta classe é instanciada uma vez e reusada, nunca empilhada.
 */
export class MalhaDeVoz {
  readonly #porta: PortaDeVoz;
  readonly #midia: FabricaDeMidia;
  readonly #eventos: EventosDaMalha;
  readonly #pares = new Map<string, Par>();
  #local: MediaStream | null = null;
  /**
   * A câmera desta máquina, quando ligada — §17.2 ("voz e câmera: WebRTC mesh").
   *
   * Fica na malha, e não em quem captura, porque a audiência dela é a malha inteira: todo
   * par com quem já se fala recebe, e quem ENTRA depois recebe na negociação inicial, sem
   * renegociação nenhuma. Quem escolhe o dispositivo, pede a permissão e traduz o erro é
   * `live/camera.ts`; aqui a câmera é só "a trilha de vídeo que esta máquina manda a todos".
   */
  #videoLocal: { track: MediaStreamTrack; stream: MediaStream } | null = null;
  #config: RTCConfiguration = {};
  #euHex = "";
  #autorizados = new Map<string, string>();
  #sessionId: string | null = null;
  /** Verdadeiro entre o início de `entrar` e o assentamento (ou falha) dele. */
  #entrando = false;
  #fila: Promise<unknown> = Promise.resolve();
  #geracao = 0;

  /** Serializa operações concorrentes de entrar/sair na malha. */
  #enfileirar<T>(op: () => Promise<T>): Promise<T> {
    const proxima = this.#fila.then(op, op);
    this.#fila = proxima.catch(() => undefined);
    return proxima;
  }
  /** Tipos de candidato ICE vistos — é o que diz POR QUE não conectou. */
  readonly #tiposDeCandidato = new Set<string>();
  /**
   * Famílias de endereço vistas (`ipv4`/`ipv6`/`mdns`). IPv6 é a única travessia de CGNAT
   * que não depende de servidor nenhum, e sem registrá-la o diagnóstico não consegue dizer
   * se a chamada sequer teve essa chance.
   */
  readonly #familiasDeCandidato = new Set<"ipv4" | "ipv6" | "mdns">();
  /** O prazo de L-11 já foi esticado uma vez à espera do `relay`? (ver `#armarPrazo`) */
  #prazoEsticado = false;
  /**
   * §17.2/§99.13 — a lista INTEIRA da sessão, incluindo os de terceiro. `#config` carrega
   * só a fase corrente; esta é o destino da escalada.
   */
  #todosOsServidores: readonly RTCIceServer[] = [];
  /** 1 = só o host; 2 = a lista inteira. Sobe uma vez por sessão e nunca desce. */
  #faseDoIce: 1 | 2 = 2;
  #prazoDaFaseUm: ReturnType<typeof setTimeout> | null = null;
  #prazo: ReturnType<typeof setTimeout> | null = null;
  #retentativa: ReturnType<typeof setInterval> | null = null;

  /**
   * §17.5 (emenda de 2026-08-28) — o Modo Música. `#mistura` existe enquanto a música está
   * ativa: a trilha que sai por cada `RTCPeerConnection` é a MISTURADA (mic + sistema), e
   * `#local` continua sendo o microfone — é a perna de voz do grafo. Os dois níveis de muto
   * (§17.5 item 5): `#mudoProprio` corta a perna do mic (a música segue); `#mudoImposto`
   * corta a trilha de SAÍDA inteira (host/fila). Fora da mistura, a trilha do mic É a de
   * saída, e os dois níveis convergem — o comportamento de hoje.
   */
  #mistura: Mixador | null = null;
  /** A trilha de sistema que ESTA malha recebeu em `ativarMusica` — quem a para é quem a pediu. */
  #trilhaDeSistema: MediaStreamTrack | null = null;
  /**
   * Ajustes de áudio (Fatia 4) — o VAD real: analisa a trilha do MIC e alimenta o campo
   * `speaking` de §17.6, que sempre existiu no protocolo e nunca era setado. `null` sem
   * WebAudio — "sem medição" nunca é falha.
   */
  #detector: DetectorDeVoz | null = null;
  #mudoProprio = false;
  #mudoImposto = false;
  readonly #fabricaDeMixador: (mic: MediaStream) => Mixador | null;
  /**
   * §10, 3.1 (B47) — o estágio de ganho de ENTRADA: mic → ganho → destino. É o que faz o
   * `inputVolume` da tela de ajustes valer de verdade no que sai por malha — antes ele era
   * lido, persistido e nunca aplicado. O `#local` continua sendo o microfone cru (VAD,
   * gravação e o `stream` que nomeia o `msid` para o outro lado); a TRILHA QUE SAI é a do
   * destino, pós-ganho. `null` sem `AudioContext` (teste fora de navegador) — aí sai o mic
   * cru, que é o comportamento de sempre.
   */
  #ctxAudio: AudioContext | null = null;
  #fonteLocal: MediaStreamAudioSourceNode | null = null;
  #ganhoEntrada: GainNode | null = null;
  #destinoLocal: MediaStreamAudioDestinationNode | null = null;
  /** O stream de sistema do Modo Música — quem o guarda é que consegue re-misturar ao trocar de microfone. */
  #streamDeSistema: MediaStream | null = null;
  #volumeEntrada = 100;

  constructor(
    porta: PortaDeVoz,
    midia: FabricaDeMidia,
    eventos: EventosDaMalha,
    fabricaDeMixador: (mic: MediaStream) => Mixador | null = criarMixador,
  ) {
    this.#porta = porta;
    this.#midia = midia;
    this.#eventos = eventos;
    this.#fabricaDeMixador = fabricaDeMixador;
  }

  get sessionId(): string | null {
    return this.#sessionId;
  }

  /**
   * Há um `voice.join` EM CURSO. Entre o clique e a resposta do host, o evento
   * `voice.revoked` da sessão ANTIGA chega — trocar de canal é sair da anterior (§17.4), e o
   * host emite a revogação no mesmo fôlego em que admite a nova. Tratá-la como encerramento
   * derrubava a chamada que o usuário acabou de pedir e o `voice.leave` dela, resolvido pelo
   * núcleo contra a sessão CORRENTE, expulsava da NOVA.
   */
  get entrando(): boolean {
    return this.#entrando;
  }

  /** Épico 4 — o stream LOCAL (mic), insumo da gravação local e do medidor. */
  get streamLocal(): MediaStream | null {
    return this.#local;
  }

  entrar(a: {
    communityId: string;
    channelId: string;
    euHex: string;
    microfoneId: string;
    agora: number;
    /** §10, 3.1 — o `inputVolume` da tela de ajustes, aplicado ao que SAI (B47). */
    volumeEntrada?: number;
  }): Promise<{ sessionId: string; microfoneAusente: string | null }> {
    const geracao = ++this.#geracao;
    return this.#enfileirar(() => this.#entrar(a, geracao));
  }

  async #entrar(
    a: {
      communityId: string;
      channelId: string;
      euHex: string;
      microfoneId: string;
      agora: number;
      /** §10, 3.1 — o `inputVolume` da tela de ajustes, aplicado ao que SAI (B47). */
      volumeEntrada?: number;
    },
    geracao: number,
  ): Promise<{ sessionId: string; microfoneAusente: string | null }> {
    // A ordem importa: o host decide ANTES de qualquer captura. Ligar o microfone para
    // depois descobrir que a permissão de §9.1 não deixa entrar acende a luz à toa.
    log(`entrando em ${a.channelId} (geração ${geracao})`);
    // A reentrada nasce LIMPA. Entrar de novo — trocar de canal, o "Tentar novamente" de
    // §80, o join depois de uma falha parcial — sem limpar deixava as RTCPeerConnection(s)
    // do join anterior negociando pelo MESMO `voice.signal`: ofertas cruzadas, candidates
    // de duas conexões misturados, a mesma voz tocando duas vezes e o microfone antigo
    // preso ao dispositivo. "Voz é uma só" (§15.4) vale para o estado local também. A
    // limpeza é a de `sair()` MENOS o `leave` na porta: o host já resolveu a sessão
    // anterior dentro do próprio `voice.join` idempotente, e um `leave` aqui seria
    // resolvido contra a sessão NOVA.
    this.#entrando = true;
    try {
      this.#limparEstado();
      const r = await this.#porta.join({ communityId: a.communityId, channelId: a.channelId });
      if (geracao !== this.#geracao) {
        log(`join cancelado por operação subsequente (geração ${geracao} vs ${this.#geracao})`);
        return { sessionId: r.sessionId, microfoneAusente: null };
      }
      // O que o host serve. Lista VAZIA aqui significa que a chamada só fecha em rede local:
      // sem STUN o WebRTC junta apenas candidato de host (§17.3, L-11).
      log(`join ok · sessão ${r.sessionId} · roster ${r.roster.length} · iceServers`, r.iceServers);
      // §17.2 "com aviso": qualquer servidor em endereço que não seja o do host é de
      // TERCEIRO, e ele passa a ver o IP de quem entra na chamada.
      //
      // **"O de terceiro nem é consultado" é falso, e o aviso não deve sugeri-lo.** §17.2
      // apoiava a emenda de 2026-08-25 numa garantia de ordem: o STUN do host vem primeiro,
      // logo quando ele resolve o de terceiro não é usado. O libwebrtc não funciona assim.
      // `UDPPort::SendStunBindingRequests()` percorre `server_addresses_` e manda um Binding
      // para CADA servidor, e `ServerAddresses` é `std::set<rtc::SocketAddress>` — a ordem
      // do array `iceServers` nem chega a ser preservada. RFC 8445 §5.1.1.2 diz o mesmo:
      // "the agent pairs each host candidate with the STUN or TURN servers with which it is
      // configured". Não há curto-circuito: com um terceiro configurado, ele vê o IP SEMPRE.
      const deTerceiros = contarTerceiros(r.iceServers);
      if (deTerceiros > 0) {
        log(
          `ATENÇÃO — ${deTerceiros} STUN de terceiro na lista; TODOS são consultados em ` +
            `paralelo e cada um vê seu IP, mesmo quando o do host responde (§17.2)`,
        );
      }
      // Uma chamada nova nasce sem música e sem imposição: quem quiser música de novo a
      // ativa de novo, e o roster do host re-dita a imposição no primeiro evento.
      this.#mudoImposto = false;
      this.#sessionId = r.sessionId;
      this.#euHex = a.euHex.toLowerCase();
      this.#todosOsServidores = r.iceServers;
      // §99.13 — a coleta começa SÓ com o que o host serve. O terceiro entra por escalada,
      // e só se o host não resolver: é assim que a garantia da guarda 1 de §17.2 passa a
      // existir de verdade, já que a ordem da lista nunca a deu.
      const { doHost, temTerceiro } = separarPorOrigem(r.iceServers);
      if (temTerceiro && doHost.length > 0) {
        this.#faseDoIce = 1;
        this.#config = { iceServers: [...doHost] };
        log(`ICE fase 1 — só o host (${doHost.length} servidor(es)); o terceiro entra em ${PRAZO_DA_FASE_UM_MS / 1000}s se não houver srflx`);
        this.#armarPrazoDaFaseUm();
      } else {
        // Sem terceiro (nada a proteger) ou sem servidor do host (nada a tentar primeiro):
        // a lista inteira desde o início, sem custo de espera.
        this.#faseDoIce = 2;
        this.#config = { iceServers: [...r.iceServers] };
      }
      this.#autorizados = paresAutorizados(r.tickets, this.#euHex, a.agora);
      // §31.15 — sem host que emita ticket, quem autoriza é o cabo. O roster de uma chamada
      // de dois é a conversa, e o `ticketId` fica vazio porque não há ticket a citar.
      if (r.autorizacaoPorTransporte === true) {
        for (const p of r.roster) {
          const par = p.keyHex.toLowerCase();
          if (par !== this.#euHex) this.#autorizados.set(par, "");
        }
      }
      // A captura pode falhar DEPOIS do join aceito (permissão do sistema negada, dispositivo
      // sumido). O desfecho NÃO é sair: o join ACEITO colocou este nó no roster do host, e é
      // nele que ele fica — em somente-escuta, com o motivo nomeado para quem desenha o
      // aviso. Expulsar da chamada quem está sem microfone é o defeito que a política de
      // microfone ausente de §17.4 tira daqui: sem mic não há o que transmitir, e o m-line 0
      // vazio é lido do outro lado como silêncio honesto — nunca como saída.
      let microfoneAusente: string | null = null;
      try {
        this.#local = await this.#midia.capturar(a.microfoneId);
      } catch (e) {
        microfoneAusente = motivoDoErroDeMicrofone(e);
        log(`microfone indisponível na entrada — somente-escuta · ${microfoneAusente}`);
      }
      this.#vigiarMicrofone();
      // O detector NASCE do stream capturado. Era criado antes, com `#local` ainda `null` na
      // primeira entrada — e `null` para sempre: o VAD nunca media, `speaking` nunca saía
      // (§17.6) e o anel de fala de ninguém acendia. Sem captura não há o que medir: o
      // detector fica `null` e o loop do VAD o lê como "sem medição".
      this.#detector = this.#local !== null ? criarDetectorDeVoz(this.#local) : null;
      // O estágio de ganho de entrada: o que sai por malha passa pelo `inputVolume` (B47).
      if (a.volumeEntrada !== undefined) this.#volumeEntrada = Math.max(0, Math.min(100, a.volumeEntrada));
      this.#montarGanhoEntrada();
      log(
        microfoneAusente === null
          ? `microfone ok · autorizado a falar com ${this.#autorizados.size} par(es)`
          : `somente-escuta · autorizado a ouvir ${this.#autorizados.size} par(es)`,
        [...this.#autorizados.keys()],
      );

      for (const p of r.roster) {
        const par = p.keyHex.toLowerCase();
        if (par === this.#euHex) continue;
        this.#abrir(par, souOIniciador(this.#euHex, par));
      }
      // **Só há prazo se há com quem conectar.** Entrar sozinho num canal de voz é normal —
      // espera-se alguém. Armar o relógio aí fazia a tela anunciar `conn-failed` 20 s depois,
      // com "candidatos vistos: nenhum", para uma chamada que nunca tentou conectar nada.
      if (this.#pares.size > 0) {
        this.#armarPrazo();
        this.#armarRetentativa();
      }
      return { sessionId: r.sessionId, microfoneAusente };
    } finally {
      this.#entrando = false;
    }
  }

  /** `voice.roster` — o host publicou a lista nova. Entra quem chegou, sai quem saiu. */
  aplicarRoster(participantes: ReadonlyArray<{ keyHex: string }>): void {
    if (this.#sessionId === null) return;
    const vivos = new Set(participantes.map((p) => p.keyHex.toLowerCase()));
    for (const par of vivos) {
      if (par !== this.#euHex && !this.#pares.has(par)) {
        this.#abrir(par, souOIniciador(this.#euHex, par));
        this.#armarPrazo();
        this.#armarRetentativa();
      }
    }
    for (const par of [...this.#pares.keys()]) {
      if (!vivos.has(par)) this.#fechar(par);
    }
    // Ficar sozinho de novo desarma o relógio: não há conexão pendente para falhar.
    if (this.#pares.size === 0) {
      this.#desarmarPrazo();
      this.#desarmarRetentativa();
    }
  }

  /**
   * §31.15 — autoriza um par **pelo transporte**, sem ticket. Só a conversa direta chama
   * isto: lá o canal `p2p-dm/1` já foi autenticado por Noise contra exatamente esta chave, e
   * `voiceTicket` não existe. Numa comunidade continua valendo o passo 4 de §17.4 — quem
   * autoriza é o host, e chamar isto lá desfaria a propriedade que `T-15` fechou.
   */
  autorizarPorTransporte(parHex: string): void {
    const par = parHex.toLowerCase();
    if (par !== this.#euHex) this.#autorizados.set(par, "");
  }

  /** `voice.tickets` — a renovação de §17.4. Só muda quem está autorizado; nada reconecta. */
  aplicarTickets(tickets: readonly TicketNoFio[], agora: number): void {
    this.#autorizados = paresAutorizados(tickets, this.#euHex, agora);
    log(`tickets renovados · ${this.#autorizados.size} par(es) autorizado(s)`);
    for (const [par, id] of this.#autorizados) {
      const p = this.#pares.get(par);
      if (p !== undefined) p.ticketId = id;
    }
    // Ticket novo destrava quem estava parado — mas quem estava parado nem sempre é quem
    // acabou de ser autorizado. Quem já tinha o ticket e ofertou cedo demais (§17.4, a
    // corrida de `REPETIR_OFERTA_MS`) também está parado, e comparar com o conjunto
    // anterior fazia exatamente esse caso ser pulado. A condição que vale é o estado da
    // NEGOCIAÇÃO, não a novidade do ticket.
    this.#tentarNegociacoesParadas();
    if (this.#pares.size > 0) this.#armarRetentativa();
  }

  /**
   * A lista `iceServers` RENOVADA que vem no `voice.tickets` (emenda de 2026-08-30, §15.5).
   *
   * A credencial TURN é de curta duração (§17.3) e viaja costurada no `turn:` da lista. Sem
   * isto, uma chamada que dependa de relay morre quando a credencial vence: o Allocate novo
   * volta 401 e a coleta de candidatos do par morre com ele. `setConfiguration` é a forma
   * canônica de trocar servidores ICE numa conexão VIVA — não recria a conexão, não
   * renegocia, só alimenta as próximas coletas (as de um `restartIce`, por exemplo).
   */
  aplicarIceServers(servers: readonly RTCIceServer[]): void {
    if (this.#sessionId === null || servers.length === 0) return;
    this.#todosOsServidores = servers;
    // **A renovação não pode desfazer a fase 1 (§99.13).** Aplicar a lista inteira aqui
    // entregaria o terceiro ao agente antes de o host ter falhado — que é exatamente o que
    // a fase 1 existe para impedir, e a renovação chega a cada `MEDIA_TICKET_TTL_MS/3`,
    // muito antes dos 2,5 s terem qualquer chance de importar em chamada longa.
    const aplicar =
      this.#faseDoIce === 1 ? [...separarPorOrigem(servers).doHost] : [...servers];
    if (aplicar.length === 0) return;
    this.#config = { iceServers: aplicar };
    log(`iceServers renovados · fase ${this.#faseDoIce} · aplicando a ${this.#pares.size} par(es)`);
    for (const [, par] of this.#pares) {
      try {
        par.pc.setConfiguration({ iceServers: aplicar });
      } catch (e) {
        // Nem toda implementação aceita `setConfiguration` em todos os estados; a conexão
        // atual continua com o que tem — a próxima negociação usa a lista nova.
        log(`setConfiguration recusado para um par — ${codigoDe(e)}`);
      }
    }
  }

  /**
   * `voice.signal` — SDP/ICE de um par. O núcleo já autorizou (passo 3); aqui vale o passo 4,
   * que é não deixar DTLS começar com quem o host não pareou conosco.
   */
  async aplicarSinal(a: { peerKey: string; ticketId: string; sdp?: string; ice?: string }): Promise<void> {
    const par = a.peerKey.toLowerCase();
    if (this.#sessionId === null || par === this.#euHex) return;
    if (!this.#autorizados.has(par)) {
      log(`sinal de ${par.slice(0, 8)} IGNORADO — sem ticket para este par (§17.4 passo 4)`);
      return;
    }

    log(`sinal recebido de ${par.slice(0, 8)} · ${a.sdp !== undefined ? "sdp" : "ice"}`);
    const existente = this.#pares.get(par);
    /*
     * **O papel é `souOIniciador`, nunca um `false` fixo** (correção de 2026-09-05).
     *
     * Este ramo é a rede de segurança para o sinal que chega de um par que não está em
     * `#pares`: `#fechar` (roster que oscilou) não limpa `#autorizados`, então um candidato
     * trickle atrasado do par que acabou de sair reabre a conexão por aqui. Com `false`
     * fixo, o lado que DEVERIA ofertar nascia como respondedor: `tx` fica `null`, os quatro
     * m-lines de §17.2 não são criados, e `aplicarRoster` não conserta depois porque
     * `#pares.has(par)` o faz pular a reabertura. A repetição de `#tentarNegociacoesParadas`
     * então mandava uma oferta **sem m-line nenhum**: o ICE conectava, o tile ficava verde e
     * a chamada era muda para sempre naquele par.
     */
    const p = existente ?? this.#abrir(par, souOIniciador(this.#euHex, par));
    // O id que vale é o do NOSSO ticket; o que veio no quadro é do ticket do outro lado.
    p.ticketId = this.#autorizados.get(par) ?? a.ticketId;

    if (a.sdp !== undefined) {
      const desc = JSON.parse(a.sdp) as RTCSessionDescriptionInit;
      /** A minha oferta foi desfeita para dar lugar à que chegou — ela volta depois. */
      let desfezOferta = false;
      // **Glare de RENEGOCIAÇÃO.** A oferta inicial tem dono (`souOIniciador`), mas a
      // renegociação não tinha: desde que a câmera existe, os dois lados podem ofertar no
      // mesmo instante — os dois ligando a câmera juntos é o caso trivial. Aplicar uma
      // oferta remota em `have-local-offer` é erro de estado, e a promessa recusada não tem
      // quem a pegue (o evento entra por `void malha.aplicarSinal(...)`): a negociação
      // ficaria parada para sempre, com a câmera acesa de um lado e ausente do outro.
      //
      // O desempate reusa a MESMA regra determinística de quem oferta primeiro. Quem
      // iniciaria **ignora** a oferta que chegou — a dele continua valendo; o outro
      // **desfaz** a própria (`rollback`), responde, e reoferta quando assentar. Nenhuma
      // das duas pontas precisa combinar nada para chegar a esta conclusão.
      if (desc.type === "offer" && p.pc.signalingState !== "stable") {
        if (souOIniciador(this.#euHex, par)) {
          log(`par ${par.slice(0, 8)} · oferta cruzada IGNORADA — a minha é que vale`);
          return;
        }
        log(`par ${par.slice(0, 8)} · oferta cruzada — desfazendo a minha e respondendo`);
        await p.pc.setLocalDescription({ type: "rollback" } as RTCSessionDescriptionInit);
        desfezOferta = true;
      }
      await p.pc.setRemoteDescription(desc);
      // Os m-lines negociados são os que valem — inclusive para quem ofertou, porque o
      // rollback de uma oferta cruzada devolve os locais ao estado não associado.
      await this.#adotarMLines(p);
      // Só agora, e não junto do `rollback`: marcar antes deixaria a marca de pé no instante
      // em que o rollback devolve o estado a `stable`, e `onsignalingstatechange` dispararia
      // a oferta de volta — a mesma colisão, de novo. Em `have-remote-offer` o retorno é
      // seguro: a marca só será lida quando a resposta assentar.
      if (desfezOferta) p.renegociacaoPendente = true;
      // Chegou a descrição: os candidatos que esperavam por ela entram agora, na ordem.
      await this.#soltarCandidatosRemotos(par, p);
      if (desc.type === "offer") {
        const resposta = await p.pc.createAnswer();
        await p.pc.setLocalDescription(resposta);
        await this.#porta.signal({ peerKey: par, ticketId: p.ticketId, sdp: JSON.stringify(resposta) });
        log(`par ${par.slice(0, 8)} · resposta enviada`);
        // A oferta pode ser a REPETIÇÃO de uma que se perdeu (§17.4, `REPETIR_OFERTA_MS`).
        // Nesse caso os candidatos que este lado já coletou saíram junto com a resposta
        // anterior e foram descartados com ela; `onicecandidate` não os repete.
        await this.#reenviarCandidatosLocais(par, p);
      }
      return;
    }
    if (a.ice !== undefined) {
      const candidato = JSON.parse(a.ice) as RTCIceCandidateInit;
      // Sem descrição remota, `addIceCandidate` é erro de estado. O candidato espera.
      if (p.pc.remoteDescription === null) {
        p.candidatosRemotos.push(candidato);
        return;
      }
      await p.pc.addIceCandidate(candidato).catch(() => {
        // Candidato que o navegador recusa é um endereço a menos, nunca o fim da chamada.
      });
    }
  }

  /** Pares com conexão aberta agora — a audiência possível de qualquer trilha nova. */
  pares(): string[] {
    return [...this.#pares.keys()];
  }

  /**
   * §10, 3.1 (B47) — o volume de ENTRADA, 0..100. É o que o microfone de esta máquina
   * TRANSMITE, não o que ela ouve. Era preferência persistida sem efeito nenhum; agora é o
   * ganho do estágio por onde a trilha de saída passa. Ao vivo, sem re-captura.
   */
  definirVolumeEntrada(p: number): void {
    this.#volumeEntrada = Math.max(0, Math.min(100, p));
    if (this.#ganhoEntrada !== null) this.#ganhoEntrada.gain.value = this.#volumeEntrada / 100;
    log(`volume de entrada ${this.#volumeEntrada}%`);
  }

  /** Monta `mic → ganho → destino`. Sem `AudioContext`, sai o mic cru — como sempre foi. */
  #montarGanhoEntrada(): void {
    this.#desmontarGanhoEntrada();
    if (this.#local === null) return;
    const Ctor = globalThis.AudioContext;
    if (typeof Ctor !== "function") return;
    try {
      const ctx = new Ctor();
      void ctx.resume().catch(() => undefined);
      const fonte = ctx.createMediaStreamSource(this.#local);
      const ganho = ctx.createGain();
      ganho.gain.value = this.#volumeEntrada / 100;
      const destino = ctx.createMediaStreamDestination();
      fonte.connect(ganho).connect(destino);
      this.#ctxAudio = ctx;
      this.#fonteLocal = fonte;
      this.#ganhoEntrada = ganho;
      this.#destinoLocal = destino;
    } catch (e) {
      log("estágio de ganho indisponível — sai o microfone cru", e);
      this.#desmontarGanhoEntrada();
    }
  }

  #desmontarGanhoEntrada(): void {
    try {
      this.#fonteLocal?.disconnect();
    } catch {}
    try {
      this.#destinoLocal?.disconnect();
    } catch {}
    this.#fonteLocal = null;
    this.#ganhoEntrada = null;
    this.#destinoLocal = null;
    try {
      void this.#ctxAudio?.close();
    } catch {}
    this.#ctxAudio = null;
  }

  /** A trilha de ÁUDIO que SAI por malha: a mistura (música ativa), a pós-ganho, ou o mic cru. */
  #trilhaDeSaida(): MediaStreamTrack | null {
    const daMistura = this.#mistura?.trilha ?? null;
    if (daMistura !== null) return daMistura;
    const doDestino = this.#destinoLocal?.stream.getAudioTracks()[0];
    if (doDestino !== undefined && doDestino !== null) return doDestino;
    return this.#local?.getAudioTracks()[0] ?? null;
  }

  /**
   * §10, 3.1 (B47) — trocar de microfone DURANTE a chamada. Antes, a escolha nova só valia
   * na próxima chamada, sem aviso: a captura acontecia uma vez, no `entrar`. Agora: captura
   * o dispositivo novo, remonta o ganho e a mistura (a música continua, com o mic novo),
   * substitui a trilha em cada par por `replaceTrack` — sem renegociação, mesmos tickets —,
   * para o VAD no mic novo, re-aplica o mudo próprio (que é da pessoa, não do dispositivo)
   * e para as trilhas do dispositivo antigo.
   */
  async trocarMicrofone(deviceId: string): Promise<void> {
    if (this.#sessionId === null) return; // fora de chamada é a próxima captura que lê a escolha
    log(`troca de microfone → ${deviceId}`);
    const novo = await this.#midia.capturar(deviceId);
    const antigo = this.#local;
    // `stop()` dispara `ended`: desarmar ANTES, ou a troca — inclusive a que RECUPERA um
    // mic morto — anunciaria ausência no instante em que a cura chegou. É a mesma ordem
    // de `CameraDaChamada.desligar`.
    this.#desarmarVigiaDoMicrofone();
    this.#local = novo;
    this.#vigiarMicrofone();
    this.#desmontarGanhoEntrada();
    this.#montarGanhoEntrada();
    // Mistura ativa: remonta com o mic novo e o sistema que esta malha guarda, e substitui
    // a trilha de saída pela nova mistura.
    if (this.#mistura !== null && this.#streamDeSistema !== null) {
      const sistema = this.#streamDeSistema;
      this.#mistura.encerrar();
      this.#mistura = null;
      await this.ativarMusica(sistema);
    }
    const trilha = this.#trilhaDeSaida();
    if (trilha !== null) await this.#substituirTrilhaDeAudio(trilha);
    this.definirMudo(this.#mudoProprio);
    this.#detector?.encerrar();
    this.#detector = criarDetectorDeVoz(this.#local);
    for (const t of antigo?.getTracks() ?? []) t.stop();
    log(`microfone trocado · ${this.#pares.size} par(es)`);
  }

  /**
   * A vigia do microfone local: cabo puxado, dispositivo tomado por outro
   * aplicativo ou permissão revogada com a chamada em curso matam a trilha sem
   * passar por nada do produto — e o `ended` é o único que conta.
   *
   * Só o `ended` arma o aviso: `mute` é transitório (o sistema pode recuperar) e
   * reagir a ele expulsaria o aviso a cada soluço do dispositivo.
   */
  #vigiarMicrofone(): void {
    for (const t of this.#local?.getAudioTracks() ?? []) {
      t.onended = () => {
        log("microfone encerrado na fonte — a chamada segue em somente-escuta");
        this.#eventos.aoMicrofoneAusente?.("O microfone foi desconectado.");
      };
    }
  }

  /**
   * `track.stop()` dispara `ended` — desligar por decisão do produto (troca de
   * dispositivo, saída da chamada) precisa desarmar antes, ou cada `stop`
   * intencional viraria um aviso de ausência.
   */
  #desarmarVigiaDoMicrofone(): void {
    for (const t of this.#local?.getAudioTracks() ?? []) {
      try {
        t.onended = null;
      } catch {
        // Trilha de teste sem `onended` gravável: nada a desarmar.
      }
    }
  }

  /**
   * §17.4 L-12 — **silenciar a si mesmo é enforcement, não conselho**: "quem controla o
   * microfone é quem o possui". `voice.setSelf` conta ao host, que republica no roster, e é
   * isso que acende o ícone do outro lado — mas o ícone não interrompe áudio nenhum. Quem
   * interrompe é `track.enabled = false`, aqui, na trilha que esta máquina captura.
   *
   * Sem esta linha o mudo era puramente cosmético: o outro lado via o ícone e continuava
   * ouvindo tudo. Distinguir as duas coisas é justamente o que L-12 exige da UI.
   */
  definirMudo(mudo: boolean): void {
    this.#mudoProprio = mudo;
    const trilhas = this.#local?.getAudioTracks() ?? [];
    for (const t of trilhas) t.enabled = !mudo;
    // Com mistura, o mudo PRÓPRIO é só a perna do mic (a música segue, §17.5 item 5); a
    // trilha de saída continua obedecendo apenas à imposição.
    if (this.#mistura !== null) this.#aplicarTrilhaDeSaida();
    log(`microfone ${mudo ? "MUDO" : "ativo"} (${trilhas.length} trilha(s))`);
  }

  /**
   * §17.4 (emenda de 2026-08-28) — o mute IMPOSTO pelo modo de fala / fila. É estado do
   * host: corta a trilha que SAI (mic + música juntos), e o roster é quem o desfaz. É
   * distinto do mudo próprio justamente para não levar a música junto quando a intenção
   * era só calar a voz.
   */
  definirMudoImpositivo(imposto: boolean): void {
    this.#mudoImposto = imposto;
    this.#aplicarTrilhaDeSaida();
  }

  /** A trilha que efetivamente sai por malha: a misturada, ou a do mic sem mistura. */
  #aplicarTrilhaDeSaida(): void {
    if (this.#mistura !== null) {
      // Com mistura, o mudo PRÓPRIO já calou a perna do mic; a saída obedece só à imposição.
      const saida = this.#mistura.trilha;
      if (saida !== null) saida.enabled = !this.#mudoImposto;
      return;
    }
    // Sem mistura, mic e saída são a mesma trilha: os dois níveis convergem.
    const saida = this.#local?.getAudioTracks()[0];
    if (saida !== undefined && saida !== null) saida.enabled = !this.#mudoImposto && !this.#mudoProprio;
  }

  /**
   * §17.5 item 4 — ativar o Modo Música: entra com a trilha de áudio do sistema, monta o
   * grafo e substitui a trilha de saída por `replaceTrack` — sem renegociação, mesmos
   * tickets. Idempotente: chamar de novo troca a fonte de sistema (seleção de aba/tela).
   */
  async ativarMusica(stream: MediaStream): Promise<boolean> {
    const sistema = stream.getAudioTracks()[0];
    // Três nadas distintos, e nenhum deles é "música tocando": sem trilha de sistema
    // não há música; sem mic não há chamada com captura; sem WebAudio não há grafo.
    // Devolver `false` é o que deixa quem chamou dizer "indisponível" em vez de acender
    // o ícone sobre uma transmissão que não existe.
    if (sistema === undefined || this.#local === null) return false;
    if (this.#mistura === null) {
      // A mistura consome a trilha PÓS-GANHO de entrada: o `inputVolume` vale também para
      // quem canta com música — e trocar de microfone remonta o grafo com o mic novo.
      const deEntrada = this.#destinoLocal?.stream ?? this.#local;
      const mistura = this.#fabricaDeMixador(deEntrada);
      if (mistura === null) return false;
      this.#mistura = mistura;
    }
    /*
     * A anterior só é parada quando é OUTRA. `trocarMicrofone` remonta a mistura com a
     * MESMA fonte de sistema (`ativarMusica(this.#streamDeSistema)`), e o `stop()`
     * incondicional matava justamente a trilha que estava sendo reaproveitada: a música
     * emudecia para todos, sem erro nenhum, no meio de uma troca de microfone.
     */
    if (this.#trilhaDeSistema !== null && this.#trilhaDeSistema !== sistema) {
      this.#trilhaDeSistema.stop();
    }
    this.#trilhaDeSistema = sistema;
    this.#streamDeSistema = stream;
    this.#mistura.definirSistema(stream);
    const saida = this.#mistura.trilha;
    if (saida !== null) await this.#substituirTrilhaDeAudio(saida);
    this.#aplicarTrilhaDeSaida();
    log(`música ativa · ${this.#pares.size} par(es)`);
    return true;
  }

  /** Volume da música (0..1) — passa direto para o nó de ganho do grafo. */
  definirVolumeMusica(g: number): void {
    this.#mistura?.definirGanhoSistema(g);
  }

  /**
   * Ajustes de áudio — o nível RMS instantâneo do MICROFONE (0..1), insumo do VAD e do
   * medidor de nível. `null` sem captura ou sem WebAudio: o chamador trata como "não
   * medível" e desliga o VAD honestamente.
   */
  nivelDeVoz(): number | null {
    return this.#detector?.nivel() ?? null;
  }

  /**
   * §17.6 — **a voz desta máquina está saindo?** É o que o VAD precisa saber antes de
   * publicar `speaking`, e o nível do microfone não responde.
   *
   * Os dois níveis de mudo de §17.5 (item 5) calam a saída por caminhos diferentes: o mudo
   * PRÓPRIO desliga a trilha do microfone — e aí o detector, que mede o microfone, lê
   * silêncio e o VAD se cala sozinho —, mas o mudo IMPOSTO com o Modo Música ligado corta
   * só a trilha MISTURADA e deixa o microfone captando. O detector continuava ouvindo, e
   * quem estava calado na fila de karaokê aparecia com o anel de fala aceso para todo o
   * canal. É a decoração de §85.2 outra vez, agora no `speaking`.
   */
  get vozAudivel(): boolean {
    return !this.#mudoProprio && !this.#mudoImposto;
  }

  /** Voltar ao microfone puro: a trilha original volta por `replaceTrack`. */
  async desativarMusica(): Promise<void> {
    // O que volta é o que sairia SEM mistura — pós-ganho, ou mic cru. Consultar
    // `#trilhaDeSaida` aqui devolveria a própria mistura, que é o que se está tirando.
    const original =
      this.#destinoLocal?.stream.getAudioTracks()[0] ?? this.#local?.getAudioTracks()[0] ?? null;
    if (original !== null) await this.#substituirTrilhaDeAudio(original);
    this.#mistura?.encerrar();
    this.#mistura = null;
    this.#trilhaDeSistema?.stop();
    this.#trilhaDeSistema = null;
    this.#streamDeSistema = null;
    this.#aplicarTrilhaDeSaida();
    log("música desligada");
  }

  /** `replaceTrack` no m-line 0 de cada conexão viva — sem renegociação (§17.5 item 4). */
  async #substituirTrilhaDeAudio(nova: MediaStreamTrack): Promise<void> {
    for (const [, par] of this.#pares) {
      /*
       * O m-line 0, **nomeado**. Procurar "o sender de áudio" por `kind` deixou de ser
       * correto na emenda de 2026-09-03: agora há DOIS áudios por conexão — a voz e o som da
       * tela —, e `find` pegaria o primeiro que aparecesse. Trocar o microfone teria chance
       * de escrever no m-line da tela.
       */
      try {
        await par.tx?.voz.sender.replaceTrack(nova);
      } catch (e) {
        log("replaceTrack falhou para um par — a negociação repetida de §17.4 cobre", e);
      }
    }
  }

  /**
   * §17.2 — a câmera desta máquina passa a ir para **todos** os pares da malha.
   *
   * A diferença para `enviarTrilha` (que é de UM par) não é de estilo: a tela é uma estrela
   * cuja audiência o host autoriza nome a nome (§17.5), e a câmera é malha — quem está na
   * chamada vê, pela mesma regra que faz todos ouvirem o microfone. Por isso ela também
   * entra em `#abrir`: um par que chega depois recebe o vídeo já na primeira oferta.
   */
  async definirVideoLocal(track: MediaStreamTrack, stream: MediaStream): Promise<void> {
    this.#videoLocal = { track, stream };
    log(`câmera ligada · m-line 1 de ${this.#pares.size} par(es)`);
    /*
     * §17.2 (emenda de 2026-09-03) — **sem renegociação nenhuma**. O m-line 1 já foi
     * negociado quando a conexão nasceu; ligar a câmera é trocar a trilha dentro dele.
     *
     * Antes disto, ligar a câmera custava um round-trip de SDP **por par** da malha, e a
     * guarda contra o segundo m-line dependia de nenhuma renegociação correr no meio da
     * varredura. As duas coisas somem.
     */
    await Promise.all(
      [...this.#pares.values()].map((par) =>
        par.tx?.camera.sender.replaceTrack(track).catch((e) => {
          // Par que já caiu não tem trilha a trocar; a reconstrução de ICE cobre o resto.
          log("replaceTrack de câmera falhou para um par", e);
        }),
      ),
    );
  }

  /**
   * Desligar a câmera é tirar a trilha de cada conexão, não parar a captura: quem parou o
   * dispositivo é quem o possui (`live/camera.ts`). Sem esta metade, desligar seria o mesmo
   * "ícone que muda e trilha que continua" que L-12 tirou do mudo (§85.2).
   */
  async removerVideoLocal(): Promise<void> {
    this.#videoLocal = null;
    /*
     * `replaceTrack(null)` **não** derruba o m-line: ele fica negociado e vazio, e a trilha
     * do outro lado vai a `muted`. Essa é a metade que torna o desligamento observável — com
     * `removeTrack` o que sobrava era ausência, e ausência não dispara evento nenhum.
     */
    await Promise.all(
      [...this.#pares.values()].map((par) =>
        par.tx?.camera.sender.replaceTrack(null).catch(() => undefined),
      ),
    );
    log("câmera desligada · m-line 1 esvaziado em todos os pares");
  }

  /**
   * Manda uma trilha a UM par, pela conexão que a voz já mantém com ele.
   *
   * **Por que a mesma `RTCPeerConnection` da voz, e não uma nova.** §17.5 pede "uma
   * `RTCPeerConnection` por espectador", e é exatamente o que isto é: a conexão que já
   * existe com aquele par. Abrir uma segunda exigiria um canal de sinalização próprio para
   * tela — e §15.4 tem UM (`voice.signal`), sem campo que diga a qual negociação um SDP
   * pertence. Duas conexões pelo mesmo canal fariam a oferta de uma cair na outra.
   * Reaproveitar é o que mantém a estrela de §17.5 dentro do contrato que existe.
   *
   * Como só o apresentador adiciona trilha, só ele renegocia: não há glare a resolver aqui,
   * ao contrário da oferta inicial (`souOIniciador`).
   */
  async enviarTrilha(parHex: string, track: MediaStreamTrack, stream: MediaStream): Promise<EnvioDeTrilha | null> {
    const par = this.#pares.get(parHex.toLowerCase());
    if (par === undefined) {
      log(`trilha para ${parHex.slice(0, 8)} IGNORADA — sem conexão com este par`);
      return null;
    }
    // §17.3 (emenda de 2026-08-28) — a tela não sobe por caminho relayado.
    //
    // O controle "tela via TURN é recusada" saiu do host porque lá ele era inaplicável:
    // tela, câmera e voz viajam na MESMA `RTCPeerConnection` (ver abaixo), logo no mesmo
    // componente ICE e na mesma alocação TURN, e o host só vê bytes cifrados. Quem consegue
    // distinguir é este lado, que sabe qual trilha está prestes a empurrar e por qual
    // caminho. É conselho declarado, na distinção que §17.4 já faz (`T-40`) — não
    // enforcement: um cliente modificado empurra assim mesmo, e o teto de taxa do host
    // continua sendo o que limita.
    //
    // Recusar só a tela, e não a chamada: quem está atrás de NAT simétrico continua
    // falando e sendo visto pela câmera; o que ele não faz é transformar o upload de quem
    // hospeda em servidor de vídeo.
    if (await this.#viaRelay(par)) {
      log(`tela para ${parHex.slice(0, 8)} RECUSADA — caminho relayado (§17.3)`);
      return null;
    }
    /*
     * §17.2 (emenda de 2026-09-03) — a tela vai no m-line reservado dela: imagem no 2, som
     * no 3. `stream` deixa de ter papel no fio (o agrupamento agora é por posição) e fica
     * só como parte da assinatura que `tela.ts` já usa.
     *
     * Reservar o m-line em toda conexão da malha **não concede audiência**: quem não entrou
     * na transmissão tem o m-line 2 vazio, e vazio é o que o outro lado lê como "ele não
     * está transmitindo para mim". A autorização continua sendo a de §17.4/§17.5.
     */
    if (par.tx === null) {
      await Promise.race([
        par.prontas,
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ]);
    }
    if (par.tx === null) {
      log(`trilha para ${parHex.slice(0, 8)} IGNORADA — os m-lines ainda não negociaram`);
      return null;
    }
    const transceiver = track.kind === "audio" ? par.tx.telaAudio : par.tx.tela;
    const sender = transceiver.sender;
    void stream;
    // Contadores da leitura anterior, para medir o intervalo em vez do acumulado.
    let anterior = { perdidos: 0, enviados: 0 };
    log(`par ${parHex.slice(0, 8)} · tela (${track.kind}) no m-line reservado — sem renegociar`);
    await sender.replaceTrack(track);
    return {
      definirBitrateKbps: async (kbps) => {
        const params = sender.getParameters();
        // `encodings` pode vir vazio antes da primeira negociação assentar.
        if (params.encodings.length === 0) params.encodings = [{}];
        params.encodings[0]!.maxBitrate = kbps * 1000;
        await sender.setParameters(params);
        log(`par ${parHex.slice(0, 8)} · maxBitrate ${kbps} kbps`);
      },
      estatisticas: async () => {
        const relatorio = await par.pc.getStats(sender.track);
        const bruto = leituraDeSaida(relatorio);
        if (bruto === null) return null;
        // **Perda do INTERVALO, não da sessão inteira.** `packetsLost`/`packetsSent` são
        // contadores acumulados: dividir um pelo outro dá a média desde o começo, e uma
        // rajada nos primeiros segundos manteria a perda alta para sempre. Como a
        // degradação de §17.5 só desce, isso prenderia o espectador no perfil baixo mesmo
        // depois de a rede melhorar.
        const perdidos = bruto.perdidosAcumulados - anterior.perdidos;
        const enviados = bruto.enviadosAcumulados - anterior.enviados;
        anterior = { perdidos: bruto.perdidosAcumulados, enviados: bruto.enviadosAcumulados };
        const lossPct = enviados > 0 ? Math.max(0, Math.min(100, (perdidos / enviados) * 100)) : 0;
        return { rttMs: bruto.rttMs, lossPct };
      },
      encerrar: async () => {
        // Esvaziar, não remover: o m-line fica negociado e a trilha do espectador vai a
        // `muted`, que é como ele fica sabendo que a transmissão acabou.
        await sender.replaceTrack(null).catch(() => undefined);
      },
    };
  }

  /**
   * O `MediaStream` recebido para o slot indicado ("camera", "tela" ou "voz").
   * Permite que consumidores (como `telaStreams`) resgatem o stream vivo mesmo
   * se o evento de chegada foi perdido ou ocorreu antes da inicialização do receptor.
   */
  streamDe(parHex: string, slot: OrigemDaTrilha | "voz"): MediaStream | null {
    const p = this.#pares.get(parHex.toLowerCase()) ?? this.#pares.get(parHex);
    if (p === undefined) return null;
    return p.recebidos.get(slot) ?? null;
  }

  /**
   * As trilhas locais entrando nos m-lines: voz no 0, câmera no 1.
   *
   * A tela não entra aqui porque ela é **por par** (§17.5, e §31.15 numa dupla): quem decide
   * a quem mandá-la é `enviarTrilha`, contra a audiência que o host autorizou.
   */
  async #aplicarTrilhasLocais(tx: MLines): Promise<void> {
    const voz = this.#trilhaDeSaida();
    await Promise.all([
      voz === null ? null : tx.voz.sender.replaceTrack(voz),
      tx.camera.sender.replaceTrack(this.#videoLocal?.track ?? null),
    ]).catch((e) => log("replaceTrack inicial falhou", e));
  }

  /**
   * §17.2 (emenda de 2026-09-03) — quem RESPONDE adota os m-lines que a oferta trouxe.
   *
   * Pela regra de associação do WebRTC, um transceiver criado por `addTransceiver` não é
   * candidato a receber um m-line remoto. Quem responde, portanto, não tem transceivers
   * seus a usar: os que valem são os que o `setRemoteDescription` acabou de criar, e é neles
   * que as trilhas locais precisam entrar. Sem isto aquele lado conecta e **não transmite**
   * (ver `MLines`).
   *
   * A resolução é por `mid`, que é a posição normativa — a mesma chave que `ontrack` usa.
   */
  async #adotarMLines(par: Par): Promise<void> {
    const porMid = new Map<string, RTCRtpTransceiver>();
    for (const t of par.pc.getTransceivers()) if (t.mid !== null) porMid.set(t.mid, t);
    const voz = porMid.get("0");
    const camera = porMid.get("1");
    const tela = porMid.get("2");
    const telaAudio = porMid.get("3");
    if (voz === undefined || camera === undefined || tela === undefined || telaAudio === undefined) {
      // Uma negociação que não trouxe os quatro não é a deste produto. Não há leitura
      // honesta possível, e forçar uma faria a voz sair pelo m-line da tela.
      log(`par sem os quatro m-lines de §17.2 — mids [${[...porMid.keys()].join(",")}]`);
      return;
    }
    const tx = { voz, camera, tela, telaAudio };
    /*
     * **`sendrecv` explícito, nos quatro.** Um transceiver que o `setRemoteDescription`
     * cria nasce `recvonly` — ele descreve o que o outro lado ofereceu, não o que este lado
     * quer. `replaceTrack` põe a trilha no sender e **não mexe na direção**: a resposta
     * saía dizendo "só recebo", e este lado nunca transmitia, com tudo o mais parecendo são.
     * É a segunda metade do mesmo defeito de `MLines`, e o `smoke:voz` mediu as duas.
     */
    for (const t of [voz, camera, tela, telaAudio]) {
      if (t.direction !== "sendrecv") t.direction = "sendrecv";
    }
    par.tx = tx;
    await this.#aplicarTrilhasLocais(tx);
    par.resolverProntas?.();
  }

  /**
   * O `MediaStream` que este lado entrega aos consumidores para uma origem daquele par.
   *
   * Por que montar em vez de repassar `ev.streams[0]`: com os m-lines reservados, quem envia
   * não precisa (nem deveria) agrupar nada por `msid` — o agrupamento é a **posição**. Quem
   * recebe é que monta um stream por origem e mantém o mesmo objeto vivo, porque um
   * `srcObject` trocado pisca a imagem e um recriado a cada trilha separaria o som da tela
   * da imagem dela.
   *
   * `ev.streams[0]` ainda é aceito quando vem: um remetente que agrupou não é motivo para
   * descartar o agrupamento dele, e é o que mantém os testes de unidade — que fingem o
   * WebRTC — falando a mesma língua do produto.
   */
  #agrupar(par: Par, slot: OrigemDaTrilha | "voz", ev: RTCTrackEvent): MediaStream | null {
    const existente = par.recebidos.get(slot);
    if (existente !== undefined) {
      // O som da tela chegando depois da imagem entra no stream que já está tocando.
      try {
        existente.addTrack(ev.track);
      } catch {
        // Já lá dentro, ou um stream de teste sem `addTrack`. Nos dois casos não há o que
        // fazer, e falhar aqui derrubaria a chamada por causa de agrupamento.
      }
      return existente;
    }
    const doRemetente = ev.streams[0];
    const stream =
      doRemetente ??
      (typeof MediaStream === "undefined" ? null : new MediaStream([ev.track]));
    if (stream === null) return null;
    par.recebidos.set(slot, stream);
    return stream;
  }

  /**
   * Oferta de renegociação para um par já conectado. Fora de `stable` a negociação anterior
   * ainda não assentou e ofertar por cima a quebraria — a trilha entra na próxima.
   */
  async #renegociar(parHex: string, par: Par): Promise<void> {
    if (par.pc.signalingState !== "stable") {
      // Marcado, não perdido: `onsignalingstatechange` solta a oferta quando assentar.
      par.renegociacaoPendente = true;
      log(`par ${parHex.slice(0, 8)} · renegociação represada (estado ${par.pc.signalingState})`);
      return;
    }
    await this.#ofertar(parHex, par);
  }

  /**
   * A limpeza de `sair()`, sem tocar na porta. É o que uma chamada deixa LIGADO — conexões,
   * trilhas do microfone, mistura, detector, relógios — e que uma entrada nova precisa
   * encontrar desligado. Usada por `sair()` e pelo começo de `entrar()`.
   */
  #limparEstado(): void {
    // **A chamada anterior acabou, e quem tem objeto vivo precisa saber.** `aoSair` era
    // disparado só por `sair()`; `entrar()` — trocar de canal, "Tentar novamente", a
    // reentrada de B43 — passava por aqui calado, e o que a malha não possui ficava de pé:
    // os `<audio>` dos pares antigos, as telas e câmeras recebidas, a gravação local. O
    // resultado era avatar fantasma e vídeo congelado de uma sessão que o host já esqueceu.
    // É o mesmo aviso, e ele vem ANTES da limpeza: quem escuta ainda precisa dos objetos.
    this.#eventos.aoSair();
    this.#desarmarPrazo();
    this.#desarmarRetentativa();
    this.#tiposDeCandidato.clear();
    this.#familiasDeCandidato.clear();
    this.#prazoEsticado = false;
    this.#desarmarPrazoDaFaseUm();
    this.#faseDoIce = 2;
    this.#todosOsServidores = [];
    for (const par of [...this.#pares.keys()]) this.#fechar(par);
    this.#desarmarVigiaDoMicrofone();
    for (const t of this.#local?.getTracks() ?? []) t.stop();
    this.#mistura?.encerrar();
    this.#mistura = null;
    this.#trilhaDeSistema?.stop();
    this.#trilhaDeSistema = null;
    this.#streamDeSistema = null;
    this.#desmontarGanhoEntrada();
    this.#detector?.encerrar();
    this.#detector = null;
    this.#local = null;
    // A trilha em si é parada por quem a possui (`live/camera.ts`, avisado por `aoSair`);
    // o que sai daqui é a referência, para que a próxima chamada não nasça com ela.
    this.#videoLocal = null;
    this.#sessionId = null;
    this.#autorizados.clear();
  }

  sair(): Promise<void> {
    this.#geracao++;
    return this.#enfileirar(() => this.#sair());
  }

  async #sair(): Promise<void> {
    const sessaoAtual = this.#sessionId;
    // `aoSair` sai de dentro de `#limparEstado` desde 2026-09-06 — repeti-lo aqui faria a
    // câmera ser desligada duas vezes por saída.
    this.#limparEstado();
    await this.#porta.leave(sessaoAtual ? { sessionId: sessaoAtual } : undefined).catch(() => undefined);
  }

  #abrir(parHex: string, iniciar: boolean): Par {
    // Sobrescrever uma entrada viva era vazar a conexão anterior: dois PCs para o mesmo par
    // negociando pelo mesmo `voice.signal`. `entrar` nasce limpo e `aplicarRoster` guarda por
    // `#pares.has`, então isto é rede de segurança — mas rede de segurança é para existir.
    if (this.#pares.has(parHex)) this.#fechar(parHex);
    const pc = this.#midia.conexao(this.#config);
    /*
     * §17.2 (emenda de 2026-09-03) — os quatro m-lines, nesta ordem, e **só de quem oferta**.
     *
     * Criá-los antes de haver o que enviar é o ponto inteiro: a posição de cada trilha fica
     * fixada na primeira negociação e nunca mais muda, então quem recebe identifica câmera,
     * tela e som de tela sem heurística nenhuma (**B41**), e ligar qualquer uma delas depois
     * é `replaceTrack` — sem SDP, sem renegociação e sem a classe de defeito do m-line
     * duplicado que a guarda de `senderDeVideo` existia para evitar.
     *
     * `sendrecv` nos quatro, mesmo vazios: é o que faz o outro lado alocar o receptor e nos
     * entregar uma trilha **muda**, que é a forma observável de "ele não está mandando isto".
     *
     * Quem **responde** não cria nada aqui — ver `MLines`. Ele adota os m-lines da oferta.
     */
    const tx: MLines | null = iniciar
      ? {
          voz: pc.addTransceiver("audio", { direction: "sendrecv" }),
          camera: pc.addTransceiver("video", { direction: "sendrecv" }),
          tela: pc.addTransceiver("video", { direction: "sendrecv" }),
          telaAudio: pc.addTransceiver("audio", { direction: "sendrecv" }),
        }
      : null;
    /*
     * O que SAI por esta conexão é a trilha pós-ganho de entrada (B47), e a câmera já ligada
     * entra pelo mesmo caminho — sem renegociação marcada para quem responde, porque o
     * m-line existe dos dois lados desde o começo.
     *
     * **`replaceTrack` é assíncrono, e `addTrack` era síncrono.** Essa diferença não é de
     * estilo: a oferta inicial precisa sair com a trilha JÁ no transceiver. Deixar as duas
     * correrem em paralelo produziu um defeito assimétrico e silencioso, medido em duas
     * pontas (`smoke:voz`): quem **oferta** mandava a oferta antes de a trilha entrar e não
     * transmitia áudio nenhum, enquanto quem **responde** — que tem todo o tempo da chegada
     * da oferta — transmitia normalmente. Os dois lados conectavam, e a chamada ficava
     * muda num sentido só.
     */
    let resolverProntas: (() => void) | undefined;
    const prontas: Promise<unknown> =
      tx !== null
        ? this.#aplicarTrilhasLocais(tx)
        : new Promise<void>((resolve) => {
            resolverProntas = resolve;
          });
    // O id sai do ticket que o host emitiu para NÓS DOIS — não é opaco nem inventado.
    const par: Par = {
      pc,
      ticketId: this.#autorizados.get(parHex) ?? "",
      renegociacaoPendente: false,
      tx,
      prontas,
      resolverProntas,
      candidatosLocais: [],
      candidatosRemotos: [],
      recebidos: new Map(),
      tentativasDeRestart: 0,
      reinicioAgendado: null,
    };
    this.#pares.set(parHex, par);


    pc.onicecandidate = (ev) => {
      if (ev.candidate === null) {
        log(`par ${parHex.slice(0, 8)} · coleta de candidatos terminada`);
        return;
      }
      // `typ host` só = rede local. `srflx` = o STUN do host respondeu. `relay` = TURN.
      if (ev.candidate.type !== null && ev.candidate.type !== undefined) {
        this.#tiposDeCandidato.add(ev.candidate.type);
      }
      const familia = familiaDoCandidato(ev.candidate);
      if (familia !== null) this.#familiasDeCandidato.add(familia);
      log(
        `par ${parHex.slice(0, 8)} · candidato ${ev.candidate.type ?? "?"} ` +
          `${ev.candidate.protocol ?? ""} ${familia ?? "?"}`,
      );
      const bruto = ev.candidate.toJSON();
      // Guardado ANTES de sair: a coleta acontece uma vez só, e uma negociação refeita
      // precisa dos mesmos endereços (§17.4, `REPETIR_OFERTA_MS`).
      par.candidatosLocais.push(bruto);
      void this.#porta
        .signal({ peerKey: parHex, ticketId: par.ticketId, ice: JSON.stringify(bruto) })
        .catch((e) => {
          // Uma recusa nomeada do núcleo (`E_TICKET_INVALID`, `E_PEER_UNREACHABLE`) que cai
          // aqui sem log é indistinguível de uma que nunca saiu — a lição de §82.3, no canal
          // exato onde ela era literal. O próximo `#tentarNegociacoesParadas` repete.
          log(`par ${parHex.slice(0, 8)} · candidato RECUSADO pelo núcleo — ${codigoDe(e)}`);
        });
    };
    pc.ontrack = (ev) => {
      /*
       * §17.2 (emenda de 2026-09-03) — quem é o quê se lê na POSIÇÃO do m-line.
       *
       * **E a posição é o `mid`, não a identidade do objeto.** Comparar `ev.transceiver`
       * com o que `addTransceiver` devolveu parece equivalente e não é: do lado que
       * **responde**, quem associa m-line a transceiver é o `setRemoteDescription`, e o
       * objeto que chega no `ontrack` não é necessariamente o mesmo que este lado criou.
       * Medido em duas pontas (`smoke:voz`): as quatro trilhas de B caíam em "m-line não
       * reservado" e a chamada morria sem áudio, com a negociação inteira parecendo sã.
       *
       * O `mid` é o que a SDP carrega e o que os dois lados leem igual — é literalmente a
       * posição que a tabela normativa fixa. O índice em `getTransceivers()` fica como
       * reserva para o caso de um `mid` não numérico.
       */
      const pos = posicaoDoMLine(pc, ev.transceiver);
      const slot = pos === 0 ? "voz" : pos === 1 ? "camera" : pos === 2 || pos === 3 ? "tela" : null;
      if (slot === null) {
        // Um m-line fora da tabela normativa. Não há leitura honesta possível — descartar é
        // melhor do que adivinhar, que é justamente o que esta emenda tirou do produto.
        log(`par ${parHex.slice(0, 8)} · trilha em m-line NÃO RESERVADO (${String(pos)}) — descartada`);
        return;
      }
      const stream = this.#agrupar(par, slot, ev);
      if (stream === null) return;
      if (slot === "voz") {
        this.#eventos.aoChegarAudio(parHex, stream);
        return;
      }
      /*
       * O som da tela (m-line 3) entra no MESMO stream da imagem e não dispara evento
       * próprio: quem o toca é o `<video>` da tela, como sempre foi. O que mudou é que o
       * agrupamento agora é garantido pela posição, e não pelo `msid` que o remetente
       * escolheu.
       */
      if (ev.track.kind === "audio") {
        log(`par ${parHex.slice(0, 8)} · som da TELA agrupado com a imagem`);
        return;
      }
      /*
       * `ontrack` acontece na primeira negociação para os quatro m-lines, com as trilhas
       * mudas. "Chegou" não é "há imagem": quem tem imagem é quem está `unmuted`, e é isso
       * que os consumidores precisam saber. Uma trilha que já nasça viva é anunciada na hora.
       */
      const anunciar = () => this.#eventos.aoChegarVideo?.(parHex, stream, ev.track, slot);
      ev.track.onunmute = () => {
        log(`par ${parHex.slice(0, 8)} · ${slot} VIVA`);
        anunciar();
      };
      ev.track.onmute = () => {
        log(`par ${parHex.slice(0, 8)} · ${slot} parou`);
        this.#eventos.aoSumirVideo?.(parHex, slot);
      };
      ev.track.onended = () => this.#eventos.aoSumirVideo?.(parHex, slot);
      if (!ev.track.muted) anunciar();
    };
    pc.onconnectionstatechange = () => {
      log(`par ${parHex.slice(0, 8)} · conexão ${pc.connectionState}`);
      // Um par conectado já basta: a chamada existe, e a falha de outro é assimétrica.
      if (pc.connectionState === "connected") {
        this.#desarmarPrazo();
        this.#descartarRestart(par);
      }
      // Queda de rede não é o fim da chamada. `disconnected` tem graça própria (o ICE se
      // cura sozinho num blip curto); `failed` reconstrói na hora, com teto.
      if (pc.connectionState === "failed") this.#reiniciarPar(parHex, par);
      if (pc.connectionState === "disconnected") this.#agendarRestart(parHex, par);
      this.#eventos.aoMudarPar(parHex, pc.connectionState);
    };
    pc.onsignalingstatechange = () => {
      // Voltou a `stable`: se havia trilha esperando, a oferta sai AGORA. É o retorno que
      // faltava — antes o adiamento era definitivo.
      if (pc.signalingState !== "stable" || !par.renegociacaoPendente) return;
      par.renegociacaoPendente = false;
      log(`par ${parHex.slice(0, 8)} · renegociação represada saindo agora`);
      void this.#ofertar(parHex, par);
    };
    pc.oniceconnectionstatechange = () => log(`par ${parHex.slice(0, 8)} · ICE ${pc.iceConnectionState}`);
    pc.onicegatheringstatechange = () => log(`par ${parHex.slice(0, 8)} · coleta ICE ${pc.iceGatheringState}`);
    // §17.4 passo 4 — sem ticket para este par, a conexão existe mas NÃO oferta: nada de
    // DTLS. Quando a renovação trouxer o ticket, o roster seguinte reabre.
    if (iniciar && this.#autorizados.has(parHex)) {
      // Depois das trilhas, nunca junto delas — ver o comentário de `prontas`.
      void prontas.then(() => this.#ofertar(parHex, par));
    } else {
      log(
        `par ${parHex.slice(0, 8)} · aguardando oferta` +
          (this.#autorizados.has(parHex) ? "" : " (SEM TICKET — o host não pareou nós dois)"),
      );
    }
    return par;
  }

  async #ofertar(parHex: string, par: Par): Promise<void> {
    try {
      const oferta = await par.pc.createOffer();
      await par.pc.setLocalDescription(oferta);
      await this.#porta.signal({ peerKey: parHex, ticketId: par.ticketId, sdp: JSON.stringify(oferta) });
      log(`par ${parHex.slice(0, 8)} · oferta enviada`);
    } catch (e) {
      log(`par ${parHex.slice(0, 8)} · oferta FALHOU — ${codigoDe(e)}`, e);
      this.#eventos.aoMudarPar(parHex, "failed");
    }
  }

  /**
   * As negociações que começaram e não andaram — e a repetição da oferta que as destrava.
   *
   * O critério é `remoteDescription`: enquanto ela for `null`, o outro lado não respondeu
   * nada, e é indistinguível daqui se ele não recebeu a oferta ou não quis responder. Nos
   * dois casos repetir é a única ação disponível, e repetir é barato. Assim que a resposta
   * entra, o par sai desta lista para sempre.
   *
   * Continua valendo a regra anti-glare: **só o iniciador oferta**. O outro lado não tem o
   * que repetir — se a oferta não chegou, não há resposta a refazer.
   */
  #tentarNegociacoesParadas(): void {
    let pendentes = 0;
    for (const [parHex, p] of this.#pares) {
      if (!souOIniciador(this.#euHex, parHex)) continue;
      if (p.pc.remoteDescription !== null) continue; // já respondeu: nada a refazer
      const estado = p.pc.connectionState;
      if (estado === "connected" || estado === "closed" || estado === "failed") continue;
      // Sem ticket ainda não se oferta (§17.4 passo 4) — mas ainda é pendência: é ESTE lado
      // que está esperando a renovação, e desarmar aqui deixaria a repetição fora do ar
      // justamente no caso que ela existe para cobrir.
      pendentes++;
      if (!this.#autorizados.has(parHex)) continue;
      log(`par ${parHex.slice(0, 8)} · sem resposta — repetindo a oferta`);
      void this.#ofertar(parHex, p).then(() => this.#reenviarCandidatosLocais(parHex, p));
    }
    // Nada mais a repetir: o relógio para até uma negociação nova precisar dele.
    if (pendentes === 0) this.#desarmarRetentativa();
  }

  /**
   * Reenvia os candidatos já coletados. Repetido é inofensivo — o outro lado descarta o que
   * já conhece —, e ausente é fatal: sem endereço não há par para o ICE testar.
   */
  async #reenviarCandidatosLocais(parHex: string, par: Par): Promise<void> {
    if (par.candidatosLocais.length === 0) return;
    log(`par ${parHex.slice(0, 8)} · reenviando ${par.candidatosLocais.length} candidato(s)`);
    for (const c of par.candidatosLocais) {
      await this.#porta
        .signal({ peerKey: parHex, ticketId: par.ticketId, ice: JSON.stringify(c) })
        .catch((e) => {
          log(`par ${parHex.slice(0, 8)} · candidato reenviado RECUSADO — ${codigoDe(e)}`);
        });
    }
  }

  /** Os candidatos do outro lado que esperavam a descrição remota. */
  async #soltarCandidatosRemotos(parHex: string, par: Par): Promise<void> {
    if (par.candidatosRemotos.length === 0) return;
    const espera = par.candidatosRemotos;
    par.candidatosRemotos = [];
    log(`par ${parHex.slice(0, 8)} · aplicando ${espera.length} candidato(s) represado(s)`);
    for (const c of espera) {
      await par.pc.addIceCandidate(c).catch((e) => {
        // Candidato que o navegador recusa é um endereço a menos, nunca o fim da chamada —
        // mas um erro sem nome é a dúvida que custou caro no smoke de duas máquinas.
        log(`candidato represado RECUSADO — ${codigoDe(e)}`);
      });
    }
  }

  #armarRetentativa(): void {
    if (this.#retentativa !== null) return;
    this.#retentativa = setInterval(() => {
      if (this.#sessionId === null) {
        this.#desarmarRetentativa();
        return;
      }
      this.#tentarNegociacoesParadas();
    }, REPETIR_OFERTA_MS);
  }

  #desarmarRetentativa(): void {
    if (this.#retentativa !== null) clearInterval(this.#retentativa);
    this.#retentativa = null;
  }

  #armarPrazo(): void {
    // O prazo é da CHAMADA, e a chamada existe desde que um par conectou: rearmar a cada
    // par novo do roster fazia a falha de UM par (o terceiro que entrou e não fechou)
    // anunciar `conn-failed` para uma chamada que funciona — a falha de outro par é
    // assimétrica e aparece no tile dele (§9, 2.3).
    if (this.#haParConectado()) return;
    this.#desarmarPrazo();
    this.#prazo = setTimeout(() => {
      this.#prazo = null;
      if (this.#sessionId === null) return;
      if (this.#haParConectado()) return; // alguém conectou enquanto o relógio corria

      // **Esticar UMA vez quando há `turn:` anunciado e o `relay` ainda não apareceu.**
      // Contra um TURN que não responde, o Chromium só desiste do `TurnPort` depois de uma
      // sequência de retransmissões que leva perto de um minuto e meio — muito além destes
      // 20 s. Vencer o prazo aí é declarar `conn-failed` ANTES de o único candidato que
      // poderia salvar a chamada ter tido chance de existir, e é o que tornaria a medida de
      // B4 impossível de fazer honestamente: ela mediria o relógio, não o relay.
      //
      // O default (`P2P_TURN_ANNOUNCE=0`) não paga nada por isto: sem `turn:` na lista não
      // há relay a esperar, e a L-11 continua falhando rápido, em 20 s.
      if (this.#esperandoRelay()) {
        this.#prazoEsticado = true;
        log(`prazo esticado +${PRAZO_EXTRA_COM_TURN_MS / 1000}s — há turn: anunciado e o relay ainda não apareceu`);
        this.#prazo = setTimeout(() => {
          this.#prazo = null;
          this.#veredito();
        }, PRAZO_EXTRA_COM_TURN_MS);
        return;
      }
      this.#veredito();
    }, PRAZO_DE_CONEXAO_MS);
  }

  /**
   * §99.13 — o relógio da fase 1. Vencido sem `srflx`, o terceiro entra.
   *
   * `srflx` é o único sinal que importa: ele É a resposta do STUN. Um candidato `host` não
   * prova nada (ele existe sempre) e `relay` implica `srflx` no caminho.
   */
  #armarPrazoDaFaseUm(): void {
    this.#desarmarPrazoDaFaseUm();
    this.#prazoDaFaseUm = setTimeout(() => {
      this.#prazoDaFaseUm = null;
      if (this.#sessionId === null || this.#faseDoIce === 2) return;
      if (this.#tiposDeCandidato.has("srflx") || this.#tiposDeCandidato.has("relay")) {
        // O host resolveu. É exatamente o que §17.2 prometia: o terceiro NÃO é consultado, e
        // o IP de quem entra na chamada não sai da comunidade.
        log("ICE fase 1 resolveu — o STUN do host respondeu; nenhum terceiro foi consultado (§17.2)");
        return;
      }
      this.#escalarParaFaseDois();
    }, PRAZO_DA_FASE_UM_MS);
  }

  #desarmarPrazoDaFaseUm(): void {
    if (this.#prazoDaFaseUm !== null) clearTimeout(this.#prazoDaFaseUm);
    this.#prazoDaFaseUm = null;
  }

  /**
   * O host não resolveu: a lista inteira entra e o ICE é reconstruído.
   *
   * `setConfiguration` sozinho não coleta nada — a lista nova só vale "for any future
   * renegotiation, such as while handling an ICE restart" (WebRTC 1.0). Por isso vem
   * `restartIce` junto, e a oferta sai do lado iniciador, pela mesma regra anti-glare de
   * `souOIniciador`: os dois reofertando é o *glare* que §17.4 evita.
   */
  #escalarParaFaseDois(): void {
    if (this.#faseDoIce === 2) return;
    this.#faseDoIce = 2;
    const todos = [...this.#todosOsServidores];
    this.#config = { iceServers: todos };
    log(
      `ICE fase 2 — o STUN do host não respondeu em ${PRAZO_DA_FASE_UM_MS / 1000}s; ` +
        `admitindo ${todos.length - (separarPorOrigem(this.#todosOsServidores).doHost.length)} de terceiro (§17.2: eles veem seu IP)`,
    );
    for (const [parHex, par] of this.#pares) {
      try {
        par.pc.setConfiguration({ iceServers: todos });
        par.pc.restartIce();
      } catch (e) {
        log(`par ${parHex.slice(0, 8)} · escalada de ICE falhou — ${codigoDe(e)}`);
        continue;
      }
      if (souOIniciador(this.#euHex, parHex)) void this.#renegociar(parHex, par);
    }
  }

  /** Há `turn:` anunciado, nenhum `relay` coletado e alguma coleta ainda em andamento? */
  #esperandoRelay(): boolean {
    if (this.#prazoEsticado) return false;
    if (this.#tiposDeCandidato.has("relay")) return false;
    const servers = this.#config.iceServers ?? [];
    const temTurn = servers.some((s) => {
      const urls = typeof s.urls === "string" ? [s.urls] : s.urls;
      return urls.some((u) => /^turns?:/i.test(u));
    });
    if (!temTurn) return false;
    for (const [, p] of this.#pares) {
      if (p.pc.iceGatheringState !== "complete") return true;
    }
    return false;
  }

  /** O veredito de L-11, nomeado por `motivoDaFalha` a partir do que o ICE coletou. */
  #veredito(): void {
    if (this.#sessionId === null) return;
    if (this.#haParConectado()) return;
    const servers = this.#config.iceServers ?? [];
    const turnAnunciado = servers.some((s) => {
      const urls = typeof s.urls === "string" ? [s.urls] : s.urls;
      return urls.some((u) => /^turns?:/i.test(u));
    });
    const motivo = motivoDaFalha({
      tipos: this.#tiposDeCandidato,
      familias: this.#familiasDeCandidato,
      turnAnunciado,
    });
    // O log carrega os DOIS eixos porque é ele que a investigação de conectividade lê: o
    // tipo diz que servidor respondeu, a família diz se houve IPv6 — e IPv6 é a travessia
    // de CGNAT que não custa servidor nenhum.
    log(
      `FALHOU [${motivo.codigo}] · candidatos: ${[...this.#tiposDeCandidato].join(", ") || "nenhum"}` +
        ` · famílias: ${[...this.#familiasDeCandidato].join(", ") || "nenhuma"}` +
        ` · turn anunciado: ${turnAnunciado ? "sim" : "não"}`,
    );
    this.#eventos.aoFalhar(motivo.texto);
  }

  /** A chamada já tem UM par com a conexão aberta — o suficiente para ela existir. */
  #haParConectado(): boolean {
    for (const [, p] of this.#pares) {
      if (p.pc.connectionState === "connected") return true;
    }
    return false;
  }

  /**
   * Reconstruir o ICE de um par que CHEGOU A FALHAR (§17.2 — a malha é a chamada; uma
   * conexão morta não encerra a sessão, encerra aquele caminho). `restartIce` marca a
   * reconstrução; a nova negociação sai pelo lado iniciador — a mesma regra de quem manda a
   * oferta, sem a qual os dois reofertam e é glare. No teto de tentativas, a falha fica no
   * tile (o estado `failed` já foi reportado) e a reconstrução desiste.
   */
  #reiniciarPar(parHex: string, par: Par): void {
    if (this.#sessionId === null) return;
    if (par.tentativasDeRestart >= RESTARTS_POR_PAR) {
      log(`par ${parHex.slice(0, 8)} · reconstrução desiste (${par.tentativasDeRestart} tentativas)`);
      return;
    }
    par.tentativasDeRestart++;
    log(`par ${parHex.slice(0, 8)} · reconstruindo o ICE (${par.tentativasDeRestart}/${RESTARTS_POR_PAR})`);
    try {
      par.pc.restartIce();
    } catch (e) {
      log(`par ${parHex.slice(0, 8)} · restartIce falhou`, e);
      return;
    }
    /*
     * **Quem detectou a queda renegocia, iniciador ou não** (correção de 2026-09-05).
     *
     * `restartIce()` sozinho não manda nada pela rede: ele marca a conexão para gerar
     * credenciais ICE novas *na próxima oferta*. Guardando a renegociação por
     * `souOIniciador`, o lado respondedor que percebesse a queda marcava e ficava calado —
     * e a queda é frequentemente assimétrica (só um lado vê `failed`). Três voltas dos 5 s
     * de graça depois, `tentativasDeRestart` batia o teto e a conexão morria sem que uma
     * única oferta tivesse saído.
     *
     * Ofertar dos dois lados aqui **não** reabre o glare que a regra evitava: a colisão de
     * ofertas de RENEGOCIAÇÃO já tem desempate em `aplicarSinal` — o iniciador ignora a
     * oferta cruzada, o outro faz `rollback`, responde e reoferta ao assentar. É a mesma
     * regra determinística, aplicada onde ela é resolvida em vez de onde ela é evitada.
     */
    void this.#renegociar(parHex, par);
  }

  /**
   * `disconnected` é normal num blip curto — o ICE se cura sozinho. Dar-lhe a graça antes de
   * reconstruir, e só reconstruir se o estado persistir (ou já tiver ido a `failed`).
   */
  #agendarRestart(parHex: string, par: Par): void {
    if (par.reinicioAgendado !== null) return;
    par.reinicioAgendado = setTimeout(() => {
      par.reinicioAgendado = null;
      const estado = par.pc.connectionState;
      if (estado === "disconnected" || estado === "failed") this.#reiniciarPar(parHex, par);
    }, GRACA_DE_DESCONECTADO_MS);
  }

  /** O par voltou: o contador e o relógio da graça voltam ao zero. */
  #descartarRestart(par: Par): void {
    par.tentativasDeRestart = 0;
    if (par.reinicioAgendado !== null) {
      clearTimeout(par.reinicioAgendado);
      par.reinicioAgendado = null;
    }
  }

  #desarmarPrazo(): void {
    if (this.#prazo !== null) clearTimeout(this.#prazo);
    this.#prazo = null;
  }

  /**
   * O par selecionado desta conexão passa por relay? Lido do `RTCStatsReport`, que é onde a
   * decisão do ICE aparece — `candidate-pair` com `state: 'succeeded'` e `nominated`, e os
   * dois candidatos que ele referencia.
   *
   * Antes da negociação assentar não há par selecionado, e a resposta é `false`: recusar
   * por não saber ainda seria trocar o defeito de "a tela sobe por TURN" pelo de "a tela
   * nunca sobe".
   */
  async #viaRelay(par: Par): Promise<boolean> {
    let relatorio: RTCStatsReport;
    try {
      relatorio = await par.pc.getStats();
    } catch {
      return false;
    }
    const candidatos = new Map<string, string>();
    let selecionado: { local?: string; remoto?: string } | null = null;
    relatorio.forEach((entrada) => {
      const s = entrada as RTCStats & Record<string, unknown>;
      if (s.type === "local-candidate" || s.type === "remote-candidate") {
        const tipo = s["candidateType"];
        if (typeof tipo === "string") candidatos.set(s.id, tipo);
        return;
      }
      if (s.type !== "candidate-pair") return;
      // `nominated` é o que o ICE marca quando escolhe; `succeeded` sozinho pode descrever
      // um par que passou na verificação mas não foi o escolhido.
      if (s["state"] !== "succeeded" || s["nominated"] !== true) return;
      const local = s["localCandidateId"];
      const remoto = s["remoteCandidateId"];
      selecionado = {
        ...(typeof local === "string" ? { local } : {}),
        ...(typeof remoto === "string" ? { remoto } : {}),
      };
    });
    if (selecionado === null) return false;
    const par2 = selecionado as { local?: string; remoto?: string };
    // Relay de QUALQUER um dos lados: nos dois casos os bytes atravessam um TURN.
    for (const id of [par2.local, par2.remoto]) {
      if (id !== undefined && candidatos.get(id) === "relay") return true;
    }
    return false;
  }

  #fechar(parHex: string): void {
    const p = this.#pares.get(parHex);
    if (p === undefined) return;
    this.#pares.delete(parHex);
    p.resolverProntas?.();
    if (p.reinicioAgendado !== null) {
      clearTimeout(p.reinicioAgendado);
      p.reinicioAgendado = null;
    }
    try {
      p.pc.close();
    } catch {
      // Fechar duas vezes não é erro que interesse a ninguém.
    }
    this.#eventos.aoMudarPar(parHex, "closed");
  }
}

/** O código nomeado de uma recusa do núcleo (§20.2) — para o log, não para inventar texto. */
function codigoDe(e: unknown): string {
  const c = (e as { code?: string } | null)?.code;
  return typeof c === "string" ? c : "sem código";
}

/**
 * O motivo, em português, de um microfone que não ligou — §20.1 ("o texto em português é do
 * renderer") com o vocabulário de `RT-10`/`E_DEVICE_BLOCKED` (§15.5 `voice.deviceError`).
 *
 * É o espelho de `motivoDoErroDeCamera` (`live/camera.ts`): a captura do MIC acontece em
 * `entrar`, depois do `voice.join` ACEITO — e o erro que ela lança precisa de um desfecho
 * nomeado, não da frase genérica de conexão. Sem isto, "o sistema negou o microfone" e "o
 * host recusou a entrada" contavam a mesma história errada.
 */
export function motivoDoErroDeMicrofone(e: unknown): string {
  const nome = (e as { name?: string } | null)?.name ?? "";
  if (nome === "NotAllowedError" || nome === "SecurityError") {
    return "O sistema não autorizou o acesso ao microfone.";
  }
  if (nome === "NotFoundError" || nome === "OverconstrainedError") {
    return "O microfone escolhido não está mais disponível.";
  }
  if (nome === "NotReadableError" || nome === "AbortError") {
    return "O microfone está em uso por outro aplicativo.";
  }
  return "Não foi possível ligar o microfone.";
}

/**
 * Leitura crua de UM envio, a partir do `RTCStatsReport` (§17.5: "obtidos de
 * `RTCStatsReport` no renderer do apresentador").
 *
 * A perda vem do relatório do RECEPTOR que o par nos devolve (`remote-inbound-rtp`): é ele
 * que sabe quantos pacotes faltaram. `outbound-rtp` conta o que saiu daqui, e o que saiu
 * daqui nunca se perdeu do ponto de vista de quem enviou.
 *
 * Os contadores saem **acumulados**, como o WebRTC os entrega; transformá-los em taxa do
 * intervalo é de quem guarda a leitura anterior (`enviarTrilha`).
 */
export function leituraDeSaida(
  relatorio: RTCStatsReport,
): { rttMs: number; perdidosAcumulados: number; enviadosAcumulados: number } | null {
  let rttMs: number | null = null;
  let perdidos: number | null = null;
  let enviados: number | null = null;

  relatorio.forEach((entrada) => {
    const s = entrada as RTCStats & Record<string, unknown>;
    if (s.type === "remote-inbound-rtp") {
      if (typeof s["roundTripTime"] === "number") rttMs = s["roundTripTime"] * 1000;
      if (typeof s["packetsLost"] === "number") perdidos = s["packetsLost"];
    }
    if (s.type === "outbound-rtp" && typeof s["packetsSent"] === "number") {
      enviados = s["packetsSent"];
    }
  });

  if (rttMs === null && perdidos === null) return null;
  return {
    rttMs: rttMs ?? 0,
    perdidosAcumulados: perdidos ?? 0,
    enviadosAcumulados: enviados ?? 0,
  };
}
