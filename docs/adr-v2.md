# Registro de Decisões Arquiteturais — v2

> **Status:** este registro **substitui integralmente** a tabela ADR-01..ADR-20 de
> `docs/backend.md` §1 (v1). Nenhuma ADR de v1 permanece em vigor com a redação original.
>
> **Contraparte normativa:** `docs/backend-v2.md`. Onde uma ADR e a especificação
> discordarem no conteúdo da decisão, a especificação vence e a ADR é bug.
>
> **Data:** 2026-08-15 · **Motivo da reabertura:** parecer `NOT APPROVED` do Architecture
> Review Board e os blockers B1–B10.

---

## 1. Mapa de substituição — v1 → v2

| ADR v1 | Veredito das auditorias | Destino em v2 |
|---|---|---|
| **ADR-01** — host como única autoridade de escrita | `BLOCKER / REQUIRES POC` — dá ordem, não serializa estado | **Reformulada** → **A01** (o host dá ordem) + **A02** (a verdade é o `fold`) + **A04** (estado autoritativo em memória) |
| **ADR-02** — SQLite como view descartável | `BLOCKER` — participação, namespaces e `blobsKey` não eram reconstruíveis | **Substituída** → **A03** (dois bancos, um autoritativo local) + **A02** |
| **ADR-03** — `better-sqlite3@13` | `REQUIRES POC`; justificativa de ABI universal **contradita** | **Mantida com justificativa corrigida** → **A16** |
| **ADR-04** — núcleo em `utilityProcess` | `REQUIRES POC` | **Mantida, condicionada a G0** → **A16** |
| **ADR-05** — mídia híbrida (WebRTC voz + WebCodecs/UDX tela) | `BLOCKER / REQUIRES POC` | **Substituída** → **A17** (WebRTC para tudo no v1) + **A19** (estrela) + **A20** (árvore adiada) |
| **ADR-06** — sem STUN; endereço HyperDHT como candidato ICE | `BLOCKER / REQUIRES POC` — premissa falsa | **Revogada** → **A18**; substituída por **A17** |
| **ADR-07** — UDX como fallback universal de voz | `BLOCKER / REQUIRES POC` — UDX não é pilha de mídia | **Revogada** → **A18**; substituída por **A17** (TURN comunitário) |
| **ADR-08** — relay voluntário "blind e cifrado" | `BLOCKER / REQUIRES POC` — UDX não cifra | **Substituída** → **A21** (TURN voluntário, SRTP real) |
| **ADR-09** — convite = segredo de 10 bytes + challenge-response | `BLOCKER` — convite delegado inexecutável | **Substituída** → **A08** (par de chaves derivado do segredo) |
| **ADR-10** — deletar é sempre tombstone | `ACCEPTED RISK` | **Mantida** → **A26** |
| **ADR-11** — outbox durável em SQLite | `BLOCKER` — durabilidade não garantida | **Reformulada** → **A03** + **A06** |
| **ADR-12** — idempotência por `opId` com janela de 7 dias | `BLOCKER` — sem atomicidade entre stores | **Substituída** → **A05** (`authorSeq`, sem janela) |
| **ADR-13** — FTS5 local | `REQUIRES POC` | **Mantida** → incorporada em `backend-v2.md` §23; sem ADR própria (decisão local, substituível) |
| **ADR-14** — presença/typing efêmeros | `REQUIRES POC` (custo) | **Mantida com fan-out redesenhado** → **A27** |
| **ADR-15** — não-lidas locais | `ACCEPTED RISK` | **Mantida e ampliada** (thread) → **A28** |
| **ADR-16** — replicação em background | `REQUIRES POC` | **Mantida com escalonador** → incorporada em §14.2; sem ADR própria |
| **ADR-17** — árvore calculada pelo host | `BLOCKER / REQUIRES POC` | **Adiada com desenho fechado** → **A20** |
| **ADR-18** — sem push com app fechado no v1 | `ACCEPTED RISK` | **Mantida** — escopo, sem ADR própria |
| **ADR-19** — chave privada por `safeStorage` | `REQUIRES POC` | **Reformulada com fronteira honesta** → **A13** |
| **ADR-20** — núcleo único com lock de diretório | `REQUIRES POC` | **Mantida com lock composto** → **A16** + §10.8 |

**Decisões novas, sem contraparte em v1:** A07 (vínculo criptográfico à comunidade), A09
(core de blobs por autor), A10 (ordenação fracionária), A11 (reação idempotente), A12
(autorização de replicação), A14 (contrato de IPC), A15 (ticket de anexo), A22 (tickets de
mídia), A23 (sucessão de host), A24 (backup de identidade), A25 (eixo otimista único),
A29 (conversa direta entre identidades).

---

## 2. Registro v2

Formato: **Contexto · Decisão · Consequências · Alternativas descartadas · Status ·
Achados que fecha.**

---

### A01 — O host dá ordem total; ele não é a fonte da verdade

**Contexto.** Um Hypercore por comunidade, appendado só pela máquina do host. A ADR-01 de
v1 concluía disso que "não existe conflito de escrita". A auditoria distribuída
(`DS-01`) demonstrou que a conclusão era falsa: um escritor único dá **ordem**, não
**serializabilidade de regra de domínio**.

**Decisão.** O host é a autoridade de **ordenação e admissão**. Ele decide o que entra no
log e em que ordem. Ele **não** decide o que o log significa — isso é A02.

> **Emenda de 2026-08-26 — o teto de 8 espectadores também saiu, e pelo mesmo critério.**
> Decisão do operador. `SHARE_MAX_VIEWERS` = 8 nunca foi consequência da topologia: a
> estrela funciona com qualquer audiência, e o que a limita é o **upload da máquina de quem
> apresenta** — grandeza que varia por conexão e que um número fixo no protocolo não mede.
> Quem já cuida disso é a degradação por `share.health` (§17.5), que lê perda real por
> espectador e desce o perfil. O que A19 continua sustentando é a estrela contra a árvore,
> que é a decisão inteira; o número era política pendurada nela. Um teto **escolhido por
> quem administra a comunidade**, se houver, é configuração de canal — `backlog.md` B38 —,
> não constante de protocolo. Ver `backend-v2.md` §17.5 e §90 do sequenciamento.

**Consequências.**
- Toda submissão passa por uma fila de uma via por comunidade (`backend-v2.md` §11.4).
- O host **não tem caminho privilegiado**: ele valida e interpreta com a mesma função que
  todo mundo.
- Censura por omissão e truncamento continuam possíveis e **detectáveis** (L-1, §25.6).

**Alternativas descartadas.** Autobase multi-writer: a seção "Tails, Forks and Merges" do
`DESIGN.md` continua `// todo`, sem benchmark público de número de escritores nem de
latência de convergência. Continua sendo pesquisa, não engenharia.

**Status.** Aceita. **Fecha:** parte de `F-04`, `DS-01`, `DR-18`.

---

### A02 — Interpretação Determinística do Log (DLI)

**Contexto.** Em v1, autorização vivia no host (pipeline de 12 estágios) e as réplicas só
verificavam assinatura. Consequências: o host podia fabricar qualquer efeito (`T-02`), um
envelope de outra comunidade valia (`T-01`), um reducer podia lançar e parar toda réplica
para sempre (`F-04`, `DS-01`), e a projeção era simultaneamente "descartável" e "fonte da
validação" (`DS-01`, `DS-19`).

**Decisão.** O estado de uma comunidade é, por definição, `fold(log)` — uma função **pura,
total e determinística**. Toda regra de autorização, hierarquia, associação, limite, cota,
unicidade e integridade vive dentro dela. Existem exatamente três desfechos por registro:
`APPLIED`, `REJECTED`, `IGNORED`. A função **nunca lança e nunca para**.

**Consequências.**
- Réplicas revalidam autorização, não só assinatura → o host não fabrica efeito.
- Corrida legítima nunca produz registro venenoso: a corrida perdida vira `REJECTED`
  determinístico em todo nó.
- `E_INVARIANT` e `projector.failed` **deixam de existir** como estados de runtime.
- A projeção SQLite passa a ser de fato descartável, porque é a materialização de
  `fold(log)`.
- **Custo:** cada nó precisa manter o `DecisionState` das comunidades abertas em memória.
  Mitigado pela política de residência de §8.1.
- **Custo:** mudar uma regra de interpretação exige bump de `opVersion` — não dá para
  "corrigir" uma regra em produção sem versionar. Isso é intencional.

**Alternativas descartadas.**
- *Manter autorização só no host:* deixa `T-01`, `T-02` e todo o B7 sem solução.
- *Host projeta sincronamente até a própria cabeça antes de cada validação:* mata o
  throughput e mantém o acoplamento entre validação e projeção que causou `DS-01`.
- *Reducers que rejeitam lançando exceção:* é exatamente o que produzia o brick.

**Status.** Aceita — **é a decisão-raiz de v2**. Protegida pelo teste de §28.4.
**Fecha:** `F-04`, `F-05`, `F-07`, `F-39`, `F-40`, `DS-01`, `DS-11`, `DS-12`, `DS-19`,
`DR-13`, `DR-14`, `DR-27`, `DR-28`, `T-02`.

---

### A03 — Dois bancos: `manifest.db` autoritativo, `view.db` derivado

**Contexto.** v1 tinha um `view.db` com `synchronous=NORMAL` guardando, na mesma conexão,
a projeção descartável **e** a outbox, o dedupe e o estado local. Justificava `NORMAL` com
"a projeção é descartável" e aplicava a garantia enfraquecida a dados que carregavam
entrega e idempotência (`DS-04`). Ao mesmo tempo, a lista de comunidades e o `blobsKey`
só existiam na projeção, que a reprojeção apagava (`F-01`, `DR-21`, `DS-19`).

**Decisão.** Dois arquivos SQLite separados:

| Banco | `synchronous` | Conteúdo | Reprojeção |
|---|---|---|---|
| `manifest.db` | **`FULL`** | Participação, sementes, chaves de core, outbox, `authorSeq`, não-lidas, preferências, consentimentos, cache/staging de blobs | **Nunca tocado** (exceto o read state, recomputado) |
| `view.db` | `NORMAL` | Snapshot do `DecisionState`, projeção, FTS5 | **Apagado e refeito** |

`synchronous` é por conexão de banco, não por tabela — por isso a separação precisa ser
física.

**Consequências.**
- A enumeração de comunidades vem de `manifest.db`, então a reprojeção não apaga o que ela
  precisa para começar.
- `manifest.db` tem migração de dado de verdade (numerada, transacional); `view.db` não
  tem migração nenhuma — bump de schema é `DROP` + reprojeta.
- Não há transação entre os dois arquivos: a ordem de commit e a reconciliação no boot
  estão em §10.5 e §10.7.

**Alternativas descartadas.** *Um banco com `FULL`:* paga fsync por transação de projeção,
que é o caminho de maior volume do sistema. *Um banco com `NORMAL`:* é v1, e perde outbox
em power loss.

**Status.** Aceita. **Fecha:** `F-01`, `DS-04`, `DR-20`, `DR-21`, `DS-19`, blocker B2.

---

### A04 — Estado de Decisão em memória, avançado no ponto crítico do append

**Contexto.** `DS-01`: o host validava contra a projeção, atrasada em até um lote inteiro.
Oito pares de ops legítimas produziam registro inaplicável e brick.

**Decisão.** O host mantém o `DecisionState` em memória. A decisão e a reserva do grupo
acontecem **dentro da seção crítica**, mas o append não: o `DS` provisório só é publicado
como estado committed depois que `core.append` resolve. A projeção é consumidora pura e
**nunca** é consultada para decidir. `communityHost` e `projector` compartilham a **mesma
instância** de `DecisionState`.

**Consequências.** A janela de `DS-01` deixa de existir. O custo é memória
(`O(membros + canais + cargos + autores×escopos usados)` por comunidade, mais metadados de mensagem só nas
comunidades com residência `full`).

**Status.** Aceita. **Fecha:** `DS-01`, `DR-28`, blocker B1 (junto com A02).

---

### A05 — Idempotência por `authorSeq` monotônico por escopo, sem janela

**Contexto.** ADR-12 usava `opId` numa tabela `local_dedupe` com janela de 7 dias, num
store sem transação comum com o Hypercore. Um crash entre append e dedupe podia duplicar
ou perder (`DS-03`); um replay depois da janela produzia colisão de chave primária
permanente (`T-05`); a tabela era global, sem `community_id`, misturando comunidades
(`DS-20`); e `identity.update` em N comunidades colidia na PK da outbox (`F-36`).

**Decisão.** O cabeçalho da `Op` carrega `sequenceScope` e `authorSeq: uint64` — contador
**estritamente crescente por (autor, comunidade, escopo)**, dentro do material assinado. O
escopo é o canal para as operações de mensagem enfileiráveis e `community` para operações
sem canal. O `fold` mantém `lastAuthorSeq[author, sequenceScope]` no `DecisionState` e
ignora todo registro com `authorSeq ≤ lastAuthorSeq` naquele escopo.

**Consequências.**
- O dedupe é **derivado do log**: crash não pode dessincronizá-lo.
- **Não existe janela** — um envelope de dois anos atrás continua sendo ignorado.
- Memória: um `uint64` por par autor/escopo usado.
- Ids de entidade derivam de `(communityId, sequenceScope, author, authorSeq)`, então são
  únicos por construção e estáveis na reprojeção.
- O contador vive em `manifest.db` (`FULL`) com chave `(communityId, sequenceScope)` e é
  reconciliado no boot com o log.
- Uma operação em cada canal pode usar o mesmo número sem colisão; `identity.update` em N
  comunidades continua consumindo um contador no escopo da comunidade de cada uma.

**Alternativas descartadas.** *Janela maior:* empurra o problema. *Dedupe por
`(author, nonce)`:* não protege contra envelope adulterado com o mesmo nonce e não dá
ordenação. *Ordem global da outbox por comunidade:* preserva o wire, mas viola a regra de
§11.7 de que um canal bloqueado não segura os outros. *Reatribuir `authorSeq` no retry:*
troca o envelope e a identidade da operação, contrariando A06 e exigindo um id lógico novo.

**Emenda pós-G4 (2026-08-17).** O POC-07 demonstrou que a redação anterior, global por
autor, ultrapassa itens de outro canal quando a outbox permite progresso independente.
`sequenceScope` é a alteração escolhida: ela preserva o isolamento entre canais e o retry
do mesmo envelope, ao custo explícito de alterar o material assinado, o `DecisionState`, o
schema do manifesto e a derivação de IDs. A mudança é versionada como `opVersion = 2` antes
de existir dado de produto; o POC descartável não é migração.

**Status.** Aceita, **emendada após G4**. **Fecha:** `T-05`, `DS-03`, `DS-12`, `DS-20`,
`F-36`, `DR-11` e `ACHADO-02`.

---

### A06 — Barreira de durabilidade e liberação por observação da própria réplica

**Contexto.** v1 respondia ACK antes do `flush` e o cliente removia da outbox no ACK
(`DS-02`); não havia reconciliação outbox↔projeção (`DS-06`); um retry manual gerava
`opId` novo, fora do alcance da idempotência (`DS-16`); e itens em `sending` não tinham
reconciliação após crash (`DR-22`).

**Decisão.**
1. O host só responde `{seq, hostTs}` **depois** de o append estar commitado no
   armazenamento, agrupado por group commit (§11.5). Em `hypercore@11.35.1` isso é **uma**
   chamada, não duas: `core.flush()` não existe e o `append` só resolve depois do commit —
   `backend-v2.md` §10.7.1, que mede o alcance da barreira (falha de processo, sim; queda de
   energia, ainda não).
2. O cliente **não** remove o item no ACK: ele passa a `awaiting-confirmation`.
3. O item só é removido quando o projetor **local** observa o próprio `opId` em
   `observed_ops`, entre os registros `APPLIED` da réplica. É a única condição de remoção;
   `authorSeq` é apenas uma negativa barata quando a marca d'água ainda é menor.
4. "Tentar novamente" reenvia **o mesmo envelope armazenado**, nunca reconstrói a op.
5. Expiração por idade só acontece **depois** de uma reconciliação.
6. No boot, todo `sending` órfão volta a `queued` sem incrementar `attempts`; o envelope e
   o `opId` permanecem os mesmos. `awaiting-confirmation` segue para reconciliação.

O append do grupo ocorre fora da seção crítica, com no máximo um grupo em voo por comunidade;
somente o resultado do `append` publica o `DS` reservado e libera os ACKs. Assim o group
commit não é reduzido acidentalmente a grupos de tamanho 1.

**Consequências.** Só existem dois estados terminais: entregue (observado por `opId`) ou `dropped`
com motivo nomeado. Um ACK que não vira registro no log é detectado e contado
(`outbox.ackMismatch`), o que também é o sinal de censura de §25.6.
Custo: latência de `submitOp` passa a incluir o custo amortizado do commit durável —
`BENCHMARK REQUIRED` (G9). Se o alvo de 60 ms não fechar, **o alvo é renegociado, não a
barreira**.

**Status.** Aceita, emendada após G4. **Fecha:** `DS-02`, `DS-06`, `DS-07`, `DS-16`,
`DR-19`, `DR-22`, `DR-24`, `F-16`, `ACHADO-01`, `ACHADO-03`, `ACHADO-04`, blocker B5.

---

### A07 — A assinatura vincula a comunidade; `hostTs` e `flags` são assinados pelo host

**Contexto.** `T-01`: a `Op` não tinha campo de comunidade, então um envelope genuíno
colhido do log de A tinha efeito no log de B — quebrando a única propriedade de segurança
que v1 afirmava manter contra o host. `T-27`/`DS-13`: `hostTs` e `flags` ficavam fora da
assinatura, então o host reescrevia carimbo e sinal de relógio sem detecção.

**Decisão.**
- `Op` ganha `communityId: bytes[32]` **dentro do material assinado**. O `fold` recusa no
  estágio 3 qualquer registro cujo `communityId` não seja o do core.
- O registro appendado é um `HostRecord = {envelope, hostTs, flags, hostSig}`, com
  `hostSig` feita com a **chave do core**. Alterar carimbo ou flags invalida a assinatura.

**Consequências.** Custo: 32 bytes por op e 64 por registro. Ganho: transplante de op
entre comunidades e reescrita de carimbo passam a ser criptograficamente impossíveis.

**Status.** Aceita. **Fecha:** `T-01`, `T-27`, `DS-13`.

---

### A08 — Convite é um par de chaves derivado do segredo

**Contexto.** ADR-09 guardava `BLAKE2b(secret)` no log e validava por prova de
conhecimento do segredo. Isso funciona quando o **host** criou o convite e falha quando um
membro comum cria: o host não tem o segredo e não consegue verificar prova nenhuma
(`F-02`). Além disso, o candidato não sabia como alcançar o host antes do resgate
(`F-09`), o consumo de `maxUses` lia projeção atrasada (`DS-05`) e a prova não era
vinculada a host nem a candidato (`T-06`).

**Decisão.**

```
inviteSecret 10 B  →  código Crockford-Base32 de 16 caracteres
inviteSeed   = BLAKE2b('invite-seed/1' ‖ inviteSecret)
(invitePk, inviteSk) = ed25519_from_seed(inviteSeed)
inviteTopic  = BLAKE2b('invite-topic/1' ‖ invitePk)
```

O log guarda **`invitePk`**. O host valida com a chave pública. Duas provas:
- `liveProof` (RPC) sobre `('invite-auth/1' ‖ invitePk ‖ hostPk ‖ candidatePk ‖ challenge)`;
- `joinProof` (no log, verificável para sempre) sobre
  `('invite-join/1' ‖ communityId ‖ invitePk ‖ candidatePk)`.

**Consequências.**
- **Convite delegado funciona**: o host nunca precisa do segredo.
- **O rendezvous pré-membro funciona**: o candidato deriva `invitePk` só do código, e daí o
  tópico. Não precisa saber a comunidade antes de conectar.
- **`maxUses` é atômico**: `uses` é `DecisionState`, avançado na seção crítica de A04.
- `member.join` é **assinado pelo candidato**, não fabricado pelo host.
- 80 bits de entropia continuam adequados; a defesa online é fechar a conexão por tentativa
  errada + rate limit por chave e por /24.
- **Consequência de produto:** o código em claro só existe na instalação de quem criou.
  A lista de convites de terceiros não mostra código (delta U-04).

**Alternativas descartadas.** *`blind-pairing`:* três versões publicadas desde 2024 e
desalinhado do `blind-pairing-core`; fica como caminho de upgrade. *Enviar o segredo ao
host:* muda o modelo de ameaça — qualquer membro passaria a poder emitir convite em nome de
outro.

**Status.** Aceita. **Fecha:** `F-02`, `F-06`, `F-09`, `DS-05`, `T-06`, `T-23`, blocker B3.

---

### A09 — Core de blobs por autor

**Contexto.** v1 tinha um `hyperblobs` por comunidade com escritor único do host, e ao
mesmo tempo mandava o membro fazer `blob.stage` local. É criptograficamente impossível
(`F-03`). As alternativas óbvias eram piores: o host receber 8 GiB pela fila de controle,
ou ninguém anexar nada.

**Decisão.** Cada membro tem o **próprio** core de blobs por comunidade, derivado da
identidade e **publicado no log** (`member.join.blobsCoreKey`, `member.setBlobsCore`). O
`AttachmentRef` da mensagem carrega `blobsCoreKey`, então o leitor sabe de qual core
buscar. Quem baixa vira seeder daquele range.

**Consequências.**
- A escrita passa a ser possível e o host não vira gargalo de upload.
- `blobsKey` deixa de ser irrecuperável: está no log.
- **Disponibilidade depende de haver ao menos um par com os blocos** (L-9). Se o autor
  sumir e ninguém tiver baixado, o anexo fica `unavailable` — estado nomeado e desenhado.
- **Emenda de 2026-09-04:** a cota por membro (`R-14`) foi removida em `opVersion = 3`
  (`backend-v2.md` §13.8). Ela supunha que o anexo era empurrado para todas as réplicas — o
  que esta própria ADR desfaz ao tirar os bytes do host e deixar a replicação sparse. Sem
  cota, o disco de cada um é gasto por decisão de quem envia e de quem clica em baixar; a
  exaustão de disco alheio que `T-09` descreve é a de **texto**, que `R-15` cobre.

**Alternativas descartadas.** *Upload via host:* mede-se em GiB atravessando a fila de
controle; reprova por desenho. *Core único multi-escritor:* Hypercore não é.

**Status.** Aceita. **Fecha:** `F-03`, `F-41`, `DS-22`, parte de `T-09`, blocker B4.

---

### A10 — Ordenação por chave fracionária esparsa

**Contexto.** `F-39`: `position` inteiro denso e único, renumerado a cada `role.move`
dentro de um índice `UNIQUE` não-diferível do SQLite, produzia violação de índice sob
concorrência — e, em v1, violação de índice dentro do reducer era brick.

**Decisão.** `rank` é uma string base62 ordenada lexicograficamente, gerada por indexação
fracionária. Mover um item gera uma chave entre os vizinhos; **nenhuma outra linha muda**.
Aplica-se a cargos, canais e categorias.

**Consequências.** `role.move` devolve `{rank}` em vez de `positions[]`, o que muda o
contrato com a UI (Apêndice A). Colisão (só possível por bug) desempata por id ascendente,
sem falhar.

**Status.** Aceita. **Fecha:** `F-39`, `P-5`.

---

### A11 — `reaction.set{present}` no lugar de `reaction.toggle`

**Contexto.** `DS-12`: `toggle` é a única op **não comutativa** do catálogo, e sua correção
dependia inteiramente da durabilidade do dedupe. Com o dedupe quebrado por crash, dois
envios do mesmo toggle viravam duas inversões.

**Decisão.** A op carrega o estado desejado, não a inversão. Idempotente e convergente por
maior `seq`.

**Status.** Aceita. **Fecha:** `DS-12`.

---

### A12 — Autorização de replicação por comunidade

**Contexto.** `DR-30`: o `firewall` só existia no host, então dois membros continuavam
replicando entre si e o banido continuava lendo. `T-25`: o firewall era **único por
processo**, atravessava comunidades e vazava estado de moderação — um par banido em A não
conseguia falar com este nó nem sobre B.

**Decisão.**
- Ao abrir um canal de replicação para o core de uma comunidade, **cada nó** consulta o
  próprio `DecisionState`: par membro ativo não banido → abre; senão → recusa com
  `E_NOT_AUTHORIZED_FOR_COMMUNITY`.
- O `firewall` de conexão passa a recusar só quando o par está banido em **todas** as
  comunidades em comum.
- O canal **pré-membro** (admissão/convite) é exceto: aceita qualquer par, com orçamento e
  tetos próprios. É o que torna o preview `banned` alcançável.

**Consequências.** A revogação de leitura passa a ser distribuída e determinística, sem
autoridade central. **Ela vale para o futuro:** o que o banido já replicou continua com ele
(L-7).

**Status.** Aceita. **Fecha:** `DR-30`, `T-25`, `F-10`, `DS-08`, parte de B10.

---

### A13 — Fronteira da chave: geração no núcleo, `safeStorage` como oráculo

**Contexto.** `T-21`/`DR-03`: v1 afirmava que a chave privada nunca cruzava o IPC e ao
mesmo tempo exigia que o main a decifrasse com `safeStorage`. As duas coisas não cabem
juntas. `T-03`: a chave de escrita do core não tinha nenhuma proteção equivalente à da
identidade. `T-10`: `safeStorage` não protege contra o adversário que o modelo de ameaça
dizia que ele protegia.

**Decisão.**
1. A chave de identidade é **gerada no núcleo** e cifrada por uma **Data Key** simétrica.
2. Só a **Data Key** atravessa o IPC-M para ser embrulhada/desembrulhada por `safeStorage`.
   O main nunca vê a chave de identidade.
3. A mesma Data Key protege as **sementes de comunidade**, dando à chave de escrita do core
   a mesma proteção da identidade.
4. Nenhum comando IPC-R devolve, deriva ou expõe material de chave.
5. **Degradado é `safeStorage.isEncryptionAvailable() === false` depois do probe de backend
   — nunca o nome do backend.** Medido em G10 (2026-08-16):
   `getSelectedStorageBackend()` devolve o backend **pedido**, não o obtido — com
   `--password-store=kwallet5` numa máquina sem kwallet ele devolve `kwallet5` enquanto
   `isEncryptionAvailable()` é `false` —, e a autodetecção do Linux devolve `basic_text`
   numa máquina com chaveiro funcionando sempre que não há ambiente de desktop
   reconhecível (WSL2, headless, SSH, contêiner). Antes de concluir degradado, o app tenta
   os candidatos explicitamente, na ordem `gnome-libsecret`, `kwallet6`, `kwallet5`, com
   `app.commandLine.appendSwitch('password-store', …)`. Forçar **não** fabrica segurança:
   com o serviço ausente, `isEncryptionAvailable()` permanece `false`. Esgotados os
   candidatos, é degradado de verdade: o núcleo recusa abrir (`E_KEYSTORE_INSECURE`) até um
   aceite dedicado, e a UI passa a exibir indicador permanente.
6. **O probe é um relaunch, e tem ordem obrigatória.** O switch só tem efeito antes de
   `app.whenReady()` — medido —, e `isEncryptionAvailable()` só responde depois dele, então
   cada candidato custa um `app.relaunch()`. O probe roda **antes da etapa (2) do lock
   composto de §10.8** — o `flock` de `p2p/LOCK`, que o `utilityProcess` toma —, senão o
   processo relançado encontra o próprio lock e morre com `E_CORE_ALREADY_RUNNING`; e
   **preserva `argv`**, senão o deep link de §3.5(4) se perde no relaunch. O backend
   aprovado é persistido e reusado no boot seguinte, sem repetir o probe; o custo medido é
   de ~350 ms por candidato ausente, uma única vez.

   **Emenda de 2026-09-05 — a etapa nomeada é a (2), e a (1) fica onde está.** A redação
   anterior dizia "antes do lock composto de §10.8", sem distinguir as quatro etapas, e a
   §10.8(1) — `app.requestSingleInstanceLock()` — é tomada no topo do módulo do main, antes
   do probe. Lida ao pé da letra, a ADR se contradizia com a única ordem implementável, por
   duas razões que não são de estilo:

   - **`safeStorage.isEncryptionAvailable()` só responde depois do `ready` no Linux** (é o
     que a API documenta). O probe não tem como preceder um `requestSingleInstanceLock` de
     topo de módulo — ele nem sequer sabe o que responder ainda.
   - **A etapa (1) é segura ao relaunch, e o código de erro que a ADR cita não é dela.**
     `app.relaunch()` sobe a instância nova **quando a atual sai** ("Relaunches the app when
     the current instance exits"), então o processo relançado nunca disputa o singleton com
     o processo que o pediu; e um `SingletonLock` deixado para trás por uma saída abrupta é
     reconhecido como órfão e retomado. `E_CORE_ALREADY_RUNNING` é o erro da etapa (2), o
     `flock` mantido pelo núcleo — e é essa a etapa que o probe precisa preceder, o que ele
     faz: a decisão roda no topo do `whenReady`, antes de `spawnUtility()`.

   O que a ADR mede continua valendo inteiro; o que muda é a etapa que ela nomeia.

**Consequências.** A afirmação "a chave nunca cruza fronteira" some e é substituída por uma
descrição do que de fato acontece. **L-2** declara o que `safeStorage` não protege.

**Status.** Aceita, **REQUIRES POC** (G10). **Fecha:** `T-03`, `T-21`, `DR-03`,
qualifica `T-10`.

---

### A14 — Contrato de IPC com `epoch`, `subId`, `evSeq`, ack e resync

**Contexto.** `DR-05`: `sub/unsub/ev` não permitiam correlacionar um evento com a
assinatura que o pediu. `DR-06`: o backpressure de v1 dependia de saber quantos quadros não
foram drenados, informação que `MessagePort` **não fornece**. `DR-07`: não havia
procedimento de reconexão depois do crash do núcleo. `T-20`: o IPC concedia comandos
destrutivos a um renderer que a própria spec tratava como não confiável.

**Decisão.**
- `epoch` por processo núcleo, em todo quadro; quadro de `epoch` errado é descartado.
- `subId` atribuído pelo núcleo; `evSeq` monotônico por assinatura.
- **Controle de fluxo no nível da aplicação:** janela de eventos não confirmados por
  `evAck`; estouro → `evStale` e resync obrigatório.
- Procedimento de recuperação de crash escrito (§15.2): requests em voo falham com
  `E_CORE_RESTARTED` e **nunca** são reenviados automaticamente; a escrita está na outbox e
  é reconciliada.
- Quatro classes de autorização de comando, com `main-confirmed` exigindo token emitido
  após confirmação nativa.
- `dev.*` gated por **constante de build**, com eliminação de código morto — não
  `NODE_ENV`, que falha aberto.

**Status.** Aceita, **REQUIRES POC** (G6). **Fecha:** `DR-05`, `DR-06`, `DR-07`, `DR-08`,
`F-17`, `T-19`, `T-20`.

---

### A15 — Caminho de anexo por ticket emitido pelo main

**Contexto.** `T-16`/`DR-37`: `blob.stage(path)` aceitava caminho do renderer, sem
mecanismo para provar que veio de um diálogo do SO. Um renderer comprometido exfiltrava
qualquer arquivo do usuário.

**Decisão.** O renderer chama `file.pickForAttachment`; o **main** abre o diálogo e emite
um ticket de uso único (16 B, TTL 15 min, escopado a uma comunidade e um caminho) ao núcleo
pelo IPC-M. O renderer recebe só o `ticketId`. O núcleo **recusa qualquer `path` vindo do
renderer, sempre**. O caminho nunca cruza o IPC-R, nem em erro, nem em log.

**Status.** Aceita. **Fecha:** `T-16`, `DR-37`.

---

### A16 — Electron + `utilityProcess` + `better-sqlite3`, matriz fechada, rebuild obrigatório

**Contexto.** ADR-03 justificava a escolha dizendo que N-API torna o `.node` "ABI-estável
entre Node e Electron". A documentação do Electron diz o contrário: módulos nativos
precisam ser **recompilados para Electron**, e upgrades geralmente exigem novo rebuild
(`relatorio-auditoria-adr.md` §3.3). ADR-04 e ADR-20 não tinham matriz de artefato nem
teste de crash. `DR-01`: o spike da fase 0 não tinha critério de aceite nem regra de
decisão. `DR-02`: a migração web → Electron contradizia "não toca componente nenhum".

**Decisão.**
- Núcleo em `utilityProcess`, driver `better-sqlite3`, ambos mantidos.
- **A justificativa de ABI universal é removida.** Rebuild por versão de Electron e por
  alvo é parte do contrato de build, com `asarUnpack` configurado.
- **Matriz de plataforma do v1, fechada:** Windows x64 e Linux x64 com glibc ≥ 2.31.
  **macOS (arm64 e x64), Alpine/musl e ARM Linux ficam fora de suporte**, declarado.
  Com macOS fora, o v1 **não tem nenhum alvo arm64** — a matriz é inteiramente x64.
- **Por que macOS saiu (2026-08-16).** Não é resultado de gate: é **decisão de escopo**,
  tomada por não haver máquina Apple disponível para produzir e manter a evidência que G0
  exige (build empacotado, assinado e notarizado, 100 cold starts por alvo, crash e
  restart). Declarar um alvo que ninguém consegue testar seria pior do que não tê-lo: a
  matriz existe justamente para impedir "funciona na minha máquina". **Esta remoção não
  aciona a regra de "falha em dois ou mais alvos"** abaixo — nada falhou tecnicamente, e o
  sidecar Bare **não** entra em avaliação por causa dela.
- Lock **composto** (instância de app → arquivo → RocksDB → SQLite), com quebra de lock
  órfão e liberação ordenada (§10.8).
- **Regra de decisão do gate:** G0 precisa passar em **todos** os alvos da matriz — hoje,
  os dois. Falha **técnica** em um alvo → aquele alvo sai da matriz e a decisão é
  registrada. Falha técnica em dois ou mais → reabrir A16 e avaliar sidecar Bare como
  **variante de arquitetura**, não como fallback pequeno. Com a matriz em dois alvos, isso
  significa que **uma segunda falha técnica esvazia a matriz e reabre A16**.
- **O piso de glibc é do host de build, não do host de teste.** Um addon nativo compilado
  contra glibc 2.43 **não roda** em glibc 2.31–2.42: o link é para símbolos versionados que
  não existem lá. Declarar "glibc ≥ 2.31" só é verdade se `better-sqlite3`,
  `sodium-native` e `udx-native` forem compilados num ambiente de **glibc 2.31**. Isso é
  contrato de build, ao lado do rebuild por versão de Electron, e vale para qualquer
  máquina de build — não é particularidade de WSL2.
- **LIMITAÇÃO DE EVIDÊNCIA (`G0-E1`) — o alvo Linux é validado em WSL2.** Decisão de 2026-08-16,
  por não haver desktop Linux nativo disponível. O que isso **não** prova, e que precisa
  ficar escrito no artefato de G0 em vez de ser assumido: comportamento de sessão de
  desktop real (registro de handler `xdg-mime`/`.desktop` e o caminho de deep link de §3.5
  fora do app empacotado), tempo de cold start com o perfil de I/O de um disco nativo, e
  integração com o secret store como um desktop o entrega. Continua válido em WSL2, porque
  não depende de sessão gráfica: carga dos addons, operação nativa real, transação longa,
  crash e restart do `utilityProcess`, `SIGKILL` do filho, lock composto (o disco do WSL é
  ext4 de verdade) e recuperação de lock órfão.
- **LIMITAÇÃO DE EVIDÊNCIA (`G0-E2`) — os addons do alvo Windows não são compilados por
  nós.** Medido em G0, 2026-08-16: o artefato `win32-x64` carrega os prebuilds
  `better-sqlite3`, `sodium-native` e `udx-native` publicados no npm, porque não há
  toolchain MSVC disponível. Eles são N-API e carregam — provado em quatro cenários no
  Windows x64 nativo —, mas a cláusula "rebuild por versão de Electron e por alvo" acima
  **não tem evidência neste alvo**. O que isso não prova: que um upgrade de versão de
  Electron seja absorvido por rebuild próprio no Windows, e que a cadeia de build do
  produto seja reprodutível nos dois alvos. Diferente do piso de glibc no Linux, aqui não
  há piso a violar — o risco é de ABI no upgrade, não de compatibilidade de distribuição.
- **A migração web → Electron é trabalho reconhecido**, não "zero toque": o shell, o
  roteamento (`MemoryRouter`), a CSP e o empacotamento mudam. Registrado em
  `deltas-ux-v2.md` U-25.

**Status.** Aceita, **condicionada a G0**. **Fecha:** `F-22`, `DR-01`, `DR-02`, corrige a
justificativa contradita da ADR-03.

---

### A17 — Voz e câmera: WebRTC com STUN/TURN servidos pelo host da comunidade

**Contexto.** ADR-06 supunha que o endereço descoberto pelo HyperDHT servia como candidato
ICE do renderer. O mapeamento NAT é **por socket**, e a socket do núcleo não é a do
`RTCPeerConnection` (`F-19`). ADR-07 mandava cair para UDX quando o ICE falhasse; o README
do UDX diz "no handshakes, no encryption, no features" — não há codec, jitter buffer, PLC,
AEC, FEC nem `MediaStreamTrack` (`F-20`). As duas juntas anulavam a justificativa da
ADR-05.

**Decisão.** Toda mídia do v1 é WebRTC no renderer, ponta a ponta com DTLS-SRTP.
Conectividade por ICE, com **STUN e TURN prestados pelo host da própria comunidade**,
multiplexados na mesma socket UDP do UDX (demux por magic cookie STUN).

- STUN: aberto a quem já tem conexão autenticada com o host.
- TURN: só membros com sessão de voz ativa, com credencial HMAC de curta duração emitida em
  `voiceJoin`, TTL de alocação, cota de banda e permissões restritas ao roster.

**Por que isso não é "servidor central".** O host já é um par da comunidade, já precisa
estar online para a voz existir, e já é alcançável. Nenhum endereço vaza para fora da
comunidade. STUN de terceiro continua configurável, default vazio, com aviso na UI.

**Por que "relay cego" passa a ser verdade.** DTLS-SRTP é negociado entre os pares; o TURN
encaminha pacotes que não decifra. Deixa de ser afirmação e vira propriedade do protocolo.

**Consequências.** Custo de implementar um STUN completo e um subconjunto de TURN no
núcleo — trabalho delimitado e padronizado, contra "construir uma pilha de mídia", que é o
que ADR-07 escondia. **L-11:** host atrás de CGNAT sem porta alcançável não serve
STUN/TURN; nesse caso a voz depende dos voluntários (A21) e, sem voluntário, falha com
`conn-failed`.

**Alternativas descartadas.** *TURN gerenciado de terceiro:* infraestrutura paga e
centralização. *Manter UDX como fallback:* significa construir a pilha de mídia inteira.
*Só candidatos host (sem STUN):* funciona em LAN e falha na maioria das redes reais.

**Status.** Aceita, **REQUIRES POC** (G7/G8). **Fecha:** `F-19`, `F-20`, `T-11` para voz.

---

### A18 — Revogação explícita de ADR-06 e ADR-07

**Decisão.** As duas decisões de v1 estão **revogadas**. Nenhum código pode assumir
candidato ICE derivado do DHT nem transporte de voz sobre UDX. Registrado como ADR própria
para que a revogação seja rastreável e ninguém as reintroduza por inércia.

**Status.** Revogada (é o registro da revogação).

---

### A19 — Compartilhamento de tela no v1: estrela WebRTC

**Contexto.** A árvore de v1 dependia de forwarding opaco por WebCodecs+UDX, de uma camada
criptográfica que não existia, de handshake de aresta não especificado (`DR-43`), de ACK de
atribuição inexistente (`DS-14`), de distinção partição×morte não definida (`DS-15`) e de
elegibilidade auto-declarada (`T-13`, `DR-44`). Nada disso foi medido (`F-42`).

**Decisão.** No v1, tela é **estrela WebRTC**: o apresentador mantém uma
`RTCPeerConnection` por espectador. Espectador é **participante do canal de voz**.

> **Emenda de 2026-08-26 — "Uma sessão por canal" saiu desta decisão.** A frase estava aqui
> herdada de `RT-06`, que era uma contradição entre documentos (UX pedia várias, backend de
> v1 fixava `0..1`, mock não implementava nenhuma) e não um achado desta ADR — o que A19
> decide, e sustenta, é a **estrela**. Em estrela a
> trilha de tela pega carona na conexão de voz que já existe entre cada par: um segundo
> apresentador não abre malha nova, e o upload não compõe porque cada um serve a própria
> estrela. O canal aceita **uma transmissão por apresentador**. Ver `backend-v2.md` §17.5.

**Consequências.**
- **`share.setQuality` volta a funcionar**: em estrela, cada `RTCRtpSender` tem bitrate
  próprio. O comando era inerte em v1 por causa do repasse opaco (`F-08`).
- Latência sub-segundo, sem os 1–2 s de árvore — o delta 3 de v1 deixa de ser necessário
  no v1.
- **Teto de 200 espectadores sai do v1.** Isso é corte de escopo, registrado.
- A UI mostra **quantos** assistem, sem denominador: não há vaga a disputar (emenda acima).

**Status.** Aceita, **REQUIRES POC** (G8). **Fecha:** `F-08`, `F-18`, `RT-06`, `V-13`.

---

### A20 — Árvore de multicast: especificada e adiada

**Contexto.** `CLAUDE.md` pede multicast em árvore para audiência grande. O ARB exigiu
separar o que está decidido do que depende de validação experimental.

**Decisão.** O desenho está **fechado e escrito** em `backend-v2.md` §17.8, com todas as
peças que faltavam em v1: confidencialidade e autenticidade por AEAD com chave de sessão
distribuída por `crypto_box_seal` a cada espectador autorizado; handshake de aresta com
ticket; ACK de atribuição com reatribuição em 2 s; prova de recepção por contagem de
quadros; distinção partição×morte pelos heartbeats dos filhos; elegibilidade por upload
**medido**, nunca auto-declarado; qualidade por subárvore, com o comando devolvendo
`{applied:false, reason}` em vez de mentir.

**A implementação está bloqueada até POC-09 (G13) passar. O v1 não a inclui.**

**Consequências.** A audiência do v1 é 8, não 200. Se G13 reprovar, a decisão objetiva é
manter estrela com teto explícito e registrar que o produto não faz broadcast de
audiência grande.

**Status.** Adiada, **REQUIRES POC** (G13). **Fecha (no desenho):** `DS-14`, `DS-15`,
`DR-43`, `DR-44`, `T-11`, `T-13`, `F-37`.

---

### A21 — Relay voluntário retransmite TURN/SRTP opaco

**Contexto.** ADR-08 justificava confidencialidade dizendo que "o tráfego UDX é cifrado
ponta a ponta". O README do UDX declara o contrário (`relatorio-auditoria-adr.md` §3.6,
`T-11`). Além disso, `relay.volunteer` não exigia prova de posse da `relayKey`, então
qualquer membro redirecionava o tráfego da comunidade para um terceiro (`T-14`), e a chave
ficava no log para sempre, sem TTL nem cota (`F-49`).

**Decisão.** O voluntário roda um **TURN restrito**, encaminhando SRTP que não decifra.
- `relayPk` é **derivada da identidade do voluntário** — apontar para terceiro é
  impossível.
- `relay.volunteer` carrega prova de posse, verificada pelo `fold` (R-19).
- TTL obrigatório (24 h), renovável; expirado sai da lista.
- Cota de bytes/dia e de alocações; atingida, para de aceitar e emite evento.
- Consentimento explícito e persistido; superfície nova em 3.1 → Rede.

**L-14:** o voluntário observa **metadados** — com quem, quando, quanto. Está no texto de
consentimento.

**Status.** Aceita, **REQUIRES POC** (G7). **Fecha:** `T-14`, `F-49`, corrige a afirmação
falsa de confidencialidade da ADR-08.

---

### A22 — Autorização de mídia por ticket assinado pelo host

**Contexto.** `T-15`: a sinalização era peer-a-peer sem autorização — qualquer chave
conhecida abria conexão com qualquer membro. `T-32`: a sessão de mídia sobrevivia ao ban e
o timeout não alcançava a voz. `T-41`: a captura de tela começava antes da autorização.

**Decisão.**
- O host emite um `ticket` Ed25519 por par de pares e por sessão, com TTL de 5 min,
  renovável. Um cliente **só** aceita sinalização e **só** inicia DTLS com quem apresenta
  ticket válido.
- Moderação (`ban`, `kick`, `timeout`, `channel.delete`) faz o host emitir `voice.revoked`;
  cada cliente é obrigado a fechar a conexão. No pior caso, o ticket expira em 5 min.
- `getDisplayMedia` só é concedido pelo main depois de `share.start` autorizado, via
  `captureToken`.

**L-12:** `voice_mute_others` é **conselho ao cliente do alvo**, não enforcement de mídia.
O que é enforcement é remover do roster e revogar o ticket. A UI precisa distinguir os dois.

**Status.** Aceita. **Fecha:** `T-15`, `T-32`, `T-41`, qualifica `T-40`.

---

### A23 — Sucessão de host por escrow e migração para core novo

**Contexto.** `T-43`: sem sucessão nem recuperação, a máquina do host morrer é a comunidade
morrer permanentemente. O ARB classificou isso como limitação de produto **não aceita**.

**Decisão.**
- O host designa até 5 sucessores em ordem de prioridade e escrowa o `communitySeed`
  cifrado para cada um (`crypto_box_seal`). O segredo nunca aparece em claro no log.
- Depois de 30 dias sem registro novo, o sucessor de maior prioridade **cria uma comunidade
  nova**, cujo lote de gênese referencia a antiga e carrega uma prova de posse da chave de
  escrita antiga.
- Não se escreve no core antigo — isso produziria dois escritores e um fork. Membros seguem
  o ponteiro; a comunidade antiga fica em modo histórico.
- Estrutura (cargos, categorias, canais) e moderação são reconstruídas no lote de gênese
  estendido. **Membros não** — ver a emenda abaixo.

**L-15:** o **histórico de mensagens não migra**. Migrar reassinado falsificaria autoria;
migrar os envelopes originais exigiria core multi-escritor. Nenhum dos dois é aceitável.
**L-16:** dois sucessores em janelas próximas produzem duas comunidades novas; cada réplica
segue a de maior prioridade, deterministicamente.

**Emenda de 2026-08-22 — `ACHADO-G12-01`: o roster não migra.** O G12
(`poc/poc-12-g12`) mediu que a continuação nasce com exatamente **um** membro. Reconstruir
membros é impossível com o catálogo fechado de 38 `kind`s: `member.join` cria a membresia do
próprio autor, o `joinProof` de R-9 vincula o `communityId` **novo** — que o sucessor não
forja para terceiros — e ninguém assina por um terceiro (`F-06`). Decisão: **reentrada
assistida** — o sucessor publica convites, cada pessoa entra com a própria chave e ele
reatribui cargos conforme as reentradas chegam (**L-23**). Para que a reentrada não lave
moderação, os bans **migram** no lote estendido, e `mod.ban` passa a admitir alvo que não é
membro (**R-28**, §18.8.1). *Alternativas descartadas:* desacoplar alvo da autoria com um
`targetKey` em `member.join` — reabre `F-06` e quebra a verificação self-contained da camada
(a) de R-18, já que réplicas sem a origem não podem conferir o roster declarado; transplante
dos envelopes originais — exige core multi-escritor, recusado por esta mesma ADR em L-15.

**Status.** Aceita, **REQUIRES POC** (G12), emendada em 2026-08-22. **Fecha:** `T-43` na
parte de continuidade.

---

### A24 — Backup de identidade protegido por frase secreta

**Contexto.** `T-43` também aponta a outra metade: perder o dispositivo é perder a
identidade, sem recuperação. A premissa 3 da spec de UX ("sem backup/export de chave") foi
escrita antes de existir uma arquitetura em que o host é uma máquina doméstica.

**Decisão.** `identity.export{passphrase}` produz um arquivo cifrado (Argon2id +
XChaCha20-Poly1305) com a semente de identidade, os metadados e a lista de comunidades,
incluindo as sementes das comunidades hospedadas. `identity.import` só em instalação sem
identidade. O arquivo nunca passa pelo renderer.

**Consequências.** **Muda a premissa 3 da UX** (delta U-01) — duas telas novas.
**L-4:** o backup não é multi-dispositivo; duas instalações hospedando a mesma comunidade
produzem fork, detectado e sinalizado. Frase secreta perdida = backup perdido.

**Alternativas descartadas.** *Não ter backup:* mantém `T-43` sem resposta.
*Multi-dispositivo com sincronização:* fora do v1, exige `keet-identity-key` e um modelo de
device linking que não está desenhado.

**Status.** Aceita. **Fecha:** `T-43` na parte de identidade.

---

### A25 — Um único eixo otimista

**Contexto.** `F-15`: a UX é otimista em toda a Camada 2, mas em v1 só `message.send` era
assíncrono. Reagir, editar, fixar e criar thread eram RPCs síncronos de 30 s que falhavam
com host offline, **sem rollback especificado**. `F-12`: auto-save de 800 ms contra ops
síncronas com rate limit de 20/60 s e log append-only.

**Decisão.**
- **Toda op do domínio de mensagem** (`send`, `edit`, `delete`, `pin`, `reaction.set`,
  `thread.create`) é assíncrona por contrato: outbox durável, retorno imediato, desfecho por
  evento.
- **Toda op de estrutura, cargo, moderação, comunidade e convite** é síncrona, exige host
  online e não enfileira.
- **Auto-save é substituído por salvamento explícito** nos formulários de comunidade, canal
  e cargo.

**Consequências.** A UI é otimista **só** onde existe fila durável e reconciliação. Nas
demais, é confirma-depois-desenha, com estado de carregamento. Deltas U-02 e U-23.

**Status.** Aceita. **Fecha:** `F-12`, `F-15`, `RT` correlatos.

---

### A26 — Deletar é sempre tombstone

**Contexto.** Herdada da ADR-10, classificada `ACCEPTED RISK` pelo ARB.

**Decisão.** Nenhuma op remove bytes do log. `message.delete`, `channel.delete`,
`role.delete` e `category.delete` appendam uma op que o `fold` interpreta como remoção.
`content` vira `NULL` na projeção.

**Consequências.** "Não pode ser desfeito" é verdade para a interface, não para os bytes.
Editar não apaga o conteúdo anterior. A UX precisa dizer as duas coisas (deltas U-19, U-20).

**Status.** Aceita.

---

### A27 — Presença e digitando efêmeros, com agregação e assinatura por interesse

**Contexto.** ADR-14 estava semanticamente correta, mas o fan-out não tinha política:
`F-13` e `T-28` apontaram que 340 membros produziriam rajadas com custo desconhecido e sem
rate limit, amplificadas 1→N pelo host.

**Decisão.** Semântica efêmera mantida. Fan-out redesenhado:
- presença agregada num **delta consolidado** a cada 2 s, só para membros conectados;
- `typing` só para quem assinou aquele canal (`subscribeChannel`);
- `voiceOccupancy` agregado (contagem + até 5 chaves) para todos, que é o que alimenta os
  avatares inline da sidebar;
- rate limit por autor no host.

**L-13:** presença e digitando são **at-most-once**. Perder um evento é aceitável; o TTL
corrige em ≤ 45 s.

**Status.** Aceita, **BENCHMARK REQUIRED** (G9). **Fecha:** `F-13`, `DS-30`, `RT-05`,
qualifica `T-28`.

---

### A28 — Não-lidas e menções locais, por canal e por thread

**Contexto.** ADR-15 estava certa no escopo (é estado de quem lê) e incompleta: não havia
tabela nem query para não-lidas de thread (`DR-48`), e `pending_mentions` dependia de
cargos que mudam sem regra de recálculo (`F-48`), com risco de contagem dupla na
reprojeção (`F-25`).

**Decisão.** Watermark por `seq`, em `manifest.db`, com **duas** tabelas:
`local_read_state` (por canal) e `local_thread_read_state` (por thread). O contador é uma
**query sobre `seq > lastReadSeq`**, não um acumulador — por isso não há contagem dupla. É
recomputado do zero na reprojeção e quando os cargos da identidade local mudam.

**Status.** Aceita. **Fecha:** `F-25`, `F-48`, `DR-48`, `RT-03`.

---

### A29 — Conversa direta entre identidades: par de logs de escritor único

**Contexto.** O produto de hoje só sabe conversar **dentro de** uma comunidade. Falar com
alguém exige que alguém hospede uma comunidade e emita convite. A pergunta levantada em
2026-08-25 é se dá para trocar mensagem e chamar alguém **sem comunidade nenhuma** — o
equivalente a uma DM.

A redação anterior desta ADR registrou o desenho como viável e deixou **em aberto** a escolha
entre duas formas: a **comunidade degenerada de dois** (barata, herda o problema de host
offline) e o **duplo log com merge** (resolve o problema, exige gate novo). Ela também
registrou, corretamente, que a escolha "não deve ser resolvida por conveniência de
implementação". Esta emenda, de 2026-09-01, a resolve; a contraparte normativa é
`backend-v2.md` **§31**.

Três fatos da arquitetura continuam valendo e são o que torna a coisa barata:

1. **A porta de conexão já aceita desconhecido.** `firewallShouldRejectConnection` recusa
   apenas quando o par está banido em **todas** as comunidades em comum; com zero comunidades
   em comum ele **não recusa** (§14.3(4), `core/src/l0/swarm/index.ts`).
2. **A identidade já é endereçável.** Por **L-24**, a chave pública de identidade **é** o nó
   na DHT. `A` alcança `B` pela chave, sem mecanismo de descoberta novo.
3. **As primitivas já existem.** Ed25519, a conversão para X25519, XChaCha20-Poly1305,
   BLAKE2b e a derivação por prefixo de domínio estão todas em §5.1/§5.2. A DM não pede
   primitiva nenhuma que a spec já não use.

**Decisão.** Uma conversa direta entre `A` e `B` é um **par de Hypercores de escritor único**
— o de `A` e o de `B` —, cada um escrito só pelo dono, replicado só entre os dois, unido por
um **merge determinístico** com marcador causal de duas posições. Sem host, sem outbox, sem
convite, sem canal, sem cargo e sem moderação. A forma completa é `backend-v2.md` §31.

**A conversa direta entra no v1** — decisão de escopo do operador, 2026-09-01 — como a
**fase 11** de `backend-v2.md` §29, bloqueada por **G14** (POC-14 do plano de validação).
O caminho de implementação está quebrado em itens ordenados em `backlog.md` (B54..B62).
Nenhuma fase anterior depende dela: a fase 11 é a última porque **reusa** o caminho de
anexos da fase 6 e o de mídia das fases 7–8, não porque alguma delas a espere.

As nove decisões de alto custo de mudança, cada uma com a razão:

| # | Decisão irreversível | Razão |
|---|---|---|
| 1 | **Modelo de replicação: dois logs de escritor único, um por participante** | É o mesmo primitivo de A01, sem multi-escritor: nada aqui pede Autobase, que A01 recusou como "pesquisa, não engenharia". Resolve a assimetria que a comunidade degenerada produz — lá, **quem não hospeda não escreve enquanto o outro está offline** |
| 2 | **Identificador de conversa derivado: `BLAKE2b('dm-conv/1' ‖ min(pk) ‖ max(pk))`** | Derivado, simétrico, único por par, estável para sempre. Não exige registro, negociação nem autoridade. Um UUID exigiria as três, e não sobreviveria à exclusão local seguida de recontato |
| 3 | **Chave de core derivada do `identitySeed`, anunciada com prova de posse** | Quem restaura a identidade pelo backup de A24 recupera a própria metade de toda conversa **sem um campo novo no arquivo de backup**. É o mesmo argumento da emenda de 2026-08-22 de §13.1 |
| 4 | **Formato de envelope próprio, com `DM_VERSION` próprio** | Não toca `opVersion = 2` nem os 38 `kind`s. Um `kind` de DM no catálogo de comunidade forçaria `opVersion = 3` e **reprojeção de toda comunidade existente** — custo pago por todo mundo para uma conversa que não usa nenhuma das regras de comunidade. Com registro próprio, as duas versões de protocolo evoluem sem se prender uma à outra |
| 5 | **Ordem canônica por soma de um relógio vetorial de duas posições, com desempate por chave** | Com duas partes, um vetor de duas posições é o mínimo que captura causalidade; a soma é monotônica sob *happened-before*, o que dá uma ordem total, estável por registro e determinística, computável sem relógio. Timestamp como ordem faria a interpretação depender do ambiente (§1.5) |
| 6 | **`ack` no material assinado, servindo a dois papéis: ordem e entrega** | Um `uint64` paga por si duas vezes. **Entrega deixa de precisar de `kind`, de estado replicado e de ACK**: ela é derivada, e atestada pela assinatura do par |
| 7 | **Payload cifrado com AEAD sob chave estática de ECDH; cabeçalho em claro** | Torna a chave do core uma chave de **replicação**, não de leitura — ela trafega e é gravada em claro. O cabeçalho fica legível porque ordem, dedupe e integridade precisam ser computáveis sem a chave, o que mantém aberta a porta de um terceiro sedimentar o core sem lê-lo |
| 8 | **Sem outbox: a escrita é `core.append` local e o comando IPC responde com o registro já no log** | É uma **terceira classe de escrita**, ao lado das duas de A25. Ela existe porque não há a que submeter; manter a outbox seria manter uma máquina de estados de cinco posições para modelar uma espera que não acontece |
| 9 | **Consentimento por pedido, com bloqueio silencioso e local** | É a forma do canal pré-membro de §12.3 aplicada a contato não solicitado. Bloqueio replicado seria o aviso que a decisão recusa dar: avisar transforma o bloqueio num sinal para escalar |

**Consequências.**

- **Nenhuma sobre o v1.** Nada em §1–§30 muda de semântica; §31.25 lista os acréscimos às
  tabelas fechadas, e todos são linhas novas.
- **A outbox de §11 não é reutilizada**, e isso é ganho, não perda: some a máquina de estados
  de §11.3, some a reconciliação de §11.6, some `observed_ops` para DM e some a família
  inteira de descarte com motivo nomeado de §11.7.
- **A deduplicação passa a ser estrutural**: índice do core + `authorSeq = index + 1` + o
  vínculo de conversa no material assinado. Não há tabela, não há janela e não há
  `lastAuthorSeq` por escopo.
- **Custo:** um `fold` novo, um codec novo, um projetor novo e um protocolo `protomux` novo —
  cada um pequeno, e todos com a mesma disciplina dos existentes. E um gate: **G14**.
- **Custo declarado:** cinco limitações novas, **L-25** a **L-29** (§25.8). A mais dura é
  **L-26** — a entrega exige as duas pontas online ao mesmo tempo em algum momento, porque
  não há store-and-forward e não haverá.
- **A mídia fica mais simples que na comunidade**: sem ticket (§17.4) e sem sinalização
  encaminhada (§16.3), porque o canal direto autenticado dá as duas propriedades. E fica mais
  frágil: sem relay voluntário, porque numa dupla não há terceiro (**L-29**).

**Alternativas descartadas.**

- ***Comunidade degenerada de dois*** — a alternativa que a redação anterior mantinha aberta.
  Quatro razões independentes, e a primeira decide sozinha:
  1. **Não é implementável na forma que resolveria o problema.** Para não herdar o host
     offline, seriam precisas **duas** comunidades-de-um, uma por participante. Mas o estágio
     3 de §8.2 recusa todo registro cujo `communityId` não seja o do core, e §7.3 escopa todo
     id por comunidade: uma reação, uma resposta ou uma edição referindo o outro lado é
     `REJECTED` **por construção**. Uma comunidade única de dois não tem esse problema e tem
     o outro — quem não hospeda não escreve com o host offline.
  2. **Estoura um limite operacional declarado.** §26.2 fixa 50 comunidades participadas, e o
     escalonador de §14.2 faz round-robin entre elas. Conversas como comunidades colidem com
     os dois no primeiro dia de uso.
  3. **A conversa passa a pertencer a uma das duas máquinas.** Se quem hospeda desinstala, a
     conversa morre; a sucessão de A23 exige 30 dias de carência e produz uma comunidade nova
     com **um** membro (**L-23**) — inaplicável a uma dupla.
  4. **Instancia e esconde o que não significa nada.** Fundador, cargo base, categoria, canal,
     `memberCount`, hierarquia e as regras R-3/R-4/R-5/R-11/R-27 rodando sobre uma estrutura
     sem sentido, mais um convite trocado para começar a conversar.
- ***Ops de DM no catálogo de `kind`s de comunidade:*** quebra o fechamento de
  `opVersion = 2` por uma funcionalidade fora do v1.
- ***Autobase multi-writer:*** já recusada em A01 — "continua sendo pesquisa, não
  engenharia". A decisão desta ADR **não** a reintroduz: dois cores de escritor único não são
  um core multi-escritor.
- ***Store-and-forward por um terceiro nó:*** reintroduz papel de servidor e contradiz §25.4.
  É a origem de **L-26**.
- ***Feed único por identidade (modelo Secure Scuttlebutt):*** replicar para um par exporia
  tudo o que você escreveu para todos. O escopo do feed passa a ser **por conversa**, o que
  faz o escopo de replicação coincidir com o de confidencialidade.
- ***Double Ratchet / forward secrecy (modelo Signal):*** exige apagar material de decifragem
  antigo, e A24 promete recuperar o histórico a partir do backup enquanto §10.5 o relê a cada
  reprojeção. Incompatibilidade estrutural, não preferência.
- ***DAG com resolução de estado (modelo Matrix):*** existe porque uma sala tem N escritores.
  Com dois, o relógio vetorial de duas posições basta e a linearização é fechada.
- ***Tópico de conversa derivado do segredo compartilhado:*** esconderia de um nó da DHT que
  alguém procura por você, mas **não funciona no primeiro contato** — o destinatário não
  conhece o remetente e não consegue computar o tópico —, e o lado que anuncia continua
  anunciando a própria chave. Ficaria um segundo mecanismo por um ganho parcial. É aditiva:
  pode entrar depois como otimização de rendezvous, sem mudar contrato.
- ***Confirmação de leitura (`dm.read`):*** A28 decidiu que estado de leitura é do leitor, e
  uma confirmação replicada é metadado que o produto passaria a vazar por decisão de
  protocolo. **Entrega** já é observável pelo `ack`, sem `kind` novo.
- ***Cota determinística de escrita no `dmFold` (análogo de R-15):*** R-15 existe porque o log
  de uma comunidade é compartilhado. Aqui cada um escreve no próprio core e no próprio disco;
  uma cota custaria estado e determinismo sem fechar ameaça.

**Status.** **Aceita, `REQUIRES POC` (G14) — fase 11 do v1.** A contraparte normativa é
`backend-v2.md` §31; o gate é POC-14 / G14 em
`plano-de-validacao-experimental-v2.md`. **Não fecha nada** — a conversa direta não estava
entre os 195 achados. Origem: validação em rede real de `sequenciamento-pos-fase-0.md` §72;
forma decidida em 2026-09-01; entrada no v1 decidida pelo operador na mesma data.

**Duas coisas que a entrada no v1 obrigou a mexer fora de §31, e que são consequência dela,
não decisão nova:** a regra permanente 5 de §25.4 dizia "nenhum dado sai do dispositivo a não
ser para um par **da comunidade**", o que, com a DM no v1, proibiria o próprio produto — a
regra sempre quis dizer *nenhum terceiro*, e passou a dizê-lo; e §29 ganhou a **fase 11**,
posicionada no fim porque reusa anexos e mídia, com o gate podendo rodar desde a fase 2.

---

## 3. Decisões que **não** viraram ADR, e por quê

| Assunto | Onde está | Por que não é ADR |
|---|---|---|
| FTS5 local com `unicode61 remove_diacritics 2` | §23 | Decisão local, substituível sem efeito sistêmico; continua `BENCHMARK REQUIRED` |
| Replicação de toda comunidade participada | §14.2 | Requisito de produto (badge no rail), não escolha arquitetural; o que é decisão é o **escalonador**, que está na spec |
| Sem push com app fechado no v1 | Escopo | Corte de escopo declarado |
| Sem descoberta LAN | §25 e delta U-26 | Limitação do ecossistema, declarada |
| Nenhum servidor, TURN de terceiro, unfurl, CDN, analytics ou crash reporter | §25.4 | Princípio de produto; introduzir qualquer um exige ADR nova |

---

## 4. Status consolidado

| Status | ADRs |
|---|---|
| **Aceita, sem dependência experimental** | A01, A02, A03, A04, A05, A06, A07, A08, A09, A10, A11, A12, A15, A24, A25, A26, A28 |
| **Aceita, `REQUIRES POC`** | A13 (G10), A14 (G6), A16 (G0), A17 (G7/G8), A19 (G8), A21 (G7), A22 (G7), A23 (G12), **A29 (G14)** |
| **Aceita, `BENCHMARK REQUIRED`** | A27 (G9) |
| **Adiada, fora do v1** | A20 (G13) |
| **Revogada** | A18 (registro da revogação de ADR-06 e ADR-07 de v1) |

**Nenhuma ADR v2 está em estado `BLOCKER`.** As nove com `REQUIRES POC` têm o gate
declarado, a hipótese escrita e a consequência objetiva de falha registrada em
`plano-de-validacao-experimental-v2.md` — o que é diferente de "pendente".
