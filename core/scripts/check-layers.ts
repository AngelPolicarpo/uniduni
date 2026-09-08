/**
 * Fronteira de camadas de `backend-v2.md` §4, verificada por diretório.
 *
 * §4: "Quatro camadas. Uma camada só importa das camadas abaixo. Importação lateral só onde
 * a tabela declarar. Violação **quebra o build** (regra de lint com fronteira por
 * diretório)." Este script é essa regra. Ele roda no `npm run build` e sai != 0 na primeira
 * violação.
 *
 * O registro abaixo é transcrição da tabela de §4 — módulo, camada e a coluna "Depende de".
 * Não é interpretação: quando a tabela diz `L2`, o valor é `L2`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LAYERS = ['l0', 'l1', 'l2', 'l3'] as const;
type Layer = (typeof LAYERS)[number];

/** `L0` abaixo de `L1` abaixo de `L2` abaixo de `L3`. */
const rank: Record<Layer, number> = { l0: 0, l1: 1, l2: 2, l3: 3 };

type Dep = string | Layer;

type Module = {
  readonly layer: Layer;
  /** Coluna "Depende de" de §4. `[]` é o travessão da tabela. */
  readonly deps: readonly Dep[];
  /**
   * Módulo de L3 cuja **porta** este módulo de L2 declara e recebe por injeção (§4,
   * "Quando L2 precisa falar rede"). A direção real é L3 → L2: importar o módulo de L3
   * daqui fecharia o ciclo, e continua sendo violação — com mensagem própria, porque o
   * erro provável é confundir "usa o transporte" com "importa o transporte".
   */
  readonly portaImplementadaPor?: readonly string[];
};

const REGISTRY: Record<string, Module> = {
  // ── L0 infra ────────────────────────────────────────────────────────────────────────
  config: { layer: 'l0', deps: [] },
  clock: { layer: 'l0', deps: [] },
  logger: { layer: 'l0', deps: ['config'] },
  metrics: { layer: 'l0', deps: ['clock'] },
  keystore: { layer: 'l0', deps: [] },
  // §10.2: `manifest.secrets` guarda `data_key` e `identity_seed` (§5.4); `identity` cifra a
  // semente com a Data Key e persiste via `manifest`. É lateral L0→L0 declarada, como
  // `projector→opCodec` para `op_version`.
  identity: { layer: 'l0', deps: ['keystore', 'manifest'] },
  manifest: { layer: 'l0', deps: ['config'] },
  view: { layer: 'l0', deps: ['config'] },
  corestore: { layer: 'l0', deps: ['config', 'manifest'] },
  swarm: { layer: 'l0', deps: ['config'] },

  // ── L1 domínio ──────────────────────────────────────────────────────────────────────
  errors: { layer: 'l1', deps: [] },
  opCodec: { layer: 'l1', deps: [] },
  idgen: { layer: 'l1', deps: [] },
  permissions: { layer: 'l1', deps: [] },
  fold: { layer: 'l1', deps: ['opCodec', 'permissions', 'idgen', 'errors'] },
  // §31 (emenda de 2026-09-01) — a conversa direta. `dmCodec` e `dmFold` são **irmãos** de
  // `opCodec` e `fold`, não extensões deles: registro, registry e versão próprios (§31.0,
  // §31.4). A coluna "Depende de" de `dmCodec` é vazia, como a de `opCodec`, e a de `dmFold`
  // é exatamente `dmCodec, idgen, errors` — sem `fold`, sem `permissions` (não há permissão
  // numa conversa de dois, §31.7.3) e sem `outbox` (não existe, §31.10).
  dmCodec: { layer: 'l1', deps: [] },
  dmFold: { layer: 'l1', deps: ['dmCodec', 'idgen', 'errors'] },
  // `opCodec` entrou em §4 para dar escritor a `meta.op_version` (§10.3.1): a constante mora
  // em L1 e `view` (L0) não pode importá-la. Só a constante — decodificar registro é proibido.
  projector: { layer: 'l1', deps: ['fold', 'opCodec', 'view', 'corestore'] },
  // §4, linha `dmProjector` — irmão do `projector`, com a mesma forma e outra lista: `dmFold`
  // no lugar de `fold`, `dmCodec` no lugar de `opCodec`. A proibição também é a mesma, e é a
  // que importa: **decodificar registro**. O `kind` de `dm_rejected_records` chega pelo
  // `DmFoldResult` (§31.7.1), e a ordem de §31.6 é computada pelas funções do próprio
  // `dmFold` (`acksOf`, `clampAck`, `ordSumOf`, `compareOrdKey`).
  dmProjector: { layer: 'l1', deps: ['dmFold', 'dmCodec', 'view', 'corestore'] },

  // ── L2 aplicação ────────────────────────────────────────────────────────────────────
  communityHost: {
    layer: 'l2',
    deps: ['fold', 'corestore'],
    portaImplementadaPor: ['rpcServer'],
  },
  communityClient: {
    layer: 'l2',
    deps: ['swarm', 'corestore', 'projector', 'outbox'],
  },
  outbox: { layer: 'l2', deps: ['manifest'], portaImplementadaPor: ['rpcClient'] },
  invites: { layer: 'l2', deps: ['swarm', 'identity', 'communityHost', 'manifest', 'fold', 'opCodec'] },
  blobs: { layer: 'l2', deps: ['corestore', 'swarm', 'manifest'] },
  presence: { layer: 'l2', deps: ['swarm', 'clock'] },
  voiceCoordinator: { layer: 'l2', deps: ['communityHost', 'communityClient', 'permissions'] },
  shareStar: { layer: 'l2', deps: ['voiceCoordinator'] },
  relay: { layer: 'l2', deps: ['swarm', 'config'] },
  // Emenda de §27 (fase 10): reconstruir o lote estendido de §18.8 exige ler estado
  // (fold), codificar/assinar registros (opCodec), prever os ids de entidade da
  // continuação (idgen) e recriar cargos com a numeração fechada do catálogo
  // (permissions). Sem elas a sucessão não é implementável — registrado em
  // `docs/sequenciamento-pos-fase-0.md` §27.
  succession: { layer: 'l2', deps: ['corestore', 'identity', 'fold', 'opCodec', 'idgen', 'permissions'] },
  search: { layer: 'l2', deps: ['view'] },
  // §4, linha `directMessages` — o ciclo de vida da conversa direta (§31.8, §31.9, §31.13).
  // A coluna "Depende de" é transcrição literal, e as duas proibições também: **interpretar
  // registro** e **importar `rpcServer`/`rpcClient`**. Note o que a lista NÃO tem: `dmCodec`,
  // `dmFold` e `dmProjector`. Construir o `dm.hello` de gênese e montar o projetor entram por
  // **porta injetada**, como a submissão e o escrow entraram em `succession` (§27) — o mesmo
  // padrão, e pela mesma razão: emendar §4 para encurtar uma injeção é trocar a fronteira por
  // conveniência.
  directMessages: {
    layer: 'l2',
    deps: ['corestore', 'swarm', 'manifest', 'identity'],
    portaImplementadaPor: ['rpcServer', 'rpcClient'],
  },
  diagnostics: { layer: 'l2', deps: ['swarm', 'metrics'] },

  // ── L3 fronteira ────────────────────────────────────────────────────────────────────
  mediaBridge: { layer: 'l3', deps: ['swarm'] },
  rpcServer: { layer: 'l3', deps: ['l2'] },
  rpcClient: { layer: 'l3', deps: ['l2'] },
  ipcRenderer: { layer: 'l3', deps: ['l2'] },
  ipcMain: { layer: 'l3', deps: ['l2'] },
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'src');

/**
 * A **raiz de composição** de §4 (emenda de 2026-08-22): `src/composition/`, fora da pilha
 * de camadas. Ela pode importar qualquer módulo — é a definição de "quem monta o grafo" —, e
 * **nenhum** módulo de camada (`src/l0` … `src/l3`) pode importá-la. Essa segunda metade é a regra que este
 * script acrescenta: sem ela, um módulo de camada poderia pegar uma implementação pronta da
 * raiz e a injeção de §4 viraria acoplamento com passo extra.
 */
const COMPOSITION = 'composition';

type Violation = { file: string; line: number; text: string; why: string };

function isLayer(v: string): v is Layer {
  return (LAYERS as readonly string[]).includes(v);
}

/** `src/l1/fold/admission.ts` → `{ layer: 'l1', module: 'fold' }`. */
function locate(file: string): { layer: Layer; module: string } | null {
  const rel = path.relative(SRC, file).split(path.sep);
  const [layer, module] = rel;
  if (layer === undefined || module === undefined || !isLayer(layer)) return null;
  return { layer, module };
}

/** `src/composition/boot.ts` → true. A raiz de composição não tem camada. */
function isComposition(file: string): boolean {
  return path.relative(SRC, file).split(path.sep)[0] === COMPOSITION;
}

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return e.isFile() && p.endsWith('.ts') ? [p] : [];
  });
}

const SPECIFIER = /(?:^|[\s;(])(?:import|export)\b(?:(?!import|export)[^;])*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]/g;

function violationsIn(file: string): Violation[] {
  const here = locate(file);
  if (here === null) return [];
  const spec = REGISTRY[here.module];
  const out: Violation[] = [];

  if (spec === undefined) {
    return [
      {
        file,
        line: 1,
        text: here.module,
        why: `módulo fora da tabela de §4 — todo diretório sob src/${here.layer}/ precisa estar no registro`,
      },
    ];
  }
  if (spec.layer !== here.layer) {
    return [
      {
        file,
        line: 1,
        text: here.module,
        why: `§4 põe \`${here.module}\` em ${spec.layer.toUpperCase()}, mas o arquivo está em src/${here.layer}/`,
      },
    ];
  }

  const content = fs.readFileSync(file, 'utf8');
  for (const m of content.matchAll(SPECIFIER)) {
    const raw = m[1] ?? m[2] ?? m[3];
    if (raw === undefined || !raw.startsWith('.')) continue; // externo: não é fronteira de §4

    const line = content.slice(0, m.index).split('\n').length;
    const resolvido = path.resolve(path.dirname(file), raw);
    if (isComposition(resolvido)) {
      out.push({
        file,
        line,
        text: raw,
        why:
          'a raiz de composição (`src/composition/`) monta o grafo e injeta as ' +
          'implementações — nenhum módulo de camada pode importá-la. A direção é sempre ' +
          'composição → módulo; o contrário transformaria a injeção de §4 em acoplamento',
      });
      continue;
    }
    const target = locate(resolvido);
    if (target === null) continue;
    if (target.layer === here.layer && target.module === here.module) continue; // interno

    const why = check(spec, here, target);
    if (why !== null) out.push({ file, line, text: raw, why });
  }
  return out;
}

function check(
  spec: Module,
  here: { layer: Layer; module: string },
  target: { layer: Layer; module: string },
): string | null {
  if (rank[target.layer] > rank[here.layer]) {
    if (spec.portaImplementadaPor?.includes(target.module)) {
      return (
        `\`${here.module}\` usa o transporte de \`${target.module}\`, mas não o importa: §4 ` +
        `manda \`${here.module}\` declarar a **porta** e \`${target.module}\` ` +
        `(${target.layer.toUpperCase()}) implementá-la, com a implementação injetada no boot. ` +
        `A direção é sempre L3 → L2; importar daqui fecharia o ciclo`
      );
    }
    return `${here.layer.toUpperCase()} não importa de ${target.layer.toUpperCase()} — §4 só permite camada abaixo`;
  }

  const declared =
    spec.deps.includes(target.module) || spec.deps.some((d) => isLayer(d) && d === target.layer);
  if (declared) return null;

  return target.layer === here.layer
    ? `importação lateral não declarada: §4 não lista \`${target.module}\` em "Depende de" de \`${here.module}\``
    : `§4 não lista \`${target.module}\` em "Depende de" de \`${here.module}\``;
}

const files = walk(SRC);
const composicao = files.filter(isComposition);
const violations = files.flatMap(violationsIn);

if (violations.length > 0) {
  for (const v of violations) {
    process.stderr.write(`${path.relative(ROOT, v.file)}:${v.line}  ${v.text}\n    ${v.why}\n`);
  }
  process.stderr.write(`\n§4 — ${violations.length} violação(ões) de fronteira de camada\n`);
  process.exit(1);
}

const byLayer = LAYERS.map((l) => {
  const n = new Set(files.map(locate).filter((x) => x?.layer === l).map((x) => x!.module)).size;
  return `${l.toUpperCase()}:${n}`;
}).join(' ');
process.stdout.write(
  `§4 ok — ${files.length} arquivo(s), módulos por camada ${byLayer}` +
    ` + raiz de composição (${composicao.length} arquivo(s))\n`,
);
