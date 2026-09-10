# Implementation Dry Run — Uniduni

> Execução mental da implementação, exatamente como a especificação manda, sem inventar
> decisão nenhuma. Cada ponto em que a execução **parou porque faltava uma decisão** está
> registrado abaixo como GAP.
>
> **Documentos lidos integralmente:** `backend.md` (2.986 linhas), `frontend.md`
> (1.605 linhas, incluindo Apêndice A e as 11 partes de "Status de implementação"),
> `auditoria-adversarial.md` (1.073 linhas, 50 achados).
>
> **Nada foi resolvido silenciosamente.** Onde havia duas leituras plausíveis do texto, as
> duas estão registradas (campo *Interpretações plausíveis*), e nenhuma foi escolhida.

---

## Método

O dry run seguiu a ordem de construção de §23 (fases 0 → 8), e dentro de cada fase a ordem
de dependência de módulos de §3.1 (L0 → L1 → L2 → L3). Para cada módulo eu tentei escrever,
mentalmente, a assinatura e o corpo mínimo:

1. **Qual arquivo eu criaria**, e qual é a assinatura pública dele (§3.2 "Expõe").
2. **Que tipos entram e saem** — se um tipo não está definido em lugar nenhum, o módulo não
   compila, e isso é GAP, não detalhe.
3. **Qual a primeira linha executável** e o que ela precisa ler.
4. **Todos os caminhos de saída**: sucesso, falha esperada, falha inesperada, concorrência,
   crash no meio.
5. **Quem consome o resultado**, e se o consumidor (renderer, host, réplica) recebe tudo o
   que a spec de UX promete exibir.

O critério de registro é o que o próprio pedido fixou, e é o mesmo que o §0 do backend
declara: *"se algo não estiver aqui, é buraco desta spec e deve ser levantado, não
inventado"*. Portanto **toda vez que eu precisaria escolher para continuar, virou GAP** —
inclusive quando a escolha "óbvia" existe, porque óbvio para mim não é contrato.

### Relação com a auditoria adversarial existente

A auditoria de 2026-08-12 é um documento de ataque: ela procura **contradições e
impossibilidades**. Este dry run é um documento de construção: ele procura **ausências que
travam o teclado**. As duas lentes se cruzam em alguns pontos, e onde isso acontece o GAP
traz `≈ F-xx` — mas o conteúdo registrado aqui é sempre a *pergunta que o implementador
precisa responder para escrever a próxima linha*, não a contradição em si. GAPs sem
`≈ F-xx` **não aparecem na auditoria**.

### Severidade

| Nível | Critério usado aqui |
|---|---|
| **BLOCKER** | Não é possível escrever a primeira versão do módulo. O trabalho para na mesa. |
| **HIGH** | É possível escrever, mas a decisão inventada muito provavelmente será revertida — retrabalho em código já testado, ou em contrato já consumido pelo frontend. |
| **MEDIUM** | Decisão inventável com risco contido, mas que precisa ser registrada porque afeta outro módulo ou outra tela. |
| **LOW** | Ruído de contrato: custa pouco corrigir depois, mas custa tempo agora. |

**Contagem:** 51 GAPs — 7 BLOCKER · 14 HIGH · 22 MEDIUM · 8 LOW.

---

# Bloco 0 — Fase 0 (spike) e fundação de projeto

## GAP DR-01 — O spike da fase 0 não tem critério de aceite nem regra de decisão

- **Localização:** §23 (fase 0); ADR-03; ADR-04; §24 (linha "Nativos não carregam").
- **O que a spec define:** a fase 0 carrega `hypercore@11` + `rocksdb-native` +
  `sodium-native` + `udx-native` + `better-sqlite3` num `utilityProcess` **empacotado**, em
  Linux/Windows/macOS. "Decide `utilityProcess` vs `bare-sidecar` e confirma a ADR-03."
  "Nada mais começa antes disto." O gatilho de replanejamento em §24 é "spike falha em
  qualquer um dos 3 SOs".
- **O que o implementador precisaria saber:** o que conta como "carregar" — `require` sem
  exceção? uma operação real de cada addon (append no core, `put` no RocksDB, transação no
  SQLite)? sob `asar` com `asarUnpack`? em qual matriz de versões de SO? Quem declara o
  spike concluído, e com que artefato (relatório? teste em CI?).
- **Qual decisão está faltando:** a definição de pronto do spike e a regra de decisão
  binária que sai dele.
- **Por que não pode ser inferida:** "carrega" é ambíguo por três ordens de grandeza —
  `require()` bem-sucedido e um benchmark de transação longa são coisas diferentes, e a
  ADR-03 pede exatamente a segunda ("sem histórico e sem documentação de uso **sob
  transação longa**"). Escolher o critério fraco faz o spike passar e o problema aparecer na
  fase 2.
- **Impacto:** a fase 0 é o portão de tudo. Sem critério, ela nunca fecha formalmente, ou
  fecha cedo demais e leva o risco inteiro para dentro da fase 2.
- **Severidade:** **BLOCKER** (≈ F-22, que ataca a condicionalidade das ADRs; aqui o
  problema é operacional: não dá para começar nem a fase 0).

## GAP DR-02 — Não há especificação de repositório, build e empacotamento — e a migração do frontend web → Electron contradiz "não toca componente nenhum"

- **Localização:** §0.1 ("substitui as fixtures por dado real **sem tocar em componente
  nenhum**"); §23 (fase 1: "Electron shell, ponte IPC tipada, deep links, `MemoryRouter`");
  Apêndice A ("a assinatura da ação não muda — só o corpo"); `frontend.md` premissa 1
  (alvo é **aplicação web**, Vite+React) e §4 (usa `react-router`, `persist` em
  `localStorage`).
- **O que a spec define:** os módulos do backend (§3.2), a fronteira de processos (§2.1) e
  as regras de segurança do renderer (§18.5: `sandbox: true`, `contextIsolation: true`, CSP
  sem `unsafe-inline`).
- **O que o implementador precisaria saber:** qual é o layout de `backend/`; qual
  empacotador (electron-builder? forge?); como o bundle do renderer (Vite) é servido dentro
  do Electron sob CSP restritiva; onde vive o `preload`; como o `MessagePort` chega ao
  renderer com `contextIsolation: true`; quem reescreve `BrowserRouter`→`MemoryRouter`, o
  `persist`/`localStorage` das stores (que passa a coexistir com `local_*` no SQLite), e o
  `DevBar` (que vira roteador `dev.*`).
- **Qual decisão está faltando:** o plano de migração do frontend existente e a estrutura de
  build de três alvos (main, utilityProcess, renderer).
- **Por que não pode ser inferida:** §0.1 promete explicitamente que nenhum componente é
  tocado, e a fase 1 exige tocar em roteamento, entrada da aplicação, persistência e CSP.
  As duas afirmações não podem ser verdadeiras ao mesmo tempo; escolher qual vale é decisão
  de escopo, não de implementação.
- **Interpretações plausíveis:** (a) "componente" significa só componente de apresentação, e
  infraestrutura de app é livre para mudar; (b) a promessa vale literalmente e a migração
  Electron é um projeto à parte, anterior à fase 1.
- **Impacto:** a fase 1 é a primeira que produz binário. Sem isso ela não tem contorno, e o
  cronograma das fases 2+ herda a incerteza.
- **Severidade:** **HIGH**

## GAP DR-03 — O canal main↔núcleo não tem contrato, e a chave privada precisa atravessá-lo apesar de §7 proibir

- **Localização:** §2.1/§2.2 (o main mantém "um canal próprio com o núcleo, exclusivo para
  três coisas"); §3.2 (`keystore` — "Depende de: ipc-main"); §7.1; §7 ("A chave privada
  **nunca** cruza o IPC"); §10 (define **só** renderer↔núcleo e núcleo↔host); §10.2
  (`host.exitImpact`, `host.notifyBeforeExit` listados como comandos do renderer); §11.20
  (quem os chama é **o main**).
- **O que a spec define:** as três responsabilidades do canal (decifrar a chave com
  `safeStorage`, responder `getDisplayMedia`, perguntar o impacto de saída) e que
  `safeStorage` só existe no main.
- **O que o implementador precisaria saber:** o envelope de quadro desse canal (é o mesmo
  `req/res` de §10.1? outro?), os nomes das mensagens, quem inicia cada uma, timeouts,
  erros; e, sobretudo, **em que direção o material de chave viaja**: o núcleo gera o par e
  manda a privada ao main para cifrar (§7.1 diz "gera par com `hypercore-crypto.keyPair()`,
  cifra a privada com `safeStorage.encryptString`"), ou o main gera e manda a privada
  decifrada ao núcleo no boot (§2.2: "decifrar a chave privada com `safeStorage`").
- **Qual decisão está faltando:** o contrato completo do canal de controle e a regra sobre a
  chave privada atravessá-lo.
- **Por que não pode ser inferida:** "a chave privada nunca cruza o IPC" e "o main decifra a
  chave privada para o núcleo" são incompatíveis, a menos que "IPC" signifique
  exclusivamente renderer↔núcleo — o que o próprio §0.3 contradiz ao chamar de IPC a
  superfície que atende o renderer. Como é regra de segurança (ADR-19), inventar aqui é
  inventar postura de segurança.
- **Interpretações plausíveis:** (a) "IPC" em §7 = superfície do renderer; a chave trafega
  main↔núcleo em `Buffer` e é zerada; (b) a chave nunca sai do main, e o main passa a ser
  quem assina — o que contradiz §3.2 (`identity` é L0 do núcleo) e a fronteira de §2.2.
- **Impacto:** o `keystore` é o primeiro módulo com I/O da fase 1 e não tem como ser
  escrito. Também trava `host.exitImpact` (3.5 da UX) e o `getDisplayMedia` da fase 7.
- **Severidade:** **BLOCKER**

## GAP DR-04 — Deep link `comunidadep2p://` e instância única colidem com o modo de falha da ADR-20

- **Localização:** §23 (fase 1: "deep links `comunidadep2p://`"); ADR-20 ("instâncias
  concorrentes **falham na abertura**"); §2.3 (`E_CORE_ALREADY_RUNNING` → "o main mostra
  diálogo e fecha o app"); `frontend.md` §4 (rotas `/invite/:code` e `/m/:code` como alvo de
  link externo).
- **O que a spec define:** que a segunda instância recusa abrir com erro nomeado, e que
  links de convite/mensagem precisam ser resolvidos ao chegar de fora do app.
- **O que o implementador precisaria saber:** o que acontece quando o SO abre uma segunda
  instância porque o usuário clicou num `comunidadep2p://invite/...` com o app já aberto —
  o esperado do gênero é `requestSingleInstanceLock` + repasse do argumento para a instância
  viva, e não "diálogo de erro e fecha".
- **Qual decisão está faltando:** o mecanismo de instância única no **main** (distinto do
  lock de diretório do núcleo) e o repasse do deep link.
- **Por que não pode ser inferida:** a ADR-20 fala do processo núcleo e do lock de
  diretório; ela não decide o comportamento do main, e aplicar a mesma regra ao main faz o
  fluxo A2 (chegada por link) falhar sempre que o app já estiver aberto — que é o caso
  comum.
- **Impacto:** o único caminho de entrada do produto (convite) quebra no caso mais frequente.
- **Severidade:** **MEDIUM**

---

# Bloco 1 — Fase 1: ponte IPC

## GAP DR-05 — `sub`/`unsub` não têm semântica: não há como correlacionar um `ev` com a assinatura que o pediu

- **Localização:** §10.1 (tabela de quadros); §10.3 (catálogo de 31 tópicos).
- **O que a spec define:** `sub {t,id,topic,filter?}`, `unsub {t,id}`, `ev {t,topic,data}`.
- **O que o implementador precisaria saber:** (1) o `ev` não carrega o `id` da assinatura —
  com duas assinaturas do mesmo tópico e filtros diferentes (ex.: `messages.appended` de dois
  canais abertos), o renderer não sabe qual casou; (2) que filtros cada tópico aceita — não
  há uma linha sequer definindo o vocabulário de `filter`; (3) se um tópico **exige**
  assinatura ou se eventos são difundidos a todo renderer conectado; (4) o que acontece com
  `sub` repetido no mesmo tópico (dedupe? duas entregas?).
- **Qual decisão está faltando:** o modelo de assinatura (por tópico global vs. por
  assinatura com id ecoado) e a gramática de `filter` por tópico.
- **Por que não pode ser inferida:** as duas leituras produzem clientes incompatíveis, e a
  escolha vaza para o formato do quadro `ev` — que é contrato de fronteira, consumido por
  todas as stores do Apêndice A.
- **Interpretações plausíveis:** (a) assinatura é por tópico e o `filter` é ignorado
  (o renderer filtra); (b) assinatura é por `id` e o `ev` precisa ganhar um campo `subId`
  — mudança no quadro de §10.1.
- **Impacto:** a ponte IPC é a primeira entrega da fase 1 e é consumida por todo o resto.
- **Severidade:** **HIGH**

## GAP DR-06 — O backpressure de IPC não tem mecanismo: `MessagePort` não informa quantos quadros não foram drenados

- **Localização:** §10.1 ("o núcleo para de emitir eventos de um `topic` se houver mais de
  `IPC_EVENT_HIGHWATER` (default 1000) quadros **não drenados**").
- **O que a spec define:** o limiar, o evento `ipc.dropped{topic,count}` e a regra de que o
  renderer reconsulta.
- **O que o implementador precisaria saber:** como medir "não drenado". `postMessage` sobre
  `MessagePort` é fire-and-forget: não há callback de entrega, não há `writableLength`, não
  há evento de dreno. Medir exige um protocolo de ack/janela que **não existe** em §10.1.
- **Qual decisão está faltando:** o mecanismo de controle de fluxo (ack periódico do
  renderer? contador de sequência por tópico? amostragem por tempo?), incluindo o quadro
  novo que ele exige.
- **Por que não pode ser inferida:** qualquer aproximação (ex.: "quadros emitidos desde o
  último `req` do renderer") muda o significado do número 1000 e do momento em que
  `ipc.dropped` dispara — e §10.1 usa esse comportamento como garantia de que evento perdido
  nunca vira estado errado.
- **Impacto:** sem isso o limiar é decorativo e o modo de falha real (renderer travado,
  fila crescendo em memória do núcleo) fica sem tratamento.
- **Severidade:** **HIGH** (≈ F-17 pelo lado de *quais* eventos podem ser descartados; aqui
  o problema é que não há como saber *quando* descartar)

## GAP DR-07 — Não há procedimento de reconexão do IPC depois do crash do núcleo

- **Localização:** §2.3 ("Crash do núcleo: o main detecta o `exit` e reinicia até 3 vezes…
  cada reinício emite `core.restarted`"); §2.2 (o main cria o `MessageChannelMain` e cruza as
  portas **na inicialização**); §10.1.
- **O que a spec define:** a política de reinício (3× em 60 s, backoff 1/4/10 s) e o evento
  `core.restarted{attempt}`.
- **O que o implementador precisaria saber:** o `MessagePort` do renderer morre junto com o
  processo. Quem recria o canal? O renderer recebe uma porta nova por
  `webContents.postMessage` e precisa descartar a antiga — como ele sabe? O que acontece com
  os `req` em voo (o `id` monotônico do renderer não reinicia, mas o núcleo sim)? Quem
  refaz as assinaturas de §10.3 — o renderer, cegamente, ou existe um `resub`?
- **Qual decisão está faltando:** o handshake de (re)conexão do IPC e a política sobre
  requisições em voo no momento do crash.
- **Por que não pode ser inferida:** o comando pode ter sido aplicado antes do crash — o
  próprio §10.1 já reconhece isso para timeout ("o núcleo continua processando"). No crash é
  pior: `message.send` grava na outbox **antes** de responder, então há um estado em que o
  renderer não tem `opId` e a outbox tem o item.
- **Impacto:** recuperação após crash é uma das superfícies que a spec de UX promete
  (`conn-reconnecting`, "Reconectando…"), e é o caminho mais fácil de produzir duplicata ou
  fantasma na tela.
- **Severidade:** **HIGH**

## GAP DR-08 — `core.status` tem duas formas contraditórias, e o enum de `phase` não existe

- **Localização:** §10.2 (`core.status` → `{phase, version, schemaVersion, opVersion}`);
  §17.4 ("`core.status` devolve `phase` **por comunidade**"); §2.3 (fases do processo:
  `boot`, `identity`, `open`, `swarm`, `ready`, `host-mode`, `draining`, `stopped`); §2.3
  também usa `degraded`, `hosting-degraded`, `awaiting-identity`.
- **O que a spec define:** duas respostas diferentes para o mesmo comando, e uma lista de
  fases espalhada em prosa, sem enum fechado.
- **O que o implementador precisaria saber:** se `phase` é do processo ou da comunidade; se
  os estados de comunidade (`degraded`, `hosting-degraded`, `cache-only`) fazem parte do
  mesmo enum ou de outro; qual é o conjunto fechado; e se `awaiting-identity` é fase de
  processo (§2.3 diz que sim).
- **Qual decisão está faltando:** o enum fechado e a forma final da resposta.
- **Por que não pode ser inferida:** o §17.4 usa a resposta para definir "saudável", que é o
  que alimenta o token `conn-degraded` da UI. Escolher errado muda o que a interface pinta.
- **Severidade:** **MEDIUM**

## GAP DR-09 — A derivação do `handle` não diz qual base32 nem como truncar

- **Localização:** §4.1 (`handle` = "`@` + 6 primeiros caracteres de base32(publicKey),
  minúsculo"); ADR-09 (Crockford Base32 — mas **para convite**); `frontend.md` §2/§10
  (`@ana`, `Usuário#4471`).
- **O que a spec define:** o formato geral, e que não é único.
- **O que o implementador precisaria saber:** alfabeto (RFC 4648? Crockford, que remove
  `I`,`L`,`O`,`U`? z-base-32?), com ou sem padding, e se "minúsculo" é aplicado depois. Como
  isso é identidade visível, mudar o alfabeto depois muda o identificador de todo mundo.
- **Qual decisão está faltando:** o alfabeto e o procedimento exato.
- **Por que não pode ser inferida:** a única base32 nomeada no documento é a de convites, com
  justificativa específica de transcrição verbal, que não se aplica aqui.
- **Impacto:** identificador exibido em 1.4, 3.3 e na lista de banidos.
- **Severidade:** **LOW** (≈ F-32, que ataca a incompatibilidade com o dataset de UX; aqui é
  o passo anterior — não dá para computar o valor)

---

# Bloco 2 — Fase 2: log, validação e projeção

## GAP DR-10 — Não existe o layout de encoding de nenhum `kind`: `opCodec` não pode ser escrito

- **Localização:** §5.1 (estruturas `Op`/`Envelope`/`LogRecord`); §5.2 (registry versionado,
  `compact-encoding@3.3.0`, "encoding canônico: campos na ordem declarada, sem padding, sem
  campo opcional ausente escrito como vazio"); §5.3 (payloads descritos como lista de nomes:
  `channelId, content, mentions[], attachment?, replyToId?, threadId?`).
- **O que a spec define:** os **nomes** dos campos de cada payload, os tipos dos campos do
  cabeçalho (`v: uint8`, `kind: string`, `author: bytes[32]`, `ts: uint64`,
  `nonce: bytes[8]`), e três regras de evolução.
- **O que o implementador precisaria saber:** para cada um dos 29 (ou 34 — ver F-23) `kind`s:
  o tipo `compact-encoding` de cada campo, a ordem, e **como um campo opcional ausente é
  representado**. `compact-encoding` não tem noção de campo ausente: ou existe um byte de
  flags, ou um marcador por campo, ou o campo é sempre escrito. A regra canônica proíbe
  escrever ausente como vazio, mas não diz o que escrever no lugar — e sem essa decisão o
  `opId` (que é hash do envelope canônico, ADR-12, e vira id de entidade em §4.7/§4.8) não é
  computável.
- **Qual decisão está faltando:** o registry de encoding completo, campo a campo, com a
  representação de opcionalidade.
- **Por que não pode ser inferida:** três esquemas igualmente razoáveis (bitmap de flags no
  início; `cenc.array` de pares; sempre escrever com sentinela) produzem bytes diferentes,
  logo `opId` diferentes, logo **ids de mensagem diferentes** — e a §21.4 (reprojeção
  determinística) transforma essa escolha em contrato permanente do log.
- **Impacto:** `opCodec` é L1 e é dependência de `validator`, `projector`, `outbox`,
  `rpcServer`, `rpcClient`. A fase 2 inteira para aqui.
- **Severidade:** **BLOCKER**

## GAP DR-11 — Ids de cargo, categoria e canal não têm origem: o payload não os carrega e "gerado pelo host" quebra a reprojeção determinística

- **Localização:** §4.4 (`Role.id` = "`role-` + 12 hex, **gerado pelo host**"); §4.5
  (`Category.id` = "`cat-` + 12 hex", sem origem); §4.6 (`Channel.id` = "`ch-` + 12 hex",
  sem origem); §4.7 (`Message.id` = "`msg-` + hex do `opId` truncado em 12.
  **Determinístico: reprojetar produz o mesmo id**"); §5.3 (payloads de `role.create`,
  `category.create`, `channel.create` — **nenhum tem campo de id**); §21.4 (reprojetar do
  seq 0 produz estado idêntico, comparado por hash de dump).
- **O que a spec define:** o formato dos ids e, só para mensagem e thread, a derivação.
- **O que o implementador precisaria saber:** de onde sai o id de um cargo. Se o host sorteia
  no momento do append, o valor precisa estar **em algum lugar do log** para a reprojeção
  reproduzi-lo — e não está, porque o payload não tem o campo. Se é derivado do `opId` como
  mensagem, então "gerado pelo host" é texto errado e §4.4 precisa mudar.
- **Qual decisão está faltando:** a regra de derivação de id para `role`, `category` e
  `channel` — ou a inclusão de um campo `id` no payload das três ops.
- **Por que não pode ser inferida:** as duas saídas são mutuamente exclusivas e ambas mexem
  em contrato: uma muda §4.4, a outra muda §5.3 e o encoding de DR-10. Além disso, o
  bootstrap de §11.1 aprofunda o problema: `channel.create` referencia `categoryId` de uma
  categoria criada **no mesmo lote atômico**, então o id da categoria precisa ser conhecido
  antes do append — o que só funciona se ele for derivável do `opId`, que por sua vez é
  computável antes do append. Isso é um argumento forte para a derivação, mas é
  **inferência minha**, e §4.4 diz o contrário.
- **Interpretações plausíveis:** (a) todos os ids derivam do `opId` da op criadora, como
  mensagem — e §4.4 está errada; (b) o host gera aleatoriamente e o id passa a fazer parte do
  payload — e §5.3 e §21.4 precisam de ajuste.
- **Impacto:** sem isso não há reducer de `role.create`, `category.create` nem
  `channel.create`, ou seja, não há bootstrap de comunidade — a primeira coisa que a fase 2
  entrega.
- **Severidade:** **BLOCKER** (relacionado a F-05, que ataca a colisão dos 48 bits; aqui o
  problema é anterior: não há regra de geração)

## GAP DR-12 — O lote de bootstrap não distingue o cargo Fundador do cargo base

- **Localização:** §11.1 (lote de 6 ops: `community.create`, `role.create`(Fundador),
  `role.create`(Membro, base), `member.join`, `category.create`, `channel.create`); §4.4
  (`isFounder` e `isDefault` são `der` — "derivado pela projeção, nunca vem numa op");
  §5.3 (payload de `role.create` = `name, color, permissions[], mentionable`); §4.18 (I-2:
  exatamente 1 `isFounder` e exatamente 1 `isDefault` por comunidade).
- **O que a spec define:** que os dois flags são derivados, e que a invariante I-2 os exige.
- **O que o implementador precisaria saber:** **derivados de quê**. O payload não tem flag.
  Sobram três candidatos, todos frágeis: posição no lote de bootstrap (seq 1 = Fundador,
  seq 2 = base), literal do nome (`"Fundador"` / `"Membro"` — quebra se alguém renomear, e
  §4.4 só proíbe `role.update` no Fundador), ou "o cargo com as 17 permissões" (quebra assim
  que alguém criar outro cargo com todas).
- **Qual decisão está faltando:** como a projeção marca `is_founder` e `is_default`.
- **Por que não pode ser inferida:** as três leituras divergem no primeiro caso de borda
  (renomear o cargo base é permitido — §4.4 diz que só as *permissões* do base são
  editáveis, mas não proíbe renomear), e a invariante I-2 aborta a transação com
  `E_INVARIANT` se a derivação errar — o que, por §6.4, congela a comunidade em `degraded`.
- **Impacto:** trava o reducer de `role.create` e, por consequência, a criação de qualquer
  comunidade.
- **Severidade:** **BLOCKER**

## GAP DR-13 — `reducers.apply(op, tx)` não recebe `seq`, `hostTs` nem `flags`, que quase todo reducer precisa

- **Localização:** §3.2 (`reducers` — "Expõe: `apply(op, tx)`"); §12.4 ("Reducer é
  `(op, tx) → void`"); §5.1 (`seq` é implícito, `hostTs` e `flags` estão no `LogRecord`, não
  na `Op`); §4.7 (`messages.seq`, `host_ts`, `clock_skewed` são colunas obrigatórias).
- **O que a spec define:** a assinatura, em dois lugares, sem os três campos.
- **O que o implementador precisaria saber:** como o reducer de `message.send` escreve
  `seq`, `host_ts` e `clock_skewed` se não os recebe. O mesmo vale para `joined_at`, `at` de
  reação/ban/timeout, e `at` do `moderation_log` — todos marcados `host` em §4.
- **Qual decisão está faltando:** a assinatura real (`apply(record, tx)`? `apply(op, ctx,
  tx)`?) e o que compõe o contexto.
- **Por que não pode ser inferida:** §12.4 declara a assinatura como regra ("reentrância
  proibida"), então mudá-la é mexer numa regra, não num detalhe.
- **Severidade:** **MEDIUM**

## GAP DR-14 — `validator.validate(op, state)` não define o que é `state` — o módulo não tem assinatura

- **Localização:** §3.2 (`validator` — "Expõe: `validate(op, state): Ok|AppError`"; "**É
  puro por construção**"; "não pode escrever"; `permissions` "recebe roster e cargos como
  argumento"); §9.1 (12 estágios); §9.3 (invariantes estruturais por `kind`).
- **O que a spec define:** os 12 estágios, a ordem fixa, e que o módulo é puro.
- **O que o implementador precisaria saber:** o tipo de `state`. Os estágios exigem, no
  mínimo: tabela de `dedupe` (5), roster com bans (7), timeouts (8), buckets de rate limit
  (9), cargos e permissões efetivas (10), hierarquia do alvo (11), e para o estágio 12 uma
  fatia grande da projeção — canais com nome e tipo, categorias vivas, contagem de emojis
  distintos por mensagem, existência de thread na raiz, contagem de convites ativos,
  `byteLength` do `blobId`. Isso é praticamente a comunidade inteira.
- **Qual decisão está faltando:** a forma de `state` (snapshot materializado? interface de
  consulta injetada? closure de leitores?), e como ela é montada sem violar a pureza.
- **Por que não pode ser inferida:** as três formas têm custos e semânticas de concorrência
  completamente diferentes (um snapshot materializado por op é caro; uma interface de
  consulta faz o módulo deixar de ser puro na prática, o que derruba a justificativa de
  §3.3 e o desenho de teste de §21.1). E há um agravante: §9.2 manda o **cliente** rodar o
  mesmo módulo, e o cliente não possui esse estado.
- **Impacto:** `validator` é a peça central da fase 2 e o alvo de ~600 casos de teste
  (§21.1). Sem o tipo de entrada, nem o teste nem o módulo existem.
- **Severidade:** **BLOCKER** (≈ F-04/F-11 por outros ângulos: serializabilidade e
  divergência de configuração; aqui é a assinatura que não existe)

## GAP DR-15 — Não está definido quais estágios do pipeline rodam no cliente

- **Localização:** §9.2 ("o **cliente** valida antes de enfileirar… e o **host** revalida
  sempre. As duas usam o **mesmo módulo**… assim não podem divergir"); §11.3 passo 1
  ("`validator` roda **local** (mesma função do host)… Falhou → `E_VALIDATION` síncrono").
- **O que a spec define:** que os dois lados usam o mesmo módulo, e que a validação local
  produz erro inline no formulário.
- **O que o implementador precisaria saber:** o cliente não pode executar os estágios 5
  (dedupe do host), 7-8 (roster e timeouts do host, que podem estar à frente da réplica
  local), 9 (rate limit do host) e boa parte do 12 (unicidade de nome de canal depende do
  log completo). Rodar o pipeline inteiro no cliente produz falsos negativos; rodar só
  parte contradiz "mesma função".
- **Qual decisão está faltando:** o subconjunto de estágios executável no cliente, e o modo
  de invocação (`validate(op, state, {mode:'client'})`? outra função?).
- **Por que não pode ser inferida:** a spec afirma que a divergência é impossível — a
  afirmação é forte o suficiente para que qualquer recorte pareça violá-la.
- **Impacto:** decide o comportamento de todo formulário de §13 da spec de UX (erro inline
  vs. erro que só aparece depois do round-trip).
- **Severidade:** **HIGH**

## GAP DR-16 — A manutenção do índice FTS5 externo não está especificada

- **Localização:** §6.3 (`messages_fts` — "FTS5 **externa**: `content`,
  `content_rowid = messages.rowid`"); §11.6 ("remove da FTS"); §11.11 (ban "remove-as da
  FTS"); ADR-13.
- **O que a spec define:** que a tabela é external-content e o tokenizer.
- **O que o implementador precisaria saber:** tabela FTS5 external-content **não se
  atualiza sozinha**. Cada inserção, edição, deleção, ocultação por ban e reexibição por
  revogação exige comandos explícitos (`INSERT INTO messages_fts(messages_fts, rowid,
  content) VALUES('delete', …)` com o **conteúdo antigo**), na ordem certa em relação ao
  `UPDATE` da tabela base. Nada disso está escrito. Também não está dito se `messages_fts` é
  recriada na reprojeção total (é tabela de projeção, logo apagada — mas o `rebuild` de
  external-content é um comando próprio).
- **Qual decisão está faltando:** o protocolo de sincronização do índice (triggers vs.
  comandos no reducer) e o procedimento na reprojeção.
- **Por que não pode ser inferida:** errar aqui não dá erro: dá índice silenciosamente
  divergente, que é exatamente a classe de bug que §21.4 existe para pegar — e §21.4 compara
  dump de tabelas, não índice FTS.
- **Severidade:** **MEDIUM**

## GAP DR-17 — Tombstone de mensagem: `content` é NOT NULL e a spec diz que o conteúdo "some da projeção"

- **Localização:** §4.7 (`deletedAt` — "Tombstone: conteúdo, reações e anexos **somem da
  projeção**"); §6.3 (`messages.content TEXT **NOT NULL**`); §11.6 ("a projeção marca
  `deleted_at`, apaga reações, remove da FTS").
- **O que a spec define:** as duas coisas, que não podem valer ao mesmo tempo se "somem"
  significa "a coluna é esvaziada".
- **O que o implementador precisaria saber:** se o conteúdo é apagado da linha (exige mudar
  a coluna para nullable ou gravar string vazia, que viola o mínimo de 1 grafema de §9.2 —
  ainda que a validação seja de op, não de coluna), ou se ele **permanece** na linha e só a
  leitura filtra. As consequências são diferentes: no segundo caso, o conteúdo de uma
  mensagem deletada continua no SQLite local de todo mundo, o que é coerente com ADR-10 mas
  não é o que "some da projeção" sugere, e afeta o delta 1 de §25.
- **Qual decisão está faltando:** o que a transação de tombstone faz com a coluna `content`.
- **Interpretações plausíveis:** (a) coluna preservada, leitura filtra por `deleted_at`;
  (b) coluna esvaziada, exigindo alteração de schema e ordem específica com a exclusão do
  FTS (que precisa do conteúdo antigo — ver DR-16).
- **Impacto:** afeta reducer, schema, FTS, e o texto que a UX precisa passar a dizer.
- **Severidade:** **MEDIUM**

## GAP DR-18 — Não está definido por qual caminho o próprio host escreve suas ops

- **Localização:** §11.3 (fluxo de envio inteiro escrito do ponto de vista do cliente:
  outbox → `rpcClient.submitOp` → host); §12.3 ("uma fila de uma via por comunidade no
  `communityHost`. **Toda op** passa por ela"); §3.2 (`communityClient` "não pode appendar
  no core"; `communityHost` "não pode existir quando `is_hosted_by_me = 0`"); §10.2
  (`message.send` responde `{opId, state:"queued"|"sending"}`).
- **O que a spec define:** o caminho do membro. Nada sobre o caminho do host para as
  próprias ops.
- **O que o implementador precisaria saber:** quando Ana hospeda Clã Noturno e envia uma
  mensagem lá, a op passa pela outbox local? Passa por um `rpcClient` em loopback contra o
  próprio processo? Ou o `ipc` chama `communityHost.submitOp` direto? Cada escolha muda: o
  que `query.outbox` devolve para o host, se `message.accepted` é emitido, se `dedupe`
  registra a op, e se o host consegue "ficar offline para si mesmo" (o `dev.hostOffline` do
  Apêndice B).
- **Qual decisão está faltando:** o caminho de escrita local do host e o estado inicial
  devolvido por `message.send` nesse caso.
- **Por que não pode ser inferida:** §12.3 diz "toda op passa pela fila do host", o que
  sugere chamada direta; §11.3 e o Apêndice A descrevem um caminho único para a UI, o que
  sugere loopback. As duas são defensáveis e produzem UIs com timing diferente.
- **Impacto:** metade das comunidades do dataset de referência é hospedada pela identidade
  local (Clã Noturno). O caminho é exercitado o tempo todo.
- **Severidade:** **HIGH**

## GAP DR-19 — Existe uma janela em que a mensagem aceita não está na outbox nem na projeção

- **Localização:** §11.3 passo 6 ("Cliente: **remove da outbox**, emite `message.accepted`.
  A projeção do append **chega pela replicação** e emite `messages.appended`"); §6.6 ("Append
  no host: **não** atômico com a projeção"); §10.1 ("eventos carregam o que mudou, não o novo
  estado. **O renderer reconsulta**").
- **O que a spec define:** que são dois momentos distintos, e que a UI reconsulta a cada
  evento.
- **O que o implementador precisaria saber:** o que a UI deve mostrar entre `message.accepted`
  e `messages.appended`. Seguindo a regra literalmente, ao receber `accepted` o renderer
  reconsulta `query.messages` (a mensagem ainda não está lá) e `query.outbox` (já foi
  removida) — a bolha otimista desaparece e reaparece. Em réplica lenta ou host remoto, isso
  pode durar centenas de ms.
- **Qual decisão está faltando:** quem segura a mensagem nessa janela — a outbox só é
  limpa em `messages.appended`? o `message.accepted` carrega dado suficiente para a UI
  renderizar sozinha? o renderer mantém a bolha por conta própria (e por quanto tempo)?
- **Por que não pode ser inferida:** a terceira opção contradiz §2.4 regra 4 ("nenhum estado
  de domínio vive no renderer"); a primeira contradiz §11.3 passo 6 literal; a segunda
  contradiz o princípio de §10.1 ("evento não é fonte de verdade").
- **Impacto:** é o caminho mais percorrido do produto (C9), e o sintoma é visível: mensagem
  piscando.
- **Severidade:** **HIGH** (≈ F-44 pelo lado do `clientRef` ausente; aqui é o estado
  intermediário sem dono)

## GAP DR-20 — Tabelas `local_*` são preservadas na reprojeção, mas não têm caminho de migração

- **Localização:** §5.4 ("Migração de schema SQLite é… trivial: incrementa
  `meta.schema_version`, **apaga a projeção** e reprojeta. **Não há migração de dado em
  SQLite, porque SQLite é descartável**"); §6.3 ("Local (**preservada** na reprojeção)");
  §6.4 ("As tabelas `local_*` sobrevivem — não-lidas, silenciados e a outbox não podem
  morrer por causa de uma mudança de schema").
- **O que a spec define:** que projeção é descartável e local é preservada.
- **O que o implementador precisaria saber:** o que fazer quando **uma tabela `local_*`**
  muda de forma (acrescentar `local_thread_read_state`, um campo em `local_device_pref`, um
  motivo novo em `local_outbox`). Elas não podem ser recriadas do log — por definição — e a
  spec declara que não há migração de dado. As duas afirmações juntas dizem que o schema
  local é imutável para sempre, o que não é sustentável.
- **Qual decisão está faltando:** a política de migração das tabelas locais (versão própria?
  `ALTER TABLE` incremental? default de coluna nova?).
- **Impacto:** aparece na primeira alteração pós-release, e o dado em risco é justamente o
  que a premissa 5 da UX promete não perder (a fila).
- **Severidade:** **MEDIUM**

## GAP DR-21 — A reprojeção total precisa da lista de comunidades que ela mesma apaga

- **Localização:** §2.3 (boot: "confere `meta.schema_version`"; `open`: "abre os cores das
  **comunidades participadas**"); §6.4 ("Reprojeção total dispara quando
  `meta.schema_version` ≠ versão do binário… Procedimento: **apaga só as tabelas de
  projeção**, zera os `last_projected_seq`, reprojeta do 0"); §6.3 (`communities` é tabela de
  **projeção**; nenhuma tabela `local_*` guarda a lista de participação nem as chaves de
  core).
- **O que a spec define:** a ordem lógica boot → detectar schema novo → apagar projeção →
  reprojetar.
- **O que o implementador precisaria saber:** depois de apagar `communities`, de onde sai a
  lista de `coreKey` a reabrir? O `corestore` guarda cores por namespace, mas §11.1 usa
  `corestore.namespace(random)` — sem o mapeamento namespace→comunidade, que também está só
  na projeção.
- **Qual decisão está faltando:** onde vive o registro autoritativo de participação e de
  chaves (tabela local? arquivo? namespace determinístico derivado do `coreKey`?).
- **Por que não pode ser inferida:** qualquer escolha muda a ADR-02 ("SQLite é descartável"),
  que é a decisão que §21.4 existe para proteger.
- **Impacto:** a primeira migração de schema depois do release apaga o app. E, no dia a dia,
  bloqueia escrever `storage.migrate()` e a sequência de boot — as duas primeiras coisas da
  fase 2.
- **Severidade:** **BLOCKER** (= F-01 pelo lado do dado; registrado aqui porque, na ordem de
  execução, ele para o boot antes de parar qualquer outra coisa)

## GAP DR-22 — Não há reconciliação dos itens `sending` da outbox depois de um crash

- **Localização:** §6.5 (coluna `state`: `queued` · `sending` · `failed` · `dropped`);
  §2.3 (crash e reinício do núcleo); §12.2 (dedupe por `opId`, janela de 7 dias).
- **O que a spec define:** os quatro estados e a política de retry por `next_attempt_at`.
- **O que o implementador precisaria saber:** um item marcado `sending` no instante do crash
  fica `sending` para sempre — o loop de `outbox.flush` (§13.1) pega itens `queued` cujo
  `next_attempt_at` passou, e `sending` não é `queued`. Não há passo de boot que os
  devolva.
- **Qual decisão está faltando:** o procedimento de recuperação no boot (varrer `sending`
  → `queued`? com incremento de `attempts`? consultando o host via `opId` antes?).
- **Por que não pode ser inferida:** devolver cegamente para `queued` é seguro **porque**
  existe dedupe — mas a janela de dedupe é de 7 dias e a de outbox é de 72 h, então a
  segurança depende de um raciocínio que a spec faz em outro contexto (§5.5) e não aplica
  aqui.
- **Impacto:** mensagem some silenciosamente da fila, que é exatamente o que a premissa 5 e
  §11.9 proíbem ("nunca some calado, nunca fica pendente para sempre").
- **Severidade:** **HIGH**

## GAP DR-23 — O conjunto de ops que entram na outbox é contraditório

- **Localização:** §6.5 (erros terminais da outbox incluem `E_LAST_CHANNEL`, `E_HIERARCHY`,
  `E_PERMISSION_DENIED`, `E_MESSAGE_DELETED` — códigos que **só** ops de estrutura,
  moderação e edição produzem); §11.5 ("Ops de **estrutura** não entram na fila: falham na
  hora com `E_HOST_UNAVAILABLE`"); §10.2 (só `message.send` é assíncrono; todos os outros
  comandos de escrita são ⏱ e devolvem `{seq}`); §25 delta 12 ("Só mensagem enfileira").
- **O que a spec define:** as três afirmações, que não fecham.
- **O que o implementador precisaria saber:** se só `message.send` enfileira, então
  `E_LAST_CHANNEL` e `E_HIERARCHY` nunca aparecem como motivo de `dropped` — e a lista de
  §6.5 é decorativa. Se outras ops enfileiram, §11.5 e o delta 12 estão errados. E o caso
  intermediário (reação, edição, pin, thread — nem estrutura nem exatamente mensagem) não é
  decidido por nenhum dos dois textos.
- **Qual decisão está faltando:** a lista fechada de `kind`s que a outbox aceita.
- **Impacto:** define o comportamento de metade das ações da tela 2.1 com host offline,
  que é o estado transversal mais visível da UX (banner `conn-offline`).
- **Severidade:** **HIGH** (≈ F-15 e F-30)

## GAP DR-24 — A máquina de estados da outbox não tem transições definidas

- **Localização:** §6.5 (estados e política de backoff); §10.2 (`message.retry{opId}` →
  `{state}`; `message.cancelQueued{opId}` → erros `E_NOT_FOUND`, `E_ALREADY_SENT`); §10.3
  (`message.failed{opId,code,retryInMs?}`, `message.dropped{opId,reason,channelId}`).
- **O que a spec define:** os quatro nomes de estado e os eventos.
- **O que o implementador precisaria saber:** um item em backoff está `queued` (com
  `next_attempt_at` no futuro) ou `failed`? `message.failed` é emitido a cada tentativa
  falha ou só na primeira? `message.retry` sobre item `dropped` é permitido (a UI oferece
  "Tentar novamente" no card de falha)? `cancelQueued` sobre item `sending` devolve
  `E_ALREADY_SENT` mesmo sem confirmação do host — e nesse caso o item continua no ar?
- **Qual decisão está faltando:** o diagrama de transições completo, com o gatilho de cada
  evento.
- **Impacto:** a UI de fila (premissa 5, B4) mostra contagens que saem daqui
  (`outbox.changed{queued, failed}`) — e sem as transições, dois clientes contam diferente.
- **Severidade:** **MEDIUM**

## GAP DR-25 — Não há enforcement de permissão nas queries de leitura, e `view_audit_log` fica sem ponto de aplicação

- **Localização:** §8.1 (`view_audit_log` — "Autoriza: **Ler** `moderation_log`, `bans`,
  `timeouts`"); §10.4 (tabela de queries — **não tem coluna de permissão**); §8.5 (três
  pontos de enforcement: firewall, validador do host, UI — nenhum deles é leitura local).
- **O que a spec define:** que a permissão autoriza uma leitura, e três pontos de
  enforcement que não incluem leitura.
- **O que o implementador precisaria saber:** se `query.auditLog` verifica a permissão
  efetiva antes de responder. E, mais fundo: o dado já está no SQLite local de todo membro
  (a projeção é integral, §6.2), então bloquear a query é cosmético — mas §8.5 diz
  explicitamente que "a UI esconder nunca é enforcement", o que sugere que alguém precisa
  aplicar.
- **Qual decisão está faltando:** se as queries verificam permissão, e o que devolvem quando
  não (erro `E_PERMISSION_DENIED`? lista vazia?).
- **Por que não pode ser inferida:** e há uma consequência de produto que não está registrada
  em §18.1 nem em §25: **em P2P, `view_audit_log` não é confidencialidade**, porque quem
  replica tem os bytes. Declarar isso é decisão de honestidade (princípio 3 da UX), não de
  implementação.
- **Severidade:** **MEDIUM**

## GAP DR-26 — `manage_community` e `create_invite` se contradizem sobre quem cria e revoga convite

- **Localização:** §8.1 (`manage_community` autoriza "`community.update`, **criar/revogar
  qualquer convite**, ver 3.1b"); §5.3 (`invite.create` — Permissão: **`create_invite`**;
  `invite.revoke` — Permissão: **`create_invite` + (autor do convite ou
  `manage_community`)**); §10.2 (`invite.create` — Perm.: `create_invite`).
- **O que a spec define:** duas regras diferentes para a mesma ação.
- **O que o implementador precisaria saber:** um cargo com `manage_community` e **sem**
  `create_invite` pode criar convite? Pela §8.1, sim; pela §5.3 e §10.2, não. E pode revogar
  um convite alheio? Pela §5.3, não (o `create_invite` é conjuntivo).
- **Qual decisão está faltando:** a regra final, que vai para a tabela declarativa que §8.4
  manda o `validator` ler.
- **Por que não pode ser inferida:** §8.4 diz que a matriz de enforcement é a de §5.3 — mas
  §8.1 é apresentada como o catálogo fechado e "idêntico ao que o frontend já implementa".
  Escolher uma das duas altera o que a tela 3.1b mostra.
- **Severidade:** **MEDIUM**

## GAP DR-27 — O "delta agregado" que o projetor devolve não tem forma

- **Localização:** §6.4 passo 5 ("Commit. Emite um **delta agregado** (§10.3) para o
  `communityClient`, que traduz em eventos IPC"); §3.2 (`projector` — "devolve um delta;
  quem emite é `communityClient`").
- **O que a spec define:** que existe um delta, e quem o consome.
- **O que o implementador precisaria saber:** a estrutura. §10.3 é o catálogo de eventos
  IPC, não o tipo do delta; e a tradução não é 1:1 — um lote de 256 registros pode gerar
  `messages.appended` por canal (com `fromSeq`/`toSeq`/`hasMention`), `members.changed` com
  a lista de chaves, `structure.changed` com ids, `roles.changed`, `unread.changed` por
  canal. Agregar isso exige que o reducer **reporte** o que tocou, e a assinatura
  `apply(op, tx) → void` (§12.4) não devolve nada.
- **Qual decisão está faltando:** o tipo do delta e como cada reducer contribui para ele sem
  quebrar a assinatura `→ void`.
- **Impacto:** sem delta não há evento; sem evento a UI não reconsulta, e todo o desenho de
  §10.1 para de funcionar.
- **Severidade:** **MEDIUM**

## GAP DR-28 — Nenhuma camada pode montar o estado de validação sem violar §3.1

- **Localização:** §3.1 (uma camada só importa das camadas **abaixo**); §3.2 (`storage`
  "não pode conter regra de negócio ou **SQL específico de domínio** (isso é dos
  reducers)"; `reducers` só escreve; `validator` é puro; `communityHost` é L2 e depende de
  `validator`, `corestore`, `rpcServer`, `presence`, `shareTree` — **não** de `storage`).
- **O que a spec define:** as proibições acima, e que o `validator` recebe estado pronto.
- **O que o implementador precisaria saber:** quem escreve os ~15 SELECTs que montam o
  estado de validação (existe canal? nome está livre? quantos emojis distintos? quantos
  convites ativos? qual o `topRole` do alvo?). `storage` não pode (é SQL de domínio),
  `reducers` é de escrita, `validator` é puro, `communityHost` não declara dependência de
  `storage`.
- **Qual decisão está faltando:** o módulo dono das leituras de domínio (um `queries`/`repo`
  em L1 que não existe na tabela de §3.2), e sua posição na hierarquia.
- **Por que não pode ser inferida:** a regra de dependência "deve quebrar o build" (§3.1),
  então acrescentar um módulo não declarado é decisão de arquitetura, que §0 proíbe ao
  implementador.
- **Impacto:** o mesmo problema atinge `search` (declarado com dependência de `storage`, o
  que sugere que SQL de domínio em L2 **é** permitido — mais uma leitura possível) e as
  queries de §10.4.
- **Severidade:** **MEDIUM**

---

# Bloco 3 — Fase 3: rede visível, outbox e estados de conexão

## GAP DR-29 — O estado inicial de `hostStatus` não existe, e "2 falhas consecutivas" não se aplica a quem nunca conectou

- **Localização:** §11.5 passo 1 ("`host.wentOffline` é emitido após **2 falhas
  consecutivas** de conexão — não na primeira"); §10.4 (`query.communities` devolve
  `hostStatus`; `query.hostStatus` devolve `{status, lastSeenAt, inactiveDays}`); §2.3 (fase
  `swarm`); `frontend.md` §12 (o rail pinta `conn-offline` a partir desse estado).
- **O que a spec define:** a transição para offline depois de duas falhas.
- **O que o implementador precisaria saber:** o que `query.communities` responde entre o
  boot e a primeira conexão bem-sucedida. No Hyperswarm não existe "falha de conexão" quando
  simplesmente não há peer: o `join` fica anunciando e nada acontece. Um host offline há três
  semanas nunca produz *falha* nenhuma — produz **ausência**. Então a regra das duas falhas
  cobre só o caso "estava conectado e caiu".
- **Qual decisão está faltando:** o estado inicial (`unknown`? `reconnecting`? `offline`?), o
  timeout de descoberta que promove ausência a offline, e se existe um estado "procurando"
  distinto de "offline".
- **Por que não pode ser inferida:** a UX distingue os três com cores e motion diferentes
  (`conn-reconnecting` com pulse ≠ `conn-offline` estático ≠ `conn-ok`), e escolher errado faz
  o app abrir piscando "reconectando" em todas as comunidades, ou mentir "offline" sobre um
  host que está a 300 ms de aparecer.
- **Impacto:** primeira tela depois do boot, em todas as comunidades, todas as vezes.
- **Severidade:** **HIGH**

## GAP DR-30 — Membros replicam entre si, e o `firewall` só existe no host: o banido continua lendo

- **Localização:** §6.2 (core `log` — "Replicado por: **todos os membros, integral**"); §3.2
  (`swarm` — "`firewall` recusa banidos **na conexão**"); §8.5 ("Firewall do swarm: recusa a
  conexão de quem está banido em **todas as comunidades que o nó hospeda**"); §18.1
  (adversário "Ex-membro banido" — **não consegue** "ler dado novo"); ADR-16 (todas as
  comunidades participadas ficam no swarm).
- **O que a spec define:** que o firewall é aplicado pelos nós **que hospedam**, e que o
  banido não lê dado novo.
- **O que o implementador precisaria saber:** o Hypercore replica de qualquer peer que tenha
  os blocos. Se só o host recusa o banido, o banido continua conectando a qualquer um dos
  outros 339 membros e recebendo o log integral — inclusive as mensagens posteriores ao ban.
  As duas afirmações não podem ser verdadeiras juntas.
- **Qual decisão está faltando:** se todo nó aplica o firewall de bans da comunidade (o que
  exige que cada nó mantenha a lista atualizada e feche conexões ao projetar um `mod.ban`),
  ou se a limitação é aceita e **declarada** em §18.1 e na nota de honestidade de 3.3 da UX.
- **Por que não pode ser inferida:** a primeira opção tem custo real (cada nó vira ponto de
  enforcement, e o §8.5 diz que são três, não N); a segunda muda o texto que a interface
  mostra ao moderador no momento do ban — e o princípio 3 da UX obriga a dizer a verdade ali.
- **Impacto:** modelo de ameaça e texto de produto.
- **Severidade:** **HIGH** (≈ F-10 pelo lado do preview de convite; este é o caminho de
  replicação, que a auditoria não cobre)

## GAP DR-31 — O rate limit de `inviteResolve` é "por IP de peer", e o IP não é a chave disponível

- **Localização:** §19.3 (última linha: "`inviteResolve` (**por IP de peer**, pré-membro)
  — 10/60 s"; "é por peer, não por identidade, porque quem resolve convite ainda não é
  membro"); §7 (o handshake Noise do `hyperdht` autentica a **chave pública** do par);
  §18.1 (observador do DHT).
- **O que a spec define:** o limite e a razão de ser por peer.
- **O que o implementador precisaria saber:** o que é a chave do bucket. O `hyperdht`
  entrega `remotePublicKey`; o IP existe no socket UDX, mas um atacante gera chave nova a
  cada tentativa de graça, e o IP muda com relay/CGNAT. Além disso, buckets de token vivem em
  memória (§19.3 não menciona persistência) e zeram a cada reinício do host — o que é
  exatamente o que um atacante de força bruta explora.
- **Qual decisão está faltando:** a chave do bucket (IP? `remotePublicKey`? par?), e se o
  estado do limitador sobrevive a reinício.
- **Por que não pode ser inferida:** §21.5 exige um teste de 10.000 tentativas em 60 s
  passando pelo rate limit — o teste não é escrevível sem a chave definida.
- **Severidade:** **MEDIUM**

## GAP DR-32 — `recent_channels` e `active_channel_id` têm dois donos

- **Localização:** §6.3 (`local_community_pref` tem `recent_channels`, `active_channel_id`,
  `collapsed_categories`); Apêndice A (`communityStore.setActiveChannel` → *"(fica local)"* —
  ou seja, permanece no renderer; `toggleCategoryCollapsed` → `category.setCollapsed`, que
  **vai** ao núcleo); §2.4 regra 4 (o renderer guarda só estado de sessão de interface —
  "painel aberto, canal ativo, colapso de categoria").
- **O que a spec define:** as colunas existem no núcleo; e o Apêndice A manda o canal ativo
  ficar no renderer, o colapso ir para o núcleo, e §2.4 lista os dois como estado de
  renderer.
- **O que o implementador precisaria saber:** quem é dono de cada um dos três campos, já que
  nenhum comando de §10.2 escreve `recent_channels` e o `active_channel_id` é declarado local
  ao renderer e, ao mesmo tempo, tem coluna no SQLite do núcleo.
- **Qual decisão está faltando:** a fronteira exata entre `persist` do Zustand e
  `local_community_pref`.
- **Impacto:** duas fontes de verdade para navegação — o bug clássico que §2.4 existe para
  evitar. E o estado vazio da busca (1.2, "canais visitados recentemente") não tem escritor.
- **Severidade:** **LOW**

## GAP DR-33 — O enum de `hostStatus` não está definido em lugar nenhum

- **Localização:** §10.4 (`query.communities` → `hostStatus`; `query.hostStatus` →
  `{status, lastSeenAt, inactiveDays}`); §10.3 (eventos `host.wentOffline`,
  `host.cameBack`, `host.reconnecting{attempt}`); §4.2 (estados `cache-only`,
  `hosting-degraded`); `frontend.md` §2 (`hostStatus`: online/offline/reconectando).
- **O que a spec define:** os eventos e os nomes de estado em prosa.
- **O que o implementador precisaria saber:** o conjunto fechado de valores de `status`, se
  `hosting-degraded` e `cache-only` aparecem nele, e se `isHostedByMe` produz um valor
  próprio (o host nunca está "offline" para si mesmo, mas pode estar `hosting-degraded`).
- **Qual decisão está faltando:** o enum, que é consumido pelo rail, pelo banner, pelo
  composer e pela busca.
- **Severidade:** **MEDIUM**

---

# Bloco 4 — Fase 4: convites e entrada

> Os três achados CRITICAL da auditoria nesta área (F-02 prova de convite alheio, F-06
> autoria de `member.join`, F-09 transporte pré-membro) **bloqueiam a fase inteira** e não
> são repetidos aqui. Os GAPs abaixo são os que aparecem depois deles, ao escrever o código.

## GAP DR-34 — O parsing do código e do link de convite não tem regra

- **Localização:** ADR-09 (10 bytes, Crockford Base32, 16 caracteres, "exibido em 4 grupos de
  4": `X7K2-QM9F-RT4B-N8ZP`); §10.2 (`invite.resolve{codeOrLink}`,
  `invite.redeem{codeOrLink}`); §23 fase 1 (deep links `comunidadep2p://`); `frontend.md` §2
  (link de exemplo `p2p.app/invite/x7K2qM`) e §7 (0.3: campo "cole um link ou código").
- **O que a spec define:** o alfabeto de exibição e o número de caracteres.
- **O que o implementador precisaria saber:** se os hífens são obrigatórios na entrada; se a
  normalização de Crockford (aceitar `I`/`l` como `1`, `O`/`o` como `0`, ignorar hífen,
  caixa livre) é obrigatória na **decodificação** — ADR-09 justifica o alfabeto por erro de
  transcrição verbal, o que só ajuda se o decodificador normalizar; quais formas de link são
  aceitas (`comunidadep2p://invite/<code>`, `https://p2p.app/invite/<code>`, ambas?); e o que
  responder a uma string com 16 caracteres válidos mas que não corresponde a convite nenhum
  (`invalid` de §10.2.1) versus uma string malformada (`E_MALFORMED`).
- **Qual decisão está faltando:** a gramática de entrada aceita e a tabela de normalização.
- **Por que não pode ser inferida:** a fronteira entre `E_MALFORMED` (erro de forma, síncrono,
  inline no campo) e `status:"invalid"` (desfecho de preview, com texto próprio) é decisão de
  UX além de backend, e a spec de UX só descreve o segundo.
- **Severidade:** **MEDIUM**

## GAP DR-35 — Sair, ser expulso ou ser banido não tem ciclo de vida de dado definido no cliente do alvo

- **Localização:** §11.9 (a fila é descartada com motivo `left-community`); §13.6 ("Blob de
  comunidade que a identidade deixou → removido imediatamente"); §4.3 (ciclo de vida do
  Member); §10.3 (evento `community.left`); §10.2 (`community.leave` ⏱).
- **O que a spec define:** o efeito na fila e nos blobs.
- **O que o implementador precisaria saber:** depois de sair (ou ser expulso, ou banido): o
  core continua aberto e replicando? sai do swarm? as linhas de projeção daquela comunidade
  são apagadas (e nesse caso a reprojeção as recria, porque o log continua lá)? a comunidade
  some do rail (`query.communities` filtra por quê — não existe coluna de participação, ver
  DR-21/F-01)? o histórico continua legível, como acontece em `community.end` (§11.21)?
- **Qual decisão está faltando:** o procedimento completo de saída, nos três gatilhos
  (voluntário, kick, ban), incluindo o que acontece com o dado local.
- **Por que não pode ser inferida:** há um precedente contraditório dentro da própria spec:
  comunidade `ended` mantém o core "em leitura para o histórico continuar acessível", e
  comunidade que a identidade deixou tem os blobs apagados **imediatamente**. As duas
  posturas sobre o mesmo tipo de evento apontam para políticas diferentes.
- **Severidade:** **MEDIUM** (≈ F-35, que ataca o lado do alvo de moderação; aqui é a
  saída voluntária, que tem comando IPC próprio)

## GAP DR-36 — `community.end` sai do swarm como servidor antes de garantir que a op foi replicada

- **Localização:** §11.21 ("Appenda a op, projeta `ended_at`, para de aceitar qualquer op,
  **sai do swarm como servidor** mas mantém o core em leitura"); §10.2.1 (novo desfecho de
  preview `status:"ended"`, que o **host** precisa responder).
- **O que a spec define:** a sequência, sem janela de propagação.
- **O que o implementador precisaria saber:** um membro offline no momento do `community.end`
  nunca recebe o registro, porque o host deixou de anunciar. Para ele a comunidade fica
  eternamente "host offline", não "encerrada" — que são estados diferentes na UI (`ended` é
  terminal e some do modo cache; `offline` promete volta). E o desfecho `ended` do preview
  exige que o host responda `inviteResolve`, o que ele não faz mais depois de sair do swarm.
- **Qual decisão está faltando:** por quanto tempo (ou sob que condição) o host continua
  servindo depois de `community.end`, e o que o cliente mostra enquanto não souber.
- **Severidade:** **MEDIUM**

---

# Bloco 5 — Fase 5: anexos e busca

## GAP DR-37 — Não há mecanismo para o núcleo verificar que o caminho de `blob.stage` veio de um diálogo do SO

- **Localização:** §18.4 ("Caminho em `blob.stage`: **precisa vir de um diálogo de arquivo do
  SO**; caminho arbitrário do renderer é **recusado**"); §10.2 (`blob.stage{communityId,
  path}`); §18.5 (`sandbox: true`, `contextIsolation: true` no renderer).
- **O que a spec define:** a regra de segurança e o argumento do comando (uma string de
  caminho).
- **O que o implementador precisaria saber:** como o núcleo distingue um caminho legítimo de
  um forjado. Uma string é uma string: sem um token de capacidade emitido pelo main no
  momento do diálogo (que não existe em nenhum contrato), a regra não é aplicável. Além
  disso, com `sandbox: true` o renderer não tem caminho de arquivo por padrão — obtê-lo exige
  um caminho próprio do Electron, que a spec não nomeia, e o diálogo é do **main**, que não
  tem canal com o núcleo para isso (ver DR-03).
- **Qual decisão está faltando:** o protocolo de handoff do arquivo (token de uso único?
  descritor? o main faz o `stage` e passa o `blobId`?).
- **Por que não pode ser inferida:** é regra de §18 (segurança). Inventar aqui é inventar
  superfície de ataque — um `blob.stage` sem verificação lê qualquer arquivo do usuário e o
  publica num core replicado.
- **Impacto:** trava a fase 5 e o fluxo C9 com anexo.
- **Severidade:** **HIGH**

## GAP DR-38 — `query.links` não tem tabela, regra de extração nem ordenação

- **Localização:** §10.4 (`query.links{channelId, cursor?, limit=25}` → "URLs extraídas, sem
  unfurl"); §6.3 (não existe tabela de links); §15.1 (filtro `kind: link` = "`content` casa
  `https?://`"); §15.3 (paginação por cursor, lote 25); `frontend.md` 2.1.2 (aba Links: "URLs
  extraídas das mensagens do canal, com **título do domínio**, quem postou e data").
- **O que a spec define:** que a aba existe e não faz unfurl.
- **O que o implementador precisaria saber:** onde os links vivem (extraídos no reducer para
  uma tabela? extraídos a cada query com regex sobre `content`?); qual é a regra de extração
  (mesma regex do `lib/markdown.tsx`? só `https?://`? e-mails? links markdown
  `[texto](url)`?); se uma mensagem com 5 URLs vira 5 linhas; se URLs repetidas colapsam;
  qual a ordenação; e como paginar por cursor `{seq, id}` quando a unidade não é a mensagem.
- **Qual decisão está faltando:** o modelo de dado da aba Links.
- **Por que não pode ser inferida:** extrair no reducer muda o schema (tabela nova, projeção,
  reprojeção); extrair na query torna o cursor de §15.4 mal definido. Não há default seguro.
- **Severidade:** **MEDIUM**

## GAP DR-39 — A consulta FTS5 não define combinação de tokens nem tratamento dos operadores da sintaxe MATCH

- **Localização:** §15.1 (Normalização: NFD, sem diacrítico, minúsculo; Tokens: "split por
  não-alfanumérico; tokens de 1 caractere são descartados"; Match: "`MATCH` no FTS5 com
  prefixo no último token (`revis*`)"); ADR-13.
- **O que a spec define:** a normalização e o prefixo no último token.
- **O que o implementador precisaria saber:** (1) tokens múltiplos são combinados com **AND
  ou OR**? Nada diz. `"revisar fila"` devolvendo mensagens que contêm qualquer uma das duas é
  um produto diferente de devolver as que contêm as duas. (2) Tokens que são **operadores do
  FTS5** — `AND`, `OR`, `NOT`, `NEAR` — passam o filtro alfanumérico e são interpretados como
  sintaxe, gerando resultado errado ou erro de SQL; a spec não manda citar os tokens.
  Buscar por "not" é plausível em português também (nomes próprios, siglas). (3) Se
  `limitPerGroup=20` é aplicado antes ou depois dos filtros de data/autor.
- **Qual decisão está faltando:** a expressão MATCH final, com combinação e citação de
  tokens.
- **Por que não pode ser inferida:** a diferença AND/OR é decisão de produto (o §11.15 diz
  que consulta vazia devolve resultado vazio, mas não diz nada sobre múltiplos termos), e a
  citação é decisão de robustez que muda o resultado de buscas legítimas.
- **Severidade:** **MEDIUM**

## GAP DR-40 — `local_blob_cache.state` não tem enum, e não há retomada de download após crash

- **Localização:** §6.3 (`local_blob_cache`: `bytes_downloaded`, `state`, `path`,
  `verified_at`); §11.13 ("linha em `local_blob_cache` marcada `owned`"); §14.3 (diagrama com
  `not-downloaded`, `downloading`, `downloaded`, `unavailable`, `corrupt`, `seeding`);
  §13.6 (GC por LRU de `verified_at`, "**exceto** os que a identidade local enviou").
- **O que a spec define:** um diagrama de estados de leitura e um valor extra (`owned`)
  citado só em §11.13.
- **O que o implementador precisaria saber:** o conjunto fechado da coluna (o diagrama tem 6
  nomes, `owned` é um sétimo, e `seeding` parece ser condição derivada, não estado); o que
  acontece com uma linha em `downloading` quando o processo cai (retoma no boot? volta a
  `not-downloaded`? espera o usuário?); e como o GC distingue "enviado por mim" (é o valor
  `owned`? uma coluna que não existe?).
- **Qual decisão está faltando:** o enum e a política de retomada.
- **Severidade:** **MEDIUM**

## GAP DR-41 — O mapa extensão → `kind` de anexo não existe

- **Localização:** §4.10 (`kind`: `video`·`image`·`audio`·`document`·`other`); §11.13
  ("`kind` inferido da **extensão**, com `other` como default").
- **O que a spec define:** o enum e a fonte da inferência.
- **O que o implementador precisaria saber:** a tabela. Ela é contrato porque o `kind` é
  replicado (vai na op, §5.3) e a UI escolhe o ícone por ele — dois clientes com tabelas
  diferentes produzem cards diferentes para o mesmo arquivo, e o valor fica congelado no log.
- **Qual decisão está faltando:** a lista de extensões por categoria.
- **Severidade:** **LOW**

---

# Bloco 6 — Fases 6 e 7: voz, câmera e tela

> Os achados F-08 (qualidade por espectador vs. repasse opaco), F-18 (quem é espectador),
> F-19 (candidato ICE do DHT), F-20 (áudio no fallback UDX) e F-42 (200 espectadores vs.
> 1–2 s) já bloqueiam estas fases. Abaixo, o que trava depois deles.

## GAP DR-42 — "Fala ativa" não tem fonte: o roster do host não carrega `speaking`

- **Localização:** §4.16 (`VoiceRoster` — `participants[{key, muted, deafened, cameraOn,
  sharing}]`); §10.3 (`voice.roster{channelId, participants[]}`); `frontend.md` §2
  (`VoiceSession.participantes[{… falando: bool …}]`), §5.4 ("indicador de fala ativa —
  nunca só cor: anel animado"), §9 2.3 ("o anel reflete quem está falando **em tempo
  real**") e 2.3.1 ("anel de fala **visível mesmo recolhido**", inclusive quando a chamada é
  de outra comunidade).
- **O que a spec define:** o roster sem o campo, e uma UI que exige o campo em dois lugares.
- **O que o implementador precisaria saber:** quem produz o sinal. A leitura natural é que o
  renderer o calcule dos próprios `RTCPeerConnection` (nível de áudio por track), o que é
  plausível e barato — mas contradiz §2.4 regra 1/4 apenas em parte e, sobretudo, **não está
  escrito em lugar nenhum**, nem como evento IPC, nem como campo do roster, nem como
  responsabilidade de módulo (§3.2 `voiceCoordinator`: "não pode ver mídia").
- **Qual decisão está faltando:** a origem do `speaking` e o caminho até a UI.
- **Interpretações plausíveis:** (a) renderer calcula localmente por `AudioLevel` e nunca
  passa pelo núcleo — então o campo não existe em contrato nenhum e a UI o mantém sozinha;
  (b) cada par publica seu nível no protocolo efêmero e o host reemite — o que acrescenta uma
  mensagem a §10.7 e um campo ao roster.
- **Impacto:** é um dos dois elementos que §5.4 declara serem requisito de acessibilidade
  ("forma + movimento, não só cor").
- **Severidade:** **MEDIUM**

## GAP DR-43 — A árvore atribui pais, mas não define como pai e filho se conectam

- **Localização:** §10.6 (`shareJoin{sessionId, canRelay, uplinkKbps}` →
  `{parentKey, level}`); §10.7 (`treeAssign` — host → nó); §10.8 (stream UDX **dedicado por
  aresta**); §11.17 (passos 4-8); §11.17.1 (recálculo incremental — "só quem muda de pai
  recebe `share.assignment`").
- **O que a spec define:** que o filho aprende o `parentKey` e que existe um stream por
  aresta.
- **O que o implementador precisaria saber:** quem inicia a conexão (o filho disca para o
  pai pelo `hyperdht`? o pai disca para os filhos?); como o pai sabe que deve **aceitar** e
  servir aquele filho (ele recebe `treeAssign` com `childKeys[]`, mas em que ordem em relação
  ao `shareJoin` do filho? se o filho chegar antes, o pai recusa? bufferiza?); o que o filho
  faz enquanto o pai não responde; e o que acontece na reatribuição (o filho fecha o stream
  antigo antes ou depois de abrir o novo — a diferença é entre um corte de vídeo e um
  keyframe duplicado).
- **Qual decisão está faltando:** o handshake da aresta e a ordem de reatribuição.
- **Por que não pode ser inferida:** é uma corrida real entre duas mensagens vindas do mesmo
  host por canais diferentes (RPC e efêmero), e a política de reparo (§11.17.1) depende dela.
- **Severidade:** **HIGH**

## GAP DR-44 — `uplinkKbps` é "medido", mas quem acaba de entrar não tem medição

- **Localização:** §11.17.1 ("Candidatos a repasse: consentimento aceito **e**
  `uplinkKbps ≥ 1,5 × bitrate × fanout` **e** NAT não-CGNAT. O critério é **medido**, não
  declarado — `uplinkKbps` vem de estatística real do UDX numa **janela de 10 s**, não de
  auto-declaração"); §10.6 (`shareJoin` recebe `uplinkKbps` **do próprio cliente**).
- **O que a spec define:** que o valor é medido em 10 s de UDX, e ao mesmo tempo que ele
  chega no argumento de `shareJoin`, enviado pelo cliente.
- **O que o implementador precisaria saber:** um espectador que acabou de entrar só recebe
  dado; ele não fez upload nenhum, então a estatística de upload dele é zero ou inexistente.
  Medir o quê, então? E se o valor vem no argumento, ele **é** auto-declarado — um cliente
  adulterado mente e ganha filhos, que é exatamente o que o texto diz querer evitar.
- **Qual decisão está faltando:** quem mede, o que mede, e o valor inicial de quem nunca
  repassou.
- **Interpretações plausíveis:** (a) o host mede o RTT/throughput do próprio stream com
  aquele peer e ignora o `uplinkKbps` recebido — e então o argumento de `shareJoin` sobra;
  (b) o valor é declarado e o "medido" de §11.17.1 se refere a uma verificação posterior,
  com rebaixamento — política que não existe.
- **Impacto:** é a entrada do único algoritmo declarado "fechado" da fase 7.
- **Severidade:** **MEDIUM**

## GAP DR-45 — Relação mudo/ensurdecer e persistência do volume por participante

- **Localização:** §10.2 (`voice.setSelf{muted?, deafened?, cameraOn?}`;
  `voice.setParticipantVolume{identityKey, volume}` — marcado "**local**"); §6.3
  (`local_device_pref` tem `input_volume`/`output_volume`, **não** volume por participante);
  `frontend.md` Parte 8 ("Ensurdecer implica mudo… A spec lista os dois controles **sem
  definir a relação**; é a convenção do gênero").
- **O que a spec define:** os três campos independentes e um comando local de volume.
- **O que o implementador precisaria saber:** se `deafened: true` força `muted: true` no
  núcleo (o frontend já decidiu que sim, por conta própria, e isso vira contrato observável
  no roster que todos veem) e onde o volume por participante é guardado — não há tabela, e
  ele é "local", então talvez nem devesse passar pelo núcleo.
- **Qual decisão está faltando:** a regra de acoplamento mudo/ensurdecer no roster
  replicado-efêmero, e o dono do volume por participante.
- **Severidade:** **LOW**

---

# Bloco 7 — Contratos de leitura e o que a UI exige

## GAP DR-46 — Nenhuma query de §10.4 tem schema de resposta, e não há mapeamento para os tipos que o frontend já usa

- **Localização:** §10.4 (17 queries descritas em uma linha cada — ex.: `query.message` →
  "Mensagem + resolvidos (autor, reações, anexo, thread)"; `query.members` → "Agrupado por
  cargo, offline agregado em contagem"); Apêndice A ("a **assinatura da ação não muda** — só
  o corpo"; "Todos os `select*` de leitura → `query.*`"); `frontend.md` (§2 modelo de
  domínio em português; Parte 1: "campos do domínio em inglês… com o mapeamento anotado onde
  não é óbvio", em `src/domain/types.ts`).
- **O que a spec define:** o nome, o argumento e uma descrição em prosa da resposta.
- **O que o implementador precisaria saber:** os campos exatos, tipos, opcionalidade e forma
  de aninhamento de cada resposta — incluindo como `bytes[32]` vira hex (§0.4 diz que vira,
  mas não onde), como `blob_id` (JSON em coluna) é devolvido, e se `query.members` devolve
  uma lista plana com `roleIds` ou grupos já montados ("agrupado por cargo" sugere o
  segundo).
- **Qual decisão está faltando:** o contrato de resposta de cada query, e o mapeamento
  campo-a-campo para `frontend/src/domain/types.ts`, que já está em código e verificado.
- **Por que não pode ser inferida:** o Apêndice A promete que a UI não muda; isso só se
  sustenta se a resposta da query **for** o tipo que a store já entrega. Como esse tipo não
  está reproduzido aqui, o implementador do backend teria que lê-lo do código do frontend e
  congelá-lo por conta própria — o que é exatamente inventar contrato de fronteira.
- **Impacto:** as 17 queries são a superfície de leitura inteira do produto. É o maior item
  de retrabalho possível: descobrir a divergência só quando a store for trocada.
- **Severidade:** **HIGH**

## GAP DR-47 — Quem reagiu não tem contrato de leitura, e a UI mostra até 6 nomes

- **Localização:** §6.3 (`reactions` guarda `identity_key`); §10.4 (`query.message` →
  "Mensagem + resolvidos (autor, **reações**, anexo, thread)"; `query.messages` → sem
  detalhe); `frontend.md` §9 2.1 ("**Hover num chip de reação** mostra tooltip com quem
  reagiu — até 6 nomes, depois 'e mais N'. É pra isso que `Reaction.usuários[]` existe").
- **O que a spec define:** o dado existe na tabela; a UI o exibe; nenhuma query o promete.
- **O que o implementador precisaria saber:** se `query.messages` (lote de 50) já traz os
  reatores de cada emoji de cada mensagem — o que pode ser muito dado (20 emojis × N pessoas
  × 50 mensagens) —, se traz só contagem + "eu reagi", ou se existe uma query dedicada por
  chip (que não está no catálogo).
- **Qual decisão está faltando:** onde os reatores entram no contrato de leitura.
- **Por que não pode ser inferida:** o §19.1 fixa `query.messages` (50 msgs) em < 3 ms; a
  escolha muda o custo dessa query em ordem de grandeza.
- **Severidade:** **MEDIUM**

## GAP DR-48 — Não-lidas de thread não têm tabela local nem query

- **Localização:** §4.8 (`Thread.unreadCount` — marcado **`local`**, remetendo a §4.15);
  §4.15 (a tabela `read_state` é por **canal**: `(communityId, channelId)`; **não há
  entrada de thread**); §6.3 (`local_read_state` PK `(community_id, channel_id)`); §10.4
  (`query.thread{threadId, cursor?, limit}` → `{root, replies[], nextCursor?}` — sem
  contagem); §10.3 (`unread.changed` é por canal); `frontend.md` §9 2.2 ("não lida — badge no
  indicador '💬 N respostas'").
- **O que a spec define:** o campo existe na entidade, é local, e nada mais.
- **O que o implementador precisaria saber:** onde o watermark de thread é gravado e como é
  calculado (respostas da thread também estão no canal — §4.8: "não é compartimento
  separado" —, então elas já contam no não-lido do canal; contar de novo na thread é dobra
  ou é outra dimensão?).
- **Qual decisão está faltando:** a tabela local de leitura por thread e a regra de contagem
  frente ao não-lido do canal.
- **Severidade:** **MEDIUM**

## GAP DR-49 — No log de auditoria, o rótulo do **alvo** é congelado, mas o do **autor** não

- **Localização:** §4.13 (`targetLabel` — "Rótulo **congelado no momento do append**"; e a
  justificativa: "o nome de um canal excluído há três semanas não existe mais em lugar
  nenhum"); a mesma ficha lista `byKey` como chave crua, sem `byLabel`; `frontend.md` §10 3.3
  ("**Bianca Souza** baniu `Usuário#4471`").
- **O que a spec define:** o congelamento só de um dos dois lados.
- **O que o implementador precisaria saber:** como renderizar o nome de quem executou a ação
  quando essa pessoa saiu da comunidade (a linha `members` continua existindo com `left_at`,
  então o nome sobrevive — mas se ela nunca chegou a ser projetada, ou se o `identity.update`
  posterior mudou o nome, a linha antiga do log passa a exibir o nome novo, o que contradiz o
  espírito do congelamento).
- **Qual decisão está faltando:** se `by` também congela rótulo, ou se é resolvido ao vivo e
  isso é aceito.
- **Severidade:** **LOW**

## GAP DR-50 — `dev.seedDataset` não tem origem para as identidades do dataset de referência

- **Localização:** Apêndice B (`dev.seedDataset` — "Cria as 3 comunidades de §2 **por ops
  reais**"); §21.7 ("os 15 fluxos… rodados contra o backend real, com o dataset de referência
  recriado **por script a partir de ops**"); `frontend.md` §2 (340 membros em Vale do Código,
  dos quais 5 nomeados + "307 offline"; `Usuário#4471` só existe como alvo de ban).
- **O que a spec define:** que o dataset é recriado por ops reais.
- **O que o implementador precisaria saber:** ops são assinadas por identidades (§5.1), então
  recriar Rafael, Bianca, Diego, Fernanda e 336 anônimos exige 340 pares de chaves e 340
  `member.join` — que, por F-06, hoje ninguém consegue produzir. Mesmo resolvido F-06: as
  chaves são geradas e descartadas? ficam fixas em fixture (e então o dataset tem chaves
  privadas commitadas)? o "307 offline" é materializado como 307 membros ou como uma
  contagem?
- **Qual decisão está faltando:** a fonte de identidades do seed e o grau de fidelidade
  exigido.
- **Impacto:** §21.7 é o teste que fecha a paridade UI↔backend, e §19.1/§21.6 dependem de um
  dataset de 340 membros.
- **Severidade:** **MEDIUM**

---

# Bloco 8 — Configuração, observabilidade e transversais

## GAP DR-51 — Três constantes normativas ficam fora da tabela de configuração, que se declara exaustiva

- **Localização:** §20 ("**Regra:** nenhum valor de negócio fica hard-coded fora desta
  tabela. Quem precisar de um número novo acrescenta uma linha aqui, com default e faixa");
  a tabela **não tem** `IPC_EVENT_HIGHWATER` (§10.1, default 1000), `MAX_ENVELOPE_BYTES`
  (§9.1, 32/64 KiB) nem `INVITE_MAX_ACTIVE` (§9.3, default 50); e a linha `P2P_RATE_*`
  remete a §19.3 sem nomear as 8 variáveis.
- **O que a spec define:** a regra, e uma tabela que a viola em pelo menos quatro pontos.
- **O que o implementador precisaria saber:** os nomes exatos das variáveis (contrato de
  operação e de teste — §21.2 e o Apêndice B dependem de sobrescrever alguns), e o
  comportamento quando um valor de `config.json` ou de ambiente está **fora da faixa**
  (recusa o boot? satura no limite? ignora e usa o default? loga?). §20 lista faixas e não
  diz o que fazer quando são violadas.
- **Qual decisão está faltando:** as linhas faltantes e a política de valor inválido.
- **Severidade:** **LOW**

---

# Consolidação

## BLOCKERS — impedem começar a implementação

| ID | Onde para | Fase travada |
|---|---|---|
| **DR-01** | Critério de aceite do spike e regra de decisão `utilityProcess` vs `bare-sidecar` | 0 (e, por consequência, todas) |
| **DR-03** | Contrato do canal main↔núcleo + a chave privada atravessando-o | 1 (`keystore`, `identity`) |
| **DR-10** | Layout de encoding por `kind`; representação de campo opcional; canonicidade | 2 (`opCodec` → tudo) |
| **DR-11** | Derivação dos ids de `role`/`category`/`channel` | 2 (bootstrap de comunidade) |
| **DR-12** | Como a projeção deriva `isFounder`/`isDefault` | 2 (reducer de `role.create`, invariante I-2) |
| **DR-14** | Tipo de `state` em `validate(op, state)` | 2 (`validator` e os ~600 testes de §21.1) |
| **DR-21** | Onde vive a lista de comunidades/chaves que a reprojeção apaga | 2 (`storage.migrate`, boot) |

Somados aos seis CRITICAL da auditoria (F-01…F-06), há **13 pontos de parada** antes da
primeira linha da fase 2 — e a fase 2 é a que "derruba a maior parte das fixtures".

## HIGH — provocariam retrabalho

| ID | Assunto | Custo do erro |
|---|---|---|
| DR-02 | Build, empacotamento e migração do frontend para Electron | Refazer a fundação do app |
| DR-05 | Semântica de `sub`/`unsub`/`filter` e correlação de `ev` | Muda o quadro IPC — contrato de fronteira |
| DR-06 | Mecanismo de backpressure (não existe medição em `MessagePort`) | Quadro novo no protocolo IPC |
| DR-07 | Reconexão do IPC após crash do núcleo | Duplicata/fantasma na tela; retrabalho em toda store |
| DR-15 | Quais estágios do pipeline rodam no cliente | Refaz validação de todo formulário de §13 |
| DR-18 | Caminho de escrita das ops do próprio host | Refaz o fluxo de envio para metade do dataset |
| DR-19 | Janela entre `message.accepted` e `messages.appended` | Refaz o casamento da mensagem otimista |
| DR-22 | Recuperação de itens `sending` após crash | Quebra a promessa da premissa 5 |
| DR-23 | Conjunto de `kind`s que a outbox aceita | Refaz o comportamento offline da tela 2.1 |
| DR-29 | Estado inicial de `hostStatus`; ausência ≠ falha | Banner e rail errados no boot, sempre |
| DR-30 | Firewall só no host, mas todos replicam | Modelo de ameaça e texto de produto |
| DR-37 | Proveniência do caminho em `blob.stage` | Regra de segurança de §18 sem mecanismo |
| DR-43 | Handshake pai↔filho na árvore de tela | Refaz o transporte da fase 7 |
| DR-46 | Ausência de schema de resposta nas 17 queries | O maior item: descobre a divergência ao trocar as stores |

## MEDIUM

DR-04 (deep link vs. instância única) · DR-08 (`core.status` com duas formas) · DR-13
(assinatura do reducer sem `seq`/`hostTs`) · DR-16 (manutenção do FTS5 externo) · DR-17
(`content` no tombstone vs. `NOT NULL`) · DR-20 (migração das tabelas `local_*`) · DR-24
(máquina de estados da outbox) · DR-25 (permissão em query de leitura) · DR-26
(`manage_community` × `create_invite`) · DR-27 (forma do delta do projetor) · DR-28 (módulo
dono das leituras de domínio) · DR-31 (chave do bucket de `inviteResolve`) · DR-33 (enum de
`hostStatus`) · DR-34 (parsing de código/link de convite) · DR-35 (ciclo de vida do dado ao
sair) · DR-36 (`community.end` e quem estava offline) · DR-38 (`query.links` sem modelo) ·
DR-39 (combinação de tokens e operadores no FTS5) · DR-40 (`local_blob_cache.state` e
retomada) · DR-42 (fonte de "fala ativa") · DR-44 (`uplinkKbps` de quem acabou de entrar) ·
DR-47 (contrato de quem reagiu) · DR-48 (não-lidas de thread) · DR-50 (identidades do
`seedDataset`).

## LOW

DR-09 (alfabeto do `handle`) · DR-32 (dono de `recent_channels`/`active_channel_id`) ·
DR-41 (extensão → `kind`) · DR-45 (mudo/ensurdecer e volume por participante) · DR-49
(rótulo do autor no log de auditoria) · DR-51 (constantes fora de §20 e valor fora da
faixa).

---

# Decisões que precisam ser congeladas antes da implementação

Ordenadas por dependência: cada bloco é pré-requisito do seguinte.

### Antes da fase 0 terminar
1. **Definição de pronto do spike** e a regra binária de decisão `utilityProcess` /
   `bare-sidecar`, com a matriz de SOs e o tipo de exercício (carga vs. transação longa
   empacotada). — DR-01
2. **Estrutura de repositório, build e empacotamento**, e o escopo da migração do frontend
   web → Electron (com o texto de §0.1 corrigido, se for o caso). — DR-02

### Antes da primeira linha da fase 1
3. **Contrato do canal main↔núcleo**, incluindo a decisão explícita sobre a chave privada
   atravessá-lo. — DR-03
4. **Protocolo IPC completo**: semântica de assinatura, gramática de `filter`, controle de
   fluxo com quadro de ack, e handshake de reconexão pós-crash. — DR-05, DR-06, DR-07

### Antes da primeira linha da fase 2
5. **Registry de encoding**, campo a campo, dos 29 (ou 34) `kind`s, com representação de
   opcionalidade e definição de canonicidade. — DR-10
6. **Regra de derivação de todos os ids de entidade** (e, se for por payload, o campo novo em
   três ops). — DR-11
7. **Origem de `isFounder`/`isDefault`.** — DR-12
8. **Tipo de `state` do validador**, o módulo que o monta, e o subconjunto de estágios que
   roda no cliente. — DR-14, DR-15, DR-28
9. **Onde vive a lista autoritativa de participação e de chaves de core** (fecha DR-21 e
   F-01 no mesmo movimento).
10. **Assinatura real do reducer** e **forma do delta do projetor**. — DR-13, DR-27
11. **Comportamento do tombstone sobre `content` e sobre o índice FTS.** — DR-16, DR-17

### Antes da fase 3
12. **Conjunto de `kind`s que a outbox aceita**, máquina de estados completa e recuperação de
    `sending` no boot. — DR-22, DR-23, DR-24
13. **Caminho de escrita do host para as próprias ops.** — DR-18
14. **Estados de conexão**: enum fechado, estado inicial, e a diferença entre ausência e
    falha. — DR-29, DR-33
15. **Janela `accepted` → `appended`**: quem segura a mensagem. — DR-19

### Antes da fase 4
16. **Enforcement de ban na replicação entre membros** — aplicar em todo nó, ou declarar a
    limitação em §18.1 e no texto de 3.3 da UX. — DR-30

### Antes da fase 5
17. **Protocolo de handoff de arquivo para `blob.stage`.** — DR-37

### Antes da fase 7
18. **Handshake de aresta da árvore e ordem de reatribuição.** — DR-43

### Contínuo, mas antes de trocar qualquer store
19. **Schema de resposta das 17 queries de §10.4**, com mapeamento explícito para
    `frontend/src/domain/types.ts`. — DR-46, DR-47, DR-48

---

# Perguntas para o arquiteto

Formuladas para serem respondíveis com uma frase e virarem texto de spec.

**Fundação e processo**
1. O que exatamente o spike da fase 0 precisa demonstrar para ser considerado aprovado, e
   quem assina isso? (DR-01)
2. "Sem tocar em componente nenhum" (§0.1) sobrevive à migração para Electron, ou o texto
   precisa ser corrigido? (DR-02)
3. A chave privada pode trafegar main↔núcleo, ou §7 proíbe também esse canal? Se proíbe, quem
   assina as ops? (DR-03)

**Log e projeção**
4. Publicar o registry de encoding por `kind`: qual é o tipo de cada campo, em que ordem, e
   como um campo opcional ausente é representado nos bytes? (DR-10)
5. Ids de cargo, categoria e canal derivam do `opId` (e §4.4 muda), ou passam a viajar no
   payload (e §5.3 muda)? (DR-11)
6. Como a projeção sabe qual `role.create` é o Fundador e qual é o cargo base? (DR-12)
7. Qual é o tipo de `state` do `validator`, quem o monta, e qual módulo tem o direito de
   escrever SQL de leitura de domínio? (DR-14, DR-28)
8. Quais dos 12 estágios rodam no cliente antes de enfileirar? (DR-15)
9. Onde fica registrada, fora da projeção, a lista de comunidades participadas e suas chaves
   de core e de blobs? (DR-21)
10. O reducer recebe `seq`, `hostTs` e `flags`? Em que forma? (DR-13)
11. Qual a estrutura do delta agregado que o projetor devolve? (DR-27)
12. No tombstone, a coluna `content` é esvaziada ou preservada — e em que ordem em relação à
    remoção do FTS? (DR-16, DR-17)

**Fila e rede**
13. Além de `message.send`, quais `kind`s podem entrar na outbox? (DR-23)
14. Um item `sending` no momento de um crash volta para `queued` no boot seguinte? (DR-22)
15. Por qual caminho o host escreve as próprias ops, e o que `message.send` devolve nesse
    caso? (DR-18)
16. Qual o estado de `hostStatus` entre o boot e a primeira conexão, e qual a regra que
    promove *ausência de peer* a *offline*? (DR-29, DR-33)
17. Entre `message.accepted` e `messages.appended`, quem é a fonte da mensagem para a UI?
    (DR-19)
18. Todo nó aplica o firewall de bans, ou a replicação por membros para o banido é uma
    limitação aceita e declarada? (DR-30)

**Permissões e leitura**
19. `manage_community` sozinha cria e revoga convite? (DR-26)
20. As queries de leitura verificam permissão? `view_audit_log` é confidencialidade real ou
    cosmético em P2P — e isso vai para §18.1? (DR-25)
21. Publicar o schema de resposta das 17 queries de §10.4, casado com os tipos que o frontend
    já usa. (DR-46, DR-47, DR-48)

**Mídia e anexos**
22. Como o núcleo verifica que o caminho de `blob.stage` veio de um diálogo do SO? (DR-37)
23. Quem produz o sinal de "fala ativa" e por qual caminho ele chega ao renderer? (DR-42)
24. Quem inicia a conexão de uma aresta da árvore, e o que acontece se o filho chegar antes
    da atribuição do pai? (DR-43)
25. `uplinkKbps` é medido pelo host ou declarado pelo cliente, e qual o valor de quem nunca
    repassou? (DR-44)

**Operação**
26. Como tabelas `local_*` são migradas, já que não podem ser reconstruídas do log? (DR-20)
27. O que o núcleo faz com um valor de configuração fora da faixa declarada? (DR-51)

---

# Avaliação

## **NOT READY TO IMPLEMENT**

O dry run não conseguiu chegar ao fim da **fase 1** sem inventar decisão, e parou
definitivamente no primeiro módulo da **fase 2** (`opCodec`), que é dependência de todos os
outros da mesma fase.

O detalhe que importa é *onde* ele parou. Não parou por falta de visão de produto, de modelo
de domínio ou de regra de negócio — essas três coisas estão entre as mais bem escritas que se
vê num documento desse porte: 26 seções, 34 ambiguidades fechadas por nome, 20 ADRs com
alternativa descartada, uma seção inteira de deltas obrigatórios contra a spec irmã, e
rastreabilidade linha a linha com o frontend já implementado. Parou por falta de **contrato
executável**: os tipos concretos que um compilador exige e que a prosa não substitui —
layout de bytes, tipo de argumento, enum fechado, schema de resposta, ordem de duas
mensagens concorrentes.

Isso é uma distinção prática, não uma amenidade. Significa que o caminho até READY é
**escrever tabelas, não redesenhar arquitetura**. Das 51 lacunas, nenhuma exige jogar fora
ADR-01 (host autoritativo), ADR-02 (Hypercore cru + view SQLite), ADR-10 (tombstone) ou
ADR-12 (idempotência por hash de envelope) — as quatro que sustentam o resto. Sete são
paradas totais, e todas as sete são texto: um registry de encoding, uma regra de derivação de
id, dois flags derivados, um tipo de argumento, um lugar para guardar duas chaves, um
contrato de canal e um critério de aceite.

Somando com a auditoria adversarial, o quadro para começar hoje é:

- **13 paradas totais** (6 CRITICAL da auditoria + 7 BLOCKERs deste dry run), todas
  concentradas nas fases 0, 2, 4 e 5.
- **30 pontos de retrabalho provável** (16 HIGH da auditoria + 14 HIGH daqui), com destaque
  para o contrato de leitura (DR-46), que é o único capaz de invalidar trabalho de **duas**
  equipes ao mesmo tempo.
- **Fases 1 e 3 são as mais próximas de executáveis** — e mesmo elas dependem de DR-03,
  DR-05, DR-06 e DR-07, que são quatro decisões de protocolo, não de arquitetura.

**Recomendação de sequência para virar READY:**

1. Fechar os 7 BLOCKERs deste documento e os 6 CRITICAL da auditoria — são 13 decisões, todas
   de texto, nenhuma exigindo experimento (com a exceção parcial de DR-01, que *define* o
   experimento).
2. Publicar dois anexos novos, que hoje não existem em nenhum dos documentos e que sozinhos
   fecham 14 GAPs: **(A) registry de encoding por `kind`** e **(B) schema de resposta das
   queries e payload dos eventos**, este último casado com `frontend/src/domain/types.ts`.
3. Reexecutar este dry run contra a versão corrigida. O critério de READY é simples e
   verificável: **percorrer as fases 0 a 3 sem que nenhum módulo fique sem assinatura de
   entrada e de saída.**

Até lá, começar a codar a fase 2 significa que o primeiro implementador vai congelar, por
conta própria e dentro de um log append-only, decisões que não são dele: o formato dos bytes
de toda op e a identidade de toda entidade da comunidade. Essas duas, uma vez em produção,
não têm migração barata — o log é permanente por construção (ADR-10) e a reprojeção
determinística (§21.4) transforma qualquer escolha em contrato vitalício.

*Fim do dry run. 51 GAPs: 7 BLOCKER · 14 HIGH · 22 MEDIUM · 8 LOW. 27 perguntas para o
arquiteto. 19 decisões a congelar.*
