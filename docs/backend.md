# Especificação Técnica do Backend — Uniduni

> ## ⛔ DOCUMENTO SUPERADO — v1, preservado como história
>
> **Esta especificação não tem precedência nenhuma e não deve ser usada como contrato.**
> Ela foi reprovada (`NOT APPROVED`) pelo Architecture Review Board em 2026-08-15, com dez
> blockers-raiz, e foi **integralmente substituída** por:
>
> - **`docs/backend-v2.md`** — especificação normativa
> - **`docs/adr-v2.md`** — decisões arquiteturais (as ADR-01..20 abaixo estão revogadas,
>   substituídas ou reformuladas; o mapa está em `adr-v2.md` §1)
> - **`docs/plano-de-validacao-experimental-v2.md`** — gates, PoCs e benchmarks
> - **`docs/deltas-ux-v2.md`** — mudanças de produto exigidas
> - **`docs/resolucao-arquitetural-v2.md`** — o que mudou e por quê
>
> O conteúdo abaixo é mantido **sem alteração** como registro do estado anterior e como
> contexto para as auditorias que o analisaram. Citá-lo como fonte de decisão é erro.

---

> **Fonte de verdade para a implementação do backend.** Contraparte de
> `~/.claude/plans/graceful-whistling-planet.md` (spec de UX/UI, 1607 linhas, 11 partes
> implementadas). Aquele documento define **o que a interface promete**; este define
> **como o backend cumpre cada promessa** — entidade por entidade, comando por comando,
> regra por regra.
>
> Pesquisa de campo de 2026-08-12 (registry do npm, `holepunchto/*`, posts da Pears)
> preservada nos §1 e §26. Toda versão citada foi verificada nessa data.
>
> **Este documento é prescritivo.** Onde houver mais de uma solução tecnicamente válida,
> a escolha está feita e o motivo registrado como ADR (§1). O agente de implementação
> **não deve** tomar decisão de arquitetura, de contrato ou de regra de negócio por conta
> própria: se algo não estiver aqui, é buraco desta spec e deve ser levantado, não
> inventado.

---

## 0. Como usar este documento

### 0.1 Escopo

Cobre tudo que roda fora do renderer React: o processo núcleo P2P, o log replicado, a
projeção local, o RPC entre membros e host, o transporte de mídia, os jobs, a
observabilidade e a configuração. **Não** cobre componentes de interface — esses estão
na spec de UX/UI e já estão em código.

O frontend está implementado e validado com fixtures (`frontend/src/mocks/dataset.ts`,
901 linhas). `backend/` é um README placeholder por decisão deliberada
(`backend/README.md:1-10`). O trabalho aqui especificado **substitui as fixtures por
dado real sem tocar em componente nenhum**: as stores Zustand deixam de mutar buckets
locais e passam a chamar comandos IPC (§10.2) e a ler projeções (§10.4). O mapa
store→comando está no Apêndice A.

### 0.2 Precedência entre documentos

Quando dois documentos discordarem, vale nesta ordem:

1. **Este documento**, para qualquer coisa de backend (dado, regra, contrato, erro).
2. **Spec de UX/UI** (`graceful-whistling-planet.md`), para qualquer coisa de interface.
3. **`CLAUDE.md`** do repositório, para intenção de produto.
4. **O código do frontend**, como registro do que já foi validado na prática.

§25 lista os pontos em que este documento **obriga** uma correção de texto na spec de
UX/UI. Nenhum deles é opcional: são lugares onde a interface hoje promete algo que a
arquitetura não entrega.

### 0.3 O que "API" significa aqui

Não existe HTTP em lugar nenhum deste produto. Não há servidor, não há porta escutando
em `localhost`, não há REST. Onde um backend convencional teria endpoints, este tem
**duas superfícies de chamada**:

| Superfície | Quem chama | Quem atende | Transporte | Seção |
|---|---|---|---|---|
| **IPC** | renderer (React) | núcleo P2P (mesmo dispositivo) | `MessagePort` sobre `MessageChannelMain` | §10.1-10.4 |
| **RPC P2P** | núcleo de um membro | núcleo do host da comunidade | `protomux-rpc` sobre stream Hyperswarm | §10.5-10.6 |

Cada comando e cada método traz, além do contrato próprio, uma coluna **"HTTP
equivalente"** — não porque exista HTTP, mas para que revisores possam ler a semântica
de erro com o vocabulário que já conhecem (400 = payload inválido, 403 = permissão,
409 = conflito de estado, 429 = rate limit, 503 = host indisponível).

### 0.4 Convenções

| Convenção | Regra |
|---|---|
| Identificadores | `string`, ASCII, ≤ 64 bytes. Chaves públicas são `Buffer` de 32 bytes; quando cruzam o IPC viram hex minúsculo de 64 caracteres. |
| Tempo | Sempre epoch em **milissegundos UTC** (`number`). Nunca string formatada, nunca fuso. A formatação é do renderer (`lib/format.ts`). |
| Tamanhos | Bytes, base 1000 na apresentação (`1,24 GB` — spec §5.10), base 1024 nunca aparece na UI. |
| Nomes de campo | `camelCase` em contratos IPC/RPC; `snake_case` em colunas SQLite. O tradutor é o módulo `projector`. |
| Nomes de comando | `dominio.acao` em `camelCase` (`message.send`, `channel.create`). |
| Nomes de evento | `dominio.fato` no passado (`host.wentOffline`, `outbox.flushed`). |
| Ausência | `undefined` nunca cruza a fronteira. Campo opcional ausente é **omitido**; `null` significa "explicitamente vazio" (ex.: remover apelido). |
| Ordenação canônica | `seq` do append no core do host (§5.5). Nenhum outro critério é canônico. |
| Encoding de texto | UTF-8. Limites de tamanho são em **bytes UTF-8**, não em code points, salvo onde a tabela disser "caracteres" (aí é grafemas, para bater com o contador da UI). |

---

## 1. Decisões de arquitetura (ADR)

Cada linha é uma decisão fechada. A coluna "Alternativa descartada" existe para que
ninguém reabra a discussão sem trazer informação nova.

| # | Decisão | Motivo | Alternativa descartada |
|---|---|---|---|
| **ADR-01** | **O host é a única autoridade de escrita.** Um Hypercore por comunidade, appendado só pela máquina do host. Membros mandam ops assinadas por RPC. | Dá ordem total de graça, torna permissão/hierarquia/ban *aplicáveis* em vez de cosméticos, e resolve sozinha `CLK-05`, `ROLE-09`, `INV-10`, `COM-03`, `TELA-08/09`. A spec de UX já assumiu isso sem declarar (`spec:163`, `spec:1134`, `spec:27`). | Autobase multi-writer: a seção "Tails, Forks and Merges" do `DESIGN.md` dele está literalmente `// todo`, sem benchmark público de nº de writers nem de latência de convergência. Seria pesquisa, não engenharia. |
| **ADR-02** | **Hypercore cru como log + SQLite como view materializada.** Zero Autobase, Hyperbee, Hyperdb, Hyperdrive. | Reduz a superfície aos 5 pacotes estáveis do ecossistema. `hyperdb` teve 3 majors em 15 meses; `hyperdrive` 3 em 25; `hyperbee` está sendo reescrito com API incompatível. A própria Holepunch não conseguiu manter o `autopass` alinhado ao `hyperdb` corrente. | Hyperbee como índice: churn alto, sem FTS, e obrigaria a manter duas representações do mesmo estado. |
| **ADR-03** | **Driver SQLite = `better-sqlite3@13`.** `sqlite3-native` fica como plano B, decidido no spike da fase 0. | API **síncrona**, que é exatamente o que o projetor precisa: uma transação por lote de ops, sem interleaving assíncrono e sem risco de reentrância. Documentação e histórico de produção incomparavelmente maiores. É N-API, então o `.node` é ABI-estável entre Node e Electron. | `sqlite3-native` como primeiro: prebuilds consistentes com o resto da stack, mas publicado em mai/2026, sem histórico e sem documentação de uso sob transação longa. |
| **ADR-04** | **Núcleo P2P em `utilityProcess` do Electron**, não no main. | Isola RocksDB e o event loop do Chromium; crash de addon nativo não derruba a janela. Mantém uma toolchain só (Node + TypeScript no projeto inteiro). | Main process: RocksDB e Chromium dividiriam event loop. `bare-sidecar` (o caminho que a Holepunch testa) fica como plano B se o spike da fase 0 falhar — custa um segundo runtime no build. |
| **ADR-05** | **Mídia híbrida.** WebRTC no renderer para voz/câmera (mesh); tela em chunks WebCodecs sobre os streams UDX do Hyperswarm. | WebRTC entrega AEC, jitter buffer, FEC e controle de congestionamento prontos — reconstruir isso é onde projetos de tempo real morrem. Já a árvore de multicast **é impossível em WebRTC puro**: o Chromium não repassa track sem decodificar e recodificar. Com WebCodecs+UDX, o nó de repasse encaminha bytes opacos. | WebRTC puro para tela: inviável (re-encode por nível). SFU: exigiria servidor, contradiz o produto. |
| **ADR-06** | **Sem STUN de terceiros por padrão.** O núcleo já conhece o endereço público do nó pelo `hyperdht`; injeta-o como candidato ICE. Lista de STUN configurável, **default vazia**. | Evita vazar o IP de todo participante para um servidor de terceiro num produto cujo princípio 1 é "nada de servidor central em lugar nenhum da UX". O DHT faz a mesma descoberta de endereço que o STUN faria. | STUN público por default: um endpoint externo por chamada, com endereço IP de cada membro, sem contrapartida — o fallback UDX (ADR-07) cobre o caso em que o candidato do DHT não basta. |
| **ADR-07** | **UDX é o fallback universal de transporte.** Quando o ICE falha, a voz cai para o mesmo transporte UDX que já carrega dados e tela. | Um mecanismo de relay, três usos. Cobre os casos que o furo de NAT não resolve sem TURN de terceiro e sem infraestrutura paga. | TURN: infraestrutura paga, servidor central, e ainda assim não resolveria a árvore. |
| **ADR-08** | **Relay por voluntários.** Membros optam por rodar `blind-relay`; o host registra os voluntários no log (`relay.volunteer`/`relay.withdraw`) e o `relayThrough` escolhe por menor RTT. O host entra na lista automaticamente se for capaz. | Sem infraestrutura paga e sem penalizar o host. Blind relay não lê nada — o tráfego é UDX cifrado ponta a ponta. | TURN gerenciado (custo, centralização) ou nada (deixaria CGNAT sem saída nenhuma). |
| **ADR-09** | **Convite = segredo de 10 bytes (80 bits), 16 caracteres.** Alfabeto Crockford Base32, exibido em 4 grupos de 4 (`X7K2-QM9F-RT4B-N8ZP`). | 6 caracteres (~30 bits) é força bruta viável contra um tópico anunciado em DHT público. 80 bits não é. Crockford Base32 remove `I`, `L`, `O`, `U` — os quatro caracteres que produzem erro de transcrição verbal. | `blind-pairing`: mais sofisticado (o host não aprende quem pediu antes de aprovar), mas 3 versões publicadas desde 2024 e desalinhado do `blind-pairing-core@2.10.1`. Fica como caminho de upgrade. |
| **ADR-10** | **Deletar é sempre tombstone.** Nenhuma op remove bytes do log; `message.delete`, `channel.delete`, `role.delete` e `category.delete` appendam uma op que a projeção interpreta como remoção. | Log append-only não apaga. Fingir o contrário quebraria a reprojeção determinística (§6.4), que é o teste que protege a ADR-02. | Truncar o core: destrói a assinatura de comprimento, é detectável por toda réplica e quebraria a verificação de §21.5. |
| **ADR-11** | **Fila de saída (outbox) durável em SQLite**, com backoff exponencial e motivos terminais nomeados. | A premissa 5 da spec de UX ("a fila é durável: sobrevive a fechar e reabrir o app") é promessa de produto. Uma fila em memória transformaria "será enviada quando o host voltar" em mentira. | Fila em memória: já rejeitada explicitamente pela spec de UX. |
| **ADR-12** | **Idempotência por `opId` = BLAKE2b-256 do envelope canônico.** O host mantém uma tabela de `opId` já aceitos, com janela de 7 dias. | Reenvio pela outbox, reconexão no meio do RPC e retry manual do usuário produzem exatamente o mesmo envelope. Sem dedupe, "Tentar novamente" duplicaria mensagem. | Dedupe por `(author, nonce)`: funciona, mas não protege contra reenvio de envelope adulterado com mesmo nonce. O hash do envelope inteiro protege. |
| **ADR-13** | **Busca full-text em SQLite FTS5**, tokenizer `unicode61 remove_diacritics 2`, com índice de prefixo `2 3`. | Nenhum pacote de FTS sobre Hypercore existe. FTS5 dá trecho, filtro por autor/canal/data/tipo e ordenação por recência — exatamente os filtros de `spec:506` — sobre a réplica local, que é parcial por definição (premissa 6). `remove_diacritics 2` é o que faz "apresentacoes" achar "apresentações". | Índice invertido próprio: reescrever FTS5 sem ganho. Busca linear: inviável acima de alguns milhares de mensagens. |
| **ADR-14** | **Presença, digitando e roster de voz são efêmeros**, sobre `protomux`, nunca no core. | Um "está digitando" no log permanente é absurdo e vazaria para sempre. Além disso, ordem total não tem valor nenhum para dado com TTL de 5s. | Ops no log: inflaria o core em ordens de grandeza. |
| **ADR-15** | **Não-lidas e menções são cálculo 100% local**, por watermark de `seq` por canal. Nunca trafegam. | É estado de quem lê (a spec já diz isso em `frontend/src/domain/types.ts:137-141`). Sincronizar entre dispositivos exigiria multi-dispositivo, que está fora do v1 (premissa 3). | Watermark no log: escrita constante, e o campo é de leitor, não de comunidade. |
| **ADR-16** | **Toda comunidade participada replica em background**, não só a ativa. | `UNR-02` (traço de não-lida e badge no rail de comunidades **fechadas**) é impossível sem isso, e a spec de UX o implementou em `CommunityIcon` + `selectCommunityUnread` (`frontend/src/store/communityStore.ts:942`). | Replicar só a ativa: mataria a funcionalidade já implementada na UI. |
| **ADR-17** | **A árvore de distribuição de tela é calculada pelo host**, não negociada entre pares. | Substitui um algoritmo distribuído tipo SplitStream por um cálculo centralizado, e é exatamente o que `CLAUDE.md:17-18` pede ao mandar o host priorizar os primeiros níveis. O host já tem roster, RTT e consentimentos — o cálculo é local e barato. | SplitStream/P2Cast distribuído: convergência lenta, reparo complexo, e nenhuma das duas coisas é necessária quando existe uma autoridade natural. |
| **ADR-18** | **Sem notificação com o app fechado no v1.** | `blind-push` existe e fica anotado como caminho futuro; a spec de UX já põe notificação nativa fora de escopo (premissa 1 e 7). | Push agora: exigiria daemon residente e um serviço de push, ambos fora do escopo declarado. |
| **ADR-19** | **Chave privada cifrada com `safeStorage` do Electron** (Keychain/DPAPI/libsecret), nunca em disco em claro. | É a única proteção real disponível sem inventar um sistema de senha — que contradiria "não existe conta central" (princípio 1 da spec de UX). | Arquivo em claro com permissão 600: qualquer processo do mesmo usuário lê. Senha mestra: reintroduz "esqueci minha senha" num produto sem servidor. |
| **ADR-20** | **Um único processo núcleo por instalação**, com lock de diretório de dados. Instâncias concorrentes falham na abertura, não corrompem. | RocksDB e SQLite não toleram dois escritores. O modo de falha precisa ser "a segunda instância recusa abrir com erro nomeado", não "as duas abrem e corrompem". | Multi-instância com coordenação: complexidade sem caso de uso — o produto tem uma janela. |

---

## 2. Topologia de execução

### 2.1 Processos

```
┌─ Electron main ───────────────────────────────────────────────┐
│  janela · ciclo de vida · deep links comunidadep2p://         │
│  safeStorage (cifra/decifra a chave privada)                  │
│  setDisplayMediaRequestHandler · shell.openPath               │
│  guarda de saída do host (3.5 da spec de UX)                  │
│  cria MessageChannelMain e cruza as portas                    │
└──────────┬───────────────────────────────┬────────────────────┘
           │ MessagePort (control)         │ MessagePort (control)
           │                               │
┌──────────▼────────────────────┐  ┌───────▼──────────────────────┐
│  NÚCLEO P2P (utilityProcess)  │  │  RENDERER (React, já pronto) │
│                               │◀▶│                              │
│  hyperswarm · hyperdht        │  │  WebRTC (voz/câmera)         │
│  hypercore · corestore        │  │  WebCodecs (captura de tela) │
│  hyperblobs · protomux(-rpc)  │  │  stores Zustand → IPC client │
│  better-sqlite3 (view+FTS5)   │  │                              │
│  outbox · projector · jobs    │  │                              │
│  validação · árvore · relay   │  │                              │
└───────────────────────────────┘  └──────────────────────────────┘
       ▲ MessagePort direto renderer↔núcleo (dados + chunks) ▲
       └──────────────────────────────────────────────────────┘
```

**Regra de fronteira:** o renderer **captura e codifica**; o núcleo **transporta e
persiste**. Chunks de mídia viajam por `MessageChannel` com `ArrayBuffer` transferível
(zero cópia). O main **nunca** encaminha payload de dado — ele só cruza as portas na
inicialização e depois sai do caminho.

### 2.2 Por que o main não fica no meio

Todo byte de tela passando por três processos custaria duas cópias e um salto de event
loop no processo que desenha a janela. O main cria o `MessageChannelMain`, entrega uma
ponta ao `utilityProcess` (`postMessage` com transferência) e a outra ao renderer
(`webContents.postMessage`), e a partir daí a conversa é direta.

O main mantém **um** canal próprio com o núcleo, exclusivo para três coisas que só ele
pode fazer: decifrar a chave privada com `safeStorage`, responder ao pedido de
`getDisplayMedia`, e perguntar ao núcleo quantas pessoas caem se a janela fechar
(guarda de saída, §11.20).

### 2.3 Ciclo de vida do processo núcleo

| Fase | O que acontece | Falha e reação |
|---|---|---|
| `boot` | Abre o lock do diretório de dados (ADR-20). Abre SQLite, aplica migrações de schema, confere `meta.schema_version`. | Lock ocupado → encerra com `E_CORE_ALREADY_RUNNING`; o main mostra diálogo e fecha o app. Schema à frente do binário → `E_SCHEMA_AHEAD`, encerra (downgrade não é suportado). |
| `identity` | Pede a chave privada ao main; se não existir, fica em `awaiting-identity` e só aceita `identity.create`. | `safeStorage` indisponível → `E_KEYSTORE_UNAVAILABLE`; o app não prossegue (ADR-19 não tem fallback). |
| `open` | Abre o `corestore`, abre os cores das comunidades participadas, inicia o `projector` para cada uma a partir de `last_projected_seq`. | Core corrompido → marca a comunidade `degraded`, reprojeta do zero; se falhar de novo, `E_CORE_CORRUPT` só para aquela comunidade, as outras seguem. |
| `swarm` | Sobe o `Hyperswarm`, faz `join` do tópico de cada comunidade **e** do `discoveryKey` de cada `hyperblobs` (§14.2). | Bootstrap inalcançável → `swarm.degraded`, retry com backoff (§13.3); a UI mostra "buscando peers". |
| `ready` | Emite `core.ready`. Comandos de escrita passam a ser aceitos. Jobs periódicos começam (§13). | — |
| `host-mode` | Para cada comunidade com `is_hosted_by_me = 1`, sobe o servidor RPC, o roster e o motor de árvore. | Porta/servidor DHT indisponível → a comunidade fica `hosting-degraded`: replica leitura mas recusa ops com `E_HOST_UNAVAILABLE`. |
| `draining` | Recebido `core.shutdown`. Para de aceitar ops novas, faz flush da outbox pendente **por até 3000 ms**, faz `core.flush()` de cada Hypercore, fecha SQLite com `PRAGMA wal_checkpoint(TRUNCATE)`. | Estouro dos 3000 ms → registra `shutdown.forced` com a contagem de ops não confirmadas e encerra mesmo assim. Isso fecha `HOST-04`. |
| `stopped` | Libera o lock. | — |

**Crash do núcleo:** o main detecta o `exit` e reinicia até 3 vezes em 60 s, com backoff
de 1 s / 4 s / 10 s. Cada reinício emite `core.restarted` para o renderer, que mostra
"Reconectando…" (`conn-reconnecting`). Na quarta falha, o main mostra erro terminal e não
reinicia mais — reiniciar em loop esconderia um bug de dado.

### 2.4 Regras de fronteira (invioláveis)

1. **O renderer nunca toca disco nem rede.** Nada de `fetch`, nada de `fs`, nada de
   socket. Toda leitura é query IPC (§10.4); toda escrita é comando IPC (§10.2).
2. **O núcleo nunca formata texto de interface.** Ele devolve códigos de erro e dados
   estruturados; a frase em português é do renderer. Exceção única: a mensagem de sistema
   de "Avisar quem está online" (§11.20), que é conteúdo de mensagem, não de UI.
3. **O núcleo nunca decide o que a UI esconde.** Ele devolve permissões efetivas; a UI
   decide o que mostrar. A validação real acontece no host de qualquer jeito (§8.5).
4. **Nenhum estado de domínio vive no renderer.** As stores Zustand ficam só com estado
   de *sessão de interface* (painel aberto, canal ativo, colapso de categoria) e com um
   cache de leitura invalidado por evento. Os três níveis de fixture+override de
   `communityStore.ts:848-1004` colapsam para uma camada só.

---

## 3. Módulos

### 3.1 Camadas e regra de dependência

Quatro camadas. **Uma camada só importa das camadas abaixo dela.** Importação lateral
dentro da mesma camada é permitida só onde a tabela de §3.2 declarar explicitamente.
Importação de cima para baixo é erro de arquitetura e deve quebrar o build (regra de
lint com fronteira por diretório).

```
L3  fronteira      ipc · rpcServer · rpcClient · mediaBridge
L2  aplicação      communityHost · communityClient · outbox · invites · presence
                   voiceCoordinator · shareTree · relay · search · blobs · diagnostics
L1  domínio        opCodec · validator · permissions · projector · reducers · errors
L0  infra          identity · keystore · storage(SQLite) · corestore · swarm · logger
                   config · clock · metrics
```

### 3.2 Ficha de cada módulo

| Módulo | Camada | Responsabilidade (uma frase) | Depende de | Expõe | **Não pode** |
|---|---|---|---|---|---|
| `config` | L0 | Resolver configuração efetiva (env > arquivo > default) e congelá-la no boot. | — | `get(key)`, snapshot imutável | Ler configuração depois do boot; nada é hot-reload. |
| `logger` | L0 | Log estruturado NDJSON com redação obrigatória (§17.2). | `config` | `child(scope)`, níveis | Registrar conteúdo de mensagem, segredo de convite ou chave privada. |
| `metrics` | L0 | Contadores e histogramas em memória, lidos por `diagnostics`. | `clock` | `inc`, `observe`, `snapshot` | Persistir; métrica é do processo corrente. |
| `clock` | L0 | Única fonte de "agora". Injetável para teste. | — | `now(): ms` | Ser chamado direto por qualquer outro módulo (sempre injetado). |
| `keystore` | L0 | Ponte com `safeStorage` do main; cifra/decifra a chave privada. | ipc-main | `load()`, `store()`, `wipe()` | Manter a chave decifrada fora de um `Buffer` que é zerado no shutdown. |
| `identity` | L0 | Par Ed25519, `publicKey` como identidade global, assinatura e verificação. | `keystore`, `hypercore-crypto` | `sign`, `verify`, `publicKey` | Expor a chave privada por IPC, log ou erro. |
| `storage` | L0 | Abre o SQLite, aplica migrações, oferece transação. | `config`, `better-sqlite3` | `db`, `tx(fn)`, `migrate()` | Conter regra de negócio ou SQL específico de domínio (isso é dos reducers). |
| `corestore` | L0 | Ciclo de vida dos Hypercores e do namespace por comunidade. | `config`, `corestore` | `coreFor(communityId)`, `blobsFor` | Decidir *o que* appendar. |
| `swarm` | L0 | Um `Hyperswarm` para o processo; join/leave por tópico; `firewall` recusa banidos **na conexão**. | `config`, `hyperswarm`, `hyperdht` | `join`, `leave`, `on(connection)` | Interpretar payload; só entrega o stream. |
| `errors` | L1 | Taxonomia fechada de erro (§16), com código, classe e HTTP equivalente. | — | `AppError`, catálogo | Conter texto em português. |
| `opCodec` | L1 | Serializar/desserializar `Op` e `Envelope` com `compact-encoding`, por versão. | `compact-encoding` | `encode`, `decode`, `canonical`, `opId` | Validar semântica (isso é do `validator`). |
| `permissions` | L1 | Permissões efetivas de um membro e regra de hierarquia. | — | `effective`, `has`, `canModerate`, `topRole` | Ler SQLite direto — recebe roster e cargos como argumento (função pura). |
| `validator` | L1 | Pipeline de 12 estágios (§9.1) sobre uma op candidata. | `permissions`, `errors`, `opCodec` | `validate(op, state): Ok\|AppError` | Escrever. É puro por construção — é o que torna §21.1 possível. |
| `reducers` | L1 | Aplicar uma op ao SQLite (uma função por `kind`). | `storage`, `errors` | `apply(op, tx)` | Rejeitar: o que chega aqui já passou pelo `validator`. |
| `projector` | L1 | Ler o core sequencialmente e aplicar `reducers` em transação; reprojetar sob mudança de schema. | `corestore`, `reducers`, `storage` | `start`, `catchUp`, `reproject` | Emitir eventos de IPC direto (devolve um delta; quem emite é `communityClient`). |
| `communityHost` | L2 | Ser a autoridade: recebe ops por RPC, valida, appenda, mantém roster e fan-out efêmero. | `validator`, `corestore`, `rpcServer`, `presence`, `shareTree` | `submitOp`, `roster`, `stats` | Existir quando `is_hosted_by_me = 0`. |
| `communityClient` | L2 | Replicar o core, disparar o projetor, enviar ops, emitir eventos de mudança. | `swarm`, `corestore`, `projector`, `outbox`, `rpcClient` | `open`, `close`, `submit` | Appendar no core (só o host appenda — ADR-01). |
| `outbox` | L2 | Fila durável de ops não confirmadas, com backoff, dedupe e descarte nomeado. | `storage`, `rpcClient`, `clock` | `enqueue`, `flush`, `drop`, `stats` | Reordenar ops do mesmo canal: a ordem de enfileiramento é preservada. |
| `invites` | L2 | Emitir, anunciar, resolver preview e resgatar convites. | `swarm`, `identity`, `communityHost` | `create`, `resolve`, `redeem`, `revoke` | Vazar qualquer dado da comunidade para quem está banido (§11.4). |
| `presence` | L2 | Presença, digitando, roster de voz e contagem de conectados — tudo efêmero. | `swarm`, `protomux`, `clock` | `publish`, `subscribe` | Persistir qualquer coisa. |
| `voiceCoordinator` | L2 | Roster do canal de voz, autorização de entrada, rendezvous para sinalização. | `communityHost`/`Client`, `presence`, `permissions` | `join`, `leave`, `roster` | Ver mídia. A mídia é ponta a ponta. |
| `shareTree` | L2 | Calcular a topologia de distribuição de tela, atribuir pais, detectar queda e reparar. | `communityHost`, `presence`, `metrics` | `start`, `assign`, `heartbeat`, `repair` | Rodar fora do host. |
| `mediaBridge` | L3 | Levar chunks WebCodecs do renderer ao UDX e encaminhá-los na árvore sem decodificar. | `swarm`, `shareTree` | `publish`, `subscribe`, `forward` | Inspecionar ou reencodar payload de mídia. |
| `relay` | L2 | Voluntariado de retransmissão: anúncio no DHT e seleção por RTT. | `swarm`, `blind-relay`, `config` | `enable`, `disable`, `pick` | Ligar sem consentimento explícito e persistido (§11.19). |
| `blobs` | L2 | Anexos: upload, download sob demanda, progresso, contagem de peers, seeding. | `corestore`, `swarm`, `storage` | `put`, `get`, `stat`, `clear` | Baixar automaticamente o que ninguém abriu (sparse por default). |
| `search` | L2 | FTS5 sobre a projeção com os filtros de `spec:506`. | `storage` | `query(input): SearchResults` | Consultar a rede: a busca é sempre local (premissa 6). |
| `diagnostics` | L2 | Diagnóstico de NAT, contagem de peers, snapshot de métricas para 3.1 → Rede. | `swarm`, `metrics` | `run`, `snapshot` | Bloquear o event loop: o diagnóstico é assíncrono e cancelável. |
| `rpcServer` | L3 | Expor os métodos do host sobre `protomux-rpc` (§10.6). | `communityHost`, `errors` | — | Conter regra de negócio; é só transporte + tradução de erro. |
| `rpcClient` | L3 | Chamar o host, com timeout, retry e circuit breaker. | `swarm`, `errors` | `call(method, arg)` | Decidir enfileirar: quem decide é o `outbox`. |
| `ipc` | L3 | Roteamento de comandos, assinatura de eventos e validação de forma da fronteira (§10.1). | todos os L2 | — | Conter regra de negócio. Um comando IPC é ~5 linhas: valida forma, chama L2, traduz erro. |

### 3.3 Regra de teste que a divisão existe para permitir

`validator`, `permissions`, `opCodec` e `reducers` são **puros** (sem I/O, sem relógio
implícito, sem rede). Isso não é estética: é o que permite que §21.1 rode milhares de
casos de validação e a reprojeção determinística de §21.4 sem subir swarm nenhum. Se um
desses quatro precisar de um mock de rede para ser testado, a fronteira foi violada.

---

## 4. Modelo de domínio

### 4.0 Convenções das fichas

Cada entidade traz: **responsabilidade**, **atributos** (com tipo, obrigatoriedade,
valores permitidos), **relacionamentos**, **restrições e regras de integridade**,
**ciclo de vida e estados**, **operações permitidas**.

Legenda de obrigatoriedade: `req` = obrigatório sempre · `opt` = opcional · `der` =
derivado pela projeção, nunca vem numa op · `host` = escrito só pelo host, ignorado se
vier do autor · `local` = existe só na réplica de quem lê, nunca trafega.

Três domínios de dado coexistem e **nunca se misturam**:

| Domínio | Onde vive | Sobrevive a quê | Exemplos |
|---|---|---|---|
| **Replicado** | Hypercore do host → projetado em SQLite | Tudo. É a comunidade. | Mensagem, canal, cargo, ban, convite |
| **Efêmero** | Só em memória, sobre `protomux` | Nada. Morre com a conexão. | Presença, digitando, roster de voz, árvore de tela |
| **Local** | SQLite do dispositivo, fora da projeção | Reinício do app; não replica | Não-lidas, silenciado, apelido rascunho, consentimento de relay, dispositivos |

Confundir os três é o erro mais caro possível neste projeto. `muted` de canal é
**local** (a spec de UX é explícita: "preferência local de quem lê, não propriedade da
comunidade", `spec:498`); `readOnlyForRoleIds` do mesmo canal é **replicado**.

---

### 4.1 Identity

**Responsabilidade:** provar autoria. É a única credencial do produto — não há conta,
não há senha, não há recuperação (princípio 1 da spec de UX).

| Atributo | Tipo | Obrig. | Valores permitidos |
|---|---|---|---|
| `publicKey` | `bytes[32]` (hex64 no IPC) | req | Chave pública Ed25519. **É o id global da pessoa.** |
| `secretKey` | `bytes[64]` | req | Nunca sai do núcleo; em disco só cifrada por `safeStorage` (ADR-19). |
| `displayName` | `string` | req | 2–32 grafemas após `trim`; não pode ser só espaço |
| `avatarColor` | `enum` | req | `role-gold` · `role-blue` · `role-green` · `role-red` · `role-purple` · `role-pink` · `role-neutral` · `accent` |
| `handle` | `string` | der | `@` + 6 primeiros caracteres de base32(publicKey), minúsculo. Não é único, é mnemônico. |
| `presence` | `enum` | local | `online` · `idle` · `dnd` · `invisible`. `offline` **nunca** é escrito — é a ausência de publicação (§4.16). |
| `createdAt` | `ms` | req | — |

**Relacionamentos:** 1 Identity → N Member (uma por comunidade). A Identity é global; o
Member é o vínculo com uma comunidade.

**Restrições e integridade:**
- Existe **no máximo uma** Identity por instalação (premissa 3: sem multi-dispositivo).
- `displayName` **não** tem unicidade: não existe namespace global em P2P (`spec:1044`).
- Trocar `displayName`/`avatarColor` gera `identity.update` em **cada** comunidade
  participada — o log é por comunidade, então a mesma mudança appenda N vezes, uma por
  comunidade. Isso é intencional: quem não participa não deve saber que o nome mudou.

**Ciclo de vida:**

```
(nenhuma) ──identity.create──▶ active ──identity.wipe──▶ (nenhuma, irreversível)
```

`identity.wipe` (`ID-05`, "Sair desta identidade") apaga a chave do keystore, apaga o
diretório de dados inteiro (cores, SQLite, blobs) e reinicia o núcleo em
`awaiting-identity`. **Não há confirmação no backend** — a confirmação é da UI; o
comando é destrutivo e imediato.

**Operações:** `identity.create`, `identity.update`, `identity.setPresence` (efêmera),
`identity.wipe`.

---

### 4.2 Community

**Responsabilidade:** raiz de agregação de tudo. Corresponde a exatamente um Hypercore e
um Hyperblobs.

| Atributo | Tipo | Obrig. | Valores permitidos |
|---|---|---|---|
| `id` | `string` | der | Hex64 da chave pública do core. **A chave do core é o id.** |
| `coreKey` | `bytes[32]` | der | Chave pública do Hypercore |
| `blobsKey` | `bytes[32]` | der | Chave pública do Hyperblobs da comunidade |
| `hostKey` | `bytes[32]` | req | Chave pública do host. Constante para sempre: sem transferência de host (premissa 3). |
| `name` | `string` | req | 2–40 grafemas após `trim` |
| `iconEmoji` | `string` | opt | Exatamente 1 grafema emoji, ≤ 24 bytes |
| `iconColor` | `enum` | req | Mesmo conjunto de `avatarColor` |
| `description` | `string` | opt | ≤ 120 grafemas |
| `createdAt` | `ms` | host | `hostTs` da op `community.create` (seq 0) |
| `memberCount` | `int` | der | Membros não banidos no roster. Projetado, nunca appendado. |
| `isHostedByMe` | `bool` | local | `hostKey === identity.publicKey` |
| `endedAt` | `ms` | opt/host | Preenchido por `community.end`; a partir daí a comunidade é terminal |
| `lastHostSeenAt` | `ms` | local | Última vez que o host respondeu. Alimenta o rótulo "Inativa há muito tempo" (§4.2, `COM-10`) |

**Relacionamentos:** 1→N Category, Channel, Role, Member, Invite, ModerationEntry.
Deleção é sempre tombstone (ADR-10), nunca cascade físico.

**Restrições e integridade:**
- **Toda comunidade nasce com** 1 categoria (`GERAL`), 1 canal de texto (`#geral`), 2
  cargos (`Fundador` e o cargo base `Membro`) e 1 membro (o host, com `Fundador`). Isso
  é appendado como um **único lote atômico** nos seqs 0..N da criação (§11.1), não como
  ops separadas sujeitas a falha parcial.
- **Nunca fica sem canal**: `channel.delete` do último canal é rejeitado com
  `E_LAST_CHANNEL` (regra do último canal, `spec:780`).
- `name` duplicado entre comunidades **é permitido** — não há unicidade global
  (`spec:1130`). A UI avisa, o backend não bloqueia.
- Uma comunidade `ended` aceita **zero** ops novas; o core é mantido em leitura para o
  histórico continuar acessível localmente.

**Ciclo de vida:**

```
                                  ┌──────────────────────────┐
(nada) ──community.create──▶ active ──community.end──▶ ended  │ (terminal, só leitura)
                              │  ▲                            │
                    host cai  │  │ host volta                 │
                              ▼  │                            │
                          cache-only ────────────────────────┘
```

`cache-only` **não é estado do dado** — é estado de conexão, vive em memória e é
sinalizado por `host.wentOffline`/`host.cameBack`. O dado replicado não muda.

**Operações:** `community.create`, `community.update`, `community.end`, `community.leave`.
`community.leave` **é bloqueado para o host** com `E_HOST_CANNOT_LEAVE` — quem hospeda
encerra, não sai (`spec:1123`).

---

### 4.3 Member

**Responsabilidade:** vínculo de uma Identity com uma Community, e portador dos cargos.

| Atributo | Tipo | Obrig. | Valores permitidos |
|---|---|---|---|
| `identityKey` | `bytes[32]` | req | — |
| `communityId` | `string` | req | — |
| `displayName` | `string` | der | Último `identity.update` desta pessoa nesta comunidade |
| `avatarColor` | `enum` | der | idem |
| `nickname` | `string \| null` | opt | 1–32 grafemas; `null` remove. **Auto-atribuído** (premissa 11): só o próprio membro escreve o seu |
| `roleIds` | `string[]` | req | Sempre contém o cargo base. Máx. 24 cargos por membro |
| `joinedAt` | `ms` | host | — |
| `leftAt` | `ms` | opt/host | Preenchido por `member.leave`/`mod.kick` |
| `banned` | `bool` | der | Existe ban ativo não revogado |
| `timeoutUntil` | `ms \| null` | der | Timeout ativo, se houver |

**Relacionamentos:** N Member → 1 Community; N Member → N Role; 1 Member → N Message.

**Restrições e integridade:**
- `(communityId, identityKey)` é único.
- **Todo membro tem o cargo base.** Remover o cargo base é rejeitado com
  `E_BASE_ROLE_REQUIRED`.
- O host é sempre membro, sempre com o cargo `Fundador`, e **nunca** pode ser alvo de
  `mod.kick`/`mod.ban`/`mod.timeout` (`E_FOUNDER_IMMUNE`).
- Um membro que saiu (`leftAt`) e volta pelo mesmo convite recupera o `Member` existente
  com `roleIds` **resetado para só o cargo base** — cargos não sobrevivem à saída. Isso é
  decisão fechada: guardar cargos de quem saiu criaria escalada silenciosa em quem volta
  via convite vazado.
- Um membro banido que reentra com **identidade nova** é indistinguível de um membro
  novo. A spec de UX já declara isso na nota de honestidade fixa de 3.3 — o backend
  **não tenta** heurística de detecção.

**Ciclo de vida:**

```
(não-membro) ──member.join──▶ active ──member.leave / mod.kick──▶ left ──member.join──▶ active
                                │
                                ├──mod.timeout──▶ silenced (temporário, volta sozinho)
                                └──mod.ban──────▶ banned ──mod.revokeBan──▶ left
```

`silenced` não é campo: é a existência de `timeoutUntil > now`. O host recusa toda op de
escrita do alvo enquanto durar (`MOD-05`), exceto `member.leave`.

**Operações:** `member.join`, `member.leave`, `member.setRoles`, `member.setNickname`,
`identity.update`, `mod.kick`, `mod.ban`, `mod.revokeBan`, `mod.timeout`,
`mod.removeTimeout`.

---

### 4.4 Role

**Responsabilidade:** carregar permissões e posição na hierarquia. É o único mecanismo de
autorização do produto.

| Atributo | Tipo | Obrig. | Valores permitidos |
|---|---|---|---|
| `id` | `string` | req | `role-` + 12 hex, gerado pelo host |
| `communityId` | `string` | req | — |
| `name` | `string` | req | 1–32 grafemas |
| `color` | `enum` | req | Uma das 7 de `RoleColor`. **Nunca color-picker livre** (`spec:1155`) |
| `position` | `int` | req | 0..999. Maior = mais alto. Único por comunidade |
| `permissions` | `Permission[]` | req | Subconjunto das 17 de §8.1. Pode ser vazio (cargo decorativo, `spec:1048`) |
| `mentionable` | `bool` | req | Default `true`, exceto no cargo base, que nasce `false` |
| `isFounder` | `bool` | der | Exatamente um por comunidade |
| `isDefault` | `bool` | der | Exatamente um por comunidade (o cargo base) |
| `memberCount` | `int` | der | Recalculado pela projeção a cada `member.setRoles` |
| `deletedAt` | `ms` | opt/host | Tombstone |

**Relacionamentos:** N Role → 1 Community; N Role ↔ N Member; N Role ↔ N Channel (via
`readOnlyForRoleIds`).

**Restrições e integridade:**
- `position` é **denso e único**: a projeção renumera 0..N-1 a cada `role.move`, sempre
  dentro da mesma transação. Nunca há dois cargos na mesma posição.
- O **Fundador** tem `position` máximo, sempre. `role.move` que tente ultrapassá-lo é
  rejeitado com `E_FOUNDER_TOP`. `role.update` e `role.delete` sobre ele são rejeitados
  com `E_FOUNDER_IMMUTABLE`.
- O **cargo base** não pode ser deletado (`E_BASE_ROLE_REQUIRED`), mas **suas permissões
  são editáveis** (`spec:729`).
- `role.delete` com membros: a op carrega `reassign: false` obrigatoriamente — remover o
  cargo nunca remove os membros (`spec:732`). A projeção tira o `roleId` de todo membro
  que o tinha, na mesma transação.
- **Ninguém cria ou edita cargo acima do próprio.** `role.create`/`role.update`/
  `role.move` cujo alvo fique `>= topRole(autor)` são rejeitados com `E_HIERARCHY`.
  Exceção: o Fundador, que não tem ninguém acima.
- **Ninguém concede permissão que não tem.** `role.update` que adicione uma permissão
  ausente do conjunto efetivo do autor é rejeitada com `E_PERMISSION_ESCALATION`. Essa
  regra não existe na spec de UX e é acrescentada aqui: sem ela, `manage_roles` é
  equivalente a todas as permissões.

**Ciclo de vida:** `created → (updated | moved)* → deleted` (tombstone).

**Operações:** `role.create`, `role.update`, `role.move`, `role.delete`,
`member.setRoles`.

---

### 4.5 Category

**Responsabilidade:** agrupar canais. É rótulo visual, nada mais — não tem permissão nem
comportamento próprio.

| Atributo | Tipo | Obrig. | Valores permitidos |
|---|---|---|---|
| `id` | `string` | req | `cat-` + 12 hex |
| `communityId` | `string` | req | — |
| `name` | `string` | req | 1–32 grafemas |
| `position` | `int` | der | Ordem de criação, denso (`spec:1062`) |
| `collapsed` | `bool` | local | Estado de leitura, por comunidade. **Nunca replica** |
| `deletedAt` | `ms` | opt/host | Tombstone |

**Restrições:** exatamente **dois níveis** — categoria contém canal, e nada mais
(`spec:1161`). Nome duplicado é permitido (categoria não é endereço, `spec:1050`).
`category.delete` tem dois caminhos, ambos no payload da op: `moveChannelsTo: <catId>`
ou `deleteChannels: true`. O segundo é rejeitado se levar junto o último canal da
comunidade (`E_LAST_CHANNEL`).

**Operações:** `category.create`, `category.rename`, `category.delete`.

---

### 4.6 Channel

**Responsabilidade:** container de mensagens (texto) ou de sessão de voz. É o endereço
dentro da comunidade.

| Atributo | Tipo | Obrig. | Valores permitidos |
|---|---|---|---|
| `id` | `string` | req | `ch-` + 12 hex |
| `communityId` | `string` | req | — |
| `categoryId` | `string` | req | Categoria existente e não deletada |
| `type` | `enum` | req | `text` · `voice`. **Imutável depois de criado** (`spec:1160`) |
| `name` | `string` | req | Texto: slug `^[a-z0-9][a-z0-9-]{0,31}$`. Voz: 1–32 grafemas livres |
| `topic` | `string` | opt | ≤ 120 grafemas. **Só em canal de texto** — rejeitado em voz |
| `position` | `int` | der | Ordem de criação dentro da categoria; canal novo entra no fim (`spec:1062`) |
| `readOnlyForRoleIds` | `string[]` | opt | Cargos que **não** postam aqui. Se presente, **ao menos um** cargo da comunidade precisa ficar de fora |
| `deletedAt` | `ms` | opt/host | Tombstone |
| `unreadCount` | `int` | local | §4.15 |
| `pendingMentions` | `int` | local | §4.15 |
| `muted` | `bool` | local | §4.15 |
| `firstUnreadSeq` | `int` | local | §4.15 |

**Restrições e integridade:**
- `(communityId, type, name)` é **único e bloqueante**: nome de canal é endereço
  (`spec:1049`). Colisão → `E_CHANNEL_NAME_TAKEN`.
- Nome que normaliza para vazio em canal de texto → `E_CHANNEL_NAME_EMPTY`. A
  normalização é responsabilidade do **cliente** (a prévia ao vivo já existe em
  `frontend/src/lib/channelName.ts`), mas o host **revalida** o slug e rejeita se não
  bater — cliente adulterado não cria `#Ajuda Design`.
- Excluir o último canal → `E_LAST_CHANNEL`.
- Excluir canal de voz com gente dentro: **permitido**, e o host derruba a sessão
  (`spec:1010`). Não há bloqueio.
- Excluir canal com fila offline pendente: a fila daquele canal é descartada com motivo
  nomeado (§11.9, `spec:1136`).

**Ciclo de vida:** `created → (updated | moved)* → deleted`.

**Operações:** `channel.create`, `channel.update`, `channel.move`, `channel.delete`.

---

### 4.7 Message

**Responsabilidade:** unidade de conteúdo. É a entidade de maior volume e a que define a
performance do sistema.

| Atributo | Tipo | Obrig. | Valores permitidos |
|---|---|---|---|
| `id` | `string` | der | `msg-` + hex do `opId` truncado em 12. Determinístico: reprojetar produz o mesmo id |
| `seq` | `int` | host | Posição no core. **Ordem canônica** (§5.5) |
| `channelId` | `string` | req | Canal de texto, existente, não deletado |
| `authorKey` | `bytes[32]` | req | Igual ao `author` do envelope. Divergência → `E_AUTHOR_MISMATCH` |
| `content` | `string` | req | 1–4000 grafemas, ≤ 16384 bytes UTF-8, não vazio após `trim`. Markdown básico, cru |
| `authorTs` | `ms` | req | `op.ts` — relógio do autor |
| `hostTs` | `ms` | host | Carimbo do host |
| `edited` | `bool` | der | Existe `message.edit` posterior |
| `editedAt` | `ms` | der | — |
| `pinned` | `bool` | der | Última `message.pin` vence |
| `replyToId` | `string` | opt | Mensagem do **mesmo canal**, não deletada |
| `threadId` | `string` | opt | Thread do mesmo canal |
| `mentions` | `string[]` | opt | ≤ 64. Cada item: hex64 de identidade, `role-…`, ou o literal `everyone` |
| `attachments` | `AttachmentRef[]` | opt | **Máximo 1 no v1** (o composer aceita um chip) |
| `deletedAt` | `ms` | opt/host | Tombstone: conteúdo, reações e anexos somem da projeção |

**Relacionamentos:** N Message → 1 Channel, → 1 Member (autor), → 0..1 Message (resposta),
→ 0..1 Thread, → 0..N Reaction, → 0..1 Attachment.

**Restrições e integridade:**
- `mention_everyone` é exigida se `mentions` contiver `everyone`; sem a permissão, a op é
  **aceita com a menção removida**, não rejeitada. Motivo: rejeitar a mensagem inteira por
  causa de uma menção é desproporcional e a UI já esconde `@everyone` de quem não tem a
  permissão — quem chega aqui sem ela é cliente desatualizado ou adulterado.
- `message.edit` e `message.delete` **da própria mensagem**: qualquer autor.
  `message.delete` **de outro autor**: exige `manage_messages` **e** hierarquia superior.
  `message.edit` de outro autor **não existe** e é rejeitada sempre (`E_CANNOT_EDIT_OTHERS`)
  — moderação apaga, não reescreve.
- Editar mensagem deletada → `E_MESSAGE_DELETED`.
- Deletar mensagem já deletada → **sucesso idempotente** (§12.2), sem nova entrada no log
  de auditoria.
- Mensagem em canal somente-leitura para todos os cargos do autor → `E_CHANNEL_READ_ONLY`.
- **Relógio adiantado:** se `authorTs > hostTs + CLOCK_TOLERANCE_MS` (default 60000), o
  host **aceita** a mensagem e marca `clockSkewed = true` na projeção. A UI mostra
  `hostTs` com o aviso de `spec:371`. O host **não** corrige `authorTs`: os dois carimbos
  ficam na linha do log, como `CLK-04` exige.

**Ciclo de vida:**

```
                   (cliente)                          (host)
composer ──▶ queued ──▶ sending ──▶ [accept] ──▶ sent(seq) ──edit──▶ sent(edited)
                │           │                                │
                │           └──[reject]──▶ failed            └──delete──▶ deleted (tombstone)
                └──[canal/comunidade sumiu]──▶ dropped(motivo)
```

`queued`, `sending`, `failed` e `dropped` são estados **do cliente** (tabela `outbox`,
§6.5) e não existem no log. `sent` e `deleted` são estados replicados. Isso resolve a
ambiguidade que a spec de UX carrega em `MessageDeliveryState`
(`frontend/src/domain/types.ts:184-189`): os quatro valores existem, mas só dois vêm da
rede.

**Operações:** `message.send`, `message.edit`, `message.delete`, `message.pin`,
`reaction.toggle`, `thread.create`.

---

### 4.8 Thread

**Responsabilidade:** vista sobre um subconjunto das mensagens de um canal, ancorada numa
raiz. **Não é compartimento separado** — a resposta de thread aparece também no canal, e
é assim que o dataset de referência documenta (`spec:1381`).

| Atributo | Tipo | Obrig. | Valores permitidos |
|---|---|---|---|
| `id` | `string` | der | `thr-` + 12 hex do `opId` de `thread.create` |
| `rootMessageId` | `string` | req | Mensagem não deletada do mesmo canal |
| `channelId` | `string` | der | Do `rootMessage` |
| `replyCount` | `int` | der | Mensagens com este `threadId`, exceto a raiz |
| `participantKeys` | `bytes[32][]` | der | Autores distintos |
| `unreadCount` | `int` | local | §4.15 |

**Restrições:** uma thread por mensagem raiz (`E_THREAD_EXISTS` na segunda). Deletar a
raiz **não** deleta as respostas — elas continuam no canal, e a thread deixa de ser
alcançável pelo indicador. Essa é uma decisão fechada: apagar N mensagens de outras
pessoas porque a raiz caiu seria moderação implícita.

**Operações:** `thread.create`, e depois `message.send` com `threadId`.

---

### 4.9 Reaction

**Responsabilidade:** sinal leve de concordância. É o único dado agregado que a projeção
calcula por contagem.

| Atributo | Tipo | Obrig. | Valores permitidos |
|---|---|---|---|
| `messageId` | `string` | req | Mensagem não deletada |
| `emoji` | `string` | req | Exatamente **1 grafema**, ≤ 24 bytes UTF-8 |
| `identityKey` | `bytes[32]` | req | Autor da reação |
| `at` | `ms` | host | — |

**Restrições e integridade:**
- Chave primária `(messageId, emoji, identityKey)`. `reaction.toggle` inverte: existe →
  remove; não existe → insere. É **idempotente por natureza do estado final**, mas não
  por reenvio — daí o dedupe por `opId` (ADR-12) ser obrigatório aqui: dois envios do
  mesmo toggle não podem virar duas inversões.
- Máximo **20 emojis distintos** por mensagem e **1 reação por pessoa por emoji**.
  Estourar → `E_REACTION_LIMIT`.
- O backend **não** restringe ao conjunto curado do `EmojiPicker` do frontend. Acoplar a
  validação de rede a uma lista de UI garantiria quebra na primeira vez que a lista
  mudasse.
- Mensagem deletada → reações somem junto, sem estado zumbi (`spec:1125`). A projeção faz
  isso na mesma transação do tombstone.

---

### 4.10 Attachment

**Responsabilidade:** referência a um blob no Hyperblobs da comunidade. O arquivo **não**
está na mensagem; a mensagem carrega o ponteiro.

| Atributo | Tipo | Obrig. | Valores permitidos |
|---|---|---|---|
| `blobId` | `{byteOffset,blockOffset,blockLength,byteLength}` | req | Devolvido pelo `hyperblobs.put` |
| `name` | `string` | req | 1–255 bytes, sem `/`, `\`, `\0`; nome de arquivo, não caminho |
| `sizeBytes` | `int` | req | 1 .. `ATTACHMENT_MAX_BYTES` (default 8 GiB) |
| `kind` | `enum` | req | `video` · `image` · `audio` · `document` · `other` |
| `hash` | `bytes[32]` | req | BLAKE2b-256 do conteúdo. Verificado no download |
| `downloadProgress` | `0..100` | local | §4.15 |
| `availablePeers` | `int` | local | Peers replicando o range — **dado real**, não estimativa (§14.4) |
| `hostAvailable` | `bool` | local | O host está entre os peers |

**Restrições e integridade:**
- `sizeBytes` é **revalidado pelo host** contra o `byteLength` do `blobId`; divergência →
  `E_ATTACHMENT_SIZE_MISMATCH`. Sem isso, um cliente anuncia 1 KB e entrega 8 GB.
- O `hash` é verificado **no destino**, ao completar o download. Falha → o arquivo é
  descartado, `attachment.corrupt` é emitido, e o card volta para "indisponível". Nenhum
  byte não verificado chega ao disco do usuário como arquivo final.
- Deletar a mensagem **não** apaga o blob do core (ADR-10, append-only). A projeção
  esconde a referência; o GC de §13.6 pode limpar o cache local.

---

### 4.11 Invite

**Responsabilidade:** capability que autoriza uma identidade nova a entrar. É o **único**
caminho de entrada (premissa 2: sem descoberta pública).

| Atributo | Tipo | Obrig. | Valores permitidos |
|---|---|---|---|
| `codeHash` | `bytes[32]` | req | `BLAKE2b('invite/1' ‖ secret)`. **O log guarda o hash, nunca o segredo** |
| `secret` | `bytes[10]` | local | Só na réplica de quem criou, para poder re-exibir o código |
| `communityId` | `string` | req | — |
| `createdByKey` | `bytes[32]` | req | Precisa de `create_invite` |
| `createdAt` | `ms` | host | — |
| `expiresAt` | `ms` | opt | `> hostTs`, ≤ 1 ano à frente. Ausente = nunca expira (premissa 4) |
| `maxUses` | `int` | opt | 1..10000. Ausente = ilimitado |
| `uses` | `int` | der | Contado **só pelo host** (`INV-10`) |
| `revoked` | `bool` | der | — |

**Restrições e integridade:**
- **O segredo nunca entra no log.** Se entrasse, todo membro da comunidade poderia gerar
  convites em nome de outro. O log guarda `codeHash`; o host valida por prova de
  conhecimento (§11.4).
- Contagem de usos é **serializada no host** (§12.3): dois candidatos simultâneos no
  último uso disponível resolvem em ordem, um entra e o outro recebe
  `E_INVITE_EXHAUSTED`. Nunca os dois.
- Convite revogado, expirado e esgotado devolvem **o mesmo desfecho ao cliente**
  (`invalid`) — a spec de UX é explícita em não diferenciar para o usuário
  (`spec:444`). O log de auditoria do host guarda a razão real.
- Convite para quem está **banido** devolve `banned` **sem nome de quem convidou e sem
  contagem de membros** (`spec:445`). Vazar isso seria dar informação da comunidade a
  quem foi expulso dela.
- **Sexto desfecho, ausente da spec de UX:** host offline → `unreachable`. §25 obriga a
  correção.

**Ciclo de vida:** `active → (revoked | expired | exhausted)`. Os três são terminais e o
convite continua no log como registro.

**Operações:** `invite.create`, `invite.revoke`, e (fora do log) `invite.resolve` /
`invite.redeem` por RPC.

---

### 4.12 Ban / Timeout

**Responsabilidade:** exclusão permanente e silenciamento temporário. Ambos são projeções
de ops de moderação, não entidades escritas diretamente.

| Atributo | Tipo | Obrig. | Valores permitidos |
|---|---|---|---|
| `communityId` | `string` | req | — |
| `targetKey` | `bytes[32]` | req | Membro atual ou passado |
| `byKey` | `bytes[32]` | req | Precisa de `ban_members`/`timeout_members` **e** hierarquia |
| `at` | `ms` | host | — |
| `reason` | `string` | opt | ≤ 200 grafemas, texto livre (`spec:1052`) |
| `until` | `ms` | req (timeout) | `> hostTs`, ≤ `hostTs + 30 dias` |
| `revokedAt` | `ms` | opt | Só para ban |

**Regras de integridade:**
- Ban é **aplicado em três pontos** (§8.5): `firewall` do swarm recusa a conexão, o RPC
  recusa a op, e o preview de convite devolve `banned`.
- Ban **remove as mensagens do alvo do canal** na projeção (é o que o fluxo D12 mostra,
  `spec:974`) — mas por **tombstone lógico de exibição**, não por apagar do log: as
  mensagens ficam ocultas enquanto o ban estiver ativo e **reaparecem** se o ban for
  revogado. Isso é decisão fechada e §25 obriga a corrigir o texto da spec de UX, que
  hoje sugere remoção permanente.
- Timeout ativo faz o host recusar **toda** op de escrita do alvo naquela comunidade com
  `E_TIMED_OUT`, incluindo reação e edição. Exceções: `member.leave`.
- Timeout expira **sozinho**, sem op: a projeção compara `until` com `now` na leitura. Não
  há job de expiração, e portanto não há divergência entre réplicas por causa de um job
  que rodou em um lugar e não no outro.

---

### 4.13 ModerationEntry (log de auditoria)

**Responsabilidade:** dar visibilidade ao que aconteceu. **Não é um tipo de op** — é uma
**projeção** derivada de qualquer op auditável (`spec:70`, "o log é da comunidade, não só
de punições").

| Atributo | Tipo | Obrig. | Valores permitidos |
|---|---|---|---|
| `id` | `string` | der | `mod-` + hex do `opId` |
| `seq` | `int` | der | Do append que a originou |
| `type` | `enum` | der | `kick` · `ban` · `revokeBan` · `timeout` · `removeTimeout` · `deleteMessage` · `createRole` · `deleteRole` · `createChannel` · `deleteChannel` · `createCategory` · `deleteCategory` · `updateCommunity` |
| `targetKey`/`targetId` | `string` | der | Identidade, canal, cargo ou categoria |
| `targetLabel` | `string` | der | Rótulo **congelado no momento do append** |
| `byKey` | `bytes[32]` | der | — |
| `reason` | `string` | opt | — |
| `at` | `ms` | der | `hostTs` |

**Por que `targetLabel` é congelado:** o nome de um canal excluído há três semanas não
existe mais em lugar nenhum. Se o log resolvesse o rótulo na leitura, toda entrada
antiga viraria "(desconhecido)". A projeção grava o rótulo no momento em que a op é
aplicada, e ele nunca muda.

**Restrição:** o log é **derivado**, então reprojetar reconstrói exatamente as mesmas
entradas, com os mesmos ids (§21.4). Nenhuma escrita direta na tabela é permitida.

---

### 4.14 RelayVolunteer

**Responsabilidade:** registrar quem se ofereceu para retransmitir tráfego UDX (ADR-08).

| Atributo | Tipo | Obrig. | Valores permitidos |
|---|---|---|---|
| `identityKey` | `bytes[32]` | req | Membro ativo da comunidade |
| `relayKey` | `bytes[32]` | req | Chave pública do `blind-relay` anunciado no DHT |
| `since` | `ms` | host | — |
| `withdrawnAt` | `ms` | opt/host | — |
| `rttMs` | `int` | local | Medido por quem for usar; nunca replica |

**Restrições:** o host entra na lista automaticamente se for capaz (ADR-08). Um voluntário
sem consentimento persistido é **rejeitado** (`E_CONSENT_REQUIRED`) — §11.19.

---

### 4.15 Estado local (nunca replica)

Uma tabela por preocupação, toda em SQLite, toda fora da projeção. Reprojetar **não**
apaga nada disto.

| Entidade local | Chave | Campos | Origem |
|---|---|---|---|
| `read_state` | `(communityId, channelId)` | `lastReadSeq`, `firstUnreadSeq`, `unreadCount`, `pendingMentions` | Cálculo local por watermark (ADR-15) |
| `channel_pref` | `(channelId)` | `muted` | Menu de contexto 1.1.1 |
| `community_pref` | `(communityId)` | `notificationLevel` (`all`\|`mentions`\|`none`), `collapsedCategories[]`, `recentChannels[]`, `activeChannelId` | 3.1 → Notificações, e estado de navegação |
| `relay_consent` | `(communityId)` | `decision` (`accept`\|`decline`), `at` | Modal 2.4.1, checkbox "Lembrar" |
| `device_pref` | singleton | `microphoneId`, `cameraId`, `outputId`, `inputVolume`, `outputVolume` | 3.1 → Dispositivos |
| `blob_cache` | `(communityId, blobIdHex)` | `bytesDownloaded`, `state`, `path`, `verifiedAt` | §14 |
| `outbox` | `(id)` | §6.5 | §4.7 |
| `dedupe` | `(opId)` | `firstSeenAt` | ADR-12 |

**Cálculo de não-lidas (fechado):** para cada canal, `unreadCount` = número de mensagens
com `seq > lastReadSeq` cujo autor **não** é a identidade local; `pendingMentions` =
subconjunto delas que menciona a identidade, um cargo dela, ou `everyone` — **e menção
conta mesmo em canal silenciado** (`spec:1140`). `firstUnreadSeq` é o menor `seq` do
conjunto e ancora o divisor "Novas mensagens". `lastReadSeq` avança quando o canal está
aberto **e rolado até o fim**, ou por "Marcar como lido".

---

### 4.16 Entidades efêmeras (nunca persistem)

| Entidade | TTL | Fan-out | Campos |
|---|---|---|---|
| `Presence` | 30 s, refresh a cada 10 s | host agrega e reemite | `identityKey`, `status`, `at` |
| `Typing` | 5 s, refresh a cada 3 s (`PRE-03`) | host agrega por canal | `identityKey`, `channelId` |
| `VoiceRoster` | enquanto a conexão vive | host, a cada mudança | `channelId`, `participants[{key, muted, deafened, cameraOn, sharing}]` |
| `ShareSession` | enquanto o apresentador transmite | host | `sessionId`, `presenterKey`, `channelId`, `topology`, `viewers[]`, `firstLevelRelays[]`, `treeHealth` |
| `TreeAssignment` | enquanto a sessão vive | host → cada nó | `sessionId`, `parentKey`, `childKeys[]`, `level` |

**`invisible` é trivial de implementar e precisa ser dito:** o cliente com presença
`invisible` **não publica** presença nenhuma, e continua recebendo tudo. Para os outros
ele é indistinguível de offline. `ID-08` fechado.

**Exceção declarada:** entrar em canal de voz publica presença mesmo com `invisible` —
voz é presença por definição (`spec:1137`). O núcleo **não** bloqueia; a UI mostra o
aviso.

### 4.17 Relacionamentos (visão consolidada)

```
Identity 1─────N Member N─────1 Community 1──N Category 1──N Channel 1──N Message
   │                       │                    1──N Role       │           │
   │                       │                    1──N Invite     │           ├─N Reaction
   │                       └──N ModerationEntry 1──N RelayVol.  │           ├─0..1 Attachment
   │                                                            │           └─0..1 Thread
   └──1 Ban/Timeout por (community, target)                     └─0..1 VoiceSession (efêmera)
                                                                       └─0..1 ShareSession (efêmera)
```

### 4.18 Invariantes globais (verificáveis por asserção na projeção)

Toda transação de projeção termina com estas asserções ligadas em desenvolvimento e em
teste. Violação é bug de reducer e deve abortar a transação com `E_INVARIANT`.

| # | Invariante |
|---|---|
| I-1 | Toda comunidade tem ≥ 1 canal não deletado. |
| I-2 | Toda comunidade tem exatamente 1 cargo `isFounder` e exatamente 1 `isDefault`. |
| I-3 | Todo membro ativo tem o cargo base em `roleIds`. |
| I-4 | `position` de cargo é denso e único dentro da comunidade; o Fundador é o máximo. |
| I-5 | Todo canal aponta para uma categoria não deletada da mesma comunidade. |
| I-6 | Toda mensagem aponta para um canal de texto não deletado da mesma comunidade. |
| I-7 | `replyToId` e `threadId` de uma mensagem são do mesmo canal. |
| I-8 | Nenhuma reação aponta para mensagem deletada. |
| I-9 | `memberCount` da comunidade = membros ativos não banidos; `memberCount` de cada cargo = membros ativos com o cargo. |
| I-10 | `meta.last_projected_seq` = maior `seq` aplicado, e não há buraco na sequência aplicada. |

---

## 5. Log de operações

### 5.1 Estrutura

Tudo que muda estado replicado é uma **op assinada pelo autor**. O host valida e appenda
um **registro de log**; toda réplica verifica a assinatura ao ler.

| Estrutura | Campos | Notas |
|---|---|---|
| `Op` | `v: uint8` · `kind: string` · `author: bytes[32]` · `ts: uint64` · `nonce: bytes[8]` · `payload: bytes` | `payload` é o encoding específico do `kind` |
| `Envelope` | `op: bytes` · `sig: bytes[64]` | `sig` = Ed25519 sobre `BLAKE2b('op/1' ‖ op)` |
| `LogRecord` | `envelope: bytes` · `hostTs: uint64` · `flags: uint8` | O que é appendado. `seq` é implícito (índice no core) |

`flags` bit 0 = `clockSkewed` (§4.7). Bits 1–7 reservados; leitores devem ignorar bits
desconhecidos em vez de rejeitar — é o que permite acrescentar sinal sem quebrar réplicas
antigas.

**O que o host pode e o que não pode:** ele pode **omitir** e **reordenar** ops (é ele que
decide o que appendar e em que ordem); **não pode forjar** — a assinatura é do autor e
toda réplica verifica. Um membro que suspeite de censura compara o que enviou com o que o
log contém. Truncar o core para reescrever história é **detectável** (a chave de
comprimento assinado muda) e não impedível. Limitação declarada, no espírito do princípio
3 da spec de UX.

### 5.2 Encoding

`compact-encoding@3.3.0`, com um **registry versionado por `kind`**. A versão está no
cabeçalho da `Op` (`v`), não no payload.

Regras invioláveis do registry:

1. **Campo nunca é removido nem tem o tipo trocado** dentro da mesma `v`. Acrescentar
   campo opcional no fim é a única evolução permitida.
2. **Leitor tolerante:** bytes sobrando no fim do payload são ignorados. Isso é o que
   permite um host novo appendar campo que réplicas antigas não conhecem.
3. **Escritor estrito:** o cliente só escreve `v` que ele conhece por inteiro.
4. `v` desconhecido na leitura → o registro é **contado no `seq`** e ignorado na
   projeção, com `log.unknownVersion` em métricas. Nunca aborta a projeção: um registro
   futuro não pode congelar a réplica de quem está atrás.
5. `kind` desconhecido dentro de um `v` conhecido → mesmo tratamento.

**Encoding canônico** (para o `opId` de ADR-12): campos na ordem declarada, sem
padding, sem campo opcional ausente escrito como vazio. `opId = BLAKE2b-256(envelope
canônico)`, 32 bytes, exibido como hex.

### 5.3 Catálogo de ops

Colunas: **Permissão** = o que o autor precisa ter; **Hier.** = exige hierarquia estrita
sobre o alvo; **Aud.** = gera entrada no log de auditoria.

#### Mensagem

| `kind` | Payload | Permissão | Hier. | Aud. | Regras específicas |
|---|---|---|---|---|---|
| `message.send` | `channelId, content, mentions[], attachment?, replyToId?, threadId?` | `send_messages` (+`attach_files` se anexo) | — | — | Canal existe, é texto, não somente-leitura para o autor. `replyToId`/`threadId` do mesmo canal. §4.7 |
| `message.edit` | `messageId, content` | própria mensagem | — | — | Só o autor. Mensagem não deletada. Conteúdo não vazio |
| `message.delete` | `messageId, reason?` | própria, ou `manage_messages` | sim, se de outro | sim, se de outro | Idempotente |
| `message.pin` | `messageId, pinned: bool` | `pin_messages` | — | — | Última escrita vence (maior `seq`) |
| `reaction.toggle` | `messageId, emoji` | `add_reactions` | — | — | §4.9 |
| `thread.create` | `rootMessageId` | `send_messages` | — | — | Uma por raiz |

#### Estrutura

| `kind` | Payload | Permissão | Hier. | Aud. | Regras específicas |
|---|---|---|---|---|---|
| `channel.create` | `categoryId, type, name, topic?, readOnlyForRoleIds?` | `manage_channels` | — | sim | Nome único por `(comunidade, tipo)`. Slug revalidado. Entra no fim da categoria |
| `channel.update` | `channelId, name?, topic?, readOnlyForRoleIds?` | `manage_channels` | — | — | `type` **não** é editável. Renomear revalida unicidade |
| `channel.move` | `channelId, categoryId` | `manage_channels` | — | — | Entra no fim da categoria de destino |
| `channel.delete` | `channelId` | `manage_channels` | — | sim | `E_LAST_CHANNEL`. Derruba sessão de voz. Descarta fila do canal nos clientes |
| `category.create` | `name` | `manage_channels` | — | sim | Entra no fim |
| `category.rename` | `categoryId, name` | `manage_channels` | — | — | — |
| `category.delete` | `categoryId, moveChannelsTo? \| deleteChannels: bool` | `manage_channels` | — | sim | Exatamente um dos dois. Categoria vazia dispensa ambos |

#### Cargos e membros

| `kind` | Payload | Permissão | Hier. | Aud. | Regras específicas |
|---|---|---|---|---|---|
| `role.create` | `name, color, permissions[], mentionable` | `manage_roles` | — | sim | Nasce abaixo do topo do autor. Sem escalada de permissão (§4.4) |
| `role.update` | `roleId, name?, color?, permissions?, mentionable?` | `manage_roles` | sim | — | Fundador imutável. Sem escalada |
| `role.move` | `roleId, position` | `manage_roles` | sim | — | Nunca acima do topo do autor; nunca acima do Fundador |
| `role.delete` | `roleId` | `manage_roles` | sim | sim | Nem Fundador nem cargo base. Membros mantidos |
| `member.setRoles` | `targetKey, roleIds[]` | `manage_roles` | sim | — | Cargo base obrigatório. Nenhum cargo `>=` topo do autor |
| `member.join` | `inviteCodeHash, displayName, avatarColor` | — (autorizado pelo convite) | — | — | Só o host appenda, no resgate (§11.4) |
| `member.leave` | — | — | — | — | Host bloqueado (`E_HOST_CANNOT_LEAVE`) |
| `member.setNickname` | `nickname \| null` | — | — | — | Só o próprio (premissa 11). Alvo diferente do autor → `E_NICKNAME_SELF_ONLY` |
| `identity.update` | `displayName?, avatarColor?` | — | — | — | Uma op por comunidade (§4.1) |

#### Moderação

| `kind` | Payload | Permissão | Hier. | Aud. | Regras específicas |
|---|---|---|---|---|---|
| `mod.kick` | `targetKey, reason?` | `kick_members` | sim | sim | Alvo vira `left`; pode voltar por convite válido |
| `mod.ban` | `targetKey, reason?` | `ban_members` | sim | sim | Oculta mensagens do alvo; `firewall` passa a recusar |
| `mod.revokeBan` | `targetKey` | `ban_members` | — | sim | Reexibe as mensagens ocultas |
| `mod.timeout` | `targetKey, until, reason?` | `timeout_members` | sim | sim | `until ≤ now + 30d` |
| `mod.removeTimeout` | `targetKey` | `timeout_members` | — | sim | Idempotente |

#### Comunidade e rede

| `kind` | Payload | Permissão | Hier. | Aud. | Regras específicas |
|---|---|---|---|---|---|
| `community.create` | `name, iconEmoji?, iconColor, description?` | — | — | — | Lote atômico de bootstrap (§11.1). Só `seq` 0 |
| `community.update` | `name?, iconEmoji?, iconColor?, description?` | `manage_community` | — | sim | — |
| `community.end` | `reason?` | host apenas | — | sim | Terminal. Só o `hostKey` pode |
| `invite.create` | `codeHash, expiresAt?, maxUses?` | `create_invite` | — | — | Segredo nunca vai no log |
| `invite.revoke` | `codeHash` | `create_invite` + (autor do convite ou `manage_community`) | — | — | Idempotente |
| `relay.volunteer` | `relayKey` | — | — | — | Exige consentimento persistido no cliente |
| `relay.withdraw` | — | — | — | — | Idempotente |

**Total: 29 `kind`s.** Espelham 1:1 as ações mapeadas nas stores do frontend (Apêndice A).

### 5.4 Versionamento e migração

- `v` começa em `1`. Bump só quando um campo **existente** mudar de significado ou tipo —
  acrescentar campo opcional não bumpa.
- A projeção conhece **todas** as versões já publicadas. Nunca se remove suporte de
  leitura a uma versão: o log é permanente e reprojetar precisa funcionar do `seq` 0.
- Migração de **schema SQLite** é independente e trivial: incrementa
  `meta.schema_version`, apaga a projeção e reprojeta (§6.4). Não há migração de dado em
  SQLite, porque SQLite é descartável.

### 5.5 Ordem, relógio e idempotência

| Questão | Resposta fechada | Fecha |
|---|---|---|
| Qual é a ordem canônica? | O `seq` do append no core do host. Não há relógio vetorial, não há reordenação retroativa. | `CLK-05` |
| Que carimbo a UI mostra? | `op.ts` (relógio do autor, UTC absoluto), com a regra de `spec:371`: se `clockSkewed`, mostra `hostTs` e o aviso. Os dois ficam disponíveis na projeção. | `CLK-02`, `CLK-04` |
| O que "última escrita vence" significa? | A de maior `seq`. Sem ambiguidade. | `CLK-09` |
| Onde a mensagem pendente aparece? | Enquanto `queued`, é renderizada localmente na posição de `op.ts`. Ao ser aceita, recebe `seq` e **assenta no fim**. É um delta de UX, registrado em §25. | `CLK-06` |
| O que impede duplicata? | `opId` (ADR-12). O host mantém `dedupe(opId → seq)` por 7 dias; reenvio devolve o `seq` original com `duplicate: true`, sem appendar. | §12.2 |
| E depois de 7 dias? | O reenvio duplicaria. Mas a outbox só retenta enquanto o item existe, e o item é descartado em 72 h (§6.5) — a janela de dedupe é 2,3× a janela de retry, com folga deliberada. |

---

## 6. Persistência

### 6.1 Layout em disco

Tudo sob `app.getPath('userData')/p2p/`:

```
p2p/
  LOCK                        lock exclusivo do processo núcleo (ADR-20)
  identity.enc                chave privada cifrada por safeStorage
  config.json                 configuração persistida (§20)
  cores/                      corestore (RocksDB) — todos os Hypercores
  blobs/<communityId>/        cache local de anexos já baixados
  view.db                     SQLite: projeção + FTS5 + estado local
  view.db-wal / -shm          WAL
  logs/core-YYYY-MM-DD.ndjson log estruturado, rotação em §17
```

**Decisão:** um único `view.db` para todas as comunidades, não um por comunidade. Motivo:
a busca global e a contagem de não-lidas do rail (`UNR-02`) cruzam comunidades; N bancos
exigiriam N conexões abertas e ATTACH para consultas triviais. O isolamento é por coluna
`community_id`, indexada em toda tabela.

### 6.2 Cores por comunidade

| Core | Chave | Escrito por | Replicado por |
|---|---|---|---|
| `log` | `coreKey` = id da comunidade | host apenas | todos os membros, integral |
| `blobs` | `blobsKey` | quem anexa (via host) | **sparse**: só quem abriu (§14) |

`swarm.join(coreKey)` e `swarm.join(blobsKey)` são feitos **juntos**, no mesmo momento
(§14.2). Estar conectado não é estar replicando — isso não está na documentação do
Hyperdrive e precisa ser código explícito.

Com ADR-16, **todos** os cores das comunidades participadas ficam no swarm, não só o da
ativa.

### 6.3 Esquema SQLite

Tabelas de **projeção** (descartáveis, reconstruídas do log) e tabelas **locais**
(preservadas na reprojeção). O separador é o prefixo: nenhuma tabela local é tocada por
`reproject()`.

#### Projeção

| Tabela | Colunas (tipo, restrição) | Índices |
|---|---|---|
| `communities` | `id TEXT PK` · `core_key BLOB NOT NULL` · `blobs_key BLOB NOT NULL` · `host_key BLOB NOT NULL` · `name TEXT NOT NULL` · `icon_emoji TEXT` · `icon_color TEXT NOT NULL` · `description TEXT` · `created_at INT NOT NULL` · `member_count INT NOT NULL DEFAULT 0` · `ended_at INT` | — |
| `members` | `community_id TEXT` · `identity_key BLOB` · `display_name TEXT NOT NULL` · `avatar_color TEXT NOT NULL` · `nickname TEXT` · `joined_at INT NOT NULL` · `left_at INT` · `banned INT NOT NULL DEFAULT 0` · `timeout_until INT` — **PK `(community_id, identity_key)`** | `idx_members_community(community_id, left_at)` |
| `member_roles` | `community_id TEXT` · `identity_key BLOB` · `role_id TEXT` — **PK dos três** | `idx_member_roles_role(role_id)` |
| `roles` | `id TEXT PK` · `community_id TEXT NOT NULL` · `name TEXT NOT NULL` · `color TEXT NOT NULL` · `position INT NOT NULL` · `permissions TEXT NOT NULL` (JSON array) · `mentionable INT NOT NULL` · `is_founder INT NOT NULL DEFAULT 0` · `is_default INT NOT NULL DEFAULT 0` · `member_count INT NOT NULL DEFAULT 0` · `deleted_at INT` | `uniq_roles_position(community_id, position)` WHERE `deleted_at IS NULL` |
| `categories` | `id TEXT PK` · `community_id TEXT NOT NULL` · `name TEXT NOT NULL` · `position INT NOT NULL` · `deleted_at INT` | `idx_categories_community(community_id, position)` |
| `channels` | `id TEXT PK` · `community_id TEXT NOT NULL` · `category_id TEXT NOT NULL` · `type TEXT NOT NULL` · `name TEXT NOT NULL` · `topic TEXT` · `position INT NOT NULL` · `read_only_role_ids TEXT` (JSON) · `deleted_at INT` | `uniq_channels_name(community_id, type, name)` WHERE `deleted_at IS NULL`; `idx_channels_category(category_id, position)` |
| `messages` | `id TEXT PK` · `seq INT NOT NULL` · `community_id TEXT NOT NULL` · `channel_id TEXT NOT NULL` · `author_key BLOB NOT NULL` · `content TEXT NOT NULL` · `author_ts INT NOT NULL` · `host_ts INT NOT NULL` · `clock_skewed INT NOT NULL DEFAULT 0` · `edited_at INT` · `pinned INT NOT NULL DEFAULT 0` · `reply_to_id TEXT` · `thread_id TEXT` · `mentions TEXT` (JSON) · `deleted_at INT` · `hidden_by_ban INT NOT NULL DEFAULT 0` | `idx_messages_channel(channel_id, seq DESC)`; `idx_messages_author(community_id, author_key)`; `idx_messages_pinned(channel_id) WHERE pinned=1`; `idx_messages_thread(thread_id, seq)` |
| `messages_fts` | FTS5 externa: `content`, `content_rowid = messages.rowid`, `tokenize='unicode61 remove_diacritics 2'`, `prefix='2 3'` | — |
| `attachments` | `message_id TEXT PK` · `community_id TEXT NOT NULL` · `blob_id TEXT NOT NULL` (JSON) · `name TEXT NOT NULL` · `size_bytes INT NOT NULL` · `kind TEXT NOT NULL` · `hash BLOB NOT NULL` | `idx_attachments_community(community_id)` |
| `reactions` | `message_id TEXT` · `emoji TEXT` · `identity_key BLOB` · `at INT NOT NULL` — **PK dos três** | `idx_reactions_message(message_id)` |
| `threads` | `id TEXT PK` · `root_message_id TEXT NOT NULL UNIQUE` · `channel_id TEXT NOT NULL` · `reply_count INT NOT NULL DEFAULT 0` | — |
| `invites` | `code_hash BLOB PK` · `community_id TEXT NOT NULL` · `created_by BLOB NOT NULL` · `created_at INT NOT NULL` · `expires_at INT` · `max_uses INT` · `uses INT NOT NULL DEFAULT 0` · `revoked_at INT` · `secret BLOB` (só de quem criou) | `idx_invites_community(community_id)` |
| `bans` | `community_id TEXT` · `target_key BLOB` · `by_key BLOB NOT NULL` · `at INT NOT NULL` · `reason TEXT` · `revoked_at INT` — **PK `(community_id, target_key)`** | — |
| `timeouts` | `community_id TEXT` · `target_key BLOB` · `by_key BLOB NOT NULL` · `at INT NOT NULL` · `until INT NOT NULL` · `reason TEXT` — **PK `(community_id, target_key)`** | `idx_timeouts_until(until)` |
| `moderation_log` | `id TEXT PK` · `seq INT NOT NULL` · `community_id TEXT NOT NULL` · `type TEXT NOT NULL` · `target_id TEXT NOT NULL` · `target_label TEXT NOT NULL` · `by_key BLOB NOT NULL` · `reason TEXT` · `at INT NOT NULL` | `idx_modlog(community_id, seq DESC)`; `idx_modlog_type(community_id, type, seq DESC)` |
| `relay_volunteers` | `community_id TEXT` · `identity_key BLOB` · `relay_key BLOB NOT NULL` · `since INT NOT NULL` · `withdrawn_at INT` — **PK `(community_id, identity_key)`** | — |
| `meta` | `key TEXT PK` · `value TEXT` — chaves: `schema_version`, `last_projected_seq:<communityId>`, `op_version` | — |

#### Local (preservada na reprojeção)

| Tabela | Colunas | Notas |
|---|---|---|
| `local_read_state` | `community_id`, `channel_id`, `last_read_seq`, `first_unread_seq`, `unread_count`, `pending_mentions` — PK `(community_id, channel_id)` | Recalculado incrementalmente a cada append aplicado |
| `local_channel_pref` | `channel_id PK`, `muted INT` | — |
| `local_community_pref` | `community_id PK`, `notification_level TEXT`, `collapsed_categories TEXT`, `recent_channels TEXT`, `active_channel_id TEXT`, `last_host_seen_at INT` | — |
| `local_relay_consent` | `community_id PK`, `decision TEXT`, `at INT` | — |
| `local_device_pref` | `id INT PK CHECK(id=1)`, campos de 3.1 → Dispositivos | Singleton |
| `local_blob_cache` | `community_id`, `blob_id TEXT`, `bytes_downloaded INT`, `state TEXT`, `path TEXT`, `verified_at INT` — PK `(community_id, blob_id)` | §14 |
| `local_outbox` | §6.5 | — |
| `local_dedupe` | `op_id BLOB PK`, `seq INT`, `first_seen_at INT` | ADR-12; podado em 7 dias |

#### PRAGMAs obrigatórios no boot

`journal_mode=WAL` · `synchronous=NORMAL` · `foreign_keys=OFF` (a integridade referencial
é do reducer, não do banco — tombstone lógico não combina com FK) · `busy_timeout=5000` ·
`temp_store=MEMORY` · `mmap_size=268435456` · `cache_size=-32000` (32 MiB).

**`synchronous=NORMAL` e não `FULL`:** a projeção é descartável por definição. Perder os
últimos milissegundos num crash custa uma reprojeção parcial a partir de
`last_projected_seq`, que é justamente o mecanismo que já existe. `FULL` pagaria um fsync
por transação para proteger dado reconstruível.

### 6.4 Projetor

**Algoritmo (por comunidade):**

1. Lê `meta.last_projected_seq:<communityId>`; começa em `-1`.
2. Lê do core em lotes de `PROJECTOR_BATCH` (default 256) registros a partir de `seq+1`.
3. Para cada registro: decodifica o envelope → **verifica a assinatura** → decodifica a
   `Op` → despacha para o reducer do `kind`.
4. **Uma transação SQLite por lote.** Dentro dela: reducers, recálculo de contadores
   afetados, `local_read_state` do lote, e `last_projected_seq` no fim.
5. Commit. Emite um **delta agregado** (§10.3) para o `communityClient`, que traduz em
   eventos IPC.
6. Repete até alcançar `core.length`; depois passa a reagir a `append`.

**Regras que não são negociáveis:**

- **A assinatura é verificada em toda réplica, sempre.** Não há caminho rápido que pule a
  verificação, nem para o próprio host lendo o que ele mesmo appendou. É o que torna
  §21.5 (host adversário) verdadeiro.
- **Assinatura inválida:** o registro é ignorado, contado em `projector.badSignature`, e a
  projeção continua. Não aborta — um único registro corrompido não pode congelar a
  réplica.
- **Reducer que lança:** aborta a transação do lote inteiro, registra `projector.failed`
  com `seq` e `kind`, e o projetor **para** aquela comunidade em estado `degraded`. Isso é
  deliberadamente diferente do caso anterior: assinatura ruim é dado hostil esperado;
  reducer que lança é bug nosso, e continuar produziria estado divergente entre réplicas.
- **`last_projected_seq` só avança dentro da mesma transação** que aplicou as ops. Sem
  isso, um crash entre o apply e o bump reprojetaria com duplicação.

**Reprojeção total** dispara quando: `meta.schema_version` ≠ versão do binário; comando
`core.reproject`; ou `projector.failed` seguido de reinício. Procedimento: apaga **só** as
tabelas de projeção, zera os `last_projected_seq`, reprojeta do 0. As tabelas `local_*`
sobrevivem — não-lidas, silenciados e a outbox não podem morrer por causa de uma mudança
de schema.

**Custo esperado:** ~8–15 k registros/s por comunidade em disco NVMe (dominado pela
verificação Ed25519, ~50 µs/op). Uma comunidade com 200 k mensagens reprojeta em ~20 s.
Acima de `REPROJECT_WARN_SEQ` (default 100 000) o núcleo emite `core.reprojecting` com
progresso, e a UI mostra barra em vez de spinner.

### 6.5 Outbox

Tabela `local_outbox`:

| Coluna | Tipo | Notas |
|---|---|---|
| `id` | `TEXT PK` | `opId` hex — a chave é o próprio hash, então enfileirar duas vezes o mesmo envelope é no-op |
| `community_id` | `TEXT` | — |
| `channel_id` | `TEXT` | Nulo para ops sem canal; existe para poder descartar por canal (§11.9) |
| `kind` | `TEXT` | — |
| `envelope` | `BLOB` | Já assinado. Nunca é reassinado no retry — assinar de novo mudaria o `opId` |
| `created_at` | `INT` | — |
| `attempts` | `INT` | — |
| `next_attempt_at` | `INT` | — |
| `state` | `TEXT` | `queued` · `sending` · `failed` · `dropped` |
| `last_error` | `TEXT` | Código de §16 |
| `dropped_reason` | `TEXT` | Motivo nomeado (§11.9) |

**Política de retry:** backoff exponencial com jitter — `min(1000 · 2^attempts, 60000)`
± 20 %. `OUTBOX_MAX_AGE_MS` = 72 h; passado isso, o item vira `dropped` com motivo
`expired` e o usuário é avisado. `OUTBOX_MAX_ITEMS` = 500 por comunidade; ao estourar, o
envio novo é rejeitado na hora com `E_OUTBOX_FULL` em vez de enfileirar às cegas.

**Ordem:** a outbox entrega **em ordem de `created_at` por canal**. Um item bloqueado não
segura os outros canais, mas segura o próprio canal — senão a segunda mensagem de uma
conversa chegaria antes da primeira.

**Erros terminais (não retentam, viram `dropped`):** `E_CHANNEL_NOT_FOUND`,
`E_COMMUNITY_ENDED`, `E_NOT_MEMBER`, `E_BANNED`, `E_PERMISSION_DENIED`, `E_HIERARCHY`,
`E_VALIDATION`, `E_MESSAGE_DELETED`, `E_LAST_CHANNEL`. Cada um vira uma frase nomeada na
UI — nunca "a mensagem sumiu".

**Erros transitórios (retentam):** `E_HOST_UNAVAILABLE`, `E_TIMEOUT`, `E_RATE_LIMITED`
(respeitando `retryAfterMs`), `E_SWARM_DEGRADED`, `E_INTERNAL`.

### 6.6 Transações

| Escopo | Garantia | Como |
|---|---|---|
| Lote de projeção | Atômico | Uma transação SQLite por lote (§6.4) |
| Append no host | **Não** atômico com a projeção do host | O append vai ao core; a projeção acontece depois, pelo mesmo caminho de todo mundo. O host **não** tem caminho privilegiado — é o que garante que a projeção dele seja idêntica à dos outros |
| Criação de comunidade | Atômico no log | Lote único de ops de bootstrap appendado com um `core.append([...])` (§11.1) |
| Resgate de convite | Serializado por comunidade | Fila de uma via no host (§12.3) |
| Outbox → RPC | Não transacional; idempotente | O `opId` cobre o caso "entregou mas a resposta se perdeu" |
| Escrita local (prefs, read state) | Atômico por operação | Transação implícita do better-sqlite3 |

**O que explicitamente não é transacional, e por quê:** anexar arquivo e enviar a mensagem
que o referencia. O blob vai primeiro; a mensagem depois. Se a mensagem falhar, sobra um
blob órfão no core — que é coletado pelo GC de §13.6. A ordem inversa produziria mensagem
apontando para blob inexistente, que é um estado muito pior.

---

## 7. Autenticação

Não há login. A autenticação é **prova de posse de chave privada Ed25519**, e acontece em
três camadas independentes:

| Camada | O que autentica | Mecanismo | Falha |
|---|---|---|---|
| **Transporte** | O peer do outro lado do socket | Handshake Noise do `hyperdht` — a conexão só existe se o par provar a chave | Conexão nunca estabelece |
| **Operação** | O autor de cada mudança de estado | `sig` Ed25519 sobre o `Op` canônico; `op.author` precisa bater com a chave do peer que enviou | `E_AUTHOR_MISMATCH` / `E_BAD_SIGNATURE` |
| **Réplica** | Toda leitura, para sempre | Verificação de assinatura na projeção (§6.4) | Registro ignorado, métrica incrementada |

**Por que as três, e não só a primeira:** a conexão prova quem está falando *agora*; a
assinatura da op prova quem **escreveu**, para sempre e para todo mundo, inclusive contra
o próprio host. Sem a terceira camada, o host poderia inserir uma mensagem com autoria
alheia e nenhuma réplica notaria. `ID-17` fechado.

**Não existe sessão, não existe token, não existe expiração de credencial.** A identidade
é a chave; revogar identidade é apagar a chave e criar outra, e nesse caso a pessoa é
alguém novo para todas as comunidades.

### 7.1 Ciclo da chave

| Evento | Ação |
|---|---|
| Primeiro boot | Gera par com `hypercore-crypto.keyPair()`, cifra a privada com `safeStorage.encryptString`, grava em `identity.enc` |
| Boot seguinte | Decifra, mantém em `Buffer` na memória do núcleo |
| Shutdown | Zera o `Buffer` (`buf.fill(0)`) antes de liberar |
| `identity.wipe` | Apaga `identity.enc`, apaga `p2p/` inteiro, reinicia em `awaiting-identity` |
| `safeStorage` indisponível | `E_KEYSTORE_UNAVAILABLE`; o app **não** prossegue com fallback em claro (ADR-19) |

A chave privada **nunca** cruza o IPC, nunca aparece em log, nunca entra numa mensagem de
erro. A pública cruza livremente — é o identificador do produto.

---

## 8. Autorização e permissões

### 8.1 Catálogo (17 permissões, fechado)

Idêntico ao que o frontend já implementa
(`frontend/src/domain/types.ts:60-81`, `frontend/src/mocks/dataset.ts:131`). O backend
**não** acrescenta nem remove nenhuma.

| Grupo | Permissão | Autoriza |
|---|---|---|
| Geral | `manage_community` | `community.update`, criar/revogar qualquer convite, ver 3.1b |
| | `manage_channels` | Todas as ops de `channel.*` e `category.*` |
| | `view_audit_log` | Ler `moderation_log`, `bans`, `timeouts` |
| Texto | `send_messages` | `message.send`, `thread.create` |
| | `attach_files` | Anexo em `message.send` |
| | `add_reactions` | `reaction.toggle` |
| | `mention_everyone` | Menção `everyone` sobreviver na projeção |
| | `pin_messages` | `message.pin` |
| | `manage_messages` | `message.delete` de outro autor |
| Voz | `voice_speak` | Entrar em canal de voz |
| | `voice_mute_others` | Silenciar outro participante na chamada (efêmero) |
| | `voice_share_screen` | `share.start` |
| Moderação | `create_invite` | `invite.create`, `invite.revoke` do próprio |
| | `kick_members` | `mod.kick` |
| | `ban_members` | `mod.ban`, `mod.revokeBan` |
| | `timeout_members` | `mod.timeout`, `mod.removeTimeout` |
| | `manage_roles` | `role.*`, `member.setRoles` |

### 8.2 Permissão efetiva

`efetiva(membro) = união das permissões de todos os cargos ativos do membro`.

Sem negação, sem override por canal, sem herança. **Única exceção por-canal do v1**:
`readOnlyForRoleIds` de `Channel` — o membro perde `send_messages` naquele canal se
**todos** os seus cargos estiverem na lista. Basta um cargo fora dela para liberar, o que
é exatamente a regra que o frontend implementa em `selectIsChannelReadOnly`
(`frontend/src/store/communityStore.ts:1270`).

O host é `Fundador` e o `Fundador` tem todas as 17. Não há "superusuário" separado do
sistema de cargos.

### 8.3 Hierarquia

`topRole(membro)` = maior `position` entre os cargos ativos.

**Regra única, aplicada em toda ação sobre pessoa ou cargo:** o autor só age sobre alvo
cujo `topRole` seja **estritamente menor** que o seu. Nunca igual, nunca maior. O
`Fundador` nunca é alvo de nenhuma ação de moderação.

Isso reimplementa no backend a mesma regra que já existe no frontend em
`selectCanModerate` (`frontend/src/store/communityStore.ts:1199`). A versão do frontend
passa a ser **previsão de UI**; o enforcement de verdade é aqui.

**Duas regras que a spec de UX não tem e que o backend acrescenta** (§25):

- **Sem escalada de permissão:** ninguém concede a um cargo permissão que não possui
  (`E_PERMISSION_ESCALATION`). Sem isso, `manage_roles` equivale a todas as 17.
- **Sem escalada de posição:** ninguém cria, edita ou move cargo para `position >=` o
  próprio topo (`E_HIERARCHY`).

### 8.4 Matriz de enforcement por `kind`

Já consolidada nas colunas "Permissão" e "Hier." do catálogo (§5.3). O `validator` lê
**dessa tabela**, declarativamente — não há `if` espalhado por reducer. Acrescentar um
`kind` sem linha na tabela faz a validação falhar fechada (`E_UNKNOWN_KIND`), que é o
comportamento seguro.

### 8.5 Os três pontos de enforcement

| Ponto | O que faz | Por que existe |
|---|---|---|
| **Firewall do swarm** (`hyperswarm.firewall(remotePublicKey)`) | Recusa a conexão de quem está banido em **todas** as comunidades que o nó hospeda | Barato: nem chega a estabelecer stream. É a diferença entre um banido consumindo CPU de validação e um banido não conseguindo abrir socket |
| **Validador do host** (§9) | Recusa a op | É o enforcement real e completo |
| **UI** | Esconde o botão | Cosmético, por cima dos dois anteriores (`spec:1069`) |

A UI esconder nunca é enforcement. Um cliente adulterado que mostre todos os botões
consegue exatamente nada.

---

## 9. Validação

### 9.1 Pipeline (12 estágios, ordem fixa)

O host roda os 12 na ordem. **Para no primeiro que falhar** e devolve o erro tipado.

| # | Estágio | Rejeita com |
|---|---|---|
| 1 | Tamanho do envelope ≤ `MAX_ENVELOPE_BYTES` (default 32 KiB, ou 64 KiB se houver anexo) | `E_PAYLOAD_TOO_LARGE` |
| 2 | Decodifica `Envelope`; `v` e `kind` conhecidos | `E_MALFORMED` / `E_UNKNOWN_KIND` |
| 3 | Assinatura válida sobre o `Op` canônico | `E_BAD_SIGNATURE` |
| 4 | `op.author` == chave pública do peer da conexão | `E_AUTHOR_MISMATCH` |
| 5 | `opId` não está no `dedupe` | devolve `{seq, duplicate:true}` — **sucesso**, não erro (§12.2) |
| 6 | `op.ts` dentro de `[hostTs − 7d, hostTs + 1d]` | `E_CLOCK_UNREASONABLE` (fora disso é relógio quebrado, não adiantado) |
| 7 | Autor é membro ativo, não banido | `E_NOT_MEMBER` / `E_BANNED` |
| 8 | Sem timeout ativo (exceto `member.leave`) | `E_TIMED_OUT` |
| 9 | Rate limit do autor (§19.3) | `E_RATE_LIMITED` + `retryAfterMs` |
| 10 | Permissão do `kind` (§8.4) | `E_PERMISSION_DENIED` |
| 11 | Hierarquia sobre o alvo, quando aplicável | `E_HIERARCHY` / `E_FOUNDER_IMMUNE` |
| 12 | Regras de forma e invariantes estruturais do `kind` (§9.2, §9.3) | `E_VALIDATION` + `field` |

A comunidade estar `ended` é checada **antes do estágio 1**, e rejeita tudo com
`E_COMMUNITY_ENDED`.

### 9.2 Limites de campo (tabela única, autoritativa)

| Campo | Mín | Máx | Normalização | Erro |
|---|---|---|---|---|
| `Identity.displayName` | 2 grafemas | 32 grafemas | `trim`, colapsa espaço interno | `E_VALIDATION.displayName` |
| `Community.name` | 2 | 40 | `trim` | `.name` |
| `Community.description` | 0 | 120 | `trim` | `.description` |
| `Category.name` | 1 | 32 | `trim` | `.name` |
| `Channel.name` (texto) | 1 | 32 | slug `^[a-z0-9][a-z0-9-]{0,31}$`; NFD, remove diacrítico, espaço→`-`, descarta o resto | `.name` / `E_CHANNEL_NAME_EMPTY` |
| `Channel.name` (voz) | 1 | 32 | `trim`, preserva caixa e espaço | `.name` |
| `Channel.topic` | 0 | 120 | `trim`; só em texto | `.topic` |
| `Role.name` | 1 | 32 | `trim` | `.name` |
| `Member.nickname` | 1 | 32 | `trim`; vazio ⇒ `null` (remover, não erro — `spec:1051`) | `.nickname` |
| `Message.content` | 1 | 4000 grafemas / 16384 bytes | `trim` no fim; preserva quebra de linha | `.content` |
| `Message.mentions` | 0 | 64 itens | ids duplicados colapsam | `.mentions` |
| `Reaction.emoji` | 1 grafema | 1 grafema / 24 bytes | — | `.emoji` |
| `reason` (moderação) | 0 | 200 | `trim` | `.reason` |
| `Attachment.name` | 1 byte | 255 bytes | remove `/`, `\`, `\0`, caracteres de controle | `.name` |
| `Attachment.sizeBytes` | 1 | `ATTACHMENT_MAX_BYTES` (8 GiB) | — | `E_ATTACHMENT_TOO_LARGE` |
| `Invite.maxUses` | 1 | 10000 | inteiro | `.maxUses` |
| `Invite.expiresAt` | `now+60s` | `now+365d` | — | `.expiresAt` |
| `Timeout.until` | `now+60s` | `now+30d` | — | `.until` |

**Onde a validação acontece, e por que em dois lugares:** o **cliente** valida antes de
enfileirar (para dar erro inline no formulário, como §13 da spec de UX exige) e o **host**
revalida sempre. A validação do cliente é UX; a do host é verdade. As duas usam o **mesmo
módulo** (`validator`, L1, puro), compilado nos dois lados — assim não podem divergir.

### 9.3 Invariantes estruturais por `kind` (estágio 12)

| `kind` | Checagens |
|---|---|
| `channel.create` | Categoria existe e não deletada · nome único por `(comunidade,tipo)` · `topic` só se texto · `readOnlyForRoleIds` deixa ≥1 cargo de fora e todos existem |
| `channel.update` | Canal existe · renomear revalida unicidade · `type` ausente do payload |
| `channel.delete` | Não é o último canal não deletado |
| `category.delete` | Exatamente um de `moveChannelsTo`/`deleteChannels` · destino existe e é da mesma comunidade · `deleteChannels` não leva o último canal |
| `role.create/update` | Cor entre as 7 · permissões ⊆ efetivas do autor · `position` resultante < topo do autor |
| `role.delete` | Não é Fundador nem cargo base |
| `member.setRoles` | Todos os cargos existem e são da comunidade · inclui o cargo base · nenhum `>=` topo do autor · alvo não é o Fundador |
| `member.setNickname` | Alvo == autor |
| `message.send` | Canal é texto, não deletado, não somente-leitura para o autor · `replyToId`/`threadId` do mesmo canal e não deletados · ≤1 anexo · `sizeBytes` bate com `blobId.byteLength` |
| `message.edit` | Autor == autor original · não deletada |
| `message.delete` | Própria, ou `manage_messages` + hierarquia |
| `reaction.toggle` | Mensagem não deletada · ≤20 emojis distintos |
| `thread.create` | Raiz não deletada · sem thread ainda |
| `invite.create` | `expiresAt`/`maxUses` na faixa · ≤ `INVITE_MAX_ACTIVE` (default 50) ativos por comunidade |
| `mod.*` | Alvo é membro (ativo ou `left`) · alvo ≠ autor · alvo ≠ Fundador |
| `community.end` | `author == hostKey` |
| `relay.volunteer` | `relayKey` ≠ zero · autor não é voluntário ativo |

---

## 10. Contratos de API

### 10.1 IPC — transporte e envelope

**Transporte:** `MessagePort` direto renderer↔núcleo (§2.1). Estrutura de quadro:

| Quadro | Campos | Direção |
|---|---|---|
| `req` | `t:"req"`, `id:uint32`, `cmd:string`, `arg:object` | renderer → núcleo |
| `res` | `t:"res"`, `id`, `ok:true`, `data` \| `ok:false`, `err:{code,message,details?,retryAfterMs?}` | núcleo → renderer |
| `sub` | `t:"sub"`, `id`, `topic:string`, `filter?:object` | renderer → núcleo |
| `unsub` | `t:"unsub"`, `id` | renderer → núcleo |
| `ev` | `t:"ev"`, `topic`, `data` | núcleo → renderer |
| `chunk` | `t:"chunk"`, `sessionId`, `seq`, `meta`, `payload:ArrayBuffer` (transferível) | ambos |

**Regras:**
- `id` é monotônico por sessão de renderer. Resposta fora de ordem é normal e esperada.
- **Timeout default 10 000 ms**; comandos que dependem de resposta do host usam 30 000 ms
  e estão marcados com ⏱ na tabela. Estouro → `E_TIMEOUT` no renderer, e o núcleo
  **continua** processando (o comando pode ter sido aplicado — daí a idempotência de
  ADR-12 ser obrigatória).
- Comando desconhecido → `E_UNKNOWN_COMMAND`. Argumento com forma errada →
  `E_MALFORMED` **antes** de chegar em L2.
- **Backpressure:** o núcleo para de emitir eventos de um `topic` se houver mais de
  `IPC_EVENT_HIGHWATER` (default 1000) quadros não drenados, emite `ipc.dropped` com a
  contagem, e o renderer refaz a query correspondente. Evento perdido nunca vira estado
  errado — evento é **sinal para reconsultar**, não fonte de verdade.

**Princípio que amarra tudo:** eventos carregam **o que mudou**, não **o novo estado**. O
renderer reconsulta. Isso elimina toda uma classe de bug de sincronização e é o que
permite que a UI sobreviva a evento perdido, evento duplicado e evento fora de ordem.

### 10.2 IPC — comandos de escrita

Todos exigem identidade criada, exceto `identity.create` e `core.status`. A coluna
**Perm.** é a permissão exigida na comunidade em questão; ✕ = nenhuma.

#### Identidade e app

| Comando | Argumento | Perm. | Resposta | Erros | HTTP eq. |
|---|---|---|---|---|---|
| `identity.create` | `{displayName, avatarColor}` | ✕ | `{publicKey, handle, createdAt}` | `E_IDENTITY_EXISTS`, `E_VALIDATION`, `E_KEYSTORE_UNAVAILABLE` | 201 |
| `identity.update` | `{displayName?, avatarColor?}` | ✕ | `{}` — enfileira `identity.update` em cada comunidade | `E_VALIDATION` | 200 |
| `identity.setPresence` | `{presence}` | ✕ | `{}` | `E_VALIDATION` | 200 |
| `identity.wipe` | `{}` | ✕ | `{}` (o núcleo reinicia) | — | 204 |
| `core.status` | `{}` | ✕ | `{phase, version, schemaVersion, opVersion}` | — | 200 |
| `core.reproject` | `{communityId?}` | ✕ | `{}` | `E_BUSY` | 202 |
| `core.shutdown` | `{}` | ✕ | `{drainedMs, pendingOps}` | — | 200 |

#### Comunidade

| Comando | Argumento | Perm. | Resposta | Erros | HTTP eq. |
|---|---|---|---|---|---|
| `community.create` | `{name, iconEmoji?, iconColor, description?}` | ✕ | `{communityId, defaultChannelId}` | `E_VALIDATION` | 201 |
| `community.update` ⏱ | `{communityId, name?, iconEmoji?, iconColor?, description?}` | `manage_community` | `{seq}` | `E_PERMISSION_DENIED`, `E_HOST_UNAVAILABLE`, `E_VALIDATION` | 200 |
| `community.end` ⏱ | `{communityId, reason?}` | host | `{seq}` | `E_NOT_HOST`, `E_COMMUNITY_ENDED` | 200 |
| `community.leave` ⏱ | `{communityId}` | ✕ | `{}` | `E_HOST_CANNOT_LEAVE` | 200 |

#### Canais e categorias

| Comando | Argumento | Perm. | Resposta | Erros | HTTP eq. |
|---|---|---|---|---|---|
| `channel.create` ⏱ | `{communityId, categoryId, type, name, topic?, readOnlyForRoleIds?}` | `manage_channels` | `{channelId, seq}` | `E_CHANNEL_NAME_TAKEN`, `E_CHANNEL_NAME_EMPTY`, `E_HOST_UNAVAILABLE` | 201 |
| `channel.update` ⏱ | `{channelId, name?, topic?, readOnlyForRoleIds?}` | `manage_channels` | `{seq}` | idem | 200 |
| `channel.move` ⏱ | `{channelId, categoryId}` | `manage_channels` | `{seq}` | `E_CATEGORY_NOT_FOUND` | 200 |
| `channel.delete` ⏱ | `{channelId}` | `manage_channels` | `{seq, droppedQueued:int}` | `E_LAST_CHANNEL` | 200 |
| `category.create` ⏱ | `{communityId, name}` | `manage_channels` | `{categoryId, seq}` | `E_VALIDATION` | 201 |
| `category.rename` ⏱ | `{categoryId, name}` | `manage_channels` | `{seq}` | — | 200 |
| `category.delete` ⏱ | `{categoryId, moveChannelsTo?} \| {categoryId, deleteChannels:true}` | `manage_channels` | `{seq}` | `E_VALIDATION`, `E_LAST_CHANNEL` | 200 |
| `channel.setMuted` | `{channelId, muted}` | ✕ (local) | `{}` | — | 200 |
| `channel.markRead` | `{channelId}` | ✕ (local) | `{unreadCount:0}` | — | 200 |
| `category.setCollapsed` | `{categoryId, collapsed}` | ✕ (local) | `{}` | — | 200 |

#### Cargos e membros

| Comando | Argumento | Perm. | Resposta | Erros | HTTP eq. |
|---|---|---|---|---|---|
| `role.create` ⏱ | `{communityId, name, color, permissions[], mentionable}` | `manage_roles` | `{roleId, seq}` | `E_PERMISSION_ESCALATION`, `E_HIERARCHY` | 201 |
| `role.update` ⏱ | `{roleId, name?, color?, permissions?, mentionable?}` | `manage_roles` | `{seq}` | `E_FOUNDER_IMMUTABLE`, `E_PERMISSION_ESCALATION` | 200 |
| `role.move` ⏱ | `{roleId, position}` | `manage_roles` | `{seq, positions:[{roleId,position}]}` | `E_FOUNDER_TOP`, `E_HIERARCHY` | 200 |
| `role.delete` ⏱ | `{roleId}` | `manage_roles` | `{seq, affectedMembers:int}` | `E_BASE_ROLE_REQUIRED`, `E_FOUNDER_IMMUTABLE` | 200 |
| `member.setRoles` ⏱ | `{communityId, targetKey, roleIds[]}` | `manage_roles` | `{seq}` | `E_HIERARCHY`, `E_BASE_ROLE_REQUIRED` | 200 |
| `member.setNickname` ⏱ | `{communityId, nickname \| null}` | ✕ | `{seq}` | `E_NICKNAME_SELF_ONLY` | 200 |

#### Mensagens

| Comando | Argumento | Perm. | Resposta | Erros | HTTP eq. |
|---|---|---|---|---|---|
| `message.send` | `{channelId, content, mentions[], attachment?, replyToId?, threadId?, clientRef}` | `send_messages` | `{opId, state:"queued"\|"sending"}` — **retorna imediatamente**, o resultado vem por evento | `E_CHANNEL_READ_ONLY`, `E_OUTBOX_FULL`, `E_VALIDATION` | 202 |
| `message.retry` | `{opId}` | ✕ | `{state}` | `E_NOT_FOUND` | 202 |
| `message.cancelQueued` | `{opId}` | ✕ | `{}` | `E_NOT_FOUND`, `E_ALREADY_SENT` | 200 |
| `message.edit` ⏱ | `{messageId, content}` | própria | `{seq}` | `E_CANNOT_EDIT_OTHERS`, `E_MESSAGE_DELETED` | 200 |
| `message.delete` ⏱ | `{messageId, reason?}` | própria \| `manage_messages` | `{seq}` | `E_PERMISSION_DENIED`, `E_HIERARCHY` | 200 |
| `message.pin` ⏱ | `{messageId, pinned}` | `pin_messages` | `{seq}` | — | 200 |
| `message.react` ⏱ | `{messageId, emoji}` | `add_reactions` | `{seq, added:bool}` | `E_REACTION_LIMIT` | 200 |
| `thread.create` ⏱ | `{rootMessageId}` | `send_messages` | `{threadId, seq}` | `E_THREAD_EXISTS` | 201 |

**`message.send` é assíncrono por contrato.** É o único comando de escrita que não espera
o host: ele grava na outbox, devolve `opId` e o resto vem por
`message.accepted`/`message.failed`/`message.dropped`. Isso é o que faz a fila offline
(premissa 5) funcionar sem a UI ter caminho especial.

#### Moderação

| Comando | Argumento | Perm. | Resposta | Erros | HTTP eq. |
|---|---|---|---|---|---|
| `mod.kick` ⏱ | `{communityId, targetKey, reason?}` | `kick_members` | `{seq}` | `E_HIERARCHY`, `E_FOUNDER_IMMUNE` | 200 |
| `mod.ban` ⏱ | `{communityId, targetKey, reason?}` | `ban_members` | `{seq, hiddenMessages:int}` | idem | 200 |
| `mod.revokeBan` ⏱ | `{communityId, targetKey}` | `ban_members` | `{seq}` | `E_NOT_BANNED` | 200 |
| `mod.timeout` ⏱ | `{communityId, targetKey, until, reason?}` | `timeout_members` | `{seq}` | `E_VALIDATION.until` | 200 |
| `mod.removeTimeout` ⏱ | `{communityId, targetKey}` | `timeout_members` | `{seq}` | — | 200 |

#### Convites

| Comando | Argumento | Perm. | Resposta | Erros | HTTP eq. |
|---|---|---|---|---|---|
| `invite.create` ⏱ | `{communityId, expiresInDays?, maxUses?}` | `create_invite` | `{code, codeHash, expiresAt?, maxUses?}` — **`code` só aqui, e só para quem criou** | `E_INVITE_LIMIT` | 201 |
| `invite.revoke` ⏱ | `{communityId, codeHash}` | `create_invite`+autor \| `manage_community` | `{seq}` | `E_NOT_FOUND` | 200 |
| `invite.resolve` ⏱ | `{codeOrLink}` | ✕ | `InvitePreview` (§10.2.1) | `E_MALFORMED` | 200 |
| `invite.redeem` ⏱ | `{codeOrLink}` | ✕ | `{communityId, defaultChannelId}` | `E_INVITE_INVALID`, `E_INVITE_EXHAUSTED`, `E_BANNED`, `E_HOST_UNAVAILABLE` | 200 |

##### 10.2.1 `InvitePreview` — os **seis** desfechos

```
{ status:"ok",            community:{id,name,iconEmoji?,iconColor,memberCount}, invitedBy:{key,displayName} }
{ status:"already-member", community:{id,name,iconEmoji?,iconColor} }
{ status:"banned",         communityName }                     ← sem contagem, sem convidador
{ status:"invalid" }                                           ← inválido, revogado, expirado, esgotado
{ status:"unreachable",    hint:"host-offline" }               ← NOVO (§25, INV-07)
{ status:"ended",          communityName }                     ← NOVO: comunidade encerrada
```

Os dois últimos **não existem** na spec de UX e obrigam correção (§25). Sem
`unreachable`, um host offline hoje cairia em `invalid`, que diz ao usuário que o convite
é ruim quando o convite está perfeito.

#### Voz, tela e relay

| Comando | Argumento | Perm. | Resposta | Erros | HTTP eq. |
|---|---|---|---|---|---|
| `voice.join` ⏱ | `{channelId}` | `voice_speak` | `{sessionId, roster[]}` | `E_HOST_UNAVAILABLE` (`VOZ-09`), `E_CHANNEL_NOT_VOICE` | 200 |
| `voice.leave` | `{}` | ✕ | `{}` | — | 200 |
| `voice.setSelf` | `{muted?, deafened?, cameraOn?}` | ✕ | `{}` | `E_CAMERA_LIMIT` (>6 câmeras) | 200 |
| `voice.setParticipantVolume` | `{identityKey, volume:0..100}` | ✕ (local) | `{}` | — | 200 |
| `voice.muteParticipant` | `{identityKey, muted}` | `voice_mute_others` | `{}` | `E_PERMISSION_DENIED` | 200 |
| `voice.signal` | `{peerKey, sdp?, ice?}` | ✕ | `{}` — repassado direto ao peer (§10.7) | `E_PEER_UNREACHABLE` | 202 |
| `share.start` ⏱ | `{sourceLabel, quality}` | `voice_share_screen` | `{sessionId, topology}` | `E_ALREADY_SHARING` | 201 |
| `share.stop` | `{sessionId}` | apresentador | `{}` | — | 200 |
| `share.setQuality` | `{sessionId, quality}` | ✕ (de quem assiste) | `{}` | — | 200 |
| `share.respondConsent` | `{communityId, accept, remember}` | ✕ | `{}` | — | 200 |
| `relay.enable` ⏱ | `{communityId}` | ✕ | `{relayKey, seq}` | `E_CONSENT_REQUIRED` | 200 |
| `relay.disable` ⏱ | `{communityId}` | ✕ | `{seq}` | — | 200 |

#### Arquivos, preferências, diagnóstico

| Comando | Argumento | Perm. | Resposta | Erros |
|---|---|---|---|---|
| `blob.stage` | `{communityId, path}` | `attach_files` | `{blobId, name, sizeBytes, kind, hash}` — sobe ao Hyperblobs antes de `message.send` | `E_ATTACHMENT_TOO_LARGE`, `E_FILE_UNREADABLE` |
| `blob.download` | `{communityId, blobId}` | ✕ | `{}` — progresso por evento | `E_NO_PEERS` |
| `blob.cancel` | `{communityId, blobId}` | ✕ | `{}` | — |
| `blob.reveal` | `{communityId, blobId}` | ✕ | `{}` — pede `shell.openPath` ao main (`ARQ-09`) | `E_NOT_DOWNLOADED` |
| `settings.setDevice` | `{kind, deviceId}` | ✕ | `{}` | — |
| `settings.setVolume` | `{kind, value}` | ✕ | `{}` | — |
| `settings.setNotifications` | `{enabled?, communityId?, level?}` | ✕ | `{}` | — |
| `diag.run` | `{}` | ✕ | `{natType, peerCount, relayAvailable, ranAt}` | — |
| `diag.snapshot` | `{}` | ✕ | métricas de §17.3 | — |
| `host.exitImpact` | `{}` | ✕ | `[{communityId, name, onlineCount, inCallCount}]` — alimenta 3.5 | — |
| `host.notifyBeforeExit` | `{}` ⏱ | host | `{postedTo:[channelId]}` | — |

#### Injeção de falha (só com `NODE_ENV !== 'production'`)

Espelha botão a botão o `DevBar.tsx` (342 linhas), agora derrubando coisa de verdade —
é o que fecha `INF-05`. Registrados sob `dev.*` e **ausentes do roteador em produção**,
não apenas escondidos: `dev.hostOffline`, `dev.hostOnline`, `dev.failNextSend`,
`dev.dropBlobPeer`, `dev.setPeerMesh`, `dev.failVoiceJoin`, `dev.startRemoteShare`,
`dev.addViewer`, `dev.clearViewers`, `dev.forceTurn`, `dev.dropTreeNode`,
`dev.failShare`, `dev.forgetConsent`, `dev.setNatType`, `dev.seedDataset`,
`dev.resetAll`.

### 10.3 IPC — eventos

Cada evento é **sinal para reconsultar**, com o mínimo de dado para a UI decidir se
precisa. `communityId` está sempre presente quando aplicável.

| Topic | Payload | Dispara |
|---|---|---|
| `core.ready` | `{phase}` | Núcleo pronto |
| `core.restarted` | `{attempt}` | Reinício após crash |
| `core.reprojecting` | `{communityId, done, total}` | Reprojeção longa |
| `ipc.dropped` | `{topic, count}` | Backpressure (§10.1) |
| `community.changed` | `{communityId, fields[]}` | `community.update` projetado |
| `community.ended` | `{communityId}` | `community.end` |
| `community.joined` / `community.left` | `{communityId}` | Entrada/saída |
| `structure.changed` | `{communityId, channels:[ids], categories:[ids]}` | Qualquer op de estrutura |
| `roles.changed` | `{communityId, roleIds[]}` | Qualquer op de cargo |
| `members.changed` | `{communityId, identityKeys[]}` | Roster, cargos, apelido, ban |
| `messages.appended` | `{communityId, channelId, fromSeq, toSeq, hasMention}` | Lote projetado |
| `message.updated` | `{messageId, channelId, fields[]}` | Edição, pin, reação, delete |
| `message.accepted` | `{opId, messageId, seq, channelId}` | Host aceitou uma op da outbox |
| `message.failed` | `{opId, code, retryInMs?}` | Falha transitória |
| `message.dropped` | `{opId, reason, channelId}` | Terminal — a UI nomeia (`spec:1136`) |
| `outbox.changed` | `{communityId, queued, failed}` | Contagem para o banner |
| `outbox.flushed` | `{communityId, delivered}` | Host voltou e a fila saiu (B4 passo 4) |
| `host.wentOffline` | `{communityId}` | Host caiu |
| `host.cameBack` | `{communityId}` | Host voltou (fase `reconnecting` antes) |
| `host.reconnecting` | `{communityId, attempt}` | Tentando |
| `swarm.changed` | `{peerCount, degraded}` | Peers |
| `nat.detected` | `{natType}` | `cgnat` alimenta 3.1 → Rede |
| `presence.changed` | `{communityId, entries[]}` | Presença agregada |
| `typing.changed` | `{channelId, identityKeys[]}` | TTL 5 s |
| `unread.changed` | `{communityId, channelId, unreadCount, pendingMentions}` | Recalculado |
| `voice.roster` | `{channelId, participants[]}` | Mudança no roster |
| `voice.meshChanged` | `{peerKey, status}` | Falha assimétrica (B7) |
| `voice.failed` | `{reason}` | Falha total |
| `voice.signal` | `{peerKey, sdp?, ice?}` | Sinalização recebida |
| `share.started` / `share.stopped` | `{sessionId, presenterKey, channelId}` | — |
| `share.topologyChanged` | `{sessionId, topology, viewerCount}` | estrela↔árvore |
| `share.assignment` | `{sessionId, parentKey, childKeys[], level}` | Atribuição da árvore |
| `share.consentRequested` | `{communityId, relayCount}` | Modal 2.4.1 |
| `share.relayingChanged` | `{sessionId, relayingTo}` | Badge "Você está retransmitindo…" |
| `share.treeHealth` | `{sessionId, health, firstLevelRelays[]}` | Painel 2.4.2 |
| `share.turnEngaged` | `{sessionId, using}` | Badge "Via TURN" |
| `blob.progress` | `{communityId, blobId, progress, peers, hostAvailable}` | A cada 500 ms |
| `blob.completed` | `{communityId, blobId, path}` | Verificado |
| `blob.peerLost` | `{communityId, blobId, remaining}` | B8 exceção |
| `blob.unavailable` | `{communityId, blobId}` | Zero peers + host offline |
| `attachment.corrupt` | `{communityId, blobId}` | Hash não bateu |

### 10.4 IPC — queries de leitura

Todas são **síncronas do ponto de vista do núcleo** (SQLite síncrono, ADR-03) e
respondem em < 5 ms nos casos típicos. Paginação por cursor opaco (§15.4).

| Query | Argumento | Resposta |
|---|---|---|
| `query.communities` | `{}` | `[{id,name,iconEmoji,iconColor,memberCount,isHostedByMe,hostStatus,unread:{count,mentions},endedAt}]` na ordem de entrada |
| `query.community` | `{communityId}` | Comunidade + `myPermissions[]` + `myRoleIds[]` + `myTopRolePosition` |
| `query.structure` | `{communityId}` | `{categories:[{...,channels:[{...,unread,muted,live}]}]}` |
| `query.messages` | `{channelId, cursor?, limit=50, direction:"before"\|"after"}` | `{messages[], nextCursor?, hasMore}` |
| `query.message` | `{messageId}` | Mensagem + resolvidos (autor, reações, anexo, thread) |
| `query.thread` | `{threadId, cursor?, limit=50}` | `{root, replies[], nextCursor?}` |
| `query.pinned` | `{channelId, cursor?, limit=25}` | Fixados, mais recente primeiro |
| `query.files` | `{channelId, cursor?, limit=25}` | Anexos do canal com estado local |
| `query.links` | `{channelId, cursor?, limit=25}` | URLs extraídas, **sem unfurl** (`spec:1166`) |
| `query.members` | `{communityId, filter?, cursor?, limit=100}` | Agrupado por cargo, offline agregado em contagem |
| `query.member` | `{communityId, identityKey}` | Perfil + cargos + `joinedAt` + `canModerate` |
| `query.roles` | `{communityId}` | Cargos por `position DESC` |
| `query.invites` | `{communityId}` | Convites ativos; `code` só nos que a identidade local criou |
| `query.auditLog` | `{communityId, type?, byKey?, from?, to?, cursor?, limit=25}` | Feed reverso |
| `query.bans` / `query.timeouts` | `{communityId, cursor?, limit=25}` | — |
| `query.search` | §15.1 | `{messages[], channels[], members[], partial:bool}` |
| `query.outbox` | `{communityId?}` | Itens pendentes/falhos com motivo |
| `query.hostStatus` | `{communityId}` | `{status, lastSeenAt, inactiveDays}` |

**`partial: true`** na busca quando o host está offline: é o que alimenta o banner
"Buscando só no histórico salvo neste dispositivo" (`spec:510`). A réplica local é parcial
por definição (premissa 6) — a busca **nunca mente** sobre isso.

### 10.5 RPC P2P — transporte

`protomux-rpc` sobre o stream do Hyperswarm. Protocolo `p2p-community/1`, um canal por
comunidade, chaveado pelo `coreKey`. Encoding `compact-encoding` nos dois sentidos.

| Parâmetro | Valor |
|---|---|
| Timeout de request | 15 000 ms (30 000 ms para `invite.redeem`, que appenda) |
| Concorrência por peer | 8 requests em voo; além disso, `E_BUSY` |
| Reconexão | O `rpcClient` reabre no `connection` seguinte; requests em voo falham com `E_HOST_UNAVAILABLE` e voltam para a outbox |
| Circuit breaker | 5 falhas consecutivas de conexão → pausa de 30 s antes de nova tentativa, com jitter |

### 10.6 RPC P2P — métodos

| Método | Request | Response | Erros | Quem atende |
|---|---|---|---|---|
| `hello` | `{clientVersion, opVersion}` | `{hostVersion, opVersion, coreLength, memberCount, capabilities[]}` | `E_VERSION_UNSUPPORTED` | host |
| `submitOp` | `{envelope}` | `{seq, hostTs, duplicate:bool}` | Todos os de §9.1 | host |
| `submitOps` | `{envelopes[≤32]}` | `[{seq\|error}]` | — | host |
| `inviteResolve` | `{challenge, proof}` | `InvitePreview` | `E_INVITE_INVALID` | host |
| `inviteRedeem` | `{challenge, proof, displayName, avatarColor}` | `{seq, coreKey, blobsKey, defaultChannelId}` | `E_INVITE_EXHAUSTED`, `E_BANNED` | host |
| `voiceJoin` | `{channelId}` | `{sessionId, roster[]}` | `E_PERMISSION_DENIED` | host |
| `voiceLeave` | `{sessionId}` | `{}` | — | host |
| `voiceState` | `{muted,deafened,cameraOn}` | `{}` | — | host |
| `shareStart` | `{channelId, codecConfig}` | `{sessionId, topology}` | `E_PERMISSION_DENIED` | host |
| `shareJoin` | `{sessionId, canRelay:bool, uplinkKbps}` | `{parentKey, level}` | `E_SESSION_GONE` | host |
| `shareHeartbeat` | `{sessionId, childCount, rttMs}` | `{assignment?}` | — | host |
| `shareLeave` | `{sessionId}` | `{}` | — | host |
| `presencePublish` | `{status, typingChannelId?}` | `{}` | — | host |
| `blobAnnounce` | `{blobId, hash}` | `{}` | — | host |

**Fluxo obrigatório na primeira conexão:** `hello` antes de qualquer outro método.
`opVersion` incompatível → o cliente entra em modo somente-leitura naquela comunidade e
emite `E_VERSION_UNSUPPORTED` para a UI. Nunca envia op que o host não entende.

### 10.7 Protocolo efêmero

Canal `protomux` separado (`p2p-ephemeral/1`) na mesma conexão, para não competir com a
replicação do core.

| Mensagem | Direção | TTL | Notas |
|---|---|---|---|
| `presence` | membro → host → todos | 30 s | `invisible` simplesmente não publica |
| `typing` | membro → host → canal | 5 s, refresh 3 s | `PRE-03` |
| `voiceRoster` | host → participantes | — | A cada mudança |
| `signal` | membro ↔ membro (**direto**, não pelo host) | — | SDP/ICE. `VOZ-17` fechado |
| `treeAssign` | host → nó | — | Atribuição de pai |
| `treeHeartbeat` | nó → host | 2 s | Ausência de 3 (6 s) = nó morto |

**A sinalização WebRTC é peer-a-peer, não pelo host.** Cada par abre uma conexão direta
pelo `hyperdht` usando a chave pública do outro (que veio no roster) e troca SDP/ICE ali.
Consequência boa e de graça: `VOZ-04` (falha assimétrica — Bianca não conecta com Ana mas
conecta com os outros) sai naturalmente, porque cada par é independente.

### 10.8 Protocolo de mídia (tela)

Stream UDX dedicado por aresta da árvore. Quadro:

| Campo | Tipo | Notas |
|---|---|---|
| `sessionId` | `bytes[16]` | — |
| `seq` | `uint32` | Monotônico por sessão |
| `ts` | `uint32` | ms relativos ao início |
| `flags` | `uint8` | bit0 `keyframe`, bit1 `configChanged` |
| `codecConfig` | `bytes?` | Presente só quando `configChanged` |
| `payload` | `bytes` | `EncodedVideoChunk` opaco |

**Regra que torna a árvore viável:** o nó de repasse **copia o quadro inteiro para os
filhos sem decodificar nem reencodar**. Ele não abre `payload`. É a diferença entre
viável e inviável (ADR-05).

| Parâmetro | Valor | Motivo |
|---|---|---|
| Keyframe | a cada 2 s **e** sob demanda quando um espectador entra | Entrada rápida sem esperar o GOP |
| Jitter buffer | 800 ms na folha + 250 ms por nível | Produz o atraso de 1–2 s declarado em §25 |
| Fanout do apresentador | ≤ 5 (`STAR_MAX_VIEWERS`, alinhado a `spec:653`) | Limiar estrela↔árvore |
| Fanout de nó de repasse | ≤ 3 | Mantém a árvore rasa e o upload de voluntário baixo |
| Bitrate default | 2 500 kbps (`high`) · 1 200 (`balanced`) · 600 (`low`) | Escolhido por quem assiste |
| Descarte | Quadro atrasado > 3 s é descartado, não bufferizado | É broadcast; acumular atraso é pior que perder quadro |

---

## 11. Fluxos (casos de uso)

Template fixo: **Entrada** · **Sequência** · **Regras** · **Persistência** · **Módulos** ·
**Resultado** · **Falhas** · **Efeitos colaterais**. A referência entre parênteses aponta
o fluxo equivalente na spec de UX.

### 11.1 Criar comunidade / virar host (A3)

**Entrada:** identidade existe; `community.create` com nome válido.
**Sequência:**
1. `corestore.namespace(random)` → cria core `log` e core `blobs`. As chaves nascem aqui;
   o `communityId` é o hex do `coreKey`.
2. Monta o **lote de bootstrap** — 6 ops assinadas, na ordem: `community.create`,
   `role.create`(Fundador), `role.create`(Membro, base), `member.join`(o host),
   `category.create`(GERAL), `channel.create`(#geral, texto).
3. `core.append(lote)` — **uma chamada, atômica**. Ou os 6 registros entram, ou nenhum.
4. `swarm.join(coreKey, {server:true})` + `swarm.join(blobsKey, {server:true})`.
5. Sobe o `rpcServer` e o roster para esta comunidade.
6. Projeta os 6 registros pelo caminho normal (§6.4) — o host **não** tem atalho.

**Regras:** `hostKey = identity.publicKey`, imutável. O Fundador recebe as 17 permissões;
o cargo base recebe `send_messages`, `attach_files`, `add_reactions`, `voice_speak`
(idêntico a `BASE_MEMBER_PERMISSIONS`, `frontend/src/mocks/dataset.ts:136`). A comunidade
**nunca** nasce sem canal.
**Persistência:** 2 cores novos no corestore; 6 registros; projeção completa.
**Módulos:** `corestore`, `identity`, `opCodec`, `communityHost`, `swarm`, `projector`.
**Resultado:** `{communityId, defaultChannelId}`; eventos `community.joined` +
`structure.changed`.
**Falhas:** disco cheio no `append` → `E_STORAGE_FULL`, os cores criados são descartados;
`swarm.join` falha → a comunidade **existe e funciona localmente**, e entra em
`hosting-degraded` até o swarm subir. Criar uma comunidade nunca depende de rede.
**Efeitos colaterais:** o rail ganha um ícone; o processo passa a hospedar.

### 11.2 Boot: abrir e replicar comunidades participadas

**Entrada:** fase `open` do §2.3.
**Sequência:** para cada linha de `communities`, em paralelo com concorrência máxima de
`OPEN_CONCURRENCY` (default 4): abre o core → `projector.catchUp` a partir de
`last_projected_seq` → `swarm.join(coreKey)` + `swarm.join(blobsKey)` → se
`is_hosted_by_me`, sobe o servidor RPC.
**Regras:** ADR-16 — **todas** as comunidades participadas entram no swarm, não só a
ativa, senão o traço de não-lida do rail (`UNR-02`) é impossível. A comunidade ativa tem
prioridade: é aberta primeiro e seu `catchUp` roda antes dos outros.
**Persistência:** avanço de `last_projected_seq`.
**Módulos:** `corestore`, `projector`, `swarm`, `communityClient`.
**Resultado:** `core.ready`; a UI já tem dado antes de qualquer peer conectar (a réplica
local é suficiente para ler).
**Falhas:** core corrompido → reprojeta; falha de novo → aquela comunidade fica
`degraded`, as outras seguem. **Uma comunidade quebrada nunca impede o app de abrir.**
**Efeitos colaterais:** `swarm.changed` conforme peers aparecem.

### 11.3 Enviar mensagem com host online (C9)

**Entrada:** `message.send` do renderer.
**Sequência:**
1. `validator` roda **local** (mesma função do host, §9.2). Falhou → `E_VALIDATION`
   **síncrono**, nada é enfileirado, a UI mostra inline.
2. Monta a `Op`, assina, calcula `opId`. Grava em `local_outbox` com `state='queued'`.
3. Responde `{opId, state}` imediatamente. A UI já desenha a mensagem otimista.
4. `outbox.flush` pega o item, marca `sending`, chama `rpcClient.submitOp`.
5. Host: pipeline de §9.1 → `core.append` → devolve `{seq, hostTs}`.
6. Cliente: remove da outbox, emite `message.accepted`. A projeção do append chega pela
   replicação e emite `messages.appended`.

**Regras:** o `clientRef` do argumento volta em `message.accepted` para a UI casar a
mensagem otimista com a real. A mensagem otimista é renderizada na posição de `op.ts` e
**assenta no fim** quando recebe `seq` (§5.5) — delta de UX registrado em §25.
**Persistência:** `local_outbox` (transitória) → core do host → projeção em toda réplica.
**Módulos:** `validator`, `opCodec`, `outbox`, `rpcClient`, `communityHost`, `projector`.
**Resultado:** mensagem visível para todos.
**Falhas:** `E_HOST_UNAVAILABLE` → volta a `queued`, backoff (§6.5); erro terminal →
`message.dropped` com motivo; timeout com a op **já aplicada** → o retry devolve
`duplicate:true` e o `seq` original, sem duplicar (ADR-12).
**Efeitos colaterais:** `unread.changed` para os outros; `typing.changed` limpa o autor.

### 11.4 Convite: emitir → resolver → resgatar (A2)

**Emitir.** `invite.create` gera `secret` = 10 bytes aleatórios criptográficos.
`codeHash = BLAKE2b('invite/1' ‖ secret)`. A op leva **só o hash**. O `secret` é gravado
em `invites.secret` **só na réplica de quem criou** — é o que permite re-exibir o código
em 3.1b. O código exibido é Crockford-Base32(secret), 16 caracteres, em 4 grupos.

**Anunciar.** O host faz `swarm.join(BLAKE2b('invite-topic/1' ‖ codeHash))` para cada
convite ativo. O tópico deriva do **hash**, não do segredo: quem observa o DHT não
consegue voltar ao código.

**Resolver (preview).**
1. O candidato deriva `codeHash` do código digitado, calcula o tópico e conecta.
2. O host manda `challenge` (16 bytes aleatórios).
3. O candidato responde `proof = BLAKE2b('invite-auth/1' ‖ secret ‖ challenge)`.
4. O host recomputa. Diferente → `E_INVITE_INVALID`, e **a conexão é fechada** (não há
   segunda tentativa na mesma conexão — é o que impede força bruta online).
5. O host avalia, nesta ordem: comunidade `ended`? → `ended`. Candidato banido? →
   `banned` (sem contagem, sem convidador). Convite revogado/expirado/esgotado? →
   `invalid`. Já é membro? → `already-member`. Senão → `ok` com nome, ícone,
   `memberCount` e quem convidou.

**Resgatar.**
1. `inviteRedeem` com a mesma prova + `displayName` + `avatarColor`.
2. O host **serializa por comunidade** (§12.3): reavalia tudo, incrementa `uses`,
   appenda `member.join` num lote atômico com o incremento.
3. Devolve `{seq, coreKey, blobsKey, defaultChannelId}`.
4. O cliente grava a comunidade, faz `swarm.join` dos dois cores e projeta do zero.

**Regras:** contagem de usos **só no host** (`INV-10`). Sem aprovação manual — a spec de
UX corta isso explicitamente (`spec:1153`); a mitigação de link vazado é revogar.
**Falhas:** host offline em qualquer ponto → `unreachable` (novo desfecho, §25); dois
candidatos no último uso → um entra, o outro recebe `E_INVITE_EXHAUSTED`, nunca os dois.
**Efeitos colaterais:** `memberCount` sobe; `members.changed`; a comunidade entra no rail.

### 11.5 Host offline → fila → reconexão → flush (B4)

**Entrada:** `rpcClient` perde a conexão ou o `hello` falha.
**Sequência:**
1. `host.wentOffline` é emitido após **2 falhas consecutivas** de conexão — não na
   primeira. Uma falha isolada é ruído de rede e piscaria o banner.
2. Toda escrita passa a enfileirar em vez de tentar. Leitura segue normal, da réplica
   local.
3. O `swarm` continua tentando (backoff de §13.3).
4. Conexão volta → `hello` → `host.reconnecting` → sucesso → `host.cameBack`.
5. `outbox.flush` entrega em ordem por canal; cada aceite emite `message.accepted`; ao
   esvaziar, `outbox.flushed{delivered}`.

**Regras:** `voice.join` com host offline é **bloqueado** com `E_HOST_UNAVAILABLE` — o
host é o rendezvous e o autorizador (`VOZ-09`, §11.16). Ops de **estrutura** (canal,
categoria, cargo) **não entram na fila**: falham na hora com `E_HOST_UNAVAILABLE`. Isso é
deliberado e a spec de UX já o previu (`spec:1134`): estrutura não é replicável
otimisticamente; mensagem é.
**Persistência:** `local_outbox` sobrevive a fechar e reabrir o app (premissa 5).
**Falhas:** item passa de 72 h → `dropped/expired`; outbox cheia → `E_OUTBOX_FULL`.
**Efeitos colaterais:** o banner soma a contagem de pendentes; o rail perde o dot ao
voltar.

### 11.6 Editar e deletar mensagem

**Editar:** só o autor (`E_CANNOT_EDIT_OTHERS` para qualquer outro, inclusive moderador —
moderação apaga, não reescreve). Conteúdo vazio é rejeitado; esvaziar se resolve com
deletar (`spec:1053`). A projeção grava `edited_at`; o conteúdo antigo **fica no log** e é
recuperável por quem inspecionar o core. §25 obriga a spec de UX a dizer isso.

**Deletar:** própria mensagem, ou `manage_messages` + hierarquia. A projeção marca
`deleted_at`, apaga reações (`spec:1125`), remove da FTS, e some da aba Fixados
(`spec:1139`) — tudo na mesma transação. O registro **continua no log** (ADR-10): "não
pode ser desfeito" é verdade para a interface, não para os bytes. §25.

Deletar de outro autor gera entrada no log de auditoria; a própria, não.

### 11.7 Criar canal (D14)

**Entrada:** `channel.create` com `manage_channels`.
**Sequência:** valida (slug revalidado no host, §9.3) → `submitOp` → host appenda →
projeta → `structure.changed` → a UI navega para o canal novo.
**Regras:** entra **no fim** da categoria (`spec:1062`); nome único por
`(comunidade, tipo)` e **bloqueante**; canal de voz preserva caixa e espaço.
**Falhas:** `E_CHANNEL_NAME_TAKEN` (a UI mostra inline no blur), `E_CHANNEL_NAME_EMPTY`,
`E_HOST_UNAVAILABLE` (não enfileira — §11.5).
**Efeitos colaterais:** entrada no log de auditoria (`spec:786`); categoria colapsada
expande sozinha na UI (`spec:1135`).

### 11.8 Excluir canal com chamada acontecendo (D15)

**Entrada:** `channel.delete` de um canal de voz com participantes.
**Sequência:** valida (não é o último canal) → appenda → **o host encerra a sessão de voz
imediatamente**, emitindo `voice.failed{reason:"channel-deleted"}` a cada participante →
projeta o tombstone → `structure.changed`.
**Regras:** a exclusão **prevalece** sobre quem entra no mesmo instante (`spec:1132`) —
o roster é do host e ele já sabe que o canal morreu. Ninguém fica "conectado a canal
inexistente".
**Efeitos colaterais:** a barra de chamada persistente some; quem estava com o canal
aberto cai no primeiro canal de texto; entrada no log de auditoria.

### 11.9 Descarte de fila quando o destino some

**Entrada:** `channel.delete` projetado, ou `community.leave`/`community.end`, com itens
`queued` daquele canal/comunidade.
**Sequência:** `outbox.drop(channelId, reason)` marca os itens `dropped` → emite
`message.dropped` um por item → a UI agrega numa frase nomeada
("2 mensagens não foram enviadas: #ajuda-design não existe mais").
**Regras:** nunca some calado, nunca fica pendente para sempre (`spec:1136`).
**Motivos possíveis:** `channel-deleted`, `left-community`, `community-ended`,
`banned`, `expired`, `permission-lost`.

### 11.10 Cargos: criar, mover, atribuir (D13)

**Criar:** `role.create` nasce com `position` = topo do autor − 1, empurrando os de baixo.
A projeção renumera denso na mesma transação.
**Mover:** `role.move` com a posição alvo; o host recalcula toda a faixa afetada e devolve
`positions[]` para a UI aplicar de uma vez, sem N eventos.
**Atribuir:** `member.setRoles` com a lista completa (não é delta — a lista substitui).
Cargo base obrigatório; nenhum cargo `>=` topo do autor.
**Regras:** Fundador travado no topo (`E_FOUNDER_TOP`); sem escalada de permissão
(`E_PERMISSION_ESCALATION`, §8.3); deletar cargo com membros mantém os membros
(`spec:732`).
**Efeitos colaterais:** `memberCount` de cargo recalculado; `roles.changed` +
`members.changed`; **se a identidade local perder `manage_channels`**, a UI fecha o modal
de 3.4 na próxima interação (`spec:1133`) — o núcleo só emite o evento, quem fecha é a UI.

### 11.11 Banir (D12)

**Entrada:** `mod.ban` com `ban_members` + hierarquia.
**Sequência:**
1. Valida (alvo não é Fundador, não é o próprio autor, hierarquia estrita).
2. Appenda `mod.ban`.
3. A projeção, **numa transação**: insere em `bans`, marca `members.banned=1`, marca
   `hidden_by_ban=1` em todas as mensagens do alvo naquela comunidade, remove-as da FTS,
   decrementa `memberCount`, insere no `moderation_log`.
4. O host adiciona a chave ao `firewall` do swarm e **derruba a conexão ativa** do alvo.
5. Se o alvo estava em voz, é removido do roster.

**Regras:** ocultar é **reversível** — `mod.revokeBan` reexibe (§4.12). §25 obriga a
corrigir o texto da spec de UX, que hoje sugere remoção permanente. A nota de honestidade
sobre identidade nova continua verdadeira e o backend **não tenta** heurística.
**Falhas:** alvo já banido → idempotente, sem segunda entrada no log.
**Efeitos colaterais:** `members.changed`, `messages.appended` de recontagem,
`community.changed{memberCount}`; o alvo recebe `E_BANNED` na próxima op e, no preview de
convite, `banned`.

### 11.12 Timeout

`mod.timeout` grava `until`. Enquanto `until > now`, o **estágio 8** do pipeline recusa
toda op de escrita do alvo com `E_TIMED_OUT` (`MOD-05`), exceto `member.leave`. Expira
**sozinho**, por comparação na leitura — sem job, portanto sem risco de divergência entre
réplicas. A contagem regressiva da UI é local.

### 11.13 Anexar arquivo (upload)

**Entrada:** `blob.stage` com caminho local, `attach_files`.
**Sequência:** lê em stream → calcula BLAKE2b enquanto lê (uma passada só) →
`hyperblobs.put` no core de blobs → devolve `{blobId, hash, sizeBytes, kind}` → o
renderer chama `message.send` com a referência.
**Regras:** `sizeBytes ≤ ATTACHMENT_MAX_BYTES` (8 GiB, `ARQ-03` fechado); **1 anexo por
mensagem** no v1; `kind` inferido da extensão, com `other` como default; o host revalida
`sizeBytes` contra `blobId.byteLength`.
**Persistência:** blocos no core de blobs (replicado sob demanda), linha em
`local_blob_cache` marcada `owned`.
**Falhas:** arquivo ilegível → `E_FILE_UNREADABLE`; grande demais → `E_ATTACHMENT_TOO_LARGE`
antes de ler um byte; `message.send` falha depois do `stage` → blob órfão, coletado pelo
GC (§13.6).
**Efeitos colaterais:** quem já tem o blob **serve automaticamente** — é replicação, não
upload dedicado. `ARQ-05` (seeding sem consentimento) fica como está: o custo é de disco,
não de banda de saída sustentada.

### 11.14 Baixar arquivo (B8)

**Entrada:** `blob.download`.
**Sequência:** `hyperblobs.get` com range → o Hypercore busca os blocos dos peers que os
têm → progresso a cada 500 ms em `blob.progress{progress, peers, hostAvailable}` → ao
completar, **verifica o hash** → grava em `blobs/<communityId>/` → `blob.completed{path}`.
**Regras:** download é **sob demanda** (sparse) — ninguém baixa o que não abriu.
`availablePeers` e `hostAvailable` saem da lista real de peers replicando o range
(`ARQ-01`), não de estimativa.
**Falhas:** peer cai no meio → o bitfield do Hypercore continua dos restantes, **sem
reiniciar** (`ARQ-06`), e `blob.peerLost{remaining}` alimenta a frase "1 peer
desconectou, continuando com 2"; zero peers e host offline → `blob.unavailable`; hash não
bate → `attachment.corrupt`, arquivo descartado.
**Efeitos colaterais:** a partir daí este nó também serve o arquivo.

### 11.15 Busca (C10)

**Entrada:** `query.search` com `{query, filters, scope}`.
**Sequência:** monta a consulta FTS5 (§15.1) → junta com `messages`/`channels`/`members`
→ aplica filtros → limita a 20 por grupo → devolve com `partial` = host offline.
**Regras:** 100 % local, sobre a réplica que existe (premissa 6). Só canais de texto —
voz não tem histórico. Ordenação por **recência**, não por relevância (§15.2).
**Falhas:** consulta que vira token vazio depois da normalização → resultado vazio, não
erro.

### 11.16 Entrar em canal de voz (B7)

**Entrada:** `voice.join` com `voice_speak`.
**Sequência:**
1. `voiceJoin` ao host (rendezvous e autorizador — é isto que fecha `VOZ-09`).
2. O host valida a permissão, adiciona ao roster, faz fan-out de `voiceRoster` a todos.
3. Para **cada** peer do roster, o cliente abre conexão direta pelo `hyperdht` (chave
   pública do peer) e troca SDP/ICE por ali (§10.7).
4. `RTCPeerConnection` por par, com os candidatos ICE derivados do endereço público que
   o `hyperdht` já conhece (ADR-06).
5. Falha de ICE num par → **só aquele par** cai para transporte UDX (ADR-07);
   `voice.meshChanged{peerKey, status:"degraded"}`.

**Regras:** depois do passo 2 a mídia é ponta a ponta e **o host não vê nada**. Falha
assimétrica é o comportamento natural, não um caso especial (`VOZ-04`). Entrar com
presença `invisible` publica presença mesmo assim (`spec:1137`) — voz é presença.
**Falhas:** host offline → `E_HOST_UNAVAILABLE` **antes** de tentar mídia; nenhum par
conecta → `voice.failed`, a UI mostra "Não foi possível conectar" com "Tentar novamente".
**Efeitos colaterais:** o item de canal ganha os avatares inline; a barra persistente
aparece; a sessão sobrevive a trocar de canal e de comunidade (C11) porque vive no núcleo,
não na navegação.

### 11.17 Compartilhar tela: estrela → árvore → reparo (B5)

**Entrada:** `share.start` com `voice_share_screen`, dentro de uma chamada.
**Sequência:**
1. O renderer captura (`getDisplayMedia`, roteado pelo `setDisplayMediaRequestHandler` do
   main) e codifica com `VideoEncoder`.
2. `shareStart` ao host → `{sessionId, topology:"star"}`.
3. Chunks vão ao núcleo por `MessageChannel` (`ArrayBuffer` transferível, zero cópia).
4. Cada espectador chama `shareJoin{canRelay, uplinkKbps}` e recebe `{parentKey, level}`.
5. **Enquanto viewers ≤ 5:** todos têm `parentKey` = apresentador (estrela).
6. **No 6º viewer:** o host recalcula (§11.17.1), emite `share.topologyChanged{tree}` e
   `share.assignment` a cada nó afetado. A UI mostra "Otimizando distribuição…".
7. Cada nó de repasse encaminha o quadro **sem decodificar** (§10.8).
8. Heartbeat de 2 s; 3 ausências (6 s) = nó morto → recálculo → reatribuição →
   `share.treeHealth{repairing}` → estabiliza em `ok`.

**11.17.1 Algoritmo da árvore (fechado):**
- Candidatos a repasse: consentimento aceito **e** `uplinkKbps ≥ 1,5 × bitrate ×
  fanout` **e** NAT não-CGNAT. Isso fecha `TELA-07`, que estava aberto: o critério é
  **medido**, não declarado — `uplinkKbps` vem de estatística real do UDX numa janela de
  10 s, não de auto-declaração.
- O host é sempre candidato e tem **prioridade nos primeiros níveis**
  (`CLAUDE.md:17-18`).
- Ordena candidatos por `(uplink desc, rtt asc)`; preenche o nível 1 até 5 filhos do
  apresentador; cada nó de repasse recebe até 3 filhos; folhas são o resto.
- Recalcula em: entrada/saída de viewer, morte de nó, mudança de consentimento. O
  recálculo é **incremental** — só quem muda de pai recebe `share.assignment`. Reatribuir
  a árvore inteira a cada entrada causaria um congelamento visível em todo mundo.

**Regras:** o espectador é **participante do canal de voz** (premissa 5 do backend); não
existe audiência fora da chamada. §25 registra que a fixture de `TELA-04` (7 espectadores
num canal com 3 participantes) contradiz isso e precisa ser corrigida.
**Falhas:** apresentador com CGNAT e sem voluntário → `share.failed`, os espectadores veem
"Falha ao conectar à transmissão" (distinto de "carregando"); nó morre e não há substituto
→ os órfãos viram filhos diretos do apresentador, mesmo estourando o fanout — degradar é
melhor que cortar.
**Efeitos colaterais:** **atraso de 1–2 s** para espectador em árvore, somando por nível
(§10.8). É broadcast, não chamada, e §25 obriga a interface a admitir isso.

### 11.18 Consentimento de repasse (B6)

Disparado **na transição estrela→árvore**, não a cada espectador novo — perguntar de novo
a cada entrada viraria insistência. O núcleo emite `share.consentRequested{relayCount}`;
a UI mostra o modal 2.4.1; `share.respondConsent{accept, remember}` grava em
`local_relay_consent` quando `remember`.
**Regra que não pode ser violada:** **nunca** assumir recusa por timeout ou por aba
inativa. Se a resposta não vier, o host escolhe outro candidato e a pergunta continua
pendente até a pessoa voltar (`spec:903`).

### 11.19 Relay voluntário (ADR-08)

**Entrada:** `relay.enable` — exige consentimento explícito **e persistido**
(`E_CONSENT_REQUIRED` sem ele).
**Sequência:** sobe um `blind-relay` local → anuncia a chave no DHT → appenda
`relay.volunteer` → todo membro recebe a lista pela replicação → ao falhar o furo
(`CANNOT_HOLEPUNCH`, `HOLEPUNCH_DOUBLE_RANDOMIZED_NATS`), `relayThrough` escolhe o
voluntário de **menor RTT** medido localmente.
**Regras:** blind relay **não lê nada** — o tráfego UDX é cifrado ponta a ponta. O host
entra na lista automaticamente se for capaz.
**Falhas:** nenhum voluntário → `conn-failed`, estado que a spec de UX já sabe desenhar
(`spec:296`, `spec:1034`). Não é crash.
**Delta de UX (§25):** essa escolha exige uma superfície de consentimento nova em
3.1 → Rede, irmã do modal 2.4.1 — pedir permissão para usar o upload de alguém em tráfego
que **não é** da árvore que essa pessoa está assistindo.

### 11.20 Saída do host (3.5)

**Entrada:** o main intercepta o fechamento e chama `host.exitImpact`.
**Sequência:** o núcleo devolve, por comunidade hospedada, `{onlineCount, inCallCount}`
lidos do roster **efêmero** (não da projeção — o que importa é quem está conectado
agora). A UI mostra o modal. Se o usuário escolher "Avisar quem está online", o main
chama `host.notifyBeforeExit`, que appenda uma `message.send` **assinada pelo host** no
canal padrão de cada comunidade afetada. Confirmando a saída, o main envia
`core.shutdown` e o núcleo entra em `draining` (§2.3).
**Regra que fecha `HOST-04`:** o `draining` tem orçamento de **3000 ms** para fazer flush
da outbox e `core.flush()`. Estourou, registra `shutdown.forced` com a contagem e encerra
mesmo assim. A alternativa — segurar o fechamento indefinidamente — é pior: o usuário mata
o processo e nada é gravado.
**Efeitos colaterais:** todos os membros veem `host.wentOffline` em até ~2 s.

### 11.21 Encerrar comunidade

`community.end` só pelo `hostKey`. Appenda a op, projeta `ended_at`, **para de aceitar
qualquer op**, sai do swarm como servidor mas **mantém o core** em leitura. Membros veem
`community.ended` e a comunidade fica no rail em modo histórico. Não há undo (ADR-10).

### 11.22 Sair da identidade

`identity.wipe`: para o swarm, fecha os cores, fecha o SQLite, apaga `p2p/` inteiro,
apaga a chave do keystore, reinicia o núcleo em `awaiting-identity`. **Irreversível e sem
confirmação no backend** — a confirmação é da UI. Nada é enviado à rede: as comunidades
hospedadas simplesmente somem para todos, indistinguível de host permanentemente offline.

---

## 12. Concorrência e idempotência

### 12.1 Onde há concorrência de verdade

| Cenário | Resolução |
|---|---|
| Dois moderadores editam o mesmo cargo | Ordem de chegada no host; **maior `seq` vence**, campo a campo (o payload de `role.update` carrega só os campos alterados). Sem merge, sem conflito visível |
| Dois candidatos no último uso de um convite | Fila serializada por comunidade (§12.3) — um entra, o outro recebe `E_INVITE_EXHAUSTED` |
| Mensagem enviada no instante em que o canal é excluído | O host processa em ordem: se o `channel.delete` chegou antes, a mensagem falha com `E_CHANNEL_NOT_FOUND` (terminal, vira `dropped`) |
| Alguém entra em voz no instante da exclusão do canal | A exclusão prevalece (§11.8) |
| Ban aplicado enquanto o alvo envia | A op do alvo chega depois do ban → `E_BANNED`; chega antes → é aceita e depois **ocultada** pela projeção do ban |
| Dois `reaction.toggle` do mesmo emoji, mesma pessoa | Dedupe por `opId` (ADR-12) se for reenvio; se forem dois cliques reais, são dois `opId` distintos e o estado final é o de maior `seq` |
| Duas instâncias do app | Impossível: lock de diretório (ADR-20) |
| Projeção e leitura simultâneas | WAL do SQLite: leitor não bloqueia escritor. O projetor é o **único escritor** das tabelas de projeção |

**A afirmação central:** com ADR-01, **não existe conflito de escrita**. Só existe ordem
de chegada, e o host a define. Toda a categoria de problema que a spec de UX marcou como
"fora do escopo de resolução real" (`spec:1126`) some — a resposta é "maior `seq` vence",
e ela é determinística.

### 12.2 Idempotência

| Operação | Chave | Comportamento no reenvio |
|---|---|---|
| Qualquer op | `opId` (ADR-12) | Devolve `{seq, duplicate:true}` — sucesso, sem appendar |
| `message.delete` de mensagem já deletada | — | Sucesso, sem nova entrada de auditoria |
| `mod.ban` de já banido | — | Sucesso, sem nova entrada |
| `mod.removeTimeout` sem timeout | — | Sucesso |
| `invite.revoke` de já revogado | — | Sucesso |
| `relay.withdraw` sem voluntariado | — | Sucesso |
| `blob.download` já baixado | — | `blob.completed` imediato |
| `channel.markRead` | — | Sucesso, `unreadCount:0` |
| `voice.join` no mesmo canal | — | Devolve a sessão existente, não recria |

**Regra geral:** toda operação de escrita é idempotente por `opId`, e as de efeito
convergente (deletar, banir, revogar) são idempotentes **também** por estado final. Um
comando repetido nunca produz efeito duplo, nunca produz erro por já ter acontecido.

**Janela de dedupe:** 7 dias, podada pelo job de §13.6. Isso é 2,3× a idade máxima de um
item de outbox (72 h), com folga deliberada.

### 12.3 Serialização no host

Uma **fila de uma via por comunidade** no `communityHost`. Toda op passa por ela; o
processamento é estritamente sequencial. Isso não é gargalo: a validação é ~60 µs (dominada
pela verificação Ed25519) e o `append` é assíncrono em lote.

`submitOps` (lote de até 32) existe para amortizar o RTT quando a outbox esvazia depois de
um período offline. O host processa o lote **na ordem**, para no primeiro erro terminal, e
devolve um resultado por item — os anteriores ficam aplicados.

**Throughput alvo:** ≥ 500 ops/s por comunidade no host. Acima disso o rate limit por
autor (§19.3) já teria mordido antes.

### 12.4 Reentrância proibida

- O `projector` **nunca** é reentrante: um lote por comunidade por vez, garantido por
  flag. Um `append` que chegue durante um lote é processado no lote seguinte.
- Um reducer **nunca** chama outro reducer nem enfileira op. Reducer é `(op, tx) → void`.
- Um handler de evento IPC **nunca** dispara comando de escrita no núcleo. Se a UI precisa
  reagir a um evento com uma escrita, quem decide é a UI.

---

## 13. Processamento assíncrono, jobs e tarefas

### 13.1 Loops permanentes

| Loop | Período | O que faz | Onde |
|---|---|---|---|
| `projector` | reativo a `append` | §6.4 | todo nó |
| `outbox.flush` | 1 s, ou imediato em `host.cameBack` | Entrega itens `queued` cujo `next_attempt_at` passou | todo nó |
| `presence.refresh` | 10 s | Republica presença (TTL 30 s) | todo nó |
| `typing.expire` | 1 s | Remove quem passou de 5 s | todo nó |
| `tree.heartbeat` | 2 s | Nó → host | nó de repasse |
| `tree.watchdog` | 2 s | Host detecta nó morto (6 s sem heartbeat) e recalcula | host |
| `blob.progress` | 500 ms | Emite progresso dos downloads ativos | quem baixa |
| `metrics.flush` | 10 s | Consolida histogramas | todo nó |

### 13.2 Jobs periódicos

| Job | Período | O que faz |
|---|---|---|
| `dedupe.prune` | 1 h | Remove `local_dedupe` com `first_seen_at` > 7 d |
| `outbox.expire` | 5 min | Marca `dropped/expired` itens com > 72 h |
| `timeout.notify` | 1 min | Emite `members.changed` para timeouts que acabaram de expirar (a expiração em si é por comparação, §11.12) |
| `invite.expireCheck` | 15 min | Sai do tópico DHT de convites expirados/esgotados — economiza anúncio inútil |
| `host.inactivity` | 6 h | Atualiza `inactiveDays`; ≥ `INACTIVE_COMMUNITY_DAYS` (default 30) alimenta o rótulo "Inativa há muito tempo" (`COM-10` fechado) |
| `blob.gc` | 24 h | §13.6 |
| `db.maintenance` | 24 h | `PRAGMA optimize`; `wal_checkpoint(TRUNCATE)` se o WAL passar de 64 MiB |
| `log.rotate` | 24 h | §17.1 |

### 13.3 Backoff de rede

Curva única, usada por reconexão de swarm, RPC e outbox:
`delay = min(BASE · 2^n, MAX) ± 20 %`, com `BASE` = 1000 ms e `MAX` = 60 000 ms. O jitter
não é enfeite: sem ele, 340 membros reconectam em fase depois de o host voltar e produzem
uma avalanche exatamente no pior momento.

### 13.4 Cancelamento

Todo job e todo loop recebe um `AbortSignal` do ciclo de vida da comunidade. Fechar uma
comunidade (sair, encerrar, `wipe`) aborta tudo dela em ≤ 100 ms. Nenhum job sobrevive ao
fechamento do seu escopo — é o que impede o "job zumbi escrevendo em banco fechado", que é
a causa clássica de crash no shutdown.

### 13.5 Prioridade

O núcleo é single-threaded (Node). A ordem de prioridade quando há disputa:
**1)** RPC de entrada (o host não pode ficar lento para os membros) · **2)** projeção ·
**3)** outbox · **4)** jobs periódicos · **5)** GC. O `blob.gc` e a reprojeção longa
cedem o event loop a cada `PROJECTOR_BATCH` registros, sempre.

### 13.6 GC de blobs

| Regra | Valor |
|---|---|
| Blob órfão (nenhuma mensagem o referencia) e criado há > 24 h | Removido do cache local |
| Cache de blobs acima de `BLOB_CACHE_MAX_BYTES` (default 20 GiB) | Remove por LRU de `verified_at`, **exceto** os que a identidade local enviou |
| Blob de comunidade que a identidade deixou | Removido imediatamente |

O GC mexe **só no cache local** (`blobs/`). O core de blobs é append-only e não encolhe —
`core.clear()` é usado para liberar blocos locais, não para apagar o dado da rede.

---

## 14. Arquivos e blobs

### 14.1 Estrutura

Um `hyperblobs` por comunidade, sobre um core próprio (`blobsKey`). A mensagem carrega
**a referência**, nunca os bytes. Isso mantém o log da comunidade pequeno e replicável por
inteiro, enquanto os arquivos ficam sparse.

### 14.2 Regras que a documentação do ecossistema não afirma e que precisam ser código

1. **`swarm.join(blobsKey)` junto com o join da comunidade.** Estar conectado ao peer não
   é estar replicando aquele core. Sem esta linha, o download nunca começa e o sintoma é
   "0 peers" com o peer bem ali.
2. **Sparse por default.** Ninguém tem o que não abriu; `blob.download` é explícito.
3. **`core.clear()` é o GC local**, não uma deleção de rede (§13.6).
4. **Seeding é automático** para quem já tem os blocos — é replicação, não upload
   dedicado. `ARQ-05` fica como está.

### 14.3 Estados do arquivo (do ponto de vista de quem lê)

```
not-downloaded ──blob.download──▶ downloading ──hash ok──▶ downloaded ──▶ (seeding)
      ▲                               │                        │
      │                    peer perdido│ (continua dos outros)  │
      └──── unavailable ◀──────────────┘  zero peers + host off └── corrupt (hash ruim, descarta)
```

### 14.4 Contagem de peers e disponibilidade

`availablePeers` = número de peers conectados **que anunciam ter** os blocos do range do
blob (leitura do bitfield do Hypercore). `hostAvailable` = o `hostKey` está entre eles.
São **dados reais**, não estimativas — é o que `ARQ-01` pedia. `blob.unavailable` só é
emitido quando os dois zeram.

### 14.5 Onde os arquivos ficam no disco do usuário

`userData/p2p/blobs/<communityId>/<blobIdHex>-<nomeSanitizado>`. Abrir usa
`shell.openPath` no main, nunca no núcleo (`ARQ-09` fechado). O nome é sanitizado contra
travessia de caminho antes de tocar o filesystem (§18.4).

---

## 15. Busca, filtros, ordenação, paginação

### 15.1 Consulta

`query.search{query, filters:{authorKey?, channelId?, date?, kind?}, scopeChannelId?,
communityId, limitPerGroup=20}`.

| Etapa | Regra |
|---|---|
| Normalização | NFD, remove diacrítico, minúsculo — mesma função de `frontend/src/features/search/searchIndex.ts:28` |
| Tokens | Split por não-alfanumérico; tokens de 1 caractere são descartados |
| Match | `MATCH` no FTS5 com prefixo no último token (`revis*`), casando o comportamento de busca-enquanto-digita |
| `date` | `today` = início do dia local; `7d`/`30d` = janela a partir de agora |
| `kind` | `attachment` = tem anexo · `pinned` = `pinned=1` · `link` = `content` casa `https?://` |
| Escopo | `scopeChannelId` restringe **antes** dos filtros |
| Exclusões | Mensagens deletadas e `hidden_by_ban` nunca aparecem; canais de voz não são varridos (não têm histórico) |

Canais e membros respondem **só ao texto** — filtrar "autor" ou "anexo" não se aplica a
eles, e devolvê-los filtrados por critério que não os toca confundiria mais do que
ajudaria (decisão herdada de `spec:1415`).

### 15.2 Ordenação (fechada, por lista)

| Lista | Ordem |
|---|---|
| Mensagens de canal | `seq` crescente (cronológica) |
| Resultados de busca | `seq` **decrescente** — recência, não relevância. Sem corpus grande, ordenar por score seria teatro |
| Canais dentro de categoria | `position` (ordem de criação); canal novo no fim |
| Categorias | `position` (ordem de criação) |
| Cargos | `position` decrescente (topo primeiro) |
| Membros | Grupo pelo cargo mais alto (hierarquia desc), alfabético dentro do grupo por `nickname ?? displayName` |
| Comunidades no rail | Ordem de entrada/criação, nunca alfabética |
| Log de auditoria / banidos / timeouts | `seq` decrescente |
| Fixados | `seq` decrescente |

### 15.3 Paginação

| Superfície | Estratégia | Lote |
|---|---|---|
| Mensagens | Cursor por `seq`, bidirecional | 50 |
| Busca | Sem paginação: teto de 20 por grupo, com "ver todos" expandindo até 100 | 20/100 |
| Membros | Cursor; offline vem como **contagem agregada**, não como lista | 100 |
| Log de auditoria / banidos / timeouts | Cursor "carregar mais" | 25 |
| Fixados / arquivos / links | Cursor | 25 |

**Nunca há paginação numerada** (`spec:1154`). O cursor é `base64url({seq, id})` e é
opaco para o renderer — mudar a estratégia interna não quebra a UI.

### 15.4 Contrato do cursor

Cursor inválido ou de outra tabela → `E_BAD_CURSOR`, e a UI recomeça do início. Nunca
devolve resultado errado silenciosamente.

---

## 16. Tratamento de erros

### 16.1 Forma

Todo erro que cruza qualquer fronteira tem a mesma forma:
`{code, message, details?, retryAfterMs?, field?}`.

- `code`: da tabela abaixo, `SCREAMING_SNAKE` com prefixo `E_`. **É o contrato.**
- `message`: em **inglês**, para log e depuração. O texto em português é do renderer.
- `field`: presente em `E_VALIDATION`, nomeia o campo — é o que permite o erro inline de
  formulário que §13 da spec de UX exige.
- `retryAfterMs`: presente em `E_RATE_LIMITED` e em falhas transitórias com backoff
  conhecido.

### 16.2 Catálogo

| Código | Classe | HTTP eq. | Retenta? | Significado |
|---|---|---|---|---|
| `E_MALFORMED` | cliente | 400 | não | Quadro/payload não decodifica |
| `E_VALIDATION` | cliente | 400 | não | Campo fora dos limites de §9.2 |
| `E_UNKNOWN_COMMAND` | cliente | 404 | não | Comando IPC inexistente |
| `E_UNKNOWN_KIND` | cliente | 400 | não | `kind` de op desconhecido |
| `E_BAD_SIGNATURE` | segurança | 401 | não | Assinatura inválida |
| `E_AUTHOR_MISMATCH` | segurança | 401 | não | `op.author` ≠ chave do peer |
| `E_NOT_MEMBER` | autorização | 403 | não | Autor não é membro |
| `E_BANNED` | autorização | 403 | não | Autor banido |
| `E_TIMED_OUT` | autorização | 403 | **sim**, após `until` | Timeout ativo |
| `E_PERMISSION_DENIED` | autorização | 403 | não | Falta permissão |
| `E_HIERARCHY` | autorização | 403 | não | Alvo com cargo ≥ o do autor |
| `E_FOUNDER_IMMUNE` | autorização | 403 | não | Alvo é o Fundador |
| `E_FOUNDER_IMMUTABLE` | autorização | 403 | não | Cargo Fundador não é editável |
| `E_FOUNDER_TOP` | autorização | 403 | não | Fundador é sempre o topo |
| `E_PERMISSION_ESCALATION` | autorização | 403 | não | Conceder permissão que não tem |
| `E_BASE_ROLE_REQUIRED` | regra | 409 | não | Cargo base obrigatório / indeletável |
| `E_NOT_HOST` | autorização | 403 | não | Só o host pode |
| `E_HOST_CANNOT_LEAVE` | regra | 409 | não | Host encerra, não sai |
| `E_NICKNAME_SELF_ONLY` | regra | 403 | não | Apelido é auto-atribuído |
| `E_CANNOT_EDIT_OTHERS` | regra | 403 | não | Moderação apaga, não reescreve |
| `E_NOT_FOUND` | estado | 404 | não | Genérico |
| `E_CHANNEL_NOT_FOUND` | estado | 404 | não | Canal sumiu |
| `E_CHANNEL_NOT_VOICE` | estado | 409 | não | Canal errado para voz |
| `E_CATEGORY_NOT_FOUND` | estado | 404 | não | — |
| `E_MESSAGE_DELETED` | estado | 409 | não | — |
| `E_COMMUNITY_ENDED` | estado | 410 | não | Comunidade encerrada |
| `E_CHANNEL_NAME_TAKEN` | conflito | 409 | não | Nome duplicado (bloqueante) |
| `E_CHANNEL_NAME_EMPTY` | validação | 400 | não | Slug vazio |
| `E_LAST_CHANNEL` | regra | 409 | não | Último canal |
| `E_THREAD_EXISTS` | conflito | 409 | não | Já há thread na raiz |
| `E_REACTION_LIMIT` | regra | 409 | não | > 20 emojis distintos |
| `E_CHANNEL_READ_ONLY` | autorização | 403 | não | Somente-leitura para os cargos do autor |
| `E_INVITE_INVALID` | estado | 404 | não | Inválido/revogado/expirado |
| `E_INVITE_EXHAUSTED` | estado | 409 | não | Limite de usos |
| `E_INVITE_LIMIT` | regra | 429 | não | > 50 convites ativos |
| `E_ATTACHMENT_TOO_LARGE` | validação | 413 | não | > `ATTACHMENT_MAX_BYTES` |
| `E_ATTACHMENT_SIZE_MISMATCH` | segurança | 400 | não | `sizeBytes` ≠ `byteLength` |
| `E_PAYLOAD_TOO_LARGE` | validação | 413 | não | Envelope grande demais |
| `E_FILE_UNREADABLE` | infra | 400 | não | Arquivo local ilegível |
| `E_NOT_DOWNLOADED` | estado | 409 | não | Abrir antes de baixar |
| `E_NO_PEERS` | rede | 503 | **sim** | Zero peers com o blob |
| `E_RATE_LIMITED` | proteção | 429 | **sim** | + `retryAfterMs` |
| `E_OUTBOX_FULL` | proteção | 429 | não | Fila cheia |
| `E_HOST_UNAVAILABLE` | rede | 503 | **sim** | Host offline/inalcançável |
| `E_SWARM_DEGRADED` | rede | 503 | **sim** | Sem bootstrap/peers |
| `E_PEER_UNREACHABLE` | rede | 503 | **sim** | Sinalização não chegou |
| `E_TIMEOUT` | rede | 504 | **sim** | Estouro de prazo |
| `E_BUSY` | proteção | 429 | **sim** | Concorrência máxima |
| `E_SESSION_GONE` | estado | 410 | não | Sessão de tela acabou |
| `E_ALREADY_SHARING` | conflito | 409 | não | Já há compartilhamento |
| `E_CAMERA_LIMIT` | regra | 409 | não | > 6 câmeras (`spec:636`) |
| `E_CONSENT_REQUIRED` | regra | 403 | não | Relay sem consentimento |
| `E_VERSION_UNSUPPORTED` | compat. | 426 | não | `opVersion` incompatível |
| `E_BAD_CURSOR` | cliente | 400 | não | Cursor inválido |
| `E_IDENTITY_EXISTS` | conflito | 409 | não | Já há identidade |
| `E_KEYSTORE_UNAVAILABLE` | infra | 500 | não | `safeStorage` indisponível |
| `E_CORE_ALREADY_RUNNING` | infra | 409 | não | Lock ocupado |
| `E_CORE_CORRUPT` | infra | 500 | não | Core ilegível |
| `E_SCHEMA_AHEAD` | infra | 500 | não | Banco de versão futura |
| `E_STORAGE_FULL` | infra | 507 | não | Disco cheio |
| `E_INVARIANT` | bug | 500 | não | Invariante de §4.18 violada |
| `E_INTERNAL` | bug | 500 | **sim** (1×) | Não classificado |

### 16.3 Regras de tratamento

1. **Erro nunca vaza stack trace pelo IPC.** A stack vai para o log; o renderer recebe
   `code` + `message`.
2. **`E_INTERNAL` é bug até prova em contrário** e sempre gera log em `error` com
   `opId`/`cmd`.
3. **Erro de rede nunca vira erro de validação.** Confundir os dois faria o usuário achar
   que digitou errado quando a rede caiu — e é exatamente o erro que a spec de UX proíbe
   em `spec:1023`.
4. **Erro terminal em op enfileirada vira `dropped` com motivo nomeado**, nunca some
   calado (`spec:1136`).
5. **Falha parcial é reportada por item**, não pelo lote: `submitOps` devolve um resultado
   por envelope.

---

## 17. Logs e observabilidade

### 17.1 Log estruturado

NDJSON, uma linha por evento, em `logs/core-YYYY-MM-DD.ndjson`. Campos obrigatórios:
`ts`, `level`, `scope`, `msg`; opcionais conforme o contexto: `communityId`, `channelId`,
`opId`, `kind`, `seq`, `durMs`, `code`.

Níveis: `error` (bug ou falha inesperada) · `warn` (degradação esperada: host offline,
peer perdido) · `info` (marcos: boot, join, reprojeção) · `debug` (fluxo detalhado,
desligado em produção) · `trace` (por op, só com `P2P_LOG_LEVEL=trace`).

Rotação: diária, retenção `LOG_RETENTION_DAYS` (default 7), teto de
`LOG_MAX_TOTAL_BYTES` (default 200 MiB) com descarte do mais antigo.

### 17.2 Redação obrigatória

**Nunca aparecem no log, em nível nenhum:**

- conteúdo de mensagem (`content`), nome de anexo, tópico de canal;
- `secret` de convite e código de convite;
- chave privada, qualquer material derivado dela;
- payload de mídia.

**Aparecem:** chaves públicas (truncadas em 8 hex), ids, `seq`, `opId`, tamanhos,
contagens, códigos de erro, durações. A regra é implementada no `logger` por allowlist de
campos, não por blocklist — blocklist esquece o campo novo.

### 17.3 Métricas

Snapshot lido por `diag.snapshot` e usado por 3.1 → Rede.

| Métrica | Tipo | Uso |
|---|---|---|
| `swarm.peers` | gauge | "N peers conectados" |
| `swarm.natType` | gauge | `open`/`moderate`/`cgnat` — alimenta o texto de `CLAUDE.md:45` |
| `swarm.holepunchSuccessRate` | ratio | **Mede o "95 %" auto-reportado** (§24) |
| `rpc.latency` | histograma | p50/p95/p99 por método |
| `rpc.errors` | counter por código | — |
| `op.validated` / `op.rejected` | counter por `kind`/código | — |
| `projector.lag` | gauge | `core.length − last_projected_seq` |
| `projector.rate` | gauge | registros/s |
| `projector.badSignature` | counter | **> 0 é alarme de segurança** |
| `outbox.depth` / `outbox.dropped` | gauge/counter | — |
| `blob.throughput` | gauge | bytes/s |
| `tree.depth` / `tree.repairs` | gauge/counter | Saúde da árvore |
| `media.chunkDrop` | counter | Quadros descartados por atraso |
| `db.txDuration` | histograma | Transação de projeção |

### 17.4 Health

`core.status` devolve `phase` por comunidade. Uma comunidade é **saudável** quando:
`projector.lag < 100` **e** host alcançável (ou é o próprio) **e** `outbox.depth` sem item
com `attempts > 5`. Qualquer outra combinação é `degraded` e a UI tem token de cor para
isso (`conn-degraded`).

---

## 18. Segurança

### 18.1 Modelo de ameaça

| Adversário | Consegue | Não consegue | Mitigação |
|---|---|---|---|
| Membro comum malicioso | Enviar ops válidas para o que sua permissão autoriza; spam até o rate limit | Escalar permissão; agir acima da hierarquia; forjar autoria | §8, §9, §19.3 |
| Membro com cliente adulterado | Mandar payload arbitrário | Passar pelo validador do host | §9.1 — a UI nunca é enforcement |
| Ex-membro banido | Tentar reconectar; criar identidade nova | Reconectar com a mesma chave; ler dado novo | `firewall` + validação + preview `banned` |
| Host malicioso | Omitir, reordenar, truncar | **Forjar autoria** | Assinatura verificada em toda réplica (§7) |
| Observador do DHT | Ver que um tópico existe e quem conecta | Derivar o código de convite; ler tráfego | Tópico deriva do **hash**; tudo é cifrado ponta a ponta |
| Voluntário de relay | Ver volume e temporização do tráfego | Ler conteúdo | Blind relay: UDX cifrado ponta a ponta |
| Processo local do mesmo usuário | Ler o SQLite e o corestore | Ler a chave privada | `safeStorage` (ADR-19) |

**Limitações declaradas, no espírito do princípio 3 da spec de UX:** o host pode censurar
por omissão (detectável comparando o que se enviou com o log); pode reescrever história
truncando (detectável, não impedível); banimento não impede volta com identidade nova; não
há sigilo de metadados contra quem observa o DHT.

### 18.2 Criptografia

| Uso | Primitiva |
|---|---|
| Identidade e assinatura de op | Ed25519 (`hypercore-crypto`) |
| Hash de op, convite, anexo | BLAKE2b-256 |
| Transporte | Noise (`hyperdht`), com `remotePublicKey` verificada |
| Chave privada em disco | `safeStorage` do SO |
| Aleatoriedade | `sodium-native.randombytes_buf` — **nunca** `Math.random` |

Domínio de separação obrigatório em todo hash: prefixo de string (`'op/1'`, `'invite/1'`,
`'invite-topic/1'`, `'invite-auth/1'`). Sem isso, um hash de um contexto pode ser
reaproveitado em outro.

### 18.3 Superfície de rede

O núcleo **não escuta em nenhuma porta TCP/HTTP local**. Não há servidor local, nem
WebSocket, nem porta de debug em produção. A única entrada é o DHT/UDX do Hyperswarm.

### 18.4 Validação de entrada não-confiável

| Entrada | Regra |
|---|---|
| Envelope de RPC | Tamanho antes de decodificar (§9.1 estágio 1) |
| Nome de anexo | Sanitizado antes de tocar filesystem: remove `..`, `/`, `\`, `\0`, controle; nome final é `<blobIdHex>-<sanitizado>` |
| `content` de mensagem | Guardado **cru**; markdown é renderizado pelo renderer em elementos React, nunca por `innerHTML` (é como o frontend já faz em `lib/markdown.tsx`) |
| URL em mensagem | Extraída para a aba Links, **sem unfurl** — buscar a página vazaria o IP de todo mundo (`spec:1166`) |
| Caminho em `blob.stage` | Precisa vir de um diálogo de arquivo do SO; caminho arbitrário do renderer é recusado |
| Emoji de reação | 1 grafema, ≤ 24 bytes |
| Cursor de paginação | Decodificado e validado; inválido → `E_BAD_CURSOR` |

### 18.5 Regras permanentes

1. Nenhum `eval`, `Function`, `require` dinâmico com string vinda de dado.
2. Nenhuma dependência nova sem versão travada (`package-lock` commitado) e sem revisão de
   transitivas.
3. `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true` no renderer.
4. CSP do renderer sem `unsafe-inline` e sem host externo.
5. Nenhum dado sai do dispositivo sem ser para um peer da comunidade — **zero telemetria,
   zero analytics, zero crash reporter externo**.

---

## 19. Performance, limites e cache

### 19.1 Alvos (medidos em §21.6)

| Operação | Alvo | Teto aceitável |
|---|---|---|
| `query.messages` (50 msgs) | < 3 ms | 15 ms |
| `query.structure` | < 2 ms | 10 ms |
| `query.search` (10 k msgs) | < 30 ms | 120 ms |
| Validação de op no host | < 100 µs | 500 µs |
| `submitOp` ponta a ponta (LAN) | < 60 ms | 250 ms |
| Projeção | ≥ 8 000 reg/s | 3 000 reg/s |
| Boot até `core.ready` (5 comunidades, 50 k msgs) | < 1,5 s | 4 s |
| Memória do núcleo em repouso (5 comunidades) | < 250 MiB | 500 MiB |
| Latência de tela, folha em estrela | < 400 ms | 800 ms |
| Latência de tela, folha em árvore (nível 2) | < 1,5 s | 2,5 s |

### 19.2 Limites do sistema

| Limite | Valor | Ação ao estourar |
|---|---|---|
| Comunidades participadas | 50 | `E_VALIDATION` ao entrar na 51ª |
| Canais por comunidade | 500 | `E_VALIDATION` |
| Categorias por comunidade | 50 | `E_VALIDATION` |
| Cargos por comunidade | 100 | `E_VALIDATION` |
| Cargos por membro | 24 | `E_VALIDATION` |
| Convites ativos por comunidade | 50 | `E_INVITE_LIMIT` |
| Itens de outbox por comunidade | 500 | `E_OUTBOX_FULL` |
| Emojis distintos por mensagem | 20 | `E_REACTION_LIMIT` |
| Menções por mensagem | 64 | `E_VALIDATION` |
| Anexos por mensagem | 1 | `E_VALIDATION` |
| Câmeras simultâneas por chamada | 6 | `E_CAMERA_LIMIT` |
| Espectadores por sessão de tela | 200 | `E_SESSION_FULL` (`E_BUSY` na v1) |
| Conexões simultâneas no swarm | 128 | Novas ficam na fila do Hyperswarm |

**Escala de referência:** a comunidade do dataset tem 340 membros. Um escritor e muitos
leitores é o caso fácil do Hypercore; o gargalo é o **fan-out de conexões no host**, não o
log. Medir na fase 3 (§23) e recalibrar o limite de 128 conexões com dado real.

### 19.3 Rate limiting (no host, por autor, por comunidade)

Token bucket. Estourar devolve `E_RATE_LIMITED` com `retryAfterMs`; a outbox respeita e
não conta como tentativa falha.

| Escopo | Taxa | Burst |
|---|---|---|
| Todas as ops | 20 / 10 s | 40 |
| `message.send` | 10 / 10 s | 20 |
| `reaction.toggle` | 30 / 10 s | 45 |
| `message.edit` | 10 / 60 s | 15 |
| Ops de estrutura (`channel.*`, `category.*`, `role.*`) | 20 / 60 s | 30 |
| `invite.create` | 5 / 1 h | 5 |
| `mod.*` | 30 / 60 s | 40 |
| `inviteResolve` (por IP de peer, **pré-membro**) | 10 / 60 s | 10 |

O último é o que impede força bruta de convite pela rede — e é por peer, não por
identidade, porque quem resolve convite ainda não é membro.

### 19.4 Cache

Só onde há medição justificando. **Cada cache tem invalidação explícita, nunca TTL cego
sobre dado replicado.**

| Cache | Chave | Invalidado por | Tamanho |
|---|---|---|---|
| Permissões efetivas | `(communityId, identityKey)` | `roles.changed`, `members.changed` | 2 000 entradas LRU |
| Cargos por comunidade | `communityId` | `roles.changed` | por comunidade aberta |
| Estrutura (categorias+canais) | `communityId` | `structure.changed` | por comunidade aberta |
| Página de mensagens | `(channelId, cursor)` | `messages.appended`, `message.updated` do canal | 20 páginas LRU |
| Disponibilidade de blob | `(communityId, blobId)` | TTL 5 s **e** evento de peer | 500 entradas |
| Statements SQLite preparados | SQL | nunca (vive com a conexão) | todos |

**O que não tem cache, de propósito:** contagem de não-lidas (é uma query indexada de <1 ms
e ficaria errada com facilidade), roster de voz (é efêmero e a fonte é o host), e resultado
de busca (a query é barata e o resultado envelhece a cada mensagem).

### 19.5 Decisões de performance já tomadas

- **Statements preparados e reutilizados** — a projeção roda os mesmos ~30 SQLs milhões de
  vezes.
- **Uma transação por lote**, não por op: reduz fsync em ~250×.
- **`ArrayBuffer` transferível** para chunk de mídia: zero cópia entre renderer e núcleo.
- **Verificação Ed25519 é o custo dominante da projeção** e **não** é opcional (§7). Se
  virar gargalo, a otimização permitida é verificação em lote (`crypto_sign_verify_detached`
  em batch), nunca pular.
- **Índice `idx_messages_channel(channel_id, seq DESC)`** é o que faz a query de canal ser
  um range scan e não um sort.

---

## 20. Configuração e variáveis de ambiente

Precedência: **variável de ambiente > `config.json` em `userData` > default**. Resolvida
uma vez no boot e **congelada** (§3.2) — nada é hot-reload.

| Variável | Default | Faixa | Efeito |
|---|---|---|---|
| `P2P_DATA_DIR` | `<userData>/p2p` | caminho | Raiz de dados |
| `P2P_LOG_LEVEL` | `info` | `error`…`trace` | Verbosidade |
| `P2P_LOG_RETENTION_DAYS` | `7` | 1–90 | Retenção |
| `P2P_LOG_MAX_TOTAL_BYTES` | `209715200` | ≥ 10 MiB | Teto de log |
| `P2P_BOOTSTRAP` | bootstrap padrão do `hyperdht` | lista `host:port` | Nós de bootstrap do DHT (§22.1) |
| `P2P_DHT_PERSIST` | `true` | bool | Cacheia nós do DHT em disco |
| `P2P_STUN_SERVERS` | *(vazio)* | lista | ADR-06 — ligar reintroduz um terceiro |
| `P2P_MAX_CONNECTIONS` | `128` | 8–512 | Teto do swarm |
| `P2P_PROJECTOR_BATCH` | `256` | 32–2048 | Registros por transação |
| `P2P_REPROJECT_WARN_SEQ` | `100000` | ≥ 1000 | A partir daí mostra progresso |
| `P2P_OPEN_CONCURRENCY` | `4` | 1–16 | Comunidades abertas em paralelo |
| `P2P_OUTBOX_MAX_ITEMS` | `500` | 10–5000 | Por comunidade |
| `P2P_OUTBOX_MAX_AGE_MS` | `259200000` (72 h) | ≥ 1 h | Descarte por idade |
| `P2P_DEDUPE_TTL_MS` | `604800000` (7 d) | ≥ 24 h | Janela de idempotência |
| `P2P_CLOCK_TOLERANCE_MS` | `60000` | 1 s–1 h | Limiar de `clockSkewed` |
| `P2P_ATTACHMENT_MAX_BYTES` | `8589934592` (8 GiB) | ≥ 1 MiB | `ARQ-03` |
| `P2P_BLOB_CACHE_MAX_BYTES` | `21474836480` (20 GiB) | ≥ 1 GiB | GC de blobs |
| `P2P_STAR_MAX_VIEWERS` | `5` | 1–16 | Limiar estrela↔árvore (`TELA-02`) |
| `P2P_TREE_FANOUT` | `3` | 2–8 | Filhos por nó de repasse |
| `P2P_TREE_HEARTBEAT_MS` | `2000` | 500–10000 | — |
| `P2P_TREE_DEAD_AFTER_MS` | `6000` | ≥ 3× heartbeat | — |
| `P2P_INACTIVE_COMMUNITY_DAYS` | `30` | 1–365 | Rótulo "Inativa há muito tempo" (`COM-10`) |
| `P2P_RATE_*` | §19.3 | — | Um por linha da tabela |
| `P2P_TESTNET` | `false` | bool | Usa `hyperdht/testnet`, **nunca** a DHT pública (§21.2) |
| `NODE_ENV` | `production` no build | — | `≠ production` habilita `dev.*` (§10.2) |

**Regra:** nenhum valor de negócio fica hard-coded fora desta tabela. Quem precisar de um
número novo acrescenta uma linha aqui, com default e faixa.

---

## 21. Estratégia de testes

### 21.1 Unitários — os quatro módulos puros

`validator`, `permissions`, `opCodec`, `reducers` são puros (§3.3) e recebem cobertura
exaustiva, não amostral:

- **`validator`**: uma tabela de casos por `kind` × cada estágio do pipeline (§9.1) ×
  fronteira de cada limite de §9.2 (mín−1, mín, máx, máx+1). ~600 casos, todos síncronos,
  todos sem I/O.
- **`permissions`**: matriz de 17 permissões × 4 cargos do dataset × hierarquia
  (acima/igual/abaixo/Fundador). Inclui os dois casos de escalada de §8.3.
- **`opCodec`**: round-trip de todos os 29 `kind`s; encoding canônico estável (mesmo
  input ⇒ mesmo `opId`, byte a byte); tolerância a bytes extras no fim; rejeição de `v`
  desconhecido.
- **`reducers`**: cada `kind` contra um SQLite em memória, checando as 10 invariantes de
  §4.18 depois de cada aplicação.

**Meta:** ≥ 95 % de linha nesses quatro. Fora deles, cobertura não é meta — é sintoma.

### 21.2 Harness multi-instância

N núcleos no mesmo processo de teste, sobre `hyperdht/testnet` (`P2P_TESTNET=true`).
**Nunca toca a DHT pública.** Cenários obrigatórios, todos vindos de risco real:

1. Host cai no meio de um envio → a mensagem fica na fila e é entregue no retorno.
2. Membro volta depois de 1000 mensagens → projeta o atraso todo sem buraco.
3. Dois moderadores editam o mesmo cargo → maior `seq` vence, ambos convergem.
4. Banido tenta reconectar → `firewall` recusa antes do stream.
5. Convite com `maxUses:1` e dois candidatos simultâneos → um entra, um `E_INVITE_EXHAUSTED`.
6. Canal excluído com fila pendente → itens `dropped` com motivo `channel-deleted`.
7. Reenvio do mesmo envelope 3× → um único `seq`, `duplicate:true` nas repetições.
8. Timeout aplicado durante envio → op recusada com `E_TIMED_OUT`; expira e volta a passar.
9. Host sai com `draining` → nada de outbox é perdido dentro do orçamento de 3 s.
10. `opVersion` incompatível → cliente entra em somente-leitura sem enviar op.

### 21.3 Injeção de falha real

Cada botão do `DevBar.tsx` passa a derrubar, atrasar ou degradar algo de verdade no
núcleo (Apêndice B). É o que fecha `INF-05` e o item 1 do §19 da spec de UX. Em produção
o roteador `dev.*` **não existe**.

### 21.4 Reprojeção determinística

Apagar o `view.db` e reprojetar do `seq` 0 produz estado **idêntico** — comparado por hash
de um dump ordenado de todas as tabelas de projeção. Rodado em CI contra um core de
referência com ≥ 5 000 registros cobrindo os 29 `kind`s.

**É o teste que protege a ADR-02.** Se ele quebrar, a decisão de usar SQLite como view
descartável deixou de ser verdade e precisa ser reavaliada, não remendada.

### 21.5 Adversário

- Host modificado que appenda mensagem com autoria alheia → **toda** réplica rejeita na
  verificação e incrementa `projector.badSignature`.
- Cliente modificado que manda payload fora dos limites → recusado no estágio certo.
- Cliente que manda `op.author` de outra pessoa → `E_AUTHOR_MISMATCH`.
- Força bruta de convite: 10 000 tentativas em 60 s contra um host → todas recusadas, com
  fechamento de conexão por tentativa errada, e o rate limit de `inviteResolve` mordendo.

### 21.6 Performance

Benchmarks com **assert de limite** (falham o CI, não só reportam), contra os alvos de
§19.1. Dataset sintético: 3 comunidades, 100 k mensagens, 340 membros, 500 anexos.

### 21.7 Paridade com as fixtures

Os 15 fluxos de `spec:818-1013` rodados contra o backend real, com o dataset de referência
(§2 da spec de UX) recriado por script a partir de ops. **Se um fluxo precisa de estado
que o backend não produz, é buraco de backend, não de UI.**

### 21.8 Medição da árvore antes de confiar nela

Com 8 espectadores simulados: latência por nível e CPU do nó de repasse. Se o repasse
custar caro, a fase 7 vira **estrela-com-limite** e isso é registrado, não escondido.

---

## 22. Integrações externas

O produto é deliberadamente pobre em integrações. A lista é **completa**:

### 22.1 Bootstrap do DHT (única dependência de rede de terceiro)

Nós de bootstrap do `hyperdht` (default do pacote, sobrescrevível por `P2P_BOOTSTRAP`).
São contatados **uma vez** na entrada da DHT; depois o nó opera com a tabela de rotas
própria, persistida em disco (`P2P_DHT_PERSIST`).

**Falha:** todos inalcançáveis → `E_SWARM_DEGRADED`, retry com backoff (§13.3), e a UI
mostra "buscando peers". **O app continua funcionando em leitura local.** Perder o
bootstrap não perde dado.

**Risco declarado e mitigação:** é um ponto de centralização de fato. A mitigação é a
tabela persistida (um nó que já entrou uma vez volta a entrar sem bootstrap) e a
configurabilidade da lista.

### 22.2 `safeStorage` do SO

Keychain (macOS), DPAPI (Windows), libsecret/kwallet (Linux). Indisponível →
`E_KEYSTORE_UNAVAILABLE` e o app não prossegue (ADR-19). Em Linux sem serviço de secret,
esta é a falha de instalação mais provável e o erro precisa dizer isso.

### 22.3 STUN (desligado por default)

ADR-06. Só entra em cena se `P2P_STUN_SERVERS` for preenchida, e a interface precisa
avisar que ligar isso expõe o IP a um terceiro.

### 22.4 Não existem, e não devem ser introduzidos

Nenhum servidor de push, nenhum TURN, nenhuma API de unfurl de link, nenhum CDN, nenhum
analytics, nenhum crash reporter externo, nenhum serviço de update automático que fale
com host próprio. Introduzir qualquer um contradiz o princípio 1 da spec de UX e precisa
virar ADR nova, não decisão de implementação.

---

## 23. Fases de implementação

Cada fase entrega uma vertical de ponta a ponta, com a UI já existente trocando fixture
por dado real.

| # | Fase | Entrega | Fecha |
|---|---|---|---|
| **0** | **Spike de viabilidade** | `hypercore@11` + `rocksdb-native` + `sodium-native` + `udx-native` + `better-sqlite3` carregando num `utilityProcess` **empacotado**, em Linux/Windows/macOS. Decide `utilityProcess` vs `bare-sidecar` e confirma ADR-03. **Nada mais começa antes disto.** | ADR-03, ADR-04 |
| **1** | Casca | Electron shell, ponte IPC tipada (§10.1), deep links `comunidadep2p://`, identidade Ed25519 em `safeStorage`, `MemoryRouter`, `core.status`. | §7, §10.1, `INF-01`, `ID-01/05` |
| **2** | Log e projeção | Core por comunidade, ops assinadas, os 29 `kind`s, validação (§9), projeção SQLite (§6.4), replicação. Criar comunidade, canal, mensagem, edição, delete, pin, reação, thread, cargos, moderação, auditoria. **Derruba a maior parte das fixtures.** | §4, §5, §6, `MSG-*`, `CH-*`, `ROLE-*`, `MOD-*` |
| **3** | Rede visível | Estados de conexão reais, outbox durável, reconexão e flush, presença, digitando, não-lidas, replicação de background (ADR-16). DevBar vira injetor de falha real. | §11.5, §13, `CON-*`, `Q-*`, `PRE-*`, `UNR-*` |
| **4** | Convites e entrada | Emissão, preview com os **seis** desfechos, resgate, contagem de usos, revogação, `firewall`. | §11.4, `INV-*` |
| **5** | Busca e anexos | FTS5 com os filtros de `spec:506`; hyperblobs, upload, download sob demanda, seeding, contagem real de peers. | §14, §15, `BUS-*`, `ARQ-*` |
| **6** | Voz e câmera | Sinalização peer-a-peer, mesh WebRTC, mudo/ensurdecer, fala ativa, dispositivos, falha assimétrica, fallback UDX. | §11.16, `VOZ-*`, `CAM-*` |
| **7** | Tela | Captura, WebCodecs, estrela; depois árvore, consentimento, reparo, painel do apresentador. | §10.8, §11.17, `TELA-*` |
| **8** | Relay voluntário | `blind-relay` opt-in, anúncio, seleção por `relayThrough`, diagnóstico de NAT real. | §11.19, `CON-07` |

Fases 2 e 3 juntas derrubam quase todas as fixtures. **A fase 7 é a mais cara, a mais
arriscada e a única cortável sem quebrar o produto** — estrela até 5 espectadores cobre a
maioria dos usos reais.

---

## 24. Riscos

| Risco | Prob. | Impacto | Mitigação | Gatilho de replanejamento |
|---|---|---|---|---|
| Nativos não carregam no `utilityProcess` empacotado | Média | Alto | Spike da fase 0; plano B `bare-sidecar` | Spike falha em qualquer um dos 3 SOs |
| Churn de API do ecossistema | **Alta** | Médio | Superfície mínima (`hypercore`, `corestore`, `hyperswarm`, `hyperblobs`, `protomux`); versões travadas; zero Autobase/Hyperbee/Hyperdb | Major novo em pacote da superfície mínima |
| Árvore custa mais do que rende | Média | Médio | Fase 7 é a última e é cortável; medição de §21.8 antes de generalizar | CPU do relay > 15 % ou latência de nível 2 > 2,5 s |
| Relay voluntário sem voluntários | **Alta** em comunidade pequena | Baixo | Host entra automaticamente; `conn-failed` é estado desenhado | — |
| "95 % de conexão direta" é otimista | Média | Médio | Número auto-reportado, sem metodologia; `swarm.holepunchSuccessRate` mede de verdade na fase 3 | Taxa medida < 80 % |
| Escala de 340 membros num só core | Baixa-média | Médio | Um escritor, muitos leitores é o caso fácil; o gargalo é o fan-out de conexões, não o log | p95 de `submitOp` > 250 ms com 100 membros |
| Zero suporte a TypeScript no ecossistema | **Certa** | Baixo | Declarações próprias em `backend/types/`, versionadas junto com as versões travadas | — |
| `.node` dentro do `asar` / ausência de prebuild musl | Média | Médio | `asarUnpack` na config de build; Alpine declarado fora de suporte | — |
| Sem descoberta LAN (`hyperswarm#115`, `#194`) | Certa | Baixo | Aceitar e **não prometer** (§25) | — |
| Fallback automático para relay só existe desde mai/2026 (`hyperswarm#215`) | Certa | Baixo | Travar versão ≥ a que traz `CANNOT_HOLEPUNCH` automático | — |
| `blind-pairing` desalinhado (3 versões desde 2024 vs. `blind-pairing-core@2.10.1`) | Certa | Baixo | Não é dependência do v1 (ADR-09) | — |

---

## 25. Deltas obrigatórios na spec de UX/UI

A arquitetura contradiz a interface em pontos específicos. Nenhum é fatal; todos são
texto; o princípio 3 da spec ("honestidade sobre limitações conhecidas", `spec:47`)
**obriga** a corrigi-los.

| # | Onde | O que muda |
|---|---|---|
| 1 | `spec:1339`, `spec:974` | **"Removida para todo mundo. Não pode ser desfeito."** — log append-only não apaga. Precisa da mesma nota de honestidade que a exclusão de canal já tem (`spec:776`): quem estiver offline só vê sumir ao reconectar, e os bytes continuam no log |
| 2 | `spec:124`, 0.3, 3.1b | **Código de convite: 6 → 16 caracteres** em 4 grupos (`X7K2-QM9F-RT4B-N8ZP`). O link não muda de forma (ADR-09) |
| 3 | 2.4 | **Espectador em árvore fica 1–2 s atrás**, somando por nível. A spec trata a árvore como a mesma experiência da estrela. É broadcast, não chamada — sem isso o usuário reporta como bug |
| 4 | `spec:875` | **Mensagem da fila se move ao ser entregue** (§5.5). A promessa de "posição cronológica" vale enquanto pendente |
| 5 | 0.3, `INV-07` | **Dois desfechos novos de preview**: `unreachable` (host offline) e `ended` (comunidade encerrada). Hoje ambos cairiam em "inválido", acusando um convite bom |
| 6 | onde aparecer | **Sem descoberta LAN.** Dois peers na mesma rede sem internet não se acham (`hyperswarm#115`, `#194`) |
| 7 | 3.1 → Rede | **Consentimento de relay voluntário** — superfície nova, irmã do modal 2.4.1: usar o upload de alguém para tráfego que **não é** da árvore que ela assiste exige pedir (§11.19) |
| 8 | `TELA-04`, §2 | **A fixture tem 7 espectadores num canal de voz com 3 participantes.** Espectador é participante do canal; a fixture precisa ser corrigida ou o modelo de audiência precisa existir |
| 9 | 3.3 (banidos) | **Ban oculta mensagens de forma reversível**: revogar o ban as reexibe. O texto atual sugere remoção permanente |
| 10 | 2.1 (editar) | **Editar não apaga o conteúdo anterior** — ele fica no log e é recuperável por quem inspecionar o core. A UI deve evitar prometer o contrário |
| 11 | 3.2 (cargos) | **Duas regras novas de segurança**: ninguém concede permissão que não tem, e ninguém cria/move cargo para posição ≥ a própria. Hoje a spec não as menciona, e sem elas `manage_roles` equivale a todas as 17 permissões |
| 12 | `spec:1134` | **Ops de estrutura não entram na fila offline** (a spec já diz isso de canal; vale igual para cargo, categoria e moderação). Só mensagem enfileira |

---

## 26. Ambiguidades

### 26.1 Fechadas por este documento

`CLK-02` (carimbo exibido) · `CLK-04` (dois carimbos) · `CLK-05` (ordem canônica) ·
`CLK-06` (posição da pendente) · `CLK-09` (última escrita vence) · `ROLE-09` (quem
valida) · `ID-05` (apagar de verdade) · `ID-08` (invisível) · `ID-17` (o que prova
autoria) · `INV-07` (preview com host offline) · `INV-10` (contagem de usos) ·
`INV-14` (o que o código codifica) · `VOZ-04` (falha assimétrica) · `VOZ-09` (por que voz
depende do host) · `VOZ-17` (sinalização) · `TELA-02` (limiar em 5) · `TELA-07`
(elegibilidade de repasse — **critério medido**, §11.17.1) · `TELA-08/09` (topologia e
reparo) · `TELA-11` (quem retransmite) · `BUS-10` (índice de busca) · `COM-03`
(`memberCount`) · `COM-10` (30 dias, agora configurável) · `PRE-03` (TTL de digitando) ·
`MOD-05` (timeout = host recusa ops) · `ARQ-01` (peers reais) · `ARQ-03` (limite de
anexo: 8 GiB configurável) · `ARQ-05` (seeding sem consentimento: fica) · `ARQ-06` (peer
cai no meio) · `ARQ-09` (diretório de dados + `shell.openPath`) · `HOST-04` (flush com
orçamento de 3 s) · `INF-02` (replicação de background) · `INF-05` (injeção de falha
real) · `UNR-02`/`UNR-08` (não-lidas por watermark).

### 26.2 Ainda abertas

| # | Ambiguidade | Por que continua aberta | Quando decidir |
|---|---|---|---|
| A-1 | Taxa real de furo de NAT | O "95 %" é auto-reportado, sem metodologia, e "typical consumer networks" provavelmente exclui CGNAT móvel | Fase 3, com `swarm.holepunchSuccessRate` medido |
| A-2 | Teto real de membros por comunidade | Depende do fan-out de conexões no host, não do log | Fase 3, com 100+ membros simulados |
| A-3 | Custo do nó de repasse | Só medível com WebCodecs real | Fase 7, §21.8 |
| A-4 | Multi-dispositivo | Fora do v1 (premissa 3). `keet-identity-key` resolveria | Depois do v1 |
| A-5 | Disponibilidade com host offline | `blind-peering@2.6.2` replica cifrado sem ler; não foi escolhido | Se o SPOF do host virar reclamação recorrente |
| A-6 | Notificação com app fechado | ADR-18; `blind-push` existe | Depois do v1 |

---

## Apêndice A — Mapa store → comando IPC

A tabela que o agente de implementação usa para trocar cada mutação local por uma chamada
real. A **assinatura da ação não muda** — só o corpo. É o que a spec de UX previu em
`spec:1532`: *"trocar a mutação local por append no Hypercore não toca componente
nenhum"*.

| Store / ação (arquivo:linha) | Comando IPC | Observação |
|---|---|---|
| `identityStore.createIdentity` (`identityStore.ts:23`) | `identity.create` | Deixa de gerar chave falsa |
| `identityStore.setPresence` (`:24`) | `identity.setPresence` | Efêmero |
| `identityStore.updateIdentity` (`:67`) | `identity.update` | Uma op por comunidade |
| `identityStore.clearIdentity` (`:29`) | `identity.wipe` | Agora apaga de verdade (`ID-05`) |
| `communityStore.createCommunity` (`communityStore.ts:125`) | `community.create` | Lote de bootstrap (§11.1) |
| `communityStore.joinCommunity` (`:124`) | `invite.redeem` | Passa a exigir convite |
| `communityStore.updateCommunity` (`:133`) | `community.update` | — |
| `communityStore.leaveCommunity` (`:137`) | `community.leave` | Host bloqueado |
| `communityStore.endCommunity` (`:138`) | `community.end` | — |
| `communityStore.createInvite` (`:134`) | `invite.create` | `code` só para quem cria |
| `communityStore.revokeInvite` (`:135`) | `invite.revoke` | — |
| `communityStore.createRole` (`:141`) | `role.create` | — |
| `communityStore.updateRole` (`:142`) | `role.update` | + anti-escalada |
| `communityStore.deleteRole` (`:143`) | `role.delete` | — |
| `communityStore.moveRole` (`:145`) | `role.move` | Devolve `positions[]` |
| `communityStore.setMemberRoles` (`:146`) | `member.setRoles` | Lista completa, não delta |
| `communityStore.setMemberNickname` (`:152`) | `member.setNickname` | Só o próprio |
| `communityStore.createChannel` (`:159`) | `channel.create` | — |
| `communityStore.updateChannel` (`:160`) | `channel.update` | — |
| `communityStore.moveChannel` (`:162`) | `channel.move` | — |
| `communityStore.deleteChannel` (`:163`) | `channel.delete` | Devolve `droppedQueued` |
| `communityStore.createCategory` (`:164`) | `category.create` | — |
| `communityStore.renameCategory` (`:165`) | `category.rename` | — |
| `communityStore.deleteCategory` (`:170`) | `category.delete` | Dois caminhos |
| `communityStore.toggleChannelMuted` (`:177`) | `channel.setMuted` | **Local** |
| `communityStore.markChannelRead` (`:178`) | `channel.markRead` | **Local** |
| `communityStore.toggleCategoryCollapsed` (`:128`) | `category.setCollapsed` | **Local** |
| `communityStore.setActiveChannel` (`:127`) | *(fica local)* | Estado de navegação |
| `communityStore.setLocalRoleOverride` (`:130`) | *(some)* | Era afinador de §19.1; some com permissão real |
| `messageStore.send` (`messageStore.ts:48`) | `message.send` | Assíncrono por contrato |
| `messageStore.retrySend` (`:51`) | `message.retry` | Mesmo `opId` |
| `messageStore.flushQueued` (`:53`) | *(some)* | O núcleo faz sozinho |
| `messageStore.dropQueued` (`:64`) | *(some)* | Vira evento `message.dropped` |
| `messageStore.toggleReaction` (`:54`) | `message.react` | — |
| `messageStore.setPinned` (`:55`) | `message.pin` | — |
| `messageStore.editMessage` (`:56`) | `message.edit` | — |
| `messageStore.deleteMessage` (`:57`) | `message.delete` | — |
| `messageStore.createThread` (`:50`) | `thread.create` | — |
| `messageStore.setTyping` (`:58`) | *(evento)* | `typing.changed` |
| `moderationStore.ban` (`moderationStore.ts:53`) | `mod.ban` | — |
| `moderationStore.revokeBan` (`:111`) | `mod.revokeBan` | Reexibe mensagens |
| `moderationStore.kick` (`:61`) | `mod.kick` | — |
| `moderationStore.applyTimeout` (`:62`) | `mod.timeout` | — |
| `moderationStore.removeTimeout` (`:63`) | `mod.removeTimeout` | — |
| `moderationStore.log` (`:82`) | *(some)* | Log é **projeção**, não escrita |
| `voiceStore.join` (`voiceStore.ts:87`) | `voice.join` | — |
| `voiceStore.leave` (`:89`) | `voice.leave` | — |
| `voiceStore.toggleMute/Deafen/Camera` (`:90-92`) | `voice.setSelf` | Um comando, três campos |
| `voiceStore.setVolume` (`:94`) | `voice.setParticipantVolume` | **Local** |
| `voiceStore.setParticipantMuted` (`:96`) | `voice.muteParticipant` | Exige `voice_mute_others` |
| `voiceStore.startShare` (`:98`) | `share.start` | — |
| `voiceStore.stopShare` (`:99`) | `share.stop` | — |
| `voiceStore.setQuality` (`:100`) | `share.setQuality` | De quem assiste |
| `voiceStore.respondConsent` (`:102`) | `share.respondConsent` | — |
| `voiceStore.dev*` (`:105-113`) | `dev.*` | Só fora de produção |
| `downloadStore.start` (`downloadStore.ts:24`) | `blob.download` | — |
| `connectionStore.setHostStatus` (`connectionStore.ts:16`) | *(evento)* | `host.wentOffline`/`cameBack` |
| `settingsStore.setDevice/setVolume` (`settingsStore.ts:71-72`) | `settings.*` | **Local** |
| `settingsStore.runDiagnostic` (`:78`) | `diag.run` | Agora mede de verdade |
| `searchIndex.search` (`searchIndex.ts`) | `query.search` | FTS5 no núcleo |
| Todos os `select*` de leitura | `query.*` | Colapsam as três camadas fixture+override numa só |

**Regra de migração:** cada store deixa de guardar dado de domínio e passa a guardar
**cache de leitura invalidado por evento**. A regra de ouro do Zustand v5 que o frontend
aprendeu quatro vezes — *"seletor nunca constrói objeto ou array novo"* (`spec:1598`) —
continua valendo e fica ainda mais importante: agora as respostas vêm do IPC e precisam ser
guardadas por referência estável.

---

## Apêndice B — Mapa DevBar → injeção de falha real

`DevBar.tsx` (342 linhas) é, hoje, a lista de eventos que o backend precisa emitir. Cada
botão passa a derrubar algo de verdade — é o que fecha `INF-05`.

| Botão do DevBar | Comando | Efeito real no núcleo |
|---|---|---|
| Derrubar host | `dev.hostOffline` | Fecha o stream RPC e recusa reconexão até liberar |
| Trazer host de volta | `dev.hostOnline` | Libera; dispara `host.cameBack` e o flush da outbox |
| Falhar próximo envio | `dev.failNextSend` | O host recusa a próxima op com `E_INTERNAL` |
| Peer do anexo cai | `dev.dropBlobPeer` | Remove um peer do range; `blob.peerLost` |
| Sinal fraco no peer | `dev.setPeerMesh` | Marca a aresta como `degraded` |
| Falhar entrada em voz | `dev.failVoiceJoin` | `voiceJoin` devolve erro |
| Rafael compartilhando | `dev.startRemoteShare` | Sessão sintética com apresentador remoto |
| +1 / 0 espectadores | `dev.addViewer` / `dev.clearViewers` | Muda o roster e força recálculo da árvore |
| Forçar TURN | `dev.forceTurn` | Marca a sessão como degradada por NAT |
| Queda de nó da árvore | `dev.dropTreeNode` | Para o heartbeat de um nó → watchdog → reparo |
| Falhar transmissão | `dev.failShare` | Encerra a sessão com `share.failed` |
| Esquecer consentimento | `dev.forgetConsent` | Apaga `local_relay_consent` |
| CGNAT detectado | `dev.setNatType` | Força `swarm.natType = cgnat` |
| Carregar dataset | `dev.seedDataset` | Cria as 3 comunidades de §2 por ops reais |
| Zerar tudo | `dev.resetAll` | Equivale a `identity.wipe` sem confirmação |

**A queda de nó continua com 2 s de atraso** (o frontend já faz isso, `spec:1469`): clicar
fecha o popover de 2.4.2, e o estado a observar é justamente a linha pulsando com ele
aberto.