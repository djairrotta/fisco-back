import { type Context, Hono } from "@hono/hono";
import { deleteCookie, getCookie, setCookie } from "@hono/hono/cookie";
import { z } from "zod";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { Sql } from "../db/client.ts";
import {
  COOKIE_SESSAO,
  definirCookieSessao,
  limitarTentativas,
  limparCookieSessao,
  NaoAutorizado,
  sair,
} from "../auth/session.ts";
import {
  COOKIE_DESAFIO,
  DESAFIO_TTL_MS,
  opcoesLogin,
  opcoesRegistro,
  OrigemErrada,
  verificarLogin,
  verificarRegistro,
  type WebauthnDeps,
} from "../auth/webauthn.ts";

const CAMINHO_DESAFIO = "/api/auth";

/** IP do cliente: CF-Connecting-IP (atrás do Cloudflare), senão o endereço remoto. */
export function ipCliente(c: Context): string {
  const cf = c.req.header("CF-Connecting-IP")?.trim();
  if (cf) return cf;
  const env = c.env as { remoteAddr?: { hostname?: string } } | undefined;
  return env?.remoteAddr?.hostname ?? "desconhecido";
}

const RespostaPasskey = z.object({
  id: z.string().min(1).max(1024),
  rawId: z.string().max(1024).optional(),
  type: z.string().max(64).optional(),
  response: z.object({}).passthrough(),
}).passthrough();

const OpcoesRegistroBody = z.object({
  convite: z.string().max(200).optional(),
}).strict();

async function lerJson(c: Context): Promise<unknown> {
  const t = await c.req.text();
  if (!t.trim()) return {};
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

function definirDesafio(c: Context, id: string) {
  setCookie(c, COOKIE_DESAFIO, id, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: CAMINHO_DESAFIO,
    maxAge: DESAFIO_TTL_MS / 1000,
  });
}

function consumirCookieDesafio(c: Context): string {
  const id = getCookie(c, COOKIE_DESAFIO) ?? "";
  deleteCookie(c, COOKIE_DESAFIO, { path: CAMINHO_DESAFIO, secure: true });
  return id;
}

export function rotasAuth(sql: Sql, w: WebauthnDeps): Hono {
  const app = new Hono();

  // Público e fora do limite de tentativas: o PWA compara com location.origin.
  app.get(
    "/estado",
    (c) => c.json({ origem: w.cfg.origin, rpId: w.cfg.rpId }),
  );

  app.use("*", async (c, next) => {
    if (!limitarTentativas(`auth:${ipCliente(c)}`, 10, 60_000)) {
      return c.json({ erro: "Muitas tentativas; aguarde um minuto" }, 429);
    }
    await next();
  });

  app.onError((e, c) => {
    if (e instanceof NaoAutorizado) {
      return c.json({ erro: "Não autorizado" }, 401);
    }
    if (e instanceof OrigemErrada) {
      console.error(
        `[auth] origem ${e.recebida} recusada; esperada ${e.esperada}`,
      );
      return c.json({ erro: e.message, origemEsperada: e.esperada }, 400);
    }
    console.error("[auth] erro:", e);
    return c.json({ erro: "Erro interno" }, 500);
  });

  app.post("/registro/opcoes", async (c) => {
    const b = OpcoesRegistroBody.safeParse(await lerJson(c));
    if (!b.success) return c.json({ erro: "Dados inválidos" }, 400);
    const { opcoes, desafioId } = await opcoesRegistro(w, {
      convite: b.data.convite,
      sessaoToken: getCookie(c, COOKIE_SESSAO),
    });
    definirDesafio(c, desafioId);
    return c.json(opcoes);
  });

  app.post("/registro", async (c) => {
    const b = RespostaPasskey.safeParse(await lerJson(c));
    if (!b.success) return c.json({ erro: "Dados inválidos" }, 400);
    const desafioId = consumirCookieDesafio(c);
    await verificarRegistro(
      w,
      desafioId,
      b.data as unknown as RegistrationResponseJSON,
    );
    return c.json({ ok: true });
  });

  app.post("/login/opcoes", async (c) => {
    const { opcoes, desafioId } = await opcoesLogin(w);
    definirDesafio(c, desafioId);
    return c.json(opcoes);
  });

  app.post("/login", async (c) => {
    const b = RespostaPasskey.safeParse(await lerJson(c));
    if (!b.success) return c.json({ erro: "Dados inválidos" }, 400);
    const desafioId = consumirCookieDesafio(c);
    const dispositivo = (c.req.header("User-Agent") ?? "desconhecido").slice(
      0,
      200,
    );
    const { token } = await verificarLogin(
      w,
      desafioId,
      b.data as unknown as AuthenticationResponseJSON,
      dispositivo,
    );
    // Uma sessão por dispositivo: revoga a anterior deste navegador.
    await sair(sql, getCookie(c, COOKIE_SESSAO));
    definirCookieSessao(c, token);
    return c.json({ ok: true });
  });

  app.post("/sair", async (c) => {
    await sair(sql, getCookie(c, COOKIE_SESSAO));
    limparCookieSessao(c);
    return c.json({ ok: true });
  });

  return app;
}
