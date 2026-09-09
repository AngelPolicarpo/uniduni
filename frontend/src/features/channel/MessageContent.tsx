import { useShallow } from "zustand/react/shallow";
import { renderMarkdown } from "../../lib/markdown";
import { selectMemberLabel, selectRole, useCommunityStore, useFindMember } from "../../store/communityStore";
import type { Message } from "../../domain/types";

/**
 * "@Ana Torres", "@Moderador", "@everyone" — o texto exato que vira pill no
 * corpo da mensagem. Sai dos ids em `message.mentions`, não de heurística
 * sobre o texto: quem foi mencionado é dado, não adivinhação.
 */
function useMentionTokens(message: Message, communityId: string): string[] {
  const findMember = useFindMember();
  return useCommunityStore(
    useShallow((state) => {
      const tokens: string[] = [];
      for (const id of message.mentions) {
        if (id === "everyone") {
          tokens.push("@everyone");
          continue;
        }
        const member = findMember(communityId, id);
        if (member) {
          const currentLabel = selectMemberLabel(state, communityId, id);
          tokens.push(`@${currentLabel}`);
          if (member.displayName && member.displayName !== currentLabel) {
            tokens.push(`@${member.displayName}`);
          }
        }
        const role = selectRole(state, id);
        if (role) {
          tokens.push(`@${role.name}`);
        }
      }
      return tokens;
    }),
  );
}

export interface MessageContentProps {
  message: Message;
  communityId: string;
}

/**
 * Corpo da mensagem (§9, 2.1) — markdown básico renderizado só depois do
 * envio (§11, C9: sem preview WYSIWYG no composer), menções em pill
 * `accent-muted-bg` (§5.3) e o rótulo "(editado)" fechando o texto inline.
 *
 * O container é `div`, não `p`: bloco de código é `<pre>`, que não pode
 * viver dentro de parágrafo.
 */
export function MessageContent({ message, communityId }: MessageContentProps) {
  const tokens = useMentionTokens(message, communityId);

  return (
    <div className="text-body break-words whitespace-pre-wrap text-text-primary">
      {renderMarkdown(message.content, tokens)}
      {message.edited && (
        <span className="ml-1 align-baseline text-caption text-text-tertiary">
          (editado)
        </span>
      )}
    </div>
  );
}
