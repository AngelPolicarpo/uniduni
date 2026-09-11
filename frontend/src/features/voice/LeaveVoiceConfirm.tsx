import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import type { LeaveVoiceGuard } from "./leaveGuard";

/**
 * Confirmação de saída com compartilhamento ativo (§11, C11 — exceções). A
 * regra de quando ela aparece está em `useLeaveVoiceGuard`; aqui só o modal,
 * que nomeia a consequência exata em vez de perguntar "tem certeza?" (§15).
 */
export function LeaveVoiceConfirm({ guard }: { guard: LeaveVoiceGuard }) {
  if (!guard.confirming) return null;

  return (
    <Modal open onClose={guard.cancel} title="Sair da chamada?" size="sm">
      <div className="flex flex-col gap-4">
        <p className="text-body text-text-secondary">
          Você está compartilhando sua tela. Sair também encerra o
          compartilhamento?
        </p>
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="secondary" onClick={guard.cancel}>
            Cancelar
          </Button>
          <Button variant="danger" onClick={guard.confirm}>
            Sair e encerrar
          </Button>
        </div>
      </div>
    </Modal>
  );
}
