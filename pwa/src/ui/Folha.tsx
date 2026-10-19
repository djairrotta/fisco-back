import { type ReactNode, useEffect } from "react";
import { createPortal } from "react-dom";

/** Folhas abertas agora (aninhadas): a trava de rolagem só sai na última. */
let abertas = 0;
let salvo: { scrollY: number; estilo: string } | null = null;

function travarRolagem() {
  if (abertas++ > 0) return;
  const b = document.body;
  salvo = { scrollY: window.scrollY, estilo: b.getAttribute("style") ?? "" };
  // iOS Safari ignora overflow:hidden no body; position:fixed segura a página.
  b.style.position = "fixed";
  b.style.top = `-${salvo.scrollY}px`;
  b.style.left = "0";
  b.style.right = "0";
  b.style.overflow = "hidden";
}

function liberarRolagem() {
  if (--abertas > 0 || !salvo) return;
  const { scrollY, estilo } = salvo;
  salvo = null;
  if (estilo) document.body.setAttribute("style", estilo);
  else document.body.removeAttribute("style");
  try { window.scrollTo(0, scrollY); } catch { /* jsdom */ }
}

/**
 * Folha/diálogo modal renderizado em document.body (portal): fica acima de
 * qualquer cartão, mesmo os com backdrop-filter/transform, que criam um novo
 * contexto de empilhamento e prendem position:fixed dentro deles no Safari.
 * Fecha no toque no fundo e no Esc; trava a rolagem do body enquanto aberta.
 */
export default function Folha({
  rotulo, onFechar, children, papel = "dialog", className = "",
}: {
  rotulo: string;
  onFechar: () => void;
  children: ReactNode;
  papel?: "dialog" | "alertdialog";
  className?: string;
}) {
  useEffect(() => {
    travarRolagem();
    return liberarRolagem;
  }, []);
  useEffect(() => {
    const tecla = (e: KeyboardEvent) => { if (e.key === "Escape") onFechar(); };
    document.addEventListener("keydown", tecla);
    return () => document.removeEventListener("keydown", tecla);
  }, [onFechar]);
  return createPortal(
    <div className="folha__fundo" data-testid="folha-fundo" onClick={onFechar}>
      <div className={`dialog folha ${className}`.trim()} role={papel} aria-modal="true" aria-label={rotulo}
        onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
