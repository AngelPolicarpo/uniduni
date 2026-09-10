# Threat Model de Segurança — Uniduni

**Documentos modelados**
- `backend.md` — Especificação Técnica do Backend (2.986 linhas), lido integralmente.
- `frontend.md` — Especificação de UX/UI (1.605 linhas), lido integralmente.
- `auditoria-adversarial.md` (F-01…F-50), `auditoria-sistemas-distribuidos.md` (DS-01…DS-31),
  `dry-run-implementacao.md` (DR-01…DR-51) — lidos para cruzamento. Onde um achado deste laudo
  toca um achado existente, a referência está explícita e o que muda é o **ângulo de segurança**,
  não a descoberta do fato.

**Postura.** Isto não é uma revisão genérica de segurança de aplicação. Não há aqui nada sobre
OWASP Top 10 de web, sobre SQL injection em `better-sqlite3` com statements preparados, ou sobre
CSRF num produto sem HTTP. O objeto modelado são **os mecanismos que esta arquitetura define**:
a assinatura de op, a autoridade única de escrita, a projeção determinística, a prova de convite,
o firewall do swarm, a árvore de distribuição de tela, a fronteira do IPC e a superfície do
Hypercore.

**Regra de escopo que respeitei.** O produto tem premissas fechadas — sem servidor central, sem
conta, sem senha, sem multi-dispositivo, sem aprovação manual de convite (`spec:1153`), sem
transferência de host, sem TURN, sem telemetria. **Nenhuma ameaça deste laudo é mitigada com
"adicione um servidor".** Onde a mitigação natural conflita com uma premissa, isso está dito no
campo 11 e a recomendação vira *declarar a limitação* ou *mover o custo para onde a premissa
permite*, nunca *quebrar a premissa por preferência*.

**Calibragem.** "Ameaça" aqui significa: um caminho de ataque concreto contra um mecanismo que a
spec define, com pré-condições verificáveis no texto. Quando o ataque depende de uma leitura
possível mas não certa da spec, isso está no campo 12 (**O que precisa ser validado**), e a
severidade é atribuída ao cenário, não à certeza. **Nenhum mecanismo desta arquitetura foi
comprovado seguro por este exercício** — modelar ameaça em documento não prova ausência de
ameaça.

---

## Convenções

**Severidade**

- **CRITICAL** — compromete a propriedade de segurança central do produto (autoria, isolamento
  entre comunidades, integridade do log, disponibilidade permanente), ou dá a um adversário
  barato um resultado que a spec afirma ser impossível.
- **HIGH** — permite escalada, personificação, exfiltração, censura direcionada ou negação de
  serviço relevante, com pré-condições realistas.
- **MEDIUM** — enfraquece uma defesa declarada, ou cria superfície que exige mais confiança do
  que a spec admite estar depositando.
- **LOW** — exposição contida, ou risco cuja realização depende de condições improváveis.

**Probabilidade** — `Alta` (custo do ataque próximo de zero e motivo comum) · `Média`
(exige preparo, posição ou motivação específica) · `Baixa` (exige recurso, tempo ou acesso raro).

**STRIDE** — `S` Spoofing · `T` Tampering · `R` Repudiation · `I` Information disclosure ·
`D` Denial of service · `E` Elevation of privilege. Onde o STRIDE não descreve bem a ameaça
(replay entre contextos, Sybil, vazamento de capability, censura por omissão), o rótulo está
marcado como `—` e a descrição carrega a classificação real.

**Atores** (os do pedido, com a abreviação usada nas fichas)

| Sigla | Ator |
|---|---|
| `A-LOCAL` | Usuário local malicioso / outro processo do mesmo usuário |
| `A-FS` | Atacante com acesso ao filesystem do usuário |
| `A-PEER` | Peer não autenticado (conhece o `coreKey`, não é membro) |
| `A-MEMBRO` | Membro legítimo malicioso (cliente adulterado) |
| `A-BANIDO` | Membro banido ou que saiu |
| `A-HOST` | Host comprometido ou malicioso |
| `A-SYBIL` | Peer que controla múltiplas identidades |
| `A-MSG` | Atacante capaz de enviar mensagens/quadros arbitrários no protocolo |
| `A-REPLAY` | Atacante capaz de reenviar envelopes/quadros observados |
| `A-META` | Observador de metadados de rede (DHT, bootstrap, relay) |
| `A-DOS` | Atacante buscando negação de serviço |
| `A-RENDER` | Renderer comprometido (dependência maliciosa, bug de UI) |

**Índice de severidade**

| Severidade | Quantidade | IDs |
|---|---|---|
| CRITICAL | 10 | T-01 … T-10 |
| HIGH | 25 | T-11 … T-35 |
| MEDIUM | 10 | T-36 … T-45 |
| LOW | 3 | T-46 … T-48 |

---

## Mapa de fronteiras de confiança

```
                    ┌─────────────────────────────────────────────┐
   TB-6  DHT ───────┤  bootstrap de terceiro · nós arbitrários     │
   (rede pública)   └──────────────────┬──────────────────────────┘
                                       │  UDX/Noise
        ┌──────────────────────────────┼──────────────────────────────┐
        │                              │                              │
   TB-4 │ membro → host (RPC)     TB-5 │ membro ↔ membro         TB-7 │ relay voluntário
        │ validado em 12 estágios      │ replicação, sinalização,     │ blind (dados)
        │ SÓ NO HOST                   │ mídia — sem validação        │ NÃO-blind (tela)
        └──────────────────────────────┴──────────────────────────────┘
                                       │
   ╔═══════════════════════════════════▼═══════════════════════════════════╗
   ║  DISPOSITIVO DO USUÁRIO                                               ║
   ║                                                                       ║
   ║   ┌──────────┐  TB-2: chave privada em claro  ┌───────────────────┐   ║
   ║   │  main    │◀──────────────────────────────▶│  NÚCLEO P2P       │   ║
   ║   │safeStorage│                               │                   │   ║
   ║   └──────────┘                                │  TB-9: comunidade │   ║
   ║        ▲                                      │  A ↔ B no mesmo   │   ║
   ║        │ TB-10: shell.openPath                │  processo, mesmo  │   ║
   ║        │        getDisplayMedia               │  view.db, mesmo   │   ║
   ║   ┌────┴──────┐  TB-1: IPC sem autorização    │  espaço de ids    │   ║
   ║   │ RENDERER  │◀──────────────────────────────▶└─────────┬─────────┘   ║
   ║   │ sandbox   │        (onipotente)                     │             ║
   ║   └───────────┘                                          │ TB-3        ║
   ║                                                          ▼             ║
   ║        p2p/  identity.enc (cifrado) · cores/ (EM CLARO) · view.db     ║
   ║              (EM CLARO) · blobs/ · config.json · logs/                ║
   ╚═══════════════════════════════════════════════════════════════════════╝
```

| # | Fronteira | O que a spec assume | O que realmente atravessa |
|---|---|---|---|
| **TB-1** | renderer ↔ núcleo (`MessagePort`) | Renderer não confiável (`sandbox: true`, CSP estrita, §18.5) | Todos os comandos, incluindo `identity.wipe`, `blob.stage(path)`, `dev.*`. Sem autorização, sem confirmação, sem limite (T-16, T-19, T-20) |
| **TB-2** | main ↔ núcleo | "A chave privada **nunca** cruza o IPC" (§7) | A chave privada, obrigatoriamente (§2.2, §2.3 fase `identity`) — T-21, DR-03 |
| **TB-3** | núcleo ↔ disco | `safeStorage` protege a identidade (ADR-19) | A chave de escrita do core, a projeção inteira, as tabelas `local_*` e `config.json`, todos sem proteção declarada (T-03, T-22, T-36) |
| **TB-4** | membro ↔ host (RPC) | 12 estágios de validação (§9.1) | Validação **cara antes de barata** (assinatura no 3, rate limit no 9) e **só no host** (T-02, T-08) |
| **TB-5** | membro ↔ membro | Não modelada em §18.1 | Replicação integral do core (sem firewall — DR-30), sinalização WebRTC sem autorização, quadros de mídia sem autenticidade (T-04, T-11, T-15) |
| **TB-6** | nó ↔ DHT/bootstrap | "ponto de centralização de fato" (§22.1) | IP de todo participante, e a correlação tópico↔membro para quem se posicionar perto da chave (T-24) |
| **TB-7** | tráfego ↔ relay | "blind relay não lê nada" (ADR-08) | Verdadeiro para UDX; **falso para a árvore de tela**, onde o repassador recebe `codecConfig` + chunks decodificáveis (T-11) |
| **TB-8** | comunidade ↔ host | Host pode omitir/reordenar/truncar, não pode forjar autoria (§18.1) | Pode produzir **efeito arbitrário atribuído a um membro** por replay e transplante de assinaturas genuínas (T-01, T-02) |
| **TB-9** | comunidade A ↔ comunidade B | Isolamento "por coluna `community_id`" (§6.1) | Um processo, um `view.db`, um swarm, um firewall, um espaço global de ids de 48 bits, uma tabela de dedupe (T-25, T-30, T-01) |
| **TB-10** | app ↔ SO | `shell.openPath` no main (`ARQ-09`), `setDisplayMediaRequestHandler` | Arquivo de terceiro entregue ao handler default do SO sem allowlist nem quarentena (T-17); captura de tela iniciada antes da autorização (T-41) |

---
# CRITICAL

---

## T-01 — A `Op` não é vinculada à comunidade: uma assinatura genuína vale em toda comunidade onde o autor exista

**Severidade:** CRITICAL · **Probabilidade:** Média · **STRIDE:** S · T · R

**1. Ativo afetado.** Autoria de qualquer op; log de auditoria; estado de moderação; a afirmação
central de §7 e §18.1 ("o host não consegue forjar autoria").

**2. Ator.** `A-HOST` (host que hospeda B e consegue ler o log de A), secundariamente `A-MEMBRO`
contra si mesmo em outra comunidade.

**3. Pré-condições.**
- §5.1: `Op` = `v · kind · author · ts · nonce · payload`. **Não existe campo de comunidade.**
- §5.1: `sig` = Ed25519 sobre `BLAKE2b('op/1' ‖ op)` — o domínio de separação é do *tipo de hash*,
  não do *contexto de aplicação*.
- §5.3: os payloads de `mod.ban`, `mod.kick`, `mod.timeout`, `mod.revokeBan`, `mod.removeTimeout`
  são `targetKey [, reason?/until]`; `member.leave` tem payload **vazio**; `identity.update` é
  `displayName?, avatarColor?`; `community.update` é `name?, …`; `community.end` é `reason?`.
  Nenhum carrega `communityId`.
- §6.4: a projeção de toda réplica **verifica a assinatura** e despacha para o reducer. §3.2:
  reducers "não podem rejeitar: o que chega aqui já passou pelo `validator`".
- ADR-01: só o host appenda — e ele appenda direto no core, sem passar pelo próprio pipeline de §9.1.

**4. Ataque.**
1. Ana é moderadora (`ban_members`) na comunidade **A** e membro comum na comunidade **B**.
2. Ana bane Bob em A. O envelope `E = {op: mod.ban{targetKey: Bob}, sig}` fica no log de A,
   legível por **todo membro de A** (§6.2: replicação integral).
3. Eve hospeda **B** e é membro de **A** (ou simplesmente conhece o `coreKey` de A — T-04).
   Eve copia `E` do log de A.
4. Eve appenda `E` no core de **B**. Não há pipeline: ela é a escritora do core.
5. Toda réplica de B projeta: assinatura **válida**, autor **Ana**, `kind = mod.ban`,
   `targetKey = Bob`. O reducer aplica. `moderation_log` de B registra
   `type: ban · by_key: Ana · target: Bob`.
6. Ana nunca baniu ninguém em B. Não existe evidência criptográfica que a distinga de quem baniu.

Variantes com o mesmo mecanismo: `member.leave` (payload vazio) transplantado remove alguém de
uma comunidade sem ato dela; `community.end` de um host que hospeda duas comunidades encerra a
segunda; `identity.update` insere um membro-fantasma se o reducer criar linha em `members`
(comportamento não especificado — DR-13).

**5. Vulnerabilidade / premissa explorada.** A spec exige domínio de separação em **hashes**
(§18.2: `'op/1'`, `'invite/1'`, `'invite-topic/1'`, `'invite-auth/1'`) e esquece de exigi-lo no
**escopo semântico da assinatura**. A premissa explorada é que "verificar a assinatura" equivale a
"verificar que este ato aconteceu aqui". Não equivale: verifica que o autor um dia assinou
*aquele conteúdo*, em contexto nenhum.

**6. Impacto.** Quebra de não-repúdio em ambos os sentidos: um membro é responsabilizado por atos
que não praticou, e um membro que praticou pode alegar transplante com razão. O log de auditoria —
a superfície que a spec vende como transparência (`spec:70`) — deixa de ser evidência. Contra um
host malicioso, isso converte "pode omitir e reordenar" em "pode fabricar quase qualquer estado
com atribuição alheia", que é exatamente o que §18.1 afirma ser impossível.

**7. Probabilidade.** Média. Exige um host que hospede duas comunidades com sobreposição de
membros — cenário normal, não excepcional (o limite do produto é 50 comunidades participadas por
instalação, §19.2). O ataque é copiar bytes e chamar `core.append`.

**8. Severidade.** CRITICAL — invalida a única propriedade de segurança que a arquitetura afirma
manter contra o host.

**9. Mitigação existente na spec.** Estágio 4 do pipeline (`op.author == chave do peer da conexão`,
§9.1) impede que um **terceiro** submeta a op de outra pessoa por RPC. Isso fecha o caminho
membro→host, e é bom.

**10. Resolve ou só reduz?** **Não resolve.** O estágio 4 protege a porta pela qual o adversário
mais perigoso (o host) não precisa passar: o host escreve direto no core. E as réplicas, que são a
última linha de §7, só verificam a assinatura.

**11. O que precisaria mudar (compatível com as premissas).** Incluir `communityId` (ou o
`coreKey`) no material assinado — é um campo no cabeçalho da `Op`, custo zero de arquitetura, e o
próprio §5.2 permite acrescentar campo dentro da mesma `v` se for no fim, ou bumpar `v` antes da
fase 2. Não introduz servidor, conta nem dependência. Sem isso, nenhuma outra mitigação funciona,
porque a assinatura permanece portátil.

**12. O que precisa ser validado.**
- Confirmar por leitura que nenhum `kind` de §5.3 carrega `communityId` no payload (verifiquei os
  29 do catálogo; nenhum carrega).
- Definir se o `nonce` de 8 bytes é gerado por comunidade (F-36 levanta a mesma pergunta por outro
  motivo); mesmo sendo, ele não vincula ao contexto, só evita colisão.
- Testar: appendar no core de B um envelope colhido do log de A e verificar se a projeção de B o
  aplica. Se aplicar, o achado está confirmado experimentalmente.

---

## T-02 — A réplica verifica assinatura e nada mais: permissão, hierarquia, associação e limites existem só no host

**Severidade:** CRITICAL · **Probabilidade:** Média · **STRIDE:** E · T · R

**1. Ativo afetado.** Todo o modelo de autorização (§8), o estado projetado de toda réplica, a
integridade da comunidade.

**2. Ator.** `A-HOST`.

**3. Pré-condições.**
- §7, camada "Réplica": *"Verificação de assinatura na projeção (§6.4)"* — a única checagem
  perpétua listada.
- §6.4, passo 3: *"decodifica o envelope → **verifica a assinatura** → decodifica a `Op` →
  despacha para o reducer"*. Nenhuma menção a revalidar permissão, hierarquia, membership,
  timeout, ban ou rate limit.
- §3.2, `reducers`: *"**Não pode** rejeitar: o que chega aqui já passou pelo `validator`"*.
- §3.1: `reducers` está em L1 e `permissions` também está em L1 — importação lateral só onde §3.2
  declarar, e ela não declara.
- §8.5: os três pontos de enforcement são firewall, **validador do host** e UI. A projeção não é um deles.

**4. Ataque.** Eve, host, quer que Carlos apareça como Fundador-equivalente sem que ninguém com
`manage_roles` tenha feito isso.
1. Eve pega qualquer `role.update` assinado por um moderador (ou um `member.setRoles` antigo).
2. Reordena / reaplica no `seq` que produz o efeito desejado (§12.1: "maior `seq` vence, campo a campo").
3. As réplicas aplicam. A regra anti-escalada de §8.3 (`E_PERMISSION_ESCALATION`) **não roda em
   lugar nenhum da projeção**.

Forma mais simples e mais grave do mesmo problema: Eve appenda uma op válida de um membro **depois
que esse membro perdeu a permissão** — a validação aconteceu num estado que já não existe, e nada
reavalia.

**5. Vulnerabilidade / premissa explorada.** A premissa de que "validar uma vez, no lugar certo,
basta" — verdadeira em sistema com autoridade confiável, falsa quando a autoridade **é o
adversário modelado**. A spec modela o host adversário em §18.1 e §21.5, mas o teste de §21.5 só
exercita **assinatura forjada**, que é o único ataque que a arquitetura de fato bloqueia.

**6. Impacto.** Toda decisão de autorização do produto é uma afirmação do host sobre si mesma.
Uma comunidade cujo host foi comprometido não tem estado recuperável nem auditável: as réplicas
convergem para o que o atacante escreveu, com assinaturas válidas.

**7. Probabilidade.** Média — depende do comprometimento do host, mas o resultado é total e
silencioso.

**8. Severidade.** CRITICAL.

**9. Mitigação existente na spec.** §7 declara três camadas de autenticação e justifica a terceira
exatamente com este argumento: *"sem a terceira camada, o host poderia inserir uma mensagem com
autoria alheia e nenhuma réplica notaria"*. A intenção está certa.

**10. Resolve ou só reduz?** **Reduz muito pouco.** Fecha a forja de autoria e deixa aberta a
fabricação de autorização. A frase de §7 descreve uma proteção mais forte do que o mecanismo
entrega.

**11. Observação de compatibilidade.** Revalidar permissão na projeção é caro e colide com §3.2
(reducer puro, sem consultar permissão) e com o alvo de 8–15 k registros/s de §6.4. Uma versão
mínima e barata **existe** e não quebra premissa nenhuma: revalidar na projeção apenas as
invariantes que não dependem de estado caro — autor é membro ativo no `seq` corrente, alvo não é
o Fundador, `kind` compatível com o estado da comunidade (`ended`) — e registrar divergência numa
métrica de segurança (`projector.unauthorizedOp`) em vez de abortar. Isso transforma um host
malicioso silencioso num host malicioso **detectável**, que é o máximo que a arquitetura permite
sem multi-writer (descartado em ADR-01 por motivo válido).

**12. O que precisa ser validado.**
- Definir normativamente o que a projeção reverifica. Hoje a resposta é "só assinatura", e ela está
  em três lugares (§6.4, §7, §3.2) de forma consistente — portanto é decisão, não lapso.
- Medir o custo de revalidação parcial contra o alvo de §19.1 antes de decidir.
- Estender §21.5 com um host adversário que **reordena e reaplica ops válidas**, não só um que
  forja assinatura.

---

## T-03 — A chave de escrita do core não tem a proteção que a ADR-19 dá à identidade

**Severidade:** CRITICAL · **Probabilidade:** Média · **STRIDE:** T · E · S

**1. Ativo afetado.** A capacidade de escrever no log de toda comunidade hospedada — isto é, a
comunidade inteira.

**2. Ator.** `A-FS`, `A-LOCAL`.

**3. Pré-condições.**
- §11.1: `corestore.namespace(random)` cria os cores; a chave do core **não** é derivada da
  identidade Ed25519 do usuário. São dois segredos distintos.
- §6.1: `identity.enc` é *"chave privada cifrada por safeStorage"*; `cores/` é
  *"corestore (RocksDB) — todos os Hypercores"*, sem qualificação de cifra.
- ADR-19 e §22.2 tratam exclusivamente da chave de identidade.
- §18.1: o adversário "processo local do mesmo usuário" **consegue** "ler o SQLite e o corestore",
  e **não consegue** "ler a chave privada". A chave de escrita do core não aparece na tabela.

**4. Ataque.**
1. `A-FS` copia `p2p/cores/` da máquina do host (backup na nuvem, pendrive, malware comum,
   suporte técnico, notebook roubado com disco sem FDE).
2. Abre o corestore fora do app. A chave secreta do core está lá, sem `safeStorage`.
3. A partir daí o atacante pode **appendar registros no log da comunidade** e servi-los no swarm.
   Ele não consegue forjar assinatura de membro — mas, por T-01 e T-02, não precisa: replay,
   transplante e reordenação bastam para produzir quase todo estado.
4. Pode também truncar e reescrever a história. §5.1 admite que isso é "detectável, não
   impedível" — mas o modelo de ameaça atribui esse poder ao *host*, não a quem copiou uma pasta.

**5. Vulnerabilidade / premissa explorada.** A ADR-19 protege o segredo que identifica a pessoa e
deixa em claro o segredo que **autoriza a escrita da comunidade**, que é o ativo de maior valor
num sistema com autoridade única de escrita (ADR-01).

**6. Impacto.** Tomada de controle da comunidade a partir de acesso de leitura ao disco, sem
comprometer o processo em execução e sem interagir com `safeStorage`. E como `hostKey` é imutável
(§4.2, premissa 3) e não há sucessão nem revogação, a comunidade não tem caminho de recuperação:
duas cópias do mesmo core escrevendo produzem fork, que §5.1 declara detectável e não impedível.

**7. Probabilidade.** Média. Exige acesso ao filesystem — que a spec já modela como adversário
real em §18.1 — e nada além disso.

**8. Severidade.** CRITICAL.

**9. Mitigação existente na spec.** Nenhuma. A ADR-20 (lock de diretório) impede duas instâncias
*do app*; não impede leitura de arquivo nem uso do core fora do app.

**10. Resolve ou só reduz?** Não existe mitigação a avaliar.

**11. Compatibilidade.** Estender `safeStorage` à chave de escrita do core é a mesma decisão já
tomada na ADR-19, aplicada ao ativo certo — não introduz senha, conta nem servidor. Alternativa
compatível: derivar a chave do core deterministicamente da identidade (o que também resolveria a
recuperação do `blobsKey` de F-01), de modo que só exista **um** segredo a proteger. As duas são
compatíveis com as premissas; a segunda é mais barata e resolve dois problemas.

**12. O que precisa ser validado.**
- Confirmar na versão travada do `corestore` **como** as chaves de escrita são persistidas e se há
  opção de custódia externa. Isto é uma pergunta de API, não de spec, e precisa entrar no spike da
  fase 0 (DR-01 já pede critério de aceite para o spike; este é um critério).
- Decidir e escrever se `cores/` é considerado segredo. Hoje o documento não diz nem que é nem que
  não é, e §18.1 sugere implicitamente que não é.

---

## T-04 — O `coreKey` é ao mesmo tempo identificador, tópico de descoberta e capacidade de leitura perpétua — e vaza por uma funcionalidade de UI

**Severidade:** CRITICAL · **Probabilidade:** Alta · **STRIDE:** I

**1. Ativo afetado.** Confidencialidade de todo o histórico da comunidade: mensagens, membros,
moderação, convites (hashes), estrutura.

**2. Ator.** `A-BANIDO`, `A-PEER`, `A-META`, e qualquer pessoa que receba um link.

**3. Pré-condições.**
- §4.2: `id` da comunidade = hex64 da chave pública do core. `coreKey` **é** o id.
- §6.2 e §11.1: `swarm.join(coreKey)` — o **tópico anunciado no DHT é a própria chave**, não um
  `discoveryKey` derivado.
- §6.2: o core de log é *"replicado por todos os membros, integral"*.
- §8.5: o `firewall` existe **no host**. DR-30 já registrou que membros replicam entre si e o
  banido continua lendo.
- Nenhuma menção, em documento nenhum, a cifra de blocos do Hypercore (`encryptionKey`) ou a
  qualquer rotação de chave de comunidade.
- `frontend.md` §4, rota `/m/:code`: o token *"identifica comunidade + canal + mensagem num token
  só"*, e o cliente resolve a comunidade a partir dele (é o que permite a mensagem
  *"Este link é de uma comunidade da qual você não faz parte"*).

**4. Ataque.** Três caminhos, o terceiro é o interessante:
1. **Ex-membro.** Ana sai (ou é banida) de uma comunidade. Ela mantém `coreKey` e `blobsKey`. Roda
   um cliente que continua no swarm dos dois tópicos. O firewall do host recusa a conexão **com o
   host**; os outros 339 membros não têm firewall. Ana continua replicando o log **em tempo real**,
   para sempre, incluindo as discussões de moderação sobre ela.
2. **Peer não autenticado.** Quem obtiver o `coreKey` por qualquer via (screenshot, log, backup,
   um membro descuidado) obtém o histórico completo sem nunca ter sido membro, sem convite e sem
   deixar rastro no log.
3. **"Copiar link da mensagem" (`spec` 2.1, rota `/m/:code`).** Uma funcionalidade de conveniência
   embute o id da comunidade — isto é, a capacidade de leitura — num token compartilhável. O
   objetivo declarado do token é *"não vazar ids legíveis pra quem não é membro"*; ele ofusca a
   apresentação e **não** reduz a capacidade. Um membro que cola um link de mensagem num grupo
   externo entrega o arquivo inteiro da comunidade a todo mundo naquele grupo.

**5. Vulnerabilidade / premissa explorada.** Colapso de três papéis num só segredo. Em Hypercore a
separação `key` (capacidade) / `discoveryKey` (endereço) existe justamente para que descobrir não
implique poder ler; a spec anuncia na chave. E o modelo de "membro" é, na prática, "quem conhece
32 bytes", sem revogação possível — porque revogar exigiria rechavear a comunidade, que a
arquitetura não prevê.

**6. Impacto.** Banir e expulsar **não removem acesso à informação**, apenas ao direito de
escrever. §18.1 afirma o contrário: na linha "Ex-membro banido", a coluna "Não consegue" diz
*"ler dado novo"*. Isso é falso como especificado. Para um produto cujo valor é conversa privada
entre pessoas que se conhecem, é a falha de confidencialidade mais grave possível — e é
permanente, porque não há rotação.

**7. Probabilidade.** Alta. Não exige habilidade: exige um ex-membro com um cliente modificado, ou
um link colado no lugar errado.

**8. Severidade.** CRITICAL.

**9. Mitigação existente na spec.** O firewall do swarm no host (§8.5), o preview `banned` de
convite (§4.11) e a premissa 2 (sem descoberta pública).

**10. Resolve ou só reduz?** **Não resolve nada da confidencialidade.** O firewall é uma otimização
de custo do host ("nem chega a estabelecer stream", §8.5) e a própria spec o descreve assim. A
premissa 2 impede que a comunidade seja *encontrada*, não que seja *lida* por quem já tem a chave.

**11. Compatibilidade.** Rechavear comunidade contradiz ADR-01/ADR-10 e não é proponível aqui. O
que **é** compatível e falta:
(a) anunciar no `discoveryKey`, não no `coreKey` — separa endereço de capacidade sem mudar nada
   mais;
(b) tratar o token de `/m/:code` como **vazamento de capability** no texto da UI, e considerar
   restringi-lo a membros (o token pode carregar um id local resolvido só por quem já tem a
   comunidade, e para não-membros mostrar erro genérico — a spec já quer erro genérico);
(c) §25 ganhar um item obrigatório: *sair e ser banido não retiram o acesso de leitura ao histórico
   já replicado nem ao que for appendado depois*. Este é o item de honestidade (princípio 3) mais
   importante que falta.

**12. O que precisa ser validado.**
- Confirmar na versão travada se `swarm.join` recebe a chave ou o `discoveryKey`, e corrigir §6.2 e
  §11.1 em qualquer caso — hoje o texto diz `coreKey`.
- Confirmar se a versão travada do Hypercore expõe cifra de blocos e se ela é utilizável sem
  multi-writer. Mesmo com ela, a chave seria compartilhada com todos os membros e o problema de
  revogação permanece — mas o vazamento por link deixaria de ser total.
- Especificar o formato do token de `/m/:code`. Hoje ele não existe em §10.2 nem em §10.4 (nenhum
  comando o produz ou resolve), então a decisão ainda está aberta.

---

## T-05 — Replay do próprio envelope depois da janela de dedupe produz colisão determinística de chave primária e para a projeção de todas as réplicas, para sempre

**Severidade:** CRITICAL · **Probabilidade:** Alta · **STRIDE:** D

**1. Ativo afetado.** Disponibilidade da comunidade inteira, em **todos** os dispositivos
simultaneamente, incluindo o do host.

**2. Ator.** `A-MEMBRO` com cliente adulterado (`A-REPLAY`). Não precisa de permissão nenhuma além
de `send_messages`.

**3. Pré-condições.** Todas verificáveis no texto:
- ADR-12 / §12.2: dedupe por `opId`, **janela de 7 dias**, podada pelo job `dedupe.prune` (§13.2).
- §5.5, última linha: *"E depois de 7 dias? **O reenvio duplicaria.**"* — a spec conhece o fato e o
  classifica como benigno porque *"a outbox só retenta enquanto o item existe"*. Isso descreve o
  cliente honesto.
- §9.1 estágio 6: `op.ts` precisa estar em `[hostTs − 7d, hostTs + 1d]`. Um `op.ts` **um dia no
  futuro** é aceito (marca `clockSkewed`, §4.7, e é explicitamente aceito, não rejeitado).
- §4.7: `Message.id` = `msg-` + hex do `opId` truncado em 12. **Determinístico.**
- §6.3: `messages.id TEXT PK`. Também: `threads.root_message_id UNIQUE`, `invites.code_hash PK`,
  `roles.id TEXT PK`.
- §6.4: *"**Reducer que lança:** aborta a transação do lote inteiro … o projetor **para** aquela
  comunidade em estado `degraded`"*, e reprojetar é o remédio especificado — que reencontra o mesmo
  par de registros.

**4. Ataque.**
1. Mallory envia uma mensagem com `op.ts = agora + 24 h − ε` (aceito pelo estágio 6; a UI dela
   mostra aviso de relógio, e ela não se importa). Guarda o envelope `E`.
2. Espera **7 dias e uma hora**. O job `dedupe.prune` remove a entrada de `E` do `local_dedupe` do
   host.
3. Reenvia `E`, byte a byte. Estágio 5 passa (não há mais dedupe). Estágio 6 passa: `op.ts` ainda
   está dentro de `[hostTs − 7d, hostTs + 1d]`, **porque ela o pôs um dia à frente**. Estágios 7–12
   passam: é a mesma op válida de antes.
4. O host appenda um **segundo registro com o mesmo `opId`**.
5. Toda réplica projeta. O reducer de `message.send` faz `INSERT` com `id = msg-<mesmos 12 hex>`.
   Violação de PK. O reducer lança.
6. §6.4: o projetor **para**. A comunidade fica `degraded` em **todos** os dispositivos, incluindo
   o do host, que projeta pelo mesmo caminho (§11.1 passo 6: *"o host **não** tem atalho"*).
7. Reprojetar do zero (§6.4) reencontra os dois registros e falha no mesmo ponto. O log é
   append-only (ADR-10): os dois registros não saem. **A comunidade está morta para leitura, em
   todo lugar, permanentemente.**

Custo do ataque: uma mensagem, uma espera, um reenvio. Sem permissão especial, sem hierarquia, sem
recurso computacional.

**5. Vulnerabilidade / premissa explorada.** Três decisões corretas isoladamente que se destroem
juntas: (a) id determinístico derivado do `opId` (bom para reprojeção determinística, §21.4);
(b) dedupe com TTL (bom para não crescer sem limite); (c) fail-stop no reducer (bom para não
divergir entre réplicas). A composição transforma o dedupe — descrito como conveniência de
idempotência — em **controle de segurança crítico com expiração documentada**. F-04 (parada
permanente por exceção de reducer) e F-05 (colisão de id) descrevem os componentes; aqui eles são
**acionados de propósito, de graça, por qualquer membro**.

**6. Impacto.** Negação de serviço remota, permanente, irreversível e simultânea em todas as
réplicas, disparada por um participante autorizado, sem caminho de recuperação especificado. É a
pior combinação possível: máximo alcance, mínimo custo, zero reversão.

**7. Probabilidade.** Alta. Um único participante insatisfeito com um cliente modificado. E o
mesmo estado é alcançável **por acidente** (F-05, colisão de aniversário em 48 bits), o que
significa que o modo de falha vai aparecer sozinho antes de aparecer por malícia.

**8. Severidade.** CRITICAL.

**9. Mitigação existente na spec.** ADR-12 (dedupe), §5.5 (a janela de 7 dias é 2,3× a idade
máxima da outbox), §9.1 estágio 6 (faixa de relógio).

**10. Resolve ou só reduz?** **Reduz apenas contra o cliente honesto.** A folga de 2,3× é
calculada contra o comportamento da própria outbox, não contra um adversário — e o adversário
não usa a outbox. O estágio 6, que poderia ter fechado a janela, é anulado por um `op.ts`
adiantado, que a mesma spec manda **aceitar**.

**11. Compatibilidade.** Nada aqui exige quebrar premissa:
(a) dedupe **permanente** por comunidade (é uma linha de 32 bytes por op; um core de 200 k ops
   custa 6,4 MB — barato comparado com o próprio log);
(b) ou, melhor, **id de entidade que não colide por construção** (`seq` do append é único por
   definição e já é a ordem canônica de §5.5) — mas isso conflita com a reprojeção determinística
   só se o `seq` mudar, e ele não muda (append-only);
(c) e, independentemente das duas, **o reducer não pode ser fail-stop contra dado hostil**: hoje a
   spec distingue "assinatura ruim = dado hostil esperado, ignora" de "reducer que lança = bug
   nosso, para" — a classificação está errada, porque dado hostil **chega ao reducer**.

**12. O que precisa ser validado.**
- Reproduzir: enviar op com `ts` adiantado, avançar o relógio do host em 7 dias, reenviar o mesmo
  envelope, observar a projeção. É um teste de meia hora no harness de §21.2.
- Verificar se `P2P_DEDUPE_TTL_MS` pode ser rebaixado a 24 h (§20 diz `≥ 24 h`): com 24 h a janela
  de ataque passa de "um dia à frente" para "seis dias de folga", tornando o ataque ainda mais
  fácil.
- Enumerar **todos** os reducers que fazem `INSERT` em coluna `PK`/`UNIQUE` a partir de dado
  controlado pelo autor. Encontrei quatro (`messages`, `threads`, `invites`, `roles`); a lista
  precisa ser exaustiva e cada um precisa de comportamento definido para "já existe".

---

## T-06 — A prova de convite não é vinculada nem ao host nem ao candidato: quem estiver no tópico rouba o convite por retransmissão

**Severidade:** CRITICAL · **Probabilidade:** Média · **STRIDE:** S · E

**1. Ativo afetado.** O convite — a única capacidade de entrada do produto (premissa 2) — e o
controle de quem entra na comunidade.

**2. Ator.** `A-MEMBRO` ou `A-PEER` posicionado no tópico do convite; `A-SYBIL` para escala.

**3. Pré-condições.**
- §11.4, Anunciar: o tópico é `BLAKE2b('invite-topic/1' ‖ codeHash)`, e `codeHash` **está no log**
  (§4.11) — portanto **todo membro da comunidade conhece o tópico de todos os convites ativos**, e
  pode anunciar-se nele.
- §11.4, Resolver, passo 1: *"O candidato deriva `codeHash` do código digitado, calcula o tópico e
  **conecta**"*. Não há verificação de que o outro lado é o host: o texto não exige comparar
  `remotePublicKey` com `hostKey` — e o candidato **não conhece** `hostKey` antes de resgatar (o
  `coreKey` só chega no retorno de `inviteRedeem`, §11.4 passo 3 — é o mesmo buraco de transporte
  que F-09 levanta).
- §11.4, passos 2–4: `challenge` (16 bytes aleatórios) → `proof = BLAKE2b('invite-auth/1' ‖ secret
  ‖ challenge)`. A prova depende de **segredo e desafio**, e de **mais nada**: não da chave do
  candidato, não da chave do host, não da comunidade.
- §10.6: `inviteRedeem{challenge, proof, displayName, avatarColor}` — quem apresenta a prova é
  quem entra.

**4. Ataque (retransmissão clássica de desafio-resposta).**
1. Mallory, membro comum, lê `codeHash` do log e anuncia-se no tópico `BLAKE2b('invite-topic/1' ‖
   codeHash)`, exatamente como o host faz.
2. Carlos recebe o código por fora, deriva o tópico e conecta — **em Mallory**, ou em ambos.
3. Mallory abre uma conexão paralela com o host **real** e pede `inviteResolve`. O host envia o
   desafio `C`.
4. Mallory repassa `C` a Carlos como se fosse seu próprio desafio.
5. Carlos, que **tem** o segredo, responde `proof = BLAKE2b('invite-auth/1' ‖ secret ‖ C)`.
6. Mallory apresenta essa prova ao host real, em `inviteRedeem`, com **o próprio nome e a própria
   chave**. O host valida: a prova bate.
7. Mallory entra. O uso é consumido (`maxUses`). Carlos recebe `E_INVITE_EXHAUSTED` ou
   `E_INVITE_INVALID` — e, por `spec:444`, a UI não diferencia: Carlos conclui que o convite era
   ruim.

Variantes: a mesma posição permite colher `memberCount`, nome e "quem convidou" (o preview `ok`)
sem ter o segredo, bastando repassar o desafio a qualquer candidato legítimo.

**5. Vulnerabilidade / premissa explorada.** A prova autentica **o conhecimento do segredo**, não
**a identidade de quem o conhece**, e o canal não autentica o servidor. A spec projetou a defesa
contra força bruta (§11.4 passo 4: fecha a conexão a cada erro; §19.3: rate limit de
`inviteResolve`) e não contra intermediação — que é mais barata que a força bruta e não é afetada
por nenhum dos dois controles.

**6. Impacto.** Qualquer membro (inclusive um que esteja prestes a ser expulso) intercepta convites
emitidos por outros e entra em nome próprio, esgota convites de terceiros, e nega entrada a
convidados legítimos com uma mensagem de erro que culpa o convite. Com `A-SYBIL`, consome todos os
usos de todos os convites ativos da comunidade — 50 convites (§19.2) × `maxUses`.

**7. Probabilidade.** Média-alta dentro de uma comunidade com membros hostis; a posição exigida é
"estar no tópico", que é público para todo membro por construção.

**8. Severidade.** CRITICAL — compromete o único mecanismo de controle de entrada.

**9. Mitigação existente na spec.** Fechamento de conexão por prova errada, rate limit de
`inviteResolve` por peer (§19.3), 80 bits de segredo (ADR-09), tópico derivado do hash e não do
segredo.

**10. Resolve ou só reduz?** As mitigações são todas **contra adivinhação** e todas corretas para
esse fim. Nenhuma toca a retransmissão. Contra este ataque, o efeito é zero.

**11. Compatibilidade.** A correção é local e não toca premissa nenhuma: ligar a prova ao contexto,
como §18.2 já manda fazer com hashes —
`proof = BLAKE2b('invite-auth/1' ‖ secret ‖ challenge ‖ hostKey ‖ candidatePublicKey)`,
com `candidatePublicKey` = a chave do peer da conexão (o host já a tem pelo handshake Noise; é o
mesmo dado do estágio 4 de §9.1). Isso torna a prova inútil em qualquer conexão que não seja a do
candidato original. Depende de o candidato conhecer `hostKey` antes do resgate — o que F-09 já
mostra ser um problema de transporte a resolver de qualquer jeito.

**12. O que precisa ser validado.**
- Confirmar que o candidato não tem como autenticar o host antes do resgate. Verifiquei §10.5,
  §10.6 e §11.4: o `coreKey` (e portanto `hostKey`, que é `op.author` do `seq` 0) chega **depois**.
- Resolver F-02 antes: se o host não consegue verificar provas de convites que não criou, a
  correção adotada muda o desenho inteiro deste fluxo — e se a saída for "o candidato manda o
  segredo em claro", o ataque acima passa a **entregar o segredo a Mallory**, o que é
  estritamente pior.
- Teste adversarial novo em §21.5: um peer que anuncia o mesmo tópico do host e retransmite o
  desafio.

---

## T-07 — Identidade é gratuita, `inviteRedeem` não tem rate limit, e não há nenhum custo de entrada: Sybil, raide e evasão de ban são industrializáveis

**Severidade:** CRITICAL · **Probabilidade:** Alta · **STRIDE:** S · D

**1. Ativo afetado.** Roster da comunidade, log (crescimento permanente), atenção dos moderadores,
teto de conexões do host, `memberCount`.

**2. Ator.** `A-SYBIL`, `A-BANIDO`, `A-DOS`.

**3. Pré-condições.**
- §4.1: identidade = par Ed25519 gerado localmente. Custo: microssegundos. Sem prova de trabalho,
  sem custo, sem verificação.
- §4.3: *"Um membro banido que reentra com **identidade nova** é indistinguível de um membro novo.
  … o backend **não tenta** heurística de detecção."* — decisão de produto, aceita aqui.
- §19.3: a tabela de rate limit é *"no host, **por autor**, por comunidade"*. **`inviteRedeem` não
  aparece nela.** Só `inviteResolve` aparece, e é "por IP de peer" — chave que DR-31 já mostrou não
  estar disponível.
- §4.11: `maxUses` é **opcional** (ausente = ilimitado) e `expiresAt` é **opcional** (ausente =
  nunca expira).
- `spec:1153` corta aprovação manual; §11.4: *"a mitigação de link vazado é revogar"*.
- §5.3: cada entrada appenda `member.join` — permanente (ADR-10).

**4. Ataque.**
1. Mallory é banida, ou obtém um link vazado, ou compra um.
2. Gera 5.000 pares de chaves. Para cada um, executa `inviteRedeem` com a mesma prova.
3. Nada limita a taxa: `inviteRedeem` não está na tabela de §19.3, e mesmo os limites que existem
   são **por autor** — cada identidade nova é um autor novo com o balde cheio.
4. 5.000 `member.join` entram no log. Permanentemente, em todas as 340 réplicas (§6.2, replicação
   integral).
5. Cada identidade nova é um membro válido: pode enviar mensagens no seu próprio balde de
   `10 / 10 s`, reagir a `30 / 10 s`, ocupar conexão no swarm.
6. O moderador responde banindo. Cada ban é outra op permanente, e a `A-BANIDO` volta com chave
   nova em milissegundos. O custo é assimétrico em várias ordens de grandeza.
7. Revogar o convite é a única saída — mas se o convite era o principal da comunidade, revogá-lo
   fecha a porta para todo mundo, e emitir outro só reinicia o ciclo.

**5. Vulnerabilidade / premissa explorada.** A ausência total de **custo de admissão**. O produto
aceita conscientemente a evasão de ban (§4.3), mas a decisão foi tomada para o caso "uma pessoa
volta com outra identidade". A mesma ausência de custo, sem limite de taxa no resgate, produz um
caso qualitativamente diferente: entrada em massa automatizada.

**6. Impacto.** Uma comunidade pode ser inundada até a inutilidade por um único adversário com um
convite vazado, e o dano ao log é **permanente e replicado** (T-09). O teto de 128 conexões do
processo (§19.2) e o fan-out efêmero (F-13) caem muito antes do roster.

**7. Probabilidade.** Alta. É o padrão de abuso mais comum em produtos de comunidade, e aqui o
custo é o mais baixo possível.

**8. Severidade.** CRITICAL.

**9. Mitigação existente na spec.** `maxUses` e `expiresAt` opcionais; `invite.revoke`;
`INVITE_MAX_ACTIVE = 50`; rate limit de `invite.create` (5/h); firewall de banidos.

**10. Resolve ou só reduz?** Reduz **se e somente se** o emissor usar `maxUses`. Como ambos os
campos são opcionais e a UI não é obrigada a exigi-los, o caso default ("convite permanente,
ilimitado") é o pior caso. O firewall não ajuda: cada Sybil é uma chave nova. A revogação é reativa
e coletivamente punitiva.

**11. Compatibilidade.** Sem contradizer premissa nenhuma:
(a) `inviteRedeem` entra em §19.3 com limite **por convite** e **por comunidade** (não por autor —
   por autor é inútil aqui, e essa é a lição);
(b) `maxUses` e `expiresAt` deixam de ser opcionais, ou ganham default finito (a spec já escolhe
   defaults para tudo em §20);
(c) um botão de **suspender convites da comunidade** ("lockdown") — que não é aprovação manual,
   logo não contradiz `spec:1153`, e dá ao moderador a única alavanca que hoje não existe: parar a
   hemorragia sem revogar caso a caso.

**12. O que precisa ser validado.**
- Confirmar que `inviteRedeem` está mesmo fora de §19.3 (verifiquei: a tabela lista `invite.create`
  e `inviteResolve`; `inviteRedeem`/`member.join` não aparecem).
- Definir a chave do limite. "Por IP" não existe (DR-31); "por autor" é ineficaz; a chave viável é
  `(codeHash)` e `(communityId)`.
- Medir o custo por join no host (append + serialização de §12.3 + fan-out de roster) para saber a
  que taxa a comunidade cai.

---

## T-08 — O caro roda antes do barato e o orçamento de conexões é global: negação de serviço por peer não autenticado

**Severidade:** CRITICAL · **Probabilidade:** Alta · **STRIDE:** D

**1. Ativo afetado.** Disponibilidade do host — e, por ADR-01, de toda escrita de **todas** as
comunidades que ele hospeda; e, pelo teto compartilhado, das 50 comunidades participadas.

**2. Ator.** `A-PEER`, `A-SYBIL`, `A-DOS`.

**3. Pré-condições.**
- §9.1, ordem fixa: 1 tamanho · 2 decode · **3 assinatura Ed25519** · 4 autoria · 5 dedupe ·
  6 relógio · **7 membro/banido** · 8 timeout · **9 rate limit** · 10 permissão …
  O custo dominante (§19.5: *"Verificação Ed25519 é o custo dominante"*, ~50 µs) roda **antes** de
  saber se o remetente é membro (7) e **antes** do rate limit (9). DS-09 já registrou a ordenação;
  aqui o ponto é quem pode acioná-la.
- §8.5: o firewall só recusa **banidos**. Um peer com chave nova não é banido.
- §6.2/§11.1: o host anuncia `coreKey` no DHT público como servidor. Qualquer um que conheça o
  `coreKey` (T-04) conecta.
- §19.2: `Conexões simultâneas no swarm` = **128**, e §3.2 diz *"**Um** `Hyperswarm` para o
  processo"* — o teto é do processo, compartilhado por até 50 comunidades.
- §10.5: 8 requests em voo por peer; `submitOps` aceita lote de até 32 envelopes.
- §12.3: fila de **uma via por comunidade**, processamento estritamente sequencial.
- §13.5: o núcleo é single-threaded e **RPC de entrada tem prioridade 1**, acima da projeção.

**4. Ataque.**
1. Mallory gera 128 pares de chaves e conecta 128 vezes ao tópico do host.
2. Só isso já satura o teto de §19.2: *"Novas ficam na fila do Hyperswarm"* — nenhum membro
   legítimo conecta, em **nenhuma** das comunidades do processo. Custo: 128 conexões DHT.
3. Se quiser também queimar CPU: cada conexão envia `submitOps` com 32 envelopes de 32 KiB com
   assinaturas inválidas mas bem-formadas. O host paga decode + Ed25519 em cada um — 32 × 50 µs =
   1,6 ms por request, 8 em voo, 128 conexões. O event loop single-threaded satura, e como RPC tem
   prioridade sobre projeção (§13.5), a projeção para de avançar e o `projector.lag` cresce.
4. Nenhum estágio anterior ao 3 tem custo suficiente para filtrar, e nenhum estágio posterior é
   alcançado.

**5. Vulnerabilidade / premissa explorada.** A ordem do pipeline foi desenhada para **correção**
(não aceitar op sem verificar assinatura), não para **custo** (não gastar antes de saber se vale a
pena). E o teto de conexões foi dimensionado para capacidade, não como recurso disputado por um
adversário.

**6. Impacto.** Negação de serviço total de escrita, barata, remota e repetível, contra um alvo que
não tem plano B: com o host fora, §11.5 manda enfileirar mensagens e **falhar na hora** todas as
ops de estrutura e moderação — ou seja, o ataque também **impede a resposta ao ataque** (não dá
para banir ninguém com o host saturado).

**7. Probabilidade.** Alta. O recurso exigido é irrisório.

**8. Severidade.** CRITICAL.

**9. Mitigação existente na spec.** Estágio 1 (tamanho antes do decode) — correto e útil; firewall
para banidos; rate limit no estágio 9; `E_BUSY` acima de 8 requests em voo; `P2P_MAX_CONNECTIONS`
configurável de 8 a 512.

**10. Resolve ou só reduz?** O estágio 1 evita o pior (decodificar 8 GB). Tudo o mais atua **depois**
do custo dominante, ou contra o adversário errado (banido, não desconhecido). O `E_BUSY` limita
concorrência **por peer** — e o adversário tem 128 peers.

**11. Compatibilidade.** Nada disto exige servidor:
(a) mover uma checagem barata de **membership** para antes da verificação de assinatura — o host
   conhece a chave do peer pelo handshake Noise **antes de receber qualquer byte de aplicação**, e
   pode recusar não-membros no `firewall`, exatamente como já faz com banidos (o firewall vira
   allowlist de membros em vez de blocklist de banidos, com uma exceção para o tópico de convite,
   que é outro tópico);
(b) reserva de conexões por comunidade, ou teto por comunidade além do teto do processo;
(c) rate limit por **chave do peer antes do estágio 3**, com balde separado para não-membros.

**12. O que precisa ser validado.**
- Confirmar que o `firewall` do Hyperswarm recebe a chave remota **antes** do estabelecimento do
  stream (a spec afirma isso em §8.5: *"nem chega a estabelecer stream"*) — se sim, a mitigação (a)
  é praticamente de graça.
- Medir a saturação real: quantas conexões/segundo de peers desconhecidos derrubam o p95 de
  `submitOp` abaixo do alvo de §19.1. Isto pertence à fase 3, junto com A-2.
- Resolver a interação com F-14 (teto menor que a comunidade de referência) — os dois achados
  atacam o mesmo número por razões diferentes.

---

## T-09 — Nenhuma cota por autor sobre dado permanente e replicado integralmente: exaustão de disco de toda a comunidade

**Severidade:** CRITICAL · **Probabilidade:** Alta · **STRIDE:** D

**1. Ativo afetado.** Disco de todos os membros e do host; `view.db`; índice FTS5; core de blobs.

**2. Ator.** `A-MEMBRO`, `A-SYBIL`.

**3. Pré-condições.**
- §6.2: o log é *"replicado por todos os membros, **integral**"*. ADR-16: **todas** as comunidades
  participadas replicam em background.
- ADR-10: nada é removido do log. §13.6: *"O core de blobs é append-only e **não encolhe**"*.
- §9.2: `Message.content` até 16.384 bytes UTF-8. §19.3: `message.send` a 10 / 10 s (burst 20).
- §19.2: `ATTACHMENT_MAX_BYTES` default **8 GiB**, 1 anexo por mensagem, sem cota por autor em
  lugar nenhum.
- §13.6: o GC de blobs age *"só no cache local"* e preserva *"os que a identidade local enviou"*.
- §6.3: `content` também entra no `messages_fts`.
- §14.4/§11.13: o `hash` do anexo é verificado **no destino**; F-41 já registrou que o host não
  consegue verificá-lo.

**4. Ataque.** Dois vetores, o segundo é pior:
1. **Texto.** 16 KiB × 10 msgs / 10 s = ~13,8 GB/dia de dado **permanente**, empurrados para as
   340 réplicas. Um mês de um único atacante = ~414 GB em cada um dos 340 dispositivos. Banir
   interrompe o fluxo futuro; **não devolve um byte** (ADR-10; o ban só oculta na projeção, §4.12).
2. **Anexos.** Mallory publica anexos de 8 GiB. Quem escreve os blocos no core de blobs é — segundo
   §6.2 — quem anexa, "via host" (o caminho é contraditório e F-03 já o derrubou); qualquer que
   seja a resolução, **alguém paga 8 GiB por mensagem sem cota**. Se o host escreve, uma dúzia de
   mensagens enche o disco dele (`E_STORAGE_FULL`) e a comunidade inteira para. Somando F-41:
   Mallory pode publicar anexos cujo `hash` **não corresponde** aos bytes — cada destinatário baixa
   8 GiB, verifica, descarta (`attachment.corrupt`) e não guarda nada, o que transforma o ataque em
   desperdício de banda amplificado 1→N, repetível, e **sem nenhum estado que o detecte
   automaticamente**.

**5. Vulnerabilidade / premissa explorada.** O rate limit de §19.3 limita **taxa de operações**, não
**volume de dado**, e o modelo de replicação transforma o custo do atacante em custo de todos os
outros. É o inverso da assimetria desejada.

**6. Impacto.** Um participante autorizado força consumo permanente e irreversível de armazenamento
em todos os dispositivos da comunidade. Não há retenção, não há poda, não há cota, não há caminho
de recuperação — a única saída seria abandonar a comunidade e perder o histórico.

**7. Probabilidade.** Alta, e boa parte do dano ocorre **sem malícia**: uma comunidade ativa com
anexos grandes chega ao mesmo lugar mais devagar.

**8. Severidade.** CRITICAL.

**9. Mitigação existente na spec.** Rate limit de §19.3; `ATTACHMENT_MAX_BYTES` e
`BLOB_CACHE_MAX_BYTES` configuráveis; sparse por default (§14.2) — que é o que salva os membros de
baixar tudo; GC de §13.6; verificação de hash no destino.

**10. Resolve ou só reduz?** O sparse **reduz muito** o vetor de anexos para os membros (ninguém
baixa o que não abriu) e é a decisão certa. Não protege o **escritor** do core de blobs, não
protege ninguém do vetor de texto (o log replica integral, sem escolha), e o GC explicitamente
**não** apaga o que a identidade local enviou.

**11. Compatibilidade.** Cota por autor por janela (bytes, não ops) no estágio 12 da validação, e
um teto de tamanho de core por comunidade com estado nomeado quando estourar. Nenhuma das duas
contradiz premissa. Poda de histórico contradiz ADR-10 e **não** está sendo proposta.

**12. O que precisa ser validado.**
- Resolver F-03 primeiro: sem saber quem escreve o blob, não dá para saber de quem é o disco.
- Medir o custo real de `messages_fts` sobre conteúdo adversarial (tokens longos, sem espaço,
  Unicode denso) — o índice pode crescer mais que o dado.
- Definir o comportamento quando `E_STORAGE_FULL` acontece no host **durante** o append: §11.1 só
  o define para a criação da comunidade.

---

## T-10 — `safeStorage` não protege contra o adversário que §18.1 diz que ele protege, e não existe revogação de identidade

**Severidade:** CRITICAL · **Probabilidade:** Média · **STRIDE:** S · E

**1. Ativo afetado.** A chave privada Ed25519 — a única credencial do produto (§4.1) — e, por
consequência, toda a identidade da pessoa em todas as comunidades, para sempre.

**2. Ator.** `A-LOCAL`, `A-FS`.

**3. Pré-condições.**
- ADR-19 / §22.2: a chave é cifrada com `safeStorage` (Keychain / **DPAPI** / **libsecret**).
- §18.1, última linha da tabela: adversário *"Processo local do mesmo usuário"* — **consegue** ler o
  SQLite e o corestore, **não consegue** ler a chave privada. Mitigação declarada: `safeStorage`.
- §7: *"Não existe sessão, não existe token, não existe expiração de credencial. … revogar
  identidade é apagar a chave e criar outra, e nesse caso a pessoa é alguém novo para todas as
  comunidades."*
- Premissa 3: sem multi-dispositivo, sem export/import de identidade (`frontend.md` §0).

**4. Ataque.**
1. Qualquer processo rodando como o mesmo usuário chama a mesma API do SO que o app chama.
   Em **DPAPI** (Windows), `CryptUnprotectData` no contexto do usuário decifra o que o mesmo
   usuário cifrou. Em **libsecret** (Linux), a coleção destravada da sessão responde a qualquer
   cliente D-Bus do usuário. O Keychain do macOS é o único dos três com ACL por assinatura de
   aplicativo, e mesmo lá o cenário "atacante já executa código como o usuário" tem saídas.
2. O atacante obtém a chave privada e **é** a vítima: assina ops, entra nas comunidades dela,
   passa por todos os 12 estágios de validação, aparece no log de auditoria com o nome dela.
3. A vítima não tem ação disponível. Não há rotação, não há revogação, não há "encerrar sessões",
   não há como provar que a chave foi comprometida. O único ato possível é `identity.wipe`, que
   destrói **a própria** participação e não impede o atacante de continuar usando a cópia.
4. Se a vítima era host, o atacante ganha o cargo Fundador com as 17 permissões, e `hostKey` é
   imutável (§4.2): a comunidade não tem sucessão.

**5. Vulnerabilidade / premissa explorada.** `safeStorage` protege contra **outro usuário** e
contra **leitura de arquivo por processo que não pode falar com o serviço de segredos** — não
contra o adversário nomeado na tabela. A tabela de §18.1 promete uma propriedade que a primitiva
não tem em duas das três plataformas suportadas.

**6. Impacto.** Personificação total, permanente e indistinguível, sem caminho de detecção nem de
recuperação, num produto que declara a identidade como sua única credencial.

**7. Probabilidade.** Média. Exige execução local — que é exatamente o adversário que a spec
escolheu modelar.

**8. Severidade.** CRITICAL, principalmente pela **ausência de recuperação**: um comprometimento
sem revogação é permanente por construção.

**9. Mitigação existente na spec.** ADR-19 (a melhor escolha disponível sem inventar senha — e a
justificativa da ADR está correta); zerar o `Buffer` no shutdown (§7.1); proibição de a chave
aparecer em log, IPC ou erro (§3.2, §7.1, §17.2).

**10. Resolve ou só reduz?** **Reduz** — e reduz de verdade contra o cenário "alguém copiou o
arquivo `identity.enc` para outra máquina", que é real e comum. **Não resolve** o cenário declarado
na tabela. A ADR está certa; o **modelo de ameaça** é que está otimista.

**11. Compatibilidade.** Não proponho senha mestra (a ADR-19 já a rejeitou por bom motivo, e ela
reintroduz "esqueci minha senha" num produto sem servidor). O que é compatível e falta:
(a) **corrigir §18.1** — a linha precisa dizer "não consegue ler a chave privada **de outra
   máquina**" e admitir o processo local como capaz;
(b) declarar, em §25 e na UI, que **não há revogação**: quem perde a máquina perde a identidade e
   não pode invalidá-la;
(c) usar a ACL do Keychain onde ela existe, e documentar a diferença entre plataformas em vez de
   tratá-las como equivalentes.

**12. O que precisa ser validado.**
- Testar empiricamente, nas três plataformas, se um segundo processo do mesmo usuário decifra
  `identity.enc`. É um teste de meia hora e ele decide o texto de §18.1.
- Verificar se `safeStorage` do Electron aplica escopo por aplicação em cada backend, ou se o
  escopo é do usuário.
- Confirmar que `buf.fill(0)` é suficiente dado que a chave também existe como cópia no `main`
  (T-21) e possivelmente em `String` intermediária (`safeStorage.encryptString`/`decryptString`
  trabalham com string — e string em V8 **não** é zerável).

---
# HIGH

---

## T-11 — O nó de repasse da árvore de tela recebe o quadro decodificável e não autenticado: ele vê o conteúdo e pode substituí-lo

**Severidade:** HIGH · **Probabilidade:** Média · **STRIDE:** I · S · T

**1. Ativo afetado.** Conteúdo da tela compartilhada (o dado mais sensível que o produto
transporta) e sua autenticidade perante os espectadores.

**2. Ator.** `A-MEMBRO` designado como repassador; `A-SYBIL` para garantir a designação (T-13).

**3. Pré-condições.**
- §10.8: o quadro é `sessionId · seq · ts · flags · codecConfig? · payload`. **Não há assinatura,
  MAC, nem chave de sessão.** O `payload` é um `EncodedVideoChunk` opaco — opaco por *convenção*.
- §10.8: *"o nó de repasse **copia o quadro inteiro para os filhos sem decodificar nem
  reencodar**. Ele não abre `payload`."* Isso é uma **política**, não uma capacidade: quem recebe
  `codecConfig` + chunks tem exatamente o que um espectador tem.
- §11.17.1: os candidatos a repasse são escolhidos entre quem **consentiu em repassar**, não entre
  quem foi autorizado a **ver**.
- ADR-08 e §11.19 estabelecem, para o relay de dados, que *"blind relay **não lê nada** — o tráfego
  UDX é cifrado ponta a ponta"*. Essa garantia **não existe** na árvore de tela: ali a cifra é
  salto a salto (UDX), e o nó é o destinatário legítimo de cada salto.

**4. Ataque.**
1. Mallory entra no canal de voz, consente em repassar, e é designada nível 1 pelo host.
2. Ela recebe `codecConfig` e todos os chunks. Chama `VideoDecoder` — **assiste à tela do
   apresentador**, mesmo que não devesse (e principalmente: mesmo que o consentimento que ela deu
   fosse só sobre *upload*, que é o que o modal 2.4.1 pergunta).
3. Para spoofing: em vez de repassar, ela **encoda a própria tela** e envia aos filhos com o mesmo
   `sessionId` e `seq` crescente. A subárvore inteira vê o conteúdo dela acreditando ser o do
   apresentador. Nenhum destinatário tem como distinguir: não há assinatura nem chave de sessão.
4. Para censura: ela repassa parcialmente, descarta keyframes, ou para. DS-14 já mostrou que não há
   ACK nem sinal de recepção — a subárvore escurece com `treeHealth: ok`.

**5. Vulnerabilidade / premissa explorada.** Confusão entre "não decodifica" (política do software
honesto) e "não pode decodificar" (propriedade criptográfica). ADR-05 justificou a árvore
precisamente por o repassador não precisar decodificar; disso não decorre que ele não possa.

**6. Impacto.** Compartilhamento de tela — a funcionalidade em que o usuário mais assume
privacidade — é visível a intermediários não autorizados, e o conteúdo exibido a um espectador pode
ter sido substituído por outro membro sem nenhum indício.

**7. Probabilidade.** Média. Exige estar na chamada e ser designado; T-13 mostra que a designação é
manipulável.

**8. Severidade.** HIGH.

**9. Mitigação existente na spec.** Cifra de transporte UDX salto a salto; consentimento explícito
para repassar (§11.18); o host escolhe a topologia (ADR-17).

**10. Resolve ou só reduz?** Protege contra **quem está fora** do caminho e contra nada de quem
está dentro. O consentimento cobre o custo de upload, não o acesso ao conteúdo — e a UI, ao pedir
consentimento "para retransmitir", não informa que retransmitir implica poder assistir.

**11. Compatibilidade.** Uma chave de sessão simétrica gerada pelo apresentador e entregue **só aos
espectadores autorizados** pelo canal já autenticado (a sinalização peer-a-peer de §10.7, que é
Noise sobre hyperdht), com os quadros cifrados e autenticados sob ela. O repassador continua
encaminhando bytes opacos — agora opacos de verdade — e a ADR-05 continua válida, porque ele segue
sem decodificar. Custo: uma cifra simétrica por quadro, muito abaixo do custo de encode.

**12. O que precisa ser validado.**
- Confirmar se, no desenho pretendido, repassador e espectador são o mesmo conjunto. §11.17 diz que
  *"o espectador é participante do canal de voz"* e o repassador também — se forem sempre o mesmo
  conjunto, a exposição de conteúdo é aceitável e o que resta é a **autenticidade** (spoofing), que
  continua de pé.
- Medir o custo da cifra por quadro contra os alvos de §19.1 (latência de folha) antes de decidir.
- Cruzar com F-08: se o repassador não pode transcodificar, "qualidade escolhida por quem assiste"
  já está em contradição; a chave de sessão não piora isso.

---

## T-12 — `codecConfig` e chunks de origem não confiável alimentam o decodificador do renderer

**Severidade:** HIGH · **Probabilidade:** Média · **STRIDE:** E · D

**1. Ativo afetado.** O processo renderer de cada espectador (e, por extensão, o dispositivo).

**2. Ator.** `A-MSG`, `A-MEMBRO` designado pai na árvore.

**3. Pré-condições.**
- §10.8: `codecConfig` vem **no quadro**, quando `flags` tem `configChanged`. Não há validação
  especificada — §18.4 (validação de entrada não confiável) lista envelope, nome de anexo,
  `content`, URL, caminho, emoji e cursor; **não lista quadro de mídia nem `codecConfig`**.
- §2.1: os chunks vão do núcleo ao renderer por `MessageChannel`, e o renderer é quem tem
  WebCodecs. O núcleo é explicitamente proibido de inspecionar (`mediaBridge`: *"Não pode
  inspecionar ou reencodar payload de mídia"*, §3.2).
- Não há verificação de que o remetente do quadro é o pai designado.

**4. Ataque.** Mallory, pai de Carlos na árvore, envia `configChanged` com um `codecConfig`
arbitrário e chunks malformados. O renderer de Carlos configura um `VideoDecoder` com parâmetros
escolhidos pelo atacante e alimenta-o com bytes escolhidos pelo atacante. O alvo é o decodificador
de vídeo do Chromium — historicamente a superfície de memória mais explorada de um navegador.

**5. Vulnerabilidade / premissa explorada.** A regra de fronteira de §2.1 (*"o renderer captura e
codifica; o núcleo transporta e persiste"*) é ótima para desempenho e coloca o parser mais frágil
do sistema do lado que não tem nenhuma validação antes dele.

**6. Impacto.** No melhor caso, travamento do renderer de todos os espectadores de uma subárvore
(DoS). No pior, execução de código no processo que desenha a janela.

**7. Probabilidade.** Média para o DoS (trivial); baixa-média para execução (depende de uma
vulnerabilidade no decodificador — que é sandbox do Chromium, mas é alcançável remotamente por
qualquer membro).

**8. Severidade.** HIGH.

**9. Mitigação existente na spec.** `sandbox: true`, `contextIsolation: true` (§18.5) — que contêm
o dano, e são a razão de isto não ser CRITICAL.

**10. Resolve ou só reduz?** Reduz o alcance da exploração. Não reduz o alcance do DoS, e não impede
a entrega do dado hostil ao parser.

**11. Compatibilidade.** Validar `codecConfig` contra uma allowlist fechada (o produto tem três
qualidades e um codec — §10.8 fixa bitrate e keyframe, então o espaço de configurações legítimas é
minúsculo), rejeitar quadro cujo remetente não seja o pai designado da sessão, e limitar tamanho de
quadro. Tudo isso cabe no núcleo sem violar "não inspecionar payload" — o cabeçalho não é payload.

**12. O que precisa ser validado.**
- Definir normativamente quem valida o cabeçalho do quadro. Hoje `mediaBridge` está proibido de
  inspecionar e o renderer não tem regra.
- Fuzzing do caminho `quadro → VideoDecoder` como teste obrigatório da fase 7.

---

## T-13 — `canRelay` e `uplinkKbps` chegam auto-declarados no RPC, e a árvore é a posição de ataque mais valiosa da sessão

**Severidade:** HIGH · **Probabilidade:** Média · **STRIDE:** S · T · E

**1. Ativo afetado.** Topologia da distribuição de tela; por T-11, o conteúdo e a autenticidade da
transmissão para toda a subárvore abaixo do nó.

**2. Ator.** `A-MEMBRO`, `A-SYBIL`.

**3. Pré-condições.**
- §10.6: `shareJoin{sessionId, canRelay:bool, uplinkKbps}` — os dois vêm **do cliente**.
- §11.17.1: *"o critério é **medido**, não declarado — `uplinkKbps` vem de estatística real do UDX
  numa janela de 10 s"*. As duas afirmações se contradizem, e a contradição é a superfície.
- §11.17.1: ordenação por `(uplink desc, rtt asc)`; nível 1 tem até 5 filhos do apresentador.
- Nada limita quantas identidades de um mesmo humano entram na chamada (T-07).

**4. Ataque.** Mallory declara `uplinkKbps` gigante em cinco identidades e ocupa os cinco slots de
nível 1. Toda a árvore passa por ela. A partir daí, T-11 (ver/substituir) e DS-14/DS-15 (censurar,
duplicar) valem para **todos** os espectadores, não só para um ramo.

**5. Vulnerabilidade / premissa explorada.** Um parâmetro de otimização vira um parâmetro de
posicionamento adversarial no momento em que o algoritmo que o consome decide **quem vê o quê**.

**6. Impacto.** Controle total do canal de distribuição de uma transmissão, obtido declarando um
número.

**7. Probabilidade.** Média.

**8. Severidade.** HIGH.

**9. Mitigação existente na spec.** O parágrafo de §11.17.1 que exige medição, se prevalecer sobre
a assinatura de §10.6.

**10. Resolve ou só reduz?** Se a medição prevalecer, resolve a **inflação** do valor, e não
resolve o resto: um atacante com upload real bom continua candidato preferencial, e §11.17.1
ordena exatamente por isso. A medição também não existe para quem acabou de entrar (DR-44).

**11. Compatibilidade.** Preferir o host nos primeiros níveis já é a intenção declarada
(`CLAUDE.md:17-18`, ADR-17); tornar isso obrigatório para o nível 1 quando o host for capaz reduz
a superfície sem custo. Randomizar o desempate entre candidatos equivalentes impede o atacante de
garantir a posição. E a cifra de sessão de T-11 torna a posição muito menos valiosa.

**12. O que precisa ser validado.**
- Fechar a contradição §10.6 × §11.17.1 (é também um achado de especificação).
- Definir o comportamento para quem entra sem histórico de medição (DR-44).

---

## T-14 — `relay.volunteer` não exige prova de posse da `relayKey`: qualquer membro redireciona o tráfego da comunidade para um terceiro

**Severidade:** HIGH · **Probabilidade:** Média · **STRIDE:** S · D

**1. Ativo afetado.** Caminho de transporte de fallback de toda a comunidade (voz, tela e dados sob
CGNAT); disponibilidade de terceiros usados como alvo.

**2. Ator.** `A-MEMBRO`, `A-DOS`.

**3. Pré-condições.**
- §5.3: `relay.volunteer{relayKey}` — permissão **nenhuma** exigida, hierarquia nenhuma, auditoria
  nenhuma.
- §9.3: a única checagem é *"`relayKey` ≠ zero · autor não é voluntário ativo"*. **Não há prova de
  posse da chave declarada.**
- §11.19: *"`relayThrough` escolhe o voluntário de **menor RTT** medido localmente"* — critério
  totalmente controlável por quem escolhe onde colocar o nó anunciado.
- §4.14: o registro é replicado a todos os membros; F-49 já notou que a `relayKey` fica no log para
  sempre.

**4. Ataque.** Dois usos:
1. **Reflexão/DoS de terceiro.** Mallory anuncia como `relayKey` a chave de um nó que **não é
   dela** — o nó de outra pessoa, ou um alvo qualquer alcançável no DHT. Os 340 membros passam a
   tentar retransmitir por ali quando o furo de NAT falha. Mallory converte a comunidade em fonte
   de tráfego contra um terceiro, e o log a incrimina apenas por ter anunciado uma chave.
2. **Posicionamento para análise de tráfego.** Mallory anuncia um relay real, colocado perto (RTT
   baixo) da maioria. Como `relayThrough` escolhe por menor RTT, ela vira o caminho preferencial.
   O relay é *blind* quanto ao conteúdo — mas vê **quem fala com quem, quando e quanto**, e pode
   descartar seletivamente.

**5. Vulnerabilidade / premissa explorada.** A ADR-08 raciocina sobre **confidencialidade**
("blind relay não lê nada"), que é verdade, e não sobre **integridade da indicação** nem sobre
**metadados**, que é onde o abuso está.

**6. Impacto.** Um membro sem permissão nenhuma influencia o caminho de rede de toda a comunidade,
com efeito sobre disponibilidade e sobre metadados, e usa a comunidade como amplificador contra
alvos externos.

**7. Probabilidade.** Média — barato e sem barreira de permissão.

**8. Severidade.** HIGH.

**9. Mitigação existente na spec.** Consentimento persistido do **voluntário** (`E_CONSENT_REQUIRED`,
§11.19) — que protege o voluntário de virar relay sem querer, não a comunidade do voluntário
mal-intencionado. Idempotência de `relay.withdraw`.

**10. Resolve ou só reduz?** Endereça um problema diferente (consentimento do doador de banda) e
não toca este.

**11. Compatibilidade.** Exigir prova de posse: o host desafia a `relayKey` anunciada antes de
aceitar a op (é uma conexão DHT e um desafio-resposta, o mesmo padrão do convite). Acrescentar
`relay.volunteer` à tabela de rate limit de §19.3 e ao log de auditoria (§4.13) — voluntariar-se
é um ato que afeta todo mundo e hoje é invisível na auditoria.

**12. O que precisa ser validado.**
- Confirmar que `blind-relay` aceita ser usado por quem não controla a chave anunciada. Se o
  protocolo já exigir autenticação mútua, o vetor 1 cai e resta o 2.
- Definir quem paga o custo quando o relay anunciado não responde: hoje o resultado é
  `conn-failed` (§11.19), sem penalização do anunciante.

---

## T-15 — A sinalização WebRTC é peer-a-peer e não tem autorização: qualquer chave conhecida abre conexão com qualquer membro

**Severidade:** HIGH · **Probabilidade:** Alta · **STRIDE:** S · I · D

**1. Ativo afetado.** O endereço de rede de cada membro; a superfície de parsing de SDP/ICE; a
sessão de voz.

**2. Ator.** `A-MEMBRO`, `A-BANIDO`, `A-PEER`, `A-META`.

**3. Pré-condições.**
- §10.7: *"**A sinalização WebRTC é peer-a-peer, não pelo host.** Cada par abre uma conexão direta
  pelo `hyperdht` usando a chave pública do outro (que veio no roster)"*.
- As chaves públicas de todos os membros estão **no log**, replicado integralmente (§6.2) — não só
  as de quem está no roster de voz.
- §10.2: `voice.signal{peerKey, sdp?, ice?}` é um comando IPC aceito para **qualquer** `peerKey`;
  o evento `voice.signal` entrega SDP/ICE recebidos ao renderer.
- Nenhuma regra exige que o remetente esteja no mesmo canal de voz, nem que o destinatário esteja
  em chamada, nem que o host confirme a sessão.

**4. Ataque.**
1. **Descoberta de IP.** Mallory lê a chave pública de qualquer membro no log e abre conexão direta
   pelo hyperdht. O handshake revela o endereço. Isso funciona para **todos os membros de todas as
   comunidades em que ela já esteve**, inclusive depois de sair, e independe de a vítima estar em
   chamada.
2. **Sinalização não solicitada.** Ela envia SDP/ICE. O núcleo da vítima emite `voice.signal` para
   o renderer, que alimenta o `RTCPeerConnection`. Sem autorização, isso é: superfície de parser
   entregue a desconhecidos, tentativa de conexão forçada, e — com candidatos ICE apontando para
   um alvo escolhido — a máquina da vítima como refletora de tráfego.
3. Repetido com `A-SYBIL`, vira ruído contínuo no cliente da vítima sem passar por nenhum rate
   limit (nenhum dos limites de §19.3 cobre sinalização).

**5. Vulnerabilidade / premissa explorada.** A decisão de §10.7 é boa por um motivo real (falha
assimétrica `VOZ-04` sai de graça) e assume que "ter a chave do peer" equivale a "estar autorizado
a falar com ele". No modelo do produto, ter a chave é a condição mais comum possível.

**6. Impacto.** Todo membro é endereçável e localizável por qualquer pessoa que já tenha visto seu
identificador, para sempre, sem revogação — e a superfície de mídia da vítima é acionável por
terceiros.

**7. Probabilidade.** Alta.

**8. Severidade.** HIGH.

**9. Mitigação existente na spec.** O handshake Noise autentica o peer, então a vítima **sabe quem**
está falando. `E_PEER_UNREACHABLE` existe. A mídia é ponta a ponta.

**10. Resolve ou só reduz?** Autenticar o remetente é necessário e insuficiente: saber que Mallory
é Mallory não impede Mallory. Falta a autorização.

**11. Compatibilidade.** O host já é o autorizador da sessão de voz (`VOZ-09`, §11.16 passo 1-2) e
já emite o roster. Basta a regra: **só aceitar sinalização de peers presentes no roster da sessão
de voz corrente**, e descartar o resto antes de chegar ao renderer. Isso não move a sinalização
para o host (a decisão de §10.7 se mantém) — usa o roster que já existe como allowlist. A
descoberta de IP por endereçabilidade é inerente ao P2P e **não** tem correção compatível: precisa
ser declarada (T-24).

**12. O que precisa ser validado.**
- Confirmar se `hyperdht` permite recusar conexões por chave antes do handshake completo (é o mesmo
  mecanismo do `firewall` de §8.5).
- Definir o que o cliente faz com sinalização de quem não está no roster: descartar em silêncio,
  contar em métrica, e nunca emitir evento ao renderer.

---

## T-16 — `blob.stage(path)` não tem como comprovar a origem do caminho: renderer comprometido exfiltra qualquer arquivo do usuário

**Severidade:** HIGH · **Probabilidade:** Baixa-Média · **STRIDE:** I

**1. Ativo afetado.** Todo o filesystem legível pelo usuário.

**2. Ator.** `A-RENDER`.

**3. Pré-condições.**
- §10.2: `blob.stage{communityId, path}` — o renderer envia **um caminho**.
- §18.4: *"Caminho em `blob.stage`: Precisa vir de um diálogo de arquivo do SO; caminho arbitrário
  do renderer é recusado"* — DR-37 já registrou que **não existe mecanismo especificado** para o
  núcleo distinguir um do outro. O núcleo recebe uma string.
- §11.13: o `stage` lê o arquivo e o coloca no core de blobs; depois `message.send` publica a
  referência; §11.13: *"quem já tem o blob **serve automaticamente**"*.

**4. Ataque.** Uma dependência maliciosa no renderer (ou um bug que dê execução lá) envia
`blob.stage{path: '~/.ssh/id_ed25519'}` seguido de `message.send` num canal qualquer — ou nem
isso: basta o `stage`, e depois anunciar o `blobId` por fora. O arquivo sai da máquina pelo
caminho legítimo de replicação.

**5. Vulnerabilidade / premissa explorada.** A regra de §2.4 (*"o renderer nunca toca disco"*) é
correta e é anulada por um comando que faz o núcleo tocar o disco **no lugar** que o renderer
escolher. A proteção declarada em §18.4 depende de uma informação que não atravessa a fronteira.

**6. Impacto.** Exfiltração arbitrária a partir de comprometimento do renderer, com o próprio
produto como canal de saída — o que também frustra a regra 5 de §18.5 ("nenhum dado sai do
dispositivo sem ser para um peer da comunidade": tecnicamente cumprida, e inútil).

**7. Probabilidade.** Baixa-Média. Depende de comprometimento do renderer, cuja superfície a spec
reduziu bem (sem `innerHTML`, CSP sem host externo, sem unfurl, sem CDN) — mas cuja cadeia de
dependências é grande e §18.5 regra 2 é o único controle de supply chain do documento.

**8. Severidade.** HIGH.

**9. Mitigação existente na spec.** A intenção de §18.4; o sandbox do renderer.

**10. Resolve ou só reduz?** A intenção não é um mecanismo. Hoje a mitigação é uma frase.

**11. Compatibilidade.** O padrão que funciona e já existe no Electron: o **main** abre o diálogo,
e a seleção do usuário vira um **handle opaco** (um id de uso único guardado no main) que o
renderer repassa; o núcleo resolve o handle com o main, nunca aceita caminho. A spec já tem um
canal main↔núcleo dedicado a exatamente esta classe de coisa (§2.2: `safeStorage`,
`getDisplayMedia`, guarda de saída) — este é o quarto item natural dele.

**12. O que precisa ser validado.**
- Fechar DR-37 com um mecanismo, não com uma regra.
- Definir se `blob.stage` sem `message.send` subsequente publica alguma coisa na rede: se o core de
  blobs só serve blocos sob pedido de quem conhece o `blobId`, a janela é menor — mas o `blobId`
  está no retorno do comando, ou seja, no renderer comprometido.

---

## T-17 — Anexo de terceiro é entregue ao handler default do SO sem allowlist de tipo nem marca de origem

**Severidade:** HIGH · **Probabilidade:** Alta · **STRIDE:** E

**1. Ativo afetado.** A máquina de cada membro que abrir um anexo.

**2. Ator.** `A-MEMBRO`, `A-SYBIL` (com T-07, entrar para distribuir).

**3. Pré-condições.**
- §10.2: `blob.reveal` *"pede `shell.openPath` ao main (`ARQ-09`)"*.
- §14.5: o arquivo é gravado em `userData/p2p/blobs/<communityId>/<blobIdHex>-<nomeSanitizado>`.
- §4.10: `kind` é `video|image|audio|document|other`, **inferido da extensão**, com `other` como
  default (§11.13). Não há bloqueio, aviso ou allowlist.
- §18.4 sanitiza o **nome** contra travessia de caminho — e só.
- Nada no documento menciona marca de origem (Mark-of-the-Web / atributo de quarentena).

**4. Ataque.** Mallory anexa `Relatorio_2026.pdf.exe`, `.lnk`, `.desktop`, `.scr`, `.html`,
`.docm` — qualquer coisa que o SO associe a um executor. O destinatário clica em "Abrir" na UI, o
main chama `shell.openPath`, o SO executa. É a rota de malware mais banal que existe, e aqui ela
não encontra nem um aviso.

**5. Vulnerabilidade / premissa explorada.** A sanitização foi desenhada contra **travessia de
caminho** (um problema de filesystem) e não contra **execução** (um problema de confiança no
conteúdo). São ameaças diferentes e a spec só modelou a primeira.

**6. Impacto.** Execução de código no dispositivo do destinatário a um clique de distância,
distribuída por um canal que o usuário considera interno e confiável.

**7. Probabilidade.** Alta — é o vetor mais explorado em qualquer produto de chat, e a única
barreira aqui é entrar na comunidade, que T-06 e T-07 tornam barato.

**8. Severidade.** HIGH.

**9. Mitigação existente na spec.** Sanitização do nome; prefixo `<blobIdHex>-` (que, de quebra,
quebra a extensão dupla visualmente, mas não a real); verificação de hash (que garante integridade,
não inocuidade); `shell.openPath` no main e não no núcleo.

**10. Resolve ou só reduz?** Nenhuma dessas mitigações endereça execução. `shell.openPath` no main
é sobre arquitetura, não sobre segurança do conteúdo.

**11. Compatibilidade.** Aplicar o atributo de quarentena do SO ao gravar (uma chamada por
plataforma), exigir confirmação nomeada para tipos executáveis, e mostrar a extensão real na UI.
Nada disso é servidor, conta ou antivírus embutido — é higiene de download, que qualquer navegador
faz.

**12. O que precisa ser validado.**
- Fechar o mapa extensão→`kind` (DR-41), que hoje não existe, e decidir ali mesmo a lista de tipos
  que não abrem direto.
- Verificar o comportamento de `shell.openPath` para cada tipo nas três plataformas.
- Definir se a UI mostra o nome original ou o nome no disco (com o prefixo `blobIdHex`): mostrar o
  original é o que o usuário espera e é o que permite o disfarce.

---

## T-18 — Markdown com link não tem allowlist de esquema de URL

**Severidade:** HIGH · **Probabilidade:** Média · **STRIDE:** E · I

**1. Ativo afetado.** O renderer e, via handler externo, o SO do destinatário.

**2. Ator.** `A-MEMBRO`.

**3. Pré-condições.**
- `frontend.md` §11: markdown básico com `[texto](url)` e URL solta, renderizado *"sempre elemento
  React, nunca HTML injetado"* — o que fecha XSS por injeção de marcação e **não** fecha o
  atributo `href`.
- §18.4: a linha sobre URL trata apenas de **unfurl** (*"sem unfurl — buscar a página vazaria o IP"*).
  Não há regra sobre **qual esquema** é renderizável ou clicável.
- §15.1 detecta `https?://` para a aba Links — o que sugere que só http(s) importa, mas é regra de
  busca, não de renderização.

**4. Ataque.** `[Planilha do trimestre](javascript:...)` — se o React renderizar `href` sem
filtro, o clique executa no contexto do renderer, contornando a CSP (que restringe origem de
script, não `javascript:` em navegação). Variantes: `file:///…` e `smb://…` (vazamento de
credencial NTLM no Windows ao abrir compartilhamento remoto), `data:text/html…`, e qualquer
esquema customizado registrado por outro app na máquina — inclusive `comunidadep2p://` (T-46).

**5. Vulnerabilidade / premissa explorada.** "Não usamos `innerHTML`" resolve injeção de nós e é
frequentemente confundido com "sanitizamos o conteúdo". Atributo de navegação é o furo clássico
que sobra.

**6. Impacto.** De vazamento de credencial de rede a execução no renderer, por uma mensagem de
texto.

**7. Probabilidade.** Média — depende de o implementador não ter posto a allowlist por conta
própria, e §0 do backend proíbe explicitamente que o implementador decida por conta própria.

**8. Severidade.** HIGH.

**9. Mitigação existente na spec.** CSP sem `unsafe-inline` e sem host externo; ausência de unfurl;
renderização por elemento React.

**10. Resolve ou só reduz?** Fecha injeção de marcação e vazamento passivo de IP. Não toca o
esquema do link.

**11. Compatibilidade.** Allowlist `https:` e `http:` na renderização, tudo o mais vira texto
inerte; abertura externa por `shell.openExternal` com a mesma allowlist. É uma linha de regra em
§18.4.

**12. O que precisa ser validado.**
- Ler `lib/markdown.tsx` (já implementado) e verificar o tratamento de `href` hoje.
- Definir se link abre no navegador do SO ou dentro do app, e escrever isso — hoje não está em
  documento nenhum.

---

## T-19 — O portão dos comandos `dev.*` é `NODE_ENV !== 'production'`, que falha aberto

**Severidade:** HIGH · **Probabilidade:** Média · **STRIDE:** E · D

**1. Ativo afetado.** Tudo: `dev.resetAll` *"equivale a `identity.wipe` sem confirmação"*
(Apêndice B).

**2. Ator.** `A-LOCAL`, `A-RENDER`, e o próprio azar de build.

**3. Pré-condições.**
- §10.2: *"Injeção de falha (só com `NODE_ENV !== 'production'`) … Registrados sob `dev.*` e
  **ausentes do roteador em produção**, não apenas escondidos"*.
- §20: `NODE_ENV` | default `production` no build — isto é, o valor correto depende de o build
  **definir** a variável.
- §20: precedência **variável de ambiente > `config.json` > default** — quem lança o processo
  controla a variável.
- Apêndice B: `dev.resetAll`, `dev.seedDataset`, `dev.hostOffline`, `dev.forgetConsent`.

**4. Ataque.** Duas formas:
1. **Erro de build.** Em app Electron empacotado, `process.env.NODE_ENV` frequentemente vem
   `undefined`. `undefined !== 'production'` é **verdadeiro** → o roteador `dev.*` existe em
   produção. O modo de falha do portão é *abrir*.
2. **Ataque deliberado.** `A-LOCAL` lança o app com `NODE_ENV=development` (atalho modificado,
   `.desktop`, script). O portão abre por definição. A partir daí, um `dev.resetAll` apaga a
   identidade e todos os dados.

**5. Vulnerabilidade / premissa explorada.** Um controle de segurança implementado como
**comparação em tempo de execução com uma variável de ambiente**, num processo cujo ambiente o
adversário local controla. A intenção da spec ("ausentes do roteador, não apenas escondidos") é a
correta; a implementação especificada não a cumpre.

**6. Impacto.** Destruição irreversível de dados; injeção de dataset falso; desligamento do host;
apagamento de consentimentos.

**7. Probabilidade.** Média-Alta para a variante 1 (é o comportamento default do empacotamento),
Média para a 2.

**8. Severidade.** HIGH.

**9. Mitigação existente na spec.** A frase "ausentes do roteador em produção".

**10. Resolve ou só reduz?** A frase descreve o objetivo certo; o mecanismo escolhido não o
implementa.

**11. Compatibilidade.** Eliminação em tempo de **compilação** (flag do bundler, `define` +
tree-shaking), de modo que o código dos handlers `dev.*` não exista no artefato de produção. É o
que a própria frase pede. Custo zero, nenhuma premissa tocada.

**12. O que precisa ser validado.**
- Testar o artefato empacotado: enviar `dev.resetAll` pelo IPC e verificar `E_UNKNOWN_COMMAND`.
  Este teste pertence ao CI, não à revisão.
- Revisar a mesma classe de portão em `P2P_TESTNET` (§20): usar a DHT pública quando se pretendia
  testnet é o inverso, e igualmente perigoso.

---

## T-20 — O IPC é onipotente sobre um renderer que a própria spec trata como não confiável

**Severidade:** HIGH · **Probabilidade:** Baixa-Média · **STRIDE:** E · D

**1. Ativo afetado.** Todos os comandos de escrita e, em especial, os destrutivos:
`identity.wipe`, `core.reproject`, `community.end`, `blob.stage`, `dev.*`.

**2. Ator.** `A-RENDER`, `A-LOCAL` (com acesso ao processo).

**3. Pré-condições.**
- §18.5: `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true` — postura de
  desconfiança explícita em relação ao renderer.
- §10.1: o quadro `req` tem `cmd` + `arg`. Não há capability, escopo, nível de confirmação nem
  limite de taxa **no sentido renderer→núcleo** (o `IPC_EVENT_HIGHWATER` é backpressure de
  eventos, do núcleo para o renderer).
- §4.1: *"`identity.wipe` … apaga a chave do keystore, apaga o diretório de dados inteiro …
  **Não há confirmação no backend** — a confirmação é da UI"*.

**4. Ataque.** Um renderer comprometido emite um quadro `{t:"req", cmd:"identity.wipe", arg:{}}` e
o produto se apaga. Ou emite `blob.stage` (T-16). Ou inunda `message.send` até `E_OUTBOX_FULL` em
todas as comunidades. Nenhum desses caminhos passa por confirmação, por segunda via ou por limite.

**5. Vulnerabilidade / premissa explorada.** A postura de sandbox declara que o renderer pode ser
hostil; o desenho do IPC assume que ele é honesto. As duas afirmações estão no mesmo documento.

**6. Impacto.** O sandbox do renderer deixa de proteger o que importa, porque o que importa está
do outro lado de um canal sem autorização.

**7. Probabilidade.** Baixa-Média (exige comprometer o renderer), mas o impacto do caso destrutivo
é total e irreversível.

**8. Severidade.** HIGH.

**9. Mitigação existente na spec.** A validação de forma na fronteira (§10.1, `E_MALFORMED` antes
de L2) e a arquitetura de processos.

**10. Resolve ou só reduz?** Validação de forma protege contra quadro malformado, não contra quadro
bem-formado e malicioso.

**11. Compatibilidade.** Classificar os comandos: os destrutivos e irreversíveis
(`identity.wipe`, `community.end`, `dev.*`, e `blob.stage` por T-16) exigem confirmação pelo
**main** — que é o processo que já detém `safeStorage`, o diálogo de arquivo e a guarda de saída
(§2.2), e é justamente o processo que a arquitetura trata como confiável. Isso mantém a regra 2.4
("nenhum estado de domínio no renderer") intacta e não muda contrato nenhum de UI.

**12. O que precisa ser validado.**
- Definir a lista de comandos privilegiados. Hoje §10.2 não tem essa coluna.
- Verificar se o `MessagePort` entregue ao renderer pode ser obtido por qualquer código carregado
  nele (é o caso por construção) — isso decide se a mitigação precisa ser do lado do núcleo.

---

## T-21 — A chave privada atravessa a fronteira main↔núcleo, contra o que §7 afirma, e as cópias não são zeráveis

**Severidade:** HIGH · **Probabilidade:** Baixa · **STRIDE:** I

**1. Ativo afetado.** A chave privada Ed25519.

**2. Ator.** `A-LOCAL` (dump de memória, depurador, crash dump), `A-FS` (arquivo de crash).

**3. Pré-condições.**
- §7.1: *"A chave privada **nunca** cruza o IPC, nunca aparece em log, nunca entra numa mensagem de
  erro."*
- §2.2: *"O main mantém **um** canal próprio com o núcleo, exclusivo para três coisas que só ele
  pode fazer: **decifrar a chave privada com `safeStorage`**, …"* e §2.3, fase `identity`:
  *"Pede a chave privada ao main"*. DR-03 já registrou a contradição.
- §3.2, `keystore`: *"**Não pode** manter a chave decifrada fora de um `Buffer` que é zerado no
  shutdown"* — regra que só pode valer para o núcleo, não para o main nem para a serialização
  entre eles.
- `safeStorage.encryptString` / `decryptString` operam sobre `string`. `String` em V8 é imutável e
  **não zerável**; o GC a move e a copia.

**4. Ataque.** A chave existe simultaneamente em: (a) uma `String` do V8 no main, não zerável;
(b) uma cópia produzida pela serialização do `MessagePort`; (c) o `Buffer` do núcleo. Um dump de
memória de qualquer um dos dois processos, um crash dump gravado pelo SO, ou um depurador anexado
por `A-LOCAL` obtêm a chave. `buf.fill(0)` no shutdown zera apenas (c).

**5. Vulnerabilidade / premissa explorada.** Uma garantia declarada em termos absolutos
("**nunca** cruza o IPC") sobre uma arquitetura que a exige, e uma medida de higiene (zerar buffer)
aplicada a uma das três cópias.

**6. Impacto.** Aumenta a superfície de T-10 e enfraquece a única barreira que a ADR-19 oferece.
Isoladamente é HIGH; combinado com T-10 (ausência de revogação) é o mesmo desfecho permanente.

**7. Probabilidade.** Baixa — exige acesso de depuração ou dump.

**8. Severidade.** HIGH.

**9. Mitigação existente na spec.** `buf.fill(0)`; proibição de log e de exposição por erro (§17.2,
§3.2).

**10. Resolve ou só reduz?** Reduz de forma real a exposição por log — que é o vetor mais comum. Não
cobre memória nem serialização.

**11. Compatibilidade.** Duas saídas, ambas compatíveis: (a) manter a chave **só no main** e expor
uma operação `sign(bytes) → sig` pelo canal privilegiado, de modo que o segredo não atravesse
fronteira nenhuma — custa um salto de IPC por op, e o alvo de §19.1 para validação é 100 µs, com
teto de 500 µs, então precisa ser medido; ou (b) manter como está, **corrigir §7**, e trabalhar
com `Buffer` em vez de `String` na fronteira do `safeStorage`, desabilitando crash dumps.

**12. O que precisa ser validado.**
- Fechar DR-03: o canal main↔núcleo não tem contrato definido, e a chave é o primeiro item dele.
- Medir o custo de (a) — se couber no orçamento, é estritamente melhor.
- Verificar se `utilityProcess` do Electron gera core dump por default nas três plataformas.

---

## T-22 — Configuração e ambiente não têm integridade: eclipse do DHT e vazamento de IP por edição de arquivo

**Severidade:** HIGH · **Probabilidade:** Média · **STRIDE:** T · I · S

**1. Ativo afetado.** A visão de rede do nó; o endereço IP do usuário; o diretório de dados.

**2. Ator.** `A-FS`, `A-LOCAL`.

**3. Pré-condições.**
- §20: precedência **variável de ambiente > `config.json` em `userData` > default**, resolvida no
  boot e congelada. Nenhuma integridade, nenhuma assinatura, nenhuma restrição de origem.
- `P2P_BOOTSTRAP` — *"Nós de bootstrap do DHT"*. `P2P_STUN_SERVERS` — vazio por default, e §22.3
  reconhece que *"ligar isso expõe o IP a um terceiro"*. `P2P_DATA_DIR` — raiz de dados.
  `P2P_MAX_CONNECTIONS`, `P2P_DEDUPE_TTL_MS`, `P2P_LOG_LEVEL` (até `trace`).

**4. Ataque.**
1. **Eclipse.** `A-FS` escreve `P2P_BOOTSTRAP` apontando para nós controlados. O nó entra numa
   DHT do atacante. Ele não lê conteúdo (tudo é cifrado e assinado), mas controla **descoberta**:
   pode esconder o host real (o app mostra "buscando peers"), apresentar apenas peers escolhidos, e
   observar todos os tópicos procurados — isto é, **a lista completa de comunidades da vítima**.
2. **Vazamento de IP.** Preenche `P2P_STUN_SERVERS`. A ADR-06 existe exatamente para impedir isso, e
   a decisão inteira é revertida editando um arquivo de texto — sem que a UI, segundo §22.3, seja
   obrigada a avisar (o texto diz que *"a interface precisa avisar"*, mas o aviso depende de a UI
   ler a configuração e não há evento para isso).
3. **Redirecionamento de dados.** Muda `P2P_DATA_DIR` e o app abre um diretório preparado —
   identidade plantada, comunidades plantadas.
4. **Rebaixamento de defesa.** `P2P_DEDUPE_TTL_MS` no mínimo (24 h) amplia a janela de T-05;
   `P2P_LOG_LEVEL=trace` liga log por op.

**5. Vulnerabilidade / premissa explorada.** A configuração é tratada como conveniência
operacional; várias linhas dela são, na prática, **controles de segurança** (ADR-06 é uma decisão
de privacidade; o bootstrap é a raiz de confiança da descoberta).

**6. Impacto.** Um atacante com escrita em um arquivo do usuário controla com quem o app fala e a
quem ele revela o endereço, sem tocar em nenhum segredo.

**7. Probabilidade.** Média — mesmo nível de acesso que T-03 e T-36.

**8. Severidade.** HIGH.

**9. Mitigação existente na spec.** §22.1 declara o bootstrap como *"ponto de centralização de
fato"* e oferece a tabela de rotas persistida como mitigação; a lista de STUN nasce vazia; a
configuração é congelada no boot.

**10. Resolve ou só reduz?** A tabela persistida (`P2P_DHT_PERSIST`) **de fato** reduz o eclipse
por bootstrap hostil — um nó que já entrou volta a entrar. É uma boa defesa e vale registrar. Não
cobre a primeira entrada, nem o STUN, nem o `DATA_DIR`.

**11. Compatibilidade.** Marcar as chaves sensíveis à segurança (`P2P_BOOTSTRAP`,
`P2P_STUN_SERVERS`, `P2P_DATA_DIR`) como exigindo confirmação explícita na UI quando diferirem do
default, e exibir estado permanente quando estiverem alteradas — é a mesma lógica de honestidade do
princípio 3, aplicada à configuração.

**12. O que precisa ser validado.**
- Verificar se o `P2P_DHT_PERSIST` sozinho resiste a um bootstrap hostil na primeira execução
  depois de uma reinstalação.
- Decidir se `config.json` deve ser assinado/lacrado, ou se a resposta é apenas exibir divergência.

---

## T-23 — Convite emitido sobrevive à queda de privilégio, ao kick e ao ban de quem o emitiu

**Severidade:** HIGH · **Probabilidade:** Média · **STRIDE:** E

**1. Ativo afetado.** Controle de entrada na comunidade.

**2. Ator.** `A-BANIDO`, ex-moderador rebaixado.

**3. Pré-condições.**
- §4.11: ciclo de vida do convite = `active → (revoked | expired | exhausted)`. **A saída, o
  rebaixamento e o ban do criador não são transições.**
- §5.3: `invite.revoke` exige `create_invite` **+** (autor do convite **ou** `manage_community`).
- §4.11: `secret` fica *"só na réplica de quem criou"* — o criador o conhece para sempre, mesmo
  banido.
- §4.3: quem sai e volta recupera o `Member` com cargos resetados — o que trata a escalada por
  cargo e **não** trata a capacidade já emitida.

**4. Ataque.** Bianca, moderadora com `create_invite`, emite um convite sem `expiresAt` e sem
`maxUses` (ambos opcionais, §4.11). É rebaixada, expulsa ou banida. Ela mantém o segredo. Se o
convite não for explicitamente revogado — e ninguém sabe que ele existe, a não ser olhando a lista
de 3.1b —, ela reentra com identidade nova (§4.3 admite), ou distribui o código a quem quiser.
Repetidamente.

**5. Vulnerabilidade / premissa explorada.** Revogar privilégio não revoga **capacidades já
emitidas sob aquele privilégio**. É a diferença entre remover a permissão de imprimir chaves e
recolher as chaves impressas.

**6. Impacto.** Porta dos fundos permanente, cuja existência depende de o administrador auditar
manualmente uma lista.

**7. Probabilidade.** Média — o cenário "moderador que saiu mal" é o mais comum em comunidades.

**8. Severidade.** HIGH.

**9. Mitigação existente na spec.** `invite.revoke` manual; lista de convites ativos em 3.1b;
`INVITE_MAX_ACTIVE = 50`.

**10. Resolve ou só reduz?** Só funciona se alguém lembrar. E F-21 já mostrou que a UI de 3.1b
promete listar o código de todos os convites ativos enquanto o backend só produz o de quem criou —
ou seja, a superfície de auditoria também está incompleta.

**11. Compatibilidade.** Regra de projeção, sem op nova: `mod.ban` e `mod.kick` revogam os convites
criados pelo alvo; perder `create_invite` marca os convites do membro como `suspended` até que
alguém com `manage_community` os reative. Isso é lógica de reducer, determinística, e não contradiz
nenhuma premissa.

**12. O que precisa ser validado.**
- Confirmar que nenhuma regra existente faz isso (verifiquei §4.11, §4.12, §5.3 e §11.11 — não faz).
- Decidir o que acontece com quem já usou o convite antes da revogação (nada: já é membro, e essa é
  a resposta certa).

---

## T-24 — Endereçabilidade por chave pública e anúncio no DHT expõem o IP de todos os membros; `invisible` não é invisível

**Severidade:** HIGH · **Probabilidade:** Alta · **STRIDE:** I

**1. Ativo afetado.** Localização de rede de cada participante; grafo social; padrão de presença.

**2. Ator.** `A-META`, `A-MEMBRO`, `A-BANIDO`, operador de nó DHT, operador de bootstrap.

**3. Pré-condições.**
- Chaves públicas de todos os membros estão no log replicado (§6.2); `hyperdht` conecta por chave
  pública (§10.7, §11.16 passo 3).
- §6.2/§11.1: o nó anuncia-se no tópico da comunidade; qualquer participante do DHT pode consultar
  peers de um tópico que conheça.
- ADR-16: **todas** as comunidades participadas ficam no swarm — o conjunto de tópicos anunciados
  por um nó **é** a lista de comunidades daquela pessoa.
- §22.1: os nós de bootstrap são de terceiro e veem a entrada de todo nó.
- §4.16: *"o cliente com presença `invisible` **não publica** presença nenhuma … Para os outros ele
  é indistinguível de offline."*

**4. Ataque.**
1. Quem conhece um `coreKey` (T-04) consulta o DHT e obtém o conjunto de peers daquele tópico — a
   lista de **endereços IP** dos membros online, continuamente, sem ser membro e sem deixar rastro
   no log.
2. Quem é (ou foi) membro conhece as chaves públicas e pode conectar diretamente a qualquer uma
   para confirmar presença e endereço, mesmo sem chamada de voz (T-15).
3. `invisible` suprime a **publicação de presença de aplicação** e não suprime nada disso: a
   conexão ao swarm existe, o RPC `hello` existe, a replicação existe. Para o **host** e para
   qualquer observador de rede, a pessoa está visivelmente online. `ID-08`, declarado fechado em
   §26.1, está fechado apenas contra membros que olham a UI.

**5. Vulnerabilidade / premissa explorada.** A privacidade de metadados foi tratada em uma decisão
(ADR-06, não usar STUN de terceiro) e não como propriedade do sistema. O DHT público, que é o
mecanismo central de descoberta, expõe muito mais do que o STUN evitado exporia.

**6. Impacto.** Correlação IP↔identidade↔comunidade para qualquer observador motivado, e uma
promessa de UI ("invisível") que é verdadeira só na camada mais superficial.

**7. Probabilidade.** Alta. É o comportamento normal do sistema, não um ataque.

**8. Severidade.** HIGH — pelo impacto sobre um produto cuja proposta é privacidade.

**9. Mitigação existente na spec.** ADR-06 (não vazar IP para STUN de terceiro); §18.1 admite o
"observador do DHT" e diz que ele *"vê que um tópico existe e quem conecta"*.

**10. Resolve ou só reduz?** §18.1 **acerta** ao declarar o observador de DHT — é a linha mais
honesta da tabela. O que falta é a consequência: "quem conecta" significa **IP de cada membro**, e
significa que `invisible` não protege contra ele. E a ADR-06 evita um vazamento pequeno enquanto o
mecanismo principal produz um grande.

**11. Compatibilidade.** Não há correção compatível — anonimato de rede exige overlay
(Tor/mixnet) e contradiz a arquitetura. A obrigação aqui é de **declaração**: §25 precisa de um
item dizendo que participar de uma comunidade expõe o endereço de rede aos demais participantes e a
quem conheça a chave da comunidade, e a UI de `invisible` precisa dizer contra quem ela funciona.

**12. O que precisa ser validado.**
- Confirmar o que `hyperdht` revela a quem consulta um tópico (endereço direto? só através do
  furo?), porque isso decide a magnitude.
- Verificar se o anúncio de todas as comunidades no mesmo nó permite correlacioná-las entre si
  (ADR-16 sugere que sim: o mesmo endereço anuncia N tópicos).

---

## T-25 — Um firewall único por processo atravessa comunidades e vaza estado de moderação

**Severidade:** HIGH · **Probabilidade:** Média · **STRIDE:** I · D

**1. Ativo afetado.** Isolamento entre comunidades; confidencialidade do estado de ban; entrada de
convidados.

**2. Ator.** `A-BANIDO`, `A-MEMBRO`.

**3. Pré-condições.**
- §3.2, `swarm`: *"**Um** `Hyperswarm` para o processo … `firewall` recusa banidos **na conexão**"*.
- §8.5: *"Recusa a conexão de quem está banido em **todas** as comunidades que o nó hospeda"* —
  ambíguo entre "em qualquer uma" e "em todas elas", e as duas leituras têm defeito.
- F-10 já mostrou que o firewall torna o preview `banned` inalcançável.

**4. Ataque / falha.**
1. **Sobreposição.** Se a leitura for "banido em qualquer uma", um ban na comunidade A impede o
   peer de conectar ao mesmo nó para a comunidade B, onde ele é membro em situação regular. Um
   moderador de A aplica, sem saber, uma punição em B.
2. **Vazamento por oráculo.** O peer descobre que está banido pela recusa de conexão, antes e
   independentemente do preview de convite — que é justamente a superfície que a spec desenhou para
   controlar o que ele descobre (§4.11: `banned` *"sem nome de quem convidou e sem contagem de
   membros"*). Sondando conexões, ele mapeia em quais comunidades daquele host está banido.
3. **Subenforcement.** Se a leitura for "banido em todas", o firewall quase nunca dispara e a
   otimização de §8.5 não existe.

**5. Vulnerabilidade / premissa explorada.** Um controle **por comunidade** implementado num
recurso **por processo**. É o mesmo padrão de TB-9: a spec isola comunidades por convenção
(coluna, chave, escopo) sobre recursos que são globais (swarm, `view.db`, espaço de ids, dedupe).

**6. Impacto.** Punição cruzada entre comunidades independentes e um oráculo de estado de moderação
que a spec explicitamente quis negar.

**7. Probabilidade.** Média.

**8. Severidade.** HIGH.

**9. Mitigação existente na spec.** A intenção de §4.11 de não revelar o motivo ao banido.

**10. Resolve ou só reduz?** A intenção é anulada pelo mecanismo que roda antes dela.

**11. Compatibilidade.** O firewall precisa decidir **por tópico**, não por peer: recusar o peer no
tópico da comunidade em que ele está banido e aceitá-lo nas demais. Se o Hyperswarm não permitir
essa granularidade, a decisão passa para a camada de protocolo (aceitar a conexão, recusar o canal
`protomux` daquela comunidade), o que custa mais CPU e resolve F-10 de quebra.

**12. O que precisa ser validado.**
- Confirmar a granularidade real do `firewall` na versão travada do Hyperswarm — isto decide se a
  mitigação é possível como escrita.
- Desambiguar o texto de §8.5. Hoje ele admite duas leituras com consequências opostas.

---
## T-26 — Retroagir o carimbo em até 7 dias é aceito e exibido como verdade

**Severidade:** HIGH · **Probabilidade:** Média · **STRIDE:** R · T

**1. Ativo afetado.** A linha do tempo da conversa — o dado que as pessoas usam para resolver
divergências sobre quem disse o quê e quando.

**2. Ator.** `A-MEMBRO`.

**3. Pré-condições.**
- §9.1 estágio 6: `op.ts` é aceito em `[hostTs − 7 d, hostTs + 1 d]`.
- §4.7: `clockSkewed` só é marcado quando `authorTs > hostTs + CLOCK_TOLERANCE_MS` — isto é,
  **só para o futuro**. Retroagir não marca nada.
- §5.5: *"Que carimbo a UI mostra? `op.ts` (relógio do autor)"*, e só troca para `hostTs` se
  `clockSkewed`.
- §4.7: *"O host **não** corrige `authorTs`"*.

**4. Ataque.** Mallory envia hoje uma mensagem com `op.ts` de seis dias atrás. O host aceita (dentro
da faixa), não marca nada, e a UI de todo mundo exibe a data escolhida por ela como se fosse a data
do envio. A mensagem aparece no fim do canal (a ordem é por `seq`, §5.5) — mas a ordem por `seq`
não é o que o usuário lê: ele lê o carimbo. Em um canal com pouco tráfego, ninguém nota.

**5. Vulnerabilidade / premissa explorada.** A faixa de 7 dias existe para tolerar relógio errado
(um problema de confiabilidade) e vira, sem contramedida, uma faixa de forja (um problema de
segurança). A assimetria da regra de `clockSkewed` — vigilante para o futuro, cega para o passado —
é o que fecha o caso.

**6. Impacto.** Falsificação de evidência dentro do produto, com aparência de dado verificado, sem
nenhum indicador. Em disputa de moderação — o cenário em que o histórico importa — isso é
diretamente explorável.

**7. Probabilidade.** Média.

**8. Severidade.** HIGH.

**9. Mitigação existente na spec.** `hostTs` é gravado ao lado (§4.7: *"os dois carimbos ficam na
linha do log, como `CLK-04` exige"*) — o dado para detectar existe.

**10. Resolve ou só reduz?** O dado existe e **não é usado**: a UI só o mostra quando `clockSkewed`,
e `clockSkewed` nunca é ligado para o passado. A mitigação está presente e desconectada.

**11. Compatibilidade.** Marcar `clockSkewed` também quando `authorTs < hostTs − tolerância` — é a
mesma comparação, com o outro sinal, e usa a marcação que já existe. F-33 já aponta o mesmo campo
por outro motivo (a spec de UX manda mostrar a hora local de chegada); as duas correções convergem
para "mostrar `hostTs` quando os carimbos divergem materialmente".

**12. O que precisa ser validado.**
- Definir a tolerância retroativa (não precisa ser igual à faixa de aceitação: aceitar 7 d e marcar
  acima de 60 s é coerente).
- Verificar se a UI tem token para o aviso — `spec:371` já define um.

---

## T-27 — `hostTs` e `flags` estão fora da assinatura: carimbo e sinal de relógio são forjáveis pelo host e indetectáveis

**Severidade:** HIGH · **Probabilidade:** Média · **STRIDE:** T · R

**1. Ativo afetado.** Carimbo do host em toda mensagem e toda entrada de auditoria; o sinal
`clockSkewed`; a expiração de convites e timeouts avaliada contra ele.

**2. Ator.** `A-HOST`.

**3. Pré-condições.**
- §5.1: `LogRecord` = `envelope · hostTs · flags`. A assinatura cobre `op`, **não** o `LogRecord`.
  DS-13 registrou o fato do ponto de vista de consistência; aqui interessa a consequência de
  segurança.
- §4.13: `ModerationEntry.at` = `hostTs`. §4.7: `hostTs` é o carimbo autoritativo quando há skew.
- Nenhuma réplica pode verificar `hostTs` contra nada.

**4. Ataque.** O host escolhe qualquer `hostTs` para qualquer registro. Consequências
encadeadas: (a) o log de auditoria pode datar um ban para antes ou depois do fato, o que muda quem
tinha qual cargo naquele instante; (b) ligar `clockSkewed` num registro qualquer faz a UI de todos
exibir o carimbo do host em vez do do autor, **substituindo a hora escolhida pelo autor pela hora
escolhida pelo host** — e desligar o bit esconde uma retroação real (T-26); (c) como `flags` tem
*"Bits 1–7 reservados; leitores devem ignorar bits desconhecidos"*, qualquer sinal futuro herda a
mesma ausência de proteção.

**5. Vulnerabilidade / premissa explorada.** A assinatura cobre a **intenção do autor** e nada
cobre a **anotação da autoridade**, embora a anotação seja exibida como dado do produto.

**6. Impacto.** O único registro temporal confiável do sistema (§5.5 elege `hostTs` como o carimbo
a mostrar quando há dúvida) é integralmente controlado pelo adversário que §18.1 modela.

**7. Probabilidade.** Média.

**8. Severidade.** HIGH.

**9. Mitigação existente na spec.** Nenhuma; §5.1 lista os campos sem comentar a exposição.

**10. Resolve ou só reduz?** —

**11. Compatibilidade.** O host pode **assinar o `LogRecord`** com sua própria chave de identidade
(ele já assina ops; é a mesma primitiva). Isso não impede o host de mentir — ele é a autoridade —
mas torna a mentira **atribuível e não repudiável**, que é o máximo alcançável sob ADR-01 e é
coerente com o princípio 3. Custo: 64 bytes por registro e uma verificação Ed25519 a mais na
projeção, o que dobra o custo dominante de §19.5 e precisa ser medido.

**12. O que precisa ser validado.**
- Medir o impacto na taxa de projeção (§19.1 alvo: ≥ 8.000 reg/s).
- Decidir se vale, dado que o host pode mentir de qualquer forma. A meu ver vale, porque muda
  "indetectável" para "provável perante terceiros", e é isso que o log de auditoria promete.

---

## T-28 — Os canais efêmeros não têm rate limit e o host os amplifica 1→N

**Severidade:** HIGH · **Probabilidade:** Alta · **STRIDE:** D

**1. Ativo afetado.** CPU e banda do host; por §13.5 (RPC tem prioridade 1), também a projeção e
todo o resto.

**2. Ator.** `A-MEMBRO`, `A-SYBIL`, `A-DOS`.

**3. Pré-condições.**
- §19.3 é titulada *"Rate limiting (no host, por autor, por comunidade)"* e lista **apenas ops
  assinadas** e `inviteResolve`. Não constam: `presencePublish`, `typing`, `voiceState`,
  `voiceJoin/Leave`, `shareJoin`, `shareHeartbeat`, `shareLeave`, `blobAnnounce`, `hello`.
- §10.7: `presence` e `typing` vão **membro → host → todos**; `voiceRoster` é reemitido *"a cada
  mudança"*.
- §4.16: presença tem TTL 30 s com refresh a cada 10 s; digitando, TTL 5 s com refresh a cada 3 s.
- Escala de referência: 340 membros (§19.2). F-13 já apontou a inviabilidade do fan-out no caso
  **honesto**.

**4. Ataque.** Mallory publica `presencePublish` e `typing` em laço fechado, milhares por segundo.
Cada um é reemitido pelo host a **todos** os membros: amplificação de 340×. `voiceState` produz
reemissão de roster a cada mudança — alternar `muted` em laço gera fan-out contínuo. Nada disso é
uma op, logo nada disso passa por §19.3, por §12.3 (a fila de uma via é para ops) ou por dedupe.
Com `A-SYBIL`, multiplica-se por identidade.

**5. Vulnerabilidade / premissa explorada.** O rate limit foi desenhado em torno do que **entra no
log**, porque é o que tem custo permanente. O que não entra no log tem custo **imediato**, e é
exatamente esse que o host não pode absorver.

**6. Impacto.** Um membro sem permissão nenhuma derruba a comunidade em segundos, e o host não tem
como responder porque responder exige appendar uma op — que está atrás da fila saturada.

**7. Probabilidade.** Alta.

**8. Severidade.** HIGH (na prática, dado o custo zero e o efeito total, é fronteiriço com
CRITICAL; fica em HIGH porque a recuperação é imediata quando o ataque cessa).

**9. Mitigação existente na spec.** ADR-14 justifica o protocolo efêmero (não poluir o log) e
§10.7 o separa em canal `protomux` próprio *"para não competir com a replicação do core"* — o que
protege a replicação, não o host.

**10. Resolve ou só reduz?** A separação de canal protege o **dado**; o custo continua no mesmo
event loop single-threaded (§13.5).

**11. Compatibilidade.** Estender §19.3 aos métodos efêmeros, com balde por peer, e agregar o
fan-out por janela (o host reemite presença consolidada a cada N ms em vez de por evento) — o que
também é a resposta natural para F-13.

**12. O que precisa ser validado.**
- Medir o fan-out honesto na escala de referência antes de dimensionar o limite (F-13 e A-2, fase 3).
- Definir política de perda para efêmero (DS-30 já pede isso por outro motivo).

---

## T-29 — Personificação é totalmente suportada pelo desenho: `handle` de 30 bits, nomes livres, apelido sem override

**Severidade:** HIGH · **Probabilidade:** Alta · **STRIDE:** S

**1. Ativo afetado.** A capacidade de distinguir pessoas — base de toda confiança social no produto.

**2. Ator.** `A-MEMBRO`, `A-SYBIL`.

**3. Pré-condições.**
- §4.1: `handle` = `@` + **6 primeiros caracteres** de base32(publicKey) → **30 bits**.
  *"Não é único, é mnemônico."*
- §4.1: `displayName` *"**não** tem unicidade: não existe namespace global em P2P"*.
- §4.3: `nickname` é **auto-atribuído** (premissa 11), e `frontend.md` §12 registra que não existe
  moderador renomeando apelido de terceiro.
- §15.2: a lista de membros ordena por `nickname ?? displayName`.
- §9.2: nomes são validados por **comprimento** e `trim`. Não há regra sobre categoria Unicode,
  marcas de direção (RLO/LRO), caracteres de largura zero ou homóglifos.
- DR-09 já registrou que a derivação do handle nem está definida (qual base32, como truncar).

**4. Ataque.** Três camadas que se somam:
1. Mallory copia `displayName` e `avatarColor` do alvo — permitido e trivial.
2. Ajusta o `nickname` para o mesmo texto — auto-atribuído, sem override possível.
3. Para vencer o último discriminador, **gera chaves até o handle bater**: 30 bits ≈ 1,07 × 10⁹
   tentativas; geração de par Ed25519 custa dezenas de microssegundos; o trabalho total é de
   **horas em um notebook**, paralelizável trivialmente. O resultado é um par cujo handle é
   idêntico ao do alvo.
4. Com bidi/zero-width, dá para produzir nomes visualmente idênticos sem sequer gerar chave.

**5. Vulnerabilidade / premissa explorada.** A ausência de namespace global é uma consequência
correta e inevitável do P2P; o produto responde a ela com um discriminador **curto**. 30 bits é
adequado contra colisão acidental e inadequado contra busca dirigida — a diferença entre as duas
coisas é a definição do problema.

**6. Impacto.** Personificação convincente de qualquer membro, inclusive do Fundador, por qualquer
membro, com custo de horas de CPU. Encadeia com T-06 (roubo de convite falando "como" quem
convidou), com engenharia social para obter códigos e com T-17.

**7. Probabilidade.** Alta.

**8. Severidade.** HIGH.

**9. Mitigação existente na spec.** O handle existe justamente como discriminador; a UI mostra
cargo e cor; `frontend.md` 1.4 tem popover de perfil.

**10. Resolve ou só reduz?** O handle **reduz** contra o impostor preguiçoso e **não resiste** a
busca dirigida. E como o próprio texto o classifica como "mnemônico, não único", a UI provavelmente
não o trata como o dado de segurança que ele é.

**11. Compatibilidade.** Sem contrariar premissa nenhuma: (a) aumentar o handle para ≥ 16
caracteres base32 (80 bits) — mesma escolha de bits que a ADR-09 fez para o convite, pelo mesmo
raciocínio, e o convite já provou que 16 caracteres cabem na UI; (b) normalizar e rejeitar
categorias Unicode perigosas em `displayName`, `nickname` e `Role.name` (a spec já normaliza
agressivamente o slug de canal — é o mesmo tipo de regra); (c) marcar visualmente na UI quando dois
participantes visíveis compartilham nome.

**12. O que precisa ser validado.**
- Fechar DR-09 (derivação do handle) e, no mesmo ato, decidir o comprimento com base em custo de
  ataque, não em estética.
- Medir o custo real de grinding com a biblioteca escolhida (`hypercore-crypto`) para escolher os
  bits.

---

## T-30 — Ids de 48 bits num espaço global e num banco único: colisão dirigida atravessa a fronteira entre comunidades

**Severidade:** HIGH · **Probabilidade:** Baixa-Média · **STRIDE:** D · T

**1. Ativo afetado.** A projeção de **todas** as comunidades no dispositivo, não apenas a atacada.

**2. Ator.** `A-MEMBRO` com recurso computacional.

**3. Pré-condições.**
- §4.7/§4.8: ids derivados do `opId` truncado em **12 hex = 48 bits** (`msg-`, `thr-`, `mod-`).
- §6.3: `messages.id TEXT PK`, `roles.id TEXT PK`, `channels.id TEXT PK`, `threads.id TEXT PK` —
  **chaves primárias globais**, sem `community_id` na chave.
- §6.1: *"um único `view.db` para todas as comunidades … O isolamento é por coluna `community_id`"*
  — isolamento nas consultas, não nas chaves.
- §5.1: o `nonce` de 8 bytes é escolhido **pelo autor**, e o `opId` é hash do envelope: o autor tem
  um moinho para procurar prefixos.
- §6.4: reducer que lança → projetor **para**.

**4. Ataque.** Mallory, membro de A, quer parar a comunidade B (da qual é membro, ou cujo id de
mensagem conheceu por um link de `/m/:code`). Ela mói `nonce` até que o `opId` da sua mensagem em
A produza os mesmos 48 bits de um id existente em B. O trabalho é 2⁴⁸ hashes BLAKE2b — caro em CPU,
alcançável em GPU/cluster para um adversário motivado; **e nada além de tempo**. Ao enviar, a
projeção do dispositivo-alvo tenta inserir uma chave primária que já existe **por causa de outra
comunidade**, e o projetor para.

F-05 descreveu a colisão como acidente (aniversário em 48 bits com ~16,7 M ids). O acréscimo aqui é
que ela é **dirigida** e **cruza a fronteira entre comunidades**. E T-05 chega ao mesmo estado com
custo zero — o que torna esta ameaça a *segunda* forma de alcançar um destino que já é alcançável.

**5. Vulnerabilidade / premissa explorada.** Truncar um hash para caber num id legível é decisão de
apresentação; usá-lo como chave primária num espaço compartilhado por domínios de confiança
distintos é decisão de segurança.

**6. Impacto.** Uma comunidade compromete outra através de um recurso local compartilhado — a
violação de isolamento mais direta de TB-9.

**7. Probabilidade.** Baixa-Média (custo computacional real), mas o mesmo efeito é obtido de graça
por T-05.

**8. Severidade.** HIGH.

**9. Mitigação existente na spec.** Nenhuma. §4.18 lista invariantes de consistência, nenhuma sobre
unicidade de id entre comunidades.

**10. Resolve ou só reduz?** —

**11. Compatibilidade.** Chave primária composta `(community_id, id)` — muda o schema, não a
arquitetura, e o schema é descartável por ADR-02, portanto o custo é uma reprojeção. Ou id completo
de 256 bits, com truncamento apenas na exibição.

**12. O que precisa ser validado.**
- Confirmar que os ids são globais nas PKs (verifiquei §6.3: `id TEXT PK` em `messages`, `roles`,
  `channels`, `categories`, `threads`, `moderation_log`).
- Medir o custo de grinding de 2⁴⁸ com o encoding canônico real, para calibrar a probabilidade.

---

## T-31 — `mention_everyone` e `mentionable` não têm ponto de aplicação: menção global irrestrita

**Severidade:** HIGH · **Probabilidade:** Alta · **STRIDE:** D · E

**1. Ativo afetado.** Atenção de todos os membros; a permissão `mention_everyone`; a propriedade
`mentionable` dos cargos.

**2. Ator.** `A-MEMBRO`.

**3. Pré-condições.**
- §4.7: sem `mention_everyone`, *"a op é **aceita com a menção removida**, não rejeitada"*.
- F-26 demonstrou que remover a menção é impossível: o host não pode alterar o payload (quebraria a
  assinatura) e o reducer não pode consultar permissão (§3.2/§3.1).
- §9.3, `message.send`: as checagens listadas **não incluem** menção. §5.3 dá `mention_everyone`
  como *"Menção `everyone` **sobreviver na projeção**"* — ou seja, o enforcement é atribuído à
  projeção, que não tem como fazê-lo.
- §4.4: `mentionable` existe por cargo; nenhuma regra de §9.3 o verifica.
- §4.15: menção conta **mesmo em canal silenciado** (`spec:1140`).

**4. Ataque.** Qualquer membro com `send_messages` inclui `everyone` em `mentions`. A menção
sobrevive. Todo mundo é notificado, inclusive em canais silenciados — o que é regra explícita. A
10 mensagens / 10 s, é uma campanha de assédio de baixo custo e alto alcance. O mesmo vale para
menções a cargos marcados `mentionable: false`, e para `mentions` contendo até 64 chaves
arbitrárias, inclusive de não-membros.

**5. Vulnerabilidade / premissa explorada.** Uma permissão cuja aplicação foi deslocada para uma
camada declaradamente incapaz de aplicá-la — e a justificativa de §4.7 (*"a UI já esconde
`@everyone` de quem não tem a permissão — quem chega aqui sem ela é cliente desatualizado ou
adulterado"*) é exatamente a hipótese contra a qual §8.5 avisa que a UI não é enforcement.

**6. Impacto.** Uma das 17 permissões do produto é decorativa; o mecanismo de notificação fica
aberto a abuso.

**7. Probabilidade.** Alta.

**8. Severidade.** HIGH.

**9. Mitigação existente na spec.** Ocultação na UI; limite de 64 menções; rate limit de
`message.send`.

**10. Resolve ou só reduz?** A UI não é enforcement, por regra da própria spec. O limite de 64 e o
rate limit contêm o volume, não o alcance.

**11. Compatibilidade.** Rejeitar a op no estágio 10 (`E_PERMISSION_DENIED`) em vez de "aceitar
removendo". A spec rejeitou essa saída por ser "desproporcional" — julgamento de UX razoável para o
cliente honesto e insustentável contra o adulterado. Alternativa que preserva a intenção: aceitar,
e a **projeção** ignorar a menção com base em dado que ela já tem (o cargo do autor está no
`member_roles` projetado no mesmo `seq`) — o que exige revisar a proibição de §3.2, e é
determinístico, portanto compatível com §21.4.

**12. O que precisa ser validado.**
- Decidir entre rejeitar e ignorar-na-projeção; as duas são compatíveis com as premissas, e F-26
  já mostra que a redação atual não é implementável.
- Acrescentar `mentionable` às checagens de §9.3, ou declará-lo explicitamente cosmético.

---

## T-32 — A sessão de mídia direta sobrevive ao ban, e o timeout não alcança a voz

**Severidade:** HIGH · **Probabilidade:** Média · **STRIDE:** E

**1. Ativo afetado.** Eficácia das duas ferramentas de moderação em tempo real.

**2. Ator.** `A-BANIDO`, membro sob timeout.

**3. Pré-condições.**
- §11.11 passo 4-5: ao banir, o host *"adiciona a chave ao `firewall`"*, **derruba a conexão do
  alvo com o host** e o remove do roster de voz. Nada é dito sobre as conexões **peer-a-peer**.
- §11.16 passo 3: a mídia é ponta a ponta entre pares, por conexões diretas estabelecidas por
  `hyperdht`. O host **não vê nada** depois do passo 2.
- §9.1 estágio 8 e §4.12: o timeout faz o host recusar *"toda op de escrita"*. `voiceJoin`,
  `voiceState`, `shareStart`, `presencePublish` **não são ops** — são métodos RPC (§10.6). Nenhuma
  regra os inclui.

**4. Ataque.**
1. **Ban durante a chamada.** Mallory é banida enquanto fala. O host a tira do roster; os pares
   dela continuam com `RTCPeerConnection` ativa. Nada na spec exige que o cliente do outro lado
   derrube a conexão ao ver o roster mudar. Ela continua na chamada até que alguém saia.
2. **Timeout e voz.** Mallory recebe timeout de 24 h por assédio no texto. Ela entra no canal de
   voz e continua — o timeout só bloqueia ops, e entrar em voz não é op. O `MOD-05`, que §26.1
   declara fechado, cobre só a escrita.

**5. Vulnerabilidade / premissa explorada.** O enforcement está desenhado em torno do log (o que é
op) e da conexão com o host (o que é firewall). A mídia não é nem uma coisa nem outra — é
exatamente o espaço que a arquitetura, corretamente, tirou do host.

**6. Impacto.** As duas ações de moderação com efeito imediato esperado pelo usuário não têm efeito
imediato onde o abuso é mais agudo — voz em tempo real.

**7. Probabilidade.** Média.

**8. Severidade.** HIGH.

**9. Mitigação existente na spec.** Remoção do roster; firewall; `voice.failed` para exclusão de
canal (§11.8, que faz a coisa certa para outro caso).

**10. Resolve ou só reduz?** A remoção do roster resolve a **apresentação** (a pessoa some da lista)
e não a **conexão**. O firewall só corta o caminho até o host.

**11. Compatibilidade.** Regra normativa no cliente: ao receber `voice.roster` sem um peer, encerrar
a `RTCPeerConnection` com ele — e recusar sinalização de quem não está no roster (a mesma regra de
T-15). Contra o cliente adulterado do outro lado isso não vale, mas o cliente adulterado é da
**vítima**, não do atacante, e num mesh todos os pares honestos derrubam. Incluir `voiceJoin` e
`shareStart` na verificação de timeout é uma linha em §9.1 / §10.6.

**12. O que precisa ser validado.**
- Confirmar que nenhuma regra hoje manda derrubar o par (verifiquei §11.11, §11.16 e §10.7).
- Decidir se timeout impede entrar em voz. É decisão de produto, e hoje ela não está tomada nem em
  um sentido nem no outro.

---

## T-33 — O host controla `retryAfterMs` e a negociação de `opVersion`: silenciamento seletivo indistinguível de bug

**Severidade:** HIGH · **Probabilidade:** Média · **STRIDE:** D

**1. Ativo afetado.** Capacidade de um membro específico de escrever, e a capacidade de perceber
que foi impedido.

**2. Ator.** `A-HOST`.

**3. Pré-condições.**
- §16.1: `retryAfterMs` é campo do erro devolvido pelo host. §19.3: *"a outbox respeita e **não
  conta como tentativa falha**"*. Nenhum limite superior é especificado.
- §10.6: `hello` devolve `opVersion`; incompatível → *"o cliente entra em modo somente-leitura
  naquela comunidade"*. A decisão é do host, por peer.
- §6.5: `OUTBOX_MAX_AGE_MS` = 72 h, depois `dropped/expired`. DS-25 já mostrou que
  `E_VERSION_UNSUPPORTED` não está classificado na outbox.

**4. Ataque.** Eve, host, quer silenciar Ana sem banir (ban aparece no log de auditoria e é
visível). Escolhe uma das duas:
1. Responde `E_RATE_LIMITED` com `retryAfterMs` enorme **apenas para Ana**. A outbox de Ana espera
   obedientemente, sem contar tentativas, até que os itens expirem em 72 h e sejam descartados como
   `expired` — motivo que a UI apresenta como problema de rede.
2. Responde a Ana, no `hello`, com um `opVersion` incompatível. O cliente dela entra em
   somente-leitura naquela comunidade. Para todos os outros, tudo normal.

Em ambos os casos não há op no log, não há entrada de auditoria, e a experiência de Ana é
indistinguível de um bug.

**5. Vulnerabilidade / premissa explorada.** Dois campos de controle de fluxo cujo valor vem do
adversário modelado, sem limite e sem validação, num cliente que os obedece por desenho.

**6. Impacto.** Censura direcionada, silenciosa, sem registro e sem meio de a vítima distinguir de
falha técnica — o que §16.3 regra 3 explicitamente quer evitar ("erro de rede nunca vira erro de
validação"; aqui é o inverso: censura vira erro de rede).

**7. Probabilidade.** Média.

**8. Severidade.** HIGH.

**9. Mitigação existente na spec.** §5.1 declara que o host pode censurar por omissão e que isso é
*"detectável comparando o que se enviou com o log"*. A intenção de transparência existe.

**10. Resolve ou só reduz?** A detecção declarada exige comparar manualmente, e **nenhuma
superfície do produto a oferece** — não há tela, evento nem métrica que mostre "enviei N, o log tem
M". Aqui o membro sequer chega a enviar.

**11. Compatibilidade.** Limitar `retryAfterMs` no **cliente** (teto configurável, ex. 5 min) e
tratar valores acima como sinal; expor no diagnóstico (3.1 → Rede) quantos itens da outbox estão
represados e há quanto tempo — o que também atende DS-06 e F-16; e diferenciar
`E_VERSION_UNSUPPORTED` na UI de "sem conexão".

**12. O que precisa ser validado.**
- Verificar se a UI hoje distingue "represado por rate limit" de "host offline" — pela leitura de
  `frontend.md` §12 e do banner de fila, não distingue.
- Definir o teto e onde ele mora (config, §20).

---

## T-34 — Não há limite de tamanho de requisição RPC antes da decodificação

**Severidade:** HIGH · **Probabilidade:** Média · **STRIDE:** D

**1. Ativo afetado.** Memória e event loop do host.

**2. Ator.** `A-PEER`, `A-SYBIL`, `A-DOS`.

**3. Pré-condições.**
- §9.1 estágio 1 limita o **envelope** (32 KiB, 64 KiB com anexo) — dentro do pipeline de op.
- §10.6: `submitOps{envelopes[≤32]}` — o limite de 32 é do **conteúdo**, verificável só depois de
  decodificar o array.
- §10.5: 8 requests em voo por peer; §19.2: 128 conexões.
- Nenhum limite de quadro é especificado em §10.5 (transporte) nem em §10.7 (efêmero) nem em §10.8
  (mídia).

**4. Ataque.** Cada peer envia requests `protomux-rpc` deliberadamente enormes. O limite de
envelope só se aplica **depois** de o quadro ser recebido e decodificado o suficiente para
enumerar os envelopes. Teto teórico por peer: 32 × 64 KiB × 8 em voo = 16 MiB em voo; × 128
conexões = 2 GiB. E isso é o cenário **conforme**; sem limite de quadro no transporte, o atacante
não precisa respeitar o 32.

**5. Vulnerabilidade / premissa explorada.** A defesa "tamanho antes de decodificar" foi aplicada
no lugar certo do pipeline de op e não na camada que recebe bytes da rede.

**6. Impacto.** Exaustão de memória do processo do host — que, por ADR-20 e §2.3, derruba o núcleo
inteiro (todas as comunidades) e aciona o reinício com limite de 3 tentativas em 60 s, depois do
qual *"o main mostra erro terminal e não reinicia mais"*. Um DoS de memória pode, portanto,
resultar em app que **não volta**.

**7. Probabilidade.** Média.

**8. Severidade.** HIGH.

**9. Mitigação existente na spec.** Estágio 1; `E_BUSY` acima de 8 em voo.

**10. Resolve ou só reduz?** Ambos atuam depois do consumo de memória do quadro.

**11. Compatibilidade.** Teto de quadro na camada `protomux`/RPC, configurável em §20, aplicado
antes de qualquer decode, com a conexão encerrada ao estourar.

**12. O que precisa ser validado.**
- Verificar se `protomux-rpc` na versão travada já impõe teto de quadro (se impuser, o achado cai
  para LOW e vira documentação).
- Reavaliar a política de "3 reinícios e desiste" (§2.3) à luz de um crash **induzido**: hoje ela
  transforma um DoS transitório em indisponibilidade que exige ação do usuário.

---

## T-35 — A regra anti-escalada não cobre o cargo base, que todo membro presente, futuro e reingressante recebe

**Severidade:** HIGH · **Probabilidade:** Média · **STRIDE:** E

**1. Ativo afetado.** O modelo de permissões inteiro.

**2. Ator.** `A-MEMBRO` com `manage_roles`.

**3. Pré-condições.**
- §8.3: *"**Sem escalada de permissão:** ninguém concede a um cargo permissão que não possui"* e
  *"**Sem escalada de posição:** ninguém cria, edita ou move cargo para `position >=` o próprio
  topo"*. As duas regras são sobre **o que o autor já tem**.
- §4.4: *"O **cargo base** não pode ser deletado …, mas **suas permissões são editáveis**"*
  (`spec:729`).
- §4.3: *"Todo membro tem o cargo base"*, e quem sai e volta tem `roleIds` **resetado para só o
  cargo base** — decisão tomada para *evitar* escalada silenciosa.
- F-38 já registrou a mesma abertura.

**4. Ataque.** Bianca tem `manage_roles` e `ban_members`. Ela edita o **cargo base** acrescentando
`ban_members` — permitido: ela possui a permissão (satisfaz a regra 1) e o cargo base está no fundo
da hierarquia (satisfaz a regra 2). No instante do commit, **os 340 membros** ganham `ban_members`,
incluindo qualquer Sybil de T-07 e qualquer banido que reentre com identidade nova. A hierarquia
continua limitando **sobre quem** cada um pode agir, mas o conjunto de quem pode moderar passou de
3 para 340.

**5. Vulnerabilidade / premissa explorada.** As duas regras anti-escalada raciocinam sobre o
**autor** e sobre a **posição**, e não sobre a **população alcançada** pelo cargo editado. O cargo
base é singular precisamente por ser universal e automático, e nada trata essa singularidade do
lado da permissão.

**6. Impacto.** Escalada de privilégio em massa, com uma única op legítima que passa em todos os 12
estágios, e que é difícil de reverter porque afeta todos ao mesmo tempo.

**7. Probabilidade.** Média — exige `manage_roles`, mas basta um moderador comprometido, arrependido
ou enganado.

**8. Severidade.** HIGH.

**9. Mitigação existente na spec.** As duas regras de §8.3 (que são boas, e §25 item 11 já as
reconhece como acréscimo necessário); hierarquia estrita; auditoria de `role.update`… que **não**
gera entrada (§5.3: `role.update` tem `Aud.` vazio — a edição mais perigosa do catálogo é a que não
aparece no log de auditoria).

**10. Resolve ou só reduz?** As regras fecham a escalada *individual* e deixam aberta a
*coletiva*. E a ausência de auditoria em `role.update` remove a única chance de alguém perceber.

**11. Compatibilidade.** Restringir o conjunto de permissões atribuíveis ao cargo base às
não-privilegiadas (as de moderação e `manage_*` fora), ou exigir `manage_community` para editá-lo,
e **acrescentar `role.update` ao log de auditoria**. Nada disso contradiz `spec:729` (as permissões
do cargo base continuam editáveis) nem premissa alguma.

**12. O que precisa ser validado.**
- Confirmar em §5.3 que `role.update` não é auditável (verifiquei: coluna `Aud.` vazia).
- Decidir a lista de permissões vedadas ao cargo base — é decisão de produto e precisa vir do dono
  do produto, não do implementador (§0).

---
# MEDIUM

---

## T-36 — Nada em disco é cifrado além da chave, e as tabelas `local_*` nunca são reconstruídas

**Severidade:** MEDIUM · **Probabilidade:** Média · **STRIDE:** I · T

**1. Ativo afetado.** Todo o conteúdo replicado (`view.db`, `cores/`), os anexos baixados
(`blobs/`), os logs, e o estado local que **não** tem fonte de verdade externa.

**2. Ator.** `A-FS`, `A-LOCAL`.

**3. Pré-condições.**
- §6.1: `view.db`, `cores/`, `blobs/`, `logs/` sem qualquer menção a cifra. Só `identity.enc` é
  cifrado (ADR-19).
- §18.1 admite: o processo local *"consegue ler o SQLite e o corestore"*.
- §6.4: a reprojeção apaga **só** as tabelas de projeção. As `local_*` sobrevivem sempre — é a
  decisão certa para não perder não-lidas e outbox, e significa que **adulteração nelas é
  permanente**.
- §6.3: `local_relay_consent`, `local_dedupe`, `local_outbox`, `local_blob_cache`.

**4. Ataque.**
1. **Leitura.** Toda a conversa de todas as comunidades, em claro, em um arquivo SQLite. Um backup
   automático na nuvem, um notebook sem FDE, ou um malware comum bastam.
2. **Escrita em `local_relay_consent`.** O atacante grava `decision: accept` e a máquina da vítima
   passa a retransmitir tráfego (§11.19 exige consentimento *persistido* — o arquivo **é** a
   persistência).
3. **Escrita em `local_dedupe`.** Inserir `opId`s faz o cliente tratar ops futuras como duplicatas.
   No host, isso **suprime ops legítimas de membros** de forma silenciosa — e DS-20 já notou que a
   tabela não tem `community_id`, então a supressão atravessa comunidades.
4. **Escrita em `local_outbox`.** Injetar envelopes capturados do log para que o cliente os
   reenvie (o envelope é assinado; o cliente não distingue o que ele mesmo enfileirou).

**5. Vulnerabilidade / premissa explorada.** A ADR-02 declara o SQLite "descartável", o que é
verdade para *integridade* (reprojetar corrige) e falso para *confidencialidade* e para as tabelas
`local_*`, que por desenho **não** são reconstruíveis.

**6. Impacto.** Confidencialidade total do histórico perante acesso ao disco; e adulteração
persistente de estado de segurança (consentimento, dedupe) que nenhum mecanismo detecta ou repara.

**7. Probabilidade.** Média.

**8. Severidade.** MEDIUM — o vetor exige acesso ao disco, que já é o pressuposto de T-03 e T-10;
o que mantém a nota é o alcance da adulteração de `local_dedupe`.

**9. Mitigação existente na spec.** Redação de log por allowlist (§17.2) — boa e bem justificada;
`safeStorage` para a chave.

**10. Resolve ou só reduz?** A redação impede que o **log** vaze conteúdo; o `view.db` ao lado tem
tudo.

**11. Compatibilidade.** Cifrar `view.db` com uma chave guardada no `safeStorage` (SQLCipher ou
equivalente) é possível e não contradiz premissa; o custo é de dependência e desempenho e deve ser
medido contra §19.1. No mínimo, `local_dedupe` e `local_relay_consent` precisam ser tratados como
estado de segurança com integridade verificada.

**12. O que precisa ser validado.**
- Decidir explicitamente se o produto promete confidencialidade em repouso. Hoje §18.1 diz que
  **não**, e a UI provavelmente sugere que sim — se for esse o caso, é item de §25.
- Fechar DS-20 (escopo e limpeza de `local_dedupe`) tratando-o como controle de segurança.

---

## T-37 — A sanitização de nome de anexo remove em vez de rejeitar, e não cobre as peculiaridades do Windows

**Severidade:** MEDIUM · **Probabilidade:** Média · **STRIDE:** T

**1. Ativo afetado.** O filesystem do destinatário.

**2. Ator.** `A-MEMBRO`.

**3. Pré-condições.**
- §18.4: *"Nome de anexo: Sanitizado antes de tocar filesystem: **remove** `..`, `/`, `\`, `\0`,
  controle"*.
- §9.2: `Attachment.name` de 1 a 255 **bytes**; §14.5: caminho final
  `blobs/<communityId>/<blobIdHex>-<nomeSanitizado>`.

**4. Ataque.** Sanitização por **remoção** é a receita clássica de bypass: `....//` vira `../`
depois de uma passada; `..%2f` depende da ordem de decodificação. Além disso, a lista não cobre:
nomes reservados do Windows (`CON`, `PRN`, `NUL`, `COM1`…), ponto e espaço finais (que o Windows
descarta, permitindo colisão entre `a.txt` e `a.txt `), `:` (fluxo alternativo de dados em NTFS), e
o teto de comprimento de caminho — 255 bytes de nome mais o prefixo `<blobIdHex>-` (64+1) mais o
diretório podem estourar limites e produzir falha de escrita.

**5. Vulnerabilidade / premissa explorada.** Sanitizar (transformar) em vez de validar (aceitar ou
recusar), num campo cujo conjunto válido é pequeno e fácil de descrever.

**6. Impacto.** Na melhor hipótese, falhas de escrita e colisões; na pior, escrita fora do
diretório pretendido. O prefixo `<blobIdHex>-` limita bastante o dano real (o nome nunca começa com
`..`), o que segura a severidade em MEDIUM.

**7. Probabilidade.** Média.

**8. Severidade.** MEDIUM.

**9. Mitigação existente na spec.** A própria regra de §18.4 e o prefixo determinístico de §14.5 —
que é, de fato, a defesa mais eficaz das duas.

**10. Resolve ou só reduz?** O prefixo reduz muito. A remoção iterativa continua sendo o mecanismo
errado.

**11. Compatibilidade.** Validar contra allowlist e **rejeitar** (`E_VALIDATION.name`), resolver o
caminho final e verificar que ele permanece dentro do diretório da comunidade antes de escrever.

**12. O que precisa ser validado.**
- Testar a sanitização com um corpus de nomes hostis nas três plataformas.
- Decidir o comportamento em colisão de nome final (hoje o `blobIdHex` a torna improvável, mas não
  há regra).

---

## T-38 — `hello` responde a quem não é membro

**Severidade:** MEDIUM · **Probabilidade:** Alta · **STRIDE:** I

**1. Ativo afetado.** Informação sobre a comunidade: tamanho, atividade, versão.

**2. Ator.** `A-PEER`, `A-BANIDO`, `A-META`.

**3. Pré-condições.**
- §10.6: `hello{clientVersion, opVersion}` → `{hostVersion, opVersion, coreLength, memberCount,
  capabilities[]}`. §10.6: *"`hello` antes de qualquer outro método"* — não há requisito de
  associação.
- §8.5: o firewall recusa **banidos**; um desconhecido com o `coreKey` conecta normalmente.
- §4.11 desenhou o preview de convite com cuidado para **não** revelar `memberCount` a banidos.

**4. Ataque.** Quem obtiver um `coreKey` (T-04) conecta e pergunta. Recebe tamanho da comunidade e
`coreLength` (proxy direto do volume de atividade). Repetindo periodicamente, mede o crescimento e o
ritmo da comunidade sem nunca entrar — e sem aparecer em lugar nenhum.

**5. Vulnerabilidade / premissa explorada.** Um método de negociação de versão que também devolve
dado de negócio, antes de qualquer autorização.

**6. Impacto.** Vazamento contínuo de metadados agregados, que contraria diretamente o cuidado que
§4.11 tomou na mesma informação.

**7. Probabilidade.** Alta (para quem tem a chave).

**8. Severidade.** MEDIUM.

**9. Mitigação existente na spec.** Firewall para banidos.

**10. Resolve ou só reduz?** Cobre um dos atores e nenhum dos outros dois.

**11. Compatibilidade.** `hello` devolve só o que é necessário para negociar versão; `coreLength` e
`memberCount` só depois de estabelecida a associação. É uma mudança de contrato de duas linhas.

**12. O que precisa ser validado.**
- Verificar se algum fluxo do cliente precisa de `memberCount` antes de ser membro (o preview de
  convite tem caminho próprio, `inviteResolve`, então provavelmente não).

---

## T-39 — A redação obrigatória de log não cobre todo o conteúdo gerado por usuário

**Severidade:** MEDIUM · **Probabilidade:** Média · **STRIDE:** I

**1. Ativo afetado.** Conteúdo sensível em `logs/*.ndjson`, que fica 7 dias em disco em claro.

**2. Ator.** `A-FS`, `A-LOCAL`.

**3. Pré-condições.**
- §17.2, lista do que **nunca** aparece: `content`, nome de anexo, tópico de canal, segredo/código
  de convite, chave privada, payload de mídia.
- Não constam: `reason` de moderação (≤ 200 grafemas de **texto livre**, §4.12), `nickname`,
  `displayName`, `Role.name`, `Category.name`, `Channel.name`, `targetLabel` do log de auditoria.
- §17.2 é explícito e correto no método: *"allowlist de campos, não blocklist — blocklist esquece o
  campo novo"*.

**4. Ataque.** O log de diagnóstico acumula o motivo textual de cada punição, os nomes das pessoas e
a estrutura das comunidades. Enviado ao suporte, sincronizado na nuvem ou lido por outro processo,
vaza exatamente o tipo de informação que o produto se propõe a proteger.

**5. Vulnerabilidade / premissa explorada.** A allowlist é o mecanismo certo; a **lista** foi
montada pensando em segredo criptográfico e conteúdo de mensagem, e deixou de fora o conteúdo livre
que existe nos outros campos.

**6. Impacto.** Vazamento de conteúdo sensível de segunda ordem, com retenção de 7 dias e teto de
200 MiB.

**7. Probabilidade.** Média.

**8. Severidade.** MEDIUM.

**9. Mitigação existente na spec.** A allowlist (§17.2) e o nível `debug` desligado em produção.

**10. Resolve ou só reduz?** O método resolve **se** a lista estiver certa. Basta corrigir a lista.

**11. Compatibilidade.** Inverter a leitura: a allowlist de §17.2 enumera **campos permitidos**
(ids, chaves truncadas, `seq`, `opId`, tamanhos, contagens, códigos, durações) e todo o resto é
redigido por default. É o que o parágrafo já diz querer.

**12. O que precisa ser validado.**
- Auditar cada `logger.child(scope)` do código quando existir, comparando com a allowlist.
- Definir se `reason` pode aparecer sob `trace` (recomendo que não).

---

## T-40 — A moderação de voz é conselho, não enforcement

**Severidade:** MEDIUM · **Probabilidade:** Média · **STRIDE:** E

**1. Ativo afetado.** `voice_mute_others`, mudo, ensurdecer, câmera.

**2. Ator.** `A-MEMBRO` com cliente adulterado.

**3. Pré-condições.**
- §10.2: `voice.muteParticipant{identityKey, muted}` exige `voice_mute_others` — verificado no
  host.
- §11.16 passo 3+: depois da entrada, *"a mídia é ponta a ponta e **o host não vê nada**"*.
- §4.16: `VoiceRoster` é efêmero, com `muted`, `deafened`, `cameraOn` — **estado declarado**, não
  aplicado.

**4. Ataque.** Mallory é silenciada por um moderador. O host atualiza o roster. Como o áudio vai
direto de Mallory para cada par por `RTCPeerConnection`, o silenciamento depende de **cada cliente
receptor** honrar o roster. O cliente de Mallory continua enviando; qualquer receptor com cliente
adulterado continua ouvindo; e Mallory pode simplesmente continuar transmitindo para os que ainda
não aplicaram. O mesmo vale para `cameraOn` e para o limite de 6 câmeras (`E_CAMERA_LIMIT`).

**5. Vulnerabilidade / premissa explorada.** Consequência direta e correta da ADR-05 (mídia ponta a
ponta, host não vê). A arquitetura escolheu privacidade sobre controle; o custo é que **não existe
ponto onde a moderação de mídia possa ser imposta**.

**6. Impacto.** Uma permissão do catálogo é cosmética contra o adversário que importa. É a mesma
categoria de §8.5 ("a UI esconder nunca é enforcement"), aplicada a um lugar onde a spec não a
aplicou.

**7. Probabilidade.** Média.

**8. Severidade.** MEDIUM — o remédio real (expulsar da chamada, banir) existe e funciona no host.

**9. Mitigação existente na spec.** O host controla o **roster**, e remover do roster é aplicável.

**10. Resolve ou só reduz?** Remover do roster é enforcement de verdade — desde que os clientes
derrubem as conexões (T-32). Silenciar não é.

**11. Compatibilidade.** Declarar em §18.1 e em §25 que a moderação de mídia é aplicada por
cooperação dos clientes, e que a ação com efeito garantido é remover do canal. Nenhuma mudança de
arquitetura é proponível aqui sem quebrar a ADR-05.

**12. O que precisa ser validado.**
- Confirmar que a spec de UX não promete "silenciado para todos" de forma absoluta.
- Definir se `voice.muteParticipant` também remove do roster após N reincidências.

---

## T-41 — A captura de tela começa antes da autorização do host, e não há requisito de indicador local

**Severidade:** MEDIUM · **Probabilidade:** Baixa-Média · **STRIDE:** I

**1. Ativo afetado.** A tela do usuário.

**2. Ator.** `A-RENDER`; secundariamente erro de UI.

**3. Pré-condições.**
- §11.17, sequência: **passo 1** o renderer captura com `getDisplayMedia` e codifica; **passo 2**
  `shareStart` ao host, que valida `voice_share_screen`. A autorização vem depois da captura.
- §2.1: `setDisplayMediaRequestHandler` fica no main. Handlers desse tipo podem conceder sem
  diálogo do sistema, dependendo da implementação — e a spec não especifica qual.
- Nenhum requisito, em documento nenhum, de indicador persistente de "você está compartilhando" no
  nível do app (a UI tem a barra de chamada, mas ela é estado de UI, não garantia).

**4. Ataque.** Um renderer comprometido aciona `getDisplayMedia` pelo handler do main e captura,
sem `share.start` e sem chamada. Se o handler concede automaticamente (padrão comum para evitar o
seletor duplo), não há diálogo do SO. A saída dos bytes usa T-16 ou o próprio `mediaBridge`.

**5. Vulnerabilidade / premissa explorada.** A ordem "capturar depois autorizar" é natural para UX
(o seletor de janela precede tudo) e coloca a operação mais sensível do produto antes de qualquer
verificação.

**6. Impacto.** Captura silenciosa de tela.

**7. Probabilidade.** Baixa-Média.

**8. Severidade.** MEDIUM.

**9. Mitigação existente na spec.** O handler no main (que é o lugar certo); a permissão
`voice_share_screen` no host; o indicador de compartilhamento do SO em algumas plataformas.

**10. Resolve ou só reduz?** A permissão do host controla **a publicação**, não a captura. O
indicador do SO existe em algumas plataformas e não é garantia do produto.

**11. Compatibilidade.** O main consulta o núcleo (`voice_share_screen` na comunidade da chamada
ativa) **antes** de conceder `getDisplayMedia` — o canal privilegiado de §2.2 já existe para
exatamente esse tipo de pergunta ("quantas pessoas caem se a janela fechar" é do mesmo tipo). E
indicador persistente obrigatório na UI enquanto houver captura ativa.

**12. O que precisa ser validado.**
- Especificar o comportamento do `setDisplayMediaRequestHandler` (hoje não está especificado).
- Verificar em quais das três plataformas há indicador do SO.

---

## T-42 — Não existe canal de atualização especificado: não há como distribuir correção de segurança

**Severidade:** MEDIUM · **Probabilidade:** Alta · **STRIDE:** —

**1. Ativo afetado.** A capacidade de corrigir **qualquer** ameaça deste documento depois do
lançamento.

**2. Ator.** Nenhum, e é esse o problema: é uma ausência de capacidade, não um ataque.

**3. Pré-condições.**
- §22.4: *"Não existem, e não devem ser introduzidos: … nenhum serviço de update automático que
  fale com host próprio."*
- §23 (fases 0 a 8) não inclui empacotamento assinado, canal de distribuição nem atualização.
  DR-02 já registrou a ausência de especificação de build e empacotamento.
- §10.6: `hello` negocia `opVersion` e clientes antigos continuam funcionando — por desenho.
- §18.5 regra 2 é o único controle de cadeia de suprimentos: versões travadas e `package-lock`
  commitado. Não há exigência de build assinado, build reprodutível ou SBOM.

**4. Cenário.** Uma correção crítica (por exemplo, T-05 ou T-17) fica pronta. Não há mecanismo para
alcançar os usuários instalados. Versões vulneráveis permanecem em campo indefinidamente, e a
negociação de versão foi desenhada para tolerá-las. Em produto P2P isso é pior que em produto
centralizado: um cliente antigo não é só um usuário em risco, é **um participante do protocolo**
que os outros precisam continuar aceitando.

**5. Vulnerabilidade / premissa explorada.** A recusa de infraestrutura de terceiro (correta como
princípio de produto) foi aplicada a um item que não é telemetria nem push, e ficou sem substituto.

**6. Impacto.** Todo achado deste laudo tem meia-vida infinita no campo.

**7. Probabilidade.** Alta — é certeza, não risco.

**8. Severidade.** MEDIUM neste laudo apenas porque não é explorável diretamente; como **risco de
programa** é o item mais importante depois dos CRITICAL.

**9. Mitigação existente na spec.** Nenhuma.

**10. Resolve ou só reduz?** —

**11. Compatibilidade.** §22.4 proíbe *"serviço de update que fale com host próprio"*. Distribuição
por releases assinados de um repositório público, verificados por assinatura de código, com
notificação in-app (sem servidor próprio, sem telemetria, sem coleta) é compatível com a letra e
com o espírito da restrição, e precisa virar ADR — como o próprio §22.4 exige para qualquer
introdução.

**12. O que precisa ser validado.**
- Decidir o canal de distribuição antes da fase 1 (é decisão de produto, não de implementação).
- Definir política de versão mínima aceita por `hello` — hoje aceitar clientes antigos é decisão
  implícita e permanente.

---

## T-43 — Não há recuperação de comprometimento nem sucessão de host, e a destruição está a um quadro de IPC

**Severidade:** MEDIUM · **Probabilidade:** Média · **STRIDE:** —

**1. Ativo afetado.** Continuidade da identidade e da comunidade.

**2. Ator.** Consequência de T-03, T-10, T-19, T-20; e falha de hardware.

**3. Pré-condições.**
- §7: sem sessão, sem token, sem expiração, sem revogação.
- §4.2: `hostKey` *"Constante para sempre: sem transferência de host (premissa 3)"*.
- §4.1: `identity.wipe` é *"irreversível e sem confirmação no backend"*; §11.22: *"Nada é enviado à
  rede: as comunidades hospedadas simplesmente somem para todos"*.
- §26.2, A-5: disponibilidade com host offline continua aberta; `blind-peering` não foi escolhido.

**4. Cenário.** Quatro desfechos sem caminho de volta: (a) chave privada comprometida → sem
revogação, o atacante é a pessoa para sempre; (b) chave privada perdida → a pessoa é alguém novo em
todas as comunidades, sem export/import (premissa 3); (c) máquina do host perdida → a comunidade
fica permanentemente sem escritor, com as réplicas em leitura, e não há sucessão; (d) um
`identity.wipe` acidental ou induzido → tudo isso de uma vez, sem confirmação do lado que guarda o
dado.

**5. Vulnerabilidade / premissa explorada.** Várias premissas legítimas (sem conta, sem
multi-dispositivo, sem transferência de host) somam-se a uma propriedade que nenhuma delas exige:
**ausência de qualquer plano de recuperação**.

**6. Impacto.** O produto tem modos de falha permanentes que o usuário não vê chegando.

**7. Probabilidade.** Média — perda de máquina é evento comum.

**8. Severidade.** MEDIUM neste laudo (não é ataque), CRITICAL como risco de produto.

**9. Mitigação existente na spec.** §26.2 A-4 e A-5 reconhecem os itens como abertos, e
`keet-identity-key` é citado como caminho pós-v1 — o problema está mapeado, não resolvido.

**10. Resolve ou só reduz?** Reconhecer não mitiga.

**11. Compatibilidade.** Sem contradizer premissa 3: (a) exportar a chave cifrada para backup
manual do usuário é *backup*, não multi-dispositivo, e é a diferença entre perder o notebook e
perder a identidade; (b) confirmação de `identity.wipe` pelo main (T-20); (c) declarar em §25 e na
UI que a comunidade morre com a máquina do host — a UI hoje mostra "Inativa há muito tempo"
(`COM-10`) para o que pode ser um estado permanente.

**12. O que precisa ser validado.**
- Decidir se export de chave para backup entra no v1. É decisão de produto.
- Verificar se a UI distingue "host offline" de "host nunca mais volta". Pela leitura, não
  distingue.

---

## T-44 — As queries de leitura não têm enforcement de permissão, e `view_audit_log` é inaplicável por construção

**Severidade:** MEDIUM · **Probabilidade:** Alta · **STRIDE:** I

**1. Ativo afetado.** A permissão `view_audit_log` e a expectativa de confidencialidade
intracomunidade.

**2. Ator.** `A-MEMBRO`.

**3. Pré-condições.**
- §8.1: `view_audit_log` autoriza *"Ler `moderation_log`, `bans`, `timeouts`"*.
- §10.4: **nenhuma** query tem coluna de permissão. DR-25 já registrou a ausência de ponto de
  aplicação.
- §6.2: o log replica **integral** para todo membro; §4.13: o log de auditoria é **projeção** do
  log. Logo, o dado está na máquina de todo mundo, derivável por qualquer um.

**4. Ataque.** Um membro sem `view_audit_log` lê `moderation_log` pela query (nada o impede) ou,
se a query for corrigida, projeta o core por conta própria (nada pode impedir). O mesmo raciocínio
vale para qualquer confidencialidade **dentro** da comunidade: não existe canal privado, e não
poderia existir sem múltiplas chaves.

**5. Vulnerabilidade / premissa explorada.** Uma permissão de **leitura** num sistema em que todo
membro tem o dado bruto. É uma classe diferente das outras 16, que são todas de escrita e
aplicáveis no host.

**6. Impacto.** Baixo em dano direto (o log de auditoria não é segredo grave), alto em clareza do
modelo: se `view_audit_log` é apresentada como permissão e não é aplicável, todo o catálogo perde
credibilidade.

**7. Probabilidade.** Alta.

**8. Severidade.** MEDIUM.

**9. Mitigação existente na spec.** §8.5 já ensina que a UI não é enforcement — o que aqui é a
confissão de que essa permissão só existe na UI.

**10. Resolve ou só reduz?** —

**11. Compatibilidade.** Declarar `view_audit_log` como **preferência de interface**, não como
controle de acesso, e escrever em §8.1 que o modelo de permissões é **exclusivamente de escrita** —
todo membro lê tudo o que a comunidade replica. Esse é um item de §25 e de honestidade (princípio 3).
Aplicar a permissão na query é higiene e deve ser feito, mas não é segurança.

**12. O que precisa ser validado.**
- Confirmar que nenhuma query de §10.4 filtra por permissão (verifiquei: nenhuma tem a coluna).
- Verificar se a UX promete privacidade de log de moderação em algum ponto.

---

## T-45 — O timeout é avaliado com o relógio de quem lê

**Severidade:** MEDIUM · **Probabilidade:** Média · **STRIDE:** T

**1. Ativo afetado.** Consistência do estado de moderação entre réplicas.

**2. Ator.** `A-MEMBRO`, `A-LOCAL`.

**3. Pré-condições.**
- §4.12: *"Timeout expira **sozinho**, sem op: a projeção compara `until` com `now` na leitura."*
  A justificativa é boa (evita divergência por job que rodou num lugar e não no outro) e troca um
  problema por outro.
- §11.12: *"A contagem regressiva da UI é local."*
- §9.1 estágio 8: o **host** aplica com o relógio dele.

**4. Ataque / falha.** Cada réplica calcula `silenced` com o próprio relógio. Uma máquina com
relógio adiantado mostra a pessoa liberada antes; atrasado, mostra silenciada depois. O enforcement
real (o host) segue o relógio do host, então a divergência é só de exibição — mas é exibição de
estado de moderação, que é onde a confiança na moderação se forma. E `A-LOCAL` mudando o relógio
altera o que **ele** vê, o que é irrelevante, mas também altera `E_CLOCK_UNREASONABLE` no envio
(estágio 6), que é relevante para T-05.

**5. Vulnerabilidade / premissa explorada.** Substituir estado por cálculo é bom para convergência
e ruim quando o insumo do cálculo é local e não confiável.

**6. Impacto.** Divergência visível de estado de moderação; nenhuma escalada.

**7. Probabilidade.** Média (relógio errado é comum).

**8. Severidade.** MEDIUM.

**9. Mitigação existente na spec.** `timeout.notify` a cada minuto (§13.2) reconcilia a exibição; o
enforcement está no host.

**10. Resolve ou só reduz?** Reduz a janela de divergência a ~1 min mais o erro do relógio local.

**11. Compatibilidade.** Usar o `hostTs` do registro mais recente conhecido como referência de
"agora" para exibição, em vez do relógio local — mas isso depende de T-27 (o host controla
`hostTs`). Alternativa: exibir o instante absoluto em vez da contagem regressiva quando os relógios
divergirem.

**12. O que precisa ser validado.**
- Medir a divergência típica de relógio na base instalada — ou simplesmente aceitar e documentar.
- Cruzar com DS-29 (host com relógio errado rejeita toda escrita), que é o mesmo insumo com
  consequência maior.

---

# LOW

---

## T-46 — O deep link `comunidadep2p://` é um canal de comando não autenticado vindo do SO e da web

**Severidade:** LOW · **Probabilidade:** Baixa · **STRIDE:** S

**1. Ativo afetado.** As rotas expostas pelo protocolo customizado.

**2. Ator.** Qualquer página web; qualquer aplicativo local.

**3. Pré-condições.**
- §2.1: o main trata *"deep links `comunidadep2p://`"*. `frontend.md` §4: as duas rotas
  compartilháveis *"ganhariam depois um protocolo customizado (`comunidadep2p://invite/…`,
  `comunidadep2p://m/…`) alimentando o `MemoryRouter`"*.
- DR-04 já registrou a colisão entre deep link e instância única.
- Registrar um esquema no SO significa que **qualquer** navegação (incluindo de uma página web
  hostil) entrega uma string ao app.

**4. Ataque.** Hoje o alcance é pequeno: uma página faz o app abrir um preview de convite ou uma
mensagem. O risco é de **crescimento**: assim que o roteador aceitar mais do que duas rotas de
leitura, ele vira uma superfície de comando remoto sem autenticação. E a entrada é uma string
controlada pelo atacante, que precisa ser parseada — e DR-34 registra que o parsing de código e
link **não tem regra definida**.

**5. Vulnerabilidade / premissa explorada.** Um handler de protocolo é uma porta de entrada com as
mesmas características de um endpoint HTTP, num produto que se define por não ter nenhum.

**6. Impacto.** Hoje baixo. Depende inteiramente de o roteador permanecer restrito.

**7. Probabilidade.** Baixa.

**8. Severidade.** LOW.

**9. Mitigação existente na spec.** As rotas são só duas, ambas de leitura; nenhuma escreve.

**10. Resolve ou só reduz?** A restrição atual **resolve** enquanto for mantida. É uma propriedade
frágil por depender de disciplina futura.

**11. Compatibilidade.** Escrever a regra: o handler de deep link aceita **exclusivamente**
`invite` e `m`, nunca dispara comando de escrita, e todo input passa por parsing estrito com
rejeição (DR-34).

**12. O que precisa ser validado.**
- Fechar DR-34 e DR-04.
- Testar o comportamento com URL malformada, muito longa e com caracteres de controle.

---

## T-47 — `projector.badSignature` é declarado alarme de segurança e não tem resposta; não há pontuação de peers

**Severidade:** LOW · **Probabilidade:** Média · **STRIDE:** —

**1. Ativo afetado.** Detecção e resposta a abuso.

**2. Ator.** —

**3. Pré-condições.**
- §17.3: `projector.badSignature` — *"**> 0 é alarme de segurança**"*.
- §17.4 define saúde por `projector.lag`, alcance do host e profundidade da outbox. `badSignature`
  não entra.
- Não há evento IPC para ele (§10.3), não há superfície de UI, e nada acontece automaticamente.
- Nenhum mecanismo pontua peers por comportamento (malformado, assinatura ruim, flood). A única
  resposta a abuso é o ban, que é manual e derrotado por T-07.

**4. Cenário.** Um host adversário ou um peer defeituoso produz registros com assinatura inválida.
A métrica sobe. Ninguém vê. A projeção segue (corretamente — §6.4 manda ignorar e continuar), e o
sinal mais forte de ataque que o sistema produz morre num contador em memória que
*"não persiste; métrica é do processo corrente"* (§3.2).

**5. Vulnerabilidade / premissa explorada.** Instrumentação sem resposta. A spec identificou o
indicador certo e parou aí.

**6. Impacto.** Ataques ficam invisíveis mesmo quando o sistema já os detectou.

**7. Probabilidade.** Média.

**8. Severidade.** LOW isoladamente — vira multiplicador de tudo o mais.

**9. Mitigação existente na spec.** A métrica existe e `diag.snapshot` a expõe.

**10. Resolve ou só reduz?** Detectar sem sinalizar não reduz risco.

**11. Compatibilidade.** Evento IPC (`security.anomaly`) e estado visível quando `badSignature`,
`E_AUTHOR_MISMATCH` ou `E_MALFORMED` passarem de um limiar; e pontuação simples de peer no host,
com desconexão por reincidência — que também ajuda T-08 e T-28.

**12. O que precisa ser validado.**
- Definir limiares por métrica.
- Decidir se a métrica persiste (hoje §3.2 proíbe, e para um indicador de segurança isso é
  discutível).

---

## T-48 — `kind` de anexo vem da extensão, e a renderização inline é superfície de decodificador

**Severidade:** LOW · **Probabilidade:** Média · **STRIDE:** E · D

**1. Ativo afetado.** O renderer de quem visualiza anexos.

**2. Ator.** `A-MEMBRO`.

**3. Pré-condições.**
- §11.13: *"`kind` inferido da extensão, com `other` como default"*. DR-41: o mapa não existe.
- §4.10: `kind` inclui `image`, e a UI tem aba de arquivos com prévia.
- Não há regra sobre quais tipos são renderizados inline nem sobre SVG.

**4. Ataque.** Mallory anexa um arquivo com extensão `.png` cujo conteúdo é malformado, e o
renderer o passa ao decodificador de imagem do Chromium. Se `image` incluir `.svg` e a renderização
for inline em vez de `<img>`, o SVG traz script e a CSP passa a ser a única barreira.

**5. Vulnerabilidade / premissa explorada.** Confiar na extensão para decidir o tratamento de bytes
controlados por terceiro.

**6. Impacto.** Travamento do renderer; num cenário ruim, execução dentro do sandbox.

**7. Probabilidade.** Média para o DoS, baixa para o resto.

**8. Severidade.** LOW — o sandbox e a CSP contêm bem, e o Chromium é a defesa mais testada do
conjunto.

**9. Mitigação existente na spec.** `sandbox: true`, CSP sem `unsafe-inline` e sem host externo,
verificação de hash (integridade, não inocuidade).

**10. Resolve ou só reduz?** Contém o dano; não impede a entrega ao parser.

**11. Compatibilidade.** Fechar o mapa extensão→`kind` (DR-41) com allowlist, nunca renderizar SVG
inline, verificar o tipo real pelos primeiros bytes antes de decidir a prévia.

**12. O que precisa ser validado.**
- Fechar DR-41.
- Verificar como a UI já renderiza prévia de imagem hoje (o frontend está implementado).

---
# Consolidação

---

## Critical Threats

| ID | Ameaça | Ator | Ativo | Por que é crítica |
|---|---|---|---|---|
| **T-01** | A `Op` não carrega `communityId`: assinatura genuína é válida em toda comunidade | `A-HOST` | Autoria, log de auditoria | Derruba a afirmação de §18.1 de que o host não pode forjar autoria — ele não forja, transplanta |
| **T-02** | A réplica só reverifica assinatura; permissão, hierarquia e associação existem apenas no host | `A-HOST` | Modelo de autorização inteiro | Todo estado de uma comunidade com host comprometido é uma afirmação do atacante, com assinaturas válidas |
| **T-03** | A chave de escrita do core fica em disco sem a proteção da ADR-19 | `A-FS` | A comunidade inteira | Tomada de controle a partir de leitura de pasta, sem tocar `safeStorage`, sem recuperação (host imutável) |
| **T-04** | `coreKey` é id + tópico + capacidade de leitura perpétua, e vaza por "copiar link da mensagem" | `A-BANIDO`, `A-PEER` | Todo o histórico | Ban e saída não retiram acesso de leitura; §18.1 afirma o contrário; sem rotação, o vazamento é definitivo |
| **T-05** | Replay do próprio envelope após a janela de dedupe → colisão de PK → projeção parada para sempre | `A-MEMBRO` | Disponibilidade de todas as réplicas | DoS remoto, permanente, irreversível, simultâneo em todos os dispositivos, ao custo de uma mensagem |
| **T-06** | A prova de convite não é vinculada ao host nem ao candidato | `A-MEMBRO`, `A-PEER` | Controle de entrada | Retransmissão rouba o convite; nenhuma das defesas existentes (força bruta) toca o ataque |
| **T-07** | Identidade gratuita + `inviteRedeem` fora do rate limit + `maxUses` opcional | `A-SYBIL`, `A-BANIDO` | Roster, log, host | Entrada em massa automatizada com dano permanente e assimetria total contra o moderador |
| **T-08** | Ed25519 antes do rate limit e do teste de associação, com 128 conexões para 50 comunidades | `A-PEER`, `A-DOS` | Disponibilidade de escrita | DoS total e barato, que também impede a resposta ao próprio DoS |
| **T-09** | Nenhuma cota por autor sobre dado permanente replicado integralmente | `A-MEMBRO` | Disco de todos | Consumo permanente e irreversível em 340 dispositivos, sem poda e sem cota |
| **T-10** | `safeStorage` não protege contra o adversário que §18.1 diz proteger; não há revogação | `A-LOCAL` | A identidade | Personificação permanente e indetectável, sem qualquer caminho de recuperação |

**Encadeamentos que agravam.** T-04 alimenta T-08 e T-38 (qualquer um com a chave conecta).
T-07 alimenta T-09, T-13 e T-28 (Sybil multiplica todos os limites por autor). T-01 e T-02 se
somam: sem vínculo de comunidade **e** sem revalidação, o host tem liberdade quase total. T-05 e
T-30 chegam ao mesmo estado terminal por caminhos independentes, o que significa que a correção de
um não fecha o outro. T-10 e T-03 têm o mesmo pré-requisito de acesso — quem tem um tem os dois.

---

## High Threats

| ID | Ameaça | Ator | Categoria |
|---|---|---|---|
| T-11 | Repassador da árvore vê e pode substituir o conteúdo da tela | `A-MEMBRO` | Confidencialidade, spoofing |
| T-12 | `codecConfig` e chunks hostis alimentam o decodificador do renderer | `A-MSG` | Superfície de memória |
| T-13 | `canRelay`/`uplinkKbps` auto-declarados definem a posição na árvore | `A-SYBIL` | Posicionamento adversarial |
| T-14 | `relay.volunteer` sem prova de posse da `relayKey` | `A-MEMBRO` | Reflexão, análise de tráfego |
| T-15 | Sinalização WebRTC sem autorização de sessão | `A-PEER`, `A-BANIDO` | Exposição de IP, parser |
| T-16 | `blob.stage(path)` sem prova de origem do caminho | `A-RENDER` | Exfiltração |
| T-17 | Anexo entregue a `shell.openPath` sem allowlist nem quarentena | `A-MEMBRO` | Execução de código |
| T-18 | Markdown sem allowlist de esquema de URL | `A-MEMBRO` | Execução, vazamento de credencial |
| T-19 | Portão `dev.*` por `NODE_ENV` falha aberto | `A-LOCAL` | Destruição de dados |
| T-20 | IPC onipotente sobre renderer declaradamente não confiável | `A-RENDER` | Escalada |
| T-21 | Chave privada atravessa main↔núcleo contra §7; cópias não zeráveis | `A-LOCAL` | Exposição de segredo |
| T-22 | Configuração sem integridade: eclipse por bootstrap, IP por STUN | `A-FS` | Eclipse, privacidade |
| T-23 | Convite sobrevive ao rebaixamento, ao kick e ao ban do emissor | `A-BANIDO` | Porta dos fundos |
| T-24 | IP de todos os membros é coletável; `invisible` não é invisível | `A-META` | Metadados |
| T-25 | Firewall único por processo atravessa comunidades e vira oráculo | `A-BANIDO` | Isolamento |
| T-26 | Retroagir o carimbo em até 7 dias é aceito e exibido como verdade | `A-MEMBRO` | Repúdio |
| T-27 | `hostTs` e `flags` fora da assinatura | `A-HOST` | Repúdio, adulteração |
| T-28 | Canais efêmeros sem rate limit, com fan-out 1→N no host | `A-MEMBRO` | DoS |
| T-29 | Handle de 30 bits, nomes livres, apelido sem override | `A-MEMBRO` | Personificação |
| T-30 | Ids de 48 bits em espaço global num `view.db` único | `A-MEMBRO` | Isolamento, DoS |
| T-31 | `mention_everyone` e `mentionable` sem ponto de aplicação | `A-MEMBRO` | Abuso, permissão vazia |
| T-32 | Mídia direta sobrevive ao ban; timeout não alcança a voz | `A-BANIDO` | Enforcement |
| T-33 | Host controla `retryAfterMs` e `opVersion` | `A-HOST` | Censura silenciosa |
| T-34 | Sem teto de quadro RPC antes da decodificação | `A-DOS` | Exaustão de memória |
| T-35 | Anti-escalada não cobre o cargo base, que é universal e automático | `A-MEMBRO` | Escalada em massa |

---

## Medium / Low Threats

| ID | Sev. | Ameaça | Resumo |
|---|---|---|---|
| T-36 | MEDIUM | Nada cifrado em disco além da chave; `local_*` adulteráveis e nunca reconstruídas | Confidencialidade total do histórico com acesso ao disco; adulteração permanente de dedupe e consentimento |
| T-37 | MEDIUM | Sanitização de nome de anexo remove em vez de rejeitar | Bypass clássico; sem cobertura de peculiaridades do Windows; o prefixo `blobIdHex` é o que segura |
| T-38 | MEDIUM | `hello` responde estatísticas a não-membro | Vazamento contínuo de `memberCount` e `coreLength` a quem só tem a chave |
| T-39 | MEDIUM | Allowlist de redação de log não cobre `reason`, nomes e rótulos | Conteúdo sensível em claro por 7 dias |
| T-40 | MEDIUM | Moderação de voz é cooperativa, não aplicada | Silenciar depende do cliente do outro lado; remover do roster é a única ação real |
| T-41 | MEDIUM | Captura de tela antes da autorização, sem indicador obrigatório | Captura silenciosa a partir de comprometimento do renderer |
| T-42 | MEDIUM | Nenhum canal de atualização especificado | Nenhuma correção deste laudo alcança quem já instalou |
| T-43 | MEDIUM | Sem recuperação de comprometimento, sem sucessão de host, `wipe` a um quadro de distância | Quatro modos de falha permanentes sem aviso ao usuário |
| T-44 | MEDIUM | `query.*` sem enforcement; `view_audit_log` inaplicável por construção | Permissão de leitura num sistema onde todo membro tem o dado bruto |
| T-45 | MEDIUM | Timeout avaliado com o relógio do leitor | Divergência de exibição do estado de moderação |
| T-46 | LOW | Deep link como canal de comando do SO e da web | Contido hoje por só haver duas rotas de leitura; frágil por depender de disciplina |
| T-47 | LOW | `projector.badSignature` é "alarme" sem resposta; sem pontuação de peers | O sistema detecta ataque e não conta a ninguém |
| T-48 | LOW | `kind` de anexo pela extensão; renderização inline | Superfície de decodificador, contida pelo sandbox |

---

## Trust Boundary Problems

**TBP-1 — A fronteira renderer↔núcleo é declarada e não é aplicada.** §18.5 configura o renderer
como não confiável (`sandbox`, `contextIsolation`, CSP) e §10.2 lhe dá um canal sem autorização
para `identity.wipe`, `blob.stage(path)` e `dev.*`. Sandbox que protege tudo menos o que importa é
teatro de defesa em profundidade. **T-16, T-19, T-20, T-41.**

**TBP-2 — A fronteira main↔núcleo carrega o segredo que §7 diz que ela não carrega.** A arquitetura
exige que a chave privada atravesse; o documento afirma que ela nunca atravessa; e a regra de
higiene (`buf.fill(0)`) cobre uma das três cópias. **T-21.**

**TBP-3 — O disco não é uma fronteira, é um espaço aberto com um cofre dentro.** `identity.enc`
está protegido; a chave de escrita do core, a projeção inteira, os anexos, os logs, o
`config.json` e as tabelas `local_*` não estão. O ativo de maior valor num sistema de escritor
único (a chave do core) está do lado de fora do cofre. **T-03, T-22, T-36.**

**TBP-4 — A fronteira membro↔host é a única defendida, e ela é defendida na ordem errada.** Os 12
estágios são completos e bem pensados; rodam depois do custo dominante e apenas em um dos lados.
Um adversário que consegue conectar já venceu o orçamento do host antes de o pipeline ter decidido
se ele é membro. **T-08, T-34.**

**TBP-5 — A fronteira membro↔membro não é modelada em lugar nenhum.** §18.1 tem sete linhas e
nenhuma delas é "outro membro falando diretamente comigo". E é por ali que passam: replicação sem
firewall (o banido continua lendo), sinalização WebRTC sem autorização, mídia sem autenticidade e
a árvore de repasse. É a fronteira com mais superfície e menos texto normativo. **T-04, T-11,
T-12, T-15, T-32, DR-30.**

**TBP-6 — O relay é "cego" em um uso e não no outro, e a spec trata os dois com a mesma palavra.**
ADR-08 estabelece corretamente que o blind relay não lê UDX cifrado; §10.8 usa a mesma noção de
"repassar sem abrir" para a árvore de tela, onde não há cifra de aplicação e o repassador recebe
exatamente o que um espectador recebe. Duas garantias muito diferentes com o mesmo nome. **T-11,
T-14.**

**TBP-7 — Não existe fronteira entre comunidades dentro do dispositivo.** Um processo, um swarm,
um firewall, um `view.db`, um espaço global de ids de 48 bits, uma tabela de dedupe sem
`community_id`, um teto de 128 conexões compartilhado. O isolamento é uma **convenção de coluna**
sobre recursos globais. Consequências verificadas: ban em A afeta conexão para B (T-25), colisão
de id em A para a projeção de B (T-30), transplante de op de A para B (T-01), supressão de op de B
por dedupe de A (T-36, DS-20). **Esta é a fronteira mais violada do sistema e a que o documento
menos reconhece.**

**TBP-8 — O host está dentro da fronteira para tudo, exceto para a assinatura.** A spec desenhou
uma exceção precisa e correta (autoria) e não percebeu que autorização, ordenação, carimbo,
supressão e negociação de versão ficaram todos do lado de dentro. O resultado é que "host
malicioso" tem, na prática, poder quase total sobre o estado — e a tabela de §18.1 promete o
oposto. **T-01, T-02, T-27, T-33.**

**TBP-9 — A fronteira app↔SO é atravessada sem mediação de confiança.** `shell.openPath` entrega
arquivo de terceiro ao handler default; `getDisplayMedia` é concedido antes de qualquer
autorização; o handler de protocolo aceita entrada de qualquer página. **T-17, T-41, T-46.**

**TBP-10 — O DHT é infraestrutura de terceiro tratada como detalhe de transporte.** §22.1 a declara
"ponto de centralização de fato" no eixo de disponibilidade e não no de privacidade. É por ela que
o endereço de rede de todo participante fica correlacionável à sua identidade e à sua lista de
comunidades. **T-22, T-24.**

---

## Missing Security Guarantees

Propriedades que o produto **não** oferece e que, na maioria dos casos, o documento não declara não
oferecer. As marcadas com ⚠ contradizem uma afirmação explícita da spec.

| # | Garantia ausente | Onde deveria estar declarada |
|---|---|---|
| MG-1 ⚠ | **Revogação de acesso de leitura.** Sair ou ser banido não retira acesso ao histórico nem ao que for appendado depois. §18.1 afirma que o banido "não consegue ler dado novo". | §18.1, §25, UI de banimento |
| MG-2 ⚠ | **Vínculo da assinatura ao contexto.** Uma op assinada vale em qualquer comunidade e em qualquer posição do log. §18.1 afirma que o host "não consegue forjar autoria". | §5.1, §18.1 |
| MG-3 | **Revalidação de autorização na réplica.** Só a assinatura é reverificada; nada de permissão, hierarquia, associação ou limite. | §7, §6.4 |
| MG-4 ⚠ | **Confidencialidade da chave contra processo local.** `safeStorage` não entrega isso em DPAPI/libsecret. §18.1 afirma que entrega. | §18.1, §22.2 |
| MG-5 | **Rotação e revogação de identidade.** Não existem. Comprometimento é permanente e a vítima não tem ato disponível. | §7, §25 |
| MG-6 | **Recuperação de identidade e sucessão de host.** Perder a máquina é perder a identidade e matar a comunidade hospedada. | §7, §4.2, §25 |
| MG-7 | **Proteção do segredo de escrita da comunidade.** A ADR-19 cobre a identidade e não a chave do core. | ADR-19, §6.1 |
| MG-8 | **Custo de admissão / resistência a Sybil.** Identidade é gratuita e o resgate de convite não tem limite. | §19.3, §4.11 |
| MG-9 | **Cota de armazenamento por autor.** O rate limit conta ops, não bytes, sobre dado permanente e replicado integralmente. | §19.2, §19.3 |
| MG-10 | **Autenticidade e confidencialidade da mídia de tela ponta a ponta.** Só há cifra salto a salto; o repassador é destinatário legítimo de cada salto. | §10.8, ADR-05 |
| MG-11 | **Autorização de sinalização e de conexão entre pares.** Ter a chave equivale a poder falar. | §10.7 |
| MG-12 | **Integridade e autenticidade da anotação do host** (`hostTs`, `flags`). Fora da assinatura, sem verificação possível. | §5.1 |
| MG-13 | **Isolamento entre comunidades no dispositivo.** Ids, banco, swarm, firewall e dedupe são globais. | §6.1, §6.3, §8.5 |
| MG-14 | **Confidencialidade em repouso.** Só a chave é cifrada; todo o conteúdo está em claro. | §6.1, §18.1 |
| MG-15 | **Confidencialidade intracomunidade.** Todo membro replica tudo; permissões são exclusivamente de escrita, e `view_audit_log` não é aplicável. | §8.1, §8.2 |
| MG-16 | **Anonimato / proteção de metadados de rede.** Endereço, presença e lista de comunidades são observáveis. `invisible` só oculta a publicação de aplicação. | §18.1, §4.16, §25 |
| MG-17 | **Canal de atualização e integridade de build.** Não há distribuição de correção, assinatura de código, build reprodutível nem SBOM. | §22.4, §23, §18.5 |
| MG-18 | **Detecção e resposta a abuso.** Existe uma métrica declarada "alarme de segurança", sem evento, sem UI e sem pontuação de peers. | §17.3, §17.4 |
| MG-19 | **Resiliência da projeção a dado hostil.** Reducer é fail-stop, o log é append-only e a reprojeção reproduz a falha. Um único registro venenoso é terminal. | §6.4 |
| MG-20 | **Prova de posse de chaves anunciadas** (`relayKey`, e por extensão qualquer chave que outros passem a usar). | §9.3 |

---

## Security Assumptions That Need Validation

Premissas que a arquitetura assume e que **não estão comprovadas** no material. Cada uma pode ser
resolvida com um experimento, uma leitura de API ou uma decisão de produto — e cada uma muda o
laudo se cair.

| # | Premissa assumida | Como validar | O que muda se for falsa |
|---|---|---|---|
| SA-1 | `safeStorage` protege a chave contra outro processo do mesmo usuário (§18.1) | Segundo processo do usuário tentando decifrar `identity.enc`, nas 3 plataformas | T-10 vira certeza; §18.1 precisa ser reescrita |
| SA-2 | O `firewall` do Hyperswarm decide **por tópico**, não por peer | Ler a API da versão travada | T-25 e a mitigação de T-08 dependem inteiramente disso |
| SA-3 | `swarm.join` recebe o `coreKey` (como §6.2 diz) e não o `discoveryKey` | Ler a API; corrigir o texto em qualquer caso | Se for o `discoveryKey`, T-04 perde a parte de descoberta e mantém a de capacidade |
| SA-4 | O corestore protege — ou pode proteger — a chave de escrita do core | Ler a API de custódia de chaves do corestore; incluir no spike da fase 0 | T-03 sobe ou cai conforme a resposta |
| SA-5 | A prova de convite é verificável pelo host (§11.4) | F-02 já demonstrou que não é para convites de terceiros | A correção adotada decide se T-06 piora (segredo em claro) ou se resolve |
| SA-6 | O candidato pode autenticar o host antes de resgatar | Verificar como `hostKey`/`coreKey` chegam antes do resgate (F-09) | Sem isso, T-06 não tem correção completa |
| SA-7 | A verificação Ed25519 a ~50 µs sustenta 8.000+ reg/s **e** margem para revalidação e para carimbo assinado | Benchmark da fase 0 | Decide a viabilidade das mitigações de T-02 e T-27 |
| SA-8 | 128 conexões bastam para 340 membros × 50 comunidades | Medição da fase 3 (já é A-2 e F-14) | T-08 muda de "DoS barato" para "DoS trivial" |
| SA-9 | O fan-out efêmero é viável na escala de referência | Medição da fase 3 (F-13) | T-28 deixa de precisar de atacante |
| SA-10 | `protomux-rpc` já impõe teto de quadro | Ler a API | T-34 cai para LOW se impuser |
| SA-11 | O `EncodedVideoChunk` do repassador não é decodificável na prática | Tentar decodificar num nó de repasse instrumentado | Se for decodificável (é o esperado), T-11 está confirmado |
| SA-12 | `uplinkKbps` é medido, não declarado (§11.17.1 × §10.6) | Fechar a contradição de especificação | T-13 depende do desfecho |
| SA-13 | O renderer nunca alimenta o `RTCPeerConnection` com SDP de quem não está no roster | Ler o fluxo de `voice.signal` quando existir | T-15 depende disso |
| SA-14 | `lib/markdown.tsx` filtra o esquema de `href` | Ler o código já implementado | T-18 é confirmado ou eliminado por uma leitura |
| SA-15 | `NODE_ENV` está definido como `production` no artefato empacotado | Inspecionar o artefato e enviar `dev.resetAll` | T-19 é confirmado ou eliminado por um teste |
| SA-16 | O caminho de `blob.stage` pode ser comprovadamente originado de diálogo do SO | DR-37 já mostrou que não há mecanismo | T-16 permanece até haver um |
| SA-17 | Quem escreve os blocos do core de blobs (host ou membro) | F-03 precisa ser resolvido primeiro | Decide de quem é o disco em T-09 |
| SA-18 | 2⁴⁸ é custo suficiente contra colisão dirigida de id | Medir o custo de grinding do `opId` real | Calibra T-30 |
| SA-19 | O handle de 30 bits resiste a busca dirigida | Medir keygen Ed25519 e extrapolar (estimo horas em notebook) | T-29 depende da ordem de grandeza |
| SA-20 | O DHT não revela mais do que "que um tópico existe" | Instrumentar um nó próximo a uma chave conhecida e coletar | Calibra T-24, que é a base da postura de privacidade |
| SA-21 | O `E_CLOCK_UNREASONABLE` de estágio 6 fecha a janela de replay | O cálculo em T-05 mostra que **não** fecha, com `op.ts` adiantado | É o passo do qual T-05 inteiro depende — validar primeiro |

---

## Recommended Security Tests

§21.5 tem quatro casos adversariais, todos corretos e todos sobre a **única** classe de ataque que
a arquitetura já bloqueia (assinatura forjada, payload fora de limite, `author` alheio, força bruta
de convite). A lista abaixo cobre o que falta. Cada teste tem um resultado esperado que **falha o
CI** se não for atendido.

### A. Integridade do log e da projeção

| # | Teste | Esperado |
|---|---|---|
| ST-01 | **Replay pós-dedupe.** Enviar op com `ts = now + 23 h`; avançar o relógio do host 7 d 1 h; reenviar o mesmo envelope. | O host recusa. Hoje, aceita e a projeção morre (T-05) |
| ST-02 | **Transplante entre comunidades.** Colher um envelope `mod.ban` do log de A e appendá-lo no core de B, com o mesmo autor membro de B. | A projeção de B ignora e conta em `projector.unauthorizedOp` (T-01) |
| ST-03 | **Reaplicação de op válida em estado diferente.** Host reaplica um `role.update` de um autor que já perdeu `manage_roles`. | Detectado e sinalizado (T-02) |
| ST-04 | **Colisão dirigida de id.** Moer `nonce` até bater 48 bits com um id existente de outra comunidade, enviar. | Nenhuma parada de projeção; nenhum efeito fora da comunidade de origem (T-30) |
| ST-05 | **Registro venenoso.** Injetar no core um registro que faz o reducer lançar. | A projeção pula, conta e continua — nunca para permanentemente (MG-19) |
| ST-06 | **Reprojeção com dado hostil.** Repetir ST-05 e reprojetar do `seq` 0. | Estado idêntico ao de §21.4, sem repetir a falha |
| ST-07 | **Carimbo retroativo.** Enviar op com `ts = now − 6 d`. | `clockSkewed` ligado; a UI exibe `hostTs` (T-26) |

### B. Convites e admissão

| # | Teste | Esperado |
|---|---|---|
| ST-08 | **Retransmissão de convite.** Peer no mesmo tópico intermedia desafio e prova entre candidato e host. | O host recusa a prova apresentada por outra chave (T-06) |
| ST-09 | **Resgate em massa.** 1.000 `inviteRedeem` com 1.000 identidades novas e o mesmo código, em 60 s. | Limitado por convite e por comunidade (T-07) |
| ST-10 | **Convite de ex-moderador.** Emitir convite, banir o emissor, tentar resgatar. | Convite inválido (T-23) |
| ST-11 | **Convite de terceiro.** Membro não-host emite convite; candidato resgata. | Funciona — hoje é impossível (F-02) |
| ST-12 | **Oráculo de ban.** Banido tenta conectar e observa a recusa. | Não é possível distinguir "banido aqui" de "indisponível" (T-25) |

### C. Rede, DoS e recursos

| # | Teste | Esperado |
|---|---|---|
| ST-13 | **Ocupação de conexões.** 128 peers Sybil conectam e não fazem nada. | Membros conhecidos continuam conectando (T-08) |
| ST-14 | **Fadiga de assinatura.** Envelopes bem-formados com assinatura inválida, taxa máxima, de peers não-membros. | Recusa antes da verificação Ed25519 (T-08) |
| ST-15 | **Flood efêmero.** `presencePublish`/`typing` a milhares por segundo de um membro. | Limitado por peer; fan-out agregado por janela (T-28) |
| ST-16 | **Quadro RPC gigante.** Request `submitOps` acima de qualquer teto razoável. | Conexão encerrada antes do decode; memória estável (T-34) |
| ST-17 | **Inundação de armazenamento.** Um membro no teto do rate limit por 24 h com `content` no máximo. | Cota por autor morde; a comunidade não cresce sem limite (T-09) |
| ST-18 | **Anexo com hash falso.** Publicar anexo cujo `hash` não corresponde aos bytes, e medir o custo dos destinatários. | Detecção precoce; penalização do autor (T-09, F-41) |
| ST-19 | **Eclipse por bootstrap.** `P2P_BOOTSTRAP` apontando para nós controlados, com e sem tabela persistida. | Com tabela persistida, o nó reencontra a rede real (T-22) |

### D. Identidade, chaves e dispositivo

| # | Teste | Esperado |
|---|---|---|
| ST-20 | **Segundo processo do usuário.** Tentar decifrar `identity.enc` a partir de outro processo, nas 3 plataformas. | Documentar o resultado real e corrigir §18.1 (T-10, SA-1) |
| ST-21 | **Uso do core fora do app.** Copiar `cores/` e tentar appendar. | Impossível sem o segredo custodiado (T-03) |
| ST-22 | **`dev.*` no artefato de produção.** Enviar `dev.resetAll` pelo IPC no build empacotado. | `E_UNKNOWN_COMMAND` (T-19) |
| ST-23 | **Comando destrutivo pelo IPC.** Enviar `identity.wipe` sem passar pela UI. | Exige confirmação do main (T-20) |
| ST-24 | **`blob.stage` com caminho arbitrário.** Enviar um caminho que não veio de diálogo. | Recusado por mecanismo, não por convenção (T-16) |
| ST-25 | **Grinding de handle.** Gerar chaves até reproduzir o handle de um alvo; medir o tempo. | Custo acima de qualquer alcance prático (T-29) |
| ST-26 | **Adulteração de `local_*`.** Editar `local_relay_consent` e `local_dedupe` com o app fechado. | Detectado, ou irrelevante por integridade (T-36) |

### E. Mídia, voz e tela

| # | Teste | Esperado |
|---|---|---|
| ST-27 | **Repassador curioso.** Nó de repasse tenta decodificar o que encaminha. | Impossível sem a chave de sessão (T-11) |
| ST-28 | **Repassador impostor.** Nó de repasse substitui os quadros pelos próprios. | Filhos rejeitam por falha de autenticação (T-11) |
| ST-29 | **Captura da árvore.** 5 identidades declaram uplink máximo e disputam o nível 1. | Não é possível garantir a posição (T-13) |
| ST-30 | **`codecConfig` hostil + fuzzing de chunk.** | Rejeitado antes do decoder; renderer estável (T-12) |
| ST-31 | **Sinalização não solicitada.** Peer fora do roster envia SDP/ICE a um membro. | Descartado antes do renderer (T-15) |
| ST-32 | **Ban durante a chamada.** Banir quem está em voz e observar as conexões dos pares. | Os pares honestos derrubam a `RTCPeerConnection` (T-32) |
| ST-33 | **Timeout e voz.** Alvo sob timeout tenta `voiceJoin` e `shareStart`. | Comportamento definido e aplicado (T-32) |
| ST-34 | **Relay com chave alheia.** `relay.volunteer` anunciando `relayKey` de terceiro. | Recusado por ausência de prova de posse (T-14) |
| ST-35 | **Captura antes da autorização.** Renderer chama `getDisplayMedia` sem `voice_share_screen`. | Negado pelo main (T-41) |

### F. Conteúdo e superfícies do cliente

| # | Teste | Esperado |
|---|---|---|
| ST-36 | **Esquemas de URL.** Mensagens com `javascript:`, `file:`, `smb:`, `data:` e esquema customizado. | Renderizados como texto inerte (T-18) |
| ST-37 | **Anexos executáveis.** `.exe`, `.lnk`, `.desktop`, `.html`, `.docm`, extensão dupla. | Confirmação nomeada; quarentena aplicada (T-17) |
| ST-38 | **Corpus de nomes hostis.** Travessia, nomes reservados do Windows, ponto/espaço final, `:`, 255 bytes. | Rejeição, não transformação; caminho final sempre dentro do diretório (T-37) |
| ST-39 | **Nomes Unicode hostis.** Bidi, largura zero, homóglifos em `displayName`, `nickname`, `Role.name`. | Normalizados ou rejeitados (T-29) |
| ST-40 | **`@everyone` sem permissão.** Cliente adulterado envia a menção. | A menção não sobrevive na projeção de nenhuma réplica (T-31) |
| ST-41 | **Escalada pelo cargo base.** Moderador com `ban_members` concede `ban_members` ao cargo base. | Recusado, ou auditado e reversível (T-35) |
| ST-42 | **Vazamento em log.** Executar um cenário completo em `trace` e varrer os NDJSON por conteúdo, `reason` e nomes. | Nada além da allowlist de §17.2 (T-39) |
| ST-43 | **Silenciamento pelo host.** Host devolve `retryAfterMs` enorme só para um membro. | Cliente limita e sinaliza; não fica represado 72 h (T-33) |

---

## Nota final de calibragem

**O que este laudo não afirma.** Não afirma que a arquitetura é insegura como conceito. Várias
decisões são melhores do que a média do gênero: assinatura por op verificada em toda réplica (§7);
domínio de separação obrigatório em hashes (§18.2); `sodium-native` em vez de `Math.random`;
ausência de `eval` e de dependência dinâmica; renderização de markdown por elemento React;
ausência de unfurl com a justificativa correta (vazaria IP); ADR-06 recusando STUN de terceiro;
redação de log por allowlist com o motivo certo escrito ao lado; e sparse por default nos blobs,
que sozinho elimina a maior parte de um vetor de exaustão. A tabela de §18.1 existe, o que já a
coloca acima de quase toda especificação comparável.

**Onde o modelo de ameaça da spec erra sistematicamente.** Em três pontos, e todos os CRITICAL
saem de um deles:

1. **Confundir "não faz" com "não pode".** O repassador não decodifica; o cliente honesto não
   reenvia depois de 7 dias; o renderer não manda caminho arbitrário; a UI não mostra `@everyone`
   a quem não pode. Cada uma dessas frases descreve software correto, e cada uma foi contada como
   defesa.
2. **Validar uma vez, no lugar em que o adversário está.** Os 12 estágios de §9.1 são excelentes e
   rodam exclusivamente no host — que §18.1 modela como adversário. A réplica, que é a única
   testemunha independente, só verifica assinatura.
3. **Isolar por convenção sobre recursos globais.** Comunidades são separadas por uma coluna, e
   compartilham processo, banco, swarm, firewall, espaço de ids e tabela de dedupe.

**O que eu tentei derrubar e não consegui.** A verificação de assinatura na projeção resiste: não
achei caminho para um host inserir conteúdo com autoria alheia sem possuir a chave — o ataque
possível é transplantar e reaplicar assinaturas **genuínas** (T-01, T-02), que é grave e é outra
coisa. O tratamento de markdown por elemento React fecha injeção de marcação; o que sobra é o
atributo `href` (T-18). O sparse por default resiste como defesa de banda para os membros. A
proibição de unfurl resiste. `E_AUTHOR_MISMATCH` no estágio 4 resiste e impede que terceiros
submetam ops alheias — foi o que reduziu T-01 do caso geral para o caso do host. A ordem "blob
antes da mensagem" de §6.6 é a escolha certa também do ponto de vista de segurança. E a tabela
persistida do DHT (`P2P_DHT_PERSIST`) é uma defesa real contra eclipse que a spec nem apresenta
como tal.

Nada disso é atestado de corretude. É o registro do que foi atacado sem sucesso, para que a
próxima revisão comece de outro lugar.
