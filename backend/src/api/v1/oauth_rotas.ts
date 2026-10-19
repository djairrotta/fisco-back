// Vigia 2.0: rotas OAuth 2.1 do MCP.
// Públicas (com CORS, atrás do Bypass do Access): descoberta em /.well-known,
// /oauth/registrar, /oauth/token e /oauth/revogar.
// Do PWA (sessão de passkey, mesma origem): /api/oauth/* usadas pela página
// /oauth/autorizar e por Config → Integrações.
import type { Context, Hono, MiddlewareHandler } from "@hono/hono";
import { z } from "zod";
import type { Sql } from "../../db/client.ts";
import {
  criarCodigo,
  type ErroOAuth,
  limparNome,
  listarConcessoes,
  normalizarEscopos,
  redirectPermitido,
  registrarCliente,
  renovar,
  revogarConcessao,
  revogarPorToken,
  trocarCodigo,
  urlRetorno,
  validarPedido,
} from "../../auth/oauth.ts";
import { criarLimitadorFalhas, ESCOPOS } from "../../auth/tokens.ts";
import { auditar } from "../../monitor/executor.ts";
import { ipCliente } from "../auth_routes.ts";

export interface OAuthOpcoes {
  /** Registros por IP por hora. Padrão: 10. */
  registrosPorIp?: number;
  /** Teto de clientes registrados. Padrão: 50. */
  maxClientes?: number;
}

export interface OAuthDeps {
  sql: Sql;
  agora: () => Date;
  /** Origem pública do Vigia (WEBAUTHN_ORIGIN): issuer e base do recurso. */
  origem: string;
  opcoes?: OAuthOpcoes;
}

export const recursoMcp = (origem: string) => `${origem}/mcp`;
export const metadadosRecurso = (origem: string) =>
  `${origem}/.well-known/oauth-protected-resource`;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};
const SEM_CACHE = { "Cache-Control": "no-store", Pragma: "no-cache" };

/** CORS aberto (sem credenciais): só descoberta, registro, token e revogação. */
const cors: MiddlewareHandler = async (c, next) => {
  if (c.req.method === "OPTIONS") return c.body(null, 204, CORS);
  await next();
  try {
    for (const [k, v] of Object.entries(CORS)) c.res.headers.set(k, v);
  } catch {
    c.res = new Response(c.res.body, c.res);
    for (const [k, v] of Object.entries(CORS)) c.res.headers.set(k, v);
  }
};

/** Corpo form-urlencoded (padrão OAuth) ou JSON; só valores string. */
async function lerParametros(
  c: Context,
): Promise<Record<string, string> | null> {
  const ct = (c.req.header("Content-Type") ?? "").toLowerCase();
  const txt = await c.req.text();
  const out: Record<string, string> = {};
  if (ct.startsWith("application/json")) {
    try {
      const j = JSON.parse(txt || "{}");
      if (!j || typeof j !== "object" || Array.isArray(j)) return null;
      for (const [k, v] of Object.entries(j)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    } catch {
      return null;
    }
  }
  for (const [k, v] of new URLSearchParams(txt)) out[k] = v;
  return out;
}

const erroOAuth = (c: Context, e: ErroOAuth, status: 400 | 401 = 400) =>
  c.json(e, status, SEM_CACHE);

const Registro = z.object({
  client_name: z.string().max(500).optional(),
  redirect_uris: z.array(z.string()).optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.string().optional(),
  scope: z.string().max(200).optional(),
}).passthrough();

export function montarOAuthPublico(app: Hono, deps: OAuthDeps): void {
  const { sql, origem } = deps;
  const recurso = recursoMcp(origem);
  const relogio = () => deps.agora().getTime();
  const registros = criarLimitadorFalhas(
    deps.opcoes?.registrosPorIp ?? 10,
    3_600_000,
    relogio,
  );
  const maxClientes = deps.opcoes?.maxClientes ?? 50;
  const falhasToken = criarLimitadorFalhas(20, 60_000, relogio);

  for (
    const p of [
      "/.well-known/*",
      "/oauth/token",
      "/oauth/registrar",
      "/oauth/revogar",
    ]
  ) {
    app.use(p, cors);
  }

  // RFC 9728: com e sem o sufixo /mcp do recurso.
  const prm = (c: Context) =>
    c.json({
      resource: recurso,
      authorization_servers: [origem],
      scopes_supported: ESCOPOS,
      bearer_methods_supported: ["header"],
      resource_name: "Vigia",
    });
  app.get("/.well-known/oauth-protected-resource", prm);
  app.get("/.well-known/oauth-protected-resource/mcp", prm);

  // RFC 8414.
  const asm = (c: Context) =>
    c.json({
      issuer: origem,
      authorization_endpoint: `${origem}/oauth/autorizar`,
      token_endpoint: `${origem}/oauth/token`,
      registration_endpoint: `${origem}/oauth/registrar`,
      revocation_endpoint: `${origem}/oauth/revogar`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ESCOPOS,
      authorization_response_iss_parameter_supported: true,
      service_documentation: `${origem}/config`,
    });
  app.get("/.well-known/oauth-authorization-server", asm);
  app.get("/.well-known/oauth-authorization-server/mcp", asm);
  // Sem OpenID Connect; e nada de cair no fallback SPA.
  app.get(
    "/.well-known/*",
    (c) => c.json({ erro: "Não encontrado" }, 404),
  );

  // RFC 7591: só clientes públicos (PKCE, sem segredo).
  app.post("/oauth/registrar", async (c) => {
    const ip = ipCliente(c);
    const espera = registros.espera(ip);
    if (espera > 0) {
      return c.json(
        {
          error: "slow_down",
          error_description: "Registros demais deste IP",
        },
        429,
        { "Retry-After": String(espera) },
      );
    }
    registros.falhou(ip);
    const meta = (d: string) =>
      c.json({ error: "invalid_client_metadata", error_description: d }, 400);
    let bruto: unknown;
    try {
      bruto = JSON.parse(await c.req.text());
    } catch {
      return meta("JSON inválido");
    }
    const v = Registro.safeParse(bruto);
    if (!v.success) return meta("Metadados inválidos");
    const m = v.data;
    const uris = m.redirect_uris ?? [];
    if (uris.length < 1 || uris.length > 10 || !uris.every(redirectPermitido)) {
      return c.json({
        error: "invalid_redirect_uri",
        error_description:
          "Use https, ou http só em localhost/127.0.0.1, sem fragmento",
      }, 400);
    }
    if (
      m.token_endpoint_auth_method !== undefined &&
      m.token_endpoint_auth_method !== "none"
    ) {
      return meta("Só clientes públicos (token_endpoint_auth_method=none)");
    }
    const tipos = ["authorization_code", "refresh_token"];
    if (m.grant_types && !m.grant_types.every((g) => tipos.includes(g))) {
      return meta("grant_types aceitos: authorization_code, refresh_token");
    }
    if (m.response_types && !m.response_types.every((r) => r === "code")) {
      return meta("response_types aceito: code");
    }
    // client_name é opcional na RFC 7591; o PWA mostra que é autodeclarado.
    const nome = limparNome(m.client_name ?? "") || "Aplicativo sem nome";
    const cli = await registrarCliente(
      sql,
      { nome, redirectUris: [...new Set(uris)], ip },
      deps.agora(),
      maxClientes,
    );
    if (!cli) {
      return c.json({
        error: "temporarily_unavailable",
        error_description: "Limite de aplicativos registrados atingido",
      }, 503);
    }
    return c.json(
      {
        client_id: cli.clientId,
        client_id_issued_at: Math.floor(cli.criadoEm.getTime() / 1000),
        client_name: cli.nome,
        redirect_uris: cli.redirectUris,
        grant_types: tipos,
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: ESCOPOS.join(" "),
      },
      201,
      SEM_CACHE,
    );
  });

  app.post("/oauth/token", async (c) => {
    const ip = ipCliente(c);
    const espera = falhasToken.espera(ip);
    if (espera > 0) {
      return c.json(
        {
          error: "slow_down",
          error_description: "Tentativas demais",
        },
        429,
        { "Retry-After": String(espera), ...SEM_CACHE },
      );
    }
    const p = await lerParametros(c);
    if (!p) {
      return erroOAuth(c, {
        error: "invalid_request",
        error_description: "Corpo inválido",
      });
    }
    const agora = deps.agora();
    const r = p.grant_type === "authorization_code"
      ? await trocarCodigo(sql, p, { recurso }, agora)
      : p.grant_type === "refresh_token"
      ? await renovar(sql, p, agora)
      : {
        error: "unsupported_grant_type",
        error_description: "Use authorization_code ou refresh_token",
      };
    if ("error" in r) {
      falhasToken.falhou(ip);
      return erroOAuth(c, r);
    }
    return c.json(r, 200, SEM_CACHE);
  });

  // RFC 7009: sempre 200, exista ou não o token.
  app.post("/oauth/revogar", async (c) => {
    const p = await lerParametros(c);
    if (!p || !p.token) {
      return erroOAuth(c, {
        error: "invalid_request",
        error_description: "token obrigatório",
      });
    }
    const r = await revogarPorToken(sql, p.token, p.client_id, deps.agora());
    if (r) {
      await auditar(
        sql,
        `oauth:${r.cliente}`,
        "oauth_revogar_cliente",
        r.cliente,
        { concessao: r.concessaoId },
      );
    }
    return c.body(null, 200, SEM_CACHE);
  });

  // Fora estes, /oauth/autorizar é a página do PWA (fallback SPA).
  app.on(
    ["GET", "PUT", "DELETE", "PATCH"],
    ["/oauth/token", "/oauth/registrar", "/oauth/revogar"],
    (c) => c.json({ erro: "Use POST" }, 405, { Allow: "POST" }),
  );
}

const Decisao = z.object({
  params: z.record(z.string().max(2000)).refine(
    (o) => Object.keys(o).length <= 20,
  ),
  escopo: z.enum(["ler", "escrever"]),
  aprovar: z.boolean(),
}).strict();

/** Rotas do PWA; montar depois do middleware de sessão de /api/*. */
export function montarOAuthPwa(app: Hono, deps: OAuthDeps): void {
  const { sql, origem } = deps;
  const cfg = { issuer: origem, recurso: recursoMcp(origem) };

  app.get("/api/oauth/pedido", async (c) => {
    const v = await validarPedido(sql, c.req.query(), cfg);
    if (!v.ok) return c.json({ erro: v.erro, redirect: v.redirect }, 400);
    return c.json({
      cliente: v.cliente.nome,
      redirectHost: new URL(v.redirectUri).host,
      redirectUri: v.redirectUri,
      escopos: v.escopos,
    });
  });

  app.post("/api/oauth/decidir", async (c) => {
    let bruto: unknown;
    try {
      bruto = JSON.parse(await c.req.text());
    } catch {
      return c.json({ erro: "JSON inválido" }, 400);
    }
    const b = Decisao.safeParse(bruto);
    if (!b.success) return c.json({ erro: "Dados inválidos" }, 400);
    const v = await validarPedido(sql, b.data.params, cfg);
    if (!v.ok) return c.json({ erro: v.erro, redirect: v.redirect }, 400);
    if (!b.data.aprovar) {
      await auditar(sql, "usuario", "oauth_negar", v.cliente.nome, {
        client_id: v.cliente.clientId,
      });
      return c.json({
        redirect: urlRetorno(v.redirectUri, origem, {
          error: "access_denied",
          error_description: "Acesso negado no Vigia",
          state: v.state,
        }),
      });
    }
    const escopos = normalizarEscopos([b.data.escopo]);
    const codigo = await criarCodigo(sql, v, escopos, deps.agora());
    await auditar(sql, "usuario", "oauth_autorizar", v.cliente.nome, {
      client_id: v.cliente.clientId,
      escopos,
      redirect_host: new URL(v.redirectUri).host,
    });
    return c.json(
      {
        redirect: urlRetorno(v.redirectUri, origem, {
          code: codigo,
          state: v.state,
        }),
      },
      200,
      SEM_CACHE,
    );
  });

  app.get("/api/oauth/apps", async (c) => c.json(await listarConcessoes(sql)));

  app.post("/api/oauth/apps/:id/revogar", async (c) => {
    const s = c.req.param("id");
    if (!/^\d{1,15}$/.test(s) || Number(s) < 1) {
      return c.json({ erro: "id inválido" }, 400);
    }
    const nome = await revogarConcessao(sql, Number(s), deps.agora());
    if (nome === null) {
      return c.json({ erro: "App não encontrado ou já revogado" }, 404);
    }
    await auditar(sql, "usuario", "oauth_revogar", nome, { id: Number(s) });
    return c.json({ ok: true });
  });
}
