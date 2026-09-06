import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { api } from "../../ipc/api";
import { pontePresente } from "../../ipc/bridge";
import { useJoinedCommunities } from "../../store/communityStore";
import { useIdentityStore } from "../../store/identityStore";
import { useVoiceStore } from "../../store/voiceStore";
import type { Community } from "../../domain/types";
import { membrosDaComunidade } from "../../store/communityStore";

export interface HostedImpact {
  community: Community;
  online: number;
  inCall: number;
  /**
   * §18.7 passo 1 — quantas ops ainda não replicaram. **Contra a barreira de PARES**, não
   * contra a projeção local: é o número que separa "fechar agora custa uma reconexão" de
   * "fechar agora perde o que foi escrito". Vem de `host.exitImpact`, porque só o núcleo
   * enxerga o bitfield remoto de quem replica.
   *
   * **`null` é "não medido", e não zero.** A versão anterior escrevia `?? 0` — inventando
   * a resposta tranquilizadora exatamente no caso em que §18.7 existe: núcleo reiniciando,
   * leitura falhando, e o modal afirmando que não havia nada por replicar. Zero é uma
   * afirmação sobre o disco dos outros; sem resposta do núcleo, não há como fazê-la.
   */
  pendingReplication: number | null;
}

interface LinhaDeImpacto {
  onlineCount: number;
  inCallCount: number;
  pendingReplication: number;
}

interface ImpactoDoNucleo {
  /** `null` enquanto nenhuma leitura tiver **completado** — não é o mesmo que mapa vazio. */
  porComunidade: Map<string, LinhaDeImpacto> | null;
  /** Quantos componentes estão observando; a sondagem só corre com pelo menos um. */
  observadores: number;
  ler(): Promise<Map<string, LinhaDeImpacto> | null>;
  observar(): () => void;
}

/**
 * §15.4 `host.exitImpact` — o impacto medido pelo NÚCLEO, num **único** lugar.
 *
 * As contagens de presença e de chamada as stores até derivam sozinhas, mas
 * `pendingReplication` não: ele depende do que os PARES anunciaram ter (§18.7 passo 2), que
 * é estado do transporte e não chega ao renderer por query nenhuma. Como o comando devolve
 * os três juntos, tomar dois de uma fonte e um de outra só criaria a chance de a linha
 * "3 pessoas online" e a linha "2 ops pendentes" descreverem instantes diferentes.
 *
 * **Store, e não hook com estado próprio.** Cada chamada do hook antigo criava um mapa e um
 * `setInterval` de 3 s independentes: o ouvinte do pedido de saída e o shell tinham cópias
 * defasadas do mesmo número, e a decisão de fechar era tomada numa delas enquanto o diálogo
 * era desenhado (ou não) a partir da outra — dava para o main receber "abra o modal" e nada
 * aparecer na tela, até o prazo de 10 s vencer sozinho.
 */
export const useImpactoDoNucleo = create<ImpactoDoNucleo>((set, get) => ({
  porComunidade: null,
  observadores: 0,

  async ler() {
    try {
      const linhas = await api.hostExitImpact();
      const mapa = new Map(linhas.map((l) => [l.communityId, l]));
      set({ porComunidade: mapa });
      return mapa;
    } catch {
      // Núcleo reiniciando ou sem identidade. **Não se apaga o que já se sabia** — mas
      // quem decide fechar a janela relê antes de decidir, justamente porque o que está
      // aqui pode ser de minutos atrás.
      return null;
    }
  },

  observar() {
    const primeiro = get().observadores === 0;
    set((s) => ({ observadores: s.observadores + 1 }));
    if (primeiro) {
      void get().ler();
      // O impacto muda a cada pessoa que entra ou sai, e a cada op que replica. Cadência
      // baixa de propósito: isto é um número de modal, não um medidor.
      timerDaSondagem = setInterval(() => void get().ler(), 3_000);
    }
    return () => {
      const restantes = get().observadores - 1;
      set({ observadores: restantes });
      if (restantes === 0 && timerDaSondagem !== null) {
        clearInterval(timerDaSondagem);
        timerDaSondagem = null;
      }
    };
  },
}));

let timerDaSondagem: ReturnType<typeof setInterval> | null = null;

/** Liga a sondagem enquanto o componente estiver montado. */
export function useSondarImpacto(): Map<string, LinhaDeImpacto> | null {
  const observar = useImpactoDoNucleo((s) => s.observar);
  useEffect(() => observar(), [observar]);
  return useImpactoDoNucleo((s) => s.porComunidade);
}

/**
 * Quem perde o quê se este dispositivo fechar agora (§10, 3.5).
 *
 * Só conta comunidade hospedada aqui: fechar o app sem hospedar nada é
 * rotina, e 3.5 é explícito em que o aviso não aparece nesse caso. A própria
 * identidade nunca entra na conta — o custo do fechamento é o que ele faz com
 * **os outros**.
 *
 * **A armadilha do Zustand v5, de novo.** Montar a lista dentro do seletor
 * devolve array novo a cada chamada e o app entra em "Maximum update depth"
 * no instante em que o shell monta — `useShallow` não salva, porque cada
 * item também é objeto novo. A saída é a mesma da Parte 4: o seletor devolve
 * referências já estáveis (`useJoinedCommunities`) e a lista é derivada num
 * `useMemo`.
 */
export function useHostedImpact(): HostedImpact[] {
  const communities = useJoinedCommunities();
  const doNucleo = useSondarImpacto();
  const euId = useIdentityStore((state) => state.identity?.id);
  const voiceCommunityId = useVoiceStore((state) => state.communityId);
  // **Sem mim.** Quem vai fechar a janela não é afetado por ela: contar-se junto
  // produzia "0 pessoas online, 1 numa chamada de voz" — a chamada onde a pessoa
  // estava sozinha, oferecida como motivo para não fechar o app.
  const outrosNaChamada = useVoiceStore(
    (state) =>
      state.participants.filter((p) => p.identityId !== state.localId).length,
  );

  return useMemo(
    () => montarImpacto({ communities, doNucleo, euId, voiceCommunityId, outrosNaChamada }),
    [communities, euId, voiceCommunityId, outrosNaChamada, doNucleo],
  );
}

/**
 * A conta de `useHostedImpact`, sem React — para quem precisa dela **agora**, sobre uma
 * leitura recém-feita, e não sobre o que o último render capturou (U-06).
 */
export function montarImpacto(args: {
  communities: readonly Community[];
  doNucleo: Map<string, LinhaDeImpacto> | null;
  euId: string | undefined;
  voiceCommunityId: string | null;
  outrosNaChamada: number;
}): HostedImpact[] {
  const { communities, doNucleo, euId, voiceCommunityId, outrosNaChamada } = args;
  const impact: HostedImpact[] = [];
  for (const community of communities) {
    if (!community.isHostedByMe) continue;

    const nucleo = doNucleo?.get(community.id);
    const online =
      nucleo?.onlineCount ??
      membrosDaComunidade(community.id).filter(
        (member) => member.presence !== "offline" && member.identityId !== euId,
      ).length;
    const inCall = nucleo?.inCallCount ?? (voiceCommunityId === community.id ? outrosNaChamada : 0);
    // Sem leitura completa não há o que afirmar sobre o disco dos outros; com leitura
    // completa e a comunidade ausente da resposta, o núcleo não a considera hospedada
    // e o zero é dele, não nosso.
    const pendingReplication = doNucleo === null ? null : (nucleo?.pendingReplication ?? 0);

    // Op pendente conta como impacto por si só: fechar com gente zero e fila cheia é
    // exatamente o caso em que §18.7 existe, e o modal antigo não abria. E impacto
    // **não medido** também conta: é o caso de não poder dizer que não há.
    if (online > 0 || inCall > 0 || pendingReplication === null || pendingReplication > 0) {
      impact.push({ community, online, inCall, pendingReplication });
    }
  }
  return impact;
}

/**
 * Registra o `beforeunload` enquanto houver gente conectada a uma comunidade
 * hospedada aqui. É o máximo que o NAVEGADOR permite; a interface de §10 (3.5)
 * é o `HostExitDialog`.
 *
 * **No Electron ele não entra, e a diferença não é de estilo — é o defeito de
 * "o app não fecha quando você é o host" (§92).** No navegador, `preventDefault`
 * num `beforeunload` faz o browser PERGUNTAR, e quem decide é a pessoa. No
 * Electron não há pergunta: o `preventDefault` **veta o fechamento em silêncio**,
 * para sempre. Medido em harness próprio — mesma janela, única diferença o
 * listener: com ele, três `close()` seguidos disparam o evento `close` e o
 * `closed` nunca chega, `window-all-closed` nunca chega, `app.quit()` nunca é
 * chamado; sem ele, a primeira chamada fecha.
 *
 * E o gatilho era exatamente "ser host com gente online" (`hostedImpact`), que é
 * a frase do relato. Os dois guardas estavam empilhados: o de web vetava a saída
 * que o de Electron — o main segurando o `close` e perguntando o impacto (U-06) —
 * tinha acabado de conceder. Nem "Fechar mesmo assim" escapava: `confirmExit`
 * mandava `mainWindow.close()` e o `beforeunload` engolia.
 *
 * Fora do Electron ele continua sendo a única defesa que existe, e continua ligado.
 */
export function useBeforeUnloadWarning(enabled: boolean): void {
  useEffect(() => {
    // Com shell, quem cuida da saída é o main (U-06). Empilhar os dois trava a janela.
    if (!enabled || pontePresente()) return;
    function handler(event: BeforeUnloadEvent) {
      event.preventDefault();
    }
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [enabled]);
}
