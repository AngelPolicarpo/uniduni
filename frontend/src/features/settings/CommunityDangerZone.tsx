import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { DangerZone } from "./SettingsLayout";
import { api } from "../../ipc/api";
import { codigoDoErro } from "../../ipc/frames";
import { sincronizarComunidades } from "../../live/sincronizacao";
import { motivoDaRecusa } from "../../live/recusas";
import { useVoiceStore } from "../../store/voiceStore";
import type { Community } from "../../domain/types";

/**
 * Sair e encerrar (§10, 3.1b) — coisas diferentes no fio.
 *
 * `community.leave` tem **efeito local imediato** e enfileira o `member.leave`
 * (§15.4, L-22) — é a exceção de §11.1, e é o que sustenta U-29: dá para sair
 * com o host offline. `community.end` é main-confirmed e só o host corrente
 * pode; o `reqConfirmado` cuida do diálogo nativo.
 */
export function CommunityDangerZone({
  community,
  semHost,
  onClose,
}: {
  community: Community;
  semHost: boolean;
  onClose: () => void;
}) {
  const leaveVoice = useVoiceStore((state) => state.leave);
  const voiceCommunityId = useVoiceStore((state) => state.communityId);

  const [confirmingLeave, setConfirmingLeave] = useState(false);
  const [confirmingEnd, setConfirmingEnd] = useState(false);
  const [endStep, setEndStep] = useState(1);
  const [saindo, setSaindo] = useState(false);
  const [recusa, setRecusa] = useState<string | null>(null);

  async function closeAndLeave(end: boolean) {
    if (saindo) return;
    setSaindo(true);
    setRecusa(null);
    try {
      if (end) await api.communityEnd({ communityId: community.id });
      else await api.communityLeave(community.id);
      // Sair da comunidade que hospeda a chamada encerra a chamada junto.
      if (voiceCommunityId === community.id) leaveVoice();
      await sincronizarComunidades();
      onClose();
    } catch (e) {
      // §15.3 — cancelar o diálogo nativo é desfecho normal, não falha: a pessoa desistiu
      // e a tela não a acusa por isso (mesma forma de sincronizacao.ts/Composer).
      if (codigoDoErro(e) !== "E_CANCELLED") {
        setRecusa(motivoDaRecusa(codigoDoErro(e)));
      }
    } finally {
      setSaindo(false);
    }
  }

  return (
    <>
      <DangerZone>
        {community.isHostedByMe ? (
          <>
            <p className="text-body text-text-secondary">
              Você hospeda {community.name} neste dispositivo. Quem é host
              não sai da própria comunidade — precisa encerrá-la.
            </p>
            <Button
              variant="danger"
              size="sm"
              className="self-start"
              onClick={() => {
                setEndStep(1);
                setConfirmingEnd(true);
              }}
            >
              Encerrar comunidade
            </Button>
          </>
        ) : (
          <>
            <p className="text-body text-text-secondary">
              Sair remove {community.name} do seu rail. Para voltar você
              precisa de um convite novo.
            </p>
            <Button
              variant="danger"
              size="sm"
              className="self-start"
              onClick={() => setConfirmingLeave(true)}
            >
              Sair da comunidade
            </Button>
          </>
        )}

        {recusa !== null && (
          <p role="alert" className="rounded-md border border-feedback-danger/40 bg-surface-primary p-3 text-meta text-feedback-danger">
            {recusa}
          </p>
        )}
      </DangerZone>

      {confirmingLeave && (
        <Modal
          open
          onClose={() => setConfirmingLeave(false)}
          title={`Sair de ${community.name}?`}
          size="sm"
        >
          <div className="flex flex-col gap-4">
            <p className="text-body text-text-secondary">
              Você deixa de receber as mensagens de {community.name} e some da
              lista de membros. Voltar exige um convite novo.
            </p>
            {/* U-29 — texto obrigatório: a saída é local na hora, o aviso é assíncrono. */}
            {semHost && (
              <p className="rounded-md border border-border-default bg-surface-sidebar p-3 text-meta text-text-tertiary">
                Você vai sair agora neste computador. Como quem hospeda está
                offline, as outras pessoas só vão ver sua saída quando ela voltar.
              </p>
            )}
            <div className="mt-2 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setConfirmingLeave(false)}>
                Cancelar
              </Button>
              <Button variant="danger" loading={saindo} onClick={() => void closeAndLeave(false)}>
                Sair da comunidade
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Dupla confirmação: encerrar desconecta todo mundo (§10, 3.1b). */}
      {confirmingEnd && (
        <Modal
          open
          onClose={() => setConfirmingEnd(false)}
          title={`Encerrar ${community.name}?`}
          size="sm"
        >
          <div className="flex flex-col gap-4">
            <p className="text-body text-text-secondary">
              {endStep === 1
                ? "Isso desconecta todos os membros permanentemente. Não pode ser desfeito."
                : `Confirme mais uma vez: ${community.memberCount} ${
                    community.memberCount === 1 ? "pessoa perde" : "pessoas perdem"
                  } o acesso a todo o histórico assim que a comunidade for encerrada.`}
            </p>
            <div className="mt-2 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setConfirmingEnd(false)}>
                Cancelar
              </Button>
              <Button
                variant="danger"
                loading={saindo}
                onClick={() =>
                  endStep === 1 ? setEndStep(2) : void closeAndLeave(true)
                }
              >
                {endStep === 1 ? "Continuar" : "Encerrar para sempre"}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
