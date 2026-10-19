import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "./api";
import { armazenamento, erroMsg } from "./lib";
import type { Caixa } from "./tipos";

interface Ctx {
  caixas: Caixa[] | null;
  erro: string;
  recarregar: () => Promise<void>;
  /** Substitui uma caixa na lista (após PATCH/upload). */
  atualizar: (c: Caixa) => void;
  /** Versão da marca (fura cache de logo/favicon após upload). */
  versao: number;
  novaVersao: () => void;
}

const CaixasCtx = createContext<Ctx | null>(null);

export const CHAVE_ULTIMA = "correio:ultima-caixa";

export function CaixasProvider({ children }: { children: ReactNode }) {
  const [caixas, setCaixas] = useState<Caixa[] | null>(null);
  const [erro, setErro] = useState("");
  const [versao, setVersao] = useState(() => Date.now());
  const recarregar = useCallback(async () => {
    try {
      const r = await api.get<{ caixas: Caixa[] }>("/api/caixas");
      setCaixas(r.caixas);
      setErro("");
    } catch (e) {
      setErro(erroMsg(e));
      setCaixas((x) => x ?? []);
    }
  }, []);
  useEffect(() => { void recarregar(); }, [recarregar]);
  const atualizar = useCallback((c: Caixa) => {
    setCaixas((xs) => (xs ?? []).map((x) => (x.id === c.id ? c : x)));
  }, []);
  const valor = useMemo<Ctx>(() => ({
    caixas, erro, recarregar, atualizar, versao, novaVersao: () => setVersao(Date.now()),
  }), [caixas, erro, recarregar, atualizar, versao]);
  return <CaixasCtx.Provider value={valor}>{children}</CaixasCtx.Provider>;
}

export function useCaixas(): Ctx {
  const c = useContext(CaixasCtx);
  if (!c) throw new Error("useCaixas fora do CaixasProvider");
  return c;
}

/** Caixa pelo id da rota (e lembra a última aberta). */
export function useCaixa(id: number | null): Caixa | null {
  const { caixas } = useCaixas();
  const c = id === null ? null : caixas?.find((x) => x.id === id) ?? null;
  useEffect(() => { if (c) armazenamento.gravar(CHAVE_ULTIMA, c.id); }, [c?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return c;
}
