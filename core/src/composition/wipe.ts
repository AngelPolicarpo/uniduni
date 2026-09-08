// A máquina de estados retomável do `identity.wipe` (§18.6) — raiz de composição: quem
// tem as mãos em TODOS os recursos que a máquina toca (swarm, runtime, view, manifest,
// identidade e lock) é esta raiz; nenhum módulo de camada poderia fechá-la sozinho.
//
//   none → requested → swarm-down → cores-closed → view-deleted → manifest-deleted
//        → key-wiped → done → none
//
// O estado vive em `manifest.meta.wipe_state`, gravado com FULL **antes** de cada etapa.
// `manifest-deleted` grava o sentinela `<dataDir>/WIPE` antes de remover o banco — a partir
// daí não há mais onde gravar. No boot, estado ≠ none ou sentinela presente retoma de onde
// parou ANTES de qualquer outra coisa (§3.3). O LOCK é o último recurso liberado, e só
// depois de `key-wiped`.

import fs from 'node:fs';
import path from 'node:path';

import type { Swarm } from '../l0/swarm/index.ts';
import type { ViewDb } from '../l0/view/index.ts';
import type { ManifestDb } from '../l0/manifest/index.ts';
import { WIPE_STAGES, type WipeStage } from '../l3/ipcMain/index.ts';

export const WIPE_SENTINEL = 'WIPE';

/** As etapas que a máquina executa, na ordem — sem o `none` inicial nem o `done` final. */
const STAGES = WIPE_STAGES.filter((s) => s !== 'none') as readonly WipeStage[];

export type WipeResourceDeps = {
  readonly dataDir: string;
  readonly swarm: Pick<Swarm, 'listTopics' | 'leave' | 'flush'>;
  /** Fecha cores, jobs, loops e blobs — a etapa `cores-closed`. */
  closeRuntime(): Promise<void>;
  readonly view: ViewDb;
  readonly manifest: ManifestDb;
  wipeIdentity(): void;
  /**
   * §18.6 emendado — zera a Data Key do processo em `key-wiped`. É ela que protege as
   * sementes de comunidade (§5.3), então deixá-la no heap contradiz §3.2 item 4 tanto
   * quanto deixar a semente de identidade.
   */
  wipeDataKey?(): void;
  /**
   * §10.8/§18.6 — o LOCK é o último recurso liberado, só depois de `key-wiped`, e **só
   * quando a sessão vai encerrar**. Na retomada do boot o processo continua, e ali esta
   * porta não é passada: liberar no meio do boot deixaria o núcleo rodando a sessão inteira
   * sem a exclusão de §10.8 (emenda de 2026-09-05).
   */
  releaseLock?(): void;
};

export type WipeOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'E_WIPE_INCOMPLETE'; readonly stage: WipeStage };

/**
 * Apaga o banco e os arquivos que o acompanham, **verificando** que sumiram.
 *
 * §18.6 emendado: falha em remover é `E_WIPE_INCOMPLETE`, nunca sucesso silencioso. O
 * `try`/`catch` mudo que estava aqui era a metade cara do defeito — em Windows o SQLite
 * abre o banco sem `FILE_SHARE_DELETE`, então apagar um `manifest.db` ainda aberto falha
 * com `EBUSY`/`EPERM`, o erro sumia, a máquina seguia para `done` e o `wipe` reportava
 * sucesso deixando `communities.core_key` e `invite_secrets.secret` (que não é cifrado) no
 * disco. A outra metade é fechar o descritor antes; quem chama faz isso.
 */
function apagarBanco(caminho: string): void {
  for (const sufixo of ['', '-wal', '-shm']) {
    const alvo = `${caminho}${sufixo}`;
    fs.rmSync(alvo, { force: true });
    if (fs.existsSync(alvo)) {
      throw Object.assign(new Error(`não foi possível remover ${alvo}`), { code: 'E_WIPE_INCOMPLETE' });
    }
  }
}

/** Fecha o que estiver aberto sem deixar a exceção derrubar a etapa: fechar duas vezes é no-op. */
function fecharEmSilencio(o: { close(): void } | null | undefined): void {
  try {
    o?.close();
  } catch {}
}

/**
 * Remove os diretórios de blobs descriptografados (<dataDir>/<blobsCoreKeyHex>)
 * e diretórios temporários de anexo residuais em disco.
 */
function apagarBlobs(dataDir: string): void {
  try {
    const entries = fs.readdirSync(dataDir, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        (/^[0-9a-f]{64}$/i.test(entry.name) || entry.name === 'blobs' || entry.name === 'staging')
      ) {
        fs.rmSync(path.join(dataDir, entry.name), { recursive: true, force: true });
      }
    }
  } catch {}
}

/** Executa UMA etapa do switch — o mesmo corpo para executar e para retomar. */
async function executarEtapa(etapa: WipeStage, deps: WipeResourceDeps): Promise<void> {
  switch (etapa) {
    case 'requested':
      break;
    case 'swarm-down':
      for (const topico of deps.swarm.listTopics()) deps.swarm.leave(topico.topicHex);
      await deps.swarm.flush().catch(() => {});
      break;
    case 'cores-closed':
      await deps.closeRuntime();
      // Fechado, o armazenamento dos cores sai do disco: uma limpeza que deixa o log de
      // toda comunidade legível em `<dataDir>/cores` contradiria §18.4 (réplica removida
      // sai inteira) e o propósito da máquina. É a etapa que nomeia os cores.
      {
        const coresDir = path.join(deps.dataDir, 'cores');
        if (fs.existsSync(coresDir)) {
          try {
            await fs.promises.rm(coresDir, { recursive: true, force: true });
          } catch {}
          if (fs.existsSync(coresDir)) {
            throw Object.assign(new Error(`não foi possível remover ${coresDir}`), { code: 'E_WIPE_INCOMPLETE' });
          }
        }
        apagarBlobs(deps.dataDir);
      }
      break;
    case 'view-deleted':
      fecharEmSilencio(deps.view);
      apagarBanco(path.join(deps.dataDir, 'view.db'));
      break;
    case 'manifest-deleted':
      // Sentinela ANTES de remover o único lugar onde o estado vivia.
      fs.writeFileSync(path.join(deps.dataDir, WIPE_SENTINEL), 'manifest-deleted', 'utf8');
      // **Fechar antes de apagar**, como a etapa acima já fazia com a `view`. A assimetria
      // era o defeito: um `manifest.db` aberto não é removível em Windows.
      fecharEmSilencio(deps.manifest);
      apagarBanco(deps.manifest.path);
      break;
    case 'key-wiped':
      deps.wipeIdentity();
      deps.wipeDataKey?.();
      try {
        fs.rmSync(path.join(deps.dataDir, 'keystore-accepted'), { force: true });
      } catch {}
      break;
    case 'done':
      try {
        fs.rmSync(path.join(deps.dataDir, WIPE_SENTINEL), { force: true });
      } catch {}
      deps.releaseLock?.();
      break;
    default:
      break;
  }
}

/**
 * Executa (ou retoma) a máquina inteira sobre recursos vivos. Cada etapa grava o próprio
 * nome ANTES de agir: um crash em qualquer ponto deixa o próximo boot exatamente um passo
 * atrás. Falha nomeada carrega a etapa (`E_WIPE_INCOMPLETE{stage}`).
 */
export async function executeWipe(deps: WipeResourceDeps): Promise<WipeOutcome> {
  // A etapa corrente é rastreada AQUI, e não relida do banco no `catch`: a partir de
  // `manifest-deleted` o banco está fechado e apagado, e perguntar a ele qual etapa falhou
  // lançaria dentro do próprio tratamento de erro.
  let etapaCorrente: WipeStage = 'requested';
  try {
    const corrente = deps.manifest.getWipeState() as WipeStage;
    const inicio = corrente === 'none' ? 0 : Math.max(0, STAGES.indexOf(corrente));
    for (let i = inicio; i < STAGES.length; i++) {
      const etapa = STAGES[i] as WipeStage;
      etapaCorrente = etapa;
      // FULL antes da etapa — exceto quando já não há mais banco onde gravar.
      if (etapa !== 'manifest-deleted' && etapa !== 'key-wiped' && etapa !== 'done') {
        deps.manifest.setWipeState(etapa);
      }
      await executarEtapa(etapa, deps);
    }
    return { ok: true };
  } catch {
    return { ok: false, code: 'E_WIPE_INCOMPLETE', stage: etapaCorrente };
  }
}

/**
 * §3.3/§18.6 — chamado PELO SHELL no boot, antes de abrir qualquer banco: se a limpeza
 * ficou pela metade, termina aqui. Depois de `manifest-deleted` o estado mora no sentinela
 * e os bancos nem reabrem; antes disso, retoma pelo banco ainda abrível. Devolve `true`
 * quando havia limpeza pendente (o boot segue com instalação zerada).
 */
export async function resumePendingWipe(
  deps: {
    readonly dataDir: string;
    readonly swarm: Pick<Swarm, 'listTopics' | 'leave' | 'flush'>;
    /** Abre o manifest.db existente, se houver e for abrível. */
    openManifest(): ManifestDb | null;
    /** Abre a view.db existente, se houver e for abrível. */
    openView(): ViewDb | null;
    wipeIdentity(): void;
    wipeDataKey?(): void;
  },
): Promise<boolean> {
  const sentinela = path.join(deps.dataDir, WIPE_SENTINEL);
  let temSentinela = false;
  try {
    temSentinela = fs.existsSync(sentinela);
  } catch {}

  const manifest = temSentinela ? null : deps.openManifest();
  const estado = manifest?.getWipeState() ?? 'none';
  if (!temSentinela && estado === 'none') return false;

  // Sentinela presente: chegamos ao menos ao `manifest-deleted`. Bancos vão embora (se
  // sobreviveram a um crash entre sentinela e rm) e a máquina termina sem eles.
  //
  // O LOCK **não** é liberado em nenhum dos dois ramos daqui para baixo (§18.6 emendado): o
  // boot continua depois desta função, para abrir os bancos de uma instalação zerada, e
  // §10.8 exige a etapa (2) em mãos antes da etapa (4). Soltar aqui deixava o núcleo rodando
  // a sessão inteira sem exclusão nenhuma.
  if (temSentinela) {
    apagarBanco(path.join(deps.dataDir, 'view.db'));
    apagarBanco(path.join(deps.dataDir, 'manifest.db'));
    try {
      await fs.promises.rm(path.join(deps.dataDir, 'cores'), { recursive: true, force: true });
    } catch {}
    apagarBlobs(deps.dataDir);
    deps.wipeIdentity();
    deps.wipeDataKey?.();
    try {
      fs.rmSync(path.join(deps.dataDir, 'keystore-accepted'), { force: true });
    } catch {}
    try {
      fs.rmSync(sentinela, { force: true });
    } catch {}
    return true;
  }

  // Antes do `manifest-deleted`: retoma com os bancos ainda abríveis. Runtime não existe
  // neste ponto do boot — fechar de novo é no-op por construção. A view só reabre quando
  // ainda há etapa que a toque; depois de `view-deleted`, no-op.
  const PRECISA_VIEW: readonly string[] = ['requested', 'swarm-down', 'cores-closed', 'view-deleted'];
  const view = PRECISA_VIEW.includes(estado) ? deps.openView() : null;
  const r = await executeWipe({
    dataDir: deps.dataDir,
    swarm: deps.swarm,
    closeRuntime: async () => {},
    view: (view ?? { close() {} }) as ViewDb,
    manifest: manifest as ManifestDb,
    wipeIdentity: deps.wipeIdentity,
    ...(deps.wipeDataKey !== undefined ? { wipeDataKey: deps.wipeDataKey } : {}),
  });
  // A retomada que não termina não pode ser reportada como instalação zerada: o boot
  // seguiria abrindo um `manifest.db` que ainda tem `communities.core_key` e
  // `invite_secrets.secret` dentro, achando que acabou de limpar tudo.
  if (!r.ok) {
    throw Object.assign(new Error(`limpeza pendente não pôde ser concluída (${r.stage})`), {
      code: 'E_WIPE_INCOMPLETE',
      stage: r.stage,
    });
  }
  return true;
}
