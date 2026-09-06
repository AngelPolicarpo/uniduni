# Sequenciamento pós-fase 0 — qual fase começa agora

**Este documento não é normativo** e não entra na lista de precedência de `backend-v2.md`
§0.2 nem do `CLAUDE.md`.

> **Este é o histórico, não o backlog.** As seções são cronológicas e append-only: cada uma
> registra o que aquela fatia entregou, e nada é apagado — item fechado é riscado no lugar,
> com ponteiro para onde fechou. **O que está aberto hoje mora em `docs/backlog.md`.** As
> tabelas "Pendências" até §69 ficam como estavam; elas valem pela data em que foram
> escritas, não como estado atual. Ele registra a leitura dos artefatos de gate feita em 2026-08-16,
a sequência escolhida e as decisões que ainda dependem de aprovação. Se divergir de
`backend-v2.md`, `adr-v2.md` ou `plano-de-validacao-experimental-v2.md`, o normativo vence.

---

## 1. O que os artefatos declaram, campo por campo

Não o que o `REPORT.md` resume nem o que o `CLAUDE.md` registra: o conteúdo do JSON.

| Gate | `veredito` | `alvo` no artefato | Evidência no segundo alvo | Arquivo |
|---|---|---|---|---|
| G0 | `APROVADO` (11/11) | `linux-x64` | **sim** — `out/gate-G0/windows/*.json`, 4 cenários, `platform: win32`, `arch: x64` | `poc/poc-03-runtime/out/gate-G0/gate-G0.json` |
| G10 | `APROVADO` (10/10) | `linux-x64` | **nenhuma** na leitura original — resolvido depois, ver §15 | `poc/poc-10-identity/out/gate-G10/gate-G10.json` |
| G1 | `confirmado` | Node 22 puro, `linux-x64` | não se aplica (o `fold` é puro, §4) | `poc/poc-01-fold/out/gate-G1/gate-G1.json` |

O que os quatro cenários de Windows de G0 cobrem, lido dos `steps`: `core.ready`,
`addonReport`, `openDbs`, `openCore`, `flushProbe`, `append.1000x256B`, `tx.256`, `tx.2048`,
`fts.index`, `ed25519.1000`, `ipc-r.roundtrip`, `crashHard` e a releitura do dado após
`SIGKILL`. É o caminho funcional inteiro mais as duas fronteiras de IPC. Ficaram só no
Linux: os 100 cold starts de `C2`, a disputa de diretório de `C7`, o addon dentro do `asar`
de `C8` e os três reinícios de `C6`.

## 2. O achado que muda a recomendação anterior

> **Estado em 2026-08-16, depois desta leitura:** o achado abaixo foi **resolvido** — G10
> passou a ter `win32-x64` APROVADO 10/10 e `matriz.json` com `completo: true` (§15). A
> seção fica como está porque é o que fundamentou a escolha de sequência de §3, e porque a
> corrida do Windows confirmou o risco que ela previa: 9 de 10 critérios reprovaram na
> primeira tentativa, por uma divergência de semântica de SO no lock de §10.8.

**G10 não tinha alvo Windows, e o próprio POC dizia isso.**

- `plano-de-validacao-experimental-v2.md:255` — Ambiente de POC-10: *"Windows e Linux — este
  último **com e sem** serviço de secret disponível."*
- `plano-de-validacao-experimental-v2.md:259` — Aprovação: *"100 % de recuperação nos
  **alvos** com secret store"*, no plural.
- `plano-de-validacao-experimental-v2.md:385` — regra composta: *"Um gate só passa quando
  **todos** os seus subcritérios (…) forem aprovados."*
- `poc/poc-10-identity/REPORT.md:103` — *"**O alvo Windows.** Este relatório cobre
  `linux-x64`. G10 exige Windows também."*

Some disso um segundo defeito, menor mas próprio de registro: o campo
`limitacaoDeEvidencia` do artefato de G10 traz apenas `G0-E1` (WSL2). A ausência do alvo
Windows **não está declarada no artefato**, só no `REPORT.md`. O artefato subdeclara a
própria limitação, e é o artefato que sustenta o veredito.

### Por que isso não é formalismo

O que G10 prova e G0 não prova é justamente a parte sensível a semântica de sistema
operacional: `D4`/`D5`/`D6` (lock composto de §10.8, lock órfão) e `D7` (`wipe` retomável de
§18.6). O achado 3.2 do próprio `poc-10-identity/REPORT.md` nasceu de uma colisão de handle
do RocksDB no Linux. No Windows, apagar diretório com handle aberto **falha** onde no Linux
sucede — o estágio `key-wiped` de §18.6 é exatamente esse padrão. É a classe de defeito com
maior chance de existir e menor chance de aparecer sem rodar.

Os quatro cenários de Windows de G0 não cobrem nada disso: `poc-03-runtime` não tem
identidade, `safeStorage`, `wipe`, `export`/`import` nem deep link. As duas POCs são
aplicações separadas, sem sobreposição nessa superfície.

## 3. Decisão de sequência: a fase 2 vem antes da fase 1

`backend-v2.md:4084-4088` e o diagrama de `plano-de-validacao-experimental-v2.md:370-379`:

```
G0 ─┬─ G10 ──▶ fase 1     (fundação de fronteira: IPC-R, IPC-M, identidade, deep link)
    └──▶ G1  ──▶ fase 2     (fold e log)
```

Os dois ramos estão formalmente abertos. Não são, porém, igualmente sustentados:

| | Fase 1 | Fase 2 |
|---|---|---|
| Gate de entrada | G0 **e** G10 | G1 |
| Cobertura do gate na matriz fechada | G0 nos dois alvos; **G10 em um só** | não se aplica — o `fold` é puro (§4) |
| Dependências de runtime | `safeStorage`, lock composto, `wipe`, deep link | `better-sqlite3`, `hypercore` — **provados nos dois alvos** por G0 |
| Buracos de spec abertos dentro do escopo | 1 (`--password-store`, §5.2 abaixo) | 0 |
| Sensibilidade ao layout ainda indefinido | alta: define main/renderer/núcleo, build e empacotamento | baixa: L1 não importa de ninguém (§4) |

A recomendação anterior — começar pela fase 1 porque ela estabelece a fundação de processo —
não está errada como princípio, e continua verdadeira sobre a arquitetura. Ela é derrotada
pelo estado da **evidência**: a fundação que a fase 1 escreveria é precisamente a metade que
G10 não exercitou no segundo alvo da matriz. Escrever lock composto e `wipe` agora é
escrevê-los contra evidência de um sistema operacional só, com a chance de reescrever quando
a evidência do outro chegar. `decision_criteria` #5 (menor retrabalho) e #4 (preservar o que
os POCs validaram) apontam na mesma direção.

A fase 2, em contrapartida, consome direto o desenho que G1 confirmou (`poc-01-fold`,
ADRs A01, A02, A04, A05, A07, A10, A11), roda **na ordem** de §6 pela primeira vez — G1
correu fora dela — e não toca nenhuma das quatro questões abertas.

## 4. Bloqueios reais da fase 1

Nenhum deles bloqueia a fase 2.

| # | Bloqueio | Fundamento | Quem resolve |
|---|---|---|---|
| ~~B1~~ | ~~G10 sem alvo Windows~~ — **resolvido**, ver §15 | `plano…v2.md:255,259,385`; `adr-v2.md:460` (*"G0 precisa passar em todos os alvos da matriz — hoje, os dois"*) | — |
| ~~B2~~ | ~~`--password-store` não está na spec~~ — **resolvido**: A13(5)+(6) e §3.2 emendados, ver §16(b) | `poc-10-identity/REPORT.md` §3.1.1 | — |
| B3 | Layout de repositório indefinido | §4 exige *"regra de lint com fronteira por diretório"* que *"quebra o build"*; nenhum normativo nomeia o diretório-raiz do núcleo | decisão do usuário |

**B3 vale para as duas fases**, mas com pesos diferentes: a fase 2 entrega `fold`, `opCodec`,
`permissions`, `idgen` e `errors`, que por §4 não importam de nenhuma camada acima. Movê-los
depois é `git mv`. A fase 1 entrega L3 e o esqueleto do processo, onde o layout é o próprio
trabalho.

### 4.1 Armadilha operacional ao fechar B1

`poc/poc-10-identity/scripts/run-all.ts:212,220` monta `alvo` a partir de `process.platform`
e grava sempre em `out/gate-G10/gate-G10.json`. Uma corrida `full` no Windows
**sobrescreveria o artefato de `linux-x64`** que hoje sustenta o veredito. `poc-03-runtime`
resolveu isso pondo o resultado de Windows em `out/gate-G0/windows/`; `poc-10-identity` não
tem esse desvio. Ele precisa existir antes da corrida, não depois.

## 5. Pendências que **não** bloqueiam nada agora

| # | Pendência | Por que não bloqueia |
|---|---|---|
| ~~P1~~ | ~~Barreira de durabilidade de §11: `core.flush` não existe em `hypercore@11.35.1` e `core.state.flush()` estoura por dentro~~ — **resolvido em 2026-08-17**: era pergunta de spec, e §10.7.1 a responde (o `append` **é** a barreira; `core.state.flush()` estoura porque o `append` já a chamou). Ver §19.2 | era entrada de **G4 / fase 3**, por `poc-03-runtime/REPORT.md:117-119`. O que sobra em G4 é medição, não indefinição |
| P2 | Patch de A16 sobre os addons de Windows | precisão documental; ver §6.2. Não impede código |
| P3 | 69 `.node` de plataformas fora da matriz no artefato | ajuste de `files` antes do release (`poc-03-runtime/REPORT.md:101-106`) |
| P4 | `communityId` é ou não a chave do core (OBS-01) | é decisão **da** fase 2, não anterior a ela (`poc-03-runtime/REPORT.md:121-124`) |
| P5 | `G0-E1` — alvo Linux validado em WSL2 | já registrada em A16 (`adr-v2.md:471-479`) e no artefato |
| P6 | Justificativa de `asarUnpack` não é funcional, é de integridade de código | motivo real medido, ainda não registrado na spec (`poc-03-runtime/REPORT.md:82-91`) |

## 6. Decisões que dependem de aprovação

### 6.1 Layout do primeiro código de produto (B3)

Nenhum documento normativo nomeia o diretório. `CLAUDE.md` diz apenas *"não presuma que o
núcleo vai morar em `backend/`"*. O que o contrato exige é só que a fronteira entre as
quatro camadas de §4 seja **verificável por diretório** e quebre o build quando violada.

### 6.2 Patch normativo de A16 — addons de Windows

`poc-03-runtime/REPORT.md:131-135` mede que os `.node` de `win32-x64` do artefato de G0 são
os prebuilds publicados no npm, não compilados por nós, por falta de toolchain MSVC. A16
diz *"rebuild por versão de Electron e por alvo é parte do contrato de build"*
(`adr-v2.md:446-447`). Essa parte do contrato **não tem evidência no alvo Windows**.

É a mesma classe de `G0-E1`, que já está escrita em A16 — e está escrita justamente porque
uma limitação de evidência não declarada vira, com o tempo, uma garantia falsa. O texto
proposto está em §7. **Não foi aplicado**: `adr-v2.md` é normativo.

## 7. Texto proposto para A16 (não aplicado)

Inserir como novo item da lista de decisão de `adr-v2.md` §A16, imediatamente após o item
`LIMITAÇÃO DE EVIDÊNCIA (G0-E1)`:

> - **LIMITAÇÃO DE EVIDÊNCIA (`G0-E2`) — os addons do alvo Windows não são compilados por
>   nós.** Medido em G0, 2026-08-16: o artefato `win32-x64` carrega os prebuilds
>   `better-sqlite3`, `sodium-native` e `udx-native` publicados no npm, porque não há
>   toolchain MSVC disponível. Eles são N-API e carregam — provado em quatro cenários no
>   Windows x64 nativo —, mas a cláusula "rebuild por versão de Electron e por alvo" acima
>   **não tem evidência neste alvo**. O que isso não prova: que um upgrade de versão de
>   Electron seja absorvido por rebuild próprio no Windows, e que a cadeia de build do
>   produto seja reprodutível nos dois alvos. Diferente do piso de glibc no Linux, aqui não
>   há piso a violar — o risco é de ABI no upgrade, não de compatibilidade de distribuição.

---

## 8. Sequência resultante

1. **Agora, sem depender de aprovação normativa:** decidir o layout (§6.1) e abrir a fase 2
   pelos módulos puros de L1 — `errors`, `idgen`, `opCodec`, `permissions`, `fold` —, na
   ordem de dependência de §4, com os testes de §28.1 e §28.4 desde o primeiro arquivo.
2. **Em paralelo, sem bloquear o item 1:** rodar o harness de `poc-10-identity` no Windows
   x64, depois do desvio de artefato de §4.1, e fechar B1.
3. **Quando B1 fechar:** decidir B2 (`--password-store`) e abrir a fase 1.
4. ~~**Antes da fase 3:** resolver P1, a barreira de durabilidade de §11.~~ **Resolvido em
   2026-08-17** por §10.7.1; a entrada atual da fase 3 é o contrato emendado de §20.5.

---

## 9. Contradição encontrada em §4, ao implementar a barreira de camadas

`backend-v2.md` §4 abre com a regra: *"Quatro camadas. Uma camada só importa das camadas
abaixo. Importação lateral só onde a tabela declarar. Violação **quebra o build** (regra de
lint com fronteira por diretório)."*

Duas linhas da própria tabela violam essa regra:

| Módulo | Camada | Coluna "Depende de" | Problema |
|---|---|---|---|
| `communityHost` | L2 | `fold`, `corestore`, **`rpcServer`** | `rpcServer` é **L3** |
| `outbox` | L2 | `manifest`, **`rpcClient`** | `rpcClient` é **L3** |

As duas arestas **sobem** de camada. Ou a regra de precedência admite exceção que a §4 não
escreve, ou as duas linhas querem dizer outra coisa — injeção da porta de transporte por
quem monta o grafo, o mais provável, já que §4 também diz que `rpcServer`/`rpcClient` *"não
podem conter regra de negócio"* e dependem de `L2`, o que fecharia um ciclo L2↔L3.

**Não foi resolvido por conta própria.** `core/scripts/check-layers.ts` registra as duas
arestas como contraditórias e recusa a importação com a contradição nomeada, em vez de
escolher uma leitura. Nenhuma linha de L2 existe ainda, então isso não bloqueia nada hoje;
vence quando a fase 3 abrir a `outbox`.

---

## 10. O que já foi executado

- `adr-v2.md` §A16 recebeu a limitação de evidência **`G0-E2`** (§7 acima), aprovada em
  2026-08-16.
- `core/` aberto como pacote do núcleo, Node puro, sem Electron — a decisão de §6.1. A
  fase 1 decide onde mora o shell; L1 não importa de ninguém acima, então mover depois é
  `git mv`.
- `core/scripts/check-layers.ts` implementa a fronteira por diretório que §4 exige. Verificado
  nos dois sentidos: `L0 → L1` é recusado, e a aresta contraditória de §9 também.
- `core/src/l1/errors/` — os 86 códigos de §20.2, gerados do normativo, com teste de
  paridade que relê a tabela a cada corrida. É o único módulo de L1 sem dependências (§4),
  e por isso o primeiro.

---

## 11. B2 — `--password-store`: o que foi medido e o patch recomendado

Nove configurações no artefato empacotado de POC-10, mesma máquina e mesmo `gnome-keyring`.
A tabela completa está em `poc/poc-10-identity/REPORT.md` §3.1.1. O que ela decide:

1. **`getSelectedStorageBackend()` reporta intenção, não capacidade.** Com
   `--password-store=kwallet5` numa máquina sem kwallet, ele devolve `kwallet5` e
   `isEncryptionAvailable()` devolve `false`. O nome do backend não é sinal de segurança.
2. **A autodetecção do Linux tem falso negativo.** Sem `XDG_CURRENT_DESKTOP` reconhecido —
   WSL2, headless, SSH, contêiner —, ela devolve `basic_text` numa máquina cujo chaveiro
   funciona. Só a flag muda, e `isEncryptionAvailable()` vai de `false` a `true`.
3. **Forçar não fabrica segurança.** Sem barramento de sessão, ou com o backend ausente,
   `isEncryptionAvailable()` continua `false`. É a assimetria que torna o probe seguro: ele
   só recupera store que existe.
4. **`appendSwitch('password-store', …)` só tem efeito antes de `app.whenReady()`.** Como
   `isEncryptionAvailable()` só responde depois do ready, tentar outro backend é
   **relançar o processo**, não reconfigurar em voo.

### Por que isso exige emenda, e não é só implementação

A13(5) identifica degradado por `basic_text`. O caso A da medição é uma máquina com chaveiro
funcionando que a spec, como escrita, classificaria como degradada — recusando o boot e
empurrando o usuário para a tela de aceite de modo inseguro **sem necessidade**. A regra
atual não é conservadora: ela produz o resultado errado, e o resultado errado é o que
normaliza aceitar modo inseguro. É defeito de segurança por redação, e por isso vai a patch
em vez de virar decisão de implementação.

### Patch proposto — `adr-v2.md` A13, item 5 (**não aplicado**)

> 5. **Degradado é `safeStorage.isEncryptionAvailable() === false` depois do probe de
>    backend — nunca o nome do backend.** Medido em G10 (2026-08-16):
>    `getSelectedStorageBackend()` devolve o backend **pedido**, não o obtido, e a
>    autodetecção do Linux devolve `basic_text` em máquina com chaveiro funcionando sempre
>    que não há ambiente de desktop reconhecível. Antes de concluir degradado, o app tenta
>    os candidatos explicitamente, na ordem `gnome-libsecret`, `kwallet6`, `kwallet5`, com
>    `app.commandLine.appendSwitch('password-store', …)`. Forçar **não** fabrica segurança:
>    com o serviço ausente, `isEncryptionAvailable()` permanece `false`. Esgotados os
>    candidatos, é degradado de verdade: o núcleo recusa abrir (`E_KEYSTORE_INSECURE`) até
>    um aceite dedicado, e a UI exibe indicador permanente.
> 6. **O probe é um relaunch, e tem ordem obrigatória.** O switch só vale antes de
>    `app.whenReady()`, então cada candidato custa um `app.relaunch()`. O probe roda **antes**
>    do lock composto de §10.8 — senão o processo relançado encontra o próprio lock e morre
>    com `E_CORE_ALREADY_RUNNING` — e **preserva `argv`**, senão o deep link de §3.5(4) se
>    perde no relaunch. O backend aprovado é persistido e reusado no boot seguinte, sem
>    repetir o probe; o custo medido é de ~350 ms por candidato ausente, uma única vez.

Emenda de acompanhamento em `backend-v2.md` §3.2, na LIMITAÇÃO DECLARADA (L-2), trocando
*"No Linux sem serviço de secret, o Electron cai para `basic_text`"* por *"No Linux, o
Electron cai para `basic_text` tanto sem serviço de secret quanto quando não reconhece o
ambiente de desktop; só o probe de A13(5) distingue os dois casos"*.

**Consequência de não aplicar:** a fase 1 implementa o boot de identidade contra uma regra
que recusa máquinas sãs, e o indicador permanente de modo inseguro aparece onde não deveria.

---

## 12. Pendências registradas por fase

| Fase | Pendência | Origem |
|---|---|---|
| ~~1~~ | ~~**B1** — G10 sem alvo Windows~~ — **RESOLVIDO em 2026-08-16**: `win32-x64` APROVADO 10/10, `matriz.json` com `completo: true`. Ver §15 | §4, §2 |
| ~~1~~ | ~~**B2** — patch de A13(5)/§3.2~~ — **APLICADO**, ver §16(b) | §11 |
| ~~3~~ | ~~**Contradição de §4**~~ — **RESOLVIDA** por inversão de dependência, ver §16(c). Não é mais pendência da fase 3 | §9 |
| ~~3~~ | ~~**P1** — barreira de durabilidade de §11 (`core.state.flush()`)~~ — **RESOLVIDO em 2026-08-17** como pergunta de spec: §10.7.1 nomeia a primitiva e mede o alcance dela. O que sobra é medição de G4, não indefinição. Ver §19.2 | §5 |
| pré-release | 69 `.node` fora da matriz no artefato; justificativa real de `asarUnpack` | §5 |
| ~~2~~ | ~~**`RANK_TOP`, `RANK_BOTTOM` e `RANK_GENESIS` sem valor declarado**~~ — **RESOLVIDO**: §27.1 e §6.4.1 emendados, ver §16(a) | §13 |
| ~~2~~ | ~~**H-21 a H-26** — os seis buracos do `projector`~~ — **RESOLVIDOS em 2026-08-17**: §8.0, §8.2, §8.4, §8.5, §10.3, §10.3.1 e §4 emendados, ver §19.1 | §18 |
| ~~2~~ | ~~**H-19, H-20, A-03 a A-06, O-07** — os sete buracos do `fold`~~ — **RESOLVIDOS em 2026-08-17**: §8.1, §8.4, §5.2, §6.4.1, §19.9, §4 e §27.1 emendados, ver §19.4. `A-03` era invariante violada, não ambiguidade | §17 |

Não sobra pendência de **spec** ativa: as duas de fase (`P1` e os seis buracos de §18) viraram
emenda em 2026-08-17. Sobram os dois ajustes de pré-release, e a medição de G4 — que é
trabalho de gate, não indefinição normativa.

---

## 13. Buraco encontrado na fase 2: três constantes de rank sem valor

R-27 (§8.3) prescreve comportamento com três constantes que **nenhuma seção define**:

| Constante | Onde aparece | O que a spec diz | O que falta |
|---|---|---|---|
| `RANK_GENESIS` | R-27(a), §19.1 | "sentinela estritamente maior que qualquer `rank` atribuível a um cargo"; nunca gravado | um valor, ou a regra de comparação |
| `RANK_TOP` | R-27(b) | o `rank` que o cargo Fundador recebe no `seq` 1 | o valor |
| `RANK_BOTTOM` | R-27(b) | o `rank` que o cargo base recebe no `seq` 2 | o valor |

§27.1 declara `RANK_MAX_LEN` (64) e nada mais sobre rank; §6.4.1 define o **tipo** (base62,
lexicográfico, nunca terminando em `0`) mas nenhum valor inicial.

Isso importa porque os três entram em **material assinado ou em decisão determinística do
`fold`**: duas réplicas que escolhessem valores diferentes para `RANK_TOP` produziriam
`DecisionState` divergente já no `seq` 1, e a comunidade se bifurcaria na gênese.

**O que foi feito e o que não foi.** `RANK_GENESIS` não precisa de valor para ser
implementado corretamente: `core/src/l1/permissions/` o representa **fora** do espaço de
strings base62, o que satisfaz "estritamente maior que qualquer rank atribuível" sem
escolher um literal — e como R-27 diz que ele nunca é gravado, nada o observa no fio.
`RANK_TOP` e `RANK_BOTTOM` **não têm essa saída**: são gravados como `rank` de cargo e
viajam. Eles bloqueiam a gênese dentro do `fold`, e não foram inventados.

### 13.1 Determinação: **não são deriváveis** do normativo existente

Quatro fundamentos independentes, cada um suficiente:

**(a) As restrições declaradas são de satisfatibilidade, não de unicidade.** Tudo que o
corpus exige é `RANK_BOTTOM < RANK_TOP`, ambos válidos por §7.2.1 (base62, 1–64 caracteres,
nunca terminando em `0`), com espaço para `midpoint` entre os dois. Os pares `('1','zz')`,
`('1','z')` e `('2','y')` satisfazem §6.4.1, §9.3, §19.9, R-4 e R-27(b) igualmente bem.
Nada no normativo escolhe um. Derivar aqui seria escolher.

**(b) §27.1 diz, por critério próprio, que eles deveriam estar lá — e não estão.** A regra
da seção é explícita: *"se um número decide se uma op tem efeito, ele está aqui"*.
`RANK_TOP` e `RANK_BOTTOM` decidem o `DecisionState` a partir do `seq` 1. A lista traz
`RANK_MAX_LEN` e mais 30 constantes; os dois não aparecem. É omissão pelo próprio critério
do documento, não silêncio proposital.

**(c) `midpoint` também não tem algoritmo, e esse buraco é maior.** §6.4.1 o nomeia e
enuncia propriedades — estritamente entre, determinístico, cresce em comprimento, ~383
inserções consecutivas no fundo estouram `RANK_MAX_LEN` — mas **não define a função**;
§19.9 a usa sem defini-la. Ela governa `role.create`, `role.move`, `channel.create` e
`category.create` por R-20, não só a gênese. Reconstruir o algoritmo a partir do número
"383" seria engenharia reversa de uma medição, não leitura de contrato.

**(d) Os valores são replicados e observáveis.** `rank` entra no `DecisionState` e em
`view.db`, e §6.4.1 manda `role.move` devolver `{rank}`. Duas réplicas com constantes ou
`midpoint` diferentes divergem no `seq` 1 e a comunidade bifurca na gênese. Não é detalhe
de implementação: é contrato de fio.

---

## 14. Proposta de resolução normativa — rank (aguardando aprovação)

### 14.1 O que a definição precisa satisfazer

| # | Requisito | Origem |
|---|---|---|
| N-1 | `RANK_BOTTOM < RANK_TOP` na ordem lexicográfica | §9.3, R-27(b) — o cargo base fica abaixo do Fundador |
| N-2 | Ambos válidos como `rank`: base62 `0-9A-Za-z`, 1–64 caracteres, não terminam em `0` | §7.2.1 |
| N-3 | Cabem **estritamente entre** os dois pelo menos `MAX_ROLES − 2` = 98 ranks distintos | §27.1 + R-4 + §6.4.1 (o Fundador é sempre o topo; todo cargo criado depois entra abaixo dele e acima do base) |
| N-4 | `RANK_GENESIS` é estritamente maior que **todo** rank atribuível e **nunca** é ele próprio atribuível | R-27(a) |
| N-5 | `midpoint(a,b)` é **total** — nunca lança, nem para entrada incoerente (`a ≥ b`, zero à direita) | §8.5 |
| N-6 | `midpoint` é função pura e idêntica em toda réplica, e a renormalização de §6.4.1 produz saída estritamente entre `RANK_BOTTOM` e `RANK_TOP` preservando a ordem, para até `MAX_CHANNELS` (500) itens | §6.4.1, §8.4 |

### 14.2 Recomendação: adotar o que G1 mediu

`poc/poc-01-fold/src/fold/rank.ts` já implementa exatamente isto, e o `CONFIRMADO` de G1
foi obtido **sobre essa álgebra de rank**, em 10⁷ entradas hostis. O próprio POC registrou
o buraco como `HOLE-14` e a escolha como `ASSUMPTION-14` — ou seja, a evidência de G1 é
**condicional a estes valores**:

| Constante | Valor | Por que satisfaz |
|---|---|---|
| `RANK_TOP` | `'zz'` | N-1, N-2; deixa `'2'`…`'zy'` livres entre o base e o topo, muito acima dos 98 de N-3 |
| `RANK_BOTTOM` | `'1'` | N-1, N-2; não é `'0'`, que violaria "nunca termina em `0`" |
| `RANK_GENESIS` | `'z'` × 65 | N-4 com elegância: 65 > `RANK_MAX_LEN` (64), então é lexicograficamente maior que qualquer rank válido **e** nunca pode ser um rank válido — não há como gravá-lo em cargo por acidente |

Mais o `midpoint` de base62 sobre a parte fracionária e a renormalização de dois dígitos
(`'11'`, `'21'`, …), ambos já escritos e exercitados naquele arquivo.

**Por que esta recomendação e não outra:** é a única escolha que **não custa uma nova
corrida de G1**. Qualquer outro par de valores, ou qualquer outro `midpoint`, deixa a
evidência de G1 sem valer para os caminhos de rank — e G1 é o gate que libera a fase 2.

### 14.3 Onde entra

- **§27.1** (constantes de protocolo): acrescentar `RANK_TOP` `'zz'` · `RANK_BOTTOM` `'1'` ·
  `RANK_GENESIS` `'z'×65` à lista, ao lado de `RANK_MAX_LEN`.
- **§6.4.1**: acrescentar a definição de `midpoint` — leitura das chaves como fração em
  base 62, prefixo comum preservado, dígito médio quando há folga, descida quando não há —
  e a forma da renormalização.

### 14.4 Impacto

| Sobre | Impacto de resolver | Impacto de **não** resolver |
|---|---|---|
| **Gênese** | R-27(b) fica implementável: `seq` 1 e 2 recebem os dois valores | **Bloqueio duro** — sem `RANK_TOP`/`RANK_BOTTOM` o `fold` não produz o `DecisionState` do `seq` 1, e **nenhuma comunidade pode ser criada** |
| **`fold`** | R-20 e a renormalização de §6.4.1 ficam implementáveis | `role.create`, `role.move`, `channel.create` e `category.create` ficam sem regra de `rank` — quatro `kind`s sem como decidir |
| **G1** | Adotando 14.2, a evidência transfere sem nova corrida | Escolher outros valores obriga a **reexecutar G1** nos caminhos de rank |
| **Fase 2** | Desbloqueia o miolo | O registry de §7.4 e os `kind`s que não tocam `rank` seguem; a gênese e a ordenação param |

---

## 15. B1 fechado — G10 aprovado nos dois alvos (2026-08-16)

`out/gate-G10/matriz.json` passou a `completo: true`:

| Alvo | Veredito | Artefato | Limitação declarada |
|---|---|---|---|
| `linux-x64` | APROVADO 10/10 | `gate-G10.json` | `G0-E1` — validado em WSL2 (A16) |
| `win32-x64` | APROVADO 10/10 | `windows/gate-G10.json` | `G0-E2` — addons são prebuilds do npm (A16) |

**O que a corrida do Windows achou, e vale para a fase 1.** A primeira tentativa reprovou 9
de 10 critérios com `EPERM: ftruncate` no boot — a etapa 2 do lock composto de §10.8 abria o
arquivo com `'a+'` e truncava em seguida, e **no Windows um descritor em modo append recusa
`ftruncate`**. É a classe de defeito que só aparece no segundo alvo: passa inteiro no Linux,
falha inteiro no Windows. `'w+'` não resolve — truncaria antes do `tryLock`, apagando o PID
do dono exatamente quando §10.8 precisa lê-lo para decidir se o lock é órfão. A forma
portátil é `O_RDWR|O_CREAT`. Detalhe em `poc-10-identity/REPORT.md` §3.1.2.

**Proveniência.** O artefato de `win32-x64` saiu do código já corrigido; o de `linux-x64` é
anterior ao fix. A equivalência das duas variantes no Linux foi **medida** fora do Electron —
arquivo novo, sobrescrita de conteúdo anterior, disputa de lock e legibilidade do dono com
lock ativo, todas idênticas byte a byte — em vez de assumida. Não houve nova corrida do alvo
Linux porque o `login.keyring` da máquina está trancado e o caminho **com** secret store
bloqueia num diálogo de senha; a medição do delta cobre o que a nova corrida provaria.

---

## 16. As três decisões aprovadas foram aplicadas (2026-08-16)

**(a) R-27 — rank.** `backend-v2.md` §27.1 passou a declarar `RANK_TOP` `'zz'`,
`RANK_BOTTOM` `'1'` e `RANK_GENESIS` `'z'`×65, e §6.4.1 ganhou a definição normativa de
`midpoint` e da renormalização. Os valores e o algoritmo são os de `poc-01-fold`, que é o
que torna a evidência de G1 transferível sem nova corrida. §13 e §14 ficam como registro do
porquê.

Verificado no código: `core/test/rank.test.ts` reproduz os vetores de G1, confirma que
`RANK_GENESIS` **não** é um `rank` válido (`isValidRank` o recusa por comprimento) e que o
crescimento no fundo estoura `RANK_MAX_LEN` em ~383 inserções — o número que §6.4.1 cita
como medido.

**(b) B2 — `--password-store`.** `adr-v2.md` A13 teve o item 5 reescrito e ganhou um item 6
(ordem do probe, relaunch, `argv`, persistência do backend). `backend-v2.md` §3.2 teve a
L-2 corrigida: `basic_text` no Linux é ambíguo entre "não há secret store" e "não reconheci
o desktop", e quem decide é `isEncryptionAvailable()`, não o nome do backend. §11 fica como
registro da medição que fundamentou a emenda.

**(c) §4 — a contradição L2 → L3.** Resolvida por **inversão de dependência**, e não por
remoção da relação: §4 ganhou a regra *"quando L2 precisa falar rede"* — o módulo de L2
declara a porta, L3 a implementa, a implementação é injetada no boot, e a direção é sempre
L3 → L2. As linhas de `communityHost` e `outbox` passaram a dizer "**porta** …, implementada
por `rpcServer`/`rpcClient`", com o import explicitamente proibido na coluna "Não pode".

Era a única leitura compatível com o resto de §4, que já faz `rpcServer`/`rpcClient`
dependerem de `L2` e proíbe regra de negócio neles — a aresta original fecharia um ciclo
L2↔L3. `core/scripts/check-layers.ts` deixou de tratar as duas arestas como contradição e
passou a recusá-las com a mensagem correta, porque o erro provável agora é confundir "usa o
transporte" com "importa o transporte". **Sai da lista de pendências da fase 3.**

---

## 17. Buracos de spec levantados ao implementar o `fold` (2026-08-16)

> **Estado: os sete viraram emenda em 2026-08-17.** As tabelas abaixo ficam como registro do
> que o código encontrou e de por que cada leitura foi a escolhida; a resolução normativa de
> cada uma está em §19.4. A de `A-03` mudou de natureza no caminho — não era ambiguidade de
> redação, era uma invariante de §6.4.1 que não valia.

Nenhum destes bloqueou a fase 2 — o `fold` está completo e passa nos 407 testes —, e nenhum
foi **decidido** aqui. Cada um é um ponto em que o normativo não fecha e o código teve de
seguir a única leitura disponível, sempre a mais conservadora. Estão registrados para virar
emenda ou permanecerem como observação, e o critério de precedência é o de sempre: o
documento normativo vence o código.

### 17.1 Bloqueantes se não resolvidos — mas não para a fase 2

| # | Buraco | Onde dói | O que o código faz hoje |
|---|---|---|---|
| **H-19** | **`DecisionState.community` não tem `originFinalSeq`.** R-18(a) manda toda réplica verificar `proof` sobre `BLAKE2b('assume/1' ‖ newCommunityId ‖ originFinalSeq)`, e §5.2 confirma o material. O valor entra no `opt<u64> originFinalSeq` da gênese (§7.4.5), mas o schema de §8.1 só declara `originCommunityId`. | **R-18 não é implementável** sem o campo: não há de onde tirar `originFinalSeq` na hora de `community.assumeHost`. | Campo acrescentado a `CommunityMeta`, gravado no `seq` 0. É derivado do log e tem **uma única origem possível**, então não há segunda leitura — é o mesmo formato de `HOLE-11` (`communityInvalid`), que foi fechado assim. Precisa entrar em §8.1. |
| **H-20** | **§8.4 não tem a forma inversa de `ftsRemoveScope`.** `mod.ban` tira as mensagens do alvo da FTS por escopo; `mod.revokeBan` "reexibe" (§18.1, §18.2) mas não tem como devolvê-las ao índice — reindexar exige o `content`, que o `fold` não guarda (§8.1 só tem metadado de decisão). | Depois de um ban revogado, as mensagens voltam às **listagens** e ficam fora da **busca**, para sempre. A UX de §18.2 promete reversibilidade sem ressalva. | `patchScope {hidden_by_ban: 0}` e nada de FTS. Acrescentar uma quarta forma a `Effect` é "mudança de contrato, com bump de `view_schema_version`" pelo próprio §8.4 — **não é decisão de implementação**. |

### 17.2 Ambiguidades — o código seguiu a leitura conservadora

| # | Ponto | As duas leituras | O que ficou |
|---|---|---|---|
| **A-03** | **§19.9, posição do cargo novo.** *"Criar: `rank` = `midpoint(rank do cargo imediatamente abaixo do topo do autor, próximo abaixo)`"*. §6.4.1 define `midpoint(a, b)` com `a < b`; os dois argumentos de §19.9 estão na ordem inversa (o primeiro é **maior** que o segundo). | (i) literal — argumentos incoerentes, e §6.4.1 manda tratar `a ≥ b` como "entra no fim"; (ii) por intenção — o cargo novo nasce logo abaixo do topo do autor. | (i). É o que `poc-01-fold` faz e o que G1 validou. **Consequência visível:** um cargo criado sem dica nasce **abaixo do cargo base**, então quem o recebe continua com `topRank` = base, e a hierarquia de §9.3 não muda. Quem quer um moderador acima dos membros precisa mandar `afterRank`. Se a intenção era (ii), §19.9 precisa ser reescrita — e a mudança afeta `role.create`, `channel.create` e `category.create`. |
| **A-04** | **§8.1, `threadsByRoot: Map<Id, Id>`.** O nome diz "indexado por raiz"; R-8 precisa resolver `threadId → canal` em O(1) e R-24 precisa de `raiz → existe?`. | (i) `raiz → thread` (o nome) — R-24 fica O(1), R-8 vira varredura; (ii) `thread → raiz` — os dois ficam O(1), porque R-24 passa a usar o `threadId` que §8.1 **já declara** em `MessageMeta`. | (ii), que é a leitura de `poc-01-fold`. É a única em que **toda** regra de §8.3 é implementável com o schema declarado e nada mais. O nome do campo em §8.1 contradiz o uso e deveria ser corrigido. |
| **A-05** | **R-19, prova de posse do relay.** *"`possession` verifica sobre `relayPublicKey` com a chave de identidade do autor"*. §5.2 é "tabela fechada e autoritativa" e **não tem prefixo de domínio** para esta prova. | (i) assinar os 32 bytes crus (literal); (ii) inventar um prefixo `'relay-possession/1'`. | (i). Inventar prefixo é mudar material assinado, que é exatamente o que §5.2 existe para impedir. **É a única assinatura do sistema sem separação de domínio** — §5.2 deveria ganhar a linha, e aí (i) deixa de valer. |
| **A-06** | **`verify` de Ed25519 não tem casa em L1.** §4 dá "verificação" a `identity`, que é **L0**, e dá ao `fold` exatamente quatro dependências: `opCodec`, `permissions`, `idgen`, `errors`. Os estágios 1 e 4 de §8.2 exigem verificar assinatura. | (i) `opCodec` expõe `verifySignature`; (ii) acrescentar `identity` às dependências do `fold` em §4. | (i). `opCodec` já constrói o material assinável de §7.1 (`opSigningHash`, `hostRecordSigningHash`), tem `Depende de` vazio e a única proibição de "validar semântica" — conferir uma curva sobre bytes dados não é semântica. (ii) faria L1 depender de L0 numa aresta que §4 não declara. |

### 17.3 Observações — corretas, mas dizem menos do que parecem

| # | Achado |
|---|---|
| **O-06** | **Os três tetos de bytes de §8.6 são inalcançáveis.** Um code point ocupa no máximo 4 bytes em UTF-8, então: `Message.content` 4000 cp ⇒ ≤ 16 000 B < 16 384 B; `Reaction.emoji` e `Community.iconEmoji` 8 cp ⇒ ≤ 32 B = 32 B. Nenhum dos três chega a disparar — o teto de code points sempre vence. Não é bug (o tamanho real do registro é limitado pelo estágio 13, 32 KiB sem anexo), mas §8.6 os apresenta como restrição ativa. Mesma família de `OBS-05` de G1, onde `ATTACHMENT_MAX_BYTES` (8 GiB) é inalcançável porque `ATTACHMENT_QUOTA_PER_MEMBER` (5 GiB) vence antes. Coberto por teste em `core/test/fold-limits.test.ts`. |
| **O-07** | **§27.1 manda as constantes de protocolo morarem em `protocol/constants.ts`, e §4 não tem módulo `protocol`.** A fronteira de camadas é por diretório de módulo da tabela de §4, então um `src/protocol/` seria violação. Cada constante ficou no módulo de §4 que a **aplica** — `RANK_*` em `permissions`, o resto em `fold` — e nenhuma é transcrita duas vezes. Se §27.1 quiser o módulo próprio, §4 precisa ganhar a linha. |

### 17.4 Bug encontrado pelo próprio teste, e corrigido

**R-15 contava só os registros `APPLIED`.** A primeira versão do pipeline avançava a janela
de cota depois de `applyKind` ter sucesso. R-15 é explícito no contrário: *"Entram em `J` os
registros do autor que **alcançaram o estágio 10**, `APPLIED` ou não — recusar num estágio
posterior **não** devolve a cota"*. Sem isso um autor inunda o log com ops que falham tarde e
não paga nada, que é precisamente o ataque que a regra fecha. Corrigido: o bookkeeping de
`REJECTED` também consome a janela quando o registro atravessou o estágio 10. Coberto por
`fold-pipeline.test.ts` ("recusar num estágio posterior **não** devolve a cota").

---

## 18. Buracos de spec levantados ao implementar o `projector` (2026-08-17)

A fase 2 fechou com o `projector` (§10.5), a reprojeção total, o snapshot de `DecisionState`
(§10.6) e a determinismo de §28.4 em CI. Como no §17, nenhum buraco abaixo foi **decidido**
aqui: cada um é um ponto em que o normativo não fecha e o código seguiu a única leitura
disponível, sempre a mais conservadora. Critério de precedência de sempre: o documento
normativo vence o código.

> **Estado: os seis viraram emenda em 2026-08-17.** As tabelas abaixo ficam como o registro do
> que o código encontrou e de por que cada leitura foi a escolhida — a resolução normativa de
> cada uma está em §19.1, e a partir dela o normativo voltou a vencer o código.

### 18.1 Onde o schema de §10.3 não declara o que o comportamento exige

| # | Buraco | O que o código faz hoje |
|---|---|---|
| **H-21** | **`rejected_records.kind` e `.author_key` não têm fonte.** §10.3 declara as colunas; §8.2 liga a tabela ao desfecho `REJECTED` ("só métrica e, quando aplicável, `rejected_records`"). Mas o `FoldResult` de §8.0 carrega só `decision`/`reason`/`effects`/`next` — sem `kind` nem `author` —, o projector (§4) não pode importar `opCodec` para decodificar o registro, e um registro recusado nos estágios 0–1 **não tem** `kind` nem autor decodificados. O "quando aplicável" de §8.2 não define quando. | As duas colunas ficam `NULL` (o schema as declara anuláveis); `seq` e `reason` saem sempre. Se a intenção for gravar `kind`/autor quando o registro decodifica, §8.0 precisa ganhar os dois campos — a família de `field`/`limit`/`hostTsClamped`, que já são extensões normativamente derivadas da assinatura. |
| **H-22** | **`ds_snapshot.fold_build_id` não está na tabela de §10.3.** §10.6 é explícito — "O snapshot carrega o **hash do binário do `fold`** (`foldBuildId`)" —, mas a linha de `ds_snapshot` declara só `community_id`, `interpreted_seq`, `blob`, `taken_at`. Sem a coluna o requisito de descarte é inexpressável. | Coluna `fold_build_id TEXT NOT NULL` acrescentada ao DDL. Mesma família de `HOLE-11` e `H-19`: comportamento obrigatório, representação única possível. |
| **H-23** | **§10.3 declara só duas chaves de `meta` — o boot precisa de mais duas.** `view_schema_version` e `op_version` são as declaradas. Mas §8.5/§10.5 exigem que um `fold.panic` fique **registrado no boot anterior** (marcador persistente), e §10.3 exige detectar snapshot "ausente ou inconsistente" — o que, depois de um crash entre a cadência de snapshots, só é detectável com o `interpretedSeq` do último lote **commitado** gravado junto com os efeitos. | Chaves `fold_panic:<communityId>` e `interpreted_seq:<communityId>` em `meta` (o esquema é key/value; as chaves são por comunidade porque um `view.db` serve todas). Se a emenda preferir outro lugar para os dois marcadores, o teste de paridade de §10.3 aponta. |
| **H-24** | **`meta.op_version` não tem escritor possível.** O projector é o **único** escritor de `view.db` (§21.1), e §4 dá a ele `fold`, `view` e `corestore` — `OP_VERSION` mora em `opCodec`, que não está na lista. `view` (L0) não pode importar `opCodec` (L1): a barreira quebra o build. | A chave fica sem escrever. Ou §4 ganha `opCodec` na linha do projector, ou `fold` reexporta a constante, ou a chave é escrita por quem compõe o boot (violaria §21.1 como escrito). |

### 18.2 Fórmulas que o normativo nomeia e não define

| # | Buraco | O que o código faz hoje |
|---|---|---|
| **H-25** | **As três contagens de `recount` não têm fórmula.** §10.5 passo 4 manda "recalcula os `recount`"; §8.4 define o `what` (`memberCount`, `roleMemberCount`, `threadReplyCount`) e §10.3 declara as colunas derivadas — mas nenhum texto define a população de cada contagem. Determinismo não exige fórmula específica (qualquer uma fixa converge), mas a semântica é de UI. | Leitura conservadora, documentada em `projector/apply.ts`: `memberCount` = membros com `left_at IS NULL AND banned=0`; `roleMemberCount` = iguais, por cargo; `threadReplyCount` = respostas com `deleted_at IS NULL AND orphaned=0` (o ban escondido é transitório, §18.2, e continua contando). É o mesmo desenho do projetor de `poc-01-fold` para as duas primeiras; a terceira é nova. |
| **H-26** | **`fold.panic{seq, kind}` — o projector não tem o `kind`.** §8.5 manda registrar a métrica com `seq` **e** `kind`, mas o `FoldResult` não carrega `kind`, um fold que lança pode nem ter decodificado o registro, e o projector não pode decodificar (§4). | O gancho `onPanic(seq)` leva só o `seq`; `kind` fica para a emenda de §8.0 que resolver H-21. |

### 18.3 Observações — corretas, mas dizem menos do que parecem

| # | Achado |
|---|---|
| **O-08** | **A FTS5 contentless-delete de §10.3 não aceita `DELETE FROM` e corrompe em remoção repetida.** O comando especial `'delete'` é o único caminho, e remover um `rowid` já removido produz `SQLITE_CORRUPT_VTAB` — o que aconteceria no primeiro `mod.ban` repetido, porque `ftsRemoveScope` alcança mensagens que já passaram por `ftsRemove`. A forma segura é o `'delete'` com guarda de pertença (`rowid IN (SELECT rowid FROM messages_fts)`), idempotente, em **um** comando por escopo — coerente com "o projector traduz cada forma em um `UPDATE ... WHERE`". É desenho de implementação, não buraco de spec; está registrado porque um `DELETE FROM` ingênuo quebra exatamente no cenário de §18.2. |
| **O-09** | **A linha de `communities` em §10.3 escreve "`id TEXT PK`" — PK de uma coluna —, e §10.1 manda `community_id` estar "em **toda** chave primária".** As duas não podem valer juntas. A regra estrutural de §10.1 venceu: `PRIMARY KEY (community_id, id)`, como em toda tabela. O teste de paridade relê §10.1 e confere que **toda** PK de `view.db` inclui `community_id`. |
| **O-10** | **O "byte a byte" de §10.3 é literal, com uma ressalva de relógio.** Com o `now` injetado fixo, dois diretórios limpos projetando o mesmo log produzem o **mesmo arquivo** `view.db` — testado com SHA-256 do arquivo fechado, além do hash de dump de §28.4. O único byte não derivado é o `taken_at` do `ds_snapshot` (§10.6), carimbo de relógio de parede de um **cache**; sem relógio fixo, a divergência entre duas reprojeções fica restrita a esses bytes e o dump ordenado é idêntico do mesmo jeito. |
| **O-11** | **O step 4/5 de §10.5 e os steps 1/4/5 da reprojeção tocam `manifest.db` — e §4 não dá `manifest` ao projector.** `local_read_state` (incremental por lote, com a barreira de dois bancos) e a enumeração de `manifest.communities` para a reprojeção são do algoritmo, mas a coluna "Depende de" do projector é `fold`, `view`, `corestore`. O módulo implementa a parte que o contrato lhe dá e declara a fronteira; a metade de `manifest` é da fase 3 (quem compõe o boot), que é a única leitura compatível com §4 exaustivo. Não é bloqueio: é o mesmo formato da porta de transporte de §4, mas para baixo. |

### 18.4 Barreira de durabilidade — resposta à pergunta da fase 2

**P1 não cruza o projector.** A barreira de §11 ("`await core.append(...)` **e** `await
core.flush()` antes de responder") é da submissão do **host** (§11.4), `communityHost`/`outbox`
— L2, fase 3, entrada de G4. O projector só **lê** o core (`get`/`length`/evento `append`) e
escreve `view.db`, cuja barreira de durabilidade é a transação SQLite por lote (`synchronous
= NORMAL`, §10.4) — nativa, sem `flush`. O caminho de admissão que compartilha o `DS` com o
projetor (§11.4) continua sendo responsabilidade do host na fase 3; ele não muda o que o
projector faz com os efeitos. Confirmação em `poc-03-runtime/REPORT.md`: o buraco é
"entrada obrigatória para quem escrever a outbox" — não para o leitor.

---

## 19. Os buracos de §18 e o P1 viraram emenda (2026-08-17)

Diferente de §17 e §18, **aqui houve decisão**. Cada item abaixo saiu de "o código seguiu a
única leitura disponível" para "o normativo diz, e o código transcreve" — a precedência voltou
ao lugar. Os testes de paridade releem o normativo em tempo de execução, então uma emenda
revertida no documento quebra a suíte antes de quebrar o produto.

### 19.1 As seis emendas

| # | O que o normativo passou a dizer | Onde |
|---|---|---|
| **H-21** | `FoldResult` declara `kind` e `author`, preenchidos **a partir do decode do `Op`** (estágio 2) e ausentes antes dele. O "quando aplicável" de §8.2 passou a significar exatamente isto: `rejected_records.kind`/`.author_key` são `NULL` **só** na recusa do estágio 0, o único desfecho sem decode. `field`, `limit` e `hostTsClamped` — que o código já devolvia por derivação — entraram na assinatura junto, pela mesma razão | `backend-v2.md` §8.0, §8.2, §10.3 |
| **H-22** | `ds_snapshot.fold_build_id TEXT NOT NULL` entra na tabela de §10.3. `NOT NULL` porque snapshot sem procedência **é** snapshot inválido: §10.6 manda descartar o que não bate, e não dá para comparar o que não existe | §10.3, §10.6 |
| **H-23** | §10.3.1, nova, é a lista **fechada** das quatro chaves de `meta`: `view_schema_version`, `op_version`, `fold_panic:<communityId>` e `interpreted_seq:<communityId>`. As duas por comunidade carregam o id no nome porque um `view.db` serve todas (§10.1). §10.6 ganhou de quebra a definição de "snapshot inconsistente", que era prosa: `ds_snapshot.interpreted_seq` ≠ o marcador do último lote commitado | §10.3.1, §10.5, §10.6 |
| **H-24** | `opCodec` entra na coluna "Depende de" do `projector` em §4 — a importação lateral que a própria seção prevê. Só a constante `OP_VERSION`; a coluna "Não pode" ganhou **decodificar registro**, que é o que mantém `kind`/`author` vindo do `FoldResult` e não de um decode do projector. A alternativa (reexportar pelo `fold`) esconderia a aresta em vez de declará-la | §4, §10.3.1 |
| **H-25** | §8.4 define a **população** das três contagens, com a tabela e as duas consequências que ela decide de propósito: `hidden_by_ban` **não** subtrai (a ocultação por ban é reversível, §18.2, e o contador não pode oscilar com ela), `left_at`/`banned` subtraem (quem saiu não aparece na tela que o número legenda) | §8.4, §10.5 |
| **H-26** | O `kind` de `fold.panic{seq, kind}` é o `kind` do `FoldResult`: presente quando a exceção veio **depois** do decode, ausente quando veio antes. Ausente não degrada a métrica — `seq` localiza o registro, o `kind` aponta o handler | §8.5 |

Das quatro observações, duas eram contradição de verdade e viraram texto; duas continuam
sendo o que já eram:

- **O-08** subiu para §10.3: a remoção em FTS5 contentless-delete é normativamente
  **idempotente** (comando `'delete'` com guarda de pertença). Não é preciosismo de
  implementação — a forma ingênua passa no teste feliz e corrompe o índice do usuário no
  segundo `mod.ban`.
- **O-09** foi corrigida na origem: a linha de `communities` em §10.3 dizia `id TEXT PK`,
  contra a regra de §10.1 ("`community_id` em **toda** chave primária"). Agora diz
  **PK `(community_id, id)`**, como todas as outras.
- **O-10** (o "byte a byte" com relógio fixado) e **O-11** (a metade de `manifest` é da fase 3)
  continuam observações. Nenhuma das duas pede emenda: a primeira descreve o que o teste já
  mede, a segunda é a leitura correta de §4.

**No código:** `FoldResult` ganhou `kind`/`author` por um probe preenchido no estágio 2, que
`foldRecord` copia para o resultado **inclusive no caminho de pânico** — é a única forma de o
`kind` de §8.5 existir. O `projector` grava as duas colunas, chama `onPanic(seq, kind)` e
escreve `meta.op_version`. `check-layers.ts` transcreveu a nova linha de §4. Dez testes novos,
443 no total, todos passando; três deles releem o normativo (as colunas de `ds_snapshot`, as
chaves de `meta` e a população dos `recount`).

### 19.2 P1 — a barreira de durabilidade tem primitiva, e ela é uma só

§10.7 mandava `await core.append(...)` **e** `await core.flush()`. A segunda metade não existe,
e o motivo é mais interessante do que "a API mudou de nome":

- `core.flush` não existe na sessão de Hypercore 11.35.1. O que existe é
  `core.state.flush()`, do `SessionState`, e ele **não é** barreira de durabilidade: commita a
  transação de escrita ativa. Chamá-lo depois de um append lança `TypeError` — porque
  `append()` já o chamou, e `_activeTx` voltou a `null`. O "estoura por dentro" registrado em
  §5 era isto.
- `append()` monta a transação, escreve blocos, árvore, bitfield e cabeça, e **só resolve
  depois** de o lote ir ao RocksDB. Quando o `await` volta, o commit aconteceu.

**Medido** (Node 22, WSL2/ext4, `hypercore@11.35.1`): um processo que appenda *N* registros e
se mata com `SIGKILL` imediatamente depois de o último `await` resolver — sem `close`, sem
checkpoint — deixa os *N* legíveis na reabertura. *N* = 1, 50 e 500, 100 % nas três.

O que isso **não** prova, e continua sendo de G4: `fsync`. `rocksdb-native` não expõe
`WriteOptions` no caminho de escrita e o padrão do RocksDB é `sync = false`, então o WAL fica
no cache de página — que um `SIGKILL` não perde e um corte de energia perde. §10.7.1 registra o
piso conservador: a barreira garante durabilidade contra **falha de processo**, não contra
falha de energia, e nenhuma superfície pode prometer mais (§24.1). O eixo otimista de §11.1
continua correto exatamente por isso: a garantia forte é a outbox em `manifest.db` com
`synchronous=FULL`, não o log.

Emendas: §10.7 (a linha), §10.7.1 (nova), §3.3 (`draining` fecha o core, não "flusha"), §11.5 e
§19.1 do normativo (group commit e gênese: uma chamada, não duas), `adr-v2.md` A06(1), e o
POC-07 do plano ganhou a linha "Entrada já fechada" — inclusive o registro de que o ponto de
kill "entre append e flush" **não existe**, porque é o mesmo instante.

### 19.3 O que ainda falta para a fase 2 estar concluída

> **Resolvido em 2026-08-17.** POC-07 foi construído (`poc/poc-07-outbox/`) e G4 saiu
> `CONFIRMADO` nos oito critérios. A fase 2 está **concluída**. O que o gate encontrou no
> caminho está em §20. Após a resolução normativa de §20.5, a fase 3 está liberada para
> implementação, mas o rerun multicanal de `opVersion = 2` ainda é necessário para concluí-la.

**G4.** Era o gate que fechava a fase 2 no diagrama de §6, e ele não tinha artefato. §19.2
fechou a *pergunta de spec* que era entrada dele; o gate em si exigia POC-07: a matriz de kill
de §28.3 inteira, contra o caminho de escrita **completo** — outbox (§11.2), seção crítica do
host (§11.4) e group commit (§11.5). Nada disso existia: é código de L2, fase 3. A ordem do
diagrama (`fase 2 → G4 → fase 3`) e o conteúdo de G4 (que precisa de código de fase 3) só
fechavam de um jeito, e foi o adotado: **o harness de POC-07 é descartável**, como os três de
fase 0, e mede o desenho — não o produto.

**Os buracos de §17 fecharam junto** — ver §19.4. Não sobra buraco de spec aberto em nenhuma
das duas listas; o que falta para a fase 2 é G4, e G4 é medição.

### 19.4 Os sete buracos de §17 também viraram emenda (2026-08-17)

| # | O que o normativo passou a dizer | Onde |
|---|---|---|
| **H-19** | `DecisionState.community` declara `originFinalSeq?: number`, o material que R-18(a) verifica. Vem do `opt<u64>` da gênese (§7.4.5) — derivado do log, origem única, mesmo formato de `HOLE-11` | §8.1 |
| **H-20** | §8.4 ganha **`ftsIndexScope`**, a forma inversa de `ftsRemoveScope`, e com ela `ftsRemoveScope` entra na union — a forma que o `fold` emitia sem o normativo declarar. Nenhuma das duas carrega texto: o `fold` não tem o `content`, e o projector reindexa a partir do `messages.content` que ele mesmo materializou, com o predicado que é o **complemento exato** das três remoções. Custou `view_schema_version` 1 → 2, como o próprio §8.4 exige | §8.4, §10.3 |
| **A-03** | §19.9 reescrita, e §6.4.1 ganha a regra que faltava — ver a nota abaixo, porque não era ambiguidade | §19.9, §6.4.1 |
| **A-04** | `threadsByRoot` vira **`rootOfThread`**, `threadId → raiz`. O nome antigo dizia o inverso do que o schema sustenta: R-8 precisa de `threadId → canal` em O(1), e R-24 já é O(1) pelo `threadId` da própria `MessageMeta` | §8.1 |
| **A-05** | §5.2 ganha `'relay-possession/1'`, e R-19 passa a verificar sobre `BLAKE2b('relay-possession/1' ‖ relayPublicKey)`. Era a **única** assinatura do sistema sobre bytes crus, e §5.2 existe exatamente para que nenhuma seja | §5.2, R-19 |
| **A-06** | §4 diz que `opCodec` faz verificação de assinatura sobre o material que ele mesmo constrói. A alternativa — dar `identity` ao `fold` — criaria uma aresta L1 → L0 não declarada | §4 |
| **O-07** | §27.1 deixa de mandar um módulo `protocol/constants.ts`, que §4 não tem: cada constante fica no módulo que a **aplica**. Um `src/protocol/` seria violação de build, e um módulo só de constantes não teria camada | §27.1 |

Depois do POC-07, `observed_ops` foi acrescentada ao schema derivado e elevou
`view_schema_version` de 2 para 3; essa alteração pertence à resolução de ACHADO-01, não ao
histórico de H-20.

**A-03 não era ambiguidade — era invariante violada, e ela mordia.** §6.4.1 afirma que "todo
`rank` gerado por `midpoint` ou por renormalização fica **estritamente entre** `RANK_BOTTOM` e
`RANK_TOP`, o que é o que mantém o cargo base no fundo e o Fundador no topo sem regra
adicional". Medido: a frase é falsa a partir do **sexto** item criado sem dica de posição, e
para **cargos** já no primeiro, porque o cargo base ocupa `RANK_BOTTOM` desde a gênese
(R-27b).

A consequência não é cosmética. Por R-3 todo membro carrega o cargo base; um cargo que nasce
**abaixo** dele não altera o `topRank` de ninguém, e por R-4 quem o recebe não modera nem um
membro comum. Criar "Moderador" com `ban_members` pelo caminho default — que é o caminho que
a UI usa quando não manda `afterRank` — produzia um cargo que não bane ninguém.

A emenda torna a invariante verdadeira **por construção**: onde o vizinho não existe, o limite
é `RANK_BOTTOM` embaixo e `RANK_TOP` em cima, e `midpoint` nunca recebe `null` vindo de um
escopo real. §19.9 passa a dizer que o item entra no fim do escopo *acima do piso*, que para
cargos é a posição mais baixa **útil**. A gênese não se move: `midpoint(RANK_BOTTOM, RANK_TOP)`
é literalmente `midpoint('1','zz')`, o vetor `'V'` que G1 fixou.

A invariante só era verificada para `renormalize`, o caminho que não tinha o defeito. Agora
`rankBetween` tem bloco próprio de teste — criação sucessiva, escopo de gênese, pedido
incoerente e dica válida.

**No código:** `ftsIndexScope` em `Effect` e no projector, com guarda de pertença invertida
(sem ela, escopo reindexado duas vezes duplica linha na FTS); `rankBetween` com os dois
sentinelas; `relayPossessionSigningHash` em `opCodec`; `rootOfThread` renomeado em `fold` e no
snapshot; `VIEW_SCHEMA_VERSION` em `2`. 450 testes passando.

---

## 20. POC-07 / G4 — o que o harness mediu, e os quatro achados (2026-08-17)

O harness está em `poc/poc-07-outbox/`, descartável como os três da fase 0, e o artefato em
`out/gate-G4/`. A leitura consolidada é o `REPORT.md` dele; aqui ficam só os achados que
**tocam o normativo**, porque os quatro precisam de resolução antes de a fase 3 ser escrita.

### 20.1 `ACHADO-01` — o ramo 1 de §11.6 perde dados, e §7.5 já tem a regra certa

§11.6 manda remover o item quando `lastAuthorSeq[eu] >= item.author_seq`. A inferência é
**insegura**: marca d'água alta prova que *algum* `authorSeq` ≥ aquele entrou, não que **este**
entrou. E o log tem buracos por desenho — §7.5 diz, na própria tabela: *"O cliente pode ter
buracos em `authorSeq`? **Sim.** A regra é estritamente crescente, não densa."*

**Medido:** com o host morrendo no meio de uma rajada, o log ficou com os `authorSeq`
`1..7, 13, 14, 15, 20, 21, 24, …, 40`; a marca d'água em 40 removeu **as 40** linhas da fila
com **21** registros no log. Dezenove operações perdidas **e reportadas como entregues** —
exatamente o que §11.3 promete ser impossível.

A correção já está no normativo, em outra seção. §7.5: *"Como o cliente sabe que a op entrou?
Procurando o **`opId`** na própria réplica projetada (§11.6). Não pela palavra do host."*
**§7.5 está certa; o pseudocódigo de §11.6 transcreveu a regra errado.** A marca d'água
continua útil como negativa barata (`<` prova ausência), e é assim que o harness a usa.

### 20.2 `ACHADO-02` — `authorSeq` por autor × ordem por canal: ops que nunca mais entram

**É decisão de arquitetura, e é a mais séria.** §7.5 numera por **autor**; §11.7 ordena por
**canal** e diz que *"um item bloqueado segura o próprio canal e **não os outros**"*. As duas
não valem juntas quando um membro escreve em mais de um canal: o `authorSeq` é atribuído em
ordem global no enfileiramento, então o canal que avança leva a marca d'água adiante e todo
item pendente dos outros canais, com número menor, passa a ser recusado **para sempre** pelo
estágio 6.

**Medido:** 8 canais, rajada de 256 envelopes — **45** entraram no log, **211** foram recusados
como duplicata sem nunca terem sido aceitos.

E §11.3 não oferece saída: `failed → queued` manda *"reenviar o mesmo envelope, mesmo
`authorSeq`, mesmo `opId`"* — o número que o host já recusa.

Três saídas, e escolher é do normativo:

| Saída | O que muda | Custo |
|---|---|---|
| **(a)** `authorSeq` por `(autor, canal)` | §7.1, §7.5, estágio 6 de §8.2 | Muda material assinado e o `DS`; ops sem canal precisam de escopo próprio |
| **(b)** Ordem global por comunidade | §11.7 perde "não os outros" | Um canal bloqueado segura todos — o que §11.7 existe para evitar |
| **(c)** Reenfileirar com `authorSeq` novo ao ser ultrapassado | §11.3 ganha exceção | O `opId` muda; a correlação com a bolha otimista precisa sobreviver à troca |

O harness implementa a **detecção** (`E_AUTHOR_SEQ_OVERTAKEN`, desfecho nomeado em vez de
perda silenciosa) e mede a vazão com **um canal**, que é o caso que a spec vigente sustenta.

### 20.3 `ACHADO-03` — `sending` encalha para sempre depois de um crash

§11.3 tem `sending → queued` para erro transitório, mas o terceiro ramo de §11.6 é
*"indeterminado: mantém"* — e um item que ficou em `sending` porque o **processo morreu** cai
nele. Como o `flush` só pega `queued`, ele nunca mais é tentado: nem entregue, nem descartado.
**Medido:** host morto em `host:before-append`, 36 de 40 itens encalhados, log parado em 4.

Emenda barata: §11.6 devolve `sending → queued` **no boot**, sem consumir tentativa.

### 20.4 `ACHADO-04` — §11.4 e §11.5 não podem ser literais ao mesmo tempo

§11.4 põe o passo 6 ("aguarda o append do grupo") **dentro** da seção crítica. Lido assim, a op
A segura a seção enquanto espera o append e a op B nem decide: **todo grupo tem um registro** e
§11.5 deixa de existir. O harness caiu nisso e **nada acusou** — durabilidade correta, testes
verdes; só a métrica `maiorGrupo = 1` denunciou. Com decisão e `DS` sob a seção e a **resposta**
fora dela, o grupo médio medido passou de 1 para **30,6** (teto 32).

### 20.5 Resolução normativa aplicada em 2026-08-17

Os quatro achados deixam de ser propostas e passam a ter contrato nos documentos
normativos:

| Achado | Resolução |
|---|---|
| `ACHADO-01` | §11.6 consulta `opId` em `observed_ops`, que contém somente `APPLIED`; `lastAuthorSeq` só pode provar ausência quando é menor que o item. |
| `ACHADO-02` | A05 adota `sequenceScope`: canal para as seis ops de mensagem enfileiráveis e `community` para ops sem canal. `opVersion`/`Op.v` passam a 2; retry comum preserva envelope e `opId`. |
| `ACHADO-03` | Boot converte `sending` órfão para `queued`, sem incrementar `attempts`; `awaiting-confirmation` não é convertido. |
| `ACHADO-04` | A seção crítica cobre decisão/reserva, não o append. Há um grupo em voo; `core.append` resolve fora do lock, publica o `DS` ou descarta o grupo inteiro. |

Essa é uma emenda de arquitetura seguida pela implementação inicial: `core/` já contém o
codec escopado, `observed_ops`, o manifesto, a outbox e a admissão do host. O harness
descartável continua refletindo a versão anterior; a integração com o produto e o rerun de
G4 com múltiplos canais ainda são necessários.

### 20.6 O veredito, e o que ele não cobre

`CONFIRMADO` nos oito critérios — zero perda, zero duplicata, convergência em 9/9 pontos de
kill, adversário detectado, p95 muito dentro do alvo de §26.1. O artefato declara cinco
limitações com id próprio (`G4-E1` a `G4-E5`); a que mais importa é `G4-E1`: **queda de energia
continua fora**, porque `rocksdb-native` não expõe `WriteOptions` e sem `fsync` observado o WAL
fica no cache de página. §10.7.1 já registra esse piso, e o gate não o move.

---

## 21. Fase 1 — fundação de fronteira (§29, A16, §10.8): implementação inicial 2026-08-20

**Gate de entrada:** G0 e G10 aprovados nos dois alvos (A16) — ver §15. `core/` já tinha
fase 2 (G1) e fase 3 (G4) como código Node puro; a fase 1 fecha o que faltava para o produto
Electron ser montável: IPC-R/IPC-M, autorização, deep link, identidade e wipe.

### 21.1 O que foi entregue

| Entrega | Onde | Seção | Teste |
|---|---|---|---|
| `config`/`clock` | `core/src/l0/config` `clock` | §27.2, §1.5 | `fase1-boundary — Config & Clock` |
| `keystore` | `core/src/l0/keystore` | §3.2, §5.4, A13 | `fase1-boundary — Identity e Keystore` |
| `identity` | `core/src/l0/identity` | §5.1, §5.5, §6.1, A13 | `fase1-boundary — Identity` (`create`, `load`, `sign`, `export`/`import` Argon2id+XChaCha20, `handle`) |
| `ipcMain` | `core/src/l3/ipcMain` | §3.5, §10.8, §15.3, §15.7 | `parseDeepLink` (gramática fechada), `AuthTokenStore` (uso único/TTL 60 s, `main-confirmed`), `ProcessLock` (PID file) |
| `ipcRenderer` | `core/src/l3/ipcRenderer` | §15.1, §15.2, A14 | `IpcServer` (`epoch`/`subId`/`evSeq`, janela 256, `evStale`/`resync`, `E_UNKNOWN_COMMAND`/`E_NO_IDENTITY`/`E_PERMISSION_DENIED`), `MemoryIpcPort` |
| `manifest` | `core/src/l0/manifest` | §10.2, §11.2 | já existia; fase 1 usa `identity.enc`/`datakey.wrapped` em arquivo como base para a migração a `manifest.secrets` |
| `wipe` | `core/test/fase1-wipe-resumption` | §18.6, §10.8 | `wipe_state` gravado **antes** da etapa, sentinela `WIPE` após `manifest-deleted`, `LOCK` por último, retomada de `view-deleted` |

Build e fronteira: `npm run build` = `tsc` + `check-layers.ts` (§4). `§4 ok — 34 arquivo(s), módulos por camada L0:7 L1:6 L2:2 L3:2`. `npm test` = 486 testes, 0 falha (inclui fuzzer de totalidade §8.5).

### 21.2 Como foi validado

Os testes de fase 1 seguem o mesmo padrão da suíte de `core/` — `node --test` em `dist/test`,
sem Electron, sem rede, com `MemoryIpcPort` e `FallbackKeystoreOracle` (`insecure:`). Eles
provam: `epoch` errado é descartado sem resposta (§15.1), `subId` é do servidor, `evSeq`
monotônico por `subId`, janela 256 produz `evStale` e `evAck` retoma, classes `open` /
`standard` (exige identidade) / `main-confirmed` (exige `authToken` de uso único) / `dev`
(gateado por `P2P_BUILD_CHANNEL=prod`), deep link só nas duas formas de §3.5 e
`identity.wipe` como máquina retomável com `SWAP`.

### 21.3 Riscos residuais e o que ainda não é G0/G10 — **fechados em código em 5295f1b, pendente pack**

> **2026-08-20:** os seis riscos abaixo foram transcritos do normativo para código em `5295f1b`,
> seguindo `poc/poc-10-identity` e `poc/poc-03-runtime` como evidência (não cópia). A validação
> empacotada G0/G10/G6 nos dois alvos da matriz A16 permanece pendente, assim como `G4-E1`
> (queda energia sem `fsync` observado §10.7.1). Até o pack, a evidência de release continua
> sendo a dos POCs, não a do produto `app/`.

| Risco | Onde doía | Correção em `5295f1b` (file:line) |
|---|---|---|
| **Shell Electron não empacotado** | `core` com `MemoryIpcPort`, sem `utilityProcess` real §3.1/§3.3 | `app/src/main/index.ts:1-260` + `app/src/utility/index.ts:1-80` + `app/src/preload/index.ts:1-50` — dois `MessageChannelMain`, `requestSingleInstanceLock`+`second-instance` §10.8, probe `--password-store` A13(5)(6), `safeStorage` oráculo, `dialog`/`shell.openPath`/`setDisplayMediaRequestHandler`, ciclo `boot`→`draining` |
| **`ProcessLock` sem `flock`** | PID file com `ftruncate` §10.8, `EPERM` no Windows G10 §3.1.2 | `core/src/l3/ipcMain/index.ts:1-210` `O_RDWR\|O_CREAT` + `fs-native-extensions` `tryLock`/`unlock` (`LockFileEx`), `install_id` persistido, `lock.stolen` |
| **`manifest.secrets` não usado** | `identity.enc` em arquivo, diverge de §10.2 | `core/src/l0/manifest/index.ts:63-340` `secrets`/`communities`/`FULL`; `core/src/l0/identity/index.ts:143-360` injeção `ManifestDb` em `secrets` (`data_key`+`identity_seed`) com fallback arquivo |
| **`safeStorage` real não exercitado** | `FallbackKeystoreOracle` só, L-2 | `core/src/l0/keystore/index.ts:44-210` `ElectronSafeStorageOracle`+`IpcKeystoreOracle` via IPC-M, `isDegraded` por `isEncryptionAvailable()`, probe `gnome-libsecret→kwallet6→kwallet5` com `relaunch` |
| **IPC-M não separado fisicamente** | `MemoryIpcPort.createPair()` simula §3.1 | `app/src/main/index.ts:90-130` cria `ipcM` e `ipcRForUtility`, `core/src/l0/keystore/index.ts:84-147` consome IPC-M |
| **Falta G6 (crash/restart)** | `epoch`/`subId` em teste, sem `SIGKILL` 3×/60s §15.2/§3.3 | `core/src/l3/ipcRenderer/index.ts:273-420` `IpcClient.handleCoreEpoch` (`E_CORE_RESTARTED`, descarta `subId`), `app/src/main/index.ts:150-190` `utility.on('exit')` `epoch++` backoff `1s/4s/10s`; `poc/poc-04-g6` `APROVADO 6/6` em `quick`+`full` (Node) |

Nenhum dos riscos acima bloqueia a fase 2/3 já implementada — `fold`, `projector`, `outbox` e
`communityHost` continuam puros e testados —, mas todos precisam de pack nos dois alvos
(glibc ≥2.31 via container, rebuild por Electron) e rerun `G0`/`G10`/`G6` **empacotado** antes de
fase 1 ser considerada **validada para release**. Até lá a implementação é **em código**,
coberta por `core: npm test` `486/486` + `poc/poc-04-g6` `quick`+`full` (Node), e a evidência
de G0/G10 continua sendo a dos POCs históricos.

### 21.4 G6 — IPC crash/restart (§15.2, A14) — `quick`+`full` (Node) aprovados 2026-08-20

Harness `poc/poc-04-g6` `APROVADO 6/6` em `quick` (10k, 1,5s) e `full` (Node, 100k, 1,6s):
`out/gate-G6-quick/gate-G6.json` e `out/gate-G6/gate-G6.json` `verdict: APROVADO`
`linux-x64` `C1` hello/epoch, `C2` 100k janela 256 com pausa 1s (`evStale`), `C3` 1000 req
sem duplicata (`opId` idempotente), `C4` 3 crashes `epoch 1→4` com replay do log e
convergência (`before:1000`→`after:1000`), `C5` `evStale`→`resync`, `C6` heap `ratio:1.001`
≤1.2. Pendente só `full` **empacotado** (`electron-builder`, `contextIsolation`/`sandbox`,
`MessageChannelMain` nativo, `G6-E1` análoga a `G0-E1`) para fechar G6 e liberar fase 4
junto com G2 `plano-de-validacao-experimental-v2.md:6` `fase3─┬─G2─┐└─G6─┴→fase4`. Detalhe em
`poc/poc-04-g6/REPORT.md:1-80`.

### 21.5 G2 — reprojeção, participação, chaves e blobs (A03, A09) — `quick`+`full` (Node) aprovados 2026-08-20

Harness `poc/poc-02-g2` `APROVADO 9/9` em `quick` (5 comunidades/100 msgs) e `full` (Node,
10 comunidades/1000 msgs, 100 blobs): `out/gate-G2-quick/gate-G2.json` e
`out/gate-G2/gate-G2.json` `verdict: APROVADO` `linux-x64` `C1` comunidades/chaves em
`manifest.communities`, `C2` 100/1000 msgs + `dumpHash`, `C3` reprojeção limpa idêntica
(`viewHash` `dumpBefore`), `C4` sem `ds_snapshot`, `C5` bump `view_schema_version`,
`C6` crash `view.db` vs `manifest.db` com `reproject`, `C7` `coreKey`/`blobsKey`
inalterados, `C8` blobs `verified`, `C9` boot ≤4s. Pendente `G2-E1` escala real
(50 comunidades/5000 msgs, 500 blobs, 4 GiB, 3 SOs A16) e `Hyperblobs`/`hyperdht/testnet`
para fechar G2 e, junto com G6, liberar fase 4 `plano:6`. Detalhe em
`poc/poc-02-g2/REPORT.md:1-70`.

Com G2 e G6 `APROVADO` em `quick`+`full` (Node), **fase 4 está liberada em código**
(contrato `manifest×view` e `epoch/subId/evSeq`). Resta `G2-E1`/`G6-E1` e pack `G0/G10`
nos dois alvos para `validada para release`.

---

## 22. Fase 4 — replicação e rede visível (§29, §14.2/§14.3/§14.5, §6.15, §6.16, §17.6): implementação em código 2026-08-20

**Gate de entrada:** G2+G6 `APROVADO` 9/9 + 6/6 `quick`+`full` (Node) — ver §21.4/§21.5.
`plano:6` `fase3─┬─G2─┐└─G6─┴→fase4`. Fase 4 implementada como módulos puros com relógio
injetável e `Swarm` mockado (sem `hyperdht` real); DHT/Noise e escala multicomunidade
continuam pendentes como `G2-E1`/`G6-E1`/`G0-E1` para `validada para release`.

| Entrega | Onde | Seção | Teste |
|---|---|---|---|
| `swarm` | `core/src/l0/swarm` | §14.1/§14.2/§14.3 | `fase4-replication — §14.2/§14.3` — `allocateConnections` (40% ativa ≥8, 40% host `HOST_MAX_PEERS`, round-robin + `BG_ROTATION_MS` 60 s), `authorizeReplicationChannel` + `firewallShouldRejectConnection` (só quando banido em **todas** as comuns, pré-membro exceto §12.3, fecha T-25), `join`/`leave`/`getStats`/`degraded`, `degraded` via bootstrap |
| `communityClient` | `core/src/l2/communityClient` | §14.5, §6.15 | `fase4-replication — §14.5` — `computeReplicationState` com `HELLO_INTERVAL_MS` 30 s/`REPLICATION_STALL_MS` 20 s/`REPLICATION_WATCH_MS` 5 s, `synced`/`catching-up`/`stalled` (`no-provider`) /`blocked` (`gap`) /`unauthorized` (`accessRevoked`)/`forked`, `watchdogTick` com lag/`reason`, `markHello`/`markUnauthorized`/`markForked`/`markBlocked`; `computeUnreadForChannel` §6.15 com `lastReadSeq`/`hiddenByBan`/`pendingMentions` |
| `presence` | `core/src/l2/presence` | §6.16, §17.6, A27 | `fase4-replication — §6.16/§17.6` — `PresenceManager` com `PRESENCE_TTL` 45 s/`TYPING_TTL` 5 s, rate-limit 5 s presença /2 s typing por canal, `invisible` não publica (§6.16), `subscribeChannel` por interesse (typing só para assinantes), host agrega `presence.changed` delta a cada `PRESENCE_TICK_MS` 2 s, `tick` expira TTL e emite |
| `config` | `core/src/l0/config` | §27.2 | `swarmMaxConnections` 128, `hostMaxPeers` 256, `bgRotationMs` 60k, `replicationWatchMs` 5k, `replicationStallMs` 20k, `helloIntervalMs` 30k, `presenceTickMs` 2k — congelada no boot |

Build e fronteira: `npm run build` = `tsc` + `check-layers.ts` (§4). `§4 ok — 37 arquivo(s), módulos por camada L0:8 L1:6 L2:4 L3:2`. `npm test` = 508 testes, 0 falha (inclui `fase4-replication` 22).

### 22.1 Limitações de evidência que permanecem para `validada para release`

| Limitação | O que ainda não foi medido | Gate/atributo que a fecha |
|---|---|---|
| `G2-E1` | Escala real: 50 comunidades participadas, 5 000 msgs/comunidade, 500 blobs, 4 GiB, 3 SOs A16 + `Hyperblobs`/`hyperdht/testnet` com crash entre `view.db`/`manifest.db` | G2 |
| `G6-E1` | `full` empacotado `electron-builder` com `contextIsolation`/`sandbox` + `MessageChannelMain` nativo, `SWARM` real, `SIGKILL` do `utilityProcess`, heap/v8 + `tc/netem` | G6 |
| `G0-E1`/`G0-E2` | Pack nos dois alvos da matriz A16 (glibc ≥2.31 via container, rebuild por Electron) e rerun `POC03_PROFILE=full`/`POC10_PROFILE=full` | G0/G10 |
| `G9/B2/B4` | Benchmarks `BENCHMARK REQUIRED` (boot multicomunidade, fan-out efêmero) antes de anunciar 340 membros/L-13 | G9 |

`REQUIRES POC`/`BENCHMARK REQUIRED` de `CLAUDE.md:44` continuam bloqueando a fase
seguinte: **G3** (`invite delegado` A08 `p2p-admission/1` com 6 desfechos, `maxUses`
atômico §12) é `REQUIRES POC` antes da fase 5, e **G5+G11** (core de blobs por autor
A09 + `ticket` §13.3 e allowlist `§13.6` com fuzzing §13.6/G11) antes da fase 6.
A UI não anuncia números não medidos (§26.1, §44).

---

## 23. Fase 7 — mídia no núcleo: STUN/TURN do host, credencial curta e tickets de sessão (§17.2–§17.4, A17, A22): implementação em código 2026-08-21

**Gate de entrada:** G7 com evidência parcial em `poc/poc-08-g7/out/gate-G7/gate-G7.json`
(demux 100%, servidor TURN funcional com clientes WebRTC reais, matriz de NAT ≥95%, relay
cego medido, revogação ≤ 5 s). Os `openCriteria` (CGNAT/netem de kernel, Opus/SRTP no
renderer empacotado, CPU dedicada) bloqueiam **release**, não implementação — mesmo padrão
do G4/fase 3. Decisões do harness foram reaproveitadas como decisões; o código do poc é
descartável e nada foi copiado.

| Entrega | Onde | Seção | Teste |
|---|---|---|---|
| Demux da socket compartilhada + codec STUN/TURN | `core/src/l2/communityHost/stunTurn.ts` | §17.3, A17 | `media-stun-turn — demux §17.3` — regra literal (bits `00` + magic cookie + comprimento), adversarial (cookie errado, bits `10`/`11`, length mentirosa), ChannelData (`0x40–0x7F`) roteado ao TURN antes do fallback UDX (ordem validada em G7 C2/C3) |
| Binding RFC 5389 | idem | §17.3 | `media-stun-turn — STUN Binding` — XOR-MAPPED-ADDRESS = origem observada |
| Subconjunto TURN RFC 5766 sobre portas injetadas | idem (`MediaServer`) | §17.3 | `media-stun-turn — Allocate/Refresh/CreatePermission/ChannelBind/Send/Data` — 401 com realm+nonce, 437 mismatch, 442 transporte, MI na resposta; Send/Data e ChannelData nos dois sentidos via porta de relay simulada |
| Credencial TURN de curta duração | idem (`issueTurnCredential`/`turnCredentialPassword`) | §17.3 | `media-stun-turn — turnCredential` — `username=<sessionId>:<expiresAt>`, HMAC-SHA-256 (`crypto_auth`) sobre BLAKE2b('turn-cred/1'‖sessionId‖peerKey‖expiresAt); amarração a par/sessão/validade |
| Controles do TURN do host | idem (`TurnControls` + `MediaServer`) | §17.3, §27.2 | tela recusada (`screen-refused`), `TURN_ALLOC_PER_MEMBER`=2 → 486, permissão só roster → 403, TTL renovável enquanto a sessão viver (credencial expirada recusa o refresh), balde de tokens por `TURN_RATE_KBPS`, teto `TURN_SESSION_MAX_BYTES`, sweep por relógio injetado |
| Tickets de mídia + revogação | `core/src/l2/voiceCoordinator/index.ts` | §17.4, A22 | `media-tickets` — Ed25519(hostKey, BLAKE2b('media-ticket/1'‖sessionId‖channelId‖peerA‖peerB‖expiresAt)), par canônico, forjado/adulterado/expirado → `E_TICKET_INVALID`; `VoiceTicketManager`: aceite/renovação, DTLS só para pares válidos, `revoke()` fecha imediato e bloqueia a sessão por até `MEDIA_TICKET_TTL_MS` (`clearRevocation` destrava pelo roster), `dropSession`/`sweep` |
| Sessões de voz host-side | `core/src/l2/voiceCoordinator/host.ts` | §17.4, §RPC, §17.6 | `voice-host` — `VoiceHostSessions`: `join` valida §17.4 passo 1 contra o `DecisionState` (`voice_speak`, canal de voz, comunidade não ended, membro ativo não banido/timeout) e devolve `{sessionId, roster[], iceServers[], tickets[], turnCredential}`; `leave`/`setSelf{muted?,deafened?,cameraOn?,speaking?}` com `E_VOICE_FULL`/`E_CAMERA_LIMIT`; `renewTicket` par-a-par (`E_TICKET_DENIED`); `sweepAgainst(state)` deriva `voice.revoked` de ban/kick/timeout/`channel.delete`/fim da comunidade; fan-out `VoiceRoster` a cada mudança |
| Constantes | `core/src/l1/fold/constants.ts` + `core/src/l0/config/index.ts` | §27.1, §27.2 | `MEDIA_TICKET_TTL_MS` 5 min, `MAX_VOICE_PARTICIPANTS` 24, `MAX_CAMERAS` 6 no `fold` (protocolo); `turnRateKbps` 512, `turnAllocTtlMs` 600000, `turnAllocPerMember` 2, `turnSessionMaxBytes` 2 GiB, `relayMaxBytesPerDay` 5 GiB, `relayMaxAllocs` 4 como defaults operacionais na `config` L0 com env `P2P_*` |

Build e fronteira: `npm run build` = `tsc` + `check-layers.ts` (§4). `§4 ok — 43
arquivo(s), módulos por camada L0:8 L1:6 L2:7 L3:2`. `npm test` = 580 testes, 0 falha
(inclui `media-stun-turn` 25 + `media-tickets` 14 + `voice-host` 17).

### 23.1 Decisões de implementação registradas

| Decisão | Justificativa normativa |
|---|---|
| Sem módulo novo `l2/media`: STUN/TURN em `communityHost` e tickets/revogação em `voiceCoordinator` | Tabela de §4 já atribui "roster, STUN/TURN" ao `communityHost` e "tickets de sessão, revogação" ao `voiceCoordinator`; o barreira de build rejeita diretório fora da tabela, e criar módulo seria alterar §4 sem evidência nova |
| `MEDIA_TICKET_TTL_MS` mora no `fold` (§27.1) e chega ao `voiceCoordinator` por injeção | §4 não declara `fold` nas dependências dele; uma constante nunca é transcrita duas vezes |
| Estado do log chega ao host-side pela porta estrutural `VoiceStatePort`, tetos via injeção | §4 também não declara `fold` para leitura de estado — mesmo padrão de `AppendablePort`/portas RPC; o `DecisionState` real satisfaz a porta por estrutura (testado contra gênese real) |
| Defaults `TURN_*`/`RELAY_*` na `config` (L0), não no `fold` | São §27.2 ("como esta instalação usa recursos locais"); o cabeçalho de `fold/constants.ts` fixa a divisão |
| Portas `MediaSocketPort`/`RelayPort` injetadas; nenhum `dgram` no core | §4: quando L2 precisa falar rede, declara a **porta** e L3 implementa no boot |
| MESSAGE-INTEGRITY long-term (HMAC-SHA1 sobre MD5(user:realm:password)) mantida sob a credencial curta | É o que torna a senha emitida compatível com clientes WebRTC reais — decisão validada em G7 C1/C6 (werift) |
| Tela via TURN recusada na camada de decisão, não no fio | REQUESTED-TRANSPORT=UDP é igual para voz e tela; o enforcement real é quem emite credencial (só `voiceJoin` de voz). Mesmo desenho validado em G7 C5 |
| Erros na fronteira só do catálogo §20.2 (`E_TICKET_INVALID`); recusas TURN internas são razões nomeadas que viram códigos RFC (401/403/437/442/486) | O catálogo de erros é fechado e não tem códigos de rejeição TURN |
| Voz: um participante, uma sessão — entrar noutra canal sai da anterior com revogação | Uma chamada por cliente é o modelo do produto (§2.3); sessões múltiplas por membro criariam roster e credenciais ambíguos |
| Renovação da `turnCredential` = re-`join` idempotente (mesma sessão, material fresco) | O `username` carrega `expiresAt` (§17.3), e `voiceTicket` só devolve `{ticketId, ticket, expiresAt}` — sem campo para credencial. A cadência de renovação passa a ser o próprio `voiceJoin` |
| Revogação client-side caduca em `MEDIA_TICKET_TTL_MS` e o roster pode destravar antes (`clearRevocation`) | §17.4 define o pior caso como expiração do ticket; reentrada legítima na mesma sessão precisa de caminho determinístico |
| Permissão removida no meio da sessão não derruba chamada | §17.4 define enforcement por remoção de roster + revogação de ticket; `voice_speak` é validado na entrada (`sweepAgainst` só deriva de estado estrutural do membro/canal/comunidade) |

### 23.2 Limitações que permanecem

| Limitação | O que falta | Quem fecha |
|---|---|---|
| Wiring de produto | Socket UDP real (L3/boot) injetando `MediaSocketPort`/`RelayPort`; roteamento dos fan-outs `voice.revoked`/`VoiceRoster` aos destinatários conectados; livro de endereços `host:port` do roster para as permissões do `MediaServer`; `settings.setDevice`/`device_pref` e evento `voice.deviceError` (superfície local de dispositivos, RT-10) | Fases seguintes de integração (IPC-R/IPC-M, `app/`) |
| `openCriteria` do G7 | CGNAT/netem de kernel, Opus/SRTP nativo no Electron empacotado, CPU dedicada na escala de referência | G7/G8 empacotado — bloqueia release, não código |
| Relay voluntário (A21) | TURN restrito do voluntário com consentimento persistido, `relayPk` derivada, TTL/cota §17.7 | Fase 9, após o núcleo |
| Árvore de multicast (A20) | Especificada e adiada; bloqueada por G13 | §17.8 |
| Números não medidos | CPU 12,4% do harness é limite superior (clientes no mesmo processo); a UI não anuncia | G9 / `BENCHMARK REQUIRED` |

## 24. POC-09 / G8 — camada de decisão da sessão de tela em código puro e evidência parcial em estrela WebRTC Node (§17.4–§17.5, A19/A22): harness 2026-08-21

**Gate de entrada:** nenhum — G8 estava sem evidência. **Resultado:** evidência parcial em
`poc/poc-09-g8/out/gate-G8/gate-G8.json` (perfil full, 13/13; quick 11/11 em
`out/gate-G8-quick/`). Interpretação em `poc/poc-09-g8/REPORT.md`. O harness importa os
artefatos compilados do core (`MediaServer`, `VoiceHostSessions`, `ShareHostSessions`,
`VoiceTicketManager`, `TurnControls`) — nada de mídia/tickets/decisão foi reimplementado,
corrigindo o desvio do poc-08.

| Entrega | Onde | Seção | Teste/evidência |
|---|---|---|---|
| `SHARE_MAX_VIEWERS` como constante de protocolo | `core/src/l1/fold/constants.ts` | §27.1 | injetada na decisão; teto exercitado nos testes e no harness (9º espectador → `E_SESSION_FULL`) |
| Camada de decisão da sessão de tela + captureToken | `core/src/l2/voiceCoordinator/share.ts` (`ShareHostSessions`, `authorizeCapture`, `degradeOnLoss`, perfis §17.5) | §17.4/T-41, §17.5, A19/A22 | `media-share` — matriz de autorização do `share.start`, uma sessão por canal (`E_ALREADY_SHARING`), captureToken recusado forjado/sessão errada/expirado/pós-stop, teto 8 + vaga reaberta, `setQuality` `{applied:true}` com papel espectador literal, ban via `sweepAgainst` encerra sessão e revoga espectadores, tabela de `degradeOnLoss` (>3 %) — 25 testes |
| Estrela WebRTC real sobre a decisão | `poc/poc-09-g8` (werift; descartável) | POC-09/G8 | latência p50/p95 apresentador→espectador (8 espectadores: p95 máx 0,6 ms localhost), perda, bitrate por perfil medido nos receptores (1167/1200), `setQuality` mensurável (razão medida 0,239 vs contratual 0,24), degradação >3 % aplicada e medida (2317→1112 kbps), ban → cessação 0 ms (critério ≤5 s), entrada tardia 153 ms ao 1º quadro, ticket adulterado recusado antes de DTLS, STUN/demux reais |

### 24.1 Decisões de implementação registradas

| Decisão | Justificativa normativa |
|---|---|
| Decisão host-side da sessão de tela em `voiceCoordinator/share.ts`, não em módulo `shareStar/` | §4 atribui "sessão de tela, autorização" ao `shareStar`, mas esta parte é código puro sem mídia e a instrução registrada desta sessão foi implementá-la no `voiceCoordinator`; o `shareStar` produto (fase 8) consumirá estas classes — migração mecânica se a fase 8 exigir |
| `captureToken` opaco aleatório amarrado à sessão com comparação timing-safe, não ticket assinado | quem valida é o próprio host que o emitiu (`capture.authorize`, IPC-M main→núcleo→main); não há verificador terceiro, então Ed25519 acrescentaria codificação sem propriedade nova — mesmo critério do catálogo fechado de erros de §23.1 |
| Apresentador precisa estar na chamada de voz para `share.start`; fora dela → `E_SESSION_GONE` | A19/§17.5: a sessão vive dentro da chamada ("espectador é participante do canal de voz", `F-18`); erro não catalogado no §RPC para este caso — escolhido estado nomeado existente |
| `setQuality` literal ao papel "espectador" do §RPC: apresentador não muda perfil alheio | coluna Perm. de §RPC; mudança global de qualidade não está especificada |
| Degradação automática só desce um perfil por evento, sem subida automática | §17.5 define apenas "degrada a qualidade automaticamente conforme share.health reporta perda"; limiar 3 % vem do critério G8 do plano (`SHARE_LOSS_DEGRADE_PCT` no módulo, não no `fold` — não decide op) |

### 24.2 Limitações que permanecem

| Limitação | O que falta | Quem fecha |
|---|---|---|
| `openCriteria` do G8 | Chromium empacotado com `getDisplayMedia`/`RTCStatsReport` reais e encoder real; tc/netem (uplink 5/10/25 Mbps), CGNAT; CPU ≤40 % em alvo dedicado; `share.health` do renderer | G8 empacotado — bloqueia release, não a fase 8 |
| Enforcement de bitrate no werift | `setParameters({maxBitrate})` é aceito mas não aplicado pelo werift ("todo impl"); no escopo Node quem aplica é a bomba do apresentador, com efeito medido | produto usa o encoder do Chromium |
| Lacunas normativas | validade do `captureToken` (injetada, 120 s no harness), erro de `share.start` fora da chamada, histerese/subida de qualidade | emenda normativa ou deltas-ux antes da fase 8 |

## 25. Fase 8 — tela em estrela: módulo `shareStar`, entidades efêmeras e saúde ao apresentador (§17.5, §6.16, §RPC `share.*`, A19/A22): implementação em código 2026-08-21

**Gate de entrada:** G8 com evidência parcial (§24) — os `openCriteria` empacotados
bloqueiam release, não implementação, mesmo padrão de G4/fase 3 e G7/fase 7. Entrega da
fase conforme §29: captura autorizada, estrela ≤ 8, qualidade por espectador e saúde ao
apresentador — tudo em decisão host-side, porque o núcleo nunca vê mídia (§17.2); a
estrela em si é WebRTC no renderer.

| Entrega | Onde | Seção | Teste |
|---|---|---|---|
| Módulo `shareStar` (L2 sobre `voiceCoordinator`) | `core/src/l2/shareStar/` | §4 | barreira de camadas: `§4 ok — 46 arquivo(s) … L2:8` |
| Sessões host-side + captureToken + teto + qualidade por espectador | `shareStar/sessions.ts` (`ShareHostSessions`, migrada do `voiceCoordinator` onde nasceu no G8, §24) | §17.5, T-41 | `media-share` — 25+3 testes (matriz de autorização, `E_ALREADY_SHARING`, captureToken forjado/expirado/sessão errada/pós-stop recusados, 9º espectador `E_SESSION_FULL`, `setQuality` `{applied:true}` papel espectador, ban via `sweepAgainst`) |
| Entidade efêmera `ShareSession` + eventos `share.started`/`share.viewersChanged`/`share.stopped` | idem (`topology:'star'`, callback `onSessionEvent`) | §6.16, §RPC eventos | `media-share` — started/viewersChanged/stopped exatamente uma vez; join idempotente não reemite; snapshot carrega topologia e contagem |
| Saúde ao apresentador com degradação automática | `shareStar/health.ts` (`ShareHealthMonitor`: `ingest` → tick consolida → `onHealth`; degradação pelo caminho de sistema `degradeTo`, só desce) | §17.5, §17.6, §6.16, RT-08, critério G8 (>3 %) | `share-health` — 9 testes (consolidação latest-wins, poda de sessão encerrada/espectador que saiu, borda 3 %, nunca sobe, piso low, `not-lower`/`gone`, cadência 2 s exposta) |
| Varredura de permissão compartilhada | `voiceCoordinator/host.ts` exporta `memberHasPermission` (a barreira bloqueou `permissions` direto no `shareStar`: §4 não o declara) | §4, §9.1 | testes existentes de voz e tela |

### 25.1 Decisões de implementação registradas

| Decisão | Justificativa normativa |
|---|---|
| Migração da decisão do G8 para o módulo próprio executada na fase 8 | §24 antecipou ("migração mecânica"); a linha de §4 atribui a sessão de tela ao `shareStar`, e o registro da barreira já declarava o módulo com dependência só do `voiceCoordinator` |
| `memberHasPermission` exportado pelo `voiceCoordinator` em vez de importar `permissions` no `shareStar` | §4 não lista `permissions` nas dependências do `shareStar` e o script da barreira é transcrição literal da tabela — a varredura mora no módulo que depende de `permissions`, que também a usava duplicada |
| Eventos granulares (`started`/`viewersChanged`/`stopped`) por um único callback `onSessionEvent` | mapeamento direto dos eventos de §RPC/§6.16; o fan-out aos destinatários conectados é da composição, como nos fan-outs `VoiceRoster`/`voice.revoked` da fase 7 |
| `degradeTo` como caminho de **sistema**, separado do comando `share.setQuality` (papel espectador no §RPC) | §17.5 define auto-degradação acionada pela saúde; ela não pode passar pelo comando do espectador nem subir perfil — razões nomeadas internas (`gone`/`not-lower`), precedentes das recusas TURN |
| Monitor consome amostras prontas (`rttMs`/`lossPct`) pela entrada `ingest`; RTCStatsReport fica no renderer | núcleo não vê mídia (§17.2); mesma fronteira de `MediaSocketPort`: números medidos entram por porta, medição é de quem possui o transporte |

### 25.2 Limitações que permanecem

| Limitação | O que falta | Quem fecha |
|---|---|---|
| Wiring de produto | handlers RPC `shareStart`/`shareJoin`/`shareLeave`/`shareSetQuality` (o `rpcServer` ainda não existe como diretório L3); roteamento dos eventos `share.*`/`ShareHealth` aos destinatários; **comando que reporte as amostras do renderer do apresentador ao host** (não catalogado no §RPC — lacuna aberta); handler `capture.authorize` no IPC-M | fases seguintes de integração (IPC-R/IPC-M, `app/`) |
| `share.failed{sessionId, reason}` (fecha V-18) | gatilho normativo de "falha" além do encerramento por stop/ban não está especificado | lacuna registrada; decidir na integração com a UI |
| Histerese/subida de qualidade | normativo só define descida automática; recuperação de perfil é comportamento de UI não especificado | deltas-ux antes da UI de produto |
| `openCriteria` do G8 | Chromium empacotado com `getDisplayMedia`/`RTCStatsReport` reais e encoder real; tc/netem; CGNAT; CPU dedicada | G8 empacotado — bloqueia release, não código |

## 26. Fase 9 — relay voluntário: consentimento, chave derivada, prova de posse, TTL e cota (§17.7, A21, R-19): implementação em código 2026-08-21

**Gate de entrada:** G7 confirmado (§29 libera a fase 9). A metade protocolar do relay já
existia no log desde o fold: `relay.volunteer`/`relay.withdraw` (kinds 60/61), verificação
R-19, estado `relays` e tabela `relay_volunteers`; a config L0 já resolvia os defaults de
§27.2 (`relayMaxBytesPerDay` 5 GiB, `relayMaxAllocs` 4, env `P2P_*`). Esta fase entregou o
módulo L2 que faltava — a decisão de quem voluntaria.

| Entrega | Onde | Seção | Teste |
|---|---|---|---|
| Módulo `relay` (L2 sobre swarm/config — nada importado deles: valores e rede chegam por injeção/porta) | `core/src/l2/relay/` | §4 | barreira: `L2:9` |
| Chave derivada da identidade + prova de posse | `keys.ts` (`deriveRelayKeyPair`, `signPossession`) | §17.7, R-19 | `relay-volunteer` — hash local ≡ `opCodec.relayPossessionSigningHash` byte a byte; verificação idêntica à de `apply.ts`; adulterada recusa; seed curta lança |
| Consentimento explícito e **persistido** antes de ligar | porta `RelayConsentPort` (`local_relay_consent`, §6.15) | §17.7 | sem consentimento → `E_CONSENT_REQUIRED` + pedido à UI (`missing`/`declined`); aceito libera; `forgetConsent` volta a exigir; persistência sobrevive "reinício" |
| Ciclo de vida com TTL renovável | `volunteer.ts` (`RelayVolunteer`: enable/renew/disable/sweep/status por comunidade) | §17.7, §RPC | op submetido com chave/expiração/posse corretos e seq devolvido; `renew` com material fresco; `disable` submete withdraw (no-op nomeado sem voluntariado); expirou → não listado, sweep não reemite |
| Cota do TURN restrito | `quota.ts` (`RelayQuota`) + `tryAllocate`/`releaseAllocation`/`recordRelayBytes` | §17.7, §27.2 | teto de alocações recusa e liberar reabre; bytes na cota suspendem e emitem `relay.stateChanged` uma vez; virada da janela de 24 h limpa a suspensão |

### 26.1 Decisões de implementação registradas

| Decisão | Justificativa normativa |
|---|---|
| Domínios BLAKE2b reproduzidos em `keys.ts` em vez de importar `opCodec` | §4 declara só `swarm`/`config` para o `relay` e o script da barreira é transcrição literal; a divergência é impossibilitada por teste que cruza os bytes com o hash que o fold verifica |
| Portas `RelayConsentPort`/`RelaySubmitPort` em vez de importar `view`/`outbox` | mesma não-declaração em §4; padrão das portas estruturais (`MediaSocketPort`, `VoiceStatePort`): persistência do consentimento e submissão dos ops são da composição |
| Suspensão por cota mantém `enabled:true` no `stateChanged` | o voluntariado no log continua (op vivo, TTL correndo); quem "para de aceitar" é o TURN restrito local — desligar é `disable` ou expiração |
| Janela de cota = 24 h a partir do primeiro byte, não dia civil | decisão operacional de §27.2, determinística; não decide interpretação de log |
| `alloc-limit` recusa pontual sem suspender; `bytes-quota` suspende até a janela rolar | §17.7 "para de aceitar": pares já admitidos continuam servidos; liberar alocação reabre admissão imediatamente |
| Consentimento `declined` reemite `consentRequested` no novo `enable` | a UI precisa poder perguntar de novo (delta U-13); `missing` × `declined` diferenciam o texto |

### 26.2 Limitações que permanecem

| Limitação | O que falta | Quem fecha |
|---|---|---|
| Wiring de produto | handlers RPC `relay.enable`/`relay.disable`/`relay.respondConsent`; persistência real de `local_relay_consent` (preferências locais); submissão real via outbox/communityHost; socket UDP do TURN restrito na composição (`MediaServer` sob estes controles) | fases seguintes de integração (IPC-R/IPC-M, `app/`) |
| Seleção de relay por menor RTT | decisão de quem consome (`diag.run{relayAvailable}`), fora do módulo | integração/IPC-R |
| Superfície de consentimento | tela 3.1 → Rede e texto com L-14 (voluntário vê metadados) | deltas-ux/frontend |
| Custo real do voluntário | CPU/banda com tráfego DTLS-SRTP real em alvo dedicado | G7/G9 empacotado (`BENCHMARK REQUIRED`) |

## 27. Fase 10 — sucessão de host: módulo `succession` e evidência parcial do G12 (§18.8, A23, R-17/R-18/R-19): implementação e harness 2026-08-21

**Gate de entrada:** G12 sem evidência prévia. O harness `poc/poc-12-g12` produziu a
evidência parcial que libera a implementação (mesmo padrão G7→fase 7, G8→fase 8): escrow,
grace period, prova de posse, continuação aceita pelo fold real e arbitragem — 6/6 passos
nos dois perfis (`out/gate-G12/gate-G12.json`, quick em `out/gate-G12-quick/`). Interpretação
em `poc/poc-12-g12/REPORT.md`.

| Entrega | Onde | Seção | Teste/evidência |
|---|---|---|---|
| Escrow da semente | `core/src/l2/succession/escrow.ts` (`sealSeedFor`/`openSealedSeed`, Ed25519→X25519 + sealed box) | §18.8 | `succession.test.ts` + S1 do harness — só o alvo abre; intruso/adulterado → null |
| Relógio de inatividade | `watch.ts` (`InactivityWatch`, ttl injetado = `HOST_INACTIVITY_MS`) | §18.8, R-18b | borda do grace period |
| Construção da continuação | `continuation.ts` (`planContinuation`: gênese com origin*, assumeHost seq 6 com prova `'assume/1'`, lote estendido de cargos/categorias/canais com previsão de ids via `entityId`) | §18.8 passos 2–6, R-27 | fold REAL aplica tudo sem rejeição; R-18(a) verifica contra a chave pública da ORIGEM |
| Camada b + arbitragem | `follow.ts` (`evaluateLayerB`, `chooseContinuation`, `dispositionFor`) | R-18b, L-16 | prioridade da lista decide; disputed não migra; réplica sem origem segue camada a |
| Evidência G12 | `poc/poc-12-g12` (descartável; importa fold/opCodec/succession compilados) | POC-12 | S1–S6 nos dois perfis |

### 27.1 Emendas aplicadas

| Emenda | Justificativa |
|---|---|
| §4 — dependências de `succession`: `corestore, identity` → `+ fold, opCodec, idgen, permissions` | Sem elas o módulo não existe: ler estado (fold), codificar/assinar os registros da continuação (opCodec), prever os ids de entidade novos (idgen) e recriar cargos com a numeração fechada de §9.1 (permissions). A barreira bloqueou cada importação antes da emenda — transcrição atualizada junto com o normativo |

### 27.2 `ACHADO-G12-01` — buraco de spec: membros não são reconstrutíveis — **resolvido em 2026-08-22, ver §31**

§18.8 passo 6 manda reconstruir membros no lote estendido, mas isso é **inalcançável** com
o catálogo fechado de 38 kinds: a membresia criada por `member.join` é a do próprio autor
do op (estrutura de §7.3/§8.1), a prova de R-9 vincula o communityId NOVO (que o sucessor
não forja para terceiros) e ninguém assina por um terceiro. Medido no harness: a
continuação nasce com exatamente 1 membro (o sucessor); qualquer zero-form adicional é
`E_INVITE_INVALID`. Uma emenda preliminar de R-9-sucessão foi descartada durante a
implementação porque não resolvia o caso de terceiros.

Rotas avaliadas: (i) desacoplar alvo da autoria na forma de sucessão; (ii) transplante
de lote assinado da origem; (iii) convergência assíncrona por convites publicados pelo
sucessor. Detalhes e trade-offs em `poc/poc-12-g12/REPORT.md` §3. **A decisão normativa
saiu em 2026-08-22 — rota (iii) mais a emenda de ban sem membresia; ver §31.**

### 27.3 Decisões de implementação registradas

| Decisão | Justificativa normativa |
|---|---|
| Comunidade encerrada (`community.end`) não tem sucessão | §18.5: end é terminal, zero ops novas, modo histórico — assumir por cima contradiz o estado |
| Duplicatas estruturais mapeiam para as equivalentes (GERAL da gênese × GERAL da origem; canal `geral` sob R-6) | Recriar violaria R-6 nos canais e produziria ruído nas categorias; a correspondência old→new fica explícita nos mapas do plano |
| Ids de entidade previstos com `entityId` antes de cada create | §7.3: ids são determinísticos por `(kind, coreKey, autor, authorSeq)`; prever é obrigatório para o lote referenciar cargos/categorias criados no mesmo lote |
| `observedHostTs` do assumeHost = `lastHostTs` da origem | É o que o sucessor observou ao decidir assumir; a camada b confere o grace period contra o mesmo valor |

### 27.4 Limitações que permanecem

| Limitação | O que falta | Quem fecha |
|---|---|---|
| Convergência de membros | ~~decisão sobre ACHADO-G12-01~~ **decidida em 2026-08-22 (§31)**; falta implementar R-28 no `fold`, os bans no lote estendido de `continuation.ts` e a superfície de reentradas pendentes | fase de integração da sucessão |
| Wiring de produto | Hypercore/swarm reais multi-nó, migração de rail, corrida "host volta durante replicação", manifest §5.3 derivando chaves da semente recuperada | fases seguintes de integração |
| openCriteria empacotados | Electron/utilityProcess; escrow corrompido persistido de verdade; escala de referência | G12 empacotado — bloqueia release, não código |

---

## 28. Fase 11 — busca e diagnóstico: módulos `search` e `diagnostics` (§23, §15.4 `diag.*`, RT-11): implementação em código 2026-08-21

**Gate de entrada:** nenhum gate específico de busca. O G5 (`poc/poc-06-g5/out/gate-G5`)
mediu ownership e caminho de escrita de **anexos** — não FTS5; nenhuma conclusão de busca foi
reaproveitada do relatório porque lá não existe uma. A consulta é pura sobre `view.db`
local, sem rede, e não havia `REQUIRES POC` sobre ela. Com esta fase, a tabela de §4 está
completa em módulos: **12 em L2**, barreira `§4 ok — L0:8 L1:6 L2:12 L3:2`; suíte do core
643 → 665 testes, 0 falha.

| Entrega | Onde | Seção | Teste/evidência |
|---|---|---|---|
| Pipeline de texto puro | `core/src/l2/search/text.ts` (`normalizeText`, `tokenize`, `buildFtsMatch`) | §23.1, DR-39 | `search.test.ts` — diacríticos; tokens de 1 caractere descartados; operadores FTS5 (`AND`/`OR`/`NOT`/`NEAR`/`*`/`:`) viram literais citados; aspas interna duplicada; prefixo só no último token |
| Consulta FTS5 sobre `CS` | `service.ts` (`SearchService`) | §23.1–§23.3, §15.6 | recência (`seq DESC`); exclusões (`deleted_at`/`hidden_by_ban`/`orphaned`/canal de voz); escopo antes dos filtros; `date` sobre `host_ts`; `kind` attachment/pinned/link; tetos 20→100; isolamento por comunidade; canais/membros só ao texto |
| Diagnóstico assíncrono | `core/src/l2/diagnostics/index.ts` (`Diagnostics`) | §4, §15.4 | `diag.run` → `{natType, peerCount, relayAvailable, stunReachable, ranAt}` exato; sondas em paralelo; estouro de prazo e rejeição absorvidos; `diag.snapshot` passa a métrica de §24.3 |

### 28.1 Decisões de implementação registradas

| Decisão | Justificativa normativa |
|---|---|
| `snippet` derivado em JavaScript de `messages.content`, não via `snippet()` do FTS5 | `messages_fts` é **contentless por norma** (`content=''`, §10.3): o índice não guarda texto, e `snippet()` nele devolve NULL. Janela fixa com reticências; apresentação fina fica para a UI |
| Canais/membros casam por substring sobre a mesma normalização da etapa 1; tokens de 1 caractere valem para os três grupos | "A mesma função do frontend" (§23.1), transcrita de `frontend/src/features/search/searchIndex.ts`; paridade de comportamento entre mock e núcleo |
| Membros pesquisados = roster ativo (`left_at IS NULL AND banned = 0`), rótulo `nickname ?? displayName` | O índice `idx_members_active` existe para esta enumeração (§10.3); banidos têm superfície própria (§18) |
| `partial`/`partialReason` são **ecoados** da composição, nunca derivados aqui | As quatro causas de RT-11 (§14.5) são estado de replicação/host que `view.db` sozinha não conhece; inventar causa local seria comportamento fora da spec |
| `CHANNEL_TYPE_VOICE = 1` repetido localmente em vez de importar `fold` | §4 não declara `fold` como dependência de `search` e a barreira bloquearia; `channels.type INT` é forma de armazenamento de `CS` |
| `diagnostics` não importa um registro central de métricas — declara a porta `DiagnosticsMetricsPort` | O módulo `metrics` (L0) ainda não existe como código: contadores vivem nos detentores de estado (fold/projector/outbox/host). Criar registro central nesta fase sairia do escopo declarado |
| Falha ou estouro de prazo de sonda **não rejeita**: `stunReachable=false` e `natType='cgnat'` (pior caso assumido) | §15.4 não cataloga erro para `diag.run` — o comando sempre responde; conservadorismo evita otimismo de conectividade |
| Sondas NAT/STUN em portas injetadas, corridas em paralelo sob teto configurável; timer referenciado e limpo no `finally` (sem `unref`) | "Não pode: bloquear o event loop" (§4) — nada síncrono-bloqueante, prazo sempre limita; sem `unref`, o próprio prazo é quem encerra a espera |

### 28.2 Limitações que permanecem

| Limitação | O que falta | Quem fecha |
|---|---|---|
| Wiring IPC-R | `query.search` e `diag.*` expostos ao renderer, montagem das portas no boot | fase de integração |
| Implementações reais das portas de sonda | Probe NAT do HyperDHT, Binding STUN pela socket compartilhada UDX, disponibilidade relay/TURN da instalação | integração L3/composição |
| Números de desempenho de busca | `<30 ms` em 10 k msgs continua hipótese de §26.1 — nada foi medido nesta fase e a UI não anuncia número | G9 |
| Causas `partial` em produção | Dependem de `communityClient`/outbox reais publicando estado de replicação (§14.5) | fases seguintes de integração |

---

## 29. Fase de integração — RPC P2P (§16), superfícies IPC-R (§15.3/§15.4/§15.6) e composição das portas: implementação em código 2026-08-21

**Gate de entrada:** nenhum gate específico — esta fase é a montagem do grafo de §4 ("quem
monta o grafo injeta a implementação no boot") sobre módulos já entregues, com transporte
simulado. Barreira passa para `§4 ok — L0:8 L1:6 L2:12 L3:4`; suíte do core 665 → 678
testes, 0 falha.

| Entrega | Onde | Seção | Teste/evidência |
|---|---|---|---|
| Módulos `rpcServer`/`rpcClient` (L3) | `core/src/l3/rpcServer/`, `core/src/l3/rpcClient/` | §16.1, §16.2 | dois protocolos (`p2p-community/1`, `p2p-admission/1`); teto de frame **antes** do decode (64 KiB / 4 KiB); timeouts 15 s membro / 10 s pré-membro (redeem 30 s); orçamento em voo 8/2; queda e timeout → `E_HOST_UNAVAILABLE` |
| Escrita ponta a ponta | `test/integracao.test.ts` | §11.4–§11.9 | outbox real → `submitOps` por RPC → `HostAdmission` real (group commit) → réplica com Projector/view.db reais interpreta → reconciliação por observação remove os itens |
| Registro de comandos IPC-R | `src/l3/ipcRenderer/commands.ts` (`registerCoreCommands`) | §15.3, §15.4, §15.6 | `diag.run`/`diag.snapshot`; `query.search` (open, com `partialReason` da composição); `relay.enable`/`disable`/`respondConsent` (consentimento REAL em manifest.db); `voice.join`/`leave`/`setSelf`/`muteParticipant`; `share.start`/`join`/`setQuality`/`stop` |
| `voice.muteParticipant` no host | `src/l2/voiceCoordinator/host.ts` | §17.4, §9.1 | decisão de host com `voice_mute_others` via `memberHasPermission`; estado efêmero do roster |
| `currentSessionOf` + métodos de consentimento no manifest | `voiceCoordinator/host.ts`; `l0/manifest/index.ts` | §15.4 (`voice.leave` sem sessionId), §6.15 | sessão corrente do membro ("voz é uma só"); `local_relay_consent` já existia no schema — faltavam os acessores |
| Probe STUN de referência | `test/helpers/composition.ts` (`UdpStunProbe`) | §17.3 | Binding Request RFC 5389 codificado pelo codec do núcleo respondido por um `MediaServer` real sobre UDP de loopback — a junta da porta `DiagnosticsStunPort` exercitada de verdade |

### 29.1 Decisões de implementação registradas

| Decisão | Justificativa normativa |
|---|---|
| `rpcClient` não importa `rpcServer` — tabela de protocolo duplicada com **teste de paridade** | §4 não declara importação lateral entre módulos de L3 e a barreira quebra o build; o teste impede divergência entre as duas cópias |
| Orçamento de requests em voo espera em fila (backpressure), sem recusa | §16.1 declara orçamento, não código de recusa; inventar código fora do catálogo de §20.2 é proibido |
| Timeout sem resposta e queda de conexão viram `E_HOST_UNAVAILABLE` | §16.1 literal — "requests em voo falham com `E_HOST_UNAVAILABLE` e voltam à outbox"; quem decide reenvio é a outbox (§11.6), nunca o transporte |
| `submitOps` devolve um resultado por envelope; só falha de infra interrompe com `E_NOT_ATTEMPTED` nos restantes | §11.9 literal (fecha DS-26) |
| Superfícies de voz/tela atrás da interface `MediaSurfaceDeps` | As decisões são do host (§17.4/§17.5); quando esta instalação não hospeda, o dispatcher remoto sobre `rpcClient` entra pela mesma fronteira sem mudar a forma dos comandos |
| Handshake `hello` exercido no cliente do rig; servidor não bloqueia pré-hello | O fluxo obrigatório é do cliente (§16.2); recusa server-side exigiria código de erro que o catálogo não nomeia |

### 29.2 Limitações que permanecem

| Limitação | O que falta | Quem fecha |
|---|---|---|
| ~~Modo membro de voz/tela via RPC~~ | **implementado em 2026-08-22 — §39** (com duas lacunas de §16.2 registradas lá) | — |
| Superfícies IPC-R da sucessão (`community.setSuccessors`/`assumeHost`) | ~~ponte de submissão assinada de ops na composição~~ (fechada no §30) + criação de gênese via corestore | integração seguinte |
| Transporte real (protomux-rpc sobre Hyperswarm, probe NAT do HyperDHT) | canais em memória cobrem o contrato de §16; sockets reais entram com os gates empacotados | G7/G8/G12 empacotados |
| Handlers de produto para `presencePublish`/`subscribeChannel` no rpcServer | o módulo `presence` (L2) existe; fan-out por conexão depende do transporte real | integração do transporte |
| ~~`file.pickForAttachment`/`blob.*` e `host.exitImpact` no roteador~~ | **implementado em 2026-08-22 — §41** | — |

## 30. Ponte de submissão assinada de ops — caminho de produto "intenção → op codificada → assinatura → envelope → outbox/RPC" 2026-08-22

**Gate de entrada:** nenhum gate específico — item 1 das limitações de §29.2. O caminho
existia só no cabo de teste (`test/helpers/world.ts` `makeRecord`); aqui ele vira produto.
Barreira inalterada (`§4 ok — L0:8 L1:6 L2:12 L3:4`, 63 arquivos); suíte do core
678 → **683 testes, 0 falha**.

| Entrega | Onde | Seção | Teste/evidência |
|---|---|---|---|
| Construtor compartilhado e portas da ponte | `core/src/l2/communityClient/submit.ts` | §7.1, §7.3, §19.3 | `SignedOpCodecPort` (`kindNumber`/`encodePayload`/`sealOp`: Op → encode canônico → BLAKE2b('op/1') → Ed25519 detached → Envelope → `opId`); `authorSeq` reservado **antes** de assinar via `outbox.nextAuthorSeq`; escopo por kind (`channelId` direto → alvo `messageId`/`rootMessageId` no DS → `community`) |
| Caminho A — outbox (§11.1) | `CommunityClient.submitQueued` | §11.1–§11.3, §15.4 Mensagens | sela e enfileira com meta completa de §11.2; resposta imediata `{opId, state:'queued'}`; `E_OUTBOX_FULL` no teto da fila |
| Caminho ⏱ — primitiva síncrona | `CommunityClient.submitSync` + porta `HostSubmitPort` sobre `rpcClient.submitOp` | §11.1, §16.2 | devolve `{seq}` ou `{code}`; recusa antes do append queima o número (§7.5); sem porta de host → `E_HOST_UNAVAILABLE` na hora |
| Validação advisória local (§8.7 ponto 1) | `advisoryCheck` em `submit.ts`, tetos injetados | §8.6, R-14/R-15, R-22, §15.4 | produz só a coluna síncrona de §15.4: `E_VALIDATION{field}` (content/mentions/payload/kind/sequenceScope), `E_CHANNEL_READ_ONLY`, `E_QUOTA_EXCEEDED`, `E_UNKNOWN_KIND`; roda antes de consumir `authorSeq` |
| `message.send` no roteador IPC-R | `src/l3/ipcRenderer/commands.ts` (`MessageSurfaceDeps`) | §15.3 standard, §15.4 Mensagens | perm `send_messages` via recorte do DS (`memberHasPermission`); resposta `{opId, state}`; `E_NOT_FOUND` para comunidade fora do recorte |
| Prova de integração com a ponte real | `test/integracao.test.ts` (`submissionRig`), porta real em `test/helpers/composition.ts` (`opCodecSignPort`, `rpcHostSubmitPort`) | §19.3 passos 1–8 | `makeRecord` deixou de ser o caminho de escrita do teste ponta a ponta: `submitQueued` ×4 → flush → HostAdmission real → réplica projeta → reconciliação remove por observação; reconciliação de boot de §7.5 (`max(manifest, log)+1`) exercida no rig |

### 30.1 Decisões de implementação registradas

| Decisão | Justificativa normativa |
|---|---|
| Codec, ids e material de assinatura chegam por **portas injetadas** (`SignedOpCodecPort`, par Ed25519 da identidade, tetos de §8.6/R-14) | §4 não declara `opCodec`, `idgen` nem `identity` nas dependências de `communityClient` — padrão relay (`seed/sk` por parâmetro) e constantes por injeção; a barreira confere. Nenhum módulo novo, nenhuma emenda de §4 |
| Recorte estrutural do DS (`WriteStatePort`) lido pelo `projector` declarado | Mesmo padrão de `VoiceStatePort`: o `DecisionState` satisfaz a porta por estrutura; nada além do recorte é lido |
| A advisória **não duplica o pipeline do `fold`**: confere tetos de campo, R-22 e janela R-14/R-15 sobre o recorte, e o desfecho vinculante continua sendo o `foldRecord` na admissão (§11.4) e em toda réplica | §8.7: validação do cliente é advisória, pode divergir "e divergir é esperado e inofensivo"; os erros síncronos são exatamente os da coluna de §15.4 |
| Permissão de comando (`send_messages`) na fronteira IPC-R; readOnly do canal (`E_CHANNEL_READ_ONLY`) na ponte | Coluna Cl./Perm. de §15.4 para o comando; R-22 depende de canal+alvo, decisão de domínio da ponte |
| Comunidade desconhecida na ponte → `E_NOT_FOUND`; binding incompleto de comunidade conhecida → `E_INTERNAL` | §20.2: estado genérico para "nada local"; `E_INTERNAL` é bug/composição, nunca fluxo esperado |
| Escopo de alvo não resolúvel no DS recusa com `E_VALIDATION.sequenceScope` sem assinar nem consumir número | §7.1: escopo incompatível com o kind/alvo é `E_VALIDATION` no campo `sequenceScope` e não avança o contador |

### 30.2 Limitações que permanecem

| Limitação | O que falta | Quem fecha |
|---|---|---|
| ~~Demais superfícies de mensagem no roteador (`message.edit/delete/pin/react`, `thread.create`, `retry`, `cancelQueued`)~~ | **implementado em 2026-08-22 — §36** | — |
| ~~`community.leave` pela ponte (exceção de §11.1)~~ | **implementado em 2026-08-22 — §37** | — |
| Desfecho por evento até a UI | ~~emissão dos desfechos pela outbox~~ (fechada no §36); falta `messages.appended` **antes** de `message.accepted` (DS-31) — o evento do lote projetado — e o consumo no renderer | integração seguinte |

---

## 31. Decisão normativa do `ACHADO-G12-01` — o roster não migra na sucessão (2026-08-22)

**Contexto.** §27.2 registrou o buraco: §18.8 passo 6 mandava reconstruir membros no lote
de gênese estendido da continuação, e o G12 mediu que isso é inalcançável — a continuação
nasce com exatamente 1 membro. Nenhum código de produto novo foi escrito nesta sessão; o
que mudou foi o normativo.

**Decisão: rota (iii), reentrada assistida, mais a emenda de ban sem membresia.** Os membros
convergem de forma assíncrona por convites publicados pelo sucessor — cada pessoa entra
assinando o próprio `member.join` —, e o sucessor reatribui cargos com `member.setRoles`
conforme as reentradas chegam. Os **bans migram** no lote estendido.

### 31.1 Por que as outras rotas foram descartadas

| Rota | Por que não |
|---|---|
| (i) `member.join` com `targetKey` na forma de sucessão | Reabre `F-06` — §12.4 fixa que "`member.join` é assinado pelo próprio candidato; o host não fabrica autoria" — e quebra a camada (a) de R-18, que é **self-contained** por construção: uma réplica sem a comunidade de origem não tem como conferir se o roster declarado corresponde a ela, então qualquer chave poderia ser publicada como membro de uma "continuação" forjada. Também derruba a propriedade de §12.4 de que `joinProof` é verificável para sempre por toda réplica |
| (ii) Transplante dos envelopes originais | Exige que o `fold` aceite registros com `communityId` de outro core, isto é, core multi-escritor — exatamente o que A23/L-15 já recusou ao decidir que o histórico de mensagens não migra. O argumento não muda por se tratar de membros em vez de mensagens |
| (iii) Reentrada assistida | **Escolhida.** Nenhuma mudança no catálogo de 38 `kind`s nem no modelo de autoria; o custo é convergência eventual e uma superfície de UX para o conjunto pendente |

### 31.2 O furo que a rota (iii) sozinha deixava, e como foi fechado

Sem os bans no log da continuação, um banido da origem entraria pela porta da frente com um
convite de reentrada: a sucessão **lavaria o ban**, e "perda de ban" é critério de
reprovação do G12. Mas `mod.ban` exigia alvo já membro — `core/src/l1/fold/apply.ts` recusa
com `E_NOT_FOUND` —, e na continuação o banido não é membro de nada.

Daí a emenda **R-28**: `mod.ban` passa a admitir alvo que não é membro, criando a linha em
estado `banned` sem passagem por `active`, sem contar em `memberCount` e sem aparecer no
roster. A regra vale para toda comunidade (ban preventivo), não só para continuações —
restringi-la à continuação exigiria uma regra condicional à origem declarada na gênese, sem
ganho de segurança. A hierarquia de §9.3/R-16 continua valendo: sem `topRank` não há
imunidade de cargo, mas Fundador original e host corrente permanecem inatingíveis.

Isso é emenda de regra do `fold` dentro de `opVersion = 2`, sem bump: nada de produto foi
publicado, e o precedente é o mesmo das emendas de §19 e §27.

### 31.3 Onde a emenda foi registrada

| Documento | O que mudou |
|---|---|
| `docs/backend-v2.md` | §18.8 passo 6 (membros saem do lote, bans entram); **§18.8.1** novo, com a decisão, as alternativas descartadas e a justificativa; **L-23** novo em §18.8 e na tabela de limitações; **L-15** deixa de dizer "membros"; **R-28** novo na tabela de regras; R-9 ganha a nota de que vale sem exceção na continuação; §6.3 ganha a aresta `(não-membro) → banned`; §8.4.1 ganha as duas linhas de alvo não-membro; §18.1 detalha o efeito do ban sem membresia |
| `docs/adr-v2.md` | A23 ganha a emenda de 2026-08-22 e passa a citar L-23/R-28 |
| `docs/plano-de-validacao-experimental-v2.md` | G12: hipótese, aprovação e reprovação reescritas — "membros idênticos" vira convergência por reentrada com recuperação de cargos, e "banido da origem que consegue entrar" passa a ser reprovação explícita |
| `docs/deltas-ux-v2.md` | U-18 ganha a terceira superfície (reentradas pendentes) e o texto obrigatório passa a dizer que as pessoas precisam entrar de novo |
| Código | Só comentários e nome de teste em `core/src/l2/succession/continuation.ts` e `core/test/succession.test.ts`, que diziam "até decisão normativa" |

### 31.4 O que ficou pendente de implementação

| Pendência | Onde | Quem fecha |
|---|---|---|
| ~~R-28 no `fold`~~ | **implementado em 2026-08-22 — §32** | — |
| ~~Bans no lote estendido da continuação~~ | **implementado em 2026-08-22 — §33** | — |
| Convites de reentrada e reatribuição de cargos pelo sucessor | `succession` + superfície IPC-R | mesma fase |
| Superfície de reentradas pendentes (U-18c) | `frontend/` | fase de UI da sucessão |

---

## 32. R-28 no `fold` — ban sem membresia: implementação em código 2026-08-22

**Gate de entrada:** nenhum gate novo — R-28 é regra de `fold`, dentro do escopo do G1. É a
primeira das pendências de §31.4, e a única que a decisão do `ACHADO-G12-01` tornou
**obrigatória**: até aqui o normativo dizia que `mod.ban` aceita não-membro e o código
recusava com `E_NOT_FOUND`. Barreira inalterada (`§4 ok — L0:8 L1:6 L2:12 L3:4`, 63
arquivos); suíte do core 683 → **692 testes, 0 falha**.

| Entrega | Onde | Seção | Teste/evidência |
|---|---|---|---|
| Ban sem membresia | `core/src/l1/fold/apply.ts` (`banSemMembresia`, chamado por `modBan` quando o alvo não está no `DS`) | R-28, §18.8.1 | linha nasce em `banned` com `roleIds` vazio, `bannedAt`/`bannedBy` e `preBan`; efeitos = `upsert members` (`banned: 1`) + `upsert bans` + `notify` + `audit` |
| Marca `preBan` no `DS` | `core/src/l1/fold/state.ts` (`Member.preBan`) e `core/src/l1/projector/snapshot.ts` (serializa e desserializa) | R-28, §8.1 | round-trip de snapshot preserva a marca e o `serializeDs` é estável |
| `joinedAt` do join posterior | `apply.ts` (`memberJoin`) | R-28, §6.3 | depois de `mod.revokeBan`, a adesão é a do `member.join`, não o instante do ban |
| Alvo sem hierarquia | `core/src/l1/fold/targets.ts` (comentário; nenhuma mudança de comportamento) | §9.3, R-16 | imunidade de Fundador original e host corrente é resolvida **antes** da busca no `DS`, então continua valendo; alvo inexistente simplesmente não tem `topRank` |
| Projeção | nenhuma mudança no `projector` | §8.4 | o `upsert` já materializa a linha; `member_count` é `SELECT COUNT(*)` com `left_at IS NULL AND banned=0`, então o ban preventivo não o move |
| Testes | `test/fold-rules.test.ts` (bloco R-28, 8 casos), `test/projector.test.ts` (projeção + snapshot) | §28.1 | inclui o caso de §18.8.1: o pré-banido tenta reentrar por convite e leva `E_BANNED` |

### 32.1 Decisões de implementação registradas

| Decisão | Justificativa normativa |
|---|---|
| A linha nasce com `displayName` = fragmento de 8 hex da chave, `avatarColor` 0 e sem `blobsCoreKey` | Não há nome a congelar: §6.13 pede o rótulo do momento da aplicação, e `labelOf` já usa o mesmo fragmento para quem não é membro. Core de blobs só existe para quem publicou um `member.join` |
| Campo `preBan` no `Member`, e não inferência a partir de `state`/`roleIds` | O `fold` é determinístico e o `DS` entra no snapshot: heurística ("banido sem cargo e sem `leftAt`") divergiria entre réplicas na primeira exceção. A marca é explícita, serializada e some no `member.join` seguinte |
| Sem `recount` de `memberCount`, sem `hideMessagesOf` e sem `revokeInvitesOf` no caminho preventivo | §8.4: a população do contador é `left_at IS NULL AND banned = 0` — quem nunca esteve `active` nunca foi contado. Mensagens e convites exigem membresia para existir, então R-10 não tem o que revogar |
| Só o **ban** ganhou forma sem membresia | §8.4.1: `kick`, `timeout` e os dois inversos continuam `E_NOT_FOUND` — expulsar, silenciar ou desfazer sobre quem não está dentro não tem significado |
| `targets.ts` não mudou de comportamento | R-16 é resolvida antes da busca no `DS`, então Fundador original e host corrente seguem inatingíveis; o resto da hierarquia compara `topRank`, que um não-membro não tem. A permissão `ban_members` continua sendo exigida no estágio 13 |

### 32.2 O que continua pendente

| Pendência | O que falta | Quem fecha |
|---|---|---|
| ~~Convites de reentrada e reatribuição de cargos~~ | **implementado em 2026-08-22 — §34** | — |
| Superfície de reentradas pendentes (U-18c) | `frontend/`; o dado já sai de `SuccessionService.pendingReentry` | fase de UI da sucessão |

---

## 33. Bans no lote estendido da continuação: implementação em código 2026-08-22

**Gate de entrada:** R-28 no `fold` (§32). É o passo 2 de §31.4 e a metade que faltava da
decisão do `ACHADO-G12-01`: o roster não migra, mas a moderação sim. Barreira inalterada
(`§4 ok — L0:8 L1:6 L2:12 L3:4`, 63 arquivos); suíte do core 692 → **694 testes, 0 falha**.

| Entrega | Onde | Seção | Teste/evidência |
|---|---|---|---|
| Bans da origem no lote | `core/src/l2/succession/continuation.ts` — laço final sobre `origin.members` com `state === 'banned'`, um `mod.ban` por alvo | §18.8.1, R-28 | `succession.test.ts`: o banido da origem nasce `banned` na continuação, com `preBan`, fora do roster |
| `bannedTargets` no plano | mesmo arquivo (`ContinuationPlan`) | §18.8 passo 6 | o conjunto rebanido é exatamente o conjunto banido da origem |
| Prova de que a reentrada não lava o ban | `succession.test.ts` | §18.8.1, L-23 | sucessor publica o convite de reentrada, o banido tenta usá-lo e o `fold` REAL recusa com `E_BANNED`; o roster continua com 1 |

### 33.1 Decisões de implementação registradas

| Decisão | Justificativa normativa |
|---|---|
| A **razão** do ban não migra | §8.1 guarda `bannedAt`/`bannedBy` no `DecisionState`; o texto vive só em `bans.reason` da projeção (§10.3), que o builder não lê. O ban chega sem motivo declarado, e é isso que a auditoria da continuação registra |
| O sucessor nunca é alvo do lote de bans | R-16: ninguém é alvo de `mod.*` sobre si mesmo, e ele é o host corrente da continuação. Se constava banido na origem, quem decide se podia assumir é a camada (b) de R-18, não este lote |
| Os bans entram **depois** da estrutura | Ordem sem efeito no `fold` — `mod.ban` não referencia cargo, categoria nem canal —, mas mantém o lote legível: primeiro o que a comunidade é, depois o que ela recusa |
| `novoMembros` nos testes passou a contar só `active` | A linha em `banned` existe no `DS` por R-28 e **não** é roster: contá-la faria o teste de L-23 medir a coisa errada |

### 33.2 O que continua pendente

| Pendência | O que falta | Quem fecha |
|---|---|---|
| ~~Convites de reentrada e reatribuição de cargos~~ | **implementado em 2026-08-22 — §34** | — |
| ~~Superfícies IPC-R da sucessão~~ | **implementadas em 2026-08-22 — §34** | — |
| Superfície de reentradas pendentes (U-18c) | `frontend/`; o dado já sai de `SuccessionService.pendingReentry` | fase de UI da sucessão |

---

## 34. Sucessão ponta a ponta: serviço, superfícies IPC-R e reentrada assistida 2026-08-22

**Gate de entrada:** G12 parcial (§27) mais a decisão do `ACHADO-G12-01` (§31) e as duas
implementações que ela obrigou (§32, §33). Fecha os passos 3 e 4 de §31.4 e o item de
sucessão de §29.2. Barreira `§4 ok — L0:8 L1:6 L2:12 L3:4` (63 → **64 arquivos**); suíte do
core 694 → **708 testes, 0 falha**.

| Entrega | Onde | Seção | Teste/evidência |
|---|---|---|---|
| Derivação de §5.3 em código | `core/src/l0/corestore/index.ts` (`deriveCommunityKeyPairs`) | §5.3 | `logKeyPair`/`blobsKeyPair` por `BLAKE2b('ns/log/1' ‖ seed)` e `'ns/blobs/1'`; é o que torna a comunidade recuperável pela semente do escrow |
| Serviço de sucessão | `core/src/l2/succession/service.ts` (`SuccessionService`) | §18.8, §15.4 | designação com escrow, assunção com camada b, reentrada assistida — tudo sobre o `fold` REAL nos dois lados |
| `community.setSuccessors` | `service.ts` + roteador | R-17, §18.8, §15.4 | appenda a lista **e um `community.escrow` por sucessor**; só o alvo abre a semente; não-host → `E_NOT_HOST` sem gastar op |
| `community.assumeHost` | `service.ts` + roteador | R-18, §18.8 | camada b (sucessor, grace period, origem viva) → escrow aberto → par antigo derivado da semente → `planContinuation` → core novo pela porta; devolve `{newCommunityId, seq: 6}` |
| Superfícies no IPC-R | `core/src/l3/ipcRenderer/commands.ts` | §15.3, §15.4 | `setSuccessors` standard, `assumeHost` **main-confirmed** — sem `authToken` o comando nem chega ao serviço; hex fora de forma é `E_VALIDATION` na fronteira |
| Reentrada assistida | `service.ts` (`pendingReentry`, `restoreRolesFor`) | L-23, §18.8.1 | pendentes = ativos da origem que ainda não voltaram; quem volta recupera os cargos por nome; `query.community` ganha `pendingReentry` no normativo |
| Testes | `core/test/succession-service.test.ts` (14 casos) | §28.1 | designação, recusas de R-17/R-18, continuação aplicada pelo `fold` real, reentrada com convite real e a fronteira IPC-R |

### 34.1 Decisões de implementação registradas

| Decisão | Justificativa normativa |
|---|---|
| Submissão ⏱, criação do core novo e leitura do escrow entram por **porta injetada** | §4 não declara `communityClient` nem `invites` como dependência de `succession`; é o mesmo padrão de `relay` e da ponte de §30. Nenhuma emenda de §4 foi necessária |
| A porta `sealedSeedFor` lê o `wrappedSeed` do **log**, não do `DS` | §8.1 não guarda escrow: `community.escrow` é registro sem efeito no `DecisionState` (o handler do `fold` diz isso explicitamente). Quem precisa dele relê o próprio log |
| `deriveCommunityKeyPairs` mora em `corestore` (L0), não em `succession` | §5.3 é ciclo de vida de core, e `community.create` vai reusar a mesma função quando o caminho de criação entrar. Derivar chave não é decidir o que appendar (§4) |
| A assunção confere que a semente do escrow **reproduz** o `communityId` da origem | Escrow de outra comunidade, ou semente corrompida, produz par que não bate: recusa como `E_SUCCESSION_DENIED` antes de montar plano nenhum |
| `setSuccessors` recusa lista com repetição, com a própria chave do host ou acima de `MAX_SUCCESSORS` | §18.8 fixa o teto de 5 e a ordem como prioridade; sucessor de si mesmo não é sucessão, e repetido desperdiça posição na lista |
| Um escrow que falha interrompe e devolve o `code` | A lista já entrou no log: seguir em silêncio deixaria um sucessor designado e incapaz de assumir. O desfecho é parcial e **nomeado** |
| Cargos da reentrada casam por **nome**, não por id | Ids de entidade são determinísticos por `(kind, coreKey, autor, authorSeq)` (§7.3) e mudam com o core novo. É a mesma correspondência que o lote estendido já usa para categorias e canais duplicados |
| O cargo **Fundador não é restaurado** a quem reentra | Na continuação o fundador é o sucessor (R-27). Devolver as 17 permissões e o `RANK_TOP` a quem tinha o cargo na origem — o host antigo, tipicamente — entregaria a comunidade a quem sumiu por `HOST_INACTIVITY_MS`. Quem quiser esse poder de volta recebe por `member.setRoles` explícito do host novo |
| Reentrada sem nada além do cargo base não vira op | R-3 já dá o base no `member.join`; uma op que só reafirma o base gastaria `authorSeq` e uma entrada de auditoria sem mudar estado |
| Nenhum comando novo de convite | O convite de reentrada é o `invite.create` que §15.4 já define, com `maxUses` do tamanho do conjunto pendente. Inventar superfície fora da tabela seria comportamento fora da spec |

### 34.2 O que continua pendente

| Pendência | O que falta | Quem fecha |
|---|---|---|
| ~~Composição das portas de sucessão no produto~~ | **implementado em 2026-08-22 — §35** | — |
| ~~Migração de rail e modo histórico~~ | **implementado em 2026-08-22 — §37** (a descoberta da continuação pelo transporte continua no G12 empacotado) | — |
| ~~`query.community` com `pendingReentry`~~ | **implementado em 2026-08-22 — §37** (recorte com fonte real; campos sem subsistema ficam ausentes) | — |
| Superfície de reentradas pendentes (U-18c) | `frontend/` | fase de UI da sucessão |
| G12 empacotado | Electron/utilityProcess, swarm multi-nó, corrida "host volta durante replicação" | gate empacotado |

---

## 35. Composição das portas de sucessão no produto: implementação em código 2026-08-22

**Gate de entrada:** G12 parcial (§27) com a decisão do `ACHADO-G12-01` (§31) e suas
implementações (§32–§34). Fecha o item 1 de §34.2: as quatro portas de `SuccessionDeps`
deixam de ser implementadas pelo cabo de `succession-service.test.ts` e passam a ser
compostas dos módulos de produto — a ponte de §30, o `corestore`, o log da origem e o
`manifest`. Nenhum módulo novo em `src/`; barreira inalterada (`§4 ok — L0:8 L1:6 L2:12
L3:4`, 64 arquivos); suíte do core 708 → **709 testes, 0 falha**. Harness do G12
rebuildado e reexecutado nos dois perfis (6/6; artefatos locais regenerados).

| Entrega | Onde | Seção | Teste/evidência |
|---|---|---|---|
| Fábricas das quatro portas sobre módulos reais | `core/test/helpers/composition.ts` — `manifestCommunitySeedPort`, `logEscrowPort`, `corestoreContinuationCorePort`, `bridgeSubmitSyncPort`; `storeCommunitySeed` semeia a linha hospedada de §5.3 | §5.3, §8.1, §11.1, §18.8 | nenhuma decisão de domínio nelas: delegação, leitura e cifra de repouso |
| Sucessão ponta a ponta com core e view reais | `core/test/integracao.test.ts` ("as quatro portas compostas") | R-17/R-18/R-28, L-23, §18.8 | host designa pela ponte real (`outbox → rpcClient → HostAdmission → hypercore em disco`; o `seq` devolvido é o bloco do core); escrow encontrado no log real só pelo alvo; réplica só leitura interpreta os mesmos blocos; grace period aberto e fora-da-lista recusam antes de criar core; assunção cria a continuação **em disco** pelo `corestore` e o `fold` REAL a interpreta inteira via Projector próprio |

### 35.1 Decisões de implementação registradas

| Decisão | Justificativa normativa |
|---|---|
| As fábricas das portas moram no cabo de composição (`test/helpers/composition.ts`), não em módulo novo de `src/` | §4 não declara módulo de composição/boot e criá-lo seria emenda arquitetural sem necessidade agora; é o mesmo padrão das juntas da ponte de §30 (`opCodecSignPort`, `rpcHostSubmitPort`). Quando o boot do utilityProcess existir, injeta estas mesmas formas |
| `communitySeed` lê `communities.community_seed_enc/nonce` e decifra com a Data Key (XChaCha20-Poly1305) | §5.3 passo 2 + §5.4: a semente do host mora cifrada no manifest, nunca em claro; linha ausente, sem semente ou cifra inválida → `null` (o serviço traduz para recusa nomeada) |
| `sealedSeedFor` relê o **log** pelo `CoreHandle` (HostRecord → Envelope → Op), mais recente primeiro | §8.1 não guarda escrow no `DS`: `community.escrow` é registro sem efeito no estado, e quem precisa dele relê o próprio log; comunidade que não é este core ou alvo diferente → `null` |
| `createContinuationCore` usa `createCore` **por chave explícita** (`<dir>/<keyHex>`) e appenda o lote inteiro numa chamada; a comunidade nova é registrada por callback | §5.3 item 5 ("cores abertos por chave explícita, nunca namespace aleatório"); §10.7.1 (um append = barreira do grupo); o registro da comunidade nova (Projector próprio, outbox, cliente) é exatamente o que o boot fará ao receber o cabo |
| A réplica do sucessor abre o mesmo log **somente leitura pela chave pública**, depois da instância do escritor fechar | §5.3 item 5: membro abre core por `{key}`, sem par de escrita; hypercore não admite duas instâncias sobre o mesmo storage, e a cópia de arquivos esbarra na proteção `DEVICE_FILE` — a simulação do swarm fica na herança dos blocos, que é o que a réplica tem |
| O `submitSync` do sucessor fica indisponível (`E_HOST_UNAVAILABLE`) até existir rail para a continuação | Migração de rail é o item seguinte de §34.2; inventar escrita na continuação antes dela seria superfície fora do fluxo de §11.1 |

### 35.2 O que continua pendente

| Pendência | O que falta | Quem fecha |
|---|---|---|
| ~~Migração de rail e modo histórico~~ | **implementado em 2026-08-22 — §37** (a descoberta da continuação pelo transporte continua no G12 empacotado) | — |
| ~~`query.community` com `pendingReentry`~~ | **implementado em 2026-08-22 — §37** | — |
| Superfície de reentradas pendentes (U-18c) | `frontend/` | fase de UI da sucessão |
| ~~Boot do utilityProcess~~ | **implementado em 2026-08-22 — §44**: as fábricas mudaram-se para `src/composition/ports.ts` e o `bootCore` as consome | — |
| G12 empacotado | Electron/utilityProcess, swarm multi-nó, corrida "host volta durante replicação" | gate empacotado |

---

## 36. Demais superfícies de mensagem no roteador e desfecho por evento: implementação em código 2026-08-22

**Gate de entrada:** nenhum gate específico — item 1 de §30.2, sobre a ponte de §30. Fecha
o eixo otimista de A25 no núcleo: as seis ops do domínio de mensagem têm comando IPC-R, e
o desfecho chega por evento de §15.5 emitido pela reconciliação e pelas transições da
fila. Nenhum módulo novo; barreira inalterada (`§4 ok — L0:8 L1:6 L2:12 L3:4`, 64
arquivos); suíte do core 709 → **712 testes, 0 falha**; harness do G12 reexecutado nos
dois perfis (6/6).

| Entrega | Onde | Seção | Teste/evidência |
|---|---|---|---|
| Comandos enfileiráveis restantes | `core/src/l3/ipcRenderer/commands.ts` — `message.edit`, `message.delete`, `message.pin`, **`message.react`**, `thread.create` | §15.4 Mensagens | forma comum (`enfileira`): recorte do DS, coluna Perm., payload direto à ponte, resposta `{opId,state}` |
| `message.retry` / `message.cancelQueued` | mesmo arquivo, via `MessageSurfaceDeps.retryQueued`/`cancelQueued` | §15.4, §11.3 (DS-16), §11.7 (DS-28) | mesmos códigos da outbox na fronteira: `E_NOT_FOUND`, `E_ALREADY_SENT`, `E_AUTHOR_SEQ_OVERTAKEN`; retry reenfileira o MESMO envelope |
| Desfecho por evento | `core/src/l2/outbox/index.ts` — porta `onOutcome` + `resolveTarget` na observação | §15.5, §11.6, DS-31 | `message.accepted{opId, clientRef, messageId, seq, channelId}` emitido **pela reconciliação**; `message.failed{...,terminal}` nas transições para `failed`; `message.dropped{...,reason}` em todo `#drop` |
| Coluna síncrona dos alvos | `core/src/l2/communityClient/submit.ts` (advisory) | §15.4, R-23, R-24 | `E_MESSAGE_DELETED`, `E_CANNOT_EDIT_OTHERS`, `E_REACTION_LIMIT`, `E_THREAD_EXISTS` produzidos do recorte antes de assinar |

### 36.1 Decisões de implementação registradas

| Decisão | Justificativa normativa |
|---|---|
| O comando é **`message.react`**, não `reaction.set` | Tabela de §15.4: o kind da op e o nome do comando são coisas distintas; nada fora da tabela |
| A advisória ganhou os códigos de alvo da coluna síncrona | §15.4 declara esses erros como síncronos vindos da validação advisória (§8.7); os dados já estavam no recorte do DS (`authorKey`, `deletedAt`, `reactionEmojis`, `threadId`) e passaram a ser declarados nele |
| Alvo **tombado** agora resolve escopo para o canal dele; alvo **inexistente** continua não-resolúvel (`E_VALIDATION.sequenceScope`) | Tombado tem canal conhecido — quem nomeia o desfecho é a advisória com `E_MESSAGE_DELETED`; e `message.delete` sobre tombado atravessa a ponte para o fold aplicar idempotente. Inexistente segue a decisão registrada em §30 |
| Coluna Perm. inteira na fronteira | Mesmo padrão do `message.send` de §30: permissões nomeadas via `memberHasPermission`; "própria \| manage_messages" do delete resolvida no recorte; hierarquia (`E_HIERARCHY`) permanece vinculante só no fold |
| `resolveTarget` mora na porta de observação, não dentro da outbox | §4 não dá `opCodec`/`idgen` à outbox; o envelope assinado é a fonte, e quem fornece a observação decodifica — o boot injeta esta mesma forma (`envelopeTargetResolver`) |
| `dropped` é terminal também para retry/cancelamento | §11.3: "os dois únicos estados terminais são removido ou dropped" — cancelar de novo duplicaria o desfecho; ressuscitar violaria a terminalidade. Ambos passam a responder `E_NOT_FOUND` |
| `E_REACTION_LIMIT` só para reação que **acréscima** emoji | R-23 literal: "que estoure é recusada" — reafirmar emoji presente não aumenta o conjunto e não pode estourar |

### 36.2 O que continua pendente

| Pendência | O que falta | Quem fecha |
|---|---|---|
| ~~`community.leave` pela ponte~~ | **implementado em 2026-08-22 — §37** | — |
| ~~`messages.appended` e fan-out completo até a UI~~ | **implementado em 2026-08-22 — §38** (a ligação com o renderer real é do boot) | — |
| ~~Anexo em `message.send` pelo IPC-R~~ | **implementado em 2026-08-22 — §41** (barreira de §13.7) | — |

---

## 37. Saída local, consulta da comunidade e migração de rail: implementação em código 2026-08-22

**Gate de entrada:** nenhum gate específico — fecha os itens restantes de §30.2 (saída),
§34.2/§35.2 (consulta e rail) e §36.2. Barreira inalterada (`§4 ok — L0:8 L1:6 L2:12 L3:4`,
64 arquivos); suíte do core 712 → **715 testes, 0 falha**; harness do G12 reexecutado nos
dois perfis (6/6).

| Entrega | Onde | Seção | Teste/evidência |
|---|---|---|---|
| `community.leave` pela ponte | `core/src/l3/ipcRenderer/commands.ts` + `communityLeavePort` em `test/helpers/composition.ts`; `Outbox.discardForLeave`, `ManifestDb.markCommunityLeft`, `MEMBER_LEAVE_KIND` na ponte | §15.4, exceção única de §11.1, L-22, §11.7 | `{leftLocally, opId, droppedQueued}`; host não sai (`E_HOST_CANNOT_LEAVE`); fila descartada com motivo `'left-community'` e desfecho por evento; a saída sobrevive na fila e é entregue ao host vivo — o roster a registra como `left` |
| `query.community` com `pendingReentry` | `queryCommunityPort` + comando standard no roteador | §15.6 emendado, L-23, U-18c | recorte montado sobre o DS real; `pendingReentry` só existe para continuação **com origem replicada aqui**, e os nomes vêm do roster da ORIGEM |
| Migração de rail e modo histórico | `migrateRail` sobre `dispositionFor` (L2, já existente) | §18.8 passo 5, L-16, S6 | antes do grace → `disputed` e nada entra no cliente; depois → a continuação entra como comunidade ativa e a origem permanece aberta e legível |

### 37.1 Decisões de implementação registradas

| Decisão | Justificativa normativa |
|---|---|
| A orquestração da saída mora na composição, não em L2 | §4 não dá `manifest` a `communityClient`: a ponte apenas aceita o kind no caminho A (`MEMBER_LEAVE_KIND`), e quem coordena fila, `left_at` e swarm é quem detém as três peças — o boot injeta esta mesma forma |
| O `member.leave` enfileira ANTES do descarte da fila | §11.1: "é enfileirado para que os demais membros vejam a saída" — enfileirar depois do descarte o mataria junto; a ordem é a única leitura coerente com `{opId, droppedQueued}` |
| `discardForLeave` toca só `queued`/`failed` | Mesma finalidade de `E_ALREADY_SENT` (§11.7): não há cancelamento que o host possa cumprir sobre item já entregue; o motivo nomeado é `'left-community'`, que já estava na tabela de descartes |
| `query.community` entrega só os campos com fonte real; os demais ficam AUSENTES | Inventar zeros para `unread`/`notificationLevel`/`hostStatus`/`inactiveDays` seria mentir à UI; cada campo ausente tem subsistema próprio pendente e está registrado abaixo |
| `pendingReentry` é presença condicional, nunca array vazio decorativo | §15.6: "só existe quando a comunidade é continuação (`originCommunityId` presente) e a origem está replicada aqui" — a condição literal define a presença do campo |
| `migrateRail` decide, mas não descobre | A descoberta da continuação (quem entrega o core novo à réplica) é do transporte — G12 empacotado; a porta aplica `dispositionFor` por réplica e, migrando, acrescenta a continuação ao cliente SEM soltar a origem (S6: se o host voltar, ela ainda interpreta cauda) |
| `disputed` volta para quem detém estado de UI | §18.8 passo 4 manda a réplica marcar e NÃO migrar, sem rejeitar registro nenhum; o enum de replicação (§14.5) não ganhou valor novo — inventá-lo seria superfície fora da tabela |

### 37.2 O que continua pendente

| Pendência | O que falta | Quem fecha |
|---|---|---|
| Campos restantes de `query.community` | `memberCount`, `unread`, `notificationLevel`, `hostStatus`, `inactiveDays`, `iconEmoji?`, `partialInterpretation` aguardam seus subsistemas (fiação de §6.15 na consulta, DR-29, preferências LS) | fases seguintes |
| Descoberta da continuação pelo transporte | DHT/swarm multi-nó apontando réplicas para a comunidade nova | G7/G8/G12 empacotados |
| Boot do utilityProcess | consumidor das portas desta seção (`communityLeavePort`, `queryCommunityPort`, `migrateRail`) | integração do transporte |
| Superfície U-18c no frontend | o dado já chega via `query.community.pendingReentry` | fase de UI da sucessão |

---

## 38. Evento do lote projetado e fan-out IPC-R: implementação em código 2026-08-22

**Gate de entrada:** nenhum gate específico — item 2 de §36.2. Fecha `DS-31` no núcleo: o
evento de §15.5 passa a ser do **lote projetado**, e existe um único ponto por onde
projector e outbox entram no `IpcServer`. Um módulo novo em L3 (`ipcRenderer/fanout.ts`);
barreira inalterada em módulos (`§4 ok — L0:8 L1:6 L2:12 L3:4`), 64 → **65 arquivos**;
suíte do core 715 → **721 testes, 0 falha**; harness do G12 reexecutado nos dois perfis
(6/6).

| Entrega | Onde | Seção | Teste/evidência |
|---|---|---|---|
| Agregação do lote no projector | `core/src/l1/projector/index.ts` — `coalesceBatch`, aplicada na emissão pós-commit | §15.5, §10.5 passo 5, §10.7, DR-27 | um `messages.appended` por canal por lote, `fromSeq` mínimo, `toSeq` máximo, `hasMention` por disjunção; `members.changed`/`roles.changed`/`community.changed`/`message.updated` por união; faixas contíguas e sem sobreposição com `batch: 3` |
| Ordem `messages.appended` → `message.accepted` | mesma emissão: commit de `observed_ops` e `onEvent` no MESMO passo síncrono | §11.6 regra 2, DS-31 | reconciliação antes de projetar não aceita nada; depois do lote aceita, com `seq` observado na réplica, e o fio mostra `messages.appended` antes de `message.accepted` — projector, `view.db`, `manifest.db` e outbox reais |
| Fan-out IPC-R | `core/src/l3/ipcRenderer/fanout.ts` — `EventFanout.fromProjector` / `fromOutbox(communityId)` | §15.1 regras 2 e 5, §15.5 | filtro casa pela **rota**, não pelo payload; `message.accepted` chega à assinatura da comunidade certa sem ganhar `communityId` no dado; filtro que o evento não sabe responder não casa |

### 38.1 Decisões de implementação registradas

| Decisão | Justificativa normativa |
|---|---|
| Quem agrega o lote é o **projector**, não o `fold` | §8.0: o `fold` vê um registro por vez e não sabe onde o lote termina. §15.5 declara `fromSeq`/`toSeq` e listas — formas de lote. §10.5 passo 5 põe a emissão depois do commit, e é ali que o recorte do lote existe |
| A chave da agregação é o alvo que o próprio payload de §15.5 nomeia (`channelId`, `messageId`), nunca um predicado novo | O projector "não decide nada" (§8.4): a tabela de §15.5 já diz por qual alvo cada evento é indexado. É o "delta agregado do projetor" de `DR-27`, agora com forma |
| Regra de merge fixa: `fromSeq` mínimo, `toSeq` máximo, lista por união, booleano por disjunção | É a única regra que não perde sinal. Evento é sinal para reconsultar (§15.1 regra 5): agregar reduz contagem de sinais, nunca estado — e alivia a janela `IPC_SUB_WINDOW`, que um lote de 256 registros do mesmo canal estouraria |
| `DS-31` fica fechado por **estrutura**, sem gatilho novo de reconciliação | §11.6 lista os três gatilhos da reconciliação (boot, `host.cameBack`, `OUTBOX_RECONCILE_MS`); acrescentar "depois de cada lote" seria superfície fora da spec. A ordem já cai do fato de o commit de `observed_ops` e a emissão estarem no mesmo passo síncrono: nenhuma reconciliação enxerga a op antes do evento do lote que a projetou |
| A comunidade viaja como **rota**, ao lado do payload | §15.5 fixa `message.accepted{opId, clientRef, messageId, seq, channelId}` — sem `communityId`. Acrescentá-lo ao dado para poder filtrar seria inventar superfície; o filtro de §15.1 regra 2 casa contra a rota |
| Filtro que o evento não sabe responder **não** casa | Entregar seria vazar sinal de outra comunidade para uma assinatura recortada. O custo do inverso é um sinal a menos, que §15.1 regra 5 já cobre com `evStale` e requery |
| `EventFanout` recebe a forma estrutural `{topic, data}`, sem importar `ProjectedEvent` | §4 dá a `ipcRenderer` só `L2`: importar o `projector` (L1) quebraria a barreira. A forma comum é estrutural, e é o boot que liga as duas pontas |
| O teste antigo de §10.7 passou a exigir a faixa do lote | Não é ajuste para "fazer passar": a expectativa "um evento por mensagem" era a leitura anterior de §15.5, e a coluna "Dispara: Lote projetado" é o que o teste agora afirma — com faixas contíguas, provando que nenhuma mensagem fica sem sinal |

### 38.2 O que continua pendente

| Pendência | O que falta | Quem fecha |
|---|---|---|
| ~~Ligação do fan-out no boot~~ | **implementada em 2026-08-22 — §44**: `bootCore` aponta `Projector.onEvent` e `Outbox.onOutcome` para o mesmo `EventFanout` | — |
| Eventos sem produtor em código | `presence.changed`, `typing.changed`, `unread.changed`, `host.statusChanged`, `swarm.changed`, `community.replication` e os de mídia/blob dependem dos subsistemas correspondentes | fases seguintes |
| `structure.changed` com `channels[]`/`categories[]` | o `fold` emite `{}`; §15.5 declara as duas listas | quando a UI precisar do recorte |
| Consumo no renderer | o mock do `frontend/` não assina IPC-R | fase de UI |

---

## 39. Modo membro de voz e tela: dispatcher remoto sobre §16.2 2026-08-22

**Gate de entrada:** nenhum gate específico — item 1 de §29.2. As superfícies de voz e tela
já estavam atrás de `MediaSurfaceDeps` desde §29, mas só existia o modo host: quem não
hospeda não tinha por onde perguntar. Agora a mesma fronteira tem dois dispatchers, e o
roteador não sabe em qual modo está. Um módulo novo em L3 (`ipcRenderer/media.ts`);
barreira inalterada em módulos (`§4 ok — L0:8 L1:6 L2:12 L3:4`), 65 → **66 arquivos**;
suíte do core 721 → **727 testes, 0 falha**; harness do G12 reexecutado nos dois perfis
(6/6).

| Entrega | Onde | Seção | Teste/evidência |
|---|---|---|---|
| `MediaDispatcher` — uma fronteira, dois modos | `core/src/l3/ipcRenderer/media.ts`; `MediaSurfaceDeps` reduzida a `{dispatcher}` | §15.4, §17.4/§17.5, §4 | os handlers de `voice.*`/`share.*` do roteador deixaram de conhecer `VoiceHostSessions`/`ShareHostSessions`; a suíte de modo host de §29 passa sem mudança de comportamento |
| Dispatcher local (modo host) | `localMediaDispatcher` | §17.4, §17.5 | extração do que já existia no roteador: recorte do DS, identidade local, sessão do roster vivo |
| Dispatcher remoto (modo membro) | `remoteMediaDispatcher` sobre `RpcCallPort` | §16.2, §16.1 | `voice.join`/`leave`/`setSelf` e `share.start`/`join`/`stop` atravessam `RpcClient`↔`RpcServer` reais; a recusa do host chega com o código do catálogo, sem tradução (`E_CHANNEL_NOT_VOICE`, `E_ALREADY_SHARING`, `E_SESSION_GONE`) |
| Estado de sessão client-side (LS) | mesma função, `currentSessionId`/`forgetSession` | §29.2, §15.4, §17.4 | nasce no `voiceJoin`, morre no `voiceLeave`, e some em `E_SESSION_GONE`/`E_HOST_UNAVAILABLE`; sem sessão, `voice.setSelf` recusa **sem** tocar a rede |
| Codec de fio dos tickets | `mediaWire` (mesmo codec nos dois lados) | §16.2, §17.4 | o ticket Ed25519 devolvido por `voiceJoin` é verificado com `verifyMediaTicket` **depois** da travessia — um byte perdido em `peerA`/`peerB`/`sig` reprova |
| Lado host dos métodos de mídia | `wireHostMediaRpc` em `test/helpers/composition.ts` | §16.2 | a identidade do chamador é fechada no registro, por conexão, e nunca lida do corpo do pedido |

### 39.1 Decisões de implementação registradas

| Decisão | Justificativa normativa |
|---|---|
| O dispatcher é **assíncrono nos dois modos** | Em modo membro cada superfície é um round-trip de §16.2. Se a fronteira fosse síncrona no modo host e assíncrona no membro, a forma de §15.4 mudaria com o modo — que é exatamente o que §29.1 dizia não poder acontecer |
| A porta de RPC é declarada **estruturalmente** (`RpcCallPort`), não importada | §4 não autoriza importação lateral entre módulos de L3 — é a mesma razão pela qual `rpcClient` não importa `rpcServer`. O `RpcClient` satisfaz a forma, e quem monta o grafo injeta |
| A identidade do chamador vem da **conexão**, nunca do corpo | O `RpcServer` é por conexão e é a conexão que autentica o par; ler `memberKeyHex` do pedido deixaria um membro se declarar outro. Fecha a mesma classe de `T-15` que os tickets fecham na mídia |
| `share.stop` viaja como `shareLeave` | §16.2 não tem `shareStop`; §17.5 e o módulo host já dizem que o apresentador que sai encerra a sessão inteira. Usar o método existente é seguir a tabela; acrescentar um método seria mudá-la |
| A sessão local morre também em `E_HOST_UNAVAILABLE` | §16.1 declara que queda e timeout são indistinguíveis para o cliente. Guardar uma sessão cuja existência depende de um host que não responde é afirmar o que não se sabe; o custo de esquecer é um `voice.join` a mais |
| `voice.muteParticipant` e `share.setQuality` **recusam** em modo membro | Nenhum dos dois tem método em §16.2, e `rpcServer` trata a tabela como fechada (recusa registro fora dela). A recusa é `E_UNKNOWN_COMMAND`, que já é a convenção do roteador para superfície não composta nesta instalação — inventar método de RPC ou código de erro seria mudar superfície normativa |
| `share.start` em modo membro devolve `{sessionId}` sem `captureToken` | §16.2 declara a resposta do host como `{sessionId}`; o cliente não fabrica token que o host não mandou. A divergência com §15.4 está na lacuna 3 abaixo |

### 39.2 Lacunas de especificação abertas (§16.2 × §15.4)

> **Fechadas em 2026-08-22 — §40.** As três foram levadas a decisão e o normativo foi
> emendado. A tabela abaixo fica como registro do que estava aberto.

Nenhuma foi contornada em código: as três estão declaradas na fronteira e cobertas por teste
como recusa ou ausência de campo.

| # | Lacuna | Efeito hoje | O que a spec precisa decidir |
|---|---|---|---|
| 1 | `voice.muteParticipant` é comando de §15.4 (`voice_mute_others`) e **não tem método** em §16.2 | em modo membro, `E_UNKNOWN_COMMAND` | L-12 diz que silenciar é conselho ao cliente do alvo, e só o host alcança o alvo: ou §16.2 ganha o método, ou §15.4 declara o comando como exclusivo do modo host |
| 2 | `share.setQuality` é comando de §15.4 (papel espectador) e **não tem método** em §16.2 | em modo membro, `E_UNKNOWN_COMMAND` | §17.5 põe o efeito no `RTCRtpSender` do apresentador, e o pedido do espectador precisa chegar até ele; hoje não há caminho |
| 3 | `shareStart` responde `{sessionId}` em §16.2 e `{sessionId, captureToken}` em §15.4 | em modo membro o campo simplesmente não vem | T-41 exige `captureToken` antes de `getDisplayMedia`; ou §16.2 passa a devolvê-lo, ou §17.4 declara que o token é cunhado localmente para uma sessão que o host já autorizou |

### 39.3 O que continua pendente

| Pendência | O que falta | Quem fecha |
|---|---|---|
| ~~Escolha do modo no boot~~ | **implementada em 2026-08-22 — §44**: `bootCore` escolhe por `manifest.communities.is_host` | — |
| ~~As três lacunas de §39.2~~ | **decididas em 2026-08-22 — §40** | — |
| `voiceTicket` (renovação de §17.4) | o método existe em §16.2, mas §15.4 não tem comando que o acione; a renovação a cada `MEDIA_TICKET_TTL_MS` não tem dono declarado | spec + integração de mídia |
| `voice.signal` | está em §15.4 e em §15.5, sem método em §16.2 e sem implementação; o transporte da sinalização SDP/ICE não está declarado | spec |
| Handlers de mídia em produto no `rpcServer` | hoje o lado host vive no cabo de composição; em produto precisa da cópia com teste de paridade, como a tabela de protocolo | integração do transporte |
| `IpcClient.request` deixa o timer de 30 s sem `clearTimeout` | defeito pré-existente do cliente de teste: cada arquivo de teste que usa IPC-R paga ~30 s de processo vivo depois do último pedido | limpeza de L3 |

---

## 40. As três lacunas de §39.2, decididas: emenda de §16.2 e do §17.4 2026-08-22

**Gate de entrada:** nenhum gate específico — §39.2. Autorização explícita para emendar o
normativo, com a condição de que cada mudança se sustente como decisão de engenharia.
Barreira inalterada (`§4 ok — L0:8 L1:6 L2:12 L3:4`, 66 arquivos); suíte do core 727 →
**729 testes, 0 falha**; harness do G12 reexecutado nos dois perfis (6/6).

Duas das três viraram método novo em §16.2; a terceira **não** virou campo novo — virou uma
clarificação que tornou o campo desnecessário no fio. É a diferença que importa: só se
acrescenta superfície quando não existe leitura coerente sem ela.

| Entrega | Onde | Seção | Teste/evidência |
|---|---|---|---|
| §16.2 ganha `voiceMute` | `docs/backend-v2.md` §16.2; as duas cópias da tabela de protocolo (`rpcClient`, `rpcServer`) | §16.2, §15.4, §17.4 L-12 | `voice.muteParticipant` atravessa em modo membro e o efeito é a marca no roster do host; sem sessão local não sai da máquina (`E_SESSION_GONE`); o teste de paridade das duas tabelas cobre a adição |
| §16.2 ganha `shareQuality` | idem | §16.2, §15.4, §17.5 | `share.setQuality` do espectador atravessa e o perfil fica registrado no host — que é de onde `share.health` tira o `quality` por espectador |
| §17.4: `captureToken` é capacidade **local** | `docs/backend-v2.md` §17.4; `remoteMediaDispatcher`/`localMediaDispatcher` | §17.4 `T-41`, §15.7, §16.2 | o token é cunhado no núcleo do apresentador quando o host autoriza a sessão; `capture.authorize{sessionId}` resolve contra o estado local; `share.stop` encerra a capacidade junto com a sessão |

### 40.1 Decisões e por que são estas

| Decisão | Justificativa de engenharia | Justificativa normativa |
|---|---|---|
| `voiceMute{sessionId, targetKey, muted}` é método próprio, e não uma extensão de `voiceState` | `voiceState` é sobre **si mesmo** e não tem alvo; sobrecarregá-lo com um `targetKey` opcional faria um método com duas autorizações diferentes (nenhuma × `voice_mute_others`) — a pior forma de esconder uma decisão de permissão | §15.4 já separa `voice.setSelf` de `voice.muteParticipant`; o transporte espelha a separação que a superfície tem |
| O silenciamento **não** ganhou evento novo | O efeito de L-12 é uma marca no roster, e o roster já é emitido: `voice.roster{participants[]}` carrega `muted` por participante | §15.5 já tem o canal; acrescentar um `voice.muted` seria um segundo caminho para o mesmo fato — e dois caminhos divergem |
| `shareQuality{sessionId, quality}` é método próprio | O pedido do espectador precisa chegar ao host, que é quem conhece a sessão e quem autoriza. Não há caminho espectador→apresentador no v1 fora do host | §15.4 declara `share.setQuality` com papel de espectador e resposta `{applied}`; o método é o transporte disso, sem semântica nova |
| A qualidade pedida **não** ganhou evento novo | `share.health` já é emitido só ao apresentador e já carrega `quality` por espectador — verificado no código: `health.ts` monta cada entrada a partir do perfil corrente da sessão, que é o que `setQuality` escreve | §15.5 (`share.health`) + §17.5 ("cada `RTCRtpSender` tem seu próprio `setParameters`"): o laço fecha sem superfície nova |
| O `captureToken` **não** entra na resposta de `shareStart` | Ele é verificado pelo mesmo processo que o emitiria — trafegá-lo é expor um segredo que nenhum dos dois lados usa como prova. `capture.authorize` (§15.7) carrega só `{sessionId}`: o token nunca sai do núcleo, nem em modo host | §15.7 é a evidência textual: se o token fosse prova de rede, a mensagem que decide a captura o levaria. Ela não leva |
| A propriedade de `T-41` continua inteira | O que `T-41` exige é "não capturar sem autorização do host". Cunhar localmente **no instante** em que o host autoriza preserva isso: sem autorização não existe sessão, e sem sessão não existe token — a condição necessária é a mesma | §17.4: a ordem `share.start → host autoriza → captureToken → getDisplayMedia` fica literal; o que muda é só quem assina o token, e ele nunca foi verificado pelo host |
| A regra do token passou a ser **a mesma nos dois modos** | Em modo host o processo que cunha já era o que verifica; a emenda estende a regra ao modo membro em vez de criar um segundo desenho para o mesmo gate. Um caminho, um teste, uma falha possível | §17.4 emendado |
| A capacidade de captura morre com a sessão | Um token que sobrevive à sessão é uma autorização de captura órfã — o pior resultado possível para o gate que `T-41` existe para fechar | §17.5: `share.stop` encerra a sessão e revoga os espectadores; a capacidade local segue o mesmo tempo de vida |

### 40.2 O que mudou no normativo

| Documento | Mudança |
|---|---|
| `docs/backend-v2.md` §16.2 | duas linhas novas na tabela de métodos (`voiceMute`, `shareQuality`) e uma nota de emenda datada, dizendo o que **não** precisou de superfície nova |
| `docs/backend-v2.md` §17.4 | parágrafo de emenda datado sob `T-41`: o `captureToken` é capacidade local, não segredo de rede; a resposta de `shareStart` em §16.2 permanece `{sessionId}` |

Nenhuma outra seção mudou. §15.4 não precisou de emenda: os três comandos já estavam lá com
a forma que agora é implementável nos dois modos.

### 40.3 O que continua pendente

| Pendência | O que falta | Quem fecha |
|---|---|---|
| ~~`voiceTicket` (renovação de §17.4)~~ | **decidido em 2026-08-22 — §42**: o dono é o núcleo | — |
| ~~`voice.signal`~~ | **decidido em 2026-08-22 — §42**: o host encaminha (`voiceSignal`) | — |
| ~~Handlers de mídia em produto no `rpcServer`~~ | **implementado em 2026-08-22 — §42** | — |
| `capture.authorize` no `ipcMain` | o dispatcher já responde; falta a mensagem de §15.7 chegar nele | fase do processo main |

---

## 41. Anexos, download e impacto de saída no roteador 2026-08-22

**Gate de entrada:** nenhum gate específico — último item de §29.2 e o de §36.2 sobre anexo.
As seis superfícies de arquivo de §15.4 entram no roteador, e `message.send` ganha a
barreira de §13.7. Nenhum módulo novo; barreira inalterada (`§4 ok — L0:8 L1:6 L2:12 L3:4`,
66 arquivos); suíte do core 729 → **741 testes, 0 falha**; harness do G12 reexecutado nos
dois perfis (6/6).

| Entrega | Onde | Seção | Teste/evidência |
|---|---|---|---|
| `file.pickForAttachment` e `blob.stage` | `core/src/l3/ipcRenderer/commands.ts` + `blobAttachmentPort` em `test/helpers/composition.ts` | §15.4, §13.2, §15.7 | sai ticket, entra ticket: nada que pareça caminho de arquivo atravessa o IPC-R; o `hash` do staging é o BLAKE2b do conteúdo real em disco |
| Barreira blob ↔ mensagem | mesmo arquivo; `BlobManager.stagedResult` | §13.7 regra 1 | `message.send` com anexo antes do staging → `E_BLOB_NOT_STAGED`, e nada é enfileirado; ticket inventado pelo renderer idem |
| `blob.download` / `blob.cancel` / `blob.reveal` | roteador + porta | §13.4, §13.6, §15.3 | `{state}` na hora e progresso por evento; argumento malformado é `E_VALIDATION` antes de qualquer decisão; executável não é revelável nem depois de baixado |
| `host.exitImpact` | roteador + `hostExitImpactPort` | §15.4, §18.7, U-06 | informa por comunidade; não avisa ninguém e não bloqueia a saída |
| `E_BLOB_NOT_STAGED` no catálogo | `docs/backend-v2.md` §20.2; `core/src/l1/errors/codes.ts` | §20.2, §13.7 | o teste de paridade relê §20.2 do normativo: 87 → **88 códigos** |
| `file.pick` em §15.7 | `docs/backend-v2.md` §15.7 | §15.7, §15.4 | a metade que faltava do par: o núcleo pede, o main abre o diálogo, `staging.ticket` volta |

### 41.1 Decisões de implementação registradas

| Decisão | Justificativa normativa |
|---|---|
| `message.send{attachment}` leva **só `{ticketId}`** | §15.4 escreve `attachment?` sem fixar a forma, e §13.7 diz que a barreira é o `blob.stage` ter completado. Quem sabe o que foi escrito é o núcleo: deixar o renderer declarar `blobsCoreKey`/`hash`/`sizeBytes` permitiria apontar a mensagem para qualquer blob do mundo — o mesmo risco que `blob.stage` já fecha ao recusar caminho vindo do renderer (`T-16`, `DR-37`). Campos extras no argumento são ignorados, e há teste para isso |
| `E_BLOB_NOT_STAGED` entrou no catálogo em vez de virar `E_VALIDATION` | §13.7 regra 1 é uma recusa nomeada de ordem, não de forma. O código já era lançado por `blobs` (L2) sem estar em §20.2 — a divergência estava no normativo, não no módulo. §20.2 é fonte única e agora o é de verdade |
| `stagedResult` é memória **em processo**, não coluna nova | `local_blob_staging` (§13.5) guarda o que a retomada precisa; `blobsCoreKey`/`blobId` ligam ticket a blob e só existem depois do `put`. Acrescentar coluna custaria bump de schema para um dado cuja perda tem desfecho correto: sem ele a mensagem recusa e a UI reencena o `blob.stage` |
| A classe de `blob.reveal` é decidida **no handler**, pelo tipo do blob | §15.3 escreve literalmente "`blob.reveal` de `archive`" na linha `main-confirmed`: a classe depende do dado, e o tipo só se conhece olhando o blob. `IpcServer.requireConfirmation` expõe o mesmo caminho de token que a classe estática usa — não há segunda porta de confirmação |
| `blob.download` resolve `name`/`sizeBytes`/`hash` da projeção, não do argumento | §15.4 manda só `{communityId, blobsCoreKey, blobId}`, e §13.4 passos 5–6 precisam do tamanho declarado e do hash para abortar e verificar. Esses são fato da mensagem projetada; aceitar do renderer seria deixá-lo desligar a verificação |
| `file.pick` foi acrescentado a §15.7 em vez de improvisado na composição | §15.4 diz "o main abre o diálogo" e §15.7 só tinha a volta (`staging.ticket`). Os outros dois casos da mesma tabela (`capture.*`, `exit.*`) já são pares pedido/resposta: a emenda usa a forma que a tabela já tinha |
| Anexar exige `attach_files` **além** de `send_messages` | §7.4 linha de `message.send`: "`send_messages` (+`attach_files` se anexo)" |

### 41.2 O que continua pendente

| Pendência | O que falta | Quem fecha |
|---|---|---|
| Eventos de blob | `blob.progress`, `blob.completed`, `blob.peerLost`, `blob.unavailable`, `attachment.corrupt` precisam sair do `BlobManager` para o fan-out de §38 | integração de blobs |
| `blobs` com hyperblobs real | o módulo grava em disco e deriva `blobIdHex` do hash; o `blobId` de §7.2.1 só ganha significado com o hyperblobs de verdade | fase de blobs |
| Cota de anexo na fronteira | `E_QUOTA_EXCEEDED` de §15.4 depende de `storage_used_bytes` do DS na hora do `blob.stage` | integração da cota |
| `file.pick`/`staging.ticket` no `ipcMain` | a porta existe e a mensagem está em §15.7; falta o módulo do main | fase do processo main |

---

## 42. Sinalização, renovação de ticket e os handlers de mídia em produto 2026-08-22

**Gate de entrada:** nenhum gate específico — as três pendências de §40.3. Duas eram lacunas
de dono ("existe o mecanismo, falta quem o opere"); a terceira era dívida de arrumação. Um
módulo novo em L3 (`rpcServer/media.ts`); barreira inalterada em módulos
(`§4 ok — L0:8 L1:6 L2:12 L3:4`), 66 → **67 arquivos**; suíte do core 741 → **747 testes,
0 falha**; harness do G12 reexecutado nos dois perfis (6/6).

| Entrega | Onde | Seção | Teste/evidência |
|---|---|---|---|
| §16.2 ganha `voiceSignal`; o host encaminha | `docs/backend-v2.md` §16.2; `registerHostMediaMethods`; `voice.signal` no roteador | §16.2, §15.4, §15.5, §17.4 | a origem do sinal é a da **conexão**, não algo que o remetente declare; par fora da chamada é `E_PEER_UNREACHABLE`; host sem relay composto recusa em vez de fingir entrega |
| A renovação de ticket é do núcleo | `docs/backend-v2.md` §17.4 e §15.5 (`voice.tickets`); `VoiceTicketRenewer` | §17.4, §26.2, §15.1 regra 5 | o ciclo renova por par e empurra tickets **verificáveis** com `verifyMediaTicket`; fora de chamada é no-op; depois do `voice.leave` volta a ser no-op |
| Handlers de mídia em produto | `core/src/l3/rpcServer/media.ts` (era cabo de composição) | §16.2, §4 | o cabo virou um atalho de três linhas sobre o módulo de produto; toda a suíte de modo membro passou sem mudança de expectativa |
| Codec de fio com teste de paridade | `mediaWire` (cliente) × `mediaWireServer` (servidor) | §4, §29.1 | as duas cópias codificam o ticket byte a byte igual, e cada uma decodifica o que a outra codificou de volta ao original |

### 42.1 Decisões e por que são estas

| Decisão | Justificativa de engenharia | Justificativa normativa |
|---|---|---|
| A sinalização é **encaminhada pelo host**, não trocada par-a-par | Antes de o ICE fechar não existe canal direto entre os dois membros — é justamente o que a sinalização serve para abrir. Quem tem conexão com os dois é o host | §17.2 (o host já é par da comunidade) e §17.4 passo 3 (quem recebe exige ticket válido para o par, e só o host emite ticket) |
| O host **encaminha sem ler** | Um host que interpretasse SDP passaria a ter opinião sobre a mídia, e a promessa de §17.2 é que ele nunca a vê | §17.2: DTLS-SRTP é negociado entre os pares; o relay é cego por propriedade do protocolo, não por promessa |
| `E_PEER_UNREACHABLE` é a recusa quando não há relay ou o destino não está na chamada | O código já existia em §20.2 com o significado "sinalização não chegou" — que **só faz sentido se alguém encaminha**. A emenda torna verdadeira uma linha que já estava lá | §20.2, §15.4 (o comando já declarava este erro) |
| A origem do sinal vem da **conexão**, nunca do corpo | Deixar o remetente declarar `fromPeerKey` permitiria personificar qualquer membro na sinalização — a mesma classe de `T-15` que os tickets fecham | §16.1: o `RpcServer` é por conexão, e é ela que autentica o par |
| A renovação de ticket é do **núcleo**, e §15.4 **não** ganha comando | Um renderer que esquecesse o temporizador perderia a sessão em silêncio, com sintoma a 5 minutos de distância da causa. Prazo é invariante da sessão, não intenção do usuário | §26.2 declara a cadência sem dono; §15.4 é a tabela de **intenções do usuário**, e renovar não é uma |
| A entrega é por evento novo (`voice.tickets`), com `voice.join` como reconsulta | §15.1 regra 5 exige que evento perdido nunca vire estado errado. `voice.join` no mesmo canal "devolve a sessão existente" com material fresco — a reconsulta já existia | §15.1 regra 5, §15.5, e o caminho de renovação que `voiceJoin` já era |
| Falha de renovação **não** emite evento | O ticket velho continua valendo até expirar e a próxima volta tenta de novo; anunciar "renovou" sem ticket seria mentir à UI. Um par que perdeu elegibilidade simplesmente para de renovar, e expira em `MEDIA_TICKET_TTL_MS` — que é a rede de segurança da revogação | §17.4: "o ticket expirado deixa de ser renovado, então mesmo um cliente que ignore o evento perde a sessão em ≤ `MEDIA_TICKET_TTL_MS`" |
| O relógio do renovador é **injetado** | Temporizador dentro do roteador é intestável; com `schedule`/`cancel` injetados, o ciclo é exercitado passo a passo e o teste não espera cinco minutos | §28.1 (nada de relógio de parede no que é testado) |
| O codec de fio é duplicado, com teste de paridade — não extraído para L2 | §4 não declara importação lateral entre módulos de L3 e a barreira quebra o build; empurrar um codec de transporte para L2 seria mover a fronteira para acomodar a ferramenta | §29.1: é exatamente o precedente da tabela de protocolo entre `rpcClient` e `rpcServer` |

### 42.2 O que mudou no normativo

| Documento | Mudança |
|---|---|
| `docs/backend-v2.md` §16.2 | linha nova `voiceSignal` e nota de emenda datada explicando por que o host é o relay e por que ele não lê |
| `docs/backend-v2.md` §15.5 | evento novo `voice.tickets{communityId, sessionId, tickets[]}` |
| `docs/backend-v2.md` §17.4 | parágrafo de emenda datado: a renovação é do núcleo, e por que §15.4 não deve ter comando para ela |

### 42.3 O que continua pendente

| Pendência | O que falta | Quem fecha |
|---|---|---|
| ~~A outra ponta do `voiceSignal`~~ | **implementada em 2026-08-22 — §43**: §16.3 dá a direção host → membro | — |
| ~~`voice.tickets` até o renderer~~ | **implementado em 2026-08-22 — §43**: `startMediaRuntime` | — |
| ~~Escolha do modo no boot~~ | **implementada em 2026-08-22 — §44** | — |

---

## 43. §16.3 — a direção host → membro, e o runtime de mídia 2026-08-22

**Gate de entrada:** nenhum gate específico — as duas pendências de §42.3. As duas eram a
mesma falta vista de dois ângulos: **§16 só tinha pedido/resposta**, e §15.5 está cheia de
eventos que só o host pode conhecer. Sem a direção host → membro, quem não hospeda nunca
receberia roster, revogação, sinalização ou estado de tela — e a sinalização, recém-decidida
em §42, chegava ao host e parava ali. Um módulo novo em L3 (`rpcServer/media.ts` já existia;
o runtime entrou em `ipcRenderer/media.ts`); barreira inalterada
(`§4 ok — L0:8 L1:6 L2:12 L3:4`, 67 arquivos); suíte do core 747 → **755 testes, 0 falha**;
harness do G12 reexecutado nos dois perfis (6/6).

| Entrega | Onde | Seção | Teste/evidência |
|---|---|---|---|
| §16.3 — notificação host → membro | `docs/backend-v2.md` §16.3; `RpcServer.notify`, `RpcClient.onNotify` | §16.3, §16.1, §15.1 regra 5 | tabela fechada com paridade entre as duas cópias, e um segundo teste que confere que **todo** tópico de §16.3 é um evento de §15.5 de mesmo nome; tópico desconhecido é descartado e a conexão continua servindo pedidos |
| Relay real da sinalização | `peerSignalRelay` em `core/src/l3/rpcServer/media.ts` | §16.2 `voiceSignal`, §16.3, §17.4 | dois membros contra o mesmo host: o SDP sai de um e chega ao outro **pela conexão dele**, com `peerKey` igual à origem da conexão; sem conexão para o destino, `E_PEER_UNREACHABLE` |
| Gate de ticket na entrada | `signalIsAuthorized` | §17.4 passo 3, §16.3 regra 5 | passa só o par com ticket verificável para `(sessionId, esteParDeChaves)`; não passa fora de chamada, nem par estranho, nem o próprio, nem depois de `MEDIA_TICKET_TTL_MS` |
| `startMediaRuntime` — o que o boot liga | `core/src/l3/ipcRenderer/media.ts` | §17.4 emendado, §16.3, §15.5, §38 | cadência de renovação + entrada de notificações desaguando no fan-out, com relógio injetado; `voice.revoked` sobre a própria identidade derruba a sessão local sem round-trip |
| `observeRoster` | `MediaDispatcher` | §16.3 `voice.roster`, §17.4 | um par que entra depois passa a ter ticket na renovação seguinte — sem isso, dois membros que não entraram juntos nunca se autorizariam |

### 43.1 Decisões e por que são estas

| Decisão | Justificativa de engenharia | Justificativa normativa |
|---|---|---|
| A direção host → membro é uma **segunda forma de quadro no mesmo canal**, não um protocolo novo | Um segundo canal duplicaria autorização, teto de frame, reconexão e circuit breaker — quatro coisas que §16.1 já define uma vez. O quadro sem `id` é a diferença mínima que expressa "não espera resposta" | §16.1 declara **um** canal por comunidade, chaveado pelo `coreKey`; a autorização de §14.3 já vale para ele |
| Entrega **at-most-once**, sem ACK e sem retentativa | ACK e retentativa numa direção cujo conteúdo é sinal só criariam fila e ordem para reconstruir — e §15.1 regra 5 já garante que evento perdido nunca vira estado errado, porque cada tópico tem uma consulta que o reconstrói | §15.1 regra 5; e é a mesma garantia que `DS-30` pedia que fosse declarada para `presence`/`typing`, agora válida para a direção inteira |
| A tabela de tópicos é **fechada**, e desconhecido é descartado em silêncio | Um host mais novo empurrando um tópico futuro não pode derrubar a conexão de um cliente velho | Mesma regra de §7.2 para `kind` desconhecido |
| Notificação que não cabe no teto **não é enviada**, e quem a produziu sabe | Fatiar sinal exigiria remontagem e ordem — estado novo no transporte para um dado que é descartável por desenho. `notify` devolve `false` em vez de fingir | §16.1: o teto de frame vale para o canal, não para uma direção |
| Em `voice.signal` a origem é a da **conexão** | Deixar o remetente declarar `peerKey` permitiria personificar qualquer membro na sinalização, que é a porta de entrada da mídia | §16.1 (o `RpcServer` é por conexão) e `T-15` |
| O ticket é verificado **no núcleo receptor**, não no renderer | O núcleo já tem o ticket do par e a chave do host; o renderer é a camada que fala WebRTC, e sinalização não autorizada não deve chegar até lá. Falha fechada: sem material, nada passa | §17.4 passo 3 — "o cliente SÓ aceita sinalização de um par que apresente ticket válido"; §16.3 regra 5 torna explícito **qual** cliente |
| `observeRoster` existe porque a renovação precisa saber de par novo | `voiceJoin` devolve o roster do instante da entrada. Quem entrou primeiro nunca teria ticket para quem entrou depois, e os dois ficariam eternamente sem se autorizar — um bug que só aparece com três pessoas e ordem de entrada específica | §16.3 `voice.roster` é a única fonte disso em modo membro |
| `voice.revoked` sobre a própria identidade derruba a sessão local | §17.4 manda o cliente fechar **imediatamente**; esperar o round-trip seguinte é manter viva uma sessão que o host já encerrou | §17.4, revogação |
| O runtime existe como peça, e não como código no boot | O boot do utilityProcess ainda não existe, e esta ordem — renovar, receber, filtrar, emitir — não pode ser redescoberta por comunidade. Com relógio e transporte injetados, ela é testável sem processo, sem socket e sem esperar cinco minutos | §4 (quem monta o grafo injeta) e §28.1 |

### 43.2 O que mudou no normativo

| Documento | Mudança |
|---|---|
| `docs/backend-v2.md` §16.3 | seção nova: tabela fechada de notificações host → membro, com as cinco regras (at-most-once; tabela fechada e descarte silencioso; teto de frame; origem da conexão; ticket verificado por quem recebe) |

### 43.3 O que continua pendente

| Pendência | O que falta | Quem fecha |
|---|---|---|
| ~~Produtores de `presence.changed` / `typing.changed`~~ | ~~os tópicos estão em §16.3, mas os handlers de `presencePublish`/`subscribeChannel` no `rpcServer` continuam sem produto~~ **implementado em 2026-08-23 — §54**: handlers no host sobre o `PresenceManager`, com os tetos de §17.6 e fan-out por assinatura | — |
| ~~`share.*` empurrado pelo host~~ | **implementado em 2026-08-22 — §44**: `onSessionEvent` do `ShareHostSessions` desagua em `notify` pelas conexões vivas | — |
| ~~Registro de conexões vivas~~ | **implementado em 2026-08-22 — §44**: `CoreRuntime.attachMemberConnection` mantém o mapa conexão↔membro | — |
| ~~Escolha do modo no boot~~ | **implementada em 2026-08-22 — §44** | — |

---

## 44. O boot do `utilityProcess` — a raiz de composição 2026-08-22

**Gate de entrada:** nenhum gate específico — as seis linhas de pendência que apontavam para
o boot (§35.2, §37.2, §38.2, §39.3, §42.3, §43.3). Todas as peças existiam e estavam
testadas; faltava o processo que as liga. Um diretório novo **fora da pilha de camadas**
(`core/src/composition/`, 2 arquivos); barreira inalterada em módulos e com regra nova
(`§4 ok — 69 arquivo(s), L0:8 L1:6 L2:12 L3:4 + raiz de composição (2 arquivo(s))`); suíte
do core 755 → **765 testes, 0 falha**; harness do G12 rebuildado e reexecutado nos dois
perfis (6/6).

| Entrega | Onde | Seção | Teste/evidência |
|---|---|---|---|
| Raiz de composição declarada e verificada | `docs/backend-v2.md` §4 (emenda); `core/scripts/check-layers.ts` | §4 | a raiz importa qualquer módulo; **módulo de camada que a importe quebra o build** com mensagem própria (verificado ligando o import e vendo a violação) |
| As juntas de produto saíram do cabo de teste | `core/src/composition/ports.ts` — 21 exports: 20 mudadas do cabo de teste (de `opCodecSignPort` a `migrateRail`) e `hostRecordSigner`, nova | §4, §35.1, §36.1, §41 | `test/helpers/composition.ts` reexporta o arquivo e ficou só com a metade simulada (`MemoryRpcChannel`, `swarmNatProbe`, `UdpStunProbe`, `tempDir`); os 755 testes anteriores passam sem alteração |
| `bootCore` / `CoreRuntime` | `core/src/composition/boot.ts` | §3.3 fases `open`…`host-mode`, §4 | 10 testes novos em `core/test/boot.test.ts`, todos sobre as **ligações**, não sobre as peças |
| Fan-out dos dois produtores | `Projector.onEvent = fanout.fromProjector`; `Outbox.onOutcome = fanout.fromOutbox(cid)` | §38.2, §15.5, DS-31 | append no core → `messages.appended{fromSeq,toSeq,channelId}` no renderer; `submitQueued` → flush → reconciliação → `message.accepted`, **depois** do lote |
| Escolha do modo de mídia por comunidade | `is_host` da linha de `manifest.communities` decide entre `localMediaDispatcher` e `remoteMediaDispatcher` | §42.3, §43.3, §10.2 | quem hospeda tem `mode:'host'`, `host ≠ null` e **nenhum** canal de §16.1; quem não hospeda tem `mode:'member'`, `host === null` e `RpcClient` |
| `startMediaRuntime` por comunidade, com relógio real | `bootCore` passa `setInterval`/`clearInterval` e `MEDIA_TICKET_TTL_MS/3` | §17.4 emendado, §26.2 | o temporizador registrado é exatamente `MEDIA_TICKET_TTL_MS/3` |
| Mapa conexão↔membro | `CoreRuntime.attachMemberConnection` / `.detach()`; `peerSignalRelay` lê dele | §43.3, §16.3 regra 4 | dois membros no mesmo host: o SDP sai de um e chega ao outro com `peerKey` igual à origem da conexão; conexão que sai do mapa vira `E_PEER_UNREACHABLE` |
| Push do host: roster, revogação e `share.*` | `onRosterChanged`/`onRevoked` de `VoiceHostSessions` e `onSessionEvent` de `ShareHostSessions` → `RpcServer.notify` nas conexões vivas | §16.3, §15.5, §17.5 | quem não está na chamada **não** recebe o roster |
| Portas de sucessão, saída e consulta | `SuccessionService` composto; `communityLeavePort`, `queryCommunityPort`, `migrateRail` no roteador | §35.2, §37.2, §15.4, §15.6 | `query.community` responde sobre o DS real; `community.leave` marca `left_at` e fecha a comunidade no runtime; o host recusa com `E_HOST_CANNOT_LEAVE` |
| `projector.start()` no boot | `bootCore`, logo após `projector.boot()` | §10.5 passo 6 | sem esta linha o núcleo interpreta o log do boot e fica surdo a `append` — foi o primeiro defeito que o teste do fan-out pegou |
| Reconciliação de boot | `outbox.recoverOnBoot()` por comunidade | §3.3 `reconcile`, §11.6 | `sending` sem desfecho volta a `queued` sem consumir tentativa |

### 44.1 Decisões e por que são estas

| Decisão | Justificativa de engenharia | Justificativa normativa |
|---|---|---|
| A composição mora **fora** de `src/l*/`, não num módulo `boot` em L3 | Um módulo de L3 com "Depende de: tudo" não é uma linha da tabela de §4 — é a negação dela, e o lint não teria o que verificar. Fora da pilha, há exatamente uma regra a verificar, e ela é a que protege a arquitetura | §4 emendado: a raiz importa qualquer módulo; **nenhum módulo de camada pode importá-la**, com mensagem própria no lint |
| A regra nova é **na direção contrária** das demais | Todas as fronteiras de §4 limitam o que um módulo pode importar. A da raiz limita quem pode importá-la: sem isso, um módulo pegaria uma implementação pronta e a injeção viraria acoplamento com um passo a mais | §4, "quem monta o grafo injeta a implementação no boot" — a injeção é a direção, não um detalhe de estilo |
| O transporte chega **injetado**, e o boot nunca abre socket | É a costura que a fase seguinte (protomux-rpc sobre Hyperswarm, probe NAT do HyperDHT) preenche sem tocar em nada abaixo dela. `attachHostChannel` e `attachMemberConnection` recebem `RpcTransportPort` pronto | §4 (L3 implementa o transporte, a composição injeta) e §16.1 (um canal por comunidade, chaveado pelo `coreKey`) |
| O `MediaRouter` roteia por comunidade sobre um dispatcher só | §15.4 dá ao roteador **um** `MediaDispatcher` e §15.4 `voice.leave` declara que "voz é uma só". As duas coisas juntas definem o objeto: `voiceJoin` fixa a comunidade corrente, e todo comando sem `communityId` vai para a fixada | §15.4, §17.4 |
| `share.*` endereça por `sessionId`, que não nomeia comunidade — o mapa `sessionId → comunidade` é alimentado pelos eventos | Um espectador manda `shareJoin` de uma sessão que ele não abriu: o único lugar onde ele soube dela é o `share.started` de §16.3, que passa pelo runtime de mídia. Sem registro, cai na comunidade da chamada corrente — a única em que §17.5 permite que exista tela | §17.5 (a tela vive dentro de um canal de voz), §16.3 |
| `outboxDe` acha a fila pela linha em `local_outbox`, não varrendo as comunidades | §15.4 manda só o `opId` em `message.retry`/`message.cancelQueued`, e §11.2 dá uma fila por comunidade. A linha do manifest **é** o índice; varrer tocaria filas de outras comunidades para responder sobre uma | §11.2, §15.4, §10.2 |
| Comunidade com `left_at` não é aberta, e `community.leave` a fecha no runtime | §3.3 fase `open` diz "para cada comunidade **listada em `manifest.communities`**", e §11.1 (exceção) faz da saída um efeito local imediato. Deixar a comunidade aberta depois da saída manteria projector, fila e mídia vivos sobre algo de que já se saiu | §3.3, §11.1, L-22 |
| Core ilegível não derruba o boot: vira `host.statusChanged{degraded}` daquela comunidade | É literalmente o que a tabela de §3.3 manda, e é a diferença entre uma comunidade quebrada e um núcleo que não abre | §3.3 fase `open`: "Core ilegível → `degraded` só naquela comunidade; as outras seguem" |
| `hostRecordSigner` entrou na raiz, e não em `communityHost` | §4 não dá `opCodec` a `communityHost`, e a chave de escrita do core é derivada da semente que só o boot lê (§5.3/§5.4). Quem constrói o material assinável e quem tem a chave é quem monta o grafo | §4, §7.1, §11.4 |
| A metade simulada continua em `test/helpers/composition.ts`, que reexporta a de produto | A fronteira entre "junta de produto" e "simulação de teste" fica visível no import, e nenhum rig existente precisou mudar | §28.1 (o transporte simulado é do teste, as decisões são dos módulos reais) |

### 44.2 O que mudou no normativo

| Documento | Mudança |
|---|---|
| `docs/backend-v2.md` §4 | linha `composition` no diagrama e na tabela de módulos (camada `—`, "Depende de: qualquer módulo", "Não pode: ser importada por qualquer módulo de camada"); parágrafo de emenda datado com as três regras da raiz de composição e a alternativa recusada (módulo `boot` em L3) |

### 44.3 O que continua pendente

| Pendência | O que falta | Quem fecha |
|---|---|---|
| ~~Transporte real~~ | **implementado em 2026-08-22 — §45**: `Hyperswarm` + `protomux` alimentando as duas costuras, com replicação do hypercore no mesmo mux. Probe NAT do HyperDHT e descoberta da continuação pela DHT continuam abertos (§45.3) | — |
| ~~Produtores de `presence.changed` / `typing.changed`~~ | ~~os tópicos estão em §16.3 e o push do host já existe para roster/revogação/tela; faltam os handlers de `presencePublish`/`subscribeChannel` no `rpcServer`~~ **implementado em 2026-08-23 — §54** | — |
| ~~`Diagnostics`, `BlobManager` e `RelayVolunteer` chegam injetados~~ | **BlobManager saiu da lista em 2026-08-22 — §47**: construído no boot sobre o layout de §10.1, com os cores locais por comunidade. `Diagnostics` (sonda de NAT) e `RelayVolunteer` (consentimento) continuam chegando prontos | fase de mídia pela rede |
| ~~Ciclo de vida do processo~~ | ~~lock composto de §10.8, wipe-resume de §18.6, `identity` pelo IPC-M e `draining` de §3.3 continuam no shell de `app/src/utility/index.ts`, hoje stub~~ **implementado em 2026-08-23 — §56**: o utility roda o `bootCore` de verdade sobre as duas portas cruzadas pelo main, com lock flock, retomada de wipe antes de abrir banco, Data Key por IPC-M e draining no quit | — |
| `IpcClient.request` deixa o timer de 30 s sem `clearTimeout` | defeito pré-existente do cliente de teste (registrado desde §39.3); `test/boot.test.ts` não usa `IpcClient` por causa dele | limpeza de L3 |

---

## 45. O transporte real de §14 e §16.1 — Hyperswarm e protomux 2026-08-22

**Gate de entrada:** nenhum gate específico — o primeiro item de §44.3. O boot deixou duas
costuras abertas (`attachHostChannel`, `attachMemberConnection`) e disse que nunca abriria
socket; esta fase é quem abre. Um arquivo novo em L0 (`swarm/hyperswarm.ts` + `swarm/ports.ts`),
um em L3 (`rpcServer/protomux.ts`) e um na raiz de composição (`transport.ts`); barreira
inalterada em módulos (`§4 ok — 73 arquivo(s), L0:8 L1:6 L2:12 L3:4 + raiz de composição
(3 arquivo(s))`); suíte do core 765 → **768 testes, 0 falha**; harness do G12 reexecutado
nos dois perfis (6/6).

Os três testes novos rodam contra uma **DHT local de verdade** (`hyperdht/testnet`), com
sockets, `Hyperswarm`, `protomux` e replicação de `hypercore` reais — em 6 s. Nada sai da
máquina.

| Entrega | Onde | Seção | Teste/evidência |
|---|---|---|---|
| Backend real do swarm | `core/src/l0/swarm/hyperswarm.ts` (`HyperswarmBackend`), porta em `swarm/ports.ts` | §14.1, §14.3(4) | a fachada `Swarm` ganhou `backend` opcional: ausente = modo memória (a suíte de §14.2/§14.3 não mudou uma linha), presente = DHT. O firewall de conexão liga-se ao `firewallShouldRejectConnection` que já era puro |
| Canal de §16.1 sobre `protomux` | `core/src/l3/rpcServer/protomux.ts` — `protomuxChannelTransport` (abre) e `protomuxChannelAcceptor` (responde) | §16.1, §14.4 | satisfaz o `RpcTransportPort` que `RpcServer`/`RpcClient` já consomem: **nada** de §16.2/§16.3 mudou por sair do canal de memória para o socket. Teto de frame aplicado antes do decode, nos dois sentidos |
| O transporte ligado ao boot | `core/src/composition/transport.ts` — `startCommunityTransport` | §14.1, §14.3, §16.1 | junta tópico, autorização, replicação e canal; alimenta as duas costuras de §44 |
| Replicação do log | `CoreHandle.replicate?`/`download?` (L0) sobre o mesmo mux | §14.1, §14.2 | o membro descobre o host pela DHT e interpreta o log inteiro; `download({start:0,end:-1})` porque o hypercore é esparso e "estar conectado a um par não é estar replicando" |
| Escrita ponta a ponta pela rede | — | §11.1 caminho A, §16.2 | `submitQueued` → `outbox.flush()` → `submitOps` pelo socket → `HostAdmission` → append → replicação de volta → a réplica projeta a op → `reconcile` limpa a fila |
| §14.3(1) contra um par de verdade | `autorizado` em `transport.ts` | §14.3(1), T-25, DR-30 | um nó com identidade que não está no `DS` acha o tópico, conecta — o firewall de §14.3(4) não o recusa, porque ele não está banido em comum nenhuma — e **não recebe bloco**: o host não replica para ele |
| §14.3(3) no mesmo lote | `CoreRuntime.onProjected` → `refresh` | §14.3(3) | o gatilho é o lote de projeção; o mesmo gatilho abre o canal que só era possível depois de saber quem é o host |
| `DS` em memória avança **com** o commit | `core/src/l1/projector/index.ts` | §10.5, §10.7 | `this.#ds = ds` passou para logo depois do commit do lote, antes da emissão — a mesma invariante que o caminho do bloco ausente já respeitava |

### 45.1 Decisões e por que são estas

| Decisão | Justificativa de engenharia | Justificativa normativa |
|---|---|---|
| **O keypair do `Hyperswarm` é a identidade de §5.5** | Sem isso, §14.3(1) é inimplementável: `remotePublicKey` não diria nada sobre membro nenhum, e a autorização exigiria um handshake de identidade em banda inventado aqui | §5.2 é a tabela **fechada** de derivações e não tem prefixo para chave de rede; §5.1 declara `remotePublicKey` verificada; §12.6 já a lê como "chave pública do par". Registrado como emenda em §14.3, com `L-24` declarando o metadado que isso expõe |
| **Réplica sem `DS` autoriza qualquer par** | Um nó que nunca interpretou a comunidade não tem bloco para servir, e só descobre quem é membro **lendo o log**. Recusar ali tornaria a primeira replicação impossível — o problema do ovo e da galinha, não uma brecha | §14.3(1) é regra sobre o que **eu** sirvo; a propriedade fica inteira por simetria, porque quem tem o dado aplica a mesma regra sobre o `DS` dele. Emenda registrada em §14.3 |
| **`protomux`, e não `protomux-rpc`** | O que §16.1 pede de `protomux-rpc` são canais distintos por protocolo (isso é `protomux`) e uma tabela de parâmetros que `protomux-rpc` não tem — timeout, requests em voo, teto antes do decode, reconexão, circuit breaker — e que `rpcClient`/`rpcServer` já implementam. E §16.3, cuja tabela fechada de notificações sem `id` não tem equivalente lá | §14.3(1) já diz "canal `protomux`"; §3.1 escreve "protomux(-rpc)". Emenda registrada em §16.1: nenhum parâmetro, método, tópico ou código muda |
| **Quem abre o canal é o membro; o host responde** (`mux.pair`) | Canal aberto contra um par que ainda não o registrou é recusado pelo `protomux` e morre. Quem sabe **quando** o canal faz sentido é o membro, porque é ele que precisa ter lido o log para saber quem é o host. Sem a assimetria, o host abriria e seria recusado em laço | Mesma assimetria do anúncio na DHT (§14.1): o host anuncia, o membro procura. Emenda registrada em §16.1 |
| Conexão sem `topics` serve **qualquer** comunidade deste nó | `peerInfo.topics` só vem preenchido do lado que procurou o tópico; quem anuncia recebe a conexão sem saber por qual tópico vieram. Filtrar por tópico do lado do host descartaria todas as conexões de entrada | Quem decide é §14.3(1), que é por comunidade e não depende do tópico: um par que não é membro ativo não passa, venha por onde vier |
| `onAppend` do `CoreHandle` reage também a `download` | Para o **escritor** `append` é o evento: o bloco existe e é legível no mesmo instante. Para a **réplica** as duas coisas se separam, e o projector para no primeiro buraco esperando um sinal — que com só `append` nunca chegaria num log que veio inteiro de uma vez. Coalescido numa microtask porque a replicação dispara `download` por bloco | §10.5 passo 6: o projector reage ao core; para uma réplica, "há mais para ler" é o download |
| `this.#ds` avança junto com o commit do lote | Quem observa o lote — o fan-out de §15.5 e, por ele, o transporte em §14.3(3) — precisa ver o estado que o lote produziu. Com a atribuição no fim do `#run`, o observador via o estado anterior e o canal só abria na projeção seguinte | É a invariante que o caminho do bloco ausente já respeitava (`this.#ds = ds` antes do `return`): depois de um commit, memória e `view.db` estão no mesmo prefixo |
| O `Swarm` de memória continua sendo o default | As regras de §14.2/§14.3 são puras e precisam continuar testáveis sem rede — é o que §4 diz que a divisão existe para permitir. Nenhum dos 765 testes anteriores mudou | §4, §28.1 |
| `peerCount` com backend real conta **conexões**, não pares por tópico | Um par que traz duas comunidades é uma conexão, e o orçamento de §14.2 é de conexões | §14.2, `F-14` |

### 45.2 O que mudou no normativo

| Documento | Mudança |
|---|---|
| `docs/backend-v2.md` §14.3 | emenda datada com dois itens: (1) o par de §14.3(1) é o `remotePublicKey` do Noise, que **é** a chave de identidade — com `L-24` declarando o metadado; (2) réplica que ainda não interpretou nada autoriza qualquer par, e por que a propriedade fica inteira por simetria |
| `docs/backend-v2.md` §16.1 | emenda datada: a implementação usa **`protomux`** (a camada sobre a qual `protomux-rpc` é construído, já nomeada em §14.3(1)) carregando os quadros de §16.2/§16.3, com a justificativa item a item; e a assimetria "o membro abre, o host responde" |

### 45.3 O que continua pendente

| Pendência | O que falta | Quem fecha |
|---|---|---|
| ~~Protocolo `p2p-admission/1`~~ | **implementado em 2026-08-22 — §46**: `inviteResolve`/`inviteRedeem` sobre o tópico de convite de §14.1, com o canal pré-membro de §12.3 e os tetos de §12.6 | — |
| Probe de NAT e `Diagnostics` | `diag.*` continua chegando injetado ao boot; o probe real é o `hyperdht` (§24.3) e o `MediaServer` de §17.3 sobre o mesmo socket UDX | fase de mídia pela rede |
| Descoberta da continuação pela DHT | §18.8 passo 5 tem a arbitragem (`migrateRail`) e a porta; falta quem entrega o core novo à réplica | G12 empacotado |
| Escalonador de §14.2 ligado | `allocateConnections` é puro e testado, e `HyperswarmBackend` aceita `maxPeers`; ninguém ainda reprioriza por comunidade ativa nem aplica `BG_ROTATION_MS` | **BENCHMARK REQUIRED — G9** |
| ~~Core de blobs na DHT~~ | ~~tópico de convite~~ entrou em §46; **terceiro tópico implementado em 2026-08-22 — §47**: os três tópicos de §14.1 anunciados/procurados | — |
| ~~Produtores de `presence.changed` / `typing.changed`~~ | ~~os tópicos estão em §16.3 e o push do host já funciona; faltam os handlers no `rpcServer`~~ **implementado em 2026-08-23 — §54** | — |

---

## 46. Nascer, convidar, resolver e resgatar — `community.create` e o protocolo `p2p-admission/1` 2026-08-22

**Gate de entrada:** G3 (`confirmado`, `poc/poc-05-g3/out/gate-G3/gate-G3.json`) para os seis
desfechos de preview e o consumo atômico de `maxUses` — decisões reutilizadas, código do
harness não. As quatro decisões de §45 (keypair de rede = identidade; réplica em branco
autoriza quem consulta; `protomux`; membro abre canal) ficaram intactas. Um arquivo novo em
L2 **não** houve — o `InviteManager` existente ganhou só o papel de anúncio; dois arquivos
novos na raiz de composição (`community.ts`, `admission.ts`); barreira:
`§4 ok — 75 arquivo(s), L0:8 L1:6 L2:12 L3:4 + raiz de composição (5 arquivo(s))`; suíte
768 → **769 testes, 0 falha**; harness do G12 rebuildado e reexecutado nos dois perfis
(6/6).

O teste que fecha a fase roda contra `hyperdht/testnet`: um nó cria a comunidade pelo
comando IPC `community.create`, emite `invite.create`, e o outro — **sem nenhuma linha em
`manifest.communities`** — resolve e resgata pelo código de 16 caracteres, replica o log
inteiro pela mesma conexão da admissão e manda uma op pela outbox que volta projetada.

| Entrega | Onde | Seção | Teste/evidência |
|---|---|---|---|
| `community.create` | `core/src/composition/community.ts` — gênese de R-27 montada com as juntas de §44 (`opCodecSignPort` + `hostRecordSigner`) | §5.3, §19.1, R-27 | semente → linha cifrada no manifest **antes** de criar core → 6 registros num único `core.append`; falha de append descarta linha e core |
| Fronteira dos cinco comandos | `core/src/l3/ipcRenderer/commands.ts` | §15.4 | `community.create` (standard), `invite.create`/`invite.revoke` (⏱ standard), `invite.resolve` (**open**), `invite.redeem` (standard); `code` só na resposta de quem cria |
| Emissão/revogação compostas | `inviteCreate`/`inviteRevoke` em `community.ts` — segredo persistido antes do append, removido se a admissão recusar | §12.2, §7.5 | vale para qualquer membro com `create_invite` (convite delegado, A08), via porta local ou RPC |
| Anúncio reconciliado do DS | gancho `onProjected` → `InviteManager.syncAnnouncements` por comunidade hospedada | §12.2 passo 3 | convite criado por outro membro chega pela replicação e é anunciado; revogado/expirado/esgotado sai no lote que o registrou; papel `server:true` |
| `CoreRuntime.openCommunity(row)` | `boot.ts` — o closure `abrir` virou método | §3.3 | comunidade que nasce depois do boot tem o mesmo caminho do boot, sem reiniciar o processo |
| Fila durável também em modo host | `admissionSubmitPort` em `ports.ts`; outbox criada nos dois ramos do boot | §11.2, §7.5 | o host consome `authorSeq` da mesma fonte persistida e tem reconciliação de boot igual à de membro |
| Tópicos dinâmicos | `transport.ts`: `syncTopicos()` reenumerável + `runtime.onOpen` | §14.1 | comunidade nova é anunciada/procurada no `register`, sem reiniciar nada |
| Canal pré-membro `p2p-admission/1` | protocolo `admission` já tabelado em `rpcServer`/`rpcClient`; `transport.ts` passa a procurar (`seekInviteTopic`) e servir (`serveInviteTopics`) tópicos de convite | §16.1, §12.3 | candidato abre, host responde — mesma assimetria de §16.1 |
| Serviço de admissão | `core/src/composition/admission.ts` — `AdmissionService`, as duas direções numa assinatura só de `onAdmissionChannel` | §16.2 | `admissionHello`/`inviteResolve`/`inviteRedeem`; seis desfechos delegados ao `InviteManager` (G3) |
| Tetos de §12.6 no fio | orçamento de conexões por tópico; rate limit node-level por chave e /24 **antes do decode** (ordem de §14.4) | §12.6, §14.4 | quadro limitado não existe: sem decode, sem resposta, sem consumo de challenge; prova errada fecha a conexão |
| Firewall cede à superfície pré-membro | `HyperswarmBackend.setPreMemberSurface`, assinado pela composição | §14.3(5) | enquanto houver convite hospedado, a porta aceita qualquer par; canais continuam guardados por §14.3(1) |
| Resgate → participação | `redeem` em `admission.ts`: envelope `member.join` selado pelo candidato (F-06), blobs locais gerados e cifrados (§13.1), linha no manifest + `openCommunity` | §12.4, §5.3 | `{seq, communityId, coreKey, blobsKey, defaultChannelId, hostKey}` do host; runtime e tópico do log ganham a comunidade no mesmo tick |
| Teste de fechamento | `core/test/admissao.test.ts` | §19.5 | dois nós, zero linha plantada; op sai da outbox, atravessa §16.2 e volta projetada; reconciliação limpa a fila |

### 46.1 Decisões e por que são estas

| Decisão | Justificativa de engenharia | Justificativa normativa |
|---|---|---|
| `abrir` virou `CoreRuntime.openCommunity(row)` | Era a sugestão literal e a mais barata: o closure já tinha exatamente as dependências que o runtime guarda. `register` continua separado para que o chamador decida o que fazer com falha (degraded no boot, erro nomeado no create/redeem) | §3.3 fases `open`+`host-mode`; §10.2 (`manifest.communities` é a enumeração autoritativa) |
| **Host também tem outbox** | Sem fila não há `authorSeq` durável (§7.5): a primeira op síncrona do host reusaria o 1 e viraria `E_DUPLICATE` — a gênese consumiu 1..6 fora da ponte. Com fila, o host usa a MESMA ponte de submissão do membro (`submitSync`), com porta local em vez de RPC | §11.2 ("uma outbox por comunidade"); contrato de `CommunityHandle.outbox` já dizia "presente quando a instalação escreve nela" — e agora ela escreve |
| Rate limit pré-membro **uma** vez, node-level, antes do decode | Contar duas vezes (transporte + manager) reduziria pela metade tetos normativos. O manager fica sem o par justamente para não duplicar | §14.4 ordem 1→2; §12.6 declara os valores, não o ponto do fio — emendado |
| Orçamento de conexões **por tópico de convite** | Pré-redeem não há comunidade nomeada para o candidato; o tópico é o agrupador disponível dos dois lados, e cada tópico pertence a uma comunidade só | §12.6 diz "por comunidade hospedada" — emendado com o motivo |
| Firewall de conexão cede enquanto houver convite hospedado | O firewall age antes da conexão existir, e quem anuncia não sabe por qual tópico vieram (`peerInfo.topics` só vem do lado que procurou). Recusar na porta tornava o preview `banned` inalcançável para exatamente o caso que (5) cobre. Autorização por comunidade (1) continua canal a canal — banido não recebe bloco | §14.3(5) declara a exceção do canal; a realização na porta foi emendada com o custo declarado (handshake a mais, dado nenhum) |
| Tópicos são **dica**, não filtro: conexões são reavaliadas contra todas as comunidades | O hyperdht deduplica conexão por par (fonte: `hyperswarm@4.17 index.js` `_connect`/`_handleServerConnection`) — a conexão da admissão É a mesma pela qual, depois do resgate, o log passa. Filtrar por tópico deixaria o resgatado sem primeira replicação | §14.3(1) decide por comunidade, independente de tópico; a emenda da réplica em branco (§45) cobre o resto |
| `replicate(mux)` **exatamente uma vez** por `(mux, comunidade)` — guarda absoluta | `attachTo()` do hypercore não é idempotente (fonte: `hypercore@11.35.1 lib/replicator.js`): rechamar cria peers duplicados que se matam — foi observado como tempestade de `peer-remove`. E o OPEN remoto sem `pair` registrado é **rejeitado sem buffer** (fonte: `protomux@3.11.0 index.js` `_requestSession`) — a corrida "host projeta antes do candidato registrar" é resolvida porque quem abre o canal de replicação do lado do candidato é o `onOpen` no instante do registro, e o par do host sobrevive à rejeição inicial (só sai com `detachFrom` ou stream morto) | §14.1 ("estar conectado a um par não é estar replicando" — e replicar uma vez basta); nenhuma regra exige retentativa |
| Anúncio é **reconciliado do DS**, nunca da ação local | Convite delegado é criado por membro que pode não ser o host: quem anuncia precisa saber do convite PELO LOG, não pela fronteira. O lote projetado é o ponto onde host e réplicas convergem | §12.2 passo 3 pertence ao host; A08 (o host valida pela chave pública e nunca conhece o segredo) |
| `defaultChannelId` = primeiro canal criado | A ordem de inserção de `ds.channels` é a ordem de aplicação do log; a gênese cria #geral primeiro. Campo respondido por §15.4 mas nunca definido | Emenda em §15.4 |
| Linha órfã limpa no boot por **armazenamento do core ausente** | §5.3 manda limpar; o critério honesto é "o core nunca chegou a existir". Só há caminho de produto quando o boot abre disco — com `openCore` injetado (teste) o diretório não prova nada, então a varredura não roda | §5.3 passo 2, literal |
| Perfil do fundador vem da identidade local; sem perfil, `'Fundador'`/0 | `member.join` exige `displayName` (R-27b verifica forma); §15.4 não pede nome no comando, e a identidade já o tem | §8.6 (`displayName` ≥ 2 cp); fallback é forma válida, nunca silêncio |
| `invite.resolve` exige identidade apesar da classe open | O `liveProof` amarra `candidatePk` (T-06): sem par Ed25519 local não há prova. A classe open diz que o comando não muda estado — não que dispense chave | §12.3 passo 3; `E_NO_IDENTITY` do catálogo |

### 46.2 O que mudou no normativo

| Documento | Mudança |
|---|---|
| `docs/backend-v2.md` §14.3 | emenda datada com a **realização de (5) na porta de conexão**: firewall cede enquanto houver convite ativo hospedado; autorização por comunidade (1) permanece canal a canal, custo declarado |
| `docs/backend-v2.md` §12.6 | emenda datada com três pontos do fio: rate limit node-level único antes do decode; orçamento de conexões por tópico de convite; prova errada fecha sem resposta útil |
| `docs/backend-v2.md` §15.4 | `defaultChannelId` definido na linha de `community.create`: primeiro canal criado (ordem de aplicação do log) |

### 46.3 O que continua pendente

| Pendência | O que falta | Quem fecha |
|---|---|---|
| ~~`query.invites` (§15.6)~~ | **implementada em 2026-08-22 — §49**: DS + `invite_secrets`, com `codeAvailable` | — |
| ~~Job de expiração de convite (§22.2)~~ | **implementado em 2026-08-22 — §49**: `invite.topicSweep` no runner de jobs | — |
| ~~Core de blobs pela rede (§13)~~ | **implementado em 2026-08-22 — §47**: `BlobManager` composto no boot sobre o core local de §13.1; stage appenda fatias no core, download puxa blocos pela replicação com teto e hash; os três tópicos de §14.1 na DHT | — |
| Probe de NAT, descoberta da continuação, escalonador, presença | herdados de §45.3 sem mudança | ver §45.3 |

---

## 47. Anexos ponta a ponta — o core de blobs sai do cabo e entra na rede 2026-08-22

**Gate de entrada:** nenhum gate específico — o terceiro tópico de §14.1, pendente desde
§45.3 e herdado como pendência de §46.3. As peças locais existiam e estavam testadas
(`BlobManager` com ticket/staging/cache, o roteador de anexos com a barreira de §13.7,
`member_blobs_core` gravado no create/redeem); o que não existia era o core de blobs real,
o boot que o constrói e a rede que o replica. Nenhum módulo novo em camada — as portas
entraram em `l2/blobs` e as juntas na raiz de composição; barreira inalterada
(`§4 ok — 75 arquivo(s), L0:8 L1:6 L2:12 L3:4 + raiz de composição (5 arquivo(s))`); suíte
769 → **776 testes, 0 falha** — inclui o teste de fechamento `core/test/anexos-rede.test.ts`:
dois nós em `hyperdht/testnet`, zero linha plantada, pick → stage → `message.send` com
anexo → o outro nó baixa os blocos **do core do autor** pela mesma conexão da comunidade,
com hash verificado. Harness do G12 rebuildado e reexecutado nos dois perfis (6/6).

| Entrega | Onde | Seção | Teste/evidência |
|---|---|---|---|
| Portas do core de blobs (`BlobsWriterPort`/`BlobsReaderPort`) | `core/src/l2/blobs/index.ts`; adaptadores Hypercore em `blobCorePorts` (`composition/ports.ts`) | §13.1, §13.4 | armazenamento em `<cores>/blobs/<blobsCoreKeyHex>` (§10.1); writer por semente, reader esparso por chave pública |
| Core local nasce do manifest | `CoreRuntime.openCommunity`: decifra `secret_seed_enc` com `aeadOpenPacked`, deriva o par e só anexa se a chave **for** a publicada no log | §5.2, §10.2, §13.1 | divergência semente↔chave não escreve em core algum; falha de blob não derruba a comunidade |
| Stage entra no core | `BlobManager.stage` resolve o escritor pelo escopo do ticket e appenda fatias de 64 KiB; `blobId` vira o recorte real | §13.2 passo 5 | `attachments.test.ts`: `blockLength = ⌈bytes/65536⌉`, concatenação das fatias = original |
| Tópico de blobs na DHT | `attachLocalCore` anuncia (`server`) ao abrir a comunidade; `download` procura (`client`) | §14.1 linha 2 | `anexos-rede.test.ts` — o candidato encontra o core do autor sem configuração nenhuma |
| Replicação no mux das comunidades | `transport.avaliar` → `blobs.serveMux(mux)`; done-set por `(mux, core)`; `forgetMux` no fechamento do stream | §16.1, §14.1 | blocos chegam pela conexão JÁ VIVA da admissão/log — hyperdht deduplica por par, tópico novo não traz conexão nova |
| Download de verdade | `#baixarPelaRede`: faixa inclusiva traduzida na fronteira L0, teto sobre os bytes recebidos, hash sobre o recorte, arquivo no cache de §10.1 | §13.4 passos 3–7 | unidade (`anexos-core.test.ts`): feliz, teto (`corrupt`/size), hash (`corrupt`/hash), prazo (`unavailable`/`E_NO_PEERS`); rede: bytes idênticos aos originais |
| Eventos de §15.5 do download | porta `onEvent` injetada no manager; rota viaja FORA do payload | §15.5, §15.1 regra 2 | `blob.completed`/`attachment.corrupt`/`blob.unavailable` com os campos exatos da tabela |
| Superfície de anexos composta no boot | `blobAttachmentPort` (agora multi-comunidade via `blobsCoreKeyOf`) + `viewAttachmentResolver` (consulta `attachments` na `view.db`) ligados ao roteador; `pickFile`/`onReveal` injetados em `BootDeps` | §13.3, §13.7, §15.4 | `name`/`sizeBytes`/`hash`/faixa vêm da mensagem projetada, nunca do renderer; caminho nunca cruza IPC-R |
| Defeito latente do roteador corrigido | `commands.ts`: `attachment.blob` levava só o quádruplo — o encode real (`writeBlobRef`) exige a chave e lançaria | §7.2.1, §7.4.1 | payload completo asserido no teste de barreira |
| Defeito latente do resgate corrigido | `admission.ts` derivava o par de blobs com `deriveInviteKeypair` (que deriva de `BLAKE2b(seed)`) — o `core_key` publicado não era recuperável da semente cifrada | §5.2 tabela fechada, §13.1 | `ed25519_keypair_from_seed(seed)` direto; o boot agora reabre o core do resgatado (asserção no teste de rede) |

### 47.1 Decisões e por que são estas

| Decisão | Justificativa de engenharia | Justificativa normativa |
|---|---|---|
| O conteúdo vive em **blocos do próprio hypercore**, sem `hyperblobs` | Uma dependência nova para representar o mesmo conteúdo que o core já endereça é custo sem propriedade nova; fatia fixa de 64 KiB torna `blockOffset`/`blockLength` determinísticos dos dois lados, sem metadado lateral | §13.2 dizia "hyperblobs.put" sem exigir o pacote; o fio (`AttachmentRef`, §7.2.1) nunca mudou — emenda registrada lá declarando a equivalência e a condição (a faixa devolve os bytes do hash) |
| Quem **tem** o core anuncia; quem quer baixa procura — nada mais entra na DHT | O dono tem tudo desde o boot da comunidade; cliente para quem não precisa seria tráfego e metadado de graça | §14.1: "quem tem, ou quer, algum anexo" — os dois papéis, e só eles |
| Tópico com prefixo de domínio (`blob-discovery/1`) | DiscoveryKeys reais de comunidades já ocupam tópicos; colisão acidental entre um log e um core de blobs misturaria réplicas | §14.1 nomeia `discoveryKey(memberBlobsKey)` como conceito; a forma concreta foi emendada com o mesmo racional do tópico de convite (`invite-topic/1`) |
| A marcação de replicação mora no **manager**, não no transporte | `serveMux` é chamado a cada avaliação de conexão e o leitor pode nascer DEPOIS do mux existir (download pedindo blob de conexão antiga). Um done-set por mux dá o "uma vez por (mux, core)" de graça | Lições de §45: `attachTo()` não é idempotente e OPEN sem pair é rejeitado — replicar uma vez basta e registrar cedo evita a corrida |
| Faixa **inclusiva** na porta, meio-aberta no hypercore | `toLength = end − start` no vendor: pedir `0..N−1` direto deixaria o último bloco de fora com `done()` resolvido — defeito observado, não teorizado | §13.4 passo 3 pede "por range"; a tradução de convenções pertence à fronteira que importa o vendor (L0), não a cada chamador |
| Eventos saem por porta injetada, com rota fora do payload | O manager é L2 e não conhece fan-out; acrescentar `communityId` ao dado inventaria superfície além da tabela | §15.5 é tabela **fechada**; §15.1 regra 2 separa rota de payload |
| `pickFile`/`onReveal` continuam injetados no boot | O diálogo e o `shell.open` são do main via IPC-M; o shell Electron ainda é stub — inventá-los aqui seria fingir fronteira que não existe | §13.3 (ticket nasce no main), §15.7 |
| Falha de blobs não derruba a abertura da comunidade | Log e anexos são cores diferentes por desenho; uma instalação com `member_blobs_core` ilegível ainda lê, projeta e envia texto | §3.3 fase `open` (degradado por comunidade); §13.1 (ownership local, não da comunidade) |

### 47.2 O que mudou no normativo

| Documento | Mudança |
|---|---|
| `docs/backend-v2.md` §13.2 | emenda datada: `hyperblobs.put` realizado por fatias de 64 KiB appendaris no core do autor; `blobId` = recorte resultante; equivalência declarada com a condição do hash |
| `docs/backend-v2.md` §13.4 | emenda datada: passos 2–3 realizados (tópico com prefixo, dono anuncia/procurador busca, replicação no mux de §16.1 uma vez por `(mux, core)`, faixa inclusiva traduzida na fronteira) |
| `docs/backend-v2.md` §14.1 | emenda datada na tabela: realização da linha "core de blobs" — forma concreta do tópico e papéis server/client |
| `docs/backend-v2.md` §10.2 | nota na linha de `member_blobs_core`: cifra empacotada `nonce‖ciphertext‖tag` (sem coluna de nonce) |

### 47.3 O que continua pendente

| Pendência | O que falta | Quem fecha |
|---|---|---|
| ~~Produtores de `blob.progress` / `blob.peerLost`~~ | **implementados em 2026-08-22 — §49**: bitfield local e remoto por par, loop de 500 ms | — |
| ~~GC de cores de blobs remotos~~ | **implementado em 2026-08-22 — §49**: `gcReaders` no job `blob.gc` | — |
| ~~Cota no `blob.stage` (`E_QUOTA_EXCEEDED`, §15.4)~~ | **implementada em 2026-08-22 — §49**: antecipação advisória de R-14 no stage | — |
| `Diagnostics` e `RelayVolunteer` chegam injetados | resto da linha de §44.3: sonda de NAT real e consentimento; o `BlobManager` saiu dessa lista nesta fase | fase de mídia pela rede |
| ~~Índice para resolver anexo sem comunidade~~ | **criado em 2026-08-22 — §49**: `idx_attachments_ref(blobs_core_key, blob_id)` | — |

---

## 48. A semente do core de blobs volta a ser derivada da identidade 2026-08-22

**Gate de entrada:** nenhum gate específico — achado de §47, registrado só agora. O código
que §46 escreveu (`community.create`) e §47 corrigiu (`invite.redeem`) criava o core de
blobs do membro com **semente aleatória**, selada pela Data Key em
`member_blobs_core.secret_seed_enc`; o normativo (§13.1, §5.2 linha `ns/memberblobs/1`,
§19.1 passo 3) sempre disse **derivada** de `identitySeed ‖ communityId`. A divergência não
era cosmética: com semente sorteada, quem restaurasse a identidade numa instalação nova sem
o `manifest.db` ficaria sem os próprios cores de blobs para sempre — o backup de §5.5
carrega `identitySeed` e a lista de comunidades, e **nunca** carregou essa semente. A
propriedade prometida por §13.1 ("recuperável por ele em qualquer reinstalação a partir do
backup de identidade") simplesmente não valia no código. Nenhum módulo novo em camada;
barreira inalterada (`§4 ok — 75 arquivo(s), L0:8 L1:6 L2:12 L3:4 + raiz de composição
(5 arquivo(s))`); suíte 776 → **778 testes, 0 falha**. Harness do G12 rebuildado e
reexecutado nos dois perfis (6/6).

| Entrega | Onde | Seção | Teste/evidência |
|---|---|---|---|
| Derivação única, em um lugar | `memberBlobsKeyPairFor` + `identitySeedOf` em `composition/community.ts`, sobre o `deriveMemberBlobsKeypair` que já existia em `l2/blobs` | §5.2, §13.1 | `identitySeed` = 32 primeiros bytes da secret key Ed25519 (`sodium` guarda `seed ‖ publicKey`), o mesmo valor que §5.5 exporta |
| `community.create` deriva o core do fundador | `createCommunity`: `newKeypairFromRandomSeed` **removido**; a chave que entra no `member.join` da gênese é a derivada | §19.1 passo 3 | `blobs-semente.test.ts` (1): chave publicada no log = `deriveMemberBlobsPublicKey`, e a linha do manifest guarda a mesma semente |
| `invite.redeem` deriva o core de quem entra | `AdmissionService.redeem`: semente derivada no lugar de `randombytes_buf` | §12.4, §13.1 | `admissao.test.ts` e `anexos-rede.test.ts` seguem verdes sem mudança — nenhum dos dois plantava a linha, os dois passam pelo caminho de produto |
| Boot deriva e **repara** o atalho | `CoreRuntime.openCommunity`: semente vem da derivação; guarda passa a comparar com a chave **publicada no log**, com a linha local como cópia enquanto o log ainda não tem a entrada do próprio; linha ausente/ilegível é reescrita | §10.2, §13.1, §3.3 `open` | `blobs-semente.test.ts` (2): mesmo `dataDir`, `manifest.db` e `view.db` apagados e recriados como `identity.import` os recria (só `communities`) — o boot reabre o writer e reescreve a linha |

### 48.1 Decisões e por que são estas

| Decisão | Justificativa de engenharia | Justificativa normativa |
|---|---|---|
| **Conformar o código ao normativo** (caminho (a)), não emendar §13.1 para legitimar a semente aleatória | Aleatória exige que um segredo local sobreviva a tudo para o dado ser recuperável; derivada não exige nada além do que o backup de identidade já carrega. E o formato de §5.5 — `identitySeed` + `{communityId, coreKey, blobsKey, communitySeed?}` — só fecha se a semente for derivável: emendar o normativo obrigaria a inventar um campo novo no bundle **ou** aceitar perda de dado do usuário | §13.1 e §19.1 passo 3 dizem "deriva"; §5.2 é tabela **fechada** e a linha `ns/memberblobs/1` existia sem nenhum consumidor — texto normativo morto é sintoma, não licença |
| A linha `member_blobs_core` **fica**, como atalho e verificação cruzada | Evita derivar a cada abertura e, principalmente, preserva a coluna que o boot usa para conferir a chave antes de escrever. Removê-la seria mudança de schema numa tabela fechada em §10.2, com emenda própria, sem propriedade nova em troca | §10.2 é tabela fechada; manter o schema é a menor alteração coerente. Emenda datada declara o novo status da linha (derivada, reparável) |
| A guarda do boot passa a comparar com a chave **publicada no log** | A linha local é cópia; a fonte que toda réplica enxerga é o `member.join`/`member.setBlobsCore`. Sem isso, o caminho de restauro (que não tem linha nenhuma) não teria contra o que se defender — e a guarda de §47 contra corrupção local se perderia justamente onde ela passa a importar | §13.1 ("publicado no log … recuperável por toda réplica"); a guarda de §47 não é enfraquecida, é ancorada na fonte mais forte |
| Boot **reescreve** a linha quando ela falta ou não decifra | É reparo de um derivado, não migração de dado: o valor recriado é função da identidade e do `communityId`, então não há decisão a inventar. É este passo que devolve os anexos a quem restaurou a identidade | §5.3 já trata linha órfã por reparo no boot; §13.1 emendada declara o comportamento |
| Chave de blobs determinística da identidade **não** é regressão de privacidade | O correlacionador seria "mesma pessoa em duas comunidades" — mas a chave já é **pública** desde o `member.join`, e continua uma chave distinta por comunidade (o `communityId` entra na derivação). Nada que estava privado passa a ser observável | §13.1 publica `blobsCoreKey` no log por desenho; §5.2 dá namespace por comunidade — a separação de domínio é o que evita a chave única entre comunidades |
| Sem migração para instalações anteriores | Nenhum binário publicado; um diretório de desenvolvimento criado antes desta fase tem no log uma `blobsCoreKey` aleatória que a derivação não reproduz — a guarda recusa o writer, `blob.stage` responde `E_NO_BLOBS_KEY` e o resto da comunidade segue. Recriar o diretório é o caminho | Mesma decisão de §10.2.1: sem release, não se inventa migração |

### 48.2 O que mudou no normativo

| Documento | Mudança |
|---|---|
| `docs/backend-v2.md` §13.1 | emenda datada: a derivação é a única fonte da semente; a linha `member_blobs_core` é atalho e verificação cruzada; a guarda do boot compara com a chave publicada no log e repara a linha ausente/ilegível; racional de privacidade (a chave já é pública) registrado |
| `docs/backend-v2.md` §10.2 | nota na linha de `member_blobs_core`: linha derivada, recriável pelo boot — não é fonte única |

### 48.3 O que continua pendente

| Pendência | O que falta | Quem fecha |
|---|---|---|
| `identity.import` que realmente reabre as comunidades | §5.5 define o bundle e o `IdentityStore` já exporta/importa a semente; o que não existe é o caminho que recria as linhas de `communities` a partir dele e chama `openCommunity`. O teste de §48 simula esse passo à mão | fase de identidade/superfícies |
| `member.setBlobsCore` sem produtor | o `fold` aplica a op e o boot já compara contra a chave corrente do log, mas nenhuma superfície a emite — trocar de core é hoje só um caminho de leitura | superfícies de comunidade |
| Herdadas de §47.3 | progresso/`peerLost`, GC de readers remotos, cota do `stage`, `Diagnostics`/`RelayVolunteer`, índice de anexo sem comunidade | ver §47.3 |

---

## 49. As pendências pequenas de superfície: convites listáveis, jobs, cota e GC 2026-08-22

**Gate de entrada:** nenhum gate específico — seis pendências nomeadas em §46.3 e §47.3,
todas de baixo custo e alto valor de superfície. Um módulo novo em camada nenhuma: entrou
`core/src/composition/jobs.ts` na raiz de composição (§4 ok — 76 arquivo(s), L0:8 L1:6 L2:12
L3:4 + raiz de composição (6 arquivo(s))); suíte 778 → **787 testes, 0 falha**, com
`core/test/pendencias-superficie.test.ts` cobrindo as seis. G12 rebuildado e reexecutado nos
dois perfis (6/6).

| Entrega | Onde | Seção | Teste/evidência |
|---|---|---|---|
| `query.invites` | `queryInvitesPort` (`composition/ports.ts`) + comando standard em `l3/ipcRenderer/commands.ts` | §15.6, §12.2 | fato do log pelo DS; `code` reconstruído de `manifest.invite_secrets` com `inviteSecretToCode`; `codeAvailable:false` onde o segredo não está (U-04). Comunidade desconhecida é `E_NOT_FOUND` |
| Vida do convite num lugar só | `isInviteLive` em `l2/invites`, usada pelo `syncAnnouncements` do `InviteManager` e pela reconciliação da `AdmissionService` | §12.3, §22.2 | tabela-verdade no teste: revogado, expirado (`<=`), esgotado |
| `invite.topicSweep` (15 min) | `AdmissionService.sweepInviteTopics` + `startJobs` | §22.2 | o job derruba o anúncio do convite vencido **sem lote novo no log** — só o relógio andou |
| Runner de jobs de §22.2 | `composition/jobs.ts`; `runtime.jobs`, parado no `close` | §22.2, §22.5 | rearme após cada execução (o `schedule` de `BootDeps` é de um disparo); `runNow` depois do `stop` não roda |
| `E_QUOTA_EXCEEDED` no `blob.stage` | porta `storageUsedOf` no `BlobManager`, ligada ao `member.storageUsedBytes` do DS | §15.4, §13.8, R-14 | recusa **antes** de gravar (nada vai para o cache nem para o disco); passa quando cabe |
| `blob.progress` / `blob.peerLost` | `rangeStatus` na porta de leitura (bitfield local + bitfield remoto por par), loop de 500 ms em `BlobManager` | §13.4 passo 4, §22.1 | `progress`, `bytesDownloaded`, `peers`, `hostAvailable` de dado real; par que some vira `peerLost{remaining}`; rota fora do payload |
| GC dos leitores esparsos | `BlobManager.gcReaders` no job `blob.gc` | §22.4 | fecha o core alheio ocioso, esquece a marcação por mux, sai do tópico; o download seguinte reabre |
| Protegido do LRU do cache | `anexoProprioVivo` (boot) sobre `attachments ⋈ messages` | §13.7 regra 2, §22.4 | anexo meu com mensagem viva (sem `deleted_at`) nunca é coletado |
| Índice do resolver de anexos | `idx_attachments_ref(blobs_core_key, blob_id)` em `view.db` | §10.3, §15.4 | `EXPLAIN QUERY PLAN` usa o índice; sem `SCAN attachments` |

### 49.1 Decisões e por que são estas

| Decisão | Justificativa de engenharia | Justificativa normativa |
|---|---|---|
| `query.invites` lista **também** revogado/expirado/esgotado | A resposta de §15.6 carrega `revokedAt`, `expiresAt`, `maxUses` e `uses`: campos que só fazem sentido se o item aparecer. Filtrar aqui esconderia da UI exatamente o que ela precisa desenhar | §15.6 define o schema do item, não um filtro; quem filtra anúncio é §22.2, que é outra coisa |
| `codeAvailable` é campo, não erro | O convite é fato do log em toda réplica; o segredo é local. "Tenho o convite, não tenho o código" é o estado normal de quem replicou a comunidade | §12.2 ("o código só existe na instalação de quem o criou"), delta U-04 |
| `isInviteLive` extraída para `l2/invites` | A mesma regra decidia duas coisas em dois lugares (preview de §12.3 e anúncio na DHT) e já tinha divergido em forma. Uma função, dois chamadores | §4: regra de domínio de convite mora em `invites`, não na raiz de composição |
| O job existe **por causa da expiração**, não da revogação | Revogar e esgotar são registro no log: a reconciliação por lote projetado já os derruba. Expirar é a passagem do tempo — numa comunidade parada, nenhum lote acontece e o tópico ficaria anunciado indefinidamente | §22.2 nomeia o job; a emenda registra qual dos três desfechos realmente depende dele |
| Relógio do sweep é o **local do host** | Quem anuncia é o host, e é o relógio dele que decide o que ele publica. Usar `hostTs` do último registro faria o anúncio depender de haver registro — a própria condição que o job existe para dispensar | §12.3 usa `hostNow` no preview (decisão de admissão, do host); o anúncio é da mesma parte |
| Jobs periódicos por **rearme**, não `setInterval` | O `schedule`/`cancel` de `BootDeps` é o cabo de um disparo que o resto do núcleo já usa (e que o teste injeta como no-op determinístico). Rearmar depois de cada execução dá periodicidade **e** impede sobreposição de graça | §22.2 fixa os períodos; §22.5 exige que nada sobreviva ao escopo — `stop()` no `close` do runtime |
| Cota antecipada no stage é **advisória** | A decisão continua no `fold` (R-14 no `message.send`), onde ela é determinística e verificável por toda réplica. O que a antecipação evita é escrever 5 GiB no core para a mensagem ser recusada depois | §8.7 é exatamente este padrão (validação síncrona antecipa o que o `fold` decide); §15.4 lista `E_QUOTA_EXCEEDED` na linha do `blob.stage` |
| `peers`/`hostAvailable` saem do bitfield, ou não saem | §13.4 é explícito: "dados reais, não estimativa". Leitor sem `rangeStatus` (rig sem replicação) não publica evento nenhum — silêncio é melhor que número inventado | §13.4 passo 4, literal |
| `bytesDownloaded` = blocos locais × 64 KiB, com teto no declarado | A fatia é fixa por §13.2 (emenda de §47), então a conta é exata salvo o último bloco, que é parcial. O teto impede prometer mais bytes do que o anexo tem | §13.2 emendada (fatias de `BLOB_CHUNK_BYTES`); §13.4 passo 5 já trata o teto como limite duro |
| GC fecha leitor, **nunca** o core local | O core local é o que serve a comunidade e sustenta a regra 2 de §13.7; fechá-lo tiraria do ar os anexos do próprio autor | §13.7 regra 2; §22.4 fala de cache e staging, e a emenda estende à mesma família de recurso |
| Ao fechar um leitor, esquecer a marcação por mux | `attachTo` não é idempotente (lição de §45) — mas também não sobrevive ao `close`: sem limpar o done-set, um core reaberto nunca voltaria a replicar | §14.1/§16.1; é o outro lado da mesma lição |
| Índice novo **sem** bump de `VIEW_SCHEMA_VERSION` | `CREATE INDEX IF NOT EXISTS` roda em toda abertura: bases existentes ganham o índice sem reprojetar. O bump é para conteúdo derivado diferente, e nenhum byte derivado mudou | §10.3 lista os índices por tabela; §10.5 define reprojeção por descompasso de schema **de conteúdo** |

### 49.2 O que mudou no normativo

| Documento | Mudança |
|---|---|
| `docs/backend-v2.md` §22.2 | emenda datada na linha `invite.topicSweep`: revogar/esgotar já saem pela reconciliação do lote; o job existe pela expiração, com o relógio local do host |
| `docs/backend-v2.md` §13.8 | emenda datada: `blob.stage` antecipa R-14 (`E_QUOTA_EXCEEDED`) com `storageUsedBytes` do DS, advisória no sentido de §8.7 |
| `docs/backend-v2.md` §22.4 | emenda datada: GC dos leitores esparsos de cores alheios — o que fecha, o que nunca fecha e por que a marcação por mux é esquecida junto |
| `docs/backend-v2.md` §15.5 | emenda datada nas linhas de blob: o campo viaja como `blobIdHex`; `peers` é contagem |
| `docs/backend-v2.md` §10.3 | `idx_attachments_ref(blobs_core_key, blob_id)` na linha de `attachments` |

### 49.3 O que continua pendente

| Pendência | O que falta | Quem fecha |
|---|---|---|
| `staging.gc` e os demais jobs de §22.2 | `outbox.expire`, `host.inactivity`, `succession.check`, `removed.purge`, `db.maintenance`, `log.rotate`, `ds.snapshot` — o runner existe e recebe cada um como uma linha; falta o corpo de cada job e, no `staging.gc`, o `hasReference` sobre a `view.db` | fase de jobs |
| `blob.progress` de download local | o loop só existe no caminho de rede; o caminho de busca local (rig) resolve antes de qualquer tick | irrelevante em produto; morre quando o caminho local sair |
| `identity.import` que reabre as comunidades | herdada de §48.3, sem mudança | fase de identidade/superfícies |
| `member.setBlobsCore` sem produtor | herdada de §48.3, sem mudança | superfícies de comunidade |
| Escalonador de §14.2, presença, sonda de NAT | herdadas de §45.3/§47.3 | ver §45.3 |

---

## 50. As consultas de leitura de §15.6 — estrutura, mensagens e derivados 2026-08-22

**Gate de entrada:** nenhum gate específico. A lacuna era de tamanho, não de decisão: de ~20
consultas de §15.6 existiam **três** (`query.search`, `query.community`, `query.invites`), e o
`projector` já materializava tudo que as outras precisam. Esta fase entrega a fatia de
**estrutura e mensagens** — oito consultas — e o produtor que faltava para uma delas.
Um módulo novo na raiz de composição (`core/src/composition/queries.ts`) e um em `l1/fold`
(`links.ts`); barreira `§4 ok — 78 arquivo(s), L0:8 L1:6 L2:12 L3:4 + raiz de composição
(7 arquivo(s))`; suíte 787 → **795 testes, 0 falha**, com `core/test/queries-leitura.test.ts`
percorrendo o caminho de produto inteiro (comunidade nasce por `community.create`, mensagens
entram pela outbox, o `projector` materializa, e só então as consultas respondem).

| Entrega | Onde | Seção | Teste/evidência |
|---|---|---|---|
| `query.structure` | `queryReadPorts.structure` | §15.6, §23.2 | categorias e canais em `rank` crescente, `readOnly` calculado para quem pergunta, `muted`/`collapsed`/`unread` vindos do manifest |
| `query.messages` | idem | §15.6, §23.3 | cursor `(seq,id)` bidirecional, lote 50, `hasMore`; a página sai sempre em `seq` crescente |
| `query.message` | idem | §15.6 | reações agregadas com `mine`, anexo com estado do cache, thread enraizada, citação de mensagem removida |
| `query.pinned` / `query.files` / `query.links` | idem | §15.6, §23.2 | `seq` decrescente, cursor de 25 |
| `query.thread` | idem | §15.6 (DR-48) | raiz + respostas em `seq` crescente, `replyCount`, participantes, `unread` local |
| `query.reactors` | idem | §15.6 (DR-47) | total e os 24 primeiros por `at` |
| Extração de links no `fold` | `core/src/l1/fold/links.ts` + efeitos em `message.send`/`edit`/`delete` | §15.6.1 (DR-38) | `message_links` tinha tabela, tipo de efeito e índice — e **nenhum produtor**: `query.links` responderia vazio para sempre |
| Leitura do estado local | `ManifestDb.getReadState`/`getThreadReadState`/`isChannelMuted`/`collapsedCategories` | §10.2 | linha ausente é o estado inicial, não erro |
| `nickname` no `UserRef` | `queryUserRef` (`composition/ports.ts`) | §15.6 | vem do roster do DS; ausente quando não há |
| `VIEW_SCHEMA_VERSION` 3 → 4 | `core/src/l0/view/index.ts` | §10.3, §10.5 | conteúdo derivável mudou: uma `view.db` da versão 3 tem `message_links` vazia para toda mensagem já projetada |

### 50.1 Decisões e por que são estas

| Decisão | Justificativa de engenharia | Justificativa normativa |
|---|---|---|
| As consultas moram na **raiz de composição**, não em L2 | Cada uma junta três fontes que não se conhecem: `view.db` (conteúdo), DS (quem é quem) e `manifest` (o que é local). Nenhum módulo de camada pode importar as três — é exatamente a definição de raiz de composição | §4 (a raiz importa qualquer módulo e não é importada); §8.4 (quem materializa é o `projector`, quem recorta é quem lê) |
| Ordenação e paginação vêm de §23, não de preferência | As duas tabelas de §23.2/§23.3 são fechadas; a página de mensagens sai em `seq` crescente **mesmo quando pedida para trás**, para a UI não inverter nada | §23.2 linha "Mensagens de canal"; §23.3 "nunca há paginação numerada" |
| Cursor é `base64url({seq,id})` e **opaco** | O par sobrevive a reprojeção (ids são determinísticos, §7.3) e não vaza offset. Forma inválida recusa na hora | §15.6.1, literal: `E_BAD_CURSOR` e a UI recomeça |
| `readOnly` é **para quem pergunta** | O campo é `boolean`, não uma lista: o único sentido possível é "este canal é somente-leitura para mim", calculado sobre os cargos que eu tenho AGORA | §6.7 (`readOnlyForRoleIds`), §15.6 (schema do canal) |
| A extração de links entrou no `fold`, não na consulta | §15.6.1 diz "o `fold` extrai … no efeito de `message.send`/`message.edit`". Calcular na leitura daria resultado diferente por versão de binário e deixaria `message_links` (tabela, efeito e índice já existentes) morta para sempre | §15.6.1 literal; §8.0 (o mesmo registro produz o mesmo estado em toda réplica) |
| `host` é o **hostname**, não o registrable domain | Registrable domain exige PSL, e PSL muda com o tempo: o mesmo log daria estados diferentes em binários diferentes. Entre derivado instável e derivado exato porém mais longo, o `fold` fica com o estável | §8.0 (determinismo é a propriedade central do `fold`); emenda registrada em §15.6.1 |
| Bump de `VIEW_SCHEMA_VERSION` | Aqui o conteúdo **derivável** mudou (links de toda mensagem antiga faltam), que é o critério do bump — diferente do índice de §49, onde nenhum byte derivado mudou | §10.3/§10.5 (descompasso de schema ⇒ reprojeção total no boot) |
| `collision` continua `false`, e isso virou emenda | L-5 manda o `fold` marcar colisão de `displayName`; nem o DS nem a coluna da `view.db` têm produtor. Calcular na leitura seria regra de domínio fora do `fold` | §6.1 L-5; §4 e §8.0 — a lacuna é do `fold` e fecha lá |
| `availablePeers`/`hostAvailable` do `AttachmentDto` fora de download são `0`/`false` | São leitura do bitfield vivo (§13.4 passo 4). Não existe registro persistente de pares, e §13.4 é explícito: dado real, não estimativa | §13.4 passo 4; emenda em §15.6.1 declarando o significado |
| `replyTo.author` é opcional | Há um caso, e um só, em que não há autor a nomear: a mensagem citada não está projetada aqui. `deleted: true` seria mentira — ela pode estar viva e ainda não replicada | §15.6.1 (`excerpt: null`/`deleted` cobrem a remoção, não a ausência) |

### 50.2 O que mudou no normativo

| Documento | Mudança |
|---|---|
| `docs/backend-v2.md` §15.6.1 | emenda datada na extração de links: `host` é o hostname (com o motivo de determinismo), URL repetida entra uma vez, edição reescreve e tombstone remove |
| `docs/backend-v2.md` §15.6 | emenda datada em `UserRef.collision` (sempre `false` até o `fold` marcar L-5) e em `AttachmentDto.availablePeers`/`hostAvailable` (leitura viva; `0`/`false` fora de download) |

### 50.3 O que continua pendente

| Pendência | O que falta | Quem fecha |
|---|---|---|
| ~~Produtores de `unread`/`muted`/`collapsed`~~ | ~~as quatro tabelas locais de §10.2 são lidas mas ninguém as escreve: faltam `channel.markRead`, `thread.markRead`, `channel.setMuted`, `category.setCollapsed` (§15.4 "Preferências locais")~~ **entregue**, ver §53 | ~~fatia de preferências~~ |
| `voice` em `query.structure` (RT-05) | a ocupação por canal existe no lado host (`VoiceHostSessions`); falta a fonte para quem **não** hospeda | fase de presença |
| Colisão de `displayName` (L-5) | o `fold` precisa marcar `displayNameCollision` no DS e na `view.db`; a consulta já tem o campo | `fold` |
| ~~Comandos estruturais~~ | ~~`channel.create/update/move/delete`, `category.create/rename/delete`, `community.update` — a fatia de **escrita** desta mesma superfície~~ **entregue**, ver §51 | ~~próxima fatia~~ |
| Demais consultas de §15.6 | `query.members/member/roles/bans/timeouts/auditLog` entregues na §52; o estado local do leitor (outbox, communities, preferences, hostStatus, selfModeration, resolveMessageLink) entregue na §53 | ver §53.3 pelo que resta |
| Herdadas | §49.3 sem mudança (jobs restantes, `identity.import`, escalonador de §14.2) | ver §49.3 |

---

## 51. A escrita da estrutura: canais, categorias e `community.update` 2026-08-22

**Gate de entrada:** nenhum gate específico — a segunda metade da fatia de estrutura de §50.
Oito comandos ⏱ passam a existir na fronteira; a regra continua toda no `fold` (R-6, R-7,
R-20, R-26 e os limites de §8.6). Um módulo novo na raiz de composição
(`core/src/composition/structure.ts`); barreira `§4 ok — 79 arquivo(s), L0:8 L1:6 L2:12 L3:4
+ raiz de composição (8 arquivo(s))`; suíte 795 → **801 testes, 0 falha**, com
`core/test/estrutura-comandos.test.ts` conferindo cada comando pela leitura de §50
(`query.structure`), não por consulta de teste.

| Entrega | Onde | Seção | Teste/evidência |
|---|---|---|---|
| `channel.create` / `update` / `move` / `delete` | `composition/structure.ts` | §15.4, §7.4 | id derivado por §7.3; `rank` lido do DS depois da projeção; `E_CHANNEL_NAME_TAKEN`, `E_CATEGORY_NOT_FOUND` e `E_LAST_CHANNEL` vêm do `fold` |
| `category.create` / `rename` / `delete` | idem | §15.4 | as duas formas do delete, com `movedChannels`/`deletedChannels` **lidos** do estado projetado |
| `community.update` | idem | §15.4 | `manage_community`; update sem nenhum campo é `E_VALIDATION` |
| Dica de posição id → rank | `dicasDeRank` | R-20 | "depois de X" vira o par `(rank de X, rank do seguinte)` e cai **entre** os dois |
| `droppedQueued` do `channel.delete` | `Outbox.discardForChannel` | §11.7 | as ops enfileiradas para o canal viram `dropped{channel-deleted}` — o primeiro produtor desse motivo |
| `submitSync` devolve `authorSeq`/`opId` | `l2/communityClient` | §7.3 | é o que permite nomear a entidade criada sem esperar a projeção |
| **Defeito corrigido:** escopo de `authorSeq` escolhido pela forma do payload | `resolveScope` (`l2/communityClient/submit.ts`) | §7.5 | qualquer payload com `channelId` virava escopo de canal — logo `channel.update`/`move`/`delete` eram assinados com escopo errado e o `fold` os recusava com `E_VALIDATION{sequenceScope}`. Agora quem decide é o **kind** |

### 51.1 Decisões e por que são estas

| Decisão | Justificativa de engenharia | Justificativa normativa |
|---|---|---|
| A fronteira endereça por **id**, a op carrega **rank** — e a conversão é da composição | §15.4 fala `afterChannelId`; §7.4 carrega `afterRank`/`beforeRank`. Converter exige ler o DS, que nem o `opCodec` nem o renderer podem | §15.4 e §7.4, literais; §4 (quem lê o DS e monta a op é a raiz) |
| "Depois de X" manda **os dois** vizinhos | Só `afterRank` faria o item cair no fim do escopo quando o cliente estivesse atrasado; o par é o que `rankBetween` espera para inserir entre X e o seguinte | R-20 (a própria função documenta o caso do cliente atrasado) |
| `rank` e as contagens **esperam a projeção**, e somem se o prazo vencer | São decisão do `fold`. Recalculá-las aqui seria escrever R-20/R-7 uma segunda vez, e as duas cópias divergiriam no primeiro caso de borda | §8.0/§8.4; emenda em §15.4 declarando quando o campo existe |
| O id não espera nada | §7.3 o deriva de `communityId ‖ sequenceScope ‖ authorKey ‖ authorSeq`, e `authorSeq` é conhecido no instante da submissão. É a **mesma** função que o `fold` usa (`entityId`), não uma segunda implementação | §7.3 |
| `category.delete` tem duas formas, não três | §15.4 dá `moveChannelsTo` **ou** `deleteChannels:true`. Pedir as duas é entrada incoerente — e "qual vence" seria comportamento inventado | §15.4; emenda registrando a recusa |
| A lista de kinds escopados por canal existe **duas vezes**, com teste de igualdade | §4 não dá `fold` a `communityClient`, e a barreira recusou o import. Repetir a lista com um teste que compara as duas é mais honesto do que enfraquecer a fronteira | §4 (fronteira de camadas); §7.5 (a regra é uma só) |
| `channel.delete` derruba a fila **local** do canal | O canal deixou de existir: cada op enfileirada para ele viraria `E_CHANNEL_NOT_FOUND` no host, uma por uma, sem motivo nomeado para a UI | §11.7 (`channel-deleted`), que até aqui não tinha produtor |
| Permissão conferida na composição **e** no `fold` | A conferência local é advisória: dá o erro certo sem ida ao host. Quem decide é o `fold`, contra o DS do host no `hostTs` da admissão | §8.7 ponto 1; §7.4 coluna Perm. |

### 51.2 O que mudou no normativo

| Documento | Mudança |
|---|---|
| `docs/backend-v2.md` §15.4 "Canais e categorias" | emenda datada: `channelId`/`categoryId` sempre presentes (§7.3); `rank` e contagens dependem da projeção local e ficam ausentes se o prazo vencer; `category.delete` tem duas formas e pedir as duas é `E_VALIDATION` |
| `docs/backend-v2.md` §11.7 | emenda datada na linha `channel-deleted`: o produtor é o `channel.delete` local; tombstone feito por outra pessoa ainda não derruba a fila local |

### 51.3 O que continua pendente

| Pendência | O que falta | Quem fecha |
|---|---|---|
| `channel-deleted` por tombstone alheio | quando **outra** pessoa apaga o canal, a fila local segue até o host recusar; o lugar do descarte é o gancho de lote projetado (`notifyProjected`), que já existe | fase de jobs/eventos |
| Ordem de quem nasce sem dica | item criado sem `afterChannelId`/`afterCategoryId` cai no piso da escala de R-20 — que, em `rank` crescente (§23.2), é a **primeira** posição da lista. É o comportamento do `fold` desde G1; se a UX quiser "no fim", quem manda a dica é a UI | UX / `deltas-ux-v2.md` |
| Preferências locais | ~~`channel.markRead`, `thread.markRead`, `channel.setMuted`, `category.setCollapsed` — os produtores do que §50 já lê~~ **entregue**, ver §53 (junto com `nav.setActive` e `settings.*`) | ~~fatia de preferências~~ |
| Demais consultas e comandos de §15.6/§15.4 | membros, cargos e moderação **entregues na §52**; estado local do leitor **entregue na §53**; faltam `community.end`/`forget`/`activate` e `identity.*` | fatias seguintes |
| Herdadas | §50.3 sem mudança | ver §50.3 |

---

## 52. Membros, cargos e moderação — as superfícies de §15.4/§15.6 que decidem quem manda 2026-08-22

**Gate de entrada:** nenhum gate específico — terceira fatia do mesmo programa de §50/§51.
Onze comandos ⏱ de escrita (`role.create/update/move/delete`, `member.setRoles`,
`member.setNickname`, `mod.kick/ban/revokeBan/timeout/removeTimeout`) e seis consultas de
leitura (`query.members/member/roles/bans/timeouts/auditLog`). A regra continua inteira no
`fold`; módulo novo na raiz de composição (`core/src/composition/moderation.ts`) e acréscimo
a `queries.ts`. Barreira `§4 ok — 80 arquivo(s), L0:8 L1:6 L2:12 L3:4 + raiz de composição
(9 arquivo(s))`; suíte 801 → **812 testes, 0 falha**, com
`core/test/moderacao-superficie.test.ts` no caminho de produto inteiro (comunidade por
`community.create`, ops pela ponte ⏱, conferência sempre pela leitura de §15.6). G12
rebuildado nos dois perfis após a mudança.

| Entrega | Onde | Seção | Teste/evidência |
|---|---|---|---|
| `role.create` / `update` / `move` / `delete` | `composition/moderation.ts` | §15.4 | id derivado por §7.3 na hora; `rank` lido do DS depois da projeção; `affectedMembers`/`clearedChannelRefs` são o delta confirmado no estado projetado (F-31) |
| `member.setRoles` / `member.setNickname` | idem | §15.4 | `appliedRoleIds` é o conjunto efetivamente aplicado (§8.4.1 descarta o id desconhecido); apelido limpa com `null` |
| `mod.kick` / `ban` / `revokeBan` / `timeout` / `removeTimeout` | idem | §15.4 | ban de não-membro é APPLIED (R-28); contagens são o delta desta op — re-ban idempotente responde zero; hierarquia nunca duplicada (`E_FOUNDER_IMMUNE` veio do `fold`) |
| Permissões nomeadas → números de protocolo | `permissoesParaNumeros` | §9.1 | nome desconhecido é `E_VALIDATION{permissions}` ANTES de assinar — número inventado no log seria concessão silenciosa |
| `query.roles` | `queryReadPorts.roles` | §15.6, §23.2 | `rank` **decrescente**, permissões como nomes, `memberCount` do projector |
| `query.members` | idem | §15.6, §23.2/§23.3 | grupo pelo cargo de maior `rank`, alfabético por `nickname ?? displayName` com desempate por `handle`; offline agregado; cursor na ordem plana |
| `query.member` | idem | §15.6 | perfil completo; os campos `can*` usam a MESMA resolução de hierarquia do `fold` (`hierarchyTargetOf` + `authorizeOverTarget`), não uma segunda implementação |
| `query.bans` / `timeouts` / `auditLog` | idem | §15.6, §23.2/§23.3 | mais recente primeiro, cursor, lote 25 (teto); `expired` contra o `lastHostTs` interpretado |
| Enforcement de leitura (DR-25/T-44) | `exigir` sobre o DS local | §15.6.1, L-10 | sem `view_audit_log` (ou `ban_members`, para bans) as três listas respondem `E_PERMISSION_DENIED` |

### 52.1 Decisões e por que são estas

| Decisão | Justificativa de engenharia | Justificativa normativa |
|---|---|---|
| Mesma régua de §51: regra no `fold`, fronteira traduz e recorta | Os campos derivados (`rank`, `appliedRoleIds`, contagens) só existem depois que o `projector` alcança o `seq`; recalculá-los seria escrever R-12/R-16/R-28 uma segunda vez, e as cópias divergem no primeiro caso de borda | §8.0/§8.4; emendas datadas em §15.4 ("Cargos e membros" e "Moderação") declarando quando cada campo existe |
| As contagens de `mod.ban`/`revokeBan` são o **delta** da op | Um re-ban idempotente decide nada: responder "total da história" misturaria ops distintas numa resposta única e mentiria no caso mais comum, o retry | §8.4.1 (idempotência sem janela); emenda datada |
| Ban de não-membro **não é recusado na fronteira** | É ban preventivo — o mecanismo pelo qual a continuação carrega os bans da origem; recusar mataria a função sem ganho nenhum. Os demais `mod.*` de não-membro recusam, e isso veio do `fold` (`E_NOT_FOUND`) | R-28; §8.4.1 |
| Hierarquia NÃO é conferida duas vezes | A fronteira confere a permissão nomeada (erro certo sem ida ao host) mas nunca R-4/R-16: quem recusa com `E_HIERARCHY`/`E_FOUNDER_IMMUNE`/`E_HOST_IMMUNE`/`E_SELF_TARGET` é o `fold`. O teste fixou a ORDEM de §9.3: imunidade do Fundador antes da auto-referência | §8.7 ponto 1; §9.3 (ordem do estágio 12) |
| Permissões viajam como NOMES no IPC e como números na op | O número é constante de protocolo (§27.1) e material assinado; nome desconhecido recusa ANTES de assinar, porque número inventado no log é concessão silenciosa | §9.1 literal ("um `u8` fora de 0..16 é `E_VALIDATION`") |
| Os campos `can*` de `query.member` reusam `hierarchyTargetOf` + `authorizeOverTarget` | É affordance de UI ("posso tentar?"), não decisão — mas chamar a MESMA função do pipeline é a única forma de não implementar R-4/R-16 pela segunda vez. Sem alvo de hierarquia (cargo a si mesmo), "pode tentar" | §9.3; §8.7 (quem decide num comando real é o `fold`) |
| `query.members`: `roleId` filtra para UM grupo de portadores | A pergunta da UI é "quem tem X", não "quem é encabeçado por X"; a regra de agrupamento de §23.2 descreve o roster sem filtro | §23.2 linha "Membros" (sem filtro declarado — decisão registrada) |
| `presence` ausente e `onlyOnline` respondendo vazio | Presença é local e efêmera e não tem produtor desde §44.3. Campo sem fonte fica ausente; filtro sem fonte responde vazio — nunca valor inventado | Precedente §46/§50; §6.1 L-5 análogo (`collision`) |
| Bans/timeouts ordenados por `at` com cursor `{seq: at, id}` | As tabelas não têm `seq`; `at` é monotônico por R-1 e o desempate pela chave do alvo fecha a ordem total. Emendas datadas em §15.6 | §23.2 ("mais recente primeiro" é a propriedade; `seq` era o meio); §20.2 (`E_BAD_CURSOR` intacto) |
| `query.bans` só lista bans vivos | O schema da resposta não declara `revokedAt`; quem foi revogado não está banido (e volta por convite). O histórico completo já está no `auditLog` | §15.6 schema da resposta; §18.2 (reversibilidade) |

### 52.2 O que mudou no normativo

| Documento | Mudança |
|---|---|
| `docs/backend-v2.md` §15.4 "Cargos e membros" | emenda datada: `roleId` sempre presente (§7.3); `rank`/`appliedRoleIds` dependem da projeção local; `affectedMembers`/`clearedChannelRefs` são delta lido do estado projetado |
| `docs/backend-v2.md` §15.4 "Moderação" | emenda datada: as contagens são o delta desta op; re-ban idempotente responde zero; hierarquia é do `fold` |
| `docs/backend-v2.md` §15.6 | emenda datada: ordenação de bans/timeouts por `at` (cursor `{seq: at, id}`) e `query.bans` só com bans vivos |

### 52.3 O que continua pendente

| Pendência | O que falta | Quem fecha |
|---|---|---|
| Produtor de presença (§6.1/§44.3) | enquanto não existir, `presence` fica ausente, `onlyOnline` responde vazio e `offlineCount === total` | fase de presença |
| Colisão de `displayName` (L-5) | segue `false` até o `fold` marcar; herdado de §50.3 sem mudança | `fold` |
| ~~Demais consultas de §15.6~~ | ~~outbox, preferences, hostStatus, communities, selfModeration, resolveMessageLink~~ **entregues na §53** | — |
| Comandos restantes de §15.4 | `community.end`/`forget`/`activate`, preferências locais, voz/tela/relay além do já entregue | fatias seguintes |
| Herdadas | §50.3/§51.3 sem mudança adicional | ver §51.3 |

---

## 53. O estado local do leitor: não-lidas, preferências, fila e status 2026-08-22

**Gate de entrada:** nenhum gate específico — a fatia que faz a UI parar de mentir. Até
aqui `query.structure` lia `unread`/`muted`/`collapsed` das tabelas de §6.15 e **ninguém as
escrevia**; `channel.markRead`, `nav.setActive` e as consultas de fila/rail eram linhas sem
dono. Nove comandos locais (§15.4 "Preferências locais"), o produtor de não-lidas e seis
consultas (`query.outbox/communities/preferences/hostStatus/selfModeration/
resolveMessageLink`). Módulos novos na raiz de composição: `unread.ts` (o recalcador) e
`preferences.ts`; acessores LS em `l0/manifest`. Barreira `§4 ok — 82 arquivo(s),
L0:8 L1:6 L2:12 L3:4 + raiz de composição (11 arquivo(s))`; suíte 812 → **822 testes,
0 falha**, com `core/test/estado-local.test.ts` no caminho de produto inteiro. G12
rebuildado nos dois perfis.

| Entrega | Onde | Seção | Teste/evidência |
|---|---|---|---|
| Recálculo de não-lidas | `composition/unread.ts` + gancho `notifyProjected` | §6.15 (emendada) | contagem pela query de definição no lote projetado; do zero na primeira marca e quando os cargos locais mudam |
| `unread.changed` | idem, via `EventFanout` | §15.5 | payload com os campos exatos da tabela (`communityId`, `channelId?`/`threadId?`, contagens) |
| `channel/thread.markRead` | `preferences.ts` → tracker | §15.4, RT-03 | watermark avança à cabeça; resposta zero **literal** |
| `channel.setMuted` / `category.setCollapsed` / `nav.setActive` / `settings.*` | `preferences.ts` | §15.4, DR-32/DR-45 | escrita direta no LS; navegação dono único (presente define, ausente limpa) |
| `query.outbox` | `queryReadPorts.outbox` | §15.6 (F-16) | preview decodificado do PRÓPRIO envelope (`opCodec`), `kindLabel`, `channelName`, `counts` |
| `query.communities` | idem | §15.6, §23.2 | ordem de entrada (`joined_at`), agregado de não-lidas do LS, `partialInterpretation` |
| `query.preferences` / `query.hostStatus` / `query.selfModeration` | idem | §15.6, §18.4 | LS inteiro para redesenhar telas; replicação como única fonte viva do hostStatus |
| `query.resolveMessageLink` | idem | §15.6 (RT-04) | MSGREF = `communityId ‖ opId` (emenda em §3.5); os cinco status |

### 53.1 Decisões e por que são estas

| Decisão | Justificativa de engenharia | Justificativa normativa |
|---|---|---|
| O cálculo de não-lidas mora na **raiz de composição**, disparado pelo gancho de lote projetado — não no projector, não no fold | `local_read_state` está no `manifest.db` (outro banco) e é por instalação; o `Effect` de §8.4 é tipo fechado sobre CS, e o mesmo log não pode produzir contagens diferentes por réplica. O gancho dá o gatilho no MESMO passo síncrono do fan-out | §1.3 (as três classes de estado); §8.0; emenda datada em §6.15 substituindo "atualizado pelo projetor" |
| Recontar = canais tocados pelo lote **∪** canais já com linha no LS | Mutação de linha VELHA (edição, tombstone, ocultação/reversão de ban por `patchScope`) não move `seq` — só pode alterar contagem onde existe não-lida, e toda canal ativo ganha linha na primeira varredura. A contagem em si continua sendo a query de definição sobre `seq > lastReadSeq`: acumulador nenhum, logo sem contagem dupla (F-25/F-48) | §6.15 literal ("a contagem É uma query", não um estado incremental); emenda datada |
| Do zero na primeira marca E quando a assinatura dos cargos locais muda | A marca nasce ausente no boot/reprojeção (varre tudo); `pendingMentions` depende dos cargos AGORA, então cargo novo pode transformar menção dormente em pendente — testado ponta a ponta | §6.15 ("recomputado do zero… cargos da identidade local") |
| Linha de thread é criada mesmo com contagem zero | É ela que coloca a thread no conjunto "já conhecido"; sem isso, uma resposta alheia disfarçada depois da projeção ficaria invisível — o teste pegou exatamente este buraco | Consequência direta da regra anterior |
| `markRead` responde zero literal (não promessa) | O comando avança o watermark à cabeça do canal e reconta NA HORA: `{unreadCount: 0, pendingMentions: 0}` é fato medido, não esperança | §15.4 declara os dois campos (fecha RT-03) |
| `nav.setActive`: presente define, ausente limpa | DR-32 manda ser dono ÚNICO — o comando declara o estado inteiro da navegação; "ausente = mantém" criaria um segundo dono parcial | DR-32; decisão registrada |
| `settings.setNotifications` sem `communityId` é flag global em `local_device_pref` | A tabela singleton de dispositivo é o lugar natural de LS para um flag da instalação; nível por comunidade já tem casa (`notificationLevel`) | Micro-emenda datada em §6.15 |
| Preview da fila sai do envelope decodificado | O envelope JÁ está em `local_outbox` (§11.2); um campo de preview no schema seria conteúdo derivado armazenado duas vezes. Envelope ilegível → preview vazio (§8.5: normaliza, não lança) | §15.6 F-16; §11.2 |
| MSGREF = `communityId ‖ opId` | Os dois são estáveis entre réplicas; a primeira metade nomeia a comunidade antes de qualquer procura (`not-member` sem tocar nada); `observed_ops` já indexa o par. Qualquer alternativa inventaria um segundo id de mensagem ou exigiria dado inexistente | Emenda datada em §3.5; §7.3 (ids determinísticos) |
| `not-synced` responde SEM `channelId` | Antes da projeção ninguém sabe o canal da op — responder um canal seria inventá-lo. Campo presente só nos status que conhecem a mensagem | Precedente §46/§50 (campo sem fonte fica ausente); emenda datada em §15.6 |
| Volume padrão 100, id de dispositivo ausente | 100 = "sem atenuação", o neutro honesto para um slider sem escolha; id sem escolha não tem valor para inventar | §15.6 schema vs. precedente de ausência |
| `hostStatus`/`inactiveDays` sem produtor ficam ausentes | Nada acompanha hoje a conexão com o host (DR-29/DR-33 sem dono); a replicação é a única fonte viva | Precedente de §46/§50 |

### 53.2 O que mudou no normativo

| Documento | Mudança |
|---|---|
| `docs/backend-v2.md` §6.15 | emenda datada: o cálculo de não-lidas mora na raiz de composição, disparada pelo lote projetado (com o algoritmo de escopo); micro-emenda: `notificationsEnabled` em `local_device_pref` |
| `docs/backend-v2.md` §3.5 | emenda datada: MSGREF = base64url(`communityId(32) ‖ opId(32)`) |
| `docs/backend-v2.md` §15.6 | emenda datada: `resolveMessageLink` responde `not-synced` sem `channelId` |

### 53.3 O que continua pendente

| Pendência | O que falta | Quem fecha |
|---|---|---|
| ~~Produtor de presença/typing (§44.3)~~ | ~~`presence.changed`/`typing.changed` continuam sem fonte; `onlyOnline` segue respondendo vazio~~ **implementado em 2026-08-23 — §54**: `presence.changed`/`typing.changed` com produtores, `presence` em `query.members/member`, `onlyOnline` filtrando de verdade. A escolha de presença do próprio usuário (`identity.setPresence`) segue para a fase de identidade | — |
| ~~Acompanhamento de conexão com o host (DR-29/DR-33)~~ | ~~`status`/`lastSeenAt`/`attempt` de `query.hostStatus` e `inactiveDays`/`hostStatus` de `query.communities` aguardam esse produtor; `lastHostSeenAt` segue sem escritor~~ **implementado em 2026-08-23 — §54**: máquina fechada de §15.6 em `composition/hostStatus.ts`, `last_host_seen_at` escrito no contato observado, `inactiveDays` derivado na leitura | — |
| Colisão de `displayName` (L-5) | segue `false` até o `fold` marcar | `fold` |
| Varredura incremental mais fina | o recálculo reconta todo canal com linha a cada lote; correto e barato na escala v1, mas a janela por canal pode ficar mais apertada se a réplica engolir log grande | otimização futura |
| Comandos restantes de §15.4 | `community.end`/`forget`/`activate`, `identity.*` (dependem de shell e IPC-M) | fatias seguintes |
| Herdadas | §50.3/§51.3/§52.3 sem mudança adicional além das entregas riscadas acima | ver §52.3 |

---

## 54. O núcleo vivo: status do host, presença/digitando e os jobs que faltavam 2026-08-23

**Gate de entrada:** nenhum gate específico — a fatia que dá aos campos deixados ausentes
em §53 os seus produtores, e dá corpo aos jobs que o runner de §49 já sabia agendar. Três
frentes que se fecham juntas. Módulo novo na raiz de composição: `hostStatus.ts`; o runner
de `jobs.ts` ganhou o gêmeo `startLoops` para os loops permanentes de §22.1 (mesma
disciplina de rearme pós-execução e cancelamento no `close`, §22.5 — nada de `setInterval`
solto). Barreira `§4 ok — 83 arquivo(s), L0:8 L1:6 L2:12 L3:4 + raiz de composição (12
arquivo(s))`; suíte 822 → **832 testes, 0 falha**, com `core/test/nucleo-vivo.test.ts`
caminhando o produto inteiro (máquina de status, presença ponta a ponta host↔membro sobre
par RPC em memória, e os corpos dos jobs).

| Entrega | Onde | Seção | Teste/evidência |
|---|---|---|---|
| Máquina de §15.6 por comunidade | `composition/hostStatus.ts` | §15.6, DR-29/DR-33 | enum fechado com fontes reais; terminais (`forked`/`unauthorized`/`ended`/`incompatible`) vencem o dinâmico |
| `host.statusChanged` | idem, via `EventFanout` | §15.5 | payload exato da tabela (`communityId`, `status`, `lastSeenAt?`, `attempt?`) |
| `lastHostSeenAt` no LS | `manifest.getLast/setLastHostSeenAt` | §6.15 | escrito no primeiro contato, em cada contato renovado e no nascer do modo hospedeiro |
| `inactiveDays` + job `host.inactivity` | derivação na leitura + travessia do limiar sinalizada | §22.2, §15.6 | rail mostra os dias; travessia de `INACTIVE_COMMUNITY_DAYS` sai por `host.statusChanged`, uma vez |
| `host.cameBack` → reconcile + flush com jitter | `hostStatus.ts` | §11.8, §22.1, §22.3 | reconciliação imediata; flush agendado após `RECONNECT_FLUSH_DELAY_MS + hash(identityKey) mod 2000`, taxado a `FLUSH_RATE_PER_S/s` |
| Handlers `presencePublish`/`subscribeChannel` no host | `ports.wireHostPresenceRpc` | §16.2, §17.6 | tetos 1/5 s e 1/2 s por autor/canal (`E_RATE_LIMITED`); origem é a chave da conexão |
| Push do host: `presence.changed`/`typing.changed` | callbacks do `PresenceManager` → `empurra` | §16.3, §17.6 | delta agregado no tick; typing só a assinantes do canal; payload de §16.3 SEM `communityId`, evento IPC COM |
| Loops de §22.1 | `composition/jobs.ts` (`startLoops`) + corpos no boot | §22.1 | `presence.tick` 2 s (host), `typing.expire` 1 s (host), `presence.refresh` 15 s (todo nó) |
| `presence` em `query.members`/`query.member` | `queryReadPorts` | §15.6, §6.1 | entrada viva → `{presence}`; sem entrada → campo AUSENTE (`offline` nunca é escrito); `onlyOnline` filtra de verdade; `offlineCount = total − vivos` |
| `query.hostStatus`/`query.communities` completos | idem | §15.6 | `status`/`lastSeenAt`/`inactiveDays`/`attempt?` com as ausências da emenda datada |
| Corpos de §22.2 | boot (`startJobs`) | §22.2 | `outbox.expire` reconcilia antes de descartar; `staging.gc` com `hasReference` na `view.db` + fila; `removed.purge` apaga LS+CS+disco; `db.maintenance` (optimize + WAL > 64 MiB); `log.rotate` (§24.1); `succession.check` (avaliação pura); `ds.snapshot` no `draining` |

### 54.1 Decisões e por que são estas

| Decisão | Justificativa de engenharia | Justificativa normativa |
|---|---|---|
| O status do host mora na raiz de composição, não no DS nem no fold | "O host visto por MIM" é fato POR INSTALAÇÃO: o mesmo log produziria estados diferentes por réplica se fosse dado replicado, e o `Effect` de §8.4 é tipo fechado sobre CS. As fontes (canal de §16.1, resultado de submissão, watchdog de §14.5, DS) já estão nesta raiz | §1.3 (três classes de estado); §8.0; precedente de §53 (não-lidas) |
| Estados terminais avaliados NAS FONTES a cada leitura, não como transições armazenadas | Transição perdida (fork detectado enquanto o tracker dorme) viraria estado mentiroso para sempre; ler `CommunityClient`/DS na hora elimina a classe do bug com custo zero | §14.5 (os estados são deriváveis de métricas observáveis) |
| `incompatible` é pegajoso | Nada nesta fase des-marca: quem entrou em `E_VERSION_UNSUPPORTED` só sai com novo binário (novo processo, novo tracker). Desmarcar dentro da sessão seria fingir renegociação que não existe | §16.3 ("somente-leitura… até nova versão"); §11.6 regra 3 |
| `reconnecting` exige contato anterior; sem nenhum, `offline` | `reconnecting` afirma "estou tentando de novo ALGUÉM QUE EU VI"; sem contato nenhum a frase honesta é outra. Ambos vêm de eventos reais do transporte (`onDown`), nunca de suposição | §16.1 (reconexão na conexão seguinte); precedentes de campo-sem-fonte |
| `cameBack` reconcilia IMEDIATO e flusha com jitter + taxa | A reconciliação primeiro evita o bloqueio de canal por op `awaiting-confirmation` nunca confirmada; o jitter por identidade é o que impede a avalanche de reconexão em fase de §22.3 | §11.8 (fecha DS-10); §22.1; lição de rig de §45–§53 |
| `presencePublish` com o MESMO status dentro da janela de 5 s é no-op, não `E_RATE_LIMITED` | O método carrega presença E typing com tetos independentes; barrar o typing porque a presença repetida não tem informação nova seria trocar a proteção do fio por um bug de UX. Status DIFERENTE continua limitado — é ele que custa fan-out | Emenda datada em §16.2; mapeamento `messageStore.setTyping → presencePublish{typingChannelId}` (deltas-ux/frontend); §17.6 (o teto protege o fio, não a semântica) |
| Delta de presença só com mudanças; expiração sai pela AUSÊNCIA na consulta | A tabela de §15.5 é fechada (`{communityId, entries[]}`): não há `removed[]` no fio, e colocar `status:'offline'` em `entries` violaria §6.1. A UI reconsulta por sinal (§15.1 regra 5) e o TTL corrige em ≤ 45 s (L-13) | §15.5 tabela fechada; §6.1; L-13 declarada |
| `typing.changed` vai só a assinantes; sem assinante, nem sai | É o redesenho de §17.6 (broadcast de canal aberto, não de comunidade). No membro, os quadros são INGERIDOS no estado local e NÃO reemitidos ao renderer — o runtime de mídia já encaminha esses tópicos, e duplicar seria evento repetido | §17.6; §16.3 regra 2; economia de fio medida no G9-pendente |
| `presence` ausente para quem está offline; `onlyOnline` passa a filtrar | Com produtor, o filtro honesto deixa de ser vazio; o VALOR continua não existindo para offline — ausência é a representação, como sempre foi | §6.1 (`offline` nunca é escrito); §23.3 (offline agregado); precedente §52.3 |
| `inactiveDays` derivado na leitura; o job sinaliza a TRAVESSIA do limiar | Armazenar uma função pura de `(agora, lastHostSeenAt)` criaria segunda fonte para o mesmo fato. O trabalho real do job é vigiar o limiar de `INACTIVE_COMMUNITY_DAYS` e avisar por `host.statusChanged` — único sinal da tabela fechada que nomeia o relacionamento com o host | Emenda datada em §22.2; §15.5 tabela fechada; §27.2 |
| `outbox.expire` É uma reconciliação | §11.6 regra 1 proíbe descarte por idade fora dela; o corpo do job é chamar `reconcile()` por comunidade — a regra de idade vive DENTRO do algoritmo, na ordem certa depois das checagens de observação/watermark/mismatch | §11.6 (fecha DS-06/DS-07); §22.2 |
| `staging.gc` confere referência na `view.db` E na fila ativa | Uma op de `message.send` pendente referencia o blob antes de qualquer projeção; varrer o envelope bruto por `(blobsCoreKey, hash)` é conservador na direção certa (mantém em vez de apagar). Staging sem comunidade/core conhecidos é mantido — sem fonte, nenhuma poda. A faixa de blocos escrita no stage (`blob_ranges`) é o que torna o `core.clear` preciso, sem tocar anexos vivos do mesmo core | §13.5; §13.7 regra 1; §22.4 |
| `removed.purge` esquece do runtime ANTES de purgar | Job zumbi escrevendo em banco purgado é exatamente o crash que §22.5 descreve. A ordem é: forget → sair do swarm → LS → CS (+FTS pelo mesmo comando contentless-delete do projector) → disco (core do log e core de blobs local) | §18.4 passo 6; §10.7; §22.5 |
| `log.rotate` roda sem produtores de log | A rotação/retenção/teto de §24.1 é manutenção de arquivos existentes; os PRODUTORES de NDJSON chegam com o shell. Inventar um subsistema de log inteiro nesta fatia iria além do menor passo coerente | §24.1; §27.2 (`LOG_RETENTION_DAYS`, `LOG_MAX_TOTAL_BYTES`) |
| `succession.check` avalia e não oferece ainda | A oferta de assumir é superfície de UI (U-18) que depende do shell; inventar tópico de evento violaria a tabela fechada de §15.5. O corpo existe: `SuccessionService.checkEligibility(cid)` é a camada b de R-18 em forma consultável, chamada pelo runner | §18.8; §22.2; U-18 |
| `ds.snapshot` sem linha no runner | Por contagem já é do projector (§10.6, cadência `DS_SNAPSHOT_INTERVAL`); "no draining" virou o primeiro passo do `close()` do runtime. Período fixo nenhum lhe corresponde — encaixá-lo no runner seria inventar cadência | §10.6 literal; §22.2 ("por contagem e no draining") |

### 54.2 O que mudou no normativo

| Documento | Mudança |
|---|---|
| `docs/backend-v2.md` §15.5 | emenda datada: `presence.changed{entries[]}` carrega só as mudanças; expiração sai pela ausência na consulta (tabela fechada + §6.1) |
| `docs/backend-v2.md` §16.2 | emenda datada: `presencePublish` com tetos independentes para presença e typing; MESMO status dentro da janela é no-op, status diferente é `E_RATE_LIMITED` |
| `docs/backend-v2.md` §22.2 | emenda datada: `inactiveDays` derivado na leitura; `host.inactivity` sinaliza a travessia do limiar por `host.statusChanged` |
| `docs/backend-v2.md` §15.6 | emenda datada: `query.hostStatus` sem `lastSeenAt`/`inactiveDays` enquanto não há contato observado; `inactiveDays` derivado do LS; `attempt` só acima de zero |

### 54.3 O que continua pendente

| Pendência | O que falta | Quem fecha |
|---|---|---|
| ~~Escolha de presença local~~ | ~~`identity.setPresence{presence}` (§15.4) define o status publicado pelo refresh; hoje o default honesto é `online`, e `invisible` já é respeitado pelo loop~~ **implementado em 2026-08-23 — §56** | — |
| ~~Gatilho de assinatura de typing no membro~~ | ~~quem chama `subscribeChannel{channelId,on}` é a UI quando abre canal; a capacidade existe no serviço e no fio, falta o comando IPC-R que a dispara~~ **implementado em 2026-08-23 — §56**: `channel.subscribeTyping` (emenda datada em §15.4) | — |
| ~~Demais loops de §22.1~~ | ~~`outbox.flush` (1 s), `outbox.reconcile` (30 s), `replication.watchdog` (5 s), `metrics.flush` (10 s) seguem disparados pelos seus gatilhos próprios/manuais~~ **implementados em 2026-08-23 — §55**, exceto `metrics.flush`, que aguarda os produtores de log (§24.3) e continua listado abaixo | — |
| ~~Produtores de log NDJSON~~ | ~~`log.rotate` mantém o layout de §24.1; quem ESCREVE `logs/core-*.ndjson` chega com o shell~~ **implementado em 2026-08-23 — §56**: `NdjsonLogger` com allowlist estrutural de §24.2, produtores nas transições do host, desfechos da fila, watchdog e boot | — |
| Oferta de sucessão (U-18) | `checkEligibility` avalia; o shell e `identity.*` existem desde §56 — falta a TELA de oferta (frontend fora do núcleo) | fase de UI |
| Colisão de `displayName` (L-5) | segue `false` até o `fold` marcar | `fold` |
| Comandos restantes de §15.4 | `community.end`/`forget`/`activate`, resto de `identity.*` | fatias seguintes |
| Herdadas | §50.3–§53.3 sem mudança adicional além das entregas riscadas acima | ver §53.3 |

---

## 55. O núcleo vivo, por completo: os loops de §22.1 que faltavam e o hello 2026-08-23

**Gate de entrada:** nenhum gate específico — a fatia pequena que fecha o que a §54
declarou pendente. Quatro corpos novos no `startLoops` de §54 (`outbox.flush`,
`outbox.reconcile`, `replication.watchdog`, `host.hello`), o `onEvent` do
`CommunityClient` ligado ao fan-out (as transições de §14.5 nunca tinham destino) e o
`Outbox.discardForVersion()` para o fluxo obrigatório de §16.3. Nenhum módulo novo; a
barreira segue `§4 ok — 83 arquivo(s)`. Suíte 832 → **838 testes, 0 falha**, com
`core/test/loops-permanentes.test.ts` montando um nó MEMBRO de verdade sobre o log de
gênese dos helpers (`openCore` injetado devolve um cabo sobre `world.log`) — é a primeira
vez que a suíte exercita o caminho de membro ponta a ponta sem rede. G12 rebuildado em
quick.

| Entrega | Onde | Seção | Teste/evidência |
|---|---|---|---|
| `outbox.flush` (1 s) | loop no boot | §22.1, §11.8 | hospedeiro: entrega → ACK local → projeção → reconcile esvazia com `message.accepted` DEPOIS de `messages.appended`; membro SEM canal: zero tentativa queimada, zero frame enfileirado |
| `outbox.reconcile` (30 s) | idem | §22.1, §11.6 | mesmo teste do flush; cadência de `OUTBOX_RECONCILE_MS` exportada pelo próprio módulo |
| `replication.watchdog` (5 s) | idem + `onEvent` → fan-out | §14.5, §22.1 | gap não servido + relógio parado → `community.replication{state:'stalled', reason:'no-provider'}` capturado pelo renderer |
| `host.hello` (30 s) + hello imediato no anexo | `CoreRuntime.renovarHelos`/`#enviarHello` | §14.5, §16.3, §22.1 emendada | resposta marca `markHello` (synced ALCANÇÁVEL), escreve `last_host_seen_at` e emite `{online}`; `opVersion` divergente → `incompatible` pegajoso + fila inteira `dropped/client-outdated` |

### 55.1 Decisões e por que são estas

| Decisão | Justificativa de engenharia | Justificativa normativa |
|---|---|---|
| Watchdog como CORPO do runner, não `client.startWatchdog()` | O `startWatchdog` carrega `setInterval` próprio dentro de L2 — fora do relógio injetado e da disciplina de rearme/cancelamento de §22.5. Chamar `watchdogTick()` do loop dá a MESMA transição sob as regras do runner (sem sobreposição, para no `close`, disparável por `runNow`) | §22.5; padrão de "nada de `setInterval` solto" das fatias anteriores |
| O `onEvent` do cliente entra no fan-out NA CONSTRUÇÃO | As transições de §14.5 já eram computadas e descartadas — evento sem destinatário é sinal que ninguém escuta. A rota viaja ao lado (`{communityId}`), payload intacto | §15.5 tabela fechada; §15.1 regra 2 |
| Flush em modo membro SÓ com canal vivo (`connecting`/`online`) | Submeter sem conexão não é tentativa real de entrega: queimaria tentativa/backoff de §11.8 contra um `E_HOST_UNAVAILABLE` garantido E inflaria a fila do `RpcClient` sem destino (um frame por segundo). Hospedeiro flui sempre — a submissão é local (§11.2) | §11.8 ("`attempts` só é incrementado quando houve uma tentativa real"); §16.1 reconexão |
| Hello imediato no anexo do canal, além da cadência | §16.3 exige hello ANTES de qualquer outro método na PRIMEIRA conexão; esperar até 30 s violaria o espírito e atrasaria `synced`. A queda anterior falhou os pendentes e esvaziou a fila do `RpcClient`, então este frame sai primeiro — sem reordenador novo | §16.3 fluxo obrigatório; §16.1 reconexão |
| `opVersion` incompatível: `queued`/`failed` caem agora; itens em voo caem pelo desfecho do host | Forçar `sending`/`awaiting-confirmation` para dropped criaria transição que §11.3 não declara. O desfecho real deles JÁ é terminal com o mesmo motivo (`TERMINAL_DROP_CODES`) — a fila inteira morre, cada item pelo caminho legítimo | §11.3 máquina de estados; §11.6 regra 3; §16.3 ("todo item… vira dropped/client-outdated") |
| `host.hello` na tabela de §22.1 por EMENDA, não por interpretação | A tabela não listava o produtor, mas §14.5 define `synced` POR ele e §27.2 declara a constante para isso — lacuna interna do documento, não liberdade nossa. Emenda datada registra a linha onde ela sempre esteve implícita | §14.5; §27.2; regra de lacuna (decidir + emendar com data) |
| Rig de membro sobre `world.log` com `openCore` injetado | Os blocos de um core de comunidade SÃO registros `HostRecord` — a gênese dos helpers produz exatamente isso. Com `buraco > 0` o cabo anuncia mais do que serve, o gap de §14.5 vira testável sem rede, e o caminho de membro (outbox, reconciliação, hello, watchdog) sai da cobertura zero | §28.1 (testes sem mock de rede); §10.5 passo 6 (parada no buraco) |

### 55.2 O que mudou no normativo

| Documento | Mudança |
|---|---|
| `docs/backend-v2.md` §22.1 | emenda datada: linha `host.hello` (`P2P_HELLO_INTERVAL_MS`) acrescentada à tabela — o produtor que §14.5/§27.2 pressupunham; hello imediato na primeira conexão |

### 55.3 O que continua pendente

| Pendência | O que falta | Quem fecha |
|---|---|---|
| ~~`metrics.flush` (10 s)~~ | ~~o loop existe na tabela de §22.1, mas os PRODUTORES de métrica/log (§24.3) ainda não — rodaria para nada~~ **implementado em 2026-08-23 — §56**: o loop comete no registro central de §24.3 (profundidade da fila, estado de replicação, pares do swarm) que `diag.snapshot` serve; o destino NÃO é o NDJSON — o formato de §24.1 é fechado e não tem campo para valor | — |
| ~~Escolha de presença local (`identity.setPresence`)~~ | inalterado desde §54.3 — **implementado em 2026-08-23 — §56** | — |
| ~~Gatilho de assinatura de typing no membro~~ | inalterado desde §54.3 — **implementado em 2026-08-23 — §56** (`channel.subscribeTyping`, emenda em §15.4) | — |
| ~~Produtores de log NDJSON~~ | inalterado desde §54.3 — **implementado em 2026-08-23 — §56** | — |
| Oferta de sucessão (U-18) / colisão L-5 / `community.end`-`forget`-`activate` | shell e `identity.*` existem desde §56; o que falta agora é superfície de UI e as ops restantes da tabela | fases seguintes |

---

## 56. O produto acorda: identidade na superfície, o shell de verdade e os produtores de log 2026-08-23

**Gate de entrada:** nenhum gate específico — a fatia que liga o processo real. Três
frentes que se fecham juntas: (1) a superfície `identity.*` + o ciclo do núcleo
(`core.status`/`reproject`/`shutdown`, transição `awaiting-identity → ready`), 100%
testável no core; (2) o shell Electron real — o stub de 99 linhas de `app/src/utility`
vira o boot do `bootCore` sobre as duas portas cruzadas pelo main, com lock composto,
retomada de wipe, Data Key por IPC-M e draining no quit; (3) as pendências pequenas que
dependiam das duas. Módulos novos na raiz de composição: `identity.ts` (serviço + portas
de keystore), `wipe.ts` (máquina retomável de §18.6) e `logger.ts` (NDJSON de §24.1 com
allowlist de §24.2 e o registro central de métricas de §24.3). Barreira
`§4 ok — 86 arquivo(s), L0:8 L1:6 L2:12 L3:4 + raiz de composição (15 arquivo(s))`;
suíte 838 → **851 testes, 0 falha**, com três arquivos novos
(`identidade-superficie.test.ts`, `wipe-backup.test.ts`, `draining-log.test.ts`). A app
compila (`npm run typecheck`/`build`) e o shell foi exercitado ponta a ponta por um smoke
automatizado sob node puro (roteiro abaixo).

| Entrega | Onde | Seção | Teste/evidência |
|---|---|---|---|
| `identity.create` (open), gates de keystore | `composition/identity.ts` + roteador | §15.4, §3.2 L-2 | coluna Erros na ordem: `E_IDENTITY_EXISTS`, `E_VALIDATION` (mesma régua do `fold`), `E_KEYSTORE_UNAVAILABLE`, `E_KEYSTORE_INSECURE` sem aceite persistido |
| Transição `awaiting-identity → ready` | boot (`setPhase` + fan-out) | §3.3, §15.5 | standard recusa com `E_NO_IDENTITY`; `create` emite `core.ready{phase:'ready', epoch}` e abre as escritas; `core.restarted` quando `epoch > 1` |
| `identity.update` **A**, uma op por comunidade | ponte (`IDENTITY_UPDATE_KIND`) + boot | §15.4, §11.1 emendada | duas comunidades → `{queued:[×2]}`; flush entrega, `fold` aplica nas duas, reconcile esvazia |
| `identity.setPresence` | boot (`runtime.localPresence`) | §6.1, §17.6 | tabela fechada valida; `dnd` publica no refresh; `invisible` para de publicar e expira pelo TTL; escolha persiste no perfil |
| `identity.export` / `identity.import` | serviço + portas IPC-M | §5.5 | export carrega comunidades hospedadas com semente; import recria linhas no manifest e REABRE os cores pelo mesmo caminho do boot; frase errada é `E_BAD_PASSPHRASE` |
| `identity.wipe` — máquina retomável | `composition/wipe.ts` | §18.6 | cada etapa grava o próprio nome ANTES de agir; crash em `view-deleted` retoma pelo `wipe_state`; sentinela `WIPE` cobre pós-`manifest-deleted` sem abrir banco; LOCK sai por último |
| `core.status` completo | boot | §15.6 | `phase/epoch/coreVersion/opVersion/manifestSchemaVersion/viewSchemaVersion/keystore/buildChannel` |
| `core.reproject` (main-confirmed) | boot | §15.2, §10.5 | reprojeção reconstrói a `view.db` do log; mensagens intactas |
| `core.shutdown` — draining com orçamento | `CoreRuntime.shutdown` | §18.7 | resposta honesta `{drainedMs, pendingOps, replicatedTo}`; fase `draining → stopped` |
| Shell real: utility roda `bootCore` | `app/src/utility/index.ts` | §3.1, §3.3 | lock flock antes dos bancos; wipe-resume ANTES de abrir qualquer banco; Data Key unwrap via IPC-M (ou geração na primeira instalação); `identity.load()` decide a fase |
| Lock composto de §10.8 | main + utility | §10.8 | segunda instância recusa com `E_CORE_ALREADY_RUNNING`; saída esperada não vira respawn de crash |
| Crash do núcleo (§15.2) | main (`epoch++`, backoff) + preload | §15.2 | renderer recebe `core-epoch` e refaz subscrições; saída limpa pós-draining NÃO reinicia |
| Draining no quit | main ↔︎ utility handshake | §3.3, §18.7 | quit manda `shutdown`, núcleo responde `{e:'drained'}` com o resumo; teto de 8 s |
| Token main-confirmed nasce NO núcleo | main (diálogo) + utility (`AuthTokenStore`) | §15.3 | diálogo nativo no main; emissão pedida pela IPC-M; consumo síncrono único no roteador |
| Deep links | main (já existia) | §3.5 | `parseDeepLink` + fila até o renderer; `query.resolveMessageLink` pronto desde §53 |
| Gatilho de typing | `channel.subscribeTyping` | §17.6 | host assina no agregador local; membro espelha por §16.2 e chega ao servidor real; sem canal vivo não há frame (§11.8) |
| Produtores NDJSON | `composition/logger.ts` | §24.1, §24.2 | allowlist ESTRUTURAL (campo fora da lista não existe na linha); `debug` só no canal dev; produtores: boot, transições do host, desfechos da fila, watchdog, metrics.flush |
| `metrics.flush` (10 s) | loop de §22.1 + `MetricsRegistry` | §24.3, §22.1 | gauges de profundidade de fila por comunidade, estado de replicação e pares do swarm cometidos no registro central que `diag.snapshot` serve |

### 56.1 Decisões e por que são estas

| Decisão | Justificativa de engenharia | Justificativa normativa |
|---|---|---|
| `identity.update` enfileira pela PONTE como segunda exceção declarada; a política do `fold` NÃO muda | A classificação `Fila` do `KIND_POLICY` espelha a tabela de §7.4.1 por domínio, e o teste de política compara as duas — o `member.leave` já seguia exatamente esse arranjo (exceção na ponte, `fila:false` na tabela). Duplicar a exceção em dois lugares seria criar segunda fonte para o mesmo fato | §11.1 (emenda datada); §7.4.3; precedente L-22 |
| `identity.export` responde `{}`, sem `savedTo` | O caminho de arquivo do usuário não cruza o IPC-R em NENHUMA direção (T-16); devolvê-lo na resposta violaria a regra 5 de §13.3. O campo da tabela era conflito interno da spec, não liberdade nossa — emenda datada registra a correção | §13.3 regra 5; §5.5 (o blob nunca passa pelo renderer); regra de conflito normativo |
| `channel.subscribeTyping` é comando LOCAL que espelha a assinatura, não uma op | A assinatura é estado efêmero do host (§17.6), nunca entra no log; quem sabe quando ela começa e termina é a UI abrindo/fechando canal. No membro é fire-and-forget por §16.2: sem canal vivo não há frame (efêmero não enfileira, §11.8) e a re-assinatura acontece na reconexão, como toda ressincronização de §15.1 | §17.6; §16.2; §11.8; lacuna interna da tabela fechada resolvida por emenda datada |
| Wipe remove `<dataDir>/cores` na etapa `cores-closed` | Uma limpeza que deixa o LOG INTEIRO de toda comunidade legível no disco contradiria §18.4 (réplica removida sai inteira) e o propósito da máquina; a etapa é a única que nomeia os cores. Fechar e remover é um passo só de desmontagem | §18.6 (etapas); §18.4 passo 6; decisão registrada aqui por ser colocação dentro de etapa existente |
| O wipe-resume mora no SHELL, antes de abrir bancos | Retomar exige NÃO ter banco aberto (pós-`manifest-deleted` não há mais onde ler o estado). O `bootCore` já recebe bancos abertos; quem pode garantir a ordem lock → resume → open é quem monta a sequência — a raiz de composição do shell | §18.6 ("no boot… retoma… antes de qualquer outra coisa"); §10.8 ordem do lock |
| `core.shutdown` corre o orçamento sobre sinais LOCAIS (fila vazia + réplica na cabeça) | A barreira de §18.7 passo 2 pede confirmação de PARES (`min(3, memberCount−1)` com `core.length` igual à cabeça); o transporte ainda não mede quem confirmou o quê. Inventar confirmação seria pior que declarar o limite: a resposta é honesta sobre pendentes | §18.7 passos 2–4; pendência registrada em §56.3 |
| Métricas de §24.3 vão para um REGISTRO central consultável, não para o NDJSON | O formato de §24.1 é fechado (`ts/level/scope/msg` + opcionais) e nenhum campo carrega valor de gauge — escrever valor em `code` ou `seq` seria abuso. O módulo `diagnostics` já declarava esperar "um registro central implementado pela composição" | §24.1 formato fechado; §24.3 taxonomia; comentário contratual de `diagnostics` |
| Allowlist de §24.2 é ESTRUTURAL no logger | Campos fora da lista de §24.1 são descartados antes de tocar o arquivo: redação por construção não depende do produtor lembrar. Teste varre TODAS as linhas produzidas num fluxo real procurando campo estranho, nome de comunidade e conteúdo de mensagem | §24.2 (fecha T-39); §24.1 lista fechada de campos |
| UMA Data Key por instalação: `identity.create` adota a chave que a composição já tem | §5.4 diz que a mesma chave protege `identitySeed`, `communitySeed`s e `escrowSeed`s. Antes desta fatia o manager sorteava uma SEGUNDA chave para a semente de identidade — duas chaves partiriam a promessa de §5.5 (restaurar com o backup + manifest) | §5.4; §5.5; §10.2 (`manifest.secrets.data_key`) |
| Token main-confirmed nasce NO núcleo, main só pede emissão após o diálogo nativo | O roteador consome o token SINCRONAMENTE (§15.2 quadro `req`); validação assíncrona contra o main mentiria por verdadeiro (Promise é truthy). Com o store no consumidor, uso único e TTL ficam onde o token é gasto — e o renderer continua incapaz de fabricá-lo | §15.3 (valor de uso único, TTL 60 s, consumido e invalidado pelo núcleo) |
| `hostTurnSecret(communityId)` derivado por `'ns/hostturn/1' ‖ dataKey ‖ communityId` | §15.7 exige o segredo no boot e nenhuma linha de §5.2 o derivava. Derivar da Data Key mantém o segredo dentro da máquina e recuperável sem estado extra; prefixo novo entra por EMENDA na tabela fechada, não por interpretação | §5.2 (emenda datada); §17.3; regra de lacuna (decidir + emendar) |
| Fase vira EVENTO (`core.ready`/`core.restarted`), não polling | A tabela de §15.5 declara os dois tópicos e ninguém os emitia; `identityStatus.isLoaded` era getter passivo — o renderer teria que adivinhar quando as escritas abrem. Eventos não são replay: quem assina depois lê `core.status` (open) | §15.5; §3.3; §15.6 `CoreStatus.phase` |
| Smoke automatizado do shell sob node puro (parentPort falso) além do typecheck | `npm run dev` depende de gnome-keyring, ABI de addons nativos para Electron e display — nada disso existe no ambiente automatizado. O smoke cruza as DUAS portas como o main faz, fala IPC-R em quadros crus e prova: lock, wipe-resume, unwrap da Data Key, `awaiting-identity`, `create` com wrap, `community.create` com gênese no disco, e reboot nascendo `ready` com identidade persistida. É evidência REAL do caminho do shell, não substituto do smoke manual do Electron | §28.1 (testes sem mock de rede/domínio); CLAUDE.md (não inventar evidência — o roteiro manual segue listado em §56.3) |

**Roteiro do smoke (node ≥ 22, sem display):**

```
node /tmp/opencode/smoke-utility.mjs          # primeira instalação → awaiting-identity → create → ready
SMOKE_REUSE_DIR=<dir> node ...                # reboot no mesmo diretório → nasce ready (persistência)
```

**Roteiro do smoke MANUAL do Electron (`npm run dev`), a executar no ambiente com
gnome-keyring ativo e addons rebuildados para a ABI do Electron:**

1. `cd core && npm run build && cd ../app && npm run build && npm run dev`.
2. Primeiro uso: janela abre, `core.status` responde `awaiting-identity`; criar identidade
   pela UI libera as escritas (evento `core.ready`).
3. Segunda instância: `comunidadep2p://join/<código>` em outra instância foca a janela
   existente; o flock recusa um segundo núcleo.
4. Export: confirmar diálogo nativo e verificar o arquivo gravado; apagar `<userData>/p2p`,
   restaurar por import e conferir comunidade reaberta.
5. Fechar a janela: log `[nucleo] draining:` com contadores e saída limpa (sem respawn).
6. `kill -9` no processo `comunidade-nucleo`: epoch+1, renderer falha pendentes com
   `E_CORE_RESTARTED` e refaz subscrições.

### 56.2 O que mudou no normativo

| Documento | Mudança |
|---|---|
| `docs/backend-v2.md` §5.2 | emenda datada: linha `'ns/hostturn/1'` (`dataKey ‖ communityId`) na tabela fechada de derivações — o produtor de §15.7/§17.3 que a tabela pressupunha |
| `docs/backend-v2.md` §11.1 | emenda datada: `identity.update` entra como SEGUNDA exceção declarada de fila (contrato já dito pela tabela de §15.4, agora escrito onde a regra única mora) |
| `docs/backend-v2.md` §15.4 | emenda datada em três alinhamentos: `identity.export` responde `{}` (§13.3 regra 5 vence `{savedTo}`); `channel.subscribeTyping {communityId, channelId, on}` (standard) entra na tabela como gatilho local da assinatura de §17.6; `E_WIPE_INCOMPLETE{stage}` viaja em `details.stage` |

### 56.3 O que continua pendente

| Pendência | O que falta | Quem fecha |
|---|---|---|
| Barreira de replicação de §18.7 por confirmação de PARES | o transporte precisa medir quem confirmou `core.length` igual à cabeça; hoje o orçamento do draining corre sobre sinais locais | fase de transporte/mídia real |
| Sondas reais de NAT/STUN no `diag.*` | o default conservador assume `cgnat`/sem STUN sem sonda injetada (pior caso declarado); a injeção é do shell empacotado | fase de empacotamento |
| Smoke manual do Electron | roteiro acima; exige gnome-keyring ativo, addons rebuildados para a ABI do Electron e display — nada disto no ambiente automatizado | ambiente de release |
| Empacotamento (`electron-builder`) e rebuild de addons nativos por versão do Electron, respeitando piso glibc ≥ 2.31 | `npm run pack` da app nunca foi executado nesta árvore | fase de release (G0/G10 regem os nativos) |
| ~~Renderer real~~ | ~~o mock de `frontend/` continua fora do produto; ligá-lo à IPC-R real é fatia própria~~ — **entregue em §58** (transporte, stores e telas mínimas sobre a IPC-R real) | — |
| ~~Oferta de sucessão (U-18)~~ | ~~tela de oferta; `checkEligibility` e o shell existem~~ — **entregue em §58** (U-18c: oferta e reentradas pendentes) | — |
| Colisão de `displayName` (L-5) | segue `false` até o `fold` marcar | `fold` |
| Comandos restantes de §15.4 | `community.end`/`forget`/`activate`; superfícies `dev.*` fora do escopo | fatias seguintes |
| Herdadas | §50.3–§55.3 sem mudança adicional além das entregas riscadas acima | ver §55.3 |

---

## 57. O bloco Comunidade se fecha: end, forget, activate — e a marca de L-5 2026-08-23

**Gate de entrada:** nenhum gate específico — a fatia curta que fecha a última linha em
aberto da tabela de §15.4. Três comandos (`community.end` ⏱ main-confirmed,
`community.forget` main-confirmed, `community.activate` standard), a desmontagem por
comunidade extraída do job `removed.purge` para reuso fora da cadência, a marca
`displayNameCollision` de L-5 no `fold` e a limpeza herdada do timer vazando no
`IpcClient.request` (§39.3/§44.3). Barreira inalterada em módulos
(`§4 ok — 86 arquivo(s)`); suíte 851 → **858 testes, 0 falha**, com
`core/test/ciclo-comunidade.test.ts` cobrindo os três comandos sobre rigs reais (hospedeiro
e membro sobre log de gênese) e a L-5 no fold puro com reprojeção. G12 rebuildado em quick.

| Entrega | Onde | Seção | Teste/evidência |
|---|---|---|---|
| `community.end ⏱` | `composition/community.ts` (`endCommunity`) | §15.4, §18.5, §18.7 | só o host corrente (`E_NOT_HOST` advisório); já encerrada é `E_COMMUNITY_ENDED`; resposta `{seq, replicatedTo}` com orçamento de draining; terminal: leitura segue, escrita recusa |
| `community.forget` | boot + `purgeUmaComunidade` | §18.4 | participada é `E_VALIDATION` (emenda datada); desconhecida `E_NOT_FOUND`; left sai do disco, do LS e do runtime; fluxo de membro real leave→forget sem deixar fila órfã |
| `community.activate {cid \| null}` | `composition/structure.ts` + `manifest.residencyOf` | §8.1 | ativa fixa `full`, `null` volta a `light`, hospedada continua `full` pela regra derivada; escolha LOCAL persistida em `local_navigation` |
| L-5 no fold | `fold/apply.ts` (`recalcularColisoesDeNome`) | §6.1 | NFKC+casefold+colapso colidem; rename e saída desmarcam; reprojeção produz as MESMAS marcas |
| Timer de 30 s sem vazamento | `IpcClient.request` | §15.4 ⏱ | o handle vive dentro do registro pendente e é limpo em TODO desfecho (resposta, epoch bump, timeout) |

### 57.1 Decisões e por que são estas

| Decisão | Justificativa de engenharia | Justificativa normativa |
|---|---|---|
| O draining de `end` corre sobre sinais LOCAIS, como no `core.shutdown` | A barreira por PARES de §18.7 continua aguardando o transporte medir confirmações (pendência desde §56.3); inventar confirmação seria pior que declarar o limite. O orçamento (`DRAIN_BUDGET_MS`, §27.2) e a ordem são os mesmos dos dois lugares | §18.7 ("o mesmo procedimento vale para community.end"); pendência explícita |
| `forget` recusa participada com `E_VALIDATION`, não código novo | A pré-condição está na própria linha da tabela ("de uma comunidade left/removed"); um terceiro erro para uma recusa de estado seria superfície nova sem necessidade — a emenda datada registra a célula | §15.4 tabela fechada + emenda datada; precedente de erros genéricos nomeados |
| `activate` persiste ESCOLHA local e deriva o resto pela regra de §8.1 | Armazenar residência por comunidade criaria segunda fonte para um fato derivável (host → full; ativa → full). O comando fixa a ATIVA; a regra manda no resto. Carga sob demanda de mensagens em `light` ainda não existe no projector — pendência registrada (a medir em G9) | §8.1 regra de residência literal; DR-32 (navegação é outro dono, outra superfície) |
| L-5 recalculada INTEIRA nas ops que mudam nome ou conjunto ativo | Marca incremental por op seria segunda implementação da mesma definição (e cada atalho uma chance de divergir); O(membros) por op afetada é barato no teto do v1. Escrita só via `draft.mutMember`, para não furar o compartilhamento estrutural do DS | §6.1 L-5 ("o fold marca… todo membro cujo displayName normalizado coincida"); determinismo de §28.4 |
| Colisão normaliza com casefold além do `trimCollapseNFKC` | O texto de L-5 pede "NFKC + casefold + colapso de espaço" — o normalizador de §8.6 sozinho não faz casefold; a marca tem normalização PRÓPRIA, derivada dele, não compartilhada | §6.1 L-5 literal |

### 57.2 O que mudou no normativo

| Documento | Mudança |
|---|---|
| `docs/backend-v2.md` §15.4 | emenda datada na célula de erros de `community.forget`: `E_VALIDATION` para comunidade ainda participada |

### 57.3 O que continua pendente

| Pendência | O que falta | Quem fecha |
|---|---|---|
| Barreira de replicação por confirmação de PARES (§18.7) | inalterada desde §56.3 | fase de transporte/mídia real |
| Residência `light` efetiva no projector | a escolha de `community.activate` é persistida e consultável; carregar `messages` sob demanda conforme §8.1 é trabalho do projector (a medir em G9) | fase de escala/G9 |
| ~~Oferta de sucessão U-18 (tela), renderer real~~, empacotamento e sondas NAT/STUN | ~~oferta e renderer~~ **entregues em §58**; empacotamento e sondas inalterados desde §56.3 | fase de release |
| Superfícies `dev.*` | seguem fora do escopo do v1 | decisão de produto |
| Herdadas | §50.3–§56.3 sem mudança adicional além das entregas riscadas | ver §56.3 |

---

## 58. A UI acorda: o renderer real sobre a IPC-R 2026-08-23

**Gate de entrada:** nenhum gate específico. A fatia liga o `frontend/` à IPC-R que o shell
de §56 já cruza e fecha as pendências de UI que §54–§57 deixaram esperando. Ao ligar,
apareceram **três defeitos de fronteira do shell** que nenhum teste automatizado podia ver —
o smoke do Electron nunca rodou (pendência declarada desde §56.3) — e os três eram fatais
para o passo 3 de §15.1 e para o passo 2 de §15.2. Estão corrigidos aqui.

Núcleo inalterado em superfície: barreira `§4 ok — 86 arquivo(s)`, suíte em **858 testes**.
G12 rebuildado em quick. `frontend/`: `npm run build` e `npm run lint` verdes (não há test
runner ali — §29/`CLAUDE.md`); `app/`: `npm run typecheck` verde.

| Entrega | Onde | Seção | Evidência |
|---|---|---|---|
| Cliente IPC-R do renderer | `frontend/src/ipc/{frames,client,bridge,api,dto}.ts` | §15.1, §15.2, §15.3, §15.6 | quadros da tabela fechada; epoch descarta o resto; `evAck` por evento e `evStale` → resync; timeout 10 s / 30 s nas ⏱; token de §15.3 só do main |
| `hello` passa a existir no produto | `composition/boot.ts` | §15.1 | **era o defeito 1**: nenhum caminho de produção chamava `IpcServer.sendHello` — só rigs. Sem ele o `waitForHello` do renderer nunca resolveria. Sai depois da última linha do roteador e antes de qualquer `ev` |
| A porta chega VIVA ao renderer | `app/src/preload/index.ts` | §3.4 | **era o defeito 2**: a porta era exposta por getter do `contextBridge`, que serializa o que atravessa, e o `start()` era chamado sem listener — o `hello` enfileirado seria descartado. Agora vai por `window.postMessage(..., [port])`, e quem escuta é quem inicia |
| Porta nova a cada núcleo novo | `app/src/main/index.ts` (`entregarPortaAoRenderer`) | §15.2 passo 2 | **era o defeito 3**: a porta 2 só era transferida no `did-finish-load`; num respawn o renderer ficava com a porta do núcleo morto e a recuperação parava no `hello` que não chega |
| Sessão e primeiro uso | `live/sessao.ts`, `live/telas/PrimeiroUso.tsx` | §3.3, §15.4 | gate por `core.status.phase`; `identity.create` (open) e `identity.import` (main-confirmed); o erro aparece no campo que o `field` de §15.2 nomeia |
| Rail, estrutura e canal | `live/comunidades.ts`, `live/canal.ts`, `live/telas/*` | §15.5, §15.6 | eventos como sinal para reconsultar; `hostStatus` pelo enum fechado de nove valores; `inactiveDays` ausente não vira zero |
| Fila honesta de envio | `live/canal.ts` + `telas/Canal.tsx` | §11.1, §11.6, §15.2 | `message.send` responde `{opId, state}` e a mensagem fica NA FILA até `messages.appended`; `accepted`/`failed`/`dropped` são o desfecho; nada é reenviado sozinho, e `query.outbox.preview` redesenha a fila ao reabrir (F-16) |
| Gatilho de typing na UI | `live/canal.ts` | §17.6 + emenda de §15.4 | abrir canal chama `channel.subscribeTyping{on:true}`, sair chama `{on:false}`, e o resync refaz a assinatura |
| Oferta de sucessão U-18c | `live/telas/Sucessao.tsx` | §18.8, §18.8.1, U-18 | oferta só com `successorKeys` ∋ eu **e** `inactiveDays ≥ 30`; `community.assumeHost` main-confirmed; `pendingReentry` ausente ≠ lista vazia; texto obrigatório literal |
| Deep link ponta a ponta | `live/deeplink.ts`, `telas/DeepLinks.tsx` | §3.5, §12.3, §15.6 | `join` → `invite.resolve` + `invite.redeem`; `m/` → `query.resolveMessageLink`, cujos cinco desfechos são estados de tela |
| Base relativa no bundle | `frontend/vite.config.ts` | §3.1 | o renderer é carregado por `loadFile`; em `file://` a base absoluta do default apontaria para a raiz do disco |

### 58.1 Decisões e por que são estas

| Decisão | Justificativa de engenharia | Justificativa normativa |
|---|---|---|
| O cliente IPC-R é **reimplementado** em `frontend/src/ipc/`, não importado de `core/` | O `IpcClient` de `core/src/l3/ipcRenderer` existe para os rigs: fala `onMessage(listener)` de `MemoryIpcPort`, mora num pacote ESM sem `exports` cujo build roda a barreira de camadas, e vem junto com o `IpcServer`. Um `file:../core` faria o build do Vite depender de `core/dist` e arrastaria L0..L2 para o grafo do renderer. O `MessagePort` real precisaria de adaptador de qualquer jeito | O contrato compartilhado é o **quadro** de §15.1, não a classe. §4 separa as camadas justamente para a fronteira não vazar |
| A UI viva não usa `react-router` | Dentro do Electron não há barra de endereço, e os deep links chegam como evento do main já parseado — nunca como URL. O próprio mock já dizia (`App.tsx` §4) que comunidade e canal selecionados são estado, não recurso endereçável | §3.5(2): o main encaminha dado estruturado, nunca a string original |
| A fila de envio é desenhada **como fila**, fora da conversa, e reconciliada por `query.outbox` | Um "otimismo" que insere a mensagem no meio da lista promete `seq` e hora do host que ainda não existem, e mente na hora exata em que a rede falha. A fila é o estado real de §11.1, e o `preview` de §15.6 existe para redesenhá-la ao reabrir | §11.6 r. 2 (`accepted` vem DEPOIS do `appended`); §15.2 passo 5 (a escrita em voo está na outbox, não se reenvia); F-16 |
| Presença é o ÚNICO evento cujo payload vira estado, com TTL local de 45 s | Não há query de presença por comunidade na tabela fechada de §15.6, e o evento é declaradamente um delta do que mudou. Reconsultar não devolveria o dado; guardar com TTL é o que a própria emenda descreve | §15.5 emenda de 2026-08-23; §17.6 (TTL 45 s); §6.1 — `offline` não é publicado, e a tela nunca o escreve |
| O gate de primeiro uso é `core.status.phase`, não `query.identity` | `query.identity` é `standard`: sem identidade ele **recusa** com `E_NO_IDENTITY`. Usar um erro como resposta faria a tela depender de uma recusa continuar significando a mesma coisa | §15.3 (classes) e §3.3 (a fase é o que o núcleo declara) |
| Do mock só `components/ui/` entra no caminho vivo | `src/domain/types.ts` é o modelo das fixtures, com enums próprios (`HostStatus` de três valores, `position` em vez de `rank`). Mapeá-lo nos DTOs de §15.6 seria inventar correspondência campo a campo — exatamente o que o precedente de §46–§57 proíbe. Os componentes de `ui/` não conhecem domínio nenhum e foram reaproveitados inteiros | `CLAUDE.md`: o mock não é a arquitetura final; §15.6 é a fonte dos tipos |
| Voz e tela aparecem como botão **desabilitado com motivo nomeado** | A capacidade existe na spec e some da tela se for escondida; fingir que funciona é pior. O motivo nomeado diz de quem é a fatia | Mídia pela rede real está fora do escopo desta fatia; §17 permanece intocado |

### 58.2 O que mudou no normativo

Nada. A fatia é implementação: as três correções de fronteira do shell fazem o código
cumprir §15.1 e §15.2 como já estavam escritos, e nenhuma tabela fechada ganhou campo ou
tópico.

### 58.3 O que continua pendente

| Pendência | O que falta | Quem fecha |
|---|---|---|
| U-17 — "opção de removê-la do rail" numa comunidade **encerrada em que ainda sou membro** | não há comando único para isso: `community.forget` recusa comunidade ainda participada com `E_VALIDATION` (emenda de §15.4), então o caminho é `community.leave` e depois `forget`. Sair de uma comunidade encerrada para poder esquecê-la é uma sequência que o delta não descreve — a tela não a inventou. O resto de U-17 (permanece no rail, ícone esmaecido, cabeçalho com a data, sem composer) está entregue | decisão de UX + §15.4 |
| ~~Telas do mock não migradas~~ | ~~busca, configurações, cargos, moderação, threads, anexos, menções e os componentes de `features/**`~~ — **migradas em §58.5**: 88 das 101 entradas do roteador têm tela; as 13 restantes são voz/tela/relay, por escopo | — |
| ~~Sem cobertura automatizada no renderer~~ | ~~`frontend/` não tem test runner~~ — **resolvido em §58.4**: Vitest entra no `frontend/`, e o cliente de IPC-R tem 20 casos cobrindo epoch, `evStale`, reassinatura e o "nada é reenviado". **Os componentes seguem sem teste** — a fatia cobriu o transporte, não as telas | fatias de UI seguintes |
| Smoke manual do Electron | continua sendo a única evidência possível do caminho ponta a ponta, e continua não executada nesta árvore — as três correções desta fatia **saíram de leitura**, não de execução. Roteiro em §56.1, agora com um passo a mais: com o núcleo vivo, `kill -9` no processo do núcleo deve trocar a porta e refazer as assinaturas sem recarregar a janela | ambiente de release |
| ~~Flake pré-existente de teardown na suíte do core~~ | ~~857/858 com uma falha que muda de arquivo a cada execução~~ — **resolvido em §58.4**, e **não era do teardown**: `BlobManager.close()` devolvia com o core de blobs ainda fechando. Suíte em **859/859**, seis execuções seguidas | — |
| Barreira de replicação por PARES (§18.7), residência `light` no projector, empacotamento, sondas NAT/STUN, `dev.*` | inalterados desde §57.3 | ver §57.3 |

### 58.4 Emenda de 2026-08-23 — os dois passos seguintes, executados

Duas pendências de §58.3 eram acionáveis de imediato e foram fechadas na mesma sessão. A
primeira delas não era o que o nome dizia: perseguir o "flake de teardown" levou a um defeito
de produto no fechamento do núcleo.

**Como a causa apareceu.** Uniformizar o `maxRetries` nos 69 teardowns derrubou a frequência
mas não a falha: uma execução em ~6 seguia com `ENOTEMPTY` em `cores/blobs/<key>/db`, e
ampliar a janela para 1 s não adiantou — o teste que falhou tinha durado 10 s. Janela que não
resolve não é corrida de janela. Um experimento isolado (30 ciclos de abrir, appendar, fechar
e remover um hypercore) fechou 30/30 sem falha nenhuma, o que descartava a biblioteca e
apontava para um core que **nunca era fechado**. Era: o `void detachLocalCore(...)` do
`stop()` da comunidade.

| Entrega | Onde | Evidência |
|---|---|---|
| `BlobManager.close()` passa a esperar o disco | `core/src/l2/blobs/index.ts` | **a causa real do flake, e um defeito de produto**: `OpenCommunity.stop()` é síncrono por contrato e chama `detachLocalCore` sem poder esperá-lo; o detach saía do registro na hora e fechava o core numa promessa que **ninguém segurava**. `close()` iterava um registro já vazio e devolvia com o RocksDB ainda fechando. Agora os fechamentos em voo ficam registrados e `close()` os espera |
| A propriedade fica fixada em teste | `core/test/attachments.test.ts` (§58.4) | dispara `detachLocalCore` sem esperar, como o `stop()` faz, e exige que `close()` só devolva com o core fechado. Verificado por mutação: com a correção revertida, o caso falha |
| Teardown dos rigs segue a convenção já registrada | `core/test/*.ts` | `{ recursive: true, force: true, maxRetries: 5, retryDelay: 20 }` existia em 15 dos 69 `rmSync` recursivos; agora está nos 69. É cinto de segurança, **não** o que resolveu |
| Vitest e a cobertura do cliente de IPC-R | `frontend/package.json`, `frontend/src/ipc/__testes__/client.test.ts` | 20 casos: aperto de mão e epoch, `req` com e sem `authToken`, `field` do erro preservado, quadro de outro epoch descartado, timeout por comando sem handle sobrevivente, `evAck` por evento, as duas obrigações do `evStale`, `unsub` com o `subId` do núcleo, `subOk` atrasado que cancela, e os passos 4a–4d de §15.2 |

**Por que Vitest e não `node:test` como no núcleo.** O `frontend/` é um projeto Vite: o
runner lê o `vite.config.ts` e o `tsconfig` que já existem, sem segunda configuração de
compilação. Reproduzir o caminho do núcleo (`tsc` para `dist/` e `node --test`) exigiria um
tsconfig paralelo só para emitir um pacote que é `noEmit` por definição — mais máquina para
menos alcance, e nada disso serviria aos testes de componente que as fatias de UI seguintes
vão querer. `CLAUDE.md` foi atualizado: a régua do `frontend/` agora é `npm run build`,
`npm run lint` e `npm test`.

**Os testes foram verificados por mutação, não só por passarem.** Removida a reassinatura do
bump de epoch, cai o caso 4b/4c; removido o `evAck` do `evStale`, cai o caso da regra 5;
revertida a correção do `BlobManager`, cai o caso de §58.4. Um teste que não falha quando o
comportamento some não é evidência de nada.

**O que o defeito significava fora da suíte.** `close()` é a barreira em que a máquina de
wipe (§18.6) apaga arquivos e em que o draining (§18.7) declara o núcleo parado. Devolver com
um RocksDB ainda aberto tornava as duas promessas falsas — no wipe, um `E_WIPE_INCOMPLETE`
por diretório ocupado; no quit, a chance de o processo sair no meio do fechamento. A suíte
só era o lugar onde isso ficava visível.

### 58.5 Emenda de 2026-08-23 — as telas restantes do mock, migradas

O que §58.3 chamou de "telas do mock não migradas" está entregue: **toda** superfície do
mock tem par vivo sobre §15.4/§15.6, exceto voz, tela e relay, que dependem de mídia pela
rede real e continuam como botão desabilitado com motivo nomeado.

Cobertura da superfície fechada do roteador: das **101** entradas registradas em
`l3/ipcRenderer/commands.ts`, a UI viva usa **88**. As 13 restantes são exatamente
`voice.*` (5), `share.*` (4), `relay.*` (3) e `settings.setParticipantVolume` — todas da
fatia de mídia.

| Entrega | Onde | Seção | O que a tela promete |
|---|---|---|---|
| Linha de mensagem completa | `telas/Mensagem.tsx` | §15.6.1 | os campos que a UI teria vontade de esconder são os que a spec manda mostrar: `clockSkewed`, `deleted`, `hiddenByBan`, `replyTo.deleted` (F-47/M-7), `editedAt` com a nota de U-19; reação e anexo vêm de `query.message`, que é onde eles existem |
| Ações de mensagem | `live/mensagem.ts` | §15.4 "Mensagens" | editar, remover, fixar, reagir e criar thread — todas **A**: respondem `{opId, state}` e o desfecho vem por evento, como o envio |
| Anexos ponta a ponta | `telas/Anexo.tsx`, `canal.ts` | §13, §13.7 | `file.pickForAttachment` → `blob.stage` → `message.send{attachment:{ticketId}}`: o blob PRIMEIRO, e quem o descreve é o núcleo. Download com progresso vivo, cancelamento e revelação |
| Thread | `telas/Thread.tsx` | §15.6 (DR-48) | raiz e respostas na mesma consulta, estado de leitura próprio (`thread.markRead`); responder é `message.send` com `threadId` — mesma fila, sem caminho especial |
| Painéis do canal | `telas/PainelDoCanal.tsx` | §15.6 | fixadas, arquivos e links são **páginas próprias**, não recortes da lista carregada: filtrar no cliente mentiria por omissão |
| Busca | `live/busca.ts` + painel | §23.1 | a normalização e o `MATCH` são do núcleo (inclusive a regra que torna `AND`/`OR`/`*` literais); `partial` é nomeado pela causa, nunca escondido |
| Roster e perfil | `telas/Membros.tsx` | §15.6, §23.3 | agrupamento, ordem e `offlineCount` vêm prontos; as affordances de moderação são resposta de `query.member`, não recálculo da hierarquia de §8.4.1 |
| Configurações da comunidade | `telas/Configuracoes.tsx` | §15.4 | identidade, canais/categorias, cargos, convites e moderação — todas ⏱, com o botão ocupado até o host confirmar |
| Conta e preferências | `telas/Conta.tsx` | §15.4, §15.6 | preferência local aplica na hora (não passa pelo host); `identity.update` diz **quantas ops enfileirou**, porque é a exceção de §11.1 e o nome só muda em cada comunidade quando o host aceitar |
| Moderação sofrida | `telas/ModeracaoPropria.tsx` | §18.4, U-16 | ban/kick observados viram leitura histórica com quem fez, por quê e o prazo de 7 dias — e o botão de apagar a cópia local chama `community.forget` de verdade |
| Zona de risco | `telas/Configuracoes.tsx` | §15.4 | as três saídas separadas pelo que realmente são: **sair** (local imediato + fila, L-22), **encerrar** (⏱ do host, terminal) e **esquecer** (apaga o disco, só depois de sair) |
| Impacto de sair | `telas/SaidaDoHost.tsx` + main | U-06, §18.7 | o main segura o primeiro `close` e o renderer mostra quantas pessoas caem e **quantas ops não replicaram**, com a contagem viva enquanto se decide. A opção de "avisar quem está online" **não** existe (F-43/RT-13) |
| Hub, criar e entrar | `telas/Hub.tsx` | §15.4, §12 | `community.create` abre já no `defaultChannelId` (o primeiro canal criado, não um canal marcado); entrar por convite funciona antes de existir comunidade, porque `invite.resolve` é `open` |
| Menções | `live/mencoes.ts`, `telas/Mencoes.tsx` | §15.6 | candidatos vêm de `query.members` com o filtro da própria query; a UI manda **chaves**, e quem decide o que é menção é o `fold`. 9 casos de teste nas bordas (`email@host` não abre menção) |
| Diagnóstico | `telas/Conta.tsx` | §15.4 | `diag.run`, `diag.snapshot` e `core.reproject` (main-confirmed) |
| Markdown com a allowlist de esquema | `live/markdown.ts`, `telas/Markdown.tsx` | §15.6.1 (T-18) | **lacuna encontrada ao revisar o que seria descartado**: a linha viva renderizava texto cru, e a única implementação da allowlist estava em `lib/markdown.tsx`, no mock. A análise devolve tokens (testável sem DOM) e a renderização só escolhe a tag; link com esquema fora de `http`/`https`/`mailto` vira **texto com o rótulo visível**, nunca âncora e nunca sumindo |

Frontend em **42 testes** (20 do cliente de IPC-R, 9 do reconhecimento de menção, 13 da
allowlist e do escopo do markdown), build e lint verdes. Núcleo inalterado nesta emenda.

**Decisões desta emenda**

| Decisão | Justificativa |
|---|---|
| Presença **não** recarrega o roster | o delta chega a cada `PRESENCE_TICK_MS` (2 s); refazer `query.members` a cada tick seria uma consulta por segundo para mover um pontinho. O roster traz a presença do instante da leitura, e a tela sobrepõe o mapa vivo com TTL que `comunidades.ts` já mantém |
| Reação e anexo carregados **sob demanda** | `MessageDto` não os carrega (§15.6.1) — são de `query.message`. Pedir por linha visível seria uma consulta por mensagem na tela |
| O modal de saída consulta a cada segundo enquanto está aberto | a fila esvazia enquanto a pessoa lê; um número congelado a faria decidir sobre um dado que já não vale |
| O main passou a segurar o primeiro `close` da janela | U-06 exige mostrar o impacto **antes** de fechar, e o caminho anterior (`window-all-closed`) já roda com a janela fechada. A confirmação volta por um canal novo do preload (`confirmExit`) — fora das tabelas de §15.4/§15.5 de propósito: é coordenação main↔renderer, não superfície de núcleo |

### 58.6 O que continua pendente

| Pendência | O que falta | Quem fecha |
|---|---|---|
| Correlação entre `blob.progress` e `AttachmentDto` não é declarada | o evento identifica o blob por `blobIdHex` (16 bytes, chave do cache local) e o DTO traz o quádruplo de §7.2.1 mais o `hash` completo. §15.6 **não declara a ponte**; ela existe no núcleo, que usa os 32 primeiros caracteres do hash como id do cache. A tela repete essa derivação porque é a única correlação possível — uma correlação não declarada é uma que pode mudar sem aviso | §15.6 (declarar o campo) ou §15.5 (mandar o quádruplo) |
| ~~Árvore do mock fora do caminho vivo~~ | ~~94 arquivos não alcançáveis a partir de `main.tsx`~~ — **resolvido em §58.7**: movidos para `frontend/mock-legado/`, fora de `src`, sem typecheck, sem lint e sem bundle. Apagar teria custado caro: **duas lacunas do produto** foram encontradas lendo esse código depois de a migração se dizer completa | — |
| Voz, tela e relay | 13 comandos sem tela, por escopo: dependem de mídia pela rede real (TURN/relay, captura). Na UI aparecem como botão desabilitado com o motivo nomeado | fase de mídia |
| U-17 — "remover do rail" numa comunidade encerrada ainda participada | **atenuado, não fechado**: a Zona de risco agora oferece sair e apagar a cópia local como dois passos nomeados, com o texto dizendo por que essa é a ordem. Continua sem existir um comando único, e o delta não descreve a sequência | decisão de UX + §15.4 |
| Smoke manual do Electron | inalterado desde §58.3, agora com mais superfície a exercitar — anexos, moderação e o modal de saída nunca rodaram contra um núcleo vivo | ambiente de release |
| Componentes sem teste | os 42 casos cobrem transporte, menção e markdown — a lógica pura; nenhuma tela tem teste de render | fatias seguintes |
| Barreira de replicação por PARES (§18.7), residência `light`, empacotamento, sondas NAT/STUN, `dev.*` | inalterados desde §57.3 | ver §57.3 |

### 58.7 Emenda de 2026-08-23 — o mock sai do produto sem sair do repositório

O mock não era "só dados". Dos 94 arquivos fora do caminho vivo, **um** é fixture
(`mocks/dataset.ts`, 902 linhas); 47 arquivos e ~10 mil linhas são componentes de tela, e o
grafo é conectado: `dataset.ts` é importado por 28 arquivos e as 11 stores por 34, quase
todos em `features/**`. Como `tsconfig.app.json` inclui `src` inteiro, apagar a base
derrubaria o `tsc -b` no que se quis preservar — inclusive `features/voice/**`, que é a
única especificação executável das telas de mídia ainda não migradas.

A saída foi mover, não apagar: `frontend/mock-legado/`, fora de `src`, com `README.md`
próprio. Fica fora do typecheck (`--listFiles` não lista nenhum arquivo de lá), fora do lint
(`ignorePatterns`) e fora do bundle (nenhuma referência em `dist/`). Os 80 imports que
apontavam para peças ainda vivas (`Button`, `TextField`, `Spinner`, `StatusBanner`,
`lib/cn`, `index.css`) foram reapontados para `../src/...`, e uma varredura confirma que
**todo** import relativo do diretório resolve.

**Duas lacunas do produto saíram de ler o que seria descartado**, depois de a migração de
§58.5 já se dizer completa. Elas são a justificativa da decisão, não uma nota de rodapé:

| Lacuna | Onde estava | Onde fechou |
|---|---|---|
| A linha de mensagem viva renderizava `content` **cru**: sem markdown e, portanto, sem a allowlist de esquema de §15.6.1 (T-18). A única implementação estava em `lib/markdown.tsx`, no mock — e ela ainda omitia `mailto` | `mock-legado/lib/markdown.tsx` | `src/live/markdown.ts` + `telas/Markdown.tsx`, com 13 casos e o `javascript:` no centro |
| Um `join/<código>` chegando no **primeiro uso** era resolvido pelo núcleo e descartado em silêncio: os overlays de deep link só existiam dentro do `Shell`, que não é montado em `sem-identidade` — exatamente o caso que o fluxo descreve, e a razão de `invite.resolve` ser classe `open` | `mock-legado/store/inviteStore.ts` (dito no cabeçalho do arquivo) | `src/live/LiveApp.tsx`: overlays acima do `Shell`, prévia sem identidade e botão desabilitado com o motivo dito |

**Quando apagar de vez.** Quando `voice.*`, `share.*` e `relay.*` tiverem tela viva. Aí
`features/voice/` deixa de ser referência de nada, e o resto do diretório já terá cumprido a
função de ser lido.

### 58.8 Emenda de 2026-08-23 — a fronteira de cor e o teste de contrato

A métrica de §58.5 ("88 das 101 entradas têm tela") media que a UI **chamava** o comando,
não que chamava **certo**. Perguntar quais eram os próximos passos expôs a diferença.

#### O defeito: cor é `u8`, e a UI mandava string

§6.4.2 é literal: cor viaja como `u8` em material assinado (`identity.create`/`update`,
`community.create`/`update`, `role.create`/`update`), então o número é **constante de
protocolo** — valor fora da faixa é `E_VALIDATION` no campo, e não é clampado nem
substituído por default, porque clampar faria duas réplicas com paletas de tamanhos
diferentes convergirem para cores diferentes a partir do mesmo log.

A UI mandava `"role-blue"`. Consequências, todas em produção:

- **`identity.create` sempre falhava** — a tela de primeiro uso não passava do botão;
- `community.create`/`update`, `identity.update`, `role.create`/`update`: `E_VALIDATION`;
- na leitura, `UserRef.avatarColor` vem como string do número (`"3"`), e a tela a usava como
  token de tema: `var(--color-3)` não existe, então **todo avatar e todo cargo caía no
  fallback**.

| Entrega | Onde |
|---|---|
| Catálogo de §6.4.2 num só lugar, com as duas faixas (cargo 0..6, avatar/ícone 0..7) | `src/ipc/cores.ts` |
| Número no fio: os seis comandos passam a exigir `number` no tipo | `src/ipc/api.ts` |
| Token só na renderização; `corDe` traduz pelo catálogo e cai num fallback **nomeado** | `telas/formato.ts` |
| Seletor único da paleta curada, com o número como valor | `telas/EscolhaDeCor.tsx` |
| 6 casos, incluindo a armadilha `Number("") === 0` — sem a guarda, cor ausente virava a cor 0 em silêncio | `__testes__/cores.test.ts` |

#### O teste de contrato: o cliente contra o roteador real

Os 20 testes de transporte falam com uma porta falsa, que aceita qualquer coisa — foi por
isso que o defeito passou. O arquivo novo sobe o **`IpcServer` real** com
`registerCoreCommands` sobre um esboço de dependências e roda **89 chamadas**, uma por
comando que a UI usa, com o argumento que a UI monta. O critério é o código: `E_VALIDATION`,
`E_MALFORMED` e `E_UNKNOWN_COMMAND` significam recusa de forma.

**O alcance é menor do que o nome sugere, e está escrito no arquivo.** A validação de tipo
não mora toda no roteador: 55 pontos de `commands.ts` recusam ali, mas `identity.create`
apenas encaminha `arg['avatarColor']` e quem confere é a composição — que no teste é esboço.
Para esses comandos, o teste prova que o argumento *chega*, não que é aceito. É exatamente
por isso que o caso "com dente" usa `role.create` (validado na fronteira) e não
`identity.create`. Há um caso que **documenta o limite**: `color: 8` passa o roteador, porque
a faixa é do `fold`, não da fronteira.

**Custo declarado:** o arquivo importa `core/dist`, então `npm test` no frontend exige o
núcleo compilado (`npm run test:contrato` faz os dois). É acoplamento de teste, não de
bundle — o Vite continua sem saber que o núcleo existe.

#### A marca de L-5 não chegava à UI

Caçando o tipo de `avatarColor` apareceu que `queryUserRef` devolvia `collision: false`
**fixo**, com um comentário dizendo que o `fold` ainda não marcava. O `fold` marca desde §57
(`displayNameCollision`): a marca morria na fronteira, e o desempate de homônimos ativos
nunca chegava à tela que já sabia desenhá-lo. `queryUserRef` passa a lê-la; teste em
`ciclo-comunidade.test.ts` §58.8, verificado por mutação. Suíte 859 → **860**.

Frontend em **141 testes** (20 transporte, 9 menção, 13 markdown, 6 cores, 92 contrato +
dente), build e lint verdes.

#### O que isto diz sobre as métricas anteriores

Três relatórios seguidos usaram cobertura de superfície como prova de correção — "86 arquivos
na barreira", "88 das 101 entradas", "42 testes". Nenhuma delas teria pego a cor. A pendência
que fica não é "faltam telas": é que **nenhum caminho tinha sido exercido ponta a ponta**, e
os testes que existiam mediam o que era fácil medir.

### 58.9 O que continua pendente

| Pendência | O que falta | Quem fecha |
|---|---|---|
| Metade da validação fora do alcance do teste de contrato | comandos que delegam a checagem de tipo à composição (`identity.create` é o caso conhecido) só são cobertos até a chegada do argumento. Fechar exige compor as portas reais no teste, com `manifest`/`view` em temporário | fatia seguinte de teste |
| Inconsistência de cor no fio na LEITURA | `UserRef.avatarColor` vem como string do número (§15.6 declara `string`), enquanto `query.communities.iconColor` vem como número cru. `ipc/cores.ts` absorve as duas formas, mas a tabela deveria declarar uma só | §15.6 |
| Correlação `blob.progress` ↔ `AttachmentDto` | inalterada desde §58.6 | §15.6 ou §15.5 |
| Smoke manual do Electron | inalterado, e agora mais valioso: com a cor corrigida e o contrato verificado, o que sobrar de defeito ali é do caminho real | ambiente de release |
| Voz, tela e relay; U-17; barreira de PARES; residência `light`; empacotamento; sondas NAT/STUN | inalterados desde §58.6 | ver §58.6 |

### 58.10 Emenda de 2026-08-23 — o aceite do cofre inseguro, sem o qual o smoke não sai do lugar

Preparar o roteiro do smoke manual expôs um bloqueio que nenhum teste podia mostrar: **em
máquina sem secret store, o produto para na primeira tela e não há como sair dela.**

O caminho é fechado e correto até o último passo. `safeStorage` cai em `basic_text`,
`CoreStatus.keystore` diz `insecure-fallback`, e `identity.create` recusa com
`E_KEYSTORE_INSECURE` — exatamente o que L-2 manda. L-2 também manda a saída: aceitar o modo
inseguro "numa tela dedicada". O aceite existia na composição (`acceptInsecure`, persistido
em `<dataDir>/keystore-accepted`), mas **não havia gatilho IPC-R**: a tela normativa era
inalcançável. Mesma forma de lacuna de `channel.subscribeTyping` em §56 — capacidade sem
porta.

| Entrega | Onde | Seção |
|---|---|---|
| `identity.acceptInsecureKeystore {}` — open, idempotente | roteador + `composition/identity.ts` + boot | §15.4 (emenda datada), §3.2 L-2 |
| Recusa com `E_VALIDATION` quando o cofre está `secure` | `acceptInsecureKeystore()` | precedente de §57 (erro genérico de estado, não código novo) |
| Tela dedicada, com o que se está aceitando dito em termos concretos | `telas/CofreInseguro.tsx` | §3.2 L-2 |
| Gate no primeiro uso: aviso permanente quando degradado, tela no `E_KEYSTORE_INSECURE` | `telas/PrimeiroUso.tsx` | §3.2 L-2 |
| Teste na fronteira: recusa → aceite → criação passa; aceite idempotente; arquivo no disco | `identidade-superficie.test.ts` | — |

**Decisões**

| Decisão | Justificativa |
|---|---|
| Classe `open`, não `main-confirmed` | é a pré-condição de `identity.create` (que é `open` pelo mesmo motivo: em `awaiting-identity` não há identidade contra a qual autorizar). `main-confirmed` existe para impedir que um renderer comprometido **destrua dado** sem confirmação nativa; o aceite não destrói nada |
| Sem campo novo no `CoreStatus` para "já aceitou" | o desfecho de `identity.create` É a resposta: `E_KEYSTORE_INSECURE` abre a tela, e o sucesso a dispensa. Um campo no schema fechado de §15.6 seria superfície nova para uma pergunta que o erro já responde |
| O aceite **não** dispara a criação | quem preencheu o formulário é a pessoa; reenviar por conta própria decidiria por ela um ato que ela acabou de ser avisada de que é arriscado |
| O indicador permanente continua aceso depois do aceite | aceitar não torna o cofre seguro. `keystore` segue `insecure-fallback`, e a faixa do shell segue lá — a segunda metade do que L-2 exige |
| O `backend` gravado no aceite é o `kind` que o núcleo conhece | o nome real do backend do `safeStorage` é do main e não cruza a IPC-M hoje. Registrado abaixo |

**Pendência nova:** o nome do backend do `safeStorage` (`gnome-libsecret`, `kwallet6`,
`basic_text`) não chega ao núcleo, então o aceite registra `insecure-fallback` em vez do
backend concreto. O campo é informativo — `hasAcceptedInsecure` só verifica a existência do
arquivo —, mas para auditoria de G10 o nome real seria melhor. Fecha na IPC-M (§15.7).

### 58.11 Emenda de 2026-08-23 — a primeira execução real, e os dois defeitos que ela achou

O smoke manual rodou pela primeira vez nesta árvore. Resultado: **tela branca, e a janela
não fechava.** Dois defeitos independentes, os dois em `app/src/main/index.ts`, nenhum
alcançável por teste automatizado — e os dois de uma classe que este projeto já conhece:
falha que se apresenta calada.

**1. Caminho do renderer com um `..` a menos.** `path.join(__dirname, '../../frontend/dist/index.html')`
resolve, a partir de `app/dist/main`, para `app/frontend/dist/index.html` — que não existe.
O `if (fs.existsSync(...)) ... else loadURL('http://localhost:5173')` então caía no dev
server; sem Vite no ar, janela branca **sem uma linha de log**. O fallback silencioso é o que
transformou um caminho errado em sintoma mudo.

Corrigido com candidatos explícitos (árvore de desenvolvimento e layout empacotado), a
escolha registrada no log, `P2P_RENDERER_URL` para apontar ao Vite quando se quiser, e —
quando nada é encontrado — uma página que **diz o que faltou** em vez de branco.

**2. O guarda de saída de U-06 prendia a janela.** O `close` fazia `preventDefault()` e
mandava `exit-impact` ao renderer, esperando que ele chamasse `confirmExit`. Com o renderer
morto (tela branca), ninguém chamava, e não havia saída pela interface. Introduzido em §58.5
e não exercido até aqui.

Corrigido com três escapes, nesta ordem: renderer destruído, travado ou ainda carregando não
segura o fechamento; a **segunda** tentativa de fechar não é mais segurada; e um prazo de
10 s fecha sozinho, com aviso no log. **U-06 pede mostrar o impacto, não impedir a saída** —
um guarda que pode prender a janela é pior que não ter guarda.

**O que isto acrescenta ao que §58.8 já dizia.** As três correções de fronteira de §56–§58
saíram de leitura de código e estavam certas. Estes dois só apareceram na execução, e são de
um tipo que nenhuma suíte pega: um depende de `__dirname` em tempo de execução, o outro de
uma interação humana com uma janela. A conta de dois defeitos na primeira execução é a
medida do que ainda não foi exercido — e o roteiro do smoke mal tinha começado.

## 59. O smoke roda: quatro defeitos do caminho real, e o §15.2 provado ponta a ponta — 2026-08-23

**Gate de entrada:** nenhum gate específico. Esta fatia ataca a pendência de §56.3 que
atravessou §58 inteiro: o smoke manual do Electron. Rodou pela primeira vez — primeiro sob
Xvfb com o renderer dirigido por CDP (motor em `/tmp/opencode`, fora da árvore), depois na
máquina de quem escreve, inclusive o fechamento pelo X da janela com o modal de U-06
confirmado à mão. A UI abria e dizia "O núcleo não respondeu" com o terminal dizendo
núcleo saudável. Quatro defeitos do caminho real saíram disso; nenhum dos quatro era
alcançável pelas suítes.

Estado ao fim da fatia: núcleo `§4 ok — 86 arquivo(s)`, **866 testes** (+3 de cofre, +3 de
derivação TURN, forma do `replication` emendada no teste que a codificava errado); G12 quick
S1–S6 ok; `frontend/`: build, lint e **144 testes** (+2) verdes; `app/`: typecheck verde.
Smoke executado de ponta a ponta: sair de `conectando`; gate do cofre inseguro (§58.10) com
aceite; identidade criada; comunidade criada; mensagem vista NA FILA antes de subir;
`kill -9` no núcleo → epoch+1, porta nova, assinaturas refeitas **sem recarregar a janela**
(sentinela em `window` intacta); segunda mensagem atravessando o núcleo respawnado; draining
limpo com saída código 0.

### 59.1 Defeito 1 — a porta IPC-R que nunca chegava

O `did-finish-load` dispara com `webContents.isLoading()` ainda `true` neste Electron
(o evento sai antes do estado interno de carga encerrar). A guarda de §58 devolvia cedo,
e não havia terceiro momento: `spawnUtility` entregara para janela inexistente, e o evento
que deveria retomar já tinha passado. A porta 2 morria no main; a tela acusava "o shell não
transferiu a porta IPC-R". Instrumentação nos três processos ([main], [nucleo], [ponte])
cravou a ordem real dos eventos antes de qualquer correção.

Correção (`entregarPortaAoRenderer`): com carga em curso, a entrega é adiada para
`did-stop-loading` — o fim de carga real — exatamente uma vez, com marca de entrega única
por canal (porta transferida é neuterada; repostá-la lança). Canal novo (respawn) zera a
marca ao nascer.

**As outras duas hipóteses caíram por evidência.** O `hello` postado na porta 1 ANTES da
transferência sobreviveu à fila até o `start()` do renderer (`hello recebido (epoch 1)` ~50 ms
após o attach): o contrato de §15.1 — hello como primeiro quadro, uma vez só — segue válido
SEM emenda, e reemitir seria violá-lo. E a escuta do renderer registra aos ~60 ms de página,
antes de qualquer entrega possível: a ordem useEffect × did-finish-load não chegou a competir.

### 59.2 Defeito 2 — o cofre recusava com o erro errado, e o gate de §58.10 era inalcançável

Na máquina real, `identity.create` devolvia `E_KEYSTORE_UNAVAILABLE`. A fiação passava
sempre por `secureKeystorePort`, cujo `kind()` era fixo em `'secure'` e cuja `available()`
repassava cru o `isEncryptionAvailable()` do main. E a plataforma mudou sob a L-2: no
Electron 43, sem secret service o `safeStorage` cai em `basic_text` **e se recusa a cifrar**
(`isEncryptionAvailable() === false`; `encryptString` lança). Resultado: nem o modo seguro
nem o inseguro — um erro de infraestrutura calmo, e a tela de aceite de §58.10 inalcançável
por fiação, embora implementada e testada no roteador desde §58.10.

Correção (`composeKeystore`, composition/identity.ts): a composição pergunta ao main uma vez
(`keystoreInfo`) e escolhe — cifra disponível → oráculo IPC-M, `'secure'`; sem cifra → o
modo explícito da L-2 com `FallbackKeystoreOracle`: wrap por obfuscação local, criação
recusada com `E_KEYSTORE_INSECURE` até o aceite, indicador permanente em `CoreStatus.keystore`.
O mesmo oráculo composto alimenta o `IdentityManager` e o unwrap inicial da Data Key — quem
wrapa a identidade é ele, não o serviço. O fluxo medido no smoke: aviso permanente na tela
de primeiro uso → criar → gate → aceitar → criar → shell pronto, faixa do modo inseguro acesa.

### 59.3 Defeito 3 — `community.create` morria em `E_INTERNAL`

Duas camadas. Embaixo: o utility derivava `'ns/hostturn/1'` com
`crypto.createHash('blake2b512')` — digest que **não existe no OpenSSL do Electron**
("Digest method not supported"; stock Node tem, o utilitário rodando sob Electron não).
Em cima: o `catch` em torno de `openCommunity`/`register` engolia a causa e devolvia
`E_INTERNAL` — falha calada, a classe exata que §58.11 condenou.

Correções: `hostTurnSecretFrom(dataKey, communityId)` no `l0/corestore`, BLAKE2b-256 via
sodium — a canônica da tabela de §5.2, a mesma de todas as derivações irmãs — importada pelo
`loadCore` do utility (que ganhou o módulo na lista fechada); e o `catch` agora nomeia a
causa no log antes de responder o código de §15.4. Foi este log que achou a camada de baixo
na primeira passagem; sem ele o defeito seguiria anônimo.

### 59.4 Defeito 4 — `query.messages` mandava `{state, lag}` onde §15.6 manda o enum

A resposta trazia `replication` como objeto; a tabela de §15.6 declara
`replication: ReplicationState` (a string). A UI indexava a tabela de banners com o objeto,
`REPLICACAO[objeto]` era `undefined`, e a leitura de `.texto` derrubava a árvore React
inteira: abrir canal virava tela vazia. O pior é que havia teste afirmando a forma errada
(`typeof primeira.replication.state === 'string'`) — o duplo estava fiel à implementação,
não ao normativo.

Correção no NÚCLEO (fonte da verdade é a tabela, não a UI): `replication: ...state`. O teste
de leitura foi emendado para exigir o enum literalmente — é o dente contra regressão de FORMA,
que é o que este arquivo protege.

### 59.5 Achados de plataforma, decisões e pendências

| Entrega | Onde | Seção | Evidência |
|---|---|---|---|
| Entrega da porta IPC-R adiada para o fim de carga real, única por canal | `app/src/main/index.ts` | §3.1 | smoke: `did-finish-load → adiada → did-stop-loading → transferindo → porta recebida (t≈70 ms) → hello epoch 1` |
| Tabela do cofre na composição | `composition/identity.ts` (`composeKeystore`) + `app/src/utility/index.ts` | §3.2 L-2, A13(5) | smoke: aviso permanente → `E_KEYSTORE_INSECURE` → aceite → identidade criada; `CoreStatus.keystore = 'insecure-fallback'` |
| Derivação de `'ns/hostturn/1'` no núcleo | `l0/corestore/index.ts` (`hostTurnSecretFrom`) + utility | §5.2, §17.3 | `community.create ok:true` no probe; 3 testes fixam determinismo e canonicidade |
| Causa visível quando open/register falha | `composition/community.ts` | §15.4 | o log achou o `blake2b512` que ninguém via |
| `query.messages` manda o enum | `composition/queries.ts` | §15.6 | canal abre sem derrubar a árvore; teste exige valor do enum |

| Decisão | Justificativa |
|---|---|
| §15.1 SEM emenda: hello continua único, pré-transferência | evidência empírica: quadro enfileirado sobrevive a `MessagePortMain → webContents.postMessage → preload → window`; reenviar o hello violaria "primeiro quadro de todo canal" |
| Modo inseguro wrapa com oráculo local, não com o IPC-M | o Electron 43 se recusa a cifrar em `basic_text`; usar o main deixaria o aceite de L-2 sem para onde levar |
| Falha de consulta ao `keystoreInfo` vale como "sem cifra" | incapaz é o mais seguro dos dois erros; rigs sem IPC-M preservam o caminho capaz |
| Correção da forma do `replication` no núcleo, não na UI | a tabela de §15.6 é fonte da verdade; o DTO do renderer já declarava o enum |

| Pendência | O que falta | Quem fecha |
|---|---|---|
| ~~Smoke manual do Electron~~ (§56.3) | **fechada nesta fatia.** Sob Xvfb+CDP: conexão, primeiro uso com aceite, comunidade, fila da outbox, `kill -9` com resync sem reload (§15.2) e draining código 0. Na máquina real, com gesto nativo: X → o guarda segurou a janela → modal U-06 → "Fechar mesmo assim" → saída limpa (confirmado em 2026-08-23). Nota de plataforma: `window.close()` do renderer contorna o evento `close` neste Electron e não é gesto de usuário | — |
| `window.close()` do renderer não emite `close` | nenhum código do produto chama `window.close()`; o achado vale ao portar ou se algum dia a UI precisar fechar-se | plataforma/Electron |
| Migração entre modos do cofre | identidade criada no modo inseguro não abre se um keyring surgir depois (unwrap falha no boot, hoje bloqueado com erro nomeado). Decidir re-wrap assistido ou wipe orientado | §3.2/A13 |
| Nome real do backend no registro de aceite | inalterada desde §58.10 — com `composeKeystore` o campo ficou mais útil ainda quando houver cifra | IPC-M (§15.7) |
| Metade da validação fora do alcance do teste de contrato; correlação `blob.progress` ↔ `AttachmentDto`; inconsistência de cor na LEITURA | inalteradas desde §58.9 | ver §58.9 |
| Voz, tela e relay; U-17; barreira de PARES; residência `light`; empacotamento; sondas NAT/STUN | inalterados desde §58.6 | ver §58.6 |

**Instrumentação que fica.** Os logs de fronteira que fizeram o diagnóstico possível ficam no
código, curtos e prefixados: `[main]` para as decisões de entrega da porta e o evento close,
`[ponte]` para recebimento/attach/hello, `[nucleo]` para a porta anexada, e a causa nomeada
quando open/register falha. É a lição de §58.11 aplicada preventivamente: sintoma mudo é o
que transforma uma tarde de depuração em duas.

## 60. As escritas acordam: mensagem pela outbox real, e o onboarding de volta ao núcleo — 2026-08-24

**Gate de entrada:** nenhum gate específico para a fatia; G12 quick e G4 quick
rebuildados DEPOIS da mudança no núcleo (S1–S6 ok; matriz A2–A8 ok, veredito CONFIRMADO —
o gancho novo não toca a máquina de estados de §11.3, só a cadência da observação).

Estado ao fim da fatia: núcleo `§4 ok — 86 arquivo(s)`, **866 testes, 0 falha**; `frontend/`:
build, lint e **165 testes** (+21) verdes; `app/`: typecheck verde. Smoke real sob Xvfb+CDP,
primeiro uso limpo: gate do cofre inseguro → aceite → identidade criada **pelo núcleo**;
comunidade criada pelo núcleo; três mensagens atravessando `message.send` → outbox → log →
réplica → `message.accepted`, cada uma assentando em **uma** linha sem marca de falha;
`kill -9` no utility → epoch novo, sem bolha fantasma na rederivação da fila, mensagem
posterior atravessando com cópia única e a janela viva.

### 60.1 O que a fatia achou antes de implementar

O smoke desta fatia começou por acusar um defeito que não era dela — e esse defeito era o
achado principal. Com as telas restauradas do mock (§58, commit "Restaura a UI do mock"),
o **onboarding tinha voltado a ser simulado**: `OnboardingScreen` chamava
`identityStore.createIdentity` (par de chaves fingido, confirmação por `setTimeout`),
`CreateCommunityModal` chamava `createCommunity` da store, e **nenhuma tela** usava
`sessao.criarIdentidade`/`aceitarCofreInseguro`, que §58/§59 haviam deixado prontas e
órfãs. Resultado medido no primeiro smoke honesto: identidade "criada" só no localStorage,
núcleo eternamente em `awaiting-identity`, e todo `message.send` recusado na porta com
`E_NO_IDENTITY` ("Identidade necessária") — recusa correta do núcleo expondo que a primeira
escrita do produto nunca chegou a existir. A lição vale registro: **leituras vivas mascaram
telas ainda de fixture enquanto ninguém escreve**; foi o envio que trouxe isso à tona.

Do mesmo smoke saíram dois achados de plataforma:

- **Estado fantasma de identidade.** `identityStore` persistia em localStorage e era quem
  decidia a rota entre Onboarding e shell (`RootRoute`). Núcleo zerado + localStorage velho =
  shell renderizando comunidade, canal e roster que o núcleo não tinha — todas as queries
  falhando caladas nos `catch` dos sincronizadores. Correção nesta fatia: `identityStore`
  perde o `persist`; a fonte de "existe identidade" é `query.identity`/`core.status.phase`.
- **Reload não redeliveria a porta IPC-R.** Um `Page.reload` dirigido por CDP deixou o app
  preso em "Conectando": a marca única de entrega de §59.1 é consumida na primeira carga e o
  recarregamento fica sem porta. Nenhum fluxo do produto dispara reload hoje; registrado como
  nota de plataforma (vale para F5/Ctrl-R do usuário).

### 60.2 Entregas

| Entrega | Onde | Seção | Evidência |
|---|---|---|---|
| `send` otimista com transporte injetado; a store não conhece IPC-R | `store/messageStore.ts` (reescrita) | §11.1, §15.4 | 13 testes novos, cada comportamento verificado por mutação (M1–M5 derrubam os casos) |
| Canal de escrita real + desfechos casados por `clientRef` | `live/sincronizacao.ts` (`configurarEscritaDeMensagem`, assinaturas de `message.accepted/failed/dropped/outbox.changed`) | §11.6 passo 8, §15.5 | smoke: bolha some quando a linha real chega; `clientRef` conferido na linha da outbox (`b-…`) e no evento |
| Fila honesta ao reabrir: bolhas derivadas de `query.outbox` (F-16), substituindo o conjunto a cada sync | `live/adaptadores.ts` (`bolhaDaFila`, `estadoDeEntrega`) + store | §15.6, F-16 | smoke pós-respawn: zero bolha fantasma; 8 testes de adaptador |
| Fim da confirmação inventada: nada de `setTimeout(800)`, nada de fila durável no renderer | idem + remoção do `persist` da messageStore | §11.2, §11.3 | durabilidade medida no smoke de §59 (kill -9) continua valendo, agora sem segundo dono |
| Falha nomeada na linha: código de §20 visível junto de "Tentar novamente" | `features/channel/MessageRow.tsx` (`DeliveryStatus`) | §11.3, §20 | smoke: `(E_…)` renderizado; retry reenvia o MESMO envelope via `message.retry` |
| Anexo bloqueado com aviso honesto no lugar do botão | `features/channel/Composer.tsx` | §13.7 | botão desabilitado com título explicativo; caminho pick→stage→ticket fica de pendência |
| Onboarding religado: `identity.create` de verdade + gate L-2 na tela | `features/onboarding/OnboardingScreen.tsx`, `live/sessao.ts` | §15.4, §3.2/L-2 | smoke: `E_KEYSTORE_INSECURE` abre o gate com checkbox de risco; aceite → criação contra o núcleo |
| Criar comunidade pelo fio | `features/communities/CreateCommunityModal.tsx`, `sessao.criarComunidade` | §15.4 | smoke: `{communityId, defaultChannelId}` da resposta abre o canal; rail vem das queries |
| Identidade deixa de persistir no renderer | `store/identityStore.ts` | §15.6 | mata o fantasma: núcleo sem identidade ⇒ Onboarding, sempre |
| Reconciliação acompanha o lote projetado | `composition/boot.ts` (gancho `onProjected` → `outbox.reconcile`, host e membro) | §11.6/DS-31 | sem ela, a bolha duplicava por até `OUTBOX_RECONCILE_MS`; agora `accepted` sai no passo seguinte ao `messages.appended`; G4 quick CONFIRMADO |
| `OutboxItem.kind` é número no DTO (era tipado string) | `ipc/dto.ts` | §11.2 | mesma classe do defeito 4 de §59: a tabela manda |

### 60.3 Decisões e por que são estas

| Decisão | Justificativa |
|---|---|
| Transporte injetado na store (`configurarEscrita`), não import direto de `api` | preserva a fronteira declarada: só `live/` conhece IPC-R e stores ao mesmo tempo; testes unitários exercitam a máquina de estados com canal falso |
| `awaiting-confirmation` vira `sending` na UI | ACK sem observação não é entrega (§11.3); "sending" é o vizinho honesto e a opacidade de §6 já o desenha |
| Bolha aceita permanece visível (como `sent`) até a linha real chegar à base | evita piscar entre `message.accepted` e o pouso da reconsulta disparada por `messages.appended`; o compose esconde quando o `messageId` observado está presente |
| `dropped` tratado como falha visível com motivo, não como remoção silenciosa | §18 proíbe sumir calado; retry subsequente recusa com erro fresco, que é o comportamento correto para item já terminal |
| Gancho de reconciliação pós-lote no núcleo, nos dois braços (host e membro) | DS-31 exige `appended` antes de `accepted`; o gancho roda depois do fan-out do lote, no mesmo passo. Sem ele, o host local vivia até 30 s com a própria mensagem duplicada na tela. Não muda a máquina de estados nem reenvia nada — `reconcile` só observa e remove; G4 quick revalidado |
| Anexo fora do escopo, botão fora do ar | meio-caminho seria mentira: a bolha anunciar arquivo que não vai; o caminho §13.7 (diálogo nativo, ticket, cota, progresso) merece fatia própria |
| `authorId` sai do input de `send` | a autoridade é o par de chaves do núcleo; quem escrevia `hostPeerId` (HostExitGuard do mock) provava que o campo era mentira waiting to happen |
| Testes de mutação como rotina | M1–M5 (store) e a remoção do gancho (núcleo) derrubaram os casos correspondentes; sem isso, verde não prova nada |

### 60.4 O que mudou no normativo

Nada. Nenhuma tabela fechada ganhou campo ou tópico. O gancho de reconciliação é
implementação de §11.6/DS-31 dentro do que o próprio texto do projetor antecipa ("um passo
posterior" ao lote), e o mapeamento `awaiting-confirmation → sending` é decisão de
adaptador registrada acima, não divergência de fio.

### 60.5 O que continua pendente

| Pendência | O que falta | Quem fecha |
|---|---|---|
| ~~Escritas de §15.4 — começar por mensagem~~ | **fechada nesta fatia para `message.send/retry`.** Restam do domínio de mensagem: `edit/delete/pin/react/thread.create` seguem otimistas LOCAIS nas stores (o evento `message.updated` já reconcilia o conteúdo quando o log chega, mas a recusa síncrona do núcleo não desfaz o override local); wire direto com tratamento de recusa é a próxima fatia | próxima fatia |
| Threads, moderação, busca e preferências no sincronizador | inalterada | ver fronteira |
| JoinCommunityOverlay resolve convite por fixture | inalterada — `invite.resolve`/`invite.redeem` já têm superfície tipada | próxima fatia |
| Voz/tela/relay (13 comandos) | inalterada | depende de mídia na rede real |
| Divergências de aparência (hostStatus 9×3, tombstone, hiddenByBan, clockSkewed, createdAt/description sem fonte) | inalteradas | ver adaptadores |
| Anexos: pick nativo → `blob.stage` → `ticketId` no send; download/reveal/progresso | botão fora do ar com aviso; o caminho do núcleo existe e está testado no contrato | fatia §13 |
| `channel.delete`: contagem de descartes deve vir da resposta `{seq, droppedQueued}` | hoje o aviso usa a contagem local (`descartarCanal`) enquanto o delete segue mock-local | fatia de escritas de estrutura |
| Recarga da página não redeliveria a porta IPC-R (marca única de §59.1) | nenhum fluxo do produto recarrega; vale para F5 do usuário | plataforma/Electron |
| Migração entre modos do cofre; nome real do backend no aceite; validação além do teste de contrato; voz/U-17/PARES/light/empacotamento/NAT | inalteradas desde §58.9/§59.5 | ver §58.9/§59.5 |

**Instrumentação que fica.** Nenhuma além da já declarada em §59.5 — os logs de fronteira de
[main]/[ponte]/[núcleo] continuam no código, e foi o log `scope:'outbox' msg:'accepted'` do
próprio núcleo que separou "evento não emitido" de "evento não casado" durante o diagnóstico.

## 61. O domínio de mensagem inteiro escreve: editar, apagar, fixar, reagir, abrir thread — 2026-08-24

**Gate de entrada:** nenhum gate específico; suíte do núcleo integral verde após a emenda
de fold (abaixo). O smoke ao vivo desta fatia achou um **defeto real de núcleo** que
bloqueava threads de ponta a ponta (§61.3).

Estado ao fim da fatia: núcleo `§4 ok — 86 arquivo(s)`, **866 testes, 0 falha**;
`frontend/`: build, lint e **172 testes** (+7) verdes; `app/`: typecheck verde. Smoke sob
Xvfb+CDP provou ao vivo: edição com cópia única e marcador; fixação; reação com chip e
contagem vindas do fio; **recusa R-23 nomeada na tela** ("Não foi possível reagir à mensagem
(E_REACTION_LIMIT)") com rollback do chip; thread abrindo pelo id temporário e assentando no
real (raiz e resposta com `thread_id` gravado na view); resposta enviada pelo composer do
painel.

### 61.1 Entregas

| Entrega | Onde | Seção | Evidência |
|---|---|---|---|
| `message.edit/delete/pin/react` + `thread.create` pelo canal injetado | `store/messageStore.ts` (`CanalDeEscrita` estendido), `live/sincronizacao.ts` (resolve `communityId` por canal) | §15.4, §11.1 | smoke: cada ação aplicada e depois observada na réplica; contrato já prendia a forma |
| Rollback de recusa: `undoPorRef` restaura o estado exato anterior + toast nomeado | `store/messageStore.ts` (`marcarFalha`), `MessageRow`/toast | §11.3, §20 | smoke: `E_REACTION_LIMIT` na tela, chip recusado fora; unidade M-mutada derruba sem o gancho |
| Reações hidratadas por demanda | `hidratarReacoes`/`aplicarReacoesRemotas` + mescla no `compose`; `MessageActions` hidrata ao montar | §15.6.1 | a lista de §15.6 não carrega reações; base vazia é substituível pela de `query.message` |
| Thread com id temporário assentado pela projeção | `createThread` (prefixo `thr-temp-`), `assentarThreadReal`, painel mostra "Abrindo a thread…" enquanto temporária | §8.x R-24 | smoke: fase temporária vista; composer real assumiu; resposta dentro da thread com `thread_id` na view |
| Assinaturas das ações recebem a `Message` inteira | `MessageActions`, `ChannelInfoPanel`, `MessageRow` | — | adaptação de fonte: quem chama sempre teve a mensagem em mãos |

### 61.2 Decisões e por que são estas

| Decisão | Justificativa |
|---|---|
| Rollback EXATO do override anterior (ou remoção da chave), não "restaurar campos" | restaurar valores como override novo deixaria lixo silencioso; o estado anterior pode ser "não havia override" |
| Recusa de escrita sobre mensagem real vira TOAST nomeado, não `DeliveryStatus` | `failed` de entrega pertence à bolha de envio; editar/apagar/fixar/reagir são mutações pontuais — rollback + motivo nomeado é o honesto alcançável sem inventar tela |
| `communityId` resolvido no sincronizador (`comunidadeDoCanal`) | as telas não sabem o mapeamento canal→comunidade e não deveriam; a store segue sem conhecer IPC-R |
| Thread responde só depois de assentada ("Abrindo a thread…") | responder com `threadId` temporário seria op que o fold recusa (id desconhecido); a ordem por escopo de canal garante a validade APÓS a projeção |
| Reações otimistas prevalecem sobre a hidratação até o fim da sessão | concorrência de outros reatores não justifica piscar chips; a reconciliação fina fica para quando houver evento de reação granular |

### 61.3 Defeto de núcleo achado pelo smoke — `thread.create` nunca ancorava

O fold aplicava `thread.create` e gravava a tabela `threads`, mas **não emitia efeito
algum** para a coluna `thread_id` da MENSAGEM RAIZ — `mutMessage(...).threadId` mudava só o
DS. Resultado: `query.messages` devolvia `threadId` ausente para sempre (§15.6), nenhuma
réplica conseguia ancorar a thread pela raiz, e o painel deste produto ficava preso em
"Abrindo a thread…". Correções:

1. `l1/fold/apply.ts` — `threadCreate` emite também o patch `{thread_id}` sobre a raiz;
2. `composition/queries.ts` — `query.thread` EXCLUI a raiz das respostas (a raiz agora casa
   com o recorte por `thread_id`);
3. `l1/projector/apply.ts` — `reply_count` idem, via subconsulta de `root_message_id`.

Teste de regressão no limite que importa (`queries-leitura.test.ts`): a raiz carrega o
MESMO `threadId` na listagem e em `query.message`. Verificado por mutação: remover o patch
derruba a asserção. Répllicas antigas se curam por reprojeção (os efeitos são recomputados
do log; nada de migração).

### 61.4 O que continua pendente

| Pendência | O que falta | Quem fecha |
|---|---|---|
| ~~Escritas de §15.4 — domínio de mensagem~~ | **fechada nesta fatia**: os seis comandos A de §11.1 estão wired, com recusa nomeada e rollback | — |
| ~~Anexos (§13): pick nativo → stage → ticketId; download/reveal/progresso~~ | **fechada na §64**: fluxo inteiro provado ao vivo entre dois nós | — |
| Threads: leitura de `query.thread` para respostas de OUTRAS instalações e contadores ao vivo | **fechada na §63**: chip conta pelo fio, thread estrangeira abre, painel hidrata por `query.thread` | — |
| JoinCommunityOverlay resolve convite por fixture | **fechada na §62**: overlay na admissão real de §12, DTO transcrito da união, smoke multi-nó aprovado | — |
| Threads/moderação/busca/preferências no sincronizador | busca ainda indexa stores locais; moderação e preferências seguem mock-local | fatia de leituras |
| Voz/tela/relay; divergências de aparência; reload sem redelivery da porta; migração de cofre | inalteradas | ver §59.5/§60.5 |
| A observar no smoke manual da máquina real | chips de reação otimistas através de um respawn de epoch (não reproduzido limpo aqui; kills sucessivos poluíram o ambiente) | próxima validação |

## 62. O convite fica real: preview e resgate pela admissão de §12, com a rede ligada e dois nós ao vivo — 2026-08-24

**Gate de entrada:** nenhum gate específico; o caminho de admissão do núcleo já tinha
contrato testado (G3/`invites-*`), mas o smoke desta fatia achou que **o app nunca tinha
ligado a rede** (§62.3.1) — o produto até aqui era um nó só. Estado ao fim: núcleo
`§4 ok — 86 arquivo(s)`, **867 testes, 0 falha** (+1); `frontend/`: build, lint e **176
testes** (+4) verdes; `app/`: typecheck verde. Smoke sob Xvfb+CDP com DUAS instâncias
(userData separados por `HOME`) e DHT local: host criou identidade+comunidade+convite
REAL (16 chars Crockford, 4 grupos); convidado colou o código, viu o preview real (nome,
contagem, quem convidou), entrou; roster 2/2 nos dois lados; uma mensagem de cada nó
apareceu **cópia única** no outro; `view.db` dos dois nós forensicamente idênticos
(mesmos `seq` 8–9, mesmos autores).

### 62.1 Entregas

| Entrega | Onde | Seção | Evidência |
|---|---|---|---|
| DTO `InvitePreview` transcrito da união de §12.3 (seis desfechos) | `frontend/src/ipc/dto.ts` | §12.3, §12.5, U-03 | compilação contra o fio; os desfechos `unreachable`/`ended` ganharam tela própria |
| `JoinCommunityOverlay` na admissão real: colar código → preview → `entrarComunidade` | `features/invites/JoinCommunityOverlay.tsx`, `live/sessao.ts` (`entrarComunidade` → `invite.redeem`) | §12.3/§12.4, §15.4 | smoke: preview real em <1 s; entrada com fold sincronizado |
| Gramática e validade decididas SÓ pelo núcleo | o overlay não valida nada localmente; `E_MALFORMED` vira o cartão de convite inválido | §15.4 (gramática de `codeOrLink`) | smoke: recusas nomeadas na tela |
| Criar/revogar convite pelo núcleo (a tela mintava código local) | `features/settings/CommunitySettings.tsx` → `invite.create`/`invite.revoke` + `sincronizarConvites` | §15.4 Convites, U-02 (confirma-depois-desenha) | smoke: código real de 16 chars na lista; sem ele não havia smoke |
| **Rede de verdade no produto** (o app rodava em modo memória) | `app/src/utility/index.ts`: `HyperswarmBackend` (par da identidade, §14.3) + `startCommunityTransport` + `attachTransport`; draining para o transporte | §14.1, §16.1 | smoke: dois nós se acham, replicam e conversam |
| `Swarm.attachBackend` com repetição de papéis | `core/src/l0/swarm/index.ts` + teste | §14.1 (host anuncia, membro procura) | unidade: repetição preserva a assimetria; idempotente; mutação derruba |
| `identityProfile` no boot do app (perfil que faltava ao resgate e à gênese) | `app/src/utility/index.ts` (`manager.record` → `deps.identityProfile`) | §12.4 (displayName/avatarColor), §19.1 | smoke: `E_VALIDATION` antes, resgate depois |
| Primeira sincronização reconsulta a comunidade ativa | `live/sincronizacao.ts` (`community.replication` + `synced` → `abrirComunidade`) | §15.5 (evento é sinal para reconsultar) | smoke: roster pós-entrada populado (antes: vazio até evento novo) |
| `P2P_DHT_BOOTSTRAP` (env) para rede local de teste | `app/src/utility/index.ts` | — (afordância de shell, default continua a DHT pública) | smoke rodou sobre 4 nós locais `firewalled:false` |

### 62.2 Decisões e por que são estas

| Decisão | Justificativa |
|---|---|
| Nada de validação local de código no overlay | a gramática de §15.4 é do núcleo; duplicá-la aqui criaria duas verdades sobre o que é um convite |
| `unreachable` com texto obrigatório da U-03 e "Tentar novamente" | RT-01: convite válido com host offline NÃO é convite inválido — a confusão era o defeito que a delta fecha |
| Falha de resgate vira erro NOMEADO dentro do cartão `ok` (não volta ao passo 1) | o preview continuou válido; o que falhou foi a entrada — esconder o cartão mentiria sobre o que se sabe |
| Rede nasce SEM identidade e anexa quando ela existe (`attachBackend`) | §14.3: o par do swarm É o par da identidade; entrar na DHT com par descartável quebraria F-06 (`E_AUTHOR_MISMATCH`) no resgate |
| Firewall de conexão §14.3(4) fica para quando a moderação for real | a recusa de banido continua valendo canal a canal (`refresh` do transporte); a porta é camada extra, e sem banidos vivos é código sem exercício |
| Smoke com DHT local em vez da pública | a DHT pública anuncia/consulta mas não conecta dois pares atrás do MESMO NAT (hairpin); com testnet local os endereços trocados são loopback e a conexão é direta — mesma receita de `hyperdht/testnet` usada pelos testes do núcleo |
| `HOME` separado por nó no smoke | é o que resolve o `userData` (`~/.config/@comunidade/app`) sem tocar no produto; lock de instância única respeitado por nó |

### 62.3 Defeitos achados pelo smoke — todos fechados na fatia

1. **O app nunca teve rede.** `app/src/utility` instanciava `new Swarm()` SEM backend e
   `startCommunityTransport` nunca era chamado — o "P2P" do produto era modo memória, e
   `invite.resolve` pendia para sempre (`whenTransport` não resolve sem transporte; o
   renderer via `E_TIMEOUT` aos 30 s). Fechado com o wiring de §62.1 (linha 5).
2. **`identityProfile` nunca foi injetado.** Sem ele, `invite.redeem` recusa com
   `E_VALIDATION` (sem displayName) e a GÊNESE grava o fundador como **"Fundador"**
   (fallback de `community.ts` quando o perfil não vem) — era isso que o preview mostrava
   em "Convite de Fundador". Fechado; a comunidade do smoke carrega o nome do defeito no
   log (imutável, e é a evidência de que aconteceu).
3. **Roster vazio logo após entrar.** `abrirComunidade` corria contra a réplica ainda
   vazia e nenhum evento reconsultava depois do `synced`. Fechado com o gancho de
   `community.replication` (§62.1, linha 8).

### 62.4 O que continua pendente

| Pendência | O que falta | Quem fecha |
|---|---|---|
| Anexos (§13): pick nativo → stage → ticketId; download/reveal/progresso | botão fora do ar com aviso honesto | fatia §13 |
| Threads: leitura de `query.thread` para respostas de OUTRAS instalações e contadores ao vivo | o painel ancora e responde pela réplica local | fatia de leituras |
| Threads/moderação/busca/preferências no sincronizador | busca ainda indexa stores locais; moderação e preferências seguem mock-local | fatia de leituras |
| Firewall de conexão §14.3(4) no `HyperswarmBackend` do app | injeção das duas metades (`commonCommunityIds`/`bannedIn`) sobre o runtime | fatia de moderação real |
| Prazo de `invite.resolve` × teto do IPC-R | 4 rodadas de 8 s + RPC podem passar de 30 s; hoje o overlay mostra `E_TIMEOUT` nomeado com "Tentar novamente" (honesto, mas o desfecho certo seria `unreachable`) | decisão de spec/prazo |
| DHT pública em NAT hairpin | ambiente de desenvolvimento não conecta dois pares locais pela DHT pública; produto em máquinas distintas usa o default — **confirmado em rede real na §72** | nada a fazer no produto |
| Voz/tela/relay; divergências de aparência; reload sem redelivery da porta; migração de cofre | inalteradas | ver §59.5/§60.5 |
| A observar no smoke manual da máquina real | chips de reação otimistas através de um respawn de epoch (herdado da §61.4) | próxima validação |

## 63. Leituras restantes do domínio de mensagem: thread de outra instalação abre, conta ao vivo e hidrata por `query.thread` — 2026-08-24

**Gate de entrada:** nenhum gate específico. Estado ao fim: núcleo `§4 ok — 86
arquivo(s)`, **867 testes, 0 falha**; `frontend/`: build, lint e **180 testes** (+4)
verdes; `app/`: typecheck verde. Smoke multi-nó sob Xvfb+CDP (mesmo par de nós da §62,
DHT local): o host respondeu numa thread; o convidado viu o chip **"2 respostas"** nascer
sob a raiz replicada — thread que ELE não criou —, abriu o painel pelo chip, leu as
respostas do host e respondeu; o host viu a resposta chegar e o chip subir para **"3
respostas"** nos dois lados. `view.db` dos dois nós forensicamente idênticos (seq
8–13, `reply_count` 3). Bônus de §11.8 provado ao vivo: com o host reiniciado no meio do
smoke, a resposta do convidado ficou `queued` na outbox e **fluiu sozinha** (`accepted
seq:13`) quando o canal voltou.

### 63.1 Entregas

| Entrega | Onde | Seção | Evidência |
|---|---|---|---|
| Threads de OUTRAS instalações registradas a partir da página do canal | `live/adaptadores.ts` (`threadsDaPagina`), `live/sincronizacao.ts` | §15.6, R-24 | smoke: chip renderiza e painel abre para thread estrangeira; unidade 4 casos, mutação min→max e remoção do filtro derrubam |
| Raiz de thread = MENOR `seq` do grupo | `threadsDaPagina` | R-24 (resposta só em thread existente) | unidade: página invertida ainda acha a raiz |
| Contador do chip vem do FIO | `domain/types.ts` + `adaptadores.ts` (`threadReplyCount`), `MessageList.tsx` | §15.6.1 (`reply_count`) | smoke: "2"→"3 respostas" ao vivo nos dois nós, contando resposta de outra instalação |
| Painel hidrata por `query.thread` | `store/messageStore.ts` (`threadLeituras`/`hidratarThread`/`aplicarThreadRemota`), `CanalDeEscrita.observarThread`, `ThreadPanel.tsx` (mescla sem duplicar) | §15.6 (`query.thread`) | cobre respostas fora da janela de 50 do canal; a vista continua ao vivo por `messages.appended` |
| Efeitos do Sincronizador só com sessão pronta + mensagens no resync | `live/Sincronizador.tsx`, `live/sincronizacao.ts` (registrarResync) | §15.2 4d | smoke: histórico volta após boot com canal/canal ativos persistidos (antes: vazio para sempre) |

### 63.2 Defeto achado pelo smoke — a primeira consulta de mensagens perdia a corrida com a porta

O zustand persist restaura comunidade e canal ativos ANTES da porta IPC-R chegar; o efeito
de `sincronizarMensagens` disparava no mount, tomava `E_NO_PORT` e o `.catch(() => null)`
engolia — e como os deps do efeito não mudam de novo, **nenhuma reconsulta jamais
ocorreria**. Estrutura e roster sobreviviam porque o resync de §15.2 4d as reconsulta;
mensagens não estavam no resync. A corrida era latente desde a §59 e virou determinística
quando a §62 pôs o Hyperswarm no boot (o `hello` do núcleo ficou mais lento). Correções:
(a) os efeitos do Sincronizador só consultam com `estado === "pronto"`; (b) o resync
passa a reconsultar também a mensagem do canal ativo. Verificado ao vivo: histórico volta
em todo boot.

### 63.3 Avaliação das leituras restantes — o que a spec manda, antes de mexer

| Superfície | O que a spec manda | Estado do frontend | Plano (fatia própria) |
|---|---|---|---|
| Busca (§23.1, §15.6 `query.search`) | índice FTS do núcleo sobre `view.db`; mensagens/canais/membros; `partial` com motivo (`host-offline`, `catching-up`, `stalled`, `partial-interpretation`) | `SearchOverlay` indexa stores locais do mock | trocar a fonte por `api.search` + adaptador do `SearchResult` + estados de parcial; a busca de canais/membros pode continuar local (§23.1 as inclui na resposta) |
| Moderação (§18.1, §15.4 `mod.*`, §15.6 auditoria) | ops ⏱ (`mod.kick/ban/timeout/revokeBan`, `member.setRoles/setNickname`); leituras exigem `view_audit_log` sob `E_PERMISSION_DENIED` | `ModerationTab` escreve mock-local (`moderationStore`); `api.mod*` e `api.auditLog` já têm superfície | ações → `api.mod*` com recusa nomeada (hierarquia é do fold); abas de auditoria → `query.auditLog/bans/timeouts`; mesma régua da estrutura (§59) |
| Preferências (§15.4 "Preferências locais", §6.15) | escrita direta no LS, sem host e sem fila: `settings.setDevice/setVolume/setNotifications`, `channel.setMuted`, `category.setCollapsed` | telas de configurações mock-local; `nav.setActive` e `markRead` JÁ wired | `settingsStore`/`communityStore` (mute/recolher) → `api.*`; leitura única por `query.preferences` no boot |

Nada destas três telas foi mexido nesta fatia — a avaliação é a entrega; cada wiring
merece fatia própria com smoke correspondente.

### 63.4 O que continua pendente

| Pendência | O que falta | Quem fecha |
|---|---|---|
| Anexos (§13): pick nativo → stage → ticketId; download/reveal/progresso | botão fora do ar com aviso honesto | fatia §13 |
| Busca/moderação/preferências no sincronizador | avaliadas em §63.3, com plano; seguem mock-local | fatias próprias (uma por superfície) |
| Anexos (§13) | **fechada na §64** | — |
| Badge de não-lidas no chip de thread (§9, 2.2) | `query.thread.unread` + `thread.markRead` já têm superfície; falta o estado de UI no indicador | fatia de leituras (restante) |
| **Canal RPC do membro não reanexa após RESTART do host** | observado no smoke: guest ficou `reconnecting` (replicação voltou, o canal de §16.1 não); op da outbox `queued, attempts:0` por ~1h50m até um restart do guest — que fluiu na hora (`accepted seq:13`). Recuperação de §11.8/§16.1 a investigar no transporte (`composition/transport.ts`) | defeito de núcleo — fatia de transporte |
| Host de longa duração deixou de receber conexões (3h22 no smoke; voltou ao reiniciar) | uma observação só, ambiente com horas de ociosidade; pode ser rotação de §14.2 ou sessão de discovery velha | a observar na próxima validação |
| Firewall de conexão §14.3(4) no `HyperswarmBackend` do app | injeção das duas metades sobre o runtime | fatia de moderação real |
| Prazo de `invite.resolve` × teto do IPC-R (herdada da §62.4) | 4 rodadas de 8 s + RPC podem passar de 30 s; hoje o overlay mostra `E_TIMEOUT` nomeado com "Tentar novamente" | decisão de spec/prazo |
| Voz/tela/relay; divergências de aparência; reload sem redelivery da porta; migração de cofre | inalteradas | ver §59.5/§60.5 |
| A observar no smoke manual da máquina real | chips de reação otimistas através de um respawn de epoch (herdado da §61.4); ~~DHT pública entre máquinas distintas~~ — **fechada na §72** | próxima validação |

## 64. Anexos de ponta a ponta: pick nativo → stage → ticketId no envio; download com progresso do fio e reveal — 2026-08-24

**Gate de entrada:** nenhum gate específico; o caminho de blobs do núcleo tinha contrato
testado (§13 nas suítes). Estado ao fim: núcleo **867 testes, 0 falha** (+0; o defeito de
porta abaixo é de forma, não de regra); `frontend/`: build, lint e **185 testes** (+5)
verdes; `app/`: typecheck verde. Smoke multi-nó sob Xvfb+CDP: o host anexou `nota.txt`
(12 B) e `nota2.txt` (14 B) — pick resolvido pelo main (ticket de §13.3), stage no core de
blobs do autor, `message.send` levando **só o `ticketId`**; o convidado recebeu, hidratou
o anexo por `query.message`, baixou pelo §13.4 com o card mostrando o estado do fio e
terminou com **arquivo íntegro no disco dele** (`local_blob_cache.state = downloaded`,
12/12 e 14/14 bytes, hash verificado) e botões Abrir/Mostrar na
pasta funcionando (`shell.openPath` do main, allowlist de §13.6).

### 64.1 Entregas

| Entrega | Onde | Seção | Evidência |
|---|---|---|---|
| Botão de anexo ligado: pick → ticket → `blob.stage` → chip "em staging" no composer | `Composer.tsx` (`anexar`), `api.filePickForAttachment`/`blobStage` | §13.2, §13.3, §15.4 | smoke: chip com nome do arquivo; `E_CANCELLED` do diálogo não é erro |
| `message.send` com `attachment: {ticketId}` — e NADA mais | `store/messageStore.ts` (`SendMessageInput.attachment`, `anexoDaBolha`), `CanalDeEscrita.enviar`, `sincronizacao.ts` | §13.7 r. 1 | unidade: o argumento do fio não contém nome/hash/tamanho; mutação derruba |
| Bolha própria com anexo local (progresso 100 = seed real, §13.1) | `anexoDaBolha` | §13.1, B8 | unidade: id = blobIdHex, "Baixado · Disponibilizando" |
| Anexo hidratado por `query.message` | `messageStore` (`anexosRemotos`/`aplicarAnexoRemoto`), `MessageRow` (`anexosDaMensagem`), adaptador `anexo` | §15.6.1 | smoke: card no guest para mensagem recebida |
| Download real com progresso do fio | `downloadStore` reescrito (eventos `blob.progress/peerLost/completed/unavailable` + `attachment.corrupt`), `AttachmentCard` | §13.4, §15.5 | smoke: 12 B e 14 B baixados com hash verificado; arquivo no disco do guest com conteúdo intacto |
| Reveal pós-download | `AttachmentCard` (Abrir / Mostrar na pasta → `api.blobReveal`) | §13.6, §15.3 | smoke: clique sem erro; `archive` continua main-confirmed no handler |
| Gancho dev `P2P_PICK_FILE` no main (smoke/CI) | `app/src/main/index.ts` | §13.3 (a decisão segue sendo do main) | o diálogo nativo não é automatizável sem X tooling; o ticket nasce igual |

### 64.2 Decisões e por que são estas

| Decisão | Justificativa |
|---|---|
| `id` do anexo no domínio = `blobIdHex` (hash.slice(0,32)) | é a MESMA chave dos eventos `blob.*` no fio (emenda de 2026-08-22 de §15.5) — progresso/conclusão casam com o card sem tradução |
| Progresso do fio é 0..1; o card fala 0..100 | `blob.progress` e o DTO de §15.6.1 trazem fração (`Math.min(1, blocos/total)`); normalizar no adaptador, não em cada tela |
| Download dispara ao montar o card (§11, B8 passo 2), uma vez por anexo e sessão | a UX documentada manda o progresso avançar sozinho; o guard na store impede re-pedido a cada remontagem — cota/GC de §13.8 fica do lado do núcleo |
| Anexo da própria bolha nasce com progresso 100 | o autor tem o arquivo no staging DELE (§13.1): "Baixado · Disponibilizando para outros" é a verdade, não otimismo |
| Card sem `origem` (fixtures) fica em "Indisponível" | sem caminho no fio não há download a pedir; inventar origem seria mentir |

### 64.3 Defeitos achados pelo smoke — fechados na fatia

1. **A porta `pickFile` do núcleo era síncrona; o diálogo do main é async por natureza**
   (§15.7). O app injetava uma função async, `escolhido.path` era `undefined` e o pick
   morria em `ERR_INVALID_ARG_TYPE` — o tipo fraco do `BootDeps` (deps chegam como
   `Record<string, unknown>` na utility) escondeu isso do TypeScript até o smoke.
   Correção: `blobAttachmentPort` aceita e `await`a as duas formas (`ports.ts`, `boot.ts`).
2. **Seletor do DevBar criava função nova a cada render** — snapshot do
   `useSyncExternalStore` mudava sem mudança de estado e o React caía em #185
   (maximum update depth) no build de produção. Correção: função estável fora do
   seletor, lendo `getState()` no clique.

### 64.4 O que continua pendente

| Pendência | O que falta | Quem fecha |
|---|---|---|
| Busca/moderação/preferências no sincronizador | avaliadas em §63.3, com plano; seguem mock-local | fatias próprias (uma por superfície) |
| Badge de não-lidas no chip de thread (§9, 2.2) | superfície existe; falta estado de UI | fatia de leituras (restante) |
| **Canal RPC do membro não reanexa após RESTART do host** (herdada da §63.4) | evidência no log do smoke; op `queued` até restart do guest | defeito de núcleo — fatia de transporte |
| Host de longa duração deixou de receber conexões (herdada da §63.4) | a observar | próxima validação |
| Firewall de conexão §14.3(4) no `HyperswarmBackend` do app | injeção das duas metades | fatia de moderação real |
| Prazo de `invite.resolve` × teto do IPC-R | overlay hoje mostra `E_TIMEOUT` nomeado com "Tentar novamente" | decisão de spec/prazo |
| Cancelamento de download na UI (`blob.cancel` tem superfície; o card não expõe) | botão/gesto de abortar | refinamento de anexos |
| Voz/tela/relay; divergências de aparência; reload sem redelivery da porta; migração de cofre | inalteradas | ver §59.5/§60.5 |

## 65. O canal de §16.1 reanexa: host que morre e volta não deixa mais o membro preso em `reconnecting` — 2026-08-25

**Gate de entrada:** nenhum gate específico; o caminho de reconexão era coberto só pelo
caminho feliz (§45). Estado ao fim: núcleo `§4 ok — 86 arquivo(s)`, **870 testes, 0
falha** (+3, rede real); `frontend/`: build, lint e **185 testes** verdes; `app/`:
typecheck verde. Smoke multi-nó sob Xvfb+CDP com DHT local: host criou identidade,
comunidade e convite REAL; convidado entrou por preview e enviou a baseline (vista no
host); o processo do HOST inteiro morreu sob SIGKILL — o guest, **intocado**, mostrou
`Reconectando…`, aceitou mensagem nova para a outbox sem erro e, com o host relançado do
mesmo disco e da mesma identidade, o banner sumiu e a op enfileirada apareceu no host
novo. O log do guest registra a máquina inteira: `reconnecting` → **`connecting`** →
`online` → `accepted seq:9`, no mesmo segundo do anexo.

### 65.1 O defeito, com a evidência do smoke de §63.4/§64.4

O guest ficou ~1h50m com a op `queued, attempts:0` depois de o host voltar; a replicação
tinha retomado sozinha (`catching-up` 7 s após a queda — logo o transporte reavaliou a
conexão nova), mas nada desbloqueava. Três defeitos encadeados:

| # | Defeto | Onde | Por que travava |
|---|---|---|---|
| 1 | `channelAttached` ignorava anexo vindo de `reconnecting` | `hostStatus.ts` | anexo só transicionava `unknown\|offline → connecting`; de `reconnecting`, nem hello (que espera `connecting\|online`) nem o loop de outbox nem presença disparavam — e contato nenhum era observado. Deadlock de estados: quem devia desbloquear dependia do estado que ele próprio destravar |
| 2 | Aceitador `p2p-community/1` global por par, registrado num mux morto | `transport.ts` | `aceitando` guardava o desregistro do mux VELHO; na conexão nova o `has(chave) → continue` impedia registrar o par no mux vivo — o protomux recusava todo open daquele membro até o HOST reiniciar |
| 3 | Entrada velha em `canais` cuja queda não foi notificada | `transport.ts` | `daComunidade.has(peer) → continue` bloqueava a reabertura para sempre se um `onDown` se perdesse |

A mutação confirma o recorte: revertendo só (1), o teste de rede falha com
`status=reconnecting, canais=1` — canal aberto, portão travado, exatamente o smoke;
revertendo só (2), o teste do membro que volta falha com `canais=0`.

### 65.2 Entregas

| Entrega | Onde | Seção | Evidência |
|---|---|---|---|
| Anexo pós-queda volta a `connecting`; queda vinda de `connecting` COM contato anterior é `reconnecting`, não `offline` | `composition/hostStatus.ts` (`channelAttached`/`channelDown`) | §15.6 (DR-29/DR-33), §16.1 | unidade 2 casos novos; smoke: banner some sem tocar no guest |
| `host.cameBack` ancorado em "houve perda" (`attempts > 0`), não no estado anterior | `hostStatus.ts` (`markSeen`) | §11.8, §22.1 | reconcile imediato + flush taxado também quando a recuperação passa por `connecting`; sem isso op `awaiting-confirmation` esperaria 30 s |
| Ciclo de vida do aceitador POR CONEXÃO: entrada carrega o stream; stream morto purga; resquício de outro stream é retirado e o par renasce no mux vivo | `composition/transport.ts` (`aceitando`, handler de `close`, `stop`) | §16.1 | teste de rede: membro reinicia contra host de pé, canal reabre dos dois lados |
| Defesa contra canal velho caído: `ProtomuxTransport.down` expõe o cabo; entrada cujo transporte já caiu é fechada e reaberta na hora | `l3/rpcServer/protomux.ts`, `transport.ts` (`avaliar`) | §16.1 | torna a reabertura independente de ordem de eventos |
| Regressão em REDE REAL (hyperdht/testnet): host morre e volta × membro morre e volta, mesmos peerKey/disco, fila anda nos dois sentidos; forasteiro continua fora | `test/transport-reconexao.test.ts` | §14.3(1), §16.1, §11.8 | 3 testes; cada conserto verificado por mutação (revertido → vermelho) |

### 65.3 Decisões e por que são estas

| Decisão | Justificativa |
|---|---|
| `channelAttached` transiciona de qualquer dinâmico não-online para `connecting` | "anexo" É o predicado de `connecting` em §15.6; negá-lo a `reconnecting` criava o deadlock. O contato observado continua sendo quem diz `online` |
| `cameBack` por `attempts > 0` e não por estado anterior | `attempts` conta quedas observadas; é a definição de "houve perda" e sobrevive à rota nova por `connecting`. Do boot (`unknown→connecting→online`) segue sem cameBack, como antes |
| Aceitador carrega o stream e é purgado no `close` dele | o par `(protocolo, id)` vive num mux; mux morto não pode continuar respondendo pelo par. A checagem em `avaliar` cobre a janela entre morte e purga |
| `down` como getter no tipo de L3 em vez de evento extra | quem guarda canais precisa perguntar o estado ao reavaliar; confiar só em notificação deixou a janela aberta (defeto 3) |
| Teste de rede fecha o nó INTEIRO (processo, bancos, transporte) e reabre o MESMO diretório | é o caso de produto (app reiniciado); simular queda só de socket esconderia os resquícios de estado que eram o defeito |
| Portão de outbox replicado no teste de rede (gira só com `connecting\|online`) | o portão é parte do contrato de §22.1/§11.8; flush manual bypassaria exatamente o que travou no smoke |

### 65.4 O que continua pendente

| Pendência | O que falta | Quem fecha |
|---|---|---|
| Host de longa duração deixou de receber conexões (3h22 no smoke de §63; voltou ao reiniciar) | uma observação só, ambiente com horas de ociosidade; pode ser rotação de §14.2 ou sessão de discovery velha | a observar na próxima validação (o smoke desta fatia não reproduziu: host novo recebeu na hora) |
| Busca/moderação/preferências no sincronizador | avaliadas em §63.3, com plano; seguem mock-local | fatias próprias (uma por superfície) |
| Firewall de conexão §14.3(4) no `HyperswarmBackend` do app | injeção das duas metades sobre o runtime | fatia de moderação real |
| Badge de não-lidas no chip de thread | superfície existe; falta estado de UI | fatia de leituras (restante) |
| Prazo de `invite.resolve` × teto do IPC-R | overlay mostra `E_TIMEOUT` nomeado com "Tentar novamente" | decisão de spec/prazo |
| Cancelamento de download na UI | `blob.cancel` tem superfície; o card não expõe | refinamento de anexos |
| Voz/tela/relay; divergências de aparência; reload sem redelivery da porta; migração de cofre | inalteradas | ver §59.5/§60.5 |

## 66. Moderação real: as ops de §15.4 saem do mock, as leituras de auditoria vêm do núcleo — e o smoke achou o vazamento de §18.1 — 2026-08-25

**Gate de entrada:** nenhum gate específico; as superfícies `mod.*`/`query.auditLog` já
tinham contrato testado (§52). Estado ao fim: núcleo **871 testes, 0 falha** (+1, rede
real); `frontend/`: build, lint e **189 testes** (+4) verdes; `app/`: typecheck verde.
Smoke multi-nó sob Xvfb+CDP: o host baniu o convidado PELO CAMINHO DE UI REAL (avatar da
mensagem → popover → Banir → confirmação nativa), o toast confirmou a op ⏱ aceita, a
mensagem pré-ban do convidado SUMIU do canal dele (§18.2), a aba Moderação mostrou
"Banidos (1)" e "Host Sessenta e Cinco baniu Convidada Sessenta e Cinco" vindos de
`query.bans`/`query.auditLog` — e o primeiro smoke provou que a mensagem PÓS-ban ainda
chegava ao banido. Defeto fechado na hora (§66.3); repetido o smoke com o conserto:
**OK-NAO-CHEGOU**, e o log do banido registra `connecting → reconnecting` sem nunca
voltar a `online`.

### 66.1 Entregas

| Entrega | Onde | Seção | Evidência |
|---|---|---|---|
| `mod.kick/ban/timeout` no diálogo de confirmação — recusa nomeada por código de §8.7 (`E_HIERARCHY`, `E_FOUNDER_IMMUNE`, `E_HOST_IMMUNE`, `E_SELF_TARGET`, …) | `features/moderation/ModerationDialog.tsx` | §15.4, §8.7 | unidade via contrato existente; smoke: toast só depois do RPC ok |
| `mod.revokeBan`/`mod.removeTimeout` nos botões das abas; reconsulta de membros + moderação após cada ação | `features/settings/ModerationTab.tsx` | §15.4 | unidade; smoke: revogação pelo mesmo caminho |
| As três leituras de §15.6 no Sincronizador: `query.auditLog/bans/timeouts` → espelho da store; `E_PERMISSION_DENIED` nas três é ESTADO (`semPermissao`), não silêncio | `live/sincronizacao.ts` (`sincronizarModeracao`), `store/moderationStore.ts` reescrita | §15.6 (DR-25/T-44) | unidade 4 casos; aba diz o que falta quando falta permissão |
| Assinatura de `auditLog.changed` + entrada no resync de §15.2 4d | `live/sincronizacao.ts` | §15.5 | o log de auditoria da comunidade ativa vive sozinho |
| Log local das telas removido — o fold audita TUDO (cargos, canais, categorias, convites), duplicar seria mentir duas vezes sobre o mesmo fato | `ChannelDialogs.tsx`, `RolesTab.tsx` (remoção de `.log()`) | §6.13 | unidade de contrato; a auditoria vem de uma fonte só |
| União `ModerationActionType` estendida aos 20 tipos de §6.13 (+ rótulo congelado do autor) | `domain/types.ts`, `adaptadores.ts` | §6.13, §10 3.4 | tipo desconhecido de host mais novo não derruba a tela |
| Firewall de conexão §14.3(4) no produto: as duas metades lidas do runtime na hora da conexão | `app/src/utility/index.ts` | §14.3(4) | smoke pós-ban: reconexão do banido recusada na porta |

### 66.2 O vazamento que o smoke achou (e como foi fechado)

O §18.1 manda para o `mod.ban`: **"Canais de replicação fechados; conexões derrubadas"**.
O transporte fechava só o canal RPC (`fecharCanal`) — e o hypercore continuava
replicando bloco novo pela mesma conexão: a mensagem pós-ban chegou ao banido. Correção:
`refresh()` agora coleta os pares cortados por autorização e derruba a CONEXÃO inteira
quando eles não têm NENHUMA outra comunidade em comum autorizada — a mesma régua do
firewall de §14.3(4). Teste novo em rede real (`transport-reconexao.test.ts`): canal
fecha, `connectionCount` vai a zero dos DOIS lados, e bloco appendado após o corte não
aumenta o core do banido. Verificado por mutação: remover a derrubada → vermelho em
"a conexão do banido não caiu".

### 66.3 Decisões

| Decisão | Justificativa |
|---|---|
| Recusa de moderação é frase por código, dentro do diálogo | a hierarquia é decisão do fold (§8.7); a tela traduz, nunca decide. Reaproveitar o cartão do diálogo evita inventar tela nova |
| Falha parcial nas três leituras preserva o espelho e NÃO marca sem permissão | `semPermissao` só quando TODAS negarem — permissão é uma só (§9.1); erro de rede não pode ser lido como falta de cargo |
| Timeouts expirados ficam fora da lista vigente | `expired` é calculado contra o último `hostTs` interpretado; expirado é história |
| Derrubar a conexão só sem comum autorizada restante | simetria com §14.3(4): banido em A e membro de B continua conectado para B |
| Smoke usa o caminho de UI real (popover → diálogo) | é o caminho que a usuária usa; exercita permissões, token e porta de uma vez |

### 66.4 Pendências

| Pendência | O que falta | Quem fecha |
|---|---|---|
| §18.4 lado do alvo: observar o próprio ban/kick e entrar em modo removed (parar rpcClient, sair do swarm, `removed_reason`, cabeçalho histórico U-16) | o banido hoje fica em `reconnecting` honesto mas sem a tela de modo histórico | fatia própria §18.4 |
| Busca/preferências no sincronizador | avaliadas em §63.3 | fatias próprias |
| Badge de não-lidas no chip de thread | superfície existe | fatia de leituras (restante) |
| Prazo de `invite.resolve` × teto do IPC-R | overlay mostra `E_TIMEOUT` nomeado | decisão de spec/prazo |
| Host de longa duração sem conexões (§63.4) | a observar em máquina real | próxima validação |

## 67. Busca real: o overlay fala com o FTS do núcleo, e `partial` vem nomeado do fio — 2026-08-25

**Gate de entrada:** nenhum gate específico; o `search` do núcleo tinha contrato testado
(§28/§50). Estado ao fim: núcleo inalterado (871); `frontend/`: build, lint e **193
testes** (+4) verdes. Smoke multi-nó sob Xvfb+CDP: o host buscou "baseline" — conteúdo
AUTORADO pelo convidado e replicado — e achou pelo caminho de UI real (lupa → overlay →
resultados com autor e canal); buscou "segredo" (próprio, pós-ban) e achou; o BANIDO,
reaberto depois do corte, buscou "baseline" na réplica DELE e achou — §18.3/L-7 provado:
ban impede leitura futura, não apaga o que já veio.

### 67.1 Entregas

| Entrega | Onde | Seção | Evidência |
|---|---|---|---|
| Painel busca via `api.search` no lugar do motor client-side; debounce mantido; resposta velha descartada por token | `features/search/SearchPanel.tsx` | §23.1 | smoke: dois termos, resultados do fio |
| Adaptador `resultadoDeBusca`: hit do FTS → resultado de tela (canal/autor/trecho no hit; timestamp do AUTOR, não do lote) | `live/adaptadores.ts`, `domain/types.ts` (`BuscaResults`) | §23.1, §23.2 | unidade 4 casos; mutação authorTs→hostTs derruba |
| Banner de parcial dirigido pelo fio: as quatro causas de §23.1 nomeadas na tela | `SearchPanel.tsx` (`MOTIVO_PARCIAL`) | §23.1/RT-11 | o banner antigo olhava status local; agora é uma fonte só |
| DTO `SearchResult` corrigido contra o fio real (`MessageHit`/`MemberHit`, não `MessageDto`/`UserRef`) | `ipc/dto.ts` | §15.6 | a divergência sobreviveu porque o contrato de §58 prova só o ARGUMENTO |
| Motor client-side removido; ficam filtros e destaque | `features/search/searchIndex.ts` | — | código morto fora do produto |

### 67.2 Pendências

| Pendência | O que falta | Quem fecha |
|---|---|---|
| "Ver todos" expandir até 100 (`limitPerGroup` hoje fixo no default do painel) | paginação da expansão | refinamento de busca |
| Preferências no sincronizador | avaliada em §63.3 | fatia própria |
| Badge de não-lidas no chip de thread; cancelamento de download; prazo de `invite.resolve` | herdados de §64.4 | fatias próprias |

## 68. Preferências locais: mute, recolher, dispositivos e notificações falam com o núcleo — e o smoke prova o ciclo inteiro — 2026-08-25

**Gate de entrada:** nenhum gate específico; as superfícies de §15.4 "Preferências
locais" já tinham contrato testado. Estado ao fim: núcleo inalterado (871); `frontend/`:
build, lint e **200 testes** (+7) verdes; `app/`: typecheck verde. Smoke sob Xvfb+CDP:
silenciar `#geral` pelo menu de contexto gravou a linha em `local_channel_pref`
(`muted=1`) do `manifest.db`; recolher a categoria GERAL gravou
`collapsed_categories`; REINICIAR o app reabriu a categoria RECOLHIDA (hidratada pela
`query.structure`) e o menu do canal passou a mostrar "Reativar notificações" — o ciclo
escrita → persistência no núcleo → hidratação provado ponta a ponta.

### 68.1 Entregas

| Entrega | Onde | Seção | Evidência |
|---|---|---|---|
| Porta de escrita injetada nas stores (`configurarEscrita`/`configurarPreferencias`) — a store não conhece IPC-R; quem injeta é o sincronizador | `store/settingsStore.ts`, `store/communityStore.ts`, `live/sincronizacao.ts` | §15.4 | unidade 7 casos; mutação (remover a chamada da porta) derruba |
| `toggleChannelMuted`/`toggleCategoryCollapsed` replicam para `channel.setMuted`/`category.setCollapsed`; falha da porta não desfaz o estado local | idem | §15.4 "sem host, sem fila" | unidade; LS é a primeira fonte, núcleo reconcilia no boot |
| `setDevice`/`setVolume`/notificações replicam para `settings.*`; slider não enfileira retentativa | `settingsStore.ts` | §15.4 | unidade |
| Hidratação única no boot: `query.preferences` → dispositivos/volumes/notificações; mute/recolher já vêm na `query.structure` | `sincronizarPreferencias()` | §15.6 | smoke pós-restart |

### 68.2 Decisões

| Decisão | Justificativa |
|---|---|
| Injeção de porta em vez de import direto da api na store | o padrão de §58 (`configurarEscrita` do messageStore): store pura, sincronizador compõe |
| Falha da escrita no núcleo é engolida (com `.catch`) | a decisão local já vale nesta sessão; erro de transporte não desfaz preferência de leitura — e `query.preferences` reconcilia no boot seguinte |
| Mute/recolher NÃO passam por `query.preferences` na hidratação | já atravessam `query.structure` como estado local do canal/categoria (§15.6); segunda fonte seria dois donos para o mesmo fato |
| Notificação por comunidade substitui o Record inteiro ao hidratar | o fio traz a lista completa; mesclar com estado local velho inventaria nível que o núcleo já não tem |

### 68.3 Pendências

| Pendência | O que falta | Quem fecha |
|---|---|---|
| Badge de não-lidas no chip de thread (§9, 2.2) | **LACUNA DE SPEC registrada**: `query.thread.unread` NÃO existe nem na tabela de §15.6 nem no roteador — só `query.thread` (unread de UMA thread, DR-48) e `thread.markRead`. Decorar o chip sem consultar thread a thread exige uma superfície de listagem com contadores, que a spec não declara. Não inventar: emendar §15.6 primeiro | decisão de spec + fatia própria |
| Cancelamento de download na UI | `blob.cancel` tem superfície (§15.4) e o card não expõe gesto de abortar — wiring direto, sem lacuna | refinamento de anexos |
| Prazo de `invite.resolve` × teto do IPC-R | overlay mostra `E_TIMEOUT` nomeado com "Tentar novamente" | decisão de spec/prazo |
| Host de longa duração deixou de receber conexões (§63.4) | a observar em máquina real | próxima validação |
| §18.4 lado do alvo (modo removed/histórico) | ver §66.4 | fatia própria |

## 69. O badge de não-lidas da thread: a superfície que a delta declarava e o código não tinha — 2026-08-25

**Gate de entrada:** nenhum gate específico. A delta-UX §2.2(7) declarava a feature
**"Implementada — `local_thread_read_state` + `query.thread.unread`"**, mas a superfície
nunca havia aterrissado nem na tabela de §15.6 nem no roteador (a divergência sobreviveu
porque nenhum teste olhava a existência do comando). Esta fatia faz o código alcançar a
resolução documentada. Estado ao fim: núcleo **872 testes, 0 falha** (+1); `frontend/`:
build, lint e **205 testes** (+5) verdes; `app/`: typecheck verde. Smoke multi-nó sob
Xvfb+CDP: o host respondeu DUAS vezes numa thread enraizada na mensagem do convidado; o
convidado, sem ter aberto a thread, viu o chip "2 respostas" com o badge "1"; ao abrir o
painel, `thread.markRead` disparou e o badge saiu — o chip permaneceu.

### 69.1 Entregas

| Entrega | Onde | Seção | Evidência |
|---|---|---|---|
| `query.thread.unread {communityId, channelId?, cursor?, limit=25}` — threads com contador > 0, raiz mais recente primeiro; junção view↔manifest EM MEMÓRIA (bancos distintos) | `composition/queries.ts`, roteador (`commands.ts`) + linha nova na tabela de §15.6 | §15.6 emenda de 2026-08-25; delta-UX §2.2(7) | unidade de núcleo: resposta alheia conta, própria não; leitura zera e tira da listagem |
| Mapa `naoLidasPorThread` na store, substituído INTEIRO a cada reconsulta (ausência = lida, nunca zero inventado) | `store/messageStore.ts`, `live/sincronizacao.ts` (`sincronizarThreadsNaoLidas`) | §9, 2.2 | unidade 3 casos; mutação (remover marcação de leitura) derruba |
| Badges nos MESMOS gatilhos da página de mensagens: carregar canal, `messages.appended`, resync | `sincronizarMensagens` → `sincronizarThreadsNaoLidas` | §15.5 | smoke: badge nasceu com a resposta replicada |
| Abrir o painel É ler: `hidratarThread` dispara `thread.markRead` pelo canal de escrita e reconsulta | `messageStore.ts` (`CanalDeEscrita.marcarThreadLida`) | §6.15, DR-48 | smoke: badge some ao abrir, chip fica |
| Badge visual no chip da raiz (contagem + sr-only) | `MessageRow.tsx`, `MessageList.tsx` | §9, 2.2 | smoke |

### 69.2 Decisões

| Decisão | Justificativa |
|---|---|
| A emenda segue o NOME que a delta já publicou (`query.thread.unread`) | resolver divergência documento×código não é inventar comportamento: a resolução de §2.2(7) é anterior; faltava o código |
| Só itens com `unreadCount > 0` na resposta | a lista alimenta um badge; zeros são ruído e "lida" é AUSÊNCIA no mapa |
| Junção em memória em vez de ATTACH entre bancos | LS e CS são bancos distintos por norma (§10.3); o conjunto por canal é pequeno e a consulta é por canal ativo |
| Marca de leitura na ABERTURA do painel (não no scroll) | §6.15 manda watermark na cabeça; a abertura é o evento de leitura que a UI tem hoje — refinamento de scroll fica para depois |

### 69.3 Pendências

| Pendência | O que falta | Quem fecha |
|---|---|---|
| Cancelamento de download na UI | `blob.cancel` tem superfície; o card não expõe | refinamento de anexos |
| Prazo de `invite.resolve` × teto do IPC-R | overlay mostra `E_TIMEOUT` nomeado | decisão de spec/prazo |
| Host de longa duração deixou de receber conexões (§63.4) | a observar em máquina real | próxima validação |
| §18.4 lado do alvo (modo removed/histórico) | ver §66.4 | fatia própria |

## 70. Cancelamento de download no card de anexo — 2026-08-25

**Gate de entrada:** nenhum. `blob.cancel` já tinha superfície de §15.4 e card sem
gesto nenhum (§64.4). Estado ao fim: núcleo inalterado; `frontend/`: build, lint e
**208 testes** (+3) verdes.

### 70.1 Entregas

| Entrega | Onde | Seção | Evidência |
|---|---|---|---|
| Botão "Cancelar" na barra de progresso; estado "Download cancelado" com "Baixar novamente" | `features/channel/AttachmentCard.tsx` | §13.4 | unidade 3 casos |
| `downloadStore.cancelar`: avisa o núcleo com a origem, marca o cartão, limpa progresso/peers e LIBERA o pedido da sessão | `store/downloadStore.ts` | §13.4 | unidade; mutação (remover `pedidos.delete`) derruba o re-download |
| Completo não se cancela; anexo sem origem não tem a quem pedir | idem | §13.4 | unidade |

## 71. Empacotamento: electron-builder configurado, AppImage gerado e o caminho do .exe no CI — 2026-08-25

**Gate de entrada:** G0/G10 provaram os nativos nos dois alvos no harness; o PRODUTO
nunca tinha sido empacotado — o script `pack` referenciava um `electron-builder.json`
inexistente. Estado ao fim: **AppImage do produto gerado e presente em
`app/release/`**; o `.exe` de Windows exige runner Windows (nativos não compilam
para win32 a partir daqui — sem wine/mingw) e nasce pelo workflow adicionado.
Suítes: núcleo 872, frontend 208, app typecheck — verdes.

### 71.1 Entregas

| Entrega | Onde | Nota |
|---|---|---|
| Config de empacotamento dos dois alvos do v1 (NSIS + portable x64; AppImage x64), deep link `comunidadep2p://` registrado, asar com desempacote dos nativos (`better-sqlite3`, `sodium-native`, `fs-native-extensions`) | `app/electron-builder.json` | `npmRebuild` ficou ligado aqui e **foi revertido na §72**: POC-03 §3.2 já tinha fixado `false` |
| Montagem dos recursos que viajam DENTRO do pacote: renderer (`frontend/dist` → `dist/renderer`) e core (`core/dist` → `dist/core`) | `app/scripts/montar.mjs`, scripts `dist*` | o main já esperava `../renderer/index.html`; o utility ganhou o candidato empacotado `../core` |
| Dependências de runtime do núcleo espelhadas no app (`b4a`, `compact-encoding`, `fs-native-extensions`, `hyperswarm`, `protomux`) | `app/package.json` | resolução de módulos do `dist/core` cai no `node_modules` do app; versões idênticas às do core |
| Workflow de empacotamento nos dois alvos, com artefato como saída (`--publish never`) | `.github/workflows/build.yml` | matrix windows-latest/ubuntu-latest; a reconstrução no runner **caiu na §72** — os addons já chegam prontos em `prebuilds/` |
| Artefato gerado localmente | `app/release/Comunidade P2P-0.0.0-linux-x86_64.AppImage` | 212 MB. O pacote desta fatia **não bootava o núcleo** — defeito achado e consertado na §72 |

### 71.2 Como obter o `.exe`

1. Envie a branch e abra o workflow **build** (aba Actions → *Run workflow*).
2. O job `windows-latest` gera dois artefatos: instalador NSIS
   (`Comunidade P2P-<versão>-windows-x64.exe`) e portable, publicados como
   *artifact* da execução (`pacote-windows-latest`).
3. Alternativa sem CI: numa máquina Windows com Node 22 + ferramentas de build
   (VS Build Tools), rodar `frontend→build`, `core→build`, `app→npm ci && npm run dist:win`.

### 71.3 Checklist de validação Windows (quando o instalador existir)

| Item | O que observar |
|---|---|
| Cofre | No Windows o SafeStorage usa DPAPI: o gate "cofre inseguro" do Linux NÃO deve aparecer; identidade nasce sem aceite explícito (A13) |
| Dados | `%APPDATA%/Comunidade P2P` (userData), não `~/.config` |
| Deep link | `comunidadep2p://join/...` registrado pelo instalador NSIS |
| ~~Rede~~ | ~~DHT pública entre DUAS máquinas reais (a nota manual das §§63–64)~~ — **fechada na §72** |
| Instalador | SmartScreen vai alertar por falta de assinatura de código — esperado no v1 |

## 72. O produto roda em rede real: duas máquinas, duas operadoras — e os dois defeitos que separavam o pacote do executável — 2026-08-25

**Gate de entrada:** §71 gerou o AppImage e desenhou o caminho do `.exe`, mas o pacote
nunca tinha sido **executado**. **Resultado:** validação manual entre **duas máquinas em
conexões de internet diferentes**, pela DHT pública, com mensagem, anexo e reação
funcionando ponta a ponta. Isso fecha a última linha de §71.3 e a nota herdada das
§§62.4/63.4.

### 72.1 Os dois defeitos entre "empacota" e "roda"

| Defeito | Sintoma | Causa | Correção |
|---|---|---|---|
| `npm ci` do core quebra no runner Windows | `gyp ERR! find VS` — `unknown version "undefined" found at "…\Microsoft Visual Studio\18\Enterprise"` | `windows-latest` passou a trazer o **VS 18**, que o `node-gyp` 11.5.0 não identifica. E a compilação nem devia acontecer: `better-sqlite3` 13.0.3 publica `prebuilds/win32-x64.node` no tarball e resolve por `node-gyp-build` — quem dispara o `node-gyp` é a regra implícita do npm (pacote com `binding.gyp` e sem script `install`) | `npm ci --ignore-scripts` no core e no app |
| Núcleo recusa iniciar no pacote | diálogo `Núcleo bloqueado — E_BOOT: Cannot use import statement outside a module` | o `montar` copia `core/dist` → `app/dist/core` sem o marcador de tipo. Fora do lugar de origem, o Node decide o tipo pelo `package.json` mais próximo subindo a árvore — e de `dist/core/**` o primeiro é o do app, que diz `commonjs` | o `montar` escreve `dist/core/package.json` com `type: module` |

**Por que o segundo só existia empacotado.** Em dev o utility resolve `core/dist`, que tem
o `core/package.json` correto logo acima. O bug nasce da montagem, não do código.

**O que o `tsc` faz com o `import()` do utility, e que ninguém tinha notado.** Em
`module: commonjs` o import dinâmico **não sobrevive**: o emit é
`Promise.resolve(p).then(s => __importStar(require(s)))`. Quem carrega o núcleo é
`require(esm)` (Node ≥ 22.12, presente no Electron 43). Daí saem duas condições que o
comentário da fonte escondia e que agora estão escritas nele: o diretório do núcleo precisa
declarar `type: module` **onde for carregado**, e **nenhum módulo do grafo do core pode usar
`await` de topo** — `require(esm)` é síncrono e recusa módulo assíncrono
(`ERR_REQUIRE_ASYNC_MODULE`). Dev e pacote passam pelo mesmo caminho, então uma regressão
dessas quebra os dois; não é armadilha só de release.

**`npmRebuild` volta para `false`.** POC-03 §3.2 já tinha fixado isso — o
`@electron/rebuild` não toca em `better-sqlite3`, `sodium-native` nem
`fs-native-extensions`, que resolvem por `node-gyp-build`/`require-addon`. §71 tinha ligado
o rebuild sem evidência nova. Verificado no pack: `skipped dependencies rebuild`.

### 72.2 O que a rede real provou

Validação manual do operador, duas máquinas, duas operadoras, pela DHT pública (sem
bootstrap explícito, sem LAN):

| Superfície | Resultado |
|---|---|
| Descoberta e conexão entre pares atrás de NATs distintos | funciona pela DHT pública |
| Mensagem nos dois sentidos | funciona |
| Anexo: envio e download | funciona |
| Reação (emoji) | funciona |
| Voz e compartilhamento de tela | **não existem na UI** — ver §72.3 |

**O que isto NÃO prova.** Uma corrida manual entre duas máquinas não mede classe de NAT,
CGNAT, taxa de conexão direta, nem comportamento sob rotação de §14.2. As observações de
longa duração de §63.4 (host que deixa de receber conexões depois de horas; canal RPC que
não reanexa — esta última fechada na §65) continuam valendo como coisas a observar. O que
fecha aqui é uma pergunta só, e ela era binária: **o produto empacotado encontra outro nó
pela internet pública e conversa com ele.**

### 72.3 Voz e tela não falharam — elas não existem

Vale separar, porque "não funcionou" sugere defeito e aqui é escopo.

| Camada | Estado |
|---|---|
| Decisão host-side (`voiceCoordinator`, `shareStar`, `MediaServer`, `TurnControls`) | **implementada e testada** no núcleo |
| Superfície IPC-R de §15.4 (`voiceJoin`, `voiceLeave`, `voiceSetSelf`, `voiceSignal`, `shareStart`, `shareStop`, `shareSetQuality`, `shareJoin`, …) | **declarada e tipada** em `core/src/l3/ipcRenderer/media.ts` |
| Cliente IPC do renderer | **não expõe nenhum comando de mídia** (`frontend/src/ipc/api.ts` só tem a sonda de NAT) |
| WebRTC no renderer | **não existe** — nenhum `RTCPeerConnection`, `getUserMedia` ou `getDisplayMedia` no código vivo |

Ou seja: o que falta é a **fatia de mídia do renderer** — capturar, negociar e reproduzir.
O núcleo já sabe autorizar sessão, assinar ticket, servir STUN/TURN e recusar tela via TURN.

**Gates.** G7 (`poc/poc-08-g7`) e G8 (`poc/poc-09-g8`) têm veredito **`parcial`**: cobrem a
camada de decisão e a matriz ICE em Node/werift, com `openCriteria` declarados que bloqueiam
**release**, não implementação — mesma situação de G4 na fase 3. Os critérios abertos exigem
Electron empacotado com `getDisplayMedia`/`RTCStatsReport` reais, `tc/netem` e CGNAT real.

### 72.4 Backlog

A lista viva do que está aberto passou para **`docs/backlog.md`**. Esta fatia é a última a
carregar uma tabela de pendências; da próxima em diante, cada fatia registra o que
**entregou** e o backlog registra o que **falta**.

O que esta fatia acrescentou ao backlog: o piso de glibc (B1), os prebuilds fora da matriz
(B2), a assinatura do `.exe` (B3), os `openCriteria` de G7/G8 (B4), as escritas de estrutura
(B5), a mídia no renderer (B6) e a conversa direta (B23).

## 73. Estrutura, cargo e comunidade escrevem no log: o último bloco mock-local sai do caminho — 2026-08-25

**Gate de entrada:** a validação em rede real da §72 mostrou que criar canal não chegava ao
núcleo. **Resultado:** as 19 escritas de estrutura, cargo e comunidade passam pela IPC-R;
nenhuma superfície de escrita do produto continua mock-local. Fecha **B5**. Suítes do
`frontend`: build, lint e 208 testes verdes.

### 73.1 O que estava errado

`ChannelDialogs`, `RolesTab`, `ProfilePopover` e `CommunitySettings` importavam **só stores**.
As ações geravam `randomId(...)` e gravavam em overlays persistidos no `localStorage`. A
**leitura** já vinha do log, então o item criado ficava empilhado sobre uma lista derivada e
nunca reconciliava. Mensagem funcionou na §72 porque `#geral` não foi criado pela UI: a
gênese de `community.create` o cria no log.

### 73.2 Entregas

| Bloco | Comandos | Onde |
|---|---|---|
| Estrutura | `channel.create/update/move/delete`, `category.create/rename/delete` | `features/channels/ChannelDialogs.tsx` |
| Cargos | `role.create/update/move/delete`, `member.setRoles/setNickname` | `features/settings/RolesTab.tsx`, `features/members/ProfilePopover.tsx` |
| Comunidade | `community.update/end/leave` | `features/settings/CommunitySettings.tsx` |

O padrão é o da moderação, síncrona pela mesma razão (A25/U-02): chama, espera, reconsulta e
traduz a recusa nomeada. Tradutor único em `live/recusas.ts`, com os códigos que §15.4
declara — §20.1 diz que o texto em português é do renderer.

### 73.3 Duas coisas que precisaram mudar de forma, não só de destino

**U-23 — auto-save vira salvamento explícito.** Não dava para separar de B5: canal, cargo e
comunidade salvavam a cada tecla ou clique, e essas são ops síncronas num log append-only com
o rate limit de §14.4. Auto-save produzia **uma op por tecla** (`F-12`). Os três formulários
ganham rascunho, botão "Salvar alterações" com estado sujo, Descartar, e desabilitado com
tooltip quando o host está fora. `features/settings/useAutoSave.ts` foi **apagado**: não
sobrou formulário que salve sozinho.

**O arrasto da hierarquia commitava por linha cruzada.** Com `role.move` síncrono, um gesto
viraria uma op por linha atravessada. O arrasto passa a manter ordem de preview local e mandar
**uma** op no drop.

### 73.4 A tradução das setas para o fio

§6.4.1: `role.move` manda os **vizinhos observados**, não posição. Como `dicasDeRank` ordena
por `rank` **ascendente** e usa o seguinte como teto, `afterRoleId` é o cargo logo **abaixo**
do destino na lista exibida — que é `rank DESC`. Sem ninguém abaixo, o destino é o fundo e o
que vai é `beforeRoleId`. Errar o sentido aqui seria um bug silencioso: a op é aceita e o
cargo vai para o lugar errado.

### 73.5 O que sai do store

Todos os overlays de escrita: `createdCommunities`, `createdCategories`, `createdChannels`,
`createdRoles`, `communityOverrides`, `categoryOverrides`, `roleOverrides`, `deletedRoleIds`,
`deletedChannelIds`, `deletedCategoryIds`, `memberRoleOverrides`, `memberNicknames`,
`createdInvites`, `revokedInviteCodes` — e `createCommunity`, que já era **código morto**
desde que a criação passou a ir por `live/sessao.ts`, mas semeava uma comunidade inteira,
gênese de §19.1 incluída, só no LS desta máquina.

Com isso `selectCommunity`, `selectRole` e `selectCategory` viram uma linha cada. Fica
`channelOverrides`, e só para silenciado/lido — preferência de quem lê (§8, 1.1.1), não
estrutura. Apelido e cargo de membro passam a ser lidos do roster: a lista de menção mantinha
um mapa de apelidos "da sessão" enquanto `member.setNickname` é op de log.

### 73.6 O que isto destrava

**B6.** `voiceJoin({communityId, channelId})` exige um `channelId` que os dois lados conheçam
pelo log. Antes desta fatia só `#geral` existia para os dois; agora um canal de voz criado na
UI existe para todo mundo. O backlog vivo continua em `docs/backlog.md`.

## 74. Voz, primeira metade: a socket do host serve STUN e o renderer ganha a superfície de §15.4 — 2026-08-25

**Gate de entrada:** B6 destravado pela §73 (canal de voz criado na UI passa a existir no
log). **Resultado:** o host responde STUN de verdade na socket que o UDX já usa, `voice.join`
entrega `iceServers` reais, e os cinco comandos de voz existem no renderer verificados contra
o roteador do núcleo. Suítes: núcleo **875**, frontend **213** — verdes.

### 74.1 A socket compartilhada de §17.3

O `MediaServer` de L2 já sabia classificar e responder — o G7 mediu isso. O que não existia
era a socket: o `openCriteria` do gate diz, com estas palavras, *"demux/tickets no
`utilityProcess` do produto"*.

`HyperswarmBackend.mediaSocket()` entrega a socket do DHT **sem interpretar nada** — quem
classifica é L2, porque a gramática de STUN não é assunto de transporte. O `tap` recebe cada
datagrama antes do DHT e devolve `true` quando consumiu; devolvendo `false`, o datagrama
segue para o listener original, intacto.

Sem isso `voice.join` devolvia `iceServers` vazio (`VoiceHostSessions` tem `() => []` como
default) e uma chamada entre duas operadoras não sairia do lugar: o WebRTC só junta candidato
de host.

### 74.2 Uma emenda de contrato que a composição obrigou

`MediaServer.hostTurnSecret` era um `Buffer` fixo. Mas §5.2 deriva o segredo **por
comunidade** e §17.3 manda **uma socket por processo** — hospedar duas comunidades quebrava.
Passa a aceitar também um resolvedor por `sessionId`, que já vem no username da credencial
(RFC 5389 §10.2), devolvendo `null` para sessão que não é desta instalação: recusa como
qualquer credencial inválida, sem revelar que a sessão existe. O `Buffer` cru continua
aceito, então o harness do G8 não quebra.

### 74.3 O que foi medido, e o que isso diz

| Medida | Valor |
|---|---|
| `dht.host` | IP público observado |
| `dht.firewalled` | **`true`** nesta máquina |
| Binding Request → resposta | `0x0101` com `XOR-MAPPED-ADDRESS` correto |
| UDX atravessando o classificador | byte a byte, até quem já estava na socket |

O `firewalled: true` é a **L-11** declarada — e é também a razão de a socket ser
compartilhada, não uma otimização: o mapeamento NAT que vale é o que o tráfego do DHT
mantém vivo.

Sem endereço observado, `iceServers` vai **vazia de propósito**: anunciar `0.0.0.0` faria o
cliente tentar e falhar, o que é pior do que não anunciar.

### 74.4 O ticket atravessa a IPC-R como bytes, não como hex

Os tickets de §17.4 chegam ao renderer como `Uint8Array`. A IPC-R é `postMessage`, que é
structured clone, e o `Buffer` do núcleo passa como bytes. O fio de §16.2 é JSON e leva hex —
o núcleo tem um codec só para aquela travessia (`mediaWire`). Confundir os dois faria a
verificação de assinatura de A22 falhar em silêncio no lado do renderer.

### 74.5 Registro de método

A prova de que o classificador não derruba o DHT começou como dois nós conectando por
testnet. O teste falhava — **e falhava igual sem a torneira instalada**, então era o harness,
não a mudança. Trocado por uma asserção determinística que prova o contrato de repasse byte a
byte sem depender de a conexão subir. Fica registrado porque a tentação de aceitar o primeiro
vermelho como defeito real é grande.

## 75. Dispositivos de áudio de verdade: o select deixa de inventar hardware — 2026-08-25

**Gate de entrada:** §74 entregou a superfície de voz; faltava saber qual microfone usar.
**Resultado:** `enumerateDevices` real, com permissão pedida no gesto que precisa dela.

### 75.1 O defeito que já estava valendo

A lista era inventada em `settingsStore.ts` — "Microfone USB (Blue Yeti)", "Headset
Bluetooth", nomes fixos. Enquanto nada capturava, essa era a escolha **certa**: pedir
permissão de microfone para popular um select que não grava nada cobra um custo real por uma
tela falsa, e o comentário do código dizia isso.

Deixou de ser certa na **§68**, que ligou `settings.setDevice` ao núcleo. A partir dali a
escolha era *persistida*: há instalações com `microphoneId: "usb"` gravado no manifest, um id
que nunca existiu em máquina nenhuma. Quando a captura entrar, ler isso cru daria
`OverconstrainedError` num lugar onde a pessoa não fez nada errado.

### 75.2 Entregas

| Entrega | Onde | Nota |
|---|---|---|
| Enumeração real, com `devicechange` | `live/dispositivos.ts` | plugar um headset aparece sem reabrir a tela |
| Permissão no gesto certo | "Testar microfone" | enumerar não pede permissão; **rotular** pede |
| `escolhaValida` — id que sumiu cai para o padrão | idem | cobre os `"usb"`/`"headset"` que o mock persistiu |
| Handler de permissão explícito | `app/src/main/index.ts` | só `media`; o resto recusado (§25.4) |

O handler no main não existia: a decisão ficava com o default do Electron, que varia por
versão. Uma porta de captura não deve depender disso.

### 75.3 Medido no Electron real

Enumeração sobre `file://` (que é o que o produto usa; `data:` não é contexto seguro e
devolve `navigator.mediaDevices` indefinido — errei nisso no primeiro probe):

```
audioinput  | default    | "Default"
audioinput  | 4cf461efd7 | "RDP Source"    ← ponte de áudio do WSLg
audiooutput | default    | "Default"
audiooutput | a701d1f978 | "RDP Sink"
```

`getUserMedia({audio:true})` passou. Os nomes aqui são a ponte do WSL; numa máquina nativa
são os dispositivos de verdade.

### 75.4 O que isto NÃO faz

Não captura. O medidor de nível continua sendo o do mock (§10, 3.1 já o descrevia como
"anima aleatoriamente quando testando"), e "Testar microfone" hoje só pede a permissão e
anima — não reproduz o que o microfone ouve. Captura e medidor real entram com a camada
WebRTC. O backlog vivo continua em `docs/backlog.md`.

## 76. A malha de voz liga: WebRTC ponta a ponta, tickets de §17.4 e os quatro eventos de §15.5 — 2026-08-25

**Gate de entrada:** §74 pôs o host servindo STUN; §75 deu microfone real.
**Resultado:** B6 fechado no escopo de **voz**. O renderer abre `RTCPeerConnection` por par,
negocia por `voice.signal` e recusa DTLS com quem o host não pareou. Suítes: frontend
**227** verdes, núcleo **875**, app typecheck; o pacote sobe e o núcleo chega em `ready`.

### 76.1 A divisão que define o módulo

`live/voz.ts` fala WebRTC e **não sabe o que é uma tela**. `voiceStore` guarda o estado que a
tela lê e **não sabe o que é um `RTCPeerConnection`**. `live/sincronizacao.ts` é o único lugar
onde os dois se encontram — mesmo padrão de mensagem e preferências.

### 76.2 O que o renderer NÃO verifica, e por quê

§17.4 passo 3 ("o cliente só aceita sinalização de par com ticket válido") é verificado **no
núcleo**: `signalIsAuthorized` roda antes do evento chegar ao renderer, com a chave do host e
os tickets da sessão, e falha fechada. Duplicar aqui exigiria Ed25519 sobre BLAKE2b no
navegador — que a WebCrypto não tem — e criaria uma segunda fonte de verdade para a mesma
regra.

O que é do renderer é o **passo 4**: não iniciar DTLS com par para quem não temos ticket.
Esse não precisa de assinatura, só de ler o par ordenado de cada ticket (`paresAutorizados`).

### 76.3 Achados de contrato

| Achado | Consequência |
|---|---|
| Ticket tem **duas formas no fio**: `voice.join` responde pela IPC-R (structured clone → `Uint8Array`), `voice.tickets` usa o codec de §16.2 (JSON → hex) | `chaveHex` absorve as duas; quem consome não deve saber por qual porta entrou |
| `ticketId` nasce em `renewTicket` (12 bytes aleatórios), **não** em `voice.join` | O host o repassa opaco e o núcleo do destino valida com os PRÓPRIOS tickets: é rótulo, não credencial |
| Sem regra de iniciativa, os dois lados ofertam e a negociação entra em *glare* | `souOIniciador` compara as chaves: determinístico, sem mensagem extra |

### 76.4 Duas ordens que ficaram no código com o motivo escrito

**O host decide antes da captura.** Ligar o microfone para depois descobrir que `voice_speak`
não deixa entrar acende a luz à toa — tem teste.

**O roster é do host, o estado da conexão é local.** `voice.roster` republicado não pode
apagar como ESTA máquina enxerga cada par: a falha de mesh é assimétrica (§9, 2.3) e sobrevive
à lista nova.

### 76.5 O que sai e o que fica

Saem do `voiceStore` os temporizadores de simulação da voz: `MESH_CONNECT_MS`,
`SPEAKING_TICK_MS`, `MESH_FAILURE_ID` (que fixava a falha na Bianca do dataset) e o ciclo de
fala aleatório. Fica a metade de **tela**, que é B25 — e com ela as superfícies de árvore de
B26, pelo motivo já registrado: sair antes seria mexer duas vezes nos mesmos arquivos.

### 76.6 O que só duas máquinas respondem

Nada aqui exercitou áudio. Os dez casos novos usam `RTCPeerConnection` falso — provam a
decisão (quem oferta, quem é recusado, o que o roster faz), **não** a mídia. Falta medir:
conexão direta entre operadoras diferentes, o caminho TURN (que **não existe** ainda — B27),
e o comportamento sob a L-11 quando o host está atrás de CGNAT.

## 77. Três defeitos que só duas máquinas achavam: a sinalização não voltava ao host, a ocupação nunca foi implementada, e a revogação derrubava a chamada errada — 2026-08-25

**Gate de entrada:** §76 entregou a malha; o smoke em duas máquinas mostrou "Conectando…"
infinito e a sala parecendo vazia para quem estava de fora. **Resultado:** três defeitos
corrigidos, dois deles estruturais. Suítes: núcleo **878**, frontend **227**.

### 77.1 O host não se encontrava no próprio mapa (causa do "Conectando…" infinito)

`peerSignalRelay` procura o destino em `connections`, que é o mapa dos **RPC servers
remotos**. O host não abre conexão consigo mesmo, então `connections.get(chaveDoHost)`
devolvia `null` e a sinalização morria com `E_PEER_UNREACHABLE`.

Efeito: a negociação WebRTC ficava **só de ida**. Host→membro entregava; membro→host não. O
SDP precisa dos dois sentidos (oferta e resposta), então nenhuma chamada fechava — e o lado
que não recebia nada não tinha como distinguir "ninguém falou comigo" de "falaram e o quadro
sumiu".

Nenhum teste pegava porque nenhum exercitava a direção membro→host: os do G8 rodavam decisão
sobre portas simuladas, e os do renderer usam `RTCPeerConnection` falso dos dois lados.

O destino que é esta identidade passa a ser resolvido por emissão local — o mesmo evento de
§15.5 que o renderer já escuta, pelo fan-out em vez do fio.

### 77.2 `voice.occupancyChanged` estava na spec e não existia no código

§15.5 declara o evento com a finalidade escrita — *"alimenta a sidebar (fecha `RT-05`)"* — e
**zero ocorrências** dele existiam no núcleo ou no frontend. Quem não estava na chamada só
via os participantes por `query.structure`, que é leitura: a lista era do instante da consulta
e não acompanhava ninguém entrando.

Agora sai de `onRosterChanged` para **toda a comunidade**, não só para quem está na sessão —
a ocupação é do canal, e é justamente quem está de fora que precisa dela.

### 77.3 `leave` não republicava o roster

Quem ficava na chamada só recebia o `voice.revoked` de quem saiu; a lista só se corrigia no
próximo `join`, e a ocupação nunca voltava a zero. `leave` e `#endSession` passam a emitir o
roster antes de derrubar a sessão.

### 77.4 E um defeito meu, da §76

A assinatura de `voice.revoked` no renderer ignorava o `targetKey` e chamava `malha.sair()`
sempre. Ou seja: **alguém sair da chamada derrubava a chamada de todo mundo.** A revogação
nomeia um alvo; se não sou eu, quem sai é ele — e o que se atualiza é o roster.

### 77.5 O que continua sem resposta

O TURN não existe (B27), então NAT simétrico ou CGNAT dos dois lados continua sem caminho. E
nada disto foi ouvido: as correções são de entrega de sinalização e de estado, não de mídia.
B28 segue aberto.

## 78. O impasse do ticket e a saída que ninguém atendia — 2026-08-25

**Gate de entrada:** smoke de duas máquinas com a instrumentação da §77.
**Resultado:** dois defeitos, achados por log e por leitura. Suítes: núcleo **878**, frontend
**227**.

### 78.1 O impasse do ticket (a chamada que nunca fechava)

O log deu o caso inteiro:

```
roster do host ['02186399','5bc953ae']    ← os dois na sala
autorizado a falar com 1 par(es)          ← este lado TEM ticket
par 02186399 · aguardando oferta          ← e fica esperando
```

Quem entra **primeiro** faz `voice.join` com o roster contendo só a si mesmo, e recebe
**zero tickets** — não havia com quem parear. Sem ticket, o cliente não oferta (§17.4 passo
4). Quem entra depois tem ticket, mas pela regra de iniciativa espera a oferta do outro.

Os dois ficavam parados até a cadência de renovação, que é `MEDIA_TICKET_TTL_MS / 3` — da
ordem de minutos. O usuário desiste antes, e o sintoma é "Conectando…" para sempre.

A renovação passa a disparar **quando o roster muda**, nos dois caminhos: no membro, pelo
quadro de §16.3 que já chamava `observeRoster`; no host, por um holder que `onRosterChanged`
aciona — o runtime de mídia nasce depois dele. E no renderer, ticket novo que autoriza um par
com conexão já aberta dispara a oferta que não pôde sair antes.

### 78.2 A saída que ninguém atendia

`ouvirPedidoDeSaida` e `confirmarSaida` existiam em `ipc/bridge.ts` com **zero consumidores**.
O main segura o primeiro fechamento da janela (U-06), manda `exit-impact` e espera resposta —
e não havia ninguém do outro lado. A janela ficava presa até o prazo de 10 s, e o
encerramento ainda esperava o dreno.

O `HostExitDialog` existia e estava montado, mas alcançável só pelo afinador de §19.1: o
comentário dele dizia, desde a versão web, *"pronta para a versão empacotada"*. Nunca foi
ligada.

Pior: os três botões chamavam o **mesmo** `onClose`. "Cancelar" e "Fechar mesmo assim" faziam
a mesma coisa — fechar o modal e não fechar o app.

Agora: o pedido do main abre o modal quando há impacto; sem impacto (`useHostedImpact` só
conta comunidade hospedada **com gente online ou em chamada**) confirma na hora, porque não há
o que perguntar. E "Fechar mesmo assim" responde ao main.

### 78.3 O que não foi verificado

O ciclo de fechamento **não foi exercitado**: este ambiente não tem gerenciador de janelas
para disparar o `close`. Tipo, build e suíte estão verdes; o fechamento em si depende do
smoke da máquina real.

## 79. A voz conecta: `ticketId` derivado da assinatura fecha a última lacuna — 2026-08-25

**Gate de entrada:** §78 destravou o impasse do ticket e o membro passou a ofertar.
**Resultado:** **chamada estabelecida entre duas máquinas** (`conexão connected`). Suítes:
núcleo **878**, frontend **229**.

### 79.1 A lacuna de contrato

O log do membro deu o caso: a oferta saiu e o núcleo recusou com `E_VALIDATION`.

§15.4 exige `ticketId` em `voice.signal`, mas só define de onde ele vem no caminho de
**renovação** — §16.2 `voiceTicket` devolve `{ticketId, ticket, expiresAt}`. Quem acabou de
entrar recebe os tickets por `voice.join`, que **não traz id nenhum**, e quem oferta fala
primeiro, antes de qualquer renovação.

Pior: o dispatcher remoto **descartava** o `ticketId` da renovação, e o host o gerava
aleatório — então o id não chegava ao renderer por caminho nenhum, e o do host não
significava nada para o outro lado.

O id passa a ser **derivado da assinatura do ticket** (12 primeiros bytes), no núcleo
(`ticketIdOf`) e no renderer (`ticketIdDe`). Fecha sem campo novo no fio, e com propriedade
melhor que a do aleatório: o id **identifica** o ticket, e os dois lados chegam nele
sozinhos. A assinatura cobre `(sessionId, channelId, par ordenado, expiresAt)`, então é única.

### 79.2 O que a corrida provou — e o que NÃO provou

Provou: `voice.join` → renovação por roster → oferta → sinalização nos dois sentidos → ICE →
`connected`. Todo o caminho de decisão e de sinalização de §17.4 funciona entre duas
instalações reais.

**Não provou travessia de NAT.** O log traz `candidato host udp` e **nada mais**: nenhum
`srflx`, nenhum `relay` — a conexão fechou por endereço de rede local. **O operador
confirmou: as duas máquinas estavam na mesma internet.** Não é inferência a partir do log,
é o cenário declarado.

Vale contrastar com a §72, que provou mensagem, anexo e reação entre **operadoras
diferentes**: aquele caminho é replicação por Hypercore sobre a DHT, que já resolve NAT por
conta própria (hole punching do `hyperdht`). Mídia não herda isso — o `RTCPeerConnection` do
renderer abre socket PRÓPRIA, e o mapeamento NAT é por socket (§17.1 revogou a ADR-06 de v1
exatamente por essa razão). Que texto atravesse não diz nada sobre voz atravessar.

Duas consequências:

1. **O STUN do host não respondeu.** Com `firewalled: true` (medido na §74), o mapeamento NAT
   da socket é mantido pelo tráfego do DHT — mas um pacote STUN não solicitado, chegando de um
   endereço para o qual aquele NAT nunca enviou nada, é descartado por NAT restrito. É a
   **L-11** acontecendo, não um defeito de código.
2. **Sem `srflx` nem TURN, operadoras diferentes continuam sem caminho.** B27 deixa de ser
   dívida e passa a ser o que separa "funciona na mesma rede" de "funciona".

### 79.3 O que fica

| Item | Estado |
|---|---|
| Voz na mesma rede | **funciona**, medido entre duas instalações |
| Voz entre redes | **sem evidência** — o cenário nem foi exercitado; depende de `srflx` ou TURN |
| TURN | não existe (B27) |
| Áudio ouvido | relatado pelo operador; sem medida de latência ou perda |

## 80. L-11 medida entre operadoras, e `conn-failed` deixa de ser promessa — 2026-08-25

**Gate de entrada:** §79 conectou na mesma rede. **Resultado:** entre **internets
diferentes** a chamada não fecha, e agora ela **diz por quê** em vez de girar. Suítes:
frontend **230**.

### 80.1 A medida

O log do smoke, entre operadoras distintas, é conclusivo: **quatro `candidato host udp`,
quatro `host tcp`, nenhum `srflx`, nenhum `relay`**. A oferta saiu, a sinalização funcionou
nos dois sentidos, o ICE juntou só endereço de rede local e não havia par possível.

Nenhum `srflx` significa uma coisa só: **o STUN do host não respondeu**. Com
`firewalled: true` (medido na §74), o mapeamento NAT da socket compartilhada é mantido vivo
pelo tráfego do DHT — mas um Binding Request chegando de um endereço para o qual aquele NAT
nunca enviou nada é descartado por NAT restrito.

Isso é **L-11 acontecendo**, exatamente como §17.3 previu. Não é defeito de código.

**Por que a replicação atravessa e a mídia não.** A §72 provou mensagem e anexo entre
operadoras diferentes: aquele caminho é Hypercore sobre a DHT, e o `hyperdht` faz hole
punching COORDENADO — os dois lados enviam ao mesmo tempo, e o mapeamento nasce dos dois
lados. Um Binding Request do WebRTC é **não solicitado**, e vem de uma socket diferente: o
mapeamento é por socket (§17.1 revogou a ADR-06 de v1 por essa razão). Texto atravessar não
faz voz atravessar.

### 80.2 `conn-failed` existia na spec e não no código

§17.3 diz que sem porta alcançável "a conexão falha com `conn-failed`, que é um estado
desenhado", e a tabela de limitações (L-11) dá a mitigação: *"Diagnóstico de rede + estado
`conn-failed`"*. O estado existia no `voiceStore` (`stage: "failed"`) e no banner do
`VoiceOverlay` — mas **nada o alcançava**: sem candidato viável o ICE fica em `checking`
indefinidamente, e a tela dizia "Conectando…" para sempre.

Agora há prazo (20 s) e o motivo é **derivado do que o ICE viu**: só `host` = nenhum endereço
público foi descoberto, e o texto diz isso — "quem hospeda a comunidade não está alcançável
de fora da rede dela". Qualquer outra combinação recebe a mensagem genérica, porque a causa
seria outra.

### 80.3 As três saídas que a spec admite, e o que cada uma custa

| Caminho | O que a spec diz | Custo |
|---|---|---|
| **STUN de terceiros** | §17.2: "configurável, default vazio, **com aviso**" — permitido | Pequeno. Dá `srflx` aos dois lados e o ICE fura sozinho na maioria dos NATs. Um terceiro passa a ver o IP de quem chama |
| **TURN do host** (B27) | §17.3 | Médio. **Mas tem o MESMO problema de alcançabilidade**: o Allocate também chega não solicitado. Não resolve L-11 |
| **Relay voluntário** (§17.7) | A resposta que a própria spec dá para L-11 | Grande. É a fase 8 |

Registrado sem escolher: a decisão é de produto (§25.4 diz que este produto não fala com
nada além dos pares; §17.2 abre exceção nomeada só para STUN).

## 81. STUN de terceiros: a única exceção que §17.2 nomeia, ligada e desligada por padrão — 2026-08-25

**Gate de entrada:** §80 mediu a L-11 entre provedores diferentes. **Resultado:** a saída que
a spec autoriza existe e está **desligada por padrão**. Suítes: núcleo **882**, frontend
**230**.

### 81.1 Por que é STUN e não TURN

§25.4 é categórica: *"nenhum servidor, TURN de terceiro, unfurl, CDN, analytics ou crash
reporter"*. §17.2 abre **uma** exceção, nominal: *"STUN de terceiros — configurável, default
vazio, com aviso"*. E §17.3 fecha a outra porta com todas as letras: *"não há TURN de
terceiro e não haverá"*.

A diferença é de substância, não de grau: um STUN só responde *"qual é o seu endereço
público"*; um TURN **carregaria a mídia**. Por isso o parser **descarta** um `turn:` em vez de
aceitá-lo — não é engano de digitação a corrigir, é coisa que a arquitetura recusa. Tem teste.

### 81.2 Correção de rumo: o TURN do host não resolvia a L-11

Nas §§76–79 este documento tratou **B27** (permissões TURN) como "o que separa funcionar na
mesma rede de funcionar". **Estava errado**, e a medida de §80 mostrou por quê: o `Allocate`
do TURN chega à mesma porta do host, do mesmo jeito não solicitado que o Binding Request do
STUN. Se o host não é alcançável, o TURN dele também não é. B27 continua sendo dívida real
— mas não é a que desbloqueia chamada entre provedores.

### 81.3 O que foi entregue

| Entrega | Onde |
|---|---|
| `stunServers` na config de L0, default **vazio**, override por `P2P_STUN_SERVERS` (§27.2) | `l0/config/index.ts` |
| Formato validado, não corrigido: só `stun:`/`stuns:` passa | idem |
| O servidor do host vem **primeiro** na lista | `composition/media.ts` |
| Aviso de §17.2 no log quando há terceiro no caminho | `live/voz.ts` |

A ordem importa e é a razão de a lista não ser um conjunto: o ICE tenta na ordem, então
quando o STUN do host resolve, o de terceiro **nem é consultado**, e o IP de quem entra na
chamada não sai da comunidade. O terceiro é a saída da L-11, não o caminho normal.

### 81.4 Lacuna de spec registrada (B29)

§17.2 diz "configurável" e **não diz por qual superfície**. Hoje só se liga por variável de
ambiente, o que num Windows empacotado significa mexer nas variáveis do sistema. Uma
superfície de UI exigiria comando novo em §15.4, que a spec não tem — então fica registrado
como lacuna, não inventado.


### 81.5 Emenda de 2026-08-25 — o padrão vira LIGADO

Decisão do operador, tomada depois de §80: o STUN de terceiros passa a vir **ligado**, e
`backend-v2.md` §17.2 recebeu a emenda correspondente. Registrar nos dois lugares é o ponto —
código e normativo divergirem em silêncio é pior que qualquer um dos dois estados.

O motivo da regra original continua verdadeiro (o servidor vê o IP de quem entra em chamada).
O que mudou é o peso do outro prato: sem endereço público a chamada entre provedores
**não acontece**, e voz que só funciona na mesma rede não é voz.

Três guardas que a emenda não afrouxa, todas com teste:

| Guarda | Como |
|---|---|
| O do host vem **primeiro** | o ICE tenta em ordem; resolvendo nele, o terceiro não é consultado |
| Desligar continua possível | `P2P_STUN_SERVERS=""` vence o default |
| Só STUN | `turn:` segue descartado pelo parser (§17.3: "não há TURN de terceiro e não haverá") |

A distinção que sustenta a segunda guarda: a resolução separa **"variável não definida"** de
**"definida e vazia"**. Confundi-las tornaria o padrão indesligável — e um padrão que não se
desliga não é padrão, é imposição.

**Achado no caminho:** o teste do `MediaHost` quebrou ao criar instâncias extras para ler
`iceServers()`. Cada `MediaHost` **instala um classificador na socket**, e o último instalado
consome o datagrama — os extras roubavam o pacote do original. Não era o teste sendo chato:
é uma propriedade real da classe, e agora está escrita.

## 82. A voz atravessa provedores diferentes — 2026-08-25

**Gate de entrada:** §81 ligou o STUN de terceiros por padrão. **Resultado:** chamada
estabelecida entre **duas máquinas em provedores diferentes**, confirmado pelo operador.
Fecha **B6** e **B28** na forma em que estavam escritos.

### 82.1 O caminho inteiro, do zero até a voz

Sete fatias, e cada uma destravou a seguinte:

| § | O que faltava |
|---|---|
| 74 | a socket do UDX não era compartilhada — o host não servia STUN nenhum |
| 74 | o endereço anunciado era o mapeamento de **outra** socket que a do classificador |
| 75 | o microfone era inventado; a preferência gravada apontava para hardware inexistente |
| 76 | a malha não existia: nada abria `RTCPeerConnection` |
| 77 | o host não se encontrava no próprio mapa — sinalização só de ida |
| 78 | quem entrava primeiro recebia zero tickets e nunca ofertava |
| 79 | `voice.join` não dava `ticketId`, e a oferta era recusada com `E_VALIDATION` |
| 80 | sem endereço público, o ICE só juntava candidato de rede local (L-11) |
| 81 | o STUN de terceiros — a única exceção que §17.2 nomeia |

Nenhum desses apareceu em teste automatizado. **Todos** vieram do smoke em duas máquinas, e
cinco deles só ficaram visíveis depois que a §77 instrumentou o caminho no console: uma
negociação que falha em silêncio é indistinguível de uma que nunca começou.

### 82.2 O que a evidência cobre, e o que não

**Cobre:** descoberta, autorização por ticket (§17.4), sinalização nos dois sentidos, ICE com
`srflx`, DTLS-SRTP ponta a ponta e áudio audível entre provedores distintos.

**Não cobre:**

| Aberto | Onde |
|---|---|
| Latência, perda e CPU em rede real — os números de G8 são de localhost | B28 |
| NAT simétrico dos dois lados: `srflx` não basta e não há relay | B30, §17.7 |
| TURN do host (não resolve L-11, mas segue sendo dívida) | B27 |
| Tela: estrela de 8, `getDisplayMedia`, perfis de qualidade | B25 |
| `openCriteria` de G7/G8 — bloqueiam **release**, não uso | `poc/poc-08-g7`, `poc/poc-09-g8` |

### 82.3 O que este trecho ensinou sobre o método

Três dos oito defeitos eram **superfície declarada na spec e ausente no código** —
`voice.occupancyChanged` (§77.2), `conn-failed` (§80.2) e o consumidor de `exit-impact`
(§78.2). Nos três casos o texto normativo descrevia o comportamento e nada o alcançava, e em
nenhum deles um teste de unidade teria notado: o que faltava não era lógica errada, era
ligação inexistente entre duas pontas que já existiam.

## 83. A tela sai do mock: estrela de 8, captura real e o laço de saúde que faltava — 2026-08-25

**Gate de entrada:** §82 fechou a voz entre provedores. **Resultado:** B25 e B26 fechados no
código. Suítes: frontend **244** verdes (eram 230), núcleo **887** (eram 884), app e frontend
typecheck, `npm run build` do frontend. **Não validado em duas máquinas** — ver §83.6.

### 83.1 A auditoria antes do código, e os cinco buracos

§82.3 disse que três dos oito defeitos da voz eram superfície declarada e ausente. Antes de
escrever qualquer linha, o mesmo exame nos cinco eventos de tela de §15.5:

| Evento | Produtor no núcleo | Consumidor no renderer |
|---|---|---|
| `share.started` | **sim** (`boot.ts`) | **não** |
| `share.viewersChanged` | **sim** | **não** |
| `share.stopped` | **sim** | **não** |
| `share.health` | **não** — `ShareHealthMonitor` existia, testado, e **ninguém o instanciava** | **não** |
| `share.failed` | **não** — zero ocorrências no repositório | **não** |

E mais dois, fora da tabela:

- **`capture.authorize`/`capture.decision` (§15.7) não existia em ponta nenhuma.**
  `MediaRouter.authorizeCapture` estava escrito e era código morto: o main nunca perguntava,
  o utilityProcess não tinha handler, e `setDisplayMediaRequestHandler` era um **comentário**.
  A ordem de `T-41` não era verificada em lugar nenhum.
- **`destinatariosDaTela` mandava dois dos três eventos para a comunidade inteira.**
  `viewersChanged` e `stopped` não carregavam `channelId`, então a função devolvia `null` —
  que em `empurra` significa "todos os conectados". §15.5 diz "só a participantes da sessão".

### 83.2 `share.failed` não virou evento, e isso é o precedente da voz

`voice.failed` e `voice.meshChanged` também têm zero ocorrências no código: a voz os resolveu
**no renderer**, em `aoFalhar`/`aoMudarPar`, sem materializar o evento de §15.5. A falha é
conhecida onde acontece, e devolvê-la ao núcleo para que ele a empurrasse de volta não
acrescentaria informação. `share.failed` seguiu o mesmo caminho — `EstrelaDeTela.aoFalhar` →
`telaFalhou`. É a diferença entre um buraco e uma escolha já feita.

### 83.3 A emenda: o laço de saúde tinha duas pernas e uma só estava declarada

Este foi o único buraco que não fechava sem superfície nova, e foi decisão do operador.

§17.5 dá `share.setQuality` como funcionando e fecha `F-08`/`V-13`. Mas o papel do comando é
**espectador**, e o efeito é do apresentador; o único caminho entre os dois é o `quality` que
`share.health` carrega. §16.3 declarava esse evento descendo ao apresentador — e **nada**
declarava como as amostras sobem ao host, que é quem consolida e degrada. Sem elas o host não
tem número, `share.health` nunca sai, e o pedido do espectador morre no registro do host: o
`F-08` de volta, com a spec dizendo que estava fechado.

`share.report` (§15.4) e `shareReport` (§16.2) fecham o ciclo, escritos em `backend-v2.md`
como emenda de 2026-08-25. Quem mede não decide: só o **apresentador** relata, e a degradação
continua sendo do host, que é quem tem autoridade sobre a sessão.

### 83.4 Uma decisão de desenho que a spec não escreve

§17.5 pede "uma `RTCPeerConnection` por espectador". Ela **já existe**: é a que a voz mantém
com aquele par. §15.4 tem um único canal de sinalização (`voice.signal`) e nenhum campo que
diga a qual negociação um SDP pertence — uma segunda conexão pelo mesmo canal faria a oferta
de uma cair na outra. A estrela é, portanto, o conjunto dos envios de trilha sobre a malha que
a voz já mantém de pé, e a audiência de §17.5 (participante do canal de voz, A19) é o que
torna isso suficiente.

Isso preservou a divisão de §76.1: `live/voz.ts` ganhou `enviarTrilha`/`aoChegarVideo`, que
falam de **trilha** e `track.kind` — vocabulário do WebRTC, não de tela. `live/tela.ts` sabe o
que é tela e não toca em `RTCPeerConnection`. `live/sincronizacao.ts` continua sendo o único
lugar onde os dois se encontram.

### 83.5 O que saiu com B26

Do `voiceStore`: `STAR_MAX_VIEWERS = 5` (que contradizia o `SHARE_MAX_VIEWERS = 8` normativo
em valor **e** em significado), `topology`, `treeHealth`, `firstLevelRelays`, `buildRelays`,
`relayCandidates`, `retopologize`, os temporizadores de simulação e os sete afinadores de tela
do `DevBar`. Do `ScreenShareStage`: o badge de topologia, o `TreeHealthPopover` (arquivo
apagado), os banners de otimização e reparo, e o selo **"Via TURN"** — §17.3 diz que tela via
TURN é *recusada* no v1, então o selo prometia um caminho que não existe. Do dataset: a
fixture de 7 espectadores em árvore, metade fora da chamada (delta U-12).

O consentimento de repasse **ficou**: §17.7 é v2, não revogado. O que mudou foi o gatilho, que
era a transição estrela→árvore e agora é `relay.consentRequested` — dormente até B27/B30.

### 83.6 O que NÃO foi verificado

Nada aqui exercitou captura de tela real, nem uma segunda máquina. Os testes novos usam
captura e malha falsas: provam a **ordem** de `T-41`, o perfil por espectador, a reconciliação
da audiência e o laço de saúde — **não** provam que a tela aparece do outro lado. Os números
de G8 são de localhost e os `openCriteria` de G7/G8 continuam bloqueando release.

Falta medir: latência e taxa de quadros da tela em rede real; o comportamento com 8
espectadores de verdade (o G8 mediu a estrela, não esta implementação); o seletor do sistema
no Windows e o portal PipeWire no Linux, que são caminhos de captura diferentes; e o que
acontece quando a renegociação de trilha acontece com o ICE ainda instável.

## 84. Quatro defeitos da §83, achados relendo o próprio código — 2026-08-25

**Gate de entrada:** §83 entregou a tela e não foi validada em duas máquinas. **Resultado:**
quatro defeitos corrigidos, um deles grave, todos com regressão. Suítes: núcleo **888**,
frontend **250**. Continua sem validação em duas máquinas.

### 84.1 A audiência era a chamada inteira (o grave)

`atualizarEspectadores(malha.pares())` servia a tela a **todos os pares da chamada**. O teto
de §17.5 é 8 (`SHARE_MAX_VIEWERS`); o da chamada é 24 (`MAX_VOICE_PARTICIPANTS`). Numa
chamada cheia isso são 23 envios em vez de 8 — e, em `high`, ~57 Mbps de upload contra os 20
que a própria §17.5 já considera acima do que uma conexão residencial entrega.

Pior que o número: **quem o host recusou com `E_SESSION_FULL` recebia a tela assim mesmo**. A
autorização de §17.5 valia no lado que pede e não no lado que envia, que é onde ela importa. O
comentário que eu havia escrito — "o teto é do host, esta lista já vem podada" — era falso: a
lista vinha da malha de voz, que o host nunca podou.

A causa raiz é de contrato: `share.viewersChanged` manda `{sessionId, viewerCount}`, uma
**contagem**, e nada mais em §15.5 nomeia os espectadores. O único evento que carrega chaves é
`share.health` — e ele só saía para quem já tinha amostra, que só existe depois de já estar
servindo. Circular.

A correção fica no núcleo, sem superfície nova: `ShareHealthMonitor.tick` passa a iterar as
**sessões vivas** (`liveSessions`) em vez das amostras, e o snapshot lista a audiência
autorizada desde o primeiro tick, medida ou não. `rttMs`/`lossPct` saem **omitidos** para quem
ainda não foi medido — zerá-los faria a UI mostrar "0 ms · 0,0%" como medida e a degradação
ler uma perda que ninguém observou. O `viewersChanged` no host dispara um tick junto, para a
audiência nova não esperar os 2 s da cadência.

### 84.2 A renegociação represada nunca voltava

`#renegociar` adiava a oferta quando a `RTCPeerConnection` não estava em `stable`, e o
comentário prometia que "a trilha entra na próxima". Não entrava: `atualizarEspectadores` só
chama `enviarTrilha` para par que ainda não está no mapa, e o par entrava no mapa assim que a
chamada retornava. A trilha ficava adicionada à conexão com a oferta nunca enviada.

O caminho era comum, não raro: quem entra na chamada com a tela já no ar tem a conexão em
`have-local-offer` quando o envio é aberto. Resultado: **sem vídeo, para sempre, em silêncio**
— a mesma forma de defeito que §82.3 nomeou, agora introduzida por mim.

Agora o adiamento marca `renegociacaoPendente` e `onsignalingstatechange` solta a oferta ao
voltar a `stable`.

### 84.3 Sessão encerrada pelo host deixava a captura viva

`telaParou` (de `share.stopped`) limpava só o estado. Quando quem encerra é o **host** — ban,
kick, canal apagado, sweep de §18.1 —, a captura do apresentador continuava rodando: a luz de
"compartilhando tela" do sistema acesa, transmitindo para uma sessão que não existe mais.
Agora, se eu era o apresentador, `telaParou` manda a estrela parar.

### 84.4 A perda era a acumulada da sessão inteira

`leituraDeSaida` dividia `packetsLost` por `packetsSent`, ambos contadores **acumulados** do
WebRTC. Isso dá a média desde o começo da transmissão, não a taxa do momento. Como a
degradação de §17.5 **só desce**, uma rajada nos primeiros segundos manteria a perda média
acima de 3% por muito tempo e prenderia o espectador no perfil baixo mesmo depois de a rede
melhorar. Agora `enviarTrilha` guarda a leitura anterior e reporta o delta do intervalo.

### 84.5 O que este trecho ensinou

Os quatro passaram pela suíte da §83 sem serem notados, e três deles pelo mesmo motivo: os
testes exercitavam `atualizarEspectadores` com a lista **já correta**, em vez de verificar de
onde a lista vinha. Um teste que injeta a entrada certa nunca descobre que a produção injeta a
errada — é a versão em teste do que §82.3 disse sobre ligação inexistente entre duas pontas.

As regressões novas foram verificadas ao contrário: cada uma foi vista **falhar** com a
correção desligada antes de entrar.

## 85. A tela atravessa provedores, e o mudo era decoração — 2026-08-26

**Gate de entrada:** §84 corrigiu os quatro defeitos achados por releitura. **Resultado:**
tela **confirmada entre duas máquinas em provedores diferentes**, pelo operador. Três
defeitos novos, os três achados pelo smoke — nenhum por teste. Suítes: frontend **255**,
núcleo **888**.

### 85.1 O que a corrida provou

O laço inteiro de §17.5 funcionou em rede real: `share.start`, captura, uma
`RTCPeerConnection` por espectador sobre a malha da voz, `share.join` do espectador,
`share.setQuality high → applied=true`, `share.report` subindo, `share.health` descendo e o
`maxBitrate 2500` aplicado no sender daquele espectador. A emenda de §83.3 — a perna de
subida que a spec não declarava — é o que fez os dois últimos passos existirem, e ela
funcionou de primeira entre operadoras distintas.

Fecha **B31** na parte de conectividade. **Não** fecha a de medida: latência, taxa de quadros
e o teto de 8 continuam sem número (§83.6).

### 85.2 O mudo do próprio microfone era decoração

`toggleMute` chamava `voice.setSelf`, o host republicava no roster e o ícone acendia do outro
lado — e **a trilha continuava transmitindo**. Nada no renderer tocava em `track.enabled`.

§17.4 L-12 é explícita na direção contrária: silenciar OUTRO participante é conselho, mas
silenciar a si mesmo é enforcement, "quem controla o microfone é quem o possui". A metade que
faltava era justamente a efetiva. `MalhaDeVoz.definirMudo` desliga a trilha.

O mesmo valia para **ensurdecer** e para o **volume por participante**: `toggleDeafen` e
`setVolume` mexiam no store e no roster, e os elementos `<audio>` de cada par nunca eram
tocados. Agora a saída de áudio é aplicada por par, e um par que chega depois nasce já no
estado corrente — antes o áudio novo entrava sempre alto, mesmo com a chamada ensurdecida.

Também trocou a ordem: o `set` do store vem **antes** dos efeitos, porque quem aplica a saída
lê o store, e lê-lo antes devolvia o valor velho.

### 85.3 Entrar sozinho anunciava falha de conexão

O log mostra `join ok · roster 1` seguido de `FALHOU · candidatos vistos: nenhum`. O prazo de
20 s de §80 era armado no fim do `entrar` sem olhar se havia par: sozinho no canal — que é o
normal de quem chega primeiro —, ele disparava e a tela anunciava `conn-failed` para uma
chamada que nunca tentou conectar coisa nenhuma. Agora o relógio só é armado com pelo menos
um par, e ficar sozinho de novo o desarma.

### 85.4 O que NÃO era defeito

O botão de compartilhar tela não aparecer para o membro é **R-27b**, não bug: o cargo base de
gênese só admite subconjunto de `{send_messages, attach_files, add_reactions, voice_speak,
pin_messages}`, e `voice_share_screen` não está lá. Quem quiser que um membro apresente
precisa conceder por cargo. A UI estava certa ao esconder o botão.

### 85.5 Método

Os três defeitos são da mesma família de §82.3 e §84.5: superfície que existe, estado que
muda, e **nenhum efeito na ponta que importa**. Mudo que não muta, ensurdecer que não
ensurdece, prazo que mede uma conexão inexistente. Nenhum teste os pegaria, porque todos
verificariam o estado — que estava certo — em vez do efeito.

As três regressões novas foram vistas falhar com a correção desligada antes de entrar.

## 86. O participante fantasma, e os quatro defeitos que ele estava escondendo — 2026-08-26

**Gate de entrada:** §85 fechou a tela entre provedores. **Entrada:** um relato de uso —
"A desligou o computador no meio da chamada e B continuou vendo A no roster, para sempre".
**Resultado:** o defeito relatado é real e tem causa única; investigá-lo abriu quatro
defeitos irmãos no mesmo domínio, **três deles piores que o relatado**. Suítes: frontend
**255**, núcleo **899** (eram 888).

Nenhum dos cinco foi achado por teste. Todos foram achados lendo o caminho que vai da
decisão de L2 até quem a executa — e os três piores estavam exatamente **no espaço entre as
duas coisas**, que é onde nenhum teste de módulo olha.

### 86.1 O relatado: nada ligava o cabo caído ao roster

`VoiceHostSessions` tira alguém da sessão por dois caminhos: `voiceLeave` explícito e
`sweepAgainst`, a revogação derivada do log. §17.4 listava cinco gatilhos de revogação —
`mod.ban`, `mod.kick`, `mod.timeout`, `channel.delete`, `voice.leave` — e **os cinco são
registro no log**. Falta o único que não é: o par que simplesmente para de falar.

Quem desliga o computador não appenda nada, não é banido e não chama `voice.leave`. Não
havia caminho nenhum que o removesse. O `detach` da conexão, que é onde o produto percebe a
queda, só apagava a entrada do mapa de RPC:

```
detach: () => {
  if (host.connections.get(peerKeyHex) === server) host.connections.delete(peerKeyHex);
}
```

O host esquecia como falar com ele e continuava contando-o como participante.

**A assimetria é o que tornava o defeito invisível na leitura.** O *cliente* já tratava a
queda como fim de sessão: qualquer método de §16.2 que volte `E_HOST_UNAVAILABLE` zera o
`sessionId` local no `remoteMediaDispatcher`. Quem caiu **sabia** que tinha saído. Era o
host que mantinha o fantasma — e o roster é dele.

**Correção.** Duas pernas, porque uma só não cobre o caso relatado:

| Perna | Cobre | Prazo |
|---|---|---|
| `dropPeer` no `detach` do canal de §16.1 | O transporte percebeu a queda | Imediato |
| Loop `voice.liveness` de §22.1 | O transporte **não** percebeu | ≤ `VOICE_LIVENESS_MS` |

A segunda perna existe porque máquina desligada não manda FIN: o fechamento do stream pode
demorar ou não vir. A evidência de vida **não é sinal novo** — é o `hello` de §22.1, que
todo membro manda a cada 30 s em toda conexão viva e que §14.5 já usa para decidir `synced`
na direção oposta. `RpcServer` passou a marcar o instante de cada pedido recebido; o loop
derruba quem passou de `VOICE_LIVENESS_MS = 3 × P2P_HELLO_INTERVAL_MS`.

Três voltas do `hello`, e não duas: o prazo tem de tolerar um `hello` perdido, senão a
correção do fantasma vira um defeito pior — expulsar da chamada quem ainda está nela. E é
**derivado**, não uma constante nova (§27.3): um `P2P_VOICE_LIVENESS_MS` independente
permitiria configurar prazo menor que a cadência que o alimenta.

O host é isento **por construção, não por prazo**: ele participa da chamada como qualquer
membro (§17.4) e não tem conexão de si para si, então o mapa de vivacidade nunca teria uma
marca dele. Sem a linha que o isenta, o primeiro giro do loop expulsaria o host da própria
chamada. Está sob teste.

### 86.2 O pior: `sweepAgainst` nunca era chamado

Os dois módulos de mídia têm a derivação de revogação escrita, comentada e testada:

```
core/src/l2/voiceCoordinator/host.ts:401   sweepAgainst(state)  // "o host chama após cada admissão projetada"
core/src/l2/shareStar/sessions.ts:450      sweepAgainst(state)  // idem
```

O comentário diz quem chama. **Ninguém chamava.** Fora dos testes, `sweepAgainst` não
aparece uma vez em `core/src/` — nenhum assinante de `onProjected` na composição a invocava.

O que isso significa em produto: `mod.ban`, `mod.kick`, `mod.timeout`, `channel.delete` e o
fim da comunidade **não alcançavam mídia nenhuma**. Banir alguém no meio de uma chamada
tirava-o da lista de membros e deixava a `RTCPeerConnection` dele aberta com todo mundo até
o ticket expirar em cinco minutos — e §17.4 diz, com todas as letras, que "em v1 a sessão
direta sobrevivia ao ban indefinidamente; em v2 ela morre por revogação ativa". A revogação
ativa não existia. §19.8 inteiro — "excluir canal com chamada acontecendo" — era papel: a
chamada continuava dentro de um canal com tombstone. A coluna "tickets revogados" de §18.1
descrevia um efeito que não acontecia.

Este é o defeito que o relato não pedia e que era três ordens pior que ele: o fantasma
custava uma linha errada na UI; este custava a propriedade de segurança que a seção diz
fechar (`T-32`).

**Correção.** Um assinante de `onProjected` por comunidade hospedada roda as duas derivações
contra o `DecisionState` do lote. É onde o comentário já dizia que deveria estar.

### 86.3 A revogação ia só para o alvo

§17.4 é explícita — "o host emite `voice.revoked{targetKey, sessionId}` **a todos os
participantes**. Ao receber, cada cliente é obrigado a fechar imediatamente a
`RTCPeerConnection` com aquela chave" — e a composição mandava só ao alvo:

```
empurra('voice.revoked', { targetKey: t.targetKeyHex, ... }, [t.targetKeyHex]);
```

Quem tem de fechar a conexão é **quem fica**: o alvo fechar a própria não retira mídia de
ninguém. Entregue só ao alvo, a malha dos outros continuava aberta com quem acabou de ser
banido. O renderer já sabia lidar com a revogação de terceiro desde §77 — o evento é que
nunca chegava a ele.

Junto com isso, dois buracos menores da mesma família: o laço de revogação de
`sweepAgainst` removia o participante **sem emitir roster novo** (`leave` emitia; o sweep,
não), então quem ficava não via a lista mudar; e `voice.failed{reason}`, que §19.8 exige e
§15.5 declara, não era emitido por ninguém — e não podia ser, porque a tabela **fechada** de
§16.3 não listava o tópico e a regra 2 manda descartar em silêncio o que não está nela.

**Correção.** `RevokedTarget` passa a carregar `recipients` (a sessão no instante da
remoção, alvo incluído) e `reason` (`left`, `peer-gone`, `moderation`, `channel-deleted`,
`community-ended`). Só L2 sabe quem estava na chamada naquele instante; o fan-out continua
sendo da composição. `voice.failed` entrou em §16.3 e é emitido nos encerramentos de sessão
inteira.

### 86.4 A tela sobrevivia à chamada que a contém

§17.5 e A19 dizem que espectador é participante do canal de voz e que **não existe audiência
fora da chamada**. A regra era aplicada no `share.start` e no `share.join`, e só ali.
Depois disso ninguém reconferia.

Consequência: quem apresentava e saía da chamada — por `voiceLeave` ou pela queda de §86.1 —
deixava a sessão de tela viva no host **para sempre**. Os espectadores continuavam
autorizados, com ticket válido, para uma transmissão que não existe; e o
`E_ALREADY_SHARING` de "exatamente 1 sessão por canal" (delta U-10) trancava o canal para
qualquer outro apresentador. Só `channel.delete` ou o fim da comunidade a matavam — e, por
§86.2, nem isso.

**Correção.** `ShareHostSessions.sweepAgainst` passa a consultar o roster da voz junto com o
estado estrutural, e roda **a cada mudança do roster** além de a cada lote projetado. A
porta que dá o roster ao módulo de tela (`voiceParticipants`) já estava injetada desde a
fase 8: o que faltava era consultá-la.

### 86.5 Ordem, e o único lugar onde ela importa

§14.3(3) manda o lote que aplicou o ban **fechar o canal do banido**. Com §86.1 no lugar,
isso significa que uma moderação também chega ao `detach` — e o motivo certo ali é
`moderation`, não `peer-gone`. Depender da ordem em que os assinantes de `onProjected` correm
seria frágil, então o `detach` deriva do log **antes** de tratar a queda como queda. O motivo
sai certo dos dois lados sem coordenação entre os assinantes.

### 86.6 O que mudou no código

| Arquivo | Mudança |
|---|---|
| `l2/voiceCoordinator/host.ts` | `RevocationReason` e `recipients` em `RevokedTarget`; `dropPeer` e `sweepLiveness`; `#remove` único para `leave`/queda/moderação — os três removiam do mesmo jeito e só dois emitiam roster |
| `l2/shareStar/sessions.ts` | `sweepAgainst` consulta o roster da voz: apresentador fora da chamada encerra, espectador fora deixa de ser audiência |
| `l3/rpcServer/index.ts` | `onRequest` (marca de vivacidade) e `voice.failed` na tabela fechada de §16.3 |
| `l3/rpcClient/index.ts` | `voice.failed` na cópia da tabela (a paridade é conferida por teste) |
| `composition/boot.ts` | `sweepAgainst` ligado ao lote projetado; `voice.revoked` a `recipients`; `voice.failed` nomeado; `vistoEm` por par; `dropPeer` no `detach`; conciliação da tela a cada roster |
| `composition/jobs.ts` | Loop `voice.liveness` e `VOICE_LIVENESS_MS` derivado de `DEFAULT_HELLO_MS` |

### 86.7 Evidência

Onze regressões novas (888 → 899), todas vistas falhar com a correção desligada antes de
entrar:

- **`test/voice-host.test.ts`** — queda tira do roster com `reason:'peer-gone'`, revoga a
  quem ficou e recusa renovação de ticket; queda de quem estava sozinho zera a ocupação;
  `sweepLiveness` derruba só quem o predicado não vê e é idempotente na segunda volta; o
  sweep de moderação emite roster novo a quem fica; `channel.delete` nomeia o motivo e
  endereça o lote inteiro.
- **`test/media-share.test.ts`** — apresentador que sai da chamada encerra a sessão;
  espectador que sai deixa de ser audiência e a sessão continua; chamada desfeita encerra a
  tela junto.
- **`test/voz-ciclo-de-vida.test.ts`** (novo) — o nível onde os defeitos moravam: núcleo
  real, comunidade hospedada, chamada aberta por IPC. `channel.delete` encerra a sessão e
  emite `voice.failed{reason:'channel-deleted'}`; o fim da comunidade idem; o loop
  `voice.liveness` tem corpo e **não** expulsa o host da própria chamada; a cadência e o
  prazo saem da evidência que os alimenta.

Com a ligação de §86.2 desativada, as duas primeiras do arquivo novo falham — foi assim que
o defeito foi confirmado como ligação ausente, e não como decisão errada de L2.

### 86.8 Método — por que nenhum teste pegou

`sweepAgainst` tinha cobertura boa **do que ele decide**. O que nenhum teste tinha era quem
o chama. É a família de §82.3, §84.5 e §85.5 vista de outro ângulo: lá era superfície que
existe e efeito que não acontece na ponta; aqui é **decisão que existe e ninguém executa**.
Um teste de módulo não consegue ver isso por construção — ele chama a função, e a função
funciona.

O arquivo novo é a resposta: o rig sobe o núcleo de verdade e mexe no log pela IPC, de modo
que quem tem de chamar a derivação é o produto, não o teste. É o mesmo argumento de §59
sobre o smoke, aplicado dentro da suíte.

E vale registrar a assimetria de §86.1 como sintoma a procurar: **os dois lados de um
protocolo discordarem sobre o mesmo fato** — o cliente sabendo que saiu, o host achando que
ele está — é a assinatura de um estado que só um dos lados sabe corrigir. A pendência
espelhada dessa mesma assimetria (o cliente que esquece a sessão em silêncio quando o host
some, sem contar ao renderer) ficou registrada no backlog, porque a resposta depende de uma
decisão que a spec não tem.

### 86.9 Os quatro irmãos menores — abertos na primeira volta, fechados na segunda

Quatro coisas apareceram na investigação e ficaram de fora do primeiro commit: três porque
a resposta parecia depender de decisão que a spec não tem, uma porque era trabalho fora do
caminho do defeito relatado. Foram registradas como B33–B36 com a solução proposta, e o
operador mandou corrigi-las.

**Os quatro fecharam.** A releitura mostrou que a pendência de decisão de B33 era menor do
que parecia — ver abaixo. O que segue é o problema de cada um e o que ficou; a resolução
está em §86.10.

**B33 — a queda do HOST não conta ao renderer que a chamada acabou.** É §86.1 espelhada, e
é o achado mais incômodo dos quatro. Quando o host some, o `remoteMediaDispatcher` zera o
`sessionId` local no primeiro `E_HOST_UNAVAILABLE` — e em silêncio. Nada avisa o renderer:
a UI segue exibindo a chamada e a malha WebRTC segue de pé enquanto o núcleo **já se
considera fora dela**. É a mesma discordância entre os dois lados sobre o mesmo fato, só
que agora dentro de uma instalação.

*Solução proposta:* emitir `voice.failed{reason:'host-unavailable'}` no ponto exato em que a
sessão local é esquecida. O evento existe (§15.5), o campo existe, e o renderer já tem o
caminho de encerramento (`encerradaPeloHost`, usado hoje pela revogação do próprio alvo).

*Pendência — e é de política, não de código:* §17.4 não diz se um blip de conexão de §16.1
deve **encerrar** a chamada ou se o membro deve **reentrar sozinho** quando o canal voltar.
Hoje o núcleo já encerra no primeiro erro, então emitir o evento apenas torna visível o que
já acontece — é correção honesta e pequena. Decidir o contrário (reentrada automática) é
mudança de comportamento, mexe na relação com `voice.join` idempotente e merece emenda
própria. Não foi feito porque escolher em silêncio seria fechar a decisão pelo caminho
errado.

**B34 — `voice.failed` chega e ninguém o escuta.** §86.3 pôs o host a emitir o encerramento
nomeado e a tabela de §16.3 a carregá-lo; o renderer não tem assinante para o tópico. Na
prática a chamada acaba certo — o `voice.revoked` do mesmo lote encerra —, mas sem dizer
por quê.

*Solução proposta:* assinar `voice.failed` em `sincronizacao.ts` e mapear `reason` para o
estado de erro da chamada. *Pendência:* o texto que o usuário lê para cada motivo é decisão
de produto e mora em `deltas-ux-v2.md`. Inventar cópia de UI aqui seria criar norma onde não
há — o mesmo motivo pelo qual §85.4 não "consertou" o botão de tela escondido.

**B35 — `voice.occupancyChanged` não coalesce.** §17.6 declara "emitido a cada mudança,
**coalescido em 1 s**". O host emite a cada mudança de roster, sem janela nenhuma, e o
destino é toda a comunidade conectada. A correção de §86.1 torna isso um pouco mais quente:
uma desconexão em massa (host que volta, varredura pegando vários de uma vez) emite um
evento por participante. Não é regressão — a janela nunca existiu —, mas passa a ter mais
ocasiões de aparecer.

*Solução proposta:* janela de 1 s por canal, colapsando para o último estado. *Pendência:*
nenhuma de spec; é trabalho, e estava fora do caminho do defeito relatado.

**B36 — `ShareHostSessions.onRevoked` é callback morto.** O módulo de tela emite revogação
de espectador desde a fase 8 e a composição nunca ligou o callback. Quem perde autorização
para assistir não recebe sinal nenhum — só `share.viewersChanged`, que leva a contagem e
vai aos da chamada. §86.4 não precisou dele (o encerramento de sessão inteira sai por
`share.stopped`), então ficou de pé.

*Solução proposta:* ligar a `share.failed{sessionId, reason}` (§15.5) endereçado ao alvo.
*Pendência:* confirmar que isso não colide com o uso que o apresentador faz do mesmo tópico
— §15.5 declara `share.failed` sem dizer quem é o destinatário, que é a mesma omissão que
`RT-08` fechou para `share.health`.

### 86.10 A segunda volta: os quatro fechados

**B33 — a queda do host deixa de ser silenciosa.** `remoteMediaDispatcher` ganhou
`onSessionLost`, chamado no ponto exato em que a sessão local é esquecida, e a composição o
liga a `voice.failed{reason:'host-unavailable'}`.

A pendência registrada era de política — "um blip de §16.1 deve encerrar a chamada, ou o
membro deve reentrar sozinho?" — e a releitura mostrou que ela **não bloqueava esta
correção**: o núcleo já encerrava no primeiro `E_HOST_UNAVAILABLE`, desde sempre. Emitir o
evento não escolhe política nenhuma; torna visível o que já era o comportamento. A escolha
sobre reentrada automática continua aberta e ficou dita em §17.4, no parágrafo que declara o
que aquela emenda **não** decide — que é o lugar certo para uma decisão adiada, e não o
backlog.

Uma distinção importa e está no código: só `E_HOST_UNAVAILABLE` dispara o aviso.
`E_SESSION_GONE` é o host **respondendo** que a sessão acabou, e esse caminho já tem
`voice.revoked`. Anunciar duas vezes o mesmo encerramento faria duas superfícies competirem
pela mesma tela.

**B34 — o encerramento nomeado chega à tela.** `sincronizacao.ts` assina `voice.failed` e
`share.failed`. A tradução de `reason` para frase segue o padrão que já existia em §80
(motivo nomeado escrito onde a falha é detectada, exibido pelo `StatusBanner` de
`stage:"failed"`) — nenhuma superfície nova, nenhum texto inventado para motivo
desconhecido, que cai na frase genérica pela mesma disciplina de §16.3 regra 2.

O que **não** era óbvio: `voice.failed` e `voice.revoked` são o mesmo encerramento chegando
em dois quadros. O `voice.revoked` do próprio alvo derruba a chamada na tela, e uma chamada
derrubada não tem mais onde mostrar o porquê — o overlay desmonta junto. Duas coisas
resolvem isso, e as duas foram precisas:

1. `encerradaPeloHost` aceita motivo opcional. Com motivo, a chamada acaba **e o overlay
   fica**, em `stage:"failed"`, que é a única superfície que carrega o porquê. Sem motivo,
   preserva o que já foi entregue em vez de zerar — quem chega depois não apaga quem chegou
   antes.
2. O host emite `voice.failed` **antes** das revogações. §16.3 não garante ordem, mas os
   dois saem do mesmo callback síncrono, então a ordem é escolha nossa; e a ordem certa é a
   que entrega o motivo enquanto ainda há onde mostrá-lo.

**B35 — a coalescência que §17.6 declarava passa a existir.** Janela de
`VOICE_OCCUPANCY_COALESCE_MS` por canal, de **borda de ataque**: a primeira mudança sai na
hora, as seguintes esperam o fim da janela e sai só o último estado. Atrasar em um segundo o
avatar de quem acabou de entrar seria trocar um defeito por outro, e ocupação é **nível**,
não sequência — quem chega no meio da janela só precisa do valor final.

A borda de ataque também é o que torna o comportamento testável com o agendador no-op do
rig: sem relógio nenhum, a primeira sai e a segunda fica retida, que é precisamente a
afirmação a fazer.

**B36 — o espectador revogado passa a saber.** O `onRevoked` do módulo de tela estava de pé
desde a fase 8 sem ninguém do outro lado. A composição o liga a
`share.failed{sessionId, reason:'revoked'}`, endereçado **só ao alvo**, e o tópico entrou na
tabela fechada de §16.3 — sem isso ele seria descartado em silêncio pela regra 2, que é
exatamente o que acontecia com `voice.failed` em §86.3.

### 86.11 Evidência da segunda volta

Seis regressões novas (899 → 902 no núcleo, 255 → 258 no frontend):

- **`test/voz-ciclo-de-vida.test.ts`** — B35: a primeira mudança de ocupação sai na hora com
  `count` e `firstKeys` certos, a segunda fica retida na janela, e a saída em si **não** é
  retida (o que se coalesce é o aviso, nunca a decisão). B33: o dispatcher de membro anuncia
  `host-unavailable` uma vez, não repete quando já não há sessão, e **não** anuncia em
  `E_SESSION_GONE`.
- **`test/media-share.test.ts`** — B36: a revogação de um espectador nomeia o alvo e não
  encerra a sessão.
- **`src/live/__testes__/chamada-encerrada.test.ts`** (novo) — B34: sem motivo a chamada some
  da tela; com motivo o overlay fica para mostrá-lo; e o `voice.revoked` do mesmo
  encerramento não apaga o motivo já entregue. Este último foi verificado por mutação —
  trocar `motivo ?? state.motivoDaFalha` por `motivo` o derruba, que é o defeito de a
  chamada evaporar sem explicação.

### 86.12 O que os oito defeitos tinham em comum

Somando as duas voltas: cinco defeitos na primeira, quatro na segunda (B33–B36), e **sete
dos nove são a mesma coisa** — uma ponta declarada, escrita e testada, e ninguém do outro
lado.

`sweepAgainst` decidia e ninguém chamava. `onRevoked` da tela emitia e ninguém escutava.
`voice.failed` era exigido por §19.8, declarado em §15.5 e não estava na tabela que o
carregaria. `share.failed` idem. A sessão local do membro morria sem contar a ninguém. A
coalescência de §17.6 estava escrita na tabela e não no código.

Nenhum teste de módulo pega essa família por construção: ele chama a função, e a função
funciona. O que a pega é um teste que sobe o produto e mexe nele pela borda — o `.request`
da IPC, o `runNow` do loop —, obrigando **o produto** a ser quem chama. Foi o que o arquivo
novo passou a fazer, e é o que explica por que 899 testes passavam sobre um host que não
revogava nada.

A regra prática que sai daqui: **um callback opcional com default no-op é um lugar onde um
defeito pode morar em silêncio para sempre.** Os três desta fatia (`onRevoked` da tela,
`onSessionLost`, e o próprio `sweepAgainst` sem chamador) tinham a mesma forma — a ausência
de ligação é indistinguível da ligação correta, do lado de dentro.

## 87. Os controles da tela voltam para quem transmite, e o canal deixa de ter uma tela só — 2026-08-26

**Gate de entrada:** §86 fechou o ciclo de vida da chamada. **Entrada:** dois relatos do
operador — os controles de resolução e FPS aparecendo para quem só assiste, e a pergunta
"por que não pode mais de uma pessoa compartilhar no mesmo canal?". **Resultado:** os dois
eram a mesma família — regra herdada de documento, não de engenharia. Suítes: frontend
**266** (eram 255), núcleo **906** (eram 899).

### 87.1 O comando de qualidade estava no papel errado

§17.5 dava a `share.setQuality` o papel de **espectador** ("quem pede um perfil é quem
assiste"), e o próprio ciclo de cinco passos da seção mostra por que isso não fecha: o passo
5 aplica o perfil no `maxBitrate` do sender **do apresentador**. Não existe "ajustar a
própria recepção" em estrela — o que se ajusta é o que sai da máquina de outra pessoa.

Oito espectadores pedindo `high` são 20 Mbps de subida numa máquina que não tinha como
recusar, e a seção **reconhece esse custo duas linhas abaixo**, em "por que 8 e não 200". A
conta estava escrita; o comando é que estava do lado errado dela.

Havia ainda a metade inerte: para quem apresentava, `setQuality` só mexia no estado local
(`set({ share: { ...share, quality } })`) e **nada tocava os senders**. Era o rótulo mudando
sem efeito, a família de §85.2.

**Correção.** O papel vira apresentador em `ShareHostSessions.setQuality`: o comando redefine
a **base da sessão** e realinha todos os espectadores (é teto novo, não ajuste de um), e
espectador recebe `E_PERMISSION_DENIED`. No renderer, `definirQualidade` passou a fazer as
duas metades — registrar no host **e** aplicar `definirBitrateKbps` em cada envio vivo, sem
esperar o tique de saúde.

**O que não mudou:** a degradação automática por perda continua do sistema, por espectador e
só para baixo. É ela que protege quem assiste numa conexão ruim, e nunca precisou de comando.

### 87.2 Resolução e FPS não existiam — e não precisavam de protocolo

O relato falava de "resolução e FPS aparecendo para o espectador". Eles não apareciam: não
existiam em lugar nenhum — nem em §17.5, que define três perfis em kbps e mais nada, nem no
núcleo, nem no contrato de IPC. O que aparecia para os dois papéis era o seletor de
qualidade.

Implementá-los **não exigiu protocolo novo**. Resolução e taxa de quadros são da *captura*:
`applyConstraints` sobre a trilha que a máquina do apresentador captura, da mesma natureza
que `track.enabled` é o mudo efetivo de §17.4 L-12. **Quem possui o dispositivo decide o que
sai dele; o host decide quem pode receber.** Não há decisão de host a tomar sobre o que uma
pessoa escolhe capturar da própria tela.

Um detalhe que virou regra: o valor exibido vem de `getSettings()` da trilha, **nunca do que
foi pedido**. A fonte aproxima ou ignora a restrição, e mostrar "720p" porque foi o que
pedimos seria inventar medida — o mesmo princípio dos `rttMs` omitidos de §83.

### 87.3 O espectador ganha um controle, e é só um

Ocultar o vídeo recebido. Local, reversível, e deliberadamente **não** implementado como
`share.setQuality` para `low` nem como `share.leave`: os dois alcançariam a transmissão de
outra pessoa, e este botão é sobre a tela de quem o aperta. Soltar o `srcObject` é o que de
fato para a decodificação — esconder por CSS continuaria decodificando quadro a quadro para
ninguém.

O lugar do vídeo diz por que está vazio: "Vídeo oculto — {apresentador} continua
transmitindo, só você deixou de ver". A frase existe para que ninguém leia o próprio botão
como "pausei a transmissão".

### 87.4 "Uma sessão por canal" era uma contradição resolvida, não uma restrição

A pergunta do operador tinha resposta curta e desconfortável: **porque três documentos
discordavam e a resolução escolheu o que já estava escrito.**

`RT-06`, no parecer do ARB: *"UX exige múltiplos compartilhamentos, backend fixa 0..1 e mock
não implementa"*. O delta U-10 registrou como justificativa "o requisito estava na UX, era
impossível no backend e já tinha sido declarado fora pela própria implementação" — e "era
impossível no backend" é circular: o backend fixava `0..1` porque fixava `0..1`. A19 herdou
a frase "Uma sessão por canal" sem argumentar por ela; o que A19 sustenta é a **estrela** e o
**teto de 8**, que são por sessão.

Não havia restrição por baixo, e três fatos bastam:

| | |
|---|---|
| **Transporte** | A voz é malha completa: existe uma `RTCPeerConnection` entre cada par, e a trilha de tela **pega carona nela** (`enviarTrilha` faz `par.pc.addTrack`). Um segundo apresentador não abre malha nova |
| **Upload** | Não compõe. Cada apresentador serve a própria estrela, da própria máquina |
| **Teto de 8** | É `SHARE_MAX_VIEWERS` **por sessão**. Duas sessões são duas estrelas independentes |

**Correção.** `ShareHostSessions` passou a indexar por `sessionId` em vez de `channelId`;
`sessionOf(channelId)` virou `sessionsOf(channelId)`, plural e ordenado por quem começou
primeiro. No renderer, `share: ActiveShare | null` virou `shares: ActiveShare[]`, e o overlay
empilha um palco por transmissão — uma ocupa a área inteira, duas ou mais viram grade, que é
a "grade de tiles grandes" que §18 pedia desde o começo.

`ActiveShare` ganhou `sessionId` (com várias vivas, "a sessão" não identifica mais nada) e
`oculto` **por sessão**: com duas telas no canal, esconder uma não diz nada sobre a outra.

**O que sobrou de `E_ALREADY_SHARING`** é o teto que é real: **uma por apresentador por
canal**. Não é regra de protocolo — é o renderer. A captura de tela de uma instalação é uma
só, e a segunda sessão da mesma pessoa nasceria sem stream para alimentá-la.

Um defeito que só apareceu na travessia: `aoChegarVideo` descartava a trilha quando o
remetente não era "quem apresenta a sessão viva", no singular. Com duas telas, a segunda era
descartada em silêncio. Agora a trilha é atribuída à sessão **de quem a mandou**.

### 87.5 O que NÃO foi feito, e por quê

**Não entrou teto de transmissões simultâneas.** O custo real de várias telas é do lado de
quem assiste: download e decodificação multiplicam — duas em `high` são 5 Mbps de descida e
dois decodificadores por participante. Isso é limite de máquina, não de protocolo. `MAX_CAMERAS`
existe como precedente de teto desse tipo, mas escolher um número aqui seria anunciar medida
que ninguém tomou, e §17.5 é silenciosa. Ficou registrado no backlog com a proposta.

**Não foram reescritas as auditorias históricas.** `rastreabilidade-ux-backend.md` e o
parecer do ARB continuam registrando `RT-06` como foi encontrado — eles são o registro de
**o que era verdade naquele momento**, e não têm precedência normativa (CLAUDE.md). Corrigir
um achado de auditoria para casar com a decisão de hoje apagaria a razão pela qual a decisão
existiu. Quem muda são os normativos, e mudaram: `backend-v2.md` §17.5, `adr-v2.md` A19,
`deltas-ux-v2.md` U-10 (revogada), `frontend.md` e `resolucao-arquitetural-v2.md`.

### 87.6 Documentos corrigidos

| Documento | O que saiu |
|---|---|
| `backend-v2.md` §17.5 | "Sessões por canal: exatamente 1" → "quantas houver, uma por apresentador"; o papel de `share.setQuality`; resolução/FPS e o controle do espectador declarados |
| `backend-v2.md` §15.4 | A coluna de papel de `share.setQuality` dizia "espectador" |
| `backend-v2.md` §20.2 | `E_ALREADY_SHARING` dizia "já há compartilhamento no canal" |
| `adr-v2.md` A19 | A frase "Uma sessão por canal", herdada de `RT-06` e não decidida ali |
| `deltas-ux-v2.md` | **U-10 revogada**; U-25 acrescentado (papéis dos controles); V-13 e V-19 emendados |
| `frontend.md` | A observação "compartilhamentos simultâneos não entraram" e a "Qualidade é de quem assiste", cuja premissa era falsa |
| `resolucao-arquitetural-v2.md` | "múltiplos compartilhamentos simultâneos" saiu da lista de escopo cortado |

### 87.7 Evidência

Treze regressões novas. Núcleo (`media-share.test.ts`): duas pessoas apresentam no mesmo
canal com sessões independentes — perfil de uma não alcança a outra, parar uma não encerra a
outra, `captureToken` de uma não autoriza a outra; quem assiste uma pode apresentar a sua; e
o teto que sobrou é por apresentador. O papel do perfil: apresentador redefine a base e
realinha, espectador recebe `E_PERMISSION_DENIED` sem efeito colateral, e a degradação
automática continua por espectador a partir da base nova.

Frontend (`tela-controles.test.ts`): qualidade e captura não saem da máquina de quem assiste;
o rótulo só muda quando o host aceita; a captura guarda o que a **fonte** entregou, não o que
foi pedido; ocultar não chama nada da porta e não encerra a sessão; ocultar é por sessão e
não se herda; parar uma transmissão não encerra a outra.

Verificado por mutação: remover o `if (share.presenterId !== localId) return;` de
`setQuality` derruba o caso do espectador — que é exatamente o defeito relatado.

### 87.8 Método

Os dois relatos desta fatia eram **regra herdada de documento**, não decisão tomada. O
seletor de qualidade no espectador vinha de uma observação de build que raciocinou errado
("ajustar a própria recepção não afeta ninguém") e ninguém releu contra §17.5. A sessão única
por canal vinha de uma contradição resolvida por precedência, e a justificativa que ficou no
papel era circular.

É uma família diferente da de §86 — lá o defeito era ligação ausente; aqui é **premissa
nunca reexaminada**. O sintoma a procurar é o mesmo em ambos: uma frase normativa cuja
justificativa, lida hoje, não sustenta a regra. Quando a razão escrita é "os documentos
discordavam", a regra não foi decidida — foi herdada.

### 87.9 O seletor da transmissão vira menu

A primeira volta entregou os controles como três `fieldset` de pílulas num popover. Funciona
e lê mal: quem apresenta mexe nisso **no meio de uma conversa**, com a grade da chamada
atrás, e três blocos empilhados de pílulas exigem varrer a tela inteira para achar uma linha.

A forma certa é **menu**: lista densa de linhas clicáveis, no mesmo idioma do `Menu` de §6 —
`text-body-emphasis` no rótulo, `text-meta text-text-tertiary` na descrição, divisores de
`border-subtle`, destrutivo em `feedback-danger`. As classes são literalmente as dele, para
que os dois não divirjam com o tempo.

Três decisões de desenho valem registro:

**Os modos vêm antes dos números.** Ninguém quer "720p a 30 fps" — quer que o movimento não
trave, ou que o texto fique legível. `Movimento` (720p · 30 fps · equilibrada) e `Leitura`
(1080p · 15 fps · alta) nomeiam a intenção e resolvem os três valores de uma vez;
`Personalizado` abre os números para quem tem motivo para discordar. É a única linha desta
tela que não pede ao usuário que traduza intenção em número.

**Resolução e quadros abrem em drill-down, não em submenu lateral.** O popover já está
ancorado num botão que pode estar perto da borda; um segundo nível flutuante teria de
resolver colisão de viewport de novo. Trocar o conteúdo com um "voltar" que também nomeia
onde se está tem o mesmo alcance e nenhuma dessas arestas.

**Não entrou interruptor de "qualidade adaptável".** A referência de mercado tem um; o nosso
não pode ter, porque a degradação por perda de §17.5 é do sistema, só desce e **não tem
comando para desligar**. Oferecer a chave seria prometer um controle que não existe — a
mesma regra que tirou o badge "Via TURN" desta tela em B26. O comportamento é dito em texto,
onde o perfil é escolhido, para que "voltar sozinho" não pareça defeito.

"Parar compartilhamento" subiu para o topo do menu, como ação destrutiva separada por
divisor. Ela continua também no botão vermelho do palco: é a ação mais frequente da tela e
não deve exigir abrir menu.

## 88. Voz e tela medidas em uso real: B28 e B31 fechados pelo operador — 2026-08-26

**Entrada:** o operador exercitou voz e tela entre máquinas em uso normal e reportou o
resultado. **Resultado:** **B28 e B31 fechados.**

### 88.1 A medida

| O que | Resultado |
|---|---|
| Latência | **9 ms** |
| Voz | Boa em uso real |
| Tela | Boa em uso real |

Os dois itens existiam pela mesma razão: §82 e §85.1 provaram que a chamada e a tela
**fecham** entre provedores diferentes, e nenhum dos dois deu número — os únicos que
existiam eram os de G8, medidos em localhost, que não dizem nada sobre rede real. Era o
buraco entre "conecta" e "presta", e ele está preenchido.

Nove milissegundos é o que o desenho previa. §17.5 declara "sub-segundo, como qualquer
WebRTC direto", e a razão de a estrela ter substituído a árvore em A19/A20 foi justamente
não pagar o 1–2 s de latência por nível. A medida confirma a premissa da decisão, não só o
funcionamento do código.

### 88.2 O que este fechamento é, e o que não é

É **evidência de operador em uso real**, da mesma classe que fechou §82 (voz entre
provedores) e §85.1 (tela entre provedores) — e é a classe de evidência que mais achou
defeito neste projeto: os nove defeitos de §86 e §87 saíram todos de uso e releitura, nenhum
de teste.

Não é medição instrumentada: perda, CPU e o comportamento com oito espectadores de verdade
continuam sem número. Isso **não reabre os itens** — eles perguntavam se voz e tela prestam
em rede real, e a resposta veio. Os `openCriteria` de G7/G8 continuam onde estavam, em **B4**,
que é o item que trata de veredito de gate e pede Electron empacotado, `tc/netem` e CGNAT
real. É lá que a instrumentação vive; duplicá-la aqui criaria a segunda cópia a envelhecer.

## 89. A oferta que chegava antes do ticket, e a sala que só quem hospeda via — 2026-08-26

**Entrada:** o operador reportou que a voz "às vezes não conecta" e que **só quem hospeda vê
quem está dentro da sala**, com o log das duas pontas de uma chamada que falhou.
**Resultado:** dois defeitos de produto e três achados no caminho, todos fechados.

### 89.1 O log dizia a coisa toda, nas duas pontas

O log é o caso raro em que as duas metades de um defeito distribuído aparecem lado a lado:

```
membro:  join ok · roster 1
membro:  microfone ok · autorizado a falar com 0 par(es) []
membro:  roster do host (2) ['1b1d1117', 'de53983d']
membro:  par 1b1d1117 · aguardando oferta (SEM TICKET — o host não pareou nós dois)
membro:  tickets renovados · 1 par(es) autorizado(s)
membro:  FALHOU · candidatos vistos: nenhum

host:    microfone ok · autorizado a falar com 1 par(es) ['de53983d…']
host:    par de53983d · oferta enviada
host:    FALHOU · candidatos vistos: host, srflx
```

O membro entrou **primeiro**, sozinho: `voiceJoin` devolve ticket por par do roster, e não
havia par — daí `0 par(es)`. Quando o host entrou, o roster novo saiu para os dois; o host,
que recebeu o ticket dentro do próprio `voiceJoin`, ofertou na hora. O núcleo do membro
ainda estava buscando os tickets dele e **descartou a oferta em silêncio**, como §17.4 passo
3 manda (falha fechada). Um segundo depois o ticket chegou — `tickets renovados` — e não
havia mais nada para destravar: pela regra anti-glare quem oferta é um lado só, e ele já
tinha ofertado. `candidatos vistos: nenhum` do lado do membro é a assinatura disso: sem
descrição local, não há coleta.

### 89.2 Os dois defeitos de produto

**A oferta perdida não voltava (§17.4).** É corrida de entrada, não de rede: os tickets de
um par só existem depois que os dois estão no roster, e cada lado busca os seus por conta
própria. O iniciador agora **repete a oferta** enquanto não houver resposta e **reenvia com
ela os candidatos ICE já coletados** — trickle manda cada candidato uma vez e a coleta não
recomeça, então uma oferta refeita sem eles seria respondida sem endereço nenhum para
testar. Do outro lado, sinalização recusada por falta de ticket deixou de ser só descarte:
ela **puxa a renovação na hora**, com piso de tempo porque o gatilho vem da rede.

**`voice.occupancyChanged` não estava na tabela fechada de §16.3.** §15.5 e §17.6 sempre
mandaram a ocupação a todos os membros conectados — é o que alimenta os avatares inline da
sidebar (`RT-05`) —, mas a tabela de §16.3 não a listava, e pela regra 2 o tópico morria no
`notify` do host. A ocupação nunca saía da máquina de quem hospeda: para todo mundo que não
hospedava, a sala de voz aparecia **sempre vazia**, mesmo com gente dentro. `query.structure`
não tem produtor de ocupação fora do host (§15.6), então não havia caminho alternativo.

Terceira ocorrência da mesma omissão, depois de `voice.failed` (§86) e `share.failed` (§86).
A forma do defeito é sempre a mesma: evento declarado em §15.5, produzido pelo host, sem
linha na tabela de §16.3 — e o silêncio da regra 2 é justamente o que o esconde.

### 89.3 Os três achados do caminho

**Ocupação é nível, não sequência.** Só emiti-la por mudança de roster deixava quem abre o
aplicativo com uma chamada em curso vendo a sala vazia até alguém entrar ou sair. A conexão
de um membro passa a levar o **instantâneo** das sessões vivas.

**`failed` era tratado como sentença.** O prazo de L-11 é um veredito sobre o que se sabia
aos 20 s. Com a oferta repetida, a chamada pode fechar depois disso — e o store não voltava
de `failed` para `connected`, então a tela diria que falhou com o áudio já tocando. É a
mentira de "Conectando…" para sempre, ao contrário.

**Candidato remoto antes da descrição remota.** `addIceCandidate` sem descrição remota é
erro de estado, e a promessa recusada não tinha quem a pegasse — o evento entra por
`void aplicarSinal(...)`. Agora espera pela descrição e entra na ordem. No caminho, o membro
deixou de pedir ao host um ticket **de si para si** (o roster inclui quem pergunta), que era
uma ida e volta à frente do ticket que importa, dentro da janela em que a oferta do outro
lado estava sendo descartada — e `firstKeys` passou de 3 para os 5 que §7/§17.6 declaram.

### 89.4 O que isto não fecha

Não fecha **B30**: NAT simétrico dos dois lados continua sem caminho, e a resposta da spec
continua sendo o relay voluntário de §17.7. O defeito daqui era anterior ao ICE — a
negociação nem chegava a testar endereço. `candidatos vistos: host, srflx` do lado do host
mostra que havia endereço público de sobra; o que faltava era com quem parear.

## 90. Os tetos de ocupação saem: nenhum deles media máquina — 2026-08-26

**Entrada:** o operador perguntou se dava para remover os limites de pessoas em chamada e de
compartilhamento de tela, do código e dos normativos. **Resultado:** os três tetos de
ocupação removidos; o teto por canal, escolhido por quem administra, aberto como **B38**.

### 90.1 O que saiu

| Constante | Valor | Erro que a acompanhava |
|---|---|---|
| `MAX_VOICE_PARTICIPANTS` | 24 | `E_VOICE_FULL` |
| `SHARE_MAX_VIEWERS` | 8 | `E_SESSION_FULL` |
| `MAX_CAMERAS` | 6 | `E_CAMERA_LIMIT` |

Os três eram **números de política, não invariantes**: nada no `fold` dependia deles, o log
nunca os carregou, e quem os aplicava era o host, na sessão efêmera. Sair foi mecânico — as
constantes chegavam por injeção da composição, exatamente para não amarrar L2 ao `fold`, e
essa costura é o que tornou a remoção uma edição em vez de uma refatoração.

Os três códigos de erro saíram do catálogo de §20.2 junto (85, eram 88). Código sem produtor
é superfície declarada que ninguém alcança — a forma de defeito que §86 e §89 fecharam três
vezes —, e deixá-los como letra morta seria plantar a quarta.

### 90.2 Por que um número fixo não era o limite

O custo é de **máquina**, e nenhum dos três números mede máquina nenhuma.

A voz é malha: cada participante mantém uma `RTCPeerConnection` por par, então o custo por
máquina cresce com N e o custo na comunidade cresce com N². Vinte e quatro não é onde isso
quebra — é onde alguém escreveu que quebraria.

A tela é estrela, e o limite inteiro é o **upload de quem apresenta**: oito espectadores em
`high` são 20 Mbps de subida. Numa conexão que tem 40, o teto recusava metade da audiência
que caberia; numa que tem 10, ele deixava entrar oito e a transmissão degradava assim mesmo.
O número errava nas duas direções, que é o que se espera de uma constante que não olha para
a rede.

Quem olha para a rede já existe e já roda: a degradação por `share.health` (§17.5) lê perda
e RTT **por espectador** e desce o perfil de quem está mal, sem tocar em quem está bem. É a
resposta certa para a mesma pergunta, e ela é medida.

### 90.3 O que isto custa, e é honesto dizer

Recusa nomeada é melhor que degradação silenciosa — é a regra que este projeto aplicou em
L-11 (§80), quando trocou "Conectando…" para sempre por `conn-failed` com motivo. `E_VOICE_FULL`
era exatamente isso: "a sala está cheia", dito na cara.

O que se perde é essa frase. O que se ganha é não mentir: o teto anterior não sabia se a sala
estava cheia — sabia contar até 24. A resposta honesta não é um número melhor, é o número que
**quem administra a comunidade** escolhe, sabendo das máquinas dela. É o B38, e é por isso que
ele nasceu junto com esta remoção em vez de depois dela.

### 90.4 O que não mudou

Continua valendo tudo que é **autorização**, que é outra categoria: `voice_speak` (§9.1),
membro ativo não banido nem em timeout, canal de voz existente, e — para a tela — audiência é
a chamada (`F-18`), com `E_PERMISSION_DENIED` para quem pede de fora. `E_ALREADY_SHARING`
também fica: um apresentador por pessoa é teto de **captura**, não de ocupação, porque a
captura de uma instalação é uma só.

G8 perdeu um critério de aprovação ("9º espectador recebe `E_SESSION_FULL`") e nenhum outro:
os oito espectadores continuam sendo a **carga** do cenário, que é o que o gate sempre quis
medir. A evidência histórica do POC-09 não foi reescrita — ela registra o que era verdade
quando foi tomada.

## 91. Sozinho na chamada não é "conectando" — 2026-08-26

**Entrada:** o operador observou que "Conectando…" devia ser um `StatusBanner` como os
outros estados da chamada, e perguntou se dava para entrar sozinho e qual seria o problema
disso. **Resultado:** o banner alinhado e um defeito de tela fechado.

### 91.1 Dava para entrar sozinho, e era a tela que não sabia

Entrar sozinho sempre foi possível e sempre foi **normal**. A malha diz isso em texto, e age
de acordo — `live/voz.ts`:

> **Só há prazo se há com quem conectar.** Entrar sozinho num canal de voz é normal —
> espera-se alguém.

É por isso que o prazo de L-11 não é armado nesse caso: não há negociação para vencer. Quem
discordava era o `voiceStore`, cujo comentário do `join` dizia "quem tira de `connecting` é o
par conectando de verdade". Sem par, nada tirava, e a chamada de quem entrava primeiro ficava
em `connecting` **para sempre**.

Três consequências, todas na mesma tela:

| O que a tela fazia | Por quê |
|---|---|
| "Conectando…" eterno | `stage` nunca saía de `connecting` |
| Tile próprio preso em esqueleto | `const tiles = connecting ? skeletons : reais` |
| Hint "Convide alguém" inalcançável | a condição era `!connecting && participants.length === 1` |

A terceira é a mais reveladora: as duas metades da condição nunca podiam ser verdadeiras ao
mesmo tempo, então o único texto escrito **para** quem entra primeiro era o único que ele
nunca veria. Código morto que parecia vivo — e que, olhando a condição, dava para ver sem
rodar nada.

É a mesma mentira que §80 tirou da conexão ("Conectando…" para sempre em vez de
`conn-failed` nomeado), reaparecida por outra causa: lá o estado não avançava porque a
negociação não fechava; aqui não avançava porque não havia negociação nenhuma.

### 91.2 O que passou a valer

Roster com **só eu** tira de `connecting`: a chamada está de pé, e estar sozinho é um estado
terminal, não uma etapa. Dois detalhes do mesmo tamanho da regra:

- **Ficar sozinho depois de uma falha apaga o motivo.** Se o outro saiu, "Não foi possível
  conectar" com "Tentar novamente" ofereceria retentativa contra ninguém.
- **Roster VAZIO não é "sozinho", é "sem chamada".** É o que sobra depois de
  `encerradaPeloHost`, e tratá-lo como sozinho ressuscitaria a chamada e apagaria o porquê —
  exatamente o defeito que §86.9 fechou. A condição é `length === 1`, não `<= 1`, e as duas
  metades estão verificadas por mutação.

O caso de duas pessoas não mudou: com alguém no roster, continua `connecting` até um par
fechar de verdade.

### 91.3 O banner, e o hint que saiu

"Conectando…" era o único dos três estados da chamada solto como parágrafo — sem ponto de
cor, sem fundo, sem o movimento que §5.4 pede de transitório. Virou `StatusBanner` no tom
`reconnecting` ("transitório e ativo: leva movimento, senão parece offline", diz a tabela do
próprio componente), ao lado de `conn-degraded` e `conn-failed`, no mesmo `inset` dos outros.

O hint "Convide alguém pra {canal}" foi **removido** — decisão do operador, tomada depois de
ele voltar a ser alcançável. A grade com um tile só já diz que não há mais ninguém, e
convidar não é ação desta tela. `frontend.md` §18 registra a mudança na linha que o pedia.

## 92. Os dois guardas de saída, e o que travava a janela do host — 2026-08-26

**Entrada:** "o programa não fecha se você for o host; a última tentativa de correção
falhou". **Resultado:** causa isolada em harness, quatro defeitos corrigidos e o ciclo de
fechamento — que §78.3 declarou **não verificado** — virou smoke versionado.

### 92.1 O que foi descartado antes de achar

Duas hipóteses caíram por medida, não por leitura:

| Hipótese | Harness | Veredito |
|---|---|---|
| `utilityProcess` vivo impede `app.quit()` | núcleo de mentira, ocupado e **surdo** ao `shutdown` | **falsa** — `quit` em 0 ms, filho reapado em 1 ms |
| O renderer não atende `exit-impact` | §78 já tinha ligado o atendente | verdadeira só **antes** do shell montar (§92.4) |

### 92.2 A causa: dois guardas de saída empilhados

O produto tinha **dois** guardas para o mesmo fechamento, um de web e um de Electron:

- `useBeforeUnloadWarning(hostedImpact.length > 0)` — herdado do mock, registra
  `beforeunload` com `preventDefault`;
- o main segurando o primeiro `close` e perguntando o impacto (U-06).

No **navegador**, `preventDefault` num `beforeunload` faz o browser **perguntar**, e quem
decide é a pessoa. No **Electron não há pergunta**: o `preventDefault` veta o fechamento
**em silêncio**, e não há segunda chance. Medido em harness próprio — mesma janela, única
diferença o listener:

```
com beforeunload:  close() ×3 → evento `close` ×3, `closed` NUNCA,
                   window-all-closed NUNCA, app.quit() NUNCA        (morto por SIGKILL)
sem beforeunload:  close() ×1 → closed em 1 ms → quit               (código 0)
```

O guarda de web vetava a saída que o guarda de Electron tinha acabado de conceder. Nem
"Fechar mesmo assim" escapava: `confirmExit` mandava `mainWindow.close()`, e o
`beforeunload` engolia — a pessoa clicava e **nada acontecia**.

**Por que só como host, e por que o smoke anterior passou.** O `beforeunload` só era
registrado quando `hostedImpact.length > 0`, isto é, hospedar **com gente conectada**. Sem
ninguém online ele nem existia. O smoke de 2026-08-23 (§3082) fechou o app pelo gesto
nativo com sucesso — e passou porque, ali, não havia ninguém do outro lado. A condição do
defeito é literalmente a frase do relato.

A regra que fica: **com shell, o guarda é o do shell.** Fora do Electron o `beforeunload`
continua ligado, porque lá é a única defesa que existe.

### 92.3 O `off` da ponte não removia nada

O preload inscrevia um **embrulho anônimo** (`ipcRenderer.on(canal, (_e, ...a) => l(...a))`,
necessário porque o `event` não pode atravessar o `contextIsolation`) e o `off` tentava
remover o **listener original**, que nunca foi inscrito. `off` devolvia sem erro e sem
efeito.

Consequência: cada reexecução do efeito de `AppShell` — e ele dependia de `hostedImpact`,
que muda a cada pessoa que entra ou sai de uma chamada — empilhava mais um `exit-impact`
vivo, cada um com um `hostedImpact` congelado no instante em que nasceu. Agora o preload
guarda o mapa `listener → embrulho`, e `off` remove o que `on` inscreveu.

### 92.4 "Cancelar" não cancelava, e o atendente estava fundo demais

Mais dois, do mesmo caminho:

**O prazo vencia quem desistia.** O main mantém 10 s para o caso de o renderer não
responder. Quem clicava "Cancelar" via o app fechar sozinho dez segundos depois — o
contrário do que pediu. E `pedidoDeSaidaEnviado` ficava `true` para sempre, então o
fechamento **seguinte** passava direto, sem mostrar impacto nenhum. Existe agora um
`cancelExit`: desarma o prazo e devolve o guarda ao lugar. O prazo é para o silêncio, não
para vencer a pessoa.

**Dez segundos de janela morta antes do shell.** O atendente de `exit-impact` morava dentro
do `AppShell`. Toda tela anterior a ele — onboarding, identidade, restauração — ficava sem
ninguém do outro lado, e fechar a janela ali custava o prazo inteiro. Medido no produto
real com o núcleo em `awaiting-identity`: **10.0 s** antes, **6 ms** depois de mover o
atendente para a raiz.

### 92.5 O dreno também ganhou orçamento

`drenarESair` não tinha prazo: um `stop()` de transporte que não resolvesse — host com
conexões abertas é justamente o caso — deixava o `finally` inalcançável, e com ele o
`liberarLock()` e o `process.exit(0)`. O main matava o processo pela rede de segurança de
8 s, mas por cima. Agora o dreno tem 5 s, abaixo dos 8 do main, para que o caminho limpo
ganhe a corrida.

### 92.6 O ciclo virou smoke versionado

§78.3 dizia: *"o ciclo de fechamento não foi exercitado: este ambiente não tem gerenciador
de janelas para disparar o `close`"*. Não precisa de gerenciador de janelas — `win.close()`
percorre o mesmo caminho que o X do sistema, e um display virtual basta. Foi por não haver
essa verificação que o mesmo ciclo voltou quebrado duas vezes.

`app/scripts/smoke-fechamento.mjs` (`npm run smoke:fechamento`, sob `xvfb-run`) roda três
cenários contra o **preload real**: confirmar fecha pela resposta e não pelo prazo; cancelar
mantém a janela viva, desarma o prazo e faz o X seguinte perguntar de novo; e o cenário
`veto` reproduz o comportamento anterior e **precisa continuar reprovando** — é a prova
viva da causa desta fatia.

## 93. A câmera sai do mock: a malha carrega vídeo, e o botão deixa de ser um ícone — 2026-08-27

**Entrada:** "fazer o programa reconhecer as câmeras disponíveis e implementar ligar e
desligar câmera em chamada". **Resultado:** `toggleCamera` deixou de ser um `set` que virava
um booleano; a câmera vira captura real, trilha na malha de §17.2 e `voice.setSelf` ao host,
com o `<video>` do tile no lugar do gradiente animado que sobreviveu ao mock.

### 93.1 O que já existia, e o que era decoração

Enumerar câmeras já era real desde §75 (`live/dispositivos.ts`): a lista vem de
`enumerateDevices`, a escolha é persistida por `settings.setDevice` e um id que sumiu cai
para o padrão do sistema. **Faltava o gesto que dá nome a elas.** Rotular exige permissão, e
a única permissão que a tela de dispositivos pedia era a do microfone — então as câmeras se
chamavam "Câmera 1" e "Câmera 2" para sempre. Agora há "Testar câmera", que pede a
permissão e mostra a prévia ao vivo, do mesmo jeito que "Testar microfone" é o gesto que
destrava os nomes dos microfones.

A dica embaixo dos dois selects também mentia: `estado` era global, então quem autorizava o
microfone continuava lendo "Autorize o microfone para ver os nomes" enquanto a câmera
seguisse sem rótulo. A permissão é por tipo, e a pergunta passou a ser por tipo
(`semRotulos(kind)`).

O resto era a família de defeitos de §85.2 — estado que muda e efeito que não acontece:

```
toggleCamera: () => set(state => ({ participants: … cameraOn: !p.cameraOn }))
```

Nenhuma captura, nenhuma trilha, nenhum `voice.setSelf`. O botão acendia do lado de cá, e do
lado de lá não acontecia nada — nem o ícone, porque o host nunca era avisado.

### 93.2 A câmera é da MALHA; a tela é uma ESTRELA

A decisão que organiza a fatia inteira. §17.2 põe voz e câmera na mesma malha ponta a ponta:
quem está na chamada vê, pela mesma regra que faz todos ouvirem o microfone. §17.5 é outra
coisa — uma estrela cuja audiência o host autoriza nome a nome (`share.join`,
`share.health`), com perfil de banda por espectador.

Daí a divisão do código, que **não** é a de `live/tela.ts`:

| | Tela (§17.5) | Câmera (§17.2) |
|---|---|---|
| Audiência | quem o host autorizou, um a um | todo par da malha |
| Sessão no host | `share.start` → `sessionId` | nenhuma; só `voice.setSelf{cameraOn}` |
| Ordem | host decide → captura (`T-41`) | captura → avisa o host (§93.3) |
| Onde a trilha entra | `enviarTrilha` por espectador | `definirVideoLocal`, em todos |

`live/camera.ts` sabe o que é uma câmera — dispositivo escolhido, permissão do sistema,
rótulo, motivo da recusa — e não toca em `RTCPeerConnection`. `MalhaDeVoz` ganhou
`definirVideoLocal`/`removerVideoLocal` e passou a anexar a câmera também em `#abrir`: quem
**entra depois** recebe o vídeo na oferta inicial, sem renegociação nenhuma.

**Do lado de quem recebe, tela e câmera chegam iguais** — duas trilhas de vídeo do mesmo par,
na mesma conexão — e §15.x não declara nada que as distinga: não há campo no fio dizendo
"este `msid` é a sessão S". A decisão é tomada com o estado que o host **já publicou** antes
da mídia chegar (`eTela`, em `live/sincronizacao.ts`), e o que ela não cobre saiu como
lacuna **B41** em vez de campo inventado no fio.

### 93.3 A ordem é o inverso da tela, e de propósito

`T-41` manda o host decidir antes da captura porque compartilhar tela exige
`voice_share_screen` e cria uma sessão. A câmera não tem nem uma coisa nem outra: §15.4 só
tem `voice.setSelf{cameraOn}`, que é **aviso**, não pedido. Então captura-se primeiro e
avisa-se depois — anunciar `cameraOn: true` para depois descobrir que o SO negou o
dispositivo acenderia o ícone do outro lado sobre uma imagem que não existe.

Entre o gesto e a imagem está o diálogo de permissão do sistema, que demora o que a pessoa
levar para responder: é o `cameraPendente`, que não é um `cameraOn` otimista (A25) e que
também impede o segundo clique de abrir uma segunda captura. Quando a recusa vem, ela vem
**nomeada** — `NotAllowedError`, `NotFoundError`, `NotReadableError` pedem ações diferentes
(autorizar, escolher outra, fechar o outro aplicativo), e uma frase genérica mandaria
procurar defeito no lugar errado. É o vocabulário de `RT-10`/`E_DEVICE_BLOCKED`.

Desligar é o simétrico do mudo de L-12, e tem as duas metades: tirar a trilha de cada
conexão **e** parar o dispositivo. Só a primeira deixaria a luz da câmera acesa; só a
segunda deixaria um m-line morto em cada par.

### 93.4 O roster do host não manda no dispositivo desta máquina

`cameraOn` no roster é o **eco** do que esta máquina contou por `voice.setSelf`. Entre contar
e o eco voltar existe um roster publicado por outro motivo — alguém entrou, alguém saiu —, e
ler esse eco como verdade apagaria a própria imagem no meio da chamada, com a câmera acesa e
transmitindo. Quem possui o dispositivo responde por ele, pela mesma razão que
`connectionToMe` já era local.

Na direção contrária vale o inverso: a trilha que chega **é** a prova de que a câmera do
outro está ligada, e ela pode chegar antes do roster que a anuncia. O tile mostra o que está
de fato entrando; o host continua mandando, e o próximo `voice.roster` sobrepõe.

### 93.5 Ofertas cruzadas: um buraco que só existe desde esta fatia

Até aqui só um lado renegociava. A tela é do apresentador, e a oferta inicial tem dono
(`souOIniciador`). Com a câmera, **os dois lados podem ofertar no mesmo instante** — os dois
ligando a câmera juntos é o caso trivial —, e aplicar uma oferta remota em `have-local-offer`
é erro de estado. A promessa recusada não teria quem a pegasse (o evento entra por
`void malha.aplicarSinal(…)`): a negociação ficaria parada para sempre, com a câmera acesa
de um lado e ausente do outro. Silenciosa, que é a forma de defeito que §82.1 mais custou a
achar.

O desempate reusa a mesma regra determinística de quem oferta primeiro: quem iniciaria
**ignora** a oferta que chegou; o outro **desfaz** a própria (`rollback`), responde, e
reoferta quando assentar. Nenhuma das duas pontas precisa combinar nada. A marca de reoferta
é posta depois do `setRemoteDescription`, e não junto do rollback — marcar antes deixaria a
marca de pé no instante em que o rollback devolve o estado a `stable`, e
`onsignalingstatechange` dispararia a oferta de volta, recriando a colisão.

### 93.6 O que ficou provado, e o que não

`camera.test.ts` cobre: a trilha indo para todos os pares; quem entra depois recebendo na
primeira oferta, sem renegociar; desligar tirando de todos e parando o dispositivo; a câmera
não sobrevivendo à chamada; as duas pontas da oferta cruzada; e, no store, que o host só é
avisado **depois** da captura, que a recusa não acende o botão, e que o roster não apaga a
câmera de quem a possui.

O que **não** está provado é o que nenhum teste desta máquina prova: imagem chegando de
verdade entre duas máquinas, o custo da malha com várias câmeras ao mesmo tempo, e a oferta
cruzada acontecendo em rede real. É **B42**, a mesma prova que B28 e B31 deram para voz e
tela.

## 94. Assistir era o modo esquecido: os controles não saíam da frente, e as recusas iam para a sessão errada — 2026-08-27

**Entrada:** "os botões ficam em cima sem sumir depois de um tempo" — e o pedido de olhar
mais fundo, a partir da pergunta se tela e câmera podem estar ligadas ao mesmo tempo (podem:
nem o host nem a UI as cruzam). **Resultado:** cinco defeitos do lado de **quem assiste**,
todos da mesma família — o produto tinha a informação certa e a usava no lugar errado.

### 94.1 A câmera de quem eu não podia assistir virava a tela dele

§93.2 deixou a classificação da trilha recebida decidida por "existe transmissão viva deste
par". Parecia conservador e não era: `share.started` chega a **todos** os da chamada,
inclusive a quem o host recusa o `share.join`. E o apresentador só manda trilha de tela a
quem o host listou em `share.health` — a audiência de §17.5 é nominal.

Então, para quem teve a entrada negada, a **câmera** daquele par chegava e era exibida como
se fosse a tela dele. Não era a janela estreita que B41 nomeava: era erro certo e permanente,
e ainda por cima mostrando no palco de transmissão um vídeo que a pessoa não tinha
autorização para ver ali.

A regra passou a ser sobre o `share.join` que **esta máquina** conseguiu, que é a única
resposta que quem recebe pode dar sozinho para "a próxima trilha deste par é a tela?".
`telaStreams` guarda as sessões assinadas; a decisão saiu de dentro de `sincronizacao.ts`
para `live/videoRecebido.ts`, pura e testada. B41 encolheu para o que de fato sobra: entrar
numa transmissão e o apresentador ligar a câmera no mesmo instante, com a trilha da câmera
chegando primeiro. Fechar isso exige campo no fio, que é decisão normativa.

### 94.2 Os controles não saíam da frente

O relato. A fileira de ações cobre o canto de baixo, o chip de espectadores cobre o de cima,
e nada disso sumia — numa apresentação de slides ou num editor, é exatamente onde o conteúdo
está. Agora somem após 3 s parados e voltam ao primeiro movimento.

O que **não** some, e é a parte que importa:

| Situação | Por quê |
|---|---|
| "Preparando…", falha, vídeo ocultado | ali os botões **são** o conteúdo; escondê-los deixa a pessoa sem saída |
| Popover de ajustes aberto | sumir debaixo do próprio menu é puxar o tapete de quem está usando |
| Ponteiro parado **sobre** a fileira | parar de mexer é "estou vendo"; parar de mexer mirando um botão é o oposto |
| Foco de teclado entrou na área | `onFocusCapture` traz de volta — Tab não pode passar por controles invisíveis |

Sumir é por opacidade, nunca desmontando: o `<video>` perderia o `srcObject` e o foco não
teria como trazer nada de volta. Enquanto invisíveis ficam `pointer-events-none`, para que o
toque que os revela não aperte um botão que ninguém estava vendo.

Junto vieram os dois gestos que faltavam para uma tela de vídeo: **Esc** sai da tela cheia
(antes o único caminho era o botão "Reduzir", que é justamente o que tinha acabado de sumir)
e **duplo clique** na imagem alterna tela cheia.

### 94.3 A recusa de quem assiste ia para uma transmissão que não existe

`telaFalhou` procurava sempre a **minha** transmissão (`minhaTela`). Para quem assiste ela
não existe, então:

- `share.join` recusado → `telaFalhou` não achava alvo, **retornava vazio**, e o espectador
  ficava em "Preparando compartilhamento…" para sempre, com o motivo descartado em silêncio;
- `share.failed{reason:'revoked'}` — o evento que a emenda de 2026-08-26 criou **para poder
  avisar o espectador revogado** — morria no mesmo lugar, sem nunca chegar à tela.

`telaFalhou` passou a receber o `sessionId`. Sem id continua sendo a minha, que é o caminho
de quem tentou apresentar e ainda não tem id nenhum do host.

### 94.4 E o "Tentar novamente" dele não tentava nada

Mesmo defeito, um passo adiante: `retryShare` também procurava `minhaTela` e desistia. O
botão aparecia na falha do espectador e **não fazia nada** — o pior tipo de botão.

Agora o que se repete depende de quem eu sou naquela transmissão: apresentador repete a
captura inteira, com a mesma fonte; espectador repete o `share.join`, que é a única coisa que
falhou do lado dele. Capturar a tela de outra pessoa nunca foi algo que este botão pudesse —
nem devesse — fazer.

### 94.5 Nome legível sobre vídeo, e avatar que não cobre mais o rosto

Duas heranças do mock que só apareceram quando a imagem virou real (§93):

**O avatar era desenhado por cima do vídeo.** Fazia sentido quando "vídeo" era um gradiente;
com câmera de verdade, eram as iniciais da pessoa tapando o rosto dela. Agora a câmera
**substitui** o avatar. Fala ativa continua sendo anel — §5.4 pede forma e movimento, e
sumir com ela junto das iniciais deixaria a grade sem dizer quem fala bem na hora em que há
mais o que olhar.

**O nome ficava direto sobre a imagem.** Sem fundo, o contraste passou a ser "o que a câmera
estiver mostrando", que não é contraste que se possa afirmar. Na grade o nome ganhou
superfície atrás; na linha compacta não precisou, porque ali a forma mudou: a câmera ocupa o
**lugar do avatar** em 4:3, em vez de virar fundo full-bleed de uma faixa de 56px — que
recortaria um rosto em tarja e ainda poria o nome por cima. A linha compacta é o que a tira
de miniaturas ao lado de uma transmissão usa, isto é, exatamente o caso de câmera e tela
ligadas ao mesmo tempo.

Saiu com isso o `camera-drift` de `tokens.css`, a animação que fazia a superfície simulada
"respirar" para não parecer imagem congelada. Não há mais o que simular.

---

## 95. O caminho do produto resolvido: seis itens, e o que cada um escondia — 2026-08-28

Pedido: resolver o caminho do produto do backlog. A ordem executada não foi a da lista, e a
razão está em §95.1.

### 95.1 A leitura que mudou a ordem

Cinco dos oito itens eram **um** item. B27, B11, B30 e metade de B10 eram todos "o caminho
de conectividade não existe, e o produto não sabe dizer isso". Concretamente, antes desta
fatia: uma chamada entre dois NATs simétricos falhava; `diag.run` não conseguia dizer por
quê (respondia `cgnat/false/false` para tudo, sempre); e `relay.enable` respondia
`E_UNKNOWN_COMMAND`.

E a premissa de B30 estava trocada. A resposta da spec para NAT simétrico dos dois lados é o
**TURN do host** (§17.3), não o voluntário; §17.7 é a resposta para o **host** estar
inalcançável (L-11). Com B27 pronto, simétrico-dos-dois-lados fecha sem voluntário nenhum —
o que reordena o resto do caminho.

Daí a ordem: **B27 → B11 → B10 → B7 → B8+B12**, com B16 (decisão do operador) à frente e
B30 no fim, na parte que dá para fazer.

### 95.2 Três decisões do operador

| Pergunta | Decisão | Onde ficou |
|---|---|---|
| §17.3 não diz de onde sai o endereço **relayado** de uma alocação TURN | Socket nova por alocação (RFC 5766 como escrito) e mapeamento externo descoberto por Binding ao STUN de terceiro, que §17.2 já deixa ligado | §17.3, emenda |
| "Tela via TURN é recusada" com tela e voz na mesma `RTCPeerConnection` | A recusa cai do host e vira conselho do renderer, que enxerga o par selecionado | §17.3, emenda |
| B9 (residência `light`) | Adiado até G9 medir | `backlog.md`, "Bloqueado por medida" |

### 95.3 O que cada item escondia

| # | O relatado | O que era |
|---|---|---|
| B16 | "Superfícies `dev.*` — decisão de produto" | Não era o `DevBar.tsx` do mock: era `dev` como **classe de autorização** de §15.3, com gate de build, eliminação de código morto e modo próprio de falhar aberto, viva no produto por uma ferramenta de desenvolvimento |
| B27 | "`rosterAddresses` devolve vazio" | Três pontos desligados, não um. E a permissão comparava `host:port` — mais estrita que RFC 5766 §9 e **impossível de satisfazer**, porque a porta de origem do `RTCPeerConnection` é de outra socket. Mais uma lacuna que ninguém tinha registrado: §17.3 é silenciosa sobre o endereço relayado, e o G7 não a expôs porque ligou a socket em loopback |
| B11 | "Sondas NAT/STUN" | As três eram stub, e a de NAT **já estava medida**: o `nat-sampler` do `dht-rpc` zera a porta exatamente quando o host é consistente e a porta não — a definição operacional de NAT simétrico. Faltava traduzir |
| B10 | "Barreira de replicação por confirmação de PARES" | Defeito de honestidade: `replicatedTo` devolvia o `interpretedSeq` local. E `pendingReplication` tinha o mesmo defeito ao contrário — lia **zero** num host em dia consigo mesmo e sozinho no swarm, o caso em que fechar perde tudo. O número não tinha consumidor: `host.exitImpact` não era chamado por ninguém |
| B7 | "observar o próprio ban/kick" | Faltava **quem começa**: nada escrevia `removed_reason`, então `community.forget` recusava sempre, `removed.purge` nunca purgava, e o passo 5 era impossível porque `query.communities` filtrava a comunidade removida para fora do rail |
| B8 | "atenuado, não fechado" | O caminho documentado ("sair, depois esquecer") **não existe**: §18.5 deixa o log terminal e o estágio 5 do `fold` recusa `member.leave` com `E_COMMUNITY_ENDED` |
| B12 | "`limitPerGroup` fixo" | Dois defeitos que se escondiam um no outro: o botão "Ver todos" **nunca aparecia** (a condição é `length > 20` e o núcleo devolvia no máximo 20), e se aparecesse expandiria para a mesma lista |

### 95.4 Achados de caminho, fora dos itens

- **"Avisar quem está online" continuava no modal de saída**, appendando a mensagem que
  §18.7 diz ter removido e desligando em seguida — o `F-43` que a seção declara fechado.
- **Dado chegando à porta relayada de um IP sem permissão era repassado ao cliente**
  (RFC 5766 §10). O endereço relayado é público.
- **`relayPublicKey` saía como `Buffer` cru pela IPC-R** — o único campo de chave do produto
  com forma diferente dos outros.

### 95.5 O que NÃO foi feito, e por quê

- **B30 não fecha.** A parte implementável saiu (consentimento, kinds 60/61, `relays` no
  `DS`). O que sobra são três decisões de protocolo — endereço, credencial e seleção —, e
  inventá-las seria criar superfície que a spec não declara. Registradas em §17.7.
- **B9 não entra.** A justificativa é hipótese que G9 mede.
- **Nada aqui foi medido em rede real.** O caminho relayado do host tem teste de loopback
  ponta a ponta e nenhuma travessia de NAT de verdade: isso continua sendo `B4`.

### 95.6 Evidência

`core`: build + barreira de camadas de §4 + 941 testes. `frontend`: build, lint e 326
testes. `app`: typecheck, `smoke:fechamento` verde, `smoke:captura` verde com o cenário de
janelas **não medido** (sem gerenciador de janelas sob Xvfb).

---

## 96. Duas caixas do sistema para escolher uma tela: o seletor do produto no Wayland — 2026-08-28

Relatado em uso real, no Linux: clicar em compartilhar tela abre a caixa do sistema ("o app
quer compartilhar sua tela"); confirmar leva ao seletor do produto ("Tela inteira" / "Uma
janela"); confirmar de novo **abre a caixa do sistema outra vez**.

### 96.1 A causa: no Wayland, listar é pedir permissão

`desktopCapturer.getSources()` não é leitura ali. Ele abre uma sessão de `ScreenCast` no
`xdg-desktop-portal`, e a caixa que aparece **é** a escolha da pessoa — não há como
enumerar sem perguntar, e é assim de propósito: no Wayland o compositor é dono da tela.

O produto chamava `getSources` duas vezes, e cada uma abria a caixa:

1. `ShareSourceModal` monta → `listCaptureSources` → **caixa #1**;
2. a pessoa escolhe na caixa, e o que volta vira a lista do seletor do produto;
3. ela escolhe de novo, agora na nossa lista → `getDisplayMedia` → o handler relista para
   validar → **caixa #2**.

E não era só uma caixa a mais. Cada pedido abre uma sessão **nova** do portal, então o `id`
escolhido na sessão #1 não existe na lista da sessão #2: `resolverFonte` devolvia
`undefined` e o main negava. **A captura nunca subia no Wayland** — o loop era o sintoma
visível de um caminho que não fechava.

Havia ainda uma inversão de `T-41`: a caixa #1 abria na montagem do seletor, ou seja
**antes** de `share.start` e antes de o host autorizar qualquer coisa.

### 96.2 A decisão: onde o sistema pergunta, ele é o seletor

O seletor do produto (§17.5) existe porque no X11 e no Windows a escolha da fonte era
`fontes[0]` — "Uma janela" era um botão que não escolhia janela nenhuma (§83). Esse motivo
não vale no Wayland: ali a caixa do sistema já é a escolha, e a nossa só a repete.

| Caminho | Quem escolhe | Por quê |
|---|---|---|
| Wayland (`XDG_SESSION_TYPE=wayland`, ou socket do compositor sem declaração — o caso do WSLg) | O sistema | Listar é pedir permissão; a resposta do portal é a escolha |
| X11 e Windows | O produto | `getSources` é leitura, e sem o seletor a fonte volta a ser `fontes[0]` |
| Fora do Electron (`npm run dev`) | O navegador | Não há main para listar; inventar lista seria o mock que §17.5 tirou |

`XDG_SESSION_TYPE` tem a última palavra nos **dois** sentidos: um `x11` explícito vence um
`WAYLAND_DISPLAY` que ficou no ambiente — um compositor rodando ao lado, ou um `xvfb-run`
que herdou o env do shell. Sem isso o seletor do produto sumiria de sessões X11 onde ele
funciona, que é o defeito oposto.

**A ordem de `T-41` melhora.** No caminho do portal a única enumeração passa a ser a do
handler, que já pergunta ao núcleo antes: `share.start` → o host autoriza → `captureToken`
→ **então** a caixa do sistema. Antes ela abria primeiro.

### 96.3 O que mudou no código

- `captura.ts`: `seletorDoSistema()` (decisão pura) e `suporteDeCaptura()`, que passa a
  responder as duas perguntas do seletor de uma vez — se há áudio, e de quem é a escolha.
- `main/index.ts`: no caminho do portal o handler pede `['screen','window']` (filtrar por
  tipo descartaria a janela que a pessoa apontou) e resolve com `sourceId: null` — ali
  `fontes[0]` não é "a primeira que aparecer", é a única, e é a que ela escolheu. E
  `listCaptureSources` recusa antes de chamar `getSources`: é a segunda tranca contra a
  caixa aparecer cedo.
- `ShareSourceModal`: no caminho do portal não lista, não mostra grade nem abas de tipo — o
  sistema pergunta tela-ou-janela junto — e diz que a caixa abre depois de confirmar.
  Qualidade e áudio continuam sendo escolha daqui. E ninguém lista antes de saber de quem é
  a escolha: perguntar cedo era exatamente o defeito.

### 96.4 O que isto NÃO resolve

**A caixa do sistema não sai.** Ela é a fronteira de segurança do Wayland, não uma tela
nossa: o app não tem como capturar sem ela. O que saiu foi a segunda aparição — e a nossa.

**Não foi medido aqui.** Sob Xvfb não há portal nem gerenciador de janelas, e o
`smoke:captura` continua declarando o cenário de janelas **não medido**. O que este
ambiente prova é a decisão de plataforma (tabela nova no smoke) e que nada regrediu no X11.
A travessia real do portal — a fonte concedida ser a apontada, e a trilha chegar ao outro
lado — continua sendo `B32`.

---

## 97. A voz que não conectava: a investigação de conectividade de ponta a ponta — 2026-08-30

Pedido: investigar todos os problemas existentes e potenciais na conectividade entre
usuários — descoberta, replicação, autorização, reconexão, queda de conexão, NAT, firewall,
relay, STUN/TURN —, corrigindo o que tem causa e correção claras e registrando o resto no
backlog. O sintoma: usuários não conseguem conversar por voz, com falhas de conexão
descritas como gravíssimas.

### 97.1 O achado central: nada disso era rede externa

A investigação (três leituras paralelas — spec, núcleo/transporte, renderer — e verificação
individual de cada achado no código) encontrou **uma cadeia de defeitos concretos**, todos em
código, nenhum exigindo rede nova para reproduzir. As ações cotidianas da chamada eram as
que quebravam a chamada:

| # | Camada | O defeito | O efeito em uso |
|---|---|---|---|
| 1 | renderer | O handler de `voice.revoked` ignorava `sessionId` — e o host emite a revogação da sessão ANTIGA para quem acabou de entrar na NOVA (§17.4, "entrar noutra é sair da anterior") | Trocar de canal de voz derrubava a malha inteira e o `voice.leave` do handler, resolvido pelo núcleo contra a sessão corrente, expulsava da chamada nova |
| 2 | renderer | `entrar()` não limpa nada do estado anterior; `#abrir` sobrescrevia o par sem `pc.close()` | Reentrar — trocar de canal, "Tentar novamente" de §80 — duplicava RTCPeerConnections: ofertas cruzadas, candidates misturados, a mesma voz duas vezes (eco) e o microfone antigo preso ao dispositivo |
| 3 | renderer | Sem `restartIce` nem reconstrução de par em `failed`/`disconnected` | Queda de rede (Wi-Fi) = par morto para sempre; áudio não voltava sem sair e reentrar à mão |
| 4 | renderer | O prazo de L-11 era GLOBAL e rearmado a cada par novo do roster | Um par que não conectava anunciava `conn-failed` para uma chamada de 3+ que já funcionava |
| 5 | renderer | `join` engolia o código da recusa (`.catch(() => failed)`) e captura de mic que falhava depois do join deixava fantasma no roster | "Permissão negada", "host indisponível" e "microfone negado" contavam a mesma frase genérica — e o fantasma ficava no roster até o liveness de 90 s |
| 6 | renderer | Erros de sinalização engolidos: `voice.signal` com `.catch(() => undefined)`, `aplicarSinal` sem quem pegue a rejeição | A lição de §82.3 violada no canal exato onde ela nasceu: uma negociação recusada era indistinguível de uma que nunca começou |
| 7 | renderer | O detector de VAD era criado ANTES da captura (`#local === null` na primeira entrada) | `speaking` nunca saía; o anel de fala de ninguém acendia |
| 8 | renderer | `voice.deviceError` (§15.5, RT-10) sem assinante; `StrictMode` duplicava toda a assinatura de voz em dev | O tópico declarado era código morto; em dev, dois handlers por evento — `voice.signal` processado duas vezes |
| 9 | renderer | O filtro local de tickets comparava relógio LOCAL com `expiresAt` carimbado pelo host | Máquina com relógio adiantado descartava ticket recém-emitido — a corrida de §17.4 com cara de intermitência "por máquina" |
| 10 | núcleo | `CoreRuntime.forget` não chamava `transport.leaveCommunity` → aceitadores `p2p-community/1` órfãos → `attachMemberConnection` lançava "não é hospedada aqui" DENTRO do `mux.pair` | Host que esquecia comunidade com pares conectados arriscava matar o PROCESSO inteiro — toda voz de todas as comunidades de uma vez |
| 11 | núcleo | `RpcClient` mantinha o transporte morto como destino no `onDown`; `send` descarta em silêncio | Blip de rede = 15 s de pedidos zumbis = `voice.failed{host-unavailable}` espúrio em chamada viva |
| 12 | núcleo | Hello falhando em `connecting` não contava para o veredito de §19.4 | Conexão meio aberta: membro preso em "conectando" para sempre, com o hello morrendo no teto a cada 30 s |
| 13 | núcleo | `unsub` do IPC-R mandava o `localId` como `subId` (o comentário admitia) | Sub errado apagado no servidor; a assinatura órfã recebia `ev` sem `evAck` até a janela estourar e o `evStale` matá-la — voz sem eventos |
| 14 | núcleo | A credencial TURN (`MEDIA_TICKET_TTL_MS`, 5 min) não tinha caminho de renovação — só o ticket tinha | Chamada que dependia do caminho relayado morria entre 5 e 10 min, com o `Allocate` novo a responder 401 — o caso CGNAT, exatamente o que §17.3 promete servir |
| 15 | núcleo | Acumuladores e knobs: `#observados` sem poda (B17); `P2P_TURN_*` lidos na config e jogados fora; `waitForHello` de slot único; o ramo `music` de `authorizeCapture` aceitava token vencido (a perna remota recusava); o giro da fila de karaokê rodava a 30 s contra o comentário que dizia 1 s | Host de longa duração acumulava; ajustes de ambiente não tinham efeito nenhum; turno vencido durava até 30 s além do prazo |

A correspondência com o histórico é direta: todos os defeitos de voz de §77–§89 foram
achados em smoke manual de duas máquinas, nenhum por teste — e os itens 1, 2, 3, 4 e 14 são
exatamente do tipo que só duas pontas revelam. É o que abre o B45.

### 97.2 As decisões

| Pergunta | Decisão | Onde ficou |
|---|---|---|
| Quando a revogação é da MINHA sessão? | `voice.revoked` só age com `sessionId` casando com a sessão corrente da malha (e fora do intervalo de um `join` em curso); o eco da sessão antiga não é ordem — a limpeza dela é do `entrar`, que nasce limpo | código (`live/sincronizacao.ts`), conforme §15.5 |
| O que limpa o estado local ao trocar de canal? | O `entrar` começa com a limpeza de `sair()` MENOS o `leave` na porta: o host já resolveu a sessão anterior no join idempotente, e um leave aqui seria resolvido contra a sessão NOVA | código (`live/voz.ts`) |
| Queda de rede encerra a chamada? | Não: `failed` reconstrói o ICE pelo lado iniciador (a regra de quem oferta), com teto de 3 tentativas; `disconnected` tem graça de 5 s. Encerrar sessão continua sendo decisão do host (§17.4) — reentrada em NOVA sessão segue indecidida (B43) | código (`live/voz.ts`) |
| Quem falha quando UM par de muitos não conecta? | Ninguém, na chamada: o prazo só vence com NENHUM par conectado; a falha de um par é assimétrica e aparece no tile dele (§9, 2.3) | código (`live/voz.ts`) |
| Como a credencial TURN se renova? | O ciclo de renovação de tickets (§22.1) embute o `voiceJoin` idempotente (§21.2), que devolve a sessão com a credencial recém-costurada; o evento `voice.tickets` ganha `iceServers` opcional, e o renderer aplica por `setConfiguration` — não recria conexão, não renegocia | §15.5, §17.4, emendas |

### 97.3 O que mudou no normativo

- **§15.5** — `voice.tickets` ganha `iceServers` opcional (emenda de 2026-08-30).
- **§17.4** — emenda de 2026-08-30: a credencial TURN se renova no mesmo ciclo dos tickets,
  pelo `voiceJoin` idempotente; o renderer aplica por `setConfiguration`.
- **§22.1/§22.2** — o giro da fila de karaokê sai do `voice.liveness` e vira o loop
  `voice.queueTick` (1 s, host), com a emenda na tabela.
- **§27.2** — a linha de `P2P_STUN_SERVERS` dizia *(vazio)* e a emenda de §17.2/§81.5 diz
  LIGADO desde 2026-08-25. Corrigida a tabela para o normativo emendado (o código já seguia
  a emenda; divergência em silêncio é o que ela mesma proíbe).

### 97.4 O que continua pendente — novos itens no backlog

- **B43** — reentrada automática de voz pós-respawn/queda: §17.4 declara expressamente que
  não decide; proposto: no resync de §15.2(4d) com chamada ativa, reexecutar o `voice.join`
  idempotente. Exige emenda própria.
- **B44** — `voice.meshChanged` (§15.5) sem produtor nem consumidor: remover ou ligar via
  §16.3 é decisão de superfície.
- **B45** — smoke de voz de duas instâncias com `RTCPeerConnection` real.
- **B46** — teto de conexões do host (`maxPeers`, §14.2 sem chamador): número sem medida.
- **B47** — dispositivos sem efeito em chamada (`setSinkId` ausente, troca de mic sem
  re-captura, volumes no-op).
- **B48** — fila de karaokê pós-respawn do host: todos-mudos sem evento nomeado (§6.16).
- **B49** — `voice.deviceError` sem produtor no núcleo (a captura é do renderer); o
  assinante da UI existe desde esta fatia.
- **B29, B30, B4, B17, B13, B19** seguem como estão. Para o B17, esta fatia eliminou os
  acumuladores concretos que a investigação encontrou (`#observados` sem poda, o `unsub`
  errado do IPC-R) e ligou os knobs ignorados — o sintoma continua exigindo observação em
  DHT pública por horas.

### 97.5 Evidência

`core`: build + barreira de camadas de §4 + 991 testes (10 novos:
`test/conectividade-voz.test.ts` — fail-fast do `RpcClient`, `noteHelloFailure` do
`HostStatusTracker`, `refreshSession`/renovador com `iceServers`, e os dois casos de
`unsub`). `frontend`: build, lint e 353 testes (5 novos: reentrada limpa, prazo por chamada
nos dois sentidos, reconstrução de ICE com teto, `iceServers` renovados por
`setConfiguration`, tolerância de relógio). `app`: typecheck.

---

## 98. Os dispositivos passam a valer em chamada, e o smoke de duas pontas acha o que faltava — 2026-08-30

Pedido: fechar os dois itens que §97.4 abriu e deixou como dívida direta da própria
investigação — **B47** (a tela de dispositivos escolhia, e a chamada ignorava) e **B45**
(smoke de voz com `RTCPeerConnection` real entre duas instâncias). Os dois na mesma fatia
porque são a mesma frase dita duas vezes: o que não é exercitado de ponta a ponta não vale.

### 98.1 B47 — a escolha de dispositivo passa a ter efeito na chamada em curso

O sintoma de §97.4 era literal: `setSinkId` não existia em lugar nenhum (a escolha de
SAÍDA era decoração), trocar de microfone não re-capturava nada (valia na próxima chamada,
se houvesse) e `inputVolume`/`outputVolume` não eram aplicados a nada. Três controles na
tela, zero efeito no áudio.

| O que mudou | Onde |
|---|---|
| A captura passa por um estágio de ganho: `AudioContext` → `MediaStreamSource` → `GainNode` → `MediaStreamDestination`. O que sai por malha é a saída do estágio, não a trilha crua | `live/voz.ts` (`#ctxAudio`, `#fonteLocal`, `#ganhoEntrada`, `#destinoLocal`, `#trilhaDeSaida()`) |
| `definirVolumeEntrada(p)` mexe no `gain` do estágio já montado — sem renegociar, sem tocar no par | `live/voz.ts` |
| `trocarMicrofone(deviceId)` re-captura, remonta ganho e mistura, faz `replaceTrack` em cada `RTCRtpSender`, reaplica o mudo, recria o VAD e só então para as trilhas velhas | `live/voz.ts` |
| O Modo Música consome o fluxo PÓS-ganho, e o `#streamDeSistema` fica guardado para ser remisturado quando o microfone troca no meio da música | `live/voz.ts` |
| `aplicarSaidaDeAudio` leva `setSinkId` e o volume de cada par multiplicado por `outputVolume/100` para o `<audio>` daquele par; o `<video>` da tela ganhou o mesmo tratamento | `live/sincronizacao.ts`, `features/voice/ScreenShareStage.tsx` |
| Um `useSettingsStore.subscribe(estado, anterior)` reage a `microphoneId`, `inputVolume`, `outputId` e `outputVolume` — a mudança na tela chega à chamada viva, não à próxima | `live/sincronizacao.ts` |

**A ordem de `trocarMicrofone` importa e é deliberada.** Parar as trilhas antigas antes do
`replaceTrack` abre uma janela de silêncio audível e, se a captura nova falhar, deixa a
pessoa muda sem caminho de volta. Captura-se primeiro, troca-se depois, para por último.

**`setSinkId` é guardado por `el.dataset.sinkId`.** Alguns Chromiums recusam o `setSinkId`
com o id que já está aplicado; só se chama quando de fato mudou. E `"default"` vira `""`,
que é como a API nomeia o padrão do sistema.

### 98.2 B45 — o smoke de duas pontas: dois núcleos reais, WebRTC real, mídia medida

`npm run smoke:voz` em `app/` (precisa de display — `xvfb-run -a` basta). O que ele monta:

- **DHT local de verdade.** Um `HyperDHT.bootstrapper` em loopback, com a porta reservada
  antes por `dgram`. `new HyperDHT({ bootstrap: [] })` **não** serve: não anuncia nem
  resolve, e o cenário morre na descoberta.
- **Dois `utilityProcess` reais**, do `dist/utility/index.js` do produto, com `P2P_DATA_DIR`
  separados e `P2P_DHT_BOOTSTRAP` apontando para a DHT local. Não há núcleo de mentira.
- **Duas `BrowserWindow`**, cada uma com um `MessageChannelMain` de IPC-R para o seu núcleo,
  rodando a `MalhaDeVoz` REAL do renderer sobre o cliente de IPC-R REAL — o driver
  (`frontend/src/smoke-voz/`) só empurra comandos e lê estado.
- **Mídia real**: `--use-fake-device-for-media-stream` dá um tom sintético ao Chromium, e o
  oráculo de "a mídia flui" é o delta de `bytesReceived` do `inbound-rtp` — negociação que
  fecha sem áudio passando não conta como sucesso.

As doze marcas exigidas: `DHT_LOCAL`, `NUCLEOS`, `PAGINAS`, `COMUNIDADE`, `ADMISSAO`,
`REPLICACAO`, `CONECTADOS`, `FLUXO_A_PARA_B`, `FLUXO_B_PARA_A`, `TROCA_DE_CANAL`,
`REENTRADA_LIMPA`, `FLUXO_POS_TROCA`. As três últimas são §97 sob teste: trocar de canal não
derruba a chamada nova, reentrar deixa UMA conexão por par, e a mídia volta a fluir depois
das duas coisas.

**As chaves de mídia do Chromium têm de ser ligadas ANTES do `whenReady`.** A linha de
comando dos processos de renderer é montada no boot; chave ligada depois não chega a quem
captura o áudio.

**O console das páginas sai no stdout do smoke.** Sem isso uma negociação que não fecha é um
prazo estourado sem causa — os rótulos do driver e os `[voz]` da própria malha são a única
janela para dentro do renderer.

### 98.3 O que o smoke achou no PRODUTO: a chave do host congelada em `ZERO32`

Com a sinalização finalmente correndo, o cenário travou assimétrico: as ofertas de B
chegavam a A, as respostas de A **nunca** chegavam a B. O gate de §17.4 passo 3 no núcleo de
B recusava toda sinalização vinda do host, comparando o ticket contra uma chave de host
`00000000…`.

A causa: `boot.ts` passava `hostPublicKey: projector.ds.community.hostKey` — **avaliado uma
vez, na abertura da comunidade**. A comunidade abre ANTES de o log replicar, e até
`community.create` ser interpretado (§6) `hostKey` é `ZERO32`. Quem hospeda nunca via o
defeito, porque `hostKey` já é a sua chave quando ela abre a própria comunidade. Quem entra
congelava o zero para sempre — e como **só o membro verifica ticket** (quem hospeda entrega
a si mesmo pelo fan-out de `#destinoDeSinal`, sem passar pelo gate), nenhum teste de um lado
só podia ver isso. O efeito em uso é o sintoma que abriu §97: a chamada não fecha.

A correção é uma linha de forma: `hostPublicKey` vira um *thunk*, lido **a cada quadro**. A
réplica que chega depois destrava o gate sozinha, sem reabrir comunidade e sem reiniciar
nada. `core/test/media-member.test.ts` ganhou a regressão com uma chave de host mutável
("como a réplica a enxerga"): com `ZERO32` o membro não recebe `voice.signal`; trocando para
a chave de verdade, o MESMO runtime passa a entregar.

Este é o item que justifica a fatia inteira. §97.1 dizia que os defeitos de voz de §77–§89
foram todos achados em smoke manual de duas máquinas e nenhum por teste; este foi achado
pelo smoke automatizado na primeira vez que ele rodou de verdade.

### 98.4 As decisões

| Pergunta | Decisão | Onde ficou |
|---|---|---|
| O volume de entrada é ganho no áudio ou constraint de captura? | Ganho, num `GainNode` entre a fonte e o destino. Constraint de dispositivo não é ajustável em chamada sem re-captura, e re-capturar para mexer num slider é renegociação por nada | código (`live/voz.ts`) |
| Trocar de microfone renegocia? | Não: `replaceTrack` no sender existente. A negociação de §17.4 não é refeita, os tickets valem, o par não pisca | código (`live/voz.ts`) |
| Onde entra o `outputVolume`? | No elemento de cada par, multiplicado pelo volume individual daquele par: `volumeDoPar/100 × outputVolume/100`. Um ganho global no grafo apagaria o ajuste por pessoa | código (`live/sincronizacao.ts`) |
| Como o smoke sobe uma DHT? | `HyperDHT.bootstrapper` em loopback, com porta reservada por `dgram` antes. Medido: `{ bootstrap: [] }` não anuncia nem resolve | `app/scripts/smoke-voz-nucleo.cjs` |
| O que conta como sucesso do smoke? | Bytes de `inbound-rtp` crescendo nos DOIS sentidos, e de novo depois da troca de canal e da reentrada. `connected` sozinho não conta: já houve defeito com ICE fechado e áudio nenhum | `app/scripts/smoke-voz.mjs` |
| A chave do host é valor de boot? | Não, é leitura por quadro. Qualquer coisa derivada de `fold(log)` capturada na abertura congela o estado de antes da replicação | código (`core/src/composition/boot.ts`, `core/src/l3/ipcRenderer/media.ts`) |

### 98.5 O que mudou no normativo

Nada. §17.4 já dizia que o membro verifica o ticket contra a chave do host; o defeito era de
implementação, não de texto. O B47 é a §14.4/§15.5 sendo cumprida, não emendada.

O que mudou de contrato **interno**: `startMediaRuntime` recebe `hostPublicKey` como
`() => Buffer` em vez de `Buffer`. É a forma que impede o defeito de voltar por descuido —
um chamador que passe um valor não compila.

### 98.6 O que continua pendente

- **B45 e B47 saem do backlog.** O fechamento fica aqui.
- **B43** (reentrada automática pós-respawn), **B44**, **B46**, **B48**, **B49** seguem
  abertos como §97.4 os deixou. O smoke novo é a ferramenta natural para o B43 quando ele
  for decidido — ele já exercita reentrada, só não a *automática*.
- **O smoke não cobre NAT nem TURN.** Tudo acontece em loopback: o caminho relayado de
  §17.3 e a renovação de credencial de §97 (item 14) continuam sem medida de duas pontas.
  Isso é rede real, não este ambiente.
- **Uma máquina, dois processos.** Relógios idênticos, latência de loopback, sem perda. A
  tolerância de relógio de §97 (item 9) e a reconstrução de ICE por queda de rede (item 3)
  continuam exercitadas só na unidade.

### 98.7 Evidência

`core`: build + barreira de camadas de §4 + **992 testes** (1 novo: a chave do host lida a
cada quadro, em `test/media-member.test.ts`), `typecheck`. `frontend`: build, lint e **358
testes** (5 novos, em dois blocos `B47` de `src/live/__testes__/voz.test.ts` — o que sai por
malha passa pelo volume de entrada, e trocar de microfone em chamada). `app`: build e
typecheck.

`smoke:voz`: **as 12 marcas verdes, em duas rodadas consecutivas** — mídia medida em
7609 B / 11278 B / 11396 B na primeira e 11315 B / 11470 B / 10293 B na segunda (A→B, B→A e
pós-troca). `smoke:fechamento`, `smoke:token` e `smoke:captura` verdes, este último com o
cenário de janelas **não medido** de sempre (sob Xvfb não há gerenciador de janelas).

## 99. A conectividade entre operadoras, relida: a L-11 eram duas falhas e uma garantia falsa — 2026-08-30

**Gate de entrada:** §80 mediu a L-11 entre operadoras e §81 ligou o STUN de terceiro; §97
corrigiu o que matava a voz por dentro. **Resultado:** a investigação não achou um defeito
novo de código — achou **duas afirmações erradas no normativo** e **um diagnóstico que somava
falhas de causas opostas**. Suítes: núcleo **992**, frontend **368**.

Esta fatia é de leitura, não de implementação. O que ela entrega em código é pequeno de
propósito: o que faltava para a investigação seguir era o produto **dizer qual** das falhas
está acontecendo, e ele não dizia.

### 99.1 A pergunta, e por que a resposta de §80 não bastava

§80 concluiu, corretamente, que entre operadoras o ICE juntava só candidato `host` e que
isso era a L-11 acontecendo. §81.2 acrescentou que o TURN do host não resolvia a L-11,
porque o Allocate chega tão não solicitado quanto o Binding Request. As duas afirmações são
verdadeiras. O erro foi tratá-las como a história inteira.

**São duas falhas, e §80 só mediu uma.**

| | **(a) Host inalcançável** | **(b) Membro sem furo** |
|---|---|---|
| Atrás do NAT ruim | o host | um membro |
| Sintoma no ICE | **nenhum `srflx`** | **`srflx` dos dois lados**, nenhum par válido |
| Causa | o NAT do host descarta o Binding não solicitado | mapeamento **dependente do destino**: o endereço que o STUN devolveu não vale para o par |
| STUN de terceiro | resolve | não resolve |
| **TURN do host** | **não resolve** — §81.2 | **resolve, e é a única saída** |

O que §80 mediu foi (a): "quatro `candidato host udp`, quatro `host tcp`, nenhum `srflx`".
Com o STUN de terceiro ligado desde §81.5, (a) tem saída — e o que sobra em campo passa a
ser (b), que §80 nunca observou porque naquela medida ninguém chegava a ter `srflx`.

**A consequência prática, e ela é grande.** Em (b), quem hospeda está alcançável e o TURN
dele funciona: o membro atrás do CGNAT abre o fluxo, e o NAT dele deixa a resposta voltar
porque foi ele quem a pediu. O produto **tem** esse TURN — com credencial costurada em
`voiceJoin`, permissão por IP fechada em §95, e teste de loopback ponta a ponta — e
**não o anuncia**, porque §81.2 concluiu "não resolve a L-11" e o default virou
`P2P_TURN_ANNOUNCE=0`. Para (b) essa conclusão é falsa. A chamada falha por política.

Isto não virou "ligar o anúncio". `B4` continua sem medida em rede real, e §17.3 registra
que anunciar o não medido quebrou chamada em 2026-08-28. O que mudou é que o default deixa
de ser justificado pela L-11 e passa a ser justificado pela **falta de medida** — que é o
que ele sempre foi, e agora está escrito.

### 99.2 A garantia de privacidade de §17.2 não existe

A emenda de 2026-08-25 ligou o STUN de terceiro por default sustentada em três guardas. A
primeira dizia: *"o ICE tenta em ordem; quando o do host resolve, o de terceiro não é
consultado e o IP não sai da comunidade"*.

**Não é assim que o ICE funciona, e não é assim que o Chromium o implementa.**

- RFC 8445 §5.1.1.2: *"The agent pairs each host candidate with the STUN or TURN servers with
  which it is configured or has discovered by some means."* Cada servidor é pareado com cada
  candidato de host. Não existe "o primeiro que resolver".
- libwebrtc, que é o agente deste produto: `UDPPort::SendStunBindingRequests()` percorre
  `server_addresses_` e manda um Binding Request para **cada** entrada. E o tipo é
  `typedef std::set<rtc::SocketAddress> ServerAddresses` — **a ordem do array `iceServers` é
  descartada na entrada**, não apenas ignorada na saída.

Com um STUN de terceiro configurado, ele vê o IP de quem entra em chamada **em toda chamada**,
inclusive nas que o host resolve. §25.4 avaliou um custo que não é o custo real. A guarda 1
foi revogada em §17.2; as guardas 2 e 3 continuam válidas e têm teste.

**A propriedade era boa; o mecanismo é que não era.** A primeira versão desta fatia parou
aqui e devolveu a escolha ao operador. Isso foi conservadorismo mal colocado: §17.2 **já
declara** a garantia como requisito, e o que faltava não era decidir se ela vale — era
implementá-la. Fazer o código cumprir o que a spec promete não é inventar comportamento; é
o contrário. A coleta em duas fases saiu em §99.13, e `B50` fecha com ela.

### 99.3 O aviso de §17.2 estava calado exatamente na chamada em que importava

`contarTerceiros` identificava o host por posição: `servers[0]`. Mas `MediaHost.iceServers()`
devolve `[...doHost, ...terceiros]`, e **`doHost` é vazio quando não há endereço público
observado** — que é a L-11, o caso que a emenda de 2026-08-25 existe para socorrer. Nesse
caso `servers[0]` é o primeiro terceiro, ele era tomado por host, e a conta dava **zero**.

Com o default (um STUN de terceiro), a chamada em que o terceiro é o **único** servidor em
uso era exatamente a chamada em que o aviso de privacidade não saía. Havia três testes sobre
esta função e nenhum cobria a lista sem host — porque a suíte foi escrita a partir do caso
que se tinha em mente, que era o host presente.

Corrigido em dois passos. Primeiro sem tocar no fio: o host é reconhecido pelo `turn:`
quando ele existe (§17.3 — "não há TURN de terceiro e não haverá", e o parser descarta
`turn:`) e pela forma literal do endereço quando não. Sobrava a borda "terceiro configurado
por IP literal, sem `turn:`". Depois, ao implementar a fase 1 (§99.13), ficou claro que
**dois** consumidores precisavam da mesma resposta e nenhum podia inferi-la — então o núcleo
passou a carimbar `terceiro: true`, e a adivinhação acabou. `B53` fecha aqui.

### 99.4 O diagnóstico somava falhas que pedem ações opostas

A mitigação declarada da L-11 é *"diagnóstico de rede + estado `conn-failed`"*. O diagnóstico
tinha **um** teste — todos os candidatos são `host` — e mandava o resto para "Não foi possível
estabelecer a conexão". Ou seja: (a) tinha texto próprio e (b) caía no genérico, junto com
UDP bloqueado e com relay que falhou.

Pior: o texto de (a) é *"quem hospeda a comunidade não está alcançável de fora da rede dela"*.
Quando o caso é (b), essa frase manda a pessoa consertar a máquina errada — o host está bem, e
quem tem o NAT ruim é quem está lendo.

O renderer passa a derivar um motivo nomeado (`motivoDaFalha`, pura e testada) com seis
códigos: `sem-candidatos`, `sem-endereco-publico`, `so-ipv6-local`, `furo-falhou`,
`turn-nao-alocou`, `relay-falhou`. A tabela está em §17.3. E o log de falha passa a carregar
os dois eixos que a investigação precisa — tipos de candidato **e famílias de endereço** —
mais se havia `turn:` anunciado.

### 99.5 IPv6 não aparecia em lugar nenhum, e é a travessia que não custa servidor

Um endereço IPv6 é roteável fim a fim. Não há tradução, não há mapeamento a descobrir, o par
`host`↔`host` fecha direto e **a L-11 não se aplica**. O Brasil passou de 50% de adoção de
IPv6 em 2024 (NIC.br / Internet Society), e Vivo, Claro, TIM, Oi e Algar têm IPv6 em produção
— incluindo móvel, que é onde o CGNAT é universal.

O `RTCPeerConnection` já coleta candidatos IPv6 sozinho quando a máquina tem endereço global.
O que faltava era o produto **registrar** se coletou: `familiaDoCandidato` lê o campo 4 da
linha `candidate:` de SDP (e não `candidate.address`, que vem `null` quando o navegador
ofusca), distingue `ipv4`, `ipv6` e `mdns`, e alimenta o diagnóstico. Sem isso, "a chamada
não fechou" e "a chamada não fechou e nenhum dos lados tinha IPv6" eram a mesma linha de log.

**O que o produto não faz, agora declarado (L-15, `B51`).** O serviço STUN/TURN do host é
IPv4-only: `xorAddress` escreve família `0x01` fixa, o decodificador recusa `0x02`, o parser
faz `split('.')` e a socket relayada abre como `udp4`. A restrição não nasce ali — o endereço
público vem de `dht.host`/`dht.port` do `hyperdht`, que é IPv4. Um par IPv6↔IPv6 fecha sem
nada disso; o que não existe é o host **servindo** em IPv6.

### 99.6 `diag.run` diz `moderate` para um host que não serve STUN

`classificarNat` traduz a observação do `hyperdht` em `open`/`moderate`/`cgnat`, e mapeia
`firewalled: true` + `host` estável + `port > 0` para `moderate`, com a justificativa "o
mapeamento externo é o MESMO para observadores diferentes".

A justificativa está certa e é **sobre a coisa errada**. RFC 4787 separa dois comportamentos
de propósito: REQ-1 é **mapeamento** (o endereço externo muda por destino?) e REQ-8 é
**filtragem** (entra datagrama de quem eu nunca contatei?). O `hyperdht` observa só o
primeiro. Quem decide se o Binding Request do WebRTC entra é o segundo.

Então o host de §80 — cujo STUN não respondeu — pode ter sido classificado `moderate` o tempo
todo. O diagnóstico tranquiliza e a chamada não fecha. Classificar filtragem exigiria um
observador externo que mandasse um datagrama não solicitado de um endereço nunca contatado:
infraestrutura que este produto não tem e que §25.4 não autoriza. Fica declarado no módulo
como o que a medida **não** cobre.

### 99.7 A causa registrada em 2026-08-28 não sobrevive à releitura do código

A emenda que desligou o anúncio do TURN registrou: *"como §17.4 repete a oferta a cada
`REPETIR_OFERTA_MS` enquanto um par não responde, cada repetição reinicia o ICE antes de ele
convergir"*.

Isso não acontece. `#tentarNegociacoesParadas` chama `#ofertar`, que faz `createOffer()`
**sem** `iceRestart`, na **mesma** `RTCPeerConnection` — uma oferta assim reusa o par
ufrag/pwd e não reinicia coleta nenhuma. E a malha é trickle desde sempre: `onicecandidate`
sinaliza cada candidato no instante em que ele aparece, então coleta inacabada nunca segurou
a oferta.

A outra metade da causa **se sustenta e basta**: contra um TURN que não responde, o Chromium
só desiste do `TurnPort` depois de perto de um minuto e meio de retransmissões, enquanto
`PRAZO_DE_CONEXAO_MS` vence em 20 s. O produto declarava `conn-failed` antes de o candidato
`relay` ter chance de existir. Deixar assim tornaria a medida de `B4` desonesta: ela mediria
o relógio, não o relay.

Corrigido: o prazo estica **uma vez** (45 s) quando há `turn:` anunciado, nenhum `relay`
coletado e alguma coleta em andamento. Sem `turn:` anunciado — o default — nada muda, e a
L-11 continua falhando em 20 s como em §80.

Registrar isto importa por um motivo além do técnico: uma causa errada no normativo é uma
decisão de default apoiada em nada. O default continua o mesmo; a razão dele mudou.

### 99.13 A guarda 1 não foi removida — foi implementada

A primeira volta desta fatia revogou a guarda 1 de §17.2 e mandou a decisão para o backlog.
Errado, e vale registrar por quê: **§17.2 já declara a garantia como requisito**. O que
faltava não era alguém decidir se o IP deve ou não sair da comunidade — isso está decidido no
normativo desde 2026-08-25 — era o código cumprir o que a spec promete. Devolver isso como
pergunta foi confundir "a justificativa está errada" com "a decisão está em aberto".

**A propriedade era boa; o mecanismo é que não era.** Ordenar a lista nunca poderia dar a
garantia, porque o agente recebe todos os servidores de uma vez. O que dá é **não entregar**
o terceiro ao agente até saber que o host não resolve:

| Fase | O que vai ao `RTCPeerConnection` | Sai quando |
|---|---|---|
| **1** | só as entradas sem `terceiro: true` | apareceu `srflx`/`relay` → **fim, terceiro nunca consultado**; ou vencem 2,5 s |
| **2** | a lista inteira, por `setConfiguration` + `restartIce` | o de sempre |

Não é invenção de mecanismo: `setConfiguration` seguido de ICE restart é o caminho que a
WebRTC 1.0 documenta para trocar servidores ICE, e o produto **já o usa** na renovação de
credencial de §98. O que mudou é quando ele é acionado.

**Três decisões, e o custo de cada uma:**

1. **Fase 1 pulada quando o host não contribui com nada.** Sob L-11 pura não há o que tentar
   primeiro. Cobrar 2,5 s de quem está justamente no caso que o terceiro existe para
   socorrer seria taxa sem contrapartida — e é o caso em que a chamada hoje conecta rápido.
2. **O sinal de sucesso é `srflx`, não `host`.** `host` existe sempre e não prova que
   servidor nenhum respondeu.
3. **A renovação não desfaz a fase.** `voice.tickets` traz a lista inteira a cada TTL/3, e
   aplicá-la crua entregaria o terceiro antes de o host falhar — em chamada longa, isso
   anularia a fase 1 poucos segundos depois de ela começar.

**O custo real, declarado:** 2,5 s a mais para conectar **apenas** no caso (a) de §17.3 —
host COM endereço público cujo STUN não responde por filtragem. Nos outros três casos
(host resolve; host sem endereço; sem terceiro configurado) o custo é zero.

**O campo `terceiro` no `IceServer`.** Aditivo, opcional, e existe porque **posição não
identifica o host**: a lista é `[...doHost, ...terceiros]`, `doHost` é vazio sob L-11, e aí
o terceiro é `servers[0]`. Dois consumidores dependiam disso e os dois adivinhavam —
a fase 1 e o aviso de §17.2. §15.4 e §16.3 declaram `iceServers[]` sem enumerar os campos de
uma entrada, e o WebIDL ignora propriedade extra num `RTCIceServer`, então o renderer segue
repassando a lista sem filtro.

Os testes foram conferidos por mutação: desligando a fase 1, quatro deles falham.

### 99.8 O que foi entregue

| Entrega | Onde |
|---|---|
| `motivoDaFalha` — seis códigos derivados do que o ICE coletou | `frontend/src/live/voz.ts` |
| `familiaDoCandidato` — `ipv4`/`ipv6`/`mdns` a partir da linha de SDP | idem |
| `contarTerceiros` para de supor que `servers[0]` é o host | idem |
| Prazo de L-11 estica uma vez quando há `turn:` e falta `relay` | idem |
| Aviso de §17.2 deixa de sugerir que o terceiro "nem é consultado" | idem |
| A ordem de `iceServers` deixa de ser declarada como garantia de privacidade | `core/src/composition/media.ts` |
| A causa de 2026-08-28 corrigida no comentário que a repetia | idem |
| `classificarNat` declara que mede mapeamento, não filtragem (RFC 4787) | `core/src/l2/diagnostics/index.ts` |
| **Coleta em duas fases** — a garantia de §17.2 passa a existir (`separarPorOrigem`, `#escalarParaFaseDois`, `PRAZO_DA_FASE_UM_MS`) | idem |
| A renovação de `iceServers` passa a respeitar a fase corrente | idem |
| `terceiro?: boolean` carimbado pelo núcleo em `IceServer`/`IceServerDto` | `core/src/l2/voiceCoordinator/host.ts`, `core/src/composition/media.ts`, `frontend/src/ipc/api.ts` |
| `contarTerceiros` usa a marca quando ela existe — fim da adivinhação | `frontend/src/live/voz.ts` |
| 21 testes novos (a L-11 sem host, o `turn:` como identificador, as seis causas, as famílias, as duas fases) | `frontend/src/live/__testes__/voz.test.ts` |

### 99.9 O que mudou no normativo

| Mudança | Onde |
|---|---|
| A guarda 1 de §17.2: a **justificativa** corrigida (ordem nunca deu a garantia) e a **propriedade implementada** por coleta em duas fases | §17.2, §17.3 |
| `IceServer` ganha `terceiro?: boolean` — aditivo e opcional | §17.3, §15.4 |
| A L-11 separada em L-11 (host) e **L-11b** (membro) | §17.3, §25.5 |
| **L-15** declarada: STUN/TURN do host é IPv4-only | §25.5 |
| Tabela de códigos de `conn-failed` | §17.3 |
| O prazo de `conn-failed` e o TURN anunciado | §17.3 |
| Proposta de TURN sobre a conexão UDX que já atravessa — **não implementada** | §17.7 |

### 99.10 O que continua pendente

- **`B4` não foi tocado.** Nada aqui substitui a medida em CGNAT real; o que mudou é que ela
  agora tem como distinguir (a) de (b) e não vence o próprio prazo antes de o relay abrir.
- **`B50` e `B53` fecham aqui**, em §99.13: a garantia de §17.2 passou a ser cumprida pela
  coleta em duas fases, e o carimbo `terceiro` acabou com a adivinhação por posição.
- **Novos: `B51`** (IPv6 no serviço do host — **verificado**: `dht-rpc` fixa `family: 4` em
  `localIP()` e no `lookup()`, então a restrição é upstream e não deste repositório) e
  **`B52`** (a proposta de §17.7, que é mudança de arquitetura e continua sendo do operador).
- **`B30` não fechou**, e a proposta de §17.7 é o caminho que fecharia as três lacunas dele
  de uma vez — se o operador a decidir.
- **Nada disto foi medido em rede real.** É releitura de código, de RFC e da fonte do
  libwebrtc. O plano de teste de duas máquinas está em §99.11 e é do operador.

### 99.11 O plano de teste que separa as causas — para duas máquinas em operadoras diferentes

O objetivo não é "a chamada fechou?". É **descobrir qual das seis causas está acontecendo**,
e cada rodada isola uma variável. Rodar nesta ordem; parar quando fechar e registrar em qual
rodada fechou.

**Preparo, nas duas máquinas.** Abrir o DevTools do renderer (é onde o log `[voz]` sai — o
stdout do Electron não tem para onde ir numa instalação de Windows). Anotar, antes de
qualquer chamada: o resultado de `diag.run` (`natType`, `stunReachable`, `relayAvailable`),
se a máquina tem IPv6 global (`ip -6 addr` no Linux, `ipconfig` no Windows — um endereço
que não comece em `fe80:`), e a operadora de cada ponta.

**O teste de CGNAT que não precisa de medida nenhuma: `100.64.0.0/10`.** É a faixa que a
RFC 6598 reserva para *Shared Address Space*, e é o que as operadoras entregam ao CPE quando
estão em CGNAT — Vivo Fibra e Claro/NET aplicam CGNAT por default no residencial e usam
exatamente essa faixa. Basta abrir a interface do roteador e olhar o **IP da WAN**:

| WAN do roteador | Leitura |
|---|---|
| `100.64.x.x` – `100.127.x.x` | **CGNAT confirmado.** Nenhuma porta é alcançável de fora; este lado não serve STUN/TURN nem com encaminhamento de porta |
| IP público normal | Sem CGNAT. Se este for o lado que hospeda, o caso (a) está descartado e o que sobra é (b) |
| `192.168.x.x` / `10.x.x.x` na WAN | Há um segundo roteador antes (NAT duplo) — subir mais um nível antes de concluir |

Isso responde de graça a pergunta mais cara do plano: **quem, dos dois, está atrás de
CGNAT**. Se for só quem *chama*, o caso é (b) e a rodada 3 deve fechar a chamada. Se for
quem *hospeda*, é (a) e a rodada 3 não vai adiantar — o que resolve ali é trocar quem
hospeda (rodada 5) ou o relay voluntário, que não existe.

| # | Rodada | Como | O que ela responde |
|---|---|---|---|
| 0 | **Linha de base** | Chamada normal, default de hoje | Colher o `FALHOU [codigo]` — ele já nomeia a causa. Todas as rodadas seguintes se justificam por ele |
| 1 | **IPv6 existe?** | Ver no log se apareceu `familias: ... ipv6` nas duas pontas | Se as duas têm IPv6 e a chamada não fecha, a causa não é NAT — é filtro IPv6 no roteador, e é outra investigação |
| 2 | **Sem terceiro** | `P2P_STUN_SERVERS=""` nos dois | Se some o `srflx`, confirma que o `srflx` vinha do terceiro e o STUN do host não serve — **(a)** |
| 3 | **TURN anunciado** | `P2P_TURN_ANNOUNCE=1` **na máquina que hospeda** | **A rodada decisiva.** Se a chamada fecha, a causa era **(b)** e o default é o que a bloqueia. Esperar até 65 s — o prazo agora estica |
| 4 | **Confirmar o relay** | Na rodada 3, procurar `candidato relay` no log e o par selecionado nas `getStats` | `relay` coletado e conectado = o TURN do host funcionou em rede real. **É a evidência que `B4` pede** |
| 5 | **Trocar quem hospeda** | Repetir a 0 com a outra máquina hospedando | Se fecha invertido, o problema é o NAT de uma máquina específica, não do par |
| 6 | **UDP bloqueado?** | Repetir a 0 numa das pontas em 4G/roteamento móvel | `sem-candidatos` que vira `furo-falhou` no celular = a rede fixa bloqueia UDP |

**O que colher de cada rodada, sem exceção:**

1. A linha `FALHOU [codigo] · candidatos: … · famílias: … · turn anunciado: …` das **duas**
   pontas. As duas, porque as causas são assimétricas: uma ponta pode ter `srflx` e a outra não.
2. Todas as linhas `par XXXXXXXX · candidato <tipo> <proto> <familia>`.
3. `join ok · sessão … · iceServers` — a lista efetivamente entregue, para conferir se o
   `turn:` saiu com `username`/`credential`.
4. A linha `coleta ICE complete` — se ela não aparece, a coleta ainda estava correndo quando
   o prazo venceu.
5. O `diag.run` das duas pontas, **antes** da chamada.

**Duas leituras que o log agora permite e antes não:**

- `furo-falhou` nas duas pontas com `srflx` nas duas = **(b)** confirmado. Não adianta mexer
  em STUN; é relay ou nada.
- `sem-endereco-publico` numa ponta e `srflx` na outra = o NAT assimétrico é de quem reportou
  `sem-endereco-publico`.

**O que este plano NÃO responde, e por quê.** Nenhuma rodada distingue *NAT simétrico* de
*firewall que bloqueia UDP para portas altas* — as duas produzem `furo-falhou`. Separá-las
exige um observador externo que mande um datagrama não solicitado de um endereço nunca
contatado, que é a mesma infraestrutura que §99.6 diz não existir aqui. Se a rodada 3 fechar
a chamada, a distinção deixa de ter consequência: o relay resolve as duas.

### 99.12 Evidência

`core`: build + barreira de camadas de §4 + **992 testes**, `typecheck`. `frontend`: build,
lint e **378 testes** (21 novos em `src/live/__testes__/voz.test.ts`), com os da fase 1
conferidos por mutação — desligando a fase, quatro falham. Nenhum smoke novo: o
que esta fatia mudou só se mede em duas operadoras, e isso é §99.11.

**Fontes externas consultadas** (as afirmações de §99.2 e §99.6 não saem de memória):
RFC 8445 §5.1.1.2; RFC 4787 REQ-1/REQ-8; `p2p/base/stun_port.cc` e `p2p/base/port.h` do
libwebrtc (`SendStunBindingRequests`, `typedef std::set<rtc::SocketAddress> ServerAddresses`);
NIC.br / Internet Society sobre os 50% de IPv6 no Brasil.

---

## 100. B54 — o `dmCodec` e o `dmFold`, e as três coisas que §31 não carregava — 2026-09-01

Pedido: implementar B54, os dois módulos L1 puros da conversa direta. Nada de rede, nada de
banco, nada de relógio: é o que torna B55 (G14) possível, porque é exatamente este código que
o gate mede.

### 100.1 O que entrou

`core/src/l1/dmCodec/` — `DM_VERSION = 1`, o envelope de §31.4 (`DmOp`/`DmEnvelope`, **sem**
`HostRecord`, `hostTs`, `hostSig` ou `flags`), o registry dirigido pela tabela de §31.5 com os
6 `kind`s, as derivações de §31.2 e §31.3 (`dmConversationId`, `dmCorePossessionHash`,
`dmNonce`, `seal`/`open` XChaCha20-Poly1305 com o cabeçalho como AAD) e `peekDmHeader`.

`core/src/l1/dmFold/` — `DmState` e o `DmDraft` copy-on-write, a ordem canônica de §31.6
(`ordSum`, `ordKey`, o merge de dois ponteiros), o pipeline de 13 estágios de §31.7.3, as onze
`RD-*` de §31.7.4, os limites de §31.7.5 e as quatro formas de `DmEffect` de §31.7.6.

`idgen` ganhou `dmEntityId` (prefixo de domínio `id/dm-message/1`, prefixo de id `dmsg-`) — é
a única entidade de DM com id próprio. `scripts/check-layers.ts` ganhou as duas linhas de §4:
`dmCodec` com "Depende de" **vazia** e `dmFold` com exatamente `dmCodec, idgen, errors`.

### 100.2 As três duplicações que §4 obriga, e por que nenhuma é preguiça

`dmCodec` não pode importar `opCodec`, e `dmFold` não pode importar `fold`: a coluna "Depende
de" de §4 é vazia num caso e tem três nomes no outro, e o `check-layers` do `npm run build`
quebra na importação lateral. Isso obriga três cópias — os primitivos de fio de §7.2.1, os
limites de campo de §8.6 e o teto de registro —, e a obrigação é a **decisão** de §31.0: a
conversa direta tem registro e versão próprios, e um bump de `opVersion` não pode arrastá-la
junto.

O que impede a segunda cópia de envelhecer é teste, não disciplina: `dm-fold-rules` compara
`DM_LIMIT` com `LIMIT` e os quatro tetos com os do `fold`, campo a campo. Se alguém mudar um
número num lado só, ele fica vermelho.

`dmCodec.test` também fixa a colisão de números entre os dois catálogos (`dm.message` = 3 e
`message.delete` = 3) como **esperada**, para que ninguém a "conserte" unificando os dois.

### 100.3 O que a spec não carregava — B66 e B67

Três lacunas apareceram na implementação. Duas não têm segunda leitura possível e foram
fechadas no ponto, como `communityInvalid` e `originFinalSeq` já haviam sido em §17 e §27; a
terceira é decisão normativa e **não** foi decidida aqui.

**(a) RD-1 não é implementável com o `DmContext` de §31.7.1.** A regra manda verificar o
`coreProof` sobre `BLAKE2b('dm-core-possession/1' ‖ conversationId ‖ chaveDoCore)`, e a chave
do core não viaja no registro: §31.5 dá ao `dm.hello` `peerKey · coreProof · displayName ·
avatarColor`, e `peerKey` é a outra chave de **identidade**, não um core. A chave do core é a
do core que se está lendo — o nó a conhece por construção e a aprendeu do `dmHello` de §31.8,
que a carrega. `DmContext` ganhou `loCoreKey`/`hiCoreKey`; ausentes, a gênese daquele lado é
recusada, porque o `dmFold` não presume o que não pode verificar.

**(b) `clockSkewed` precisa de um `ts` que `SideState` não guarda.** §31.6 o define como "o
`ts` é menor que o `ts` do registro mais recente que ele reconhece por `ack`" — o registro do
**outro** lado no índice `ack − 1`. `lastTs` não serve: na ordem canônica ele pode ser o de um
índice maior, e usá-lo marcaria `clockSkewed` onde não há impossibilidade causal nenhuma.
`SideState` ganhou uma janela `tsWindow`/`tsWindowBase`, podada pelo `ack` do outro lado —
que é não decrescente por RD-4, então a janela é do tamanho do **atraso**, não da conversa.
Há teste que a prende em ≤ 4 entradas ao longo de 300 registros.

**(c) RD-11, como está escrita, não é verificável.** `dmBlobsSeed` deriva do `identitySeed`
(§31.3) e a chave resultante não é declarada em lugar nenhum — nem no payload de §31.5, nem no
handshake de §31.8, e o catálogo de 6 `kind`s é fechado. Conferir só sobre o próprio lado
tornaria a regra assimétrica e faria as réplicas divergirem, contra §31.1. O que entrou é a
única forma determinística e simétrica que não muda o fio: o **primeiro** anexo de um lado
vincula a chave e os seguintes precisam repetir. Isso fecha "cada anexo aponta para um core
diferente" e **não** fecha o caso que RD-11 nomeia. Registrado como **B66**; (a) e (b) como
**B67**, que é a emenda de duas linhas nos schemas.

### 100.4 Duas leituras do pipeline que valem registrar

**RD-1 roda em dois lugares, e é assim que a ordem de §31.7.3 pede.** O estágio 6 vem antes do
8 (AEAD) e do 9 (payload), então ali só dá para conferir a parte de cabeçalho da gênese —
`kind`, `authorSeq = 1`, `ack = 0`. `peerKey` e `coreProof` são conferidos no handler de
`dm.hello`, no estágio 11, com o mesmo desfecho e a mesma marca de lado `invalid`.

**O planejador do merge não decodifica payload.** Ele lê `ack` do cabeçalho em claro, que é
exatamente o que §31.4 diz que o cabeçalho em claro compra. Pagar um Ed25519 e um AEAD por
registro só para descobrir a ordem transformaria o merge de dois ponteiros num fold completo.
O clamp de RD-4 é o mesmo nos dois caminhos, e um registro cujo cabeçalho não decodifica
herda o `ack` anterior — é o que mantém planejador e `dmFold` de acordo sobre o `ordSum` de um
registro que vai ser `IGNORED`.

### 100.5 Evidência

`core`: `npm run build` (typecheck + barreira de §4, **101 arquivos**, L1 com 8 módulos) e
`npm test` — **1085 testes**, 88 deles novos: `dmCodec` (19), `dm-fold-pipeline` (27),
`dm-fold-rules` (28), `dm-merge-determinism` (10) e `dm-fold-totality` (5, incluindo o fuzzer
de 60 000 registros hostis com `panic = 0`, que é o ensaio do critério 2 de G14).

**Quatro testes seguem vermelhos, e eles são anteriores a esta fatia**: `errors.test` cobra os
90 códigos de §20.2 contra os 86 de `codes.ts` (os quatro de §31.17 são B57/B59) e
`projector-parity` cobra as tabelas `dm_*` de §31.12 contra o schema de `view.db` (B56). Os
dois medem a distância entre a spec de 2026-09-01 e a implementação, que é o caminho
B55..B59 — nenhum deles é sintoma de B54, e conferi isso repondo a árvore sem esta fatia.

### 100.6 O que NÃO entrou, e é deliberado

Sem `dmProjector`, sem tabela, sem `manifest.db`, sem `outbox` (não existe, §31.10), sem
`HostRecord` (não existe host), sem os quatro códigos de erro de §31.17 (o pipeline de §31.7.3
não usa nenhum deles) e sem nada de §31.8 em diante. B55 é o gate, e ele mede este código
antes de qualquer coisa se apoiar nele.

---

## 101. B55 — G14, e as cinco respostas que ele trouxe — 2026-09-01

Pedido: implementar B55, o harness do gate G14 em `poc/poc-14-g14`. É o gate que decide se a
conversa direta entra na fase 11 — reprovar em (1) ou (3) reabre A29 — e ele bloqueia B56 em
diante.

### 101.1 A regra que organiza o harness

Duas metades, e a linha entre elas é o que separa um gate de uma tautologia.

**O que o gate mede é do produto.** `dmFold`, o merge de §31.6, o pipeline de 13 estágios,
`dmCodec` — tudo importado de `core/dist/src/l1/`, pelo mesmo padrão de ponte que o
`poc-12-g12` usa. Um segundo `dmFold` dentro do `poc/` mediria o harness. O cabo que
**escreve** o registro é `core/dist/test/helpers/dm.js`, o mesmo do ensaio de unidade, para
que o corpus do gate e o da suíte falem do mesmo material.

**O que ainda não existe é descartável, e fica dentro do harness.** O `dmProjector`, o
snapshot de `dm_ds_snapshot`, as tabelas `dm_*` e o `self_high_water` de `manifest.db` são
B56 e B57 — os dois **bloqueados por este gate**. Os cenários 2, 4 e 5 precisam deles para ter
o que medir; construí-los como código de produto antes do veredito inverteria a ordem que
§31.26 fixa.

### 101.2 Os cinco critérios, e o que cada um deu

Todos **aprovados** no escopo medido; o gate sai **parcial** pelos `openCriteria`, no padrão
de G7/G8/G12.

1. **Determinismo do merge.** O par de logs do roteiro — escrita concorrente, `ack` mentiroso
   (L-27), `ts` retroativo, referência quebrada e quatro registros hostis **dentro** dos
   logs — entregue em 240 intercalações diferentes, mais o nó que recebe os dois logs
   prontos: **um único hash de dump**. E o `ordSum` de cada `(origin, index)` é o mesmo em
   todo prefixo do par.
2. **Totalidade.** 10⁷ registros hostis, doze sabotagens (uma por estágio de §31.7.3):
   `dmFold.panic = 0`, zero desfecho fora dos três, zero `APPLIED`, zero recusa sem código de
   §31.7.3, zero efeito emitido em recusa.
3. **Convergência após partição.** Dois nós reais numa `hyperdht/testnet`, quatro cores de
   verdade, os dois cores de cada nó no mesmo socket. Escrita dos dois lados durante a
   partição, hashes divergentes enquanto ela dura, reconciliação **sem intervenção**: hash do
   nó A = hash do nó B = referência.
4. **Core encurtado.** A detecção acontece antes de qualquer append, e a pergunta aberta de
   §31.13 tem resposta — ver §101.3.
5. **Sem fork sob `SIGKILL`.** Quatro pontos do caminho de append, com o par replicando a cada
   volta: zero fork, e o caminho de escrita se recusando a appendar em `desynced` por conta
   própria.

**A29 não reabre.** A barreira de §31.10 basta para falha de processo, e a emenda que o
critério 5 ameaçava exigir não é necessária.

### 101.3 `ACHADO-G14-01` — `desynced` não é terminal, e L-25 não ganha a segunda metade

§31.13 marca `REQUIRES POC` a afirmação de que um escritor pode recompor o **próprio** core a
partir de um par sem antes appendar, e proíbe implementar a saída automática antes de
medi-la. **Medido, e ela se sustenta**: o escritor reabre curto, conecta ao par, o `download`
traz os blocos que faltam assinados pela própria chave dele, eles conferem byte a byte, o
append seguinte é aceito no índice certo e o par lê o bloco novo. Zero conflito.

O contrafactual foi medido junto (`ACHADO-G14-02`): o mesmo escritor appendando **antes** de
recompor produz dois blocos diferentes no mesmo índice com a mesma chave, e o `hypercore` não
mescla nem escolhe — as duas pontas emitem `conflict` e fecham a sessão. A ordem "grava
`self_high_water`, compara, só então appenda" não é conservadorismo.

O resultado vale para a versão exata de `hypercore` registrada no artefato.

### 101.4 `ACHADO-G14-05` — `desynced` sem perda nenhuma, e a decisão que sobra para B57

`self_high_water` é gravado **antes** do append. Um `SIGKILL` na janela entre as duas coisas
deixa `core.length = self_high_water − 1`, e a regra de boot lê isso como `desynced` — mas
nada se perdeu: o bloco nunca existiu, e o par também não o tem. **A saída (1) do mesmo
parágrafo não resolve este caso**, porque não há de onde restaurar.

O critério 5 passa (nenhum fork existiu). O que o gate acrescenta é que a regra é conservadora
**demais** nessa janela: ou o boot distingue "append pendente que não landou" de uma perda de
verdade, ou o `self_high_water` passa a ser gravado de outra forma. **Registrado, não
decidido** — é de B57.

### 101.5 O custo, que é entrada para B56

`ACHADO-G14-03`: o snapshot é **custo, não semântica** — com e sem ele a reinterpretação
converge para o mesmo hash. E há um caso em que ele não ajuda por definição: quando a inserção
retroativa é o log do par chegando inteiro depois, o ponto de inserção é o começo da conversa
e não existe snapshot anterior a ele.

`ACHADO-G14-04`: reinterpretar do zero é **super-linear** — a cópia-na-escrita do `DmDraft` é
por container, então o registro que toca `messages` clona o `Map` inteiro. Não é desvio de
§31.7.2 (é o arranjo que ela escolhe, o mesmo do `fold` de §8) e não reprova critério nenhum.
**Nada foi alterado em `core/` por causa disso**: o gate não reprovou, e `core/` não se altera
para um gate passar. É exatamente o que o snapshot existe para não deixar aparecer no boot.

### 101.6 Três vezes o mesmo erro de harness, e por que ele vale registro

O corpus precisou **garantir** o desvio em três geradores, não sorteá-lo: `content` acima do
teto de §31.7.5 e não `% 9000`; gênese com `authorSeq`/`ack` forçados fora da forma de RD-1; e
truncar ao menos um byte. Sorteados, os três às vezes produziam um registro **válido** — e um
registro válido não é sabotagem, então "todo registro hostil termina em `REJECTED` ou
`IGNORED`" deixava de ser verificável. O PRNG também precisou devolver os bits **altos**: os
baixos de um LCG têm período curto, e `% 12` sobre o valor cru concentrava o corpus em três
sabotagens. Um fuzzer que mede o próprio gerador não mede o `dmFold`.

### 101.7 Evidência

`poc/poc-14-g14`: `npm run build`, `npm run gate:quick` e `npm run gate`. O artefato do perfil
full está versionado em `out/gate-G14/gate-G14.json`, com ambiente, versões, lockfile, as
métricas de POC-14 (hash de dump por nó e por ordem de entrega, `dmFold.panic`, desfecho por
sabotagem, `ordSum` por registro, número e custo das reinterpretações, existência de fork), o
veredito por critério e os cinco achados. `REPORT.md` é a leitura consolidada e não é
normativo.

`core/` **não foi tocado** — nada aqui exigiu correção nele, e os quatro testes vermelhos
(`errors.test` e `projector-parity`) continuam sendo B56/B57/B59, anteriores a esta fatia.

### 101.8 O que NÃO entrou

B56 e B57 não começaram: eles dependem deste veredito, e antecipá-los é o que §31.26 existe
para impedir. **B66 e B67 continuam abertas** — o harness mede o efeito delas a cada corrida,
mas não pode decidir texto normativo, e não decidiu.

## 102. B56 — o `dmProjector` e a persistência da conversa — 2026-09-02

Pedido: implementar B56 — as seis tabelas de `view.db` e as três de `manifest.db` de §31.12,
o snapshot por `ord_sum` com `fold_build_id`, a reinterpretação por inserção retroativa de
§31.13, os eventos de §31.16.2 e a barreira `view.db` → `manifest.db` → eventos. G14
destravou o item em §101; o que ele deixou de bagagem está em §101.5.

### 102.1 O desenho, e a coisa que a sessão fria erra

O `projector` de §10.5 **já existe** e não é este. §31.0 é a regra: os dois são irmãos, e o
que se reusa é o desenho, não o arquivo.

| | `projector` (§10.5) | `dmProjector` (§31.12) |
|---|---|---|
| Ordem | `seq`, um core | `ordSum`/`ordKey`, **dois** cores (§31.6) |
| Formas de efeito | doze (§8.4) | **quatro** (§31.7.6) |
| `recount`, `patchScope`, FTS5 | sim | **nenhum dos três** |
| `observed_ops` | sim (§11.6) | não existe — não há outbox (§31.10) |
| Contador de autor | `local_author_seq` | `core.length + 1` (RD-3); **não existe `dm_author_seq`** |
| Inserção retroativa | impossível — `seq` só cresce | §31.13, e é o que o snapshot precisa suportar |

A última linha é a que muda o arquivo, não só o texto: ver §102.3.

### 102.2 A ordem de §31.6 em fluxo, e o piso de RD-4

O merge de §31.6 é de dois ponteiros, e o projetor não materializa a ordem inteira: o próximo
registro é o de menor `ordKey` entre as duas cabeças não interpretadas. `sides[o].length` **é**
o ponteiro daquele lado, e `sides[o].lastAck` é o `ack` já clampado do registro anterior — as
duas coisas que o estágio final de §31.7.3 mantém em dia. Só o cabeçalho em claro é lido, pelo
`acksOf` do próprio `dmFold`: o projetor não decodifica registro (§4).

Um bloco que ainda não replicou (§10.5 passo 6) **não para os dois lados por princípio**. RD-4
dá um piso ao `ordKey` do bloco que falta sem lê-lo — `ack` é não decrescente, logo o registro
de índice `i` tem `ordSum ≥ i + 1 + lastAck`. Se a cabeça do outro lado precede esse piso, ela
passa: nenhum bloco que chegue depois poderá se inserir antes dela. Sem isso, um buraco no log
de um lado congelaria o outro e produziria uma inserção retroativa evitável — e §31.13 é cara.

### 102.3 O snapshot carrega as LINHAS, e essa é a diferença com §10.6

`ds_snapshot` (§10.6) guarda o `DecisionState` e **não** guarda projeção: o log de uma
comunidade é uma sequência, e nada em `view.db` é jamais desfeito. §31.13 manda o contrário —
**voltar** a projeção a um ponto anterior —, e a projeção não é reconstruível só do `DmState`:
`dm_messages.content` não mora nele, e um registro que muda de desfecho na reinterpretação (a
reação cujo alvo chega depois, a edição que era `APPLIED` e passa a `REJECTED`) deixaria a
linha antiga viva se ninguém a apagasse. O passo 2 de §31.13 é, então: **apagar o que é desta
conversa e repor as linhas do blob**. É o arranjo que o harness de G14 mediu no cenário 2.

Pela mesma razão, `messages` entra no blob — ao contrário de §8.1, que rematerializa o
`MessageMeta` de `view.db`. `reactionEmojis` é a lista de emojis **distintos já vistos** e, por
RD-9, ela **nunca encolhe**: um `present:false` apaga a linha do reator e não devolve a vaga.
Reconstruir o conjunto de `dm_reactions` devolveria a vaga, e um par contornaria RD-9
alternando `present` de um lado ao outro de um snapshot.

**§31.12 dá UMA linha de snapshot por conversa** (`conversation_id` é a PK inteira). Então
"descartar os snapshots acima do ponto e recarregar o mais recente anterior ou igual" tem
exatamente dois desfechos aqui. E "ou igual" precisa de cuidado: dois registros empatam em
`ordSum` e o desempate é a chave do autor, então comparar `ordSum` erraria. O critério
implementado é o exato — o snapshot serve se o maior `ordKey` **de dentro** dele precede o
menor `ordKey` **de fora** —, e os dois são computáveis sem reler o prefixo: o de dentro sai do
`lastAck` de cada lado no próprio blob, o de fora é a cabeça de cada lado.

### 102.4 `DM_SNAPSHOT_INTERVAL = 1 000`, e por quê

§27.2 declara quatro `P2P_DM_*`, todas de admissão e teto (§31.18, §31.9) — **nenhuma** de
projeção. O default mora no módulo e não finge ser da tabela; um teste de paridade guarda essa
fronteira.

O número é escolha de custo, e `ACHADO-G14-03` diz que errar custa tempo, nunca dado: com e sem
snapshot a reinterpretação converge para o mesmo hash. Duas contas o cercam:

- **Para baixo:** `ACHADO-G14-04` mediu reinterpretação do zero super-linear (log ×8 →
  ms/registro ×6,7; 2 000 → 241 ms, 16 000 → 12,9 s). O que a cadência compra é o teto do `n`
  que se refaz. Em 1 000, o pior caso a partir do snapshot fica na ordem de 100 ms; em 5 000
  (o valor da comunidade) já passaria de 1 s.
- **Para cima:** o blob carrega a projeção (§102.3), então gravar custa O(conversa) e o total
  numa conversa de `n` registros é O(n²/intervalo).

E há o caso que nenhuma cadência resolve, também de `ACHADO-G14-03`: quando a inserção
retroativa é o log do par chegando **inteiro** depois, o ponto de inserção é o começo da
conversa e não existe snapshot anterior a ele. Por isso a escolha é sobre o caminho comum —
chegada em ordem —, não sobre o pior caso.

### 102.5 Duas leituras de §31.12 que foram decididas aqui, e ficam declaradas

**1. `dm_participants.length`/`invalid` são materializados pelo projetor.** §31.12 as declara
`NOT NULL`, e nenhum `DmEffect` as carrega — §31.7.6 fecha o tipo em quatro formas e nenhuma
delas fala do **lado**. O projetor as escreve do `DmState` ao fim de cada lote. Isso não é
decidir: o valor é função do prefixo interpretado, igual com e sem snapshot, que é exatamente
o que o oráculo de equivalência exige. Um lado com zero registros não ganha linha — uma
conversa `pending-in` mostra quem escreveu, e uma linha vazia seria participante inventado.

**2. `dm_rejected_records` recebe `REJECTED` **e** `IGNORED`.** §10.3 escreve só na recusa e
fecha a questão dizendo que `kind` é `NULL` "só na recusa do estágio 0". §31.12 **removeu**
essa metade da frase e ficou com "`kind` é `NULL` **exatamente** quando o cabeçalho não
decodificou" — e no `dmFold` o envelope que não decodifica é `IGNORED` no estágio 1 (§31.7.3),
não `REJECTED`. Uma tabela só de recusas seria cega exatamente para o caso que a frase nomeia,
e a conversa direta não tem outro registro durável de um bloco ilegível vindo do par.

### 102.6 O que ficou fora, e é de B57

`manifest.db` ganhou as três tabelas de §31.12 e os acessos de armazenamento — nada mais. §4
**não** dá `manifest` ao `dmProjector`, então a segunda metade da barreira de §10.5
(`dm_local_read_state` recomputado, `dm.unreadChanged`) é de quem compõe o boot, como já
acontece com o `local_read_state` da comunidade.

`self_high_water` é **coluna**, não regra: B56 cria a coluna e o `raiseDmSelfHighWater` que só
sabe subir a marca. A comparação com `core.length` que decide `desynced`, a restauração por
replicação de `ACHADO-G14-01` e a decisão de `ACHADO-G14-05` são de B57. `dm.forget` (§31.19,
**L-25**) também não entrou: a linha de `dm_conversations` que sobrevive reduzida a seis
colunas é comportamento, e o comportamento é de B57.

### 102.7 Verificação

`core`: `npm run build` (typecheck + barreira de §4, agora com a linha `dmProjector` —
`dmFold, dmCodec, view, corestore` —, 105 arquivos, L1 com 9 módulos), `npm run typecheck` e
`npm test`.

O teste que fecha o item é o oráculo de G14, em `test/dm-projector.test.ts`: a projeção
comparada por **hash de dump** (`dmDumpHash`, §31.12) com a de um nó que recebeu os dois logs
inteiros de uma vez — depois de inserção retroativa, com cinco cadências de snapshot
diferentes, com o snapshot adiante do ponto de inserção, com `fold_build_id` trocado e depois
de `reproject()`.

**Cada cenário tem contrafactual**, porque um oráculo que não pode falhar não mede nada. O
corpus principal é um **empate de `ordSum`** desempatado pela chave do autor: a reação de `hi`
chega antes da mensagem de `lo`, é recusada por alvo inexistente e escreve linha em
`dm_rejected_records`; o teste afirma que nesse ponto o hash **difere** da referência, e que
depois da reinterpretação a linha de recusa **sumiu** e o hash bate. Um projetor que comparasse
só `ordSum` não veria inserção retroativa nenhuma aqui.

`VIEW_SCHEMA_VERSION` foi para `6` e `MANIFEST_SCHEMA_VERSION` para `3`. O primeiro é o que faz
o boot reprojetar: `view.db` é derivada e §31.12 autoriza `DROP` e refazer. O segundo é
declaratório — `manifest.db` é LS, `FULL`, **nunca** apagado por reprojeção, e o
`CREATE TABLE IF NOT EXISTS` acrescenta as três tabelas sem tocar em nada.

`test/errors.test.ts` **continua vermelho** e não foi consertado de passagem: faltam os quatro
códigos de §31.17 (`E_DM_BLOCKED`, `E_DM_FORKED`, `E_DM_CORE_MISMATCH`, `E_DM_NOT_AUTHORIZED`)
e quem os **usa** é B57/B59. `test/projector-parity.test.ts`, que era o outro vermelho, ficou
verde aqui: §10.3.1 declara as duas chaves `dm_*` de `meta`, e agora o código também.

### 102.8 O que NÃO entrou

**B66 e B67 continuam abertas.** B54 as registrou, G14 mediu o efeito delas e nenhuma se
resolve num projetor: as duas pedem texto normativo do operador. `ACHADO-G14-05` continua
**registrado, não decidido** — é de B57.

## 103. B57 — `directMessages`, o ciclo de vida da conversa direta — 2026-09-02

Pedido: implementar B57 — a derivação de `conversationId`, do core e da chave de conteúdo, os
cinco estados de §31.9, `self_high_water` gravado **antes** de cada append, a detecção e a
saída de `desynced`, aceite, bloqueio silencioso, teto de pendentes e a política local de
contato. G14 destravou o item em §101 e B56 fechou em §102; o que ficou de bagagem está em
§101.4/§101.5 e §102.6, mais uma decisão que o gate deixou nominalmente para cá
(`ACHADO-G14-05`).

### 103.1 A decisão de `ACHADO-G14-05`, que é o que este item tinha para decidir

O gate mediu e registrou sem decidir: como `self_high_water` sobe **antes** do append, um
`SIGKILL` na janela entre os dois deixa `core.length = self_high_water − 1`, e a regra de boot
de §31.13 lê isso como `desynced` — mas **nada se perdeu**, o bloco nunca existiu, e a saída
(1) do mesmo parágrafo não resolve, porque não há de onde restaurar. As duas saídas que o
achado nomeia: o boot distingue "append pendente que não landou" de perda de verdade, ou o
`self_high_water` passa a ser gravado de outra forma.

**Decisão: o boot distingue, mas a distinção exige o par — não é um teste local.**

A tentação é decidir por `core.length === self_high_water − 1` e pronto: é local, é
instantâneo, e acerta na janela benigna. Ela erra no caso que a barreira existe para pegar.
Uma queda de energia que encurte o core em **um** bloco que o par já tem produz exatamente a
mesma leitura local, e appendar ali é o fork de `ACHADO-G14-02` — dois blocos diferentes no
mesmo índice, assinados pela mesma chave, `conflict` nas duas pontas. Nenhum estado local
separa "nunca landou" de "landou e sumiu". Só o par separa.

A outra saída do achado — gravar a marca de outra forma, por exemplo só **depois** do append,
ou com uma coluna de intenção limpa após o `await` — foi considerada e recusada: ela abre a
janela inversa, em que um bloco durável não está coberto pela marca, e essa cobertura é
exatamente a propriedade que §31.13 compra. Trocar uma janela de espera por uma janela de fork
é o pior lado do trade.

Concretamente, `recuperarDesynced` tem **um** mecanismo e três desfechos, todos vindos do par:

| Desfecho | Significado | Efeito |
|---|---|---|
| `restaurado` | O par tinha os blocos, assinados pela minha própria chave de core, com a árvore de Merkle (`ACHADO-G14-01`, `hypercore@11.35.2`) | sai de `desynced`; a marca fica onde está |
| `inexistente` | Houve contato e o par **não tem** o índice que falta. Ninguém tem: o bloco nunca existiu | a marca era especulativa e **desce** para `core.length`; sai de `desynced` |
| `indisponivel` | Sem contato com o par | continua `desynced`, e escrever continua `E_DM_FORKED` |

**Custo declarado, e ele é real:** a conversa fica `desynced` até o próximo contato com o par.
Um nó que morreu na janela e nunca mais encontra aquele par não volta a escrever *naquela*
conversa. É a mesma classe de limitação que **L-26** já declara para entrega, e é preferível a
um heurístico local que acerta quase sempre e forka no resto.

### 103.2 A fronteira de §4, e por que ela não foi emendada

§4 dá a `directMessages` a coluna "Depende de" `corestore, swarm, manifest, identity`, mais a
porta de RPC de `rpcServer`/`rpcClient`, e duas proibições: **interpretar registro** e
**importar `rpcServer`/`rpcClient`**. A lista **não** tem `dmCodec`, `dmFold`, `dmProjector`
nem `view` — e o módulo precisa, ainda assim, construir o `dm.hello` de gênese e montar o
projetor.

A saída foi a de §27, não uma emenda: as duas coisas entram por **porta injetada**, e quem as
liga é a raiz de composição. `DmCriptoPort` traz `conversationKey(peerKey)` e
`hello({conversationKey, peerKey, selfCoreKey})`; `DmProjetorPort` traz `montar`/`limpar`;
`DmCorePort` traz `abrirProprio`, `abrirDoPar`, `recompor` e `limpar`. A consequência prática
é a que se quer: o módulo **nunca vê um registro decodificado** (a proibição literal de §4) e
nunca escreve em `view.db`, que tem um escritor só (§21.1).

Duas coisas caem fora da regra e são declaradas:

- **`identitySk` não atravessa porta nenhuma.** A composição fecha a chave secreta dentro de
  `cripto.hello` e de `cripto.conversationKey`; nem ela nem `dmContentKey` aparecem na
  assinatura de nada em `directMessages`.
- **`identitySeed` é do módulo**, porque a derivação do próprio core é literalmente o papel que
  §4 lhe dá ("derivação"), e `corestore` é dependência declarada.

### 103.3 As duas derivações de §31.3 que faltavam, e onde cada uma foi morar

| Derivação | Onde | Por quê |
|---|---|---|
| `dmCoreSeed` + par Ed25519 | `corestore.deriveDmCoreKeyPair` (L0) | Precedente exato de `deriveCommunityKeyPairs`: derivar chave é **ciclo de vida de core**, não decisão de conteúdo. E é dependência declarada de `directMessages` |
| `dmContentKey` | `dmCodec.dmContentKey` (L1) | É material de **AEAD**: os únicos consumidores são `sealDmPayload`/`openDmPayload` e o `DmContext`. Mesmo argumento que já pôs `verifyDmSignature` e `dmNonce` ali, com "Depende de" vazio |

`dmShared` é zerado antes do retorno (§31.3 regra 5). `crypto_scalarmult` entrou em
`types/vendor.d.ts` ao lado das conversões Ed25519 → X25519 que o escrow de §18.8 já usava.

### 103.4 O cabo de teste de `helpers/dm.ts` mudou, e isso não é silencioso

Até aqui o cabo derivava a `contentKey` de um rótulo falso (`'dm-content/1' ‖ conversationKey`)
com um comentário dizendo que no produto ela sai de X25519. **Ele passou a usar
`dmCodec.dmContentKey`.** A troca muda os bytes de cifra de **todo** registro de teste de
`dmFold`/`dmProjector`; nenhuma asserção depende deles, porque nenhuma testa ciphertext — todas
testam desfecho, e as 1 126 continuam verdes.

O ganho não é cosmético. Com a derivação real, um teste pode dar ao `dmFold` a chave computada
**do outro lado** e ver a AEAD fechar: é a propriedade de simetria de §31.3 regra 3. Com o
rótulo falso os dois lados batiam por construção, e isso é tautologia sobre a própria
implementação, não medida.

### 103.5 Decisões pequenas que ficam declaradas

| Decisão | Razão |
|---|---|
| `receberHello` numa conversa bloqueada devolve `E_DM_NOT_AUTHORIZED`, **nunca** `E_DM_BLOCKED` | §31.9 regra 2: bloqueado e recusado-por-política precisam ser indistinguíveis do outro lado. `E_DM_BLOCKED` é local, para a própria UI |
| `dm.unblock` **deriva** o estado de volta, não o lembra | `accepted_at` ⇒ `accepted`; sem core próprio ⇒ `pending-in`; resto ⇒ `pending-out`. Uma coluna a mais reconstruiria o que as três existentes já dizem |
| `abrir` cria o meu core e escreve o `dm.hello`; `receberHello` **não** | A tabela de §31.9 dá a `pending-out` "escrevo no meu core"; a regra 1 dá o aceite ao outro lado. Os dois lados da mesma regra |
| `abrir` sobre um `pending-in` **aceita** | Os dois abriram ao mesmo tempo. Criar uma segunda conversa é impossível por §31.2 regra 3, e recusar seria pior |
| Escrever antes do aceite é `E_DM_NOT_AUTHORIZED` | §31.9 regra 1: antes do aceite não existe o meu core, logo não existe onde appendar. Não é `E_NOT_FOUND` — a conversa existe |
| `esquecer` não zera `self_high_water` | §31.19 regra 2 / **L-25**: é o que impede o fork no recontato. A linha sobrevive reduzida às seis colunas |
| O módulo não importa `errors` | Nenhum L2 importa; §4 não o lista. Devolve `{ok:false, code}` e quem traduz para §20.1 é a fronteira — o arranjo de `relay` e `shareStar` |

### 103.6 Verificação

`core`: `npm run build` (typecheck + barreira de §4, agora com a linha `directMessages` —
`corestore, swarm, manifest, identity` e `portaImplementadaPor: ['rpcServer','rpcClient']` —,
108 arquivos, L2 com 13 módulos), `npm run typecheck` e `npm test`: **1 126 testes, 0 falhas**.

`test/errors.test.ts` **ficou verde**: os quatro códigos de §31.17 entraram em
`src/l1/errors/codes.ts` com classe, equivalente HTTP e política de retentativa batendo linha a
linha com §20.2, e o teste — que relê a tabela do normativo — passou de 86 para 90.

O teste que fecha o item é o **da ordem**, em `test/direct-messages.test.ts`: um nó reabre com
`core.length < self_high_water`, e o teste afirma três coisas separadas — que ele emite
`dm.desynced`, que `append` devolve `E_DM_FORKED` e **nenhum bloco entra no core**, e que o
primeiro `append` da sessão é posterior ao primeiro `recompor` num diário de operações. A
terceira é a que mede `ACHADO-G14-02`; as duas primeiras sozinhas passariam num código que
appendasse antes de recompor.

**Contrafactual conferido, não presumido:** removida a guarda `rt.desynced` do caminho de
escrita, o arquivo vai a **2 falhas**. Um teste que não pode falhar quando o append acontece
antes da recomposição estaria medindo que o código roda.

O `manifest.db` do teste é **real, em arquivo, com `synchronous=FULL`** — é ele que a barreira
de §31.13 usa, e trocá-lo por um mapa transformaria o teste da barreira num teste de mock. Os
cores são de mentira pela mesma razão do cabo do `dmProjector`: a ordem em que os blocos
aparecem, e a possibilidade de encurtar o core, é o que se quer controlar.

O determinismo dos dois lados é medido com **dois nós reais**: `conversationId`, `dmCoreSeed` e
`dmContentKey` computados independentemente de cada lado, e o `dm.hello` que `alice` escreveu
aberto pela `dmContentKey` que `bob` derivou sozinho — que é §31.2 regra 2 e §31.3 regra 3
juntas, sem trocar material nenhum.

### 103.7 O que NÃO entrou, e é de propósito

**B58 não começou.** O `dmHello` no fio, a conferência de `coreProof` contra a
`remotePublicKey`, `autorizaDm` aplicado canal a canal, os dois cores no mesmo mux, os tetos de
admissão de §31.18 e o `dm.typing` efêmero são dele. B57 entrega a **política**
(`autorizaDm(par, conversa)`, `receberHello`, `contactPolicy`) num ponto de injeção; quem a
aplica no canal vem depois. `P2P_DM_PENDING_MAX_RECORDS` está em `limites.ts` sem chamador, e
é B58 quem o aplica.

**B59 não começou.** Os 14 comandos, os 12 eventos e as 5 queries de §31.16, e o cursor
`base64url({ordSum, authorKey, id})`, são dele. Os eventos que este item emite saem pelo
`onEvent` injetado, não pelo IPC-R.

**A segunda metade da barreira de §10.5 continua de quem compõe o boot** (§102.6):
`dm_local_read_state` recomputado e `dm.unreadChanged` não saem daqui nem do projetor.

**B66 e B67 continuam abertas.** Seguem pedindo texto normativo do operador; nada nesta fatia
as toca.

## 104. B58 — `p2p-dm/1`, o fio da conversa direta — 2026-09-02

Pedido: implementar B58 — `dmHello` com prova de posse e conferência do `conversationId`
contra a `remotePublicKey`, `autorizaDm` canal a canal, a replicação dos dois cores no mesmo
mux, os tetos de admissão de §31.18 e o `dm.typing` efêmero. B57 fechou em §103 e entregou a
**política** num ponto de injeção; esta fatia é quem a aplica no canal.

### 104.1 O canal é simétrico, e é a única coisa em §16.1 sem precedente

Nos outros dois protocolos a assimetria de §16.1 resolve tudo: "quem abre o canal é o membro;
o host responde". Numa conversa direta **não há host** (§31.1), então não há a quem dar o
papel de respondedor. As alternativas consideradas:

| Alternativa | Por que não |
|---|---|
| Desempate por ordem de byte (`lo` abre, `hi` responde) | Reusa §31.2 e é determinístico, mas quebra no caso que importa: em `pending-in` eu **não tenho core** (§31.9 regra 1), logo não tenho `coreProof` a enviar. Se o `lo` for o lado pendente, ninguém se apresenta |
| Só quem tem core abre | Resolve o caso acima, mas os dois têm core numa conversa `accepted`, e aí voltam os dois a abrir |
| **Os dois abrem e os dois respondem** (adotada) | Cada ponta roda um `RpcServer` **e** um `RpcClient` sobre o mesmo cabo. Quem **chama** `dmHello` é quem tem core; quem não tem, escuta. É a forma que espelha "as duas partes são simétricas" de §31.1 |

**O canal simétrico trouxe um defeito real, e ele foi corrigido nas duas pontas.** Com os dois
lados falando pelo mesmo cabo, os dois numeram pedidos a partir de `1`: o quadro
`{i:1, m:'dmHello'}` que o par manda tem o mesmo `i` de um pedido meu em voo, e o
`decodeResponse` do `rpcClient` só conferia `i`. O pedido do par resolvia a minha chamada com
o corpo errado. A correção é uma linha em cada lado — **`m` é o que separa pedido de
resposta** — e tem teste próprio, porque nenhum dos dois protocolos anteriores podia produzir
o caso.

### 104.2 As quatro camadas de §31.8, e o contrafactual de cada uma

| Camada | Onde | Contrafactual medido |
|---|---|---|
| 1. Transporte | O Noise do `hyperdht` já autenticou `remotePublicKey`, que **é** a chave de identidade (§14.3 emenda) | — (é premissa do cabo) |
| 2. Vínculo da conversa | `conversationId` tem de ser exatamente o derivado do par de chaves, conferido **antes** de qualquer cripto cara | `alice` anuncia o id da conversa de `carol` com `bob` → `E_DM_NOT_AUTHORIZED`, e **nenhuma linha é criada** |
| 3. Posse do core | `coreProof` sobre `BLAKE2b('dm-core-possession/1' ‖ conversationId ‖ coreKey)` | prova assinada por outra chave → recusada; **e** prova sobre um core diferente do anunciado → recusada |
| 4. Autorização de canal | `autorizaDm(par, conversa)`, que mora em `directMessages` (§103) | conversa bloqueada → canal fechado, par solto da descoberta |

A terceira linha da coluna do meio é a que separa prova de alegação: sem ela, `coreKey` seria
uma afirmação do par sobre si mesmo, e replicar o core anunciado seria replicar o que o
atacante escolher. Removidas as camadas 2 e 3 do código, o arquivo de teste vai a **3 falhas**.

### 104.3 Descoberta: nenhuma peça nova, e nenhum tópico

§31.8 é explícito: por **L-24** a chave de identidade **é** o nó na DHT. O nó com ao menos uma
conversa `accepted` ou `pending-out` anuncia-se sob o próprio par (`swarm.announceSelf()` →
`hyperswarm.listen()`) e procura o par de cada conversa pela chave dele (`swarm.joinPeer`).
`SwarmBackendPort` ganhou `listenSelf`/`joinPeer`/`leavePeer`, todos opcionais pela mesma
razão dos demais: backend sem rede real não tem par a quem se conectar.

**Em `pending-in` eu não procuro ninguém.** O pedido chegou até mim; ir atrás do remetente
antes de aceitar seria dizer a ele que eu existo, que é exatamente o que o aceite decide
(§31.9 regra 1).

O tópico derivado do segredo compartilhado continua recusado, pela razão que §31.8 já dá: ele
não funciona no primeiro contato, porque `B` não conhece `A` e não consegue computá-lo.

### 104.4 Os tetos de §31.18, e o que o teste achou neles

A tabela de §31.18 tem **duas colunas**, e a coluna que se aplica depende do estado da
conversa, não do protocolo. `p2p-dm/1` entra em `RPC_FRAME_MAX_BYTES` com o teto do **par
desconhecido** (4 KiB, 2 em voo, 10 req/60 s, 30 req/60 s por /24); quem já tem conversa
`accepted` sobe para a coluna do par aceito (64 KiB, 8 em voo, 40 req/10 s) por conexão, via
`maxFrameBytes`. O default generoso seria o erro: um par que nunca falou comigo não paga o
teto do par aceito.

**O bucket cobrava dois tokens por quadro, e o teste é que mostrou.** Envolver cada assinatura
de `onFrame` no `check` — que é o que `admission.ts` faz, e lá está certo, porque há um
assinante só — cobra um token por assinante. Neste canal há **dois** (servidor e cliente, por
ser simétrico), e o teto de 10 req/60 s virava 5 sem que nada no código dissesse isso. O
limitador passou a ser consultado **uma vez por quadro**, com fan-out para os assinantes.

### 104.5 Os dois cores no mesmo mux

§31.13: "registrar um core num mux é **uma** operação por `(mux, core)` — o `attachTo` do
hypercore não é idempotente. Mesma lição de §13.4." O serviço guarda um `Set` de chaves de
core por stream, e o teste afirma que cada core aparece **uma vez** por mux mesmo com o
handshake repetido.

Antes de registrar, `autorizaDm` (§31.8(4)). Depois de registrar, §14.2 — replicar o canal não
baixa bloco nenhum por si só —, com a diferença que §31.9 impõe: em `pending-in` o core do par
é baixado por `downloadRange(0, P2P_DM_PENDING_MAX_RECORDS − 1)`, não por `download()`. Um
pedido não aceito não paga o disco de uma conversa inteira.

**O aceite reapresenta o core no canal vivo.** O canal nasce antes de eu ter core (`pending-in`
não cria core), e é o `dmHello` que leva a `coreKey` ao par. Sem a releitura em `refresh()`,
quem aceitasse ficaria com um canal vivo e mudo até a conexão cair.

### 104.6 `dm.typing`, e por que a tabela de notificações se dividiu

`dm.typing` é a notificação de §31.8: efêmero, TTL 5 s, refresh 3 s, teto de 1 / 2 s por
conversa — os mesmos números de §17.6, reusados e não reinventados. At-most-once (**L-13**):
nada é persistido, e uma perda se conserta sozinha em 5 s. Sem canal, ele **não enfileira** —
simplesmente não acontece (§31.16.1).

A tabela de notificações do `rpcServer`/`rpcClient` deixou de ser um conjunto plano e passou a
ser por protocolo. Fundir `dm.typing` na de §16.3 tornaria as duas erradas: ele não é evento de
§15.5 — e há teste que confere exatamente isso —, e nenhum tópico de §16.3 (roster, sessão,
ocupação) existe numa conversa sem host.

### 104.7 Verificação

`core`: `npm run build` (typecheck + barreira de §4 — 109 arquivos, raiz de composição com 19),
`npm run typecheck` e `npm test`: **1 144 testes, 0 falhas**.

O cabo de `test/helpers/dmRede.ts` usa **`Protomux` de verdade** sobre um par de streams
`streamx`, e DHT nenhuma. A escolha é deliberada: a descoberta tem cabo próprio com testnet
real em `transport.test.ts`, e trocá-la por um par de streams não muda nada do que §31.8
decide — a `remotePublicKey` chega igualmente declarada pelo cabo, que no produto é o Noise. O
que **não** se podia falsear é o `Protomux`: o canal simétrico é a peça sem precedente, e um
canal de mentira provaria o cabo, não o protocolo. O `manifest.db` é real, em arquivo.

O teste que fecha o item é o das quatro camadas, com os três contrafactuais de §104.2 —
verificados removendo as camadas 2 e 3 do produto, o que leva o arquivo a 3 falhas.

### 104.8 O que NÃO entrou

**B59 é o próximo.** Os 14 comandos, os 12 eventos e as 5 queries de §31.16, e o cursor
`base64url({ordSum, authorKey, id})`. Os eventos que esta fatia emite saem pelo `onEvent`
injetado; quem os leva ao renderer é B59, e é lá que `dm.setTyping` e `dm.activate` ganham
comando.

**O `startDmTransport` ainda não é chamado pelo boot.** Ele é raiz de composição e está
pronto, mas ligá-lo ao `bootCore` exige a `DirectMessages` montada no boot — com o
`dmProjector` real e a `dmContentKey` da composição —, e isso é a costura de B59, que é quem
tem motivo para acordar o subsistema.

**B62 (mídia em conversa direta) segue de pé**: §31.15 manda a sinalização passar pelo próprio
`p2p-dm/1`, sem host encaminhando. O canal existe agora; o método de sinalização é dele.

**B66 e B67 continuam abertas.** Nada nesta fatia as toca.

## 105. B59 — a superfície IPC-R da conversa direta — 2026-09-02

Pedido: implementar B59 — os 14 comandos de §31.16.1, os 12 eventos de §31.16.2 e as 5
queries de §31.16.3, com o cursor por `(ordSum, authorKey, id)`; e `dm.send` respondendo
**síncrono** com o registro já no log, com o cliente de IPC do renderer refletindo isso.
B57 fechou em §103 (a política) e B58 em §104 (o fio); esta fatia é quem os expõe.

### 105.1 A costura que faltava, e onde ela ficou

§103.7 e §104.8 registraram a mesma pendência: nada chamava o subsistema. Quatro peças
existiam e nenhuma se conhecia, por desenho — `dmCodec`/`dmFold` não fazem I/O,
`dmProjector` não decide nada, `directMessages` não importa transporte nem codec,
`composition/dm.ts` é só o fio. Faltava o lugar onde a chave secreta de identidade e a
`dmContentKey` coexistem com o resto.

Esse lugar é `composition/dmRuntime.ts`, e ele é a **única** peça com esse privilégio:

- deriva a `dmContentKey` (§31.3) e a entrega ao `DmContext` do projetor e ao escritor.
  Nenhuma porta de `directMessages` a carrega, e ela não cruza o IPC-R (§3.2 item 5);
- constrói o registro de §31.4 — encode, seal, assinatura — com `authorSeq = core.length + 1`
  (RD-3, **não existe `dm_author_seq`**) e `ack` igual ao que já foi interpretado do log do
  par (§31.6). A barreira do `self_high_water` continua sendo de `directMessages` (§103);
- fecha a **segunda metade da barreira de §10.5**, que §102.6 e §103.7 deixaram em aberto:
  `dm_local_read_state` recomputado no boot e `dm.unreadChanged` **depois** do commit. §4 não
  dá `manifest` ao `dmProjector` nem `view` a `directMessages`, então o cruzamento das duas é
  de quem compõe — exatamente como já acontece com o `local_read_state` da comunidade.

O `bootCore` ganhou uma chamada, e só. Sem identidade não há o que montar — o `conversationId`
sai de duas chaves de identidade (§31.2) —, então o núcleo em `awaiting-identity` simplesmente
não tem a superfície, e os comandos respondem `E_UNKNOWN_COMMAND`, como toda superfície sem
serviço.

### 105.2 A fronteira de §4, de novo, e de novo sem emenda

`ipcRenderer` tem `deps: ['l2']` — **só L2**. A primeira versão de `dmCommands.ts` importava
`DmKindName`/`DmPayloadOf` do `dmCodec` (L1) e `DmQueryPorts` da raiz de composição; o
`check-layers` quebrou o build nas duas linhas, que é o que ele existe para fazer.

A correção não foi emendar a tabela: a fronteira passou a declarar as **formas** que
atravessam (`DmAttachmentWire`, `DmWriteResult`, `DmQuerySurface`) e a receber **cinco métodos
de escrita** — `sendMessage`, `editMessage`, `deleteMessage`, `react`, `setProfile` — em vez de
um `write(kind, payload)` genérico. O catálogo de §31.5 é de L1, e a fronteira não o conhece.
É a mesma disciplina de §103.2 e §104, e o resultado é o mesmo: nenhuma emenda a §4 em três
fatias seguidas.

### 105.3 O cursor de §31.16.3 leva três campos, e os três importam

`base64url({ordSum, authorKey, id})`:

| Campo | Por que ele está lá |
|---|---|
| `ordSum` | A coordenada de §31.6 |
| `authorKey` | `ordSum` **empata**, e §31.6 desempata pela chave do autor. Sem ele, uma página perderia ou repetiria o registro do outro lado no ponto de empate |
| `id` | É o que sobrevive a uma reinterpretação (§31.13): o `ordSum` de um registro pode mudar de vizinhos sem que ele mude de identidade |

Forma inválida ou incompleta é `E_BAD_CURSOR`, nunca resultado errado em silêncio (§15.6.1) —
e o teste enumera as cinco formas quebradas, uma por campo.

A saída é **sempre crescente**, independente da direção: `before` devolve a página anterior já
reordenada para leitura, como `query.messages` faz com `seq` (§23.2). A UI não inverte nada.

### 105.4 O que a superfície de DM **não** tem, e a ausência é o contrato

| Ausente | Razão |
|---|---|
| `{opId, state:'queued'}` em `dm.send` | §31.10 — a resposta é síncrona e reporta um registro **já no log**. `state` é o literal `'written'` |
| `dm.retry` / `dm.cancelQueued` | Não há fila durável: nada pendente a retentar nem a cancelar. O que existe é apagar (`dm.delete`, tombstone) |
| `collision` em `DmPeerRef` | Numa conversa de dois não há conjunto em que colidir (§31.16.3) |
| `delivery` nas mensagens **do par** | §31.11 — a entrega do outro é observação dele, não minha. Inventá-la seria afirmar o que nenhum atestado sustenta |
| `unread.changed` de §15.5 reusado | O payload dele declara `communityId`, e uma conversa direta não tem um. `dm.unreadChanged` é tópico próprio (§31.16.2) |

O invólucro do renderer reflete os dois primeiros, e há teste que afirma a **ausência**:
`dmRetry` e `dmCancelQueued` não existem em `api`, enquanto `messageRetry` e
`messageCancelQueued` continuam existindo. Uma tela que os oferecesse mentiria sobre o modelo.

`conversationId` entrou como terceira chave de roteamento do `EventFanout`. Sem ela, uma
assinatura de `dm.appended` recortada por conversa não casaria com evento nenhum: a regra do
fan-out diz que filtro que o evento não sabe responder **não** casa.

### 105.5 Quatro defeitos que só a pilha inteira revelou

Nenhum dos quatro aparece em teste de unidade, e os quatro estão corrigidos:

1. **A gênese nascia inválida.** O `dm.hello` de RD-1 ia com `displayName: ''`, e §31.7.5 exige
   2–32 code points: o `dmFold` recusava a gênese com `E_VALIDATION` e RD-1 marcava aquele lado
   **inteiro** como `invalid` — a conversa nascia morta, em silêncio, e nada depois dela
   aplicava. O perfil agora vem por porta, com o `handle` de §6.1 como piso; ele é derivado da
   chave e nunca é vazio.
2. **O aceite reabria os cores já abertos.** `directMessages` remonta a conversa a cada
   transição de estado, e cada remontagem repedia os dois cabos. Sem memória, o segundo pedido
   abria o **mesmo diretório** com o primeiro ainda aberto — que o hypercore recusa. Quem tem
   o ciclo de vida do core é a composição (§4), e é lá que a memória ficou.
3. **Dois projetores da mesma conversa.** A remontagem descartava o `Runtime` de
   `directMessages` junto com a referência dele ao projetor velho; quem ainda a tinha era o
   mapa da composição, que não o parava. Dois `#run()` sobre a mesma `view.db` disputam a
   transação, e o segundo perde. Parar o projetor anterior antes de montar o novo é obrigação
   de quem tem o mapa, e o mapa é da composição (§4).
4. **Duas aberturas do mesmo core, ao mesmo tempo.** Este é o defeito **intermitente**, e a
   memória do defeito 2 não bastava para ele: ela gravava o cabo no mapa **depois** do
   `await`. As remontagens não são sequenciais — o aceite chega pelo IPC-R e o vínculo de
   `peerCoreKey` chega pelo handshake do fio, por caminhos assíncronos independentes —, e as
   duas atravessavam a janela entre o pedido e a resposta vendo o mapa vazio. O hypercore
   recebia dois `open` do mesmo diretório e recusava o segundo com
   `File descriptor could not be locked`, que chegava à fronteira como `E_INTERNAL` no
   `dm.accept`. O mapa passou a guardar a **promessa**, gravada antes do `await`, e uma
   abertura que falha sai dele — cachear a rejeição faria um erro transitório condenar a
   conversa até o próximo boot.

   A forma como ele apareceu é parte do achado: o arquivo falhava cerca de **uma vez a cada
   duas rodadas**, e o palpite inicial foi carga da suíte inteira. Não era. Instrumentado o
   ponto de abertura, o log mostrou os dois `abrir` do mesmo caminho sobrepostos **na rodada
   isolada** também — a suíte só deslocava o escalonamento o bastante para tornar a corrida
   mais provável. Foi o log que separou a causa do sintoma; sem ele, a leitura por carga
   teria levado a mexer no lugar errado.

### 105.6 Verificação

`core`: `npm run build` (typecheck + barreira de §4 — 112 arquivos, raiz de composição com 21),
`npm run typecheck` e `npm test`: **1 154 testes, 0 falhas**, e a suíte inteira rodada três
vezes seguidas por causa do defeito 4. O arquivo isolado, que era onde a corrida aparecia,
rodou **doze** vezes seguidas sem falha — antes da correção ele falhava duas em oito.

`frontend`: `npm run build`, `npm run lint` e `npm test` — **383 testes, 0 falhas**.

O teste que fecha o item é `test/dm-ipc.test.ts`, e ele é o primeiro da série de §31 com
**hypercores de verdade em disco** e **Noise de verdade** (`@hyperswarm/secret-stream`) entre
os dois nós. A escolha não é zelo: `dm.send` responde um `ordSum`, e a afirmação que importa é
que **a projeção do outro lado materializa o mesmo número** — isso não é afirmável com core de
mentira, e o `hypercore` nem sequer anexa ao mux sem um stream que tenha `opened`. Como
subproduto, a `remotePublicKey` de §31.8 camada 1 passa a ser autenticada de fato, e não
declarada pelo cabo.

**Contrafactual conferido:** removido o `download()` do core do par (§14.2 — replicar o canal
não baixa bloco nenhum por si só), o arquivo vai a **2 falhas**. É o que separa "a replicação
aconteceu" de "o teste roda".

Os cabos de §103 e §104 continuam com cores de mentira, e continuam certos: lá o que se mede é
a **ordem** em que os blocos chegam e a possibilidade de encurtar o core, e um hypercore em
disco não dá controle nenhum sobre isso.

### 105.7 O que NÃO entrou

**A UI é B60, e o delta de UX é B65.** O invólucro do renderer entrou porque o backlog de B59
o pede nominalmente — o cliente precisa refletir a terceira classe de escrita —, mas nenhuma
tela existe ainda. `frontend/src/ipc/api.ts` declara que só entra ali o que a fatia realmente
chama; a exceção está registrada aqui, e o que a justifica é o teste de contrato: sem ele, o
invólucro seria superfície morta.

**`lag` e as listas de `partialInterpretation` saem 0 e vazias.** §31.13 define `lag` como
"registros por interpretar", o que exige conhecer a **cabeça** do par — informação do fio, que
B58 não expõe. §31.16.2 declara `unknownKinds[]`/`unknownVersions[]`, e o `DmState` de §31.7.2
guarda só o **fato** de haver interpretação parcial, não a enumeração. Nos dois casos, um
número inventado seria pior do que nenhum; ficam declarados como superfície com fonte
incompleta.

**B61 (anexos) e B62 (mídia) seguem de pé.** `dm.send` já aceita `attachment` na forma do fio,
mas o `blob.stage` de DM (`ns/dmblobs/1`, RD-11) é de B61.

**B66 e B67 continuam abertas.**

---

## 106. B65 — U-33, o delta de UX da conversa direta — 2026-09-02

`deltas-ux-v2.md` ganhou **U-33**, na forma de U-16/U-17 estendida como U-32 fez: uma entrada,
uma tabela, uma linha por decisão. Não há código nesta fatia — é texto normativo, e a
precedência dele é a 4ª da lista do `CLAUDE.md`.

### 106.1 O que é derivação e o que seria decisão

A distinção governou o que entrou. §31.24 declara **L-25 a L-29**, e a coluna "Superfície de UI
obrigatória" daquela tabela tem cinco linhas: elas são **requisito**, não escolha de produto —
sem elas, cinco limitações reais do sistema ficam invisíveis para quem as sofre. O resto de
U-33 sai do contrato de §31.16, que existe em código desde §105: 14 comandos, 12 eventos e 5
queries que nenhuma tela consumia.

O que **não** se deriva ficou de fora e está nomeado no próprio delta: **onde a DM mora na
navegação** e **como a notificação dela é configurada** são B63, e as duas propostas escritas
lá valem enquanto ninguém decidir o contrário. Escrever uma delas aqui teria transformado
preferência de produto em texto normativo por acidente.

### 106.2 Três proibições de texto, e por que são normativas

A parte de U-33 que mais custa a quem for desenhar B60 não é o que a tela mostra, é o que ela
**não pode dizer**:

1. **"Não entregue" não pode afirmar a causa.** `undelivered` é, por construção,
   indistinguível entre o par offline e o par que bloqueou (§31.9 regra 2). A tela mostra o
   estado e o tempo desde a escrita; escrever "ele está offline" inventaria o fato que o
   protocolo recusa dar (**L-26**, **L-28**).
2. **`delivered` não é "lido".** O `ack` só avança quando o par **escreve** (§31.11), então ele
   atesta que os registros chegaram, não que alguém os leu. Confirmação de leitura não existe
   em §31.5, e rotulá-la assim seria inventá-la na camada errada.
3. **`unauthorized` usa o mesmo texto que `peer-offline`.** Os dois estados de §31.13 são
   distintos no núcleo e têm de ser **indistinguíveis na tela** — separá-los desfaria L-28 por
   um caminho lateral, que é exatamente a forma como um bloqueio silencioso costuma vazar.

### 106.3 A ausência de outbox tem consequência de tela

`dm.send` é síncrono e a mensagem é final assim que escrita (§31.10). Os cinco estados de
outbox — `queued`, `sending`, `awaiting-confirmation`, `failed`, `dropped` — não são declarados
em §31.11 porque não podem ocorrer, e U-33 fecha o corolário: **o composer não pode inventá-los**.
Não há "enviando", não há "falhou", não há "tentar de novo". É a mesma decisão que §105 já tinha
gravado do lado do cliente de IPC-R, onde `dmRetry`/`dmCancelQueued` **não existem** e um teste
de contrato afirma a ausência.

A exceção declarada é `desynced`/`forked`: ali o composer **fica visível e desabilitado**, com a
faixa dizendo o porquê. É a única exceção à regra de §15 (esconder, nunca desabilitar) em U-33,
e ela é justificada: o estado é temporário e espera o par (§31.13, §103.1), e sumir com o
composer faria a conversa parecer somente-leitura por natureza.

### 106.4 O evento que a UI não pode ignorar

Onze dos doze eventos de §31.16.2 são "sinal para reconsultar, se quiser" (§15.1 regra 5). O
décimo segundo não é: `dm.reordered` diz que a história mudou de ordem a partir de `fromOrdSum`
(§31.13, inserção retroativa), e a lista já renderizada **deixou de ser a corrente**. U-33 torna
a recarga daquela faixa obrigatória e acrescenta o requisito de desenho que vem junto — a
recarga não pode dar salto de rolagem, e a âncora é a mensagem sob o cursor, como no divisor de
não-lidas de `frontend.md` 2.1.

### 106.5 Verificação

Não há suíte que rode sobre texto normativo. O que se conferiu:

- as cinco superfícies obrigatórias de §31.24 (L-25..L-29) têm linha própria em U-33;
- a regra de completude do cabeçalho de `deltas-ux-v2.md` dizia "L-1 a L-22" e passou a "L-1 a
  **L-29**" — §25.8 cresceu com §31 e o cabeçalho não tinha acompanhado, o que tornaria a
  própria regra de completude incapaz de detectar a falta de U-33;
- a linha de `deltas-ux-v2.md` na matriz de cobertura de §31.25 saiu de **Aberto — B65** para
  **Feito**;
- nenhum estado, rótulo ou texto de U-33 sem fonte em §31: os que não têm fonte estão
  declarados como em aberto (B63) ou como fonte incompleta (`lag` e as listas de
  `partialInterpretation`, §105.7).

### 106.6 O que NÃO entrou

**Nenhuma tela.** B60 continua aberta, e agora com o delta que ela pedia.

**B63 continua do lado humano**, e U-33 não a antecipou. **B66 e B67** também continuam abertas
— nenhuma delas é de UX.

---

## 107. B60 — a UI da conversa direta — 2026-09-02

U-33 virou tela. O destino da DM existe, montado com o que o shell já tinha: a entrada no
topo do rail, a lista de conversas no slot da lista de canais e a conversa no slot de
conteúdo. Nenhum componente novo de `components/ui` — a biblioteca de §6 já bastava.

### 107.1 Onde as decisões normativas foram parar

`features/dm/dmRegras.ts` é o arquivo que importa, e ele não desenha nada. A maior parte de
U-33 é **proibição de texto**, e proibição só é verificável se houver uma função a chamar:
um componente que monta a frase inline transforma requisito normativo em detalhe de JSX, e
a próxima pessoa a mexer não tem como saber que "não entregue" não pode virar "ele está
offline". O precedente é `moderation/historico.ts`, e a mesma armadilha de nome vale (um
`.ts` e um `.tsx` que diferem só na caixa são o **mesmo** arquivo para o TypeScript num
filesystem Windows — `TS1261`).

Três asserções do teste são o contrato, e as três foram conferidas por mutação:

1. **`unauthorized` e `peer-offline` devolvem a MESMA faixa.** O teste compara os dois
   objetos inteiros com `toEqual`. Trocar o texto de `unauthorized` por "Esta pessoa
   recusou o canal" derruba exatamente esse caso — que é o ponto: a frase separada diria ao
   bloqueado que ele foi bloqueado, e **L-28** deixaria de valer por um caminho lateral.
2. **"Não entregue" não afirma a causa.** O teste varre o rótulo e o detalhe atrás de
   `offline`, `bloque`, `desligad`, `ausente` e `recusou`, e o detalhe carrega só o **tempo
   desde a escrita**, que é o que §31.24 manda acrescentar.
3. **`dm.reordered` descarta a faixa antes da reconsulta.** O teste deixa a query pendurada
   numa promessa que nunca resolve e mede o estado no meio. Remover a linha de
   `reordenar()` em `live/dm.ts` derruba o caso; sem ela, a tela ficaria mostrando a
   história antiga com as mensagens novas penduradas no fim.

### 107.2 Onze eventos são sinal, um é ordem

`live/dm.ts` segue §15.1 regra 5 em onze dos doze eventos de §31.16.2: nenhum aplica
payload, todos disparam a consulta correspondente. `dm.reordered` é a exceção declarada, e
está comentada no ponto — o payload entra na hora, a faixa some, e só então vem a
reconsulta. Há teste para os dois lados: `dm.appended` **não** pode mexer na lista, e
`dm.reordered` **tem** de mexer.

`dm.activate` entrou junto e não é cosmético: §31.16.1 o usa para decidir a residência do
projetor, e sair do destino solta a conversa. Sem isso, a conversa aberta uma vez
continuaria consumindo lote com ninguém olhando.

### 107.3 A ausência de outbox chegou à tela

Não há "enviando", "falhou", "na fila" nem "tentar de novo" — em lugar nenhum, e o store
não tem onde guardá-los. `dm.send` é síncrono com o registro já no log (§31.10): ou a
promessa resolve e a mensagem é final, ou ela rejeita e **nada foi escrito**. O segundo
caso é toast, e o texto **continua no campo** — limpar o composer perderia o que a pessoa
escreveu, e não há retentativa a oferecer em troca. O teste afirma que um envio recusado
não deixa mensagem nenhuma na conversa.

A única exceção à regra de esconder-nunca-desabilitar de §15 é o composer em `desynced` e
`forked`: visível e morto, com o motivo escrito. Está em `composerDaConversa`, com teste.

### 107.4 O que a fatia decidiu, e o que não decidiu

**A montagem é a proposta de B63(a), e nada além dela.** A DM é entrada no topo do rail —
antes das comunidades, porque não é uma comunidade — e troca as duas colunas. Trocar de
forma depois é trocar o lugar de montagem: `DmList` e `DmConversationView` não sabem onde
estão, e o campo `destino` mora no `uiStore` justamente por ser navegação e não estado de
comunidade.

**B63(b) continua aberta.** A política de contato de §31.9 regra 5 entrou em 3.1, com o
custo escrito junto da opção — que é requisito ("o custo, e ele precisa aparecer na UI"),
não cortesia. O silenciar por conversa **não** entrou: ele depende da decisão de B63(b).

### 107.5 Verificação

`frontend`: `npm run build`, `npm run lint` (sem aviso) e `npm test` — **412 testes, 0
falhas**, de 383. Os 29 novos são 21 de `features/dm/__testes__/dm-regras.test.ts` e 8 de
`live/__testes__/dm.test.ts`.

Um aviso do `oxlint` foi corrigido em vez de silenciado: `corDoPar` estava exportada de um
`.tsx` ao lado de componentes, o que quebra o Fast Refresh. Foi para `dmRegras.ts`, que é
onde as funções da fatia moram de qualquer forma.

`core` não foi tocado nesta fatia.

**Teste de render continua não existindo** (B20). O que estes 29 cobrem é a camada abaixo
do JSX — os textos, os estados e a ponte —, que é onde U-33 pôs o conteúdo normativo. Uma
tela que renderize errado o que `dmRegras` decide certo ainda passa; é a mesma dívida que
B20 já nomeia, e ela não cresceu com esta fatia.

### 107.6 O que NÃO entrou

**Anexos e mídia** são B61 e B62. O composer não tem clipe e a conversa não tem botão de
chamada — `TEXTO_CHAMADA_SEM_RELAY` existe em `dmRegras.ts`, testado, esperando a tela de
B62.

**Editar, apagar e reagir** têm porta em `live/dm.ts` (os comandos de §31.16.1 estão todos
lá) e ainda não têm afordância na linha da mensagem. A anatomia de 2.1 os prevê; ligá-los é
trabalho de superfície, não de contrato.

**B63, B66 e B67 continuam abertas.**

---

## 108. B61 — anexos na conversa direta — 2026-09-02

§31.14 é uma tabela de **reusos**, e a fatia se mediu por isso: o que entrou de código novo
é uma derivação, uma exceção declarada e duas guardas. Tudo o mais — o ticket do main, o
fluxo de upload, o de download, a barreira blob↔mensagem, os oito estados de cache, a
allowlist de §13.6 — é §13 sem uma linha alterada.

### 108.1 O `conversationId` entra no slot do `communityId`, e isso é o reuso

O `BlobManager` sempre chaveou por uma **string opaca**. §31.14 manda reutilizar §13 inteiro,
e a leitura honesta disso é que o escopo de um blob é o escopo de replicação dele — que numa
conversa é a conversa (§31.1), não uma comunidade. Então `blob.stage`, `blob.download`,
`blob.cancel` e `file.pickForAttachment` **não ganharam campo nenhum**: o `conversationId`
viaja onde o `communityId` viajava, e o núcleo sabe qual dos dois é.

Duas coisas precisaram de distinção, e só duas:

1. **R-14 não se aplica** (§31.14, textual). A cota existe para impedir que um membro esgote
   o disco dos *outros membros* de uma comunidade; numa dupla o download é *pull* (§13.4),
   ninguém recebe bytes que não pediu, e o teto de `sizeBytes` de §6.10 já fecha "declara
   1 KB, entrega 8 GB". O `BlobManager` guarda quais escopos são de DM e pula a cota neles —
   **explicitamente**, e não por acidente: sem a marca, a isenção existiria só porque
   `storageUsedOf` devolve `null` para um id que não é comunidade, o que é a coisa certa
   acontecendo pela razão errada.
2. **O tópico DHT** continua `BLAKE2b('blob-discovery/1' ‖ blobsCoreKey)` e o `kind` continua
   `member-blobs` — §31.14 classifica o core de blobs de DM como "core de blobs por autor,
   reutilizado", que é o que aquele nome diz. O que muda é o `communityId`, que sai `null`:
   o campo já é anulável e é o lugar de dizer "este não pertence a comunidade nenhuma".
   Inventar um `kind` em L0 mexeria no vocabulário declarado de §14.1 para não dizer nada
   que o `null` não diga.

### 108.2 O core de blobs nasce com a conversa, não com o primeiro anexo

`deriveDmBlobsKeyPair` ficou em `l0/corestore`, ao lado de `deriveDmCoreKeyPair`, pelo
argumento que aquele arquivo já faz: derivar chave é **ciclo de vida de core**, não decisão
de conteúdo (§4). A semente é derivada em `dmRuntime` — o único lugar onde a chave secreta de
identidade já mora — e sai dali direto para quem abre o core; ela não cruza porta de
`directMessages` e não cruza o IPC-R.

O core é anexado quando a conversa é **montada**, e não quando o primeiro anexo é escrito.
Esperar o `blob.stage` deixaria a janela em que o par pede um anexo no tópico de §13.4 e
ninguém responde: quem anuncia é o dono do core. Falhar a abertura não derruba a montagem —
uma conversa sem anexos continua inteira, e o que sai é um `dm.sync` degradado.

`dm.forget` solta o core junto com o resto (§31.19): manter anunciado o core de blobs de uma
conversa que a pessoa mandou apagar serviria bytes que ela mandou tirar de vista.

### 108.3 Duas guardas na escrita, e o que elas não fecham

`dm.send` leva o `attachment` **inteiro** no argumento (§31.16.1), diferente de
`message.send`, que manda só o `ticketId`. Isso obriga a duas conferências antes de o
registro entrar no log:

1. **RD-11** — o `blobsCoreKey` tem de ser o core de blobs de DM desta conversa. Do lado da
   escrita a regra é **total**: um anexo apontando para um core arbitrário não entra no meu
   log, e a recusa é `E_VALIDATION`.
2. **§13.7 regra 1** — o blob tem de existir aqui. `BlobManager.stagedMatching` confronta
   chave, faixa e **hash** com o que este núcleo escreveu; sem correspondência, é
   `E_BLOB_NOT_STAGED` — que a tabela de §31.16.1 já declarava e que não tinha produtor.

O que **não** fecha continua sendo B66: do lado da **leitura**, o `dmFold` só consegue exigir
que todo anexo de um lado repita a chave do primeiro daquele lado (§31.7.2), porque
`dmBlobsSeed` é derivável só por quem tem o `identitySeed` e a chave resultante não é
declarada em lugar nenhum do fio. O **primeiro** anexo do par ainda pode apontar para um core
arbitrário. Fechá-lo exige texto normativo, e B66 é isso.

### 108.4 A tela

O clipe faz o `blob.stage` **na hora**, não no envio: §13.7 é "o blob primeiro, a mensagem
depois", e adiar o stage deixaria a mensagem entrar no log apontando para bytes ainda não
escritos. O que vai no `dm.send` é o resultado do stage, nunca algo montado pela tela — a
mesma disciplina de `message.send`, com o confronto do núcleo por trás.

O cartão do anexo **não baixa sozinho**: §13.4 é pull, e é justamente isso que torna a cota
desnecessária numa dupla. Tirar o anexo do composer antes de enviar não apaga os bytes do
core — quem os poda é o GC de staging órfão (§13.5/§22.4) —, e o comentário no ponto diz
isso, porque prometer o contrário na tela seria a mentira que A26 recusa nas mensagens.

Anexo de mensagem apagada não aparece: `dm.delete` tira o `content` da projeção, e devolver
o arquivo seria devolver o que a pessoa mandou tirar da vista.

### 108.5 Verificação

`core`: `npm run build` (§4, 112 arquivos), `npm run typecheck` e `npm test` — **1 163
testes, 0 falhas**, de 1 154, rodado duas vezes. Os 9 novos estão em `test/dm-anexos.test.ts`.

`frontend`: `npm run build`, `npm run lint` (sem aviso) e `npm test` — **416 testes**, de 412.

**Mutação, nas duas guardas.** Removida a comparação de RD-11, o caso 2 cai; removida a
recusa de §13.7, o caso 3 cai. As duas isoladamente — não é um teste pegando os dois.

A derivação tem quatro asserções de separação, e cada uma nomeia o que aconteceria sem ela:
determinismo (o backup de §5.5 recupera o core sem campo novo), por conversa (§31.1 — um core
único ligaria pelo tópico de §13.4 pessoas sem relação), diferente do core de **log** da mesma
conversa (um anexo grande atrasaria a conversa inteira) e diferente do core de blobs de
**comunidade** de mesmo id (sem `ns/dmblobs/1` vs `ns/memberblobs/1`, os dois seriam o mesmo).

### 108.6 O que NÃO entrou

**B62 (mídia)** segue de pé, e é a última da fase 11.

**B66** continua aberta, agora com a metade implementável entregue e a metade normativa
isolada em uma frase: falta declarar a chave de blobs no fio.

**Miniatura de imagem inline** não entrou. §13.6 permite renderizar imagem inline e a regra
não muda numa DM; o que falta é a tela, não o contrato — e o cartão já distingue baixado de
não baixado, que é onde a miniatura entraria.

## 109. B62 — mídia na conversa direta, e a fase 11 fecha — 2026-09-02

§31.15 é uma tabela de **remoções** sobre §17, e a fatia se mediu por ela: nenhuma peça de
mídia nova foi desenhada. O que entrou é §17.2 inteiro — WebRTC no renderer, ponta a ponta,
DTLS-SRTP, o núcleo nunca vendo mídia — com host, ticket, roster, ocupação, fila, revogação
e relay retirados de baixo, e um nome dado ao que sobrou.

### 109.1 O `REQUIRES POC` de §31.15, conferido antes de qualquer linha

§31.15 abre com "**`REQUIRES POC` — G7, G8 e G14.** Nada aqui pode ser implementado antes
deles". Os três existem, e os três saíram `parcial`. O que se conferiu nos artefatos:

| Gate | Veredito | `openCriteria` |
|---|---|---|
| G7 (`poc/poc-08-g7/out/gate-G7/gate-G7.json`) | `parcial` | NAT de kernel + `tc/netem` e CGNAT real; codec de voz real e `RTCPeerConnection` do Electron empacotado; CPU ≤20% em alvo dedicado; demux/tickets no `utilityProcess` do produto |
| G8 (`poc/poc-09-g8/out/gate-G8/gate-G8.json`) | `parcial` | `getDisplayMedia`/`RTCStatsReport` reais no Chromium empacotado; encoder de vídeo real; `tc/netem` com uplink limitado, CGNAT e churn; CPU ≤40% em alvo dedicado; `share.health` do renderer |
| G14 (§101) | `parcial` | Os **cinco** critérios aprovados |

Os `openCriteria` de G7 e G8 são, item a item, o que **B4** guarda do lado humano: máquinas
de verdade, `NET_ADMIN` para o `tc/netem` e um link de operadora com CGNAT. Nenhum deles se
produz nesta máquina, e nenhum deles é sobre a existência do caminho — são sobre a **medida**
dele em rede real.

**A leitura que se sustenta, e o precedente que a sustenta:** este mesmo veredito não travou
§17. Voz e tela de comunidade estão em produto desde §77–§98, sobre G7 e G8 `parcial`, e a
evidência de duas pontas que se pôde produzir aqui é `xvfb-run -a npm run smoke:voz` (§98).
B62 herda o veredito e herda a pendência: o que continua aberto depois desta fatia é **B4**,
não §31.15.

O que a fatia **não** faz por causa disso é anunciar número não medido. Não há indicador de
qualidade de chamada de DM, não há teto de participantes (não existe, §90) e o `turn:` deste
nó continua saindo do anúncio pelo default de §17.3 (`P2P_TURN_ANNOUNCE`), pela mesma razão
de 2026-08-28 — o caminho relayado não foi medido em rede real.

### 109.2 A segunda decisão: derivação, e não lacuna nova

§31.15 manda, em texto, que SDP e ICE viajem pelo `p2p-dm/1` e que "o outro está na chamada"
seja uma notificação efêmera nesse canal, com a disciplina at-most-once de §16.3 regra 1. Mas
a tabela de §31.8 declarava **um** método (`dmHello`) e **uma** notificação (`dm.typing`), e
§31.16 declarava 14 comandos e 12 eventos, nenhum deles de mídia.

**Isso é extensão derivável, e entrou como emenda no ponto.** O precedente é literal e é o
mesmo defeito: §19.8 sempre mandou o host emitir `voice.failed` e §15.5 sempre declarou o
evento, mas a tabela **fechada** de §16.3 não o listava, e pela regra 2 o tópico morria em
silêncio — corrigido por emenda em 2026-08-26, junto com `share.failed` e
`voice.occupancyChanged`. `dm.signal` e `dm.call` são a **quarta** ocorrência da mesma
omissão, e a primeira em que ela é fatal em vez de invisível: sem as duas linhas, §31.15
inteira não tem implementação possível.

O que decidiu a favor de emenda, e não de uma B68, foi o teste que B66 e B67 passam e este
não: **nada aqui é inexpressível nem inverificável**. B66 existe porque uma chave não é
declarada em lugar nenhum do fio e a regra fica assimétrica; B67 porque um schema não carrega
o campo que a regra exige. Aqui todo comportamento já está fixado — o canal, a disciplina, a
autorização por `remotePublicKey`, o `dmTurnSecret` com o mesmo `'turn-cred/1'` e o mesmo
TTL —, e o que faltava era **nomenclatura**. Os campos são o que sobra de `voiceSignal` e de
`voiceJoin` depois da tabela de remoções, e cada campo ausente é uma linha declarada dela:

| Ausente | Linha de §31.15 |
|---|---|
| `ticketId` | Ticket de mídia (§17.4) — **não reutilizado** |
| `toPeerKey` | Roster — **não existe**; há um par só |
| `sessionId` de host, `channelId` | Não há host e não há canal; o escopo é a conversa |
| `roster[]`, `tickets[]` | Roster e ticket, de novo |
| `quality`, `share.*`, fila | §17.5/§16.4 não têm análogo numa dupla |

As emendas ficaram em §31.8 (as duas notificações), §31.15 (o mapa de onde cada linha vira
superfície), §31.16.1 (`dm.callJoin`, `dm.callLeave`, `dm.signal`), §31.16.2 (`dm.signal`,
`dm.callState`) e §16.1 (a linha do `p2p-dm/1`).

### 109.3 O serviço de §17.3, simétrico, e o que a simetria custa

§17.3 é serviço **por nó**: um `MediaServer` por processo, na mesma socket UDP do UDX,
demultiplexado pelo magic cookie. Uma comunidade hospedada se registra nele com o
`hostTurnSecret` dela; uma conversa passa a se registrar com o `dmTurnSecret` dela, e o
`conversationId` entra no slot do `communityId` — a **mesma substituição** de §31.14.

Três consequências, e nenhuma é cosmética:

1. **`MediaHost.registrar` deixou de pedir `VoiceHostSessions`.** O `MediaServer` sempre
   consumiu só `participantKeys(sessionId)`; declarar essa porta mínima é o que deixa a
   conversa se registrar sem inventar uma comunidade de mentira para carregá-la. Numa dupla o
   roster do serviço é a conversa — as duas chaves —, e a permissão de RFC 5766 §9 continua
   valendo sobre o menor conjunto possível.
2. **Uma instalação que só tem DM passa a servir STUN/TURN.** A criação do `MediaHost` saiu
   de dentro do caminho de comunidade hospedada e virou `garantirMediaHost()`, com dois
   chamadores. Ele continua nascendo **sob demanda**: quem nunca ligou para ninguém não passa
   a escutar STUN por causa desta fatia.
3. **A credencial que eu uso contra o TURN do par não é derivável aqui.** Ela foi emitida com
   o `dmTurnSecret` **dele**, que sai da `dataKey` dele. Ela viaja no `dm.call{on:true}`, e é
   por isso que a resposta de `dm.callJoin` pode nascer sem serviço nenhum do outro lado: numa
   dupla não há host que já saiba a resposta dos dois.

`dmTurnSecretFrom` ficou em `l0/corestore`, ao lado de `hostTurnSecretFrom`, pelo mesmo
argumento de §108.2 — derivar chave é ciclo de vida, não decisão de conteúdo (§4).

### 109.4 A malha só sobe quando o outro atende, e isso é §99.13

A garantia que §17.2 anuncia — "quando o STUN do host resolve, o de terceiro não é
consultado" — não vem da ordem da lista (§99.2 desmentiu isso); vem da **coleta em duas
fases** de §99.13, em que a `RTCPeerConnection` nasce só com o que o host serve.

Numa DM quem faz o papel do host é o par. Antes de ele atender, o serviço dele **não existe**,
e subir a malha ali entregaria o STUN de terceiro ao agente na primeira coleta — exatamente o
que a fase 1 existe para evitar. Então a malha sobe no `dm.call{on:true}`, e antes disso o
estado é `chamando` e não há `RTCPeerConnection` nenhuma. É também o modelo honesto: antes do
atendimento não há com quem negociar.

Isso está declarado em §31.15 como consequência da simetria, ao lado da segunda: **o reanúncio
é resposta a uma transição, nunca à repetição de um nível.**

### 109.5 O defeito que só dois nós reais revelaram

Os dois lados reanunciam a própria oferta quando o outro entra — é o análogo do instantâneo
que §16.3 manda o host mandar na conexão de um membro novo, e sem ele quem entra depois nunca
recebe o serviço de quem já estava dentro.

Na primeira versão o reanúncio era resposta ao **nível**: recebi `on:true`, reanuncio. Com dois
núcleos reais e Noise de verdade, o resultado foi **ping-pong** — A anuncia, B reanuncia, A
reanuncia, e os dois trocam `dm.call` para sempre pelo mesmo cabo. Medido: dezenas de quadros
entre dois nós que só queriam se avisar, e o teste de duas pontas travando por 5 s até o
limite.

A correção é uma linha e a razão dela é o que importa: `dmCall` guarda o que sabia do par, e
só age na **transição**. O caso está isolado em teste (`repetir o MESMO nível não reanuncia
nem reemite`), e a mutação que o confirma é remover a guarda.

Duas coisas menores do mesmo tipo:

- **A oferta entra no mapa antes do aviso.** Quem recebe o aviso compõe a lista do agente
  lendo `ofertaDoPar`; avisar primeiro entregaria uma lista sem o que acabou de chegar. É a
  mesma inversão da oferta que chegava antes do ticket (§89).
- **Sair esquece o que eu sabia do par.** Sem isso, a chamada seguinte nasceria com ele
  marcado como presente sem ninguém ter dito.

### 109.6 A tela, e as duas coisas que ela não pode fazer

O botão de chamar mora no cabeçalho da conversa, e as regras estão em
`features/dm/dmRegras.ts` — fora do JSX, pela razão de §107.1: proibição de texto só é
verificável se houver função a chamar.

- **`acoesDeChamada` só devolve algo em `accepted`.** Antes do aceite não existe o meu core
  (§31.9 regra 1) e `autorizaDm` não abre o canal; um botão de ligar num pedido pendente
  prometeria um caminho que o transporte recusa.
- **`faixaDeChamada` não pode oferecer relay** (**L-29**). O desfecho de falha é o diagnóstico
  de rede de §99 **mais** `TEXTO_CHAMADA_SEM_RELAY`, que declara a ausência de terceiro sem
  oferecer nada. O tipo carrega `podeOferecerRelay: false` para que o teste possa afirmar a
  ausência, e o teste varre o texto atrás de `relay`, `voluntári`, `outro membro` e `peça a`.
- **"Chamando" e "Chamada recebida" são fato local.** Não dizem "está tocando lá": isso
  exigiria um atestado que o protocolo não dá, a mesma disciplina que impede `delivered` de
  virar "lido" (§31.11).

O painel tem **mudo e desligar**, e nada mais. Ensurdecer não existe (numa dupla é desligar),
silenciar o outro não existe (é moderação, e §31.15 remove a moderação inteira), e o mudo
**não sai da máquina**: não há `voiceState` numa DM, e inventá-lo seria mecanismo sem
destinatário. Ele é efetivo, não conselho (**L-12**).

`MalhaDeVoz` ganhou **um** campo, `autorizacaoPorTransporte`, e o comentário dele é o
contrato: numa comunidade continua valendo o passo 4 de §17.4, e ligá-lo lá desfaria a
propriedade que `T-15` fechou.

### 109.7 Verificação

`core`: `npm run build` (§4, **113 arquivos**, raiz de composição com 22), `npm run typecheck`
e `npm test` — **1 189 testes, 0 falhas**, de 1 163, rodado **três vezes seguidas**. Os 26
novos são 23 de `test/dm-chamada.test.ts` e 3 de `test/dm-ipc.test.ts` (a sinalização sobre o
cabo de verdade, com Noise e dois núcleos).

`frontend`: `npm run build`, `npm run lint` (sem aviso) e `npm test` — **440 testes, 0
falhas**, de 416. Os 24 novos são 13 de `live/__testes__/dmVoz.test.ts`, 8 de
`features/dm/__testes__/dm-regras.test.ts` e 3 de `live/__testes__/voz.test.ts`.

`app`: `xvfb-run -a npm run smoke:voz` (§98) — o caminho de mídia foi tocado
(`autorizacaoPorTransporte` em `frontend/src/live/voz.ts`), e ele é a única evidência de duas
pontas com WebRTC real.

**Cinco mutações, uma por asserção central, cada uma conferida isoladamente:**

| Mutação | Cai |
|---|---|
| `autorizacaoPorTransporte` ignorado em `voz.ts` | `voz.test.ts` — "o roster É a autorização" |
| A guarda de transição removida de `dmCall` | `dm-chamada.test.ts` — "repetir o MESMO nível não reanuncia" |
| A marca `terceiro` apagada da lista do agente | `dm-chamada.test.ts` — 3 casos da composição de ICE |
| `TEXTO_CHAMADA_SEM_RELAY` trocado por uma oferta de relay | `dm-regras.test.ts` — 2 casos de **L-29** |
| `dm.signal` fora da tabela fechada de §31.8 | `dm-ipc.test.ts` — a sinalização não atravessa |

A quinta é a que vale registrar: ela é o defeito de `voice.failed` reproduzido de propósito, e
o que ela mostra é que a tabela fechada **é** o mecanismo — sem a linha, o quadro sai, o
`notify` devolve `false` e nada acontece, em silêncio.

### 109.8 O que NÃO entrou

**Câmera e tela numa DM.** §31.15 fala de mídia, e §17.2 põe câmera na mesma malha; a
`MalhaDeVoz` já sabe carregar vídeo (§93). O que não entrou é a **superfície**: não há botão
de câmera nem de tela na conversa direta, e a tela em estrela de §17.5 numa dupla é uma malha
de dois com outro nome. É trabalho de superfície sobre contrato que já existe, e não abre
lacuna nova.

**Reentrada automática depois de respawn do núcleo.** É **B43**, e ela vale igual aqui: o
núcleo reinicia no meio da chamada, o renderer re-assina, e a sessão de mídia morre sem evento.
§17.4 declara que **não** decide reentrada, e §31.15 não a decide também.

**Nenhuma medida de rede real.** Continua sendo **B4**, e agora com uma superfície a mais para
medir.

**B63, B66 e B67 continuam abertas.** Nenhuma delas é de mídia.

**A fase 11 fecha com esta fatia.** B54..B62 e B65 estão fechadas (§100..§109); do lado humano
sobram B63 (navegação e política de notificação) e B64 (deep link para chave de identidade).

## 110. A conversa direta ganha porta de entrada — 2026-09-02

Achado pelo operador logo depois de §109, olhando a tela: **não havia como iniciar uma
conversa.** A DM sabia receber pedido, aceitar, bloquear, esquecer, escrever, anexar e
chamar — e não sabia começar.

### 110.1 O que existia, e por que ninguém viu

| Camada | Estado antes desta fatia |
|---|---|
| Núcleo | `dm.open{peerKey}` funcionando desde §105 |
| Ponte | `abrirConversaCom(peerKey)` em `live/dm.ts` desde §107 — **sem nenhum chamador** |
| Tela | Nada. `DmList` só aceita/bloqueia/esquece pedidos que chegaram |

`abrirConversaCom` era **superfície morta**, e é a mesma família do tópico declarado sem
produtor que §82.3 nomeia — só que do lado do renderer, e visível para quem abre o programa.

O buraco caiu entre dois itens do backlog e não estava em nenhum dos dois. **B63** é "onde a
DM mora na navegação", e §107.4 já a resolveu de fato adotando a proposta B63(a). **B64** é a
rota de deep link (`comunidadep2p://u/<KEY64>`), e ela troca a **forma de obter** a chave —
§31.25 registra, textualmente, que "hoje o único caminho para abrir uma conversa é colar 64
caracteres hex". Ninguém escreveu a tela em que se cola. B60 (§107) construiu a lista e a
conversa a partir de U-33 e não notou que U-33 descreve o **destino**, não a entrada.

Não é decisão de produto pendente: `dm.open` está declarado em §31.16.1, o lugar já foi
decidido, e um comando sem chamador na tela é defeito. Por isso entrou como correção, sem
item novo.

### 110.2 Por que é um campo de chave, e não uma busca

**L-24** é o que decide a forma: a chave pública de identidade **é** o nó na DHT, e não há
diretório, não há registro e não há tópico de descoberta. §31.8 chega a considerar o
rendezvous por segredo compartilhado e o recusa — entre outras razões, porque ele **não
funciona no primeiro contato**. Não existe "quem é fulano?" a implementar.

Então a tela é um campo, e o texto diz por quê (`TEXTO_NOVA_CONVERSA`). A tolerância do
parser é deliberada e limitada, e o teste afirma os dois lados:

- **some o que não muda o valor** — espaço, quebra de linha e caixa. Sessenta e quatro
  caracteres copiados de um chat ou de um e-mail chegam quebrados o tempo todo, e recusar
  por isso transformaria formatação em erro do usuário;
- **é recusado tudo o que muda** — `0x`, comprimento errado, caractere fora do hex, e
  **a URL de B64**. Aceitá-la seria implementar por antecipação uma decisão de gramática
  normativa fechada (§3.5) que não foi tomada. Há mutação para esse caso.

Duas recusas com razão própria: a **própria chave** (§31.2 regra 5 — `lo = hi` não é
conversa; o núcleo devolveria `E_VALIDATION.peerKey`, e dizer isso aqui é mais honesto do que
traduzir um erro genérico depois) e a chave de **quem já está na lista**, que abre a conversa
existente em vez de parecer criar um pedido — `dm.open` é **derivado, nunca atribuído**
(§31.2 regra 1), e um "pedido enviado" ali seria mentira sobre o que aconteceu.

### 110.3 O custo de §31.9 regra 5, no momento em que é relevante

A regra manda o custo da política de contato aparecer na UI, e §107.4 já o pôs na tela de
ajustes. Ele aparece agora também no diálogo, quando a política está em `shared-community`.

O texto fala **só da política desta máquina**, e o teste varre para garantir isso: a política
do destinatário este nó não conhece, e um pedido recusado por política do outro lado é o
**mesmo silêncio** de um pedido recusado por bloqueio (§31.9 regra 2, **L-28**). Afirmar
qualquer coisa sobre o outro lado desfaria L-28 pelo mesmo caminho lateral que §106.2 já
tinha fechado nos rótulos de entrega.

Nada aqui é irreversível, e por isso a confirmação não é modal de perigo: `pending-out` é
estado **local** (§31.9) e `dm.forget` o desfaz. O que ela custa — o nó passa a anunciar-se
na DHT e a procurar aquele par (§31.8) — está no texto.

### 110.4 Abrir abre

`abrirConversaCom` sincronizava a lista e devolvia o id. Agora ela abre a conversa: quem colou
uma chave quer falar, e mandar escolher de novo na lista o que acabou de pedir é trabalho a
troco de nada. Abrir **não aceita nada** — §31.9 regra 1 vale do lado de quem recebe.

O vazio da lista também passou a apontar a saída. Sem busca (L-24), "Nenhuma conversa ainda."
deixava a pessoa sem próximo passo nenhum.

### 110.5 Verificação

`frontend`: `npm run build`, `npm run lint` (sem aviso) e `npm test` — **453 testes, 0
falhas**, de 440. Os 13 novos são 10 de `features/dm/__testes__/dm-regras.test.ts` e 3 de
`live/__testes__/dm.test.ts`.

`core` não foi tocado; `npm test` conferido em **1 189, 0 falhas**.

**Três mutações, conferidas isoladamente:**

| Mutação | Cai |
|---|---|
| `abrirConversa` removida de `abrirConversaCom` | `dm.test.ts` — "colar uma chave abre a conversa" |
| O parser passando a aceitar `comunidadep2p://u/…` | `dm-regras.test.ts` — "a rota de deep link NÃO é aceita por antecipação" |
| A busca por conversa existente devolvendo sempre `null` | `dm-regras.test.ts` — "chave de quem já está na lista" |

### 110.6 O que NÃO entrou

**Prévia do `handle` antes de abrir.** Derivar `@k3f9-2mqa` da chave colada exigiria uma
segunda implementação de §6.1 no renderer, e duas implementações da mesma derivação divergem.
O `handle` real vem do núcleo assim que a conversa existe, e é ele que a lista e o cabeçalho
mostram (`DmPeerLabel`, mitigação (a) de **L-5**). Fechar isso direito é um comando de
consulta, não uma cópia da derivação — e nada nesta fatia depende dele.

**B64 continua aberta e não foi antecipada.** O campo é o caminho de hoje; a URL é a
melhoria, e ela é decisão do operador sobre gramática normativa fechada.

**B63(b) continua aberta** — o silenciar por conversa não entrou aqui nem em §107.

## 111. U-34 — a chave pública é um endereço, e a outra metade da porta — 2026-09-02

Segunda pergunta do operador sobre a mesma tela: §110 fez a pessoa **colar** a chave de
alguém; e como ela **obtém** a chave que vai colar? Não obtinha. A própria chave só aparecia
truncada em Configurações → Minha conta, sem copiar.

### 111.1 Por que desta vez houve texto normativo antes de código

§110 foi defeito puro: `dm.open` declarado, sem chamador. Esta metade esbarra em
`frontend.md` §10 3.1, que diz textualmente "identificador local e **chave truncada** em
somente-leitura".

Isso contradiz §31. Por **L-24** a chave pública **é** o nó na DHT; `dm.open` recebe hex64
cru (§31.16.1); §31.25 registra que "o único caminho para abrir uma conversa é colar 64
caracteres hex" — o que pressupõe que o outro lado consiga **fornecê-los**. Truncada ela não é
fornecível, e §31.8 fecha as alternativas: não há diretório, não há busca, e o rendezvous
derivado de segredo compartilhado foi recusado porque não funciona no primeiro contato.

A precedência do `CLAUDE.md` resolve o conflito (`backend-v2.md` 1 > `deltas-ux-v2.md` 4 >
`frontend.md` 5), mas resolvê-lo **só no código** seria fazer código e normativo divergirem em
silêncio, que é o que §17.2 já teve de emendar em 2026-08-25 por essa mesma razão. Então saiu
**U-34** primeiro, e o código depois.

### 111.2 O achado que a pergunta destravou: L-24 nunca entrou em §25.8

Ao procurar a superfície obrigatória de L-24 para escrever U-34, a linha não existia: a
tabela de §25.8 pula de **L-23** para **L-25**.

L-24 é declarada e numerada em §14.3 desde sempre ("**LIMITAÇÃO DECLARADA (L-24):** a chave
pública de identidade é, portanto, o nó na DHT"), e §31.8 a cita como fundamento da descoberta
inteira. Ela nunca chegou à lista que se declara completa.

A consequência é a mesma família de §106.5, invertida. Lá o **cabeçalho** de
`deltas-ux-v2.md` dizia "L-1 a L-22" e §25.8 tinha crescido; aqui o cabeçalho diz "L-1 a
L-29" e §25.8 é que estava com um buraco. Nos dois casos o efeito é o mesmo: **a regra de
completude fica incapaz de detectar a falta que ela existe para detectar.** Se L-24 estivesse
na tabela desde o começo, a ausência de superfície para "entregar a própria chave" teria
aparecido em §106, quando U-33 foi escrita.

A linha entrou, com a nota de que é **correção de omissão e não limitação nova** — a própria
regra de §25.8 diz que acrescentar limitação é decisão de produto e segurança, e nada foi
decidido aqui: o texto de §14.3 já era normativo. A superfície obrigatória dela são duas, e
as duas agora existem: o aviso de metadado de presença (**U-27**) e a chave inteira e
copiável mais o campo para colar a do outro (**U-34**, **U-33**).

### 111.3 A distinção que a tela era obrigada a fazer e não fazia

Sob a chave **pública** truncada estava escrito:

> "Esta chave existe só neste dispositivo. Ninguém, em lugar nenhum, tem uma cópia dela."

Isso é verdade da chave **privada** e falso da pública — a pública está, por construção, na
DHT e no log de toda comunidade de que a pessoa participa. Colada ali, a frase lê como **"não
compartilhe"**, que é o oposto do que §31.8 exige. Com um botão "copiar" ao lado, a
ambiguidade deixaria de ser teórica.

As duas passaram a ser nomeadas separadamente, e os textos moram em
`features/settings/chaveDeIdentidade.ts` — fora do JSX, pela razão de §107.1: U-34 é
sobretudo distinção de texto, e distinção só é verificável se houver constante a chamar. O
teste afirma as duas direções, e a mutação que devolve a frase do dispositivo para o texto da
pública derruba três casos.

A UI continua **sem** oferecer exibir, exportar ou copiar a chave privada: §3.2 item 5 não dá
superfície para material de chave, e `identity.export` (U-01) é backup cifrado, não exibição.

### 111.4 Inteira, e sem reformatar

`chaveParaExibir` devolve os 64 caracteres e mais nada. Agrupar em blocos ajudaria a conferir
a olho e foi recusado: faria **o que se vê divergir do que se copia**, e a chave é um valor a
transportar, não um número a ler em voz alta. Sem identidade carregada ela devolve `null` — a
tela não inventa placeholder para endereço.

Um teste fecha o ciclo das duas fatias: o que `chaveParaExibir` entrega é aceito por
`lerChaveDeIdentidade` (§110), com o mesmo valor. O que uma tela dá, a outra recebe.

### 111.5 Verificação

`frontend`: `npm run build`, `npm run lint` (sem aviso) e `npm test` — **462 testes, 0
falhas**, de 453. Os 9 novos estão em `features/settings/__testes__/chave-de-identidade.test.ts`.

`core` não foi tocado.

**Duas mutações:**

| Mutação | Cai |
|---|---|
| `chaveParaExibir` voltando a truncar (`slice(0,8)…slice(-4)`) | 3 casos de "a chave vai INTEIRA" |
| A frase do dispositivo devolvida ao texto da chave pública | 3 casos de "o texto convida a entregá-la" |

### 111.6 O que NÃO entrou

**QR code, ou qualquer outra forma de transporte.** U-34 diz que a chave precisa ser
copiável; **B64** é quem decide se existe uma URL (`comunidadep2p://u/<KEY64>`), e mexer na
gramática fechada de §3.5 é do operador. §110 já recusa a URL no parser de propósito, com
mutação.

**Prévia do `handle` de uma chave colada** continua fora (§110.6): derivá-la no renderer seria
uma segunda implementação de §6.1.

**`frontend.md` §10 3.1 não foi editado.** Ele é precedência 5 e continua dizendo "chave
truncada"; quem vence é U-34, e é assim que este repositório trata divergência entre os dois —
o delta é a emenda, e o documento histórico não é reescrito.

## 112. A câmera entra na conversa direta, e a tela vira B68 — 2026-09-02

§109.8 deixou "câmera e tela numa DM" nomeado como superfície que faltava, e escreveu que
"não abre lacuna nova". **A metade da câmera confirmou-se; a metade da tela não.** As duas
não têm o mesmo estatuto normativo, e a fatia é sobretudo o trabalho de separá-las antes de
escrever qualquer linha.

### 112.1 O teste de §109.2, aplicado às duas separadamente

§109.2 fixou o critério: é **inexpressível ou inverificável** sem texto novo (lacuna), ou é
**nomenclatura derivável** das tabelas vizinhas (emenda no ponto)? B66 e B67 passam no
primeiro; `dm.signal`/`dm.call` passaram no segundo. Aqui as respostas são diferentes, e é
esse o resultado.

| | Câmera | Tela |
|---|---|---|
| O que §31.15 diz | "Vale §17.2 sem alteração", e a tabela de §17.2 diz `Voz e câmera │ WebRTC mesh` — a **mesma** malha, a mesma `RTCPeerConnection` (§93) | **Nada.** §17.5 não aparece em linha nenhuma da tabela de remoções de §31.15 |
| Comportamento fixado por texto? | Sim, inteiro: topologia, transporte, autorização (a do canal), ciclo de vida (a malha de §109) | Não. §17.5 é estrela **autorizada pelo host**: sessão, ticket, roster de espectadores, revogação |
| Falta o quê? | Nada — nem comando, nem notificação, nem campo | Quem cria a sessão sem host, quem emite `share.health`, a quem `share.setQuality` pede, quem decide a degradação |
| Verificável por quem recebe? | Sim, e trivialmente (§112.3) | **Não** — B41 sem `share.join` |
| Desfecho | **Implementada** | **B68** |

O detalhe que decide a coluna da direita é que os **cinco passos** do laço de saúde de §17.5
passam todos pelo host: ele registra o perfil pedido por espectador (1), recebe `share.report`
(3), consolida e aplica a degradação (4), e emite `share.health` só ao apresentador (5). §31.15
remove o host. Não sobra de quem derivar os passos 1, 3, 4 e 5 — e "numa dupla a estrela é uma
malha de dois com outro nome" é uma frase que **o texto normativo teria de dizer**, não uma
que se implementa por analogia. CLAUDE.md: se a especificação não responde, não invente
comportamento.

### 112.2 A câmera, e por que ela não custou fio nenhum

`CameraDaChamada` (`live/camera.ts`) foi reusada **sem uma linha de condicional**: ela já
nasceu em §93 falando com a malha por uma porta que só conhece "trilha de vídeo local", e o
comentário de cabeçalho dela já argumentava, desde então, *por que a câmera é da malha e a
tela não é*. Uma `CameraDaDm` teria sido uma segunda implementação da mesma coisa.

O que **não** acompanhou a câmera é o `voice.setSelf{cameraOn}` da comunidade. Ele é **aviso
ao host** (§15.4), e numa DM não há host nem `voiceState` — a mesma razão pela qual §109.6
recusou mandar o mudo pelo fio. Nenhuma linha entrou na tabela fechada de §31.8, e essa
ausência é o ponto: se a câmera tivesse precisado de uma, ela seria a quinta ocorrência da
omissão de §109.2, não uma derivação.

**Um botão só, e só com a chamada de pé.** A `RTCPeerConnection` só nasce quando
`dm.call{on:true}` chega (§31.15 consequência 1 / §99.13); em `chamando` e em `recebendo` não
há malha a que anexar a trilha, e um botão ali capturaria o dispositivo para não o mandar a
lugar nenhum. `acoesDeVideo` é quem recusa, fora do JSX, pela razão de §107.1.

### 112.3 B41 numa DM: a câmera está segura, e é a tela que a tornaria insegura

Na comunidade nada no fio diz se uma trilha de vídeo é a tela ou a câmera, e
`classificarVideo` decide cruzando o `msid` com o `share.join` que **este** lado conseguiu.
Numa DM não existe `share.join`: a regra 3 de `videoRecebido.ts` fica sem entrada, e a
heurística de lá não atravessa.

`dmVoz.ts` **não chama `classificarVideo`**, e isso não é atalho:

- Enquanto a câmera for a única trilha de vídeo possível, toda trilha de vídeo de um par é a
  câmera dele **por construção** — a classificação é trivial e total, não heurística.
- Admitir a tela sem campo no fio tornaria a classificação **inverificável**, que é
  exatamente o critério de B66 e B67. Não há estado local a conquistar do lado de quem
  recebe: numa DM não há `share.join` que se possa ter conseguido.

Ou seja: B41 não fica menor numa DM — fica **fatal**, e é a segunda razão independente pela
qual a tela é B68. O comentário no ponto diz que é aquela linha que quebra se a tela entrar,
e que ela não quebra em silêncio: as duas imagens se sobreporiam no mesmo tile.

### 112.4 Como o par descobre a câmera, sem roster

§31.15 remove o roster, e nenhuma notificação de §31.8 declara câmera. A única evidência
disponível de que o outro ligou a câmera é **local**: a trilha chegando. É a mesma disciplina
que a comunidade já usa (`cameraDoParChegou` é setado pela trilha, antes do eco do roster que
a confirma) — aqui sem o eco, porque não há quem o emita.

O desligamento segue o mesmo caminho: `removeTrack` do outro lado chega como
`mute`/`ended` na trilha recebida. Isso é observação, não afirmação sobre o par — a mesma
disciplina que impede `delivered` de virar "lido" (§31.11) e "Chamando" de virar "está
tocando lá" (§109.6).

### 112.5 A faixa da câmera é separada da faixa da chamada, de propósito

`faixaDeChamada` cola `TEXTO_CHAMADA_SEM_RELAY` em **toda** falha, porque ali a falha é de
conectividade e L-29 é a consequência exata. Uma câmera que o sistema operacional recusou não
tem nada com relay nenhum, e emendar a frase a ela mandaria a pessoa procurar defeito na rede.
Por isso `faixaDeCamera` é função própria, e o motivo vem de `motivoDoErroDeCamera` (§20.1),
que já distingue autorizar, trocar de dispositivo e fechar o outro aplicativo.

### 112.6 O painel: dois tiles, e nunca mais que dois

`DmVideoPanel` não tem grade que cresça, tira de miniaturas nem seletor de foco — os três são
superfície de uma chamada com mais de duas pessoas, e numa DM não há terceiro possível
(§31.15). Ele também **não reserva o lugar da tela**: um painel que já o mostrasse prometeria
uma superfície que a norma não descreve.

Sem imagem de lado nenhum o painel não renderiza: uma chamada só de voz não precisa de duas
caixas pretas ocupando a conversa que a pessoa abriu para ler. O `MediaStream` mora fora do
React (`live/cameraStreams.ts`, reusado sem alteração — "voz é uma só", então não há chamada
de comunidade concorrendo pelo mapa); o que atravessa a store é `videoSeq`, a ordem de ir
buscá-lo.

### 112.7 Verificação

`frontend`: `npm run build`, `npm run lint` (sem aviso) e `npm test` — **475 testes, 0
falhas**, de 462. Os 13 novos são 8 de `live/__testes__/dmVoz.test.ts` e 5 de
`features/dm/__testes__/dm-regras.test.ts`.

`core`: **não foi tocado** — a fatia inteira é renderer, e essa é a evidência mais forte de
que a câmera é derivação: uma superfície que precisasse de fio teria mexido em
`composition/dmCall.ts` e na tabela fechada de §31.8. `npm run build` (§4, **113 arquivos**),
`npm run typecheck` e `npm test` — **1 189 testes, 0 falhas**, rodado **três vezes seguidas**
(§105.5), sem variação.

`app`: `xvfb-run -a npm run smoke:voz` (§98) — o caminho de mídia foi tocado
(`definirVideoLocal` passou a ter chamador numa DM), e ele é a única evidência de duas pontas
com WebRTC real. **`VEREDITO=PASSA`**, com mídia nos dois sentidos (8 950 B e 7 419 B) e
11 176 B depois da troca de canal e da reentrada.

**Seis mutações, uma por asserção central, cada uma conferida isoladamente — cada uma derruba
exatamente um caso:**

| Mutação | Cai |
|---|---|
| `acoesDeVideo` sem a guarda de `na-chamada` | `dm-regras.test.ts` — "a câmera só existe com a malha de pé (§99.13)" |
| `faixaDeCamera` emendando `TEXTO_CHAMADA_SEM_RELAY` | `dm-regras.test.ts` — "a câmera recusada NÃO herda L-29" |
| `ligarCamera` sem a guarda de estado | `dmVoz.test.ts` — "não liga fora da chamada" |
| `desligar` sem apagar a câmera | `dmVoz.test.ts` — "o dispositivo é desta máquina e ninguém o apaga por ela" |
| `onmute`/`onended` removidos da trilha recebida | `dmVoz.test.ts` — "a trilha parando é o ÚNICO sinal" |
| `ligarCamera` anunciando por `dm.signal` | `dmVoz.test.ts` — "não há `voice.setSelf` numa DM" |

A varredura de "nenhum estado oferece tela" é o caso que **não** tem mutação de código: ela
percorre os 20 pares de (estado da conversa × estado da chamada) e afirma a ausência em todos.
O que a derrubaria é acrescentar a tela — que é precisamente o que B68 guarda.

### 112.8 O que NÃO entrou

**A tela numa conversa direta. É a B68**, registrada em `docs/backlog.md` do lado humano, no
molde de B66/B67. A implementação parou onde a norma para: não há `dm.share*` inventado, não
há sessão sem host e não há `capture.authorize` contra um `sessionId` que não existe.

**Nada mudou em B41 nem em B4.** B41 continua exatamente como está — a fatia não a fecha nem
a agrava; ela apenas mostra que na DM a lacuna é bloqueante em vez de estreita, e é isso que
B68 cita. B4 ganha uma superfície a mais para medir em rede real (vídeo é o `encoder de vídeo
real` que os `openCriteria` de G7/G8 já nomeavam), e continua sendo a única coisa que o
`REQUIRES POC` de §31.15 trava.

**Resolução, taxa de quadros e escolha de câmera na conversa.** A preferência de dispositivo é
de §10 (3.1) e mora no `settingsStore`, como o microfone; não há superfície nova, e o
`applyConstraints` de §17.5 é do apresentador de tela, que aqui não existe.

**Reentrada automática depois de respawn do núcleo** continua sendo **B43**, como §109.8 já
registrava.

## 113. O m-line vira o discriminador, B41 e B68 fecham juntas — 2026-09-03

§112 deixou a tela da conversa direta como **B68**, do lado humano, com duas razões: §17.5
depende do host em cada peça, e **B41** deixa quem recebe sem como distinguir tela de câmera
numa dupla. O operador aprovou a decisão recomendada e autorizou a emenda normativa. Esta
fatia executa as duas — e elas são **uma decisão só**, não duas.

### 113.1 Por que B41 tinha de cair primeiro

B68 estava registrada como precisando de duas respostas. A segunda é que decide a ordem: sem
distinguir tela de câmera, a tela numa DM é **inverificável**, e o critério de B66/B67 recusa
implementá-la. Então a pergunta virou "o que fecha B41?".

B41 pedia **uma correlação nova em §15.5/§15.6** — superfície de IPC ligando um `MediaStream`
à sessão de tela. Ela não é necessária: a distinção já existe no protocolo que §17.2 usa e só
não estava sendo exigida. Cada trilha vive num **m-line**, o m-line é negociado na SDP ponta a
ponta, e o que faltava era **fixar o significado de cada um**:

| Posição | Conteúdo | `kind` |
|---|---|---|
| 0 | Voz | `audio` |
| 1 | Câmera (§17.2) | `video` |
| 2 | Tela — imagem (§17.5) | `video` |
| 3 | Tela — som (§17.5) | `audio` |

Nenhum campo entrou no IPC-R; nenhuma linha entrou nas tabelas fechadas de §16.3 ou §31.8. O
discriminador **não atravessa o núcleo** — ele vive na SDP, que §17.2 já manda viajar ponta a
ponta e que o núcleo já declaradamente não lê. É a mesma forma de argumento de §112 para a
câmera: o que parecia lacuna era nomenclatura de uma coisa que já estava no fio.

**O que a emenda dá além de B41**, e nada disto é sobre tela:

1. Ligar e desligar câmera ou tela deixou de custar renegociação. Antes, cada liga/desliga era
   um round-trip de SDP **por par** da malha.
2. A metade de **áudio** da mesma lacuna caiu junto. §17.2 dizia que a voz é "o áudio do
   primeiro stream deste par" e que qualquer outro "é som que veio junto com uma tela" —
   também heurística. Agora a posição diz.
3. **A ausência virou observável.** `replaceTrack(null)` deixa a trilha do outro lado em
   `muted` em vez de a fazer sumir; "o par desligou a câmera" passou a ser evento do WebRTC,
   medido localmente. É exatamente isto que torna a tela possível numa DM, onde não há roster.
4. Some a classe de defeito do m-line duplicado que a guarda de `senderDeVideo` existia para
   evitar.

O custo, declarado: toda conexão negocia quatro m-lines, inclusive numa chamada só de voz. São
quatro seções de SDP sobre o mesmo transporte BUNDLE — não quatro portas, nem quatro alocações
TURN, nem quatro fluxos DTLS.

### 113.2 A tela na DM: o que sobra de §17.5 quando o host sai

§31.15 ganhou a linha que faltava — numa dupla a estrela **é** a malha de dois. Some sessão,
`sessionId` de host, ticket, `share.join`, roster de espectadores, `E_ALREADY_SHARING` do host
e revogação. Sobra `replaceTrack` no m-line 2.

**O laço de saúde sai inteiro, e isso não é recorte de escopo.** §17.5 mede, consolida e
degrada porque **um upload serve N espectadores**: a estimativa de uma conexão não dá política
sobre as outras, e por isso o host precisa ser autoridade. Com **N = 1**, a estimativa daquela
conexão **é** a política, e o `transport-cc` adapta o encoder continuamente — melhor que três
perfis fixos e sem RPC no meio. Some junto a razão declarada de "quem mede não decide", que
existe para impedir um espectador de empurrar o perfil dos **outros**: numa dupla não há outros.

O que **não** muda: §17.3 (emenda de 2026-08-28) — tela não sobe por caminho relayado —
continua valendo, porque é conselho do lado que empurra e não depende de host. E na
**comunidade** a autorização segue intacta: o apresentador põe a trilha no m-line reservado
**da conexão daquele espectador** e deixa as demais em `null`. Reservar o m-line não concede
audiência.

### 113.3 `capture.authorize` sem sessão de tela

O main nega toda captura sem sessão declarada (`T-41`), e essa falha fechada **não** foi
afrouxada. O que mudou é o que se declara: o `conversationId`, a mesma substituição que
§31.15 já faz em `dm.callJoin`. O núcleo responde a partir do único fato local que existe —
**estou nesta chamada agora** —, e ele é tão forte quanto o `captureToken` era: os dois são
estado deste processo, e nenhum vai ao host. Sair fecha a captura no mesmo instante, que é o
que substitui a revogação de §17.5. A ordem é falha fechada: só se chega ao ramo de DM depois
de o roteador de comunidade ter recusado.

### 113.4 Os dois defeitos que só duas pontas revelaram

A emenda parecia trivial de implementar e **não era**. Duas suposições minhas passaram na
unidade inteira e morreram no `smoke:voz`, as duas do mesmo tipo: assimétricas e silenciosas —
a chamada conecta, o ICE fecha, e o áudio anda num sentido só.

| Suposição | O que a medida mostrou |
|---|---|
| "Comparo `ev.transceiver` com o que criei" | Do lado que **responde**, quem associa m-line a transceiver é o `setRemoteDescription`, e o objeto que chega no `ontrack` não é o que este lado criou. As quatro trilhas caíam em "m-line não reservado" |
| "Os dois lados pré-criam os quatro" | Um transceiver criado por `addTransceiver` **não** recebe m-line de oferta remota — só os de `addTrack` recebem. Quem responde ficava com **oito**: quatro órfãos segurando as trilhas locais e quatro negociados vazios. Aquele lado não transmitia nada |
| "`replaceTrack` basta para o lado que responde" | O transceiver que o `setRemoteDescription` cria nasce **`recvonly`**, e `replaceTrack` não mexe na direção. A resposta saía dizendo "só recebo" |
| "`replaceTrack` no `#abrir` é como `addTrack`" | `addTrack` era **síncrono**; `replaceTrack` não é. A oferta saía antes de a trilha entrar no m-line 0, e quem **oferta** ficava mudo — enquanto quem responde, que tem o tempo da chegada da oferta, transmitia normalmente |

As três primeiras estão declaradas no normativo, em §17.2, porque quem implementar a partir do
texto vai tropeçar nas mesmas. A quarta é do produto e está comentada no ponto.

Cada uma virou teste de unidade **depois** de medida — inclusive a que exige que o objeto do
transceiver **não** precise ser o mesmo, que é a que a unidade jamais teria pego sozinha,
porque um duplo devolve sempre o objeto que criou.

### 113.5 O que saiu do produto

`live/videoRecebido.ts` (`classificarVideo`) foi **removido**: ele era B41 inteira. Com ele
saíram `assinouTelaDe` e `idDaTelaDe`, e o mapa `assinadas` de `telaStreams.ts` — que passou a
ser escrito e nunca lido, que é a superfície morta de §82.3 do lado do renderer.

Também saiu a heurística de áudio de `voz.ts` ("a voz é o primeiro stream que trouxe áudio").

### 113.6 Verificação

`frontend`: `npm run build`, `npm run lint` (sem aviso) e `npm test` — **487 testes, 0
falhas**, de 475 (489 com a correção de §113.6b).

`core`: `npm run build` (§4, **113 arquivos**), `npm run typecheck` e `npm test` — **1 192
testes, 0 falhas**, de 1 189, rodado **três vezes seguidas** (§105.5). Os 3 novos são de
`dm-chamada.test.ts`, sobre o que autoriza a captura numa DM.

`app`: `xvfb-run -a npm run smoke:voz` (§98) — **`VEREDITO=PASSA`**, com mídia real nos dois
sentidos (10 418 B e 11 342 B) e 10 715 B depois da troca de canal e da reentrada. Ele
**reprovou quatro vezes** antes disso, e cada reprovação é uma linha da tabela de §113.4. Esta
fatia é a defesa mais forte do smoke até aqui: a suíte de unidade ficou verde o tempo todo.

**Mutações, cada uma conferida isoladamente:**

| Mutação | Cai |
|---|---|
| `ontrack` voltando a comparar identidade do transceiver | `voz.test.ts` — "o objeto NÃO precisa ser o mesmo: o que decide é o `mid`" |
| `#adotarMLines` sem forçar `sendrecv` | `voz.test.ts` — "o transceiver criado pelo navegador nasce `recvonly`" |
| Quem responde pré-criando os quatro | `voz.test.ts` — "a trilha entra nos m-lines NEGOCIADOS, não em órfãos" |
| `#adotarMLines` aceitando negociação com menos de quatro m-lines | `voz.test.ts` — "a voz não sai pelo m-line da tela" |
| `#substituirTrilhaDeAudio` voltando a procurar por `kind` | `musica.test.ts` — "escreve no m-line 0 e NUNCA no som da tela" (2 casos) |
| `enviarTrilha` renegociando | `voz.test.ts` — "a tela NÃO renegocia mais" |
| `removerVideoLocal` usando `removeTrack` | `camera.test.ts` — "esvazia em vez de remover" |
| `acoesDeVideo` sem a tela | `dm-regras.test.ts` — a varredura dos 20 pares (3 casos) |
| `iniciarTela` declarando algo que não o `conversationId` | `dmVoz.test.ts` — "não há sessão de tela a citar" |

**Uma das nove não matava, e o duplo é que estava errado.** A mutação de
`#substituirTrilhaDeAudio` sobrevivia porque o `getSenders()` do duplo devolvia a voz **antes**
do som da tela, e a busca por `kind` acertava por acidente. `getSenders()` não promete ordem
nenhuma — era disso que o código antigo dependia sem dizer —, então o duplo passou a devolver
a ordem hostil, que é legal e é o caso que quebra. Só então a mutação caiu. Um duplo que
confirma a implementação em vez do contrato não é teste; é eco.

### 113.6b O som da tela da DM não tocava, e o `<video>` é que estava mudo

Achado ao responder uma pergunta sobre **B39**, depois de §113 já commitada: o `<video>` do
painel da DM nascia `muted` sem condição. O som da tela viajava certinho no m-line 3, era
agrupado com a imagem, chegava ao elemento — e o elemento não tocava. Transmitir som para
ninguém.

O defeito estava no JSX, e é por isso que não tinha teste: a decisão "quem toca o som" não
era função nenhuma. Virou `palcoDeVideo` em `dmRegras.ts`, pela razão de §107.1 — a mesma que
já tinha tirado as proibições de texto de U-33 do componente. Duas mutações novas: calar o som
do par derruba um caso, tocar o da minha própria tela derruba outro.

Numa DM não há ensurdecer nem volume por participante (§31.15 remove os dois), então o que
resta para calar o som do par é o volume geral da máquina. Isso é **B39**, e não uma escolha
desta fatia.

### 113.7 O que NÃO entrou

**B39 continua aberta.** §17.5 é silenciosa sobre o áudio da transmissão de tela: o m-line 3
diz **onde** o som viaja, e não **de onde** ele pode vir. As opções de captura
(`systemAudio: "exclude"` em janela) continuam sendo decisão do renderer, sem texto normativo
por baixo.

**Perfis de qualidade e saúde na DM.** Não existem, por decisão registrada em §31.15 — não é
lacuna, é remoção. Se a medida em rede real (**B4**) mostrar que o congestion control não basta
numa dupla, isso é evidência nova e reabre a linha; hoje não há.

**A árvore de multicast** continua adiada (§17.8, POC-09), e nada aqui a aproxima.

**Nenhuma medida de rede real.** **B4**, de novo, e agora com a tela da DM a medir também.

## 114. B39 — o som da tela ganha texto, e o núcleo passa a vê-lo — 2026-09-03

Perguntado pelo operador logo depois de §113: por que B39 continuou aberta, se a emenda do
m-line acabara de tratar do som da tela? Porque ela respondeu **uma** das quatro perguntas de
B39, e a menos interessante.

| Pergunta de B39 | Antes desta fatia |
|---|---|
| **Onde** o som viaja | Respondida em §113: m-line 3 |
| A tela **leva** som? | Não declarado — o produto o fazia desde §83, o texto não |
| **De onde** ele pode vir | Não declarado; a política vivia só no renderer |
| Quem pode **calá-lo** | Não declarado, e com **duas** respostas desde §113 |

### 114.1 A assimetria que tornava a lacuna incômoda

O **Modo Música** é a mesma captura de áudio — §17.5 diz textualmente que ela "existe no §17.5
como efeito colateral do vídeo de tela" — e ganhou tratamento normativo completo na emenda de
2026-08-28: `music.start`, `captureToken` próprio, `kind:'music'` no `capture.authorize`, gate
de permissão declarado. **O caso derivado foi declarado e o originário não.**

A consequência estava no código: `capture.authorize` recebia `kind: 'screen' | 'music'` e
**nunca via o flag `audio`**. Ele viajava do renderer ao main, que o obedecia. O núcleo
autorizava a captura sem saber se ela levava o som da máquina inteira, e o renderer era a
única autoridade sobre isso. Não era escalada de privilégio — as duas rotas exigem
`voice_share_screen` —, era **cegueira**: o núcleo não podia recusar, registrar, nem servir de
gancho para política nenhuma.

### 114.2 O que a fatia decidiu

**1. Declarar o que já existia** (§17.5): a tela leva som, opt-in nascendo `false`; janela
capturada dá o som **daquela janela** (`systemAudio: "exclude"`), tela inteira dá o som do
sistema; e onde a plataforma não sabe separar por janela, a captura **sobe muda** — nunca cai
para "tudo o que toca aqui". Trocar silenciosamente transformaria a escolha da pessoa no seu
oposto, e é a mesma disciplina de `E_MUSIC_UNSUPPORTED`, que recusa nomeadamente.

**2. `capture.authorize` passa a levar `audio`** (§15.7), e a resposta a devolvê-lo. **Nenhuma
permissão nova** — quem pode compartilhar pode compartilhar com som. Três consequências que só
existem com a resposta vindo do núcleo:

- **`allowed` e `audio` são decisões separadas.** Som negado sobe a captura **muda**; negar a
  captura inteira puniria a imagem, que estava autorizada. É o desfecho que §17.5 já declarava
  para a plataforma sem áudio separável.
- **A permissão é lida no instante do pedido**, contra o DS corrente, e não no `share.start` —
  a mesma disciplina do gate do Modo Música. Quem perde `voice_share_screen` entre uma coisa e
  outra transmite imagem e não transmite o som da máquina.
- **Fica rastro do lado que autoriza**, e não só do lado que pede.

**3. Quem cala, por superfície**, e a diferença é consequência declarada e não acidente: numa
comunidade, ensurdecer e o volume por participante (os dois já existiam e valem para o som da
tela); numa DM, só o volume geral, porque §31.15 remove os outros dois. **Moderação não ganha
verbo novo**: quem quer calar a tela de alguém encerra a sessão, e esse verbo já existe.

### 114.3 O opt-in que a DM não tinha

Escrever "opt-in, nasce `false`" expôs que a DM de §113 pedia `audio: true` fixo — o botão de
tela não dava escolha nenhuma. Corrigido com dois itens de menu em vez de um botão
(compartilhar, e compartilhar com o som), sem seletor de fonte (o do sistema resolve) e sem
perfil de qualidade (§31.15 os remove). Capturar o som de uma máquina não pode ser efeito
colateral de clicar em "compartilhar".

### 114.4 Verificação

`core`: `npm run build` (§4, **113 arquivos**), `npm run typecheck` e `npm test` — **1 196
testes, 0 falhas**, de 1 192. Os 4 novos estão em `musica-captura.test.ts` (a decisão de som
em si) e 2 asserções entraram em `media-member.test.ts`.

`frontend`: `npm run build`, `npm run lint` (sem aviso) e `npm test` — **491 testes, 0
falhas**, de 489. Os 2 novos são o opt-in da DM.

`app`: `npm run typecheck` e `xvfb-run -a npm run smoke:captura` — **tudo verde**, com o
cenário de janela **não medido** (sem gerenciador de janelas, como sempre neste ambiente). O
smoke ganhou a tabela do som: "núcleo negou → sobe muda" é afirmado no ponto onde o main
consome a decisão.

**Mutações conferidas isoladamente:**

| Mutação | Cai |
|---|---|
| Conceder som sem conferir a permissão | `musica-captura.test.ts` — "som negado NÃO derruba a imagem" |
| Som negado derrubando a captura inteira | `musica-captura.test.ts` — a separação entre `allowed` e `audio` |
| Conceder som sem ele ter sido pedido | 3 casos — o opt-in é do pedido, não do núcleo |
| A DM pedindo som sempre | `dmVoz.test.ts` — "o som é opt-in" |

### 114.5 O que NÃO tem cobertura, e é preciso dizer

**O main honrar a decisão do núcleo não tem teste automático.** A mutação que faz o main usar
`capturaDeclarada.audio` no lugar de `decisao.audio` — isto é, voltar a obedecer o renderer —
**passa em tudo**: typecheck, unidade e `smoke:captura`, porque este último exercita
`resolverFonte` e `audioDaCaptura` sem núcleo nenhum do outro lado. As duas metades estão
cobertas (o núcleo decide; `audioDaCaptura` obedece), e o fio entre elas não está.

Fechar isso exige um smoke de captura **com núcleo real**, no molde de `smoke:voz`. Não foi
feito aqui e não deve ser esquecido: é o mesmo tipo de vão que §113.4 mostrou custar caro.

### 114.6 O que NÃO entrou

**Volume por participante numa DM.** Não existe, e a ausência é consequência de §31.15, não
escolha desta fatia: numa dupla o único controle é o volume geral. Se o uso mostrar que não
basta, é decisão de produto — não lacuna de texto.

**`voice_share_audio` como cargo separado.** Recusado: partiria em dois um par que §17.5 sempre
tratou como uma coisa só, e nada pede essa separação hoje.

**Seletor de fonte na conversa direta.** O do sistema resolve, e importar o do produto traria
junto perfis de qualidade que §31.15 remove.

## 115. A lacuna de §114.5 fecha, e o handler de captura vira código do produto — 2026-09-03

§114 entregou B39 e **declarou uma lacuna de cobertura**: o main honrar a decisão do núcleo
sobre o som não tinha teste de ponta a ponta. A mutação que faz o main voltar a obedecer o
renderer passava em typecheck, unidade e `smoke:captura`. O operador pediu para fechá-la.

### 115.1 Por que nada alcançava aquele trecho

O corpo do `setDisplayMediaRequestHandler` morava **dentro** de `main/index.ts`, e esse
arquivo roda `app.whenReady()` e abre janela ao ser importado: nada nele é exercitável fora de
um app inteiro. É exatamente a razão que o cabeçalho de `main/captura.ts` já dava para
`resolverFonte` e `audioDaCaptura` viverem lá — só que a regra mais nova (**quem concede o som
é o núcleo**, §15.7) tinha ficado do lado de fora.

O `smoke:captura` chamava `resolverFonte` e **reimplementava o resto do handler**. Um smoke
que reimplementa a decisão que mede não a mede: ele confirma a cópia.

### 115.2 A extração

`atenderPedidoDeCaptura` é agora a função de produto, em `main/captura.ts`, com as portas
injetadas (`sessaoDeclarada`, `declaracao`, `perguntarAoNucleo`, `getSources`,
`seletorDoSistema`, `plataforma`). O `setDisplayMediaRequestHandler` real chama **ela**, e o
smoke também — a mesma disciplina de `resolverFonte`, agora valendo para o handler inteiro,
inclusive o invólucro de desfecho único e os seis ramos de falha fechada.

`DeclaracaoDeCaptura` estava **duplicada** entre `index.ts` e o que a função precisava; virou
um tipo só, exportado. Duas cópias de um contrato entre processos é a próxima divergência
silenciosa.

**A plataforma passou a ser injetável**, pelo mesmo motivo que em `seletorDoSistema`: o
loopback só existe no Windows, então sem declará-la "o núcleo negou o som" e "esta máquina não
tem loopback" produzem a mesma captura muda, e o cenário não distinguiria um do outro.

### 115.3 Uma regra ficou mais forte na extração

A linha era `const audio = decisao.audio`. Virou **`declarada.audio && decisao.audio`**:
pedido **e** concedido. Usar só a decisão deixaria um núcleo com defeito acrescentar som que
ninguém pediu; usar só a declaração é o defeito que §114 tirou dali. A conjunção é a única
leitura que não tem um lado confiando cegamente no outro, e ela tem caso próprio.

### 115.4 O cenário `nucleo`, com duas metades

**A primeira é o fio, contra o `utilityProcess` do produto.** O smoke forja o núcleo real com
`MessageChannelMain`, o oráculo de keystore do `smoke:voz`, e manda `capture.authorize` com
`captureAudio`. O núcleo não conhece a sessão e recusa — e o que se prova **não** é que a
sessão exista: é que a pergunta atravessa com o som e a resposta volta com o campo. Essa
travessia (main → utility → núcleo → main) não tinha nenhuma cobertura.

**A segunda é o handler honrando a decisão**, com as três combinações que importam:

| Declarado | Concedido | Desfecho |
|---|---|---|
| som | **negado** | captura **muda**, imagem intacta |
| som | concedido | som sobe |
| sem som | concedido | **sem som** — o núcleo não inventa o que ninguém pediu |

### 115.5 Verificação

`app`: `npm run typecheck`, `npm run build`, `xvfb-run -a npm run smoke:captura` — **tudo
verde**, com 6 asserções novas e o cenário de janela **não medido** (sem gerenciador de
janelas, como sempre neste ambiente). `smoke:fechamento` verde: a extração mexeu no `main`.

`core` (não tocado): **1 196 testes, 0 falhas**. `frontend` (não tocado): **491 testes**,
build e lint.

**A mutação de §114.5, refeita:**

| Mutação | Antes de §115 | Agora |
|---|---|---|
| `audio = declarada.audio` (o main obedece o renderer) | **passava em tudo** | cai — "pediu som e o núcleo negou → a captura sobe MUDA" |
| `audio = decisao.audio` (o núcleo concede som não pedido) | não existia como regra | cai — "não pediu som → não recebe" |

### 115.6 O que NÃO entrou

**O caso `allowed: true` vindo de núcleo real.** Para o núcleo conceder é preciso comunidade,
sessão de voz e `share.start` — o aparato inteiro do `smoke:voz`. O cenário prova a travessia
com a recusa, e a concessão é exercitada contra a função de produto com a decisão injetada.
Unir as duas pontas num só cenário é trabalho de um `smoke:tela` com dois núcleos, e ele não
existe.

**`smoke:voz` não foi re-rodado**: nada em `frontend/src/live` nem no caminho de mídia do
núcleo foi tocado nesta fatia.

## 116. Modo Música fora do Windows e microfone ausente sem saída — 2026-09-03

Dois bugs de áudio, os dois com a chamada de pé: o Modo Música não transmitia no Windows
nem no Linux, e o microfone desconectado tirava o usuário da chamada em vez de deixá-lo
ouvindo.

### 116.1 O que a investigação achou no Modo Música

Quatro causas, em três camadas — e nenhuma era a permissão (`music.start` gateava certo,
o núcleo cunhia e conferia o token certo):

1. **No Linux não havia caminho, só rótulo.** O `audio: 'loopback'` do Electron só
   existe no Windows, então o main negava a música sempre (`musica-sem-loopback`) — o
   desenho de §17.5 até então. O rótulo honesto não é correção quando a tarefa é
   transmitir: faltava a fonte de playback do Linux.
2. **O ramo de música não honrava as regras que a tela honrava.** Ele ignorava o
   `deps.plataforma` que §115 criou (chamava `audioDaCaptura('screen', true)` sem a
   plataforma) e ignorava o `decisao.audio` do núcleo — as duas disciplinas de
   §114/§115 valiam para `share` e não para `music`. Prova: sonda contra a função do
   produto com plataforma `win32` injetada negava no Linux, onde o ramo de tela
   concedia.
3. **O misturador podia nascer suspenso e calar tudo.** `criarMixador` nunca retomava
   o `AudioContext` — o estágio de ganho de entrada retomava, o misturador não. Grafo
   suspenso é silêncio digital, e a perna do mic passa pelo misturador enquanto ele
   existe: não era só a música que não saía. O VAD e o gravador local tinham o mesmo
   defeito, pela mesma ausência.
4. **`ativarMusica` engolia os três nadas e o renderer anunciava sucesso.** Sem trilha
   de sistema, sem mic ou sem WebAudio, nada era misturado — e `definirMusica`
   devolvia `erro: null`, acendendo o ícone sobre uma transmissão que não existia.

### 116.2 O que a investigação achou no microfone

Três lacunas, todas do lado local — o host nunca soube de mic nenhum, e é assim que
continua:

1. **A trilha do mic não tinha vigia.** Câmera e tela têm `aoEncerrarNaFonte`; o mic
   não tinha nada. Cabo puxado no meio da chamada matava a trilha sem passar por nada
   do produto: o usuário transmitia silêncio com o tile aceso, sem aviso e sem
   somente-escuta nomeado.
2. **Entrar sem mic expulsava.** A captura falhando depois do join aceito dava `leave`
   + exceção: o roster perdia quem tinha acabado de entrar, e a tela mostrava falha de
   chamada para um problema de dispositivo.
3. **A recuperação falhava em silêncio.** `trocarMicrofone` recusado ia só ao console —
   sem aviso para nomear, sem limpeza quando dava certo.

### 116.3 O que mudou

| Arquivo | Mudança |
|---|---|
| `app/src/main/captura.ts` | O ramo de música usa a plataforma injetada e nega nomeado sem áudio concedido (`musica-som-negado`): música muda não é música |
| `frontend/src/live/mixagem.ts`, `vad.ts`, `gravacao.ts` | `resume()` ao montar, como o ganho de entrada já fazia |
| `frontend/src/live/voz.ts` | `ativarMusica` devolve se misturou; vigia de `ended` no mic (`aoMicrofoneAusente`), desarmada antes de todo `stop` intencional; `entrar` resolve em somente-escuta com o motivo nomeado em vez de dar `leave` |
| `frontend/src/live/dispositivos.ts` | `acharMonitorDeSistema`: o monitor do PulseAudio/PipeWire casado pelo nome |
| `frontend/src/live/sincronizacao.ts` | `definirMusica` honra o desfecho real e cai no monitor onde não há loopback; aviso de mic ausente, limpo na troca bem-sucedida |
| `frontend/src/store/voiceStore.ts`, `features/voice/VoiceCallBanners.tsx` | `erroDeMicrofone` + faixa em tom de aviso (nunca de falha): a chamada segue |
| `frontend/src/live/dmVoz.ts`, `store/dmCallStore.ts`, `features/dm/` | A mesma política na conversa direta: aviso, somente-escuta e troca com a chamada de pé |
| `app/scripts/smoke-captura*.{mjs,cjs}` | Três casos de música no cenário `nucleo` (concede no Windows, nega sem loopback, nega sem áudio concedido) |

A política virou texto normativo: somente-escuta em §17.4 (emenda de 2026-09-03) e o
monitor de reprodução em §17.5 (item 7). O `muted` do roster ficou de fora de propósito:
marcá-lo imporia mudo — que corta a música junto — por um motivo que é local.

### 116.4 Verificação

`frontend`: `npm run build`, `npm run lint` e `npm test` — **508 testes, 0 falhas**, de
491 (17 novos: somente-escuta na entrada e no meio da chamada, desarme antes do `stop`,
recuperação por troca, desfechos de `ativarMusica`, `resume` do misturador, monitor por
nome, faixas das duas superfícies).

`app`: `npm run build`, `npm run typecheck` e `xvfb-run -a npm run smoke:captura` —
**tudo verde**, com o cenário de janela **não medido** (sem gerenciador de janelas, como
sempre neste ambiente). `xvfb-run -a npm run smoke:voz` — **`VEREDITO=PASSA`** (a fatia
encostou em `frontend/src/live`, e o smoke de duas pontas é quem manda ali).
`xvfb-run -a npm run smoke:fechamento` — verde (a fatia encostou em `app/src/main`).

`core` (não tocado): segue em **1 196 testes, 0 falhas**.

**Mutações, cada uma conferida isoladamente:**

| Mutação | Cai |
|---|---|
| Ramo de música sem a plataforma injetada | `smoke:captura` — "Modo Música no Windows" (nega onde devia conceder) |
| Ramo de música sem conferir `decisao.audio` | `smoke:captura` — "com som negado pelo núcleo é NEGADO" |
| `criarMixador` sem `resume` | `musica.test.ts` — "o misturador retoma o contexto ao montar" |
| `entrar` voltando a dar `leave` sem mic | `voz.test.ts` — "entrar sem microfone ENTRA" |
| Vigia sem desarme antes do `stop` | `voz.test.ts` — "parar por decisão do produto não vira aviso" |
| `ativarMusica` sem desfecho (`void`) | `musica.test.ts` — "ativar diz quando NÃO misturou" (não compila sem o booleano) |
| Faixa de mic em tom de falha | `dm-regras.test.ts` — "a faixa pede a troca" (afirma `degraded`) |

### 116.5 O que NÃO entrou

**Medida em máquina real.** O monitor é casado pelo nome (`/monitor/i`) — sufixo de
"Monitor of ..." do PipeWire/PulseAudio. Nome exótico continua caindo no
`indisponivel` honesto; confirmar os nomes reais é sessão Linux de verdade, e entra em
`B32`. O loopback audível entre duas pontas Windows continua em `B4`, como tudo que é
mídia real.

**`B40` estreitado, não fechado.** A premissa dele ("áudio de captura só existe no
Windows") valia para a música e deixou de valer; segue valendo para o áudio do
compartilhamento de tela — e a promessa "só desta janela" continua sem medida.

**`B49` intacto.** O aviso de mic é local de propósito; nenhum produtor de
`voice.deviceError` foi criado, e o tópico continua sem emissor.

**Sem seletor novo em chamada.** A troca com a chamada de pé usa o seletor de
dispositivos das configurações — que a chamada sobrevive por desenho ("voz é uma só",
independente da navegação) — e a assinatura que a aplica ao vivo. O botão de
configurações da barra de chamada continua inerte; ligá-lo é superfície, não correção.

---

## 117. B43 — a chamada volta sozinha depois do reinício do núcleo — 2026-09-03

Pedido: desbloquear o item de decisão humana **B43** (reentrada automática de voz
pós-respawn/queda) e implementar a decisão. O sintoma: o núcleo reinicia no meio da
chamada (epoch novo), o renderer re-assina eventos e re-consulta mensagens, mas a
sessão de voz — efêmera (§6.16) — morre sem evento nenhum, e o lado de cá continua
mostrando a chamada de pé, surdo e mudo. §17.4 declarava expressamente que não decidia
a reentrada.

Decisão do operador: **voltar sozinho**. No resync de §15.2(4d) com chamada ativa, o
renderer reexecuta o `voice.join` idempotente (nova sessão) — o mesmo caminho do
"Tentar novamente". Se o re-join falhar, vira `failed` com o motivo, e o botão de
sempre continua valendo.

### 117.1 O que mudou no código

| Onde | O que |
|---|---|
| `frontend/src/live/sessao.ts` | O resync passa a carregar o motivo (`epoch`/`stale`/`recarregar`). O bump de epoch não dispara resync imediato: queries E voz saem pelo `recarregar`, depois do `core.status` responder — entrar contra um núcleo subindo falharia à toa |
| `frontend/src/live/sincronizacao.ts` | `reentrarVozSePreciso(motivo)`: só no `epoch` e só com `channelId`/`communityId`/`localId` presentes, chama `retryJoin()`. `stale` (janela estourada) e `recarregar` (boot, comunidade nova) nunca reentram |
| `frontend/src/live/__testes__/reentrada-voz.test.ts` | 4 casos: epoch com chamada reentra; epoch sem chamada não tenta; stale e recarregar com chamada não reentram |

O `retryJoin` é o existente (põe `connecting`, refaz `join` + captura, reaplica o mudo
da preferência, reconsulta a fila). Câmera, tela e música nascem limpos como no retry
manual — a voz é o que volta sozinha, por desenho mínimo.

### 117.2 O que mudou no normativo

- **§15.2(4d)**: passa a incluir a reentrada ("com chamada de voz ativa, reexecuta o
  `voice.join` idempotente"), com emenda B43 que limita ao `epoch` e nomeia o destino
  de câmera/tela/música e a exclusão da conversa direta.
- **§17.4**: o parágrafo "O que este parágrafo NÃO decide" vira a emenda B43 que decide
  a reentrada automática no respawn. A volta do canal de §16.1 sem respawn (só queda de
  transporte) continua sem decisão — ali o caminho é a reconstrução de ICE.
- **`backlog.md`**: **B43** sai da lista (item fechado sai daqui, pela regra do
  cabeçalho). B44, B49 e os demais seguem como estão.

### 117.3 Verificação

`frontend`: `npm run build`, `npm run lint` e `npm test` — **512 testes, 0 falhas**
(508 + 4 novos desta fatia). `app`: `npm run build`, `npm run typecheck` e
`xvfb-run -a npm run smoke:voz` — **`VEREDITO=PASSA`** (a fatia encostou em
`frontend/src/live/sincronizacao.ts`, e o smoke de duas pontas é quem manda ali).
`core` (não tocado): segue como estava.

**Mutações, cada uma conferida isoladamente:**

| Mutação | Cai |
|---|---|
| `reentrarVozSePreciso` sem a guarda de `epoch` | `reentrada-voz.test.ts` — "stale NÃO reentra" (reentraria à toa) |
| Sem a guarda de `channelId === null` | `reentrada-voz.test.ts` — "sem chamada não tenta" |
| `onResync` de epoch voltando a disparar resync imediato | chamada tenta o join antes do núcleo responder (pisca `failed` no meio da reconexão) |

### 117.4 O que NÃO entrou

**Conversa direta.** `dm.callJoin` (§31.15) não entra aqui: escopo de comunidade, como
a emenda diz. O par ainda em chamada do outro lado é outro desenho.

**Câmera, tela e música.** Nascem limpos como no "Tentar novamente" manual — quem
estava com câmera precisa ligá-la de novo, quem apresentava precisa apresentar de
novo. Restaurar captura sem gesto (ainda mais `getDisplayMedia`) seria outro produto.

**Queda do host sem respawn local.** Sem epoch não há resync, e nada aqui muda: o
membro descobre por `E_HOST_UNAVAILABLE`/`voice.failed{host-unavailable}`, como antes.

---

## 118. B64 — o link clicável de pessoa, com confirmação — 2026-09-03

Pedido: desbloquear **B64** (abrir conversa direta sem colar 64 caracteres) pela opção
A decidida pelo operador — link clicável com confirmação. Até aqui o único caminho era
o campo de §110 (que recusa a URL de propósito, com mutação); a gramática de §3.5 é
fechada e não tinha rota que carregasse chave de identidade.

Decisão: `comunidadep2p://u/<KEY64>`, com a regra 3 de §3.5 valendo igual — o link
**nunca dispara ação**, só posiciona a UI na confirmação de "Nova conversa", e abrir
exige o clique explícito depois da prévia.

### 118.1 O que mudou no código

| Onde | O que |
|---|---|
| `app/src/main/index.ts` | `RE_USER` + rota `{route:'user', key}` no `parseDeepLink`; a chave segue em minúsculas. `second-instance`, `open-url` e a fila continuam iguais — eles já encaminham dado estruturado (§3.5 regra 2) |
| `app/src/preload/index.ts`, `frontend/src/ipc/bridge.ts` | `DeepLink` ganha `route:'user'` + `key?` (só tipo; o transporte já repassa o objeto) |
| `frontend/src/live/deeplink.ts` | Estado `contato{peerKey}` + `fecharContato()`; `receber` na rota `user` só preenche o contato — nenhum `dm.open`, pela regra 3 |
| `frontend/src/features/dm/DmDialogs.tsx`, `DmList.tsx` | A "Nova conversa" aceita `chaveInicial` e abre pré-preenchida quando o link chega (`key` força remontagem); fechar limpa a intenção. A validação, o caso "já está na lista" e o aviso de política continuam os do campo |
| `frontend/src/features/dm/dmRegras.ts` | `lerChaveDeIdentidade` extrai a chave do link colado (`u/<64 hex>` exato); resto das recusas igual (`0x`, tamanho, não-hex) |

### 118.2 O que mudou no normativo

- **§3.5**: a rota `u/<KEY64>` entra na gramática, com a emenda B64 (sintaxe, dado
  estruturado, regra 3 igual, campo como reserva onde o handler não alcança).
- **§31.25**: a linha de §3.5 passa de "Aberto — B64" para "Feito (§118, B64)".
- **`backlog.md`**: **B64** sai da lista; o parágrafo da conversa direta passa a dever
  B63 (navegação/notificação), B66/B67 e B4.

### 118.3 Verificação

`frontend`: `npm run build`, `npm run lint` e `npm test` — **517 testes, 0 falhas**
(512 + 5 novos: link colado extrai a chave com caixa/espaços, link com chave inválida
recusa, e os quatro de `deeplink.test.ts` — preenche sem `dm.open`, minúsculas,
limpa, substitui). `app`: `npm run build`, `npm run typecheck` e
`xvfb-run -a npm run smoke:fechamento` — **tudo verde** (a fatia encostou em
`app/src/main` e no preload, e esse smoke é quem manda ali). `core` (não tocado):
segue como estava.

**Mutações, cada uma conferida isoladamente:**

| Mutação | Cai |
|---|---|
| `RE_USER` fora do `parseDeepLink` | link de pessoa cai em `deeplink.rejected` (volta a ser recusado) |
| `receber` chamando `dm.open` direto | `deeplink.test.ts` — "nunca dispara `dm.open`" (viola a regra 3) |
| Extração do link fora do `lerChaveDeIdentidade` | `dm-regras.test.ts` — "o link de pessoa é aceito colado" |
| `chaveInicial` fora da modal | o link abre a confirmação vazia, sem a chave |

### 118.4 O que NÃO entrou

**Sem busca nem diretório (L-24).** O link troca a embalagem da chave, não a origem:
continua sendo preciso obtê-la por fora do produto. Nada aqui cria descoberta.

**Sem prévia de `handle`.** Como em §110.6: o nome curto do par continua vindo do núcleo
depois que a conversa existe (`DmPeerLabel`), sem segunda implementação da derivação
no renderer.

**Linux sem empacotado.** O handler continua inexistente fora do empacotado (§3.5 regra
5) — ali o caminho segue sendo colar no campo, agora aceitando o link colado.

## 119. O Modo Música no Linux: a porta certa era a que o produto se recusava a bater — 2026-09-03

§116 fez o Modo Música "funcionar fora do Windows" abrindo o monitor de reprodução do
PulseAudio/PipeWire por `getUserMedia`. O relato do usuário depois daquela fatia foi o
mesmo de antes: **"Modo Música indisponível nesta plataforma — use Compartilhar tela (com
áudio)."** A investigação achou duas causas independentes; consertar uma só não mudaria
nada na tela.

### 119.1 Causa A — o caminho do monitor não pode casar, em máquina nenhuma

O item 7 de §17.5 afirmava que o Chromium lista a fonte de MONITOR como `audioinput`
comum. Ele não lista. Em `media/audio/pulse/audio_manager_pulse.cc` (Chromium 150, o do
Electron 43.4.0), `GetAudioInputDeviceNames` enumera por `InputDevicesInfoCallback`, que
começa por:

```cpp
// Exclude output monitor (i.e. loopback) devices.
if (info->monitor_of_sink != PA_INVALID_INDEX)
  return;
```

É decisão de privacidade, não omissão: a lista de microfones é onde uma permissão de
"microfone" é concedida, e deixar o som do sistema aparecer ali o tornaria capturável por
trás de um consentimento que a pessoa entendeu como voz. O mesmo arquivo recusa até o
dispositivo *padrão* quando ele é um monitor (`default_source_is_monitor_` →
`AudioParameters()` inválido).

O `/monitor/i` de `acharMonitorDeSistema` só encontra, portanto, uma fonte que a própria
pessoa tenha criado (um `module-remap-source`, que não é monitor aos olhos do Pulse). O
teste de unidade passava porque a lista era sintética: nenhuma verificação daquela fatia
olhou para uma enumeração de verdade.

### 119.2 Causa B — o ambiente de desenvolvimento estava sem áudio nenhum

No WSLg em que o relato nasceu, o servidor PulseAudio parou de aceitar conexões
(`connect /mnt/wslg/PulseServer` → `EAGAIN`, enquanto `.X11-unix/X0` e
`PulseAudioRDPSink` conectam). O Chromium registra
`pulse_util.cc:270 Failed to connect to the context` e cai para ALSA, que ali não tem
dispositivo nenhum: `enumerateDevices()` devolve lista vazia e `getUserMedia({audio:true})`
dá `NotFoundError`. Com lista vazia, `ligarMusicaDoMonitor` nem chega a pedir permissão —
casa zero fontes e devolve `indisponivel`. Não é defeito do produto (o microfone da
chamada também some ali; `wsl --shutdown` restaura), mas é o que fazia a mensagem
aparecer **antes** de a causa A ter chance de aparecer.

### 119.3 O conserto — parar de recusar

O `audio: 'loopback'` do Electron **funciona no Linux**. A documentação
("currently only supported on Windows") está desatualizada, e foi ela que produziu o
`if (plataforma !== 'win32') return undefined` de `audioDaCaptura`. O código não concorda
com a própria documentação:

| Camada | O que se leu | Onde |
|---|---|---|
| Electron 43 | `'loopback'` vira dispositivo de id `"loopback"` **sem `#if` de plataforma**; o único condicional é o de `restrict_own_audio`, cujo `#else` (Linux) segue com `kLoopbackInputDeviceId` | `shell/browser/electron_browser_context.cc`, `DisplayMediaDeviceChosen` |
| Chromium 150 | `IsLoopbackDevice(device_id)` → `PulseLoopbackManager`, que abre **o monitor do sink padrão** e o troca sozinho quando a saída padrão muda | `media/audio/pulse/audio_manager_pulse.cc`, `pulse_loopback_manager.cc` |
| Flag | `kPulseaudioLoopbackForScreenShare` só é consultada em `chrome/browser/media/webrtc/desktop_media_picker_controller.cc`, para o picker do **Chrome** — que o Electron não usa | — |

Ou seja: o produto já tinha o caminho certo implementado (o de §17.5 item 2, o mesmo do
Windows) e o desligava por conta própria. O conserto é `audioDaCaptura` conceder loopback
no Linux — e **só para `screen`**. Para `window` o loopback continua negado: ele é o som
da máquina inteira, e concedê-lo a quem pediu uma janela seria capturar mais do que a
pessoa autorizou. É a mesma disciplina de §115.3 lida pelo outro lado: lá "som negado sobe
muda"; aqui, "som demais não sobe".

Com isso `captureSupport().screen` passa a ser verdadeiro no Linux, o `semLoopback` do
renderer fica falso, e o Modo Música volta ao caminho de sempre — `music.start` no núcleo,
declaração da sessão, `getDisplayMedia`, vídeo parado no ato, áudio misturado e
`replaceTrack`. Nada do fluxo mudou; só deixou de ser desviado.

### 119.4 O que NÃO entrou

**A caixa do Wayland continua.** O som vem do loopback, não do portal — mas o
`getDisplayMedia` ainda pede vídeo, e no Wayland pedir vídeo É o pedido de permissão do
portal (§17.5, `seletorDoSistema`). Então em sessão Wayland o Modo Música ainda mostra a
caixa "escolha o que compartilhar", que a pessoa responde com qualquer tela, e o vídeo é
descartado. Arranha a promessa de um clique.

Existe caminho sem caixa: o GUM legado (`chromeMediaSource: 'desktop'` só no áudio), que
`shell/browser/web_contents_permission_helper.cc` concede como `"loopback"`/"System Audio"
— também sem gate de plataforma, e sem exigir trilha de vídeo. Ele **não** passa pelo
`setDisplayMediaRequestHandler`, e portanto sai por fora do `capture.authorize` de §15.7:
o núcleo deixaria de ser quem concede a captura. Isso é decisão de arquitetura, não
conserto de defeito, e fica em aberto.

**O caminho do monitor não foi removido.** Ele deixou de ser o caminho do Linux e virou
último recurso — vale para quem tenha criado uma fonte remapeada à mão, e para uma
plataforma futura sem loopback. O texto de §17.5 item 7, de `acharMonitorDeSistema` e de
`ligarMusicaDoMonitor` passou a dizer isso em vez do que dizia.

**Nada foi medido ponta a ponta.** O smoke exercita a decisão do main com a plataforma
injetada; o áudio real do Linux não foi capturado porque a máquina da investigação está
sem servidor de áudio (§119.2). A evidência é a fonte do Chromium e do Electron, não bytes
de `inbound-rtp`. Fica pendente uma passada em máquina Linux com áudio de verdade.

### 119.5 Verificação

`app`: `npm run build`, `npm run typecheck` e `xvfb-run -a npm run smoke:captura` —
**tudo verde**, com o cenário `janela` declarado NÃO MEDIDO como sempre (sem gerenciador
de janelas o Chromium não enumera janela). O smoke ganhou os casos que prendem a emenda:
`musica-linux-concedida` (tela primária + loopback, como no Windows),
`musica-darwin-sem-loopback` (a recusa nomeada continua existindo onde a plataforma de
fato não tem loopback), e as três linhas novas da tabela de `audioDaCaptura`
(`linux/screen` → `loopback`, `linux/window` → sem som, `linux/screen` com som negado pelo
núcleo → sem som). `frontend`: `npm run build`, `npm run lint` e `npm test` — **517
testes, 0 falhas**. `core` (não tocado): segue como estava.

### 119.6 `B40` fechado — por decisão do operador, não por medida

A linha saiu do `backlog.md` a pedido do operador, e o registro do fechamento é este
parágrafo (regra do próprio backlog: item fechado sai de lá e o fechamento mora na fatia
que o fechou).

O que fechou foi a **premissa**: "áudio de captura de tela só existe no Windows" é falso
desde §119.3, e era ela que sustentava a linha. O que **não** foi medido continua não
medido, e fica aqui em vez de lá:

- **Ninguém ouviu o loopback do Linux.** A evidência de §119 é leitura de fonte do
  Chromium 150 e do Electron 43.4.0, não captura de áudio. A máquina da investigação está
  sem servidor de som (§119.2). A primeira chamada real em Linux com Modo Música ligado é
  a medida — e se ela falhar, o lugar de reabrir é aqui, não uma linha nova.
- **A promessa "só desta janela" segue sem conferência no Windows.** O recorte é do
  Chromium (`GetDisplayMediaWindowAudioCapture`), o pedido é feito
  (`windowAudio: 'window'` + `systemAudio: 'exclude'`), e nada neste repositório observou
  se ele é honrado. No Linux a pergunta não existe: `window` sobe muda de propósito
  (§119.3).

Fechar por decisão é legítimo — o backlog é lista de trabalho, não de verdades — mas o
custo é que estas duas ausências deixaram de ter quem as lembre. Está escrito aqui para
que a próxima fatia que encostar em captura de áudio não as leia como resolvidas.

### 119.7 A mensagem que mandou a investigação para o lado errado

O relato que abriu esta fatia era de um **Windows** — a plataforma em que o Modo Música
sempre funcionou —, e a tela dizia "indisponível nesta plataforma". A frase não descrevia
nada: `definirMusica` tinha um `indisponivel` só, e ele cobria quatro falhas distintas
(`getDisplayMedia` recusado pelo main, captura sem trilha de áudio, mixagem que não montou,
e a ausência real de loopback). Foi essa frase que fez a investigação começar pelo Linux.

Agora cada ramo tem nome e frase própria (`recusada`, `sem-som`, `sem-mistura`, `negado`,
`indisponivel`), e **só o último** pode acusar a plataforma — ele agora depende de
`captureSupport().screen` ser falso, não de um `catch` genérico. O caminho também ficou
observável no console do renderer (`[musica] …`): a autorização do núcleo, a plataforma e
o loopback escolhidos, e o desfecho com o `name`/`message` do erro do Chromium quando há
um. O log do main já nomeava seus ramos; o do renderer não nomeava nenhum.

**O relato do Windows continua ABERTO.** Nada aqui o explica — o microfone estava vivo e a
chamada de pé, o que descarta o ramo da mixagem; os outros três só se distinguem em
execução, e é para isso que a instrumentação existe. A correção do Linux (§119.3) e esta
separação de desfechos são independentes daquele defeito.

## 120. A primeira mensagem direta não tinha por onde chegar — 2026-09-03

O relato: *"o usuário conseguiu encontrar meu perfil, mandou mensagem mas eu não recebi
nada na minha interface."* O protocolo de §31.8 estava certo. O que não funcionava era
tudo o que precisa acontecer **antes** de o protocolo poder falar: três defeitos
independentes — dois na descoberta, um na montagem —, e consertar qualquer um sozinho não
entrega mensagem nenhuma.

### 120.1 Causa A — quem recebe não se anunciava

`refresh()` só chamava `announceSelf()` quando já existia conversa `accepted` ou
`pending-out`. Quem recebe o **primeiro** contato não tem nenhuma das duas, por definição.

A regra normativa de §31.8 dizia exatamente isso, e justificava a condição com a premissa
de que "o lado que anuncia continua anunciando a própria chave de identidade por causa de
toda comunidade de que participa". A premissa é falsa para quem é só membro: por §14.1 o
host entra no tópico como `server` e o membro como `client`
(`composition/transport.ts:426`), e o hyperswarm só chama `listen()` para tópico de
servidor (`hyperswarm/lib/peer-discovery.js`). Um membro nunca anuncia par nenhum — e sem
anúncio o `joinPeer` do outro lado não tem a que se conectar. Na prática, a primeira
mensagem só chegava a quem hospeda comunidade.

Medido antes do conserto, com dois `Hyperswarm` reais numa DHT local: enquanto o
destinatário não anuncia, o `joinPeer` do remetente fica sem conexão nenhuma; no instante
em que ele anuncia, a conexão sobe nos dois lados. §31.8 ganhou a emenda correspondente —
**quem tem identidade anuncia-se** — e o filtro de quem pode *falar* continua onde sempre
esteve, na política de contato de §31.9 regra 5.

### 120.2 Causa B — a descoberta nunca era relida depois de abrir a conversa

`transport.refresh()` era chamado **uma vez**, no `boot()` do `dmRuntime`. `abrir`,
`aceitar`, `bloquear`, `desbloquear` e `esquecer` são comandos de §31.16.1 que mudam o
estado em L2 e que o transporte não vê passar: um `pending-out` recém-criado só procuraria
o par no próximo reinício do núcleo. Quem escreveu a primeira mensagem ficava com ela no
próprio log, sem nunca ter procurado o destinatário.

O conserto liga as duas pontas no funil que já existia: `eventosDaPolitica` — a saída
única dos eventos de L2 — relê a descoberta em `dm.conversationChanged` e `dm.requested`.
`refresh` já se declarava idempotente e chamável a cada mudança de conversa; faltava
alguém chamá-lo.

### 120.3 O que a releitura obrigou a corrigir junto

Com `refresh()` passando a rodar durante a vida da conversa, o ramo `else` dele virou um
problema novo: ele tratava `pending-in` como `blocked` e **fechava o canal**. O pedido
chegava e o cabo por onde ele veio morria em seguida — junto com a replicação limitada de
§31.9, que é de onde sai a primeira mensagem que o pedido mostra. `pending-in` agora tem
ramo próprio: não procuro o par, mas não derrubo o que ele abriu.

### 120.4 Por que a suíte não pegava

`core/test/dm-rede.test.ts` prova o protocolo com `Protomux` de verdade e **entrega a
conexão à mão**; ele chegava a afirmar `anunciou === false` no lado que recebe — o defeito
estava assertado como comportamento correto. Um cabo entregue à mão não pode reprovar uma
descoberta que não acontece.

`core/test/dm-descoberta.test.ts` é o que faltava: dois núcleos de produto, uma
`hyperdht/testnet` local, **nenhuma comunidade** e nenhuma conexão entregue à mão. Ele
cobre o ciclo do relato — pedido chega, a mensagem aparece dentro do pedido, o aceite
acontece e a resposta volta pelo mesmo cabo. Com qualquer uma das duas causas de volta,
ele falha por timeout.

### 120.5 Causa C — numa instalação nova, §31 não existia até o app reabrir

O terceiro defeito é de outra natureza e do mesmo assunto: o subsistema de §31 era montado
**uma vez**, no boot, e só se já houvesse identidade. Numa instalação nova a identidade
nasce em sessão (`identity.create`), e o núcleo não reiniciava por causa dela — o shell só
anexa a rede e o transporte de comunidade (`app/src/utility/index.ts`, `ligarRede`). Quem
criava a identidade ficava com `dm.*` respondendo `E_UNKNOWN_COMMAND` até fechar e abrir o
app, sem nada na tela explicando por quê.

§3.3 já trata a chegada da identidade como **transição**, e já tem funil: `identidadePronta`
liga a assinatura das ops e passa a fase para `ready`. A montagem de §31 entrou nessa
transição — `montarDm()`, idempotente e inerte sem identidade, chamado do boot e dos três
caminhos que produzem identidade (`create` e os dois `import`). Nada de normativo mudou
aqui: nenhum texto dizia que a conversa direta só existia a partir do reinício seguinte;
era artefato da ordem em que o boot montava as peças.

### 120.6 O que a montagem tardia obrigou a corrigir em L0

Montar §31 junto com a identidade inverte uma ordem que estava implícita: o transporte de
DM lia `swarm.backend` **uma vez**, e nessa ordem o backend de rede ainda não foi anexado —
o shell o anexa quando vê a identidade aparecer, o que pode acontecer depois. Um transporte
montado antes do anexo ficaria surdo para sempre, e o defeito seria idêntico ao de §120.1
visto de fora.

`Swarm` ganhou `onConexao` — a conexão crua, para quem monta canal sobre o stream —, e
`attachBackend` passou a religá-la junto com os tópicos e os `joinPeer`. É a terceira vez
que a mesma lição aparece no mesmo método, e agora as três estão no mesmo lugar: o que foi
pedido antes de haver rede não pode morrer na memória. O `startDmTransport` assina pela
fachada em vez de ler o backend.

### 120.7 Verificação

`core`: `npm run build` (com a barreira de §4) e `npm test` — **1200 testes, 0 falhas**.
`app`: `npm run typecheck` e `npm run build` — verdes. Os três consertos foram revertidos
em separado para confirmar que os testes novos reprovam cada um: `dm-descoberta` (§120.1 e
§120.2), `identidade-superficie` §120 (§120.5) e `fase4-replication` (§120.6).

Não medido: rede real com NAT. A DHT aqui é local, e o que §120 prova é que a descoberta
existe — não que ela atravessa CGNAT, que continua sendo `B4`.

---

## 121. B63 — a conversa mora no topo do rail, e cada uma tem o seu mudo — 2026-09-04

Pedido: desbloquear **B63** (as duas decisões de navegação e política que a conversa
direta não deriva) pela recomendação aceita — A1 + B1. A entrada no rail já existia
montada como proposta (§107.4); o mudo por conversa não existia em lugar nenhum: o
selo somava tudo e a única saída era desligar as notificações do programa inteiro.

Decisão do operador: **A1** — o topo do rail é o lugar oficial, fica como está;
**B1** — o flag global mais um silenciar por conversa, espelhando o mudo de canal.

### 121.1 O que mudou no código

| Onde | O que |
|---|---|
| `frontend/src/store/settingsStore.ts` | `dmMutedByConversation` + `setDmMuted()`: preferência local deste aparelho, persistida com o resto, sem porta e sem fio — o núcleo não conhece mudo de DM. `false` apaga a entrada para o mapa não crescer |
| `frontend/src/features/dm/dmRegras.ts` | `contarPendentesDm()`: pedidos + não lidas das conversas com som; conversa muda não soma, pedido soma sempre (§31.9 regra 4). Sem nada mudo, é a conta de antes |
| `frontend/src/features/dm/DmRailButton.tsx` | O selo passa pela regra; o comentário deixa de dizer "proposta" |
| `frontend/src/features/dm/DmConversationView.tsx` | "Silenciar conversa" / "Reativar notificações" no menu da conversa, em qualquer estado visível |
| `frontend/src/live/dm.ts` | `esquecerConversa` limpa o mudo com a conversa |

### 121.2 O que mudou no normativo

- **§31.16**: emenda B63 — o topo do rail ratificado e o mudo por conversa (local,
  pedido soma sempre, esquecer limpa, nada de comando/evento/tabela no núcleo).
- **`backlog.md`**: **B63** sai da lista; a conversa direta passa a dever B66/B67 e B4.

### 121.3 Verificação

`frontend`: `npm run build`, `npm run lint` e `npm test` — **522 testes, 0 falhas**
(517 + 5 novos: mudo marca sem atravessar a porta, reativar apaga, e os três do selo —
conta preservada, muda não soma, pedido soma sempre). Nenhum smoke toca este caminho
(selo e menu de DM, sem mídia e sem main), então nenhum foi rodado; `core` e `app`
não foram tocados.

**Mutações, cada uma conferida isoladamente:**

| Mutação | Cai |
|---|---|
| `setDmMuted` replicando pela porta | `preferencias.test.ts` — "só local, sem porta" (o núcleo não tem onde receber) |
| Selo somando conversa muda | `dm-regras.test.ts` — "conversa muda não soma" |
| Pedido respeitando mudo | `dm-regras.test.ts` — "pedido soma sempre" |

### 121.4 O que NÃO entrou

**Sem nível por conversa (tudo/menções/nada).** Comunidade tem três níveis porque tem
menção — "só menções" filtra o que não é com você. Numa dupla tudo é com você, então
o binário mudo/com-som esgota o que há para decidir. Pedir o terceiro nível seria
superfície sem pergunta.

**Sem som ou vibração próprios.** O que o mudo governa é o selo do rail — a única
superfície de notificação de DM que existe. Não há centro de notificações de DM para
respeitá-lo além dali.

## 122. Anexo sem cota — `opVersion = 3` — 2026-09-04

Começou como pergunta sobre a justificativa, não sobre o número: por que 5 GiB, e o que
quebraria sem limite. A resposta que a spec dava — "impedir que um membro esgote o disco dos
outros" — não descrevia mais o mecanismo. §13.1 fixa que o host nunca recebe os bytes do
anexo (`F-03`), a replicação de blobs é sparse por faixa (§13.4) e, desde a emenda de
2026-08-27 de `frontend.md`, nenhum `blob.download` sai sem clique. O disco alheio já estava
protegido por construção; a cota cobrava um pedágio determinístico por um custo que só recai
sobre quem envia e sobre quem escolhe baixar.

O próprio `T-09` registrava isso no item 10: *"o sparse reduz muito o vetor de anexos para os
membros... não protege o escritor do core de blobs"*. O que sobrou de `T-09` como defesa real
é o vetor de **texto**, que o log replica integral e sem escolha — e esse é de `R-15`, que não
mudou.

### 122.1 O que saiu, e o que ficou no lugar

| Antes | Depois |
|---|---|
| `ATTACHMENT_QUOTA_PER_MEMBER` = 5 GiB por comunidade, aplicada pelo `fold` no estágio 10 (`R-14`) | Não existe. O estágio 10 ficou só com `R-15` |
| `ATTACHMENT_MAX_BYTES` = 8 GiB, inalcançável porque a cota vencia antes (`OBS-05`) | 2^53−1, teto de **representação**: `sizeBytes` é `u64` no fio e `number` no tipo |
| `blob.stage` antecipava a cota lendo `storageUsedBytes` do DS (§8.7) | Não há o que antecipar; a porta `storageUsedOf` saiu do `BlobManager` e do `boot` |
| `member.storageUsedBytes` era fronteira | É medidor, e continua projetado e exposto em `query.member` |
| Staging fazia `Buffer.concat` do arquivo inteiro para hashear | Hash incremental + append em lotes de 64 fatias (4 MiB de pico) |
| Disco cheio no `blob.stage` era caso patológico, e qualquer falha de cópia virava `E_STORAGE_FULL` | `ENOSPC`/`EDQUOT`/`EFBIG` → `E_STORAGE_FULL` com frase própria na UI; o resto → `E_FILE_UNREADABLE` |

### 122.2 Por que foi bump de protocolo

Relaxar regra do `fold` muda a projeção de logs que **já existem**: uma op hoje `REJECTED` com
`E_QUOTA_EXCEEDED` passa a ser `APPLIED` na reprojeção. Duas instalações em versões diferentes
divergiriam sobre o mesmo log, em silêncio. `opVersion` foi a 3; o fio é byte a byte o de v2 —
nenhum `kind` entrou ou saiu, nenhum campo mudou —, e a regra 5 de §7.2 é o que faz o cliente
velho parar de escrever (`partialInterpretation` + `E_VERSION_UNSUPPORTED`) em vez de projetar
um estado diferente. Os vetores dourados de `opCodec.test.ts` foram recalculados: o byte de
versão entra nos dois hashes de assinatura e no `opId`.

### 122.3 Descoberta lateral

Com o teto por arquivo em 2^53−1, ele passou a **coincidir** com a fronteira do
`Reader.u64` (que liga `failed` acima de `MAX_SAFE_INTEGER`). `E_ATTACHMENT_TOO_LARGE` deixou
de ser alcançável por registro vindo do fio: quem recusa primeiro é o decode, com
`E_MALFORMED`. A checagem do estágio 13 permanece porque o `fold` é total e não pode supor que
quem o chamou decodificou; a do ticket permanece porque lá o número vem do `stat`. É o inverso
de `OBS-05`: antes o teto por arquivo era inalcançável porque a cota vencia; agora é
inalcançável porque o decode vence.

### 122.4 Verificação

`core`: 1203 testes, `npm run build` (com a barreira de camadas) e `npm run typecheck`.
`frontend`: 522 testes, `npm run build` e `npm run lint`. Testes reescritos: a ordenação de
estágio de `R-14` em `fold-pipeline` virou a asserção oposta (6 GiB é `APPLIED`, e o
`storageUsedBytes` acumula); `pendencias-superficie` §49.3 deixou de testar a recusa antecipada
e passou a testar o staging de arquivo grande, o teto de representação e o caminho de muitos
lotes (200 fatias, hash incremental conferido contra `hashForBlobContent`).

### 122.5 O que NÃO entrou

**`E_STORAGE_FULL` durante o append do log** — não do blob. `T-09` item 12 já registrava que
ele só está definido para a criação da comunidade (§11.1), e continua assim. Sem cota isso fica
mais provável, mas é outro caminho, com outra recuperação, e misturá-lo aqui seria alargar a
fatia. Vai para o backlog.

**Nenhum limite novo em outro lugar.** Não entrou cota por comunidade, por canal, nem teto
operacional configurável. A decisão foi remover a fronteira, não movê-la.

## 123. As fases 3, 7, 8 e 10 fecham por evidência de operador — 2026-09-04

**Entrada:** o operador empacotou o produto para **Windows e Linux** e o exercitou **com
outros usuários**, em uso normal, numa build já distribuída. **Resultado:** **B1**, **B2** e
**B4** fechados por decisão do operador; as fases **3**, **7**, **8** e **10** passam a
`validada`.

Esta fatia não mede nada. Ela **registra** uma medida que aconteceu fora deste repositório e
a classifica — que é a única coisa honesta a fazer com evidência que o agente não produziu.
É a mesma classe de §88 (voz e tela em uso real entre operadoras) e de §119.6 (`B40` fechado
por decisão do operador, não por medida): a classe que mais achou defeito neste projeto, e
exatamente a que §72.3 vinha dizendo que faltava desde que o pacote passou a existir.

### 123.1 O que a evidência cobre, item por item

| Item | Fecha porque | Grau da prova |
|---|---|---|
| **Fase 3** — escrita durável | A build distribuída escreveu, replicou e sobreviveu a fechamento e reabertura em uso de terceiros. O rerun multicanal de `opVersion` que §29 pedia deixa de ser condição de release por decisão do operador | Uso real, sem instrumentação |
| **Fase 7** — voz e câmera | Chamada entre usuários diferentes, em máquinas diferentes, nas duas plataformas. Soma-se a §82 (voz entre provedores) e §88 (9 ms medidos em uso real) | Uso real, com terceiros |
| **Fase 8** — tela em estrela | Transmissão exercitada com espectadores reais, sobre a mesma malha da fase 7. Soma-se a §85.1 e §88 | Uso real, com terceiros |
| **Fase 10** — continuidade | O caminho de sucessão foi exercitado na build empacotada, além do harness parcial de §27 | Uso real |
| **B1** — piso de glibc | Os addons carregaram nas máquinas Linux dos usuários que receberam a build | **Empírico, não reproduzível** — ver §123.2 |
| **B2** — prebuilds fora da matriz | O instalador com os `.node` extras rodou nos dois alvos sem falha | Empírico; era higiene de empacotamento, nunca impediu executar |
| **B4** — vereditos `parcial` de G7/G8 | A metade "Electron empacotado" dos `openCriteria` está atendida: o produto rodou empacotado, nos dois sistemas, com gente de verdade | **Parcial** — ver §123.2 |

### 123.2 O que esta fatia NÃO prova, e fica declarado

Fechar um item por decisão não é o mesmo que medi-lo. Três coisas continuam sem medida, e
nenhuma delas volta para a lista viva porque nenhuma bloqueia release na decisão do operador
— mas todas ficam escritas aqui, que é onde o histórico mora.

1. **`tc/netem` e CGNAT real nunca foram exercitados.** Os `openCriteria` de G7 e G8 pedem
   degradação de rede controlada e um link de operadora com CGNAT. Uso real entre pessoas
   com internet que funciona não é isso. **`L-11` e `L-11b` continuam válidas e continuam
   com as superfícies de UI que §25.8 exige** — o produto segue nomeando `conn-failed` com o
   motivo separado, porque a causa que elas descrevem não foi refutada por esta evidência.
2. **Os artefatos de gate não foram tocados.** `poc/poc-08-g7` e `poc/poc-09-g8` continuam
   com veredito `parcial` e com os `openCriteria` como estavam. Reescrevê-los para casar com
   uma decisão de operador seria alterar artefato de validação para "fazer passar", que é o
   que `CLAUDE.md` proíbe. O que fechou é o **item de backlog**, não o gate.
3. **O repositório não carrega a garantia de B1 nem a de B2.** Não existe `build/Dockerfile`
   nem `build/build-addons.sh`, e o `electron-builder.json` não tem filtro de `.node` por
   plataforma. A build do operador **rodou** nas máquinas dos testadores; isso é diferente de
   **garantir** que roda no piso declarado de glibc 2.31 (A16) — a primeira é uma observação
   sobre as distribuições daquelas pessoas, a segunda exige compilar no piso. Quem reconstruir
   o produto deste repositório reconstrói sem essa garantia. Se o piso voltar a importar —
   um usuário numa distribuição mais antiga —, o item volta com o mesmo texto.

### 123.3 O que mudou no normativo

- **`backend-v2.md` §29**: a nota "Estado pós-G4" é substituída pelo estado real das fases,
  com a origem da evidência nomeada e o que ela não cobre.
- **`backlog.md`**: **B1**, **B2** e **B4** saem da lista. "Bloqueia release" fica só com
  **B3** (assinatura de código do `.exe`), que é certificado e não se resolve em repositório.
- **`unidune-index.html`**: a landing page passa a mostrar as quatro fases como prontas e
  reduz a lista de bloqueios de release a um item.

### 123.4 O que continua aberto

Nada mudou para **B30**/**B52** (endereço e credencial do relay voluntário), **B38**,
**B37**, **B29**, **B44**, **B49**, **B51**, **B66**, **B67** nem para os itens de
observação e qualidade. A fase 9 continua sendo a única do caminho do produto sem fechar,
e continua bloqueada por decisão de protocolo, não por medida.

**B17** (host de longa duração deixando de receber conexões) continua aberto e ganha
relevância: uma build distribuída a terceiros é exatamente o cenário em que ele apareceria.
Se algum usuário relatar host que para de aceitar conexões depois de horas, é este item.

---

## 124. Varredura do domínio puro: doze defeitos e cinco emendas — 2026-09-04

Fase 1 de um mapeamento de busca por bugs dividido por funcionalidade, restrita ao domínio
puro do núcleo: `fold`, `projector`, `opCodec`, `permissions`, `idgen`, `errors`. Nada de
fronteira de processo, replicação, DM, mídia, app ou frontend — essas são as outras fases.

Doze defeitos, todos com regressão em `core/test/conformidade-dominio-puro.test.ts`. A suíte
tinha 1 203 testes verdes antes da varredura e tem 1 227 depois; nenhum dos doze era pegável
pelos 1 203, e vale entender por quê antes de olhar item a item.

### 124.1 O padrão: o teste afirmava o efeito colateral, não a propriedade

Quase todos sobreviveram pelo mesmo motivo. O teste existente afirmava algo que **o defeito
também satisfaz**:

- `§10.6` — "o boot continua do snapshot" era afirmado como `interpretedSeq == log.length - 1`,
  que a reprojeção total também produz. Os dois caminhos terminam iguais; o que os separa é
  **quantos registros o `fold` interpretou**, e ninguém contava.
- `§8.4` (ban/FTS) — "as mensagens do banido perdoado voltam à busca" era afirmado contando
  linhas no índice. Como a remoção nunca removia nada, a contagem estava certa e o índice
  estava errado.
- `R-28` (ban preventivo) — "sem mexer no `member_count`" estava certo, e escondia que
  `roles.member_count` **também** não mexia, para nenhum ban.
- `§52` (superfície de membros) — o `member.setRoles` do teste tinha o Fundador como autor e
  alvo, o único caso em que a escalada de R-30 não aparece: ele já tem as 17.

O corretivo não é escrever mais teste, é escrever o teste sobre a **propriedade normativa**.
Cada regressão nova cita a linha da spec que decide o caso, e três delas afirmam justamente o
que os antigos não afirmavam: registros refoldados, `MATCH` na FTS, e igualdade entre o `DS`
foldado e o `DS` reidratado.

### 124.2 O achado que era de segurança

**Auto-atribuição de cargo era escalada de privilégio.** `member.setRoles` com o próprio autor
como alvo não passava pelo estágio 12 — `targets.ts` devolvia "não se aplica" —, e o que
sobrava era R-4, que só compara `rank`. Quem tivesse `manage_roles` e um cargo qualquer abaixo
do próprio topo se atribuía esse cargo e herdava tudo que ele carregasse: medido, uma conta com
`manage_roles` saiu com `ban_members` e `manage_community` num único registro `APPLIED`.

A leitura literal de §9.3 ("nunca igual") e de R-4 ("nenhum cargo **do alvo** pode ter
`rank ≥ topRank(autor)`", com `member.setRoles` na coluna "Aplica a") resolveria: o alvo próprio
sempre viola as duas. Foi implementada, e o efeito colateral apareceu em três testes de
superfície de uma vez — **ninguém** editaria os próprios cargos, o Fundador inclusive, e os
cargos dele ficariam congelados na gênese para sempre. §6.15 ("mudança nos cargos da identidade
local reconta") passaria a só acontecer quando **outra** pessoa mexesse nos seus.

A decisão foi a outra: **R-30**, quarta regra de anti-escalada de §9.3. Auto-atribuição
continua permitida, mas nenhum cargo **acrescentado** pode carregar permissão fora de
`efetiva(autor)`. Fecha exatamente o vetor — é a mesma escalada que R-5 já fecha na *criação*
do cargo, entrando pela porta da *atribuição* — e deixa intacto o que não é vetor: o Fundador,
que tem as 17, segue ajustando os próprios cargos, e atribuir a **outra** pessoa um cargo mais
forte que o seu continua valendo, porque ali o estágio 12 responde e o autor não ganha nada.

### 124.3 Os dois que se protegiam um ao outro

`loadSnapshot` lia `row.foldBuildId` de um `SELECT` sem `AS`, que devolve `fold_build_id`:
sempre `undefined`, sempre descartado. E o construtor de `ViewDb` executava o DDL sem carimbar
`view_schema_version`, contra §10.3.1 ("escrita **na criação**"), então `schemaVersionMismatch()`
era `true` num banco recém-criado. Duas causas independentes para o mesmo sintoma — §10.6 nunca
acelerou um boot sequer —, e cada uma escondia a outra.

O que isso protegia é o ponto interessante. Enquanto nenhum snapshot era herdado, **dois outros
defeitos eram inalcançáveis**:

- `reaction.set{present:false}` não tirava o emoji de `reactionEmojis`, mas
  `loadMessagesFromView` rematerializava o campo das reações **vivas** de `view.db`. Duas
  leituras de R-23 em vigor ao mesmo tempo: um nó que herdasse snapshot e um que reprojetasse
  decidiriam **diferente sobre o mesmo log**.
- A marca de L-5 (`displayNameCollision`) não entrava no blob do snapshot, e é função do
  conjunto ativo inteiro — nenhum registro futuro a recalcula para quem já estava lá.

Consertar o boot sem consertar os dois teria trocado um defeito de desempenho por uma
divergência de interpretação entre réplicas, que é a classe de bug que a arquitetura inteira
existe para eliminar. Os quatro foram no mesmo lote.

### 124.4 O que mudou no normativo

Cinco emendas em `backend-v2.md`. As três primeiras são lacuna de especificação — o código
decidia algo que a spec não definia; as duas últimas são a spec descrevendo um contrato que a
configuração nomeada não entrega.

- **§6.9 e §8.1 — o que "20 emojis distintos" conta.** Passa a ser "emoji com ao menos um
  reagente", e a última remoção **libera a vaga**. A leitura alternativa (conjunto que só
  cresce) deixava uma mensagem sem reação nenhuma exibida incapaz de receber a 21ª, e era
  inconsistente com a projeção, que só guarda reação viva. `MessageMeta.reactions` passa a ser
  `Map<Emoji, Set<KeyHex>>`: decidir a vaga exige saber quem reagiu.
- **§8.1 — três campos que o schema exigia sem declarar.** `orphaned` (§8.4.1),
  `displayNameCollision` (§6.1 L-5) e `preBan` (R-28). Mesma família de `HOLE-11` e `H-19`.
- **§8.4 — quem emite cada `recount`, e depois de quê.** A tabela declarava a *população* de
  cada contador sem declarar os *gatilhos*, e `roleMemberCount` não tinha nenhum em ban, kick
  ou saída. Junto: o efeito que escreve `display_name_collision` (a coluna existia em §10.3 e
  nada a escrevia) e o `patch` de `threads.root_deleted` que §6.8 já exigia.
- **§9.3 — R-30**, acima.
- **§6.4.1 — a renormalização não reespaça os dois sentinelas.** "Todos os itens vivos daquele
  escopo" tirava o Fundador de `RANK_TOP` e o cargo base de `RANK_BOTTOM`; com o piso vago, o
  próximo cargo criado sem dica caía **abaixo** do base — que é `A-03` de volta, por outro
  caminho. Medido com 380 inserções na mesma extremidade.
- **§10.3 — `contentless_delete=1` não é detalhe de implementação.** A spec dizia
  "contentless-delete (`content=''`)", que são duas configurações diferentes do FTS5:
  `content=''` sozinho só remove pelo comando `'delete'` **com os valores originais da coluna**,
  que o projector não tem por contrato (§8.4). A chamada com `NULL` tirava o `rowid` da lista e
  não subtraía termo nenhum. `view_schema_version` 6 → **7**.

### 124.5 O que continua aberto

Uma pergunta que a spec não responde e que a correção do achado 10 encostou sem resolver:
**thread cujo canal foi apagado**. §6.8 manda marcar `rootDeleted` quando a **raiz é deletada**;
não diz nada sobre a raiz ficar `orphaned` por `channel.delete`. O `reply_count` agora cai
(§8.4 exclui `orphaned`), mas `root_deleted` continua `0` e `query.threads` filtra por ele —
a thread de um canal apagado segue listada. Entra no backlog como **B69**, do lado do humano:
é decisão de produto, não de implementação.

Fora isso, nada aqui toca `communityHost`, `communityClient`, DM, mídia, app ou frontend: são
as fases seguintes do mesmo mapeamento.

---

## 125. Varredura da fronteira de processo: onze defeitos e quatro emendas — 2026-09-05

Fase 2 do mapeamento de busca por bugs. O escopo foi a fronteira `main` ↔ `utilityProcess` ↔
`renderer` e a gestão de segredo do núcleo: `config`, `clock`, `keystore`, `identity`,
`manifest`, `view`, `corestore`, `ipcMain`, `ipcRenderer` e a fiação de `composition/`.

O que a fase encontrou não foi um defeito difuso: foram **quatro mecanismos de segurança que
não estavam ligados**, dois deles listados no `core/README.md` como riscos residuais
*fechados*. Um mecanismo desligado é pior que um mecanismo ausente, porque ninguém o procura.

### 125.1 Os dois que estavam desligados havia semanas

**O `flock` de §10.8 nunca rodou.** `l3/ipcMain` é ESM — `core/package.json` declara
`type: module` — e carregava o addon com um `require()` nu, que nesse escopo lança
`ReferenceError`. O `catch` engolia, `fsext` ficava `null`, e **todo** `acquire()` caía num
ramo de comparação de PID que o próprio comentário admitia ser "sem garantia de atomicidade":
entre ler o arquivo e escrevê-lo cabem duas instâncias inteiras. Medido: três processos
disparados juntos adquiriram o mesmo LOCK. O teste que deveria ver isso, chamado "ProcessLock
exclusivo (§10.8)", adquiria e liberava **um** lock — nunca houve um segundo detentor.

Vale registrar o que atrapalhou a verificação, porque vai atrapalhar de novo: `node -e` define
`require` no objeto global, então uma checagem feita por `-e` **passa** e esconde o defeito. Só
um arquivo `.mjs`/`.cjs` de verdade reproduz o escopo do módulo.

**O `wipe` reportava sucesso sem apagar, em Windows.** A etapa `manifest-deleted` apagava
`manifest.db` sem fechá-lo — ao contrário de `view-deleted`, que fechava —, e `apagarBanco`
tinha um `catch {}` mudo. Em Linux o `unlink` de arquivo aberto funciona e nada aparecia. Em
Windows o SQLite abre sem `FILE_SHARE_DELETE`: a remoção falha, o erro sumia, a máquina seguia
para `done`, o sentinela era apagado e a UI ouvia "apagado" — com `communities.core_key` e
`invite_secrets.secret` (que **não** é cifrado) intactos no disco, e o boot seguinte repetindo
a mesma falha em silêncio para sempre. O teste afirmava `existsSync === false`, o que passa na
plataforma onde o defeito não acontece.

### 125.2 Os outros nove

- **`identity.create` sem rollback.** `#initKeys` roda antes do primeiro `await` que pode
  falhar (o wrap da Data Key atravessa a IPC-M, prazo de 20 s). Um wrap que estoura deixava a
  identidade viva **só em memória**: `isLoaded` virava `true` e liberava toda a classe
  `standard` de §15.3 sobre uma identidade que não existe no disco; o vigia de rede anexava o
  backend do swarm e anunciava esse par na DHT; e toda retentativa devolvia
  `E_IDENTITY_EXISTS`, sem saída a não ser matar o processo.
- **O probe A13(5)(6) nunca aplicou backend nenhum.** Rodava depois de `app.whenReady()` (A13(6)
  mede que o switch só vale antes) e relançava com `process.argv.slice(1)` — o argv original,
  sem o `--password-store` recém-anexado. Persistia a lista de *tentados* em vez do *aprovado*,
  então após três relaunches o probe ficava desligado para sempre e a instalação caía em
  `insecure-fallback` permanente numa máquina com chaveiro funcionando. Agora o switch viaja no
  argv do relaunch, o aprovado é persistido, e o esgotamento é datado.
- **O LOCK era solto no meio do boot.** `resumePendingWipe` recebia `releaseLock`, e a etapa
  `done` o chamava — mas o boot **continua** dali, abrindo `manifest.db`, `view.db` e os cores.
  Nada readquiria: depois de qualquer limpeza interrompida, o núcleo rodava a sessão inteira sem
  a exclusão de §10.8.
- **A confirmação nativa de §15.3 não dizia o que confirmava.** "Confirmar ação destrutiva?"
  servia igualmente para apagar a instalação e para reprojetar uma comunidade, `cmd` não era
  conferido contra tabela nenhuma, e o token valia para qualquer argumento. Contra o adversário
  que a classe nomeia — o renderer comprometido — a defesa inteira era um clique.
- **Quatro divergências no backpressure de §15.1.** `evStale` saía no instante em que a janela
  enchia (`IPC_STALE_MS` era campo morto), `dropped` era `1` fixo, o `evAck` zerava um contador
  cego em vez de avançar uma marca, e o `IpcClient` **não** mandava o `evAck` que §15.1(5)
  obriga — a assinatura ficava morta pelo resto do `epoch`, e a UI daquele tópico congelava sem
  erro. `IPC_SUB_WINDOW`/`IPC_STALE_MS` de §27.2 eram configuração morta: o `IpcServer` nascia
  sem elas.
- **Falha de consulta ao keystore virava modo inseguro permanente.** Qualquer exceção do
  `keystoreInfo` era lida como "não há cifra", e o modo ficava fixo para a vida do processo.
- **Segredos não zerados.** A semente decifrada em cada `load`, a de `create`, o payload em
  claro do `exportBundle`, e a Data Key do processo — que §3.2 item 4 manda zerar e que o
  `wipe` não tocava. Junto: `import` decodificava o backup **duas vezes**, pagando o Argon2id
  MODERATE em dobro e dobrando as cópias em claro no heap.
- **A porta IPC-R não era reentregue na recarga do renderer.** Uma `MessagePort` transferida
  pertence ao documento que a recebeu; ao ser substituído, ela morre junto e não há como
  retransferi-la. O renderer recarregado ficava sem IPC-R até o núcleo morrer por outro motivo.
- **Duas gramáticas de deep link, e a testada não era a do produto.** A cópia de `l3/ipcMain`
  não tinha consumidor fora do teste e já divergira (faltava `u/<KEY64>`, da emenda B64). Ficou
  uma só, em `app/src/main/deeplink.ts`, com `npm run smoke:deeplink`.

### 125.3 O que mudou no normativo

Quatro emendas em `backend-v2.md`, todas lacuna de especificação: o código decidia algo que a
spec não definia, e em três das quatro a decisão silenciosa era a insegura.

- **§10.8 — não há etapa (2) sem `flock`/`LockFileEx`.** Comparar PID não é exclusão e não
  pode substituí-la; sem poder tentar o lock, o núcleo recusa abrir
  (`E_CORE_LOCK_UNAVAILABLE`). O PID e o `install_id` do arquivo continuam servindo para nomear
  o dono e reconhecer o órfão — nunca para decidir se o lock está livre.
- **§15.3 — o que o diálogo diz e ao que o token se liga.** A caixa **nomeia** a ação, por
  tabela fechada indexada pelo comando; o main só emite para comando da tabela; e o token
  liga-se a `(cmd, escopo)`, com o escopo derivado do argumento pelos dois lados. Nenhum escopo
  carrega segredo — `identity.export` não se liga à `passphrase`.
- **§15.1(5) — o descarte consome `evSeq`, e o ack de um `evStale` cobre `toSeq`.** É o buraco
  na numeração que dá corpo à detecção de perda de §15.1(3); e como os descartados consumiram
  seq, confirmar só o entregue deixaria a janela cheia para sempre.
- **§18.6 e §3.2 L-2.** Fechar o descritor antes de apagar e **verificar** que o arquivo sumiu;
  o `wipe-resume` do boot **não** libera o LOCK (o processo continua, e §10.8 exige a etapa (2)
  antes da (4)); `key-wiped` zera também a Data Key. E o modo do cofre passa a ser persistido em
  `manifest.meta.keystore_mode`: não conseguir perguntar é `E_KEYSTORE_UNAVAILABLE` e não "não
  há cifra"; `insecure-fallback → secure` migra sozinho; `secure → insecure-fallback` recusa com
  `E_KEYSTORE_MODE_CHANGED`, porque não há o que reembrulhar.

### 125.4 O que continua aberto

Nada de novo entrou no backlog. Duas observações que a fase deixa registradas sem tratar,
porque pertencem a fases seguintes deste mesmo mapeamento:

- `shell.reveal` e `setWindowOpenHandler` no main não têm a allowlist de tipo que §13.6 pede —
  ambos são o caminho de anexo e captura, fase 6. **Fechado em §128**, com a ressalva de que
  o `shell.reveal` já era coberto pelo `canReveal` do núcleo: o que faltava no main era a
  segunda tranca que §3.1 declara, e o `mode`, que era ignorado.
- A verificação em Windows do `wipe` corrigido é a evidência que falta: o defeito foi deduzido
  do modo de compartilhamento do SQLite e fechado com um teste que reproduz a falha de remoção
  de forma portátil (diretório no lugar do arquivo), não com uma rodada em Windows.

---

## 128. Varredura do shell Electron: o que o relatório acertou, o que ele errou — 2026-09-05

Verificação do relatório de auditoria do `app/` (main, preload, `utilityProcess` e a ponte do
renderer): 14 achados e 3 "lacunas de especificação". A regra desta fatia foi a de sempre —
**cada achado é confirmado na fonte antes de virar correção**, e o que não se sustenta é dito
por que não se sustenta. Sete confirmados como escritos, quatro confirmados com o mecanismo
certo e a consequência exagerada, três refutados. Das três lacunas, uma era real.

### 128.1 Os defeitos confirmados e corrigidos

- **A rede era parada ANTES do dreno, então a barreira de §18.7 não podia ser cumprida.** O
  `drenarESair` do `utilityProcess` chamava `pararRede()` — que fecha canais, esquece muxes e
  destrói o backend do swarm — e só então `runtime.shutdown()`. O passo 2 de §18.7 conta
  **pares que confirmaram a cabeça**, lidos do bitfield que o replicador mantém por par
  conectado; sem pares, a contagem é zero fixa, o alvo `min(3, memberCount − 1)` nunca é
  alcançado e o `outbox.flush()` do primeiro giro não tem canal. O efeito não era "replicar
  menos": era gastar o orçamento inteiro para devolver `replicatedTo = 0` e sair do swarm
  **antes** de replicar — a barreira desligada com o sintoma de estar ligada. Invertido.
- **Sob o portal do Wayland, o som era calculado pelo tipo DECLARADO.** O renderer declara
  `screen`, a caixa do sistema oferece tela **e** janela, a pessoa aponta uma janela — e
  `audioDaCaptura('screen', …)` devolvia `loopback`. O som da máquina inteira concedido a quem
  escolheu compartilhar uma janela, que é a captura a mais que §17.5 nomeia. O tipo efetivo
  passa a ser lido do `id` da fonte concedida, e `sourceTypes` é reconferido contra ele.
- **`blocked` era tratado como crash.** Lock ocupado (`E_CORE_ALREADY_RUNNING`) ou schema à
  frente (`E_SCHEMA_AHEAD`) são "encerra" em §3.3, e o main os mandava de volta pela lógica de
  respawn de §15.2: quatro caixas de erro idênticas para uma condição que a primeira já
  descrevia inteira.
- **O reinício agendado nascia no meio do quit.** O backoff chega a 10 s; fechar a janela
  dentro dessa janela punha um núcleo novo no mundo depois de `encerrando = true` — bancos
  abertos, lock de §10.8 tomado, e ninguém mais para lhe mandar `shutdown`. Morria pelo prazo
  de 8 s, sem snapshot e sem soltar o lock pelo caminho limpo.
- **`shell.open` ignorava o `mode`.** "Mostrar na pasta", que é a ação menos invasiva e a única
  que §13.6 regra 1 oferece para o que está fora da allowlist, **abria o arquivo**. E o
  `canReveal` do núcleo recusava os dois modos, então um `.zip` baixado não tinha ação nenhuma
  — nem a que a regra lhe promete pelo nome.
- **`setWindowOpenHandler` prometia allowlist e não tinha nenhuma.** `shell.openExternal(url)`
  cru: o esquema era o que o SO registrasse.
- **A fila de deep link nunca esvaziava**, então toda recarga da janela reabria a prévia dos
  convites já tratados.
- **`mainWindow` não era zerada no `closed`.** A janela morre antes do processo (o draining
  dura até 8 s), e cada `mainWindow !== null` adiante era acesso a objeto destruído.
- **A porta IPC-R dependia de o React ter chegado ao efeito antes de o main entregar.** O
  evento `message` do DOM não tem fila: quem não tem ouvinte no instante do despacho perde a
  porta para sempre. A ordem de hoje é favorável (a entrega é adiada até `did-stop-loading`),
  mas era ordem por sorte. A escuta passou a ser de módulo, e a porta que chega cedo demais
  fica **guardada**.
- **`window` sem `sourceId` concedia `fontes[0]`** — que, no handler, é tipicamente a janela
  deste app (ao contrário do `listCaptureSources`, o handler não a filtra). Falha fechada.
- **A declaração de sessão de captura sobrevivia ao uso**, então um segundo `getDisplayMedia`
  sem `declareCaptureSession` herdava o endereço do primeiro. O núcleo ainda recusaria a
  sessão morta com `gone`, mas a ordem de `T-41` é a barreira e ela é do main.

### 128.2 O que o relatório errou

- **`shell.reveal` não abria executável.** O achado descrevia um `.sh` baixado sendo executado
  pelo `openPath`. Não chega lá: `canReveal` (§13.6, `l2/blobs`) recusa executável e tudo fora
  de `image`/`audio`/`video`/`document` com `E_TYPE_NOT_OPENABLE`, e `onReveal` nem é chamado.
  O que era verdade é outra coisa, e menor: §3.1 põe a allowlist **na caixa do main**, e ali
  não havia conferência nenhuma. Ela foi acrescentada como segunda tranca — não como a
  primeira, que já existia.
- **O probe de `--password-store` não mata instâncias no relaunch.** O achado citava A13(6)
  ("o probe roda antes do lock composto de §10.8") contra a §10.8(1) tomada no topo do módulo.
  A ordem é mesmo essa, e o dano descrito não acontece: `app.relaunch()` sobe a instância nova
  **quando a atual sai**, então ela nunca disputa o singleton com quem a pediu, e um
  `SingletonLock` órfão é retomado. `E_CORE_ALREADY_RUNNING` — o código que a própria ADR cita
  — é da etapa (2), o `flock` do núcleo, e essa o probe precede de fato. A ADR foi emendada
  para nomear a etapa certa, e para registrar que a (1) não pode vir depois:
  `safeStorage.isEncryptionAvailable()` só responde depois do `ready` no Linux.
- **A perda de `core-epoch`/`core-ready` na recarga não tem a consequência descrita.** O
  achado dizia que o `IpcClient` classificaria o `hello` contra a época errada. Não classifica:
  o epoch do cliente vem do **`hello`**, e o rótulo que o preload põe no `window.postMessage` é
  ignorado por quem escuta. `core-ready` não tem assinante nenhum no renderer, e `getEpoch()`
  não tem chamador. A inconsistência é real; o efeito observável, não.
- **Recarga do renderer derrubar o núcleo não é acidente.** É o ciclo de §15.2 sendo reusado
  porque não há caminho mais barato: uma `MessagePort` transferida morre com o documento, a do
  outro lado já foi transferida, e o canal inteiro precisa nascer de novo. Rebindar só a ponta
  do renderer exigiria troca de porta em quente no `IpcServer` e um `hello` fora do nascimento
  do processo — mecanismo novo no contrato de §15.1 para um caso que o ciclo existente cobre.
  Ficou **declarado** em §15.2, com o custo dito: recarregar não é operação barata aqui.

### 128.3 As três lacunas de especificação

- **Reconciliação de tipo e áudio no portal — não era lacuna, era defeito.** §17.5 já responde
  ("no Linux o loopback é concedido para captura de tela, nunca de janela"; "compartilhar uma
  janela não é consentir em transmitir tudo o que toca na máquina"). O que faltava era o
  código obedecer. A emenda de 2026-09-05 em §17.5 diz explicitamente que o tipo que vale é o
  **concedido**, porque a regra é sobre a fonte que a captura usa — e acrescenta a reconferência
  de `sourceTypes`, que essa sim não estava escrita.
- **Encerramento por sinal externo — lacuna real, e a única.** Nada dizia o que acontece com
  o `draining` quando a saída vem de `SIGTERM`/`SIGINT`/logoff, e na prática não acontecia
  nada: o processo morria sem snapshot de §10.6, sem a barreira de §18.7 e sem `stopped`.
  §3.3 foi emendada com a tabela dos dois caminhos: o sinal externo **não** passa por U-06 (a
  decisão foi tomada fora do app; perguntar "tem certeza?" a um `SIGTERM` gasta o prazo que o
  SO deu antes do `SIGKILL`) e drena com a mesma barreira e o mesmo orçamento.
- **Modo Música no portal — já respondida.** §17.5 item 3 diz, com todas as letras, que no
  Wayland "o portal continua sendo quem escolhe a fonte de vídeo, e por isso o Modo Música
  ainda passa pela caixa do sistema nessas sessões". O código faz exatamente isso.

### 128.4 As duas decisões do operador, tomadas

Os dois itens que esta fatia levantou nasceram e fecharam nela, com a decisão dada.

**`B73` — `archive` abre, atrás da caixa nativa (§15.3 vence §13.6 regra 1).** As duas seções
se contradiziam: a regra 1 listava só `image`/`audio`/`video`/`document`; §15.3 declara
"`blob.reveal` de `archive`" na linha `main-confirmed` e escreve o texto da caixa ("Abrir este
arquivo compactado?"). O caminho `main-confirmed` estava construído nas duas pontas — o
`BLOB_KIND_ARCHIVE` no roteador, o `requireConfirmation`, a entrada em `CAIXA_POR_COMANDO`, e
o retry com token no `api.blobReveal` — e o que o matava era uma linha do `isRevealAllowed`.

O argumento que decidiu: **bloquear não removia o risco, mudava-o de caminho.** "Mostrar na
pasta" leva à mesma pasta, e o duplo clique de lá não tem confirmação nenhuma; recusar "Abrir"
empurrava a pessoa para o caminho com *menos* aviso. Abrir um `.zip` inicia o gerenciador de
compactados, que não executa nada de dentro. §15.3 é a regra mais específica — nomeia o tipo e
nomeia o mecanismo de consentimento —, e a regra 2 (executável bloqueado até para revelar), que
é a que de fato sustenta a segurança desta seção, não foi tocada.

**`B74` — quem classifica é o núcleo, e ele passou a dizer (`revealMode`).** A regra 1 manda
oferecer somente a ação que o tipo permite, e a UI tinha três caminhos, dois ruins: o `kind` do
log é declarado por quem enviou (é o `T-48` que a própria regra nomeia), e derivar da extensão
no renderer seria a terceira cópia da tabela. O `AttachmentDto` de §15.6.1 ganhou
`revealMode: 'open' | 'folder' | 'none'`, decidido pelo núcleo pela extensão real e válido
**antes** do download (o nome está no log, e o arquivo local preserva a extensão pela regra 2).
Efeito colateral bom: a decisão de `B73` chega à tela sozinha, sem uma segunda edição.

Junto saíram duas coisas menores que só apareceram por causa disto:

- **"Mostrar na pasta" passou a funcionar para `archive` e `other`.** O `canReveal` recusava os
  dois modos, então um `.zip` ou um `.bin` baixado não tinha ação nenhuma — nem a que a regra 1
  lhe promete pelo nome. Agora ele recebe o `mode`, e `folder` só esbarra na regra 2.
- **A recusa aparece na tela.** `api.blobReveal` era chamado com `void` e sem `catch`: um
  `E_TYPE_NOT_OPENABLE`, ou o cancelamento da caixa nativa, viravam um botão que parecia não
  fazer nada. `E_CANCELLED` continua sendo desistência e não vira mensagem.
- **`blob.stage` deixou de ser tipado como `AttachmentDto` no renderer.** Era mentira antiga —
  o stage descreve bytes recém-escritos, sem estado de download, sem pares e sem `revealMode` —
  e só apareceu quando o DTO ganhou campo obrigatório. §15.6.1 agora declara os dois tipos.


---

## 129. Varredura da conversa direta pela interface: o que o relatório acertou — 2026-09-05

Verificação do relatório consolidado sobre a **interface** da conversa direta
(não confundir com §127, que foi o relatório sobre o núcleo da DM): 14 achados e 2 "lacunas
de especificação". A regra é a de sempre — **cada achado é confirmado na fonte antes de virar
correção**. Doze confirmados, um refutado, um com o mecanismo certo e a causa errada. As duas
lacunas eram reais, e as duas fecharam por emenda. A varredura achou **um buraco maior do que
qualquer item da lista**, que o relatório não viu; ele está em §129.5 e virou **B76**.

### 129.1 Os defeitos confirmados e corrigidos

- **Bloquear ou esquecer no meio de uma chamada não a encerrava** — o crítico do relatório, e
  ele tinha **duas metades**, das quais o relatório viu uma. A do renderer é a que ele
  descreve: `bloquearConversa`/`esquecerConversa` despachavam o comando sem tocar em
  `dmVoz.desligar()`, e microfone e câmera seguiam capturando. Em `esquecer` a conversa some
  da lista e leva junto a **única** superfície que oferecia desligar (o cabeçalho da
  conversa), deixando uma chamada órfã que ainda recusava a próxima com "voz é uma só"
  (§15.4). A metade que faltava é do **núcleo**: a mídia é ponta a ponta e não passa pelo
  canal que o bloqueio fecha, mas o **escopo do serviço de §17.3 é do núcleo** — bloquear sem
  sair deixava o escopo registrado no `MediaServer` e a credencial TURN emitida por este nó
  ainda válida, isto é, este nó encaminhando a mídia de quem acabou de bloquear. As duas
  foram corrigidas, e a do núcleo mora em `registerDmCommands`, **não** na raiz de
  composição: há mais de uma montagem da mesma superfície (o `boot.ts` do produto e os rigs
  de teste), e uma regra que dependesse de cada uma se lembrar dela valeria só onde alguém
  lembrou — foi exatamente o que a primeira tentativa mostrou, com o teste passando pela
  montagem errada. §31.16.1 ganhou a emenda.
- **A conversa aberta acumulava não lidas sobre si mesma.** A contagem de §31.12 é por
  watermark e não sabe o que está na tela: a mensagem que chegava ficava acima da marca e
  entrava no selo, com a conversa visível. Só sumia ao fechar e reabrir. O renderer passa a
  remarcar ao chegar lote com `hasIncoming` (§31.16.2) na conversa em foco — e **só** com
  ele: um lote só meu não tem o que dar por lido, e remarcar nele seria uma escrita no
  manifest a cada mensagem enviada.
- **`abrirConversa` marcava como lida mesmo sem ter aberto nada.** Duas formas do mesmo
  defeito: a página que falhava (a recusa é engolida por desenho, e engoli-la **e** marcar
  apagava o selo de uma conversa que não abriu) e a troca de conversa no meio da abertura
  (clicar em A e logo em B zerava o selo de A). `recarregarDetalhe` sempre teve a segunda
  guarda; o `markRead` não tinha nenhuma das duas.
- **O cartão de anexo da DM era metade do fluxo de §13.4.** Ele lia um instantâneo congelado
  de `dmStore.anexos` e nunca mais o revisitava: `blob.progress` e `blob.completed` alimentam
  o `downloadStore`, que ele não consultava. Sem progresso, sem mudança ao concluir e **sem
  nenhuma ação para abrir o arquivo baixado** — §13.6 regra 1 sem superfície nenhuma. A
  correção foi apagar a cópia: §31.14 manda reutilizar o fluxo de download "sem alteração", e
  o cartão da DM passou a ser o cartão de §13 com o `conversationId` no slot do `communityId`.
  `baixarAnexo` saiu de `live/dm.ts` — sem ele, não sobra caminho que mande `blob.download`
  sem escutar os cinco eventos de desfecho.
- **`query.dmMessage` devolvia meio `AttachmentDto`** — a causa raiz do item acima, e uma
  violação de §31.16.3, que declara o DTO de §15.6.1 "sem alteração". Faltavam `state`,
  `progress`, `localPath`, `availablePeers` e `hostAvailable`: metade do tipo é estado de
  download, lido do mesmo `local_blob_cache` que `query.message` já lia. Efeito visível: o
  arquivo já baixado nesta máquina reaparecia como "Baixar" a cada abertura do app.
- **O modal de "Nova conversa" descartava o `jaExiste` que ele mesmo calculava**, e mandava a
  chave pelo `dm.open` sempre. Dois desfechos errados, um deles grave: conversa `blocked` →
  `E_DM_BLOCKED` e um toast no lugar do histórico legível que `blocked` promete ser; conversa
  `pending-in` → **aceite silencioso**, porque `dm.open` sobre um pedido recebido é `aceitar`
  (§31.9 regra 1). Aceitar escreve o `dm.hello` e não se desfaz — é o ato que a seção de
  pedidos da lista existe para impedir que aconteça por engano. `left` ficou de fora do
  desvio: ela não está na lista, e quem sabe o que fazer com ela é o `dm.open`.
- **A chamada que falhou continuava oferecendo câmera e tela.** `dmCallStore.falhou` mantém
  `na-chamada` de propósito (a faixa de §99 precisa ficar), mas o veredito da malha só sai
  quando **nenhum** par chegou a `connected`: clicar ali acendia o dispositivo para mandá-lo
  a lugar nenhum. `acoesDeVideo` passou a receber a falha.
- **"Carregar mensagens anteriores" saltava para o rodapé.** O efeito rolava ao fim a
  qualquer variação de `mensagens.length`, e carregar a página anterior é exatamente isso: o
  histórico entra no topo, o comprimento cresce, e quem subiu para ler é arremessado de volta
  — a única coisa que acabara de pedir para não fazer. A medida passou a ser a do
  `MessageList` do canal, feita no **gesto de rolar** e não depois do render.
- **A linha da lista não trazia o trecho da última mensagem**, que U-33 exige por escrito.
  Sem ele, uma lista de nomes conhecidos não diz qual conversa tem algo novo para ler.
- **O deep link `u/<KEY64>` não chegava a lugar nenhum fora da DM.** A chave era guardada num
  store que só o destino de conversas lia (B63(a)), então clicar no link de dentro de uma
  comunidade não produzia efeito visível. §3.5 regra 3 foi emendada: "nunca dispara ação" é
  sobre o **comando**, não sobre navegar — sem navegação não existe a tela em que a
  confirmação aparece.
- **O "digitando…" vazava na troca de conversa.** Sair com meia frase no campo deixava o
  pulso `on:true` de pé até o TTL de 5 s. O TTL limitava o dano; ele não é o desligamento, é
  a rede de segurança para quando o desligamento não chega.
- **O clipe não dava sinal de vida durante o staging.** O `blob.stage` escreve os bytes antes
  de existir mensagem, e num disco lento o botão apagado sem mais nada é um botão morto. Ele
  ganhou o giro, e "Enviar" passou a esperar o stage — enviar no meio mandaria a mensagem sem
  o anexo que está a caminho.

### 129.2 O que o relatório errou

- **`DmConversationView` não ignora `detalhe.state`.** O achado (alto, no relatório) dizia
  que a tela usa a prop estática `conversa.state` e fica travada em `pending-out` depois do
  aceite. A prop **não é estática**: `conversa` sai de `useDmStore.conversas`, que
  `dm.conversationChanged` reconsulta por `sincronizarConversas()`, e `DmDestino` recalcula a
  conversa ativa a cada mudança da lista. `detalhe.state` seria uma segunda cópia do mesmo
  fato. A assimetria com `sync` que o relatório notou é real e tem razão: `dm.desynced`,
  `dm.forked` e `dm.partialInterpretation` reconsultam **só** o detalhe, então `detalhe.sync`
  é mais fresco; `state` não tem evento nessa situação. Refutado, sem correção.
- **O esqueleto eterno do anexo é real; a causa não é a descrita.** O relatório atribuía o
  shimmer infinito a "`hasAttachment` verdadeiro com o blob ainda não replicado". Isso não
  acontece: `has_attachment` é um `COUNT(*)` sobre `dm_attachments`, a **mesma** tabela que a
  query do anexo lê, gravada pelo **mesmo** lote do projetor — o que replica depois são os
  **bytes**, não a linha. O caminho alcançável é a consulta que falha, e o defeito é o
  mesmo: `carregarAnexo` saía sem gravar nada e o efeito, com as dependências inalteradas,
  não rodava de novo. Corrigido com o desfecho gravado, texto honesto ("não foi possível
  carregar") e um botão.

### 129.3 As duas lacunas de especificação — as duas reais

- **O divisor de "Novas mensagens" não tinha fonte.** U-33 manda a conversa reusar a anatomia
  de §9 2.1 e nomeia o divisor; §31.16.3 dava `unread.count` (**quantas**) e nunca o watermark
  (**onde**). `query.dmMessages` e `query.dmConversation` passam a devolver `lastReadOrdSum` e
  `lastReadAuthorKey`. Os **dois** eixos viajam: `naoLidas` desempata pela chave do autor
  (§31.6), e um corte só por `ordSum` discordaria do próprio selo no empate — "1 não lida" com
  divisor nenhum na tela. Duas regras de tela acompanham a emenda: a marca vem na **mesma**
  resposta da página (numa segunda consulta ela avançaria entre as duas, e o divisor cairia no
  lugar errado por uma corrida) e o corte é **congelado na abertura**, porque abrir marca como
  lida logo em seguida e um divisor que seguisse o watermark sumiria no quadro em que apareceu.
- **A chamada de DM não tinha superfície fora da conversa.** Atender e desligar existiam só no
  cabeçalho, sob a guarda de ser a conversa aberta: uma chamada que chegasse com o app noutra
  conversa — ou numa comunidade — não podia ser atendida nem recusada, e "voz é uma só" ainda
  impedia iniciar outra, com erro sobre uma chamada que ninguém via. U-33 já mandava usar o
  painel de 2.3.1, e 2.3.1 é justamente **a superfície que sobrevive à navegação** (§11 C11);
  o que faltava era isso estar escrito. O `DmCallPanel` ocupa o mesmo slot do painel de
  chamada, existe nos três estados que têm chamada e **some** quando a conversa da chamada é a
  que está na tela — repetir o par de botões 8px acima do cabeçalho é o argumento que já tirou
  mudo e ensurdecer do painel da comunidade. Atender leva para a conversa, porque a imagem e o
  mudo moram lá.

### 129.4 A emenda que fechou uma pendência antiga

**B14 fechou.** "Correlação `blob.progress` ↔ `AttachmentDto` não é declarada em §15.6" estava
na lista desde §58.6, do lado humano, esperando "a forma da correlação". A varredura mostrou
que a forma já existia e só não estava escrita: é o `blobIdHex` de §13.2 — os 16 primeiros
bytes do `hash`, em hex —, a chave que os cinco eventos de blob carregam desde a emenda de
2026-08-22 e que o adaptador do renderer já produzia como `Attachment.id`. A lacuna não era de
desenho, era de declaração, e ela custou caro exatamente uma vez: o cartão da DM foi escrito
sem a correlação e ficou parado enquanto os bytes desciam. §15.6.1 passa a declará-la, e a
afirmar que ela vale igual na conversa direta.

### 129.5 O que a varredura achou e o relatório não viu — B76

**A conversa direta não tem responder, editar, apagar nem reagir.** U-33 os lista por escrito
("a conversa reusa a anatomia de 2.1 — grupo de mensagens por autor, divisor de *Novas
mensagens*, composer, **responder, editar, deletar, reagir**"), o núcleo os serve há muito
(`dm.edit`, `dm.delete`, `dm.react`, e `replyToId` em `dm.send`, §31.16.1), o cliente de IPC-R
os expõe e `live/dm.ts` tem as quatro funções escritas — **sem chamador nenhum**.
`DmMessageRow` não tem barra de ações, e o `replyToId` que a spec declara nunca é preenchido.

É a família de defeito que este repositório já nomeia em §82.3 e que a lista carrega em B44,
B49, B71 e B72: superfície declarada, sem produtor de um dos lados. A diferença é que aqui a
metade que falta é a **tela**, e ela é maior do que qualquer item deste relatório — barra de
ações por mensagem, seletor de emoji, edição no lugar, confirmação de apagar e a citação no
composer. Não é correção de defeito, é a fatia de produto que U-33 pede e que §100..§109 não
entregou; por isso ela **não** entrou nesta varredura e virou **B76**, do lado do agente.

**Correção de numeração:** a lista tinha **dois** itens `B66`. O de RD-11 (§31.7.4) é o
original e é o que o histórico referencia de §100 em diante; o de "apagar a própria mensagem
esconde a linha inteira", que nasceu depois em *A observar*, passou a **B75**.

### 129.6 O que não foi medido

- **Nenhuma tela tem teste de render** (B20 continua aberta), e as correções de tela desta
  fatia são afirmadas pelas regras puras de `dmRegras.ts` e pelo comportamento de
  `live/dm.ts` — não pelo DOM. O divisor, o painel de chamada, o cartão de anexo e o trecho
  da lista têm o **cálculo** coberto e a **renderização** não.
- **A chamada de DM continua sem duas pontas com mídia real.** `smoke:voz` cobre a malha de
  comunidade; o caminho de DM segue com a evidência de §109 e de §123.2, e nada aqui muda
  isso. O que esta fatia acrescentou ao caminho da chamada — bloquear e esquecer encerrando —
  está medido pela superfície (`E_SESSION_GONE` depois do comando), não pela mídia.

---

## 130. Varredura da mídia de comunidade pela interface: voz, câmera, tela e música — 2026-09-06

Verificação do relatório consolidado de auditoria sobre o caminho de **mídia da comunidade**
no renderer (voz, câmera, compartilhamento de tela, Modo Música e gravação local): 16 achados
e 6 "lacunas de especificação". A regra é a de sempre — **cada achado é confirmado na fonte
antes de virar correção**. Treze confirmados como escritos, dois com o mecanismo certo e o
alcance exagerado, **um refutado**. Das seis lacunas, todas as seis eram reais e fecharam por
emenda.

O tema é um só, e ele atravessa quase todos os achados: **esquecer a referência não fecha o
dispositivo.** O produto tem três capturas que vivem só no renderer e não têm sessão no host —
a câmera, a tela e a gravação local — e nenhuma seção dizia quando cada uma morre. O resultado
foi a mesma família de vazamento em quatro caminhos diferentes.

### 130.1 Os defeitos confirmados e corrigidos

- **Sair da chamada compartilhando tela deixava o SO capturando.** O crítico do relatório, e
  ele estava certo por inteiro. `pararTudo` (`live/sincronizacao.ts`) esquecia os `MediaStream`
  de tela e rodava a lista `aoPararTudo` — em que **só a câmera** estava registrada;
  `configurarTela` nunca pôs a estrela lá. Sair pelo botão, ser revogado, o host sumir: nos
  quatro caminhos a captura de tela seguia viva, com o áudio do sistema junto e o indicador de
  gravação do SO aceso, servindo uma sessão que o host já tinha esquecido. A correção é a
  linha irmã da da câmera; a emenda de §17.2 é o que impede a assimetria de voltar.
- **A câmera vazava aberta quando a negociação falhava.** Em `CameraDaChamada.ligar`, o
  dispositivo é aberto e só então a trilha vai à malha. Se `definirVideoLocal` lançasse, a
  exceção subia com `#stream`/`#track` preenchidos e ninguém mais tinha a referência: a luz
  ficava acesa sob um botão que dizia "Ligar câmera". O `catch` de `configurarCamera` só
  traduzia o motivo. Agora a captura que não vira transmissão é desfeita antes de a falha
  subir.
- **Trocar de canal de voz não desligava câmera nem tela.** `voiceStore.join` zerava
  `cameraOn` e `shares` no estado e chamava `malha.entrar()`, que começa por `#limparEstado()`
  — fecha conexões, zera o vídeo local, encerra a mistura. Nada disso toca nos **dispositivos**:
  a luz da câmera do canal anterior seguia acesa transmitindo para ninguém.
- **A reentrada por epoch deixava o estado mentindo.** `retryJoin` rearmava só as flags de
  erro. O transporte voltava limpo e o store continuava com `cameraOn: true` sobre uma trilha
  que não chega a par nenhum, `musicaAtiva: true` sobre uma mistura encerrada e a transmissão
  de tela congelada numa sessão que o host esqueceu. Agora as três nascem desligadas, e as
  capturas param junto — a lacuna 6 do relatório, resolvida a favor de "nasce limpo".
- **Trocar de microfone com o Modo Música ligado emudecia a música.** O achado mais preciso do
  relatório. `trocarMicrofone` guarda o `MediaStream` de sistema, encerra a mistura e chama
  `ativarMusica(sistema)` para remontar o grafo com o microfone novo — e dentro de
  `ativarMusica` o `this.#trilhaDeSistema?.stop()` incondicional parava **a mesma trilha** que
  estava sendo reaproveitada. A música sumia para todos, sem erro nenhum, no meio de uma troca
  que aparentemente deu certo. A anterior agora só é parada quando é outra.
- **"Tentar novamente" do apresentador corria contra o próprio parar.** `retryShare` chama
  `stopShare()` e `startShare()` em sequência síncrona, cada um disparando uma promessa que
  ninguém aguarda. `EstrelaDeTela.parar()` lê `#stream` **depois** de seus `await` (o
  encerramento por espectador é o lento) e encontrava a captura NOVA: parava as trilhas dela,
  zerava a sessão nova e desfazia a declaração que o main acabara de receber. A retentativa
  nascia morta, dependendo de tempo. `apresentar` e `parar` passam a formar uma fila.
- **"Silenciar nesta chamada" não silenciava nada.** `setParticipantMuted` era um `set(...)` e
  mais nada: nenhum comando saía, o áudio continuava audível e o `voice.roster` seguinte
  desfazia o ícone. O verbo existe (`voice.muteParticipant`, §15.4), o núcleo o implementa, o
  cliente do alvo já sabe honrá-lo (`definirMudoImpositivo`) — faltava a chamada. "Conselho"
  em L-12 tinha sido lido como "não faz nada".
- **O `sharing` do roster nunca era escrito.** O host publicava `false` constante com a nota
  de que "quem muda é o `shareStar`", e nada mudava. Como o renderer reconstrói a lista de
  participantes a cada roster, a marca que `share.started` acendia era apagada pelo roster
  seguinte — o de **qualquer** `voiceState` de **qualquer** participante, que chega o tempo
  todo. Sumiam junto o ícone de quem apresenta e a confirmação de §11 (C11) ao sair da chamada
  compartilhando, que lê exatamente este campo: a transmissão morria sem a pergunta. É a
  lacuna 1 do relatório, e a correção é de autoridade — o host escreve, porque a sessão é dele.
- **A confirmação de saída não cobria a fase `starting`.** Entre escolher a fonte e a captura
  voltar já existe sessão no host, e sair a mata. O guarda lia só o roster, que nem tinha
  chegado. Agora ele lê o estado local da transmissão em qualquer fase; o roster é a
  confirmação, não a condição.
- **Trocar de câmera nas configurações era ignorado em chamada.** A assinatura de ajustes
  reagia a microfone, volumes e saída (B47) e não a `cameraId` — sem que nada dissesse por
  quê. Com o m-line 1 reservado (§17.2, 2026-09-03), trocar de câmera é `replaceTrack`, o
  mesmo custo da troca de microfone. É a lacuna 4, resolvida a favor da simetria.
- **A gravação local morava no ciclo de vida de um componente.** `VoiceControlBar` vive dentro
  da grade expandida, que **desmonta** ao recolher para a barra persistente (§9, 2.3.1) — e a
  chamada continua. Cada recolhimento durante uma gravação abandonava um `AudioContext` aberto
  com uma fonte por par **e** perdia o arquivo em silêncio: o botão voltava apagado, sem
  download. O gravador foi para `live/gravacao.ts`, fora do React, com `encerrar()` de
  verdade e descarte no fim da chamada. É a lacuna 3.
- **O `AudioContext` da gravação nunca fechava.** Mesmo sem desmontar: `parar()` encerrava o
  `MediaRecorder` e deixava de pé o contexto, o destino e as fontes.
- **O `blob:` do download era revogado no mesmo tique do clique.** O Chromium resolve o
  download fora dessa pilha; revogar ali deixa o arquivo vazio ou com erro de rede.
- **Os dois encerramentos vindos do host vazavam o relógio do VAD.** `voice.revoked` e
  `voice.failed` chamavam `malha.sair()` direto e pulavam o `desligarVad()` que a porta do
  store fazia. Inócuo por sorte — sem malha, `nivelDeVoz()` é `null` —, mas é um relógio a
  mais por expulsão. Os três caminhos passam a ser um só.

### 130.2 O que o relatório errou

- **REFUTADO — `definirSistema` não empilha ganho.** O relatório afirma que
  `ganhoSistema.connect(destino)` a cada troca de fonte soma uma aresta e eleva o volume
  percebido. O Web Audio não funciona assim: a especificação de `AudioNode.connect` diz que só
  pode existir **uma** conexão entre uma saída específica de um nó e uma entrada específica de
  outro, e que conexões repetidas com os mesmos extremos são **ignoradas**. `mixagem.ts` está
  correto como está, e nada foi mudado ali.
- **ALCANCE EXAGERADO — o VAD sob mudo.** O mecanismo apontado é real (o loop não consulta
  estado de mudo nenhum), mas a consequência descrita — "usuários silenciados ainda disparam
  `speaking`" — só vale num recorte. Uma `MediaStreamTrack` desabilitada entrega silêncio ao
  `MediaStreamAudioSourceNode`, então o mudo **próprio** já calava o detector sozinho, e o
  mudo **imposto sem Modo Música** também (ali os dois níveis convergem na mesma trilha). O
  caso que sobra é o único em que a saída é cortada sem tocar no microfone: **mudo imposto com
  o Modo Música ligado** — exatamente a fila de karaokê que o relatório usou de exemplo,
  quando quem espera a vez está com música. Corrigido pela propriedade certa (`vozAudivel`),
  que cobre os três casos de uma vez em vez de remendar o recorte.
- **ALCANCE EXAGERADO — a comparação de ids sensível a caixa.** A comparação estrita existe e
  é a exceção num arquivo que compara por `toLowerCase()` em todo o resto. Mas os dois lados
  vêm de `Buffer.toString('hex')` do núcleo, que é sempre minúsculo: o defeito é **latente**,
  não ativo, e o relatório o descreve como se o usuário já se visse duas vezes. Normalizado
  assim mesmo — é barato e é o idioma do arquivo —, mas registrado pelo que é.

### 130.3 As seis lacunas de especificação — as seis reais

| # | Lacuna | Onde fechou |
|---|---|---|
| 1 | Autoridade sobre `sharing` no roster de voz | §6.16 — o host escreve, pelo `shareStar`; corolário para o guarda de §11 (C11) |
| 2 | Supressão de `speaking` sob mudo impositivo | §6.16 — `speaking` é sobre o que SAI, não sobre o que o microfone capta |
| 3 | Ciclo de vida do pipeline Web Audio da gravação local | §17.2 — item 5 da emenda de ciclo de vida da mídia local |
| 4 | Troca ao vivo de câmera | §17.2 — emenda própria, simétrica à do microfone (B47) |
| 5 | `speaking` ao mutar e ao sair | §6.16 — a virada para `false` é enviada; sem medição, nada é publicado |
| 6 | Destino de câmera, música e tela na reentrada (epoch) | §17.2 — item 3: nascem desligados, e a interface reflete |

Uma sétima emenda saiu da varredura e não estava na lista do relatório: **§17.5 — apresentar e
parar são serializados entre si**. A ordem de `T-41` descrevia uma apresentação isolada e não
dizia nada sobre duas operações sobrepostas, que é o caminho mais comum de todos.

E duas emendas fecharam limitações que estavam sendo lidas como ausência de mecanismo:
**§17.4 L-12** (o conselho tem um caminho, e ele é `voice.muteParticipant`) e **§17.5 item
5-bis** (a fonte de sistema é reaproveitada na remontagem do grafo).

### 130.4 O que foi medido

- `core`: `npm run build` (barreira de camadas), `npm run typecheck`, `npm test` — 1284 testes.
  Quatro novos em `test/voice-host.test.ts` para `setSharing`.
- `frontend`: `npm run lint`, `npm run build`, `npm test` — 584 testes. Sete novos:
  `src/store/__testes__/midia-local.test.ts` (ciclo de vida da captura nos três caminhos de
  saída e o `voice.muteParticipant`), mais casos em `musica.test.ts` (trilha de sistema
  reaproveitada, `vozAudivel`), `tela.test.ts` (a fila de captura, com o encerramento por
  espectador explicitamente lento — com fakes instantâneos a corrida não acontece) e
  `camera.test.ts` (a negociação que falha não deixa a câmera aberta).
- `app`: `npm run build`, `npm run typecheck`, `smoke:fechamento`, `smoke:captura`
  (um cenário **não medido** — janelas, sem gerenciador de janelas neste ambiente) e
  **`smoke:voz`**, que exercita duas pontas reais: as doze afirmações passaram, incluindo
  troca de canal, reentrada com uma conexão por par e mídia fluindo depois das duas.
- Cinco correções foram verificadas por **mutação** (reverter a correção derruba o teste):
  a trilha de sistema reaproveitada, a fila de captura (dois casos), a câmera que vaza na
  falha de negociação e o `sharing` do roster.

### 130.5 O que não foi medido

- **A troca ao vivo de câmera não tem teste de unidade.** Ela vive na assinatura de
  `useSettingsStore` dentro de `configurarCamera`, que só roda a partir de `configurarVoz()` —
  e esse caminho exige o cliente IPC-R inteiro. Está coberta por tipo e build, e o mecanismo
  que ela usa (`CameraDaChamada.ligar` como troca de dispositivo) já tem teste próprio. Mesma
  situação da troca de microfone, que também não é exercitada por unidade nessa camada.
- **O gate do VAD no laço tem a propriedade testada, não o laço.** `malha.vozAudivel` tem
  teste; a linha que o consulta dentro do `setInterval` de `configurarVoz` não, pela mesma
  razão acima.
- **A revogação síncrona do `blob:`** é comportamento do Chromium sob download real: a
  correção segue a documentação da plataforma e não há harness que a exercite aqui.

---

## 131. Varredura de cargos, permissões e moderação pela interface — 2026-09-06

Verificação do relatório consolidado de auditoria sobre a superfície de **cargos,
permissões e moderação** no renderer: 14 achados e 3 "lacunas de especificação". A regra é a
de sempre — **cada achado é confirmado na fonte antes de virar correção**. Treze confirmados
como escritos, **um refutado**. Das três lacunas, duas eram reais e uma era leitura errada do
normativo; as três fecharam por emenda.

O tema é um só, e ele atravessa doze dos treze achados: **a tela oferecia o que o `fold` já
recusa.** O núcleo tem a decisão certa — hierarquia (R-4), imutabilidade do Fundador,
anti-escalada de permissão (R-5, R-11), imunidade de Fundador e host (R-16), cargo base
obrigatório (R-3) — e nenhuma das telas de §10, 3.2/3.3 consultava nada disso antes de
oferecer o botão. O resultado era sempre o mesmo: clicar, esperar, receber um código de erro
nomeado por uma ação que o produto já sabia que não ia acontecer.

E havia um segundo tema, menor mas com raiz comum: **a superfície lia menos do que o núcleo
sabe.** O roster entregava um cargo por membro, o log parava no primeiro lote, e a aba de
moderação era gated por uma permissão que não é a única que abre suas consultas.

### 131.1 O defeito de raiz: o roster com um cargo só

`query.members` agrupa o roster pelo cargo de maior `rank` — é a linha "Membros" de §23.2, e
está certo. O que faltava era o membro carregar, junto, **todos** os cargos ativos dele. O
adaptador então gravava `roleIds: [cargo-do-grupo]`, e três coisas quebravam de uma vez:

1. `selectHasPermission` calculava a união de §9.2 sobre um cargo só. Quem tivesse
   "Veterano" no topo (sem permissão nenhuma) e "Moderação" embaixo era visto como só
   Veterano, e os botões Expulsar/Banir sumiam de alguém que os tem.
2. `member.setRoles` **substitui** o conjunto. Toda atribuição ou remoção mandava uma lista
   sem o cargo base — `E_BASE_ROLE_REQUIRED` (R-3), sempre, para todo mundo.
3. A lista "Membros (N)" do editor de cargos omitia quem tem o cargo como secundário.

A correção é do lado do fio: `query.members` passa a devolver `roleIds` por membro, em `rank`
DESC (§15.6, emenda). O núcleo já tinha o vínculo em mãos — ele é quem calcula o cargo do
grupo a partir dele.

**Um defeito a mais, encontrado ao verificar este.** `sincronizarMembros` pedia um lote de
100 e parava ali, ignorando `nextCursor`. Acima de 100 membros, quem ficasse de fora do lote
aparecia com `roleIds` vazio para os seletores — a mesma cegueira do achado principal, por
outro caminho, e agora com consequência maior, porque é `roleIds` que decide o que a tela
oferece. §8, 1.3 não pagina o painel de membros: o roster passa a ser lido até o fim.

### 131.2 Os defeitos de hierarquia e anti-escalada

Todos confirmados, todos do mesmo formato — o controle existia e nada conferia o estado que a
tela já tinha:

- **Atribuir cargo pelo popover de perfil** filtrava só `isFounder`. Cargo de `rank` igual ou
  superior ao do autor continuava na lista (`E_HIERARCHY`), e o cargo base também, que não se
  atribui nem se retira (R-3).
- **Editar e deletar cargo no `RoleEditor`** conferia `isFounder` para nome e cor, e mais
  nada. Cargo acima do autor era editável e deletável; `canDelete` era
  `!isFounder && !isDefault`, sem comparação de `rank` nenhuma.
- **Mencionabilidade e permissões do cargo Fundador** ficavam habilitadas mesmo com nome e cor
  desabilitados — `E_FOUNDER_IMMUTABLE` no envio.
- **O cargo base** renderizava as 17 permissões como caixas ativas, inclusive as 11 que R-11
  proíbe (`E_BASE_ROLE_RESTRICTED`). É o vetor que R-11 existe para fechar: o cargo base é o
  que **todo** membro presente, futuro e reingressante recebe.
- **Nenhuma caixa** era comparada com `efetiva(autor)`: qualquer um com `manage_roles`
  marcava permissão que não tem num cargo subordinado (R-5, `E_PERMISSION_ESCALATION`).
- **Reordenar** liberava arrasto e botões para tudo que não fosse Fundador — inclusive cargo
  acima do autor e o **cargo base**, que é o piso sentinela de §6.4.1 e não se move.
- **"Remover" na aba Membros** do editor não conferia nada: Fundador, host e alguém de
  hierarquia superior tinham o botão.
- **`selectCanModerate` não conferia o host corrente.** Só `isFounder`. Depois de uma sucessão
  (R-18), quem assume não carrega o cargo Fundador original: administradores acima dele viam
  Expulsar e Banir contra o próprio host (`E_HOST_IMMUNE`).

A correção não é uma checagem espalhada por componente: são dois seletores no
`communityStore` — `selectLocalTopPosition` (o `topRank(autor)` de §9.3) e
`selectCanActOnRole` (R-4 mais a imutabilidade do Fundador) — mais `selectLocalPermissions`
(a união de §9.2) para o checklist. `selectCanModerate` ganhou a conferência de
`hostPeerId`.

**A forma de "não oferecer" não é uma só.** Ação de moderação sem permissão **some** (§15 do
`frontend.md`). Mas a caixa de uma permissão dentro do checklist do cargo **fica visível e
inerte, com o motivo dito**: o checklist é o catálogo de §9.1, e sumir com onze das
dezessete faria a comunidade parecer ter menos permissões do que tem. O mesmo vale para o
cargo acima do seu, que continua legível — quem administra precisa ver o que ele concede.

Uma sutileza que o relatório não tinha e a correção precisou decidir: permissão **já salva**
no cargo continua desmarcável mesmo que o autor não a tenha. Retirar não é escalada, e travar
ali deixaria um cargo forte sem ninguém que pudesse enfraquecê-lo.

### 131.3 Os defeitos de leitura da aba de moderação

- **Os botões "Revogar banimento" e "Remover timeout"** eram desenhados para qualquer um que
  alcançasse a aba, isto é, para quem tem `view_audit_log` — que é permissão de **leitura**.
  §9.1 dá `mod.revokeBan` a `ban_members` e `mod.removeTimeout` a `timeout_members`.
- **E o inverso, que é a lacuna real:** quem tem `ban_members` e não tem `view_audit_log` não
  via a aba, embora `query.bans` já aceitasse `ban_members` desde sempre.
- **`sincronizarModeracao` tratava a permissão como UMA para as três consultas.** Com o
  carve-out de `bans`, um moderador com só `ban_members` recebia recusa em duas das três, a
  função concluía "todas negaram" e **apagava os bans que tinham respondido**.
- **O log parava em 50 entradas.** `api.auditLog({ limit: 50 })` sem cursor, e o "Carregar
  mais" paginava o array local. Ação além do primeiro lote era inalcançável na tela, embora
  estivesse no `fold` e §14 já pedisse lotes de 25 buscados na fonte.
- **O modal de ban omitia `L-7`.** §6.12 obriga a UI a dizer, **neste** modal, que o ban corta
  a replicação futura e **não** retira do alvo o que ele já replicou. O modal dizia só a nota
  sobre identidade nova.

### 131.4 O que o relatório errou

**Achado 11 — "ações de moderação sem diálogo de confirmação" (Revogar banimento / Remover
timeout).** Refutado. §15 do `frontend.md` tem a **lista fechada** das ações que exigem
confirmação, e nenhuma das duas está nela; a linha seguinte isenta nominalmente "remover
timeout", classificando-o como destrutivo **reversível dentro da própria sessão**. Revogar um
banimento é da mesma família: quem revogou por engano bane de novo. O relatório citou como
regra violada um comentário de código do `ModerationDialog`, que fala do **ban** — a ação
irreversível —, não das duas.

**Lacuna L3 — "`query.bans`/`query.timeouts` expõem `UserRef` vivo, sem rótulos congelados".**
Leitura errada do normativo. O congelamento de §6.13 é da `ModerationEntry`: a linha do
**log**, que é história e não pode mudar de nome depois. As tabelas `bans` e `timeouts` são
**estado corrente** e o schema de §15.6 declara `UserRef` de propósito. Não havia o que
corrigir — havia o que **escrever**, porque a spec nunca disse isso com todas as letras.

**Lacuna L2 — "ausência de menu de contexto de membro no painel de membros".** Meio termo. 1.3
lista só "clicar abre popover de perfil", então o painel não estava violando a própria seção.
Mas §6 sempre descreveu o menu de contexto como acionável "em mensagem, **membro**, canal,
comunidade", e o painel de membros era a única superfície de gente sem o gatilho. Ligado, com
1.3 emendada para dizê-lo.

### 131.5 As emendas normativas

`backend-v2.md`:

| # | Seção | O que passou a estar escrito |
|---|---|---|
| 1 | §20.3, regras 8 e 9 | A UI **não oferece** o que o `fold` já recusa por hierarquia ou anti-escalada, com a lista dos sete códigos previsíveis a partir do estado que a tela tem — e a regra 9, que a pré-checagem é affordance e **nunca** substitui a recusa recebida |
| 2 | §15.6, `query.members` | Cada membro carrega `roleIds` com todos os cargos ativos, `rank` DESC |
| 3 | §15.6, `query.timeouts` | Carve-out de `timeout_members`, simétrico ao de `ban_members` em `query.bans` — e o parágrafo de enforcement dizendo que **a permissão não é a mesma nas três** |
| 4 | §15.6 | Esclarecimento: `bans`/`timeouts` respondem `UserRef` **vivo**; o rótulo congelado de §6.13 é da `ModerationEntry` |
| 5 | §9.1 | `view_audit_log` não é a única porta de leitura de `bans` e `timeouts` |

`frontend.md`:

| # | Seção | O que passou a estar escrito |
|---|---|---|
| 6 | 3.1b | A aba Geral é de todo membro (o "Sair da comunidade" mora nela); a **seção de identidade** é de `manage_community` |
| 7 | 3.2 | O que o editor não oferece, item a item: cargo acima do seu, cargo Fundador, as 11 de R-11 no cargo base, permissão fora de `efetiva(autor)`, o cargo base imóvel, o "Remover" que some, o cargo base que nunca sai de `setRoles` |
| 8 | 3.3 | A aba abre para `view_audit_log`, `ban_members` **ou** `timeout_members`; cada sub-aba pela permissão da sua consulta; o botão da linha pela de **escrita** |
| 9 | 1.3 | Botão direito no painel de membros abre o menu de contexto de §6 |
| 10 | D12 | A nota de `L-7` é obrigatória no modal de ban, ao lado da de identidade nova |
| 11 | §14 | "Carregar mais" do log paga o lote seguinte **na fonte**; o filtro vale sobre o que já veio, e a tela diz isso |

### 131.6 O que foi medido

- `core`: `npm run build` (barreira de camadas), `npm run typecheck`, `npm test` — **1285**
  testes. Um novo em `test/moderacao-superficie.test.ts` (os carve-outs de `bans` e
  `timeouts`, com cargos reais do `fold` e a membresia encenada na porta de leitura, mesmo
  recorte da `intrusa` que já existia ali), mais a asserção de `roleIds` no roster.
- `frontend`: `npm run lint`, `npm run build`, `npm test` — **596** testes. Doze novos:
  `src/store/__testes__/hierarquia.test.ts` (imunidade do host pós-sucessão, união de §9.2,
  R-4 no limite do "estritamente menor", Fundador imutável),
  `src/live/__testes__/roster.test.ts` (todos os cargos no membro, o fallback para host
  antigo, o cursor seguido até o fim, a falha no meio que não deixa meia lista) e três casos
  novos em `moderacao.test.ts` (o moderador com só `ban_members`, a recusa de permissão que
  zera **a lista dela**, e o "Carregar mais" que busca com o cursor da página anterior).
- `app`: `npm run build`, `npm run typecheck` e **`smoke:voz`** — as doze afirmações passaram.
  Foi rodado porque a correção do roster encosta em `live/sincronizacao.ts`, que é gatilho
  declarado do smoke no `CLAUDE.md`, ainda que o caminho de mídia não tenha sido tocado.
- Uma correção foi verificada por **mutação** (remover a conferência de `hostPeerId` derruba o
  caso da sucessão em `hierarquia.test.ts`).

### 131.7 O que não foi medido

- **Nenhum componente desta fatia tem teste de render** — é o `B20` da lista, e continua
  aberto. As correções de `RoleEditor`, `RoleList`, `ModerationTab`,
  `ProfileModerationActions` e `CommunitySettings` estão cobertas pelos seletores que elas
  consultam e pelo build, não pelo JSX que as desenha. O que isso deixa sem rede é a **ligação**
  entre o seletor e o controle — um `disabled` esquecido num botão passa por tudo.
- **O menu de contexto no painel de membros** foi ligado e typechecado; não há harness de
  interação que o abra.
- **O caminho de recusa continua vivo e não foi exercitado de novo nesta fatia.** A regra 9 de
  §20.3 existe porque o espelho pode estar atrás do log: a tradução do erro nomeado segue nos
  componentes, como estava.

---

## 132. Varredura do frontend e da integração com o núcleo — 2026-09-06

Verificação do relatório consolidado de auditoria sobre o **renderer inteiro e sua
integração com o núcleo**: 13 achados (1 crítico, 6 altos, 4 médios, 2 baixos) e 4 "lacunas
de especificação". A regra é a de sempre — **cada achado é confirmado na fonte antes de
virar correção**. **Treze confirmados**, nenhum refutado; dois com o alcance exagerado, e o
exagero está registrado em §132.9. As quatro lacunas eram reais e fecharam por emenda.

O tema é um só, e ele atravessa o crítico e três dos altos: **o caminho existia e ninguém o
percorria.** Não são funcionalidades ausentes — são funcionalidades escritas, testadas em
isolamento, e **desconectadas do produto**:

- `assinarDeepLinks()` estava definida, tinha teste, e nenhum arquivo em produção a chamava.
  O main parseava, o preload despachava, e o renderer nunca ouvia.
- O ramo `preview.status === "unreachable"` na prévia de convite estava escrito, com o texto
  que U-03 exige e o botão de tentar de novo, e era **inalcançável por construção**: a
  composição recusava com `E_HOST_UNAVAILABLE` em vez de devolver o desfecho 6 de §12.3.
- O `HostExitListener` tinha sido movido para a raiz em §92, com o comentário explicando por
  quê — e continuava **dentro** do `Sincronizador`, que não renderiza os filhos enquanto o
  núcleo sobe. O defeito que a mudança devia fechar continuava aberto pelo mesmo motivo.
- O store de deep link guardava a prévia do convite resolvida por `invite.resolve` e nenhum
  componente a lia: um segundo caminho para o mesmo desfecho, sem superfície.

E um segundo tema, com raiz comum: **a UI afirmava números que não tinha.** O impacto de
saída do host inventava `pendingReplication: 0` quando a leitura falhava — a frase
tranquilizadora exatamente no caso em que §18.7 existe —, e o `inCallCount` do núcleo contava
canais chamando-os de pessoas.

### 132.1 O crítico: o deep link que não chegava a lugar nenhum

`app/src/main/index.ts` parseia (`parseDeepLink`), enfileira e entrega ao `webContents`; o
preload converte em evento de janela. Do outro lado, `frontend/src/live/deeplink.ts`
exportava `assinarDeepLinks()`, que registra a escuta — e a busca textual em `frontend/src`
não achava chamada nenhuma. Todo `comunidadep2p://…` com o app aberto era descartado em
silêncio.

O teste de unidade passava porque chamava `receber()` direto, que é **o degrau depois do que
faltava**. É a forma de cobertura que engana: exercita a função e não a ligação dela.

E, mesmo registrada, a escuta teria efeito parcial: das três fatias do store, só `contato`
(a rota `u/`) tinha consumidor — `DmDestino`. As fatias `convite` e `mensagem` não eram
lidas por componente nenhum.

Três correções, e a terceira é a que evita a repetição:

1. `App` assina no efeito de montagem, **acima** do `Sincronizador` — um link pode chegar
   enquanto o núcleo conecta.
2. A rota `join` deixou de ter caminho próprio: ela guarda o convite pendente de §11 A2 e
   abre a prévia de 0.3, que é a mesma tela do código colado à mão, com os seis desfechos de
   §12.3 já implementados. A fatia `convite` do store saiu.
3. A rota `m/` ganhou `DeepLinkMensagem`, que desenha os cinco desfechos de §15.6 — e
   **espera o núcleo** antes de resolver, porque `query.resolveMessageLink` sem sessão é
   `E_NO_PORT`, que o catch transformava em `malformed`: a tela de "link alterado" para um
   link bom que chegou cedo demais.

A lacuna 4 do relatório fechou por emenda em **§3.5**: a regra 2 fixou o contrato
main→renderer e a regra 3 fixou o que o link pode fazer, e nenhuma das duas dizia **onde** o
link chega. A emenda traz a tabela rota → superfície, e três regras: uma superfície por rota
e sempre uma já existente; a escuta acima do guarda de conexão; e a rota `join` também troca
de destino, pela regra 3 emendada ("posicionar inclui chegar lá").

### 132.2 O `smoke:deeplink` que passava com o produto surdo

O smoke existente valida a **gramática** de §3.5 contra `dist/main/deeplink.js`: 16 casos,
todos corretos, todos passando — enquanto o link não fazia nada. A gramática nunca foi o
defeito.

A segunda parte que ele ganhou é a pergunta que importa: preload real, bundle real do
renderer (`frontend/dist`), o main enviando `deeplink` e a checagem de que **algo mudou do
outro lado**. O observável é o convite pendente de §11 A2, que o store persiste — se está no
`localStorage` depois do evento, a escuta foi registrada, `receber` correu e a rota `join`
posicionou a prévia.

Verificado por **mutação**: comentar a linha `useEffect(() => assinarDeepLinks(), [])` em
`App.tsx` faz o smoke reprovar com `PENDENTE=null`. É a mesma classe de verificação que
§92 pediu para o ciclo de fechamento, e pelo mesmo motivo — este defeito é invisível para
teste de unidade por definição.

### 132.3 A prévia de convite: três defeitos numa tela

**O desfecho 6 era recusa (achado 10, lacuna 3).** §12.3 numera seis desfechos e diz que o
sexto é "decidido pelo cliente"; §12.5 o lista ao lado de `invalid` na tabela do que vaza.
`AdmissionService.resolve` devolvia `{ ok: false, code: 'E_HOST_UNAVAILABLE' }` quando não
conseguia abrir o canal pré-membro, e a fronteira transformava isso em promessa rejeitada.
Emenda em **§12.3**: `invite.resolve` devolve o desfecho; `invite.redeem` continua recusando
(escrita que não aconteceu é recusa, e a coluna de §15.4 já mapeava). `E_MALFORMED` e
`E_NO_IDENTITY` continuam recusa dos dois — não são resposta do host sobre o convite, são
condições anteriores a haver pergunta. O desfecho **não** é memorizado na sessão, que é o que
faz o botão "Tentar novamente" de U-03 significar alguma coisa.

**E isso fecha `B13`.** O item pedia exatamente esta troca — "desfecho certo seria
`unreachable`, não `E_TIMEOUT`" — e o que faltava era o aval normativo. Ele fecha inteiro
porque o prazo já cabe: as três rodadas de descoberta de §12.3 somam 24 s (o corte de quatro
para três foi feito por esta razão), então o núcleo responde `unreachable` **antes** dos 30 s
que o IPC-R dá a `resolve`. O `E_TIMEOUT` que chegava à tela era o teto do renderer vencendo
uma corrida que o núcleo agora ganha com folga.

**A tela ficava presa 30 s (achado 4, lacuna 1).** `guardClose={() => !entrando}` bloqueava
`Esc`, clique fora e o X; `cancelDisabled={entrando}` desabilitava cancelar. Com o host
inalcançável, meio minuto de spinner sem saída.

A lacuna perguntava se `invite.redeem` deveria expor `AbortSignal`. A resposta, na emenda de
**§16.1**, é que **não há o que cancelar**: o resgate é decidido no log do host (§12.4 passo
4, dentro da seção crítica de §11.4), e nenhum sinal do candidato desfaz um `member.join` já
aplicado — um `AbortSignal` que só encerrasse a espera local prometeria um cancelamento que
não existe. O que a UI passa a dever: sair da espera é sempre possível; sair abandona a
espera e não o comando; se o resgate completar, a participação chega pelo resync de §15.5; e
a tela **diz isso**, senão o botão de cancelar parece uma promessa de desfazer.

**O erro cru por cima da prévia velha (achado 9).** Convite que expira ou esgota entre a
prévia e o clique produzia `Não foi possível entrar (E_INVITE_INVALID)` — o código de §20 na
tela — mantendo o preview antigo e o botão "Entrar" ativo sobre um convite morto. A coluna de
§15.4 mapeia desfecho → código na ida; `desfechoDaRecusa` é a volta, e leva a tela ao
desfecho de §12.3 que descreve o que aconteceu. `E_VALIDATION` e o resto de §20 continuam
recusa nomeada, porque não são desfechos de convite.

### 132.4 O código de convite que a interface corrompia

`normalizeInviteCode` em `frontend/src/mocks/dataset.ts` era uma segunda implementação da
gramática de §12.1, divergente da do núcleo em quatro pontos: casava só `invite/…` (o deep
link nativo caía num fallback que só removia pontuação, produzindo
`comunidadep2pjoinX7K2…`), não aplicava caixa, não aplicava os aliases Crockford (`I`/`L`→1,
`O`→0) e não validava comprimento nem alfabeto — devolvia string em todo caso.

Passou a ser a mesma normalização de `core/src/l2/invites`: tudo depois da última `/`, `-` e
espaço ignorados, caixa alta, aliases, e então comprimento e alfabeto conferidos. E devolve
`string | null`, o que fecha o achado 13 junto: `setPendingInvite` mapeava a normalização
vazia para `null` e a rota navegava para `/` sem aviso — um link truncado virava onboarding
comum, sem nada dizendo que havia um convite. O store passa a distinguir "não havia link" de
"o link não servia", e a prévia abre no desfecho `invalid`.

### 132.5 A saída do host: decidir sobre o que não se sabe

Três defeitos encadeados (achado 7), mais dois de contagem (5 e 8) e um de estado (12).

**A decisão vinha de uma leitura que podia nunca ter acontecido.** `useImpactoDoNucleo`
começava com o mapa vazio, e `HostExitListener` auto-confirmava a saída quando
`impact.length === 0` — fechar o app no boot, com a comunidade cheia, não perguntava nada.
Agora o pedido do main dispara `host.exitImpact` e **espera por ele**, com prazo de 2,5 s
dentro dos 10 s do main.

**Zero era inventado.** `pendingReplication` vinha com `?? 0`. Zero é uma afirmação sobre o
disco dos outros; sem resposta do núcleo não há como fazê-la. Passou a ser `null`, e impacto
não medido **entra** na lista — é o caso de não poder dizer que não há.

**Ouvinte e shell liam cópias diferentes.** Duas chamadas de `useHostedImpact()` criavam dois
mapas e dois `setInterval` de 3 s independentes; o shell só renderizava o diálogo se a
**cópia dele** fosse não-vazia, então dava para o main receber "vou perguntar" e nada
aparecer, até o prazo vencer sozinho. Virou store único com sondagem por contagem de
observadores, e **quem responde ao main é quem desenha**: o diálogo saiu de `ShellOverlays`
e mora no `HostExitListener`.

**`inCallCount` contava canais.** `voice.sessionCount` é o tamanho do mapa de sessões: oito
pessoas no mesmo canal viravam "1 em chamada", e o host sozinho num canal também. Agora é
`participantCount(selfKeyHex)` — pessoas distintas, deduplicadas entre sessões, sem quem
está fechando.

**E o aviso descartava o que estava aberto.** `openHostExit` escrevia no slot único de
`overlay`: abrir o aviso apagava a criação de comunidade ou o editor de cargos junto com o
que não tinha sido salvo, e cancelar não os trazia de volta. Um pedido do main não é
navegação da pessoa — saiu do `overlay`.

A lacuna 2 fechou por emenda em **§18.7**: a tabela do que cada campo conta, a regra de que
`host.exitImpact` mede o efeito sobre **os outros** (quem pergunta nunca entra na conta), e
as três regras sobre a ausência de resposta — não medido ≠ zero, auto-confirmar exige
leitura completa, e quem decide e quem desenha leem a mesma coisa.

### 132.6 O `HostExitListener` que continuava dentro do guarda

§92 moveu o ouvinte para a raiz e escreveu por quê: fechar a janela numa tela anterior ao
shell não pode custar os 10 s de prazo do main. A montagem ficou em `App.tsx` — como
**filha** do `Sincronizador`, que não renderiza os filhos em `inicial`, `conectando`,
`falhou` e `sem-shell`. Fechar a janela durante a conexão continuava custando os dez
segundos inteiros, com o comentário na tela do código explicando que não deveria.

A montagem passou a ser **irmã** do `Sincronizador`, junto com `DeepLinkMensagem` e o
`ToastViewport`. O `smoke:fechamento` continua verde nos três cenários.

### 132.7 A unidade em que a interface conta caracteres

`OnboardingScreen` validava com `trimmed.length` e limitava com `maxLength={32}` no DOM. Os
dois são **unidade UTF-16**; §8.6 conta **code points**, depois de `trim` + colapso de espaço
interno + NFKC. Os dois extremos do mesmo campo:

- um emoji sozinho tem `length === 2` e um code point: a tela aceitava, o núcleo recusava com
  `E_VALIDATION` — e o erro inline de §8.7 existe exatamente para isso não acontecer;
- vinte emojis têm 40 unidades UTF-16 e vinte code points: o `maxLength` travava a digitação
  de um nome válido, e travava no meio de um par substituto.

§8.6 permite contador **grafêmico** e o chama de advisório. A emenda de **§8.7** separa as
duas coisas: advisório é o veredito (pode divergir por estar atrás do host, e divergir assim
é inofensivo), não a **unidade** — grafema nunca é mais permissivo que o log, UTF-16 é mais
permissivo na entrada e mais frouxo na saída ao mesmo tempo. Três regras normativas: teto em
code points (ou grafemas), nunca via `maxLength`; corte que respeita o code point; e
validação sobre o texto **normalizado**.

`TextField` ganhou `limiteCp`, que conta e clampa em code points e substitui o `maxLength` do
DOM. Aplicado aos três campos de nome de pessoa (onboarding, identidade da conta, apelido na
comunidade). Os campos de nome de comunidade, canal e cargo continuam com `maxLength` — a
mesma divergência existe neles, e está registrada em §132.10.

### 132.8 O convite pendente que reabria para sempre

`handleClose` limpava o convite pendente, mas fechar a **janela** com a prévia aberta deixava
o código no `localStorage`: a inicialização seguinte reabria o mesmo convite por cima do que
a pessoa fosse fazer — inclusive um convite já inválido, indefinidamente. O convite passa a
ser consumido **quando a tela abre**, que é quando ele deixa de ser pendente; o código já
está no estado local do componente.

E `usePendingInviteOverlay` passou a `useLayoutEffect`: com o efeito comum, o shell pintava
um quadro inteiro antes de o modal existir, e quem chegava por convite sem nenhuma comunidade
via o Hub vazio piscar antes da prévia.

### 132.9 Onde o relatório exagerou

Dois achados descrevem o mecanismo certo com alcance maior do que o código sustenta. Ficam
registrados porque a diferença importa para quem for reler o relatório:

- **Achado 2 — a truncagem por espaço.** O texto atribui a `normalizeInviteCode` um
  `split(/\s+/)[0]` que "trunca silenciosamente códigos com espaços acidentais". Essa linha
  não existe no código auditado; espaço já era removido junto com `-`. A corrupção do deep
  link nativo, essa sim, era real, e é o que foi corrigido.
- **Achado 11 — o convite que reabre.** O texto diz que `pendingInviteCode` "só é limpo ao
  clicar em Cancelar". `handleClose` era chamado também por `Esc`, clique fora e pela
  navegação de sucesso — o que sobrevivia era o fechamento da **janela**, que é um caminho
  que não passa por `handleClose` nenhum. O defeito é o mesmo; a descrição não.

### 132.10 O que não foi medido, e o que ficou aberto

- **Nenhum componente desta fatia tem teste de render** — é o `B20`, e continua aberto. As
  correções de `JoinCommunityOverlay`, `HostExitGuard`, `DeepLinkMensagem` e `TextField` estão
  cobertas pelas funções puras que elas consomem (`montarImpacto`, `normalizeInviteCode`,
  `codePointsNormalizados`, `desfechoDaRecusa` via build) e pelo `smoke:deeplink`, não pelo
  JSX. O que fica sem rede é a ligação entre a função e o controle.
- **A unidade de contagem foi corrigida só nos campos de nome de pessoa.** `Community.name`,
  `Community.description`, `Channel.name`, `Channel.topic`, `Role.name` e `reason` continuam
  com `maxLength` do DOM, que é UTF-16 — a mesma divergência do §132.7, no mesmo produto. A
  emenda de §8.7 vale para todos; a correção parou onde o relatório apontou.
- **O link interno de mensagem não casa a gramática de §3.5.** `MessageActions` copia
  `p2p.app/m/<base64url do JSON>` e o handler de deep link só aceita
  `comunidadep2p://m/<MSGREF de 86 chars>`, que é `communityId(32) ‖ opId(32)` decidido pelo
  núcleo. São dois formatos, e o produto não consegue abrir o link que ele mesmo copia por
  fora do app. Não estava no relatório e **não foi corrigido nesta fatia** — exige o núcleo
  expor o MSGREF de uma mensagem, que é decisão de contrato, não de renderer. Virou **B77**
  no backlog.
- **O prazo de 2,5 s da leitura de impacto não foi medido sob carga.** Ele é folgado contra
  os 10 s do main e apertado o bastante para não gastá-los; a escolha é de projeto, não de
  medição.

### 132.11 Validação

- `core`: `npm run build` (barreira de camadas), `npm run typecheck`, `npm test` — **1292**
  testes. Sete novos: `test/convite-inalcancavel.test.ts` (o desfecho 6 como resposta de
  `resolve` e como recusa de `redeem`, mais `E_MALFORMED` continuando recusa) e três casos em
  `test/voice-host.test.ts` (duas pessoas num canal são duas, quem pergunta não se conta, e
  duas sessões sem contar ninguém duas vezes).
- `frontend`: `npm run lint`, `npm run build`, `npm test` — **623** testes. Vinte e um novos:
  `convite-codigo.test.ts` (a gramática de §12.1 na interface, incluindo o deep link nativo
  que virava lixo de 33 caracteres), `nome-de-exibicao.test.ts` (a unidade de §8.6 nos dois
  extremos, e o corte que não parte par substituto), `saida-do-host.test.ts` (não medido ≠
  zero, e impacto não medido entrando na lista) e seis casos novos em `deeplink.test.ts` —
  entre eles o que faltava: **`assinarDeepLinks` registra a escuta**, e desfazê-la a remove.
- `app`: `npm run build`, `npm run typecheck`, **`smoke:fechamento`** (as sete afirmações dos três cenários) e
  **`smoke:deeplink`** (16 casos de gramática + a parte de ponta a ponta).
- Uma correção foi verificada por **mutação**: comentar `assinarDeepLinks()` em `App.tsx`
  derruba o `smoke:deeplink` com `PENDENTE=null`, e só ele — a suíte de unidade continua
  verde, que é precisamente por que ela não pegou o defeito original.
