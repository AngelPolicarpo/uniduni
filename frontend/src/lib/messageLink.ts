import { INVITE_LINK_HOST } from "../mocks/dataset";

/**
 * Link de mensagem (§4, rota `/m/:code` · premissa 10).
 *
 * O `code` empacota comunidade + canal + mensagem num token só. Não é
 * segurança — é para o link não anunciar a estrutura da comunidade a quem
 * não é membro: quem recebe um `/m/x7K2qM…` colado fora do app não deve
 * conseguir ler dali o nome do canal nem o id da comunidade.
 *
 * Base64URL do JSON, sem padding. Um link corrompido devolve `null` em vez
 * de lançar — quem chama trata como "link inválido", que é o mesmo desfecho
 * de um link de comunidade da qual não se faz parte.
 */
export interface MessageRef {
  communityId: string;
  channelId: string;
  messageId: string;
}

function toBase64Url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
}

export function encodeMessageRef(ref: MessageRef): string {
  return toBase64Url(
    JSON.stringify([ref.communityId, ref.channelId, ref.messageId]),
  );
}

/** Formato copiado para a área de transferência com protocolo seguro https. */
export function linkDeMensagem(ref: MessageRef): string {
  return `https://${INVITE_LINK_HOST}/m/${encodeMessageRef(ref)}`;
}

export function decodeMessageRef(code: string): MessageRef | null {
  try {
    const parsed: unknown = JSON.parse(fromBase64Url(code));
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [communityId, channelId, messageId] = parsed;
    if (
      typeof communityId !== "string" ||
      typeof channelId !== "string" ||
      typeof messageId !== "string"
    )
      return null;
    return { communityId, channelId, messageId };
  } catch {
    return null;
  }
}
