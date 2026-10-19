// Vigia 2.0 (1.1): tokens de acesso à API v1 e ao MCP.
// Criados e revogados só pelo PWA (sessão de passkey). Só o sha256 é guardado.
import type { Sql } from "../db/client.ts";
import { base64url, iguaisConstante, sha256Hex } from "./session.ts";

export type Escopo = "ler" | "escrever";
export const ESCOPOS: readonly Escopo[] = ["ler", "escrever"];
export const FORMATO_TOKEN = /^vgt_[A-Za-z0-9_-]{43}$/;

export interface TokenValido {
  id: number;
  nome: string;
  escopos: Escopo[];
  /** Ator da auditoria quando não é um token vgt_ (ex.: "oauth:Claude"). */
  ator?: string;
  /** Chave do limite por minuto; padrão: id (tokens vgt_). */
  chaveLimite?: number;
}

export interface TokenListado {
  id: number;
  nome: string;
  escopos: Escopo[];
  criadoEm: string;
  ultimoUso: string | null;
  revogadoEm: string | null;
}

const INTERVALO_ULTIMO_USO_MS = 60_000;
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

/** Gera e grava um token novo; o texto do token só existe neste retorno. */
export async function criarToken(
  sql: Sql,
  nome: string,
  escopos: Escopo[],
): Promise<{ id: number; token: string }> {
  const token = `vgt_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
  const unicos = [...new Set(escopos)];
  const [r] = await sql`INSERT INTO vigia.tokens_api (nome, hash, escopos)
    VALUES (${nome}, ${await sha256Hex(token)}, ${unicos}) RETURNING id`;
  return { id: Number(r.id), token };
}

export async function listarTokens(sql: Sql): Promise<TokenListado[]> {
  const rows = await sql`SELECT id, nome, escopos, criado_em, ultimo_uso,
      revogado_em
    FROM vigia.tokens_api ORDER BY revogado_em IS NOT NULL, id DESC LIMIT 200`;
  return rows.map((r) => ({
    id: Number(r.id),
    nome: String(r.nome),
    escopos: r.escopos as Escopo[],
    criadoEm: iso(r.criado_em)!,
    ultimoUso: iso(r.ultimo_uso),
    revogadoEm: iso(r.revogado_em),
  }));
}

/** true se revogou agora; false se não existe ou já estava revogado. */
export async function revogarToken(
  sql: Sql,
  id: number,
  agora: () => Date = () => new Date(),
): Promise<boolean> {
  const r = await sql`UPDATE vigia.tokens_api SET revogado_em = ${agora()}
    WHERE id = ${id} AND revogado_em IS NULL RETURNING id`;
  return r.length > 0;
}

/**
 * Valida o token do header Bearer. Busca pelo hash e confirma em tempo
 * constante; formato errado nem chega ao banco.
 */
export async function validarToken(
  sql: Sql,
  token: string | null | undefined,
  agora: () => Date = () => new Date(),
): Promise<TokenValido | null> {
  if (!token || !FORMATO_TOKEN.test(token)) return null;
  const hash = await sha256Hex(token);
  const [r] = await sql`SELECT id, nome, escopos, hash, ultimo_uso
    FROM vigia.tokens_api WHERE hash = ${hash} AND revogado_em IS NULL`;
  if (!r || !await iguaisConstante(String(r.hash), hash)) return null;
  // ultimo_uso no máximo 1 escrita por minuto por token.
  const t = agora();
  if (
    r.ultimo_uso === null ||
    t.getTime() - new Date(r.ultimo_uso).getTime() >= INTERVALO_ULTIMO_USO_MS
  ) {
    await sql`UPDATE vigia.tokens_api SET ultimo_uso = ${t}
      WHERE id = ${r.id}`;
  }
  return {
    id: Number(r.id),
    nome: String(r.nome),
    escopos: r.escopos as Escopo[],
  };
}

/** Ator da auditoria: id + nome (o nome pode ser reusado após revogar). */
export const atorToken = (t: TokenValido) =>
  t.ator ?? `token:${t.id}:${t.nome}`;

export const podeEscrever = (t: TokenValido) => t.escopos.includes("escrever");
/** "escrever" inclui "ler". */
export const podeLer = (t: TokenValido) =>
  t.escopos.includes("ler") || podeEscrever(t);

/**
 * Janela deslizante em memória por token. Devolve 0 se permitido, senão os
 * segundos para o Retry-After.
 */
export function criarLimitadorTokens(
  max = 60,
  janelaMs = 60_000,
  relogio: () => number = Date.now,
): (id: number) => number {
  const mapa = new Map<number, number[]>();
  return (id) => {
    const t = relogio();
    const recentes = (mapa.get(id) ?? []).filter((x) => t - x < janelaMs);
    if (recentes.length >= max) {
      mapa.set(id, recentes);
      return Math.max(1, Math.ceil((recentes[0] + janelaMs - t) / 1000));
    }
    recentes.push(t);
    mapa.set(id, recentes);
    if (mapa.size > 1000) {
      for (const [k, v] of mapa) {
        if (!v.length || t - v[v.length - 1] >= janelaMs) mapa.delete(k);
      }
    }
    return 0;
  };
}

/**
 * Falhas de autenticação por chave (IP), em janela deslizante: `espera`
 * devolve 0 se liberado, senão os segundos para o Retry-After.
 */
export function criarLimitadorFalhas(
  max = 10,
  janelaMs = 60_000,
  relogio: () => number = Date.now,
): { espera(chave: string): number; falhou(chave: string): void } {
  const mapa = new Map<string, number[]>();
  const recentes = (k: string, t: number) => {
    const r = (mapa.get(k) ?? []).filter((x) => t - x < janelaMs);
    if (r.length) mapa.set(k, r);
    else mapa.delete(k);
    return r;
  };
  return {
    espera(k) {
      const t = relogio();
      const r = recentes(k, t);
      return r.length >= max
        ? Math.max(1, Math.ceil((r[r.length - max] + janelaMs - t) / 1000))
        : 0;
    },
    falhou(k) {
      const t = relogio();
      const r = recentes(k, t);
      r.push(t);
      mapa.set(k, r.slice(-max));
      if (mapa.size > 10_000) {
        for (const k2 of [...mapa.keys()]) recentes(k2, t);
      }
    },
  };
}
