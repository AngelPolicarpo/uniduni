# Uniduni

Uniduni é uma comunidade P2P de voz, vídeo e tela — sem servidor central. Cada comunidade é hospedada
pela máquina de quem a criou.

## Sumário

- [Sobre](#sobre)
- [Funcionalidades principais](#funcionalidades-principais)
- [Instalação / quick start](#instalação--quick-start)
- [Uso](#uso)
- [Documentação](#documentação)
- [Configuração](#configuração)
- [Contribuindo](#contribuindo)
- [Licença](#licença)

## Sobre

Uniduni é um app de comunidade em voz, vídeo e compartilhamento de tela, no formato de
servidores/canais, mas sem backend central: os dados moram na máquina de quem hospeda a
comunidade e são descobertos por DHT, não por um servidor de terceiros.

Todas as fases do v1 estão implementadas (`docs/backend-v2.md` §29, emenda de 2026-09-04).
`core/` é o núcleo determinístico do estado da comunidade **e** a camada de rede —
`Hyperswarm`/`Hypercore`/`corestore` vivem em `core/src/l0/swarm/`, `corestore/`, e o
`utilityProcess` de `app/` liga o `HyperswarmBackend` real à DHT. `frontend/` é o renderer de
produto: lê todo o dado do núcleo pela IPC-R e é onde mora a mídia P2P (malha de voz e estrela
de tela em WebRTC, §17.2/§17.5). `backend/` é um diretório vazio do layout antigo — a camada
P2P **não** foi construída ali. Consulte [`docs/backlog.md`](docs/backlog.md) para o que
continua aberto.

## Funcionalidades principais

O que a arquitetura normativa (`docs/backend-v2.md`) define para o produto:

- Comunidades hospedadas pela máquina de quem as cria, sem servidor central.
- Estado da comunidade como `fold(log)` — função pura, total e determinística sobre um log
  append-only.
- Voz em malha P2P direta entre participantes.
- Compartilhamento de tela via WebRTC em estrela, com degradação medida sob carga (§17.5).
- Sem teto artificial de ocupação — nem de voz, nem de câmeras, nem de espectadores de tela
  (§90); o limite real é a máquina do host.
- Shell Electron com fronteiras de processo explícitas (main / `utilityProcess` / renderer).

Partes marcadas `REQUIRES POC` ou `BENCHMARK REQUIRED` na especificação só entram em
produto depois de evidência experimental — ver [`poc/`](poc/) e
[`docs/plano-de-validacao-experimental-v2.md`](docs/plano-de-validacao-experimental-v2.md).

## Instalação / quick start

Requer Node.js ≥ 22. O repositório é um monorepo sem workspace raiz — cada pacote
(`core/`, `frontend/`, `app/`) tem seu próprio `package.json`.

```bash
# núcleo (fold, projector, permissions, outbox...)
cd core
npm install
npm run build
npm test

# renderer de produto (Vite + React) — IPC-R e a mídia WebRTC
cd ../frontend
npm install
npm run build

# shell Electron — carrega frontend/dist e core/dist diretamente em dev
cd ../app
npm install
npm run dev
```

Os três comandos de build acima foram executados neste repositório antes desta seção ser
escrita.

## Uso

`app` é o produto (Electron: main + `utilityProcess` + renderer). `npm run dev` em `app/`
abre o shell com a interface de `frontend/` e o núcleo de `core/` rodando como
`utilityProcess`, com o swarm ligado à DHT. É uma comunidade efetivamente distribuída: o
produto empacotado para Windows e Linux foi exercitado com outros usuários, em uso normal
(`docs/sequenciamento-pos-fase-0.md` §123), e é essa evidência que fechou as fases 3, 7, 8 e
10. O que ela **não** mediu está declarado em §123.2 (`tc/netem`, CGNAT real e a garantia
reproduzível do piso de glibc).

Para rodar só o núcleo, sem Electron:

```bash
cd core
npm test          # build + suíte unitária/projeção/fronteira
npm run typecheck
```

Para empacotar (Windows x64 / Linux x64, glibc ≥ 2.31 — únicos alvos do v1):

```bash
cd app
npm run montar        # copia frontend/dist e core/dist para dentro do pacote
npm run dist:win       # ou dist:linux
```

## Documentação

A especificação normativa vive em [`docs/`](docs/), com precedência definida em
[`CLAUDE.md`](CLAUDE.md#source-of-truth):

1. [`docs/backend-v2.md`](docs/backend-v2.md) — arquitetura do núcleo.
2. [`docs/adr-v2.md`](docs/adr-v2.md) — decisões arquiteturais.
3. [`docs/plano-de-validacao-experimental-v2.md`](docs/plano-de-validacao-experimental-v2.md) — como cada gate é validado.
4. [`docs/deltas-ux-v2.md`](docs/deltas-ux-v2.md) e [`docs/frontend.md`](docs/frontend.md) — UX e frontend.
5. [`docs/backlog.md`](docs/backlog.md) — o que está aberto hoje.

`core/README.md` documenta o estado módulo a módulo do núcleo.

## Configuração

Variáveis de ambiente lidas pelo núcleo/app (ver `docs/backend-v2.md` §27.2 para a lista
normativa completa):

| Variável | Efeito |
|---|---|
| `P2P_DATA_DIR` | diretório onde o `manifest.db`/`view.db` e as chaves são gravados |
| `P2P_BUILD_CHANNEL` | `prod` ou `dev` — gateia código de desenvolvimento |
| `P2P_RENDERER_URL` | em dev, sobrepõe o carregamento do `frontend/dist` por uma URL (ex.: servidor do Vite) |

## Contribuindo

Veja [`CONTRIBUTING.md`](CONTRIBUTING.md) para como rodar o ambiente local, a convenção de
commits e branches, e como abrir PR.

## Licença

[MIT](LICENSE).
