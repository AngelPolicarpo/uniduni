/**
 * §17.5 — a resolução da fonte de captura, isolada do resto do main.
 *
 * Mora num arquivo próprio por um motivo prático: `main/index.ts` roda `app.whenReady()` e
 * abre janela ao ser importado, então nada nele é exercitável fora de um app inteiro. Estas
 * duas decisões — **qual fonte** e **que áudio** — são justamente as que o smoke de captura
 * (`scripts/smoke-captura.mjs`) precisa exercitar contra o código de verdade, e não contra
 * uma cópia que pode divergir sem ninguém notar.
 */

export type TipoDeFonte = 'screen' | 'window';

/** O mínimo de `Electron.DesktopCapturerSource` que a escolha usa. */
export interface FonteCapturavel {
  readonly id: string;
  readonly name: string;
}

/**
 * A fonte que a captura deve usar, dada a lista VIVA e o id que o renderer declarou.
 *
 * `null` é "a primeira do tipo" — o caminho de quem chama sem passar pelo seletor, e o
 * único lugar onde `fontes[0]` continua sendo resposta legítima. Com um id declarado, é
 * ele ou nada: um id que não está na lista significa que aquela janela fechou entre a
 * escolha e a captura, e substituí-la pela primeira disponível transmitiria uma janela que
 * ninguém escolheu — o defeito de origem, só que mais tarde.
 */
/**
 * O tipo REAL de uma fonte, lido do `id` que o Chromium dá (`screen:0:0`, `window:12345:0`).
 *
 * Existe por causa do Wayland: ali a lista é a escolha da pessoa na caixa do portal, e ela
 * pode não ser do tipo que o renderer declarou. Quem decide o áudio (§17.5: loopback só para
 * tela) precisa perguntar à fonte concedida, não à declaração. `null` é um `id` que não
 * segue a convenção — o chamador cai no tipo declarado, que é o que se sabia antes.
 */
export function tipoDaFonte(id: string): TipoDeFonte | null {
  if (id.startsWith('screen:')) return 'screen';
  if (id.startsWith('window:')) return 'window';
  return null;
}

export function resolverFonte<T extends FonteCapturavel>(
  fontes: readonly T[],
  sourceId: string | null,
): T | undefined {
  if (sourceId === null) return fontes[0];
  return fontes.find((f) => f.id === sourceId);
}

/**
 * O áudio da captura, e o que este produto tem permissão de prometer sobre ele.
 *
 * O Electron expõe **um** botão: `audio: 'loopback'`. Não existe nesta API um "áudio
 * daquela janela" que o main possa pedir — quem sabe separar por janela é o Chromium, e o
 * pedido vai pelo lado do renderer (`windowAudio: 'window'` + `systemAudio: 'exclude'` no
 * `getDisplayMedia`, ver `frontend/src/live/sincronizacao.ts`). O main concede a captura de
 * áudio; o renderer é quem diz de onde ela pode vir.
 *
 * **Emenda de 2026-09-03 — o loopback também existe no Linux.** A documentação do Electron
 * ainda diz "currently only supported on Windows", e foi por acreditar nela que este ramo
 * negava o som fora do Windows. O código não concorda com a própria documentação: em
 * `shell/browser/electron_browser_context.cc` (Electron 43), o `'loopback'` devolvido pelo
 * `setDisplayMediaRequestHandler` vira um dispositivo de id `"loopback"` **sem nenhum
 * `#if` de plataforma** — o único condicional ali é o de `restrict_own_audio`, e o ramo
 * `#else` (Linux) segue com `kLoopbackInputDeviceId`. Do outro lado,
 * `AudioManagerPulse::MakeInputStream` (Chromium 150) reconhece esse id e abre o
 * `PulseLoopbackManager`, que captura **o monitor do sink padrão** e ainda acompanha a
 * troca de saída de áudio no meio da sessão. É o mesmo som que §17.5 item 7 tentava
 * alcançar à mão — pela porta que o Chromium mantém aberta, em vez da que ele fecha.
 *
 * **Por que só `screen`.** O loopback é o som da MÁQUINA; não há recorte por janela nesse
 * caminho. Concedê-lo a uma captura de `window` entregaria o sistema inteiro a quem pediu
 * uma janela — captura a mais do que a pessoa autorizou, que é pior que captura muda. No
 * Windows o Chromium sabe separar por janela a partir do pedido do renderer
 * (`windowAudio: 'window'`), e por isso lá os dois tipos continuam valendo.
 *
 * Onde não há loopback (macOS, fora do v1), conceder entregaria uma sessão sem trilha de
 * áudio e uma UI dizendo que há som. Não conceder é o que deixa a tela dizer a verdade.
 */
export function audioDaCaptura(
  kind: TipoDeFonte,
  pedido: boolean,
  plataforma: NodeJS.Platform = process.platform,
): 'loopback' | undefined {
  if (!pedido) return undefined;
  if (plataforma === 'win32') return 'loopback';
  if (plataforma === 'linux') return kind === 'screen' ? 'loopback' : undefined;
  return undefined;
}

/**
 * **Este sistema tem seletor de fonte próprio e OBRIGATÓRIO?**
 *
 * No Wayland, enumerar telas e janelas não é uma leitura: é um pedido de permissão. Quem
 * responde é o `xdg-desktop-portal`, e a resposta É a escolha da pessoa — a caixa que diz
 * "o app quer compartilhar sua tela". Não há como listar sem perguntar, e não há como
 * perguntar sem que a pessoa escolha ali.
 *
 * Isso torna o seletor do produto impossível de sustentar nesse caminho, e o defeito não
 * era cosmético: o seletor listava (portal #1), a pessoa escolhia na NOSSA lista, e o
 * handler relistava para validar (portal #2) — a caixa do sistema aparecia duas vezes, e o
 * `id` da primeira sessão do portal não existia na segunda, então `resolverFonte` recusava
 * e a captura **nunca** subia no Wayland.
 *
 * O sinal é o ambiente, e é o que a plataforma dá: `WAYLAND_DISPLAY` (ou `XDG_SESSION_TYPE`)
 * é o que distingue "o portal manda aqui" de X11, onde `getSources` continua sendo leitura
 * e o seletor do produto continua sendo a única escolha real que existe.
 */
export function seletorDoSistema(
  plataforma: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (plataforma !== 'linux') return false;
  // `XDG_SESSION_TYPE` é a declaração da própria sessão e tem a última palavra nos dois
  // sentidos: `x11` explícito vence um `WAYLAND_DISPLAY` que ficou no ambiente (um
  // compositor rodando ao lado, ou um `xvfb-run` que herdou o env do shell), e é o que
  // impede o seletor do produto de sumir de uma sessão X11 onde ele funciona.
  const tipo = env['XDG_SESSION_TYPE'];
  if (tipo === 'wayland') return true;
  if (tipo === 'x11') return false;
  // Sem declaração — o caso do WSLg, que não a define — sobra o socket do compositor.
  return (env['WAYLAND_DISPLAY'] ?? '') !== '';
}

/**
 * O que ESTA plataforma faz com captura — as duas perguntas que o seletor precisa responder
 * antes de desenhar qualquer coisa: se há áudio para oferecer, e de quem é a escolha da
 * fonte. As duas viajam juntas porque são feitas no mesmo instante (a abertura do seletor)
 * e um segundo round-trip por um booleano seria pior.
 */
export function suporteDeCaptura(
  plataforma: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): {
  screen: boolean;
  window: boolean;
  platform: string;
  systemPicker: boolean;
} {
  return {
    screen: audioDaCaptura('screen', true, plataforma) !== undefined,
    window: audioDaCaptura('window', true, plataforma) !== undefined,
    platform: plataforma,
    systemPicker: seletorDoSistema(plataforma, env),
  };
}

/**
 * §17.5/`T-41` — **a porta única da captura de tela**, como função de produto.
 *
 * Ela morava dentro do `setDisplayMediaRequestHandler` em `main/index.ts`, e por isso não
 * tinha como ser exercitada: o `smoke:captura` chamava `resolverFonte` e reimplementava o
 * resto, então a regra que importa — **quem concede o som é o núcleo, não a declaração do
 * renderer** (§15.7, emenda de 2026-09-03) — vivia num trecho que nenhum teste alcançava.
 * A mutação que faz o main voltar a obedecer o renderer passava em tudo (§114.5).
 *
 * Agora o handler real e o smoke chamam **esta** função, com o núcleo injetado. É a mesma
 * disciplina de `resolverFonte`: o smoke exercita a função do produto, nunca uma cópia dela.
 */
export interface DeclaracaoDeCaptura {
  kind: TipoDeFonte;
  sourceId: string | null;
  audio: boolean;
  /** §17.5 (emenda de 2026-08-28) — `music` é o Modo Música: sem seletor, tela + loopback. */
  mode?: 'share' | 'music';
}

export interface DecisaoDoNucleo {
  allowed: boolean;
  sourceTypes: readonly string[];
  /** §15.7 (emenda de 2026-09-03) — o som **concedido**, que não é o som pedido. */
  audio: boolean;
}

export interface PortasDaCaptura {
  /** A sessão que o renderer declarou; `null` é falha fechada (§17.5). */
  sessaoDeclarada(): string | null;
  declaracao(): DeclaracaoDeCaptura;
  perguntarAoNucleo(sessionId: string, kind: 'screen' | 'music', audio: boolean): Promise<DecisaoDoNucleo>;
  getSources(opts: { types: string[] }): Promise<Electron.DesktopCapturerSource[]>;
  seletorDoSistema(): boolean;
  /**
   * A plataforma, injetável pelo mesmo motivo que em `seletorDoSistema` e `audioDaCaptura`:
   * o loopback só existe no Windows, e sem poder declará-lo o smoke não distingue "o núcleo
   * negou o som" de "esta máquina não tem loopback" — os dois dariam captura muda.
   */
  plataforma?(): NodeJS.Platform;
}

type Concessao = { video?: Electron.DesktopCapturerSource; audio?: 'loopback' };

/**
 * Atende UM pedido de `getDisplayMedia`. Falha fechada em todos os ramos: sem sessão
 * declarada, sem núcleo, sem decisão dentro do prazo ou sem fonte disponível, nega.
 */
export function atenderPedidoDeCaptura(
  deps: PortasDaCaptura,
  callback: (c: Concessao) => void,
): void {
  const declarada = deps.declaracao();
  // O callback do handler é de USO ÚNICO — o segundo chamamento quebra o processo com
  // "One-time callback was called more than once", e o lançamento dentro do `.catch`
  // vira rejeição não tratada (foi exatamente o relato do smoke no Linux: a recusa do
  // Modo Música respondia, a cadeia rejeitava depois, e o catch tentava responder de
  // novo). O invólucro garante UM desfecho por pedido — e o aviso nomeia o ramo que
  // tentou o segundo, que é o diagnóstico do intercalamento que o produziu.
  let respondeu = false;
  const responder = (ramo: string, valor: Concessao): void => {
    if (respondeu) {
      console.warn(`[main] captura: segundo desfecho descartado (callback já respondido) · ramo '${ramo}'`);
      return;
    }
    respondeu = true;
    callback(valor);
  };
  const sessionId = deps.sessaoDeclarada();
  if (sessionId === null) {
    console.warn('[main] getDisplayMedia sem sessão declarada — captura NEGADA (§17.5)');
    responder('sem-sessao', {});
    return;
  }
  void deps.perguntarAoNucleo(
    sessionId,
    declarada.mode === 'music' ? 'music' : 'screen',
    declarada.mode === 'music' ? true : declarada.audio,
  )
    .then(async (decisao) => {
      if (!decisao.allowed) {
        console.warn(`[main] captura NEGADA pelo núcleo para a sessão ${sessionId.slice(0, 8)}`);
        responder('nucleo-negou', { video: undefined });
        return;
      }
      // **Modo Música (§17.5, emenda de 2026-08-28)** — um clique, sem seletor: a fonte
      // é a tela primária e o que interessa é o áudio loopback. Sem loopback este ramo
      // nega — conceder vídeo mudo seria mentir. A recusa é NOMEADA e o renderer a
      // mostra ("Modo Música indisponível nesta plataforma"). Desde a emenda de
      // 2026-09-03 o Windows não é mais o único lugar onde o loopback existe: o Linux
      // entra por aqui também (ver `audioDaCaptura`), e o item 7 de §17.5 deixou de ser
      // o caminho da plataforma para ser último recurso.
      if (declarada.mode === 'music') {
        // O Modo Música **é** som: sem áudio concedido pelo núcleo não há o que
        // transmitir — subir "mudo" aqui seria o oposto do desfecho honesto de §17.5
        // para a tela (lá a imagem vale sem o som; aqui o som é o produto). É a mesma
        // disciplina da conjunção de §115.3, lida para o caso em que o som é tudo.
        if (!decisao.audio) {
          console.warn('[main] som NÃO concedido pelo núcleo — Modo Música NEGADO (música muda não é música)');
          responder('musica-som-negado', {});
          return;
        }
        // A plataforma é a INJETADA, como no ramo de tela: sem isso o smoke não
        // distingue "o núcleo negou o som" de "esta máquina não tem loopback" — e o
        // ramo de música ignorava o `deps.plataforma` que §115 criou para isso.
        const somMusica = audioDaCaptura('screen', true, deps.plataforma?.() ?? process.platform);
        if (somMusica === undefined) {
          console.warn('[main] Modo Música sem loopback nesta plataforma — captura NEGADA (o renderer mostra a recusa nomeada)');
          responder('musica-sem-loopback', {});
          return;
        }
        const fontesMusica = await deps.getSources({ types: ['screen'] });
        const telaPrimaria = resolverFonte(fontesMusica, null);
        if (telaPrimaria === undefined) {
          console.warn('[main] Modo Música sem tela para ancorar o loopback — captura NEGADA');
          responder('musica-sem-tela', {});
          return;
        }
        console.log(`[main] Modo Música concedido · tela '${telaPrimaria.name}' · áudio loopback`);
        responder('musica-concedida', { video: telaPrimaria, audio: somMusica });
        return;
      }
      const { kind: tipo, sourceId } = declarada;
      /*
       * §17.5 (emenda de 2026-09-03) — **quem concede o som é o núcleo**, não a
       * declaração do renderer. Pedir e receber deixaram de ser a mesma coisa: som
       * negado sobe a captura **muda**, que é o desfecho honesto de §17.5 — o mesmo que
       * uma plataforma sem áudio separável por janela já produzia. Negar a captura
       * inteira por causa do som puniria a imagem, que estava autorizada.
       */
      /*
       * **Pedido E concedido.** O renderer pede, o núcleo concede, e só a conjunção liga o
       * som. Usar só a decisão deixaria um núcleo com defeito acrescentar som que ninguém
       * pediu; usar só a declaração é o defeito que a emenda de 2026-09-03 tirou daqui.
       */
      const audio = declarada.audio && decisao.audio;
      if (declarada.audio && !decisao.audio) {
        console.warn(`[main] som NÃO concedido pelo núcleo — a captura sobe muda (§17.5)`);
      }
      if (!decisao.sourceTypes.includes(tipo)) {
        console.warn(`[main] núcleo não autoriza fonte '${tipo}' — captura NEGADA`);
        responder('fonte-nao-autorizada', {});
        return;
      }
      // **Onde o portal manda, esta é a ÚNICA enumeração.** No Wayland, `getSources` é
      // o próprio pedido de permissão, e a lista que volta é o que a pessoa acabou de
      // escolher na caixa do sistema — não um catálogo. Pedir os dois tipos é o que
      // deixa a escolha inteira com ela; filtrar por `tipo` aqui descartaria a janela
      // que ela apontou só porque a tela abriu em "Tela inteira".
      //
      // Fora dele nada muda: a lista é relida AGORA e não confiada ao renderer — um
      // `sourceId` é um handle de janela do sistema, e entre escolher e capturar a
      // janela pode ter fechado. Casar contra a lista viva é o que transforma "o
      // renderer pediu" em "isto existe".
      const doSistema = deps.seletorDoSistema();
      /*
       * **Sem seletor do sistema, `window` exige fonte escolhida.** `resolverFonte(_, null)`
       * devolve `fontes[0]`, e isso é resposta legítima só onde "a primeira do tipo" quer
       * dizer alguma coisa: a tela primária, o Modo Música. Para janela não quer — a
       * primeira que o sistema listar é tipicamente a janela DESTE app (`getSources` aqui
       * não a filtra, ao contrário do `listCaptureSources` do seletor), e conceder uma
       * janela que ninguém apontou é o defeito que o `sourceId` de §17.5 existe para
       * fechar. Falha fechada.
       */
      if (!doSistema && tipo === 'window' && sourceId === null) {
        console.warn('[main] captura de janela sem fonte escolhida — NEGADA (§17.5)');
        responder('janela-sem-fonte', {});
        return;
      }
      const fontes = await deps.getSources({
        types: doSistema ? ['screen', 'window'] : [tipo],
      });
      // Com o seletor do sistema não há `sourceId` a casar: a sessão do portal é outra a
      // cada pedido, e o id da anterior nunca estaria nesta lista. `fontes[0]` aqui não
      // é "a primeira que aparecer" — é a única, e é a que a pessoa escolheu.
      const fonte = resolverFonte(fontes, doSistema ? null : sourceId);
      if (fonte === undefined) {
        console.warn(
          doSistema
            ? '[main] o seletor do sistema não devolveu fonte — captura NEGADA'
            : sourceId === null
              ? `[main] nenhuma fonte '${tipo}' disponível — captura NEGADA`
              : `[main] a fonte '${tipo}' escolhida não existe mais — captura NEGADA`,
        );
        responder('sem-fonte', {});
        return;
      }
      /*
       * §17.5 — **o áudio é do tipo CONCEDIDO, não do declarado.**
       *
       * Onde o portal manda, o tipo que volta é escolha da pessoa na caixa do sistema, e ela
       * pode ter apontado uma janela depois de o renderer declarar `screen`. Calcular o som
       * pelo `tipo` declarado dava `loopback` — o som da MÁQUINA — numa captura de janela, que
       * é exatamente o que §17.5 proíbe ("no Linux ele é concedido para captura de tela, nunca
       * de janela"; "compartilhar uma janela não é consentir em transmitir tudo o que toca na
       * máquina"). O tipo efetivo é o que a fonte declara no próprio `id`.
       *
       * A mesma leitura vale para a autorização do núcleo: `sourceTypes` foi conferido contra
       * o declarado antes de enumerar, e reconferir contra o concedido é o que impede o portal
       * de entregar um tipo que o núcleo não autorizou. Sem seletor do sistema os dois são o
       * mesmo valor e nada disto muda.
       */
      const tipoEfetivo = tipoDaFonte(fonte.id) ?? tipo;
      if (tipoEfetivo !== tipo) {
        console.log(`[main] o seletor do sistema devolveu '${tipoEfetivo}' onde o renderer declarou '${tipo}'`);
        if (!decisao.sourceTypes.includes(tipoEfetivo)) {
          console.warn(`[main] núcleo não autoriza fonte '${tipoEfetivo}' — captura NEGADA`);
          responder('fonte-nao-autorizada', {});
          return;
        }
      }
      const som = audioDaCaptura(tipoEfetivo, audio, deps.plataforma?.() ?? process.platform);
      if (audio && som === undefined && tipoEfetivo !== tipo) {
        console.warn('[main] som pedido para tela e a escolha foi janela — a captura sobe MUDA (§17.5)');
      }
      console.log(
        `[main] captura concedida · sessão ${sessionId.slice(0, 8)} · ${tipoEfetivo} '${fonte.name}'` +
          ` · áudio ${som ?? 'não'}`,
      );
      responder('concedida', som === undefined ? { video: fonte } : { video: fonte, audio: som });
    })
    .catch((e) => {
      // A falha do caminho (getSources, por exemplo) nega — mas o pedido pode já ter
      // sido respondido por um ramo que venceu a corrida; o invólucro descarte com
      // aviso, nunca o segundo chamamento cru.
      console.warn(`[main] captura falhou no caminho — NEGADA (${e instanceof Error ? e.message : String(e)})`);
      responder('falha-no-caminho', {});
    });
}
