import { useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { Network, RefreshCw, ShieldAlert } from "lucide-react";
import { Avatar } from "../../components/ui/Avatar";
import { Button } from "../../components/ui/Button";
import { TextField } from "../../components/ui/TextField";
import { cn } from "../../lib/cn";
import { avatarColorFromSeed, nextAvatarColor } from "../../lib/avatar";
import { mensagemDeErro, useSessao } from "../../live/sessao";
import { numeroDaCor } from "../../ipc/cores";
import { codePointsNormalizados } from "../../lib/texto";
import type { AvatarColor } from "../../domain/types";

/**
 * §8.6 — `displayName`: 2 a 32 **code points**, medidos DEPOIS de `trim`, colapso de
 * espaço interno e NFKC. É a mesma conta de `checkDisplayName` no núcleo, e a tela
 * precisa fazê-la igual: contando `String.length` (UTF-16) ela aceitava um emoji
 * sozinho — 2 unidades, 1 code point — que o núcleo devolvia como `E_VALIDATION`,
 * e recusava vinte emojis, que o núcleo aceitaria.
 */
const NAME_MIN = 2;
const NAME_MAX = 32;
/** Acima disto o contador vira `feedback-warning` (§7, 0.1). */
const NAME_WARNING_AT = 28;

/** Casado com `--duration-slow` (§5.9) — transição de tela cheia. */
const SUCCESS_TRANSITION_MS = 320;

type Phase = "editing" | "submitting" | "gate" | "success";

function validate(rawName: string): string | undefined {
  const n = codePointsNormalizados(rawName);
  if (n === 0) return "Digite um nome de exibição.";
  if (n < NAME_MIN)
    return `O nome precisa ter pelo menos ${NAME_MIN} caracteres.`;
  // O campo já clampa em `NAME_MAX` code points, mas o colapso de espaço e o NFKC
  // rodam depois: o ramo existe porque o núcleo mede o texto normalizado, e sem ele
  // a tela não tinha o que dizer quando essa conta discordasse.
  if (n > NAME_MAX)
    return `O nome pode ter no máximo ${NAME_MAX} caracteres.`;
  return undefined;
}

/**
 * 0.1 Onboarding / criar identidade — fluxo A1 sobre a IPC-R.
 *
 * A criação é a primeira **escrita** do produto (`identity.create`, §15.4):
 * o par de chaves nasce no núcleo e é o cofre quem o wrapa — esta tela não
 * gera nada sozinha. Sem cofre de sistema, o núcleo recusa com
 * `E_KEYSTORE_INSECURE` (§3.2 L-2) e o aceite explícito entra aqui, na
 * decisão que a limitação declarada exige ser consciente.
 */
export function OnboardingScreen() {
  const [name, setName] = useState("");
  const [avatarColor, setAvatarColor] = useState<AvatarColor>(() =>
    avatarColorFromSeed(crypto.randomUUID()),
  );
  const [error, setError] = useState<string | undefined>();
  const [phase, setPhase] = useState<Phase>("editing");
  /** L-2 — o aceite do modo inseguro; o botão só abre com a caixa marcada. */
  const [aceite, setAceite] = useState(false);
  const [aceitando, setAceitando] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(window.clearTimeout);
  }, []);

  const isValid = validate(name) === undefined;

  function handleNameChange(value: string) {
    setName(value);
    // Erro some assim que o campo volta a ser válido; o contador é a
    // validação em tempo real, o erro é do submit/blur (§7, 0.1).
    if (error && validate(value) === undefined) setError(undefined);
  }

  async function criar() {
    // Cor é u8 na escrita (§6.4.2): o token de tema vira constante de
    // protocolo só no limite da fronteira.
    const cor = numeroDaCor(avatarColor);
    if (cor === null) {
      setError("Cor fora do catálogo do protocolo.");
      setPhase("editing");
      return;
    }
    setPhase("submitting");
    try {
      await useSessao.getState().criarIdentidade({
        displayName: name.trim(),
        avatarColor: cor,
      });
      setPhase("success");
      // A rota troca quando `query.identity` encher a store; a transição
      // de saída só precisa durar o suficiente para ser vista (§7, 0.1).
      timers.current.push(
        window.setTimeout(() => {}, SUCCESS_TRANSITION_MS),
      );
    } catch (e) {
      if ((e as { code?: string }).code === "E_KEYSTORE_INSECURE") {
        setAceite(false);
        setPhase("gate");
        return;
      }
      setError(mensagemDeErro(e));
      setPhase("editing");
    }
  }

  /** L-2 — aceite registrado no núcleo; a criação é reencaixada em seguida. */
  async function aceitarECriar() {
    setAceitando(true);
    try {
      await useSessao.getState().aceitarCofreInseguro();
      await criar();
    } catch (e) {
      setError(mensagemDeErro(e));
      setPhase("editing");
    } finally {
      setAceitando(false);
    }
  }

  /**
   * Enter com campo inválido mostra o mesmo erro inline, sem navegar
   * (§11, A1 exceções) — o submit implícito não dispara com o botão
   * primário desabilitado, então tratamos aqui.
   */
  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter" || isValid) return;
    event.preventDefault();
    setError(validate(name));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (phase !== "editing") return;

    const validationError = validate(name);
    if (validationError) {
      setError(validationError);
      inputRef.current?.focus();
      return;
    }

    void criar();
  }

  return (
    <main className="flex min-h-full items-center justify-center bg-surface-app px-4 py-8 tablet:px-8">
      <div
        className={cn(
          "w-full max-w-[420px] transition-all ease-in duration-(--duration-slow)",
          phase === "success" && "-translate-y-2 opacity-0",
        )}
      >
        <div className="mb-8 flex items-center gap-2">
          <span
            className="grid size-8 place-items-center rounded-lg bg-accent-default text-text-on-accent"
            aria-hidden="true"
          >
            <Network size={18} strokeWidth={2} />
          </span>
          <span className="text-body-emphasis text-text-secondary">
            Comunidade P2P
          </span>
        </div>

        <h1 className="text-heading-1 text-text-primary">Crie sua identidade</h1>
        <p className="mt-2 text-body text-text-secondary">
          Não existe conta nem servidor central aqui. Sua identidade é um par de
          chaves gerado agora e guardado só neste dispositivo.
        </p>

        {phase === "gate" ? (
          <div className="mt-6 flex flex-col gap-4 rounded-md border border-border-default bg-surface-sidebar p-4">
            <div className="flex items-center gap-2">
              <ShieldAlert
                size={20}
                strokeWidth={2}
                className="shrink-0 text-conn-degraded"
                aria-hidden="true"
              />
              <p className="text-body-emphasis text-text-primary">
                Sem cofre de chaves neste sistema
              </p>
            </div>
            <p className="text-meta text-text-secondary">
              Não há um cofre de chaves do sistema disponível. A identidade
              seria guardada com proteção local fraca: quem tiver acesso aos
              arquivos deste dispositivo pode ler as chaves.
            </p>
            <label className="flex items-start gap-2 text-meta text-text-secondary">
              <input
                type="checkbox"
                checked={aceite}
                onChange={(event) => setAceite(event.target.checked)}
                className="mt-0.5"
              />
              Entendo os riscos e quero criar a identidade assim mesmo.
            </label>
            {error !== undefined && (
              <p className="text-meta text-feedback-danger">{error}</p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setAceite(false);
                  setError(undefined);
                  setPhase("editing");
                }}
              >
                Voltar
              </Button>
              <Button
                variant="danger"
                size="sm"
                disabled={!aceite}
                loading={aceitando}
                onClick={() => void aceitarECriar()}
              >
                Aceitar e continuar
              </Button>
            </div>
          </div>
        ) : (
          <>
            <form className="mt-6 flex flex-col gap-6" onSubmit={handleSubmit}>
              <TextField
                ref={inputRef}
                label="Nome de exibição"
                value={name}
                onChange={handleNameChange}
                onKeyDown={handleKeyDown}
                onBlur={() => setError(validate(name))}
                error={error}
                placeholder="Como as pessoas vão te ver"
                limiteCp={NAME_MAX}
                counterWarningAt={NAME_WARNING_AT}
                showCounter
                autoFocus
                autoComplete="off"
                spellCheck={false}
                disabled={phase !== "editing"}
              />

              <div className="flex items-center gap-4 rounded-md border border-border-default bg-surface-sidebar p-4">
                <Avatar
                  name={name}
                  color={avatarColor}
                  size="lg"
                  presenceRingClass="border-surface-sidebar"
                />
                <div className="flex min-w-0 flex-col items-start gap-2">
                  <p className="text-body-emphasis text-text-primary">Seu avatar</p>
                  <p className="text-meta text-text-tertiary">
                    As iniciais do seu nome sobre uma cor sorteada. Sem upload de
                    imagem nesta versão.
                  </p>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setAvatarColor(nextAvatarColor(avatarColor))}
                    disabled={phase !== "editing"}
                    leadingIcon={<RefreshCw size={16} strokeWidth={2} />}
                  >
                    Gerar outra cor
                  </Button>
                </div>
              </div>

              {error !== undefined && (
                <p className="-mt-4 text-meta text-feedback-danger">{error}</p>
              )}

              <Button
                type="submit"
                size="lg"
                fullWidth
                disabled={!isValid}
                loading={phase === "submitting"}
              >
                Criar identidade
              </Button>
            </form>

            <p className="mt-6 text-meta text-text-tertiary">
              A chave privada nunca sai deste dispositivo — e não há como
              recuperá-la em outro lugar.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
