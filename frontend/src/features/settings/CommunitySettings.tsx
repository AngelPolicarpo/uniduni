import { useState } from "react";
import { Settings, Shield, Users } from "lucide-react";
import { SettingsLayout } from "./SettingsLayout";
import { CommunityDangerZone } from "./CommunityDangerZone";
import { CommunityIdentitySection } from "./CommunityIdentitySection";
import { CommunityInvitesSection } from "./CommunityInvitesSection";
import { ModerationTab } from "./ModerationTab";
import { RolesTab } from "./RolesTab";
import { useHasPermission } from "../../store/communityStore";
import { useHostStatus } from "../../store/connectionStore";
import type { Community } from "../../domain/types";

export interface CommunitySettingsProps {
  community: Community;
  onClose: () => void;
}

/**
 * 3.1b Configurações da comunidade — metadados, convites e zona de perigo,
 * mais as abas de cargos (3.2) e moderação (3.3).
 *
 * §15 manda esconder o que a permissão não autoriza, nunca mostrar desabilitado. A aba de
 * moderação não é gated só por `view_audit_log` (emenda de 2026-09-06, §15.6): §9.1 dá
 * `mod.revokeBan` a `ban_members` e `mod.removeTimeout` a `timeout_members`, e as consultas
 * correspondentes aceitam essas permissões — gatear a porta pela permissão de LEITURA
 * deixava sem caminho quem tem a de escrita.
 */
export function CommunitySettings({ community, onClose }: CommunitySettingsProps) {
  const canViewAudit = useHasPermission(community.id, "view_audit_log");
  const canManageRoles = useHasPermission(community.id, "manage_roles");
  const canInvite = useHasPermission(community.id, "create_invite");
  const canBan = useHasPermission(community.id, "ban_members");
  const canTimeout = useHasPermission(community.id, "timeout_members");
  // §7.4.5 — `community.update` é de `manage_community`; sem ela o formulário de identidade
  // nem aparece. A aba "Geral" continua alcançável por todo mundo: "Sair da comunidade"
  // mora nela e é de todo membro.
  const canManageCommunity = useHasPermission(community.id, "manage_community");
  const canModerationTab = canViewAudit || canBan || canTimeout;

  const [tab, setTab] = useState("general");
  const hostStatus = useHostStatus(community);
  const semHost = hostStatus !== "online";

  const tabs = [
    { id: "general", label: "Geral", icon: <Settings size={16} strokeWidth={2} /> },
    ...(canManageRoles
      ? [{ id: "roles", label: "Cargos", icon: <Users size={16} strokeWidth={2} /> }]
      : []),
    ...(canModerationTab
      ? [
          {
            id: "moderation",
            label: "Moderação",
            icon: <Shield size={16} strokeWidth={2} />,
          },
        ]
      : []),
  ];

  return (
    <SettingsLayout
      title={community.name}
      items={tabs}
      activeId={tab}
      onSelect={setTab}
      onClose={onClose}
    >
      {tab === "general" && (
        <>
          {canManageCommunity && (
            <CommunityIdentitySection community={community} semHost={semHost} />
          )}
          {canInvite && <CommunityInvitesSection community={community} />}
          <CommunityDangerZone
            community={community}
            semHost={semHost}
            onClose={onClose}
          />
        </>
      )}

      {tab === "roles" && <RolesTab community={community} />}
      {tab === "moderation" && <ModerationTab community={community} />}
    </SettingsLayout>
  );
}
