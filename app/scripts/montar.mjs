// Monta os recursos que o pacote leva DENTRO do app.asar (§3.1):
//   dist/renderer/**  ← frontend/dist   (o main procura ../renderer/index.html)
//   dist/core/**      ← core/dist       (o utility procura ../core)
// Rodar depois dos builds do frontend e do core; quem chama é o script `dist`.
import { cpSync, existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { podarPrebuilds } from "./podar-prebuilds.mjs";

const raizApp = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function copiar(de, para, rotulo) {
  const origem = path.resolve(raizApp, de);
  const destino = path.resolve(raizApp, para);
  if (!existsSync(origem)) {
    console.error(`[montar] ${rotulo}: origem ausente — ${origem}`);
    process.exit(1);
  }
  rmSync(destino, { recursive: true, force: true });
  cpSync(origem, destino, { recursive: true });
  const mb = (statSync(destino).size / 1024 / 1024).toFixed(1);
  console.log(`[montar] ${rotulo}: ${para} (${mb} MB)`);
}

copiar("../frontend/dist", "dist/renderer", "renderer");
copiar("../core/dist", "dist/core", "core");

// O núcleo é ESM (`core/package.json` declara `type: module`), mas o app é CJS. Fora do
// lugar de origem, o Node decide o tipo pelo `package.json` mais próximo subindo a árvore
// — e de `dist/core/**` o primeiro que aparece é o do app, que diz `commonjs`. Sem este
// marcador o núcleo empacotado é lido como CJS e o boot morre no primeiro `import`
// ("Cannot use import statement outside a module", E_BOOT). Em dev não acontece: lá o
// utility carrega de `core/dist`, com o `package.json` certo logo acima.
const marcador = path.resolve(raizApp, "dist/core/package.json");
writeFileSync(marcador, `${JSON.stringify({ type: "module" }, null, 2)}\n`);
console.log("[montar] core: dist/core/package.json (type: module)");

// Poda prebuilds fora da matriz (mobile, macOS, arm64) antes do empacotamento
podarPrebuilds();

