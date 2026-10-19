import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "./api";

/** Mensagem de erro amigável a partir de qualquer exceção. */
export const erroMsg = (e: unknown): string =>
  e instanceof ApiError || e instanceof Error ? e.message : "Erro inesperado";

/** Carrega GET ao montar (o 401 é tratado em api.ts); opcional: recarga periódica. */
export function useCarga<T>(path: string, intervaloMs?: number) {
  const [dados, setDados] = useState<T | null>(null);
  const [erro, setErro] = useState("");
  const vivo = useRef(true);
  const contador = useRef(0);
  const recarregar = useCallback(async () => {
    const n = ++contador.current;
    try {
      const d = await api.get<T>(path);
      if (vivo.current && n === contador.current) { setDados(d); setErro(""); }
    } catch (e) {
      if (vivo.current && n === contador.current) setErro(erroMsg(e));
    }
  }, [path]);
  useEffect(() => {
    vivo.current = true;
    setDados(null); setErro("");
    void recarregar();
    let t: ReturnType<typeof setInterval> | undefined;
    if (intervaloMs) {
      t = setInterval(() => {
        if (document.visibilityState !== "hidden") void recarregar();
      }, intervaloMs);
    }
    return () => { vivo.current = false; if (t) clearInterval(t); };
  }, [recarregar, intervaloMs]);
  return { dados, erro, recarregar };
}

export function dataHora(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** Aviso pt-BR quando a regra do Cloudflare falhou em alguma zona. */
export function avisoZonas(r: unknown): string {
  const z = (r as { zonasComFalha?: unknown } | null)?.zonasComFalha;
  if (!Array.isArray(z) || z.length === 0) return "";
  return `Falhou em ${z.length} zona(s): ${z.join(", ")}`;
}
