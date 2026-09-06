/**
 * A decisão de permissão de janela (§17.2, §25.4), fora do `main/index.ts`.
 *
 * Mora aqui pela razão de §114.5: `main/index.ts` abre janela ao ser importado, então nada
 * declarado lá dentro é exercitável sem um app inteiro — e foi assim que a lista ficou
 * errada sem ninguém ver. O `smoke:clipboard` chama **esta** função, e o handler real do
 * produto é o mesmo objeto.
 */

/**
 * O que uma janela do produto pode pedir ao Chromium.
 *
 * - `media` — microfone e câmera. Toda a mídia é do renderer (§17.2), então a captura passa
 *   por aqui. Sem handler explícito a decisão fica com o default do Electron, que varia por
 *   versão: uma porta de captura não deve depender disso.
 * - `clipboard-sanitized-write` — é o que `navigator.clipboard.writeText` pede. **A
 *   ausência dela quebrava todo botão de copiar do produto**: link de convite, link do
 *   canal, link da mensagem e chave pública rejeitavam com `NotAllowedError: Write
 *   permission denied`, e três dos quatro descartavam a promessa e diziam "copiado" assim
 *   mesmo. Não é "falar com o mundo" no sentido de §25.4 — é a afordância local que a
 *   pessoa acabou de pedir com um clique, e o Chromium só a concede com gesto e foco.
 *
 * Tudo o mais é recusado, e a lista fechada é o ponto: geolocalização, notificações do SO,
 * MIDI, USB, HID, serial — e a **leitura** da área de transferência (`clipboard-read`), que
 * o produto nunca precisa. §25.4 diz que este produto não fala com nada além dos pares.
 */
const CONCEDIDAS: ReadonlySet<string> = new Set(['media', 'clipboard-sanitized-write']);

export function permissaoConcedida(permission: string): boolean {
  return CONCEDIDAS.has(permission);
}
