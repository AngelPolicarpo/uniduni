import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { Select } from "../../components/ui/Select";
import { TextArea } from "../../components/ui/TextArea";
import { api } from "../../ipc/api";
import { codigoDoErro } from "../../ipc/frames";
import { TIMEOUT_OPTIONS } from "../../store/moderationStore";
import {
  sincronizarMembros,
  sincronizarModeracao,
} from "../../live/sincronizacao";
import { useToastStore } from "../../store/toastStore";

export type ModerationKind = "kick" | "ban" | "timeout";

const TITLE: Record<ModerationKind, string> = {
  kick: "Expulsar",
  ban: "Banir",
  timeout: "Aplicar timeout",
};

/** Uma frase por recusa de §8.7 — a hierarquia é do fold, o texto é da tela. */
function motivoDaRecusa(code: string, targetLabel: string): string {
  switch (code) {
    case "E_HIERARCHY":
      return `${targetLabel} tem cargo igual ou acima do seu.`;
    case "E_FOUNDER_IMMUNE":
      return "O Fundador não pode ser alvo de moderação.";
    case "E_HOST_IMMUNE":
      return "Quem hospeda a comunidade não pode ser alvo de moderação.";
    case "E_SELF_TARGET":
      return "Esta ação não se aplica a você mesmo.";
    case "E_PERMISSION_DENIED":
      return "Seu cargo não tem permissão para esta ação.";
    case "E_NOT_FOUND":
      return `${targetLabel} não está mais na comunidade.`;
    case "E_HOST_UNAVAILABLE":
      return "Sem conexão com o host agora. Tente novamente.";
    default:
      return `Não foi possível aplicar (${code}).`;
  }
}

export interface ModerationDialogProps {
  kind: ModerationKind;
  communityId: string;
  targetId: string;
  targetLabel: string;
  byId: string;
  onClose: () => void;
  /** Chamado depois de aplicar — D12 usa para sumir com o alvo da tela. */
  onApplied?: () => void;
}

/**
 * Confirmação de ação de moderação (§11, D12 · §15).
 *
 * Nunca é ação de um clique só, e o texto nomeia a consequência exata em vez
 * de perguntar "tem certeza?". No ban são DUAS notas obrigatórias, não uma: a
 * de honestidade de §10 (3.3) — banir não impede tecnicamente que a pessoa
 * volte com identidade nova — e a de `L-7` (§6.12 do `backend-v2.md`), que a
 * spec do núcleo obriga a UI a dizer **neste** modal: o ban corta a replicação
 * futura, mas não retira do alvo o que ele já replicou para a máquina dele.
 * Sem a segunda, o moderador aplica o ban achando que apagou o histórico da
 * pessoa, o que o produto nunca fez.
 *
 * A escrita é op ⏱ de §15.4 (`mod.*`) e a decisão de hierarquia é DO FOLD —
 * a tela nunca decide quem pode em quem, só traduz a recusa nomeada.
 */
export function ModerationDialog({
  kind,
  communityId,
  targetId,
  targetLabel,
  byId,
  onClose,
  onApplied,
}: ModerationDialogProps) {
  void byId;
  const [reason, setReason] = useState("");
  const [duration, setDuration] = useState(TIMEOUT_OPTIONS[0].value);
  const [recusa, setRecusa] = useState<string | null>(null);
  const [aplicando, setAplicando] = useState(false);
  const showToast = useToastStore((state) => state.showToast);

  async function apply(): Promise<void> {
    if (aplicando) return;
    setAplicando(true);
    setRecusa(null);
    const motivo = reason.trim() || undefined;
    try {
      if (kind === "ban") {
        await api.modBan({ communityId, targetKey: targetId, ...(motivo !== undefined ? { reason: motivo } : {}) });
        showToast(`${targetLabel} foi banido`);
      } else if (kind === "kick") {
        await api.modKick({ communityId, targetKey: targetId, ...(motivo !== undefined ? { reason: motivo } : {}) });
        showToast(`${targetLabel} foi expulso`);
      } else {
        await api.modTimeout({
          communityId,
          targetKey: targetId,
          until: Date.now() + Number(duration) * 60_000,
          ...(motivo !== undefined ? { reason: motivo } : {}),
        });
        showToast(`Timeout aplicado em ${targetLabel}`);
      }
      // A auditoria, os bans e o roster vêm do núcleo por evento; a reconsulta
      // aqui só antecipa o espelho para a tela que disparou a ação.
      void sincronizarModeracao(communityId);
      void sincronizarMembros(communityId);
      onApplied?.();
      onClose();
    } catch (e) {
      setRecusa(motivoDaRecusa(codigoDoErro(e), targetLabel));
    } finally {
      setAplicando(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`${TITLE[kind]} ${targetLabel}?`}
      size="sm"
    >
      <div className="flex flex-col gap-4">
        <p className="text-body text-text-secondary">
          {kind === "ban" &&
            `${targetLabel} não consegue mais entrar nesta comunidade com esta identidade, e as mensagens dele saem do canal.`}
          {kind === "kick" &&
            `${targetLabel} sai da comunidade agora, mas pode voltar com um convite válido.`}
          {kind === "timeout" &&
            `${targetLabel} fica sem enviar mensagens nem falar em voz durante o período escolhido.`}
        </p>

        {kind === "timeout" && (
          <Select
            label="Duração"
            value={duration}
            options={TIMEOUT_OPTIONS}
            onChange={setDuration}
          />
        )}

        <TextArea
          label="Motivo (opcional)"
          value={reason}
          onChange={setReason}
          maxLength={200}
          showCounter
          rows={2}
          hint="Vai para o log de auditoria como texto livre."
        />

        {recusa !== null && (
          <p role="alert" className="rounded-md border border-feedback-danger/40 bg-surface-primary p-3 text-meta text-feedback-danger">
            {recusa}
          </p>
        )}

        {kind === "ban" && (
          <div className="flex flex-col gap-2">
            <p className="rounded-md border border-border-default bg-surface-primary p-3 text-meta text-text-secondary">
              Banir impede a entrada com esta identidade específica. Como não há
              autoridade central, a pessoa pode tecnicamente voltar com uma
              identidade nova através de outro convite.
            </p>
            {/* L-7 (§6.12) — declaração obrigatória, e obrigatoriamente aqui. */}
            <p className="rounded-md border border-border-default bg-surface-primary p-3 text-meta text-text-secondary">
              O ban também não apaga nada da máquina de {targetLabel}: ele corta a
              replicação daqui para a frente, mas o que já foi replicado continua no
              dispositivo dele.
            </p>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="danger" onClick={() => void apply()} disabled={aplicando}>
            {TITLE[kind]}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
