import { useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { cn } from "../../lib/cn";
import { Button } from "../../components/ui/Button";
import { RoleEditor } from "./RoleEditor";
import { RoleList } from "./RoleList";
import { api } from "../../ipc/api";
import { numeroDaCor } from "../../ipc/cores";
import { codigoDoErro } from "../../ipc/frames";
import { sincronizarComunidade } from "../../live/sincronizacao";
import { motivoDaRecusa, OFFLINE_HINT } from "../../live/recusas";
import { useHostStatus } from "../../store/connectionStore";
import {
  selectLocalTopPosition,
  useCommunityStore,
  useFindMembers,
  useRoles,
} from "../../store/communityStore";
import type { Community } from "../../domain/types";

export interface RolesTabProps {
  community: Community;
}

/**
 * 3.2 Gestão de cargos e permissões — lista à esquerda, editor à direita.
 *
 * Esta aba decide QUAL cargo está selecionado e é dona das ops que mexem na
 * lista (criar e mover); o que cada cargo é fica no `RoleEditor`, e a ordem
 * na `RoleList`.
 */
export function RolesTab({ community }: RolesTabProps) {
  const findMembers = useFindMembers();
  const roles = useRoles(community.id);
  // `topRank(autor)` de §9.3 — a lista precisa dele para não oferecer movimento que R-4 recusa.
  const minhaPosicao = useCommunityStore((state) =>
    selectLocalTopPosition(state, community.id),
  );
  const hostStatus = useHostStatus(community);
  const semHost = hostStatus !== "online";

  const [selectedId, setSelectedId] = useState(roles[0]?.id ?? "");
  const [ocupado, setOcupado] = useState(false);
  /** A mesma verdade que `ocupado`, legível no mesmo quadro em que é escrita. */
  const ocupadoRef = useRef(false);
  const [recusa, setRecusa] = useState<string | null>(null);
  const [mobileEditing, setMobileEditing] = useState(false);
  const [section, setSection] = useState("permissions");

  const selected = roles.find((role) => role.id === selectedId) ?? roles[0];

  // Quem tem o cargo vem do roster do núcleo: `member.setRoles` é op de §15.4 e a lista
  // reage porque `sincronizarMembros` reconsulta depois de cada escrita.
  const membersWithRole = useMemo(() => {
    if (!selected) return [];
    return findMembers(community.id).filter((member) =>
      member.roleIds.includes(selected.id),
    );
  }, [community.id, selected, findMembers]);

  function comRecusa(acao: () => Promise<void>) {
    // A guarda mora num ref, e não no estado: `ocupado` só vale no render seguinte, então
    // dois cliques no MESMO quadro passavam os dois pela porta — o `disabled={ocupado}` do
    // botão ainda não tinha valido — e criavam dois "Novo cargo" de uma vez.
    if (ocupadoRef.current) return;
    ocupadoRef.current = true;
    setOcupado(true);
    setRecusa(null);
    void (async () => {
      try {
        await acao();
        await sincronizarComunidade(community.id);
      } catch (e) {
        setRecusa(motivoDaRecusa(codigoDoErro(e)));
      } finally {
        ocupadoRef.current = false;
        setOcupado(false);
      }
    })();
  }

  /**
   * §6.4.1 — `role.move` manda os VIZINHOS observados, não uma posição. O `fold` ordena por
   * `rank` ascendente e usa o seguinte como teto, então `afterRoleId` é o cargo logo ABAIXO
   * do destino na lista exibida (que é `rank DESC`). Sem ninguém abaixo, o destino é o fundo
   * e o que se manda é `beforeRoleId`: o cargo que vai ficar acima.
   */
  function moverCargo(roleId: string, paraIndice: number) {
    const nova = roles.filter((r) => r.id !== roleId);
    nova.splice(paraIndice, 0, roles.find((r) => r.id === roleId)!);
    const abaixo = nova[paraIndice + 1];
    const acima = nova[paraIndice - 1];
    comRecusa(async () => {
      await api.roleMove({
        communityId: community.id,
        roleId,
        ...(abaixo !== undefined
          ? { afterRoleId: abaixo.id }
          : acima !== undefined
            ? { beforeRoleId: acima.id }
            : {}),
      });
    });
  }

  if (!selected) return null;

  return (
    <div className="flex min-h-0 flex-1 gap-4 tablet:h-full">
      {/* Lista de cargos — em Mobile, a primeira das duas telas (§10, 3.2). */}
      <div
        className={cn(
          "flex w-full flex-col gap-3 tablet:w-[240px] tablet:shrink-0",
          mobileEditing && "hidden tablet:flex",
        )}
      >
        <Button
          variant="secondary"
          size="sm"
          leadingIcon={<Plus size={16} strokeWidth={2} aria-hidden="true" />}
          disabled={semHost || ocupado}
          title={semHost ? OFFLINE_HINT : undefined}
          onClick={() =>
            comRecusa(async () => {
              // Cargo novo nasce vazio e no fundo — quem posiciona é o `fold` (§8.5).
              const r = await api.roleCreate({
                communityId: community.id,
                name: "Novo cargo",
                color: numeroDaCor("role-neutral") ?? 6,
                permissions: [],
                mentionable: false,
              });
              setSelectedId(r.roleId);
              setSection("permissions");
              setMobileEditing(true);
            })
          }
        >
          Novo cargo
        </Button>

        <RoleList
          mover={moverCargo}
          minhaPosicao={minhaPosicao}
          desabilitado={semHost || ocupado}
          {...(semHost ? { motivoDesabilitado: OFFLINE_HINT } : {})}
          roles={roles}
          selectedId={selected.id}
          onSelect={(roleId) => {
            setSelectedId(roleId);
            setMobileEditing(true);
          }}
        />
      </div>

      <RoleEditor
        community={community}
        selected={selected}
        membersWithRole={membersWithRole}
        semHost={semHost}
        ocupado={ocupado}
        recusa={recusa}
        comRecusa={comRecusa}
        mobileEditing={mobileEditing}
        section={section}
        onSelectSection={setSection}
        onBack={() => setMobileEditing(false)}
        onDeleted={() => setSelectedId(roles[0]?.id ?? "")}
      />
    </div>
  );
}
