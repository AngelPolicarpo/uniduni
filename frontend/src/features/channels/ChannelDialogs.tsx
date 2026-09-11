import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { Select } from "../../components/ui/Select";
import { TextField } from "../../components/ui/TextField";
import { channelName } from "../../lib/channelName";
import { api } from "../../ipc/api";
import { codigoDoErro } from "../../ipc/frames";
import { sincronizarComunidade } from "../../live/sincronizacao";
import { motivoDaRecusa, OFFLINE_HINT } from "../../live/recusas";
import {
  useCategories,
  useCategory,
  useChannel,
  useChannelCount,
  useChannels,
  useCommunityStore,
  useRoles,
} from "../../store/communityStore";
import { useMessageStore } from "../../store/messageStore";
import { useToastStore } from "../../store/toastStore";
import { useUiStore } from "../../store/uiStore";
import { useHostStatus } from "../../store/connectionStore";
import { useVoiceChannelParticipantIds, useVoiceStore } from "../../store/voiceStore";
import { ChannelForm } from "./ChannelForm";
import {
  NAME_MAX,
  NEW_CATEGORY,
  QUEUE_TURN_DEFAULT,
  roleIdsExcluding,
  sameRoleIds,
  speechModeNumber,
  validateChannelForm,
} from "./channelFormModel";
import type { ChannelFormErrors, ChannelFormValue } from "./channelFormModel";
import type { Channel, Community, Role } from "../../domain/types";

/**
 * Estrutura é **confirma-depois-desenha** (A25, U-02): a op é síncrona, exige host online e
 * não enfileira. Nada aparece na tela antes de o núcleo aceitar, e o que aparece depois vem
 * do log pela reconsulta — não de um espelho local.
 */
function Recusa({ texto }: { texto: string | null }) {
  if (texto === null) return null;
  return (
    <p role="alert" className="rounded-md border border-feedback-danger/40 bg-surface-primary p-3 text-meta text-feedback-danger">
      {texto}
    </p>
  );
}

/** Cargos que já vêm marcados como "pode postar" ao ligar somente-leitura. */
function moderatorRoleIds(roles: Role[]): string[] {
  return roles
    .filter(
      (role) =>
        role.isFounder ||
        role.permissions.includes("manage_messages") ||
        role.permissions.includes("manage_community"),
    )
    .map((role) => role.id);
}

/**
 * Nomes de canal já usados na comunidade — base da checagem de duplicidade
 * de §13, que aqui é bloqueante porque o nome é o endereço do canal.
 */
function useExistingNames(communityId: string, exceptId?: string): string[] {
  const categories = useCategories(communityId);
  const channelIds = useMemo(
    () => categories.flatMap((category) => category.channelIds),
    [categories],
  );
  const channels = useChannels(channelIds);
  return channels
    .filter((channel) => channel.id !== exceptId)
    .map((channel) => channel.name);
}

/* ─── Criar canal ─────────────────────────────────────────────────── */

interface CreateChannelModalProps {
  community: Community;
  categoryId?: string;
}

function CreateChannelModal({ community, categoryId }: CreateChannelModalProps) {
  const close = useUiStore((state) => state.closeChannelDialog);
  const categories = useCategories(community.id);
  const roles = useRoles(community.id);
  const setActiveChannel = useCommunityStore((state) => state.setActiveChannel);
  const existing = useExistingNames(community.id);

  const [value, setValue] = useState<ChannelFormValue>(() => ({
    type: "text",
    name: "",
    topic: "",
    categoryId: categoryId ?? categories[0]?.id ?? NEW_CATEGORY,
    newCategoryName: "",
    readOnly: false,
    canPostRoleIds: moderatorRoleIds(roles),
    speechMode: "free",
    queueTurnSeconds: QUEUE_TURN_DEFAULT,
  }));
  const [errors, setErrors] = useState<ChannelFormErrors>({});
  const [creating, setCreating] = useState(false);
  const [recusa, setRecusa] = useState<string | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  const takenNames = existing.map((name) => name.toLowerCase());
  const isDirty = value.name.trim().length > 0 || value.topic.trim().length > 0;

  function patch(next: Partial<ChannelFormValue>) {
    setValue((current) => ({ ...current, ...next }));
    // Tipo e nome mudam como o nome é normalizado, então o erro deixa de
    // valer na hora — não espera o próximo blur (§12).
    if ((next.name !== undefined || next.type) && errors.name)
      setErrors((current) => ({ ...current, name: undefined }));
    if (next.queueTurnSeconds !== undefined && errors.queueTurnSeconds)
      setErrors((current) => ({ ...current, queueTurnSeconds: undefined }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creating) return;

    const found = validateChannelForm(value, takenNames);
    if (found.name || found.category || found.queueTurnSeconds || found.readOnly) {
      setErrors(found);
      return;
    }

    setCreating(true);
    setRecusa(null);
    try {
      // "+ Nova categoria…" cria categoria e canal na mesma confirmação (D14).
      // São DUAS ops no log, não uma: se o canal for recusado, a categoria já
      // existe e aparece na tela — §15.4 não tem op de compensação, e inventar
      // um "desfazer" aqui seria escrever regra de domínio fora do fold.
      let targetCategoryId = value.categoryId;
      if (targetCategoryId === NEW_CATEGORY) {
        const criada = await api.categoryCreate({
          communityId: community.id,
          name: value.newCategoryName.trim(),
        });
        targetCategoryId = criada.categoryId;
      }

      const topico = value.topic.trim();
      const criado = await api.channelCreate({
        communityId: community.id,
        categoryId: targetCategoryId,
        // §7.2: `text = 0 · voice = 1`, constante de protocolo.
        type: value.type === "voice" ? 1 : 0,
        name: channelName(value.type, value.name),
        ...(topico !== "" ? { topic: topico } : {}),
        ...(value.readOnly
          ? {
              readOnlyForRoleIds: roleIdsExcluding(roles, value.canPostRoleIds),
            }
          : {}),
        // §6.6 (R-29) — modo de fala só existe em canal de voz; o turno só viaja
        // quando o canal FICA em modo fila.
        ...(value.type === "voice"
          ? {
              speechMode: speechModeNumber(value.speechMode),
              ...(value.speechMode === "queue"
                ? { queueTurnSeconds: value.queueTurnSeconds }
                : {}),
            }
          : {}),
      });

      // O canal só existe na tela depois de vir do log (§15.4: `rank` pode nem
      // chegar na resposta se a projeção local estiver atrasada).
      await sincronizarComunidade(community.id);
      // Canal de texto novo vira o ativo; o de voz não troca o conteúdo (§4).
      if (value.type === "text") setActiveChannel(community.id, criado.channelId);
      close();
    } catch (e) {
      setRecusa(motivoDaRecusa(codigoDoErro(e)));
    } finally {
      setCreating(false);
    }
  }

  function guardClose() {
    if (creating) return false;
    if (!isDirty) return true;
    setConfirmingDiscard(true);
    return false;
  }

  return (
    <>
      <Modal
        open
        onClose={close}
        title="Criar canal"
        size="md"
        guardClose={guardClose}
      >
        <form className="flex flex-col gap-6" onSubmit={handleSubmit}>
          <ChannelForm
            value={value}
            onChange={patch}
            errors={errors}
            onBlurName={() =>
              setErrors(validateChannelForm(value, takenNames))
            }
            categories={categories}
            roles={roles}
            disabled={creating}
          />

          <Recusa texto={recusa} />

          <div className="flex flex-col gap-3 tablet:flex-row tablet:justify-end">
            <Button
              variant="secondary"
              size="lg"
              onClick={() => (guardClose() ? close() : undefined)}
              disabled={creating}
            >
              Cancelar
            </Button>
            <Button
              type="submit"
              size="lg"
              loading={creating}
              disabled={
                value.name.trim().length === 0 ||
                (value.readOnly && value.canPostRoleIds.length === 0)
              }
            >
              Criar canal
            </Button>
          </div>
        </form>
      </Modal>

      {confirmingDiscard && (
        <Modal
          open
          onClose={() => setConfirmingDiscard(false)}
          title="Descartar este canal?"
          size="sm"
        >
          <p className="text-body text-text-secondary">
            O canal ainda não foi criado. Fechar agora descarta o que você
            preencheu.
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
                close();
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

/* ─── Editar canal ────────────────────────────────────────────────── */

interface EditChannelModalProps {
  community: Community;
  channel: Channel;
}

function EditChannelModal({ community, channel }: EditChannelModalProps) {
  const close = useUiStore((state) => state.closeChannelDialog);
  const openDialog = useUiStore((state) => state.openChannelDialog);
  const categories = useCategories(community.id);
  const roles = useRoles(community.id);
  const channelCount = useChannelCount(community.id);
  const hostStatus = useHostStatus(community);
  const showToast = useToastStore((state) => state.showToast);
  const existing = useExistingNames(community.id, channel.id);

  const readOnlyIds = channel.readOnlyForRoleIds ?? [];
  const [value, setValue] = useState<ChannelFormValue>(() => ({
    type: channel.type,
    name: channel.name,
    topic: channel.topic ?? "",
    categoryId: channel.categoryId,
    newCategoryName: "",
    readOnly: readOnlyIds.length > 0,
    canPostRoleIds: roleIdsExcluding(roles, readOnlyIds),
    speechMode: channel.speechMode,
    queueTurnSeconds: channel.queueTurnSeconds,
  }));
  const [errors, setErrors] = useState<ChannelFormErrors>({});
  const [salvando, setSalvando] = useState(false);
  const [recusa, setRecusa] = useState<string | null>(null);

  const takenNames = existing.map((name) => name.toLowerCase());
  const isLastChannel = channelCount <= 1;
  const semHost = hostStatus !== "online";

  /**
   * O que este formulário mudaria no log, se salvo agora. Serve para duas coisas: dizer se o
   * botão está sujo e montar as ops — a mesma conta, uma fonte só.
   *
   * `type` não entra: §7.2 o declara imutável, e o formulário já vem com `lockType`.
   */
  const alvoReadOnly = value.readOnly
    ? roleIdsExcluding(roles, value.canPostRoleIds)
    : [];
  const nomeResolvido = channelName(value.type, value.name);
  const topicoNovo = value.topic.trim() === "" ? undefined : value.topic.trim();
  const mudouNome = nomeResolvido !== channel.name;
  const mudouTopico = (topicoNovo ?? "") !== (channel.topic ?? "");
  const mudouReadOnly = !sameRoleIds(alvoReadOnly, readOnlyIds);
  const mudouCategoria =
    value.categoryId !== channel.categoryId && value.categoryId !== NEW_CATEGORY;
  // §6.6 (R-29) — modo de fala é só de voz; o turno compara só no modo fila.
  const mudouModo =
    value.type === "voice" && value.speechMode !== channel.speechMode;
  const mudouTurno =
    value.type === "voice" &&
    value.speechMode === "queue" &&
    value.queueTurnSeconds !== channel.queueTurnSeconds;
  const sujo =
    mudouNome || mudouTopico || mudouReadOnly || mudouCategoria || mudouModo || mudouTurno;

  function patch(next: Partial<ChannelFormValue>) {
    const merged = { ...value, ...next };
    setValue(merged);
    setErrors(validateChannelForm(merged, takenNames));
    if (recusa !== null) setRecusa(null);
  }

  /**
   * U-23: salvamento explícito. O auto-save de 800 ms saiu porque `channel.update` é op
   * síncrona num log append-only com rate limit de §14.4 — digitar o nome produzia uma op
   * por tecla e queimava o limite (`F-12`). Não era debounce curto demais: era modelo errado.
   *
   * Mover é `channel.move`, não `channel.update` — kinds diferentes em §7.4. Por isso pode
   * sair mais de uma op de um clique só, e por isso a reconsulta vem no fim, uma vez.
   */
  async function salvar() {
    if (salvando || !sujo) return;
    const found = validateChannelForm(value, takenNames);
    setErrors(found);
    if (found.name || found.category || found.queueTurnSeconds || found.readOnly) return;

    setSalvando(true);
    setRecusa(null);
    try {
      if (mudouNome || mudouTopico || mudouReadOnly || mudouModo || mudouTurno) {
        await api.channelUpdate({
          communityId: community.id,
          channelId: channel.id,
          ...(mudouNome ? { name: nomeResolvido } : {}),
          ...(mudouTopico ? { topic: topicoNovo ?? "" } : {}),
          ...(mudouReadOnly ? { readOnlyForRoleIds: alvoReadOnly } : {}),
          ...(mudouModo ? { speechMode: speechModeNumber(value.speechMode) } : {}),
          ...(mudouTurno ? { queueTurnSeconds: value.queueTurnSeconds } : {}),
        });
      }
      if (mudouCategoria) {
        await api.channelMove({
          communityId: community.id,
          channelId: channel.id,
          categoryId: value.categoryId,
        });
      }
      await sincronizarComunidade(community.id);
      showToast("Alterações salvas", "success");
      close();
    } catch (e) {
      setRecusa(motivoDaRecusa(codigoDoErro(e)));
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Modal open onClose={close} title="Editar canal" size="md">
      <div className="flex flex-col gap-6">
        <ChannelForm
          value={value}
          onChange={patch}
          errors={errors}
          onBlurName={() => setErrors(validateChannelForm(value, takenNames))}
          categories={categories}
          roles={roles}
          lockType
          disabled={salvando}
        />

        <Recusa texto={recusa} />

        <div className="flex flex-col gap-3 tablet:flex-row tablet:justify-end">
          <Button variant="secondary" onClick={close} disabled={salvando}>
            Cancelar
          </Button>
          <Button
            onClick={() => void salvar()}
            loading={salvando}
            disabled={
              !sujo ||
              semHost ||
              (value.readOnly && value.canPostRoleIds.length === 0)
            }
            title={semHost ? OFFLINE_HINT : undefined}
          >
            Salvar alterações
          </Button>
        </div>

        {/* Zona de perigo, igual à de 3.1b. */}
        <div className="flex flex-col gap-3 border-t border-border-default pt-6">
          <h3 className="text-heading-3 text-text-primary">Zona de perigo</h3>
          {isLastChannel ? (
            <p className="text-meta text-text-tertiary">
              Toda comunidade precisa de pelo menos um canal.
            </p>
          ) : (
            <>
              <p className="text-meta text-text-secondary">
                Excluir remove o canal para todo mundo. Não pode ser desfeito.
              </p>
              <Button
                variant="danger"
                onClick={() =>
                  openDialog({ kind: "delete-channel", channelId: channel.id })
                }
              >
                Excluir canal
              </Button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

/* ─── Excluir canal ───────────────────────────────────────────────── */

function DeleteChannelDialog({
  community,
  channel,
}: {
  community: Community;
  channel: Channel;
}) {
  const close = useUiStore((state) => state.closeChannelDialog);
  const showToast = useToastStore((state) => state.showToast);
  const participantIds = useVoiceChannelParticipantIds(channel);
  const leaveVoice = useVoiceStore((state) => state.leave);
  const descartarCanal = useMessageStore((state) => state.descartarCanal);
  const voiceChannelId = useVoiceStore((state) => state.channelId);
  const hostStatus = useHostStatus(community);
  const [deleting, setDeleting] = useState(false);
  const [recusa, setRecusa] = useState<string | null>(null);
  const semHost = hostStatus !== "online";

  const label = channel.type === "text" ? `#${channel.name}` : channel.name;
  const inCall = channel.type === "voice" ? participantIds.length : 0;

  async function handleDelete() {
    if (deleting) return;
    setDeleting(true);
    setRecusa(null);
    try {
      // §18: mensagem pendente num canal que deixou de existir é descartada com
      // aviso nomeado — nunca some calada nem fica pendente para sempre. Quem
      // CONTA agora é o núcleo (`droppedQueued`): a fila é dele. O descarte
      // local continua, mas só para limpar o espelho da tela.
      const r = await api.channelDelete({ communityId: community.id, channelId: channel.id });
      // Excluir o canal de voz derruba a chamada — inclusive a nossa (D15).
      if (voiceChannelId === channel.id) leaveVoice();
      descartarCanal([channel.id]);
      await sincronizarComunidade(community.id);
      const dropped = r.droppedQueued;
      showToast(
        dropped > 0
          ? `${label} foi excluído · ${dropped} ${dropped === 1 ? "mensagem não foi enviada" : "mensagens não foram enviadas"}`
          : `${label} foi excluído`,
        dropped > 0 ? "error" : undefined,
      );
      close();
    } catch (e) {
      setRecusa(motivoDaRecusa(codigoDoErro(e)));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Modal open onClose={close} title={`Excluir ${label}?`} size="sm">
      <div className="flex flex-col gap-4">
        {inCall > 0 ? (
          <p className="text-body text-text-secondary">
            {inCall === 1
              ? "1 pessoa está nesta chamada agora. Excluir tira ela da chamada."
              : `${inCall} pessoas estão em ${label} agora. Excluir tira todas da chamada.`}
          </p>
        ) : (
          <p className="text-body text-text-secondary">
            As mensagens deste canal somem para todo mundo. Não pode ser
            desfeito.
          </p>
        )}

        {/* Nota de honestidade P2P, no mesmo espírito da nota de banimento. */}
        <p className="rounded-md border border-border-default bg-surface-sidebar p-3 text-meta text-text-tertiary">
          Quem estiver offline agora só vê o canal sumir ao reconectar — até
          lá, a réplica local dessa pessoa ainda tem as mensagens.
        </p>

        <Recusa texto={recusa} />

        <div className="flex flex-col gap-3 tablet:flex-row tablet:justify-end">
          <Button variant="secondary" onClick={close} disabled={deleting}>
            Cancelar
          </Button>
          <Button
            variant="danger"
            onClick={() => void handleDelete()}
            loading={deleting}
            disabled={semHost}
            title={semHost ? OFFLINE_HINT : undefined}
          >
            Excluir canal
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/* ─── Categorias ──────────────────────────────────────────────────── */

function CategoryNameModal({
  community,
  categoryId,
}: {
  community: Community;
  categoryId?: string;
}) {
  const close = useUiStore((state) => state.closeChannelDialog);
  const category = useCategory(categoryId ?? null);
  const hostStatus = useHostStatus(community);

  const [name, setName] = useState(category?.name ?? "");
  const [error, setError] = useState<string | undefined>();
  const [salvando, setSalvando] = useState(false);
  const [recusa, setRecusa] = useState<string | null>(null);
  const semHost = hostStatus !== "online";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (salvando) return;
    const limpo = name.trim();
    if (limpo.length === 0) {
      setError("Digite um nome para a categoria.");
      return;
    }

    setSalvando(true);
    setRecusa(null);
    try {
      if (category) {
        await api.categoryRename({ communityId: community.id, categoryId: category.id, name: limpo });
      } else {
        await api.categoryCreate({ communityId: community.id, name: limpo });
      }
      await sincronizarComunidade(community.id);
      close();
    } catch (e) {
      setRecusa(motivoDaRecusa(codigoDoErro(e)));
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Modal
      open
      onClose={close}
      title={category ? "Renomear categoria" : "Criar categoria"}
      size="sm"
    >
      <form className="flex flex-col gap-6" onSubmit={handleSubmit}>
        <TextField
          label="Nome da categoria"
          value={name}
          onChange={(value) => {
            setName(value);
            if (error) setError(undefined);
          }}
          error={error}
          placeholder="Ex.: PROJETOS"
          maxLength={NAME_MAX}
          autoFocus
          autoComplete="off"
          disabled={salvando}
        />

        <Recusa texto={recusa} />

        <div className="flex flex-col gap-3 tablet:flex-row tablet:justify-end">
          <Button variant="secondary" onClick={close} disabled={salvando}>
            Cancelar
          </Button>
          <Button
            type="submit"
            loading={salvando}
            disabled={name.trim().length === 0 || semHost}
            title={semHost ? OFFLINE_HINT : undefined}
          >
            {category ? "Salvar" : "Criar categoria"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteCategoryDialog({
  community,
  categoryId,
}: {
  community: Community;
  categoryId: string;
}) {
  const close = useUiStore((state) => state.closeChannelDialog);
  const category = useCategory(categoryId);
  const categories = useCategories(community.id);
  const channelCount = useChannelCount(community.id);
  const hostStatus = useHostStatus(community);

  const others = categories.filter((item) => item.id !== categoryId);
  const [moveTo, setMoveTo] = useState(others[0]?.id ?? "");
  const [excluindo, setExcluindo] = useState(false);
  const [recusa, setRecusa] = useState<string | null>(null);
  const semHost = hostStatus !== "online";

  if (!category) return null;

  const inside = category.channelIds.length;
  // Excluir tudo não pode levar junto o último canal da comunidade (§18).
  const wouldEmptyCommunity = channelCount - inside <= 0;

  /**
   * §15.4: `category.delete` tem exatamente DUAS formas — mover os canais
   * (`moveChannelsTo`) **ou** apagá-los (`deleteChannels: true`). Pedir as duas na mesma
   * chamada é `E_VALIDATION`, não uma terceira forma.
   */
  async function finish(moveChannelsToId?: string) {
    if (excluindo) return;
    setExcluindo(true);
    setRecusa(null);
    try {
      await api.categoryDelete(
        moveChannelsToId !== undefined
          ? { communityId: community.id, categoryId, moveChannelsTo: moveChannelsToId }
          : { communityId: community.id, categoryId, deleteChannels: true },
      );
      await sincronizarComunidade(community.id);
      close();
    } catch (e) {
      setRecusa(motivoDaRecusa(codigoDoErro(e)));
    } finally {
      setExcluindo(false);
    }
  }

  return (
    <Modal open onClose={close} title={`Excluir ${category.name}?`} size="sm">
      <div className="flex flex-col gap-6">
        <p className="text-body text-text-secondary">
          {inside === 0
            ? "A categoria está vazia."
            : inside === 1
              ? "Há 1 canal nesta categoria. Ele pode ir para outra em vez de sumir junto."
              : `Há ${inside} canais nesta categoria. Eles podem ir para outra em vez de sumir junto.`}
        </p>

        {inside > 0 && others.length > 0 && (
          <Select
            label="Mover os canais para"
            value={moveTo}
            onChange={setMoveTo}
            options={others.map((item) => ({
              value: item.id,
              label: item.name,
            }))}
          />
        )}

        <Recusa texto={recusa} />

        <div className="flex flex-col gap-3">
          {inside > 0 && others.length > 0 && (
            <Button
              onClick={() => void finish(moveTo)}
              loading={excluindo}
              disabled={semHost}
              title={semHost ? OFFLINE_HINT : undefined}
            >
              Mover os canais e excluir a categoria
            </Button>
          )}
          <Button
            variant="danger"
            loading={excluindo}
            disabled={(inside > 0 && wouldEmptyCommunity) || semHost}
            title={semHost ? OFFLINE_HINT : undefined}
            onClick={() => void finish()}
          >
            {inside === 0
              ? "Excluir categoria"
              : `Excluir a categoria e os ${inside} canais`}
          </Button>
          {inside > 0 && wouldEmptyCommunity && (
            <p className="text-meta text-text-tertiary">
              Toda comunidade precisa de pelo menos um canal — crie outra
              categoria com um canal antes de excluir esta.
            </p>
          )}
          <Button variant="secondary" onClick={close}>
            Cancelar
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/* ─── Router ──────────────────────────────────────────────────────── */

/**
 * §10, 3.4 — os seis diálogos de gestão de canal e categoria. Ficam num
 * componente só porque compartilham o mesmo slot de estado (`channelDialog`)
 * e nunca aparecem dois ao mesmo tempo.
 */
export function ChannelDialogs({ community }: { community: Community }) {
  const dialog = useUiStore((state) => state.channelDialog);
  const channelId =
    dialog && "channelId" in dialog ? dialog.channelId : null;
  const channel = useChannel(channelId);

  if (!dialog) return null;

  switch (dialog.kind) {
    case "create-channel":
      return (
        <CreateChannelModal
          community={community}
          categoryId={dialog.categoryId}
        />
      );
    case "edit-channel":
      return channel ? (
        <EditChannelModal community={community} channel={channel} />
      ) : null;
    case "delete-channel":
      return channel ? (
        <DeleteChannelDialog community={community} channel={channel} />
      ) : null;
    case "create-category":
      return <CategoryNameModal community={community} />;
    case "rename-category":
      return (
        <CategoryNameModal community={community} categoryId={dialog.categoryId} />
      );
    case "delete-category":
      return (
        <DeleteCategoryDialog
          community={community}
          categoryId={dialog.categoryId}
        />
      );
  }
}
