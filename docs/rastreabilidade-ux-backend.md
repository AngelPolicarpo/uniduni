# Matriz de Rastreabilidade UX/UI ↔ Backend — Uniduni

> Verificação de rastreabilidade entre `docs/frontend.md` (Spec de UX/UI), `docs/backend.md`
> (Especificação Técnica do Backend), o frontend mockado já em código (`frontend/src/`, 18 407
> linhas) e as três auditorias existentes (`auditoria-adversarial.md`,
> `auditoria-sistemas-distribuidos.md`, `dry-run-implementacao.md`, `threat-model-seguranca.md`).
> **Este documento não corrige nenhuma spec** — só registra o que está rastreado, o que não está,
> e onde os documentos se contradizem.

## 0. Método, escopo e convenções

**Documentos lidos integralmente:** `frontend.md` (1 605 linhas), `backend.md` (2 986 linhas), e
as quatro auditorias (`auditoria-adversarial.md` 1 073, `auditoria-sistemas-distribuidos.md`
1 438, `dry-run-implementacao.md` 1 357, `threat-model-seguranca.md` 3 249).

**Cadeia verificada por comportamento** (a coluna vazia significa "não se aplica a este
comportamento", nunca "não verifiquei"):

```
requisito de UX → estado/ação no frontend → comando IPC → operação de backend (kind/reducer)
  → RPC P2P → persistência → projeção → evento de atualização → estado final na UI → erro
```

**Convenções de citação:**

- `frontend.md:N` e `backend.md:N` referenciam linha exata.
- `spec:N` dentro de `backend.md` **resolve para `frontend.md:N`** — verifiquei os 14 alvos
  citados em §25, §16.3 e §11 (`spec:47`, `124`, `510`, `653`, `776`, `875`, `974`, `1134`,
  `1136`, `1166`, `1339`, `1469`, `1532`, `1598`) e todos apontam para o trecho correto.
- Achados já documentados nas auditorias são referenciados pelo id delas (`F-nn`, `DS-nn`,
  `DR-nn`, `T-nn`) — **não foram reescritos aqui**. Os achados novos desta análise recebem id
  `RT-nn`.
- **Precedência entre documentos** (`backend.md:36-48`): a spec de UX é a fonte de produto; onde
  a arquitetura a contradiz, `backend.md` §25 lista os deltas obrigatórios. Um item que **não**
  está em §25 e mesmo assim diverge é, por definição do próprio documento, uma inconsistência
  não reconhecida.

**Regra de avaliação aplicada:** "existe um comando IPC" nunca foi aceito como evidência.
Para uma linha ser `COMPLETE` exigi: comando **e** operação persistida (ou justificativa
explícita de local-only) **e** projeção/leitura **e** evento de invalidação **e** estado de erro
com destino na UI. Uma cadeia que perde qualquer elo vira `PARTIAL`.

**Estado do frontend:** o mock está inteiro em código. `frontend.md:1483-1485` declara "toda a
spec de §7 a §11 está em código"; a única pendência é o rail vertical em Mobile
(`frontend.md:1581`). Isso torna a comparação **fixture × modelo real** verificável no código,
não só no texto — e é onde estão vários dos achados abaixo.

---

## 1. Sumário executivo

| Métrica | Resultado |
|---|---|
| Comportamentos de UX rastreados ponta a ponta | 117 |
| `COMPLETE` | 38 (32 %) |
| `PARTIAL` | 50 (43 %) |
| `MISSING` | 16 (14 %) |
| `CONTRADICTORY` | 12 (10 %) |
| `UNCLEAR` | 1 (1 %) |
| Inconsistências novas desta análise (`RT-01`..`RT-15`) | 15 |
| Inconsistências já documentadas que a matriz confirma | 34 |
| Capacidades de backend sem uso na UX | 11 |

**Onde o risco se concentra**, em ordem:

1. **Contratos de leitura.** Nenhuma das 17 queries de `§10.4` tem schema de resposta
   (`DR-46`). Isso não é detalhe de implementação: cinco superfícies de UX exibem dados que
   **nenhuma query promete devolver** (quem reagiu, não-lidas de thread, participantes de canal
   de voz alheio, código de convite de terceiros, preferências de notificação).
2. **O eixo otimista.** A UX é otimista em toda a Camada 2 (`frontend.md:397`), o backend só é
   assíncrono em `message.send` (`backend.md:1476-1479`). Reagir, editar, fixar e criar thread
   são RPC síncronos de 30 s que falham com host offline, sem rollback especificado (`F-15`).
3. **Estados visuais sem estado de backend.** Anel de fala ativa (`DR-42`), avatares inline de
   canal de voz (`RT-05`), progresso de árvore por espectador (`DS-14`).
4. **Divergências de fixture.** O dataset de referência de `frontend.md:73-124` — que 206
   checagens de verificação usam — não é produzível pelo modelo real em pelo menos quatro
   pontos (`handle`, código de convite, espectadores × participantes, carimbo de mensagem).
---

## 2. Cadeias de rastreabilidade

Legenda das células: `—` = não se aplica · `✗` = elo ausente · `⚠` = elo existe mas diverge.
Onde há divergência, a célula aponta o id do achado (`RT-nn` novo, `F/DS/DR/T-nn` já
documentado).

### 2.1 Identidade e presença

| # | Comportamento UX | Frontend | IPC | Op / reducer | RPC | Persistência → Projeção | Evento → UI final | Erro | Status |
|---|---|---|---|---|---|---|---|---|---|
| I-1 | Criar identidade local (A1, `frontend.md:410-420`) | `identityStore.createIdentity` (`identityStore.ts:45`) | `identity.create` (`backend.md:1420`) | — (não é op de log) | — | keystore via `safeStorage` (ADR-19) + `meta` → sem projeção | `core.ready{phase}` → Hub vazio (0.2) | `E_IDENTITY_EXISTS`, `E_VALIDATION`, `E_KEYSTORE_UNAVAILABLE` | **COMPLETE** |
| I-2 | Editar nome/cor do avatar (3.1, `frontend.md:704`) | `identityStore.updateIdentity` (`:67`) | `identity.update` (`backend.md:1421`) | `identity.update` — **uma op por comunidade** (`backend.md:957`, `:299-301`) | `submitOp` × N | log de cada comunidade → `members.display_name` | `members.changed` → nome novo em todas as telas | `E_VALIDATION`; colisão de PK na outbox se o nonce não for por comunidade (`F-36`) | **PARTIAL** |
| I-3 | Seletor de presença, 4 estados (3.1 + 1.4, `frontend.md:704`, `:534`) | `identityStore.setPresence` (`:60`) | `identity.setPresence` (`backend.md:1422`) | efêmero, nunca persiste (`backend.md:826`) | `presencePublish` (`backend.md:1665`) | ✗ nada em disco (por desenho) | `presence.changed{entries[]}` → dot de presença | `E_VALIDATION`; perda sem política declarada (`DS-30`) | **COMPLETE** |
| I-4 | "Invisível" continua recebendo tudo (`frontend.md:534`) | idem | idem | não publica presença (`backend.md:832-834`) | — | — | ausência de evento → outros veem offline | — · exposição de IP no DHT contradiz a promessa (`T-24`) | **PARTIAL** |
| I-5 | "Sair desta identidade" com confirmação (3.1, `frontend.md:704`) | `identityStore.clearIdentity` (`:82`) | `identity.wipe` (`backend.md:1423`) | apaga `p2p/` inteiro, reinicia núcleo (`backend.md:2096-2099`) | — | destrói cores + SQLite + blobs + chave | núcleo em `awaiting-identity` → volta a 0.1 | **declarado sem nenhum erro possível** apesar de apagar o LOCK do processo (`F-50`) | **PARTIAL** |
| I-6 | Identificador local exibido `@ana` (3.1, 1.4, §2) | `handleFromDisplayName()` (`identityStore.ts:50`) — **deriva do nome** | resposta de `identity.create` traz `handle` | `handle` = `@` + 6 chars de base32(publicKey), não único (`backend.md:289`) | — | não persiste (derivado) | — → popover 1.4, 3.1, lista de banidos | — | **CONTRADICTORY** (`F-32`, `DR-09`, `T-29`) |

**Nota I-6:** o mock deriva o handle do nome de exibição; o backend deriva da chave pública.
Nenhum dos dois produz `@ana` nem `Usuário#4471`, que são os dois formatos que o dataset de §2 e
a tela 3.3 usam. As 206 checagens de verificação declaradas nas Partes 1-11 assumem o formato do
mock.

### 2.2 Convites e entrada (A2)

| # | Comportamento UX | Frontend | IPC | Op / reducer | RPC | Persistência → Projeção | Evento → UI final | Erro | Status |
|---|---|---|---|---|---|---|---|---|---|
| C-1 | Colar código/link, preview antes de entrar (0.3, `frontend.md:432-450`) | `inviteStore.setPendingInvite` + `resolveInvite()` (`dataset.ts:790-813`) | `invite.resolve{codeOrLink}` (`backend.md:1497`) | — (leitura no host) | `inviteResolve{challenge, proof}` (`backend.md:1656`) | nada local | resposta síncrona → card de preview | `E_MALFORMED`; **6 desfechos no backend × 4 na UX** | **CONTRADICTORY** (`RT-01`) |
| C-2 | Desfecho "banido": preview reduzido, sem contagem nem convidador (`frontend.md:445`) | `{status:"banned", communityName}` (`types.ts:239`) | idem | — | `inviteResolve` | — | → preview acinzentado, só "Cancelar" | firewall do swarm corta a conexão **antes** do preview → estado inalcançável | **CONTRADICTORY** (`F-10`, `DS-08`) |
| C-3 | Entrar na comunidade (A2 passo final) | `communityStore.joinCommunity` (`:124`) | `invite.redeem` (`backend.md:1498`) | `member.join` appendada **pelo host** (`backend.md:954`) | `inviteRedeem` → `{seq, coreKey, blobsKey, defaultChannelId}` | 2 cores novos + projeção do zero | `community.joined` + `members.changed` → shell no 1º canal de texto | `E_INVITE_INVALID`, `E_INVITE_EXHAUSTED`, `E_BANNED`, `E_HOST_UNAVAILABLE` | **PARTIAL** (`F-06`: ninguém consegue produzir `member.join`) |
| C-4 | Criar convite com expiração/limite (3.1b, `frontend.md:718`) | `communityStore.createInvite` (`:134`) | `invite.create` (`backend.md:1495`) | `invite.create{codeHash, expiresAt?, maxUses?}` (`backend.md:976`) | `submitOp` | log (só o hash) + `invites.secret` **só na réplica de quem criou** | ✗ **não há evento de convite** (`F-34`) → lista não atualiza sozinha | `E_INVITE_LIMIT` (>50) | **PARTIAL** |
| C-5 | Lista de convites ativos com **código** e "copiar link" (3.1b) | `createdInvites[]` (`communityStore.ts:121`) | `query.invites` (`backend.md:1626`) | — | — | `invites` (`backend.md:1064`) | — → tabela com código, criado por, usos, expiração | — | **MISSING** (`F-21`) — o `code` só existe para quem criou |
| C-6 | Revogar convite, sem confirmação (`frontend.md:718`, §15) | `communityStore.revokeInvite` (`:135`) | `invite.revoke{communityId, codeHash}` (`backend.md:1496`) | `invite.revoke` (`backend.md:977`) | `submitOp` | `invites.revoked_at` | ✗ sem evento (`F-34`) → linha some por reconsulta manual | `E_NOT_FOUND`; **permissão diverge**: §8.1 × §5.3 × §10.2 (`DR-26`) | **PARTIAL** |
| C-7 | Código curto de 6 caracteres (`X7K2QM`, `frontend.md:124`) | `x7K2qM` em `dataset.ts:727`, gerador de 6 chars em `communityStore.ts:445` | — | — | — | — | — | — | **CONTRADICTORY** — §25 delta 2 exige **16 chars em 4 grupos** |
| C-8 | Rota `/invite/:code` resolvendo fora do app (`frontend.md:211`) | `InviteRoute.tsx` + `inviteStore` persistido | `invite.resolve` | — | `inviteResolve` | `pendingInviteCode` em localStorage | — → onboarding e retomada do preview | parsing do código/link **sem regra definida** (`DR-34`) | **PARTIAL** |

### 2.3 Comunidade

| # | Comportamento UX | Frontend | IPC | Op / reducer | RPC | Persistência → Projeção | Evento → UI final | Erro | Status |
|---|---|---|---|---|---|---|---|---|---|
| K-1 | Criar comunidade / virar host (A3, 0.4) | `communityStore.createCommunity` (`:125`) | `community.create` (`backend.md:1432`) | **lote atômico de 6 ops** (`backend.md:1731-1734`) | — (é local) | 2 cores + 6 registros + projeção completa | `community.joined` + `structure.changed` → rail + `#geral` | `E_STORAGE_FULL`; `swarm.join` falha → `hosting-degraded` (estado **sem token de UI**) | **PARTIAL** |
| K-2 | Aviso permanente "fica hospedada neste dispositivo" (`frontend.md:456`) | texto fixo em `CreateCommunityModal.tsx` | — | — | — | — | — | — | **COMPLETE** (só texto) |
| K-3 | Editar nome/ícone/descrição com **auto-save de 800 ms** (3.1b, §13) | `useAutoSave.ts` + `communityStore.updateCommunity` (`:133`) | `community.update` ⏱ (`backend.md:1433`) | `community.update`, **auditável** (`backend.md:974`) | `submitOp` (30 s) | log → `communities` | `community.changed{fields[]}` → toast "Alterações salvas" | `E_PERMISSION_DENIED`, `E_HOST_UNAVAILABLE`, `E_VALIDATION` | **CONTRADICTORY** (`F-12`) |
| K-4 | Sair da comunidade, com confirmação (§15) | `communityStore.leaveCommunity` (`:137`) | `community.leave` ⏱ (`backend.md:1435`) | ⚠ **não existe `kind` `community.leave`** — só `member.leave` (`backend.md:955`, `F-24`) | `submitOp` | ciclo de vida do dado local **indefinido** (`DR-35`, `F-35`) | `community.left` → comunidade some do rail | `E_HOST_CANNOT_LEAVE` | **PARTIAL** |
| K-5 | Encerrar comunidade (host), dupla confirmação (`frontend.md:718`) | `communityStore.endCommunity` (`:138`) | `community.end` ⏱ (`backend.md:1434`) | `community.end`, terminal (`backend.md:975`) | `submitOp` | `communities.ended_at`; core mantido em leitura | `community.ended` → rail em modo histórico | `E_NOT_HOST`, `E_COMMUNITY_ENDED`; sai do swarm antes de garantir replicação (`DR-36`) | **PARTIAL** |
| K-6 | Rail: ordem de entrada, traço de não-lida, badge de menção (1.1, `frontend.md:477`) | `selectCommunityUnread` + `CommunityIcon` | `query.communities` → `unread:{count,mentions}` (`backend.md:1614`) | — | — | `local_read_state` (`backend.md:1075`) | `unread.changed{unreadCount, pendingMentions}` | — · reprojeção total conta em dobro (`F-25`); `pending_mentions` depende de cargos que mudam (`F-48`) | **PARTIAL** |
| K-7 | Comunidade silenciada em 3.1 não mostra traço nem badge (`frontend.md:477`) | `settingsStore.notificationByCommunity` | `settings.setNotifications` (escrita) | — | — | `local_community_pref.notification_level` (`backend.md:1077`) | — | ✗ **não há query de leitura de preferências** | **MISSING** (`RT-02`) |
| K-8 | Rótulo "Inativa há muito tempo" após ~30 dias (§18, `frontend.md:1120`) | não implementado no mock | `query.hostStatus` → `{status, lastSeenAt, inactiveDays}` (`backend.md:1631`) | — | — | `local_community_pref.last_host_seen_at` | — → rótulo no rail | — | **PARTIAL** (backend pronto, UI ausente) |

### 2.4 Estrutura: canais e categorias (3.4)

| # | Comportamento UX | Frontend | IPC | Op / reducer | RPC | Persistência → Projeção | Evento → UI final | Erro | Status |
|---|---|---|---|---|---|---|---|---|---|
| E-1 | Criar canal (D14), slug ao vivo, entra no fim (`frontend.md:764-769`) | `communityStore.createChannel` (`:159`) | `channel.create` ⏱ (`backend.md:1441`) | `channel.create` (`backend.md:937`), **auditável** | `submitOp` | log → `channels` (`uniq_channels_name`) | `structure.changed` → navega para o canal, composer focado | `E_CHANNEL_NAME_TAKEN` (inline no blur), `E_CHANNEL_NAME_EMPTY`, `E_HOST_UNAVAILABLE` (**não enfileira**) | **COMPLETE** |
| E-2 | Editar canal com **auto-save** + zona de perigo (`frontend.md:771`) | `useAutoSave` + `updateChannel` (`:160`) | `channel.update` ⏱ (`backend.md:1442`) | `channel.update` (`backend.md:938`) | `submitOp` | `channels` | `structure.changed` → toast "Alterações salvas" | rate limit de estrutura 20/60 s (`backend.md:2593`) vs. debounce de 800 ms | **CONTRADICTORY** (`F-12`) |
| E-3 | Mover canal trocando a categoria no modal (`frontend.md:771`) | `moveChannel` (`:162`) | `channel.move` ⏱ (`backend.md:1443`) | `channel.move` (`backend.md:939`) | `submitOp` | `channels.category_id`, `position` no fim | `structure.changed` | `E_CATEGORY_NOT_FOUND` | **COMPLETE** |
| E-4 | Excluir canal com confirmação nomeada + nota P2P (`frontend.md:776`) | `deleteChannel` (`:163`) | `channel.delete` ⏱ → `{seq, droppedQueued}` (`backend.md:1444`) | `channel.delete` (`backend.md:940`), auditável | `submitOp` | tombstone `deleted_at` | `structure.changed` + `message.dropped` × N → toast + frase nomeada | `E_LAST_CHANNEL` (item some do menu) | **COMPLETE** |
| E-5 | Excluir canal de voz com gente dentro (D15, `frontend.md:777`) | idem + `voiceStore` | idem | host encerra a sessão (`backend.md:1881-1886`) | — | — | `voice.failed{reason:"channel-deleted"}` → barra de chamada some | — | **COMPLETE** |
| E-6 | Criar / renomear / excluir categoria, 2 caminhos (`frontend.md:778`) | `createCategory` (`:164`), `renameCategory` (`:165`), `deleteCategory` (`:170`) | `category.create` / `.rename` / `.delete` (`backend.md:1445-1447`) | 3 `kind`s (`backend.md:941-943`) | `submitOp` | `categories` | `structure.changed` | `E_VALIDATION`, `E_LAST_CHANNEL` | **COMPLETE** |
| E-7 | Colapsar categoria, lembrado por comunidade (`frontend.md:476`) | `toggleCategoryCollapsed` (`:128`) | `category.setCollapsed` — **local** (`backend.md:1450`) | — | — | `local_community_pref.collapsed_categories` | — | — | **COMPLETE** |
| E-8 | Gatilhos desabilitados com host offline, com tooltip (`frontend.md:791`) | `ChannelContextMenu` + `useHostStatus` | — | ops de estrutura **não enfileiram** (`backend.md:1843-1846`) | — | — | `host.wentOffline` → "+" visível e desabilitado | `E_HOST_UNAVAILABLE` na hora | **COMPLETE** |
| E-9 | Silenciar canal (1.1.1) — preferência local de quem lê | `toggleChannelMuted` (`:177`) | `channel.setMuted` — local (`backend.md:1448`) | — | — | `local_channel_pref.muted` | — → ícone de mudo, sem destaque de não-lida | — | **COMPLETE** |
| E-10 | Marcar como lido — zera contador **e menções** (`frontend.md:489`) | `markChannelRead` (`:178`) | `channel.markRead` → `{unreadCount:0}` (`backend.md:1449`) | — | — | `local_read_state` | `unread.changed` → divisor vai pro fim | ⚠ o retorno só declara `unreadCount`, não `pendingMentions` | **PARTIAL** (`RT-03`) |
| E-11 | "Copiar link do canal" → `/m/:code` da 1ª não lida (`frontend.md:533`) | `ChannelContextMenu.tsx`, `messageLink.ts` | rota consumida pelo renderer via `encodeMessageRef` (1ª não lida) e oculta se vazio | — | — | — | — → toast "Link copiado" | — | **COMPLETE (UI)** (`RT-04`) |
| E-12 | Canal de voz lista **participantes inline** na sidebar (1.1, `frontend.md:473`) | `Channel.voiceParticipantIds` (`types.ts:145`) | `query.structure` devolve só `live` (`backend.md:1616`) | — | `voiceRoster` é enviado **só aos participantes** (`backend.md:1681`) | efêmero, não persiste | — → avatares inline + pill "AO VIVO" | — | **MISSING** (`RT-05`) |
### 2.5 Mensagens (2.1, C9, B4)

| # | Comportamento UX | Frontend | IPC | Op / reducer | RPC | Persistência → Projeção | Evento → UI final | Erro | Status |
|---|---|---|---|---|---|---|---|---|---|
| M-1 | Enviar mensagem, bolha otimista (C9, `frontend.md:930-940`) | `messageStore.send` (`:126`) | `message.send` → `{opId, state}` **imediato** (`backend.md:1467`) | `message.send` (`backend.md:926`) | `submitOp` → `{seq, hostTs}` | `local_outbox` → core do host → `messages` | `message.accepted{clientRef}` → `messages.appended` → bolha assenta | `E_VALIDATION` síncrono (inline), `E_CHANNEL_READ_ONLY`, `E_OUTBOX_FULL` | **PARTIAL** — `message.accepted` não carrega `clientRef` (`F-44`); janela `accepted`→`appended` sem dono (`DR-19`) |
| M-2 | Fila offline durável, reaparece ao reabrir (premissa 5, B4) | `messageStore` com `persist`+`partialize` só da fila (`frontend.md:1594`) | `query.outbox` (`backend.md:1630`) | — | — | `local_outbox` (`backend.md:1137-1151`) | `outbox.changed{queued, failed}` → banner soma a contagem | 72 h → `dropped/expired` | **PARTIAL** (`F-16`: `query.outbox` sem contrato; conteúdo só no BLOB do envelope, que o renderer não decodifica) |
| M-3 | Mensagem pendente na **posição cronológica** (`frontend.md:875`) | ícone de relógio na linha | — | — | — | — | ao entregar, **assenta no fim** (`backend.md:1785`) | — | **CONTRADICTORY** — reconhecido em §25 delta 4 |
| M-4 | Descarte nomeado da fila (§18, `frontend.md:1136`) | `messageStore.dropQueued` (`:64`) | *(evento)* | — | — | `outbox.drop(channelId, reason)` | `message.dropped{reason}` × N → "2 mensagens não foram enviadas: #x não existe mais" | 6 motivos (`backend.md:1898`), **3 inalcançáveis** (`DS-08`) | **PARTIAL** |
| M-5 | Reagir — chip "salta" na hora (§17, `frontend.md:1103`) | `toggleReaction` (`:54`) | `message.react` ⏱ **30 s síncrono** (`backend.md:1473`) | `reaction.toggle` (`backend.md:930`) | `submitOp` | `reactions` PK `(message_id, emoji, identity_key)` | `message.updated` | `E_REACTION_LIMIT`; **com host offline falha, sem rollback especificado** | **CONTRADICTORY** (`F-15`) |
| M-6 | Hover no chip mostra até 6 nomes + "e mais N" (`frontend.md:550`) | `Reaction.userIds` (`types.ts:168`) | ✗ nenhuma query devolve os reatores | — | — | `reactions.identity_key` **existe** (`backend.md:1062`) | — | — | **MISSING** (`DR-47`) — dado está no banco, não tem porta |
| M-7 | Responder inline (`replyToId`) | `send({replyToId})` | `message.send` | idem | `submitOp` | `messages.reply_to_id` | `messages.appended` → "respondendo a X" | alvo deletado depois: **sem comportamento definido** (`F-47`) | **PARTIAL** |
| M-8 | Responder em thread (2.2) | `createThread` (`:50`) | `thread.create` ⏱ (`backend.md:1474`) | `thread.create` (`backend.md:931`) | `submitOp` | `threads` | `message.updated` → painel de thread | `E_THREAD_EXISTS`; falha com host offline | **PARTIAL** (`F-15`) |
| M-9 | Badge de não-lidas da thread ("💬 N respostas", `frontend.md:596`) | `Thread.unreadCount` (`types.ts:215`) | ✗ `query.thread` não devolve contagem | — | — | ✗ `local_read_state` é **por canal** (`backend.md:1075`) | `unread.changed` é por canal | — | **MISSING** (`DR-48`) |
| M-10 | Fixar / desafixar (`pin_messages`) | `setPinned` (`:55`) | `message.pin` ⏱ (`backend.md:1472`) | `message.pin`, última escrita vence (`backend.md:929`) | `submitOp` | `messages.pinned` + `idx_messages_pinned` | `message.updated` → aba Fixados (`query.pinned`) | falha com host offline | **PARTIAL** (`F-15`) |
| M-11 | Editar a própria mensagem (`frontend.md:1053`) | `editMessage` (`:56`) | `message.edit` ⏱ (`backend.md:1470`) | `message.edit` (`backend.md:927`) | `submitOp` | `messages.edited_at` | `message.updated` → "(editado)" | `E_CANNOT_EDIT_OTHERS`, `E_MESSAGE_DELETED` | **PARTIAL** — conteúdo antigo fica no log; §25 delta 10 |
| M-12 | Deletar: própria sem confirmação, de outro com modal (`frontend.md:1339`) | `deleteMessage` (`:57`) | `message.delete` ⏱ (`backend.md:1471`) | `message.delete`, hierarquia se de outro (`backend.md:928`) | `submitOp` | `deleted_at` + apaga reações + remove da FTS + sai de Fixados, **mesma transação** | `message.updated` → some da lista | `E_PERMISSION_DENIED`, `E_HIERARCHY` | **PARTIAL** — texto "Não pode ser desfeito" é falso para os bytes; §25 delta 1 |
| M-13 | Menções `@membro` / `@cargo` / `@everyone` (2.1.1) | `mentions.ts` + `MentionAutocomplete` | `message.send{mentions[]}` | `messages.mentions` JSON, ≤64 | `submitOp` | `messages.mentions` | `messages.appended{hasMention}` → pill `accent-muted-bg` | sem `mention_everyone` a op é **aceita com a menção removida** (`backend.md:565-568`) — **sem ponto de aplicação construível** (`T-31`, `F-26`) | **PARTIAL** |
| M-14 | "X está digitando…" (`frontend.md:550`) | `setTyping` (`:58`) | *(evento)* | efêmero, TTL 5 s / refresh 3 s | `presencePublish{typingChannelId}` | ✗ nunca persiste (por desenho) | `typing.changed{identityKeys[]}` | perda sem política declarada (`DS-30`) | **COMPLETE** |
| M-15 | Divisor "Novas mensagens" / pular pra 1ª não lida | `firstUnreadMessageId` (`types.ts:141`) | `query.structure` / `query.messages` | — | — | `local_read_state.first_unread_seq` (`backend.md:1075`) | `unread.changed` | — | **COMPLETE** |
| M-16 | Scroll infinito, lotes de ~50 (§14, `frontend.md:1057`) | `MessageList` | `query.messages{cursor, limit=50, direction}` (`backend.md:1617`) | — | — | `idx_messages_channel(channel_id, seq DESC)` | — | `E_BAD_CURSOR` → recomeça do início | **COMPLETE** |
| M-17 | Carimbo de mensagem e relógio adiantado (§5.10, `frontend.md:371`) | `lib/format.ts` `isClockAhead`/`displayDate`; `Message.timestamp` **único** (`types.ts:197`) | — | — | — | `messages.author_ts`, `host_ts`, `clock_skewed` (`backend.md:1059`) | — → tooltip "O relógio de quem enviou está adiantado" | — | **CONTRADICTORY** (`F-33`, `T-26`) — UX manda exibir **hora local de chegada**, backend manda exibir `hostTs`, o mock não tem nenhum dos dois |
| M-18 | "Copiar link da mensagem" → `/m/:code` (`frontend.md:550`) | `lib/messageLink.ts` (base64url) | ✗ nenhum comando gera; ✗ nenhuma query resolve | — | — | — | — → toast "Link copiado" | os 3 desfechos de `frontend.md:212` não têm origem no backend | **MISSING** (`RT-04`) |
| M-19 | Markdown básico renderizado (§0 premissa 8) | `lib/markdown.tsx` | — | `content` cru no log (`backend.md:549`) | — | `messages.content` | — | ✗ **sem allowlist de esquema de URL** (`T-18`) | **PARTIAL** |
| M-20 | Composer bloqueado em canal somente-leitura (`#avisos`) | `selectIsChannelReadOnly` (`communityStore.ts:1270`) | `message.send` | `readOnlyForRoleIds` (`backend.md:512`) | `submitOp` | `channels.read_only_role_ids` | — → aviso "Só moderadores podem postar aqui" | `E_CHANNEL_READ_ONLY` | **COMPLETE** |

### 2.6 Anexos (C9, B8, 2.1.2)

| # | Comportamento UX | Frontend | IPC | Op / reducer | RPC | Persistência → Projeção | Evento → UI final | Erro | Status |
|---|---|---|---|---|---|---|---|---|---|
| A-1 | Anexar 1 arquivo, chip no composer, teto 8 GB (`frontend.md:940`) | `Composer` chip | `blob.stage{path}` → `{blobId, name, sizeBytes, kind, hash}` (`backend.md:1536`) | depois `message.send{attachment}` | — (`hyperblobs.put` local) | core de blobs + `local_blob_cache` `owned` | — → card na mensagem | `E_ATTACHMENT_TOO_LARGE` (antes de ler 1 byte), `E_FILE_UNREADABLE` | **PARTIAL** — caminho do `blob.stage` sem prova de origem (`T-16`, `DR-37`); escrita no core de blobs pelo membro é impossível como escrita (`F-03`) |
| A-2 | Baixar arquivo estilo torrent, N peers (B8) | `downloadStore.start` (`:24`) | `blob.download` (`backend.md:1537`) | — | `blobAnnounce`; `hyperblobs.get` por range | `local_blob_cache.bytes_downloaded/state/path` | `blob.progress` (500 ms), `blob.completed{path}` → "Baixado · Disponibilizando para outros" | `E_NO_PEERS` | **PARTIAL** — `local_blob_cache.state` **sem enum** e sem retomada após crash (`DR-40`) |
| A-3 | "1 peer desconectou, continuando com 2" (B8 exceção) | `downloadStore.devDropPeer` | — | — | bitfield do Hypercore | — | `blob.peerLost{remaining}` | — | **COMPLETE** |
| A-4 | "Indisponível no momento — nenhum peer…" (B8 exceção) | `noticeById` | — | — | — | — | `blob.unavailable` (zero peers **e** host offline) | — | **COMPLETE** |
| A-5 | Anexo corrompido | ✗ sem estado na UX | — | — | verificação de hash no destino | arquivo descartado | `attachment.corrupt` | — | **MISSING** — evento de backend sem representação na UX |
| A-6 | Abrir / "Mostrar na pasta" (B8 passo 3) | ícone ilustrativo no mock | `blob.reveal` → `shell.openPath` no main (`backend.md:1539`) | — | — | `blobs/<communityId>/` | — | `E_NOT_DOWNLOADED`; sem allowlist de tipo (`T-17`) | **PARTIAL** |
| A-7 | Aba **Arquivos** do canal (2.1.2) | `ChannelInfoPanel` | `query.files{channelId, cursor, limit=25}` (`backend.md:1621`) | — | — | `attachments` + `local_blob_cache` | — → cards com peers/host/progresso | — | **PARTIAL** — query sem schema (`DR-46`) |
| A-8 | Aba **Links** do canal (2.1.2) | `ChannelInfoPanel` extrai URLs do corpo | `query.links` (`backend.md:1622`) | — | — | ✗ **não existe tabela de links** em §6.3 | — → host + URL, sem unfurl | — | **MISSING** (`DR-38`) |
| A-9 | Aba **Fixados** do canal (2.1.2) | `ChannelInfoPanel` | `query.pinned{cursor, limit=25}` (`backend.md:1620`) | — | — | `idx_messages_pinned` | `message.updated` | — | **COMPLETE** |

### 2.7 Busca (1.2, C10)

| # | Comportamento UX | Frontend | IPC | Op / reducer | RPC | Persistência → Projeção | Evento → UI final | Erro | Status |
|---|---|---|---|---|---|---|---|---|---|
| S-1 | Busca com chips Autor/Canal/Data/Tipo, 20 por grupo (`frontend.md:506`) | `searchIndex.search` | `query.search` (`backend.md:1629`, §15.1) | — | — | FTS5 `messages_fts` (`unicode61 remove_diacritics 2`, prefix `2 3`) | resposta síncrona → 3 grupos | consulta que vira token vazio → resultado vazio, **não erro** | **PARTIAL** — combinação de tokens e operadores `MATCH` sem regra (`DR-39`) |
| S-2 | Ordenação por recência, não relevância (`frontend.md:1417`) | idem | idem | — | — | `seq DESC` (`backend.md:2294`) | — | — | **COMPLETE** |
| S-3 | Banner "Buscando só no histórico salvo neste dispositivo" (`frontend.md:510`) | `SearchPanel.tsx:362` (`hostStatus === "offline"`) | `query.search` → `partial: bool` (`backend.md:1633`) | — | — | — | — → banner | — | **PARTIAL** (`RT-11`) — `partial` só cobre host offline; réplica atrasada com host online não tem sinal (`DS-11`) |
| S-4 | Busca varre só canais de texto | idem | idem | — | — | — | — | — | **COMPLETE** |

### 2.8 Membros, cargos e moderação (1.3, 1.4, 3.2, 3.3, D12, D13)

| # | Comportamento UX | Frontend | IPC | Op / reducer | RPC | Persistência → Projeção | Evento → UI final | Erro | Status |
|---|---|---|---|---|---|---|---|---|---|
| P-1 | Painel de membros agrupado por cargo, "OFFLINE — 307" agregado (1.3) | `MembersPanel` | `query.members{filter, cursor, limit=100}` (`backend.md:1623`) | — | — | `members` + `member_roles` | `members.changed`, `presence.changed` | — | **PARTIAL** — forma da resposta indefinida (`DR-46`) |
| P-2 | Popover de perfil: cargos, "Entrou em…", ações condicionais (1.4) | `ProfilePopover` + `selectCanModerate` (`communityStore.ts:1199`) | `query.member` → `+ canModerate` (`backend.md:1624`) | — | — | `members.joined_at` | `members.changed` | — | **COMPLETE** |
| P-3 | Editar apelido próprio, inline, `Enter` salva (1.4) | `setMemberNickname` (`:152`) | `member.setNickname` ⏱ (`backend.md:1461`) | `member.setNickname`, alvo == autor (`backend.md:956`) | `submitOp` | `members.nickname` | `members.changed` → nome resolvido na renderização | `E_NICKNAME_SELF_ONLY`; vazio ⇒ `null`, **não é erro** | **COMPLETE** |
| P-4 | Criar/editar cargo com auto-save (3.2, D13) | `createRole`/`updateRole` (`:141`,`:142`) | `role.create`/`role.update` ⏱ | `role.create`/`role.update` (`backend.md:949-950`) | `submitOp` | `roles`, `uniq_roles_position` | `roles.changed` → toast "Cargo criado" | `E_PERMISSION_ESCALATION`, `E_HIERARCHY`, `E_FOUNDER_IMMUTABLE` | **CONTRADICTORY** (`F-12`) — auto-save de 800 ms × ⏱ 30 s × rate limit 20/60 s |
| P-5 | Arrastar para reordenar hierarquia, Fundador travado | `moveRole` (`:145`) | `role.move` → `{seq, positions[]}` (`backend.md:1458`) | `role.move` (`backend.md:951`) | `submitOp` | renumeração densa na mesma transação | `roles.changed` → lista reordenada de uma vez | `E_FOUNDER_TOP`, `E_HIERARCHY` | **PARTIAL** — `UNIQUE(community_id, position)` sem constraint diferível no SQLite (`F-39`) |
| P-6 | Deletar cargo: "Este cargo tem 12 membros. Remover o cargo, não os membros?" | `deleteRole` (`:143`) | `role.delete` → `{seq, affectedMembers}` (`backend.md:1459`) | `role.delete` (`backend.md:952`) | `submitOp` | tombstone; membros mantidos | `roles.changed` + `members.changed` | `E_BASE_ROLE_REQUIRED`, `E_FOUNDER_IMMUTABLE` | **PARTIAL** — deixa referência pendurada em `channels.read_only_role_ids` (`F-31`) |
| P-7 | Atribuir cargo pelo popover (1.4) | `setMemberRoles` (`:146`) | `member.setRoles` ⏱ | `member.setRoles`, **lista completa** (`backend.md:953`) | `submitOp` | `member_roles` + `roles.member_count` | `members.changed` + `roles.changed` | `E_HIERARCHY`, `E_BASE_ROLE_REQUIRED` | **COMPLETE** |
| P-8 | Duas regras de anti-escalada (§25 delta 11) | ✗ ausente da UX e do mock | — | `E_PERMISSION_ESCALATION`, `E_HIERARCHY` (`backend.md:1278-1281`) | — | — | — | — | **MISSING na UX** — reconhecido em §25 delta 11; não cobre o cargo base (`T-35`, `F-38`) |
| P-9 | Banir com modal + motivo (D12) | `moderationStore.ban` (`:53`) | `mod.ban` ⏱ → `{seq, hiddenMessages}` (`backend.md:1486`) | `mod.ban` (`backend.md:964`) | `submitOp` | 1 transação: `bans`, `members.banned`, `hidden_by_ban`, FTS, `member_count`, `moderation_log`; + `firewall` e queda da conexão | `members.changed`, `community.changed{memberCount}` → toast "X foi banido" | `E_HIERARCHY`, `E_FOUNDER_IMMUNE` | **PARTIAL** — ocultação é **reversível**, texto da UX sugere permanente (§25 delta 9) |
| P-10 | Expulsar (D12) | `moderationStore.kick` (`:61`) — **só registra no log** | `mod.kick` ⏱ | `mod.kick`, alvo vira `left` (`backend.md:963`) | `submitOp` | `members.left_at` | `members.changed` | idem | **PARTIAL** — ciclo de vida no cliente do alvo indefinido (`F-35`, `DR-35`) |
| P-11 | Timeout com contagem regressiva (3.3) | `applyTimeout` (`:62`) + `formatCountdown` | `mod.timeout` ⏱ (`backend.md:1488`) | `mod.timeout`, `until ≤ now+30d` (`backend.md:966`) | `submitOp` | `timeouts.until` | `members.changed` via job `timeout.notify` (1 min) | `E_VALIDATION.until`; alvo recebe `E_TIMED_OUT` | **PARTIAL** — avaliado com o relógio de quem lê (`T-45`) |
| P-12 | Remover timeout, sem confirmação (§15) | `removeTimeout` (`:63`) | `mod.removeTimeout` ⏱ | `mod.removeTimeout`, idempotente | `submitOp` | `timeouts` | `members.changed` | — | **COMPLETE** |
| P-13 | Revogar banimento (3.3) | `revokeBan` (`:111`) | `mod.revokeBan` ⏱ | `mod.revokeBan` (`backend.md:965`) | `submitOp` | `bans.revoked_at` + **reexibe** as mensagens | `members.changed` | `E_NOT_BANNED` — **fora do catálogo §16.2** | **PARTIAL** |
| P-14 | Log de auditoria em tempo real, com filtros (3.3, D12) | `moderationStore.entries` + `ModerationTab` | `query.auditLog{type?, byKey?, from?, to?, cursor, limit=25}` (`backend.md:1627`) | log é **projeção**, não op (`backend.md:755`) | — | `moderation_log` | ✗ **não existe `auditLog.changed`** (`F-34`) | ✗ sem enforcement de `view_audit_log` na leitura (`DR-25`, `T-44`) | **PARTIAL** |
| P-15 | Linha do log "Bianca Souza baniu `Usuário#4471`" | `describe()` | idem | — | — | `target_label` **congelado**; `by_key` **cru, sem label** | — | — | **PARTIAL** (`DR-49`) |
| P-16 | Lista de banidos / timeouts, "Carregar mais" em 25 | `ModerationTab` | `query.bans` / `query.timeouts` (`backend.md:1628`) | — | — | `bans`, `timeouts` | — | — | **PARTIAL** — sem schema (`DR-46`) |
| P-17 | Nota de honestidade fixa sobre ban (3.3) | texto fixo | — | backend **não tenta** heurística (`backend.md:404-406`) | — | — | — | — | **COMPLETE** |

### 2.9 Voz, câmera e compartilhamento de tela (2.3, 2.3.1, 2.3.2, 2.4, B5-B7, C11)

| # | Comportamento UX | Frontend | IPC | Op / reducer | RPC | Persistência → Projeção | Evento → UI final | Erro | Status |
|---|---|---|---|---|---|---|---|---|---|
| V-1 | Entrar em canal de voz, direto, sem confirmação (B7) | `voiceStore.join` (`:87`) | `voice.join` ⏱ → `{sessionId, roster[]}` (`backend.md:1519`) | — (efêmero) | `voiceJoin`; SDP/ICE **direto par a par** (`backend.md:1682`) | ✗ nada persiste (por desenho) | `voice.roster` → grade de tiles | `E_HOST_UNAVAILABLE` (`VOZ-09`), `E_CHANNEL_NOT_VOICE` | **COMPLETE** |
| V-2 | Voz bloqueada com host offline, mensagem clara (B4 exceção) | `AppShell.tsx:165` | idem | — | — | — | `host.wentOffline` → "Voz precisa que o host esteja online" | `E_HOST_UNAVAILABLE` **antes** de tentar mídia | **COMPLETE** |
| V-3 | Mesh parcial: "Sem conexão com você" + banner (B7) | `connectionToMe` (`types.ts:280`) | — | — | par a par independente | — | `voice.meshChanged{peerKey, status}` | falha total → `voice.failed` → "Tentar novamente" | **COMPLETE** |
| V-4 | Mudo / ensurdecer / câmera | `toggleMute/Deafen/Camera` (`:90-92`) | `voice.setSelf{muted?, deafened?, cameraOn?}` (`backend.md:1521`) | — | `voiceState` | — | `voice.roster` | `E_CAMERA_LIMIT` (>6) | **PARTIAL** — "ensurdecer implica mudo" foi decidido pelo frontend e vira contrato observável (`DR-45`) |
| V-5 | **Anel de fala ativa** (2.3, 2.3.1, requisito de acessibilidade §5.4) | ciclo simulado no mock | — | — | ✗ `VoiceRoster.participants` **não tem `speaking`** (`backend.md:828`) | — | `voice.roster` | — | **MISSING** (`DR-42`) |
| V-6 | Volume individual por participante (slider em 1.4) | `setVolume` (`:94`) | `voice.setParticipantVolume` — local (`backend.md:1522`) | — | — | ✗ `local_device_pref` **não tem coluna** por participante (`backend.md:1079`) | — | — | **PARTIAL** (`DR-45`) |
| V-7 | "Silenciar nesta chamada" com `voice_mute_others` | `setParticipantMuted` (`:96`) | `voice.muteParticipant` (`backend.md:1523`) | — | host valida a permissão | — | `voice.roster` | `E_PERMISSION_DENIED` | **PARTIAL** — é conselho ao cliente, não enforcement de mídia (`T-40`) |
| V-8 | Barra persistente sobrevive a trocar canal/comunidade (C11, 2.3.1) | `voiceStore` + `VoiceCallBar` | sessão vive no núcleo (`backend.md:2005-2006`) | — | — | — | `voice.roster` | — | **COMPLETE** |
| V-9 | Câmera: tile vira vídeo, teto de 6 (2.3.2) | `VoiceTile` + `animate-camera-drift` | `voice.setSelf{cameraOn}` | — | WebRTC mesh | — | `voice.roster{cameraOn}` | `E_CAMERA_LIMIT` | **PARTIAL** — "O sistema bloqueou o acesso à câmera" **não tem código nem caminho** (`RT-10`) |
| V-10 | Áudio tem prioridade sobre vídeo em rede fraca (§18, `frontend.md:1142`) | degrada o tile no mock | — | — | ✗ nenhuma regra de priorização de mídia especificada | — | — | — | **UNCLEAR** |
| V-11 | Compartilhar tela: badge estrela ≤5 / árvore >5 (2.4, B5) | `startShare` (`:98`) | `share.start` ⏱ → `{sessionId, topology}` (`backend.md:1525`) | — (efêmero) | `shareStart`, `shareJoin{canRelay, uplinkKbps}` | ✗ nada persiste | `share.started`, `share.topologyChanged{topology, viewerCount}` → "Otimizando distribuição…" | `E_ALREADY_SHARING` | **COMPLETE** (limiar 5 = `STAR_MAX_VIEWERS`, `backend.md:1712` = `voiceStore.ts:41`) |
| V-12 | **Espectador em árvore fica 1-2 s atrás** | ✗ a UX trata árvore = estrela | — | — | jitter 800 ms + 250 ms/nível (`backend.md:1711`) | — | — | — | **MISSING na UX** — §25 delta 3; incompatível com o teto de 200 espectadores (`F-42`) |
| V-13 | Ajustar qualidade (de quem assiste) | `setQuality` (`:100`) | `share.setQuality` → `{}` (`backend.md:1527`) | — | — | — | ✗ nenhum evento | — | **CONTRADICTORY** (`F-08`) — nó de repasse copia o quadro sem transcodificar; o comando é inerte |
| V-14 | Modal de consentimento de repasse (2.4.1, B6) | `RelayConsentModal` + `respondConsent` (`:102`) | `share.respondConsent{accept, remember}` (`backend.md:1528`) | — | — | `local_relay_consent` | `share.consentRequested{relayCount}` → modal; `share.relayingChanged{relayingTo}` → badge | nunca assume recusa por timeout (`backend.md:2053-2055`) | **COMPLETE** — com a ressalva de `F-37` (só na transição estrela→árvore) |
| V-15 | Painel do apresentador, saúde da árvore (2.4.2) | `TreeHealthPopover` | — | — | `shareHeartbeat` | — | `share.treeHealth{health, firstLevelRelays[]}` → linhas com `conn-*` | ✗ `share.assignment` sem ACK/retry (`DS-14`) | **PARTIAL** (`RT-08`) — a UX restringe ao apresentador, o protocolo não |
| V-16 | Badge "Via TURN" com tooltip de NAT restritivo | `ScreenShareStage` | — | — | — | — | `share.turnEngaged{using}` | — | **COMPLETE** |
| V-17 | Reparo de árvore: "Reorganizando transmissão…" | `devRepairTree` | — | — | `treeHeartbeat` 2 s, morto em 6 s | — | `share.treeHealth{repairing→ok}` | órfãos viram filhos diretos, estourando o fanout | **COMPLETE** |
| V-18 | Falha total: "Falha ao conectar à transmissão" | `ScreenShareStage` | — | — | — | — | `share.failed` — **evento citado em `backend.md:2040` e ausente da tabela §10.3** | — | **PARTIAL** |
| V-19 | **Múltiplos compartilhamentos simultâneos no mesmo canal** (§18, `frontend.md:1119`) | ✗ `share: ActiveShare \| null` (`voiceStore.ts:81`); "não entraram" (`frontend.md:1467`) | `E_ALREADY_SHARING` | — | — | `Channel ─0..1 ShareSession` (`backend.md:849`) | — | — | **CONTRADICTORY** (`RT-06`) |
| V-20 | Consentimento de **relay voluntário** em 3.1 → Rede | ✗ não existe na UX nem no mock | `relay.enable` / `relay.disable` (`backend.md:1529-1530`) | `relay.volunteer` / `relay.withdraw` (`backend.md:978-979`) | anúncio no DHT | `relay_volunteers` | — | `E_CONSENT_REQUIRED` | **MISSING na UX** — §25 delta 7 |

### 2.10 Conexão, host e preferências (§12, 3.1, 3.5)

| # | Comportamento UX | Frontend | IPC | Op / reducer | RPC | Persistência → Projeção | Evento → UI final | Erro | Status |
|---|---|---|---|---|---|---|---|---|---|
| N-1 | Banner "X está offline — mostrando histórico salvo" (B4) | `connectionStore.setHostStatus` (`:16`) | `query.hostStatus` (`backend.md:1631`) | — | `hello` | `local_community_pref.last_host_seen_at` | `host.wentOffline` (após **2 falhas**), `host.reconnecting{attempt}`, `host.cameBack` | — | **PARTIAL** — enum de `hostStatus` inexistente (`DR-33`) e sem estado inicial (`DR-29`) |
| N-2 | Contagem "2 mensagens suas aguardando envio" | `selectQueuedChannelIds` (`messageStore.ts:437`) | — | — | — | `local_outbox` | `outbox.changed{queued, failed}`, `outbox.flushed{delivered}` | — | **PARTIAL** (depende de `M-2`) |
| N-3 | Distinguir "represado por rate limit" de "host offline" | ✗ a UX não distingue (`T-33`) | — | — | `E_RATE_LIMITED{retryAfterMs}` | — | — | — | **MISSING na UX** |
| N-4 | Ícone do rail com opacidade 60 % + dot `conn-offline` | `CommunityIcon` | `query.communities` → `hostStatus` (`backend.md:1614`) | — | — | — | `host.*` | — | **COMPLETE** |
| N-5 | Aviso de saída do host (3.5) | `HostExitGuard` + `beforeunload` | `host.exitImpact` → `[{onlineCount, inCallCount}]` (`backend.md:1545`) | — | roster **efêmero** | — | — → modal "Fechar o app desconecta 12 pessoas" | — | **COMPLETE** |
| N-6 | "Avisar quem está online" (3.5) | `HostExitDialog` | `host.notifyBeforeExit` → `{postedTo[]}` (`backend.md:1546`) | `message.send` **assinada pelo host** (`backend.md:2079`) | `submitOp` (local) | core | `messages.appended` | — | **PARTIAL** — provavelmente nunca replicada antes do desligamento (`F-43`); a UX chama de "mensagem de sistema", que não existe no modelo (`RT-13`) — ver §3.1 |
| N-7 | Fechar de verdade | idem | `core.shutdown` → `{drainedMs, pendingOps}` | — | — | `draining` com orçamento de **3000 ms** | `shutdown.forced` (fora da tabela §10.3) | — | **COMPLETE** |
| N-8 | Diagnóstico de rede / CGNAT (3.1 → Rede) | `settingsStore.runDiagnostic` (`:78`) | `diag.run` → `{natType, peerCount, relayAvailable, ranAt}` (`backend.md:1543`) | — | — | — | `nat.detected{natType}`, `swarm.changed{peerCount, degraded}` | — | **COMPLETE** |
| N-9 | Dispositivos, volumes (3.1 → Dispositivos) | `settingsStore.setDevice/setVolume` (`:71-72`) | `settings.setDevice` / `settings.setVolume` (`backend.md:1540-1541`) | — | — | `local_device_pref` (singleton) | — | — | **PARTIAL** (`RT-02`) — **escrita sem leitura**: nenhuma query devolve as preferências |
| N-10 | "Testar microfone" + medidor de nível ao vivo (3.1) | `LevelMeter` animado localmente (`AccountSettings.tsx:241-244`) | ✗ nenhum comando | — | — | — | ✗ nenhum evento de nível de áudio | — | **MISSING** (`RT-09`) |
| N-11 | Notificações: toggle geral + nível por comunidade (3.1) | `setNotificationsEnabled`, `setCommunityNotification` | `settings.setNotifications{enabled?, communityId?, level?}` | — | — | `local_community_pref.notification_level` | — | — | **PARTIAL** (`RT-02`) — mesma lacuna de leitura |
| N-12 | Aparência: "Tema escuro (único disponível)" | texto fixo | — | — | — | — | — | — | **COMPLETE** (sem backend por desenho) |
| N-13 | Sem descoberta LAN | ✗ a UX não menciona | — | — | — | — | — | — | **MISSING na UX** — §25 delta 6 |
---

## 3. Inconsistências

### 3.1 Achados novos desta análise (`RT-nn`)

Cada um foi verificado nos dois documentos **e** no código do mock. Nenhum destes está em
`backend.md` §25, e nenhum aparece nas quatro auditorias com este recorte.

---

**RT-01 — `InvitePreview` tem seis desfechos no backend e quatro na UX e no código**

| | |
|---|---|
| **Referência UX** | `frontend.md:440-447` (estados de 0.3); `frontend/src/domain/types.ts:236-240`; `frontend/src/mocks/dataset.ts:790-813` |
| **Referência Backend** | `backend.md:1500-1513` (§10.2.1); `backend.md:711-712` (§4.11) |
| **Comportamento esperado** | O preview distingue: válido, inválido/revogado/expirado, banido, já-é-membro. |
| **Comportamento suportado** | O host devolve mais dois: `unreachable` (host offline) e `ended` (comunidade encerrada). |
| **Divergência** | Dois desfechos do backend caem no ramo `invalid` da UI. |
| **Impacto** | Um convite **perfeitamente válido** é acusado de inválido quando o host está offline — o oposto da promessa do princípio 3 (`frontend.md:47`). Bloqueia a entrada e não dá caminho de recuperação. |
| **Severidade** | **Alta** |
| **Documento a alterar** | `frontend.md` (0.3, §2 `InvitePreview`) — já obrigado por §25 delta 5, ainda não aplicado. |

---

**RT-02 — Preferências locais têm comando de escrita e nenhuma query de leitura**

| | |
|---|---|
| **Referência UX** | `frontend.md:704-707` (3.1 → Dispositivos e Notificações); `frontend.md:477` (rail não mostra badge se a comunidade está em "Nada") |
| **Referência Backend** | `backend.md:1540-1542` (`settings.setDevice`, `settings.setVolume`, `settings.setNotifications`); `backend.md:1607-1631` (§10.4 — **nenhuma query de preferências**); `backend.md:1076-1079` (`local_channel_pref`, `local_community_pref`, `local_device_pref`) |
| **Comportamento esperado** | Ao abrir 3.1, os selects de microfone/câmera/saída, os dois sliders de volume, o toggle geral e o nível por comunidade aparecem **no valor atual**; o rail decide o badge lendo `notification_level`. |
| **Comportamento suportado** | As três tabelas existem e são escritas. Nenhuma das 17 queries de §10.4 as devolve. |
| **Divergência** | Dado exibido em pelo menos quatro superfícies sem fonte de leitura. |
| **Impacto** | 3.1 abre com valores em branco ou com o default do renderer a cada boot — e o rail não consegue aplicar a regra de silenciamento por comunidade de `frontend.md:477`. É o mesmo padrão que a Parte 11 nomeou no frontend ("campo lido em N lugares, escrito em zero", `frontend.md:1556`), invertido. |
| **Severidade** | **Alta** |
| **Documento a alterar** | `backend.md` (§10.4 — acrescentar a query de leitura) |

---

**RT-03 — `channel.markRead` zera não-lidas, mas o contrato não declara as menções**

| | |
|---|---|
| **Referência UX** | `frontend.md:489` — "Zera contador **e menções** e move o divisor" |
| **Referência Backend** | `backend.md:1449` — resposta `{unreadCount:0}`; `backend.md:1075` — `local_read_state` tem `unread_count` **e** `pending_mentions` |
| **Comportamento esperado** | Marcar como lido zera contador e menções, e o badge `feedback-danger` do rail some. |
| **Comportamento suportado** | A coluna existe; o comando declara só `unreadCount`. `unread.changed` carrega os dois (`backend.md:1589`), então o dado chega — mas por evento, não pela resposta. |
| **Divergência** | Contrato de resposta incompleto em relação ao efeito declarado. |
| **Impacto** | Baixo em execução (o evento cobre), alto em teste de contrato: o critério de aceite de `UNR-*` fica ambíguo sobre se `pending_mentions` também zera. |
| **Severidade** | **Baixa** |
| **Documento a alterar** | `backend.md` (§10.2, linha de `channel.markRead`) |

---

**RT-04 — A rota `/m/:code` não tem contrato de backend em nenhuma ponta**

| | |
|---|---|
| **Referência UX** | `frontend.md:212` (rota + 3 desfechos de falha); `frontend.md:550` ("Copiar link da mensagem"); `frontend.md:491` ("Copiar link do canal" aponta pra 1ª não lida); `frontend/src/lib/messageLink.ts` (base64url de comunidade+canal+mensagem) |
| **Referência Backend** | `backend.md:1411-1556` (§10.2 — nenhum comando gera o token); `backend.md:1607-1631` (§10.4 — nenhuma query o resolve); `backend.md:2828-2848` (§25 não registra o delta) |
| **Comportamento esperado** | Gerar um token que **não vaza ids legíveis pra quem não é membro** e resolvê-lo em três desfechos distintos: não-membro, ainda-não-sincronizado, deletada. |
| **Comportamento suportado** | Nada. O mock resolve localmente com base64url, que é **reversível por qualquer pessoa** — não cumpre a propriedade que `frontend.md:212` usa para justificar a rota. |
| **Divergência** | Feature de UX inteira (rota endereçável, premissa 10) sem implementação backend, e com a propriedade de privacidade declarada não cumprida nem no mock. |
| **Impacto** | Dois pontos de entrada da UI (2.1 e 1.1.1) produzem links que o produto real não sabe abrir. O desfecho "ainda não chegou neste dispositivo" depende de saber se o `seq` existe na réplica local — não há query para isso. Relaciona-se com `T-04` (o `coreKey` como capacidade perpétua). |
| **Severidade** | **Alta** |
| **Documento a alterar** | `backend.md` (§10.2 + §10.4) — ou `frontend.md`, se o corte alternativo já previsto em `frontend.md:1579` (remover "Copiar link da mensagem") for escolhido. |

---

**RT-05 — Avatares inline dos participantes de um canal de voz não têm fonte para quem não está na chamada**

| | |
|---|---|
| **Referência UX** | `frontend.md:473` ("canal de voz lista participantes ativos inline abaixo do nome"); `frontend.md:395` (item de lista de canal); `frontend.md:60` (`Channel.participantesVoz[]`); `frontend/src/domain/types.ts:145` (`voiceParticipantIds`) |
| **Referência Backend** | `backend.md:1616` (`query.structure` devolve `{unread, muted, live}` — só um booleano); `backend.md:1681` (`voiceRoster` é **host → participantes**); `backend.md:498-517` (§4.6 `Channel` **não tem** campo de participantes) |
| **Comportamento esperado** | A sidebar mostra, para todo membro, quem está agora em cada canal de voz. |
| **Comportamento suportado** | Um booleano `live`. O roster só é enviado a quem entrou na chamada. |
| **Divergência** | Campo do modelo mockado sem contraparte no modelo real; dado exibido sem fonte. |
| **Impacto** | Perde-se um dos elementos mais visíveis da sidebar e o gancho de descoberta de conversa em andamento. Também afeta a confirmação de exclusão de canal de voz, que promete contar "3 pessoas estão em Sala de Estudos agora" (`frontend.md:777`) — mesma dependência. |
| **Severidade** | **Alta** |
| **Documento a alterar** | `backend.md` (§10.4 `query.structure` e/ou §10.7 fan-out de `voiceRoster`) |

---

**RT-06 — Compartilhamentos de tela simultâneos: exigidos pela UX, impossíveis no backend, não implementados no mock**

| | |
|---|---|
| **Referência UX** | `frontend.md:1119` (edge case 4: "grade de tiles grandes… cada um com badge de topologia independente"); `frontend.md:1467` ("compartilhamentos simultâneos não entraram — uma sessão por chamada"); `frontend/src/store/voiceStore.ts:81` (`share: ActiveShare \| null`) |
| **Referência Backend** | `backend.md:2393` (`E_ALREADY_SHARING`); `backend.md:849` (`Channel ─0..1 ShareSession`); `backend.md:1525` (`share.start`) |
| **Comportamento esperado** | N sessões de compartilhamento coexistindo no mesmo canal de voz, cada uma com topologia própria. |
| **Comportamento suportado** | Exatamente uma sessão por canal; a segunda tentativa recebe `E_ALREADY_SHARING`. |
| **Divergência** | Edge case normativo da UX que a arquitetura não entrega e que a implementação já declarou fora. |
| **Impacto** | Baixo em uso, alto em rastreabilidade: é um requisito de §18 que ninguém pode cumprir, e §18 é tratado como lista de requisitos no resto do documento. Além disso, `E_ALREADY_SHARING` não tem comportamento de UI definido em lugar nenhum. |
| **Severidade** | **Média** |
| **Documento a alterar** | `frontend.md` (§18, edge case 4) |

---

**RT-07 — O enum do log de auditoria tem três formas diferentes, e uma op auditável não tem tipo**

| | |
|---|---|
| **Referência UX** | `frontend.md:70` (10 tipos em §2); `frontend/src/domain/types.ts:244-257` (11 tipos — o código acrescentou `revokeBan`) |
| **Referência Backend** | `backend.md:763` (13 tipos em `ModerationEntry.type`); `backend.md:975` (`community.end` é `Aud. = sim`) |
| **Comportamento esperado** | Toda entrada do log de 3.3 renderiza com ícone e frase por tipo. |
| **Comportamento suportado** | O backend projeta `removeTimeout` e `updateCommunity`, que a UI não conhece. E `community.end` é declarada auditável em §5.3 sem existir um tipo `endCommunity` no enum de §4.13 — a entrada não tem como ser gravada nem exibida. |
| **Divergência** | Cardinalidade do enum: 10 (spec UX) × 11 (mock) × 13 (backend), com uma op auditável fora dos três. |
| **Impacto** | Duas classes de entrada caem em fallback silencioso no log; encerrar uma comunidade — a ação mais destrutiva do produto — não deixa rastro representável. O filtro "por tipo de ação" de `frontend.md:740` fica incompleto. |
| **Severidade** | **Média** |
| **Documento a alterar** | `frontend.md` (§2 `ModerationAction`) **e** `backend.md` (§4.13 vs §5.3 — a contradição interna) |

---

**RT-08 — O painel de saúde da árvore é exclusivo do apresentador na UX, mas o protocolo entrega a lista a todos**

| | |
|---|---|
| **Referência UX** | `frontend.md:678` — "Só o apresentador vê isso — nunca espectadores, **nem os que estão retransmitindo**"; `frontend.md:684` (justificativa P2P: cada nó só enxerga seus vizinhos diretos) |
| **Referência Backend** | `backend.md:829` (`ShareSession` efêmera inclui `firstLevelRelays[]`, fan-out "host"); `backend.md:1599` (`share.treeHealth{health, firstLevelRelays[]}` sem destinatário declarado) |
| **Comportamento esperado** | Só o apresentador recebe a topologia do primeiro nível. |
| **Comportamento suportado** | A entidade efêmera que o host dissemina carrega `firstLevelRelays[]`, e o evento IPC não declara escopo. |
| **Divergência** | Estado visual com escopo de visibilidade mais restrito que o estado de backend correspondente. |
| **Impacto** | Vazamento de topologia social (quem retransmite para quem) para todos os espectadores, contrariando a justificativa explícita da tela. Como o `voiceCoordinator` é o host, isso é decisão de protocolo, não de UI. |
| **Severidade** | **Média** |
| **Documento a alterar** | `backend.md` (§10.3 e §4.16 — declarar o destinatário) |

---

**RT-09 — "Testar microfone" e o medidor de nível ao vivo não têm nem comando nem evento**

| | |
|---|---|
| **Referência UX** | `frontend.md:705` — sliders "com medidor de nível ao vivo" e botão "Testar microfone"; `frontend/src/features/settings/AccountSettings.tsx:241-244` (`LevelMeter` animado localmente) |
| **Referência Backend** | `backend.md:1540-1543` — só `settings.setDevice`, `settings.setVolume`, `settings.setNotifications`, `diag.run`; §10.3 não tem evento de nível de áudio |
| **Comportamento esperado** | Ao clicar em "Testar microfone", o medidor reflete o áudio real captado. |
| **Comportamento suportado** | Nada no núcleo. (Captura é do renderer por ADR-05, então pode ser resolvido inteiramente no renderer — mas isso **não está declarado em lugar nenhum**, e §2.4 regra 1 diz que "o renderer nunca toca disco nem rede".) |
| **Divergência** | Funcionalidade de UX sem dono declarado entre renderer e núcleo. |
| **Impacto** | Baixo funcionalmente; é uma ambiguidade de fronteira que só aparece na implementação da fase 6. |
| **Severidade** | **Baixa** |
| **Documento a alterar** | `backend.md` (§2.4 ou §10.2 — declarar que medição de nível local é do renderer) |

---

**RT-10 — Erro de permissão de câmera do sistema operacional não tem código no catálogo**

| | |
|---|---|
| **Referência UX** | `frontend.md:645` — estado nomeado "O sistema bloqueou o acesso à câmera", com atalho para 3.1, **"nunca falha silenciosa"**; `frontend.md:1602` (é o único estado de 2.3.2 sem código no mock) |
| **Referência Backend** | `backend.md:1521` (`voice.setSelf` só declara `E_CAMERA_LIMIT`); `backend.md:2340-2405` (§16.2 não tem código de permissão de dispositivo) |
| **Comportamento esperado** | Erro nomeado, distinto do limite de 6 câmeras. |
| **Comportamento suportado** | Só `E_CAMERA_LIMIT`. |
| **Divergência** | Estado de erro da UX sem código no catálogo que se declara "o contrato" (`backend.md:2333`). |
| **Impacto** | Como a captura é do renderer, o erro nasce lá — mas a regra 3 de §16.3 ("erro de rede nunca vira erro de validação") pressupõe um catálogo completo, e este ficou de fora. |
| **Severidade** | **Baixa** |
| **Documento a alterar** | `backend.md` (§16.2) |

---

**RT-11 — `partial` da busca cobre só host offline; a réplica parcial da premissa 6 é mais ampla**

| | |
|---|---|
| **Referência UX** | `frontend.md:28` (premissa 6: réplica local é parcial "só o que sincronizou enquanto esteve online"); `frontend.md:510` e `frontend.md:585` (banner); `frontend/src/features/search/SearchPanel.tsx:362` (`hostStatus === "offline"`) |
| **Referência Backend** | `backend.md:1633-1635` — "`partial: true` na busca **quando o host está offline**" |
| **Comportamento esperado** | A busca "nunca mente" sobre completude — inclusive para quem acabou de entrar e ainda está em catch-up, ou para uma réplica com buraco de replicação. |
| **Comportamento suportado** | Um único gatilho: host offline. Com o host online e a projeção atrasada (`DS-11`) ou o catch-up em andamento (`backend.md:1756`), a busca se apresenta como completa. |
| **Divergência** | Semântica de `partial` mais estreita que a premissa que ela existe para cumprir. |
| **Impacto** | O caso mais provável de resultado incompleto — membro novo que acabou de resgatar o convite e ainda está projetando 200 k mensagens — é exatamente o que não recebe o aviso. |
| **Severidade** | **Média** |
| **Documento a alterar** | `backend.md` (§10.4 / §15.1 — ampliar a definição de `partial`) |

---

**RT-12 — Limites de convite do backend não existem no formulário da UX**

| | |
|---|---|
| **Referência UX** | `frontend.md:1047` — "Limite de usos: opcional (padrão 'ilimitado'), **inteiro ≥1** se preenchido"; expiração "opcional (padrão 'nunca')", sem faixa |
| **Referência Backend** | `backend.md:1346-1347` — `Invite.maxUses` 1..**10000**; `Invite.expiresAt` entre `now+60s` e `now+365d`; `backend.md:693-694` |
| **Comportamento esperado** | O formulário de 3.1b valida inline o que o host aceita (§9.2 diz que cliente e host usam o mesmo módulo). |
| **Comportamento suportado** | A UX declara só o piso; o host rejeita `maxUses > 10000` e qualquer expiração acima de 1 ano com `E_VALIDATION`. |
| **Divergência** | Validação de formulário incompleta em relação à tabela autoritativa de limites. |
| **Impacto** | Erro de campo só descoberto no submit — exatamente o que §13 e §12 da UX proíbem ("validação inline, nunca só toast"). |
| **Severidade** | **Baixa** |
| **Documento a alterar** | `frontend.md` (§13, linha "Criar convite") |

---

**RT-13 — "Mensagem de sistema" de 3.5 não existe no modelo de domínio**

| | |
|---|---|
| **Referência UX** | `frontend.md:810` — "posta uma **mensagem de sistema** no canal padrão de cada comunidade afetada"; `frontend.md:1601` — a implementação registra o oposto: "posta como o host, não como sistema. §2 não tem tipo de mensagem de sistema" |
| **Referência Backend** | `backend.md:2079` — `host.notifyBeforeExit` appenda uma `message.send` **assinada pelo host**; `backend.md:178-180` — exceção declarada à regra "o núcleo nunca formata texto de interface" |
| **Comportamento esperado** | Um aviso visualmente distinto de uma mensagem comum. |
| **Comportamento suportado** | Uma mensagem normal, do autor host, indistinguível de qualquer outra. |
| **Divergência** | Semântica divergente entre o texto de 3.5 e o modelo (§2 da UX, §4.7 do backend), já resolvida de fato pelo código e pelo backend na mesma direção. |
| **Impacto** | Só texto — mas é o tipo de frase que gera um tipo de mensagem inventado na implementação. |
| **Severidade** | **Baixa** |
| **Documento a alterar** | `frontend.md` (§10, 3.5) |

---

**RT-14 — Quatro fixtures do mock não são produzíveis pelo modelo real (verificado em código)**

| | |
|---|---|
| **Referência UX** | `frontend.md:73-124` (dataset de referência) e os 206 casos de verificação que o usam (`frontend.md:1512-1514`) |
| **Referência Backend** | §4.1, §4.7, §6.5, §10.2.1, §25 delta 2 e 8 |
| **Comportamento esperado** | Paridade fixture ↔ modelo real, exigida por `backend.md` §21.7. |
| **Comportamento suportado** | Quatro divergências verificáveis no código: **(a)** código de convite de 6 caracteres (`mocks/dataset.ts:727`, `communityStore.ts:445`) × 16 do backend; **(b)** `InvitePreview` com 4 estados (`domain/types.ts:236-240`) × 6; **(c)** `MessageDeliveryState` sem `dropped` (`domain/types.ts:184-189`) × os 4 estados de cliente da outbox; **(d)** `Message` com um único `timestamp` (`domain/types.ts:197`) × `author_ts` + `host_ts` + `clock_skewed`. Some-se a fixture de **7 espectadores num canal com 3 participantes** (`mocks/dataset.ts:420` e `:885`), já registrada em §25 delta 8. |
| **Divergência** | O dataset que serve de critério de aceite não é gerável por `dev.seedDataset` "por ops reais" (`backend.md:2982`). |
| **Impacto** | O teste de paridade de §21.7 — o único que amarra a UI implementada ao backend — não pode passar sem reescrever fixtures **ou** contrato. Corrigir depois de 206 checagens escritas é caro. |
| **Severidade** | **Alta** |
| **Documento a alterar** | `frontend.md` (§2 dataset) — e o código de fixtures, que não é documento |

---

**RT-15 — Nomes de injeção de falha divergem entre o Apêndice B e o mock**

| | |
|---|---|
| **Referência UX** | `frontend.md:1469`; `frontend/src/store/voiceStore.ts:105-113`, `downloadStore.ts:26`, `settingsStore.ts:80`, `messageStore.ts:59`, `connectionStore.ts:16` |
| **Referência Backend** | `backend.md:2962-2986` (Apêndice B), `backend.md:1552-1556` (lista `dev.*`) |
| **Comportamento esperado** | "Espelha botão a botão o `DevBar.tsx`" (`backend.md:1550`). |
| **Comportamento suportado** | Espelha o **efeito**, não o nome: `dev.forceTurn` ↔ `devSetTurnFallback`, `dev.dropTreeNode` ↔ `devRepairTree`, `dev.hostOffline/Online` ↔ `connectionStore.setHostStatus`, `dev.failNextSend` ↔ `messageStore.setFailNextSend`. |
| **Divergência** | Nomes divergentes numa tabela que se apresenta como mapeamento 1:1. |
| **Impacto** | Só ferramental de desenvolvimento; nenhum efeito em produção. |
| **Severidade** | **Baixa** |
| **Documento a alterar** | `backend.md` (Apêndice B) |

---

### 3.2 Inconsistências já documentadas que esta matriz confirma

Não reescritas aqui — a coluna "Linha da matriz" liga cada uma ao ponto exato da cadeia em
que o elo quebra.

| Achado | Resumo de uma linha | Linha da matriz | Sev. | Documento a alterar |
|---|---|---|---|---|
| `F-12` | Auto-save de 800 ms × ops ⏱ síncronas × rate limit de 20/60 s × log append-only | K-3, E-2, P-4 | Alta | ambos |
| `F-15` | Reagir, editar, fixar e criar thread são RPC de 30 s contra UI otimista sem rollback | M-5, M-8, M-10, M-11 | Alta | ambos (§25 delta 12 é insuficiente) |
| `F-16` | `query.outbox` sem contrato de dados — a fila não pode ser redesenhada ao reabrir | M-2, N-2 | Alta | `backend.md` §10.4 |
| `F-18` | Espectador é/não é participante do canal de voz — a UI implementada assume o oposto | V-11, RT-14 | Alta | ambos |
| `F-21` | Código de convite de terceiros não tem fonte | C-5 | Alta | ambos |
| `F-08` | Qualidade escolhida por quem assiste é inerte num nó que não transcodifica | V-13 | Alta | ambos |
| `F-10` / `DS-08` | O firewall torna o preview `banned` e três motivos de descarte inalcançáveis | C-2, M-4 | Alta | `backend.md` |
| `F-32` / `DR-09` / `T-29` | `handle`: três derivações incompatíveis | I-6 | Alta | ambos |
| `F-33` / `T-26` | `hostTs` × hora local de chegada | M-17 | Média | ambos |
| `F-34` | Sem evento para log de auditoria e para convites | C-4, C-6, P-14 | Média | `backend.md` §10.3 |
| `F-35` / `DR-35` | Ser expulso ou banido não tem ciclo de vida no cliente do alvo | K-4, P-10 | Média | ambos |
| `F-44` / `DR-19` | `message.accepted` sem `clientRef`; janela `accepted`→`appended` sem dono | M-1 | Média | `backend.md` |
| `F-47` | `replyToId` para mensagem deletada sem comportamento | M-7 | Baixa | ambos |
| `DR-38` | `query.links` sem tabela nem regra de extração | A-8 | Média | `backend.md` |
| `DR-40` | `local_blob_cache.state` sem enum; sem retomada após crash | A-2 | Média | `backend.md` |
| `DR-42` | "Fala ativa" sem fonte — e é requisito de acessibilidade | V-5 | Média | `backend.md` §4.16/§10.3 |
| `DR-45` | Relação mudo/ensurdecer e volume por participante decididos só no frontend | V-4, V-6 | Baixa | ambos |
| `DR-46` | As 17 queries de §10.4 sem schema de resposta | P-1, P-16, A-7, e todas as leituras | Alta | `backend.md` §10.4 |
| `DR-47` | Quem reagiu não tem contrato de leitura | M-6 | Média | `backend.md` §10.4 |
| `DR-48` | Não-lidas de thread sem tabela nem query | M-9 | Média | `backend.md` |
| `DR-49` | Rótulo do autor no log não é congelado | P-15 | Baixa | `backend.md` §4.13 |
| `DR-25` / `T-44` | Queries de leitura sem enforcement; `view_audit_log` inaplicável | P-14 | Média | ambos |
| `DR-26` | `manage_community` × `create_invite` se contradizem sobre criar/revogar convite | C-6 | Média | `backend.md` |
| `DR-29` / `DR-33` | `hostStatus` sem enum fechado e sem estado inicial | N-1 | Média | `backend.md` |
| `DS-11` | Buraco de replicação congela a projeção sem estado nem evento observável | S-3, RT-11 | Alta | `backend.md` |
| `DS-14` | `share.assignment` sem ACK: subárvore escurece com `treeHealth: ok` | V-15 | Alta | `backend.md` |
| `DS-06` / `DS-16` | Sem reconciliação outbox↔projeção; retry manual gera `opId` novo | M-2, M-4 | Alta | `backend.md` |
| `T-31` / `F-26` | `mention_everyone` sem ponto de aplicação construível | M-13 | Alta | `backend.md` |
| `T-40` | Silenciar na chamada é conselho, não enforcement | V-7 | Média | ambos |
| `T-18` | Markdown sem allowlist de esquema de URL | M-19 | Alta | ambos |
| `T-33` | UI não distingue rate limit de host offline | N-3 | Alta | `frontend.md` §12 |
| `F-23` / `F-24` | Catálogo diz 29 `kind`s, tem 34; `community.leave` não é `kind` | K-4 | Baixa | `backend.md` §5.3 |
| `F-28` | `E_CLOCK_UNREASONABLE`, `E_NOT_BANNED`, `E_ALREADY_SENT`, `E_SESSION_FULL` fora do catálogo | P-13, V-19 | Média | `backend.md` §16.2 |
| `F-27` | Limites de §19.2 sem ponto de enforcement em §9.3 | — (transversal) | Média | `backend.md` |
---

## 4. Classificação das features

### 4.1 UX completamente rastreadas (38 de 117)

Cadeia inteira verificada — comando, operação, persistência, projeção, evento e erro com
destino na UI.

**Estrutura de canais e categorias** é a área mais bem rastreada do produto (8 de 12 linhas
`COMPLETE`): criar canal (E-1), mover (E-3), excluir (E-4), excluir com chamada dentro (E-5),
CRUD de categoria (E-6), colapsar (E-7), gatilhos desabilitados com host offline (E-8),
silenciar canal (E-9). Não é acaso: é a única área em que a spec de UX e a de backend foram
escritas **depois** do código (Partes 10 e 11) e puderam se conferir.

Demais: criar identidade (I-1) · presença (I-3) · aviso de host em 0.4 (K-2) · digitando
(M-14) · divisor de novas mensagens (M-15) · scroll infinito (M-16) · composer bloqueado em
canal somente-leitura (M-20) · peer perdido no download (A-3) · anexo indisponível (A-4) ·
aba Fixados (A-9) · ordenação por recência (S-2) · escopo da busca só em texto (S-4) ·
popover de perfil (P-2) · apelido auto-atribuído (P-3) · atribuir cargos (P-7) · remover
timeout (P-12) · nota de honestidade do ban (P-17) · entrar em voz (V-1) · voz bloqueada com
host offline (V-2) · mesh parcial (V-3) · barra persistente e C11 (V-8) · topologia
estrela/árvore (V-11) · consentimento de repasse (V-14) · badge TURN (V-16) · reparo de
árvore (V-17) · rail com host offline (N-4) · aviso de saída do host (N-5) · shutdown
(N-7) · diagnóstico de rede (N-8) · aparência (N-12).

### 4.2 UX parcialmente rastreadas (50 de 117)

O padrão dominante: **o comando existe, a persistência existe, e falta o contrato de leitura
ou o evento de invalidação**. As mais custosas, por ordem de impacto:

| Feature | O elo que falta |
|---|---|
| Fila offline durável (M-2, N-2) | `query.outbox` sem contrato de dados (`F-16`) |
| Log de auditoria em tempo real (P-14) | não existe `auditLog.changed` (`F-34`) |
| Lista de convites (C-4, C-6) | não existe `invites.changed`; `uses` não é coberto por evento |
| Cargos e permissões (P-4, P-5, P-6) | auto-save contra comando síncrono e rate limit (`F-12`) |
| Reagir / editar / fixar / thread (M-5, M-8, M-10, M-11) | comandos ⏱ de 30 s contra UI otimista, sem rollback (`F-15`) |
| Envio de mensagem (M-1) | `clientRef` não volta; janela `accepted`→`appended` sem dono |
| Painel de membros e listas de moderação (P-1, P-16) | queries sem schema de resposta (`DR-46`) |
| Download de anexo (A-2) | `local_blob_cache.state` sem enum, sem retomada |
| Estado de host (N-1) | enum inexistente, sem estado inicial |
| Preferências (N-9, N-11) | escrita sem leitura (`RT-02`) |

### 4.3 UX sem rastreabilidade (16 de 117)

Funcionalidades que a interface promete e que **nenhum contrato de backend cobre**:

| # | Feature de UX | Onde a UX promete | Por que não rastreia |
|---|---|---|---|
| 1 | Código de convite de terceiros na lista de 3.1b | `frontend.md:718` | `secret` só existe na réplica de quem criou (`F-21`) |
| 2 | Rail respeitando "Notificações: Nada" por comunidade | `frontend.md:477` | sem query de preferências (`RT-02`) |
| 3 | "Copiar link do canal" → `/m/:code` | `frontend.md:491` | rota sem contrato (`RT-04`) |
| 4 | "Copiar link da mensagem" → `/m/:code` | `frontend.md:550` | idem |
| 5 | Participantes inline do canal de voz na sidebar | `frontend.md:473` | `query.structure` devolve só `live` (`RT-05`) |
| 6 | Quem reagiu (até 6 nomes no tooltip) | `frontend.md:550` | dado no banco, sem query (`DR-47`) |
| 7 | Badge de não-lidas da thread | `frontend.md:596` | `local_read_state` é por canal (`DR-48`) |
| 8 | Aba Links do canal | `frontend.md:580` | sem tabela nem regra de extração (`DR-38`) |
| 9 | Anel de fala ativa (requisito de acessibilidade) | `frontend.md:282`, `:630` | roster não tem `speaking` (`DR-42`) |
| 10 | Anti-escalada de permissão e de posição | — | regra nova do backend, ausente da UX (§25 delta 11) |
| 11 | "1–2 s de atraso" do espectador em árvore | — | §25 delta 3, ainda não escrito na UX |
| 12 | Consentimento de relay voluntário (3.1 → Rede) | — | §25 delta 7, superfície inexistente |
| 13 | Sem descoberta LAN | — | §25 delta 6 |
| 14 | Distinguir rate limit de host offline | — | `T-33` |
| 15 | "Testar microfone" com medidor real | `frontend.md:705` | sem comando nem evento (`RT-09`) |
| 16 | Anexo corrompido | — | `attachment.corrupt` sem estado na UX |

### 4.4 Capacidades de backend sem uso na UX (11)

Contratos especificados que nenhuma tela consome. Cada linha é ou uma tela faltando, ou um
contrato a cortar.

| Capacidade | Onde está | O que faltaria na UX |
|---|---|---|
| `core.reproject` + `core.reprojecting{done,total}` | `backend.md:1425`, `:1567`, `:1132` | O próprio backend diz que "a UI mostra barra em vez de spinner" acima de 100 k registros — **não há essa tela** em `frontend.md` |
| `core.restarted{attempt}` | `backend.md:1566`, `:2169-2172` | Estado de crash e reinício do núcleo (até 3× em 60 s, depois erro terminal) — §12 da UX não tem token para isso |
| `ipc.dropped{topic, count}` | `backend.md:1568` | Backpressure: a UI deve reconsultar; nenhum componente sabe disso (`F-17`) |
| `message.cancelQueued` | `backend.md:1469` | Nenhuma tela oferece cancelar uma mensagem pendente; §15 nem a lista entre as ações reversíveis (`DS-28`) |
| `blob.cancel` | `backend.md:1538` | O card de anexo (§6) não tem ação de cancelar download |
| `diag.snapshot` | `backend.md:1544` | Métricas de §17.3 sem superfície — 3.1 → Rede só usa `diag.run` |
| `relay.enable` / `relay.disable` | `backend.md:1529-1530` | §25 delta 7 (superfície irmã do modal 2.4.1) |
| `E_VERSION_UNSUPPORTED` → modo somente-leitura por comunidade | `backend.md:1668-1670` | Estado "cliente desatualizado" não existe na UX, e não é `host offline` |
| `swarm.changed{degraded}` / `E_SWARM_DEGRADED` | `backend.md:1585`, `:2388` | "Sem bootstrap/peers" é diferente de "host offline" e não tem token em §5.4 |
| `community.ended` → modo histórico no rail | `backend.md:1570`, `:2090-2092` | A UX especifica encerrar (3.1b) mas **não** como a comunidade encerrada aparece depois |
| `query.hostStatus.inactiveDays` | `backend.md:1631`, `:2190` | Rótulo "Inativa há muito tempo" está em `frontend.md:1120` como edge case, sem tela nem código |
---

## 5. Matriz final

Legenda: **✓** elo verificado · **⚠** existe mas diverge ou está incompleto · **✗** ausente ·
**—** não se aplica. `Persistence` cobre disco (core + SQLite + tabelas `local_*`);
`Projection` cobre a materialização legível pela UI.

| Feature | UX | IPC | Backend | RPC | Persistence | Projection | UI feedback | Status |
|---|---|---|---|---|---|---|---|---|
| Criar identidade local (A1, 0.1) | ✓ | `identity.create` | — | — | ✓ keystore | — | ✓ | **COMPLETE** |
| Editar nome/avatar (3.1) | ✓ | `identity.update` | `identity.update` ×N | ✓ | ✓ | ✓ `members` | ✓ `members.changed` | **PARTIAL** |
| Presença (3.1, 1.4) | ✓ | `identity.setPresence` | — efêmero | `presencePublish` | — | — | ✓ `presence.changed` | **COMPLETE** |
| Sair da identidade (3.1) | ✓ | `identity.wipe` | — | — | ✓ destrói tudo | — | ⚠ sem erro possível declarado | **PARTIAL** |
| Identificador `@ana` (1.4, 3.1, 3.3) | ✓ | ✓ resposta | ⚠ deriva da chave | — | — | — | ⚠ | **CONTRADICTORY** |
| Preview de convite (0.3) | ⚠ 4 de 6 | `invite.resolve` | — | `inviteResolve` | — | — | ⚠ 2 desfechos sem UI | **CONTRADICTORY** |
| Preview `banned` (0.3) | ✓ | ✓ | ✓ | ✓ | — | — | ✗ inalcançável (firewall) | **CONTRADICTORY** |
| Entrar por convite (A2) | ✓ | `invite.redeem` | `member.join` | `inviteRedeem` | ✓ 2 cores | ✓ do zero | ✓ `community.joined` | **PARTIAL** |
| Criar convite (3.1b) | ✓ | `invite.create` | `invite.create` | `submitOp` | ✓ `invites` + `secret` local | ✓ | ✗ sem evento | **PARTIAL** |
| Listar convites com código (3.1b) | ✓ | `query.invites` | — | — | ⚠ `secret` só de quem criou | ✓ | ✗ | **MISSING** |
| Revogar convite (3.1b) | ✓ | `invite.revoke` | `invite.revoke` | `submitOp` | ✓ | ✓ | ✗ sem evento | **PARTIAL** |
| Código de convite de 6 caracteres | ✓ | — | ⚠ 16 caracteres | — | — | — | — | **CONTRADICTORY** |
| Criar comunidade / virar host (A3) | ✓ | `community.create` | lote de 6 ops | — | ✓ 2 cores | ✓ | ✓ `structure.changed` | **PARTIAL** |
| Editar metadados com auto-save (3.1b) | ✓ | `community.update` ⏱ | `community.update` | `submitOp` | ✓ | ✓ | ⚠ toast × erro de rede | **CONTRADICTORY** |
| Sair da comunidade (3.1b) | ✓ | `community.leave` | ⚠ sem `kind` próprio | `submitOp` | ⚠ ciclo local indefinido | ✓ | ✓ | **PARTIAL** |
| Encerrar comunidade (3.1b) | ✓ | `community.end` | `community.end` | `submitOp` | ✓ `ended_at` | ✓ | ⚠ modo histórico não especificado | **PARTIAL** |
| Não-lidas e menções no rail (1.1) | ✓ | `query.communities` | — | — | ✓ `local_read_state` | ⚠ contagem dupla na reprojeção | ✓ `unread.changed` | **PARTIAL** |
| CRUD de canal (3.4, D14, D15) | ✓ | `channel.*` ⏱ | 4 `kind`s | `submitOp` | ✓ `channels` | ✓ | ✓ `structure.changed` | **COMPLETE** |
| CRUD de categoria (3.4) | ✓ | `category.*` ⏱ | 3 `kind`s | `submitOp` | ✓ `categories` | ✓ | ✓ | **COMPLETE** |
| Editar canal com auto-save (3.4) | ✓ | `channel.update` ⏱ | ✓ | `submitOp` | ✓ | ✓ | ⚠ debounce × rate limit | **CONTRADICTORY** |
| Silenciar canal / marcar como lido (1.1.1) | ✓ | `channel.setMuted` / `.markRead` | — local | — | ✓ `local_*_pref` | ✓ | ⚠ menções não declaradas | **PARTIAL** |
| Participantes inline do canal de voz (1.1) | ✓ | `query.structure` | ✗ | ⚠ roster só a participantes | ✗ | ✗ | ✗ | **MISSING** |
| Enviar mensagem (C9) | ✓ | `message.send` | `message.send` | `submitOp` | ✓ outbox → core | ✓ `messages` | ⚠ sem `clientRef` | **PARTIAL** |
| Fila offline durável (B4, premissa 5) | ✓ | `query.outbox` | — | — | ✓ `local_outbox` | ✗ sem contrato de leitura | ✓ `outbox.changed` | **PARTIAL** |
| Descarte nomeado da fila (§18) | ✓ | *(evento)* | — | — | ✓ `dropped_reason` | ✓ | ⚠ 3 motivos inalcançáveis | **PARTIAL** |
| Reagir (2.1) | ✓ | `message.react` ⏱ | `reaction.toggle` | `submitOp` | ✓ `reactions` | ✓ | ⚠ otimista sem rollback | **CONTRADICTORY** |
| Quem reagiu (tooltip, 2.1) | ✓ | ✗ | — | — | ✓ `identity_key` | ✓ | ✗ | **MISSING** |
| Responder inline (2.1) | ✓ | `message.send` | ✓ | `submitOp` | ✓ `reply_to_id` | ✓ | ⚠ alvo deletado sem regra | **PARTIAL** |
| Thread (2.2) | ✓ | `thread.create` ⏱ | `thread.create` | `submitOp` | ✓ `threads` | ✓ | ⚠ ⏱ contra UI otimista | **PARTIAL** |
| Não-lidas de thread (2.2) | ✓ | ✗ | — | — | ✗ | ✗ | ✗ | **MISSING** |
| Fixar / aba Fixados (2.1, 2.1.2) | ✓ | `message.pin` / `query.pinned` | `message.pin` | `submitOp` | ✓ | ✓ | ⚠ ⏱ | **PARTIAL** |
| Editar mensagem (2.1) | ✓ | `message.edit` ⏱ | `message.edit` | `submitOp` | ✓ `edited_at` | ✓ | ⚠ conteúdo antigo fica no log | **PARTIAL** |
| Deletar mensagem (2.1) | ✓ | `message.delete` ⏱ | `message.delete` | `submitOp` | ✓ tombstone | ✓ | ⚠ "não pode ser desfeito" | **PARTIAL** |
| Menções e `@everyone` (2.1.1) | ✓ | `message.send{mentions}` | ⚠ sem ponto de aplicação | `submitOp` | ✓ | ✓ | ✓ | **PARTIAL** |
| Digitando (2.1) | ✓ | *(evento)* | — efêmero | `presencePublish` | — | — | ✓ `typing.changed` | **COMPLETE** |
| Carimbo e relógio adiantado (§5.10) | ✓ | — | ⚠ `hostTs` × hora de chegada | — | ✓ 2 carimbos + flag | ✓ | ⚠ | **CONTRADICTORY** |
| Rota `/m/:code` (§4) | ✓ | ✗ | ✗ | — | ✗ | ✗ | ✓ 3 desfechos só no mock | **MISSING** |
| Markdown (§0 premissa 8) | ✓ | — | ✓ conteúdo cru | — | ✓ | ✓ | ⚠ sem allowlist de URL | **PARTIAL** |
| Anexar arquivo (C9) | ✓ | `blob.stage` | `message.send{attachment}` | — | ✓ core de blobs | ✓ `attachments` | ✓ | **PARTIAL** |
| Baixar arquivo (B8) | ✓ | `blob.download` | — | `hyperblobs.get` | ✓ `local_blob_cache` | — | ✓ `blob.progress` | **PARTIAL** |
| Aba Arquivos (2.1.2) | ✓ | `query.files` | — | — | ✓ | ✓ | ✓ | **PARTIAL** |
| Aba Links (2.1.2) | ✓ | `query.links` | — | — | ✗ sem tabela | ✗ | ✓ | **MISSING** |
| Busca com filtros (1.2, C10) | ✓ | `query.search` | — | — | ✓ FTS5 | ✓ | ✓ | **PARTIAL** |
| Aviso de resultado incompleto (1.2) | ✓ | `partial: bool` | — | — | — | — | ✓ banner | **PARTIAL** |
| Painel de membros (1.3) | ✓ | `query.members` | — | — | ✓ `members` | ✓ | ✓ `members.changed` | **PARTIAL** |
| Popover de perfil (1.4) | ✓ | `query.member` | — | — | ✓ | ✓ `canModerate` | ✓ | **COMPLETE** |
| Apelido por comunidade (1.4) | ✓ | `member.setNickname` ⏱ | `member.setNickname` | `submitOp` | ✓ | ✓ | ✓ | **COMPLETE** |
| CRUD de cargo (3.2, D13) | ✓ | `role.*` ⏱ | 4 `kind`s | `submitOp` | ✓ `roles` | ✓ | ⚠ auto-save × ⏱ × rate limit | **CONTRADICTORY** |
| Hierarquia e anti-escalada (3.2) | ⚠ só hierarquia | ✓ erros dedicados | ✓ §8.3 | ✓ | ✓ | ✓ | ✗ 2 regras sem UI | **PARTIAL** |
| Atribuir cargos (1.4, 3.2) | ✓ | `member.setRoles` ⏱ | ✓ | `submitOp` | ✓ `member_roles` | ✓ | ✓ | **COMPLETE** |
| Banir / expulsar / timeout (D12) | ✓ | `mod.*` ⏱ | 5 `kind`s | `submitOp` | ✓ 1 transação | ✓ | ⚠ reversibilidade e ciclo do alvo | **PARTIAL** |
| Log de auditoria (3.3) | ✓ | `query.auditLog` | projeção | — | ✓ `moderation_log` | ⚠ enum divergente | ✗ sem evento | **PARTIAL** |
| Banidos / timeouts (3.3) | ✓ | `query.bans` / `.timeouts` | ✓ | — | ✓ | ✓ | ⚠ relógio de quem lê | **PARTIAL** |
| Entrar em canal de voz (B7) | ✓ | `voice.join` ⏱ | — efêmero | `voiceJoin` + ICE direto | — | — | ✓ `voice.roster` | **COMPLETE** |
| Mudo / ensurdecer / câmera (2.3, 2.3.2) | ✓ | `voice.setSelf` | — | `voiceState` | — | — | ✓ | **PARTIAL** |
| Anel de fala ativa (2.3, 2.3.1) | ✓ | ✗ | ✗ | ✗ sem `speaking` | — | — | ✗ | **MISSING** |
| Volume por participante (1.4) | ✓ | `voice.setParticipantVolume` | — | — | ✗ sem coluna | — | ✓ | **PARTIAL** |
| Silenciar outro na chamada (1.4) | ✓ | `voice.muteParticipant` | — | host valida | — | — | ✓ | **PARTIAL** |
| Barra persistente e C11 (2.3.1) | ✓ | — | — | — | — | — | ✓ | **COMPLETE** |
| Compartilhar tela, estrela↔árvore (2.4, B5) | ✓ | `share.start` | — efêmero | `shareStart`/`shareJoin` | — | — | ✓ `share.topologyChanged` | **COMPLETE** |
| Ajustar qualidade (2.4) | ✓ | `share.setQuality` | ✗ inerte | — | — | — | ✗ sem evento | **CONTRADICTORY** |
| Consentimento de repasse (2.4.1, B6) | ✓ | `share.respondConsent` | — | — | ✓ `local_relay_consent` | — | ✓ `share.consentRequested` | **COMPLETE** |
| Painel de saúde da árvore (2.4.2) | ✓ | — | — | `shareHeartbeat` | — | — | ⚠ escopo e sem ACK | **PARTIAL** |
| Múltiplos compartilhamentos (§18) | ✓ | `E_ALREADY_SHARING` | ✗ 0..1 por canal | — | — | — | ✗ | **CONTRADICTORY** |
| Atraso de 1–2 s em árvore (2.4) | ✗ | — | ✓ jitter por nível | — | — | — | ✗ | **MISSING** |
| Relay voluntário (3.1 → Rede) | ✗ | `relay.enable` | `relay.volunteer` | ✓ | ✓ `relay_volunteers` | ✓ | ✗ | **MISSING** |
| Host offline / reconectando (B4, §12) | ✓ | `query.hostStatus` | — | `hello` | ✓ `last_host_seen_at` | — | ⚠ enum indefinido | **PARTIAL** |
| Aviso de saída do host (3.5) | ✓ | `host.exitImpact` | roster efêmero | — | — | — | ✓ | **COMPLETE** |
| "Avisar quem está online" (3.5) | ✓ | `host.notifyBeforeExit` | `message.send` do host | `submitOp` | ✓ | ✓ | ⚠ "mensagem de sistema" não existe | **PARTIAL** |
| Diagnóstico de rede / CGNAT (3.1) | ✓ | `diag.run` | — | — | — | — | ✓ `nat.detected` | **COMPLETE** |
| Dispositivos e volumes (3.1) | ✓ | `settings.setDevice/Volume` | — | — | ✓ `local_device_pref` | ✗ sem leitura | ⚠ | **PARTIAL** |
| Notificações por comunidade (3.1) | ✓ | `settings.setNotifications` | — | — | ✓ `local_community_pref` | ✗ sem leitura | ⚠ | **PARTIAL** |
| Testar microfone / medidor (3.1) | ✓ | ✗ | ✗ | — | — | — | ✓ só simulado | **MISSING** |
| Prioridade do áudio sobre vídeo (§18) | ✓ | ✗ | ✗ sem regra | — | — | — | ✓ só simulado | **UNCLEAR** |
| Rótulo "Inativa há muito tempo" (§18) | ✓ | `query.hostStatus` | job `host.inactivity` | — | ✓ | ✓ `inactiveDays` | ✗ sem UI | **PARTIAL** |
| Reprojeção com barra de progresso | ✗ | `core.reproject` | ✓ | — | ✓ | ✓ | ✗ | **MISSING na UX** |
| Crash e reinício do núcleo | ✗ | — | ✓ até 3× em 60 s | — | — | — | ✗ `core.restarted` sem token | **MISSING na UX** |
| Backpressure de IPC | ✗ | — | ✓ `IPC_EVENT_HIGHWATER` | — | — | — | ✗ `ipc.dropped` sem consumidor | **MISSING na UX** |
| Cancelar mensagem enfileirada | ✗ | `message.cancelQueued` | — | — | ✓ | — | ✗ | **MISSING na UX** |
| Cancelar download | ✗ | `blob.cancel` | — | — | ✓ | — | ✗ | **MISSING na UX** |
| Cliente com versão incompatível | ✗ | — | ✓ modo somente-leitura | `hello` | — | — | ✗ `E_VERSION_UNSUPPORTED` sem UI | **MISSING na UX** |
| Swarm degradado (sem bootstrap) | ✗ | — | ✓ `E_SWARM_DEGRADED` | — | — | — | ✗ sem token em §5.4 | **MISSING na UX** |

**Totais:** 117 comportamentos rastreados · **COMPLETE 38** · **PARTIAL 50** · **MISSING 16**
(+8 capacidades de backend sem UX, contadas em §4.4) · **CONTRADICTORY 12** · **UNCLEAR 1**.

---

## 6. Leitura final

Três observações que a matriz produz e que nenhuma auditoria isolada produzia:

1. **A rastreabilidade quebra sistematicamente no mesmo elo.** Das 50 linhas `PARTIAL`, 20
   perdem o mesmo elo — **contrato de leitura, projeção ou evento de invalidação** (C-4, C-6,
   K-1, K-6, E-10, M-1, M-2, A-2, A-7, P-1, P-14, P-15, P-16, S-3, V-15, V-18, N-1, N-2, N-9,
   N-11) —, mais do que qualquer outra causa isolada. O eixo de escrita
   (UX → IPC → op → RPC → log) está bem coberto; o eixo de leitura (projeção → query →
   evento → estado exibido) é onde o documento de backend para na prosa. `DR-46` já pede o
   schema das 17 queries; esta matriz mostra que o custo não é uniforme — cinco superfícies
   (`RT-02`, `RT-05`, `DR-47`, `DR-48`, `DR-38`) precisam de **dado que hoje não é devolvido
   por query nenhuma**, não só de um schema escrito.

2. **§25 é bom e está incompleto na mesma proporção que a auditoria adversarial estimou.**
   Dos 12 deltas, **7 caem exatamente sobre linhas que esta matriz classificou como
   `CONTRADICTORY` ou `MISSING`** (deltas 2, 3, 4, 5, 6, 7 e 11); os outros 5 caem em linhas
   `PARTIAL` ou já cobertas pelo código. Sobram 21 das 28 divergências dessas duas classes
   sem delta correspondente. As que mais doem: auto-save (`F-12`), ações
   otimistas de mensagem (`F-15`), código de convite de terceiros (`F-21`), `handle`
   (`F-32`), carimbo (`F-33`), qualidade de tela (`F-08`), e — novos aqui — preferências sem
   leitura (`RT-02`), `/m/:code` (`RT-04`) e participantes de voz na sidebar (`RT-05`).

3. **O frontend implementado é o terceiro documento, e ele discorda dos outros dois em
   pontos que ninguém registrou.** `frontend.md:1459` afirma "espectador ≠ participante" e
   `backend.md:2037` afirma o contrário; `frontend.md:1457` decidiu "ensurdecer implica mudo"
   sozinho e isso vira contrato observável no roster; `identityStore.ts:50` deriva o `handle`
   do nome enquanto `backend.md:289` o deriva da chave. A precedência de `backend.md:36-48`
   coloca o código em quarto lugar — mas são 18 407 linhas e 206 casos de verificação
   escritos contra essas decisões, e o custo de reverter não está estimado em documento
   nenhum.
