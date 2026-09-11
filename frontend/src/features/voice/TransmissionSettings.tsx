import { useState } from "react";
import { ChevronLeft, ChevronRight, MonitorX } from "lucide-react";
import { cn } from "../../lib/cn";
import { Button } from "../../components/ui/Button";
import { TextField } from "../../components/ui/TextField";
import { useVoiceStore, type ShareQuality } from "../../store/voiceStore";

/**
 * §17.5 — os ajustes da transmissão, **do apresentador e só dele**.
 *
 * Três coisas, e as três decidem o que sai desta máquina: resolução e taxa de quadros da
 * captura, que são `applyConstraints` na trilha local (a mesma natureza do mudo efetivo de
 * §17.4 L-12 — quem possui o dispositivo decide o que sai dele), e o perfil de qualidade de
 * §17.5, que é o teto de banda por espectador e passa pelo host.
 *
 * **A forma é menu, não formulário.** Quem apresenta mexe nisto no meio de uma conversa,
 * com a grade da chamada atrás: uma lista densa de linhas clicáveis lê e opera mais rápido
 * que três `fieldset` de pílulas empilhadas, e é o mesmo idioma do `Menu` de §6 — daí as
 * classes serem as dele.
 *
 * **Os modos vêm primeiro porque o número quase nunca é a pergunta.** Ninguém quer "720p a
 * 30 fps": quer que o movimento não trave, ou que o texto fique legível. Os dois modos
 * nomeiam a intenção e resolvem os três valores de uma vez; `Personalizado` abre os números
 * para quem tem motivo para discordar.
 *
 * Resolução e quadros abrem em **drill-down**, não em submenu lateral: o popover já está
 * ancorado num botão que pode estar perto da borda, e um segundo nível flutuante teria de
 * resolver colisão de viewport de novo. Trocar o conteúdo com um "voltar" tem o mesmo
 * alcance e nenhuma dessas arestas.
 */

/** `null` = sem restrição, que é o padrão de `getDisplayMedia`. */
const RESOLUCOES: Array<{ label: string; height: number | null }> = [
  { label: "Original da fonte", height: null },
  { label: "1080p", height: 1080 },
  { label: "720p", height: 720 },
  { label: "480p", height: 480 },
];

const QUADROS: Array<{ label: string; fps: number | null }> = [
  { label: "Original da fonte", fps: null },
  { label: "60 fps", fps: 60 },
  { label: "30 fps", fps: 30 },
  { label: "15 fps", fps: 15 },
];

/** §17.5 — `high` 2500 kbps · `balanced` 1200 · `low` 600. Números do contrato. */
const QUALIDADES: Array<{ id: ShareQuality; label: string; hint: string }> = [
  { id: "high", label: "Alta", hint: "2500 kbps" },
  { id: "balanced", label: "Equilibrada", hint: "1200 kbps" },
  { id: "low", label: "Baixa", hint: "600 kbps" },
];

/**
 * Modos nomeados pela intenção. Cada um fixa os três valores de uma vez — é a única coisa
 * nesta tela que não é um número solto, e é a que resolve o caso de quase todo mundo.
 */
interface Modo {
  id: string;
  label: string;
  descricao: string;
  height: number | null;
  frameRate: number | null;
  quality: ShareQuality;
}

const MODOS: Modo[] = [
  {
    id: "movimento",
    label: "Movimento",
    descricao: "Fluido, em 720p a 30 fps",
    height: 720,
    frameRate: 30,
    quality: "balanced",
  },
  {
    id: "leitura",
    label: "Leitura",
    descricao: "Texto nítido, em 1080p a 15 fps",
    height: 1080,
    frameRate: 15,
    quality: "high",
  },
];

const ALTURA_MIN = 144;
const ALTURA_MAX = 2160;
const FPS_MIN = 1;
const FPS_MAX = 120;

/** Rótulo de seção — o "MODO DE TRANSMISSÃO" da referência. */
function Secao({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-3 pt-2 pb-1 text-caption text-text-tertiary uppercase">
      {children}
    </p>
  );
}

function Divisor() {
  return <hr className="my-1 border-t border-border-subtle" />;
}

/** Uma linha de menu: rótulo + descrição à esquerda, o que for à direita. */
function Linha({
  label,
  descricao,
  direita,
  onClick,
  danger = false,
  icon,
}: {
  label: string;
  descricao?: string;
  direita?: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left",
        "transition-colors duration-(--duration-fast) ease-out",
        danger ? "hover:bg-feedback-danger/15" : "hover:bg-accent-muted-bg",
      )}
    >
      {icon && (
        <span className={cn("shrink-0", danger ? "text-feedback-danger" : "text-text-secondary")}>
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block text-body-emphasis",
            danger ? "text-feedback-danger" : "text-text-primary",
          )}
        >
          {label}
        </span>
        {descricao !== undefined && (
          <span className="block text-meta text-text-tertiary">{descricao}</span>
        )}
      </span>
      {direita !== undefined && <span className="shrink-0">{direita}</span>}
    </button>
  );
}

/** O círculo de escolha única da referência — forma, não só cor (§5). */
function Radio({ ativo }: { ativo: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid size-4 place-items-center rounded-full border-2",
        ativo ? "border-accent-default" : "border-border-strong",
      )}
    >
      {ativo && <span className="size-2 rounded-full bg-accent-default" />}
    </span>
  );
}

function ValorAtual({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1 text-meta text-text-tertiary">
      {children}
      <ChevronRight size={16} strokeWidth={2} aria-hidden="true" />
    </span>
  );
}

/** Cabeçalho dos níveis internos: um "voltar" que também nomeia onde se está. */
function Voltar({ titulo, onBack }: { titulo: string; onBack: () => void }) {
  return (
    <>
      <button
        type="button"
        onClick={onBack}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left",
          "transition-colors duration-(--duration-fast) ease-out hover:bg-accent-muted-bg",
        )}
      >
        <ChevronLeft size={16} strokeWidth={2} aria-hidden="true" className="text-text-secondary" />
        <span className="text-body-emphasis text-text-primary">{titulo}</span>
      </button>
      <Divisor />
    </>
  );
}

type Nivel = "raiz" | "resolucao" | "quadros" | "qualidade";

export function TransmissionSettings({ onClose }: { onClose?: () => void }) {
  // A transmissão que EU apresento — os ajustes são dela (§17.5).
  const share = useVoiceStore((state) =>
    state.shares.find((s) => s.presenterId === state.localId),
  );
  const captura = useVoiceStore((state) => state.capturaDaTela);
  const setQuality = useVoiceStore((state) => state.setQuality);
  const definirCaptura = useVoiceStore((state) => state.definirCaptura);
  const stopShare = useVoiceStore((state) => state.stopShare);

  const [nivel, setNivel] = useState<Nivel>("raiz");
  const [alturaLivre, setAlturaLivre] = useState("");
  const [fpsLivre, setFpsLivre] = useState("");

  if (share === undefined) return null;

  const modoAtivo = MODOS.find(
    (m) =>
      m.height === captura.height &&
      m.frameRate === captura.frameRate &&
      m.quality === share.quality,
  );

  const rotuloResolucao =
    captura.height === null ? "Original" : `${captura.height}p`;
  const rotuloQuadros =
    captura.frameRate === null ? "Original" : `${captura.frameRate} fps`;
  const rotuloQualidade =
    QUALIDADES.find((q) => q.id === share.quality)?.label ?? "—";

  const aplicarModo = (m: Modo) => {
    void definirCaptura({ height: m.height, frameRate: m.frameRate });
    setQuality(m.quality);
  };

  if (nivel === "resolucao") {
    const alturaNum = Number(alturaLivre);
    const valida =
      alturaLivre !== "" &&
      Number.isInteger(alturaNum) &&
      alturaNum >= ALTURA_MIN &&
      alturaNum <= ALTURA_MAX;
    return (
      <div className="-mx-1 flex flex-col">
        <Voltar titulo="Resolução" onBack={() => setNivel("raiz")} />
        {RESOLUCOES.map((r) => (
          <Linha
            key={r.label}
            label={r.label}
            onClick={() => void definirCaptura({ height: r.height })}
            direita={<Radio ativo={captura.height === r.height} />}
          />
        ))}
        <Divisor />
        <div className="flex items-end gap-2 px-3 py-2">
          <TextField
            label="Altura (px)"
            inputMode="numeric"
            value={alturaLivre}
            onChange={setAlturaLivre}
            placeholder={captura.height === null ? "720" : String(captura.height)}
            {...(alturaLivre !== "" && !valida
              ? { error: `Entre ${ALTURA_MIN} e ${ALTURA_MAX}` }
              : { hint: "A largura acompanha a proporção" })}
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={!valida}
            onClick={() => void definirCaptura({ height: alturaNum })}
          >
            Aplicar
          </Button>
        </div>
      </div>
    );
  }

  if (nivel === "quadros") {
    const fpsNum = Number(fpsLivre);
    const valido =
      fpsLivre !== "" && Number.isInteger(fpsNum) && fpsNum >= FPS_MIN && fpsNum <= FPS_MAX;
    return (
      <div className="-mx-1 flex flex-col">
        <Voltar titulo="Taxa de quadros" onBack={() => setNivel("raiz")} />
        {QUADROS.map((q) => (
          <Linha
            key={q.label}
            label={q.label}
            onClick={() => void definirCaptura({ frameRate: q.fps })}
            direita={<Radio ativo={captura.frameRate === q.fps} />}
          />
        ))}
        <Divisor />
        <div className="flex items-end gap-2 px-3 py-2">
          <TextField
            label="Quadros por segundo"
            inputMode="numeric"
            value={fpsLivre}
            onChange={setFpsLivre}
            placeholder={captura.frameRate === null ? "30" : String(captura.frameRate)}
            {...(fpsLivre !== "" && !valido ? { error: `Entre ${FPS_MIN} e ${FPS_MAX}` } : {})}
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={!valido}
            onClick={() => void definirCaptura({ frameRate: fpsNum })}
          >
            Aplicar
          </Button>
        </div>
      </div>
    );
  }

  if (nivel === "qualidade") {
    return (
      <div className="-mx-1 flex flex-col">
        <Voltar titulo="Qualidade" onBack={() => setNivel("raiz")} />
        {QUALIDADES.map((q) => (
          <Linha
            key={q.id}
            label={q.label}
            descricao={q.hint}
            onClick={() => setQuality(q.id)}
            direita={<Radio ativo={share.quality === q.id} />}
          />
        ))}
        {/*
          §17.5 — a degradação por perda é do sistema, só desce e não tem chave para
          desligar. Dizê-lo aqui evita que o perfil "voltar sozinho" pareça defeito; oferecer
          um interruptor seria prometer um controle que não existe.
        */}
        <p className="px-3 pt-1 pb-2 text-meta text-text-tertiary">
          Com perda alta, o sistema baixa o perfil de quem estiver recebendo mal — sem mexer
          nos outros.
        </p>
      </div>
    );
  }

  return (
    <div className="-mx-1 flex flex-col">
      <Linha
        label="Parar compartilhamento"
        danger
        icon={<MonitorX size={16} strokeWidth={2} aria-hidden="true" />}
        onClick={() => {
          stopShare();
          onClose?.();
        }}
      />

      <Divisor />
      <Secao>Modo de transmissão</Secao>
      {MODOS.map((m) => (
        <Linha
          key={m.id}
          label={m.label}
          descricao={m.descricao}
          onClick={() => aplicarModo(m)}
          direita={<Radio ativo={modoAtivo?.id === m.id} />}
        />
      ))}
      <Linha
        label="Personalizado"
        descricao="Escolha resolução, quadros e banda"
        onClick={() => setNivel("resolucao")}
        direita={<Radio ativo={modoAtivo === undefined} />}
      />

      <Divisor />
      <Linha
        label="Resolução"
        onClick={() => setNivel("resolucao")}
        direita={<ValorAtual>{rotuloResolucao}</ValorAtual>}
      />
      <Linha
        label="Taxa de quadros"
        onClick={() => setNivel("quadros")}
        direita={<ValorAtual>{rotuloQuadros}</ValorAtual>}
      />
      <Linha
        label="Qualidade"
        onClick={() => setNivel("qualidade")}
        direita={<ValorAtual>{rotuloQualidade}</ValorAtual>}
      />

      <Divisor />
      {/*
        O que a fonte está de fato entregando (`getSettings`), não o que foi pedido: entre
        pedir e conseguir há a fonte, que aproxima ou ignora.
      */}
      <p className="px-3 pt-1 pb-2 text-meta text-text-tertiary">
        Entregando {rotuloResolucao === "Original" ? "na resolução da fonte" : rotuloResolucao}
        {captura.frameRate === null ? "" : ` a ${captura.frameRate} fps`}.
      </p>
    </div>
  );
}
