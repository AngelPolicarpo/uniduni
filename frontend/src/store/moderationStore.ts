import { useMemo } from "react";
import { create } from "zustand";
// O log, os banidos e os timeouts vêm TODOS do núcleo (§15.6): `query.auditLog`,
// `query.bans` e `query.timeouts` respondem `E_PERMISSION_DENIED` a quem não tem a
// permissão DELAS — que não é a mesma nas três. Ausência aqui é "não carregado ou sem
// permissão", nunca "nada aconteceu" — os flags guardam a diferença.
import type { ModerationAction } from "../domain/types";

/**
 * Moderação por-comunidade (§10, 3.3 · fluxo D12).
 *
 * Escopo deliberadamente local: cargos e permissões desta comunidade, nunca
 * reputação global — `CLAUDE.md:49` marca "moderação em escala sem
 * autoridade central" como problema em aberto, não como recurso resolvido.
 *
 * Esta store não aplica ação nenhuma: as escritas são ops ⏱ (`mod.*`, §15.4)
 * e a hierarquia é decisão do fold. Aqui mora só o espelho do que o núcleo
 * responde, preenchido pelo Sincronizador.
 */

export interface BanRecord {
  communityId: string;
  /** Hex64 da identidade banida — é o `targetKey` das superfícies de §15.4/§15.6. */
  identityId: string;
  /** Identificador exibido — em P2P não há nome real garantido (§10, 3.3). */
  label: string;
  byId: string;
  at: string;
  reason?: string;
}

export interface TimeoutRecord {
  communityId: string;
  identityId: string;
  label: string;
  byId: string;
  at: string;
  /** Epoch em ms — a lista mostra a contagem regressiva (§10, 3.3). */
  until: number;
  reason?: string;
}

/** Durações oferecidas ao aplicar timeout. */
export const TIMEOUT_OPTIONS = [
  { value: "5", label: "5 minutos" },
  { value: "60", label: "1 hora" },
  { value: "1440", label: "24 horas" },
];

/**
 * Qual das três leituras foi recusada por permissão (emenda de 2026-09-06). As três NÃO
 * exigem a mesma coisa (§15.6): `query.auditLog` é `view_audit_log`; `query.bans` aceita
 * `view_audit_log` ou `ban_members`; `query.timeouts` aceita `view_audit_log` ou
 * `timeout_members`. Um flag só para as três apagava a lista que tinha respondido.
 */
export interface NegadasPorPermissao {
  auditLog: boolean;
  bans: boolean;
  timeouts: boolean;
}

const NADA_NEGADO: NegadasPorPermissao = { auditLog: false, bans: false, timeouts: false };

interface ModerationState {
  auditLog: ModerationAction[];
  bans: BanRecord[];
  timeouts: TimeoutRecord[];
  /**
   * Cursor opaco da PRÓXIMA página de `query.auditLog` (§15.6). Ausente = a fonte já
   * respondeu tudo, e "Carregar mais" some — §14 pede que o botão pague o lote seguinte
   * NA FONTE, não que revele linhas de um array já carregado.
   */
  auditCursor: string | null;
  /** Recusa por permissão, por consulta. */
  negadas: NegadasPorPermissao;
  /**
   * As TRÊS bateram em `E_PERMISSION_DENIED`: quem vê esta tela não tem nenhuma das
   * permissões de leitura. As listas vazias então significam "sem permissão", não
   * "sem registro".
   */
  semPermissao: boolean;
  aplicarRemoto: (patch: {
    auditLog?: ModerationAction[];
    bans?: BanRecord[];
    timeouts?: TimeoutRecord[];
    auditCursor?: string | null;
    negadas?: NegadasPorPermissao;
    semPermissao?: boolean;
  }) => void;
  /** Anexa a página seguinte do log sem reconsultar o que já está na tela. */
  anexarAuditoria: (entries: ModerationAction[], cursor: string | null) => void;
}

export const useModerationStore = create<ModerationState>()((set) => ({
  auditLog: [],
  bans: [],
  timeouts: [],
  auditCursor: null,
  negadas: NADA_NEGADO,
  semPermissao: false,
  aplicarRemoto: (patch) => set(patch),
  anexarAuditoria: (entries, cursor) =>
    set((state) => {
      const conhecidos = new Set(state.auditLog.map((e) => e.id));
      return {
        auditLog: [...state.auditLog, ...entries.filter((e) => !conhecidos.has(e.id))],
        auditCursor: cursor,
      };
    }),
}));

/* ─── Seletores ──────────────────────────────────────────────────── */

/** Log de auditoria da comunidade, do mais recente para o mais antigo. */
export function useAuditLog(communityId: string): ModerationAction[] {
  const entries = useModerationStore((state) => state.auditLog);
  return useMemo(
    () => entries.filter((entry) => entry.communityId === communityId),
    [entries, communityId],
  );
}

/** Banidos vivos, mais recentes primeiro. */
export function useBans(communityId: string): BanRecord[] {
  const bans = useModerationStore((state) => state.bans);
  return useMemo(
    () => bans.filter((ban) => ban.communityId === communityId),
    [bans, communityId],
  );
}

/** Timeouts vigentes, mais recentes primeiro — os expirados são do histórico. */
export function useTimeouts(communityId: string): TimeoutRecord[] {
  const timeouts = useModerationStore((state) => state.timeouts);
  return useMemo(
    () => timeouts.filter((t) => t.communityId === communityId),
    [timeouts, communityId],
  );
}

export function useModeracaoSemPermissao(): boolean {
  return useModerationStore((state) => state.semPermissao);
}

/** Recusa por consulta — cada sub-aba de §10, 3.3 pergunta pela sua. */
export function useModeracaoNegadas(): NegadasPorPermissao {
  return useModerationStore((state) => state.negadas);
}

/** Há mais páginas de log na fonte (§14 — "Carregar mais" busca, não revela). */
export function useAuditCursor(): string | null {
  return useModerationStore((state) => state.auditCursor);
}
