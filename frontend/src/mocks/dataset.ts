/**
 * O que restou do dataset de referência de §2 da spec de UX/UI.
 *
 * As fixtures foram embora quando as telas passaram a ler da IPC-R (ver o comentário em
 * `store/communityStore.ts`): comunidades, canais, membros, mensagens, convites e log de
 * moderação vinham daqui e hoje vêm do núcleo. O que sobrou não é dado de exemplo — são
 * três constantes de produto que nunca tiveram outra casa:
 *
 *   - `PERMISSION_GROUPS`  — o catálogo de permissões de §10, 3.2, que o editor de cargos
 *                            desenha;
 *   - `INVITE_LINK_HOST`   — o host do link de convite (§2, §7 0.3);
 *   - `normalizeInviteCode`— a leitura tolerante do código colado.
 */
import type { Permission } from "../domain/types";

/* ─── Catálogo de permissões (§10, 3.2) ──────────────────────────── */

export const PERMISSION_GROUPS: {
  id: "general" | "text" | "voice" | "moderation";
  label: string;
  permissions: { id: Permission; label: string }[];
}[] = [
  {
    id: "general",
    label: "Geral",
    permissions: [
      { id: "manage_community", label: "Gerenciar comunidade" },
      { id: "manage_channels", label: "Gerenciar canais" },
      { id: "view_audit_log", label: "Ver log de auditoria" },
    ],
  },
  {
    id: "text",
    label: "Texto",
    permissions: [
      { id: "send_messages", label: "Enviar mensagens" },
      { id: "attach_files", label: "Anexar arquivos" },
      { id: "add_reactions", label: "Adicionar reações" },
      { id: "mention_everyone", label: "Mencionar @everyone" },
      { id: "pin_messages", label: "Fixar mensagens" },
      { id: "manage_messages", label: "Gerenciar mensagens" },
    ],
  },
  {
    id: "voice",
    label: "Voz",
    permissions: [
      { id: "voice_speak", label: "Falar" },
      { id: "voice_mute_others", label: "Silenciar outros" },
      { id: "voice_share_screen", label: "Compartilhar tela" },
    ],
  },
  {
    id: "moderation",
    label: "Moderação",
    permissions: [
      { id: "create_invite", label: "Convidar pessoas" },
      { id: "kick_members", label: "Expulsar" },
      { id: "ban_members", label: "Banir" },
      { id: "timeout_members", label: "Aplicar timeout" },
      { id: "manage_roles", label: "Gerenciar cargos" },
    ],
  },
];

/* ─── Convites (§2, §7 0.3) ──────────────────────────────────────── */

export const INVITE_LINK_HOST = "p2p.app";

/**
 * O link de convite que se copia — a forma que o sistema operacional **abre**.
 *
 * §15.4 aceita as duas gramáticas de `codeOrLink` (`comunidadep2p://join/<CODE16>` e
 * `<scheme>://<host>/invite/<CODE16>`, com o host ignorado e nunca contactado), mas §3.5
 * só tem rota de protocolo para a primeira: um deep link é `join/`, `m/` ou `u/`, e mais
 * nada. O que estava sendo copiado — `p2p.app/invite/<code>` — não é nenhuma das duas:
 * não tem esquema, então nem casa a segunda gramática, e como link é inerte em qualquer
 * lugar onde seja colado. `p2p.app` é domínio de exemplo do dataset original, que ninguém
 * possui e o produto nunca resolve.
 *
 * A forma nativa serve os dois caminhos com uma string só: o handler de §3.5 a abre, e o
 * campo "cole um link ou código" de 0.3 a aceita (a normalização pega tudo depois da
 * última `/`). Os hífens de exibição saem — `CODE16` de §3.5 são 16 símbolos, sem
 * separador.
 */
export function linkDeConvite(code: string): string {
  return `comunidadep2p://join/${normalizeInviteCode(code) ?? code}`;
}

/** §12.1 — Base32 Crockford, sem `I`, `L`, `O` e `U`. */
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** §12.1 — `I` e `L` valem `1`, `O` vale `0`. Caixa é irrelevante. */
const CROCKFORD_ALIAS = new Map([
  ["I", "1"],
  ["L", "1"],
  ["O", "0"],
]);
/** 80 bits / 5 = 16 chars exatos (§12.1). */
const INVITE_CODE_CHARS = 16;

/**
 * A gramática de `codeOrLink` de §15.4, do lado da interface.
 *
 * **Devolve `null` quando o que foi colado não é um código.** A versão anterior
 * devolvia string em todo caso: um `comunidadep2p://join/…` não casava no regex de
 * `invite/…` e caía no ramo que só removia pontuação, produzindo
 * `comunidadep2pjoinX7K2…` — 33 caracteres que o núcleo recusa com `E_MALFORMED`,
 * sem que a tela soubesse dizer por quê. E não aplicava nem os aliases Crockford
 * nem a caixa, então `x7k2-qm9f-rt4b-n8zp` e `X7K2QM9FRT4BN8ZP` viravam pendências
 * diferentes para o mesmo convite.
 *
 * É a mesma normalização de `normalizeInviteCode` em `core/src/l2/invites`: tudo
 * depois da última `/` (que cobre `p2p.app/invite/…`, `https://…` e
 * `comunidadep2p://join/…`), `-` e espaço ignorados, caixa alta, aliases, e então
 * o comprimento e o alfabeto conferidos. O núcleo continua sendo quem decide —
 * aqui a conta serve para a tela não guardar lixo achando que guardou convite.
 */
export function normalizeInviteCode(raw: string): string | null {
  let s = raw.trim();
  const barra = s.lastIndexOf("/");
  if (barra !== -1) s = s.slice(barra + 1);

  let limpo = "";
  for (const ch of s) {
    if (ch === "-" || ch === " " || ch === "\t" || ch === "\n") continue;
    const alto = ch.toUpperCase();
    limpo += CROCKFORD_ALIAS.get(alto) ?? alto;
  }
  if (limpo.length !== INVITE_CODE_CHARS) return null;
  for (const ch of limpo) if (!CROCKFORD_ALPHABET.includes(ch)) return null;
  return limpo;
}
