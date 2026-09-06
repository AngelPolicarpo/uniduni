import { useEffect } from "react";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { api } from "../../ipc/api";
import type { ResolvedMessageLink } from "../../ipc/dto";
import { useDeeplinks } from "../../live/deeplink";
import { useSessao } from "../../live/sessao";
import { useCommunityStore } from "../../store/communityStore";
import { useToastStore } from "../../store/toastStore";
import { useUiStore } from "../../store/uiStore";

/**
 * §3.5 `m/<MSGREF>` — a superfície dos cinco desfechos de §15.6.
 *
 * O store de deep link já chamava `query.resolveMessageLink` e guardava o resultado; o que
 * não existia era **quem o desenhasse**. Sem este componente, um `comunidadep2p://m/…`
 * resolvia no núcleo, escrevia num store que ninguém lia e não produzia efeito visível
 * nenhum — o mesmo defeito que a emenda de §3.5 já tinha corrigido para `u/<KEY64>`.
 *
 * Não confundir com `MessageLinkResolver`: aquele consome o link **interno** do produto
 * (`/m/:code`, a rota do `MemoryRouter` com a referência empacotada pela própria interface).
 * Este consome o MSGREF de §3.5, que é decidido pelo núcleo.
 *
 * Os desfechos de falha nunca revelam conteúdo (§15.6): quem não é membro não fica sabendo
 * o nome do canal nem se a mensagem existe.
 */
export function DeepLinkMensagem() {
  const mensagem = useDeeplinks((s) => s.mensagem);
  const definirResultado = useDeeplinks((s) => s.definirResultado);
  const fechar = useDeeplinks((s) => s.fecharMensagem);
  // §15.6 é query do núcleo: sem sessão, a chamada é `E_NO_PORT` e o desfecho seria
  // `malformed`. O link espera o núcleo em vez de ser declarado inválido por ter chegado
  // antes dele.
  const comNucleo = useSessao((s) => s.estado === "pronto" || s.estado === "sem-identidade");
  const setActiveCommunity = useCommunityStore((s) => s.setActiveCommunity);
  const setActiveChannel = useCommunityStore((s) => s.setActiveChannel);
  const highlightMessage = useUiStore((s) => s.highlightMessage);
  const abrirComunidades = useUiStore((s) => s.abrirComunidades);
  const openJoinCommunity = useUiStore((s) => s.openJoinCommunity);
  const showToast = useToastStore((s) => s.showToast);

  const resultado = mensagem?.resultado ?? null;
  const refPendente = mensagem !== null && mensagem.resultado === null ? mensagem.ref : null;

  useEffect(() => {
    if (refPendente === null || !comNucleo) return;
    let vivo = true;
    void api
      .resolveMessageLink(refPendente)
      .catch<ResolvedMessageLink>(() => ({ status: "malformed" }))
      .then((r) => {
        if (vivo) definirResultado(refPendente, r);
      });
    return () => {
      vivo = false;
    };
  }, [refPendente, comNucleo, definirResultado]);

  useEffect(() => {
    if (resultado === null || resultado.status !== "ok") return;
    // §3.5 regra 3 continua valendo: navegar até a mensagem é posicionar, não agir.
    abrirComunidades();
    setActiveCommunity(resultado.communityId);
    setActiveChannel(resultado.communityId, resultado.channelId);
    highlightMessage(resultado.messageId);
    fechar();
  }, [
    resultado,
    abrirComunidades,
    setActiveCommunity,
    setActiveChannel,
    highlightMessage,
    fechar,
  ]);

  // `not-synced`: a mensagem existe do outro lado e ainda não chegou aqui (§15.6). O canal
  // NÃO vem nesse desfecho — sem a projeção da op, ninguém sabe em qual ela cairia (emenda
  // de 2026-08-22) — então o que dá para fazer é abrir a comunidade e dizer o que houve.
  useEffect(() => {
    if (resultado === null || resultado.status !== "not-synced") return;
    abrirComunidades();
    setActiveCommunity(resultado.communityId);
    showToast("Esta mensagem ainda não chegou neste dispositivo");
    fechar();
  }, [resultado, abrirComunidades, setActiveCommunity, showToast, fechar]);

  if (mensagem === null) return null;

  // Resolvendo: o link já foi aceito e a resposta é ⏱ contra o núcleo.
  if (resultado === null) {
    return (
      <Modal open onClose={fechar} title="Abrindo o link" size="sm">
        <p className="text-body text-text-secondary">Um instante.</p>
      </Modal>
    );
  }

  if (resultado.status === "ok" || resultado.status === "not-synced") return null;

  if (resultado.status === "deleted") {
    return (
      <Modal open onClose={fechar} title="Esta mensagem não existe mais" size="sm">
        <div className="flex flex-col gap-5">
          <p className="text-body text-text-secondary">
            Quem escreveu apagou a mensagem para todo mundo.
          </p>
          <div className="flex justify-end">
            <Button onClick={fechar}>Fechar</Button>
          </div>
        </div>
      </Modal>
    );
  }

  if (resultado.status === "malformed") {
    return (
      <Modal open onClose={fechar} title="Este link não é válido" size="sm">
        <div className="flex flex-col gap-5">
          <p className="text-body text-text-secondary">
            O link chegou incompleto ou alterado. Peça o link de novo a quem o enviou.
          </p>
          <div className="flex justify-end">
            <Button onClick={fechar}>Fechar</Button>
          </div>
        </div>
      </Modal>
    );
  }

  // `not-member` — a mesma resposta para quem nunca entrou e para quem saiu (§18).
  return (
    <Modal open onClose={fechar} title="Este link não abre aqui" size="sm">
      <div className="flex flex-col gap-5">
        <p className="text-body text-text-secondary">
          Este link é de uma comunidade da qual você não faz parte. Sem um convite não
          há como entrar — não existe diretório público de comunidades.
        </p>
        <div className="flex flex-col gap-3 tablet:flex-row tablet:justify-end">
          <Button variant="secondary" onClick={fechar}>
            Fechar
          </Button>
          <Button
            onClick={() => {
              fechar();
              openJoinCommunity("manual");
            }}
          >
            Colar um convite
          </Button>
        </div>
      </div>
    </Modal>
  );
}
