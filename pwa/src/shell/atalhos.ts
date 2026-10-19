import { useEffect, useRef } from "react";

export type AcaoAtalho =
  | "escrever" | "responder" | "todos" | "encaminhar" | "arquivar" | "excluir"
  | "estrela" | "proxima" | "anterior" | "buscar" | "naoLida";

/** Teclas do spec (§3): c r a f · e # s · j k / u. */
export const TECLAS: Record<string, AcaoAtalho> = {
  c: "escrever", r: "responder", a: "todos", f: "encaminhar",
  e: "arquivar", "#": "excluir", s: "estrela",
  j: "proxima", k: "anterior", "/": "buscar", u: "naoLida",
};

/** Rótulo curto para dicas e menus. */
export const TECLA_DE: Record<AcaoAtalho, string> = Object.fromEntries(
  Object.entries(TECLAS).map(([t, a]) => [a, t.toUpperCase()]),
) as Record<AcaoAtalho, string>;

function editavel(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable || el.getAttribute?.("contenteditable") === "true";
}

/** Ação de uma tecla, ou null (com modificadores, digitando, ou com camada modal aberta). */
export function acaoDaTecla(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "target"> & { isComposing?: boolean }): AcaoAtalho | null {
  // IME (acentos compostos, teclados asiáticos): a tecla ainda não é um caractere final
  if (e.isComposing || e.key === "Process" || e.key === "Dead") return null;
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (editavel(e.target)) return null;
  if (typeof document !== "undefined" && document.querySelector('[aria-modal="true"]')) return null;
  return TECLAS[e.key.length === 1 ? e.key.toLowerCase() : e.key] ?? TECLAS[e.key] ?? null;
}

/** Atalhos globais do teclado (só no layout de computador). */
export function useAtalhos(ativo: boolean, fn: (a: AcaoAtalho) => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!ativo) return;
    const h = (e: KeyboardEvent) => {
      const a = acaoDaTecla(e);
      if (!a) return;
      e.preventDefault();
      ref.current(a);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [ativo]);
}
