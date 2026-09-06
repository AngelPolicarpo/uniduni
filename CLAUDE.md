# Project instructions

## Purpose

Comunidade P2P de voz, vídeo e tela, sem servidor central. Cada comunidade é hospedada pela máquina de quem a criou.

Todas as fases do v1 estão implementadas (`docs/backend-v2.md` §29, emenda de 2026-09-04). `core/` é o núcleo e a rede; `frontend/` é o renderer de produto, não um mock; `app/` é o shell Electron que junta os dois. O que continua aberto está em `docs/backlog.md`.

## Repository map

- `core/`: código de produto do núcleo (`fold`, `projector`, `view`, `opCodec`, `idgen`, `permissions`, `manifest`, `outbox`, `communityHost`) **e da rede** (`swarm` com `HyperswarmBackend` real, `corestore`, transporte de §16.1, admissão, DM).
- `app/`: shell Electron (main + `utilityProcess` + preload). É quem instancia o núcleo e liga o swarm à DHT.
- `frontend/`: Vite + React + TypeScript + Tailwind + Zustand. **Renderer de produto, não mock**: todo o dado de domínio vem do núcleo pela IPC-R (`src/live/sincronizacao.ts`, `src/live/adaptadores.ts`), e a **mídia P2P mora aqui** — malha de voz (`src/live/voz.ts`), estrela de tela (`src/live/tela.ts`), câmera e DM em WebRTC. `src/mocks/dataset.ts` sobreviveu ao nome: não tem fixture, só o catálogo de permissões de §10, o host do link de convite e a normalização do código colado.
- `poc/`: harnesses descartáveis usados para produzir evidência dos gates. Reaproveite decisões e evidências, não o código.
- `docs/`: arquitetura v2, ADRs, plano de validação e auditorias.
- `docs/backlog.md`: o que está aberto hoje. `docs/sequenciamento-pos-fase-0.md` é o histórico das fatias — o backlog diz o estado, o sequenciamento diz como se chegou nele.
- `backend/`: remanescente do layout antigo; o núcleo não fica aqui.
- `graphify-out/`: grafo derivado do repositório; não é versionado.

## Source of truth

Quando houver conflito, a precedência normativa é:

1. `docs/backend-v2.md`
2. `docs/adr-v2.md`
3. `docs/plano-de-validacao-experimental-v2.md`
4. `docs/deltas-ux-v2.md`
5. `docs/frontend.md`
6. `docs/resolucao-arquitetural-v2.md`

Os documentos históricos (`docs/backend.md`, auditorias e pareceres) não têm precedência.

Os `poc/**/REPORT.md` não são normativos, mas devem ser consultados antes de reabrir decisões já validadas experimentalmente.

Se a especificação normativa não responder algo, não invente comportamento. Registre o problema como lacuna de especificação e siga a investigação apropriada.

## Architecture constraints

- O produto é Electron, não um web app: main + `utilityProcess` + renderer, com IPC-R e IPC-M como fronteiras distintas.
- O estado da comunidade é `fold(log)`: função pura, total e determinística sobre o log append-only.
- O v1 suporta somente Windows x64 e Linux x64 com glibc >= 2.31. macOS, Alpine/musl e ARM estão fora de escopo.
- Addons nativos exigem rebuild por versão de Electron. No Linux, o build deve respeitar o piso de glibc declarado.
- Dados permanecem na máquina do host e são descobertos via DHT.
- Voz é mesh P2P direto. Tela usa WebRTC em estrela; multicast em árvore está fora do v1. Não há teto de ocupação — nem de participantes de voz, nem de câmeras, nem de espectadores de tela (§90). O que limita é máquina: a malha custa uma conexão por par, e a estrela custa o upload de quem apresenta, tratado pela degradação medida de §17.5.
- TURN só entra quando NAT impedir conexão direta.
- Marcações `REQUIRES POC` e `BENCHMARK REQUIRED` bloqueiam a implementação da parte dependente até existir evidência correspondente. A UI não anuncia números que ainda não foram medidos.

## Workflow

1. Antes de alterar código, consulte o Graphify para localizar conceitos, relações e arquivos relevantes.
2. Leia diretamente os arquivos identificados pelo grafo para confirmar código, decisões e texto normativo.
3. Antes de implementar uma decisão arquitetural, consulte os documentos normativos e o evidence/report do gate relacionado.
4. Faça a menor alteração coerente com a arquitetura existente. Não introduza abstrações novas sem necessidade.
5. Depois da alteração, execute primeiro a validação mais específica; em seguida, execute a validação completa aplicável.
6. Não altere artefatos de gate versionados, migrações/evidências históricas ou outros artefatos de validação apenas para "fazer passar" um teste.
7. Não publique, faça operações destrutivas ou altere decisões arquiteturais sem confirmação explícita.

## Commands

### Frontend

```bash
cd frontend
npm run dev
npm run build
npm run lint
npm test
```

`npm test` roda o Vitest (adicionado em 2026-08-23, §58). A cobertura existente é a do
cliente de IPC-R em `src/ipc/`; os componentes ainda não têm teste. `npm run build` e
`npm run lint` continuam obrigatórios — o build é quem typecheca a árvore inteira.

### Core

```bash
cd core
npm run build
npm test
npm run typecheck
```

`npm run build` inclui a barreira de camadas definida pela arquitetura.

`npm run addons` exige Docker e deve ser executado no ambiente de build com glibc 2.31. Não compile esses nativos no host atual e assuma compatibilidade com o piso do v1.

### App (shell Electron)

```bash
cd app
npm run build
npm run typecheck
xvfb-run -a npm run smoke:fechamento
xvfb-run -a npm run smoke:captura
xvfb-run -a npm run smoke:clipboard
xvfb-run -a npm run smoke:deeplink
xvfb-run -a npm run smoke:voz
```

`smoke:fechamento` exercita o ciclo de fechamento de U-06/§18.7 contra o preload real
(§92). Precisa de um display — sob Xvfb basta. Foi a ausência dessa verificação que deixou
o mesmo defeito voltar duas vezes; rode-a ao encostar em `app/src/main`, `app/src/preload`
ou no guarda de saída do renderer.

`smoke:captura` exercita a escolha de fonte de §17.5 contra a `resolverFonte` do produto
dentro de um `setDisplayMediaRequestHandler` real: a fonte concedida é a declarada, e uma
fonte que sumiu da lista viva é negada em vez de trocada pela primeira. O cenário de
**janelas** exige um gerenciador de janelas — sem ele o Chromium não enumera janela nenhuma
e o smoke o declara **não medido**, nunca aprovado. Rode-a ao encostar no caminho de
captura.

`smoke:clipboard` (§133) mede a lista de permissões de janela de `app/src/main/permissoes.ts`
contra uma janela real: com os handlers do produto a escrita na área de transferência resolve
e o texto chega lá; com a lista anterior (`media` sozinha) ela rejeita — o segundo cenário é a
mutação, embutida. Foi a falta de `clipboard-sanitized-write` que deixou **todo** botão de
copiar do produto quebrado enquanto três deles diziam "copiado". Rode-a ao encostar no handler
de permissão ou em `frontend/src/lib/copiar.ts`.

`smoke:deeplink` (§132) exercita a gramática fechada de §3.5 contra `main/deeplink.ts` **e**
entrega um link a um renderer real, conferindo que ele produziu efeito. Só a primeira metade
existia, e ela passava com o produto inteiro surdo — `assinarDeepLinks` nunca era chamada.
Rode-o ao encostar no parse do main, no preload ou em `frontend/src/live/deeplink.ts`.

`smoke:voz` (§98) sobe uma DHT local, DOIS núcleos reais (`utilityProcess` do produto) e
duas janelas com a `MalhaDeVoz` real, e mede bytes de `inbound-rtp` nos dois sentidos — a
suíte de unidade finge o WebRTC por necessidade, e todo defeito de voz de §77–§89 e §97 foi
do tipo que só duas pontas revelam. Ele reconstrói o bundle do driver a cada rodada e leva
alguns minutos. Rode-o ao encostar em `frontend/src/live/voz.ts`, em
`frontend/src/live/sincronizacao.ts` ou no caminho de mídia do núcleo (§17.4).

## Conventions

- Documentação, comentários e mensagens de commit são em português.
- Títulos de commit descrevem o efeito da mudança em prosa; não use `feat:`/`fix:`.
- Não existe branch `main`. `master` pertence ao scaffold inicial. O trabalho está em `feat/arquitetura-v2`.
- `.claude/` está no `.gitignore`; portanto, regras colocadas ali são locais e não devem ser tratadas como contrato compartilhado.

## Graphify

Antes de ler arquivos para compreender o repositório, consulte `graphify-out/graph.json`.

Use:

```bash
graphify query "<termos>"
graphify path "<A>" "<B>"
graphify explain "<conceito>"
```

A busca é literal em relação ao vocabulário do grafo. Quando necessário, consulte `graphify-out/.vocab.txt` e use os termos existentes. Prefira consultas curtas e específicas; use `--budget N` para ampliar o contexto.

Use o resultado para decidir quais arquivos realmente precisam ser lidos. Em seguida, abra esses arquivos diretamente para confirmar detalhes.

`EXTRACTED` é evidência forte. `INFERRED` e `AMBIGUOUS` são hipóteses e devem ser confirmadas na fonte.

## Boundaries

- `poc/` é descartável por definição; não transforme harness em código de produto.
- `frontend/` não é mock. Comentários e docs antigos que dizem "fixture"/"mock" descrevem a origem histórica do código, não a fonte do dado de hoje — confirme na fonte antes de repetir.
- Não trate resultados de um gate como prova de propriedades que o gate não mediu.
- Não reabra decisões já fechadas sem evidência nova ou conflito real com a especificação normativa.
