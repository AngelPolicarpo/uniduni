import { useState } from "react";
import { useVoiceStore } from "../../store/voiceStore";

export interface LeaveVoiceGuard {
  requestLeave: () => void;
  confirming: boolean;
  cancel: () => void;
  confirm: () => void;
}

/**
 * §11, C11 (exceções) — sair da chamada enquanto compartilha a tela pede
 * confirmação, porque encerra o compartilhamento junto; sem compartilhamento
 * ativo, sai direto, sem "tem certeza?" à toa (§15).
 *
 * Vive num hook porque os dois pontos de saída — barra persistente (2.3.1) e
 * grade expandida (2.3) — precisam da mesma regra.
 *
 * **A pergunta é local, e a resposta também.** Ler só o `sharingScreen` do participante
 * deixava duas janelas sem confirmação: o roster do host chega depois do gesto (e antes de
 * §6.16 passar a escrever `sharing`, chegava dizendo `false` para sempre), e a fase
 * `starting` — entre escolher a fonte e a captura voltar — não tem `sharingScreen` nenhum.
 * Nos dois casos a sessão JÁ existe no host e sair a mata: `shares` é quem sabe disso na
 * hora, em qualquer fase.
 */
export function useLeaveVoiceGuard(): LeaveVoiceGuard {
  const sharing = useVoiceStore((state) => {
    const eu = state.localId?.toLowerCase();
    if (eu === undefined) return false;
    if (state.shares.some((s) => s.presenterId.toLowerCase() === eu)) return true;
    return Boolean(
      state.participants.find((p) => p.identityId.toLowerCase() === eu)?.sharingScreen,
    );
  });
  const leave = useVoiceStore((state) => state.leave);
  const [confirming, setConfirming] = useState(false);

  return {
    requestLeave: () => (sharing ? setConfirming(true) : leave()),
    confirming,
    cancel: () => setConfirming(false),
    confirm: () => {
      setConfirming(false);
      leave();
    },
  };
}
