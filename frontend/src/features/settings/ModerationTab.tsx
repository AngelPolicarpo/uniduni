import { useEffect, useMemo, useState } from "react";
import {
  Ban,
  Clock,
  FolderPlus,
  Hash,
  MessageSquareOff,
  ShieldOff,
  Trash2,
  UserMinus,
  UserPlus,
  RefreshCcw,
  Crown,
  LogOut,
  Pencil,
  TimerOff,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Menu } from "../../components/ui/Menu";
import { Tabs } from "../../components/ui/Tabs";
import { SettingsRow } from "./SettingsLayout";
import { formatCountdown, formatRelativeTime } from "../../lib/format";
import {
  useAuditCursor,
  useAuditLog,
  useBans,
  useModeracaoNegadas,
  useModeracaoSemPermissao,
  useTimeouts,
} from "../../store/moderationStore";
import { useHasPermission } from "../../store/communityStore";
import {
  carregarMaisAuditoria,
  sincronizarMembros,
  sincronizarModeracao,
} from "../../live/sincronizacao";
import { api } from "../../ipc/api";
import { codigoDoErro } from "../../ipc/frames";
import { useToastStore } from "../../store/toastStore";
import type {
  Community,
  ModerationAction,
  ModerationActionType,
} from "../../domain/types";

/** Ícone por tipo de auditoria — os de §6.13, não só punições (§10, 3.4). */
const ACTION_ICON: Partial<Record<ModerationActionType, LucideIcon>> = {
  ban: Ban,
  kick: UserMinus,
  timeout: Clock,
  removeTimeout: TimerOff,
  deleteMessage: MessageSquareOff,
  createRole: UserPlus,
  updateRole: Pencil,
  deleteRole: Trash2,
  revokeBan: ShieldOff,
  createChannel: Hash,
  updateChannel: Pencil,
  deleteChannel: Trash2,
  createCategory: FolderPlus,
  renameCategory: Pencil,
  deleteCategory: Trash2,
  updateCommunity: Pencil,
  endCommunity: LogOut,
  assumeHost: Crown,
  setSuccessors: Users,
  revokeInvite: ShieldOff,
};

/** Uma frase por tipo — o log é lido, não decifrado (§10, 3.3). */
function describe(entry: ModerationAction, authorName: string): string {
  const alvo = entry.targetLabel;
  switch (entry.type) {
    case "ban": return `${authorName} baniu ${alvo}`;
    case "kick": return `${authorName} expulsou ${alvo}`;
    case "timeout": return `${authorName} aplicou timeout em ${alvo}`;
    case "removeTimeout": return `${authorName} removeu o timeout de ${alvo}`;
    case "deleteMessage": return `${authorName} deletou uma mensagem de ${alvo}`;
    case "createRole": return `${authorName} criou o cargo ${alvo}`;
    case "updateRole": return `${authorName} atualizou o cargo ${alvo}`;
    case "deleteRole": return `${authorName} deletou o cargo ${alvo}`;
    case "revokeBan": return `${authorName} revogou o banimento de ${alvo}`;
    case "createChannel": return `${authorName} criou o canal ${alvo}`;
    case "updateChannel": return `${authorName} atualizou o canal ${alvo}`;
    case "deleteChannel": return `${authorName} excluiu o canal ${alvo}`;
    case "createCategory": return `${authorName} criou a categoria ${alvo}`;
    case "renameCategory": return `${authorName} renomeou a categoria para ${alvo}`;
    case "deleteCategory": return `${authorName} excluiu a categoria ${alvo}`;
    case "updateCommunity": return `${authorName} atualizou a identidade da comunidade`;
    case "endCommunity": return `${authorName} encerrou a comunidade`;
    case "assumeHost": return `${authorName} assumiu a hospedagem da comunidade`;
    case "setSuccessors": return `${authorName} definiu a fila de sucessão`;
    case "revokeInvite": return `${authorName} revogou um convite`;
    default: return `${authorName} registrou uma ação (${String(entry.type)})`;
  }
}

const TYPE_FILTERS: { value: ModerationActionType | "all"; label: string }[] = [
  { value: "all", label: "Todas as ações" },
  { value: "ban", label: "Banimentos" },
  { value: "kick", label: "Expulsões" },
  { value: "timeout", label: "Timeouts" },
  { value: "deleteMessage", label: "Mensagens deletadas" },
  { value: "createRole", label: "Cargos criados" },
];

/** Contagem regressiva do timeout, recalculada a cada segundo. */
function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function remaining(until: number, now: number): string {
  const ms = Math.max(0, until - now);
  // Acima de uma hora a regressiva em segundos não ajuda ninguém; abaixo,
  // §5.10 pede "12min 30s" atualizando a cada segundo.
  if (ms >= 3600_000) return `${Math.ceil(ms / 3600_000)} h restantes`;
  return `${formatCountdown(ms)} restantes`;
}

export interface ModerationTabProps {
  community: Community;
}

/**
 * 3.3 Ferramentas de moderação — log de auditoria, banidos e timeouts.
 *
 * As três leituras vêm do núcleo (`query.auditLog/bans/timeouts`, §15.6) e cada uma tem a
 * SUA permissão: log é `view_audit_log`; banidos aceita `view_audit_log` ou `ban_members`;
 * timeouts aceita `view_audit_log` ou `timeout_members`. Sub-aba cuja consulta foi recusada
 * não aparece, e a tela só vira "sem permissão" inteira quando as três negam.
 *
 * O botão de cada linha depende da permissão de ESCRITA, não da de leitura (§9.1 —
 * `mod.revokeBan` é de `ban_members`, `mod.removeTimeout` é de `timeout_members`): quem só
 * lê o log não vê botão nenhum, porque ação de moderação sem permissão some (§15).
 *
 * Escopo por-comunidade via cargos, nunca reputação global: `CLAUDE.md:49` marca moderação
 * em escala como problema em aberto, e a nota de honestidade do topo da lista de banidos diz
 * isso com todas as letras.
 */
export function ModerationTab({ community }: ModerationTabProps) {
  const showToast = useToastStore((state) => state.showToast);
  const [tab, setTab] = useState("log");
  const [typeFilter, setTypeFilter] = useState<ModerationActionType | "all">(
    "all",
  );
  const [filterOpen, setFilterOpen] = useState(false);
  const [carregandoMais, setCarregandoMais] = useState(false);

  const entries = useAuditLog(community.id);
  const bans = useBans(community.id);
  const timeouts = useTimeouts(community.id);
  const semPermissao = useModeracaoSemPermissao();
  const negadas = useModeracaoNegadas();
  const auditCursor = useAuditCursor();
  // Permissões de ESCRITA — são elas que decidem se o botão da linha existe (§9.1).
  const canBan = useHasPermission(community.id, "ban_members");
  const canTimeout = useHasPermission(community.id, "timeout_members");
  const now = useNow();

  const recarregar = () => void sincronizarModeracao(community.id);

  function carregarMais(): void {
    if (carregandoMais) return;
    setCarregandoMais(true);
    void carregarMaisAuditoria(community.id).finally(() => setCarregandoMais(false));
  }

  async function revogar(identityId: string, label: string): Promise<void> {
    try {
      await api.modRevokeBan({ communityId: community.id, targetKey: identityId });
      showToast(`Banimento de ${label} revogado`);
      void sincronizarMembros(community.id);
      recarregar();
    } catch (e) {
      showToast(`Não foi possível revogar (${codigoDoErro(e)}).`);
    }
  }

  async function removerTimeout(identityId: string, label: string): Promise<void> {
    try {
      await api.modRemoveTimeout({ communityId: community.id, targetKey: identityId });
      showToast(`Timeout de ${label} removido`);
      recarregar();
    } catch (e) {
      showToast(`Não foi possível remover (${codigoDoErro(e)}).`);
    }
  }

  const filtered = useMemo(
    () =>
      typeFilter === "all"
        ? entries
        : entries.filter((entry) => entry.type === typeFilter),
    [entries, typeFilter],
  );

  if (semPermissao) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <p className="rounded-md border border-border-default bg-surface-primary p-3 text-body text-text-secondary">
          Seu cargo não tem permissão para ver nada da moderação desta comunidade — nem o
          log (<code>view_audit_log</code>), nem os banidos (<code>ban_members</code>), nem
          os timeouts (<code>timeout_members</code>). Peça a quem pode e recarregue.
        </p>
        <Button variant="secondary" size="sm" className="self-start" onClick={recarregar}>
          Tentar novamente
        </Button>
      </div>
    );
  }

  // Sub-aba cuja consulta foi recusada não aparece (§15). Se a ativa sumiu — porque a
  // permissão mudou embaixo da tela —, a primeira disponível assume.
  const subAbas = [
    ...(negadas.auditLog ? [] : [{ id: "log", label: "Log de auditoria" }]),
    ...(negadas.bans ? [] : [{ id: "bans", label: `Banidos (${bans.length})` }]),
    ...(negadas.timeouts ? [] : [{ id: "timeouts", label: `Timeouts (${timeouts.length})` }]),
  ];
  const abaVisivel = subAbas.some((a) => a.id === tab) ? tab : (subAbas[0]?.id ?? "log");

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <Tabs
        orientation="horizontal"
        activeId={abaVisivel}
        onSelect={setTab}
        items={subAbas}
      />

      {abaVisivel === "log" && (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <div className="relative self-start">
            <Button
              variant="secondary"
              size="sm"
              aria-haspopup="menu"
              aria-expanded={filterOpen}
              onClick={() => setFilterOpen((open) => !open)}
            >
              {TYPE_FILTERS.find((f) => f.value === typeFilter)?.label}
            </Button>
            <Menu
              open={filterOpen}
              onClose={() => setFilterOpen(false)}
              side="bottom"
              items={TYPE_FILTERS.map((filter) => ({
                id: filter.value,
                label: filter.label,
                onSelect: () => setTypeFilter(filter.value),
              }))}
            />
          </div>

          {filtered.length === 0 ? (
            <p className="text-body text-text-tertiary">
              Nenhuma ação de moderação registrada ainda.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {filtered.map((entry) => {
                const Icon = ACTION_ICON[entry.type] ?? RefreshCcw;
                const author =
                  entry.authorLabel ?? `${entry.authorId.slice(0, 8)}…`;
                return (
                  <li key={entry.id}>
                    <SettingsRow>
                      <span className="flex items-start gap-2">
                        <Icon
                          size={16}
                          strokeWidth={2}
                          aria-hidden="true"
                          className="mt-0.5 shrink-0 text-text-tertiary"
                        />
                        <span className="min-w-0">
                          <span className="block text-body text-text-primary">
                            {describe(entry, author)}
                          </span>
                          {entry.reason && (
                            <span className="block text-meta text-text-secondary">
                              motivo: {entry.reason}
                            </span>
                          )}
                          <span className="block text-meta text-text-tertiary">
                            {formatRelativeTime(entry.timestamp)}
                          </span>
                        </span>
                      </span>
                    </SettingsRow>
                  </li>
                );
              })}
            </ul>
          )}

          {/* §14 — o botão paga o lote seguinte NA FONTE (`nextCursor` de `query.auditLog`),
              e some quando a consulta responde sem cursor. Filtrar o que já veio não é
              paginar: sem isto, ação além do primeiro lote era inalcançável na tela. */}
          {auditCursor !== null && (
            <>
              {typeFilter !== "all" && (
                <p className="text-meta text-text-tertiary">
                  O filtro vale sobre o que já foi carregado — há mais log a buscar.
                </p>
              )}
              <Button
                variant="secondary"
                size="sm"
                className="self-start"
                loading={carregandoMais}
                onClick={carregarMais}
              >
                Carregar mais
              </Button>
            </>
          )}
        </div>
      )}

      {abaVisivel === "bans" && (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          {/* Nota de honestidade fixa, nunca escondida num tooltip (§10). */}
          <p className="rounded-md border border-border-default bg-surface-primary p-3 text-meta text-text-secondary">
            Banir impede a entrada com esta identidade específica. Como não há
            autoridade central, a pessoa pode tecnicamente voltar com uma
            identidade nova através de outro convite.
          </p>

          {bans.length === 0 ? (
            <p className="text-body text-text-tertiary">
              Ninguém está banido de {community.name}.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {bans.map((ban) => (
                <li key={ban.identityId}>
                  <SettingsRow
                    action={
                      canBan ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void revogar(ban.identityId, ban.label)}
                        >
                          Revogar banimento
                        </Button>
                      ) : undefined
                    }
                  >
                    <span className="block truncate font-mono text-body text-text-primary">
                      {ban.label}
                    </span>
                    <span className="block text-meta text-text-tertiary">
                      {formatRelativeTime(ban.at)}
                      {ban.reason ? ` · motivo: ${ban.reason}` : ""}
                    </span>
                  </SettingsRow>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {abaVisivel === "timeouts" && (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          {timeouts.length === 0 ? (
            <p className="text-body text-text-tertiary">
              Nenhum timeout ativo em {community.name} no momento.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {timeouts.map((timeout) => (
                <li key={timeout.identityId}>
                  <SettingsRow
                    action={
                      canTimeout ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void removerTimeout(timeout.identityId, timeout.label)}
                        >
                          Remover timeout
                        </Button>
                      ) : undefined
                    }
                  >
                    <span className="block truncate text-body text-text-primary">
                      {timeout.label}
                    </span>
                    <span className="block text-meta text-text-tertiary">
                      {remaining(timeout.until, now)}
                      {timeout.reason ? ` · motivo: ${timeout.reason}` : ""}
                    </span>
                  </SettingsRow>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
