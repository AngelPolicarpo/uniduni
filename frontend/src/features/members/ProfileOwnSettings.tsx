import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { TextField } from "../../components/ui/TextField";
import { cn } from "../../lib/cn";
import { PRESENCE_LABEL } from "../../lib/avatar";
import { api } from "../../ipc/api";
import { useIdentityStore } from "../../store/identityStore";
import { useUiStore } from "../../store/uiStore";
import type { PresenceStatus } from "../../domain/types";

/** Os quatro estados de §2/§5.4, na ordem em que aparecem no seletor. */
const PRESENCE_OPTIONS: PresenceStatus[] = [
  "online",
  "idle",
  "dnd",
  "invisible",
];

export interface ProfileOwnSettingsProps {
  communityId: string;
  /** Rótulo em uso hoje (apelido, se houver). */
  label: string;
  displayName: string;
  /** Envia a op e trata a recusa — vem do popover, que mostra o aviso. */
  escrever: (acao: () => Promise<void>) => void;
  onClose: () => void;
}

/**
 * Perfil próprio: apelido, presença e atalho para 3.1 — as ações de
 * moderação nunca apontam para si mesma (§8, 1.4).
 */
export function ProfileOwnSettings({
  communityId,
  label,
  displayName,
  escrever,
  onClose,
}: ProfileOwnSettingsProps) {
  const identityPresence = useIdentityStore(
    (state) => state.identity?.presence ?? "online",
  );
  const setPresence = useIdentityStore((state) => state.setPresence);
  const openAccountSettings = useUiStore((state) => state.openAccountSettings);

  const [editingNickname, setEditingNickname] = useState(false);
  const [nicknameDraft, setNicknameDraft] = useState("");

  return (
    <div className="flex flex-col gap-3 border-t border-border-subtle pt-4">
      {editingNickname ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            escrever(async () => {
              await api.memberSetNickname({ communityId, nickname: nicknameDraft });
              setEditingNickname(false);
            });
          }}
        >
          <TextField
            label="Apelido nesta comunidade"
            value={nicknameDraft}
            onChange={setNicknameDraft}
            limiteCp={32}
            showCounter
            autoFocus
            autoComplete="off"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                setEditingNickname(false);
              }
            }}
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm">
              Salvar
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                escrever(async () => {
                  await api.memberSetNickname({ communityId, nickname: null });
                  setEditingNickname(false);
                })
              }
            >
              Usar meu nome
            </Button>
          </div>
        </form>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          fullWidth
          onClick={() => {
            setNicknameDraft(label === displayName ? "" : label);
            setEditingNickname(true);
          }}
        >
          Editar apelido nesta comunidade
        </Button>
      )}

      <div>
        <p className="text-caption text-text-tertiary uppercase">Presença</p>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {PRESENCE_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={identityPresence === option}
              onClick={() => setPresence(option)}
              className={cn(
                "rounded-full border px-2 py-0.5 text-meta",
                "transition-colors duration-(--duration-fast) ease-out",
                identityPresence === option
                  ? "border-accent-default bg-accent-muted-bg text-text-primary"
                  : "border-border-default text-text-secondary hover:text-text-primary",
              )}
            >
              {PRESENCE_LABEL[option]}
            </button>
          ))}
        </div>
        {identityPresence === "invisible" && (
          <p className="mt-1.5 text-meta text-text-tertiary">
            Você aparece como offline, mas continua recebendo tudo
            normalmente.
          </p>
        )}
      </div>

      <Button
        variant="secondary"
        size="sm"
        fullWidth
        onClick={() => {
          onClose();
          openAccountSettings();
        }}
      >
        Editar perfil
      </Button>
    </div>
  );
}
