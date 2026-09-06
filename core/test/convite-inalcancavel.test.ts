// §12.3 desfecho 6 — "host offline / inalcançável (**decidido pelo cliente**)".
//
// A união normativa de `inviteResolve` tem SEIS desfechos, e o sexto é o único que o
// cliente decide sozinho: os outros cinco vêm da avaliação do host. §12.5 o lista ao lado
// de `invalid` na tabela do que vaza, e U-03 exige que a tela diga "o convite pode estar
// bom — tente de novo mais tarde", com botão de repetir. É outra tela, e outra frase, do
// que "este convite não é válido".
//
// A implementação recusava com `E_HOST_UNAVAILABLE` no lugar de devolver o desfecho, e o
// renderer tinha o ramo de `unreachable` escrito e **inalcançável**: quem tentasse um
// convite cujo host está fora via o banner genérico de erro com um código de §20 dentro.
//
// `redeem` continua recusando pelo mesmo caso — resgatar é escrita, e escrita que não
// aconteceu é recusa (coluna de §15.4, `desfechoParaCodigo`).
//
// Verificado por mutação: voltar `resolve` a `{ ok: false, code: 'E_HOST_UNAVAILABLE' }`
// derruba o primeiro caso e mantém o segundo — que é exatamente a assimetria que se afirma.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AdmissionService } from '../src/composition/admission.ts';
import { inviteSecretToCode } from '../src/l2/invites/index.ts';
import type { CoreRuntime } from '../src/composition/boot.ts';
import type { ManifestDb } from '../src/l0/manifest/index.ts';
import type { Swarm } from '../src/l0/swarm/index.ts';
import { keypairFromSeed, T0 } from './helpers/world.ts';

/** Um código de 16 chars que passa a gramática de §12.1 — o host é que não existe. */
const CODIGO = inviteSecretToCode(Buffer.alloc(10, 7));

/** Sem transporte: é literalmente o "host inalcançável" do desfecho 6. */
function servico(): AdmissionService {
  const identity = keypairFromSeed('candidato-sem-host');
  const runtime = {
    onTransport: () => () => undefined,
    whenTransport: async () => null,
  } as unknown as CoreRuntime;
  return new AdmissionService({
    runtime,
    swarm: null as unknown as Swarm,
    manifest: null as unknown as ManifestDb,
    dataKey: Buffer.alloc(32, 3),
    coresDir: '/nao-usado',
    selfKey: () => identity,
    profile: () => ({ displayName: 'Candidato', avatarColor: 2 }),
    now: () => T0,
  });
}

describe('§12.3 desfecho 6 — host inalcançável', () => {
  it('`invite.resolve` devolve o desfecho `unreachable`, e não uma recusa', async () => {
    const r = await servico().resolve({ codeOrLink: CODIGO });

    assert.deepEqual(r, { ok: true, preview: { status: 'unreachable' } });
  });

  it('o link inteiro chega ao mesmo desfecho — a gramática de §15.4 aceita os dois', async () => {
    const r = await servico().resolve({ codeOrLink: `comunidadep2p://join/${CODIGO.replace(/-/g, '')}` });

    assert.deepEqual(r, { ok: true, preview: { status: 'unreachable' } });
  });

  it('código malformado continua sendo recusa, não desfecho', async () => {
    const r = await servico().resolve({ codeOrLink: 'nao-e-um-codigo' });

    assert.deepEqual(r, { ok: false, code: 'E_MALFORMED' });
  });

  it('`invite.redeem` no mesmo caso recusa com `E_HOST_UNAVAILABLE`', async () => {
    const r = await servico().redeem({ codeOrLink: CODIGO });

    assert.deepEqual(r, { ok: false, code: 'E_HOST_UNAVAILABLE' });
  });
});
