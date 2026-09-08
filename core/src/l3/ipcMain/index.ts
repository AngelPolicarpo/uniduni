// `ipcMain` — L3, fronteira de controle e canal IPC-M com o processo main (§4, §3.1, §3.2, §3.5, §15.3, §15.7).
//
// §4: depende de L2.
// §4: NUNCA contém regra de negócio de domínio.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

// `fs-native-extensions` fornece `flock`/`LockFileEx` reais (§10.8, A16).
// No Windows `LockFileEx` é obrigatório; `ftruncate` em fd `a+` falha com EPERM.
// O piso portátil é `O_RDWR|O_CREAT` + `tryLock` — medido em G10 §3.1.2 (win32-x64 9/10 reprovados).
//
// O carregador é `createRequire(import.meta.url)`, e não um `require` nu: este módulo é
// **ESM** (`core/package.json` declara `type: module` e o `tsc` emite `import`), então
// `require` não existe no escopo e a chamada nua lançava `ReferenceError` sempre. O `catch`
// a engolia e todo `acquire()` caía no ramo de comparação de PID — que não é exclusão
// nenhuma (§10.8 emendado): três processos simultâneos adquiriam o mesmo LOCK. O engano
// passou despercebido porque `node -e` define `require` no objeto global, então qualquer
// verificação feita por `-e` dá falso negativo; um arquivo `.mjs`/`.cjs` de verdade não dá.
type FsExt = {
  tryLock?: (fd: number) => boolean;
  tryLockSync?: (fd: number) => boolean;
  unlock?: (fd: number) => void;
  unlockSync?: (fd: number) => void;
};
let fsext: FsExt | null = null;
let motivoSemFsext = '';
try {
  fsext = createRequire(import.meta.url)('fs-native-extensions') as FsExt;
} catch (err) {
  fsext = null;
  motivoSemFsext = (err as Error).message;
}

/** O `tryLock` que existir nesta build do addon — a API expõe `tryLock` síncrono. */
function tentarTravar(): ((fd: number) => boolean) | null {
  if (fsext === null) return null;
  return fsext.tryLockSync ?? fsext.tryLock ?? null;
}

function destravar(fd: number): void {
  const unlock = fsext?.unlockSync ?? fsext?.unlock;
  if (unlock === undefined) return;
  try {
    unlock(fd);
  } catch {}
}

/**
 * §10.8 emendado — o `flock`/`LockFileEx` está disponível? Exposto para o shell poder dizer
 * ao usuário o que faltou (addon sem rebuild para esta versão de Electron, A16) em vez de
 * subir sem exclusão nenhuma.
 */
export function lockNativoDisponivel(): { ok: boolean; motivo: string } {
  if (tentarTravar() !== null) return { ok: true, motivo: '' };
  return { ok: false, motivo: motivoSemFsext || 'fs-native-extensions sem tryLock' };
}

// ── §15.3 — a tabela fechada dos comandos `main-confirmed` ────────────────────────────
//
// Emenda de 2026-09-05 em §15.3. Três coisas moram aqui porque as três são a MESMA decisão,
// e separá-las foi o que deixou a classe sem efeito: o que a caixa nativa diz (o main lê
// daqui, nunca do renderer), quais nomes podem virar token (fora da tabela → sem diálogo) e
// qual campo do argumento é o ALVO ao qual o token se liga.
//
// O escopo é derivado pela MESMA função nos dois lados — o renderer para pedir, o núcleo
// para consumir —, e é isso que faz um token de `community.end` da comunidade A não
// encerrar a B. Nenhum escopo carrega segredo: `identity.export` tem escopo `null` porque o
// endereço da ação não é a `passphrase`.

export type ComandoConfirmado = {
  readonly cmd: string;
  /** Campo do argumento que identifica o alvo; `null` quando a ação não tem alvo. */
  readonly escopo: string | null;
  /** `message` do `dialog.showMessageBox`. */
  readonly titulo: string;
  /** `detail` do `dialog.showMessageBox`. */
  readonly detalhe: string;
  /** Rótulo do botão destrutivo. */
  readonly botao: string;
};

export const COMANDOS_CONFIRMADOS: readonly ComandoConfirmado[] = [
  {
    cmd: 'identity.wipe',
    escopo: null,
    titulo: 'Apagar esta instalação?',
    detalhe: 'Identidade, comunidades e mensagens locais são removidas desta máquina. Não há desfazer.',
    botao: 'Apagar tudo',
  },
  {
    cmd: 'identity.export',
    escopo: null,
    titulo: 'Exportar a identidade?',
    detalhe: 'Grava um backup cifrado pela frase secreta que você digitou. Quem tiver o arquivo e a frase tem a sua identidade.',
    botao: 'Exportar',
  },
  {
    cmd: 'identity.import',
    escopo: null,
    titulo: 'Restaurar identidade de um backup?',
    detalhe: 'Substitui o estado local desta instalação pelo backup escolhido.',
    botao: 'Restaurar',
  },
  {
    cmd: 'community.end',
    escopo: 'communityId',
    titulo: 'Encerrar a comunidade?',
    detalhe: 'Quem está conectado cai, e a comunidade deixa de existir para todos os membros.',
    botao: 'Encerrar',
  },
  {
    cmd: 'community.forget',
    escopo: 'communityId',
    titulo: 'Esquecer esta comunidade?',
    detalhe: 'A réplica local é apagada desta máquina. A comunidade continua existindo para os outros.',
    botao: 'Esquecer',
  },
  {
    cmd: 'community.assumeHost',
    escopo: 'communityId',
    titulo: 'Assumir a hospedagem?',
    detalhe: 'Cria a continuação da comunidade sob esta máquina; os membros precisam reentrar.',
    botao: 'Assumir',
  },
  {
    cmd: 'core.reproject',
    escopo: 'communityId',
    titulo: 'Reprojetar o estado?',
    detalhe: 'O núcleo congela enquanto reabre o estado a partir do log. Nada é perdido.',
    botao: 'Reprojetar',
  },
  {
    cmd: 'blob.reveal',
    escopo: 'blobId',
    titulo: 'Abrir este arquivo compactado?',
    detalhe: 'O arquivo será aberto pelo aplicativo que o sistema associar a ele.',
    botao: 'Abrir',
  },
  {
    cmd: 'dm.forget',
    escopo: 'conversationId',
    titulo: 'Esquecer esta conversa?',
    detalhe: 'As mensagens locais desta conversa são apagadas desta máquina.',
    botao: 'Esquecer',
  },
];

const POR_COMANDO = new Map(COMANDOS_CONFIRMADOS.map((c) => [c.cmd, c]));

/** A linha da tabela de §15.3, ou `null` para nome que não pertence à classe. */
export function comandoConfirmado(cmd: string): ComandoConfirmado | null {
  return POR_COMANDO.get(cmd) ?? null;
}

/**
 * Serialização **canônica** de um valor de escopo: chaves ordenadas, para que dois lados que
 * receberam o mesmo objeto produzam a mesma string sem depender da ordem de inserção.
 *
 * Existe porque nem todo alvo é uma string: o `blobId` de `blob.reveal` é
 * `{byteOffset, blockOffset, blockLength, byteLength}` (§13.2). Exigir string ali faria o
 * escopo daquele comando ser sempre `null` — uma ligação vazia, que passaria despercebida
 * justamente por ser consistente nos dois lados.
 */
export function canonicalizarEscopo(v: unknown): string | null {
  if (typeof v === 'string') return v.length > 0 ? v : null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === null || typeof v !== 'object') return null;
  if (Array.isArray(v)) return `[${v.map((x) => canonicalizarEscopo(x) ?? '').join(',')}]`;
  const entradas = Object.entries(v as Record<string, unknown>)
    .filter(([, valor]) => valor !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([chave, valor]) => `${chave}:${canonicalizarEscopo(valor) ?? ''}`);
  return entradas.length > 0 ? `{${entradas.join(',')}}` : null;
}

/**
 * §15.3 emendado — o alvo ao qual o token se liga, derivado do argumento. `null` tanto para
 * a ação sem alvo quanto para o campo ausente (`core.reproject` sem `communityId` é "todas"),
 * e os dois lados derivam pela mesma função: o que não bate, não consome.
 */
export function escopoDeConfirmacao(cmd: string, arg: unknown): string | null {
  const linha = comandoConfirmado(cmd);
  if (linha === null || linha.escopo === null) return null;
  return canonicalizarEscopo((arg as Record<string, unknown> | null | undefined)?.[linha.escopo]);
}

export const WIPE_STAGES = [
  'none',
  'requested',
  'swarm-down',
  'cores-closed',
  'view-deleted',
  'manifest-deleted',
  'key-wiped',
  'done',
] as const;

export type WipeStage = (typeof WIPE_STAGES)[number];

// A gramática de deep link de §3.5 vive em `app/src/main/deeplink.ts`, junto de quem a usa:
// quem recebe `argv` e `open-url` é o processo main. A cópia que morava aqui não tinha
// consumidor nenhum fora do teste e já havia divergido do produto (faltava a rota
// `u/<KEY64>` da emenda B64) — uma gramática fechada testada numa implementação que ninguém
// executa é pior que nenhuma, porque parece cobertura.

/**
 * §15.3 — o token de confirmação nativa. Uso único, TTL de 60 s, ligado ao par
 * `(cmd, escopo)` da emenda de 2026-09-05: um token de `community.end` da comunidade A não
 * encerra a B, porque o escopo é derivado do argumento REAL pelos dois lados.
 */
export class AuthTokenStore {
  readonly #tokens = new Map<
    string,
    { cmd: string; escopo: string | null; expiresAt: number }
  >();

  issue(cmd: string, escopo: string | null = null, ttlMs = 60_000): string {
    // A poda entra aqui porque `consume` só alcança o token que alguém tenta usar: o
    // diálogo cancelado depois da emissão deixava a entrada viva até o fim do processo.
    this.prune();
    const token = crypto.randomBytes(32).toString('hex');
    this.#tokens.set(token, { cmd, escopo, expiresAt: Date.now() + ttlMs });
    return token;
  }

  consume(token: string, cmd: string, escopo: string | null = null): boolean {
    const entry = this.#tokens.get(token);
    if (entry === undefined) return false;
    // Apaga ANTES de julgar: token apresentado é token gasto, mesmo que o julgamento recuse.
    this.#tokens.delete(token);
    if (Date.now() > entry.expiresAt) return false;
    return entry.cmd === cmd && entry.escopo === escopo;
  }

  prune(): void {
    const now = Date.now();
    for (const [t, entry] of this.#tokens.entries()) {
      if (now > entry.expiresAt) this.#tokens.delete(t);
    }
  }
}

export class ProcessLock {
  readonly #dataDir: string;
  #lockFd: number | null = null;

  constructor(dataDir: string) {
    this.#dataDir = dataDir;
  }

  get isLocked(): boolean {
    return this.#lockFd !== null;
  }

  /** `install_id` persistido — distingue reinstalações no mesmo diretório (§10.8). */
  #installId(): string {
    const file = path.join(this.#dataDir, 'install-id');
    try {
      const existing = fs.readFileSync(file, 'utf8').trim();
      if (existing.length > 0) return existing;
    } catch {}
    const buf = crypto.randomBytes(16);
    const id = buf.toString('hex');
    try {
      fs.mkdirSync(this.#dataDir, { recursive: true });
      fs.writeFileSync(file, id, 'utf8');
    } catch {}
    return id;
  }

  #readOwner(lockPath: string): { pid?: number; install_id?: string; installId?: string } | null {
    try {
      const txt = fs.readFileSync(lockPath, 'utf8').trim();
      if (!txt) return null;
      return JSON.parse(txt) as { pid?: number; install_id?: string; installId?: string };
    } catch {
      return null;
    }
  }

  acquire(): void {
    // §10.8 emendado — sem `flock`/`LockFileEx` não há etapa (2). Comparar o PID gravado no
    // arquivo NÃO substitui a exclusão do SO: entre ler e escrever cabem duas instâncias
    // inteiras, que é exatamente a corrida que a etapa fecha. Recusar abrir é o único
    // desfecho honesto — subir sem exclusão deixa dois núcleos sobre o mesmo RocksDB.
    const tryLock = tentarTravar();
    if (tryLock === null) {
      throw Object.assign(
        new Error(
          `Lock exclusivo indisponível nesta build (${lockNativoDisponivel().motivo}). ` +
            'O núcleo não abre sem a exclusão de §10.8.',
        ),
        { code: 'E_CORE_LOCK_UNAVAILABLE' },
      );
    }
    fs.mkdirSync(this.#dataDir, { recursive: true });
    const lockPath = path.join(this.#dataDir, 'LOCK');
    // §10.8 / G10 §3.1.2: O_RDWR|O_CREAT é o único modo portátil.
    // `a+` recusa ftruncate no Windows (EPERM); `w+` truncaria antes do tryLock e apagaria
    // o PID do dono legítimo quando o lock está ocupado.
    const fd = fs.openSync(lockPath, fs.constants.O_RDWR | fs.constants.O_CREAT, 0o600);
    let travado = false;
    try {
      try {
        travado = tryLock(fd) === true;
      } catch {
        travado = false;
      }
      if (!travado) {
        // O PID e o `install_id` do arquivo servem para NOMEAR o dono na mensagem — nunca
        // para decidir se o lock está livre; quem decidiu foi o `tryLock` acima.
        const owner = this.#readOwner(lockPath);
        throw Object.assign(
          new Error(`Diretório já em uso pelo processo ${owner?.pid ?? 'desconhecido'}`),
          { code: 'E_CORE_ALREADY_RUNNING', pid: owner?.pid },
        );
      }

      // Somente com o lock em mãos podemos truncar e escrever.
      // Detecta órfão: se o arquivo continha PID morto ou install_id diferente (sem release limpo), log lock.stolen.
      const prevOwner = this.#readOwner(lockPath);
      if (
        prevOwner !== null &&
        !(prevOwner as { released?: boolean }).released &&
        typeof prevOwner.pid === 'number' &&
        prevOwner.pid !== process.pid
      ) {
        const alive = this.#isPidAlive(prevOwner.pid);
        const curId = this.#installId();
        const prevId = (prevOwner.install_id ?? prevOwner.installId) as string | undefined;
        if (!alive || (prevId !== undefined && prevId !== curId)) {
          // lock órfão quebrado automaticamente — §10.8 exige log lock.stolen
          try {
            // não há logger aqui (L0→L3 sem dependência); usa stderr para auditoria
            process.stderr.write(`lock.stolen ${JSON.stringify({ prevPid: prevOwner.pid, prevInstallId: prevId, curInstallId: curId })}\n`);
          } catch {}
        }
      }

      const installId = this.#installId();
      fs.ftruncateSync(fd, 0);
      fs.writeSync(
        fd,
        JSON.stringify({
          pid: process.pid,
          install_id: installId,
          installId,
          time: Date.now(),
        }),
        0,
      );
      try {
        fs.fsyncSync(fd);
      } catch {}
      this.#lockFd = fd;
    } catch (err) {
      // Só destrava o que ESTE `acquire` travou: chamar `unlock` num fd cujo `tryLock`
      // falhou soltaria nada aqui, mas a assimetria é o tipo de coisa que volta como bug.
      if (travado) destravar(fd);
      try {
        fs.closeSync(fd);
      } catch {}
      throw err;
    }
  }

  release(): void {
    if (this.#lockFd !== null) {
      try {
        fs.ftruncateSync(this.#lockFd, 0);
        fs.writeSync(
          this.#lockFd,
          JSON.stringify({
            pid: process.pid,
            install_id: this.#installId(),
            released: true,
            time: Date.now(),
          }),
          0,
        );
        fs.fsyncSync(this.#lockFd);
      } catch {}
      destravar(this.#lockFd);
      try {
        fs.closeSync(this.#lockFd);
      } catch {}
      this.#lockFd = null;
    }
  }

  #isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
