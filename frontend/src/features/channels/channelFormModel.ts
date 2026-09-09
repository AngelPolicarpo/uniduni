import { channelName } from "../../lib/channelName";
import {
  SPEECH_MODE_DEFAULT_SECONDS,
  type ChannelType,
  type SpeechMode,
} from "../../domain/types";

/** §13 — nome 1-32, tópico até 120. */
export const NAME_MAX = 32;
export const TOPIC_MAX = 120;

/** §8.6 (R-29) — faixa do turno do modo fila. */
export const QUEUE_TURN_MIN = 30;
export const QUEUE_TURN_MAX = 3600;

/** Opção final do select de categoria, que abre o campo de nome inline. */
export const NEW_CATEGORY = "__new__";

export interface ChannelFormValue {
  type: ChannelType;
  name: string;
  topic: string;
  categoryId: string;
  newCategoryName: string;
  readOnly: boolean;
  /** Cargos que **podem** postar; o inverso vira `readOnlyForRoleIds` (§2). */
  canPostRoleIds: string[];
  /** §6.6 — só em canal de voz; quem transmite áudio. */
  speechMode: SpeechMode;
  /** §6.6 — duração do turno no modo fila, em segundos (30–3600). */
  queueTurnSeconds: number;
}

export interface ChannelFormErrors {
  name?: string;
  category?: string;
  queueTurnSeconds?: string;
  readOnly?: string;
}

/**
 * §13 — nome obrigatório, e em canal de texto ele não pode normalizar pra
 * vazio (o nome é o endereço do canal). Duplicidade é bloqueante dentro da
 * mesma comunidade, diferente do nome de comunidade, onde duplicar só avisa.
 * §8.6 — teto de 32 code points.
 */
export function validateChannelForm(
  value: ChannelFormValue,
  takenNames: string[],
): ChannelFormErrors {
  const errors: ChannelFormErrors = {};
  const resolved = channelName(value.type, value.name);
  const cpCount = Array.from(resolved).length;

  if (value.name.trim().length === 0)
    errors.name = "Digite um nome para o canal.";
  else if (resolved.length === 0)
    errors.name = "Use ao menos uma letra ou número.";
  else if (cpCount > 32)
    errors.name = "O nome pode ter no máximo 32 caracteres.";
  else if (takenNames.includes(resolved.toLowerCase()))
    errors.name =
      value.type === "text"
        ? `Já existe um canal #${resolved} nesta comunidade.`
        : `Já existe um canal ${resolved} nesta comunidade.`;

  if (
    value.categoryId === NEW_CATEGORY &&
    value.newCategoryName.trim().length === 0
  )
    errors.category = "Digite um nome para a categoria.";

  if (value.type === "voice" && value.speechMode === "queue") {
    const n = value.queueTurnSeconds;
    if (!Number.isInteger(n) || n < QUEUE_TURN_MIN || n > QUEUE_TURN_MAX)
      errors.queueTurnSeconds = `O turno vai de ${QUEUE_TURN_MIN} a ${QUEUE_TURN_MAX} segundos.`;
  }

  if (value.readOnly && value.canPostRoleIds.length === 0) {
    errors.readOnly = "Selecione ao menos um cargo com permissão para postar.";
  }

  return errors;
}

/**
 * Complemento de §2: dada a lista de cargos e os ids de um lado, devolve os
 * ids do outro. É o que converte `canPostRoleIds` em `readOnlyForRoleIds` e
 * vice-versa. O conjunto é montado uma vez, em vez de a lista ser varrida por
 * cargo.
 */
export function roleIdsExcluding(
  roles: ReadonlyArray<{ id: string }>,
  excluded: readonly string[],
): string[] {
  const fora = new Set(excluded);
  return roles.filter((role) => !fora.has(role.id)).map((role) => role.id);
}

/** Mesmos ids, sem depender de ordem — usado para saber se o alvo mudou. */
export function sameRoleIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const conjunto = new Set(b);
  return a.every((id) => conjunto.has(id));
}

/** Número de §6.6 que o formulário envia ao núcleo. */
export function speechModeNumber(mode: SpeechMode): number {
  return mode === "queue" ? 1 : mode === "admins" ? 2 : 0;
}

export function speechModeLabel(mode: SpeechMode): string {
  switch (mode) {
    case "queue":
      return "Fila (karaokê)";
    case "admins":
      return "Apenas administradores";
    default:
      return "Fala livre";
  }
}

export const SPEECH_MODE_OPTIONS: Array<{ value: SpeechMode; label: string }> = (
  ["free", "queue", "admins"] as const
).map((value) => ({ value, label: speechModeLabel(value) }));

/** Default do formulário para a duração do turno. */
export const QUEUE_TURN_DEFAULT = SPEECH_MODE_DEFAULT_SECONDS;
