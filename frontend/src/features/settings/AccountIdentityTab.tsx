import { useState } from "react";
import { Copy } from "lucide-react";
import { Avatar } from "../../components/ui/Avatar";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { Select } from "../../components/ui/Select";
import { TextField } from "../../components/ui/TextField";
import { DangerZone, SettingsSection } from "./SettingsLayout";
import {
  TEXTO_CHAVE_PRIVADA,
  TEXTO_CHAVE_PUBLICA,
  chaveParaExibir,
} from "./chaveDeIdentidade";
import { useToastStore } from "../../store/toastStore";
import { nextAvatarColor } from "../../lib/avatar";
import { useIdentityStore } from "../../store/identityStore";
import { useCommunityStore } from "../../store/communityStore";
import { useMessageStore } from "../../store/messageStore";
import { useVoiceStore } from "../../store/voiceStore";
import { usePendingInviteStore } from "../../store/inviteStore";
import type { Identity, PresenceStatus } from "../../domain/types";

/**
 * §10, 3.1 — identidade local e a zona de perigo.
 *
 * "Sair desta identidade" diz o que ninguém pode desfazer: sem conta central,
 * não existe recuperação (§1, princípio 1).
 */
export function AccountIdentityTab({ identity }: { identity: Identity }) {
  const updateIdentity = useIdentityStore((state) => state.updateIdentity);
  const clearIdentity = useIdentityStore((state) => state.clearIdentity);
  const setPresence = useIdentityStore((state) => state.setPresence);
  const resetCommunities = useCommunityStore((state) => state.resetCommunities);
  const resetMessages = useMessageStore((state) => state.reset);
  const leaveVoice = useVoiceStore((state) => state.leave);
  const clearPendingInvite = usePendingInviteStore(
    (state) => state.clearPendingInvite,
  );

  const showToast = useToastStore((state) => state.showToast);

  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  // U-34 — a chave **inteira**. `null` só enquanto a identidade não carregou.
  const chavePublica = chaveParaExibir(identity.publicKey);

  function signOut() {
    leaveVoice();
    resetCommunities();
    resetMessages();
    clearPendingInvite();
    clearIdentity();
  }

  return (
    <>
      <SettingsSection title="Identidade">
        <div className="flex items-center gap-4">
          <Avatar
            name={identity.displayName}
            color={identity.avatarColor}
            size="lg"
            presence={identity.presence}
            presenceRingClass="border-surface-elevated"
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              updateIdentity({
                avatarColor: nextAvatarColor(identity.avatarColor),
              })
            }
          >
            Gerar outra cor
          </Button>
        </div>

        <TextField
          label="Nome de exibição"
          value={identity.displayName}
          onChange={(value) => updateIdentity({ displayName: value })}
          limiteCp={32}
          showCounter
          counterWarningAt={28}
        />

        {/*
          §5.4 define quatro estados de presença, com dot e cor; até
          aqui não havia onde escolher um. Este é o caminho principal;
          o popover do próprio perfil (§8, 1.4) é o atalho.
        */}
        <Select
          label="Presença"
          value={identity.presence}
          onChange={(value) => setPresence(value as PresenceStatus)}
          hint={
            identity.presence === "invisible"
              ? "Você aparece como offline, mas continua recebendo tudo normalmente."
              : undefined
          }
          options={[
            { value: "online", label: "Online" },
            { value: "idle", label: "Ausente" },
            { value: "dnd", label: "Ocupado" },
            { value: "invisible", label: "Invisível" },
          ]}
        />

        {/*
          **U-34** — a chave pública é um ENDEREÇO, e a tela precisa deixar entregá-lo.
          Truncada (`a1b2…f9e2`, como era até 2026-09-02) ela não é fornecível, e por
          **L-24** não existe outro caminho: sem diretório e sem busca, quem quiser abrir
          uma conversa direta com esta pessoa precisa destes 64 caracteres (§31.8,
          §31.16.1 `dm.open`).
        */}
        <div>
          <p className="text-caption text-text-tertiary uppercase">
            Identificador local
          </p>
          <p className="mt-1 font-mono text-body text-text-secondary">{identity.handle}</p>

          <p className="mt-4 text-caption text-text-tertiary uppercase">
            Chave pública
          </p>
          <div className="mt-1 flex items-start gap-2">
            <p className="min-w-0 flex-1 select-all font-mono text-meta break-all text-text-secondary">
              {chavePublica ?? "—"}
            </p>
            {chavePublica !== null && (
              <Button
                variant="ghost"
                size="sm"
                aria-label="Copiar chave pública"
                className="shrink-0"
                onClick={() => {
                  // O que se copia é o valor exato exibido: a chave não é reformatada na
                  // tela justamente para que as duas coisas não possam divergir.
                  void navigator.clipboard.writeText(chavePublica);
                  showToast("Chave copiada");
                }}
              >
                <Copy size={16} strokeWidth={2} aria-hidden="true" />
              </Button>
            )}
          </div>
          <p className="mt-1 text-meta text-text-tertiary">{TEXTO_CHAVE_PUBLICA}</p>

          {/*
            A frase que estava sob a chave PÚBLICA e é verdade só da privada. Colada ali,
            ela lia como "não compartilhe" — o oposto do que §31.8 exige. U-34 separa as
            duas, e a UI continua sem oferecer exibir, exportar ou copiar a privada
            (§3.2 item 5; `identity.export` é backup cifrado, não exibição).
          */}
          <p className="mt-2 text-meta text-text-tertiary">{TEXTO_CHAVE_PRIVADA}</p>
        </div>
      </SettingsSection>

      <DangerZone>
        <p className="text-body text-text-secondary">
          Apagar a identidade remove o par de chaves deste dispositivo.
          Como não existe conta central, não há como recuperá-la — nem
          voltar às comunidades em que você entrou com ela.
        </p>
        <Button
          variant="danger"
          size="sm"
          onClick={() => setConfirmingSignOut(true)}
          className="self-start"
        >
          Sair desta identidade
        </Button>
      </DangerZone>

      {confirmingSignOut && (
        <Modal
          open
          onClose={() => setConfirmingSignOut(false)}
          title="Sair desta identidade?"
          size="sm"
        >
          <div className="flex flex-col gap-4">
            <p className="text-body text-text-secondary">
              A identidade {identity.displayName} será apagada deste
              dispositivo. Não há conta central e não existe recuperação — você
              precisaria de um convite novo para voltar a qualquer comunidade.
            </p>
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() => setConfirmingSignOut(false)}
              >
                Cancelar
              </Button>
              <Button variant="danger" onClick={signOut}>
                Apagar identidade
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
