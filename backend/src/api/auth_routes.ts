import { type Context, Hono } from "@hono/hono";
import { deleteCookie, getCookie, setCookie } from "@hono/hono/cookie";
import { z } from "zod";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { Sql } from "../db/client.ts";
import { auditar } from "../db/auditoria.ts";
import {
  COOKIE_SESSAO,
  definirCookieSessao,
  limitarTentativas,
  limparCookieSessao,
  NaoAutorizado,
  sair,
} from "../auth/session.ts";
import {
  ConviteRecusado,
  COOKIE_DESAFIO,
  DESAFIO_TTL_MS,
  opcoesLogin,
  opcoesRegistro,
  OrigemDivergente,
  verificarLogin,
  verificarRegistro,
  type WebauthnDeps,
} from "../auth/webauthn.ts";
import { configSenha, loginSenhaValido } from "../auth/senha.ts";
import { criarSessao } from "../auth/session.ts";
import { limiteCorpo } from "./util.ts";

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

/** Auditoria best-effort: falha ao gravar não derruba login nem registro. */
async function registrar(
  sql: Sql,
  acao: string,
  alvo: string | null,
  detalhes: Record<string, unknown>,
) {
  try {
    await auditar(sql, "usuario", acao, alvo, detalhes);
  } catch (e) {
    console.error(`[auth] falha ao auditar ${acao}:`, (e as Error)?.name);
  }
}

/** Host esperado (de WEBAUTHN_ORIGIN), para o PWA avisar quando aberto por outro endereço. */
export function hostEsperado(origem: string): string {
  try {
    return new URL(origem).host;
  } catch {
    return origem;
  }
}

/** Mensagem pt-BR de cada recusa de passkey (nunca falha muda no PWA). */
function mensagemRecusa(e: NaoAutorizado, caminho: string): string {
  if (e instanceof OrigemDivergente) {
    return `A origem do navegador (${e.recebida}) não confere com a esperada (${e.esperada}). Abra pelo endereço ${e.esperada}.`;
  }
  if (e instanceof ConviteRecusado) {
    return "Convite inválido ou já usado. Se este Correio já tem passkey, use “Entrar com passkey”.";
  }
  if (caminho.endsWith("/registro")) {
    return "O servidor recusou o registro da passkey (desafio expirado ou resposta inválida). Tente de novo.";
  }
  if (caminho.endsWith("/login")) {
    return "Passkey não reconhecida ou desafio expirado. Tente de novo.";
  }
  return "Não autorizado";
}

const LoginSenhaBody = z.object({
  usuario: z.string().trim().min(1).max(60),
  senha: z.string().min(1).max(200),
}).strict();

export function rotasAuth(sql: Sql, w: WebauthnDeps): Hono {
  const app = new Hono();

  // Público e fora do limite de tentativas: o PWA confere o endereço antes
  // de chamar a passkey (RP ID/origem divergentes falham no navegador).
  app.get(
    "/estado",
    (c) =>
      c.json({
        host: hostEsperado(w.cfg.origin),
        origem: w.cfg.origin,
        loginSenha: configSenha() !== null,
      }),
  );

  app.use("*", limiteCorpo());
  app.use("*", async (c, next) => {
    if (!limitarTentativas(`auth:${ipCliente(c)}`, 10, 60_000)) {
      return c.json({ erro: "Muitas tentativas; aguarde um minuto" }, 429);
    }
    await next();
  });

  app.onError((e, c) => {
    if (e instanceof OrigemDivergente) {
      return c.json({
        erro: mensagemRecusa(e, c.req.path),
        origemEsperada: e.esperada,
      }, 400);
    }
    if (e instanceof NaoAutorizado) {
      return c.json({ erro: mensagemRecusa(e, c.req.path) }, 401);
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
    await registrar(sql, "passkey_registrada", b.data.id.slice(0, 200), {
      ip: ipCliente(c),
    });
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
    await registrar(sql, "login", null, {
      ip: ipCliente(c),
      dispositivo,
    });
    return c.json({ ok: true });
  });

  // Login por usuário e senha (só se CORREIO_LOGIN_USUARIO/CORREIO_LOGIN_SENHA_HASH existirem).
  // Limite próprio: 5 tentativas por IP a cada 15 min.
  app.post("/senha", async (c) => {
    if (!configSenha()) {
      return c.json({ erro: "Login por senha desligado" }, 404);
    }
    const ip = ipCliente(c);
    if (!limitarTentativas(`senha:${ip}`, 5, 15 * 60_000)) {
      return c.json({ erro: "Muitas tentativas; aguarde 15 minutos" }, 429);
    }
    const b = LoginSenhaBody.safeParse(await lerJson(c));
    if (!b.success) return c.json({ erro: "Dados inválidos" }, 400);
    const ok = await loginSenhaValido(b.data.usuario, b.data.senha);
    const dispositivo = (c.req.header("User-Agent") ?? "desconhecido").slice(0, 200);
    await registrar(sql, ok ? "login_senha" : "login_senha_falhou", null, {
      ip,
      dispositivo,
      usuario: b.data.usuario.slice(0, 60),
    });
    if (!ok) return c.json({ erro: "Usuário ou senha incorretos" }, 401);
    await sair(sql, getCookie(c, COOKIE_SESSAO));
    definirCookieSessao(c, await criarSessao(sql, `senha · ${dispositivo}`));
    return c.json({ ok: true });
  });

  app.post("/sair", async (c) => {
    await sair(sql, getCookie(c, COOKIE_SESSAO));
    limparCookieSessao(c);
    return c.json({ ok: true });
  });

  return app;
}
