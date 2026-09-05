import { useRef, useState } from "react";
import { Paperclip, SendHorizontal, X } from "lucide-react";

import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/cn";
import { anexarArquivo, avisarDigitacao, enviarMensagem } from "../../live/dm";
import { formatFileSize } from "../../lib/format";
import type { StagedAttachmentDto } from "../../ipc/dto";

/**
 * O composer da conversa direta — e a consequência de tela da **ausência de outbox**.
 *
 * `dm.send` é síncrono, com o registro já no log (§31.10). Os cinco estados de outbox
 * (`queued`, `sending`, `awaiting-confirmation`, `failed`, `dropped`) não são declarados
 * em §31.11 porque não podem ocorrer — e por isso este componente **não** os inventa:
 * não há linha "enviando", não há linha "falhou" na conversa e não há "tentar de novo".
 * Ou a promessa resolve e a mensagem é final, ou ela rejeita e nada foi escrito; o
 * segundo caso é um toast, e o texto continua no campo para a pessoa decidir.
 *
 * `desabilitado` é a única exceção de U-33 à regra de esconder-nunca-desabilitar (§15):
 * em `desynced`/`forked` o campo fica visível e morto, porque o estado é temporário e
 * espera o par (§31.13) — sumir com ele faria a conversa parecer somente-leitura.
 */
export interface DmComposerProps {
  conversationId: string;
  nomeDoPar: string;
  desabilitado: boolean;
  motivo?: string;
}

export function DmComposer({
  conversationId,
  nomeDoPar,
  desabilitado,
  motivo,
}: DmComposerProps) {
  const [texto, setTexto] = useState("");
  const [ocupado, setOcupado] = useState(false);
  /**
   * §13.7 — o blob **já está escrito** quando ele aparece aqui: `anexarArquivo` faz o
   * `blob.stage` na hora do clipe, não na hora do envio. O que este estado guarda é o
   * resultado do stage, e é ele que vai no `dm.send` — a tela nunca monta um `attachment`.
   */
  const [anexo, setAnexo] = useState<StagedAttachmentDto | null>(null);
  const [anexando, setAnexando] = useState(false);
  const digitando = useRef(false);

  async function escolherArquivo() {
    if (desabilitado || anexando) return;
    setAnexando(true);
    const r = await anexarArquivo(conversationId);
    setAnexando(false);
    if (r !== null) setAnexo(r);
  }

  async function enviar() {
    const conteudo = texto.trim();
    // §31.5 — sem conteúdo e sem anexo não há mensagem; com anexo, o texto é opcional.
    if ((conteudo.length === 0 && anexo === null) || desabilitado || ocupado) return;
    setOcupado(true);
    const ok = await enviarMensagem(conversationId, conteudo, anexo ?? undefined);
    setOcupado(false);
    // O campo só esvazia quando a escrita aconteceu. Não há retentativa a oferecer, e
    // limpar antes perderia o texto de quem não tem para onde reenviá-lo.
    if (ok) {
      setTexto("");
      setAnexo(null);
      if (digitando.current) {
        digitando.current = false;
        void avisarDigitacao(conversationId, false);
      }
    }
  }

  function aoDigitar(valor: string) {
    setTexto(valor);
    const agoraDigitando = valor.length > 0;
    if (agoraDigitando === digitando.current) return;
    digitando.current = agoraDigitando;
    void avisarDigitacao(conversationId, agoraDigitando);
  }

  return (
    <div className="shrink-0 px-4 pb-4">
      {desabilitado && motivo && (
        <p className="mb-1.5 text-caption text-text-tertiary">{motivo}</p>
      )}
      {/*
        O anexo já staged, antes do envio. Tirá-lo daqui **não** apaga os bytes do core —
        §13.5/§22.4 é quem os poda depois, como órfão de staging —, e prometer o contrário
        na tela seria a mesma mentira que A26 recusa nas mensagens.
      */}
      {anexo && (
        <div className="mb-1.5 flex items-center gap-2 rounded-md border border-border-default bg-surface-elevated px-2 py-1.5">
          <Paperclip size={14} strokeWidth={2} className="shrink-0 text-text-tertiary" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-meta text-text-primary">{anexo.name}</span>
          <span className="shrink-0 text-caption text-text-tertiary tabular-nums">
            {formatFileSize(anexo.sizeBytes)}
          </span>
          <Button variant="icon" size="sm" onClick={() => setAnexo(null)} aria-label="Remover anexo">
            <X size={14} strokeWidth={2} aria-hidden="true" />
          </Button>
        </div>
      )}

      <div
        className={cn(
          "flex items-end gap-2 rounded-lg border border-border-default bg-surface-elevated p-2",
          desabilitado && "opacity-60",
        )}
      >
        <Button
          variant="icon"
          size="sm"
          onClick={() => void escolherArquivo()}
          disabled={desabilitado || anexando}
          aria-label="Anexar arquivo"
        >
          <Paperclip size={16} strokeWidth={2} aria-hidden="true" />
        </Button>
        <textarea
          value={texto}
          onChange={(e) => aoDigitar(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void enviar();
            }
          }}
          disabled={desabilitado}
          rows={1}
          placeholder={`Mensagem para ${nomeDoPar}`}
          aria-label={`Mensagem para ${nomeDoPar}`}
          className={cn(
            "max-h-40 min-h-9 flex-1 resize-none bg-transparent text-body text-text-primary",
            "placeholder:text-text-tertiary focus:outline-none disabled:cursor-not-allowed",
          )}
        />
        <Button
          variant="icon"
          size="sm"
          onClick={() => void enviar()}
          disabled={desabilitado || (texto.trim().length === 0 && anexo === null) || ocupado}
          aria-label="Enviar"
        >
          <SendHorizontal size={16} strokeWidth={2} aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
