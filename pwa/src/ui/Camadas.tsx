// Camadas flutuantes: folha (sheet), popover/menu, diálogo de confirmação e
// gaveta lateral. Tudo via portal em document.body, com entrada e saída
// pelo mesmo caminho e arrasto 1:1 (pointer events) onde há gesto.
import {
  useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject,
} from "react";
import { createPortal } from "react-dom";
import Icone, { type NomeIcone } from "./Icone";
import { resistencia } from "../gestos";

/** Mantém montado durante a animação de saída. `ativo` liga um quadro depois de montar. */
export function usePresenca(aberto: boolean, saidaMs = 220) {
  const [montado, setMontado] = useState(aberto);
  const [ativo, setAtivo] = useState(false);
  useEffect(() => {
    if (aberto) {
      setMontado(true);
      const r = requestAnimationFrame(() => requestAnimationFrame(() => setAtivo(true)));
      return () => cancelAnimationFrame(r);
    }
    setAtivo(false);
    const t = setTimeout(() => setMontado(false), saidaMs);
    return () => clearTimeout(t);
  }, [aberto, saidaMs]);
  return { montado, ativo };
}

export function Portal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
}

/** Esc fecha a camada do topo. */
function useEsc(ativo: boolean, fn: () => void) {
  useEffect(() => {
    if (!ativo) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); fn(); } };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [ativo, fn]);
}

/** Arrasto vertical de uma folha: segue o dedo, resiste para cima, fecha por distância ou velocidade. */
function useArrastoFolha(ref: RefObject<HTMLElement | null>, onFechar: () => void) {
  const g = useRef<{ y0: number; t: number; y: number; v: number; id: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    g.current = { y0: e.clientY, t: e.timeStamp, y: 0, v: 0, id: e.pointerId };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    if (ref.current) ref.current.style.transition = "none";
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const s = g.current;
    if (!s || !ref.current) return;
    const dy = e.clientY - s.y0;
    const dt = Math.max(1, e.timeStamp - s.t);
    s.v = ((dy - s.y) / dt) * 1000;
    s.y = dy;
    s.t = e.timeStamp;
    const y = dy < 0 ? -resistencia(-dy, 400) : dy;
    ref.current.style.transform = `translateY(${y}px)`;
  };
  const onPointerUp = () => {
    const s = g.current;
    g.current = null;
    if (!s || !ref.current) return;
    ref.current.style.transition = "";
    ref.current.style.transform = "";
    if (s.y > 140 || s.v > 700) onFechar();
  };
  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp };
}

/** Folha que sobe da base (iPhone) com alça de arrasto. */
export function Sheet({ aberto, onFechar, titulo, children, rotulo, acaoTopo }: {
  aberto: boolean; onFechar: () => void; titulo?: ReactNode; children: ReactNode; rotulo: string; acaoTopo?: ReactNode;
}) {
  const { montado, ativo } = usePresenca(aberto, 260);
  const ref = useRef<HTMLDivElement>(null);
  const arrasto = useArrastoFolha(ref, onFechar);
  useEsc(aberto, onFechar);
  if (!montado) return null;
  return (
    <Portal>
      <div className={`camada camada--folha${ativo ? " camada--ativa" : ""}`}>
        <div className="scrim" onClick={onFechar} aria-hidden="true" />
        <div ref={ref} className="folha" role="dialog" aria-modal="true" aria-label={rotulo}>
          <div className="folha__topo" {...arrasto}>
            <span className="folha__alca" aria-hidden="true" />
            {(titulo != null || acaoTopo) && (
              <div className="folha__cab">
                <h2 className="folha__titulo">{titulo}</h2>
                {acaoTopo}
              </div>
            )}
          </div>
          <div className="folha__corpo">{children}</div>
        </div>
      </div>
    </Portal>
  );
}

export interface ItemMenu {
  icone?: NomeIcone;
  rotulo: string;
  onClick: () => void;
  perigo?: boolean;
  atalho?: string;
  nota?: string;
  desabilitado?: boolean;
  marcado?: boolean;
}

/** Itens de menu (usados no popover e na folha). `null` é separador. */
export function Menu({ itens, onEscolher, rotulo }: { itens: (ItemMenu | null)[]; onEscolher?: () => void; rotulo: string }) {
  return (
    <div className="menu" role="menu" aria-label={rotulo}>
      {itens.map((it, i) => it === null ? <div key={`s${i}`} className="menu__sep" role="separator" /> : (
        <button key={it.rotulo} type="button" role="menuitem" disabled={it.desabilitado}
          className={`menu__item${it.perigo ? " menu__item--perigo" : ""}`}
          onClick={() => { onEscolher?.(); it.onClick(); }}>
          <span className="menu__ic">{it.marcado ? <Icone nome="ok" tam={15} /> : it.icone ? <Icone nome={it.icone} tam={16} /> : null}</span>
          <span className="menu__rot">{it.rotulo}</span>
          {it.nota && <span className="menu__nota">{it.nota}</span>}
          {it.atalho && <kbd className="menu__atalho">{it.atalho}</kbd>}
        </button>
      ))}
    </div>
  );
}

/** Popover ancorado no gatilho (origem da animação no gatilho). */
export function Popover({ aberto, onFechar, ancora, children, rotulo, alinhar = "inicio", largura = 260 }: {
  aberto: boolean; onFechar: () => void; ancora: RefObject<HTMLElement | null>; children: ReactNode; rotulo: string;
  alinhar?: "inicio" | "fim"; largura?: number;
}) {
  const { montado, ativo } = usePresenca(aberto, 160);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; acima: boolean }>({ x: 0, y: 0, acima: false });
  useLayoutEffect(() => {
    if (!montado || !ancora.current) return;
    const r = ancora.current.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    let x = alinhar === "fim" ? r.right - largura : r.left;
    x = Math.max(8, Math.min(x, vw - largura - 8));
    const alt = ref.current?.offsetHeight ?? 0;
    const acima = r.bottom + 6 + alt > vh - 8 && r.top - 6 - alt > 8;
    setPos({ x, y: acima ? r.top - 6 - alt : r.bottom + 6, acima });
  }, [montado, ancora, alinhar, largura]);
  useEsc(aberto, onFechar);
  useEffect(() => {
    if (!aberto) return;
    const h = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || ancora.current?.contains(t)) return;
      onFechar();
    };
    document.addEventListener("pointerdown", h, true);
    return () => document.removeEventListener("pointerdown", h, true);
  }, [aberto, onFechar, ancora]);
  if (!montado) return null;
  return (
    <Portal>
      <div ref={ref} className={`popover${ativo ? " popover--ativo" : ""}${pos.acima ? " popover--acima" : ""}`}
        role="dialog" aria-label={rotulo}
        style={{ left: pos.x, top: pos.y, width: largura, transformOrigin: `${alinhar === "fim" ? "right" : "left"} ${pos.acima ? "bottom" : "top"}` }}>
        {children}
      </div>
    </Portal>
  );
}

/** Alerta de confirmação: só para ações destrutivas e irreversíveis. */
export function ConfirmDialog({ titulo, texto, onConfirmar, onCancelar, rotuloConfirmar = "Confirmar", perigo = true }: {
  titulo: string; texto: string; onConfirmar: () => void; onCancelar: () => void; rotuloConfirmar?: string; perigo?: boolean;
}) {
  const { ativo } = usePresenca(true);
  useEsc(true, onCancelar);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => { btn.current?.focus(); }, []);
  return (
    <Portal>
      <div className={`camada camada--alerta${ativo ? " camada--ativa" : ""}`}>
        <div className="scrim" onClick={onCancelar} aria-hidden="true" />
        <div className="alerta" role="alertdialog" aria-modal="true" aria-label={titulo}>
          <h2 className="alerta__titulo">{titulo}</h2>
          <p className="alerta__texto">{texto}</p>
          <div className="alerta__acoes">
            <button ref={btn} type="button" className="alerta__btn" onClick={onCancelar}>Cancelar</button>
            <button type="button" className={`alerta__btn alerta__btn--forte${perigo ? " alerta__btn--perigo" : ""}`} onClick={onConfirmar}>{rotuloConfirmar}</button>
          </div>
        </div>
      </div>
    </Portal>
  );
}

/** Gaveta lateral (barra lateral em telas menores). Arrastar para a esquerda fecha. */
export function Gaveta({ aberta, onFechar, children }: { aberta: boolean; onFechar: () => void; children: ReactNode }) {
  const { montado, ativo } = usePresenca(aberta, 260);
  const ref = useRef<HTMLDivElement>(null);
  const g = useRef<{ x0: number; x: number; v: number; t: number } | null>(null);
  useEsc(aberta, onFechar);
  const fim = useCallback(() => {
    const s = g.current;
    g.current = null;
    if (!s || !ref.current) return;
    ref.current.style.transition = "";
    ref.current.style.transform = "";
    if (s.x < -90 || s.v < -600) onFechar();
  }, [onFechar]);
  if (!montado) return null;
  return (
    <Portal>
      <div className={`camada camada--gaveta${ativo ? " camada--ativa" : ""}`}>
        <div className="scrim" onClick={onFechar} aria-hidden="true" />
        <div ref={ref} className="gaveta" role="dialog" aria-modal="true" aria-label="Pastas"
          onPointerDown={(e) => { if (e.pointerType !== "mouse") g.current = { x0: e.clientX, x: 0, v: 0, t: e.timeStamp }; }}
          onPointerMove={(e) => {
            const s = g.current;
            if (!s || !ref.current) return;
            const dx = e.clientX - s.x0;
            s.v = ((dx - s.x) / Math.max(1, e.timeStamp - s.t)) * 1000;
            s.x = dx; s.t = e.timeStamp;
            if (Math.abs(dx) < 8) return;
            ref.current.style.transition = "none";
            ref.current.style.transform = `translateX(${dx > 0 ? resistencia(dx, 300) : dx}px)`;
          }}
          onPointerUp={fim} onPointerCancel={fim}>
          {children}
        </div>
      </div>
    </Portal>
  );
}
