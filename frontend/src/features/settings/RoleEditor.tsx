import { useState } from "react";
import { cn } from "../../lib/cn";
import { Avatar } from "../../components/ui/Avatar";
import { Button } from "../../components/ui/Button";
import { Checkbox } from "../../components/ui/Checkbox";
import { Modal } from "../../components/ui/Modal";
import { Tabs } from "../../components/ui/Tabs";
import { TextField } from "../../components/ui/TextField";
import { Toggle } from "../../components/ui/Toggle";
import { SettingsRow, SettingsSection } from "./SettingsLayout";
import { api } from "../../ipc/api";
import { numeroDaCor } from "../../ipc/cores";
import { OFFLINE_HINT } from "../../live/recusas";
import { useToastStore } from "../../store/toastStore";
import { AVATAR_BG_CLASS } from "../../lib/avatar";
import { PERMISSION_GROUPS } from "../../mocks/dataset";
import {
  selectCanActOnRole,
  selectCanModerate,
  selectLocalPermissions,
  selectMemberRoleIds,
  useCommunityStore,
} from "../../store/communityStore";
import type { Community, Member, Permission, Role, RoleColor } from "../../domain/types";

/**
 * R-11 (§8.3): as 11 permissões que o **cargo base** nunca pode ter. Ele é o cargo que todo
 * membro presente, futuro e reingressante recebe (R-3), então gestão, moderação ou menção
 * global ali valeria para a comunidade inteira — `E_BASE_ROLE_RESTRICTED` no núcleo.
 */
const PROIBIDAS_NO_BASE: ReadonlySet<Permission> = new Set<Permission>([
  "manage_community",
  "manage_channels",
  "manage_roles",
  "manage_messages",
  "ban_members",
  "kick_members",
  "timeout_members",
  "mention_everyone",
  "view_audit_log",
  "voice_mute_others",
  "create_invite",
]);

/** §5.4 — conjunto curado fechado de 7; nunca color-picker livre. */
const ROLE_COLORS: RoleColor[] = [
  "role-gold",
  "role-blue",
  "role-green",
  "role-red",
  "role-purple",
  "role-pink",
  "role-neutral",
];

export interface RoleEditorProps {
  community: Community;
  /** Cargo em edição — o rascunho é dele, e trocar de cargo o descarta. */
  selected: Role;
  membersWithRole: Member[];
  semHost: boolean;
  ocupado: boolean;
  /** Mensagem de recusa da última op, mostrada acima dos botões. */
  recusa: string | null;
  /** Envia a op, reconsulta e trata a recusa — vem da aba. */
  comRecusa: (acao: () => Promise<void>) => void;
  /** §16 Mobile: volta para a lista, que é a primeira das duas telas. */
  mobileEditing: boolean;
  /** Aba interna do editor — vive na aba de cargos porque criar um cargo
   *  novo volta para "Permissões". */
  section: string;
  onSelectSection: (id: string) => void;
  onBack: () => void;
  onDeleted: () => void;
}

/**
 * Editor do cargo selecionado (§10, 3.2).
 *
 * U-23: tem rascunho e botão. O auto-save saiu porque `role.update` é op síncrona
 * de §15.4 num log append-only com o rate limit de §14.4 — marcar permissões uma a uma
 * mandava uma op por clique (`F-12`). O rascunho pertence a UM cargo: trocar de cargo na
 * lista descarta o que não foi salvo, e é por isso que ele carrega o próprio `roleId`.
 */
export function RoleEditor({
  community,
  selected,
  membersWithRole,
  semHost,
  ocupado,
  recusa,
  comRecusa,
  mobileEditing,
  section,
  onSelectSection,
  onBack,
  onDeleted,
}: RoleEditorProps) {
  const showToast = useToastStore((state) => state.showToast);
  /**
   * §20.3 (regra 8): a tela não oferece o que o `fold` já recusa. Três eixos independentes
   * decidem o que fica inerte aqui — hierarquia (R-4), imutabilidade do Fundador
   * (`E_FOUNDER_IMMUTABLE`) e as duas anti-escaladas de permissão (R-5 e R-11). Nenhum deles
   * é autorização: quem decide continua sendo o núcleo, e a recusa nomeada segue sendo
   * traduzida em `recusa`.
   */
  const podeMexer = useCommunityStore((state) =>
    selectCanActOnRole(state, community.id, selected),
  );
  // Chave estável: o seletor devolveria um `Set` novo a cada render e a store re-renderizaria
  // para sempre. Mesmo padrão que o popover de perfil já usa para os cargos do alvo.
  const minhasPermissoesChave = useCommunityStore((state) =>
    [...selectLocalPermissions(state, community.id)].sort().join("|"),
  );
  const minhasPermissoes = new Set<Permission>(
    minhasPermissoesChave === "" ? [] : (minhasPermissoesChave.split("|") as Permission[]),
  );
  const motivoBloqueio = selected.isFounder
    ? "O cargo Fundador não é editável"
    : podeMexer
      ? null
      : "Este cargo está acima do seu na hierarquia";
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [rascunho, setRascunho] = useState<{
    roleId: string;
    name: string;
    color: RoleColor;
    mentionable: boolean;
    permissions: Permission[];
  } | null>(null);

  const draft =
    rascunho?.roleId === selected.id
      ? rascunho
      : {
          roleId: selected.id,
          name: selected.name,
          color: selected.color,
          mentionable: selected.mentionable,
          permissions: selected.permissions,
        };

  // R-12 recusa deletar o cargo base (`E_BASE_ROLE_REQUIRED`); R-4 recusa o que está acima.
  const canDelete = podeMexer && !selected.isDefault;

  /**
   * Conjuntos das permissões: um deles responde a comparação de "sujo", o
   * outro as caixas de PERMISSION_GROUPS. Montados uma vez, em vez de a lista
   * ser varrida por permissão perguntada.
   */
  const salvas = new Set(selected.permissions);
  const marcadas = new Set(draft.permissions);

  /** Motivo pelo qual uma permissão específica não é marcável, ou `null` se for. */
  function bloqueioDaPermissao(permission: Permission): string | null {
    if (motivoBloqueio !== null) return motivoBloqueio;
    if (selected.isDefault && PROIBIDAS_NO_BASE.has(permission))
      return "O cargo base é de todo mundo — permissão de gestão ou moderação nele valeria para a comunidade inteira";
    // R-5: ninguém concede o que não tem. Permissão JÁ salva no cargo continua marcável para
    // ser RETIRADA — tirar não é escalada, e travá-la deixaria o cargo sem quem o desfizesse.
    if (!minhasPermissoes.has(permission) && !salvas.has(permission))
      return "Você não tem esta permissão";
    return null;
  }
  const sujo =
    draft.name !== selected.name ||
    draft.color !== selected.color ||
    draft.mentionable !== selected.mentionable ||
    draft.permissions.length !== selected.permissions.length ||
    draft.permissions.some((perm) => !salvas.has(perm));

  function togglePermission(permission: Permission) {
    setRascunho({
      ...draft,
      permissions: marcadas.has(permission)
        ? draft.permissions.filter((item) => item !== permission)
        : [...draft.permissions, permission],
    });
  }

  function salvar() {
    const cor = numeroDaCor(draft.color);
    comRecusa(async () => {
      await api.roleUpdate({
        communityId: community.id,
        roleId: draft.roleId,
        ...(draft.name !== selected.name ? { name: draft.name } : {}),
        ...(draft.color !== selected.color && cor !== null ? { color: cor } : {}),
        ...(draft.mentionable !== selected.mentionable ? { mentionable: draft.mentionable } : {}),
        permissions: draft.permissions,
      });
      setRascunho(null);
      showToast("Alterações salvas", "success");
    });
  }

  return (
    <>
  <div
    className={cn(
      "flex min-w-0 flex-1 flex-col gap-4",
      !mobileEditing && "hidden tablet:flex",
    )}
  >
    <button
      type="button"
      onClick={onBack}
      className="self-start text-meta text-text-secondary tablet:hidden"
    >
      ← Todos os cargos
    </button>

    <TextField
      label="Nome do cargo"
      value={draft.name}
      onChange={(value) => setRascunho({ ...draft, name: value })}
      maxLength={32}
      showCounter
      error={
        draft.name.trim() === "" ? "O cargo precisa de um nome" : undefined
      }
      disabled={motivoBloqueio !== null}
    />

    {motivoBloqueio !== null && (
      <p className="rounded-md border border-border-default bg-surface-primary p-3 text-meta text-text-secondary">
        {motivoBloqueio}. Você continua vendo o que ele concede.
      </p>
    )}

    <div>
      <p className="text-caption text-text-tertiary uppercase">Cor</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {ROLE_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            aria-label={color}
            aria-pressed={draft.color === color}
            disabled={motivoBloqueio !== null}
            title={motivoBloqueio ?? undefined}
            onClick={() => setRascunho({ ...draft, color })}
            className={cn(
              "size-7 rounded-full transition-transform duration-(--duration-fast)",
              AVATAR_BG_CLASS[color],
              draft.color === color &&
                "ring-2 ring-border-strong ring-offset-2 ring-offset-surface-elevated",
              motivoBloqueio !== null && "cursor-not-allowed opacity-50",
            )}
          />
        ))}
      </div>
    </div>

    <Toggle
      checked={draft.mentionable}
      onChange={(mentionable) => setRascunho({ ...draft, mentionable })}
      label="Mencionável"
      description="Permite escrever @cargo no composer."
      disabled={motivoBloqueio !== null}
    />

    <Tabs
      orientation="horizontal"
      activeId={section}
      onSelect={onSelectSection}
      items={[
        { id: "permissions", label: "Permissões" },
        { id: "members", label: `Membros (${membersWithRole.length})` },
      ]}
    />

    <div className="min-h-0 flex-1 overflow-y-auto">
      {section === "permissions" &&
        PERMISSION_GROUPS.map((group) => (
          <SettingsSection key={group.id} title={group.label}>
            {group.permissions.map((permission) => {
              const bloqueio = bloqueioDaPermissao(permission.id);
              return (
                <Checkbox
                  key={permission.id}
                  checked={marcadas.has(permission.id)}
                  onChange={() => togglePermission(permission.id)}
                  label={permission.label}
                  disabled={bloqueio !== null}
                  {...(bloqueio !== null ? { title: bloqueio } : {})}
                />
              );
            })}
          </SettingsSection>
        ))}

      {section === "members" && (
        <div className="flex flex-col gap-2">
          {membersWithRole.length === 0 && (
            <p className="text-body text-text-tertiary">
              Nenhum membro tem o cargo {selected.name || "sem nome"} ainda.
            </p>
          )}
          {membersWithRole.map((member) => (
            <MembroDoCargo
              key={member.identityId}
              communityId={community.id}
              member={member}
              /* O cargo base é de todo mundo por R-3: retirá-lo de alguém é
                 `E_BASE_ROLE_REQUIRED`, então nem se oferece. */
              removivel={!selected.isDefault}
              semHost={semHost}
              ocupado={ocupado}
              onRemove={() =>
                comRecusa(async () => {
                  const atuais = selectMemberRoleIds(
                    useCommunityStore.getState(),
                    community.id,
                    member.identityId,
                  );
                  await api.memberSetRoles({
                    communityId: community.id,
                    targetKey: member.identityId,
                    roleIds: atuais.filter((id) => id !== selected.id),
                  });
                })
              }
            />
          ))}
        </div>
      )}
    </div>

    {recusa !== null && (
      <p role="alert" className="rounded-md border border-feedback-danger/40 bg-surface-primary p-3 text-meta text-feedback-danger">
        {recusa}
      </p>
    )}

    {/* U-23 — salvamento explícito: sujo, carregando, e fora do ar com tooltip. */}
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        onClick={salvar}
        loading={ocupado}
        disabled={!sujo || semHost || motivoBloqueio !== null || draft.name.trim() === ""}
        title={motivoBloqueio ?? (semHost ? OFFLINE_HINT : undefined)}
      >
        Salvar alterações
      </Button>
      {sujo && (
        <Button variant="ghost" size="sm" onClick={() => setRascunho(null)} disabled={ocupado}>
          Descartar
        </Button>
      )}
    </div>

    {canDelete && (
      <Button
        variant="danger"
        size="sm"
        className="self-start"
        onClick={() => setConfirmingDelete(true)}
      >
        Deletar cargo
      </Button>
    )}
  </div>

  {confirmingDelete && (
    <Modal
      open
      onClose={() => setConfirmingDelete(false)}
      title="Deletar cargo?"
      size="sm"
    >
      <div className="flex flex-col gap-4">
        <p className="text-body text-text-secondary">
          {membersWithRole.length > 0
            ? `Este cargo tem ${membersWithRole.length} ${
                membersWithRole.length === 1 ? "membro" : "membros"
              }. Remover o cargo, não os membros?`
            : `O cargo ${selected.name || "sem nome"} será removido desta comunidade.`}
        </p>
        <div className="flex justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() => setConfirmingDelete(false)}
          >
            Cancelar
          </Button>
          <Button
            variant="danger"
            loading={ocupado}
            disabled={semHost}
            title={semHost ? OFFLINE_HINT : undefined}
            onClick={() =>
              comRecusa(async () => {
                await api.roleDelete({ communityId: community.id, roleId: selected.id });
                setConfirmingDelete(false);
                onDeleted();
              })
            }
          >
            Deletar cargo
          </Button>
        </div>
      </div>
    </Modal>
  )}
    </>
  );
}

/**
 * Linha da aba "Membros com este cargo".
 *
 * O "Remover" é `member.setRoles` sobre outra pessoa, e por isso passa pelo estágio 12 de
 * §9.3: Fundador original e host corrente são imunes, e alvo com hierarquia igual ou
 * superior é `E_HIERARCHY`. Aqui é ação de moderação, então a regra de §15 é **esconder** —
 * o botão some, não fica desabilitado. Precisa ser um componente próprio porque
 * `selectCanModerate` é um hook e a lista é um `map`.
 */
function MembroDoCargo({
  communityId,
  member,
  removivel,
  semHost,
  ocupado,
  onRemove,
}: {
  communityId: string;
  member: Member;
  removivel: boolean;
  semHost: boolean;
  ocupado: boolean;
  onRemove: () => void;
}) {
  const podeModerar = useCommunityStore((state) =>
    selectCanModerate(state, communityId, member.identityId),
  );
  return (
    <SettingsRow
      action={
        removivel && podeModerar ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={semHost || ocupado}
            title={semHost ? OFFLINE_HINT : undefined}
            onClick={onRemove}
          >
            Remover
          </Button>
        ) : undefined
      }
    >
      <span className="flex items-center gap-2">
        <Avatar name={member.displayName} color={member.avatarColor} size="sm" />
        <span className="truncate text-body text-text-primary">
          {member.displayName}
        </span>
      </span>
    </SettingsRow>
  );
}
