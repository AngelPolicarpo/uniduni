import { Hash } from "lucide-react";
import { cn } from "../../lib/cn";
import { Avatar } from "../../components/ui/Avatar";
import { Skeleton } from "../../components/ui/Skeleton";
import { formatMessageTimestamp } from "../../lib/format";
import { useFindMember, useRecentChannels } from "../../store/communityStore";
import {
  LISTAS_IDS,
  RESULTS_PER_GROUP,
  hasFilters,
  destacarCasamentos,
  opcaoId,
} from "./searchIndex";
import type { BuscaResults, SearchFilters } from "./searchIndex";
import type { Community, Member } from "../../domain/types";

export type Selectable =
  | { type: "message"; message: BuscaResults["messages"][number] }
  | { type: "channel"; channel: BuscaResults["channels"][number] }
  | { type: "member"; member: Member };

function Highlighted({ text, query }: { text: string; query: string }) {
  const trechos = destacarCasamentos(text, query);
  return (
    <>
      {trechos.map((trecho, i) =>
        trecho.match ? (
          <mark
            key={i}
            className="rounded-sm bg-accent-muted-bg text-accent-default"
          >
            {trecho.text}
          </mark>
        ) : (
          <span key={i}>{trecho.text}</span>
        ),
      )}
    </>
  );
}

export interface SearchResultsProps {
  community: Community;
  /** Termo já debounced — é o que casa com o realce dos trechos. */
  debounced: string;
  filters: SearchFilters;
  results: BuscaResults;
  visibleMessages: BuscaResults["messages"];
  /** Alguém pediu alguma coisa: digitou ou marcou filtro. */
  asked: boolean;
  searching: boolean;
  selected: number;
  onHover: (index: number) => void;
  onActivate: (item: Selectable) => void;
  expandMessages: boolean;
  onExpandMessages: () => void;
  onOpenChannel: (channelId: string) => void;
}

/**
 * O corpo do painel de busca: canais recentes enquanto ninguém pediu nada,
 * esqueleto durante a consulta, e os três grupos de resultado (§8, 1.2).
 *
 * O índice de seleção é achatado sobre os três grupos, na ordem em que eles
 * aparecem — é o mesmo número que a navegação por teclado move.
 */
export function SearchResults({
  community,
  debounced,
  filters,
  results,
  visibleMessages,
  asked,
  searching,
  selected,
  onHover,
  onActivate,
  expandMessages,
  onExpandMessages,
  onOpenChannel,
}: SearchResultsProps) {
  const findMember = useFindMember();
  const recentChannels = useRecentChannels(community.id);
  const vazio =
    visibleMessages.length + results.channels.length + results.members.length ===
    0;

  if (!asked)
    return (
      <section>
        <h3 className="px-2 py-1 text-caption text-text-tertiary uppercase">
          Canais recentes
        </h3>
        {recentChannels.length === 0 ? (
          <p className="px-2 py-2 text-body text-text-tertiary">
            Abra um canal para ele aparecer aqui.
          </p>
        ) : (
          <ul>
            {recentChannels.map((channel) => (
              <li key={channel.id}>
                <button
                  type="button"
                  onClick={() => onOpenChannel(channel.id)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent-muted-bg"
                >
                  <Hash
                    size={16}
                    strokeWidth={2}
                    aria-hidden="true"
                    className="text-text-tertiary"
                  />
                  <span className="text-body text-text-primary">
                    {channel.name}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    );

  if (searching)
    return (
      <div className="flex flex-col gap-2 p-2">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex items-center gap-2">
            <Skeleton className="size-6 rounded-full" />
            <Skeleton className="h-4 flex-1" />
          </div>
        ))}
      </div>
    );

  if (vazio)
    return (
      <div className="px-4 py-8 text-center">
        <p className="text-body text-text-secondary">
          Nada encontrado para "{debounced.trim()}"
        </p>
        {hasFilters(filters) && (
          <p className="mt-1 text-meta text-text-tertiary">
            Tente remover um filtro.
          </p>
        )}
      </div>
    );

  return (
    // `listbox`/`option` de verdade, e não `aria-selected` solto num botão: o foco fica no
    // campo, então é este contrato (campo `combobox` → lista `listbox` → item `option`) que
    // faz o leitor de tela anunciar o resultado que as setas apontam. Antes, o destaque
    // existia só na cor de fundo.
    <>
      {visibleMessages.length > 0 && (
        <section className="mb-2">
          <h3 className="px-2 py-1 text-caption text-text-tertiary uppercase">
            {/* Sem expansão o núcleo devolve 21 (20 + a sonda que revela "há mais"),
                e imprimir esse número anunciava um resultado a mais do que a lista
                mostra. O rótulo conta o que está na tela; "Ver todos" é quem diz
                que existe mais. */}
            Mensagens — {visibleMessages.length}
            {results.messages.length > RESULTS_PER_GROUP && !expandMessages ? "+" : ""}
          </h3>
          <ul id={LISTAS_IDS[0]} role="listbox" aria-label="Mensagens">
            {visibleMessages.map((message, index) => {
              const author = findMember(community.id, message.authorId);
              return (
                <li key={message.id} role="presentation">
                  <button
                    type="button"
                    id={opcaoId(index)}
                    role="option"
                    // Fora da ordem de tabulação: quem navega é o campo, pelo
                    // `aria-activedescendant`, e um Tab por resultado tornaria a lista
                    // intransitável.
                    tabIndex={-1}
                    onMouseEnter={() => onHover(index)}
                    onClick={() => onActivate({ type: "message", message })}
                    aria-selected={selected === index}
                    className={cn(
                      "flex w-full flex-col gap-0.5 rounded-md px-2 py-2 text-left",
                      selected === index && "bg-accent-muted-bg",
                    )}
                  >
                    <span className="flex items-center gap-2 text-meta text-text-tertiary">
                      <Avatar
                        name={author?.displayName ?? "?"}
                        color={author?.avatarColor ?? "role-neutral"}
                        size="sm"
                      />
                      <span className="text-text-secondary">
                        {author?.displayName ?? "Membro"}
                      </span>
                      <span>#{message.channelName}</span>
                      <span>
                        {formatMessageTimestamp(new Date(message.timestamp))}
                      </span>
                    </span>
                    <span className="line-clamp-2 text-body text-text-primary">
                      <Highlighted text={message.snippet} query={debounced} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          {!expandMessages && results.messages.length > RESULTS_PER_GROUP && (
            <button
              type="button"
              onClick={onExpandMessages}
              className="px-2 py-1 text-meta text-accent-default hover:underline"
            >
              Ver todos os resultados de mensagens
            </button>
          )}
        </section>
      )}

      {results.channels.length > 0 && (
        <section className="mb-2">
          <h3 className="px-2 py-1 text-caption text-text-tertiary uppercase">
            Canais — {results.channels.length}
          </h3>
          <ul id={LISTAS_IDS[1]} role="listbox" aria-label="Canais">
            {results.channels.map((channel, index) => {
              const flatIndex = visibleMessages.length + index;
              return (
                <li key={channel.id} role="presentation">
                  <button
                    type="button"
                    id={opcaoId(flatIndex)}
                    role="option"
                    tabIndex={-1}
                    onMouseEnter={() => onHover(flatIndex)}
                    onClick={() => onActivate({ type: "channel", channel })}
                    aria-selected={selected === flatIndex}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left",
                      selected === flatIndex && "bg-accent-muted-bg",
                    )}
                  >
                    <Hash
                      size={16}
                      strokeWidth={2}
                      aria-hidden="true"
                      className="text-text-tertiary"
                    />
                    <span className="text-body text-text-primary">
                      <Highlighted text={channel.name} query={debounced} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {results.members.length > 0 && (
        <section>
          <h3 className="px-2 py-1 text-caption text-text-tertiary uppercase">
            Membros — {results.members.length}
          </h3>
          <ul id={LISTAS_IDS[2]} role="listbox" aria-label="Membros">
            {results.members.map((member, index) => {
              const flatIndex =
                visibleMessages.length + results.channels.length + index;
              return (
                <li key={member.identityId} role="presentation">
                  <button
                    type="button"
                    id={opcaoId(flatIndex)}
                    role="option"
                    tabIndex={-1}
                    onMouseEnter={() => onHover(flatIndex)}
                    onClick={() => onActivate({ type: "member", member })}
                    aria-selected={selected === flatIndex}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left",
                      selected === flatIndex && "bg-accent-muted-bg",
                    )}
                  >
                    <Avatar
                      name={member.displayName}
                      color={member.avatarColor}
                      size="sm"
                      presence={member.presence}
                      presenceRingClass="border-surface-elevated"
                    />
                    <span className="text-body text-text-primary">
                      <Highlighted
                        text={member.nickname ?? member.displayName}
                        query={debounced}
                      />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </>
  );
}
