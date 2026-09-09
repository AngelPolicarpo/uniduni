# Relatório de Auditoria — Fase 5: Coordenação de Voz, Compartilhamento de Tela, Relay e STUN/TURN

**Data:** 2026-09-08  
**Escopo:** Mídia WebRTC, streaming P2P mesh, estrela de tela, relay voluntário e servidores STUN/TURN (RFC 5389 / RFC 5766).  
**Normativos de referência:** `docs/backend-v2.md` (§17, §16.4, §15.4, §15.5, §15.7) > `docs/adr-v2.md` > `docs/plano-de-validacao-experimental-v2.md`.  

---

Total de achados: 6 (1 crítico, 2 altos, 2 médios, 1 baixo).

---

### [severidade: crítico] Vazamento de sessão de tela e emissão de tickets após revogação de `voice_share_screen` no Fold
- **Local:** `core/src/l2/shareStar/sessions.ts:504-526`
- **Hipótese investigada:** Vazamento de Tickets de Sessão: Um MediaTicket emitido para compartilhamento de tela continua válido após a revogação da permissão `voice_share_screen` no log do fold?
- **O que acontece:** Em [`ShareHostSessions.start()`](file:///home/rebis/projetos/software/core/src/l2/shareStar/sessions.ts#L313-L315), a permissão `voice_share_screen` (`SHARE_SCREEN`) é exigida estritamente para iniciar a transmissão. No entanto, na varredura periódica/reativa [`sweepAgainst()`](file:///home/rebis/projetos/software/core/src/l2/shareStar/sessions.ts#L495-L527) (chamada a cada lote projetado do fold por [boot.ts](file:///home/rebis/projetos/software/core/src/composition/boot.ts#L1677)), o host verifica apenas se o canal existe, se o apresentador está no roster de voz e se [`#memberEligible(state, session.presenterKeyHex, now)`](file:///home/rebis/projetos/software/core/src/l2/shareStar/sessions.ts#L567-L578) é satisfeito. O método `#memberEligible` valida unicamente se o membro existe, se não foi banido, se não saiu e se não está em timeout; ele **nunca** valida se o apresentador ainda detém a permissão `voice_share_screen`.
- **Cenário de falha:**
  1. O usuário A (apresentador) inicia o compartilhamento de tela via `share.start`.
  2. Um moderador edita os cargos no fold ou remove o cargo de A, revogando a permissão `voice_share_screen`.
  3. O fold projeta a alteração e dispara `host.share.sweepAgainst(estrutural)`.
  4. Como `sweepAgainst` não valida `memberHasPermission(state, session.presenterKeyHex, SHARE_SCREEN)`, a sessão de tela não é encerrada (`#end` não é chamado) e os espectadores não são revogados.
  5. Qualquer novo espectador que invocar `share.join` continua sendo aceito, e o host continua gerando e assinando novos [`MediaTicket`s](file:///home/rebis/projetos/software/core/src/l2/shareStar/sessions.ts#L381-L388) (`issueSessionTicket`) para uma transmissão de tela desautorizada.
- **Evidência:** `docs/backend-v2.md` §17.4 ("Revogação de tickets de mídia: Sessões de voz/tela: Imediato") e §17.5 ("A autoridade estrutural é o DecisionState corrente, passado como argumento no start e no sweepAgainst").
Em `core/src/l2/shareStar/sessions.ts`:
```typescript
      if (
        channel === undefined ||
        channel.deletedAt !== undefined ||
        call === null ||
        !call.has(session.presenterKeyHex) ||
        !this.#memberEligible(state, session.presenterKeyHex, now).ok
      ) {
        this.#end(session, emitted);
        continue;
      }
```
Não há checagem de `!memberHasPermission(state, session.presenterKeyHex, SHARE_SCREEN)`.
- **Confiança:** alta.

---

### [severidade: alto] Bypass da validação de tickets WebRTC (`voice.signal`) no nó hospedeiro (Host)
- **Local:** `core/src/composition/boot.ts:1125-1138` e `core/src/composition/boot.ts:1818-1828`
- **Hipótese investigada:** O enforcement do passo 3 de §17.4 ("o cliente SÓ aceita sinalização de um par que apresente ticket válido") é garantido de forma uniforme tanto em modo membro quanto em modo host?
- **O que acontece:** No modo membro, [`startMediaRuntime`](file:///home/rebis/projetos/software/core/src/l3/ipcRenderer/media.ts#L1098-L1124) intercepta as notificações de sinalização recebidas por `notifications` e executa [`signalIsAuthorized()`](file:///home/rebis/projetos/software/core/src/l3/ipcRenderer/media.ts#L1016-L1042), descartando qualquer sinal cujo ticket seja inválido ou expirado antes que ele chegue ao renderer. Contudo, em modo host, [boot.ts](file:///home/rebis/projetos/software/core/src/composition/boot.ts#L1828) não passa `notifications` para o runtime sob o argumento de que "quem hospeda produz os eventos, não os recebe". Quando um par envia uma oferta ou candidato SDP/ICE destinado ao host via RPC `voiceSignal`, a entrega passa por [`#destinoDeSinal`](file:///home/rebis/projetos/software/core/src/composition/boot.ts#L1125-L1138). Ao notar que `toPeerKeyHex === eu`, o método injeta o evento diretamente no barramento [`this.fanout.emit`](file:///home/rebis/projetos/software/core/src/composition/boot.ts#L1132) da interface gráfica sem nenhuma verificação criptográfica do `ticketId` pelo núcleo.
- **Cenário de falha:**
  1. Um nó conectado envia um pacote RPC `voiceSignal` com `toPeerKey` apontando para a chave pública do host e um `ticketId` forjado ou expirado.
  2. O handler `voiceSignal` em `rpcServer/media.ts` despacha para `deps.signal.deliver`.
  3. `peerSignalRelay` invoca `#destinoDeSinal(communityId, hostKey)`.
  4. `#destinoDeSinal` emite `voice.signal` diretamente ao fan-out do host.
  5. O renderer do host recebe e processa ofertas/candidatos WebRTC de um par sem que o núcleo tenha validado a assinatura do ticket de mídia.
- **Evidência:** `docs/backend-v2.md` §17.4 passo 3 ("A verificação é **do núcleo**, não do renderer: o núcleo já tem o ticket do par e a chave do host, e sinalização não autorizada não deve chegar à camada que fala WebRTC. Falha fechada — sem material, nada passa").
Em `core/src/composition/boot.ts`:
```typescript
    const eu = this.#deps.identity()?.publicKey.toString('hex') ?? null;
    if (eu !== null && toPeerKeyHex === eu) {
      return {
        notify: (topic, body) => {
          try {
            const data = JSON.parse(Buffer.from(body).toString('utf8')) as Record<string, unknown>;
            this.fanout.emit({ topic, data: { communityId, ...data } }, { communityId });
            return true;
          } catch {
            return false;
          }
        },
      };
    }
```
- **Confiança:** alta.

---

### [severidade: alto] Invalidação prematura de tickets válidos por substituição atômica durante renovação periódica
- **Local:** `core/src/l3/ipcRenderer/media.ts:768-784` (e `core/src/l3/ipcRenderer/media.ts:425-444`)
- **Hipótese investigada:** Ciclo de vida e retenção de tickets válidos durante renegociação e jitter de rede.
- **O que acontece:** Durante a cadência de renovação (`renewTickets()`), o array acumulador `tickets` é inicializado vazio (`const tickets: MediaTicket[] = []`). O cliente itera sobre a lista de pares e dispara `voiceTicket` individualmente. Se uma das requisições RPC falhar temporariamente (por exemplo, timeout pontual de rede ou descarte de pacote UDX), o par correspondente não é inserido em `tickets`. Ao final do método, o estado é atualizado com `seguranca = { ...seguranca, tickets }`. Essa atribuição sobrescreve e descarta atomicamente todos os tickets emitidos anteriormente, inclusive tickets ainda dentro do prazo de validade (`MEDIA_TICKET_TTL_MS`, que têm até ~3 minutos de vida restante no momento da renovação periódica).
- **Cenário de falha:**
  1. O cliente A está em chamada com os participantes B e C com tickets válidos por mais 180 segundos.
  2. O ciclo de renovação automática dispara. A renovação do ticket com B tem sucesso, mas a requisição para C sofre uma oscilação passageira de rede.
  3. `renewTickets()` define `seguranca.tickets = [ticketB]`. O ticket pré-existente de C é descartado.
  4. C envia um candidato ICE trickle 100 ms depois.
  5. `signalIsAuthorized` avalia `a.security.tickets.some(...)` e recusa o candidato com `E_TICKET_INVALID`, descartando a sinalização de um par legítimo antes do tempo de expiração do ticket anterior.
- **Evidência:** `core/src/l3/ipcRenderer/media.ts:770-783`:
```typescript
      const tickets: MediaTicket[] = [];
      const eu = opts.selfKeyHex?.() ?? null;
      for (const par of pares) {
        if (eu !== null && par === eu) continue;
        const r = await call('voiceTicket', { sessionId, peerKey: par });
        if (!failed(r) && r['ticket'] !== undefined) {
          tickets.push(mediaWire.decodeTicket(r['ticket'] as Parameters<typeof mediaWire.decodeTicket>[0]));
        }
      }
      if (seguranca !== null) seguranca = { ...seguranca, tickets };
```
- **Confiança:** alta.

---

### [severidade: médio] Inanição de servidores STUN de fallback por esgotamento de orçamento no primeiro servidor
- **Local:** `core/src/composition/relayPort.ts:136-146`
- **Hipótese investigada:** Resiliência da descoberta de mapeamento público para portas de relay STUN/TURN.
- **O que acontece:** Ao instanciar uma alocação TURN, o host aloca uma socket UDP nova e precisa mapear seu endereço público externo via `abrirPortaDeRelay`. O orçamento de tempo padrão é calculado como `limite = Date.now() + (opts.budgetMs ?? 3 * TENTATIVA_MS)` (1500 ms). No loop de consulta, existe um `for (const servidor of servidores)` contendo internamente `while (externo === null && Date.now() < limite)`. Se o primeiro servidor da lista estiver inacessível ou filtrado por firewall, o loop `while` consome todas as tentativas até que `Date.now() >= limite`. Quando o loop do primeiro servidor encerra, a variável `limite` já expirou. Ao passar para o próximo servidor do `for`, a condição do `while` falha imediatamente. Consequentemente, servidores secundários ou de fallback nunca são consultados.
- **Cenário de falha:**
  1. A configuração possui `stunServers: ['stun:primario.bloqueado:3478', 'stun:secundario.operacional:3478']`.
  2. O servidor primário não responde.
  3. `abrirPortaDeRelay` executa 3 tentativas de 500 ms contra o primário.
  4. O prazo de 1500 ms expira.
  5. O loop do primário termina; o servidor secundário é ignorado imediatamente.
  6. A função lança `E_NO_MAPPING` e o host responde `508 Insufficient Capacity` no TURN Allocate, ignorando o servidor secundário funcional.
- **Evidência:** `core/src/composition/relayPort.ts:136-146`:
```typescript
  const limite = Date.now() + (opts.budgetMs ?? 3 * TENTATIVA_MS);
  let externo: MediaAddr | null = null;
  let usado: MediaAddr | null = null;
  for (const servidor of servidores) {
    while (externo === null && Date.now() < limite) {
      externo = await descobrirMapeamento(socket, servidor, TENTATIVA_MS);
      if (externo !== null) usado = servidor;
    }
    if (externo !== null) break;
  }
```
- **Confiança:** alta.

---

### [severidade: médio] Revogação de permissão `voice_speak` no Fold não remove participante da sessão de voz ativa
- **Local:** `core/src/l2/voiceCoordinator/host.ts:626-633` e `core/src/l2/voiceCoordinator/host.ts:581-582`
- **Hipótese investigada:** Revogação contínua de permissões estruturais em chamadas ativas de malha P2P.
- **O que acontece:** Ao entrar no canal de voz ([host.ts:379](file:///home/rebis/projetos/software/core/src/l2/voiceCoordinator/host.ts#L379)), a presença da permissão `voice_speak` é uma pré-condição mandatória (`if (!this.#hasVoiceSpeak(state, args.memberKeyHex)) return { ok: false, code: 'E_PERMISSION_DENIED' }`). No entanto, no método de varredura [sweepAgainst()](file:///home/rebis/projetos/software/core/src/l2/voiceCoordinator/host.ts#L611-L648), a elegibilidade é verificada unicamente através de [`#memberEligible(state, keyHex, now)`](file:///home/rebis/projetos/software/core/src/l2/voiceCoordinator/host.ts#L740-L751), que não consulta `#hasVoiceSpeak`. Da mesma forma, [`renewTicket()`](file:///home/rebis/projetos/software/core/src/l2/voiceCoordinator/host.ts#L581-L582) valida apenas `#memberEligible`.
- **Cenário de falha:**
  1. O usuário A entra em um canal de voz com permissão `voice_speak`.
  2. Um administrador remove o cargo com `voice_speak` de A ou altera as permissões do cargo no log.
  3. O fold projeta a mudança e aciona `host.voice.sweepAgainst(estrutural)`.
  4. O participante A não é removido da chamada e não tem sua sessão revogada (`#remove` não é chamado).
  5. Se o canal estiver em `speechMode: free (0)`, o microfone de A permanece aberto e o host continua renovando os `MediaTicket`s de A em `renewTicket()`.
- **Evidência:** `docs/backend-v2.md` §17.4 ("voice.join → o host valida voice_speak...").
Em `core/src/l2/voiceCoordinator/host.ts`:
```typescript
      for (const keyHex of [...session.participants.keys()]) {
        if (!this.#memberEligible(state, keyHex, now).ok) {
          emitted.push(this.#remove(session, keyHex, 'moderation'));
        }
      }
```
- **Confiança:** alta.

---

### [severidade: baixo] Validação permissiva de delimitadores em `parseTurnUsername`
- **Local:** `core/src/l2/communityHost/stunTurn.ts:425-432`
- **Hipótese investigada:** Validação e parsing de integridade do formato de credenciais temporárias TURN RFC 5766.
- **O que acontece:** O formato normativo do username TURN é `<sessionId>:<expiresAt>` (§17.3). A função `parseTurnUsername` utiliza `username.lastIndexOf(':')` e aceita qualquer string como prefixo, permitindo usernames com múltiplos delimitadores ou caracteres de controle antes do timestamp.
- **Cenário de falha:** Uma requisição com username malformado como `a:b:c:1700000000` é interpretada com `sessionId = "a:b:c"`. Embora o cálculo HMAC de validação subsequente falhe caso a chave não coincida, o formato viola o princípio de validação sintática estrita antes de consultar o armazenamento de segredos da comunidade.
- **Evidência:** `core/src/l2/communityHost/stunTurn.ts`:
```typescript
export function parseTurnUsername(username: string): { sessionId: string; expiresAt: number } | null {
  const sep = username.lastIndexOf(':');
  if (sep < 0) return null;
  const sessionId = username.slice(0, sep);
  const expiresAt = Number.parseInt(username.slice(sep + 1), 10);
  if (sessionId.length === 0 || !Number.isFinite(expiresAt)) return null;
  return { sessionId, expiresAt };
}
```
- **Confiança:** alta.

---

## Avaliação das Hipóteses de Investigação

1. **Participante Fantasma na Fila de Karaokê (Refutada):** A fila **não** trava eternamente. A emenda de 2026-09-05 implementou `fila.reconciliar(snapshot.channelId, new Set(alvos))` vinculado diretamente ao callback `onRosterChanged` do coordenador de voz ([boot.ts:1485](file:///home/rebis/projetos/software/core/src/composition/boot.ts#L1485)). Quando um participante cai (seja imediatamente pelo fechamento do socket/cabo via `dropPeer`, seja pelo watchdog `sweepLiveness` em até `VOICE_LIVENESS_MS`), o roster é emitido sem o par ausente; `reconciliar` purga o titular ausente e promove imediatamente o próximo da fila, acionando `voice.imporTurno` para abrir o microfone do novo titular.
2. **Vazamento de Tickets de Sessão de Tela (Confirmada):** Ocorre vazamento crítico. `sweepAgainst` em `shareStar/sessions.ts` não valida a posse da permissão `voice_share_screen` (`SHARE_SCREEN`). A sessão sobrevive à revogação e continua emitindo novos `MediaTicket`s no `share.join`.
3. **Validação de Integridade TURN RFC 5389 / RFC 5766 (Confirmada na separação de responsabilidades):** A função `addMessageIntegrity` em `stunTurn.ts` apenas empacota e assina a mensagem com HMAC-SHA1 ajustando o header de comprimento; a validação real ocorre em `verifyMessageIntegrity` e `#authenticate`. As rotinas cumprem estritamente a RFC 5389 §15.4 (recalculando o cabeçalho excluindo o offset do MI e rejeitando atributos posteriores exceto FINGERPRINT). O cancelamento de credenciais na revogação funciona via `#server.revoke(peerKeyHex)` fechando as alocações ativas.
4. **Recuperação de Degradação de Tela em `shareStar/health.ts` (Comportamento por Projeto Normativo):** A taxa de bits **não** se recupera automaticamente quando a perda de pacotes cessa, permanecendo no nível degradado mínimo até que o apresentador execute `share.setQuality`. Isso não é um bug de implementação, mas sim uma decisão normativa explícita de §17.5 ("'Só desce' é decisão, e o caminho de volta é o passo 1... Não há recuperação automática no v1, e não há número a inventar para ela").

---

## Lacunas de especificação

1. **Critérios de Revogação Imediata vs. Permissões de Cargo:** A seção §17.4 lista exaustivamente eventos de moderação no log (`mod.ban`, `mod.kick`, `mod.timeout`, `channel.delete`, `voice.leave`), mas não define explicitamente o comportamento quando um membro perde uma permissão específica (`voice_speak` ou `voice_share_screen`) via edição de cargos (`role.update` / `role.assign`). O código adotou apenas checagens de banimento/saída no `sweepAgainst`, gerando uma assimetria com as regras de entrada (`voice.join` e `share.start`).
2. **Modelo de Validação de Sinalização no Host:** A especificação §17.4 passo 3 determina que o núcleo deve inspecionar e validar ingressos de sinalização antes do renderer, mas o desenho de componentes em §16.3 assumiu que o host atua apenas como produtor/encaminhador de eventos e não como consumidor de notificações de sinalização destinadas a si mesmo, abrindo o bypass constatado no nó hospedeiro.
