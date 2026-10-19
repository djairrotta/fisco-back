// Vigia 2.0 (1.2/1.3): API REST v1 (/api/v1/*) e MCP (/mcp), autenticados só
// por token Bearer (vgt_ do PWA ou access token OAuth vgo_). Tokens não valem em nenhuma outra rota (o PWA exige a
// sessão de passkey) e nenhuma operação aqui cria tokens, mexe em passkeys ou
// lê segredos.
import type { Context, Hono, MiddlewareHandler } from "@hono/hono";
import type { ContentfulStatusCode } from "@hono/hono/utils/http-status";
import type { Sql } from "../../db/client.ts";
import {
  atorToken,
  criarLimitadorFalhas,
  criarLimitadorTokens,
  podeEscrever,
  podeLer,
  type TokenValido,
  validarToken,
} from "../../auth/tokens.ts";
import { ErroApi, type Servicos } from "../servicos.ts";
import { OPERACOES, problemaValidacao } from "./operacoes.ts";
import { documentoOpenApi } from "./openapi.ts";
import { atenderMcp } from "../../mcp/servidor.ts";
import { ipCliente } from "../auth_routes.ts";
import { validarAcesso } from "../../auth/oauth.ts";
import {
  metadadosRecurso,
  montarOAuthPublico,
  type OAuthOpcoes,
} from "./oauth_rotas.ts";

export interface IntegracaoDeps {
  sql: Sql;
  agora: () => Date;
  srv: Servicos;
  /** Origem do PWA (WEBAUTHN_ORIGIN): único Origin aceito quando presente. */
  origem: string;
  /** 0 = permitido; senão segundos para o Retry-After. Padrão: 60/min. */
  limitar?: (tokenId: number) => number;
  /** Falhas de token por IP. Padrão: 10/min, depois 429. */
  falhas?: ReturnType<typeof criarLimitadorFalhas>;
  /** Limites do registro dinâmico de clientes OAuth (testes). */
  oauth?: OAuthOpcoes;
}

type Vars = { Variables: { token: TokenValido } };

export function bearer(c: Context): string | null {
  const h = c.req.header("Authorization") ?? "";
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m ? m[1] : null;
}

export function montarIntegracoes(app: Hono, deps: IntegracaoDeps): void {
  const limitar = deps.limitar ?? criarLimitadorTokens(60, 60_000);
  const falhas = deps.falhas ?? criarLimitadorFalhas(10, 60_000);
  // MCP authorization (RFC 9728): o 401 aponta para os metadados do recurso.
  const desafio = `Bearer resource_metadata="${metadadosRecurso(deps.origem)}"`;

  /** MCP spec: valida Origin quando presente (anti DNS rebinding / CSRF). */
  const origem: MiddlewareHandler = async (c, next) => {
    const o = c.req.header("Origin");
    if (o !== undefined && o !== deps.origem) {
      return c.json({ erro: "Origem não permitida" }, 403);
    }
    await next();
  };

  const autenticar: MiddlewareHandler<Vars> = async (c, next) => {
    // IP com falhas demais espera antes de qualquer consulta ao banco.
    const ip = ipCliente(c);
    const bloqueado = falhas.espera(ip);
    if (bloqueado > 0) {
      return c.json({ erro: "Tentativas demais com token inválido" }, 429, {
        "Retry-After": String(bloqueado),
      });
    }
    // vgo_ = access token OAuth; vgt_ = token criado no PWA.
    const b = bearer(c);
    const t = b?.startsWith("vgo_")
      ? await validarAcesso(deps.sql, b, deps.agora())
      : await validarToken(deps.sql, b, deps.agora);
    if (!t) {
      falhas.falhou(ip);
      return c.json({ erro: "Token ausente, inválido ou revogado" }, 401, {
        "WWW-Authenticate": desafio,
      });
    }
    const espera = limitar(t.chaveLimite ?? t.id);
    if (espera > 0) {
      return c.json({ erro: "Limite de 60 requisições por minuto" }, 429, {
        "Retry-After": String(espera),
      });
    }
    c.set("token", t);
    await next();
  };

  for (const p of ["/api/v1/*", "/mcp"]) {
    app.use(p, origem);
  }

  // OpenAPI: público para leitura? Não — também exige token (lista de rotas).
  app.get(
    "/api/v1/openapi.json",
    autenticar,
    (c) => c.json(documentoOpenApi()),
  );

  for (const op of OPERACOES) {
    const handler = async (c: Context<Vars>) => {
      const t = c.get("token");
      const ok = op.escopo === "escrever" ? podeEscrever(t) : podeLer(t);
      if (!ok) {
        return c.json({
          erro: `Token sem o escopo "${op.escopo}" exigido por ${op.nome}`,
        }, 403);
      }
      let corpo: Record<string, unknown> = {};
      if (op.metodo !== "GET") {
        const txt = await c.req.text();
        if (txt.trim()) {
          try {
            const j = JSON.parse(txt);
            if (!j || typeof j !== "object" || Array.isArray(j)) throw 0;
            corpo = j;
          } catch {
            return c.json({ erro: "JSON inválido" }, 400);
          }
        }
      }
      const entrada = op.metodo === "GET"
        ? { ...c.req.query(), ...c.req.param() }
        : { ...corpo, ...c.req.param() };
      const v = op.entrada.safeParse(entrada);
      if (!v.success) {
        return c.json({
          erro: "Dados inválidos",
          detalhes: problemaValidacao(v.error),
        }, 400);
      }
      try {
        const r = await op.executar(deps.srv, v.data, {
          ator: atorToken(t),
        });
        return c.json(r as object);
      } catch (e) {
        if (e instanceof ErroApi) {
          return c.json(e.corpo, e.status as ContentfulStatusCode);
        }
        if ((e as { code?: string })?.code === "22P02") {
          return c.json({ erro: "Valor inválido" }, 400);
        }
        throw e;
      }
    };
    const caminho = `/api/v1${op.caminho}`;
    const m = op.metodo.toLowerCase() as "get" | "post" | "put" | "delete";
    (app as unknown as Hono<Vars>)[m](caminho, autenticar, handler);
  }
  app.all("/api/v1/*", (c) => c.json({ erro: "Rota não encontrada" }, 404));

  // ------------------------------------------------------------------ MCP
  app.post("/mcp", autenticar as MiddlewareHandler, async (c) => {
    const t = (c as unknown as Context<Vars>).get("token");
    return await atenderMcp(c.req.raw, deps.srv, t);
  });
  // OAuth 2.1 (conectores do claude.ai): descoberta, registro, token e
  // revogação. A página /oauth/autorizar é do PWA (sessão de passkey).
  montarOAuthPublico(app, {
    sql: deps.sql,
    agora: deps.agora,
    origem: deps.origem,
    opcoes: deps.oauth,
  });
  // Sem SSE do servidor nem sessões (spec 2025-06-18 permite 405).
  app.on(
    ["GET", "DELETE", "PUT", "PATCH"],
    "/mcp",
    (c) =>
      c.json({ erro: "Método não permitido: use POST" }, 405, {
        Allow: "POST",
      }),
  );
}
