import { useState } from "react";
import type { FormEvent } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Avatar } from "../../components/ui/Avatar";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { TextArea } from "../../components/ui/TextArea";
import { TextField } from "../../components/ui/TextField";
import { avatarColorFromSeed, nextAvatarColor } from "../../lib/avatar";
import { useCommunityStore, useJoinedCommunities } from "../../store/communityStore";
import { useToastStore } from "../../store/toastStore";
import { useUiStore } from "../../store/uiStore";
import { mensagemDeErro, useSessao } from "../../live/sessao";
import { numeroDaCor } from "../../ipc/cores";
import type { AvatarColor } from "../../domain/types";
import { codePoints } from "../../lib/texto";

/** §13 — Nome: obrigatório, 2-40 · Descrição: opcional, até 120. */
const NAME_MIN = 2;
const NAME_MAX = 40;
const NAME_WARNING_AT = 36;
const DESCRIPTION_MAX = 120;
const DESCRIPTION_WARNING_AT = 108;

type Phase = "editing" | "creating";

function validate(rawName: string): string | undefined {
  const name = rawName.trim();
  if (name.length === 0) return "Digite um nome para a comunidade.";
  if (codePoints(name) < NAME_MIN)
    return `O nome precisa ter pelo menos ${NAME_MIN} caracteres.`;
  return undefined;
}

/**
 * 0.4 Criar comunidade / virar host — fluxo A3.
 *
 * A decisão de produto mais importante desta tela é o aviso permanente: a
 * comunidade depende desta máquina continuar rodando. Ele não é toast, não
 * é tooltip e não é dispensável.
 */
export function CreateCommunityModal() {
  const closeOverlay = useUiStore((state) => state.closeOverlay);
  const setActiveChannel = useCommunityStore((state) => state.setActiveChannel);
  const joinedCommunities = useJoinedCommunities();
  const showToast = useToastStore((state) => state.showToast);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [iconColor, setIconColor] = useState<AvatarColor>(() =>
    avatarColorFromSeed(crypto.randomUUID()),
  );
  const [error, setError] = useState<string | undefined>();
  const [phase, setPhase] = useState<Phase>("editing");
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  const isValid = validate(name) === undefined;
  const isDirty = name.trim().length > 0 || description.trim().length > 0;

  /**
   * Não há unicidade global em P2P: nome repetido é só risco de confusão
   * visual no rail, então avisa sem bloquear (§11, A3 exceções).
   */
  const duplicateName = joinedCommunities.some(
    (community) =>
      community.name.trim().toLowerCase() === name.trim().toLowerCase(),
  );

  function handleNameChange(value: string) {
    setName(value);
    if (error && validate(value) === undefined) setError(undefined);
  }

  async function criar() {
    // Cor é u8 na escrita (§6.4.2) — constante de protocolo, não tema.
    const cor = numeroDaCor(iconColor);
    if (cor === null) {
      setError("Cor fora do catálogo do protocolo.");
      setPhase("editing");
      return;
    }
    setPhase("creating");
    try {
      const r = await useSessao.getState().criarComunidade({
        name: name.trim(),
        ...(description.trim() !== "" ? { description: description.trim() } : {}),
        iconColor: cor,
      });
      // O `recarregar()` dentro de `criarComunidade` trouxe o rail e a
      // estrutura do núcleo; o canal padrão vem da própria resposta.
      setActiveChannel(r.communityId, r.defaultChannelId);
      showToast(`${name.trim()} criada — você é o host`);
      closeOverlay();
    } catch (e) {
      setError(mensagemDeErro(e));
      setPhase("editing");
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (phase !== "editing") return;

    const validationError = validate(name);
    if (validationError) {
      setError(validationError);
      return;
    }

    void criar();
  }

  /** `Esc`/scrim com formulário preenchido pedem confirmação (§15). */
  function guardClose() {
    if (phase === "creating") return false;
    if (!isDirty) return true;
    setConfirmingDiscard(true);
    return false;
  }

  return (
    <>
      <Modal
        open
        onClose={closeOverlay}
        title="Criar comunidade"
        size="lg"
        guardClose={guardClose}
      >
        <form className="flex flex-col gap-6" onSubmit={handleSubmit}>
          <TextField
            label="Nome da comunidade"
            value={name}
            onChange={handleNameChange}
            onBlur={() => setError(validate(name))}
            error={error}
            placeholder="Ex.: Clã Noturno"
            limiteCp={NAME_MAX}
            counterWarningAt={NAME_WARNING_AT}
            showCounter
            autoFocus
            autoComplete="off"
            disabled={phase !== "editing"}
          />

          {duplicateName && !error && (
            <p className="-mt-4 text-meta text-feedback-warning">
              Você já participa de uma comunidade com este nome. Dá pra criar
              assim mesmo — só fica difícil diferenciar as duas no rail.
            </p>
          )}

          <div className="flex items-center gap-4 rounded-md border border-border-default bg-surface-sidebar p-4">
            <Avatar
              name={name}
              color={iconColor}
              size="lg"
              shape="squircle"
              presenceRingClass="border-surface-sidebar"
            />
            <div className="flex min-w-0 flex-col items-start gap-2">
              <p className="text-body-emphasis text-text-primary">
                Ícone da comunidade
              </p>
              <p className="text-meta text-text-tertiary">
                As iniciais do nome sobre uma cor sorteada.
              </p>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setIconColor(nextAvatarColor(iconColor))}
                disabled={phase !== "editing"}
                leadingIcon={<RefreshCw size={16} strokeWidth={2} />}
              >
                Gerar outra cor
              </Button>
            </div>
          </div>

          <TextArea
            label="Descrição (opcional)"
            value={description}
            onChange={setDescription}
            placeholder="Do que essa comunidade trata?"
            limiteCp={DESCRIPTION_MAX}
            counterWarningAt={DESCRIPTION_WARNING_AT}
            showCounter
            disabled={phase !== "editing"}
          />

          {/* Aviso permanente e não-dispensável (§7, 0.4). */}
          <div className="flex items-start gap-3 rounded-md border border-border-default bg-surface-sidebar p-4">
            <AlertTriangle
              size={20}
              strokeWidth={2}
              className="mt-px shrink-0 text-conn-degraded"
              aria-hidden="true"
            />
            <p className="text-meta text-text-secondary">
              Esta comunidade fica hospedada neste dispositivo. Se ele ficar
              offline, outras pessoas não conseguem enviar novas mensagens até
              você voltar.
            </p>
          </div>

          <div className="flex flex-col gap-3 tablet:flex-row tablet:justify-end">
            <Button
              variant="secondary"
              size="lg"
              onClick={() => (guardClose() ? closeOverlay() : undefined)}
              disabled={phase !== "editing"}
            >
              Cancelar
            </Button>
            <Button
              type="submit"
              size="lg"
              disabled={!isValid}
              loading={phase === "creating"}
            >
              Criar e virar host
            </Button>
          </div>
        </form>
      </Modal>

      {confirmingDiscard && (
        <Modal
          open
          onClose={() => setConfirmingDiscard(false)}
          title="Descartar esta comunidade?"
          size="sm"
        >
          <p className="text-body text-text-secondary">
            O que você preencheu ainda não foi criado. Fechar agora descarta o
            nome, o ícone e a descrição.
          </p>
          <div className="mt-6 flex flex-col gap-3 tablet:flex-row tablet:justify-end">
            <Button
              variant="secondary"
              onClick={() => setConfirmingDiscard(false)}
            >
              Continuar editando
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmingDiscard(false);
                closeOverlay();
              }}
            >
              Descartar
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
