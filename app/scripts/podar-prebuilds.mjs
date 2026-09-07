// Remove binários nativos pré-compilados (prebuilds) fora da matriz do v1 (A16: apenas Windows x64 e Linux x64 glibc >= 2.31).
// Poda Mobile (Android/iOS), macOS (Darwin), ARM64 e Linux musl.
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const raizApp = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function isForaDoEscopo(nome) {
  return /android|ios|darwin|osx|macos|arm64|linuxmusl|ia32/i.test(nome);
}

function podarDiretorio(dir) {
  if (!existsSync(dir)) return 0;
  let removidos = 0;
  let bytesEconomizados = 0;

  function obterTamanho(p) {
    try {
      const s = statSync(p);
      if (!s.isDirectory()) return s.size;
      let t = 0;
      for (const f of readdirSync(p)) t += obterTamanho(path.join(p, f));
      return t;
    } catch {
      return 0;
    }
  }

  function varrer(d) {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "prebuilds") {
          for (const sub of readdirSync(full, { withFileTypes: true })) {
            if (isForaDoEscopo(sub.name)) {
              const sz = obterTamanho(path.join(full, sub.name));
              rmSync(path.join(full, sub.name), { recursive: true, force: true });
              removidos++;
              bytesEconomizados += sz;
            }
          }
        } else if (ent.name === "deps" && d.endsWith("better-sqlite3")) {
          const sz = obterTamanho(full);
          rmSync(full, { recursive: true, force: true });
          removidos++;
          bytesEconomizados += sz;
        } else {
          varrer(full);
        }
      }
    }
  }

  varrer(dir);
  const mb = (bytesEconomizados / 1024 / 1024).toFixed(1);
  console.log(`[podar] ${dir}: ${removidos} itens fora do escopo podados (~${mb} MB liberados)`);
  return bytesEconomizados;
}

export function podarPrebuilds() {
  const nodeModulesApp = path.resolve(raizApp, "node_modules");
  const nodeModulesCore = path.resolve(raizApp, "../core/node_modules");

  podarDiretorio(nodeModulesApp);
  podarDiretorio(nodeModulesCore);
}

// Se chamado diretamente via CLI
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  podarPrebuilds();
}
