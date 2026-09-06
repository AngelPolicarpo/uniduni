# Backlog

O que está aberto, hoje. Uma linha por item: **nome e ponteiro**. A descrição mora na
referência — repetir aqui seria a segunda cópia a envelhecer.

Não normativo. Atualizado em 2026-09-06 (§133). **§133** respondeu a uma pergunta do
operador — por que copiar o convite não funciona — e achou três defeitos empilhados no mesmo
botão. **Todo botão de copiar do produto estava quebrado**: `navigator.clipboard.writeText`
pede `clipboard-sanitized-write` ao Chromium e o handler de permissão do main concedia só
`media`, então a promessa rejeitava com `NotAllowedError` — link de convite, link do canal,
link da mensagem e chave pública, desde que o handler existe. Medido em harness próprio, com
a lista de permissões como única variável. Três dos quatro chamadores descartavam a promessa
com `void` e mostravam "copiado" logo depois, então a interface afirmava um sucesso que nunca
houve; o único que tratava a recusa era o link do canal, e por isso era o único lugar onde o
defeito aparecia. Por baixo disso, a linha de convite violava **U-04**: o adaptador fazia
`code: i.code ?? i.invitePublicKey` e punha a chave pública de 64 hex no campo do código —
em fonte monoespaçada, com botão de copiar ao lado — quando o núcleo já dizia por
`codeAvailable` que o código não estava disponível. E o que se copiava, `p2p.app/invite/…`,
não é rota de protocolo nem casa a gramática de `codeOrLink`: passou a ser
`comunidadep2p://join/<CODE16>`, a única forma que o sistema operacional abre e que o campo
de 0.3 também aceita. Duas emendas: **§25.4 regra 7** (a lista de permissões de janela é
fechada e escrita, a leitura da área de transferência continua recusada, e quem chama uma
API que pede permissão trata a recusa) e **`frontend.md` 3.1b** (as três regras da lista de
convites). A decisão de permissão saiu de `main/index.ts` para módulo próprio e ganhou
`smoke:clipboard`, com o cenário anterior embutido como mutação. **B77 continua aberto** — o
link de mensagem agora copia, mas ainda produz um formato que §3.5 não abre, e ali o
conserto não é do renderer.
Atualizado antes em 2026-09-06 (§132). **§132** foi a verificação do relatório
consolidado de auditoria do **frontend e da integração com o núcleo** (união de dois
relatórios, 13 achados). **Treze confirmados**, nenhum refutado — mas dois com o alcance
exagerado: o `split(/\s+/)[0]` que o achado 2 descreve não existe mais no código
(a truncagem por espaço é história), e o achado 11 diz que o convite pendente "só é limpo ao
clicar em Cancelar" quando o que ele de fato sobrevivia era o fechamento da **janela** — o
cancelamento sempre limpou. As **quatro** lacunas de especificação eram reais e fecharam por
emenda.

O tema é um só: **o caminho existia e ninguém o percorria.** `assinarDeepLinks` estava
escrita e nenhum arquivo em produção a chamava, então todo `comunidadep2p://…` com o app
aberto era descartado em silêncio; o ramo de `unreachable` na prévia de convite estava
escrito e era inalcançável, porque a composição recusava em vez de devolver o desfecho; o
`HostExitListener` tinha sido movido para a raiz e continuava **dentro** do guarda de
conexão, que não renderiza os filhos enquanto o núcleo sobe. Treze defeitos corrigidos.
Cinco emendas normativas em `backend-v2.md`: **§3.5** (qual superfície do renderer consome
cada rota de deep link — a tabela que faltava), **§8.7** (advisório é o veredito, não a
unidade: o contador da UI conta code points ou grafemas, nunca UTF-16, e mede o texto
normalizado), **§12.3** (o desfecho 6 é resposta de `inviteResolve`, não recusa dele — e
continua sendo recusa em `redeem`), **§16.1** (o prazo de 30 s é do request, não da pessoa:
sair da espera é sempre possível, e sair não cancela o comando) e **§18.7** (o que cada
campo de `host.exitImpact` conta — `inCallCount` são **pessoas**, deduplicadas, sem o
próprio host —, mais a regra de que leitura ausente não vale zero). O `smoke:deeplink`
ganhou a parte que faltava: preload e bundle reais, o main enviando o link e a pergunta que
importa — mudou alguma coisa do outro lado? Verificado por mutação. **B13 fechou** — ele pedia
exatamente o desfecho `unreachable` no lugar de `E_TIMEOUT`, e a emenda de §12.3 o entrega
dentro do teto: as três rodadas de descoberta somam 24 s, então o núcleo responde antes dos
30 s do IPC-R. Abriu **B77**, abaixo.
Atualizado antes em 2026-09-06 (§131). **§131** foi a verificação do relatório de
auditoria de **cargos, permissões e moderação** pela interface. Dos 14
achados, **treze confirmados** e **um refutado** — o de exigir confirmação em "Revogar
banimento" e "Remover timeout": `frontend.md` §15 lista as ações que pedem modal, e isenta
nominalmente "remover timeout" como destrutiva **reversível dentro da própria sessão**;
revogar banimento é da mesma família e também não está na lista fechada. Das três lacunas de
especificação, **duas** eram reais (o roster sem os cargos do membro; nenhum caminho para
quem tem `ban_members`/`timeout_members` e não tem `view_audit_log`) e uma era leitura errada
(§6.13 congela rótulo na `ModerationEntry`, que é história; `bans`/`timeouts` são estado
corrente e respondem `UserRef` vivo por decisão declarada) — as três fecharam por emenda.

O tema é um só: **a tela oferecia o que o `fold` já recusa**. Editar o cargo Fundador,
mexer em cargo acima do seu, marcar no cargo base as permissões que R-11 proíbe, conceder
permissão que o autor não tem, mover o cargo base, remover cargo de quem é imune — tudo
clicável, tudo recusado no envio. Treze defeitos corrigidos. Três emendas normativas em
`backend-v2.md`: **§20.3 regras 8 e 9** (a UI não oferece o que hierarquia ou anti-escalada
já recusam, e a pré-checagem é affordance, nunca autorização), **§15.6** (o roster carrega
`roleIds` com todos os cargos ativos do membro; `query.timeouts` ganha o carve-out de
`timeout_members`, simétrico ao de `ban_members` em `query.bans`; e o esclarecimento sobre
rótulo vivo) e **§9.1** (a nota de que `view_audit_log` não é a única porta de leitura de
`bans`/`timeouts`). Quatro em `frontend.md`: 3.1b (a seção de identidade da comunidade é de
`manage_community`), 3.2 (o que o editor de cargos não oferece, item a item), 3.3 (a aba e
cada sub-aba pela permissão da sua consulta; o botão da linha pela de escrita) e §14 (o
"Carregar mais" do log paga o lote seguinte **na fonte**, não revela linhas de um array já
carregado), mais 1.3 (o botão direito no painel de membros abre o menu de contexto que §6
sempre previu "em membro") e D12 (a nota de `L-7` é obrigatória no modal de ban). Um defeito
a mais, encontrado ao verificar o primeiro achado: o roster era lido em um lote de 100 e
parava ali — acima disso, quem ficasse de fora aparecia sem cargo nenhum para os seletores,
que é a mesma cegueira do achado principal por outro caminho. Nenhum item desta lista fechou
nem abriu por causa dela.
Atualizado antes em 2026-09-06 (§130). **§130** foi a verificação do relatório de
auditoria da **mídia de comunidade** pela interface: voz, câmera, tela, Modo
Música e gravação local. Dos 16 achados, treze confirmados, dois com o mecanismo certo e o
alcance exagerado e **um refutado** (o empilhamento de ganho em `mixagem.ts` — o Web Audio
ignora conexões repetidas entre os mesmos extremos). As **seis** lacunas de especificação eram
reais e fecharam por emenda. Treze defeitos corrigidos, e o tema é um só: **esquecer a
referência não fecha o dispositivo** — sair da chamada compartilhando tela deixava o SO
capturando com o áudio do sistema junto, e trocar de canal deixava a luz da câmera acesa
transmitindo para ninguém. Sete emendas normativas: §17.2 (o ciclo de vida da captura local,
em cinco regras; e a troca ao vivo de câmera, simétrica à do microfone), §6.16 (quem escreve
`sharing` no roster — o host, pelo `shareStar`; e `speaking` é sobre o que SAI, não sobre o que
o microfone capta), §17.4 L-12 (o conselho tem um caminho, e ele é `voice.muteParticipant`),
§17.5 (apresentar e parar são serializados entre si; e a fonte de sistema é reaproveitada na
remontagem do grafo). Nenhum item desta lista fechou nem abriu por causa dela.
Atualizado antes em 2026-09-05 (§129). **§129** foi a verificação do relatório de
auditoria da **interface** da conversa direta (§127 foi o do núcleo dela): dos
14 achados, doze confirmados, um refutado e um com o mecanismo certo e a causa errada. As
**duas** lacunas de especificação eram reais e fecharam por emenda. Doze defeitos corrigidos —
o mais grave sendo bloquear ou esquecer no meio de uma chamada, que deixava a captura acesa no
renderer **e** o escopo do TURN registrado no núcleo, encaminhando a mídia de quem se acabou
de bloquear. Cinco emendas normativas: §31.16.1 (`dm.block` e `dm.forget` implicam
`dm.callLeave`), §31.16.3 (a marca de leitura sai nas queries, e o `AttachmentDto` da DM é o
de §15.6.1 **inteiro**), §15.6.1 (a correlação com `blob.progress` é o `blobIdHex`), §3.5
regra 3 (posicionar inclui navegar) e U-33 (o painel de chamada que sobrevive à navegação, a
fonte do divisor de "Novas mensagens" e a conversa em foco que não acumula não lidas).
**B14 fechou** — a correlação já existia e só não estava escrita. Abriu **B76**, abaixo. A
lista tinha **dois** `B66`; o de *A observar* virou **B75**. **§128** foi a verificação do relatório de
auditoria do shell Electron (main, preload, `utilityProcess`, ponte do renderer): dos 14
achados, sete confirmados como escritos, quatro com o mecanismo certo e a consequência
exagerada, três refutados; das três lacunas de especificação, **uma** era real. Onze defeitos
corrigidos — o mais grave sendo a rede parada **antes** do dreno, que tornava a barreira de
§18.7 impossível de cumprir, e o mais perigoso o loopback do sistema concedido a uma janela
escolhida no portal do Wayland. Cinco emendas normativas: §18.7 (a rede sai depois do dreno),
§17.5 (sob seletor do sistema, o tipo que vale é o **concedido**; e `window` sem `sourceId` é
recusa), §3.3 (`blocked` é terminal, o respawn não atropela o quit, e o encerramento por sinal
externo drena sem passar por U-06), §3.5(2) (o deep link vai ao **renderer**; o caminho pela
IPC-M não tinha consumidor) e §13.6 (o `mode` de `shell.open`, e a allowlist conferida nas duas
fronteiras) — mais a emenda de A13(6) em `adr-v2.md`, que passa a nomear a etapa (2) de §10.8.
**B19 fechou** (a porta IPC-R **é** reentregue na recarga desde §92, e §15.2 agora declara o
mecanismo e o custo). **B73 e B74 nasceram e fecharam na mesma fatia**, por decisão do
operador: §15.3 vence §13.6 sobre `archive` (abrir compactado é permitido, atrás da caixa
nativa — bloquear não removia o risco, mudava-o para "Mostrar na pasta" + duplo clique, que
não tem confirmação nenhuma), e a UI passou a saber o que oferecer por um campo novo do
núcleo (`revealMode`) em vez de uma terceira cópia da tabela de extensões. **§127** foi a verificação do relatório de
auditoria da conversa direta (`auditoria.md`): oito achados confirmados e
corrigidos — um crítico (escritas concorrentes duplicavam `authorSeq` e invalidavam o próprio
lado para sempre), dois altos, três médios e dois baixos — e sete emendas normativas: §31.10
(o caminho de escrita é serializado por conversa), §31.7.4 (`dm.react{present:false}` nunca é
recusada, **em qualquer alvo**, e o alvo inexistente é `E_NOT_FOUND`), §6.9 (o tombstone apaga
`attachments`/`dm_attachments`, e é o que faz §13.7 regra 2 ser verdade), §31.9 regra 7
(`pending-out` vira `accepted` quando o `dm.hello` do par chega), §31.13 (o handshake que não
fecha **emite**, com `reason:'handshake'`; a validação de 32 bytes do `coreKey` é simétrica),
§31.7.2 (`unknownKinds`/`unknownVersions` no `DmState`) e §31.16.2 (`hasIncoming` e
`dm.partialInterpretation` são do `dmProjector`, por lote). Abriu **B72**, abaixo. As duas
lacunas de especificação do relatório fecharam por emenda; a terceira já era **B66**.
**§126** foi a verificação do relatório de
fase 3 (replicação, presença e sucessão): sete defeitos corrigidos e quatro emendas
normativas — §14.3 (a recusa de (1) é dita, e (4) cede sob o orçamento de §12.6), §14.5 (o
host é `synced` sem `hello`, os três motivos de `stalled`, e quem decide a causa de
`partial`), §17.6 (`invisible` não publica typing) e §18.4 (o segundo gatilho ganhou
produtor). Fechou `RT-11`, que não tinha produtor nenhum. Abriu **B70** e **B71**, abaixo.
**§125** foi a fase 2 do mapeamento de busca
por bugs (fronteira de processo e gestão de segredo): onze defeitos corrigidos e quatro
emendas normativas — §10.8 (sem `flock` não há etapa (2)), §15.3 (o diálogo nomeia a ação e o
token liga-se ao alvo), §15.1(5) (o descarte consome `evSeq`) e §18.6 + §3.2 L-2 (fechar antes
de apagar; modo do cofre persistido, com upgrade automático e downgrade recusado). Dois
códigos entraram no catálogo de §20.2: `E_KEYSTORE_MODE_CHANGED` e `E_CORE_LOCK_UNAVAILABLE`.
Nenhum item desta lista fechou nem abriu por causa dela. **§124** foi a fase 1 (domínio puro
do núcleo): doze defeitos corrigidos, cinco emendas normativas e uma pergunta de produto nova
— **B69**, abaixo. **§123 fechou B1, B2 e B4** por evidência
de operador — build empacotada para Windows e Linux, exercitada com outros usuários — e as
fases 3, 7, 8 e 10 passaram a `validada`. O que essa evidência **não** prova (`tc/netem`,
CGNAT real, e a garantia reproduzível do piso de glibc) está escrito em §123.2; os vereditos
dos gates em `poc/` continuam `parcial` e não foram tocados.

A conversa direta é a fase 11 de §29, e ela **fechou** (B54..B62 e B65, em §100..§109);
§110..§115 foram superfície e texto normativo sobre contrato já existente, e fecharam também
**B39**, **B41** e **B68**. As linhas de tudo isso **saíram desta lista** — é a regra abaixo
—, e o histórico está em `sequenciamento-pos-fase-0.md`.

**Como manter.** Item fechado sai daqui e o fechamento é registrado na fatia do
`sequenciamento-pos-fase-0.md` que o fechou. As tabelas "Pendências" até §69 ficam como
histórico; da §72 em diante a lista viva é esta e as fatias não a repetem.

## Como esta lista é dividida

O critério é **o que falta para dar o próximo passo**, não a dificuldade nem o tamanho.

- **Só o operador humano** — o próximo passo exige algo que não está neste repositório nem
  nesta máquina: uma decisão de produto, texto normativo novo, uma credencial, uma máquina
  de outro sistema operacional, uma rede real.
- **O agente pode fazer** — o próximo passo é código, teste ou configuração que já dá para
  escrever **e verificar** aqui.

Duas consequências do critério, e as duas importam na hora de reclassificar:

**Um item atravessa a linha quando o bloqueio muda.** Vários são "o humano decide, o agente
implementa". Enquanto a decisão não existe, o item fica do lado humano — quem está esperando
é quem manda —, e a coluna *O que só o humano tem* diz o que destrava. Depois da decisão ele
muda de lado, e isso é manutenção normal desta lista, não exceção.

**O lado depende da máquina, então confira antes de mover.** O exemplo canônico é o B1 que
fechou em §123: ele ficava do lado do agente porque o Docker desta máquina responde e o piso
de glibc podia ser montado aqui; num ambiente sem Docker o mesmo item seria humano.
Classificar por suposição sobre o ambiente é como esta divisão apodrece.

## Só o operador humano

### Bloqueia release

| # | Item | O que só o humano tem | Referência |
|---|---|---|---|
| B3 | `.exe` sem assinatura de código — SmartScreen alerta | O certificado: compra, identidade jurídica e custódia da chave privada. Nada disso se resolve em repositório | §71.3 |

### Decisão de produto ou texto normativo

Nenhum destes é implementação parada: é a **spec que não responde**. Escrever comportamento
aqui sem decisão seria inventá-lo, que é o que `CLAUDE.md` proíbe.

| # | Item | O que só o humano tem | Referência |
|---|---|---|---|
| B44 | **`voice.meshChanged` é um tópico morto.** Declarado em §15.5 ("falha assimétrica"), não tem produtor no núcleo nem consumidor no renderer — o renderer mede o par localmente por `connectionState`, que é melhor. É a família do defeito recorrente de §82.3: evento declarado, sem linha na tabela fechada de §16.3 | Remover do §15.5 ou ligar via §16.3 — mudança de superfície normative é do operador | §97.4, §15.5, §82.3 |
| B49 | **`voice.deviceError` sem produtor no núcleo.** Declarado em §15.5 (fecha `RT-10`) e agora com assinante na UI, mas ninguém o emite: a captura de dispositivo é do renderer, que conhece a falha direto pelo `DOMException` da própria captura | A forma: um produtor no núcleo (para que falha?) ou a remoção do tópico de §15.5 | §97.4, §15.5 |
| B29 | §17.2 diz "configurável" e não diz ONDE. Com o default ligado (§81.5) deixou de bloquear uso, mas desligar ou trocar o servidor ainda exige `P2P_STUN_SERVERS` — §15.4 não tem comando de settings para isso. Lacuna de spec | Onde a configuração mora. Definido isso, o comando de §15.4 e a tela são do agente. **Menos urgente depois de §99.13**: a coleta em duas fases faz o terceiro só ser consultado quando o host não resolve, então o default ligado deixou de significar "o terceiro vê o IP em toda chamada" | §17.2, §81.4, §99.13 |
| B38 | **Máximo de participantes por canal de voz, escolhido por quem administra.** Os tetos de ocupação saíram do protocolo em §90 (eram números de política, e nenhum media máquina). O que faz sentido no lugar é **configuração de canal**: um campo opcional em `channel.create`/`channel.update`, aplicado pelo host no `voiceJoin` com erro nomeado. Precisa de campo no log (§6.6), superfície em §15.4 e a decisão de o que fazer com quem já está dentro quando o número baixa | O que acontece com quem já está dentro quando o número baixa — e o aval para mexer em §6.6 e §15.4, que são normativos | §90, §17.6, `deltas-ux-v2.md` U-09 |
| B37 | **Transmissões simultâneas sem teto.** O canal aceita várias telas (§87.4) e o custo é de quem assiste — download e decodificação multiplicam. Limite de máquina, não de protocolo; §17.5 é silenciosa e um número inventado seria medida que ninguém tomou | A medida em máquinas reais e, depois dela, a política. O agente monta o cenário; o número não sai de dentro do repositório | §87.5, §17.5 |
| B52 | **TURN sobre a conexão UDX que já atravessa — a resposta comum às três lacunas de B30.** O produto já mantém, entre cada membro e o host, um canal autenticado que atravessa NAT e CGNAT (é por ele que passa a sinalização de voz); §17.3 o ignora e pede ao renderer que abra um caminho novo pela via que não funciona. A proposta: TURN em `127.0.0.1` servido pelo núcleo local, encapsulado na UDX até o host. Endereço e credencial **deixam de existir** como problema, e o RTT para seleção já é observado. Custa um salto a mais, e faz o núcleo encaminhar ciphertext — o que muda o sentido de uma frase de §17.2 ("o núcleo nunca vê mídia"), embora não a propriedade (DTLS-SRTP segue ponta a ponta) | O aval para mexer em §17.2/§17.7 e a decisão sobre o custo do salto. A proposta está escrita e argumentada; falta ser decidida | §99, §17.7, B30 |
| B51 | **O serviço STUN/TURN do host é IPv4-only, e IPv6 é a travessia de CGNAT que não custa servidor.** `xorAddress` escreve família `0x01` fixa, o decodificador recusa `0x02`, o parser faz `split('.')` e a socket relayada abre `udp4`. A restrição não nasce ali: o endereço público vem de `dht.host`/`dht.port` do `hyperdht`, que é IPv4. Um par IPv6↔IPv6 já fecha sem nada disso — o que não existe é o host **servindo** em IPv6, e o Brasil passou de 50% de adoção | A decisão de escopo. **Verificado em §99**: `dht-rpc` fixa `family: 4` em `localIP()` e em `lookup()`, então servir em IPv6 exige mexer no transporte upstream — não é correção neste repositório | §99.5, L-15, §17.3 |
| B66 | **RD-11 não é verificável como está escrita.** A regra manda o `dmFold` conferir que o `blobsCoreKey` de um anexo é "o core de blobs de DM do **autor** daquela mensagem", mas `dmBlobsSeed = BLAKE2b('ns/dmblobs/1' ‖ identitySeed ‖ conversationId)` (§31.3) só é derivável por quem tem o `identitySeed`, e a chave resultante **não é declarada em lugar nenhum**: não está no payload de `dm.hello` (§31.5), não está no `dmHello` de §31.8, e o catálogo de 6 `kind`s é fechado. Verificar só sobre o próprio lado tornaria a regra assimétrica e faria as duas réplicas divergirem, contra §31.1. B54 implementa o que é determinístico e simétrico sem mudar o fio — o **primeiro** anexo de um lado vincula a chave e os seguintes precisam repetir —, o que fecha "cada anexo aponta para um core diferente" e **não** fecha o caso que RD-11 nomeia. **§108 acrescentou a metade da escrita**, que é total: `dm.send` recusa com `E_VALIDATION` um anexo cujo `blobsCoreKey` não seja o core de blobs desta conversa. O que sobra é só a leitura do **primeiro** anexo do par | A forma da declaração: um campo `key blobsCoreKey` em `dm.hello` (mudança de `DM_VERSION`) ou outra âncora. Definido isso, a implementação é do agente e cabe em duas linhas do handler | §31.7.4 RD-11, §31.14, §31.5, `core/src/l1/dmFold/state.ts` |
| B67 | **§31.7.1 e §31.7.2 não carregam o que RD-1 e RD-5 exigem.** Dois campos faltam, e nos dois casos não há segunda leitura possível — B54 os acrescentou e documentou no ponto, como `communityInvalid` e `originFinalSeq` já haviam sido. (a) `DmContext` não tem as chaves dos dois cores de DM, e sem elas RD-1 não consegue verificar o `coreProof` (a chave do core não viaja no registro; ela é a do core que se está lendo, e o handshake de §31.8 já a carrega). (b) `SideState` só tem `lastTs`, e `clockSkewed` é definido sobre o `ts` do registro no índice `ack − 1` do **outro** lado — que na ordem canônica pode não ser o último interpretado; usar `lastTs` marcaria `clockSkewed` sem impossibilidade causal nenhuma | O aval para o texto: acrescentar os dois campos aos schemas de §31.7.1 e §31.7.2, ou dizer outra coisa. É emenda de duas linhas, não decisão de desenho | §31.7.1, §31.7.2, RD-1, RD-5, §31.6 |
| B30 | **O voluntário de relay não tem endereço nem credencial no protocolo.** A parte implementável saiu em §95: consentimento persistido, kinds 60/61 no log, `DecisionState.relays` com entradas. O que sobra são **três decisões de protocolo**: §6.14 carrega chave/prazo/posse e nenhum endereço; §16.3 tem tabela fechada sem tópico de relay; e a credencial do TURN do host deriva do `hostTurnSecret`, que o voluntário não tem. "Seleção por menor RTT" pressupõe a lista de candidatos com endereço, que é o que falta | A forma dos três em §17.7/§16.3 — é superfície de protocolo, não detalhe de implementação. A **prova**, depois disso, continua dependendo de CGNAT real — que **§123 não mediu**, e que saiu da lista de bloqueios sem deixar de ser verdade (§123.2 item 1). **`B52` propõe uma resposta comum às três**, aproveitando a conexão UDX que já atravessa | §17.7, §6.14, §16.3, L-11, B52 |
| B15 | Divergências de aparência: `hostStatus` 9×3, tombstone, `hiddenByBan`, `clockSkewed`, `createdAt`/`description` sem fonte | Qual é a fonte de cada um desses estados. Hoje a UI mostra o que o mock inventou, e escolher a fonte é decisão de produto | §60.5 |
| B70 | **`blocked` e `forked` continuam sem produtor.** §14.5 declara os dois estados e o `communityClient` tem os marcadores (`markBlocked`, `markForked`), mas ninguém os chama: nada liga evento de conflito do Hypercore v10 a `forked`, e não existe critério de detecção de `gap` para `blocked`. `unauthorized` fechou em §126 (a recusa de §14.3(1) passou a viajar); estes dois não, e por razões diferentes — `forked` precisa saber qual evento do hypercore vale como conflito, e `blocked` precisa de um critério que §14.5 não dá ("o core anuncia comprimento maior do que o disponível em qualquer par" não diz como se observa isso nem por quanto tempo) | A forma dos dois critérios em §14.5 — é texto normativo, não detalhe de implementação | §126, §14.5, §5.5 L-4 |
| B71 | **O "digitando…" está morto de ponta a ponta no renderer.** O núcleo serve os dois lados (§17.6: `presencePublish{typingChannelId}`, `subscribeChannel`, fan-out por assinatura) e o `TypingIndicator` existe na tela, mas o renderer **nunca assina** (`channelSubscribeTyping` só aparece no teste de contrato), **nunca publica** (não há comando de IPC-R que mande `typingChannelId`) e o `setTyping` do `messageStore` não tem chamador. Sem assinante, `#typingDeltaFor` devolve `null` e nada sai do host. A conversa direta (`dm.setTyping`) é outro caminho e está viva | A decisão de produto: o "digitando…" entra no v1 em canal de comunidade, ou o indicador sai da tela? Definido isso, ligar as três pontas é do agente | §126, §17.6, `frontend/src/features/channel/TypingIndicator.tsx` |
| B72 | **`community.partialInterpretation` é um tópico morto — o gêmeo do que §127 acabou de ligar na DM.** §15.5 declara `{communityId, unknownKinds[], unknownVersions[]}` e §7.2 regra 5 manda ligar a marca, mas o `fold` da comunidade guarda só o booleano e ninguém emite o tópico. Na conversa direta isso foi corrigido em §127 (listas em `DmState`, evento por lote no `dmProjector`), e o desenho é transferível linha a linha. O que **não** é transferível é o snapshot: o `DecisionState` da comunidade é rematerializado de linhas de `view.db` (§8.1), e duas listas que não têm tabela voltariam vazias depois de um restart — o evento re-dispararia. É a mesma família de B44 e B49 (tópico declarado, sem produtor), mas aqui a decisão de conteúdo já existe | Onde as duas listas moram para sobreviver ao snapshot: coluna nova em `communities`, tabela própria, ou aceitar que o evento re-dispare depois de reprojeção. É §10.3 e §8.1, que são normativos | §127, §15.5, §7.2 regra 5, §31.7.2 |
| B77 | **O link de mensagem que o produto copia não casa a gramática de §3.5.** `MessageActions` e `ChannelContextMenu` copiam `p2p.app/m/<base64url do JSON {communityId, channelId, messageId}>`, montado pela própria interface; o handler de deep link só aceita `comunidadep2p://m/<MSGREF>`, 86 chars de `communityId(32) ‖ opId(32)` (§3.5, emenda de 2026-08-22), que é o que `query.resolveMessageLink` resolve. São dois formatos para a mesma coisa, e o produto **não abre o link que ele mesmo copia** por fora do app: colado num chat, o `comunidadep2p://` nunca casa e o `p2p.app/…` não é rota de protocolo. A rota interna `/m/:code` do `MemoryRouter` funciona porque nunca é alcançada de fora. É a família de B44/B49/B71/B72 — superfície declarada sem produtor —, aqui com o produtor existindo e produzindo outra coisa. **§133 consertou a metade de baixo**: o botão agora de fato escreve na área de transferência, e o convite passou a copiar a forma nativa. O link de mensagem não pôde acompanhar porque o `opId` do MSGREF não existe no renderer | A decisão de contrato: o núcleo passa a devolver o MSGREF de uma mensagem (campo novo em `query.message`/`query.messages` de §15.6, ou comando próprio em §15.4), ou §3.5 aceita um segundo formato. Definido isso, trocar o que a interface copia é do agente e cabe em duas funções | §133.6, §132.10, §3.5, §15.6 |
| B69 | **Thread cujo canal foi apagado continua listada.** §6.8 manda o `fold` marcar `rootDeleted` quando a **raiz é deletada**, e nada diz sobre a raiz ficar `orphaned` por `channel.delete`. Depois de §124 o `reply_count` cai (§8.4 exclui `orphaned`), mas `root_deleted` fica `0` e `query.threads` filtra por ele | A decisão: canal apagado esconde as threads dele do indicador global, ou elas continuam alcançáveis? O código faz o que a spec manda hoje; mudar exige texto novo em §6.8 | §124.5, §6.8, §8.4 |

### Máquina, rede ou sessão que não existe aqui

| # | Item | O que só o humano tem | Referência |
|---|---|---|---|
| B32 | **O portal do Linux: o caminho existe, a travessia não foi medida.** O loop de duas caixas do portal foi achado em uso real e fechado em §96 — no Wayland o seletor do produto sai de cena e a caixa do sistema é a escolha, uma vez só. O que continua sem medida é a captura **subindo** por esse caminho: que a fonte concedida é a que a pessoa apontou no portal, e que a trilha chega ao outro lado | Uma sessão gráfica Linux de verdade, com `xdg-desktop-portal` e gerenciador de janelas. Sob Xvfb o Chromium não enumera janela nenhuma, e `npm run smoke:captura` se declara **não medido** nesse cenário | §96, §83.6, `app/src/main/captura.ts` |
| B42 | **A câmera não foi vista entre duas máquinas.** O caminho existe e é o da voz — trilha de vídeo na mesma `RTCPeerConnection`, ligada e desligada em todos os pares (§93). O que não foi medido: imagem chegando de verdade, o custo da malha com várias câmeras ligadas ao mesmo tempo, e a oferta cruzada de §93.3 acontecendo em rede real em vez de em teste | Duas máquinas e duas câmeras. É a mesma prova que B28 e B31 deram para voz e tela | §93, `frontend/src/live/camera.ts` |
| B17 | Host de longa duração deixou de receber conexões (3h22 no smoke; voltou ao reiniciar). §97 eliminou os acumuladores concretos encontrados (`#observados` sem poda, `unsub` IPC-R que matava assinatura viva) e ligou os knobs `P2P_TURN_*` ignorados — o sintoma continua exigindo a observação de longa duração | Duas máquinas na DHT pública por horas. Não é observação que caiba num teste desta máquina | §63.4, §97.4 |

## O agente pode fazer

### Bloqueia release

**Vazio.** B1 e B2 fecharam em §123, por decisão do operador sobre a build que rodou nos
dois alvos com usuários reais. **O repositório continua sem `build/Dockerfile`,
`build/build-addons.sh` e sem filtro de `.node` por plataforma no empacotamento** — a
garantia reproduzível do piso de glibc 2.31 (A16) não existe aqui, e §123.2 item 3 registra
por quê isso foi aceito. Se aparecer usuário numa distribuição mais antiga, o item volta com
o mesmo texto.

### Caminho do produto, em ordem

| # | Item | Referência |
|---|---|---|
| B76 | **A conversa direta não tem responder, editar, apagar nem reagir.** U-33 os lista por escrito ("a conversa reusa a anatomia de 2.1 — … composer, **responder, editar, deletar, reagir**"), o núcleo os serve desde §100..§109 (`dm.edit`, `dm.delete`, `dm.react` e o `replyToId` de `dm.send`, §31.16.1), o cliente de IPC-R os expõe e `live/dm.ts` tem as quatro funções escritas — **sem chamador nenhum**. `DmMessageRow` não tem barra de ações e o `replyToId` nunca é preenchido. É a família de B44/B49/B71/B72 (superfície declarada, sem produtor), com a metade que falta do lado da tela: barra de ações por mensagem, seletor de emoji, edição no lugar, confirmação de apagar e a citação no composer. Não é correção de defeito — é a fatia de produto que U-33 pede e que §100..§109 não entregou | §129.5, U-33, §31.16.1 |

A fase 11 (a conversa direta, §31) fechou em §100..§109, e o que veio depois — §110..§115 —
foi trabalho de superfície e de texto normativo sobre contrato já existente, sem abrir fase
nova. **B76** é o que sobrou dela na tela, e foi §129 que o encontrou.

O que a conversa direta ainda deve **não é código de fase**, e está registrado nas seções
acima: **B66** e **B67** de texto normativo. A medida em rede real que a mídia de DM
acrescentou saiu da lista com **B4** em §123 — o caminho relayado da chamada de DM continua
sem sair de loopback, e isso está declarado em §123.2 em vez de aqui. **B63** (navegação e
mudo por conversa) fechou em §121; **B64** (deep link de pessoa) fechou em §118.

O histórico de como se chegou aqui está em `sequenciamento-pos-fase-0.md` §100..§123, que é
onde ele deve estar: esta lista diz o **estado**, e o sequenciamento diz o **caminho**.

### Bloqueado por medida

Nem humano nem agente: é implementável aqui, e a **justificativa** é hipótese que ninguém
mediu. Implementar antes da medida é pagar o custo sem saber se há ganho.

| # | Item | O que destrava | Referência |
|---|---|---|---|
| B46 | **Teto de conexões do host.** O escalonador de §14.2 (`allocateForCommunities`) é código sem chamador, e o `maxPeers` que o backend de hyperswarm aceita nunca é passado — conexões sem teto num host de longa duração é o candidato estrutural de B17. O número é política de capacidade sem medida nenhuma | A medida em máquina real (quantas conexões o host sustenta com o gasto de memória/CPU medido); depois dela, o valor e onde a política mora | §97.4, §14.2, `poc/poc-03-runtime/REPORT.md` |
| B9 | Residência `light` efetiva no projector. Exige um `MessageLookup` injetado no `fold` — que hoje não existe — e mexe na assinatura do módulo mais puro e mais testado do sistema, com o teste de determinismo de §28.4 no caminho | A medida de G9. §8.1 estima 24 MiB por 200 mil mensagens e marca "a medir em G9"; nada mais no caminho depende disto | §8.1, §57.3 |

### A observar

Sintomas com repro possível nesta máquina: o próximo passo é investigar, não esperar.

| # | Item | Referência |
|---|---|---|
| B48 | Fila de karaokê pós-respawn do host: a fila é efêmera (§6.16) e ninguém a re-anuncia — quem estava no turno fica "todos mudos" sem evento nomeado explicando. Repro: respawn do núcleo host com canal em modo fila. **A metade que era do roster fechou em 2026-09-05** (§16.4, emenda): quem sai da chamada sai da fila, então o "todos mudos" por titular fantasma não acontece mais. O que resta aqui é o caso do respawn, em que a fila inteira some junto com o host | §97.4, §6.16, §16.4 |
| B18 | Chips de reação otimistas através de respawn de epoch | §61.4 |
| B75 | Apagar a PRÓPRIA mensagem esconde a linha inteira (`deletedIds`), enquanto o tombstone projetado que os outros veem é uma linha com o texto de U-20. Quem apagou vê a conversa fechar o buraco; quem não apagou vê o buraco marcado — e um reload troca uma coisa pela outra para a mesma pessoa. §15.6.1 devolve a linha tombstonada e U-20 diz "some da interface": as duas leituras cabem, e nenhuma está escrita. Repro: apagar a própria mensagem, reabrir o app | §15.6.1, `deltas-ux-v2.md` U-20 |
| B65 | `E_STORAGE_FULL` **durante o append do log** (não do blob) só está definido para a criação da comunidade (§11.1). Sem a cota de anexos (§122), encher o disco deixou de ser caso raro, e o append sem desfecho nomeado é a próxima parada silenciosa. Repro: `blob.stage` + `message.send` com o volume do `dataDir` quase cheio | §122.5, `threat-model-seguranca.md` T-09 item 12, §11.1 |

### Qualidade

| # | Item | Referência |
|---|---|---|
| B20 | Nenhuma tela tem teste de render | §58.6 |
| B21 | Metade da validação fora do alcance do teste de contrato | §58.9 |
| B22 | Migração entre modos do cofre não exercitada — os modos se forçam por `--password-store`, sem depender do chaveiro do sistema | §60.5 |

## Fora do v1

Nem uma coisa nem outra: ninguém executa enquanto o escopo não voltar a se abrir.

| # | Item | Referência |
|---|---|---|
| B24 | Árvore de multicast — especificada e adiada | `adr-v2.md` A20, `backend-v2.md` §17.8 |
