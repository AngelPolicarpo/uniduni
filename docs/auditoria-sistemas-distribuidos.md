# Auditoria de Sistemas Distribuídos e Confiabilidade — Uniduni

> Análise do `backend.md` (2986 linhas) tratado como **sistema distribuído real**, com
> `frontend.md`, `auditoria-adversarial.md` e `dry-run-implementacao.md` como contexto.
>
> **Recorte deliberado:** este documento não reaudita arquitetura, contrato ou regra de
> negócio — isso já foi feito (F-01…F-50, DR-01…DR-51). Aqui só entra o que aparece quando
> se assume **falha parcial**: mensagem duplicada, perdida, atrasada ou fora de ordem; ACK
> perdido; crash no meio de uma operação; restart; reconexão; partição; concorrência real.
>
> **Premissa metodológica:** "existe retry" não é resposta. Todo mecanismo de confiabilidade
> foi submetido a três perguntas: *o que acontece se a mensagem que confirma se perder?*,
> *o que acontece se o processo morrer exatamente aqui?*, *o que acontece se dois
> acontecerem ao mesmo tempo?* Um mecanismo só conta como resolvido se a spec **define** a
> resposta — não se ela é inferível por um leitor caridoso.

---

## Convenções

**Severidade**

| Nível | Critério |
|---|---|
| **CRITICAL** | Perde dado confirmado, diverge réplicas permanentemente, ou quebra a comunidade para todos os membros de forma não recuperável |
| **HIGH** | Produz estado incorreto observável pelo usuário, ou reporta o oposto do que aconteceu |
| **MEDIUM** | Degrada, trava ou desperdiça recurso de forma não reportada; correto só por acaso |
| **LOW** | Custo, ruído ou diagnóstico ruim, sem corrupção |

**Relação com os documentos existentes.** Onde um achado toca um F-xx ou DR-xx, a relação
está declarada: `≠` = ângulo novo sobre o mesmo local; `⊃` = generaliza; `→` = usa como
pré-condição. Nenhum achado abaixo é uma reformulação de achado existente.

**Notação temporal.** `T0`, `T1`… são instantes; `‖` marca concorrência real; `✗` marca o
ponto de crash ou perda.

---

# CRITICAL

## DS-01 — A validação lê a projeção, que está atrás do log em que o próprio host acabou de appendar

**Cenário.** O host valida uma op contra um estado materializado que é atualizado por um
processo assíncrono e em lote. Entre appendar um registro e vê-lo refletido no estado de
validação existe uma janela de até um lote inteiro. Toda decisão de autorização e toda
invariante estrutural são tomadas dentro dessa janela.

**Estado inicial.** Comunidade com host online, projetor rodando com
`PROJECTOR_BATCH = 256`, reativo a `append`. `#ajuda` existe. Bruno tem `manage_channels`.

**Sequência temporal.**

| t | Evento |
|---|---|
| T0 | Bruno envia `channel.delete(#ajuda)`. Fila de uma via (§12.3) processa: estágios 1–12 passam. |
| T1 | `core.append` → `seq = 900`. Host responde `{seq:900}`. |
| T2 | O projetor **ainda não rodou** — §6.4 passo 6 diz que ele reage ao `append`; §12.4 diz que um append durante um lote entra no lote seguinte. `channels.deleted_at` continua `NULL`. |
| T3 | Ana envia `message.send(channelId = #ajuda)`. Estágio 12 (§9.3) checa "canal é texto, **não deletado**" contra a projeção → **passa**. |
| T4 | `core.append` → `seq = 901`. Host responde `{seq:901, hostTs}`. Ana remove da outbox, UI mostra entregue. |
| T5 | O projetor roda o lote. Aplica 900 (tombstone do canal) e 901 (mensagem). |
| T6 | Invariante **I-6** ("toda mensagem aponta para um canal de texto não deletado") falha → `E_INVARIANT` → transação abortada → `projector.failed` → comunidade `degraded`. |
| T7 | O mesmo acontece **em toda réplica**, deterministicamente, para sempre. Reprojetar reproduz. |

**Comportamento especificado atualmente.** §12.1 afirma o oposto com todas as letras:
*"Mensagem enviada no instante em que o canal é excluído → o host processa em ordem: se o
`channel.delete` chegou antes, a mensagem falha com `E_CHANNEL_NOT_FOUND`"*. §12.3 garante
serialização **do processamento**. §6.6 garante que o append **não** é atômico com a
projeção e que *"o host não tem caminho privilegiado"*. §12.1 garante que *"o projetor é o
único escritor das tabelas de projeção"*.

**Onde a spec deixa de definir.** As quatro afirmações acima são individualmente
verdadeiras e conjuntamente inconsistentes. Falta **a especificação da fonte e da
frescura do estado de validação**: §3.2 diz que o `validator` *"recebe roster e cargos como
argumento (função pura)"* e não diz quem monta o argumento nem a partir de quê (DR-14,
DR-28 → registram a ausência da assinatura; aqui o que falta é a **garantia de
consistência**). Nenhuma linha da spec exige que o estado de validação esteja em
`last_projected_seq == core.length − 1` no instante do estágio 12.

**Resultado incorreto / risco.** Toda corrida validação↔projeção vira **violação de
invariante no reducer**, e §6.4 define violação de invariante como parada permanente
(F-04 → pré-condição). Ou seja: o modo de falha desta corrida não é "op rejeitada tarde
demais", é **brick determinístico e replicado de toda a comunidade**. Os caminhos que
chegam lá, todos com pares de ops legítimas e comuns:

| Par de ops concorrentes | Invariante / índice violado | Consequência |
|---|---|---|
| `channel.delete` ‖ `message.send` | I-6 | brick |
| `channel.create(#x)` ‖ `channel.create(#x)` | `uniq_channels_name` | brick |
| `role.delete` ‖ `member.setRoles` referenciando-o | I-3 / FK lógica | brick |
| `category.delete` ‖ `channel.create` naquela categoria | I-5 | brick |
| `message.delete` ‖ `reaction.toggle` | I-8 | brick |
| `channel.delete` (último) ‖ `channel.delete` (penúltimo) | I-1 | brick |
| `mod.ban(Ana)` ‖ op de Ana | nenhuma — mas §12.1 promete `E_BANNED` e a op é aceita | divergência silenciosa |
| `role.move` ‖ `role.move` | I-4 (`position` denso e único) | brick (ver F-39) |

**Severidade.** **CRITICAL.** É a falha de maior alcance do documento: transforma
concorrência normal em perda permanente de comunidade, e o dano é irreversível porque o
registro venenoso fica no log para sempre.

**Mecanismo necessário para provar que está resolvido.**
1. Declarar explicitamente o **modelo de consistência do estado de validação**. Só duas
   formas fecham: (a) o host mantém estado autoritativo **em memória**, avançado
   sincronamente no mesmo ponto do `append`, e valida contra ele — a projeção vira
   consumidor puro; ou (b) o host projeta sincronamente até a própria cabeça antes de cada
   validação (mata o throughput de 500 ops/s).
2. Teste de harness multi-instância (§21.2) que submete os **oito pares** da tabela acima
   com atraso de projetor injetado (`PROJECTOR_BATCH` alto + pausa forçada), assertando que
   a segunda op de cada par é rejeitada com o erro nomeado e **nunca** appendada.
3. Asserção permanente (não só em dev, ver F-40): nenhum registro pode ser appendado com
   `last_projected_seq < seq − 1` sem passar por revalidação.

---

## DS-02 — `submitOp` confirma antes de a escrita ser durável, e o cliente libera a outbox na palavra do host

**Cenário.** Perda silenciosa de mensagem **com confirmação positiva**. É o oposto exato do
que a premissa 5 da UX promete.

**Estado inicial.** Ana com host online. Outbox vazia.

**Sequência temporal.**

| t | Evento |
|---|---|
| T0 | Ana: `message.send`. Item gravado em `local_outbox` com `state='queued'`. |
| T1 | `outbox.flush` → `sending` → `rpcClient.submitOp(envelope)`. |
| T2 | Host: pipeline OK → `core.append(record)` resolve → `seq = 4211`. |
| T3 | Host responde `{seq:4211, hostTs}`. |
| T4 | Ana: §11.3 passo 6 — **remove da outbox**, emite `message.accepted`. A UI marca entregue. |
| T5 | ✗ Host perde energia. O `core.flush()` de §2.3 (`draining`) nunca acontece — `draining` só roda em shutdown limpo. |
| T6 | Host reinicia. O core reabre com `length = 4211` (o registro 4211 não estava no disco). |
| T7 | A mensagem não existe para ninguém. Ana não tem mais nada na outbox. Nenhum evento é emitido. |

**Comportamento especificado atualmente.** §11.3 passo 5: *"Host: pipeline → `core.append`
→ devolve `{seq, hostTs}`"*. §11.3 passo 6: *"Cliente: **remove da outbox**"*. §2.3
`draining`: *"faz `core.flush()` de cada Hypercore"* — o que estabelece, por implicação,
que `append` sozinho **não** é durável.

**Onde a spec deixa de definir.** Não existe **barreira de durabilidade antes do ACK**. A
spec nunca diz que `submitOp` só pode responder depois de o registro estar em disco, e
nunca define o critério de liberação da outbox como "observado na réplica" em vez de
"confirmado pelo host". O único ponto onde `flush()` aparece é no shutdown limpo — isto é,
exatamente o caminho em que a durabilidade não é o problema.

**Resultado incorreto / risco.** Perda de dado confirmado, sem detecção possível pelo
cliente, num sistema em que **o host é a única cópia autoritativa** (ADR-01). Não há
quórum, não há segundo escritor, não há caminho de recuperação. Agrava-se com
`P2P_DHT_PERSIST` e com o host sendo um desktop doméstico — o modo de falha alvo (queda de
energia, bateria, `SIGKILL` do SO) é comum, não exótico.

**Severidade.** **CRITICAL.**

**Mecanismo necessário para provar que está resolvido.**
1. Especificar a barreira: `submitOp` responde **depois** do `flush()` (ou do equivalente
   de durabilidade do storage do corestore), com o custo de fsync declarado no orçamento de
   §19.1 (`submitOp` ponta a ponta < 60 ms — um fsync cabe, um por op não cabe: exige
   **group commit** por lote da fila de §12.3, que precisa ser especificado).
2. Mudar o critério de liberação da outbox: o item sai quando o cliente **observa o registro
   na própria réplica** (`messages.appended` cobrindo o `seq`), não no ACK. Isso resolve
   simultaneamente DS-06 e a janela de flicker de DR-19.
3. Teste de injeção de falha real (§21.3, `INF-05`): `SIGKILL` no host entre o `append`
   resolver e o ACK sair, e entre o ACK sair e o flush. Assertar que a mensagem ou existe
   para todos, ou continua na outbox de Ana — **nunca** o terceiro estado.

---

## DS-03 — A tabela de dedupe não tem ordenação definida com o append, e os dois ordenamentos possíveis são ambos catastróficos

**Cenário.** ADR-12 é o mecanismo que sustenta toda a afirmação de idempotência do sistema.
Ele consiste em duas escritas em subsistemas diferentes (`core.append` no Hypercore/RocksDB,
`local_dedupe` no SQLite) sem transação comum e **sem ordem especificada**.

**Estado inicial.** Host online. Ana com um item `sending` na outbox, `opId = X`.

**Sequência temporal — ordenamento A (dedupe antes do append).**

| t | Evento |
|---|---|
| T0 | Host recebe `X`. Estágio 5: `X` não está no dedupe. Estágios 6–12 passam. |
| T1 | `INSERT INTO local_dedupe (op_id=X, seq=4211)`. |
| T2 | ✗ Crash antes de `core.append` (ou o append falha com `E_STORAGE_FULL`). |
| T3 | Host reinicia. `core.length = 4211`. `X` está no dedupe apontando para um `seq` que não existe. |
| T4 | Ana retenta `X`. Estágio 5 acerta o dedupe → **`{seq:4211, duplicate:true}` — sucesso**. |
| T5 | Ana remove da outbox, emite `message.accepted`. A mensagem **nunca existiu**. |

**Sequência temporal — ordenamento B (dedupe depois do append).**

| t | Evento |
|---|---|
| T0–T1 | Idem. `core.append(X)` → `seq = 4211`, durável. |
| T2 | ✗ Crash antes do `INSERT` no dedupe (ou o commit se perde — ver DS-04). |
| T3 | Host reinicia. Registro 4211 existe. `X` **não** está no dedupe. |
| T4 | Ana retenta `X` (mesmo envelope, `opId` idêntico por construção). |
| T5 | Estágio 5 **não** acerta. Pipeline roda. `core.append(X)` de novo → `seq = 4212`. |
| T6 | Projetor aplica 4211: `INSERT INTO messages (id = 'msg-' + hex(X)[:12], …)`. |
| T7 | Projetor aplica 4212: **mesmo `id`** — `messages.id` é PK. `UNIQUE constraint failed`. |
| T8 | Reducer lança → transação abortada → `projector.failed` → `degraded` **em toda réplica, para sempre**. |

**Comportamento especificado atualmente.** ADR-12 e §5.5 descrevem o dedupe como um fato
(*"O host mantém `dedupe(opId → seq)` por 7 dias"*). §9.1 posiciona a consulta no estágio 5.
§4.7 define `Message.id = 'msg-' + hex do opId truncado em 12`, com a justificativa
*"Determinístico: reprojetar produz o mesmo id"*. §6.6 lista os escopos transacionais e
**não inclui** o par (append, dedupe).

**Onde a spec deixa de definir.** (a) A ordem entre as duas escritas. (b) Se elas devem ser
atômicas, e como, dado que estão em dois subsistemas de persistência distintos. (c) O
procedimento de reconciliação no boot do host (varrer o core dos últimos 7 dias e
reconstruir o dedupe é possível — o `opId` é derivável de cada envelope armazenado — mas
não está especificado em lugar nenhum, e é a única saída limpa).

**Resultado incorreto / risco.** No ordenamento A: perda silenciosa com ACK positivo, igual
a DS-02 mas por outro caminho, e persistente (o dedupe envenenado sobrevive 7 dias, então
**todo** retry da Ana falha em silêncio). No ordenamento B: o `opId` é, por construção, a
chave primária derivada da mensagem — um append duplicado **garante** colisão de PK. Isto é
categoricamente pior que F-05 (colisão aleatória em 48 bits, que exige azar): aqui a
colisão é **determinística e provocada pelo próprio mecanismo de retry**.

**Severidade.** **CRITICAL.**

**Mecanismo necessário para provar que está resolvido.**
1. Especificar o dedupe como **derivado do log, não como estado paralelo**: no boot, o host
   reconstrói `local_dedupe` varrendo os registros com `hostTs > now − 7d` e recomputando o
   `opId` de cada envelope. Com isso, a tabela vira cache e a ordem deixa de importar.
2. Se o dedupe permanecer como estado independente, exigir ordenamento B **mais** o passo de
   reconciliação do item 1 no boot, e declarar isso em §6.6.
3. Teste determinístico: `SIGKILL` do host injetado em cada um dos três pontos (antes do
   append, entre append e dedupe, depois do dedupe), com retry do mesmo envelope depois do
   restart. Assertar `core.length` e a projeção idênticas nas três variantes.
4. Assertar, na reprojeção de §21.4, que **nenhum `opId` aparece duas vezes** no log —
   verificação barata (um `SELECT COUNT(*) GROUP BY` sobre a tabela de opIds) que
   transforma o brick de T8 num erro de teste.

---

## DS-04 — `synchronous=NORMAL` é justificado pela projeção descartável e aplicado às tabelas que carregam as garantias de entrega e de idempotência

**Cenário.** O argumento de durabilidade é feito sobre um conjunto de tabelas e o PRAGMA
vale para o arquivo inteiro.

**Estado inicial.** Ana com 40 itens `queued` na outbox (host offline há 2 dias). Host, em
outra máquina, com 6 000 entradas em `local_dedupe`.

**Sequência temporal.**

| t | Evento |
|---|---|
| T0 | Cada `INSERT` na outbox commita. Em WAL + `synchronous=NORMAL`, o commit **não faz fsync** — ele grava no WAL e devolve. |
| T1 | ✗ Queda de energia (ou `SIGKILL` do SO, ou pane do driver de disco). |
| T2 | O SQLite recupera até o último frame **efetivamente escrito no disco**. As transações commitadas desde o último checkpoint podem não estar lá. |
| T3 | Ana reabre o app. Um número indeterminado dos 40 itens não existe mais. |
| T4 | Nenhum evento, nenhum `message.dropped`, nenhuma contagem. A promessa "a fila é durável: sobrevive a fechar e reabrir o app" foi cumprida para *fechar e reabrir*, e não para *crash*. |

O mesmo em `local_dedupe`, no host: perde as últimas N entradas → cai no ordenamento B de
DS-03 → append duplicado → brick.

**Comportamento especificado atualmente.** §6.3: *"**`synchronous=NORMAL` e não `FULL`:** a
projeção é descartável por definição. Perder os últimos milissegundos num crash custa uma
reprojeção parcial a partir de `last_projected_seq`, que é justamente o mecanismo que já
existe. `FULL` pagaria um fsync por transação para proteger dado reconstruível."*

**Onde a spec deixa de definir.** O raciocínio é correto e o escopo está errado. §6.1 fixa
**um único `view.db` para todas as comunidades**, e §6.3 põe na mesma base as tabelas
`local_*` — que §6.4 declara explicitamente **não** reconstruíveis (*"não-lidas,
silenciados e a outbox não podem morrer"*). A spec nunca reconcilia "SQLite é descartável"
(ADR-02, §5.4) com "estas oito tabelas não são". Não há política de durabilidade
diferenciada, e o SQLite não oferece `synchronous` por tabela.

**Resultado incorreto / risco.** As duas garantias mais fortes do produto — a fila durável
(premissa 5, ADR-11) e a idempotência (ADR-12) — repousam sobre um modo de persistência
escolhido com o argumento de que o dado é reconstruível. Nenhum dos dois é.

**Severidade.** **CRITICAL** (é o multiplicador de DS-02 e DS-03).

**Mecanismo necessário para provar que está resolvido.** Escolher uma:
- Base separada (`local.db`) com `synchronous=FULL` para as oito tabelas `local_*`, e
  `view.db` com `NORMAL` para a projeção — custa o ATTACH que §6.1 quis evitar, mas só a
  projeção precisa de junção cruzada.
- `synchronous=FULL` no arquivo único, com o custo de fsync medido em §21.6 (a projeção faz
  **uma** transação por lote de 256, então o custo real é ~1 fsync por 256 ops, não por op —
  provavelmente aceitável, e a justificativa de §6.3 superestima o preço).
- `PRAGMA synchronous` elevado transitoriamente em torno das escritas de outbox/dedupe
  (suportado: o PRAGMA é por conexão e mutável em runtime) — a mais barata, e precisa ser
  dita.

Prova: teste de perda de energia simulada (`kill -9` + `fsync` bloqueado por LD_PRELOAD, ou
`dm-flakey`), assertando que nenhum item de outbox commitado e nenhuma entrada de dedupe
desaparece.

---

## DS-05 — Dois resgates concorrentes do último uso de um convite: a serialização por comunidade não impede que os dois entrem

**Cenário.** Instância específica de DS-01, listada à parte porque a spec afirma a
propriedade contrária de forma explícita e porque o usuário do convite não tem como
detectar o erro.

**Estado inicial.** Convite `C` com `maxUses = 1`, `uses = 0`. Carla e Diego têm o código.

**Sequência temporal.**

| t | Evento |
|---|---|
| T0 | Carla e Diego chamam `inviteRedeem(C, proof)` ‖ (dentro de 50 ms). |
| T1 | A fila de uma via (§12.3) processa Carla. Lê `invites.uses` da projeção = 0. `0 < 1` → OK. |
| T2 | Appenda `member.join(Carla)` → `seq = 500`. Responde. |
| T3 | A fila processa Diego. Lê `invites.uses` **da projeção** — o projetor ainda não aplicou 500 (§6.6: append não é atômico com projeção). Lê **0**. `0 < 1` → OK. |
| T4 | Appenda `member.join(Diego)` → `seq = 501`. Responde. |
| T5 | Projetor aplica 500 e 501. `uses` vira 2 num convite de `maxUses = 1`. Os dois são membros. |

**Comportamento especificado atualmente.** §11.4: *"O host **serializa por comunidade**
(§12.3): reavalia tudo, incrementa `uses`, appenda `member.join` num lote atômico com o
incremento."* §11.4 Falhas: *"dois candidatos no último uso → um entra, o outro recebe
`E_INVITE_EXHAUSTED`, **nunca os dois**"*. §12.1 repete a garantia.

**Onde a spec deixa de definir.** A frase *"appenda `member.join` num lote atômico com o
incremento"* descreve uma transação que atravessa o Hypercore e o SQLite, o que §6.6 diz
não existir, e uma escrita direta do host numa tabela de projeção, o que §12.1 proíbe (*"o
projetor é o único escritor"*). Não há op `invite.use` no catálogo de §5.3, então `uses` só
pode ser **derivado** contando `member.join` com aquele `inviteCodeHash` — e derivar
significa ler a projeção, que está atrás. As três afirmações não coexistem.

O mesmo vale para `invite.revoke`: a spec declara que *"a mitigação de link vazado é
revogar"* (§11.4), e a janela em que a revogação ainda não vale não é definida nem limitada.

**Resultado incorreto / risco.** `maxUses` é a única defesa contra link vazado num produto
que corta aprovação manual por decisão de UX. Ela vale "na maioria das vezes". Um atacante
que distribui o código para N clientes disparando simultaneamente entra com todos.
Encadeia com F-06 (`member.join` não é produzível por ninguém) e F-02 (o host não verifica
prova de convite que não criou) — o fluxo de entrada é a área mais frágil do sistema.

**Severidade.** **CRITICAL** (segurança + a spec afirma o contrário).

**Mecanismo necessário para provar que está resolvido.**
1. `uses` precisa ser lido do **estado autoritativo do host** (DS-01, item 1), não da
   projeção, ou o resgate precisa ser um `compare-and-append` sobre o log.
2. Teste: `inviteRedeem` de 10 peers simultâneos contra `maxUses = 1`, com o projetor
   pausado à força. Assertar exatamente 1 `member.join` no log e 9 `E_INVITE_EXHAUSTED`.
3. Assertar como invariante de projeção (§4.18, invariante nova): `invites.uses ≤ max_uses`
   para todo convite — hoje isso não é checado, então o erro é invisível até alguém contar.

---

# HIGH

## DS-06 — Não existe reconciliação entre a outbox e a projeção: um item entregue e depois expirado é reportado ao usuário como não enviado

**Cenário.** O host aceita a op, o ACK se perde, o host fica fora do ar por mais tempo que a
janela da outbox, e o cliente informa o usuário do oposto do que aconteceu.

**Estado inicial.** Ana com uma mensagem `sending`.

**Sequência temporal.**

| t | Evento |
|---|---|
| T0 | `submitOp` chega. Host valida, appenda (`seq = 900`), começa a responder. |
| T1 | ✗ A conexão cai antes do ACK chegar. §10.5: *"requests em voo falham com `E_HOST_UNAVAILABLE` e voltam para a outbox"*. Item volta a `queued`. |
| T2 | Host permanece fora do ar (viagem, mudança de máquina) por 5 dias. |
| T3 | `outbox.expire` (a cada 5 min) marca o item `dropped/expired` às 72 h. `message.dropped{reason:'expired'}`. UI: "1 mensagem não foi enviada: expirou". |
| T4 | Dia 5: host volta. A réplica de Ana replica o registro 900. O projetor aplica. `messages.appended`. |
| T5 | A mensagem aparece no canal, enviada por Ana, com a hora de 5 dias atrás — depois de o app ter afirmado que ela não foi enviada. |

**Comportamento especificado atualmente.** §6.5: `OUTBOX_MAX_AGE_MS = 72h`, motivo
`expired`, *"e o usuário é avisado"*. §11.9: *"nunca some calado, nunca fica pendente para
sempre"*. §10.3: `message.dropped{opId, reason, channelId}`.

**Onde a spec deixa de definir.** Não há **nenhum** ponto em que a outbox consulte a
projeção antes de descartar, nem depois. E a consulta é trivial: `Message.id` é derivado do
`opId` (§4.7), então `SELECT 1 FROM messages WHERE id = 'msg-' + hex(opId)[:12]` responde
"isto foi entregue?" em microssegundos. A spec constrói a chave e nunca a usa. Faltam três
pontos de reconciliação:

| Ponto | O que falta decidir |
|---|---|
| Boot | Itens `sending` (DR-22 → registra a ausência; aqui o ponto é que a resposta certa é *consultar a projeção*, não devolver cegamente a `queued`) |
| Antes de expirar | Item de 72 h cujo `opId` já está projetado deve sair **como entregue**, não como `expired` |
| Antes de descartar por erro terminal | Ver DS-07 |

**Resultado incorreto / risco.** O produto mente na direção mais cara: diz "não enviei"
quando enviou. O usuário reescreve e reenvia — agora com `nonce`/`ts` novos, `opId` novo,
fora do alcance do ADR-12 — e a mensagem aparece **duas vezes** quando o host volta.

**Severidade.** **HIGH.**

**Mecanismo necessário para provar que está resolvido.** Especificar `outbox.reconcile()`
como passo obrigatório em: boot, `host.cameBack`, e imediatamente antes de qualquer
transição para `dropped`. Teste: host derrubado entre append e ACK, cliente mantido offline
por `OUTBOX_MAX_AGE_MS + 1`, assertando que o desfecho é `message.accepted`, não
`message.dropped`.

---

## DS-07 — Retry fora da janela de dedupe transforma uma op já aplicada em descarte terminal com motivo errado

**Cenário.** O dedupe é a única coisa que impede a revalidação de uma op já aceita. Quando
ele falha por qualquer motivo (restart do host — DS-03/DS-04 —, janela de 7 dias vencida,
comunidade migrada), o retry passa pelo pipeline **contra um estado que mudou desde então**.

**Estado inicial.** Ana envia uma mensagem em `#design`.

**Sequência temporal.**

| t | Evento |
|---|---|
| T0 | Host aceita e appenda em `seq = 900`. ✗ ACK se perde. |
| T1 | Item volta a `queued`, backoff. |
| T2 | Bruno exclui `#design` (`seq = 901`). |
| T3 | Host reinicia por qualquer motivo; `local_dedupe` não foi reconstruído (não há procedimento — DS-03). |
| T4 | Ana retenta. Estágio 5: dedupe vazio → segue. Estágio 12: canal não existe → **`E_CHANNEL_NOT_FOUND`**. |
| T5 | §6.5: `E_CHANNEL_NOT_FOUND` é **erro terminal**. Item vira `dropped`, motivo `channel-deleted`. |
| T6 | UI (§11.9): *"1 mensagem não foi enviada: #design não existe mais"*. A mensagem **está no log em `seq = 900`** e todos os outros membros a viram. |

Variantes com o mesmo desfecho: Ana banida entre T0 e T4 (`E_BANNED` terminal); Ana perde
`send_messages` (`E_PERMISSION_DENIED` terminal); a mensagem respondia a outra mensagem que
foi deletada (`E_MESSAGE_DELETED` terminal).

**Comportamento especificado atualmente.** §11.3 Falhas: *"timeout com a op **já aplicada** →
o retry devolve `duplicate:true` e o `seq` original, sem duplicar (ADR-12)"*. Isso é
verdadeiro **dentro** da janela e com a tabela intacta, e a spec não trata o fora.

**Onde a spec deixa de definir.** Que um erro terminal no retry **não** prova que a op não
foi aplicada. A classificação terminal/transitório de §6.5 é feita sobre o **código de
erro**, sem considerar se a op é uma primeira tentativa ou um retry. Um erro terminal na
tentativa 1 significa "nunca foi aplicada"; na tentativa N significa "não pode ser aplicada
**agora**" — duas coisas diferentes com a mesma etiqueta.

**Resultado incorreto / risco.** Divergência entre o que o autor acredita e o que a
comunidade vê, com uma frase específica e errada na UI. Além disso, todo o valor da
categoria "motivo nomeado" de §11.9 (que existe para o produto nunca dizer "sumiu") é gasto
para dizer algo falso com precisão.

**Severidade.** **HIGH.**

**Mecanismo necessário para provar que está resolvido.** Regra: antes de qualquer transição
para `dropped`, o cliente consulta a projeção pelo `opId` (DS-06). Se está lá, o desfecho é
`accepted`. Teste: forçar `attempts ≥ 1` + limpar o dedupe do host + mudar o estado que o
estágio 12 checa, assertando `message.accepted`.

---

## DS-08 — `banned` e `community-ended` são motivos de descarte inalcançáveis: o mecanismo que os torna verdadeiros é o mesmo que impede o cliente de descobri-los

**Cenário.** O usuário pediu explicitamente: *membro é banido enquanto possui operações
pendentes*.

**Estado inicial.** Ana com 40 itens `queued` (host esteve offline 2 dias). Ana é banida em
`seq = 900` enquanto está offline.

**Sequência temporal.**

| t | Evento |
|---|---|
| T0 | Host aplica `mod.ban(Ana)`. §11.11 passo 4: *"O host adiciona a chave ao `firewall` do swarm e **derruba a conexão ativa** do alvo."* |
| T1 | Ana volta. `swarm` tenta conectar ao host. O `firewall` recusa **na conexão** (§3.2, `swarm`). |
| T2 | 2 falhas consecutivas → `host.wentOffline`. UI: banner "host offline". |
| T3 | `outbox.flush` a cada 1 s: `E_HOST_UNAVAILABLE` — **transitório** (§6.5). Backoff até 60 s. Circuit breaker abre e fecha. |
| T4 | Ana não replica o core (a conexão nem existe), então **nunca recebe o registro do ban**. Ela é banida e não sabe. |
| T5 | 72 h depois: 40 × `message.dropped{reason:'expired'}`. |

**Comportamento especificado atualmente.** §11.9 lista os motivos possíveis: *"`channel-deleted`,
`left-community`, `community-ended`, **`banned`**, `expired`, `permission-lost`"*. §11.11
Efeitos colaterais: *"o alvo recebe `E_BANNED` na próxima op"*.

**Onde a spec deixa de definir.** *"O alvo recebe `E_BANNED` na próxima op"* pressupõe uma
conexão que o passo 4 do mesmo fluxo acabou de tornar impossível. Não há caminho
especificado pelo qual um cliente banido descubra o ban: o firewall corta o RPC, e a
replicação do core vem pela mesma conexão. DR-30 nota que membros replicam entre si e o
firewall é só do host — mas isso é observação de brecha, não caminho de descoberta
especificado, e não há regra que mande o cliente concluir "fui banido" a partir de um
registro replicado por terceiro.

Idêntico para `community-ended`: §11.21 diz que o host, ao encerrar, *"sai do swarm como
servidor"* — quem estava offline naquele instante nunca replica o registro `community.end`
(DR-36 → pelo lado da replicação; aqui o efeito é na fila) e vê host offline para sempre.
E para `permission-lost`, que exige detectar uma mudança de cargo que só chega pela
projeção.

**Resultado incorreto / risco.** Três dos seis motivos nomeados de §11.9 são inatingíveis
na prática. Ser banido é indistinguível de o host estar offline, por 72 horas, e o usuário
recebe o diagnóstico errado no fim. Retry inútil contra o firewall por 3 dias (≈4.300
tentativas por item, mesma tempestade que F-29 descreve para `E_TIMED_OUT`).

**Severidade.** **HIGH.**

**Mecanismo necessário para provar que está resolvido.** Definir o canal de notificação de
ban: ou o firewall permite a conexão e o host responde `E_BANNED` a tudo (contradiz §11.11
passo 4 e F-10 — precisa ser decidido de um jeito só), ou existe um handshake mínimo
pré-firewall que devolve o estado. Teste: banir com 40 itens na fila e assertar que os 40
saem com motivo `banned` em ≤ um ciclo de flush, e não com `expired` em 72 h.

---

## DS-09 — O dedupe (estágio 5) roda antes do rate limit (estágio 9) e depois da verificação Ed25519 (estágio 3): replay de envelope é o caminho mais barato de produzir e o mais caro de processar

**Cenário.** Peer malicioso ou cliente com bug envia repetidamente envelopes já aceitos.

**Estado inicial.** Comunidade com host online. Mallory é membro (ou ex-membro não banido)
e guardou 500 envelopes que já enviou legitimamente.

**Sequência temporal.**

| t | Evento |
|---|---|
| T0 | Mallory abre a conexão RPC. `hello` OK. |
| T1 | Dispara `submitOp` com envelopes reciclados, 8 em voo (o teto de §10.5), em loop fechado. |
| T2 | Para cada um o host executa: estágio 1 (tamanho), 2 (decode), **3 — verificação Ed25519, ~50 µs**, 4 (author match), 5 (dedupe hit) → responde `{seq, duplicate:true}`. **Sucesso.** |
| T3 | O estágio 9 (rate limit por autor) **nunca é alcançado**. Nenhum token é consumido. |
| T4 | A fila de uma via de §12.3 é a mesma para todos: cada verificação de Mallory atrasa a op legítima de todo mundo. |

Com 8 em voo e ~60 µs por item na fila serializada, um único peer satura a meta declarada de
500 ops/s de §12.3 sem violar nenhum limite especificado.

**Comportamento especificado atualmente.** §9.1 fixa a ordem dos 12 estágios (*"para no
primeiro que falhar"*), com dedupe em 5 e rate limit em 9. §19.3 define token bucket **por
autor, por comunidade**. §10.5 define concorrência de 8 requests em voo por peer. §19.3
define um limite pré-membro só para `inviteResolve` (*"por IP de peer"*, cuja
implementabilidade DR-31 já questiona).

**Onde a spec deixa de definir.** Não existe **rate limit por conexão** para `submitOp`, e
o limite por autor está posicionado depois de todo o trabalho criptográfico. A ordem dos
estágios está correta do ponto de vista de *semântica* (dedupe tem de vir antes da
autorização, senão um retry legítimo depois de um ban falharia) e errada do ponto de vista
de *custo*. A spec nunca separa as duas preocupações.

**Resultado incorreto / risco.** DoS de host por um membro qualquer, sem violar limite
declarado nenhum, contra um alvo que é um desktop doméstico single-threaded e é o SPOF de
escrita de toda a comunidade (ADR-01). §13.5 põe "RPC de entrada" como prioridade 1
justamente para o host não ficar lento para os membros — o que faz do RPC de entrada o
melhor vetor.

**Severidade.** **HIGH.**

**Mecanismo necessário para provar que está resolvido.** Um limite de taxa **por conexão de
peer**, aplicado antes do estágio 3 (a chave do peer vem do handshake Noise, é confiável e
está disponível de graça — §7). Métrica `rpc.rejectedPreAuth`. Teste do adversário (§21.5):
peer que só faz replay, assertando que o p95 de `submitOp` dos membros legítimos não se
degrada além do teto de §19.1 (250 ms).

---

## DS-10 — O flush imediato em `host.cameBack` reintroduz exatamente a avalanche que o jitter de §13.3 existe para evitar, e a fila do host não tem profundidade nem shedding

**Cenário.** Thundering herd na reconexão, com o mecanismo de defesa aplicado ao evento
errado.

**Estado inicial.** Comunidade de 340 membros (escala de referência, §19.2). Host offline
há 6 horas. Cada membro com 5 a 40 itens na outbox.

**Sequência temporal.**

| t | Evento |
|---|---|
| T0 | Host volta. Anuncia no DHT. |
| T1 | Os clientes reconectam **com jitter** (§13.3) — a defesa funciona aqui. Espalham-se em ~60 s. |
| T2 | Cada `hello` bem-sucedido dispara `host.cameBack`, que dispara `outbox.flush` **imediato** (§13.1: *"1 s, ou **imediato em `host.cameBack`**"*). Sem jitter. |
| T3 | Cada cliente manda `submitOps` de até 32 envelopes (§10.6), 8 em voo (§10.5). |
| T4 | O host recebe até 340 × 8 = 2 720 requests concorrentes, com até 32 ops cada, numa **fila de uma via sem profundidade máxima** (§12.3). |
| T5 | O teto de conexões é 128 (§19.2) — abaixo dos 340 membros (F-14 → já registra o problema do teto; aqui o efeito é a fila). As conexões excedentes ficam na fila do Hyperswarm, reconectam, e o ciclo se repete. |
| T6 | Requests esperam na fila; o timeout de RPC é 15 s (§10.5). Os que estouram voltam para a outbox como `E_TIMEOUT` (transitório) e **serão reenviados**, dobrando a carga. |

**Comportamento especificado atualmente.** §13.3: *"O jitter não é enfeite: sem ele, 340
membros reconectam em fase depois de o host voltar e produzem uma avalanche exatamente no
pior momento."* §13.1 aplica o flush imediato. §12.3 declara a fila *"não é gargalo"* com
base em ~60 µs por op — cálculo de latência, não de fila.

**Onde a spec deixa de definir.** (a) Profundidade máxima da fila de §12.3 e política ao
estourar (`E_BUSY` só cobre o teto de 8 por peer, que não é um teto agregado). (b) Se o
flush imediato leva jitter. (c) O que o host faz quando a fila cresce além do que consegue
drenar dentro do timeout de 15 s dos requests que já estão nela — hoje ele processa ops
cujo cliente já desistiu, e cada uma dessas gera um retry.

**Resultado incorreto / risco.** O pior momento do sistema (host acabou de voltar, todo
mundo tem fila) é exatamente onde não há controle de admissão. O modo de falha é
auto-amplificado: timeout → retry → mais carga → mais timeout.

**Severidade.** **HIGH.**

**Mecanismo necessário para provar que está resolvido.** Jitter no flush pós-reconexão
(mesma curva de §13.3); teto de profundidade da fila do host com `E_BUSY` + `retryAfterMs`
quando estourar; descarte de requests cujo prazo já venceu antes de processá-los. Prova:
§21.2 com 100+ instâncias simuladas (o cenário de A-2), medindo p95 de `submitOp` e taxa
de retry induzido durante os primeiros 120 s pós-reconexão.

---

## DS-11 — Um buraco de replicação congela a projeção indefinidamente, sem timeout, sem estado e sem evento

**Cenário.** O projetor é estritamente sequencial por exigência da invariante I-10. Um único
bloco indisponível para o quanto ele consegue avançar.

**Estado inicial.** Ana, membro. `last_projected_seq = 899`. `core.length = 950` (a
assinatura de comprimento chegou; os blocos, nem todos).

**Sequência temporal.**

| t | Evento |
|---|---|
| T0 | Ana replica. Hypercore baixa blocos **fora de ordem** (comportamento normal). Chegam 900, 902–950. O 901 vem do host, que cai antes de enviá-lo. |
| T1 | Projetor: §6.4 passo 2 — *"Lê do core em lotes de `PROJECTOR_BATCH` a partir de `seq+1`"*. Aplica 900. |
| T2 | Pede 901. `core.get(901)` **aguarda a rede**. Sem timeout especificado. |
| T3 | Nenhum outro peer tem o 901 (comunidade pequena, ou os outros também estão atrás). |
| T4 | O projetor fica parado. Os registros 902–950 estão **no disco de Ana** e não são aplicados — I-10 proíbe buraco na sequência aplicada. |
| T5 | Nenhum evento é emitido. `hostStatus` fica `offline`, o que é verdade, mas não explica que a réplica tem 49 mensagens paradas em disco. `unread` congela. A busca (§11.15) devolve `partial: true` — correto por acaso, pelo motivo errado. |

**Comportamento especificado atualmente.** §6.4 descreve o algoritmo sequencial. §4.18 I-10:
*"não há buraco na sequência aplicada"*. §2.3 (`open`) trata core **corrompido**, não core
**incompleto**. §6.4 trata assinatura inválida e reducer que lança; não trata bloco ausente.

**Onde a spec deixa de definir.** (a) Timeout de leitura do core no projetor. (b) Estado
observável para "réplica atrás por falta de bloco" — não é `degraded` (nada falhou) nem
`ready` (não está em dia). (c) Evento correspondente. (d) Se o projetor deve pré-baixar o
lote inteiro antes de abrir a transação SQLite (obrigatório: §6.4 passo 4 põe os reducers
*dentro* da transação, e aguardar rede com uma transação de escrita aberta trava todo
escritor pelo `busy_timeout=5000`, quebrando toda escrita local — inclusive a outbox).

**Resultado incorreto / risco.** A UI mostra um canal parado numa mensagem antiga enquanto
as novas estão em disco. Com ADR-16 (todas as comunidades replicam em background), o caso é
comum, não raro. E o ponto (d) é um risco de travamento do processo inteiro, não só de uma
comunidade.

**Severidade.** **HIGH.**

**Mecanismo necessário para provar que está resolvido.** Especificar: leitura do lote
**fora** da transação, com timeout; estado `lagging{missingSeq, haveUpTo}` distinto de
`degraded`; evento correspondente para a UI; e a decisão sobre se I-10 permanece
inegociável (ela é o que impede aplicar 902–950 fora de ordem — e como o log é imutável e
totalmente ordenado, aplicar fora de ordem não é uma opção legítima: a solução é a
transparência, não a flexibilização). Teste: `dev.dropBlobPeer` estendido para derrubar um
bloco específico do core, assertando que o estado e o evento aparecem em ≤ 5 s.

---

## DS-12 — `reaction.toggle` é a única op não comutativa do catálogo, e sua correção depende inteiramente da durabilidade do dedupe

**Cenário.** Encadeamento direto de DS-03 e DS-04, isolado porque o efeito é visível e
porque a spec já identificou a dependência sem tratar a fragilidade dela.

**Estado inicial.** Ana reagiu com 👍 na mensagem `M`. Estado: reação presente.

**Sequência temporal.**

| t | Evento |
|---|---|
| T0 | Ana clica de novo (remover). `reaction.toggle(M, 👍)`, `opId = Y`. |
| T1 | Host aceita, appenda em `seq = 900`. ✗ ACK perdido. |
| T2 | Item volta a `queued`. |
| T3 | ✗ O host reinicia e o dedupe não é reconstruído (DS-03), **ou** as últimas entradas do dedupe não sobreviveram ao crash (DS-04), **ou** passaram 7 dias. |
| T4 | Retry de `Y`. Estágio 5 não acerta. Pipeline passa (nada mudou). `core.append` → `seq = 950`. |
| T5 | Projeção: 900 inverte (remove), 950 inverte (**insere de volta**). Estado final: reação presente. |
| T6 | Ana clicou para remover e a reação está lá. Clicar de novo repete o ciclo. |

Note que aqui **não há colisão de PK** — a reação não deriva id do `opId` — então o sistema
não quebra: ele simplesmente fica errado, em silêncio, e converge para o valor errado em
todas as réplicas.

**Comportamento especificado atualmente.** §4.9: *"É **idempotente por natureza do estado
final**, mas não por reenvio — daí o dedupe por `opId` (ADR-12) ser obrigatório aqui: dois
envios do mesmo toggle não podem virar duas inversões."* §12.1 confirma.

**Onde a spec deixa de definir.** A spec identifica corretamente que este é o ponto em que
o dedupe é *load-bearing* e não avalia o que acontece quando ele falha. Nenhuma das três
condições de T3 é tratada. E a alternativa óbvia — trocar `toggle` por `set(messageId,
emoji, present: bool)`, que é comutativo, idempotente e imune a tudo isso — não é
considerada nem descartada.

**Resultado incorreto / risco.** Estado convergente e errado. Além disso, torna a janela de
dedupe de 7 dias uma **exigência de correção**, e não uma otimização — o que muda a
severidade de qualquer falha na tabela de dedupe.

**Severidade.** **HIGH.**

**Mecanismo necessário para provar que está resolvido.** Ou tornar a op comutativa
(`reaction.set` com valor absoluto — a mudança mais barata e a que elimina a classe
inteira), ou provar durabilidade e reconstrutibilidade do dedupe (DS-03, DS-04). Teste:
mesmo envelope de toggle submetido 2× com dedupe limpo entre as tentativas, assertando o
estado final.

---

## DS-13 — `hostTs` e `flags` estão fora da assinatura: o host reescreve carimbo e `clockSkewed` de qualquer registro sem que nenhuma réplica possa detectar

**Cenário.** Peer malicioso — especificamente o host, que §5.1 e §21.5 tratam como
adversário declarado.

**Estado inicial.** Comunidade normal. Host adversário.

**Sequência temporal.**

| t | Evento |
|---|---|
| T0 | Ana envia uma mensagem às 14:00 com `op.ts = 14:00`, assinada. |
| T1 | O host appenda `LogRecord{envelope, hostTs, flags}`. `envelope` é assinado; `hostTs` e `flags` **não são**. |
| T2 | O host grava `hostTs = 03:00` e `flags = 0x01` (`clockSkewed`). |
| T3 | Toda réplica verifica a assinatura do envelope → **válida**. §4.7: com `clockSkewed`, a UI mostra `hostTs` e o aviso de `spec:371`. |
| T4 | Todo mundo vê a mensagem de Ana carimbada às 03:00, com um aviso que atribui a discrepância ao **relógio da Ana**. Ana não tem como contestar: seu `op.ts` está correto no log, mas a UI não o mostra. |

**Comportamento especificado atualmente.** §5.1: *"O que o host pode e o que não pode: ele
pode **omitir** e **reordenar** ops; **não pode forjar** — a assinatura é do autor e toda
réplica verifica."* §5.1 sobre `flags`: bit 0 = `clockSkewed`. §4.7 manda a UI exibir
`hostTs` quando `clockSkewed`. §21.5 promete um teste de host adversário.

**Onde a spec deixa de definir.** A afirmação "não pode forjar" está correta sobre o
**conteúdo** e é falsa sobre os **metadados**, e a spec não faz a distinção. Dois dos três
campos do `LogRecord` estão fora do escopo da assinatura, e um deles (`flags`) controla
diretamente o que a interface exibe. A spec também não define limites de sanidade sobre
`hostTs` que uma réplica pudesse checar (por exemplo, monotonicidade em relação ao `seq` —
que hoje não é exigida nem verificada, e sem a qual `hostTs` não serve nem para ordenar).

**Resultado incorreto / risco.** Um host pode reescrever a linha do tempo aparente de
qualquer conversa e atribuir a anomalia ao autor. Isso derrota o propósito declarado da
terceira camada de autenticação de §7 (*"a assinatura da op prova quem escreveu, para
sempre e para todo mundo, **inclusive contra o próprio host**"*). O ângulo de moderação é
pior: `moderation_log.at` sai do `hostTs`.

**Severidade.** **HIGH.**

**Mecanismo necessário para provar que está resolvido.** Ou (a) o host assina o `LogRecord`
inteiro com a chave do host (barato: uma assinatura por registro, verificável por todos,
e o `hostKey` já é conhecido e imutável), ou (b) a UI nunca exibe campo não assinado como
fato, e §4.7 muda para "relógio do autor, sempre", com `hostTs` tratado como dica de
diagnóstico. Assertar monotonicidade de `hostTs` por `seq` na projeção, com métrica.
Teste: estender §21.5 com um host que altera `flags` e `hostTs`, assertando detecção.

---

## DS-14 — `share.assignment` não tem ACK, retry nem sinal de recepção de quadro: uma subárvore inteira escurece com `treeHealth: ok`

**Cenário.** ACK perdido num protocolo de controle que só tem heartbeat na direção que não
prova nada.

**Estado inicial.** Sessão de tela em árvore. Nó `R` retransmite para 3 filhos.

**Sequência temporal.**

| t | Evento |
|---|---|
| T0 | O host recalcula a árvore (alguém entrou) e reatribui o filho `C` de `R` para `R'`. |
| T1 | Host envia `treeAssign` a `C` pelo canal efêmero (§10.7). **Sem ACK, sem TTL, sem retry** — a tabela de §10.7 não define nenhum dos três para `treeAssign`. |
| T2 | ✗ A mensagem se perde (reconexão do protomux, buffer estourado, o que for). |
| T3 | `C` continua apontando para `R`. `R` já removeu `C` da lista de filhos ao receber sua própria atribuição. `C` **para de receber quadros**. |
| T4 | `C` continua mandando `shareHeartbeat{sessionId, childCount, rttMs}` a cada 2 s. O host recebe, conclui que `C` está vivo. |
| T5 | `share.treeHealth` reporta `ok`. Os filhos de `C` também escurecem. A UI de `C` mostra a transmissão travada, sem erro. |

**Comportamento especificado atualmente.** §10.7: `treeAssign` host→nó, TTL "—", sem
menção a confirmação. §11.17 passo 8: *"Heartbeat de 2 s; 3 ausências (6 s) = nó morto →
recálculo → reatribuição"*. §10.6: `shareHeartbeat` devolve `{assignment?}` — o que sugere
um caminho de correção, mas o host só o usa quando **ele** sabe que precisa reatribuir.

**Onde a spec deixa de definir.** O heartbeat prova que o nó está **vivo**, não que ele
está **recebendo quadros**. Não há sinal de recepção no protocolo (§10.8 define `seq`
monotônico por sessão, que seria exatamente o dado necessário, e o heartbeat não o carrega).
Não há confirmação nem reenvio de `treeAssign`. Não há detecção de "atribuído e mudo".

**Resultado incorreto / risco.** Falha silenciosa de subárvore, com o painel de diagnóstico
de 2.4.2 reportando saúde. Como o fanout de nó de repasse é 3 (§10.8), uma perda no nível 1
apaga até 4 pessoas de uma vez.

**Severidade.** **HIGH.**

**Mecanismo necessário para provar que está resolvido.** `shareHeartbeat` passa a carregar
`lastFrameSeq` e `framesLastWindow`; o host trata "vivo mas sem quadros por > N s" como
nó a reatribuir (mesma máquina do nó morto); `treeAssign` ganha ACK e reenvio com backoff.
Teste (§21.3): descartar o `treeAssign` de um nó específico e assertar recuperação em ≤ 6 s
e `treeHealth != ok` durante a janela.

---

## DS-15 — Um nó vivo particionado apenas do host é declarado morto, e passa a existir com dois pais alimentando os mesmos filhos

**Cenário.** Partição parcial — o caso que distingue um sistema distribuído de um
cliente-servidor.

**Estado inicial.** Sessão em árvore. Nó `R` com 3 filhos. Caminho `R`↔host degradado;
caminhos `R`↔apresentador e `R`↔filhos íntegros.

**Sequência temporal.**

| t | Evento |
|---|---|
| T0 | Os `shareHeartbeat` de `R` param de chegar ao host (só aquele caminho). |
| T1 | T0+6 s: `tree.watchdog` declara `R` morto (§13.1). Recalcula. |
| T2 | Host emite `share.assignment` aos 3 filhos, apontando para `R'`. |
| T3 | `R` **não recebe nada** (é o caminho quebrado) e continua recebendo do apresentador e **encaminhando** para os 3 filhos. |
| T4 | Cada filho agora recebe o mesmo stream de `R` e de `R'`. §10.8 define `seq` monotônico por sessão, e **não define descarte de quadro duplicado no receptor**. |
| T5 | O downlink de cada filho dobra; o jitter buffer recebe cada quadro duas vezes; o `VideoDecoder` recebe quadros repetidos. |
| T6 | `R` continua consumindo um slot de fanout do apresentador (≤ 5, §10.8), que o host acredita ter liberado. Um espectador novo é colocado num slot que não existe. |

**Comportamento especificado atualmente.** §11.17 passo 8 define morte por ausência de
heartbeat e reparo por recálculo. §11.17.1 define o recálculo como **incremental** (*"só
quem muda de pai recebe `share.assignment`"*) — o que garante que `R`, cujo pai não mudou,
não seja notificado de nada.

**Onde a spec deixa de definir.** (a) Que "não responde ao host" ≠ "morto". (b) O que o nó
reatribuído faz com o fluxo do pai antigo (fechar o stream UDX é a resposta óbvia e não está
escrita, e depende do filho saber que mudou de pai — o que T2 garante mas T3 não). (c)
Descarte de duplicata por `seq` no receptor. (d) Como o host reconcilia sua visão do fanout
com a realidade quando um nó "morto" não morreu.

**Resultado incorreto / risco.** Consumo duplicado de banda exatamente nos nós que foram
escolhidos por terem banda; contabilidade de fanout divergente no host; e um nó zumbi
transmitindo até a sessão acabar.

**Severidade.** **HIGH.**

**Mecanismo necessário para provar que está resolvido.** Regra explícita: ao receber
`share.assignment`, o nó **fecha** o stream do pai anterior antes de abrir o novo; o
receptor descarta `seq` já visto; o host, ao reatribuir por watchdog, envia um
`treeRevoke` ao nó declarado morto (best-effort) e valida a topologia contra os
`childCount` reportados. Teste: partição seletiva host↔nó com `dev.dropTreeNode` estendido,
assertando ausência de quadro duplicado nos filhos.

---

## DS-16 — Um timeout de IPC leva o usuário a repetir a ação, e a repetição produz um `opId` diferente — fora do alcance do ADR-12

**Cenário.** A spec cita a idempotência do ADR-12 como a resposta ao timeout de IPC, e o
ADR-12 não cobre esse caso.

**Estado inicial.** Bruno cria um canal. Host lento (fila cheia, ver DS-10).

**Sequência temporal.**

| t | Evento |
|---|---|
| T0 | Bruno: `channel.create{name:'design'}`. Comando ⏱, timeout de 30 000 ms (§10.1). |
| T1 | O núcleo monta `Op{v, kind, author, ts: T1, nonce: N1, payload}`, assina, `opId = X1`. `submitOp`. |
| T2 | O host processa em 31 s (fila). O núcleo já devolveu `E_TIMEOUT` ao renderer em T0+30 s. §10.1: *"o núcleo **continua** processando (o comando pode ter sido aplicado — daí a idempotência de ADR-12 ser obrigatória)"*. |
| T3 | A UI mostra erro. Bruno clica "Criar" de novo. |
| T4 | O núcleo monta uma **nova** `Op`: `ts = T4 ≠ T1`, `nonce = N2 ≠ N1` → **`opId = X2 ≠ X1`**. Estágio 5 não acerta. |
| T5 | Duas ops `channel.create{name:'design'}` no log. |
| T6 | Se a projeção alcançou X1 antes de X2 ser validada: X2 é rejeitada com `E_CHANNEL_NAME_TAKEN`. Se não (DS-01): **as duas são appendadas** e o reducer viola `uniq_channels_name` → `projector.failed` → **brick**. |

**Comportamento especificado atualmente.** ADR-12, coluna Motivo: *"Reenvio pela outbox,
reconexão no meio do RPC e **retry manual do usuário** produzem exatamente o mesmo
envelope. Sem dedupe, 'Tentar novamente' duplicaria mensagem."* §10.1 repete a
dependência.

**Onde a spec deixa de definir.** *"Retry manual do usuário produz exatamente o mesmo
envelope"* é uma afirmação sobre um mecanismo que não existe. Para ser verdadeira seria
preciso: (a) o `nonce` **e** o `ts` serem congelados na primeira tentativa e reusados; (b)
existir onde guardá-los — e os comandos ⏱ **não passam pela outbox** (§11.5, §25 delta 12:
"só mensagem enfileira"), então o envelope é construído e descartado no caminho do RPC.
Não há armazenamento especificado para o envelope de uma op de estrutura. `message.retry`
existe e opera sobre `{opId}` — só serve para o que está na outbox.

**Resultado incorreto / risco.** Duplicação real (dois cargos, dois convites, duas
categorias, dois `thread.create`) ou brick (DS-01) para toda a família de comandos ⏱:
`channel.create`, `category.create`, `role.create`, `invite.create`, `thread.create`,
`message.pin`, `message.react`, `mod.*`. `message.react` é o pior: dupla inversão de toggle
(DS-12) pelo caminho do usuário, não pelo da rede.

**Severidade.** **HIGH.**

**Mecanismo necessário para provar que está resolvido.** Uma tabela de envelopes em voo
(pode ser a própria outbox com um estado novo), chaveada por `clientRef`, de onde o retry
recupera o envelope **original**. Ou o `clientRef` (que §11.3 já define para mensagens) ser
obrigatório em todos os comandos de escrita e entrar na derivação do `nonce`, tornando o
`opId` determinístico por intenção do usuário e não por instante de construção. Teste: timeout
de IPC forçado + retry pela UI, assertando `duplicate: true` e um único registro no log.

---

# MEDIUM

## DS-17 — A transição de catch-up para modo reativo não tem barreira, e não há watchdog comparando `core.length` com `last_projected_seq`

**Cenário.** Evento perdido na única janela em que o projetor não está nem em loop nem
inscrito.

**Sequência.** §6.4 passo 6: *"Repete até alcançar `core.length`; depois passa a reagir a
`append`"*. Se um `append` chega entre a última checagem de `core.length` e a instalação do
listener, ele não é visto por nenhum dos dois caminhos. A réplica fica um registro atrás
até o **próximo** append — em canal de baixo tráfego, horas ou dias.

**Onde a spec deixa de definir.** A ordem (inscrever antes de checar) e a idempotência do
handler (o handler deve reler `core.length`, não confiar no evento). E não existe nenhuma
verificação periódica de `core.length − 1 == last_projected_seq` — a única sonda de
sanidade da réplica.

**Resultado / risco.** Réplica silenciosamente atrasada, sem sintoma. Também mascara DS-11:
os dois têm o mesmo sintoma e causas diferentes, e nenhum tem instrumentação.

**Severidade.** **MEDIUM.**

**Prova.** Inscrever antes de checar, handler idempotente, e um job de sanidade (o
`db.maintenance` de 24 h é infrequente demais; 60 s é barato) emitindo métrica
`projector.lagSeq`. Teste: append único injetado exatamente na janela de transição.

---

## DS-18 — Todos os caches de §19.4 são invalidados exclusivamente por evento, e nenhum evento sobrevive a um crash entre o commit e a emissão

**Cenário.** §6.4 passo 5: *"Commit. Emite um delta agregado."* São dois passos, e o
segundo não é transacional com o primeiro.

**Sequência.** Projetor commita o lote (cargos mudaram) → ✗ crash → main reinicia o núcleo
(§2.3) → `core.restarted` → o renderer mostra "Reconectando…". Os seis caches de §19.4
(permissões efetivas, cargos, estrutura, páginas de mensagem, disponibilidade de blob,
statements) estão obsoletos e **nenhum evento de invalidação foi emitido**.

**Onde a spec deixa de definir.** O que acontece com o estado do renderer depois de
`core.restarted`. DR-07 registra a ausência do procedimento de reconexão do IPC; o ângulo
aqui é a **invalidação**: §19.4 declara *"Cada cache tem invalidação explícita, nunca TTL
cego sobre dado replicado"*, e a invalidação explícita é um evento que pode não existir.
F-17 cobre o mesmo pelo lado do backpressure (`ipc.dropped`); este é o lado do crash, e
tem uma solução diferente (o backpressure avisa que descartou; o crash não avisa nada).

**Resultado / risco.** Permissões obsoletas exibidas na UI depois de um restart — inclusive
"posso moderar" para quem perdeu o cargo. A verdade continua no host (§8.5, terceiro ponto
de enforcement), então não é falha de segurança; é falha de honestidade da interface, que é
o princípio 3 da spec de UX.

**Severidade.** **MEDIUM.**

**Prova.** Regra: `core.restarted` invalida **tudo** no renderer, incondicionalmente.
Teste: matar o núcleo entre commit e emissão, assertando que a primeira query pós-restart
reflete o estado commitado.

---

## DS-19 — Reprojeção total: depende de `meta`, que ela apaga, e é o remédio especificado para uma falha que ela reproduz

**Cenário.** Recuperação que não recupera.

**Sequência (a) — dependência circular.** §6.3 lista `meta` entre as tabelas de **projeção**
(chaves `schema_version`, `last_projected_seq:<id>`, `op_version`). §6.4: *"apaga **só** as
tabelas de projeção, zera os `last_projected_seq`, reprojeta do 0"*. Apagar `meta` apaga
`schema_version` — o valor cuja divergência acabou de disparar a reprojeção, e o valor que o
boot lê antes de tudo (§2.3). DR-21 registra a mesma circularidade pelo lado de
`communities`; `meta` é o segundo caso e não está registrado.

**Sequência (b) — remédio que reproduz o problema.** §6.4: *"Reprojeção total dispara quando
… `projector.failed` seguido de reinício."* Mas `projector.failed` vem de um reducer que
lançou sobre um registro que **está no log**. Reprojetar do 0 chega no mesmo registro e
lança de novo. Cada boot gasta os ~20 s de reprojeção de uma comunidade de 200 k mensagens
(§6.4) para terminar no mesmo `degraded`. Não há contador de tentativas, não há circuit
breaker, não há caminho de quarentena do registro venenoso, e §2.3 (que limita reinícios do
processo a 3 em 60 s) não se aplica porque `projector.failed` não derruba o processo.

**Onde a spec deixa de definir.** (a) Onde vive `schema_version` se `meta` é descartável.
(b) Qualquer política de recuperação para registro venenoso permanente — a auditoria já
aponta a ausência em "Requisitos que parecem incompletos", item 3; aqui o que se acrescenta
é que **a reprojeção está especificada como o remédio e é comprovadamente inócua**.

**Resultado / risco.** Recuperação que consome CPU e não recupera, e um boot que fica mais
lento a cada tentativa do usuário.

**Severidade.** **MEDIUM** (o dano de fundo é F-04; o que este achado acrescenta é que o
mecanismo de saída não sai).

**Prova.** `meta` (ou ao menos `schema_version` e o registro de participação) fora do
conjunto descartável. Política de registro venenoso: quarentena com `seq` registrado,
projeção continua, réplica marcada como divergente e a divergência é **exibida**. Teste:
injetar um registro que faz um reducer lançar e assertar que a comunidade continua legível
e que o estado divergente é reportado.

---

## DS-20 — `local_dedupe` não tem `community_id`, teto, nem limpeza ao sair de uma comunidade

**Cenário.** A tabela que sustenta o ADR-12 é `(op_id BLOB PK, seq INT, first_seen_at INT)`
num `view.db` compartilhado por até 50 comunidades (§6.1, §19.2).

**Problemas concretos.**
1. `seq` é por comunidade e a linha não diz de qual. A resposta `{seq, duplicate:true}` de
   um `opId` só é interpretável se o chamador já souber a comunidade — o que é verdade no
   caminho feliz e deixa de ser em qualquer reconciliação (DS-06) ou diagnóstico.
2. Não há teto. `OUTBOX_MAX_ITEMS` existe (500/comunidade); a tabela de dedupe do host não
   tem equivalente. O único freio é o rate limit (§19.3: 20 ops/10 s por autor) — com 340
   membros e 7 dias, o teto teórico é da ordem de 10⁸ linhas. O caso realista é bem menor,
   mas a spec não dá **nenhum** limite nem métrica de tamanho, e o job `dedupe.prune` roda
   só de hora em hora.
3. Sair, ser expulso, ou encerrar uma comunidade não limpa as entradas dela — não há
   `community_id` para filtrar.
4. `identity.wipe` apaga tudo (§11.22), então o único caminho de limpeza é destrutivo.

**Onde a spec deixa de definir.** O escopo da tabela, o teto e o comportamento no
fechamento de comunidade. §13.4 promete que *"nenhum job sobrevive ao fechamento do seu
escopo"*, e esta tabela não tem escopo declarado.

**Severidade.** **MEDIUM.**

**Prova.** Acrescentar `community_id` à PK; teto e métrica; limpeza no `AbortSignal` do
ciclo de vida da comunidade (§13.4). Teste de crescimento sob carga sustentada por 7 dias
simulados.

---

## DS-21 — A ordem da outbox é por `created_at` — relógio de parede — em vez de sequência monotônica local

**Cenário.** §6.5: *"a outbox entrega **em ordem de `created_at` por canal** … senão a
segunda mensagem de uma conversa chegaria antes da primeira"*.

**Sequência.** Ana escreve "primeira" às 14:00:00.500 (`created_at = C1`). O SO sincroniza
NTP e o relógio recua 800 ms. Ana escreve "segunda", `created_at = C2 < C1`. O flush ordena
por `created_at` e entrega "segunda" antes de "primeira". Elas recebem `seq` nessa ordem, e
`seq` é a ordem canônica (§5.5) — a inversão é **permanente e replicada**.

Também acontece com: suspensão/retomada de laptop, correção de fuso em máquina sem RTC
(mesmo caso que §9.1 estágio 6 antecipa para `op.ts`), e VM restaurada de snapshot.

**Onde a spec deixa de definir.** Que a ordenação intra-canal precisa de um contador
monotônico local (um `INTEGER PRIMARY KEY AUTOINCREMENT` ou um `seq` local por canal), não
de um carimbo. A spec já reconhece que o relógio do autor não é confiável — é o motivo de
existir `clockSkewed`, do estágio 6 e de `CLK-02`/`CLK-04` — e usa esse mesmo relógio como
chave de ordenação da fila.

**Severidade.** **MEDIUM** (baixa probabilidade, efeito permanente).

**Prova.** Coluna monotônica local na outbox, e `ORDER BY` sobre ela. Teste com relógio
injetado (§3.2: `clock` é injetável exatamente para isto) recuando entre dois `message.send`.

---

## DS-22 — `blob.stage` interrompido não tem retomada, idempotência nem remoção: os bytes ficam no core de blobs para sempre

**Cenário.** Crash durante uma operação longa e não transacional.

**Sequência.** Ana anexa 6 GiB (o limite é 8 GiB, §9.2). `blob.stage` lê em stream e
escreve no `hyperblobs`. Aos 4 GiB, ✗ crash (ou `blob.cancel`, ou fechar o app). Ana repete.
O `blobId` é novo (é derivado da posição no core, não do conteúdo). Os 4 GiB anteriores
ficam num core **append-only que não encolhe** — §13.6 é explícito: *"O GC mexe **só no
cache local**. O core de blobs é append-only e não encolhe."* A regra "blob órfão criado há
> 24 h é removido do cache local" não toca o core.

**Onde a spec deixa de definir.** (a) Retomada de upload (DR-40 cobre a de **download**; a
de upload não está em lugar nenhum). (b) Idempotência de `blob.stage` — o hash BLAKE2b já é
calculado na mesma passada (§11.13) e serviria de chave natural, e não é usado para isso.
(c) Qualquer limite sobre o tamanho do core de blobs (`BLOB_CACHE_MAX_BYTES` governa o
cache local, não o core). (d) O que os **outros** membros fazem com esses blocos: eles
replicam sob demanda e ninguém pede blocos órfãos, então o custo fica no autor — mas o core
cresce para todo mundo que fizer replicação completa.

**Severidade.** **MEDIUM.**

**Prova.** `blob.stage` idempotente por hash de conteúdo, com retomada por offset. Teste:
matar o processo a 50 % de um upload de 1 GiB e assertar que o retry não duplica bytes.

---

## DS-23 — O rate limit de `message.send` e o lote de `submitOps` foram calibrados para objetivos opostos e se encontram no pior momento

**Cenário.** Os dois mecanismos existem para o mesmo instante — drenar a fila depois de um
período offline — e trabalham um contra o outro.

**Sequência.** Ana volta com 300 mensagens na fila (3 dias offline, dentro das 72 h).
`submitOps` manda 32 (§10.6, existe *"para amortizar o RTT quando a outbox esvazia depois de
um período offline"*, §12.3). O rate limit de `message.send` é **10 / 10 s, burst 20**
(§19.3). Do primeiro lote de 32, os itens 21–32 voltam `E_RATE_LIMITED` com `retryAfterMs`.
O regime estacionário é 1 mensagem por segundo: **300 s de drenagem**, com o banner de
pendentes visível o tempo todo e ~10 round-trips desperdiçados por lote.

**Onde a spec deixa de definir.** Que o rate limit é dimensionado para digitação interativa
(10 mensagens em 10 s é generoso para uma pessoa escrevendo) e aplicado a um caminho de
recuperação em lote. Não há isenção, escopo separado, nem reconhecimento da interação.
§19.3 diz apenas que *"a outbox respeita e não conta como tentativa falha"* — o que evita
o descarte por `attempts`, e não afeta o teto de 72 h por `created_at`: uma fila de 2 500
itens (o teto configurável de `OUTBOX_MAX_ITEMS`) não drena antes de expirar.

**Severidade.** **MEDIUM.**

**Prova.** Escopo de rate limit separado para flush de recuperação (por exemplo, um balde
com taxa maior e teto de burst amarrado ao tamanho da fila), ou reconhecer o limite e
dimensionar `OUTBOX_MAX_ITEMS` para o que é drenável dentro da janela de 72 h. Teste:
drenagem de 500 itens medindo tempo total e `E_RATE_LIMITED` emitidos.

---

## DS-24 — O circuit breaker consome tentativas da outbox sem tentar entregar nada

**Cenário.** Dois mecanismos de backoff empilhados, um contando as falhas do outro.

**Sequência.** §10.5: 5 falhas consecutivas de conexão → pausa de 30 s. §13.1:
`outbox.flush` roda a cada 1 s. Durante a pausa do breaker, cada flush falha
**imediatamente** — sem tocar a rede. Se cada uma dessas incrementa `attempts` (a spec não
diz que não), o backoff de §6.5 (`min(1000·2^attempts, 60000)`) satura em ~7 ciclos, isto é,
em 7 segundos de host indisponível. Um blip de 30 s deixa toda a fila com backoff de 60 s.

`host.cameBack` dispara flush imediato e repara o dano — **exceto** quando `host.cameBack`
não acontece: conexão que estabelece mas o `hello` falha por `E_VERSION_UNSUPPORTED`
(§10.6), host em `hosting-degraded` (§2.3) recusando ops com `E_HOST_UNAVAILABLE`, ou
firewall de ban (DS-08).

**Onde a spec deixa de definir.** Se uma rejeição do breaker conta como tentativa. Se o
backoff é por item ou por comunidade. O que `attempts` significa (tentativas de entrega ou
ciclos de flush).

**Severidade.** **MEDIUM.**

**Prova.** Declarar que só uma tentativa que chega à rede incrementa `attempts`. Teste:
breaker aberto por 30 s, assertando `attempts` inalterado.

---

## DS-25 — `E_VERSION_UNSUPPORTED` não está classificado na outbox: um cliente incompatível queima 72 h e descarta tudo como `expired`

**Cenário.** §10.6: *"`opVersion` incompatível → o cliente entra em modo somente-leitura
naquela comunidade"*. §6.5 divide os erros em terminais e transitórios por código, e
`E_VERSION_UNSUPPORTED` não está em nenhuma das duas listas (mesma classe de buraco que F-28
para `E_CLOCK_UNREASONABLE` e F-29 para `E_TIMED_OUT`; este código é o terceiro caso e não
está registrado).

**Sequência.** Ana atualiza o app; o host não. Ana tem 12 itens na fila. `hello` devolve
`E_VERSION_UNSUPPORTED`. Modo somente-leitura. Os 12 itens: retentam? viram `dropped`? Se
retentam, são 72 h de tentativas contra um host que **por definição** nunca os aceitará, e
o desfecho final é `expired` — de novo o motivo errado (DS-06, DS-08). Se viram `dropped`,
falta o motivo em §11.9 (a lista fechada não tem `version-mismatch`).

**Onde a spec deixa de definir.** A classificação do código e o motivo de descarte
correspondente. E o inverso: se o **host** atualiza e o cliente não, o cliente também
precisa de um caminho — a spec só descreve a direção cliente-novo.

**Severidade.** **MEDIUM.**

**Prova.** Linha no catálogo de §16.2, entrada em uma das duas listas de §6.5, motivo novo
em §11.9. Teste de harness com duas `opVersion` diferentes.

---

## DS-26 — `submitOps` para no primeiro erro terminal, e os itens não tentados não têm estado definido — nem podem ser bloqueados sem violar §6.5

**Cenário.** Falha parcial em lote.

**Sequência.** Lote de 32. Item 7 devolve `E_PERMISSION_DENIED` (terminal). §12.3: *"O host
processa o lote **na ordem**, para no primeiro erro terminal, e devolve um resultado por
item — os anteriores ficam aplicados."* Os itens 8–32 não têm resultado. O cliente:
mantém como `queued`? incrementa `attempts`? aplica backoff? Nenhum dos três está definido
(F-30 → registra a contradição com a regra 5 de §16.3; o que se acrescenta aqui é o
**estado dos não tentados** e a interação com a ordem).

E se o lote mistura canais — a spec não diz se `submitOps` é por canal —, então parar no
item 7 (canal A) segura os itens 8–32 (canais B, C), violando §6.5: *"Um item bloqueado não
segura os outros canais"*.

**Onde a spec deixa de definir.** (a) Se o lote é homogêneo por canal. (b) O estado de
retorno dos não tentados. (c) Se o cliente deve reenviar os não tentados imediatamente ou
esperar o próximo ciclo (reenviar imediatamente reproduz o problema; esperar 1 s × N lotes
multiplica a drenagem de DS-23).

**Severidade.** **MEDIUM.**

**Prova.** Lote homogêneo por canal, resultado explícito `not_attempted` por item,
reenvio imediato do resto sem contar tentativa. Teste: lote de 32 com erro terminal no
meio, assertando o estado dos 25 seguintes.

---

## DS-27 — Blob e mensagem são duas filas independentes sem barreira: a mensagem pode ser entregue dias depois de o blob ter deixado de existir em qualquer peer

**Cenário.** §6.6 declara explicitamente a não-transacionalidade e trata **um** dos dois
lados.

**Sequência.** Ana anexa um arquivo. `blob.stage` escreve no core de blobs local. Host
offline → `message.send` vai para a outbox. Ana fecha o app e viaja por 2 dias. O blob
existe **só na máquina dela** (§11.13: quem já tem serve automaticamente — ninguém mais
tem). Ana abre o app num aeroporto, a fila drena, a mensagem é aceita e replicada para todos.
Ana fecha o app antes de qualquer peer baixar o blob. Todos veem a mensagem com o anexo
`not-downloaded`; `blob.download` devolve `E_NO_PEERS`; `blob.unavailable` (§14.4) para todo
mundo, indefinidamente.

**Comportamento especificado atualmente.** §6.6: *"O blob vai primeiro; a mensagem depois.
Se a mensagem falhar, sobra um blob órfão — coletado pelo GC. A ordem inversa produziria
mensagem apontando para blob inexistente, que é um estado muito pior."*

**Onde a spec deixa de definir.** A spec resolve "blob sem mensagem" e não resolve
"mensagem sem blob **replicado**", que é o estado que ela mesma chama de "muito pior". A
ordem correta de escrita não garante disponibilidade: o blob precisa estar em **pelo menos
um outro peer** (naturalmente o host) antes de a mensagem ser entregue, e nada especifica
essa condição. Encadeia com F-03, que mostra que o caminho de escrita do blob é impossível
como escrito — o que significa que este achado precisa ser reavaliado **depois** de F-03 ser
resolvido, e a resolução de F-03 deve incluir a barreira.

**Severidade.** **MEDIUM.**

**Prova.** Condição de entrega: a op `message.send` com anexo só sai da outbox depois de o
host confirmar posse dos blocos (o `blobAnnounce` de §10.6 é o lugar natural, e hoje não tem
resposta que sirva de confirmação). Teste: anexar offline, entregar a mensagem, matar o
autor, assertar o desfecho.

---

## DS-28 — `message.cancelQueued` sobre um item `sending` é uma promessa local sem contrapartida no host

**Cenário.** §10.2: `message.cancelQueued{opId}` → erros `E_NOT_FOUND`, `E_ALREADY_SENT`.

**Sequência.** Item em `sending` — o `submitOp` está em voo. Ana clica em cancelar. O núcleo
devolve `E_ALREADY_SENT`, ou remove localmente e o host aceita mesmo assim. Não existe RPC
de cancelamento, e não poderia existir com utilidade: quando o host recebe o pedido, ou já
appendou (log append-only, ADR-10: nada é removido) ou vai appendar.

**Onde a spec deixa de definir.** Se `cancelQueued` sobre `sending` remove o item local
(deixando a mensagem aparecer depois, vinda da replicação, sem que a UI espere por ela) ou
recusa. DR-24 registra a pergunta; o ângulo distribuído é que **as duas respostas estão
erradas** e a única correta é "cancelar só existe enquanto `queued`, e a UI precisa dizer
isso" — decisão de produto que só o backend pode informar.

**Severidade.** **MEDIUM.**

**Prova.** Fechar o contrato: `cancelQueued` é rejeitado com `E_ALREADY_SENT` para qualquer
estado ≠ `queued`, e o estado da outbox precisa ser lido e trancado na mesma transação da
transição (senão o flush e o cancel correm entre si — concorrência local real, dentro do
mesmo processo, entre o loop de 1 s e o comando IPC).

---

## DS-29 — O host com relógio errado rejeita toda escrita da comunidade, sem diagnóstico e sem caminho de recuperação

**Cenário.** §9.1 estágio 6 valida `op.ts` contra `[hostTs − 7d, hostTs + 1d]`, onde
`hostTs` é o relógio do host.

**Sequência.** O host roda numa máquina cujo relógio salta 2 anos à frente (BIOS sem
bateria, VM restaurada, fuso mal configurado). Toda op de todo membro chega com
`op.ts` muito abaixo de `hostTs − 7d` → `E_CLOCK_UNREASONABLE` para **todos**,
permanentemente. A comunidade vira somente-leitura sem que nada indique por quê: F-28
mostra que o código nem está no catálogo, então o cliente não sabe classificá-lo, a UI não
tem frase para ele, e a outbox não sabe se retenta.

**Onde a spec deixa de definir.** (a) Qualquer sanidade sobre o relógio do **host** — a
spec trata o relógio do autor como suspeito (`clockSkewed`, estágio 6) e o do host como
verdade absoluta, sem justificar a assimetria: o host é um desktop doméstico igual aos
outros. (b) Um caminho de detecção: com 340 membros reportando `op.ts` consistentes entre
si e discrepantes do host, a evidência está toda disponível e não é usada. (c) O que
acontece com `hostTs` já gravado nos registros anteriores (ver DS-13: `hostTs` não é
monotônico por exigência nenhuma, então o log fica com um salto de 2 anos no meio,
permanente).

**Severidade.** **MEDIUM.**

**Prova.** Métrica `host.clockSkewVsPeers` (mediana da diferença `op.ts − hostTs` sobre as
últimas N ops de autores distintos); alerta e estado `hosting-degraded` quando ela passa de
um limiar; monotonicidade de `hostTs` por `seq` assertada na projeção.

---

# LOW

## DS-30 — `presence` e `typing` passam pelo host e não têm política de perda declarada

§10.7 define TTL (30 s / 5 s) e refresh (10 s / 3 s), o que dá tolerância a perda de graça —
o mecanismo está correto. O que falta é declarar: a entrega é **at-most-once, sem ACK e sem
retry**, e o efeito de uma perda é um avatar cinza por até 30 s. Está certo, e não está
escrito; F-13 cobre o custo de fan-out, não a semântica de entrega. Registrar em §10.7 fecha
a única superfície do sistema onde perda de mensagem é aceitável **por desenho** — e é
importante que seja a única.

**Severidade.** **LOW** (documentação de garantia, não defeito).

---

## DS-31 — A ordenação relativa entre `message.accepted` (RPC) e `messages.appended` (replicação) não é definida, e a UI depende das duas

O `message.accepted` chega pelo RPC; o `messages.appended` chega pela replicação + projeção.
São dois caminhos independentes e a ordem entre eles não é especificada — em host local
(comunidade própria) a projeção pode chegar **antes** do ACK; em host remoto, depois. DR-19
registra a janela pelo lado do flicker; o que falta é a afirmação explícita de que a UI
deve tolerar **as duas ordens** e que `messages.appended` é o sinal autoritativo. Vira
não-problema assim que DS-02 (liberar a outbox na observação, não no ACK) for adotado.

**Severidade.** **LOW** (some com DS-02).

---

# Propriedades: exigidas, afirmadas e efetivamente providas

O usuário pediu que nenhuma propriedade fosse presumida por causa da linguagem do documento.
A tabela abaixo separa as três colunas.

| Propriedade | O sistema **exige**? | A spec **afirma**? | **Provida?** | Por quê |
|---|---|---|---|---|
| **Ordem total** do log | Sim (é a base do ADR-01) | Sim (§5.5, `seq`) | **Sim, no log.** Não no estado de validação | O log tem um escritor único e ordem total. Mas nenhuma decisão do host é tomada contra o log — todas são tomadas contra a projeção, que está atrás (DS-01) |
| **Causal ordering** | Sim, intra-canal | Parcialmente (§6.5, por canal) | **Não** | Ordenação por relógio de parede (DS-21); nenhuma relação causal entre canais, entre blob e mensagem (DS-27), ou entre entidades dependentes |
| **At-least-once** (entrega da op) | Sim (premissa 5) | Sim, implicitamente (ADR-11) | **Não.** É *best-effort com tentativas limitadas* | Descarta por idade (72 h), por lotação (`E_OUTBOX_FULL`), e por erro terminal em retry (DS-07). Nenhum desses é "at-least-once" |
| **At-most-once** (efeito) | Sim, para `reaction.toggle` | Não é nomeada | **Não** | O toggle é a única op não comutativa e depende do dedupe (DS-12) |
| **Exactly-once** (efeito aplicado) | É o que ADR-12 promete na prática | Sim (§12.2: *"nunca produz efeito duplo"*) | **Não** | Dedupe com janela finita, tabela não durável (DS-04), sem ordenação com o append (DS-03), e sem cobertura do retry manual (DS-16) |
| **Idempotência** por `opId` | Sim | Sim (ADR-12) | **Parcial** | Vale para o retry da outbox com o envelope preservado, dentro de 7 dias, com a tabela intacta. Três condições, nenhuma garantida |
| **Idempotência dos reducers** | Não (o desenho evita precisar) | Não é nomeada | **Não é necessária, e isso está correto** | `last_projected_seq` avança na mesma transação (§6.4) — o único mecanismo de crash-safety do documento que está inteiramente certo |
| **Durability** do append aceito | Sim (é a única cópia) | Implicada por devolver `{seq}` | **Não** | Sem barreira de flush antes do ACK (DS-02) |
| **Durability** da fila local | Sim (premissa 5, explícita) | Sim (ADR-11: *"sobrevive a fechar e reabrir o app"*) | **Parcial** | Sobrevive a fechar/reabrir; não sobrevive a crash de SO ou queda de energia (DS-04). A afirmação está literalmente correta e é lida como mais forte do que é |
| **Eventual consistency** entre réplicas | Sim | Sim (§6.4, §21.4) | **Condicional** | Vale enquanto nenhum reducer lançar. Como há corridas que **garantem** que um lance (DS-01), a condição não se sustenta. Uma réplica em `degraded` nunca converge |
| **Determinismo da reprojeção** | Sim (§21.4 é o teste que protege a ADR-02) | Sim | **Ameaçado** | Por `hostTs`/`flags` não assinados (DS-13), por ids gerados pelo host (DR-11), e por pular registros de versão desconhecida (F-07, F-40) |
| **Read-your-writes** no host | Sim (§11.4 e §12.1 dependem) | Assumida sem ser nomeada | **Não** | DS-01, DS-05 |
| **Monotonic reads** no cliente | Desejável | Não é nomeada | **Não** | `degraded` e reprojeção fazem a UI andar para trás; não há contrato sobre isso |
| **Linearizabilidade** de resgate de convite | Sim (`maxUses` depende) | Sim (§11.4: *"nunca os dois"*) | **Não** | DS-05 |
| **Backpressure** | Sim, em 4 caminhos | Só em 1 (IPC, §10.1) | **Não** | Falta na fila do host (DS-10), no flush da outbox (DS-10), e na leitura do core pelo projetor (DS-11) |
| **Detecção de falha** (falha-parada vs. falha-omissão) | Sim | Assume falha-parada | **Não** | Heartbeat prova vida, não função (DS-14); "não fala com o host" é tratado como morte (DS-15) |

**Leitura resumida.** O documento descreve um sistema **CP com escritor único**, e a escolha
é boa: ADR-01 elimina de verdade a classe inteira de conflito de escrita, e §12.1 está certo
ao dizer isso. O que não está especificado é a **fronteira de consistência dentro do próprio
host** — entre o log (autoritativo, ordenado, durável-se-flushed) e a projeção (derivada,
atrasada, descartável). Quase todos os achados CRITICAL deste documento moram nessa
fronteira.

---

# Consolidação por categoria

## Failure Scenarios

| ID | Cenário | Sev. |
|---|---|---|
| DS-02 | Host cai depois de responder e antes de a escrita ser durável | CRITICAL |
| DS-03 | Crash entre o append e o registro de dedupe (ambos os ordenamentos) | CRITICAL |
| DS-04 | Queda de energia com transações de outbox/dedupe não sincronizadas | CRITICAL |
| DS-11 | Bloco indisponível congela a projeção sem estado nem timeout | HIGH |
| DS-14 | `treeAssign` perdido: subárvore escurece com saúde `ok` | HIGH |
| DS-15 | Nó particionado só do host é declarado morto e vira zumbi | HIGH |
| DS-22 | `blob.stage` interrompido deixa bytes permanentes e não retoma | MEDIUM |
| DS-29 | Relógio do host errado rejeita toda escrita da comunidade | MEDIUM |

## Consistency Risks

| ID | Risco | Sev. |
|---|---|---|
| DS-01 | Validação contra projeção atrasada → invariante violada → brick replicado | CRITICAL |
| DS-05 | `maxUses` de convite furado por corrida read-your-writes | CRITICAL |
| DS-12 | Toggle de reação converge para o valor errado em todas as réplicas | HIGH |
| DS-13 | Metadados não assinados permitem ao host reescrever a linha do tempo | HIGH |
| DS-18 | Caches invalidados só por evento; crash entre commit e emissão | MEDIUM |

## Recovery Risks

| ID | Risco | Sev. |
|---|---|---|
| DS-03 | Não há reconstrução do dedupe no boot | CRITICAL |
| DS-06 | Não há reconciliação outbox ↔ projeção em nenhum ponto | HIGH |
| DS-07 | Retry pós-restart vira descarte terminal com motivo falso | HIGH |
| DS-19 | Reprojeção depende de `meta`, que apaga; e reproduz a falha que deveria curar | MEDIUM |
| DS-17 | Sem watchdog de `core.length` vs `last_projected_seq` | MEDIUM |
| DS-25 | `E_VERSION_UNSUPPORTED` sem classificação de retry | MEDIUM |

## Ordering Risks

| ID | Risco | Sev. |
|---|---|---|
| DS-01 | Ordem no log ≠ ordem observada pelo validador | CRITICAL |
| DS-21 | Ordem da outbox por relógio de parede | MEDIUM |
| DS-26 | `submitOps` para no meio; não tentados sem estado; bloqueio cruza canais | MEDIUM |
| DS-27 | Blob e mensagem em filas independentes, sem barreira | MEDIUM |
| DS-31 | Ordem entre ACK e replicação não definida | LOW |

## Retry / Idempotency Risks

| ID | Risco | Sev. |
|---|---|---|
| DS-03 | Retry após perda do dedupe → append duplicado → colisão de PK determinística | CRITICAL |
| DS-04 | A tabela que garante idempotência não é durável | CRITICAL |
| DS-07 | Retry revalidado contra estado que mudou | HIGH |
| DS-12 | Op não comutativa dependente do dedupe | HIGH |
| DS-16 | Retry manual do usuário produz `opId` novo — fora do ADR-12 | HIGH |
| DS-23 | Rate limit interativo aplicado ao caminho de drenagem em lote | MEDIUM |
| DS-24 | Circuit breaker consome tentativas sem tentar | MEDIUM |
| DS-20 | Tabela de dedupe sem escopo, teto nem limpeza | MEDIUM |

## Partition / Offline Risks

| ID | Risco | Sev. |
|---|---|---|
| DS-08 | `banned` / `community-ended` inalcançáveis: partição impede a descoberta | HIGH |
| DS-09 | Replay não contabilizado satura o host | HIGH |
| DS-10 | Flush imediato pós-reconexão + fila sem profundidade = avalanche | HIGH |
| DS-11 | Réplica atrás por falta de bloco, sem sinal | HIGH |
| DS-15 | Partição parcial produz dois pais para o mesmo filho | HIGH |
| DS-27 | Anexo cujo único portador some | MEDIUM |
| DS-28 | Cancelamento sem contrapartida no host | MEDIUM |

## Missing Distributed-System Guarantees

Garantias que o sistema **precisa ter** e que a spec não define em lugar nenhum:

1. **Barreira de durabilidade antes do ACK.** Nenhuma linha define quando um `submitOp` pode
   responder. (DS-02)
2. **Modelo de consistência do estado de validação.** Nenhuma linha define de onde o
   validador lê nem quão fresco esse estado precisa estar. (DS-01, DS-05)
3. **Ordenação e atomicidade entre o append e o dedupe**, e reconstrução do dedupe no boot.
   (DS-03)
4. **Política de durabilidade diferenciada** entre tabelas descartáveis e tabelas que
   carregam garantias. (DS-04)
5. **Reconciliação outbox ↔ projeção** em boot, reconexão e antes de todo descarte.
   (DS-06, DS-07)
6. **Controle de admissão no host**: profundidade de fila, shedding, rate limit por conexão
   pré-autenticação. (DS-09, DS-10)
7. **Timeout e estado observável para leitura de core incompleta.** (DS-11)
8. **Detecção de falha por função, não por vida** (heartbeat que prove recepção). (DS-14)
9. **Distinção entre "não fala comigo" e "morreu"** no reparo da árvore. (DS-15)
10. **Idempotência do retry iniciado pelo usuário**, não só do retry da outbox. (DS-16)
11. **Política de registro venenoso**: quarentena, divergência declarada, ou parada — mas
    especificada. (DS-19, e F-04 pelo lado do gatilho)
12. **Integridade dos metadados do `LogRecord`** (`hostTs`, `flags`). (DS-13)

## Critical Failure Cases

Os cinco casos que, se não forem fechados antes da implementação, produzem defeitos que
**não são corrigíveis depois do release** — porque o dano fica no log, que é permanente:

| # | Caso | Por que é irreversível |
|---|---|---|
| 1 | **DS-01** — corrida validação↔projeção appenda um registro que viola invariante | O registro fica no log para sempre. Toda réplica, atual e futura, para no mesmo ponto. Reprojetar reproduz. Não há como remover (ADR-10) |
| 2 | **DS-03 (ordenamento B)** — append duplicado com `opId` idêntico | `messages.id` deriva do `opId`: dois registros, mesma PK. Mesmo desfecho do caso 1, com gatilho muito mais provável (crash + retry, não corrida) |
| 3 | **DS-02** — ACK antes da durabilidade | Perda de mensagem confirmada, sem cópia em lugar nenhum (escritor único, sem quórum) e sem detecção possível pelo autor |
| 4 | **DS-04** — `synchronous=NORMAL` sobre outbox e dedupe | Multiplica os casos 2 e 3, e quebra a promessa de fila durável que é premissa explícita do produto |
| 5 | **DS-05** — resgate concorrente fura `maxUses` | Único controle de acesso do produto (não há aprovação manual). Uma vez que N pessoas entraram, remover exige moderação manual e o convite já circulou |

**Observação de sequenciamento.** Os casos 1, 2, 4 e 5 têm **a mesma raiz**: a spec trata o
host como se ele tivesse uma visão consistente e durável do próprio estado no momento em que
decide, e ele não tem. Fechar a fronteira log↔projeção (uma decisão: onde vive o estado
autoritativo do host, e quando ele avança) resolve os quatro de uma vez, e é a decisão que
precisa ser tomada antes de qualquer linha da fase 2.

---

# Áreas atacadas sem achado

Registrado para que a ausência não seja lida como falta de tentativa:

- **`last_projected_seq` na mesma transação do lote** (§6.4). Correto e suficiente. É o
  único ponto do documento onde crash-safety está inteiramente bem resolvido, e é o que
  dispensa idempotência de reducer.
- **TTL + refresh de presença e digitando** (§10.7). Tolerância a perda por desenho, com
  margem de 3× entre refresh e TTL. Só falta declarar a garantia (DS-30).
- **Tombstone em vez de remoção** (ADR-10). Elimina toda uma classe de divergência
  ressurreição/exclusão que sistemas com deleção real sofrem.
- **Verificação de assinatura em toda réplica, sempre** (§6.4, §7). Correto, e a recusa
  explícita de um "caminho rápido" para o host é a decisão que torna a auditabilidade real.
- **Jitter na curva de backoff de rede** (§13.3). A análise está certa; o problema é só que
  ela não é aplicada ao flush pós-reconexão (DS-10).
- **`AbortSignal` por ciclo de vida de comunidade** (§13.4). Fecha corretamente a classe de
  "job zumbi escrevendo em banco fechado".
- **Expiração de timeout por comparação na leitura** (§11.12). Deliberadamente sem job — e a
  justificativa ("sem risco de divergência entre réplicas") está certa. É o padrão que
  `invites.expires_at` também deveria seguir e segue.
- **Eventos como sinal para reconsultar** (§10.1). O princípio é correto e elimina uma classe
  inteira de bug. Ele só não sobrevive a crash (DS-18) nem cobre estados sem query
  correspondente (F-17).

---

*Fim da auditoria. 31 achados: 5 CRITICAL, 11 HIGH, 13 MEDIUM, 2 LOW.*
