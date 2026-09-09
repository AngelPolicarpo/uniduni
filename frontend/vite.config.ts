import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  // O renderer é carregado por `loadFile` a partir de `frontend/dist/index.html` (§3.1):
  // em `file://` os caminhos absolutos do default (`/assets/...`) apontam para a raiz do
  // disco. Base relativa é o que faz o bundle carregar dentro do shell.
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    // Cinco dos seis efeitos sonoros cabem no teto de 4 KB do default e virariam `data:`
    // dentro do bundle. Duas razões para não deixar: §25.4 regra 4 manda a CSP sem host
    // externo, e uma CSP com `media-src 'self'` — a forma óbvia de escrevê-la — recusaria
    // `data:` sem um erro visível; e um áudio embutido em base64 no JS não é cacheável
    // como arquivo. Áudio sai sempre como arquivo; o resto mantém o default.
    assetsInlineLimit: (arquivo: string) => (/\.(mp3|ogg|wav)$/.test(arquivo) ? false : undefined),
  },
})
