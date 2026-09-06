import { useEffect } from "react";
import { MemoryRouter, Navigate, Route, Routes } from "react-router-dom";
import { ToastViewport } from "./components/ui/Toast";
import { RootRoute } from "./routes/RootRoute";
import { InviteRoute } from "./routes/InviteRoute";
import { MessageRoute } from "./routes/MessageRoute";
import { Sincronizador } from "./live/Sincronizador";
import { assinarDeepLinks } from "./live/deeplink";
import { DeepLinkMensagem } from "./features/channel/DeepLinkMensagem";
import { HostExitListener } from "./features/host/HostExitGuard";

/**
 * Três rotas reais, resto é estado (§4).
 *
 * Comunidade/canal selecionado, painéis, modais e sessão de voz ficam fora
 * do router, em Zustand — nada disso é recurso endereçável por servidor.
 *
 * `MemoryRouter` porque o produto é Electron carregado por `file://` (§3.1):
 * não há barra de endereço, e `BrowserRouter` sobre `file://` não resolve as
 * rotas. A tabela é a mesma — era exatamente a troca que o mock previa.
 * Deep links chegam como evento do main (§3.5), nunca como URL.
 */
function App() {
  /*
   * §3.5(2) — a escuta dos deep links, e **a chamada que faltava**.
   *
   * `assinarDeepLinks` existia desde a emenda e nenhum arquivo em produção a chamava:
   * o main entregava `{route,…}` ao `webContents`, o preload virava evento de janela e
   * ninguém estava ouvindo. Todo `comunidadep2p://…` com o app aberto era descartado em
   * silêncio, e o teste de unidade não pegava porque chamava `receber()` direto.
   *
   * Fica aqui, e não dentro do `Sincronizador`: um link pode chegar enquanto o núcleo
   * ainda conecta, e é o mesmo motivo pelo qual o `HostExitListener` mora na raiz (§92).
   */
  useEffect(() => assinarDeepLinks(), []);

  return (
    <MemoryRouter>
      {/*
        Fora do `Sincronizador`, de propósito: ele não renderiza os filhos nos estados
        `inicial`/`conectando`/`falhou`/`sem-shell`, e o que precisa sobreviver a esses
        estados não pode depender deles.

        - U-06: o main segura o fechamento e espera resposta. Sem ouvinte montado, fechar
          a janela durante a conexão inicial custava os 10 s de prazo do main (§92) —
          exatamente o defeito que mover o listener para a raiz devia ter fechado, e não
          fechou enquanto ele continuou **dentro** do guarda de conexão.
        - §3.5: um deep link que chega durante a conexão precisa de tela para esperar.
      */}
      <HostExitListener />
      <DeepLinkMensagem />

      <Sincronizador>
        <Routes>
          <Route path="/" element={<RootRoute />} />
          <Route path="/invite/:code" element={<InviteRoute />} />
          <Route path="/m/:code" element={<MessageRoute />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Sincronizador>

      {/* Fora das rotas e do guarda: os toasts sobrevivem à navegação e à reconexão. */}
      <ToastViewport />
    </MemoryRouter>
  );
}

export default App;
