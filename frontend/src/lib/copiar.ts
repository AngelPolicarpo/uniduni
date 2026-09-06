/**
 * Copiar para a área de transferência, e **dizer a verdade sobre o resultado**.
 *
 * `navigator.clipboard.writeText` rejeita mais do que parece: o Chromium exige gesto do
 * usuário e documento em foco, e no Electron a permissão `clipboard-sanitized-write` passa
 * pelo `setPermissionCheckHandler` do main — que durante toda a vida do produto concedeu
 * só `media`, então **todo** botão de copiar rejeitava com `NotAllowedError`.
 *
 * O defeito ficou invisível porque três dos quatro chamadores faziam
 * `void navigator.clipboard.writeText(...)` e mostravam "Link copiado" logo em seguida,
 * incondicionalmente: a promessa rejeitada era descartada e a interface afirmava um
 * sucesso que não houve. Daí esta função devolver `boolean` em vez de `void` — quem chama
 * é obrigado a olhar.
 */
export async function copiarTexto(texto: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(texto);
    return true;
  } catch {
    return false;
  }
}
