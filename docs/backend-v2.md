# Especificação Técnica do Backend — Comunidade P2P — **v2**

> **Status normativo:** esta é a **única** fonte de verdade para a arquitetura e para a
> implementação do backend. Ela **substitui integralmente** `docs/backend.md` (v1), que
> passa a ser documento histórico.
>
> **Data:** 2026-08-17 · **Versão de protocolo:** `opVersion = 3` (emenda de 2026-09-04, que
> removeu `R-14`/`ATTACHMENT_QUOTA_PER_MEMBER` — §13.8; `opVersion = 2` foi a emenda pós-G4 e
> `opVersion = 1` o protocolo experimental anterior, sem migração de dado de produto)
>
> **Origem:** reescrita completa motivada pelo parecer `NOT APPROVED` do Architecture
> Review Board (`parecer-consolidado-do-architecture-review-board.md`) e pelos blockers
> B1–B10 lá consolidados. A disposição individual de cada um dos 195 achados
> (`F-01..F-50`, `DS-01..DS-31`, `DR-01..DR-51`, `T-01..T-48`, `RT-01..RT-15`) está em
> `docs/resolucao-arquitetural-v2.md`.
>
> **Documentos que acompanham este:**
>
> | Documento | Papel |
> |---|---|
> | `docs/adr-v2.md` | Registro de decisões arquiteturais v2 (ADR-A01..A29), com o mapa de substituição das ADR-01..20 de v1 |
> | `docs/plano-de-validacao-experimental-v2.md` | PoCs e benchmarks obrigatórios, com hipótese, critério de aprovação e consequência objetiva de falha |
> | `docs/deltas-ux-v2.md` | Mudanças de produto/UX exigidas por esta arquitetura, e a resolução dos 117 comportamentos da matriz de rastreabilidade |
> | `docs/resolucao-arquitetural-v2.md` | O que mudou, o que foi resolvido, o que virou risco aceito, o que continua `REQUIRES POC`, e o veredito final |
>
> **Regra de leitura:** onde este documento e qualquer outro discordarem, este vence para
> backend. Onde este documento for **omisso**, isso é buraco desta spec e deve ser
> levantado — **o implementador não decide arquitetura, contrato, consistência, segurança
> ou regra de negócio por conta própria.** Onde este documento marcar `REQUIRES POC`, a
> parte dependente **não pode ser implementada** antes do gate correspondente passar.

---

## 0. Como usar este documento

### 0.1 Escopo

Cobre tudo que roda fora do renderer React: o processo núcleo P2P, o log replicado, a
interpretação determinística desse log, a projeção local, o RPC entre pares, o transporte
de mídia, os jobs, a observabilidade e a configuração. Não cobre componentes de interface
— esses estão em `docs/frontend.md`, corrigido pelos deltas de `docs/deltas-ux-v2.md`.

### 0.2 Precedência entre documentos (v2)

1. **Este documento** — dado, regra, contrato, consistência, erro, segurança de backend.
2. **`docs/adr-v2.md`** — justificativa e status de cada decisão; se uma ADR e este
   documento discordarem no *conteúdo* da decisão, este documento vence e a ADR é bug.
3. **`docs/deltas-ux-v2.md`** — produto/UX, onde altera `docs/frontend.md`.
4. **`docs/frontend.md`** — produto/UX no que os deltas não tocam.
5. **`CLAUDE.md`** — intenção de produto.
6. **O código do frontend** — registro do que já foi validado na prática, **não** contrato.

`docs/backend.md` (v1) e as cinco auditorias são **história**. Não têm precedência nenhuma
e não devem ser citados como contrato.

### 0.3 O que "API" significa aqui

Não existe HTTP, servidor, porta escutando em `localhost` nem REST. Existem **três**
superfícies de chamada:

| Superfície | Quem chama | Quem atende | Transporte | Seção |
|---|---|---|---|---|
| **IPC-R** | renderer (React) | núcleo P2P | `MessagePort` sobre `MessageChannelMain` | §15 |
| **IPC-M** | Electron main ↔ núcleo | mútuo | `MessagePort` privado, **nunca compartilhado com o renderer** | §3.2 |
| **RPC P2P** | núcleo de um par | núcleo de outro par | `protomux-rpc` sobre stream Hyperswarm | §16 |

### 0.4 Convenções

| Convenção | Regra |
|---|---|
| Identificadores de entidade | `string` ASCII; formato fechado em §7.3. Chaves públicas são `bytes[32]`; no IPC viram hex minúsculo de 64 caracteres. |
| Tempo | epoch em **milissegundos UTC** (`uint64`). Nunca string, nunca fuso. |
| Tamanhos | bytes; base 1000 na apresentação, base 1024 nunca aparece na UI. |
| Nomes de campo | `camelCase` em IPC/RPC; `snake_case` em SQLite. O tradutor é o módulo `projector`. |
| Nomes de comando | `dominio.acao` (`message.send`). Nomes de evento: `dominio.fato` no passado. |
| Ausência | `undefined` nunca cruza fronteira. Campo opcional ausente é **omitido**; `null` significa "explicitamente vazio". |
| Ordenação canônica | `seq` do registro no log da comunidade (§7). Nenhum outro critério é canônico. |
| Texto | UTF-8. Limites em **bytes UTF-8**, salvo onde a tabela disser "code points" — escalares Unicode, nunca grafemas (§8.6). |
| `REQUIRES POC` | A decisão está tomada e escrita, mas **não pode ser implementada** antes do gate citado passar. |
| `LIMITAÇÃO DECLARADA` | Propriedade que o sistema **não** entrega, registrada aqui e obrigatoriamente comunicada na UI. |

---

## 1. O modelo arquitetural

Esta seção é a mudança conceitual de v1 para v2. Tudo no resto do documento decorre dela.
Ler primeiro.

### 1.1 O erro central de v1

Em v1, três coisas diferentes ocupavam o mesmo lugar sem contrato entre si:

- **Autoridade** (quem decide o que entra) — o host.
- **Validação** (o que é aceitável) — um pipeline que lia a projeção SQLite.
- **Interpretação** (o que o log significa) — reducers que podiam lançar exceção.

A projeção era assíncrona e em lote, então a validação decidia contra um estado atrasado; o
reducer, que recebia o resultado, podia lançar; e lançar parava a comunidade **em toda
réplica, deterministicamente e para sempre**. Uma corrida legítima entre `channel.delete` e
`message.send` — duas ações comuns — bastava para destruir a comunidade. Ao mesmo tempo, a
réplica só verificava assinatura: qualquer coisa que o host appendasse virava verdade,
inclusive envelope transplantado de outra comunidade.

### 1.2 A decisão de v2: Interpretação Determinística do Log (DLI)

> **O estado de uma comunidade é, por definição, `fold(log)`: uma função pura, total e
> determinística sobre a sequência de registros do log daquela comunidade.**
>
> **Toda** regra de autorização, hierarquia, associação, limite, cota, unicidade e
> integridade vive **dentro** dessa função. Não existe regra fora dela.

Consequências, todas normativas:

| Propriedade | Como decorre |
|---|---|
| **O host não é a fonte da verdade; ele é a fonte da ordem.** | O host escolhe *quais* registros entram e *em que ordem*. O que cada registro *significa* é decidido pela função, igual em todo nó. |
| **O host não consegue fabricar efeito não autorizado.** | Se o host appendar um registro que a função rejeita, a função rejeita em toda réplica — inclusive na dele. O ataque vira ruído contado no `seq`. |
| **Não existe registro venenoso.** | A função é **total**: definida para toda entrada, inclusive bytes hostis, `kind` desconhecido, referência a entidade inexistente. Ela nunca lança, nunca para. §8.5. |
| **Réplicas nunca divergem.** | Mesma entrada, mesma função, mesma saída. Divergência só é possível por bug, e o teste de §28.4 a detecta por hash de dump. |
| **A projeção SQLite é de fato descartável.** | Ela é a materialização de `fold(log)`. Apagar e refazer produz o mesmo byte. §10.5. |
| **A corrida validação↔projeção deixa de existir.** | A validação do host roda contra o **Estado de Decisão** em memória, avançado no mesmo ponto crítico do append. A projeção é consumidora pura, nunca consultada por decisão. §8.2. |

### 1.3 As três classes de estado (fronteira inviolável)

| Classe | Onde vive | Quem escreve | Sobrevive a | Exemplos |
|---|---|---|---|---|
| **Estado de Decisão** (`DS`) | memória de todo nó, com snapshot em `view.db` | só o `fold` | reprojeção (é recomputado) | membros, cargos, permissões efetivas, metadados de canal, bans, timeouts, contadores de convite, `lastAuthorSeq`, cotas |
| **Estado de Conteúdo** (`CS`) | `view.db` (SQLite + FTS5) | só o `projector`, aplicando os efeitos que o `fold` emitiu | reprojeção (é recomputado) | mensagens, reações, anexos, log de auditoria, threads, links |
| **Estado Local** (`LS`) | `manifest.db` (SQLite, `synchronous=FULL`) | módulos locais | **tudo**, inclusive reprojeção e mudança de schema de `view.db` | participação em comunidades, sementes/chaves, outbox, não-lidas, preferências, consentimentos, cache de blobs, contador `authorSeq` |

**Regras que o build precisa garantir (lint de fronteira por diretório):**

1. O `fold` **nunca** lê `view.db` nem `manifest.db`. Ele recebe `DS` como argumento.
2. O `fold` **nunca** lê configuração de ambiente. Ver §1.5.
3. Nenhum módulo além do `projector` escreve em tabela de `CS`.
4. Nenhuma decisão de autorização, unicidade ou limite acontece fora do `fold`.
5. `manifest.db` e `view.db` são **arquivos separados**, com PRAGMAs separados (§10.4).

Confundir as três classes é o erro mais caro possível neste projeto. `muted` de canal é
`LS`; `readOnlyForRoleIds` do mesmo canal é `DS`; o texto da mensagem é `CS`.

### 1.4 O que o host pode e o que não pode (v2)

| O host **pode** | O host **não pode** |
|---|---|
| Omitir uma op que recebeu (censura por omissão) | Fabricar autoria: a assinatura do autor é verificada por toda réplica |
| Escolher a ordem de append | Fazer valer um efeito que o `fold` rejeita |
| Carimbar `hostTs` | Carimbar `hostTs` retroativo abaixo do registro anterior (o `fold` clampa, §8.3) |
| Truncar o próprio core (detectável) | Transplantar envelope de outra comunidade (o `communityId` está dentro do material assinado, §7.1) |
| Recusar conexão e aplicar rate limit | Silenciar seletivamente sem que o cliente perceba: `E_RATE_LIMITED` e `E_HOST_UNAVAILABLE` são estados distintos e visíveis (§20, delta de UX) |

**LIMITAÇÃO DECLARADA (L-1):** censura por omissão e truncamento são **detectáveis, não
impedíveis**. §25.6 define a detecção e a superfície de UI.

### 1.5 Constantes de protocolo × configuração operacional

Em v1, limites usados na validação estavam em variáveis de ambiente. Isso tornava a
interpretação do log função do ambiente local — duas réplicas com configuração diferente
divergiriam. v2 separa:

| Categoria | Regra |
|---|---|
| **Constantes de protocolo** (§27.1) | Fazem parte de `opVersion`. **Fixas no binário**, não configuráveis por env, arquivo ou flag. Mudar qualquer uma exige bump de `opVersion`. Toda entrada do `fold` sai daqui. |
| **Configuração operacional** (§27.2) | Local, sem efeito nenhum sobre a interpretação do log. Caminhos, verbosidade, tetos de recurso local, janelas de retry, orçamentos de conexão. |

**Nenhum valor pode estar nas duas listas.** Se um número influencia se uma op tem efeito,
ele é constante de protocolo. Fim da discussão.

---

## 2. Decisões de arquitetura

O registro completo, com contexto, alternativas descartadas, status e mapa de substituição
das ADRs de v1, está em **`docs/adr-v2.md`**. Resumo de uma linha por decisão, para
orientação:

| # | Decisão | Status |
|---|---|---|
| **A01** | Um Hypercore por comunidade, appendado só pelo host; o host dá **ordem**, não verdade | Aceita |
| **A02** | **Interpretação Determinística do Log (DLI)**: estado = `fold(log)`, função pura e total, com autorização dentro | Aceita — é a decisão-raiz de v2 |
| **A03** | **Dois bancos**: `manifest.db` (`FULL`, autoritativo local, nunca descartável) e `view.db` (`NORMAL`, derivado, descartável) | Aceita |
| **A04** | Estado de Decisão em memória, avançado no mesmo ponto crítico do append; projeção é consumidora pura | Aceita |
| **A05** | Idempotência por `(author, sequenceScope, authorSeq)` monotônico assinado — sem janela de dedupe | Aceita, emendada pós-G4 |
| **A06** | Barreira de durabilidade: ACK só depois de o append estar commitado (§10.7.1); outbox só libera ao **observar a própria réplica** | Aceita |
| **A07** | `communityId` dentro do material assinado; `hostTs`/`flags` num `HostRecord` assinado pelo host | Aceita |
| **A08** | Convite = par de chaves derivado do segredo; o host valida com a **chave pública** que está no log | Aceita |
| **A09** | Anexos em **core de blobs por autor**, anunciado no log | Aceita |
| **A10** | Ordenação de cargos por **chave fracionária esparsa**, sem renumeração | Aceita |
| **A11** | `reaction.set{present}` idempotente no lugar de `reaction.toggle` | Aceita |
| **A12** | Autorização de replicação por comunidade: replicar exige ser membro não banido | Aceita |
| **A13** | Fronteira da chave: geração e assinatura **só no núcleo**; `safeStorage` como oráculo de wrap/unwrap | Aceita |
| **A14** | IPC com `epoch`, `subId`, `evSeq`, ack de janela, resync e classes de autorização de comando | Aceita |
| **A15** | Caminho de anexo por **ticket emitido pelo main** após diálogo do SO; renderer nunca fornece caminho | Aceita |
| **A16** | Electron + `utilityProcess` + `better-sqlite3`, com matriz de plataforma **fechada** e rebuild por alvo obrigatório | Aceita, **condicionada a G0** |
| **A17** | Voz e câmera: WebRTC no renderer, com **STUN/TURN servidos pelo host da comunidade** | Aceita, **REQUIRES POC** (G7/G8) |
| **A18** | ADR-06/07 de v1 (candidato ICE via DHT; UDX como fallback de voz) **revogadas** | Revogada |
| **A19** | Compartilhamento de tela no v1 é **estrela WebRTC** | Aceita — o teto de 8 espectadores saiu em 2026-08-26 (§90); a topologia, que é o que A19 sustenta, continua |
| **A20** | Árvore de multicast de tela **especificada e adiada** para além do v1, bloqueada por POC-09 | Adiada, **REQUIRES POC** |
| **A21** | Relay voluntário retransmite **TURN/SRTP opaco**, com prova de posse, TTL e cota | Aceita, **REQUIRES POC** |
| **A22** | Autorização de mídia por **ticket assinado pelo host**; ban/kick revogam tickets | Aceita |
| **A23** | Sucessão de host por **escrow de semente + migração para core novo** | Aceita |
| **A24** | Backup/exportação de identidade protegida por frase secreta | Aceita — **muda a premissa 3 da UX** |
| **A25** | Toda operação de domínio de mensagem é **assíncrona por contrato** (outbox); estrutura/moderação é síncrona e não enfileira | Aceita — **muda o eixo otimista da UX** |
| **A26** | Tombstone continua sendo a semântica de deleção | Aceita (herda ADR-10) |
| **A27** | Presença/digitando efêmeros, com agregação e assinatura por interesse | Aceita, **BENCHMARK REQUIRED** |
| **A28** | Não-lidas e menções calculadas localmente, por watermark, com estado por canal **e por thread** | Aceita |
| **A29** | **Conversa direta** entre identidades = par de logs de escritor único, sem host e sem outbox (§31) | Aceita, **REQUIRES POC** (G14) — **fase 11 do v1** |

---

## 3. Topologia de execução e fronteiras

### 3.1 Processos e canais

```
┌─ Electron main ───────────────────────────────────────────────────────┐
│ janela · ciclo de vida · deep links (parse + validação, §3.5)         │
│ safeStorage (wrap/unwrap do Data Key, §5.4)                           │
│ dialog.showOpenDialog → emite ticket de anexo (§13.3)                 │
│ setDisplayMediaRequestHandler (só depois de autorização do host, §17) │
│ shell.openPath (só com allowlist de tipo, §13.6)                      │
│ confirmação nativa para comandos destrutivos (§15.3)                  │
│ cria os DOIS MessageChannelMain e cruza as portas                     │
└───────┬──────────────────────────────────────┬────────────────────────┘
        │ IPC-M (privado, nunca ao renderer)   │ (só entrega a porta)
┌───────▼──────────────────────────┐  ┌────────▼───────────────────────┐
│  NÚCLEO P2P (utilityProcess)     │  │ RENDERER (React, sandbox)      │
│  identity (Ed25519) · fold       │◀▶│  WebRTC (voz/câmera/tela)      │
│  corestore · hypercore · swarm   │  │  stores Zustand → cliente IPC  │
│  hyperblobs (próprio + de pares) │  │  captura, codec, decode        │
│  protomux(-rpc) · udx            │  │                                │
│  better-sqlite3 × 2 (manifest,   │  │                                │
│  view+FTS5) · outbox · projector │  │                                │
│  STUN/TURN comunitário (§17.3)   │  │                                │
└──────────────────────────────────┘  └────────────────────────────────┘
                    ▲  IPC-R (MessagePort direto)  ▲
                    └──────────────────────────────┘
```

**Por que o main não fica no meio do IPC-R:** custo de duas cópias e um salto de event loop
no processo que desenha a janela. O main cria os canais e sai do caminho de dado.

**Por que existe um IPC-M separado:** o canal main↔núcleo carrega material sensível (Data
Key, tickets de anexo, tokens de confirmação). Ele **nunca** é transferido ao renderer e
**nunca** transporta payload de domínio.

### 3.2 Fronteira da chave privada — declaração honesta

v1 afirmava "a chave privada nunca cruza o IPC" e ao mesmo tempo exigia que o main a
decifrasse. As duas coisas não cabem juntas. v2 decide e declara:

1. **A chave privada de identidade é gerada dentro do núcleo** e nunca sai dele em claro,
   exceto no passo 3 abaixo, na direção oposta.
2. O núcleo cifra a chave com uma **Data Key** simétrica de 32 bytes (XChaCha20-Poly1305).
3. A **Data Key** — e só ela — atravessa o IPC-M para ser embrulhada/desembrulhada por
   `safeStorage` no main. `safeStorage.encryptString(base64(dataKey))` no primeiro boot;
   `decryptString` nos seguintes. O main **nunca** vê a chave de identidade.
4. Os dois lados zeram o `Buffer` da Data Key (`buf.fill(0)`) imediatamente após o uso, e
   no shutdown.
5. **Nenhum comando IPC-R devolve, deriva ou expõe material de chave**, em nenhuma forma,
   nem truncado, nem em erro, nem em log.
6. A mesma Data Key protege as **sementes de comunidade** (§5.3), o que dá à chave de
   escrita do core exatamente a mesma proteção que a identidade tem.

**LIMITAÇÃO DECLARADA (L-2):** `safeStorage` não protege contra outro processo do **mesmo
usuário** já em execução, nem contra memória do processo. No Linux o Electron cai para
`basic_text` — que **não protege nada** — tanto **sem serviço de secret** quanto **quando
não reconhece o ambiente de desktop**; só o probe de backend de A13(5) distingue os dois
casos, e é `isEncryptionAvailable()`, não o nome do backend, que decide. v2 trata o
degradado **confirmado pelo probe** como modo explícito: o núcleo recusa abrir
(`E_KEYSTORE_INSECURE`) salvo se o usuário aceitar o modo inseguro numa tela dedicada, e a
UI passa a exibir um indicador permanente. Não é equivalente a proteção. Medido em G10.

**Emenda de 2026-09-05 — o modo do cofre é persistido, e mudar de modo tem regra.** O modo
em que a Data Key foi embrulhada é gravado em `manifest.meta.keystore_mode` (`secure` |
`insecure-fallback`) na mesma transação em que `secrets.data_key` é escrito. Sem esse
registro, "o ambiente mudou" e "a consulta ao main falhou" são indistinguíveis, e o boot
escolhe silenciosamente entre eles — que era a lacuna. As três regras:

1. **Não conseguir perguntar não é "não há cifra".** A consulta `keystoreInfo` da IPC-M é
   retentada; esgotadas as tentativas **sem resposta**, o boot falha com
   `E_KEYSTORE_UNAVAILABLE` e o núcleo **não abre**. Só uma resposta explícita
   `available:false` compõe o modo inseguro. Tratar timeout como ausência de cifra troca um
   soluço do main pela degradação permanente do cofre desta instalação.
2. **`insecure-fallback` → `secure` migra sozinho.** É o caso de quem instalou o chaveiro
   depois: a Data Key ainda é legível pelo oráculo antigo, então o boot a desembrulha por
   ele, reembrulha por `safeStorage`, reescreve `secrets.data_key` e grava o modo novo. Uma
   linha de log `keystore.upgraded`; nenhuma pergunta ao usuário — ninguém precisa aprovar
   passar a ser protegido.
3. **`secure` → `insecure-fallback` NÃO migra.** A Data Key embrulhada por `safeStorage` é
   ilegível sem ele; não há o que reembrulhar. O boot falha com
   `E_KEYSTORE_MODE_CHANGED` e a UI explica que o chaveiro do sistema sumiu ou mudou —
   reinstalar o chaveiro, ou restaurar o backup de §5.5 numa instalação nova, são os dois
   caminhos. Aceitar o modo inseguro **não** é oferecido aqui: ele não recuperaria dado
   nenhum, só apagaria a única cópia da chave.

O aceite de L-2 (`keystore-accepted`) vale para o modo que estava em uso quando foi dado, e
não é gatilho de degradação futura: um aceite antigo não autoriza abrir em modo inseguro uma
instalação cuja Data Key está em modo `secure` — a regra 3 vence.

### 3.3 Ciclo de vida do núcleo

| Fase | O que acontece | Falha e reação |
|---|---|---|
| `boot` | Adquire o lock composto (§10.8). Abre `manifest.db`, aplica migrações **de dado** (§10.2.1). | Lock ocupado → `E_CORE_ALREADY_RUNNING`, encerra. `manifest.db` à frente do binário → `E_SCHEMA_AHEAD`, encerra. |
| `wipe-resume` | Se `manifest.wipe_state` ≠ `none`, retoma a limpeza de §18.6 do ponto onde parou. | Falha → `E_WIPE_INCOMPLETE` com estado nomeado e caminho de retentativa. |
| `identity` | Pede unwrap da Data Key ao main; decifra a chave. Sem identidade → `awaiting-identity`, só aceita `identity.create` e `identity.import`. | Sem secret store → §3.2 item L-2. |
| `view` | Abre `view.db`; se `schema_version` ≠ binário, agenda reprojeção total (§10.5). | `view.db` corrompido → apaga e reprojeta; é derivado. |
| `open` | Para cada comunidade **listada em `manifest.communities`**: abre o core pela chave gravada, carrega o snapshot de `DS` e recompõe o `fold` até `core.length`. | Core ilegível → `degraded` só naquela comunidade; as outras seguem. |
| `swarm` | `join` do tópico de cada comunidade participada e dos cores de blobs referenciados por anexos abertos localmente (§13.4). | Bootstrap inalcançável → `swarm.degraded`, backoff (§22.3). |
| `reconcile` | Reconciliação da outbox (§11.6) e do staging de blobs (§13.5). | — |
| `ready` | Emite `core.ready`. Escritas aceitas. Jobs periódicos começam. | — |
| `host-mode` | Para cada comunidade hospedada: sobe `rpcServer`, roster, serviço STUN/TURN (§17.3). | Indisponível → `hosting-degraded`: replica leitura, recusa ops com `E_HOST_UNAVAILABLE`. |
| `draining` | `core.shutdown`: para de aceitar ops, aplica a barreira de replicação de §18.7, **fecha** cada core (o append já commitou — §10.7.1; o que falta é liberar o armazenamento), `wal_checkpoint(TRUNCATE)` nos dois bancos. | Estouro do orçamento → `shutdown.forced` com contagem, encerra. |
| `stopped` | Libera o lock. | — |

**Crash do núcleo:** o main reinicia até 3 vezes em 60 s (backoff 1 s / 4 s / 10 s), cada
reinício incrementando o `epoch` do IPC (§15.1). Na quarta falha, erro terminal e não
reinicia mais. O renderer trata cada `epoch` novo pelo procedimento de §15.2.

**Emenda de 2026-09-05 — `blocked` não é crash, e o respawn não atropela o quit.** Duas
regras que a tabela acima implicava e o main não distinguia:

1. **Recusa de abertura é terminal.** As linhas de falha de `boot` (`E_CORE_ALREADY_RUNNING`,
   `E_SCHEMA_AHEAD`, `E_CORE_LOCK_UNAVAILABLE`) dizem "encerra", e encerrar é o fim: nenhuma
   delas muda de resposta por ser tentada de novo. Elas **não** consomem a cota de reinício
   de §15.2 e **não** são reiniciadas — o main mostra a recusa uma vez e encerra. Reiniciar
   dava quatro caixas de erro idênticas para uma condição que a primeira já descrevia.
2. **Reinício agendado confere o estado antes de disparar.** O backoff chega a 10 s, e o app
   pode entrar em `draining` dentro dessa janela. Um núcleo que nasça depois disso abre os
   bancos e toma o lock de §10.8 sem que ninguém mais lhe mande `core.shutdown` — e morre
   pelo prazo do quit, sem snapshot e sem soltar o lock pelo caminho limpo. O reinício em
   voo é cancelado no início do encerramento, e conferido de novo na hora de disparar.

**Emenda de 2026-09-05 — encerramento por sinal externo do sistema operacional.** O ciclo
de fechamento estava escrito só para o caminho da janela: U-06 mostra o impacto (§18.7), a
pessoa confirma, `window-all-closed` dispara o `draining`. Nada dizia o que acontece quando
a saída é decidida **fora do app** — `SIGTERM` de um gerenciador de serviços ou de sessão,
`SIGINT` de um terminal, logoff/desligamento do SO. Na prática não acontecia nada: o
processo morria sem `draining`, portanto sem o snapshot de §10.6, sem a barreira de §18.7 e
sem passar por `stopped`.

Fica normativo:

| | Fechamento pela janela | Sinal externo (`SIGTERM`/`SIGINT`/`SIGHUP`, logoff) |
|---|---|---|
| Confirmação de U-06 | **Sim** — o modal de §18.7 mostra quem cai e o que não replicou | **Não.** A decisão foi tomada fora do app; perguntar "tem certeza?" a um `SIGTERM` gasta o prazo que o SO deu antes do `SIGKILL` |
| `draining` de §3.3 | Sim | **Sim, o mesmo** — mesma barreira de §18.7, mesmo `DRAIN_BUDGET_MS` |
| Prazo do main | 8 s por `{e:'drained'}`, depois sai de qualquer jeito | Idem. O orçamento do núcleo (5 s) continua **menor** que ele, de propósito |
| Sem núcleo vivo | Sai imediatamente | Sai imediatamente — esperar 8 s por um `drained` que não vem é atraso dentro do prazo do SO |

O dreno é o mesmo procedimento, não um caminho paralelo: **um** ponto de entrada, alcançado
pela janela, pelo sinal ou por `before-quit`, e idempotente porque as três coisas podem
chegar juntas.

### 3.4 Regras de fronteira (invioláveis)

1. **O renderer nunca toca disco nem rede para dado de domínio.** Sem `fetch`, sem `fs`,
   sem socket próprio. Exceções, e são só estas duas, ambas declaradas: (a) o
   `RTCPeerConnection` de mídia, que por definição abre socket; (b) a captura e o
   *decode* de mídia. Nenhuma delas transporta dado replicado.
2. **O núcleo nunca formata texto de interface.** Devolve código de erro e dado
   estruturado. Não há exceção: a "mensagem de sistema" de v1 foi removida (§18.7).
3. **O núcleo devolve permissões efetivas; a UI decide o que esconder.** Esconder nunca é
   enforcement.
4. **Nenhum estado de domínio vive no renderer.** As stores guardam estado de sessão de
   interface e um cache de leitura invalidado por evento.
5. **O renderer nunca recebe caminho de arquivo do usuário, nem fornece um.** §13.3.

### 3.5 Deep links

Rota de protocolo `comunidadep2p://`. **Gramática fechada, tudo fora dela é recusado sem
processamento:**

```
comunidadep2p://join/<CODE16>                  CODE16 = 16 chars Crockford Base32
comunidadep2p://m/<MSGREF>                     MSGREF = base64url, 64 bytes exatos (§15.6)
comunidadep2p://u/<KEY64>                      KEY64 = 64 hex (a chave de identidade, §31.16.1)
```

Regras normativas:

1. O **main** faz o parse e a validação sintática. Uma URL que não case exatamente com a
   gramática é descartada com log `deeplink.rejected` e **nada** é encaminhado.
2. O main encaminha **dado estruturado já parseado** (`{route:'join', code}`), nunca a
   string original. **Emenda de 2026-09-05 — o destinatário é o renderer.** A redação
   anterior dizia "ao núcleo", e a implementação a obedecia ao pé da letra nos dois lados
   sem que nada acontecesse: o main postava `{kind:'deeplink'}` na IPC-M e o
   `utilityProcess` logava a mensagem e voltava. Não era descuido — é que **não há o que o
   núcleo faça com um deep link**. A regra 3 abaixo manda o link só posicionar a UI numa
   confirmação, e a prévia que essa tela mostra vem de `invite.resolve` (classe `open`,
   §12.3) e `query.resolveMessageLink` (§15.6), comandos que o renderer emite pela IPC-R
   quando a tela abre. O núcleo fica sabendo do link por eles, no momento em que a
   informação é pedida, e uma cópia antecipada pela IPC-M não teria consumidor. O caminho
   morto foi removido das duas pontas.

   **A entrega ao renderer é fila, e a fila esvazia.** Link que chega antes de haver
   documento (abertura a frio, `second-instance` durante uma recarga) espera o
   `did-finish-load`; entregue, sai da fila. Reler a fila a cada carga transformava toda
   recarga da janela numa reabertura dos convites já tratados.
3. Deep link **nunca dispara ação**: ele só posiciona a UI numa tela de confirmação. Entrar
   numa comunidade sempre exige um clique explícito depois do preview.

   **Emenda de 2026-09-05 — posicionar inclui chegar lá.** "Nunca dispara ação" é sobre o
   **comando** (`invite.join`, `dm.open`), não sobre navegar: sem navegação não existe a
   tela em que a confirmação aparece, e o link não posiciona coisa nenhuma. Foi o que
   acontecia com `u/<KEY64>` fora do destino de conversas — a chave era guardada num store
   que só o destino da DM lia (B63(a)), e clicar no link de dentro de uma comunidade não
   produzia efeito visível nenhum. O renderer troca de destino ao receber o link, e a
   confirmação continua exigindo o clique.
4. Com o app já aberto, `second-instance` encaminha à instância viva
   (`requestSingleInstanceLock`); o lock de dado (§10.8) e o lock de instância são
   **checados na mesma ordem em todo caminho**: instância primeiro, dado depois.
5. No Linux o handler só funciona com o app empacotado. Fora disso a rota é
   inexistente e a UI oferece colar o código. `REQUIRES POC` — G0.

**Emenda de 2026-09-03 (B64) — a rota de pessoa.** `u/<KEY64>` carrega a chave de
identidade de §31.16.1 (64 hex, caixa tolerada, valor em minúsculas adiante). O main
valida a sintaxe e encaminha `{route:'user', key}` já parseado, como as demais rotas.
A regra 3 vale igual: o link **nunca dispara ação** — só posiciona a UI na confirmação
de "Nova conversa", e abrir exige o clique explícito depois da prévia. O campo de
chave continua existindo (é a reserva onde o handler não alcança) e aceita o link
colado, extraindo a chave.

**Emenda de 2026-08-22 — o conteúdo do MSGREF.** São os 64 bytes
`communityId(32) ‖ opId(32)` da op `message.send` que criou a mensagem: os dois são
estáveis entre réplicas por construção, a primeira metade nomeia a comunidade **antes** de
qualquer procura (o `not-member` de §15.6 responde sem tocar nada), e o par já tem índice
em toda réplica (`observed_ops`, §11.6). Qualquer outra derivação ou exigiria dado que o
log não carrega, ou inventaria um segundo id de mensagem.

---

## 4. Módulos e camadas

Quatro camadas. Uma camada só importa das camadas abaixo. Importação lateral só onde a
tabela declarar. Violação **quebra o build** (regra de lint com fronteira por diretório).

**Quando L2 precisa falar rede, quem depende de quem (fecha `HOLE-18`).** `communityHost` e
`outbox` precisam de transporte RPC, mas `rpcServer`/`rpcClient` são L3 e já dependem de L2 —
declarar a dependência nos dois sentidos seria ciclo, e contradiria a regra de precedência
acima. A direção é **sempre L3 → L2**: o módulo de L2 declara a **porta** de que precisa
(interface própria, sem tipo de transporte), L3 a implementa, e quem monta o grafo injeta a
implementação no boot. Nenhuma linha da tabela abaixo cria dependência de L2 para L3.

```
--  composição     composition (raiz de composição — fora da pilha; emenda de 2026-08-22)
L3  fronteira      ipcRenderer · ipcMain · rpcServer · rpcClient · mediaBridge
L2  aplicação      communityHost · communityClient · outbox · invites · presence
                   voiceCoordinator · shareStar · relay · search · blobs · diagnostics
                   succession
L1  domínio        fold (decisionState + admission + effects) · opCodec · permissions
                   idgen · errors
L0  infra          identity · keystore · manifest(SQLite) · view(SQLite) · corestore
                   swarm · logger · config · clock · metrics
```

| Módulo | Camada | Responsabilidade | Depende de | **Não pode** |
|---|---|---|---|---|
| `config` | L0 | Resolver e congelar a **configuração operacional** (§27.2) no boot | — | Expor qualquer valor ao `fold`; ser hot-reload |
| `clock` | L0 | Única fonte de "agora", injetável | — | Ser lido pelo `fold` (o `fold` usa `hostTs` do registro) |
| `logger` | L0 | NDJSON com **allowlist** de campos (§24.2) | `config` | Registrar conteúdo, segredo, caminho de arquivo do usuário ou material de chave |
| `metrics` | L0 | Contadores/histogramas em memória | `clock` | Persistir |
| `keystore` | L0 | Ponte IPC-M para wrap/unwrap da Data Key | — | Ver a chave de identidade |
| `identity` | L0 | Par Ed25519, assinatura, verificação, export/import (§5.5) | `keystore` | Expor material privado por IPC-R, log ou erro |
| `manifest` | L0 | `manifest.db`: abre, migra **preservando dado**, transação | `config` | Conter regra de domínio |
| `view` | L0 | `view.db`: abre, **recria** no bump de schema, transação | `config` | Conter regra de domínio |
| `corestore` | L0 | Ciclo de vida dos cores, **namespaces determinísticos** (§5.3) | `config`, `manifest` | Decidir o que appendar |
| `swarm` | L0 | Um `Hyperswarm`; join/leave; orçamento de conexão (§14.4) | `config` | Interpretar payload |
| `errors` | L1 | Taxonomia fechada (§20) | — | Conter texto em português |
| `opCodec` | L1 | Encode/decode de `Op`, `Envelope`, `HostRecord` por versão; forma canônica; **verificação de assinatura** sobre material que ele mesmo constrói (§7.1) | — | Validar semântica |
| `idgen` | L1 | Derivação determinística de todo id de entidade (§7.3) | — | Usar aleatoriedade ou relógio |
| `permissions` | L1 | Permissão efetiva e hierarquia — função pura sobre `DS` | — | Ler banco |
| `fold` | L1 | **A interpretação normativa**: `DS`, admissão, efeitos (§8) | `opCodec`, `permissions`, `idgen`, `errors` | Fazer I/O, ler relógio, ler configuração, lançar exceção |
| `projector` | L1→L0 | Aplicar os efeitos que o `fold` emitiu em `view.db`, em transação | `fold`, `opCodec`, `view`, `corestore` | Decidir qualquer coisa; **decodificar registro**; emitir evento IPC direto |
| `communityHost` | L2 | Autoridade de ordem: fila de admissão, append, `DS` de host, roster, STUN/TURN | `fold`, `corestore` · **porta** de servidor RPC, implementada por `rpcServer` | Existir quando não hospeda; **importar `rpcServer`** |
| `communityClient` | L2 | Replicar, rodar `fold`+`projector`, enviar ops, emitir eventos | `swarm`, `corestore`, `projector`, `outbox` | Appendar no core |
| `outbox` | L2 | Fila durável, backoff, reconciliação (§11) | `manifest` · **porta** de cliente RPC, implementada por `rpcClient` | Reordenar ops do mesmo canal; **importar `rpcClient`** |
| `invites` | L2 | Emitir, anunciar, resolver, resgatar (§12) | `swarm`, `identity`, `communityHost` | Vazar dado de comunidade para banido além do previsto em §12.5 |
| `blobs` | L2 | Core de blobs próprio, staging, download, seeding, GC (§13) | `corestore`, `swarm`, `manifest` | Aceitar caminho vindo do renderer |
| `presence` | L2 | Presença, digitando, roster — efêmeros, com assinatura por interesse (§17.6) | `swarm`, `clock` | Persistir |
| `voiceCoordinator` | L2 | Roster de voz, **tickets de sessão**, revogação (§17.4) | `communityHost`/`Client`, `permissions` | Ver mídia |
| `shareStar` | L2 | Sessão de tela em estrela, autorização, qualidade por espectador (§17.5) | `voiceCoordinator` | Rodar fora do host para autorização |
| `relay` | L2 | Voluntariado TURN: prova de posse, TTL, cota (§17.7) | `swarm`, `config` | Ligar sem consentimento persistido |
| `succession` | L2 | Escrow, detecção de inatividade, migração de comunidade (§18.8) | `corestore`, `identity`, `fold`, `opCodec`, `idgen`, `permissions` | Assumir host sem o grace period |
| `search` | L2 | FTS5 sobre `CS` (§23) | `view` | Consultar a rede |
| `dmCodec` | L1 | Encode/decode de `DmOp`/`DmEnvelope` por `DM_VERSION`; forma canônica; verificação de assinatura e AEAD sobre material que ele mesmo constrói (§31.4) | — | Validar semântica |
| `dmFold` | L1 | **A interpretação normativa da conversa direta**: `DmState`, admissão, efeitos (§31.7) | `dmCodec`, `idgen`, `errors` | Fazer I/O, ler relógio, ler configuração, lançar exceção |
| `dmProjector` | L1→L0 | Aplicar os efeitos que o `dmFold` emitiu em `view.db`, em transação; manter a ordem de merge de §31.6 | `dmFold`, `dmCodec`, `view`, `corestore` | Decidir qualquer coisa; **decodificar registro**; emitir evento IPC direto |
| `directMessages` | L2 | Ciclo de vida da conversa: derivação, handshake, aceite, bloqueio, autorização de canal, `self_high_water` (§31.8, §31.9, §31.13) | `corestore`, `swarm`, `manifest`, `identity` · **porta** de RPC, implementada por `rpcServer`/`rpcClient` | Interpretar registro; **importar `rpcServer`/`rpcClient`** |
| `diagnostics` | L2 | NAT, peers, snapshot de métricas | `swarm`, `metrics` | Bloquear o event loop |
| `mediaBridge` | L3 | Ponte de chunks renderer↔núcleo (só usada pela árvore adiada, §17.8) | `swarm` | Inspecionar payload |
| `rpcServer` / `rpcClient` | L3 | Transporte e tradução de erro | L2 | Conter regra de negócio |
| `ipcRenderer` / `ipcMain` | L3 | Roteamento, autorização de comando, forma da fronteira | L2 | Conter regra de negócio |
| `composition` | — | **Raiz de composição**: montar o grafo, escolher implementações, injetá-las e ligar os ciclos de vida (§3.3) | qualquer módulo | Decidir domínio; **ser importada por qualquer módulo de camada** |

**Onde mora o `verify` de Ed25519 (fecha `A-06`).** Os estágios 1 e 4 de §8.2 exigem
verificar assinatura, e o `fold` tem exatamente quatro dependências — nenhuma delas é
`identity`, que é L0 e cuja "verificação" a tabela acima nomeia. A operação fica em
`opCodec`: ele **já** constrói o material assinável de §7.1 (`opSigningHash`,
`hostRecordSigningHash`), e conferir uma curva sobre bytes dados não é "validar semântica" —
é a outra metade do mesmo codec. A alternativa, acrescentar `identity` às dependências do
`fold`, criaria uma aresta L1 → L0 que esta tabela não declara e que faria o módulo mais puro
do sistema depender de infra.

**`opCodec` no `projector`, e só a constante.** A importação lateral existe por um motivo
único: `meta.op_version` (§10.3.1) precisa de escritor, e o único escritor de `view.db` é o
`projector` (§21.1) — `view` é L0 e não pode importar L1. O que o `projector` pode tirar de
`opCodec` é a **constante** `OP_VERSION`; decodificar registro continua proibido, e é por isso
que `kind`/`author` de `rejected_records` e de `fold.panic` chegam pelo `FoldResult` (§8.0).
Sem a linha, a alternativa seria reexportar a constante pelo `fold` — o que esconderia a
aresta em vez de declará-la, contra a regra desta seção.

**A raiz de composição (emenda de 2026-08-22).** Esta seção diz três vezes que "quem monta o
grafo injeta a implementação no boot" — e não dizia onde esse "quem" mora. Enquanto a
composição vivia em cabo de teste, a omissão não custava nada. O boot do `utilityProcess`
paga a conta: ele precisa importar `rpcServer` **e** `outbox`, `ipcRenderer` **e**
`projector`, `communityHost` **e** `communityClient` — pares que a tabela acima proíbe
explicitamente de se conhecerem. Não existe camada onde isso caiba: um módulo de L3 com
"depende de L0..L3" não seria uma linha da tabela, seria a negação dela.

A decisão é a única que preserva o sentido da tabela: `src/composition/` fica **fora da
pilha**, e a fronteira que vale para ela é uma só, na direção contrária das demais.

1. A raiz de composição pode importar qualquer módulo, de qualquer camada. É a definição de
   montar o grafo, e é por isso que ela não tem coluna "Depende de".
2. **Nenhum módulo de camada pode importá-la** — e é essa metade que o lint verifica, com
   mensagem própria. Sem ela, um módulo pegaria da raiz uma implementação já pronta, e a
   injeção desta seção viraria acoplamento com um passo a mais.
3. Ela **não decide domínio**. Cada função dela é uma junta entre dois módulos que a tabela
   proíbe de se importarem, ou o ciclo de vida de §3.3. Quem decide continua sendo o `fold`
   (L1) ou o serviço de L2 que a tabela nomeia.

A alternativa considerada era declarar um módulo `boot` em L3. Ela foi recusada porque a
coluna "Depende de" desse módulo seria "tudo", o lint não teria o que verificar nele, e a
regra 2 — a única que de fato protege a arquitetura — não teria onde ser escrita: um módulo
de L3 pode ser importado por outro de L3 quando a tabela declarar, e a raiz de composição
nunca pode ser importada por ninguém.

**Regra de teste que a divisão existe para permitir:** `fold`, `dmFold`, `opCodec`, `dmCodec`,
`permissions` e `idgen` são **puros**. Se um deles precisar de mock de rede, relógio ou banco para ser
testado, a fronteira foi violada. É o que torna §28.1 e §28.4 possíveis.

---

## 5. Identidade, chaves e criptografia

### 5.1 Primitivas

| Uso | Primitiva | Biblioteca |
|---|---|---|
| Identidade e assinatura de op | Ed25519 | `hypercore-crypto` / `sodium-native` |
| Assinatura de `HostRecord` | Ed25519 (chave do core) | `hypercore-crypto` |
| Hash de op, convite, anexo, id | BLAKE2b-256 (128 para id) | `sodium-native` |
| Cifra simétrica em repouso | XChaCha20-Poly1305 | `sodium-native` |
| Derivação de chave por frase secreta | Argon2id (`crypto_pwhash`, `MODERATE`) | `sodium-native` |
| Cifra para um destinatário (escrow, chave de sessão de tela) | `crypto_box_seal` sobre X25519 convertido da Ed25519 | `sodium-native` |
| Transporte P2P | Noise (`hyperdht`), `remotePublicKey` verificada | `hyperdht` |
| Mídia | DTLS-SRTP (WebRTC) — ponta a ponta entre pares | navegador |
| Aleatoriedade | `sodium.randombytes_buf` — **nunca** `Math.random` | `sodium-native` |

### 5.2 Separação de domínio (tabela fechada e autoritativa)

Todo hash e toda derivação usam prefixo de string. Reaproveitar um prefixo em dois
contextos é bug de segurança.

| Prefixo | Entrada | Saída |
|---|---|---|
| `'op/1'` | material assinável da `Op` (§7.1) | hash assinado pelo autor |
| `'hostrec/1'` | material assinável do `HostRecord` (§7.1) | hash assinado pelo host |
| `'opid/1'` | envelope canônico | `opId` (32 B) — correlação de cliente |
| `'id/<entidade>/2'` | `communityId ‖ sequenceScope ‖ authorKey ‖ authorSeq` | id de entidade (16 B) — §7.3 |
| `'ns/log/1'` / `'ns/blobs/1'` | `communitySeed` | semente de par de chaves do core |
| `'ns/memberblobs/1'` | `identitySeed ‖ communityId` | semente do core de blobs do membro |
| `'invite-seed/1'` | `inviteSecret` (10 B) | semente do par de chaves do convite |
| `'invite-topic/1'` | `invitePublicKey` | tópico DHT do convite |
| `'invite-auth/1'` | `invitePk ‖ hostPk ‖ candidatePk ‖ challenge` | prova viva (RPC) |
| `'invite-join/1'` | `communityId ‖ invitePk ‖ candidatePk` | prova de adesão (no log, verificável para sempre) |
| `'relay-possession/1'` | `relayPublicKey` | prova de posse do relay (R-19) — fecha `A-05` |
| `'blob-hash/1'` | conteúdo do arquivo | hash do anexo |
| `'media-ticket/1'` | `sessionId ‖ channelId ‖ peerA ‖ peerB ‖ expiresAt` | ticket de mídia assinado pelo host |
| `'turn-cred/1'` | `sessionId ‖ peerKey ‖ expiresAt` | credencial TURN de curta duração |
| `'ns/hostturn/1'` — **emenda de 2026-08-23** | `dataKey ‖ communityId` | segredo do serviço TURN desta instalação, por comunidade hospedada (§17.3). A tabela de §15.4 exige `hostTurnSecret(communityId)` no boot e nenhum prefixo o derivava; a entrada é da composição, nunca sai do núcleo e não trafega |
| `'share-key/1'` | (aleatório por sessão) | chave AEAD de sessão de tela (§17.8) |
| `'escrow/1'` | `communitySeed` | payload cifrado ao sucessor (§18.8) |
| `'assume/1'` | `newCommunityId ‖ originFinalSeq` | prova de sucessão, assinada com a chave do core de origem (§18.8) |
| `'identity-export/1'` | `identitySeed` | payload de backup (§5.5) |
| `'dm-conv/1'` — **emenda de 2026-09-01** | `min(pkA,pkB) ‖ max(pkA,pkB)` | `conversationId` de uma conversa direta (§31.2) |
| `'ns/dm/1'` | `identitySeed ‖ conversationId` | semente do core de DM daquele lado (§31.3) |
| `'dm-core-possession/1'` | `conversationId ‖ dmPublicKey` | prova de posse do core de DM (RD-1, §31.8) |
| `'dm-content/1'` | `dmShared ‖ conversationId` | chave AEAD de conteúdo da conversa (§31.3) |
| `'dm-nonce/1'` | `conversationId ‖ author ‖ authorSeq` | nonce XChaCha20 derivado, nunca armazenado (§31.3) |
| `'dm-op/1'` | material assinável do `DmOp` (§31.4) | hash assinado pelo autor |
| `'ns/dmblobs/1'` | `identitySeed ‖ conversationId` | semente do core de blobs de DM (§31.14) |
| `'ns/dmturn/1'` | `dataKey ‖ conversationId` | segredo do serviço TURN desta instalação, por conversa direta (§31.15) |

### 5.3 Semente de comunidade e namespaces determinísticos

v1 usava `corestore.namespace(random)`, que não é recuperável. v2:

1. Ao criar uma comunidade, o núcleo gera `communitySeed` = 32 bytes aleatórios.
2. **Grava `communitySeed` cifrado (Data Key) em `manifest.communities` com
   `synchronous=FULL`, antes de criar qualquer core.** Se o processo morrer aqui, nada foi
   criado e a linha órfã é limpa no boot.
3. Deriva:
   - `logKeyPair = keyPairFromSeed(BLAKE2b('ns/log/1' ‖ communitySeed))`
   - `blobsKeyPair = keyPairFromSeed(BLAKE2b('ns/blobs/1' ‖ communitySeed))`
   - `communityId = hex(logKeyPair.publicKey)`
4. `blobsPublicKey` entra **no payload assinado de `community.create`** (§7.4) — portanto é
   dado do log, recuperável por toda réplica, para sempre. Isso é o que mata a
   irrecuperabilidade de `blobsKey` que reprovou a ADR-02 de v1.
5. Cores são abertos por chave explícita (`corestore.get({keyPair})` no host,
   `corestore.get({key})` no membro), **nunca** por namespace aleatório.

Para um membro que entra por convite, `coreKey` vem do resgate (§12.4) e é gravado no
manifesto na mesma transação em que a participação é registrada.

### 5.4 Data Key

`dataKey` = 32 bytes aleatórios, gerados no primeiro boot, embrulhados por `safeStorage`
via IPC-M e gravados em `manifest.secrets`. Protege: `identitySeed`, todo `communitySeed`,
todo `escrowSeed`. Rotação: fora de escopo do v1 (`LIMITAÇÃO DECLARADA L-3`).

### 5.5 Backup e restauração de identidade

**Muda a premissa 3 da spec de UX** (registrado em `deltas-ux-v2.md`, delta U-01).
Motivo: sem isso, perder a máquina é perder permanentemente toda comunidade hospedada, o
que o ARB classificou como limitação de produto não aceita (T-43).

| Comando | Comportamento |
|---|---|
| `identity.export{passphrase}` | Deriva `kek = Argon2id(passphrase, salt, MODERATE)`; devolve um blob `identity-export/1` contendo `identitySeed`, `displayName`, `avatarColor` e a lista de `{communityId, coreKey, blobsKey, communitySeed?}` das comunidades participadas. `communitySeed` só entra para comunidades hospedadas. O main grava o arquivo por `dialog.showSaveDialog`; o blob **nunca** passa pelo renderer. |
| `identity.import{ticket, passphrase}` | Só em instalação **sem** identidade. Deriva a chave, decifra, recria o manifesto e reabre os cores. |

**LIMITAÇÃO DECLARADA (L-4):** o backup não é multi-dispositivo. Se duas instalações
usarem a mesma identidade e **hospedarem a mesma comunidade**, os dois escritores produzem
um fork do Hypercore. O núcleo **detecta** o fork (bloco conflitante ao replicar), marca a
comunidade `forked`, **para de appendar** e exige resolução manual (§18.9). Não há merge
automático. Frase secreta perdida = backup perdido; não há recuperação.

---

## 6. Modelo de domínio

### 6.0 Convenções das fichas

Legenda de obrigatoriedade: `req` obrigatório · `opt` opcional · `der` derivado pelo `fold`
(nunca vem em op) · `host` escrito pelo host no `HostRecord` · `local` só na instalação de
quem lê, nunca trafega.

### 6.1 Identity

**Responsabilidade:** provar autoria. É a única credencial do produto.

| Atributo | Tipo | Obrig. | Regra |
|---|---|---|---|
| `publicKey` | `bytes[32]` | req | Ed25519. **É o id global da pessoa.** |
| `secretKey` | `bytes[64]` | req | Nunca sai do núcleo (§3.2) |
| `displayName` | `string` | req | 2–32 code points após `trim` |
| `avatarColor` | `enum` | req | `role-gold = 0 · role-blue = 1 · role-green = 2 · role-red = 3 · role-purple = 4 · role-pink = 5 · role-neutral = 6 · accent = 7`. Ver **§6.4.2** |
| `handle` | `string` | der | `@` + 8 caracteres Crockford-Base32 minúsculos da `publicKey`, exibidos em 2 grupos de 4 (`@k3f9-2mqa`). **Não é único.** |
| `presence` | `enum` | local | `online · idle · dnd · invisible`. `offline` nunca é escrito. |
| `createdAt` | `ms` | req | — |

**Restrições:** no máximo uma Identity por instalação. `displayName` não tem unicidade —
não existe namespace global em P2P.

**LIMITAÇÃO DECLARADA (L-5) — personificação:** com nome livre e `handle` de 40 bits,
personificação é possível. Mitigações normativas: (a) o `handle` é exibido **junto** do
nome em perfil, log de moderação, lista de banidos e preview de convite; (b) o `fold`
marca `displayNameCollision = true` em todo membro cujo `displayName` normalizado
(NFKC + casefold + colapso de espaço) coincida com o de outro membro **ativo** da mesma
comunidade, e a UI é obrigada a mostrar o aviso. Não há bloqueio de nome duplicado.

**Ciclo:** `(nenhuma) → identity.create|identity.import → active → identity.wipe → (nenhuma)`.

**Operações:** `identity.create`, `identity.update`, `identity.setPresence` (efêmera),
`identity.export`, `identity.import`, `identity.wipe`.

### 6.2 Community

| Atributo | Tipo | Obrig. | Regra |
|---|---|---|---|
| `id` | `string` | der | hex64 da chave pública do core do log |
| `coreKey` | `bytes[32]` | der | = `id` |
| `blobsKey` | `bytes[32]` | req | **Payload de `community.create`** — dado do log (§5.3) |
| `hostKey` | `bytes[32]` | der | Chave pública do host **corrente**; muda por `community.assumeHost` (§18.8) |
| `originCommunityId` | `string` | opt | Presente quando a comunidade é continuação de outra (§18.8) |
| `name` | `string` | req | 2–40 code points |
| `iconEmoji` | `string` | opt | 1–8 code points, ≤ 32 bytes |
| `iconColor` | `enum` | req | Mesmo conjunto de `avatarColor`: `0..7` (§6.4.2) |
| `description` | `string` | opt | ≤ 120 code points |
| `createdAt` | `ms` | host | `hostTs` do registro `seq=0` |
| `memberCount` | `int` | der | Membros ativos não banidos |
| `endedAt` | `ms` | der | `community.end` |
| `successorKeys` | `bytes[32][]` | der | Ordem = prioridade (§18.8). Máx. 5 |
| `isHostedByMe` | `bool` | local | `hostKey === identity.publicKey` |
| `lastHostSeenAt` | `ms` | local | Alimenta "Inativa há muito tempo" |

**Restrições:**
- Toda comunidade nasce com 1 categoria (`GERAL`), 1 canal de texto (`#geral`), 2 cargos
  (Fundador e cargo base `Membro`) e 1 membro (o host, com Fundador). Isso é o **lote de
  gênese**, appendado como uma única chamada `core.append([...])` (§19.1).
- Nunca fica sem canal (§8.3, regra R-7).
- Nome duplicado entre comunidades é permitido.
- Comunidade `ended` não aceita op nenhuma; o core fica em leitura.

**Operações:** `community.create`, `community.update`, `community.end`,
`community.setSuccessors`, `community.escrow`, `community.assumeHost`, `member.leave`.
Não existe `kind` `community.leave` — a saída é `member.leave` (fecha `F-24`). O host não
pode `member.leave`: `E_HOST_CANNOT_LEAVE`.

### 6.3 Member

| Atributo | Tipo | Obrig. | Regra |
|---|---|---|---|
| `identityKey` | `bytes[32]` | req | — |
| `communityId` | `string` | req | Do cabeçalho da op |
| `displayName` / `avatarColor` | — | der | Último `identity.update` desta pessoa nesta comunidade |
| `nickname` | `string \| null` | der | 1–32 code points; auto-atribuído |
| `roleIds` | `string[]` | der | Sempre contém o cargo base. Máx. 24 |
| `blobsCoreKey` | `bytes[32]` | der | Core de blobs do membro (§13.1); vem em `member.join` ou `member.setBlobsCore` |
| `joinedAt` / `leftAt` | `ms` | der | — |
| `banned` | `bool` | der | Ban ativo não revogado |
| `timeoutUntil` | `ms \| null` | der | — |
| `displayNameCollision` | `bool` | der | §6.1, L-5 |
| `storageUsedBytes` | `int` | der | Soma de `sizeBytes` dos anexos vivos do membro. **Medidor, não fronteira** desde a remoção de `R-14` (§13.8) |

**Restrições:**
- `(communityId, identityKey)` é único.
- Todo membro ativo tem o cargo base (`R-3`).
- O **Fundador original** e o **host corrente** nunca são alvo de `mod.*`
  (`E_FOUNDER_IMMUNE` / `E_HOST_IMMUNE`).
- Quem sai e volta recupera o `Member` com `roleIds` **resetado ao cargo base**. A volta
  exige um convite **novo**: R-9 registra o par `(invitePk, autor)` em `joinedByInvite` e
  nunca o aceita duas vezes — sem isso, um convite de `maxUses = 1` seria reusável
  indefinidamente pela mesma pessoa entrando e saindo (§12.6).

**LIMITAÇÃO DECLARADA (L-6):** um banido que volta com identidade nova é indistinguível de
um membro novo. O backend **não** tenta heurística.

**Ciclo:**
```
(não-membro) ─member.join─▶ active ─member.leave|mod.kick─▶ left ─member.join─▶ active
     │                        ├─mod.timeout──▶ silenced (expira sozinho)
     │                        └─mod.ban──────▶ banned ─mod.revokeBan─▶ left
     └─mod.ban────────────────────────────────▶ banned          (R-28)
```

A aresta direta `(não-membro) → banned` é **R-28**: ban preventivo, e o mecanismo pelo qual
a continuação de uma sucessão carrega os bans da origem (§18.8.1). Um alvo nesse estado
nunca esteve `active`, não conta em `memberCount` e não aparece no roster.

### 6.4 Role

| Atributo | Tipo | Obrig. | Regra |
|---|---|---|---|
| `id` | `string` | der | §7.3 |
| `name` | `string` | req | 1–32 code points |
| `color` | `enum` | req | Uma das 7 de `RoleColor`: `0..6` (§6.4.2). **`accent` (7) não é cor de cargo** |
| `rank` | `string` | req | **Chave fracionária esparsa** (§6.4.1). Único por comunidade |
| `permissions` | `Permission[]` | req | Subconjunto das 17 (§9.1); pode ser vazio |
| `mentionable` | `bool` | req | Default `true`; cargo base nasce `false` |
| `isFounder` / `isDefault` | `bool` | der | Exatamente um de cada por comunidade |
| `memberCount` | `int` | der | — |
| `deletedAt` | `ms` | der | Tombstone |

#### 6.4.1 Ordenação por chave fracionária

v1 usava `position` inteiro **denso e único**, renumerado a cada `role.move` dentro de um
índice `UNIQUE` — o que produzia violação de índice sob concorrência (`F-39`) e obrigava a
reescrever N linhas por movimento.

v2: `rank` é uma string na base 62 (`0-9A-Za-z`), ordenada lexicograficamente, gerada por
**indexação fracionária**: mover um cargo entre `A` e `B` gera uma chave estritamente entre
as duas (`midpoint(A,B)`), sem tocar em nenhum outro registro.

#### Valores de fronteira (constantes de protocolo, §27.1)

| Constante | Valor | Papel |
|---|---|---|
| `RANK_TOP` | `'zz'` | `rank` do cargo Fundador, atribuído no `seq` 1 da gênese (R-27b). O Fundador é sempre o topo |
| `RANK_BOTTOM` | `'1'` | `rank` do cargo base, atribuído no `seq` 2 (R-27b). Não é `'0'` porque `rank` nunca termina em `0` |
| `RANK_GENESIS` | `'z'` repetido **65** vezes | `topRank` do principal de gênese (R-27a). 65 > `RANK_MAX_LEN`, então é maior que qualquer `rank` válido **e nunca é ele próprio um `rank` válido** — não há como gravá-lo em cargo por acidente |

Todo `rank` gerado por `midpoint` ou por renormalização fica **estritamente entre**
`RANK_BOTTOM` e `RANK_TOP`, o que é o que mantém o cargo base no fundo e o Fundador no topo
sem regra adicional.

**Os dois sentinelas são os limites, e é isso que torna a frase acima verdadeira.** Quando o
vizinho de que o cálculo precisa não existe, o limite é `RANK_BOTTOM` embaixo e `RANK_TOP` em
cima — **`midpoint` nunca recebe `null` vindo de um escopo real**. Sem essa regra a invariante
é falsa, e não por um caso de canto: com o limite inferior aberto, o sexto item criado sem
dica de posição cai exatamente em `RANK_BOTTOM` e o sétimo abaixo dele. Para **cargos** isso
acontece já no primeiro, porque o cargo base ocupa `RANK_BOTTOM` desde a gênese (R-27b) — e um
cargo abaixo do base é pior do que fora de ordem: por R-3 todo membro carrega o base, então o
`topRank` de quem recebe o cargo novo continua sendo o do base, e por R-4 ele **não modera
ninguém**, nem um membro comum. Um "Moderador" criado pelo caminho default nasceria com
`ban_members` e sem poder banir.

O piso é limite, não vizinho: o cargo base não entra no cálculo como item do escopo, ele *é* a
fronteira de baixo. Pedir posição abaixo dela é entrada incoerente e normaliza para o fim do
escopo, como toda dica inutilizável — o `fold` não recusa (§8.5).

#### `midpoint(a, b)` — definição normativa

`a` e `b` são lidos como a **parte fracionária** de um número em base 62 com os dígitos
`0-9A-Za-z` nessa ordem. `a = null` é o limite inferior; `b = null`, o superior. A função é
**total**: entrada incoerente (`a ≥ b`, zero à direita) é normalizada, nunca recusada — o
`fold` não lança (§8.5).

```
canônica(s)  = s sem os '0' finais            // senão midpoint não termina
dígito(c)    = índice de c em '0-9A-Za-z'     // 0..61

mid(a, b):
  a ← canônica(a)
  se b ≠ null:
    b ← canônica(b)
    se b = '' ou a ≥ b:  devolve mid(a, null)          // incoerente: entra no fim
    n ← tamanho do prefixo comum, tratando a[i] ausente como '0'
    se n > 0: devolve b[0..n) ‖ mid(a[n..), b[n..))    // preserva o prefixo comum
  dA ← a ≠ '' ? dígito(a[0]) : 0
  dB ← b ≠ null ? dígito(b[0]) : 62
  se dB − dA > 1:      devolve dígito⁻¹(round((dA + dB) / 2))
  se b ≠ null e |b| > 1: devolve b[0..1)
  devolve dígito⁻¹(dA) ‖ mid(a[1..), null)
```

`round` é o arredondamento para o inteiro mais próximo, meio para cima — a única escolha que
mantém a função determinística entre réplicas.

**Renormalização.** Quando o `midpoint` excederia `RANK_MAX_LEN`, o escopo inteiro é
reespaçado com **dois dígitos base 62, ambos de índice ≥ 1**: o item `i` (base 0) recebe
`dígito⁻¹(1 + ⌊i/60⌋) ‖ dígito⁻¹(1 + (i mod 60))`. Nunca termina em `0`, cabe em
`MAX_CHANNELS` (500), e todo valor fica estritamente entre `RANK_BOTTOM` e `RANK_TOP`.

**Os dois sentinelas não são reespaçados** (emenda de 2026-09-04). No escopo de **cargos**, a
renormalização alcança todos os cargos vivos **exceto o Fundador e o cargo base**: o primeiro
porque esta mesma seção o declara imutável e sempre no topo, o segundo porque ele "não entra no
cálculo como item do escopo, ele *é* a fronteira de baixo". Como todo valor gerado fica
estritamente entre `RANK_BOTTOM` e `RANK_TOP`, deixá-los de fora **preserva a ordem relativa**
e custa nada. Reespaçá-los junto — que era a leitura literal de "todos os itens vivos daquele
escopo" — tirava o Fundador de `RANK_TOP` e o base de `RANK_BOTTOM`, e com o piso vago o
próximo cargo criado sem dica caía **abaixo** do base: por R-3 todo membro carrega o base, então
por R-4 esse cargo nascia sem moderar ninguém. Nos escopos de canal e de categoria não há
sentinela e a renormalização segue alcançando o escopo inteiro.

Regras normativas:
- `role.move` carrega `{roleId, afterRank?, beforeRank?}` — as chaves **vizinhas
  observadas pelo cliente**, não uma posição absoluta.
- O `fold` recalcula `rank = midpoint(prevRank, nextRank)` usando os vizinhos **reais** no
  seu `DS` no momento do registro, ignorando os que o cliente enviou se estiverem
  desatualizados. Determinístico.
- Colisão de `rank` (só possível por bug) é resolvida por desempate em `roleId` ascendente.
  O `fold` **nunca** falha por causa disso.
- **Renormalização determinística (fecha `HOLE-15`).** `midpoint` cresce em comprimento a
  cada inserção sucessiva na mesma extremidade: medido, a partir de ~383 inserções
  consecutivas no fundo a chave passa de `RANK_MAX_LEN` (64) e sai do tipo declarado em
  §7.2.1. Quando o `midpoint` que o `fold` calcularia excederia `RANK_MAX_LEN`, o `fold`
  **não recusa a op**: ele **renormaliza o escopo inteiro** no mesmo registro — todos os
  itens vivos daquele escopo (cargos da comunidade, canais da categoria, categorias da
  comunidade) recebem `rank` reespaçado uniformemente, **preservando a ordem corrente**, e
  o item novo entra na posição pedida. A renormalização é função pura do `DS` no momento
  do registro, então **toda réplica produz exatamente os mesmos `rank`**, e emite um
  `upsert` por item do escopo — limitado por §27.1 (`MAX_ROLES` 100, `MAX_CHANNELS` 500,
  `MAX_CATEGORIES` 50). Recusar era a alternativa e foi descartada: deixaria a comunidade
  permanentemente incapaz de reordenar, sem caminho de volta e por um detalhe de
  representação que o usuário não tem como perceber nem corrigir.
- A ordem exibida é `rank DESC` (topo primeiro). `position` inteiro **não existe mais** em
  contrato nenhum.

**Restrições:** Fundador tem sempre o `rank` máximo e é imutável (`E_FOUNDER_IMMUTABLE`,
`E_FOUNDER_TOP`). Cargo base não é deletável (`E_BASE_ROLE_REQUIRED`) mas suas permissões
são editáveis **dentro dos limites de R-11 e R-12** (§8.3). `role.delete` nunca remove
membros; o `fold` tira o `roleId` de todos e **limpa toda referência pendurada**, inclusive
`channel.readOnlyForRoleIds` (fecha `F-31`).

#### 6.4.2 Catálogo de cores (fecha `HOLE-10`)

Cor viaja como `u8` em material assinado (`role.create`/`role.update`, `identity.update`,
`community.create`/`community.update`), então o número é **constante de protocolo**
(§27.1), não escolha de tema. A paleta é a mesma que o frontend já implementa (§5.4 de
`frontend.md`): curada, fechada, sem cor livre.

| # | Nome | `RoleColor` | `avatarColor` / `iconColor` |
|---:|---|:---:|:---:|
| 0 | `role-gold` | ✅ | ✅ |
| 1 | `role-blue` | ✅ | ✅ |
| 2 | `role-green` | ✅ | ✅ |
| 3 | `role-red` | ✅ | ✅ |
| 4 | `role-purple` | ✅ | ✅ |
| 5 | `role-pink` | ✅ | ✅ |
| 6 | `role-neutral` | ✅ | ✅ |
| 7 | `accent` | — | ✅ |

`accent` é a cor da própria identidade visual do app e **não** é atribuível a cargo: um
cargo com `accent` se confundiria com elemento de sistema na lista de membros. Daí a
faixa de `Role.color` ser `0..6` e a de `avatarColor`/`iconColor` ser `0..7`.

Valor fora da faixa é `REJECTED` no estágio 13 com `E_VALIDATION` no campo correspondente.
**Não é clampado nem substituído por um default:** clampar faria duas réplicas com
paletas de tamanhos diferentes convergirem para cores diferentes a partir do mesmo log.

### 6.5 Category

`id` (§7.3) · `name` 1–32 code points · `rank` (mesma indexação fracionária de §6.4.1) ·
`deletedAt`. `collapsed` é **local**. Exatamente dois níveis: categoria contém canal.
`category.delete` carrega exatamente um de `moveChannelsTo` / `deleteChannels`.

### 6.6 Channel

| Atributo | Tipo | Obrig. | Regra |
|---|---|---|---|
| `id` | `string` | der | §7.3 |
| `categoryId` | `string` | req | Categoria da mesma comunidade |
| `type` | `enum` | req | `text = 0 · voice = 1`. **Imutável.** O número é constante de protocolo (§27.1): viaja como `u8` em `channel.create` (§7.4.2), dentro de material assinado. `u8` fora de `{0,1}` é `E_VALIDATION.type` |
| `name` | `string` | req | Texto: slug `^[a-z0-9][a-z0-9-]{0,31}$`. Voz: 1–32 code points livres |
| `topic` | `string` | opt | ≤ 120 code points; só em texto |
| `rank` | `string` | der | Indexação fracionária dentro da categoria |
| `readOnlyForRoleIds` | `string[]` | opt | Cargos que **não** postam; ≥ 1 cargo precisa ficar de fora |
| `speechMode` | `enum` | opt | **Emenda de 2026-08-28 (modo karaokê).** `free = 0 · queue = 1 · admins = 2`, default `0` (ausente em `channel.create` = `0`). Regula **quem transmite áudio** num canal de voz — quem escuta continua sujeito só a `voice_speak` (§17.4). **Só existe em canal de voz**: `channel.create` de texto com o campo presente é `E_VALIDATION.speechMode`; idem `channel.update` sobre canal de texto. O número é constante de protocolo (§27.1): viaja como `u8` em `channel.create`/`channel.update` (§7.4.2), dentro de material assinado. Fora de `{0,1,2}` é `E_VALIDATION.speechMode` (R-29). `queue = 1` é o modo explicitamente desenhado para karaokê: a fila de turnos é efêmera (§16.4) e o `queueTurnSeconds` abaixo é seu default |
| `queueTurnSeconds` | `int` | opt | Duração do turno do modo fila: 30–3600, default **300** (§8.6, R-29). Só tem efeito com `speechMode = 1`; só pode estar presente num registro que **deixa o canal em modo fila** (`speechMode = 1` na própria op, ou o canal já em `1` com `speechMode` ausente) — `E_VALIDATION.queueTurnSeconds`. O valor persiste quando o modo muda para outro: trocar de volta para fila reusa o turno gravado |
| `deletedAt` | `ms` | der | — |
| `unreadCount`, `pendingMentions`, `muted`, `firstUnreadSeq` | — | local | §6.15 |

`(communityId, type, name)` é único entre canais não deletados. Excluir o último canal é
recusado (`R-7`). Excluir canal de voz com gente dentro é permitido e derruba a sessão.

### 6.7 Message

| Atributo | Tipo | Obrig. | Regra |
|---|---|---|---|
| `id` | `string` | der | §7.3 — determinístico, reprojetar produz o mesmo |
| `seq` | `int` | der | Posição no log. **Ordem canônica** |
| `channelId` | `string` | req | Canal de texto, existente, não deletado |
| `authorKey` | `bytes[32]` | der | Do cabeçalho da `Op` (não vai no payload) |
| `content` | `string \| null` | req | 1–4000 code points, ≤ 16384 bytes UTF-8. `NULL` quando tombstonada |
| `authorTs` | `ms` | req | `op.ts` — relógio do autor |
| `hostTs` | `ms` | host | Carimbo do host, monotônico (§8.3 R-1) |
| `clockSkewed` | `bool` | der | `|authorTs − hostTs| > CLOCK_SKEW_MS` |
| `edited`, `editedAt` | — | der | — |
| `pinned` | `bool` | der | Maior `seq` vence |
| `replyToId`, `threadId` | `string` | opt | Do **mesmo canal** |
| `mentions` | `string[]` | opt | ≤ 64: hex64 de identidade, id de cargo, ou `everyone` |
| `mentionEveryoneEffective` | `bool` | der | §8.3 R-13 |
| `attachment` | `AttachmentRef` | opt | Máx. 1 no v1 |
| `deletedAt` | `ms` | der | Tombstone |
| `hiddenByBan` | `bool` | der | Reversível (§18.2) |
| `orphaned` | `bool` | der | §8.4 — canal-alvo tombstonado depois; a mensagem existe, mas não é listada |

**Regras de edição/deleção:** editar só a própria (`E_CANNOT_EDIT_OTHERS` sempre para
terceiros — moderação apaga, não reescreve). Deletar a própria, ou `manage_messages` +
hierarquia. Deletar já deletada é sucesso idempotente sem nova entrada de auditoria.

**Relógio (fecha `F-33`, `T-26`, `M-17`):** o `fold` **não** corrige `authorTs`. A UI exibe
`authorTs`; se `clockSkewed`, exibe `hostTs` com o aviso. `authorTs` fora de
`[hostTs − 24 h, hostTs + 24 h]` faz a op **não ter efeito** (`R-2`) — carimbo retroativo
de sete dias, que v1 aceitava, foi removido.

**Ciclo (o `fold` só conhece dois estados; os outros quatro são do cliente):**
```
cliente:  composer → queued → sending → awaiting-confirmation → (removido)
                       └──────────────┴──▶ failed → queued | dropped(motivo)
log:      sent(seq) ──edit──▶ sent(edited) ──delete──▶ deleted(tombstone)
```

### 6.8 Thread

`id` (§7.3) · `rootMessageId` · `channelId` (der) · `replyCount` (der) ·
`participantKeys` (der) · `unreadCount` (**local**, tabela própria — fecha `DR-48`).
Uma thread por raiz. Deletar a raiz **não** deleta as respostas; a thread deixa de ser
alcançável pelo indicador e o `fold` marca `rootDeleted = true`.

### 6.9 Reaction

PK `(communityId, messageId, emoji, identityKey)`. `emoji` = 1–8 code points, ≤ 32 bytes.
Máx. 20 emojis distintos por mensagem, 1 reação por pessoa por emoji.

**"Distintos" é "com ao menos um reagente"** (emenda de 2026-09-04, fecha a lacuna que R-23 e
§8.1 deixavam). Um emoji ocupa uma das 20 vagas **enquanto tiver reagente**, e a remoção da
última reação daquele emoji **libera a vaga**. A leitura alternativa — "emojis já usados", um
conjunto que só cresce — foi descartada por duas razões: ela deixa uma mensagem sem reação
nenhuma exibida permanentemente incapaz de receber a 21ª, e é **inconsistente com a projeção**,
porque `view.db` só guarda as reações vivas (a PK acima) e é de lá que o `DecisionState` é
rematerializado (§8.1, regra de residência). Com as duas leituras em vigor ao mesmo tempo, um
nó que herdou snapshot e um nó que reprojetou do `seq` 0 decidiam R-23 **diferente sobre o mesmo
log**. Por isso `MessageMeta` guarda o reagente, e não só o emoji — ver §8.1.

**Mudança normativa (fecha `DS-12`):** a op é `reaction.set{messageId, emoji, present}` —
**idempotente e convergente por último `seq`**. `reaction.toggle` não existe mais. Isso
elimina a única op não comutativa do catálogo e remove a dependência de durabilidade de
dedupe para correção.

Mensagem deletada → reações somem na mesma transação, sem estado zumbi. **Emenda de
2026-09-05:** o mesmo vale para `message_links` e para `attachments`. O `content` vira `NULL`
(§10.3), mas `name`, `size_bytes`, `kind` e `hash` do anexo são conteúdo tanto quanto o texto,
e `query.message` os devolvia inteiros depois da deleção, com `hasAttachment: true`. A26 vale
para os **bytes no core**, que continuam onde estavam; não para a projeção. É também o que faz
a regra 2 de §13.7 ser verdade: o GC de §22.4 decide pela referência viva em `attachments`, e
sem apagar a linha os blocos do autor nunca voltavam — o que §13.8 já afirmava ("o espaço só
volta tombstonando as próprias mensagens"). `member.storageUsedBytes` **não** muda: ele é
acumulador do `fold` (§13.8), medidor de uso, não soma da tabela. A conversa direta faz o
mesmo com `dm_attachments` (§31.7.4).

### 6.10 Attachment

| Atributo | Tipo | Obrig. | Regra |
|---|---|---|---|
| `ownerKey` | `bytes[32]` | der | = autor da mensagem |
| `blobsCoreKey` | `bytes[32]` | req | Core de blobs **do autor** (§13.1) |
| `blobId` | `{byteOffset,blockOffset,blockLength,byteLength}` | req | Devolvido por `hyperblobs.put` |
| `name` | `string` | req | 1–255 bytes, sem `/ \ \0` nem controle |
| `sizeBytes` | `int` | req | 1 .. `ATTACHMENT_MAX_BYTES` |
| `kind` | `enum` | req | `image · video · audio · document · archive · other` — tabela de extensão em §13.6 |
| `hash` | `bytes[32]` | req | `BLAKE2b('blob-hash/1' ‖ conteúdo)`. **Verificado no destino** |
| `downloadProgress`, `availablePeers`, `hostAvailable`, `state` | — | local | §13.4 |

**Regras:**
- `sizeBytes` **não** é revalidado pelo host (o host não tem os bytes). O **leitor** aborta
  o download se os bytes recebidos ultrapassarem `sizeBytes` e emite `attachment.corrupt`.
  Isso fecha o ataque "declara 1 KB, entrega 8 GB" no ponto certo.
- O `hash` é verificado ao completar. Falha → arquivo descartado, `attachment.corrupt`.
  **Nenhum byte não verificado vira arquivo final no disco do usuário.**
- Deletar a mensagem não apaga o blob do core do autor. A projeção esconde a referência; o
  GC local (§22.4) limpa o cache.
- Cota por membro: **não há** (`R-14` saiu em `opVersion = 3`, §13.8).

### 6.11 Invite

| Atributo | Tipo | Obrig. | Regra |
|---|---|---|---|
| `invitePublicKey` | `bytes[32]` | req | **No log.** Derivada do segredo (§12.1) |
| `secret` | `bytes[10]` | local | Só na instalação de quem criou |
| `createdByKey` | `bytes[32]` | der | Precisa de `create_invite` |
| `createdAt` | `ms` | der | `hostTs` |
| `expiresAt` | `ms` | opt | `> hostTs`, ≤ 365 d à frente. Ausente = nunca |
| `maxUses` | `int` | opt | 1..10000. Ausente = ilimitado |
| `uses` | `int` | der | Contado pelo `fold` |
| `revokedAt` | `ms` | der | Explícito, ou automático por `R-10` |
| `label` | `string` | opt | ≤ 40 code points, para a lista de 3.1b |

**O segredo nunca entra no log.** O log guarda a **chave pública** do convite; o host
valida com ela. É isso que torna convite delegado executável (§12).

**Revogação automática (`R-10`, fecha `T-23`):** o `fold` revoga todo convite de um membro
no instante em que esse membro é banido, expulso, sai, ou perde `create_invite`.

**MUDANÇA DE PRODUTO (delta U-04):** o código em claro de um convite **só existe na
instalação de quem o criou**. `query.invites` devolve `codeAvailable:false` para os
demais. Não há solução criptográfica para o contrário sem colocar o segredo no log.

**Ciclo:** `active → (revoked | expired | exhausted)`, todos terminais; o registro fica.

### 6.12 Ban / Timeout

`targetKey` · `byKey` · `at` (`hostTs`) · `reason` (≤ 200 code points) · `until` (timeout:
`> hostTs`, ≤ 30 d) · `revokedAt` (ban).

**O que o ban faz, exatamente:**

| Efeito | Alcance | Momento |
|---|---|---|
| Recusa de op | Total, em toda réplica | Imediato pelo `fold` |
| Ocultação de mensagens do alvo | Projeção, **reversível** | Mesma transação do ban |
| Recusa de replicação a partir dos pares | Todo membro que já projetou o ban | Ao aplicar o ban (§14.3) |
| Queda das conexões ativas do alvo | Comunidade banida apenas | Imediato |
| Revogação de tickets de mídia | Sessões de voz/tela | Imediato (§17.4) |
| Revogação dos convites emitidos pelo alvo | `R-10` | Imediato pelo `fold` |
| Preview de convite devolve `banned` | Canal pré-membro (§12.5) | Sempre |

**LIMITAÇÃO DECLARADA (L-7) — revogação de leitura:** o ban impede replicação **futura**.
Ele **não** retira do alvo o que ele já replicou. A UI é obrigada a dizer isso no modal de
confirmação de ban.

**Timeout** expira **sozinho**, por comparação `until > hostTs do registro corrente` dentro
do `fold` — nunca pelo relógio de quem lê. Isso fecha `T-45`: réplicas não divergem.
Consequência: um timeout só "expira" quando algum registro novo entra no log; para a UI, a
contagem regressiva é local e cosmética, e o `fold` é a verdade.

### 6.13 ModerationEntry (log de auditoria)

**Não é um `kind`** — é projeção derivada de qualquer op auditável.

| Atributo | Regra |
|---|---|
| `id` | §7.3 |
| `seq` | Do registro |
| `type` | Enum fechado e **único** (fecha `RT-07`): `kick · ban · revokeBan · timeout · removeTimeout · deleteMessage · createRole · updateRole · deleteRole · createChannel · updateChannel · deleteChannel · createCategory · renameCategory · deleteCategory · updateCommunity · endCommunity · assumeHost · setSuccessors · revokeInvite` (**20**). Há exatamente um valor para cada linha marcada `Aud. = sim` em §7.4 — a correspondência é 1:1 e verificável por teste |
| `targetId` / `targetKey` | — |
| `targetLabel` | **Congelado no momento da aplicação** |
| `byKey` | — |
| `byLabel` | **Congelado também** (fecha `DR-49`) |
| `reason` | — |
| `at` | `hostTs` |

Reprojetar reconstrói exatamente as mesmas entradas, com os mesmos ids.

### 6.14 RelayVolunteer

`identityKey` · `relayPublicKey` (derivada da identidade, §17.7) · `since` · `expiresAt`
(TTL obrigatório, `RELAY_TTL_MS`) · `withdrawnAt` · `rttMs` (**local**).
Exige prova de posse (§17.7) e consentimento persistido.

### 6.15 Estado local (`LS` — nunca replica, nunca é apagado por reprojeção)

| Tabela | Chave | Campos |
|---|---|---|
| `local_read_state` | `(communityId, channelId)` | `lastReadSeq`, `firstUnreadSeq`, `unreadCount`, `pendingMentions` |
| `local_thread_read_state` | `(communityId, threadId)` | `lastReadSeq`, `unreadCount` — fecha `DR-48` |
| `local_channel_pref` | `channelId` | `muted` |
| `local_community_pref` | `communityId` | `notificationLevel`, `collapsedCategories[]`, `recentChannels[]`, `lastHostSeenAt` |
| `local_navigation` | singleton | `activeCommunityId`, `activeChannelId` — **dono único** (fecha `DR-32`) |
| `local_relay_consent` | `communityId` | `decision`, `at` |
| `local_device_pref` | singleton | `microphoneId`, `cameraId`, `outputId`, `inputVolume`, `outputVolume` |
| `local_participant_volume` | `(communityId, identityKey)` | `volume` 0..100 — fecha `DR-45`/`V-6` |
| `local_blob_cache` | `(blobsCoreKey, blobIdHex)` | `bytesDownloaded`, `state`, `path`, `verifiedAt`, `declaredSize` |
| `local_blob_staging` | `ticketId` | `path`, `bytesWritten`, `rollingHashState`, `state` |
| `local_outbox` | `localSeq` | §11.2 |
| `local_author_seq` | `(communityId, sequenceScope)` | `nextAuthorSeq` — §7.3 |

**Cálculo de não-lidas (fechado):** por canal, `unreadCount` = mensagens com
`seq > lastReadSeq` cujo autor não é a identidade local, não deletadas e não
`hiddenByBan`; `pendingMentions` = subconjunto que menciona a identidade, um cargo dela ou
`everyone` efetivo — **e menção conta mesmo em canal silenciado**. `firstUnreadSeq` é o
menor `seq` do conjunto. `lastReadSeq` avança com o canal aberto e rolado até o fim, ou por
`channel.markRead`.

**Recálculo (fecha `F-25`, `F-48`):** `local_read_state` é atualizado **incrementalmente**
pelo projetor a cada lote e **recomputado do zero** em duas situações, ambas dentro da
mesma transação: reprojeção total, e `roles.changed` que afete os cargos da identidade
local (porque `pendingMentions` depende deles). Nunca há contagem dupla porque
`lastReadSeq` é o watermark e a contagem é uma query sobre `seq > lastReadSeq`, não um
acumulador.

**Emenda de 2026-08-22 — onde o cálculo mora.** "`local_read_state` mora no `manifest.db`
(LS) e é por instalação; pô-lo no `fold` faria o mesmo log produzir contagens diferentes
por réplica (§8.0), e o `Effect` de §8.4 é tipo fechado sobre as tabelas de CS. O cálculo
mora então num serviço da **raiz de composição**, ligado ao gancho de lote projetado
(`notifyProjected`, o mesmo passo síncrono do fan-out): a cada lote ele reconta os canais
atingidos — os tocados pelo lote **mais** todo canal que já tem linha no LS, porque
mutação de linha velha (edição, tombstone, ocultação/reversão de ban via `patchScope`) não
move `seq` — pela MESMA query que define a contagem, escreve no LS na hora e emite
`unread.changed`. Recálculo do zero acontece na primeira marca do serviço (boot/reprojeção)
e quando a assinatura dos cargos locais muda. O projetor continua sem saber que LS existe."

**Emenda de 2026-08-22 (micro) — `local_device_pref`:** a tabela ganha o campo
`notificationsEnabled`, o flag global de `settings.setNotifications`; o nível por
comunidade continua em `local_community_pref.notificationLevel`.

### 6.16 Entidades efêmeras (nunca persistem)

| Entidade | TTL | Fan-out | Campos |
|---|---|---|---|
| `Presence` | 45 s, refresh 15 s | host agrega e emite delta a cada `PRESENCE_TICK_MS` | `identityKey`, `status` |
| `Typing` | 5 s, refresh 3 s | host → **só assinantes do canal** | `identityKey`, `channelId` |
| `VoiceOccupancy` | enquanto a sessão vive | host → **todos os membros conectados** | `channelId`, `count`, `firstKeys[≤5]` — fecha `RT-05` |
| `VoiceRoster` | enquanto a sessão vive; participante sai por `VOICE_LIVENESS_MS` sem sinal | host → **participantes** | `channelId`, `participants[{key,muted,deafened,cameraOn,sharing,speaking}]` — `speaking` fecha `DR-42` |
| `ShareSession` | enquanto transmite **e enquanto quem apresenta está na chamada** | host → participantes | `sessionId`, `presenterKey`, `channelId`, `topology`, `viewerCount` |
| `ShareHealth` | idem | host → **só o apresentador** | `viewers[{key, rttMs, lossPct, quality}]` — destinatário declarado, fecha `RT-08` |

`invisible` **não publica** presença **nem `typing`**, e continua recebendo tudo. Exceção
declarada: entrar em canal de voz publica presença mesmo com `invisible` — voz é presença por
definição; a UI avisa.

**Emenda de 2026-09-05 — por que `typing` entrou na frase.** O texto dizia só "presença", e
`presencePublish{status, typingChannelId?}` (§16.2) carrega os dois no MESMO quadro: o host
descartava a presença do invisível e publicava o "digitando…" logo em seguida, que revela
exatamente o que a presença esconde — identidade, canal e o fato de a pessoa estar conectada
agora. Publicar um enquanto se recusa o outro deixava o modo invisível meia-porta. A
publicação não é **recusada** (não é erro do cliente): ela simplesmente não vira `typing`.

**Emenda de 2026-08-26 — "enquanto a sessão vive" não dizia quem a mata.** As três linhas de
chamada declaravam duração por referência a si mesmas, e isso lia como "para sempre" no caso
que importa: o participante que some sem avisar. `VoiceRoster` ganha o prazo de vivacidade de
§17.4; `ShareSession` ganha a condição que A19 já implicava e que ninguém aplicava depois da
entrada (§17.5). `VoiceOccupancy` é derivada do roster e se corrige junto — a ocupação de um
canal só volta a zero porque a última pessoa saiu dele.

**`speaking`** é **produzido pelo renderer** (VAD local sobre o próprio microfone), enviado
ao host em `voiceState{speaking}` com histerese de 200 ms, e reemitido no roster. Não é
inferido pelo núcleo, que não vê mídia.

### 6.17 Invariantes — o que elas são em v2

Em v1, violar invariante abortava a projeção e parava a comunidade. Em v2 isso é
**proibido**: o `fold` é total (§8.5) e as invariantes são **propriedades verificáveis**,
não guardas de execução.

| # | Propriedade (verificada em teste e em `dev`, contada como métrica em produção) |
|---|---|
| P-1 | Toda comunidade tem ≥ 1 canal não deletado |
| P-2 | Exatamente 1 cargo `isFounder` e 1 `isDefault` por comunidade |
| P-3 | Todo membro ativo tem o cargo base |
| P-4 | `rank` de cargo é único dentro da comunidade; o Fundador é o máximo |
| P-5 | Todo canal aponta para categoria não deletada da mesma comunidade |
| P-6 | Toda mensagem **listável** aponta para canal de texto não deletado |
| P-7 | `replyToId` e `threadId` são do mesmo canal |
| P-8 | Nenhuma reação visível aponta para mensagem deletada |
| P-9 | `memberCount` = membros ativos não banidos; `memberCount` de cargo = membros ativos com o cargo |
| P-10 | `interpretedSeq` = maior `seq` interpretado; **não há buraco**, porque todo registro é interpretado-ou-explicitamente-ignorado, e ambos avançam o contador (fecha `F-40`) |
| P-11 | Reprojetar do `seq` 0 produz `CS` byte-a-byte idêntico (hash de dump ordenado) |

**Em produção**, uma violação de P-1..P-9 incrementa `fold.propertyViolation{p}` e **não
interrompe nada**. Uma violação é bug do `fold` e deve ser corrigida com um `opVersion`
novo, não com uma parada de emergência.

---

## 7. Log de operações

### 7.1 Estruturas assinadas

```
Op         = { v:uint8, communityId:bytes[32], kind:uint16, author:bytes[32],
               sequenceScope:Scope, authorSeq:uint64, ts:uint64, payload:bytes }
Envelope   = { op:bytes, sig:bytes[64] }      sig = Ed25519(author, BLAKE2b('op/1' ‖ op))
HostRecord = { envelope:bytes, hostTs:uint64, flags:uint8, hostSig:bytes[64] }
              hostSig = Ed25519(coreKeyPair, BLAKE2b('hostrec/1' ‖ envelope ‖ hostTs ‖ flags))
```

`Scope = community | channel(channelId)`. `sequenceScope` faz parte do material assinado e
tem encoding canônico. As seis operações de domínio de mensagem enfileiráveis usam
`channel(channelId)`; `message.edit`, `message.delete`, `message.pin`, `reaction.set` e
`thread.create` carregam um escopo que o `fold` confere contra o alvo. Operações sem canal,
inclusive a gênese e a exceção `member.leave`, usam `community`. Escopo incompatível com o
`kind` ou com o alvo é `E_VALIDATION` no campo `sequenceScope` e não avança o contador.

`HostRecord` é o que é appendado. `seq` é implícito (índice no core).

**Três mudanças em relação a v1, todas normativas:**

1. **`communityId` está dentro do material assinado.** Um envelope colhido do log de A não
   tem efeito nenhum no log de B: o `fold` de B recusa no estágio 3 (§8.2). Fecha `T-01`.
2. **`authorSeq` substitui `nonce`.** Contador monotônico estritamente crescente por
   `(author, communityId, sequenceScope)`, mantido em `manifest.local_author_seq` e
   reconciliado no boot por escopo com `max(local, lastAuthorSeq observado no log) + 1`.
   Fecha `T-05`, `DS-03`, `DS-20`, `F-36` e elimina a janela de dedupe de 7 dias (§7.5).
3. **`hostTs` e `flags` são assinados pelo host.** Um host não pode reescrever carimbo nem
   `clockSkewed` sem que a assinatura falhe. Fecha `T-27`, `DS-13`.

`flags`: bit 0 `clockSkewed`; bits 1–7 reservados. Leitores ignoram bits desconhecidos.

### 7.2 Encoding

`compact-encoding`, com **registry versionado por `kind`**. `kind` é um `uint16` de um
enum fechado (§7.4) — nunca uma string no fio. A versão está no cabeçalho da `Op`.
Na versão de produto desta emenda, `v = 3`. O fio de `v = 3` é **byte a byte o de `v = 2`**:
o bump é semântico, e existe porque §13.8 relaxou uma regra do `fold` — o mesmo log projeta
diferente nas duas versões, e a regra 5 abaixo é o que impede duas instalações de divergirem
em silêncio. `v = 1` pertence ao protocolo experimental anterior e não é reinterpretado como
se tivesse `sequenceScope`.

Regras invioláveis:

1. Dentro de um mesmo `v`, campo **nunca** é removido nem tem o tipo trocado. Acrescentar
   campo opcional **no fim** é a única evolução permitida.
2. **Leitor tolerante:** bytes sobrando no fim do payload são ignorados.
3. **Escritor estrito:** o cliente só escreve `v` que conhece por inteiro.
4. `v` desconhecido, `kind` desconhecido, ou payload que não decodifica → o registro é
   `IGNORED` (§8.2 estágio 2), contado no `seq`, sem efeito, com métrica. **Nunca** para a
   projeção.
5. Uma comunidade com ≥ 1 registro `IGNORED` por versão desconhecida entra no estado
   `partialInterpretation = true`: **as escritas locais naquela comunidade são bloqueadas**
   com `E_VERSION_UNSUPPORTED` e a UI exibe "seu cliente está desatualizado". Fecha `F-07`
   (o leitor tolerante deixa de destruir as propriedades) e `DS-25`.

**Forma canônica** (para `opId`): campos na ordem declarada, sem padding, campo opcional
ausente não é escrito.

#### 7.2.1 Layout dos tipos primitivos do registry

| Tipo do registry | Encoding |
|---|---|
| `u8`, `u16`, `u32`, `u64` | `compact-encoding` `uint8/16/32/64`, little-endian |
| `Scope` | `u8` tag `0` para `community`; tag `1` seguido de `str channelId` para `channel` |
| `key` | `fixed32` |
| `sig` | `fixed64` |
| `str` | `string` (uint prefixado, UTF-8) |
| `id` | `string` — **prefixo de entidade + 26 caracteres** Crockford-Base32 (§7.3), 29 a 32 caracteres no total conforme o prefixo |
| `rank` | `string` base62 (`0-9A-Za-z`), 1–`RANK_MAX_LEN` (64) caracteres; nunca termina em `0` (§6.4.1) |
| `bool` | `uint8` 0/1 |
| `opt<T>` | `uint8` presente(1)/ausente(0) seguido de `T` quando presente |
| `arr<T>` | `uint` de contagem seguido de `T` repetido |
| `bytes` | `buffer` (uint prefixado) |
| `blobref` | `key blobsCoreKey · u64 byteOffset · u64 blockOffset · u64 blockLength · u64 byteLength` |

**Regra que fecha `DR-10`:** nenhum `kind` pode ser implementado sem sua linha de payload
em §7.4. Um `kind` sem layout declarado é `E_UNKNOWN_KIND` na escrita e `IGNORED` na
leitura.

### 7.3 Identificadores determinísticos

```
opId          = BLAKE2b-256('opid/1' ‖ envelopeCanônico)                 → 32 B, hex
entityId(t)   = 'PREFIXO' + crockford32(BLAKE2b-128('id/' ‖ t ‖ '/2'
                              ‖ communityId ‖ sequenceScope ‖ author ‖ authorSeq)) → prefixo + 26 chars
```

| Entidade | `t` | Prefixo | Exemplo |
|---|---|---|---|
| Message | `message` | `msg-` | `msg-8g3k...` (26 chars) |
| Channel | `channel` | `ch-` | — |
| Category | `category` | `cat-` | — |
| Role | `role` | `role-` | — |
| Thread | `thread` | `thr-` | — |
| ModerationEntry | `modentry` | `mod-` | — |

**Propriedades que isso garante e que v1 não tinha:**
- 128 bits, não 48 → colisão dirigida deixa de ser viável (fecha `T-30`, `F-05`).
- Escopado por comunidade → não atravessa fronteira (fecha `T-30`).
- Derivado de `(author, sequenceScope, authorSeq)`, que é único por construção → **duas ops
  distintas não podem produzir o mesmo id**, e a mesma op reproduz o mesmo id em toda
  reprojeção (fecha `DR-11`).
- Nenhum id é "gerado pelo host" — o que quebrava reprojeção determinística em v1.

Chave primária de toda tabela de `CS` é `(community_id, id)`.

### 7.4 Catálogo de ops

`Perm.` = permissão exigida · `Hier.` = exige hierarquia estrita sobre o alvo · `Aud.` =
gera entrada de auditoria · `Fila` = pode ser enfileirada na outbox (§11.1).

#### 7.4.1 Mensagem — domínio enfileirável

| `kind` | # | Payload | Perm. | Hier. | Aud. | Fila |
|---|---:|---|---|---|---|---|
| `message.send` | 1 | `id channelId · str content · arr<str> mentions · opt<blobref+meta> attachment · opt<id> replyToId · opt<id> threadId` | `send_messages` (+`attach_files` se anexo) | — | — | **sim** |
| `message.edit` | 2 | `id messageId · str content` | própria | — | — | **sim** |
| `message.delete` | 3 | `id messageId · opt<str> reason` | própria \| `manage_messages` | se de outro | se de outro | **sim** |
| `message.pin` | 4 | `id messageId · bool pinned` | `pin_messages` | — | — | **sim** |
| `reaction.set` | 5 | `id messageId · str emoji · bool present` | `add_reactions` | — | — | **sim** |
| `thread.create` | 6 | `id rootMessageId` | `send_messages` | — | — | **sim** |

`attachment` completo: `blobref · str name · u64 sizeBytes · u8 kind · key hash`.

#### 7.4.2 Estrutura — síncrona, não enfileirável

| `kind` | # | Payload | Perm. | Aud. |
|---|---:|---|---|---|
| `channel.create` | 10 | `id categoryId · u8 type · str name · opt<str> topic · arr<id> readOnlyForRoleIds · opt<u8> speechMode · opt<u16> queueTurnSeconds · opt<rank> afterRank · opt<rank> beforeRank` | `manage_channels` | sim |
| `channel.update` | 11 | `id channelId · opt<str> name · opt<str> topic · opt<arr<id>> readOnlyForRoleIds · opt<u8> speechMode · opt<u16> queueTurnSeconds` | `manage_channels` | sim |
| `channel.move` | 12 | `id channelId · id categoryId · opt<rank> afterRank · opt<rank> beforeRank` | `manage_channels` | — |
| `channel.delete` | 13 | `id channelId` | `manage_channels` | sim |
| `category.create` | 14 | `str name · opt<rank> afterRank · opt<rank> beforeRank` | `manage_channels` | sim |
| `category.rename` | 15 | `id categoryId · str name` | `manage_channels` | sim |
| `category.delete` | 16 | `id categoryId · opt<id> moveChannelsTo · bool deleteChannels` | `manage_channels` | sim |

#### 7.4.3 Cargos e membros — síncrona

| `kind` | # | Payload | Perm. | Hier. | Aud. |
|---|---:|---|---|---|---|
| `role.create` | 20 | `str name · u8 color · arr<u8> permissions · bool mentionable · opt<rank> afterRank · opt<rank> beforeRank` | `manage_roles` | — | sim |
| `role.update` | 21 | `id roleId · opt<str> name · opt<u8> color · opt<arr<u8>> permissions · opt<bool> mentionable` | `manage_roles` | sim | sim |
| `role.move` | 22 | `id roleId · opt<rank> afterRank · opt<rank> beforeRank` | `manage_roles` | sim | — |
| `role.delete` | 23 | `id roleId` | `manage_roles` | sim | sim |
| `member.setRoles` | 24 | `key targetKey · arr<id> roleIds` | `manage_roles` | sim | — |
| `member.join` | 25 | `key invitePublicKey · sig joinProof · str displayName · u8 avatarColor · key blobsCoreKey` | — (autorizado pelo convite) | — | — |
| `member.leave` | 26 | *(vazio)* | — | — | — |
| `member.setNickname` | 27 | `opt<str> nickname` | — (só o próprio) | — | — |
| `member.setBlobsCore` | 28 | `key blobsCoreKey` | — (só o próprio) | — | — |
| `identity.update` | 29 | `opt<str> displayName · opt<u8> avatarColor` | — | — | — |

#### 7.4.4 Moderação — síncrona

| `kind` | # | Payload | Perm. | Hier. | Aud. |
|---|---:|---|---|---|---|
| `mod.kick` | 30 | `key targetKey · opt<str> reason` | `kick_members` | sim | sim |
| `mod.ban` | 31 | `key targetKey · opt<str> reason` | `ban_members` | sim | sim |
| `mod.revokeBan` | 32 | `key targetKey` | `ban_members` | — | sim |
| `mod.timeout` | 33 | `key targetKey · u64 until · opt<str> reason` | `timeout_members` | sim | sim |
| `mod.removeTimeout` | 34 | `key targetKey` | `timeout_members` | — | sim |

#### 7.4.5 Comunidade, convite, rede — síncrona

| `kind` | # | Payload | Perm. | Aud. |
|---|---:|---|---|---|
| `community.create` | 40 | `str name · opt<str> iconEmoji · u8 iconColor · opt<str> description · key blobsKey · opt<str> originCommunityId · opt<u64> originFinalSeq` | — (gênese) | — |
| `community.update` | 41 | `opt<str> name · opt<str> iconEmoji · opt<u8> iconColor · opt<str> description` | `manage_community` | sim |
| `community.end` | 42 | `opt<str> reason` | host | sim |
| `community.setSuccessors` | 43 | `arr<key> successorKeys` | host | sim |
| `community.escrow` | 44 | `key targetKey · bytes wrappedSeed` | host | — |
| `community.assumeHost` | 45 | `key newHostKey · u64 observedHostTs · sig proof` | sucessor (§18.8) | sim |
| `invite.create` | 50 | `key invitePublicKey · opt<u64> expiresAt · opt<u32> maxUses · opt<str> label` | `create_invite` | — |
| `invite.revoke` | 51 | `key invitePublicKey` | autor do convite \| `manage_community` | sim |
| `relay.volunteer` | 60 | `key relayPublicKey · u64 expiresAt · sig possession` | — | — |
| `relay.withdraw` | 61 | *(vazio)* | — | — |

**Total: 38 `kind`s.** O número é normativo e fechado para `opVersion = 3` — o bump de
2026-09-04 não acrescenta nem remove `kind` nenhum. Fecha `F-23`.

Para os `kind`s com `Fila = sim`, `sequenceScope` é o canal referido pela operação. Os
`kind`s sem canal usam `sequenceScope = community`; isso inclui as operações síncronas e o
`member.leave`, que é a única exceção não-mensagem enfileirada (§11.1). A escolha do escopo
não é uma propriedade local da outbox: ela é validada pelo `fold` em toda réplica.

### 7.5 Idempotência sem janela

v1 dependia de uma tabela `dedupe(opId)` com janela de 7 dias, num store sem transação
comum com o log — a origem de `DS-03`, `T-05`, `DS-12` e metade de `B5`.

v2:

| Questão | Resposta |
|---|---|
| O que impede duplicata? | `(author, sequenceScope, authorSeq)`. O `fold` mantém `lastAuthorSeq[author, sequenceScope]` no `DS` e **ignora** todo registro com `authorSeq ≤ lastAuthorSeq[author, sequenceScope]` (§8.2 estágio 6). |
| Isso é durável? | Sim, por construção: é derivado do log, não de um store paralelo. Crash não pode dessincronizar. |
| E depois de N dias? | Não há janela. Um envelope de dois anos atrás, reenviado, continua sendo ignorado. |
| Custo de memória? | `O(autores × escopos usados)` por comunidade: um `uint64` por par autor/escopo. |
| O cliente pode ter buracos em `authorSeq`? | Sim. A regra é **estritamente crescente**, não densa. Uma op recusada antes do append queima o número. |
| Como o cliente sabe que a op entrou? | Procurando o `opId` entre as operações `APPLIED` da própria réplica projetada (§11.6). Não pela palavra do host nem por uma marca d'água. |
| E se o cliente perder o contador? | Boot reconcilia por `(communityId, sequenceScope)`: `next = max(manifest, lastAuthorSeq no log) + 1`. |
| Reenvio produz o mesmo `opId`? | Sim — o envelope é armazenado assinado e **nunca reassinado**. |

**Ordem canônica:** o `seq` do registro no core do host. Não há relógio vetorial, não há
reordenação retroativa. "Última escrita vence" = maior `seq`.

---

## 8. O `fold` — a interpretação normativa

Esta é a seção mais importante do documento. Ela substitui, de uma vez, o "pipeline de
validação" (§9 de v1), os "reducers" (§3.2/§6.4 de v1) e a "concorrência" (§12 de v1).

### 8.0 Assinatura do módulo

```ts
// L1, puro. Sem I/O, sem relógio, sem configuração, sem exceção.
type FoldResult = {
  decision: 'APPLIED' | 'REJECTED' | 'IGNORED'
  reason?: ErrorCode           // presente quando REJECTED ou IGNORED
  field?: string               // §20.1 — presente em E_VALIDATION
  limit?: number               // §20.2 — presente em E_LIMIT_EXCEEDED
  hostTsClamped?: boolean      // R-1 — o registro trouxe hostTs retroativo e foi clampado
  kind?: number                // §7.4 — presente a partir do decode do `Op` (estágio 2)
  author?: Key                 // §7.1 — idem; é `op.author`, tal como decodificado
  opId?: string                // presente em APPLIED; chave de `observed_ops` (§10.3)
  authorSeq?: uint64            // presente em APPLIED; metadado do mesmo decode
  sequenceScope?: Scope        // presente em APPLIED; metadado do mesmo decode
  effects: Effect[]            // vazio quando não APPLIED
  next: DecisionState          // sempre presente; quando não APPLIED difere de `prev`
                               // apenas em `interpretedSeq`, `lastAuthorSeq` e
                               // `partialInterpretation` (§8.2). O `CS` não muda.
}

function foldRecord(prev: DecisionState, rec: RawRecord, seq: number): FoldResult
```

Isso fecha `DR-14` (a assinatura de `validate` não existia) e `DR-28` (nenhuma camada podia
montar o estado de validação): o estado é `DecisionState`, ele é argumento e resultado, e o
módulo é L1 puro. Nenhuma camada precisa violar a regra de dependência.

**`kind` e `author` — a fonte do diagnóstico (fecha `H-21` e `H-26`).** Os dois são
preenchidos **exatamente a partir do momento em que o `Op` decodifica**, dentro do estágio 2
de §8.2, e ficam ausentes em todo desfecho anterior a esse ponto — um registro recusado no
estágio 0 (teto de bytes, antes de qualquer decode) não tem `kind` nem autor, e nenhuma
camada pode inventá-los. `kind` é o número de §7.4 **como veio no registro**, inclusive
quando é desconhecido deste binário (o desfecho aí é `IGNORED`, e o número é o que permite
diagnosticar de qual versão ele veio).

São **metadado de desfecho, não decisão**: não entram no `DecisionState`, não influenciam
nenhum estágio e nenhuma regra `R-*`, e removê-los não muda uma única interpretação. Estão
na assinatura pela mesma razão que `field`, `limit` e `hostTsClamped`: existe requisito
normativo que os consome e não havia de onde tirá-los. São eles que dão fonte a

`opId`, `authorSeq` e `sequenceScope` têm a mesma origem, mas são exigidos somente no
desfecho `APPLIED`: o projector precisa materializar `observed_ops` sem decodificar o
registro. Os três também são metadados, não entram no `DecisionState` nem alteram o desfecho.

- `rejected_records.kind` e `.author_key` (§10.3) — o "quando aplicável" da tabela de
  desfechos abaixo passa a significar **isto**, e nada mais; e
- o `kind` de `fold.panic{seq, kind}` (§8.5), que o `projector` não tem como obter de outro
  jeito: ele **não decodifica registro** (§4), e um `fold` que lança pode ter lançado antes
  do decode.

Três desfechos, e só três:

| Desfecho | Significado | Efeito no `CS` | Avança `interpretedSeq` |
|---|---|---|---|
| `APPLIED` | O registro é válido e autorizado | Sim | Sim |
| `REJECTED` | Sintaxe válida, mas o `fold` recusa (autorização, limite, unicidade, duplicata) | Não (só métrica e `rejected_records`; `kind`/`author_key` presentes sse o `Op` decodificou) | Sim |
| `IGNORED` | O registro não é interpretável por este binário (versão/`kind`/decode) | Não | Sim, e marca `partialInterpretation` |

**Não existe um quarto desfecho.** Não existe "abortar", "parar", "degradar a comunidade"
nem "lançar". §8.5.

### 8.1 `DecisionState` — schema exato

Estrutura em memória, por comunidade. Tudo aqui é derivado do log e recomputável.

```ts
type DecisionState = {
  communityId: string
  interpretedSeq: number            // −1 antes do primeiro registro
  opVersionSeen: number
  partialInterpretation: boolean
  communityInvalid: boolean         // gênese fora da forma de R-27; absorvente
  lastHostTs: number                // monotonicidade (R-1)

  community: {
    exists: boolean
    hostKey: Key
    founderKey: Key                 // imutável: autor do lote de gênese
    blobsKey: Key
    name: string; iconEmoji?: string; iconColor: number; description?: string
    createdAt: number; endedAt?: number
    successorKeys: Key[]
    originCommunityId?: string
    originFinalSeq?: number         // R-18(a) — material da prova de sucessão (fecha `H-19`)
  }

  members: Map<KeyHex, {
    state: 'active' | 'left' | 'banned'
    roleIds: Set<Id>
    displayName: string; avatarColor: number; nickname?: string
    displayNameCollision?: true     // L-5 (§6.1) — derivada do conjunto ATIVO
    blobsCoreKey?: Key
    joinedAt: number; leftAt?: number
    timeoutUntil?: number
    bannedAt?: number; bannedBy?: Key
    preBan?: true                   // R-28 — linha nascida de ban sem membresia
    storageUsedBytes: number
    opBudget: RingCounter           // R-15
    byteBudget: RingCounter         // R-15
  }>

  roles: Map<Id, { name, color, rank, permissions: Set<Perm>,
                   mentionable, isFounder, isDefault, deletedAt? }>
  categories: Map<Id, { name, rank, deletedAt? }>
  channels:  Map<Id, { categoryId, type, name, topic?, rank,
                       readOnlyForRoleIds: Set<Id>, deletedAt? }>
  channelNameIndex: Map<`${type}:${name}`, Id>   // unicidade (R-6)

  messages: Map<Id, { channelId, authorKey, deletedAt?, pinned,
                      threadId?, hasAttachment, attachmentBytes,
                      reactions: Map<Emoji, Set<KeyHex>>,   // §6.9 — R-23 conta as CHAVES
                      hiddenByBan, orphaned }>
  rootOfThread: Map<Id, Id>         // threadId → mensagem raiz (fecha `A-04`)

  invites: Map<KeyHex, { createdBy: Key, createdAt, expiresAt?, maxUses?,
                         uses: number, revokedAt? }>
  joinedByInvite: Set<`${invitePkHex}:${candidateHex}`>   // R-9

  lastAuthorSeq: Map<`${KeyHex}:${sequenceScope}`, number> // §7.5

  relays: Map<KeyHex, { relayPublicKey: Key, expiresAt: number, withdrawnAt?: number }>
}
```

**Três campos que o schema declarava sem declarar (emenda de 2026-09-04).** `orphaned` era
exigido por §8.4.1 ("canal deletado depois de mensagens existentes ⇒ `orphaned = 1`") e tinha
coluna em §10.3, mas não aparecia aqui; `displayNameCollision` era exigido por §6.1 L-5, tinha
coluna em §10.3 e **não tinha efeito que o escrevesse** (corrigido em §8.4); `preBan` era
exigido por R-28 para o `member.join` posterior não herdar o `joinedAt` do ban. Os três são
derivados do log como todo o resto do `DecisionState`, e são a mesma família de `HOLE-11`
(`communityInvalid`) e `H-19` (`originFinalSeq`): campo sem o qual uma regra declarada não é
implementável. **Consequência do primeiro deles para o snapshot:** o que está no `DecisionState`
e **não** é rematerializável de `view.db` precisa entrar no blob de §10.6 — `displayNameCollision`
é função do conjunto ativo inteiro, não do registro corrente, e nenhum registro futuro o
recalcula para quem já estava lá.

**`reactions` guarda o reagente, não só o emoji.** §6.9 define a vaga de R-23 como "emoji com
ao menos um reagente", e decidir isso exige saber quem reagiu — a mesma PK
`(messageId, emoji, identityKey)` de §10.3, espelhada em memória. O custo é proporcional às
reações vivas, que é exatamente o que `view.db` já guarda; a estimativa de ~120 B por mensagem
abaixo continua valendo para mensagem sem reação, que é a esmagadora maioria.

**`rootOfThread`, e por que a direção é essa (fecha `A-04`).** O campo se chamava
`threadsByRoot`, indexado pela raiz — e o nome contradizia todo uso que §8.3 faz dele. R-8
precisa resolver `threadId → canal` em O(1) a cada `message.send` numa thread; R-24 ("uma
thread por mensagem raiz") **já** é O(1) sem índice nenhum, porque a `MessageMeta` da raiz
carrega o `threadId` da própria thread. Indexado por raiz, R-24 ficava barato e R-8 virava
varredura do mapa inteiro. `threadId → raiz` é a única direção em que **toda** regra de §8.3 é
implementável com o schema declarado e nada mais.

**Custo de memória (ordem de grandeza, a medir em G9):** dominado por `members` e
`messages`. `messages` guarda só metadados de decisão (~120 B/mensagem). Uma comunidade com
200 000 mensagens ≈ 24 MiB. Com 50 comunidades abertas isso não fecha, então:

> **Regra de residência do `DS` (normativa):** `messages` e `rootOfThread` são carregados
> sob demanda a partir de `view.db` (que os materializa) **apenas** para as comunidades com
> `residency = 'full'`. Comunidades em `residency = 'light'` mantêm o resto do `DS` (que é
> `O(membros + canais + cargos)`, alguns KiB) e resolvem consultas de mensagem por lookup
> indexado em `view.db` **dentro da mesma transação de projeção**. O lookup é uma leitura de
> chave primária, determinística e local, e por isso **não** reintroduz a corrida de v1: ele
> lê o estado já projetado do **mesmo prefixo** que o `fold` já interpretou, nunca um estado
> atrasado.
>
> `residency = 'full'` para a comunidade ativa e para toda comunidade em modo host.
> `'light'` para as demais. A troca acontece em `community.activate` (§15.4).

Isso é a única leitura de banco que o `fold` faz, é explicitamente delimitada, é
determinística, e é a razão pela qual a assinatura real do módulo recebe um
`MessageLookup` injetado — uma função pura do prefixo já interpretado.

### 8.2 Pipeline de admissão (ordem fixa, determinística)

Roda **idêntico** em toda réplica, para todo registro, sempre. É a única definição de
"válido" que existe no sistema.

| # | Estágio | Desfecho da falha |
|---:|---|---|
| **0** | **Teto de bytes do registro**, antes de qualquer decode ou verificação de assinatura: `len(rec) ≤ MAX_ENVELOPE_BYTES_ATTACHMENT` (64 KiB, o teto absoluto). Custo O(1) | `REJECTED` — `E_PAYLOAD_TOO_LARGE` |
| 1 | `HostRecord` decodifica; `hostSig` válida sobre a chave do core | `IGNORED` — `E_BAD_HOST_SIGNATURE` |
| 2 | `Envelope`/`Op` decodificam; `v` e `kind` conhecidos; payload casa o layout de §7.4 | `IGNORED` — `E_MALFORMED` / `E_UNKNOWN_KIND`; liga `partialInterpretation` só no caso de versão/`kind` desconhecido |
| 3 | `op.communityId === state.communityId` | `REJECTED` — `E_WRONG_COMMUNITY` |
| 4 | `sig` válida sobre `BLAKE2b('op/1' ‖ op)` com `op.author` | `REJECTED` — `E_BAD_SIGNATURE` |
| 5 | `hostTs ≥ state.lastHostTs` (senão clampa, R-1) e comunidade não `ended` (exceto o próprio `community.end`) | `REJECTED` — `E_COMMUNITY_ENDED` |
| 6 | `authorSeq > lastAuthorSeq[author, sequenceScope]` e `sequenceScope` compatível com o `kind`/alvo | `REJECTED` — `E_DUPLICATE` ou `E_VALIDATION` em `sequenceScope` (é **sucesso** do ponto de vista do cliente só no primeiro caso, §11.6) |
| 7 | `|op.ts − hostTs| ≤ CLOCK_ACCEPT_MS` (24 h) | `REJECTED` — `E_CLOCK_UNREASONABLE` |
| 8 | Autor é membro ativo não banido — exceto `member.join` (o autor é o candidato). Durante a gênese o **principal de gênese** de R-27(a) satisfaz este estágio por construção; não há suspensão | `REJECTED` — `E_NOT_MEMBER` / `E_BANNED` |
| 9 | Sem timeout ativo (`timeoutUntil > hostTs`), exceto `member.leave` | `REJECTED` — `E_TIMED_OUT` |
| 10 | Cota determinística de escrita do autor (R-15) | `REJECTED` — `E_QUOTA_EXCEEDED` |
| 11 | Permissão do `kind` (§9.4) | `REJECTED` — `E_PERMISSION_DENIED` |
| 12 | Hierarquia sobre o alvo, quando aplicável (§9.3) | `REJECTED` — `E_HIERARCHY` / `E_FOUNDER_IMMUNE` / `E_HOST_IMMUNE` |
| 13 | Limites de campo (§8.6) | `REJECTED` — `E_VALIDATION` + `field` |
| 14 | Regras estruturais do `kind` (§8.3) | `REJECTED` — código específico da regra |
| 15 | Emissão de efeitos (§8.4) e avanço do `DS` | `APPLIED` |

Em **todos** os desfechos o estágio final atualiza `interpretedSeq = seq` e, quando o
registro chegou ao estágio 6, também `lastAuthorSeq[author, sequenceScope] = authorSeq` —
inclusive em `REJECTED`. Isso é o que impede um autor de reciclar o número dentro daquele
escopo depois de uma recusa; uma recusa em um canal não avança o contador de outro canal.

**Como o estágio 6 confere o escopo contra o alvo, `kind` a `kind` (nota de 2026-09-04).** §7.1
divide os seis `kind`s de escopo de canal em dois grupos, e a diferença é onde o canal está:

- `message.send` carrega o canal **no próprio payload** (`channelId`), e a conferência é a
  comparação direta `payload.channelId == sequenceScope.channelId`. Não há alvo a resolver no
  `DecisionState`, e procurar um ali é procurar id de mensagem onde há id de canal — o lookup
  nunca casa e a conferência vira no-op silenciosa.
- `message.edit`, `message.delete`, `message.pin`, `reaction.set` e `thread.create` carregam o
  id de uma **mensagem**, e a conferência é contra o canal dela. Alvo que o `DS` não conhece
  não tem canal a comparar: o estágio 6 deixa passar e o estágio 14 devolve `E_NOT_FOUND`, que
  é o erro que a UI sabe explicar.

O estágio 2 é também a **fronteira de diagnóstico**: assim que o `Op` decodifica, o
`FoldResult` passa a carregar `kind` e `author` (§8.0), em qualquer desfecho posterior. Antes
dele — ou seja, só no estágio 0, o único que recusa sem decodificar — os dois são ausentes, e
é por isso que `rejected_records` os declara anuláveis (§10.3).

**Por que existe um estágio 0 (fecha `HOLE-04`).** `MAX_ENVELOPE_BYTES` e
`E_PAYLOAD_TOO_LARGE` existiam em §26.2/§27.1/§20.2 sem nenhum ponto de aplicação no
`fold`: §14.4 impõe teto **no transporte**, e o host adversário de §1.4 não passa pelo
transporte — ele appenda direto. O teto declarado não vinculava ninguém, e um prefixo de
tamanho hostil fazia o decodificador alocar antes de concluir que a entrada é malformada.
O estágio 0 roda **antes** do estágio 1 justamente para que nem o decode nem o Ed25519
sejam pagos por um registro que já é grande demais; a numeração começa em 0 para **não**
renumerar os quinze estágios existentes, que são referenciados por número em R-27, §9.3,
§20.2 e no plano de validação.

**Ordem que fecha `DS-09` e `T-08` no host:** os estágios 1–7 são baratos. O trabalho caro
por conexão (Ed25519 no estágio 4) roda depois do **controle de admissão do transporte**
(§14.4), que é onde estão o teto de bytes, o token bucket por par e o orçamento de
conexão. O `fold` em si não faz controle de admissão de rede — ele é puro.

### 8.3 Regras estruturais (`R-*`), determinísticas e completas

Toda regra abaixo é decidida **só** com `DecisionState`. Nenhuma consulta relógio, rede,
configuração ou banco fora do `MessageLookup` de §8.1.

| # | Regra | Aplica a | Falha |
|---|---|---|---|
| R-1 | `hostTs` é monotônico não decrescente. Se o registro trouxer `hostTs < lastHostTs`, o `fold` usa `lastHostTs` no lugar (clamp determinístico) e conta `fold.hostTsClamped` | todos | — (clamp, não recusa) |
| R-2 | `|op.ts − hostTsEfetivo| ≤ 24 h` | todos | `E_CLOCK_UNREASONABLE` |
| R-3 | Todo membro ativo contém o cargo base em `roleIds`; remover o base é recusado | `member.setRoles` | `E_BASE_ROLE_REQUIRED` |
| R-4 | Nenhum cargo do alvo pode ter `rank ≥ topRank(autor)`; nenhum cargo atribuído pode ter `rank ≥ topRank(autor)` | `member.setRoles`, `role.*` | `E_HIERARCHY` |
| R-5 | Ninguém concede a um cargo permissão que não possui no conjunto efetivo | `role.create`, `role.update` | `E_PERMISSION_ESCALATION` |
| R-6 | `(type, name)` de canal é único entre não deletados. **O `fold` resolve a corrida pela ordem do log**: o primeiro `APPLIED` fica com o nome; o segundo é `REJECTED` | `channel.create`, `channel.update` | `E_CHANNEL_NAME_TAKEN` |
| R-7 | A comunidade nunca fica sem canal de texto não deletado | `channel.delete`, `category.delete` | `E_LAST_CHANNEL` |
| R-8 | `replyToId`/`threadId` existem, não estão deletados e são do mesmo canal do `channelId` da mensagem | `message.send` | `E_VALIDATION.replyToId` / `.threadId` |
| R-9 | `member.join`: `joinProof` verifica com `invitePublicKey` sobre `BLAKE2b('invite-join/1' ‖ communityId ‖ invitePk ‖ author)`; convite existe, não revogado, não expirado (`hostTs`), `uses < maxUses`; `(invitePk, author)` ainda não usado. Incrementa `uses` **no mesmo passo**. A forma zerada fica restrita ao fundador em gênese (R-27). **Vale sem exceção também na continuação de uma sucessão**: o sucessor não reconstrói membros, eles reentram assinando o próprio join (§18.8.1, L-23) | `member.join` | `E_INVITE_INVALID` / `E_INVITE_EXHAUSTED` |
| R-10 | Ban, kick, saída ou perda de `create_invite` de um membro revogam **todos** os convites que ele criou, no mesmo registro | `mod.ban`, `mod.kick`, `member.leave`, `member.setRoles`, `role.update`, `role.delete` | — (efeito, não recusa) |
| R-11 | O **cargo base** nunca pode conter nenhuma de: `manage_community`, `manage_channels`, `manage_roles`, `manage_messages`, `ban_members`, `kick_members`, `timeout_members`, `mention_everyone`, `view_audit_log`, `voice_mute_others`, `create_invite` | `role.update` sobre `isDefault` | `E_BASE_ROLE_RESTRICTED` |
| R-12 | O cargo base nunca é deletado nem tem `isDefault` removido | `role.delete`, `role.update` | `E_BASE_ROLE_REQUIRED` |
| R-13 | `everyone` na lista de menções só produz `mentionEveryoneEffective = true` se o autor tiver `mention_everyone` **no momento do registro**. Sem a permissão, a mensagem é `APPLIED` com a flag em `false`; o conteúdo não é alterado | `message.send` | — (efeito) |
| R-14 | **Removida em `opVersion = 3`** (emenda de 2026-09-04, §13.8). Era a cota de anexos por membro; `member.storageUsedBytes` continua projetado como medidor de uso, sem fronteira. O número da regra não é reaproveitado | — | — |
| R-15 | **Cotas de escrita determinísticas por autor** (fecha `HOLE-05`, define o `RingCounter` de §8.1). Seja `S` o `seq` do registro corrente e `J = {r : r.author = autor, S − QUOTA_WINDOW_SEQS < seq(r) ≤ S}` a janela **sobre `seq`, não sobre tempo**. Entram em `J` os registros do autor que **alcançaram o estágio 10**, `APPLIED` ou não — recusar num estágio posterior **não** devolve a cota, pela mesma razão de §7.5 ("uma op recusada antes do append queima o número"): sem isso, um autor inunda o log com ops que falham tarde e não paga nada. O registro corrente **conta na própria verificação**: recusa quando `|J| > QUOTA_OPS_PER_WINDOW` ou `Σ len(payload) sobre J > QUOTA_BYTES_PER_WINDOW`. `RingCounter` é **implementação** dessa função, não contrato — qualquer estrutura que compute o mesmo par (ops, bytes) sobre a mesma janela é conforme | todos exceto `member.join` | `E_QUOTA_EXCEEDED` |
| R-16 | O Fundador original e o host corrente nunca são alvo de `mod.*`; ninguém é alvo de `mod.*` sobre si mesmo | `mod.*` | `E_FOUNDER_IMMUNE` / `E_HOST_IMMUNE` / `E_SELF_TARGET` |
| R-17 | Só o `hostKey` corrente pode `community.end`, `community.setSuccessors`, `community.escrow` | — | `E_NOT_HOST` |
| R-18 | `community.assumeHost` tem **duas camadas de verificação**. **(a) Universal**, feita por toda réplica sem precisar da comunidade de origem: `proof` verifica com `originCommunityId` (que é a chave pública do core antigo, e está no payload da gênese) sobre `BLAKE2b('assume/1' ‖ newCommunityId ‖ originFinalSeq)`. Falhou → `REJECTED`. **(b) Condicional**, feita só por quem tem a comunidade de origem replicada: o autor está em `successorKeys` da origem; `hostTs − lastHostTs(origem) ≥ HOST_INACTIVITY_MS`; e nenhum sucessor de prioridade maior apresentou prova válida. Falhou → o cliente **não migra** e marca a continuação como `disputed`, sem rejeitar o registro (ele não tem base para isso na comunidade nova) | `community.assumeHost` | `E_SUCCESSION_DENIED` (camada a) |
| R-19 | `relay.volunteer`: `possession` verifica sobre `BLAKE2b('relay-possession/1' ‖ relayPublicKey)` com a chave de identidade do autor (§5.2); `expiresAt ≤ hostTs + RELAY_TTL_MS` | `relay.volunteer` | `E_VALIDATION` |
| R-20 | `role.move`, `channel.move`, `role.create`, `channel.create` e `category.create`: `rank` é recalculado pelo `fold` a partir dos vizinhos **no `DS`**, ignorando os enviados quando desatualizados (§6.4.1). **Não existe `category.move`**: a ordem de categoria é definida na criação e não é reordenável no v1 | ops de ordenação | — (efeito) |
| R-21 | `readOnlyForRoleIds` precisa deixar ≥ 1 cargo não deletado de fora, e todos os ids precisam existir | `channel.create`, `channel.update` | `E_VALIDATION.readOnlyForRoleIds` |
| R-22 | `message.send` num canal em que **todos** os cargos do autor estão em `readOnlyForRoleIds` é recusada | `message.send` | `E_CHANNEL_READ_ONLY` |
| R-23 | Máx. 20 emojis distintos por mensagem; `reaction.set{present:true}` que estoure é recusada; `present:false` nunca é recusada | `reaction.set` | `E_REACTION_LIMIT` |
| R-24 | Uma thread por mensagem raiz | `thread.create` | `E_THREAD_EXISTS` |
| R-25 | `category.delete` carrega exatamente um de `moveChannelsTo`/`deleteChannels`; o destino existe e é da mesma comunidade | `category.delete` | `E_VALIDATION` |
| R-26 | Limites de cardinalidade de §26.2 (canais, categorias, cargos, cargos por membro, convites ativos) | ops de criação | `E_LIMIT_EXCEEDED` + `limit` |
| **R-27** | **Lote de gênese.** Os registros de `seq` 0 a 5 formam a gênese: todos precisam ser autorados **pela mesma chave** (que passa a ser `founderKey`), com `authorSeq` 1..6, e com `kind` exatamente na ordem `community.create · role.create · role.create · member.join · category.create · channel.create` (§19.1). **(a) Principal de gênese.** Enquanto `seq ≤ 5` e a comunidade não está `invalid`, o autor do lote é avaliado pelo pipeline de §8.2 como **membro ativo, não banido, sem timeout**, com `efetiva(autor)` = as 17 permissões de §9.1 e `topRank(autor) = RANK_GENESIS` — sentinela estritamente maior que qualquer `rank` atribuível a um cargo. O principal de gênese vale **só** nos `seq` 0..5, não é gravado no `DecisionState` nem em `view.db`, e `RANK_GENESIS` nunca é gravado como `rank` de cargo. **Nenhum estágio de §8.2 e nenhuma regra de §8.3 são suspensos**, exceto **R-9**, que não se aplica ao `member.join` do fundador, o qual carrega `invitePublicKey` e `joinProof` zerados. **(b) Forma dos payloads, verificada pelo `fold`.** `seq` 1 é o cargo Fundador: carrega **exatamente as 17** permissões, recebe `isFounder = true` e `rank = RANK_TOP`. `seq` 2 é o cargo base: carrega um subconjunto de `{send_messages, attach_files, add_reactions, voice_speak, pin_messages}` (R-11 vale desde a criação), recebe `isDefault = true` e `rank = RANK_BOTTOM`. `seq` 3 atribui ao autor `roleIds = {Fundador, base}`. **(d) A gênese não emite auditoria** (fecha `HOLE-17`): `role.create`, `category.create` e `channel.create` estão marcados `Aud. = sim` em §7.4, mas a coluna **não se aplica nos `seq` 0..5**. §6.13 exige `byLabel` congelado no momento da aplicação, e nos `seq` 1, 2, 4 e 5 o autor ainda não é membro — o `member.join` dele é o `seq` 3 —, então o log de auditoria de **toda** comunidade nasceria com quatro entradas cujo `byLabel` é um fragmento de chave em hexadecimal. O lote de gênese é a comunidade vindo a existir, não moderação dentro dela; quem quiser auditar a criação tem os `seq` 0..5 no próprio log. **(c) Verificação por registro, sem retroação.** Cada registro de 0..5 é conferido contra a posição que R-27 exige **dele**. Qualquer desvio — ordem errada, autor diferente, `kind` inesperado, `authorSeq` fora de 1..6, payload fora da forma de (b), `seq` 0 que não seja `community.create` — faz **aquele** registro ser `REJECTED` e marca a comunidade `invalid`; a partir daí **todo** registro do core é `REJECTED`, inclusive os `seq` restantes da gênese e todo `seq ≥ 6`. Registros de `seq` menor já `APPLIED` **não** são revogados: o `fold` interpreta um registro por vez (§8.0) e não tem retroação. A garantia é que toda réplica marca `invalid` no **mesmo** `seq` e a comunidade fica inútil — o cliente recusa abri-la e não entra no swarm dela. **Emenda de 2026-09-04:** a marca não depende de o desvio ser detectado pela verificação de forma. **Todo** registro de `seq ≤ 5` cujo desfecho seja `REJECTED` marca `invalid`, seja qual for o estágio de §8.2 que o recusou — o estágio 6 recusa `authorSeq` repetido com `E_DUPLICATE` antes de a forma ser conferida, e o estágio 14 recusa um `member.join` cujo cargo Fundador não existe, e os dois deixam a gênese incompleta exatamente como um `kind` fora de ordem deixaria. `IGNORED` fica **de fora**: versão ou `kind` desconhecido é `partialInterpretation` (§7.2 regra 5), não desvio de forma, e marcar `invalid` ali faria um binário antigo condenar toda gênese escrita por um binário novo | `seq` 0..5 | `E_GENESIS_MISPLACED` |
| **R-28** | **Ban sem membresia** (emenda de 2026-08-22, `ACHADO-G12-01`). `mod.ban` admite alvo que **não é membro**: o `fold` cria o registro de ban e uma linha de membro em estado `banned`, sem passagem por `active` e sem contar em `memberCount`. É o que permite a continuação de uma sucessão carregar os bans da origem (§18.8.1) — sem isso, o convite de reentrada lavaria o ban —, e é também ban preventivo comum. A hierarquia de §9.3/R-16 continua valendo: alvo sem `topRank` não tem imunidade de cargo, mas Fundador original e host corrente permanecem inatingíveis; o `byLabel` da auditoria é o fragmento de chave quando não há rótulo conhecido. `mod.revokeBan` sobre esse alvo o leva a `left`, como qualquer outro — e o `member.join` que venha depois **não herda o `joinedAt` da linha de ban**: a data de adesão é a do join, porque quem nunca esteve `active` não tem adesão anterior a preservar. Vale para toda comunidade, não só para continuações — restringir à continuação exigiria uma regra condicional à origem declarada na gênese, sem ganho de segurança | `mod.ban` | — (deixa de recusar com `E_NOT_FOUND`) |
| **R-29** | **Modo de fala** (emenda de 2026-08-28). `speechMode`, quando presente, precisa ser `0`, `1` ou `2`, e o canal precisa ser de voz (`type = 1` na criação; alvo de voz no `update`) — ausente em `channel.create` vale `0`. `queueTurnSeconds`, quando presente, precisa ser inteiro em 30..3600 (§8.6) e o registro precisa **deixar o canal em modo fila**: `speechMode = 1` na própria op, ou `speechMode` ausente com o canal já em `1`. O campo persiste quando o modo sai de fila e volta a ter efeito quando retorna. Não há gate de permissão além de `manage_channels`, que a tabela de §7.4 já exige: o modo é configuração de canal, não moderação | `channel.create`, `channel.update` | `E_VALIDATION.speechMode` / `E_VALIDATION.queueTurnSeconds` |
| **R-30** | **Auto-atribuição não concede o que o autor não tem** (emenda de 2026-09-04). Quando o alvo de `member.setRoles` é o **próprio autor**, nenhum cargo **acrescentado** pode carregar permissão fora de `efetiva(autor)` no momento do registro. É a quarta regra de anti-escalada de §9.3, e existe porque o estágio 12 não se aplica ao alvo que é o próprio autor: sobrava R-4, que só compara `rank`, e quem tinha `manage_roles` se atribuía qualquer cargo abaixo do próprio topo herdando `ban_members`, `manage_community` e o que mais estivesse ali — a mesma escalada que R-5 fecha na **criação** do cargo, entrando pela porta da **atribuição**. Atribuir a **outra** pessoa um cargo mais forte que o seu continua valendo: ali o estágio 12 responde, e o autor não ganha permissão nenhuma | `member.setRoles` | `E_PERMISSION_ESCALATION` |

### 8.4 Efeitos e resolução determinística de referência quebrada

O `fold` emite `Effect[]`, que o `projector` aplica em `view.db`. O `Effect` é um tipo
fechado — isso fecha `DR-27` ("o delta agregado do projetor não tem forma"):

```ts
type Effect =
  | { t:'upsert', table: CsTable, key: EntityKey, row: Record<string, Primitive> }
  | { t:'patch',  table: CsTable, key: EntityKey, fields: Record<string, Primitive> }
  | { t:'delete', table: CsTable, key: EntityKey }
  // Formas em lote — escopo FECHADO, não é linguagem de consulta (fecha `HOLE-12`)
  | { t:'patchScope',     scope: EffectScope, fields: Record<string, Primitive> }
  | { t:'ftsRemoveScope', scope: EffectScope }   // ban, canal apagado
  | { t:'ftsIndexScope',  scope: EffectScope }   // ban revogado — fecha `H-20`
  | { t:'ftsIndex',   messageId: Id, content: string }
  | { t:'ftsRemove',  messageId: Id }
  | { t:'audit', entry: ModerationEntry }
  | { t:'recount', what: 'memberCount'|'roleMemberCount'|'threadReplyCount', key: EntityKey }
  | { t:'notify', topic: EventTopic, data: object }   // vira evento IPC (§15.5)
```

O `projector` aplica a lista **na ordem**, dentro de **uma transação por lote**, e emite os
`notify` **depois do commit** (§10.7). Ele não decide nada.

**`patchScope` e por que o escopo é fechado (fecha `HOLE-12`).** Sem forma em lote, um
`mod.ban` de quem tem N mensagens emitia **N** `patch` de ocultação (§6.12, §18.2), e um
`channel.delete` emitia N `patch` de `orphaned`: num canal com 100 k mensagens, uma
transação de 100 k efeitos e uma lista de 100 k itens em memória, por **um** registro. O
escopo é um enum de **três** formas, exatamente as que o v1 precisa — não um predicado
livre, porque um predicado livre viraria linguagem de consulta dentro de material
determinístico, e duas implementações a avaliariam diferente:

```ts
type EffectScope =
  | { s:'messagesOfAuthor',  authorKey: Key }        // mod.ban / mod.revokeBan → hidden_by_ban
  | { s:'messagesOfChannel', channelId: Id }         // channel.delete → orphaned
```

**As duas formas de escopo da FTS, e por que nenhuma carrega texto (fecha `H-20`).**
`ftsRemoveScope` tira do índice tudo o que casa o escopo; `ftsIndexScope` devolve. A segunda
não transporta `content` porque o `fold` não o tem — §8.1 guarda metadado de decisão, não
texto —, e não precisa: o `projector` reindexa a partir do `messages.content` que ele mesmo
materializou, com o predicado que é o **complemento exato** das três remoções (tombstone,
canal apagado, ban). Reindexar não pode ressuscitar o que outra regra tirou.

Sem a forma inversa, `mod.ban` seguido de `mod.revokeBan` devolvia as mensagens às listagens
(`hidden_by_ban = 0`) e as deixava **fora da busca para sempre** — §18.2 promete
reversibilidade sem ressalva, e entregava metade dela. As duas são idempotentes por guarda de
pertença, nos dois sentidos (§10.3), porque o mesmo escopo é alcançado de novo a cada ban
repetido e a cada revogação repetida.

**População de cada `recount` (fecha `H-25`).** O `recount` nomeia *o que* recontar e a
chave da linha que recebe o número; a **população** contada é esta tabela, e nenhuma outra.
O `projector` a calcula a partir das tabelas de `CS` **dentro da mesma transação do lote**
(§10.5 passo 4), depois de todos os `upsert`/`patch`/`patchScope` daquele lote:

| `what` | Linha atualizada | População contada |
|---|---|---|
| `memberCount` | `communities.member_count` | membros da comunidade com `left_at IS NULL` **e** `banned = 0` |
| `roleMemberCount` | `roles.member_count` | os **mesmos** membros, restritos aos que têm o cargo em `member_roles` |
| `threadReplyCount` | `threads.reply_count` | mensagens com `thread_id` = a thread, `deleted_at IS NULL` **e** `orphaned = 0` |

Duas consequências que a tabela decide de propósito:

- **`hidden_by_ban` não subtrai.** A ocultação por ban é reversível (§18.2, `mod.revokeBan`),
  e um contador que oscilasse com ela mostraria a thread perdendo respostas que voltam. Sair
  da listagem é assunto da query, não do contador.
- **`left_at`/`banned` subtraem.** Quem saiu ou foi banido não aparece nas listagens de
  membros nem nas de cargo (§18.1), e um contador que os incluísse contradiria a tela que ele
  legenda.

**Quem emite cada `recount`, e quando (emenda de 2026-09-04).** A tabela acima diz *o que* cada
contador conta; declarar a **população** sem declarar os **gatilhos** deixava contadores parados
em número que a própria tabela contradiz. Os gatilhos são estes, e são todos os que existem:

| `what` | Emitido por | Emitido **depois** de |
|---|---|---|
| `memberCount` | `member.join`, `member.leave`, `mod.kick`, `mod.ban`, `mod.revokeBan` | o `upsert`/`patch` que mexe em `left_at`/`banned` |
| `roleMemberCount` | os **mesmos** cinco, para **cada cargo do membro**, mais `member.setRoles`, `role.delete` e `role.update` para os cargos cuja lista mudou | idem |
| `threadReplyCount` | `message.send` com `threadId`; `message.delete` de uma **resposta**; `channel.delete` e `category.delete{deleteChannels}`, para cada thread alcançada | o `patch`/`patchScope` que mexe em `deleted_at`/`orphaned` |

O "depois" é normativo, não estilístico: o projetor calcula cada `recount` lendo as tabelas de
`CS` **já atualizadas**, na mesma transação do lote (§10.5 passo 4) — emitido antes, ele conta o
estado anterior. E `roleMemberCount` acompanhar `memberCount` também é: as duas populações são a
mesma, então `mod.ban` que só recontasse a comunidade deixaria `roles.member_count` contando o
banido para sempre.

**A marca de L-5 tem efeito (fecha a lacuna que §10.3 declarava sozinha).** §6.1 L-5 define
`displayNameCollision` e §10.3 declara a coluna `members.display_name_collision`, mas nenhum
efeito a escrevia: a coluna nascia `0` e ficava `0`, e a marca existia só no `DecisionState`.
Toda op que muda `displayName` ou o **conjunto ativo** — `member.join`, `identity.update`,
`member.leave`, `mod.kick`, `mod.ban` — recalcula a marca sobre os membros ativos e emite um
`patch` por membro **cujo valor mudou** (nunca um por membro: o recálculo é O(membros), o delta
não). Quem deixa o conjunto ativo **perde** a marca, porque L-5 fala de membro ativo.

**A thread acompanha a deleção da raiz.** §6.8 manda o `fold` marcar `rootDeleted = true` quando
a mensagem raiz é deletada, e a coluna `threads.root_deleted` existe em §10.3: o efeito é um
`patch` em `threads` no mesmo registro do `message.delete`. Não há campo correspondente no
`DecisionState` — `messages[raiz].deletedAt` e `rootOfThread` já decidem o caso, e um terceiro
lugar guardando a mesma verdade seria uma chance a mais de divergirem.

O determinismo não depende desta escolha — qualquer fórmula fixa converge em toda réplica —,
mas a **semântica** depende, e sem ela cada implementação legendaria a mesma tela com um
número diferente.

A renormalização de §6.4.1 **não** usa `patchScope`: cada item do escopo recebe um `rank`
**diferente**, e uma forma em lote só transporta o mesmo valor para todas as linhas. Ela
emite um `patch` por item, e é aceitável porque o escopo é limitado por §27.1 (≤ 500) e o
evento é raro — ao contrário da ocultação por ban, que é ilimitada no número de mensagens.

O `projector` traduz cada forma em **um** `UPDATE ... WHERE` sobre índice existente. O
`fold` **não** enumera as linhas: `patchScope` não depende de o `DecisionState` conhecer
todas as mensagens, e é isso que mantém o `DS` dentro do orçamento de §26.1. O efeito sobre
o `DS` continua sendo calculado pelo `fold`; o que muda é **como o delta é transportado**
até `view.db`. Acrescentar uma forma nova é mudança de contrato, com bump de
`view_schema_version` — foi o que `ftsIndexScope` custou (`view_schema_version` 1 → **2**), e
o preço é uma reprojeção total no primeiro boot, que §10.5 já sabe fazer.

#### 8.4.1 Referência quebrada — a política que substitui "reducer que lança"

Em v1 uma referência inconsistente lançava e parava a comunidade. Em v2 cada caso tem
**resolução determinística**, e nenhuma delas é uma parada:

| Situação | Resolução determinística |
|---|---|
| `message.send` para canal que o `DS` não conhece ou que está deletado | `REJECTED` no estágio 14 — nunca chega ao efeito |
| Canal deletado **depois** de mensagens existentes | As mensagens ficam com `orphaned = 1`, saem das listagens e da FTS, **não são apagadas** e voltam se o canal for restaurado (não existe restauração no v1, então na prática é permanente) |
| `role.delete` com o cargo referenciado em `channel.readOnlyForRoleIds` | O `fold` remove o id de todas as listas, no mesmo registro (R-10 análogo) |
| `role.delete` com membros | Membros mantidos; o id sai de `roleIds`; se o membro ficar sem cargo, recebe o base |
| `member.setRoles` citando cargo inexistente/deletado | Ids desconhecidos são **descartados** do conjunto (não recusa a op inteira); se sobrar vazio, recebe o base |
| `reaction.set` sobre mensagem deletada | `REJECTED` (`E_MESSAGE_DELETED`) |
| `message.delete` de mensagem já deletada | `APPLIED` idempotente, sem efeito e sem auditoria |
| `mod.ban` de já banido | `APPLIED` idempotente, sem segunda entrada de auditoria |
| `mod.ban` de quem **não é membro** | `APPLIED` — cria a linha em estado `banned` sem passar por `active` (R-28). Não é mais `E_NOT_FOUND` |
| `mod.kick` / `mod.timeout` / `mod.revokeBan` / `mod.removeTimeout` de quem não é membro | `REJECTED` (`E_NOT_FOUND`) — só o **ban** ganhou a forma sem membresia; expulsar ou silenciar quem não está dentro não tem significado |
| Colisão de `rank` | Desempate por id ascendente |
| Colisão de `entityId` | Impossível por construção (§7.3). Se ocorrer, é bug: o segundo é `REJECTED` com `E_ID_COLLISION` e conta `fold.idCollision` |
| `thread.create` sobre raiz deletada | `REJECTED` |
| `community.create` em `seq ≠ 0`, ou gênese fora da forma de R-27 | O registro que desvia é `REJECTED` (`E_GENESIS_MISPLACED`) e a comunidade é marcada `invalid`; a partir daí **todo** registro é `REJECTED`, inclusive os `seq` restantes da gênese. Sem retroação sobre os `seq` já `APPLIED` — R-27(c) |
| Op em `seq ≥ 6` numa comunidade cuja gênese foi rejeitada | `REJECTED` (`E_NOT_MEMBER`) — não há membro nenhum |

### 8.5 Totalidade — a regra que elimina a classe inteira de brick

> **O `fold` nunca lança, nunca aborta, nunca para, e não tem estado `degraded` causado por
> dado.** Toda entrada possível — inclusive bytes aleatórios, `kind` desconhecido, payload
> truncado, referência inexistente, assinatura falsa, ordem impossível — mapeia para
> `APPLIED`, `REJECTED` ou `IGNORED`.

Consequências normativas:

1. `projector.failed` **não existe mais** como estado. O que existe é
   `fold.rejected{reason}` e `fold.ignored{reason}` como métricas.
2. `E_INVARIANT` **não existe mais** como erro de runtime. Virou `fold.propertyViolation`
   (§6.17), que é métrica de bug e não interrompe nada.
3. Uma exceção lançada de dentro do `fold` é **bug de implementação de severidade máxima**.
   O `projector` a captura, registra `fold.panic{seq, kind}`, trata o registro como
   `IGNORED` e **continua**. Isso não é o comportamento pretendido; é a rede de segurança
   para que um bug nunca vire perda de comunidade. O CI de §28.1 tem um fuzzer dedicado a
   provar que ela nunca é acionada.
   O `kind` da métrica é o `kind` do `FoldResult` (§8.0) — presente quando a exceção veio
   **depois** do decode do `Op`, ausente quando veio antes dele, que é o caso em que nenhuma
   camada tem como saber qual era a op. Ausente não é degradação da métrica: `seq` sozinho já
   localiza o registro no core, e o `kind` é o que aponta o handler suspeito.
4. A comunidade só tem dois estados de saúde derivados de dado: `ok` e
   `partialInterpretation` (versão desconhecida, §7.2 regra 5). O estado `degraded` de v1
   passa a significar **exclusivamente** condição de rede/replicação (§14.5).

Isso fecha `F-04`, `F-05`, `F-07`, `F-39`, `F-40`, `DS-01`, `DS-11`, `DS-12`, `DS-19`,
`DR-13`, `DR-14`, `DR-28`.

### 8.6 Limites de campo (tabela única e autoritativa)

Todos são **constantes de protocolo** (§27.1). Nenhum é configurável.

**Unidade de contagem.** Onde a tabela diz **code points**, conta-se escalares Unicode
(`[...string].length`), **nunca grafemas**. Grafema é definido pela tabela de segmentação
do ICU do runtime; ICU tem versão, a versão muda com o Node/Electron e pode ser tailorizada
por locale — o que faria a interpretação do log função do ambiente e violaria §1.5. O
`fold` **não** chama `Intl.Segmenter`. Contagem de grafema é assunto de UI: o contador de
caracteres do formulário pode ser grafêmico, e é advisório por §8.7.

**Consequência para `Reaction.emoji` e `Community.iconEmoji`.** Os limites abaixo são tetos
determinísticos, não um julgamento de "isto é um emoji" — o `fold` aceita qualquer string
dentro deles. A semântica "uma reação é **um** emoji" passa a ser garantida pelo **seletor
curado** da interface, que é a única origem desses campos na UI
(`deltas-ux-v2.md` **U-30**). Toda réplica precisa **renderizar** o que estiver no log,
mesmo fora do catálogo dela: o registro foi aceito, e esconder estado aceito é divergência.

| Campo | Mín | Máx | Normalização | Erro |
|---|---|---|---|---|
| `Identity.displayName` | 2 code points | 32 code points | `trim`, colapsa espaço interno, NFKC | `E_VALIDATION.displayName` |
| `Community.name` | 2 | 40 | `trim`, NFKC | `.name` |
| `Community.description` | 0 | 120 | `trim` | `.description` |
| `Community.iconEmoji` | 1 code point | 8 code points / 32 bytes | — | `.iconEmoji` |
| `Category.name` | 1 | 32 | `trim`, NFKC | `.name` |
| `Channel.name` (texto) | 1 | 32 | NFD → remove diacrítico → minúsculo → espaço vira `-` → descarta o resto → colapsa `-` repetido → `trim('-')`. Resultado precisa casar `^[a-z0-9][a-z0-9-]{0,31}$` | `.name` / `E_CHANNEL_NAME_EMPTY` |
| `Channel.name` (voz) | 1 | 32 | `trim`, preserva caixa e espaço, NFKC | `.name` |
| `Channel.topic` | 0 | 120 | `trim`; só em texto | `.topic` |
| `Channel.queueTurnSeconds` | 30 | 3600 | inteiro; só com efeito em `speechMode = 1` (R-29) | `.queueTurnSeconds` |
| `Role.name` | 1 | 32 | `trim`, NFKC | `.name` |
| `Member.nickname` | 1 | 32 | `trim`; vazio ⇒ `null` (remover, não erro) | `.nickname` |
| `Message.content` | 1 | 4000 code points / 16384 bytes | `trim` no fim; preserva quebra de linha | `.content` |
| `Message.mentions` | 0 | 64 itens | ids duplicados colapsam | `.mentions` |
| `Reaction.emoji` | 1 code point | 8 code points / 32 bytes | — | `.emoji` |
| `reason` (moderação) | 0 | 200 | `trim` | `.reason` |
| `Attachment.name` | 1 byte | 255 bytes | **Rejeita** (não remove) se contiver `/ \ \0`, controle, ou casar `^(CON\|PRN\|AUX\|NUL\|COM[1-9]\|LPT[1-9])(\..*)?$` case-insensitive, ou terminar em `.` ou espaço | `.name` |
| `Attachment.sizeBytes` | 1 | `ATTACHMENT_MAX_BYTES` (2^53−1, teto de representação — §13.8) | — | `E_ATTACHMENT_TOO_LARGE` (na prática, o decode de `u64` recusa antes com `E_MALFORMED`) |
| Registro **sem** anexo | — | `MAX_ENVELOPE_BYTES` (32 KiB) | Conferido no estágio 13, depois do decode revelar se há anexo | `E_PAYLOAD_TOO_LARGE` |
| Registro **com** anexo | — | `MAX_ENVELOPE_BYTES_ATTACHMENT` (64 KiB) | Teto absoluto, já conferido no **estágio 0** | `E_PAYLOAD_TOO_LARGE` |
| `Invite.maxUses` | 1 | 10000 | inteiro | `.maxUses` |
| `Invite.expiresAt` | `hostTs+60s` | `hostTs+365d` | — | `.expiresAt` |
| `Invite.label` | 0 | 40 code points | `trim` | `.label` |
| `Timeout.until` | `hostTs+60s` | `hostTs+30d` | — | `.until` |
| `successorKeys` | 0 | 5 | sem duplicata, sem o próprio host | `.successorKeys` |

**Nome de anexo: rejeitar, não sanitizar.** v1 removia caracteres, o que pode fazer dois
nomes distintos colapsarem no mesmo e esconder travessia de caminho (`T-37`). v2 rejeita na
origem e, no disco, o arquivo é gravado como `<blobIdHex>-<nome>` — o prefixo garante
unicidade mesmo com nomes iguais.

### 8.7 Onde a validação acontece, e o que isso significa

| Ponto | Papel | Autoridade |
|---|---|---|
| **Cliente, antes de enfileirar** | `fold.wouldAccept(localDS, opCandidata)` — erro inline no formulário | **Advisória.** Pode divergir do host por estar atrás. Divergir é esperado e inofensivo |
| **Host, antes do append** | O mesmo `fold`, contra o `DS` do host **na cabeça do log**, dentro da seção crítica de §11.4 | **Preditiva e vinculante para o append.** Se recusa, nada é appendado e o cliente recebe o erro tipado |
| **Toda réplica, ao interpretar** | O mesmo `fold`, sobre o registro já appendado | **Normativa.** É o que define o estado |

Como é a mesma função e o host valida contra a cabeça, os dois últimos concordam sempre —
exceto se o host for adversário, e é exatamente aí que o terceiro ponto protege.

**Fecha `F-11` e a §9.2 de v1:** "compartilhar o mesmo TypeScript impede divergência" era
falso. v2 não depende disso: depende de o `fold` **não ler configuração nem relógio**
(§1.5), o que torna a convergência estrutural, e de a validação do cliente ser
explicitamente advisória.

---

## 9. Autorização e permissões

### 9.1 Catálogo (17 permissões, fechado)

Idêntico ao que o frontend já implementa. O backend não acrescenta nem remove nenhuma.

O número da coluna `#` é **constante de protocolo** (§27.1): é ele que viaja em
`arr<u8> permissions` de `role.create`/`role.update` (§7.4.3), dentro de **material
assinado**. Dois clientes com numerações diferentes concederiam permissões diferentes
lendo o mesmo log. A numeração é a ordem desta tabela, é fixa, e **nenhum número é
reaproveitado**: uma permissão futura recebe o próximo inteiro livre, nunca o de uma
removida.

| # | Grupo | Permissão | Autoriza |
|---:|---|---|---|
| 0 | Geral | `manage_community` | `community.update`; revogar qualquer convite; ver 3.1b |
| 1 | | `manage_channels` | Todas as ops de `channel.*` e `category.*` |
| 2 | | `view_audit_log` | Ler `moderation_log`, `bans`, `timeouts` (§15.6, enforcement real) |
| 3 | Texto | `send_messages` | `message.send`, `thread.create` |
| 4 | | `attach_files` | Anexo em `message.send` |
| 5 | | `add_reactions` | `reaction.set` |
| 6 | | `mention_everyone` | `mentionEveryoneEffective` (R-13) |
| 7 | | `pin_messages` | `message.pin` |
| 8 | | `manage_messages` | `message.delete` de outro autor |
| 9 | Voz | `voice_speak` | Entrar em canal de voz |
| 10 | | `voice_mute_others` | Silenciar outro participante na chamada |
| 11 | | `voice_share_screen` | `share.start` |
| 12 | Moderação | `create_invite` | `invite.create`; revogar o próprio |
| 13 | | `kick_members` | `mod.kick` |
| 14 | | `ban_members` | `mod.ban`, `mod.revokeBan` |
| 15 | | `timeout_members` | `mod.timeout`, `mod.removeTimeout` |
| 16 | | `manage_roles` | `role.*`, `member.setRoles` |

Um `u8` fora de `0..16` em `permissions` é `REJECTED` com `E_VALIDATION.permissions` no
estágio 13 — não é ignorado silenciosamente, senão um cliente futuro concederia uma
permissão que este binário não vê e as duas réplicas discordariam do conjunto efetivo.

### 9.2 Permissão efetiva

`efetiva(membro) = união das permissões de todos os cargos ativos`. Sem negação, sem
override por canal, sem herança. Única exceção por canal: `readOnlyForRoleIds` (R-22) — o
membro perde `send_messages` naquele canal se **todos** os seus cargos estiverem na lista.

O host é `Fundador` e o `Fundador` tem as 17. Não há superusuário fora do sistema de cargos.

### 9.3 Hierarquia

`topRank(membro)` = maior `rank` entre os cargos ativos, na ordenação lexicográfica de
§6.4.1.

**Regra única:** o autor só age sobre alvo cujo `topRank` seja **estritamente menor** que o
seu. Nunca igual, nunca maior. Fundador original e host corrente nunca são alvo.

**Ordem dentro do estágio 12 (fecha `HOLE-16`).** A imunidade do alvo é conferida
**antes** da comparação de `rank`, nesta ordem:

1. alvo é o cargo Fundador → `E_FOUNDER_IMMUTABLE`; alvo é `role.move` que levaria um
   cargo a `rank ≥` o do Fundador → `E_FOUNDER_TOP`;
2. alvo é o Fundador original → `E_FOUNDER_IMMUNE`; alvo é o host corrente →
   `E_HOST_IMMUNE`; alvo é o próprio autor em `mod.*` → `E_SELF_TARGET` (R-16);
3. só então `topRank(alvo) < topRank(autor)` → senão `E_HIERARCHY`.

Sem essa ordem, `E_FOUNDER_IMMUTABLE` e `E_FOUNDER_TOP` eram **inalcançáveis**: o cargo
Fundador tem sempre o `rank` máximo, então a comparação genérica de R-4 recusava antes,
com `E_HIERARCHY`, **para todo autor — inclusive o próprio Fundador**. Dois códigos do
catálogo de §20.2 nunca apareciam, e a UI de §20.3 não tinha como dizer "este cargo não é
editável" em vez de "você não tem hierarquia sobre ele". A alternativa era remover os dois
códigos do catálogo, e foi descartada: a mensagem específica é a que o usuário consegue
agir sobre.

**Quatro regras de anti-escalada** (v1 tinha duas e nenhuma cobria o cargo base — `F-38`,
`T-35`; a quarta é emenda de 2026-09-04):

- **R-5** ninguém concede permissão que não tem;
- **R-4** ninguém cria, edita ou move cargo para `rank ≥` o próprio topo;
- **R-11** o cargo base nunca pode ter permissão de gestão, moderação ou menção global;
- **R-30** ninguém **se atribui** cargo com permissão que já não tenha.

R-11 é a que fecha o vetor real: sem ela, editar o cargo base — que **todo membro presente,
futuro e reingressante recebe automaticamente** — concedia moderação a toda a comunidade.

**O alvo que é o próprio autor, e por que ele não cai no passo 3.** A ordem acima é sobre o
alvo, e o passo 3 lido ao pé da letra recusaria **sempre** que autor e alvo fossem a mesma
pessoa: `topRank(alvo) < topRank(autor)` é falso para si mesmo, inclusive para o Fundador, que
passaria a nunca mais poder tocar nos próprios cargos. Fora de `mod.*` — onde R-16 já responde
com `E_SELF_TARGET` — o alvo próprio **não** passa pelo estágio 12; quem guarda o caminho é
**R-30**, no estágio 14. A diferença entre as duas é exatamente a que interessa: o que o
sistema precisa impedir não é a pessoa mexer nos próprios cargos, é ela **ganhar permissão que
não tinha**.

### 9.4 Matriz de enforcement por `kind`

Consolidada nas colunas `Perm.`/`Hier.` de §7.4. O `fold` lê **dessa tabela**,
declarativamente. Um `kind` sem linha na tabela falha fechado com `E_UNKNOWN_KIND`.

### 9.5 Os pontos de enforcement (v2)

| Ponto | O que faz | Natureza |
|---|---|---|
| **Controle de admissão do transporte** (§14.4) | Teto de bytes, orçamento de conexão, token bucket por par, antes de qualquer trabalho caro | Proteção de recurso, **não** autorização |
| **Autorização de canal de replicação** (§14.3) | Um par só replica o core de uma comunidade se for membro ativo não banido segundo o `DS` local | Autorização, distribuída |
| **`fold` no host, antes do append** | Recusa a op | Preditivo |
| **`fold` em toda réplica** | Decide o efeito | **Normativo** |
| **Queries com escopo de permissão** (§15.6) | `view_audit_log`, `manage_community` e afins filtram a resposta | Confidencialidade local |
| **UI** | Esconde o botão | Cosmético |

A UI esconder nunca é enforcement. Um cliente adulterado que mostre todos os botões
consegue exatamente nada.

---

## 10. Persistência

### 10.1 Layout em disco

Tudo sob `<userData>/p2p/` (sobrescrevível por `P2P_DATA_DIR`, §27.2):

```
p2p/
  LOCK                          lock composto (§10.8)
  manifest.db  (+ -wal/-shm)    LS — autoritativo local, synchronous=FULL
  view.db      (+ -wal/-shm)    DS snapshot + CS + FTS5, synchronous=NORMAL
  cores/                        corestore (RocksDB): log e blobs
  blobs/<blobsCoreKeyHex>/      cache local de anexos verificados
  staging/<ticketId>            staging de upload retomável (§13.5)
  logs/core-YYYY-MM-DD.ndjson   log estruturado
```

**Decisão:** um `view.db` para todas as comunidades (busca global e não-lidas cruzam
comunidades), com isolamento por coluna `community_id` **indexada em toda tabela** e
presente em **toda** chave primária. Isso é o que impede o vazamento entre comunidades que
`T-30`/`T-25` exploravam.

### 10.2 `manifest.db` — schema

**Nunca é apagado por reprojeção. Nunca é reconstruído a partir do log.** É a resposta
direta ao blocker B2.

| Tabela | Colunas | Notas |
|---|---|---|
| `meta` | `key TEXT PK`, `value TEXT` | `manifest_schema_version`, `identity_public_key`, `wipe_state`, `install_id` |
| `secrets` | `name TEXT PK`, `ciphertext BLOB`, `nonce BLOB` | `data_key` (embrulhada por `safeStorage`), `identity_seed` (cifrada pela Data Key) |
| `communities` | `community_id TEXT PK`, `core_key BLOB NOT NULL`, `blobs_key BLOB NOT NULL`, `community_seed_enc BLOB`, `community_seed_nonce BLOB`, `is_host INT NOT NULL`, `joined_at INT NOT NULL`, `left_at INT`, `removed_reason TEXT`, `retain_until INT`, `origin_community_id TEXT` | `community_seed_enc` só existe para comunidades hospedadas. **Esta tabela é a enumeração autoritativa de participação** |
| `member_blobs_core` | `community_id TEXT PK`, `core_key BLOB`, `secret_seed_enc BLOB` | Core de blobs local por comunidade (§13.1); `secret_seed_enc` é cifra **empacotada** `nonce‖ciphertext‖tag` — a linha não tem coluna de nonce. **Emenda de 2026-08-22:** a linha é **derivada** (§13.1) — atalho e verificação cruzada, não fonte única; o boot a recria quando falta ou não decifra |
| `local_author_seq` | `community_id TEXT`, `sequence_scope TEXT`, `next_author_seq INT NOT NULL` · **PK `(community_id, sequence_scope)`** | §7.5 |
| `local_outbox` | §11.2 | — |
| `local_read_state`, `local_thread_read_state`, `local_channel_pref`, `local_community_pref`, `local_navigation`, `local_relay_consent`, `local_device_pref`, `local_participant_volume`, `local_blob_cache`, `local_blob_staging` | §6.15 | — |
| `invite_secrets` | `invite_public_key BLOB PK`, `community_id TEXT`, `secret BLOB`, `label TEXT` | Só dos convites criados nesta instalação |
| `dm_conversations` | §31.12 | **Emenda de 2026-09-01.** Enumeração autoritativa de conversas diretas; carrega `self_high_water`, que é o que impede o fork de §31.13 |
| `dm_local_read_state`, `dm_prefs` | §31.12 | Não-lidas de DM (A28) e a política local de contato (§31.9) |

#### 10.2.1 Migração de `manifest.db`

`manifest.db` **não** é descartável, então tem migração de verdade: uma sequência numerada
de scripts idempotentes (`001_init.sql`, `002_...`), aplicados em transação, com
`manifest_schema_version` avançado na mesma transação. Downgrade não é suportado
(`E_SCHEMA_AHEAD`). Fecha `DR-20` ("tabelas locais preservadas na reprojeção não têm
caminho de migração").

A emenda de `sequenceScope` exige migração do schema de `local_author_seq` e de
`local_outbox`, mas **não** reinterpreta envelopes da versão experimental 1. Como nenhum
binário de produto foi publicado com ela, as fixtures e os diretórios de desenvolvimento
anteriores são recriados; uma migração de comunidades já publicadas exigiria contrato
próprio e não é inventada nesta fase. A tabela derivada `observed_ops` incrementa
`view_schema_version`; o schema de produto desta emenda é **3** e a tabela é recriada junto
com as demais tabelas de `view.db`.

### 10.3 `view.db` — schema

**Totalmente derivado.** Apagar e reprojetar reconstrói byte a byte. Toda PK inclui
`community_id`.

#### Estado de Decisão (snapshot)

| Tabela | Colunas | Notas |
|---|---|---|
| `ds_snapshot` | `community_id TEXT PK`, `interpreted_seq INT`, `blob BLOB`, `fold_build_id TEXT NOT NULL`, `taken_at INT` | Serialização do `DecisionState` **exceto** `messages`/`rootOfThread`. Acelera o boot; se ausente ou inconsistente, o `fold` recomeça do `seq` 0 (§10.6) |

**`fold_build_id` (fecha `H-22`).** §10.6 exige que o snapshot carregue o hash do binário do
`fold` e seja descartado quando ele não bate; sem a coluna o requisito é inexpressável, e a
única representação possível é esta — a mesma família de `HOLE-11` e `H-19`. `TEXT NOT NULL`
porque um snapshot sem procedência **é** um snapshot inválido: quem não sabe qual `fold`
produziu o estado não pode herdá-lo.

#### Estado de Conteúdo

| Tabela | Colunas (tipo, restrição) | Índices |
|---|---|---|
| `communities` | `id TEXT NOT NULL` · `core_key BLOB NOT NULL` · `blobs_key BLOB NOT NULL` · `host_key BLOB NOT NULL` · `founder_key BLOB NOT NULL` · `name TEXT NOT NULL` · `icon_emoji TEXT` · `icon_color TEXT NOT NULL` · `description TEXT` · `created_at INT NOT NULL` · `member_count INT NOT NULL DEFAULT 0` · `ended_at INT` · `origin_community_id TEXT` · `successor_keys TEXT` — **PK `(community_id, id)`** | — |
| `members` | `community_id TEXT` · `identity_key BLOB` · `display_name TEXT NOT NULL` · `avatar_color TEXT NOT NULL` · `nickname TEXT` · `blobs_core_key BLOB` · `joined_at INT NOT NULL` · `left_at INT` · `banned INT NOT NULL DEFAULT 0` · `timeout_until INT` · `storage_used_bytes INT NOT NULL DEFAULT 0` · `display_name_collision INT NOT NULL DEFAULT 0` — **PK `(community_id, identity_key)`** | `idx_members_active(community_id, left_at, banned)` |
| `member_roles` | `community_id` · `identity_key` · `role_id` — PK dos três | `idx_member_roles_role(community_id, role_id)` |
| `roles` | `community_id TEXT` · `id TEXT` · `name` · `color` · `rank TEXT NOT NULL` · `permissions TEXT NOT NULL` (JSON) · `mentionable INT` · `is_founder INT` · `is_default INT` · `member_count INT` · `deleted_at INT` — **PK `(community_id, id)`** | `idx_roles_rank(community_id, rank DESC)` |
| `categories` | `community_id` · `id` · `name` · `rank TEXT` · `deleted_at` — PK `(community_id, id)` | `idx_categories_rank(community_id, rank)` |
| `channels` | `community_id` · `id` · `category_id` · `type` · `name` · `topic` · `rank TEXT` · `read_only_role_ids TEXT` (JSON) · `deleted_at` — PK `(community_id, id)` | `uniq_channels_name(community_id, type, name) WHERE deleted_at IS NULL`; `idx_channels_cat(community_id, category_id, rank)` |
| `observed_ops` | `community_id` · `op_id` · `seq INT NOT NULL` · `author_key BLOB NOT NULL` · `sequence_scope TEXT NOT NULL` · `author_seq INT NOT NULL` — **PK `(community_id, op_id)`** | `idx_observed_ops_seq(community_id, seq)`; contém somente registros `APPLIED` e é o índice derivado consultado pela reconciliação (§11.6) |
| `messages` | `community_id` · `id` · `seq INT NOT NULL` · `channel_id` · `author_key BLOB` · `content TEXT` (**NULL quando tombstonada** — fecha `DR-17`) · `author_ts INT` · `host_ts INT` · `clock_skewed INT` · `edited_at INT` · `pinned INT` · `reply_to_id TEXT` · `thread_id TEXT` · `mentions TEXT` (JSON) · `mention_everyone_effective INT` · `deleted_at INT` · `hidden_by_ban INT` · `orphaned INT` — PK `(community_id, id)` | `idx_messages_channel(community_id, channel_id, seq DESC)`; `idx_messages_author(community_id, author_key)`; `idx_messages_pinned(community_id, channel_id) WHERE pinned=1`; `idx_messages_thread(community_id, thread_id, seq)` |
| `messages_fts` | FTS5 **contentless-delete** (`content=''` **com `contentless_delete=1`** — ver abaixo), colunas `content`, com `rowid = messages.rowid`, `tokenize='unicode61 remove_diacritics 2'`, `prefix='2 3'` | — |
| `message_links` | `community_id` · `message_id` · `idx INT` · `url TEXT` · `host TEXT` · `seq INT` — PK `(community_id, message_id, idx)` | `idx_links_channel(community_id, message_id)` — fecha `DR-38` |
| `attachments` | `community_id` · `message_id` · `owner_key BLOB` · `blobs_core_key BLOB` · `blob_id TEXT` (JSON) · `name` · `size_bytes INT` · `kind` · `hash BLOB` — PK `(community_id, message_id)` | `idx_attachments_owner(community_id, owner_key)`; **emenda de 2026-08-22:** `idx_attachments_ref(blobs_core_key, blob_id)` — `blob.cancel`/`blob.reveal` chegam sem `communityId` (§15.4 é tabela fechada) e o resolver varre por essa dupla |
| `reactions` | `community_id` · `message_id` · `emoji` · `identity_key BLOB` · `at INT` — PK dos quatro | `idx_reactions_message(community_id, message_id)` |
| `threads` | `community_id` · `id` · `root_message_id` · `channel_id` · `reply_count INT` · `root_deleted INT` — PK `(community_id, id)`; `UNIQUE(community_id, root_message_id)` | — |
| `invites` | `community_id` · `invite_public_key BLOB` · `created_by BLOB` · `created_at INT` · `expires_at INT` · `max_uses INT` · `uses INT` · `revoked_at INT` · `label TEXT` — PK `(community_id, invite_public_key)` | `idx_invites_community(community_id, revoked_at)` |
| `bans` | `community_id` · `target_key BLOB` · `by_key BLOB` · `at INT` · `reason` · `revoked_at INT` — PK `(community_id, target_key)` | — |
| `timeouts` | `community_id` · `target_key BLOB` · `by_key BLOB` · `at INT` · `until INT` · `reason` — PK `(community_id, target_key)` | `idx_timeouts_until(community_id, until)` |
| `moderation_log` | `community_id` · `id` · `seq INT` · `type` · `target_id` · `target_label` · `by_key BLOB` · `by_label TEXT` · `reason` · `at INT` — PK `(community_id, id)` | `idx_modlog(community_id, seq DESC)`; `idx_modlog_type(community_id, type, seq DESC)` |
| `relay_volunteers` | `community_id` · `identity_key BLOB` · `relay_public_key BLOB` · `since INT` · `expires_at INT` · `withdrawn_at INT` — PK `(community_id, identity_key)` | — |
| `rejected_records` | `community_id` · `seq INT` · `kind INT` · `author_key BLOB` · `reason TEXT` — PK `(community_id, seq)` | Só para diagnóstico; podado acima de `REJECTED_LOG_MAX` linhas por comunidade. `kind`/`author_key` vêm do `FoldResult` (§8.0) e são **`NULL` exatamente** quando o `Op` não decodificou — ou seja, só na recusa do estágio 0 |
| `meta` | `key TEXT PK` · `value TEXT` | Chaves em §10.3.1 |
| `dm_ds_snapshot`, `dm_messages`, `dm_reactions`, `dm_attachments`, `dm_participants`, `dm_rejected_records` | §31.12 | **Emenda de 2026-09-01.** Conteúdo derivado da conversa direta. Toda PK inclui `conversation_id`; a ordem é `ord_sum` (§31.6), nunca `seq`. **Sem FTS no v1** — §31.12 |

**FTS5 (fecha `DR-16`):** o índice **não** usa triggers de external-content. O `projector`
emite `ftsIndex`/`ftsRemove` explicitamente, aplicados **na mesma transação** que o
`upsert`/`patch` da mensagem, sempre depois dele. Reprojeção reconstrói o índice do zero
junto com a tabela. Sem ordem implícita, sem rollback parcial.

**A remoção exige `contentless_delete=1`, e é por `DELETE FROM` (emenda de 2026-09-04).** As
duas formas de FTS5 sem conteúdo não são a mesma coisa, e a redação anterior — "contentless-delete
(`content=''`)" — juntava as duas num nome só, descrevendo um contrato que a configuração
nomeada **não** entrega:

| | `content=''` sozinho | `content=''` **+ `contentless_delete=1`** |
|---|---|---|
| `DELETE FROM fts WHERE rowid=?` | recusado | **é a remoção suportada** |
| Comando `'delete'` | única remoção, e exige os **valores originais** da coluna | recusado |
| `'delete'` com `content` `NULL` | tira o `rowid` da lista de documentos e **não subtrai termo nenhum** | — |
| Remoção repetida do mesmo `rowid` | `SQLITE_CORRUPT_VTAB` | no-op |

O projetor **não tem** os valores originais — §8.4 é explícito em que o `fold` não carrega
`content` —, então na forma antiga a remoção era silenciosamente inerte: `message.delete`,
`mod.ban` e `channel.delete` deixavam o texto no índice para sempre, com `messages.content` já
em `NULL`. `messages_fts` declara **`contentless_delete=1`**, e `ftsRemove`/`ftsRemoveScope`
viram um `DELETE FROM ... WHERE rowid IN (...)` — um comando por escopo, coerente com "cada
forma vira um `UPDATE … WHERE`" de §8.4, e **idempotente por construção**, sem precisar de
guarda de pertença.

**Reindexar exige remover antes.** Inserir de novo um `rowid` que já está no índice **soma**
termos; não substitui, em nenhuma das duas formas. Por isso `message.edit` emite `ftsRemove`
**antes** do `ftsIndex`, no mesmo registro: sem isso a mensagem continuava sendo encontrada
pelo texto que ela não tem mais. `ftsIndexScope` resolve o mesmo risco pelo outro lado, com a
guarda `rowid NOT IN (SELECT rowid FROM messages_fts)`.

Está aqui, e não na implementação, porque nenhuma das duas falhas aparece no teste feliz: a
busca por texto vivo funciona nos dois casos, e o que sobra no índice só é visível para quem
consulta a FTS diretamente.

#### 10.3.1 Chaves de `meta` — lista fechada (fecha `H-23` e `H-24`)

`view_schema_version` e `op_version` sozinhas não sustentam o boot: §8.5 e §10.5 exigem um
marcador de `fold.panic` que **sobreviva ao processo**, e §10.3 exige detectar snapshot
"ausente ou inconsistente" — o que, depois de um crash entre duas cadências de snapshot, só é
decidível com o `interpretedSeq` do último lote **commitado**. Nenhum dos dois marcadores
cabe numa tabela derivada de `CS`: eles são estado da própria interpretação.

Um `view.db` serve **todas** as comunidades (§10.1), então toda chave por comunidade carrega
o `communityId` no nome. Quem escreve é sempre o `projector`, único escritor de `view.db`
(§21.1). A lista é fechada:

| Chave | Valor | Quando é escrita |
|---|---|---|
| `view_schema_version` | versão de schema do binário | na criação e na recria do schema (§10.5). **"Na criação" é literal:** quem abre um `view.db` e executa o DDL carimba a versão ali mesmo, **só quando não há nenhuma** — uma versão antiga precisa sobreviver para o boot detectar o bump e apagar (§3.3). Sem o carimbo na criação, um `view.db` recém-criado nasce reportando divergência de schema, e todo consumidor que não passe pelo `wipe` do boot reprojeta do `seq` 0 em **todo** boot, com um `ds_snapshot` válido na mão |
| `op_version` | `OP_VERSION` de `opCodec` (§7.2) | idem — é a versão de protocolo que materializou esta `view.db` |
| `fold_panic:<communityId>` | `seq` do registro que fez o `fold` lançar (§8.5) | na **mesma transação** do lote em que o pânico aconteceu; some no `wipe` da reprojeção |
| `interpreted_seq:<communityId>` | `interpretedSeq` do último lote commitado | na **mesma transação** dos efeitos de cada lote (§10.5 passo 4) |
| `dm_interpreted:<conversationId>` | `{ordSum, loLength, hiLength}` do último lote commitado (§31.12) | na **mesma transação** dos efeitos de cada lote |
| `dm_fold_panic:<conversationId>` | `ordSum` do registro que fez o `dmFold` lançar (§31.7.1) | na **mesma transação** do lote em que o pânico aconteceu |

**Por que `op_version` obriga uma emenda em §4.** A constante mora em `opCodec` (L1), o
`projector` é o único que pode escrevê-la (§21.1) e `view` (L0) não pode importar L1 — a
barreira de camadas quebra o build antes. A resolução é a que §4 já prevê para o caso:
**declarar a importação lateral**, e `opCodec` entra na coluna "Depende de" do `projector`.
Só a constante: o `projector` continua proibido de decodificar registro, e é por isso que
`kind`/`author` chegam pelo `FoldResult` (§8.0) e não por um decode dele.

### 10.4 PRAGMAs e durabilidade

| Banco | PRAGMAs |
|---|---|
| `manifest.db` | `journal_mode=WAL` · **`synchronous=FULL`** · `foreign_keys=OFF` · `busy_timeout=5000` · `temp_store=MEMORY` · `cache_size=-8000` |
| `view.db` | `journal_mode=WAL` · **`synchronous=NORMAL`** · `foreign_keys=OFF` · `busy_timeout=5000` · `temp_store=MEMORY` · `mmap_size=268435456` · `cache_size=-32000` |

**Por que dois bancos e não um (fecha `DS-04`, `B5`):** `NORMAL` é aceitável para dado
reconstruível e inaceitável para outbox, contadores `authorSeq`, sementes e participação.
v1 aplicava `NORMAL` aos dois. v2 separa fisicamente, porque `synchronous` é por conexão de
banco, não por tabela.

`foreign_keys=OFF` é deliberado: a integridade referencial é do `fold`; tombstone lógico
não combina com FK, e uma FK que dispara mid-transação reintroduziria o "reducer que
lança".

### 10.5 Projetor e reprojeção

**Algoritmo, por comunidade:**

1. Carrega `DecisionState` (§10.6).
2. Lê do core em lotes de `PROJECTOR_BATCH` registros a partir de `interpretedSeq + 1`.
3. Para cada registro: `foldRecord(ds, rec, seq)`.
4. **Uma transação `view.db` por lote.** Dentro dela: aplica todos os `Effect` **na ordem**,
   registra em `observed_ops` cada registro `APPLIED`, recalcula os `recount` (a população de
   cada um está em §8.4), atualiza `local_read_state` (que vive em `manifest.db` — ver a
   barreira abaixo) e grava o `interpretedSeq` do lote em `meta.interpreted_seq:<communityId>`
   (§10.3.1). Registros `REJECTED` e `IGNORED` nunca entram em `observed_ops`.
5. Commit. **Depois do commit**, emite os `notify` como eventos IPC.
6. Repete até `core.length`; depois reage a `append`.

**Barreira entre os dois bancos (fecha `DS-18`):** `local_read_state` está em
`manifest.db`, e não há transação distribuída entre dois arquivos SQLite. A ordem é
normativa: **primeiro commita `view.db`, depois commita `manifest.db`, depois emite os
eventos.** Um crash entre os dois deixa o read state atrasado, o que é reconciliável e
inofensivo: no boot, `local_read_state` é **recomputado** para todo canal cujo
`last_read_seq > interpretedSeq` ou cujo `unread_count` não bata com a query — uma varredura
indexada barata. Nenhum cache depende de um evento que pode ter se perdido: o boot sempre
reconsulta.

**Reprojeção total** dispara quando `view_schema_version` ≠ binário, por
`core.reproject`, por `fold.panic` (§8.5) registrado no boot anterior
(`meta.fold_panic:<communityId>`, §10.3.1), ou quando o snapshot está ausente ou
inconsistente (§10.6).

Procedimento (fecha `DR-21`, `DS-19`):

1. **Lê a lista de comunidades de `manifest.communities`** — não de `view.db`.
2. `DROP`/recria **todas** as tabelas de `view.db` (`DS` snapshot, `CS`, FTS).
3. Para cada comunidade, `fold` do `seq` 0 até `core.length`.
4. Recomputa `local_read_state` e `local_thread_read_state` do zero.
5. Nada em `manifest.db` além do read state é tocado.

Acima de `REPROJECT_PROGRESS_SEQ` registros, emite `core.reprojecting{done,total}` e a UI
mostra barra (**a UX precisa dessa tela** — delta U-11).

### 10.6 Snapshot de `DecisionState`

Boot precisa ser rápido; refazer o `fold` de 200 000 registros a cada abertura não fecha
com o alvo de §26.1.

- A cada `DS_SNAPSHOT_INTERVAL` registros interpretados, e no `draining`, o `projector`
  serializa o `DecisionState` (exceto `messages`/`rootOfThread`) em `ds_snapshot`.
- No boot, carrega o snapshot e continua do `interpreted_seq` gravado.
- O snapshot carrega o **hash do binário do `fold`** (`foldBuildId`, coluna
  `ds_snapshot.fold_build_id` de §10.3). Se não bater, é descartado e o `fold` recomeça do 0.
  Isso garante que uma mudança na função de interpretação nunca herde estado interpretado
  pela versão anterior.
- **"Inconsistente" tem definição.** O snapshot é gravado a cada `DS_SNAPSHOT_INTERVAL`
  registros, mas o `interpretedSeq` do último lote **commitado** é gravado a cada lote
  (§10.3.1). Um crash entre duas cadências deixa `view.db` adiante do snapshot, e retomar
  dele reaplicaria efeitos já materializados. Então o snapshot só é aproveitável quando
  `ds_snapshot.interpreted_seq` == `meta.interpreted_seq:<communityId>`; qualquer outra
  combinação — incluindo marcador ausente — é inconsistente, e o `fold` recomeça do `seq` 0.
- O snapshot é **cache**, não verdade: sua perda custa tempo de boot, nunca dado.

**"Cache, não verdade" não é licença para nunca aproveitá-lo** (nota de 2026-09-04). Porque a
perda é inofensiva, um snapshot **sempre** descartado produz o resultado certo e nenhum sintoma:
o `interpretedSeq` final é o mesmo, o dump de §28.4 é o mesmo, e o único efeito é o boot pagar
o `fold` do log inteiro toda vez — exatamente o custo que esta seção existe para eliminar. Um
teste que afirme só o `interpretedSeq` depois do boot **não distingue** os dois caminhos e
passa nos dois. O que distingue é contar registros interpretados: com o snapshot na cabeça do
log, o segundo boot folda **zero**. É essa a propriedade a afirmar.

### 10.7 Transações e barreiras — tabela normativa

| Escopo | Garantia | Como |
|---|---|---|
| Lote de projeção (`view.db`) | Atômico | Uma transação por lote |
| `local_read_state` (`manifest.db`) | Atômico por lote, **depois** do commit de `view.db` | §10.5, com reconciliação no boot |
| Emissão de eventos IPC | **Sempre depois** de ambos os commits | Evento é sinal, nunca fonte |
| Append no host | O grupo é todo commitado ou nenhum ACK é liberado; a decisão fica provisória até o commit | Reserva sob a seção crítica de §11.4; append fora dela |
| Durabilidade do append | `await core.append(...)` — a resolução da promessa **é** a barreira | §11.4 e §10.7.1. `REQUIRES POC` — G4 mede o que sobra: queda de energia e a matriz de §28.3 |
| Gênese da comunidade | Atômica no log | Um único `core.append([...6 registros])` (§19.1) |
| Resgate de convite | Serializado por comunidade | Mesma fila de §11.4; `uses` é `DS` |
| Enfileirar na outbox | Atômico e durável (`FULL`) | Transação em `manifest.db` |
| Blob e mensagem | **Não** transacional, com barreira explícita | §13.7 |
| Escrita local (prefs, read state) | Atômico por operação | Transação implícita |

#### 10.7.1 A barreira do append não é uma segunda chamada (fecha `P1`)

A linha acima dizia `await core.append(...)` **e** `await core.flush()`. A segunda metade não
é implementável em `hypercore@11.35.1`, e a razão importa:

- **`core.flush` não existe** na sessão de Hypercore. O que existe é `core.state.flush()`, do
  `SessionState`, e ele **não** é uma barreira de durabilidade: ele commita a transação de
  escrita ativa (`_activeTx`). Chamá-lo depois de um append lança `TypeError` — porque
  `append()` **já o chamou**, e `_activeTx` voltou a ser `null`.
- É esse o ponto: `append()` monta a transação, escreve blocos, árvore, bitfield e cabeça, e
  só resolve **depois** de `View.flush()` levar o lote ao motor de armazenamento (RocksDB).
  Quando o `await` volta, a escrita já foi commitada. Não há segunda chamada a fazer, e
  pedi-la no normativo era pedir um erro em tempo de execução.

**O que foi medido** (2026-08-17, Node 22 / WSL2 / ext4, `hypercore@11.35.1`): um processo que
appenda *N* registros e se mata com `SIGKILL` **imediatamente** depois de o último `await`
resolver — sem `close`, sem checkpoint — deixa os *N* registros legíveis na reabertura.
Reproduzido com *N* = 1, 50 e 500, 100 % em todas.

**O que continua aberto, e é de G4.** A medida acima cobre **morte de processo**, que é o
oráculo de §28.3 (`SIGKILL` em cada ponto da matriz). Ela **não** cobre queda de energia nem
pânico de kernel, e não há como concluí-lo por leitura: `rocksdb-native` não expõe
`WriteOptions` no caminho de escrita — `rocksdb_write()` é chamado sem opções —, e o padrão do
RocksDB é `sync = false`, o que deixa o WAL no cache de página do sistema sem `fsync`. Um
`SIGKILL` não perde cache de página; um corte de energia perde. Enquanto G4 não medir com
`fsync` observado, vale o piso conservador:

> **Regra normativa:** a barreira do append garante durabilidade contra **falha de processo**,
> não contra falha de energia. Nenhuma superfície pode prometer mais do que isso ao usuário
> (§24.1), e o eixo otimista de §11.1 continua correto justamente porque a outbox de §11.2
> vive em `manifest.db` com `synchronous=FULL` — a fila é a garantia forte, o log não precisa
> ser.

G4 mede a matriz de §28.3 inteira contra o caminho de escrita **completo** (outbox +
`communityHost` + grupo de commit de §11.5), que é código da fase 3; o que está fechado aqui é
só a pergunta "qual é a primitiva", que era o bloqueio de spec.

---

### 10.8 Lock composto e instância única

Um único processo núcleo por diretório de dados. O lock é **composto** e adquirido nesta
ordem exata, sempre:

1. `app.requestSingleInstanceLock()` no main (instância de aplicação).
2. Lock exclusivo de arquivo em `p2p/LOCK` (`flock`/`LockFileEx`), mantido pelo **núcleo**,
   com o PID e o `install_id` gravados dentro.
3. Abertura do RocksDB do corestore (que tem lock próprio).
4. Abertura de `manifest.db` e `view.db`.

Regras:

- Falha em (1) → o main encaminha o argv à instância viva e encerra silenciosamente.
- Falha em (2) → `E_CORE_ALREADY_RUNNING` com o PID; **lock órfão** (PID inexistente ou de
  outro `install_id`) é quebrado automaticamente, com log `lock.stolen`.
- **Emenda de 2026-09-05 — não há etapa (2) sem `flock`/`LockFileEx`.** A exclusão é do
  sistema operacional; comparar o PID gravado no arquivo **não** é a etapa (2) e não pode
  substituí-la, porque entre ler o arquivo e escrevê-lo cabem duas instâncias inteiras — a
  corrida que a etapa existe para fechar. Se o `flock` não puder sequer ser tentado (addon
  nativo ausente ou sem rebuild para esta versão de Electron), o núcleo recusa abrir com
  `E_CORE_LOCK_UNAVAILABLE`. O PID e o `install_id` gravados dentro do arquivo continuam
  servindo ao que sempre serviram: dizer **quem** é o dono na mensagem de erro e reconhecer
  o órfão de outra instalação — nunca decidir se o lock está livre.
- Falha em (3) ou (4) → libera (2) antes de encerrar; nunca deixa lock pendurado.
- `identity.wipe` só roda com (2) em mãos e usa a máquina de estados de §18.6.

`REQUIRES POC` — G0/G10 (lock órfão, crash em cada etapa, `wipe`, deep link com app aberto).

---

## 11. Caminho de escrita: outbox, submissão, durabilidade, reconciliação

Resposta direta ao blocker B5.

### 11.1 A regra única do eixo otimista

v1 tinha duas regras conflitantes: `message.send` assíncrono e todo o resto síncrono de
30 s, enquanto a UX era otimista na Camada 2 inteira (`F-15`). v2 fecha:

> **Toda op do domínio de mensagem (`message.send`, `message.edit`, `message.delete`,
> `message.pin`, `reaction.set`, `thread.create`) é assíncrona por contrato: vai para a
> outbox durável, o comando IPC retorna `{opId, state}` imediatamente, e o desfecho chega
> por evento.**
>
> **Toda op de estrutura, cargo, moderação, comunidade e convite é síncrona: exige host
> online, não enfileira, e falha na hora com `E_HOST_UNAVAILABLE`.**

Isso é o que torna a UI otimista defensável: ela só é otimista onde existe fila durável e
reconciliação. Nas demais, é confirma-depois-desenha. Registrado como delta U-02.

**Exceção única e declarada — `member.leave`.** Sair de uma comunidade é a única op de
não-mensagem cujo efeito **local** não depende do host: o cliente sai do swarm, marca
`left_at` em `manifest.communities` e descarta a outbox daquela comunidade
**imediatamente**, com host online ou offline. O `member.leave` é **enfileirado** para que
os demais membros vejam a saída. Se ele nunca for entregue (host que nunca volta), os
outros continuam vendo a pessoa no roster — **LIMITAÇÃO DECLARADA (L-22)**, com o texto
correspondente na confirmação de saída. Nenhuma outra op de estrutura, cargo, moderação,
comunidade ou convite enfileira.

**Emenda de 2026-08-23 — segunda exceção declarada: `identity.update`.** A tabela de
§15.4 declara `identity.update` **A** ("uma op por comunidade", resposta
`{queued:[{communityId, opId}]}`): o perfil muda em TODA comunidade participada, não há
estado novo para o host confirmar por op, e o `fold` aplica idempotente — exatamente o
contrato da fila. A ponte de submissão o aceita como segunda exceção declarada (o mesmo
arranjo do `member.leave`; a coluna `Fila` de §7.4.1 continua sem linha para ele porque a
classificação da tabela é por domínio). Nenhuma outra op de não-mensagem enfileira.

### 11.2 `local_outbox` (em `manifest.db`, `synchronous=FULL`)

| Coluna | Tipo | Notas |
|---|---|---|
| `local_seq` | `INTEGER PRIMARY KEY AUTOINCREMENT` | **Ordem de entrega**; monotônico local, não relógio de parede (fecha `DS-21`) |
| `op_id` | `TEXT UNIQUE NOT NULL` | hex do `opId`; enfileirar o mesmo envelope duas vezes é no-op |
| `community_id` | `TEXT NOT NULL` | — |
| `channel_id` | `TEXT` | Nulo para ops sem canal; permite descarte por canal |
| `sequence_scope` | `TEXT NOT NULL` | `community` ou o `channelId` assinado no envelope; chave do contador de `authorSeq` |
| `kind` | `INT NOT NULL` | — |
| `author_seq` | `INT NOT NULL` | Consumido no enfileiramento, nunca reatribuído |
| `envelope` | `BLOB NOT NULL` | Já assinado. **Nunca reassinado** |
| `client_ref` | `TEXT` | Correlação com a bolha otimista (fecha `F-44`) |
| `created_at` | `INT NOT NULL` | Informativo |
| `attempts` | `INT NOT NULL DEFAULT 0` | — |
| `next_attempt_at` | `INT NOT NULL` | — |
| `state` | `TEXT NOT NULL` | §11.3 |
| `acked_seq` | `INT` | `seq` informado pelo host no ACK, quando houve |
| `last_error` | `TEXT` | Código de §20 |
| `dropped_reason` | `TEXT` | Motivo nomeado (§11.7) |

Índices: `idx_outbox_ready(community_id, state, next_attempt_at)`,
`idx_outbox_channel(community_id, channel_id)`.

### 11.3 Máquina de estados da outbox (fecha `DR-24`)

```
            enqueue
               │
               ▼
           ┌────────┐  flush   ┌─────────┐  ACK{seq}  ┌───────────────────────┐
           │ queued │─────────▶│ sending │───────────▶│ awaiting-confirmation │
           └────────┘          └─────────┘            └───────────┬───────────┘
             ▲   ▲                  │                             │ opId observado
             │   │  erro            │ erro terminal               │ na própria réplica
             │   │  transitório     │ / rejeição do fold          ▼
             │   └──────────────────┤                        (removido)
             │                      ▼
             │                 ┌─────────┐   usuário/canal/comunidade
             └── retry ────────│ failed  │──────────────────────▶ dropped(motivo)
                               └─────────┘
```

| Transição | Gatilho | Regra |
|---|---|---|
| `→ queued` | `enqueue` | Consome `authorSeq` no `sequenceScope`, grava com `FULL`, responde ao renderer |
| `queued → sending` | `flush` pega o item de menor `local_seq` pronto do canal | Um item `sending` por canal por vez |
| `sending → awaiting-confirmation` | ACK do host com `{seq, hostTs}` | Grava `acked_seq`. **Não remove** |
| `awaiting-confirmation → removido` | O projetor local observa o `opId` do item em `observed_ops` | **É a única condição de remoção**; `lastAuthorSeq` sozinho nunca basta |
| `sending → queued` | Erro transitório (§20) | Backoff (§22.3) |
| `sending → failed` | Erro terminal | `last_error` preenchido; item continua visível na UI com "Tentar novamente" |
| `failed → queued` | `message.retry{opId}` | **Reenvia o mesmo envelope**, mesmo `authorSeq`, mesmo `opId` (fecha `DS-16`) |
| `sending → queued` | Boot após crash do processo | Todos os `sending` órfãos voltam a `queued`, sem consumir tentativa e sem limpar o envelope |
| `qualquer → dropped` | Canal/comunidade sumiu, banido, expiração reconciliada | §11.7 |

**Nunca existe um item entregue e perdido, nem um item perdido reportado como entregue.**
Os dois únicos estados terminais são: removido (observado na própria réplica) ou
`dropped` com motivo nomeado.

**Recuperação de processo:** no boot, depois de abrir `manifest.db` e antes do primeiro
`flush`, todo item em `sending` é tratado como órfão do processo anterior e volta a
`queued`, com `next_attempt_at = agora` e sem incrementar `attempts`. O envelope, `opId`,
`client_ref` e `sequence_scope` permanecem idênticos. Se o host já o tiver appendado, o
reenvio do mesmo envelope produz `E_DUPLICATE` e a remoção ainda depende de `observed_ops`;
se não tiver, a tentativa normal o entrega. `awaiting-confirmation` não é convertido: ele
segue para reconciliação.

### 11.4 Submissão no host — a seção crítica

`communityHost` mantém **uma fila de uma via por comunidade**. A seção crítica cobre somente
a decisão, a atribuição da ordem e a reserva do estado do grupo; ela **nunca espera I/O do
core**. O contrato é:

1. Sob a seção crítica, calcula `hostTs`, executa `foldRecord` contra o `DS` committed mais
   o estado provisório do grupo corrente e recusa sem reservar quando o desfecho não é
   `APPLIED`.
2. Para `APPLIED`, fixa o `seq` relativo ao grupo, monta o `HostRecord` e adiciona a decisão
   ao grupo corrente. O `DS` provisório é visível somente para decisões do mesmo grupo.
3. Libera a seção crítica enquanto a janela de group commit (§11.5) coleta as submissões.
   Há no máximo **um grupo em append** por comunidade; nenhuma decisão de um grupo seguinte
   pode observar uma reserva cujo resultado ainda não foi decidido.
4. Fora da seção crítica, faz uma única chamada `core.append([...])`. A resolução da promessa
   é a barreira de durabilidade (§10.7.1); não existe chamada posterior de `core.flush()`.
5. Se o append resolver, publica o `DS` provisório como `DS` committed e só então resolve as
   promessas com `{seq, hostTs}`. Se falhar, descarta o grupo inteiro, restaura o `DS` anterior
   e resolve todos os itens com `E_STORAGE_FULL` ou `E_INTERNAL`; nenhum ACK é emitido.

**Propriedades que isso dá, e que v1 não tinha:**

- A validação lê `ds` **na cabeça do log**, não uma projeção atrasada. A janela de `DS-01`
  deixa de existir.
- O avanço do `DS` só é publicado depois do append resolvido; não há estado de um grupo
  falho visível para um grupo seguinte.
- Se o append falhar, a reserva provisória é descartada como uma unidade: nada é ACKado e
  nenhum `seq` fantasma fica no estado do host.
- A projeção do host roda pelo mesmo caminho de todo mundo, a partir do log. O `DS` do
  `communityHost` e o `DS` do `projector` são **a mesma instância** — o host não tem
  caminho privilegiado nem estado duplicado. Fecha `DR-18`.

**Quantas vezes cada registro é interpretado, no host (fecha `HOLE-13`).** "Mesma
instância de `DS`" e "a projeção do host roda pelo mesmo caminho de todo mundo, a partir
do log" lidos juntos sugeriam que o host interpretaria cada registro **duas** vezes — uma
na admissão, outra ao projetar —, o que duplicaria efeitos ou exigiria o estado duplicado
que o próprio §11.4 proíbe. A regra é:

| Momento | Quem roda o `fold` | O que o projetor faz |
|---|---|---|
| **Op local admitida** | O `communityHost`, **uma vez**, no passo 3 | Consome os `Effect` **daquela** execução. Não reinterpreta |
| **Registro vindo da rede** (réplica, ou host em catch-up) | O projetor, uma vez, no caminho de réplica | Aplica os `Effect` que ele mesmo produziu |
| **Reinício** | O `DS` é reconstruído do log pelo caminho de réplica, do snapshot em diante | Idem |

O host não tem atalho: o caminho de admissão e o de réplica executam **o mesmo**
`foldRecord`. O que não acontece é o mesmo `seq` passar duas vezes pelo `fold` na mesma
instalação. POC-01 mede exatamente isso: o `DS` de admissão e o `DS` reconstruído do log
produzem hash de dump idêntico em 100 % dos cenários.

Na admissão local, consumir os `Effect` inclui materializar a linha correspondente em
`observed_ops` na projeção do host; na réplica, o projetor faz a mesma materialização ao
aplicar o lote. A origem da linha é sempre uma execução `APPLIED` do mesmo `fold`, nunca um
ACK ou uma marca d'água.

**Relógio quebrado no host (fecha `DS-29`):** se `clock.now() < ds.lastHostTs −
HOST_CLOCK_ALARM_MS`, o host **não** para de aceitar (isso mataria a comunidade); ele usa
`lastHostTs` (R-1), emite `host.clockSuspect` e a UI do host exibe um aviso acionável.
Nenhuma escrita é perdida por causa de um relógio errado.

### 11.5 Group commit

Submissões concorrentes são agrupadas: o host acumula registros por até
`GROUP_COMMIT_WINDOW_MS` (default 4 ms) ou `GROUP_COMMIT_MAX` (default 64) registros, faz
**um** `core.append([...])` — que já é o commit, §10.7.1 — e só então responde a todos do
grupo.

O agrupamento só existe porque a espera do append está **fora** da seção crítica de §11.4.
Durante um append há no máximo um grupo em voo por comunidade; novas decisões aguardam o
resultado sem segurar o lock. Se o append falhar, o grupo inteiro é rejeitado e seu `DS`
provisório é descartado. O limite 64 é o contrato; o POC-07 observou no máximo 32 porque o
seu tráfego usou `submitOps` de 32, e isso não altera o limite normativo.

Isso é o que amortiza o custo do commit durável e ainda permite mirar o alvo de `submitOp`
p95. A existência e o custo de `fsync` no caminho do core continuam limitados pela evidência
de §10.7.1. **`BENCHMARK REQUIRED` — G9/B1.** Se o benchmark reprovar, a decisão objetiva
está em §26.1: o alvo de latência é renegociado, **nunca** a barreira de durabilidade.

### 11.6 Reconciliação (o coração do B5)

Roda no boot, em `host.cameBack`, e a cada `OUTBOX_RECONCILE_MS`.

```
para cada item em (sending | awaiting-confirmation | failed):
    observado := replica.observed_ops[item.op_id]
    se observado existe:
        → a op está APPLIED na réplica: remove o item,
          emite message.accepted{opId, observado.seq, clientRef}
    senão se watermark(author, sequenceScope) >= item.author_seq:
        → a marca d'água não prova esta op; mantém `failed` com
          E_AUTHOR_SEQ_OVERTAKEN e não reporta entrega
    senão se item.acked_seq != null e ds.interpretedSeq >= item.acked_seq:
        → o host disse que appendou, mas o log interpretado não contém: o host mentiu,
           reordenou ou censurou. Item volta a `queued` e conta `host.ackMismatch`
    senão:
        → indeterminado: mantém, respeitando o backoff
```

`watermark < item.author_seq` é apenas uma negativa barata. O ramo de remoção exige a
presença do `opId` em `observed_ops`, que registra somente `APPLIED`; um registro
`REJECTED`/`IGNORED`, um ACK e uma marca d'água alta nunca confirmam entrega. Em uma outbox
conforme a `sequenceScope`, `E_AUTHOR_SEQ_OVERTAKEN` é inalcançável: se aparecer, indica
incompatibilidade de protocolo, corrupção ou violação do escalonador e deixa o item visível
como `failed` para diagnóstico, sem reenvio automático de um envelope que o host já recusará.
Esse estado não é elegível para `message.retry`; só uma correção de compatibilidade ou
reconstrução autorizada da fila pode removê-lo, sem reassinar silenciosamente a operação.

Regras normativas que decorrem:

1. **Um item nunca é descartado por idade sem reconciliação.** `OUTBOX_MAX_AGE_MS` só pode
   produzir `dropped/expired` depois de uma reconciliação com `interpretedSeq ≥ acked_seq`
   (ou sem nenhum ACK) — fecha `DS-06`, `DS-07`.
2. O `seq` que a UI exibe é sempre o **observado na réplica**, nunca o do ACK. Fecha
   `DS-31`: `message.accepted` passa a ser emitido **pela reconciliação**, ou seja,
   **depois** de `messages.appended`. A ordem entre os dois eventos é determinada e
   documentada.
3. `E_VERSION_UNSUPPORTED` é **classificado como terminal** e vira `dropped` com motivo
   `client-outdated`, não fica 72 h queimando retry. Fecha `DS-25`.

### 11.7 Descarte com motivo nomeado

| Motivo | Quando | Alcançável? |
|---|---|---|
| `channel-deleted` | O canal foi tombstonado | Sim — **emenda de 2026-08-22:** o produtor em código é o `channel.delete` local, que descarta a fila do canal e devolve `droppedQueued`. O tombstone feito por **outra** pessoa ainda não derruba a fila local: a op segue e o host a recusa com `E_CHANNEL_NOT_FOUND` |
| `community-ended` | `community.end` projetado | Sim |
| `left-community` | `member.leave` local | Sim |
| `banned` / `kicked` | O `fold` local observou `mod.ban`/`mod.kick` sobre a identidade local | **Sim** — em v2 o alvo continua replicando até aplicar o ban, então ele *vê* o próprio ban antes de perder acesso (§14.3). Fecha `DS-08`/`F-10` |
| `permission-lost` | O `fold` recusou com `E_PERMISSION_DENIED` de forma terminal | Sim |
| `expired` | Reconciliado e ausente do log por mais de `OUTBOX_MAX_AGE_MS` | Sim |
| `client-outdated` | `E_VERSION_UNSUPPORTED` | Sim |
| `cancelled` | `message.cancelQueued` sobre item em `queued` ou `failed` | Sim |

`message.cancelQueued` sobre item em `sending` ou `awaiting-confirmation` devolve
`E_ALREADY_SENT` — **não há promessa de cancelamento que o host não pode cumprir**. Fecha
`DS-28`.

**Limites da outbox:** `OUTBOX_MAX_ITEMS` (500 por comunidade) → `E_OUTBOX_FULL` na hora,
nunca enfileira às cegas. **Ordem:** por `local_seq` **dentro do canal**; um item bloqueado
segura o próprio canal e não os outros. Isso é compatível com a deduplicação porque cada canal
tem `sequenceScope` próprio; nenhum avanço de `authorSeq` em um canal pode ultrapassar uma
operação pendente de outro canal.

### 11.8 Backoff, circuit breaker e avalanche

- Curva única: `delay = min(1000 · 2^attempts, 60000) ± 20 %` de jitter.
- **Circuit breaker (fecha `DS-24`):** 5 falhas **de conexão** consecutivas → estado `open`
  por 30 s ± jitter. Enquanto `open`, o `flush` **não consome tentativa** de nenhum item:
  `attempts` só é incrementado quando houve uma tentativa real de entrega. Transições
  escritas: `closed → open` (5 falhas de conexão), `open → half-open` (após a pausa),
  `half-open → closed` (uma entrega bem-sucedida), `half-open → open` (falha).
- **Flush pós-reconexão (fecha `DS-10`):** o flush em `host.cameBack` **não** é imediato
  para todos. Ele começa após `RECONNECT_FLUSH_DELAY_MS` com jitter proporcional a
  `hash(identityKey) mod 2000 ms`, e a taxa é limitada a `FLUSH_RATE_PER_S` itens por
  segundo por comunidade. Sem isso, 340 membros reconectam em fase e produzem avalanche
  exatamente no pior momento.
- **Fila do host (fecha `DS-10`):** a fila de admissão do host tem profundidade
  `HOST_QUEUE_DEPTH` (default 512) por comunidade. Cheia → `E_BUSY` com `retryAfterMs`,
  **antes** de qualquer verificação cara. Isso é shedding explícito, não backlog infinito.

### 11.9 `submitOps` em lote

`submitOps{envelopes[≤32]}` devolve **um resultado por envelope**, sempre com os 32 itens
representados:

```
[{ index, ok:true, seq, hostTs } | { index, ok:false, code, retryAfterMs? }
 | { index, ok:false, code:'E_NOT_ATTEMPTED' }]
```

O host processa na ordem, **não para no primeiro erro**: um erro terminal marca aquele item
e continua com os seguintes. Só um erro de infraestrutura (`E_STORAGE_FULL`, breaker do
próprio host) interrompe, e aí todos os restantes voltam como `E_NOT_ATTEMPTED` e
permanecem `queued`. Fecha `DS-26`.

**Conflito com o rate limit (fecha `DS-23`):** o controle de taxa por autor é aplicado
**ao lote inteiro como um só evento de custo `n`**, não `n` eventos de custo 1. Um lote que
excede o budget devolve `E_RATE_LIMITED` para o excedente com `retryAfterMs`, mantendo os
aceitos aplicados. O tamanho máximo do lote (32) e o burst do bucket (§26.3) são calibrados
juntos, na mesma linha da tabela, e não em seções diferentes.

---

## 12. Convites e admissão

Resposta direta ao blocker B3.

### 12.1 Derivação

```
inviteSecret   = 10 bytes aleatórios                      (80 bits)
código exibido = Crockford-Base32(inviteSecret)           16 chars, 4 grupos de 4
inviteSeed     = BLAKE2b-256('invite-seed/1' ‖ inviteSecret)
(invitePk, inviteSk) = ed25519_keypair_from_seed(inviteSeed)
inviteTopic    = BLAKE2b-256('invite-topic/1' ‖ invitePk)
```

**A propriedade que resolve o convite delegado:** o log guarda `invitePk`. Qualquer membro
pode criar um convite; o host valida usando a **chave pública** que está no log e **nunca
precisa conhecer o segredo**. É a razão de o esquema de v1 (hash do segredo +
challenge-response de conhecimento) ser inexecutável e este não ser.

**A propriedade que resolve o rendezvous pré-membro (`F-09`):** o candidato deriva
`invitePk` **só do código**, e daí o tópico. Ele não precisa saber `communityId`, `coreKey`
nem quem hospeda antes de conectar. O código curto de 16 caracteres é auto-suficiente; o
link é conveniência.

### 12.2 Emissão

1. `invite.create` gera `inviteSecret`, deriva `invitePk`, grava
   `manifest.invite_secrets` (`FULL`).
2. Appenda `invite.create{invitePublicKey, expiresAt?, maxUses?, label?}` — op síncrona,
   exige host online e `create_invite`.
3. O **host** faz `swarm.join(inviteTopic, {server:true})` para cada convite ativo, e sai
   do tópico quando o convite expira, esgota ou é revogado (job de §22.2).

### 12.3 Preview (`inviteResolve`)

Canal **pré-membro** (§14.4), com o orçamento e os tetos mais restritos do sistema.

```
1. candidato → host:  hello{clientOpVersion}
2. host      → cand:  challenge{16 bytes aleatórios, hostPk}
3. candidato → host:  resolve{ invitePk, candidatePk,
                               liveProof = Ed25519(inviteSk,
                                 BLAKE2b('invite-auth/1' ‖ invitePk ‖ hostPk
                                         ‖ candidatePk ‖ challenge)) }
4. host verifica liveProof com invitePk  →  falha: fecha a conexão, sem segunda tentativa
5. host avalia, nesta ordem:
     comunidade ended?              → { status:'ended', communityName }
     candidato banido?              → { status:'banned', communityName }   // sem contagem, sem convidador
     já é membro?                   → { status:'already-member', community }
     convite revogado/expirado/esgotado? → { status:'invalid' }
     senão                          → { status:'ok', community{id,name,iconEmoji,iconColor,memberCount},
                                         invitedBy{key, displayName, handle} }
6. host offline / inalcançável (decidido pelo cliente) → { status:'unreachable', hint }
```

**Seis desfechos, normativos.** A UX tem quatro — delta U-03.

**`liveProof` fecha `T-06`:** ele amarra `hostPk` e `candidatePk`, então quem observa o
tópico e captura a prova não consegue reusá-la para si nem contra outro host.

**Por que `banned` é alcançável agora (fecha `F-10`, `DS-08`, `C-2`):** o canal pré-membro
**não** aplica o firewall de banidos. Ele aplica teto de bytes, rate limit por par e
fechamento de conexão a cada prova errada. O firewall de banidos vale para o canal de
**replicação** (§14.3), não para o de admissão.

### 12.4 Resgate (`inviteRedeem`)

```
1. candidato monta a Op member.join:
     payload = { invitePublicKey, joinProof, displayName, avatarColor, blobsCoreKey }
     joinProof = Ed25519(inviteSk,
                   BLAKE2b('invite-join/1' ‖ communityId ‖ invitePk ‖ candidatePk))
   → o candidato precisa do communityId, que o host devolveu no preview (status ok)
   → a Op é assinada pela identidade do candidato (author = candidatePk)
2. candidato → host: redeem{ envelope, liveProof }
3. host revalida liveProof, e entrega o envelope à MESMA fila de admissão de §11.4
4. o fold aplica R-9: verifica joinProof com invitePk, checa revogação/expiração/uses,
   registra (invitePk, candidatePk) em joinedByInvite e incrementa uses — TUDO no mesmo
   passo atômico da seção crítica
5. host responde { seq, communityId, coreKey, blobsKey, defaultChannelId, hostKey }
6. candidato grava a participação em manifest.communities (FULL), faz swarm.join dos
   cores e projeta do seq 0
```

**Consumo atômico de `maxUses` (fecha `DS-05`, `F-02`):** `uses` é campo do
`DecisionState`, avançado dentro da seção crítica, na mesma operação que decide a admissão.
Dez candidatos simultâneos com `maxUses=1` produzem **exatamente um** `member.join` e nove
`E_INVITE_EXHAUSTED`. Não há leitura de projeção atrasada em lugar nenhum do caminho.

**`joinProof` é verificável para sempre por toda réplica** — ele não depende do challenge
efêmero. É isso que permite ao `fold` de um membro que entrou depois confirmar que aquele
join foi autorizado.

**`member.join` é assinado pelo próprio candidato** (fecha `F-06`): o host não fabrica
autoria; ele só decide se o registro entra.

### 12.5 O que o preview vaza, e o que não vaza

| Desfecho | Devolve | Não devolve |
|---|---|---|
| `ok` | nome, ícone, cor, `memberCount`, quem convidou (nome + `handle`) | nada além disso |
| `already-member` | nome, ícone, cor | `memberCount`, convidador |
| `banned` | **só** o nome da comunidade | contagem, convidador, ícone |
| `invalid` / `unreachable` | nada | — |
| `ended` | só o nome | — |

`hello` **não** responde a quem não é membro e não está num fluxo de convite (fecha
`T-38`): o handshake de replicação exige autorização (§14.3); o canal pré-membro só expõe
`inviteResolve`/`inviteRedeem`.

### 12.6 Defesa contra força bruta e Sybil

| Controle | Valor |
|---|---|
| Entropia do segredo | 80 bits |
| Prova errada | **Fecha a conexão**; sem segunda tentativa na mesma conexão |
| Rate limit pré-membro | Por chave pública do par **e** por prefixo /24 do endereço observado (`INVITE_RATE_PER_PEER`, `INVITE_RATE_PER_SUBNET`) — fecha `DR-31`, que apontava que "IP do peer" não é a chave disponível: o que existe é a `remotePublicKey` do Noise e o endereço UDP observado, e v2 usa os dois |
| Orçamento de conexão pré-membro | `PREMEMBER_CONN_BUDGET` (default 8 simultâneas por comunidade hospedada), separado do orçamento de membros — fecha `T-08` |
| Teto de bytes antes do decode | `PREMEMBER_MAX_FRAME_BYTES` (4 KiB) — fecha `T-34` |
| Convites ativos por comunidade | 50 |

**Emenda de 2026-08-22 — onde os tetos vivem no fio.** A implementação do canal
pré-membro (`p2p-admission/1`) fixou três pontos que a tabela acima pressupunha sem dizer:

1. **O rate limit é node-level e vale uma única vez por request**, aplicado **antes do
   decode** (ordem de §14.4): o mesmo pedido não pode ser contado duas vezes — uma pelo
   transporte e outra pelo `InviteManager` da comunidade — porque isso reduziria pela metade
   efetivo os tetos declarados. Quadro limitado **não existe para nós**: nem decode, nem
   resposta, nem consumo de challenge.
2. **O orçamento de conexões pré-membro é por tópico de convite** (8 simultâneas por
   tópico). §12.6 diz "por comunidade hospedada", mas um candidato no meio do preview ainda
   não tem comunidade nomeada — o tópico é o agrupador disponível dos dois lados do fio, e
   cada tópico pertence a exatamente uma comunidade.
3. **Prova errada fecha a conexão sem resposta útil**: o host envia `E_INVITE_INVALID` e
   fecha; o candidato vê falha de transporte, que é o contrato de §12.3 passo 4.

**LIMITAÇÃO DECLARADA (L-8) — Sybil:** identidade é gratuita e não há custo de entrada. O
convite limita **quem entra**, não **quantas identidades uma pessoa tem**. Um convite
vazado com `maxUses` alto permite raide; a mitigação é revogar e usar `maxUses` baixo. O
produto **não** implementa aprovação manual (corte de escopo herdado da UX) — delta U-05
registra que o texto de 0.3 precisa dizer isso.

---

## 13. Anexos e blobs

Resposta direta ao blocker B4.

### 13.1 Ownership: um core de blobs por autor

v1 tinha um único `hyperblobs` por comunidade, com escritor único do host, e ao mesmo tempo
mandava o membro fazer `blob.stage` local — criptograficamente impossível (`F-03`).

v2:

| Core | Chave | Escrito por | Replicado por |
|---|---|---|---|
| `log` | `coreKey` = id da comunidade | host | todos os membros, integral |
| `blobs` do **membro X** | `memberBlobsKey(X, community)` | **X** | quem baixou algum anexo de X (sparse) |
| `blobs` da **comunidade** | `blobsKey` (§5.3) | host | opcional; usado só por `community.*` no futuro. **Sem uso no v1** |

```
memberBlobsSeed = BLAKE2b-256('ns/memberblobs/1' ‖ identitySeed ‖ communityId)
(memberBlobsPk, memberBlobsSk) = ed25519_keypair_from_seed(memberBlobsSeed)
```

- Derivável só pelo dono, recuperável por ele em qualquer reinstalação a partir do backup
  de identidade (§5.5).
- **Publicado no log**: em `member.join` (campo `blobsCoreKey`) e alterável por
  `member.setBlobsCore`. Portanto é dado do log, recuperável por toda réplica — fecha o
  lado de anexos do B2.
- O `AttachmentRef` na mensagem carrega `blobsCoreKey`, então o leitor sabe **de qual core**
  buscar sem consultar ninguém.

**Emenda de 2026-08-22 — a semente é derivada, e a linha do manifest é atalho.** A
derivação acima é a **única** fonte da semente: `community.create` (§19.1 passo 3) e
`invite.redeem` (§12.4) calculam `memberBlobsSeed` a partir do `identitySeed` e do
`communityId`, e a linha `member_blobs_core` (§10.2) guarda essa mesma semente cifrada pela
Data Key apenas como atalho local e verificação cruzada — nunca como a única cópia. No boot,
a comparação que autoriza abrir o writer é contra a chave **publicada no log**
(`member.join` / `member.setBlobsCore`), caindo para a cópia local só enquanto o log desta
instalação ainda não tem a entrada do próprio; e quando a linha falta ou não decifra, o boot
a **reescreve** a partir da derivação. É isto que realiza a promessa desta seção e de §5.5:
quem restaura a identidade recupera os cores de blobs sem o `manifest.db` da máquina
anterior — o backup de §5.5 nunca carregou esta semente, e não precisa carregar. A chave do
core fica determinística da identidade, e isso **não** expõe nada novo: ela já é dado do log
público desde o `member.join`.

**O host nunca recebe os bytes do anexo.** O caminho de controle (RPC de ops) e o caminho
de dado (replicação de blobs) são cores diferentes, conexões diferentes e orçamentos
diferentes. Fecha `F-03` e o cenário de 8 GiB monopolizando o RPC.

### 13.2 Fluxo de upload

```
1. renderer: file.pickForAttachment{communityId}
2. main: dialog.showOpenDialog  →  path
3. main → núcleo (IPC-M): stagingTicket{ticketId, path, sizeBytes, communityId}
   main → renderer: {ticketId, name, sizeBytes, kind}      // renderer NUNCA vê o path
4. renderer: blob.stage{ticketId}
5. núcleo: abre o core de blobs local da comunidade; lê o arquivo em stream;
   calcula BLAKE2b('blob-hash/1' ‖ conteúdo) na mesma passada;
   hyperblobs.put em chunks, journalando bytesWritten em manifest.local_blob_staging
6. núcleo → renderer: {blobId, hash, sizeBytes, kind}
7. renderer: message.send{ ..., attachment:{blobsCoreKey, blobId, name, sizeBytes, kind, hash} }
```

**Emenda de 2026-08-22 — o `hyperblobs.put` é realizado por blocos do próprio core.** O
passo 5 acima não exige um segundo formato de armazenamento: cada `blob.stage` appenda o
arquivo no core de blobs do autor em **fatias de 64 KiB** (constante operacional,
`BLOB_CHUNK_BYTES`), e o `blobId` de §7.2.1 é exatamente o recorte resultante —
`blockOffset` = comprimento do core antes do append, `blockLength` = número de fatias,
`byteLength` = tamanho do arquivo, `byteOffset` = 0. A motivação é tripla: (a) `hyperblobs`
seria uma dependência nova para representar o mesmo conteúdo que o hypercore já endereça;
(b) o fio de `AttachmentRef` não muda um byte — o quádruplo sempre foi a interface; (c) a
fatia fixa torna `blockOffset`/`blockLength` determinísticos dos dois lados, sem índice
lateral. Quem preferir `hyperblobs` numa implementação alternativa continua satisfeito:
nada nesta seção depende de como os bytes se dividem dentro do core, desde que a faixa do
`blobId` devolva os bytes cujo hash está na mensagem.

### 13.3 Origem do caminho — ticket, nunca string

**O núcleo recusa qualquer `path` vindo do renderer, sempre.** O único caminho aceito é o
que chegou pelo IPC-M dentro de um ticket emitido pelo main após um diálogo do SO.

Propriedades do ticket:

| Propriedade | Valor |
|---|---|
| `ticketId` | 16 bytes aleatórios |
| Validade | `STAGING_TICKET_TTL_MS` (default 15 min) |
| Uso | **uma vez**; consumido no `blob.stage` |
| Escopo | um `communityId`, um caminho |
| Visibilidade | o `path` **nunca** cruza o IPC-R, nem em resposta, nem em erro, nem em log |

Fecha `T-16` e `DR-37`: um renderer comprometido não consegue exfiltrar arquivo arbitrário,
porque não existe superfície que aceite caminho dele.

**Emenda de 2026-09-05 — "uma vez" e "15 min" precisam valer também contra a RETOMADA.**

`TicketStore` é memória e `local_blob_staging` é disco (§13.5): depois de um restart, o
ticket não existe mais e a linha existe. O produto tratava isso com um `catch` que
reconstruía o ticket a partir da linha sempre que ela estivesse em `pending`/`writing` —
qualquer que fosse o motivo da recusa. Duas propriedades desta tabela caíam junto:

1. **A validade.** Ticket **vencido** caía no mesmo caminho de retomada, então a TTL era
   inócua sempre que a linha sobrevivesse: bastava o renderer guardar um `ticketId` velho e
   encenar o `stage` horas depois, dentro da janela órfã de 24 h.
2. **O uso único.** A guarda contra reuso lia `state = 'done'`, que só é gravado no **fim**.
   Dois `stage` concorrentes do mesmo ticket — duplo clique em "anexar" — passavam os dois:
   um vencia o consumo, o outro caía na retomada, e os **dois** appendavam o arquivo inteiro
   no core. O segundo `markDone` sobrescrevia a faixa de blocos e a do primeiro virava lixo
   que nenhum `core.clear` de §13.5/§22.4 sabe podar.

As duas regras, declaradas:

- **A retomada vale só para o ticket que este processo não conhece.** Ticket que o
  `TicketStore` tem e recusou é recusa, e o motivo dela é o que sobe. É a linha de staging,
  com a janela órfã de 24 h de §13.5, que governa a retomada — não a TTL do ticket, que
  governa a **primeira** apresentação.
- **Uso único inclui o concorrente.** Uma linha de staging tem um `stage` por vez; o segundo
  é recusado como o ticket já usado que ele é.

### 13.4 Download

```
1. blob.download{blobsCoreKey, blobId}
2. swarm.join(discoveryKey(blobsCoreKey))            // se ainda não estiver
3. hyperblobs.get por range, sparse
4. progresso a cada 500 ms: blob.progress{progress, peers, hostAvailable, bytesDownloaded}
5. abort se bytesRecebidos > declaredSize          → attachment.corrupt (§6.10)
6. ao completar: verifica hash → falha → descarta, attachment.corrupt
7. grava em blobs/<blobsCoreKeyHex>/<blobIdHex>-<name>  →  blob.completed{path}
```

**Estados de `local_blob_cache.state` (enum fechado — fecha `DR-40`):**

`not-downloaded` · `queued` · `downloading` · `verifying` · `downloaded` · `corrupt` ·
`unavailable` · `cancelled`

Retomada após crash: no boot, todo item em `downloading`/`verifying` volta para `queued`
com `bytesDownloaded` preservado; o Hypercore retoma pelo bitfield, sem reiniciar.

`availablePeers` = pares conectados que **anunciam ter** os blocos do range (leitura do
bitfield). `hostAvailable` = o `hostKey` está entre eles. **Dados reais, não estimativa.**
`blob.unavailable` só quando os dois zeram.

**Emenda de 2026-09-05 — `cancelled` é um estado do MOTOR, não um rótulo no manifest.**

`blob.cancel` gravava `state = 'cancelled'` e mais nada: nenhum ponto dos passos 3–7 lia
esse estado. O download seguia consumindo banda até o fim, gravava o arquivo em disco e
emitia `blob.completed` **por cima** do "cancelado" que a tela já mostrava — o pior desfecho
possível, porque ele desmente a única coisa que o usuário sabia sobre a operação.

**O cancelamento é conferido em cada ponto de retomada** dos passos 3–7 (entre a espera da
faixa e o primeiro bloco, entre um bloco e o próximo, e antes de gravar o arquivo). Nele o
download aborta com `E_CANCELLED`, **não sobrescreve o estado** e **não emite desfecho
nenhum** — nem `blob.completed`, nem `attachment.corrupt`, nem `blob.unavailable`: quem
cancelou já viu o desfecho que pediu. O arquivo parcial que tenha chegado a ser escrito é
removido. Um `blob.download` novo do mesmo blob limpa a marca e roda até o fim: o
cancelamento é da **tentativa**, e a linha `cancelled` no cache é o que a retomada de boot lê.

**Emenda de 2026-08-22 — a realização dos passos 2–3, e o tópico de §14.1.** O `swarm.join`
do passo 2 usa o tópico `BLAKE2b('blob-discovery/1' ‖ blobsCoreKey)` — a mesma forma da
linha "core de blobs" de §14.1, com prefixo de domínio para não colidir com as
discoveryKeys reais que já ocupam tópicos de comunidades. Quem **tem** o core anuncia
(`server`) desde o boot da comunidade; quem quer baixar procura (`client`) ao pedir o
download. O `hyperblobs.get por range` do passo 3 é a replicação do hypercore no MESMO mux
das comunidades (§16.1) — o hypercore abre canal próprio para cada core, e a autorização
continua sendo a de §14.3(1), canal a canal. Registrar um core num mux é **uma** operação
por `(mux, core)`: o `attachTo` do hypercore não é idempotente (lição de §45). A faixa
pedida é a do `blobId` projetado; o teto do passo 5 vale sobre os bytes que chegam, e o
hash do passo 6 sobre o recorte montado. Os blocos são pedidos com faixa **inclusiva** na
fronteira do núcleo — a faixa do hypercore é meio-aberta (`end − start`), e traduzir isso
na porta de L0 é o que impede o último bloco de ficar de fora.

### 13.5 Retomada e limpeza do staging (fecha `DS-22`)

`manifest.local_blob_staging` guarda `{ticketId, path, bytesWritten, rollingHashState,
state}`. No boot:

- `state = 'writing'` → retoma do `bytesWritten` (o arquivo de origem ainda existe? se não,
  `E_FILE_UNREADABLE` e o staging é descartado);
- `state = 'done'` e sem mensagem referenciando em `STAGING_ORPHAN_MS` (24 h) → `core.clear`
  dos blocos locais e remoção da linha. Como o core é **do próprio membro**, um staging
  abandonado custa disco dele, não da comunidade.

### 13.6 Abertura, tipo e quarentena

**Mapa extensão → `kind` (normativo, fecha `DR-41`):**

| `kind` | Extensões |
|---|---|
| `image` | `png jpg jpeg gif webp avif bmp tiff heic` |
| `video` | `mp4 mkv webm mov avi m4v` |
| `audio` | `mp3 wav flac ogg opus m4a aac` |
| `document` | `pdf txt md csv json xml odt ods odp docx xlsx pptx rtf` |
| `archive` | `zip tar gz bz2 xz 7z rar` |
| `other` | qualquer outra, **inclusive extensão ausente** |

**Regras de segurança (fecham `T-17`, `T-48`, `DR-41`):**

1. `blob.reveal` (abrir com o handler do SO) é permitido **apenas** para `image`, `audio`,
   `video`, `document`, `archive` e **apenas** para as extensões da tabela. Todo o resto
   (`other`) oferece somente "Mostrar na pasta".

   **Emenda de 2026-09-05 (`B73`) — `archive` entra, e entra pela porta de §15.3.** Esta
   regra e §15.3 se contradiziam: a lista aqui excluía `archive`, e §15.3 declara
   "`blob.reveal` de `archive`" na linha `main-confirmed`, com a caixa nativa escrita
   ("Abrir este arquivo compactado?"). O caminho `main-confirmed` estava construído nas
   duas fronteiras e o que o matava era esta lista — uma linha normativa inalcançável e um
   bloqueio que não bloqueava nada: "Mostrar na pasta" leva à mesma pasta, e o duplo clique
   de lá **não tem confirmação nenhuma**. Recusar aqui não removia o risco; mudava-o para o
   caminho com menos aviso. Vence §15.3, que é a regra mais específica (nomeia o tipo e
   nomeia o mecanismo de consentimento). Abrir um `archive` continua exigindo o token de
   §15.3; a regra 2 continua acima de tudo isto.
2. Uma allowlist de extensões executáveis/roteiráveis (`exe bat cmd com scr ps1 sh msi
   dll app pkg dmg deb rpm jar vbs js wsf lnk`) é **bloqueada até para revelar**: o arquivo
   é gravado com a extensão preservada, mas a UI mostra aviso de origem e não oferece ação
   de abertura.
3. Onde o SO suportar, o arquivo baixado recebe a marca de origem — na matriz de A16, só
   o Windows suporta (`Zone.Identifier`). **No Linux não há marca de origem padrão e
   nenhuma é aplicada**, o que precisa ser tratado como ausência de defesa, não como
   defesa silenciosa.
4. **Renderização inline no v1 é só para `image` nas extensões `png jpg jpeg gif webp`.**
   Vídeo e áudio **não** tocam inline no v1: exigem download explícito e abertura pelo SO.
   Isso reduz a superfície de decodificador do renderer a um decoder de imagem já
   sandboxado. `REQUIRES POC` — G11 (fuzzing) antes de qualquer ampliação.

**Emenda de 2026-09-05 — o `mode` de `shell.open`, e onde a allowlist é conferida.**

`shell.open{path, mode}` (§15.7) tem dois modos e eles são ações diferentes: `open` entrega
o arquivo ao handler do SO, `folder` mostra o item no gerenciador de arquivos. O main
tratava os dois como `open` — então "Mostrar na pasta", que é a ação **menos** invasiva e a
única que a regra 1 oferece para o que está fora da allowlist, abria o arquivo. Normativo:
`folder` **nunca** abre, e a allowlist da regra 1 governa `open`; `folder` é permitido para
o que a regra 2 não bloqueia.

**Emenda de 2026-09-05 (`B74`) — quem classifica é o núcleo, e ele passou a dizer.** A regra 1
manda a UI oferecer **somente** a ação que o tipo permite, e a UI não tinha como saber qual é:
o `kind` que viaja no log é **declarado por quem enviou** (usá-lo é o ataque `T-48` que esta
mesma regra nomeia), e derivar da extensão no renderer seria a terceira cópia da tabela acima.
O `AttachmentDto` de §15.6.1 ganha `revealMode`, decidido pelo núcleo pela **extensão real**:

| `revealMode` | O que a tela oferece | Quando |
|---|---|---|
| `open` | "Abrir" e "Mostrar na pasta" | `image`, `audio`, `video`, `document`, `archive` — regra 1 |
| `folder` | Só "Mostrar na pasta" | `other`, e qualquer extensão fora da tabela |
| `none` | Nenhuma das duas | Extensão da regra 2 (executável/roteirável) |

Vale **antes** do download: o nome está no log e o arquivo local é gravado com a extensão
preservada (regra 2), então a resposta não muda quando os bytes chegam. Continua sendo
`esconder nunca é enforcement` (§3.4 regra 3) — quem recusa é o núcleo, e a recusa é
`E_TYPE_NOT_OPENABLE`; `revealMode` só evita oferecer o botão que seria recusado.

**A conferência acontece nas duas fronteiras, e isso é deliberado.** O núcleo continua sendo
a autoridade (`canReveal`: recusa executável e tudo fora de `image`/`audio`/`video`/
`document` com `E_TYPE_NOT_OPENABLE`), e é a decisão dele que a UI vê. O main confere de
novo antes de chamar `shell.openPath`, porque §3.1 põe "`shell.openPath` (só com allowlist
de tipo, §13.6)" dentro da caixa do main: ele é quem fala com o SO, e um `openPath` que
obedece qualquer caminho vindo da IPC-M é uma etapa a menos entre um núcleo com defeito e o
handler do sistema. Duplicação de regra é o custo; a alternativa é uma fronteira que
executa sem conferir.

### 13.7 Barreira blob ↔ mensagem (fecha `DS-27`, `F-43`)

Anexar e enviar não são transacionais — e não podem ser. A ordem é normativa: **o blob
primeiro, a mensagem depois.** A ordem inversa produziria mensagem apontando para blob
inexistente, que é pior.

A barreira que v1 não tinha:

1. `message.send` com anexo **só é enfileirada** depois que o `blob.stage` completou e o
   `hyperblobs.put` foi `flush`ado no core local.
2. O autor **mantém os blocos** do anexo enquanto a mensagem existir e não estiver
   tombstonada: o GC local (§22.4) **nunca** limpa blocos de anexos enviados pela
   identidade local que ainda tenham mensagem viva.
3. Se a mensagem for entregue e o autor sumir para sempre sem outro seeder, o leitor recebe
   `blob.unavailable` — estado nomeado, desenhado, e não silêncio. **LIMITAÇÃO DECLARADA
   (L-9):** a disponibilidade de um anexo depende de haver ao menos um par com os blocos.

### 13.8 Sem cota de anexos, teto de arquivo e GC

**Emenda de 2026-09-04 (`opVersion = 3`) — `ATTACHMENT_QUOTA_PER_MEMBER` deixa de existir.**

A regra removida era `R-14`: `member.storageUsedBytes + attachment.sizeBytes ≤ 5 GiB` por
comunidade, aplicada pelo `fold` no estágio 10. Ela nasceu supondo que o anexo era empurrado
para todas as réplicas, e essa premissa não sobreviveu a três decisões posteriores: §13.1
fixa que **o host nunca recebe os bytes do anexo** (fecha `F-03` — caminho de controle e
caminho de dado são cores, conexões e orçamentos distintos), a replicação de blobs é sparse
por faixa (§13.4), e a emenda de 2026-08-27 de `frontend.md` estabelece que **nenhum
`blob.download` sai sem clique**. Quem paga o disco é quem envia, e depois só quem escolheu
baixar — que é a assimetria correta. A cota cobrava um pedágio determinístico por um custo
que já recaía sobre quem o escolhe.

Os três efeitos que a cota ainda tinha, e a decisão sobre cada um:

1. **Custo permanente do autor.** A regra 2 de §13.7 proíbe o GC local de limpar blocos de
   anexo do autor enquanto a mensagem viver, então o espaço só volta tombstonando as próprias
   mensagens. Isso continua verdade — e continua sendo escolha do autor sobre o disco do
   autor. `member.storageUsedBytes` **segue projetado** (§8.3, exposto em `query.member`):
   virou medidor de uso, não fronteira.
2. **Estoque de iscas de `F-41`** (anexo cujo `hash` não bate: quem baixa gasta banda,
   verifica e descarta). O clique obrigatório já exige uma isca por download, e o cartão
   mostra o tamanho antes. Aceito como custo, não como bloqueio.
3. **Exaustão de disco alheio por volume**, que é o lado de `T-09` que continua real: ele
   nunca foi de anexo, e sim de **texto**, que o log replica integral e sem escolha (ADR-16).
   Coberto por `R-15` (`QUOTA_BYTES_PER_WINDOW`), que não muda.

**Por que é bump de `opVersion`, e não ajuste de número.** Relaxar uma regra do `fold` muda a
projeção de logs **que já existem**: uma op hoje `REJECTED` com `E_QUOTA_EXCEEDED` passa a ser
`APPLIED` na reprojeção, e duas instalações em versões diferentes divergiriam sobre o mesmo
log. `opVersion` vai a **3**; pela regra 5 de §7.2 um cliente v2 que veja um registro v3 marca
`partialInterpretation` e bloqueia escrita local com `E_VERSION_UNSUPPORTED`, que é o
comportamento pretendido — atualizar deixa de ser opcional dentro de uma comunidade que já
escreveu em v3. `meta.op_version` (§10.3.1) decide a reprojeção no upgrade.

- **Teto por arquivo:** `ATTACHMENT_MAX_BYTES` = **2^53−1**. Não é política de produto, é
  **teto de representação**: `sizeBytes` viaja como `u64` (§7.2.1) mas é `number` no tipo, e
  acima de 2^53−1 o valor deixa de fazer round-trip. O `Reader.u64` já falha nessa mesma
  fronteira, então `E_ATTACHMENT_TOO_LARGE` **não é alcançável por registro vindo do fio** —
  quem recusa antes é o decode, com `E_MALFORMED`. A checagem do estágio 13 permanece porque o
  `fold` é total e não pode depender de quem o chamou ter decodificado; a do ticket de §13.3
  permanece porque lá o número vem do `stat` do arquivo, não do fio. A defesa contra "declara
  1 KB, entrega 8 GB" nunca foi o valor do teto: é o abort do passo 5 de §13.4 quando
  `bytesRecebidos > declaredSize`, e não muda.
- **Disco cheio é desfecho nomeado, não caso patológico.** Com a cota fora, `E_STORAGE_FULL`
  no `blob.stage` passa a ser o desfecho esperado de quem anexa arquivo grande: entra na linha
  de `blob.stage` em §15.4, é distinguido de falha de leitura (`E_FILE_UNREADABLE`) pelo
  `errno` (`ENOSPC`/`EDQUOT`/`EFBIG`), e a UI tem frase própria para ele. Segue **aberto** o
  que `T-09` (item 12) já registrava: o comportamento de `E_STORAGE_FULL` durante o append do
  log — não do blob — só está definido para a criação da comunidade (§11.1).
- **O staging não carrega o arquivo na memória.** §13.2 passo 5 passa a hashear
  incrementalmente (BLAKE2b `init`/`update`/`final`, mesmo domínio `blob-hash/1`) e a appendar
  as fatias em lotes de `STAGE_BATCH_BLOCKS` (64 × 64 KiB = 4 MiB de pico). Enquanto havia
  cota, juntar tudo antes de escrever já era caro; sem cota seria uma parada por falta de
  memória em qualquer arquivo que caiba no disco e não na RAM.
- **Cache local:** `BLOB_CACHE_MAX_BYTES` (20 GiB, configuração operacional), LRU por
  `verified_at`, **exceto** blocos protegidos pela regra 2 de §13.7.
- Blobs de comunidade que a identidade deixou: removidos ao expirar `retain_until`
  (§18.4).

---

## 14. Replicação, autorização e isolamento

Resposta direta ao blocker B7 na parte de isolamento, e ao B10 na parte de revogação.

### 14.1 O que replica

| Recurso | Tópico DHT | Quem entra |
|---|---|---|
| Log da comunidade | `discoveryKey(coreKey)` | Membros ativos não banidos |
| Core de blobs de um membro | `discoveryKey(memberBlobsKey)` | Quem tem, ou quer, algum anexo daquele membro |
| Tópico de convite | `BLAKE2b('invite-topic/1' ‖ invitePk)` | Host (server) e candidatos (client) |
| Conversa direta (§31) | **Sem tópico** — quem tem identidade anuncia-se sob o próprio par e conecta-se ao par da conversa pela chave dele (**L-24**, §31.8, emenda de 2026-09-03) | Só os dois participantes, e só sob `autorizaDm` |

**Emenda de 2026-08-22 — realização da linha "core de blobs".** O tópico é
`BLAKE2b('blob-discovery/1' ‖ blobsCoreKey)` (prefixo de domínio, mesmo racional do tópico
de convite: não competir com discoveryKeys reais). Quem **tem** o core — o autor, que o
abriu do `member_blobs_core.secret_seed_enc` — anuncia desde que a comunidade abre; quem
quer algum anexo procura ao pedir `blob.download`. A replicação em si é do hypercore, no
mesmo mux das comunidades (§16.1), uma vez por `(mux, core)`.

`swarm.join(coreKey)` e o join dos cores de blobs relevantes são feitos explicitamente:
**estar conectado a um par não é estar replicando um core** — precisa ser código, não
suposição.

### 14.2 ADR-16 continua: toda comunidade participada replica em background

É requisito de produto (traço de não-lida no rail de comunidades fechadas). O que v1 não
tinha, e v2 tem, é o **escalonador**:

| Regra | Valor |
|---|---|
| Orçamento total de conexões | `SWARM_MAX_CONNECTIONS` (default 128) |
| Reserva para a comunidade ativa | 40 % do orçamento, mínimo 8 |
| Reserva para modo host | 40 % do orçamento em cada comunidade hospedada, com o teto `HOST_MAX_PEERS` |
| Restante | Round-robin entre as comunidades de background |
| **Garantia anti-starvation** | Toda comunidade de background recebe ao menos uma janela de replicação a cada `BG_ROTATION_MS` (default 60 s), mesmo que o orçamento esteja saturado |
| Prioridade de event loop | 1) RPC de entrada · 2) `fold`+projeção · 3) outbox · 4) replicação de background · 5) blobs · 6) jobs · 7) GC |
| Cessão de event loop | O `fold` cede a cada `PROJECTOR_BATCH` registros; o GC e a reprojeção longa cedem sempre |

Fecha `F-14` (o teto de 128 não é "conexões por membro da comunidade": um membro comum
mantém poucas conexões; quem precisa de muitas é o host, e o teto dele é separado) e
`DS-10`. **`BENCHMARK REQUIRED` — G9.**

### 14.3 Autorização de replicação (fecha `DR-30`, parte de `T-25` e do B10)

Em v1 o `firewall` existia **só no host**, então dois membros continuavam replicando entre
si e o banido continuava lendo.

v2:

1. Ao abrir um canal `protomux` de replicação para o core de uma comunidade, **cada nó**
   consulta o próprio `DecisionState` daquela comunidade:
   - o par é membro ativo não banido? → abre;
   - senão → **recusa o canal** com `E_NOT_AUTHORIZED_FOR_COMMUNITY` e não replica nada.
2. Como o `fold` é determinístico, todos os nós convergem para a mesma decisão assim que
   projetam o ban. Não há autoridade central para isso, e não precisa haver.
3. O nó **fecha canais já abertos** para um par que acabou de ser banido, no mesmo lote de
   projeção que aplicou o ban.
4. O **firewall de conexão** (`hyperswarm.firewall`) continua existindo, mas com escopo
   corrigido: ele só recusa a conexão TCP/UDX quando o par está banido em **todas** as
   comunidades que este nó tem em comum com ele. Um par banido em A e membro de B **abre
   conexão** e replica só B. Isso fecha `T-25` — o firewall por processo de v1 atravessava
   comunidades e vazava estado de moderação.
5. O canal **pré-membro** (§12.3) é exceto de (4): ele aceita qualquer par, com o orçamento
   e os tetos de §12.6, para que o preview `banned` seja alcançável.

**Emenda de 2026-09-05 — a recusa de (1) precisa CHEGAR, e a porta fechada de (4) a
escondia.** (1) diz "recusa o canal **com** `E_NOT_AUTHORIZED_FOR_COMMUNITY`", e §14.5 e
§18.4 dependem desse código chegar: é ele que tira quem foi removido de `reconnecting`, grava
`removed_reason`, abre a tela de histórico de U-16 e libera `community.forget`. A
implementação apenas **ignorava** o par recusado — o código existia no catálogo de §20.2 e
ninguém nunca o enviou —, e (4) fechava a porta antes de qualquer canal, o que tornava o
segundo gatilho de §18.4 inalcançável para quem foi removido enquanto estava offline. Duas
consequências ficam escritas:

1. **A recusa é dita, não silenciosa.** O host que nega (1) a um par que o `DecisionState`
   **conhece** (ex-membro banido, expulso ou que saiu) abre o canal de §16.1 mesmo assim,
   servindo **apenas** a recusa: todo método de §16.2 responde
   `E_NOT_AUTHORIZED_FOR_COMMUNITY` e nada replica. Um par de quem o log nunca ouviu falar
   continua sem canal — ele nem sabe quem é o host, e não há desfecho a lhe dar.
2. **(4) cede sob orçamento, como (5) já cedia.** O firewall de conexão não recusa o par que
   este nó ainda precisa informar: ele entra sob o mesmo `PREMEMBER_CONN_BUDGET` de §12.6
   que (5) usa para tornar o preview `banned` alcançável, e a porta volta a fechar quando o
   teto está ocupado. É a mesma decisão de (5), pelo mesmo motivo, e não custa dado nenhum:
   quem nega é (1), canal a canal.

Do lado do membro, a recusa recebida no `hello` é o que produz `unauthorized` em §14.5. "De
todos os pares" resolve-se no host: é o único par a quem um membro abre canal de §16.1 (§16.1
"quem abre o canal é o membro; o host responde"), e dois membros não têm o que se recusar.

**Emenda de 2026-08-22 — quem é "o par", e o que faz uma réplica em branco.** A
implementação do transporte real encostou em duas coisas que o texto acima pressupunha sem
dizer.
1. **O par de (1) é o `remotePublicKey` do Noise, e ele é a chave de identidade.** §5.2 é a
   tabela fechada de derivações e **não tem prefixo para uma chave de rede separada**; §5.1
   declara "Noise (`hyperdht`), `remotePublicKey` verificada"; §12.6 já trata
   `remotePublicKey` como "chave pública do par" para rate limit. A conclusão é a única
   coerente com as três: o keypair do `Hyperswarm` **é** o par de identidade de §5.5. Se
   fosse outro, `remotePublicKey` não diria nada sobre membro nenhum e (1) exigiria um
   handshake de identidade em banda que esta especificação não declara.
   **LIMITAÇÃO DECLARADA (L-24):** a chave pública de identidade é, portanto, o nó na DHT.
   Quem conhece o `discoveryKey` de uma comunidade — todo membro, e quem receber um convite —
   consegue observar quando aquela identidade está online. Isso não expõe conteúdo nem
   participação em outras comunidades, mas é metadado, e a UX precisa dizê-lo.

2. **Uma réplica que ainda não interpretou nada autoriza qualquer par.** A regra (1) é sobre
   **o que eu sirvo**: ela impede que um banido leia de mim. Um nó cujo `DecisionState`
   daquela comunidade ainda não existe não tem bloco nenhum para servir — e, se recusasse
   por não reconhecer o par, nunca conseguiria a **primeira** replicação, porque só se
   descobre quem é membro lendo o log. A propriedade fica inteira por simetria: quem tem o
   dado é quem autoriza, e aplica (1) sobre o próprio `DS`. O mesmo vale para o canal de
   §16.1: o membro só o abre depois de saber, pelo log, quem é o host.

**Consequência para o alvo do ban (fecha `DS-08`):** o banido replica o registro do próprio
ban antes de perder acesso — porque quem o baniu só fecha o canal **depois** de appendar, e
a op é replicada. Se ele estiver offline no momento, ele descobre na reconexão seguinte,
quando algum par ainda não projetou o ban, ou pelo próprio host no canal pré-membro. Se
nem isso acontecer, o cliente cai em `E_NOT_AUTHORIZED_FOR_COMMUNITY` na replicação, que é
um estado nomeado e desenhado (§18.4).

**Emenda de 2026-08-22 — a realização de (5) na porta de conexão.** O firewall de (4) age
**antes da conexão existir**, e o lado que anuncia não sabe por qual tópico o par chegou
(`peerInfo.topics` só vem preenchido do lado que procurou). Recusar a conexão na porta era,
portanto, tornar (5) inalcançável para exatamente o caso que (5) existe para cobrir: o
ex-membro banido voltando por um convite. A implementação resolve assim: enquanto este nó
hospeda **algum** convite ativo, o firewall de conexão **cede** para qualquer par; a
autorização de (1) não muda — ela continua valendo **canal a canal**, e é quem impede um
banido de receber bloco. O custo é abrir a conexão (e o handshake Noise) a mais; os tetos
de §12.6 protegem a superfície pré-membro, e nenhum dado cruza sem passar por (1).

### 14.4 Controle de admissão do transporte

Aplicado **antes** de qualquer trabalho criptográfico ou de decode (fecha `T-08`, `T-34`,
`DS-09`):

| Controle | Membro | Pré-membro |
|---|---|---|
| Teto de frame antes do decode | `RPC_MAX_FRAME_BYTES` = 64 KiB | `PREMEMBER_MAX_FRAME_BYTES` = 4 KiB |
| Requests em voo por par | 8 | 2 |
| Token bucket por `remotePublicKey` | 40 req / 10 s | 10 req / 60 s |
| Token bucket por prefixo de rede /24 | — | 30 req / 60 s |
| Orçamento de conexões | `HOST_MAX_PEERS` | `PREMEMBER_CONN_BUDGET` = 8 |
| Custo do handshake Noise | Pago pelo `hyperdht` antes de qualquer coisa nossa | idem |

Ordem por request: **(1)** teto de bytes → **(2)** bucket → **(3)** decode → **(4)**
verificação de assinatura → **(5)** `fold`. Nunca o contrário.

### 14.5 Estados de replicação observáveis (fecha `DS-11`, `DS-17`, `RT-11`)

Um buraco de replicação em v1 congelava a projeção sem estado, sem timeout e sem evento.
v2 torna isso um estado de primeira classe:

| Estado | Condição | Evento |
|---|---|---|
| `synced` | `interpretedSeq === core.length − 1` e o par host respondeu no último `HELLO_INTERVAL_MS`. **Em comunidade hospedada, só a primeira metade**: o par host é este nó | — |
| `catching-up` | `core.length − interpretedSeq > 0` e avançando; **ou** réplica em dia cujo primeiro `hello` ainda não voltou | `community.replication{state, lag, etaMs}` |
| `stalled` | `lag > 0` e sem avanço por `REPLICATION_STALL_MS` (default 20 s); **ou** `lag == 0` em nó membro cujo host **já respondeu antes** e parou de responder | idem, com `reason` — ver 14.5.1 |
| `blocked` | O core anuncia comprimento maior do que o disponível em qualquer par | idem, com `reason:'gap'` |
| `unauthorized` | Todos os pares recusaram o canal (§14.3) | `community.accessRevoked` |
| `forked` | Bloco conflitante detectado (§5.5, L-4) | `community.forked` |

#### 14.5.1 Os motivos de `stalled` — emenda de 2026-09-05

A tabela tinha um motivo só (`no-provider`) e três situações, então ele mentia em duas
delas. E não tinha linha nenhuma para duas configurações que acontecem todo dia: a
comunidade que a pessoa **hospeda** (o loop de `hello` de §22.1 não envia frame para si
mesmo, então `synced` era inalcançável e o host vivia em `catching-up`) e a réplica **em
dia** cujo host caiu (`lag == 0` não é `catching-up`, e não havia lag para exibir).

| `reason` | Quando |
|---|---|
| `no-provider` | `lag > 0`, sem avanço por `REPLICATION_STALL_MS` **e** sem resposta de `hello` na janela — ninguém está entregando |
| `no-progress` | `lag > 0`, sem avanço por `REPLICATION_STALL_MS`, **mas o host responde `hello`** — há provedor, e os blocos não chegam |
| `host-offline` | `lag == 0` em nó membro cujo `hello` venceu a janela depois de já ter sido respondido ao menos uma vez |

**Contato que nunca aconteceu não é desfecho.** Uma comunidade recém-aberta ainda não trocou
o primeiro `hello` de §16.3; anunciar `host-offline` ali seria piscar um estado que ninguém
observou. Enquanto não houver a primeira resposta, o estado é `catching-up`.

O estado `stalled` continua definido por **ausência de avanço**, não por ausência de par: um
`hello` respondido com zero bloco chegando é exatamente o que ele existe para nomear, e
zerar o relógio de progresso a cada `hello` apagaria travamentos reais.

**Watchdog obrigatório:** um loop de `REPLICATION_WATCH_MS` compara `core.length` com
`interpretedSeq` em toda comunidade aberta e publica a transição. Fecha `DS-17` (não havia
barreira entre catch-up e modo reativo, nem watchdog).

**`partial` na busca (fecha `RT-11`):** `query.search` devolve `partial: true` quando o
estado de replicação **não** é `synced`, **ou** o host está offline, **ou** a comunidade
está em `partialInterpretation`. Não é mais só "host offline".

**Emenda de 2026-09-05 — quem decide a causa.** O módulo de busca (§23) só **ecoa**
`partialReason`; decidi-la é da composição, que é quem tem os três sinais. A precedência
entre elas é declarada, e nesta ordem: `partial-interpretation` (o que a réplica não
conseguiu interpretar fala sobre o resultado devolvido) → `catching-up`/`stalled` (o que ela
não conseguiu baixar) → `host-offline` (o contato). Em comunidade hospedada a terceira não se
aplica, pelo mesmo motivo de 14.5.1.

---

## 15. Contratos IPC

Resposta direta aos blockers B6 (contrato executável) e B9 (rastreabilidade de leitura).

### 15.1 IPC-R — transporte e envelope

**Transporte:** `MessagePort` direto renderer↔núcleo. **Todo** quadro carrega `epoch`.

| Quadro | Campos | Direção |
|---|---|---|
| `hello` | `t:"hello"`, `epoch:uint32`, `coreVersion`, `opVersion`, `schemaVersion` | núcleo → renderer, primeiro quadro de todo canal |
| `req` | `t:"req"`, `epoch`, `id:uint32`, `cmd:string`, `arg:object`, `authToken?:string` | renderer → núcleo |
| `res` | `t:"res"`, `epoch`, `id`, `ok:true`, `data` \| `ok:false`, `err:{code,message,details?,field?,retryAfterMs?}` | núcleo → renderer |
| `sub` | `t:"sub"`, `epoch`, `id`, `topic:string`, `filter?:object` | renderer → núcleo |
| `subOk` | `t:"subOk"`, `epoch`, `id`, `subId:uint32` | núcleo → renderer |
| `unsub` | `t:"unsub"`, `epoch`, `subId` | renderer → núcleo |
| `ev` | `t:"ev"`, `epoch`, `subId`, `evSeq:uint32`, `topic`, `data` | núcleo → renderer |
| `evAck` | `t:"evAck"`, `epoch`, `subId`, `evSeq` | renderer → núcleo |
| `evStale` | `t:"evStale"`, `epoch`, `subId`, `fromSeq`, `toSeq`, `dropped:uint32` | núcleo → renderer |
| `chunk` | `t:"chunk"`, `epoch`, `sessionId`, `seq`, `meta`, `payload:ArrayBuffer` (transferível) | ambos — só usado pela árvore adiada (§17.8) |

**Regras normativas (fecham `DR-05`, `DR-06`, `DR-07`, `T-20`):**

1. **`epoch`** é atribuído pelo núcleo no `hello` e incrementa a cada processo núcleo novo.
   Um quadro com `epoch` diferente do corrente é **descartado sem resposta** dos dois
   lados. É isso que impede um `res` do núcleo antigo ser aplicado depois de um crash.
2. **`subId`** é atribuído pelo núcleo, não pelo renderer. Duas assinaturas do mesmo
   `topic` com filtros diferentes recebem `subId` distintos e são independentes.
3. **`evSeq`** é monotônico **por `subId`**. Isso dá correlação e detecção de perda.
4. **Controle de fluxo no nível da aplicação:** o núcleo para de emitir para um `subId`
   quando há mais de `IPC_SUB_WINDOW` (default 256) eventos não confirmados por `evAck`.
   Passado `IPC_STALE_MS` (default 3 s) nesse estado, ele emite `evStale` com a contagem
   descartada e marca a assinatura **stale**. `MessagePort` não informa profundidade de
   fila, então esse contador é a **única** fonte de backpressure — v1 dependia de uma
   informação que a API não fornece.
5. **Assinatura stale:** o renderer é obrigado a (a) refazer a query correspondente e (b)
   mandar `evAck` com o último `evSeq` recebido. O núcleo retoma a emissão. **Evento
   perdido nunca vira estado errado**, porque evento é sinal para reconsultar, nunca fonte
   de verdade.
   **Emenda de 2026-09-05 — o descarte consome `evSeq`, e o ack de um `evStale` cobre
   `toSeq`.** O evento descartado avança o `evSeq` do `subId` sem ser postado: é esse buraco
   na numeração que dá corpo à detecção de perda de (3) e faz `fromSeq`/`toSeq` nomearem a
   faixa que de fato se perdeu. Como consequência, o `evAck` que responde a um `evStale`
   carrega o `toSeq` **daquele quadro**, e não o último `evSeq` efetivamente entregue —
   confirmar só o entregue deixaria a janela cheia para sempre e a assinatura morta pelo
   resto do `epoch`. Cobrir a faixa anunciada é o que a re-query de (a) já tornou
   verdadeiro. Fora da saturação, (b) continua sendo literalmente o último recebido.
   O `evAck` **avança** a marca de confirmação (`lastAcked`), nunca zera um contador: um ack
   atrasado de evento antigo não pode reabrir a janela inteira.
6. **Timeouts:** default 10 000 ms. Comandos síncronos que dependem do host: 30 000 ms
   (marcados ⏱). Estouro → `E_TIMEOUT` no renderer, e o núcleo **continua** processando.
   Como toda escrita é idempotente por `(author, communityId, sequenceScope, authorSeq)`, repetir é seguro.
7. **`E_TIMEOUT` não é motivo para o renderer reemitir a mesma ação com dado novo.** Fecha
   `DS-16`: a UI oferece "Tentar novamente", e "tentar novamente" reenvia o **mesmo `opId`**
   pela outbox, nunca constrói uma op nova.
8. Comando desconhecido → `E_UNKNOWN_COMMAND`. Argumento com forma errada → `E_MALFORMED`
   **antes** de chegar em L2.

### 15.2 Recuperação de crash do núcleo (procedimento normativo)

```
1. main detecta exit do utilityProcess
2. main cria MessageChannelMain novo, sobe o núcleo, cruza as portas
3. núcleo emite hello{epoch: N+1}
4. renderer, ao ver epoch novo:
     a. falha TODAS as requests em voo com E_CORE_RESTARTED (NUNCA as reenvia
        automaticamente)
     b. descarta todos os subId antigos
     c. refaz todas as assinaturas (o cliente IPC mantém a lista declarativa)
     d. refaz todas as queries ativas; com chamada de voz ativa, reexecuta o
        `voice.join` idempotente (nova sessão, emenda B43 de 2026-09-03)
     e. mostra o estado conn-reconnecting durante (c) e (d)
5. escrita em voo perdida: nada a fazer — ela está na outbox (manifest.db, FULL) e será
   reconciliada por §11.6. Nenhuma escrita é reenviada pelo renderer.
```

**Convergência garantida:** depois de (d), o estado da UI é derivado só de queries, e as
queries leem `view.db`, que é derivado do log. Três crashes seguidos convergem para o mesmo
estado. `REQUIRES POC` — G6.

**Emenda de 2026-09-05 — a recarga do renderer entra por este mesmo ciclo, e por quê.**

O procedimento acima está escrito de um único gatilho: o núcleo morre, o canal renasce, o
renderer ressincroniza. Existe um segundo gatilho, e ele é o inverso — **o documento do
renderer é substituído** (recarga por `F5`/menu, renderer que crashou e voltou, navegação).
Fica declarado que ele usa o mesmo caminho, e o que isso custa:

- **Por que não há caminho mais barato.** Uma `MessagePort` transferida pertence ao
  documento que a recebeu; quando ele é substituído, ela vai junto e não há como
  transferi-la de novo. A porta do lado do núcleo também já foi transferida (e neuterada no
  main), então o **canal inteiro** precisa nascer outra vez. Rebindar só a ponta do renderer
  exigiria dar ao `IpcServer` uma troca de porta em quente e um `hello` fora do nascimento
  do processo — mecanismo novo no contrato de §15.1 para um caso que o ciclo existente já
  cobre.
- **Como é feito.** O main pede ao núcleo um encerramento **limpo** (`core.shutdown`, com o
  `draining` de §3.3 e a barreira de §18.7 inteiros), e a saída com código 0 **não** consome
  a cota de 3 reinícios em 60 s. O que volta é `epoch+1`, canal novo, e a porta entregue ao
  documento que acabou de carregar — os passos 2 a 4 acima, sem exceção.
- **O que custa.** Uma recarga derruba as conexões P2P e reabre os cores; com ops ainda não
  replicadas, ela paga a barreira de §18.7 (até `DRAIN_BUDGET_MS`) antes de o núcleo sair.
  É o preço correto: a alternativa seria sair sem drenar. Recarregar o renderer **não** é
  operação barata neste produto, e a UI não deve oferecê-la como se fosse.

**Emenda de 2026-09-03 (B43) — a reentrada de voz é parte do (d).** A sessão de voz do
núcleo é efêmera (§6.16): no respawn ela morre sem evento nenhum, e sem re-join o
renderer ficava mostrando a chamada de pé, surdo e mudo. Com chamada ativa
(`channelId`/`communityId`/`localId` presentes no renderer), o resync de epoch
reexecuta o `voice.join` idempotente — nova sessão, mesmo caminho do "Tentar
novamente". Vale só para o `epoch`: `stale` (§15.1 r.5) é janela de eventos estourada
e `recarregar` é boot ou comunidade nova — refazer a chamada ali derrubaria quem está
nela sem motivo. A falha do re-join não é silenciada: vira `failed` com o motivo, e o
botão de sempre continua valendo. Câmera, tela e música nascem limpos como no retry
manual — a voz é o que volta sozinha. A conversa direta (§31.15, `dm.callJoin`) não
entra aqui: escopo de comunidade, par ainda em chamada do outro lado.

### 15.3 Classes de autorização de comando (fecha `T-20`, `T-19`)

| Classe | Quem pode | Comandos |
|---|---|---|
| `open` | Renderer, sempre | Todas as queries, `core.status` |
| `standard` | Renderer, com identidade criada | Escritas de domínio, mídia, preferências, blobs |
| `main-confirmed` | Renderer **com `authToken`** emitido pelo main após confirmação nativa | `identity.wipe`, `identity.export`, `identity.import`, `community.end`, `core.reproject`, `blob.reveal` de `archive`, `community.assumeHost`, `dm.forget` (§31.16.1) |

- O `authToken` é um valor de 32 bytes, de uso único, com TTL de 60 s, emitido pelo main via
  IPC-M depois de um diálogo nativo (`dialog.showMessageBox` com botão destrutivo). O núcleo
  o consome e invalida. O renderer **não pode fabricá-lo**.

**Emenda de 2026-09-05 — o que o diálogo diz e ao que o token se liga.** A redação acima
descrevia o mecanismo e nada mais, e uma implementação literalmente conforme a ela — caixa
genérica ("Confirmar ação destrutiva?"), `cmd` aceito sem conferência, token válido para
qualquer argumento — deixa a classe sem efeito nenhum contra o adversário que ela nomeia (o
renderer comprometido). As três regras que faltavam:

1. **O diálogo NOMEIA a ação.** O texto da caixa é escolhido pelo main a partir de uma
   tabela fechada, indexada pelo comando; não vem do renderer. Uma caixa que não distingue
   apagar a instalação de reprojetar uma comunidade não é confirmação, é um clique.
2. **O main só emite para comando da tabela desta seção.** `cmd` fora dela →
   `E_UNKNOWN_COMMAND`, sem diálogo. Emitir para nome arbitrário faz do `AuthTokenStore` um
   oráculo de assinatura para qualquer comando futuro que entre na classe.
3. **O token liga-se a `(cmd, escopo)`**, onde `escopo` é o identificador do alvo declarado
   na tabela abaixo — `null` para o comando que não tem alvo. Quem **deriva** o escopo é
   cada lado a partir do argumento, pela mesma função: o renderer para pedir o token, o
   núcleo para consumi-lo. Um token de `community.end` da comunidade A não encerra a B. O
   escopo nunca carrega segredo: `identity.export` liga-se ao comando e a nada mais, porque
   a `passphrase` é o segredo do backup e não o endereço da ação — e é também por isso que o
   main extrai **só o campo declarado**, nunca o argumento inteiro.
   O alvo nem sempre é texto (o `blobId` de §13.2 é um registro de deslocamentos), então a
   comparação é sobre uma forma **canônica** com chaves ordenadas, e a canonicalização tem
   **uma** implementação, no núcleo: duas poderiam divergir, e um escopo que sai `null` dos
   dois lados por engano é uma ligação vazia que passa despercebida justamente por ser
   consistente.

| Comando | Escopo (campo do argumento) | O que a caixa nativa diz |
|---|---|---|
| `identity.wipe` | — | "Apagar esta instalação?" / "Identidade, comunidades e mensagens locais são removidas. Não há desfazer." |
| `identity.export` | — | "Exportar a identidade?" / "Grava um backup cifrado pela frase secreta que você digitou." |
| `identity.import` | — | "Restaurar identidade de um backup?" / "Substitui o estado local desta instalação pelo backup escolhido." |
| `community.end` | `communityId` | "Encerrar a comunidade?" / "Quem está conectado cai, e a comunidade deixa de existir para todos." |
| `community.forget` | `communityId` | "Esquecer esta comunidade?" / "A réplica local é apagada desta máquina." |
| `community.assumeHost` | `communityId` | "Assumir a hospedagem?" / "Cria a continuação da comunidade sob esta máquina (§18.8)." |
| `core.reproject` | `communityId` (ausente = todas) | "Reprojetar o estado?" / "O núcleo congela enquanto reabre o estado a partir do log." |
| `blob.reveal` | `blobId` (registro de §13.2, comparado na forma canônica) | "Abrir este arquivo compactado?" / "O arquivo será aberto pelo aplicativo do sistema." |
| `dm.forget` | `conversationId` | "Esquecer esta conversa?" / "As mensagens locais desta conversa são apagadas desta máquina." |
- **A classe `dev` foi removida (decisão do operador, 2026-08-28).** Ela existia para o
  roteador `dev.*` de injeção de falha, que o v1 não terá: o produto não expõe superfície
  que derrube, atrase ou degrade o próprio núcleo, nem em build separado. Um roteador
  condicionado por constante de build é uma classe de autorização inteira — com o seu gate,
  a sua eliminação de código morto e o seu modo de falhar aberto — mantida viva para
  ferramenta de desenvolvimento; e a injeção de falha que §28.3 exige se faz **no harness
  de teste**, que já roda contra o núcleo real e não precisa de porta no produto. Uma
  chamada `dev.*` é hoje `E_UNKNOWN_COMMAND` como qualquer nome inexistente.

### 15.4 IPC-R — comandos de escrita

Coluna **Cl.** = classe de autorização · **A** = assíncrono por contrato (outbox, §11.1) ·
**⏱** = síncrono com o host, timeout de 30 s.

#### Identidade e app

| Comando | Argumento | Cl. | Resposta | Erros |
|---|---|---|---|---|
| `identity.create` | `{displayName, avatarColor}` | open | `{publicKey, handle, createdAt}` | `E_IDENTITY_EXISTS`, `E_VALIDATION`, `E_KEYSTORE_UNAVAILABLE`, `E_KEYSTORE_INSECURE` |
| `identity.update` | `{displayName?, avatarColor?}` | standard | `{queued:[{communityId, opId}]}` — **A**, uma op por comunidade | `E_VALIDATION` |
| `identity.setPresence` | `{presence}` | standard | `{}` | `E_VALIDATION` |
| `identity.export` | `{passphrase}` | main-confirmed | `{savedTo}` — o main grava o arquivo | `E_VALIDATION.passphrase`, `E_CANCELLED` |
| `identity.import` | `{passphrase}` | main-confirmed | `{publicKey, handle, communities:int}` | `E_IDENTITY_EXISTS`, `E_BAD_PASSPHRASE`, `E_MALFORMED` |
| `identity.wipe` | `{}` | main-confirmed | `{}` (o núcleo reinicia) | `E_WIPE_INCOMPLETE` |
| `identity.acceptInsecureKeystore` | `{}` | open | `{}` | `E_VALIDATION` |
| `core.status` | `{}` | open | §15.6 `CoreStatus` | — |
| `core.reproject` | `{communityId?}` | main-confirmed | `{}` | `E_BUSY` |
| `core.shutdown` | `{}` | standard | `{drainedMs, pendingOps, replicatedTo}` | — |

**Emenda de 2026-08-23 — três alinhamentos desta tabela com o resto da spec:**

1. **`identity.export` responde `{}`, não `{savedTo}`.** A regra 5 de §13.3 proíbe o
   caminho de arquivo do usuário de cruzar o IPC-R em qualquer direção; devolvê-lo na
   resposta violaria T-16. O desfecho bem-sucedido da chamada É a confirmação para a UI,
   e o blob do backup nunca passa pelo renderer (§5.5).
2. **`channel.subscribeTyping {communityId, channelId, on}` — standard — entra na tabela.**
   §17.6 define que `typing` vai só a quem chamou `subscribeChannel{channelId, on:true}`,
   mas a capacidade era RPC de §16.2 sem gatilho IPC-R nenhum: a UI abre canal pelo
   renderer e a tabela estava fechada. O comando é LOCAL e espelha a assinatura: no host,
   registra no agregador de presença; no membro, encaminha por §16.2 quando o canal está
   vivo (efêmero não enfileira — §11.8) e quem reabrir o canal re-assina na reconexão.
3. **`identity.wipe` falha com `E_WIPE_INCOMPLETE{stage}`** — o `stage` viaja no campo
   `details` do erro de §15.2 (`details.stage`), forma já prevista no quadro de resposta.

**Emenda de 2026-08-23 — `identity.acceptInsecureKeystore {}` — open — entra na tabela.**
A limitação declarada L-2 de §3.2 já exigia que o núcleo recusasse abrir
(`E_KEYSTORE_INSECURE`) "salvo se o usuário aceitar o modo inseguro **numa tela dedicada**",
e que a UI passasse a exibir um indicador permanente. O aceite existia na composição
(`acceptInsecure`, persistido em `<dataDir>/keystore-accepted`) e o gate existia em
`identity.create` — mas **não havia gatilho IPC-R nenhum**, então a tela que L-2 exige era
inalcançável e o produto parava na primeira tela em toda máquina sem secret store. É a mesma
forma de lacuna que `channel.subscribeTyping` tinha (emenda 2 acima): capacidade sem porta.

A classe é `open` pela mesma razão de `identity.create`: o comando é a **pré-condição** dela,
e em `awaiting-identity` não há identidade contra a qual autorizar. Não entra em
`main-confirmed` — aquela classe existe para impedir que um renderer comprometido **destrua
dado** sem confirmação nativa, e o aceite não destrói nada: muda como a chave passará a ser
guardada, e só tem efeito quando uma identidade for criada em seguida.

É **idempotente**, para a tela poder chamá-lo sem precisar saber se já houve aceite. Com o
cofre `secure` recusa com `E_VALIDATION`: gravar o registro mesmo assim deixaria no disco a
afirmação de aceite de um modo que nunca esteve em uso, e se o ambiente degradasse depois o
gate de `create` já estaria vencido sem ninguém ter visto a tela. Aceitar **não** torna o
cofre seguro — `CoreStatus.keystore` continua `insecure-fallback`, que é o que mantém o
indicador permanente aceso.

#### Comunidade

| Comando | Argumento | Cl. | Resposta | Erros |
|---|---|---|---|---|
| `community.create` | `{name, iconEmoji?, iconColor, description?}` | standard | `{communityId, defaultChannelId}` — **`defaultChannelId` é o primeiro canal criado** (ordem de inserção do `DS` = ordem de aplicação do log; na gênese, #geral) | `E_VALIDATION`, `E_STORAGE_FULL`, `E_LIMIT_EXCEEDED` |
| `community.activate` | `{communityId \| null}` | standard | `{residency}` — troca o `residency` do `DS` (§8.1) | `E_NOT_FOUND` |
| `community.update` ⏱ | `{communityId, name?, iconEmoji?, iconColor?, description?}` | standard | `{seq}` | `E_PERMISSION_DENIED`, `E_HOST_UNAVAILABLE`, `E_VALIDATION` |
| `community.end` ⏱ | `{communityId, reason?}` | main-confirmed | `{seq, replicatedTo}` | `E_NOT_HOST`, `E_COMMUNITY_ENDED` |
| `community.leave` | `{communityId}` | standard | `{leftLocally:true, opId, droppedQueued}` — efeito local imediato; o `kind` `member.leave` é enfileirado (exceção de §11.1, L-22) | `E_HOST_CANNOT_LEAVE` |
| `community.setSuccessors` ⏱ | `{communityId, successorKeys[]}` | standard | `{seq}` — o núcleo appenda, **na mesma operação**, um `community.escrow` por sucessor (§18.8); sem eles a lista existe e ninguém assume | `E_NOT_HOST`, `E_VALIDATION` |
| `community.assumeHost` ⏱ | `{communityId}` | main-confirmed | `{newCommunityId, seq}` | `E_SUCCESSION_DENIED` |
| `community.forget` | `{communityId}` | main-confirmed | `{}` — apaga a réplica local de uma comunidade `left`/`removed` antes do `retain_until` | `E_NOT_FOUND`, `E_VALIDATION` — **emenda de 2026-08-23:** comunidade ainda participada (`left_at` e `removed_reason` nulos) não é esquecível; recusar com o erro genérico de estado evita inventar código novo para uma pré-condição da própria linha |

#### Canais e categorias — todas ⏱, `manage_channels`

**Emenda de 2026-08-22 — o que a resposta promete e quando.** `channelId`/`categoryId` são
derivados na hora pelo §7.3 (do `authorSeq` que a submissão consumiu) e estão **sempre**
presentes. Já `rank` e as contagens de `category.delete` são o que o **`fold`** decidiu:
a resposta só os traz depois que a projeção local alcançou o `seq` confirmado pelo host, e
fica **sem** eles se o prazo local vencer antes (réplica atrasada) — a UI os obtém no
`query.structure` seguinte. Recalculá-los na fronteira seria escrever R-20 e R-7 uma
segunda vez, fora do `fold`. `category.delete` tem exatamente **duas** formas: mover os
canais (`moveChannelsTo`) **ou** apagá-los (`deleteChannels: true`); pedir as duas na mesma
chamada é `E_VALIDATION`, não uma terceira forma.

| Comando | Argumento | Resposta | Erros |
|---|---|---|---|
| `channel.create` | `{communityId, categoryId, type, name, topic?, readOnlyForRoleIds?, speechMode?, queueTurnSeconds?, afterChannelId?}` | `{channelId, seq, rank}` | `E_CHANNEL_NAME_TAKEN`, `E_CHANNEL_NAME_EMPTY`, `E_LIMIT_EXCEEDED`, `E_VALIDATION.speechMode`, `E_VALIDATION.queueTurnSeconds`, `E_HOST_UNAVAILABLE` |
| `channel.update` | `{communityId, channelId, name?, topic?, readOnlyForRoleIds?, speechMode?, queueTurnSeconds?}` | `{seq}` | idem |
| `channel.move` | `{communityId, channelId, categoryId, afterChannelId?}` | `{seq, rank}` | `E_CATEGORY_NOT_FOUND` |
| `channel.delete` | `{communityId, channelId}` | `{seq, droppedQueued}` | `E_LAST_CHANNEL` |
| `category.create` | `{communityId, name, afterCategoryId?}` | `{categoryId, seq, rank}` | `E_VALIDATION`, `E_LIMIT_EXCEEDED` |
| `category.rename` | `{communityId, categoryId, name}` | `{seq}` | — |
| `category.delete` | `{communityId, categoryId, moveChannelsTo?} \| {..., deleteChannels:true}` | `{seq, movedChannels, deletedChannels}` | `E_VALIDATION`, `E_LAST_CHANNEL` |

#### Preferências locais (sem host, sem fila)

| Comando | Argumento | Resposta |
|---|---|---|
| `channel.setMuted` | `{communityId, channelId, muted}` | `{}` |
| `channel.markRead` | `{communityId, channelId}` | `{unreadCount:0, pendingMentions:0}` — **declara os dois** (fecha `RT-03`) |
| `thread.markRead` | `{communityId, threadId}` | `{unreadCount:0}` |
| `category.setCollapsed` | `{communityId, categoryId, collapsed}` | `{}` |
| `nav.setActive` | `{communityId?, channelId?}` | `{}` — **dono único** de navegação (fecha `DR-32`) |
| `settings.setDevice` | `{kind:'microphone'\|'camera'\|'output', deviceId}` | `{}` |
| `settings.setVolume` | `{kind:'input'\|'output', value:0..100}` | `{}` |
| `settings.setParticipantVolume` | `{communityId, identityKey, volume:0..100}` | `{}` |
| `settings.setNotifications` | `{enabled?, communityId?, level?}` | `{}` |

#### Cargos e membros — todas ⏱

**Emenda de 2026-08-22 — o que a resposta promete e quando.** `roleId` é derivado na hora
pelo §7.3 (do `authorSeq` que a submissão consumiu) e está **sempre** presente. Já `rank`
(`role.create`/`role.move`) e `appliedRoleIds` (`member.setRoles`) são o que o **`fold`**
decidiu: a resposta só os traz depois que a projeção local alcançou o `seq` confirmado pelo
host, e fica **sem** eles se o prazo local vencer antes — a UI os obtém no `query.roles`
seguinte. Em `role.delete`, `affectedMembers` e `clearedChannelRefs` são o **delta lido do
estado projetado** (quem perdeu o cargo; quantas referências de canal F-31 limpou), nunca um
recálculo na fronteira — que seria escrever R-12/§8.4.1 uma segunda vez.

| Comando | Argumento | Perm. | Resposta | Erros |
|---|---|---|---|---|
| `role.create` | `{communityId, name, color, permissions[], mentionable, afterRoleId?}` | `manage_roles` | `{roleId, seq, rank}` | `E_PERMISSION_ESCALATION`, `E_HIERARCHY`, `E_LIMIT_EXCEEDED` |
| `role.update` | `{communityId, roleId, name?, color?, permissions?, mentionable?}` | `manage_roles` | `{seq}` | `E_FOUNDER_IMMUTABLE`, `E_PERMISSION_ESCALATION`, `E_BASE_ROLE_RESTRICTED` |
| `role.move` | `{communityId, roleId, afterRoleId?, beforeRoleId?}` | `manage_roles` | `{seq, rank}` — **só o cargo movido muda** (§6.4.1) | `E_FOUNDER_TOP`, `E_HIERARCHY` |
| `role.delete` | `{communityId, roleId}` | `manage_roles` | `{seq, affectedMembers, clearedChannelRefs}` | `E_BASE_ROLE_REQUIRED`, `E_FOUNDER_IMMUTABLE` |
| `member.setRoles` | `{communityId, targetKey, roleIds[]}` | `manage_roles` | `{seq, appliedRoleIds[]}` — devolve o conjunto **efetivamente aplicado** após §8.4.1 | `E_HIERARCHY`, `E_BASE_ROLE_REQUIRED` |
| `member.setNickname` | `{communityId, nickname\|null}` | — | `{seq}` | `E_NICKNAME_SELF_ONLY` |

#### Mensagens — todas **A** (assíncronas por contrato)

| Comando | Argumento | Perm. | Resposta | Erros síncronos |
|---|---|---|---|---|
| `message.send` | `{communityId, channelId, content, mentions[], attachment?, replyToId?, threadId?, clientRef}` | `send_messages` | `{opId, state:'queued'}` | `E_VALIDATION`, `E_CHANNEL_READ_ONLY`, `E_OUTBOX_FULL`, `E_QUOTA_EXCEEDED` |
| `message.edit` | `{communityId, messageId, content, clientRef}` | própria | `{opId, state}` | `E_CANNOT_EDIT_OTHERS`, `E_MESSAGE_DELETED`, `E_VALIDATION` |
| `message.delete` | `{communityId, messageId, reason?, clientRef}` | própria \| `manage_messages` | `{opId, state}` | `E_PERMISSION_DENIED`, `E_HIERARCHY` |
| `message.pin` | `{communityId, messageId, pinned, clientRef}` | `pin_messages` | `{opId, state}` | `E_PERMISSION_DENIED` |
| `message.react` | `{communityId, messageId, emoji, present, clientRef}` | `add_reactions` | `{opId, state}` | `E_REACTION_LIMIT`, `E_MESSAGE_DELETED` |
| `thread.create` | `{communityId, rootMessageId, clientRef}` | `send_messages` | `{opId, state}` | `E_THREAD_EXISTS` |
| `message.retry` | `{opId}` | — | `{state}` — **mesmo envelope** | `E_NOT_FOUND` |
| `message.cancelQueued` | `{opId}` | — | `{}` | `E_NOT_FOUND`, `E_ALREADY_SENT` |

Os erros da coluna são **síncronos** e vêm da validação advisória local (§8.7). O desfecho
real chega por `message.accepted` / `message.failed` / `message.dropped`.

#### Moderação — todas ⏱

**Emenda de 2026-08-22 — as contagens são o delta desta op.** `hiddenMessages`,
`revokedInvites` e `restoredMessages` são lidos do estado projetado como a **diferença que
ESTA operação produziu**: um re-ban idempotente (§8.4.1) decide nada e responde zero, não o
total acumulado da história do alvo. A hierarquia não é conferida duas vezes — quem recusa
com `E_HIERARCHY`/`E_FOUNDER_IMMUNE`/`E_HOST_IMMUNE`/`E_SELF_TARGET` é o `fold`.

| Comando | Argumento | Perm. | Resposta | Erros |
|---|---|---|---|---|
| `mod.kick` | `{communityId, targetKey, reason?}` | `kick_members` | `{seq}` | `E_HIERARCHY`, `E_FOUNDER_IMMUNE`, `E_HOST_IMMUNE`, `E_SELF_TARGET` |
| `mod.ban` | `{communityId, targetKey, reason?}` | `ban_members` | `{seq, hiddenMessages, revokedInvites}` | idem |
| `mod.revokeBan` | `{communityId, targetKey}` | `ban_members` | `{seq, restoredMessages}` | `E_NOT_BANNED` |
| `mod.timeout` | `{communityId, targetKey, until, reason?}` | `timeout_members` | `{seq}` | `E_VALIDATION.until` |
| `mod.removeTimeout` | `{communityId, targetKey}` | `timeout_members` | `{seq}` | — |

#### Convites — todas ⏱

| Comando | Argumento | Perm. | Resposta | Erros |
|---|---|---|---|---|
| `invite.create` | `{communityId, expiresInDays?, maxUses?, label?}` | `create_invite` | `{invitePublicKey, code, expiresAt?, maxUses?, seq}` — **`code` só aqui e só para quem cria** | `E_LIMIT_EXCEEDED`, `E_VALIDATION` |
| `invite.revoke` | `{communityId, invitePublicKey}` | autor \| `manage_community` | `{seq}` | `E_NOT_FOUND`, `E_PERMISSION_DENIED` |
| `invite.resolve` | `{codeOrLink}` | open | `InvitePreview` (§15.6) | `E_MALFORMED` |
| `invite.redeem` | `{codeOrLink, displayName?, avatarColor?}` | standard | `{communityId, defaultChannelId, seq}` | `E_INVITE_INVALID`, `E_INVITE_EXHAUSTED`, `E_BANNED`, `E_HOST_UNAVAILABLE`, `E_LIMIT_EXCEEDED` |

**Gramática de `codeOrLink` (fecha `DR-34`), normativa:**

```
entrada := codigo | link
codigo  := 16 caracteres do alfabeto Crockford Base32 (0-9 A-H J-N P-T V-Z),
           case-insensitive, aceitando '-' e espaço como separadores ignorados
link    := 'comunidadep2p://join/' codigo
         | scheme '://' host '/invite/' codigo        (qualquer host — o host do link
                                                       é ignorado e nunca contactado)
```

Normalização: remove espaços e `-`, maiúsculas, aplica o mapeamento Crockford
(`I,L → 1`, `O → 0`), exige exatamente 16 símbolos válidos. Qualquer outra coisa →
`E_MALFORMED`. **O domínio do link nunca é resolvido nem acessado** — não há requisição
HTTP em lugar nenhum.

#### Voz, tela e relay

| Comando | Argumento | Perm. | Resposta | Erros |
|---|---|---|---|---|
| `voice.join` ⏱ | `{communityId, channelId}` | `voice_speak` | `{sessionId, roster[], iceServers[], tickets[]}` (§17.4) | `E_HOST_UNAVAILABLE`, `E_CHANNEL_NOT_VOICE`, `E_PERMISSION_DENIED` |
| `voice.leave` | `{}` | — | `{}` | — |
| `voice.setSelf` | `{muted?, deafened?, cameraOn?, speaking?}` | — | `{}` | `E_SESSION_GONE` |
| `voice.muteParticipant` | `{communityId, identityKey, muted}` | `voice_mute_others` | `{}` | `E_PERMISSION_DENIED` |
| `voice.queueJoin` | `{communityId, channelId}` | participante da voz (§16.4) | `{}` | `E_SESSION_GONE`, `E_QUEUE_CLOSED` |
| `voice.queueLeave` | `{communityId, channelId}` | — | `{}` | — (idempotente) |
| `voice.queueModerate` | `{communityId, channelId, action:'promote'\|'skip'\|'remove'\|'addTime'\|'open'\|'close', targetKey?, seconds?}` | `voice_mute_others` | `{}` | `E_SESSION_GONE`, `E_PERMISSION_DENIED` |
| `music.start` | `{communityId}` | `voice_share_screen` — conferida **localmente** pelo núcleo (emenda de 2026-08-28 em §17.5) | `{captureToken, expiresAt}` | `E_PERMISSION_DENIED`, `E_DEVICE_BLOCKED` |
| `voice.signal` | `{peerKey, ticketId, sdp?, ice?}` | — | `{}` | `E_PEER_UNREACHABLE`, `E_TICKET_INVALID` |
| `share.start` ⏱ | `{communityId, channelId, quality}` | `voice_share_screen` | `{sessionId, captureToken}` (§17.5) | `E_ALREADY_SHARING`, `E_PERMISSION_DENIED` |
| `share.stop` | `{sessionId}` | apresentador | `{}` | — |
| `share.setQuality` | `{sessionId, quality}` | **apresentador** (emenda de 2026-08-26; era espectador — §17.5) | `{applied:bool}` (§17.5) | `E_SESSION_GONE`, `E_PERMISSION_DENIED` |
| `share.join` ⏱ | `{sessionId}` | participante da voz | `{ticketId, presenterKey}` | `E_SESSION_GONE`, `E_PERMISSION_DENIED` |
| `share.report` | `{sessionId, samples[{viewerKey, rttMs, lossPct}]}` | apresentador | `{}` — **emenda de 2026-08-25**, ver §17.5 | `E_SESSION_GONE`, `E_PERMISSION_DENIED` |
| `relay.enable` ⏱ | `{communityId}` | — | `{relayPublicKey, seq, expiresAt}` | `E_CONSENT_REQUIRED` |
| `relay.disable` ⏱ | `{communityId}` | — | `{seq}` | — |
| `relay.respondConsent` | `{communityId, accept, remember}` | — | `{}` | — |

#### Arquivos e diagnóstico

| Comando | Argumento | Cl. | Resposta | Erros |
|---|---|---|---|---|
| `file.pickForAttachment` | `{communityId}` | standard | `{ticketId, name, sizeBytes, kind}` — o main abre o diálogo | `E_CANCELLED`, `E_ATTACHMENT_TOO_LARGE`, `E_VALIDATION.name` |
| `blob.stage` | `{ticketId}` | standard | `{blobsCoreKey, blobId, name, sizeBytes, kind, hash}` | `E_TICKET_INVALID`, `E_FILE_UNREADABLE`, `E_STORAGE_FULL` |
| `blob.download` | `{communityId, blobsCoreKey, blobId}` | standard | `{state}` | `E_NO_PEERS` |
| `blob.cancel` | `{blobsCoreKey, blobId}` | standard | `{}` | — |
| `blob.reveal` | `{blobsCoreKey, blobId, mode:'open'\|'folder'}` | standard / main-confirmed | `{}` | `E_NOT_DOWNLOADED`, `E_TYPE_NOT_OPENABLE` |
| `diag.run` | `{}` | standard | `{natType, peerCount, relayAvailable, stunReachable, ranAt}` | — |
| `diag.snapshot` | `{}` | standard | Métricas de §24.3 | — |
| `host.exitImpact` | `{}` | standard | `[{communityId, name, onlineCount, inCallCount, pendingReplication}]` | — |

**`host.notifyBeforeExit` foi removido.** Ver §18.7 e delta U-06.

### 15.5 IPC-R — eventos

Cada evento é **sinal para reconsultar**, com o mínimo para a UI decidir se precisa.
`communityId` está sempre presente quando aplicável.

| Topic | Payload | Dispara |
|---|---|---|
| `core.ready` | `{phase, epoch}` | Núcleo pronto |
| `core.restarted` | `{epoch, attempt}` | Reinício após crash |
| `core.reprojecting` | `{communityId, done, total}` | Reprojeção longa |
| `core.clockSuspect` | `{communityId, skewMs}` | §11.4 |
| `community.joined` / `community.left` | `{communityId, reason?}` | — |
| `community.changed` | `{communityId, fields[]}` | `community.update`, `assumeHost` |
| `community.ended` | `{communityId}` | — |
| `community.replication` | `{communityId, state, lag, etaMs?, reason?}` | §14.5 |
| `community.accessRevoked` | `{communityId, cause:'banned'\|'kicked'\|'unauthorized'}` | §14.3, §18.4 |
| `community.forked` | `{communityId}` | §5.5 L-4 |
| `community.partialInterpretation` | `{communityId, unknownKinds[], unknownVersions[]}` | §7.2 regra 5 |
| `structure.changed` | `{communityId, channels[], categories[]}` | Qualquer op de estrutura |
| `roles.changed` | `{communityId, roleIds[]}` | Qualquer op de cargo |
| `members.changed` | `{communityId, identityKeys[]}` | Roster, cargos, apelido, ban, timeout |
| `messages.appended` | `{communityId, channelId, fromSeq, toSeq, hasMention}` | Lote projetado |
| `message.updated` | `{communityId, messageId, channelId, fields[]}` | Edição, pin, reação, delete |
| `message.accepted` | `{opId, clientRef, messageId, seq, channelId}` | **Emitido pela reconciliação** (§11.6), depois de `messages.appended` |
| `message.failed` | `{opId, clientRef, code, retryInMs?, terminal:bool}` | — |
| `message.dropped` | `{opId, clientRef, reason, channelId}` | §11.7 |
| `outbox.changed` | `{communityId, queued, sending, failed}` | — |
| `outbox.flushed` | `{communityId, delivered}` | Fila esvaziou |
| `invites.changed` | `{communityId, invitePublicKeys[]}` | **Novo** — fecha `F-34`/`C-4`/`C-6` |
| `auditLog.changed` | `{communityId, fromSeq, toSeq}` | **Novo** — fecha `F-34`/`P-14` |
| `host.statusChanged` | `{communityId, status, lastSeenAt, attempt?}` | Enum fechado de `hostStatus` (§15.6) — fecha `DR-29`/`DR-33` |
| `swarm.changed` | `{peerCount, degraded, byCommunity:[{communityId, peers}]}` | — |
| `nat.detected` | `{natType}` | — |
| `presence.changed` | `{communityId, entries[]}` | Delta agregado a cada `PRESENCE_TICK_MS` — **emenda de 2026-08-23:** `entries[]` carrega só as presenças que MUDARAM desde o último tick (`{identityKey, status, lastSeenAt}`); quem expirou simplesmente deixa de aparecer e o TTL corrige em ≤ 45 s (L-13), porque `offline` nunca é um valor publicado (§6.1) e a tabela é fechada — não há campo `removed[]` no fio |
| `typing.changed` | `{communityId, channelId, identityKeys[]}` | TTL 5 s |
| `unread.changed` | `{communityId, channelId?, threadId?, unreadCount, pendingMentions}` | Recalculado |
| `voice.occupancyChanged` | `{communityId, channelId, count, firstKeys[]}` | **Novo** — alimenta a sidebar (fecha `RT-05`) |
| `voice.roster` | `{communityId, channelId, participants[]}` | Só a participantes |
| `voice.meshChanged` | `{peerKey, status}` | Falha assimétrica |
| `voice.failed` | `{reason, sessionId?}` | Falha total. **Emenda de 2026-08-26:** `reason` é o motivo da revogação que encerrou a sessão inteira (§17.4) — `channel-deleted`, `community-ended` — ou `host-unavailable`, quando quem perdeu a sessão foi o **próprio nó** por silêncio do host (§17.4). O tópico entrou na tabela fechada de §16.3, sem a qual ele não descia ao membro. `sessionId` não viaja no caso `host-unavailable`: quem o emite é o núcleo local, sobre uma sessão que já deixou de existir para ele |
| `voice.revoked` | `{communityId, targetKey, sessionId}` | Moderação (§17.4) |
| `voice.signal` | `{peerKey, ticketId, sdp?, ice?}` | Sinalização recebida |
| `voice.tickets` | `{communityId, sessionId, tickets[], iceServers?}` | **Novo (2026-08-22)** — renovação de §17.4 na cadência `MEDIA_TICKET_TTL_MS/3`, empurrada pelo núcleo. **Emenda de 2026-08-30:** ganha `iceServers` **opcional** — a credencial TURN vence junto do ticket (§17.3) e não tem evento próprio, então a renovação embute o `voiceJoin` idempotente (§21.2) e traz a lista com a credencial recém-costurada. O renderer a aplica por `setConfiguration` nas conexões vivas — sem isto, chamada que dependia de relay morria no vencimento da credencial, com o `Allocate` novo a responder 401. Ausente = sem renovação a anunciar (a renovação de tickets falhou, ou a sessão não tem TURN anunciado) |
| `voice.queueChanged` | `{communityId, channelId, open, items[{keyHex, queuedAt}], turn: {keyHex, endsAt} \| null}` | **Novo (2026-08-28)** — a fila de karaokê mudou (§16.4). A cada mudança, **e como instantâneo na conexão** de quem entra na comunidade (mesma regra de `voice.occupancyChanged`: fila é NÍVEL, não sequência) |
| `voice.deviceError` | `{kind:'microphone'\|'camera', code}` | **Novo** — fecha `RT-10` |
| `share.started` / `share.stopped` | `{sessionId, presenterKey, channelId}` | — |
| `share.viewersChanged` | `{sessionId, viewerCount}` | — |
| `share.health` | `{sessionId, viewers[{key, rttMs, lossPct, quality}]}` | **Só ao apresentador** (fecha `RT-08`) |
| `share.failed` | `{sessionId, reason}` | **Agora está na tabela** (fecha `V-18`). **Emenda de 2026-08-26:** o destinatário estava omisso, e a omissão tinha custo — o espectador cuja autorização foi revogada (§17.5) não tinha por onde saber, já que `share.stopped` é da sessão inteira e `share.viewersChanged` leva só a contagem. Quando `reason` é `revoked`, vai **só ao alvo**; nos demais casos é local a quem falhou |
| `relay.consentRequested` | `{communityId, reason}` | §17.7 |
| `relay.stateChanged` | `{communityId, enabled, expiresAt, bytesRelayed}` | — |
| `blob.progress` | `{blobsCoreKey, blobId, progress, bytesDownloaded, peers, hostAvailable}` | A cada 500 ms — **emenda de 2026-08-22:** nas cinco linhas de blob o campo viaja como `blobIdHex` (o id de 16 bytes em hex, §13.2), que é a chave do cache local; `peers` é a **contagem** dos pares que anunciam ter a faixa |
| `blob.completed` | `{blobsCoreKey, blobId, path}` | Verificado |
| `blob.peerLost` | `{blobsCoreKey, blobId, remaining}` | — |
| `blob.unavailable` | `{blobsCoreKey, blobId}` | Zero pares |
| `attachment.corrupt` | `{blobsCoreKey, blobId, cause:'hash'\|'size'}` | Fecha `A-5` |
| `config.nonDefault` | `{keys[]}` | Configuração de rede fora do default (§25.5) |

### 15.6 IPC-R — queries, **com schema de resposta**

Fecha `DR-46` (nenhuma das 17 queries tinha schema) e as cinco superfícies sem fonte de
dado (`RT-02`, `RT-05`, `DR-47`, `DR-48`, `DR-38`).

Tipos compartilhados (mapeiam 1:1 para `frontend/src/domain/types.ts` — a correspondência
completa está em `deltas-ux-v2.md` §4):

```ts
type Key       = string   // hex64
type Ms        = number
type Cursor    = string   // base64url opaco, {seq, id}
type Rank      = string

type UserRef   = { key: Key, displayName: string, handle: string,
                   avatarColor: string, nickname?: string,
                   collision: boolean }                      // §6.1 L-5
// Emenda de 2026-08-22: `collision` é sempre `false` até o `fold` marcar a colisão de L-5
// (nem o DS nem `members.display_name_collision` têm produtor). Calcular a colisão na
// leitura seria pôr regra de domínio fora do `fold` — a lacuna é do `fold`, e é lá que
// fecha.

type HostStatus = 'unknown' | 'connecting' | 'online' | 'reconnecting'
                | 'offline' | 'ended' | 'unauthorized' | 'incompatible' | 'forked'

type ReplicationState = 'synced' | 'catching-up' | 'stalled' | 'blocked'
                      | 'unauthorized' | 'forked'

type CoreStatus = {
  phase: 'boot'|'awaiting-identity'|'opening'|'ready'|'draining'|'stopped'
  epoch: number, coreVersion: string, opVersion: number
  manifestSchemaVersion: number, viewSchemaVersion: number
  keystore: 'secure' | 'insecure-fallback'
  buildChannel: 'prod' | 'dev'
}
```

| Query | Argumento | Resposta |
|---|---|---|
| `query.identity` | `{}` | `{key, displayName, handle, avatarColor, presence, createdAt} \| null` |
| `query.communities` | `{}` | `[{ id, name, iconEmoji?, iconColor, memberCount, isHostedByMe, hostStatus: HostStatus, replication: {state, lag}, unread:{count, mentions}, notificationLevel, endedAt?, inactiveDays, partialInterpretation }]` na ordem de entrada |
| `query.community` | `{communityId}` | `{ ...community, myPermissions: string[], myRoleIds: string[], myTopRank: Rank, isHost, hostRef: UserRef, successorKeys: Key[], pendingReentry?: UserRef[], replication, partialInterpretation }` — `pendingReentry` só existe quando a comunidade é continuação (`originCommunityId` presente) e a origem está replicada aqui: são os membros ativos da origem que ainda não reentraram (L-23, §18.8.1), a lista da tela de sucessão (U-18c) |
| `query.structure` | `{communityId}` | `{ categories: [{ id, name, rank, collapsed, channels: [{ id, name, type, topic?, rank, readOnly: boolean, muted, unread:{count,mentions}, firstUnreadSeq?, speechMode, queueTurnSeconds, voice?: {count, first: UserRef[]} }] }] }` — `voice` fecha `RT-05`; `speechMode`/`queueTurnSeconds` são da emenda de 2026-08-28 (§6.6) e valem os defaults de §6.6 quando ausentes no log |
| `query.messages` | `{communityId, channelId, cursor?, limit=50, direction:'before'\|'after'}` | `{ messages: MessageDto[], nextCursor?, hasMore, replication: ReplicationState }` |
| `query.message` | `{communityId, messageId}` | `MessageDto & { reactions: ReactionDto[], attachment?: AttachmentDto, thread?: ThreadRefDto } \| null` |
| `query.reactors` | `{communityId, messageId, emoji, limit=24}` | `{ total, users: UserRef[] }` — fecha `DR-47` |
| `query.thread` | `{communityId, threadId, cursor?, limit=50}` | `{ root: MessageDto, replies: MessageDto[], nextCursor?, replyCount, participants: UserRef[], unread:{count} }` — fecha `DR-48` |
| `query.thread.unread` | `{communityId, channelId?, cursor?, limit=25}` | `{ items: [{ threadId, rootMessageId, channelId, unreadCount }], nextCursor?, hasMore }` — as threads do canal (ou da comunidade, sem `channelId`) com `unreadCount > 0`, raiz mais recente primeiro (§23.2); a contagem é a mesma linha de `local_thread_read_state` que `query.thread.unread.count` lê e quem zera é `thread.markRead`. Emenda de 2026-08-25: fecha o §9, 2.2 badge do chip (delta-UX §2.2 item 7) |
| `query.pinned` | `{communityId, channelId, cursor?, limit=25}` | `{ items: MessageDto[], nextCursor?, hasMore }` |
| `query.files` | `{communityId, channelId, cursor?, limit=25}` | `{ items: [{ messageId, at, author: UserRef, attachment: AttachmentDto }], nextCursor?, hasMore }` |
| `query.links` | `{communityId, channelId, cursor?, limit=25}` | `{ items: [{ messageId, at, author: UserRef, url, host }], nextCursor?, hasMore }` — fonte: `message_links` (§15.6.1) |
| `query.members` | `{communityId, filter?:{query?, roleId?, onlyOnline?}, cursor?, limit=100}` | `{ groups: [{ roleId, roleName, roleColor, rank, members: (UserRef & {presence, joinedAt})[] }], offlineCount, total, nextCursor? }` |
| `query.member` | `{communityId, identityKey}` | `{ ...UserRef, roleIds, roles: [{id,name,color,rank}], joinedAt, presence, banned, timeoutUntil?, canModerate, canKick, canBan, canTimeout, canSetRoles, storageUsedBytes }` |
| `query.roles` | `{communityId}` | `{ roles: [{ id, name, color, rank, permissions, mentionable, isFounder, isDefault, memberCount }] }` ordenado por `rank DESC` |
| `query.invites` | `{communityId}` | `{ items: [{ invitePublicKey, code?: string, codeAvailable: boolean, label?, createdBy: UserRef, createdAt, expiresAt?, maxUses?, uses, revokedAt? }] }` — `code` só nos criados nesta instalação (delta U-04) |
| `query.auditLog` | `{communityId, type?, byKey?, from?, to?, cursor?, limit=25}` | `{ items: [{ id, seq, type, targetId?, targetKey?, targetLabel, by: UserRef, byLabel, reason?, at }], nextCursor?, hasMore }` — **exige `view_audit_log`**, senão `E_PERMISSION_DENIED` |
| `query.bans` | `{communityId, cursor?, limit=25}` | `{ items: [{ target: UserRef, by: UserRef, at, reason? }], nextCursor?, hasMore }` — exige `view_audit_log` ou `ban_members` |
| `query.timeouts` | `{communityId, cursor?, limit=25}` | `{ items: [{ target: UserRef, by: UserRef, at, until, reason?, expired: boolean }], nextCursor?, hasMore }` — `expired` é calculado contra o `hostTs` do último registro |
| `query.search` | §23.1 | `{ messages: [{...MessageDto, channelId, channelName, snippet}], channels: [...], members: UserRef[], partial: boolean, partialReason?: 'host-offline'\|'catching-up'\|'stalled'\|'partial-interpretation' }` |
| `query.outbox` | `{communityId?}` | `{ items: [{ opId, clientRef?, communityId, channelId?, channelName?, kind, kindLabel, state, attempts, enqueuedAt, nextAttemptAt, lastError?, droppedReason?, preview: { content?: string, emoji?: string, targetMessageId?: string } }], counts:{queued,sending,failed} }` — **`preview` é o que permite a UI redesenhar a fila ao reabrir** (fecha `F-16`). **Emenda de 2026-09-05:** `enqueuedAt` é o `created_at` do item em `local_outbox` (§11.2) — o instante em que a op foi enfileirada NESTA máquina. Sem ele o renderer não tinha carimbo honesto para a bolha redesenhada e inventava a época zero, com separador de data de 1970 na conversa. Não é `hostTs` nem substitui: enquanto a op não foi observada na réplica, o log não tem instante nenhum a dar |
| `query.preferences` | `{}` | `{ device:{microphoneId?, cameraId?, outputId?, inputVolume, outputVolume}, notifications:{enabled, byCommunity:[{communityId, level}]}, channels:[{channelId, muted}], relayConsent:[{communityId, decision, at}], participantVolumes:[{communityId, identityKey, volume}] }` — fecha `RT-02` |
| `query.hostStatus` | `{communityId}` | `{ status: HostStatus, lastSeenAt?, inactiveDays, replication: {state, lag}, attempt? }` — **emenda de 2026-08-23:** `lastSeenAt`/`inactiveDays` ficam AUSENTES enquanto não houver contato observado nenhum com o host (réplica que nunca o viu não tem dias para contar, e inventar zero seria mentir); `inactiveDays` é derivado na leitura do LS (§22.2 emendado); `attempt` só existe acima de zero |
| `query.resolveMessageLink` | `{ref}` | `{ status:'ok', communityId, channelId, messageId, seq } \| { status:'not-member', communityId } \| { status:'not-synced', communityId, channelId } \| { status:'deleted' } \| { status:'malformed' }` — fecha `RT-04` |
| `query.selfModeration` | `{communityId}` | `{ banned: boolean, bannedAt?, kicked: boolean, timeoutUntil?, byLabel?, reason? }` — alimenta a tela de §18.4 |
| `query.voiceQueue` | `{communityId, channelId}` | `{ open, items: [{keyHex, displayName, queuedAt}], turn: {keyHex, displayName, endsAt} \| null } \| null` — **novo (2026-08-28)**; `null` quando o canal não tem fila (sem sessão ou `speechMode ≠ 1`). É a consulta que reconstrói `voice.queueChanged` (§16.3 regra 1). `displayName` vem da leitura, não da fila: a fila guarda só chave |

#### 15.6.1 `MessageDto` e derivados

```ts
type MessageDto = {
  id: string, seq: number, channelId: string
  author: UserRef
  content: string | null                     // null quando tombstonada
  authorTs: Ms, hostTs: Ms, clockSkewed: boolean   // fecha F-33/M-17
  editedAt?: Ms, pinned: boolean
  replyTo?: { messageId, author: UserRef, excerpt: string | null, deleted: boolean }
  threadId?: string, threadReplyCount?: number
  mentions: { identityKeys: Key[], roleIds: string[], everyone: boolean }
  mentionsMe: boolean
  hasAttachment: boolean
  deleted: boolean, hiddenByBan: boolean
}
type ReactionDto   = { emoji: string, count: number, mine: boolean }
type AttachmentDto = { blobsCoreKey: Key, blobId: object, name, sizeBytes, kind, hash,
                       state: BlobState, progress: number, availablePeers: number,
                       hostAvailable: boolean, localPath?: string,
                       revealMode: 'open' | 'folder' | 'none' }
// Emenda de 2026-08-22: `availablePeers`/`hostAvailable` são leitura do bitfield VIVO
// (§13.4 passo 4). Fora de um download em curso não há par conectado àquele core, e é isso
// que `0`/`false` dizem — não há registro persistente de pares, e inventar um seria pior.
// Emenda de 2026-09-05 (B74): `revealMode` é a regra 1 de §13.6 dita à UI, decidida pela
// extensão REAL do nome. `kind` continua sendo o do remetente e não serve para isto.
// Emenda de 2026-09-05 (fecha B14): a **correlação com os eventos de blob** é o `blobIdHex`
// de §13.2 — os 16 primeiros bytes do `hash`, em hex (`hash.slice(0,32)`). É a chave que
// `blob.progress`, `blob.completed`, `blob.peerLost`, `blob.unavailable` e
// `attachment.corrupt` carregam desde a emenda de 2026-08-22, e ela não estava declarada
// deste lado: a UI recebia o DTO por uma chave e os eventos por outra, sem nada dizendo que
// são a mesma. Vale igual na conversa direta (§31.16.3) — lá o `communityId` do pedido de
// download é o `conversationId` (§31.14), e a correlação não muda.

// `blob.stage` NÃO devolve um `AttachmentDto`: o que ele descreve são bytes recém-escritos
// no core de blobs local, sem estado de download, sem pares e sem `revealMode` (nada foi
// revelado). O que ele devolve, e o que vira `attachment` na op de §7.4.1, é:
type StagedAttachmentDto = { blobsCoreKey: Key, blobId: object, name, sizeBytes, kind, hash }
```

**`replyTo` para mensagem deletada (fecha `F-47`/`M-7`):** a resposta continua existindo,
com `excerpt: null` e `deleted: true`. A UI exibe "mensagem removida" no lugar da citação.
Comportamento definido, não inventado.

**Extração de links (fecha `DR-38`):** o `fold` extrai do `content`, no efeito de
`message.send`/`message.edit`, todas as ocorrências que casem
`\b(https?):\/\/[^\s<>"']{1,2000}` — **só `http` e `https`**, no máximo 8 por mensagem, na
ordem de aparição, gravando `url` e `host` (o registrable domain, sem porta e sem
credenciais). **Emenda de 2026-08-22:** `host` é o **hostname** — sem porta, sem
credenciais, em minúsculas —, não o registrable domain. Calcular "registrable" exige uma
Public Suffix List, e uma PSL **muda com o tempo**: o mesmo registro produziria estados
diferentes em binários diferentes, o que §8.0 proíbe. A URL que o `URL` do runtime recusa
não vira link nenhum (§8.5 — o `fold` normaliza, nunca lança), e a mesma URL repetida entra
uma vez só. Editar reescreve os links do conteúdo novo; o tombstone os remove com as
reações. Sem unfurl, nunca — buscar a página vazaria o IP de todo mundo. A mesma
allowlist de esquema vale para o renderizador de markdown (fecha `T-18`): links com
esquema fora de `http`/`https`/`mailto` são renderizados como **texto**, não como âncora.

**Cursor:** `base64url({seq, id})`, opaco. Inválido, de outra tabela ou de outra
comunidade → `E_BAD_CURSOR`, e a UI recomeça do início. Nunca resultado errado em silêncio.

**Emenda de 2026-08-22 — ordenação de `query.bans`/`query.timeouts`.** As duas tabelas não
têm `seq`: o "mais recente primeiro" de §23.2 se dá por `at`, com desempate pela chave do
alvo, e o cursor carrega `{seq: at, id}` — mesmo formato opaco, mesma recusa. Em
`query.bans` só entram bans vivos (`revoked_at IS NULL`): o schema da resposta não declara
revogação, e quem foi revogado não está banido.

**Emenda de 2026-08-22 — `resolveMessageLink` no `not-synced`.** O `channelId` da resposta
fica **ausente** nesse status: a op ainda não foi projetada nesta instalação, e ninguém —
nem o log bruto dela, sem interpretação — sabe dizer em que canal cairia. O campo existe
nos status que já conhecem a mensagem.

**Enforcement de leitura (fecha `DR-25`, `T-44`):** `query.auditLog`, `query.bans` e
`query.timeouts` exigem a permissão e devolvem `E_PERMISSION_DENIED` sem ela.
**LIMITAÇÃO DECLARADA (L-10):** como a replicação é integral, um cliente adulterado
consegue ler as tabelas do próprio disco. `view_audit_log` é confidencialidade **local**,
não segredo criptográfico. A UX precisa dizer isso (delta U-07).

### 15.7 IPC-M — main ↔ núcleo

| Mensagem | Direção | Payload |
|---|---|---|
| `key.wrap` / `key.wrapped` | núcleo → main → núcleo | `{plaintextB64}` / `{ciphertextB64}` |
| `key.unwrap` / `key.unwrapped` | núcleo → main → núcleo | `{ciphertextB64}` / `{plaintextB64}` |
| `file.pick` / `staging.ticket` | núcleo → main → núcleo | `{communityId}` / `{ticketId, path, sizeBytes, communityId}` |
| `auth.token` | main → núcleo | `{token, cmd, expiresAt}` |
| `deeplink` | main → núcleo | `{route:'join'\|'message', code \| ref}` (já parseado, §3.5) |
| `capture.authorize` / `capture.decision` | main → núcleo → main | `{sessionId, kind?: 'screen'\|'music', audio?: bool}` / `{allowed, sourceTypes, audio}` (§17.5). **`audio` é a emenda de 2026-09-03 (B39)**: o pedido de som viaja junto e a resposta diz se ele é concedido — som negado sobe a captura **muda**, nunca derruba a imagem. `kind` é da emenda de 2026-08-28: `music` autoriza a captura de **áudio do sistema** do Modo Música, contra o `captureToken` de `music.start` (§15.4) em vez de uma sessão `share.start`; a decisão continua local ao núcleo (§15.4: permissão conferida no comando, host nunca consulted) |
| `exit.impact` / `exit.impactResult` | main → núcleo → main | `{}` / `[{communityId, name, onlineCount, inCallCount, pendingReplication}]` |
| `file.save` | núcleo → main | `{suggestedName, dataRef}` — usado por `identity.export` |
| `shell.open` | núcleo → main | `{path, mode}` — só depois da allowlist de §13.6 |

**Emenda de 2026-08-22 — `file.pick`.** A tabela tinha só a metade de volta
(`staging.ticket`): §15.4 diz que `file.pickForAttachment` é um comando do renderer e que
"o main abre o diálogo", mas nada declarava como o núcleo pedia isso. `file.pick{communityId}`
é essa metade, com a mesma forma de par que `capture.authorize`/`capture.decision` e
`exit.impact`/`exit.impactResult` já tinham. O caminho de arquivo continua nascendo e
morrendo entre main e núcleo: ele nunca aparece no IPC-R (`T-16`, `DR-37`).

**Emenda de 2026-09-03 — `capture.authorize` passa a ver o som.** Até aqui o flag de áudio ia
do renderer **direto ao main**, que o obedecia, e o núcleo não sabia se a captura que ele
acabara de autorizar levava o som da máquina inteira. Isso era incoerente com o próprio §17.5:
o **Modo Música** é a mesma captura de áudio e tem `kind` próprio, `captureToken` próprio e
gate de permissão declarado desde a emenda de 2026-08-28 — o caso derivado foi declarado e o
originário não. E deixava o renderer como única autoridade sobre uma captura que alcança tudo
o que a máquina toca.

Não há permissão nova: quem pode compartilhar pode compartilhar com som. O que muda é **quem
responde**, e três consequências que só existem com a resposta vindo do núcleo:

1. **`allowed` e `audio` são decisões separadas.** Som negado sobe a captura **muda** — o
   desfecho honesto de §17.5, o mesmo que uma plataforma sem áudio separável por janela já
   produzia. Negar a captura inteira por causa do som puniria a imagem, que estava autorizada.
2. **A permissão é lida no instante do pedido**, contra o DS corrente, e não no `share.start`.
   É a mesma disciplina do gate do Modo Música. Quem perde `voice_share_screen` entre uma
   coisa e outra transmite imagem e não transmite o som da máquina.
3. **Fica rastro do lado que autoriza**, e não só do lado que pede.

**Nenhuma mensagem de IPC-M carrega dado de domínio.** Nenhuma delas é acessível ao
renderer, direta ou indiretamente.

---

## 16. Contratos RPC P2P

### 16.1 Transporte

`protomux-rpc` sobre o stream do Hyperswarm. **Dois protocolos distintos, com canais
distintos:**

| Protocolo | Uso | Autorização |
|---|---|---|
| `p2p-community/1` | Ops, roster, mídia, blobs — um canal por comunidade, chaveado pelo `coreKey` | §14.3 — o canal só abre se o par for membro ativo não banido |
| `p2p-admission/1` | `inviteResolve`, `inviteRedeem` | Nenhuma; tetos e cotas de §12.6 |
| `p2p-dm/1` — **emenda de 2026-09-01** | `dmHello`, replicação dos dois cores de uma conversa direta e — **emenda de 2026-09-02** — a sinalização de mídia de §31.15 (`dm.signal`, `dm.call`) | §31.8(4) — o canal só abre para o par daquela conversa, não bloqueado |

| Parâmetro | Membro | Pré-membro |
|---|---|---|
| Timeout de request | 15 000 ms (30 000 ms para `redeem`) | 10 000 ms |
| Requests em voo | 8 | 2 |
| Frame máximo antes do decode | 64 KiB | 4 KiB |
| Reconexão | `rpcClient` reabre na conexão seguinte; requests em voo falham com `E_HOST_UNAVAILABLE` e voltam à outbox | — |
| Circuit breaker | §11.8 | — |

**Emenda de 2026-08-22 — `protomux`, e quem abre o canal.** O que esta seção pede de
`protomux-rpc` é (a) dois protocolos distintos em canais distintos sobre o stream do
Hyperswarm e (b) a tabela de parâmetros acima. (a) é `protomux`, que é a camada sobre a qual
o próprio `protomux-rpc` é construído, e é o que §14.3(1) já nomeia ("canal `protomux` de
replicação"). (b) — timeout, requests em voo, teto de frame antes do decode, reconexão,
circuit breaker — não existe em `protomux-rpc` e teria de ser implementado por cima dele de
qualquer maneira; é o que `rpcClient`/`rpcServer` fazem. Some-se a isso §16.3, cuja tabela
**fechada** de notificações sem `id` e sem retentativa não tem equivalente em
`protomux-rpc`. A implementação usa portanto um **canal `protomux`** por protocolo, chaveado
como esta tabela manda, carregando os quadros de §16.2/§16.3. Nenhum parâmetro, método,
tópico ou código de erro muda.

**Quem abre o canal é o membro; o host responde.** Um canal aberto contra um par que ainda
não o registrou é recusado pelo `protomux` e morre. Como o membro só descobre quem é o host
**lendo o log** (§14.1, §14.3 emenda item 2), é ele quem sabe quando o canal faz sentido; o
host registra o par `(protocolo, id)` e aceita quando pedirem. A assimetria é a mesma do
anúncio na DHT: o host anuncia o tópico, o membro procura.

### 16.2 Métodos

| Método | Protocolo | Request | Response | Erros |
|---|---|---|---|---|
| `hello` | community | `{clientVersion, opVersion}` | `{hostVersion, opVersion, coreLength, memberCount, capabilities[]}` | `E_VERSION_UNSUPPORTED`, `E_NOT_AUTHORIZED_FOR_COMMUNITY` |
| `submitOp` | community | `{envelope}` | `{seq, hostTs}` | Todos os de §8.2 |
| `submitOps` | community | `{envelopes[≤32]}` | §11.9 | — |
| `admissionHello` | admission | `{clientOpVersion}` | `{challenge, hostPk, hostOpVersion}` | `E_VERSION_UNSUPPORTED` |
| `inviteResolve` | admission | `{invitePk, candidatePk, liveProof}` | `InvitePreview` | `E_INVITE_INVALID` |
| `inviteRedeem` | admission | `{envelope, liveProof}` | `{seq, communityId, coreKey, blobsKey, hostKey, defaultChannelId}` | `E_INVITE_EXHAUSTED`, `E_BANNED`, `E_INVITE_INVALID` |
| `voiceJoin` | community | `{channelId}` | `{sessionId, roster[], iceServers[], tickets[], turnCredential}` | `E_PERMISSION_DENIED` |
| `voiceLeave` | community | `{sessionId}` | `{}` | — |
| `voiceState` | community | `{muted, deafened, cameraOn, speaking}` | `{}` | — |
| `voiceTicket` | community | `{sessionId, peerKey}` | `{ticketId, ticket, expiresAt}` | `E_TICKET_DENIED` |
| `voiceMute` | community | `{sessionId, targetKey, muted}` | `{}` | `E_PERMISSION_DENIED`, `E_SESSION_GONE` |
| `voiceSignal` | community | `{sessionId, toPeerKey, ticketId, sdp?, ice?}` | `{}` | `E_PEER_UNREACHABLE`, `E_TICKET_INVALID`, `E_SESSION_GONE` |
| `voiceQueueJoin` | community | `{channelId}` | `{}` | `E_SESSION_GONE`, `E_QUEUE_CLOSED` — §16.4 |
| `voiceQueueLeave` | community | `{channelId}` | `{}` | — idempotente; `E_SESSION_GONE` só se o canal não tem sessão |
| `voiceQueueModerate` | community | `{channelId, action, targetKey?, seconds?}` | `{}` | `E_SESSION_GONE`, `E_PERMISSION_DENIED`, `E_VALIDATION` — §16.4 |
| `shareStart` | community | `{channelId, quality}` | `{sessionId}` | `E_PERMISSION_DENIED`, `E_ALREADY_SHARING` |
| `shareJoin` | community | `{sessionId}` | `{ticketId, presenterKey}` | `E_SESSION_GONE`, `E_PERMISSION_DENIED` |
| `shareLeave` | community | `{sessionId}` | `{}` | — |
| `shareQuality` | community | `{sessionId, quality}` | `{applied}` | `E_SESSION_GONE`, `E_PERMISSION_DENIED` |
| `shareReport` | community | `{sessionId, samples[]}` | `{}` | `E_SESSION_GONE`, `E_PERMISSION_DENIED` — **emenda de 2026-08-25:** a perna de SUBIDA do laço de saúde de §17.5. §16.3 declarava `share.health` descendo ao apresentador e nada declarava como as amostras chegam ao host, que é quem consolida e degrada. `peerKeyHex` é o da conexão (§16.3 regra 4): só o apresentador daquela sessão relata |
| `presencePublish` | community | `{status, typingChannelId?}` | `{}` | `E_RATE_LIMITED` — **emenda de 2026-08-23:** o mesmo método carrega presença E typing, com tetos independentes de §17.6 (5 s e 2 s). Repetir o MESMO `status` dentro da janela de 5 s não carrega informação nenhuma — é o fluxo do "digitando…" da UI, que dispara mais rápido que o teto de presença — e é tratado como no-op, seguindo para o typing; `status` DIFERENTE dentro da janela continua sendo `E_RATE_LIMITED` |
| `subscribeChannel` | community | `{channelId, on:bool}` | `{}` | — assinatura de interesse para `typing` (§17.6) |
| `stunBinding` | community (mesmo socket UDX) | Pacote STUN RFC 5389 | Binding Response | — §17.3 |

### 16.3 Notificações do host (emenda de 2026-08-22)

§16.2 declarava só pedido/resposta, mas §15.5 tem eventos que **apenas o host pode
conhecer** — o roster de uma chamada, a revogação de um ticket, a sinalização de outro par,
o estado de uma sessão de tela. Para um membro que não hospeda, faltava a direção
host → membro inteira. Ela é uma **segunda forma de quadro no mesmo canal**, não um
protocolo novo: sem `id`, sem resposta e sem retentativa.

| Tópico | Payload | Evento de §15.5 correspondente |
|---|---|---|
| `voice.roster` | `{sessionId, channelId, participants[]}` | `voice.roster` |
| `voice.revoked` | `{targetKey, sessionId}` | `voice.revoked` |
| `voice.failed` | `{reason, sessionId}` | `voice.failed` — **Emenda de 2026-08-26:** §19.8 sempre mandou o host emitir `voice.failed{reason:'channel-deleted'}` a cada participante e §15.5 sempre declarou o evento, mas a tabela desta seção não o listava. Pela regra 2 daqui, tópico fora da tabela é **descartado em silêncio** pelo cliente: em modo membro o encerramento nomeado não tinha por onde descer, e a chamada acabava sem dizer por quê. `reason` é o motivo da revogação de §17.4 que encerrou a sessão inteira (`channel-deleted`, `community-ended`) |
| `voice.signal` | `{peerKey, ticketId, sdp?, ice?}` | `voice.signal` |
| `share.started` / `share.stopped` | `{sessionId, presenterKey, channelId}` | idem |
| `share.viewersChanged` | `{sessionId, viewerCount}` | idem |
| `share.failed` | `{sessionId, reason}` | `share.failed` — **Emenda de 2026-08-26:** mesma omissão de `voice.failed`. É por aqui que o espectador revogado (§17.5) descobre que a tela acabou **para ele**; só ao alvo |
| `voice.occupancyChanged` | `{channelId, count, firstKeys[≤5]}` | `voice.occupancyChanged` — **Emenda de 2026-08-26:** §15.5 e §17.6 sempre mandaram a ocupação a **todos os membros conectados** (é o que alimenta os avatares inline da sidebar, `RT-05`), e a tabela desta seção não a listava. Pela regra 2, o tópico morria no `notify` do host: a ocupação nunca saía da máquina de quem hospeda, e **para quem não hospeda a sala de voz aparecia sempre vazia**, mesmo com gente dentro — `query.structure` não tem produtor de ocupação fora do host (§15.6). Terceira ocorrência da mesma omissão, depois de `voice.failed` e `share.failed`. Vai também **como instantâneo** na conexão de um membro novo: ocupação é NÍVEL, não sequência, e quem chega no meio de uma chamada não viu nenhuma das mudanças anteriores |
| `voice.queueChanged` | `{channelId, open, items[], turn}` | `voice.queueChanged` — **novo (2026-08-28, §16.4)**: a fila de karaokê mudou. Vai a todos os membros conectados do canal (não só aos da sessão: a fila é visível a quem assiste sem estar na chamada), e como instantâneo na conexão, pela mesma regra de NÍVEL da ocupação |
| `share.health` | `{sessionId, viewers[]}` | idem — **só ao apresentador** (§17.5). **Emenda de 2026-08-25:** `viewers[]` é a **audiência autorizada** da sessão, não só quem já rendeu amostra — é por aqui que o apresentador descobre A QUEM servir, já que `share.viewersChanged` manda só a contagem. `rttMs`/`lossPct` são **omitidos** enquanto aquele espectador não foi medido; zerá-los faria a UI exibir "0 ms" como medida e a degradação ler uma perda que ninguém observou |
| `presence.changed` | `{entries[]}` | idem |
| `typing.changed` | `{channelId, identityKeys[]}` | idem |

**Regras normativas:**

1. **Entrega at-most-once, sem ACK e sem retentativa.** É a mesma garantia que `DS-30` pedia
   que fosse declarada para `presence`/`typing`, agora válida para a direção inteira. O custo
   de uma perda é o que §15.1 regra 5 já cobre: evento é sinal para reconsultar, nunca fonte
   de verdade, e cada tópico acima tem uma consulta que o reconstrói.
2. **A tabela é fechada, e tópico fora dela é descartado em silêncio** pelo cliente. Um host
   mais novo pode empurrar o que este cliente não entende, e isso nunca pode derrubar a
   conexão — mesma regra de §7.2 para `kind` desconhecido.
3. **Vale o mesmo teto de frame de §16.1**, aplicado antes do envio. Notificação que não cabe
   não é fatiada: ela não é enviada, e quem a produziu sabe disso.
4. **O host não fabrica origem.** Em `voice.signal`, `peerKey` é a chave da **conexão** de
   quem enviou, nunca um campo do pedido (§16.2 `voiceSignal`).
5. **Quem recebe sinalização verifica o ticket antes de agir** (§17.4 passo 3). A verificação
   é do núcleo receptor, não do renderer: o núcleo já tem o material do par e a chave do
   host, e sinalização não autorizada não deve chegar à camada que fala WebRTC.

**Emenda de 2026-08-22 — `voiceSignal`, e o host como relay de sinalização.** `voice.signal`
estava em §15.4 (comando) e em §15.5 (evento) com payloads casados, mas nada declarava o
salto entre os dois. Ele é **encaminhado pelo host**, e não trocado par-a-par, por duas
razões que não têm alternativa: antes de o ICE fechar não existe canal direto entre os dois
membros — é justamente o que a sinalização serve para abrir —, e §17.4 passo 3 exige que
quem recebe veja um ticket válido para aquele par, o que só o host emite. Quem tem conexão
com os dois é o host, que já é par da comunidade (§17.2) e já autoriza a sessão. O host
**encaminha sem ler**: ele não interpreta SDP nem decide nada sobre a mídia, que continua
sendo DTLS-SRTP ponta a ponta (§17.2). É isso que dá sentido a `E_PEER_UNREACHABLE`
("sinalização não chegou", §20.2), que só existe se alguém encaminha.

**Emenda de 2026-08-22 — `voiceMute` e `shareQuality`.** `voice.muteParticipant` e
`share.setQuality` são comandos de §15.4 cuja decisão é do host, e a tabela não tinha método
para nenhum dos dois: em modo membro eles não tinham por onde passar. Os dois métodos acima
fecham isso sem criar semântica nova — cada um é o transporte do comando de §15.4 que leva o
mesmo nome, com os mesmos erros. Duas consequências que **não** precisam de superfície nova:
o silenciamento continua sendo conselho ao cliente do alvo (L-12), e chega a ele pelo
`voice.roster` que o host já emite; a qualidade pedida pelo espectador chega ao apresentador
pelo `quality` que `share.health` já carrega por espectador (§15.5, §17.5).

**Fluxo obrigatório na primeira conexão:** `hello` antes de qualquer outro método.
`opVersion` incompatível → o cliente entra em **somente-leitura** naquela comunidade,
emite `host.statusChanged{status:'incompatible'}`, e todo item de outbox daquela comunidade
vira `dropped/client-outdated` (§11.6). Nunca envia op que o host não entende.

### 16.4 A fila de karaokê — turn-taking do modo fila (emenda de 2026-08-28)

A fila existe **por canal de voz em `speechMode = 1` (§6.6) com sessão de voz ativa**, é
**efêmera** (§6.16: nunca persiste, morre com o host e com a sessão de §17.4) e mora no
mesmo nó que o roster — o host da comunidade, ou quem a suceder com a fila vazia (fila não
é estado de decisão; a sucessão não a reconstrói). O estado é um só:

```
{ aberta: bool, itens: [{keyHex, queuedAt}] ordenados, turno: {keyHex, endsAt} | null }
```

**Entrada (`voiceQueueJoin`).** Exige sessão de voz ativa no canal (o membro está no roster
de §17.4), canal em modo fila, fila `aberta`, autor ainda não na fila e não sendo o titular.
Repetir a entrada é idempotente. Fila fechada é `E_QUEUE_CLOSED` — o erro existe para a UI
dizer "a fila está fechada", e não "sem permissão": fechar a fila não é moderação contra
ninguém em específico.

**Primeiro turno é automático.** Entrada nova numa fila sem turno corrente vira titular no
ato — a fila existe para dar vez, não para esperar um moderador abrir a primeira. A partir
daí a promoção é sequencial: expiração, `skip` ou saída do titular promovem **o próximo da
fila**; fila vazia encerra o turno sem sucessor.

**Expiração.** O turno dura `queueTurnSeconds` do canal (§6.6, default 300 s). O host mantém
o prazo com o relógio local e, ao expirar, **muta o titular** (imposição de §17.4 emenda:
roster volta a `muted: true`) e promove o próximo. `endsAt` viaja no evento para a UI
desenhar a contagem; o relógio de verdade é o do host — a UI nunca desmuta por conta
própria quando o prazo dela vence.

**A troca de turno aplica no roster NO ATO** (emenda de 2026-08-28, product fix). O sweep
de §17.4 reimpõe o gate só quando um op é projetada — entre "a vez acabou" e o próximo
registro do log pode haver minutos, e quem perdeu a vez ficaria com o microfone aberto o
tempo todo. Toda promoção (automática, `skip`, `promote`, saída ou remoção do titular) faz
o host, no mesmo ato: **abrir o microfone do titular novo** — a imposição de entrada vale
até chegar a vez, e é a promoção que a levanta — e **silenciar quem perdeu a vez**,
inclusive quando a fila encerra sem sucessor. Vale só em canal `speechMode = 1`: a fila
sobrevive a uma troca de modo para livre, e impor turno num canal livre mutaria a sala
inteira. E o fio fala os nomes de §15.5 (`{open, items, turn}`): o estado interno do
módulo tem nomes próprios, e a tradução mora em uma função usada pelos dois pontos que
emitem — espalhar os nomes internos fez o renderer descartar o evento por forma, com
"Entrar na fila" funcionando no host e a tela nunca ficando sabendo. Por isso **todo
comando da fila é seguido de reconsulta** (`query.voiceQueue`, §15.1 regra 5): o evento é
at-most-once e o desfecho do próprio clique não pode depender dele.

**Moderação (`voiceQueueModerate`), com `voice_mute_others`:**

| Ação | Efeito |
|---|---|
| `skip` | Encerra o turno corrente e promove o próximo (sem alvo) |
| `promote {targetKey}` | Dá a vez a quem está na fila, fora da ordem — ou encerra o turno corrente se o alvo é o titular. Alvo fora da fila é `E_VALIDATION` |
| `remove {targetKey}` | Tira da fila; tirar o titular encerra o turno e promove o próximo |
| `addTime {seconds}` | Estende o turno corrente; `seconds` é inteiro em 30..600 e o total do turno não passa de 3600 (§6.6) — `E_VALIDATION.seconds` |
| `close` / `open` | Fecha/abre a **entrada** na fila. Quem já está continua; o turno corrente não é afetado |

**Gate de transmissão.** O titular do turno é quem o §17.4 (emenda de 2026-08-28) deixa
fazer `voiceState {muted: false}`; a fila e o gate compartilham o mesmo estado — não existe
"titular que o host mantém mudo" nem "desmutado que não é titular". Quem entra no canal em
modo fila entra bloqueado, inclusive quem já era titular de turno anterior.

**Eventos.** Toda mudança de estado emite `voice.queueChanged` (§16.3) e a consulta que a
reconstrói é `query.voiceQueue` (§15.6). A fila não emite `voice.roster`: o roster muda por
conta da imposição de mute (§17.4), e é ele quem carrega a mudança.

**Emenda de 2026-09-05 — sair da CHAMADA é sair da fila, e o texto não dizia.**

A seção declarava a entrada ("exige sessão de voz ativa no canal") e a saída explícita, e
tratava só de `voiceQueueLeave` na promoção sequencial. Todos os outros modos de deixar a
chamada — `mod.ban`, `mod.kick`, `mod.timeout`, `channel.delete`, `voice.leave` e a **queda
de conexão** (§17.4, emenda de 2026-08-26) — ficavam fora, e a implementação seguiu o texto:
`sair` só era chamado pelo comando do próprio usuário.

A consequência é do **canal inteiro**, não de quem saiu. O gate de transmissão desta seção é
"só o titular fala", e o host o impõe silenciando todo o resto: um titular que desligou o
computador deixa a sala muda até o `endsAt` vencer — até 300 s por default, 3600 s com
`addTime` —, e a promoção seguinte pode entregar a vez a outro ausente, encadeando turnos de
silêncio. A expiração periódica não resolvia porque ela só sabe se a **sessão** vive, não
quem está nela.

**A regra:** a fila é da sessão, e vale para ela a mesma reconciliação contínua que §17.5
já aplica à audiência da tela. **A cada `voice.roster`, quem não está no roster sai da fila;
titular ausente perde a vez no ato e o próximo PRESENTE é promovido.** É uma regra, não um
gatilho por verbo: qualquer caminho que mude o roster passa por ela, inclusive os que ainda
não existem. A reconciliação é idempotente e só emite `voice.queueChanged` quando muda algo
— a própria imposição de turno produz um roster novo, e um evento por giro seria ruído.

---

## 17. Mídia: voz, câmera e tela

Resposta direta ao blocker B8. Esta seção **revoga** ADR-05/06/07/08/17 de v1 e as
substitui.

### 17.1 O que foi revogado e por quê

| Decisão de v1 | Por que caiu |
|---|---|
| "O endereço do HyperDHT é injetado como candidato ICE" (ADR-06) | O mapeamento NAT é **por socket**. A socket que o núcleo usa no DHT não é a socket que o `RTCPeerConnection` do renderer cria. Sob NAT dependente de porta ou de destino, o candidato derivado é inválido. Não é uma otimização arriscada: é uma premissa falsa (`F-19`) |
| "UDX é o fallback universal de voz" (ADR-07) | UDX declara "no handshakes, no encryption, no features". Não fornece ICE, DTLS-SRTP, jitter buffer, PLC, AEC, FEC, codec nem `MediaStreamTrack`. "Cair para UDX" significa **construir uma pilha de mídia**, que é exatamente o que ADR-05 existia para evitar (`F-20`) |
| "Blind relay não lê porque UDX é cifrado" (ADR-08) | UDX não cifra. A afirmação de confidencialidade era falsa (`T-11`) |
| Árvore WebCodecs+UDX no v1 (ADR-17) | Exige, junto: forwarding opaco, uma camada criptográfica autenticada própria, handshake de aresta, ACK de atribuição e reparo — nada disso especificado nem medido (`DS-14`, `DR-43`, `T-11`, `T-13`) |
| Sinalização peer-a-peer sem autorização | Qualquer chave conhecida abria conexão com qualquer membro (`T-15`) |

### 17.2 A arquitetura de mídia v2

> **Toda mídia do v1 — voz, câmera e tela — é WebRTC no renderer, ponta a ponta, com
> DTLS-SRTP. O núcleo nunca vê mídia. A conectividade é resolvida por ICE, com os serviços
> STUN e TURN prestados pelo *host da própria comunidade*, que já é um par dela.**

Por que isso é coerente com "sem servidor central": o host **já** é a autoridade daquela
comunidade, já precisa estar online para a voz existir (`VOZ-09`), e já é alcançável. Ele
não é um terceiro. Nenhum endereço de membro vaza para fora da comunidade.

Por que isso é honesto: DTLS-SRTP é negociado **entre os pares**. Um relay TURN encaminha
pacotes que não consegue decifrar. "Relay cego" deixa de ser uma afirmação e passa a ser
uma propriedade do protocolo.

| Camada | v1 | v2 |
|---|---|---|
| Voz e câmera | WebRTC mesh | **WebRTC mesh** (mantido) |
| Descoberta de endereço | Candidato do DHT | **STUN servido pelo host** (§17.3) |
| Fallback de conectividade | UDX "universal" | **TURN servido pelo host, e por voluntários** (§17.3, §17.7) |
| Autorização de sessão | Nenhuma | **Ticket assinado pelo host** (§17.4) |
| Tela | WebCodecs + UDX + árvore | **WebRTC estrela**, sem teto de audiência (§17.5, §90) |
| Árvore de multicast | v1 | **Adiada, especificada, bloqueada por POC-09** (§17.8) |
| STUN de terceiros | Configurável, default vazio | **Configurável, com aviso** — `default vazio` **emendado em 2026-08-25**, ver abaixo |

**Emenda de 2026-08-25 — o STUN de terceiros passa a vir LIGADO.** Decisão do operador,
registrada aqui porque contraria a letra anterior ("default vazio") e porque código e
normativo não podem divergir em silêncio.

O motivo da regra original continua verdadeiro: o servidor de terceiro **vê o IP de quem
entra em chamada**, e §25.4 recusa serviço externo por princípio. O que mudou é o peso do
outro prato. A **L-11** foi medida em produto entre dois provedores diferentes
(`sequenciamento-pos-fase-0.md` §80): sem endereço público nenhum dos dois lados descobre
candidato `srflx`, o ICE junta só endereço de rede local, e a chamada **não acontece**. Um
produto de voz que só funciona dentro da mesma rede não é um produto de voz.

Três guardas que a emenda **não** afrouxa:

1. **O STUN do host é tentado primeiro, e sozinho.** ~~O ICE tenta em ordem; quando o do host
   resolve, o de terceiro não é consultado.~~ **A JUSTIFICATIVA foi corrigida em 2026-08-30
   (§99.2) e a garantia foi REIMPLEMENTADA (§99.13).** Ordenar a lista nunca deu essa
   propriedade: RFC 8445 §5.1.1.2 pareia cada candidato de host com **cada** servidor
   configurado, e no libwebrtc `UDPPort::SendStunBindingRequests()` manda um Binding para
   todos, a partir de um `std::set` que nem preserva a ordem do array. Entregar a lista
   inteira ao agente e esperar que ele escolha era a garantia apoiada em nada.
   
   O que a entrega é **coleta em duas fases**: a `RTCPeerConnection` nasce só com o que o
   host serve, e a lista inteira só entra — por `setConfiguration` + `restartIce` — se
   nenhum `srflx` aparecer em `PRAZO_DA_FASE_UM_MS` (2,5 s). Quando o STUN do host responde,
   o de terceiro **não é entregue ao agente** e o IP não sai da comunidade. Quando o host
   não tem endereço público nenhum, a fase 1 nasce vazia e a escalada é imediata: quem está
   na L-11 pura não paga espera por uma fase sem servidor.
   
   O núcleo carimba `terceiro: true` nas entradas que não são dele (§17.3), porque
   **posição não identifica o host** — `[...doHost, ...terceiros]` tem `doHost` vazio sob
   L-11, e aí o terceiro É a primeira entrada.
2. **Desligar continua possível e é explícito.** `P2P_STUN_SERVERS=""` vence o default. A
   resolução distingue "variável não definida" de "definida e vazia" — confundi-las tornaria o
   padrão indesligável.
3. **Só STUN.** `turn:` continua descartado pelo parser. §17.3 mantém: *"não há TURN de
   terceiro e não haverá"* — um STUN responde um endereço, um TURN carregaria a mídia.

O aviso de §17.2 continua devido: enquanto não houver superfície de UI (lacuna **B29**), ele
aparece no log de fronteira do renderer.

**Emenda de 2026-09-03 — o m-line É o discriminador de vídeo, e isto fecha B41.**

Até aqui, do mesmo par chegavam duas coisas como trilha de vídeo pela **mesma**
`RTCPeerConnection` — a câmera (§17.2, malha) e a tela (§17.5, estrela) —, e **nada no fio as
distinguia**. Quem recebia decidia por heurística, cruzando o `msid` com o `share.join` que
ele próprio conseguira. Era a lacuna **B41**, e ela estava registrada como pedindo uma
correlação nova em §15.5/§15.6.

**Não pede.** A distinção já existe no protocolo que §17.2 usa, e só não estava sendo
exigida: cada trilha de uma `RTCPeerConnection` vive num **m-line**, e o m-line é negociado na
SDP, ponta a ponta, antes de qualquer mídia. O que faltava era **fixar o significado de cada
um**. Fica fixado:

| Posição | Conteúdo | `kind` |
|---|---|---|
| 0 | Voz | `audio` |
| 1 | Câmera (§17.2) | `video` |
| 2 | Tela — imagem (§17.5) | `video` |
| 3 | Tela — som (§17.5) | `audio` |

Toda `RTCPeerConnection` da malha nasce com **exatamente estes quatro** transceivers, criados
nesta ordem, em `sendrecv`, **antes da primeira oferta** e independentemente do que haja para
enviar. Ligar a câmera, começar a transmitir ou parar qualquer das duas é `replaceTrack()` no
transceiver reservado — **nunca** `addTrack`/`removeTrack`.

Cinco consequências, e nenhuma delas é de tela:

1. **B41 deixa de existir**, nas duas superfícies. Quem recebe sabe o que é cada trilha pela
   posição, sem consultar estado nenhum. A janela residual que B41 declarava — "entrar numa
   transmissão e o apresentador ligar a câmera no mesmo instante, com a câmera chegando
   primeiro" — fecha, porque não há mais ordem de chegada a interpretar.
2. **O som da tela deixa de ser inferido.** §17.2 dizia que a voz é "o áudio do primeiro
   stream deste par" e que qualquer outro áudio "é som que veio junto com uma tela". Isso
   também era heurística, e é a metade de áudio da mesma lacuna. Agora a posição 3 diz.
3. **Ligar e desligar câmera ou tela deixa de custar renegociação.** Hoje cada liga/desliga é
   um round-trip de SDP **por par** da malha; com o m-line já negociado, `replaceTrack` não
   toca na SDP. Some junto a classe inteira de defeito do m-line duplicado que a guarda de
   `senderDeVideo` existia para evitar.
4. **A ausência de trilha passa a ser observável.** `replaceTrack(null)` deixa a trilha do
   outro lado em `muted` em vez de a fazer sumir: "o par desligou a câmera" vira um evento do
   WebRTC, medido localmente, sem depender de roster nem de notificação. É o que torna a tela
   possível numa conversa direta (§31.15).
5. **A autorização não muda.** Numa comunidade a tela continua indo só a quem o host listou
   (§17.4, §17.5): o que muda é que o apresentador põe a trilha no transceiver reservado
   **daquela** conexão e deixa as outras em `null`. Reservar o m-line não é conceder audiência.

**O custo, declarado:** toda conexão negocia quatro m-lines, inclusive numa chamada só de voz.
São quatro seções de SDP sobre o mesmo transporte BUNDLE — não são quatro portas, quatro
alocações TURN nem quatro fluxos DTLS. É o preço de tornar determinístico o que era
adivinhação.

**Quem cria os quatro é quem OFERTA; quem responde os ADOTA.** Isto não é detalhe de
implementação, e sim a única forma que funciona: pela regra de associação do WebRTC, um
transceiver criado por `addTransceiver` **não** é candidato a receber um m-line de uma oferta
remota — só os criados implicitamente por `addTrack` são. Se os dois lados pré-criarem os
quatro, quem responde fica com **oito**: quatro órfãos, sem `mid`, segurando as trilhas
locais, e quatro que o navegador anexou para a oferta que chegou. Aquele lado conecta e
**não transmite nada**. Duas consequências obrigatórias para quem responde:

1. Resolver os m-lines pelo `mid` da negociação (0–3) e pôr as trilhas locais **neles**;
2. Forçar `sendrecv` nos quatro. O transceiver que o `setRemoteDescription` cria nasce
   `recvonly` — ele descreve o que o outro ofereceu, não o que este lado quer — e
   `replaceTrack` põe a trilha no sender **sem mexer na direção**. Sem o passo 2 a resposta
   sai dizendo "só recebo", e o resultado é o mesmo silêncio.

Os dois defeitos são assimétricos e silenciosos: a chamada conecta, o ICE fecha, e o áudio
anda num sentido só. Nenhum dos dois aparece numa suíte que finge o WebRTC; os dois foram
medidos em `smoke:voz` (§98), que é o motivo de ele existir.

**A correlação de §15.5/§15.6 que B41 pedia não é criada.** Ela deixa de ser necessária:
nenhum campo novo entra no IPC-R, nenhuma linha entra nas tabelas fechadas de §16.3 ou §31.8,
e o discriminador nunca atravessa o núcleo — ele vive na SDP, que §17.2 já manda viajar ponta
a ponta e que o núcleo já declaradamente não lê.

### 17.3 STUN e TURN comunitários

O núcleo do host escuta STUN/TURN **na mesma socket UDP do UDX**, demultiplexando pelo
cabeçalho (os dois primeiros bits `00` e o magic cookie `0x2112A442` identificam STUN; o
resto é UDX). Isso é a prática padrão de multiplexação ICE.

| Serviço | Escopo | Credencial |
|---|---|---|
| **STUN** (RFC 5389, Binding) | Aberto a qualquer par que já tenha conexão autenticada com o host | Nenhuma |
| **TURN** (RFC 5766, subconjunto: Allocate, Refresh, CreatePermission, Send/Data, ChannelBind) | Só membros com sessão de voz ativa | `turnCredential` de curta duração emitida em `voiceJoin`: `username = <sessionId>:<expiresAt>`, `password = HMAC(hostTurnSecret, BLAKE2b('turn-cred/1' ‖ sessionId ‖ peerKey ‖ expiresAt))` |

Controles obrigatórios do TURN do host:

| Controle | Constante |
|---|---|
| Vida da alocação | `TURN_ALLOC_TTL_MS` (10 min, renovável enquanto a sessão viver) |
| Alocações simultâneas por membro | `TURN_ALLOC_PER_MEMBER` (2) |
| Taxa por alocação | `TURN_RATE_KBPS` (default 512 kbps), sobre o **bundle** — ver a emenda de 2026-08-28 abaixo |
| Bytes por sessão | `TURN_SESSION_MAX_BYTES` |
| Permissões | Só para o **IP** de pares presentes no roster daquela sessão (RFC 5766 §9) |

O endereço público do host é obtido do próprio `hyperdht` (ele é um servidor DHT) e
entregue em `voiceJoin` na lista `iceServers`. A `turnCredential` é costurada na entrada
`turn:` pelo próprio `voiceJoin`: ela é de curta duração e amarrada ao par, e uma lista com
`turn:` sem credencial anuncia um caminho que responde 401.

**Emenda de 2026-08-28 (mesmo dia) — o `turn:` NÃO é anunciado até ser medido.** A emenda
anterior o pôs na lista, e isso **quebrou chamada em uso real**. O Chromium abre um
`TurnPort` contra o endereço anunciado e o mantém retentando enquanto o Allocate não fecha;
enquanto ele retenta, a **coleta de candidatos não termina**, e como §17.4 repete a oferta a
cada `REPETIR_OFERTA_MS` enquanto um par não responde, cada repetição reinicia o ICE antes
de ele convergir. Medido no log de uma chamada real: nove candidatos locais (host e srflx),
nenhum `relay`, coleta nunca concluída, `failed` no fim — numa chamada que fechava antes.

A causa de fundo é a nota acima: o endereço relayado sai de uma socket **nova**, e que ele
seja alcançável de fora depende de um NAT que ninguém mediu. O caminho existe e tem teste de
loopback ponta a ponta; a medida em rede real é `B4`. Anunciar antes dela era oferecer o que
não foi medido — e aqui o custo não é uma promessa errada na tela, é a chamada não fechar.

`P2P_TURN_ANNOUNCE=1` liga o anúncio para quem for medir; o default volta a ser só `stun:`.
Dois defeitos que o mesmo log expôs no servidor, e que ficam corrigidos para quando a medida
acontecer:

| Defeito | Correção |
|---|---|
| Retransmissão do **mesmo** Allocate (mesmo `txId`, mesmo 5-tuple) recebia **437** enquanto a porta relayada abria — e 437 faz o cliente derrubar a porta TURN inteira | RFC 5766 §6.2: retransmissão é reconhecida pela transação e **ignorada**; o pedido original responde por ela. Allocate diferente do mesmo cliente continua 437 |
| O aviso de §17.2 contava `iceServers.length − 1` como "de terceiro", pressupondo **uma** entrada do host | Conta por **endereço**: o host serve `stun:` e `turn:` no mesmo, e um aviso de privacidade que exagera é tão ruim quanto um que falta |

#### Emenda de 2026-08-28 — de onde vem o endereço RELAYADO (fecha `B27`)

A redação anterior dizia de onde vem o endereço do **serviço** e era silenciosa sobre o
endereço **relayado**: o `XOR-RELAYED-ADDRESS` que o Allocate devolve e que o par do outro
lado usa como destino. Não são o mesmo endereço — RFC 5766 §5 exige uma porta relayada por
alocação —, e uma socket UDP nova atrás de NAT tem um mapeamento externo que o host **não
conhece**. A socket do DHT é a única cujo mapeamento ele conhece, porque o `hyperdht` o
descobre e o mantém vivo. O G7 não expôs a lacuna: ele ligou a socket relayada em
`127.0.0.1:0`, com NAT emulado no mesmo processo, onde o endereço anunciado é alcançável
por construção.

**A decisão.** A socket relayada é nova por alocação, e o host descobre o mapeamento externo
**dela** mandando um Binding RFC 5389 ao STUN de terceiro que a emenda de 2026-08-25 de
§17.2 já deixa ligado por default. Consequências, todas declaradas:

1. O terceiro passa a ver o IP **do host**, não só o de quem entra em chamada. O custo é
   nulo: esse IP já está publicado na DHT, que é onde a comunidade inteira o encontra.
2. `P2P_STUN_SERVERS=""` desliga a descoberta junto com o resto. Sem terceiro e atrás de
   NAT, o Allocate responde **508 Insufficient Capacity** — recusa honesta, não um endereço
   inventado.
3. NAT simétrico **no host** faz o mapeamento observado valer só para o terceiro. Isso é a
   **L-11** já declarada abaixo, e é a razão de §17.7 existir.

**O primer.** Descobrir o mapeamento não basta: sob NAT restrito por porta o par só alcança
o endereço relayado depois que o host mandou algo para ele. Quem sabe o endereço do par é o
`CreatePermission` — §9 manda ignorar a porta ao casar a permissão, mas ela **vem** no
`XOR-PEER-ADDRESS` —, então é de lá que sai um datagrama de 1 byte, que não é STUN, nem
ChannelData, nem DTLS, e que o agente ICE do par descarta.

#### Emenda de 2026-08-28 — permissão por IP, e a ponte que a torna possível (fecha `B27`)

"Endereços de pares presentes no roster" era ambíguo e o produto o leu como `host:port`. Isso
era, ao mesmo tempo, mais estrito que RFC 5766 §9 — *"the port portion of each attribute will
be ignored and may be any arbitrary value"* — e **impossível de satisfazer**: a porta de
origem do `RTCPeerConnection` é de outra socket, com outro mapeamento NAT, e o host não tem
de onde sabê-la. Toda `CreatePermission` respondia 403 e o caminho relayado não existia.

Por IP a ponte fecha, e ela tem **duas pernas**, ambas necessárias:

| Perna | Fonte | O que cobre |
|---|---|---|
| Transporte | `remoteAddress` da conexão do swarm — o mesmo dado que §12.6 lê para a metade por /24 do rate limit pré-membro | Todo par conectado, sem custo novo |
| TURN | Um Allocate/Refresh que fecha o `MESSAGE-INTEGRITY` prova que aquela chave está naquele IP **agora** | O par cujo tráfego de mídia sai por IP diferente do da conexão do DHT (pool de saída de operadora, máquina com duas WANs) |

A união das duas, **filtrada pelo roster vivo**, é o conjunto permitido: quem sai da sessão
perde a permissão junto, que é o que a revogação de §17.4 exige.

Duas regras que a redação anterior não tinha e que RFC 5766 exige:

- **ChannelBind** liga o canal ao endereço de transporte completo (§11) e instala a
  permissão pelo **IP** (§9). São duas chaves, de propósito.
- **Dado que chega à porta relayada de um IP sem permissão é descartado** (§10). O endereço
  relayado é público; sem isso qualquer máquina que o descubra faz o host entregar bytes ao
  cliente por ela.

#### Emenda de 2026-08-28 — a recusa de tela via TURN cai (fecha `B27`)

A tabela dizia "tela via TURN é **recusada** no v1". O controle nunca foi aplicável, e não
por descuido de implementação: a tela reusa a **mesma** `RTCPeerConnection` da voz (§17.5, e
`frontend/src/live/voz.ts` registra o porquê — §15.4 tem um canal de sinalização só, sem
campo que diga a qual negociação um SDP pertence). Voz, câmera e tela viajam num componente
ICE só e numa alocação TURN só; o host vê bytes cifrados e não distingue trilha. Recusar "a
tela" seria recusar a chamada.

O que fica no lugar:

- `TURN_RATE_KBPS` e `TURN_SESSION_MAX_BYTES` passam a ser declaradamente sobre o **bundle**.
  Eles sempre foram o que de fato limitava.
- O **renderer** recusa promover a trilha de tela quando o par selecionado é relayado (lido
  do `RTCStatsReport`: `candidate-pair` nomeado, com candidato local ou remoto do tipo
  `relay`). É **conselho declarado**, na distinção que §17.4 já faz em `T-40`, não
  enforcement: um cliente modificado empurra assim mesmo, e quem o limita é o teto de taxa.
- A recusa é só da tela. Quem está atrás de NAT simétrico continua falando e sendo visto
  pela câmera; o que ele não faz é transformar o upload de quem hospeda em servidor de vídeo.

**`REQUIRES POC` — G7/G8 (POC-V1).** O que precisa ser provado antes de implementar:
demultiplexação STUN/UDX numa socket compartilhada; taxa de conexão direta por classe de
NAT (full-cone, port-restricted, symmetric, CGNAT); latência e perda no caminho TURN; custo
de CPU e banda do host. Critérios e consequências em
`plano-de-validacao-experimental-v2.md`.

#### Emenda de 2026-09-05 — o que a redação do demux e dos controles não dizia

Quatro regras que RFC 5389/5766 exigem, que o produto violava, e que o texto desta seção não
tinha como arbitrar porque era silencioso sobre as quatro.

**1. O demux de ChannelData é por Length, não pelo primeiro byte.** A abertura da seção
declara a regra de STUN ("os dois primeiros bits `00` e o magic cookie; o resto é UDX") e
**não menciona ChannelData**, que ocupa `01` no primeiro byte e portanto cairia no UDX pela
regra bruta. O produto o roteava ao TURN antes do fallback — decisão certa, validada em G7 —
classificando por `0x40 ≤ primeiro byte ≤ 0x7F` e mais nada. Um quarto dos datagramas UDX
cai nessa faixa por acaso: o demux os dava por consumidos pelo TURN e o UDX nunca os via.
~25 % de perda artificial em toda replicação, sincronização e descoberta da comunidade,
indistinguível de rede ruim.

A regra normativa passa a ser a de RFC 5766 §11.4: **é ChannelData quando o primeiro byte
está em `0x40–0x7F` E o campo Length casa com o datagrama** — `length(UDP) − 4`, admitido o
padding a múltiplo de quatro (opcional sobre UDP, até 3 bytes). Qualquer outra coisa é UDX e
segue para a pilha do transporte.

**2. `CHANNEL-NUMBER` é `0x000C`.** O produto o lia do tipo `0x0006` sob o comentário de que
"CHANNEL-NUMBER compartilha o tipo com USERNAME, o contexto é o método". Não compartilha:
`0x0006` **é** o USERNAME (RFC 5389 §15.3) e `CHANNEL-NUMBER` é `0x000C` (RFC 5766 §14.1).
Todo `ChannelBind` de cliente WebRTC real voltava **400 Bad Request**, e o relay só
funcionava pelo caminho de indicações Send/Data, com o overhead de 36 bytes por pacote que o
ChannelData existe para eliminar.

**3. Nada é lido depois do `MESSAGE-INTEGRITY`.** RFC 5389 §15.4: com a exceção de
`FINGERPRINT` (§15.5), nenhum atributo pode sucedê-lo, e o que suceder deve ser ignorado. O
produto verificava o HMAC "onde quer que o atributo esteja" e continuava decodificando até o
fim do corpo: um intermediário anexava atributos à cauda de um pedido legitimamente assinado
— um `XOR-PEER-ADDRESS` forjado, por exemplo —, corrigia o comprimento do cabeçalho externo
(que não entra no MAC, porque o cálculo o reescreve para terminar no próprio MI) e a
mensagem passava adulterada. **O MAC prova a mensagem, não um prefixo dela:** a verificação
recusa quando o MI não é o último atributo, e o decodificador para nele.

**4. A permissão de §9 tem prazo, e a revogação de §17.4 derruba a alocação.** A tabela de
controles acima nomeia a vida da **alocação** e é silenciosa sobre a vida da **permissão** e
sobre o que a revogação faz com o que já foi concedido. As duas lacunas se somavam no mesmo
buraco: `CreatePermission`/`ChannelBind` conferem o roster vivo, mas os dois caminhos que
**não autenticam** — o `ChannelData` de saída e a entrada pela porta relayada — consultavam
apenas o conjunto de permissões concedidas, que nunca era podado. Um membro banido seguia
mandando e recebendo mídia relayada, na cota dele e na banda de quem hospeda, até a alocação
vencer sozinha.

| Regra | Prazo |
|---|---|
| Vida de uma permissão | `TURN_PERMISSION_LIFETIME_MS` = **5 min** (RFC 5766 §9), renovada por cada `CreatePermission`/`ChannelBind` que a reafirme. Vencida, o IP volta a ser negado nos dois sentidos e os canais que apontavam para ele caem junto |
| Revogação (§17.4) | **Imediata.** O mesmo `voice.revoked` que fecha a sinalização fecha a alocação TURN do alvo e a socket relayada dela |
| Varredura (`media.sweep`, §22.1) | Rede de segurança a cada 30 s: fecha alocação vencida e alocação de quem já não está no roster da sessão |

A varredura **não é opcional**, e não tê-la agendada era o outro defeito: `MediaServer.sweep`
existia desde a fase 7 sem nenhum chamador em produto. Cada alocação vencida vazava a socket
relayada até o processo morrer e, pior, o registro morto fazia o `Allocate` seguinte **do
mesmo 5-tuple** responder 437 Allocation Mismatch para sempre — um `Refresh` perdido depois
do vencimento matava o caminho relayado até o host reiniciar. **Registro vencido não é
conflito:** ele é recolhido e o pedido novo é atendido.

**LIMITAÇÃO DECLARADA (L-11):** se o host estiver atrás de CGNAT sem porta alcançável, o
serviço STUN/TURN dele não funciona para quem precisa dele. Nesse caso a voz depende dos
voluntários de relay (§17.7); sem voluntário, a conexão falha com `conn-failed`, que é um
estado desenhado. Não há TURN de terceiro e não haverá.


#### Emenda de 2026-08-30 — a L-11 são DUAS falhas, e só uma delas é sobre o host (§99)

A redação acima trata "host atrás de CGNAT" como a causa da chamada entre operadoras não
fechar. A investigação de §99 separou o que estava somado. **São duas falhas independentes,
com causas, culpados e saídas diferentes**, e confundi-las é o que fez §80 concluir que o
TURN do host "não resolve a L-11" — conclusão certa para uma das duas e errada para a outra.

| | **(a) O serviço do host é inalcançável** | **(b) Os dois membros não se furam** |
|---|---|---|
| Quem está atrás do NAT ruim | **O host** | **Um membro** (ou os dois) |
| O que falha | O Binding Request chega não solicitado à socket do host e o NAT dele descarta | Os dois têm `srflx`, e o mapeamento de pelo menos um é **dependente do destino**: o endereço que o STUN devolveu não vale para o par |
| Sintoma no ICE | **Nenhum `srflx`** — só `host` | **`srflx` dos dois lados**, nenhum par de candidatos válido |
| STUN de terceiro resolve? | **Sim.** É exatamente para isto que §17.2 o ligou | **Não.** Um STUN a mais devolve o mesmo endereço inútil |
| TURN do host resolve? | **Não** — o Allocate chega tão não solicitado quanto o Binding | **Sim, e é a única saída.** O host alcançável relaya, e o NAT do membro deixa passar porque foi ELE quem abriu o fluxo |

**A consequência que estava escondida.** §81.2 registrou "o TURN do host não resolvia a
L-11" e o produto tirou daí o default `P2P_TURN_ANNOUNCE=0`. A frase é verdadeira para (a) e
**falsa para (b)** — e (b) é o caso mais comum no Brasil, porque é o caso de quem chama pelo
celular ou por operadora com CGNAT simétrico enquanto quem hospeda está numa conexão fixa
alcançável. Hoje, nesse cenário, o produto tem um TURN funcional, autorizado e com credencial
costurada, **e não o anuncia**. A chamada falha por política, não por rede.

Isto **não** vira "ligar o anúncio por default" aqui: o caminho relayado continua sem medida
em rede real (`B4`), e §17.3 já declara que anunciar o não medido foi o que quebrou chamada
em 2026-08-28. O que a emenda declara é que o default é uma escolha **por falta de medida**,
não uma consequência da L-11 — e que a medida de `B4` deve reportar (a) e (b) separadamente.

#### Emenda de 2026-08-30 — a ordem de `iceServers` não é garantia de privacidade (§99)

§17.2 apoiou a emenda de 2026-08-25 em três guardas. **A primeira é falsa** e precisa cair:

> "O STUN do host vem primeiro. O ICE tenta em ordem; quando o do host resolve, o de terceiro
> não é consultado e o IP não sai da comunidade."

Nenhuma das duas metades se sustenta. O ICE **não tenta em ordem**, e a lista **não é uma
lista** quando chega ao agente:

- RFC 8445 §5.1.1.2: *"The agent pairs each host candidate with the STUN or TURN servers with
  which it is configured or has discovered by some means."* Cada servidor configurado é
  pareado com cada candidato de host — não há "o primeiro que resolver".
- No libwebrtc, que é o agente do Chromium e portanto o deste produto,
  `UDPPort::SendStunBindingRequests()` percorre `server_addresses_` e manda um Binding para
  **cada** entrada. E `ServerAddresses` é `std::set<rtc::SocketAddress>`: a ordem do array
  `iceServers` é descartada na entrada, não apenas ignorada na saída.

**O que isso muda, e o que não muda.** Não muda o código: a ordem continua onde está, porque
um servidor mais próximo responde antes e o par correspondente é testado antes. Muda a
**declaração**: com um STUN de terceiro configurado, ele vê o IP de quem entra em chamada
**sempre** — inclusive nas chamadas em que o host responde. O terceiro deixa de ser "a saída
da L-11" e passa a ser parte do caminho normal, e é assim que §25.4 deve avaliá-lo.

As guardas 2 (`P2P_STUN_SERVERS=""` desliga) e 3 (só `stun:` passa no parser) continuam
válidas e verificadas por teste. **A guarda 1 foi reimplementada em vez de removida** — a
propriedade que ela prometia é boa, o mecanismo é que não era. Ver a emenda de §99.13 logo
abaixo; `B50` fecha com ela.

#### Emenda de 2026-08-30 — a coleta em duas fases (§99.13, fecha `B50` e `B53`)

A garantia que a ordem não dava, a fase dá:

| Fase | O que vai ao `RTCPeerConnection` | Quando termina |
|---|---|---|
| **1** | Só as entradas **sem** `terceiro: true` | Um `srflx` (ou `relay`) apareceu → **fim, e o terceiro nunca foi consultado**; ou vencem `PRAZO_DA_FASE_UM_MS` (2,5 s) |
| **2** | A lista inteira, por `setConfiguration` + `restartIce` | Comportamento de sempre |

Três decisões que a emenda toma e o porquê de cada uma:

1. **A fase 1 é pulada quando o host não contribui com nada.** Sob L-11 pura (`doHost`
   vazio) não há o que tentar primeiro, e cobrar 2,5 s de quem está exatamente no caso que
   o terceiro existe para socorrer seria taxa sem contrapartida.
2. **O sinal de sucesso é `srflx`, não `host`.** `host` existe sempre e não prova que
   servidor nenhum respondeu; `srflx` **é** a resposta do STUN.
3. **A renovação de credencial não desfaz a fase.** `voice.tickets` traz a lista inteira a
   cada `MEDIA_TICKET_TTL_MS/3` (§15.5); aplicá-la crua entregaria o terceiro ao agente
   antes de o host ter falhado. A renovação atualiza a lista guardada e aplica só a fase
   corrente.

`setConfiguration` sozinho não coleta: a lista nova vale *"for any future renegotiation,
such as while handling an ICE restart"* (WebRTC 1.0). Por isso a escalada leva `restartIce`
junto, e a oferta sai do lado iniciador — os dois reofertando é o *glare* que §17.4 evita.

**O campo `terceiro` no `IceServer`.** Aditivo e opcional. §15.4 e §16.3 declaram
`iceServers[]` sem enumerar os campos de uma entrada, e uma propriedade a mais num
`RTCIceServer` é ignorada pelo WebIDL — o renderer repassa a lista ao `RTCPeerConnection`
sem filtrar. Ele existe porque **dois** consumidores precisam da resposta e nenhum pode
inferi-la: a fase 1, e o aviso de §17.2 (que, adivinhando por posição, ficava calado
justamente sob L-11 — §99.3).

#### Emenda de 2026-08-30 — o diagnóstico nomeia a causa, e IPv6 entra nele (§99)

A mitigação declarada da L-11 na tabela de §25.5 é *"Diagnóstico de rede + estado
`conn-failed`"*. O diagnóstico existia com **um** teste — "todos os candidatos são `host`" —
e mandava todo o resto para uma frase genérica. Isso somava (a) e (b) da tabela acima na
mesma tela, e é a razão de a investigação de §80 não ter conseguido separá-las.

O renderer passa a derivar um **motivo nomeado** do que o ICE efetivamente coletou:

| Código | O que o ICE viu | O que significa |
|---|---|---|
| `sem-candidatos` | nenhum candidato | UDP bloqueado na saída, ou sem rede. Não é L-11 |
| `sem-endereco-publico` | só `host`, sem IPv6 | **(a)** — nenhum STUN respondeu |
| `so-ipv6-local` | só `host`, com IPv6 presente | Esta ponta tem endereço roteável; quem não tem é a outra |
| `furo-falhou` | `srflx`, sem `turn:` anunciado | **(b)** — mapeamento por destino; precisa de relay, e não há |
| `turn-nao-alocou` | `srflx`, `turn:` anunciado, sem `relay` | **(b)** com relay anunciado que não abriu |
| `relay-falhou` | `relay` coletado e sem conexão | O relay respondeu e os dados não atravessaram |

**IPv6 entra no diagnóstico porque é a única travessia de CGNAT que não custa servidor
nenhum.** Um endereço IPv6 é roteável fim a fim: não há tradução, não há mapeamento a
descobrir, e o par `host`↔`host` fecha direto — a L-11 simplesmente não se aplica. O Brasil
passou de 50% de adoção de IPv6 em 2024 (NIC.br/Internet Society), e Vivo, Claro, TIM, Oi e
Algar têm IPv6 em produção. O `RTCPeerConnection` já coleta candidatos IPv6 por conta
própria quando a máquina tem endereço global — o que faltava era o log **dizer** se coletou.

**O que este produto NÃO faz em IPv6, declarado (`B51`).** O serviço STUN/TURN do host é
IPv4-only por construção: `xorAddress` escreve família `0x01` fixa, o decodificador recusa
`0x02`, o parser de endereço faz `split('.')`, e a socket relayada de `relayPort.ts` abre
como `udp4`. A origem da restrição é anterior ao módulo — o endereço público vem de
`dht.host`/`dht.port` do `hyperdht`, que é IPv4 —, então servir STUN em IPv6 não é uma
correção neste arquivo. Fica declarado: **um par IPv6↔IPv6 fecha sem nada disto**; o que não
existe é o host **servindo** STUN/TURN em IPv6.

#### Emenda de 2026-08-30 — o prazo de `conn-failed` não pode vencer antes da coleta (§99)

`PRAZO_DE_CONEXAO_MS` são 20 s, e contra um TURN que não responde o Chromium leva perto de um
minuto e meio de retransmissões antes de desistir do `TurnPort`. Com `turn:` anunciado, o
produto declarava `conn-failed` **antes** de o candidato `relay` ter tido chance de existir —
o que tornaria a medida de `B4` impossível de fazer honestamente: ela mediria o relógio, não
o relay. O prazo passa a esticar **uma vez** (`PRAZO_EXTRA_COM_TURN_MS`, 45 s) quando há
`turn:` na lista, nenhum `relay` coletado e alguma coleta ainda em andamento. Sem `turn:`
anunciado nada muda: a L-11 continua falhando em 20 s, que é o comportamento de §80.

### 17.4 Autorização de sessão de mídia — tickets

Fecha `T-15`, `T-32`, `T-41`, `DS-15` (na parte de autorização) e `T-40` (declarando o que
é enforcement e o que é conselho).

```
1. voice.join → o host valida voice_speak, canal de voz, comunidade não ended,
   membro ativo não banido nem em timeout
2. o host emite, para cada par do roster, um ticket:
      ticket = Ed25519(hostKey, BLAKE2b('media-ticket/1' ‖ sessionId ‖ channelId
                                        ‖ peerA ‖ peerB ‖ expiresAt))
   com expiresAt = now + MEDIA_TICKET_TTL_MS (default 5 min, renovado por voiceTicket)
3. o cliente SÓ aceita sinalização (SDP/ICE) de um par que apresente ticket válido
   para (sessionId, esteParDeChaves). Sem ticket → E_TICKET_INVALID, conexão recusada
4. o cliente SÓ inicia DTLS com pares que passaram (3)
```

**Revogação:** `mod.ban`, `mod.kick`, `mod.timeout`, `channel.delete`, `voice.leave` e
**a queda da conexão do participante** fazem o host emitir
`voice.revoked{targetKey, sessionId}` a todos os participantes. Ao receber, **cada cliente é
obrigado a fechar imediatamente** a `RTCPeerConnection` com aquela chave e a parar de
renovar o ticket. O ticket expirado deixa de ser renovado, então mesmo um cliente que ignore
o evento perde a sessão em ≤ `MEDIA_TICKET_TTL_MS`.

**Emenda de 2026-08-26 — queda de conexão é saída, e a lista não a tinha.** A redação
anterior enumerava cinco gatilhos, e os cinco são **registro no log**. Faltava o único que
não é: o par que simplesmente para de falar. Quem desliga o computador no meio de uma
chamada não appenda nada, não é banido e não chama `voice.leave` — e, pela tabela antiga,
não havia nada que o tirasse da sessão. Ele ficava no roster de quem continuou na chamada
**indefinidamente**: um participante que não fala, não sai e não pode ser removido.

A assimetria era o que tornava o defeito invisível na leitura: o **cliente** já tratava a
queda como fim de sessão (qualquer método de §16.2 que volte `E_HOST_UNAVAILABLE` zera o
estado local da sessão), então quem caiu sabia que tinha saído. Era o **host** que mantinha
o fantasma, e é o host que dita o roster.

O host declara vivo o par de quem recebeu pedido há menos de `VOICE_LIVENESS_MS`. A
evidência não é um sinal novo: é o `hello` de §22.1, que todo membro manda a cada
`P2P_HELLO_INTERVAL_MS` em toda conexão viva, e que §14.5 já usa para decidir `synced` na
direção oposta. `VOICE_LIVENESS_MS` são **três voltas** desse `hello` — tolera uma perdida e
a jitter da rede sem derrubar ninguém de uma chamada em que ainda está —, e por isso é
derivado dele, e não uma segunda constante que envelheceria em separado.

São dois caminhos, e os dois precisam existir:

| Caminho | Quando | Prazo |
|---|---|---|
| Fechamento do canal de §16.1 | O transporte percebeu a queda | Imediato |
| Loop `voice.liveness` (§22.1) | O transporte **não** percebeu — máquina desligada não manda FIN | ≤ `VOICE_LIVENESS_MS` |

**A revogação vai a quem FICA, não só a quem sai.** A frase "a todos os participantes"
sempre esteve aqui e é o ponto inteiro do mecanismo: quem tem de fechar a
`RTCPeerConnection` com a chave revogada é quem continua na chamada — o alvo fechar a
própria conexão não retira mídia de ninguém. Uma revogação entregue só ao alvo deixa a malha
dos outros aberta com quem acabou de ser banido, que é exatamente o `T-32` que esta seção
diz fechar. Os destinatários são os participantes da sessão **no instante da remoção**,
alvo incluído.

**Toda revogação carrega motivo** — `left`, `peer-gone`, `moderation`, `channel-deleted`,
`community-ended`. É o que permite a §19.8 nomear o encerramento (`voice.failed{reason}`) em
vez de a chamada apenas esvaziar, e o que distingue na UI "fulano saiu" de "fulano caiu".

**A mesma assimetria vale do outro lado, e é do nó que a corrige.** Quando é o **host** que
some, nenhuma revogação chega — não há quem a emita. O membro descobre pelo primeiro método
de §16.2 que volta `E_HOST_UNAVAILABLE`, e nesse instante a sessão local deixa de existir
para ele: sem host não há roster, não há renovação de ticket e não há sinalização. Isso já
era verdade e acontecia **em silêncio**, o que reproduzia o defeito do fantasma dentro de
uma instalação só — o núcleo fora da chamada e o renderer ainda dentro dela.

O nó emite `voice.failed{reason:'host-unavailable'}` no instante em que esquece a sessão.
Vale só para o silêncio do host: `E_SESSION_GONE` é o host **respondendo** que a sessão
acabou, e esse caminho já tem sinal próprio na revogação — anunciar duas vezes o mesmo
encerramento faz duas superfícies competirem pela mesma tela.

**Emenda de 2026-09-05 — quem detecta a queda renegocia, iniciador ou não.**

A regra anti-glare ("quem oferta é um lado só") vale para a **oferta inicial**, e o produto a
estendeu à **reconstrução de ICE** de um par que caiu. As duas não são o mesmo caso. Uma
queda de rede é frequentemente assimétrica — só uma das pontas vê `failed` —, e
`restartIce()` não manda nada pela rede: ele marca a conexão para gerar credenciais ICE novas
na *próxima oferta*. O lado respondedor que detectasse a queda marcava e ficava calado; três
voltas da graça de `disconnected` depois, o teto de tentativas desistia e a conexão morria
sem que uma única oferta tivesse saído.

**Na reconstrução, oferta quem detectou.** Isso não reabre o glare: a colisão de ofertas de
**renegociação** já tem desempate declarado — quem iniciaria ignora a oferta cruzada, o outro
desfaz a própria (`rollback`), responde e reoferta quando assentar. A regra determinística é
a mesma; ela passa a ser aplicada onde a colisão se **resolve**, em vez de onde ela se evita.

Vale o mesmo para o outro ponto em que a malha reabre uma conexão fora do roster: um sinal
que chega de um par autorizado que não está mais na lista de conexões (candidato trickle
atrasado, roster que oscilou) reabre a conexão **com o papel que `souOIniciador` dá**, nunca
como respondedor por default. Nascendo respondedor, o lado que deveria ofertar não cria os
m-lines reservados de §17.2, e a repetição de oferta sai sem m-line nenhum: o ICE conecta, o
tile fica verde e a chamada é muda para sempre naquele par.

**Emenda de 2026-09-03 (B43) — a reentrada automática está decidida.** No resync de
epoch de §15.2(4d) com chamada de voz ativa, o renderer reexecuta o `voice.join`
idempotente (nova sessão) — decisão do operador "voltar sozinho". Se o re-join falhar
(canal excluído, sem permissão, host inalcançável), vira `failed` com o motivo, e o
"Tentar novamente" continua valendo. O que continua sem decisão é a volta do canal de
§16.1 quando é o transporte que cai sem respawn do núcleo: sem epoch não há resync, e
a reconstrução de ICE de `live/voz.ts` segue sendo o caminho.

**Emenda de 2026-08-26 — a oferta que chega antes do ticket, e a repetição que a salva.**
Os passos 2 a 4 descrevem o estado final e não descrevem a **entrada**, que tem uma corrida
que nenhuma das duas pontas evita sozinha. Os tickets de um par só existem depois que os
DOIS estão no roster, e cada lado busca os seus por conta própria. Quem já tinha ticket —
quem estava na chamada primeiro, ou quem hospeda — oferta no instante em que vê o roster
novo; quem acabou de entrar ainda está buscando os seus, e o núcleo dele, que falha fechada
pelo passo 3, **descarta a oferta em silêncio**.

Descartada, ela não voltava: pela regra anti-glare quem oferta é um lado só, e ele já
ofertou. Os dois ficavam parados até o prazo de L-11 anunciar `conn-failed` — o defeito do
smoke de duas máquinas, em que um lado registrava `oferta enviada` e o outro,
`SEM TICKET`, no mesmo fôlego.

**O iniciador repete a oferta enquanto não houver resposta**, na cadência de segundos, e
**reenvia com ela os candidatos ICE que já coletou** — trickle manda cada candidato uma vez
e a coleta não recomeça, então uma oferta refeita sem eles seria respondida sem endereço
nenhum para testar. A repetição para na primeira descrição remota que chegar. Nada disso é
campo novo no fio: é `voice.signal` de novo, com o mesmo ticket.

Do lado que recusa, a recusa continua fechada — o quadro morre no núcleo —, mas ela é
**sintoma nomeado**: sinalização sem ticket válido para um par da sessão corrente puxa a
renovação de ticket na hora (com piso de tempo, porque o gatilho vem da rede), para que a
repetição seguinte encontre autorização em vez do mesmo silêncio.

**Isso é o que faz ban alcançar mídia** (`T-32`): em v1 a sessão direta sobrevivia ao ban
indefinidamente; em v2 ela morre por revogação ativa e, no pior caso, por expiração de
ticket em 5 minutos.

**LIMITAÇÃO DECLARADA (L-12) — `voice_mute_others`:** silenciar outro participante é
**conselho ao cliente do alvo**, não enforcement de mídia: quem controla o microfone é
quem o possui. O que é enforcement é a **remoção do roster e a revogação de ticket**. A UI
precisa distinguir "silenciado nesta chamada" (reversível, cooperativo) de "removido da
chamada" (efetivo). Delta U-08.

**Emenda de 2026-09-03 — microfone ausente não é saída: é somente-escuta.** Quem
controla o microfone é quem o possui (L-12) — e quando não há microfone a possuir, a
chamada segue sem ele. Sem microfone não há o que transmitir, e o m-line 0 vazio é lido
do outro lado como silêncio honesto — nunca como saída. Três regras:

1. **Entrar sem microfone ENTRA.** Se a captura falha depois do `voice.join` aceito
   (dispositivo sumido, permissão negada), o nó fica no roster em somente-escuta, com o
   motivo nomeado localmente no vocabulário de `RT-10` (`NotAllowedError`,
   `NotFoundError`/`OverconstrainedError`, `NotReadableError`). O `leave` automático
   desse caminho era a expulsão de quem estava sem mic.
2. **Perder o microfone no meio da chamada não a encerra.** A trilha dispara `ended`
   sem passar por nada do produto; quem observa é o renderer, que avisa em faixa não
   intrusiva (tom de aviso, nunca de falha) e segue ouvindo. Nada renegocia e nenhum
   evento de §15.5/§16.3 sai — a ausência é fato local, como a câmera que cai. Só o
   `ended` arma o aviso: `mute` é transitório e reagir a ele avisaria a cada soluço do
   dispositivo.
3. **A recuperação é a troca de dispositivo com a chamada de pé.** `trocarMicrofone`
   re-captura e substitui por `replaceTrack`, sem renegociação e sem sessão nova; o
   sucesso limpa o aviso, a falha o nomeia — nos dois casos sem encerrar nada. O
   `muted` do roster NÃO é tocado: marcá-lo faria o host impor mudo — que corta a
   música junto — por um motivo que é local. Numa conversa direta (§31.15) vale o
   mesmo, sem roster a contradizer.

**Captura de tela só depois da autorização (`T-41`):** o `setDisplayMediaRequestHandler` do
main **consulta o núcleo** (`capture.authorize`) e só concede se existir uma sessão
`share.start` autorizada pelo host com `captureToken` válido. A ordem é: `share.start` →
host autoriza → `captureToken` → `getDisplayMedia`. Nunca o contrário.

**Emenda de 2026-08-22 — a renovação de ticket é do núcleo, não do renderer.** §16.2 tinha
`voiceTicket` e §26.2 tinha a cadência (`MEDIA_TICKET_TTL_MS/3`), mas nenhum dono: §15.4 não
tem — e **não deve ter** — comando de renovação. Um renderer que esquecesse o temporizador
perderia a sessão em silêncio, e o prazo é uma invariante da sessão, não uma intenção do
usuário. Enquanto houver sessão de voz, o núcleo renova o ticket de cada par na cadência e
empurra o resultado por `voice.tickets{communityId, sessionId, tickets[]}` (§15.5). O evento
continua obedecendo §15.1 regra 5: se ele se perder, o caminho de reconsulta é `voice.join`
no mesmo canal, que devolve a sessão existente com material fresco.

**Emenda de 2026-08-30 — a credencial TURN se renova no mesmo ciclo dos tickets (§17.3).**
A credencial do `voiceJoin` vencia junto do ticket (`MEDIA_TICKET_TTL_MS`), mas só o ticket
tinham caminho de renovação: chamada que dependia do caminho relayado morria no vencimento —
o `Allocate`/`Refresh` novo voltava 401 e nada reemitia a credencial. O ciclo de renovação
de 2026-08-22 passa a embutir o **`voiceJoin` idempotente** (§21.2), que devolve a sessão
existente com material fresco — é o mesmo caminho de reconsulta que a emenda anterior já
nomeava —, e o evento `voice.tickets` ganha `iceServers` **opcional** com a credencial
recém-costurada (§15.5). Quem aplica é o renderer, por `setConfiguration` nas conexões
vivas: não recria conexão, não renegocia, só alimenta as próximas coletas de candidatos.
Sem TURN anunciado (`P2P_TURN_ANNOUNCE` desligado, §17.3) a lista renovada não muda nada e
o campo pode nem viajar.

**Emenda de 2026-08-22 — o `captureToken` é uma capacidade local, não um segredo de rede.**
Quem o cunha é o núcleo **do apresentador**, no instante em que o host autoriza a sessão, e
quem o verifica é esse mesmo núcleo: `capture.authorize` (§15.7) leva só `{sessionId}` e é
resolvido contra o estado local, sem consultar o host. Por isso a resposta de `shareStart`
em §16.2 continua sendo `{sessionId}` e o token **não trafega**: mandá-lo pela rede seria
expor um segredo que nenhum dos dois lados usa como prova. A propriedade que `T-41` exige
continua inteira, e passa a valer igual nos dois modos: **sem autorização do host não existe
sessão, e sem sessão não existe token**. Em modo host isso já era literalmente verdade — o
processo que cunha é o que verifica; a emenda só estende a mesma regra ao modo membro.

**Emenda de 2026-09-05 — "sem sessão não existe token" é conferido A CADA `capture.authorize`.**
A frase acima é a regra certa e o modo membro não a aplicava: ele conferia o token e o prazo,
e mais nada. O ramo host reconferia a sessão corrente; o membro era mais frouxo do que o host
é consigo mesmo, exatamente ao contrário do que esta emenda estabeleceu. Sair da chamada,
perder o host (`E_HOST_UNAVAILABLE`) ou ser revogado deixava `capture.authorize` respondendo
`allowed: true` pela TTL inteira — para a tela e para o Modo Música, cujo token não era
limpo por caminho nenhum. Duas regras fecham:

1. **`capture.authorize` recusa sem sessão de voz corrente**, nos dois modos, antes de olhar
   token ou prazo. A comparação é com a existência da chamada, não com o `sessionId` do
   argumento: o da tela é o id da `ShareSession`, que não é o da sessão de voz.
2. **Todo caminho que encerra a sessão apaga os dois tokens** — `voice.leave`, a revogação
   recebida do host e o silêncio dele. O prazo do token continua sendo rede de segurança, e
   não o mecanismo.

**Emenda de 2026-08-28 — o modo de fala do canal gateia a TRANSMISSÃO, não a entrada**
(§6.6, R-29). O passo 1 continua valendo como está: `voice_speak` gateia **entrar** na
sessão, e o modo de fala não o substitui nem o relaxa — só **restringe quem pode deixar o
microfone aberto**. O gate é aplicado pelo host no `voiceState`, que passa a validar a
transição `muted: true → false`:

| `speechMode` | Quem pode `voiceState {muted: false}` | Recusa |
|---|---|---|
| `0` (free) | Qualquer participante — comportamento de hoje | — |
| `1` (queue) | Só o **titular do turno** da fila de karaokê (§16.4). Quem entra no canal em modo fila entra **bloqueado** (`muted: true` imposto pelo host, ignorando o pedido do cliente); o turno abre, o turno fecha | `E_PERMISSION_DENIED` |
| `2` (admins) | Só participante com `voice_mute_others` no conjunto efetivo de §9.2 | `E_PERMISSION_DENIED` |

Três propriedades fecham o desenho. **(a) O estado no roster é do host.** `muted` no
`VoiceRoster`/`voiceState` passa a ter dono único quando o modo restringe: o host grava
`muted: true` e recusa o desencontro antes dele virar áudio; o cliente que insistir recebe
`E_PERMISSION_DENIED` e o estado local volta ao do roster (§15.1 regra 5). **(b) A troca de
modo aplica na hora, sem novo evento.** Quando um `channel.update` muda o modo de fala, o
host recalcula o bloqueio de cada participante no próximo `voiceState` — quem estava
falando em modo `free` e vê o canal virar `2 (admins)` sem ter o gate é **silenciado pelo
roster**, não por comando novo; a UI mostra o estado que o roster manda. **(c) O mute do
modo é distinto do mute cooperativo.** O `voiceMute` de §16.2 continua sendo conselho ao
alvo (U-08); o mute do modo de fala é **estado do host**, reversível só pelo gate — quem o
sofre não pode "desmutar" até ter direito (turno próprio, modo mudado). A UI distingue os
dois rótulos: "silenciado" (cooperativo) e "aguardando vez / sem permissão de fala" (modo).

### 17.5 Compartilhamento de tela no v1 — estrela

| Parâmetro | Valor |
|---|---|
| Topologia | **Estrela WebRTC**: o apresentador mantém uma `RTCPeerConnection` por espectador |
| Teto de espectadores | **Não há** (emenda de 2026-08-26, §90). `SHARE_MAX_VIEWERS` = 8 era número de política, não invariante da estrela: o que limita é o **upload de quem apresenta**, e disso cuida a degradação medida abaixo, que lê perda real em vez de contar cabeças. A UI mostra quantos assistem, sem denominador |
| Sessões por canal | **Quantas houver** — uma por apresentador (`E_ALREADY_SHARING` só para a segunda da mesma pessoa) |
| Quem pode assistir | **Participante do canal de voz.** Não existe audiência fora da chamada (fecha `F-18`; a fixture precisa mudar — delta U-12) |
| Qualidade por espectador | **Funciona**: em estrela, cada `RTCRtpSender` tem seu próprio `setParameters({encodings:[{maxBitrate}]})`. `share.setQuality` devolve `{applied:true}`. Fecha `F-08`/`V-13`, que existia porque o repasse opaco tornava o comando inerte |
| Quem comanda o perfil | **O apresentador** (emenda de 2026-08-26). O comando redefine a base da sessão e realinha todos os espectadores |
| Resolução e taxa de quadros | **Do apresentador, e locais**: `applyConstraints` sobre a trilha capturada. Não têm RPC e não passam pelo host |
| Controle do espectador | **Ocultar/mostrar o vídeo recebido** — exibição local, sem efeito sobre a transmissão |
| Perfis | `high` 2500 kbps · `balanced` 1200 · `low` 600 |
| Latência esperada | Sub-segundo, como qualquer WebRTC direto. **Sem os 1–2 s de árvore** — o delta 3 de v1 deixa de ser necessário no v1 |
| Saúde | `share.health` só ao apresentador, com `rttMs`/`lossPct`/`quality` por espectador, obtidos de `RTCStatsReport` no renderer do apresentador |

**Emenda de 2026-08-25 — o laço de saúde tem duas pernas, e só uma estava declarada.**
Esta seção dá `share.setQuality` como **funcionando** e fecha `F-08`/`V-13` com o argumento
de que, em estrela, cada `RTCRtpSender` tem o próprio `maxBitrate`. O argumento é verdadeiro
e a ligação não existia. O papel de `share.setQuality` em §15.4 é **espectador**: quem pede
um perfil é quem assiste, e o efeito mensurável é de quem apresenta. Entre os dois há um
caminho só — o `quality` por espectador que `share.health` carrega —, e §16.3 declarava esse
evento descendo do host ao apresentador sem que nada declarasse **como as amostras sobem**:
`rttMs`/`lossPct` saem do `RTCStatsReport` do apresentador, e nem §15.4 nem §16.2 tinham por
onde. Sem elas o host não consolida nada, `share.health` nunca sai, e o pedido do espectador
morre no registro do host.

`share.report` (§15.4) e `shareReport` (§16.2) são essa perna. O ciclo completo (o passo 1
foi corrigido pela emenda de 2026-08-26 mais abaixo — o papel do comando é do apresentador):

```
1. o espectador chama share.setQuality → o host registra o perfil pedido
2. o apresentador mede rttMs/lossPct por espectador no RTCStatsReport, a cada 2 s (§17.6)
3. share.report/shareReport levam as amostras ao HOST — nunca a outro par
4. o host consolida, aplica a degradação automática (perda > SHARE_LOSS_DEGRADE_PCT)
   e emite share.health SÓ ao apresentador (RT-08)
5. o apresentador aplica o `quality` de cada espectador no maxBitrate daquele sender
```

Quem mede não decide: a decisão é do host, porque é ele que guarda o perfil corrente de cada
espectador e é ele que tem autoridade sobre a sessão. Só o **apresentador** daquela sessão
relata — aceitar amostra de um espectador deixaria qualquer participante empurrar o perfil
dos outros pelo caminho de sistema (`degradeTo`), que não tem papel no §RPC. Amostra
malformada é **descartada**, nunca recusada: relatar saúde não pode derrubar a transmissão de
ninguém, e a cadência seguinte traz outra medida.

**Emenda de 2026-08-26 — "não existe audiência fora da chamada" é contínuo, não só na
entrada.** A linha "Quem pode assistir: participante do canal de voz" e o A19 ("a sessão de
tela vive dentro da chamada") eram aplicados no `share.start` e no `share.join`, e só ali.
Depois disso ninguém reconferia — e a tela não tinha por que continuar existindo quando a
chamada que a contém deixou de conter quem transmite.

O apresentador que saía da chamada (por `voice.leave` ou por queda de conexão) deixava a
sessão de tela **viva no host para sempre**, com três consequências: os espectadores
continuavam autorizados e com ticket válido para uma transmissão que não existe mais; o
`E_ALREADY_SHARING` trancava o canal — que, à época desta emenda, ainda era "exatamente 1
sessão por canal" (revisto mais abaixo) — para qualquer outro apresentador; e a sessão só
morria por `channel.delete` ou pelo fim da comunidade.

A derivação de encerramento passa a consultar o roster da voz junto com o estado
estrutural, e roda **a cada mudança do roster** além de a cada lote projetado. Apresentador
fora da chamada encerra a sessão; espectador fora da chamada deixa de ser audiência. A
porta que dá o roster ao módulo de tela já existia — o que faltava era consultá-la.

**Emenda de 2026-09-03 — a transmissão de tela leva som, e isto é o corpo de B39.**

Esta seção descrevia a estrela, os perfis e a saúde, e **não dizia se a tela leva som, de onde
ele vem, nem quem pode calá-lo**. O produto o implementava desde §83; o texto nunca o
declarou. Era **B39**, e a assimetria que a tornava incômoda é que o **Modo Música** — a
*mesma* captura de áudio, descrita nesta seção como "efeito colateral do vídeo de tela" —
ganhou tratamento completo na emenda de 2026-08-28. O caso derivado foi declarado; o
originário, não.

**1. A tela leva som, e o som é opt-in.** Ele nasce `false` e é escolhido no mesmo ato de
escolher a fonte. Capturar o som de uma máquina é o tipo de coisa que ninguém deve descobrir
depois.

**2. De onde ele vem, por tipo de fonte:**

| Fonte | Áudio | Por quê |
|---|---|---|
| **Uma janela** | O som **daquela janela** (`windowAudio: "window"`), e explicitamente **não** o do sistema (`systemAudio: "exclude"`) | Compartilhar uma janela não é consentir em transmitir tudo o que toca na máquina |
| **Tela inteira** | O som do sistema (`systemAudio: "include"`) | Não há janela a isolar, e a única leitura coerente de "áudio" aqui é o som da máquina |

**A falha é subir MUDA, nunca cair para o som do sistema.** Onde a plataforma não sabe separar
áudio por janela, a captura sobe sem som. Trocar silenciosamente por "tudo o que toca aqui"
transformaria a escolha da pessoa no seu oposto — é a mesma disciplina de `E_MUSIC_UNSUPPORTED`
na emenda de 2026-08-28, que recusa **nomeadamente** em vez de dar outra coisa.

**Emenda de 2026-09-05 — sob seletor do sistema, o tipo que vale é o CONCEDIDO.** A tabela
acima e a regra do loopback do item 3 do Modo Música (`screen` sim, `window` nunca) são
regras sobre a fonte que a captura de fato usa. Onde a escolha é do
`xdg-desktop-portal` (Wayland), o tipo declarado pelo renderer é uma **intenção**, não o
resultado: a caixa do sistema oferece tela e janela, e a pessoa pode apontar uma janela
depois de o renderer ter declarado `screen`. Nesse caminho:

1. **O áudio é decidido pelo tipo da fonte concedida**, lido dela mesma — nunca pelo tipo
   declarado. Declarar `screen`, receber uma janela do portal e conceder `loopback` entrega o
   som da máquina inteira a quem escolheu compartilhar uma janela, que é a captura a mais que
   esta seção proíbe. Quando o pedido de som não sobrevive à troca de tipo, a captura sobe
   **muda** — a imagem escolhida continua valendo (§114).
2. **`sourceTypes` de `capture.decision` é reconferido contra o tipo concedido.** A primeira
   conferência, contra o declarado, acontece antes de enumerar; a segunda existe para que o
   portal não entregue um tipo que o núcleo não autorizou.
3. **A discrepância não invalida a concessão de vídeo por si só.** A escolha da pessoa na
   caixa do sistema é a escolha, e recusá-la por não casar com a declaração feita antes de a
   caixa abrir seria transformar o seletor do sistema em erro. O que se ajusta é o som.

Fora do seletor do sistema (Windows, Linux/X11) declarado e concedido são o mesmo valor por
construção — o `sourceId` é casado contra a lista viva — e nada disto muda.

**E, onde o seletor é do produto, `window` sem `sourceId` é recusa.** "A primeira fonte do
tipo" é resposta legítima para tela (a primária) e para o Modo Música; para janela não é
resposta nenhuma — a primeira que o sistema lista é tipicamente a janela **deste** app, e
conceder uma janela que ninguém apontou é o defeito que o `sourceId` desta seção existe para
fechar. Falha fechada, como todos os outros ramos do handler.

**3. Quem autoriza.** O núcleo, por `capture.authorize{audio}` (§15.7, emenda de 2026-09-03),
contra `voice_share_screen` — **a mesma permissão da tela, sem cargo novo**. Um
`voice_share_audio` separado partiria em dois um par que esta seção sempre tratou como uma
coisa só.

**4. Quem pode calá-lo. A resposta difere por superfície, e a diferença é consequência
declarada, não acidente:**

| | Numa comunidade | Numa conversa direta (§31.15) |
|---|---|---|
| Quem escuta | Ensurdecer (§9, 2.3) e o **volume por participante**, que vale para o som da tela daquele par como vale para a voz dele | Só o volume geral da máquina (§10, 3.1). Ensurdecer e volume por participante **não existem** — são superfície de uma chamada com mais de duas pessoas |
| Quem apresenta | Não ouve a própria tela: o `<video>` local é mudo, ou seria eco | Idem |
| Moderação | **Nenhum verbo novo.** Quem quer calar a tela de alguém encerra a sessão, e esse verbo já existe. Um "silenciar o som da tela dele" seria mecanismo que nada aqui pede | Não há moderação (§31.15) |

**A ausência de volume por participante numa DM é a metade de B39 que sobra**, e ela é
consequência de §31.15, não escolha desta emenda: numa dupla o único controle é o volume
geral. Se isso se mostrar insuficiente em uso, é decisão de produto — não lacuna de texto.

**Emenda de 2026-09-03 — o m-line reservado, e o que ele NÃO muda aqui.**

A imagem da tela vai no m-line 2 e o som dela no m-line 3, fixados em §17.2. Nesta seção isso
muda **uma** coisa e é bom dizer o que não muda:

- **Muda:** quem recebe sabe que aquilo é a tela pela posição, e não por cruzar `msid` com o
  `share.join` que conseguiu. Começar e parar a transmissão deixa de renegociar.
- **NÃO muda a autorização.** A audiência continua sendo quem o host listou: o apresentador
  põe a trilha no m-line reservado **da conexão daquele espectador** e deixa as demais em
  `null`. Reservar o m-line em toda conexão da malha não concede audiência a ninguém —
  `share.join` e a reconferência contínua da emenda de 2026-08-26 seguem valendo inteiros.
  (A frase original dizia "`share.join`, **o ticket** e a reconferência". Sobre o ticket ela
  era falsa; ver a emenda de 2026-09-05 abaixo.)

**Emenda de 2026-09-05 — o que o ticket de tela é, dito honestamente.**

`share.join` cunhava um ticket Ed25519 por espectador, apresentado em código como "a
autorização A22 passos 3–4", e **o descartava**: nem o RPC nem o dispatcher local o
devolviam, nenhum verificador o consumia. §16.2 não tem campo em que ele viaje, e nem
precisaria ter — a tela reusa a **mesma** `RTCPeerConnection` da voz (§17.2/§17.3), que já
está gateada pelo ticket de §17.4. Não havia furo de segurança: havia uma assinatura por
join paga a troco de nada, e um comentário que prometia cobertura criptográfica onde não há.

Fica declarado o que sempre foi verdade:

| | Quem faz o quê |
|---|---|
| **Autorização de transporte** | O ticket de §17.4 da conexão de voz. É ele que decide se DTLS começa com aquele par |
| **Autorização de audiência** | A lista do host, **reconferida a cada mudança de roster** (emenda de 2026-08-26). É ela que decide em qual conexão a trilha entra no m-line 2 |
| **`ticketId` de `share.join`** | Um **identificador opaco** da relação (sessão, espectador, apresentador). Não é capacidade e não autoriza nada |

O `ticketId` passa a ser **derivado da assinatura** (`ticketIdOf`, como em §17.4) em vez de
`randomBytes`: a assinatura Ed25519 é determinística sobre `(sessionId, channelId, par
ordenado, expiresAt)`, então o id é estável entre re-joins do mesmo espectador e os dois
lados chegam nele sozinhos. Era a divergência com a voz que fazia o ciclo de vida do ticket
de tela parecer inconsistente — e ela some sem inventar mecanismo nenhum.

**Consequência: não há "renovação de ticket de tela" a especificar.** A pergunta ("por que
não existe `shareTicket` na cadência que `voiceTicket` tem?") pressupunha que o prazo do
ticket de tela governava alguma coisa. Não governa. O que precisa sobreviver a uma
transmissão longa é a **audiência**, e ela é estado vivo do host: enquanto o espectador
estiver na chamada, ele está na lista; quando sai, `share.failed{reason:'revoked'}` o tira.
O prazo que importa continua sendo o do ticket de voz, renovado por §17.4.
- **NÃO muda o laço de saúde.** `share.report`/`share.health`, a consolidação no host e a
  degradação automática continuam como estão: aqui há N espectadores, e é para isso que eles
  existem. (Numa conversa direta N = 1 e o laço sai — §31.15.)

**Emenda de 2026-08-26 — o canal deixa de ter no máximo uma transmissão.** A linha
"exatamente 1 por canal" vinha de `RT-06`, e `RT-06` não era um achado de engenharia: era
uma **contradição entre documentos** — a UX pedia várias (§18, edge case 4), o backend de v1
fixava `Channel ─0..1 ShareSession` e o mock não implementava nenhuma. A resolução escolheu o
que já estava escrito, e A19 herdou a frase sem argumentar por ela. A19 argumenta pela
**estrela**, que é outra coisa. (O teto de 8 que A19 também trazia saiu em §90, pelo mesmo
critério: era número de política, não consequência da topologia.)

Não havia restrição de arquitetura por baixo:

- **O transporte já está pago.** A voz é malha completa (§17.2): existe uma
  `RTCPeerConnection` entre cada par de participantes, e a trilha de tela **pega carona
  nela**. Um segundo apresentador não abre malha nova — acrescenta uma trilha a conexões que
  já estão abertas.
- **O upload não compõe.** Cada apresentador serve a própria estrela, da própria máquina.
  Duas transmissões não somam nada num terceiro nó.
- **Nenhuma das duas tem teto de audiência** (§90). Duas sessões são duas estrelas
  independentes; o que cada uma custa é o upload da máquina que a serve.

O que **custa de verdade** é o lado de quem assiste: download e decodificação multiplicam por
transmissão simultânea. Duas telas em `high` são 5 Mbps de descida e dois decodificadores por
participante. Isso é limite de máquina, não de protocolo, e por ora não tem teto declarado —
está registrado como pendência, e inventar um número aqui seria anunciar medida que ninguém
tomou.

**O que continua valendo é o teto por apresentador:** `E_ALREADY_SHARING` recusa a **segunda
sessão da mesma pessoa no mesmo canal**. Não é regra de protocolo — é o renderer: a captura
de tela de uma instalação é uma só, e a segunda sessão nasceria sem stream para alimentá-la.

**Emenda de 2026-08-26 — o perfil de qualidade passa a ser comando do APRESENTADOR.**
O texto acima dava a `share.setQuality` o papel de espectador ("quem pede um perfil é quem
assiste") e derivava disso o ciclo de cinco passos. O papel estava errado, e o próprio ciclo
mostra por quê: o passo 5 aplica o perfil no `maxBitrate` do sender **do apresentador**. Não
existe "ajustar a própria recepção" em estrela — o que se ajusta é o que sai da máquina de
outra pessoa. Oito espectadores pedindo `high` são 20 Mbps de subida numa máquina que não
tinha como recusar, e a seção reconhece esse custo duas linhas abaixo, em "por que 8 e não
200". Quem paga a conta decide.

É também quem apresenta que **vê o que está transmitindo** e sabe se o caso pede texto
pequeno legível ou movimento fluido; o espectador julga por um vídeo que já chegou
degradado.

O ciclo de §17.5 fica assim:

```
1. o apresentador escolhe o perfil → share.setQuality → o host registra a base da sessão
   e realinha todos os espectadores (é teto novo, não ajuste de um)
2. o apresentador mede rttMs/lossPct por espectador no RTCStatsReport, a cada 2 s (§17.6)
3. share.report/shareReport levam as amostras ao HOST — nunca a outro par
4. o host consolida, aplica a degradação automática (perda > SHARE_LOSS_DEGRADE_PCT)
   e emite share.health SÓ ao apresentador (RT-08)
5. o apresentador aplica o `quality` de cada espectador no maxBitrate daquele sender
```

**O que a mudança de papel NÃO tira.** A degradação automática continua sendo do **sistema**,
continua sendo **por espectador** e continua só descendo (`degradeTo`): é ela que protege quem
assiste numa conexão ruim, e ela nunca precisou de comando de ninguém. Espectador chamando
`share.setQuality` recebe `E_PERMISSION_DENIED`.

**"Só desce" é decisão, e o caminho de volta é o passo 1** (nota de 2026-09-05). O
unidirecional já está escrito acima, mas não estava escrito **como se recupera** — e a
ausência lia-se como esquecimento. Não é: quem sobe é o passo 1 do ciclo, o comando do
apresentador, que "redefine a base da sessão e realinha todos os espectadores". Subir sozinho
exigiria histerese e janela de estabilidade sobre uma perda medida a cada 2 s, e o custo do
erro é assimétrico — descer cedo demais custa nitidez, subir cedo demais devolve à conexão
ruim exatamente a saturação que a degradação acabou de aliviar, e o laço oscila. **Não há
recuperação automática no v1, e não há número a inventar para ela.** A UI do apresentador
mostra o perfil corrente de cada espectador (`share.health`), que é o que torna o realinhe
uma decisão informada em vez de um palpite.

**Resolução e taxa de quadros da captura — do apresentador, e sem host.** São
`applyConstraints` sobre a trilha que a máquina do apresentador captura, da mesma natureza
que `track.enabled` é o mudo efetivo de §17.4 L-12: **quem possui o dispositivo decide o que
sai dele; o host decide quem pode receber.** Não têm RPC, não entram no log e não são
autorizadas por ninguém — não há decisão de host a tomar sobre o que uma pessoa escolhe
capturar da própria tela. A fonte pode aproximar ou ignorar a restrição, então o valor que a
UI exibe vem de `getSettings()` da trilha, nunca do que foi pedido: a promessa é ter pedido,
não ter conseguido.

**O único controle de quem assiste é ocultar o vídeo recebido.** É exibição local: a
`RTCPeerConnection` continua de pé, o apresentador continua transmitindo e nenhum outro
espectador é afetado. Deliberadamente **não** é `share.setQuality` para `low` nem
`share.leave` — os dois alcançariam a transmissão de outra pessoa, e este controle é sobre a
tela de quem o aperta. Delta U-25.

**Emenda de 2026-08-26 — a revogação de UM espectador tinha alvo e não tinha entrega.** A
derivação de §17.5 distingue desde sempre dois desfechos: apresentador inelegível encerra a
sessão inteira, espectador inelegível é revogado sozinho. O segundo não chegava a lugar
nenhum — `share.stopped` fala da sessão inteira e `share.viewersChanged` leva só a contagem,
então quem perdia a autorização de assistir descobria por ausência de quadro. O tópico que
§15.5 declara para isso é `share.failed{sessionId, reason}`, e ele passa a ser emitido **ao
alvo** com `reason:'revoked'` (§16.3, tabela fechada).

**Por que 8 e não 200:** 8 conexões de 2500 kbps são 20 Mbps de upload, que já é mais do
que a maioria das conexões residenciais entrega. O teto real depende de upload medido, e a
UI **degrada a qualidade automaticamente** conforme `share.health` reporta perda, antes de
recusar espectador. O teto de 200 espectadores de v1 dependia da árvore, que está adiada.

**Emenda de 2026-08-28 — Modo Música: a captura de áudio do sistema não é compartilhamento
de tela.** O usuário que canta ou toca música precisa transmitir o **playback** da máquina —
e não o microfone. A captura existe no §17.5 como efeito colateral do vídeo de tela (áudio
de `getDisplayMedia` com `systemAudio: include`, Windows loopback); o Modo Música a usa
**sem tela**:

1. **Autorização sem sessão de tela.** O renderer pede `music.start` (§15.4), que o núcleo
   resolve **localmente**: conferir `voice_share_screen` no conjunto efetivo do próprio
   membro e existir sessão de voz ativa. Não há `share.start`, não há sessão de tela no
   host, não há `share.*` de evento nenhum — o host não fica sabendo que alguém ativou o
   Modo Música, porque nada dele precisa de coordenação. A resposta é um `captureToken`
   **local**, com a mesma natureza do `captureToken` de §17.4 (capacidade local, não
   segredo de rede) e prazo curto.
2. **Concessão pelo main.** Com o token, o renderer chama `getDisplayMedia`; o
   `setDisplayMediaRequestHandler` do main valida o token por `capture.authorize
   {kind: 'music'}` (§15.7) e **concede automaticamente** a tela primária + áudio
   loopback (`audio: 'loopback'`, que o Windows concede e o §17.5 já conhece). Um clique:
   sem seletor. A trilha de **vídeo** é parada no ato; só o áudio segue. Se o loopback não
   estiver disponível, o main **recusa nomeado** e o renderer diz "Modo Música
   indisponível nesta plataforma" — e o mesmo vale quando o núcleo concede a captura mas
   nega o áudio: música muda não é música. Subir captura muda é o desfecho honesto da
   TELA (a imagem vale sem o som, §114); aqui o som é o produto, e usurpar a concessão
   de vídeo sem áudio seria transmitir a promessa de música sem música.
3. **Plataformas — emenda de 2026-09-03 (§119).** Windows: loopback nativo, concedido
   pelo main sem seletor. **Linux: o loopback também existe**, e é o caminho ali também.
   O que a documentação do Electron chama de recurso "only supported on Windows" não tem
   `#if` de plataforma no código: o `'loopback'` devolvido pelo
   `setDisplayMediaRequestHandler` vira o dispositivo de id `"loopback"`, e o Chromium o
   atende no Linux abrindo **o monitor do sink padrão** por dentro (`PulseLoopbackManager`),
   com troca de saída acompanhada durante a sessão. O "indisponível com rótulo honesto"
   passa a valer só onde o loopback de fato não existe (macOS, fora do v1). O loopback é
   sempre o som da MÁQUINA: no Linux ele é concedido para captura de **tela**, nunca de
   **janela** — ali entregaria o sistema inteiro a quem pediu uma janela, que é captura a
   mais do que a pessoa autorizou. Wayland: o portal continua sendo quem escolhe a FONTE
   DE VÍDEO, e por isso o Modo Música ainda passa pela caixa do sistema nessas sessões
   (§119.4); o som não vem do portal, vem do loopback.
4. **Transporte — a trilha entra no lugar do microfone, não ao lado dele.** O `<audio>` por
   par toca a **primeira** trilha de áudio do `MediaStream`; uma segunda trilha num mesmo
   stream não é tocada. Em vez de adicionar trilha (renegociação + receptor novo), o
   renderer **mistura localmente** microfone + áudio do sistema num único
   `MediaStreamAudioDestinationNode` e a trilha resultante **substitui** a do microfone por
   `replaceTrack` — sem renegociação, mesmo slot, mesmos tickets. É por isso que a trilha
   de música **não** herda a recusa de caminho relayado do vídeo de tela: ela viaja no slot
   de voz, que sempre foi permitido em relay.
5. **Mudo em dois níveis (fecha o acoplamento com §17.4).** O mudo **próprio** (botão do
   usuário) vira ganho zero do nó do microfone no grafo de mixagem — a música continua
   saindo. O mute **imposto** (host, modo de fala, fila) continua sendo `track.enabled =
   false` na trilha misturada — corta tudo, música incluída. O roster de §17.4 continua
   dono do segundo; o primeiro é estado local de captura, nunca sobe ao host como "muted".
6. **Processamento.** A trilha de sistema **não** passa por AGC/NS/EC do navegador — o
   grafo a alimenta direto do loopback. O toggle de processamento de voz das configurações
   afeta só o nó do microfone.
7. **Onde não há loopback, a fonte é o monitor de reprodução — último recurso, não o
   caminho de uma plataforma (emenda de 2026-09-03, corrigida em §119).** A redação
   anterior deste item dizia que o Chromium lista a fonte de MONITOR do PulseAudio/PipeWire
   como `audioinput` comum, e apoiava o Modo Música do Linux inteiro nisso. **Isso é
   falso**, e por decisão explícita do Chromium: `AudioManagerPulse` descarta da
   enumeração toda fonte com `monitor_of_sink` válido — "Exclude output monitor (i.e.
   loopback) devices" — justamente para que o som da máquina não seja capturável por trás
   de uma permissão de microfone. O caminho existia, era exercitado por testes de unidade
   com listas sintéticas, e **nunca poderia casar** numa máquina real. O que sobra para o
   `/monitor/i` encontrar é uma fonte que a própria pessoa tenha criado (um
   `module-remap-source`, que não é monitor aos olhos do Pulse e por isso aparece). O
   caminho só entra onde o loopback não existe (o shell diz por `captureSupport`); no
   navegador, a escolha de tela cancelada é resposta, e o monitor não entra para não
   emendar um prompt de microfone no cancelamento. Rótulos vazios não casam: a permissão é
   pedida pelo caminho normal e a lista é relida com nomes. A captura do monitor nasce com
   EC/NS/AGC desligados — o processamento de voz é do mic (item 6). A integração WebRTC não
   muda: o stream do monitor entra no mesmo grafo e sai pelo mesmo `replaceTrack`. Sem
   monitor, o desfecho é o `indisponivel` honesto de sempre — e `ativarMusica` diz se
   misturou de verdade, em vez de acender o ícone sobre uma transmissão que não existe.

### 17.6 Presença, digitando e roster

Fecha `F-13` e `T-28` na parte de arquitetura; a capacidade continua `BENCHMARK REQUIRED`.

| Sinal | Fan-out | Controle |
|---|---|---|
| `presence` | O host agrega e emite **um delta consolidado** a cada `PRESENCE_TICK_MS` (2 s), só para membros com conexão ativa. Não há reemissão por evento individual | TTL 45 s, refresh 15 s; rate limit por autor: 1 publicação / 5 s |
| `typing` | Só para quem chamou `subscribeChannel{channelId, on:true}` — tipicamente as pessoas com aquele canal aberto | TTL 5 s, refresh 3 s; rate limit por autor: 1 / 2 s por canal |
| `voiceOccupancy` | A **todos** os membros conectados, agregado por canal (contagem + até 5 chaves) — é o que alimenta os avatares inline da sidebar | Emitido a cada mudança, coalescido em 1 s, **e como instantâneo na conexão de cada membro** (emenda de 2026-08-26: ocupação é NÍVEL, não sequência; quem abre o aplicativo com uma chamada em curso não viu mudança nenhuma e ficaria vendo a sala vazia até alguém entrar ou sair, já que §15.6 não dá produtor de ocupação a quem não hospeda). **Emenda de 2026-08-26:** a janela é de **borda de ataque** — a primeira mudança sai na hora e as seguintes esperam o fim da janela, quando sai só o último estado daquele canal. Atrasar em um segundo o avatar de quem acabou de entrar trocaria um defeito por outro; e ocupação é **nível**, não sequência, então quem chega no meio da janela só precisa do valor final. A coalescência não existia: o host emitia por mudança de roster, e uma saída em massa — host que volta, ou a varredura de vivacidade de §17.4 pegando vários — virava um evento por participante para toda a comunidade conectada |
| `voiceRoster` | Só a participantes da sessão | A cada mudança. **Emenda de 2026-08-26:** a coluna dizia só "a cada mudança" e não dizia o que **tira** alguém do roster quando ele não avisa que saiu. Participante sem pedido recebido há mais de `VOICE_LIVENESS_MS` (3 × `P2P_HELLO_INTERVAL_MS`) sai da sessão como se tivesse chamado `voice.leave` (§17.4). Sem esse controle o roster era a única entidade efêmera de §6.16 **sem correção por TTL** — presença tem 45 s, digitando tem 5 s, e a chamada não tinha nenhum |
| `shareHealth` | **Só ao apresentador** | 2 s |

**Custo (a medir em G9):** com 340 membros, presença agregada a cada 2 s é ~170
mensagens/s de saída no host no pior caso (todos conectados), contra os ~11 000/s que o
fan-out ingênuo de v1 produziria em rajada. `typing` deixa de ser broadcast de comunidade e
passa a ser broadcast de canal aberto.

**LIMITAÇÃO DECLARADA (L-13):** presença e digitando são **at-most-once**. Perder um
evento efêmero é aceitável e esperado; o TTL corrige em ≤ 45 s. Isso é declarado e não é
defeito de durabilidade (fecha `DS-30`).

### 17.7 Relay voluntário (v2)

O voluntário passa a rodar **um TURN restrito**, não um repasse de bytes de aplicação.
Isso é o que torna "cego" verdadeiro: ele encaminha SRTP que não decifra.

| Regra | Valor |
|---|---|
| Consentimento | Explícito e **persistido** (`local_relay_consent`); sem ele, `E_CONSENT_REQUIRED` |
| Chave de relay | **Derivada da identidade**: `relayPk = keyPairFromSeed(BLAKE2b('ns/relay/1' ‖ identitySeed ‖ communityId)).publicKey`. Não é possível apontar para um terceiro |
| Prova de posse | `relay.volunteer` carrega `Ed25519(identitySk, relayPk)`; o `fold` verifica (R-19). Fecha `T-14` |
| TTL | `expiresAt ≤ hostTs + RELAY_TTL_MS` (default 24 h). Expirado = não listado. Fecha o `relayKey` permanente no log de `F-49` |
| Cota | `RELAY_MAX_BYTES_PER_DAY` (default 5 GiB) e `RELAY_MAX_ALLOCS` (default 4); atingido, o voluntário para de aceitar e emite `relay.stateChanged`. Os dois tetos **não são alternativos** — ver a emenda de 2026-09-05 |
| Seleção | Por menor RTT medido localmente por quem vai usar; o host entra na lista automaticamente se for capaz |
| Superfície de UX | **Nova tela em 3.1 → Rede**, irmã do modal de consentimento de repasse (delta U-13) |
| Confidencialidade | Real: DTLS-SRTP ponta a ponta. O voluntário vê volume e temporização, não conteúdo |

#### Emenda de 2026-09-05 — os dois tetos não são o mesmo estado, e o status não pode mentir

A linha da tabela soma "atingido, o voluntário para de aceitar" para os dois tetos, e o
produto os guardou num campo só, primeiro a chegar. Eles são coisas diferentes:

| | `alloc-limit` | `bytes-quota` |
|---|---|---|
| O que é | Recusa **pontual** do par novo; quem já foi admitido continua servido | Suspensão **da janela**: o voluntário para de aceitar |
| Como sai | Uma alocação termina | A janela de 24 h rola |

Com um campo só, um nó no teto de alocações que estourasse 5 GiB **não registrava** a
violação de volume — a marca de `alloc-limit` já ocupava o campo. Terminada uma alocação, a
marca era limpa e, com ela, a violação que nunca chegou a ser gravada: o nó voltava a
admitir pares acima do teto diário. **O teto de volume tem precedência**, e a marca de
alocação nunca o apaga.

A segunda metade é o que a UI vê. Três pontos mudavam a suspensão e **um** emitia
`relay.stateChanged`: a cura silenciosa na admissão não avisava ninguém, a liberação de uma
alocação limpava a cota sem tocar o estado do voluntário, e a virada da janela limpava a
marca por dentro da leitura do status — que continuava respondendo `suspended`. O mesmo
instantâneo chegava a dizer `status: suspended` com `suspendedReason: null`. **O estado do
voluntário é derivado da cota, e toda transição emite `relay.stateChanged`** — inclusive a
cura, que é a que interessa a quem está olhando a tela esperando voltar a servir.

**LIMITAÇÃO DECLARADA (L-14):** o voluntário observa **metadados** — com quem, quando,
quanto. Isso é inerente a relay e precisa estar no texto de consentimento.

#### Emenda de 2026-08-28 — o que existe, e a lacuna que sobra (`B30`)

`relay.enable`, `relay.disable` e `relay.respondConsent` estavam declaradas em §15.4 e
respondiam `E_UNKNOWN_COMMAND` no produto inteiro: o módulo estava pronto e testado desde a
fase 9, e a composição nunca o injetava. Agora estão ligadas — o consentimento persiste em
`local_relay_consent`, a chave derivada e a prova de posse vão ao log pelos kinds 60/61, e
`DecisionState.relays` passa a ter entradas.

`RelaySubmitPort` virou **assíncrona** junto: §7.4 dá `fila: false` aos dois kinds e §15.4
declara os dois comandos ⏱, então o `seq` da resposta é o que o **host** atribuiu. Uma porta
síncrona só podia devolvê-lo antes de o host entrar na conversa — ou seja, um palpite.

**O que NÃO está fechado, e é lacuna de especificação.** Um voluntário no log ainda não é um
caminho utilizável, porque §17.7 não declara **como o TURN dele é alcançado**:

| Falta | Por quê |
|---|---|
| **Endereço** | §6.14 carrega `relayPublicKey`, `expiresAt` e a posse — nenhum endereço. §16.3 tem tabela fechada de notificações do host, sem tópico de relay. Não há por onde o endereço do voluntário chegar a quem vai usá-lo |
| **Credencial** | O TURN do host usa `turnCredential` derivada de `hostTurnSecret` (§17.3). O voluntário não tem esse segredo, e §17.7 não declara equivalente: `relayPk` é chave **pública**, e não serve de credencial compartilhada |
| **Seleção** | §17.7 diz "por menor RTT medido localmente por quem vai usar" — mas medir RTT pressupõe a lista de candidatos com endereço, que é justamente o que falta |

Registrado como lacuna, não implementado: inventar aqui seria criar superfície de protocolo
que a spec não declara. A **prova** do caminho, quando ele existir, continua dependendo do
CGNAT real de `B4`.


#### Proposta de 2026-08-30 — o TURN alcançado pela conexão que JÁ atravessa (§99, `B52`)

**Não implementada. É proposta de protocolo e a decisão é do operador.** Registrada aqui
porque as três lacunas que a emenda acima declara (endereço, credencial, seleção) têm uma
causa comum, e uma causa comum admite uma resposta só.

**A observação que a origina.** §80 mediu, e §17.1 já explicava: a replicação atravessa entre
operadoras e a mídia não. A diferença nunca foi o NAT — é que o `hyperdht` faz hole punching
**coordenado** (os dois lados enviam ao mesmo tempo, o mapeamento nasce dos dois lados),
enquanto o Binding Request do WebRTC chega **não solicitado**, de uma socket diferente. Ou
seja: **o produto já tem, entre cada membro e o host, um canal autenticado que atravessa
NAT, CGNAT e a L-11 inteira.** É por ele que passa toda a sinalização de voz. O que §17.3
faz é ignorá-lo e pedir ao renderer que abra um caminho novo, do zero, pela via que não
funciona.

**A proposta.** O núcleo local expõe um TURN em `127.0.0.1:<porta efêmera>` e o anuncia em
`iceServers`. O `RTCPeerConnection` aloca nele — em loopback, onde não há NAT, filtro nem
prazo. O núcleo local **encapsula o Allocate e os ChannelData na conexão UDX que já mantém
com o host** e o host aloca a porta relayada de verdade. O caminho fica:

```
renderer ──loopback── núcleo local ──UDX autenticado (já atravessa)── host ──porta relayada── par
```

O que cada lacuna de `B30` vira:

| Lacuna | Hoje | Com a proposta |
|---|---|---|
| **Endereço** | §6.14 não carrega nenhum, e §16.3 tem tabela fechada sem tópico de relay | **Deixa de existir.** O endereço é `127.0.0.1`; quem se alcança pela chave pública na DHT é o núcleo, que é como tudo neste produto já se alcança |
| **Credencial** | `hostTurnSecret` não é compartilhável com o voluntário | **Deixa de existir.** A conexão UDX é autenticada por Noise/Ed25519 antes do primeiro byte; a `turnCredential` de §17.3 vira redundante nesse trecho |
| **Seleção por menor RTT** | Pressupõe a lista de candidatos com endereço | **Já é medível.** O RTT da conexão UDX com cada voluntário existe e é observado |

E, de quebra, resolve o que a emenda de 2026-08-28 chama de "o endereço relayado sai de uma
socket NOVA cujo mapeamento o host não conhece": não sai. A socket nova é do host, do lado
do host, e quem precisa alcançá-la é o **par**, não este membro.

**O que a proposta custa, declarado antes de alguém decidi-la:**

1. **Um salto a mais em toda mídia relayada** — loopback e uma travessia de processo. Não é
   grátis e não foi medido.
2. **O núcleo passa a encaminhar bytes de mídia.** §17.2 diz "o núcleo nunca vê mídia". Com
   isto ele vê **ciphertext**: DTLS-SRTP é negociado entre os pares e o núcleo não tem as
   chaves — a mesma propriedade que §17.7 já reivindica para o voluntário ("ele encaminha
   SRTP que não decifra"). Ainda assim é uma frase de §17.2 que muda de sentido, e mudá-la
   é do operador.
3. **Um TURN em `127.0.0.1` é alcançável por qualquer processo local.** Precisa da mesma
   `turnCredential` de §17.3 no trecho de loopback, agora por razão de isolamento local e
   não de rede.
4. **Não dispensa `B4`.** Continua sendo preciso medir em CGNAT real — o que muda é que a
   medida passa a ter chance de dar certo.

Enquanto isto não for decidido, a saída viável para o caso **(b)** da emenda de §17.3 é a
que já existe pronta e desligada: anunciar o TURN do host (`P2P_TURN_ANNOUNCE=1`), que
resolve membro-atrás-de-CGNAT sempre que quem hospeda for alcançável.

### 17.8 Árvore de multicast — especificada e adiada

`CLAUDE.md` pede multicast em árvore para audiência grande. A decisão v2 é: **o desenho
existe e está fechado aqui; a implementação está bloqueada até POC-09 passar; o v1 não a
inclui.** Isso separa o que está decidido do que depende de validação experimental, que é
exatamente o que o ARB exigiu.

Desenho normativo, para quando for implementada:

| Item | Decisão |
|---|---|
| Transporte | WebCodecs no renderer + stream UDX dedicado por aresta, via `mediaBridge` |
| **Confidencialidade** | O apresentador gera `shareKey` (32 B) por sessão e a entrega **a cada espectador autorizado**, cifrada com `crypto_box_seal` para a chave de identidade dele, pelo RPC do host. Cada quadro é `XChaCha20-Poly1305(shareKey, nonce = sessionId ‖ seq)`. O nó de repasse encaminha **ciphertext** e não tem a chave. Fecha `T-11` |
| **Autenticidade** | O AEAD já autentica; um relay não consegue substituir quadro |
| Handshake de aresta | `treeConnect{sessionId, ticketId}` → o filho apresenta o ticket do host; o pai valida antes de abrir o stream. Fecha `DR-43` |
| ACK de atribuição | `share.assignment` exige `assignmentAck{sessionId, assignmentId}` em ≤ 2 s; sem ACK, o host reatribui. Fecha `DS-14` |
| Prova de recepção | Cada nó reporta `framesReceived` no heartbeat; uma subárvore com `framesReceived` parado é **reparada**, e `treeHealth` reflete isso — nunca fica `ok` com subárvore escura |
| Partição × morte (fecha `DS-15`) | O host distingue "não me responde" de "não recebe quadro" usando o heartbeat **dos filhos** do nó suspeito. Só reatribui pais quando os filhos também param. Um nó reatribuído recebe `assignmentRevoked` e **precisa** derrubar os streams antigos antes de abrir novos, para não existirem dois pais alimentando os mesmos filhos |
| Elegibilidade de repasse | Consentimento aceito **e** upload medido pelo UDX numa janela de 10 s **e** NAT não-CGNAT. Auto-declaração (`canRelay`, `uplinkKbps` de v1) **não** é aceita. Fecha `T-13`, `DR-44` |
| Qualidade | Por **subárvore**, não por espectador: um nó de repasse copia bytes. `share.setQuality` devolve `{applied:false, reason:'tree-topology'}` e a UI explica |
| Latência declarada | 1–2 s, somando por nível — a UX precisa admitir (delta U-14, só quando a árvore entrar) |
| Consentimento | Pedido na transição estrela→árvore **e** sempre que um nó for promovido a repasse pela primeira vez naquela sessão; nunca assumido por timeout (fecha `F-37`) |

---

## 18. Moderação, revogação, remoção e continuidade

Resposta direta ao blocker B10.

### 18.1 O que cada ação de moderação faz — tabela completa

| Ação | Efeito no log | Efeito na projeção | Efeito na rede | Efeito no cliente do alvo |
|---|---|---|---|---|
| `mod.timeout` | Registro | `timeouts` | Nenhum | Ops recusadas com `E_TIMED_OUT` até `until`; **continua lendo**; tickets de mídia revogados |
| `mod.kick` | Registro | `members.left_at`; convites do alvo revogados (R-10) | Canais de replicação fechados por quem projetou | §18.4 — modo `removed` |
| `mod.ban` | Registro | `bans`; `banned=1`; `hidden_by_ban=1` nas mensagens; `member_count−−`; convites revogados. Alvo que **não é membro**: só a linha `bans` e o registro em `banned`, sem decremento de contagem (R-28) | Canais de replicação fechados; conexões derrubadas; tickets revogados | §18.4 — modo `removed`, causa `banned`. Alvo que nunca entrou não tem dado local a remover |
| `mod.revokeBan` | Registro | `revoked_at`; `banned=0` **e `left_at` preenchido**; `hidden_by_ban=0` — **reexibe**; `member_count` e `roleMemberCount` recontados | Replicação volta a ser autorizada | O alvo volta a `left`; precisa de convite válido para reentrar |

**Nota de 2026-09-04 sobre `left_at` em `mod.revokeBan`.** "O alvo volta a `left`" é a última
coluna desde sempre, e a coluna da projeção não dizia qual linha carrega isso. É `left_at`: sem
ele a linha fica `left_at IS NULL AND banned = 0`, que é a definição de **membro ativo** para os
contadores de §8.4 e para toda query de §15.6 — o alvo reaparecia no roster e na busca de
membros enquanto o `fold` recusava cada op dele com `E_NOT_MEMBER` no estágio 8. `view.db` é
derivada do log (§10.3): ela não pode discordar do `DecisionState` que a produziu.

**Nota de 2026-08-26 sobre a coluna "efeito na rede".** "Tickets revogados" e "conexões
derrubadas" descrevem o que a derivação de §17.4/§17.5 faz — e essa derivação só passou a
ser chamada a cada lote projetado nesta data (§19.8, emenda). Antes disso as três primeiras
linhas desta tabela prometiam na coluna de rede um efeito que o produto não produzia: a
sessão de mídia do banido sobrevivia ao ban, que é o defeito de v1 que §17.4 diz ter
fechado. A tabela não muda; o que mudou foi passar a ser verdade.

### 18.2 Ocultação reversível

Ban oculta as mensagens do alvo; revogar o ban as reexibe. Isso é decisão fechada e a UX de
v1 sugeria remoção permanente — delta U-15.

### 18.3 O que o ban **não** faz

**LIMITAÇÃO DECLARADA (L-7, repetida aqui por ser a mais mal compreendida):** o ban não
retira do alvo o que ele já replicou. Ele impede leitura **futura**. O modal de confirmação
é obrigado a dizer isso, junto com a nota de honestidade que já existe sobre identidade
nova (L-6).

### 18.4 Ciclo de vida do dado no cliente do alvo (fecha `F-35`, `DR-35`)

Ao observar no próprio `fold` um `mod.ban`/`mod.kick` cujo alvo é a identidade local, ou ao
receber `E_NOT_AUTHORIZED_FOR_COMMUNITY` de todos os pares:

```
1. para o rpcClient e sai do swarm daquela comunidade
2. marca manifest.communities.removed_reason = 'banned' | 'kicked' | 'unauthorized'
   e retain_until = now + REMOVED_RETENTION_DAYS (default 7)
3. descarta itens de outbox daquela comunidade com motivo 'banned'/'kicked'
4. emite community.accessRevoked{cause}
5. a comunidade continua no rail, em MODO HISTÓRICO SOMENTE LEITURA, com um cabeçalho
   nomeado que diz o que aconteceu, por quem e com que motivo (query.selfModeration)
6. em retain_until, ou por community.forget, a réplica local é apagada
```

Isso é uma tela nova na UX (delta U-16) e é a diferença entre "o app quebra" e "o app
explica".

`member.leave` voluntário segue o mesmo caminho com `removed_reason = 'left'`.

#### Emenda de 2026-08-28 — quem começa, e o que o passo 5 exigia do rail (fecha `B7`)

O passo 6 e a leitura existiam: `removed.purge` apagava no `retain_until`,
`community.forget` apagava antes e `query.selfModeration` sabia dizer o que aconteceu.
Faltava **quem começa** — nada no produto escrevia `removed_reason` nem `retain_until`. As
consequências eram todas silenciosas: `community.forget` recusava sempre (ele exige
`left_at` ou `removed_reason`), `removed.purge` nunca tinha o que purgar,
`community.activate` nunca recusava réplica removida, e o banido ficava em `reconnecting`
honesto tentando para sempre um host que passara a recusá-lo.

| Item | Decisão |
|---|---|
| Gatilho | O `fold` **local**, a cada lote projetado — o mesmo gancho da revogação de mídia de §17.4, e pelo mesmo motivo: em v2 o alvo continua replicando até aplicar o ban (§14.3), então ele **vê** o próprio ban antes de perder acesso |
| Segundo gatilho | `unauthorized` do watchdog (§14.5). Ele já emitia o evento; o que faltava era o resto dos passos. **Emenda de 2026-09-05:** e faltava o **produtor** — `unauthorized` nunca era marcado, porque a recusa de §14.3(1) não chegava a viajar. Com a emenda de §14.3 ela viaja no `hello`, e este gatilho passa a ser o caminho de quem foi removido **enquanto estava offline**: o primeiro gatilho não o alcança, já que os pares recusam a replicação e o bloco do `mod.ban` nunca desce até ele |
| `kicked` × `left` | Os dois têm `state: 'left'` no `DS` e só se distinguem pela auditoria: um `kick` sobre mim **dentro da membresia corrente** (`at >= joinedAt`). Mesma derivação de `query.selfModeration`, para o cabeçalho e o `removed_reason` nunca divergirem |
| Membro ausente do `DS` | **Não** é remoção: é réplica que ainda não interpretou o `member.join`. Tratá-la como saída apagaria a comunidade de quem acabou de entrar |
| Idempotência | Uma comunidade já em modo removido não é reprocessada. Refazer o passo 2 empurraria `retain_until` a cada op nova, e um prazo que nunca vence é o oposto de um prazo |
| Host | Isento: `mod.ban` sobre o próprio host não existe (R-11), e aplicar isto ali desligaria a comunidade da rede por causa da própria auditoria |

**E o passo 5 exigia uma mudança em §15.6 que ninguém tinha feito.** `query.communities`
filtrava por `left_at == null`, então no instante em que a remoção marcava a linha a
comunidade **sumia do rail** — o oposto do que este passo manda. Réplica com
`removed_reason` passa a continuar listada, e o item carrega `removedReason` e `retainUntil`:
é o que a tela de U-16 precisa saber sem uma query só para ela. O "por quem e com que
motivo" continua em `query.selfModeration`, que é onde a auditoria mora.

### 18.5 Comunidade encerrada

`community.end` só pelo `hostKey` corrente. A comunidade fica terminal: zero ops novas, core
mantido em leitura, membros veem `community.ended` e a comunidade permanece no rail em modo
histórico — **a UX precisa especificar essa aparência** (delta U-17).

**Emenda de 2026-08-28 — comunidade encerrada é esquecível sem sair antes (fecha `B8`).**
`community.forget` exigia `left_at` ou `removed_reason`, e o caminho documentado para tirar
do rail uma comunidade encerrada em que ainda sou membro era "sair, depois esquecer". Esse
caminho **não existe**: esta seção deixa o log terminal e o estágio 5 do `fold` recusa toda
op nova, `member.leave` inclusive (`E_COMMUNITY_ENDED`). O passo 1 é impossível, então o 2
era inalcançável e a comunidade ficava no rail para sempre.

A distinção também não significa nada aqui: num log que nunca mais recebe registro, "ainda
sou membro" não descreve relação nenhuma. `community.forget` passa a aceitar a comunidade
terminal diretamente — e continua sendo `main-confirmed` (§15.3), com diálogo nativo, que é
onde a barreira contra o apagamento acidental sempre esteve.

### 18.6 `identity.wipe` — máquina de estados retomável

v1 declarava `identity.wipe` sem nenhum erro possível, apesar de ele apagar o `LOCK` que o
próprio processo segurava (`F-50`). v2:

```
none → requested → swarm-down → cores-closed → view-deleted → manifest-deleted
     → key-wiped → done → none
```

- O estado vive em `manifest.meta.wipe_state`, gravado com `FULL` **antes** de cada etapa.
- `manifest-deleted` grava o estado num arquivo sentinela `p2p/WIPE` antes de remover o
  banco, porque a partir daí não há mais banco onde gravar.
- No boot, se `wipe_state ≠ none` (ou o sentinela existir), a limpeza **retoma** de onde
  parou, antes de qualquer outra coisa (§3.3).
- O `LOCK` é o **último** recurso liberado, e só depois de `key-wiped`.
- **Emenda de 2026-09-05 — liberar o LOCK só quando a sessão vai encerrar.** A linha acima
  descreve a limpeza disparada por `identity.wipe` sobre recursos vivos, que termina com o
  processo saindo: ali liberar é o passo final e correto. O `wipe-resume` do boot (§3.3) é o
  outro caso e tem a regra oposta — o processo **continua** para abrir `manifest.db`,
  `view.db` e os cores de uma instalação zerada, e §10.8 exige a etapa (2) em mãos antes da
  etapa (4). Numa retomada, portanto, a máquina **não** libera o LOCK: ele segue sendo o do
  processo, e sai pelo caminho normal de `stopped`. Liberar no meio do boot deixaria o
  núcleo rodando a sessão inteira sem a exclusão de §10.8.
- Toda etapa que apaga arquivo **fecha o descritor antes de apagar** e **verifica** que o
  arquivo sumiu; falha em remover é `E_WIPE_INCOMPLETE{stage}`, nunca sucesso silencioso.
  Isto não é detalhe de implementação: em Windows o SQLite abre o banco sem
  `FILE_SHARE_DELETE`, então apagar um `manifest.db` ainda aberto **falha**, e engolir esse
  erro faz o `wipe` reportar sucesso deixando `communities.core_key` e
  `invite_secrets.secret` no disco.
- `key-wiped` zera **também** a Data Key do processo (§3.2 item 4), e não só a semente e a
  chave privada de identidade: é ela que protege as sementes de comunidade (§5.3).
- Erros possíveis, todos nomeados: `E_WIPE_INCOMPLETE{stage}` com caminho de retentativa na
  UI. Nunca "sem erro possível".
- Classe `main-confirmed` (§15.3): o renderer sozinho não consegue disparar.

### 18.7 Saída do host

`host.exitImpact` devolve, por comunidade hospedada, `{onlineCount, inCallCount,
pendingReplication}` lidos do roster **efêmero** e do estado de replicação.

**Mudança normativa (fecha `F-43`, `DR-36`, `RT-13`):** a opção "avisar quem está online"
de v1 appendava uma mensagem assinada pelo host e desligava em seguida — quase certamente
antes de ela replicar, e usando um tipo de "mensagem de sistema" que não existe no modelo.
v2 remove essa mensagem. No lugar:

1. O modal de saída mostra quantas pessoas caem e **quantas ops ainda não replicaram**.
2. O `draining` aplica a **barreira de replicação**: o host permanece no swarm até que
   `min(3, memberCount − 1)` pares confirmem `core.length` igual à cabeça, ou até
   `DRAIN_BUDGET_MS` (default 5 000 ms), o que vier primeiro.
3. Estourado o orçamento, registra `shutdown.forced{pendingReplication}` e encerra. Segurar
   o fechamento indefinidamente é pior: o usuário mata o processo e nada é gravado.
4. `core.shutdown` devolve `{drainedMs, pendingOps, replicatedTo}` para a UI ser honesta.

O mesmo procedimento vale para `community.end` (§18.5), com o mesmo orçamento.

#### Emenda de 2026-08-28 — o que conta como confirmação, e o que `replicatedTo` significa (fecha `B10`)

A barreira do passo 2 estava escrita e não estava sendo aplicada: o `draining` esperava
**sinais locais** — fila vazia e projeção na cabeça — e devolvia `replicatedTo` igual ao
`interpretedSeq` desta máquina. Os dois sinais são verdadeiros e nenhum dos dois é o que
este passo pede. "A op está no meu disco" e "a op sobreviveu a esta máquina desligar" são
afirmações diferentes, e o modal de U-06 mostrava a primeira chamando-a de segunda.

| Item | Fonte |
|---|---|
| Confirmação de um par | O comprimento **contíguo** que ele anunciou ter, do bitfield que o replicador do hypercore já mantém por par. Não é sinal novo no fio, e não é declaração do par: é o que ele anunciou |
| Por que contígua, e não `remoteLength` | Quem interessa é quem consegue **interpretar** até a cabeça. Um par com buraco no meio tem `remoteLength` alto e não interpreta nada depois do buraco (§10.5 passo 6) |
| Alvo | `min(3, memberCount − 1)` sobre **membros ativos** — quem saiu ou foi banido não replica e não entra na conta. Alvo zero (host sozinho) não segura o fechamento |
| `replicatedTo` | **Quantos pares** confirmaram a cabeça. Antes era um `seq`, o que fazia a resposta parecer replicação sem descrever nenhuma. Com várias comunidades hospedadas, é a **pior** das confirmações: dizer a melhor esconderia a que não replicou |
| `pendingReplication` de `host.exitImpact` | Quantos registros da cabeça ainda não alcançaram o alvo — não o atraso da projeção local, que lia **zero** num host em dia consigo mesmo e sozinho no swarm, exatamente o caso em que fechar perde tudo |

E o botão **"avisar quem está online"** ainda existia no renderer, appendando a mensagem que
esta seção diz ter removido. Ele saiu junto (`F-43`, delta U-06): o que fica no modal são os
números, incluindo o que ainda não replicou.

#### Emenda de 2026-09-05 — a rede sai **depois** do dreno, e isso é o passo 2

O passo 2 diz "o host **permanece no swarm** até que `min(3, memberCount − 1)` pares
confirmem". O shell fazia o contrário: parava o transporte P2P (fechando canais, esquecendo
os muxes e destruindo o backend do swarm) e só então chamava `core.shutdown`. Com a rede
desfeita, a barreira não tinha como ser cumprida nem como ser medida:

- a confirmação de um par é lida do bitfield que o replicador mantém **por par conectado**;
  sem pares, a contagem é fixa em zero;
- o alvo vem de `membrosAtivos`, que é estado do log e **não** cai junto com a conexão —
  então numa comunidade com dois ou mais membros o alvo nunca era alcançado;
- o `outbox.flush()` do primeiro giro precisa de canal vivo (§11.8) e não tinha nenhum.

O efeito não era "replicar menos": era esperar o orçamento inteiro para devolver
`replicatedTo = 0` e sair do swarm **antes** de replicar — a barreira desligada com o
sintoma de estar ligada. A ordem é normativa: **`core.shutdown` primeiro, com a rede de pé;
a parada do transporte depois, com o que sobrar do orçamento.** O orçamento total continua
sendo o mesmo, e continua menor que a rede de segurança do main (§3.3): perder o dreno é
aceitável, perder o desligamento não.

### 18.8 Sucessão de host e continuidade da comunidade

Fecha `T-43` na parte de continuidade. Sem isso, a máquina do host morrer é a comunidade
morrer, o que o ARB registrou como limitação de produto não aceita.

**Escrow.** O host designa até 5 sucessores em ordem de prioridade
(`community.setSuccessors`). Para cada um, appenda `community.escrow{targetKey,
wrappedSeed}` com `crypto_box_seal(communitySeed, x25519(targetKey))`. Só o sucessor
consegue abrir. O `communitySeed` **nunca** aparece em claro no log.

**Assunção.** Depois de `HOST_INACTIVITY_MS` (default 30 dias) sem novo registro no log,
o sucessor de maior prioridade pode assumir. A assunção **não** appenda no core antigo —
isso produziria dois escritores e um fork. Em vez disso:

```
1. o sucessor decifra communitySeed do escrow
2. cria uma comunidade NOVA, cujo lote de gênese é:
     community.create{ ..., originCommunityId, originFinalSeq, blobsKey novo }
   assinada pela identidade dele, e com o core derivado de um seed NOVO
3. appenda community.assumeHost{ newHostKey, observedHostTs,
     proof = Ed25519(logSecretKeyDoCoreAntigo,
                     BLAKE2b('assume/1' ‖ newCommunityId ‖ originFinalSeq)) }
   — no core NOVO, como seq 6 (logo após a gênese de R-27). A prova demonstra posse da
   chave de escrita antiga, portanto autorização legítima, SEM exigir escrita no core
   antigo — que é o que evita o fork
4. toda réplica verifica a camada (a) de R-18 usando originCommunityId, que É a chave
   pública do core antigo e está na gênese: verificação self-contained, sem precisar ter
   a comunidade de origem. Quem TEM a origem replicada verifica também a camada (b)
   (sucessor autorizado, grace period, prioridade) e, se ela falhar, marca a continuação
   como `disputed` e NÃO migra
5. os membros seguem o ponteiro: o cliente que tem a comunidade antiga e vê um
   community.assumeHost válido apontando para ela migra o rail para a nova, mantendo
   a antiga em modo histórico
6. o estado inicial da comunidade nova é reconstruído pelo sucessor a partir do
   log antigo, appendado como um lote de gênese estendido — **cargos, categorias,
   canais e bans** (R-28). **Membros NÃO são reconstruídos** por este lote (L-23);
   mensagens NÃO são migradas (L-15)
```

#### 18.8.1 Membros não são reconstrutíveis — decisão de 2026-08-22 (`ACHADO-G12-01`)

O passo 6 mandava, até esta emenda, reconstruir **membros** no lote estendido. Isso é
**inalcançável** com o catálogo fechado de 38 `kind`s, e a medição do G12
(`poc/poc-12-g12`) o confirmou: a continuação nasce com exatamente 1 membro — o sucessor,
como fundador de R-27 —, e qualquer `member.join` adicional em forma zerada é
`E_INVITE_INVALID`. Três fatos independentes produzem isso:

1. `member.join` cria a membresia do **próprio autor** (§7.3/§8.1: autoria → `Member`);
2. o `joinProof` de R-9 vincula `(communityId, invitePk, author)` — e o `communityId` da
   continuação é **novo**, portanto o sucessor não tem como forjá-lo para terceiros;
3. ninguém assina por um terceiro (§12.4, `F-06`: "o host não fabrica autoria").

**Decisão: reentrada assistida.** A convergência de membros é **assíncrona**, por convites
que o sucessor publica na continuação; cada pessoa entra com a própria chave, assinando o
próprio `member.join`. O sucessor, que tem a origem replicada, reatribui cargos com
`member.setRoles` conforme cada reentrada acontece. O critério "membros idênticos ao estado
final da origem" é substituído por **convergência eventual do conjunto de membros que
retornar** (L-23).

**Alternativas descartadas.** *Desacoplar alvo da autoria* (`member.join` com `targetKey`
na forma de sucessão): reabre `F-06`, faz o host fabricar membresia de terceiros e quebra a
verificação **self-contained** da camada (a) de R-18 — uma réplica que não tem a origem não
teria como conferir se o roster declarado corresponde a ela, e `joinProof` deixaria de ser
"verificável para sempre por toda réplica" (§12.4). *Transplante dos envelopes originais*
(replay de registros com o `communityId` antigo no core novo): exige core multi-escritor,
que A23/L-15 já recusou pelo mesmo motivo pelo qual o histórico de mensagens não migra.

**O que a decisão obriga.** Moderação **não** pode depender da reentrada: sem os bans no
log da continuação, um banido da origem entra pela porta da frente com um convite de
reentrada — a sucessão lavaria o ban. Por isso o lote estendido carrega os bans, e **R-28**
passa a admitir `mod.ban` sobre alvo que não é membro.

**LIMITAÇÃO DECLARADA (L-15):** a sucessão preserva estrutura, cargos e
moderação. **O histórico de mensagens permanece na comunidade antiga**, acessível em modo
histórico para quem já o replicou. Migrar milhões de mensagens reassinadas pelo sucessor
falsificaria autoria; migrar os envelopes originais exigiria um core multi-escritor. Nenhum
dos dois é aceitável. A UX precisa dizer isso na tela de sucessão (delta U-18).

**LIMITAÇÃO DECLARADA (L-16):** se dois sucessores assumirem em janelas próximas, existem
duas comunidades novas. `R-18` faz cada réplica seguir a de **maior prioridade** entre as
que apresentarem prova válida; a outra fica órfã. Determinístico, mas visível.

**LIMITAÇÃO DECLARADA (L-23):** o **roster não migra**. A continuação nasce com um único
membro — o sucessor — e os demais reentram por convite, cada um assinando o próprio
`member.join`; quem não reentrar não existe na continuação, e os cargos são reatribuídos
pelo sucessor à medida que as reentradas chegam. Bans **migram** (R-28), justamente para
que a reentrada não lave moderação. A UX precisa mostrar o conjunto pendente e dizer que a
migração de pessoas é assíncrona (delta U-18).

`REQUIRES POC` — G12.

### 18.9 Fork detectado

Se o Hypercore reportar bloco conflitante (dois escritores com a mesma chave — §5.5 L-4), o
núcleo: para de appendar naquela comunidade; marca `forked`; emite `community.forked`;
oferece **exportar** a réplica local e **escolher** qual ramo seguir. Não há merge
automático, e não haverá.

### 18.10 Moderação em escala

`CLAUDE.md` lista "moderação em escala sem autoridade central" como problema em aberto.
v2 **não** o resolve e declara o escopo: moderação é **por comunidade**, via cargos e
permissões, sem reputação, sem lista compartilhada, sem federação. **LIMITAÇÃO DECLARADA
(L-17).**

---

## 19. Fluxos

Template: **Entrada · Sequência · Regras · Persistência · Resultado · Falhas.**

### 19.1 Criar comunidade / virar host

**Entrada:** identidade existe; `community.create` válido.
**Sequência:**
1. Gera `communitySeed`; grava em `manifest.communities` com `FULL` (§5.3).
2. Deriva os dois pares de chaves; cria os cores por chave explícita.
3. Deriva o core de blobs local do membro (§13.1) e grava em `manifest.member_blobs_core`.
4. Monta o **lote de gênese** (forma normativa em **R-27**): 6 ops assinadas pela mesma
   chave, `sequenceScope = community` e `authorSeq` 1..6, nesta ordem exata — `community.create` (com `blobsKey`),
   `role.create`(Fundador), `role.create`(Membro, base), `member.join`(o host, com
   `blobsCoreKey`, e com `invitePublicKey`/`joinProof` **zerados**),
   `category.create`(GERAL), `channel.create`(#geral). A chave que assina o `seq` 0 vira o
   `founderKey`. Durante a gênese o `fold` **não suspende estágio nenhum**: quem torna o
   lote admissível é o **principal de gênese** de R-27(a) — o autor é avaliado como membro
   ativo, com as 17 permissões e `topRank = RANK_GENESIS`. A única regra que não se aplica
   é R-9, porque o `member.join` do fundador não tem convite. Os payloads dos `seq` 1, 2 e
   3 têm forma normativa, verificada pelo `fold` — **R-27(b)**.
5. `core.append(lote)` — **uma chamada**, que já commita (§10.7.1). Ou os 6 entram, ou nenhum.
6. `swarm.join(coreKey, {server:true})`; sobe `rpcServer`, roster e STUN/TURN.
7. Projeta os 6 registros pelo caminho normal. O host **não** tem atalho.

**Regras:** `founderKey` = autor do `seq` 0, imutável para sempre. O Fundador recebe as 17
permissões; o cargo base recebe `send_messages`, `attach_files`, `add_reactions`,
`voice_speak` — e **nunca** pode receber mais que isso além de `pin_messages` (R-11).
**Falhas:** disco cheio no append → `E_STORAGE_FULL`, os cores e a linha de manifesto são
descartados. `swarm.join` falhar **não impede** a criação: a comunidade existe e funciona
localmente, em `hosting-degraded`. **Criar comunidade nunca depende de rede.**

### 19.2 Boot

Fase `open` de §3.3. Para cada linha de `manifest.communities` sem `left_at`, com
concorrência `OPEN_CONCURRENCY`: abre o core pela chave gravada → carrega `ds_snapshot` →
`fold` até `core.length` → `swarm.join`. A comunidade ativa (`local_navigation`) é aberta
**primeiro** e com `residency:'full'`.

**Uma comunidade quebrada nunca impede o app de abrir.**

### 19.3 Enviar mensagem

1. `fold.wouldAccept` local (advisório) → falhou: `E_VALIDATION` **síncrono**, nada
   enfileirado, erro inline.
2. Consome `authorSeq` no `sequenceScope` do canal, monta a `Op` (com `communityId`),
   assina, calcula `opId`.
3. `INSERT` em `local_outbox` (`FULL`) com `clientRef`. Responde `{opId, state:'queued'}`.
4. A UI desenha a bolha otimista, ancorada em `authorTs`.
5. `outbox.flush` → `sending` → `rpcClient.submitOp`.
6. Host: §11.4 → `{seq, hostTs}` → item vai a `awaiting-confirmation`.
7. A replicação traz o registro; o `fold` local o interpreta; `messages.appended` é
   emitido; a reconciliação (§11.6) remove o item e emite
   `message.accepted{opId, clientRef, messageId, seq}`.
8. A UI casa pelo `clientRef` e **assenta a bolha na posição de `seq`**.

**Ordem determinada:** `messages.appended` **antes** de `message.accepted`, sempre (fecha
`DS-31`). A UI nunca precisa lidar com as duas ordens.

### 19.4 Host offline → fila → reconexão → flush

`host.statusChanged{status:'offline'}` após **2 falhas consecutivas** de conexão (uma falha
isolada é ruído e piscaria o banner). Escritas de mensagem enfileiram; escritas de
estrutura/moderação falham na hora com `E_HOST_UNAVAILABLE`; leitura segue normal da
réplica local. Volta → `reconnecting` → `hello` → `online` → flush com jitter e limite de
taxa (§11.8) → `outbox.flushed{delivered}`.

`voice.join` com host offline é bloqueado com `E_HOST_UNAVAILABLE` **antes** de tocar em
mídia — o host é o rendezvous, o autorizador e o STUN/TURN.

### 19.5 Convite: emitir → resolver → resgatar

§12.2 → §12.3 → §12.4.

### 19.6 Anexar e baixar

§13.2 → §13.4.

### 19.7 Banir

1. Valida (não é Fundador, não é host, não é o próprio, hierarquia estrita).
2. `submitOp` → §11.4 → append.
3. O `fold`, em **uma** transação de projeção: insere em `bans`; `members.banned=1`;
   `hidden_by_ban=1` nas mensagens do alvo; remove-as da FTS; `member_count−−`; revoga os
   convites do alvo (R-10); insere no `moderation_log`.
4. O host fecha os canais de replicação com o alvo e derruba a conexão daquela comunidade.
5. Revoga tickets de mídia e emite `voice.revoked`.
6. Todo outro membro faz (4) e (5) ao projetar o mesmo registro.

### 19.8 Excluir canal com chamada acontecendo

Valida (não é o último canal) → appenda → o host encerra a sessão de voz imediatamente,
emitindo `voice.failed{reason:'channel-deleted'}` e `voice.revoked` a cada participante →
projeta o tombstone → `structure.changed` → a outbox descarta os itens daquele canal com
motivo `channel-deleted`. A exclusão **prevalece** sobre quem entra no mesmo instante,
porque as duas ops passam pela mesma fila serializada.

**Emenda de 2026-08-26 — "imediatamente" era o lote projetado, e o lote projetado não
chamava ninguém.** Este fluxo é o único lugar do documento que amarra uma op de estrutura ao
encerramento de uma sessão de mídia, e ele estava correto no papel. O que não existia era o
ponto que liga uma coisa à outra: a derivação de revogação de §17.4/§17.5 é uma função pura
sobre o estado corrente, e **nada a chamava depois de cada lote projetado**. `channel.delete`
appendava, projetava o tombstone e emitia `structure.changed` — e a chamada continuava
acontecendo dentro de um canal que já não existe. O mesmo valia para `mod.ban`, `mod.kick`,
`mod.timeout` e o fim da comunidade: a coluna "tickets revogados" de §18.1 descrevia um
efeito que não acontecia.

A derivação passa a rodar em **todo lote projetado** da comunidade hospedada, e é ela que
torna verdadeira a frase de §17.4 sobre ban alcançar mídia (`T-32`). As duas metades deste
fluxo agora existem: `voice.revoked` a cada participante **e** `voice.failed{reason}`
nomeando o encerramento — a segunda dependia também de §16.3 passar a listar o tópico.

### 19.9 Cargos: criar, mover, atribuir

Criar: sem dica de posição, o cargo entra no **fim do escopo** —
`rank` = `midpoint(RANK_BOTTOM, menor rank existente acima de RANK_BOTTOM)`, ou
`midpoint(RANK_BOTTOM, RANK_TOP)` se não houver nenhum. Numa comunidade recém-criada isso é
entre o cargo base e o Fundador, que é a posição mais baixa **útil**: o cargo já modera quem
só tem o base, e não modera mais ninguém. Com dica, `role.create{afterRank?, beforeRank?}`
segue a mesma regra de vizinhança de `role.move`.

> A redação anterior era `midpoint(rank do cargo imediatamente abaixo do topo do autor,
> próximo abaixo)`, com os dois argumentos na ordem **inversa** da definição de §6.4.1
> (`midpoint(a, b)` exige `a < b`, e o primeiro argumento ali é o **maior**). Lida ao pé da
> letra ela caía no ramo de entrada incoerente e produzia cargo abaixo do base — inerte por
> R-3 + R-4. A regra acima é a que §6.4.1 sustenta, e o piso é o que a torna correta.

Mover: `role.move{afterRoleId, beforeRoleId}` → **uma única linha muda**; a
resposta devolve só o `rank` novo (não uma lista de renumeração). Atribuir:
`member.setRoles` com a lista completa; a resposta devolve `appliedRoleIds` após o
descarte de ids desconhecidos (§8.4.1), para a UI não ficar com uma expectativa errada.

### 19.10 Editar e deletar mensagem

Editar: só o autor. Conteúdo vazio é recusado; esvaziar se resolve deletando. O conteúdo
antigo **fica no log** e é recuperável por quem inspecionar o core — a UX precisa evitar
prometer o contrário (delta U-19).

Deletar: própria, ou `manage_messages` + hierarquia. Uma transação: `deleted_at`,
`content = NULL`, apaga reações, `ftsRemove`, sai de Fixados. O registro continua no log.
"Não pode ser desfeito" é verdade para a interface, não para os bytes (delta U-20).

---

## 20. Erros

### 20.1 Forma

`{code, message, details?, field?, retryAfterMs?}`.

- `code`: da tabela abaixo. **É o contrato.**
- `message`: em inglês, para log e depuração. O texto em português é do renderer.
- `field`: presente em `E_VALIDATION`; nomeia o campo, para o erro inline de formulário.
- `retryAfterMs`: presente em `E_RATE_LIMITED`, `E_BUSY` e nas falhas transitórias com
  backoff conhecido.

### 20.2 Catálogo completo

Coluna **R** = a outbox retenta.

| Código | Classe | HTTP eq. | R | Significado |
|---|---|---|---|---|
| `E_MALFORMED` | cliente | 400 | não | Quadro/payload não decodifica |
| `E_VALIDATION` | cliente | 400 | não | Campo fora dos limites de §8.6 |
| `E_UNKNOWN_COMMAND` | cliente | 404 | não | Comando IPC inexistente |
| `E_UNKNOWN_KIND` | cliente | 400 | não | `kind` de op desconhecido |
| `E_BAD_CURSOR` | cliente | 400 | não | Cursor inválido ou de outro escopo |
| `E_BAD_SIGNATURE` | segurança | 401 | não | Assinatura do autor inválida |
| `E_BAD_HOST_SIGNATURE` | segurança | 401 | não | `hostSig` inválida |
| `E_WRONG_COMMUNITY` | segurança | 400 | não | `op.communityId` ≠ core |
| `E_AUTHOR_MISMATCH` | segurança | 401 | não | `op.author` ≠ chave do par |
| `E_DUPLICATE` | idempotência | 200 | — | `authorSeq` já visto — **sucesso** para o cliente |
| `E_AUTHOR_SEQ_OVERTAKEN` | bug | 409 | não | A `sequenceScope` avançou sem o `opId` correspondente na réplica; falha de protocolo/escalonador, nunca entrega |
| `E_NOT_MEMBER` | autorização | 403 | não | Autor não é membro ativo |
| `E_BANNED` | autorização | 403 | não | Autor banido |
| `E_TIMED_OUT` | autorização | 403 | **sim**, após `until` | Timeout ativo |
| `E_PERMISSION_DENIED` | autorização | 403 | não | Falta permissão |
| `E_HIERARCHY` | autorização | 403 | não | Alvo com `rank ≥` o do autor |
| `E_FOUNDER_IMMUNE` | autorização | 403 | não | Alvo é o Fundador |
| `E_HOST_IMMUNE` | autorização | 403 | não | Alvo é o host corrente |
| `E_SELF_TARGET` | autorização | 403 | não | Moderação sobre si mesmo |
| `E_FOUNDER_IMMUTABLE` | autorização | 403 | não | Cargo Fundador não é editável |
| `E_FOUNDER_TOP` | autorização | 403 | não | Fundador é sempre o topo |
| `E_PERMISSION_ESCALATION` | autorização | 403 | não | Conceder permissão que não tem (R-5) |
| `E_BASE_ROLE_REQUIRED` | regra | 409 | não | Cargo base obrigatório / indeletável |
| `E_BASE_ROLE_RESTRICTED` | segurança | 403 | não | Permissão proibida no cargo base (R-11) |
| `E_NOT_HOST` | autorização | 403 | não | Só o host pode |
| `E_HOST_CANNOT_LEAVE` | regra | 409 | não | Host encerra ou sucede, não sai |
| `E_NICKNAME_SELF_ONLY` | regra | 403 | não | Apelido é auto-atribuído |
| `E_CANNOT_EDIT_OTHERS` | regra | 403 | não | Moderação apaga, não reescreve |
| `E_NOT_FOUND` | estado | 404 | não | Genérico |
| `E_CHANNEL_NOT_FOUND` | estado | 404 | não | Canal sumiu |
| `E_CHANNEL_NOT_VOICE` | estado | 409 | não | Canal errado para voz |
| `E_CATEGORY_NOT_FOUND` | estado | 404 | não | — |
| `E_MESSAGE_DELETED` | estado | 409 | não | — |
| `E_COMMUNITY_ENDED` | estado | 410 | não | Comunidade encerrada |
| `E_NOT_BANNED` | estado | 409 | não | Revogar ban inexistente |
| `E_CHANNEL_NAME_TAKEN` | conflito | 409 | não | Nome duplicado (R-6) |
| `E_CHANNEL_NAME_EMPTY` | validação | 400 | não | Slug vazio após normalização |
| `E_LAST_CHANNEL` | regra | 409 | não | Último canal (R-7) |
| `E_THREAD_EXISTS` | conflito | 409 | não | Já há thread na raiz |
| `E_REACTION_LIMIT` | regra | 409 | não | > 20 emojis distintos |
| `E_CHANNEL_READ_ONLY` | autorização | 403 | não | Somente-leitura para os cargos do autor |
| `E_LIMIT_EXCEEDED` | regra | 409 | não | Limite de cardinalidade de §26.2 — traz `limit` |
| `E_QUOTA_EXCEEDED` | proteção | 429 | **sim** | Cota determinística de escrita (R-15) — traz `retryAfterMs` estimado |
| `E_INVITE_INVALID` | estado | 404 | não | Inválido, revogado ou expirado |
| `E_INVITE_EXHAUSTED` | estado | 409 | não | `maxUses` atingido |
| `E_ATTACHMENT_TOO_LARGE` | validação | 413 | não | > `ATTACHMENT_MAX_BYTES` |
| `E_PAYLOAD_TOO_LARGE` | validação | 413 | não | Envelope acima do teto |
| `E_FILE_UNREADABLE` | infra | 400 | não | Arquivo local ilegível |
| `E_BLOB_NOT_STAGED` | regra | 409 | não | `message.send` com anexo antes de o `blob.stage` completar (§13.7 regra 1) |
| `E_TICKET_INVALID` | segurança | 403 | não | Ticket de staging ou de mídia inválido/expirado |
| `E_TICKET_DENIED` | autorização | 403 | não | Host recusou emitir ticket de mídia |
| `E_TYPE_NOT_OPENABLE` | segurança | 403 | não | Tipo fora da allowlist de §13.6 |
| `E_NOT_DOWNLOADED` | estado | 409 | não | Abrir antes de baixar |
| `E_NO_PEERS` | rede | 503 | **sim** | Zero pares com o blob |
| `E_RATE_LIMITED` | proteção | 429 | **sim** | + `retryAfterMs` |
| `E_OUTBOX_FULL` | proteção | 429 | não | Fila cheia |
| `E_ALREADY_SENT` | estado | 409 | não | Cancelar item já em voo |
| `E_HOST_UNAVAILABLE` | rede | 503 | **sim** | Host offline/inalcançável |
| `E_SWARM_DEGRADED` | rede | 503 | **sim** | Sem bootstrap/pares |
| `E_PEER_UNREACHABLE` | rede | 503 | **sim** | Sinalização não chegou |
| `E_TIMEOUT` | rede | 504 | **sim** | Estouro de prazo |
| `E_BUSY` | proteção | 429 | **sim** | Fila do host cheia / concorrência máxima |
| `E_NOT_ATTEMPTED` | lote | 202 | **sim** | Item de `submitOps` que o host não chegou a processar; permanece `queued` (§11.9) |
| `E_NOT_AUTHORIZED_FOR_COMMUNITY` | autorização | 403 | não | Canal de replicação recusado (§14.3) |
| `E_SESSION_GONE` | estado | 410 | não | Sessão de mídia acabou |
| `E_ALREADY_SHARING` | conflito | 409 | não | Você já está compartilhando neste canal (uma por apresentador, §17.5) |
| `E_QUEUE_CLOSED` | estado | 409 | não | **Novo (2026-08-28)** — entrada na fila de karaokê com a fila fechada (§16.4) |
| `E_DEVICE_BLOCKED` | infra | 403 | não | **Novo** — o SO negou microfone/câmera (fecha `RT-10`) |
| `E_CONSENT_REQUIRED` | regra | 403 | não | Relay sem consentimento |
| `E_VERSION_UNSUPPORTED` | compat. | 426 | não | `opVersion` incompatível — **terminal** na outbox |
| `E_CLOCK_UNREASONABLE` | validação | 400 | não | `op.ts` fora da janela (R-2) |
| `E_GENESIS_MISPLACED` | regra | 409 | não | `community.create` fora do `seq` 0 |
| `E_ID_COLLISION` | bug | 500 | não | Colisão de id determinístico |
| `E_SUCCESSION_DENIED` | autorização | 403 | não | Assunção de host não autorizada (R-18) |
| `E_IDENTITY_EXISTS` | conflito | 409 | não | Já há identidade |
| `E_BAD_PASSPHRASE` | cliente | 401 | não | Frase secreta de import errada |
| `E_CANCELLED` | cliente | 499 | não | Usuário cancelou diálogo do SO |
| `E_KEYSTORE_UNAVAILABLE` | infra | 500 | não | `safeStorage` indisponível |
| `E_KEYSTORE_INSECURE` | segurança | 500 | não | Fallback `basic_text` sem aceite explícito (§3.2 L-2) |
| `E_CORE_ALREADY_RUNNING` | infra | 409 | não | Lock ocupado |
| `E_CORE_RESTARTED` | infra | 503 | não | Request perdido por crash do núcleo (§15.2) |
| `E_CORE_CORRUPT` | infra | 500 | não | Core ilegível |
| `E_SCHEMA_AHEAD` | infra | 500 | não | Banco de versão futura |
| `E_STORAGE_FULL` | infra | 507 | não | Disco cheio |
| `E_WIPE_INCOMPLETE` | infra | 500 | não | `identity.wipe` parcial (§18.6) — traz `stage` |
| `E_INTERNAL` | bug | 500 | **sim** (1×) | Não classificado |
| `E_DM_BLOCKED` | estado | 409 | não | **Novo (2026-09-01)** — a conversa direta está bloqueada nesta instalação (§31.9) |
| `E_DM_FORKED` | estado | 409 | não | **Novo** — o próprio core de DM está `forked` ou `desynced`; escrever produziria fork (§31.13) |
| `E_DM_CORE_MISMATCH` | segurança | 403 | não | **Novo** — o par anunciou chave de core diferente da já vinculada (RD-6) |
| `E_DM_NOT_AUTHORIZED` | autorização | 403 | não | **Novo** — canal de DM recusado: par errado, bloqueado, ou política de contato (§31.8, §31.9) |
| `E_KEYSTORE_MODE_CHANGED` | infra | 500 | não | **Novo (2026-09-05)** — a Data Key está embrulhada em modo `secure` e o cofre atual é o inseguro (§3.2 L-2, regra 3): não há o que reembrulhar |
| `E_CORE_LOCK_UNAVAILABLE` | infra | 500 | não | **Novo (2026-09-05)** — o lock exclusivo de §10.8(2) não pôde ser tentado (addon de `flock`/`LockFileEx` ausente); o núcleo não abre sem exclusão |

**92 códigos.** O catálogo é **fonte única**: nenhum código pode aparecer em qualquer parte
deste documento sem estar nesta tabela (fecha `F-28`).

**Emenda de 2026-08-26 (§90) — saíram `E_SESSION_FULL`, `E_VOICE_FULL` e `E_CAMERA_LIMIT`.**
Os três nomeavam recusa por **lotação**, e a lotação deixou de existir: os tetos de §27.1
eram números de política, não invariantes, e nada no `fold` dependia deles. Código de erro
sem produtor é superfície declarada que ninguém alcança — a forma de defeito que §86 e §89
fecharam três vezes —, então eles saem do catálogo em vez de ficar como letra morta.

### 20.3 Regras de tratamento

1. Erro nunca vaza stack trace pelo IPC. A stack vai para o log.
2. `E_INTERNAL` é bug até prova em contrário e sempre gera log em `error`.
3. **Erro de rede nunca vira erro de validação**, e o inverso também não. Confundir os dois
   faz o usuário achar que digitou errado quando a rede caiu.
4. **`E_RATE_LIMITED` e `E_HOST_UNAVAILABLE` são visualmente distintos na UI**, com o
   `retryAfterMs` exibido. Fecha `T-33`: um host que silencie seletivamente via
   `retryAfterMs` fica visível para o usuário, em vez de parecer bug.
5. Erro terminal em op enfileirada vira `dropped` com motivo nomeado, nunca some calado.
6. Falha parcial é reportada **por item** (§11.9).
7. `E_DUPLICATE` **não** é erro na UI: é confirmação de que a op já estava aplicada.

---

## 21. Concorrência, ordenação e idempotência

### 21.1 Onde há concorrência de verdade, e como cada caso resolve

| Cenário | Resolução |
|---|---|
| Dois moderadores editam o mesmo cargo | Ordem de chegada na fila do host; maior `seq` vence, campo a campo (o payload de `role.update` carrega só os campos alterados). Sem merge, sem conflito visível |
| Dois candidatos no último uso de um convite | Seção crítica de §11.4; `uses` é `DS`. Um entra, o outro recebe `E_INVITE_EXHAUSTED`. **Nunca os dois** |
| `channel.delete` ‖ `message.send` no mesmo canal | Ambos passam pela mesma fila serializada. Se o delete chegou antes, a mensagem é `REJECTED` com `E_CHANNEL_NOT_FOUND` **antes do append**. Se chegou depois, a mensagem existe e o canal é tombstonado — a mensagem fica `orphaned` (§8.4.1). **Nenhum dos dois caminhos produz brick** |
| `channel.create(#x)` ‖ `channel.create(#x)` | R-6: o primeiro fica, o segundo é `REJECTED` antes do append |
| `role.delete` ‖ `member.setRoles` citando-o | O `setRoles` posterior descarta o id desconhecido (§8.4.1) |
| `role.move` ‖ `role.move` | Chave fracionária: os dois aplicam, sem colisão de índice (§6.4.1) |
| `category.delete` ‖ `channel.create` naquela categoria | O create posterior é `REJECTED` (`E_CATEGORY_NOT_FOUND`) |
| `message.delete` ‖ `reaction.set` | A reação posterior é `REJECTED` (`E_MESSAGE_DELETED`) |
| `channel.delete`(último) ‖ `channel.delete`(penúltimo) | R-7 recusa o que deixaria a comunidade sem canal |
| Ban ‖ op do alvo | A op que chega depois do ban é `REJECTED` com `E_BANNED`; a que chega antes é aplicada e depois **ocultada** pela projeção do ban |
| Duas instâncias do app | Impossível: lock composto (§10.8) |
| Projeção e leitura simultâneas | WAL: leitor não bloqueia escritor. O `projector` é o **único** escritor de `view.db` |
| Dois escritores do mesmo core (identidade importada) | Fork detectado (§18.9) |

**A afirmação central de v2 (e o que ela substitui):** v1 dizia "com um só escritor não
existe conflito de escrita". Isso era verdade para o *log* e falso para o *estado*. v2 diz:

> Existe **uma ordem** (o `seq`) e **uma interpretação** (o `fold`). Toda corrida se
> resolve determinaticamente, no mesmo ponto, em todo nó. As oito corridas que a auditoria
> distribuída usou para demonstrar `DS-01` são exatamente as oito linhas acima, e nenhuma
> delas produz registro venenoso.

### 21.2 Idempotência

| Operação | Chave | Reenvio |
|---|---|---|
| Qualquer op | `(author, communityId, sequenceScope, authorSeq)` | `E_DUPLICATE` = sucesso, sem novo efeito |
| `message.delete` de já deletada | — | Sucesso, sem auditoria nova |
| `mod.ban` de já banido | — | Sucesso, sem entrada nova |
| `mod.removeTimeout` sem timeout | — | Sucesso |
| `invite.revoke` de já revogado | — | Sucesso |
| `relay.withdraw` sem voluntariado | — | Sucesso |
| `reaction.set{present}` | Estado final | Convergente por maior `seq` |
| `blob.download` já baixado | — | `blob.completed` imediato |
| `channel.markRead` | — | Sucesso |
| `voice.join` no mesmo canal | — | Devolve a sessão existente |

### 21.3 Reentrância proibida

- O `fold`/`projector` **nunca** é reentrante: um lote por comunidade por vez, garantido por
  flag. Um `append` durante um lote entra no lote seguinte.
- O `fold` **nunca** chama outro `fold`, nem enfileira op, nem faz I/O.
- Um handler de evento IPC **nunca** dispara comando de escrita no núcleo.

---

## 22. Jobs, loops e cancelamento

### 22.1 Loops permanentes

| Loop | Período | Onde |
|---|---|---|
| `projector` | reativo a `append`, com lote | todo nó |
| `outbox.flush` | 1 s, ou disparado por `host.cameBack` com jitter (§11.8) | todo nó |
| `outbox.recover` | uma vez no boot, antes do primeiro flush | todo nó — `sending → queued`, sem consumir tentativa (§11.3) |
| `outbox.reconcile` | `OUTBOX_RECONCILE_MS` (30 s), no boot e em `host.cameBack` | todo nó |
| `replication.watchdog` | `REPLICATION_WATCH_MS` (5 s) | todo nó — §14.5 |
| `host.hello` | `P2P_HELLO_INTERVAL_MS` (30 000) | todo nó membro — **Emenda de 2026-08-23:** a tabela não listava o produtor do `hello`, embora §14.5 defina `synced` por ele ("o par host respondeu no último `HELLO_INTERVAL_MS`") e §27.2 declare a constante para isso. É o loop que o pressupunha. Na PRIMEIRA conexão o `hello` é enviado imediatamente pelo anexo do canal (§16.3 "antes de qualquer outro método"), não na cadência |
| `presence.refresh` | 15 s | todo nó |
| `voice.liveness` | `P2P_HELLO_INTERVAL_MS` | **host** — **Emenda de 2026-08-26:** §17.4 passou a declarar que queda de conexão é saída da chamada, e o fechamento do canal cobre só o caso em que o transporte percebe a queda. Máquina desligada no meio da chamada não manda FIN nenhum: sem esta varredura o participante ficaria no roster até um `voiceJoin` novo, que pode não vir nunca. Roda na cadência do `hello`, que é a evidência que a alimenta, e derruba quem não manda pedido há `VOICE_LIVENESS_MS` (3 × `P2P_HELLO_INTERVAL_MS`). O host participa da chamada como qualquer membro e **não** tem conexão de si para si — ele é isento por construção, não por prazo |
| `presence.tick` | `PRESENCE_TICK_MS` (2 s) | host |
| `typing.expire` | 1 s | host |
| `voice.queueTick` | 1 s | **host** — **Emenda de 2026-08-30 (§16.4):** o giro do relógio da fila de karaokê — expira o turno vencido (muta o titular e promove o próximo) e descarta a fila do canal cuja sessão acabou. Rodava acoplado ao `voice.liveness`, na cadência do hello (30 s), e a vez é coisa de segundos: o titular ficava com o microfone aberto até 30 s além do prazo, e a promoção do próximo atrasada junto. A varredura de vivacidade continua no `voice.liveness`, que é onde a evidência (o `hello`) vive |
| `media.ticketRenew` | `MEDIA_TICKET_TTL_MS / 3` | participante de mídia |
| `media.sweep` | 30 s | **host** — **Emenda de 2026-09-05 (§17.3):** a varredura de alocações do TURN, que existia em código desde a fase 7 **sem chamador nenhum** em produto. Fecha a alocação vencida e a de quem já não está no roster da sessão, com a socket relayada de cada uma. Sem ela, cada alocação vencida vazava um socket UDP até o processo morrer, e o registro morto fazia o `Allocate` seguinte do mesmo 5-tuple responder 437 para sempre. A revogação de §17.4 continua sendo o caminho rápido — esta é a rede de segurança, na ordem de grandeza da vida da permissão de RFC 5766 §9 |
| `blob.progress` | 500 ms | quem baixa |
| `metrics.flush` | 10 s | todo nó |

### 22.2 Jobs periódicos

| Job | Período | O que faz |
|---|---|---|
| `outbox.expire` | 5 min | Marca `dropped/expired` **só depois de reconciliar** (§11.6) |
| `invite.topicSweep` | 15 min | Sai do tópico DHT de convites expirados/esgotados/revogados. **Emenda de 2026-08-22:** revogar e esgotar são registro no log e já saem na reconciliação do lote projetado (§12.2 passo 3); **expirar não é registro nenhum**, e é por isso que o job existe — o relógio é o local do host, que é quem anuncia |
| `host.inactivity` | 6 h | Atualiza `inactiveDays`; ≥ `INACTIVE_COMMUNITY_DAYS` alimenta o rótulo do rail. **Emenda de 2026-08-23:** `inactiveDays` é derivado na leitura (`⌊(agora − lastHostSeenAt)/dia⌋`) — armazená-lo criaria segunda fonte para o mesmo fato; o job reavalia o valor e, na TRAVESSIA do limiar, emite `host.statusChanged` (o único sinal da tabela fechada de §15.5 que nomeia o relacionamento com o host), que é o que alimenta o rótulo. Sem `lastHostSeenAt` não há dias para contar — e nada é inventado (precedente de §46/§50) |
| `succession.check` | 24 h | Verifica se o grace period de §18.8 foi atingido; oferece assumir ao sucessor |
| `blob.gc` | 24 h | §22.4 |
| `staging.gc` | 24 h | §13.5 |
| `removed.purge` | 24 h | Apaga réplicas de comunidades com `retain_until` vencido (§18.4) |
| `db.maintenance` | 24 h | `PRAGMA optimize`; `wal_checkpoint(TRUNCATE)` acima de 64 MiB |
| `ds.snapshot` | por contagem (`DS_SNAPSHOT_INTERVAL`) e no `draining` | §10.6 |
| `log.rotate` | 24 h | §24.1 |

### 22.3 Backoff

Curva única para reconexão de swarm, RPC e outbox:
`delay = min(1000 · 2^n, 60000) ± 20 %`. O jitter não é enfeite: sem ele, 340 membros
reconectam em fase depois de o host voltar e produzem avalanche exatamente no pior momento.

### 22.4 GC de blobs

| Regra | Valor |
|---|---|
| Blob **enviado por mim** com mensagem viva | **Nunca** coletado (§13.7 regra 2) |
| Blob baixado, cache acima de `BLOB_CACHE_MAX_BYTES` | LRU por `verified_at` |
| Blob de comunidade removida | Apagado com o `removed.purge` |
| Staging órfão > `STAGING_ORPHAN_MS` | `core.clear` dos blocos + remove a linha |

`core.clear()` libera **blocos locais**; não apaga o dado da rede.

**Emenda de 2026-08-22 — leitores esparsos de cores alheios.** Cada `blob.download` abre o
core de blobs do autor e o registra para replicar em todo mux vivo (§13.4). Sem coleta, uma
sessão longa acumula um core aberto por autor de quem já se baixou algo, cada um com canal
em cada conexão. O `blob.gc` fecha os leitores **sem download em voo**, esquece a marcação
de replicação por mux (o `attachTo` não sobrevive ao `close`, e o core precisa entrar de
novo se for reaberto) e sai do tópico de §14.1 daquele core. O core **local** nunca é
coletado: é dele que a comunidade se serve (§13.7 regra 2).

### 22.5 Cancelamento

Todo job e todo loop recebe um `AbortSignal` do ciclo de vida da comunidade. Fechar uma
comunidade (sair, encerrar, ser removido, `wipe`) aborta tudo dela em ≤ 100 ms. Nenhum job
sobrevive ao fechamento do seu escopo — é o que impede o "job zumbi escrevendo em banco
fechado", causa clássica de crash no shutdown.

---

## 23. Busca, filtros, ordenação, paginação

### 23.1 Consulta

`query.search{communityId, query, filters:{authorKey?, channelId?, date?, kind?},
scopeChannelId?, limitPerGroup=20}`.

| Etapa | Regra normativa |
|---|---|
| Normalização | NFD → remove diacrítico → minúsculo (a mesma função do frontend) |
| Tokenização | Split por não-alfanumérico; tokens de 1 caractere são descartados |
| **Construção do `MATCH` (fecha `DR-39`)** | Cada token vira `"token"` (aspas duplas, escapando `"` interno por duplicação) — **isso desativa toda a sintaxe de operador do FTS5**, então `AND`, `OR`, `NOT`, `NEAR`, `*`, `^`, `:` digitados pelo usuário são literais, nunca operadores. Os tokens são unidos por `AND` implícito. **Exceção única:** o último token recebe `*` de prefixo (`"revis"*`) para busca-enquanto-digita |
| `date` | `today` = início do dia local do leitor; `7d`/`30d` = janela a partir de agora. Aplicado sobre `host_ts` |
| `kind` | `attachment` = tem anexo · `pinned` = `pinned=1` · `link` = existe linha em `message_links` |
| Escopo | `scopeChannelId` restringe **antes** dos filtros |
| Exclusões | Deletadas, `hidden_by_ban` e `orphaned` nunca aparecem; canais de voz não são varridos |
| Canais e membros | Respondem **só ao texto**; filtros de autor/anexo/data não se aplicam a eles |
| `partial` | §14.5 — quatro causas possíveis, devolvidas em `partialReason` |

### 23.2 Ordenação (fechada, por lista)

| Lista | Ordem |
|---|---|
| Mensagens de canal | `seq` crescente |
| Resultados de busca | `seq` **decrescente** — recência, não relevância |
| Canais dentro de categoria | `rank` crescente |
| Categorias | `rank` crescente |
| Cargos | `rank` **decrescente** (topo primeiro) |
| Membros | Grupo pelo cargo de maior `rank`; alfabético dentro do grupo por `nickname ?? displayName`, com desempate por `handle` |
| Comunidades no rail | Ordem de entrada (`joined_at`), nunca alfabética |
| Log de auditoria / banidos / timeouts / fixados | `seq` decrescente |

### 23.3 Paginação

| Superfície | Estratégia | Lote |
|---|---|---|
| Mensagens | Cursor por `(seq, id)`, bidirecional | 50 |
| Busca | Teto de 20 por grupo, "ver todos" expande até 100 | 20/100 |
| Membros | Cursor; offline vem como **contagem agregada** | 100 |
| Auditoria / banidos / timeouts / fixados / arquivos / links | Cursor | 25 |

**Nunca há paginação numerada.** Cursor inválido → `E_BAD_CURSOR` e a UI recomeça do início.

---

## 24. Logs e observabilidade

### 24.1 Log estruturado

NDJSON, uma linha por evento, em `logs/core-YYYY-MM-DD.ndjson`. Campos obrigatórios: `ts`,
`level`, `scope`, `msg`. Opcionais: `communityId`, `channelId`, `opId`, `kind`, `seq`,
`durMs`, `code`, `epoch`.

Níveis: `error` · `warn` · `info` · `debug` (desligado em produção) · `trace`.
Rotação diária; retenção `LOG_RETENTION_DAYS` (7); teto `LOG_MAX_TOTAL_BYTES` (200 MiB).

### 24.2 Redação obrigatória — allowlist, não blocklist

O `logger` só escreve campos que estão numa **allowlist explícita** por escopo. Um campo
novo não aparece no log até ser adicionado. Blocklist esquece o campo novo (fecha `T-39`).

**Nunca aparecem, em nível nenhum:** conteúdo de mensagem, nome de anexo, tópico de canal,
nome de canal, `displayName`, `nickname`, apelido, motivo de moderação, `label` de convite,
segredo/código de convite, **qualquer caminho de arquivo do usuário**, material de chave,
payload de mídia, frase secreta.

**Aparecem:** chaves públicas truncadas em 8 hex, ids de entidade, `seq`, `opId`, tamanhos,
contagens, códigos de erro, durações, `epoch`, `subId`.

### 24.3 Métricas

| Métrica | Tipo | Uso |
|---|---|---|
| `swarm.peers` (por comunidade) | gauge | "N pares conectados" |
| `swarm.natType` | gauge | `open`/`moderate`/`cgnat` |
| `swarm.directConnectRate` | ratio | Mede a promessa de conectividade de verdade |
| `rpc.latency` / `rpc.errors` | histograma / counter por código | — |
| `fold.applied` / `fold.rejected` / `fold.ignored` | counter por `kind`/razão | `rejected` alto = cliente adulterado ou bug |
| `fold.panic` | counter | **> 0 é bug de severidade máxima** (§8.5) |
| `fold.propertyViolation` | counter por propriedade | §6.17 |
| `fold.hostTsClamped` | counter | R-1 |
| `fold.idCollision` | counter | Deve ser sempre 0 |
| `projector.lag` / `projector.rate` | gauge | `core.length − interpretedSeq` |
| `replication.state` | gauge por comunidade | §14.5 |
| `outbox.depth` / `outbox.dropped` / `outbox.ackMismatch` | gauge / counter | `ackMismatch` > 0 = host suspeito (§11.6) |
| `commit.groupSize` / `commit.flushMs` | histograma | §11.5 |
| `blob.throughput` / `blob.hashFailures` | gauge / counter | — |
| `media.ticketsIssued` / `media.ticketsRevoked` | counter | — |
| `turn.allocations` / `turn.bytesRelayed` | gauge / counter | Custo do host |
| `db.txDuration` (por banco) | histograma | — |
| `ipc.evDropped` / `ipc.staleSubs` | counter / gauge | §15.1 |

### 24.4 Health

`core.status` devolve `phase` global; `query.communities` devolve saúde por comunidade. Uma
comunidade é **saudável** quando: `replication.state = 'synced'` **e** host alcançável (ou é
o próprio) **e** nenhum item de outbox com `attempts > 5` **e**
`partialInterpretation = false`.

### 24.5 Resposta a alarme de segurança (fecha `T-47` parcialmente)

`fold.rejected{reason:'E_BAD_SIGNATURE'}` ou `E_BAD_HOST_SIGNATURE` > 0 numa comunidade é
sinal de host adversário ou de corrupção. A resposta normativa: (a) registrar em `warn` com
`seq` e `kind`; (b) expor a contagem em 3.1 → Rede; (c) **não** desconectar automaticamente
— um falso positivo desconectaria o usuário da comunidade dele. **LIMITAÇÃO DECLARADA
(L-18):** não há pontuação de pares nem banimento automático de peer. É alarme, não defesa.

---

## 25. Segurança

### 25.1 Modelo de ameaça v2

| Adversário | Consegue | Não consegue | Onde está a mitigação |
|---|---|---|---|
| Membro comum malicioso | Enviar ops que sua permissão autoriza; spam até a cota | Escalar permissão; agir acima da hierarquia; forjar autoria; usar o cargo base como vetor | §9.3 (R-4, R-5, R-11), §8.2, R-15 |
| Cliente adulterado | Mandar payload arbitrário | Passar pelo `fold` — em nó nenhum | §8 |
| Ex-membro banido | Reconectar ao canal pré-membro; criar identidade nova | Continuar replicando; ler dado novo; usar mídia | §14.3, §17.4, L-6 |
| **Host malicioso** | Omitir, reordenar, truncar (detectável) | **Forjar autoria; fabricar efeito não autorizado; transplantar envelope de outra comunidade; reescrever carimbo** | §7.1 (`communityId` assinado, `hostSig`), §8 (o `fold` roda em toda réplica) |
| Observador do DHT | Ver que um tópico existe e quem conecta | Derivar o código de convite; ler tráfego | §12.1, Noise, DTLS-SRTP |
| Voluntário de relay | Ver volume e temporização | Ler conteúdo de mídia | DTLS-SRTP ponta a ponta (§17.7) |
| Nó de repasse da árvore (quando existir) | Ver volume e temporização | Ler ou forjar quadro | AEAD por sessão (§17.8) |
| Renderer comprometido | Tudo que a UI pode fazer | Ler arquivo arbitrário do disco; obter material de chave; executar comando destrutivo sem confirmação nativa; ligar `dev.*` | §13.3, §3.2, §15.3 |
| Processo local do mesmo usuário | Ler `view.db`, `manifest.db` e o corestore | Ler a chave privada — **se e só se** o secret store do SO estiver disponível | §3.2 e **L-2** |
| Par não autenticado | Abrir conexão e gastar o orçamento pré-membro | Consumir CPU de verificação; passar do teto de bytes; enumerar convite | §14.4, §12.6 |

### 25.2 Superfície de rede

O núcleo **não escuta em porta TCP/HTTP local**. Não há servidor local, WebSocket ou porta
de debug em produção. As entradas são: o socket UDP do `hyperdht`/UDX (que também
multiplexa STUN/TURN quando em modo host) e as sockets do `RTCPeerConnection` no renderer.

### 25.3 Validação de entrada não confiável

| Entrada | Regra |
|---|---|
| Frame RPC | Teto de bytes **antes** do decode (§14.4) |
| Envelope | `fold` §8.2, estágios 1–2 |
| Nome de anexo | **Rejeitado**, não sanitizado (§8.6); no disco vira `<blobIdHex>-<nome>` |
| `content` de mensagem | Guardado cru; markdown renderizado em elementos React, nunca por `innerHTML` |
| URL em mensagem | Allowlist de esquema `http`/`https`/`mailto`; o resto vira texto (§15.6.1) |
| Caminho de arquivo | **Só por ticket do main** (§13.3) |
| Emoji de reação | 1–8 code points, ≤ 32 bytes (§8.6) |
| Cursor | Decodificado e validado; escopo conferido |
| Deep link | Gramática fechada, parse no main (§3.5) |
| Mídia recebida | Decodificada pelo pipeline do Chromium; **só imagem inline** no v1 (§13.6) |

### 25.4 Regras permanentes

1. Nenhum `eval`, `Function` ou `require` dinâmico com string vinda de dado.
2. Nenhuma dependência nova sem versão travada (`package-lock` commitado), SBOM gerado no
   build e revisão de transitivas.
3. `nodeIntegration:false`, `contextIsolation:true`, `sandbox:true` no renderer.
4. CSP sem `unsafe-inline` e sem host externo.
5. Nenhum dado sai do dispositivo a não ser para um par **com quem o usuário escolheu
   falar** — membro de uma comunidade em comum (§14.3) ou participante de uma conversa
   direta aceita (§31.8): **zero telemetria, zero analytics, zero crash reporter
   externo**. **Emenda de 2026-09-01:** a redação anterior dizia "para um par da
   comunidade", e com a conversa direta no v1 (§31) ela passaria a proibir o próprio
   produto. O que a regra sempre quis dizer é **nenhum terceiro**, e é isso que está
   escrito agora; a lista de proibições não muda.
6. Builds assinados (Authenticode no Windows). Hash do artefato publicado junto do release.
   Notarização era exigência de macOS e saiu com ele da matriz (A16).

### 25.5 Integridade de configuração (fecha `T-22`)

- **Nada que afete interpretação do log vem de configuração** (§1.5). Um arquivo adulterado
  não muda o estado da comunidade.
- **Valores de rede sensíveis** (`P2P_BOOTSTRAP`, `P2P_STUN_SERVERS`, `P2P_DATA_DIR`) **não
  são lidos de `config.json`** em build de produção. Só de variável de ambiente ou flag de
  linha de comando explícita.
- Quando qualquer um deles estiver fora do default, o núcleo emite `config.nonDefault` e a
  UI exibe um indicador permanente em 3.1 → Rede: "configuração de rede não padrão ativa".
  Delta U-21.

### 25.6 Detecção de censura e de reescrita (`L-1`)

- **Omissão:** o cliente sabe o que enviou (`local_outbox` + `local_author_seq`). A
  reconciliação (§11.6) procura o `opId` em `observed_ops`, detecta ACK sem registro
  correspondente e conta `outbox.ackMismatch`.
  Uma contagem persistente é exibida em 3.1 → Rede como "o host confirmou N operações que
  não aparecem no histórico". Delta U-22.
- **Truncamento:** o Hypercore assina o comprimento; truncar muda a chave de comprimento e é
  **detectável por toda réplica**. O núcleo emite `community.forked` e para de appendar.
- Nenhuma das duas é **impedível**. Está declarado.

### 25.7 Distribuição e resposta a vulnerabilidade (fecha `T-42`)

| Item | Decisão v1 |
|---|---|
| Canal de atualização | Manual: o app **não** se atualiza sozinho e **não** fala com host próprio (isso contradiria o princípio 1). Ele **verifica** a versão corrente contra uma constante embutida e, quando o `hello` de um host reportar `coreVersion` maior, exibe "há uma versão mais nova" com instrução de download manual |
| Integridade | Build assinado; hash publicado; SBOM |
| Aviso de segurança | `opVersion` pode ser usado para forçar clientes vulneráveis a somente-leitura: um host atualizado recusa `opVersion` antiga, o que **para a escrita** de clientes desatualizados sem parar a leitura |
| Prazo | Correção de severidade crítica: nova build em ≤ 7 dias, com bump de `opVersion` quando aplicável |

**LIMITAÇÃO DECLARADA (L-19):** sem canal de atualização automático, a janela de exposição
depende do usuário atualizar. É consequência direta do princípio 1 e está aceita.

### 25.8 Limitações declaradas — lista consolidada

Esta é a lista **completa e fechada** do que a arquitetura **não** entrega. Toda linha aqui
é um risco aceito, não um buraco: ela existe porque a alternativa contradiz o produto, é
tecnicamente impossível, ou custa mais do que vale. **Cada uma tem obrigação de aparecer na
interface**, na superfície indicada.

| # | Limitação | Onde | Superfície de UI obrigatória |
|---|---|---|---|
| **L-1** | Censura por omissão e truncamento pelo host são **detectáveis, não impedíveis** | §1.4, §25.6 | 3.1 → Rede (contagem de divergência) |
| **L-2** | `safeStorage` não protege contra processo do mesmo usuário nem contra memória; no Linux sem secret store o fallback `basic_text` **não protege nada** | §3.2 | Tela de aceite do modo inseguro + indicador permanente |
| **L-3** | Não há rotação da Data Key no v1 | §5.4 | — (registrado, sem superfície) |
| **L-4** | O backup de identidade **não** é multi-dispositivo; duas instalações hospedando a mesma comunidade produzem fork | §5.5 | Texto no fluxo de backup e de restauração |
| **L-5** | Personificação é possível: nome livre, `handle` de 40 bits | §6.1 | `handle` sempre junto do nome; aviso de nome duplicado |
| **L-6** | Banido que volta com identidade nova é indistinguível de membro novo | §6.3 | Nota de honestidade no modal de ban |
| **L-7** | Ban impede leitura **futura**; não retira o que o alvo já replicou | §6.12, §18.3 | Modal de confirmação de ban |
| **L-8** | Identidade é gratuita: convite limita quem entra, não quantas identidades uma pessoa tem | §12.6 | Texto em 0.3 e em 3.1b |
| **L-9** | Disponibilidade de anexo depende de haver ao menos um par com os blocos | §13.7 | Estado `unavailable` no card do anexo |
| **L-10** | `view_audit_log` é confidencialidade **local**, não segredo criptográfico | §15.6 | Texto em 3.3 |
| **L-11** | Host atrás de CGNAT sem porta alcançável não serve STUN/TURN | §17.3 | Diagnóstico de rede + estado `conn-failed` |
| **L-11b** | **Membro** atrás de NAT com mapeamento dependente do destino (CGNAT simétrico, típico de operadora móvel) não fecha conexão direta **mesmo com o host alcançável**. Separada da L-11 em 2026-08-30 (§99): a causa é outra e a saída é outra — aqui o TURN do host **resolve**, e o que falta é anunciá-lo (`B4`/`P2P_TURN_ANNOUNCE`) | §17.3 | `conn-failed` com motivo `furo-falhou`/`turn-nao-alocou`; relay |
| **L-15** | O serviço STUN/TURN do host é **IPv4-only** — a pilha do `hyperdht` de onde sai o endereço público é IPv4. Um par IPv6↔IPv6 fecha sem ele; o que não existe é o host servindo em IPv6 (§99) | §17.3 | Declarada; `B51` |
| **L-12** | `voice_mute_others` é **conselho** ao cliente do alvo; o enforcement é remover do roster | §17.4 | Dois controles distintos (U-08) |
| **L-13** | Presença e digitando são **at-most-once** | §17.6 | — (comportamento, sem superfície) |
| **L-14** | O voluntário de relay observa **metadados**: com quem, quando, quanto | §17.7 | Texto de consentimento (U-13) |
| **L-15** | A sucessão preserva estrutura, cargos e moderação; **o histórico de mensagens não migra** | §18.8 | Tela de sucessão (U-18) |
| **L-16** | Dois sucessores em janelas próximas produzem duas continuações; cada réplica segue a de maior prioridade | §18.8 | Tela de sucessão |
| **L-17** | Moderação é **por comunidade**: sem reputação, sem lista compartilhada, sem federação | §18.10 | — (escopo declarado) |
| **L-18** | `fold.rejected` por assinatura ruim é **alarme, não defesa**: não há pontuação de pares nem banimento automático de peer | §24.5 | 3.1 → Rede |
| **L-19** | Sem canal de atualização automático, a janela de exposição depende do usuário | §25.7 | Aviso de versão nova |
| **L-20** | `invisible` **não** entrega anonimato de rede: o endereço é anunciado no DHT e observável por quem participa dos mesmos tópicos. Ele entrega apenas invisibilidade **na interface** | §6.16, §25.1 | Texto no seletor de presença e em 3.1 → Rede |
| **L-21** | Só material de chave é cifrado em repouso. `view.db`, `manifest.db` (exceto os campos de segredo) e o corestore ficam **em claro** no disco: conteúdo de mensagem, nomes e anexos são legíveis por qualquer processo do mesmo usuário e por quem tiver acesso físico ao disco | §10.1, §10.2 | Texto em 3.1 → Privacidade |
| **L-22** | Sair de uma comunidade tem efeito **local imediato**, mas o `member.leave` depende do host para chegar aos outros. Com o host permanentemente offline, os demais continuam vendo a pessoa no roster | §11.1 | Texto na confirmação de saída |
| **L-23** | O **roster não migra** na sucessão: a continuação nasce só com o sucessor, os demais reentram por convite assinando o próprio `member.join`, e quem não reentrar não existe lá. Cargos são reatribuídos pelo sucessor conforme as reentradas chegam; bans migram (R-28) | §18.8.1 | Tela de sucessão (U-18): conjunto pendente e aviso de migração assíncrona |
| **L-24** | **A chave pública de identidade é o nó na DHT**, e portanto é ao mesmo tempo o **endereço** de uma pessoa e o que denuncia que ela está online a quem já conhece o `discoveryKey` de uma comunidade dela. Não há diretório, não há busca e o rendezvous derivado de segredo compartilhado foi recusado (§31.8): para falar com alguém pela primeira vez é preciso já ter a chave dela, obtida por fora do produto. **Acrescentada em 2026-09-02 (§111): a limitação já era declarada e numerada em §14.3 desde sempre, e nunca tinha entrado nesta tabela** — a omissão tornava a regra de completude de `deltas-ux-v2.md` incapaz de detectar a falta da superfície correspondente | §14.3, §31.8 | Duas, e as duas obrigatórias: o aviso de metadado de presença (**U-27**), e a chave própria **inteira e copiável** mais o campo para colar a do outro (**U-33**, **U-34**) |
| **L-25** | Uma **conversa direta nunca some por inteiro** do disco de quem participou dela: `dm.forget` limpa blocos e projeção, mas a linha de `dm_conversations` sobrevive com `self_high_water` e os comprimentos de esquecimento — sem eles, escrever de novo produziria fork contra a cópia do par. Só `identity.wipe` apaga tudo | §31.19 | Texto na confirmação de "esquecer conversa" |
| **L-26** | **A entrega de uma DM exige as duas pontas online ao mesmo tempo**, em algum momento. Não há store-and-forward, e não haverá (§25.4, A29). Escrever é sempre possível e a mensagem é final assim que escrita; o que espera é a replicação | §31.10, §31.11 | Estado "não entregue" com o tempo desde a escrita, **sem afirmar a causa** |
| **L-27** | **A ordem de uma conversa direta é acordo entre as duas partes.** Uma parte pode escrever um `ack` maior do que o que viu e posicionar as próprias mensagens fora da ordem causal; a outra vê isso **marcado** (`ackAhead`), não corrigido | §31.6 | Marca de "ordem provisória" na faixa afetada |
| **L-28** | **Bloquear uma conversa direta é silencioso e indistinguível de estar offline.** O bloqueado vê o `ack` parar de avançar, e nada mais. É deliberado: avisar transformaria o bloqueio num sinal para escalar | §31.9 | Texto na confirmação de bloqueio, dizendo que o outro não é avisado |
| **L-29** | **Voz numa conversa direta falha mais que voz numa comunidade**: não há relay voluntário, porque ele pressupõe uma comunidade com terceiros e numa dupla não há terceiro. Com nenhum dos dois lados alcançável (L-11, L-11b), a chamada não acontece | §31.15 | Diagnóstico de rede + `conn-failed` com o motivo, sem oferecer relay |

**Regra:** uma limitação que não está nesta lista **não é aceita** — é buraco de spec e
deve ser levantada. Acrescentar uma linha aqui é decisão de produto e segurança, não de
implementação.

---

## 26. Performance, limites e cache

> **Toda a §26.1 é hipótese até o benchmark correspondente passar.** Nenhum número aqui é
> fato. Isso é a aplicação direta da recomendação 5 da auditoria de ADRs.

### 26.1 Alvos (hipóteses, medidas em G9)

| Operação | Alvo | Teto aceitável | Consequência objetiva se o teto for estourado |
|---|---|---|---|
| `query.messages` (50) | < 3 ms | 15 ms | Revisar índice; **não** relaxar o alvo sem registro |
| `query.structure` | < 2 ms | 10 ms | idem |
| `query.search` (10 k msgs) | < 30 ms | 120 ms | Reduzir `limitPerGroup` ou cortar prefixo do último token |
| `fold` de uma op (host) | < 150 µs | 600 µs | Perfilar; a verificação Ed25519 domina e **não** é pulável |
| `submitOp` ponta a ponta (LAN) | < 60 ms | 250 ms | **Renegociar o alvo, nunca a barreira de durabilidade** (§11.5) |
| Interpretação + projeção | ≥ 8 000 reg/s | 3 000 reg/s | Abaixo do teto: reduzir o dataset de referência ou paralelizar a verificação em lote |
| Boot até `core.ready` (5 comunidades, 50 k msgs) | < 1,5 s | 4 s | Reduzir `DS_SNAPSHOT_INTERVAL` |
| Memória do núcleo em repouso (5 comunidades) | < 250 MiB | 500 MiB | Reduzir comunidades com `residency:'full'` |
| Latência de tela (estrela WebRTC) | < 400 ms | 800 ms | Degradar o perfil por espectador (§17.5). Reintroduzir teto de audiência só com número medido, e como configuração por canal (`backlog.md` B38), não como constante de protocolo |
| Latência de voz p95 | < 200 ms | 400 ms | — |

O POC-07 mediu `submitOp` em **um canal**, com p95 de 0,34 ms e 1.298 ops/s, além de
group commit médio 30,8 e máximo observado 32. Isso é evidência do harness, não aprovação
do alvo de produção: o limite normativo do grupo continua 64 e o cenário multicanal da
emenda de A05 ainda precisa ser medido no código da fase 3/G9.

### 26.2 Limites do sistema

**Constantes de protocolo** (o `fold` as aplica; mudar exige bump de `opVersion`):

| Limite | Valor | Erro |
|---|---|---|
| Canais por comunidade | 500 | `E_LIMIT_EXCEEDED` |
| Categorias por comunidade | 50 | idem |
| Cargos por comunidade | 100 | idem |
| Cargos por membro | 24 | idem |
| Convites ativos por comunidade | 50 | idem |
| Emojis distintos por mensagem | 20 | `E_REACTION_LIMIT` |
| Menções por mensagem | 64 | `E_VALIDATION` |
| Anexos por mensagem | 1 | `E_VALIDATION` |
| Links extraídos por mensagem | 8 | — (truncado) |
| Sucessores | 5 | `E_VALIDATION` |
| `ATTACHMENT_MAX_BYTES` | 2^53−1 (teto de representação, não de produto — §13.8) | `E_ATTACHMENT_TOO_LARGE`, inalcançável pelo fio: o decode de `u64` recusa antes com `E_MALFORMED` |
| `ATTACHMENT_QUOTA_PER_MEMBER` | **não existe** desde `opVersion = 3` | — |
| `QUOTA_WINDOW_SEQS` / `QUOTA_OPS_PER_WINDOW` / `QUOTA_BYTES_PER_WINDOW` | 10 000 / 2 000 / 64 MiB | `E_QUOTA_EXCEEDED` |
| `MAX_ENVELOPE_BYTES` / `MAX_ENVELOPE_BYTES_ATTACHMENT` | 32 KiB sem anexo, 64 KiB com anexo. Aplicado no `fold`: estágio 0 (teto absoluto) e estágio 13 (o condicional) | `E_PAYLOAD_TOO_LARGE` |

**Limites operacionais** (locais, sem efeito na interpretação): comunidades participadas
(50), conexões de swarm (128), itens de outbox por comunidade (500), cache de blobs
(20 GiB). Estourar comunidades participadas devolve `E_LIMIT_EXCEEDED` no `invite.redeem`.

**Escala de referência:** 340 membros. Um escritor e muitos leitores é o caso fácil do
Hypercore; o gargalo é o **fan-out de conexões no host**, não o log. `HOST_MAX_PEERS`
(default 256) e a política de §14.2 existem para isso. **`BENCHMARK REQUIRED` — G9.**

### 26.3 Rate limiting no host (proteção, não interpretação)

Token bucket por autor e por comunidade, aplicado **antes** do `fold`. É proteção de
recurso do host; **não** substitui a cota determinística de R-15, que é o que vincula um
host adversário.

| Escopo | Taxa | Burst | Nota |
|---|---|---|---|
| Todas as ops | 20 / 10 s | 40 | Um `submitOps` de `n` custa `n` (§11.9) |
| `message.send` | 10 / 10 s | 24 | Burst calibrado com o lote máximo de 32 |
| `reaction.set` | 30 / 10 s | 45 | — |
| `message.edit` | 10 / 60 s | 15 | — |
| Ops de estrutura/cargo | 20 / 60 s | 30 | Compatível com **salvamento explícito** (§26.5) |
| `invite.create` | 5 / 1 h | 5 | — |
| `mod.*` | 30 / 60 s | 40 | — |
| `presencePublish` | 1 / 5 s (presença), 1 / 2 s por canal (typing) | — | §17.6 |
| Pré-membro | §12.6 | — | Por chave e por /24 |

### 26.4 Cache

Cada cache tem invalidação explícita, nunca TTL cego sobre dado replicado. **E nenhum cache
depende de um evento que pode ter se perdido:** todo cache é reconstruído no boot e após
`evStale` (§15.1).

| Cache | Chave | Invalidado por | Tamanho |
|---|---|---|---|
| Permissões efetivas | `(communityId, identityKey)` | `roles.changed`, `members.changed`, boot | 2 000 LRU |
| Cargos por comunidade | `communityId` | `roles.changed`, boot | por comunidade aberta |
| Estrutura | `communityId` | `structure.changed`, boot | por comunidade aberta |
| Página de mensagens | `(channelId, cursor)` | `messages.appended`, `message.updated`, boot | 20 páginas LRU |
| Disponibilidade de blob | `(blobsCoreKey, blobId)` | evento de par **e** TTL 5 s | 500 |
| Statements SQLite | SQL | nunca | todos |

**Sem cache, de propósito:** contagem de não-lidas (query indexada de < 1 ms), roster de
voz (efêmero), resultado de busca.

### 26.5 Decisões de performance já tomadas

- Statements preparados e reutilizados.
- **Uma transação por lote**, não por op.
- **Group commit** no host (§11.5) — é o que permite `synchronous` seguro e latência
  aceitável ao mesmo tempo.
- Verificação Ed25519 é o custo dominante e **não** é opcional. Se virar gargalo, a
  otimização permitida é verificação em lote, nunca pular.
- `ArrayBuffer` transferível para chunk de mídia (só na árvore adiada).
- **Salvamento explícito no lugar de auto-save** (fecha `F-12`, `K-3`, `E-2`, `P-4`): os
  formulários de comunidade, canal e cargo passam a ter botão "Salvar alterações" com
  estado sujo, em vez de debounce de 800 ms. Auto-save contra uma op síncrona, com rate
  limit de 20/60 s e log append-only, produz uma op por tecla e é indefensável. Delta U-23.

---

## 27. Configuração

### 27.1 Constantes de protocolo (**não configuráveis**)

Fazem parte de `opVersion = 3`. Mudar qualquer uma exige bump de versão de protocolo e um
plano de compatibilidade — foi exatamente o que a remoção de `ATTACHMENT_QUOTA_PER_MEMBER`
custou (§13.8). Nenhuma lê `env`.

**Onde elas moram (fecha `O-07`).** Cada constante fica no módulo de §4 que a **aplica** —
`RANK_*` em `permissions`, o resto em `fold` —, e nenhuma é transcrita duas vezes. A redação
anterior mandava um módulo `protocol/constants.ts`, que §4 não tem: a fronteira de camadas é
por diretório de módulo da tabela de §4, então um `src/protocol/` seria violação de build, não
organização. Um módulo só de constantes também não teria camada — ele seria importado por L1 e
por L2 ao mesmo tempo.

`CLOCK_ACCEPT_MS` 86 400 000 · `CLOCK_SKEW_MS` 60 000 · `ATTACHMENT_MAX_BYTES` 2^53−1 ·
`QUOTA_WINDOW_SEQS` 10 000 ·
`QUOTA_OPS_PER_WINDOW` 2 000 · `QUOTA_BYTES_PER_WINDOW` 64 MiB · `MAX_ENVELOPE_BYTES`
32 KiB · `MAX_ENVELOPE_BYTES_ATTACHMENT` 64 KiB · `RANK_MAX_LEN` 64 ·
`RANK_TOP` `'zz'` · `RANK_BOTTOM` `'1'` · `RANK_GENESIS` `'z'` × 65 ·
`PERM_COUNT` 17 (numeração fechada em §9.1) · `COLOR_COUNT` 8 (catálogo em §6.4.2) ·
`MAX_CHANNELS` 500 · `MAX_CATEGORIES` 50 · `MAX_ROLES` 100 ·
`MAX_ROLES_PER_MEMBER` 24 · `MAX_ACTIVE_INVITES` 50 · `MAX_REACTION_EMOJIS` 20 ·
`MAX_MENTIONS` 64 · `MAX_ATTACHMENTS_PER_MESSAGE` 1 · `MAX_LINKS_PER_MESSAGE` 8 ·
`MAX_SUCCESSORS` 5 · `INVITE_SECRET_BYTES` 10 · `HOST_INACTIVITY_MS` 30 d · `RELAY_TTL_MS` 24 h ·
`MEDIA_TICKET_TTL_MS` 5 min · `TEXT_COUNT_UNIT` = code point (escalar Unicode; §8.6) ·
`DM_VERSION` 1 (versão de protocolo da conversa direta, §31.4 — **independente de `opVersion`**) ·
e todos os limites de campo de §8.6.

**Regra:** se um número decide se uma op tem efeito, ele está aqui. Se decide como esta
instalação usa recursos locais, está em §27.2. Nunca nos dois.

### 27.2 Configuração operacional

Precedência: variável de ambiente > `config.json` em `userData` > default. Resolvida uma
vez no boot e **congelada**. Valor fora da faixa é **clampado** para o limite mais próximo,
com log `config.invalid{key, given, used}` e um aviso na UI de 3.1 (fecha `DR-51`).

| Variável | Default | Faixa | Efeito |
|---|---|---|---|
| `P2P_DATA_DIR` | `<userData>/p2p` | caminho | Raiz de dados — **só env/flag** (§25.5) |
| `P2P_BOOTSTRAP` | default do `hyperdht` | lista `host:port` | Bootstrap do DHT — **só env/flag** |
| `P2P_STUN_SERVERS` | STUN público (Google) | lista | STUN de terceiro — **só env/flag**; ligar expõe o IP a um terceiro e a UI avisa. **Correção de 2026-08-30:** a linha dizia *(vazio)*, mas a emenda de 2026-08-25 de §17.2 (§81.5) decidiu o default **LIGADO** — "o STUN de terceiros passa a vir ligado", com os três guardas lá declarados (o do host vem primeiro; `P2P_STUN_SERVERS=""` vence o default, distinguindo "não definida" de "definida e vazia"; o parser só aceita `stun:`/`stuns:`). O código seguia a emenda e esta tabela, a antiga: divergência em silêncio é o que §81.5 proíbe. A superfície de configuração fora de env/flag continua sendo o B29 |
| `P2P_LOG_LEVEL` | `info` | `error`…`trace` | — |
| `P2P_LOG_RETENTION_DAYS` | 7 | 1–90 | — |
| `P2P_LOG_MAX_TOTAL_BYTES` | 200 MiB | ≥ 10 MiB | — |
| `P2P_DHT_PERSIST` | `true` | bool | Cache de nós do DHT |
| `P2P_SWARM_MAX_CONNECTIONS` | 128 | 8–512 | §14.2 |
| `P2P_HOST_MAX_PEERS` | 256 | 16–1024 | §14.2 |
| `P2P_PREMEMBER_CONN_BUDGET` | 8 | 1–64 | §12.6 |
| `P2P_BG_ROTATION_MS` | 60 000 | 5 000–600 000 | Anti-starvation |
| `P2P_PROJECTOR_BATCH` | 256 | 32–2048 | Registros por transação |
| `P2P_DS_SNAPSHOT_INTERVAL` | 5 000 | 500–100 000 | §10.6 |
| `P2P_REPROJECT_PROGRESS_SEQ` | 100 000 | ≥ 1 000 | Mostra barra a partir daí |
| `P2P_OPEN_CONCURRENCY` | 4 | 1–16 | — |
| `P2P_OUTBOX_MAX_ITEMS` | 500 | 10–5 000 | Por comunidade |
| `P2P_OUTBOX_MAX_AGE_MS` | 72 h | ≥ 1 h | Só após reconciliação (§11.6) |
| `P2P_OUTBOX_RECONCILE_MS` | 30 000 | 5 000–600 000 | — |
| `P2P_GROUP_COMMIT_WINDOW_MS` | 4 | 0–50 | §11.5 |
| `P2P_GROUP_COMMIT_MAX` | 64 | 1–512 | — |
| `P2P_HOST_QUEUE_DEPTH` | 512 | 32–8 192 | Shedding (§11.8) |
| `P2P_FLUSH_RATE_PER_S` | 20 | 1–500 | Anti-avalanche |
| `P2P_RECONNECT_FLUSH_DELAY_MS` | 1 000 | 0–30 000 | — |
| `P2P_REPLICATION_WATCH_MS` | 5 000 | 1 000–60 000 | §14.5 |
| `P2P_REPLICATION_STALL_MS` | 20 000 | 5 000–300 000 | — |
| `P2P_IPC_SUB_WINDOW` | 256 | 16–4 096 | §15.1 |
| `P2P_IPC_STALE_MS` | 3 000 | 500–30 000 | — |
| `P2P_BLOB_CACHE_MAX_BYTES` | 20 GiB | ≥ 1 GiB | GC |
| `P2P_STAGING_TICKET_TTL_MS` | 900 000 | 60 000–3 600 000 | §13.3 |
| `P2P_DRAIN_BUDGET_MS` | 5 000 | 1 000–60 000 | §18.7 |
| `P2P_REMOVED_RETENTION_DAYS` | 7 | 0–365 | §18.4 |
| `P2P_INACTIVE_COMMUNITY_DAYS` | 30 | 1–365 | Rótulo do rail |
| `P2P_PRESENCE_TICK_MS` | 2 000 | 500–30 000 | §17.6 |
| `P2P_TURN_RATE_KBPS` | 512 | 64–4 096 | §17.3 |
| `P2P_RELAY_MAX_BYTES_PER_DAY` | 5 GiB | ≥ 100 MiB | §17.7 |
| `P2P_TESTNET` | `false` | bool | `hyperdht/testnet`; **nunca** a DHT pública em teste |
| `P2P_BUILD_CHANNEL` | `prod` | `prod`/`dev` | **Constante de build**, não runtime (§15.3) |
| `P2P_RPC_MAX_FRAME_BYTES` | 65 536 | ≥ `MAX_ENVELOPE_BYTES` | Teto antes do decode, membro (§14.4) |
| `P2P_PREMEMBER_MAX_FRAME_BYTES` | 4 096 | 1 024–65 536 | Teto antes do decode, pré-membro (§12.6) |
| `P2P_INVITE_RATE_PER_PEER` | `10 / 60 s` | — | Rate limit de admissão por `remotePublicKey` (§12.6) |
| `P2P_INVITE_RATE_PER_SUBNET` | `30 / 60 s` | — | Rate limit de admissão por prefixo /24 (§12.6) |
| `P2P_HELLO_INTERVAL_MS` | 30 000 | 5 000–300 000 | Frequência do `hello` que alimenta `synced` (§14.5) |
| `P2P_HOST_CLOCK_ALARM_MS` | 300 000 | 60 000–3 600 000 | Limiar de `host.clockSuspect` (§11.4) |
| `P2P_STAGING_ORPHAN_MS` | 86 400 000 | ≥ 1 h | Coleta de staging abandonado (§13.5) |
| `P2P_REJECTED_LOG_MAX` | 2 000 | 0–100 000 | Linhas de `rejected_records` por comunidade (§10.3) |
| `P2P_TURN_ALLOC_TTL_MS` | 600 000 | 60 000–3 600 000 | Vida da alocação TURN (§17.3) |
| `P2P_TURN_ALLOC_PER_MEMBER` | 2 | 1–8 | Alocações simultâneas por membro (§17.3) |
| `TURN_PERMISSION_LIFETIME_MS` | 300 000 | — | **Constante de protocolo, não configuração** (RFC 5766 §9): vida de uma permissão de par, renovada por `CreatePermission`/`ChannelBind`. Está nesta tabela por vizinhança com os controles de §17.3; o valor é o da RFC e não se ajusta por ambiente |
| `P2P_TURN_SESSION_MAX_BYTES` | 2 GiB | ≥ 64 MiB | Teto de bytes por sessão TURN (§17.3) |
| `P2P_RELAY_MAX_ALLOCS` | 4 | 1–32 | Alocações simultâneas aceitas por um voluntário (§17.7) |
| `P2P_DM_MAX_CONVERSATIONS` | 500 | 1–5 000 | Conversas diretas em estado `accepted` por instalação (§31.18) |
| `P2P_DM_PENDING_MAX` | 100 | 0–1 000 | Conversas em `pending-in` simultâneas (§31.9) |
| `P2P_DM_PENDING_MAX_RECORDS` | 32 | 1–256 | Registros replicados de um par ainda não aceito (§31.9) |
| `P2P_DM_STORAGE_WARN_BYTES` | 1 GiB | ≥ 16 MiB | Acima disso numa conversa, a UI avisa e oferece bloquear ou esquecer. **Não trunca** (§31.18) |

### 27.3 Valores derivados (emenda de 2026-08-26)

Nem todo número nomeado no texto é constante de protocolo ou botão de operação. Alguns são
**função de outro**, e escrevê-los como valor solto criaria duas fontes para o mesmo fato —
exatamente o que §27.1 evita ao mandar cada constante morar no módulo que a aplica. Esta
tabela é fechada: um valor derivado só entra aqui se a fórmula estiver escrita.

| Valor | Fórmula | Por quê |
|---|---|---|
| `VOICE_LIVENESS_MS` | `3 × P2P_HELLO_INTERVAL_MS` (90 s no default) | §17.4/§22.1 — o prazo depois do qual um participante silencioso sai da chamada. A **evidência** de que ele está vivo é o `hello` de §22.1; o prazo tem de ser múltiplo da cadência dessa evidência, senão troca-se um número por outro sem relação. Três voltas tolera um `hello` perdido. Um `P2P_VOICE_LIVENESS_MS` independente permitiria configurar um prazo menor que a cadência que o alimenta, o que derrubaria da chamada gente que está nela |
| `media.ticketRenew` | `MEDIA_TICKET_TTL_MS / 3` | §17.4/§22.1 — já era derivado desde a emenda de 2026-08-22; entra aqui por ser a mesma família |
| `VOICE_OCCUPANCY_COALESCE_MS` | 1 s, o valor que §17.6 já declarava em prosa | §17.6 — a janela de coalescência de `voiceOccupancy`. Não é loop nem botão: é janela por canal, aberta pela primeira mudança e fechada com o último estado. Entra aqui porque a tabela de §17.6 a declarava sem nome, e um número citado sem nome é um número que ninguém consegue conferir |

**Verificação obrigatória em CI:** um teste percorre a spec e falha se existir qualquer
constante `SCREAMING_SNAKE` citada no texto que não esteja em §27.1, §27.2 ou §27.3, e
vice-versa. É o que impede a regressão que `DR-51` descreveu.

---

## 28. Estratégia de testes

### 28.1 Unitários — os módulos puros

`fold`, `opCodec`, `permissions`, `idgen` recebem cobertura exaustiva, não amostral.

- **`fold`**: tabela de casos por `kind` × cada estágio de §8.2 × cada regra `R-*` ×
  fronteira de cada limite de §8.6 (mín−1, mín, máx, máx+1). ≥ 1 200 casos, síncronos,
  sem I/O; inclui monotonicidade independente de `lastAuthorSeq` por `sequenceScope` e
  rejeição de escopo incompatível sem avanço do contador.
- **`fold` — fuzzer de totalidade (obrigatório):** ≥ 10⁷ entradas aleatórias e mutadas
  (bytes aleatórios, envelopes truncados, `kind` inválido, `seq` fora de ordem, payload de
  outro `kind`) provando que **nenhuma** lança e que toda uma delas mapeia para um dos três
  desfechos. `fold.panic` precisa ser 0. Este teste é o que sustenta §8.5.
- **`permissions`**: 17 permissões × cargos do dataset × hierarquia (acima/igual/abaixo/
  Fundador/host) × os três casos de anti-escalada.
- **`opCodec`**: round-trip dos 38 `kind`s com `sequenceScope`; forma canônica estável (mesmo
  input ⇒ mesmo `opId`, byte a byte); assinatura cobre o escopo; tolerância a bytes extras;
  rejeição de `v` desconhecido e de `v = 1` sem escopo.
- **`idgen`**: determinismo, ausência de colisão em 10⁸ tuplas e ids distintos para o mesmo
  `(communityId, author, authorSeq)` em `community` e em dois canais diferentes.

**Meta:** ≥ 98 % de linha nesses quatro. Fora deles, cobertura não é meta.

### 28.2 Harness multi-instância

N núcleos no mesmo processo de teste, sobre `hyperdht/testnet`. **Nunca toca a DHT
pública.** Cenários obrigatórios, todos vindos de risco real:

1. As **oito corridas** de §21.1, com projeção atrasada e reinício do host no meio →
   nenhuma produz registro inaplicável nem divergência.
2. Host cai no meio de um envio → a mensagem fica na fila e é entregue no retorno.
3. Membro volta depois de 1 000 mensagens → interpreta o atraso todo sem buraco.
4. Banido tenta replicar → todo par recusa o canal, não só o host.
5. Convite delegado (criador ≠ host) resgatado com o host **sem o segredo** → 100 %.
6. `maxUses=1` com 10 candidatos simultâneos → exatamente um `member.join`.
7. Reenvio do mesmo envelope 3× → um `seq`, `E_DUPLICATE` nas repetições.
8. Envelope colhido do log de A appendado no core de B → `REJECTED` com
   `E_WRONG_COMMUNITY` em toda réplica de B.
9. Host adversário appenda `mod.ban` autorado por quem não tem `ban_members` → `REJECTED`
   em toda réplica, inclusive na do próprio host.
10. Timeout aplicado durante envio → `E_TIMED_OUT`; expira e volta a passar.
11. Host sai com `draining` → barreira de replicação cumprida ou `shutdown.forced` honesto.
12. `opVersion` incompatível → somente-leitura, outbox drenada como `client-outdated`.
13. Sucessão: host some por `HOST_INACTIVITY_MS` → sucessor assume, membros migram.
14. Um autor enfileira mensagens em pelo menos 8 canais com atrasos independentes → todos os
    envelopes são aceitos uma vez, sem `E_DUPLICATE` para uma operação nunca observada e sem
    `E_AUTHOR_SEQ_OVERTAKEN`; cada contador é monotônico dentro de seu `sequenceScope`.
15. Log com buracos e watermark acima de um item ausente → a reconciliação consulta o
    `opId` em `observed_ops` e mantém o item; nunca o reporta como entregue.
16. Kill com itens em `sending` antes do append e depois do append/antes do ACK → boot os
    devolve a `queued`, preserva `attempts`, e o reenvio produz no máximo um efeito lógico.
17. Grupo com 32/64 submissões concorrentes e falha de append → há mais de um registro no
    grupo nominal, nenhum ACK parcial e o `DS` provisório inteiro é descartado na falha.

### 28.3 Injeção de falha real

A injeção acontece **no harness**, nunca por superfície do produto: o teste monta o núcleo
real e derruba, atrasa ou degrada as portas injetadas (transporte, corestore, relógio,
manifest). O roteador `dev.*` que a redação anterior pressupunha foi removido em 2026-08-28
(§15.3) — o que ele oferecia, o harness já alcança pelo mesmo lugar por onde a composição
monta o núcleo, e sem manter uma classe de autorização viva no produto para isso.

Matriz de crash obrigatória: `SIGKILL` antes do append, depois do append/commit e antes do
ACK, depois do ACK, entre o commit de `view.db` e o de
`manifest.db`, durante a reprojeção, durante o `wipe` em cada estágio, durante o staging de
blob. Oráculo: **nenhuma operação confirmada é perdida; nenhuma é duplicada; o boot sempre
converge.**

### 28.4 Determinismo do `fold`

Três testes, todos em CI, contra um core de referência com ≥ 5 000 registros cobrindo os 38
`kind`s **e** ≥ 200 registros deliberadamente inválidos:

1. **Reprojeção idêntica:** apagar `view.db` e reprojetar do `seq` 0 produz o mesmo hash de
   dump ordenado.
2. **Convergência entre réplicas:** N réplicas independentes produzem o mesmo hash.
3. **Snapshot equivalente:** interpretar com snapshot a cada K registros produz o mesmo
   `DecisionState` que interpretar sem snapshot.

**É o teste que protege a decisão-raiz A02.** Se ele quebrar, a arquitetura deixou de ser
verdade e precisa ser reavaliada, não remendada.

### 28.5 Adversário

- Host modificado que appenda op com autoria alheia → toda réplica recusa.
- Host modificado que appenda op de outra comunidade → `E_WRONG_COMMUNITY`.
- Host modificado que reescreve `hostTs` → `E_BAD_HOST_SIGNATURE`.
- Cliente que manda payload fora dos limites → recusado no estágio certo.
- Força bruta de convite: 10 000 tentativas em 60 s → todas recusadas, conexão fechada por
  tentativa, rate limit por chave e por /24 mordendo.
- Renderer que tenta `blob.stage` com caminho arbitrário → não existe superfície.
- Renderer que tenta `identity.wipe` sem token → `E_PERMISSION_DENIED`.

### 28.6 Performance

Benchmarks com **assert de limite** (falham o CI), contra §26.1. Dataset sintético: 3
comunidades, 100 k mensagens, 340 membros, 500 anexos. Cada execução publica ambiente,
versões, lockfile, dataset, amostras, warm-up e percentis.

### 28.7 Paridade com as fixtures

Os fluxos de `frontend.md` §11 rodados contra o backend real, com o dataset de referência
recriado por `dev.seedDataset` **a partir de ops reais** — o que exige que o dataset seja
produzível pelo modelo (`RT-14`, `DR-50`). As quatro divergências estão resolvidas em
`deltas-ux-v2.md` §3. **Se um fluxo precisa de estado que o backend não produz, é buraco de
backend, não de UI.**

---

## 29. Fases de implementação e gates

**Nenhuma fase começa antes do gate que a precede.** A definição completa de cada gate,
com hipótese, critério e consequência de falha, está em
`plano-de-validacao-experimental-v2.md`.

| # | Fase | Entrega | Gate de entrada |
|---|---|---|---|
| **0** | **Runtime** | Electron empacotado com `better-sqlite3`, `hypercore`, `sodium-native`, `udx-native` em `utilityProcess`, na matriz de plataforma fechada; lock composto; `safeStorage`; crash/restart | — |
| **1** | **Fundação de fronteira** | IPC-R com `epoch`/`subId`/`evSeq`/ack/resync; IPC-M; classes de autorização; deep link; identidade; export/import | **G0**, **G10** |
| **2** | **`fold` e log** | Os 38 `kind`s, `DecisionState`, pipeline de admissão, efeitos, projeção, reprojeção, snapshot, determinismo em CI | **G1** |
| **3** | **Escrita durável** | Outbox, group commit, barreira de durabilidade, reconciliação, máquina de estados, descarte nomeado | **G4** |
| **4** | **Replicação e rede visível** | Autorização de canal, escalonador multicomunidade, estados de replicação, presença/typing agregados, não-lidas | **G2**, **G6** |
| **5** | **Convites e entrada** | Canal de admissão, preview de 6 desfechos, resgate atômico, revogação | **G3** |
| **6** | **Busca e anexos** | FTS5, core de blobs por autor, ticket de staging, download, seeding, cotas, allowlist de tipo | **G5** |
| **7** | **Voz e câmera** | WebRTC mesh, STUN/TURN comunitário, tickets, revogação, dispositivos | **G7** |
| **8** | **Tela (estrela)** | Captura autorizada, estrela sem teto de audiência (§90), qualidade por espectador, saúde ao apresentador | **G8** |
| **9** | **Relay voluntário** | TURN voluntário com prova de posse, TTL, cota, consentimento | **G7** |
| **10** | **Continuidade** | Escrow, sucessão, migração, detecção de fork | **G12** |
| **11** | **Conversa direta (DM)** | §31 — par de logs de escritor único, merge determinístico, sem host e sem outbox; anexos herdam a fase 6 e mídia herda G7/G8 | **G14** |
| **— (fora do v1)** | **Árvore de multicast** | §17.8 | **G13 / POC-09** |

**Emenda de 2026-09-04 — estado das fases, e a origem da evidência.** Todas as fases do
v1 estão implementadas. As fases **3**, **7**, **8** e **10** passaram a `validada` por
**evidência de operador**: o produto empacotado para Windows e Linux foi exercitado com
outros usuários, em uso normal (`sequenciamento-pos-fase-0.md` §123). Isso substitui, como
condição de release, o rerun multicanal de `opVersion` que esta nota exigia da fase 3 e os
`openCriteria` de G7/G8 que `backlog.md` B4 carregava.

**O que essa evidência não é, e a distinção é normativa.** Ela não é medida instrumentada:
`tc/netem`, CGNAT real e as limitações de evidência de G4-E1/E2 **continuam sem medida**, e
os artefatos de gate em `poc/poc-08-g7` e `poc/poc-09-g8` continuam com veredito `parcial` —
não foram alterados, porque reescrevê-los para casar com uma decisão de operador seria
alterar artefato de validação. **`L-11` e `L-11b` (§25.8) continuam válidas e continuam
obrigadas às superfícies de UI que elas declaram**: a causa que descrevem não foi refutada
por uso real em redes que funcionam. §123.2 registra o alcance exato.

**A fase 11 entra no v1 por decisão do operador (2026-09-01).** Ela é a última porque
reusa o caminho de anexos da fase 6 (§31.14) e o de mídia das fases 7–8 (§31.15); o que
**não** espera é o gate: `dmCodec` e `dmFold` são L1 puros, então **G14 pode ser
executado a partir da fase 2**, e reprovar cedo é o que impede escrever as fases
seguintes sobre um merge que não converge. O caminho de implementação está em
`backlog.md` (B54..B62).

Fases 2 e 3 juntas derrubam quase todas as fixtures. **A fase 10 é cortável do v1 sem
quebrar o produto** — sem ela, a limitação L-15 vira "não há sucessão", o que precisa ser
dito na UX.

---

## 30. Ambiguidades

### 30.1 Fechadas por este documento

Fonte da verdade do estado · atomicidade validação↔append · política de registro inválido ·
reprojeção completa e o que ela preserva · origem de todo id · dedupe sem janela ·
escopo do `authorSeq` por canal e comunidade · índice de `opId` observado para reconciliação ·
durabilidade e critério de liberação da outbox · protocolo de convite delegado ·
consumo atômico de `maxUses` · alcançabilidade dos seis desfechos de preview · ownership e
caminho de escrita de anexos · origem do caminho de arquivo · retomada de staging ·
contrato de IPC com crash, backpressure e reconexão · fronteira da chave privada ·
autorização de comando · vínculo da assinatura à comunidade · assinatura de `hostTs` ·
isolamento entre comunidades · autorização de replicação · cargo base na anti-escalada ·
ponto de aplicação de `mention_everyone` · enum de `hostStatus` · schema de todas as
queries · quem reagiu · não-lidas de thread · aba Links · preferências legíveis ·
participantes de voz na sidebar · fala ativa · `/m/:code` · carimbo exibido · `handle` ·
ordenação de cargos · reação idempotente · ciclo de vida do expulso/banido · revogação de
mídia · saída do host · sucessão · detecção de fork · catálogo de erros completo ·
constantes de protocolo × configuração.

### 30.2 Ainda abertas, com dono e prazo

| # | Ambiguidade | Por que continua aberta | Quando decide |
|---|---|---|---|
| A-1 | Taxa real de conexão direta por classe de NAT | Não há medida; o "95 %" de v1 era auto-reportado | **G7**, antes da fase 7 |
| A-2 | Teto real de membros por comunidade | Depende do fan-out de conexões no host | **G9**, antes de anunciar 340 |
| A-3 | Custo do host como STUN/TURN | Só medível com carga real | **G7** |
| A-4 | Multi-dispositivo | Fora do v1; o backup de §5.5 é import em instalação nova, não sincronização | Depois do v1 |
| A-5 | Disponibilidade com host offline | `blind-peering` replicaria cifrado sem ler; não escolhido | Se o SPOF do host virar reclamação recorrente |
| A-6 | Notificação com app fechado | Fora do v1 | Depois do v1 |
| A-7 | Árvore de multicast | §17.8 | **G13/POC-09** |
| A-8 | Rotação da Data Key | Fora do v1 (L-3) | Depois do v1 |

---

## 31. Conversa direta entre identidades (DM)

Contraparte normativa de **A29**. Fecha a forma que `backlog.md` **B23** registrava como
aberta. **A conversa direta entra no v1 como a fase 11 de §29** — decisão do operador,
2026-09-01. A implementação continua bloqueada até **G14** passar (§31.26), e o caminho
está quebrado em itens ordenados em `backlog.md` (B54..B62).

Esta seção é **independente de §6–§19**: nada aqui pressupõe comunidade, canal, cargo,
permissão, convite ou host. Onde ela reusa um mecanismo, cita a seção de origem e diz o que
muda. Onde ela **não** reusa, diz por quê.

### 31.0 O que esta seção decide, e o que ela reusa

Classificação de cada peça, exigida antes de qualquer decisão nova:

| Assunto | Situação | Onde |
|---|---|---|
| Identidade e assinatura Ed25519 | **REUTILIZÁVEL** sem alteração | §5.1, §6.1 |
| Chave de identidade como nó na DHT | **REUTILIZÁVEL** sem alteração | **L-24** (§14.3) |
| Conversão Ed25519 → X25519 e `crypto_box`/AEAD | **REUTILIZÁVEL** sem alteração | §5.1 |
| Derivação por prefixo de domínio | **REUTILIZÁVEL**; prefixos novos entram na tabela fechada | §5.2 |
| Hypercore de escritor único | **REUTILIZÁVEL** sem alteração | A01, §14.1 |
| `corestore` com chave explícita, nunca namespace aleatório | **REUTILIZÁVEL** sem alteração | §5.3 |
| Barreira de durabilidade do `append` | **REUTILIZÁVEL**; o alcance declarado em §10.7.1 vale igual | §10.7.1 |
| `fold` puro, total, determinístico; três desfechos | **REUTILIZÁVEL** como **disciplina**; a função é outra | §8.0, §8.5 |
| Autorização de canal de replicação por consulta ao próprio estado | **REUTILIZÁVEL** com predicado próprio | §14.3(1) |
| Controle de admissão do transporte (teto de bytes, bucket, orçamento) | **REUTILIZÁVEL** sem alteração | §14.4 |
| Canal de admissão para par desconhecido | **REUTILIZÁVEL** como padrão | §12.3, §12.6 |
| Prova de posse de chave derivada | **REUTILIZÁVEL** como padrão | R-19, §5.2 `relay-possession/1` |
| Prova viva (RPC) + prova durável (no log) | **REUTILIZÁVEL** como padrão | §12.3/§12.4 (`liveProof`/`joinProof`) |
| Anexos: core de blobs do autor, `AttachmentRef`, verificação de hash, teto por bytes recebidos | **REUTILIZÁVEL** sem alteração | §13 |
| Tombstone como semântica de deleção | **REUTILIZÁVEL** sem alteração | A26 |
| Reação idempotente `set{present}` | **REUTILIZÁVEL** sem alteração | A11 |
| Ids determinísticos derivados de `(escopo, autor, contador)` | **REUTILIZÁVEL** com escopo trocado | §7.3 |
| Não-lidas como estado local por watermark | **REUTILIZÁVEL** sem alteração | A28, §6.15 |
| Dois bancos: `manifest.db` autoritativo, `view.db` derivado | **REUTILIZÁVEL** sem alteração | A03 |
| Snapshot de estado interpretado | **REUTILIZÁVEL** sem alteração | §10.6 |
| Envelope IPC-R (`epoch`, `subId`, `evSeq`, ack, resync) | **REUTILIZÁVEL** sem alteração | A14, §15.1 |
| Ciclo de vida de réplica removida (`retain_until`, `forget`) | **REUTILIZÁVEL** com o mesmo formato | §18.4 |
| Detecção de fork, sem merge automático | **REUTILIZÁVEL** sem alteração | §18.9 |
| WebRTC ponta a ponta; STUN/TURN servido por um par | **REUTILIZÁVEL**; o papel do host é assumido simetricamente | §17.2, §17.3 |
| Outbox de §11 | **NÃO REUTILIZADA** — não há submissão a host; §31.10 | §11 |
| `HostRecord`, `hostTs`, `hostSig` | **NÃO REUTILIZADOS** — não há host; §31.4 | §7.1 |
| Ticket de mídia de §17.4 | **NÃO REUTILIZADO** — o canal direto autenticado dá a mesma propriedade; §31.15 | §17.4 |
| Catálogo de 38 `kind`s e `opVersion = 3` | **NÃO REUTILIZADO e NÃO TOCADO** — a DM tem registro e versão próprios; §31.4 | §7.4 |
| Convite e admissão de §12 | **NÃO REUTILIZADOS** como mecanismo; reutilizada só a **forma** do canal pré-membro | §12 |
| Ordem por `seq` de um log único | **INSUFICIENTE** — há dois logs e nenhum serializador; §31.6 é **NOVO** | §7.5 |
| Regra de consentimento para contato não solicitado | **NOVO** — §31.9 | — |
| Confidencialidade do payload no core | **NOVO** — §31.3, §31.4 | — |
| Identificador de conversa | **NOVO** — §31.2 | — |
| Protocolo de handshake `p2p-dm/1` | **NOVO** — §31.8 | — |

### 31.1 O modelo

> **Uma conversa direta é um par de Hypercores de escritor único — um por participante —,
> replicados apenas entre os dois, cujo estado é `dmFold(merge(logPróprio, logDoPar))`:
> uma função pura, total e determinística sobre a intercalação canônica dos dois logs.**

Consequências, todas normativas:

| Propriedade | Como decorre |
|---|---|
| **Não há host.** | Cada parte é a autoridade de ordem do **próprio** log e de mais nada. Não existe admissão, não existe fila de submissão, não existe `hostTs`. |
| **Escrever nunca depende do outro estar online.** | A escrita é `core.append` local. O que depende de rede é a **entrega**, que é replicação. |
| **As duas partes são simétricas.** | Não há fundador, cargo, permissão nem moderação. As únicas assimetrias possíveis são locais: aceitar, bloquear, esquecer. |
| **Não existe registro venenoso.** | `dmFold` é total, pela mesma regra de §8.5. Bytes hostis, `kind` desconhecido, referência inexistente e assinatura falsa mapeiam para `APPLIED`/`REJECTED`/`IGNORED`. |
| **Réplicas convergem.** | Mesmo par de logs, mesma função de merge, mesma função de interpretação. Divergência só é possível por bug, detectável por hash de dump (G14). |
| **A projeção é descartável.** | Ela é a materialização de `dmFold(merge(...))`. A03 vale sem alteração. |
| **Não há outbox.** | Não há a que submeter. §31.10. |

**Por que não é uma comunidade degenerada de dois** (a alternativa que A29 mantinha aberta):
a razão que decide não é custo, é impossibilidade estrutural. Numa comunidade, o estágio 3
de §8.2 recusa todo registro cujo `communityId` não seja o do core, e §7.3 escopa **todo id
de entidade** por comunidade. Duas comunidades-de-um — que é a única forma de a comunidade
degenerada não herdar o problema de host offline — não conseguem referenciar uma à outra:
uma reação ou resposta a uma mensagem do outro lado é `REJECTED` por construção. Uma
comunidade **única** de dois não tem esse problema e tem o outro: quem não hospeda não
escreve com o host offline. As três razões restantes estão em A29.

### 31.2 Identidade da conversa

```
lo, hi         = as duas chaves públicas de identidade, ordenadas por byte, ascendente
conversationId = BLAKE2b-256('dm-conv/1' ‖ lo ‖ hi)          → 32 B, hex64 no IPC
```

Regras normativas:

1. O identificador é **derivado, não atribuído**. Não existe registro de criação, não existe
   negociação e não existe autoridade que o emita. Os dois lados o computam sozinhos.
2. É **simétrico**: `id(A,B) = id(B,A)`. Ordenar por byte é o que torna isso verdade sem
   convenção de "quem começou".
3. **Existe no máximo uma conversa por par.** Não há forma de criar uma segunda, e isso é
   deliberado: uma DM é a relação entre duas identidades, não um objeto que se instancia.
4. É **estável para sempre**: exclusão local (§31.19), reinstalação com a identidade
   restaurada (§5.5) e recontato posterior produzem o **mesmo** identificador. Recriar uma
   conversa é retomá-la.
5. Conversa consigo mesmo é `E_VALIDATION.peerKey`. `lo = hi` não é conversa.
6. O identificador viaja **dentro do material assinado** de todo registro (§31.4). Isso lhe
   dá a propriedade de A07: um envelope colhido da conversa X não tem efeito na conversa Y.
7. Ele **não** é publicado na DHT e não é tópico de nada (§31.8). Quem já conhece as duas
   chaves consegue derivá-lo; isso é a mesma classe de exposição de uma `discoveryKey` e
   está declarado em §31.21.

### 31.3 Chaves e derivações

Nenhuma primitiva nova. Todas já estão em §5.1.

```
dmCoreSeed     = BLAKE2b-256('ns/dm/1' ‖ identitySeed ‖ conversationId)
(dmPk, dmSk)   = ed25519_keypair_from_seed(dmCoreSeed)

dmShared       = X25519(x25519_from_ed25519_sk(identitySk_próprio),
                        x25519_from_ed25519_pk(identityPk_do_par))
dmContentKey   = BLAKE2b-256('dm-content/1' ‖ dmShared ‖ conversationId)

dmCoreProof    = Ed25519(identitySk, BLAKE2b('dm-core-possession/1'
                                             ‖ conversationId ‖ dmPk))

dmNonce(r)     = BLAKE2b-192('dm-nonce/1' ‖ conversationId ‖ r.author ‖ r.authorSeq)
dmBlobsSeed    = BLAKE2b-256('ns/dmblobs/1' ‖ identitySeed ‖ conversationId)
dmTurnSecret   = BLAKE2b-256('ns/dmturn/1' ‖ dataKey ‖ conversationId)
```

Regras normativas:

1. **`dmCoreSeed` deriva do `identitySeed`.** Consequência exigida: quem restaura a
   identidade pelo backup de §5.5 recupera **a própria metade de toda conversa**, sem que o
   arquivo de backup carregue um único campo novo. É o mesmo argumento da emenda de
   2026-08-22 de §13.1 para o core de blobs do membro, e vale pela mesma razão.
2. **O par não consegue derivar o seu core**, e isso é a propriedade que se quer: dois
   escritores no mesmo core produzem fork (§18.9). O par aprende a **chave pública**
   `dmPk` pelo handshake (§31.8) e a verifica com `dmCoreProof`, exatamente como R-19
   verifica a posse da chave de relay.
3. **`dmContentKey` é simétrica e estática.** Os dois lados a computam do próprio segredo de
   identidade e da chave pública do outro. Ela **não** é transmitida, nem cifrada, nem
   embrulhada: ela não existe em repouso em lugar nenhum.
4. **O `dmNonce` é derivado, não armazenado.** `(author, authorSeq)` é único por
   construção (RD-3), então não há reuso de nonce, e o registro não carrega 24 bytes de
   nonce.
5. **`dmShared` e `dmContentKey` são zerados após o uso**, pela mesma regra do item 4 de
   §3.2.
6. Nenhum material derivado aqui cruza o IPC-R, em nenhuma forma, nem truncado, nem em erro,
   nem em log (§3.2 item 5, sem exceção nova).

**O que a cifra do payload compra, e o que ela NÃO compra.** Ela torna a chave do core uma
**chave de replicação, não uma chave de leitura**: quem obtiver `dmPk` — que trafega no
handshake e é gravada em claro no manifesto — não lê nada sem uma das duas chaves privadas
de identidade. Isso também é o que deixa a porta aberta para um terceiro sedimentar o core
no futuro sem ler a conversa. Ela **não** torna a conversa confidencial em repouso: a
projeção em `view.db` guarda o conteúdo em claro, como todo o resto, e **L-21** vale
integralmente. Afirmar o contrário seria exatamente o erro que §31.21 proíbe.

### 31.4 Estruturas assinadas e encoding (`dmVersion = 1`)

```
DmOp       = { v:uint8, conversationId:bytes[32], kind:uint16, author:bytes[32],
               authorSeq:uint64, ts:uint64, ack:uint64, payload:bytes }
DmEnvelope = { op:bytes, sig:bytes[64] }
             sig     = Ed25519(author, BLAKE2b('dm-op/1' ‖ op))
             payload = XChaCha20-Poly1305(dmContentKey, dmNonce(op),
                                          plaintext, aad = cabeçalho do DmOp)
```

`DmEnvelope` é o que é appendado. Não há `HostRecord`, não há `hostTs`, não há `hostSig` e
não há `flags`: **não existe host para carimbar coisa nenhuma.** O índice no core faz o papel
que o `seq` faz em §7.1, mas **não é ordem canônica** — a ordem canônica é §31.6.

| Campo | Papel | Por que existe |
|---|---|---|
| `v` | `DM_VERSION`, hoje `1` | Registro versionado próprio; **não** é `opVersion` e não interage com ele |
| `conversationId` | Vínculo criptográfico à conversa | Propriedade de A07: envelope de outra conversa não tem efeito |
| `kind` | `uint16` do enum fechado de §31.5 | Nunca string no fio |
| `author` | Chave de identidade de quem escreveu | O `fold` confere contra o dono do core; também entra no nonce e na AAD |
| `authorSeq` | Contador estritamente crescente por conversa | Id determinístico (§31.4) e verificação de integridade do core (RD-3) |
| `ts` | Relógio do autor, em ms UTC | **Só exibição.** Sem host não há relógio neutro; §31.6 |
| `ack` | Quantos registros do log do par o autor havia interpretado | **É o mecanismo de ordem e de entrega.** §31.6, §31.11 |
| `payload` | Ciphertext AEAD | §31.3 |

**O cabeçalho fica em claro; só o `payload` é cifrado.** Deliberado: a ordem (§31.6), a
deduplicação e a verificação de integridade precisam ser computáveis sem a chave de
conteúdo. É isso que mantém a replicação por um terceiro possível no futuro sem torná-la uma
leitura. O que o cabeçalho em claro vaza está em §31.21.

**Encoding.** `compact-encoding`, com registry versionado por `kind`, próprio, separado do
de §7.2. As cinco regras invioláveis de §7.2 valem **na íntegra**, com uma substituição de
nome: onde §7.2 diz `opVersion`, leia `DM_VERSION`; onde diz "a comunidade entra em
`partialInterpretation`", leia "a conversa entra em `partialInterpretation`, e as escritas
locais **naquela conversa** são bloqueadas com `E_VERSION_UNSUPPORTED`". O layout dos tipos
primitivos é o de §7.2.1, sem `Scope` (não há escopo: a conversa é o escopo) e sem `rank`
(não há ordenação fracionária).

**Identificadores determinísticos:**

```
dmEntityId(t) = PREFIXO + crockford32(BLAKE2b-128('id/dm-' ‖ t ‖ '/1'
                            ‖ conversationId ‖ author ‖ authorSeq))
```

| Entidade | `t` | Prefixo |
|---|---|---|
| Mensagem de DM | `message` | `dmsg-` |

Uma só entidade tem id: a mensagem. Reação, edição e deleção referenciam a mensagem e não
têm identidade própria. As propriedades de §7.3 valem iguais — 128 bits, escopado à conversa,
derivado de um trio único por construção, nunca gerado por ninguém que não seja o autor.

Chave primária de toda tabela de conteúdo de DM é `(conversation_id, id)`.

### 31.5 Catálogo de ops

`Própria` = só atua sobre registro do próprio autor.

| `kind` | # | Payload (plaintext, antes do AEAD) | Própria | Notas |
|---|---:|---|---|---|
| `dm.hello` | 1 | `key peerKey · sig coreProof · str displayName · u8 avatarColor` | — | **Obrigatoriamente o índice 0** de todo core de DM (RD-1) |
| `dm.profile` | 2 | `opt<str> displayName · opt<u8> avatarColor` | sim | Perfil **por conversa**, como §6.3 já faz por comunidade |
| `dm.message` | 3 | `str content · opt<blobref+meta> attachment · opt<id> replyToId` | — | `attachment` completo: `blobref · str name · u64 sizeBytes · u8 kind · key hash` |
| `dm.edit` | 4 | `id messageId · str content` | sim | — |
| `dm.delete` | 5 | `id messageId` | sim | Tombstone (A26) |
| `dm.react` | 6 | `id messageId · str emoji · bool present` | — | Idempotente e convergente (A11) |

**Total: 6 `kind`s.** O número é normativo e **fechado para `DM_VERSION = 1`**, pela mesma
regra que fecha os 38 de §7.4. Um `kind` sem linha aqui é `E_UNKNOWN_KIND` na escrita e
`IGNORED` na leitura.

**O que deliberadamente não existe, e por quê:**

| Ausente | Razão |
|---|---|
| `dm.read` (confirmação de leitura) | Estado de leitura é do leitor (**A28**), e uma confirmação de leitura é metadado que o produto passaria a vazar por decisão de protocolo. **Entrega** já é observável sem `kind` novo, pelo `ack` (§31.11). Acrescentá-la depois é compatível: um `kind` novo com `DM_VERSION = 2` |
| `dm.close` / `dm.block` | Bloquear é **silencioso** (§31.9). Anunciar o bloqueio ao bloqueado transforma o bloqueio num sinal para escalar |
| `dm.pin`, `dm.thread` | Não há produto que os peça numa conversa de dois, e §7.4 é o precedente: `kind` sem uso é superfície declarada que ninguém alcança |
| Moderação de qualquer forma | Não há hierarquia entre duas pessoas. Apagar mensagem do outro não existe; o que existe é bloquear e esquecer |

### 31.6 Ordem canônica — o merge determinístico

Esta é a única peça verdadeiramente nova do modelo, e é a que o gate G14 mede.

**Relógio vetorial de duas posições.** Para um registro `r`:

```
r do log de lo, no índice i  →  V(r) = ( i + 1 , r.ack )
r do log de hi, no índice j  →  V(r) = ( r.ack , j + 1 )
```

As coordenadas são fixas — `(posição no log de lo, posição no log de hi)`, com `lo`/`hi` os
de §31.2 —, então a definição não depende de quem está lendo.

**Chave de ordem.**

```
ordSum(r)  = V(r).lo + V(r).hi
ordKey(r)  = ( ordSum(r) , authorKey(r) )        // desempate por chave, byte ascendente
```

**Regra normativa:** a ordem canônica de uma conversa é `ordKey` ascendente. Nenhum outro
critério é canônico. `ts` é exibição; o índice no core é armazenamento.

Três propriedades, e as três são o que torna a decisão defensável:

1. **É um merge de duas listas já ordenadas.** Por RD-4 o `ack` é não decrescente ao longo
   do log de quem escreve, e o índice cresce de 1 em 1; logo `ordSum` é **estritamente
   crescente** dentro de cada log. A intercalação é um merge de dois ponteiros, não uma
   ordenação.
2. **Respeita causalidade.** Se `r` aconteceu antes de `s` — o autor de `s` já havia
   interpretado `r` quando escreveu —, então `V(r) ≤ V(s)` nas duas coordenadas e as duas não
   são iguais, logo `ordSum(r) < ordSum(s)`. Uma resposta nunca aparece antes do que ela
   responde.
3. **É estável.** `ordKey(r)` é função só do próprio registro e da sua posição no próprio
   log. Uma vez escrito, um registro **nunca muda de chave**. O que pode acontecer é um
   registro **chegar** e se inserir entre outros já exibidos — inserção retroativa, que é
   inerente a qualquer sistema sem serializador e que §31.16 obriga a UI a tratar
   (`dm.reordered`).

**Registros concorrentes** — os que nenhum dos dois havia visto quando o outro escreveu —
empatam ou se aproximam em `ordSum` e são desempatados pela chave do autor. O desempate é
arbitrário de propósito: qualquer critério que dependesse de relógio faria a ordem depender
do ambiente, contra a regra de §1.5.

**Relógio.** O `fold` **não** recusa nenhum registro por causa de `ts`, e a razão é
estrutural: sem host não existe carimbo neutro contra o qual comparar, e recusar por relógio
daria a uma parte com relógio quebrado o poder de destruir a conversa. Em vez disso:

- **RD-5** — `ts` é clampado para não decrescer dentro do próprio log (mesma forma de R-1).
- **`clockSkewed`** é marcado quando o `ts` do registro é menor que o `ts` do registro mais
  recente que ele reconhece por `ack`. Isso é uma impossibilidade **causal**, detectável sem
  relógio externo, e é melhor sinal do que a janela fixa de 24 h de R-2 — que aqui não teria
  contra o que ser medida.
- A UI exibe `ts`; com `clockSkewed`, exibe o aviso, como §6.7 já manda.

**`ack` mentiroso.** Uma parte pode escrever um `ack` maior do que o número de registros que
o par realmente escreveu, empurrando as próprias mensagens para o fim da ordem. O `fold`
**não** recusa, e a razão é que o dano é cosmético entre duas partes que já podem escrever o
que quiserem uma para a outra: não há terceiro a enganar. O registro cujo `ack` excede o
comprimento conhecido do log do par é marcado `ackAhead = true`, a UI mostra a conversa como
ordem provisória naquela faixa, e nada mais. Declarado em **L-27**.

### 31.7 O `dmFold`

#### 31.7.1 Assinatura e desfechos

```ts
// L1, puro. Sem I/O, sem relógio, sem configuração, sem exceção.
type DmContext = {                 // argumento, nunca leitura de ambiente
  conversationId: string
  loKey: Key; hiKey: Key           // §31.2
  contentKey: Uint8Array           // §31.3 — fornecido pela raiz de composição
}

type DmFoldResult = {
  decision: 'APPLIED' | 'REJECTED' | 'IGNORED'
  reason?: ErrorCode
  field?: string
  kind?: number                    // a partir do decode do cabeçalho
  author?: Key
  messageId?: string               // presente em APPLIED de dm.message
  ordSum?: number                  // presente em APPLIED
  tsClamped?: boolean              // RD-5
  ackAhead?: boolean               // §31.6
  effects: DmEffect[]
  next: DmState
}

function dmFoldRecord(prev: DmState, rec: RawRecord,
                      origin: 'lo' | 'hi', index: number,
                      ctx: DmContext): DmFoldResult
```

`contentKey` entra como **argumento**, pelo mesmo arranjo que §8.1 usa para o
`MessageLookup`: a função continua sendo função dos seus argumentos, e quem a supre é a raiz
de composição (§4). O `dmFold` não abre chaveiro, não lê banco e não conhece rede.

Os três desfechos, os significados e a regra de que **não existe um quarto** são os de §8.0 e
§8.5, sem alteração. Uma exceção lançada de dentro do `dmFold` é bug de severidade máxima: o
projetor a captura, registra `dmFold.panic{ordSum, kind}`, trata o registro como `IGNORED` e
**continua**.

#### 31.7.2 `DmState` — schema exato

```ts
type DmState = {
  conversationId: string
  interpretedOrdSum: number         // −1 antes do primeiro registro
  dmVersionSeen: number
  partialInterpretation: boolean
  unknownKinds: number[]            // §31.16.2 — o conteúdo de dm.partialInterpretation
  unknownVersions: number[]         // idem; ordenados, teto MAX_UNKNOWN_TAGS

  sides: {
    lo: SideState
    hi: SideState
  }

  messages: Map<Id, { author: Key, ordSum: number, deletedAt?: number,
                      editedAt?: number, replyToId?: Id,
                      hasAttachment: boolean,
                      reactionEmojis: Set<string> }>
}

type SideState = {
  identityKey: Key
  coreKey?: Key                     // do dm.hello daquele lado
  displayName: string
  avatarColor: number
  length: number                    // registros interpretados daquele lado
  lastAuthorSeq: number
  lastAck: number                   // RD-4
  lastTs: number                    // RD-5
  invalid: boolean                  // gênese fora de RD-1; absorvente, POR LADO
}
```

Não há `members`, `roles`, `channels`, `categories`, `invites`, `joinedByInvite`, `relays`
nem `lastAuthorSeq` por escopo. `O(mensagens)` é o único termo que cresce, e vale para ele a
**mesma regra de residência de §8.1**, palavra por palavra: `messages` é carregado sob demanda
de `view.db` só para a conversa com `residency = 'full'` (a aberta); as demais resolvem por
lookup indexado dentro da mesma transação de projeção.

**`unknownKinds` e `unknownVersions` — emenda de 2026-09-05.** §31.16.2 declara o payload de
`dm.partialInterpretation` com as duas listas, e §31.7.2 guardava só o booleano: a query
respondia "parcial" sem dizer de quê, e o evento não tinha como existir. As duas listas são
**diagnóstico**, nunca fluxo de controle — quem bloqueia a escrita local continua sendo
`partialInterpretation`, e ele não tem teto.

O teto delas (`MAX_UNKNOWN_TAGS = 8`) não é conforto: `v` e `kind` vêm do cabeçalho **em
claro** do par, antes de qualquer verificação estrutural (estágio 1), e um par adversário
appenda valores distintos no próprio log para fazer o `DmState` crescer sem limite. Guardar os
primeiros 8 distintos, em ordem de log, é determinístico e suficiente para a UI dizer o que a
conversa não soube ler. As listas entram no snapshot de §31.12 como o resto do estado.

#### 31.7.3 Pipeline de admissão (ordem fixa, determinística)

Roda idêntico nos dois lados, para todo registro, sempre.

| # | Estágio | Desfecho da falha |
|---:|---|---|
| **0** | Teto de bytes do registro, antes de qualquer decode: `len(rec) ≤ MAX_ENVELOPE_BYTES_ATTACHMENT` | `REJECTED` — `E_PAYLOAD_TOO_LARGE` |
| 1 | `DmEnvelope`/`DmOp` decodificam; `v` e `kind` conhecidos; cabeçalho casa o layout de §31.5 | `IGNORED` — `E_MALFORMED` / `E_UNKNOWN_KIND`; liga `partialInterpretation` só no caso de versão/`kind` desconhecido |
| 2 | `op.conversationId === ctx.conversationId` | `REJECTED` — `E_WRONG_COMMUNITY` (o código é o de §20.2; o significado é "envelope de outra conversa") |
| 3 | `op.author` é o dono do core de origem (`lo` ou `hi`, conforme `origin`) | `REJECTED` — `E_AUTHOR_MISMATCH` |
| 4 | `sig` válida sobre `BLAKE2b('dm-op/1' ‖ op)` com `op.author` | `REJECTED` — `E_BAD_SIGNATURE` |
| 5 | `op.authorSeq === index + 1` (**RD-3**) | `REJECTED` — `E_VALIDATION.authorSeq`, e marca o **lado** `invalid` |
| 6 | Forma da gênese, quando `index = 0` (**RD-1**) | `REJECTED` — `E_GENESIS_MISPLACED`, e marca o lado `invalid` |
| 7 | O lado de origem não está `invalid` | `REJECTED` — `E_VALIDATION` |
| 8 | AEAD abre com `dmContentKey` e `dmNonce(op)`, com o cabeçalho como AAD | `REJECTED` — `E_BAD_SIGNATURE` (a AEAD falhar é falha de autenticidade, não de sintaxe) |
| 9 | Payload decodifica e casa o layout do `kind` | `IGNORED` — `E_MALFORMED` |
| 10 | Limites de campo (§31.7.5) | `REJECTED` — `E_VALIDATION` + `field` |
| 11 | Regras estruturais do `kind` (§31.7.4) | `REJECTED` — código específico da regra |
| 12 | Emissão de efeitos e avanço do `DmState` | `APPLIED` |

Em **todos** os desfechos o estágio final atualiza `interpretedOrdSum`, `sides[origin].length`,
`lastAuthorSeq`, `lastAck` e `lastTs`. Um registro recusado **queima** o número, pela mesma
razão de §7.5: sem isso, uma recusa devolveria a posição e o índice do core deixaria de casar
com `authorSeq`.

**Não existe estágio de duplicata.** Um Hypercore não tem duas entradas no mesmo índice, e
RD-3 amarra `authorSeq` ao índice; um envelope replicado para outro core é recusado no
estágio 2 ou 3. **A deduplicação é estrutural: não há tabela, não há janela e não há
`lastAuthorSeq` por escopo.** É a simplificação mais direta que o modelo produz.

**Não existe estágio de autorização.** Não há permissão, hierarquia, cota determinística nem
membresia a conferir: uma conversa tem exatamente dois participantes e cada um escreve o
próprio log. As três regras de anti-escalada de §9.3 não têm análogo porque não há nada a
que escalar.

#### 31.7.4 Regras estruturais (`RD-*`), determinísticas e completas

| # | Regra | Aplica a | Falha |
|---|---|---|---|
| **RD-1** | **Gênese do lado.** O índice 0 de todo core de DM é um `dm.hello` com `authorSeq = 1`, `ack = 0`, `peerKey` igual à outra chave do par, `conversationId` conferindo com `BLAKE2b('dm-conv/1' ‖ lo ‖ hi)`, e `coreProof` válido sobre `BLAKE2b('dm-core-possession/1' ‖ conversationId ‖ chaveDoCore)` com a chave de identidade do autor. Qualquer desvio marca **aquele lado** `invalid`; a partir daí todo registro daquele lado é `REJECTED`. O outro lado **não** é afetado — é a diferença deliberada em relação a R-27, e ela existe porque os dois logs são independentes: uma conversa em que um lado está quebrado ainda é legível do outro | índice 0 | `E_GENESIS_MISPLACED` |
| **RD-2** | **`dm.hello` só no índice 0.** Um `dm.hello` em qualquer outro índice é `REJECTED` sem marcar `invalid` | `dm.hello` | `E_GENESIS_MISPLACED` |
| **RD-3** | **`authorSeq = index + 1`, sem exceção.** É a amarração entre o contador assinado pela identidade e a posição autenticada pela árvore do core. Um desvio significa core reescrito e marca o lado `invalid` | todos | `E_VALIDATION.authorSeq` |
| **RD-4** | **`ack` é não decrescente** ao longo do próprio log. Um registro que o faria decrescer tem `ack` **clampado** para o valor anterior (clamp determinístico, não recusa) — é o que preserva a monotonicidade de `ordSum` de que §31.6 depende | todos | — (clamp) |
| **RD-5** | **`ts` é não decrescente** ao longo do próprio log; clampado para o anterior quando decresceria, contando `dmFold.tsClamped`. `clockSkewed` é marcado quando `ts` é menor que o `ts` do registro mais recente reconhecido por `ack` | todos | — (clamp e flag) |
| **RD-6** | **Chave de core imutável por lado.** O `coreKey` de um lado é o que RD-1 fixou; nada depois o troca. Um handshake que anuncie chave diferente da já vinculada é recusado no transporte (§31.8), nunca aceito e nunca sobrescrito | `dm.hello`, §31.8 | `E_DM_CORE_MISMATCH` |
| **RD-7** | **Edição e deleção são só do próprio.** `dm.edit`/`dm.delete` cujo `messageId` não pertença ao autor são `REJECTED`. Não existe moderação numa conversa direta | `dm.edit`, `dm.delete` | `E_CANNOT_EDIT_OTHERS` |
| **RD-8** | **Alvo existente e vivo.** `dm.edit`, `dm.react{present:true}` e `replyToId` exigem mensagem existente e não deletada **na ordem canônica corrente**. `dm.delete` de já deletada é `APPLIED` idempotente sem efeito; `dm.react{present:false}` nunca é recusada | `dm.edit`, `dm.react`, `dm.message` | `E_MESSAGE_DELETED` / `E_VALIDATION.replyToId` |
| **RD-9** | Máx. `MAX_REACTION_EMOJIS` (20) emojis distintos por mensagem; `present:true` que estoure é recusada | `dm.react` | `E_REACTION_LIMIT` |
| **RD-10** | **Último a escrever vence, por `ordKey`.** `dm.profile`, `dm.edit` e `dm.react` convergem pelo maior `ordKey`, nunca por `ts`. É a mesma semântica de "maior `seq` vence" de §7.5, com a ordem de §31.6 no lugar do `seq` | `dm.profile`, `dm.edit`, `dm.react` | — (efeito) |
| **RD-11** | **Anexo é do autor.** O `blobsCoreKey` de um `attachment` precisa ser o core de blobs de DM do **autor daquela mensagem** (§31.14). Apontar para outro core é `REJECTED` — sem isso, uma parte faria a outra buscar bytes num core arbitrário | `dm.message` | `E_VALIDATION.attachment` |

**Resolução determinística de referência quebrada** — a política que substitui "reducer que
lança", pela mesma disciplina de §8.4.1:

| Situação | Resolução determinística |
|---|---|
| `dm.edit`/`dm.react{present:true}`/`replyToId` para mensagem que a ordem corrente ainda não contém | `REJECTED` — **`E_NOT_FOUND`** (emenda de 2026-09-05: o código estava sem nome; §31.7.4 só nomeava `E_MESSAGE_DELETED`, que é para o alvo tombstonado, e `E_NOT_FOUND` é o que §20.2 tem e o que R-8 usa no `fold`). Se o registro alvo chegar **depois** e se inserir antes (§31.6), a reinterpretação de §31.13 refaz o desfecho — o registro passa a ser `APPLIED` na releitura. É a única situação em que um desfecho muda, e ele muda porque a **entrada** mudou, não a função |
| `dm.delete` de já deletada | `APPLIED` idempotente, sem efeito |
| `dm.react{present:false}`, **em qualquer alvo** | `APPLIED` idempotente, sem efeito de estado — sem reação, sobre mensagem tombstonada, ou sobre alvo que a ordem corrente ainda não contém. **Emenda de 2026-09-05:** a linha dizia só "sem reação", e a linha acima dizia `dm.react` sem qualificar `present`, o que deixava as duas em conflito com RD-8 ("`present:false` **nunca** é recusada"). O `present` é testado **antes** do alvo, e a remoção só pode convergir para "não está lá": recusá-la produziria linha em `dm_rejected_records` por uma operação cujo desfecho é o mesmo nos dois lados |
| Colisão de `dmEntityId` | Impossível por construção (§31.4). Se ocorrer, é bug: o segundo é `REJECTED` com `E_ID_COLLISION` |
| Um lado `invalid` | O outro segue. A conversa é legível pela metade e a UI diz qual metade quebrou |

#### 31.7.5 Limites de campo

Todos são **constantes de protocolo** e todos são **reuso literal de §8.6**. Nenhum limite
novo é inventado:

| Campo | Mín | Máx | Igual a |
|---|---|---|---|
| `dm.message.content` | 1 | 4000 code points / 16384 bytes | `Message.content` |
| `dm.hello.displayName`, `dm.profile.displayName` | 2 | 32 code points | `Identity.displayName` |
| `avatarColor` | 0 | 7 | §6.4.2 |
| `dm.react.emoji` | 1 code point | 8 code points / 32 bytes | `Reaction.emoji` |
| `attachment.name` | 1 byte | 255 bytes | `Attachment.name` — **rejeita, não sanitiza** |
| `attachment.sizeBytes` | 1 | `ATTACHMENT_MAX_BYTES` | idem |
| Registro **sem** anexo | — | `MAX_ENVELOPE_BYTES` | idem |
| Registro **com** anexo | — | `MAX_ENVELOPE_BYTES_ATTACHMENT` | idem, conferido no estágio 0 |

A unidade de contagem é **code point**, pela mesma razão de §8.6: grafema depende da versão
do ICU, e isso faria a interpretação do log função do ambiente.

#### 31.7.6 Efeitos

```ts
type DmEffect =
  | { t:'upsert', table: DmTable, key: DmEntityKey, row: Record<string, Primitive> }
  | { t:'patch',  table: DmTable, key: DmEntityKey, fields: Record<string, Primitive> }
  | { t:'delete', table: DmTable, key: DmEntityKey }
  | { t:'notify', topic: EventTopic, data: object }
```

Quatro formas, contra as doze de §8.4. Não há `patchScope` — não há ban que oculte N
mensagens de um autor nem canal apagado que orfanize N mensagens, que são os dois casos que
o obrigaram a existir. Não há `ftsIndex`/`ftsRemove` (§31.12), não há `audit` (não há
moderação) e não há `recount` (não há contagem derivada de população).

O projetor aplica a lista **na ordem**, dentro de **uma transação por lote**, e emite os
`notify` **depois do commit** (§10.7). Ele não decide nada.

### 31.8 Descoberta, handshake e autorização

**Descoberta: nenhuma peça nova.** Por **L-24**, a chave pública de identidade **é** o nó na
DHT. `A` alcança `B` conectando-se à chave de identidade de `B`. Não há tópico de conversa,
não há registro em diretório e não há anúncio novo na DHT.

**Regra normativa (emenda de 2026-09-03):** um nó **com identidade** anuncia-se na DHT sob o
próprio par de identidade — que é o par do `Hyperswarm` (§14.3, emenda item 1) — e procura o
par de cada conversa em `accepted` ou `pending-out` pela chave dele. §14.1 ganha a linha
correspondente, **sem tópico**.

**Emenda de 2026-09-03 — por que a condição anterior tornava o primeiro contato impossível.**
A regra dizia "um nó com ao menos uma conversa em estado `accepted` ou `pending-out`
anuncia-se", e justificava a condição com a premissa de que "o lado que anuncia continua
anunciando a própria chave de identidade por causa de toda comunidade de que participa". A
premissa é **falsa para quem é apenas membro**: por §14.1 o host entra no tópico da
comunidade como `server` e o membro como `client`, e um nó que só é `client` nunca anuncia
par nenhum na DHT — não há a que `A` se conectar. E quem recebe o **primeiro** contato não
tem, por definição, conversa em `accepted` nem em `pending-out`: as duas metades juntas
faziam com que uma primeira mensagem só chegasse a quem hospeda comunidade.

Medido em DHT local com dois nós reais: enquanto `B` não anuncia, o `joinPeer` de `A` não
produz conexão nenhuma; no instante em que `B` anuncia, a conexão sobe nos dois lados. O
custo do anúncio incondicional é o que **L-24** já declara e **U-27** já avisa — a chave de
identidade é o endereço, e quem a tem sabe que você está online. Quem decide se um
desconhecido pode **falar** continua sendo a política de contato de §31.9 regra 5, que é
onde essa decisão sempre esteve; o anúncio não a substitui nem a antecipa.

**Alternativa considerada e não adotada: tópico derivado do segredo compartilhado.**
`BLAKE2b('dm-topic/1' ‖ dmShared)` seria computável só pelas duas partes e esconderia de um
nó da DHT próximo à chave de `B` o fato de alguém estar procurando `B`. Foi recusada por
duas razões: ela **não funciona no primeiro contato** — `B` não conhece `A` e portanto não
consegue computar o tópico —, então seria um segundo mecanismo ao lado do primeiro; e o
ganho é parcial, porque o lado que **anuncia** já anuncia a própria chave de identidade pela
regra normativa acima. Acrescentá-la depois é compatível: é otimização de rendezvous, não
contrato.

**Protocolo `p2p-dm/1`** — terceiro canal `protomux` de §16.1, ao lado de `p2p-community/1`
e `p2p-admission/1`.

| Método | Request | Response | Erros |
|---|---|---|---|
| `dmHello` | `{ dmVersion, conversationId, coreKey, coreProof }` | `{ dmVersion, state, coreKey?, coreProof? }` | `E_VERSION_UNSUPPORTED`, `E_DM_CORE_MISMATCH`, `E_DM_NOT_AUTHORIZED`, `E_VALIDATION` |

Notificações, sem `id`, sem resposta e sem retentativa, pela regra 1 de §16.3. **A tabela é
fechada, e tópico fora dela é descartado em silêncio** pelo cliente, como a de §16.3:

| Tópico | Payload |
|---|---|
| `dm.typing` | `{ on: bool }` — efêmero, TTL 5 s, refresh 3 s, teto de 1 / 2 s por conversa (mesmos números de §17.6) |
| `dm.signal` | `{ sdp?: string, ice?: string }` — **emenda de 2026-09-02.** SDP e ICE de uma chamada de dois (§31.15). Sem `ticketId` e sem `toPeerKey`: há um par só do outro lado, e quem ele é o Noise já autenticou. O núcleo **não lê** o conteúdo — a mídia é DTLS-SRTP ponta a ponta (§17.2) |
| `dm.call` | `{ on: bool, iceServers?: [{urls}], turnCredential?: {username, password} }` — **emenda de 2026-09-02.** "O outro está na chamada" (§31.15), a notificação efêmera que substitui o roster de §17.6. Quando `on`, ela leva o que **este** lado serve (§17.3 simétrico): a `turnCredential` foi emitida com o `dmTurnSecret` de quem a manda, e não é derivável do outro lado |

**Emenda de 2026-09-02 — `dm.signal` e `dm.call`, e por que elas são derivação e não decisão
nova.** §31.15 já mandava, em texto, que "SDP e ICE viajam por" este canal e que "o estado 'o
outro está na chamada' é uma notificação efêmera em `p2p-dm/1`, com a mesma disciplina
at-most-once de §16.3 regra 1". O que faltava era a **linha na tabela**, e sem ela a regra 2
comeria os dois tópicos em silêncio — a mesma omissão de `voice.failed` (§16.3, emenda de
2026-08-26), de `share.failed` e de `voice.occupancyChanged`, e a quarta ocorrência dela.
Aqui ela seria fatal em vez de invisível: sem estas duas linhas a chamada de §31.15 não tem
por onde negociar, e a seção inteira fica sem implementação possível.

Os campos são o que sobra de `voiceSignal` e de `voiceJoin` depois da tabela de remoções de
§31.15, e nenhum é novo: `sdp`/`ice` são os de §16.2, `iceServers`/`turnCredential` são os
de `voiceJoin`. O que some — `sessionId`, `toPeerKey`, `ticketId`, `roster`, `tickets[]` — é
uma linha declarada daquela tabela, uma a uma.

**Autenticação — quatro camadas, nenhuma delas nova:**

1. **Transporte.** Noise do `hyperdht`, com `remotePublicKey` verificada (§5.1). A
   identidade do par é conhecida **antes** de qualquer quadro de DM. Não há handshake de
   identidade em banda a construir.
2. **Vínculo da conversa.** O receptor recusa qualquer `dmHello` cujo `conversationId` não
   seja exatamente `BLAKE2b('dm-conv/1' ‖ min(remotePk, selfPk) ‖ max(remotePk, selfPk))`.
   Isso fecha impersonação e transplante de conversa **antes** de qualquer trabalho
   criptográfico caro, e é a mesma propriedade que A07 dá ao log.
3. **Posse do core.** `coreProof` prova que aquele core foi designado por aquela identidade
   para aquela conversa. Mesma forma de R-19. É a **prova viva**, e o `dm.hello` no índice 0
   do core é a **prova durável**, verificável para sempre — o mesmo par
   `liveProof`/`joinProof` de §12.3/§12.4.
4. **Autorização de canal de replicação.** Análogo direto de §14.3(1): ao abrir um canal
   `protomux` de replicação para um core de DM, **cada nó** consulta o próprio estado —

   ```
   autorizaDm(par, conversa) =
       par === conversa.peerKey
       && conversa.state ∈ { 'accepted', 'pending-in', 'pending-out' }
       && conversa.blockedAt === null
   ```

   Falha → recusa o canal com `E_DM_NOT_AUTHORIZED` e não replica nada. Em `pending-in` a
   replicação é **limitada** a `P2P_DM_PENDING_MAX_RECORDS` registros (§31.9). É isso, e só
   isso, que impede um terceiro de replicar um core de DM cuja chave tenha vazado.

**Replay.** Não há o que reproduzir: `dmHello` não carrega segredo e é idempotente; um
registro reproduzido cai no estágio 2 ou 3 do pipeline; a árvore de Merkle do Hypercore
torna impossível injetar um registro antigo em posição nova. Nenhum desafio *nonce* é
necessário, e inventar um seria mecanismo sem ameaça.

**Ordem de admissão do transporte**, por request: **(1)** teto de bytes → **(2)** bucket →
**(3)** decode → **(4)** verificação de assinatura → **(5)** `dmFold`. Nunca o contrário
(§14.4, sem alteração). Os valores estão em §31.18.

### 31.9 Consentimento, bloqueio e spam

O problema que A29 nomeia — "sem isso a chave de identidade vira endereço spammável" — é
resolvido pela forma do canal pré-membro de §12.3, aplicada a contato não solicitado.

**Estados de uma conversa** (estado **local**, nunca replicado):

| Estado | Significado | O que o nó faz |
|---|---|---|
| `pending-out` | Eu abri, o outro ainda não aceitou | Escrevo no meu core; sirvo meu core ao par; replico o dele se ele já tiver um. **Sai para `accepted` sozinho** quando o `dm.hello` do par chega (regra 7) |
| `pending-in` | Um par com quem eu não tinha conversa abriu comigo | Replico **no máximo** `P2P_DM_PENDING_MAX_RECORDS` registros do core dele; **não crio meu core**; a UI mostra como pedido |
| `accepted` | Eu aceitei | `dm.hello` é escrito no índice 0 do meu core, criando-o; replicação plena nos dois sentidos |
| `blocked` | Eu bloqueei | Recuso o canal e não conecto. **Silenciosamente** |
| `left` | Esqueci localmente (§31.19) | Blocos limpos, projeção removida, marcas de esquecimento preservadas |

Regras normativas:

1. **Aceitar é o que cria o meu core.** Antes do aceite não existe `dm.hello` do meu lado,
   logo não existe `ack` meu, logo o outro lado **não** observa entrega. Um pedido não
   aceito não confirma nada, e isso é a propriedade correta: aceitar é o ato.
2. **Bloquear é silencioso.** O bloqueado vê o mesmo que veria se eu estivesse offline: o
   `ack` dele não avança. Ele **não** consegue distinguir bloqueio de ausência. É decisão de
   segurança de produto: avisar transforma o bloqueio num sinal para escalar. Declarado em
   **L-28**.
3. **Bloqueio é local e permanente até revogado localmente.** Não vai para log nenhum,
   porque não há log compartilhado onde ele fosse verdade para os dois — e porque um
   bloqueio replicado seria o aviso que a regra 2 recusa dar.
4. **Teto de pendentes.** No máximo `P2P_DM_PENDING_MAX` conversas em `pending-in`
   simultâneas. Cheio → o nó recusa `dmHello` novo com `E_LIMIT_EXCEEDED` e `limit`. **Não
   há descarte silencioso do mais antigo:** um pedido que o usuário nunca viu não pode sumir
   sem ele saber.
5. **Filtro local de contato.** Preferência local `dmContactPolicy ∈ { 'anyone',
   'shared-community' }`, default `'anyone'`. Em `'shared-community'`, `dmHello` de um par
   com quem esta instalação não tem comunidade em comum é recusado com
   `E_DM_NOT_AUTHORIZED`. **É política local, não protocolo:** ela não faz a DM depender de
   comunidade — nada nesta seção muda de forma quando ela está ligada —, ela dá ao usuário a
   única defesa real contra Sybil que existe num sistema em que identidade é gratuita
   (**L-8**). O custo, e ele precisa aparecer na UI: ligada, ninguém de fora consegue falar
   com você pela primeira vez.
6. **Sem custo de entrada, sem prova de trabalho, sem reputação.** Um custo computacional
   por pedido puniria o usuário legítimo tanto quanto o spammer, e reputação exigiria lista
   compartilhada, que **L-17** já recusou para moderação.
7. **`pending-out` → `accepted` é derivado, não lembrado** (emenda de 2026-09-05). Uma
   conversa em `pending-out` cujo `dmHello` do par traga um `coreKey` passa a `accepted`, com
   `accepted_at` gravado. O que move o estado é a **existência do core do outro lado**, e pela
   regra 1 esse core só existe depois do aceite dele — `pending-out` quer dizer "o outro ainda
   não aceitou", e depois do hello isso deixou de ser verdade. Sem esta regra o lado que abriu
   ficava em `pending-out` para sempre numa conversa viva nos dois sentidos: o estado é local e
   **nunca replicado**, então não havia correção posterior nem ação do usuário que o desfizesse
   (não se "aceita" a própria abertura). Vale também para a abertura simultânea dos dois lados,
   em que os dois já consentiram. O estado continua **derivado**, na mesma disciplina do
   desbloqueio: `accepted_at` gravado é o que faz `dm.unblock` devolver a conversa a
   `accepted`.

### 31.10 Caminho de escrita — não há outbox

> **Escrever numa conversa direta é `core.append` no próprio core. A resposta do comando IPC
> é síncrona e reporta um registro que já está no log.**

Isso é uma **terceira classe de escrita**, ao lado das duas que A25 fixou, e o registro dela
é a mudança de contrato mais visível desta seção:

| Classe | Onde | Contrato |
|---|---|---|
| Síncrona com o host | estrutura, cargo, moderação, comunidade, convite (A25) | Exige host online; falha na hora com `E_HOST_UNAVAILABLE`; não enfileira |
| Assíncrona por outbox | domínio de mensagem de comunidade (A25, §11.1) | Fila durável; retorno imediato `{opId, state:'queued'}`; desfecho por evento |
| **Local-durável, entregue por replicação** | **toda op de DM (§31)** | **Retorno imediato com o registro já no log**; a **entrega** é observada depois, pelo `ack` do par |

Consequências normativas — o que **não existe** para DM, e por que a ausência é correta:

| Peça de §11 | Situação |
|---|---|
| `local_outbox` e a máquina de estados de §11.3 | **Não existe.** Ela modela "op esperando ser admitida"; aqui não há admissão |
| Group commit (§11.5) | **Não existe.** Ele amortiza `fsync` de submissões concorrentes de N autores; aqui há um autor |
| Reconciliação (§11.6) e `observed_ops` | **Não existem.** O registro está no meu próprio log: não há ACK a conferir contra réplica |
| Descarte com motivo nomeado (§11.7) | **Não existe.** Não há motivo pelo qual uma escrita minha no meu log deixe de existir |
| Backoff, breaker e anti-avalanche (§11.8) | **Reutilizados**, mas para **replicação**, não para escrita. A curva e o breaker de §11.8 valem sem alteração |
| `message.retry` / `message.cancelQueued` | **Não existem.** Não há nada pendente a retentar nem a cancelar; o que existe é apagar (`dm.delete`, tombstone) |

**Serialização por conversa — emenda de 2026-09-05.** O caminho de escrita de uma conversa é
**serializado**: ler `core.length`, derivar `authorSeq = index + 1` (RD-3), construir o
registro assinado e appendar formam **uma seção crítica por `conversationId`**, e duas
escritas na mesma conversa nunca a atravessam ao mesmo tempo.

Isto não reintroduz nada de §11. Não é fila durável, não tem estado persistido, não sobrevive
ao processo e não muda o contrato de resposta: continua síncrona, com o registro já no log. É
uma trava em memória, e existe porque `core.length` só avança quando o `await core.append`
resolve. Sem ela, dois `dm.send` em voo leem o mesmo comprimento e assinam o **mesmo**
`authorSeq` — o que quebra RD-3 no estágio 5 de §31.7.3, marca o lado `invalid`, e o estágio 7
torna a marca **absorvente**: a conversa nunca mais aceita escrita própria. Como `dmEntityId` é
função de `(conversationKey, author, authorSeq)`, as duas escritas ainda respondem com o mesmo
`messageId` e com sucesso.

A remoção da `outbox` (a tabela acima) tirou o único ponto onde a ordem por escopo estava
garantida; esta é a peça que a substitui, e é a menor que fecha a invariante. O `ack` de §31.6
é lido **dentro** da mesma seção, pela mesma razão: é o valor do momento do append.

**Durabilidade.** Vale §10.7.1 sem emenda: `await core.append(...)` é a barreira, ela cobre
**falha de processo** e não cobre queda de energia enquanto G4 não medir com `fsync`
observado. Aqui isso pesa mais do que numa comunidade, porque o log **é** a única cópia — não
há fila em `manifest.db` com `synchronous=FULL` atrás dele. §31.13 define a detecção, e
**L-26** declara a limitação de entrega que decorre do modelo.

### 31.11 Entrega, estados de mensagem e leitura

**Entrega é derivada, sem `kind` novo e sem estado replicado adicional.**

```
entregueAté(meuLado) = max( r.ack : r ∈ log do par )
```

Uma mensagem minha no índice `i` está **entregue** quando `entregueAté ≥ i + 1`. O número é
assinado pelo par, dentro do material que a chave de identidade dele autentica: entrega não
é palavra de ninguém, é atestado.

**Estados de mensagem — semântica normativa, tabela fechada:**

| Estado | Definição exata | Onde vive |
|---|---|---|
| `written` | O `core.append` resolveu. O registro existe no meu log, assinado, com posição fixa | Derivado do core |
| `delivered` | `entregueAté ≥ índice + 1`, ou seja: o par escreveu algo depois de ter interpretado esta mensagem | Derivado do log do par |
| `undelivered` | `written` e não `delivered` | Derivado |
| `deleted` | Existe um `dm.delete` meu apontando para ela, vencedor por `ordKey` | `DmState` |

**Não existem `queued`, `sending`, `awaiting-confirmation`, `failed` nem `dropped`.** Os
cinco pertencem à outbox, que não existe aqui. Um estado que não pode ocorrer não é
declarado.

**`undelivered` não distingue offline de bloqueado** (regra 2 de §31.9). A UI mostra "não
entregue" e o tempo desde a escrita; ela **não** pode afirmar por quê.

**Leitura.** Estado local, por **A28**, sem alteração de princípio: uma tabela
`dm_local_read_state` com watermark por `ordKey`, e a contagem é uma **query** sobre
`ordKey > lastRead`, não um acumulador — por isso não há contagem dupla e a reprojeção a
recomputa do zero. Zerada por `dm.markRead`.

**Confirmação de leitura não existe** (§31.5). O `ack` **não** é uma: ele só avança quando o
par **escreve**, e por isso atesta que os registros chegaram, não que alguém os leu. A UI é
proibida de rotular `delivered` como "lido".

### 31.12 Persistência

Dois bancos, exatamente como A03. Nenhum arquivo novo, nenhum banco novo.

**`manifest.db`** (LS — `synchronous=FULL`, nunca apagado por reprojeção):

`dm_conversations`

| Coluna | Tipo | Nulo | Semântica |
|---|---|---|---|
| `conversation_id` | `TEXT` **PK** | não | §31.2, hex64 |
| `peer_key` | `BLOB` | não | Chave de identidade do par. **Esta tabela é a enumeração autoritativa de conversas** |
| `self_core_key` | `BLOB` | não | Derivada (§31.3); gravada como atalho e verificação cruzada |
| `self_core_seed_enc` | `BLOB` | sim | Semente cifrada pela Data Key, empacotada `nonce‖ct‖tag`. **Derivada** — o boot a reescreve quando falta ou não decifra, mesmo racional da emenda de §13.1 |
| `peer_core_key` | `BLOB` | sim | `NULL` até o `dmHello`/`dm.hello` do par chegar. Depois de gravada é **imutável** (RD-6) |
| `state` | `TEXT` | não | `pending-out · pending-in · accepted · blocked · left` |
| `created_at` | `INT` | não | Relógio local, informativo |
| `accepted_at` | `INT` | sim | — |
| `blocked_at` | `INT` | sim | — |
| `self_high_water` | `INT` | não | Maior `core.length` próprio já observado. **É a detecção de perda de §31.13** |
| `forgotten_self_length` | `INT` | sim | §31.19 |
| `forgotten_peer_length` | `INT` | sim | §31.19 |
| `removed_at` | `INT` | sim | §31.19, espelha §18.4 |
| `retain_until` | `INT` | sim | idem |

Índices: `idx_dm_conv_peer(peer_key)`, `idx_dm_conv_state(state)`.

`dm_local_read_state`

| Coluna | Tipo | Nulo | Semântica |
|---|---|---|---|
| `conversation_id` | `TEXT` **PK** | não | — |
| `last_read_ord_sum` | `INT` | não | Watermark |
| `last_read_author` | `BLOB` | não | Segunda metade do `ordKey` |
| `unread_count` | `INT` | não | Recomputado, nunca acumulado (A28) |

`dm_prefs`

| Coluna | Tipo | Nulo | Semântica |
|---|---|---|---|
| `key` | `TEXT` **PK** | não | Hoje: `contactPolicy` (§31.9 regra 5) |
| `value` | `TEXT` | não | — |

**Não existe `dm_author_seq`.** O contador é `core.length + 1` e é recuperado do próprio core
no boot (RD-3). Uma tabela a menos do que a comunidade precisa.

**`view.db`** (CS — derivado, `DROP` e refaz no bump de schema):

| Tabela | Colunas | Índices |
|---|---|---|
| `dm_ds_snapshot` | `conversation_id TEXT PK` · `interpreted_ord_sum INT` · `lo_length INT` · `hi_length INT` · `blob BLOB` · `fold_build_id TEXT NOT NULL` · `taken_at INT` | — |
| `dm_messages` | `conversation_id TEXT` · `id TEXT` · `ord_sum INT NOT NULL` · `author_key BLOB NOT NULL` · `author_seq INT NOT NULL` · `content TEXT` (**NULL quando tombstonada**) · `ts INT NOT NULL` · `clock_skewed INT NOT NULL` · `ack_ahead INT NOT NULL` · `edited_at INT` · `reply_to_id TEXT` · `deleted_at INT` — **PK `(conversation_id, id)`** | `idx_dm_messages_ord(conversation_id, ord_sum, author_key)`; `idx_dm_messages_author(conversation_id, author_key)` |
| `dm_reactions` | `conversation_id` · `message_id` · `emoji` · `identity_key BLOB` · `ord_sum INT` — PK dos quatro | `idx_dm_reactions_message(conversation_id, message_id)` |
| `dm_attachments` | `conversation_id` · `message_id` · `owner_key BLOB` · `blobs_core_key BLOB` · `blob_id TEXT` (JSON) · `name` · `size_bytes INT` · `kind` · `hash BLOB` — PK `(conversation_id, message_id)` | `idx_dm_attachments_ref(blobs_core_key, blob_id)` |
| `dm_participants` | `conversation_id` · `identity_key BLOB` · `display_name TEXT NOT NULL` · `avatar_color INT NOT NULL` · `core_key BLOB` · `length INT NOT NULL` · `invalid INT NOT NULL` — PK `(conversation_id, identity_key)` | — |
| `dm_rejected_records` | `conversation_id` · `origin TEXT` · `idx INT` · `kind INT` · `reason TEXT` — PK `(conversation_id, origin, idx)` | Só para diagnóstico; podado acima de `REJECTED_LOG_MAX` linhas por conversa. `kind` é `NULL` **exatamente** quando o cabeçalho não decodificou |

Chaves de `meta` acrescentadas à lista fechada de §10.3.1:

| Chave | Valor | Quando é escrita |
|---|---|---|
| `dm_interpreted:<conversationId>` | `{ordSum, loLength, hiLength}` do último lote commitado | Na mesma transação dos efeitos de cada lote |
| `dm_fold_panic:<conversationId>` | `ordSum` do registro que fez o `dmFold` lançar | Na mesma transação do lote em que o pânico aconteceu |

**Sem FTS para DM no v1.** `query.search` (§23) tem contrato declarado com três grupos
(`messages`, `channels`, `members`) e uma semântica de `partial` amarrada a estado de
replicação de comunidade; acrescentar uma quarta fonte muda esse contrato e é decisão de
produto, não consequência desta seção. A conversa é paginável por `ord_sum`, e isso é o que
o v1 entrega. Acrescentar FTS depois é aditivo: uma tabela `dm_messages_fts` e um bump de
`view_schema_version`, que §10.5 já sabe fazer.

**Barreira entre os dois bancos.** A de §10.5, sem alteração: **primeiro commita `view.db`,
depois `manifest.db`, depois emite os eventos.** No boot, `dm_local_read_state` é recomputado
para toda conversa cujo watermark não bata com a query.

### 31.13 Replicação, perda local e fork

**O que replica:**

| Recurso | Como é encontrado | Quem replica |
|---|---|---|
| Core de DM de cada lado | Conexão direta ao par pela chave de identidade (§31.8) | **Só os dois**, e só sob `autorizaDm` |
| Core de blobs de DM de um lado | `BLAKE2b('blob-discovery/1' ‖ blobsCoreKey)` (§13.4, sem alteração) | Quem tem, ou quer, um anexo daquele lado |

Registrar um core num mux é **uma** operação por `(mux, core)` — o `attachTo` do hypercore
não é idempotente. Mesma lição de §13.4.

**Estados de sincronização observáveis**, análogos a §14.5 com os nomes ajustados:

| Estado | Condição | Evento |
|---|---|---|
| `synced` | Os dois lados interpretados até a cabeça, e o par respondeu no último `HELLO_INTERVAL_MS` | — |
| `catching-up` | Há registro por interpretar e o número avança | `dm.sync{state, lag}` |
| `stalled` | `lag > 0` sem avanço por `REPLICATION_STALL_MS`; **ou** o handshake de §31.8 não fechou (emenda de 2026-09-05) | idem, com `reason:'no-provider'` ou `reason:'handshake'` |
| `peer-offline` | Sem conexão com o par | idem |
| `unauthorized` | O par recusou o canal — a RPC `dmHello` voltou com código | idem — **não é distinguível de bloqueio**, por desenho (§31.9 regra 2) |
| `forked` | Bloco conflitante no próprio core | `dm.forked` |
| `desynced` | `core.length` próprio menor que `self_high_water` | `dm.desynced` |

**O handshake que não fecha emite — emenda de 2026-09-05.** Do lado de **quem chama** §31.8,
todo desfecho que não termina em "apresentado" emite `dm.sync`, sem exceção. O canal fica vivo
depois de um handshake que falhou, a replicação não começa, e sem evento isso é um travamento
silencioso que a UI não tem como diagnosticar. A separação é:

| Desfecho | Evento |
|---|---|
| A RPC `dmHello` voltou com código (o par recusou) | `dm.sync{state:'unauthorized'}` — a causa **não** é dita (§31.9 regra 2) |
| A resposta não decodifica, ou traz `dmVersion` fora da faixa suportada | `dm.sync{state:'stalled', reason:'handshake'}` |
| `coreKey` fora de 32 bytes, ou `coreProof` que não confere (§31.8(3)) | idem |
| A política **local** recusou o vínculo (bloqueio, filtro de contato, RD-6) | idem |

`unauthorized` afirma recusa do par; os outros três não afirmam nada sobre ele, e usar o mesmo
estado ali diria à UI que o outro lado bloqueou quando o que houve foi incompatibilidade ou uma
recusa **desta** instalação. A última linha não fere **L-28**: o evento é local, nada é
respondido ao par, e o bloqueado continua vendo só um `ack` que não avança.

A validação de 32 bytes do `coreKey` é **simétrica** entre quem responde e quem chama. Ela não
é higiene: RD-6 congela a chave do lado assim que ela é vinculada, então uma chave malformada
aceita pelo cliente ficaria em `peer_core_key` para sempre, e a chave certa depois seria
recusada com `E_DM_CORE_MISMATCH`.

**Perda local do próprio core — a detecção que impede o fork.** Se a barreira de §10.7.1 não
alcançar (queda de energia), o próprio core pode reabrir mais curto do que já esteve. Se o
nó appendar nesse estado, produz **dois blocos diferentes no mesmo índice assinados pela
mesma chave** — um fork contra a cópia que o par já tem, e o pior desfecho possível.

Regra normativa: `self_high_water` é gravado em `manifest.db` (`FULL`) **antes** de cada
append. No boot e a cada abertura de conversa, o nó compara:

- `core.length ≥ self_high_water` → normal.
- `core.length < self_high_water` → a conversa entra em **`desynced`**, o nó **não appenda**
  e emite `dm.desynced`. Escritas devolvem `E_DM_FORKED`.

Saída de `desynced` — **duas, e a escolha entre elas é de G14**:

1. **Restauração por replicação.** O par tem os blocos que faltam **assinados pela minha
   própria chave de core**, junto com a árvore de Merkle correspondente. Se o Hypercore
   permitir a um escritor recompor o próprio core a partir de um par sem antes appendar
   nada, a saída é automática e sem perda. **`REQUIRES POC` — G14**: esta é uma afirmação
   sobre o comportamento do `hypercore@11.x` e **não pode ser implementada como se fosse
   fato antes de medida**.
2. **Aceite explícito de perda.** Se (1) não se sustentar, a saída é uma tela: a pessoa
   aceita que a própria metade da conversa fica congelada, e uma conversa nova exige uma
   identidade nova — porque o `conversationId` e o `dmCoreSeed` são derivados e não há como
   pedir um core novo para o mesmo par.

**Fork detectado.** Se o Hypercore reportar bloco conflitante (identidade restaurada em duas
máquinas escrevendo a mesma conversa — **L-4**), vale §18.9 sem alteração: para de appendar,
marca `forked`, emite `dm.forked`, oferece exportar e escolher o ramo. **Não há merge
automático, e não haverá.**

**Reinterpretação por inserção retroativa.** Quando chega um registro cujo `ordKey` é menor
que o `interpretedOrdSum` corrente (§31.6), o projetor:

1. descarta os snapshots de `dm_ds_snapshot` com `interpreted_ord_sum` maior que o ponto de
   inserção;
2. recarrega o snapshot mais recente **anterior ou igual** ao ponto de inserção — ou recomeça
   do início da conversa se não houver;
3. reinterpreta dali até as duas cabeças, em lotes, com uma transação por lote;
4. emite `dm.reordered{fromOrdSum}` **depois do commit**.

O snapshot obedece a §10.6 sem alteração, inclusive o `fold_build_id`: um snapshot cuja
procedência não bate é descartado, e o `dmFold` recomeça do zero.

### 31.14 Anexos

Reuso integral de §13, com uma derivação trocada e uma regra a mais.

| Peça | Situação |
|---|---|
| `AttachmentRef` com `blobsCoreKey` embutido | **Reutilizada sem alteração** — o leitor sabe de qual core buscar sem perguntar a ninguém |
| Core de blobs por autor | **Reutilizado**, com `dmBlobsSeed` de §31.3 no lugar de `memberBlobsSeed`. Um core de blobs **por conversa**, pela mesma razão de §31.1: escopo de replicação = escopo de confidencialidade |
| Ticket de staging emitido pelo main (§13.3, A15) | **Reutilizado sem alteração.** O núcleo continua recusando qualquer `path` vindo do renderer, sempre |
| Fluxo de upload (§13.2) e de download (§13.4) | **Reutilizados sem alteração**, inclusive o teto por bytes recebidos, a verificação de hash e os oito estados de `local_blob_cache` |
| Barreira blob ↔ mensagem (§13.7) | **Reutilizada sem alteração**: o blob primeiro, a mensagem depois; o autor mantém os blocos enquanto a mensagem viver |
| Abertura, tipo e quarentena (§13.6) | **Reutilizados sem alteração**, inclusive a allowlist de extensões e a regra de renderização inline só de imagem |
| Cota `ATTACHMENT_QUOTA_PER_MEMBER` (R-14) | **Não existe mais em lugar nenhum.** Esta linha registrava que a conversa direta era a exceção; desde a emenda de 2026-09-04 (§13.8, `opVersion = 3`) a comunidade também não tem cota, e a assimetria que a linha explicava desapareceu. O teto de `sizeBytes` de §6.10 continua fechando "declara 1 KB, entrega 8 GB", aqui e lá |
| **RD-11** | **Regra a mais**: o `blobsCoreKey` de um anexo precisa ser o core de blobs de DM do autor daquela mensagem. Sem ela, uma parte faria a outra buscar bytes num core arbitrário |

O tópico de descoberta de blobs continua sendo `BLAKE2b('blob-discovery/1' ‖ blobsCoreKey)`;
ele não revela a conversa nem o par, porque a chave é derivada do `identitySeed` de quem
escreve.

### 31.15 Mídia numa conversa direta

**`REQUIRES POC` — G7, G8 e G14.** Nada aqui pode ser implementado antes deles.

Vale §17.2 sem alteração: **toda mídia é WebRTC no renderer, ponta a ponta, com DTLS-SRTP; o
núcleo nunca vê mídia.** O que muda é quem faz o papel que §17 dá ao host, e a mudança é
sempre no sentido de **remover** mecanismo:

| Peça de §17 | Numa conversa direta |
|---|---|
| **Sinalização encaminhada pelo host** (§16.3, emenda de 2026-08-22) | **Não existe.** A justificativa declarada para o encaminhamento é que "antes de o ICE fechar não existe canal direto entre os dois membros". Aqui **existe**: é o canal `p2p-dm/1`, autenticado por Noise contra exatamente a chave do par. SDP e ICE viajam por ele |
| **Ticket de mídia assinado pelo host** (§17.4) | **Não existe.** O ticket prova a um terceiro que ele está autorizado a sinalizar comigo. Com sinalização que só chega pelo canal autenticado do próprio par, a `remotePublicKey` do Noise **é** a autorização. A propriedade de `T-15` — "qualquer chave conhecida abria conexão com qualquer membro" — fica fechada por transporte, não por assinatura |
| **STUN/TURN do host** (§17.3) | **Simétrico.** O serviço de §17.3 é por **nó**, não por comunidade: cada lado o oferece ao outro na mesma socket UDP do UDX, com a mesma demultiplexação por magic cookie. Quem estiver alcançável serve. A credencial TURN usa `dmTurnSecret` (§31.3) no lugar de `hostTurnSecret`, com o mesmo `'turn-cred/1'` e o mesmo TTL |
| **STUN de terceiro** | **Reutilizado sem alteração**, inclusive a coleta em duas fases da emenda de 2026-08-25 / §99.13 e o carimbo `terceiro: true` |
| **Roster, ocupação e fila** (§17.6, §16.4) | **Não existem.** Numa chamada de duas pessoas o roster é a própria conversa. O estado "o outro está na chamada" é uma notificação efêmera em `p2p-dm/1`, com a mesma disciplina at-most-once de §16.3 regra 1 |
| **Revogação por moderação** (§17.4) | **Não existe** — não há moderação. O que encerra a sessão é sair, cair, ou bloquear |
| **Relay voluntário** (§17.7) | **Não existe.** Ele pressupõe uma comunidade com terceiros; numa dupla não há terceiro. Consequência: **L-11 morde mais forte numa DM** — sem nenhum dos dois lados alcançável, não há voz, e não há voluntário a quem recorrer. Declarado em **L-29** |
| **A estrela de tela** (§17.5) — **linha acrescentada em 2026-09-03** | **É a malha de dois.** Uma estrela com um espectador é a conexão que já existe. Somem a sessão, o `sessionId`, o ticket, o `share.join`, o roster de espectadores, o `E_ALREADY_SHARING` do host e o laço de saúde inteiro; sobra `replaceTrack` no m-line 2 de §17.2. Ver abaixo |

**Onde cada linha desta tabela vira superfície (emenda de 2026-09-02).** A tabela diz o que
some; o que **fica** precisava de nome, e os nomes são derivação das tabelas vizinhas, não
desenho novo:

| O que fica | Onde |
|---|---|
| SDP e ICE pelo `p2p-dm/1` | `dm.signal`, notificação de §31.8 |
| "O outro está na chamada", com o serviço que ele oferece | `dm.call`, notificação de §31.8 |
| Entrar, sair e sinalizar, do renderer | `dm.callJoin`, `dm.callLeave`, `dm.signal` (§31.16.1) |
| O estado da chamada, ao renderer | `dm.callState` (§31.16.2) |
| `dmTurnSecret` | §31.3, e o registro do escopo no serviço de §17.3 é o `conversationId` — a mesma substituição que §31.14 faz no escopo de blob |

**O `REQUIRES POC` desta seção, relido.** G7 e G8 saíram `parcial`, e os `openCriteria` dos
dois são exatamente o que **`backlog.md` B4** guarda do lado humano: Electron empacotado,
`tc/netem`, CGNAT real, encoder de vídeo real, CPU em alvo dedicado. G14 saiu `parcial` com
os cinco critérios aprovados. É o **mesmo veredito** sobre o qual §17 foi implementada — voz
e tela de comunidade existem em produto desde §77–§98 —, e a consequência aqui é a mesma: o
que este veredito trava é a **medida em rede real**, que continua sendo B4, não a existência
do caminho. A evidência de duas pontas disponível é o smoke de §98.

**Duas consequências que a simetria custa, e que não são apagáveis:**

1. **A garantia de §17.2/§99.13 só existe depois que o outro atende.** A coleta em duas fases
   nasce "só com o que o host serve", e numa DM quem faz esse papel é o par — antes de ele
   entrar na chamada, o serviço dele não existe. Por isso a `RTCPeerConnection` **só é criada
   quando `dm.call{on:true}` chega**: subi-la antes entregaria o STUN de terceiro ao agente na
   primeira coleta, que é exatamente o que a fase 1 evita.
2. **O reanúncio é resposta a uma transição, nunca à repetição de um nível.** Os dois lados
   reanunciam quando o outro entra; sem essa distinção os dois ficam trocando `dm.call` para
   sempre pelo mesmo cabo.

**Emenda de 2026-09-03 — câmera e tela numa conversa direta.**

A tabela acima dizia o que some de §17 e **não mencionava §17.5**. Silêncio não é
autorização, e a lacuna foi registrada como **B68** em §112. Fica decidido:

**A câmera é derivação, e já era.** "Vale §17.2 sem alteração" e §17.2 põe voz e câmera na
mesma malha, na mesma `RTCPeerConnection`. Numa DM a malha existe desde a chamada; a câmera é
`replaceTrack` no m-line 1 e um botão. Implementada em §112, sem tocar no núcleo.

**A tela existe numa conversa direta, e é a malha de dois.** A estrela de §17.5 é uma
topologia — "o apresentador mantém uma `RTCPeerConnection` por espectador" — e com **um**
espectador ela É a conexão que a chamada já mantém. Toda a máquina em volta some, e cada peça
sai por uma linha já declarada nesta tabela:

| Peça de §17.5 | Numa conversa direta |
|---|---|
| `share.start`, `shareStart`, `share.started` | **Não existem.** Não há host que registre sessão nem que anuncie. Transmitir é pôr a trilha no m-line 2 da conexão que existe |
| `sessionId` | **Não existe.** O escopo é a conversa, como em `dm.callJoin` — e não há segunda transmissão a distinguir |
| `share.join`, ticket, `share.viewersChanged` | **Não existem.** Há um espectador só, e o canal `p2p-dm/1` autenticado por Noise já o autorizou. É a mesma linha do ticket de §17.4 |
| `E_ALREADY_SHARING` | **Local.** Um m-line de tela por conexão; não há registro de host a trancar |
| "Quem pode assistir: participante do canal de voz" (`F-18`) | **Verdadeiro por construção.** A malha só existe dentro da chamada (§99.13); não há audiência a reconferir a cada mudança de roster, porque não há roster |
| Revogação por moderação | **Não existe** — já declarado acima |
| `share.setQuality`, `share.report`, `share.health`, degradação automática, perfis `high`/`balanced`/`low` | **Não existem.** Ver abaixo |
| Resolução e taxa de quadros (`applyConstraints`) | **Inalterados** — §17.5 já os declara locais e sem RPC |
| §17.3 (emenda de 2026-08-28) — tela não sobe por caminho relayado | **Vale sem alteração.** É conselho do lado que empurra, e não depende de host |

**Por que o laço de saúde inteiro sai, e não é recorte de escopo.** §17.5 mede, consolida e
degrada porque **um upload serve N espectadores**: a estimativa de banda de uma conexão não dá
política sobre as outras, e por isso o host precisa ser a autoridade que guarda o perfil de
cada um. Com **N = 1** a estimativa daquela conexão **é** a política, e o congestion control do
próprio WebRTC (`transport-cc`) adapta o encoder ao caminho continuamente — melhor do que três
perfis fixos e sem um round-trip de RPC no meio. Some junto a razão declarada de "quem mede
não decide": ela existe porque "aceitar amostra de um espectador deixaria qualquer participante
empurrar o perfil dos **outros**", e numa dupla não há outros.

**Nenhum comando e nenhuma notificação novos.** §31.16.1 e §31.16.2 ficam como estão, e a
tabela fechada de §31.8 não ganha linha: a tela de uma DM não atravessa o núcleo em ponto
nenhum. O que a torna implementável é a emenda de 2026-09-03 de §17.2 — com o m-line fixo, a
tela e a câmera são distinguíveis na chegada sem `share.join`, que é exatamente o que **B41**
tornava impossível numa dupla. Sem aquela emenda esta aqui não se sustenta.

### 31.16 IPC-R

Envelope, `epoch`, `subId`, `evSeq`, janela de `evAck`, `evStale` e o procedimento de
recuperação de crash de §15.2 valem **sem alteração**. As classes de autorização são as de
§15.3.

**Emenda de 2026-09-04 (B63) — onde a conversa mora e como ela se cala.** (a) A conversa
direta é entrada no topo do rail, antes das comunidades porque não é uma comunidade; ela
troca a sidebar pela lista de conversas e o painel principal pela conversa, reusando o
`AppShell` sem layout novo — o que §107.4 já montava como proposta fica aqui ratificado.
(b) Notificação: `settings.setNotifications` continua por comunidade
(`local_community_pref.notificationLevel`) mais o flag global
(`local_device_pref.notificationsEnabled`), e a conversa ganha o **mudo por conversa**:
preferência local deste aparelho, persistida com as demais, que não replica nem avisa
ninguém — espelho do mudo de canal (`local_channel_pref.muted`). Conversa muda não soma
no selo do rail; pedido (`pending-in`) soma sempre (§31.9 regra 4) e ainda não é conversa
para ter mudo. Esquecer a conversa limpa o mudo com ela. Nenhum comando, evento ou tabela
nova: o núcleo não conhece mudo de DM.

#### 31.16.1 Comandos

| Comando | Argumento | Cl. | Resposta | Erros |
|---|---|---|---|---|
| `dm.open` | `{peerKey}` | standard | `{conversationId, state}` | `E_VALIDATION.peerKey`, `E_DM_BLOCKED`, `E_LIMIT_EXCEEDED` |
| `dm.accept` | `{conversationId}` | standard | `{state:'accepted'}` — cria o core e escreve o `dm.hello` | `E_NOT_FOUND`, `E_DM_BLOCKED`, `E_STORAGE_FULL` |
| `dm.block` | `{conversationId}` | standard | `{}` — **encerra a chamada desta conversa antes de bloquear** | `E_NOT_FOUND` |
| `dm.unblock` | `{conversationId}` | standard | `{state}` | `E_NOT_FOUND` |
| `dm.send` | `{conversationId, content, attachment?, replyToId?, clientRef}` | standard | `{messageId, ordSum, state:'written'}` — **o registro já está no log** | `E_VALIDATION`, `E_DM_BLOCKED`, `E_DM_FORKED`, `E_BLOB_NOT_STAGED`, `E_STORAGE_FULL`, `E_VERSION_UNSUPPORTED` |
| `dm.edit` | `{conversationId, messageId, content}` | standard | `{ordSum}` | `E_CANNOT_EDIT_OTHERS`, `E_MESSAGE_DELETED`, `E_DM_FORKED` |
| `dm.delete` | `{conversationId, messageId}` | standard | `{ordSum}` | `E_CANNOT_EDIT_OTHERS`, `E_DM_FORKED` |
| `dm.react` | `{conversationId, messageId, emoji, present}` | standard | `{ordSum}` | `E_REACTION_LIMIT`, `E_MESSAGE_DELETED`, `E_DM_FORKED` |
| `dm.setProfile` | `{conversationId, displayName?, avatarColor?}` | standard | `{ordSum}` | `E_VALIDATION` |
| `dm.markRead` | `{conversationId}` | standard | `{unreadCount:0}` | `E_NOT_FOUND` |
| `dm.setTyping` | `{conversationId, on}` | standard | `{}` | — (efêmero; nunca enfileira) |
| `dm.setContactPolicy` | `{policy:'anyone'\|'shared-community'}` | standard | `{}` | `E_VALIDATION` |
| `dm.forget` | `{conversationId}` | **main-confirmed** | `{}` — **encerra a chamada desta conversa antes de esquecer** | `E_NOT_FOUND` |
| `dm.activate` | `{conversationId \| null}` | standard | `{residency}` | `E_NOT_FOUND` |
| `dm.callJoin` | `{conversationId}` | standard | `{sessionId, peerKey, iceServers[], peerOnCall}` — **emenda de 2026-09-02** (§31.15) | `E_NOT_FOUND` |
| `dm.callLeave` | `{conversationId}` | standard | `{}` — idempotente | — |
| `dm.signal` | `{conversationId, sdp?, ice?}` | standard | `{}` | `E_VALIDATION`, `E_SESSION_GONE`, `E_PEER_UNREACHABLE` |

**Emenda de 2026-09-02 — os três comandos de mídia.** São `voice.join`, `voice.leave` e
`voice.signal` de §15.4 com a comunidade tirada de baixo, e cada campo ausente é uma linha da
tabela de remoções de §31.15: sem `channelId` (não há canal), sem `ticketId` (a
`remotePublicKey` do Noise é a autorização), sem `toPeerKey` (há um par só), sem `roster` e
sem `tickets[]`. `sessionId` é o próprio `conversationId` — o escopo do serviço de §17.3 é a
conversa, e não há host que emita um id de sessão.

`peerOnCall` é o que substitui o roster: numa dupla a única pergunta que ele respondia é "o
outro está aqui?", e ela é um booleano. Ele pode nascer `false` — chamar antes de o outro
atender é o caso normal —, e quem o vira é `dm.callState`.

`E_PEER_UNREACHABLE` em `dm.signal` é o mesmo código de §16.2 `voiceSignal`, e aqui ele é
honesto por construção: sem canal `p2p-dm/1` de pé não existe caminho nenhum, e não há host
a quem atribuir a falha.

**Emenda de 2026-09-05 — `dm.block` e `dm.forget` implicam `dm.callLeave`.** Os dois
encerram a chamada daquela conversa, e o `dm.callLeave` acontece **antes** do comando: depois
de bloquear, `autorizaDm` é falso (§31.8(4)) e o `dm.call{on:false}` não teria por onde sair —
o par ficaria com a chamada de pé contra quem acabou de bloqueá-lo.

A razão de a regra ser do núcleo, e não só do renderer: a mídia é ponta a ponta (§17.2) e não
passa pelo canal que o bloqueio fecha, mas o **escopo do serviço de §17.3** é do núcleo.
Bloquear sem sair deixava o escopo registrado no `MediaServer` e a credencial TURN emitida
por este nó ainda válida — este nó encaminhando a mídia de quem acabou de bloquear. §31.15 já
diz que a revogação de §17.4 acontece "pela única via que sobrou aqui: **sair encerra**"; esta
emenda diz que bloquear e esquecer são duas dessas vias. `dm.callLeave` é idempotente, então a
implicação não muda nada quando não há chamada.

O renderer tem a **outra metade**, e ela não é derivável desta: o dispositivo. Microfone e
câmera são dele (§3.4), e nenhum comando do núcleo os apaga — sem desligá-los, bloquear no
meio de uma chamada deixava a captura acesa. Em `dm.forget` isso era pior, porque a conversa
some da lista e com ela a única superfície que oferecia desligar (§31.15, U-33).

`dm.forget` é `main-confirmed` pela mesma razão que `community.forget`: ele apaga dado, e a
barreira contra o apagamento acidental é o diálogo nativo (§15.3).

**Nenhum comando de DM devolve, deriva ou expõe material de chave** — §3.2 item 5, sem
exceção nova. `dmContentKey`, `dmShared` e `dmCoreSeed` não aparecem em resposta, em erro nem
em log.

#### 31.16.2 Eventos

Cada evento é **sinal para reconsultar**, com o mínimo para a UI decidir se precisa
(§15.1 regra 5).

| Topic | Payload | Dispara |
|---|---|---|
| `dm.requested` | `{conversationId, peerKey}` | Um par sem conversa aceita abriu contato (`pending-in`) |
| `dm.conversationChanged` | `{conversationId, fields[]}` | Aceite, bloqueio, perfil do par, vínculo de core |
| `dm.appended` | `{conversationId, fromOrdSum, toOrdSum, hasIncoming}` | Lote projetado. **`hasIncoming` é do lote, e quem o preenche é o `dmProjector`** (emenda de 2026-09-05): o `dmFold` não sabe qual dos dois lados é o próprio, e não pode saber — §31.1 exige que a interpretação dê o mesmo resultado nos dois. O projetor sabe, porque quem o compõe tem a identidade nas mãos, e o campo é o **OU** dos registros da faixa: `origin ≠ meuLado` para algum deles |
| `dm.messageUpdated` | `{conversationId, messageId, fields[]}` | Edição, deleção, reação |
| `dm.reordered` | `{conversationId, fromOrdSum}` | **Inserção retroativa** (§31.13). A UI é obrigada a recarregar a partir daí; sem este evento ela mostraria uma história que não é mais a corrente |
| `dm.delivered` | `{conversationId, deliveredUpTo}` | O `ack` do par avançou (§31.11) |
| `dm.sync` | `{conversationId, state, lag, reason?}` | §31.13 |
| `dm.desynced` | `{conversationId, coreLength, highWater}` | §31.13 |
| `dm.forked` | `{conversationId}` | §18.9 |
| `dm.unreadChanged` | `{conversationId, unreadCount}` | Recalculado |
| `dm.typing` | `{conversationId, on}` | TTL 5 s |
| `dm.partialInterpretation` | `{conversationId, unknownKinds[], unknownVersions[]}` | §31.4. **Por lote e do `dmProjector`** (emenda de 2026-09-05), pela mesma razão de `hasIncoming` e por uma segunda: o registro que liga a marca é `IGNORED` no estágio 1, e §31.7.3 dá a emissão de efeitos ao estágio 12. Sai **só quando uma das listas de §31.7.2 cresce** — um lote com N registros do mesmo `kind` desconhecido é uma degradação, não N eventos |
| `dm.signal` | `{conversationId, peerKey, sdp?, ice?}` | **Emenda de 2026-09-02** — SDP/ICE do par (§31.15). `peerKey` é a chave da **conexão**, nunca um campo do quadro: numa DM ela nem sequer é fabricável, porque não há campo de origem e o Noise já a fixou (§16.3 regra 4, na forma que sobra sem host) |
| `dm.callState` | `{conversationId, peerKey, on, iceServers?}` | **Emenda de 2026-09-02** — o par entrou ou saiu da chamada (§31.15). Quando `on`, `iceServers[]` é a lista **já composta** para o agente ICE: o serviço do par (sem a marca `terceiro`, porque ele é o outro nó da conversa) mais o STUN de terceiro **local** (com a marca). Compor no núcleo é a mesma disciplina de `voiceJoin` — quem sabe o que é serviço do par e o que é terceiro é quem tem o serviço de mídia nas mãos, e é essa diferença que a coleta em duas fases de §99.13 usa |

**Os dois eventos de mídia são ORDEM, não sinal para reconsultar.** A regra 5 de §15.1 vale
para os doze de cima porque cada um tem uma consulta que o reconstrói; não existe query que
reconstrua uma negociação WebRTC nem um `dm.call` perdido. É a mesma exceção que
`voice.signal` sempre teve em §15.5.

`unread.changed` de §15.5 **não** é reutilizado: o payload dele declara `communityId`, e uma
conversa direta não tem um. Reaproveitar o tópico exigiria tornar o campo opcional, o que
mudaria um contrato existente por conveniência.

#### 31.16.3 Queries

Tipos compartilhados novos:

```ts
type DmConvState = 'pending-out' | 'pending-in' | 'accepted' | 'blocked' | 'left'
type DmSync      = 'synced' | 'catching-up' | 'stalled' | 'peer-offline'
                 | 'unauthorized' | 'forked' | 'desynced'

type DmPeerRef = { key: Key, displayName: string, handle: string,
                   avatarColor: number }
// Sem `collision`: numa conversa de dois não há conjunto em que colidir. O `handle`
// (§6.1) é derivado da chave e é sempre exibido junto do nome — é a mitigação (a) de
// L-5, e aqui ela é mais forte, porque para falar com alguém é preciso JÁ ter a chave dele.

type DmMessageDto = {
  id: string, ordSum: number, conversationId: string
  author: DmPeerRef
  content: string | null                      // null quando tombstonada
  ts: Ms, clockSkewed: boolean, ackAhead: boolean
  editedAt?: Ms
  replyTo?: { messageId, author: DmPeerRef, excerpt: string | null, deleted: boolean }
  hasAttachment: boolean
  deleted: boolean
  delivery?: 'written' | 'delivered'          // só nas próprias; ausente nas do par
}
```

| Query | Argumento | Resposta |
|---|---|---|
| `query.dmConversations` | `{}` | `[{ conversationId, peer: DmPeerRef, state: DmConvState, sync: DmSync, unread: {count}, lastMessage?: {ordSum, ts, excerpt, author}, pendingRecords? }]`, mais recente primeiro |
| `query.dmConversation` | `{conversationId}` | `{ conversationId, peer: DmPeerRef, state, sync, lag, deliveredUpTo, selfInvalid, peerInvalid, partialInterpretation, lastReadOrdSum, lastReadAuthorKey, blockedAt?, retainUntil? }` |
| `query.dmMessages` | `{conversationId, cursor?, limit=50, direction:'before'\|'after'}` | `{ messages: DmMessageDto[], nextCursor?, hasMore, sync: DmSync, lastReadOrdSum, lastReadAuthorKey }` |
| `query.dmMessage` | `{conversationId, messageId}` | `DmMessageDto & { reactions: ReactionDto[], attachment?: AttachmentDto } \| null` |
| `query.dmPrefs` | `{}` | `{ contactPolicy: 'anyone' \| 'shared-community' }` |

**Cursor:** `base64url({ordSum, authorKey, id})`, opaco. Inválido ou de outra conversa →
`E_BAD_CURSOR`, e a UI recomeça do início. Nunca resultado errado em silêncio (§15.6.1).

`ReactionDto` e `AttachmentDto` são os de §15.6.1, sem alteração — **inteiros**, e a palavra
importa: metade daquele DTO é estado de download (`state`, `progress`, `localPath`), lida do
mesmo `local_blob_cache` de §13.4 que `query.message` já lê. §31.14 manda reutilizar o fluxo
de download sem alteração, e devolver só o que está em `dm_attachments` — nome, tamanho e
ponteiro — deixa o cartão da conversa sem como saber que o arquivo já está no disco.
`availablePeers`/`hostAvailable` são `0`/`false` pela mesma razão de §15.6.1 (leitura do
bitfield **vivo**), e numa DM `hostAvailable` é `false` por construção: não há host.

**Emenda de 2026-09-05 — a marca de leitura sai nas queries (`lastReadOrdSum`,
`lastReadAuthorKey`).** É o watermark de `dm_local_read_state` (§31.12/A28), na forma do
`ordKey` de §31.6, e ele fecha uma lacuna nomeada: **U-33** manda a conversa reusar a anatomia
de §9 2.1 "inclusive o divisor de *Novas mensagens*", e nada em §31.16.3 dizia **onde** o
corte fica. `unread.count` diz **quantas**; o divisor precisa saber **onde**, e as duas coisas
não são derivadas uma da outra.

Os **dois** eixos viajam, e o segundo não é decoração: `naoLidas` desempata pela chave do
autor (§31.6), então um corte só por `ordSum` discordaria do próprio contador exatamente no
empate — o selo diria "1 não lida" e a tela não mostraria divisor nenhum.

`lastReadOrdSum = -1` com a chave zerada é o sentinela de "nada lido nesta máquina": a ordem
canônica começa em 0, e nesse caso tudo é novo. A marca vem na **mesma resposta** da página
de propósito — numa segunda consulta ela poderia avançar entre as duas, e o divisor apareceria
no lugar errado por uma corrida.

Congelar o corte enquanto a conversa está aberta é do renderer, e é obrigatório: abrir a
conversa chama `dm.markRead` logo em seguida (§31.16.1), e um divisor que acompanhasse o
watermark sumiria no mesmo quadro em que apareceu.

### 31.17 Erros

Reuso de §20.2 em tudo que já existe. **Quatro códigos novos**, e cada um existe porque
nenhum código atual descreve a condição:

| Código | Classe | HTTP eq. | R | Significado |
|---|---|---|---|---|
| `E_DM_BLOCKED` | estado | 409 | não | A conversa está bloqueada nesta instalação |
| `E_DM_FORKED` | estado | 409 | não | O próprio core está `forked` ou `desynced`; escrever produziria fork (§31.13) |
| `E_DM_CORE_MISMATCH` | segurança | 403 | não | O par anunciou chave de core diferente da já vinculada (RD-6) |
| `E_DM_NOT_AUTHORIZED` | autorização | 403 | não | Canal de DM recusado: par errado, bloqueado, ou política de contato (§31.8, §31.9) |

**Três condições que deliberadamente não ganham código próprio**, porque um existente já as
descreve e §20.2 é fonte única: "conversa consigo mesmo" é `E_VALIDATION.peerKey`; "pendentes
demais" é `E_LIMIT_EXCEEDED` com `limit`; "registro de outra conversa" é `E_WRONG_COMMUNITY`,
cujo significado na tabela — "`op.communityId` ≠ core" — é exatamente esta condição com outro
nome de campo.

As regras de tratamento de §20.3 valem sem alteração, com uma consequência a mais:
**`undelivered` nunca é apresentado como erro.** Não entregue é um estado normal de uma
conversa em que o outro lado está offline, e transformá-lo em erro faria a UI acusar falha
onde não há.

### 31.18 Limites e proteção de recurso

**Constantes de protocolo** (parte de `DM_VERSION = 1`; mudar exige bump):

`DM_VERSION` 1 · e **todos os limites de campo de §31.7.5, que são os de §8.6** —
`MAX_ENVELOPE_BYTES`, `MAX_ENVELOPE_BYTES_ATTACHMENT`, `ATTACHMENT_MAX_BYTES`,
`MAX_REACTION_EMOJIS`, `CLOCK_SKEW_MS` e os limites de `content`, `displayName`, `emoji` e
`name`. Nenhum número novo: reusar é o que mantém uma fonte só para cada limite.

**Configuração operacional** (local, sem efeito na interpretação):

| Variável | Default | Faixa | Efeito |
|---|---|---|---|
| `P2P_DM_MAX_CONVERSATIONS` | 500 | 1–5 000 | Conversas em estado `accepted` por instalação |
| `P2P_DM_PENDING_MAX` | 100 | 0–1 000 | Conversas em `pending-in` simultâneas (§31.9 regra 4) |
| `P2P_DM_PENDING_MAX_RECORDS` | 32 | 1–256 | Registros replicados de um par ainda não aceito |
| `P2P_DM_STORAGE_WARN_BYTES` | 1 GiB | ≥ 16 MiB | Acima disso numa conversa, a UI avisa e oferece bloquear ou esquecer. **Não trunca** |

**Controle de admissão do transporte** — §14.4 sem alteração, com a coluna que se aplica:

| Controle | Par com conversa `accepted` | Par desconhecido (`p2p-dm/1`) |
|---|---|---|
| Teto de frame antes do decode | `RPC_MAX_FRAME_BYTES` = 64 KiB | `PREMEMBER_MAX_FRAME_BYTES` = 4 KiB |
| Requests em voo por par | 8 | 2 |
| Token bucket por `remotePublicKey` | 40 req / 10 s | 10 req / 60 s |
| Token bucket por prefixo de rede /24 | — | 30 req / 60 s |

**Não há rate limit determinístico no `dmFold`.** R-15 existe porque o log de uma comunidade
é **compartilhado** e um autor inunda o recurso de todos. Aqui cada um escreve no próprio
core, no próprio disco, e o custo que recai sobre o outro é a replicação — que ele encerra
bloqueando. Uma cota no `dmFold` custaria estado e determinismo sem fechar ameaça: o teto
que importa é o de §31.9 (pendentes) e o aviso de `P2P_DM_STORAGE_WARN_BYTES`.

### 31.19 Retenção e exclusão local

Quatro coisas diferentes, e confundi-las é o erro que esta subseção existe para impedir:

| Ação | O que faz | O que **não** faz |
|---|---|---|
| `dm.delete` | Tombstone no meu log; `content` vira `NULL` na projeção dos dois lados quando o registro replicar, e as linhas de `dm_reactions` e `dm_attachments` daquela mensagem são apagadas (emenda de 2026-09-05, mesma regra de §6.9) | **Não** remove bytes: A26 vale integralmente. "Não pode ser desfeito" é verdade para a interface, não para os bytes |
| `dm.block` | Recuso o canal e paro de conectar | Não apaga nada e não avisa o outro |
| `dm.forget` | Limpa os blocos dos **dois** cores por `core.clear`, apaga as linhas de `dm_messages`/`dm_reactions`/`dm_attachments`/`dm_participants` daquela conversa, apaga os blobs do cache e grava `removed_at` + `retain_until` | **Não apaga a linha de `dm_conversations` e não destrói a árvore assinada do meu core.** É deliberado: `core.length` precisa sobreviver, senão escrever de novo produziria fork contra a cópia que o par tem |
| `identity.wipe` | Máquina de estados de §18.6, sem alteração | — |

Regras normativas:

1. `dm.forget` grava `forgotten_self_length = core.length próprio` e
   `forgotten_peer_length = core.length do par`. Registros com índice **menor** que esses
   nunca voltam a ser projetados. É isso que impede a conversa de "voltar" ao primeiro
   recontato.
2. A linha de `dm_conversations` sobrevive a `dm.forget` **para sempre**, reduzida a
   `conversation_id`, `peer_key`, `self_core_key`, `self_high_water`, os dois
   `forgotten_*_length` e `state = 'left'`. É o mínimo indispensável para não forkar, e está
   declarado em **L-25**.
3. `retain_until` = `now + REMOVED_RETENTION_DAYS` governa a limpeza dos blobs, exatamente
   como §18.4.
4. **Não há retenção de material criptográfico**: `dmContentKey` é derivada por uso e nunca
   persistida; `dmCoreSeed` é derivável do `identitySeed`, e a cópia cifrada em
   `dm_conversations` é atalho, apagável a qualquer momento.
5. **Não há estado retido para deduplicação.** Ela é estrutural (§31.7.3), então nada precisa
   sobreviver por causa dela — a diferença mais direta em relação a §7.5.

### 31.20 Segurança — ameaças e mitigações

| Ameaça | Atacante/observador | Pré-condição | Impacto | Mitigação | Limitação residual |
|---|---|---|---|---|---|
| **Impersonation** | Qualquer um | Conhecer a chave de `B` | Fazer-se passar por `B` para `A` | A identidade **é** a chave: o Noise autentica `remotePublicKey` (§5.1) e a assinatura de cada registro é conferida no estágio 4 | `displayName` é livre: alguém pode se chamar como um amigo seu. Mitigação: `handle` sempre junto do nome (**L-5**) — e, aqui, mais forte, porque para falar com você é preciso **já ter** a sua chave |
| **Replay** | Par ou observador | — | Reaplicar um registro | Estágios 2 e 3 (conversa e autor errados); RD-3 amarra `authorSeq` ao índice; a árvore de Merkle impede injeção em posição nova | Nenhuma |
| **Leitura por terceiro** | Par não participante | Obter `dmPk` | Replicar e ler a conversa | Duas camadas: `autorizaDm` recusa o canal a quem não é o par (§31.8); e o payload é AEAD sob `dmContentKey`, que exige uma das duas chaves privadas de identidade | Quem tiver o **disco** de um dos dois lê a projeção em claro (**L-21**) |
| **Falsificação de mensagem** | Par | — | Escrever como se fosse o outro | Impossível: o `author` é conferido contra o dono do core e a assinatura é Ed25519 da identidade | Nenhuma |
| **Alteração de mensagem** | Par | — | Reescrever o que o outro disse | Impossível pela mesma razão. RD-7 recusa `dm.edit` sobre registro alheio | Nenhuma |
| **Alteração da ordem** | Par | — | Posicionar as próprias mensagens fora da ordem causal | `ack` monotônico (RD-4); registro com `ack` além do conhecido é marcado `ackAhead` | **Não é impedido, só marcado** — o dano é cosmético entre duas partes (**L-27**) |
| **Vazamento de metadado na DHT** | Nó da DHT próximo à chave de `B` | — | Saber que alguém procura `B` | Nenhuma nova: é a exposição que **L-24** já declara | Declarada. O tópico derivado do segredo compartilhado a reduziria e foi recusado em §31.8 |
| **Vazamento no swarm** | Par conectado | — | Saber que você está online, e o volume e a temporização do que troca | Inerente a uma conexão direta | Declarada (§31.21) |
| **Spam** | Qualquer um com a sua chave | — | Encher a sua caixa de pedidos | `pending-in` limitado em número (`P2P_DM_PENDING_MAX`) e em registros (`P2P_DM_PENDING_MAX_RECORDS`); bloqueio silencioso; política `'shared-community'` opcional | Com política `'anyone'`, quem tem a sua chave consegue um pedido. A chave não está em diretório nenhum |
| **Denial-of-service** | Par ou desconhecido | — | Consumir CPU, disco ou conexões | §14.4 sem alteração: teto de bytes antes do decode, bucket por chave e por /24, orçamento de conexões. Aviso de armazenamento por conversa | Nenhuma nova |
| **Sybil** | Qualquer um | — | N identidades, N pedidos | Identidade é gratuita (**L-8**): o teto de pendentes e a política de contato são a defesa, não o custo de entrada | Declarada. Sem prova de trabalho e sem reputação, por §31.9 regra 6 |
| **Enumeração de contatos** | Qualquer um | — | Descobrir com quem você fala | Não há diretório, não há tópico por conversa, e o `conversationId` não é publicado. Descobrir o par exige **já** conhecer as duas chaves | Um nó da DHT vê tentativas de alcançar você (**L-24**) |
| **Enumeração de conversas** | Qualquer um | — | Listar as suas conversas | Impossível pela rede: a lista só existe em `manifest.db` | Quem tem o disco lê a lista (**L-21**) |
| **Comprometimento de chave de identidade** | Quem a obtiver | Roubar a chave privada | Ler todo o histórico de todas as conversas e escrever como você | §31.22 | **Sem forward secrecy** (§31.22) |
| **Comprometimento do armazenamento local** | Processo do mesmo usuário; acesso físico | — | Ler a projeção em claro e a lista de conversas | Nenhuma além de **L-21** e **L-2** | Declarada |
| **Mensagens duplicadas** | — | — | História duplicada | Estrutural (§31.7.3): índice do core + RD-3 | Nenhuma |
| **Mensagens fora de ordem** | — | Partição | Ver a conversa numa ordem transitória | §31.6 é estável por registro; `dm.reordered` obriga a UI a recarregar quando há inserção retroativa | Inserção retroativa é inerente e visível |
| **Par malicioso** | O próprio par | — | Escrever qualquer coisa, mentir no `ack`, encher o disco | É a pessoa com quem você escolheu conversar. A defesa é bloquear e esquecer | Não há moderação numa conversa de dois, e não deveria haver |

### 31.21 Privacidade de metadados, por observador

Conteúdo cifrado **não** torna metadado privado. Cada observador, separadamente:

| Observador | Vê | Não vê |
|---|---|---|
| **Participante** | Tudo o que foi escrito; `ts`; quando você esteve online com ele conectado; até onde você havia interpretado quando escreveu (`ack`) | O que você **leu** sem escrever — leitura é local e não replica (§31.11). O restante da sua vida na rede |
| **Par não participante** | Nada. O canal de DM é recusado (`autorizaDm`) e a chave do core não trafega fora do canal autenticado | Existência da conversa, conteúdo, volume |
| **Observador do DHT** | Que a identidade `X` anuncia e está online; que alguém procurou por `X` | **Com quem** `X` conversa. Não há tópico por conversa, e o `conversationId` não é publicado |
| **Observador do swarm / da rede** | Que dois endereços trocam bytes, o volume e a temporização | Conteúdo (Noise), tipo de registro, identidades — o par de identidades está dentro do handshake cifrado |
| **Operador do dispositivo local** | Tudo: projeção em claro, lista de conversas, blobs baixados | Nada. **L-21** |
| **Atacante com acesso ao armazenamento** | O mesmo que o operador local, se o cofre estiver degradado ou se ele já for processo do mesmo usuário (**L-2**) | A chave de identidade, **se e só se** o secret store do SO estiver disponível |
| **Atacante com `dmPk` (chave do core) e mais nada** | O **cabeçalho** dos registros, se conseguir replicar: `kind`, `author`, `authorSeq`, `ts`, `ack` — ou seja, quantas mensagens, quando e em que cadência | O **conteúdo**: o payload é AEAD sob `dmContentKey` (§31.3). E na prática nem o cabeçalho, porque `autorizaDm` recusa o canal |
| **Atacante com uma chave privada de identidade** | Tudo daquela pessoa, retroativamente | — |

**Metadados que a arquitetura NÃO consegue esconder, declarados:**

1. **Que uma identidade está online.** É **L-24**, e vale para DM sem atenuação.
2. **O tamanho aproximado de cada mensagem.** O comprimento do ciphertext o revela. *Padding*
   foi considerado e não adotado: o registro já é limitado por `MAX_ENVELOPE_BYTES`, e um
   *padding* uniforme multiplicaria o custo de armazenamento e replicação de toda conversa
   para esconder uma grandeza que a temporização já sugere.
3. **O tipo de cada registro.** `kind` fica em claro no cabeçalho, porque a ordem (§31.6) e a
   integridade precisam ser computáveis sem a chave de conteúdo. Quem já pode ler o cabeçalho
   distingue mensagem de reação.
4. **A cadência de escrita de cada lado.** `ts` e `ack` estão em claro pela mesma razão.

### 31.22 Comprometimento de chave

| Chave | Se comprometida | Rotação | Revogação | Recuperação |
|---|---|---|---|---|
| **Identidade (Ed25519)** | O atacante lê **todo o histórico de todas as conversas** (derivando `dmShared` e `dmContentKey`), escreve como você em qualquer conversa e assume as suas comunidades | **Não existe no v1** — não há rotação de identidade em lugar nenhum da spec, e §31 não a inventa | **Não existe.** Não há autoridade que revogue e não há lista compartilhada (**L-17**) | Só criar identidade nova, o que produz `conversationId` novos com todo mundo. As conversas antigas ficam ilegíveis para você e legíveis para quem tem a chave velha |
| **Chave do core de DM (`dmPk`/`dmSk`)** | O atacante appenda no seu core → **fork** contra a cópia do par, detectado por §18.9. **Não lê nada**: o payload é AEAD sob `dmContentKey` | Não existe: é derivada de `identitySeed ‖ conversationId`, e RD-6 fixa o vínculo | Idem | Derivável do backup de identidade (§5.5) |
| **`dmContentKey`** | Lê aquela conversa, passada e futura | Não existe: é função das duas identidades estáticas | Idem | Derivável |
| **Data Key** | Descobre `identitySeed` e as sementes; cai no primeiro caso | **L-3** — não há rotação no v1 | — | — |
| **Armazenamento local** | Lê a projeção e a lista de conversas em claro | — | — | — |
| **Dispositivo** | Tudo acima | — | — | — |

**O que este modelo oferece:** autenticidade e integridade fortes — assinatura por registro,
árvore assinada por core, AEAD sobre o payload com o cabeçalho como AAD; e confidencialidade
contra qualquer um que não tenha uma das duas chaves privadas de identidade.

**O que ele NÃO oferece, e por quê:**

- **Forward secrecy.** Um ratchet exige apagar material de decifragem antigo. A24 promete que
  restaurar a identidade de um backup recupera o que a pessoa tinha, e §10.5 relê o log
  inteiro a cada reprojeção — as duas exigem decifrar registros arbitrariamente antigos a
  qualquer momento. FS é **estruturalmente incompatível** com as duas, e a escolha é manter
  as duas, que já estão decididas.
- **Post-compromise security.** Ela pressupõe rotação, que não existe. Sem chave nova, não há
  como se recuperar de um comprometimento a não ser trocando de identidade.
- **Revogação.** Não há autoridade e não há lista compartilhada.

Adotar um ratchet no futuro é possível e é mudança de `DM_VERSION`, não emenda: exigiria
rotação de identidade, um caminho de recuperação diferente de A24 e uma decisão sobre o que
acontece com o histórico. **Nada disso pode ser tratado como extensão natural do que existe.**

### 31.23 Classificação de estado

Cada dado introduzido por §31, com dono, quem altera, se replica, se sobrevive a restart, se
é necessário para deduplicação ou consistência, e quando pode ser removido.

| Dado | Classe | Dono | Quem altera | Replica | Sobrevive a restart | Necessário para dedup/consistência | Quando pode sumir |
|---|---|---|---|---|---|---|---|
| `conversationId` | **derivado** | ninguém — é função das duas chaves | ninguém | não (é recomputado) | sim (recomputável) | sim (escopo de id e de assinatura) | nunca |
| Registro de um core de DM | **lógico + replicado** | o autor | só o autor, só appendando | **sim** | sim | sim | nunca (A26: tombstone, não remoção) |
| `dmPk` de cada lado | **criptográfico + replicado** (via `dm.hello`) | o dono | ninguém depois de RD-1 | sim, no índice 0 | sim | sim (vínculo do core à identidade) | nunca |
| `dmCoreSeed` / `dmSk` | **criptográfico, local** | o dono | ninguém | **não** | sim (derivável do `identitySeed`) | não | com `identity.wipe` |
| `dmContentKey` / `dmShared` | **criptográfico, efêmero** | os dois | ninguém | **não** | **não** — derivado por uso e zerado | não | ao fim de cada uso |
| `ack` de cada registro | **lógico + replicado** | o autor | ninguém depois de escrito | sim | sim | **sim** — é a ordem (§31.6) e a entrega (§31.11) | nunca |
| `ordSum` / `ordKey` | **derivado** | ninguém | ninguém | não | sim (recomputável) | **sim** | nunca |
| `DmState` | **derivado** (interpretação) | o nó local | só o `dmFold` | não | por snapshot; recomputável do zero | sim | a qualquer momento (é cache) |
| `dm_messages` e demais tabelas de `view.db` | **derivado** (conteúdo) | o nó local | só o projetor | não | sim, e é **descartável** | não | reprojeção, `DROP` de schema |
| `dm_conversations.state` | **exclusivamente local** | o nó local | comandos IPC-R | **não** | sim | não | com `identity.wipe` |
| `dm_conversations.blocked_at` | **exclusivamente local** | o nó local | `dm.block`/`dm.unblock` | **não, por desenho** (§31.9 regra 2) | sim | não | com `dm.unblock` |
| `self_high_water` | **exclusivamente local** | o nó local | o caminho de append | não | **sim, obrigatoriamente** | **sim** — é o que impede o fork de §31.13 | nunca antes de `identity.wipe` |
| `forgotten_*_length` | **exclusivamente local** | o nó local | `dm.forget` | não | **sim, obrigatoriamente** | sim (impede a conversa "voltar") | nunca antes de `identity.wipe` |
| `dm_local_read_state` | **exclusivamente local** | o nó local | leitura, `dm.markRead` | **não** | sim | não | recomputável; some com a conversa |
| `dm_prefs.contactPolicy` | **exclusivamente local** | o nó local | `dm.setContactPolicy` | não | sim | não | com `identity.wipe` |
| Estado de conexão e `DmSync` | **de transporte** | o nó local | o watchdog | não | **não** | não | ao cair a conexão |
| `dm.typing`, "o outro está na chamada" | **de transporte, efêmero** | o emissor | o emissor | não persiste | **não** | não | por TTL (5 s) |
| Blocos de blob | **replicado, sob demanda** | o autor do anexo | ninguém | sim (sparse) | sim | não | GC de §22.4 e `retain_until` |

### 31.24 Limitações declaradas

As cinco entram na lista consolidada de §25.8, que se declara **completa e fechada**.

| # | Limitação | Onde | Superfície de UI obrigatória |
|---|---|---|---|
| **L-25** | **Uma conversa direta nunca some por inteiro do disco de quem participou dela.** `dm.forget` limpa blocos e projeção, mas a linha de `dm_conversations` sobrevive com `self_high_water` e os comprimentos de esquecimento — sem eles, escrever de novo produziria fork contra a cópia do par. Só `identity.wipe` apaga tudo | §31.19 | Texto na confirmação de "esquecer conversa" |
| **L-26** | **A entrega exige as duas pontas online ao mesmo tempo, em algum momento.** Não há store-and-forward, e não haverá (§25.4, A29). Escrever é sempre possível e a mensagem é final assim que escrita; o que espera é a **replicação**. Uma mensagem para alguém que nunca mais aparece nunca chega | §31.10, §31.11 | Estado "não entregue" com o tempo desde a escrita, **sem afirmar a causa** |
| **L-27** | **A ordem de uma conversa direta é um acordo entre as duas partes.** Uma parte pode escrever um `ack` maior do que o que realmente viu e posicionar as próprias mensagens fora da ordem causal. A outra vê isso **marcado** (`ackAhead`), não corrigido — não há terceiro a enganar, e recusar daria a um contador quebrado o poder de parar a conversa | §31.6 | Marca de "ordem provisória" na faixa afetada |
| **L-28** | **Bloquear é silencioso e indistinguível de estar offline.** O bloqueado vê o mesmo que veria se você estivesse desligado: o `ack` dele não avança. É deliberado — avisar transformaria o bloqueio num sinal para escalar | §31.9 | Texto na confirmação de bloqueio, dizendo que o outro não é avisado |
| **L-29** | **Voz numa conversa direta falha mais que voz numa comunidade.** Não há relay voluntário: ele pressupõe uma comunidade com terceiros, e numa dupla não há terceiro. Com nenhum dos dois lados alcançável (**L-11**, **L-11b**), a chamada não acontece e não há a quem recorrer | §31.15 | Diagnóstico de rede + `conn-failed` com o motivo, sem oferecer relay |

### 31.25 Edições exigidas em outras seções

Nenhuma altera semântica existente; todas são acréscimos a tabelas que se declaram fechadas
e que, por isso, **precisam** receber a linha nova em vez de conviver com uma referência
solta.

| Seção | Edição |
|---|---|
| **§2** | Linha de A29 na tabela-resumo |
| **§4** | `dmCodec` (L1), `dmFold` (L1), `dmProjector` (L1→L0) e `directMessages` (L2) na tabela de módulos; `dmFold` entra na regra de pureza do fim da seção |
| **§5.2** | Os oito prefixos de §31.3 |
| **§10.2** | `dm_conversations`, `dm_local_read_state`, `dm_prefs`, e a migração numerada correspondente |
| **§10.3** | `dm_ds_snapshot`, `dm_messages`, `dm_reactions`, `dm_attachments`, `dm_participants`, `dm_rejected_records`; bump de `view_schema_version` |
| **§10.3.1** | `dm_interpreted:<conversationId>` e `dm_fold_panic:<conversationId>` na lista fechada |
| **§14.1** | A linha "Conversa direta — **sem tópico**" |
| **§15.3** | `dm.forget` na classe `main-confirmed` |
| **§16.1** | A linha `p2p-dm/1`, e a sinalização de mídia nela (2026-09-02) |
| **§20.2** | Os quatro códigos de §31.17, e a contagem passa de 86 para **90** |
| **§25.8** | L-25..L-29 |
| **§27.1** | `DM_VERSION` 1 |
| **§27.2** | As quatro variáveis `P2P_DM_*` de §31.18 |
| **§29** | A linha de fase da conversa direta, com gate **G14** |
| **`plano-de-validacao-experimental-v2.md`** | **Feito (2026-09-01):** POC-14 / G14, com hipótese, critério de aprovação e consequência objetiva de falha, e a entrada na tabela de gates e na ordem de execução |
| **`deltas-ux-v2.md`** | **Feito (2026-09-02):** **U-33**, a conversa direta como superfície nova inteira — a lista e os pedidos, os cinco estados de §31.9, os rótulos de entrega que **não** podem afirmar a causa, a marca de ordem provisória, os textos obrigatórios de esquecer e bloquear, e a chamada sem relay. As cinco superfícies que §31.24 torna obrigatórias estão nele; o resto é derivação de §31.16. O que **não** se deriva continua em **B63** |
| **§3.5** | **Feito (§118, B64, 2026-09-03).** A rota `u/<KEY64>` carrega a chave de identidade; a regra 3 vale igual (só posiciona na confirmação) |

### 31.26 Gate

**G14 — determinismo e convergência do `dmFold`.** Mesma família de G1, e pela mesma razão:
uma função de interpretação nova, sobre a qual todo o resto se apoia, sem serializador que
esconda divergência.

O que G14 precisa medir:

1. **Determinismo do merge.** Dois nós com os mesmos dois logs, chegando em ordens de
   replicação diferentes, produzem hash de dump idêntico do estado projetado. Inclui a
   inserção retroativa e a reinterpretação a partir de snapshot de §31.13.
2. **Totalidade.** Fuzzer sobre registros hostis — bytes aleatórios, `kind` desconhecido,
   `DM_VERSION` desconhecida, payload truncado, AEAD que não abre, `authorSeq` fora de RD-3,
   `ack` absurdo, `ts` retroativo — sem que o `dmFold` lance uma única vez.
3. **Convergência sob partição.** Escrita concorrente dos dois lados durante partição, com
   reconciliação depois; os dois lados convergem para a mesma ordem e para o mesmo estado.
4. **A afirmação aberta de §31.13.** Se o `hypercore@11.x` permite a um escritor recompor o
   próprio core, a partir de um par, sem antes appendar. **Enquanto isso não for medido, a
   saída de `desynced` não pode ser implementada como restauração automática.**
5. **Ausência de fork sob crash.** `SIGKILL` em cada ponto do caminho de append, com a
   verificação de `self_high_water` no boot seguinte, sem que um fork chegue a existir.

**Consequência objetiva de falha:** se (1) ou (3) reprovarem, o merge de §31.6 não é a
solução e a decisão de A29 reabre. Se (2) reprovar, é bug de implementação, não de desenho.
Se (4) reprovar, `desynced` vira terminal e **L-25** ganha uma segunda metade. Se (5)
reprovar, a barreira de §31.10 não é suficiente e a escrita de DM precisa de uma fila durável
em `manifest.db` — o que reintroduziria parte de §11 e precisaria de emenda própria.

---

## Apêndice A — Mapa store → comando IPC

A assinatura da ação no frontend **não muda** — só o corpo. As linhas marcadas **⚠**
mudaram de contrato em relação a v1 e exigem ajuste no componente; estão detalhadas em
`deltas-ux-v2.md`.

| Store / ação | Comando IPC | Observação |
|---|---|---|
| `identityStore.createIdentity` | `identity.create` | — |
| `identityStore.setPresence` | `identity.setPresence` | Efêmero |
| `identityStore.updateIdentity` | `identity.update` | **⚠** assíncrono: devolve `queued[]` |
| `identityStore.clearIdentity` | `identity.wipe` | **⚠** exige token de confirmação nativa |
| *(novo)* | `identity.export` / `identity.import` | **⚠** telas novas (U-01) |
| `communityStore.createCommunity` | `community.create` | Lote de gênese |
| `communityStore.joinCommunity` | `invite.redeem` | — |
| `communityStore.updateCommunity` | `community.update` | **⚠** salvamento explícito (U-23) |
| `communityStore.leaveCommunity` | `community.leave` → `kind` `member.leave` | — |
| `communityStore.endCommunity` | `community.end` | **⚠** token de confirmação |
| `communityStore.createInvite` | `invite.create` | `code` só para quem cria |
| `communityStore.revokeInvite` | `invite.revoke` | — |
| `communityStore.createRole` / `updateRole` / `deleteRole` | `role.create` / `.update` / `.delete` | **⚠** salvamento explícito |
| `communityStore.moveRole` | `role.move` | **⚠** devolve `{rank}`, não `positions[]` |
| `communityStore.setMemberRoles` | `member.setRoles` | **⚠** devolve `appliedRoleIds` |
| `communityStore.setMemberNickname` | `member.setNickname` | — |
| `communityStore.createChannel` … `deleteCategory` | `channel.*` / `category.*` | **⚠** `afterChannelId` no lugar de `position` |
| `communityStore.toggleChannelMuted` | `channel.setMuted` | Local |
| `communityStore.markChannelRead` | `channel.markRead` | **⚠** devolve menções também |
| `communityStore.toggleCategoryCollapsed` | `category.setCollapsed` | Local |
| `communityStore.setActiveChannel` | `nav.setActive` | **⚠** o núcleo é o dono |
| `communityStore.setLocalRoleOverride` | *(some)* | — |
| `messageStore.send` | `message.send` | Assíncrono |
| `messageStore.retrySend` | `message.retry` | **Mesmo `opId`** |
| `messageStore.flushQueued` / `dropQueued` | *(some)* | Vira evento |
| `messageStore.toggleReaction` | `message.react{present}` | **⚠** deixa de ser toggle |
| `messageStore.setPinned` / `editMessage` / `deleteMessage` / `createThread` | `message.pin` / `.edit` / `.delete` / `thread.create` | **⚠** todos assíncronos agora (U-02) |
| `messageStore.setTyping` | `presencePublish{typingChannelId}` | Efêmero |
| `moderationStore.ban` / `revokeBan` / `kick` / `applyTimeout` / `removeTimeout` | `mod.*` | — |
| `moderationStore.log` | `query.auditLog` + `auditLog.changed` | **⚠** evento novo |
| `voiceStore.join` / `leave` | `voice.join` / `voice.leave` | **⚠** devolve `iceServers` e `tickets` |
| `voiceStore.toggleMute/Deafen/Camera` | `voice.setSelf` | — |
| `voiceStore.setVolume` | `settings.setParticipantVolume` | **⚠** agora persiste |
| `voiceStore.setParticipantMuted` | `voice.muteParticipant` | **⚠** declarado como conselho (U-08) |
| `voiceStore.startShare` / `stopShare` | `share.start` / `share.stop` | **⚠** `captureToken` antes de capturar |
| `voiceStore.setQuality` | `share.setQuality` | **⚠** agora funciona (estrela) |
| `voiceStore.respondConsent` | `relay.respondConsent` | — |
| `downloadStore.start` | `blob.download` | **⚠** exige `blobsCoreKey` |
| *(novo)* | `file.pickForAttachment` | **⚠** substitui o caminho local |
| `connectionStore.setHostStatus` | *(evento)* | `host.statusChanged` com enum fechado |
| `settingsStore.setDevice` / `setVolume` | `settings.*` | — |
| *(novo)* | `query.preferences` | **⚠** fecha a leitura que faltava (U-24) |
| `settingsStore.runDiagnostic` | `diag.run` | — |
| `searchIndex.search` | `query.search` | FTS5 no núcleo |
| Todos os `select*` | `query.*` | Colapsam fixture+override numa camada só |

**Regra de migração:** cada store deixa de guardar dado de domínio e passa a guardar
**cache de leitura invalidado por evento**, reconstruído no boot e após `evStale`.

---

*Fim da Especificação Técnica do Backend v2.*
