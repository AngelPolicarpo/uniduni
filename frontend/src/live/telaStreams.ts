/**
 * Os `MediaStream` de tela vivos, fora da árvore do React — irmão do mapa de `<audio>` que
 * `live/sincronizacao.ts` mantém para a voz, e pela mesma razão.
 *
 * Um `MediaStream` não é estado de UI: ele não serializa, não compara e não sobrevive a ser
 * recriado. Guardá-lo no `voiceStore` faria cada render tocar em `srcObject` e a imagem
 * piscaria; guardá-lo em `useState` o perderia na primeira remontagem do tile. O store
 * guarda **quem** apresenta e **como** vai a transmissão; o pixel mora aqui.
 */

/** A tela que ESTA máquina captura e envia (§17.5, papel apresentador). */
let daMinhaCaptura: MediaStream | null = null;

/** Telas recebidas, por chave de quem apresenta. */
const recebidas = new Map<string, MediaStream>();

export function guardarTelaDoApresentador(stream: MediaStream | null): void {
  daMinhaCaptura = stream;
}

export function telaDoApresentador(): MediaStream | null {
  return daMinhaCaptura;
}

export function guardarTelaRecebida(presenterHex: string, stream: MediaStream): void {
  recebidas.set(presenterHex.toLowerCase(), stream);
}

/**
 * A tela viva daquele par, ou `null`.
 *
 * **O mapa é a única fonte, e isso é a propriedade** (correção de 2026-09-06). Houve aqui
 * uma consulta de reserva à malha (`streamDe(par, "tela")`) para o caso de o evento de
 * chegada se perder. Ela não tinha como funcionar: com os m-lines reservados de §17.2, o
 * `ontrack` do m-line 2 dispara na PRIMEIRA negociação, com a trilha **muda**, para todo
 * par da chamada — então a malha tem um `MediaStream` de tela para quem nunca apresentou
 * nada, e a reserva devolvia "tem tela" sempre.
 *
 * O estrago era em cascata: `share.started` lê esta função para decidir se a transmissão já
 * está `live` (`live/sincronizacao.ts`), então toda tela nascia ao vivo e o prazo de
 * §17.5 — o único detector de "a transmissão não subiu" — era cancelado antes de existir
 * imagem. Uma tela que nunca chegasse virava retângulo preto permanente, sem erro e sem
 * "Tentar novamente". `esquecerTelaRecebida` também deixava de esquecer: o acesso seguinte
 * repunha o stream morto.
 *
 * Quem povoa o mapa é `aoChegarVideo`, que a malha dispara no `unmute` — isto é, quando há
 * imagem de verdade. Não havia buraco a tapar.
 */
export function telaRecebida(presenterHex: string): MediaStream | null {
  return recebidas.get(presenterHex.toLowerCase()) ?? null;
}

/**
 * §17.2 (emenda de 2026-09-03) — **o mapa de assinaturas saiu daqui, e com ele B41.**
 *
 * Existia `assinadas` (sessão → apresentador) e `assinouTelaDe`, e a única coisa que os lia
 * era a heurística de `classificarVideo`: "entrei na transmissão deste par e ainda não tenho
 * imagem, então esta trilha de vídeo é a tela". Com o m-line 2 reservado, quem recebe sabe o
 * que a trilha é pela posição, e a assinatura deixou de ter leitor. Mantê-la escrita e nunca
 * lida seria a superfície morta que §82.3 nomeia, do lado do renderer.
 *
 * `idDaTelaDe` saiu pelo mesmo motivo: ele respondia "qual `msid` já está ligado à tela",
 * que era a outra metade da mesma adivinhação.
 */

export function esquecerTelaRecebida(presenterHex: string): void {
  recebidas.delete(presenterHex.toLowerCase());
}

/** Fim de chamada: nada de tela sobrevive a ela. */
export function esquecerTodasAsTelas(): void {
  daMinhaCaptura = null;
  recebidas.clear();
}
