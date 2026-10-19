import { Hono, type MiddlewareHandler } from "@hono/hono";
import type { Sql } from "../db/client.ts";
import { exigirSessao } from "../auth/session.ts";
import type { WebauthnDeps } from "../auth/webauthn.ts";
import { rotasAuth } from "./auth_routes.ts";
import { rotasPush } from "./push_routes.ts";
import { rotasCaixas, rotasMarca } from "./caixas_routes.ts";
import { rotasMensagens } from "./mensagens_routes.ts";
import {
  type abrirImap,
  type ConfigMail,
  type TestarCaixa,
  testarCaixa as testarCaixaPadrao,
} from "../mail/conexao.ts";
import { criarPool, type Pool } from "../mail/pool.ts";
import { filaPadrao, type FilaSaida } from "../mail/saida.ts";
import { rotasPastas } from "./pastas_routes.ts";
import { rotasRascunhos } from "./rascunhos_routes.ts";
import { rotasSaida } from "./saida_routes.ts";
import { rotasEnvio } from "./envio_routes.ts";
import { rotasConfig } from "./config_routes.ts";
import { rotasAssinaturas } from "./assinaturas_routes.ts";
import { rotasRegras } from "./regras_routes.ts";
import type { abrirSieve, ConfigSieve } from "../mail/sieve.ts";
import type { EnvioDeps, Transmitir } from "../mail/envio.ts";
import type { PayloadPush, ResultadoPush } from "../notify/push.ts";
import type { Limitador } from "../notify/notificar.ts";
import type { Classificador } from "../ai/classificador.ts";
import type { SincronizadorCaixas } from "../mail/vigia_caixa.ts";
import type { ResendConfig } from "../mail/resend.ts";
import type { Registrador } from "../db/registro.ts";
import { rotasRegistro } from "./registro_routes.ts";
import { rotasResend, type VerificarResend } from "./resend_routes.ts";

export interface ApiDeps {
  sql: Sql;
  agora: () => Date;
  webauthn: WebauthnDeps;
  vapidPublic: string;
  /** Chave do cofre (senhas das caixas). */
  masterKey: Uint8Array;
  /** IMAP/SMTP; SIEVE_HOST/SIEVE_PORT opcionais (padrão IMAP_HOST e 4190). */
  mail: ConfigMail & Partial<ConfigSieve>;
  /** Injetável nos testes; padrão: abrirSieve real (ManageSieve). */
  abrirSieve?: typeof abrirSieve;
  /** Injetável nos testes; padrão: login IMAP+SMTP real. */
  testarCaixa?: TestarCaixa;
  /** Injetável nos testes; padrão: abrirImap real. */
  abrirImap?: typeof abrirImap;
  /** Envia um push a todas as inscrições (main: enviarPush + depsPadrao). Sem ele, nenhum push sai. */
  enviarPush?: (p: PayloadPush) => Promise<ResultadoPush>;
  /** Limite de pushes de falha; padrão: limitadorPadrao (compartilhado). */
  limitador?: Limitador;
  /** Injetável nos testes; padrão: SMTP real. */
  transmitir?: Transmitir;
  /** Selo de suspeita no detalhe da mensagem (sem ele, nunca há selo). */
  classificador?: Classificador;
  /** Espera máxima da classificação sob demanda no detalhe (padrão 5 s). */
  prazoClassificacaoMs?: number;
  /** Vigia das INBOX (main: GerenciadorCaixas); avisado ao mudar caixas. */
  vigia?: SincronizadorCaixas;
  /** OPENROUTER_API_KEY presente (mostrado na config do classificador). */
  iaDisponivel?: boolean;
  /** Pool IMAP compartilhado com o worker da Caixa de saída (main). */
  pool?: Pool;
  /** Worker da Caixa de saída (main o inicia); padrão: um parado. */
  fila?: FilaSaida;
  /** Contas Resend por domínio (envio por domínio verificado). */
  resend?: ResendConfig;
  /** Logger de atividade/erro (tabela correio.registro). */
  registro?: Registrador;
  /** Injetável nos testes; padrão: verify() SMTP real da conta Resend. */
  verificarResend?: VerificarResend;
}

const semPush = () => Promise.resolve({ ok: 0, falhas: 0 });

/** Rotas que não exigem sessão. */
function publica(p: string): boolean {
  return p === "/api/vivo" || p === "/api/saude" || p.startsWith("/api/auth/");
}

/**
 * Defesa CSRF em toda rota mutante (inclui /api/auth/*):
 * - JSON: Content-Type application/json e Sec-Fetch-Site ausente ou same-origin;
 * - multipart ou binário (uploads: application/octet-stream, image/*):
 *   Sec-Fetch-Site obrigatório e igual a same-origin;
 * - qualquer outro Content-Type: 415.
 */
export const csrf: MiddlewareHandler = async (c, next) => {
  const m = c.req.method;
  if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS") {
    const ct = (c.req.header("Content-Type") ?? "").toLowerCase();
    const site = c.req.header("Sec-Fetch-Site");
    if (
      /^(multipart\/form-data|application\/octet-stream|image\/[a-z0-9.+-]+)\s*(;|$)/
        .test(ct)
    ) {
      if (site !== "same-origin") {
        return c.json({ erro: "Requisição de outra origem recusada" }, 403);
      }
    } else if (!/^application\/json\s*(;|$)/.test(ct)) {
      return c.json({ erro: "Content-Type deve ser application/json" }, 415);
    } else if (site !== undefined && site !== "same-origin") {
      return c.json({ erro: "Requisição de outra origem recusada" }, 403);
    }
  }
  await next();
};

/**
 * API do Correio. Cada área tem seu próprio router montado em /api/<área>;
 * tarefas seguintes acrescentam routers na seção "áreas com sessão".
 */
export function criarApp(deps: ApiDeps): Hono {
  const { sql } = deps;
  const app = new Hono();

  app.onError((e, c) => {
    console.error("[api] erro:", e);
    return c.json({ erro: "Erro interno" }, 500);
  });

  app.use("/api/*", csrf);

  // Liveness do container: só o processo, sem banco.
  app.get("/api/vivo", (c) => c.json({ ok: true }));

  // Prontidão: banco acessível e migrado.
  app.get("/api/saude", async (c) => {
    try {
      await sql`SELECT 1 FROM correio.migracoes LIMIT 1`;
    } catch (e) {
      // Só o código/nome: a mensagem do driver pode citar a URL de conexão.
      const x = e as { code?: string; name?: string };
      console.error("[saude] banco inacessível:", x?.code ?? x?.name ?? "erro");
      return c.json({ ok: false, motivo: "banco de dados inacessível" }, 503);
    }
    return c.json({ ok: true });
  });

  app.route("/api/auth", rotasAuth(sql, deps.webauthn));

  const sessao = exigirSessao(sql, deps.agora);
  app.use("/api/*", async (c, next) => {
    if (publica(c.req.path)) return await next();
    return await sessao(c, next);
  });

  // ------------------------------------------------ áreas com sessão
  // um pool só: o mutex por caixa vale para leitura e envio
  const pool = deps.pool ?? criarPool({
    sql,
    masterKey: deps.masterKey,
    mail: deps.mail,
    abrir: deps.abrirImap,
  });
  const envio: EnvioDeps = {
    sql,
    masterKey: deps.masterKey,
    mail: deps.mail,
    pool,
    transmitir: deps.transmitir,
    resend: deps.resend,
    registro: deps.registro,
    agora: deps.agora,
    notificacao: {
      sql,
      agora: deps.agora,
      enviar: deps.enviarPush ?? semPush,
      limitador: deps.limitador,
    },
  };
  const fila = deps.fila ?? filaPadrao(envio);
  app.route("/api/push", rotasPush(sql, deps.vapidPublic));
  app.route(
    "/api/caixas",
    rotasCaixas({
      sql,
      masterKey: deps.masterKey,
      mail: deps.mail,
      testarCaixa: deps.testarCaixa ?? testarCaixaPadrao,
      vigia: deps.vigia,
      resend: deps.resend,
    }),
  );
  app.route(
    "/api/caixas",
    rotasMensagens({
      sql,
      pool,
      classificador: deps.classificador,
      prazoClassificacaoMs: deps.prazoClassificacaoMs,
    }),
  );
  app.route("/api/caixas", rotasPastas({ sql, pool }));
  app.route("/api/caixas", rotasEnvio(envio));
  app.route(
    "/api/caixas",
    rotasRascunhos({ sql, pool, agora: deps.agora }),
  );
  app.route("/api/caixas", rotasSaida({ sql, fila, agora: deps.agora }));
  app.route("/api/caixas", rotasAssinaturas({ sql }));
  app.route(
    "/api/caixas",
    rotasRegras({
      sql,
      masterKey: deps.masterKey,
      mail: deps.mail,
      abrirSieve: deps.abrirSieve,
      registro: deps.registro,
    }),
  );
  app.route("/api/marca", rotasMarca(sql));
  app.route(
    "/api/config",
    rotasConfig({ sql, iaDisponivel: deps.iaDisponivel ?? false }),
  );
  app.route("/api/registro", rotasRegistro({ sql }));
  app.route(
    "/api/resend",
    rotasResend({
      sql,
      mail: deps.mail,
      resend: deps.resend,
      verificar: deps.verificarResend,
    }),
  );

  return app;
}
