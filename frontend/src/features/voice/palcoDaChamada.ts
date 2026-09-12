/**
 * Quem ocupa a área grande da chamada e quem vai para a tira de miniaturas
 * (§9, 2.3.2 · §9, 2.4), separado do React para poder ser fixado por teste.
 *
 * §2.4 já dizia que "tile do compartilhamento ativo ocupa a maior área, thumbnail
 * strip dos demais participantes abaixo/lateral". §2.3.2 acrescenta a ação que
 * faltava: "fixar um tile como principal (clique duplo — desfaz com outro clique
 * duplo)". As duas caem no mesmo lugar — a área grande —, então quem decide o
 * layout é uma conta só: quantos itens o palco tem.
 *
 * Sem isto, a área grande era exclusiva das transmissões: com alguém
 * compartilhando a tela, toda câmera da chamada virava miniatura de 40px e não
 * havia gesto nenhum para aumentar uma.
 */

export interface ComposicaoDoPalco {
  /** Há algo ocupando a área grande — o layout vira palco + tira. */
  temPalco: boolean;
  /** O participante fixado, quando ele ainda está na chamada. */
  fixadoId: string | null;
  /** Quantos itens dividem a área grande (transmissões + fixado). */
  itensNoPalco: number;
  /** Quem sobra para a tira/grade: o fixado sai, porque já está no palco. */
  naGrade: readonly string[];
}

export function comporPalco(a: {
  participantes: ReadonlyArray<{ identityId: string }>;
  /** Ids de quem está transmitindo agora — só a contagem importa aqui. */
  transmissoes: number;
  fixadoId: string | null;
}): ComposicaoDoPalco {
  /*
    Fixado que não está mais na lista não conta: o roster pode tê-lo removido entre
    o gesto e este render. O store também limpa o campo, mas a tela não pode
    depender de a limpeza ter chegado primeiro — reservar a área grande a quem saiu
    deixaria um buraco.
  */
  const fixadoId =
    a.fixadoId !== null &&
    a.participantes.some((p) => p.identityId === a.fixadoId)
      ? a.fixadoId
      : null;

  const itensNoPalco = a.transmissoes + (fixadoId === null ? 0 : 1);

  return {
    temPalco: itensNoPalco > 0,
    fixadoId,
    itensNoPalco,
    naGrade: a.participantes
      .filter((p) => p.identityId !== fixadoId)
      .map((p) => p.identityId),
  };
}
