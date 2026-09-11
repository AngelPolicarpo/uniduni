import { useEffect, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Checkbox } from "../../components/ui/Checkbox";
import { Modal } from "../../components/ui/Modal";
import { useVoiceStore } from "../../store/voiceStore";

/**
 * A aba pode estar em segundo plano na hora em que a árvore precisa de mais
 * um nó. §11 (B6, exceções) é explícita: espera Ana voltar a focar a aba,
 * **nunca** assume recusa por inatividade ou timeout.
 */
function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(
    () => typeof document === "undefined" || !document.hidden,
  );

  useEffect(() => {
    function handle() {
      setVisible(!document.hidden);
    }
    document.addEventListener("visibilitychange", handle);
    return () => document.removeEventListener("visibilitychange", handle);
  }, []);

  return visible;
}

/**
 * Modal de consentimento de repasse (§9, 2.4.1 · fluxo B6).
 *
 * §17.7 — consentimento de **relay voluntário**, explícito e persistido
 * (`local_relay_consent`); sem ele, `E_CONSENT_REQUIRED`. A tela está de pé e **dormente**:
 * o gatilho antigo era a transição estrela→árvore, que A20 tirou do v1 (B26), e o novo é
 * `relay.consentRequested` (§15.5), que chega quando o relay voluntário existir (B27/B30).
 *
 * Recusar não tem custo nenhum — o texto não usa tom de culpa.
 */
export function RelayConsentModal() {
  const request = useVoiceStore((state) => state.consentRequest);
  const respondConsent = useVoiceStore((state) => state.respondConsent);
  const [remember, setRemember] = useState(false);
  const visible = useDocumentVisible();

  if (!request || !visible) return null;

  return (
    <Modal
      open
      // Não há fechar silencioso: §17.7 exige consentimento explícito, e "sem
      // resposta" nunca vira aceite.
      onClose={() => respondConsent(false, remember)}
      title="Ajudar a retransmitir?"
      size="sm"
    >
      <div className="flex flex-col gap-4">
        <p className="text-body text-text-secondary">
          Sua conexão pode retransmitir chamadas de outras pessoas desta
          comunidade, usando um pouco do seu upload. Isso não afeta as suas.
        </p>
        {/*
          §17.7 — o motivo vem do host (`relay.consentRequested{reason}`). L-14 exige dizer
          o que o voluntário observa: metadados, nunca conteúdo (DTLS-SRTP ponta a ponta).
        */}
        <p className="text-meta text-text-tertiary">
          {request.reason} Você vê com quem e quando, nunca o que é transmitido.
        </p>

        <Checkbox
          checked={remember}
          onChange={setRemember}
          label="Lembrar minha escolha para esta comunidade"
        />

        <div className="mt-2 flex justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() => respondConsent(false, remember)}
          >
            Recusar
          </Button>
          <Button onClick={() => respondConsent(true, remember)}>Aceitar</Button>
        </div>
      </div>
    </Modal>
  );
}
