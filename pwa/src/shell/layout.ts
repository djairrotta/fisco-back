import { useSyncExternalStore } from "react";

/** ≥ 1024: três colunas (Mac); 768–1023: duas (lista | leitura); < 768: uma (iPhone). */
export type Layout = "tres" | "duas" | "uma";

export const layoutPara = (largura: number): Layout => (largura >= 1024 ? "tres" : largura >= 768 ? "duas" : "uma");

function assinar(fn: () => void) {
  window.addEventListener("resize", fn);
  window.addEventListener("orientationchange", fn);
  return () => {
    window.removeEventListener("resize", fn);
    window.removeEventListener("orientationchange", fn);
  };
}

export function useLayout(): Layout {
  return useSyncExternalStore(assinar, () => layoutPara(window.innerWidth), () => "tres");
}
