import type { Context, MiddlewareHandler } from "@hono/hono";
import { deleteCookie, getCookie, setCookie } from "@hono/hono/cookie";
import type { Sql } from "../db/client.ts";

export const COOKIE_SESSAO = "vigia_s";
export const SESSAO_MS = 30 * 86_400_000;

export class NaoAutorizado extends Error {
  constructor(message = "não autorizado") {
    super(message);
    this.name = "NaoAutorizado";
  }
}

export type Agora = () => Date;
const relogio: Agora = () => new Date();

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function base64url(b: Uint8Array): string {
  return btoa(String.fromCharCode(...b)).replaceAll("+", "-").replaceAll(
    "/",
    "_",
  )
    .replaceAll("=", "");
}

/** Comparação em tempo constante (via hash SHA-256 de ambos os lados). */
export async function iguaisConstante(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let r = 0;
  for (let i = 0; i < x.length; i++) r |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return r === 0 && a.length > 0 && b.length > 0;
}

export async function criarSessao(
  sql: Sql,
  dispositivo: string,
  agora: Agora = relogio,
): Promise<string> {
  const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const expira = new Date(agora().getTime() + SESSAO_MS);
  await sql`insert into vigia.sessoes (token_hash, expira, dispositivo)
    values (${await sha256Hex(token)}, ${expira}, ${dispositivo})`;
  return token;
}

let ultimaLimpeza = 0;

export async function validarSessao(
  sql: Sql,
  token: string | undefined | null,
  agora: Agora = relogio,
): Promise<boolean> {
  if (!token) return false;
  const now = agora();
  if (
    now.getTime() - ultimaLimpeza >= 60_000 || now.getTime() < ultimaLimpeza
  ) {
    ultimaLimpeza = now.getTime();
    await sql`delete from vigia.sessoes where expira <= ${now}`;
  }
  const rows = await sql`select 1 from vigia.sessoes
    where token_hash = ${await sha256Hex(token)} and expira > ${now}`;
  return rows.length > 0;
}

export async function sair(sql: Sql, token: string | undefined | null) {
  if (!token) return;
  await sql`delete from vigia.sessoes where token_hash = ${await sha256Hex(
    token,
  )}`;
}

export function definirCookieSessao(c: Context, token: string) {
  setCookie(c, COOKIE_SESSAO, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
    maxAge: SESSAO_MS / 1000,
  });
}

export function limparCookieSessao(c: Context) {
  deleteCookie(c, COOKIE_SESSAO, { path: "/", secure: true });
}

export function exigirSessao(
  sql: Sql,
  agora: Agora = relogio,
): MiddlewareHandler {
  return async (c, next) => {
    if (!await validarSessao(sql, getCookie(c, COOKIE_SESSAO), agora)) {
      return c.json({ erro: "não autenticado" }, 401);
    }
    await next();
  };
}

const tentativas = new Map<string, number[]>();
const MAX_CHAVES = 10_000;
let ultimaVarredura = 0;

/** true = permitido; false = limite estourado. Janela deslizante em memória. */
export function limitarTentativas(
  chave: string,
  max = 10,
  janelaMs = 60_000,
  agora: () => number = Date.now,
): boolean {
  const t = agora();
  if (t - ultimaVarredura >= 60_000 || t < ultimaVarredura) {
    ultimaVarredura = t;
    for (const [k, v] of tentativas) {
      if (v.length === 0 || t - v[v.length - 1] >= janelaMs) {
        tentativas.delete(k);
      }
    }
  }
  const recentes = (tentativas.get(chave) ?? []).filter((x) =>
    t - x < janelaMs
  );
  if (recentes.length >= max) {
    tentativas.set(chave, recentes);
    return false;
  }
  if (!tentativas.has(chave) && tentativas.size >= MAX_CHAVES) {
    // teto rígido: descarta a chave mais antiga
    tentativas.delete(tentativas.keys().next().value as string);
  }
  recentes.push(t);
  tentativas.set(chave, recentes);
  return true;
}

/** Só para testes. */
export function _estadoLimite() {
  return { chaves: tentativas.size };
}
