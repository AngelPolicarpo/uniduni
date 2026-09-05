// §17.3 — o serviço STUN/TURN do host, montado sobre a socket que o UDX já usa.
//
// Uma instalação tem UMA socket (§17.3) e pode hospedar VÁRIAS comunidades, cada uma com o
// seu `hostTurnSecret` (§5.2 deriva por comunidade). Este módulo é o que reconcilia as duas
// coisas: um `MediaServer` por processo, e um registro de sessões de voz que diz, para cada
// `sessionId` que chega numa credencial TURN, de qual comunidade ela é.
//
// **A ponte par→endereço, que era o que faltava (B27, fechado em 2026-08-28).** §17.3 manda
// permitir só endereços de pares do roster daquela sessão, e o roster de `voiceCoordinator`
// guarda **chaves**. A ponte tem duas pernas, e as duas são necessárias:
//
//   1. **O transporte.** `SwarmConnection.remoteAddress` é o IP de onde o par abriu a
//      conexão autenticada pelo Noise — o mesmo que §12.6 já usa para a metade por /24 do
//      rate limit pré-membro. Chave → IP, de graça, para todo par conectado.
//   2. **O próprio TURN.** Um Allocate/Refresh que fecha o MESSAGE-INTEGRITY prova que
//      aquela chave está naquele IP **agora**. Cobre o par cujo tráfego de mídia sai por um
//      IP diferente do da conexão do DHT (operadora com pool de saída, máquina com duas
//      WANs) — caso em que a perna (1) daria o IP errado e a permissão seria negada.
//
// A união das duas é o conjunto de IPs da sessão. Por **IP**, não por `host:port`: RFC 5766
// §9 ignora a porta na permissão, e é o que torna a ponte possível — a porta de origem do
// `RTCPeerConnection` é de outra socket, com outro mapeamento NAT, e o host não tem como
// sabê-la.

import { MediaServer, type MediaAddr, type RelayPort } from '../l2/communityHost/stunTurn.ts';
import type { MediaSocketTap } from '../l0/swarm/ports.ts';
import type { IceServer } from '../l2/voiceCoordinator/index.ts';
import { resolveConfig } from '../l0/config/index.ts';
import { abrirPortaDeRelay, RELAY_PRIMER } from './relayPort.ts';

/**
 * Quem é o roster de uma sessão que este nó serve. Porta mínima, e não `VoiceHostSessions`,
 * desde §109: §31.15 manda o serviço de §17.3 valer **por nó** numa conversa direta, e ali
 * não existe `voiceCoordinator` nenhum — o roster de uma chamada de dois é a própria
 * conversa. O `MediaServer` sempre consumiu só este método; declará-lo é o que deixa a
 * conversa direta se registrar sem inventar uma comunidade de mentira para carregá-la.
 */
export type RosterDeSessao = {
  participantKeys(sessionId: string): ReadonlySet<string>;
};

type ComunidadeHospedada = {
  /** O escopo do serviço: `communityId` (§17.3) ou `conversationId` (§31.15). */
  readonly communityId: string;
  readonly voice: RosterDeSessao;
  readonly turnSecret: Buffer;
};

/**
 * Perna (1) da ponte: o que o transporte observou. Porta, e não import, porque
 * `CommunityTransport` nasce depois do `MediaHost` e a direção real é composição → os dois.
 */
export type EnderecosObservadosPort = {
  /** IP público de onde o par abriu conexão, ou `null` se ele não está conectado. */
  ipDoPar(peerKeyHex: string): string | null;
};

export type MediaHostOptions = {
  readonly stunDeTerceiros?: readonly string[];
  readonly enderecos?: EnderecosObservadosPort;
  /** §17.3 — anunciar o `turn:` do host. Default: o da config (`P2P_TURN_ANNOUNCE`). */
  readonly anunciaTurn?: boolean;
  /**
   * §27.2 — os controles operacionais do TURN. Default: os da config (`P2P_TURN_*`).
   * Antes eram lidos na config e jogados fora: ajustá-los por ambiente não tinha efeito
   * nenhum, e o default de §27.2 continuava valendo por coincidência.
   */
  readonly turnKnobs?: {
    readonly allocTtlMs: number;
    readonly maxAllocsPerMember: number;
    readonly rateKbps: number;
    readonly sessionMaxBytes: number;
  };
};

/**
 * O serviço de mídia do processo. Nasce com a socket; as comunidades hospedadas se
 * registram conforme abrem, e saem quando fecham.
 */
export class MediaHost {
  readonly #tap: MediaSocketTap;
  readonly #hospedadas = new Map<string, ComunidadeHospedada>();
  readonly #server: MediaServer;
  readonly #desinstalar: () => void;

  readonly #terceiros: readonly string[];
  #enderecos: EnderecosObservadosPort | null;
  /** §17.3 — anunciar o TURN do host em `iceServers`. Ver `iceServers()` para o porquê do não. */
  readonly #anunciaTurn: boolean;
  /** Perna (2): `sessionId` → `peerKeyHex` → IP provado por MESSAGE-INTEGRITY. */
  readonly #observados = new Map<string, Map<string, string>>();

  constructor(tap: MediaSocketTap, realm: string, opts: MediaHostOptions | readonly string[] = {}) {
    // A forma antiga (terceiro parâmetro = lista de STUN) continua aceita: é o que a suíte
    // de §17.2 usa para isolar o `iceServers` do host do de terceiro.
    const o: MediaHostOptions = Array.isArray(opts) ? { stunDeTerceiros: opts as readonly string[] } : (opts as MediaHostOptions);
    this.#terceiros = o.stunDeTerceiros ?? resolveConfig().stunServers;
    this.#enderecos = o.enderecos ?? null;
    this.#anunciaTurn = o.anunciaTurn ?? resolveConfig().turnAnnounce;
    const cfg = resolveConfig();
    const knobs = o.turnKnobs ?? {
      allocTtlMs: cfg.turnAllocTtlMs,
      maxAllocsPerMember: cfg.turnAllocPerMember,
      rateKbps: cfg.turnRateKbps,
      sessionMaxBytes: cfg.turnSessionMaxBytes,
    };
    this.#tap = tap;
    this.#server = new MediaServer({
      realm,
      hostTurnSecret: (sessionId) => this.#daSessao(sessionId)?.turnSecret ?? null,
      socket: { send: (d, a) => tap.send(d, a) },
      // O endereço relayado de uma alocação é de uma socket NOVA, e o mapeamento externo
      // dela não é o do DHT. Ver `relayPort.ts` para a lacuna de §17.3 e a decisão.
      openRelayPort: () => abrirPortaDeRelay({ stunServers: this.#terceiros }),
      sessionPeerKeys: (sessionId) => this.#daSessao(sessionId)?.voice.participantKeys(sessionId) ?? new Set<string>(),
      rosterAddresses: (sessionId) => this.ipsDaSessao(sessionId),
      primeRelayTo: (relay: RelayPort, peer: MediaAddr) => relay.send(RELAY_PRIMER, peer),
      allocTtlMs: knobs.allocTtlMs,
      maxAllocsPerMember: knobs.maxAllocsPerMember,
      rateKbps: knobs.rateKbps,
      sessionMaxBytes: knobs.sessionMaxBytes,
      onPeerObserved: (sessionId, peerKeyHex, addr) => {
        let porSessao = this.#observados.get(sessionId);
        if (porSessao === undefined) {
          // O mapa é índice por SESSÃO de voz, e sessão é entidade efêmera (§6.16): sem
          // poda, cada sessão morta acumulava entradas para sempre num host de longa
          // duração — o acumulador silencioso de B17. Podar ao criar a próxima entrada é
          // O(1) amortizado e dispensa cadência nova.
          this.#podarSessoesMortas();
          porSessao = new Map();
          this.#observados.set(sessionId, porSessao);
        }
        porSessao.set(peerKeyHex, addr.host);
      },
    });
    this.#desinstalar = tap.tap((data, from) => {
      // `udx` volta ao dono da socket; STUN e dados de canal foram consumidos aqui.
      return this.#server.handleDatagram(data, { host: from.host, port: from.port }) !== 'udx';
    });
  }

  /** Perna (1) da ponte, ligada depois do boot: o transporte nasce depois deste objeto. */
  ligarEnderecos(port: EnderecosObservadosPort): void {
    this.#enderecos = port;
  }

  registrar(c: ComunidadeHospedada): void {
    this.#hospedadas.set(c.communityId, c);
  }

  esquecer(communityId: string): void {
    this.#hospedadas.delete(communityId);
  }

  /**
   * O que `voice.join` entrega ao renderer (§17.4). Sem endereço público observado a lista
   * vai vazia — e vazia é honesto: o WebRTC junta só candidato de host e a chamada fecha
   * apenas em rede local. Anunciar um `0.0.0.0` seria pior do que não anunciar nada.
   *
   * **O `turn:` NÃO é anunciado por padrão, e isto é uma correção de 2026-08-28.**
   *
   * **Emenda de 2026-08-30 (§99) — metade da causa registrada abaixo não se sustenta.** A
   * releitura do renderer desmente "cada repetição reinicia o ICE antes de ele convergir":
   * `#tentarNegociacoesParadas` chama `createOffer()` **sem** `iceRestart`, na MESMA
   * `RTCPeerConnection`, e uma oferta assim reusa o par ufrag/pwd — ela não reinicia coleta
   * nenhuma. A malha também é trickle desde sempre (`onicecandidate` sinaliza cada candidato
   * na hora), então a coleta inacabada nunca segurou a oferta.
   *
   * O que a releitura CONFIRMA é a outra metade, e ela basta: contra um TURN que não
   * responde o Chromium só desiste do `TurnPort` depois de perto de um minuto e meio de
   * retransmissões, enquanto `PRAZO_DE_CONEXAO_MS` do renderer vencia em 20 s. O produto
   * declarava `conn-failed` antes de o `relay` ter tido chance de existir. O renderer passa
   * a esticar o prazo uma vez quando há `turn:` anunciado e o `relay` ainda não apareceu
   * (`PRAZO_EXTRA_COM_TURN_MS`) — sem isso a medida de `B4` mediria o relógio, não o relay.
   *
   * O default segue `false` porque o caminho relayado continua **não medido em rede real**
   * (`B4`), não porque anunciá-lo seja sabidamente destrutivo. O registro original:
   * o Chromium abre um `TurnPort` contra o endereço
   * anunciado e o mantém retentando enquanto o Allocate não fecha. Enquanto ele retenta, a
   * **coleta de candidatos não termina**. Medido no log de uma chamada real: nove candidatos locais (host e
   * srflx), nenhum `relay`, `coleta de candidatos terminada` nunca, e `failed` no fim — numa
   * chamada que fechava antes do anúncio.
   *
   * A causa de fundo é a mesma que §17.3 já declara em nota: o endereço relayado sai de uma
   * socket NOVA, e que ele seja alcançável de fora depende de um NAT que ninguém mediu. O
   * caminho existe, tem teste de loopback ponta a ponta, e **não foi medido em rede real**
   * (`B4`). Anunciá-lo era exatamente o que `CLAUDE.md` proíbe: oferecer o que ainda não foi
   * medido — só que aqui o custo não é uma promessa errada na tela, é a chamada não fechar.
   *
   * `P2P_TURN_ANNOUNCE=1` liga o anúncio para quem for medir. Quando a medida existir, o
   * default vira o valor medido, e esta nota vira registro.
   */
  iceServers(): readonly IceServer[] {
    const addr = this.#tap.publicAddress();
    const doHost: IceServer[] =
      addr === null
        ? []
        : [
            { urls: `stun:${addr.host}:${addr.port}` },
            // O `turn:` sai no MESMO endereço do `stun:` porque §17.3 põe os dois na mesma
            // socket, e **sem credencial**: quem a tem é a sessão, e é `voiceJoin` que a
            // costura (§17.3 — `turnCredential` é de curta duração e amarrada ao par).
            ...(this.#anunciaTurn ? [{ urls: `turn:${addr.host}:${addr.port}?transport=udp` }] : []),
          ];
    // §17.2 — o do host vem primeiro, e **a ordem não é garantia de privacidade nenhuma**.
    //
    // A emenda de 2026-08-25 ligou o STUN de terceiro por default apoiada em três guardas, e
    // a primeira delas era: "o ICE tenta em ordem; quando o do host resolve, o de terceiro
    // não é consultado e o IP não sai da comunidade". O libwebrtc não se comporta assim.
    // `UDPPort::SendStunBindingRequests()` percorre `server_addresses_` mandando um Binding
    // Request para CADA servidor configurado, e `ServerAddresses` é
    // `std::set<rtc::SocketAddress>` — a ordem deste array é descartada na entrada. RFC 8445
    // §5.1.1.2: "the agent pairs each host candidate with the STUN or TURN servers with
    // which it is configured or has discovered by some means". Não há curto-circuito.
    //
    // A consequência é de política, não de código: com um terceiro na lista, ele vê o IP de
    // quem entra em chamada SEMPRE — inclusive quando o host responde primeiro. A ordem
    // segue aqui porque um servidor mais próximo responde antes e o par é testado antes;
    // o que ela não faz é impedir a consulta.
    //
    // **A garantia foi devolvida por outro caminho (§99.13):** quem a entrega é a coleta em
    // DUAS FASES do renderer — ele monta a primeira `RTCPeerConnection` só com o que NÃO
    // está marcado `terceiro`, e só reconfigura com o resto (`setConfiguration` +
    // `restartIce`) se nenhum `srflx` aparecer no prazo. Aí sim o terceiro não é consultado
    // quando o host resolve. Por isso a marca existe: posição não identifica o host, porque
    // `doHost` é vazio sob L-11 e o terceiro passa a ser `servers[0]`.
    return [...doHost, ...this.#terceiros.map((urls) => ({ urls, terceiro: true }))];
  }

  /** §17.2 "com aviso" — a tela precisa saber que um terceiro está no caminho. */
  get usaStunDeTerceiros(): boolean {
    return this.#terceiros.length > 0;
  }

  /**
   * §15.4 `diag.run` — há caminho relayado servível aqui? (`relayAvailable`, B11).
   *
   * Servível é o que este nó **consegue** fazer: endereço público observado e STUN para
   * descobrir o mapeamento da porta relayada. Não depende do anúncio: `diag.run` diz o que a
   * máquina tem, e o anúncio é política de §17.3.
   */
  get servindoRelay(): boolean {
    return this.#tap.publicAddress() !== null && this.#terceiros.length > 0;
  }

  get counters(): MediaServer['counters'] {
    return this.#server.counters;
  }

  /**
   * §22.1 `media.sweep` — a varredura de alocações do TURN, que **nunca teve chamador**.
   * `MediaServer.sweep` existia com teste que o chamava direto, e nada na composição o
   * agendava: alocação vencida vazava a socket relayada até o fim do processo, e o cliente
   * cujo 5-tuple ficou preso a um registro morto levava 437 até o host reiniciar.
   */
  sweep(): number {
    return this.#server.sweep();
  }

  /**
   * §17.4 — a revogação alcança o transporte relayado. Chamada pela composição no mesmo
   * `onRevoked` que emite `voice.revoked`: sem ela o banido seguia recebendo e mandando
   * mídia pelo relay do host até a alocação vencer sozinha.
   */
  revogar(peerKeyHex: string): number {
    return this.#server.revoke(peerKeyHex);
  }

  close(): void {
    this.#desinstalar();
    this.#server.close();
    this.#observados.clear();
    this.#hospedadas.clear();
  }

  /**
   * A união das duas pernas da ponte — é o que §17.3 chama de "endereços de pares presentes
   * no roster daquela sessão". Público porque é o conjunto que decide se o caminho relayado
   * abre ou não, e ficar invisível foi o que deixou B27 aberto sem ninguém notar.
   */
  ipsDaSessao(sessionId: string): ReadonlySet<string> {
    const ips = new Set<string>();
    const c = this.#daSessao(sessionId);
    if (c !== null) {
      for (const peerKeyHex of c.voice.participantKeys(sessionId)) {
        const ip = this.#enderecos?.ipDoPar(peerKeyHex) ?? null;
        if (ip !== null) ips.add(ip);
      }
    }
    // Perna (2). Filtrada pelo roster VIVO: quem saiu da sessão perde a permissão junto,
    // que é o que §17.4 exige da revogação — o endereço observado não pode sobreviver a ela.
    const roster = c?.voice.participantKeys(sessionId);
    for (const [peerKeyHex, ip] of this.#observados.get(sessionId) ?? []) {
      if (roster?.has(peerKeyHex) === true) ips.add(ip);
    }
    return ips;
  }

  #daSessao(sessionId: string): ComunidadeHospedada | null {
    for (const c of this.#hospedadas.values()) {
      if (c.voice.participantKeys(sessionId).size > 0) return c;
    }
    return null;
  }

  /** Sessões cujo `sessionId` nenhuma comunidade hospedada conhece mais — aposentadas. */
  #podarSessoesMortas(): void {
    for (const sessionId of [...this.#observados.keys()]) {
      if (this.#daSessao(sessionId) === null) this.#observados.delete(sessionId);
    }
  }
}
