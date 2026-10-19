import { createContext, useContext } from "react";
import type { PastaContada } from "../api2";
import type { Modo } from "../compor";
import type { Caixa } from "../tipos";
import type { Layout } from "./layout";

export interface PedidoEscrever {
  caixaId: number;
  modo: Modo;
  pasta?: string;
  uid?: number;
  /** Reabre um rascunho do servidor. */
  rascunhoUid?: number;
}

export interface ShellCtx {
  layout: Layout;
  ativa: Caixa | null;
  abrirGaveta: () => void;
  abrirCaixas: () => void;
  escrever: (p?: Partial<PedidoEscrever>) => void;
  pastas: PastaContada[] | null;
  /** Recarrega as pastas (contagens) após ações. */
  recarregarPastas: () => void;
}

export const Shell = createContext<ShellCtx>({
  layout: "tres", ativa: null, abrirGaveta: () => {}, abrirCaixas: () => {}, escrever: () => {},
  pastas: null, recarregarPastas: () => {},
});
export const useShell = () => useContext(Shell);

/** Pastas virtuais do Correio (não existem no IMAP). */
export const FAVORITOS = "__favoritos";
export const SAIDA = "__saida";
