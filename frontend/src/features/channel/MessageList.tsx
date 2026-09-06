import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import { Hash } from "lucide-react";
import { MessageRow } from "./MessageRow";
import {
  MESSAGE_GROUP_WINDOW_MS,
  formatDaySeparator,
  isSameDay,
} from "../../lib/format";
import { useChannelMessages, useNaoLidasPorThread, useThreadRoots } from "../../store/messageStore";
import { useBans } from "../../store/moderationStore";
import { useToastStore } from "../../store/toastStore";
import { useUiStore } from "../../store/uiStore";
import type { Channel, Message } from "../../domain/types";

/** Separador de data — muda o dia (§6). */
function DaySeparator({ label }: { label: string }) {
  return (
    <div className="my-4 flex items-center gap-3 px-4" role="separator">
      <span className="h-px flex-1 bg-border-default" aria-hidden="true" />
      <span className="text-caption text-text-tertiary uppercase">{label}</span>
      <span className="h-px flex-1 bg-border-default" aria-hidden="true" />
    </div>
  );
}

/** Divisor "Novas mensagens" — onde a leitura parou (§6). */
function UnreadDivider() {
  return (
    <div className="mt-4 flex items-center px-4" role="separator">
      <span className="h-px flex-1 bg-feedback-danger" aria-hidden="true" />
      <span className="ml-2 rounded-sm bg-feedback-danger px-1.5 py-px text-caption text-text-on-accent">
        Novas mensagens
      </span>
    </div>
  );
}

/** §9, 2.1 — canal sem histórico nenhum. */
function ChannelEmptyState({ channel }: { channel: Channel }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-8 py-12 text-center">
      <span
        className="grid size-16 place-items-center rounded-full bg-surface-elevated text-text-secondary"
        aria-hidden="true"
      >
        <Hash size={32} strokeWidth={1.5} />
      </span>
      <h2 className="mt-6 text-heading-1 text-text-primary">
        Este é o início de #{channel.name}
      </h2>
      <p className="mt-2 max-w-[420px] text-body text-text-secondary">
        Ninguém enviou mensagem neste canal ainda.
      </p>
    </div>
  );
}

/**
 * Uma mensagem começa um bloco novo quando muda o autor, passam 5 min,
 * vira o dia, ela responde outra mensagem, ou um divisor a separa da
 * anterior (§9, 2.1). Mensagem fixada também fica sozinha: a superfície
 * dela é outra, e agrupar misturaria dois fundos no mesmo bloco.
 */
function startsNewGroup(
  message: Message,
  previous: Message | undefined,
  dividerBetween: boolean,
): boolean {
  if (!previous || dividerBetween) return true;
  if (previous.authorId !== message.authorId) return true;
  if (message.replyToId !== undefined) return true;
  if (message.pinned || previous.pinned) return true;

  const gap =
    new Date(message.timestamp).getTime() -
    new Date(previous.timestamp).getTime();
  return gap >= MESSAGE_GROUP_WINDOW_MS;
}

export interface MessageListProps {
  channel: Channel;
  readOnly: boolean;
  onReply: (message: Message) => void;
}

/**
 * Lista de mensagens em modo leitura (§9, 2.1) — scroll cronológico, com
 * scroll-to-bottom ao entrar no canal. Composer, reações, toolbar de hover e
 * thread entram com o restante de 2.1/2.2.
 */
export function MessageList({ channel, readOnly, onReply }: MessageListProps) {
  const allMessages = useChannelMessages(channel.id);
  const bans = useBans(channel.communityId);
  // §11, D12 passo 3: banir remove as mensagens da pessoa do canal.
  const messages = useMemo(() => {
    if (bans.length === 0) return allMessages;
    const banned = new Set(bans.map((ban) => ban.identityId));
    return allMessages.filter((message) => !banned.has(message.authorId));
  }, [allMessages, bans]);
  const threadRoots = useThreadRoots();
  const naoLidasPorThread = useNaoLidasPorThread(channel.id);
  const highlightedId = useUiStore((state) => state.highlightedMessageId);
  const showToast = useToastStore((state) => state.showToast);
  const scrollRef = useRef<HTMLDivElement>(null);

  /**
   * Quantos pixels do fim ainda contam como "estou no fim". Uma linha e pouco:
   * o suficiente para o arredondamento do scroll e para quem parou de rolar em
   * cima da última mensagem.
   */
  const PERTO_DO_FIM = 80;
  /**
   * Se a leitura está no fim. Medido no gesto de ROLAR, não depois do render: um
   * efeito de layout já roda com a lista nova no DOM, e mediria a posição de
   * depois — sempre "não está no fim" — em vez da intenção de quem rolou.
   */
  const noFim = useRef(true);
  function aoRolar(event: React.UIEvent<HTMLDivElement>) {
    const node = event.currentTarget;
    noFim.current = node.scrollHeight - node.scrollTop - node.clientHeight <= PERTO_DO_FIM;
  }

  // Trocar de canal sempre leva ao fim; dentro do canal, só quem já estava lá.
  const canalAnterior = useRef(channel.id);
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const trocouDeCanal = canalAnterior.current !== channel.id;
    canalAnterior.current = channel.id;
    // O efeito dispara a QUALQUER variação de tamanho — inclusive uma mensagem
    // apagada ou o redesenho da fila. Rolar incondicionalmente arrancava quem
    // estava lendo o histórico e o jogava no rodapé sem ter pedido nada.
    if (trocouDeCanal) noFim.current = true;
    if (noFim.current) node.scrollTop = node.scrollHeight;
  }, [channel.id, messages.length]);

  // Chegando por busca ou por link, a mensagem alvo entra em vista (§11, C10 passo 4).
  //
  // O canal carrega a janela de 50 de §23.3; um resultado de busca ou um `/m/:code`
  // pode apontar para fora dela. Antes, o `?.` engolia esse caso: a pessoa caía no
  // canal certo, sem destaque e sem explicação, achando que o link estava quebrado.
  const avisadoFora = useRef<string | null>(null);
  useEffect(() => {
    if (!highlightedId) return;
    const alvo = document.getElementById(`msg-${highlightedId}`);
    if (alvo !== null) {
      alvo.scrollIntoView({ block: "center" });
      avisadoFora.current = null;
      return;
    }
    // Enquanto a página não chegou não há o que afirmar; só depois dela.
    if (messages.length === 0) return;
    if (avisadoFora.current === highlightedId) return;
    avisadoFora.current = highlightedId;
    showToast(
      "Esta mensagem está fora do trecho carregado deste canal — role para cima para chegar nela",
    );
  }, [highlightedId, channel.id, messages, showToast]);

  const byId = new Map(messages.map((message) => [message.id, message]));
  // Quantas mensagens cada thread tem; a raiz é uma delas (§9, 2.2).
  const threadSizes = new Map<string, number>();
  for (const message of messages) {
    if (!message.threadId) continue;
    threadSizes.set(
      message.threadId,
      (threadSizes.get(message.threadId) ?? 0) + 1,
    );
  }

  const rows: ReactNode[] = [];
  let previous: Message | undefined;

  for (const message of messages) {
    const date = new Date(message.timestamp);
    const newDay =
      previous === undefined || !isSameDay(date, new Date(previous.timestamp));
    // §15.6 `firstUnreadSeq` — o divisor ancora na POSIÇÃO do log, não num id: o id da
    // primeira não lida não existe antes de a página chegar, e o campo de id que estava aqui
    // não tinha escritor nenhum — o divisor nunca aparecia.
    const unreadHere =
      channel.firstUnreadSeq !== undefined && message.seq === channel.firstUnreadSeq;

    if (newDay) {
      rows.push(
        <DaySeparator key={`day-${message.id}`} label={formatDaySeparator(date)} />,
      );
    }
    if (unreadHere) rows.push(<UnreadDivider key={`unread-${message.id}`} />);

    rows.push(
      <MessageRow
        key={message.id}
        message={message}
        communityId={channel.communityId}
        groupStart={startsNewGroup(message, previous, newDay || unreadHere)}
        repliedTo={message.replyToId ? byId.get(message.replyToId) : undefined}
        readOnly={readOnly}
        onReply={onReply}
        threadReplies={
          message.threadId &&
          threadRoots.get(message.threadId) === message.id
            ? // §15.6.1 — o total do fio vale sobre a janela carregada: respostas de
              // outras instalações contam mesmo fora da página. Sem campo (bolha
              // otimista), a contagem derivada da lista é o vizinho honesto.
              (message.threadReplyCount ?? (threadSizes.get(message.threadId) ?? 1) - 1)
            : 0
        }
        threadUnread={
          message.threadId && threadRoots.get(message.threadId) === message.id
            ? naoLidasPorThread[message.threadId]
            : undefined
        }
      />,
    );

    previous = message;
  }

  return (
    <div ref={scrollRef} onScroll={aoRolar} className="flex flex-1 flex-col overflow-y-auto pb-4">
      {messages.length === 0 ? (
        <ChannelEmptyState channel={channel} />
      ) : (
        // Histórico curto encosta na base, como em qualquer chat — é de lá
        // que a leitura começa e é lá que o composer vai encostar.
        <div className="mt-auto">{rows}</div>
      )}
    </div>
  );
}
