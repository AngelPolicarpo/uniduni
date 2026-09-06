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

let portaDaMalha: { streamDe?(parHex: string, slot: "camera" | "tela" | "voz"): MediaStream | null } | null = null;

export function configurarPortaDeStream(
  porta: { streamDe?(parHex: string, slot: "camera" | "tela" | "voz"): MediaStream | null } | null,
): void {
  portaDaMalha = porta;
}

export function guardarTelaDoApresentador(stream: MediaStream | null): void {
  daMinhaCaptura = stream;
}

export function telaDoApresentador(): MediaStream | null {
  return daMinhaCaptura;
}

export function guardarTelaRecebida(presenterHex: string, stream: MediaStream): void {
  recebidas.set(presenterHex.toLowerCase(), stream);
}

export function telaRecebida(presenterHex: string): MediaStream | null {
  const norm = presenterHex.toLowerCase();
  const cached = recebidas.get(norm);
  if (cached) return cached;
  const daMalha = portaDaMalha?.streamDe?.(norm, "tela");
  if (daMalha) {
    recebidas.set(norm, daMalha);
    return daMalha;
  }
  return null;
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
  portaDaMalha = null;
}
