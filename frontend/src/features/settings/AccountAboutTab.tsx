import { useEffect } from "react";
import {
  AlertCircle,
  ArrowUpCircle,
  CheckCircle2,
  Download,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { Button } from "../../components/ui/Button";
import { SettingsSection } from "./SettingsLayout";
import { useUpdateStore } from "../../store/updateStore";

export function AccountAboutTab() {
  const {
    status,
    appVersion,
    verificando,
    baixando,
    inicializar,
    verificarAtualizacao,
    baixarAtualizacao,
    aplicarAtualizacao,
  } = useUpdateStore();

  useEffect(() => {
    void inicializar();
  }, [inicializar]);

  return (
    <>
      <SettingsSection
        title="Sobre o Uniduni"
        description="Aplicativo descentralizado de voz, vídeo e mensagens em tempo real sem servidor central."
      >
        <div className="flex flex-col gap-1.5 rounded-lg border border-border-subtle bg-surface-primary p-3">
          <div className="flex items-center justify-between">
            <span className="text-body font-medium text-text-primary">
              Uniduni
            </span>
            <span className="rounded bg-surface-secondary px-2 py-0.5 text-meta font-mono text-text-secondary">
              v{appVersion || "0.0.0"}
            </span>
          </div>
          <p className="text-meta text-text-tertiary">
            Arquitetura descentralizada (§3.1): Electron + Hypercore + WebRTC.
          </p>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Atualizações do Aplicativo"
        description="Distribuição por releases oficiais públicas e assinadas (§25.7, T-42)."
      >
        {status.status === "checking" && (
          <div className="flex items-center gap-2 text-text-secondary">
            <RefreshCw size={16} className="animate-spin text-conn-reconnecting" />
            <p className="text-body">Verificando se há atualizações...</p>
          </div>
        )}

        {status.status === "not-available" && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-primary p-3">
              <CheckCircle2 size={18} className="shrink-0 text-conn-ok" />
              <p className="text-body text-text-primary">
                Você já está na versão mais recente disponível ({status.version}).
              </p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void verificarAtualizacao()}
              loading={verificando}
              className="self-start"
            >
              <RefreshCw size={14} className="mr-1.5" />
              Verificar novamente
            </Button>
          </div>
        )}

        {status.status === "available" && (
          <div className="flex flex-col gap-3 rounded-lg border border-conn-reconnecting/40 bg-surface-primary p-4">
            <div className="flex items-start gap-2.5">
              <Sparkles size={20} className="mt-0.5 shrink-0 text-conn-reconnecting" />
              <div className="min-w-0 flex-1">
                <p className="text-body font-medium text-text-primary">
                  Nova versão {status.version} disponível!
                </p>
                {status.releaseDate && (
                  <p className="text-meta text-text-tertiary">
                    Lançada em: {new Date(status.releaseDate).toLocaleDateString()}
                  </p>
                )}
                {status.releaseNotes && (
                  <div className="mt-2 max-h-32 overflow-y-auto rounded border border-border-subtle bg-surface-sidebar p-2 text-meta text-text-secondary whitespace-pre-wrap">
                    {status.releaseNotes}
                  </div>
                )}
              </div>
            </div>

            <Button
              variant="primary"
              size="sm"
              onClick={() => void baixarAtualizacao()}
              loading={baixando}
              className="self-start"
            >
              <Download size={14} className="mr-1.5" />
              Baixar atualização
            </Button>
          </div>
        )}

        {status.status === "downloading" && (
          <div className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-surface-primary p-4">
            <div className="flex items-center justify-between text-body">
              <span className="font-medium text-text-primary">
                Baixando atualização...
              </span>
              <span className="font-mono text-text-secondary">
                {status.percent}%
              </span>
            </div>

            <div className="h-2 w-full overflow-hidden rounded-full bg-surface-secondary">
              <div
                className="h-full bg-conn-reconnecting transition-all duration-300"
                style={{ width: `${status.percent}%` }}
              />
            </div>

            <div className="flex justify-between text-meta text-text-tertiary">
              <span>
                {(status.transferred / 1024 / 1024).toFixed(1)} MB de{" "}
                {(status.total / 1024 / 1024).toFixed(1)} MB
              </span>
              <span>
                {(status.bytesPerSecond / 1024 / 1024).toFixed(2)} MB/s
              </span>
            </div>
          </div>
        )}

        {status.status === "ready" && (
          <div className="flex flex-col gap-3 rounded-lg border border-conn-ok/40 bg-surface-primary p-4">
            <div className="flex items-start gap-2.5">
              <ArrowUpCircle size={20} className="mt-0.5 shrink-0 text-conn-ok" />
              <div className="min-w-0 flex-1">
                <p className="text-body font-medium text-text-primary">
                  Atualização v{status.version} pronta para ser aplicada!
                </p>
                <p className="text-meta text-text-secondary">
                  Ao reiniciar, o aplicativo encerrará o estado e fechará as conexões com segurança
                  (ciclo de drenagem de §3.3) antes de iniciar a nova versão.
                </p>
              </div>
            </div>

            <Button
              variant="primary"
              size="sm"
              onClick={() => void aplicarAtualizacao()}
              className="self-start"
            >
              <RefreshCw size={14} className="mr-1.5" />
              Reiniciar e atualizar agora
            </Button>
          </div>
        )}

        {status.status === "error" && (
          <div className="flex flex-col gap-3">
            <div className="flex items-start gap-2.5 rounded-lg border border-conn-failed/40 bg-conn-failed/10 p-3">
              <AlertCircle size={18} className="mt-0.5 shrink-0 text-conn-failed" />
              <div className="min-w-0 flex-1">
                <p className="text-body font-medium text-conn-failed">
                  Falha na atualização
                </p>
                <p className="text-meta text-text-secondary break-words">
                  {status.message}
                </p>
              </div>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void verificarAtualizacao()}
              loading={verificando}
              className="self-start"
            >
              <RefreshCw size={14} className="mr-1.5" />
              Tentar novamente
            </Button>
          </div>
        )}

        {status.status === "idle" && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void verificarAtualizacao()}
            loading={verificando}
            className="self-start"
          >
            <RefreshCw size={14} className="mr-1.5" />
            Verificar se há atualizações
          </Button>
        )}
      </SettingsSection>

      <SettingsSection
        title="Princípios de Segurança"
        description="Conformidade com a integridade e privacidade do projeto."
      >
        <div className="space-y-2 text-meta text-text-secondary">
          <p>
            • <strong>Sem telemetria:</strong> O processo de checagem busca apenas metadados públicos
            estáticos de release no GitHub, sem transmitir nenhum dado sobre você ou sobre suas comunidades.
          </p>
          <p>
            • <strong>Integridade por hash e assinatura:</strong> Todos os pacotes são validados contra
            os blocos e hashes criptográficos oficiais antes de qualquer execução.
          </p>
          <p>
            • <strong>Proteção de dados:</strong> As atualizações preservam intactos a sua identidade,
            chaves criptográficas e histórico local armazenado em SQLite.
          </p>
        </div>
      </SettingsSection>
    </>
  );
}
