// §16.4 (emenda de 2026-08-28) — a máquina de estados da fila de karaokê. O que se prova
// aqui é o que a spec declara: primeiro turno automático, promoção sequencial (expiração,
// skip, saída, remoção), fila fechada recusa entrada com E_QUEUE_CLOSED, addTime com teto,
// e a fila morre com a sessão de voz — efêmera como o roster (§6.16).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FilaKaraoké, filaParaOFio } from '../src/l2/voiceCoordinator/index.ts';

const CH = 'ch-palco';

function clockFake() {
  let t = 1_000_000;
  return { now: () => t, avanca(ms: number) { t += ms; } };
}

/** Fila com duração de turno fixa (300 s) e mudanças registradas. */
function filaFake(opts: { aberta?: boolean } = {}) {
  const clock = clockFake();
  const mudancas: Array<{ channelId: string; estado: ReturnType<FilaKaraoké['estadoDe']> }> = [];
  const fila = new FilaKaraoké({
    clock,
    duracaoTurnoDe: () => 300,
    aoMudar: (channelId, estado) => mudancas.push({ channelId, estado }),
    ...(opts.aberta !== undefined ? {} : {}),
  });
  return { fila, clock, mudancas };
}

describe('primeiro turno é automático (§16.4)', () => {
  it('entrada numa fila sem turno vira titular no ato', () => {
    const { fila, clock } = filaFake();
    const r = fila.entrar(CH, 'ana');
    assert.deepEqual(r, { ok: true });
    assert.equal(fila.titularDe(CH), 'ana');
    const estado = fila.estadoDe(CH);
    assert.equal(estado.turno?.keyHex, 'ana');
    assert.equal(estado.turno?.endsAt, clock.now() + 300_000);
    // A segunda entrada entra no FIM da fila, não no palco.
    fila.entrar(CH, 'bruno');
    assert.deepEqual(fila.estadoDe(CH).itens.map((i) => i.keyHex), ['bruno']);
    assert.equal(fila.titularDe(CH), 'ana');
  });

  it('entrada repetida é idempotente — não duplica nem rouba a vez', () => {
    const { fila } = filaFake();
    fila.entrar(CH, 'ana');
    fila.entrar(CH, 'bruno');
    assert.deepEqual(fila.entrar(CH, 'bruno'), { ok: true });
    assert.deepEqual(fila.estadoDe(CH).itens.map((i) => i.keyHex), ['bruno']);
    assert.deepEqual(fila.entrar(CH, 'ana'), { ok: true });
    assert.equal(fila.estadoDe(CH).itens.length, 1);
  });
});

describe('promoção sequencial (§16.4)', () => {
  it('a saída do titular promove o próximo; fila vazia encerra sem sucessor', () => {
    const { fila } = filaFake();
    fila.entrar(CH, 'ana');
    fila.entrar(CH, 'bruno');
    fila.entrar(CH, 'carla');
    fila.sair(CH, 'ana');
    assert.equal(fila.titularDe(CH), 'bruno');
    fila.sair(CH, 'bruno');
    assert.equal(fila.titularDe(CH), 'carla');
    fila.sair(CH, 'carla');
    assert.equal(fila.titularDe(CH), null);
    assert.equal(fila.estadoDe(CH).itens.length, 0);
  });

  it('skip encerra o turno e promove; `promote` dá a vez FORA da ordem', () => {
    const { fila } = filaFake();
    fila.entrar(CH, 'ana');
    fila.entrar(CH, 'bruno');
    fila.entrar(CH, 'carla');
    assert.deepEqual(fila.moderar(CH, 'promote', 'carla'), { ok: true });
    assert.equal(fila.titularDe(CH), 'carla');
    // bruno, que era o próximo, continua na fila (carla o ultrapassou).
    assert.deepEqual(fila.estadoDe(CH).itens.map((i) => i.keyHex), ['bruno']);
    // skip sem alvo: encerra e promove o próximo que estiver na fila.
    assert.deepEqual(fila.moderar(CH, 'skip'), { ok: true });
    assert.equal(fila.titularDe(CH), 'bruno');
  });

  it('promote de quem não está na fila é E_VALIDATION; sem alvo também', () => {
    const { fila } = filaFake();
    fila.entrar(CH, 'ana');
    assert.deepEqual(fila.moderar(CH, 'promote', 'fantasma'), { ok: false, code: 'E_VALIDATION' });
    assert.deepEqual(fila.moderar(CH, 'promote'), { ok: false, code: 'E_VALIDATION' });
  });

  it('remove tira da fila; remover o TITULAR encerra o turno e promove', () => {
    const { fila } = filaFake();
    fila.entrar(CH, 'ana');
    fila.entrar(CH, 'bruno');
    fila.entrar(CH, 'carla');
    assert.deepEqual(fila.moderar(CH, 'remove', 'ana'), { ok: true });
    assert.equal(fila.titularDe(CH), 'bruno');
    assert.deepEqual(fila.estadoDe(CH).itens.map((i) => i.keyHex), ['carla']);
  });
});

describe('expiração e o relógio do host (§16.4)', () => {
  it('ticar após o prazo promove o próximo; o turno novo recomeça a contagem', () => {
    const { fila, clock } = filaFake();
    fila.entrar(CH, 'ana');
    fila.entrar(CH, 'bruno');
    const fimDeAna = fila.estadoDe(CH).turno?.endsAt;
    clock.avanca(300_001);
    fila.ticar(() => true);
    assert.equal(fila.titularDe(CH), 'bruno');
    assert.notEqual(fila.estadoDe(CH).turno?.endsAt, fimDeAna);
    assert.equal(fila.estadoDe(CH).turno?.endsAt, clock.now() + 300_000);
  });

  it('ticar antes do prazo não faz nada', () => {
    const { fila, clock } = filaFake();
    fila.entrar(CH, 'ana');
    clock.avanca(1_000);
    fila.ticar(() => true);
    assert.equal(fila.titularDe(CH), 'ana');
  });
});

describe('addTime — a plateia gostou (§16.4)', () => {
  it('estende o turno corrente; o teto absoluto é 3600 s do início', () => {
    const { fila, clock } = filaFake();
    fila.entrar(CH, 'ana');
    const inicio = fila.estadoDe(CH).turno?.endsAt! - 300_000;
    assert.deepEqual(fila.moderar(CH, 'addTime', undefined, 60), { ok: true });
    assert.equal(fila.estadoDe(CH).turno?.endsAt, inicio + 360_000);
    // Somando além do teto (300 + 60 + 600×6 > 3600): o endsAt clampa, nunca passa.
    for (let i = 0; i < 6; i++) assert.deepEqual(fila.moderar(CH, 'addTime', undefined, 600), { ok: true });
    assert.equal(fila.estadoDe(CH).turno?.endsAt, inicio + 3_600_000);
    void clock;
  });

  it('fora de 30..600 é E_VALIDATION; sem turno é no-op', () => {
    const { fila } = filaFake();
    assert.deepEqual(fila.moderar(CH, 'addTime', undefined, 10), { ok: false, code: 'E_VALIDATION' });
    assert.deepEqual(fila.moderar(CH, 'addTime', undefined, 601), { ok: false, code: 'E_VALIDATION' });
    assert.deepEqual(fila.moderar(CH, 'addTime', undefined, 60), { ok: true });
  });
});

describe('fechar e abrir a fila (§16.4)', () => {
  it('fechada recusa entrada com E_QUEUE_CLOSED; quem já está continua', () => {
    const { fila } = filaFake();
    fila.entrar(CH, 'ana');
    fila.entrar(CH, 'bruno');
    assert.deepEqual(fila.moderar(CH, 'close'), { ok: true });
    assert.deepEqual(fila.entrar(CH, 'carla'), { ok: false, code: 'E_QUEUE_CLOSED' });
    // O turno corrente não é afetado; quem já está permanece.
    assert.equal(fila.titularDe(CH), 'ana');
    assert.deepEqual(fila.estadoDe(CH).itens.map((i) => i.keyHex), ['bruno']);
    assert.deepEqual(fila.moderar(CH, 'open'), { ok: true });
    assert.deepEqual(fila.entrar(CH, 'carla'), { ok: true });
  });
});

describe('a fila morre com a sessão (§6.16)', () => {
  it('ticar com sessão morta descarta o canal inteiro', () => {
    const { fila, clock } = filaFake();
    fila.entrar(CH, 'ana');
    assert.equal(fila.titularDe(CH), 'ana');
    fila.ticar(() => false);
    assert.equal(fila.titularDe(CH), null);
    assert.equal(fila.estadoDe(CH).itens.length, 0);
    // A sessão voltou (nova chamada): fila nova, vazia e aberta — nada sobreviveu.
    clock.avanca(1);
    fila.ticar(() => true);
    assert.deepEqual(fila.estadoDe(CH), { aberta: true, itens: [], turno: null });
  });

  it('a saída de TODO MUNDO da chamada não é o mesmo que fila vazia: quem sai por queda perde o lugar', () => {
    // O gate (§17.4) remove o participante da sessão; o turno dele tem de acabar, porque
    // sem sessão não há donde transmitir. `ticar` descarta a fila inteira com a sessão —
    // e a nova chamada começa limpa.
    const { fila } = filaFake();
    fila.entrar(CH, 'ana');
    fila.entrar(CH, 'bruno');
    fila.ticar((channelId) => (channelId === CH ? false : true));
    assert.equal(fila.titularDe(CH), null);
  });
});

describe('as mudanças saem por aoMudar (§16.3)', () => {
  it('toda mutação emite o estado completo do canal', () => {
    const { fila, mudancas } = filaFake();
    fila.entrar(CH, 'ana');
    fila.entrar(CH, 'bruno');
    assert.equal(mudancas.length, 2);
    const ultima = mudancas.at(-1)!;
    assert.equal(ultima.channelId, CH);
    assert.equal(ultima.estado.turno?.keyHex, 'ana');
    assert.deepEqual(ultima.estado.itens.map((i) => i.keyHex), ['bruno']);
  });

  it('saída sem estar na fila não emite nada', () => {
    const { fila, mudancas } = filaFake();
    fila.sair(CH, 'fantasma');
    assert.equal(mudancas.length, 0);
  });
});

describe('filaParaOFio — os nomes de §15.5 no fio (emenda de 2026-08-28)', () => {
  it('traduz {aberta, itens, turno} → {open, items, turn}, campo a campo', () => {
    const { fila, clock } = filaFake();
    fila.entrar(CH, 'ana');
    fila.entrar(CH, 'bruno');
    const noFio = filaParaOFio(fila.estadoDe(CH));
    assert.deepEqual(noFio, {
      open: true,
      items: [{ keyHex: 'bruno', queuedAt: clock.now() }],
      turn: { keyHex: 'ana', endsAt: clock.now() + 300_000 },
    });
    // Os nomes internos NÃO vazam para o fio — foi exatamente isto que fez o renderer
    // descartar o evento por forma com "Entrar na fila" funcionando no host.
    assert.equal('aberta' in (noFio as object), false);
    assert.equal('itens' in (noFio as object), false);
    assert.equal('turno' in (noFio as object), false);
  });

  it('sem turno, `turn` é null — nunca undefined', () => {
    const { fila } = filaFake();
    const noFio = filaParaOFio(fila.estadoDe(CH));
    assert.equal(noFio.turn, null);
    assert.deepEqual(noFio.items, []);
  });
});

// ─── §16.4 (emenda de 2026-09-05) — a fila contra o roster vivo ────────────────────────

describe('reconciliar — quem saiu da chamada sai da fila (§16.4/§17.4)', () => {
  it('titular ausente perde a vez e o próximo PRESENTE é promovido', () => {
    const { fila, mudancas } = filaFake();
    fila.entrar(CH, 'ana'); // titular automático
    fila.entrar(CH, 'bruno');
    fila.entrar(CH, 'carla');
    mudancas.length = 0;

    // O computador da Ana desliga e o Bruno cai junto: `dropPeer`/`sweepLiveness` os tiram
    // do roster. Antes desta emenda a fila mantinha os dois, e o gate de §17.4 ("só o
    // titular fala") deixava o canal inteiro mudo até `endsAt` — promovendo o Bruno
    // fantasma em seguida, para mais um turno de silêncio.
    fila.reconciliar(CH, new Set(['carla']));

    assert.equal(fila.titularDe(CH), 'carla');
    assert.deepEqual(fila.estadoDe(CH).itens, []);
    assert.equal(mudancas.length, 1, 'uma mudança, um evento');
  });

  it('a sala inteira sumir encerra o turno sem sucessor', () => {
    const { fila } = filaFake();
    fila.entrar(CH, 'ana');
    fila.entrar(CH, 'bruno');
    fila.reconciliar(CH, new Set());
    assert.equal(fila.titularDe(CH), null);
    assert.deepEqual(fila.estadoDe(CH).itens, []);
  });

  it('é idempotente e silenciosa quando o roster não mudou nada', () => {
    const { fila, mudancas } = filaFake();
    fila.entrar(CH, 'ana');
    fila.entrar(CH, 'bruno');
    mudancas.length = 0;
    fila.reconciliar(CH, new Set(['ana', 'bruno']));
    fila.reconciliar(CH, new Set(['ana', 'bruno']));
    assert.equal(mudancas.length, 0, 'sem mudança, sem evento — ela roda a cada voice.roster');
  });

  it('canal sem fila conhecida é no-op', () => {
    const { fila, mudancas } = filaFake();
    fila.reconciliar('ch-vazio', new Set(['ana']));
    assert.equal(mudancas.length, 0);
  });
});
