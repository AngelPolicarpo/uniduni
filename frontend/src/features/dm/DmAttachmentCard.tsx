import { useEffect } from "react";

import { AttachmentCard } from "../channel/AttachmentCard";
import { Button } from "../../components/ui/Button";
import { anexo as paraDominio } from "../../live/adaptadores";
import { carregarAnexo } from "../../live/dm";
import { useDmStore, type DmAnexo } from "../../store/dmStore";

/**
 * O anexo de uma mensagem de conversa direta (§31.14).
 *
 * **Este componente não desenha um cartão** — ele resolve o anexo e entrega o cartão de
 * §13, que é o que §31.14 manda fazer: "fluxo de upload (§13.2) e de download (§13.4)
 * **reutilizados sem alteração**". A cópia que existia aqui reimplementava só o começo
 * daquele fluxo e parava no botão: lia um instantâneo congelado de `dmStore.anexos` e
 * nunca mais o revisitava, então
 *
 *   - o progresso não aparecia (`blob.progress` alimenta o `downloadStore`, não este),
 *   - concluir não mudava nada na tela (`blob.completed` idem),
 *   - e **não havia como abrir o arquivo baixado** — nem "Abrir" nem "Mostrar na pasta",
 *     que é §13.6 regra 1 sem superfície nenhuma.
 *
 * A correlação com os eventos é o `blobIdHex` de §13.2 — os 16 primeiros bytes do `hash`,
 * em hex (§15.6.1, emenda de 2026-09-05) —, e é ela que o adaptador de §15.6.1 já produz
 * como `Attachment.id`. Nada disso é específico de DM: o escopo do blob numa conversa é a
 * conversa, e o `conversationId` viaja no slot do `communityId` pela mesma substituição
 * que §31.14 faz no core de blobs.
 *
 * O que continua valendo, e não muda aqui: **não baixa sozinho** (§13.4 é *pull*) e não
 * renderiza o conteúdo inline fora do que §13.6 permite.
 */
export interface DmAttachmentCardProps {
  conversationId: string;
  messageId: string;
}

export function DmAttachmentCard({ conversationId, messageId }: DmAttachmentCardProps) {
  const anexo = useDmStore((s) => s.anexos[messageId]);

  // §31.16.3 — a lista de mensagens traz só `hasAttachment`; o anexo inteiro é uma query
  // por mensagem. Buscar aqui, e não ao carregar a página, evita N consultas por rolagem.
  useEffect(() => {
    if (anexo === undefined) void carregarAnexo(conversationId, messageId);
  }, [anexo, conversationId, messageId]);

  if (anexo === undefined) {
    return (
      <div className="mt-1 h-12 w-64 animate-pulse rounded-md border border-border-subtle bg-surface-elevated" />
    );
  }

  /*
   * `null` = a consulta não devolveu o anexo. Antes isto era indistinguível de "ainda
   * carregando", e o cartão pulsava para sempre: `carregarAnexo` saía sem gravar nada e o
   * efeito, com as mesmas dependências, não rodava de novo.
   *
   * A causa possível é uma só, e vale dizê-la porque muda o texto: `hasAttachment` e a
   * linha de `dm_attachments` saem da MESMA tabela, gravadas pelo MESMO lote do projetor
   * (§31.7.6) — "está na lista e não está na query" não é anexo a caminho, é consulta que
   * falhou. Por isso a frase fala de carregar, não de replicar, e por isso há um botão.
   */
  if (anexo === null) {
    return (
      <div className="mt-1 flex max-w-md items-center gap-2 rounded-md border border-border-default bg-surface-elevated px-2 py-1.5">
        <span className="min-w-0 flex-1 text-meta text-text-tertiary">
          Não foi possível carregar este anexo.
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void carregarAnexo(conversationId, messageId)}
        >
          Tentar de novo
        </Button>
      </div>
    );
  }

  return <AttachmentCard attachment={paraDominio(comKind(anexo), conversationId)} />;
}

/**
 * §31.16.3 devolve o `AttachmentDto` de §15.6.1 inteiro — inclusive `state`, `progress` e
 * `localPath`, que a query da DM não mandava até a correção de 2026-09-05. Um núcleo mais
 * antigo que o renderer não os manda; ler a ausência como "nada baixado" é a leitura
 * conservadora, e é a mesma que o adaptador faz com `revealMode`.
 */
function comKind(a: DmAnexo): Parameters<typeof paraDominio>[0] {
  return {
    ...a,
    progress: a.progress ?? 0,
    availablePeers: a.availablePeers ?? 0,
    hostAvailable: a.hostAvailable ?? false,
  };
}
