import { useState } from "react";

import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { TextField } from "../../components/ui/TextField";
import { useDmStore } from "../../store/dmStore";
import { useIdentityStore } from "../../store/identityStore";
import {
  TEXTO_BLOQUEAR_CONVERSA,
  TEXTO_ENTREGA_QUANDO_ONLINE,
  TEXTO_ESQUECER_CONVERSA,
  TEXTO_NOVA_CONVERSA,
  TEXTO_POLITICA_RESTRITA,
  lerChaveDeIdentidade,
} from "./dmRegras";

/**
 * As duas confirmações que §31.24 torna **obrigatórias**, e cujos textos são normativos
 * (`dmRegras.ts`): esquecer (**L-25**) e bloquear (**L-28**).
 *
 * Nenhuma das duas é "Tem certeza?" — a regra de §15 é nomear a consequência exata, e
 * nos dois casos a consequência é justamente o que não se adivinha: a conversa **não**
 * some por inteiro do disco, e o outro lado **não** é avisado.
 */

export interface DmConfirmProps {
  open: boolean;
  nomeDoPar: string;
  onClose: () => void;
  onConfirm: () => void;
}

export function DmEsquecerModal({ open, nomeDoPar, onClose, onConfirm }: DmConfirmProps) {
  return (
    <Modal open={open} onClose={onClose} title={`Esquecer a conversa com ${nomeDoPar}?`} size="sm">
      <p className="text-body text-text-secondary">{TEXTO_ESQUECER_CONVERSA}</p>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
        <Button
          variant="danger"
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          Esquecer conversa
        </Button>
      </div>
    </Modal>
  );
}

export function DmBloquearModal({ open, nomeDoPar, onClose, onConfirm }: DmConfirmProps) {
  return (
    <Modal open={open} onClose={onClose} title={`Bloquear ${nomeDoPar}?`} size="sm">
      <p className="text-body text-text-secondary">{TEXTO_BLOQUEAR_CONVERSA}</p>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
        <Button
          variant="danger"
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          Bloquear
        </Button>
      </div>
    </Modal>
  );
}

/**
 * **A porta de entrada da conversa direta** — §31.16.1 `dm.open`.
 *
 * Ela faltava: até aqui a DM só sabia **receber** pedido, e `abrirConversaCom` era
 * superfície morta. Não é B63 (onde a DM mora na navegação, já resolvida pela proposta
 * B63(a) em §107.4) nem B64 (a rota de deep link, que troca a forma de obter a chave, não
 * a existência do campo).
 *
 * Nada aqui é irreversível, e é por isso que a confirmação **não** é modal de perigo: o
 * estado nasce `pending-out`, que é local (§31.9), e `dm.forget` o desfaz. O que ela custa
 * está escrito no texto — o nó passa a anunciar-se na DHT e a procurar aquele par (§31.8).
 */
export function DmNovaConversaModal({
  open,
  onClose,
  onAbrir,
  chaveInicial,
}: {
  open: boolean;
  onClose: () => void;
  /**
   * Recebe a chave já normalizada e validada, e o `conversationId` quando ela **já está na
   * lista** — que é o `jaExiste` de `lerChaveDeIdentidade`, e não uma conveniência.
   */
  onAbrir: (peerKey: string, jaExiste: string | null) => void;
  /** B64 — a chave vinda do link, pré-preenchida e ainda confirmável. */
  chaveInicial?: string | null;
}) {
  const [texto, setTexto] = useState(chaveInicial ?? "");
  const [erro, setErro] = useState<string | null>(null);
  const euHex = useIdentityStore((s) => s.identity?.publicKey ?? null);
  const conversas = useDmStore((s) => s.conversas);
  const contactPolicy = useDmStore((s) => s.contactPolicy);

  const fechar = () => {
    setTexto("");
    setErro(null);
    onClose();
  };

  const enviar = () => {
    const r = lerChaveDeIdentidade(texto, { euHex, conversas });
    if (!r.ok) {
      setErro(r.erro);
      return;
    }
    // Chave de quem já está na lista abre a conversa existente: `dm.open` é derivado
    // (§31.2 regra 1), e um "pedido enviado" aqui seria mentira sobre o que aconteceu.
    //
    // O `jaExiste` era calculado e **descartado**, e mandar a chave pelo `dm.open` de
    // qualquer forma custava dois desfechos errados, um deles grave:
    //
    //   - conversa `blocked` → `E_DM_BLOCKED` (§31.16.1), e um toast de "não foi possível
    //     abrir" no lugar do histórico legível que `blocked` promete ser;
    //   - conversa `pending-in` → **aceite silencioso**. `dm.open` sobre um pedido recebido
    //     é `aceitar` (§31.9 regra 1: "os dois abriram ao mesmo tempo"), e aceitar é o ato
    //     que escreve o `dm.hello` e não se desfaz. É exatamente o que a seção de pedidos
    //     da lista existe para impedir que aconteça por engano.
    onAbrir(r.peerKey, r.jaExiste);
    fechar();
  };

  return (
    <Modal open={open} onClose={fechar} title="Nova conversa" size="sm">
      <p className="text-body text-text-secondary">{TEXTO_NOVA_CONVERSA}</p>
      <p className="mt-2 text-meta text-text-tertiary">{TEXTO_ENTREGA_QUANDO_ONLINE}</p>

      <form
        className="mt-4"
        onSubmit={(e) => {
          e.preventDefault();
          enviar();
        }}
      >
        <TextField
          label="Chave de identidade"
          value={texto}
          onChange={(v) => {
            setTexto(v);
            setErro(null);
          }}
          {...(erro !== null ? { error: erro } : {})}
          hint="64 caracteres. Espaços e quebras de linha são ignorados."
          placeholder="a1b2c3…"
          autoFocus
          spellCheck={false}
          autoComplete="off"
          className="font-mono"
        />

        {/*
          §31.9 regra 5 — "o custo, e ele precisa aparecer na UI". Aqui ele aparece no
          momento em que é relevante, e falando só da política DESTA máquina: a do outro
          lado este nó não conhece, e afirmá-la seria inventar o fato que L-28 recusa dar.
        */}
        {contactPolicy === "shared-community" && (
          <p className="mt-3 text-meta text-text-tertiary">{TEXTO_POLITICA_RESTRITA}</p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={fechar}>
            Cancelar
          </Button>
          <Button type="submit">Abrir conversa</Button>
        </div>
      </form>
    </Modal>
  );
}
