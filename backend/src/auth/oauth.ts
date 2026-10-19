// Vigia 2.0: servidor de autorização OAuth 2.1 para o MCP (spec MCP
// 2025-06-18): registro dinâmico de clientes públicos (RFC 7591), código com
// PKCE S256, refresh token girado a cada uso e revogação (RFC 7009).
// Códigos e tokens só existem em texto no retorno; o banco guarda o sha256.
import type { TransactionSql } from "postgres";
import type { Sql } from "../db/client.ts";
import { base64url, sha256Hex } from "./session.ts";
import type { Escopo, TokenValido } from "./tokens.ts";

export const CODIGO_MS = 60_000;
export const ACESSO_S = 3600;
export const REFRESH_MS = 30 * 86_400_000;
const INTERVALO_ULTIMO_USO_MS = 60_000;

export const FORMATO_ACESSO = /^vgo_[A-Za-z0-9_-]{43}$/;
const FORMATO_REFRESH = /^vgr_[A-Za-z0-9_-]{43}$/;
const FORMATO_CODIGO = /^vgc_[A-Za-z0-9_-]{43}$/;
const FORMATO_DESAFIO = /^[A-Za-z0-9_-]{43}$/;
const FORMATO_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const FORMATO_CLIENTE = /^vgcl_[A-Za-z0-9_-]{22,64}$/;

const aleatorio = (prefixo: string, bytes = 32) =>
  `${prefixo}${base64url(crypto.getRandomValues(new Uint8Array(bytes)))}`;

/** "escrever" inclui "ler". */
export const normalizarEscopos = (e: readonly string[]): Escopo[] =>
  e.includes("escrever") ? ["ler", "escrever"] : ["ler"];

/** https (sem fragmento nem credenciais), ou http só em localhost/127.0.0.1. */
export function redirectPermitido(s: unknown): boolean {
  if (typeof s !== "string" || s.length > 2000 || s.includes("#")) {
    return false;
  }
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.protocol === "https:") return u.hostname.length > 0;
  return u.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
}

/** Nome declarado pelo cliente: sem caracteres de controle, até 100. */
export function limparNome(s: unknown): string {
  if (typeof s !== "string") return "";
  return s.replace(/[\r\n\t]/g, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

// --------------------------------------------------------------- clientes

export interface Cliente {
  clientId: string;
  nome: string;
  redirectUris: string[];
}

/**
 * Grava um cliente novo. Com o teto atingido, descarta clientes com mais de
 * um dia que nunca foram autorizados; se ainda assim não couber, null.
 */
export async function registrarCliente(
  sql: Sql,
  dados: { nome: string; redirectUris: string[]; ip: string },
  agora: Date,
  maxClientes: number,
): Promise<(Cliente & { criadoEm: Date }) | null> {
  const contar = async () =>
    Number(
      (await sql`SELECT count(*)::int n FROM vigia.oauth_clientes`)[0].n,
    );
  if (await contar() >= maxClientes) {
    await sql`DELETE FROM vigia.oauth_clientes c
      WHERE c.criado_em < ${new Date(agora.getTime() - 86_400_000)}
        AND NOT EXISTS (SELECT 1 FROM vigia.oauth_concessoes g
          WHERE g.client_id = c.client_id)`;
    if (await contar() >= maxClientes) return null;
  }
  const clientId = aleatorio("vgcl_", 24);
  await sql`INSERT INTO vigia.oauth_clientes
      (client_id, nome, redirect_uris, ip, criado_em)
    VALUES (${clientId}, ${dados.nome}, ${dados.redirectUris}, ${dados.ip},
      ${agora})`;
  return {
    clientId,
    nome: dados.nome,
    redirectUris: dados.redirectUris,
    criadoEm: agora,
  };
}

async function buscarCliente(sql: Sql, id: string): Promise<Cliente | null> {
  if (!FORMATO_CLIENTE.test(id)) return null;
  const [r] = await sql`SELECT client_id, nome, redirect_uris
    FROM vigia.oauth_clientes WHERE client_id = ${id}`;
  return r
    ? {
      clientId: String(r.client_id),
      nome: String(r.nome),
      redirectUris: r.redirect_uris as string[],
    }
    : null;
}

// ------------------------------------------------------------ autorização

export interface PedidoValido {
  ok: true;
  cliente: Cliente;
  redirectUri: string;
  state: string;
  desafio: string;
  escopos: Escopo[];
}
export interface PedidoInvalido {
  ok: false;
  erro: string;
  /** Presente quando o erro pode voltar ao cliente (redirect já conferido). */
  redirect?: string;
}

/** Monta o redirect de volta com code/error, state e iss (RFC 9207). */
export function urlRetorno(
  redirectUri: string,
  issuer: string,
  params: Record<string, string>,
): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set("iss", issuer);
  return u.toString();
}

/** Valida os parâmetros de /oauth/autorizar (OAuth 2.1 + PKCE S256). */
export async function validarPedido(
  sql: Sql,
  p: Record<string, unknown>,
  cfg: { issuer: string; recurso: string },
): Promise<PedidoValido | PedidoInvalido> {
  const s = (k: string) => (typeof p[k] === "string" ? p[k] as string : "");
  const cliente = await buscarCliente(sql, s("client_id"));
  if (!cliente) return { ok: false, erro: "Aplicativo não registrado" };
  const redirectUri = s("redirect_uri");
  if (!cliente.redirectUris.includes(redirectUri)) {
    return {
      ok: false,
      erro: "Endereço de retorno não confere com o registrado",
    };
  }
  const state = s("state");
  const falha = (error: string, erro: string): PedidoInvalido => ({
    ok: false,
    erro,
    redirect: urlRetorno(redirectUri, cfg.issuer, {
      error,
      error_description: erro,
      ...(state ? { state } : {}),
    }),
  });
  if (s("response_type") !== "code") {
    return falha("unsupported_response_type", "Use response_type=code");
  }
  if (
    s("code_challenge_method") !== "S256" ||
    !FORMATO_DESAFIO.test(s("code_challenge"))
  ) {
    return falha("invalid_request", "PKCE S256 obrigatório");
  }
  if (!state || state.length > 1000) {
    return falha("invalid_request", "state obrigatório");
  }
  if (p.resource !== undefined && s("resource") !== cfg.recurso) {
    return falha("invalid_target", "resource diferente do MCP do Vigia");
  }
  const pedidos = s("scope").split(" ").filter(Boolean);
  if (pedidos.some((e) => e !== "ler" && e !== "escrever")) {
    return falha("invalid_scope", "Escopos aceitos: ler, escrever");
  }
  return {
    ok: true,
    cliente,
    redirectUri,
    state,
    desafio: s("code_challenge"),
    escopos: normalizarEscopos(pedidos),
  };
}

/** Grava o código (só hash, uso único, 60 s) e devolve o texto. */
export async function criarCodigo(
  sql: Sql,
  pedido: PedidoValido,
  escopos: Escopo[],
  agora: Date,
): Promise<string> {
  const codigo = aleatorio("vgc_");
  await sql`INSERT INTO vigia.oauth_codigos
      (hash, client_id, redirect_uri, desafio, escopos, expira)
    VALUES (${await sha256Hex(codigo)}, ${pedido.cliente.clientId},
      ${pedido.redirectUri}, ${pedido.desafio}, ${escopos},
      ${new Date(agora.getTime() + CODIGO_MS)})`;
  return codigo;
}

// ------------------------------------------------------------------ token

export interface RespostaToken {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}
export interface ErroOAuth {
  error: string;
  error_description: string;
}
const erro = (error: string, error_description: string): ErroOAuth => ({
  error,
  error_description,
});

type Tx = TransactionSql;

async function emitirPar(
  tx: Tx,
  concessaoId: number,
  escopos: Escopo[],
  agora: Date,
): Promise<RespostaToken> {
  const acesso = aleatorio("vgo_");
  const refresh = aleatorio("vgr_");
  await tx`INSERT INTO vigia.oauth_tokens (hash, concessao_id, tipo, expira,
      criado_em)
    VALUES
      (${await sha256Hex(acesso)}, ${concessaoId}, 'acesso',
        ${new Date(agora.getTime() + ACESSO_S * 1000)}, ${agora}),
      (${await sha256Hex(refresh)}, ${concessaoId}, 'refresh',
        ${new Date(agora.getTime() + REFRESH_MS)}, ${agora})`;
  // Faxina: códigos e tokens vencidos há mais de um dia.
  const ontem = new Date(agora.getTime() - 86_400_000);
  await tx`DELETE FROM vigia.oauth_codigos WHERE expira < ${ontem}`;
  await tx`DELETE FROM vigia.oauth_tokens WHERE expira < ${ontem}`;
  return {
    access_token: acesso,
    token_type: "Bearer",
    expires_in: ACESSO_S,
    refresh_token: refresh,
    scope: escopos.join(" "),
  };
}

async function revogarConcessaoTx(
  tx: Tx | Sql,
  id: number,
  agora: Date,
  motivo: string,
): Promise<boolean> {
  const r = await tx`UPDATE vigia.oauth_concessoes
    SET revogado_em = ${agora}, motivo_revogacao = ${motivo}
    WHERE id = ${id} AND revogado_em IS NULL RETURNING id`;
  return r.length > 0;
}

async function pkceConfere(verifier: string, desafio: string) {
  const d = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64url(new Uint8Array(d)) === desafio;
}

/** grant_type=authorization_code. */
export async function trocarCodigo(
  sql: Sql,
  p: Record<string, string>,
  cfg: { recurso: string },
  agora: Date,
): Promise<RespostaToken | ErroOAuth> {
  const { code, redirect_uri, client_id, code_verifier } = p;
  if (!code || !redirect_uri || !client_id || !code_verifier) {
    return erro(
      "invalid_request",
      "code, redirect_uri, client_id e code_verifier são obrigatórios",
    );
  }
  if (p.resource !== undefined && p.resource !== cfg.recurso) {
    return erro("invalid_target", "resource diferente do MCP do Vigia");
  }
  if (!FORMATO_CODIGO.test(code) || !FORMATO_VERIFIER.test(code_verifier)) {
    return erro("invalid_grant", "Código ou code_verifier inválido");
  }
  const hash = await sha256Hex(code);
  return await sql.begin(async (tx) => {
    const [c] = await tx`UPDATE vigia.oauth_codigos SET usado_em = ${agora}
      WHERE hash = ${hash} AND usado_em IS NULL RETURNING *`;
    if (!c) {
      // Reuso: revoga o que foi emitido com este código (RFC 6749 §4.1.2).
      const [velho] = await tx`SELECT concessao_id FROM vigia.oauth_codigos
        WHERE hash = ${hash}`;
      if (velho?.concessao_id) {
        await revogarConcessaoTx(
          tx,
          Number(velho.concessao_id),
          agora,
          "reuso de código de autorização",
        );
      }
      return erro("invalid_grant", "Código inválido ou já usado");
    }
    if (
      new Date(c.expira).getTime() <= agora.getTime() ||
      c.client_id !== client_id || c.redirect_uri !== redirect_uri ||
      !await pkceConfere(code_verifier, String(c.desafio))
    ) {
      return erro("invalid_grant", "Código inválido, vencido ou PKCE errado");
    }
    const escopos = c.escopos as Escopo[];
    const [g] = await tx`INSERT INTO vigia.oauth_concessoes
        (client_id, escopos, criado_em)
      VALUES (${client_id}, ${escopos}, ${agora}) RETURNING id`;
    await tx`UPDATE vigia.oauth_codigos SET concessao_id = ${g.id}
      WHERE hash = ${hash}`;
    return await emitirPar(tx, Number(g.id), escopos, agora);
  }) as RespostaToken | ErroOAuth;
}

/** grant_type=refresh_token: gira o refresh; reuso revoga a concessão. */
export async function renovar(
  sql: Sql,
  p: Record<string, string>,
  agora: Date,
): Promise<RespostaToken | ErroOAuth> {
  const { refresh_token, client_id } = p;
  if (!refresh_token || !client_id) {
    return erro(
      "invalid_request",
      "refresh_token e client_id são obrigatórios",
    );
  }
  if (!FORMATO_REFRESH.test(refresh_token)) {
    return erro("invalid_grant", "Refresh token inválido");
  }
  const hash = await sha256Hex(refresh_token);
  return await sql.begin(async (tx) => {
    const [t] = await tx`SELECT t.hash, t.expira, t.usado_em, g.id, g.client_id,
        g.escopos, g.revogado_em
      FROM vigia.oauth_tokens t
      JOIN vigia.oauth_concessoes g ON g.id = t.concessao_id
      WHERE t.hash = ${hash} AND t.tipo = 'refresh'
      FOR UPDATE OF t, g`;
    if (!t || t.client_id !== client_id || t.revogado_em !== null) {
      return erro("invalid_grant", "Refresh token inválido ou revogado");
    }
    if (t.usado_em !== null) {
      await revogarConcessaoTx(
        tx,
        Number(t.id),
        agora,
        "reuso de refresh token",
      );
      return erro("invalid_grant", "Refresh token já usado: acesso revogado");
    }
    if (new Date(t.expira).getTime() <= agora.getTime()) {
      return erro("invalid_grant", "Refresh token vencido");
    }
    const escopos = t.escopos as Escopo[];
    if (p.scope) {
      const pedidos = p.scope.split(" ").filter(Boolean);
      if (pedidos.some((e) => !escopos.includes(e as Escopo))) {
        return erro("invalid_scope", "Escopo além do autorizado");
      }
    }
    await tx`UPDATE vigia.oauth_tokens SET usado_em = ${agora}
      WHERE hash = ${hash}`;
    return await emitirPar(tx, Number(t.id), escopos, agora);
  }) as RespostaToken | ErroOAuth;
}

/** Valida um access token vgo_ (mesmo papel do validarToken dos vgt_). */
export async function validarAcesso(
  sql: Sql,
  token: string | null | undefined,
  agora: Date,
): Promise<TokenValido | null> {
  if (!token || !FORMATO_ACESSO.test(token)) return null;
  const [r] = await sql`SELECT g.id, g.escopos, g.ultimo_uso, c.nome
    FROM vigia.oauth_tokens t
    JOIN vigia.oauth_concessoes g ON g.id = t.concessao_id
    JOIN vigia.oauth_clientes c ON c.client_id = g.client_id
    WHERE t.hash = ${await sha256Hex(token)} AND t.tipo = 'acesso'
      AND t.expira > ${agora} AND g.revogado_em IS NULL`;
  if (!r) return null;
  if (
    r.ultimo_uso === null ||
    agora.getTime() - new Date(r.ultimo_uso).getTime() >=
      INTERVALO_ULTIMO_USO_MS
  ) {
    await sql`UPDATE vigia.oauth_concessoes SET ultimo_uso = ${agora}
      WHERE id = ${r.id}`;
  }
  const nome = String(r.nome);
  return {
    id: Number(r.id),
    nome,
    escopos: r.escopos as Escopo[],
    ator: `oauth:${nome}`,
    // Negativo: não colide com os ids dos tokens vgt_ no limitador.
    chaveLimite: -Number(r.id),
  };
}

/** RFC 7009: revoga a concessão do token (acesso ou refresh). */
export async function revogarPorToken(
  sql: Sql,
  token: string,
  clientId: string | undefined,
  agora: Date,
): Promise<{ concessaoId: number; cliente: string } | null> {
  if (!FORMATO_ACESSO.test(token) && !FORMATO_REFRESH.test(token)) return null;
  const [r] = await sql`SELECT g.id, g.client_id, c.nome
    FROM vigia.oauth_tokens t
    JOIN vigia.oauth_concessoes g ON g.id = t.concessao_id
    JOIN vigia.oauth_clientes c ON c.client_id = g.client_id
    WHERE t.hash = ${await sha256Hex(token)}`;
  if (!r || (clientId !== undefined && clientId !== r.client_id)) return null;
  const ok = await revogarConcessaoTx(
    sql,
    Number(r.id),
    agora,
    "revogado pelo cliente",
  );
  return ok ? { concessaoId: Number(r.id), cliente: String(r.nome) } : null;
}

// -------------------------------------------------------------------- PWA

export interface AppAutorizado {
  id: number;
  cliente: string;
  escopos: Escopo[];
  criadoEm: string;
  ultimoUso: string | null;
}
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

export async function listarConcessoes(sql: Sql): Promise<AppAutorizado[]> {
  const rows = await sql`SELECT g.id, c.nome, g.escopos, g.criado_em,
      g.ultimo_uso
    FROM vigia.oauth_concessoes g
    JOIN vigia.oauth_clientes c ON c.client_id = g.client_id
    WHERE g.revogado_em IS NULL ORDER BY g.id DESC LIMIT 200`;
  return rows.map((r) => ({
    id: Number(r.id),
    cliente: String(r.nome),
    escopos: r.escopos as Escopo[],
    criadoEm: iso(r.criado_em)!,
    ultimoUso: iso(r.ultimo_uso),
  }));
}

/** Revoga pelo PWA; devolve o nome do cliente ou null. */
export async function revogarConcessao(
  sql: Sql,
  id: number,
  agora: Date,
): Promise<string | null> {
  const [r] = await sql`UPDATE vigia.oauth_concessoes g
    SET revogado_em = ${agora}, motivo_revogacao = 'revogado no app'
    FROM vigia.oauth_clientes c
    WHERE g.id = ${id} AND g.revogado_em IS NULL
      AND c.client_id = g.client_id
    RETURNING c.nome`;
  return r ? String(r.nome) : null;
}
