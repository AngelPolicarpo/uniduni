/**
 * Sessão — o estado do canal com o núcleo e a porta de entrada do produto (§3.3, §15.2).
 *
 * Esta store é a única que sabe conectar. Todas as outras se registram em `registrarResync`
 * e são chamadas quando o cliente pede resync — por bump de epoch (§15.2 4d) ou por
 * assinatura stale (§15.1 r. 5). É o que cumpre "refazer todas as queries ativas" sem que
 * cada store tenha que ouvir o transporte.
 *
 * O gate de primeiro uso é `core.status.phase`, não `query.identity`: `query.identity` é
 * `standard` e, sem identidade, recusa com `E_NO_IDENTITY` — perguntar por ela para
 * descobrir que não existe seria usar um erro como resposta.
 */

import { create } from "zustand";
import { api, cliente } from "../ipc/api";
import { conectar, pontePresente } from "../ipc/bridge";
import { codigoDoErro, IpcCommandError } from "../ipc/frames";
import type { MotivoDeResync } from "../ipc/client";
import type { CoreStatus, IdentityDto, Presence } from "../ipc/dto";

export type EstadoDaSessao =
  | "inicial"
  | "conectando"
  | "sem-shell"
  | "sem-identidade"
  | "pronto"
  | "reconectando"
  | "falhou";

interface Sessao {
  estado: EstadoDaSessao;
  motivo: string | null;
  status: CoreStatus | null;
  identidade: IdentityDto | null;
  epoch: number;

  iniciar(): Promise<void>;
  recarregar(origem?: MotivoResync): Promise<void>;
  /** "Tentar novamente" da tela de falha — o mesmo caminho do resync, a pedido de quem olha. */
  reconectar(): Promise<void>;
  criarIdentidade(arg: { displayName: string; avatarColor: number }): Promise<void>;
  aceitarCofreInseguro(): Promise<void>;
  importarIdentidade(passphrase: string): Promise<void>;
  definirPresenca(presence: Presence): Promise<void>;
  /** §15.4 — `community.create`; ⏱ no fio, mas daqui parece await normal. */
  criarComunidade(arg: {
    name: string;
    iconEmoji?: string;
    iconColor: number;
    description?: string;
  }): Promise<{ communityId: string; defaultChannelId: string }>;
  /** §12.4 — `invite.redeem`; o resgate abre a comunidade no runtime e o resync a traz. */
  entrarComunidade(arg: { codeOrLink: string }): Promise<{ communityId: string; defaultChannelId: string }>;
}

/**
 * Por que o resync foi pedido — o consumidor decide o quanto refazer.
 *
 * `epoch` é o reinício do núcleo (§15.2 4d): queries E a chamada de voz (B43).
 * `stale` é uma assinatura que perdeu eventos (§15.1 r.5): só queries, nunca voz —
 * refazer a chamada a cada janela estourada derrubaria quem está nela sem motivo.
 * `recarregar` é o resto (boot, comunidade nova, `core.ready`): só queries.
 */
export type MotivoResync = MotivoDeResync | { readonly tipo: "recarregar" };

/** Assinantes de resync. Set, não array: registrar duas vezes não deve refazer duas vezes. */
const resyncs = new Set<(motivo: MotivoResync) => void>();

export function registrarResync(fn: (motivo: MotivoResync) => void): () => void {
  resyncs.add(fn);
  return () => resyncs.delete(fn);
}

function dispararResync(motivo: MotivoResync): void {
  for (const fn of resyncs) fn(motivo);
}

let ligado = false;

/**
 * §15.2 — o prazo que separa "reconectando" de "falhou". O respawn de §3.3 tem backoff de
 * 1 s/4 s/10 s e até três tentativas em 60 s; passado o teto, o núcleo não volta mais e a
 * tela precisa dizer isso com um botão, em vez de girar para sempre.
 */
const PRAZO_DE_RECONEXAO_MS = 60_000;
let prazoDeReconexao: ReturnType<typeof setTimeout> | null = null;

function armarPrazoDeReconexao(): void {
  desarmarPrazoDeReconexao();
  prazoDeReconexao = setTimeout(() => {
    prazoDeReconexao = null;
    if (useSessao.getState().estado !== "reconectando") return;
    useSessao.setState({
      estado: "falhou",
      motivo: "O núcleo reiniciou e não voltou a responder.",
    });
  }, PRAZO_DE_RECONEXAO_MS);
}

function desarmarPrazoDeReconexao(): void {
  if (prazoDeReconexao === null) return;
  clearTimeout(prazoDeReconexao);
  prazoDeReconexao = null;
}

export const useSessao = create<Sessao>((set, get) => ({
  estado: "inicial",
  motivo: null,
  status: null,
  identidade: null,
  epoch: 0,

  async iniciar() {
    if (ligado) return;
    ligado = true;
    if (!pontePresente()) {
      set({
        estado: "sem-shell",
        motivo:
          "O produto é Electron (§3.1): a porta IPC-R vem do shell. Rode `npm run dev` na app, não só o Vite.",
      });
      return;
    }
    set({ estado: "conectando", motivo: null });
    // §15.2 4e — o `conn-reconnecting` começa no instante em que o núcleo cai, não quando o
    // substituto responde: entre o `exit` e o `hello` do respawn passam até 10 s de backoff,
    // e é a porta velha que o cliente larga aqui. Consultar nesse intervalo dava `E_NO_PORT`
    // e prendia a sessão em "falhou" para sempre — o resync de epoch (4d) sai só no
    // `onResync`, quando existe núcleo novo do outro lado.
    cliente.onDesconectado((epoch) => {
      set({ estado: "reconectando", epoch, motivo: null });
      armarPrazoDeReconexao();
    });
    cliente.onResync((motivo) => {
      // O resync (queries E a reentrada de voz de B43) sai pelo `recarregar` abaixo, DEPOIS
      // do núcleo responder — refazer `voice.join` contra um núcleo que ainda está subindo
      // falharia à toa e piscaria `failed` no meio da reconexão.
      if (motivo.tipo === "epoch") {
        desarmarPrazoDeReconexao();
        set({ estado: "reconectando", epoch: motivo.epoch });
        void get().recarregar(motivo);
        return;
      }
      dispararResync(motivo);
    });
    try {
      const conexao = await conectar(cliente);
      set({ epoch: conexao.epoch });
      await get().recarregar();
    } catch (e) {
      set({ estado: "falhou", motivo: e instanceof Error ? e.message : "falha ao conectar" });
    }
  },

  async recarregar(origem: MotivoResync = { tipo: "recarregar" }) {
    try {
      const status = await api.coreStatus();
      if (status.phase === "awaiting-identity") {
        set({ estado: "sem-identidade", status, identidade: null, epoch: status.epoch });
        return;
      }
      const identidade = await api.identity().catch((e) => {
        // Fase adiantada e identidade ainda não carregada não é falha de sessão: a tela de
        // primeiro uso cobre o caso e o `core.ready` reconsulta.
        if (codigoDoErro(e) === "E_NO_IDENTITY") return null;
        throw e;
      });
      set({
        estado: identidade === null ? "sem-identidade" : "pronto",
        status,
        identidade,
        epoch: status.epoch,
        motivo: null,
      });
      dispararResync(origem);
    } catch (e) {
      // Sem porta o núcleo novo ainda não chegou (§15.2 passo 2): isso é a reconexão em
      // curso, não fim de linha. Quem decide que a reconexão fracassou é o prazo armado no
      // `onDesconectado` — declarar falha aqui apagava a tela por causa do backoff.
      if (codigoDoErro(e) === "E_NO_PORT" && get().estado === "reconectando") return;
      set({ estado: "falhou", motivo: e instanceof Error ? e.message : "falha ao ler o núcleo" });
    }
  },

  /**
   * "Tentar novamente" da tela de falha. Refaz o aperto de mão quando não há porta — é o
   * caso do boot que estourou o prazo — e daí em diante é o mesmo `recarregar` do resync.
   */
  async reconectar() {
    set({ estado: "reconectando", motivo: null });
    if (!cliente.conectado) {
      try {
        const conexao = await conectar(cliente);
        set({ epoch: conexao.epoch });
      } catch (e) {
        set({ estado: "falhou", motivo: e instanceof Error ? e.message : "falha ao conectar" });
        return;
      }
    }
    await get().recarregar();
  },

  async criarIdentidade(arg) {
    await api.identityCreate(arg);
    // `identity.create` é o que tira o núcleo de `awaiting-identity`; o `core.ready` chega
    // por evento, mas a tela não precisa esperar o evento para sair do formulário.
    await get().recarregar();
  },

  /**
   * §3.2 L-2 — o aceite explícito. Depois dele, `core.status` continua dizendo
   * `insecure-fallback`: o aceite não torna o cofre seguro, e o indicador permanente que a
   * limitação declarada exige segue aceso no shell.
   */
  async aceitarCofreInseguro() {
    await api.identityAcceptInsecureKeystore();
  },

  async importarIdentidade(passphrase) {
    await api.identityImport({ passphrase });
    await get().recarregar();
  },

  async definirPresenca(presence) {
    await api.identitySetPresence(presence);
    set((s) => (s.identidade === null ? s : { identidade: { ...s.identidade, presence } }));
  },

  /**
   * §15.4 `community.create` — a resposta traz `{communityId, defaultChannelId}`.
   * O `recarregar()` dispara o resync: o rail e a estrutura da comunidade nova
   * vêm das queries, não de estado local montado à mão.
   */
  async criarComunidade(arg) {
    const r = await api.communityCreate(arg);
    await get().recarregar();
    return r;
  },

  /**
   * §12.4 `invite.redeem` — a resposta traz `{communityId, defaultChannelId}`. O resgate
   * registra a participação no manifest e abre a comunidade no runtime; o `recarregar()`
   * dispara o resync e o rail passa a incluí-la, como em `criarComunidade`.
   */
  async entrarComunidade(arg) {
    const { communityId, defaultChannelId } = await api.inviteRedeem(arg);
    await get().recarregar();
    return { communityId, defaultChannelId };
  },
}));

/**
 * Assinaturas do ciclo do núcleo. Ficam fora do `create` porque só podem sair depois da
 * porta existir — assinar antes enfileiraria `sub` num cliente sem porta.
 */
export function assinarCicloDoNucleo(): void {
  // `core.ready` é assinado pelo sincronizador (§15.5) — assiná-lo aqui também faria toda
  // partida de núcleo recarregar a sessão duas vezes.
  cliente.subscribe("core.restarted", (data) => {
    const epoch = (data as { epoch?: number })?.epoch;
    if (typeof epoch === "number") cliente.handleCoreEpoch(epoch);
  });
}

export function mensagemDeErro(e: unknown): string {
  if (e instanceof IpcCommandError) return `${e.code}${e.message ? ` — ${e.message}` : ""}`;
  return e instanceof Error ? e.message : String(e);
}
