import { Network } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { useUiStore } from "../../store/uiStore";

/**
 * 0.2 Hub vazio.
 *
 * Não é uma tela nova: é o shell com o rail contendo só o botão "+" e o
 * conteúdo central orientando a única decisão possível. Existe sempre que
 * `comunidades.length === 0`; some assim que a primeira entra.
 */
export function EmptyHub() {
  const openCreateCommunity = useUiStore((state) => state.openCreateCommunity);
  const openJoinCommunity = useUiStore((state) => state.openJoinCommunity);

  return (
    <div className="flex h-full flex-1 items-center justify-center bg-surface-primary px-8 py-12">
      <div className="flex w-full max-w-[420px] flex-col items-center text-center">
        <span
          className="grid size-16 place-items-center rounded-lg bg-accent-muted-bg text-accent-default"
          aria-hidden="true"
        >
          <Network size={32} strokeWidth={1.5} />
        </span>

        <h1 className="mt-6 text-heading-1 text-text-primary">
          Nenhuma comunidade ainda
        </h1>
        <p className="mt-2 text-body text-text-secondary">
          Comunidades no Uniduni não têm servidor central — você entra
          com um convite de alguém, ou cria a sua e vira o host.
        </p>

        <div className="mt-8 flex w-full flex-col gap-3 tablet:flex-row tablet:justify-center">
          <Button size="lg" onClick={openCreateCommunity}>
            Criar uma comunidade
          </Button>
          <Button
            variant="secondary"
            size="lg"
            onClick={() => openJoinCommunity("manual")}
          >
            Entrar com convite
          </Button>
        </div>
      </div>
    </div>
  );
}
