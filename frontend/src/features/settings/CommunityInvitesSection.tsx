import { useState, useRef } from "react";
import { Copy } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { Select } from "../../components/ui/Select";
import { SettingsRow, SettingsSection } from "./SettingsLayout";
import { formatRelativeTime } from "../../lib/format";
import { linkDeConvite } from "../../mocks/dataset";
import { copiarTexto } from "../../lib/copiar";
import { api } from "../../ipc/api";
import { mensagemDeErro } from "../../live/sessao";
import { OFFLINE_HINT } from "../../live/recusas";
import { sincronizarConvites } from "../../live/sincronizacao";
import { useFindMember, useInvites } from "../../store/communityStore";
import { useToastStore } from "../../store/toastStore";
import type { Community, Invite } from "../../domain/types";

const EXPIRY_OPTIONS = [
  { value: "0", label: "Nunca" },
  { value: "1", label: "1 dia" },
  { value: "7", label: "7 dias" },
  { value: "30", label: "30 dias" },
];

const USES_OPTIONS = [
  { value: "0", label: "Ilimitado" },
  { value: "1", label: "1 uso" },
  { value: "10", label: "10 usos" },
  { value: "100", label: "100 usos" },
];

/** Delta U-04 — texto obrigatório, e a razão de o código de terceiros não aparecer. */
const TEXTO_U04 =
  "Só quem criou um convite consegue ver o código dele. Isso é o que impede alguém de emitir convites em nome de outra pessoa.";

/** Delta U-05 — texto obrigatório: não há aprovação manual; mitigação é revogar. */
const TEXTO_U05 =
  "Não há aprovação manual: a mitigação de link vazado é revogar.";

/**
 * Convites da comunidade (§10, 3.1b) — a única porta de entrada; não existe
 * diretório público.
 */
export function CommunityInvitesSection({
  community,
  semHost = false,
}: {
  community: Community;
  semHost?: boolean;
}) {
  const findMember = useFindMember();
  const invites = useInvites(community.id);
  const showToast = useToastStore((state) => state.showToast);

  const [creatingInvite, setCreatingInvite] = useState(false);
  const [criandoConvite, setCriandoConvite] = useState(false);
  const [revogando, setRevogando] = useState<string | null>(null);
  const criandoConviteRef = useRef(false);
  const revogandoRef = useRef<string | null>(null);
  const [expiry, setExpiry] = useState("0");
  const [uses, setUses] = useState("0");

  /**
   * §15.4 `invite.create` — confirma-depois-desenha (U-02): nada de convite
   * otimista. O `code` só existe NESTA resposta (nunca no log nem em
   * evento), então o toast é a única vez que ele aparece pronto para copiar.
   */
  async function criarConvite() {
    if (semHost || criandoConviteRef.current) return;
    criandoConviteRef.current = true;
    setCriandoConvite(true);
    try {
      const dias = Number(expiry);
      const limite = Number(uses);
      const r = await api.inviteCreate({
        communityId: community.id,
        ...(dias > 0 ? { expiresInDays: dias } : {}),
        ...(limite > 0 ? { maxUses: limite } : {}),
      });
      setCreatingInvite(false);
      showToast(`Convite ${r.code} criado`);
      await sincronizarConvites(community.id);
    } catch (e) {
      showToast(mensagemDeErro(e), "error");
    } finally {
      criandoConviteRef.current = false;
      setCriandoConvite(false);
    }
  }

  /**
   * §15.4 `invite.revoke` — a chave pública é o identificador estável da linha, e §15.6 a
   * entrega para **todo** convite (só o código é restrito, por U-04). Revogar é a ação que
   * continua valendo sem o código, e é por isso que ela não pode depender dele.
   *
   * A busca em `api.invites` que existia aqui procurava o alvo comparando o código com a
   * chave pública, porque o adaptador punha uma no campo da outra. Sem essa confusão, a
   * linha já traz o que o comando pede.
   */
  async function revogarConvite(invite: Invite) {
    if (semHost || revogandoRef.current !== null) return;
    revogandoRef.current = invite.invitePublicKey;
    setRevogando(invite.invitePublicKey);
    try {
      await api.inviteRevoke({
        communityId: community.id,
        invitePublicKey: invite.invitePublicKey,
      });
      await sincronizarConvites(community.id);
    } catch (e) {
      showToast(mensagemDeErro(e), "error");
    } finally {
      revogandoRef.current = null;
      setRevogando(null);
    }
  }

  return (
    <>
      {/*
        As duas frases de apoio vão juntas na `description`. Separadas — uma no
        slot da seção, a outra como primeiro filho — elas saíam com a mesma
        forma (12px, `tertiary`) em dois níveis diferentes de espaçamento, e o
        topo da seção lia como três linhas soltas de tamanhos parecidos.
        O texto de U-05 continua literal.
      */}
      <SettingsSection
        title="Convites"
        description={`A única porta de entrada da comunidade — não existe diretório público. ${TEXTO_U05}`}
      >
        {invites.length === 0 && (
          <p className="text-body text-text-tertiary">
            Nenhum convite ativo. Crie um para alguém entrar.
          </p>
        )}

        {invites.map((invite) => (
          <SettingsRow
            key={invite.invitePublicKey}
            action={
              <span className="flex shrink-0 gap-1">
                {/*
                  U-04 — sem código nesta instalação não há link para copiar, e a ação fica
                  **indisponível**. Antes ela aparecia sempre e copiava
                  `p2p.app/invite/<64 hex da chave pública>`: um link que não resgata nada.
                */}
                {invite.code !== undefined && (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Copiar link do convite ${invite.code}`}
                    onClick={() => {
                      const codigo = invite.code;
                      if (codigo === undefined) return;
                      void copiarTexto(linkDeConvite(codigo)).then((ok) =>
                        showToast(
                          ok ? "Link copiado" : "Não foi possível copiar o link",
                          ok ? "success" : "error",
                        ),
                      );
                    }}
                  >
                    <Copy size={16} strokeWidth={2} aria-hidden="true" />
                  </Button>
                )}
                {/* Revogar é destrutivo mas reversível na prática:
                    basta criar outro convite (§15). Continua disponível sem o código —
                    a chave pública é o identificador, e é ela que `invite.revoke` pede. */}
                <Button
                  variant="ghost"
                  size="sm"
                  loading={revogando === invite.invitePublicKey}
                  disabled={semHost || (revogando !== null && revogando !== invite.invitePublicKey)}
                  title={semHost ? OFFLINE_HINT : undefined}
                  onClick={() => void revogarConvite(invite)}
                >
                  Revogar
                </Button>
              </span>
            }
          >
            {invite.code !== undefined ? (
              <span className="block truncate font-mono text-body text-text-primary">
                {invite.code}
              </span>
            ) : (
              <span className="block truncate text-body text-text-tertiary">
                Código não disponível neste dispositivo
              </span>
            )}
            <span className="block truncate text-meta text-text-tertiary">
              {findMember(community.id, invite.createdById)?.displayName ??
                "Alguém"}{" "}
              · {invite.uses}
              {invite.maxUses ? `/${invite.maxUses}` : ""} usos ·{" "}
              {invite.expiresAt
                ? `expira ${formatRelativeTime(invite.expiresAt)}`
                : "sem expiração"}
            </span>
          </SettingsRow>
        ))}

        {/* U-04 — o texto é obrigatório, e explica a linha acima em vez de só constatá-la. */}
        {invites.some((i) => i.code === undefined) && (
          <p className="text-meta text-text-tertiary">{TEXTO_U04}</p>
        )}

        <Button
          variant="secondary"
          size="sm"
          className="self-start"
          disabled={semHost}
          title={semHost ? OFFLINE_HINT : undefined}
          onClick={() => setCreatingInvite(true)}
        >
          Criar novo convite
        </Button>
      </SettingsSection>

      {creatingInvite && (
        <Modal
          open
          onClose={() => setCreatingInvite(false)}
          title="Criar convite"
          size="md"
        >
          <div className="flex flex-col gap-4">
            <p className="text-meta text-text-tertiary">{TEXTO_U05}</p>
            <Select
              label="Expiração"
              value={expiry}
              options={EXPIRY_OPTIONS}
              onChange={setExpiry}
            />
            <Select
              label="Limite de usos"
              value={uses}
              options={USES_OPTIONS}
              onChange={setUses}
            />
            <div className="mt-2 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setCreatingInvite(false)}>
                Cancelar
              </Button>
              <Button
                loading={criandoConvite}
                disabled={semHost || criandoConvite}
                title={semHost ? OFFLINE_HINT : undefined}
                onClick={() => void criarConvite()}
              >
                Criar convite
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
