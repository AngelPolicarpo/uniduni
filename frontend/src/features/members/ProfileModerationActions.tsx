import { useState } from "react";
import { Check } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/cn";
import { AVATAR_BG_CLASS } from "../../lib/avatar";
import { api } from "../../ipc/api";
import {
  selectCanModerate,
  selectLocalTopPosition,
  selectMemberRoleIds,
  useCommunityStore,
  useHasPermission,
  useLocalMemberId,
  useRoles,
} from "../../store/communityStore";
import {
  ModerationDialog,
  type ModerationKind,
} from "../moderation/ModerationDialog";

export interface ProfileModerationActionsProps {
  communityId: string;
  identityId: string;
  targetLabel: string;
  /** Envia a op e trata a recusa — vem do popover, que mostra o aviso. */
  escrever: (acao: () => Promise<void>) => void;
  onClose: () => void;
}

/**
 * Ações condicionais à permissão (§8, 1.4 · §10). Item que a permissão ou a
 * hierarquia não autoriza não aparece — nunca aparece desabilitado (§15).
 *
 * A checagem inteira mora aqui: quem monta o popover não precisa saber quais
 * permissões existem para decidir se a seção sai na tela.
 */
export function ProfileModerationActions({
  communityId,
  identityId,
  targetLabel,
  escrever,
  onClose,
}: ProfileModerationActionsProps) {
  /**
   * Regra de hierarquia de §10: só dá para moderar quem está abaixo de você,
   * e o Fundador nunca é alvo. Sem isso, cada ação teria de repetir a
   * checagem — e uma delas acabaria esquecendo.
   */
  const canModerate = useCommunityStore((state) =>
    selectCanModerate(state, communityId, identityId),
  );
  const canManageRoles = useHasPermission(communityId, "manage_roles");
  const canKick = useHasPermission(communityId, "kick_members");
  const canBan = useHasPermission(communityId, "ban_members");
  const canTimeout = useHasPermission(communityId, "timeout_members");

  const communityRoles = useRoles(communityId);
  const assignedRoleIds = useCommunityStore((state) =>
    selectMemberRoleIds(state, communityId, identityId).join("|"),
  );
  const localMemberId = useLocalMemberId(communityId);
  // `topRank(autor)` de §9.3: cargo com `rank ≥` o meu é `E_HIERARCHY` por R-4, então não é
  // oferecido. O cargo Fundador sai antes disso, por `E_FOUNDER_IMMUTABLE`.
  const minhaPosicao = useCommunityStore((state) =>
    selectLocalTopPosition(state, communityId),
  );

  const [assigning, setAssigning] = useState(false);
  const [moderation, setModeration] = useState<ModerationKind | null>(null);

  const assigned = assignedRoleIds === "" ? [] : assignedRoleIds.split("|");
  // Conjunto: a lista de cargos atribuídos é consultada uma vez por cargo da comunidade.
  const atribuidos = new Set(assigned);

  if (!canModerate || !(canManageRoles || canKick || canBan || canTimeout))
    return null;

  return (
    <>
      <div className="flex flex-col gap-2 border-t border-border-subtle pt-4">
        {canManageRoles && (
          <>
            <Button
              variant="secondary"
              size="sm"
              fullWidth
              aria-expanded={assigning}
              onClick={() => setAssigning((open) => !open)}
            >
              Atribuir cargo
            </Button>

            {assigning && (
              <ul className="flex flex-col gap-1">
                {communityRoles
                  .filter(
                    (role) =>
                      !role.isFounder &&
                      // O cargo base é de todo mundo (R-3): não se atribui nem se retira.
                      !role.isDefault &&
                      minhaPosicao > role.position,
                  )
                  .map((role) => {
                    const has = atribuidos.has(role.id);
                    return (
                      <li key={role.id}>
                        <button
                          type="button"
                          aria-pressed={has}
                          onClick={() =>
                            escrever(async () => {
                              await api.memberSetRoles({
                                communityId,
                                targetKey: identityId,
                                roleIds: has
                                  ? assigned.filter((id) => id !== role.id)
                                  : [...assigned, role.id],
                              });
                            })
                          }
                          className={cn(
                            "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-body",
                            "transition-colors duration-(--duration-fast) ease-out",
                            has
                              ? "bg-accent-muted-bg text-text-primary"
                              : "text-text-secondary hover:bg-surface-primary",
                          )}
                        >
                          <span
                            className={cn(
                              "size-2 shrink-0 rounded-full",
                              AVATAR_BG_CLASS[role.color],
                            )}
                            aria-hidden="true"
                          />
                          <span className="min-w-0 flex-1 truncate">
                            {role.name || "Cargo sem nome"}
                          </span>
                          {has && <Check size={16} strokeWidth={2} aria-hidden="true" />}
                        </button>
                      </li>
                    );
                  })}
              </ul>
            )}
          </>
        )}

        {canTimeout && (
          <Button
            variant="secondary"
            size="sm"
            fullWidth
            onClick={() => setModeration("timeout")}
          >
            Aplicar timeout
          </Button>
        )}
        {canKick && (
          <Button
            variant="danger"
            size="sm"
            fullWidth
            onClick={() => setModeration("kick")}
          >
            Expulsar
          </Button>
        )}
        {canBan && (
          <Button
            variant="danger"
            size="sm"
            fullWidth
            onClick={() => setModeration("ban")}
          >
            Banir
          </Button>
        )}
      </div>

      {moderation && (
        <ModerationDialog
          kind={moderation}
          communityId={communityId}
          targetId={identityId}
          targetLabel={targetLabel}
          byId={localMemberId}
          onClose={() => setModeration(null)}
          onApplied={onClose}
        />
      )}
    </>
  );
}
