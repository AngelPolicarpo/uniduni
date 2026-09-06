import { useState } from "react";
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

/**
 * Convites da comunidade (§10, 3.1b) — a única porta de entrada; não existe
 * diretório público.
 */
export function CommunityInvitesSection({ community }: { community: Community }) {
  const findMember = useFindMember();
  const invites = useInvites(community.id);
  const showToast = useToastStore((state) => state.showToast);

  const [creatingInvite, setCreatingInvite] = useState(false);
  const [criandoConvite, setCriandoConvite] = useState(false);
  const [revogando, setRevogando] = useState<string | null>(null);
  const [expiry, setExpiry] = useState("0");
  const [uses, setUses] = useState("0");

  /**
   * §15.4 `invite.create` — confirma-depois-desenha (U-02): nada de convite
   * otimista. O `code` só existe NESTA resposta (nunca no log nem em
   * evento), então o toast é a única vez que ele aparece pronto para copiar.
   */
  async function criarConvite() {
    if (criandoConvite) return;
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
    if (revogando !== null) return;
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
      setRevogando(null);
    }
  }

  return (
    <>
      <SettingsSection
        title="Convites"
        description="A única porta de entrada da comunidade — não existe diretório público."
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
                  disabled={revogando !== null && revogando !== invite.invitePublicKey}
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
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setCreatingInvite(false)}>
                Cancelar
              </Button>
              <Button loading={criandoConvite} onClick={() => void criarConvite()}>
                Criar convite
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
