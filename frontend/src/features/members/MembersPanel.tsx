import { useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Search, Volume2 } from "lucide-react";
import { cn } from "../../lib/cn";
import { Avatar } from "../../components/ui/Avatar";
import { SlidePanel } from "../../components/ui/SlidePanel";
import { MemberContextMenu } from "./MemberContextMenu";
import { ProfilePopover } from "./ProfilePopover";
import { ROLE_TEXT_CLASS } from "../../lib/role";
import { selectRole, useCommunityStore, useMemberLabel } from "../../store/communityStore";
import { useBans } from "../../store/moderationStore";
import type {
  Channel, Community, Member, Role } from "../../domain/types";

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/**
 * Quem está em algum canal de voz desta comunidade agora (§8, 1.3).
 *
 * A ocupação vem de `query.structure`, que dá `voice.count` e as primeiras pessoas por canal
 * (§15.6, fecha RT-05) — não há varredura de fixture. `first` é um recorte, então esta lista
 * é "quem dá para nomear", não o roster completo da chamada.
 */
function inVoiceIds(communityId: string, channels: Record<string, Channel>): Set<string> {
  const ids = new Set<string>();
  for (const channel of Object.values(channels)) {
    if (channel.communityId !== communityId) continue;
    for (const id of channel.voiceParticipantIds ?? []) ids.add(id);
  }
  return ids;
}

interface MemberRowProps {
  member: Member;
  role: Role | undefined;
  inVoice: boolean;
  onOpenProfile: (identityId: string, anchor: DOMRect) => void;
  /** Botão direito / long-press: o menu de contexto de membro de §6. */
  menuAberto: boolean;
  onOpenMenu: () => void;
  onCloseMenu: () => void;
}

function MemberRow({
  member,
  role,
  inVoice,
  onOpenProfile,
  menuAberto,
  onOpenMenu,
  onCloseMenu,
}: MemberRowProps) {
  // Apelido definido nesta sessão vence o que o núcleo respondeu (§8, 1.4).
  const label = useMemberLabel(member.communityId, member.identityId);
  // "Ver perfil" no menu abre o popover ancorado na MESMA linha que abriu o menu.
  const linha = useRef<HTMLButtonElement>(null);
  const ancoraDoMenu = () =>
    linha.current?.getBoundingClientRect() ?? new DOMRect(0, 0, 0, 0);
  return (
    <li className="relative">
      <button
        ref={linha}
        type="button"
        onClick={(event) =>
          onOpenProfile(
            member.identityId,
            event.currentTarget.getBoundingClientRect(),
          )
        }
        onContextMenu={(event) => {
          event.preventDefault();
          onOpenMenu();
        }}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left",
          "transition-colors duration-(--duration-fast) ease-out",
          "hover:bg-surface-primary",
        )}
      >
        <Avatar
          name={member.displayName}
          color={member.avatarColor}
          size="sm"
          presence={member.presence}
          presenceRingClass="border-surface-sidebar"
        />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-body",
            role ? ROLE_TEXT_CLASS[role.color] : "text-text-secondary",
          )}
        >
          {label}
        </span>
        {inVoice && (
          <Volume2
            size={14}
            strokeWidth={2}
            role="img"
            aria-label="Em uma chamada"
            className="shrink-0 text-text-tertiary"
          />
        )}
      </button>

      {/* §6 sempre previu o menu de contexto "em membro"; o painel era a única superfície
          de gente que não tinha o gatilho, e o clique esquerdo continua abrindo o perfil
          (1.4), que é o caminho equivalente de §19.4 para quem não tem botão direito. */}
      <MemberContextMenu
        communityId={member.communityId}
        identityId={member.identityId}
        open={menuAberto}
        onClose={onCloseMenu}
        onOpenProfile={() => onOpenProfile(member.identityId, ancoraDoMenu())}
      />
    </li>
  );
}

export interface MembersPanelProps {
  community: Community;
  onClose: () => void;
}

/**
 * Painel de membros (§8, 1.3) — agrupado por cargo, do topo da hierarquia
 * para baixo, com dot de presença e busca rápida por nome.
 *
 * O grupo "OFFLINE" mostra só a contagem: §2 define os offline como um
 * agregador ("307 offline"), sem registros individuais, então não há lista
 * para expandir — o que corresponde ao estado colapsado que a spec pede como
 * padrão.
 */
export function MembersPanel({ community, onClose }: MembersPanelProps) {
  const [query, setQuery] = useState("");
  const [profile, setProfile] = useState<{
    identityId: string;
    anchor: DOMRect;
  } | null>(null);
  const [menu, setMenu] = useState<string | null>(null);

  const roles = useCommunityStore(
    useShallow((state) =>
      community.roleIds
        .map((roleId) => selectRole(state, roleId))
        .filter((role): role is Role => role !== undefined)
        .sort((a, b) => b.position - a.position),
    ),
  );

  const bans = useBans(community.id);
  const roster = useCommunityStore((state) => state.remote.membersByCommunity);
  const groups = useMemo(() => {
    const banned = new Set(bans.map((ban) => ban.identityId));
    const members = (roster[community.id] ?? []).filter(
      (member) => !banned.has(member.identityId),
    );
    const needle = normalize(query.trim());
    const visible = needle
      ? members.filter((member) =>
          normalize(member.nickname ?? member.displayName).includes(needle) ||
          normalize(member.displayName).includes(needle),
        )
      : members;

    // Cada membro aparece uma vez, sob o cargo mais alto que tem (§8, 1.3).
    //
    // Uma passada sobre os membros, e não uma por cargo: `roles` já vem do topo
    // da hierarquia para baixo, então o menor índice é o cargo mais alto e o
    // `sort` por membro deixa de existir. A versão anterior reordenava os
    // cargos de CADA membro uma vez para CADA cargo — e como a busca está nas
    // dependências deste `useMemo`, isso acontecia a cada tecla digitada.
    const ordem = new Map(roles.map((role, i) => [role.id, i]));
    const porCargo = new Map<string, Member[]>();
    for (const member of visible) {
      let maisAlto = -1;
      for (const roleId of member.roleIds) {
        const i = ordem.get(roleId);
        // Empate de `position` fica com a ordem da hierarquia da comunidade, e
        // não com a ordem em que ESTE membro recebeu os cargos.
        if (i !== undefined && (maisAlto === -1 || i < maisAlto)) maisAlto = i;
      }
      // Membro só com cargo desconhecido não entra em grupo nenhum, como antes.
      if (maisAlto === -1) continue;
      const cargoId = roles[maisAlto].id;
      const lista = porCargo.get(cargoId);
      if (lista === undefined) porCargo.set(cargoId, [member]);
      else lista.push(member);
    }

    return roles
      .map((role) => ({
        role,
        members: (porCargo.get(role.id) ?? []).sort((a, b) =>
          a.displayName.localeCompare(b.displayName, "pt-BR"),
        ),
      }))
      .filter((group) => group.members.length > 0);
  }, [community.id, roles, query, bans, roster]);

  const canais = useCommunityStore((state) => state.remote.channels);
  const voiceIds = useMemo(() => inVoiceIds(community.id, canais), [community.id, canais]);
  // §23.3 — offline é contagem agregada, e quem a produz é `query.members.offlineCount`.
  // Enquanto o sincronizador não a espelha, a seção não afirma um número: zero aqui
  // significa "não sei", e a UI já não desenha a linha nesse caso. Lacuna registrada.
  const offlineCount = 0;

  return (
    <SlidePanel title="Membros" onClose={onClose} width={280}>
      <div className="shrink-0 px-3 pt-3">
        <div className="flex items-center gap-2 rounded-md border border-border-default bg-surface-primary px-2">
          <Search
            size={16}
            strokeWidth={2}
            aria-hidden="true"
            className="shrink-0 text-text-tertiary"
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar membro"
            aria-label="Buscar membro"
            className="h-8 min-w-0 flex-1 bg-transparent text-body text-text-primary outline-none placeholder:text-text-tertiary"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {groups.length === 0 && query.trim() !== "" && (
          <p className="px-2 text-body text-text-tertiary">
            Nenhum membro encontrado para "{query.trim()}"
          </p>
        )}

        {groups.map(({ role, members }) => (
          <section key={role.id} className="mb-4 last:mb-0">
            <h3 className="px-2 pb-1 text-caption text-text-tertiary uppercase">
              {role.name} — {members.length}
            </h3>
            <ul className="flex flex-col gap-0.5">
              {members.map((member) => (
                <MemberRow
                  key={member.identityId}
                  member={member}
                  role={role}
                  inVoice={voiceIds.has(member.identityId)}
                  onOpenProfile={(identityId, anchor) => {
                    setMenu(null);
                    setProfile({ identityId, anchor });
                  }}
                  menuAberto={menu === member.identityId}
                  onOpenMenu={() => setMenu(member.identityId)}
                  onCloseMenu={() => setMenu(null)}
                />
              ))}
            </ul>
          </section>
        ))}

        {offlineCount > 0 && query.trim() === "" && (
          <h3 className="px-2 pt-2 text-caption text-text-tertiary uppercase">
            Offline — {offlineCount}
          </h3>
        )}
      </div>

      {profile && (
        <ProfilePopover
          communityId={community.id}
          identityId={profile.identityId}
          anchor={profile.anchor}
          onClose={() => setProfile(null)}
        />
      )}
    </SlidePanel>
  );
}
