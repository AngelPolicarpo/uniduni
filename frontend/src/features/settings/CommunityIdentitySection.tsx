import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { TextArea } from "../../components/ui/TextArea";
import { TextField } from "../../components/ui/TextField";
import { SettingsSection } from "./SettingsLayout";
import { api } from "../../ipc/api";
import { codigoDoErro } from "../../ipc/frames";
import { sincronizarComunidade } from "../../live/sincronizacao";
import { motivoDaRecusa, OFFLINE_HINT } from "../../live/recusas";
import { useToastStore } from "../../store/toastStore";
import { codePoints } from "../../lib/texto";
import type { Community } from "../../domain/types";

/**
 * Nome e descrição da comunidade (§10, 3.1b).
 *
 * U-23 — este formulário também tinha auto-save; `community.update` é op ⏱ de
 * §15.4 e vale o mesmo `F-12` dos cargos e dos canais. Rascunho + botão.
 */
export function CommunityIdentitySection({
  community,
  semHost,
}: {
  community: Community;
  /** Host offline: a op não sai daqui, e o botão diz por quê. */
  semHost: boolean;
}) {
  const showToast = useToastStore((state) => state.showToast);

  const [rascunho, setRascunho] = useState<{ name: string; description: string } | null>(null);
  const draft = rascunho ?? { name: community.name, description: community.description ?? "" };
  const sujo =
    draft.name !== community.name || draft.description !== (community.description ?? "");
  const [salvando, setSalvando] = useState(false);
  const [recusa, setRecusa] = useState<string | null>(null);

  async function salvarIdentidade() {
    if (salvando || !sujo) return;
    setSalvando(true);
    setRecusa(null);
    try {
      await api.communityUpdate({
        communityId: community.id,
        ...(draft.name !== community.name ? { name: draft.name.trim() } : {}),
        ...(draft.description !== (community.description ?? "")
          ? { description: draft.description.trim() }
          : {}),
      });
      await sincronizarComunidade(community.id);
      setRascunho(null);
      showToast("Alterações salvas", "success");
    } catch (e) {
      setRecusa(motivoDaRecusa(codigoDoErro(e)));
    } finally {
      setSalvando(false);
    }
  }

  return (
    <SettingsSection title="Identidade da comunidade">
      <TextField
        label="Nome da comunidade"
        value={draft.name}
        onChange={(name) => setRascunho({ ...draft, name })}
        limiteCp={40}
        showCounter
        counterWarningAt={36}
        error={
          codePoints(draft.name.trim()) < 2
            ? "O nome precisa de pelo menos 2 caracteres"
            : undefined
        }
      />
      <TextArea
        label="Descrição"
        value={draft.description}
        onChange={(description) => setRascunho({ ...draft, description })}
        limiteCp={120}
        showCounter
        rows={3}
      />

      {recusa !== null && (
        <p role="alert" className="rounded-md border border-feedback-danger/40 bg-surface-primary p-3 text-meta text-feedback-danger">
          {recusa}
        </p>
      )}

      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={() => void salvarIdentidade()}
          loading={salvando}
          disabled={!sujo || semHost || codePoints(draft.name.trim()) < 2}
          title={semHost ? OFFLINE_HINT : undefined}
        >
          Salvar alterações
        </Button>
        {sujo && (
          <Button variant="ghost" size="sm" onClick={() => setRascunho(null)} disabled={salvando}>
            Descartar
          </Button>
        )}
      </div>
    </SettingsSection>
  );
}
