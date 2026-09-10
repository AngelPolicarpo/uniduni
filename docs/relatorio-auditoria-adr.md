# Auditoria adversarial de decisões tecnológicas — Uniduni

**Responsável:** Manus AI  
**Data de corte da pesquisa:** 15 de agosto de 2026  
**Escopo:** ADRs 01–20, contratos de backend relacionados e as premissas de APIs, bibliotecas, runtimes, persistência, mídia, rede, segurança, empacotamento, desempenho e compatibilidade presentes no corpus fornecido.

> **Conclusão de método.** Esta auditoria não tentou confirmar as ADRs. Ela procurou primeiro a condição que faria cada premissa falhar: limite de API, diferença de processo, dependência de versão, ausência de contrato de rede, configuração que muda a semântica ou meta de desempenho sem medida. Uma API documentada não é, por si, evidência de que a propriedade de sistema foi alcançada.

## 1. Método e taxonomia de evidência

Foram priorizadas a documentação oficial do Electron, TypeScript, SQLite e W3C; os READMEs/código-fonte dos pacotes Holepunch e `better-sqlite3`; e o registry npm para a fotografia de versões. Posts, fóruns e respostas geradas não foram usados como autoridade. Quando uma conclusão deriva do cruzamento de uma API documentada com o contrato dos ADRs, ela está marcada como **INFERRED**, não como fato experimental.

| Rótulo de evidência | Significado aplicado neste relatório |
|---|---|
| **DOCUMENTED** | A fonte primária declara diretamente o comportamento. |
| **EXPERIMENTALLY VERIFIED** | Exigiria execução reproduzível no ambiente-alvo. Não foi atribuído nesta auditoria documental. |
| **INFERRED** | Decorre de fonte primária e do contrato analisado, sem ensaio executado. |
| **UNSUPPORTED CLAIM** | Nenhuma fonte primária pesquisada estabelece a propriedade alegada. |

Os estados de conclusão são **VERIFIED**, **PARTIALLY VERIFIED**, **OUTDATED**, **CONTRADICTED** ou **UNKNOWN**. “Verificado” não significa “boa escolha universal”; significa apenas que a afirmação delimitada encontrou suporte suficiente.

## 2. Resultado executivo

Foram classificadas **30 afirmações importantes**. Quatro são verificadas de forma favorável, doze são apenas parcialmente verificadas, oito são contraditas e seis permanecem sem evidência primária suficiente. Nenhuma meta de escala ou desempenho foi aceita como comprovada, pois o corpus não contém benchmark reproduzível com a combinação real de hardware, sistema operacional, NAT, topologia, tamanhos de dados e versões empacotadas.

| Veredito | Quantidade | Leitura prática |
|---|---:|---|
| **VERIFIED** | 4 | A semântica delimitada está sustentada, mas pode depender de integração. |
| **PARTIALLY VERIFIED** | 12 | A API existe; a propriedade final contém condição ausente, limite ou risco material. |
| **CONTRADICTED** | 8 | A documentação ou o próprio contrato conflita com a premissa. |
| **UNKNOWN** | 6 | A evidência pesquisada não permite manter a alegação como fato. |

As contradições mais consequentes são: a recuperação total da “view descartável” sem metadados necessários; a alegação de ABI estável entre Node e Electron; a equivalência entre endereço HyperDHT e candidato ICE do renderer; o fallback de voz por UDX; a afirmação de cifragem do UDX; e a garantia de convergência do mesmo validador TypeScript sob configurações locais divergentes.

## 3. Achados que pressionam a arquitetura

### 3.1 ADR-01 — autoridade única resolve ordem, não serializabilidade

**Referência:** `backend.md` §1, ADR-01; §12.1. **Afirmação:** “Um Hypercore com append exclusivo do host dá ordem total e elimina conflito de escrita.” **Veredito:** **PARTIALLY VERIFIED**; a sequência de append do escritor é **DOCUMENTED**, mas a conclusão sobre conflito de regras é **INFERRED** e insuficiente.

O Hypercore documenta um log append-only, `append`, a flag `writable` e a chave usada para assinar append/truncate. Um core recém-criado recebe acesso local de escrita; leitores que só têm a chave pública não recebem esse poder.[1] Isso sustenta a propriedade de **uma única ordem de append**.

> A fonte comprova que a escrita é autorizada pelo material de chave e que o log tem semântica de append. Ela não define uma transação entre “ler a projeção”, “validar uma pré-condição”, “append” e “projetar em SQLite”.

Portanto, ela não demonstra que duas validações concorrentes contra o mesmo estado projetado não possam aprovar operações mutuamente incompatíveis antes de o projetor avançar. O cenário de duplicidade de canal apontado no corpus não é refutado por “um writer”; ele é um problema de **atomicidade da regra de domínio**. A decisão continua válida para ordenação, mas não pode justificar a afirmação absoluta de ausência de conflitos sem alterar o contrato de commit/validação.

### 3.2 ADR-02 — a view SQLite não é reconstruível como especificada

**Referência:** `backend.md` ADR-02, §6.4 e §11.1; achado F-01. **Afirmação:** “A projeção SQLite é 100% descartável e a reprojeção do `seq=0` recompõe estado equivalente.” **Veredito:** **CONTRADICTED**; conclusão **INFERRED** a partir do contrato e da API de Corestore.

Corestore documenta que namespace é uma sessão derivada do namespace-pai e do nome, e que `get({name})` deriva a chave gravável do `primaryKey`, namespace e nome. Também explicita que a replicação não troca chaves/capabilities.[2] A documentação não fornece inventário de “comunidades participadas” para a aplicação e não torna um namespace gerado aleatoriamente recuperável sem persistir o valor ou sem uma derivação normatizada.

No corpus, `blobsKey` chega em RPC/localmente e não aparece como dado normativo do log, enquanto o Corestore é aberto com `namespace(random)`. Isso contradiz a tese de reconstrução exclusiva pelo log: duas reprojeções do mesmo log podem concordar e ainda ambas perderem acesso aos mesmos recursos. A fonte **não** prova que `blobsKey` seja irrecuperável em qualquer design; ela prova que Corestore não fornece, por si, a recuperação implícita alegada. A ADR precisa ser reaberta até que a fonte autoritativa de participação e a derivação/persistência de `blobsKey` estejam explícitas.

### 3.3 ADR-03 e ADR-04 — N-API reduz risco, não cria ABI universal Electron–Node

**Referência:** `backend.md` ADR-03 e ADR-04; §23 fase 0. **Afirmação:** “`better-sqlite3` é N-API e, por isso, o `.node` é ABI-estável entre Node e Electron.” **Veredito:** **CONTRADICTED**; evidência **DOCUMENTED**.

O repositório atual de `better-sqlite3` confirma Node-API (`node-addon-api`), define `NAPI_VERSION=10`, expõe `NODE_API_MODULE` e publica `better-sqlite3` 13.0.3 com requisito Node >=22.[3] A biblioteca também documenta transações síncronas que fazem rollback quando o callback lança, o que realmente dá a semântica de API invocada pelo ADR.[4]

Porém a documentação oficial do Electron instrui que módulos Node nativos precisam ser **recompilados para Electron**, em razão de ABI diferente, e avisa que upgrades de Electron geralmente exigem novo rebuild.[5] Isso é incompatível com a formulação “ABI-estável entre Node e Electron”. Node-API oferece uma promessa importante dentro de seu escopo, mas não garante que o artefato distribuído, o runtime Electron, o `asar`, o compilador, a arquitetura e as dependências nativas funcionarão como um único binário intercambiável.

O `utilityProcess` é, de fato, um processo separado com Node e MessagePorts; Electron documenta seu ciclo de spawn/exit.[6] Isso apoia isolamento de processo. A fonte não promete que crash de addon não alcance o main, que o renderer permaneça semanticamente saudável, nem que recovery do Corestore/SQLite ocorra sem protocolo explícito. Assim, ADR-03 e ADR-04 permanecem condicionais ao spike, à matriz de artifacts e a testes de crash/restart nos três sistemas operacionais. O plano Bare não é um substituto drop-in para um addon Node-API e deve ser tratado como variante de arquitetura, não fallback pequeno.

### 3.4 ADR-05 a ADR-07 — a ponte DHT→ICE e o fallback de voz não estão comprovados

**Referência:** `backend.md` ADR-05, ADR-06, ADR-07 e §11.16; achados F-19 e F-20. **Afirmação A:** “O endereço HyperDHT substitui a descoberta STUN e pode ser injetado no ICE do renderer.” **Veredito:** **CONTRADICTED**; **DOCUMENTED + INFERRED**.

HyperDHT documenta hole punching para “most networks”, endereço público de um servidor DHT quando previsível e relays que podem acelerar conexão.[7] Isso não é uma promessa de atravessar qualquer NAT. A especificação WebRTC define candidatos/estados ICE no contexto do `RTCPeerConnection`; `iceServers` transporta a configuração STUN/TURN e a própria sinalização fica fora do escopo da especificação.[8]

Essas fontes comprovam que ambos lidam com conectividade, mas **não** que um mapeamento descoberto por uma socket UDX no núcleo seja um candidato válido para a socket ICE criada em outro processo pelo renderer. Sob NAT dependente de porta/destino, a premissa pode falhar exatamente na diferença que a ADR abstrai. A decisão não continua válida sem PoC que compare os mapeamentos por socket e meça sucesso em NAT restritivo e simétrico.

**Afirmação B:** “Quando ICE falhar, UDX é fallback universal de voz sem reconstruir a pilha RTC.” **Veredito:** **CONTRADICTED**; **DOCUMENTED**. O próprio README de UDX descreve streams confiáveis/multiplexados/congestion-controlled sobre UDP e afirma de forma explícita: “No handshakes. No encryption. No features.”[9] Ele não fornece ICE, DTLS-SRTP, jitter buffer, packet-loss concealment, AEC, FEC, codec de voz ou `MediaStreamTrack`.

Logo, “cair para UDX” para a voz significa um protocolo de mídia adicional: captura, codificação, framing, timestamps, jitter buffer, recuperação de perdas, playout, criptografia e controle operacional. A fonte não afirma que isso seja impossível de construir, apenas mostra que não está incluído no transporte escolhido. Como a ADR-05 justifica WebRTC justamente por não reconstruir esses componentes, as duas decisões entram em tensão material e exigem reconsideração conjunta.

### 3.5 WebRTC e WebCodecs — o absoluto sobre reencode já não é defensável, mas suporte continua incerto

**Referência:** `backend.md` ADR-05; §10.8. **Afirmação:** “Em WebRTC puro, o Chromium não repassa track sem decodificar e recodificar.” **Veredito:** **PARTIALLY VERIFIED / OUTDATED em formulação absoluta**.

A Working Draft do W3C para **WebRTC Encoded Transform** expõe frames codificados entre encoder e packetizer e entre depacketizer e decoder. Ao mesmo tempo, ela proíbe um processador de criar frames ou movê-los entre streams; portanto não fornece uma árvore multicast opaca completa pronta para uso.[10] A fonte limita a conclusão: há acesso a bits codificados, mas não uma API de relay multi-hop que resolva por si toda a topologia.

WebCodecs, por seu turno, dá API de encoder e `isConfigSupported`, porém a recomendação não transforma um codec, modo de escalabilidade, aceleração por hardware ou orçamento de CPU em suporte universal.[8] Portanto o pipeline de tela pode ser tecnicamente plausível, mas a compatibilidade Electron/Chromium/OS/GPU e a qualidade precisam de PoC. Não é apropriado tratar a disponibilidade de codec como **DOCUMENTED** sem pin de Electron e ensaio no artefato final.

### 3.6 ADR-08 — “relay cego cifrado porque UDX é cifrado” é diretamente falso

**Referência:** `backend.md` ADR-08. **Afirmação:** “Blind relay não lê porque o tráfego UDX é cifrado ponta a ponta.” **Veredito:** **CONTRADICTED**; evidência **DOCUMENTED**.

O README de UDX declara expressamente ausência de encryption.[9] Uma camada superior pode cifrar uma sessão particular, mas ela precisa ser identificada e seu protocolo de chave, autenticação, rekey, metadata, capacidade de relay, expiração e rate limit devem ser especificados. A documentação de UDX não fornece esses controles. A ADR não pode usar “UDX cifrado” como justificativa de confidencialidade; essa parte precisa ser corrigida antes de alegar relay cego.

### 3.7 Persistência local — SQLite WAL ajuda, mas `NORMAL` muda a promessa da outbox

**Referência:** `backend.md` ADR-11; §6.4. **Afirmação:** “Uma outbox SQLite é durável ao fechar/reabrir e após crash.” **Veredito:** **PARTIALLY VERIFIED**; **DOCUMENTED** para a semântica SQLite, não para o produto completo.

SQLite documenta que WAL permite leitores e um único escritor concorrentes, e que `synchronous=FULL` sincroniza a WAL em cada commit. Também explica que `NORMAL` omite a sincronização no commit, aumentando desempenho ao custo de transações não duráveis após power loss ou hard reset.[11] `better-sqlite3` documenta o rollback da função de transação ao lançar exceção.[4]

Isso comprova atomicidade e uma configuração disponível. Não comprova que o app seleciona `FULL`, que checkpoint não degrada o caminho crítico, que `-wal` acompanha backups/migrações, ou que o replay de rede é idempotente ao reabrir. A ADR permanece válida apenas se as configurações de SQLite se tornarem contrato normativo e se houver teste de kill/power-loss/restart com auditoria do estado.

### 3.8 Tipos compartilhados não são validação de rede

**Referência:** `backend.md` §9.2. **Afirmação:** “O mesmo módulo TypeScript nos dois lados impede divergência.” **Veredito:** **CONTRADICTED**; evidência **DOCUMENTED**.

O Handbook do TypeScript é explícito: anotações de tipo são removidas e nunca mudam comportamento de runtime.[12] Ele descreve type guards como verificações JavaScript que permitem narrowing; isto é, a validação efetiva de dados externos precisa ocorrer em runtime.[13]

O mesmo fonte compilado pode reduzir divergência de lógica estática, mas não impede que variáveis de ambiente, limites locais, relógio, versão de schema, payload malformado ou regras de configuração produzam decisões distintas. Em particular, os limites configuráveis descritos em §20 tornam o resultado do validador função do ambiente local. A frase precisa ser rebaixada de garantia para benefício de manutenção, e os inputs devem ser canônicos/verificados no host.

### 3.9 Escala, presença e replicação de fundo são hipóteses de benchmark

**Referência:** `backend.md` ADR-14, ADR-16, §19.1 e §19.2. **Afirmações:** 340 membros, 128 conexões, 50 comunidades, 500 ops/s, p95 60 ms e 95% de conexão direta. **Veredito:** **UNKNOWN**; **UNSUPPORTED CLAIM**.

Hyperswarm documenta suporte a múltiplos tópicos e opções como `maxPeers`, limites direcionais, `maxParallel`, `limit` no join e `relayThrough`; seu `maxPeers` default é 64 e `flush()` pode ser global/dispendioso.[18] Isso prova que os controles existem. Não especifica fairness entre 100 tópicos, política de fila para 128 pares, contenção entre replicação e voz, nem qualquer uma das metas de produto.

Os números de fan-out de presença e typing encontrados no corpus são aritmética de cenário, não benchmark. Eles devem ser tratados como **limites ainda não demonstrados**, com métricas de loop lag, backlog de RPC, in-flight bytes, perda de mídia e latência de commit. A ADR-14 pode continuar como escolha semântica, mas não como evidência de que o fan-out é econômico; ADR-16 não deve ficar fechada sem um scheduler de prioridade/degradação.

### 3.10 Segurança e distribuição — `safeStorage` e deep links têm condições de plataforma

**Referência:** `backend.md` ADR-19 e §2.1. **Afirmação A:** “A chave privada nunca fica em disco em claro graças a `safeStorage`.” **Veredito:** **PARTIALLY VERIFIED**. Electron integra Keychain/DPAPI/stores Linux, mas documenta o fallback Linux `basic_text`, no qual os itens ficam sem proteção.[14] A proteção também não cobre cópias em memória ou processos já privilegiados do mesmo usuário. A decisão continua aceitável se houver política explícita para ausência de secret store e se o estado `basic_text` for tratado como risco visível, não como proteção equivalente.

**Afirmação B:** “O empacotamento torna nativos e deep links uma questão já resolvida.” **Veredito:** **PARTIALLY VERIFIED**. Electron documenta que handlers de protocolo só funcionam empacotados em macOS/Linux e exigem metadados de distribuição; Electron Forge oferece plugin para desempacotar módulos nativos do `asar`.[15] [16] As fontes não comprovam assinatura, notarização, associação de protocolo, prebuilds e load de addon em Win/macOS/Linux e x64/arm64. Isso requer smoke tests nos artefatos finais.

## 4. Diferenças de versão relevantes

Uma consulta ao registry npm em 15/08/2026 observou `hypercore` 11.35.1, `corestore` 7.12.0, `hyperblobs` 2.12.1, `hyperswarm` 4.17.0, `hyperdht` 6.33.1, `protomux` 3.11.0, `protomux-rpc` 1.10.0, `udx-native` 1.21.0 e `better-sqlite3` 13.0.3.[17] Essa fotografia não substitui lockfile, SBOM ou teste de interop.

| Área | Risco de versão | Consequência de auditoria |
|---|---|---|
| **Electron/Node** | O ADR não fixa Electron/Chromium/Node ABI e `better-sqlite3` atual exige Node >=22. | Fixar tripla de versão e rebuild por alvo antes de afirmar compatibilidade. |
| **Corestore** | A documentação atual descreve major 7 e alertas sobre transição/dist-tag. | Pin de pacote não prova compatibilidade de storage/replicação com dados legados. |
| **WebRTC Encoded Transform** | É Working Draft em 2026, não Recommendation estável. | Não usá-lo como requisito implícito sem feature detection e PoC no Electron. |
| **SQLite** | WAL e FTS5 dependem de build e de PRAGMAs persistidos/configurados. | Registrar versões SQLite/FTS5, `journal_mode`, `synchronous`, checkpoint e teste de recuperação. |

## 5. Resultado solicitado por ADR

| Grupo | ADRs | Resultado de auditoria |
|---|---|---|
| **Verified ADRs** | ADR-09, ADR-18; partes delimitadas de ADR-01 e ADR-03 | Aritmética de convite, corte de escopo de push, writer único para ordem e transação síncrona existem como alegado. |
| **ADRs with weak evidence** | ADR-04, ADR-05, ADR-11, ADR-12, ADR-13, ADR-14, ADR-15, ADR-16, ADR-17, ADR-19, ADR-20 | Dependem de integração, configuração, política de aplicação ou comportamento de plataforma não demonstrado. |
| **ADRs contradicted by documentation** | ADR-02, ADR-03 (justificativa ABI), ADR-06, ADR-07, ADR-08; §9.2 TypeScript | O texto conflita com API/documentação ou pressupõe capacidade não provida. |
| **Outdated assumptions** | Absoluto sobre reencode WebRTC; motivo de ADR-10 que trata truncamento como indisponível | Hypercore atual documenta `truncate`; W3C expõe transforms de frames codificados, embora não resolva relay multicast sozinho. |

## 6. Claims requiring PoC

| PoC | Pergunta que deve responder | Critério mínimo |
|---|---|---|
| **ICE por socket/processo** | O candidato derivado de HyperDHT funciona para o `RTCPeerConnection` do renderer? | Comparar mapeamento DHT e STUN por socket; NAT port-restricted e symmetric; registrar taxa de conexão. |
| **Crash e recovery do núcleo** | `utilityProcess` falha sem deixar janela ou protocolo em estado falso? | Induzir crash de addon durante replicação/projeção; verificar reinicialização, reconexão, dados e UI. |
| **Outbox durável** | A fila preserva atomicidade, ordem e idempotência sob crash? | Kill em pontos de commit, `synchronous=FULL/NORMAL`, reabertura e comparação de operações aceitas/deliveries. |
| **Matrix Electron native** | `better-sqlite3` carrega no artefato final? | Win/macOS/Linux × x64/arm64 aplicáveis; `asar`, `utilityProcess`, cold start, upgrade e deep link. |
| **WebCodecs/Encoded Transform** | O codec/modo necessário existe no Chromium empacotado? | `isConfigSupported`, captura, encode, GC/CPU e fallback explícito por GPU/OS. |
| **Lock composto** | Segunda instância não abre Corestore+SQLite nem após crash/wipe? | Corrida de launch, filesystem local suportado, cleanup e `identity.wipe`. |

## 7. Claims requiring benchmark

| Benchmark | Hipótese a medir | Métricas indispensáveis |
|---|---|---|
| **Fan-out efêmero** | Presença/typing a 340 membros não prejudica operações críticas. | mensagens/s, bytes/s, event-loop lag, p95/p99 de `submitOp`, drops e memória. |
| **Replicação multicomunidade** | 50 comunidades / 100 tópicos coexistem com teto de 128 pares. | tempo até convergir, starvation por tópico, fila, número de peers e impacto em mídia. |
| **Projetor SQLite** | 500 ops/s e p95 <60 ms são atingíveis com FTS e WAL reais. | tempo de transação, `SQLITE_BUSY`, checkpoint, WAL size, CPU, I/O e recuperação. |
| **Upload de anexos** | 8 GiB não monopoliza RPC/host. | ocupação de stream, throughput, backpressure, p95 de mensagem paralela e cancelamento/retry. |
| **Árvore de tela/relay** | Custo e churn da árvore são aceitáveis. | encode/decode, bytes por nível, reparenting, perdas, latência end-to-end e CPU de relay. |

## 8. Claims requiring architectural reconsideration

1. **Reabrir ADR-02** até que uma reconstrução integral — participação, namespace, `blobsKey`, material local e reprojeção — tenha fonte autoritativa e teste de delete/reopen completo.
2. **Reabrir o par ADR-06/ADR-07** como uma única decisão de conectividade e mídia. O endereço DHT não é evidência de candidato ICE do renderer, e UDX não é fallback de voz pronto.
3. **Corrigir ADR-08 antes de qualquer reivindicação de confidencialidade de relay.** UDX não fornece criptografia; a camada real precisa existir no contrato.
4. **Reformular ADR-03/ADR-04 como decisões condicionais de distribuição.** N-API não elimina rebuild Electron; Bare não é fallback sem redesign de driver e semântica.
5. **Rebaixar todos os limites de §19 de fatos para hipóteses de validação.** A decisão de capacidade só pode fechar depois de benchmark publicado com ambiente e versões.
6. **Substituir “mesmo TypeScript não diverge” por contrato runtime.** Tipos compartilhados devem acompanhar schema/guard e uma fonte canônica para limites que o host aplica.

## 9. Limites desta auditoria

Esta entrega não executou tráfico real por NAT, benchmark de 340 peers, artifacts instaláveis por plataforma, nem crashes induzidos. Por isso não há rótulo **EXPERIMENTALLY VERIFIED**. Ela também não recomenda tecnologia alternativa por preferência: aponta apenas onde a decisão existente não possui evidência suficiente ou conflita com documentação, e qual prova mínima permitiria mantê-la ou revisá-la.

## Referências

[1]: https://github.com/holepunchto/hypercore "Hypercore — README e API"
[2]: https://github.com/holepunchto/corestore "Corestore — README e API"
[3]: https://github.com/WiseLibs/better-sqlite3 "better-sqlite3 — repositório e metadados de pacote"
[4]: https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md "better-sqlite3 — API de transação"
[5]: https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules "Electron — Using Native Node Modules"
[6]: https://www.electronjs.org/docs/latest/api/utility-process "Electron — Utility Process API"
[7]: https://github.com/holepunchto/hyperdht "HyperDHT — README"
[8]: https://www.w3.org/TR/webrtc/ "W3C — WebRTC Recommendation"
[9]: https://github.com/holepunchto/udx-native "UDX native — README"
[10]: https://www.w3.org/TR/webrtc-encoded-transform/ "W3C — WebRTC Encoded Transform Working Draft"
[11]: https://www.sqlite.org/wal.html "SQLite — Write-Ahead Logging"
[12]: https://www.typescriptlang.org/docs/handbook/2/basic-types.html "TypeScript Handbook — The Basics"
[13]: https://www.typescriptlang.org/docs/handbook/2/narrowing.html "TypeScript Handbook — Narrowing"
[14]: https://www.electronjs.org/docs/latest/api/safe-storage "Electron — safeStorage"
[15]: https://www.electronjs.org/docs/latest/tutorial/launch-app-from-url-in-another-app "Electron — Deep Links"
[16]: https://www.electronforge.io/config/plugins/auto-unpack-natives "Electron Forge — Auto Unpack Native Modules"
[17]: https://www.npmjs.com/ "npm registry — versões consultadas em 15/08/2026"
[18]: https://docs.pears.com/reference/building-blocks/hyperswarm/ "Pears — Hyperswarm"
