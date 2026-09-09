/**
 * Nome de canal (§10, 3.4 · §13).
 *
 * Canal de **texto** vira slug: o nome é o endereço dele dentro da
 * comunidade, então precisa ser previsível e digitável. Canal de **voz**
 * preserva o que foi digitado — é o que o dataset de §2 mostra ("Sala de
 * Estudos", não "sala-de-estudos").
 */
import type { ChannelType } from "../domain/types";

export function channelSlug(input: string): string {
  return input
    .normalize("NFD")
    // Remove os diacríticos que o NFD separou das letras.
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Como o nome digitado vai ficar de fato, já pelo tipo do canal. */
export function channelName(type: ChannelType, input: string): string {
  return type === "text" ? channelSlug(input) : input.trim().normalize("NFKC");
}
