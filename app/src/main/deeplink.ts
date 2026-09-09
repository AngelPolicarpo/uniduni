/**
 * A gramática **fechada** de deep link de §3.5, e a única implementação dela.
 *
 * Morava em dois lugares: aqui (o produto) e em `core/src/l3/ipcMain`. A segunda não tinha
 * consumidor nenhum fora do teste e já havia divergido — faltava a rota `u/<KEY64>` da
 * emenda B64 —, então a suíte validava uma gramática que nenhum processo executava, o que é
 * pior que não ter teste: parece cobertura. Ficou a que recebe `argv` e `open-url`, que é
 * esta, e o `smoke:deeplink` a exercita.
 *
 * §3.5(2): o que sai daqui é **dado estruturado**, nunca a string original. Nada de
 * `shell.openExternal`, nada de navegação: o main encaminha a rota já reconhecida.
 */

const RE_JOIN = /^comunidadep2p:\/\/join\/([0-9A-HJKMNP-TV-Z]{16})$/i;
const RE_MSG = /^comunidadep2p:\/\/m\/([A-Za-z0-9_-]{86})$/;
const RE_USER = /^comunidadep2p:\/\/u\/([0-9a-fA-F]{64})$/;

export type DeepLink =
  | { route: 'join'; code: string }
  | { route: 'message'; ref: string }
  | { route: 'user'; key: string };

export function parseDeepLink(raw: string): DeepLink | null {
  const bruto = raw.trim();
  const j = RE_JOIN.exec(bruto);
  if (j !== null) return { route: 'join', code: (j[1] as string).toUpperCase() };
  const m = RE_MSG.exec(bruto);
  if (m !== null) return { route: 'message', ref: m[1] as string };
  // B64 — a chave segue em minúsculas adiante; a caixa da URL é tolerada aqui.
  const u = RE_USER.exec(bruto);
  if (u !== null) return { route: 'user', key: (u[1] as string).toLowerCase() };
  return null;
}
