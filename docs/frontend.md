# Especificação de UX/UI — Comunidade P2P (Frontend Mockado)

> ## ⚠️ CORRIGIDA POR `docs/deltas-ux-v2.md`
>
> Este documento **continua válido** em tudo que os deltas não tocam — arquitetura de
> informação, design system, componentes, e a maior parte das telas e fluxos.
>
> **Onde ele e `docs/deltas-ux-v2.md` discordarem, os deltas vencem.** São 28 mudanças de
> produto exigidas pela arquitetura v2 (`docs/backend-v2.md`), incluindo alterações na
> **premissa 3** (passa a existir backup de identidade), no **eixo otimista** da Camada 2,
> no **preview de convite**, no **compartilhamento de tela** e no **dataset de referência**
> de §2. Ler os deltas antes de implementar qualquer coisa deste documento.

---

> Fonte de verdade para a implementação do frontend mockado. Cobre arquitetura de informação, navegação, design system, especificação tela-a-tela, fluxos, estados, formulários, responsividade e edge cases. Não contém código — apenas decisões prescritivas de produto e interface.

## 0. Contexto

> **Nota de estado — 2026-09-05.** O parágrafo abaixo descreve o repositório **em
> 2026-08-11**, quando esta spec foi escrita, e virou histórico. O que mudou, e que vale
> quando alguém for ler o resto deste documento:
>
> - **O frontend não é mais mockado.** Todo o dado de domínio — comunidades, canais,
>   membros, mensagens, cargos, convites, log de moderação — vem do núcleo pela IPC-R
>   (`frontend/src/live/sincronizacao.ts` e `adaptadores.ts`). `src/mocks/dataset.ts` guarda
>   três constantes de produto e nenhuma fixture. Onde este documento diz "conteúdo
>   mockado", leia **dado de referência de §2**: descreve a aparência esperada da tela, não
>   a origem do dado.
> - **A camada P2P existe, e parte dela é do renderer.** Voz em malha e tela em estrela são
>   WebRTC dentro do frontend (`frontend/src/live/voz.ts`, `tela.ts`, `camera.ts`); a
>   descoberta e a replicação são do núcleo (`core/src/l0/swarm/`, com `Hyperswarm` real).
>   `backend/` continua vazio e não vai receber nada — ver `backend/README.md`.
> - **A plataforma-alvo é Electron, não browser** — isto corrige a premissa 1 abaixo. Ver
>   `CLAUDE.md` e `docs/backend-v2.md` §3.1. As limitações que esta spec declara por causa do
>   browser foram resolvidas no shell: o diálogo de saída de §18.7 (`app/src/main`, com o
>   smoke `smoke:fechamento`), a captura de tela real (`app/src/main/captura.ts` sob
>   `setDisplayMediaRequestHandler`) e o seletor de arquivo do SO (`dialog.showOpenDialog`,
>   por trás de `api.filePickForAttachment`).
>
> Tudo que é decisão de UX/UI — arquitetura de informação, design system, telas, fluxos,
> estados — continua valendo, corrigido por `deltas-ux-v2.md` como o aviso acima diz.

O "Comunidade P2P" é um app de comunidade (texto/voz/vídeo/tela) 100% P2P, sem servidor central — cada comunidade é hospedada pela máquina de quem a criou (`CLAUDE.md:1-5`). Hoje (2026-08-11) o repositório é um scaffold vazio: `frontend/src/App.tsx` é uma única `div` placeholder em fundo escuro (`bg-neutral-900 text-neutral-100`), sem componentes, rotas ou dados mockados — confirmado por leitura direta do código e pela consulta ao grafo de conhecimento do graphify (`graphify query`), que não extraiu nenhuma tela ou componente porque nenhum existe além de configuração de build. Não há backend real: `backend/` é só um README dizendo que a lógica P2P (Hyperswarm/Hypercore/Hyperdht) entra depois que o frontend, com dados mockados, estiver validado (`CLAUDE.md:33-35`, `backend/README.md:7-10`).

Este documento define exatamente o que esse frontend mockado deve ser, tela por tela e fluxo por fluxo, com dados simulados concretos, para que quem implementar não precise tomar decisões de UX/UI por conta própria.

### Decisões confirmadas com o usuário

| Decisão | Escolha |
|---|---|
| Cor de destaque (accent) | Violeta/índigo |
| Escopo de recursos de mensagem | Completo, estilo Discord — inclui threads completas, reações, menções, markdown, responder, fixar, editar/deletar |
| Suporte a tema | Somente escuro na v1 (sem tema claro) |

### Premissas assumidas (não bloqueantes)

Onde o `CLAUDE.md` não define algo e a decisão não justificava outra rodada de perguntas, assumi a opção mais conservadora e documento aqui — quem revisar pode contestar qualquer uma destas antes da implementação:

1. **Plataforma-alvo do mock**: aplicação web (browser), no stack atual (Vite+React). Interações de shell desktop (bandeja do sistema, notificação nativa do SO, protocolo customizado `comunidadep2p://`) **não** fazem parte desta spec — aparecem só como nota de compatibilidade futura na seção de Navegação, já que Hyperswarm/Hypercore/Hyperdht provavelmente vão exigir runtime nativo (Electron/Tauri/Bare) quando o backend real chegar.
2. **Sem descoberta pública de comunidades.** A única porta de entrada é convite (link ou código). Um diretório público exigiria índice central curado, o que contradiz "sem servidor central" (`CLAUDE.md:3-4`).
3. **Identidade é local a um dispositivo.** Sem backup/export/import de chave, sem múltiplos dispositivos simultâneos, sem migração de host no v1 — `CLAUDE.md:5` fala em "a máquina de quem a criou" no singular.
4. **Convites** sem expiração por padrão, mas configuráveis (expiração e limite de usos) na criação, e revogáveis a qualquer momento.
5. **Mensagem enviada com o host offline** entra numa fila local ("pendente de envio") em vez de bloquear o composer — consistente com o modelo de réplica local do Hypercore e com apps offline-first. **A fila é durável:** sobrevive a fechar e reabrir o app, senão "será enviada quando o host voltar" é uma promessa que o produto não cumpre (§18 e §12 detalham o que a interface mostra ao reabrir com fila pendente).
6. **Réplica local de quem não é host é parcial**: só o que sincronizou enquanto esteve online. Busca em modo cache/offline pode retornar resultado incompleto, e a interface comunica isso explicitamente.
7. **Notificações**: badge de não-lido e mute por canal/comunidade fazem parte do v1; notificação nativa do SO fica fora (depende da premissa 1).
8. Bloco de código monoespaçado faz parte do "markdown básico" do composer (coerente com o escopo "completo, estilo Discord").
9. **Câmera é escopo, e é mesh como a voz.** `CLAUDE.md:1` chama o produto de "voz/vídeo/tela" e §2 dá `câmeraOn` ao participante, então vídeo de câmera fica dentro (§9, 2.3.2). Mas a árvore de multicast de `CLAUDE.md:12-19` é sobre **transmissão para audiência**; câmera numa chamada é poucos-para-poucos, então segue o mesmo mesh direto da voz, sem topologia em árvore. Alternativa descartada: cortar câmera do v1 — contradiria o nome do próprio produto.
10. **Link de mensagem é endereçável; canal e comunidade não.** §4 ganha uma terceira rota só pra mensagem (`/m/:code`). A distinção que mantém o raciocínio original de §4 de pé: canal selecionado é *estado de navegação* (não vale endereçar), enquanto link de mensagem é *referência compartilhada a um artefato específico* que viaja para fora da sessão — colado noutro canal, num bloco de notas, noutro app — e precisa resolver na chegada, exatamente como o convite.
11. **Apelido é auto-atribuído.** Cada pessoa define o próprio apelido por comunidade (§8, 1.4); moderador não renomeia os outros no v1. Evita inventar uma permissão `gerenciar apelidos` que não está no checklist de §10 (3.2) nem no `CLAUDE.md`.

### Fora de escopo explícito (v1)

- Mensagens diretas (DM) entre usuários — `CLAUDE.md` descreve apenas canais dentro de uma comunidade, nunca conversa 1:1 fora desse contexto.
- Diretório/descoberta pública de comunidades (premissa 2).
- Multi-dispositivo, export/import de identidade, migração de host (premissa 3).
- Sistema de reputação ou moderação global entre comunidades — `CLAUDE.md:49` lista "moderação em escala sem autoridade central" como **problema em aberto**, não como feature resolvida. O mock cobre apenas moderação por-comunidade via cargos/permissões.
- Notificação nativa do SO, bandeja do sistema, deep link de protocolo customizado (premissa 1).

## 1. Princípios de produto

1. **Nada de servidor central em lugar nenhum da UX.** Toda tela que em produtos equivalentes dependeria de uma API central (login com senha, diretório de comunidades, "esqueci minha senha") precisa ser repensada em termos P2P (identidade local, convite, backup de chave) ou explicitamente removida.
2. **A saúde da conexão é informação de primeira classe.** Como não existe "o servidor está de pé" garantido, o estado de conexão (com o host, com peers de voz, com a árvore de multicast) é sempre visível, nunca escondido atrás de um spinner genérico.
3. **Honestidade sobre limitações conhecidas.** Onde a arquitetura tem um problema em aberto (CGNAT, reparo de árvore, consentimento de repasse, moderação em escala — `CLAUDE.md:45-49`), a interface comunica a limitação em vez de fingir que não existe (ex.: banir alguém não impede tecnicamente que volte com identidade nova por outro convite — o texto de confirmação de ban diz isso).
4. **Dark-only, superfícies por elevação.** Sem tema claro no v1. Hierarquia visual vem de variação de luminância entre camadas de superfície + borda sutil de 1px, não de sombra (sombra preta tem pouco contraste sobre fundo já escuro).
5. **Consistência com o gênero onde não há motivo pra divergir.** Layout de 3-4 colunas, rail de comunidades, lista de canais agrupados por categoria — são padrões testados (Discord) que o usuário já entende; a diferenciação de produto está nos pontos genuinamente P2P (saúde de conexão, modo cache offline, topologia de compartilhamento de tela), não em reinventar a navegação básica.

## 2. Modelo de domínio (entidades mockadas)

Todas as telas abaixo referenciam este modelo. Os dados não vêm de nenhuma API — vivem em fixtures locais (ex.: um módulo `mocks/` consumido pelas stores Zustand) e devem ser internamente consistentes entre telas (o mesmo usuário, os mesmos IDs, aparecem em todas as specs abaixo).

| Entidade | Campos relevantes para a UI |
|---|---|
| **Identity** (identidade local) | par de chaves (não exibido, só existência), `displayName`, `avatarColor`/`avatarEmoji`, `statusPresence` (online/ausente/ocupado/invisível) |
| **Community** | `id`, `nome`, `ícone`, `descrição`, `hostPeerId`, `souEuOHost: bool`, `createdAt`, `memberCount`, `categorias[]`, `canais[]`, `cargos[]`, `connectionHealth` |
| **Category** | `id`, `nome`, `canais[]`, `colapsada: bool` |
| **Channel** | `id`, `tipo` (texto \| voz), `nome`, `tópico?`, `categoriaId`, `naoLidas: int`, `mencoesPendentes: int`, `silenciado: bool`, `somenteLeituraParaCargos[]` (quem **não** posta aqui — é assim que `#avisos` existe; única permissão por-canal do v1, §10 3.4), `participantesVoz[]` (só se tipo=voz) |
| **Role** (cargo) | `id`, `nome`, `cor` (do conjunto curado, ver §5.1), `posição` (hierarquia), `permissões[]`, `mencionável: bool`, `membroCount` |
| **Member** | identidade + `roles[]` *dentro desta comunidade*, `apelido?`, `joinedAt`, `presence`, `banido: bool` |
| **Message** | `id`, `autorId`, `canalId`, `conteúdo` (markdown), `timestamp`, `editado: bool`, `respondendoA?: messageId`, `fixado: bool`, `reações[]`, `anexos[]`, `menções[]`, `threadId?` |
| **Thread** | `mensagemRaizId`, `respostas[]`, `participantes[]`, `naoLidas: int` |
| **Reaction** | `emoji`, `contagem`, `usuários[]` |
| **Attachment** | `nome`, `tamanhoBytes`, `tipo`, `progressoDownload: 0-100`, `peersDisponíveis: int`, `hostDisponível: bool` |
| **VoiceSession** | `canalId`, `participantes[{identityId, falando: bool, mudo: bool, ensurdecido: bool, câmeraOn: bool, compartilhandoTela: bool}]` |
| **ScreenShareSession** | `apresentadorId`, `modo` (estrela \| árvore), `espectadores[]`, `qualidade`, `saúdeÁrvore` (ok/reparando/degradada) |
| **Invite** | `código`, `comunidadeId`, `criadoPor`, `expiraEm?`, `usosMax?`, `usosAtuais`, `revogado: bool` |
| **ModerationAction** | `tipo` (kick \| ban \| timeout \| deleteMessage \| createRole \| deleteRole \| createChannel \| deleteChannel \| createCategory \| deleteCategory), `alvoId`, `autorId`, `motivo?`, `timestamp`. O log de 3.3 é da comunidade, não só de punições — §2 já registra "criou o cargo Contribuidor", e mudança de estrutura de canais (§10, 3.4) entra pela mesma porta |
| **ConnectionHealth** | por comunidade: `hostStatus` (online/offline/reconectando); por voz: `meshStatus`; por compartilhamento: `saúdeÁrvore` |

### Dataset de referência

Usado consistentemente em todas as telas e fluxos abaixo — quem implementar deve usar exatamente estes valores como fixtures padrão, para que os screenshots/estados batam com esta spec.

**Identidade atual (usuário testando o app):** Ana Torres (`@ana`), avatar com iniciais "AT" sobre fundo violeta, presença "online".

**Comunidades da Ana (aparecem no rail, nesta ordem):**

1. **Vale do Código** — ícone "VC" sobre fundo azul-petróleo, 340 membros, host = Rafael Mendes (Ana é membro comum, cargo "Contribuidor"). `connectionHealth.hostStatus = online`.
2. **Clã Noturno** — ícone 🎮, 58 membros, **host = Ana** (a própria usuária — usada para especificar as telas de administração/host). `connectionHealth.hostStatus = online`.
3. **Ateliê Aberto** — ícone 🎨, 12 membros, host = Bianca Souza. `connectionHealth.hostStatus = offline` (usada para especificar o estado "host offline / modo cache").

**Estrutura de "Vale do Código" (comunidade principal de referência para as telas de conteúdo):**

- Categoria **INÍCIO**: `#avisos` (texto, somente-leitura para não-moderadores, 1 não lida), `#apresentações` (texto)
- Categoria **TEXTO**: `#geral` (texto, 12 não lidas, 1 menção pendente), `#ajuda-frontend` (texto), `#ajuda-backend` (texto, silenciado por Ana)
- Categoria **VOZ**: 🔊 `Sala de Estudos` (voz, 3 participantes conectados agora: Rafael, Diego, Bianca), 🔊 `Papo Aberto` (voz, vazia)

**Cargos em Vale do Código** (do topo pro fundo da hierarquia):

| Cargo | Cor | Permissões-chave |
|---|---|---|
| Fundador | dourado (`role-gold`) | todas |
| Moderador | azul-petróleo (`role-blue`) | kick, ban, timeout, deletar mensagem, gerenciar canais |
| Contribuidor | verde (`role-green`) | fixar mensagem, mencionar @everyone |
| Membro (padrão, todo mundo tem) | cinza-neutro (`role-neutral`) | enviar mensagem, falar em voz |

**Membros visíveis na lista (amostra):** Rafael Mendes (Fundador, host, online), Bianca Souza (Moderador, online, ativa em Ateliê Aberto como host), Diego Alves (Contribuidor, online, em `Sala de Estudos`), Ana Torres (Contribuidor, online, usuária atual), Fernanda Lima (Membro, ausente) + agregador "307 offline".

**Mensagens de exemplo em `#geral`** (para popular a spec da tela de canal de texto):
```
Rafael Mendes — hoje 09:14
Bom dia! Subi a build nova do onboarding, testem quando puderem 🚀

Diego Alves — hoje 09:16
testando agora

Diego Alves — hoje 09:20 (editado)
👍 rodou liso aqui, só achei o texto do botão de convite meio pequeno

Bianca Souza — hoje 09:41
@Ana Torres bora revisar a fila de moderação depois do almoço?
  [fixado]

Ana Torres — hoje 09:43
  ↳ respondendo a Bianca Souza
  bora, te chamo na Sala de Estudos
```

**Arquivo de exemplo (para spec de compartilhamento estilo torrent):** `aula-webrtc-completa.mp4`, 1.24 GB, enviado por Rafael, 3 peers disponíveis + host, progresso de download 62% no momento em que Ana abre a tela.

**Convite de exemplo:** link `p2p.app/invite/x7K2qM` / código curto `X7K2QM`, criado por Rafael, sem expiração, sem limite de usos.

## 3. Arquitetura de informação

Telas e painéis são organizados em 4 camadas. A camada muda como cada item é especificado — "tela" (rota ou vista de tela cheia, navegação exclusiva) vs. "painel/modo" (vive dentro de outra tela, não substitui o que está por trás).

### Camada 0 — Entrada e identidade (pré-shell, sequencial, bloqueante)

Nada funciona sem isso: em P2P "conta" é um par de chaves local, não existe estado "deslogado navegando".

- **0.1 Onboarding / criar identidade local** — tela cheia, primeira coisa que qualquer instalação nova mostra.
- **0.2 Hub vazio** — não é uma tela nova; é o *shell* (Camada 1) com o rail contendo só o botão "+" e conteúdo central sendo um CTA duplo (entrar via convite / criar comunidade). Existe sempre que `comunidades.length === 0`.
- **0.3 Entrar via convite + preview** — modal/tela sobreposta, acionável tanto do hub vazio quanto (via CTA persistente) de dentro do shell já povoado.
- **0.4 Criar comunidade / virar host** — modal/tela sobreposta, acionável do hub vazio **e** de um botão "+" persistente no rail (não é um evento único do primeiro uso).

### Camada 1 — Estrutura (chrome que hospeda tudo abaixo; não é destino isolado de navegação)

- **1.1 Shell principal** — rail de comunidades | lista de canais | área de conteúdo | painel de membros colapsável, mais uma **barra de chamada de voz persistente** quando Ana está conectada a um canal de voz (fica visível mesmo navegando outros canais de texto).
- **1.2 Painel de busca** — overlay estilo command palette (Cmd/Ctrl+K), com dois escopos: inline-no-canal (busca rápida no canal atual) e global-com-filtros (todos os canais da comunidade, por autor/data/tipo). Um motor, dois pontos de entrada — não duas telas.
- **1.3 Painel de membros** — coluna direita colapsável do shell.
- **1.4 Popover de perfil de membro** — acionado a partir da lista de membros, do nome/avatar do autor de uma mensagem, de um participante de voz (tile da grade), de uma linha de participante na lista de canais (1.1) ou do bloco de identidade da barra de usuário (1.1, para o próprio perfil). Mesmo componente, vários gatilhos.

### Camada 2 — Conteúdo (onde o tempo de uso se concentra)

- **2.1 Canal de texto** — mensagens + composer + anexos inline + reações + menções + fixados + edição/exclusão.
- **2.2 Painel de thread** — sub-painel deslizante (lado direito, sobrepõe o painel de membros quando aberto) acionado a partir de "responder em thread" numa mensagem. Não é rota própria.
- **2.3 Canal de voz** — grade de participantes, fala ativa, mute/deafen, entrar/sair.
- **2.4 Compartilhamento de tela/vídeo** — **sub-modo do canal de voz** (ativado de dentro da chamada, não é tela irmã): viewer com tile grande do compartilhamento ativo, indicador de topologia (estrela/árvore), contagem de espectadores, fallback TURN visível.

### Camada 3 — Administração (baixa frequência, alta necessidade quando acessada)

- **3.1 Configurações** — identidade, dispositivos de voz/vídeo, aparência, rede (diagnóstico NAT/CGNAT), notificações.
- **3.2 Gestão de cargos e permissões** — dentro de "Configurações da comunidade" (só visível para quem tem permissão).
- **3.3 Ferramentas de moderação** — log de auditoria, lista de banidos/timeout, dentro de "Configurações da comunidade".
- **3.4 Gestão de canais e categorias** — criar/editar/mover/excluir canal e categoria, para quem tem `gerenciar canais`. Única entre as telas da Camada 3 que **não** é tab de "Configurações da comunidade": os gatilhos vivem na própria lista de canais (1.1) e o detalhe abre em modal.
- **3.5 Aviso de saída do host** — confirmação ao fechar o app hospedando gente conectada. Não tem gatilho de interface: quem dispara é o sistema operacional/navegador.

### Estados transversais de conexão P2P (não são telas — sobrepõem qualquer camada acima)

- Host offline → modo cache local somente-leitura (réplica Hypercore existente, sem novas mensagens).
- Host prestes a fechar o app com pessoas conectadas → aviso ativo ("N pessoas online, fechar desconecta todo mundo").
- Buscando peers via DHT (conectando).
- Reparo de árvore de multicast em andamento (nó do meio caiu).
- Falha total de NAT/CGNAT (nem direto nem TURN resolve) — distinto de "degradado via TURN".
- Prompt de consentimento para repassar upload de espectador (multicast tree).
- Preview de convite para comunidade da qual Ana foi banida.

### Mapa de telas (visão em árvore)

```
Onboarding (0.1)
  └─ Shell (1.1)
      ├─ Hub vazio (0.2)                         [quando 0 comunidades]
      │   ├─ Entrar via convite + preview (0.3)
      │   └─ Criar comunidade (0.4)
      ├─ [Rail] "+" persistente
      │   ├─ Entrar via convite + preview (0.3)
      │   └─ Criar comunidade (0.4)
      ├─ [Comunidade ativa]
      │   ├─ [Lista de canais] "+" / menu de contexto      [só com `gerenciar canais`]
      │   │   └─ Criar / editar / excluir canal e categoria (3.4)
      │   ├─ Categoria → Canal de texto (2.1)
      │   │   ├─ Painel de thread (2.2)
      │   │   ├─ Painel do canal: fixados/arquivos/links (2.1.2)
      │   │   └─ Anexo/arquivo inline (card, não é tela)
      │   ├─ Categoria → Canal de voz (2.3)
      │   │   ├─ Câmera (2.3.2)
      │   │   └─ Compartilhamento de tela/vídeo (2.4)
      │   ├─ Painel de busca (1.2)                [Cmd/Ctrl+K, de qualquer canal]
      │   ├─ Painel de membros (1.3)
      │   │   └─ Popover de perfil (1.4)
      │   └─ Configurações da comunidade
      │       ├─ Geral
      │       ├─ Cargos e permissões (3.2)
      │       └─ Moderação / auditoria (3.3)
      ├─ Configurações de conta (3.1)              [identidade/presença/dispositivos/aparência/rede]
      │   — acessível independente de comunidade ativa
      └─ Aviso de saída do host (3.5)              [ao fechar o app hospedando gente conectada]
```

## 4. Navegação

**Três rotas reais, resto é estado.** O app usa `react-router` com apenas três rotas endereçáveis:

| Rota | Resolve para |
|---|---|
| `/` | Sem identidade → Onboarding (0.1). Com identidade e 0 comunidades → Hub vazio (0.2). Com comunidade ativa salva → Shell (1.1) nela. |
| `/invite/:code` | Preview de convite (0.3). Precisa existir como URL de verdade porque é o alvo de um link compartilhado *fora* do app — inclusive por quem nunca abriu o app antes (a rota guarda o convite pendente, manda pro onboarding se não houver identidade, e retoma o preview depois de criada). |
| `/m/:code` | Mensagem específica (§9, 2.1 — "Copiar link da mensagem"). O `code` identifica comunidade + canal + mensagem num token só, para não vazar ids legíveis pra quem não é membro. Resolve abrindo o shell no canal certo com a mensagem destacada (mesmo highlight de 1.2). **Estados de falha, todos sem vazar conteúdo:** quem não é membro daquela comunidade vê "Este link é de uma comunidade da qual você não faz parte" com CTA "Colar um convite" (0.3); quem é membro mas ainda não sincronizou aquele trecho do histórico vê "Esta mensagem ainda não chegou neste dispositivo" (premissa 6) e cai no canal certo, no fim do que já tem; mensagem deletada vê "Esta mensagem não existe mais". |

Tudo mais — comunidade/canal selecionado, painéis abertos (membros/busca/thread/configurações), modais, estado de voz/tela compartilhada — **fica fora do router, em Zustand**. Motivo: nenhuma dessas coisas é um recurso endereçável por servidor (não há API por trás de uma rota `/comunidade/:id/canal/:id` pra "carregar") — é estado de sessão efêmero, e duplicar entre router e store é receita pra bug de sincronização. Persistência de "última comunidade/canal aberto" entre sessões usa o middleware `persist` do próprio Zustand (localStorage), sem dependência nova.

**Por que `react-router` e não uma alternativa mais magra:** Hyperswarm/Hypercore/Hyperdht não rodam em sandbox de browser puro (precisam de socket raw pra DHT/hole-punching) — é bem provável que a versão com backend real deste app não seja "só um site", e sim empacotada em Electron/Tauri/Bare (ver premissa 1, §0). `react-router` tem `MemoryRouter` pronto para exatamente esse caso ("app empacotado sem URL de verdade"), então esta mesma tabela de 3 rotas sobrevive à migração sem reescrita — só as duas rotas compartilháveis (convite e mensagem) ganhariam depois um protocolo customizado (`comunidadep2p://invite/...`, `comunidadep2p://m/...`) alimentando o `MemoryRouter` na entrada. Isso não é trabalho desta spec, só a razão da escolha.

**Entrada manual de convite:** além do link direto, a tela 0.3 tem um campo "colar código ou link" (como o "Join a Server" do Discord) — necessário para demo/dev já que não existe mecanismo real de compartilhamento externo no mock.

**Navegação dentro do shell (Camada 1-2):**

- Clique num ícone do rail → troca comunidade ativa (Zustand), mantém o painel/canal do tipo mais recente aberto nela (ou o primeiro canal de texto da primeira categoria, se for a primeira visita).
- Clique num canal na sidebar → troca canal ativo dentro da comunidade.
- Entrar em canal de voz **não troca a área de conteúdo principal** se Ana estava vendo um canal de texto — abre o painel da chamada (§9, 2.3.1) e, opcionalmente, o usuário pode clicar no nome do canal ali para expandir a grade de participantes/tela compartilhada como overlay. Sair do canal de voz fecha o painel.
- `Cmd/Ctrl+K` de qualquer lugar dentro do shell → abre painel de busca (1.2) como overlay.
- Clique em avatar/nome → popover de perfil (1.4), não navega para outra tela.
- Breadcrumb implícito no cabeçalho do canal (ícone da comunidade + nome do canal) — clicável para reabrir painel de membros.

## 5. Design system

Dark-only (v1). Tokens nomeados por **papel semântico**, nunca a escala crua do Tailwind (`neutral-800` etc.) direto nos componentes — assim trocar um valor não exige tocar em componente nenhum.

### 5.1 Superfícies e elevação

4 níveis, do fundo pra frente. Diferenciação por luminância + borda 1px, não por sombra (sombra preta tem pouco contraste sobre fundo já escuro).

| Token | Valor | Uso |
|---|---|---|
| `surface-app` | `#0E0F14` | Fundo do rail de comunidades, fundo geral por trás de tudo |
| `surface-sidebar` | `#15171E` | Lista de canais, painel de membros, painéis de configuração |
| `surface-primary` | `#1A1C24` | Área de conteúdo do canal (onde o usuário lê/escreve) |
| `surface-elevated` | `#22242E` | Popover, modal, dropdown, menu de contexto, painel de thread, toast |
| `surface-overlay-scrim` | `rgba(8,9,13,0.72)` | Fundo escurecido atrás de modal |
| `border-subtle` | `rgba(255,255,255,0.06)` | Divisórias discretas (entre mensagens de mesmo autor) |
| `border-default` | `rgba(255,255,255,0.10)` | Bordas de card, input, divisórias de seção |
| `border-strong` | `rgba(255,255,255,0.16)` | Foco, borda de elemento ativo/selecionado |

Modal/popover recebem sombra adicional só para se separar do scrim: `0 8px 24px rgba(0,0,0,0.4)`.

### 5.2 Texto

| Token | Valor | Uso |
|---|---|---|
| `text-primary` | `#F2F3F5` | Corpo de mensagem, títulos |
| `text-secondary` | `#A7ACB8` | Metadados, labels, texto de apoio |
| `text-tertiary` | `#6B7180` | Timestamps, placeholders, texto desabilitado-adjacente |
| `text-disabled` | `#4B505C` | Texto/ícone de controle desabilitado |
| `text-on-accent` | `#FFFFFF` | Texto sobre botão/superfície de cor `accent` |

### 5.3 Cor de destaque (accent — violeta/índigo)

| Token | Valor | Uso |
|---|---|---|
| `accent-default` | `#7B6EF6` | Botão primário, link, item ativo na sidebar, borda de foco |
| `accent-hover` | `#8F84F8` | Hover sobre elemento `accent` (clareia — convenção dark UI) |
| `accent-active` | `#6659E0` | Pressed/active |
| `accent-muted-bg` | `rgba(123,110,246,0.16)` | Fundo do canal ativo/selecionado na sidebar, fundo de menção `@ana` |

### 5.4 Paletas semânticas (4 sistemas paralelos, não intercambiáveis)

Mesmo vocabulário cromático (verde=bom, âmbar=atenção, vermelho=ruim, azul=neutro/informativo), mas cada sistema tem token próprio — um cargo nunca deve "parecer" um status de sistema por acidente.

**Presença** (dot estático, 8px, borda 2px na cor da superfície por trás para "recortar" do avatar):

| Token | Valor | Estado |
|---|---|---|
| `presence-online` | `#3BD16F` | Online |
| `presence-idle` | `#F5B942` | Ausente |
| `presence-dnd` | `#ED5B5B` | Ocupado / não perturbe |
| `presence-offline` | `#5B6270` | Offline (dot vazado, sem preenchimento) |

**Indicador de fala ativa** — nunca só cor: anel animado (glow pulsante, 2px, `presence-online` mesmo tom) ao redor do avatar, + barras de waveform sutis no canto. Precisa ser diferenciável de "presença online" mesmo quando os dois aparecem juntos no mesmo avatar (um participante de voz que também está online) — a diferença é forma (anel + movimento) e não matiz, por acessibilidade (daltonismo).

**Cor de cargo** — conjunto curado fechado de 7, não color-picker livre. Pré-validadas para contraste como texto (nome de usuário colorido no chat):

`role-gold #E8B84B` · `role-blue #4FA3D1` · `role-green #4CC38A` · `role-red #E5636B` · `role-purple #A98CF0` · `role-pink #E572B0` · `role-neutral #9AA0AC` (cor do cargo padrão, todo membro tem).

**Saúde de conexão P2P** — o sistema mais novo do produto (Discord não precisa disso porque o servidor deles "sempre está de pé"). Estado "reconectando" nunca depende só de cor — leva animação (pulse/spinner), porque semanticamente é muito diferente de "offline" (estado parado/final) mesmo caindo na mesma família de cor neutra/âmbar:

| Token | Valor | Motion | Estado |
|---|---|---|---|
| `conn-ok` | `#3BD16F` | — | Host/peer conectado normalmente |
| `conn-degraded` | `#F5B942` | — | Funcionando via fallback TURN (não é erro, é modo alternativo) |
| `conn-reconnecting` | `#F5B942` | pulse contínuo ~1.2s | Buscando peer/reparando árvore, ativo e transitório |
| `conn-offline` | `#5B6270` | — | Host offline, modo cache (não é erro, é estado estável) |
| `conn-failed` | `#ED5B5B` | — | Falha total de NAT/CGNAT, nem direto nem TURN resolve |

**Feedback de sistema** (toast, validação de formulário) — nomeado separado dos anteriores mesmo resolvendo pra cor parecida:

`feedback-success #3BD16F` · `feedback-warning #F5B942` · `feedback-danger #ED5B5B` · `feedback-info #4FA3D1`.

### 5.5 Tipografia

Família: `Inter` (fallback `system-ui, -apple-system, "Segoe UI", sans-serif`) — amplamente hintada, gratuita, usada em produtos comparáveis (Discord, Linear), boa legibilidade em corpo pequeno. Monoespaçada só para blocos de código no composer/mensagem: `"JetBrains Mono", "SFMono-Regular", Consolas, monospace`.

3 pesos: Regular (400), Semibold (600, ênfase — nomes de autor, item ativo), Bold (700, headings).

7 degraus:

| Token | Tamanho / altura de linha | Peso | Uso |
|---|---|---|---|
| `text-caption` | 11px / 16px | 500 | Labels de seção em maiúsculas (letter-spacing 0.04em) — "TEXTO", "VOZ" |
| `text-meta` | 12px / 16px | 400 | Timestamps, contagem de membros, hints de formulário |
| `text-body` | 14px / 20px | 400 | Corpo de mensagem — degrau dominante, é onde a maior parte do tempo de leitura acontece |
| `text-body-emphasis` | 14px / 20px | 600 | Nome de autor, item ativo, label de botão |
| `text-heading-3` | 15px / 20px | 700 | Nome de canal no cabeçalho, títulos de seção em painel |
| `text-heading-2` | 18px / 24px | 700 | Título de modal |
| `text-heading-1` | 22px / 28px | 700 | Título de tela cheia (onboarding, hub vazio) |

### 5.6 Espaçamento e grid

Escala nativa do Tailwind 4 (múltiplos de 4px). Múltiplos "oficiais" do produto, para manter ritmo vertical consistente:

`4px` (gap ícone-label) · `8px` (padding de botão pequeno, gap avatar-nome) · `12px` (padding de item de lista) · `16px` (padding padrão de painel/card, gap entre grupos de mensagens de autores diferentes) · `24px` (padding de modal, gap entre seções de configurações) · `32px` (padding de tela cheia) · `48px`/`64px` (empty states centralizados).

Grid do shell (larguras fixas, não fluidas, em desktop):

| Coluna | Largura |
|---|---|
| Rail de comunidades | 72px fixo |
| Lista de canais | 240px fixo (colapsável) |
| Conteúdo | flexível, mínimo 480px |
| Painel de membros / thread | 280px fixo (colapsável, um de cada vez) |

### 5.7 Iconografia

Linha (outline, peso de traço consistente), não preenchida — combina com a densidade de informação da UI. Tamanhos: 16px (dentro de input/badge pequeno), 20px (padrão — itens de lista, botões secundários), 24px (ações primárias da barra de chamada: mudo, ensurdecer, sair, compartilhar tela). Biblioteca sugerida (não trava a implementação): Lucide — open-source, combina com Tailwind.

### 5.8 Raio de borda

`radius-sm` 4px (inputs pequenos, badges) · `radius-md` 8px (botões, cards, item de lista ativo) · `radius-lg` 12px (modais, painéis flutuantes, ícone de comunidade — quadrado arredondado) · `radius-full` (avatar de usuário, dots de presença, pills).

### 5.9 Motion

| Token | Duração | Uso |
|---|---|---|
| `duration-fast` | 100ms | Hover, toggle, feedback de clique |
| `duration-base` | 180ms | Abrir/fechar painel lateral, modal, dropdown |
| `duration-slow` | 320ms | Transição de tela cheia (passos do onboarding) |

Easing: `ease-out` em entradas, `ease-in` em saídas. Pulse de "reconectando" / "fala ativa": loop contínuo ~1.2s, opacidade 0.5↔1.

**`prefers-reduced-motion` é respeitado globalmente.** Todo motion desta spec é decorativo — nenhuma informação existe *só* na animação —, então com movimento reduzido as transições viram corte seco (`duration` 0) e os loops contínuos param num estado estável. Duas exceções que **não** podem simplesmente parar, porque §5.4 as define como "forma + movimento, nunca só cor": o pulse de `conn-reconnecting` vira um ícone de spinner estático acompanhado do rótulo textual ("Reconectando…"), e o anel de fala ativa vira anel sólido de espessura constante — a distinção contra o dot de presença passa a ser só a forma (anel em volta do avatar vs. dot no canto), que já basta.

### 5.10 Data, hora e números

Um app P2P não tem servidor pra normalizar isto — cada réplica carimba a mensagem com o relógio de quem escreveu, e quem lê está em outro fuso. Regras fechadas, para toda a spec:

| Contexto | Formato |
|---|---|
| Carimbo de mensagem (hoje) | `hoje 09:14` — 24h, sempre. O prefixo é o que a transcrição de §2 mostra, e é o que manda |
| Carimbo de mensagem (ontem) | `ontem 09:14` |
| Carimbo de mensagem (mesmo ano) | `12 mar 09:14` |
| Carimbo de mensagem (ano anterior) | `12 mar 2025 09:14` |
| Separador de dia na lista | `HOJE` · `ONTEM` · `QUINTA, 12 DE MARÇO` (`text-caption`, maiúsculas via CSS — a função devolve capitalização normal) |
| Tempo relativo (log de auditoria, "entrou em") | `há 2 dias`, `há 3 semanas` — nunca relativo além de ~1 ano, aí vira data absoluta |
| Contagem regressiva (timeout ativo) | `12min 30s` restantes, atualizando a cada segundo |
| Tamanho de arquivo | `1,24 GB` — vírgula decimal, base 1000, uma casa decimal |
| Contagem grande | `340 membros`; badge numérico trunca em `99+` (§6) |

**Fuso e locale:** tudo é renderizado no fuso e no locale **de quem lê** (`pt-BR` no v1, sem seletor de idioma — traduzir não está no escopo). O timestamp que viaja entre peers é absoluto (UTC), nunca texto já formatado — do contrário uma mensagem enviada às 23h em São Paulo apareceria "hoje" para um peer em Lisboa onde já é o dia seguinte. **Relógio de peer adiantado:** mensagem que chega com carimbo no futuro é exibida com o horário local de chegada e um tooltip discreto "O relógio de quem enviou está adiantado" — nunca uma mensagem "de amanhã" no topo da lista, e nunca reordenação silenciosa.

## 6. Biblioteca de componentes

Cada componente tem estados explícitos — nenhum é "estático" por padrão. Lista não-exaustiva de variações; a lógica de estado (qual state machine cada um usa) é detalhada nas specs de tela onde aparecem.

| Componente | Variações / estados obrigatórios |
|---|---|
| **Avatar** | Tamanhos P (24px) / M (32px) / G (80px, perfil). Camadas opcionais combináveis: dot de presença, anel de fala ativa (animado), badge de cargo. Fallback: iniciais sobre cor gerada a partir do ID do usuário. |
| **Botão** | Variantes: primário (`accent`), secundário (superfície elevada + borda), ghost (sem fundo), destrutivo (`feedback-danger`), ícone-only. Estados: default, hover, active, focus (anel `border-strong`), disabled, loading (spinner substitui label). Altura é fixa por degrau (32/36/44px), então o rótulo **nunca quebra linha**: a segunda linha não caberia e transbordava por cima do padding, com o botão aparecendo sem respiro. Rótulo que não cabe é rótulo longo demais, ou fileira apertada demais. |
| **Input de texto / Textarea** | Estados: default, focus, erro (borda `feedback-danger` + mensagem abaixo), disabled. Textarea do composer cresce até um máximo (~40% da altura da viewport) antes de rolar. |
| **Select, Toggle, Slider, Checkbox, Radio** | Padrão de formulário; slider usado para volume de entrada/saída em Configurações. |
| **Segmented control** | Grupo de rádio apresentado como botões colados, 2-3 opções curtas e mutuamente exclusivas visíveis de uma vez (nunca escondidas atrás de um select). Único uso desta spec: escolher Texto/Voz ao criar canal (§10, 3.4). Estados: opção ativa (`accent-muted-bg` + `text-primary`), inativa (`text-secondary`), foco (anel `border-strong`), grupo inteiro desabilitado. Navegação por setas ←/→, como todo grupo de rádio. |
| **Badge / Pill** | Contagem de não-lidas (numérica, trunca em "99+"), pill de cargo colorido, pill "AO VIVO" (canal de voz com gente dentro), pill "NOVO". |
| **Tooltip** | Aparece após 500ms de hover, texto curto, nunca a única fonte de uma informação crítica. |
| **Menu de contexto** | Acionado por botão direito ou botão "⋯" — em mensagem, membro, canal, comunidade. Itens variam por permissão (ver §10, Gestão de cargos e permissões / Moderação). |
| **Dropdown menu** | Seleção de opção única (ex.: dispositivo de microfone em Configurações). |
| **Modal / Dialog** | Confirmação (ação destrutiva sempre passa por aqui) e formulário (criar comunidade, criar convite, criar cargo). Fecha com `Esc`, clique no scrim, ou botão explícito — nunca só clique-fora silencioso em formulários com dado não salvo (pede confirmação de descarte). |
| **Painel deslizante** | Membros, busca, thread, configurações — desliza da direita, `duration-base`, um de cada vez (abrir um fecha outro que estava aberto no mesmo slot). |
| **Toast** | Canto inferior direito, empilha até 3, some sozinho em 4s (exceto erro, que fica até dispensado manualmente). |
| **Tabs** | Usado em Configurações (Geral / Cargos / Moderação), no painel do canal (Fixados / Arquivos / Links — §9, 2.1.2) e nas sub-abas de moderação (3.3). |
| **Barra de progresso** | Upload/download de arquivo (determinística, %), saúde de árvore de multicast (indeterminística quando "reparando"). |
| **Dot de status** | Ver §5.4 — presença e saúde de conexão reaproveitam o mesmo componente base, cores diferentes, nunca no mesmo lugar da UI (não colidem visualmente). |
| **Skeleton loader** | Formato do conteúdo real (linhas de mensagem, círculos de avatar) — nunca spinner genérico de tela cheia depois do primeiro carregamento. |
| **Item de lista de canal** | Estados: default, hover, ativo (fundo `accent-muted-bg`), não-lido (texto mais claro + dot), com menção pendente (badge numérico `feedback-danger`), silenciado (ícone mudo, sem destaque de não-lido), canal de voz com gente dentro (uma linha por participante abaixo do nome: avatar + nome de exibição). |
| **Item de lista de membro** | Agrupado por cargo (maior hierarquia primeiro), com dot de presença; offline agrupados e colapsados por padrão. |
| **Barra de usuário** | Rodapé fixo da coluna da esquerda, atravessando rail e lista de canais (56px). Avatar + dot de presença, nome de exibição e presença por extenso à esquerda; à direita, mudo, ensurdecer e engrenagem (3.1). O bloco de identidade é clicável — abre o popover do próprio perfil (1.4) — e tem estado de hover próprio, distinto dos três ícones. Detalhada em §8, 1.1. |
| **Linha/bolha de mensagem** | Agrupa mensagens consecutivas do mesmo autor (sem repetir avatar/nome se <5min de intervalo). Hover revela barra de ações flutuante (reagir, responder, responder em thread, mais opções). Estados: enviando (opacidade reduzida), falha no envio (ícone de alerta + "tentar novamente"), pendente offline (ícone de relógio, ver fluxo B4), editada (label "(editado)"), destacada (ao chegar via link/busca, highlight breve). |
| **Tile de participante de voz/vídeo** | Avatar + anel de fala + ícones de estado (mudo/ensurdecido/câmera) sobrepostos no canto. |
| **Command palette (busca)** | Abre com `Cmd/Ctrl+K`, lista resultados agrupados por tipo (mensagens, canais, membros) conforme digita. |
| **Banner de status** | Full-width, topo da área de conteúdo, cores de `conn-*` — host offline, reconectando, etc. **O fundo é a cor do tom lavada a 15% sobre o que estiver atrás**, nunca uma superfície fixa mais escura que a área de conteúdo: uma faixa escura entre o header e a lista lê como buraco, como se o header tivesse sido cortado, e a severidade fica dependendo só do ponto de 8px. Não-modal, não bloqueia interação com o que já carregou. |
| **Painel da chamada** | No Desktop/Tablet, acima da barra de usuário, com o canal atual, sair, câmera e tela; no Mobile, barra fixa no rodapé da viewport com avatares dos participantes, mudo e sair. Vive enquanto a chamada existe, mesmo navegando outros canais e outras comunidades. Layout e conjunto de controles variam por breakpoint — detalhado em §9, 2.3.1. |
| **Card de anexo/arquivo** | Nome, tamanho, ícone por tipo, barra de progresso quando baixando, contagem de peers/seeders, estado "indisponível" (zero peers e host offline). |
| **Divisor de mensagens** | Linha "Novas mensagens" (ao reabrir canal com não-lidas) e separador de data (ao mudar o dia). |
| **Composer** | Textarea + toolbar (anexar, emoji, formatação) + botão enviar. Estado: vazio (placeholder "Conversar em #geral"), com texto, enviando anexo (barra de progresso inline), bloqueado (canal somente-leitura para o cargo atual — ver `#avisos`), fila offline (ver premissa 5). |

Breakpoints referenciados nas specs de tela abaixo (detalhados na íntegra em §16): **Desktop** ≥1280px · **Tablet** 640–1279px · **Mobile** <640px.

## 7. Especificação por tela — Camada 0 (entrada e identidade)

### 0.1 Onboarding / criar identidade local

**Objetivo:** gerar a identidade local (par de chaves, não exibido) e capturar nome de exibição + avatar antes de liberar qualquer outra tela.
**Layout:** tela cheia, conteúdo centralizado (max-width 420px), fundo `surface-app`, sem chrome de navegação — nada existe antes disso.
**Estrutura:** nome do produto no topo; título `heading-1` "Crie sua identidade"; subtítulo explicando que não há conta central — a identidade fica só neste dispositivo; campo "Nome de exibição" (obrigatório, 2-32 caracteres); seletor de avatar (cor gerada a partir de hash aleatório + iniciais do nome, botão "Gerar outra cor" — sem upload de imagem no v1, mock não tem storage); botão primário "Criar identidade" (disabled até nome válido).
**Ações:** digitar nome, regenerar cor do avatar, confirmar.
**Interações:** validação em tempo real (contador de caracteres); botão primário mostra loading (~600ms simulado) ao confirmar.
**Estados:** vazio (disabled) · preenchendo (válido) · erro (nome inválido — borda `feedback-danger` + texto abaixo do campo) · confirmando (loading) · sucesso (transição `duration-slow`).
**Feedback visual:** contador "12/32" muda de `text-tertiary` pra `feedback-warning` acima de 28 caracteres.
**Navegação:** tela inicial absoluta (rota `/` sem identidade); sem "voltar"; ao concluir vai para o Hub vazio (0.2) ou, se havia convite pendente (chegada via `/invite/:code` sem identidade), retoma o preview do convite (0.3) automaticamente.
**Responsividade:** mesmo layout centralizado nos 3 breakpoints; só o card se adapta (420px → 100% menos 32px de margem em Mobile).

### 0.2 Hub vazio

**Objetivo:** primeiro estado do shell quando `comunidades.length === 0` — orientar a única decisão possível (entrar ou criar).
**Layout:** shell já existe (rail à esquerda só com botão "+"), conteúdo central com empty state centralizado verticalmente.
**Componentes:** ícone de rede/nós conectados (ilustração simples, não asset realista — mock não tem pipeline de imagem), título `heading-1` "Nenhuma comunidade ainda", texto de apoio, dois botões: primário "Criar uma comunidade" (abre 0.4) e secundário "Entrar com convite" (abre 0.3).
**Conteúdo mockado:** "Comunidades no Comunidade P2P não têm servidor central — você entra com um convite de alguém, ou cria a sua e vira o host."
**Estados:** único (sem loading — resolvido por contagem local, sem chamada de rede).
**Navegação:** existe sempre que 0 comunidades; some assim que a primeira é criada/entrada (substituído por 1.1).
**Responsividade:** idêntico nos 3 breakpoints.

### 0.3 Entrar via convite + preview

**Objetivo:** entrar numa comunidade a partir de link/código, sempre mostrando preview antes de confirmar — nunca entra "às cegas".
**Layout:** modal centralizado (~440px) sobre scrim; ou tela cheia quando chega via `/invite/:code` direto sem shell por trás (primeira comunidade).
**Estrutura em 2 passos:** Passo 1 (só se aberto pelo "+", não por link direto) — campo "Cole um link ou código de convite" + botão "Continuar". Passo 2 (preview, sempre visto antes de confirmar) — ícone e nome da comunidade, contagem de membros, nome de quem criou o convite, botão primário "Entrar em [nome]", botão secundário "Cancelar".
**Conteúdo mockado (preview bem-sucedido):** ícone "VC", "Vale do Código", "340 membros", "Convite de Rafael Mendes".
**Ações:** colar código, confirmar, cancelar.
**Interações:** validação ao colar/digitar (debounce ~400ms, skeleton no card de preview enquanto resolve).
**Estados:**
- Resolvendo (skeleton no lugar de ícone/nome/contagem).
- Sucesso (preview completo, botão habilitado).
- Código inválido/expirado (`feedback-danger`, "Este convite não é válido ou expirou").
- Convite revogado (mesmo tratamento textual do inválido — não diferenciar tecnicamente pro usuário).
- **Banido desta comunidade**: preview distinto — ícone acinzentado, "Você não pode entrar em Vale do Código" sem contagem de membros nem nome de quem convidou (não vaza informação da comunidade pra quem foi banido), botão único "Cancelar".
- Já é membro: "Você já está em Vale do Código", botão único "Ir para a comunidade".
- Entrando (loading no botão primário, ~800ms simulado).
**Feedback visual:** transição passo 1 → 2 é `duration-base` (slide/fade), não reload abrupto.
**Navegação:** acionável do Hub vazio, do "+" do rail, ou direto via `/invite/:code`. Ao confirmar, fecha/navega e abre 1.1 já na comunidade nova, no primeiro canal de texto da primeira categoria.
**Responsividade:** Mobile → modal vira tela cheia (sem scrim, sem cantos arredondados).

### 0.4 Criar comunidade / virar host

**Objetivo:** capturar os dados mínimos pra criar uma comunidade, deixando explícito que ela depende da máquina de Ana continuar rodando — a decisão de produto mais importante desta tela.
**Layout:** modal centralizado (~480px).
**Estrutura:** título `heading-2` "Criar comunidade"; campo "Nome da comunidade" (obrigatório, 2-40 caracteres); seletor de ícone (mesma lógica cor+iniciais do avatar de identidade); campo opcional "Descrição" (até 120 caracteres); **aviso permanente e não-dispensável** (não é toast que some) abaixo do formulário: "Esta comunidade fica hospedada neste dispositivo. Se ele ficar offline, outras pessoas não conseguem enviar novas mensagens até você voltar." com ícone `conn-degraded`; botão primário "Criar e virar host".
**Ações:** preencher nome/ícone/descrição, confirmar.
**Interações:** validação inline igual à 0.1 (contador de caracteres; "duplicado" aqui significa mesmo nome de outra comunidade que Ana já participa, só pra evitar confusão visual no rail — não é unicidade global, que não existe em P2P).
**Estados:** preenchendo · erro de validação · criando (loading ~600ms) · sucesso.
**Feedback visual:** toast de sucesso ao concluir — "Vale do Código criada — você é o host" (exemplo com o nome digitado).
**Navegação:** acionável do Hub vazio ou do "+" persistente no rail. Ao concluir, navega pra 1.1 já na comunidade nova, pré-populada com categoria "GERAL" e canal `#geral` (nunca uma comunidade sem nenhum canal).
**Responsividade:** modal → tela cheia em Mobile, mesma regra da 0.3.

## 8. Especificação por tela — Camada 1 (estrutura)

### 1.1 Shell principal

**Objetivo:** chrome persistente que hospeda toda a navegação pós-identidade.
**Layout (Desktop, esquerda→direita):** rail de comunidades (72px) · lista de canais (240px) · área de conteúdo (flexível) · painel de membros/thread (280px, um de cada vez, fechado por padrão). Painel da chamada logo acima da barra de usuário quando há voz ativa, ambos no rodapé da coluna da esquerda.
**Componentes:** praticamente toda a biblioteca (§6) aparece aqui em algum estado.
**Hierarquia visual:** rail em `surface-app` (mais escuro) → lista de canais `surface-sidebar` → conteúdo `surface-primary` (mais claro) → painéis flutuantes `surface-elevated`. Comunidade ativa no rail tem barra vertical `accent-default` de 4px à esquerda do ícone; ícone muda de circular pra `radius-lg` quando ativo/hover (convenção do gênero: só o ativo "quadra").
**Conteúdo do rail (topo→base):** ícones das comunidades de Ana na ordem do dataset (§2) — Vale do Código, Clã Noturno, Ateliê Aberto —, separador, botão "+" (criar/entrar) e espaço flexível. O avatar de Ana ficava aqui no rodapé e era a porta de 3.1; quem faz os dois papéis agora é a **barra de usuário** (abaixo), que atravessa o rodapé desta coluna e da lista de canais — o avatar sozinho não dizia nome nem presença, e duas portas para a mesma tela na mesma coluna seriam ruído.
**Conteúdo da lista de canais:** nome da comunidade ativa no topo (clicável → painel de membros), categorias colapsáveis (ver dataset §2 pra Vale do Código), canal de voz lista os participantes ativos abaixo do nome, um por linha (avatar + nome de exibição — a tira de avatares nus dizia quantos estavam na sala, não quem); clicar numa dessas linhas abre o popover de perfil (1.4), como em qualquer outro lugar onde uma pessoa é exibida. Para quem tem `gerenciar canais`, mais três afordâncias discretas (especificadas em §10, 3.4): "+" no cabeçalho da lista, "+" no header de cada categoria e "+ Nova categoria" no fim da lista.
**Barra de usuário (rodapé da coluna da esquerda):** faixa de 56px atravessando o rail e a lista de canais (72 + 240px), `surface-app` com `border-subtle` no topo. À esquerda, avatar M com dot de presença, nome de exibição (`text-body-emphasis`) e a presença por extenso embaixo (`text-meta`, `text-tertiary`) — o bloco inteiro é um alvo clicável, com hover próprio, e abre o popover do **próprio** perfil (1.4), onde já moram trocar presença, editar apelido e o caminho para 3.1. À direita, três ícones de 32px: **mudo**, **ensurdecer** e **engrenagem** (abre 3.1 direto, para quem quer as configurações e não o perfil). O estado ligado de mudo/ensurdecer é vermelho **e** troca o ícone para a versão cortada — cor nunca é pista única (§5.4). Sem identidade (antes de 0.1) a barra não existe; sem comunidade ativa (Hub vazio) ela existe, mas o bloco de identidade não abre popover, porque apelido e cargos são por comunidade (§2, Member) e não há nenhuma.

**Mudo e ensurdecer são preferência da instalação, não estado da chamada.** Os dois ficam nesta barra justamente porque valem fora de uma chamada: desligar o microfone aqui faz Ana **entrar já muda** no próximo canal de voz, e a escolha sobrevive ao reload. Dentro da chamada, os mesmos dois controles continuam existindo na barra de chamada (2.3.1) e na grade (2.3), sobre o mesmo estado — não são três interruptores, é um só em três lugares. Enquanto a chamada existe, quem a barra reflete é o participante local do roster (o host publica o que a máquina pediu); fora dela, a preferência é tudo que há. Aplicar a preferência ao entrar é **efeito, não ícone**: a trilha do microfone entra desligada (§17.4, L-12), como no mudo de dentro da chamada.

**Ações:** trocar comunidade, trocar canal, colapsar/expandir categoria, abrir busca, abrir configurações, abrir painel de membros, entrar/sair de voz, e — com `gerenciar canais` — criar/editar/excluir canal e categoria (3.4).
**Interações:** hover no ícone de comunidade mostra tooltip com o nome; clique em canal de voz entra direto sem confirmação (sair pode ter aviso — ver flow C11); botão direito num canal ou no header de uma categoria abre o menu de contexto de 3.4 (só com permissão). Reordenar canal/categoria por drag-and-drop fica **fora do v1** (não mencionado no CLAUDE.md — ordem é fixa por ordem de criação).
**Estados:** comunidade com host offline → ícone com opacidade 60% + dot `conn-offline` sobreposto; comunidade/canal ativo vs. inativo; canal não-lido (negrito + dot) vs. lido; categoria colapsada/expandida (lembrado por comunidade, client-side).
**Não-lidas no rail** (sem isso, não-lida e menção só existem dentro da comunidade que já está aberta — e a premissa 7 põe as duas no v1): ícone de comunidade com qualquer canal não-lido ganha um **traço branco curto** à esquerda, mais curto que a barra `accent-default` de 4px do estado ativo (mesma gramática do gênero: comprimento = ativo > não-lido > nada); comunidade com **menção pendente** ganha badge numérico `feedback-danger` no canto inferior direito do ícone, truncando em "99+" (§6). Canal silenciado (1.1.1) não conta pro traço de não-lida, mas **menção direta continua contando** — silenciar reduz ruído, não esconde alguém te chamando pelo nome. Comunidade inteira silenciada em 3.1 (Notificações → "Nada") não mostra nem traço nem badge.
**Feedback visual:** troca de canal tem fade rápido (`duration-fast`) pra evitar flash vazio.
**Navegação:** ponto central — quase tudo nesta spec é alcançável a partir daqui.
**Responsividade:** **Desktop** 4 colunas completas. **Tablet** painel de membros/thread vira overlay flutuante (não ocupa coluna fixa), acionado por botão no cabeçalho do canal. **Mobile** uma coluna por vez, navegação sequencial rail → lista de canais → conteúdo com botão "voltar" (comportamento completo em §16).

#### 1.1.1 Menu de contexto do canal (todos os membros)

**Objetivo:** dar ação às duas propriedades de canal que o dataset §2 já exibe mas que nenhuma tela produzia — silenciado (`#ajuda-backend` nasce assim) e não-lido. Este menu é de **todo membro**, sem permissão nenhuma; os itens de gestão (§10, 3.4) se somam a ele para quem tem `gerenciar canais`, na mesma ordem de §15 (conteúdo primeiro, destrutivo por último, separados por divisor).

**Layout:** menu de contexto padrão (§6), acionado por botão direito, pelo "⋯" que aparece no hover do item, ou long-press em Mobile.

**Itens, nesta ordem:**
- **Marcar como lido** — some quando o canal já está lido. Zera contador e menções e move o divisor "Novas mensagens" (§6) para o fim; não navega pro canal.
- **Silenciar canal** / **Reativar notificações** — alterna `silenciado` (§2). Silenciado, o item de canal perde o destaque de não-lida e ganha o ícone de mudo (§6, item de lista de canal), mas **menções diretas continuam gerando badge** — a mesma regra do rail em 1.1.
- **Copiar link do canal** — só aparece pra canal de texto; produz um link `/m/:code` apontando pra primeira mensagem não lida (§4). Sem mensagem nenhuma no canal, o item some.
- Divisor + itens de 3.4, quando houver permissão.

**Ações equivalentes fora do menu** (§19.4 exige caminho não-dependente de hover/botão direito): "Marcar como lido" também acontece por `Shift+clique` no canal e por `Esc` com o canal aberto e rolado até o fim; silenciar também está no cabeçalho do canal (2.1), no ícone de sino ao lado da busca.

**Estados:** canal lido (sem "Marcar como lido") · canal silenciado (item invertido) · canal de voz (sem "Marcar como lido" nem "Copiar link" — voz não tem histórico) · comunidade inteira silenciada em 3.1 (o item de canal segue disponível e independente; o mais restritivo vence na hora de notificar).

**Escopo do silenciamento:** é preferência **local de quem lê**, não propriedade da comunidade — não vai pro log de auditoria, não aparece pra mais ninguém, e persiste por dispositivo junto das outras preferências de 3.1. Sem duração ("silenciar por 1 hora") no v1 (Apêndice A).

**Responsividade:** Mobile → long-press abre bottom sheet em vez de menu ancorado, mesma lista.

### 1.2 Painel de busca

**Objetivo:** encontrar mensagens/canais/membros, com dois escopos (inline no canal atual e global com filtros) no mesmo componente.
**Layout:** overlay centralizado no topo (~600px), scrim atrás, `surface-elevated`.
**Estrutura:** campo com placeholder "Buscar em Vale do Código" (ou "Buscar em #geral" se aberto pelo ícone de busca do canal — escopo inicial = canal atual, expansível pra comunidade inteira); linha de filtros (chips: Autor, Canal, Data, Tipo — anexo/link/fixado); resultados agrupados por tipo (Mensagens, Canais, Membros) conforme digita.
**Conteúdo mockado:** buscar "revisar" retorna a mensagem de Bianca Souza em `#geral` (dataset §2), trecho destacado, contexto (autor, canal, "hoje 09:41").
**Ações:** digitar, aplicar/remover filtro, clicar resultado (navega e destaca a mensagem), limpar, fechar (`Esc`).
**Interações:** navegação por teclado entre resultados (setas + Enter); debounce ~250ms.
**Estados:** vazio (mostra canais visitados recentemente) · digitando sem resultado (skeleton) · com resultados · sem resultados ("Nada encontrado para 'xyz'") · **resultado potencialmente incompleto** — comunidade com host offline (ex. Ateliê Aberto) mostra banner no topo dos resultados: "Buscando só no histórico salvo neste dispositivo — Ateliê Aberto está offline".
**Navegação:** `Cmd/Ctrl+K` de qualquer lugar dentro de uma comunidade ativa; ícone de lupa no cabeçalho do canal.
**Responsividade:** Mobile → tela cheia em vez de overlay.

### 1.3 Painel de membros

**Objetivo:** listar quem está na comunidade, agrupado por cargo, com presença.
**Layout:** coluna direita (280px) em Desktop; overlay em Tablet/Mobile.
**Estrutura:** grupos por cargo em ordem de hierarquia (Fundador → Moderador → Contribuidor → Membro), header `text-caption` com nome do cargo + contagem ("MODERADOR — 1"); offline agrupados no fim sob "OFFLINE — 307", **colapsado por padrão**. Linha: avatar + dot de presença, nome/apelido, ícone pequeno se em voz agora.
**Conteúdo mockado:** Rafael, Bianca, Diego, Ana, Fernanda + agregador offline (dataset §2).
**Ações:** clicar abre popover de perfil (1.4); **botão direito (ou long-press em Mobile) abre o menu de contexto de membro** — o mesmo de §6, já disponível na linha de participante de voz da lista de canais (1.1), e que §6 sempre previu "em membro" (emenda de 2026-09-06: o painel de membros é a superfície onde a lista de gente vive, e era a única que não tinha o gatilho); busca rápida no topo filtra por nome.
**Estados:** carregando (skeleton) · lista normal · grupo offline expandido/colapsado.
**Navegação:** aberto pelo nome da comunidade no cabeçalho da lista de canais, ou ícone dedicado no cabeçalho do canal; fecha o painel de thread se aberto (mesmo slot, §6).
**Responsividade:** Tablet/Mobile → drawer deslizando da direita por cima do conteúdo.

### 1.4 Popover de perfil de membro

**Objetivo:** ver detalhes de um membro e agir sobre ele sem sair do contexto atual.
**Layout:** popover ancorado no elemento que disparou (avatar/nome), `surface-elevated`, ~320px.
**Estrutura:** avatar tamanho G + dot de presença; nome de exibição + apelido (se houver) + identificador; cargos como pills coloridas (§5.4); data de entrada ("Entrou em 12 mar 2026"); seção de ações condicionais à permissão de Ana (ver **Gestão de cargos e permissões**, §10).
**Conteúdo mockado:** popover de Diego Alves — pill verde "Contribuidor", "Entrou em 3 jan 2026", presença online.
**Ações condicionais:** "Atribuir cargo" (se Ana gerencia cargos), "Silenciar/Ensurdecer nesta chamada" (só se ambos em voz juntos), "Timeout", "Expulsar", "Banir" (só se cargo de Ana for hierarquicamente superior ao do alvo).
**Ações no próprio perfil** (substituem o bloco de moderação, que nunca aponta pra si mesma):
- **"Editar apelido nesta comunidade"** — abre um campo inline no próprio popover (não um modal): 1-32 caracteres, salva com `Enter`, limpa com o botão "Usar meu nome" que remove o apelido e volta a exibir o nome de identidade. Apelido é **por comunidade** (§2, Member) e definido pela própria pessoa (premissa 11): em Vale do Código Ana pode ser "Ana (design)" enquanto segue "Ana Torres" em Clã Noturno. Muda o nome dela na lista de membros (1.3), nas mensagens já enviadas (o nome é resolvido na renderização, não copiado na mensagem) e no autocomplete de menção (2.1.1).
- **"Definir presença"** — submenu com os quatro estados de §2/§5.4: Online, Ausente, Ocupado, Invisível. É o caminho rápido; o mesmo seletor existe em 3.1 → Minha conta. "Invisível" mostra Ana como offline pros outros, com aviso no próprio submenu de que ela continua recebendo tudo normalmente.
- **"Editar perfil"** — abre 3.1 na aba **Minha conta** (nome de exibição e cor do avatar, que são globais, ao contrário do apelido). É o destino que faltava a esta ação.
**Estados:** padrão · próprio perfil de Ana (bloco acima em vez de ações de moderação) · editando apelido (campo inline, contador, `Esc` cancela) · perfil de alguém banido (só alcançável via log de auditoria — mostra "Banido" no lugar do cargo, sem ações exceto "Ver no log").
**Navegação:** fecha ao clicar fora ou `Esc`; nunca navega pra "outra tela" — estritamente contextual.
**Responsividade:** Mobile → bottom sheet (desliza de baixo) em vez de popover ancorado.

## 9. Especificação por tela — Camada 2 (conteúdo)

### 2.1 Canal de texto

**Objetivo:** ler e enviar mensagens, com recursos completos — markdown, menções, reações, resposta inline, threads, fixar, editar/deletar, anexos (escopo "completo, estilo Discord" confirmado com o usuário).
**Layout:** header do canal (nome, tópico, ícones: thread/fixados/busca/membros) + lista de mensagens (scroll cronológico, scroll-to-bottom ao entrar) + composer fixo na base.
**Hierarquia visual:** header em `surface-primary` com `border-subtle` na base; mensagens consecutivas do mesmo autor agrupadas (avatar/nome só na primeira, <5min de intervalo); hover revela barra de ações flutuante à direita da mensagem.
**Componentes:** divisor de mensagens (linha "Novas mensagens" / separador de data), linha de mensagem, composer, card de anexo, pill de menção (`accent-muted-bg` quando é `@ana`), reação (chip com emoji + contagem, destacado se Ana reagiu).
**Conteúdo mockado:** thread de `#geral` do dataset (§2) — Rafael, Diego (com edição), Bianca (fixada), Ana (resposta inline).
**Ações disponíveis:** enviar mensagem; anexar arquivo; formatar (negrito/itálico/código inline/bloco de código/link); mencionar `@membro`, `@cargo`, `@everyone` (se permitido); reagir com emoji; responder inline; responder em thread; fixar/desafixar (se permissão); editar mensagem própria; deletar mensagem própria ou, com permissão de moderação, de qualquer um; copiar link da mensagem; rolar histórico pra cima (infinite scroll); pular pra "primeira não lida".
**Interações:** hover em mensagem mostra toolbar (reagir, responder, responder em thread, "⋯"); digitar `@` abre autocomplete de membros/cargos filtrando por texto (comportamento detalhado em 2.1.1); contador "X está digitando…" no rodapé, acima do composer. **Hover num chip de reação** mostra tooltip com quem reagiu — até 6 nomes, depois "e mais N". **Emenda de 2026-09-05:** a fonte dos nomes é `query.reactors` (§15.6, `DR-47`), pedida quando o ponteiro ou o foco chega ao chip — **não** `Reaction.usuários[]`. O fio da lista de mensagens (§15.6.1) carrega só `{emoji, count, mine}`: quem mais reagiu não está nele, e o tooltip que lia aquela lista anunciava a reação sem nome nenhum sempre que ela era de outra pessoa. Enquanto a consulta não volta, o tooltip diz a contagem ("5 pessoas reagiram com 👍"), que é o que se sabe. Em Mobile, long-press no chip abre a mesma lista como bottom sheet. "Copiar link da mensagem" produz a rota `/m/:code` de §4 — e é o único lugar da spec que a gera.

**Emenda de 2026-09-05 — alvo fora do trecho carregado.** A lacuna: nem o deep link `/m/:code` nem o resultado de busca diziam o que fazer quando a mensagem apontada está fora da janela de 50 do canal (§23.3). Fica decidido: **navega-se ao canal e diz-se o que houve** — "Esta mensagem está fora do trecho carregado deste canal — role para cima para chegar nela". Não se busca a mensagem antiga só para destacá-la (seria paginar até ela sem a pessoa ter pedido), e não se cala: cair no canal certo sem destaque e sem aviso fazia o link parecer quebrado. Mensagem apagada continua com o desfecho próprio ("Esta mensagem não existe mais"), e comunidade da qual não se faz parte continua com o de §18 — nenhum dos dois vaza se a mensagem existe.
**Estados:** canal vazio ("Este é o início de #nome-do-canal") · carregando histórico (skeleton) · mensagem enviando (opacidade reduzida) · falha no envio (ícone de alerta + "Tentar novamente") · pendente offline (ícone de relógio — ver fluxo B4, premissa 5) · scroll fora do fim (botão flutuante "↓ Novas mensagens") · canal somente-leitura para o cargo atual (ex.: `#avisos` pra quem não é Moderador+ — composer substituído por aviso "Só moderadores podem postar aqui").
**Feedback visual:** mensagem que chega via link/busca recebe highlight breve (`accent-muted-bg`, ~1.5s, fade out); toast "Link copiado" ao copiar link de mensagem.
**Navegação:** abre painel de thread (2.2), busca escopada (1.2), aba de fixados (dentro do próprio header do canal, via tabs — ver §6).
**Responsividade:** **Mobile** composer permanece fixo na base mesmo com teclado virtual aberto (viewport ajustada); barra de ações da mensagem vira acionável só por long-press em vez de hover.

#### 2.1.1 Autocomplete de menção (@)

**Quando aparece:** ao digitar `@` no composer (canal de texto 2.1 ou composer de thread 2.2), seguido opcionalmente de texto de filtro.
**Layout:** dropdown ancorado imediatamente acima do composer (abre pra cima — o composer fica na base da tela), largura igual à do composer, `surface-elevated`, altura máxima ~6-8 linhas visíveis com scroll interno pra mais.
**Estrutura, agrupada em ordem fixa (nunca interleaved — a seção já indica o tipo, sem depender só de um ícone pequeno):**
- **`@everyone`** — linha única no topo, só aparece se Ana tiver a permissão `mention_everyone` nesta comunidade (some da lista pra quem não tem, nunca aparece desabilitado — mesma regra de ocultar-não-desabilitar do menu de contexto de moderação, §15). Ícone genérico de "todos" + "everyone" + secundário `text-tertiary` "Notifica todos os membros do canal".
- **Seção "CARGOS"** (header `text-caption`, só aparece se houver ao menos um cargo mencionável correspondente ao filtro): swatch circular 16px preenchido com a cor do cargo (`role-*`, §5.4) no lugar de avatar + nome do cargo em `text-body-emphasis` + secundário "N membros". Respeita o toggle "Mencionável" de cada cargo (§10, 3.2) — no dataset, todo cargo exceto o cargo base "Membro" é mencionável por padrão.
- **Seção "MEMBROS"** (header `text-caption`): avatar P (24px) com dot de presença + nome de exibição/apelido, colorido com a cor do cargo principal do membro (mesma convenção do nome do autor nas mensagens) + secundário `text-tertiary` com o nome do cargo principal. Ordenado online → ausente → offline, alfabético dentro de cada grupo de presença.
**Conteúdo mockado:** digitar `@bi` em Vale do Código retorna só "MEMBROS — Bianca Souza" (secundário "Moderador"). Digitar `@` sozinho (sem filtro) retorna a lista default: `@everyone` (Ana tem `mention_everyone` como Contribuidor) → CARGOS: Fundador, Moderador, Contribuidor → MEMBROS: Rafael, Diego, Bianca (online, nessa ordem), depois Fernanda (ausente).
**Ações:** navegar com ↑/↓ (wrap-around — do último volta pro primeiro), confirmar com `Enter` ou `Tab`, clicar numa linha com o mouse, fechar com `Esc` (mantém o `@` e o texto já digitado como texto comum, sem inserir menção) ou apagando o `@` com backspace.
**Interações:** mesmo padrão de navegação por teclado da busca (1.2) — setas movem a seleção, Enter confirma — com duas diferenças específicas de autocomplete inline: `Tab` funciona como atalho adicional equivalente a `Enter` (convenção padrão desse tipo de componente), e digitar espaço ou pontuação encerra o filtro e fecha o dropdown (na busca 1.2 o usuário continua digitando livremente). Sem debounce perceptível — filtro local sobre membros/cargos já carregados da comunidade, não é busca assíncrona.
**Estados:** lista default (só `@` digitado, sem filtro) · filtrando com resultados · filtrando sem resultados (linha única "Nenhum resultado para '@xyz'", compacta, sem ilustração — diferente do empty state de tela cheia) · linha selecionada (fundo `accent-muted-bg`, mesma convenção de item ativo usada em toda a spec).
**Feedback visual:** ao confirmar, a menção vira um token não-editável inline no composer (pill compacta — `accent-muted-bg` para cargo/everyone, cor do cargo do membro para pessoa); um único `Backspace` no token remove a menção inteira, não caractere por caractere — inclusive quando o cursor está depois do espaço que a confirmação insere.

**Emenda de 2026-09-05 — o que É menção no envio.** A lacuna: a spec não dizia o que acontece quando alguém digita `@Ana` ou `@everyone` à mão, sem confirmar no dropdown. Fica decidido:

1. **Só menção confirmada notifica.** O `mentions` da op (§15.4 `message.send`) leva exclusivamente os ids escolhidos no autocomplete. Texto digitado à mão é texto — não há adivinhação de quem é "@Ana" quando existem duas Anas, e o `fold` não aceitaria um palpite como dado. O feedback já é visível dos dois lados: o espelho do composer só destaca o que foi confirmado, e a mensagem enviada só vira pill o que está em `mentions`.
2. **Confirmada é a palavra inteira.** Um token vale como menção onde ele é a palavra completa: escolher `@Dan` e seguir digitando até `@Danilo` **não** manda o id do Dan. O casamento por "o texto contém o token" notificava quem a mensagem não menciona.
3. **Homônimos são pessoas distintas.** Duas pessoas com o mesmo nome de exibição produzem o mesmo token. Cada confirmação é uma entrada própria, e o envio casa **por ocorrência**: duas confirmações levam os dois ids só se o token aparecer duas vezes no texto. Antes, a segunda escolha apagava a primeira e uma das duas pessoas não era notificada.
4. **O `Esc` vale para a mensagem em que foi dado.** Enviar limpa a memória do `@` dispensado; um `@` na mesma posição da mensagem seguinte reabre o dropdown normalmente.
**Navegação:** existe só dentro do composer (2.1 e 2.2); fecha automaticamente ao enviar a mensagem, apertar `Esc`, ou trocar de canal.
**Responsividade:** **Mobile** mesma lógica, dropdown ocupa até ~40% da altura da viewport, ancorado acima do teclado virtual — sem mudança estrutural.

#### 2.1.2 Painel do canal — Fixados / Arquivos / Links

**Objetivo:** dar destino ao ato de fixar e superfície ao acervo do canal. Até aqui a spec citava estas abas duas vezes (§9 2.1, "aba de fixados no header do canal"; §6, linha de Tabs) sem nunca defini-las — fixar uma mensagem não levava a lugar nenhum, e o `Attachment` de §2 só existia dentro da mensagem onde foi postado.

**Layout:** painel deslizante direito de 320px, **mesmo slot** de membros/busca/thread (§6) — abrir fecha o que estava ali. Tabs horizontais no topo: Fixados · Arquivos · Links.

**Estrutura — Fixados:** mensagens fixadas do canal, mais recente primeiro, cada uma como linha compacta (avatar P, autor, carimbo por §5.10, duas linhas de conteúdo truncadas). Clicar navega até ela no canal com o mesmo highlight de 1.2. Hover revela "Desafixar" para quem tem `pin_messages`.
**Estrutura — Arquivos:** todos os anexos do canal em cards compactos (§6, card de anexo), com nome, tamanho, quem enviou, data, e o estado de disponibilidade P2P que o card já define (peers, host, progresso). É a única tela onde o problema "arquivos ficam no host e se distribuem entre quem já baixou" (`CLAUDE.md:20-22`) aparece agregado em vez de mensagem a mensagem.
**Estrutura — Links:** URLs extraídas das mensagens do canal, com título do domínio, quem postou e data. Sem preview/unfurl (exigiria buscar a página — não existe servidor pra fazer isso por você, e fazer do cliente vazaria o IP de todo mundo pro site linkado; **decisão de privacidade, registrada no Apêndice A**).

**Conteúdo mockado:** Fixados → a mensagem de Bianca "@Ana Torres bora revisar a fila de moderação…" (única fixada no dataset §2). Arquivos → `aula-webrtc-completa.mp4`, 1,24 GB, de Rafael, 62%, "3 peers + host". Links → vazio, ilustrando o empty state.

**Ações:** trocar de aba, navegar até a mensagem de origem, desafixar (com permissão), baixar arquivo, copiar link.
**Estados:** cada aba tem empty state próprio, nomeando o que falta (§12) — "Nenhuma mensagem fixada neste canal" com dica "Fixe uma mensagem pelo menu dela", "Nenhum arquivo compartilhado aqui ainda", "Nenhum link compartilhado aqui ainda" · carregando (skeleton) · **host offline** → banner igual ao da busca (1.2): "Mostrando só o que está salvo neste dispositivo" (premissa 6).
**Navegação:** ícone de alfinete no cabeçalho do canal (2.1), ao lado de busca e membros. Fecha com `Esc` ou reclique, respeitando a ordem de camadas (§18, popover/modal por cima primeiro).
**Responsividade:** Tablet → overlay flutuante; Mobile → tela cheia com "voltar" (§16).

### 2.2 Painel de thread

**Objetivo:** sub-conversa aninhada a uma mensagem raiz, sem poluir o canal principal.
**Layout:** painel deslizante direito (mesmo slot que membros/busca — ver §6), 320px.
**Estrutura:** mensagem raiz fixada no topo (fundo levemente destacado de `surface-elevated`), respostas abaixo em ordem cronológica, composer de thread na base.
**Conteúdo mockado:** thread a partir de "@Ana Torres bora revisar a fila de moderação depois do almoço?" (Bianca), com a resposta de Ana já visível como primeira reply.
**Ações:** responder na thread, reagir, fechar painel.
**Estados:** vazio ("Seja o primeiro a responder") · com respostas · não lida (badge no indicador "💬 N respostas" abaixo da mensagem raiz, no canal principal).
**Navegação:** aberto por "Responder em thread" no menu de uma mensagem, ou clicando no indicador "💬 N respostas" já existente sob ela.
**Responsividade:** Mobile → tela cheia (substitui o canal, com botão "voltar").

**Emenda de 2026-09-05 — a âncora da thread e a reconciliação com o canal.** A lacuna: a página do canal traz a janela de 50 de §23.3 e `query.thread` traz a thread inteira; a spec não dizia como as duas se combinam quando elas discordam. Fica decidido:

1. **A raiz é dado, não dedução.** O indicador "💬 N respostas" ancora na `threads.root_message_id` respondida por `query.thread` (§15.6). Deduzi-la como o registro de menor `seq` da página estava errado: uma thread aberta há tempo tem a raiz **fora** da janela, e o palpite pendurava o indicador numa resposta — de onde ele nunca mais saía, porque a thread passava a constar como conhecida.
2. **A leitura da thread respeita o estado local.** O que `query.thread` devolve passa pelo mesmo recorte que a página do canal: resposta apagada nesta sessão não aparece no painel, e resposta editada aparece com o texto novo. Sem isso a thread contradizia a conversa — a mesma mensagem, apagada no canal e viva no painel.
3. **Raiz removida não perde as respostas.** `query.thread` continua respondendo a thread cuja raiz foi tombstonada; o que sai é o badge de não-lidas (`query.thread.unread` filtra `root_deleted`). O painel abre pela raiz tombstonada como abriria por qualquer outra: o registro existe, o conteúdo é o de U-20.

### 2.3 Canal de voz

**Objetivo:** comunicação de voz em mesh P2P direto entre participantes (`CLAUDE.md:11`).
**Layout:** ao entrar, a área de conteúdo principal (se Ana estava olhando aquele canal) muda pra grade de participantes; se Ana estava em outro canal de texto, abre como overlay expandido a partir do painel da chamada (§4).
**Estrutura:** grade de tiles de participante (avatar + anel de fala + ícones de estado sobrepostos) + barra de controles inferior (mudo, ensurdecer, câmera, compartilhar tela, sair, atalho de configuração de dispositivo).
**Conteúdo mockado:** `Sala de Estudos` com Rafael, Diego, Bianca conectados (dataset §2); Diego com anel de fala ativo no momento inicial da tela.
**Ações:** mutar/desmutar microfone, ensurdecer/desensurdecer, ativar câmera, compartilhar tela (abre 2.4), sair do canal, ajustar volume individual por participante (slider no popover de perfil, 1.4, quando aberto durante a chamada).
**Interações:** clicar num tile abre popover de perfil (1.4) com slider de volume adicional específico da chamada.
**Estados:** conectando (skeleton dos tiles + banner `conn-reconnecting` "Conectando…") · conectado normal · peer com problema pontual de conexão (ícone de sinal fraco só no tile dele, não afeta os demais) · mesh parcialmente degradado (um peer específico não conecta com Ana mas conecta com os outros — banner "Conexão instável com Diego Alves", `conn-degraded`) · saindo.

> **Emenda de 2026-08-26 (§91) — "Conectando…" é banner, e sozinho não é conectando.**
> Os três estados da chamada moram no mesmo lugar e falam a mesma língua: "Conectando…"
> era o único solto como parágrafo, sem ponto de cor nem o movimento que §5.4 pede de
> transitório, e lia como legenda em vez de estado. Passa a `StatusBanner` no tom
> `reconnecting`, ao lado de `conn-degraded` e `conn-failed`.
>
> E **entrar sozinho não é "conectando"**: não há par com quem conectar, que é a mesma
> leitura que a malha já fazia ao não armar o prazo de L-11 nesse caso. Quem entrava
> primeiro num canal ficava em "Conectando…" para sempre, com o próprio tile preso em
> esqueleto — nunca se via na grade da chamada em que já estava.
**Feedback visual:** anel de fala reflete quem está falando em tempo real (no mock, simula ciclando entre participantes).
**Navegação:** o painel da chamada (detalhado em 2.3.1) permite voltar a navegar canais de texto sem sair da chamada.
**Responsividade:** **Mobile** grade vira lista vertical compacta com carrossel horizontal se >4 participantes.

#### 2.3.1 Painel da chamada (estado recolhido)

É a representação compacta da mesma sessão de voz de 2.3 — existe sempre que Ana está conectada a um canal de voz e não está olhando a grade expandida (por exemplo, navegando um canal de texto, ou até numa comunidade diferente da que hospeda a chamada, per fluxo C11). Layout muda por breakpoint porque o espaço disponível é fundamentalmente diferente (312px da coluna da esquerda no Desktop/Tablet vs. largura total no Mobile) — não é só uma versão "espremida" do mesmo painel.

**Desktop e Tablet — e o Mobile com a lista de canais em foco** (é o mesmo componente; o que muda é só o alvo de toque, 44px onde não há ponteiro):
- Container: a largura da coluna da esquerda (rail + lista de canais), ancorado **logo acima da barra de usuário** (§8, 1.1) e nunca no lugar dela: uma é a chamada de agora, a outra é a identidade permanente. Fundo `surface-sidebar`, `border-subtle` no topo, padding 8px, duas linhas com 8px de gap.
- **Linha 1**: ícone 🔊 14px em `conn-ok` + nome do canal (`text-body-emphasis`, truncado) +, só quando a chamada pertence a uma comunidade diferente da ativa no momento, " · " + nome da comunidade em `text-tertiary` (também truncado). Sem esse sufixo quando a chamada é da própria comunidade ativa — informação redundante nesse caso. Clicar nessa área expande pra 2.3 como overlay (§4). À direita, o botão de **sair**, em `feedback-danger`.
- **Linha 2**: dois botões largos de mesma largura — **câmera** e **tela** —, cada um com ícone 16px + rótulo. O de tela some para quem não tem `voice_share_screen`, nunca aparece desabilitado (§15), e a câmera ocupa a linha inteira nesse caso. Ligado é `accent-muted-bg` **e** ícone trocado (câmera cortada, monitor sem seta): cor nunca é pista única (§5.4). O de tela abre o seletor de fonte de 2.4 quando não há transmissão minha, e a encerra quando há.
- **Mudo e ensurdecer não estão aqui.** Eles moram na barra de usuário (§8, 1.1), 8px abaixo, e valem também fora da chamada — repeti-los neste painel seria o mesmo interruptor duas vezes na mesma coluna. O que fica aqui é só o que existe **enquanto há chamada**: de onde ela é, sair dela, e as duas ações que produzem mídia.
- **Sem stack de avatares.** A versão anterior deste painel carregava a miniatura de quem estava dentro, e o argumento era que ela seria a única pista visual disso. Deixou de ser: a lista de canais mostra os participantes por nome, um por linha (§8, 1.1), e quem está numa comunidade diferente da chamada tem o nome da comunidade escrito na linha 1 e a grade a um clique. O Mobile mantém a stack, porque lá a lista de canais não está na tela junto do conteúdo.

**Mobile** (<640px):
- Container: largura total da viewport, 64px de altura, fixo no rodapé, `surface-elevated`, `border-subtle` no topo, padding 12px. Existe **enquanto o conteúdo está em foco** — que é quando a coluna da esquerda saiu da tela (§16) e a chamada ficaria sem nenhuma superfície. Com a lista de canais em foco, quem faz este papel é o painel do Desktop, acima da barra de usuário: as duas juntas empilhavam dois microfones a 60px de distância, e o de baixo repetia o de cima.
- **Uma linha só** (mais espaço horizontal disponível que no Desktop): à esquerda, stack de avatares (24px cada, máximo 3 + badge "+N") + ao lado, nome do canal (`text-body-emphasis`) e, numa segunda linha de texto pequena abaixo, nome da comunidade em `text-tertiary` — mesma regra condicional (só mostra se a comunidade da chamada for diferente da ativa). À direita, só 2 controles — **mudo** e **sair** — cada um com área de toque de 44px (convenção de touch target mínimo) mesmo com ícone visualmente menor; ensurdecer/câmera/compartilhar ficam só na vista expandida (2.3), pra não lotar uma barra estreita com alvos de toque pequenos demais.
- Toque em qualquer área fora dos 2 botões expande pra 2.3 em tela cheia.

**Anel de fala ativa — visível mesmo recolhido**, nos avatares da stack do Mobile: mesmo token de cor/animação do anel expandido (2.3, `presence-online` com pulse, §5.4), só escalado para o tamanho menor. Mantém a regra de acessibilidade já estabelecida — forma + movimento, não só cor — mesmo em miniatura. O badge de overflow "+N" nunca recebe anel, por não representar uma pessoa específica.

#### 2.3.2 Câmera

**Objetivo:** dar superfície ao "vídeo" do nome do produto (`CLAUDE.md:1`). Até aqui `câmeraOn` existia em §2, "ativar câmera" era ação de 2.3, e o único efeito especificado era um **ícone** no tile (§6) — ligar a câmera não mudava nada do que se vê.

**Topologia (premissa 9):** câmera vai pelo **mesh direto da voz**, igual ao áudio — cada participante manda seu vídeo pra cada outro. A árvore de multicast de `CLAUDE.md:12-19` é para transmissão a audiência (compartilhamento de tela, 2.4), não para uma chamada de poucos. Consequência que a interface precisa admitir: com muita gente de câmera ligada o upload de cada um cresce linearmente. **Não há teto de câmeras** (emenda de 2026-08-26, §90): o `MAX_CAMERAS` = 6 que ficava aqui era número ilustrativo, e a interface não desenha portão que o núcleo não aplica. O que a tela deve fazer é o tratamento assimétrico de sempre — vídeo de um par que trava vira ícone de sinal fraco no tile dele, e conexão degradada devolve o avatar, porque o áudio tem prioridade.

**Layout:** o tile do participante (§6) troca o avatar pelo vídeo, mantendo tudo o que já estava sobreposto — anel de fala, ícones de estado, nome no canto inferior. Proporção 16:9, recorte `cover`, `radius-md`. Tiles sem câmera continuam mostrando avatar, na mesma grade: **não** há duas grades separadas.

**Estrutura:** grade da 2.3, com os tiles de câmera ganhando prioridade de tamanho quando há mistura (vídeo ativo é maior que avatar, na proporção que couber). Vídeo **espelhado só para você mesma** (convenção universal: você se vê como no espelho, os outros te veem como você é).

**Conteúdo mockado:** o mock não captura câmera de verdade (mesma postura de 2.4 para tela) — o tile mostra uma superfície de vídeo simulada com o avatar em movimento suave sobre `surface-app`, suficiente para validar layout, proporção e prioridade da grade.

**Ações:** ligar/desligar câmera (botão de 24px na barra de controles de 2.3, ao lado de mudo/ensurdecer), escolher dispositivo (atalho para 3.1 → Dispositivos), fixar um tile como principal (clique duplo — desfaz com outro clique duplo).
**Estados:** desligada (avatar) · iniciando ("Ligando câmera…", ~800ms) · ligada · **sem permissão do sistema operacional** → erro nomeado ("O sistema bloqueou o acesso à câmera") com atalho pra 3.1 → Dispositivos, nunca falha silenciosa · vídeo de um peer travando (ícone de sinal fraco no tile dele, mesmo tratamento assimétrico do áudio em B7) (o botão de câmera não tem estado "limite atingido": não há teto — §90).
**Navegação:** existe só dentro do canal de voz (2.3); a barra recolhida (2.3.1) **não** mostra vídeo — só a stack de avatares, como já especificado.
**Responsividade:** Mobile → no máximo 2 tiles de vídeo visíveis por vez no carrossel de 2.3; o resto continua acessível rolando.

### 2.4 Compartilhamento de tela/vídeo

**Objetivo:** representar a parte mais diferenciadora da arquitetura do produto — estrela vs. multicast em árvore, fallback TURN, reparo de árvore (`CLAUDE.md:12-19`). É o item de maior originalidade de toda a spec (sem equivalente direto no Discord).
**Layout:** dentro do canal de voz (2.3) — sub-modo, não tela irmã. Tile do compartilhamento ativo ocupa a maior área, thumbnail strip dos demais participantes abaixo/lateral.
**Estrutura:** tile principal + badge de topologia (**"Transmissão direta"** com ícone de estrela quando ≤5 espectadores, ou **"Retransmissão em árvore"** com ícone de nós conectados quando >5 — `CLAUDE.md:13-14`) + contagem de espectadores + indicador de qualidade + ícone de fallback TURN quando ativo, com tooltip "Conexão direta bloqueada por NAT restritivo — usando retransmissão" (`CLAUDE.md:19`).
**Conteúdo mockado:** Rafael compartilhando tela pra 7 espectadores → modo árvore ativo; Ana é um dos nós que retransmite pro próximo nível, com badge discreto **"Você está retransmitindo para 2 pessoas"** (só aparece pra quem de fato está repassando — `CLAUDE.md:15-18`).
**Ações:** iniciar compartilhamento (escolher janela/tela — mock simula sem captura real de tela), parar, ajustar qualidade, expandir pra tela cheia; **só o apresentador** também pode expandir o badge de topologia pra ver a saúde da árvore de distribuição (detalhado em 2.4.2) — pra espectadores o badge é só informativo, não clicável.

> **Emenda de 2026-08-26 (§87, delta U-25) — "ajustar qualidade" não é ação dos dois papéis.**
> Esta linha lista as ações sem separar por papel, e foi assim que o seletor de qualidade foi
> parar na tela do espectador. Em estrela o perfil é aplicado no `RTCRtpSender` do
> apresentador: quem pedia não era quem pagava. **Apresentador:** resolução, taxa de quadros
> e qualidade (presets e personalizado). **Espectador:** um controle só — ocultar/mostrar o
> vídeo recebido, que é exibição local. A parte da árvore desta seção já tinha saído com B26.
**Estados:**
- Iniciando ("Preparando compartilhamento…").
- Ativo, modo estrela (≤5 espectadores) — sem nós intermediários ainda, badge não é expandível nem pro apresentador.
- Ativo, modo árvore (>5 espectadores) — transição estrela→árvore mostra brevemente "Otimizando distribuição…" (não é instantâneo/abrupto, pra não parecer bug) quando o espectador nº6 entra.
- **Reparando árvore** — nó do meio caiu (`CLAUDE.md:46-47`): banner "Reorganizando transmissão…" cor `conn-reconnecting` (com pulse), espectadores afetados veem um buffer breve em vez de tela congelada sem explicação. Apresentador recebe o mesmo banner mais um sinal adicional no painel de saúde da árvore — ver 2.4.2.
- Fallback TURN ativo (ver badge acima).
- Encerrado.
**Feedback visual:** todas as transições de estado usam banner não-bloqueante no topo do tile, nunca um modal que interrompe a visualização.
**Navegação:** acessível só de dentro do canal de voz (2.3).
**Responsividade:** **Mobile** tile principal ocupa quase a tela inteira, thumbnails viram tira horizontal scrollável no rodapé.

#### 2.4.1 Modal de consentimento de repasse (viewer vira nó da árvore)

Cobre diretamente o problema em aberto "consentimento de usar upload de espectador para repassar a outros" (`CLAUDE.md:48`) — o mock representa a pergunta ao usuário, não a resolve tecnicamente.

**Quando aparece:** a árvore de multicast precisa que Ana (espectadora com upload/NAT favoráveis) vire nó intermediário pra mais 1-2 pessoas.
**Conteúdo:** modal pequeno (~360px), título "Ajudar a retransmitir?", corpo "Sua conexão pode retransmitir esta transmissão para outras 2 pessoas, usando um pouco do seu upload. Isso não afeta sua visualização.", checkbox "Lembrar minha escolha para esta comunidade", botões "Recusar" (secundário) e "Aceitar" (primário).
**Estados:** aguardando resposta · aceito (badge "Você está retransmitindo…" aparece no tile, ver acima) · recusado (Ana continua como folha da árvore, sem impacto negativo — texto não usa tom de culpa).
**Navegação:** aparece como modal sobre o canal de voz, não interrompe áudio.

#### 2.4.2 Painel do apresentador — saúde da árvore de distribuição

Só o apresentador vê isso — nunca espectadores, nem os que estão retransmitindo (esses veem só o badge discreto sobre a própria contribuição, já descrito em 2.4/2.4.1, não a árvore inteira). Existe porque o produto trata saúde de conexão como informação de primeira classe (§1, princípio 2) e porque o apresentador é quem carrega a responsabilidade prática de um compartilhamento instável — merece mais visibilidade que "está tudo bem" ou "algo mudou".

**Quando aparece:** badge de topologia (2.4) ganha um indicador extra (▾) só pro apresentador, só em modo "Retransmissão em árvore" — em modo estrela não há nó intermediário nenhum pra listar, então o badge fica só informativo, igual ao que espectadores veem.

**Layout:** clicar no badge (interativo só pro apresentador — ver §9, 2.4) abre um popover ancorado logo abaixo dele, `surface-elevated`, ~280px — mesma linguagem visual do popover de perfil (1.4).

**Estrutura:** título "Retransmitindo através de N pessoas" (N = quantidade de nós de **primeiro nível**, não o total de espectadores); uma linha por nó de primeiro nível — avatar P + nome + dot de status (`conn-ok` / `conn-degraded` / `conn-reconnecting` / `conn-failed`, mesmos tokens de §5.4) + secundário "retransmitindo para N pessoas". Só o primeiro nível aparece individualmente — a árvore não é desenhada em profundidade, porque nem o apresentador tem visibilidade direta de conexões que não são suas (coerente com a natureza P2P: cada nó só enxerga seus vizinhos diretos); a contagem de cada linha já agrega tudo que está abaixo dela na árvore.

**Conteúdo mockado:** Rafael compartilhando pra 7 espectadores (mesmo cenário de 2.4/2.4.1) — painel mostra "Retransmitindo através de 2 pessoas": linha "Ana Torres — retransmitindo para 2 pessoas" (`conn-ok`) e linha "Diego Alves — retransmitindo para 3 pessoas" (`conn-ok`). 2 + 3 = 5 espectadores de segundo nível, mais os próprios Ana e Diego, fecha os 7 do badge.

**Alerta durante reparo de árvore:** sim, e o apresentador recebe mais sinal que o espectador, nunca menos:
- O mesmo banner não-bloqueante "Reorganizando transmissão…" (`conn-reconnecting`, 2.4) aparece igual pro apresentador — consistência de linguagem visual, sem tela/modal separado.
- **Exclusivo do apresentador:** se o painel estiver aberto no momento da falha, a linha do nó afetado muda pra `conn-reconnecting` (pulse) em vez de sumir ou virar erro genérico — no exemplo acima, se Diego cai, a linha dele pulsa em âmbar enquanto a árvore reconecta os 3 espectadores que dependiam dele.
- Se o painel estiver **fechado** no momento da falha, o badge de topologia ganha um dot pequeno pulsante sobreposto ao ícone (mesmo `conn-reconnecting`) — convite discreto pra abrir e ver o quê, sem toast nem modal (mantém a regra já estabelecida em 2.4: transições usam banner não-bloqueante, nunca interrompem a visualização).
- Depois que a árvore se reorganiza, a linha volta a `conn-ok` (a contagem pode mudar, se espectadores foram redistribuídos pra outro nó) e o dot no badge some.

**Ações:** nenhuma sobre nós individuais no v1 — não dá pra forçar reconexão ou remover um nó manualmente. É um painel só de visibilidade, mesma postura de honestidade já adotada em 2.4.1: o mock representa o problema em aberto de reparo de árvore (`CLAUDE.md:46-47`), não finge resolvê-lo com um botão mágico.
**Responsividade:** Mobile → popover vira bottom sheet, mesma convenção do popover de perfil (1.4).

## 10. Especificação por tela — Camada 3 (administração)

### 3.1 Configurações de conta

**Objetivo:** gerenciar identidade local, dispositivos, aparência, notificações e diagnóstico de rede — independente de qualquer comunidade ativa.
**Layout:** modal/tela grande (~720px) com tabs verticais à esquerda (~180px) e conteúdo à direita.
**Estrutura (tabs):**
- **Minha conta** — nome de exibição (editável), avatar (regenerar cor), **seletor de presença** (Online / Ausente / Ocupado / Invisível — os quatro estados de §2 e §5.4, que até aqui tinham sistema de cor, dot e ícone especificados mas nenhum lugar onde se escolhe um; atalho equivalente no popover do próprio perfil, §8 1.4), identificador local (somente leitura, ex.: `@ana` truncado), botão "Sair desta identidade" em zona de perigo (`feedback-danger`, com confirmação — apaga a identidade local deste dispositivo; texto deixa claro que não há recuperação porque não há conta central).
- **Dispositivos** — select de microfone, select de câmera, select de saída de áudio, sliders de volume de entrada/saída com medidor de nível ao vivo (mock: anima aleatoriamente quando "testando"), botão "Testar microfone".
- **Aparência** — informativo nesta v1: "Tema escuro (único disponível nesta versão)" sem toggle funcional — não inventar um seletor de tema que não faz nada.
- **Notificações** — toggle geral, e por-comunidade (lista com switch "Tudo" / "Só menções" / "Nada" por comunidade).
- **Rede** — diagnóstico somente-leitura: tipo de NAT detectado (mock: "NAT moderado — conexão direta funciona na maioria dos casos" ou, pra ilustrar o problema em aberto de CGNAT, "CGNAT detectado — você pode ter dificuldade para retransmitir compartilhamentos de tela para outros", `CLAUDE.md:45`), contagem de peers conectados agora, botão "Executar diagnóstico novamente".
**Ações:** editar nome, trocar avatar, ajustar dispositivos/volume, alternar notificações, reexecutar diagnóstico, sair da identidade.
**Estados:** cada campo segue os estados padrão de formulário (§6); diagnóstico de rede tem estado "executando" (skeleton ~1.5s simulado) e "concluído".
**Navegação:** aberta pela engrenagem da barra de usuário (§8, 1.1), e também pelo "Editar perfil" do popover do próprio perfil (1.4); fecha voltando pro shell na comunidade que estava ativa antes.
**Responsividade:** Mobile → tabs viram lista própria (tela cheia), selecionar uma navega pra tela cheia do conteúdo com botão "voltar" pras tabs.

### 3.1b Configurações da comunidade — Geral

**Objetivo:** editar metadados da comunidade e gerenciar convites (visível pra quem tem `manage_community`; host sempre tem).
**Layout:** mesmo padrão modal/tabs de 3.1, mas escopado à comunidade ativa — tabs "Geral", "Cargos" (3.2), "Moderação" (3.3).
**Gating dentro da aba Geral (emenda de 2026-09-06):** a aba inteira é alcançável por todo membro, porque "Sair da comunidade" mora nela e é de todo mundo. O que é gated é cada seção: **identidade da comunidade** (nome, descrição, "Salvar alterações") só aparece com `manage_community` — §7.4.5 dá `community.update` a ela, e mostrar o formulário para quem não a tem é oferecer um `E_PERMISSION_DENIED`; **convites** só com `create_invite`; a zona de perigo mostra "Encerrar comunidade" só ao host. Sem `manage_community`, a aba Geral abre direto no que a pessoa pode fazer.
**Estrutura (Geral):** nome/ícone/descrição editáveis (mesmos campos de 0.4, agora em modo edição), lista de convites ativos (código **quando disponível** — U-04, ver abaixo —, criado por, usos, expiração, botões "Copiar link" e "Revogar" por linha) + botão "Criar novo convite" (formulário: expiração opcional, limite de usos opcional), zona de perigo no fim: "Sair da comunidade" (todo mundo) ou, se Ana é o host, **"Encerrar comunidade"** (`feedback-danger`, dupla confirmação — texto explícito: "Isso desconecta todos os membros permanentemente. Não pode ser desfeito.").
**Ações:** editar metadados, criar convite, revogar convite, sair/encerrar comunidade.
**A lista de convites e o que se copia dela (emenda de 2026-09-06).** Três regras, e as três estavam sendo violadas na mesma linha:
- **U-04 é sobre a linha inteira, não só sobre o código.** `query.invites` entrega o código apenas dos convites criados nesta instalação e diz isso em `codeAvailable` (`F-21`: o segredo do convite nunca entra no log, senão qualquer membro emitiria convite em nome de outro). Sem código, a linha mostra **"Código não disponível neste dispositivo"** e a ação de copiar **não aparece**; quem criou, usos, expiração e **Revogar** continuam — revogar usa a `invitePublicKey`, que existe para todo convite. O texto obrigatório da delta aparece sob a lista quando houver ao menos uma linha assim. O que existia era o oposto: a interface punha a chave pública de 64 hex no campo do código, exibia-a em fonte monoespaçada como se fosse um, e oferecia copiar um link que não resgata nada.
- **O que se copia é `comunidadep2p://join/<CODE16>`.** É a única forma que o sistema operacional abre (§3.5 tem rota de protocolo só para `join/`, `m/` e `u/`) e é aceita pelo campo "cole um link ou código" de 0.3 — uma string serve os dois caminhos. O `p2p.app/invite/<code>` que era copiado vem do dataset ilustrativo de §2, não é rota de protocolo, não tem esquema (então nem casa a segunda gramática de `codeOrLink` de §15.4) e é inerte onde quer que seja colado; `p2p.app` é domínio que ninguém possui e que o produto nunca resolve.
- **O toast diz o que aconteceu.** "Link copiado" só depois de a escrita na área de transferência resolver; se rejeitar, "Não foi possível copiar o link", em variante de erro. Vale para todo botão de copiar da spec (link de canal em §15, link de mensagem em 2.1, chave pública em 3.1) — ver `backend-v2.md` §25.4 regra 7 para a permissão que faltava e para a regra geral.
**Estados:** salvo automaticamente com toast "Alterações salvas" (debounce ~800ms após parar de digitar) — sem botão "Salvar" separado, consistente com a natureza local-first (não há "enviar pro servidor").
**Navegação:** aberta pelo nome da comunidade no cabeçalho da lista de canais → "Configurações da comunidade", ou pelo menu de contexto do ícone da comunidade no rail.
**Responsividade:** mesma regra de 3.1.

### 3.2 Gestão de cargos e permissões

**Objetivo:** criar/editar cargos, definir permissões e hierarquia, atribuir cargos a membros.
**Layout:** tab dentro de Configurações da comunidade; lista de cargos à esquerda (~240px, ordenada por hierarquia, arrastável pra reordenar) + editor do cargo selecionado à direita.
**Estrutura do editor:** nome do cargo (1-32 caracteres), seletor de cor (as 7 opções curadas de `role-*`, §5.4 — não é color-picker livre), toggle "Mencionável" (permite `@cargo`), checklist de permissões agrupada por categoria (**Geral**: gerenciar comunidade, gerenciar canais, ver log de auditoria; **Texto**: enviar mensagens, anexar arquivos, adicionar reações, mencionar @everyone, fixar mensagens, gerenciar mensagens; **Voz**: falar, silenciar outros, compartilhar tela; **Moderação**: convidar pessoas, expulsar, banir, aplicar timeout, gerenciar cargos), aba secundária "Membros com este cargo" (lista + botão remover).
**Conteúdo mockado:** os 4 cargos do dataset (§2) — Fundador (todas as permissões, não-editável/não-deletável, sempre no topo), Moderador, Contribuidor, Membro (cargo padrão, não pode ser deletado, mas permissões são editáveis).
**Ações:** criar cargo ("+ Novo cargo"), editar nome/cor/permissões/hierarquia, deletar cargo (exceto Fundador e Membro), atribuir/remover membro de um cargo (pelo popover de perfil 1.4 ou por aqui).
**Regra de hierarquia (aplicada em toda a spec, não só aqui):** um membro só pode gerenciar cargos, expulsar, banir ou aplicar timeout em outro membro cujo cargo de maior hierarquia esteja **abaixo** do seu próprio. Nunca em cargo igual ou superior. O Fundador/host nunca pode ser alvo de nenhuma ação de moderação.
**A tela não oferece o que o núcleo já recusa (emenda de 2026-09-06, §20.3 regra 8 de `backend-v2.md`).** Concretamente, nesta aba:
- **Cargo com hierarquia igual ou superior à do autor** abre em modo leitura: nome, cor, mencionabilidade, permissões, "Deletar cargo" e os controles de reordenar ficam **desabilitados com o motivo dito** ("Este cargo está acima do seu na hierarquia"). Desabilitado e não escondido porque o cargo em si é informação legítima — quem administra precisa ver que ele existe e o que ele concede.
- **Cargo Fundador** é imutável em **todo** campo, não só nome e cor: mencionabilidade e permissões também. Motivo dito: "O cargo Fundador não é editável".
- **Cargo base** não oferece as 11 permissões que `R-11` proíbe (gerenciar comunidade/canais/cargos/mensagens, banir, expulsar, timeout, mencionar @everyone, ver log de auditoria, silenciar outros, convidar pessoas): as caixas ficam desabilitadas com o motivo ("O cargo base é de todo mundo — permissão de gestão ou moderação nele valeria para a comunidade inteira"). Desabilitadas, não escondidas: o checklist é o catálogo, e sumir com metade dele faria parecer que a permissão não existe.
- **Permissão que o autor não tem** não é concedível a ninguém (`R-5`): a caixa fica desabilitada com o motivo ("Você não tem esta permissão"). O Fundador tem as 17 e não vê nenhuma desabilitada por este motivo.
- **Reordenar** só alcança as posições estritamente abaixo do topo do autor, e o **cargo base** não se move: ele é o piso fixo da hierarquia.
- **Aba "Membros com este cargo"**: "Remover" some para membro que o autor não pode moderar (Fundador, host corrente, ou hierarquia igual/superior) — aqui é ação de moderação, então vale a regra de esconder de §15.
- **Atribuir cargo pelo popover de perfil (1.4)**: a lista oferece só cargos estritamente abaixo do topo do autor, e o **cargo base nunca sai** do conjunto enviado (`R-3` — remover o base é recusado).
**Estados:** salvo automaticamente (mesmo padrão de 3.1b) · conflito ao tentar deletar cargo com membros (confirmação: "Este cargo tem 12 membros. Remover o cargo, não os membros?") · tentativa de reordenar cargo pra cima do próprio (bloqueado, tooltip explicando).
**Navegação:** tab dentro de Configurações da comunidade.
**Responsividade:** Mobile → lista de cargos e editor viram duas telas sequenciais (lista → seleciona → editor tela cheia → voltar).

### 3.3 Ferramentas de moderação

**Objetivo:** dar visibilidade e controle sobre ações de moderação já tomadas — escopo deliberadamente **por-comunidade, via cargos**, não um sistema de reputação global (`CLAUDE.md:49` marca "moderação em escala sem autoridade central" como problema em aberto, não resolvido).
**Layout:** tab dentro de Configurações da comunidade, com sub-tabs: **Log de auditoria** / **Banidos** / **Timeouts ativos**.
**Estrutura — Log de auditoria:** lista cronológica reversa, cada linha com ícone por tipo de ação, descrição ("Bianca Souza baniu `Usuário#4471`"), motivo (se informado), responsável, timestamp relativo; filtros por tipo de ação, por responsável, por intervalo de data.
**Estrutura — Banidos:** lista de identidades banidas (identificador truncado — não há e-mail/nome real garantido em P2P), quem baniu, quando, motivo; ação "Revogar banimento" por linha; **nota de honestidade fixa no topo da tela** (não é um tooltip escondido): "Banir impede a entrada com esta identidade específica. Como não há autoridade central, a pessoa pode tecnicamente voltar com uma identidade nova através de outro convite."
**Estrutura — Timeouts ativos:** lista com contagem regressiva de tempo restante, ação "Remover timeout" por linha.
**Conteúdo mockado:** entrada de log "Bianca Souza baniu `Usuário#4471` — motivo: spam de link — há 2 dias"; entrada "Rafael Mendes criou o cargo Contribuidor — há 3 semanas"; nenhum timeout ativo no momento (estado vazio ilustrado abaixo).
**Ações:** filtrar log, revogar banimento, remover timeout.
**Estados:** log vazio ("Nenhuma ação de moderação registrada ainda") · lista de banidos vazia · lista de timeouts vazia · carregando (skeleton).
**Navegação:** tab dentro de Configurações da comunidade; visível para quem tem `view_audit_log`, `ban_members` **ou** `timeout_members` (emenda de 2026-09-06 — §15.6 de `backend-v2.md` dá a `ban_members` e a `timeout_members` a leitura da sua própria lista, e gatear a aba só por `view_audit_log` deixava sem caminho quem tem a permissão de escrita).
**Gating dentro da aba (emenda de 2026-09-06):** cada sub-tab aparece pela permissão da **sua** consulta — "Log de auditoria" com `view_audit_log`, "Banidos" com `view_audit_log` ou `ban_members`, "Timeouts ativos" com `view_audit_log` ou `timeout_members`. E o botão de ação de cada linha depende da permissão de **escrita**, não da de leitura: "Revogar banimento" exige `ban_members`, "Remover timeout" exige `timeout_members`. Quem só tem `view_audit_log` lê as três listas e não vê botão nenhum — ação de moderação sem permissão **some** (§15).
**Responsividade:** Mobile → sub-tabs viram um seletor no topo (dropdown) em vez de tabs horizontais, pra caber a largura.

### 3.4 Gestão de canais e categorias

**Objetivo:** criar, editar, mover e remover canais e categorias. Visível só para quem tem `gerenciar canais` (host sempre tem) — a permissão já existe no checklist de 3.2 desde a primeira versão desta spec; esta tela é o que ela finalmente controla.

**Onde vive:** ao contrário de 3.1b, 3.2 e 3.3, **não é uma tab de "Configurações da comunidade"**. A lista de canais (1.1) já é a representação da árvore de canais; recriá-la dentro de um modal de configurações seria manter duas árvores em sincronia sem ganho nenhum. A gestão acontece in loco, na própria lista, e o detalhe abre em modal — mesmo padrão do popover de perfil (1.4): vários gatilhos, um destino.

**Layout:** modais de ~440px em `surface-elevated`, centralizados sobre scrim (§5.1), por cima do shell.

**Gatilhos (todos na lista de canais, 1.1 — nenhum aparece sem `gerenciar canais`):**
- **"+" no cabeçalho da lista**, ao lado da engrenagem que abre 3.1b → modal "Criar canal" sem categoria pré-selecionada.
- **"+" no header da categoria**, revelado no hover (Desktop/Tablet) ou sempre visível (Mobile, onde não há hover) → modal "Criar canal" com aquela categoria já escolhida.
- **Menu de contexto do item de canal** — botão direito, "⋯" no hover, ou long-press em Mobile → "Editar canal", divisor, "Excluir canal" (destrutiva por último, §15).
- **Menu de contexto do header da categoria** → "Criar canal aqui", "Renomear categoria", divisor, "Excluir categoria".
- **"+ Nova categoria"** no fim da lista, em `text-tertiary`, revelado no hover da lista.

**Estrutura — modal "Criar canal"** (formulário com botão explícito, §13):
- **Tipo** — segmented control Texto (`#`) / Voz (🔊), padrão Texto. Converter tipo depois de criado não existe (Apêndice A).
- **Nome** — obrigatório, 1-32 caracteres. Canal de **texto** normaliza pra slug ao vivo (minúsculas, acentos removidos, espaço → hífen, descarta o que não for `a-z0-9-`) com prévia sob o campo: "Vai aparecer como **#ajuda-design**". Canal de **voz** preserva o que foi digitado, com maiúsculas e espaços — é o que o dataset §2 mostra ("Sala de Estudos", não "sala-de-estudos").
- **Categoria** — select das categorias existentes, com "+ Nova categoria…" como última opção: escolhê-la troca o select por um campo de nome inline, em vez de empilhar um segundo modal sobre o primeiro.
- **Tópico** — opcional, até 120 caracteres, só para canal de texto (§2 não dá tópico a canal de voz).
- **Somente-leitura** — toggle, desligado por padrão. Ligado, revela a lista de cargos da comunidade com checkbox "pode postar", pré-marcando os que têm permissão de moderação. É exatamente como `#avisos` do dataset §2 existe, e é a **única permissão por-canal do v1** — não há canal privado nem canal oculto (Apêndice A).

**Estrutura — modal "Editar canal":** os mesmos campos exceto Tipo, com **salvamento automático** (debounce ~800ms + toast "Alterações salvas", §13 — mesmo padrão de 3.1b e 3.2) e uma zona de perigo no fim com "Excluir canal", igual à de 3.1b. Trocar a categoria aqui é como um canal se move entre categorias, já que não há arrasto (Apêndice A).

**Estrutura — "Renomear categoria":** modal mínimo de um campo (1-32 caracteres) com botão explícito. Categoria não tem nada além do nome no modelo (§2).

**Confirmações destrutivas** (§15 — cada uma nomeia a consequência exata, nunca "Tem certeza?"):
- **Excluir canal de texto** — "Excluir #ajuda-frontend? As mensagens deste canal somem para todo mundo. Não pode ser desfeito." Acompanhada da nota de honestidade P2P, no mesmo espírito da nota de banimento de 3.3 (princípio 3): "Quem estiver offline agora só vê o canal sumir ao reconectar — até lá, a réplica local dessa pessoa ainda tem as mensagens."
- **Excluir canal de voz com gente dentro** — a confirmação conta quem está: "3 pessoas estão em Sala de Estudos agora. Excluir tira todas da chamada."
- **Excluir categoria** — dois caminhos no mesmo modal, mesmo padrão do "Remover o cargo, não os membros?" de 3.2: "Mover os N canais para «select de categoria»" (primária, padrão) ou "Excluir a categoria e os N canais" (destrutiva). Categoria vazia é excluída direto, sem modal — destrutivo de baixo custo (§15).

**Regra do último canal:** a comunidade nunca fica sem nenhum canal (§7, 0.4). Excluir o último é bloqueado — o item some do menu de contexto e a zona de perigo do modal de edição mostra o motivo no lugar do botão: "Toda comunidade precisa de pelo menos um canal".

**Conteúdo mockado:** Ana é Contribuidora em Vale do Código e **não tem** `gerenciar canais` — nenhum "+" nem item de menu aparece pra ela ali (ocultar-não-desabilitar, §15). Dois caminhos exercitam a tela: **Clã Noturno**, onde Ana é host (§2), criando `#regras` na categoria GERAL; e **Vale do Código** com o afinador de cargo (§19.1) assumindo Moderador, mesma saída que o fluxo D12 já usa para o ban.

**Ações:** criar canal (texto ou voz), editar nome/tópico/somente-leitura, mover canal de categoria, excluir canal, criar categoria, renomear categoria, excluir categoria.

**Registro no log de auditoria:** criar e excluir canal ou categoria entram no log de 3.3, como já acontece com cargos ("Rafael Mendes criou o cargo Contribuidor", §2). O log é da comunidade, não só de punições.

**Estados:**
- Campos nos estados padrão de formulário (§13) · **nome duplicado** na mesma comunidade → erro inline no blur ("Já existe um canal #ajuda-design nesta comunidade") · **nome que normaliza pra vazio** (ex.: só emoji num canal de texto) → "Use ao menos uma letra ou número".
- **Criando** → botão em loading (§6). **Criado** → o canal aparece na lista, vira o canal ativo e o composer recebe foco, com o empty state de 2.1 ("Este é o início de #ajuda-design"). Sem toast: o resultado visível já é a confirmação (§12).
- **Host offline** (ex.: Ateliê Aberto) → gatilhos ficam **visíveis e desabilitados**, com tooltip "Ateliê Aberto está offline — a estrutura de canais só muda com o host conectado". Exceção deliberada à regra de ocultar-não-desabilitar de §15: lá o motivo é permissão (a ação não é sua), aqui é estado de rede transitório (a ação é sua, o momento é que não é) — esconder faria parecer que a permissão sumiu.
- **Canal ativo excluído** → navega pro primeiro canal de texto da comunidade, com toast "#ajuda-design foi excluído".

**Navegação:** modais abrem sobre o shell e fecham com `Esc`, clique no scrim ou botão explícito — com pedido de descarte quando o formulário de criação já tem texto (§6). Nenhum gatilho sai da lista de canais; não há rota nem tab nova.

**Responsividade:** **Tablet** igual a Desktop. **Mobile** menu de contexto por long-press (não há botão direito nem hover), "+" da categoria sempre visível em vez de revelado no hover, e modais em tela cheia com "fechar" explícito (§16).

### 3.5 Aviso de saída do host

**Objetivo:** impedir que quem hospeda derrube a comunidade sem perceber. §3 lista este estado transversal desde a primeira versão da spec ("host prestes a fechar o app com pessoas conectadas → aviso ativo") e nunca o especificou — é o estado mais próprio deste produto que existe, porque aqui o "servidor" é a janela que alguém está prestes a fechar.

**Quando aparece:** Ana hospeda ao menos uma comunidade **e** há gente conectada nela (membros online sincronizando, ou qualquer chamada de voz em andamento) **e** ela dispara o fechamento do app — botão de fechar da janela/aba, `Cmd/Ctrl+W`, "Sair" do menu do sistema. Nunca aparece se ninguém está conectado: fechar o app sozinha é rotina, não evento.

**Layout:** modal de confirmação (§6, ~420px) sobre scrim, com o app ainda funcionando por trás — não é uma tela de despedida.

**Estrutura:** título "Fechar o app desconecta 12 pessoas" — quando o impacto é só uma chamada e ninguém mais está online, o título nomeia a chamada em vez de exibir um zero ("Fechar o app encerra a chamada de voz"); um card por comunidade hospedada, com o ícone dela, o nome e as contagens em linha, cada uma com seu ícone e **só quando maior que zero** (👤 "12 pessoas online" · 🔊 "3 em chamada", esta em `conn-degraded`, porque perder uma chamada é mais brusco que perder sincronia); nota de honestidade fixa, no espírito do princípio 3, sobre a superfície de aviso de §6 (tom lavado a 10-15%, nunca uma caixa cinza igual à do card acima): "Enquanto seu dispositivo estiver fechado, ninguém envia novas mensagens nesta comunidade — só leem o que já sincronizaram."

**Nenhuma contagem inclui quem está fechando.** O custo do fechamento é o que ele faz com os outros; contar-se junto produzia "0 pessoas online, 1 numa chamada de voz" — a chamada em que a própria pessoa estava sozinha, oferecida a ela como motivo para não fechar o app.

**Botões:** a ação opcional ("Avisar quem está online") sai da fileira de decisão e fica sozinha acima dela, largura inteira — enfileirada com as outras duas, tinha o mesmo peso do par que decide o fechamento e as três juntas quebravam a linha. Abaixo, separados por divisor, "Cancelar" (primário, foco inicial — a ação segura é a padrão) e "Fechar mesmo assim" (`feedback-danger`, por último, como nos outros diálogos de §15).

**Conteúdo mockado:** Ana hospeda Clã Noturno (§2, 58 membros); o aviso conta 12 online e a chamada de `Sala de Estudos` de 2.3 quando ela existe.

**Ações:** cancelar (volta ao app, nada muda) · fechar mesmo assim · **"Avisar quem está online"** (ação secundária, opcional): posta uma mensagem de sistema no canal padrão de cada comunidade afetada — "Ana Torres vai ficar offline; a comunidade fica em modo leitura até ela voltar" — antes de fechar. Sem isso, quem está do outro lado só descobre pelo banner de host offline (B4), depois do fato.

**Estados:** nenhum host / ninguém conectado → o aviso **não aparece**, fecha direto · uma comunidade afetada · várias comunidades afetadas (lista, uma linha cada) · chamada de voz em andamento (a contagem separa "N online, M em chamada" — perder uma chamada é mais brusco que perder sincronia).

**Limitação declarada:** num app web o navegador não deixa customizar o diálogo de saída nem garantir que ele apareça — o mock representa a decisão de produto, e a versão empacotada (premissa 1, Electron/Tauri/Bare) é que consegue cumpri-la de verdade. Documentado aqui em vez de fingir que o browser coopera.

> **Emenda de 2026-08-26 (§92) — os dois guardas não se somam, e empilhá-los travava o app.**
> No navegador, `beforeunload` com `preventDefault` faz o browser **perguntar**, e quem
> decide é a pessoa. No Electron não há pergunta: o `preventDefault` **veta o fechamento em
> silêncio**, indefinidamente. Enquanto os dois estavam ligados ao mesmo tempo, o guarda de
> web vetava a saída que o guarda de Electron — o main segurando o `close` e perguntando o
> impacto — tinha acabado de conceder, e nem "Fechar mesmo assim" escapava.
>
> O gatilho era exatamente a condição desta tela: **hospedar com gente conectada**. Sem
> ninguém online o `beforeunload` nem era registrado, e por isso o smoke de 2026-08-23
> passou. A regra passa a ser: **com shell, o guarda é o do shell**; o `beforeunload` só
> vale fora do Electron, onde é a única defesa que existe.
>
> "Cancelar" também passou a cancelar de verdade: o prazo de 10 s que o main mantinha para
> o caso de silêncio do renderer fechava a janela por trás de quem tinha acabado de
> desistir, e o guarda ficava gasto — o fechamento seguinte passava sem perguntar nada.

**Responsividade:** Mobile → modal em tela cheia (§16); o gatilho equivalente é o app ir pra segundo plano por tempo prolongado, não o fechamento imediato da aba.

## 11. User flows

15 fluxos priorizados em 4 tiers (Fundacionais → Diferenciador P2P → Uso diário → Administrativo). Formulários simples de uma tela só (ex.: editar dispositivo de áudio) não têm fluxo dedicado — estão cobertos na spec da própria tela.

### Tier A — Fundacionais

#### A1. Criar identidade local

**Entrada:** primeira abertura do app, nenhuma identidade local existe, rota `/`.
**Sequência e resposta da interface:**
1. App detecta ausência de identidade → renderiza Onboarding (0.1) direto, sem flash de outra tela.
2. Ana digita "Ana Torres" → contador de caracteres atualiza, botão primário habilita.
3. Ana clica "Gerar outra cor" (opcional) → avatar muda instantaneamente, sem chamada assíncrona.
4. Ana clica "Criar identidade" → botão entra em loading (~600ms, simula geração do par de chaves).
5. Identidade salva (Zustand + `persist`) → transição `duration-slow` para o Hub vazio (0.2).
**Estados intermediários:** vazio → preenchendo → confirmando (loading) → sucesso.
**Resultado final:** identidade local persistida; Hub vazio exibido.
**Exceções:** nome só com espaços → erro inline em vez de submeter; tentativa de Enter com campo inválido → mesmo erro inline, sem navegar.

#### A2. Entrar via convite + preview

**Entrada:** "Entrar com convite" (Hub vazio ou "+" do rail) **ou** URL direta `/invite/x7K2qM` aberta fora do app.
**Sequência e resposta da interface (caminho mais complexo — chegada por link, sem identidade ainda):**
1. App abre em `/invite/x7K2qM`, verifica identidade local — não existe.
2. Guarda o código pendente em Zustand (a URL já foi consumida) → redireciona pro fluxo A1.
3. Ao concluir A1, retoma automaticamente: abre 0.3 já no Passo 2 (preview), sem exigir colar o código de novo.
4. Preview resolve (skeleton ~400ms) → "Vale do Código, 340 membros, convite de Rafael Mendes".
5. Ana clica "Entrar em Vale do Código" → loading ~800ms → shell (1.1) abre na comunidade nova, primeiro canal de texto da primeira categoria.
**Estados intermediários:** sem identidade → onboarding → preview resolvendo → preview pronto → entrando → dentro da comunidade.
**Resultado final:** Ana é membro de Vale do Código.
**Exceções:** código inválido/expirado (erro, botão desabilitado) · Ana banida (preview reduzido, sem contagem/convidador, só "Cancelar") · Ana já é membro (atalho "Ir para a comunidade") · convite revogado entre o clique e o carregamento (mesmo tratamento do inválido).

#### A3. Criar comunidade / virar host

**Entrada:** "Criar uma comunidade" (Hub vazio) ou "+" no rail a qualquer momento.
**Sequência e resposta da interface:**
1. Abre modal 0.4.
2. Ana preenche nome "Clã Noturno", ícone 🎮, descrição opcional.
3. Aviso fixo sobre depender da própria máquina fica sempre visível (não é dispensável, não é tooltip escondido).
4. Ana clica "Criar e virar host" → loading ~600ms.
5. Toast "Clã Noturno criada — você é o host" → shell abre na comunidade nova, pré-populada com categoria "GERAL" + canal `#geral`, cargo "Fundador" atribuído a Ana automaticamente.
**Estados intermediários:** preenchendo → validando → criando → sucesso.
**Resultado final:** nova comunidade no rail; `connectionHealth.hostStatus = online` (é a própria máquina de Ana).
**Exceções:** nome vazio/só espaços (erro inline) · nome duplicado entre comunidades de Ana (aviso não-bloqueante — não há unicidade global em P2P, então é só um alerta de confusão visual, não impede criar).

### Tier B — Diferenciador P2P (maior risco de design, sem precedente direto no Discord)

#### B4. Comunidade com host offline → modo cache + reconexão

**Entrada:** Ana clica no ícone de "Ateliê Aberto" no rail (host Bianca, `hostStatus = offline` no dataset).
**Sequência e resposta da interface:**
1. Shell abre a comunidade → banner no topo da área de conteúdo: "Ateliê Aberto está offline — mostrando histórico salvo neste dispositivo" (`conn-offline`, cinza, sem animação — estado estável, não transitório).
2. Canais e histórico carregam normalmente a partir da réplica local — sem skeleton infinito nem erro, o cache é dado válido.
3. Composer permanece habilitado; mensagens enviadas ganham ícone de relógio ("pendente — será enviada quando Ateliê Aberto voltar") em vez de check de entregue.
4. (Assíncrono) Host volta a ficar online → banner muda pra "Reconectando…" (`conn-reconnecting`, com pulse) brevemente → some; mensagens pendentes trocam o ícone de relógio por enviado.
**Estados intermediários:** offline (estável) → reconectando (transitório, com motion) → online (banner some).
**Resultado final:** Ana navegou/leu tudo que já sincronizou; mensagens enviadas offline chegam quando o host reconecta.
**Exceções:** Ana tenta entrar em canal de voz com host offline → bloqueado com mensagem clara ("Voz precisa que o host esteja online") em vez de tentar e falhar silenciosamente · busca nessa comunidade mostra o banner de resultado incompleto (§8, 1.2) · **Ana fecha e reabre o app com mensagens ainda pendentes** → a fila é durável (premissa 5): as mensagens reaparecem no canal com o mesmo ícone de relógio, na posição cronológica em que foram escritas, e o banner do canal soma a contagem ("Ateliê Aberto está offline — 2 mensagens suas aguardando envio"). Uma fila que evapora ao reabrir transformaria "será enviada quando o host voltar" em mentira.

#### B5. Compartilhar tela — estrela → árvore → reparo

**Entrada:** Rafael (apresentador) já está no canal de voz `Sala de Estudos` e clica "Compartilhar tela". Fluxo documentado do ponto de vista de Ana, espectadora.
**Sequência e resposta da interface:**
1. Tile de Rafael muda pra "Preparando compartilhamento…" (~1s).
2. Compartilhamento ativo, badge "Transmissão direta" (ícone de estrela) — 3 espectadores (≤5).
3. Mais pessoas entram; ao ultrapassar 5, badge transiciona: "Otimizando distribuição…" (~1-2s) → "Retransmissão em árvore" (ícone de nós).
4. Se a conexão de Ana for elegível, ela recebe o modal de consentimento de repasse (B6) neste momento.
5. Um nó intermediário cai (simulado) → espectadores afetados veem banner "Reorganizando transmissão…" (`conn-reconnecting`) por alguns segundos, com buffer breve em vez de congelamento sem explicação.
6. Árvore se reorganiza → banner some, vídeo normal.
7. Rafael clica "Parar compartilhamento" → tile volta ao normal pra todos.
**Estados intermediários:** iniciando → estrela → transicionando → árvore → reparando → árvore estável → encerrado.
**Resultado final:** espectadores voltam a ver normalmente após o reparo; Rafael controla início/fim.
**Exceções:** Rafael tem NAT/CGNAT que impede até o fallback TURN → espectadores veem "Falha ao conectar à transmissão" (distinto de "carregando"), com "Tentar novamente" · Ana entra depois que já está em modo árvore há tempo → entra direto em árvore, sem ver a transição (só quem já assistia quando ela ocorreu vê a animação).

#### B6. Consentimento de retransmissão de upload do espectador

**Entrada:** consequência do B5 (passo 3-4) — a árvore precisa de mais um nó intermediário e Ana é candidata.
**Sequência e resposta da interface:**
1. Modal 2.4.1 aparece sobre o canal de voz de Ana, sem pausar áudio/vídeo por trás.
2. Ana lê "Sua conexão pode retransmitir esta transmissão para outras 2 pessoas, usando um pouco do seu upload. Isso não afeta sua visualização."
3a. Ana clica "Aceitar" → modal fecha, badge "Você está retransmitindo para 2 pessoas" aparece no tile do compartilhamento.
3b. Ana clica "Recusar" → modal fecha, nada muda pra ela; a árvore busca outro nó (fora de vista).
4. Se Ana marcou "Lembrar minha escolha para esta comunidade", a escolha fica salva localmente e o modal não reaparece nesta comunidade — sem tela dedicada de gerenciar isso no v1, só o texto do próprio modal confirmando que foi salvo.
**Estados intermediários:** aguardando resposta → decidido.
**Resultado final:** participação de Ana na árvore reflete sua escolha, sem tom de culpa no texto em caso de recusa.
**Exceções:** app em segundo plano/aba inativa quando o modal apareceria → espera até Ana voltar a focar a aba, nunca assume "recusa" por inatividade/timeout.

#### B7. Entrar em canal de voz — mesh parcial

**Entrada:** Ana clica em `Sala de Estudos` na sidebar.
**Sequência e resposta da interface:**
1. Ana entra imediatamente (sem tela de "pedido pra entrar" — voz é livre pra quem tem `voice_speak`).
2. Tiles dos participantes já presentes aparecem com skeleton breve (~500ms) enquanto o mesh estabelece conexão individual com cada peer.
3. Conexão com Rafael e Diego estabelece normalmente. Conexão com Bianca falha (simulado) → tile dela mostra ícone de sinal fraco + "Sem conexão com você" — assimétrico, não derruba a chamada toda (Bianca segue normal pros outros).
4. Painel da chamada aparece na base da coluna da esquerda, acima da barra de usuário.
**Estados intermediários:** conectando → parcialmente conectado (com falha pontual) → estável.
**Resultado final:** Ana ouve/fala com quem conectou e sabe explicitamente que não está ouvindo Bianca, em vez de achar que ela está calada.
**Exceções:** falha total (nenhum peer conecta) → banner "Não foi possível conectar à chamada de voz" com "Tentar novamente", em vez de grade vazia sem explicação.

#### B8. Download de arquivo estilo torrent

**Entrada:** Ana abre `#geral` e vê o card do anexo `aula-webrtc-completa.mp4` (1.24 GB, 62% baixado — estado inicial do dataset).
**Sequência e resposta da interface:**
1. Card mostra nome, tamanho, barra de progresso (62%), "3 peers + host disponíveis".
2. Progresso avança automaticamente (ou por clique em "Baixar", se ainda não iniciado).
3. Progresso chega a 100% → card muda pra "Baixado", ação "Abrir"/"Mostrar na pasta" (mock: só ícone, sem ação real de SO), indicador discreto "Disponibilizando para outros" (seeding automático, sem ação explícita de Ana).
**Estados intermediários:** não iniciado → baixando (X%, Y peers) → concluído (seedando).
**Resultado final:** arquivo "baixado" localmente; Ana passa a ser peer disponível pra outros.
**Exceções:** zero peers e host offline → "Indisponível no momento — nenhum peer com este arquivo está online" em vez de progresso travado em 0% · peer específico desconecta no meio → progresso continua a partir dos restantes ("1 peer desconectou, continuando com 2"), sem reiniciar do zero.

> **Emenda de 2026-08-27 — o download é sob demanda; receber a mensagem não baixa nada.**
> O passo 2 estava sendo lido como "o card pede o download ao montar", e o efeito era que
> toda pessoa com o canal aberto começava a puxar o arquivo assim que a mensagem chegava.
> Isso gasta banda e disco de quem não pediu nada, e num anexo de 1,24 GB o custo é de
> cada membro da comunidade ao mesmo tempo — o oposto do que a distribuição estilo torrent
> deveria oferecer.
>
> O passo 2 passa a ser explícito: **nenhum `blob.download` sai sem clique**. O card em
> repouso mostra nome, tamanho e uma ação — "Baixar", ou "Retomar download" quando já há
> bytes de uma sessão anterior (o Hypercore retoma pelo bitfield, §13.4), ou "Baixar
> novamente" depois de um cancelamento. Barra de progresso, contagem de peers e "Cancelar"
> existem **enquanto** o download desta sessão está em voo, e é o pedido em voo — não o
> percentual — que decide qual dos dois o card mostra: progresso parado sem job por trás
> era exatamente o "travado em 0%" que as exceções deste fluxo proíbem.
>
> Segue valendo o que não depende do gatilho: peers/host vêm do bitfield vivo (§15.6.1) e
> só significam algo durante um download; o seeding pós-conclusão continua automático e
> sem ação de Ana; e o anexo da própria bolha nasce em 100% porque o autor já tem o
> arquivo (§13.1).

### Tier C — Uso diário (padrão conhecido, mas com estados específicos)

#### C9. Enviar mensagem + anexar arquivo

**Entrada:** Ana está em `#geral`, clica no composer.
**Sequência e resposta da interface:**
1. Ana digita texto com markdown (`**importante**`) — sem preview WYSIWYG, renderiza só depois de enviado.
2. Ana clica em anexar → seletor de arquivo do SO (mock simula escolha) → chip de anexo acima do composer (nome + tamanho + "x" pra remover).
3. Ana pressiona Enter → mensagem aparece na lista com opacidade reduzida ("enviando") + barra de progresso pequena no chip.
4. Confirmação (~800ms) → opacidade normal, progresso do anexo desaparece.
**Estados intermediários:** digitando → anexo adicionado → enviando → enviado.
**Resultado final:** mensagem visível pra todos; anexo vira card de download pros demais (ver B8).
**Exceções:** anexo acima do teto ilustrativo (ex. 8GB) → erro inline "Arquivo muito grande" antes de tentar enviar · canal em modo cache offline → mensagem entra na fila (ver B4).

#### C10. Buscar histórico com filtros

**Entrada:** Ana pressiona `Cmd/Ctrl+K` de dentro de Vale do Código.
**Sequência e resposta da interface:**
1. Painel de busca (1.2) abre, foco automático no campo.
2. Ana digita "revisar" → resultados após debounce, agrupados por tipo, mensagem de Bianca em destaque.
3. Ana adiciona filtro "Autor: Bianca Souza" (chip) → lista restringe.
4. Ana clica no resultado → painel fecha, `#geral` abre com scroll automático até a mensagem, que recebe highlight breve.
**Estados intermediários:** digitando → resultados → filtrado → navegado.
**Resultado final:** Ana está no canal certo, na mensagem certa.
**Exceções:** busca em comunidade com host offline → banner de resultado incompleto (§8, 1.2) · sem resultados → estado vazio com sugestão "Tente remover um filtro".

#### C11. Persistência de chamada de voz ao trocar de canal/comunidade

**Entrada:** Ana está em `Sala de Estudos` (voz) e clica em `#ajuda-frontend` (texto, mesma comunidade).
**Sequência e resposta da interface:**
1. Área de conteúdo troca pra `#ajuda-frontend` normalmente — a chamada **não** é encerrada.
2. Painel da chamada continua visível ("🔊 Sala de Estudos · Vale do Código", sair, câmera e tela) — o nome da comunidade aparece justamente porque Ana está olhando outra.
3. Ana clica noutra comunidade no rail (ex.: Ateliê Aberto) → chamada continua ativa mesmo trocando de comunidade (sessão de voz é independente da navegação).
4. Ana clica na própria barra → expande de volta pra grade de participantes (2.3) por cima do conteúdo atual, sem perder o canal de texto por trás.
**Estados intermediários:** voz ativa + navegando texto → voz ativa em comunidade diferente → voz expandida sobre o conteúdo.
**Resultado final:** Ana navega livremente enquanto conversa, volta pra chamada quando quiser.
**Exceções:** Ana clica "Sair" na barra persistente enquanto compartilha tela → confirmação ("Você está compartilhando sua tela. Sair também encerra o compartilhamento?"); sem compartilhamento ativo, sai direto sem confirmação.

### Tier D — Administrativo (menor originalidade, exceções específicas)

#### D12. Moderação rápida + log de auditoria

**Entrada:** Bianca Souza (Moderador) clica com o botão direito numa mensagem de spam de `Usuário#4471` em `#geral`.
**Sequência e resposta da interface:**
1. Menu de contexto mostra, além das ações padrão, "Deletar mensagem" e "Banir Usuário#4471" (Bianca tem permissão e hierarquia superior ao alvo).
2. Bianca clica "Banir" → modal de confirmação (nunca ação de um clique só): nome do alvo, campo opcional "Motivo", e **duas** notas de honestidade fixas, ambas obrigatórias: a de §10, 3.3 ("a pessoa pode tecnicamente voltar com identidade nova…") e a de `L-7` (§6.12 de `backend-v2.md`), que a spec do núcleo obriga a UI a dizer **no modal de ban** e que faltava aqui (emenda de 2026-09-06): o ban impede a replicação **futura**, mas **não retira do alvo o que ele já replicou para a máquina dele**.
3. Bianca confirma → toast "Usuário#4471 foi banido" · mensagens dele são removidas do canal · entrada nova aparece no log de auditoria (3.3) em tempo real.
**Estados intermediários:** menu aberto → confirmando → processando (~500ms) → concluído.
**Resultado final:** `Usuário#4471` não entra mais em Vale do Código com esta identidade; ação registrada e visível pra outros Moderadores+.
**Exceções:** Ana (Contribuidor, sem permissão) vê o mesmo menu **sem** as opções de moderação (item nem aparece — nunca aparece desabilitado, pra não sugerir uma ação inacessível) · tentativa de banir alguém com cargo igual/superior → ação nem aparece no menu, pela regra de hierarquia (§10).

#### D13. Gestão de cargos e permissões

**Entrada:** Rafael (Fundador) abre Configurações da comunidade → aba Cargos (3.2) → "+ Novo cargo".
**Sequência e resposta da interface:**
1. Editor abre em branco: nome vazio, cor não selecionada (obrigatório escolher uma das 7), nenhuma permissão marcada.
2. Rafael digita "Revisor de Design", escolhe `role-pink`, marca "Enviar mensagens", "Adicionar reações", "Fixar mensagens".
3. Salva automaticamente (mesmo padrão debounce de 3.1b) → toast discreto "Cargo criado".
4. Rafael arrasta o novo cargo pra posição entre "Contribuidor" e "Membro" na lista.
5. Rafael vai ao popover de perfil (1.4) de um membro → "Atribuir cargo" → seleciona "Revisor de Design".
**Estados intermediários:** criando → salvo → reordenando → atribuindo.
**Resultado final:** novo cargo existe, posicionado corretamente na hierarquia, com ao menos um membro atribuído.
**Exceções:** tentativa de arrastar acima de "Fundador" → bloqueado (Fundador é sempre topo, posição fixa) · tentativa de deletar o cargo padrão "Membro" → bloqueado ("Todo membro precisa de um cargo base").

#### D14. Criar um canal de texto

**Entrada:** Rafael (Fundador) passa o mouse no header da categoria TEXTO em Vale do Código e clica no "+" que aparece.
**Sequência e resposta da interface:**
1. Modal "Criar canal" (§10, 3.4) abre com Tipo = Texto e Categoria = TEXTO já preenchida.
2. Rafael digita "Ajuda Design" → a prévia sob o campo acompanha em tempo real: "Vai aparecer como #ajuda-design".
3. Preenche o tópico "Críticas e revisões de interface", deixa Somente-leitura desligado e clica "Criar canal" (botão entra em loading).
4. Modal fecha · `#ajuda-design` aparece **no fim** da categoria TEXTO (ordem de criação, §14) · vira o canal ativo · composer focado · conteúdo mostra "Este é o início de #ajuda-design" (2.1) · entrada nova no log de auditoria (3.3).
**Estados intermediários:** preenchendo → validando → criando → canal ativo.
**Resultado final:** canal existe, é navegável e aceita mensagem imediatamente.
**Exceções:** Ana (Contribuidora, sem `gerenciar canais`) não vê o "+" em lugar nenhum · nome colidindo com canal existente → erro inline no blur e botão bloqueado · em Ateliê Aberto (host offline) o "+" aparece desabilitado com o motivo · escolher "+ Nova categoria…" no select cria categoria e canal na mesma confirmação · canal de **voz** pula o campo Tópico e mantém o nome como digitado.

#### D15. Excluir um canal com chamada acontecendo

**Entrada:** Rafael decide remover 🔊 Sala de Estudos — onde Rafael, Diego e Bianca estão conversando agora (§2).
**Sequência e resposta da interface:**
1. Botão direito no canal → menu de contexto com "Excluir canal" por último, depois do divisor (§15).
2. Modal de confirmação nomeia as duas consequências: "3 pessoas estão em Sala de Estudos agora. Excluir tira todas da chamada." mais a nota P2P sobre a réplica local de quem está offline (§10, 3.4).
3. Rafael confirma → a chamada encerra para todo mundo (o painel da chamada some, como em C11) · o canal some da lista · quem estava com ele aberto cai no primeiro canal de texto · entrada no log de auditoria.
**Estados intermediários:** menu aberto → confirmando → processando (~500ms) → concluído.
**Resultado final:** canal não existe mais e ninguém fica preso numa chamada órfã.
**Exceções:** se fosse o último canal da comunidade, "Excluir canal" nem aparece (regra do último canal, §10 3.4) · quem não tem `gerenciar canais` não vê o item · excluir o canal de voz onde a **própria Ana** está a desconecta junto, sem tratamento especial · excluir um canal de texto troca a contagem de participantes por "As mensagens deste canal somem para todo mundo".

## 12. Estados transversais (catálogo de referência)

Padrão geral por trás das variações já listadas em cada tela (§7-10) — mantém consistência entre partes da spec escritas em momentos diferentes.

**Loading:** primeira carga de uma lista usa skeleton no formato do conteúdo real (nunca spinner de tela cheia depois da primeira renderização do shell). Ação pontual (enviar, confirmar, salvar) mostra loading no próprio controle que disparou, nunca um overlay bloqueando a tela inteira.

**Empty:** sempre com ícone/ilustração simples, uma frase explicando o motivo (nunca só "Nada aqui"), e uma ação primária quando existe uma óbvia. O texto sempre nomeia o que está faltando especificamente (canal, resultado de busca, cargo) — nunca um empty state genérico reaproveitado sem adaptar a frase.

**Error:** erro de validação de formulário é inline, junto ao campo, nunca só um toast genérico. Erro de ação (ex.: falha ao entrar em voz) é banner ou toast com ação de recuperação nomeada ("Tentar novamente"), nunca só "Algo deu errado".

**Success:** ação rápida (criar, salvar, copiar) usa toast discreto de 4s. Ação de consequência maior (banir, encerrar comunidade) não usa toast — o próprio resultado visível (item some da lista, membro banido não aparece mais) já é a confirmação, evitando redundância.

**Estados P2P-específicos (consolidado):**

| Estado | Cor / motion | Onde aparece |
|---|---|---|
| Host offline (cache) | `conn-offline`, estático | Rail (ícone opaco), banner de comunidade, busca, composer |
| Reconectando | `conn-reconnecting`, pulse | Banner de comunidade, reparo de árvore |
| Degradado (via TURN) | `conn-degraded`, estático | Badge de compartilhamento de tela |
| Falha total (NAT/CGNAT) | `conn-failed`, estático + ícone de alerta | Entrada em voz, compartilhamento de tela |
| Fila offline (mensagem pendente) | ícone de relógio, sem cor semântica dedicada | Linha de mensagem; contagem no banner do canal ao reabrir o app (premissa 5, B4) |
| Host prestes a sair (você hospeda) | `feedback-danger` no botão de confirmação, sem cor no corpo | Modal de saída (§10, 3.5) — único estado desta tabela disparado por **você**, não pela rede |

## 13. Formulários e validações

Validação inline, em tempo real onde é barato (contadores de caractere) e no blur/submit onde é caro (nomes duplicados). Formulários de **edição** (comunidade, cargo, canal) salvam automaticamente com debounce ~800ms, sem botão "Salvar" — consistente com não haver "enviar pro servidor" num produto local-first. Formulários de **criação** (identidade, comunidade, cargo, convite, canal, categoria) têm botão de ação explícito, porque criar é um passo discreto que o usuário espera confirmar.

| Formulário | Campos e regras |
|---|---|
| Criar identidade (0.1) | Nome: obrigatório, 2-32 caracteres, sem checagem de unicidade (não existe unicidade global em P2P) |
| Criar/editar comunidade (0.4, 3.1b) | Nome: obrigatório, 2-40 caracteres, aviso não-bloqueante se duplicado entre comunidades de Ana · Descrição: opcional, até 120 caracteres |
| Entrar via convite (0.3) | Código/link: obrigatório, validado de forma assíncrona (resolve ou erro) |
| Criar convite (3.1b) | Expiração: opcional (padrão "nunca") · Limite de usos: opcional (padrão "ilimitado"), inteiro ≥1 se preenchido |
| Criar/editar cargo (3.2) | Nome: obrigatório, 1-32 caracteres · Cor: obrigatório, uma das 7 curadas · Permissões: nenhuma obrigatória (cargo pode ser só decorativo) |
| Criar/editar canal (3.4) | Nome: obrigatório, 1-32 caracteres · em canal de texto vira slug ao vivo (`a-z0-9-`) e não pode normalizar pra vazio · duplicidade checada no blur, **bloqueante** dentro da mesma comunidade (diferente do nome de comunidade, onde duplicar só avisa — aqui o nome é o endereço do canal) · Tópico: opcional, até 120 caracteres, só em canal de texto · Categoria: obrigatória · Somente-leitura: desligado por padrão; ligado, exige ao menos um cargo com "pode postar" |
| Criar/renomear categoria (3.4) | Nome: obrigatório, 1-32 caracteres, duplicidade só avisa (categoria é rótulo visual, não endereço) |
| Apelido nesta comunidade (1.4) | Opcional, 1-32 caracteres; campo inline, salva no `Enter`, "Usar meu nome" limpa. Vazio ou só espaços = remover apelido, não erro — é o jeito natural de desfazer |
| Banir/expulsar/timeout (D12) | Motivo: opcional, até 200 caracteres, vai pro log de auditoria como texto livre |
| Editar mensagem | Mesmas regras da criação; não pode ficar vazia (esvaziar = usar "Deletar", não editar pra vazio) |

## 14. Busca, filtros, ordenação, paginação

- **Mensagens dentro de um canal:** sem paginação numerada — scroll infinito pra cima, carregando em lotes de ~50 conforme aproxima do topo já carregado.
- **Busca (1.2):** sem paginação visível — top ~20 resultados por grupo (Mensagens/Canais/Membros), com "Ver todos os resultados de mensagens" expandindo in-line (nunca navega pra outra tela).
- **Lista de membros (1.3):** sem paginação — agrupada por cargo, grupo "Offline" colapsado por padrão. Acima de ~200 membros num grupo expandido, a lista deve ser virtualizada (renderizar só linhas visíveis) — detalhe de implementação, não visível ao usuário.
- **Log de auditoria (3.3):** paginação por botão "Carregar mais" (lotes de 25), mais recente primeiro — nunca paginação numerada, é um feed, não uma tabela de referência. **"Carregar mais" busca o lote seguinte na fonte** (`nextCursor` de `query.auditLog`, §15.6 de `backend-v2.md`), não revela mais linhas de um array já carregado: o botão some quando a consulta responde sem `nextCursor`, e não antes (emenda de 2026-09-06). Os filtros de tipo/responsável continuam sendo aplicados sobre o que já veio; um filtro que não acha nada na página carregada não é "nada encontrado" enquanto houver mais páginas, e a tela diz isso.
- **Lista de banidos / timeouts (3.3):** mesma regra do log de auditoria.
- **Ordenação:** rail de comunidades = ordem de entrada/criação (não alfabética, não reordenável no v1). Canais dentro de categoria = ordem de criação — canal novo (3.4) entra **no fim** da sua categoria, e canal movido para outra categoria entra no fim da categoria de destino. Categorias = ordem de criação, categoria nova no fim da lista. Membros = agrupado por cargo/hierarquia, depois alfabético dentro do grupo.
- **Filtros:** busca (autor/canal/data/tipo, chips combináveis) e log de auditoria (tipo de ação/responsável/data) são os dois únicos pontos de filtro desta spec — ambos client-side sobre o dataset já carregado (o mock não simula filtro server-side).

## 15. Modais, menus de contexto e feedback

- **Toda ação destrutiva ou irreversível passa por modal de confirmação nomeando a consequência exata** — nunca um "Tem certeza?" genérico. Lista fechada de ações que exigem confirmação: sair de comunidade, encerrar comunidade (host), banir, expulsar, deletar mensagem de outro autor, deletar cargo, excluir canal, excluir categoria **que tenha canais dentro**, sair da identidade, fechar o app hospedando gente conectada (§10, 3.5).
- **Ações destrutivas reversíveis dentro da própria sessão** (deletar a própria mensagem, remover timeout, revogar convite) não pedem confirmação — baixo custo de engano, fáceis de refazer/entender.
- **Menu de contexto:** item aparece só se a permissão permite — nunca desabilitado-mas-visível para ações de moderação (ver D12). Itens sempre agrupados: ações de conteúdo primeiro, ações destrutivas por último, separadas por divisor.
- **Toast:** canto inferior direito, empilha até 3 (o 4º substitui o mais antigo), 4s de duração exceto erro (fica até dispensado manualmente ou substituído). Nunca usado para erro de validação de formulário — isso é inline (§12).
- **Painéis deslizantes** (membros/busca/thread/configurações) ocupam sempre o mesmo slot à direita — abrir um fecha o outro que estava aberto ali, nunca empilham.

## 16. Responsividade

Três breakpoints, usados consistentemente em todas as telas de §7-10:

| Breakpoint | Largura | Comportamento geral |
|---|---|---|
| **Desktop** | ≥1280px | 4 colunas fixas: rail (72px) + lista de canais (240px) + conteúdo (flex) + painel direito (280px, quando aberto) |
| **Tablet** | 640–1279px | 3 colunas: rail (72px) + lista de canais (240px, recolhível por botão) + conteúdo (flex). Painéis direitos (membros/busca/thread/configurações) **não** ocupam coluna fixa — viram overlay flutuante ancorado à direita (~340px) com leve scrim, fecha ao clicar fora |
| **Mobile** | <640px | 1 coluna, navegação sequencial empilhada (ver abaixo) |

**Navegação em Mobile — 3 telas empilhadas + overlays:**

1. **Comunidades** — rail vira lista vertical em tela cheia (ícone + nome de cada comunidade, não só ícone).
2. **Canais** — lista de canais da comunidade selecionada, tela cheia, seta "voltar" no topo leva a 1.
3. **Conteúdo** — canal de texto ou voz selecionado, tela cheia, seta "voltar" leva a 2.

Painéis (membros, busca, thread, configurações) e modais abrem **por cima** dessa pilha, sempre em tela cheia, sempre com "voltar"/"fechar" explícito — nunca overlay flutuante pequeno em Mobile (não há espaço). Popover de perfil (1.4) vira bottom sheet. A barra de chamada do Mobile (§9, 2.3.1) fica fixada no rodapé da viewport **independente de qual das 3 telas está em foco** — é a única coisa que sobrevive à navegação sequencial, e é por isso que ela, ao contrário do painel do Desktop, ainda carrega o mudo: a barra de usuário não está na tela junto do conteúdo.

**Regra geral de colapso:** o rail (identidade de qual comunidade) é o elemento mais persistente e o último a desaparecer da tela; painéis de detalhe/administração são os primeiros a virar overlay/tela-cheia. Nenhuma tela desta spec introduz conteúdo ou ação nova em Mobile que não exista em Desktop — só reorganiza.

## 17. Microinterações

| Interação | Comportamento |
|---|---|
| Hover em item de lista (canal, membro) | Fundo clareia sutilmente, `duration-fast` |
| Hover em mensagem | Barra de ações flutuante aparece com fade, `duration-fast`, sem deslocar o texto |
| Envio de mensagem | Entra na lista com leve slide-up + fade |
| Anel de fala ativa | Pulse contínuo ~1.2s, opacidade 0.6↔1, enquanto a pessoa fala |
| Troca de canal | Fade cruzado rápido no conteúdo — evita flash em branco |
| Abrir/fechar painel lateral | Slide da direita, `duration-base`; em Desktop sobrepõe o conteúdo (não empurra — evita reflow de texto em leitura) |
| Reagir a mensagem | Emoji "salta" (scale 1→1.2→1) ao ser adicionado |
| Toast | Entra com slide-up + fade, sai com fade puro |
| Badge de não-lido | Aparece com pop (scale 0→1) ao incrementar |
| Arrastar pra reordenar cargo | Item levanta levemente (sombra), os demais deslizam pra abrir espaço |
| Hover no header da categoria | "+" de criar canal (3.4) aparece com fade, `duration-fast`, sem deslocar o nome da categoria |
| Canal criado | Entra na lista com o mesmo pop de badge (scale 0.96→1) e já nasce selecionado — o destaque é a seleção, sem highlight extra por cima |
| Canal excluído | Item sai com fade + colapso de altura, `duration-fast`, pra lista não "pular" |
| Indicador "digitando…" | Pontos animados em loop |
| Botão em loading | Spinner substitui o label sem mudar a largura do botão (evita pulo de layout) |
| Copiar link/código | Ícone de copiar vira check por ~1.5s antes de reverter |

## 18. Edge cases

- Nome de usuário/comunidade extremamente longo → trunca com reticências + tooltip com o nome completo.
- Mensagem extremamente longa → colapsa após ~15 linhas com "Mostrar mais".
- Lista de membros muito grande (300+) → virtualização (§14) + grupo offline colapsado por padrão.
- Múltiplos compartilhamentos de tela simultâneos no mesmo canal de voz → grade de tiles grandes (não só um "principal"), cada um com badge de topologia independente.
- Host permanentemente offline (nunca mais volta) → sem estado técnico diferente de "offline" comum; depois de um limite ilustrativo (ex.: 30 dias) a comunidade pode ganhar um rótulo informativo "Inativa há muito tempo" no rail — não a remove da lista.
- Voz com apenas 1 participante (Ana sozinha) → grade mostra só o tile dela, sem placeholder vazio estranho. **Emenda de 2026-08-26 (§91):** o hint "Convide alguém pra {canal}" saiu — decisão do operador. A grade com um tile só já diz que não há mais ninguém, e o convite não é ação desta tela. Estar sozinho é um estado normal e **terminal** da chamada, não uma espera a ser preenchida com texto.
- Compartilhamento de tela cai pra 0 espectadores → apresentador vê aviso discreto "Ninguém está assistindo agora", mas o compartilhamento **continua ativo** até ele parar manualmente (não encerra sozinho).
- Ana é Fundador/host e tenta "sair" da própria comunidade → bloqueado com explicação: quem é host precisa encerrar a comunidade explicitamente (zona de perigo, 3.1b) — transferência de host está fora de escopo (§0), então a única saída é encerrar.
- Nome de arquivo extremamente longo → trunca no meio preservando a extensão visível (`aula-webrtc-com(…)pleta.mp4`).
- Mensagem deletada que tinha reações → reações somem junto, sem estado "zumbi".
- Duas edições concorrentes num mesmo cargo (dois Fundadores hipotéticos) → fora do escopo de resolução real (mock não simula concorrência de verdade); o padrão "salva automaticamente" (§13) implica último-a-salvar-vence — limitação documentada aqui, não escondida.
- Link de convite vazado/compartilhado sem querer → sem mecanismo de aprovação manual de entrada (não está no `CLAUDE.md`, não foi inventado); a mitigação disponível é revogar o convite existente (3.1b).
- Excluir o único canal que sobrou → bloqueado (regra do último canal, §10 3.4); o caminho pra ficar sem comunidade é "Encerrar comunidade", não esvaziá-la canal por canal.
- Excluir a última categoria com canais dentro → o caminho "Mover os N canais" fica sem destino; o modal cai só na opção destrutiva, e ela é bloqueada se levar junto o último canal da comunidade (regra acima). Na prática: pra remover a última categoria é preciso criar outra antes.
- Canal de texto criado com nome que já existe **em outra comunidade** → permitido; o nome do canal é único por comunidade, não global (não existe namespace global em P2P).
- Nome de canal só com emoji ou acentos que somem na normalização (ex.: "🎉") → erro de validação, não canal com nome vazio (§13). Canal de **voz** aceita, porque não vira slug.
- Alguém entra num canal de voz no exato momento em que ele é excluído → prevalece a exclusão; a pessoa cai fora da chamada com o mesmo tratamento de D15, sem estado "conectada a canal inexistente".
- Ana perde `gerenciar canais` (cargo alterado por outro moderador) com o modal de 3.4 aberto → o modal fecha na próxima interação, com toast "Você não gerencia mais os canais desta comunidade" — não salva pela metade nem congela a tela.
- Host offline no meio de uma edição de canal com auto-save pendente → o debounce descarta o salvamento e o campo volta ao último valor confirmado, com o banner de host offline já visível (§12) explicando; nada entra em fila (diferente de mensagem, premissa 5 — estrutura de canais é do host, não replicável otimisticamente).
- Categoria colapsada recebe um canal novo → expande sozinha, senão a criação parece não ter surtido efeito.
- Fila offline pendente quando o canal de destino é excluído (ou Ana sai da comunidade) antes do host voltar → a mensagem é descartada com aviso nomeado ("2 mensagens não foram enviadas: #ajuda-design não existe mais"), nunca some calada nem fica pendente para sempre.
- Presença "Invisível" e entrar em canal de voz → voz é presença por definição (a pessoa aparece no tile e na lista de participantes). Ao entrar, aviso único e discreto: "Entrar na chamada mostra que você está online". Não bloqueia; a alternativa seria uma chamada com participante fantasma.
- Apelido igual ao nome de outra pessoa da comunidade → permitido, sem checagem de unicidade (a mesma postura de §13 para nome de identidade — não existe unicidade global em P2P). Menções continuam resolvendo por identidade, não por texto.
- Mensagem fixada é deletada → some da aba Fixados (2.1.2) junto, sem deixar linha órfã, mesma regra das reações de mensagem deletada.
- Canal silenciado com menção direta → badge de menção aparece mesmo assim (1.1.1); silenciar reduz ruído, não esconde alguém te chamando pelo nome.
- Link `/m/:code` de uma comunidade que Ana já deixou → mesmo tratamento de "não é membro" (§4), sem revelar que ela já esteve lá.
- Todas as câmeras da chamada ligadas ao mesmo tempo em conexão fraca → o áudio tem prioridade declarada (2.3.2): o vídeo degrada ou pausa antes de a voz falhar, com o tile mostrando o avatar de volta e um ícone de sinal fraco.
- Relógio do dispositivo de quem envia muito adiantado → mensagem não vai pro "futuro" no topo da lista; regra em §5.10.
- Movimento reduzido ativo no sistema (§5.9) durante um reparo de árvore → o pulse vira spinner estático com rótulo textual; o estado nunca depende só da animação que foi desligada.

## Apêndice A — Decisões de escopo tomadas ao longo do documento

Consolidação de todo corte de escopo feito durante a especificação (além dos listados em §0), pra quem for implementar não reintroduzir por engano:

- Sem drag-and-drop de canais/categorias — ordem fixa por criação (§8, 1.1).
- Sem tema claro — dark-only (confirmado com o usuário, §0).
- Sem transferência de host entre dispositivos (§0, edge case em §18).
- Sem aprovação manual de entrada em convite — só convite válido/revogado/banido (§18).
- Sem paginação numerada em nenhuma lista — scroll infinito, "carregar mais", ou virtualização, conforme o caso (§14).
- Sem color-picker livre para cargos — 7 cores curadas fechadas (§5.4, §10).
- Sem notificação nativa do SO nem bandeja do sistema (premissa 1, §0).
- Sem sistema de reputação/moderação entre comunidades — só por-comunidade via cargos (§0, §10).
- Sem edição colaborativa em tempo real com resolução de conflito — última escrita vence (§18).
- Sem canal privado nem canal oculto por cargo — a única permissão por-canal do v1 é "somente-leitura" (§10, 3.4). Visibilidade de canal é toda-ou-nada por comunidade.
- Sem converter canal de texto em canal de voz (ou vice-versa) depois de criado — o tipo é escolhido na criação e fica (§10, 3.4).
- Sem mover canal entre **comunidades**, e sem categoria aninhada — a árvore tem exatamente dois níveis (§10, 3.4).
- Sem limite de participantes, bitrate ou região por canal de voz — não há servidor pra dimensionar, e `CLAUDE.md` não descreve nada disso.
- Sem arquivar canal (só excluir) e sem lixeira/desfazer — coerente com "não pode ser desfeito" das confirmações de §15.
- Sem silenciar canal "por 1 hora / até amanhã" — o mute de 1.1.1 é liga-desliga; duração exigiria agendamento local que nada mais na spec usa.
- Sem moderador renomear o apelido de outra pessoa — apelido é auto-atribuído (premissa 11), o que evita inventar uma permissão fora do checklist de §10 (3.2).
- Sem preview/unfurl de link na aba Links nem nas mensagens (§9, 2.1.2) — buscar a página exigiria ou um servidor central (que não existe) ou uma requisição de cada cliente, vazando o IP de todo mundo pro site linkado. Decisão de privacidade, não de esforço.
- Sem câmera na árvore de multicast — vídeo de câmera é mesh, só compartilhamento de tela usa árvore (premissa 9, §9 2.3.2).
- Sem seletor de idioma — `pt-BR` fixo (§5.10). Fuso e formatos seguem o dispositivo de quem lê.
- Sem rota endereçável para canal ou comunidade — só identidade/convite/mensagem (§4, premissa 10).

## 19. Verificação

Como confirmar que uma implementação bate com esta spec, sem depender de backend real:

1. **Checklist por tela**: percorrer §7-10 tela por tela e confirmar que todo estado listado ("Estados") é alcançável no mock — via dados fixos que já nascem naquele estado (ex.: Ateliê Aberto já carrega com `hostStatus = offline`) ou via um afinador de estado só-de-desenvolvimento (recomendado: um painel de debug, fora desta spec de produto, que force `conn-reconnecting`, `conn-failed`, reparo de árvore, etc. sob demanda — sem isso, estados de rede são difíceis de disparar manualmente num mock sem rede real).
2. **Consistência do dataset**: todo nome/ID usado numa tela (§2) deve bater com o mesmo nome/ID nas outras — Ana, Rafael, Bianca, Diego, Fernanda e as 3 comunidades devem se comportar como as mesmas entidades em qualquer tela onde aparecerem.
3. **Verificação de acessibilidade pontual**: confirmar que o indicador de fala ativa é distinguível do dot de presença sem depender só de cor (forma + movimento, §5.4); confirmar contraste de texto das 7 cores de cargo sobre `surface-primary`.
4. **Verificação de responsividade**: cada tela de §7-10 testada nos 3 breakpoints (§16), confirmando que nenhuma ação some sem um caminho equivalente.
5. **Consistência interna**: nenhuma tela referencia um estado, permissão ou componente que não esteja definido em §5, §6 ou no Apêndice A — este documento é a fonte única, não deveria exigir inventar nada na hora de implementar.

## Status de implementação

Registro do que já existe em código, parte por parte, para quem for implementar a próxima. A spec acima continua sendo a fonte de verdade — esta seção só diz até onde ela já virou código.

### Parte 1 — Fundação do projeto + Onboarding (0.1) — implementada em 2026-08-11

**Escopo:** primeira fatia da ordem de dependência — design system em código, modelo de domínio, dataset de referência, roteamento, stores de identidade/convite e a tela 0.1 completa. Nenhuma tela das Camadas 1-3 foi iniciada.

#### O que está funcional

- **Design system (§5) inteiro em código**, em `frontend/src/styles/tokens.css`: as 4 superfícies + 3 bordas + scrim, os 5 degraus de texto, os 4 tokens de accent, os 4 sistemas semânticos paralelos de §5.4 (presença, cargo, saúde de conexão, feedback — cada um com token próprio, mesmo onde resolvem para a mesma cor), os 7 degraus tipográficos com peso/altura de linha/letter-spacing, raios, sombra de elevação, durações de motion e os breakpoints de §16 (`tablet:` 640px, `desktop:` 1280px). Nenhum valor de §5 ficou de fora e nenhum componente usa a escala crua do Tailwind.
- **Modelo de domínio (§2) tipado** em `src/domain/types.ts` — todas as entidades da tabela, inclusive as que só serão usadas nas Camadas 2-3 (`VoiceSession`, `ScreenShareSession` com `firstLevelRelays` de 2.4.2, `ModerationAction`, `Thread`, `Attachment`, `InvitePreview` com os 4 desfechos de 0.3).
- **Dataset de referência (§2) completo** em `src/mocks/dataset.ts`: Ana/Rafael/Bianca/Diego/Fernanda, as 3 comunidades com seus `hostStatus` (incluindo Ateliê Aberto já nascendo `offline` para o fluxo B4), a estrutura de canais/categorias de Vale do Código com as não-lidas e o `#ajuda-backend` silenciado, os 4 cargos com o catálogo de permissões de §10 (3.2), a transcrição de `#geral`, a thread de moderação, o anexo de 1.24 GB a 62%, o convite `x7K2qM`, as duas entradas do log de auditoria e as sessões de voz/compartilhamento de 2.3/2.4.
- **Componentes de §6 usados por 0.1**, em `src/components/ui/`: `Button` (5 variantes, incluindo loading com spinner que substitui o label sem mudar a largura — §17), `TextField` (default/focus/erro/disabled, contador e mensagem inline), `Avatar` (P/M/G, iniciais ou emoji, dot de presença com recorte de 2px e o dot vazado de offline, anel de fala ativa com waveform) e `Spinner`.
- **Roteamento de §4**: exatamente duas rotas (`/` e `/invite/:code`) em `react-router`, com `/` resolvendo por estado e qualquer outra URL redirecionando para `/`. Nada de painel, modal ou canal selecionado no router.
- **Tela 0.1 e fluxo A1 integralmente**, incluindo as exceções: nome só com espaços dá erro inline em vez de submeter, `Enter` com campo inválido mostra o mesmo erro sem navegar, contador vira `feedback-warning` acima de 28/32, "Gerar outra cor" nunca devolve a cor atual, loading de ~600ms e transição de saída em `duration-slow` antes de a rota trocar. Identidade persistida via `persist` do Zustand.
- **Fluxo A2, passos 1-2**: `/invite/:code` consome a URL, guarda o código pendente (normalizando link completo ou código curto, em qualquer caixa) e devolve para `/`, que mostra o onboarding quando não há identidade. Os passos 3-5 dependem de 0.3.

#### Observações

- **Tokens aplicados como variáveis CSS**, via `@theme static` do Tailwind 4: cada token de §5 existe como custom property em `:root` *e* como utilitário semântico. Os nomes de utilitário carregam o prefixo do namespace do Tailwind — `bg-surface-app`, `text-text-primary`, `border-border-default`, `text-heading-1` —, e as durações de motion, que não têm namespace próprio no Tailwind 4, são consumidas como `duration-(--duration-base)`.
- **Avatar: preenchimento sólido + tinta `surface-app`.** As 7 cores de cargo são validadas em §5.4 para contraste *como texto sobre superfície escura*; usadas como fundo, texto branco seria ilegível sobre `role-gold`. A paleta de avatar é o conjunto curado de §5.4 + o accent do produto — nenhuma paleta nova foi inventada.
- **Campos do domínio em inglês, textos de interface em português.** A spec descreve os campos em português (`souEuOHost`, `naoLidas`); o código usa o equivalente em inglês, com o mapeamento anotado onde não é óbvio.
- **Uma mensagem a mais no dataset:** §11 (B8) exige o card do anexo em `#geral`, mas a transcrição de §2 não o inclui. O anexo foi pendurado numa mensagem de Rafael às 08:52, *antes* do bloco transcrito, para não alterar a sequência documentada.
- **`prefers-reduced-motion` respeitado globalmente** — todo motion desta spec é decorativo, então desligá-lo não custa informação nenhuma.
- **Pendência deliberada:** `src/routes/ShellPlaceholder.tsx` não é uma tela da spec. Ocupa o destino do fluxo A1 enquanto 0.2/1.1 não existem e **deve ser deletado** quando a Camada 1 entrar — é o único arquivo descartável desta parte.
- **Dependências adicionadas:** `react-router-dom` (§4), `lucide-react` (§5.7) e `@fontsource-variable/inter` (§5.5, auto-hospedada, sem CDN).

#### Verificação feita (§19)

Todos os estados listados em 0.1 foram alcançados e conferidos em navegador headless: vazio/disabled, preenchendo, erro por espaços, erro por `Enter` inválido, contador em warning, confirmando (loading) e sucesso. Também conferidos: persistência da identidade e do convite pendente, `/invite/x7K2qM` sem identidade caindo no onboarding com o código guardado, e o layout de 0.1 em Mobile (card em 100% menos 32px, sem overflow horizontal). `tsc -b`, `vite build` e `oxlint` passam limpos.

#### Próxima parte sugerida

Fechar a Camada 0: **0.2 Hub vazio → 0.4 Criar comunidade → 0.3 Entrar via convite + preview**, que juntos tornam os fluxos A2 e A3 percorríveis de ponta a ponta. Exige uma store de comunidades (lista de participação + comunidade/canal ativos com `persist`, §4) e os componentes `Modal`, `Toast` e `Badge` de §6. O shell (1.1) entra junto ou logo depois, já que 0.2 é definido como o shell com o rail vazio.

### Parte 2 — Camada 0 completa (0.2, 0.4, 0.3) — implementada em 2026-08-11

**Escopo:** as três telas restantes da camada de entrada, mais o rail do shell (1.1) — sem ele o Hub vazio não existe, já que 0.2 é definido como "o shell com o rail contendo só o botão +". A lista de canais e a área de conteúdo do shell continuam fora.

#### O que está funcional

- **0.2 Hub vazio** com o texto de apoio exato da spec, ilustração de nós conectados, e os dois CTAs abrindo 0.4 e 0.3. Aparece sempre que `comunidades.length === 0` e é substituído assim que a primeira entra.
- **Rail de comunidades (§8, 1.1)** — 72px, ordem de entrada, barra vertical `accent-default` no ativo, ícone que sai de circular para `radius-lg` no ativo/hover, tooltip com o nome após 500ms, host offline com opacidade 60% + dot `conn-offline`, botão "+" com menu (criar/entrar) e avatar da identidade no rodapé.
- **0.4 Criar comunidade e fluxo A3 completo** — nome 2-40 com contador, seletor de ícone cor+iniciais, descrição opcional até 120, o **aviso permanente e não-dispensável** sobre a comunidade depender desta máquina (ícone `conn-degraded`), loading de 600ms, toast "X criada — você é o host", e a comunidade nascendo com categoria "GERAL", canal `#geral` e cargo Fundador atribuído. Nome duplicado gera aviso não-bloqueante, não erro — não existe unicidade global em P2P.
- **0.3 Entrar via convite e fluxo A2 completo**, com os cinco desfechos de preview alcançáveis: válido (Vale do Código, 340 membros, convite de Rafael Mendes), inválido, revogado (tratado como inválido, sem diferenciar para o usuário), banido (ícone acinzentado, sem contagem de membros nem quem convidou) e já-é-membro (botão único "Ir para a comunidade"). Passo 1 valida ao colar/digitar com debounce de 400ms; passo 2 mostra skeleton antes do card; entrar leva 800ms.
- **Chegada por `/invite/:code`**: sem nenhuma comunidade, o preview ocupa a tela inteira (não há shell por trás); com o rail já povoado, é modal sobre o shell. Cancelar consome o convite pendente em vez de reabrir o preview em loop.
- **Componentes novos de §6**: `Modal` (sobre `<dialog>` nativo), `Toast` + pilha, `Tooltip`, `Skeleton`, `TextArea` e `Menu`.
- **Stores novas**: `communityStore` (participação, comunidade/canal ativos, comunidades criadas, tudo persistido), `uiStore` (overlay aberto) e `toastStore`.

#### Observações

- **Duas fontes de dado convivem de propósito.** As comunidades de §2 vivem nas fixtures — o "mundo" que já existe — e a store guarda apenas de quais Ana participa; comunidades criadas no mock não existem em fixture nenhuma e moram na store. Resolver um id sempre passa por `selectCommunity`, que consulta os dois lugares.
- **Selectors que montam array novo passam por `useShallow`.** `useCommunityStore(selectJoinedCommunities)` derrubava o app com "Maximum update depth exceeded": o Zustand v5 compara por referência e um array recriado a cada render entra em loop. O acesso correto é o hook `useJoinedCommunities()`; o seletor cru ficou reservado para `getState()`.
- **Duas correções específicas do `<dialog>` nativo**, ambas encontradas em teste de navegador: o `preventDefault` do `onCancel` sintético do React não segura o dialog (precisa de listener nativo), e o close watcher do Chrome ignora esse `preventDefault` quando não houve ativação do usuário na página — daí a rede de segurança que reabre o dialog se o React ainda o considera aberto, preservando a ordem do top layer. Sem isso, `Esc` com formulário sujo fechava o modal por baixo da própria confirmação de descarte.
- **`h-fit`, não `h-auto`, no modal:** o `<dialog>` nativo vem com `inset: 0`, e altura automática entre top e bottom fixos estica o modal para a viewport inteira.
- **Três códigos de convite de mock** (`x7K2qM` válido, `X7REV0` revogado, `X7BAN1` banido) existem só para tornar os desfechos de 0.3 alcançáveis, como pede §19.1 — não fazem parte de §2. O estado "banido" é um atalho: no produto o banimento é da identidade, não do convite.
- **Afinador de estado de desenvolvimento** (`DevBar`, canto inferior esquerdo, só em `import.meta.env.DEV`): carrega o rail de §2 de uma vez, zera comunidades, apaga a identidade e lista os códigos de teste. É o painel recomendado por §19.1, explicitamente fora da spec de produto.
- **Pendência deliberada:** `CommunityWorkspacePlaceholder.tsx` ocupa as colunas de lista de canais e conteúdo até a Camada 1 chegar. É o único arquivo descartável desta parte — `ShellPlaceholder.tsx`, da parte 1, foi removido.

#### Verificação feita (§19)

Fluxos A2 e A3 percorridos de ponta a ponta em navegador headless, com input real de mouse e teclado (clique sintético não gera ativação do usuário e muda o comportamento do `<dialog>`). Conferidos: texto exato de 0.2; os cinco desfechos de 0.3, incluindo que o preview de banido não vaza contagem de membros nem quem convidou; contadores e aviso permanente de 0.4; confirmação de descarte por `Esc` com o formulário preservado ao voltar; convite pendente limpo ao cancelar; as duas variantes de layout de `/invite/:code`; estados do rail com o dataset de §2 carregado; e o modal em Mobile ocupando 390×780 sem cantos arredondados nem overflow horizontal. Zero erros de console. `tsc -b`, `vite build` e `oxlint` limpos.

#### Próxima parte sugerida

**1.1 Shell principal** completo: lista de canais (240px) com categorias colapsáveis, badges de não-lidas/menções, canal silenciado e participantes inline nos canais de voz; área de conteúdo; painel de membros (1.3). Isso remove o último placeholder e abre caminho para 2.1 (canal de texto), a tela onde o tempo de uso se concentra.

### Parte 3 — Lista de canais (1.1) + canal de texto em leitura (2.1 parcial) — implementada em 2026-08-11

**Escopo:** as duas colunas que faltavam no shell — lista de canais e área de conteúdo — com o canal de texto em **modo leitura**. Tudo que depende do composer (envio, markdown, autocomplete de menção 2.1.1, reações, toolbar de hover, thread 2.2) ficou deliberadamente de fora para não entrar pela metade. O painel direito de 280px (busca 1.2, membros 1.3, thread 2.2) também continua fora.

#### O que está funcional

- **Lista de canais (§8, 1.1)** — 240px em `surface-sidebar`, nome da comunidade no topo, categorias colapsáveis com o estado **lembrado por comunidade** e persistido (`collapsedCategoryIds` no `communityStore`), canais na ordem de criação (§14).
- **Item de lista de canal (§6) com todos os estados obrigatórios**: default, hover, ativo (`accent-muted-bg`), não-lido (texto em `text-primary` + peso de ênfase + dot na borda da lista), menção pendente (badge numérico `feedback-danger`, trunca em "99+"), silenciado (ícone mudo, texto em `text-tertiary`, sem destaque de não-lido) e canal de voz com gente dentro (pill "AO VIVO" + uma linha por participante abaixo do nome, com avatar e nome de exibição). No dataset de §2 os cinco estados coexistem na mesma tela: `#avisos` não-lido, `#geral` ativo + não-lido + 1 menção, `#ajuda-backend` silenciado, `Sala de Estudos` com Rafael/Diego/Bianca, `Papo Aberto` vazio.
- **Cabeçalho do canal (§9, 2.1)** — ícone por tipo, nome, tópico separado por divisória e os quatro ícones de ação à direita.
- **Lista de mensagens em leitura (§9, 2.1)** — agrupamento de mensagens consecutivas do mesmo autor dentro de 5 min (avatar e nome só na primeira; a hora aparece na medianiz no hover), separador de data, divisor "Novas mensagens", rótulo "(editado)", mensagem fixada (rótulo "Fixado" + superfície um degrau acima), resposta inline com autor e trecho da mensagem respondida, pill de menção em `accent-muted-bg`, nome do autor colorido pela cor do cargo mais alto (§5.4) e scroll-to-bottom ao entrar no canal.
- **Card de anexo (§6, §11 B8)** — `aula-webrtc-completa.mp4`, 1,24 GB, barra de progresso em 62% e "3 peers + host disponíveis", com os desfechos "Baixado · Disponibilizando para outros" e "Indisponível no momento" derivados dos próprios campos de `Attachment`.
- **`#avisos` somente-leitura** para quem não é Moderador+: no lugar do composer entra o aviso "Só moderadores podem postar aqui". A regra é por cargo (`selectIsChannelReadOnly`) — basta um cargo fora da lista de somente-leitura para liberar, então Ana (Contribuidora) lê e Bianca (Moderadora) postaria.
- **Empty state de canal sem mensagem** — "Este é o início de #nome-do-canal" com uma frase explicando o motivo (§12), alcançável em `#apresentações`, `#ajuda-frontend`, `#avisos` e no `#geral` de qualquer comunidade recém-criada.
- **Mobile (§16)**, parcial: abaixo de 640px a lista de canais e o conteúdo passam a ocupar uma coluna por vez, com seta "voltar" no cabeçalho do canal.

#### Observações

- **Onde fica "lido até aqui".** O divisor "Novas mensagens" precisa de uma âncora, e a spec não dá uma: entrou `firstUnreadMessageId` no `Channel` (no canal, não na mensagem — quem leu é quem lê). Em `#geral` ele aponta para a menção de Bianca, a mesma que gera a menção pendente do item de lista. A resposta de Ana aparece *abaixo* do divisor de propósito: o divisor marca onde a leitura parou e só se move quando o canal é reaberto.
- **Não-lidas não zeram ao abrir o canal.** §19.1 pede que todo estado continue alcançável no mock; se abrir `#geral` limpasse o contador, o estado "ativo + não-lido + menção" e o próprio divisor sumiriam no primeiro clique e não voltariam. O contador só vai virar dinâmico quando houver envio de mensagem (Parte 4).
- **O `unreadCount` de 12 em `#geral` nunca vira número na tela** — §6 manda dot para não-lido e badge numérico só para menção, então o 12 acende o dot e o badge mostra 1, a menção. Não é inconsistência com os 6 itens da transcrição de §2.
- **Quem é a identidade local dentro de uma comunidade.** Nas comunidades de fixture ela ocupa o lugar de Ana Torres (`selectLocalMemberRoleIds`) — o mock não tem rede para materializar duas pessoas, e §19.2 pede que Ana seja a mesma entidade em toda tela; nas comunidades criadas no app, é a fundadora. É o que decide o somente-leitura de `#avisos`.
- **Canal de voz não é clicável.** Entrar em voz não troca a área de conteúdo (§4) — a resposta certa ao clique é a barra de chamada persistente de 2.3.1, que ainda não existe. A linha fica com o visual completo (pill + avatares) e sem afordância de clique, em vez de fingir uma chamada.
- **Os quatro ícones de ação do cabeçalho ficam visíveis e inativos** (`aria-disabled`, com tooltip nomeando a ação): os destinos são painéis das partes seguintes (2.2, fixados, 1.2, 1.3). A regra de esconder-em-vez-de-desabilitar de §15 vale para ação de moderação sem permissão, não para navegação que ainda não existe.
- **Categoria colapsada esconde todos os canais**, inclusive os não-lidos. A spec só descreve colapsar (§8, 1.1); manter não-lidos visíveis é convenção do Discord que ela não pede.
- **Banner de host offline não entrou.** Ateliê Aberto abre em modo cache sem banner no topo do conteúdo — ele faz parte do fluxo B4, junto com a fila de mensagens pendentes do composer, e viria pela metade sem ele. Hoje o sinal de host offline está só no rail (ícone opaco + dot `conn-offline`).
- **Mobile ainda não tem a tela 1 de §16**: o rail continua rail em vez de virar lista vertical com nomes. As telas 2 e 3 (canais → conteúdo, com "voltar") funcionam.
- **Histórico curto encosta na base** da área de rolagem, como em qualquer chat — é onde o composer vai encostar na Parte 4.
- **Componentes novos de §6**: `Badge` (contagem numérica com "99+" e pill "AO VIVO"). O restante saiu de composição dos que já existiam.
- **Placeholders zerados:** `CommunityWorkspacePlaceholder.tsx` foi removido. Não há mais nenhum arquivo descartável no projeto.

#### Verificação feita (§19)

Todos os estados acima conferidos em navegador headless (1440×900 e 390×780), com o dataset de §2 carregado: os cinco estados do item de lista convivendo na mesma lista; 6 mensagens renderizando 5 blocos de autor (as duas de Diego, a 4 min de distância, agrupam) com a hora aparecendo na medianiz só no hover; separador "HOJE", divisor "Novas mensagens", "(editado)", "Fixado", "respondendo a Bianca Souza", pill `@Ana Torres` e o card do anexo com "1,24 GB · 3 peers + host disponíveis" e 62%; aviso de somente-leitura presente em `#avisos` e ausente em `#apresentações`; colapso de "TEXTO" escondendo os canais, gravado em `localStorage` (`{"com-vale-do-codigo":["cat-vale-texto"]}`), sobrevivendo ao reload e **não** vazando para o "GERAL" de Clã Noturno; comunidade aberta pela primeira vez (Ateliê Aberto) destacando na lista o mesmo canal que abriu no conteúdo; e Mobile sem overflow horizontal (`scrollWidth` 390 em viewport de 390), com a seta "voltar" alternando as duas colunas. Zero erros de JavaScript e nenhum aviso de console — a única entrada de erro é o `GET /favicon.ico` 404, do scaffold: o projeto não tem favicon nenhum. `tsc -b`, `vite build` e `oxlint` limpos.

Duas correções nasceram dessa verificação: numa comunidade aberta pela primeira vez o conteúdo caía no primeiro canal de texto mas a lista não destacava nada (a lista lia a store, o conteúdo lia o fallback — agora o id vem resolvido de cima, de uma fonte só), e a lista de mensagens passou a encostar na base em vez de flutuar no topo de uma área vazia.

#### Próxima parte sugerida

**2.1 completa + 2.2** — composer (com os estados de §6: vazio, com texto, anexo em envio, fila offline), envio, markdown básico, autocomplete de menção (2.1.1), reações, toolbar de hover na mensagem e painel de thread. É o que transforma o canal de leitura em canal de uso, e o composer é pré-requisito do fluxo B4 (fila offline) e do banner de host offline que ficou de fora aqui.

### Parte 4 — Composer, envio e fluxo B4 — implementada em 2026-08-11

**Escopo:** o canal de texto deixa de ser só leitura. Composer com anexo, envio, markdown básico, autocomplete de menção (2.1.1) e os estados P2P que só existem quando dá para escrever: fila local com host offline e banner de saúde do host (fluxo B4). Reações, toolbar de hover na mensagem, editar/deletar/fixar e o painel de thread (2.2) ficaram para a parte seguinte — dependem do mesmo slot de painel deslizante de 1.2/1.3 e andam juntos.

#### O que está funcional

- **Composer (§6, §9 2.1)** — textarea nativo que cresce até 40% da viewport antes de rolar, placeholder "Conversar em #canal", `Enter` envia e `Shift+Enter` quebra linha. Botão de anexo abre o seletor do SO, o arquivo escolhido vira chip com nome, tamanho e "x", e o erro inline "Arquivo muito grande" pertence ao mock: desde a emenda de 2026-09-04 (`backend-v2.md` §13.8) **não há teto de produto por arquivo** nem cota por membro, e o que o composer real precisa nomear é `E_STORAGE_FULL` — sem espaço em disco —, não tamanho (§11, C9).
- **Fluxo C9 inteiro** — a mensagem entra na lista na hora com opacidade reduzida, o anexo mostra "Enviando…" com barra de progresso, e a confirmação (~800ms) devolve a opacidade normal e transforma o anexo em card de seeding ("Disponibilizando para outros" — o arquivo é de Ana, ela é a origem dele).
- **Markdown básico (§0, premissa 8)** renderizado só depois do envio, sem preview WYSIWYG: negrito, itálico, código inline, bloco de código monoespaçado, `[texto](url)` e URL solta. Sem dependência nova — são ~80 linhas em `lib/markdown.tsx`, e o resultado é sempre elemento React, nunca HTML injetado.
- **Autocomplete de menção (§9, 2.1.1) completo** — `@everyone` no topo (só para quem tem `mention_everyone`; Ana tem, como Contribuidora), seção CARGOS com swatch da cor do cargo e contagem de membros, seção MEMBROS com avatar P, dot de presença, nome na cor do cargo principal e o cargo como secundário. `↑`/`↓` com wrap-around, `Enter` e `Tab` confirmam, `Esc` fecha mantendo o texto como texto comum, espaço ou pontuação encerram o filtro. A menção confirmada fica destacada dentro do composer e um único `Backspace` remove o token inteiro.
- **Estados de entrega da mensagem (§6)** — enviando (opacidade), falha ("Não foi possível enviar" + "Tentar novamente", que reenvia) e fila offline (ícone de relógio + "Pendente — será enviada quando X voltar").
- **Fluxo B4 inteiro** — Ateliê Aberto abre com o banner `conn-offline` "Ateliê Aberto está offline — mostrando histórico salvo neste dispositivo"; o composer continua habilitado e o que Ana escreve entra na fila local; quando o host volta, o banner vira "Reconectando…" com pulse (`conn-reconnecting`), o rail perde o dot de offline e, ao estabilizar, a fila é entregue e o banner some.
- **Indicador "está digitando…"** (§9, 2.1) no rodapé, acima do composer, com os pontos animados de §17.
- **Banner de status (§6)** como componente próprio, com os quatro tons de `conn-*` — é o mesmo que 2.4 vai usar para reparo de árvore.

#### Observações

- **A variante nova da armadilha do Zustand v5.** A Parte 2 já registrou que selector que monta array novo precisa de `useShallow`. Aqui isso **não bastou**: `useShallow` compara elemento a elemento por referência, e o seletor de candidatos de menção construía objetos novos a cada chamada — todo render era "diferente" e o app voltou a cair com "Maximum update depth exceeded". A regra completa é: `useShallow` só resolve quando os *elementos* já são estáveis. Montar objeto derivado é trabalho de `useMemo` sobre entradas estáveis, não de selector.
- **Cursor reposicionado em efeito de layout, nunca em `requestAnimationFrame`.** Inserir ou apagar uma menção mexe no texto por fora do input e exige recolocar o cursor. Com `rAF` o reposicionamento chega *depois* da próxima tecla quando o usuário digita rápido, e o texto sai embaralhado — foi exatamente o que o teste de navegador pegou (o `@bi` seguinte virava `ib@` e era enviado como mensagem). `useLayoutEffect` acerta antes do próximo evento.
- **Token de menção destacado, não editável-por-pill.** §9 2.1.1 pede um token visual dentro do composer. Em vez de trocar o textarea por `contenteditable` (que custaria seleção, undo e IME), o destaque vem de um espelho alinhado atrás do campo — mesma fonte, mesmo padding, mesmo wrap. O comportamento de §2.1.1 fica inteiro; o que o espelho não faz é dar padding horizontal ao token, que deslocaria o texto real.
- **Depois de `Esc`, a menção segue texto comum enquanto for editada.** A spec diz o que `Esc` faz, não o que acontece se o usuário continuar digitando o mesmo token. Aqui o dropdown só volta num `@` novo — coerente com "vira texto comum" e com o gênero.
- **A ordem dos membros segue a regra, não o exemplo.** §9 2.1.1 manda ordenar por presença e alfabeticamente dentro do grupo, mas o exemplo mockado lista "Rafael, Diego, Bianca", que não é alfabético. Vale a regra: Bianca, Diego, Rafael (online) e depois Fernanda (ausente). A identidade local também não aparece na própria lista — mencionar a si mesma não serve para nada, e o exemplo da spec já omitia Ana.
- **`connectionStore` é a fonte única de saúde de host.** O `hostStatus` da fixture diz como a comunidade *nasce*; o que muda em sessão vive na store e sobrepõe. Rail, banner e composer leem do mesmo lugar, então não podem discordar. Não é persistido: estado de conexão é sempre do agora.
- **Mensagens enviadas não são persistidas.** Recarregar devolve o canal ao estado documentado em §2 — que é justamente o que §19 manda conferir.
- **Sem check de entregue.** §11 B4 fala em "ícone de relógio em vez de check de entregue", mas §6 não lista "entregue" entre os estados da linha de mensagem, e um check em toda mensagem seria ruído. Só o desvio (fila, falha) aparece.
- **Fora do composer nesta parte:** os botões de emoji e de formatação da toolbar de §6. O seletor de emoji não tem spec própria e vai ser usado duas vezes — no composer e nas reações —, então entra junto com elas. Markdown, como §11 C9 descreve, é digitado.
- **Não-lidas continuam estáticas.** Abrir um canal ainda não zera o contador, pelo mesmo motivo da Parte 3 (§19.1: os estados precisam seguir alcançáveis).
- **Afinador de desenvolvimento ampliado** (§19.1): derrubar o host da comunidade ativa, trazê-lo de volta (com a reconexão de B4), forçar a falha do próximo envio e pôr Diego digitando. Sem rede real, nenhum desses estados é alcançável de outro jeito.

#### Verificação feita (§19)

34 checagens em navegador headless com teclado real (1440×900 e 390×780), cobrindo C9 e B4 de ponta a ponta: markdown renderizando negrito/código/link depois do envio; a mensagem aparecendo opaca e confirmando; lista default do autocomplete exatamente como §9 2.1.1 descreve (`@everyone` → Fundador, Moderador, Contribuidor → Bianca, Diego, Rafael, Fernanda), cargo base "Membro" ausente por não ser mencionável, `@bi` filtrando só Bianca, wrap-around do `↑` no topo, `Esc`, `Tab`, token destacado e `Backspace` apagando a menção inteira; chip de anexo, "Enviando…" e o card virando seeding; falha de envio e reenvio; banner offline, mensagem na fila, "Reconectando…", rail perdendo o dot e a fila sendo entregue; indicador de digitando; `#avisos` seguindo sem composer; e Mobile com composer e sem overflow horizontal. Nenhum erro de JavaScript — a única entrada de erro no console segue sendo o `GET /favicon.ico` 404 do scaffold. `tsc -b`, `vite build` e `oxlint` limpos.

Duas correções nasceram dessa verificação, ambas descritas em Observações: o loop de render do seletor de menções e o cursor reposicionado por `requestAnimationFrame`.

#### Próxima parte sugerida

**Painel deslizante e o que vive nele** — toolbar de hover na mensagem (reagir, responder, responder em thread, "⋯"), reações com seletor de emoji, editar/deletar/fixar com o menu de contexto de §15, e o painel de thread (2.2). Os três painéis do slot direito (thread 2.2, membros 1.3, busca 1.2) compartilham o mesmo componente e a regra de "abrir um fecha o outro" (§6), então vale construir o slot uma vez e encaixar 1.3 e 1.2 na sequência.

### Parte 5 — Ações na mensagem: toolbar, reações e menu de contexto — implementada em 2026-08-11

**Escopo:** tudo que acontece *na própria mensagem*. A barra de ações de hover, o menu de contexto de §15 com seus itens por permissão, reações com seletor de emoji, responder inline, editar, deletar, fixar e copiar link. O painel de thread (2.2) e os outros dois painéis do slot direito (membros 1.3, busca 1.2) ficaram juntos para a parte seguinte — os três dividem o mesmo componente deslizante e a regra de "abrir um fecha o outro" (§6).

#### O que está funcional

- **Barra de ações de hover (§6, §9 2.1, §17)** — aparece com fade, sem deslocar o texto, ancorada no canto superior direito da mensagem: reagir, responder e "⋯". Continua visível enquanto o menu ou o seletor de emoji estiverem abertos (senão o próprio movimento do mouse até o menu o fecharia) e também enquanto o foco estiver dentro da mensagem, para quem navega por teclado.
- **Menu de contexto (§6, §15)** — pelo "⋯", pelo botão direito, ou por long-press de 500ms no toque (§9, 2.1 responsividade). Ações de conteúdo primeiro, destrutivas por último, separadas por divisor. **Item que a permissão não autoriza não aparece**, nunca desabilitado: como Contribuidora, Ana vê "Adicionar reação", "Responder", "Fixar mensagem" e "Copiar link" na mensagem de outra pessoa — sem "Editar" e sem "Deletar".
- **Reações (§6, §9 2.1)** — chip com emoji e contagem, destacado quando a identidade local reagiu, alternando ao clicar; chip que zera some junto (§18). O emoji "salta" ao ser adicionado (§17). Seletor de emoji curado, sem dependência nova nem busca — mesma postura das 7 cores de cargo (§5.4).
- **Responder inline** — a barra "respondendo a X" aparece colada ao topo do composer, com cancelar; a mensagem enviada nasce com `replyToId` e a citação já renderizada (o preview de resposta existe desde a Parte 3).
- **Editar a própria mensagem (§13)** — editor inline, `Enter` salva, `Esc` cancela, `Shift+Enter` quebra linha. Esvaziar não salva: mensagem vazia se resolve com "Deletar" (§13), então o botão desabilita em vez de apagar por engano. Salvar marca "(editado)".
- **Deletar (§15)** — a própria mensagem some direto, sem confirmação (destrutivo reversível dentro da sessão); a de outro autor, só com `manage_messages`, passa por modal que nomeia a consequência exata ("A mensagem de Rafael Mendes será removida para todo mundo. Não pode ser desfeito.").
- **Fixar/desafixar** (Ana tem `pin_messages` como Contribuidora) e **copiar link da mensagem** com o toast "Link copiado" (§9, 2.1).
- **Composer completo (§6)** — o botão de emoji e os de formatação (negrito, itálico, código), que a Parte 4 tinha deixado pendentes esperando o seletor de emoji, agora existem.

#### Observações

- **Uma reação a mais no dataset.** §2 não transcreve reação nenhuma, mas §9 (2.1) exige o chip nos dois estados — com e sem a reação de Ana. Sem alguém já tendo reagido, "outros reagiram, você não" seria inalcançável, então a mensagem de Rafael das 09:14 nasce com 👍 de Diego e Bianca. Mesmo precedente da mensagem porta-anexo da Parte 1.
- **"Responder em thread" não está na toolbar.** §6 lista a ação, mas o destino é 2.2, que ainda não existe — abrir um painel inexistente seria pior que não oferecer. Entra junto com o painel.
- **Toda mutação é override por id.** Reagir, fixar, editar, deletar e trocar estado de entrega não tocam a fixture: viram um `Partial<Message>` por id no `messageStore`. Recarregar devolve o canal ao estado de §2 — que é o que §19 manda conferir. Deletar é lista de ids, não remoção.
- **Modal montado sob demanda.** Um `<dialog>` de confirmação por linha de mensagem (mesmo fechado) enchia o DOM e a árvore de acessibilidade com seis confirmações que ninguém pediu — apareceu na verificação, quando um seletor de texto casou com todas elas. Agora só monta quando pedido.
- **Afinador de cargo (§19.1).** Com uma identidade só, a UI que depende de permissão de moderação é inalcançável. O DevBar ganhou "Assumir <cargo do topo>", que sobrepõe os cargos locais da comunidade ativa; é o que torna verificáveis tanto "Deletar mensagem de outro autor" quanto o `#avisos` liberado para Moderador+. Não é persistido — cargo assumido é estado de sessão.
- **O link da mensagem é ilustrativo** (`p2p.app/m/<id>`): §4 define duas rotas e nenhuma delas é de mensagem. Quando a busca (1.2) existir, é ela que vai navegar até a mensagem, com o highlight breve de §9 (2.1).
- **Formatação some no Mobile.** Os três botões ficam a partir de Tablet para não espremer a barra do composer; o caminho equivalente (digitar `**`) continua disponível em qualquer largura, como §19.4 exige.
- **Sem "responder" nem "reagir" em canal somente-leitura** — as mesmas permissões que escondem o composer escondem as ações de escrita na mensagem.

#### Verificação feita (§19)

39 checagens em navegador headless: chip de reação nascendo sem destaque com contagem 2, indo a 3 destacado ao clicar e voltando ao clicar de novo; toolbar oculta sem hover e visível no hover; seletor de emoji abrindo, aplicando e fechando; menu de contexto com exatamente os itens que a permissão de Contribuidora autoriza; copiar link (conteúdo conferido no clipboard) e toast; fixar e desafixar trocando o rótulo "Fixado" de mensagem; responder inline com a barra no composer e a citação na mensagem enviada; edição inline com conteúdo carregado, vazio bloqueado, `Esc` descartando e "(editado)" aparecendo; deletar a própria mensagem sem modal; e, com o cargo assumido pelo afinador, "Deletar" aparecendo, o modal nomeando a consequência e o cancelar não deletando — mais o `#avisos` liberando o composer para o cargo alto e voltando a somente-leitura ao devolver o cargo. As 39 checagens da Parte 4 foram reexecutadas como regressão e seguem passando. Zero erros de console. `tsc -b`, `vite build` e `oxlint` limpos.

#### Próxima parte sugerida

**O slot de painel direito e seus três inquilinos** — painel deslizante (§6) com a regra de "abrir um fecha o outro", e dentro dele thread (2.2), membros (1.3) e busca (1.2, com `Cmd/Ctrl+K`). Vale notar uma contradição da spec a resolver ali: §5.6 e §16 descrevem o painel direito como **coluna fixa de 280px** no Desktop, enquanto §17 diz que abrir painel lateral **sobrepõe o conteúdo** no Desktop, para não causar reflow do texto em leitura. Duas seções contra uma linha — implementar como coluna e registrar a divergência, ou consultar quem escreveu a spec antes de decidir.

### Parte 6 — Painel direito: thread (2.2), membros (1.3) e perfil (1.4) — implementada em 2026-08-11

**Escopo:** o slot de painel deslizante e dois dos seus inquilinos, mais o popover de perfil que os dois acionam. A busca (1.2) ficou de fora — ela não é painel lateral, é command palette (ver Observações).

#### O que está funcional

- **Slot único de painel (§6, §15)** — membros e thread dividem o mesmo espaço, e abrir um fecha o outro por construção: o estado é um valor só no `uiStore`, não dois booleanos que poderiam ficar ambos verdadeiros. Fecha com `Esc`, com o "×" ou, no Tablet, clicando no scrim.
- **Layout por breakpoint (§16)** — **Desktop** coluna fixa no fluxo (280px membros, 320px thread), com o conteúdo cedendo espaço; **Tablet** overlay flutuante de 340px ancorado à direita, com scrim leve; **Mobile** tela cheia com "voltar".
- **1.3 Painel de membros** — agrupado por cargo do topo da hierarquia para baixo, com contagem no cabeçalho ("MODERADOR — 1"), avatar com dot de presença, nome na cor do cargo, ícone para quem está em voz agora, e busca rápida que filtra por nome (com empty state nomeando o termo). Cada membro aparece uma vez só, sob o cargo mais alto que tem.
- **1.4 Popover de perfil** — mesmo componente para os dois gatilhos que já existem (item da lista de membros e nome/avatar do autor de uma mensagem). Avatar G com presença, nome/apelido/identificador, cargos como pills coloridas e "Entrou em 3 de jan. de 2026" — a data que §8 usa no exemplo de Diego. Fecha com `Esc` ou clique fora, nunca navega, e não vaza da viewport (tenta a direita, cai para a esquerda, grampeia no topo). Em Mobile vira bottom sheet.
- **2.2 Painel de thread** — raiz fixada no topo separada por borda, respostas em ordem cronológica, composer próprio com placeholder "Responder na thread". Empty state "Seja o primeiro a responder" quando a thread acabou de nascer.
- **Entradas da thread** — o indicador "N respostas" sob a mensagem raiz no canal, e "Responder em thread" no menu de contexto (que a Parte 5 tinha deixado de fora justamente por não ter destino). Mensagem sem thread ganha uma na hora; com thread, o item vira "Ver thread".
- **Nome da comunidade abre os membros** (§8, 1.1) e o ícone "Membros" do cabeçalho do canal alterna o painel, ficando destacado enquanto ele está aberto.

#### Observações

- **A divergência de §17 foi resolvida a favor da coluna**, com aprovação de quem escreveu a spec: §5.6 (tabela do grid) e §16 (tabela de breakpoints) descrevem o painel direito como coluna fixa no Desktop; §17 diz que ele sobrepõe o conteúdo para evitar reflow do texto. Ficou coluna — duas seções contra uma linha —, e a divergência está anotada no próprio componente.
- **Larguras vêm de cada tela, não do grid genérico.** §5.6 lista "membros / thread — 280px"; §9 (2.2) pede 320px para a thread. Cada painel declara a sua e o slot honra.
- **A busca (1.2) não entra neste slot.** §15 a lista junto de membros/thread/configurações como painel deslizante, mas §8 (1.2) e §6 a descrevem como overlay centralizado no topo com scrim — command palette de `Cmd/Ctrl+K`. Vale a descrição da tela; a linha de §15 é a imprecisa.
- **Resposta de thread também aparece no canal.** É assim que §2 documenta: a resposta de Ana das 09:43 está na transcrição do canal *e* é a resposta da thread de moderação. A thread aqui é uma **vista** sobre as mensagens do canal, não um compartimento separado — diferente do Discord, igual ao dataset.
- **O indicador "N respostas" só aparece sob a raiz.** A resposta também carrega o `threadId`, e a primeira versão anunciava a thread embaixo das duas mensagens — apareceu na verificação, olhando o screenshot. Quem decide é o `rootMessageId` da thread, não a presença do campo.
- **Linha de mensagem dentro da thread não tem toolbar.** Reagir e responder ali abririam thread de dentro de thread, e a coluna de 320px não comporta a barra flutuante. A sub-conversa é leitura + composer.
- **Composer tem modo compacto.** No painel de 320px os seis controles espremiam o campo a ponto de o placeholder quebrar uma letra por linha (visto na verificação). O breakpoint do Tailwind mede a viewport, não o container, então quem sabe que o espaço é curto é quem monta o composer — a thread pede `compact` e perde os botões de formatação.
- **O grupo OFFLINE mostra só a contagem.** §2 define os offline de Vale do Código como um agregador ("307 offline"), sem registros individuais — não há lista para expandir, o que corresponde ao estado colapsado que §8 pede como padrão.
- **O popover de perfil não tem ações de moderação.** Atribuir cargo, timeout, expulsar e banir dependem de §10 (3.2/3.3) e do fluxo D12, que não existem. Para Ana, que é Contribuidora, o popover já está completo do jeito que está: a spec manda esconder o que a permissão não autoriza.
- **Ainda inertes no cabeçalho do canal:** "Threads" (lista de threads do canal, que a spec não detalha), "Mensagens fixadas" (aba de fixados, §6) e "Buscar" (1.2). "Membros" saiu da lista dos inertes.

#### Verificação feita (§19)

34 checagens em navegador headless: painel abrindo como coluna de 280px no Desktop com o conteúdo cedendo espaço; grupos por cargo na ordem da hierarquia com as contagens de §2 e o agregador "OFFLINE — 307"; busca rápida filtrando e explicando quando não acha; popover de perfil pelos dois gatilhos, com cargo em pill, a data de entrada de §8 e sem vazar da viewport; thread abrindo em 320px com raiz e resposta de §2, fechando o painel de membros ao abrir (slot único); resposta enviada dentro da thread aparecendo lá e elevando o indicador do canal para "2 respostas"; indicador ausente na mensagem que é resposta, não raiz; "Responder em thread" criando thread vazia; `Esc` fechando; nome da comunidade abrindo membros; e os três breakpoints (coluna 280 / overlay 340 com scrim / tela cheia 390 com "voltar"), sem overflow horizontal. As 39 checagens da Parte 4 e as 39 da Parte 5 foram reexecutadas como regressão e seguem passando. Zero erros de console. `tsc -b`, `vite build` e `oxlint` limpos.

#### Próxima parte sugerida

**1.2 Painel de busca** — command palette com `Cmd/Ctrl+K`, dois escopos (canal atual e comunidade inteira), chips de filtro (autor/canal/data/tipo), resultados agrupados por tipo, navegação por teclado, e o banner de "resultado potencialmente incompleto" quando o host está offline (o caso de Ateliê Aberto). É ela que fecha a Camada 1 e traz o highlight breve da mensagem alvo (§9, 2.1), que hoje não tem quem dispare. Depois disso sobram a Camada 2 de voz (2.3/2.4, a parte mais original da spec) e a Camada 3 de administração.

### Parte 7 — Busca (1.2) e fluxo C10 — implementada em 2026-08-11

**Escopo:** a última tela da Camada 1. Command palette com os dois escopos, filtros, resultados agrupados e a navegação que leva até a mensagem — incluindo o highlight de §9 (2.1), que existia na spec sem nada que o disparasse.

#### O que está funcional

- **Command palette (§8, 1.2)** — overlay centralizado no topo, 600px sobre scrim, `surface-elevated`; tela cheia no Mobile. Abre por `Cmd/Ctrl+K` de qualquer lugar dentro de uma comunidade ativa (escopo = comunidade) ou pela lupa do cabeçalho do canal (escopo = canal atual). Foco automático no campo, `Esc` fecha, clique fora fecha.
- **Escopo expansível** — no modo canal, um chip "Em #geral ×" mostra a restrição e removê-lo expande para a comunidade inteira, sem fechar nem perder o que já foi digitado. O placeholder acompanha ("Buscar em #geral" ↔ "Buscar em Vale do Código").
- **Filtros de §8 como chips** — Autor, Canal, Data (hoje / 7 dias / 30 dias) e Tipo (anexo / link / fixado). Cada um abre um menu, o chip aplicado mostra o valor e tem × próprio. Filtro sozinho, sem texto, já busca.
- **Resultados agrupados (§14)** — Mensagens, Canais, Membros, com a contagem no cabeçalho de cada grupo, teto de 20 por grupo e "Ver todos os resultados de mensagens" expandindo in-line. Mensagem mostra avatar, autor, canal e carimbo, com o trecho que casou destacado.
- **Navegação por teclado** — ↑/↓ percorrem os resultados dos três grupos como uma lista só, `Enter` ativa; o hover também move a seleção.
- **Fluxo C10 completo** — clicar (ou dar `Enter`) numa mensagem fecha a palette, abre o canal certo, rola até a mensagem e a destaca por ~1,5s em `accent-muted-bg`. Resultado de canal navega até ele; resultado de membro abre o painel de membros.
- **Estados de §8** — vazio mostra os canais visitados recentemente; digitando mostra skeleton; sem resultado diz "Nada encontrado para 'xyz'" e, se houver filtro, sugere removê-lo; e comunidade com host offline mostra o banner "Buscando só no histórico salvo neste dispositivo — Ateliê Aberto está offline".

#### Observações

- **A busca não é painel lateral.** §15 a lista junto de membros/thread/configurações como painel deslizante do slot direito, mas §8 (1.2) e §6 a descrevem como overlay centralizado com scrim — command palette. Vale a descrição da tela; a linha de §15 é a imprecisa. Divergência anotada no componente.
- **Histórico de canais visitados entrou na store.** O estado vazio de §8 pede "canais visitados recentemente", que não existia: `setActiveChannel` agora empilha até 5 ids por comunidade. É dado de sessão do leitor, como o colapso de categoria.
- **Canais e membros respondem só ao texto.** Filtrar "autor" ou "anexo" não se aplica a eles, e devolvê-los filtrados por critério que não os toca confundiria mais do que ajudaria. Os filtros valem para mensagens.
- **Resultado de membro abre a lista, não o popover.** O popover de 1.4 é ancorado num gatilho, e a palette fecha ao ativar — sem elemento para ancorar, o destino honesto é o painel de membros.
- **Mensagens mais recentes primeiro**, não por relevância: sem corpus grande, ordenar por score seria teatro; recência é um critério verdadeiro e previsível.
- **A busca varre só canais de texto.** Canal de voz não tem histórico para buscar.
- **Ainda inertes no cabeçalho:** "Threads" (lista de threads do canal, que a spec não detalha) e "Mensagens fixadas" (aba de fixados, §6). São os dois últimos.

#### Verificação feita (§19)

25 checagens em navegador headless: `Ctrl+K` e lupa abrindo com o escopo certo e o placeholder correspondente; foco automático; estado vazio com canais recentes; skeleton durante o debounce; a busca por "revisar" achando a mensagem de Bianca de §2 com canal, carimbo "hoje 09:41" e o trecho destacado; escopo expandindo de canal para comunidade; filtro de autor restringindo e a sugestão de remover filtro quando zera; filtro de tipo sozinho, sem texto; `Enter` navegando e destacando a mensagem alvo, com o highlight sumindo depois de ~1,5s; grupo de canais e navegação por teclado até ele; banner de resultado incompleto em Ateliê Aberto; e Mobile em tela cheia sem overflow horizontal. As 39 checagens da Parte 4, as 39 da Parte 5 e as 34 da Parte 6 foram reexecutadas como regressão e seguem passando. Zero erros de console. `tsc -b`, `vite build` e `oxlint` limpos.

Uma correção veio da verificação: o estado vazio ("canais recentes") piscava por 250ms no lugar do skeleton a cada primeira busca, porque a decisão olhava a query já debounced em vez da digitação viva.

#### Próxima parte sugerida

**Camada 2 — voz e compartilhamento de tela (2.3, 2.3.1, 2.4, 2.4.1, 2.4.2).** É o maior bloco que resta e o mais original da spec: grade de participantes com anel de fala, barra de chamada persistente que sobrevive à navegação entre comunidades, e o compartilhamento de tela com topologia estrela → árvore, fallback TURN, reparo de árvore, consentimento de repasse e painel do apresentador. Traz de uma vez os fluxos B5, B6, B7 e C11. Depois disso sobra a Camada 3 (3.1, 3.1b, 3.2, 3.3 + D12/D13), que destrava as ações de moderação do popover de perfil.

### Parte 8 — Voz e compartilhamento de tela (2.3, 2.3.1, 2.4, 2.4.1, 2.4.2) — implementada em 2026-08-11

**Escopo:** a Camada 2 de voz inteira, com os fluxos B5, B6, B7 e C11. Junto entraram duas dívidas antigas: o progresso do anexo, que não avançava sozinho (B8), e os botões do rail sem nome acessível, herdados da Parte 2. Ficaram de fora a Camada 3 inteira, os ícones "Threads" e "Mensagens fixadas" do cabeçalho do canal, e captura real de mídia — o mock simula.

#### O que está funcional

- **2.3 Canal de voz** — o canal de voz da lista, deliberadamente inerte desde a Parte 3, virou o ponto de entrada. Clicar entra na chamada e abre a grade **por cima** da área de conteúdo, sem trocá-la: o canal de texto continua atrás e segue destacado na lista (§4). Recolher devolve a barra persistente sem encerrar nada.
- **Tile de participante (§6)** — avatar, anel de fala (forma + movimento, nunca só cor) e ícones de estado sobrepostos: mudo, ensurdecido, câmera, compartilhando. Clicar abre o popover de perfil (1.4), que dentro da chamada ganha o **slider de volume individual** e, para quem tem `voice_mute_others`, "Silenciar nesta chamada".
- **Todos os estados de 2.3** — conectando (skeleton dos tiles + banner "Conectando…"), conectado, peer com problema pontual (sinal fraco só no tile dele), **mesh parcialmente degradado** (Bianca não conecta com Ana mas segue normal para os outros: tile "Sem conexão com você" + banner "Conexão instável com Bianca Souza") e falha total (banner `conn-failed` com "Tentar novamente").
- **Controles da chamada** — mudo, ensurdecer, câmera, compartilhar tela, atalho de dispositivos (visível e inativo até 3.1 existir) e sair, todos com nome acessível e ícones de 24px (§5.7).
- **2.3.1 Barra de chamada persistente** — Desktop/Tablet: 240×56 na base *da lista de canais*, `surface-elevated`, linha 1 com 🔊 + nome do canal (+ " · comunidade" só quando a chamada é de outra), linha 2 com a stack de avatares de 20px (3 + badge "+N") e os 3 controles compactos. Mobile: 390×64 fixa no rodapé da viewport, acima das três telas empilhadas, uma linha só e apenas **mudo e sair**, com alvo de toque de 44px. O **anel de fala continua visível na miniatura**, afinado para 1.5px; o badge "+N" nunca recebe anel.
- **Fluxo C11 inteiro** — trocar de canal de texto, trocar de comunidade e voltar: a chamada sobrevive a tudo, a barra acompanha (ganhando o sufixo da comunidade quando é outra) e clicar nela reexpande a grade sobre o conteúdo atual. Sair compartilhando pede confirmação nomeando a consequência; sem compartilhamento, sai direto.
- **2.4 Compartilhamento de tela** — badge de topologia ("Transmissão direta" com estrela até 5 espectadores, "Retransmissão em árvore" com nós acima disso), contagem de espectadores, seletor de qualidade, badge "Via TURN" com o tooltip de NAT restritivo, badge "Você está retransmitindo para N pessoas" só para quem de fato repassa, tela cheia, e o seletor simulado de janela/tela. Todas as transições usam banner não-bloqueante no topo do tile: "Otimizando distribuição…", "Reorganizando transmissão…", "Ninguém está assistindo agora" (§18) e a falha total com "Tentar novamente".
- **Fluxo B5 completo dos dois lados** — como espectadora (Rafael apresenta) e como apresentadora (Ana compartilha): preparando → estrela → otimizando → árvore → reparo → estável → encerrado.
- **2.4.1 / B6 Consentimento de repasse** — modal com o texto exato da spec, checkbox "Lembrar minha escolha para esta comunidade" (única coisa persistida desta parte), recusa sem tom de culpa e sem impacto, e a exceção da aba inativa: o modal **espera** o foco voltar em vez de assumir recusa por timeout.
- **2.4.2 Painel do apresentador** — só para quem apresenta, só em modo árvore: o badge ganha o ▾ e abre o popover de 280px com "Retransmitindo através de N pessoas" e uma linha por nó de primeiro nível (avatar, nome, dot de status, "retransmitindo para N pessoas"). Durante o reparo, a linha afetada pulsa em `conn-reconnecting` com o painel aberto e o badge ganha o dot pulsante com ele fechado; depois volta a `conn-ok`, com a contagem redistribuída. Nenhuma ação sobre nó individual — é painel de visibilidade.
- **Fluxo B7** e a exceção de B4 (voz com host offline é bloqueada com mensagem clara, em vez de tentar e falhar em silêncio).
- **Dívida do B8** — o progresso do anexo avança sozinho a partir dos 62% de §2 até "Baixado · Disponibilizando para outros", e a exceção do peer que cai no meio ("1 peer desconectou, continuando com 2") ficou alcançável.
- **Nome acessível nos botões do rail** — sem `aria-label`, o nome do botão de comunidade era o que estivesse desenhado: as iniciais, ou só o emoji.
- **Componentes novos de §6**: `Slider` (volume) e `Checkbox`. `Avatar` ganhou o degrau de 20px de 2.3.1 e `Popover`, o posicionamento abaixo do gatilho que 2.4.2 pede.

#### Observações

- **§2.4.2 pede duas coisas que não cabem na mesma tela, e as duas ficaram alcançáveis.** O conteúdo mockado põe Ana como nó de primeiro nível de um compartilhamento que ela não apresenta, enquanto o painel é exclusivo de quem apresenta — com uma identidade só, não dá para ver os dois ao mesmo tempo. Como espectadora, Ana recebe exatamente o badge "Você está retransmitindo para 2 pessoas" da spec; como apresentadora, vê o painel com a mesma aritmética (2 + 3 + os 2 nós = 7 espectadores). A distribuição é calculada, não fixa: o resto vai para o último nó, que é o que produz o 2 e o 3 do exemplo.
- **Quem falha no mesh é Bianca.** §9 (2.3) usa "Conexão instável com Diego Alves" no exemplo do banner e §11 (B7) diz que a conexão com Bianca falha. Vale o fluxo, que é o caminho percorrido; o sinal fraco de Diego — o outro estado, "problema pontual" — está no afinador.
- **Entrar na chamada abre a grade, mas nunca troca o conteúdo.** §9 (2.3) descreve a grade aparecendo ao entrar e §4 é taxativo que a área de conteúdo não muda. As duas coisas convivem porque a grade é overlay sobre a coluna de conteúdo: o canal de texto continua montado atrás, e recolher devolve a leitura no ponto em que estava.
- **Ensurdecer implica mudo** (e desensurdecer devolve a voz). A spec lista os dois controles sem definir a relação; é a convenção do gênero e evita o estado incoerente de "falo mas não ouço ninguém".
- **Um degrau de avatar a mais.** §6 fecha o Avatar em 24/32/80px, mas §9 (2.3.1) pede nominalmente 20px na stack da barra, com anel de 1.5px. Como 2.3.1 é a spec mais específica, entrou o degrau `xs`, usado só ali. A waveform não aparece nesse tamanho — 2.3.1 pede só o anel afinado, e as barrinhas em 20px viram sujeira.
- **Espectador de compartilhamento não é o mesmo que participante da chamada.** §2 já documenta isso: o compartilhamento de Rafael tem 7 espectadores num canal com 3 pessoas. A contagem do badge e a topologia leem a lista de espectadores; a grade mostra quem está na voz.
- **O consentimento é perguntado na transição estrela→árvore**, não a cada espectador novo — é quando a árvore passa a precisar de nó intermediário. Perguntar de novo a cada entrada viraria insistência, e a spec não pede.
- ~~**Qualidade é de quem assiste; parar é de quem apresenta.** §9 (2.4) lista as duas ações juntas sem separar por papel. Ajustar a própria recepção não afeta ninguém, então ficou disponível para todos; encerrar a transmissão, só para o apresentador.~~ **Corrigido em 2026-08-26 (§87, delta U-25).** A premissa era falsa: em estrela **não existe "própria recepção" para ajustar**. O perfil de §17.5 vira `maxBitrate` no `RTCRtpSender` do **apresentador**, então o pedido do espectador gastava o upload de outra pessoa — e essa pessoa não tinha como recusar. Resolução, taxa de quadros e qualidade passaram a ser de quem transmite; o espectador tem um controle só, "Ocultar vídeo", que é exibição local e não alcança a transmissão de ninguém.
- **Tela cheia é CSS, não a Fullscreen API.** O objetivo é o tile ocupar a tela do app; pedir fullscreen do navegador exigiria gesto e permissão para um vídeo que não existe.
- **O volume individual aparece a partir da grade**, não da lista de membros. §8 (1.4) condiciona a "só se ambos em voz juntos", e é a grade que garante isso sem ambiguidade. "Ensurdecer nesta chamada" não existe: ensurdecer é estado de quem ouve, não algo que se aplica a outra pessoa — o equivalente é o slider em 0.
- **Sair é instantâneo.** §9 (2.3) lista um estado "saindo"; encerrar uma chamada local não tem latência para simular, e inventar meio segundo de espera seria teatro.
- **`useIsMobile` existe porque a diferença é estrutural.** Em Mobile a grade vira lista vertical, e carrossel horizontal acima de 4 participantes — isso muda o que é renderizado, não só como. Onde CSS resolve, continua valendo `tablet:`/`desktop:`; o hook não é atalho para isso.
- **Só a resposta ao consentimento sobrevive ao reload.** A chamada em si é estado do agora, como a saúde de host da Parte 4: recarregar devolve o app ao estado documentado em §2.
- ~~**Compartilhamentos simultâneos (§18) não entraram** — uma sessão de compartilhamento por chamada. É um edge case sem fluxo próprio, e a grade de tiles grandes que ele pede duplicaria toda a lógica de topologia por tile.~~ **Revertido em 2026-08-26 (§87, U-10 revogada).** O canal aceita várias transmissões, uma por apresentador, e a grade de tiles grandes de §18 voltou. O argumento de "duplicaria toda a lógica de topologia por tile" caducou com B26: não há mais topologia por tile a duplicar — a estrela é a única, e A20 tirou a árvore do v1.
- **Uma esquisitice pré-existente apareceu na regressão:** com o painel de membros e um popover de perfil abertos ao mesmo tempo, o primeiro `Esc` fecha só o painel — o popover, que está por cima, exige um segundo `Esc`. É a ordem de registro dos dois listeners de `Esc`, vinda da Parte 6. Não foi mexido nesta parte: cada `Esc` fecha uma camada, o que é defensável, mas quem encostar em 3.x pode querer inverter a prioridade.
- **Afinador de desenvolvimento ampliado** (§19.1): falha total do mesh, peer com sinal fraco, Rafael compartilhando, +1/0 espectadores, forçar TURN, queda de nó da árvore, falha na transmissão, esquecer o consentimento e o peer do anexo caindo. A queda de nó dispara **com 2s de atraso** de propósito: clicar no afinador fecha o popover de 2.4.2, e o estado a observar é justamente a linha pulsando com ele aberto.

#### Verificação feita (§19)

136 checagens em navegador headless (Chrome via CDP, com mouse e teclado reais — clique sintético não gera ativação do usuário), a 1440×900 e 390×780, distribuídas em cinco roteiros: voz e barra persistente (37), compartilhamento como espectadora (26), como apresentadora (27), bordas e dívidas (18) e regressão das Partes 3-7 (28).

Conferidos, entre outros: canal de voz clicável abrindo a grade sem trocar o conteúdo; "Conectando…" com skeleton e o mesh parcial de B7; anel de fala animado, com o peer sem mesh fora do ciclo de fala; os seis controles e o efeito de cada um no tile; a barra de 240×56 ancorada depois do rail com stack de 3 + "+1" e três controles; C11 completo, incluindo o sufixo da comunidade e a reexpansão; a sequência estrela → otimizando → árvore com 3, 5 e 6 espectadores; o texto exato do modal de consentimento, a recusa sem badge e a aceitação produzindo "Você está retransmitindo para 2 pessoas"; o reparo de árvore nas duas situações de 2.4.2 (painel aberto pulsando a linha, painel fechado pulsando o badge) e a volta a `conn-ok`; TURN com tooltip; falha de transmissão e retomada; o painel de 280px com a soma batendo com o badge; "Ninguém está assistindo agora" sem encerrar a transmissão; a confirmação de saída com compartilhamento ativo; a chamada sozinha com o hint de §18; voz bloqueada com host offline; o rail com nome acessível nos três ícones; o anexo saindo de 62% até "Baixado · Disponibilizando para outros" e o aviso de peer que cai; e, no Mobile, a barra de 390×64 fixa no rodapé com dois alvos de 44px, a grade em tela cheia e nenhum overflow horizontal. Zero erros de console. `tsc -b`, `vite build` e `oxlint` limpos.

Três correções nasceram da verificação: os espectadores do compartilhamento remoto passaram a ser encabeçados pela identidade local (sem isso Ana nunca virava nó de primeiro nível, e o badge de §2.4.2 era inalcançável); o afinador de "+1 espectador" passou a reconstruir a audiência a partir de quem está na chamada, e não só dos espectadores extras, para que a transição estrela→árvore fosse repetível; e a queda de nó ganhou o atraso de 2s descrito acima.

#### Próxima parte sugerida

**Camada 3 — administração (3.1, 3.1b, 3.2, 3.3 + fluxos D12 e D13).** É o que resta da spec: configurações de conta com diagnóstico de rede (onde o CGNAT de `CLAUDE.md:45` finalmente aparece nomeado), configurações da comunidade com convites e zona de perigo, gestão de cargos e permissões, e as ferramentas de moderação com o log de auditoria. É também o que destrava as ações condicionais do popover de perfil (1.4) — atribuir cargo, timeout, expulsar, banir —, hoje ausentes porque não têm destino, e o que aposenta o afinador de cargo do DevBar.

### Parte 9 — Camada 3: administração (3.1, 3.1b, 3.2, 3.3) — implementada em 2026-08-11

**Escopo:** a última camada da spec, com os fluxos D12 e D13. Configurações de conta, configurações da comunidade, cargos e permissões, ferramentas de moderação — e as ações condicionais do popover de perfil (1.4), que existiam na spec desde a Parte 6 sem destino para onde levar o clique. Com isto **toda a spec de §7 a §11 está em código**.

#### O que está funcional

- **3.1 Configurações de conta** — modal de 720px com as cinco tabs verticais de 180px. **Minha conta**: nome editável, "Gerar outra cor", identificador local e chave truncada em somente-leitura, e a zona de perigo com "Sair desta identidade" sob confirmação que diz o que não tem volta. **Dispositivos**: três selects, sliders de entrada/saída e "Testar microfone" com medidor de nível ao vivo. **Aparência**: informativa, sem toggle que não faz nada. **Notificações**: toggle geral mais Tudo / Só menções / Nada por comunidade. **Rede**: diagnóstico somente-leitura com os dois desfechos de §10 (NAT moderado e CGNAT), contagem de peers e re-execução com skeleton de ~1,5s.
- **3.1b Configurações da comunidade** — nome, descrição e ícone editáveis com **salvamento automático** (§13: debounce de 800ms e toast "Alterações salvas", sem botão Salvar); lista de convites ativos com quem criou, usos e expiração, copiar link, revogar e criar novo (expiração e limite opcionais); e a zona de perigo que muda com o papel: quem não hospeda vê "Sair da comunidade", quem hospeda vê **"Encerrar comunidade" com dupla confirmação** — §18 é explícita em que host não sai, encerra.
- **3.2 Cargos e permissões** — lista à esquerda ordenada por hierarquia, editor à direita: nome (1-32, obrigatório), as **7 cores curadas** (nunca color-picker livre), toggle "Mencionável", checklist de permissões agrupada nas quatro categorias de §10, e a aba "Membros com este cargo" com remoção por linha. Criar, editar, deletar (exceto Fundador e o cargo base Membro, com a confirmação que pergunta "Remover o cargo, não os membros?") e **reordenar a hierarquia por arrasto**, com o Fundador travado no topo.
- **3.3 Ferramentas de moderação** — sub-abas Log de auditoria / Banidos / Timeouts. O log traz as duas entradas de §2 com ícone por tipo, motivo, responsável e carimbo relativo, filtro por tipo de ação e "Carregar mais" em lotes de 25 (§14). Banidos abre com a **nota de honestidade fixa** de §10 e permite revogar. Timeouts mostra contagem regressiva ao vivo e remoção.
- **Fluxo D12 completo** — botão direito numa mensagem mostra "Banir <autor>" só para quem tem `ban_members` **e** hierarquia superior; o modal nomeia o alvo, aceita motivo e repete a nota de honestidade; confirmar dispara o toast, **tira as mensagens da pessoa do canal**, some com ela da lista de membros e registra a entrada no log em tempo real.
- **Fluxo D13 completo** — criar cargo em branco, nomear, escolher cor, marcar permissões, reordenar na hierarquia e atribuir a um membro pelo popover de perfil, com as duas exceções: não dá para arrastar acima do Fundador nem deletar o cargo base.
- **1.4 completo** — o popover ganhou "Atribuir cargo" (com a lista de cargos alternáveis), "Aplicar timeout", "Expulsar" e "Banir", todos condicionados a permissão **e** à regra de hierarquia de §10, num seletor único (`selectCanModerate`) em vez de repetir a checagem em cada ponto.
- **Componentes novos de §6**: `Tabs` (vertical e horizontal), `Toggle` e `Select` — o que faltava da linha de formulário. Entradas: avatar do rail → 3.1; engrenagem no cabeçalho da lista de canais e botão direito no ícone do rail → 3.1b.

#### Observações

- **O nome da comunidade continua abrindo os membros.** §8 (1.1) e §4 dizem que o nome no topo da lista de canais abre o painel de membros; §10 (3.1b) diz que ele abre as configurações. Duas seções contra uma: o nome ficou como estava e as configurações ganharam botão próprio ao lado, além do menu de contexto do ícone no rail que a própria §10 já oferecia como segunda porta.
- **A armadilha do Zustand v5 apareceu pela terceira vez, e agora na origem.** Editar a comunidade fazia `selectCommunity` mesclar fixture+override e devolver **objeto novo a cada chamada** — o app entrava em "Maximum update depth exceeded" no instante em que alguém digitava no nome. `useShallow` não salva disso (compara elemento a elemento por referência), e desta vez o problema não era do componente: era do seletor compartilhado. A correção é um cache `WeakMap` chaveado pelo próprio objeto de override, que morre junto com ele na próxima edição — assim toda tela que resolve uma comunidade ou um cargo recebe referência estável de graça.
- **Reordenar cargo tem arrasto e botões.** §10 (3.2) pede lista arrastável e §17 descreve o item levantando; o arrasto é por evento de ponteiro (não a API HTML5, que não sobrevive a teste com entrada real). Só que arrastar não existe no teclado, e §19.4 exige caminho equivalente — daí os botões de mover para cima/baixo, que aparecem no hover e no foco.
- **`deleteRole` entrou no domínio.** §2 lista quatro tipos de ação de moderação, mas o log de §2 já registra "criou o cargo Contribuidor", e o código da Parte 1 tinha acrescentado `createRole` e `revokeBan` por isso. Deletar cargo é o par que faltava.
- **Banir usa Diego, não `Usuário#4471`.** §11 (D12) narra o ban de `Usuário#4471`, que existe só como alvo no log de §2 — a pessoa foi banida há dois dias e não tem mensagem no canal para clicar com o botão direito. O fluxo é percorrido contra um membro real da transcrição, com o afinador de cargo assumindo o cargo alto; `Usuário#4471` segue aparecendo na lista de banidos, como §2 documenta, e é ele quem exercita "Revogar banimento".
- **O que a sessão edita não é persistido.** Nome de comunidade, cargos, convites criados, bans e timeouts são override de sessão, como as mensagens desde a Parte 4: recarregar devolve o app ao estado de §2, que é o que §19 manda conferir. Persistem só as preferências de 3.1 (dispositivos e notificações) — que são de quem usa, não da comunidade.
- **O afinador saiu de cima do avatar.** O DevBar estava em `left-4`, exatamente sobre o avatar da identidade no rodapé do rail — que agora é o gatilho de 3.1. Um afinador de desenvolvimento tapando um controle de produto é bug de dev, e apareceu no primeiro teste desta parte.
- **A esquisitice do `Esc` da Parte 8 foi corrigida.** Com painel e popover abertos ao mesmo tempo, o primeiro `Esc` fechava o painel de baixo e o popover exigia um segundo. Agora o painel ignora o `Esc` quando há popover ou modal aberto por cima: uma camada por vez, de cima para baixo.
- **`memberCount` dos cargos não é recalculado.** É o número que §2 documenta; recontar a cada atribuição faria a lista de Vale do Código discordar dos 340 membros da fixture, dos quais só 5 são materializados.

#### Verificação feita (§19)

70 checagens novas em navegador headless com entrada real (44 nas telas de configuração, 26 em moderação), a 1440×900 e 390×780. Conferidos, entre outros: o modal de 720×600 com as cinco tabs; medidor de nível animando durante o teste de microfone; aparência sem seletor de tema; os três níveis de notificação por comunidade; diagnóstico de rede com skeleton e conclusão; a Contribuidora vendo **só** a aba Geral e as abas Cargos/Moderação aparecendo com a permissão; convite criado, copiado e revogado; edição salvando sozinha com o nome novo aparecendo no shell atrás; os 4 cargos de §2 na ordem da hierarquia, as 7 cores, a reordenação e o Fundador travado; cargo novo com erro de nome obrigatório; log de auditoria com as duas entradas de §2, motivo, carimbo relativo e filtro por tipo; a nota de honestidade dos banidos; timeout aplicado, contado em regressiva e removido; "Banir" ausente para quem não tem permissão **e** ausente na mensagem do Fundador pela hierarquia; o ban levando as mensagens e o membro embora e registrando no log com o motivo digitado; a dupla confirmação de encerrar comunidade; e o Mobile com as tabs viradas lista, "voltar" e sem overflow horizontal.

As 136 checagens das Partes 3-8 foram reexecutadas como regressão e seguem passando — 206 no total. Zero erros de console. `tsc -b`, `vite build` e `oxlint` limpos.

Três correções nasceram da verificação: o loop de render de `selectCommunity` descrito acima, o afinador cobrindo o avatar do rail, e o log de "revogar banimento" que registrava o id cru em vez do identificador exibido quando o ban vinha da fixture de §2.

#### O que resta

Nenhuma tela **da spec como ela estava escrita naquele momento**. §7 a §11 estavam implementadas — Camadas 0, 1, 2 e 3, os 13 fluxos de então (A1-A3, B4-B8, C9-C11, D12-D13) e os estados transversais de §12. O que sobrava era fora do escopo: o backend P2P real (Hyperswarm/Hypercore/Hyperdht), que substitui as fixtures por réplica de verdade, e os itens marcados como fora do v1 no Apêndice A.

Depois disso a spec ganhou duas rodadas de correção, ambas pendentes de código: **§10 3.4** com os fluxos **D14/D15** (Parte 10), e os catorze buracos fechados na auditoria de 2026-08-12 (Parte 11). Ambas abaixo.

### Parte 10 — Gestão de canais e categorias (3.4, D14, D15) — implementada em 2026-08-12

**Por que esta parte existe:** a spec original ia da criação da comunidade direto pro uso dela, sem nunca dar um jeito de criar o segundo canal. Não foi corte — não estava em "Fora de escopo explícito" (§0) nem no Apêndice A, os dois lugares onde todo corte foi registrado. Três indícios de que era esquecimento, não decisão: o Apêndice A cortava "drag-and-drop de canais/categorias — **ordem fixa por criação**", o que pressupõe canais criados em runtime; a permissão `gerenciar canais` estava no checklist de 3.2 e no cargo Moderador (§2) sem nenhuma tela por trás; e §7 (0.4) manda a comunidade nascer com um canal "para nunca ficar sem nenhum", deixando toda comunidade criada no mock presa a um `#geral` só.

**Estado do código antes desta parte** (`frontend/src/store/communityStore.ts`): o bucket `createdChannels` existe e é populado uma única vez, por `createCommunity`; não há `createChannel`, `updateChannel`, `deleteChannel` nem nada de categoria. `ChannelList.tsx` tem só o botão de configurações no cabeçalho, sem "+" nem menu de contexto. Os canais visíveis vêm todos das fixtures de §2.

**Escopo:** §10 3.4 inteira — os cinco gatilhos na lista de canais, os modais de criar/editar canal, renomear/excluir categoria, as três confirmações destrutivas, a regra do último canal, o gating por `gerenciar canais` com a exceção de host offline (desabilitado, não oculto), o registro no log de auditoria, e os fluxos D14 e D15. Mais as regras de §13 (validação e slug), §14 (canal novo entra no fim), §15 (lista de confirmações), §17 (três microinterações novas) e os nove edge cases de §18.

**Por que vale fazer no mock, antes do backend:** é uma das superfícies que o backend real mais precisa acertar — cada criação de canal vira um append no log Hypercore do host, com propagação aos peers, checagem de permissão e reconciliação de quem estava offline. Validar a UX disso contra fixtures é mais barato do que descobrir o formato certo com Hyperswarm no meio. A camada de troca já está provada: ação no Zustand mexendo num bucket de override, exatamente como cargos e convites — trocar a mutação local por append no Hypercore não toca componente nenhum.

**Ponto conferido:** a observação da Parte 9 dizendo que "o que a sessão edita não é persistido" estava desatualizada — o `partialize` do `communityStore` exclui apenas `localRoleOverrides`, então canal criado, silenciado ou lido sobrevive ao reload. Ficou assim de propósito; voltar ao dataset de §2 é papel do `resetCommunities` do afinador (§19.1).

#### O que ficou funcional

- **Store** (`communityStore.ts`): `createChannel`, `updateChannel`, `moveChannel`, `deleteChannel`, `createCategory`, `renameCategory`, `deleteCategory` (com os dois caminhos — mover os canais ou levar tudo junto), mais `channelOverrides`/`categoryOverrides` e as listas de excluídos, na mesma divisão fixture-vs-sessão que comunidades e cargos já usavam. `selectChannel` e `selectCategory` passaram a mesclar override com o `WeakMap` de referência estável, herdando a correção da Parte 9.
- **Gatilhos na lista (§8, 1.1)**: "+" no cabeçalho, "+" por categoria (no hover em Desktop/Tablet, fixo em Mobile), "+ Nova categoria" no fim, menu de contexto no canal e no header da categoria. Nada aparece sem `manage_channels`.
- **Modais**: criar canal (segmented control Texto/Voz, slug ao vivo, categoria com "+ Nova categoria…" inline, tópico, somente-leitura com checklist de cargos), editar canal com auto-save e zona de perigo, renomear categoria, e as três confirmações destrutivas com a nota de honestidade P2P.
- **Regra do último canal** e **log de auditoria** (`createChannel`/`deleteChannel`/`createCategory`/`deleteCategory` entraram em `ModerationActionType` e no `describe()` de 3.3).
- **§8, 1.1.1 junto**: silenciar canal e marcar como lido saíram na mesma passada, porque dividem o mesmo menu.

#### Observações

- **A verdade sobre o host não está na fixture.** O primeiro teste falhou porque `ChannelList` lia `community.connectionHealth.hostStatus`, que o afinador não toca — quem sabe se o host caiu é o `connectionStore` (`useHostStatus`). Qualquer tela nova que dependa de host online tem a mesma armadilha.
- **`Esc` com formulário preenchido não fecha**, pede descarte (§15) — o teste precisou aprender isso, e é o comportamento certo.
- **Dois módulos separados por causa do fast refresh**: `useContextMenu` e o modelo do formulário (`channelFormModel.ts`) saíram dos arquivos de componente. O nome do modelo evita `channelForm.ts` ao lado de `ChannelForm.tsx`, que colidiria em sistema de arquivos sem distinção de maiúsculas.

#### Verificação feita (§19)

13 checagens em navegador headless a 1440×900, com o dataset de §2: Contribuidora sem nenhum gatilho visível; afinador assumindo o cargo e o "+" aparecendo; prévia "#ajuda-design" acompanhando a digitação; canal criado entrando no fim da categoria e virando o ativo; nome duplicado bloqueando com erro inline; `Esc` pedindo descarte; menu de contexto com silenciar (e o ícone de mudo aparecendo); exclusão com a nota P2P e o canal sumindo; e host derrubado deixando o "+" **visível e desabilitado** enquanto "Nova categoria" some. Zero erros de console além do 404 de favicon, que é do scaffold. `tsc -b`, `oxlint` e `vite build` limpos.

### Parte 11 — Buracos da spec fechados na auditoria de 2026-08-12 — implementada em 2026-08-12

**Por que esta parte existe:** depois do buraco da gestão de canais, a spec inteira foi auditada contra o código, seção por seção. Apareceram mais catorze buracos, e eles têm um padrão único que vale nomear porque prediz onde procurar o próximo: **a spec documenta estados nas fixtures sem nunca dar o verbo que os produz.** `#ajuda-backend` nasce silenciado, `#avisos` nasce somente-leitura, membros têm apelido, identidades têm quatro estados de presença — todos são substantivos de §2 sem ação correspondente em tela nenhuma. O sintoma no código é sempre o mesmo: **campo lido em N lugares, escrito em zero** (`muted` só em `mocks/dataset.ts`; `nickname` lido em quatro arquivos; `identityStore.ts:60` expõe `setPresence` sem um único chamador).

**O que foi acrescentado à spec:**

| # | Buraco | Onde foi fechado |
|---|---|---|
| 1 | Silenciar canal — prometido pela premissa 7, sem UI | §8, **1.1.1** (menu de contexto do canal) |
| 2 | Aviso de host fechando o app — listado em §3, nunca especificado | §10, **3.5** + linha em §12 + §15 |
| 3 | Seletor de presença — 4 estados no modelo, nenhum lugar pra escolher | §10 (3.1, aba Minha conta) + atalho em §8 (1.4) |
| 4 | Aba Fixados/Arquivos/Links — citada 2×, nunca definida | §9, **2.1.2** |
| 5 | Apelido — lido em 4 lugares do código, escrito em nenhum | §8 (1.4) + premissa 11 + §13 |
| 6 | Câmera sem superfície de vídeo (produto é "voz/vídeo/tela") | §9, **2.3.2** + premissa 9 |
| 7 | "Copiar link da mensagem" apontava pra rota inexistente | §4 (rota `/m/:code`) + premissa 10 + §9 (2.1) |
| 8 | Fila offline não durável — B4 prometia entrega diferida | Premissa 5 + B4 + §12 + §18 |
| 9 | Não-lida/menção invisíveis fora da comunidade aberta | §8 (1.1, "Não-lidas no rail") |
| 10 | "Editar perfil" (1.4) sem destino | §8 (1.4) → abre 3.1 |
| 11 | "Marcar como lido" inexistente | §8, 1.1.1 |
| 12 | `Reaction.usuários[]` sem superfície | §9 (2.1, tooltip do chip) |
| 13 | Data/hora/fuso/locale nunca especificados | §5.10 (novo) |
| 14 | `prefers-reduced-motion` implementado no código, ausente da spec | §5.9 |

**Um destes já tinha sido avistado de dentro.** A Parte 5 registrou, sobre o link de mensagem: *"§4 define duas rotas e nenhuma delas é de mensagem"* — o buraco nº 7 foi notado por quem implementava, virou nota de rodapé e nunca subiu pra spec. Vale como sinal de processo: observação de parte não fecha buraco; só a spec fecha. As notas históricas das Partes 1-9 seguem descrevendo o código daquele momento e **não** foram reescritas — onde elas conflitam com o texto acima, o texto acima é que vale.

**Três premissas novas, contestáveis** (§0, 9-11) — foram decisões tomadas para não travar o adendo, e são o que revisar primeiro: **câmera fica no escopo** e vai por mesh, não pela árvore (cortar contradiria o nome do produto); **link de mensagem ganha rota**, com o argumento de que canal selecionado é estado de navegação enquanto link de mensagem é referência a um artefato que viaja pra fora da sessão — se isso não convencer, o corte alternativo é remover "Copiar link da mensagem" de 2.1; **apelido é auto-atribuído**, para não inventar uma permissão fora do checklist de §10.

**Pendência herdada, ainda aberta:** §16 manda o rail virar lista vertical com nomes abaixo de 640px (a "tela 1" do Mobile). A Parte 3 registrou isso em 2026-08-11 e as Partes 4 a 11 não voltaram nela — `MobilePane` ainda só conhece `"channels" | "content"`. **É o que resta de toda a spec**: nenhum outro item de §7-§19 está sem código.

#### O que ficou funcional

Os catorze, em duas levas. **Primeira leva** (menus, badges e abas que já existiam): 1 silenciar canal e 11 marcar como lido em `ChannelContextMenu`; 9 traço de não-lida e badge de menção no rail (`CommunityIcon` + `selectCommunityUnread`); 3 presença em 3.1 e no popover; 5 apelido auto-atribuído, com `selectMemberLabel` passando a alimentar lista de membros, menções e autocomplete; 10 "Editar perfil" abrindo 3.1; 12 tooltip de quem reagiu. O 14 (`prefers-reduced-motion`) já estava no CSS desde a Parte 1 — faltava só na spec.

**Segunda leva** (superfície e infraestrutura novas):

- **4 · §9, 2.1.2** — `ChannelInfoPanel` no slot direito, com as três abas, empty state nomeado por aba, desafixar para quem tem `pin_messages`, banner de réplica parcial com host offline, e o alfinete do cabeçalho do canal como gatilho. A aba Links extrai URLs do corpo das mensagens e mostra host + URL, **sem unfurl** (Apêndice A).
- **13 · §5.10** — `lib/format.ts` passou a "12 mar 09:14" / "12 mar 2025 09:14", separador de dia com dia da semana, `formatCountdown` compartilhado com 3.3, relativo virando data absoluta além de ~1 ano, e `isClockAhead`/`displayDate` para o relógio adiantado.
- **2 · §10, 3.5** — `HostExitDialog` conta online e em chamada por comunidade hospedada, traz a nota de honestidade, tem "Cancelar" como ação padrão com foco e "Avisar quem está online" postando o aviso no canal padrão. O `beforeunload` fica registrado enquanto houver gente conectada **e não houver shell Electron** (§92: dentro do Electron ele veta a saída em silêncio, e quem guarda é o main).
- **6 · §9, 2.3.2** — tile troca o avatar por superfície de vídeo simulada (`animate-camera-drift`), espelhada só para quem se vê. Não há teto de câmeras (§90). Conexão degradada derruba o vídeo e devolve o avatar: o áudio tem prioridade.
- **7 · §4** — rota `/m/:code` com `lib/messageLink.ts` (base64url de comunidade+canal+mensagem, para o link não anunciar a estrutura), `MessageRoute` guardando a referência como o convite já fazia, e `MessageLinkResolver` com os três desfechos de falha.
- **8 · premissa 5** — `messageStore` ganhou `persist` com `partialize` que grava **só a fila**: mensagem entregue continua morrendo com a sessão (§19), pendente sobrevive. O banner de host offline soma a contagem, e excluir um canal descarta a fila dele com aviso nomeado (§18).

#### Observações

- **A armadilha do Zustand v5 apareceu pela quarta vez, e derrubou o app inteiro.** `useHostedImpact` montava a lista dentro do seletor e devolvia array novo a cada chamada — "Maximum update depth exceeded" no instante em que o shell montava, com tela branca. `useShallow` não salvaria: cada item também é objeto novo. A correção é a mesma da Parte 4 — o seletor devolve referências já estáveis (`useJoinedCommunities`) e a lista sai de um `useMemo`. Vale a regra: **seletor de Zustand nunca constrói objeto ou array novo**.
- **§5.10 contradizia §2 e foi corrigida na spec, não no código.** A tabela que a auditoria escreveu dizia que o carimbo de hoje é `09:14`; a transcrição de §2 e a implementação verificada desde a Parte 3 dizem `hoje 09:14`. O dataset é o registro mais antigo e já testado — a tabela é que estava errada.
- ~~**O aviso de saída só é alcançável pelo afinador.**~~ **Superado (§78 e §92).** No Electron o gatilho é real: o main segura o primeiro `close`, pergunta o impacto por `exit-impact` e espera a resposta do `HostExitListener`, montado na raiz. O afinador continua existindo para quem roda no navegador.
- **"Avisar quem está online" posta como o host, não como sistema.** §2 não tem tipo de mensagem de sistema, e inventar um seria mudar o modelo por causa de um botão; o texto ficou em primeira pessoa para não fingir uma voz que não existe.
- **O erro de permissão de câmera do sistema operacional ficou de fora.** O mock não chama `getUserMedia`, então não há como o erro acontecer de verdade; entraria só como mais um botão de afinador, e preferi não inflar o DevBar. É o único estado de 2.3.2 sem código.

#### Verificação feita (§19)

17 checagens novas em navegador headless a 1440×900: carimbo de §2 preservado; painel abrindo com a fixada de Bianca, o anexo de "1,24 GB · 3 peers + host" e o empty state de Links; menu da mensagem copiando um `/m/…`, a rota abrindo o canal certo e o link de comunidade alheia sendo recusado com CTA de convite; aviso de saída contando quem cai, com nota de honestidade e ação de avisar; câmera ligando e o tile ganhando a superfície de vídeo; e a fila offline aparecendo no banner e **sobrevivendo ao reload**. As 22 checagens das Partes 10-11 foram reexecutadas como regressão e seguem passando — 39 no total. Zero erros de console. `tsc -b`, `oxlint` e `vite build` limpos.