import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Outlet, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Button, Gaveta, Icone, Sheet } from "../ui";
import { api2, type PastaContada } from "../api2";
import { CHAVE_ULTIMA, useCaixa, useCaixas } from "../caixas";
import { useMarca } from "../marca";
import { armazenamento } from "../lib";
import JanelaEscrever from "../screens/Escrever";
import BarraLateral, { ListaCaixas } from "./BarraLateral";
import { Shell, type PedidoEscrever, type ShellCtx } from "./contexto";
import { useLayout } from "./layout";
import { useAtalhos } from "./atalhos";

/** Id da caixa da rota (/c/:id/...) ou a última aberta. */
function useIdAtivo(): number | null {
  const { pathname } = useLocation();
  const m = pathname.match(/^\/c\/(\d+)/);
  if (m) return Number(m[1]);
  return armazenamento.ler<number>(CHAVE_ULTIMA);
}

/** Barra inferior do iPhone: Correio, Buscar, Escrever (centro), Caixas e Ajustes. */
export function BarraInferior({ caixaId, onEscrever, onCaixas }: { caixaId: number | null; onEscrever: () => void; onCaixas: () => void }) {
  const nav = useNavigate();
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const naLista = caixaId !== null && pathname.startsWith(`/c/${caixaId}`) && !pathname.endsWith("/config");
  const buscando = naLista && params.has("buscar");
  const aba = (rotulo: string, icone: Parameters<typeof Icone>[0]["nome"], ativo: boolean, fn: () => void) => (
    <button type="button" className={`tab${ativo ? " tab--ativa" : ""}`} aria-current={ativo ? "page" : undefined} onClick={fn}>
      <Icone nome={icone} tam={23} />
      <span>{rotulo}</span>
    </button>
  );
  const lista = caixaId !== null ? `/c/${caixaId}` : "/caixas";
  return (
    <nav className="tabbar" aria-label="Navegação principal">
      {aba("Correio", "entrada", naLista && !buscando, () => nav(lista))}
      {aba("Buscar", "buscar", buscando, () => nav(caixaId !== null ? `/c/${caixaId}?buscar=1` : "/caixas"))}
      <div className="tab tab--centro">
        <button type="button" className="tab__escrever" aria-label="Escrever" onClick={onEscrever} disabled={caixaId === null}>
          <Icone nome="caneta" tam={21} />
        </button>
      </div>
      {aba("Caixas", "caixas", pathname === "/caixas", onCaixas)}
      {aba("Ajustes", "ajustes", pathname === "/config" || pathname.endsWith("/config"), () => nav("/config"))}
    </nav>
  );
}

export default function Moldura() {
  const { caixas, versao } = useCaixas();
  const idRota = useIdAtivo();
  const existe = caixas?.some((c) => c.id === idRota) ? idRota : caixas?.[0]?.id ?? null;
  const ativa = useCaixa(existe);
  useMarca(ativa, versao);
  const layout = useLayout();
  const nav = useNavigate();
  const { pathname } = useLocation();
  const [gaveta, setGaveta] = useState(false);
  const [folhaCaixas, setFolhaCaixas] = useState(false);
  const [pedido, setPedido] = useState<(PedidoEscrever & { n: number }) | null>(null);
  const [pastas, setPastas] = useState<PastaContada[] | null>(null);
  const seqPastas = useRef(0);

  const recarregarPastas = useCallback(() => {
    if (!ativa) return;
    const n = ++seqPastas.current;
    api2.listarPastas(ativa.id)
      .then((r) => { if (n === seqPastas.current) setPastas(r); })
      .catch(() => { if (n === seqPastas.current) setPastas(null); });
  }, [ativa?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setPastas(null); recarregarPastas(); }, [recarregarPastas]);

  // a gaveta não sobrevive à troca de layout nem de tela
  useEffect(() => { setGaveta(false); }, [layout, pathname]);

  const escrever = useCallback((p: Partial<PedidoEscrever> = {}) => {
    const caixaId = p.caixaId ?? ativa?.id;
    if (!caixaId) return;
    setPedido({ modo: "nova", ...p, caixaId, n: Date.now() });
  }, [ativa?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const ctx = useMemo<ShellCtx>(() => ({
    layout, ativa, abrirGaveta: () => setGaveta(true), abrirCaixas: () => setFolhaCaixas(true), escrever, pastas, recarregarPastas,
  }), [layout, ativa, escrever, pastas, recarregarPastas]);

  // "c" funciona em qualquer tela do computador; os demais atalhos vivem na caixa
  useAtalhos(layout !== "uma" && !pedido && !pathname.startsWith("/c/"), (a) => { if (a === "escrever") escrever(); });

  // deslize a partir da borda esquerda abre a gaveta (layouts sem a coluna fixa)
  const borda = useRef<{ x0: number; y0: number } | null>(null);
  const bordaHandlers = layout === "tres" ? {} : {
    onPointerDown: (e: React.PointerEvent) => { borda.current = e.clientX < 20 && e.pointerType !== "mouse" ? { x0: e.clientX, y0: e.clientY } : null; },
    onPointerMove: (e: React.PointerEvent) => {
      const b = borda.current;
      if (b && e.clientX - b.x0 > 36 && Math.abs(e.clientY - b.y0) < 30) { borda.current = null; setGaveta(true); }
    },
    onPointerUp: () => { borda.current = null; },
  };

  const telaMensagem = /^\/c\/\d+\/m\//.test(pathname);
  const comTabbar = layout === "uma" && !telaMensagem;

  return (
    <Shell.Provider value={ctx}>
      <div className={`janela janela--${layout}${comTabbar ? " janela--tabbar" : ""}`} data-layout={layout}>
        {layout === "tres" && <aside className="janela__lateral"><BarraLateral /></aside>}
        <main className="janela__conteudo" {...bordaHandlers}>
          <Outlet />
        </main>
        {comTabbar && <BarraInferior caixaId={ativa?.id ?? null} onEscrever={() => escrever()} onCaixas={() => setFolhaCaixas(true)} />}
      </div>
      {layout !== "tres" && (
        <Gaveta aberta={gaveta} onFechar={() => setGaveta(false)}>
          <BarraLateral aoNavegar={() => setGaveta(false)} />
        </Gaveta>
      )}
      <Sheet aberto={folhaCaixas} onFechar={() => setFolhaCaixas(false)} rotulo="Caixas" titulo="Caixas">
        <ListaCaixas ativa={ativa} onEscolher={(c) => { setFolhaCaixas(false); nav(`/c/${c.id}`); }} />
        <div className="folha__rodape">
          <Button variante="cinza" bloco icone="ajustes" onClick={() => { setFolhaCaixas(false); nav("/caixas"); }}>Gerenciar caixas</Button>
        </div>
      </Sheet>
      {pedido && (
        <JanelaEscrever key={pedido.n} pedido={pedido} onFechar={() => setPedido(null)} />
      )}
    </Shell.Provider>
  );
}
