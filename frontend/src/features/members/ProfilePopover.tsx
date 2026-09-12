import { useShallow } from "zustand/react/shallow";
import { cn } from "../../lib/cn";
import { Avatar } from "../../components/ui/Avatar";
import { Button } from "../../components/ui/Button";
import { Popover } from "../../components/ui/Popover";
import { ROLE_TEXT_CLASS } from "../../lib/role";
import { AVATAR_BG_CLASS, PRESENCE_LABEL } from "../../lib/avatar";
import {
  selectMemberRoleIds,
  selectRole,
  useCommunityStore,
  useFindMember,
  useLocalMemberId,
  useMemberLabel,
} from "../../store/communityStore";
import { ProfileCallActions } from "./ProfileCallActions";
import { ProfileModerationActions } from "./ProfileModerationActions";
import { ProfileOwnSettings } from "./ProfileOwnSettings";
import { codigoDoErro } from "../../ipc/frames";
import { sincronizarMembros } from "../../live/sincronizacao";
import { motivoDaRecusa } from "../../live/recusas";
import { useVoiceStore } from "../../store/voiceStore";
import { useState } from "react";
import type { Role } from "../../domain/types";

const joinedFormat = new Intl.DateTimeFormat("pt-BR", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

export interface ProfilePopoverProps {
  communityId: string;
  identityId: string;
  anchor: DOMRect;
  onClose: () => void;
  /**
   * Aberto de dentro de uma chamada em que os dois estão (§9, 2.3) — libera
   * o volume individual e, com permissão, silenciar nesta chamada (§8, 1.4).
   */
  inCall?: boolean;
}

/**
 * Popover de perfil de membro (§8, 1.4) — mesmo componente para todos os
 * gatilhos: lista de membros, autor de uma mensagem, tile de participante de
 * voz e linha de participante na lista de canais (§7, 1.1).
 *
 * Aqui ficam a identificação e os cargos; cada seção condicional é um
 * componente próprio, que decide sozinho se aparece: perfil próprio
 * (`ProfileOwnSettings`), moderação (`ProfileModerationActions`) e chamada
 * em curso (`ProfileCallActions`).
 */
export function ProfilePopover({
  communityId,
  identityId,
  anchor,
  onClose,
  inCall = false,
}: ProfilePopoverProps) {
  const findMember = useFindMember();
  const member = findMember(communityId, identityId);
  const roles = useCommunityStore(
    useShallow((state) =>
      selectMemberRoleIds(state, communityId, identityId)
        .map((roleId) => selectRole(state, roleId))
        .filter((role): role is Role => role !== undefined)
        .sort((a, b) => b.position - a.position),
    ),
  );

  const isSelf = useVoiceStore((state) => state.localId === identityId);
  const alternarFixado = useVoiceStore((state) => state.alternarFixado);
  const fixado = useVoiceStore((state) => state.fixadoId === identityId);
  const localMemberId = useLocalMemberId(communityId);
  const label = useMemberLabel(communityId, identityId);

  const [recusa, setRecusa] = useState<string | null>(null);

  /**
   * Cargo de membro e apelido são ops SÍNCRONAS de §15.4 (A25/U-02). O roster volta do
   * núcleo pela reconsulta — `member.setRoles` pode inclusive devolver `appliedRoleIds`
   * diferente do pedido, porque §8.4.1 descarta id de cargo que não existe mais.
   */
  function escrever(acao: () => Promise<void>) {
    setRecusa(null);
    void (async () => {
      try {
        await acao();
        await sincronizarMembros(communityId);
      } catch (e) {
        setRecusa(motivoDaRecusa(codigoDoErro(e)));
      }
    })();
  }

  if (!member) return null;

  const showCallSection = inCall && !isSelf;
  // `isSelf` do voiceStore só vale dentro de uma chamada; aqui a pergunta é
  // sobre identidade na comunidade, não sobre a chamada.
  const isOwnProfile = identityId === localMemberId;

  return (
    <Popover anchor={anchor} onClose={onClose} label={`Perfil de ${member.displayName}`}>
      <div className="flex flex-col gap-4 p-4">
        <div className="flex items-center gap-3">
          <Avatar
            name={member.displayName}
            color={member.avatarColor}
            size="lg"
            presence={member.presence}
            presenceRingClass="border-surface-elevated"
          />
          <div className="min-w-0">
            <p className="truncate text-heading-2 text-text-primary">
              {label}
            </p>
            {label !== member.displayName && (
              <p className="truncate text-meta text-text-secondary">
                {member.displayName}
              </p>
            )}
            <p className="truncate text-meta text-text-tertiary">
              {member.handle} · {PRESENCE_LABEL[member.presence]}
            </p>
          </div>
        </div>

        {recusa !== null && (
          <p role="alert" className="rounded-md border border-feedback-danger/40 bg-surface-primary p-2 text-meta text-feedback-danger">
            {recusa}
          </p>
        )}

        {roles.length > 0 && (
          <div>
            <p className="text-caption text-text-tertiary uppercase">Cargos</p>
            <ul className="mt-1.5 flex flex-wrap gap-1">
              {roles.map((role) => (
                <li
                  key={role.id}
                  className={cn(
                    "flex items-center gap-1.5 rounded-full border border-border-default",
                    "bg-surface-primary px-2 py-0.5 text-meta",
                    ROLE_TEXT_CLASS[role.color],
                  )}
                >
                  <span
                    className={cn(
                      "size-2 rounded-full",
                      AVATAR_BG_CLASS[role.color],
                    )}
                    aria-hidden="true"
                  />
                  {role.name}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div>
          <p className="text-caption text-text-tertiary uppercase">
            Membro desde
          </p>
          <p className="mt-1 text-body text-text-secondary">
            Entrou em {joinedFormat.format(new Date(member.joinedAt))}
          </p>
        </div>

        {isOwnProfile && (
          <ProfileOwnSettings
            communityId={communityId}
            label={label}
            displayName={member.displayName}
            escrever={escrever}
            onClose={onClose}
          />
        )}

        {/*
          §9, 2.3.2 — o caminho de teclado para "fixar como principal". O gesto que a
          spec nomeia é o clique duplo no tile, e §19.4 exige o equivalente alcançável:
          clique duplo é só ponteiro. Aqui também é onde a ação fica **descobrível** —
          um gesto sem superfície nenhuma é um gesto que ninguém encontra.
        */}
        {inCall && (
          <div className="flex flex-col gap-3 border-t border-border-subtle pt-4">
            <Button
              variant="secondary"
              size="sm"
              fullWidth
              onClick={() => {
                alternarFixado(identityId);
                onClose();
              }}
            >
              {fixado ? "Desafixar" : "Fixar como principal"}
            </Button>
          </div>
        )}

        <ProfileModerationActions
          communityId={communityId}
          identityId={identityId}
          targetLabel={member.displayName}
          escrever={escrever}
          onClose={onClose}
        />

        {showCallSection && (
          <ProfileCallActions
            communityId={communityId}
            identityId={identityId}
          />
        )}
      </div>
    </Popover>
  );
}
