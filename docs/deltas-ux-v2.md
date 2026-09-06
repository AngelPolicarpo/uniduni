# Deltas de UX/UI exigidos pela arquitetura v2

> **Papel deste documento.** A arquitetura v2 (`backend-v2.md`) mantém quase toda a
> experiência descrita em `docs/frontend.md`, mas exige mudanças de produto em pontos
> específicos. Este documento é a **lista completa e fechada** dessas mudanças, e a
> resolução dos 117 comportamentos da matriz de rastreabilidade.
>
> **Precedência.** Onde este documento e `docs/frontend.md` discordarem, **este vence**.
> `docs/frontend.md` continua válido em tudo que não está aqui.
>
> **Comparação com v1.** A §25 de `docs/backend.md` (v1) listava 12 deltas. A auditoria de
> rastreabilidade mostrou que sobravam 21 divergências das classes `CONTRADICTORY` e
> `MISSING` sem delta correspondente. Este documento tem **30 deltas** e cobre todas.
>
> **Regra de completude:** toda limitação declarada em `backend-v2.md` §25.8 (L-1 a L-29)
> tem uma superfície de UI obrigatória. Um delta que some daqui sem que a limitação
> correspondente saia de §25.8 é regressão.

---

## 1. Deltas, por classe

### 1.1 Mudanças de escopo de produto (alteram o que o produto faz)

---

**U-01 — Backup e restauração de identidade passam a existir**

| | |
|---|---|
| **Onde** | `frontend.md` premissa 3; §10 (3.1 Configurações de conta) |
| **Hoje** | "Identidade é local a um dispositivo. Sem backup/export/import de chave." |
| **Muda para** | Existe **exportar identidade** (arquivo cifrado por frase secreta) e **importar identidade** (só em instalação sem identidade). Multi-dispositivo continua fora do v1. |
| **Por quê** | `T-43`: sem isso, perder a máquina é perder permanentemente toda comunidade hospedada. O ARB classificou como limitação de produto **não aceita**. `adr-v2.md` A24. |
| **Telas novas** | 3.1 → Identidade: "Fazer backup da identidade" (com aviso de que a frase secreta não tem recuperação) e, na Camada 0, uma terceira porta de entrada em 0.1: "Restaurar identidade a partir de um backup". |
| **Texto obrigatório** | "Se você perder este arquivo **e** a frase secreta, a identidade não pode ser recuperada. Não existe conta, não existe servidor, não existe 'esqueci minha senha'." E: "Usar a mesma identidade em dois computadores ao mesmo tempo, hospedando a mesma comunidade, corrompe a comunidade." |

---

**U-02 — Um único eixo otimista: só mensagem é otimista**

| | |
|---|---|
| **Onde** | `frontend.md` §9 (2.1), §17 (microinterações), §12 (estados transversais) |
| **Hoje** | A Camada 2 inteira é otimista: reagir, fixar, editar e criar thread respondem na hora. |
| **Muda para** | **Otimista, com fila durável:** `enviar`, `editar`, `deletar`, `fixar`, `reagir`, `criar thread`. Estes vão para a fila e mostram estado de entrega. **Confirma-depois-desenha:** tudo de estrutura, cargo, moderação, comunidade e convite. Estes exigem host online, mostram estado de carregamento no controle acionado, e **não** enfileiram. |
| **Por quê** | `F-15`: em v1, reagir/editar/fixar/thread eram RPCs síncronos de 30 s contra uma UI otimista, **sem rollback especificado**. Ou tudo tem fila, ou nada é otimista. `adr-v2.md` A25. |
| **Consequência visível** | O chip de reação passa a ter o mesmo ciclo de entrega da mensagem (pendente → entregue → falhou), em vez de "saltar" e talvez sumir. Com host offline, os botões de estrutura ficam desabilitados com tooltip — o que a spec já faz para canais (`frontend.md:791`) e agora vale para cargos, categorias e moderação. |

---

**U-03 — O preview de convite tem seis desfechos, não quatro**

| | |
|---|---|
| **Onde** | `frontend.md` 0.3; §2 (`InvitePreview`); `frontend/src/domain/types.ts:236-240` |
| **Hoje** | `ok`, `invalid`, `banned`, `already-member`. |
| **Muda para** | Acrescenta `unreachable` (host offline) e `ended` (comunidade encerrada), com telas distintas de `invalid`. |
| **Por quê** | `RT-01`: um convite **perfeitamente válido** era acusado de inválido quando o host estava offline. É o oposto do princípio 3. |
| **Texto obrigatório** | `unreachable`: "Não foi possível falar com quem hospeda esta comunidade agora. O convite pode estar bom — tente de novo mais tarde." Com botão "Tentar novamente". `ended`: "Esta comunidade foi encerrada." |

---

**U-04 — A lista de convites não mostra o código de convites de terceiros**

| | |
|---|---|
| **Onde** | `frontend.md` 3.1b (lista de convites ativos) |
| **Hoje** | A tabela mostra o código de todos os convites ativos, com "copiar link". |
| **Muda para** | Mostra o código **apenas** dos convites criados nesta instalação. Nos demais, a coluna exibe "código não disponível neste dispositivo" e a ação de copiar fica indisponível; todo o resto (quem criou, usos, expiração, revogar) continua. |
| **Por quê** | `F-21`: o segredo do convite nunca entra no log — se entrasse, qualquer membro poderia emitir convite em nome de outro. Não há solução criptográfica para o contrário. `adr-v2.md` A08. |
| **Texto obrigatório** | "Só quem criou um convite consegue ver o código dele. Isso é o que impede alguém de emitir convites em nome de outra pessoa." |

---

**U-05 — Convite: entropia, formato e ausência de aprovação manual**

| | |
|---|---|
| **Onde** | `frontend.md` §2 (dataset), 0.3, 3.1b, §13 |
| **Hoje** | Código de 6 caracteres (`X7K2QM`); o formulário valida só "inteiro ≥ 1" no limite de usos. |
| **Muda para** | Código de **16 caracteres** em 4 grupos (`X7K2-QM9F-RT4B-N8ZP`), alfabeto Crockford Base32. O formulário valida inline `maxUses` 1..10000 e expiração entre 1 minuto e 365 dias. O texto declara que **não há aprovação manual**: a mitigação de link vazado é revogar. |
| **Por quê** | 6 caracteres (~30 bits) é força bruta viável contra um tópico anunciado em DHT. `RT-12` para os limites. |

---

**U-06 — "Avisar quem está online" ao sair como host deixa de existir**

| | |
|---|---|
| **Onde** | `frontend.md` §10 (3.5, aviso de saída do host) |
| **Hoje** | O modal oferece postar uma "mensagem de sistema" no canal padrão de cada comunidade afetada. |
| **Muda para** | A opção é removida. O modal passa a mostrar, além de quantas pessoas caem, **quantas operações ainda não replicaram**, e o app aguarda a barreira de replicação (até 5 s) antes de fechar. |
| **Por quê** | `F-43`: a mensagem era appendada e o host desligava em seguida — quase certamente antes de ela replicar, então ninguém a receberia. `RT-13`: "mensagem de sistema" não existe no modelo de domínio, e inventar um tipo só para isso é pior do que remover. `backend-v2.md` §18.7. |
| **Texto novo** | "Fechar agora desconecta 12 pessoas. 3 operações ainda estão sendo enviadas para outros dispositivos — aguarde alguns segundos para não perdê-las." |

---

**U-07 — O log de auditoria é confidencialidade local, não segredo**

| | |
|---|---|
| **Onde** | `frontend.md` §10 (3.3), permissão `ver log de auditoria` |
| **Muda para** | A tela passa a declarar que a permissão controla **o que a interface mostra**, e que o dado replicado está no dispositivo de todo membro. |
| **Por quê** | `T-44`, `DR-25`: com replicação integral, `view_audit_log` não pode ser segredo criptográfico. Fingir o contrário é a desonestidade que o princípio 3 proíbe. |
| **Texto obrigatório** | "Esta permissão controla quem vê o log nesta interface. Como cada membro guarda uma cópia da comunidade, ela não é um segredo técnico." |

---

**U-08 — "Silenciar nesta chamada" é conselho; "remover da chamada" é enforcement**

| | |
|---|---|
| **Onde** | `frontend.md` §8 (1.4, popover de perfil), §9 (2.3) |
| **Hoje** | "Silenciar nesta chamada" aparece como ação de moderação com `voice_mute_others`. |
| **Muda para** | Duas ações distintas e visualmente distintas: **"Silenciar nesta chamada"** (cooperativa, reversível, com o aviso de que depende do cliente do outro) e **"Remover da chamada"** (efetiva: o host revoga o ticket de mídia e a conexão cai). |
| **Por quê** | `T-40`: quem controla o microfone é quem o possui. `adr-v2.md` A22 dá o mecanismo efetivo. |
| **Texto obrigatório** | Ao silenciar: "Isso pede ao aplicativo da pessoa para silenciar. Para interromper de fato, use 'Remover da chamada'." |

---

**U-09 — Compartilhamento de tela é estrela, sem árvore no v1**

| | |
|---|---|
| **Onde** | `frontend.md` §9 (2.4), §18 (edge cases) |
| **Hoje** | Estrela até 5, árvore acima disso, até 200 espectadores. |
| **Muda para** | **Estrela WebRTC. Não há árvore no v1.** Quem está na chamada pode assistir; o painel do apresentador mostra **quantos** assistem. |
| **Por quê** | `adr-v2.md` A19/A20: a árvore depende de forwarding opaco cifrado, handshake de aresta, ACK de atribuição e reparo — nada disso especificado nem medido em v1. O desenho está fechado em `backend-v2.md` §17.8 e bloqueado por POC-09. |
| **Ganho colateral** | Como a estrela é WebRTC direto, **o atraso de 1–2 s da árvore some**, e o delta 3 de v1 deixa de ser necessário. Quando a árvore entrar, o delta volta (U-14). |
| **Revisto em 2026-08-26 (§90)** | A redação anterior fixava "até 8 espectadores", com o 9º recebendo um estado nomeado e o teto exibido no painel. O teto saiu: era número de política, não consequência da estrela, e o que limita de verdade é o upload de quem apresenta — grandeza que a degradação medida de §17.5 já trata. Somem com ele o estado "A transmissão está no limite de 8 espectadores" e o denominador do contador. |

---

**U-25 — Os controles da transmissão são de quem transmite; o espectador só oculta o vídeo**

| | |
|---|---|
| **Onde** | `frontend.md` §9 (2.4) "Ações"; `frontend.md` observação "Qualidade é de quem assiste"; `backend-v2.md` §17.5 |
| **Hoje** | O seletor de qualidade aparece para **os dois papéis**, com a justificativa de que "ajustar a própria recepção não afeta ninguém". |
| **Muda para** | **Apresentador:** resolução, taxa de quadros e perfil de qualidade — presets e personalizado. **Espectador:** um controle só, "Ocultar vídeo"/"Mostrar vídeo", que para a exibição **local**. |
| **Por quê** | A justificativa antiga é falsa em estrela. Não existe "própria recepção" para ajustar: o perfil de §17.5 é aplicado no `RTCRtpSender` **do apresentador**, então o pedido do espectador gasta o upload de outra pessoa — oito espectadores em `high` já são 20 Mbps de subida numa máquina que não tinha como recusar, e desde §90 não há teto que limite esse número. É também quem apresenta que vê o que está capturando e sabe se o caso pede texto legível ou movimento fluido. |
| **O que não muda** | A **degradação automática por perda** continua sendo do sistema, por espectador e só para baixo (§17.5): é ela que protege quem assiste numa conexão ruim, e ela nunca precisou de comando. |
| **Telas** | 2.4 ganha o popover "Transmissão" (só para quem apresenta) com os três grupos; o espectador ganha o botão de olho e, com o vídeo oculto, o lugar do vídeo diz "Vídeo oculto — {apresentador} continua transmitindo, só você deixou de ver". |
| **Texto obrigatório** | Ocultar **não** pode ser descrito como "pausar a transmissão" nem "sair da transmissão": as duas coisas afetariam outra pessoa, e esta não afeta. |

---

**U-10 — ~~Compartilhamentos simultâneos no mesmo canal saem do escopo~~ — REVOGADA em 2026-08-26**

| | |
|---|---|
| **Onde** | `frontend.md` §18, edge case 4 |
| **Status** | **Revogada.** O canal aceita **várias transmissões ao mesmo tempo**, uma por apresentador. A UX original de §18 (grade de tiles grandes) volta a valer. |
| **Por que foi revogada** | O "por quê" original não era engenharia: `RT-06` era uma **contradição entre documentos** — a UX pedia várias, o backend de v1 fixava `0..1`, o mock não implementava nenhuma — e a resolução escolheu o que já estava escrito. Não havia restrição por baixo: em estrela, a trilha de tela **pega carona na conexão de voz que já existe** entre cada par, então um segundo apresentador não abre malha nova; e o upload não compõe, porque cada apresentador serve a própria estrela da própria máquina. |
| **O que ficou** | `E_ALREADY_SHARING` recusa a **segunda sessão da mesma pessoa** no mesmo canal — não é regra de protocolo, é o renderer: a captura de tela de uma instalação é uma só. |
| **Custo declarado** | Download e decodificação multiplicam por transmissão simultânea, no lado de quem assiste. É limite de máquina, não de protocolo, e não tem teto declarado — registrado como pendência em vez de inventar um número. |

---

**U-11 — Estados de sistema que não tinham tela**

| | |
|---|---|
| **Onde** | `frontend.md` §12 (estados transversais), §5.4 (paletas semânticas) |
| **Faltam** | (a) reprojeção longa com barra de progresso; (b) núcleo reiniciando após crash; (c) cliente desatualizado (somente-leitura numa comunidade); (d) swarm degradado (sem bootstrap/pares) — **diferente** de host offline; (e) replicação atrasada/parada; (f) comunidade encerrada em modo histórico; (g) comunidade em fork. |
| **Muda para** | Sete estados nomeados, com token de cor próprio. `swarm-degraded` e `client-outdated` **não** podem reusar o token de `host-offline`: são causas diferentes com ações diferentes. |
| **Por quê** | `F-17`, `DS-11`, `RT-11`, e as 8 capacidades de backend sem UX da matriz §4.4. |

---

**U-12 — Espectador de tela é participante do canal de voz**

| | |
|---|---|
| **Onde** | `frontend.md` §2 (dataset de referência), fixture `TELA-04` |
| **Hoje** | A fixture tem 7 espectadores num canal de voz com 3 participantes, e `frontend.md:1459` afirma "espectador ≠ participante". |
| **Muda para** | **Espectador é participante.** Não existe audiência fora da chamada. A fixture precisa ter espectadores ⊆ participantes. |
| **Por quê** | `F-18`: a contradição estava entre a UX, o backend e o código, e nenhum dos três cedia. v2 fecha do lado do backend e a fixture segue. |

---

**U-13 — Consentimento de relay voluntário é uma superfície nova**

| | |
|---|---|
| **Onde** | `frontend.md` §10 (3.1 → Rede) |
| **Muda para** | Nova seção "Ajudar outros a se conectarem", com: explicação do que é relay, o que o voluntário **vê** (volume e temporização — não conteúdo) e o que ele **não vê**; cota de banda; botão para ativar/desativar; e um indicador de quanto foi retransmitido. |
| **Por quê** | Usar o upload de alguém para tráfego que **não é** da chamada dela exige pedir. `adr-v2.md` A21, L-14. |
| **Texto obrigatório** | "Quem retransmite não consegue ler nada do que passa: áudio e vídeo são cifrados entre as duas pontas. Mas consegue ver **com quem** você fala, **quando** e **quanto**." |

---

**U-14 — Atraso da árvore (só quando a árvore entrar)**

| | |
|---|---|
| **Onde** | `frontend.md` §9 (2.4) |
| **Muda para** | Quando a árvore for habilitada (pós-POC-09), a interface precisa admitir que espectadores em nível ≥ 2 ficam **1–2 s atrás**, somando por nível. É broadcast, não chamada. |
| **Status** | **Não se aplica ao v1** (U-09). Registrado para não se perder. |

---

**U-15 — Ban oculta mensagens de forma reversível**

| | |
|---|---|
| **Onde** | `frontend.md` §10 (3.3), fluxo D12 |
| **Hoje** | O texto sugere remoção permanente das mensagens do banido. |
| **Muda para** | Revogar o ban **reexibe** as mensagens. O modal de confirmação diz isso. |
| **Por quê** | `backend-v2.md` §18.2. |

---

**U-16 — Ser expulso ou banido tem uma tela**

| | |
|---|---|
| **Onde** | `frontend.md` §12; novo estado na Camada 1 |
| **Hoje** | Não existe. O app do alvo simplesmente pararia de funcionar naquela comunidade. |
| **Muda para** | Ao observar o próprio ban/kick, a comunidade entra em **modo histórico somente leitura**, com um cabeçalho nomeado dizendo o que aconteceu, quem fez e o motivo (quando houver), e por quanto tempo a cópia local será mantida (7 dias) com opção de apagar agora. |
| **Por quê** | `F-35`, `DR-35`: o ciclo de vida do dado no cliente do alvo não existia. `backend-v2.md` §18.4. |

---

**U-17 — Comunidade encerrada tem aparência definida**

| | |
|---|---|
| **Onde** | `frontend.md` §10 (3.1b) e rail |
| **Hoje** | A UX especifica **encerrar**, mas não como a comunidade encerrada aparece depois. |
| **Muda para** | Permanece no rail, em modo histórico legível, com ícone esmaecido e cabeçalho "Esta comunidade foi encerrada em <data>". Sem composer, sem ações de escrita. Opção de removê-la do rail. |

---

**U-18 — Sucessão de host é uma tela nova, com limitação declarada**

| | |
|---|---|
| **Onde** | `frontend.md` §10 (3.1b, novo bloco) |
| **Muda para** | Três superfícies: (a) o host designa até 5 sucessores em ordem de prioridade; (b) o sucessor, após 30 dias de inatividade do host, recebe a oferta de assumir; (c) depois de assumir, uma lista de **reentradas pendentes** — quem da comunidade original ainda não entrou na continuação —, com o convite a distribuir e o estado de cada pessoa. |
| **Texto obrigatório** | "Assumir cria uma continuação da comunidade: canais, cargos e moderação são preservados. **As pessoas precisam entrar de novo** — cada uma entra com a própria chave, por convite, e recebe os cargos que tinha. **O histórico de mensagens permanece na comunidade original** e continua acessível para quem já o tem." |
| **Por quê** | `T-43` na parte de continuidade. `adr-v2.md` A23 e a emenda de 2026-08-22 (`ACHADO-G12-01`), L-15, L-23, `backend-v2.md` §18.8.1. |

---

**U-19 — Editar não apaga o conteúdo anterior**

| | |
|---|---|
| **Onde** | `frontend.md` §9 (2.1, editar mensagem) |
| **Muda para** | A interface não promete que a versão anterior desaparece. O conteúdo antigo fica no log e é recuperável por quem inspecionar a cópia da comunidade. |

---

**U-20 — Deletar não apaga os bytes**

| | |
|---|---|
| **Onde** | `frontend.md` §9 (2.1); D12 |
| **Hoje** | "Removida para todo mundo. Não pode ser desfeito." |
| **Muda para** | Mesma nota de honestidade que a exclusão de canal já tem: some da interface de todo mundo ao sincronizar; os bytes continuam no registro da comunidade. |

---

**U-21 — Configuração de rede não padrão é visível**

| | |
|---|---|
| **Onde** | `frontend.md` §10 (3.1 → Rede) |
| **Muda para** | Quando `P2P_BOOTSTRAP`, `P2P_STUN_SERVERS` ou `P2P_DATA_DIR` estiverem fora do default, a tela exibe um indicador permanente: "Configuração de rede não padrão ativa", listando quais. |
| **Por quê** | `T-22`: configuração sem integridade permite eclipse do DHT e vazamento de IP. Se não dá para impedir, tem que ficar visível. |

---

**U-22 — Divergência entre confirmação e histórico é visível**

| | |
|---|---|
| **Onde** | `frontend.md` §10 (3.1 → Rede) |
| **Muda para** | Se o host confirmar operações que não aparecem no histórico replicado, a tela mostra: "Quem hospeda confirmou N operações suas que não aparecem no histórico da comunidade." |
| **Por quê** | `backend-v2.md` §25.6 — é a única detecção possível de censura por omissão, e escondê-la contradiz o princípio 3. |

---

**U-23 — Auto-save vira salvamento explícito**

| | |
|---|---|
| **Onde** | `frontend.md` §13 (formulários), 3.1b, 3.2, 3.4 |
| **Hoje** | Auto-save com debounce de 800 ms nos formulários de comunidade, canal e cargo, com toast "Alterações salvas". |
| **Muda para** | Botão **"Salvar alterações"** com estado sujo, desabilitado quando não há mudança, e estado de carregamento durante o envio. Desabilitado com tooltip quando o host está offline. |
| **Por quê** | `F-12`: auto-save de 800 ms contra uma operação síncrona, num log append-only, com rate limit de 20/60 s, produz uma operação por tecla e queima o limite. Não é ajuste de debounce: é incompatibilidade de modelo. |

---

**U-24 — Preferências passam a ser lidas do backend**

| | |
|---|---|
| **Onde** | `frontend.md` §10 (3.1 → Dispositivos, Notificações), rail |
| **Hoje** | As telas escrevem preferências e o mock as guarda no renderer. |
| **Muda para** | Ao abrir 3.1, os valores vêm de `query.preferences`. O rail lê `notificationLevel` para decidir traço e badge. |
| **Por quê** | `RT-02`: escrita sem leitura — quatro superfícies exibiam dado sem fonte. |

---

**U-25 — A migração para Electron é trabalho reconhecido**

| | |
|---|---|
| **Onde** | `frontend.md` premissa 1; §4 (navegação) |
| **Hoje** | Premissa 1 diz que o mock é web e que shell de desktop "aparece só como nota de compatibilidade futura". A spec de v1 dizia que substituir fixtures "não toca componente nenhum". |
| **Muda para** | A plataforma-alvo do v1 é **Electron empacotado**, na matriz fechada de A16. A migração inclui: shell, `MemoryRouter`, CSP sem `unsafe-inline` e sem host externo, `contextIsolation`/`sandbox`, empacotamento, assinatura e deep links. Isso **é** trabalho de frontend, e precisa estar no plano. |
| **Por quê** | `DR-02`. |

---

**U-26 — Não há descoberta LAN**

| | |
|---|---|
| **Onde** | `frontend.md` §10 (3.1 → Rede), §12 |
| **Muda para** | Declarar que dois dispositivos na mesma rede, sem internet, **não** se encontram. O produto depende do DHT. |

---

**U-27 — "Invisível" é invisibilidade na interface, não anonimato de rede**

| | |
|---|---|
| **Onde** | `frontend.md` §8 (1.4, seletor de presença), §10 (3.1 → Rede) |
| **Hoje** | "Invisível" é apresentado como equivalente a estar offline para os outros. |
| **Muda para** | Continua verdadeiro **na interface**: quem está invisível não publica presença e aparece como offline. Mas o endereço continua sendo anunciado no DHT e é observável por quem participa dos mesmos tópicos. |
| **Por quê** | `T-24` / `L-20`. Prometer anonimato de rede que a arquitetura não entrega contradiz o princípio 3. |
| **Texto obrigatório** | "Invisível esconde você da lista de membros. Ele **não** esconde que este computador está conectado à comunidade — isso é visível para quem participa da mesma rede de distribuição." |

---

**U-28 — O que está em claro no disco**

| | |
|---|---|
| **Onde** | `frontend.md` §10 (3.1, nova seção "Privacidade") |
| **Hoje** | A UX não fala do assunto. |
| **Muda para** | Uma seção curta declarando que **só a chave privada e as sementes são cifradas em repouso**: mensagens, nomes, anexos e a cópia da comunidade ficam em claro no disco. |
| **Por quê** | `T-36` / `L-21`. Cifrar o banco inteiro exigiria uma senha mestra, que reintroduz "esqueci minha senha" num produto sem servidor — a decisão é **não** cifrar e **dizer**. |
| **Texto obrigatório** | "As comunidades ficam salvas neste computador sem criptografia adicional. Quem tiver acesso a este usuário do sistema consegue ler o histórico. Sua chave de identidade, essa sim, fica protegida pelo cofre do sistema operacional." |

---

**U-29 — Sair da comunidade com o host offline sai localmente, mas os outros podem não saber**

| | |
|---|---|
| **Onde** | `frontend.md` §10 (3.1b, sair da comunidade); §15 (confirmações) |
| **Hoje** | A confirmação de saída não distingue host online de offline. |
| **Muda para** | A saída tem efeito local imediato nos dois casos. Com o host offline, a confirmação avisa que o aviso de saída só chega aos outros quando o host voltar. |
| **Por quê** | `L-22`: `member.leave` é a única op de não-mensagem que enfileira, porque o efeito local não depende do host. Se o host nunca voltar, os demais continuam vendo a pessoa no roster. |
| **Texto obrigatório** | (host offline) "Você vai sair agora neste computador. Como quem hospeda está offline, as outras pessoas só vão ver sua saída quando ela voltar." |

---

**U-30 — O seletor de emoji vira o ponto de aplicação de "uma reação = um emoji"**

| | |
|---|---|
| **Onde** | `frontend.md` §9 2.1 (reações) e §6 (composer); `backend-v2.md` §8.6 (`Reaction.emoji`, `Community.iconEmoji`) |
| **Hoje** | O seletor "não tem spec própria", e §9 2.1 só o descreve como "curado, sem dependência nova nem busca — mesma postura das 7 cores de cargo (§5.4)". O catálogo nunca foi enumerado. A garantia de que uma reação é **um** emoji vinha do `fold`, que recusava tudo que não fosse exatamente **1 grafema**. |
| **Muda para** | O catálogo curado passa a ser **normativo e enumerado**, e é a **única** origem de `emoji` que a interface submete em `reaction.set` e em `community.create`/`community.update` (`iconEmoji`). Não há campo livre, não há busca, não há catálogo completo do sistema — a mesma postura das 7 cores de cargo. |
| **Por quê** | `RISCO-01`: contar grafema dentro do `fold` tornava a interpretação do log função da versão de ICU do runtime, o que §1.5 proíbe. §8.6 passou a contar **code points**, e com isso o `fold` deixou de julgar "emoji-ness": ele aplica tetos determinísticos (1–8 code points, ≤ 32 bytes) e aceitaria `ab` como reação. A garantia migrou para a UI — e garantia sem ponto de aplicação declarado não é garantia. |
| **Catálogo (v1)** | 👍 ❤️ 😂 🎉 🚀 👀 🔥 ✅ 🙏 💡 😅 😮 😢 🤔 👏 💯 🐛 🛠️ 📌 ⚡ 🥳 🤝 ☕ 🌙 — 24 entradas distintas. Medido: máximo de **2 code points** e **7 bytes** por entrada (`❤️` e `🛠️` carregam `U+FE0F`), todas dentro do limite de §8.6. |
| **Renderização** | O chip renderiza **o que está no log**, não o que está no catálogo. Outra réplica pode ter appendado qualquer string dentro do limite de §8.6, o `fold` a aceita, e esconder estado aceito criaria divergência entre o que a réplica sabe e o que ela mostra. A UI não substitui, não trunca o valor e não quebra o layout: o chip tem largura máxima e o excedente é elidido visualmente. |
| **Não é constante de protocolo** | O catálogo **não** entra em §27.1. Ele não decide se uma op tem efeito — quem decide são os tetos de §8.6 —, então acrescentar ou remover emoji é decisão de produto, sem bump de `opVersion` e sem plano de compatibilidade. Duas instalações com catálogos diferentes interoperam: cada uma oferece o seu e ambas renderizam o do log. |

---

**U-31 — macOS sai da matriz de plataforma, e isso é dito**

| | |
|---|---|
| **Onde** | `frontend.md` §10 (3.1, "Sobre"); página/tela de download ou primeira execução; `adr-v2.md` A16 |
| **Hoje** | A UX supõe a matriz de quatro alvos de A16 (Windows x64, macOS arm64, macOS x64, Linux x64) e não fala de plataforma em lugar nenhum. |
| **Muda para** | O v1 roda em **Windows x64 e Linux x64 (glibc ≥ 2.31)**. macOS, Alpine/musl e ARM Linux ficam **fora de suporte**, declarado onde alguém possa tentar instalar. Como não sobrou alvo arm64, **não existe build para Apple Silicon nem para Linux ARM** — e não existe build "não suportado, use por sua conta": não existe build. |
| **Por quê** | A16, 2026-08-16: decisão de escopo, não resultado de gate. Sem máquina Apple não há como produzir nem manter a evidência que G0 exige — build empacotado, assinado, notarizado, 100 cold starts, crash e restart. Anunciar um alvo que ninguém consegue testar é exatamente o que a matriz fechada existe para impedir. |
| **Texto obrigatório** | "Este aplicativo roda em Windows e Linux. Não há versão para Mac." — sem "ainda", sem "em breve" e sem lista de espera, enquanto não houver máquina para sustentar o alvo. |
| **O que não muda** | Nada do produto. macOS nunca teve comportamento próprio na UX: não há tela, atalho ou fluxo que sumam com a remoção. O que sai é a promessa de plataforma. |

---
---

**U-32 — A fila de karaokê e o Modo Música entram no §9, 2.3 (emenda de 2026-08-28)**

| | |
|---|---|
| **Onde** | `frontend.md` §9 2.3 (canal de voz) e 2.3.1 (painel da chamada); `backend-v2.md` §16.4 (fila) e §17.5 (Modo Música, emenda) |
| **Hoje** | O §9, 2.3 descreve a barra de controles como "mudo, ensurdecer, câmera, compartilhar tela, sair, atalho de configuração de dispositivo" — a fila de karaokê do modo fila (§6.6 `speechMode = 1`) e a captura de áudio do sistema não existiam na tela. |
| **Muda para** | **Barra de controles (2.3)** ganha dois botões de 24px no mesmo corpo circular dos vizinhos: **Modo Música** (`Music`, e `AudioLines` quando tocando — a troca de ícone é a pista de §5.4, cor nunca é pista única) e **Gravação local** (`Circle` → `Square` enquanto grava). **Painel da fila**, só em canal `speechMode = 1`, como faixa `border-t` abaixo da barra de controles, na anatomia de painel de 2.3.1 (`border-subtle`, padding 12px): rótulo `caption` caixa-alta "Fila (karaokê)"; pill de estado "fila fechada" no tom de aviso lavado a 15% (construção do `Badge`, semelhança do `StatusBanner`); ações de lista como botões de ícone com **44px de alvo no Mobile e 32px onde há ponteiro** (o precedente do botão de sair de 2.3.1), sempre com `Tooltip` — coroa (dar a vez), relógio (+1 min), skip (pular), user-minus (tirar da fila); o card do palco em `surface-elevated` com contagem em `tabular-nums`. **Painel do Modo Música**, só enquanto ativo (ou com erro a mostrar): volume no `Slider` de §6 e a preferência de microfone mudo no `Checkbox` de §6 — nenhum input nativo estilizado à mão. |
| **Por quê** | O primeiro pouso da fila inventou CSS que o projeto já tinha resolvido: botão com `hover:brightness` à mão, `input[range]` com `accent-*`, checkbox cru, e alvos de toque de 32px num painel que o Mobile usa. Além de divergir visualmente, violava duas regras escritas — §5.4 (a música tocando mudava só de cor) e a convenção de 44px/32px do shell. A refatoração não muda comportamento nenhum: os mesmos comandos de §16.4, os mesmos estados, só a superfície. |
| **Regra de esconder × inativo** | "Entrar na fila" **some** quando a fila está fechada — a pill diz o porquê; botão visível e morto seria decorativa (§15, mesmo argumento do botão de tela de 2.3.1). As ações de moderação (coroa, relógio, skip, remover) **não renderizam** para quem não tem `voice_mute_others` — §15 manda esconder, nunca desabilitar por permissão. |
| **O que não muda** | A barra de controles continua 24px/`size-11` circular; mudo e ensurdecer continuam na barra de usuário; o painel recolhido (2.3.1) ganha o botão "Música" na linha 2 com a mesma regra de ícone trocado da câmera e da tela, e nada mais. |

---

**U-33 — A conversa direta é uma superfície nova inteira (§31)**

| | |
|---|---|
| **Onde** | `frontend.md` §3 (destino novo na Camada 2), §8 1.1 (rail e barra de usuário), §9 2.1 (a conversa reusa a anatomia do canal de texto), §10 3.1 (política de contato e notificação); `backend-v2.md` §31 inteira, com §31.9, §31.11, §31.13, §31.16 e §31.19 como fonte |
| **Hoje** | Não existe. Toda a UX de `frontend.md` é **por comunidade**: o rail lista comunidades, o canal pertence a uma, a permissão vem de um cargo e a moderação tem um host. Numa conversa direta não há nenhuma das quatro coisas, e nenhuma tela atual sobrevive sem tradução. |
| **Muda para** | Uma **lista de conversas** e uma **conversa**, nas duas colunas que o shell já tem: a lista ocupa o slot da lista de canais (240px) e a conversa o slot de conteúdo. A linha de conversa mostra avatar, nome de exibição **e o `handle` de §6.1 sempre junto** (§31.16.3 não tem `collision`: numa dupla não há conjunto em que colidir, e a mitigação (a) de **L-5** vale aqui mais forte, porque para falar com alguém é preciso já ter a chave dele), o trecho da última mensagem, a hora e o contador de não-lidas de §31.11. A conversa reusa a anatomia de 2.1 — grupo de mensagens por autor, divisor de "Novas mensagens", composer, responder, editar, deletar, reagir — e **perde** o que é da comunidade: sem thread, sem menção, sem cargo, sem fixar, sem moderação, sem link de canal. |
| **Os cinco estados de conversa (§31.9)** | `pending-out`, `pending-in`, `accepted`, `blocked` e `left` são estado **local**, e os cinco têm aparência distinta. `pending-out` — a conversa existe e o composer funciona (escrever é sempre possível, §31.10), com uma faixa dizendo que o outro ainda não aceitou e que **por isso nada aparece como entregue** (regra 1: aceitar é o que cria o core do outro lado, logo não existe `ack` dele). `pending-in` — não é conversa ainda, é **pedido** (abaixo). `accepted` — a conversa plena. `blocked` — modo histórico legível, sem composer, com a ação de desbloquear; a lista o mostra com o ícone esmaecido, como a comunidade encerrada de **U-17**. `left` — some da lista; o que sobrevive no disco é a linha mínima de §31.19, e o texto de esquecer já disse isso. |
| **O pedido não aceito** | `pending-in` entra numa seção própria no topo da lista, com contador — e **não** como uma conversa comum, porque aceitar é um ato (§31.9 regra 1) e o desenho não pode fazer o aceite acontecer por engano ao abrir. O pedido mostra quem é (nome, `handle`, avatar) e quantos registros do par já chegaram (`pendingRecords`), com três ações: **aceitar**, **bloquear** e **esquecer**. O teto de §31.9 regra 4 tem superfície: cheio, os pedidos novos são recusados com `E_LIMIT_EXCEEDED`, e a lista diz isso na própria seção — **não há descarte silencioso do mais antigo**, então um teto atingido que não aparecesse na tela seria pedido perdido sem ninguém saber. |
| **Rótulos de entrega, e o que eles não podem dizer** | A tabela de §31.11 é fechada: `written`, `delivered`, `undelivered`, `deleted`. Só as **próprias** mensagens levam rótulo. `undelivered` aparece como "não entregue" **com o tempo desde a escrita** e **nada mais** — a UI é proibida de afirmar a causa (**L-26**), e a proibição não é estética: `undelivered` é literalmente indistinguível entre o par offline e o par que bloqueou (§31.9 regra 2, **L-28**). Escrever "ele está offline" seria inventar o fato que o protocolo recusa dar. Pela mesma razão `delivered` **não** pode ser rotulado "lido": o `ack` só avança quando o par **escreve**, e atesta que os registros chegaram, não que alguém os leu (§31.11). |
| **Marca de ordem provisória (L-27)** | Mensagem com `ackAhead` leva uma marca discreta na própria mensagem e a faixa afetada leva um rótulo de **ordem provisória**, com o texto explicando que a posição foi declarada pelo autor e não confirmada pela ordem causal. Marcado, nunca corrigido e nunca escondido: não há terceiro a enganar numa dupla, e recusar o registro daria a um contador quebrado o poder de parar a conversa (§31.6). `clockSkewed` usa a mesma gramática de marca, com o texto do relógio. |
| **Recarga obrigatória por `dm.reordered`** | É o único evento de §31.16.2 que a UI **não pode** tratar como "reconsultar se quiser": a história mudou de ordem a partir de `fromOrdSum` (§31.13, inserção retroativa), e a lista renderizada deixou de ser a corrente. A recarga daquela faixa é obrigatória, e o desenho precisa aguentá-la sem salto de rolagem — a âncora é a mensagem que estava sob o cursor, como no divisor de não-lidas de 2.1. |
| **Estados de sincronização** | Os sete de §31.13 (`synced`, `catching-up`, `stalled`, `peer-offline`, `unauthorized`, `forked`, `desynced`) entram no cabeçalho da conversa na gramática dos estados transversais de `frontend.md` §3 — faixa, não modal, porque a conversa continua legível em todos eles. Dois deles têm consequência que a faixa precisa nomear: `desynced` **impede escrever** (`E_DM_FORKED`) e espera o próximo contato com o par (§31.13, §103.1), e `forked` para de appendar e oferece exportar e escolher o ramo (§18.9), sem merge automático. `unauthorized` usa exatamente o mesmo texto que `peer-offline` — distingui-los na tela desfaria **L-28** por um caminho lateral. |
| **Texto obrigatório — esquecer conversa (L-25)** | "Isto apaga as mensagens desta conversa desta máquina e não pode ser desfeito. Uma marca mínima da conversa **permanece no disco** — sem ela, escrever de novo para esta pessoa corromperia a cópia que ela tem. Apagar tudo só é possível apagando a identidade." `dm.forget` está na classe `main-confirmed` de §15.3, então o modal é obrigatório de qualquer forma; o que **U-33** fixa é que ele nomeia a consequência exata, na regra de §15. |
| **Texto obrigatório — bloquear (L-28)** | "A outra pessoa **não é avisada**. Para ela, você fica igual a alguém desligado." Sem eufemismo e sem promessa de invisibilidade: o bloqueio é silencioso porque avisar transformaria o bloqueio num sinal para escalar (§31.9 regra 2), e quem bloqueia precisa saber que o silêncio é o mecanismo, não um efeito colateral. |
| **Voz numa conversa direta (L-29)** | A chamada de dois usa o painel de chamada de 2.3.1 sem roster, sem fila e sem ocupação — numa dupla o roster é a própria conversa (§31.15). Quando ela falha, o desfecho é `conn-failed` **com o diagnóstico de rede de §99** e **sem oferecer relay**: não há relay voluntário numa DM, porque ele pressupõe um terceiro que não existe. O texto diz que a chamada precisa de pelo menos um dos dois alcançável, e o que **não** pode aparecer é o caminho de recuperação que §17.7 oferece na comunidade — oferecer o que não existe é pior do que declarar a falha. |
| **Política de contato (§31.9 regra 5)** | `dmContactPolicy` entra em 3.1 como escolha de duas opções, default "qualquer pessoa", **com o custo escrito junto**: em "só quem tem comunidade em comum", ninguém de fora consegue falar com você pela primeira vez. É a única defesa real contra Sybil num sistema em que identidade é gratuita (**L-8**), e é local — não muda o protocolo e não é visível para ninguém. |
| **Perfil é por conversa** | `dm.setProfile` (§31.16.1) escreve `displayName`/`avatarColor` **naquela conversa**, não globalmente: não há perfil de comunidade a herdar. O ponto de edição fica no cabeçalho da conversa, e o piso de §31.7.5 (2–32 code points) é validação de formulário na regra de §13, inline — um nome vazio faz o registro ser recusado pelo `dmFold` e o lado inteiro virar `invalid`, o que na tela seria uma conversa que nasce morta em silêncio. |
| **O que não existe, e a ausência é o contrato** | Não há **"enviando"**, **"falhou"**, **"na fila"** nem **"tentar de novo"**. `dm.send` é síncrono e a mensagem é final assim que escrita (§31.10): não há outbox, e os cinco estados de outbox de §31.11 não são declarados porque não podem ocorrer. O cliente de IPC-R reflete isso — não existem `dmRetry` nem `dmCancelQueued` (§105) —, e o composer não pode inventar um estado intermediário que o núcleo não tem. Também não há **confirmação de leitura** (§31.5), **menção**, **thread**, **fixar**, **busca global na DM** (§31.16.3 não a declara) nem qualquer ação de moderação. |
| **Regra de esconder × inativo** | "Aceitar" e "bloquear" existem **só** em `pending-in`; "desbloquear" **só** em `blocked`. Nada de botão visível e morto — é a regra de §15, e o precedente é o de U-32. A exceção é o composer em `desynced`/`forked`: ele **fica visível e desabilitado**, com a faixa dizendo o porquê, porque aqui o estado é temporário e sumir com o composer faria a conversa parecer somente-leitura por natureza. |
| **O que não muda** | O design system inteiro (§5), a biblioteca de componentes (§6), a anatomia da mensagem e do composer de 2.1, o painel de chamada de 2.3.1, os alvos de 44px/32px e a regra de cor nunca ser pista única (§5.4). U-33 não pede componente novo — pede um destino novo montado com o que já existe. |
| **Em aberto, e declarado** | **Onde a DM mora na navegação** e **como a notificação dela é configurada** são **B63**, e não se derivam de §31: a primeira é escolha de arquitetura de informação e a segunda esbarra em `settings.setNotifications` ser por comunidade, que uma DM não tem. As duas propostas estão escritas em B63 e valem enquanto ninguém decidir o contrário; o resto de U-33 não depende delas. `lag` e as listas de `partialInterpretation` chegam à UI como `0` e vazias enquanto a fonte não existir (§105.7) — a superfície **não anuncia** número que ninguém mediu. |
| **Por quê** | §31.24 declara **L-25 a L-29**, e as cinco linhas da coluna "Superfície de UI obrigatória" daquela tabela são requisito normativo, não escolha de produto: sem elas, cinco limitações reais do sistema ficariam invisíveis para quem as sofre. O resto é derivação do contrato de §31.16 — 14 comandos, 12 eventos e 5 queries que já existem (§105) e que nenhuma tela consumia. |

**Emenda de 2026-09-05 — a chamada de DM precisa de superfície fora da conversa.** A linha
"Voz numa conversa direta (L-29)" acima diz que a chamada usa o painel de 2.3.1, e 2.3.1 é
justamente **a superfície que sobrevive à navegação** (§11 C11: "a chamada pode ser de uma
comunidade que nem está aberta, e este painel é o que diz isso"). Na DM isso não estava
escrito, e o produto tirava a conclusão contrária: atender e desligar existiam **só** no
cabeçalho da conversa, sob a guarda de ser a conversa aberta. Uma chamada que chegasse com o
app noutra conversa — ou numa comunidade — não tinha superfície nenhuma: não dava para
atender, não dava para recusar, e "voz é uma só" (§15.4) ainda impedia iniciar outra, com um
erro sobre uma chamada que ninguém via.

O que a emenda fixa: **a chamada de DM ocupa o mesmo slot do painel de chamada** — acima da
barra de usuário, com a largura dela — sempre que houver chamada, nos três estados que a têm
(`recebendo`, `chamando`, `na-chamada`). Ele **some** quando a conversa da chamada é a que
está na tela, onde o cabeçalho já oferece isso e mais (mudo, câmera, tela e o palco): repetir
o mesmo par de botões 8px acima é o argumento que já tirou mudo e ensurdecer do painel da
comunidade. Atender **leva para a conversa**, porque a imagem e o mudo moram lá; uma chamada
atendida sem eles é a metade que ninguém pediu.

O que ele **não** traz continua sendo a tabela de remoções de §31.15: sem roster, sem
ocupação, sem fila, sem revogação — e sem relay (**L-29**), aqui como no cabeçalho. Os rótulos
não afirmam nada sobre o outro lado: "Chamando…" é fato local, não "está tocando lá".

**Emenda de 2026-09-05 — de onde sai o divisor de "Novas mensagens".** A linha "Muda para"
exige o divisor, e ele não era derivável: §31.16.3 dava `unread.count` (**quantas**) e não o
watermark (**onde**). `query.dmMessages` e `query.dmConversation` passam a devolver
`lastReadOrdSum` e `lastReadAuthorKey` (§31.16.3, emenda da mesma data). Duas regras de tela
acompanham: o corte é **congelado na abertura** — abrir marca como lida logo em seguida, e um
divisor que seguisse o watermark sumiria no mesmo quadro em que apareceu — e a comparação usa
o `ordKey` **inteiro** de §31.6, senão o divisor discorda do selo no empate de `ordSum`.

**Emenda de 2026-09-05 — a conversa em foco não acumula não lidas.** A contagem de §31.12 é
por watermark e não sabe o que está na tela: sem remarcar ao receber, a conversa aberta ganhava
selo sobre si mesma. O renderer remarca ao chegar lote com `hasIncoming` (§31.16.2) na conversa
em foco — e **só** com ele: um lote só meu não tem o que dar por lido.

---

**U-34 — A chave pública de identidade é um endereço, e a UI precisa deixar entregá-lo (§31.8, L-24)**

| | |
|---|---|
| **Onde** | `frontend.md` §10, 3.1 (Configurações → Minha conta); `backend-v2.md` §31.8, §31.16.1 `dm.open`, §25.8 **L-24**, §31.25 |
| **Hoje** | `frontend.md` 3.1 diz "identificador local e **chave truncada** em somente-leitura", e é o que o produto faz: `@k3f9-2mqa · a1b2c3d4…f9e2`, sem copiar. Não há outro lugar no programa que mostre a chave. |
| **Por que isso deixou de servir** | Em v1 a chave era só um identificador a exibir. Com §31 ela virou **endereço**: por **L-24** a chave pública **é** o nó na DHT, `dm.open` recebe um hex64 cru (§31.16.1), e §31.25 registra que "o único caminho para abrir uma conversa é colar 64 caracteres hex". Isso pressupõe que o outro lado consiga **fornecer** os 64 caracteres, e truncada ela não é fornecível. §31.8 fecha a porta de saída: não há diretório, não há busca e o rendezvous por segredo compartilhado foi recusado porque não funciona no primeiro contato. Sem entregar a chave, ninguém consegue abrir a primeira conversa com você. |
| **Muda para** | A chave pública aparece **inteira**, em fonte monoespaçada, com ação de **copiar** — a mesma afordância do link de convite de 3.2, e pelo mesmo motivo: é um endereço que existe para ser passado adiante. Continua **somente-leitura** (não há o que editar numa chave derivada). O `handle` de §6.1 continua ao lado: ele é o que se reconhece, ela é o que se cola, e a mitigação (a) de **L-5** vale nos dois sentidos. |
| **A distinção que a tela é obrigada a fazer** | O texto de 3.1 hoje diz, sob a chave: *"Esta chave existe só neste dispositivo. Ninguém, em lugar nenhum, tem uma cópia dela."* Isso é verdade da chave **privada** e falso da **pública** — a pública está, por construção, na DHT e no log de toda comunidade de que você participa. Colada sob a pública, a frase lê como "não compartilhe", que é o oposto do que §31.8 exige. As duas passam a ser nomeadas separadamente: a **pública** é o endereço, e entregá-la é o uso normal; a **privada** é a que nunca sai do dispositivo, e a zona de perigo já diz o que acontece quando ela some. |
| **O que a UI não pode dizer** | Que copiar a chave pública tem risco de segurança — não tem, e um aviso ali faria a pessoa não entregar o único endereço que ela tem. E não pode oferecer nenhuma forma de exportar, exibir ou copiar a chave **privada**: §3.2 item 5 e §15.4 não dão superfície para isso, e `identity.export` (U-01) é backup cifrado, não exibição. |
| **O que não muda** | O restante de 3.1 — nome editável, "Gerar outra cor", presença e a zona de perigo com "Sair desta identidade" sob confirmação. Nenhum componente novo: `TextField` somente-leitura e o botão de copiar já existem. |
| **Por quê** | `frontend.md` 3.1 e §31.8 se contradizem, e a precedência resolve (`backend-v2.md` 1 > `deltas-ux-v2.md` 4 > `frontend.md` 5). Mas a contradição precisa estar **escrita**, e não resolvida em silêncio no código: **L-24** é uma limitação declarada em §25.8, e a regra de completude deste documento manda toda limitação de §25.8 ter superfície de UI obrigatória. A de L-24 era "não há descoberta: você precisa da chave" — e ela não estava coberta dos dois lados. U-33 cobriu o lado de quem **cola**; este cobre o lado de quem **entrega**. |

---

## 2. Resolução das divergências da matriz de rastreabilidade

A matriz classificou 117 comportamentos: 38 `COMPLETE`, 50 `PARTIAL`, 16 `MISSING`, 12
`CONTRADICTORY`, 1 `UNCLEAR`. Abaixo, a resolução de **todos** os não-`COMPLETE`.

### 2.1 `CONTRADICTORY` (12) — todas resolvidas

| # | Divergência | Resolução |
|---|---|---|
| I-6 | `handle`: três derivações incompatíveis | **Fechado no backend**: `@` + 8 caracteres Crockford-Base32 da chave pública, em 2 grupos (`@k3f9-2mqa`). O mock deixa de derivar do nome; o dataset muda (`@ana` → o handle real da chave da fixture) |
| C-1 | Preview com 6 desfechos × 4 na UX | **U-03** |
| C-2 | Preview `banned` inalcançável pelo firewall | **Resolvido no backend**: canal de admissão separado, sem firewall de banidos (`backend-v2.md` §12.3, §14.3) |
| C-7 | Código de 6 × 16 caracteres | **U-05** |
| K-3, E-2, P-4 | Auto-save × op síncrona × rate limit | **U-23** |
| M-3 | Mensagem pendente assenta ao ser entregue | **Mantido e explicitado**: a bolha é ancorada em `authorTs` enquanto pendente e assenta na posição de `seq` ao ser confirmada. A UI precisa animar a transição, não teleportar |
| M-5 | Reagir otimista sem rollback | **U-02** |
| M-17 | Carimbo: `hostTs` × hora local × mock com um só campo | **Fechado**: `MessageDto` traz `authorTs`, `hostTs` e `clockSkewed`. A UI exibe `authorTs`; com `clockSkewed`, exibe `hostTs` com o aviso. `types.ts` ganha os três campos |
| V-13 | Qualidade de tela inerte | **Resolvido pela estrela** (U-09): em WebRTC direto, o bitrate é por espectador e o comando funciona. **Emenda de 2026-08-26 (U-25):** funciona, e o comando é **de quem apresenta** — o `maxBitrate` mora no `RTCRtpSender` dele, então quem pedia o perfil não era quem pagava por ele |
| V-19 | Múltiplos compartilhamentos | ~~**U-10**~~ → **suportados** desde 2026-08-26; U-10 foi revogada e o requisito de §18 volta a valer |

### 2.2 `MISSING` (16) — resolução

| # | Feature | Resolução |
|---|---|---|
| 1 | Código de convite de terceiros | **Cortada** — U-04 |
| 2 | Rail respeitando "Notificações: Nada" | **Implementada** — `query.preferences` (U-24) |
| 3, 4 | "Copiar link do canal/mensagem" → `/m/:code` | **Implementada com propriedade corrigida**: `query.resolveMessageLink` com quatro desfechos (`ok`, `not-member`, `not-synced`, `deleted`). **A promessa de privacidade cai**: o link contém ids e quem o recebe aprende que aqueles ids existem. A UX precisa parar de afirmar o contrário |
| 5 | Participantes inline do canal de voz | **Implementada** — `voice.occupancyChanged` + `query.structure.voice{count, first[]}` |
| 6 | Quem reagiu (tooltip) | **Implementada** — `query.reactors` |
| 7 | Badge de não-lidas da thread | **Implementada** — `local_thread_read_state` + `query.thread.unread` |
| 8 | Aba Links | **Implementada** — tabela `message_links` com regra de extração fechada (só `http`/`https`, ≤ 8 por mensagem, sem unfurl) |
| 9 | Anel de fala ativa | **Implementada** — `speaking` produzido por VAD no renderer, propagado em `voiceState` e no roster |
| 10 | Anti-escalada de permissão e posição | **Nova na UX**: 3.2 precisa explicar as **três** regras (permissão, posição e cargo base), e desabilitar o que o autor não pode conceder |
| 11 | Atraso de 1–2 s em árvore | **Não se aplica ao v1** — U-09/U-14 |
| 12 | Consentimento de relay voluntário | **Implementada** — U-13 |
| 13 | Sem descoberta LAN | **U-26** |
| 14 | Distinguir rate limit de host offline | **Implementada** — `E_RATE_LIMITED` com `retryAfterMs` tem estado visual próprio (`backend-v2.md` §20.3 regra 4) |
| 15 | "Testar microfone" com medidor real | **Resolvida por fronteira**: a medição é **100 % do renderer** (é o dono da captura). `backend-v2.md` §3.4 declara a exceção explicitamente, então deixa de ser ambiguidade |
| 16 | Anexo corrompido | **Implementada** — evento `attachment.corrupt{cause}` com estado nomeado no card |

### 2.3 `PARTIAL` (50) — o elo que faltava

A matriz observou que 20 das 50 perdiam o **mesmo** elo: contrato de leitura, projeção ou
evento de invalidação. v2 fecha os três de uma vez:

| Elo que faltava | Como v2 fecha |
|---|---|
| Schema das queries | `backend-v2.md` §15.6 — **todas** as queries com schema de resposta e mapeamento para `types.ts` |
| Evento de convite | `invites.changed` |
| Evento de auditoria | `auditLog.changed` |
| `clientRef` no aceite | `message.accepted{opId, clientRef, messageId, seq}` |
| Enum de `hostStatus` | 9 valores fechados, com estado inicial `unknown` |
| Enum de estado de blob | 8 valores fechados, com retomada após crash |
| Reconciliação da outbox | §11.6 — e `query.outbox` devolve `preview` para a UI redesenhar a fila ao reabrir |
| `partial` na busca | 4 causas, devolvidas em `partialReason` |
| Contagem de menções em `markRead` | A resposta declara os dois contadores |
| `replyTo` de mensagem deletada | `{excerpt:null, deleted:true}` — comportamento definido |
| Ciclo de vida do expulso/banido | §18.4 + U-16 |
| Volume por participante | `local_participant_volume` + `settings.setParticipantVolume` |
| Escopo do painel de saúde da árvore | `share.health` **só ao apresentador**, declarado |
| Rótulo do autor no log de auditoria | `byLabel` congelado, como o do alvo |
| Permissão de leitura no log | `query.auditLog` recusa sem `view_audit_log` (+ U-07 sobre o que isso significa) |
| `manage_community` × `create_invite` | Fechado: `create_invite` cria e revoga **o próprio**; `manage_community` revoga **qualquer um** |
| Erro de permissão de câmera do SO | `E_DEVICE_BLOCKED` + `voice.deviceError` |
| Ordenação de cargos | `rank` fracionário; `role.move` devolve `{rank}` |

### 2.4 `UNCLEAR` (1)

| # | Item | Resolução |
|---|---|---|
| V-10 | "Áudio tem prioridade sobre vídeo em rede fraca" | **Decidido**: é comportamento do WebRTC, configurado no renderer via `RTCRtpSender.setParameters({priority})` — áudio em `high`, vídeo em `low`, tela em `medium`. Não há regra de backend; a UX pode manter a promessa porque agora existe o mecanismo |

---

## 3. Mudanças obrigatórias no dataset de referência e nas fixtures

`RT-14` mostrou que o dataset de `frontend.md` §2 — usado por 206 checagens de verificação —
não é produzível pelo modelo real. Correções obrigatórias:

| # | Fixture | Hoje | Precisa virar |
|---|---|---|---|
| 1 | `handle` da Ana | `@ana` (derivado do nome) | `@` + 8 chars Crockford da chave pública da fixture, em 2 grupos |
| 2 | Identificador na lista de banidos | `Usuário#4471` | Nome de exibição + `handle` real |
| 3 | Código de convite | `X7K2QM` (6 chars) | 16 chars em 4 grupos |
| 4 | `InvitePreview` | 4 estados | 6 estados |
| 5 | `MessageDeliveryState` | sem `dropped` | 5 estados: `queued`, `sending`, `awaiting`, `failed`, `dropped` |
| 6 | `Message.timestamp` | um campo | `authorTs`, `hostTs`, `clockSkewed` |
| 7 | Espectadores de tela | 7 espectadores num canal com 3 participantes | Espectadores ⊆ participantes (sem teto desde §90) |
| 8 | `Reaction.userIds` | lista inline | Passa a vir de `query.reactors` sob demanda |
| 9 | `Role.position` | inteiro | `rank` string |
| 10 | `Channel.voiceParticipantIds` | lista completa | `{count, first[≤5]}` |
| 11 | `ModerationAction.tipo` | 10 tipos (spec) / 11 (código) | **20 tipos**, enum único de `backend-v2.md` §6.13 |

**Critério de aceite:** o dataset precisa ser produzível **por ops reais** passando pelo
`fold`. Se uma fixture não for produzível, ela está errada — não o backend. O produtor era
`dev.seedDataset`; com a remoção de `dev.*` em 2026-08-28 (§15.3) o critério passa a valer
sobre as fixtures de `core/test`, que já constroem estado por ops assinadas. O critério não
mudou de conteúdo — mudou de quem o executa.

---

## 4. Mapeamento `types.ts` ↔ contratos de leitura

| Tipo do frontend | Contrato v2 | Mudança |
|---|---|---|
| `Identity` | `query.identity` | `handle` derivado da chave |
| `Community` | `query.communities` / `query.community` | `+ hostStatus`, `+ replication`, `+ partialInterpretation`, `+ notificationLevel`, `+ successorKeys` |
| `Category` | `query.structure` | `position` → `rank` |
| `Channel` | `query.structure` | `position` → `rank`; `voiceParticipantIds` → `voice{count, first[]}` |
| `Role` | `query.roles` | `position` → `rank` |
| `Member` | `query.members` / `query.member` | `+ handle`, `+ collision`, `+ can*` |
| `Message` | `MessageDto` | `timestamp` → `authorTs`/`hostTs`/`clockSkewed`; `content` pode ser `null`; `+ mentionsMe`; `replyTo` estruturado |
| `Thread` | `query.thread` | `+ unread` |
| `Reaction` | `ReactionDto` + `query.reactors` | `userIds` sai do payload principal |
| `Attachment` | `AttachmentDto` | `+ blobsCoreKey`, `+ state` (enum de 8) |
| `Invite` | `query.invites` | `code` opcional; `+ codeAvailable`, `+ label` |
| `ModerationAction` | `query.auditLog` | enum de 19; `+ byLabel` |
| `ConnectionHealth` | `query.hostStatus` + `community.replication` | `hostStatus` com 9 valores; `+ replication` |
| `InvitePreview` | §12.3 | 6 desfechos |
| `MessageDeliveryState` | `query.outbox` | 5 estados |

---

## 5. Custo estimado da mudança no frontend implementado

Registrado porque a matriz apontou que "o custo de reverter não está estimado em documento
nenhum" — e porque é informação necessária para a decisão de produto.

| Área | Impacto | Natureza |
|---|---|---|
| Migração web → Electron | **Alto** | Shell, roteamento, CSP, empacotamento (U-25). Não é "zero toque" |
| Formulários com auto-save → salvamento explícito | **Médio** | 3.1b, 3.2, 3.4 — muda o padrão de interação, não os componentes |
| Eixo otimista de reação/edição/pin/thread | **Médio** | `messageStore` ganha o mesmo ciclo de entrega que `send` já tem |
| `handle`, código de convite, timestamp, `rank` | **Médio** | Toca `types.ts`, fixtures e ~206 checagens de verificação |
| Telas novas (backup, sucessão, removido, relay, estados de sistema) | **Alto** | 7 superfícies novas |
| Queries de leitura substituindo fixtures | **Baixo por tela, alto no total** | É o trabalho já previsto; agora com schema, então é mecânico |
| Cortes (código de terceiros, múltiplos shares, aviso de saída, árvore) | **Negativo** (remove trabalho) | — |

---

## 6. O que **não** muda

Para deixar explícito o que a arquitetura preservou:

Arquitetura de informação em 4 camadas · navegação e rotas (exceto a adição da restauração
de identidade) · design system inteiro (superfícies, cor, tipografia, espaçamento, motion) ·
biblioteca de componentes · canal de texto, thread, busca, painel de membros, perfil ·
CRUD de canais e categorias · gestão de cargos (exceto o modelo de ordenação) ·
moderação (exceto os textos de honestidade) · voz e câmera em mesh · barra de chamada
persistente e continuidade entre canais · fila offline durável e seus estados · modo
cache com host offline · consentimento de repasse · diagnóstico de rede · princípios de
produto, incluindo o princípio 3, que é justamente o que obriga metade dos deltas acima.
