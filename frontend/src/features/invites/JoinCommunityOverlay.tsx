import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { Skeleton } from "../../components/ui/Skeleton";
import { TextField } from "../../components/ui/TextField";
import { cn } from "../../lib/cn";
import { AVATAR_BG_CLASS, initialsFrom } from "../../lib/avatar";
import { api } from "../../ipc/api";
import { codigoDoErro } from "../../ipc/frames";
import { tokenDaCor } from "../../ipc/cores";
import type { InvitePreview } from "../../ipc/dto";
import { mensagemDeErro, useSessao } from "../../live/sessao";
import {
  selectFirstTextChannelId,
  useCommunityStore,
} from "../../store/communityStore";
import { usePendingInviteStore } from "../../store/inviteStore";
import { useUiStore } from "../../store/uiStore";

/** Entrada no canal pré-membro é ⏱ contra o host (§16.1) — o skeleton diz isso. */
const RESOLVENDO_HINT = "Procurando quem hospeda esta comunidade…";

const INVALID_MESSAGE = "Este convite não é válido ou expirou";
/** U-03 — texto obrigatório do desfecho `unreachable`. */
const UNREACHABLE_MESSAGE =
  "Não foi possível falar com quem hospeda esta comunidade agora. O convite pode estar bom — tente de novo mais tarde.";
const ENDED_MESSAGE = "Esta comunidade foi encerrada.";

/** Recusa nomeada do fio: o código de §20 para decidir a tela, o texto para mostrar. */
interface Falha {
  codigo: string;
  mensagem: string;
}

function falhaDe(e: unknown): Falha {
  return { codigo: codigoDoErro(e), mensagem: mensagemDeErro(e) };
}

/**
 * A recusa de `invite.redeem` de volta ao desfecho de §12.3 que a descreve.
 *
 * A coluna de §15.4 mapeia desfecho → código no caminho de ida; esta é a volta, e ela
 * existe porque o convite pode morrer **entre** a prévia e o clique: um convite de uso
 * único resgatado noutro dispositivo, uma expiração que venceu no meio, a comunidade
 * encerrada pelo host. A tela mostrava `Não foi possível entrar (E_INVITE_INVALID)` por
 * cima da prévia antiga — o código cru de §20, e um botão "Entrar" ainda ativo sobre um
 * convite morto. Os desfechos já têm tela; o que faltava era chegar nelas.
 */
function desfechoDaRecusa(codigo: string, previaAtual: InvitePreview | null): InvitePreview | null {
  switch (codigo) {
    case "E_INVITE_INVALID":
    case "E_INVITE_EXHAUSTED":
    case "E_MALFORMED":
      return { status: "invalid" };
    case "E_COMMUNITY_ENDED":
      return {
        status: "ended",
        communityName: previaAtual?.status === "ok" ? previaAtual.community.name : "Esta comunidade",
      };
    case "E_BANNED":
      return {
        status: "banned",
        communityName: previaAtual?.status === "ok" ? previaAtual.community.name : "Esta comunidade",
      };
    case "E_HOST_UNAVAILABLE":
    case "E_TIMEOUT":
      return { status: "unreachable" };
    default:
      // `E_VALIDATION`, `E_NO_IDENTITY` e o resto de §20 não são desfechos de convite:
      // continuam como recusa nomeada em cima da prévia, que é onde a pessoa está.
      return null;
  }
}

function CommunityGlyph({
  name,
  iconEmoji,
  iconColor,
  muted = false,
}: {
  name: string;
  iconEmoji?: string;
  iconColor?: number;
  muted?: boolean;
}) {
  const cor = tokenDaCor(iconColor);
  return (
    <span
      className={cn(
        "grid size-14 shrink-0 place-items-center rounded-lg",
        "text-heading-2 text-surface-app select-none",
        (muted || cor === null) && "bg-role-neutral opacity-60",
        cor !== null && !muted && AVATAR_BG_CLASS[cor],
      )}
      aria-hidden="true"
    >
      {iconEmoji ? <span className="text-[26px]">{iconEmoji}</span> : initialsFrom(name)}
    </span>
  );
}

function PreviewSkeleton() {
  return (
    <>
      <div className="flex items-center gap-4 rounded-md border border-border-default bg-surface-sidebar p-4">
        <Skeleton className="size-14 shrink-0 rounded-lg" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-32" />
        </div>
      </div>
      <p className="text-meta text-text-tertiary">{RESOLVENDO_HINT}</p>
    </>
  );
}

function AcoesFinais({
  onCancel,
  children,
}: {
  onCancel: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 tablet:flex-row tablet:justify-end">
      {/* Nunca desabilitado: sair da espera é sempre possível (§16.1, 30 s). */}
      <Button variant="secondary" size="lg" onClick={onCancel}>
        Cancelar
      </Button>
      {children}
    </div>
  );
}

/**
 * 0.3 Entrar via convite + preview — fluxo A2, agora sobre a admissão real de §12.
 *
 * O código vai inteiro ao núcleo: a gramática de §15.4 e os seis desfechos de §12.3 são
 * dele — nada de validação local que duvide antes da hora. Nunca entra "às cegas": o
 * preview é sempre visto antes de confirmar. Vira tela cheia quando a pessoa chega por
 * `/invite/:code` sem nenhuma comunidade ainda — não há shell por trás para servir de
 * contexto.
 */
export interface JoinCommunityOverlayProps {
  /** Decidido pelo shell: sem comunidade nenhuma por trás, vira tela cheia. */
  layout: "modal" | "fullscreen";
}

export function JoinCommunityOverlay({ layout }: JoinCommunityOverlayProps) {
  const source = useUiStore((state) => state.joinSource);
  const closeOverlay = useUiStore((state) => state.closeOverlay);

  const pendingInviteCode = usePendingInviteStore(
    (state) => state.pendingInviteCode,
  );
  const pendingInviteInvalid = usePendingInviteStore(
    (state) => state.pendingInviteInvalid,
  );
  const clearPendingInvite = usePendingInviteStore(
    (state) => state.clearPendingInvite,
  );

  const setActiveCommunity = useCommunityStore(
    (state) => state.setActiveCommunity,
  );
  const setActiveChannel = useCommunityStore((state) => state.setActiveChannel);

  const fromLink = source === "link";
  /**
   * §12.1 — o link trouxe algo que não é código. Não há o que resolver: é `invalid`.
   *
   * Lido **uma vez**, na montagem: o convite pendente é consumido logo abaixo, e um valor
   * recalculado a cada render viraria `false` no instante seguinte — reabrindo a resolução
   * com o código vazio que não existe.
   */
  const [linkInvalido] = useState(() => fromLink && pendingInviteInvalid);
  const [step, setStep] = useState<"input" | "preview">(
    fromLink ? "preview" : "input",
  );
  const [code, setCode] = useState(fromLink ? (pendingInviteCode ?? "") : "");
  const [preview, setPreview] = useState<InvitePreview | null>(
    linkInvalido ? { status: "invalid" } : null,
  );
  const [resolvendo, setResolvendo] = useState(false);
  const [erro, setErro] = useState<Falha | null>(null);
  const [entrando, setEntrando] = useState(false);
  const [erroDeEntrada, setErroDeEntrada] = useState<Falha | null>(null);
  /** Sequência da resolução em voo — só a última escreve estado. */
  const resolucaoAtual = useRef(0);
  /**
   * A pessoa saiu da tela enquanto o resgate corria. O resultado que chegar depois não
   * navega mais: quem fechou não quer ser levado para outro lugar (ver `handleJoin`).
   */
  const abandonado = useRef(false);

  /*
   * **O convite pendente é consumido quando esta tela abre, não quando ela é cancelada.**
   *
   * Ele só era limpo no "Cancelar": fechar a JANELA com o preview aberto deixava o código
   * no `localStorage`, e a inicialização seguinte reabria o mesmo convite sozinha por cima
   * do que a pessoa fosse fazer — inclusive um convite já inválido, para sempre. O código
   * já está em `code` aqui; o store não precisa mais guardá-lo.
   */
  useEffect(() => {
    if (fromLink) clearPendingInvite();
    // Só na montagem: `clearPendingInvite` mudaria a dependência e reexecutaria o efeito.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function resolver() {
    if (resolvendo) return;
    const meu = ++resolucaoAtual.current;
    // A resposta de uma resolução abandonada não escreve mais nada: sair do passo de
    // preview (ou pedir de novo pelo botão de U-03) invalida a anterior, e sem isto a
    // que voltasse depois repintava um convite que já não está na tela.
    const vivo = () => meu === resolucaoAtual.current;
    setResolvendo(true);
    setErro(null);
    setPreview(null);
    try {
      // Classe open (§15.3): resolve antes de qualquer identidade; o host é
      // encontrado pelo tópico derivado do próprio código (§12.1).
      const r = await api.inviteResolve(code);
      if (vivo()) setPreview(r);
    } catch (e) {
      if (vivo()) setErro(falhaDe(e));
    } finally {
      if (vivo()) setResolvendo(false);
    }
  }

  // Passo 2: o preview resolve uma vez ao entrar nele; o código já está
  // congelado aqui. `unreachable` tem botão próprio para repetir (U-03).
  useEffect(() => {
    if (step !== "preview" || linkInvalido) return;
    const sequencia = resolucaoAtual;
    void resolver();
    // Sair do passo aposenta a resolução em voo: o incremento faz o `vivo()` dela dar
    // falso quando a resposta chegar.
    return () => {
      sequencia.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, linkInvalido]);

  function handleClose() {
    // §16.1 — `invite.redeem` corre sob 30 s contra o host, e a tela não pode ficar
    // presa a esse prazo. Fechar **abandona a espera**, não o comando: o resgate é
    // decidido no log do host (§12.4 passo 4), e se ele completar depois a comunidade
    // chega pelo resync como qualquer outra participação. O que não pode acontecer é a
    // resposta atrasada arrastar a navegação de quem já saiu daqui.
    abandonado.current = true;
    closeOverlay();
  }

  function goToCommunity(communityId: string, channelId?: string) {
    setActiveCommunity(communityId);
    if (channelId !== undefined) {
      setActiveChannel(communityId, channelId);
    } else {
      const state = useCommunityStore.getState();
      if (!state.activeChannelByCommunity[communityId]) {
        const first = selectFirstTextChannelId(state, communityId);
        if (first) setActiveChannel(communityId, first);
      }
    }
    handleClose();
  }

  async function handleJoin() {
    if (preview?.status !== "ok" || entrando) return;
    setEntrando(true);
    setErroDeEntrada(null);
    try {
      // §12.4 — o resgate registra a participação, abre a comunidade no
      // runtime e devolve o canal padrão; o resync já trouxe o rail novo.
      const r = await useSessao.getState().entrarComunidade({ codeOrLink: code });
      if (abandonado.current) return;
      goToCommunity(r.communityId, r.defaultChannelId);
    } catch (e) {
      if (abandonado.current) return;
      setEntrando(false);
      const falha = falhaDe(e);
      // O convite morreu entre a prévia e o clique: a tela vai para o desfecho de §12.3
      // que descreve o que aconteceu, em vez de escrever o código de §20 por cima de uma
      // prévia que já não vale.
      const desfecho = desfechoDaRecusa(falha.codigo, preview);
      if (desfecho !== null) {
        setPreview(desfecho);
        setErroDeEntrada(null);
        return;
      }
      setErroDeEntrada(falha);
    }
  }

  const body =
    step === "input" ? (
      <>
        <TextField
          label="Cole um link ou código de convite"
          value={code}
          onChange={setCode}
          hint="Exemplo: X7K2-QM9F-RT4B-N8ZP"
          placeholder="X7K2-QM9F-RT4B-N8ZP ou link do convite"
          autoFocus
          autoComplete="off"
          spellCheck={false}
        />

        <AcoesFinais onCancel={handleClose}>
          <Button
            size="lg"
            disabled={code.trim().length === 0}
            onClick={() => setStep("preview")}
          >
            Continuar
          </Button>
        </AcoesFinais>
      </>
    ) : (
      <PreviewCard
        preview={preview}
        resolvendo={resolvendo}
        erro={erro}
        entrando={entrando}
        erroDeEntrada={erroDeEntrada}
        code={code}
        onRetry={() => void resolver()}
        onJoin={() => void handleJoin()}
        onGoTo={goToCommunity}
        onCancel={handleClose}
      />
    );

  // Chegada por link sem nenhuma comunidade: não há shell por trás, então o
  // preview ocupa a tela inteira em vez de flutuar sobre o vazio (§7, 0.3).
  if (layout === "fullscreen") {
    return (
      <FullscreenInvite title="Convite para uma comunidade">
        {body}
      </FullscreenInvite>
    );
  }

  return (
    <Modal
      open
      onClose={handleClose}
      title="Entrar numa comunidade"
      size="md"
    >
      {body}
    </Modal>
  );
}

function FullscreenInvite({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <main className="flex min-h-full items-center justify-center bg-surface-app px-4 py-8 tablet:px-8">
      <div className="w-full max-w-[440px]">
        <h1 className="mb-6 text-heading-1 text-text-primary">{title}</h1>
        {children}
      </div>
    </main>
  );
}

function CodigoUsado({ code }: { code: string }) {
  return <p className="mt-1 text-meta text-text-tertiary">Código usado: {code || "—"}</p>;
}

function PreviewCard({
  preview,
  resolvendo,
  erro,
  entrando,
  erroDeEntrada,
  code,
  onRetry,
  onJoin,
  onGoTo,
  onCancel,
}: {
  preview: InvitePreview | null;
  resolvendo: boolean;
  erro: Falha | null;
  entrando: boolean;
  erroDeEntrada: Falha | null;
  code: string;
  onRetry: () => void;
  onJoin: () => void;
  onGoTo: (communityId: string, channelId?: string) => void;
  onCancel: () => void;
}) {
  // Falha de transporte/gramática antes de qualquer desfecho. E_MALFORMED é
  // recusa da forma do código — mesma tela do convite inválido.
  if (preview === null && !resolvendo) {
    if (erro !== null && erro.codigo === "E_MALFORMED") {
      return (
        <>
          <div className="rounded-md border border-feedback-danger bg-surface-sidebar p-4">
            <p className="text-body text-feedback-danger">{INVALID_MESSAGE}</p>
            <CodigoUsado code={code} />
          </div>
          <div className="mt-3 flex justify-end">
            <Button variant="secondary" size="lg" onClick={onCancel}>
              Cancelar
            </Button>
          </div>
        </>
      );
    }
    return (
      <>
        <div className="rounded-md border border-feedback-danger bg-surface-sidebar p-4">
          <p className="text-body text-feedback-danger">
            Não foi possível resolver este convite{erro === null ? "" : ` (${erro.codigo})`}
          </p>
        </div>
        <AcoesFinais onCancel={onCancel}>
          <Button size="lg" onClick={onRetry}>
            Tentar novamente
          </Button>
        </AcoesFinais>
      </>
    );
  }

  if (resolvendo || preview === null) return <PreviewSkeleton />;

  if (preview.status === "invalid") {
    return (
      <>
        <div className="rounded-md border border-feedback-danger bg-surface-sidebar p-4">
          <p className="text-body text-feedback-danger">{INVALID_MESSAGE}</p>
          <CodigoUsado code={code} />
        </div>
        <div className="mt-3 flex justify-end">
          <Button variant="secondary" size="lg" onClick={onCancel}>
            Cancelar
          </Button>
        </div>
      </>
    );
  }

  // U-03 — `unreachable` NÃO é inválido: o convite pode estar bom.
  if (preview.status === "unreachable") {
    return (
      <>
        <div className="rounded-md border border-border-default bg-surface-sidebar p-4">
          <p className="text-body text-text-primary">{UNREACHABLE_MESSAGE}</p>
          {preview.hint !== undefined && (
            <p className="mt-1 text-meta text-text-tertiary">{preview.hint}</p>
          )}
        </div>
        <AcoesFinais onCancel={onCancel}>
          <Button size="lg" onClick={onRetry}>
            Tentar novamente
          </Button>
        </AcoesFinais>
      </>
    );
  }

  if (preview.status === "ended") {
    return (
      <>
        <div className="flex items-center gap-4 rounded-md border border-border-default bg-surface-sidebar p-4">
          <CommunityGlyph name={preview.communityName} muted />
          <div className="min-w-0">
            <p className="truncate text-heading-3 text-text-primary">{preview.communityName}</p>
            <p className="text-body text-text-secondary">{ENDED_MESSAGE}</p>
          </div>
        </div>
        <div className="mt-3 flex justify-end">
          <Button variant="secondary" size="lg" onClick={onCancel}>
            Cancelar
          </Button>
        </div>
      </>
    );
  }

  if (preview.status === "banned") {
    return (
      <>
        {/* Sem contagem de membros e sem quem convidou: não vaza informação
            da comunidade para quem foi banido (§12.5). */}
        <div className="flex items-center gap-4 rounded-md border border-border-default bg-surface-sidebar p-4">
          <CommunityGlyph name={preview.communityName} muted />
          <p className="text-body-emphasis text-text-primary">
            Você não pode entrar em {preview.communityName}
          </p>
        </div>
        <div className="mt-3 flex justify-end">
          <Button variant="secondary" size="lg" onClick={onCancel}>
            Cancelar
          </Button>
        </div>
      </>
    );
  }

  if (preview.status === "already-member") {
    const { community } = preview;
    return (
      <>
        <div className="flex items-center gap-4 rounded-md border border-border-default bg-surface-sidebar p-4">
          <CommunityGlyph name={community.name} iconEmoji={community.iconEmoji} iconColor={community.iconColor} />
          <p className="text-body-emphasis text-text-primary">
            Você já está em {community.name}
          </p>
        </div>
        {/* Sem contagem e sem convidador: §12.5 vaza só nome, ícone e cor. */}
        <div className="mt-3 flex justify-end">
          <Button size="lg" onClick={() => onGoTo(community.id)}>
            Ir para a comunidade
          </Button>
        </div>
      </>
    );
  }

  const { community, invitedBy } = preview;
  return (
    <>
      <div className="flex items-center gap-4 rounded-md border border-border-default bg-surface-sidebar p-4">
        <CommunityGlyph name={community.name} iconEmoji={community.iconEmoji} iconColor={community.iconColor} />
        <div className="min-w-0">
          <p className="truncate text-heading-3 text-text-primary">
            {community.name}
          </p>
          <p className="text-meta text-text-secondary">
            {community.memberCount.toLocaleString("pt-BR")} membros
          </p>
          <p className="text-meta text-text-tertiary">
            Convite de {invitedBy.displayName}
          </p>
        </div>
      </div>

      {erroDeEntrada !== null && (
        <div className="rounded-md border border-feedback-danger bg-surface-sidebar p-4">
          <p className="text-body text-feedback-danger">
            Não foi possível entrar ({erroDeEntrada.codigo})
          </p>
        </div>
      )}

      {/*
        "Cancelar" continua ativo durante o resgate, e `Esc`/clique fora continuam
        fechando: §16.1 dá 30 s a `invite.redeem` contra o host, e um host inalcançável
        deixava a pessoa presa no spinner meio minuto, sem saída. Sair não cancela o
        comando — cancela a espera; a linha abaixo é quem diz isso.
      */}
      <AcoesFinais onCancel={onCancel}>
        <Button size="lg" loading={entrando} onClick={onJoin}>
          Entrar em {community.name}
        </Button>
      </AcoesFinais>
      {entrando && (
        <p className="mt-2 text-meta text-text-tertiary">
          Falando com quem hospeda. Dá para fechar — se o resgate completar, a comunidade
          aparece sozinha.
        </p>
      )}
    </>
  );
}
