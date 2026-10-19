import { memo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Icone, Monograma, type NomeIcone } from "../ui";
import { dataLista, nomeEndereco } from "../lib";
import { decidirArrasto, deslocamento, direcaoGesto, LARGURA_ACAO, type LadoArrasto } from "../gestos";
import type { ItemLista } from "../tipos";

export interface AcaoLinha { id: string; rotulo: string; icone: NomeIcone; cor: string; fn: () => void }

interface Props {
  m: ItemLista;
  href: string;
  selecionada: boolean;
  aberta: boolean;
  modoSelecao: boolean;
  /** Ações à esquerda (aparecem ao puxar para a direita): a primeira é a do deslize completo. */
  inicio: AcaoLinha[];
  /** Ações à direita (aparecem ao puxar para a esquerda). */
  fim: AcaoLinha[];
  onAlternarSelecao: () => void;
  onPressaoLonga: () => void;
  /** Abre outra coisa em vez da leitura (ex.: rascunho reabre o compositor). */
  onAbrir?: () => void;
  /** Nome da pasta de origem (busca em todas as pastas). */
  pastaNome?: string;
}

/**
 * Linha da lista. No toque: deslize 1:1 (pointer events + captura), limiar
 * de 10 px para decidir a direção, momento projetado ao soltar, deslize
 * longo executa a ação principal; pressão longa entra na seleção.
 * No mouse: clique abre, Cmd/Ctrl/Shift+clique seleciona.
 */
function LinhaMensagem({ m, href, selecionada, aberta, modoSelecao, inicio, fim, onAlternarSelecao, onPressaoLonga, onAbrir, pastaNome }: Props) {
  const ref = useRef<HTMLAnchorElement>(null);
  const g = useRef<{ x0: number; y0: number; base: number; dir: "h" | "v" | null; x: number; v: number; t: number; id: number; longo: ReturnType<typeof setTimeout> | null } | null>(null);
  const suprimirClique = useRef(false);
  const [aberto, setAberto] = useState<LadoArrasto | null>(null);
  const [completo, setCompleto] = useState<LadoArrasto | null>(null);

  const base = (lado: LadoArrasto | null) => (lado === "inicio" ? inicio.length * LARGURA_ACAO : lado === "fim" ? -fim.length * LARGURA_ACAO : 0);
  const aplicar = (x: number, animar: boolean) => {
    const el = ref.current;
    if (!el) return;
    el.style.transition = animar ? "" : "none";
    el.style.transform = x ? `translate3d(${x}px,0,0)` : "";
    el.parentElement?.style.setProperty("--arrasto", String(x));
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" || modoSelecao) return;
    const longo = setTimeout(() => {
      const s = g.current;
      if (s && !s.dir) { suprimirClique.current = true; g.current = null; navigator.vibrate?.(8); onPressaoLonga(); }
    }, 480);
    g.current = { x0: e.clientX, y0: e.clientY, base: base(aberto), dir: null, x: 0, v: 0, t: e.timeStamp, id: e.pointerId, longo };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const s = g.current;
    if (!s) return;
    const dx = e.clientX - s.x0, dy = e.clientY - s.y0;
    if (!s.dir) {
      s.dir = direcaoGesto(dx, dy);
      if (!s.dir) return;
      if (s.longo) { clearTimeout(s.longo); s.longo = null; }
      if (s.dir === "v") { g.current = null; return; }
      ref.current?.setPointerCapture?.(s.id);
    }
    const largura = ref.current?.offsetWidth || 375;
    let x = s.base + dx;
    if ((x > 0 && !inicio.length) || (x < 0 && !fim.length)) x = 0;
    const nAcoes = x > 0 ? inicio.length : fim.length;
    const vis = deslocamento(x, largura, nAcoes);
    const dt = Math.max(1, e.timeStamp - s.t);
    s.v = ((x - s.x) / dt) * 1000;
    s.x = x;
    s.t = e.timeStamp;
    setCompleto(Math.abs(vis) > largura * 0.55 ? (vis > 0 ? "inicio" : "fim") : null);
    aplicar(vis, false);
  };

  const onPointerUp = () => {
    const s = g.current;
    g.current = null;
    if (!s) return;
    if (s.longo) clearTimeout(s.longo);
    if (!s.dir) {
      // toque simples com ações abertas: só fecha
      if (aberto) { suprimirClique.current = true; setAberto(null); aplicar(0, true); }
      return;
    }
    suprimirClique.current = true;
    const largura = ref.current?.offsetWidth || 375;
    const d = decidirArrasto(s.x, s.v, largura, s.x > 0 ? inicio.length : fim.length);
    setCompleto(null);
    if (d.executar) {
      const acao = (d.executar === "inicio" ? inicio : fim)[0];
      aplicar(d.executar === "inicio" ? largura : -largura, true);
      setAberto(null);
      setTimeout(() => { acao?.fn(); aplicar(0, false); }, 180);
      return;
    }
    setAberto(d.aberto);
    aplicar(base(d.aberto), true);
  };

  const onClick = (e: React.MouseEvent) => {
    if (suprimirClique.current) { e.preventDefault(); suprimirClique.current = false; return; }
    if (modoSelecao || e.shiftKey || e.metaKey || e.ctrlKey) { e.preventDefault(); onAlternarSelecao(); return; }
    if (onAbrir) { e.preventDefault(); onAbrir(); }
  };

  const executar = (a: AcaoLinha) => { setAberto(null); aplicar(0, true); a.fn(); };
  const nome = nomeEndereco(m.de);

  return (
    <li className={`linha-env${completo ? ` linha-env--completo-${completo}` : ""}`}>
      {inicio.length > 0 && (
        <div className="linha__acoes linha__acoes--inicio" aria-hidden={aberto !== "inicio"}>
          {inicio.map((a) => (
            <button key={a.id} type="button" tabIndex={aberto === "inicio" ? 0 : -1} className="linha__acao" style={{ background: a.cor }} onClick={() => executar(a)}>
              <Icone nome={a.icone} tam={20} /><span>{a.rotulo}</span>
            </button>
          ))}
        </div>
      )}
      {fim.length > 0 && (
        <div className="linha__acoes linha__acoes--fim" aria-hidden={aberto !== "fim"}>
          {[...fim].reverse().map((a) => (
            <button key={a.id} type="button" tabIndex={aberto === "fim" ? 0 : -1} className="linha__acao" style={{ background: a.cor }} onClick={() => executar(a)}>
              <Icone nome={a.icone} tam={20} /><span>{a.rotulo}</span>
            </button>
          ))}
        </div>
      )}
      <Link ref={ref} to={href} draggable={false}
        className={`linha${m.lida ? "" : " linha--nova"}${aberta ? " linha--aberta" : ""}${selecionada ? " linha--sel" : ""}`}
        aria-current={aberta ? "true" : undefined}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        onClick={onClick} onContextMenu={(e) => { if (g.current) e.preventDefault(); }}>
        <span className="linha__ponto" aria-label={m.lida ? undefined : "não lida"} />
        {modoSelecao ? (
          <span className={`linha__marca${selecionada ? " linha__marca--on" : ""}`} role="checkbox" aria-checked={selecionada} aria-label={`Selecionar mensagem de ${nome}`}>
            {selecionada && <Icone nome="ok" tam={14} />}
          </span>
        ) : <Monograma nome={nome} tam={38} />}
        <span className="linha__corpo">
          <span className="linha__l1">
            <span className="linha__de">{nome}</span>
            <span className="linha__hora">{dataLista(m.data)}</span>
          </span>
          <span className="linha__l2">
            <span className="linha__assunto">{m.assunto || "(sem assunto)"}</span>
            {m.temAnexo && <span className="linha__ind" aria-label="com anexo" title="Com anexo"><Icone nome="clipe" tam={13} /></span>}
            {m.estrela && <span className="linha__ind linha__ind--estrela" aria-label="com estrela" title="Com estrela"><Icone nome="favoritos" tam={13} /></span>}
          </span>
          {pastaNome && <span className="linha__pasta"><Icone nome="pasta" tam={11} />{pastaNome}</span>}
          {m.previa && <span className="linha__previa">{m.previa}</span>}
        </span>
      </Link>
    </li>
  );
}

export default memo(LinhaMensagem);
