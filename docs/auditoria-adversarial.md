# Auditoria Adversarial de Arquitetura — Uniduni

**Documentos auditados**
- `backend.md` — Especificação Técnica do Backend (2.986 linhas), lido integralmente.
- `frontend.md` — Especificação de UX/UI (1.605 linhas), lido integralmente, incluindo o Apêndice A e as 11 partes de "Status de implementação".

**Postura:** cética e adversarial. O objetivo declarado foi tentar **derrubar** a arquitetura, não melhorá-la. Nenhuma decisão foi aceita por estar escrita como ADR. Nenhum achado é preferência pessoal de estilo: cada um aponta uma contradição verificável, um estado sem comportamento definido, um dado que não pode existir, ou uma premissa que a própria spec não sustenta.

**Nota de calibragem, exigida pelo pedido:** este laudo diferencia rigorosamente três coisas.
- **Achado** = problema demonstrado com cenário concreto.
- **"Não encontrei evidência de problema"** = examinei e não consegui derrubar (§ final, "Áreas atacadas sem sucesso"). Isso **não** é atestado de correção.
- **"Comprovadamente correto"** = não aparece neste laudo em lugar nenhum. Nenhuma parte desta arquitetura foi comprovada correta por esta auditoria; auditoria de documento não prova corretude.

**Verificação prévia de integridade das referências.** Antes de acusar contradição entre documentos, conferi ~45 citações `spec:NNN` do backend contra as linhas reais de `frontend.md`. Elas batem (ex.: `spec:498` = escopo do silenciamento; `spec:729` = permissões do cargo base editáveis; `spec:1062` = ordenação; `spec:1598` = regra do seletor Zustand). Portanto os achados abaixo **não** são artefato de numeração defasada. Duas exceções menores estão registradas em F-46.

---

## Convenções

**Severidade**
- **CRITICAL** — impede a construção do sistema como especificado, ou produz perda de dado / indisponibilidade permanente / falha de segurança sem caminho de recuperação.
- **HIGH** — contradiz um requisito declarado de produto, ou produz estado incorreto persistente, ou torna uma superfície da UI inimplementável.
- **MEDIUM** — lacuna real de especificação que obriga o implementador a inventar decisão de arquitetura (o que §0 do backend proíbe explicitamente).
- **LOW** — inconsistência de documento, com impacto contido.

**Tipo** — `CONTRADIÇÃO` · `REQUISITO AUSENTE` · `RISCO` · `INVIABILIDADE` · `PREMISSA NÃO COMPROVADA`.

**Índice de severidade**

| Severidade | Quantidade | IDs |
|---|---|---|
| CRITICAL | 6 | F-01 … F-06 |
| HIGH | 16 | F-07 … F-22 |
| MEDIUM | 21 | F-23 … F-43 |
| LOW | 7 | F-44 … F-50 |

---

# CRITICAL FINDINGS

---

## F-01 — `blobsKey` e o conjunto de comunidades participadas existem **só** na tabela de projeção e não são reconstruíveis a partir do log

**Severidade:** CRITICAL
**Tipo:** CONTRADIÇÃO + INVIABILIDADE

**Localização exata**
- `backend.md` §6.3, tabela **Projeção**, linha `communities`: `blobs_key BLOB NOT NULL`.
- `backend.md` §5.3, bloco "Comunidade e rede": payload de `community.create` = `name, iconEmoji?, iconColor, description?`.
- `backend.md` §6.4, "Reprojeção total": *"apaga **só** as tabelas de projeção, zera os `last_projected_seq`, reprojeta do 0"*.
- `backend.md` §5.4: *"Não há migração de dado em SQLite, porque SQLite é descartável."*
- `backend.md` §21.4: *"É o teste que protege a ADR-02."*
- `backend.md` §11.4, Resgatar, passo 3: `{seq, coreKey, blobsKey, defaultChannelId}` — o `blobsKey` chega por **RPC**, fora do log.

**O que a especificação afirma**
Que o SQLite é uma view materializada 100% descartável do Hypercore, que reprojetar do `seq` 0 produz estado idêntico (§21.4), e que essa propriedade é o teste que protege a ADR-02.

**Por que isso é potencialmente problemático**
`blobs_key` é `NOT NULL` numa tabela de **projeção** (portanto apagada em `reproject()`), mas **nenhuma op do catálogo de §5.3 o carrega**. `coreKey` é recuperável (`id` = hex do `coreKey`, §4.2) e `hostKey` é recuperável (`op.author` de `community.create`), mas `blobsKey` só existe no retorno do `inviteRedeem` e no ato local de criação. O mesmo vale, com força maior, para a **lista de comunidades participadas**: o projetor de §11.2 itera "para cada linha de `communities`" — uma tabela que a reprojeção acabou de esvaziar. Não há tabela `local_*` que enumere participações (§6.3 lista `local_community_pref`, `local_read_state`, etc., todas com `community_id` como chave, mas nenhuma delas é declarada como o registro autoritativo de participação, e nenhuma é declarada como criada no join). Também não há especificação do mapeamento `communityId → namespace do corestore` (§11.1 usa `corestore.namespace(random)`).

**Cenário concreto**
1. Ana participa de 8 comunidades há 6 meses, com 4 GB de anexos baixados.
2. A versão nova do app incrementa `meta.schema_version` (§5.4 diz que isso é "trivial").
3. No boot, §6.4 dispara reprojeção total: apaga `communities`, `channels`, `messages`, …
4. O projetor tenta iterar `communities` para saber o que reprojetar. A tabela está vazia.
5. Mesmo assumindo que os ids sejam recuperados de `local_community_pref`, `blobs_key` não pode ser reconstruído de log nenhum.
6. `swarm.join(blobsKey)` (§14.2, regra 1 — "sem esta linha, o download nunca começa") torna-se impossível. Todo anexo de todas as comunidades fica permanentemente inacessível.
7. Não há caminho de recuperação: o convite original pode ter sido revogado, expirado ou esgotado (§4.11, três estados terminais), e não existe RPC "me diga o blobsKey" para um membro já existente.

**Consequência para o sistema**
Um bump de schema — a operação que a spec descreve como "trivial" — destrói de forma irreversível o acesso a anexos e, potencialmente, à própria lista de comunidades. A ADR-02 ("SQLite como view materializada descartável") é **falsa como escrita**, e o teste de §21.4 que deveria protegê-la não pega isso, porque ele compara o dump de duas projeções do mesmo core — ambas igualmente sem `blobsKey`.

**Evidência necessária para confirmar ou refutar**
- Localizar qualquer op de §5.3 que carregue `blobsKey`. Se não existir, o achado está confirmado por leitura.
- Verificar se existe intenção de derivar `blobsKey` deterministicamente de `coreKey` (ex.: `corestore.namespace(coreKey).get({name:'blobs'})`). Se sim, isso precisa virar texto normativo — hoje não está em lugar nenhum, e §11.1 usa namespace **aleatório**, o que impede a derivação.
- Executar o teste de §21.4 acrescentando "apagar `view.db` inteiro (não só as tabelas de projeção) e reabrir o app" como passo. É o teste que hoje não existe e que expõe a falha.

---

## F-02 — O host não consegue verificar a prova de convite de convites que ele não criou

**Severidade:** CRITICAL
**Tipo:** CONTRADIÇÃO + INVIABILIDADE

**Localização exata**
- `backend.md` §4.11, tabela: `secret | bytes[10] | **local** | Só na réplica de quem criou, para poder re-exibir o código`.
- `backend.md` §4.11, restrições: *"**O segredo nunca entra no log.** … O log guarda `codeHash`; o host valida por prova de conhecimento (§11.4)."*
- `backend.md` §11.4, Resolver, passos 2–4: *"O host manda `challenge` … O candidato responde `proof = BLAKE2b('invite-auth/1' ‖ secret ‖ challenge)` … **O host recomputa.**"*
- `backend.md` §8.1: permissão `create_invite` é grantável a qualquer cargo.
- `frontend.md` §10 (3.2): "convidar pessoas" está no checklist de permissões do grupo Moderação.

**O que a especificação afirma**
Que o segredo do convite só existe na réplica de quem criou o convite, que o log guarda apenas o hash, e que o host valida a entrada recomputando uma prova que depende do segredo.

**Por que isso é potencialmente problemático**
As duas afirmações são mutuamente exclusivas. Para recomputar `BLAKE2b('invite-auth/1' ‖ secret ‖ challenge)` o host precisa do `secret`. Se o convite foi criado por um membro com `create_invite` que **não é o host**, o host tem apenas o `codeHash` (que veio no log) e é criptograficamente incapaz de derivar o `secret` de volta. Não existe RPC no §10.6 pelo qual o criador entregue o segredo ao host, e §4.11 proíbe explicitamente que ele trafegue no log.

**Cenário concreto**
1. Rafael (host, Fundador) cria o cargo Moderador com `create_invite` e o atribui a Bianca — cenário exatamente previsto por §8.1 e pelo checklist de `frontend.md` 3.2.
2. Bianca executa `invite.create`. Seu núcleo gera `secret` (10 bytes), grava `codeHash` na op e o `secret` só em `invites.secret` local (§11.4, Emitir).
3. Bianca manda o código `X7K2-QM9F-RT4B-N8ZP` para Carlos.
4. Carlos deriva `codeHash`, calcula o tópico, conecta ao host (§11.4, Resolver, passo 1). O host de fato anuncia esse tópico, porque ele tem o `codeHash` do log.
5. O host manda o `challenge`. Carlos responde a `proof`.
6. O host **não pode** recomputar a prova. Ele não tem o `secret`.
7. O único desfecho possível é `E_INVITE_INVALID`.

**Consequência para o sistema**
Convites criados por qualquer pessoa que não seja o host nunca funcionam. Como `create_invite` é uma das 17 permissões do produto e a UI de 3.1b lista convites com a coluna "criado por", a funcionalidade "delegar convites a moderadores" é inteiramente não-funcional. Pior: o modo de falha é `invalid`, que segundo `spec:444` é indistinguível de "convite ruim" para o usuário — o produto acusa o convite de estar errado quando o problema é arquitetural.

**Evidência necessária para confirmar ou refutar**
- Confirmar por leitura que não existe caminho especificado para o segredo chegar ao host. (Verifiquei §5.3, §10.2, §10.6, §11.4 — não existe.)
- Se a intenção era que o candidato enviasse o **segredo em claro** ao host (o host então compara `BLAKE2b('invite/1' ‖ secret)` com o `codeHash` do log), então: (a) o desenho de challenge-response de §11.4 está errado e deve ser removido; (b) a proteção contra força bruta muda de natureza (o teste de §21.5 assume a prova); (c) o host passa a conhecer o segredo, o que precisa entrar no modelo de ameaça de §18.1.

---

## F-03 — O caminho de escrita de anexos é impossível como escrito: o core de blobs tem um escritor único (o host), mas §11.13 faz o membro escrever nele localmente

**Severidade:** CRITICAL
**Tipo:** CONTRADIÇÃO + INVIABILIDADE

**Localização exata**
- `backend.md` §11.1, passo 1: *"`corestore.namespace(random)` → cria core `log` e core `blobs`"* — ambos criados na máquina do host, ambos assináveis só por ele.
- `backend.md` §6.2, tabela: `blobs | blobsKey | **Escrito por: quem anexa (via host)**`.
- `backend.md` §11.13, Sequência: *"lê em stream → calcula BLAKE2b enquanto lê → **`hyperblobs.put` no core de blobs** → devolve `{blobId, hash, sizeBytes, kind}`"*.
- `backend.md` §3.2, ficha do módulo `blobs`: `Depende de: corestore, swarm, storage` — **não** depende de `rpcClient`.
- `backend.md` §10.2, `blob.stage`: erros = `E_ATTACHMENT_TOO_LARGE`, `E_FILE_UNREADABLE`. Nenhum erro de rede.
- `backend.md` §10.6: existe o método RPC `blobAnnounce | {blobId, hash} | {} | host`.
- `backend.md` §14.1: *"Um `hyperblobs` por comunidade"*.

**O que a especificação afirma**
Três coisas simultaneamente incompatíveis: (a) que há **um** hyperblobs por comunidade, cujo core foi criado pelo host; (b) que quem anexa escreve nele "via host"; (c) que `blob.stage` é uma operação **local e síncrona** do módulo `blobs`, que não tem dependência de RPC nem erro de host indisponível.

**Por que isso é potencialmente problemático**
Um Hypercore tem escritor único — o detentor da chave secreta. O core de blobs foi criado no namespace do host. Portanto nenhum membro pode executar `hyperblobs.put` nele. Cada uma das três leituras possíveis quebra algo diferente:
- **Leitura (b) — upload via host:** o arquivo inteiro precisa subir para o host antes que a mensagem exista. Para o teto declarado de `ATTACHMENT_MAX_BYTES` = 8 GiB (§19.2, `ARQ-03`), isso significa 8 GiB atravessando o RPC do host, que é **estritamente sequencial por comunidade** (§12.3, "fila de uma via"). O host fica indisponível para todo mundo durante o upload. Contradiz também §11.13, que devolve `blobId` sem contato com host, e §10.2, que não lista erro de host.
- **Leitura (c) — put local:** criptograficamente impossível.
- **Leitura implícita pelo `blobAnnounce`** — cada membro tem o **seu** core de blobs e anuncia ao host. Contradiz §14.1 ("um por comunidade") e §4.2 (Community tem um único `blobsKey`), e deixa `blobsKey` sem função.

**Cenário concreto**
Ana, membro comum de Vale do Código (host = Rafael), anexa `aula-webrtc-completa.mp4` (1,24 GB, o arquivo do dataset de referência de `frontend.md` §2). O renderer chama `blob.stage`. O módulo `blobs` (L2), cujas dependências declaradas são `corestore`, `swarm` e `storage`, precisa gravar 1,24 GB num core cuja chave secreta está na máquina de Rafael. Não há chamada possível. O fluxo C9 de `frontend.md` — que a Parte 4 declara implementada e verificada — não tem backend.

**Consequência para o sistema**
Toda a fase 5 do plano de implementação (§23) não tem contrato executável. O card de anexo, o fluxo B8 (download estilo torrent), a aba Arquivos de 2.1.2 e a promessa de produto de `CLAUDE.md:20-22` dependem de um caminho de escrita que não existe. Adicionalmente, se a leitura (b) for a escolhida, o host acumula indefinidamente todos os anexos de todas as suas comunidades num core append-only que "não encolhe" (§13.6) — com `BLOB_CACHE_MAX_BYTES` de 20 GiB aplicando LRU *exceto* ao que "a identidade local enviou", categoria indefinida para um host que recebeu tudo por upload.

**Evidência necessária para confirmar ou refutar**
- Confirmar a semântica de escritor único do `hyperblobs`/`hypercore` na versão travada (`hypercore@11`). Se `hyperblobs` suportasse multi-writer, a ADR-02 (zero Autobase) já estaria violada.
- Decidir e escrever qual dos três modelos vale, e refazer §6.2, §10.2, §11.13, §14.1 e a ficha do módulo `blobs` em §3.2 de forma coerente.
- Medir o custo do modelo (b): tempo de ocupação da fila serializada do host durante um upload de 8 GiB, e o efeito em `submitOp` p95 (alvo de §19.1: 60 ms).

---

## F-04 — Qualquer exceção de reducer é uma parada permanente, auto-reproduzível e sem recuperação da comunidade inteira — e há pelo menos quatro caminhos especificados que chegam nela

**Severidade:** CRITICAL
**Tipo:** RISCO + REQUISITO AUSENTE

**Localização exata**
- `backend.md` §6.4, "Regras que não são negociáveis": *"**Reducer que lança:** aborta a transação do lote inteiro, registra `projector.failed` com `seq` e `kind`, e o projetor **para** aquela comunidade em estado `degraded`."*
- `backend.md` §6.4, "Reprojeção total dispara quando: … ou `projector.failed` seguido de reinício."
- `backend.md` §4.18: *"Violação é bug de reducer e deve abortar a transação com `E_INVARIANT`."*
- `backend.md` §3.2, ficha de `reducers`: *"**Não pode** Rejeitar: o que chega aqui já passou pelo `validator`."*
- `backend.md` §6.6: *"Append no host | **Não** atômico com a projeção do host"*.
- `backend.md` §12.3: *"o `append` é assíncrono em lote"*.

**O que a especificação afirma**
Que reducers nunca rejeitam, porque tudo que chega neles passou pelo validador; que se um reducer lançar, isso é bug e o correto é parar; e que reiniciar dispara reprojeção total.

**Por que isso é potencialmente problemático**
A recuperação especificada é **reprojetar do `seq` 0** — o que reprocessa exatamente o mesmo registro que fez o reducer lançar, produzindo exatamente a mesma exceção. O ciclo é: falha → `degraded` → reinício → reprojeção cara (20 s para 200k registros, §6.4) → falha no mesmo `seq` → `degraded`. **Não existe caminho de saída especificado**, nem quarentena de registro, nem skip-com-log, nem intervenção manual. E o estado `degraded` é por comunidade em **cada réplica independentemente** — se a causa é um registro do log (que é o mesmo para todos), *todas* as réplicas param no mesmo ponto, ao mesmo tempo.

O agravante é que a premissa "o que chega no reducer já passou pelo validador" é **falsa em quatro caminhos declarados na própria spec**:

1. **Race validação↔projeção (este achado).** §6.6 diz que o append **não** é atômico com a projeção, e §12.3 diz que o append é assíncrono em lote. Portanto o validador de §9.3 checa pré-condições ("nome único por `(comunidade,tipo)`", "não é o último canal não deletado", "sem thread ainda", "≤20 emojis distintos") contra uma projeção que ainda não viu as ops já aceitas e appendadas. A fila de uma via de §12.3 serializa o *processamento*, não a *visibilidade do efeito*.
2. **Registros pulados por versão/kind desconhecido** — ver F-07.
3. **Colisão de chave primária de 48 bits** — ver F-05.
4. **Renumeração densa de `position` contra índice UNIQUE não-diferível** — ver F-39.

**Cenário concreto (caminho 1)**
1. Rafael e Bianca, ambos com `manage_channels`, criam `#retro` no mesmo segundo.
2. As duas ops entram na fila de uma via do host (§12.3), na ordem A, B.
3. A é validada: `uniq_channels_name` livre na projeção. Aceita. `core.append(A)` é disparado — assíncrono.
4. B é validada **antes** de A ser projetada. A projeção ainda não tem `#retro`. B passa no estágio 12. `core.append(B)`.
5. O projetor lê o lote [A, B]. Aplica A: OK. Aplica B: `UNIQUE constraint failed: channels.community_id, channels.type, channels.name`. `better-sqlite3` lança.
6. Transação abortada → `projector.failed` → Vale do Código fica `degraded` **para os 340 membros**, porque o registro B está no log de todos.
7. Reiniciar reprojeta do 0 e falha no mesmo `seq`. Permanentemente.

**Consequência para o sistema**
Perda total e permanente de disponibilidade de uma comunidade, disparada por uma ação corriqueira e concorrente de dois moderadores. O texto de §12.1 — *"A afirmação central: com ADR-01, **não existe conflito de escrita**"* — é verdadeiro apenas para *ordem*, e falso para *pré-condições*. A ADR-01 resolve ordenação; ela não torna a validação serializável em relação aos appends que ela autoriza.

**Evidência necessária para confirmar ou refutar**
- Verificar se `communityHost` valida contra a projeção ou contra um estado em memória atualizado no ato do append. §3.2 lista as dependências de `communityHost` como `validator, corestore, rpcServer, presence, shareTree` — **não** inclui `storage` nem `projector`, ou seja, a spec nem sequer declara de onde vem o estado que o validador consome. Isso precisa ser fechado antes de qualquer implementação.
- Escrever um teste no harness de §21.2: duas instâncias submetendo `channel.create` com o mesmo nome dentro da mesma janela de lote, e assertar que exatamente uma recebe `E_CHANNEL_NAME_TAKEN` e que o projetor não entra em `degraded`. Esse caso **não está** entre os 10 cenários obrigatórios de §21.2.
- Definir e documentar a política de recuperação de `projector.failed` (hoje inexistente).

---

## F-05 — Ids de entidade truncados em 48 bits são chave primária, derivam de um nonce escolhido pelo autor, e a colisão para a projeção da comunidade para sempre

**Severidade:** CRITICAL
**Tipo:** RISCO (segurança + integridade)

**Localização exata**
- `backend.md` §4.7: `id | der | msg- + hex do opId **truncado em 12**`.
- `backend.md` §4.8: `thr- + 12 hex do opId`; §4.13: `mod- + hex do opId`.
- `backend.md` §6.3: `messages | id TEXT **PK**`; `threads | id TEXT **PK**`; `moderation_log | id TEXT **PK**`.
- `backend.md` §5.1: `Op` inclui `nonce: bytes[8]` — campo livre do autor.
- `backend.md` §5.2: `opId = BLAKE2b-256(envelope canônico)`.
- `backend.md` §6.1: *"um único `view.db` para todas as comunidades"* — o espaço de chave é global, não por comunidade.

**O que a especificação afirma**
Que o id é determinístico (reprojetar produz o mesmo id) e que isso é uma propriedade desejável. Não diz nada sobre colisão.

**Por que isso é potencialmente problemático**
12 caracteres hex = 48 bits. Como `id` é PRIMARY KEY num banco **compartilhado por todas as comunidades**, duas naturezas de falha coexistem:

- **Aniversário (acidental):** P(colisão) ≈ N²/2⁴⁹. Com N = 10⁶ mensagens totais no dispositivo, ≈ 0,18%. Com N = 10⁷, ≈ 18%. Não é hipotético para um usuário de longo prazo em 50 comunidades (o teto de §19.2).
- **Adversarial (dirigida):** o atacante controla `nonce` (8 bytes), `ts` e `content`. Ele não precisa acertar um alvo específico — basta colidir com **qualquer** das N mensagens existentes, o que divide o trabalho por N. Com N = 10⁵, o custo cai para ≈2,8×10⁹ tentativas. Cada tentativa custa uma assinatura Ed25519 (~20–50 µs) mais um BLAKE2b. Isso é da ordem de dezenas de horas em um núcleo, ou ~1 hora em uma máquina modesta com 16 núcleos. Não é barato, mas está muito longe de ser proibitivo para um ataque de negação de serviço permanente.

Em ambos os casos o efeito é o de F-04: o `INSERT` viola a PK, o reducer lança, `projector.failed`, comunidade `degraded` **em toda réplica**, e a reprojeção reproduz a falha.

**Cenário concreto**
1. Um membro descontente de Vale do Código, com apenas `send_messages`, coleta os ids das mensagens existentes do canal (todos estão na projeção local dele).
2. Ele roda um grinder local: varia o `nonce`, assina, calcula `opId`, compara os 12 primeiros hex contra a lista.
3. Encontrado o par, ele submete a mensagem. Ela passa nos 12 estágios de §9.1 — não há estágio que cheque colisão de id derivado, porque o id é `der` (derivado na projeção), não um campo da op.
4. O host appenda. O registro entra no log permanente e append-only (ADR-10 — **não pode ser removido**).
5. Toda réplica projeta até esse `seq` e para. Vale do Código morre para 340 pessoas.
6. Não há remediação: truncar o core é explicitamente proibido pela ADR-10 e detectável (§5.1); reprojetar reproduz a falha; e não existe mecanismo de quarentena de registro.

**Consequência para o sistema**
Um único membro pode destruir permanentemente uma comunidade inteira, sem nenhuma permissão privilegiada, sem que o modelo de ameaça de §18.1 preveja isso ("Membro comum malicioso — **Não consegue** … Escalar permissão; agir acima da hierarquia; forjar autoria" — nada sobre parar a projeção). §21.5 (Adversário) tem quatro cenários e nenhum cobre este.

**Evidência necessária para confirmar ou refutar**
- Medir o custo real do grinder: taxa de `sign + BLAKE2b` por segundo em hardware comum, e o tempo esperado para colidir contra um conjunto de N ids. Isso decide entre "risco de aniversário lento" (ainda CRITICAL pela irrecuperabilidade) e "ataque prático".
- Verificar se `better-sqlite3` de fato lança em violação de PK dentro de transação (lança) e se §6.4 realmente trata isso como "reducer que lança" (o texto não distingue exceção de SQLite de exceção de código).
- Escrever o caso adversarial em §21.5.

---

## F-06 — `member.join` não pode ser produzida por ninguém: o autor não é membro (estágio 7), o host não pode forjar a assinatura, e o payload não contém a identidade de quem entra

**Severidade:** CRITICAL
**Tipo:** CONTRADIÇÃO + INVIABILIDADE

**Localização exata**
- `backend.md` §9.1, estágio 7: *"Autor é membro ativo, não banido → `E_NOT_MEMBER` / `E_BANNED`"*. Sem exceções declaradas.
- `backend.md` §9.1, estágio 4: *"`op.author` == chave pública do peer da conexão → `E_AUTHOR_MISMATCH`"*.
- `backend.md` §5.3: `member.join | inviteCodeHash, displayName, avatarColor | — (autorizado pelo convite) | … | **Só o host appenda, no resgate (§11.4)**`.
- `backend.md` §10.6: `inviteRedeem | {challenge, proof, displayName, avatarColor}` — o candidato **não** envia envelope assinado.
- `backend.md` §5.1: *"o host … **não pode forjar** — a assinatura é do autor e toda réplica verifica"*.
- `backend.md` §6.4: *"**A assinatura é verificada em toda réplica, sempre.**"*
- `backend.md` §6.3: `members | … identity_key BLOB` — parte da PK, portanto obrigatória.

**O que a especificação afirma**
Que o host appenda `member.join` no resgate; que toda op é assinada pelo autor e verificada por toda réplica; e que o pipeline de 12 estágios roda em toda op.

**Por que isso é potencialmente problemático**
Só há duas possibilidades para `op.author` de `member.join`, e ambas são impossíveis:
- **`author` = o candidato.** Então a assinatura tem que ser do candidato, mas o `inviteRedeem` de §10.6 não transporta envelope assinado nenhum — e mesmo que transportasse, o estágio 7 rejeitaria com `E_NOT_MEMBER`, porque o candidato, por definição, ainda não é membro. Não há exceção declarada para `member.join` em §9.1.
- **`author` = o host.** A assinatura fecha, o estágio 7 passa (o host é membro). Mas então **a chave de identidade de quem entrou não existe em lugar nenhum da op** — o payload é `inviteCodeHash, displayName, avatarColor`. A projeção precisa preencher `members.identity_key`, e não tem de onde. Além disso, `identity.update` (§4.3, operações do Member) usa `op.author` para saber de quem é o nome — se o `member.join` tem autoria do host, o vínculo identidade↔membro nunca se estabelece.

O mesmo estágio 7 também rejeitaria o lote de bootstrap de §11.1 (`community.create`, `role.create`, `category.create` são appendadas antes do `member.join` do host, quando o autor ainda não é membro). §11.1 passo 6 diz que o host projeta "pelo caminho normal", mas **não diz** se o lote de bootstrap passa pelo pipeline de §9.1 — e §3.2 afirma que reducers não rejeitam porque "o que chega aqui já passou pelo `validator`".

**Cenário concreto**
Carlos resgata um convite válido de Vale do Código. O host de Rafael precisa appendar `member.join`. Se assina como Rafael, a projeção de todos os 340 membros recebe uma op cujo payload é `{codeHash, "Carlos", "role-blue"}` sem chave nenhuma — a linha em `members` não pode ser inserida (`identity_key` é parte da PK e é `NOT NULL` por construção). Se tenta assinar como Carlos, não tem a chave privada dele.

**Consequência para o sistema**
O único caminho de entrada do produto (premissa 2: "convite é a única porta") não tem contrato executável. A fase 4 inteira de §23 fica bloqueada. Como consequência secundária, o pipeline de §9.1 é declarado como aplicável a "toda op" sem que exista o conjunto de exceções que ele obrigatoriamente precisa ter (`member.join`, e as 6 ops do lote de bootstrap).

**Evidência necessária para confirmar ou refutar**
- Confirmar por leitura que §9.1 não tem exceção para `member.join` (não tem: o único texto de exceção do pipeline é o do estágio 8 para `member.leave`).
- Confirmar que o payload de `member.join` em §5.3 não carrega chave de identidade (não carrega).
- Definir o modelo: o mais provável é que o candidato assine um `member.join` com `author` = sua própria chave, e que o estágio 7 ganhe uma exceção explícita condicionada à prova de convite válida — o que precisa ser escrito, junto com a reordenação do pipeline (a prova precisa ser verificada **antes** do estágio 7).

---

# HIGH-RISK FINDINGS

---

## F-07 — O "leitor tolerante" de §5.2 e as invariantes de §4.18 se destroem mutuamente: uma réplica com versão antiga entra em `degraded` permanente

**Severidade:** HIGH
**Tipo:** CONTRADIÇÃO

**Localização** `backend.md` §5.2, regras 4 e 5; §4.18 (I-1 a I-10); §6.4 ("Reducer que lança").

**O que a spec afirma** Regra 4: *"`v` desconhecido na leitura → o registro é **contado no `seq`** e ignorado na projeção … **Nunca aborta a projeção:** um registro futuro não pode congelar a réplica de quem está atrás."* Regra 5 estende para `kind` desconhecido. §4.18: violação de invariante *"deve abortar a transação com `E_INVARIANT`"*.

**Por que é problemático** Ignorar um registro não é neutro: as invariantes são sobre o **grafo** projetado. Pular uma op de criação e aplicar as ops que dependem dela viola a invariante correspondente, e a violação faz exatamente o que a regra 4 jurou impedir — congela a réplica.

**Cenário concreto**
1. Host atualiza para `opVersion` 2 e appenda `channel.create` na `v` 2 (novo campo obrigatório de tipo alterado, o que §5.4 diz que exige bump).
2. Membro na `v` 1 pula o registro (regra 4), contando o `seq`.
3. Alguém posta em `#novo-canal`. `message.send` continua na `v` 1 e é decodificável.
4. O reducer de `message.send` insere a mensagem. A asserção I-6 ("Toda mensagem aponta para um canal de texto não deletado da mesma comunidade") falha.
5. `E_INVARIANT` → transação abortada → `projector.failed` → comunidade `degraded` **em todo cliente que não atualizou**. Reiniciar reprojeta e falha no mesmo ponto.

O modo somente-leitura de §10.6 (`E_VERSION_UNSUPPORTED`) não protege: ele impede **enviar** op, não impede **projetar** log incompatível.

**Consequência** Cada bump de `opVersion` transforma todo cliente desatualizado num tijolo para aquela comunidade, silenciosamente e sem caminho de recuperação. Isso inverte o objetivo declarado da regra 4.

**Tipo** CONTRADIÇÃO interna entre §5.2 e §4.18.

**Evidência necessária** Rodar o cenário 10 de §21.2 ("`opVersion` incompatível → cliente entra em somente-leitura") **estendido**: o host appenda uma op de estrutura em `v` nova e depois uma op dependente em `v` antiga; assertar o que acontece com a projeção do cliente antigo. O cenário atual de §21.2 só testa o lado do envio, que é o lado que funciona.

---

## F-08 — Qualidade escolhida por quem assiste é incompatível com um nó de repasse que não transcodifica

**Severidade:** HIGH
**Tipo:** CONTRADIÇÃO + INVIABILIDADE

**Localização** `backend.md` §10.8, tabela de parâmetros ("Bitrate default | 2 500 kbps (`high`) · 1 200 (`balanced`) · 600 (`low`) | **Escolhido por quem assiste**") e regra imediatamente acima ("o nó de repasse **copia o quadro inteiro para os filhos sem decodificar nem reencodar**. Ele não abre `payload`"); §10.2, `share.setQuality | {sessionId, quality} | ✕ (de quem assiste)`; §10.6, `shareStart | {channelId, **codecConfig**}` (singular); §11.17 passo 1 (um `VideoEncoder` no renderer do apresentador). `frontend.md` §9, 2.4 ("ajustar qualidade" como ação de espectador) e Parte 8 ("Qualidade é de quem assiste… Ajustar a própria recepção não afeta ninguém").

**O que a spec afirma** Que existe um único fluxo codificado, que nós de repasse encaminham bytes opacos, e que cada espectador escolhe seu bitrate.

**Por que é problemático** As três coisas não coexistem. Com um encoder e um `codecConfig`, existe **um** bitstream. Um nó que não abre o payload não pode servir a um filho um bitrate diferente do que recebe. Servir qualidades distintas exige simulcast (N encoders no apresentador) ou SVC (camadas), e nesse caso a árvore precisa ser por camada — nada disso está especificado, e `shareStart` transporta um `codecConfig` só.

**Cenário concreto** Rafael apresenta em `high` (2.500 kbps). Ana, na árvore em nível 2, é filha de Diego e escolhe `low` (600 kbps) porque está no 4G. `share.setQuality{low}` é aceito (§10.2 devolve `{}` sem erro). Diego, que recebe `high`, encaminha os mesmos bytes sem abrir. Ana continua recebendo 2.500 kbps. O comando não tem efeito nenhum e não há erro — a UI mostra "baixa" e a rede entrega "alta". Em modo estrela o mesmo problema existe, a menos que o apresentador rode três encoders, o que triplica o custo de CPU e não está no orçamento de §19.1.

**Consequência** Uma ação de UI implementada e verificada (`frontend.md` Parte 8) é inerte no backend, e a UI mente sobre o estado. Além disso, a decisão "não transcodificar" — que a ADR-05 chama de *"a diferença entre viável e inviável"* — é incompatível com um requisito de produto que a spec de UX trata como resolvido. **Este delta não está em §25.**

**Evidência necessária** Confirmar que WebCodecs `VideoEncoder` no renderer emite um único bitstream por instância (emite). Decidir entre: (a) qualidade vira propriedade do apresentador, e a UI perde o controle do espectador; (b) simulcast de 2–3 camadas com N árvores, com o custo medido antes da fase 7; (c) SVC temporal, que permitiria a um nó descartar camadas sem decodificar — a única opção que preserva a regra de opacidade, e que precisa de suporte confirmado no `VideoEncoder` do Chromium empacotado.

---

## F-09 — O RPC de convite não tem transporte: o canal é chaveado pelo `coreKey`, que o candidato só aprende ao terminar o resgate

**Severidade:** HIGH
**Tipo:** CONTRADIÇÃO

**Localização** `backend.md` §10.5 (*"um canal por comunidade, **chaveado pelo `coreKey`**"*); §10.6 (métodos `inviteResolve` e `inviteRedeem` na mesma tabela do canal `p2p-community/1`); §11.4 Resgatar passo 3 (*"Devolve `{seq, **coreKey**, blobsKey, defaultChannelId}`"*); §10.7 (o único outro canal é `p2p-ephemeral/1`, para presença/typing/sinalização/árvore).

**O que a spec afirma** Que existem exatamente dois canais protomux, ambos por comunidade, e que os métodos de convite vivem no canal chaveado por `coreKey`.

**Por que é problemático** O candidato conecta pelo tópico derivado do `codeHash` (§11.4) e, nesse momento, **não conhece o `coreKey`** — ele o recebe como resultado do `inviteRedeem`. Portanto não pode abrir o canal em que o `inviteRedeem` vive. É uma dependência circular no contrato de transporte.

**Cenário concreto** Carlos cola o código, o núcleo dele calcula `topic = BLAKE2b('invite-topic/1' ‖ codeHash)`, conecta ao host, e precisa chamar `inviteResolve`. Para isso precisa de um canal protomux. §10.5 só define canais chaveados por `coreKey`; §10.7 idem, na mesma conexão. Nenhum contrato cobre a conexão pré-membro.

**Consequência** A fase 4 de §23 não tem contrato de transporte. Também fica indefinido: qual é o timeout, qual é o limite de concorrência (§10.5 fala em 8 requests em voo "por peer" — por peer de qual canal?), e como se aplica o rate limit de `inviteResolve` "por IP de peer, pré-membro" (§19.3) num canal que não existe.

**Tipo** CONTRADIÇÃO / REQUISITO AUSENTE (falta um terceiro protocolo, ex.: `p2p-invite/1`, chaveado pelo `codeHash`).

**Evidência necessária** Ler §10.5–10.7 procurando qualquer canal chaveado por algo que o candidato conheça. Não existe. A correção é escrever o protocolo pré-membro, incluindo seu próprio orçamento de concorrência e a regra de fechamento de conexão por prova errada (§11.4 passo 4).

---

## F-10 — Os três pontos de enforcement de ban se contradizem: o firewall torna o preview `banned` inalcançável

**Severidade:** HIGH
**Tipo:** CONTRADIÇÃO

**Localização** `backend.md` §8.5 (firewall recusa a conexão de banidos); §3.2, módulo `swarm` (*"`firewall` recusa banidos **na conexão**"*); §4.12 (*"Ban é **aplicado em três pontos**: `firewall` … o RPC recusa a op, e o **preview de convite devolve `banned`**"*); §11.4 Resolver passo 5 (*"Candidato banido? → `banned`"*); §21.2 cenário 4 (*"Banido tenta reconectar → `firewall` recusa **antes do stream**"*). `frontend.md` 0.3 (estado "Banido desta comunidade", com layout próprio) e A2 (exceções).

**O que a spec afirma** Simultaneamente que a conexão de um banido é recusada antes do stream, e que um banido que resolve um convite recebe o desfecho `banned` com o nome da comunidade.

**Por que é problemático** Se o firewall recusa a conexão pela `remotePublicKey`, o handshake não completa e o `inviteResolve` nunca é chamado. O candidato banido recebe falha de conexão — que, pelo próprio catálogo de §16.2, é `E_HOST_UNAVAILABLE`/`E_SWARM_DEGRADED`, mapeando no desfecho `unreachable` (o desfecho novo de §25 delta 5). Ele nunca vê `banned`.

Existe uma segunda ambiguidade no mesmo texto: *"Recusa a conexão de quem está banido em **todas** as comunidades que o nó hospeda"* admite duas leituras opostas — "recusa se banido em qualquer uma" (superbloqueio: corta o acesso da pessoa a comunidades onde ela é membro legítimo, porque a conexão Hyperswarm é uma só e multiplexa tudo) ou "recusa só se banido em todas" (subbloqueio: o objetivo declarado de "não gastar CPU de validação com banido" não é atingido). A spec não fecha qual.

**Cenário concreto** Bianca é banida de Vale do Código (host: Rafael) e é membro ativa de Ateliê Aberto, que ela mesma hospeda. Alguém manda a ela um convite de Vale do Código. Ela cola. A tela 0.3 de `frontend.md`, implementada e verificada na Parte 2 com o desfecho "banido" alcançável, nunca é atingida — ela vê `unreachable` ("host offline"), o que é falso e enganoso.

**Consequência** Um estado de UI implementado, verificado e explicitamente desenhado para não vazar informação vira código morto; o usuário banido recebe um diagnóstico incorreto; e a regra do firewall permanece indefinida para o caso multi-comunidade, que é o caso normal de um host que hospeda mais de uma.

**Evidência necessária** Determinar se o `firewall` do Hyperswarm pode ser condicionado por tópico (pelo que a API expõe, ele decide por `remotePublicKey` **antes** de saber o tópico — o que confirmaria a contradição). Definir textualmente a precedência entre os três pontos e qual deles cede para tornar o preview `banned` alcançável.

---

## F-11 — A afirmação central de §9.2 ("cliente e host não podem divergir") é falsa: eles compartilham o módulo, não a configuração

**Severidade:** HIGH
**Tipo:** PREMISSA NÃO COMPROVADA / CONTRADIÇÃO

**Localização** `backend.md` §9.2, último parágrafo: *"As duas usam o **mesmo módulo** (`validator`, L1, puro), compilado nos dois lados — assim não podem divergir."* Contra §20 (*"Precedência: **variável de ambiente** > `config.json` em `userData` > default"*, resolvido por processo) e a própria tabela de §20, que torna configuráveis `P2P_ATTACHMENT_MAX_BYTES`, `P2P_CLOCK_TOLERANCE_MS`, `P2P_OUTBOX_MAX_ITEMS`, os `P2P_RATE_*` e (via §19.2) `INVITE_MAX_ACTIVE` — todos consumidos pelo validador.

**O que a spec afirma** Que a validação no cliente e no host é garantidamente idêntica por compartilharem o código.

**Por que é problemático** O validador é puro, mas seus limiares vêm de `config`, que é resolvido **localmente em cada instalação**, com precedência de variável de ambiente. Duas máquinas com envs diferentes rodam o mesmo código com constantes diferentes. Além disso, §20 estabelece a regra *"nenhum valor de negócio fica hard-coded fora desta tabela"* — ou seja, **todo** limite de negócio é, por construção, divergível entre nós.

**Cenário concreto** Ana roda com `P2P_ATTACHMENT_MAX_BYTES=17179869184` (16 GiB, dentro da faixa "≥ 1 MiB" declarada). Ela anexa um arquivo de 12 GiB. O validador local aceita. `blob.stage` sobe o arquivo. `message.send` chega no host de Rafael, que usa o default de 8 GiB, e é rejeitado com `E_ATTACHMENT_TOO_LARGE` — um erro **terminal** (§6.5), portanto `dropped`. O usuário gastou horas de upload para receber "Arquivo muito grande" **depois** do upload, exatamente o oposto do que §11.13 promete ("grande demais → `E_ATTACHMENT_TOO_LARGE` **antes de ler um byte**").

Um segundo cenário, mais grave: `P2P_CLOCK_TOLERANCE_MS` divergente faz o cliente e o host discordarem sobre `clockSkewed`, que é um bit do `LogRecord` (§5.1, `flags` bit 0) — o cliente prevê uma coisa e a projeção mostra outra.

**Consequência** A garantia que sustenta o desenho de dupla validação ("a validação do cliente é UX; a do host é verdade… não podem divergir") não existe. Todo limite configurável é uma fonte silenciosa de divergência cliente↔host, e nenhum deles é negociado no `hello` de §10.6 (que troca só `clientVersion`/`opVersion`).

**Evidência necessária** Listar quais campos de §20 participam do `validator`. Decidir: (a) limites de validação passam a ser **do host** e chegam ao cliente no `hello`; ou (b) tornam-se constantes de compilação, saindo de §20 — o que colide com a regra "nenhum valor de negócio hard-coded fora desta tabela".

---

## F-12 — Auto-save da UI + log append-only + rate limit de estrutura + ausência de fila: três telas de administração são inimplementáveis como especificadas

**Severidade:** HIGH
**Tipo:** CONTRADIÇÃO entre documentos (ausente de §25)

**Localização** `frontend.md` §13 (*"Formulários de **edição** (comunidade, cargo, canal) salvam automaticamente com debounce ~800ms, **sem botão 'Salvar'**"*), 3.1b (*"salvo automaticamente com toast 'Alterações salvas' (debounce ~800ms)"*), 3.2 e 3.4 (mesmo padrão). Contra `backend.md` §10.2 (`community.update`, `role.update`, `channel.update` são todos ⏱, síncronos, esperam o host); §11.5 (ops de estrutura **não** enfileiram, falham com `E_HOST_UNAVAILABLE`); §19.3 (*"Ops de estrutura (`channel.*`, `category.*`, `role.*`) | 20 / 60 s | burst 30"*); ADR-10 (nada é removido do log).

**O que a spec afirma** UX: editar é auto-save contínuo, sem confirmação, "consistente com a natureza local-first (não há 'enviar pro servidor')". Backend: cada edição é uma op assinada, appendada para sempre num log replicado a todos, sujeita a rate limit e falha dura se o host estiver offline.

**Por que é problemático** A premissa da UX ("não há enviar pro servidor") é **exatamente falsa** sob a ADR-01: o host *é* a autoridade de escrita, e cada auto-save é um round-trip de rede que pode falhar. Três consequências acumulam:
1. **Rate limit.** Um debounce de 800 ms durante a digitação de uma descrição de 120 caracteres produz facilmente 10–20 ops. `role.update` cai no bucket de estrutura (20/60 s, burst 30). Editar dois cargos seguidos estoura. A UI então mostra "Alterações salvas" ou um erro de rede num formulário onde §12 da UX proíbe erro de rede virar erro de formulário (`spec:1023`).
2. **Log permanente.** Cada salvamento intermediário é um registro imutável replicado a 340 pessoas. Renomear um canal por tentativa e erro deixa 15 registros permanentes e 15 entradas potenciais de auditoria.
3. **Host offline.** `frontend.md` §18 (`spec:1134`) já resolve o caso do canal ("o debounce descarta o salvamento e o campo volta ao último valor confirmado"), mas **não** o de comunidade nem o de cargo, e §25 delta 12 fala de fila, não de auto-save.

**Cenário concreto** Rafael abre 3.2, seleciona "Moderador" e marca/desmarca 6 checkboxes de permissão enquanto pensa. Isso são até 6 ops `role.update` em ~10 s, cada uma alterando permissões de moderação de toda a comunidade e cada uma gerando um estado intermediário replicado (ex.: um instante em que Moderador tem `ban_members` mas perdeu `kick_members`). Membros conectados projetam cada estado intermediário; o cache de permissões efetivas de §19.4 é invalidado 6 vezes; e a 7ª interação recebe `E_RATE_LIMITED`.

**Consequência** O padrão de interação principal de 3.1b, 3.2 e 3.4 — declarado implementado e verificado nas Partes 9 e 10 — não sobrevive ao backend real. §25 lista 12 deltas obrigatórios na spec de UX e **nenhum deles é este**, apesar de ser o mais caro dos deltas de UI.

**Evidência necessária** Contar quantas ops um preenchimento típico de cada formulário de edição gera; comparar com os buckets de §19.3. Decidir se edição volta a ter botão "Salvar" (contrariando §13 da UX) ou se o núcleo passa a coalescer edições numa janela (o que exige uma regra nova, porque §12.4 proíbe reentrância e o `outbox` não aceita ops de estrutura).

---

## F-13 — O fan-out de presença e digitando não tem política especificada e, na leitura natural, é inviável na escala de referência declarada

**Severidade:** HIGH
**Tipo:** RISCO de escalabilidade / REQUISITO AUSENTE

**Localização** `backend.md` §4.16 (`Presence | TTL 30 s, refresh a cada 10 s | Fan-out: **host agrega e reemite**`; `Typing | 5 s, refresh 3 s | host agrega por canal`); §10.7 (mesmo); §13.1 (`presence.refresh | 10 s`); §13.5 (núcleo single-threaded, RPC de entrada é prioridade 1); §19.2 (*"**Escala de referência:** a comunidade do dataset tem 340 membros"*); ADR-14 (*"ordem total não tem valor nenhum para dado com TTL de 5s"* — argumenta o custo do log, não o custo do fan-out).

**O que a spec afirma** Que o host agrega presença e a reemite, sem definir período de agregação, debounce, coalescência ou tamanho de lote.

**Por que é problemático** Na leitura direta, 340 membros publicando a cada 10 s produzem ~34 publicações/s de entrada; se o host reemite o agregado a cada mudança para os 340, são ~11.560 mensagens/s de saída, num processo Node single-threaded que também precisa validar ops (prioridade 1), projetar, rodar a outbox, o watchdog da árvore a cada 2 s e os jobs. Digitando compõe: um canal com 20 pessoas digitando (refresh a cada 3 s) adiciona ~6,7 eventos/s × 340 destinatários ≈ 2.267 msgs/s. Nada em §19.1 (alvos), §19.2 (limites) ou §17.3 (métricas) mede ou limita isso — não existe métrica `presence.fanout` nem limite `P2P_PRESENCE_*` em §20.

**Cenário concreto** Vale do Código com 340 membros conectados, meio-dia. O host de Rafael é um laptop. `submitOp` tem alvo de p95 < 60 ms em LAN (§19.1) e teto de 250 ms; o event loop está consumido reemitindo presença. A degradação aparece como latência de envio de mensagem, não como um erro nomeado, e nenhum estado de UI cobre "o host está saturado" (a tabela de §12 da UX tem `conn-offline`, `conn-reconnecting`, `conn-degraded`, `conn-failed` — nenhum é "host lento").

**Consequência** O gargalo que §19.2 admite ("o gargalo é o **fan-out de conexões** no host, não o log") é reconhecido mas subdimensionado: o fan-out de *mensagens efêmeras* não é mencionado em nenhum lugar, e é uma ordem de grandeza maior que o de conexões.

**Evidência necessária** Medir na fase 3 com 100+ membros simulados (A-2 já prevê isso, mas para *conexões*): mensagens efêmeras/s emitidas pelo host, ocupação do event loop, e efeito no p95 de `submitOp`. Especificar período de agregação e política de coalescência antes de implementar `presence`.

---

## F-14 — O teto de 128 conexões é menor que a comunidade de referência, é compartilhado entre 50 comunidades, e o comportamento de estouro não tem erro, estado nem UI

**Severidade:** HIGH
**Tipo:** RISCO + REQUISITO AUSENTE

**Localização** `backend.md` §19.2 (*"Conexões simultâneas no swarm | **128** | Novas ficam na fila do Hyperswarm"*; *"Comunidades participadas | 50"*); §3.2, módulo `swarm` (*"**Um** `Hyperswarm` para o processo"*); ADR-16 (*"Toda comunidade participada replica em background"*); §6.2 (`swarm.join(coreKey)` **e** `swarm.join(blobsKey)`, feitos juntos); §20 (`P2P_MAX_CONNECTIONS | 128 | 8–512`).

**O que a spec afirma** Um único Hyperswarm por processo, 128 conexões, join de dois tópicos por comunidade, todas as comunidades participadas no swarm, teto de 50 comunidades, e "novas ficam na fila" ao estourar.

**Por que é problemático** Três problemas empilhados:
1. **O host não cabe na própria comunidade de referência.** 340 membros, 128 conexões. O membro 129 fica numa fila sem timeout, sem posição, sem erro e sem estado de UI. Não há código em §16.2 para isso, e a UI não tem como distinguir "estou na fila do host" de "host offline" — o que é exatamente a distinção que o princípio 2 da UX ("saúde da conexão é informação de primeira classe") exige.
2. **Não há política de alocação.** As 128 conexões são compartilhadas entre até 100 tópicos (50 comunidades × 2 cores) mais as conexões diretas por chave para sinalização WebRTC (§10.7, "cada par abre uma conexão direta pelo `hyperdht`") mais os relays. Nada reserva conexões para a comunidade ativa, para as obrigações de host, ou para uma chamada de voz em curso.
3. **A conexão de voz compete com a replicação.** Entrar numa chamada com 6 participantes abre até 5 conexões diretas adicionais, potencialmente expulsando/adiando replicação de outras comunidades — o que quebra o `UNR-02` que a ADR-16 existe para viabilizar.

**Cenário concreto** Ana participa de 12 comunidades, hospeda 2, e entra numa chamada de voz de 5 pessoas. As 12 comunidades × 2 tópicos já saturam boa parte do orçamento; a chamada adiciona conexões diretas; o traço de não-lida no rail de 3 comunidades para de atualizar sem nenhum sinal, porque a replicação de background não conseguiu conexão. A UI mostra "0 não lidas" — indistinguível de "nada aconteceu".

**Consequência** Um limite arbitrário (128) sem justificativa registrada, aplicado a uma escala de referência de 340, com comportamento de estouro indefinido, degradando silenciosamente uma funcionalidade que tem ADR própria.

**Evidência necessária** §19.2 já promete *"Medir na fase 3 e recalibrar o limite de 128 com dado real"* — mas o que precisa ser medido primeiro é a **política**, não o número. Definir: prioridade por comunidade ativa, reserva para obrigações de host, e um estado nomeado (com código de erro e token de UI) para "o host atingiu a capacidade de conexões".

---

## F-15 — Reações, edições, fixar e criar thread são RPCs síncronos que falham com host offline, contra uma UI que promete comportamento otimista — e §25 não registra o delta

**Severidade:** HIGH
**Tipo:** CONTRADIÇÃO entre documentos

**Localização** `backend.md` §10.2, bloco Mensagens: `message.edit ⏱`, `message.delete ⏱`, `message.pin ⏱`, `message.react ⏱`, `thread.create ⏱` — todos síncronos, timeout de 30.000 ms. Apenas `message.send` é assíncrono (*"É o **único** comando de escrita que não espera o host"*). §11.5: só mensagem enfileira. §25 delta 12: *"Ops de estrutura não entram na fila offline … **Só mensagem enfileira**"* — o delta é escrito sobre canal/cargo/categoria/moderação, e não menciona reação/edição/pin/thread. Contra `frontend.md` §17 (*"Reagir a mensagem | Emoji 'salta' (scale 1→1.2→1) ao ser adicionado"*), 2.1 (toolbar de hover), Parte 5 ("chip … indo a 3 destacado ao clicar e voltando ao clicar de novo") e §18 (a lista de edge cases **não** tem "reagir com host offline").

**O que a spec afirma** Backend: essas cinco ações bloqueiam por até 30 s e falham com `E_HOST_UNAVAILABLE` quando o host está fora. UX: são microinterações instantâneas com feedback de animação, sem estado de rede.

**Por que é problemático** O modo cache offline da UX (B4) é desenhado inteiramente em torno de "ler funciona, escrever mensagem enfileira". Ele não prevê que **reagir a uma mensagem** — a ação de escrita mais leve e frequente do produto — simplesmente não funcione. Em Ateliê Aberto (host offline por design no dataset), a UI atual permite reagir, e o chip anima. Com backend real, o clique gera um spinner de até 30 s e depois um erro.

**Cenário concreto** Ana abre Ateliê Aberto (host offline). Ela lê o histórico normalmente (correto, §11.5 passo 2). Clica no 👍 de uma mensagem. Pela §10.2, `message.react` é ⏱: o núcleo tenta o RPC, espera 30 s, devolve `E_HOST_UNAVAILABLE`. A UI, que já tinha animado o chip, tem que reverter. Não há estado desenhado para "reação pendente" (§6 da UX lista os estados da linha de mensagem: enviando, falha, pendente offline, editada, destacada — nenhum se aplica a um chip de reação).

**Consequência** Um buraco de UX inteiro (o comportamento de todas as ações de mensagem que não são "enviar" no modo cache) que nenhum dos dois documentos cobre, e que §25 — a lista dos deltas obrigatórios — omite.

**Evidência necessária** Percorrer as ações de 2.1 uma a uma contra a tabela de §10.2 marcando quais são ⏱, e confrontar com a tabela de estados de §12 da UX. Decidir se reação/edição/pin entram na outbox (o que exige estado de UI novo) ou se ficam bloqueadas com aviso (o que exige texto novo em 2.1).

---

## F-16 — `query.outbox` não tem contrato de dados; a UI não consegue redesenhar mensagens pendentes depois de reabrir o app, que é a promessa da premissa 5

**Severidade:** HIGH
**Tipo:** REQUISITO AUSENTE (dado que a UI precisa e o backend não produz)

**Localização** `backend.md` §10.4: `query.outbox | {communityId?} | **Itens pendentes/falhos com motivo**` — resposta sem lista de campos, ao contrário de todas as outras queries da tabela. §6.5, tabela `local_outbox`: as colunas são `id, community_id, channel_id, kind, **envelope (BLOB)**, created_at, attempts, next_attempt_at, state, last_error, dropped_reason` — o conteúdo da mensagem existe **apenas** dentro do envelope binário. §2.4, regra 1: *"O renderer **nunca** toca disco nem rede"*; regra 4: *"Nenhum estado de domínio vive no renderer"*. Contra `frontend.md` premissa 5 e B4: *"Ana fecha e reabre o app com mensagens ainda pendentes → a fila é durável: **as mensagens reaparecem no canal com o mesmo ícone de relógio, na posição cronológica em que foram escritas**"*.

**O que a spec afirma** Que a fila é durável e que, ao reabrir, as mensagens pendentes reaparecem **no canal, com conteúdo, na posição cronológica**. E que o renderer não guarda estado de domínio.

**Por que é problemático** Depois de reiniciar, o renderer não tem mais nada em memória. A única fonte possível para o texto da mensagem pendente é `query.outbox`. Mas a resposta especificada é "itens pendentes/falhos com motivo" — sem `content`, sem `authorTs` (necessário para a posição cronológica), sem `channelId` explícito no contrato, sem `mentions`, `replyToId`, `threadId` ou `attachment`. O dado existe no `envelope`, mas decodificá-lo é trabalho do `opCodec` (L1, no núcleo), e o renderer não pode fazê-lo (regra de fronteira 1 e 4 de §2.4).

**Cenário concreto** Ana escreve três mensagens em Ateliê Aberto com o host offline, fecha o app, reabre. §11.5 garante que `local_outbox` sobreviveu. O renderer chama `query.messages` (não retorna nada pendente — a projeção não as tem) e `query.outbox` (retorna, digamos, `[{opId, state, kind, lastError}]`). Com isso a UI consegue exibir "3 mensagens aguardando envio" no banner, mas **não consegue redesenhar as três mensagens no canal**, que é literalmente o que a premissa 5 e o fluxo B4 prometem, e o que a Parte 11 declara implementado e verificado ("a fila offline aparecendo no banner e **sobrevivendo ao reload**").

**Consequência** A promessa de produto mais defendida da spec de UX (*"Uma fila que evapora ao reabrir transformaria 'será enviada quando o host voltar' em mentira"*) não é cumprível com o contrato de leitura especificado.

**Evidência necessária** Escrever o schema de resposta de `query.outbox` com os campos que 2.1 precisa para renderizar uma linha de mensagem. Alternativamente, denormalizar `content`/`author_ts`/`reply_to_id` como colunas em `local_outbox` — o que precisa ser decidido, porque hoje o envelope é a única cópia.

---

## F-17 — O backpressure de IPC descarta eventos que não são "sinal para reconsultar", deixando estados sem resolução

**Severidade:** HIGH
**Tipo:** CONTRADIÇÃO

**Localização** `backend.md` §10.1, Backpressure: *"o núcleo **para de emitir eventos** de um `topic` se houver mais de `IPC_EVENT_HIGHWATER` (default 1000) quadros não drenados, emite `ipc.dropped` … e o renderer **refaz a query correspondente**"*, seguido do princípio: *"eventos carregam **o que mudou**, não **o novo estado**. O renderer reconsulta. Isso elimina toda uma classe de bug de sincronização e é o que permite que a UI sobreviva a evento perdido"*. Contra a tabela de §10.3, que contém `voice.signal | {peerKey, sdp?, ice?}`, `share.assignment | {sessionId, parentKey, childKeys[], level}` e `message.accepted | {opId, messageId, seq, channelId}`.

**O que a spec afirma** Que todo evento é redundante com uma query, e que perder evento nunca produz estado errado.

**Por que é problemático** Três eventos violam o princípio:
- **`voice.signal`** carrega SDP/ICE. Não existe `query.signal`. Um SDP perdido não é reconsultável — ele é a negociação. Perder um trava aquele par para sempre, sem erro.
- **`share.assignment`** é um **comando** (a atribuição de pai na árvore), não um sinal. Não há query correspondente. Perdê-lo deixa um nó órfão sem que ele saiba; o watchdog do host (§13.1) só detecta ausência de heartbeat do *filho*, não a não-entrega da atribuição.
- **`message.accepted`** é o único caminho pelo qual a mensagem otimista sai do estado "enviando". Perdê-lo é irrecuperável por query: `query.outbox` retorna apenas "pendentes/falhos", e o item aceito **já foi removido da outbox** (§11.3 passo 6). Não há query "o que aconteceu com o `opId` X".

**Cenário concreto** Um flush de outbox após 3 h offline entrega 400 mensagens. A projeção emite `messages.appended` em lote e o núcleo emite 400 `message.accepted`. Se o renderer estiver travado (render pesado, aba em background), o highwater de 1000 quadros é atingido. O núcleo para de emitir e manda `ipc.dropped{topic:"message.accepted", count:N}`. O renderer "refaz a query correspondente" — mas não existe. As N mensagens ficam para sempre em opacidade reduzida ("enviando") na UI, embora estejam entregues.

**Consequência** O princípio arquitetural mais bem defendido de §10.1 não vale para três dos eventos mais críticos, e o texto não sinaliza a exceção. A consequência prática é estado de UI permanentemente errado após qualquer episódio de backpressure — que é justamente o cenário de reconexão em massa que ADR-11 e §11.5 existem para tratar.

**Evidência necessária** Classificar cada linha de §10.3 em "sinal (reconsultável)" vs "entrega (não-reconsultável)" e definir política separada para a segunda classe: fila garantida sem descarte, ou confirmação por sequência com retransmissão.

---

## F-18 — "Espectador é participante do canal de voz" é tratada como decisão fechada em §11.17 e como questão aberta em §25; a UI implementada assume o oposto

**Severidade:** HIGH
**Tipo:** CONTRADIÇÃO / decisão ausente apresentada como fechada

**Localização** `backend.md` §11.17, Regras: *"o espectador é **participante do canal de voz** (premissa 5 do backend); **não existe audiência fora da chamada**"*. Contra §25, delta 8: *"A fixture tem 7 espectadores num canal de voz com 3 participantes. Espectador é participante do canal; a fixture precisa ser corrigida **ou o modelo de audiência precisa existir**"*. Contra `frontend.md` §2 (dataset: `Sala de Estudos` com 3 participantes; compartilhamento de Rafael com 7 espectadores), 2.4.2 (a aritmética do painel: 2+3+2 = 7) e a Parte 8, Observações: *"**Espectador de compartilhamento não é o mesmo que participante da chamada.** §2 já documenta isso"* — comportamento implementado e verificado em 136 checagens.

**O que a spec afirma** Duas coisas incompatíveis, no mesmo documento: que a questão está fechada (§11.17) e que ela tem duas saídas possíveis (§25 delta 8). Além disso, cita uma "premissa 5 do backend" que **não existe** — o backend não tem seção de premissas numeradas; as premissas 1–11 são de `frontend.md` §0, e a de número 5 é sobre fila offline, nada a ver com audiência.

**Por que é problemático** §11.17.1 (o algoritmo da árvore, declarado "fechado") opera sobre um conjunto de "candidatos a repasse" e "viewers" cuja população **não está definida**. Se espectador = participante de voz, então: (a) assistir exige `voice_speak`, permissão que não tem relação semântica com assistir e que não é mencionada em nenhum lugar da UX; (b) o teto de 200 espectadores por sessão (§19.2) colide com a natureza de uma chamada; (c) o `voiceCoordinator` passa a ser o autorizador de audiência, papel que §3.2 não lhe dá. Se espectador ≠ participante, então falta inteiramente o modelo de audiência: quem entra, com que permissão, como o roster é mantido, e qual op/RPC governa.

**Cenário concreto** Fase 7. O implementador lê §11.17 ("decisão fechada") e exige `voice_speak` + presença no roster de voz para `shareJoin`. Roda a paridade de fixtures de §21.7 com o dataset de §2 e o cenário `TELA-04` falha, porque o dataset tem 7 espectadores e 3 participantes. §21.7 diz: *"Se um fluxo precisa de estado que o backend não produz, é buraco de **backend**"* — ou seja, a própria estratégia de teste declara este achado como buraco de backend.

**Consequência** A fase mais cara e mais arriscada do plano (§23: *"A fase 7 é a mais cara, a mais arriscada"*) começa com sua entidade central sem definição, e com dois trechos do mesmo documento em desacordo.

**Evidência necessária** Fechar a decisão explicitamente. Se for "audiência existe", especificar: permissão de assistir, ciclo de vida do roster de audiência, e o efeito no `E_SESSION_FULL`/`E_BUSY`. Se for "espectador = participante", corrigir a fixture de §2 e registrar a exigência de `voice_speak` para assistir na spec de UX.

---

## F-19 — A premissa da ADR-06 é provavelmente incorreta: o endereço público conhecido pelo `hyperdht` não é um candidato ICE válido para os sockets do renderer

**Severidade:** HIGH
**Tipo:** PREMISSA NÃO COMPROVADA

**Localização** `backend.md` ADR-06 (§1): *"O núcleo já conhece o endereço público do nó pelo `hyperdht`; **injeta-o como candidato ICE**. … O DHT faz **a mesma descoberta de endereço** que o STUN faria."* Combinado com §2.1 (o WebRTC vive no **renderer**; o `hyperdht`/UDX vive no **núcleo**, processos distintos) e §11.16 passo 4 (*"`RTCPeerConnection` por par, com os candidatos ICE derivados do endereço público que o `hyperdht` já conhece"*).

**O que a spec afirma** Que o STUN é dispensável porque o DHT já descobre o endereço público, e que esse endereço pode ser injetado como candidato ICE.

**Por que é problemático** O que o STUN entrega não é "o IP público do host", é o **mapeamento NAT (IP:porta) de um socket local específico**. O endereço que o `hyperdht` conhece é o mapeamento do socket UDX aberto pelo **processo núcleo**. O `RTCPeerConnection` roda no **processo renderer** e abre seus próprios sockets, com portas próprias e mapeamentos NAT próprios. Injetar o par (IP, porta) do núcleo como candidato srflx do renderer só funciona em NAT full-cone / endpoint-independent com preservação de porta — precisamente a classe de NAT em que o furo já funcionaria sem ajuda. Nas classes que importam (port-restricted, symmetric), o candidato é inválido. Na melhor das hipóteses o **IP** é reutilizável; a porta não é, e ICE candidata pares, não IPs.

**Cenário concreto** Ana está atrás de um NAT simétrico. O núcleo abriu o socket UDX e o DHT informa `203.0.113.7:41999`. O renderer cria o `RTCPeerConnection`, que abre uma porta local diferente; o NAT cria um mapeamento diferente, digamos `203.0.113.7:52310`, e — por ser simétrico — um mapeamento distinto por destino. O candidato injetado (`203.0.113.7:41999`) aponta para o socket do núcleo, que não é o que o WebRTC está escutando. O par de Ana falha no ICE e cai para o fallback UDX (ADR-07), que por sua vez tem o problema de F-20. Com STUN desligado por default (ADR-06), Ana não tem candidato srflx válido nenhum.

**Consequência** A justificativa de privacidade da ADR-06 (não vazar IP para terceiro) é legítima, mas o mecanismo substituto proposto provavelmente não substitui nada — o que empurra uma fração desconhecida (e possivelmente grande) das chamadas para o caminho de fallback UDX, que é o caminho não especificado. Isso interage diretamente com o risco já declarado em §24 (*"'95 % de conexão direta' é otimista"*) e com A-1.

**Evidência necessária** Experimento direto na fase 6, em pelo menos NAT port-restricted e symmetric: (1) comparar o mapeamento observado pelo `hyperdht` para o socket do núcleo com o mapeamento observado por um STUN para um socket criado pelo renderer; (2) medir a taxa de sucesso de ICE usando apenas o candidato derivado do DHT. Se a taxa for baixa, a ADR-06 precisa ser reaberta (por exemplo, o núcleo passa a fazer *ele mesmo* a descoberta de mapeamento para a porta que o renderer vai usar, via ICE-lite próprio, o que é um projeto muito maior do que "injetar um candidato").

---

## F-20 — A ADR-07 (fallback de voz por UDX) anula a justificativa inteira da ADR-05 e não tem caminho de mídia especificado

**Severidade:** HIGH
**Tipo:** CONTRADIÇÃO + REQUISITO AUSENTE

**Localização** `backend.md` ADR-05: *"WebRTC entrega **AEC, jitter buffer, FEC e controle de congestionamento** prontos — reconstruir isso é onde projetos de tempo real morrem."* ADR-07: *"Quando o ICE falha, **a voz cai para o mesmo transporte UDX** que já carrega dados e tela."* §11.16 passo 5: *"Falha de ICE num par → só aquele par cai para transporte UDX (ADR-07); `voice.meshChanged{peerKey, status:"degraded"}`"*.

**O que a spec afirma** Que a voz usa WebRTC pelas garantias de tempo real, e que quando o ICE falha ela usa UDX.

**Por que é problemático** O `RTCPeerConnection` do Chromium não aceita transporte externo. "Cair para UDX" significa **sair do WebRTC**: capturar áreas com `getUserMedia`, codificar com `AudioEncoder` (WebCodecs), transportar em UDX, e reconstruir do zero jitter buffer, PLC, FEC e controle de congestionamento — exatamente as quatro coisas que a ADR-05 diz que matam projetos de tempo real. Nada disso está especificado: §10.8 define o quadro de mídia **de tela** (com `EncodedVideoChunk`), e não existe equivalente para áudio.

Há ainda um efeito de segunda ordem: o **AEC do Chromium é global à captura**, referenciado contra o áudio renderizado pela pilha WebRTC. Numa chamada mista (3 pares por WebRTC, 1 por UDX), o áudio do par UDX não passa pelo renderizador do WebRTC e portanto **não entra na referência do cancelador de eco**. O resultado é eco audível do participante degradado para todos os outros — um sintoma que a UI classificaria como "problema do microfone de alguém", não como consequência de topologia.

**Cenário concreto** Bianca está atrás de CGNAT. Seu par com Ana falha no ICE. O sistema emite `voice.meshChanged{status:"degraded"}` e a UI mostra "Conexão instável com Bianca Souza" — que é o estado desenhado. Mas não existe implementação especificada por trás: nenhum formato de quadro de áudio, nenhum jitter buffer, nenhuma política de perda. E se implementado ingenuamente, Ana passa a ouvir o próprio eco através de Bianca.

**Consequência** O estado `conn-degraded` da voz — que a UX trata como "não é erro, é modo alternativo" (§5.4) — corresponde a um caminho de código inexistente e de custo comparável ao de escrever meia pilha de RTC. A ADR-05 escolheu WebRTC precisamente para não fazer isso; a ADR-07 obriga a fazer.

**Evidência necessária** Verificar se existe caminho suportado para alimentar o `RTCPeerConnection` do Chromium com um transporte customizado (não existe; a alternativa mais próxima seria um TURN local em `localhost` falando UDX para fora — o que precisa ser avaliado explicitamente, e que §18.3 hoje proíbe: *"O núcleo **não escuta em nenhuma porta TCP/HTTP local**"*). Especificar o protocolo de áudio de fallback com a mesma profundidade de §10.8, ou reabrir a ADR-07.

---

## F-21 — A UI de 3.1b lista o código de todos os convites ativos; o backend só consegue produzi-lo para os que a identidade local criou

**Severidade:** HIGH
**Tipo:** CONTRADIÇÃO entre documentos (ausente de §25) — dado que a UI precisa e o backend não produz

**Localização** `frontend.md` 3.1b: *"lista de convites ativos (**código**, criado por, usos, expiração, botão 'Revogar' por linha)"*; Parte 9: *"lista de convites ativos com quem criou, usos e expiração, **copiar link**, revogar e criar novo"* — declarado implementado e verificado. Contra `backend.md` §10.4: `query.invites | {communityId} | Convites ativos; **`code` só nos que a identidade local criou**`; §4.11 (`secret` é `local`, só na réplica de quem criou); §10.2 (`invite.create` devolve `code` — *"**`code` só aqui, e só para quem criou**"*).

**O que a spec afirma** UX: a tabela de convites mostra o código de cada linha, com ação de copiar. Backend: o código é irrecuperável para convites criados por outra pessoa, por construção criptográfica (só o hash está no log).

**Por que é problemático** É um dado que a UI exibe e que o backend é **estruturalmente incapaz** de fornecer — não é uma lacuna de implementação, é uma consequência direta da decisão (correta) de não colocar o segredo no log. O host tem `codeHash`, e nenhuma quantidade de engenharia recupera 80 bits de segredo a partir de um BLAKE2b.

**Cenário concreto** Rafael (host) abre 3.1b em Vale do Código. A comunidade tem 4 convites ativos: 2 criados por ele, 2 criados por Bianca (Moderadora com `create_invite`). A tabela precisa de 4 códigos. O backend pode entregar 2. As outras 2 linhas ficam com "—" ou com o `codeHash` truncado, nenhum dos quais está especificado em lugar nenhum, e nenhum dos quais é copiável/compartilhável. O botão "copiar link" fica inerte em metade das linhas, sem estado desenhado.

**Consequência** Uma tela de administração implementada exibe uma coluna sem fonte. Além disso, isso amplifica F-02: mesmo que o problema da verificação da prova fosse resolvido, o host continuaria sem poder re-exibir ou compartilhar convites que não criou, o que torna a delegação de convites parcialmente inútil na prática. **§25 não registra este delta.**

**Evidência necessária** Confirmar em §10.4 que a restrição é explícita (é). Definir o que a UI mostra na linha sem código — e registrar como delta obrigatório em §25, junto do texto de 3.1b.

---

## F-22 — ADR-03 e ADR-04 são condicionais ao spike da fase 0, e o plano B da ADR-04 invalida silenciosamente a ADR-03 e o desenho síncrono do projetor

**Severidade:** HIGH
**Tipo:** PREMISSA NÃO COMPROVADA / RISCO subdimensionado

**Localização** `backend.md` §1, cabeçalho: *"Cada linha é uma decisão **fechada**."* §0.3/§0: *"Onde houver mais de uma solução tecnicamente válida, a escolha está feita."* Contra §23, fase 0: *"**Decide `utilityProcess` vs `bare-sidecar` e confirma ADR-03.** **Nada mais começa antes disto.**"* ADR-04: *"`bare-sidecar` … fica como plano B se o spike da fase 0 falhar — custa um segundo runtime no build."* ADR-03: *"É **N-API**, então o `.node` é ABI-estável **entre Node e Electron**."* §24, primeira linha de risco: probabilidade **Média**, impacto **Alto**.

**O que a spec afirma** Que as ADRs são decisões fechadas; e, em outro lugar, que duas delas ainda serão decididas/confirmadas por um spike; e que o custo do plano B é "um segundo runtime no build".

**Por que é problemático** O custo do plano B está subestimado por, no mínimo, uma ordem de grandeza. `bare-sidecar` não é Node: a ADR-03 escolheu `better-sqlite3` justificando-se em N-API e ABI-estabilidade **entre Node e Electron** — garantia que não se estende a Bare. Se o spike escolher Bare, cai junto:
- a ADR-03 inteira (é preciso um SQLite para Bare, e nenhum candidato está nomeado);
- a premissa do projetor de §6.4/ADR-03 (*"API **síncrona**, que é exatamente o que o projetor precisa: uma transação por lote, **sem interleaving assíncrono e sem risco de reentrância**"*) — se o driver alternativo for assíncrono, §6.4, §12.4 e §10.4 (*"queries são **síncronas do ponto de vista do núcleo**"*) precisam ser reescritos;
- a afirmação de §2.1/ADR-04 (*"Mantém **uma toolchain só** (Node + TypeScript no projeto inteiro)"*).

Além disso, "o `.node` é ABI-estável entre Node e Electron" é verdadeiro para N-API, mas o `utilityProcess` do Electron ainda precisa carregar `rocksdb-native`, `sodium-native` e `udx-native` **empacotados e dentro/fora do asar** — que é o próprio risco listado em §24 com mitigação `asarUnpack`. O spike é necessário; o problema é o documento tratar como fechado o que ele mesmo condiciona.

**Cenário concreto** O spike falha em Windows (o cenário de probabilidade "Média"). A equipe adota `bare-sidecar`. Descobre que não há `better-sqlite3` para Bare. Precisa escolher outro driver, provavelmente assíncrono. §6.4 ("uma transação por lote, síncrona"), §12.4 ("o `projector` **nunca** é reentrante"), §10.4 ("respondem em < 5 ms") e §19.1 (alvos de query) passam a ser não-verdades. O que era "custa um segundo runtime no build" vira uma reescrita da camada de persistência, ou seja, das seções §6, §10.4, §12 e §19 — depois de a fase 0 ter consumido o tempo do spike.

**Consequência** O gatilho de replanejamento de §24 ("Spike falha em qualquer um dos 3 SOs") aponta para uma mitigação que não é drop-in. O risco de cronograma está registrado com o impacto errado.

**Evidência necessária** Antes ou durante o spike: identificar e nomear o driver SQLite do caminho Bare, e confirmar se ele é síncrono. Se não houver candidato síncrono, o plano B precisa ser reclassificado de "mitigação" para "replanejamento", e as seções dependentes precisam de uma variante escrita.

---

# MEDIUM / LOW FINDINGS

Formato compacto; os nove campos estão presentes, condensados.

---

## F-23 — MEDIUM — O catálogo de ops tem 34 `kind`s, não 29, e o número errado é requisito de teste

**Local:** §5.3, linha final (*"**Total: 29 `kind`s.** Espelham 1:1 as ações mapeadas nas stores do frontend (Apêndice A)"*); §21.1 (*"round-trip de todos os **29** `kind`s"*); §21.4 (*"cobrindo os **29** `kind`s"*).
**Afirma:** que há 29 ops e que elas espelham 1:1 as ações do Apêndice A.
**Problema:** a contagem por bloco dá 6 (mensagem) + 7 (estrutura) + 9 (cargos/membros) + 5 (moderação) + 7 (comunidade/rede) = **34**. E o espelhamento "1:1" não se sustenta: o Apêndice A mapeia ~60 ações, incluindo várias marcadas `*(local)*`, `*(some)*` e `*(evento)*`.
**Cenário:** o teste de `opCodec` (§21.1) e o core de referência de §21.4 são dimensionados por "29 kinds"; cinco ops ficam sem cobertura obrigatória, e a de maior risco (`member.join`, F-06) está entre elas.
**Consequência:** cobertura de teste incompleta por erro aritmético em requisito normativo.
**Tipo:** CONTRADIÇÃO interna.
**Evidência:** recontar a tabela de §5.3 (feito). Corrigir os três lugares.

---

## F-24 — MEDIUM — `community.leave` é comando IPC e "Operação" da entidade Community, mas não existe como `kind` de op

**Local:** §4.2 (*"**Operações:** `community.create`, `community.update`, `community.end`, **`community.leave`**"*); §10.2 (comando `community.leave ⏱`); Apêndice A (`communityStore.leaveCommunity` → `community.leave`). Contra §5.3, que não tem a linha; §4.3, cujo ciclo de vida usa `member.leave`.
**Afirma:** que existe uma operação `community.leave`.
**Problema:** o catálogo de ops não a contém. O implementador precisa decidir se `community.leave` emite `member.leave` — o que é uma decisão de contrato, proibida por §0.
**Cenário:** Ana sai de Ateliê Aberto. Qual op é appendada? `member.leave` não tem payload (§5.3), então não carrega `communityId`; o contexto vem do canal RPC (§10.5). Funciona, mas nada disso está escrito, e o efeito na outbox, no `local_*` e no `swarm.leave` fica indefinido.
**Consequência:** um dos poucos comandos irreversíveis do produto sem op definida.
**Tipo:** REQUISITO AUSENTE.
**Evidência:** buscar `community.leave` em §5.3 (ausente). Escolher e escrever.

---

## F-25 — MEDIUM — Não-lidas: §6.3/§6.4 materializam incrementalmente, §19.4 diz que é query ao vivo; se materializado, a reprojeção total conta em dobro

**Local:** §6.3 (`local_read_state … | **Recalculado incrementalmente a cada append aplicado**`); §6.4 passo 4 (*"Dentro dela: reducers, recálculo de contadores afetados, **`local_read_state` do lote**"*); §6.4 reprojeção (*"As tabelas `local_*` **sobrevivem**"*). Contra §19.4 (*"O que **não** tem cache, de propósito: **contagem de não-lidas** (é uma query indexada de <1 ms e ficaria errada com facilidade)"*).
**Afirma:** as duas coisas.
**Problema:** se `unread_count` é coluna incrementada por lote e as tabelas `local_*` sobrevivem à reprojeção, então reprojetar do `seq` 0 reincrementa todo o histórico sobre um contador que já estava correto.
**Cenário:** Ana tem 3 não-lidas em `#geral`. Bump de schema → reprojeção total → o projetor reaplica 40.000 mensagens e incrementa `unread_count` a cada uma cujo `seq > last_read_seq`… mas `last_read_seq` sobreviveu, então tecnicamente o delta é o mesmo — **exceto** que o contador não foi zerado antes. Resultado: 3 + 3 = 6, ou pior, dependendo de a soma ser sobre o conjunto ou sobre o incremento. O documento não diz qual. E o badge de menção do rail (`UNR-02`) fica errado sem sinal.
**Consequência:** o dado que a ADR-15 e a ADR-16 existem para viabilizar corrompe silenciosamente numa operação de manutenção rotineira. E §19.4 contradiz a existência da coluna.
**Tipo:** CONTRADIÇÃO + RISCO de consistência.
**Evidência:** decidir entre coluna materializada (e então especificar que a reprojeção zera e recalcula `local_read_state`) ou query ao vivo (e então remover as colunas de §6.3). Assertar em §21.4 que reprojetar não altera contagem de não-lidas.

---

## F-26 — MEDIUM — A remoção da menção `everyone` não pode ser feita pelo host (quebra a assinatura) nem pelo reducer (§3.2 proíbe a dependência)

**Local:** §4.7 (*"sem a permissão, a op é **aceita com a menção removida**, não rejeitada"*); §8.1 (`mention_everyone | Menção `everyone` **sobreviver na projeção**`); §5.1 (o host *"não pode forjar"*); §3.2, ficha de `reducers` (`Depende de: storage, errors` — **não** de `permissions`); §3.1 (importação lateral só onde §3.2 declarar).
**Afirma:** que a menção some sem que a op seja rejeitada.
**Problema:** há só dois lugares onde isso poderia acontecer, e ambos estão bloqueados. No host: mexer no payload invalida a assinatura, e §6.4 manda toda réplica verificar sempre → o registro seria ignorado com `projector.badSignature`, que §17.3 marca como *"> 0 é alarme de segurança"*. Na projeção: o reducer precisaria consultar `permissions`, dependência que §3.2 não declara — e, além disso, precisaria da permissão **no `seq` daquela mensagem**, não a atual.
**Cenário:** um cliente adulterado envia `mentions:["everyone"]` sem a permissão. Se o host mexer no payload: `projector.badSignature` incrementa em 340 réplicas, disparando alarme de segurança para um caso benigno e previsto. Se ninguém mexer: `mentions` fica na projeção, e §4.15 conta `everyone` em `pendingMentions` — a badge vermelha toca em toda a comunidade, que é exatamente o abuso que a permissão existe para impedir.
**Consequência:** uma das 17 permissões não tem ponto de enforcement construível.
**Tipo:** CONTRADIÇÃO + INVIABILIDADE.
**Evidência:** decidir. A saída limpa é rejeitar a op (`E_PERMISSION_DENIED`), assumindo que o custo é aceitável porque §4.7 já diz que só cliente adulterado chega ali — o argumento de "desproporcional" perde força quando a alternativa é inconstruível.

---

## F-27 — MEDIUM — A maioria dos limites de §19.2 não tem ponto de enforcement em §9.3, e o de 50 comunidades não tem enforcement possível

**Local:** §19.2 (12 limites com ação "`E_VALIDATION`"); §8.4 (*"O `validator` lê **dessa tabela**, declarativamente — não há `if` espalhado por reducer"*); §9.3 (invariantes por `kind`).
**Afirma:** que estourar cada limite devolve `E_VALIDATION`, e que a validação é declarativa a partir das tabelas.
**Problema:** §9.3 é a única tabela de invariantes estruturais e ela **não** contém: 500 canais, 50 categorias, 100 cargos, 24 cargos por membro, 64 menções, 1 anexo, 200 espectadores. Só `INVITE_MAX_ACTIVE` está lá. Pior: "Comunidades participadas | 50" é um limite **do dispositivo do leitor**, e o host que valida o `inviteRedeem` não tem como saber de quantas comunidades o candidato participa — não existe enforcement possível do lado da verdade.
**Cenário:** um cliente adulterado cria 5.000 canais numa comunidade. O pipeline de §9.1 não tem estágio que verifique. A projeção aceita. `query.structure` (alvo: < 2 ms) degrada, a lista de canais de 1.1 fica inutilizável, e a ação corretiva (excluir canais) é 5.000 ops sujeitas a rate limit de 20/60 s ≈ 4 horas.
**Consequência:** limites declarados que não existem no caminho de execução; e um limite (50 comunidades) que só pode ser cortesia do cliente.
**Tipo:** REQUISITO AUSENTE + limite arbitrário sem enforcement.
**Evidência:** cruzar §19.2 com §9.3 linha a linha (feito) e acrescentar as checagens faltantes. Reclassificar o limite de 50 comunidades como local, com erro próprio, e removê-lo da semântica de `E_VALIDATION` de op.

---

## F-28 — MEDIUM — Quatro códigos de erro usados em texto normativo estão fora do catálogo de §16.2, que se declara "o contrato"

**Local:** §16.1 (*"`code`: da tabela abaixo … **É o contrato**"*). Códigos ausentes do catálogo: `E_CLOCK_UNREASONABLE` (usado em §9.1, estágio 6), `E_NOT_BANNED` (§10.2, `mod.revokeBan`), `E_ALREADY_SENT` (§10.2, `message.cancelQueued`), `E_SESSION_FULL` (§19.2, com a nota "`E_BUSY` na v1").
**Afirma:** que o catálogo é fechado e é o contrato.
**Problema:** quatro códigos existem fora dele, sem classe, sem HTTP equivalente e — o que importa de verdade — **sem a coluna "Retenta?"**, que é o que a outbox consulta (§6.5 divide erros em terminais e transitórios por código).
**Cenário:** uma op chega ao estágio 6 com `op.ts` fora da janela de 8 dias (relógio quebrado, caso real em máquinas sem RTC). Devolve `E_CLOCK_UNREASONABLE`. O item na outbox não está em nenhuma das duas listas de §6.5: retenta para sempre até os 72 h, ou vira `dropped` sem motivo nomeado — ambos violam a regra 4 de §16.3 ("nunca some calado").
**Consequência:** buraco no contrato de erro, com efeito direto na política de retry.
**Tipo:** CONTRADIÇÃO / REQUISITO AUSENTE.
**Evidência:** buscar cada código no catálogo (feito). Acrescentar as quatro linhas com classe e política de retry.

---

## F-29 — MEDIUM — `E_TIMED_OUT` não está em nenhuma das listas da outbox, e sua janela de retry (até 30 dias) é incompatível com o backoff (60 s) e a idade máxima (72 h)

**Local:** §16.2 (`E_TIMED_OUT | autorização | 403 | Retenta? **sim, após `until`**`); §6.5 (listas de erros terminais e transitórios — `E_TIMED_OUT` não aparece em nenhuma); §6.5, política de retry (`min(1000·2^attempts, 60000)`; `OUTBOX_MAX_AGE_MS` = 72 h); §4.12 (`until ≤ hostTs + 30 dias`).
**Afirma:** que `E_TIMED_OUT` retenta "após `until`", e que a outbox tem backoff máximo de 60 s e descarte em 72 h.
**Problema:** três incompatibilidades. (1) O código não está classificado na outbox. (2) A curva de backoff satura em 60 s; esperar até `until` exigiria honrar `retryAfterMs`, mecanismo que §16.1 associa só a `E_RATE_LIMITED`. (3) Um timeout de 7 dias garante que o item morra por idade (72 h) antes de `until`.
**Cenário:** Ana recebe timeout de 7 dias enquanto tinha 4 mensagens na fila. Elas retentam a cada 60 s por 72 h (≈4.300 tentativas inúteis contra o host, que ainda contam para o rate limit de conexão), e então são descartadas por `expired`. O usuário recebe "4 mensagens não foram enviadas: expiraram" quando a causa real é o timeout — mensagem errada, motivo errado.
**Consequência:** tempestade de retry inútil e diagnóstico incorreto num fluxo de moderação normal.
**Tipo:** REQUISITO AUSENTE + CONTRADIÇÃO.
**Evidência:** classificar `E_TIMED_OUT` e definir se `retryAfterMs` é honrado genericamente (o que seria a correção limpa) e se `until` > `OUTBOX_MAX_AGE_MS` deve dropar imediatamente com motivo `timed-out`.

---

## F-30 — MEDIUM — `submitOps` "para no primeiro erro terminal" contradiz a ordenação por canal da outbox e a regra 5 de §16.3

**Local:** §12.3 (*"O host processa o lote **na ordem**, **para no primeiro erro terminal**, e devolve um resultado por item — os anteriores ficam aplicados"*); §6.5 (*"Um item bloqueado **não segura os outros canais**, mas segura o próprio canal"*); §16.3, regra 5 (*"Falha parcial é reportada **por item**, não pelo lote: `submitOps` devolve um resultado **por envelope**"*); §10.6 (`submitOps | {envelopes[≤32]} | [{seq|error}]`).
**Afirma:** as três coisas.
**Problema:** um lote de 32 pode conter itens de vários canais. Parar no primeiro erro terminal faz um bloqueio de canal virar bloqueio de todos os canais do lote — exatamente o que §6.5 promete que não acontece. E "devolve um resultado por envelope" fica indefinido para os itens após a parada: não há valor especificado (nem `seq`, nem `error`).
**Cenário:** flush após 3 h offline. O lote 1 tem 10 mensagens de `#geral`, 12 de `#ajuda-frontend` e 10 de `#avisos`. A 11ª (primeira de `#ajuda-frontend`) falha com `E_CHANNEL_NOT_FOUND` (o canal foi excluído enquanto Ana estava fora — cenário previsto em §11.9). As 21 restantes, de dois canais saudáveis, não são processadas e não têm resultado definido. O cliente as reenfileira, e o próximo lote refaz o mesmo erro.
**Consequência:** mensagens de canais saudáveis atrasadas e possivelmente presas em loop, contra uma garantia explícita.
**Tipo:** CONTRADIÇÃO.
**Evidência:** definir se `submitOps` continua após erro terminal (marcando aquele item) ou se o cliente monta lotes homogêneos por canal. Acrescentar cenário ao §21.2, que hoje não testa lote heterogêneo com erro no meio.

---

## F-31 — MEDIUM — `role.delete` deixa referência pendurada em `channels.read_only_role_ids`, e a garantia de "≥1 cargo de fora" pode ser anulada depois

**Local:** §4.4 (*"`role.delete` … A projeção tira o `roleId` de todo **membro** que o tinha, na mesma transação"* — só membros); §4.6/§9.3 (`readOnlyForRoleIds` … *"deixa ≥1 cargo de fora **e todos existem**"* — checado só na op de canal); §6.3 (`channels.read_only_role_ids TEXT` (JSON)); §4.18 (nenhuma invariante cobre isso).
**Afirma:** que a lista de somente-leitura sempre deixa ao menos um cargo de fora e que todos os cargos dela existem.
**Problema:** as duas garantias são verificadas **no momento da op de canal** e podem ser violadas depois por `role.delete`. Nada limpa a lista do canal, e nada impede que o único cargo "de fora" seja o deletado.
**Cenário A (canal travado):** `#avisos` tem `readOnlyForRoleIds = [Contribuidor, Membro]`, deixando Fundador e Moderador de fora — válido. Rafael deleta o cargo Moderador. Agora só o Fundador está fora. Rafael deleta… não pode (Fundador é imutável). Mas suponha uma comunidade com 3 cargos onde o único fora da lista é deletado: **ninguém**, incluindo o Fundador, pode postar, porque §8.2 avalia por pertencimento a cargo, não por permissão. Estado alcançável, sem invariante, sem erro, sem UI.
**Cenário B (canal inatualizável):** após deletar Moderador, `channels.read_only_role_ids` ainda contém `role-mod…`. Qualquer `channel.update` futuro que reenvie a lista falha em §9.3 ("todos existem"); e se omitir o campo, mantém a referência pendurada para sempre.
**Consequência:** canal permanentemente inescrivível ou ineditável, alcançável por uma operação de administração comum.
**Tipo:** REQUISITO AUSENTE (falta reducer de limpeza e invariante).
**Evidência:** acrescentar a `role.delete` a limpeza de `read_only_role_ids` na mesma transação, e uma invariante I-11 em §4.18 ("todo canal tem ≥1 cargo não-somente-leitura").

---

## F-32 — MEDIUM — O `handle` derivado da chave pública não produz os identificadores que a spec de UX usa em todo o dataset

**Local:** §4.1 (`handle | der | **`@` + 6 primeiros caracteres de base32(publicKey)**, minúsculo`). Contra `frontend.md` §2 (*"Ana Torres (**`@ana`**)"*), 3.1 (*"identificador local (somente leitura, ex.: **`@ana`** truncado)"*), 3.3 (*"**`Usuário#4471`**"* como identificador de banido, usado no log de auditoria e no fluxo D12) e 1.4 (*"nome de exibição + apelido (se houver) + **identificador**"*).
**Afirma:** backend, que o handle é `@`+6 caracteres de base32 da chave. UX, que o identificador é `@ana` e `Usuário#4471`.
**Problema:** nenhum dos dois formatos da UX é produzível pela regra do backend. `@ana` é derivado do nome (e portanto colidiria, o que §4.1 quer evitar); `Usuário#4471` é um formato de terceiro tipo que não existe no backend.
**Cenário:** a tela 1.4, o log de auditoria de 3.3 e a lista de banidos passam a exibir `@k7m2qx` no lugar de `@ana` e `@r3f9pd` no lugar de `Usuário#4471`. Todo o dataset de referência de §2, e as 206 checagens de verificação que o usam, deixam de bater — e §21.7 exige paridade com as fixtures.
**Consequência:** dessincronização visível entre o produto especificado na UX e o produto que o backend pode produzir, em três telas.
**Tipo:** CONTRADIÇÃO entre documentos, ausente de §25.
**Evidência:** conferir §4.1 contra §2 e 3.3 da UX (feito). Escolher um formato e registrar o delta.

---

## F-33 — MEDIUM — Relógio adiantado: §4.7 manda exibir `hostTs`; a spec de UX manda exibir a hora local de chegada. São coisas diferentes e o delta não está em §25

**Local:** §4.7 (*"o host **aceita** a mensagem e marca `clockSkewed = true` … A UI mostra **`hostTs`** com o aviso de `spec:371`"*); §5.5 (*"se `clockSkewed`, mostra `hostTs` e o aviso"*). Contra `frontend.md` §5.10, linha 371: *"mensagem que chega com carimbo no futuro é exibida com **o horário local de chegada** e um tooltip discreto"*.
**Afirma:** duas âncoras temporais diferentes, cada documento citando o outro como confirmação.
**Problema:** `hostTs` é determinístico e igual para toda réplica; "horário local de chegada" é **por leitor** e não existe na projeção — não há coluna para ele em `messages` (§6.3), e ele nem sequer é reprodutível numa reprojeção (§21.4 exige estado idêntico). Portanto a regra da UX não é implementável, e a do backend altera o comportamento visível sem registrar delta.
**Cenário:** Diego está com o relógio 3 dias adiantado. Sua mensagem chega. Bianca, que estava online, veria "hora de chegada"; Ana, que sincroniza dois dias depois, veria uma hora de chegada dois dias posterior. Com `hostTs`, as duas veem a mesma coisa. O comportamento correto é o do backend — mas a spec de UX diz outra coisa, e §25, que lista 12 deltas, não inclui este.
**Consequência:** divergência silenciosa entre o texto de UX e o backend num ponto que o próprio produto marca como sensível (`CLK-02`, `CLK-04`).
**Tipo:** CONTRADIÇÃO entre documentos, ausente de §25.
**Evidência:** comparar §4.7 com a linha 371 da UX (feito). Acrescentar o delta 13.

---

## F-34 — MEDIUM — Não há evento para mudanças no log de auditoria nem em convites, e as duas telas exigem atualização em tempo real

**Local:** §10.3 (tabela completa de eventos — não há `auditLog.changed` nem `invites.changed`); §10.4 (`query.auditLog`, `query.invites`). Contra `frontend.md` D12 passo 3 (*"entrada nova aparece no log de auditoria (3.3) **em tempo real**"*) e 3.1b (lista de convites com coluna `usos`, que muda a cada resgate).
**Afirma:** que eventos são o sinal para reconsultar, e que essas duas telas atualizam sozinhas.
**Problema:** não existe o sinal. O renderer teria que reconsultar o log de auditoria em **todo** evento (`structure.changed`, `roles.changed`, `members.changed`, `community.changed`), porque §4.13 diz que a entrada de auditoria é derivada de "qualquer op auditável" — 13 tipos, espalhados por 4 tópicos. E `uses` de convite não é coberto por evento nenhum: um resgate dispara `members.changed`, que a UI de 3.1b não escuta.
**Cenário:** Rafael deixa 3.1b aberta enquanto 5 pessoas entram por um convite de `maxUses: 10`. A coluna "usos" continua mostrando 0/10. Ele revoga achando que ninguém usou.
**Consequência:** duas telas de administração com dado desatualizado sem sinal, num produto cujo princípio 2 é "a saúde da informação é de primeira classe".
**Tipo:** REQUISITO AUSENTE.
**Evidência:** cruzar as telas 3.1b/3.3 com a tabela de §10.3 (feito). Acrescentar os dois tópicos, ou uma regra explícita de "reconsultar auditoria em X, Y, Z".

---

## F-35 — MEDIUM — Ser expulso ou banido não tem ciclo de vida definido no cliente do alvo, em nenhum dos dois documentos

**Local:** §4.3 (ciclo de vida do Member); §11.11 (banir, do ponto de vista do host); §10.3 (`community.left` existe, mas §10.3 o descreve como "Entrada/saída", sem dizer se cobre expulsão). Silêncio em: o que acontece com o `swarm.join` do alvo, com a `local_outbox` dele, com a réplica local, com `local_read_state`, e o que a UI mostra. `frontend.md` não tem tela nem estado para "você foi removido de X".
**Afirma:** o efeito no host e na projeção. Nada sobre o alvo.
**Problema:** é um estado alcançável, comum e de alta carga emocional, sem comportamento definido. E o alvo **continua com o log completo replicado** — ele pode continuar lendo tudo que já sincronizou indefinidamente, o que é consequência inevitável da arquitetura mas não está declarado no princípio 3 da UX ("honestidade sobre limitações").
**Cenário:** Ana é expulsa de Vale do Código. A projeção dela aplica `mod.kick` e marca seu próprio `leftAt`. E aí? O ícone some do rail? Vira histórico? A fila dela é descartada com motivo `left-community` (§11.9 tem o motivo, mas o gatilho listado é `community.leave` voluntário)? Ela continua no swarm replicando? O firewall do host a expulsa da conexão em algum momento? Nada disso está escrito.
**Consequência:** o implementador inventa; e a UI não tem estado para renderizar, o que na prática produz um ícone de comunidade que silenciosamente para de atualizar.
**Tipo:** ESTADO ALCANÇÁVEL SEM COMPORTAMENTO DEFINIDO.
**Evidência:** buscar "kick" no lado do cliente em ambos os documentos (não há). Especificar o ciclo completo e a tela.

---

## F-36 — MEDIUM — `identity.update` em N comunidades colide na chave primária da outbox, a menos que o nonce seja por comunidade — requisito nunca declarado

**Local:** §4.1 (*"Trocar `displayName`/`avatarColor` gera `identity.update` em **cada** comunidade participada — … a mesma mudança appenda N vezes"*); §5.1 (`Op` = `v, kind, author, ts, nonce, payload` — **sem** `communityId`); §5.3 (payload de `identity.update` = `displayName?, avatarColor?` — sem `communityId`); §6.5 (`local_outbox | id TEXT PK | opId hex — … enfileirar duas vezes o mesmo envelope é **no-op**`).
**Afirma:** que a mesma mudança gera N ops, e que a outbox é chaveada pelo `opId`, tratando duplicata como no-op.
**Problema:** duas ops `identity.update` para comunidades diferentes têm exatamente o mesmo conteúdo canônico, exceto o `nonce` e o `ts`. Se o núcleo assinar **um** envelope e enfileirá-lo N vezes (que é a leitura natural de "a mesma mudança"), o `opId` é idêntico e a PK descarta N−1. O documento nunca exige nonce fresco por instância.
**Cenário:** Ana troca o nome. O núcleo assina um `identity.update` e o enfileira para as 12 comunidades. `local_outbox` aceita 1 e ignora 11. Onze comunidades continuam mostrando o nome antigo, sem erro, sem evento, sem item pendente visível em `query.outbox`.
**Consequência:** falha silenciosa de uma operação de identidade, com diagnóstico difícil (o sintoma é "meu nome só mudou em uma comunidade").
**Tipo:** REQUISITO IMPLÍCITO que deveria ser explícito.
**Evidência:** escrever em §5.1 que o `nonce` é gerado por instância de op e nunca reutilizado entre comunidades; ou acrescentar `communityId` ao payload de `identity.update`, o que também resolveria a ambiguidade de escopo do envelope.

---

## F-37 — MEDIUM — Consentimento de repasse só é pedido na transição estrela→árvore; quem entra depois nunca é candidato, e a degradação de reparo é ilimitada

**Local:** §11.18 (*"Disparado **na transição estrela→árvore**, não a cada espectador novo — perguntar de novo a cada entrada viraria insistência"*; *"**nunca** assumir recusa por timeout … a pergunta continua pendente até a pessoa voltar"*); §11.17.1 (*"Recalcula em: entrada/saída de viewer, **morte de nó**, mudança de consentimento"*); §11.17, Falhas (*"nó morre e não há substituto → os órfãos viram **filhos diretos do apresentador, mesmo estourando o fanout** — degradar é melhor que cortar"*).
**Afirma:** que o consentimento é pedido uma vez, na transição, e que órfãos sem substituto viram filhos diretos do apresentador sem limite.
**Problema:** os espectadores que entram depois da transição — que é a maioria, numa sessão que cresce — nunca são perguntados, e portanto **nunca** entram no conjunto de candidatos a repasse. O conjunto de candidatos é fixado no pior momento possível: quando havia 6 espectadores. Quando um relay morre (o cenário que §11.17 passo 8 trata como normal), o pool de substitutos é o mesmo de quando a sessão tinha 6 pessoas.
**Cenário:** transição com 6 espectadores; 2 aceitam repassar. A sessão cresce para 40. Os 34 novos nunca viram o modal. Os 2 relays saem. Os 38 órfãos viram filhos diretos do apresentador. A 2.500 kbps cada, o apresentador precisa de **95 Mbps de upload**. O fanout declarado de ≤5 é violado por um fator de 7,6, por regra explícita da spec, e o resultado prático é o colapso da transmissão para todos — o oposto de "degradar é melhor que cortar".
**Consequência:** o mecanismo de reparo da árvore (`TELA-08/09`, declarados fechados em §26.1) tem um pool de candidatos que só encolhe, e um fallback sem teto.
**Tipo:** REQUISITO AUSENTE + RISCO.
**Evidência:** definir quando novos espectadores entram no pool sem virar insistência (por exemplo: perguntar uma vez por sessão a quem for elegível, no `shareJoin`, já que `shareJoin` carrega `canRelay`). Definir um teto para o fanout de emergência do apresentador e o comportamento acima dele.

---

## F-38 — MEDIUM — A regra anti-escalada permite conceder permissões elevadas ao cargo base, que todo membro atual, futuro e reingressante recebe automaticamente

**Local:** §4.4 (*"O **cargo base** não pode ser deletado …, mas **suas permissões são editáveis** (`spec:729`)"*); §8.3 (*"Sem escalada de permissão: ninguém concede a um cargo permissão que não possui"*); §4.3 (*"Todo membro tem o cargo base"*; membro que volta tem `roleIds` **resetado para só o cargo base**); §11.4 (o resgate atribui o cargo base).
**Afirma:** que a anti-escalada impede que `manage_roles` equivalha a todas as 17 permissões.
**Problema:** a regra é sobre o **conjunto** de permissões, não sobre **quem** as recebe. Um moderador com `manage_roles` + `ban_members` pode legalmente editar o cargo base (que está abaixo dele na hierarquia) e acrescentar `ban_members` a ele — todas as permissões concedidas são ⊆ das dele, então §9.3 aprova. A partir daí, todo membro da comunidade tem `ban_members`. Não há regra que trate o cargo base como especial nesse aspecto.
**Cenário:** um moderador comprometido (ou apenas descuidado) marca 6 checkboxes no cargo "Membro" em 3.2. Os 340 membros de Vale do Código passam a poder banir. A hierarquia limita alvos a quem tem topRole estritamente menor — mas todo mundo no cargo base tem a mesma posição, então na prática eles não conseguem banir uns aos outros… **exceto** que qualquer membro agora pode editar o cargo base de novo (ele também ganhou `manage_roles`), e a cascata continua. E cada convite resgatado a partir daí (§11.4) entrega essas permissões ao recém-chegado.
**Consequência:** um vetor de escalada de privilégio de comunidade inteira que passa pela regra anti-escalada, e que se propaga a todo novo membro, incluindo quem entra por link vazado — cuja única mitigação declarada é revogar o convite (`spec:1127`).
**Tipo:** REQUISITO AUSENTE.
**Evidência:** decidir se o cargo base tem restrição própria (por exemplo, permissões de moderação não podem ser atribuídas ao `isDefault`), e escrever a regra em §4.4 e §9.3.

---

## F-39 — MEDIUM — Renumeração densa de `position` dentro de uma transação contra índice UNIQUE: SQLite não tem constraint diferível

**Local:** §4.4 (*"`position` é **denso e único**: a projeção renumera 0..N-1 a cada `role.move`, **sempre dentro da mesma transação**"*); §6.3 (`uniq_roles_position(community_id, position) WHERE deleted_at IS NULL`); §4.18, I-4; §6.3, PRAGMAs (`foreign_keys=OFF` — mas isso não afeta índices UNIQUE, que não são diferíveis em SQLite).
**Afirma:** renumeração densa e única na mesma transação, com índice UNIQUE parcial garantindo.
**Problema:** SQLite avalia unicidade **por linha**, no momento do UPDATE, sem `DEFERRABLE INITIALLY DEFERRED` (que só existe para chaves estrangeiras). Um `UPDATE roles SET position = position - 1 WHERE position BETWEEN 4 AND 7` colide na primeira linha processada, dependendo da ordem do índice. A invariante é declarada sem que o mecanismo que a torna possível esteja especificado.
**Cenário:** Rafael arrasta um cargo da posição 7 para a 3, numa comunidade com 9 cargos. O reducer precisa deslocar 6 linhas. A implementação natural (um UPDATE de faixa) lança `UNIQUE constraint failed`. Pelo §6.4, reducer que lança = `projector.failed` = comunidade `degraded` (F-04), reproduzido em toda reprojeção. Uma ação de administração cotidiana vira um tijolo.
**Consequência:** falha determinística e irrecuperável a partir de uma operação comum, se o implementador seguir a leitura direta do texto.
**Tipo:** INVIABILIDADE da implementação natural / REQUISITO IMPLÍCITO.
**Evidência:** testar o UPDATE de faixa em `better-sqlite3` com o índice parcial de §6.3. Especificar a técnica (duas fases com deslocamento por offset fora da faixa, ou DELETE+INSERT dentro da transação) em §4.4, em vez de deixá-la implícita.

---

## F-40 — MEDIUM — A invariante I-10 ("não há buraco na sequência aplicada") contradiz duas regras que mandam pular registros

**Local:** §4.18, I-10 (*"`meta.last_projected_seq` = maior `seq` aplicado, e **não há buraco na sequência aplicada**"*). Contra §5.2, regras 4 e 5 (`v`/`kind` desconhecido → *"o registro é **contado no `seq`** e **ignorado na projeção**"*) e §6.4 (*"**Assinatura inválida:** o registro é **ignorado**, contado em `projector.badSignature`, e a projeção continua"*).
**Afirma:** simultaneamente que não há buracos e que há pelo menos três motivos para pular registros.
**Problema:** se a invariante é assertada com as regras ativas (§4.18 diz que as asserções ficam **ligadas em desenvolvimento e em teste**), a primeira assinatura inválida — que é dado hostil **esperado**, segundo o próprio §6.4 — dispara `E_INVARIANT`, que aborta a transação, que é "reducer que lança", que é `degraded`. As duas regras de §6.4 se cancelam: a de cima diz "continua", a de baixo diz "para".
**Cenário:** o teste de §21.5 ("Host modificado que appenda mensagem com autoria alheia → toda réplica rejeita na verificação e incrementa `projector.badSignature`") é executado com asserções ligadas (ambiente de teste, por §4.18). A réplica pula o registro, I-10 falha, `E_INVARIANT`, projeção abortada. O teste que deveria provar a resiliência prova o contrário.
**Consequência:** o teste central do modelo de segurança (§21.5, host adversário) colide com a invariante central do modelo de integridade.
**Tipo:** CONTRADIÇÃO.
**Evidência:** reescrever I-10 distinguindo "`seq` consumido" de "`seq` aplicado", e nomear explicitamente as três causas legítimas de lacuna.

---

## F-41 — MEDIUM — O `hash` do anexo não é verificável pelo host; qualquer membro pode publicar um anexo garantidamente corrompido apontando para blocos de outra pessoa

**Local:** §4.10 (`hash | bytes[32] | req | BLAKE2b-256 do conteúdo. **Verificado no download**`; *"O `hash` é verificado **no destino**"*); §9.3, `message.send` (*"`sizeBytes` bate com `blobId.byteLength`"* — só o tamanho); §4.10 (*"`sizeBytes` é **revalidado pelo host** contra o `byteLength` do `blobId`"*).
**Afirma:** que o host revalida o tamanho e que o hash é verificado no destino.
**Problema:** o `blobId` é um par de coordenadas (`byteOffset, blockOffset, blockLength, byteLength`) dentro do core de blobs — não é um endereço por conteúdo. O host valida a coerência de tamanho, não a correspondência entre `hash` e conteúdo, e não pode fazê-lo sem baixar o blob. Nada impede um membro de referenciar coordenadas de um blob de outra pessoa declarando um `hash` arbitrário.
**Cenário:** um membro posta uma mensagem com anexo "contrato-assinado.pdf", apontando para as coordenadas de um blob real e um `hash` inventado. O host aceita (tamanho bate). Todo destinatário que clicar baixa o arquivo inteiro, falha na verificação, recebe `attachment.corrupt`, e o card volta para "indisponível" (§4.10). Repetido com um arquivo de 8 GiB, isso é desperdício de banda de toda a comunidade, sob demanda, a custo zero para o atacante.
**Consequência:** vetor de griefing/desperdício de banda não previsto em §18.1 ("Membro comum malicioso — spam até o rate limit"), e um estado de UI (`attachment.corrupt`) que passa a ser induzível por terceiros em vez de indicar corrupção real.
**Tipo:** RISCO de segurança / REQUISITO AUSENTE.
**Evidência:** avaliar se o `hyperblobs` já vincula conteúdo a `blobId` de forma verificável (o Hypercore tem árvore de Merkle sobre blocos; se o `blobId` for verificável contra a raiz assinada, o achado se enfraquece muito — **isto precisa ser confirmado antes de agir**). Se não for, exigir que o `hash` seja derivável das coordenadas ou que o autor prove posse.

---

## F-42 — MEDIUM — O teto de 200 espectadores e a promessa de "1–2 s de atraso" são incompatíveis, e os alvos de performance param no nível 2

**Local:** §19.2 (`Espectadores por sessão de tela | **200**`); §10.8 (`Fanout do apresentador ≤ 5`; `Fanout de nó de repasse ≤ 3`; `Jitter buffer | **800 ms na folha + 250 ms por nível**`); §19.1 (só dois alvos de tela: estrela e "folha em árvore (**nível 2**)"); §25, delta 3 (*"Espectador em árvore fica **1–2 s** atrás"*).
**Afirma:** que o teto é 200 espectadores e que o atraso a comunicar na UI é de 1–2 s.
**Problema:** com fanout 5 no primeiro nível e 3 nos demais, a capacidade por nível é 5, 15, 45, 135, 405 — atender 200 exige **5 níveis**. O orçamento de jitter sozinho é 800 + 5×250 = **2.050 ms**, antes de qualquer latência de rede por salto (5 saltos), de fila e de decodificação. O atraso real na borda da capacidade declarada é plausivelmente 3–5 s, não 1–2. E não há alvo nem teto de performance especificado acima do nível 2.
**Cenário:** uma comunidade faz uma apresentação para 150 pessoas — bem dentro do limite declarado. Espectadores nos níveis 4 e 5 ficam ~4 s atrás. A UI, por §25 delta 3, diz "1–2 s". Perguntas no chat chegam ao apresentador fora de contexto; o usuário reporta como bug.
**Consequência:** um limite declarado (200) que a arquitetura de latência não sustenta, e uma promessa de UI calibrada para um cenário (nível 2) que não é o limite do sistema.
**Tipo:** CONTRADIÇÃO interna + limite arbitrário sem sustentação.
**Evidência:** §21.8 já prevê medir com 8 espectadores; isso cobre no máximo o nível 2. Estender a medição até a profundidade que 200 espectadores exige, ou reduzir o teto de §19.2 ao que os alvos de §19.1 sustentam.

---

## F-43 — MEDIUM — "Avisar quem está online" appenda uma mensagem que provavelmente nunca é replicada antes do desligamento

**Local:** §11.20 (*"o main chama `host.notifyBeforeExit`, que **appenda** uma `message.send` assinada pelo host … Confirmando a saída, o main envia `core.shutdown`"*); §2.3, fase `draining` (*"flush da outbox pendente **por até 3000 ms**, faz `core.flush()` de cada Hypercore"*); §5.1 (a replicação é **pull**: réplicas leem o core). `frontend.md` 3.5 (*"**'Avisar quem está online'** … posta uma mensagem … **antes de fechar**. Sem isso, quem está do outro lado só descobre pelo banner de host offline (B4), depois do fato"*).
**Afirma:** que a ação avisa as pessoas conectadas antes de o host cair.
**Problema:** `core.flush()` garante durabilidade **local**, não entrega. A replicação Hypercore é sob demanda: os peers precisam perceber o novo `length`, pedir o bloco e recebê-lo — tudo dentro de uma janela de 3.000 ms compartilhada com o flush da outbox, e sem nenhuma confirmação de entrega especificada. Não há espera por N réplicas, nem métrica, nem retorno indicando quantos receberam.
**Cenário:** Ana hospeda Clã Noturno com 12 pessoas online, 3 em chamada. Ela clica "Avisar quem está online", confirma a saída. O núcleo appenda a mensagem e entra em `draining`. O processo encerra em 3 s. Alguns peers ainda não puxaram o bloco. Eles veem apenas `host.wentOffline` — que é exatamente o que a ação existia para evitar. Quem não recebeu só vai ver o aviso quando Ana voltar, momento em que ele é inútil e confuso ("Ana vai ficar offline" aparecendo no instante em que ela volta).
**Consequência:** uma funcionalidade cujo propósito declarado ("sem isso, a pessoa só descobre depois do fato") não é atingível pelo mecanismo especificado, e cujo modo de falha é entregar a mensagem no pior momento possível.
**Tipo:** PREMISSA NÃO COMPROVADA (que appendar ≈ entregar).
**Evidência:** medir, no harness de §21.2, quantos peers de N recebem um bloco appendado 3.000 ms antes do encerramento do host. Se for baixo, ou a mensagem passa a ser **efêmera** (protomux, entrega imediata a quem está conectado — que é semanticamente o certo para um aviso) ou o `draining` espera confirmação de replicação, com orçamento próprio.

---

## F-44 — LOW — `message.accepted` não carrega `clientRef`, embora §11.3 dependa disso

**Local:** §11.3, Regras (*"o `clientRef` do argumento **volta em `message.accepted`** para a UI casar a mensagem otimista com a real"*). Contra §10.3 (`message.accepted | **{opId, messageId, seq, channelId}**`) e §6.5 (a tabela `local_outbox` não tem coluna `client_ref`).
**Problema:** o campo prometido não existe no schema do evento nem na tabela que sobreviveria a um restart.
**Cenário:** a UI casa por `opId`, que é devolvido sincronamente por `message.send`. Funciona **enquanto o renderer não reinicia**; depois disso, nem `clientRef` nem `opId` estão no renderer, e cai-se em F-16.
**Consequência:** contradição menor de contrato; o mecanismo de casamento fica dependente de estado volátil do renderer, o que §2.4 regra 4 desaconselha.
**Tipo:** CONTRADIÇÃO. **Evidência:** acrescentar o campo em §10.3 e a coluna em §6.5, ou remover a menção de §11.3.

---

## F-45 — LOW — Os alvos de performance e memória são declarados para 5 comunidades; o limite do sistema é 50

**Local:** §19.1 (*"Boot até `core.ready` (**5 comunidades**, 50 k msgs) < 1,5 s"*; *"Memória do núcleo em repouso (**5 comunidades**) < 250 MiB"*). Contra §19.2 (*"Comunidades participadas | **50**"*) e ADR-16 (todas replicam em background).
**Problema:** os alvos não limitam a configuração suportada. Com 50 comunidades, 100 joins de tópico, 50 projetores reativos, 50 conjuntos de statements preparados e `mmap_size` de 256 MiB, nenhum dos dois números tem validade.
**Cenário:** um usuário no limite declarado (50 comunidades) sofre boot lento e consumo de memória fora do teto, sem que nada tenha sido violado formalmente.
**Consequência:** alvos que não cobrem o espaço de configuração declarado como suportado.
**Tipo:** REQUISITO INCOMPLETO. **Evidência:** medir em 50 comunidades e declarar alvos para o limite, não para um caso típico.

---

## F-46 — LOW — Duas citações `spec:NNN` apontam para o trecho errado

**Local:** §4.2 (*"`name` duplicado entre comunidades **é permitido** — não há unicidade global (`spec:1130`)"*) — a linha 1130 de `frontend.md` fala de **nome de canal** em outra comunidade; a referência correta seria a linha 861 (exceções de A3) ou 1045. §11.17 cita *"premissa 5 do backend"*, que não existe (ver F-18).
**Problema:** deriva de citação num documento que se apoia fortemente em citação cruzada como prova.
**Consequência:** baixa isoladamente; relevante porque o mecanismo de "isso já está resolvido na outra spec" é usado ~45 vezes, e uma citação errada esconde uma decisão não tomada — que é exatamente o que aconteceu em F-18.
**Tipo:** LOW / erro de referência. **Evidência:** revalidar as citações restantes (fiz uma amostragem ampla; as demais batem).

---

## F-47 — LOW — `replyToId` apontando para mensagem posteriormente deletada não tem comportamento definido em nenhum dos dois documentos

**Local:** §4.7 (`replyToId | opt | Mensagem do mesmo canal, **não deletada**` — condição de validação, no momento do envio); §4.18 (nenhuma invariante); §10.4 (`query.message | Mensagem + **resolvidos**`). `frontend.md` 2.1 (a citação renderizada "respondendo a X" com trecho) e §18 (nenhum edge case cobre isso).
**Problema:** a condição vale no envio e é violável depois; a UI renderiza um trecho que deixa de existir.
**Cenário:** Ana responde a Rafael. Rafael deleta. A linha de Ana continua com `reply_to_id` apontando para uma linha com `deleted_at`. `query.message` "resolve" o quê? A UI mostra "respondendo a (mensagem deletada)", o texto original (vazando conteúdo apagado), ou nada?
**Consequência:** estado alcançável e comum, sem comportamento definido; a leitura errada vaza conteúdo que a UI promete ter removido.
**Tipo:** ESTADO ALCANÇÁVEL SEM COMPORTAMENTO DEFINIDO. **Evidência:** definir em §10.4 e registrar o texto em 2.1.

---

## F-48 — LOW — `pending_mentions` é materializado mas depende dos cargos atuais do leitor, que mudam

**Local:** §4.15 (*"`pendingMentions` = subconjunto delas que menciona a identidade, **um cargo dela**, ou `everyone`"*); §6.3 (`local_read_state … pending_mentions`, *"Recalculado incrementalmente"*).
**Problema:** o critério depende de um conjunto (os cargos do leitor) que muda por op de terceiros (`member.setRoles`, `role.delete`), e não há regra de recálculo.
**Cenário:** Ana tem 4 menções pendentes vindas de `@Contribuidor`. Ela é promovida a Moderadora e perde Contribuidor. As 4 menções deveriam deixar de contar (ou não?). Nada diz. O contador fica congelado num valor derivado de um estado que não existe mais.
**Consequência:** badge de menção incorreta, persistente e inexplicável para o usuário.
**Tipo:** REQUISITO AUSENTE. **Evidência:** definir se menção por cargo é avaliada no momento da mensagem (histórica) ou continuamente, e adicionar a regra de recálculo em `roles.changed`/`members.changed`.

---

## F-49 — LOW — Relay voluntário não tem nenhum controle de abuso, e a `relayKey` fica permanentemente no log

**Local:** ADR-08; §4.14 (`relayKey` é campo replicado); §11.19; §20 (nenhuma variável `P2P_RELAY_*`); §18.1 (adversário "Voluntário de relay" está no modelo; **quem usa o relay** não está).
**Problema:** o voluntário oferece upload sem teto de banda, sem limite de sessões, sem allowlist e sem expiração. A `relayKey` está no log append-only e portanto é conhecida para sempre por qualquer pessoa que tenha replicado a comunidade — incluindo ex-membros e banidos, cujas réplicas locais permanecem.
**Cenário:** Diego se voluntaria. Meses depois é banido. Ele mantém a réplica local, lê a `relayKey` de Ana no log, e continua usando o upload dela. `relay.withdraw` resolve — se Ana perceber. Não há métrica de uso de relay em §17.3.
**Consequência:** um recurso opt-in de generosidade sem instrumentação, sem teto e sem revogação efetiva contra quem já leu o log.
**Tipo:** REQUISITO AUSENTE (segurança). **Evidência:** verificar se `blind-relay` oferece autorização por chave de cliente. Especificar teto de banda, TTL do anúncio e métrica de uso.

---

## F-50 — LOW — `identity.wipe` é declarado sem nenhum erro possível, embora apague o diretório de dados incluindo o LOCK que o processo detém

**Local:** §10.2 (`identity.wipe | {} | ✕ | {} (o núcleo reinicia) | **Erros: —** | 204`); §11.22 (*"apaga `p2p/` inteiro"*); §6.1 (`p2p/LOCK` está dentro de `p2p/`); §4.1 (*"**Não há confirmação no backend** — o comando é destrutivo e imediato"*).
**Problema:** apagar recursivamente um diretório que contém arquivos abertos (o LOCK, o WAL do SQLite, o RocksDB do corestore) falha em Windows e pode falhar parcialmente em qualquer SO. A tabela declara zero erros para a operação mais destrutiva e irreversível do produto.
**Cenário:** o wipe falha na metade em Windows: a chave foi apagada do keystore, mas `cores/` continua no disco. O núcleo reinicia em `awaiting-identity` com dados órfãos e um LOCK possivelmente pendurado (§2.3 → `E_CORE_ALREADY_RUNNING` no próximo boot). O usuário fica sem identidade **e** sem app.
**Consequência:** operação irreversível sem tratamento de erro nem estado de falha parcial.
**Tipo:** OPERAÇÃO SEM TRATAMENTO DE ERRO. **Evidência:** especificar a ordem (fechar tudo → soltar o lock → apagar → recriar) e os erros (`E_WIPE_INCOMPLETE` ou equivalente), incluindo o comportamento em falha parcial.

---

# UNRESOLVED QUESTIONS

Perguntas que o próprio par de documentos deixa sem resposta e que **bloqueiam** implementação. Distintas das "ambiguidades ainda abertas" de §26.2, que estão conscientemente adiadas.

| # | Questão | Bloqueia | Origem |
|---|---|---|---|
| Q-1 | Quem assina `member.join`, e onde a chave de identidade de quem entra é transportada? | Fase 4 inteira | F-06 |
| Q-2 | Como o host verifica a prova de um convite criado por outro membro? | Fase 4 | F-02 |
| Q-3 | Quem escreve no core de blobs, e por qual caminho? | Fase 5 | F-03 |
| Q-4 | Em que canal protomux vive o RPC pré-membro de convite? | Fase 4 | F-09 |
| Q-5 | O `blobsKey` é derivável do `coreKey`, ou o SQLite não é descartável? | ADR-02 inteira | F-01 |
| Q-6 | O validador do host lê de qual fonte de estado, e como ela vê os appends ainda não projetados? | Fase 2 | F-04 |
| Q-7 | Qual é a política de recuperação de `projector.failed`? Hoje não há nenhuma. | Fases 2+ | F-04 |
| Q-8 | Espectador de compartilhamento é participante do canal de voz — sim ou não? | Fase 7 | F-18 |
| Q-9 | Qualidade é escolhida por quem assiste (exige simulcast/SVC) ou pelo apresentador? | Fase 7 | F-08 |
| Q-10 | Qual é o caminho de mídia de áudio no fallback UDX? | Fase 6 | F-20 |
| Q-11 | O firewall recusa por comunidade ou por nó? E como o preview `banned` continua alcançável? | Fase 4 | F-10 |
| Q-12 | Reação, edição, pin e thread enfileiram com host offline, ou bloqueiam? | Fase 3 | F-15 |
| Q-13 | Não-lidas são coluna materializada ou query? | Fase 3 | F-25 |
| Q-14 | Como `mention_everyone` é enforçada sem quebrar assinatura nem a regra de camada? | Fase 2 | F-26 |
| Q-15 | Qual op corresponde a `community.leave`? | Fase 2 | F-24 |
| Q-16 | Qual é o ciclo de vida do cliente de quem foi expulso/banido? | Fase 2 | F-35 |
| Q-17 | Qual é a política de alocação das 128 conexões entre 50 comunidades, voz e obrigações de host? | Fase 3 | F-14 |
| Q-18 | Qual é o período de agregação do fan-out de presença/typing? | Fase 3 | F-13 |

---

# ADRs QUE PRECISAM DE VALIDAÇÃO

Nenhuma ADR foi aceita por estar escrita como ADR. Abaixo, o veredito de auditoria de cada uma que não sobreviveu ao ataque intacta.

| ADR | Status da auditoria | Achado | O que precisa ser medido/decidido antes de manter |
|---|---|---|---|
| **ADR-01** (host é a única autoridade) | **Parcialmente falsa como justificada.** Resolve *ordem*, não resolve *pré-condições*. A afirmação de §12.1 ("não existe conflito de escrita") não se sustenta com §6.6. | F-04 | Serializabilidade entre validação e append. |
| **ADR-02** (SQLite como view descartável) | **Falsa como escrita.** `blobsKey` e a lista de participações não são reconstruíveis do log. | F-01 | Derivar `blobsKey` do `coreKey` de forma determinística, ou mover para tabela local. |
| **ADR-03** (`better-sqlite3@13`) | **Condicional**, apesar de escrita como fechada. §23 diz que a fase 0 a "confirma". Cai junto se ADR-04 cair. | F-22 | Confirmar carga do `.node` empacotado nos 3 SOs; nomear o equivalente síncrono no caminho Bare. |
| **ADR-04** (`utilityProcess`) | **Condicional.** O plano B não é drop-in: derruba ADR-03 e o desenho síncrono de §6.4/§10.4/§12.4. | F-22 | Spike; e escrever a variante Bare de §6 antes de chamar Bare de "plano B". |
| **ADR-05** (mídia híbrida) | **Justificativa anulada pela ADR-07** no caminho de fallback. | F-20 | Especificar o áudio no fallback, ou reabrir ADR-07. |
| **ADR-06** (sem STUN, candidato do DHT) | **Premissa provavelmente incorreta.** O DHT conhece o mapeamento do socket do *núcleo*, não o do *renderer*. | F-19 | Experimento comparando o mapeamento DHT com o STUN por socket, em NAT port-restricted e symmetric. |
| **ADR-07** (UDX como fallback universal) | **Sem caminho de mídia especificado**; contradiz ADR-05. | F-20 | Protocolo de áudio com a profundidade de §10.8, ou reabertura. |
| **ADR-08** (relay por voluntários) | **Sem controle de abuso.** | F-49 | Autorização, teto de banda, TTL, métrica. |
| **ADR-09** (convite de 80 bits) | **Aritmética correta** (10 bytes = 80 bits = 16 caracteres Base32). A ADR em si sobreviveu; o **protocolo** que a usa não (F-02). | — | Nada na ADR; ver Q-2. |
| **ADR-10** (tombstone sempre) | **Sobreviveu**, mas agrava F-05: um registro venenoso não pode ser removido do log. | F-05 | Definir quarentena de registro na projeção, já que o log não pode ser corrigido. |
| **ADR-12** (idempotência por `opId`) | **Sobreviveu na aritmética** (7 d = 2,33× 72 h). Mas o *truncamento* do `opId` para id de entidade é um problema distinto. | F-05, F-36 | Nonce fresco por instância; id de entidade mais largo ou com tratamento de colisão. |
| **ADR-14** (efêmeros fora do core) | **Justificativa incompleta.** Argumenta o custo de log; não considera o custo de fan-out. | F-13 | Medir o fan-out na escala de referência. |
| **ADR-15** (não-lidas 100 % local) | **Ambígua na materialização**; quebra na reprojeção total. | F-25 | Decidir coluna vs query. |
| **ADR-16** (replicar tudo em background) | **Colide com o teto de 128 conexões** e com a política de alocação inexistente. | F-14 | Política de alocação e degradação nomeada. |
| **ADR-17** (árvore calculada pelo host) | **A população de "viewer" não está definida**; o critério de qualidade é incompatível com repasse opaco. | F-08, F-18, F-37 | Q-8, Q-9; e política de consentimento para quem entra tarde. |
| **ADR-19** (`safeStorage`) | Não encontrei evidência de problema. Ver "Áreas atacadas sem sucesso". | — | — |
| **ADR-20** (processo único com lock) | **Sobreviveu**, exceto pela interação com `identity.wipe`, que apaga o próprio lock. | F-50 | Ordem de shutdown no wipe. |

ADRs **não** listadas acima (ADR-11, ADR-13, ADR-18) foram atacadas e não produziram achado — o que significa "não encontrei evidência de problema", não "correto".

---

# REQUISITOS QUE PARECEM INCOMPLETOS

Superfícies onde a especificação obriga o implementador a inventar — o que §0 do backend proíbe explicitamente (*"se algo não estiver aqui, é buraco desta spec e deve ser levantado, não inventado"*).

1. **Entrada de membro** (`member.join`, prova de convite, transporte pré-membro, autoria) — F-02, F-06, F-09.
2. **Escrita e ciclo de vida de blobs** (quem escreve, por onde, teto de armazenamento no host, GC do lado do host) — F-03, F-41.
3. **Recuperação de projeção** — não existe nenhuma política para `projector.failed`, `E_INVARIANT` ou registro venenoso permanente — F-04, F-05, F-07, F-39, F-40.
4. **Contrato de `query.outbox`** — a única query de §10.4 sem schema, e é a que sustenta a premissa 5 — F-16.
5. **Classe de eventos não-reconsultáveis** — `voice.signal`, `share.assignment`, `message.accepted` precisam de política própria de entrega — F-17.
6. **Áudio no caminho de fallback** — F-20.
7. **Modelo de audiência de compartilhamento** — F-18, F-37.
8. **Política de agregação de efêmeros e de alocação de conexões** — F-13, F-14.
9. **Enforcement dos limites de §19.2** — a maioria não tem estágio em §9.3 — F-27.
10. **Comportamento do cliente do alvo de moderação** (kick/ban) — F-35.
11. **Estados alcançáveis sem comportamento**: `replyToId` órfão (F-47), canal sem nenhum cargo apto a postar (F-31), cargo deletado pendurado em `read_only_role_ids` (F-31), timeout na outbox (F-29), comunidade encerrada durante chamada de voz (não especificado em §11.21).
12. **Deltas de UX faltando em §25** — a lista tem 12 itens; esta auditoria encontrou pelo menos 6 que faltam: auto-save de edição (F-12), ações de mensagem com host offline (F-15), código de convite na lista de 3.1b (F-21), formato do `handle` (F-32), âncora temporal do relógio adiantado (F-33), e qualidade de compartilhamento escolhida pelo espectador (F-08).

---

# OVERALL ARCHITECTURE RISK ASSESSMENT

## Veredito

**A arquitetura tem falhas.** O ataque teve sucesso, e não em pontos periféricos: os seis achados CRITICAL atingem a autoridade de escrita (F-04), o único caminho de entrada do produto (F-02, F-06), o único caminho de anexos (F-03), a premissa que sustenta a ADR-02 (F-01) e a integridade da projeção (F-05). Nenhum deles é um detalhe de implementação; todos exigem decisão de contrato antes que qualquer código da fase 2 seja escrito.

Ao mesmo tempo — e isto precisa ser dito com a mesma clareza — **este é um documento de qualidade muito acima da média**. Ele é internamente rastreável, cita suas fontes, fecha 34 ambiguidades nomeadas, declara suas limitações, mantém uma seção de deltas obrigatórios contra a spec irmã, e antecipa boa parte dos seus próprios riscos em §24 e §26.2. A razão pela qual esta auditoria produziu 50 achados não é que o documento seja fraco; é que ele é **específico o suficiente para ser falsificável**. Uma spec vaga não teria produzido nenhum destes achados — teria produzido os mesmos bugs, seis meses depois, em código.

## Onde o risco se concentra

| Área | Nível | Comentário |
|---|---|---|
| **Log, ordem e idempotência** | Baixo | ADR-01/ADR-12 são sólidas no que se propõem. Ordem canônica por `seq`, dedupe por hash de envelope e tombstone universal são escolhas defensáveis e coerentes. |
| **Modelo de permissões e hierarquia** | Baixo-médio | As duas regras acrescentadas em §8.3 são corretas e importantes. As falhas encontradas são de borda (F-38, F-31), não estruturais. |
| **Projeção e recuperação** | **Alto** | O ponto mais frágil. Quatro caminhos independentes levam a uma parada permanente sem recuperação, e o modelo de teste (§21.4) não cobre nenhum deles. |
| **Entrada de membros (convites)** | **Crítico** | Duas impossibilidades independentes (F-02, F-06) e uma falta de transporte (F-09) na porta única do produto. |
| **Anexos** | **Crítico** | Sem caminho de escrita construível. |
| **Voz e ICE** | **Alto** | A ADR-06 apoia-se numa equivalência DHT≈STUN que provavelmente não vale, e a ADR-07 empurra o resto para um caminho não especificado que anula a ADR-05. |
| **Compartilhamento de tela** | **Alto** | A entidade central (espectador) não está definida, e a qualidade por espectador é incompatível com repasse opaco. §23 já reconhece esta fase como a mais arriscada e a única cortável — a auditoria concorda e reforça. |
| **Escala** | **Alto, e mal instrumentado** | O teto de conexões é menor que a comunidade de referência; o fan-out efêmero não é medido nem limitado; alvos de performance param em 1/10 do limite declarado. |
| **Segurança** | Médio-alto | O modelo de ameaça de §18.1 é bem construído para as ameaças que prevê, mas omite a categoria mais barata: **negação de serviço contra a projeção** (F-05, F-41), acessível a qualquer membro comum. |
| **Coerência com a spec de UX** | Médio | §25 é um instrumento excelente e raro. Está incompleto em ao menos 6 itens, e um deles (F-12) invalida o padrão de interação de três telas. |

## Risco de cronograma

O plano de §23 tem uma dependência que a auditoria confirma como correta (*"Nada mais começa antes do spike da fase 0"*) e uma que ela contesta: a fase 2 ("Log e projeção") é apresentada como pronta para começar após o spike, mas depende de Q-6 e Q-7, que não têm resposta. A fase 4 (convites) está bloqueada por três achados CRITICAL, e a fase 5 (anexos) por um. **Na leitura desta auditoria, quatro das nove fases não têm contrato executável hoje.**

O custo de fechar tudo isso é de decisão e de texto, não de reescrita: nenhum achado exige jogar fora a forma geral da arquitetura (host autoritativo + Hypercore cru + projeção SQLite + mídia híbrida). Os seis CRITICAL são localizados e todos têm caminho de correção identificável. O que **não** é barato é o conjunto F-19/F-20 (ICE e fallback de áudio), porque ali a correção pode custar uma reabertura de ADR com trabalho de engenharia real por trás.

## Recomendação de sequenciamento (sem propor solução, apenas ordem de decisão)

1. **Antes de qualquer código:** Q-1 a Q-7. São seis decisões de contrato e uma política de recuperação; todas são texto.
2. **Junto do spike da fase 0:** validar a viabilidade de ADR-03 no caminho Bare (F-22), porque o resultado muda §6 inteira.
3. **Antes da fase 6:** o experimento de F-19. Se a ADR-06 cair, a fase 6 muda de escopo.
4. **Antes da fase 7:** Q-8 e Q-9. Sem isso o algoritmo "fechado" de §11.17.1 não tem entrada definida.
5. **Contínuo:** completar §25 com os 6 deltas faltantes, porque eles afetam telas já implementadas e verificadas.

## Áreas atacadas sem sucesso

Registro explícito, conforme pedido — **"não encontrei evidência de problema" não é o mesmo que "está comprovadamente correto"**. Ataquei os pontos abaixo e não consegui derrubá-los com a informação disponível nos documentos:

- **Aritmética da ADR-09** (10 bytes → 80 bits → 16 caracteres Crockford Base32): correta. A remoção de `I`, `L`, `O`, `U` é justificada e o alfabeto resultante fecha a conta.
- **Janela de dedupe da ADR-12**: 7 d / 72 h = 2,33×, como afirmado.
- **Aritmética da projeção** (§6.4): 200 k registros a 8–15 k/s ≈ 20 s, e ~50 µs/op de Ed25519 ≈ 20 k verificações/s — internamente consistentes.
- **Catálogo de 17 permissões**: bate 1:1, item a item, com o checklist de `frontend.md` 3.2. Não encontrei permissão órfã nem faltante.
- **Argumento das três camadas de autenticação (§7)**: o raciocínio de por que a verificação na réplica é necessária além do handshake e da assinatura da op está correto e fecha `ID-17` de fato.
- **Ordenação de listas (§15.2)** contra `frontend.md` §14: bate item a item.
- **Modelo de durabilidade da outbox (ADR-11)** contra a premissa 5 da UX: coerente. As falhas que encontrei nessa área (F-16, F-29, F-30) são de contrato de leitura e de política de erro, não do modelo de durabilidade.
- **Separação replicado / efêmero / local (§4.0)**: a taxonomia é correta e a advertência ("confundir os três é o erro mais caro possível neste projeto") é acertada. `muted` local vs `readOnlyForRoleIds` replicado está certo.
- **`safeStorage` (ADR-19)**: a análise de alternativas é honesta e a conclusão ("não há fallback") é a única coerente com "não existe conta central".
- **Regra de redação de log por allowlist (§17.2)**: a escolha de allowlist sobre blocklist está correta pelo motivo declarado.
- **Não encontrei** problema de arredondamento, de fuso ou de formatação em §5.10 da UX contra as convenções de §0.4 do backend (epoch em ms UTC, formatação no renderer). A divisão de responsabilidade está certa; a única falha ali é a âncora temporal de F-33.

---

*Fim do laudo. 50 achados: 6 CRITICAL, 16 HIGH, 21 MEDIUM, 7 LOW. 18 questões bloqueantes. 16 ADRs requerendo validação, das quais 5 com premissa contestada.*
