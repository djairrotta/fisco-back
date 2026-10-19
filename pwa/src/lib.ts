import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, ehPrecisaSenha } from "./api";

/** Mensagem de erro amigável a partir de qualquer exceção. */
export const erroMsg = (e: unknown): string =>
  e instanceof ApiError || e instanceof Error ? e.message : "Erro inesperado";

/** Carrega GET ao montar (o 401 é tratado em api.ts). `path` null = não carrega. */
export function useCarga<T>(path: string | null) {
  const [dados, setDados] = useState<T | null>(null);
  const [erro, setErro] = useState("");
  const [precisaSenha, setPrecisaSenha] = useState(false);
  const [carregando, setCarregando] = useState(false);
  const vivo = useRef(true);
  const contador = useRef(0);
  const recarregar = useCallback(async () => {
    if (!path) return;
    const n = ++contador.current;
    setCarregando(true);
    try {
      const d = await api.get<T>(path);
      if (vivo.current && n === contador.current) { setDados(d); setErro(""); setPrecisaSenha(false); }
    } catch (e) {
      if (vivo.current && n === contador.current) { setErro(erroMsg(e)); setPrecisaSenha(ehPrecisaSenha(e)); }
    } finally {
      if (vivo.current && n === contador.current) setCarregando(false);
    }
  }, [path]);
  useEffect(() => {
    vivo.current = true;
    setDados(null); setErro(""); setPrecisaSenha(false);
    void recarregar();
    return () => { vivo.current = false; };
  }, [recarregar]);
  return { dados, erro, precisaSenha, carregando, recarregar, setDados };
}

export function dataCurta(iso: string | null | undefined, agora = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (d.toDateString() === agora.toDateString()) {
    return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }
  if (d.getFullYear() === agora.getFullYear()) {
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
  }
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

export function dataHora(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export function tamanhoLegivel(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

export const nomeEndereco = (e: { nome: string; endereco: string } | null | undefined): string =>
  e ? e.nome?.trim() || e.endereco : "(sem remetente)";

/** Leitura/gravação no localStorage que nunca lança (modo privado, cota). */
export const armazenamento = {
  ler<T>(chave: string): T | null {
    try {
      const v = localStorage.getItem(chave);
      return v ? (JSON.parse(v) as T) : null;
    } catch {
      return null;
    }
  },
  gravar(chave: string, v: unknown) {
    try {
      localStorage.setItem(chave, JSON.stringify(v));
    } catch { /* sem armazenamento: segue sem rascunho */ }
  },
  apagar(chave: string) {
    try {
      localStorage.removeItem(chave);
    } catch { /* idem */ }
  },
};

/**
 * Baixa um recurso da própria origem e devolve como data: URL (o iframe
 * sandbox tem origem opaca e CSP só com data:/blob:). null em falha.
 */
export async function buscarDataUrl(url: string, tipo?: string, limite = 5 * 1024 * 1024): Promise<string | null> {
  try {
    const r = await fetch(url, { credentials: "include" });
    if (!r.ok) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength > limite) return null;
    const blob = new Blob([buf], { type: tipo ?? r.headers.get("Content-Type") ?? "application/octet-stream" });
    return await new Promise<string>((ok, falha) => {
      const fr = new FileReader();
      fr.onload = () => ok(String(fr.result));
      fr.onerror = () => falha(fr.error);
      fr.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

const DIAS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

/** Data da linha da lista (estilo Mail): hora hoje, "Ontem", dia da semana, ou dd/mm/aa. */
export function dataLista(iso: string | null | undefined, agora = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  const dia = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dif = Math.round((dia(agora) - dia(d)) / 86400000);
  if (dif <= 0) return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  if (dif === 1) return "Ontem";
  if (dif < 7) return DIAS[d.getDay()];
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

/** Data completa do cabeçalho da mensagem: "3 de outubro de 2026, 09:42". */
export function dataLonga(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.toLocaleDateString("pt-BR", { day: "numeric", month: "long", year: "numeric" })}, ${d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
}
