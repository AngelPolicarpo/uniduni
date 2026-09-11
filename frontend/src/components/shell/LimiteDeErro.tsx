import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "../ui/Button";

/**
 * Limite de erro da árvore de telas.
 *
 * Sem ele, uma exceção durante o render desmonta a árvore INTEIRA e a janela fica preta —
 * sem mensagem, sem controles, sem nada que diga o que houve. Foi exatamente assim que a
 * 1.0.0 se apresentou a quem instalou sem identidade: um `undefined` chegando ao `Avatar`
 * derrubava o produto todo, e o defeito só apareceu depois de reproduzir a build empacotada
 * com o log do Chromium ligado.
 *
 * Ele mora ABAIXO da `TitleBar`, de propósito: a janela é `frameless` e quem fecha, minimiza
 * e arrasta é a barra do produto. Um limite que a envolvesse trocaria a tela preta por uma
 * janela que também não dá para fechar.
 *
 * O botão primeiro é "tentar de novo", não "recarregar": recarregar a janela é, por §15.2, a
 * operação mais cara do produto — derruba as conexões P2P e paga a barreira de §18.7. Um
 * render que falhou por estado transitório volta sem nada disso.
 */
interface Estado {
  erro: Error | null;
}

export class LimiteDeErro extends Component<{ children: ReactNode }, Estado> {
  override state: Estado = { erro: null };

  static getDerivedStateFromError(erro: Error): Estado {
    return { erro };
  }

  override componentDidCatch(erro: Error, info: ErrorInfo): void {
    // Vai para o console do renderer, que é onde `ELECTRON_ENABLE_LOGGING=1` o captura.
    console.error("[tela] render falhou:", erro, info.componentStack);
  }

  override render(): ReactNode {
    const { erro } = this.state;
    if (erro === null) return this.props.children;

    return (
      <div className="flex h-full items-center justify-center bg-surface-app p-6">
        <div className="max-w-md text-center">
          {/* `text-heading-1`, e não o `text-h2` que estava aqui: `h2` não é
              nome de token nenhum de §5.5, então a classe não chegava ao CSS
              gerado e o título desta tela saía em 14px de corpo — do mesmo
              tamanho do parágrafo abaixo dele. §5.5 dá heading-1 a "título de
              tela cheia", que é o que esta é. */}
          <h1 className="text-heading-1 text-text-primary">Esta tela quebrou</h1>
          <p className="mt-2 text-body text-text-secondary">
            O erro está abaixo. Nada foi perdido: o que já estava no disco continua lá.
          </p>
          <p className="mt-3 rounded-md border border-border-default bg-surface-sidebar p-3 text-left text-meta font-mono text-text-tertiary">
            {erro.message || String(erro)}
          </p>
          <div className="mt-5 flex justify-center gap-3">
            <Button onClick={() => this.setState({ erro: null })}>Tentar de novo</Button>
            <Button variant="secondary" onClick={() => window.location.reload()}>
              Recarregar a janela
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
