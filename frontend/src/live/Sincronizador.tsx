/**
 * Ponte entre o ciclo do núcleo e a árvore de componentes do produto.
 *
 * Não desenha interface do produto: as telas são as do mock, intactas. O que este componente
 * faz é (a) subir a sessão IPC-R, (b) manter o espelho das stores em dia conforme a
 * comunidade e o canal ativos mudam, e (c) segurar a árvore enquanto não há núcleo — porque
 * mostrar o shell sem dado nenhum seria pior que dizer que ainda está conectando.
 *
 * O gate de primeiro uso **não** é daqui: `identityStore.identity === null` já leva o
 * `RootRoute` do mock ao Onboarding, e é o `query.identity` que decide isso agora.
 */

import { useEffect, useState, type ReactNode } from "react";
import { useSessao } from "./sessao";
import {
  abrirComunidade,
  assinarTypingDoCanal,
  iniciarSincronizacao,
  reconectarSincronizacao,
  sincronizarMensagens,
} from "./sincronizacao";
import { useCommunityStore } from "../store/communityStore";
import { Button } from "../components/ui/Button";

function Aviso({ titulo, texto, acao }: { titulo: string; texto: string; acao?: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center bg-surface-app p-6">
      <div className="max-w-md text-center">
        <h1 className="text-h2 text-text-primary">{titulo}</h1>
        <p className="mt-2 text-meta text-text-secondary">{texto}</p>
        {acao !== undefined && <div className="mt-5 flex justify-center">{acao}</div>}
      </div>
    </div>
  );
}

/**
 * §15.2 — o núcleo pode voltar depois de a tela desistir de esperar, e antes deste botão a
 * única saída era recarregar a janela inteira (que, por §15.2, é o caminho MAIS caro:
 * derruba as conexões P2P e paga a barreira de §18.7).
 */
function BotaoDeReconectar() {
  const [tentando, setTentando] = useState(false);
  return (
    <Button
      disabled={tentando}
      onClick={() => {
        setTentando(true);
        void reconectarSincronizacao().finally(() => setTentando(false));
      }}
    >
      {tentando ? "Tentando…" : "Tentar novamente"}
    </Button>
  );
}

export function Sincronizador({ children }: { children: ReactNode }) {
  const estado = useSessao((s) => s.estado);
  const motivo = useSessao((s) => s.motivo);
  const communityId = useCommunityStore((s) => s.activeCommunityId);
  const channelId = useCommunityStore((s) =>
    s.activeCommunityId ? (s.activeChannelByCommunity[s.activeCommunityId] ?? null) : null,
  );
  // O zustand persist restaura comunidade/canal ativos ANTES da porta IPC-R chegar:
  // consultar nesse instante é E_NO_PORT na primeira carga (§59). As consultas de
  // mensagem não têm o resync de rede para tentar de novo — só quando há sessão.
  const pronto = estado === "pronto";

  useEffect(() => {
    void iniciarSincronizacao();
  }, []);

  useEffect(() => {
    if (pronto && communityId !== null) void abrirComunidade(communityId);
  }, [pronto, communityId]);

  useEffect(() => {
    if (pronto && communityId !== null && channelId !== null) void sincronizarMensagens(communityId, channelId);
  }, [pronto, communityId, channelId]);

  // §17.6/§15.4 — o interesse em "digitando…" é declarado por quem abre o canal, e desfeito
  // por quem o fecha. Sem isto o host não tinha a quem mandar `typing.changed`.
  useEffect(() => {
    if (!pronto || communityId === null) return;
    assinarTypingDoCanal(communityId, channelId);
  }, [pronto, communityId, channelId]);

  if (estado === "sem-shell") {
    return (
      <Aviso
        titulo="Sem núcleo"
        texto={motivo ?? "Esta janela não está rodando dentro do shell Electron do produto."}
      />
    );
  }
  if (estado === "falhou") {
    return <Aviso titulo="O núcleo não respondeu" texto={motivo ?? ""} acao={<BotaoDeReconectar />} />;
  }
  if (estado === "inicial" || estado === "conectando") {
    return <Aviso titulo="Conectando ao núcleo" texto="Um instante." />;
  }
  return <>{children}</>;
}
