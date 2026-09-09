import { useState } from "react";
import { Pencil, Reply, SmilePlus, Trash2 } from "lucide-react";

import { Avatar } from "../../components/ui/Avatar";
import { Tooltip } from "../../components/ui/Tooltip";
import { cn } from "../../lib/cn";
import { formatClock } from "../../lib/format";
import { EmojiPicker } from "../channel/EmojiPicker";
import { apagarMensagem, editarMensagem, reagir } from "../../live/dm";
import { DmAttachmentCard } from "./DmAttachmentCard";
import { corDoPar, marcasDaMensagem, rotuloDeEntrega } from "./dmRegras";
import type { DmMessageDto } from "../../ipc/dto";

/**
 * Uma mensagem da conversa direta, na anatomia de §9 2.1.
 *
 * As três coisas que este componente **não** faz, e que são o conteúdo normativo de
 * U-33 (a lógica está em `dmRegras.ts`, que é onde o teste a alcança):
 *
 * - não afirma a causa de "não entregue" (**L-26**, **L-28**);
 * - não escreve "lido" em lugar nenhum (§31.11: o `ack` é chegada, não leitura);
 * - não esconde nem corrige a marca de ordem provisória (**L-27**).
 */
export interface DmMessageRowProps {
  mensagem: DmMessageDto;
  /** Continuação do mesmo autor dentro da janela de agrupamento (§9, 2.1). */
  agrupada: boolean;
  agora: number;
  propria?: boolean;
  onResponder?: (mensagem: DmMessageDto) => void;
}

export function DmMessageRow({
  mensagem,
  agrupada,
  agora,
  propria = false,
  onResponder,
}: DmMessageRowProps) {
  const [editando, setEditando] = useState(false);
  const [textoEdicao, setTextoEdicao] = useState(mensagem.content ?? "");
  const [pickerAberto, setPickerAberto] = useState(false);

  const entrega = rotuloDeEntrega(mensagem, agora);
  const marcas = marcasDaMensagem(mensagem);

  return (
    <article
      className={cn(
        "group relative flex gap-2 px-4 hover:bg-surface-hover",
        agrupada ? "py-0.5" : "pt-3 pb-0.5",
      )}
    >
      <div className="w-8 shrink-0">
        {!agrupada && (
          <Avatar
            name={mensagem.author.displayName}
            color={corDoPar(mensagem.author.avatarColor)}
            size="md"
          />
        )}
      </div>

      <div className="min-w-0 flex-1">
        {mensagem.replyTo && (
          <p className="mb-0.5 flex items-center gap-1.5 text-caption text-text-secondary">
            <Reply size={12} strokeWidth={2} aria-hidden="true" className="shrink-0 text-text-tertiary" />
            <span className="shrink-0">respondendo a</span>
            <span className="shrink-0 font-medium text-text-primary">
              {mensagem.replyTo.author.displayName}
            </span>
            <span className="truncate text-text-tertiary italic">
              {mensagem.replyTo.deleted ? "Mensagem apagada" : (mensagem.replyTo.excerpt ?? "")}
            </span>
          </p>
        )}

        {!agrupada && (
          <p className="flex items-baseline gap-1.5">
            <span className="text-body-emphasis text-text-primary">
              {mensagem.author.displayName}
            </span>
            <span className="text-caption text-text-tertiary">{mensagem.author.handle}</span>
            <span className="text-caption text-text-tertiary tabular-nums">
              {formatClock(new Date(mensagem.ts))}
            </span>
          </p>
        )}

        {editando ? (
          <div className="mt-1">
            <textarea
              value={textoEdicao}
              onChange={(e) => setTextoEdicao(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (textoEdicao.trim() !== "") {
                    void editarMensagem(mensagem.conversationId, mensagem.id, textoEdicao.trim());
                    setEditando(false);
                  }
                } else if (e.key === "Escape") {
                  setEditando(false);
                }
              }}
              rows={2}
              className="w-full rounded border border-border-subtle bg-surface-app p-2 text-body text-text-primary focus:outline-none"
            />
            <div className="mt-1 flex gap-2 text-meta">
              <button
                type="button"
                onClick={() => {
                  if (textoEdicao.trim() !== "") {
                    void editarMensagem(mensagem.conversationId, mensagem.id, textoEdicao.trim());
                    setEditando(false);
                  }
                }}
                disabled={textoEdicao.trim() === ""}
                className="text-accent-default hover:underline disabled:opacity-50"
              >
                Salvar
              </button>
              <button
                type="button"
                onClick={() => setEditando(false)}
                className="text-text-tertiary hover:underline"
              >
                Cancelar
              </button>
            </div>
          </div>
        ) : mensagem.deleted || mensagem.content === null ? (
          // A26 — o tombstone apaga o conteúdo da projeção, não os bytes. "Apagada" é a
          // verdade da interface, e a spec é explícita em não prometer mais que isso.
          <p className="text-body text-text-tertiary italic">Mensagem apagada</p>
        ) : (
          <p className="text-body whitespace-pre-wrap text-text-primary">{mensagem.content}</p>
        )}

        {/*
          §31.14 — o anexo sobrevive ao tombstone da mensagem? Não: `dm.delete` apaga o
          `content` da projeção, e mostrar o arquivo de uma mensagem apagada devolveria o
          que a pessoa mandou tirar da vista.
        */}
        {mensagem.hasAttachment && !mensagem.deleted && (
          <DmAttachmentCard
            conversationId={mensagem.conversationId}
            messageId={mensagem.id}
          />
        )}

        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 empty:hidden">
          {mensagem.editedAt !== undefined && (
            <span className="text-caption text-text-tertiary">(editada)</span>
          )}

          {/* L-27 — marcado, nunca corrigido e nunca escondido. */}
          {marcas.map((marca) => (
            <Tooltip key={marca.id} label={marca.detalhe}>
              <span
                className={cn(
                  "rounded-sm px-1 py-px text-caption",
                  "bg-conn-degraded/15 text-text-secondary",
                )}
              >
                {marca.rotulo}
              </span>
            </Tooltip>
          ))}

          {entrega && (
            <Tooltip label={entrega.detalhe}>
              <span
                className={cn(
                  "text-caption",
                  entrega.texto === "Entregue"
                    ? "text-text-tertiary"
                    : "text-conn-offline",
                )}
              >
                {entrega.texto}
              </span>
            </Tooltip>
          )}
        </p>
      </div>

      {/* Barra de ações no hover (§9 2.1 e U-33: responder, editar, apagar, reagir) */}
      {!editando && !mensagem.deleted && (
        <div className="absolute right-4 top-2 hidden items-center gap-0.5 rounded-md border border-border-subtle bg-surface-elevated px-1 py-0.5 shadow-sm group-hover:flex">
          {onResponder && (
            <button
              type="button"
              onClick={() => onResponder(mensagem)}
              title="Responder"
              aria-label="Responder"
              className="rounded p-1 text-text-tertiary hover:bg-surface-hover hover:text-text-primary"
            >
              <Reply size={14} strokeWidth={2} aria-hidden="true" />
            </button>
          )}
          <div className="relative">
            <button
              type="button"
              onClick={() => setPickerAberto((v) => !v)}
              title="Reagir"
              aria-label="Reagir"
              className="rounded p-1 text-text-tertiary hover:bg-surface-hover hover:text-text-primary"
            >
              <SmilePlus size={14} strokeWidth={2} aria-hidden="true" />
            </button>
            {pickerAberto && (
              <EmojiPicker
                onPick={(emoji) => {
                  void reagir(mensagem.conversationId, mensagem.id, emoji, true);
                  setPickerAberto(false);
                }}
                onClose={() => setPickerAberto(false)}
                side="top"
              />
            )}
          </div>
          {propria && (
            <>
              <button
                type="button"
                onClick={() => {
                  setTextoEdicao(mensagem.content ?? "");
                  setEditando(true);
                }}
                title="Editar"
                aria-label="Editar"
                className="rounded p-1 text-text-tertiary hover:bg-surface-hover hover:text-text-primary"
              >
                <Pencil size={14} strokeWidth={2} aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => void apagarMensagem(mensagem.conversationId, mensagem.id)}
                title="Apagar"
                aria-label="Apagar"
                className="rounded p-1 text-text-tertiary hover:bg-surface-hover hover:text-feedback-danger"
              >
                <Trash2 size={14} strokeWidth={2} aria-hidden="true" />
              </button>
            </>
          )}
        </div>
      )}
    </article>
  );
}
