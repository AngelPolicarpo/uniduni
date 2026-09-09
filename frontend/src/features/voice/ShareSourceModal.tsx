import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppWindow,
  Check,
  Monitor,
  RefreshCw,
  Volume2,
  VolumeX,
} from "lucide-react";
import { cn } from "../../lib/cn";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { Skeleton } from "../../components/ui/Skeleton";
import { Toggle } from "../../components/ui/Toggle";
import type { CaptureSource } from "../../ipc/bridge";
import type { ShareQuality } from "../../store/voiceStore";

/**
 * §17.5 — **o seletor de fonte do produto**: o que transmitir, com que som e em que perfil.
 *
 * Esta tela escolhia só o *tipo* (tela inteira ou janela) e deixava a fonte concreta para
 * "o seletor do sistema". O seletor do sistema não existia: no Linux nunca houve, e no
 * Windows o `useSystemPicker` do Electron só entra quando
 * `isDisplayMediaSystemPickerAvailable()` responde `true` — fora disso o main caía em
 * `desktopCapturer.getSources(...)[0]`, a primeira janela que o sistema listasse. "Uma
 * janela" era, literalmente, um botão que não escolhia janela nenhuma.
 *
 * Agora a lista é daqui e as miniaturas são reais: `id`, nome e imagem vêm do
 * `desktopCapturer` pelo main, e o `id` escolhido viaja na declaração de captura (§17.5,
 * `T-41`) para que o handler conceda **aquela** fonte. Nada aqui é inventado pela UI — o
 * nome de cada janela é o que o sistema diz que ela é.
 *
 * **A ordem de `T-41` não muda.** Listar não é capturar: nenhuma trilha abre nesta tela, e
 * a autorização continua sendo `share.start` → o host decide → `captureToken` →
 * `getDisplayMedia`. O que a escolha faz é dizer *qual* fonte, quando a captura for
 * concedida.
 */

interface SuporteDeCaptura {
  screen: boolean;
  window: boolean;
  platform: string;
  /** O sistema é quem escolhe a fonte (Wayland/`xdg-desktop-portal`) — ver o main. */
  systemPicker: boolean;
}

type Tipo = "screen" | "window";

const TIPOS: Array<{ id: Tipo; label: string; icon: typeof Monitor }> = [
  { id: "screen", label: "Tela inteira", icon: Monitor },
  { id: "window", label: "Uma janela", icon: AppWindow },
];

/** §17.5 — `high` 2500 kbps · `balanced` 1200 · `low` 600. */
const QUALIDADES: Array<{ id: ShareQuality; label: string; hint: string }> = [
  { id: "high", label: "Alta", hint: "2500 kbps — texto pequeno legível" },
  { id: "balanced", label: "Equilibrada", hint: "1200 kbps — o padrão" },
  { id: "low", label: "Baixa", hint: "600 kbps — conexões apertadas" },
];

/**
 * O áudio é opt-in e o texto muda com o tipo, porque a promessa muda com o tipo: numa
 * janela existe o que isolar, numa tela inteira não existe — e prometer "só desta janela"
 * ao compartilhar o monitor seria anunciar um recorte que ninguém faz.
 */
const AUDIO_COPY: Record<Tipo, { label: string; hint: string }> = {
  window: {
    label: "Transmitir o áudio da janela",
    hint: "Só o som do aplicativo escolhido; o resto da máquina não vai junto.",
  },
  screen: {
    label: "Transmitir o áudio do sistema",
    hint: "Tudo o que estiver tocando nesta máquina.",
  },
};

export interface ShareSourceModalProps {
  onSelect: (a: {
    kind: Tipo;
    quality: ShareQuality;
    sourceId: string | null;
    audio: boolean;
  }) => void;
  onClose: () => void;
}

export function ShareSourceModal({ onSelect, onClose }: ShareSourceModalProps) {
  const [kind, setKind] = useState<Tipo>("screen");
  const [quality, setQuality] = useState<ShareQuality>("balanced");
  const [audio, setAudio] = useState(false);
  const [fontes, setFontes] = useState<CaptureSource[] | null>(null);
  const [escolhida, setEscolhida] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [suporte, setSuporte] = useState<SuporteDeCaptura | null>(null);

  /**
   * **Quem escolhe a fonte: esta tela, ou o sistema?**
   *
   * Dois caminhos onde a escolha NÃO é nossa, e por motivos diferentes:
   *
   * - Fora do Electron — o `npm run dev` do frontend — não há main para listar fonte
   *   nenhuma, e quem pergunta é o navegador. Inventar uma lista de janelas ali seria o
   *   mesmo mock que §17.5 tirou daqui.
   * - No **Wayland**, listar é pedir permissão: `getSources` abre a caixa do
   *   `xdg-desktop-portal`, e a resposta dela É a escolha da pessoa. Insistir no seletor do
   *   produto mostrava a caixa do sistema, depois a nossa, e depois a do sistema de novo —
   *   e a captura nunca subia, porque o id da primeira sessão do portal não existe na
   *   segunda.
   *
   * Enquanto `suporte` não chegou, ninguém lista: perguntar antes de saber de quem é a
   * escolha é exatamente como a caixa do sistema aparecia cedo demais.
   */
  const temPonte = typeof window.electron?.listCaptureSources === "function";
  const escolhoAqui = temPonte && suporte !== null && !suporte.systemPicker;

  const listar = useCallback(
    async (tipo: Tipo) => {
      const listarFontes = window.electron?.listCaptureSources;
      if (listarFontes === undefined) return;
      setCarregando(true);
      setFontes(null);
      setEscolhida(null);
      try {
        const r = await listarFontes({ kind: tipo });
        setFontes(r);
        // Uma tela inteira numa máquina de um monitor só não é escolha: pré-selecionar
        // poupa um clique que não decide nada. Janela é sempre escolha da pessoa.
        setEscolhida(tipo === "screen" && r.length === 1 ? (r[0]?.id ?? null) : null);
      } catch {
        setFontes([]);
        setEscolhida(null);
      } finally {
        setCarregando(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!escolhoAqui) return;
    setFontes(null);
    setEscolhida(null);
    void listar(kind);
  }, [kind, listar, escolhoAqui]);

  useEffect(() => {
    void window.electron
      ?.captureSupport?.()
      .then(setSuporte)
      // Ponte de um shell anterior, sem esta pergunta: o caminho honesto é o do navegador —
      // sem lista nossa e sem promessa de áudio.
      .catch(() => setSuporte({ screen: false, window: false, platform: "?", systemPicker: true }));
  }, []);

  /**
   * A plataforma entrega áudio de captura? A pergunta é do main porque a resposta é do
   * sistema: o loopback do Electron é do Windows. Onde não há, o controle aparece
   * desligado e dizendo por quê — melhor que um botão que liga e não faz som.
   */
  const audioDisponivel = suporte === null ? false : suporte[kind];
  const audioEfetivo = audio && audioDisponivel;

  // Trocar de tipo troca a promessa do áudio; manter o pedido anterior ligado faria a
  // pessoa transmitir o som da máquina achando que escolheu o de uma janela.
  useEffect(() => {
    setAudio(false);
  }, [kind]);

  // Onde a escolha é do sistema, não há o que esperar aqui: o botão só entrega a vez.
  const podeCompartilhar = !escolhoAqui || escolhida !== null;

  /**
   * `id` explícito existe para o duplo clique: o primeiro clique só agenda a mudança de
   * estado, então o `escolhida` desta closure ainda é o de antes — confirmar por ele
   * transmitiria a fonte anterior, ou nenhuma. Quem sabe qual card foi clicado é o card.
   */
  function confirmar(id?: string): void {
    const fonte = id ?? escolhida;
    if (escolhoAqui && fonte === null) return;

    onSelect({ kind, quality, sourceId: fonte, audio: audioEfetivo });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Compartilhar tela"
      size="xl"
      bodyClassName="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex items-center justify-between gap-4 px-6 pt-4">
        {/*
          As abas escolhem o TIPO, e só existem quando a fonte é escolhida aqui. Onde quem
          pergunta é o sistema, ele pergunta tela-ou-janela junto — repetir a pergunta antes
          faria a pessoa escolher duas vezes e a primeira não valeria nada.
        */}
        <div
          role="tablist"
          aria-label="O que transmitir"
          className={cn(
            "flex items-center gap-1 rounded-md bg-surface-primary p-1",
            !escolhoAqui && "hidden",
          )}
        >
          {TIPOS.map((t) => {
            const ativo = kind === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={ativo}
                onClick={() => setKind(t.id)}
                className={cn(
                  "flex h-8 items-center gap-2 rounded-sm px-3 text-body-emphasis",
                  "transition-colors duration-(--duration-fast) ease-out",
                  ativo
                    ? "bg-surface-elevated text-text-primary"
                    : "text-text-secondary hover:text-text-primary",
                )}
              >
                <t.icon size={16} strokeWidth={2} aria-hidden="true" />
                {t.label}
              </button>
            );
          })}
        </div>

        {escolhoAqui && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void listar(kind)}
            disabled={carregando}
            leadingIcon={
              <RefreshCw
                size={16}
                strokeWidth={2}
                aria-hidden="true"
                className={cn(carregando && "animate-spin")}
              />
            }
          >
            Atualizar
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {escolhoAqui ? (
          <GradeDeFontes
            fontes={fontes}
            carregando={carregando}
            kind={kind}
            escolhida={escolhida}
            onEscolher={setEscolhida}
            onConfirmar={confirmar}
          />
        ) : (
          <p className="text-body text-text-secondary">
            {suporte === null
              ? "Preparando…"
              : suporte.systemPicker
                ? "Este sistema pergunta o que transmitir na própria janela dele — tela inteira ou uma janela, você escolhe lá. Ela abre depois de você confirmar aqui."
                : kind === "window"
                  ? "O navegador vai perguntar qual janela transmitir."
                  : "O navegador vai perguntar qual tela transmitir."}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-4 border-t border-border-subtle px-6 py-4">
        {/*
          Qualidade e áudio são o mesmo tipo de decisão — como a transmissão sai desta
          máquina —, então moram no mesmo bloco. Separá-los em caixas diferentes fazia a
          régua da esquerda quebrar duas vezes na mesma altura da tela.
        */}
        <div className="divide-y divide-border-subtle rounded-md border border-border-subtle bg-surface-primary">
          <fieldset className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
            <legend className="sr-only">Qualidade</legend>
            <span className="text-body text-text-primary">Qualidade</span>
            <div className="flex flex-wrap gap-1.5">
              {QUALIDADES.map((q) => (
                <button
                  key={q.id}
                  type="button"
                  aria-pressed={quality === q.id}
                  onClick={() => setQuality(q.id)}
                  title={q.hint}
                  className={cn(
                    "rounded-full border px-3 py-1 text-meta",
                    "transition-colors duration-(--duration-fast) ease-out",
                    quality === q.id
                      ? "border-border-strong bg-surface-elevated text-text-primary"
                      : "border-border-default text-text-secondary hover:border-border-strong",
                  )}
                >
                  {q.label}
                </button>
              ))}
            </div>
          </fieldset>

          <div className="flex items-start gap-3 px-3 py-2.5">
            {audioEfetivo ? (
              <Volume2
                size={20}
                strokeWidth={2}
                aria-hidden="true"
                className="mt-0.5 shrink-0 text-accent-default"
              />
            ) : (
              <VolumeX
                size={20}
                strokeWidth={2}
                aria-hidden="true"
                className="mt-0.5 shrink-0 text-text-tertiary"
              />
            )}
            <div className="min-w-0 flex-1">
              <Toggle
                checked={audioEfetivo}
                onChange={setAudio}
                disabled={!audioDisponivel}
                label={AUDIO_COPY[kind].label}
                description={
                  audioDisponivel
                    ? AUDIO_COPY[kind].hint
                    : "Esta plataforma não entrega áudio junto com a captura de tela."
                }
              />
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4">
          {/*
            O rodapé responde à pergunta do momento: enquanto falta escolher, ele diz o que
            falta; escolhido, volta a dizer quem vai ver. Um botão desabilitado sem motivo
            visível é a forma mais comum de tela travada sem explicação.
          */}
          <p className="text-meta text-text-tertiary">
            {podeCompartilhar
              ? "Quem está na chamada pode assistir."
              : kind === "window"
                ? "Escolha a janela que você quer transmitir."
                : "Escolha a tela que você quer transmitir."}
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancelar
            </Button>
            <Button onClick={() => confirmar()} disabled={!podeCompartilhar}>
              Compartilhar
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

interface GradeDeFontesProps {
  fontes: CaptureSource[] | null;
  carregando: boolean;
  kind: Tipo;
  escolhida: string | null;
  onEscolher: (id: string) => void;
  onConfirmar: (id: string) => void;
}

/**
 * A grade de fontes. `radiogroup` e não uma lista de botões: é **uma** escolha entre
 * várias, e é isso que o teclado precisa ouvir — Tab entra no grupo, as setas andam dentro
 * dele. Uma grade de botões faria o Tab visitar quinze janelas antes de chegar em
 * "Compartilhar".
 */
function GradeDeFontes({
  fontes,
  carregando,
  kind,
  escolhida,
  onEscolher,
  onConfirmar,
}: GradeDeFontesProps) {
  const refs = useRef(new Map<string, HTMLButtonElement>());

  const ids = useMemo(() => (fontes ?? []).map((f) => f.id), [fontes]);

  function aoTeclar(e: React.KeyboardEvent, id: string): void {
    const passo =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    if (passo === 0) return;
    e.preventDefault();
    const i = ids.indexOf(id);
    // Circular: numa grade curta, esbarrar na borda é mais atrapalho que proteção.
    const alvo = ids[(i + passo + ids.length) % ids.length];
    if (alvo === undefined) return;
    onEscolher(alvo);
    refs.current.get(alvo)?.focus();
  }

  if (fontes === null || (carregando && fontes.length === 0)) {
    return (
      <div className="grid grid-cols-2 gap-3 tablet:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="flex flex-col gap-2">
            <Skeleton className="aspect-video w-full rounded-md" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        ))}
      </div>
    );
  }

  if (fontes.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-center">
        {kind === "window" ? (
          <AppWindow size={24} strokeWidth={2} aria-hidden="true" className="text-text-tertiary" />
        ) : (
          <Monitor size={24} strokeWidth={2} aria-hidden="true" className="text-text-tertiary" />
        )}
        <p className="text-body text-text-secondary">
          {kind === "window"
            ? "Nenhuma janela aberta para transmitir"
            : "Nenhuma tela disponível"}
        </p>
        <p className="text-meta text-text-tertiary">
          {kind === "window"
            ? "Abra o aplicativo que você quer mostrar e use Atualizar."
            : "Verifique as permissões de gravação de tela do sistema."}
        </p>
      </div>
    );
  }

  return (
    <div
      role="radiogroup"
      aria-label={kind === "window" ? "Janelas abertas" : "Telas disponíveis"}
      className="grid grid-cols-2 gap-3 tablet:grid-cols-3"
    >
      {fontes.map((f) => {
        const ativo = escolhida === f.id;
        return (
          <button
            key={f.id}
            ref={(el) => {
              if (el === null) refs.current.delete(f.id);
              else refs.current.set(f.id, el);
            }}
            type="button"
            role="radio"
            aria-checked={ativo}
            // Roving tabindex: só o selecionado (ou o primeiro) está na ordem do Tab.
            tabIndex={ativo || (escolhida === null && f.id === fontes[0]?.id) ? 0 : -1}
            onClick={() => onEscolher(f.id)}
            // Duplo clique é "esta, e vamos": escolhe e confirma no mesmo gesto.
            onDoubleClick={() => onConfirmar(f.id)}
            onKeyDown={(e) => aoTeclar(e, f.id)}
            className={cn(
              "group flex flex-col gap-2 rounded-md border p-2 text-left",
              "transition-colors duration-(--duration-fast) ease-out",
              ativo
                ? "border-accent-default bg-accent-muted-bg"
                : "border-border-default bg-surface-primary hover:border-border-strong hover:bg-surface-elevated",
            )}
          >
            <span className="relative block aspect-video w-full overflow-hidden rounded-sm bg-surface-app">
              {f.thumbnail === null ? (
                <span className="grid h-full w-full place-items-center">
                  <Monitor
                    size={20}
                    strokeWidth={2}
                    aria-hidden="true"
                    className="text-text-tertiary"
                  />
                </span>
              ) : (
                <img
                  src={f.thumbnail}
                  alt=""
                  className="h-full w-full object-contain"
                  draggable={false}
                />
              )}
              {ativo && (
                <span
                  aria-hidden="true"
                  className="absolute top-1.5 right-1.5 grid size-5 place-items-center rounded-full bg-accent-default text-text-on-accent"
                >
                  <Check size={12} strokeWidth={3} />
                </span>
              )}
            </span>

            <span className="flex min-w-0 items-center gap-2">
              {f.appIcon !== null && (
                <img src={f.appIcon} alt="" className="size-4 shrink-0" draggable={false} />
              )}
              <span
                className={cn(
                  "truncate text-meta",
                  ativo ? "text-text-primary" : "text-text-secondary",
                )}
                title={f.name}
              >
                {f.name}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
