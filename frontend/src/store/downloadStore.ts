import { create } from "zustand";
import { api } from "../ipc/api";
import type { Attachment } from "../domain/types";

/**
 * Download de anexo (§13.4) — o progresso é o que o núcleo publica em `blob.progress`
 * (emenda de 2026-08-22: a chave do fio é `blobIdHex`), não uma simulação.
 *
 * O gatilho é o clique em "Baixar" (§11, B8 passo 2). Receber a mensagem com o anexo
 * NÃO pede nada ao núcleo: quem recebe decide se e quando gasta banda e disco. O
 * comando é idempotente no núcleo e o pedido também é aqui — `emCursoById` é o guarda,
 * e é ele que o card lê para saber se há download desta sessão em voo.
 */

interface DownloadState {
  /** Pedidos desta sessão ainda em voo — guarda contra re-pedido e estado do card. */
  emCursoById: Record<string, true>;
  progressById: Record<string, number>;
  peersById: Record<string, number>;
  hostById: Record<string, boolean>;
  /** "1 peer desconectou, continuando com 2" (§11, B8, exceções) — de `blob.peerLost`. */
  noticeById: Record<string, string>;
  /** `blob.unavailable` — zero pares e host fora (§13.4). */
  indisponivelById: Record<string, true>;
  /** `attachment.corrupt` — hash/size divergiram (A-5); a UI não oferece abrir. */
  corrompidoById: Record<string, string>;
  /** Caminho local pós-`blob.completed` — nunca cruza o fio; quem abre é o main. */
  caminhoById: Record<string, true>;
  /** Cancelado nesta sessão (§13.4 `blob.cancel`) — o card oferece baixar de novo. */
  canceladoById: Record<string, true>;

  /** Dispara `blob.download` a pedido de quem baixa; não re-pede o que está em voo. */
  iniciar: (attachment: Attachment) => void;
  /** Cancela o download em curso; liberar o pedido permite "baixar de novo". */
  cancelar: (attachment: Attachment) => void;
  /** Eventos de §15.5 — chamados pelo sincronizador. */
  aplicarProgresso: (blobIdHex: string, progress: number, peers: number, hostAvailable: boolean) => void;
  aplicarPeerLost: (blobIdHex: string, remaining: number) => void;
  aplicarConcluido: (blobIdHex: string) => void;
  aplicarIndisponivel: (blobIdHex: string) => void;
  aplicarCorrompido: (blobIdHex: string, causa: string) => void;
  /**
   * §15.2 4d — o núcleo reiniciou e levou junto toda transferência em voo. Solta as marcas
   * de "baixando" para o card voltar a oferecer "Baixar": o núcleo novo não conhece os
   * downloads do processo morto e nenhum `blob.progress` chega mais para eles, então a
   * guarda de re-pedido de `iniciar` deixava o anexo parado em "baixando N %" para sempre.
   * O que já terminou não é tocado — o arquivo está no disco.
   */
  interromperEmVoo: () => void;
  reset: () => void;
}

function omitir(map: Record<string, true>, chave: string): Record<string, true> {
  const { [chave]: _fora, ...resto } = map;
  return resto;
}

function omitirValor(map: Record<string, number>, chave: string): Record<string, number> {
  const { [chave]: _fora, ...resto } = map;
  return resto;
}

export const useDownloadStore = create<DownloadState>()((set, get) => ({
  emCursoById: {},
  progressById: {},
  peersById: {},
  hostById: {},
  noticeById: {},
  indisponivelById: {},
  corrompidoById: {},
  caminhoById: {},
  canceladoById: {},

  iniciar: (attachment) => {
    const origem = attachment.origem;
    if (origem === undefined || get().emCursoById[attachment.id] === true) return;
    if ((attachment.downloadProgress ?? 0) >= 100) return;
    // Um pedido novo depois de um cancelamento limpa a marca — o card volta ao
    // estado "baixando" com o que o fio disser por cima.
    set((state) => ({
      emCursoById: { ...state.emCursoById, [attachment.id]: true },
      canceladoById: omitir(state.canceladoById, attachment.id),
    }));
    void api
      .blobDownload({
        communityId: origem.communityId,
        blobsCoreKey: origem.blobsCoreKey,
        blobId: origem.blobId,
      })
      .catch(() => {
        // E_NO_PEERS etc.: o card já mostra o estado do fio; `blob.unavailable`
        // chega por evento quando for o caso (§13.4). Sem pedido em voo, o card
        // volta a oferecer "Baixar".
        set((state) => ({ emCursoById: omitir(state.emCursoById, attachment.id) }));
      });
  },

  /** §13.4 `blob.cancel` — para o download; o card oferece recomeçar. */
  cancelar: (attachment) => {
    const origem = attachment.origem;
    if (origem === undefined) return;
    if ((attachment.downloadProgress ?? 0) >= 100) return;
    void api
      .blobCancel({
        blobsCoreKey: origem.blobsCoreKey,
        blobId: origem.blobId,
      })
      .catch(() => {});
    set((state) => ({
      emCursoById: omitir(state.emCursoById, attachment.id),
      canceladoById: { ...state.canceladoById, [attachment.id]: true },
      progressById: omitirValor(state.progressById, attachment.id),
      peersById: omitirValor(state.peersById, attachment.id),
    }));
  },

  aplicarProgresso: (blobIdHex, progress, peers, hostAvailable) =>
    set((state) => ({
      progressById: { ...state.progressById, [blobIdHex]: progress },
      peersById: { ...state.peersById, [blobIdHex]: peers },
      hostById: { ...state.hostById, [blobIdHex]: hostAvailable },
      indisponivelById: omitir(state.indisponivelById, blobIdHex),
    })),

  aplicarPeerLost: (blobIdHex, remaining) =>
    set((state) => ({
      peersById: { ...state.peersById, [blobIdHex]: remaining },
      noticeById: {
        ...state.noticeById,
        [blobIdHex]: `1 peer desconectou, continuando com ${remaining}`,
      },
    })),

  aplicarConcluido: (blobIdHex) =>
    set((state) => ({
      emCursoById: omitir(state.emCursoById, blobIdHex),
      progressById: { ...state.progressById, [blobIdHex]: 100 },
      caminhoById: { ...state.caminhoById, [blobIdHex]: true },
    })),

  aplicarIndisponivel: (blobIdHex) =>
    set((state) => ({
      indisponivelById: { ...state.indisponivelById, [blobIdHex]: true },
      peersById: { ...state.peersById, [blobIdHex]: 0 },
    })),

  aplicarCorrompido: (blobIdHex, causa) =>
    set((state) => ({
      emCursoById: omitir(state.emCursoById, blobIdHex),
      corrompidoById: { ...state.corrompidoById, [blobIdHex]: causa },
    })),

  interromperEmVoo: () => {
    set((state) => {
      const ids = Object.keys(state.emCursoById);
      if (ids.length === 0) return {};
      const progressById = { ...state.progressById };
      const peersById = { ...state.peersById };
      const noticeById = { ...state.noticeById };
      for (const id of ids) {
        delete progressById[id];
        delete peersById[id];
        delete noticeById[id];
      }
      return { emCursoById: {}, progressById, peersById, noticeById };
    });
  },

  reset: () => {
    set({
      emCursoById: {},
      progressById: {},
      peersById: {},
      hostById: {},
      noticeById: {},
      indisponivelById: {},
      corrompidoById: {},
      caminhoById: {},
      canceladoById: {},
    });
  },
}));

/** Anexo com o que os eventos de §15.5 já disseram por cima do DTO. */
export function useLiveAttachment(attachment: Attachment): Attachment {
  const progress = useDownloadStore((state) => state.progressById[attachment.id]);
  const peers = useDownloadStore((state) => state.peersById[attachment.id]);
  const host = useDownloadStore((state) => state.hostById[attachment.id]);
  const indisponivel = useDownloadStore((state) => state.indisponivelById[attachment.id] === true);

  if (
    progress === undefined &&
    peers === undefined &&
    host === undefined &&
    !indisponivel
  ) {
    return attachment;
  }
  return {
    ...attachment,
    downloadProgress: progress ?? attachment.downloadProgress,
    availablePeers: indisponivel ? 0 : (peers ?? attachment.availablePeers),
    hostAvailable: indisponivel ? false : (host ?? attachment.hostAvailable),
  };
}
