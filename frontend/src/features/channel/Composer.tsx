import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  CornerUpLeft,
  Paperclip,
  SendHorizontal,
  Smile,
  X,
} from "lucide-react";
import { cn } from "../../lib/cn";
import { EmojiPicker } from "./EmojiPicker";
import { MentionAutocomplete } from "./MentionAutocomplete";
import { useComposerMentions } from "./composerMentions";
import { AttachmentChip } from "./AttachmentChip";
import { useAttachmentStaging } from "./composerAttachment";
import { ComposerFormatting } from "./ComposerFormatting";
import { TypingIndicator } from "./TypingIndicator";
import { useFindMember } from "../../store/communityStore";
import { useMessageStore } from "../../store/messageStore";
import { avisarQueEstouDigitando } from "../../live/sincronizacao";
import { ROLE_TEXT_CLASS } from "../../lib/role";
import { selectHighestRole, useCommunityStore } from "../../store/communityStore";
import type { Channel, Message } from "../../domain/types";

/** §6 — o textarea cresce até ~40% da altura da viewport antes de rolar. */
const MAX_HEIGHT_RATIO = 0.4;

/** Barra "respondendo a X" acima do campo, com cancelar (§9, 2.1). */
function ReplyingTo({
  message,
  communityId,
  onCancel,
}: {
  message: Message;
  communityId: string;
  onCancel: () => void;
}) {
  const findMember = useFindMember();
  const member = findMember(communityId, message.authorId);
  const highest = useCommunityStore((state) =>
    member ? selectHighestRole(state, member.roleIds) : undefined,
  );

  return (
    <div className="flex items-center gap-2 rounded-t-md border border-b-0 border-border-default bg-surface-sidebar px-3 py-1.5">
      <CornerUpLeft
        size={14}
        strokeWidth={2}
        aria-hidden="true"
        className="shrink-0 text-text-tertiary"
      />
      <p className="min-w-0 flex-1 truncate text-meta text-text-secondary">
        respondendo a{" "}
        <span
          className={cn(
            "font-semibold",
            highest ? ROLE_TEXT_CLASS[highest.color] : "text-text-primary",
          )}
        >
          {member?.displayName ?? "membro"}
        </span>
      </p>
      <button
        type="button"
        onClick={onCancel}
        className="shrink-0 rounded-sm text-text-tertiary hover:text-text-primary"
      >
        <X size={14} strokeWidth={2} aria-hidden="true" />
        <span className="sr-only">Cancelar resposta</span>
      </button>
    </div>
  );
}

export interface ComposerProps {
  channel: Channel;
  replyTo?: Message | null;
  onCancelReply?: () => void;
  /** Composer da thread (§9, 2.2) — a mensagem nasce dentro dela. */
  threadId?: string;
  /** Sobrepõe "Conversar em #canal" (§6) no composer de thread. */
  placeholder?: string;
  /**
   * Coluna estreita (painel de thread, 320px): sem os botões de formatação.
   * O breakpoint do Tailwind mede a viewport, não o container, então quem
   * sabe que o espaço é curto é quem monta o composer.
   */
  compact?: boolean;
}

/**
 * Composer do canal de texto (§6 · §9, 2.1 · fluxo C9).
 *
 * O textarea é nativo — cresce até 40% da viewport e depois rola. As
 * menções confirmadas aparecem destacadas por trás do texto, num espelho
 * alinhado ao textarea: é o que permite o token visual de §9 2.1.1 sem
 * trocar o campo por um `contenteditable`, que quebraria seleção, undo e IME.
 *
 * Markdown é digitado, não renderizado aqui — §11 (C9) é explícito em não
 * ter preview WYSIWYG; o texto só vira formatação depois de enviado.
 *
 * A máquina de menção mora em `useComposerMentions` e o anexo em
 * `useAttachmentStaging`: aqui ficam o campo, o envio e a barra de botões.
 */
export function Composer({
  channel,
  replyTo,
  onCancelReply,
  threadId,
  placeholder,
  compact = false,
}: ComposerProps) {
  const send = useMessageStore((state) => state.send);

  const [value, setValue] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  /**
   * Cursor a reposicionar depois que o React aplicar o novo valor (inserir
   * ou apagar uma menção mexe no texto por fora do input). Vai num efeito de
   * layout, não num `requestAnimationFrame`: o frame pode chegar *depois* da
   * próxima tecla e jogar o cursor no meio do que o usuário acabou de digitar.
   */
  const pendingCaret = useRef<number | null>(null);

  const mention = useComposerMentions({
    communityId: channel.communityId,
    value,
    setValue,
    textareaRef,
    pendingCaret,
  });
  const { anexo, anexando, anexar, limpar: limparAnexo } = useAttachmentStaging(
    channel.communityId,
  );

  // Cresce com o conteúdo até o teto e só então rola (§6).
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(
      el.scrollHeight,
      window.innerHeight * MAX_HEIGHT_RATIO,
    )}px`;
  }, [value]);

  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    if (caret === null) return;
    pendingCaret.current = null;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(caret, caret);
  }, [value]);

  /** Insere texto no cursor — usado pelo emoji e pela formatação. */
  function insertAtCaret(before: string, after = "") {
    const el = textareaRef.current;
    if (!el) return;
    const { selectionStart: start, selectionEnd: end } = el;
    const selected = value.slice(start, end);
    pendingCaret.current =
      selected === ""
        ? start + before.length
        : end + before.length + after.length;
    setValue(
      value.slice(0, start) + before + selected + after + value.slice(end),
    );
  }

  function handleSend() {
    const content = value.trim();
    if (content === "") return;

    // A bolha otimista e o transporte são da store; quem decide entre envio
    // imediato e fila é a outbox do núcleo (§11.1), nunca a tela.
    void send({
      communityId: channel.communityId,
      channelId: channel.id,
      content,
      mentions: mention.mentionIdsIn(content),
      replyToId: replyTo?.id,
      threadId,
      ...(anexo !== null ? { attachment: anexo } : {}),
    });

    setValue("");
    mention.reset();
    limparAnexo();
    onCancelReply?.();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    // O dropdown de menção tem prioridade sobre o envio (§9, 2.1.1).
    if (mention.handleKeyDown(event)) return;

    if (event.key === "Enter" && !event.shiftKey && !composing.current) {
      event.preventDefault();
      handleSend();
    }
  }

  const canSend = value.trim() !== "";

  return (
    <div className="px-4 pb-4">
      <TypingIndicator channelId={channel.id} communityId={channel.communityId} />

      {anexo !== null && (
        <AttachmentChip anexo={anexo} onRemove={limparAnexo} />
      )}

      <div className="relative">
        {mention.query && (
          <MentionAutocomplete
            candidates={mention.visible}
            selectedIndex={mention.selectedIndex}
            query={mention.query.text}
            onSelect={mention.applyMention}
            onHover={mention.setSelectedIndex}
          />
        )}

        {replyTo && onCancelReply && (
          <ReplyingTo
            message={replyTo}
            communityId={channel.communityId}
            onCancel={onCancelReply}
          />
        )}

        <div
          className={cn(
            "flex items-end gap-1 border border-border-default bg-surface-elevated p-1",
            replyTo ? "rounded-b-md" : "rounded-md",
          )}
        >
          <button
            type="button"
            onClick={() => void anexar()}
            disabled={anexando || anexo !== null}
            aria-label="Anexar arquivo"
            className={cn(
              "grid size-9 shrink-0 place-items-center rounded-md",
              "text-text-secondary transition-colors duration-(--duration-fast) ease-out",
              "hover:bg-accent-muted-bg hover:text-accent-default",
              (anexando || anexo !== null) && "text-text-disabled hover:bg-transparent",
            )}
          >
            <Paperclip size={20} strokeWidth={2} aria-hidden="true" />
            <span className="sr-only">Anexar arquivo</span>
          </button>

          <ComposerFormatting
            compact={compact}
            onWrap={(wrap) => insertAtCaret(wrap, wrap)}
          />

          <div className="relative min-w-0 flex-1">
            {/* Espelho do textarea: só os fundos das menções aparecem. */}
            <div
              ref={backdropRef}
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 overflow-hidden px-2 py-2 text-body break-words whitespace-pre-wrap text-transparent"
            >
              {mention.segments.map((segment, index) =>
                segment.isMention ? (
                  <span
                    key={`${index}-${segment.text}`}
                    className="rounded-sm bg-accent-muted-bg"
                  >
                    {segment.text}
                  </span>
                ) : (
                  segment.text
                ),
              )}
            </div>

            <textarea
              ref={textareaRef}
              rows={1}
              value={value}
              placeholder={placeholder ?? `Conversar em #${channel.name}`}
              aria-label={placeholder ?? `Conversar em #${channel.name}`}
              onChange={(event) => {
                setValue(event.target.value);
                mention.syncQuery(event.target.value, event.target.selectionStart);
                // §17.6 — "digitando…" é publicado por quem digita. O teto de 1 / 2 s é
                // aplicado do lado de lá; aqui só o gesto. Campo esvaziado não publica:
                // apagar o rascunho não é digitar.
                if (event.target.value.length > 0) {
                  avisarQueEstouDigitando(channel.communityId, channel.id);
                }
              }}
              onKeyUp={(event) =>
                mention.syncQuery(event.currentTarget.value, event.currentTarget.selectionStart)
              }
              onClick={(event) =>
                mention.syncQuery(event.currentTarget.value, event.currentTarget.selectionStart)
              }
              onKeyDown={handleKeyDown}
              onCompositionStart={() => (composing.current = true)}
              onCompositionEnd={() => (composing.current = false)}
              onScroll={(event) => {
                if (backdropRef.current)
                  backdropRef.current.scrollTop = event.currentTarget.scrollTop;
              }}
              className={cn(
                "relative block max-h-[40vh] w-full resize-none bg-transparent px-2 py-2",
                "text-body break-words text-text-primary outline-none",
                "placeholder:text-text-tertiary",
              )}
            />
          </div>

          <div className="relative shrink-0">
            <button
              type="button"
              onClick={() => setEmojiOpen((open) => !open)}
              className={cn(
                "grid size-9 place-items-center rounded-md",
                "text-text-secondary hover:bg-surface-primary hover:text-text-primary",
                "transition-colors duration-(--duration-fast) ease-out",
              )}
            >
              <Smile size={20} strokeWidth={2} aria-hidden="true" />
              <span className="sr-only">Emoji</span>
            </button>

            {emojiOpen && (
              <EmojiPicker
                side="top"
                onPick={(emoji) => insertAtCaret(emoji)}
                onClose={() => setEmojiOpen(false)}
              />
            )}
          </div>

          <button
            type="button"
            onClick={handleSend}
            disabled={!canSend}
            className={cn(
              "grid size-9 shrink-0 place-items-center rounded-md",
              "transition-colors duration-(--duration-fast) ease-out",
              canSend
                ? "text-accent-default hover:bg-accent-muted-bg"
                : "text-text-disabled",
            )}
          >
            <SendHorizontal size={20} strokeWidth={2} aria-hidden="true" />
            <span className="sr-only">Enviar mensagem</span>
          </button>
        </div>
      </div>
    </div>
  );
}
